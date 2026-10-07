// v4phys — physics in a v4 world, on the client (design 20: notes/eidoverse/v4-research/20-physics-in-v4-design.md).
//
// Replaces physobj.js (v1 leases: a volunteer simulated a punt and streamed it, the lease table arbitrated) and
// simworld.js (v1 dialect-3 intents folded in state.js). In a v4 world nothing here simulates for anyone else and
// nothing is streamed: every act is a DOOR REQUEST, and every client draws the same truth.
//
//   carrying   grab / put / throw / drop / punt are door tools (shared/v4/door.js). Who holds what is the door's
//              presence plane (`v4-holds`, never logged); every client draws a held thing in its holder's hand, so it
//              follows the hand for everyone (a remote's hand is their avatar's hand bone, driven by their own pose
//              stream: desktop or VR alike), and the holder's own hand is where its release pose is sent from.
//   flights    a launch (throw, drop, punt, a grab that let what rested on it fall) is a `sim` entry in the log. This
//              client folds it with the SAME engine the door runs (shared/v4/client.js: simFolder + eidosim, no
//              catalogue of its own: shapes are the log's physics.shape), so a flight on screen is the engine's
//              flight, and it rests bit for bit where the door logs the rest (tools/v4/physlive-check.ts F4/F6).
//              The screen shows a COPY of the canonical sim advanced to the server's clock (serverNow), interpolated
//              between ticks: the canonical fold advances only by the entries' own ts.
//   the body   the door measures reach from its own track of your body (L6, 25d M3). A person's client keeps that
//              track current with `move` requests (presence: unlogged), arriving once when the world has physics.
//
// Presentation only, like hair: the tumble of a flying crate and the roll of a ball. The engine is yaw-only; the
// orientation the log records at rest is the realizer's to draw once the rest arrives.

import { THREE } from './core.js';
import { bus } from './base.js';
import { entities } from './world.js';
import { remotes, serverNow } from './remotes.js';
import { heightAt } from './terrain.js';
import { colliders, suspendCollider } from './colliders.js';
import { pushHostHook } from './autohooks.js';
import { v4, net, requestV4, identities } from './net.js';
import { flashHint } from './ui.js';
import { logChat } from './chat.js';
import { register as registerAction } from './actions.js';
import { setPressFx, pressFxOn } from './emitters.js';
import { advanceSim, tickOf } from '../../shared/sim.js';
import { onWorldChange } from './state.js';
import { grabOf, holdPoseOf, fingerPose, armPose, bothArms, HAND_REACH } from '../../shared/grab.js';

const REACH = 1.5, HAND_Y = 1.1;                  // the door's: a hand reaches 1.5 m from feet + 1.1 m (door.js)
const KICK = { reach: 1.6, below: -0.5, above: 2.0 }; // the door's punt reach, from the feet
const TRACK_MS = 200, TRACK_MIN = 0.05;           // the body track: at most 5 moves a second, only when moved
const THROW = { speed: 8, arc: 0.45 };            // a desktop throw: along the view's heading, ~26° up
const PUNT_POWER = 4;                             // physobj's default: a barrel hops a couple of metres

let hooks = null;   // { myPos(): {x,y,z}, me(): Avatar|null, camera, editing(): bool }
export function initV4Phys(h) { hooks = h; pushHostHook(frame); }
// Am I in a headset? xr.js binds this (it imports this module, never the other way round): a tracked body holds with
// its own hands, so the hold pose's arms are only for a body without them.
let presenting = () => false;
export const bindPresenting = (fn) => { presenting = fn; };

// ---------------------------------------------------------------- who holds what (door presence)
let holds = {};     // id -> the door's hold record: { by: v4 identity, hand?, grip? | offset?, second? } (shared/grab.js holdWire)
const pulls = new Map();   // id -> { from: Vector3, t0, dur }: a new hold eases from where the thing was into the hand
bus.on('v4-holds', (h) => {
  const before = holds; holds = h && typeof h === 'object' ? h : {};
  for (const id of Object.keys(before)) if (!holds[id]) { released(id); pulls.delete(id); }
  for (const id of Object.keys(holds)) if (!before[id] || before[id].by !== holds[id].by) { suspendCollider(id, true); startPull(id); }
});
// the hand reaches out and the thing comes to it (Unity Attach Ease In, Godot LERP, Meta pull): presence only, every
// client the same; a far grab (grabbable.range past arm's reach) flies a little longer
function startPull(id) {
  const obj = entities.get(id); if (!obj) return;
  obj.updateWorldMatrix(true, false); const from = obj.getWorldPosition(new THREE.Vector3());
  const hand = handOf(holds[id].by, holds[id].hand ?? 'right'); const d = hand ? from.distanceTo(hand) : 0;
  pulls.set(id, { from, t0: performance.now(), dur: Math.min(400, Math.max(120, d / 8 * 1000)) });
}
// A put (or anything that writes where a held thing is) arrives as a state entry BEFORE the door's holds message says
// the hand is empty (server order: the log, then presence). From that entry on the fold has it: stop drawing it in the
// hand, or a frame between the two messages would leave it drawn there after the realizer placed it.
onWorldChange((ev) => {
  if (ev.type === 'change' && holds[ev.id] && ['pose', 'parent', 'gone', 'born'].includes(ev.what)) { const { [ev.id]: _, ...rest } = holds; holds = rest; released(ev.id); }
  else if (ev.type === 'reset') holds = {};
});
export const holdsNow = () => holds;
/** What I hold, per the door. */
export const myHolds = () => Object.keys(holds).filter((id) => holds[id].by === net.v4you);
function released(id) {
  // the realizer re-asserts where the log has it on its next change; until the fold or the sim owns it again, the
  // last drawn pose stays (a put's state entry and a throw's launch both arrive BEFORE this message: server order)
  if (!presOwns(id)) suspendCollider(id, false);
}
/** A presence id (the people map's key) for a door identity. */
function presenceIdOf(v4id) {
  if (v4id === net.v4you) return null;               // me
  for (const [pid, vid] of identities) if (vid === v4id) return pid;
  return undefined;
}

// ---------------------------------------------------------------- the body the door tracks
let arrived = false, moving = null, lastTrack = 0, doorAt = null, lastMove = null, lastTeleport = 0;
const feet = () => { const p = hooks?.myPos(); return p ? [p.x, p.y, p.z] : null; };
const r3 = (n) => Math.round(n * 1000) / 1000;
const worldHasPhysics = () => { const es = v4.st?.entities; if (!es) return false; if (es['@world']?.c.sim) return true;
  for (const id in es) if (es[id].c.physics?.kind === 'dynamic' || es[id].c.grabbable) return true; return false; };
bus.on('v4-joined', () => { arrived = false; doorAt = null; holds = {}; });
/** Bring the door's track of my body to where I stand. Resolves true when it's there (or close enough to act). */
async function track(force = false) {
  if (!v4.active || !net.joined) return false;
  const to = feet(); if (!to) return false;
  if (moving) { await moving; if (!force) return arrived; }
  const go = async () => {
    if (!arrived) {   // arriving: one act on the record, as an agent's first move is
      const r = await requestV4('move', { to: to.map(r3), client: 'human' }); lastMove = { arrive: true, ok: !!r?.ok, refused: r?.refused?.code };
      if (r?.ok) { arrived = true; doorAt = r.at ?? to; }
      else if (r?.refused) bus.emit('v4phys-refused', { tool: 'move', refused: r.refused });
      return arrived;
    }
    const d = doorAt ? Math.hypot(to[0] - doorAt[0], to[1] - doorAt[1], to[2] - doorAt[2]) : Infinity;
    if (!force && d < TRACK_MIN) return true;
    // walk the door's body toward mine in steps it accepts (6 m/s, 4 m at most at once: door TRACK)
    const k = d > 3.5 ? 3.5 / d : 1; const step = doorAt ? doorAt.map((v, i) => r3(v + (to[i] - v) * k)) : to.map(r3);
    let r = await requestV4('move', { to: step }); lastMove = { to: step, ok: !!r?.ok, refused: r?.refused?.code, reason: r?.refused?.reason };
    if (r?.ok) { doorAt = r.at ?? step; return true; }
    if (r?.refused?.at) doorAt = r.refused.at;
    stuck = { at: to, until: performance.now() + 2000 };
    // the door lost me (flew faster than a body walks, or through something it calls solid): re-arrive, an act on the
    // record, which it refuses while I hold something (a teleport can't carry things)
    // (at most once in 3 s: each is an act on the record, and flying fast would otherwise write one per step)
    if (['too-fast', 'solid'].includes(r?.refused?.code) && !myHolds().length && (force || performance.now() - lastTeleport > 3000)) {
      lastTeleport = performance.now();
      r = await requestV4('move', { to: to.map(r3), teleport: true }); lastMove = { teleport: true, ok: !!r?.ok, refused: r?.refused?.code, reason: r?.refused?.reason };
      if (r?.ok) { doorAt = r.at ?? to; return true; }
    }
    return false;
  };
  moving = go().catch(() => false).finally(() => { moving = null; lastTrack = performance.now(); });
  return moving;
}
let stuck = null;   // {at, until}: a refused step isn't re-sent until I've moved on from it, or a while has passed
function tickTrack(now) {
  if (!v4.active || moving || now - lastTrack < TRACK_MS) return;
  if (hooks?.seated?.()) return;   // a seated body is where its seat is; it walks again when it stands
  if (stuck) { const f = feet(); if (now < stuck.until && f && Math.hypot(f[0] - stuck.at[0], f[2] - stuck.at[2]) < 0.3) return; stuck = null; }
  if (!arrived) { if (worldHasPhysics()) track(); else lastTrack = now; return; }
  const to = feet(); if (!to || !doorAt) return;
  if (Math.hypot(to[0] - doorAt[0], to[1] - doorAt[1], to[2] - doorAt[2]) >= TRACK_MIN) track();
}

// ---------------------------------------------------------------- the hand
const _hp = new THREE.Vector3(), _fw = new THREE.Vector3();
const avatarOf = (v4id) => { const pid = presenceIdOf(v4id); return pid === null ? hooks?.me() : pid ? remotes.get(pid)?.avatar : null; };
/** Is this holder's body tracked (a headset: their own hands hold it)? */
function tracked(v4id) { const pid = presenceIdOf(v4id); if (pid === null) return presenting(); const r = pid ? remotes.get(pid) : null; return !!(r?.xrSample || r?.lastPose?.xr); }
/** Where a holder's hand is in the world: their avatar's hand bone (left or right), else in front of their chest. */
function handOf(v4id, side = 'right', out = _hp) {
  const av = avatarOf(v4id);
  // the RAW bone: the skinned skeleton the person sees. (The normalized rig is a proxy; on a cloned avatar it can be
  // another body's — the browser probe saw Bob's box drawn in Ann's hand through it.)
  const bone = av?.vrm?.humanoid?.getRawBoneNode?.(`${side}Hand`) ?? av?.vrm?.humanoid?.getNormalizedBoneNode?.(`${side}Hand`);
  if (bone) { bone.updateWorldMatrix(true, false); return bone.getWorldPosition(out); }
  const root = av?.root; if (!root) return null;
  root.getWorldPosition(out); root.getWorldDirection(_fw); _fw.y = 0; if (_fw.lengthSq() > 1e-9) _fw.normalize();
  return out.set(out.x + _fw.x * 0.35, out.y + HAND_Y, out.z + _fw.z * 0.35);
}
// The PALM's frame, in the world (shared/grab.js: a grip says where the palm goes: +Z out of the palm, +Y along the
// fingers' base, from the little finger to the index). Read off the hand's own raw bones (wrist, index, middle and little
// knuckles), so it is right for any rig: the normalized rig is a proxy that can belong to another body (see handOf). The
// origin sits in the closed hand, three quarters of the way to the knuckles and a little out of the palm. A rig without
// finger bones uses the normalized hand's rotation (palm down, fingers out in its T-pose).
const _pa = new THREE.Vector3(), _pb = new THREE.Vector3(), _pc = new THREE.Vector3(), _pd = new THREE.Vector3();
const _px = new THREE.Vector3(), _py = new THREE.Vector3(), _pz = new THREE.Vector3(), _pm = new THREE.Matrix4();
const PALM_Q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2);   // grip frame in a T-pose hand bone
function palmOf(v4id, side, out) {
  const av = avatarOf(v4id); const H = av?.vrm?.humanoid; if (!H) return null;
  const raw = (n) => H.getRawBoneNode?.(n) ?? null;
  const hand = raw(`${side}Hand`); if (!hand) return null;
  hand.updateWorldMatrix(true, true); hand.getWorldPosition(_pa);
  const mid = raw(`${side}MiddleProximal`), idx = raw(`${side}IndexProximal`), lit = raw(`${side}LittleProximal`);
  if (mid && idx && lit) {
    mid.getWorldPosition(_pb); idx.getWorldPosition(_pc); lit.getWorldPosition(_pd);
    const len = _pb.distanceTo(_pa);
    _px.subVectors(_pb, _pa).normalize();          // along the fingers
    _py.subVectors(_pc, _pd).normalize();          // across the knuckles, little → index
    if (side === 'right') _pz.crossVectors(_py, _px); else _pz.crossVectors(_px, _py);
    _pz.normalize(); _py.sub(_pd.copy(_pz).multiplyScalar(_py.dot(_pz))).normalize(); _px.crossVectors(_py, _pz);
    _pm.makeBasis(_px, _py, _pz); out.q.setFromRotationMatrix(_pm);
    out.p.copy(_pa).lerp(_pb, 0.75).addScaledVector(_pz, len * 0.25);
    return out;
  }
  const n = H.getNormalizedBoneNode?.(`${side}Hand`); if (!n) return null;
  n.updateWorldMatrix(true, false); n.getWorldQuaternion(out.q).multiply(PALM_Q); out.p.copy(_pa);
  return out;
}
// a thing's visual centre, local to its origin (its collider box): held by its middle, not its base
const _c = new THREE.Vector3();
function localCentre(id, obj) {
  const b = colliders.get(id)?.box; if (!b) return _c.set(0, 0.1, 0);
  const s = obj.scale ?? { x: 1, y: 1, z: 1 };
  return _c.set((b.min.x + b.max.x) / 2 * (s.x || 1), (b.min.y + b.max.y) / 2 * (s.y || 1), (b.min.z + b.max.z) / 2 * (s.z || 1));
}
/** A thing's measured size (its collider box × scale), or null. */
function sizeOf(id, obj) { const b = colliders.get(id)?.box; if (!b) return null; const s = obj?.scale ?? { x: 1, y: 1, z: 1 };
  return [(b.max.x - b.min.x) * (s.x || 1), (b.max.y - b.min.y) * (s.y || 1), (b.max.z - b.min.z) * (s.z || 1)]; }
const _w = new THREE.Vector3(), _q = new THREE.Quaternion(), _m = new THREE.Matrix4(), _s = new THREE.Vector3();
/** Draw obj at a WORLD pose whatever its scene parent (a thing that rested on a table may hang under it). */
function setWorldPose(obj, pos, quat) {
  if (!obj.parent || obj.parent.isScene) { obj.position.copy(pos); if (quat) obj.quaternion.copy(quat); return; }
  obj.parent.updateWorldMatrix(true, false);
  _m.copy(obj.parent.matrixWorld).invert();
  obj.position.copy(pos).applyMatrix4(_m);
  if (quat) { obj.parent.matrixWorld.decompose(_w, _q, _s); obj.quaternion.copy(_q.invert().multiply(quat)); }
}
const compsOf = (id) => v4.st?.entities?.[id]?.c ?? null;
const _held = new THREE.Vector3(), _hq = new THREE.Quaternion(), _ws = new THREE.Vector3(), _tq = new THREE.Quaternion(), _tp = new THREE.Vector3();
const _gq = new THREE.Quaternion(), _gv = new THREE.Vector3(), _v2 = new THREE.Vector3(), _aq = new THREE.Quaternion();
const P1 = { p: new THREE.Vector3(), q: new THREE.Quaternion() }, P2 = { p: new THREE.Vector3(), q: new THREE.Quaternion() };
/** Where a held thing goes, from the holder's hand bone and the door's hold record (every client computes the same):
 *  a grip puts the palm on the grip (VRChat ExactGrip, Unity Attach Transform); an offset keeps it where the hand took
 *  it (Unreal Free); neither, it's held by its centre (what the door did before grips). A second hand on a twoHanded
 *  thing steers it: the line from the primary grip to the secondary one points from hand to hand. A body without
 *  tracked hands carrying in both arms holds it between them. Returns the world {p, q} (q null: keep its rotation). */
function heldPose(id, h, obj) {
  const g = grabOf(compsOf(id)); const side = h.hand ?? 'right';
  const grip = h.grip ? g?.grips?.[h.grip] : null;
  obj.getWorldScale(_ws);
  if (!tracked(h.by) && g && bothArms(holdPoseOf(g, sizeOf(id, obj))) && !grip) {
    const a = palmOf(h.by, 'right', P1), b = palmOf(h.by, 'left', P2);
    if (a && b) { obj.getWorldQuaternion(_hq); _held.copy(localCentre(id, obj)).applyQuaternion(_hq); return { p: _tp.copy(a.p).lerp(b.p, 0.5).sub(_held), q: null }; }
  }
  const palm = (grip || h.offset) ? palmOf(h.by, side, P1) : null;
  if (palm && grip) {
    _gq.fromArray(grip.q); _tq.copy(palm.q).multiply(_gq.invert());
    _tp.copy(palm.p).sub(_gv.fromArray(grip.pos).multiply(_ws).applyQuaternion(_tq));
    const sg = h.second?.grip ? g.grips[h.second.grip] : null;
    if (g.twoHanded && h.second && sg) { const p2 = palmOf(h.by, h.second.hand, P2);
      if (p2) { _gv.fromArray(sg.pos).sub(_v2.fromArray(grip.pos)).multiply(_ws).applyQuaternion(_tq);
        _v2.subVectors(p2.p, palm.p);
        if (_gv.lengthSq() > 1e-8 && _v2.lengthSq() > 1e-8) { _aq.setFromUnitVectors(_gv.normalize(), _v2.normalize()); _tq.premultiply(_aq); _tp.sub(palm.p).applyQuaternion(_aq).add(palm.p); } } }
    return { p: _tp, q: _tq };
  }
  if (palm && h.offset) { _tq.copy(palm.q).multiply(_gq.fromArray(h.offset.q)); _tp.copy(palm.p).add(_gv.fromArray(h.offset.pos).applyQuaternion(palm.q)); return { p: _tp, q: _tq }; }
  const hand = handOf(h.by, side); if (!hand) return null;
  obj.getWorldQuaternion(_hq); _held.copy(localCentre(id, obj)).applyQuaternion(_hq);
  return { p: _tp.copy(hand).sub(_held), q: null };
}
function drawHeld() {
  const now = performance.now();
  for (const [id, h] of Object.entries(holds)) {
    if (pres?.bodies?.[id]) continue;              // thrown or dropped: the launch is folded, the flight draws it
    const obj = entities.get(id); if (!obj) continue;
    const at = heldPose(id, h, obj); if (!at) continue;
    const pull = pulls.get(id);
    if (pull) { const k = Math.min(1, (now - pull.t0) / pull.dur); if (k >= 1) pulls.delete(id); else { const e = 1 - (1 - k) ** 3; at.p.lerpVectors(pull.from, at.p, e); } }
    setWorldPose(obj, at.p, at.q);
  }
  poseHolders();
}
// What holding does to each holder's body (avatar.js setHoldPose): the grip's finger preset on each holding hand, and,
// for a body without tracked hands, the arms' hold pose (grabbable.pose, else by size). Recomputed every frame from the
// door's record; an avatar that stops holding lets go.
const posed = new Set();
function poseHolders() {
  const want = new Map();
  for (const [id, h] of Object.entries(holds)) {
    const av = avatarOf(h.by); if (!av?.vrm) continue;
    const g = grabOf(compsOf(id)); const side = h.hand ?? 'right';
    let m = want.get(av); if (!m) want.set(av, (m = { bones: {}, fingers: {} }));
    const grip = h.grip ? g?.grips?.[h.grip] : null;
    Object.assign(m.bones, fingerPose(grip?.fingers ?? 'fist', side, grip?.hold ?? {})); m.fingers[side] = true;
    if (h.second) { const sg = h.second.grip ? g?.grips?.[h.second.grip] : null; Object.assign(m.bones, fingerPose(sg?.fingers ?? 'fist', h.second.hand, sg?.hold ?? {})); m.fingers[h.second.hand] = true; }
    if (!tracked(h.by) && g) { const preset = holdPoseOf(g, sizeOf(id, entities.get(id)));
      Object.assign(m.bones, armPose(preset, side));
      if (bothArms(preset)) { const o = side === 'right' ? 'left' : 'right'; Object.assign(m.bones, fingerPose('fist', o)); m.fingers[o] = true; } }
  }
  for (const av of posed) if (!want.has(av)) { av.setHoldPose?.(null); if (av.vrm?.userData) av.vrm.userData._holdFingers = null; posed.delete(av); }
  for (const [av, m] of want) { av.setHoldPose?.(m.bones); (av.vrm.userData ||= {})._holdFingers = m.fingers; posed.add(av); }
}
/** Where a thing I hold is drawn (its origin, world): the release pose sent with throw/drop. */
function heldPos(id) { const obj = entities.get(id); if (!obj) return null; obj.updateWorldMatrix(true, false); return obj.getWorldPosition(new THREE.Vector3()); }

// ---------------------------------------------------------------- flights (the engine's, at display time)
let pres = null, presV = -1, tickSeen = -1, lastAt = 0;
const prev = new Map();      // id -> [x, y, z] at the tick before pres.tick (the interval's start)
const spins = new Map();     // id -> presentation state {q, kind, r, arm, box}
const presOwns = (id) => !!pres?.bodies?.[id];
const _axis = new THREE.Vector3(), _dq = new THREE.Quaternion(), _upq = new THREE.Quaternion(), _p = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);
const TUMBLE = 2.2;          // rad/s while airborne (simworld's)
/** Console/probe surface: the displayed sim (a copy), and the canonical fold's view. */
export const simShown = () => pres;
function shapeKind(id, obj) {
  const b = colliders.get(id)?.box; if (!b) return null;
  const s = obj.scale ?? { x: 1, y: 1, z: 1 };
  const d = [(b.max.x - b.min.x) * (s.x || 1), (b.max.y - b.min.y) * (s.y || 1), (b.max.z - b.min.z) * (s.z || 1)].sort((a, c) => a - c);
  const arm = Math.hypot((b.min.x + b.max.x) / 2 * (s.x || 1), (b.min.z + b.max.z) / 2 * (s.z || 1));
  // physobj's law: round-ish in all three AND ball-sized rolls; anything else tumbles like a crate
  const ball = d[0] > 0.01 && d[2] / d[0] < 1.25 && d[2] < 0.9;
  return { ball, r: ball ? (d[0] + d[1] + d[2]) / 6 : d[1] / 2, arm, box: b };
}
function drawFlights(wall, now) {
  const canon = v4.sim;
  if (!canon?.sim || canon.foreign) { if (pres) { for (const id of Object.keys(pres.bodies)) suspendCollider(id, false); } pres = null; prev.clear(); return; }
  if (presV !== v4.simVersion) {
    const was = pres ? Object.keys(pres.bodies) : [];
    pres = v4.simClone(); presV = v4.simVersion; tickSeen = -1; stats.clones++;
    for (const id of was) if (!pres.bodies[id] && !holds[id]) suspendCollider(id, false);   // its rest is the fold's now
  }
  const target = tickOf(pres, wall);
  if (pres.tick !== tickSeen) prev.clear();
  if (pres.tick < target) {
    if (pres.tick < target - 1) advanceSim(pres, target - 1);
    for (const id in pres.bodies) { const b = pres.bodies[id]; let pv = prev.get(id); if (!pv) prev.set(id, (pv = [0, 0, 0])); pv[0] = b.p[0]; pv[1] = b.p[1]; pv[2] = b.p[2]; }
    advanceSim(pres, target);
  }
  tickSeen = pres.tick;
  const k = Math.min(1, Math.max(0, (wall - pres.epoch.ts) / pres.epoch.tickMs - (pres.tick - 1)));
  const dt = Math.min(0.1, (now - (lastAt || now)) / 1000); lastAt = now;
  for (const id in pres.bodies) {
    // (a body here is a launch folded AFTER any grab: a grab is a lift, which takes the body out, so the engine wins
    //  over a hold the door hasn't yet said is over)
    const b = pres.bodies[id]; const obj = entities.get(id); if (!obj) continue;
    let sp = spins.get(id);
    if (!sp) { obj.getWorldQuaternion(_hq); sp = { q: _hq.clone(), shape: null, box: undefined }; spins.set(id, sp); suspendCollider(id, true); }
    const box = colliders.get(id)?.box ?? null; if (box !== sp.box) { sp.box = box; sp.shape = shapeKind(id, obj); }
    const pv = b.resting ? undefined : prev.get(id);
    if (pv) _p.set(pv[0] + (b.p[0] - pv[0]) * k, pv[1] + (b.p[1] - pv[1]) * k, pv[2] + (b.p[2] - pv[2]) * k);
    else _p.set(b.p[0], b.p[1], b.p[2]);
    const flat = Math.hypot(b.v[0], b.v[2]); const sh = sp.shape; const q = sp.q;
    if (sh?.ball && !b.resting && flat > 0.01 && sh.arm < 0.5) {
      // a ball ROLLS with its travel (and spins in the air): physobj streamed this as q so a ball never slid
      _axis.set(b.v[2], 0, -b.v[0]).normalize(); _dq.setFromAxisAngle(_axis, (flat * dt) / Math.max(0.05, sh.r)); q.premultiply(_dq);
    } else if (sh && !sh.ball && !b.resting && b.v[1] !== 0 && flat > 0.05 && sh.arm < 0.5) {
      _axis.set(b.v[2], 0, -b.v[0]).normalize(); _dq.setFromAxisAngle(_axis, TUMBLE * dt); q.premultiply(_dq);
    } else if (!sh?.ball) {
      // grounded (the engine zeroes v[1] at contact): right itself to the engine's yaw, as the log will have it
      _upq.setFromAxisAngle(UP, b.yaw); q.slerp(_upq, Math.min(1, 6 * dt));
    }
    // the engine stands the ORIGIN on its ground; a far-offset mesh (the barrels group) lifts by the terrain difference
    // under its visual centre (simworld's §24t-6 rule), presentation only
    if (sh && !b.on) { const cx = (sh.box.min.x + sh.box.max.x) / 2, cz = (sh.box.min.z + sh.box.max.z) / 2;
      const c = Math.cos(b.yaw), s = Math.sin(b.yaw); const wx = _p.x + cx * c + cz * s, wz = _p.z - cx * s + cz * c;
      try { _p.y += heightAt(wx, wz) - heightAt(_p.x, _p.z); } catch { /* no terrain */ } }
    setWorldPose(obj, _p, q);
    if (obj.userData.base?.pos) { obj.userData.base.pos[0] = b.p[0]; obj.userData.base.pos[1] = b.p[1]; obj.userData.base.pos[2] = b.p[2]; }
  }
  for (const id of spins.keys()) if (!pres.bodies[id]) spins.delete(id);
}

const stats = { frames: 0, ms: 0, clones: 0, maxMs: 0 };
/** One presentation frame. `wall` (the server clock, ms) may be given: a probe can sample the real applier at exact
 *  display times without depending on the page's frame rate (simworld's bench rule). */
function frame(wall) {
  if (!v4.active) return;
  const now = performance.now();
  drawFlights(wall ?? serverNow(), now);
  drawHeld();
  drawPressFx();
  tickTrack(now);
  const ms = performance.now() - now; stats.frames++; stats.ms += ms; if (ms > stats.maxMs) stats.maxMs = ms;
}

// ---------------------------------------------------------------- acts (door requests)
const say = (t) => logChat('*', t);
const refused = (what, r) => { const x = r?.refused; say(`${what}: ${x?.reason ?? 'the door said no'}${x?.teach ? ` (${x.teach})` : ''}`); bus.emit('v4phys-refused', { tool: what, refused: x }); return r; };
// what a hand may pick up: grabbable (shared/grab.js grabOf: the door's own reader, so a dynamic thing with no grabbable
// counts, as at the door); what a foot may punt: physics {kind: 'dynamic'}
const grabbableIds = () => { const es = v4.st?.entities ?? {}; return Object.keys(es).filter((id) => grabOf(es[id].c)?.enabled); };
const dynamicIds = () => { const es = v4.st?.entities ?? {}; return Object.keys(es).filter((id) => es[id].c.physics?.kind === 'dynamic'); };
/** Where the thing is now, as the door sees it: someone's hand, the air (the engine), or the log. */
function whereIs(id) {
  const b = pres?.bodies?.[id]; if (b && !b.resting) return b.p;
  const obj = entities.get(id); if (obj) { obj.updateWorldMatrix(true, false); return obj.getWorldPosition(new THREE.Vector3()).toArray(); }
  return null;
}
// the nearest a test accepts; for grabbing, the highest grabbable.priority first (the key, not the table: Resonite)
function nearest(ok, ids = dynamicIds(), prio = () => 0) {
  const f = feet(); if (!f) return null; let best = null, bd = Infinity, bp = -Infinity;
  for (const id of ids) { if (holds[id]) continue; const p = whereIs(id); if (!p) continue; const d = ok(p, f, id); if (d === null) continue;
    const pr = prio(id); if (pr > bp || (pr === bp && d < bd)) { bd = d; bp = pr; best = id; } }
  return best;
}
const rangeOf = (id) => grabOf(compsOf(id))?.range ?? REACH;
const prioOf = (id) => grabOf(compsOf(id))?.priority ?? 0;
const inHand = (p, f, id) => { const d = Math.hypot(p[0] - f[0], p[1] - (f[1] + HAND_Y), p[2] - f[2]); return d <= (id ? rangeOf(id) : REACH) ? d : null; };
const atFeet = (p, f) => { const dh = Math.hypot(p[0] - f[0], p[2] - f[2]), dy = p[1] - f[1]; return dh <= KICK.reach && dy >= KICK.below && dy <= KICK.above ? dh : null; };

/** Pick something up: the named thing, or the nearest you can reach. */
export async function grab(name) {
  if (!v4.active) return say('carrying works in v4 worlds');
  const id = name || nearest(inHand, grabbableIds(), prioOf);
  if (!id) return say('nothing here you can pick up within reach (things with a grabbable component)');
  await track(true);
  const r = await requestV4('grab', { id });
  if (!r?.ok) return refused('grab', r);
  flashHint(`holding ${id}${r.notes?.some((n) => n.takenFrom) ? ' (taken from someone)' : ''} — T puts it down, C throws`);
  return r;
}
/** Set down what you hold (straight down onto what's below your hand). */
export async function put(name) {
  const id = name || myHolds()[0]; if (!id) return say('you aren\'t holding anything');
  await track(true);
  const r = await requestV4('put', { id });
  return r?.ok ? r : refused('put', r);
}
/** Let go: it falls (with physics) from where your hand is. */
export async function drop(name) {
  const id = name || myHolds()[0]; if (!id) return say('you aren\'t holding anything');
  await track(true);
  const pos = heldPos(id); const r = await requestV4('drop', { id, ...(pos ? { pos: pos.toArray().map(r3) } : {}) });
  return r?.ok ? r : refused('drop', r);
}
/** Throw what you hold along your view, from your hand. */
export async function throwHeld(arg) {
  const id = myHolds()[0]; if (!id) return say('you aren\'t holding anything');
  const speed = Math.min(20, Math.max(1, parseFloat(arg) || THROW.speed));
  // where you look, as an arc: the view's heading, lifted by THROW.arc, and higher when you look up (a third-person
  // camera always looks down at your body: its pitch alone would throw everything flat into the ground)
  const cam = hooks?.camera; const dir = new THREE.Vector3(0, 0, 1);
  if (cam) cam.getWorldDirection(dir);
  const h = Math.hypot(dir.x, dir.z) || 1, up = Math.min(1.2, THROW.arc + Math.max(0, Math.asin(Math.max(-1, Math.min(1, dir.y)))));
  const v = [dir.x / h * Math.cos(up) * speed, Math.sin(up) * speed, dir.z / h * Math.cos(up) * speed].map(r3);
  await track(true);
  const pos = heldPos(id);
  const r = await requestV4('throw', { id, v, ...(pos ? { pos: pos.toArray().map(r3) } : {}) });
  return r?.ok ? r : refused('throw', r);
}
/** A hand's grab (VR grip, or any caller with a hand position [x, y, z]): the nearest thing it can carry within reach of
 *  that point and of the door's hand. The same door request the desktop key sends. */
export async function grabNear(at, within = 0.6) {
  const f = feet(); if (!f) return null; let best = null, bd = within;
  for (const id of grabbableIds()) { if (holds[id]) continue; const obj = entities.get(id); if (!obj) continue;
    const c = obj.getWorldPosition(new THREE.Vector3()).add(localCentre(id, obj)); const d = Math.hypot(c.x - at[0], c.y - at[1], c.z - at[2]);
    if (d < bd && inHand(c.toArray(), f, id) !== null) { bd = d; best = id; } }
  return best ? grab(best) : null;
}
/** A hand letting go with a velocity (VR: the controller's; [0,0,0] is a drop), from where the thing is drawn in it. */
export async function release(v = [0, 0, 0], name) {
  const id = name || myHolds()[0]; if (!id) return null;
  await track(true);
  const pos = heldPos(id); const still = v.every((n) => Math.abs(n) < 0.05);
  const r = await requestV4(still ? 'drop' : 'throw', { id, ...(still ? {} : { v: v.map(r3) }), ...(pos ? { pos: pos.toArray().map(r3) } : {}) });
  return r?.ok ? r : refused(still ? 'drop' : 'throw', r);
}
/** /punt [thing] [power]: kick the named thing, or the nearest at your feet, through it from where you stand. */
export async function punt(arg) {
  if (!v4.active) return say('punting works in v4 worlds');
  const parts = (arg || '').trim().split(/\s+/).filter(Boolean);
  const named = parts.find((x) => !/^[\d.]+$/.test(x));
  const power = Math.min(20, Math.max(0.5, parseFloat(parts.find((x) => /^[\d.]+$/.test(x))) || PUNT_POWER));
  const id = named || nearest(atFeet);
  if (!id) return say('nothing at your feet to punt (things with physics {kind: dynamic})');
  await track(true);
  const r = await requestV4('punt', { id, power });
  if (!r?.ok) return refused('punt', r);
  flashHint(`you punt ${id}${r.volley ? ' (a volley)' : ''}`);
  return r;
}

// ---------------------------------------------------------------- use while held (grabbable.use; research grab §3-4)
// The use button while you hold a thing: a door request per press and per release (use.down, use.up: each one act; a
// hose turns on, then off), and, while it's pressed, presence (pose.use) every client draws the thing's fx from. Desktop:
// the left mouse button while holding something usable (outside edit mode); phone: a button that appears while you do;
// VR: the trigger (xr.js calls useHeld). Rapid effects are never a stream of acts: the door rate-limits acts on purpose.
const usable = () => myHolds().find((id) => grabOf(compsOf(id))?.use) ?? null;
let pressing = null;   // the id my use is held down on
/** Press (phase 'down') or release ('up') the use of what I hold. Returns the door's reply, or null if nothing to use. */
export async function useHeld(phase = 'down', name) {
  const id = name || (phase === 'up' ? pressing : usable()); if (!id) return null;
  const h = holds[id]; const g = grabOf(compsOf(id));
  const st = hooks?.myState?.();
  if (phase === 'down') { pressing = id; if (st && g?.fx) st.useHeld = { id, hand: h?.hand ?? 'right' }; }
  else { if (pressing === id) pressing = null; if (st?.useHeld?.id === id) st.useHeld = null; }
  if (!g?.use || !(phase === 'down' ? g.use.down : g.use.up)) return { ok: true, recorded: false, note: `nothing happens on use ${phase}` };
  const r = await requestV4('use', { id, args: { held: true, hand: h?.hand ?? 'right', phase } });
  return r?.ok ? r : refused('use', r);
}
// every holder pressing use on what they hold, from presence (mine: myState; theirs: the latest sample of their pose)
function drawPressFx() {
  for (const [id, h] of Object.entries(holds)) {
    const g = grabOf(compsOf(id)); if (!g?.fx) { setPressFx(id, null); continue; }
    const pid = presenceIdOf(h.by);
    const use = pid === null ? hooks?.myState?.()?.useHeld : pid ? remotes.get(pid)?.buf?.at(-1)?.use : null;
    setPressFx(id, use?.id === id ? g.fx : null);
  }
  for (const id of fxIds) if (!holds[id]) setPressFx(id, null);
  fxIds = new Set(Object.keys(holds));
}
let fxIds = new Set();
if (typeof document !== 'undefined') {
  // capture phase: while I hold something usable, the left button is its use, not a look-drag
  addEventListener('mousedown', (e) => {
    if (e.button !== 0 || e.target?.tagName !== 'CANVAS' || hooks?.editing?.() || !v4.active || !usable()) return;
    e.stopImmediatePropagation(); e.preventDefault(); void useHeld('down');
  }, true);
  addEventListener('mouseup', (e) => { if (e.button === 0 && pressing) void useHeld('up'); }, true);
  // the phone's action button: shown while I hold something usable, labelled with what it does
  let btn = null;
  const sync = () => { const box = document.getElementById('touchbtns'); if (!box || !document.body.classList.contains('touch')) return;
    const id = usable(); const g = id ? grabOf(compsOf(id)) : null;
    if (!btn) { btn = document.createElement('button'); btn.className = 'panel usebtn'; btn.style.display = 'none';
      btn.addEventListener('pointerdown', (e) => { e.preventDefault(); void useHeld('down'); });
      btn.addEventListener('pointerup', () => { if (pressing) void useHeld('up'); }); btn.addEventListener('pointercancel', () => { if (pressing) void useHeld('up'); });
      box.prepend(btn); }
    btn.style.display = id ? '' : 'none'; if (g) btn.textContent = g.use.down ?? g.use.up; };
  bus.on('v4-holds', () => setTimeout(sync, 0));
}

// ---------------------------------------------------------------- keys: T take/put · C throw/punt
const KEYS = [
  { code: 'KeyT', key: 'T', id: 'body:take', title: 'pick up / put down', keywords: ['grab', 'carry', 'hold', 'take', 'put'], icon: 'hand',
    run: () => (myHolds().length ? put() : grab()) },
  { code: 'KeyC', key: 'C', id: 'body:throw', title: 'throw what you hold / punt what\'s at your feet', keywords: ['throw', 'kick', 'punt', 'toss'],
    run: () => (myHolds().length ? throwHeld() : punt()) },
];
for (const { code, ...a } of KEYS) registerAction({ ...a, group: 'body' });
bus.on('key', (e) => {
  if (e.repeat || e.ctrlKey || e.metaKey || e.altKey || hooks?.editing?.()) return;
  KEYS.find((k) => k.code === e.code)?.run();
});

/** The surface a runtime mod scripts against (mods.js EW.physics): the same door requests the keys send. */
export const physicsApi = { grab, put, drop, throw: throwHeld, punt, grabNear, release, use: useHeld, holds: holdsNow, mine: myHolds, shown: simShown,
  /** the held things whose fx this client is drawing now (grabbable's presence tier) */
  fx: () => pressFxOn(),
  /** what a hand may do with a thing (shared/grab.js grabOf over this client's fold), or null */
  grabbable: (id) => grabOf(compsOf(id)),
  /** probe surface: where a held thing should be drawn now (heldPose, fresh) beside where it is drawn */
  heldAt: (id) => { const h = holds[id], obj = entities.get(id); if (!h || !obj) return null; obj.updateWorldMatrix(true, false);
    const at = heldPose(id, h, obj); return { want: at ? { p: at.p.toArray(), q: at.q?.toArray() ?? null } : null, drawn: { p: obj.getWorldPosition(new THREE.Vector3()).toArray(), q: obj.getWorldQuaternion(new THREE.Quaternion()).toArray() }, rec: h }; },
  /** probe surface: the palm frame a holder's hand gives ({p, q} world arrays), and the hold pose a body wears */
  palm: (v4id, side = 'right') => { const o = palmOf(v4id ?? net.v4you, side, { p: new THREE.Vector3(), q: new THREE.Quaternion() }); return o ? { p: o.p.toArray(), q: o.q.toArray() } : null; },
  track: () => track(true), request: (tool, args) => requestV4(tool, args), frame: (wall) => frame(wall),
  /** the canonical fold's flights: id -> the launch seq it flies from */
  launched: () => Object.fromEntries(Object.entries(v4.sim?.launched ?? {}).map(([id, l]) => [id, l.seq])),
  /** what this client believes about its door body (diagnostics) */
  body: () => ({ arrived, doorAt, feet: feet(), lastMove, stats: { ...stats, ms: Math.round(stats.ms), maxMs: +stats.maxMs.toFixed(2) } }) };
