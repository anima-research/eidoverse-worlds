// motion — the world's moving parts, as functions of time.
//
// A motion component is PARAMETERS, never frames: the log stores "a pendulum
// with this amp/period/phase since t0" and every client — live, joining late,
// replaying a fork — evaluates the same closed form at its own `now`. Nothing
// integrates, nothing accumulates error, everyone agrees with zero ongoing
// traffic. Sequencer-not-simulator, applied to dynamics.
//
// Evaluators are pure f(params, t) → transform, composed onto the entity's
// logged base pose (spawn/place). Adding a motion type = adding a case here;
// the server folds it blindly, and older clients simply don't animate it.
//
// Types:
//   pendulum {axis, pivot, amp, period, phase, damp, maxAmp, t0}   — swings
//   spin     {axis?, pivot?, degPerSec|period, phase?, t0}         — windmills, carousels
//   orbit    {center?, radius, degPerSec|period, phase?, face?, t0} — ferries, birds (rateOf: the one reading)
//   oscillate {axis?, amp, period, phase?, t0}                     — back and forth along an axis (a sine): hover, buoys, pistons
//   path     {points, speed|duration, loop?: 'loop'|'pingpong'|'once', face?, t0}
//
// SUB-OBJECTS: a component keyed `motion:<slot>` whose value names a `node` (as the model file spells it;
// shared/protocol/names.js motionNode also reads the older forms) animates ONE NAMED NODE inside the entity's model
// instead of the whole thing. Several coexist on one entity, so a machine can have many moving parts. Coordinates
// are the PART's frame: pivot/axis relative to the node's own origin (default pivot [0,0,0], where a hinge usually
// lives), oscillate/orbit/path positions in the part's parent frame. `measure` reports each part's `local`
// center/size in this frame, so a local center is a pivot candidate verbatim. When a part's motion is removed, the
// part returns to its authored rest pose.

import { THREE, camera } from './core.js';
import { entities, bags, bagOf, findPart } from './world.js';
import { reindexCollider } from './colliders.js';
import { serverNow } from './player/remotes.js';
// The closed forms (and the generous reader) live in motioneval.js, shared with
// the agent's text-tier perception; this file applies them to THREE objects and
// owns the part-frame machinery only a renderer with a loaded model can have.
import { evalWholeMotion, evalPath, axisOf, ampOf, since, pendulumTheta, rateOf } from '../../shared/motioneval.js';
import { motionNode } from '../../shared/protocol/names.js';

const _q = new THREE.Quaternion();
const _ax = new THREE.Vector3();
const _pv = new THREE.Vector3();
const _rp = new THREE.Vector3();

// Colliders re-index at a walk, not at frame rate — a moving thing's collider
// trails it by up to half a second, which is invisible next to the cost of
// re-indexing every mover every frame.
const lastIndexed = new Map();

// ---- sub-object machinery ---------------------------------------------------
// findPart (name → node, async-load-safe) lives in world.js: mounting rides the same parts, so they share one lookup.

const _qb = new THREE.Quaternion();

/** rotateAtPivot's part-frame sibling: compose theta about `axis` at `pivot`
 *  (both in the PART's local frame) onto the part's rest transform. The
 *  pivot point stays fixed in the parent's frame — that is what makes it a
 *  hinge and not a wobble. */
function rotatePartAtPivot(obj, pbase, axis, pivot, theta) {
  _ax.set(...(axis ?? [0, 1, 0])).normalize();
  _q.setFromAxisAngle(_ax, theta);
  _qb.fromArray(pbase.quat);
  obj.quaternion.copy(_qb).multiply(_q);
  _pv.set(...(pivot ?? [0, 0, 0]));
  _rp.copy(_pv).applyQuaternion(_q);          // pivot after rotation
  _pv.sub(_rp).applyQuaternion(_qb);          // shift that keeps the pivot fixed
  obj.position.set(...pbase.pos).add(_pv);
}

/** One motion type evaluated on a part, in part-local terms. */
function evalPart(m, t, obj, pbase) {
  switch (m?.type) {
    case 'pendulum':
      rotatePartAtPivot(obj, pbase, axisOf(m, [1, 0, 0]), m.pivot ?? [0, 0, 0], pendulumTheta(m, t));
      return true;
    case 'spin': {
      const rate = rateOf(m, 36);
      rotatePartAtPivot(obj, pbase, axisOf(m, [0, 1, 0]), m.pivot ?? [0, 0, 0],
        (m.phase ?? 0) + (rate * Math.PI / 180) * t);
      return true;
    }
    case 'oscillate': {
      const off = Math.sin((2 * Math.PI / (m.period ?? 4)) * t + (m.phase ?? 0)) * ampOf(m, 0.3);
      _ax.set(...axisOf(m, [0, 1, 0])).normalize();
      obj.position.set(...pbase.pos).addScaledVector(_ax, off);
      return true;
    }
    case 'orbit': {
      const c = m.center ?? pbase.pos;
      const r = m.radius ?? 1;
      const a = (m.phase ?? 0) + (rateOf(m, 12) * Math.PI / 180) * t;
      obj.position.set(c[0] + r * Math.sin(a), (c[1] ?? pbase.pos[1]), c[2] + r * Math.cos(a));
      if (m.face !== false) obj.rotation.set(0, a + Math.PI / 2, 0);
      return true;
    }
    case 'path': {
      const r = evalPath(m, t, { pos: pbase.pos, yaw: 0 });
      if (!r.ok) return false;   // malformed path: the part rests, like an unknown type
      obj.position.set(...r.pos);
      if (r.rot) obj.rotation.set(0, r.yaw, 0);
      return true;
    }
    default:
      return false;   // unknown type: the part rests here, moves for newer clients
  }
}

/** "id\u0000part" -> part Object3D animated last frame. When a part's motion
 *  vanishes the part returns to its rest pose here (realize/models.js only does wholes). */
const _liveParts = new Map();
const _seenParts = new Set();

/** Called once per frame from the main loop. Walks every placed thing's components (bags()) and acts on those with
 *  a motion component: there is no motion-only index.
 *  Epoch clock, NOT the rAF timestamp: t0s are the authority clock's stamps (wall ms, never backwards: livehost.ts now()),
 *  and agreeing with other clients matters more than agreeing with vsync. */
// the camera's WORLD position: in XR camera.position is rig-local
const _eye = new THREE.Vector3();
const _wp = new THREE.Vector3();
export function tickMotion() {
  camera.getWorldPosition(_eye);   // in XR camera.position is only the head's offset inside the rig
  // The SEQUENCER's clock, not the wall's: t0s are server stamps, and a skewed
  // client would render the wrong phase. serverNow() is local time only until
  // the first server stamp.
  const nowMs = serverNow();
  _seenParts.clear();
  for (const [id, bag] of bags()) {
    for (const key in bag) {
      const isWhole = key === 'motion';
      if (!isWhole && !key.startsWith('motion:')) continue;
      const m = bag[key];
      if (!m || !m.type) continue;
      const obj = entities.get(id);
      if (!obj) continue;
      // a parented thing (userData.mountedTo: the hierarchy; sitting and holding are presence) moves in its parent's
      // frame too: its base is the local pose execMount gave it, and the parent carries the result
      // distance gate (TEL0S_NOTES §14.2): motion is closed-form f(t), so a far swing skipped this
      // frame lands at the right phase the frame it re-enters range
      const at = obj.userData.mountedTo ? obj.getWorldPosition(_wp) : obj.position;
      if (at.distanceToSquared(_eye) > 8100) continue;   // 90m, from the camera's WORLD position
      const t = since(m, nowMs);
      const partName = motionNode(key, m);   // the node it moves: its value's `node` (shared/protocol/names.js)

      if (partName) {
        const part = findPart(obj, partName);
        if (!part) continue;   // not loaded yet (or misnamed) — retry next second
        const pbase = part.userData.mbase
          ?? (part.userData.mbase = { pos: part.position.toArray(), quat: part.quaternion.toArray() });
        if (evalPart(m, t, part, pbase)) {
          const k = `${id}\u0000${partName}`;
          _seenParts.add(k);
          _liveParts.set(k, part);
        }
      } else {
        const base = obj.userData.base
          ?? (obj.userData.base = { pos: obj.position.toArray(), yaw: obj.rotation.y });
        // the shared evaluator: the agent's look() runs the same call
        // the entity's pivot component is the default hinge, in its parent's units: scaled by its own scale
        const pv = bagOf(id)?.pivot?.pos;
        const r = evalWholeMotion(Array.isArray(pv) && pv.length === 3 ? { ...base, pivot: [pv[0] * obj.scale.x, pv[1] * obj.scale.y, pv[2] * obj.scale.z] } : base, m, nowMs);
        if (!r.ok) {
          // unknown type or malformed path: stands still here, moves for newer clients
          continue;
        }
        obj.position.set(...r.pos);
        // rot:false = this motion leaves authored rotation alone (oscillate; face:false orbit/path)
        if (r.rot) obj.quaternion.set(...r.quat);
      }
      const li = lastIndexed.get(id) ?? 0;
      if (nowMs - li > 500) { lastIndexed.set(id, nowMs); reindexCollider(id); }
    }
  }
  // parts whose motion vanished this frame return to their rest pose
  for (const [k, part] of _liveParts) {
    if (_seenParts.has(k)) continue;
    _liveParts.delete(k);
    const b = part.userData.mbase;
    if (b && part.parent) {
      part.position.set(...b.pos);
      part.quaternion.fromArray(b.quat);
    }
    delete part.userData.mbase;
  }
}

// Motion ended (`{type: null}`): realize/models.js restores the base pose (it owns
// the base). Anything that rests AWAY from base (a ferry stopping
// mid-route) gets a `place` from the stopper alongside.

// The inspector's motion fields are declared in shared/editschema.js. No live
// preview on purpose: previewing would mean writing a bag this module doesn't own.
