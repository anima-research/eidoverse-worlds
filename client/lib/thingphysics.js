// thingphysics — physics in a world, on the client (design 20: the physics design note, research 20).
//
// TODAY nothing here simulates for anyone else and nothing is streamed: every act is a REQUEST, and every client draws
// the same truth. That is this client's current state, not the protocol's limit: spec/PHYSICS.md §4.1 lets whoever
// holds or touches a thing simulate it locally and stream its state on a presence lane (§4.3, reserved), crossing into
// the engine only through log entries (a lift; a launch or a checked settlement). Continuous contact gives no unlogged
// impulse TO THE ENGINE; it was never a ban on live hands.
//
//   carrying   grab / put / throw / drop / punt are requests (shared/protocol/authority.js). Who holds what is the authority's
//              presence plane (`holds`, never logged); every client draws a held thing in its holder's hand, so it
//              follows the hand for everyone (a remote's hand is their avatar's hand bone, driven by their own pose
//              stream: desktop or VR alike), and the holder's own hand is where its release pose is sent from.
//   flights    a launch (throw, drop, punt, a grab that let what rested on it fall) is a `sim` entry in the log. This
//              client folds it with the SAME engine the authority runs (shared/protocol/replica.js: simFolder + eidosim, no
//              catalogue of its own: shapes are the log's physics.shape), so a flight on screen is the engine's
//              flight, and it rests bit for bit where the authority logs the rest (tools/protocol/physlive-check.ts F4/F6).
//              The screen shows a COPY of the canonical sim advanced to the server's clock (serverNow), interpolated
//              between ticks: the canonical fold advances only by the entries' own ts.
//   the body   the authority measures reach from its own track of your body (L6, 25d M3). A person's client keeps that
//              track current with `move` requests (presence: unlogged), arriving once when the world has physics.
//
// The engine (eidosim) carries each body's whole rotation: a flying crate's tumble and a ball's roll are drawn as the
// engine has them, slerped between ticks; the rotation the log records at rest is the realizer's once the rest arrives.

import { THREE } from './core.js';
import { bus } from './base.js';
import { entities } from './world.js';
import { remotes, serverNow } from './remotes.js';
import { colliders, suspendCollider } from './colliders.js';
import { pushHostHook } from './autohooks.js';
import { colliderFor } from './bodyscale.js';
import { replica, net, sendRequest as rawSend, identities } from './net.js';
import { flashHint } from './ui.js';
import { logChat } from './chat.js';
import { register as registerAction } from './actions.js';
import { setPressFx, pressFxOn } from './emitters.js';
import { advanceSim, tickOf, ENGINES, engineViewM } from '../../shared/protocol/simlayer.js';
import { simEntry } from '../../shared/sim.js';
import { planVelocity } from '../../shared/protocol/launchplan.js';
import { clockRtt } from './serverclock.js';
import { onWorldChange } from './state.js';
import { plain, nameOf } from './plainwords.js';
import { html } from './markup.js';
import { xrActive } from './xrask.js';
import { grabOf, holdPoseOf, fingerPose, armPose, bothArms, pickGrip, HAND_REACH, NEAR_GRAB } from '../../shared/grab.js';

const REACH = 1.5, HAND_Y = 1.1;                  // the authority's: a hand reaches 1.5 m from feet + 1.1 m (authority.js)
const KICK = { reach: 1.6, below: -0.5, above: 2.0 }; // the authority's punt reach, from the feet
const TRACK_MS = 200, TRACK_MIN = 0.05;           // the body track: at most 5 moves a second, only when moved
const THROW = { speed: 8, arc: 0.45, lob: 0.6 };   // a desktop throw with no aim: the way my body faces, ~26° up; aimed: a lob of ~34° or steeper
const PUNT_POWER = 4;                             // physobj's default: a barrel hops a couple of metres

let hooks = null;   // { myPos(): {x,y,z}, me(): Avatar|null, camera, editing(): bool }
// The frame loop hands every hook its own clock (main.js: updateAutoSystems(t), SECONDS since boot). frame() takes a
// SERVER time in ms (a probe's seam), so the bare function as the hook read "12.3" as the wall clock: tick 0, and the
// displayed flights never advanced between folds (R, 10-10: "object location updates every few seconds", a domino
// "stuck in this tilted position"). Every probe passed its own wall, so none saw it.
export function initThingPhysics(h) { hooks = h; pushHostHook(() => frame()); }
export const myAvatar = () => hooks?.me() ?? null;
// Am I in a headset? xr.js binds this (it imports this module, never the other way round): a tracked body holds with
// its own hands, so the hold pose's arms are only for a body without them.
let presenting = () => false;
export const bindPresenting = (fn) => { presenting = fn; };

// ---------------------------------------------------------------- who holds what (the authority's presence plane)
let holds = {};     // id -> the authority's hold record: { by: identity, hand?, grip? | offset?, second? } (shared/grab.js holdWire)
const pulls = new Map();   // id -> { from: Vector3, t0, dur }: a new hold eases from where the thing was into the hand
bus.on('holds', (h) => {
  const before = holds; holds = h && typeof h === 'object' ? h : {};
  for (const id of Object.keys(before)) if (!holds[id]) { released(id); pulls.delete(id);
    // a hold that ends with no row moving the thing (a put back to the very pose it had: the fold didn't change, so no
    // change event ever re-asserts it): ask the realizer for the fold's pose and ease to it, as a put does
    if (!presOwns(id) && entities.has(id)) { startSettle(id); bus.emit('pose-revert', { id }); } }
  for (const id of Object.keys(holds)) if (!before[id] || before[id].by !== holds[id].by) { suspendCollider(id, true); startPull(id); }
  // a use still pressed on a thing that has left my hand (taken, dropped with the button down): its up goes now (the authority
  // takes it from whoever pressed down), and the press stops riding my presence (review 10-06)
  if (pressing && holds[pressing]?.by !== net.you) void useHeld('up', pressing);
});
// the hand reaches out and the thing comes to it (Unity Attach Ease In, Godot LERP, Meta pull): presence only, every
// client the same; a far grab (grabbable.range past arm's reach) flies a little longer
function startPull(id) {
  const obj = entities.get(id); if (!obj) return;
  obj.updateWorldMatrix(true, false); const from = obj.getWorldPosition(new THREE.Vector3());
  const hand = handOf(holds[id].by, holds[id].hand ?? 'right'); const d = hand ? from.distanceTo(hand) : 0;
  pulls.set(id, { from, t0: performance.now(), dur: Math.min(400, Math.max(120, d / 8 * 1000)) });
}
// A put (or anything that writes where a held thing is) arrives as a change entry BEFORE the authority's holds message says
// the hand is empty (server order: the log, then presence). From that entry on the fold has it: stop drawing it in the
// hand, or a frame between the two messages would leave it drawn there after the realizer placed it.
onWorldChange((ev) => {
  if (ev.type === 'change' && holds[ev.id] && ['pose', 'parent', 'gone', 'born'].includes(ev.what)) { const { [ev.id]: _, ...rest } = holds; holds = rest; released(ev.id);
    if (ev.what === 'pose' || ev.what === 'parent') startSettle(ev.id); }
  else if (ev.type === 'change' && settles.has(ev.id)) { if (ev.what === 'pose' || ev.what === 'parent') startSettle(ev.id); else if (ev.what === 'gone' || ev.what === 'born') endSettle(ev.id, false); }
  else if (ev.type === 'reset') { holds = {}; settles.clear(); }
});
// ---- settling: the way out of a hand (R 10-11 23:17, "lerp on put/attach"). A put, a place onto something, a mount:
// the row moves the thing from the hand to its rest in one frame. The truth takes it at once (the fold, the object's own
// transform, whereIs, the collider's place); what is DRAWN eases from where the hand had it over SETTLE_MS, the pull's
// own ease the other way round (startPull: the thing comes to the hand; this: the hand's place lets it go). Rotation too.
// The next row for the thing restarts the ease from what is drawn; a grab hands it to the pull; gone ends it. Presence
// only: nothing sent, nothing logged; the collider sits the ease out (as a flight's does) and comes back at the truth.
// A launch (throw, drop) is the engine's flight, not this.
let SETTLE_MS = 120;   // lab knob (physicsApi.settle(ms))
const settles = new Map();   // id -> { from: {p, q} world, drawn: {p, q} world, t0, dur, truth: {p, q} local | null (read on the first frame, after the realizer wrote it) }
const drawnHeld = new Map();   // id -> {p, q} world: where drawHeld last put a held thing (the hand's place, as drawn)
function startSettle(id) {
  const obj = entities.get(id); if (!obj || presOwns(id) || compsOf(id)?.motion) return;
  const s = settles.get(id); const at = s?.drawn ?? drawnHeld.get(id);
  if (s?.truth) { obj.position.copy(s.truth.p); obj.quaternion.copy(s.truth.q); }   // the realizer's write lands on the truth, never on a drawn pose
  const from = at ? { p: at.p.clone(), q: at.q.clone() } : (obj.updateWorldMatrix(true, false), { p: obj.getWorldPosition(new THREE.Vector3()), q: obj.getWorldQuaternion(new THREE.Quaternion()) });
  settles.set(id, { from, drawn: { p: from.p.clone(), q: from.q.clone() }, t0: performance.now(), dur: SETTLE_MS, truth: null });
  drawnHeld.delete(id);
}
function endSettle(id, restore = true) {
  const s = settles.get(id); if (!s) return; settles.delete(id);
  const obj = entities.get(id);
  if (restore && obj && s.truth) { obj.position.copy(s.truth.p); obj.quaternion.copy(s.truth.q); obj.updateWorldMatrix(true, false); }
  if (s.truth && !holds[id] && !presOwns(id)) suspendCollider(id, false);
}
const easeOut = (k) => 1 - (1 - k) ** 3;
const _sp = new THREE.Vector3(), _sq = new THREE.Quaternion(), _st = new THREE.Quaternion();
function drawSettles(now) {
  for (const [id, s] of settles) {
    const obj = entities.get(id);
    if (!obj || holds[id] || presOwns(id)) { endSettle(id, false); continue; }
    if (!s.truth) { s.truth = { p: obj.position.clone(), q: obj.quaternion.clone() }; suspendCollider(id, true); }
    const k = s.dur > 0 ? Math.min(1, (now - s.t0) / s.dur) : 1;
    if (k >= 1) { endSettle(id); continue; }
    obj.position.copy(s.truth.p); obj.quaternion.copy(s.truth.q); obj.updateWorldMatrix(true, false);
    obj.getWorldPosition(_sp); obj.getWorldQuaternion(_st);
    const e = easeOut(k);
    _sp.lerpVectors(s.from.p, _sp, e); _sq.copy(s.from.q).slerp(_st, e);
    setWorldPose(obj, _sp, _sq); s.drawn.p.copy(_sp); s.drawn.q.copy(_sq);
  }
}
/** The truth's world position of a settling thing (what a request may read: Covenant III), or null when it isn't one. */
function settledTruth(id) {
  const s = settles.get(id), obj = entities.get(id); if (!s?.truth || !obj) return null;
  const p = obj.position.clone(), q = obj.quaternion.clone();
  obj.position.copy(s.truth.p); obj.quaternion.copy(s.truth.q); obj.updateWorldMatrix(true, false); const w = obj.getWorldPosition(new THREE.Vector3());
  obj.position.copy(p); obj.quaternion.copy(q); obj.updateWorldMatrix(true, false);
  return w;
}
export const holdsNow = () => holds;
/** What I hold, per the authority. */
// newest first: what I picked up last is what I put down, throw or use first (R, 10-10: "you drop the last thing you
// picked up first"). The order is this client's own (when it first saw each hold); the wire carries none.
const heldSeen = new Map(); let heldN = 0;
export const myHolds = () => { const mine = Object.keys(holds).filter((id) => holds[id].by === net.you);
  for (const id of mine) if (!heldSeen.has(id)) heldSeen.set(id, ++heldN);
  for (const id of heldSeen.keys()) if (!mine.includes(id)) heldSeen.delete(id);
  return mine.sort((a, b) => heldSeen.get(b) - heldSeen.get(a)); };
function released(id) {
  // the realizer re-asserts where the log has it on its next change; until the fold or the sim owns it again, the
  // last drawn pose stays (a put's change entry and a throw's launch both arrive BEFORE this message: server order)
  if (!presOwns(id)) suspendCollider(id, false);
}
/** A presence id (the people map's key) for an identity the authority stamps. */
function presenceIdOf(actorId) {
  if (actorId === net.you) return null;               // me
  for (const [pid, vid] of identities) if (vid === actorId) return pid;
  return undefined;
}

// ---------------------------------------------------------------- the body the authority tracks
let arrived = false, moving = null, lastTrack = 0, trackedAt = null, lastMove = null, lastTeleport = 0, arriveFails = 0;
const feet = () => { const p = hooks?.myPos(); return p ? [p.x, p.y, p.z] : null; };
const r3 = (n) => Math.round(n * 1000) / 1000;
const worldHasPhysics = () => { const es = replica.st?.entities; if (!es) return false; if (es['@world']?.c['physics-engine']) return true;
  for (const id in es) if (es[id].c.physics?.kind === 'dynamic' || es[id].c.grabbable) return true; return false; };
bus.on('cut-adopted', () => { arrived = false; trackedAt = null; holds = {}; stuck = null; arriveFails = 0; });   // a fresh cut: try at once
// R 10-10 ("Couldn't grab: your body isn't in the world yet", after a rename): the authority had no body for me while
// this client thought it had arrived. Whatever the cause, the refusal says so: re-arrive once and send it again.
let lagMs = 0;   // lab knob (physicsApi.lag): delay a throw/drop request by this much, as a slow round trip would
async function sendRequest(verb, args) {
  if (lagMs && (verb === 'throw' || verb === 'drop')) await new Promise((res) => setTimeout(res, lagMs));
  const r = await rawSend(verb, args);
  if (verb === 'move' || r?.refused?.code !== 'not-here') return r;
  arrived = false; trackedAt = null; arriveFails = 0; stuck = null;
  return (await track(true)) ? rawSend(verb, args) : r;
}
export { sendRequest as requestWithBody };
/** Bring the authority's track of my body to where I stand. Resolves true when it's there (or close enough to act). */
async function track(force = false) {
  if (!replica.active || !net.joined) return false;
  const to = feet(); if (!to) return false;
  if (moving) { await moving; if (!force) return arrived; }
  const go = async () => {
    if (!arrived) {   // arriving: one act on the record, as an agent's first move is
      const r = await sendRequest('move', { to: to.map(r3), client: 'human' }); lastMove = { arrive: true, ok: !!r?.ok, refused: r?.refused?.code };
      if (r?.ok) { arrived = true; trackedAt = r.at ?? to; }
      if (arrived) { arriveFails = 0; stuck = null; return true; }   // arrived: no leftover back-off (review round 3)
      // refused (review of 5a978cc0: this retried every 200 ms, forever). Back off as a refused step does; and when the
      // server still has me somewhere else (a takeover reconnect keeps the body: too-fast) or calls my spot solid,
      // re-arrive as a teleport, which it allows when nothing is in my hands (at most once in 3 s, as the step's)
      // the back-off holds by TIME only, doubling (2, 4, 8, 16 s): walking on doesn't clear it as it clears a step's
      // (an arrival that can't succeed would otherwise go back to 5 a second the moment I move; review round 2)
      arriveFails++; stuck = { at: to, until: performance.now() + 2000 * 2 ** Math.min(arriveFails - 1, 3), arrival: true };
      if (['too-fast', 'solid'].includes(r?.refused?.code) && !myHolds().length && performance.now() - lastTeleport > 3000) {
        lastTeleport = performance.now();
        const t = await sendRequest('move', { to: to.map(r3), teleport: true, client: 'human' }); lastMove = { arrive: true, teleport: true, ok: !!t?.ok, refused: t?.refused?.code };
        if (t?.ok) { arrived = true; arriveFails = 0; stuck = null; trackedAt = t.at ?? to; return true; }
        if (t?.refused) refused('move', t);
      } else if (r?.refused) refused('move', r);
      return false;
    }
    const d = trackedAt ? Math.hypot(to[0] - trackedAt[0], to[1] - trackedAt[1], to[2] - trackedAt[2]) : Infinity;
    if (!force && d < TRACK_MIN) return true;
    // walk the authority's body toward mine in steps it accepts (6 m/s, 4 m at most at once: the authority's TRACK)
    const k = d > 3.5 ? 3.5 / d : 1; const step = trackedAt ? trackedAt.map((v, i) => r3(v + (to[i] - v) * k)) : to.map(r3);
    let r = await sendRequest('move', { to: step }); lastMove = { to: step, ok: !!r?.ok, refused: r?.refused?.code, reason: r?.refused?.reason };
    if (r?.ok) { trackedAt = r.at ?? step; return true; }
    if (r?.refused?.at) trackedAt = r.refused.at;
    stuck = { at: to, until: performance.now() + 2000 };
    // the authority lost me (flew faster than a body walks, or through something it calls solid): re-arrive, an act on the
    // record, which it refuses while I hold something (a teleport can't carry things)
    // (at most once in 3 s: each is an act on the record, and flying fast would otherwise write one per step)
    if (['too-fast', 'solid'].includes(r?.refused?.code) && !myHolds().length && (force || performance.now() - lastTeleport > 3000)) {
      lastTeleport = performance.now();
      r = await sendRequest('move', { to: to.map(r3), teleport: true }); lastMove = { teleport: true, ok: !!r?.ok, refused: r?.refused?.code, reason: r?.refused?.reason };
      if (r?.ok) { trackedAt = r.at ?? to; stuck = null; return true; }
    }
    return false;
  };
  moving = go().catch(() => false).finally(() => { moving = null; lastTrack = performance.now(); });
  return moving;
}
let stuck = null;   // {at, until}: a refused step isn't re-sent until I've moved on from it, or a while has passed
function tickTrack(now) {
  if (!replica.active || moving || now - lastTrack < TRACK_MS) return;
  if (hooks?.seated?.()) return;   // a seated body is where its seat is; it walks again when it stands
  if (stuck) { const f = feet(); if (now < stuck.until && (stuck.arrival || (f && Math.hypot(f[0] - stuck.at[0], f[2] - stuck.at[2]) < 0.3))) return; stuck = null; }
  if (!arrived) { if (worldHasPhysics()) track(); else lastTrack = now; return; }
  const to = feet(); if (!to || !trackedAt) return;
  if (Math.hypot(to[0] - trackedAt[0], to[1] - trackedAt[1], to[2] - trackedAt[2]) >= TRACK_MIN) track();
}

// ---------------------------------------------------------------- the hand
const _hp = new THREE.Vector3(), _fw = new THREE.Vector3();
const avatarOf = (actorId) => { const pid = presenceIdOf(actorId); return pid === null ? hooks?.me() : pid ? remotes.get(pid)?.avatar : null; };
/** Is this holder's body tracked (a headset: their own hands hold it)? */
function tracked(actorId) { const pid = presenceIdOf(actorId); if (pid === null) return presenting(); const r = pid ? remotes.get(pid) : null; return !!(r?.xrSample || r?.lastPose?.xr); }
/** Where a holder's hand is in the world: their avatar's hand bone (left or right), else in front of their chest. */
function handOf(actorId, side = 'right', out = _hp) {
  const av = avatarOf(actorId);
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
export function palmOf(actorId, side, out) {
  const av = avatarOf(actorId); const H = av?.vrm?.humanoid; if (!H) return null;
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
const _c = new THREE.Vector3(), _cq = new THREE.Quaternion();
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
const compsOf = (id) => replica.st?.entities?.[id]?.c ?? null;
const _held = new THREE.Vector3(), _hq = new THREE.Quaternion(), _ws = new THREE.Vector3(), _tq = new THREE.Quaternion(), _tp = new THREE.Vector3();
const _gq = new THREE.Quaternion(), _gv = new THREE.Vector3(), _v2 = new THREE.Vector3(), _aq = new THREE.Quaternion();
const P1 = { p: new THREE.Vector3(), q: new THREE.Quaternion() }, P2 = { p: new THREE.Vector3(), q: new THREE.Quaternion() };
/** Where a held thing goes, from the holder's hand bone and the authority's hold record (every client computes the same):
 *  a grip puts the palm on the grip (VRChat ExactGrip, Unity Attach Transform); an offset keeps it where the hand took
 *  it (Unreal Free); neither, it's held by its centre (what the authority did before grips). A second hand on a twoHanded
 *  thing steers it: the line from the primary grip to the secondary one points from hand to hand. A body without
 *  tracked hands carrying in both arms holds it between them. Returns the world {p, q} (q null: keep its rotation). */
function heldPose(id, h, obj) {
  const g = grabOf(compsOf(id)); const side = h.hand ?? 'right';
  const grip = h.grip ? g?.grips?.[h.grip] : null;
  obj.getWorldScale(_ws);
  if (!tracked(h.by) && g && bothArms(holdPoseOf(g, sizeOf(id, obj))) && !grip) {
    const a = palmOf(h.by, 'right', P1), b = palmOf(h.by, 'left', P2);
    if (a && b) { obj.getWorldQuaternion(_hq); _held.copy(localCentre(id, obj)).applyQuaternion(_hq); _tp.copy(a.p).lerp(b.p, 0.5);
      // carried in both arms it sits AGAINST the body, not around it: its centre goes out in front by what it is deep,
      // less the arm's reach to the palms (R, 10-10: a wrecking ball held by its centre swallowed the avatar)
      const av = avatarOf(h.by), sz = sizeOf(id, obj);
      if (av?.root && Array.isArray(sz)) { const fx = _tp.x - av.root.position.x, fz = _tp.z - av.root.position.z, fl = Math.hypot(fx, fz);
        const push = Math.max(0, Math.max(sz[0], sz[2]) / 2 - Math.max(0, fl - 0.12));
        if (fl > 1e-3 && push > 0) { _tp.x += fx / fl * push; _tp.z += fz / fl * push; } }
      return { p: _tp.sub(_held), q: null }; }
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
// R 10-10 evening: a thing held with no grip (or carried in both arms) kept its world orientation as she turned. It now
// keeps the turn it had relative to the holder's body when it was taken (yaw only: the body turns about up).
const heldTurn = new Map();   // `${id}|${by}` → the thing's rotation in the holder's yaw frame
const _bq = new THREE.Quaternion(), _bodyQ = new THREE.Quaternion(), _up = new THREE.Vector3(0, 1, 0);
function bodyYawQ(by) { const av = avatarOf(by); if (!av?.root) return null; av.root.getWorldQuaternion(_bq);
  const f = new THREE.Vector3(0, 0, 1).applyQuaternion(_bq); return _bodyQ.setFromAxisAngle(_up, Math.atan2(f.x, f.z)); }
function drawHeld() {
  const now = performance.now();
  for (const k of heldTurn.keys()) { const [id, by] = k.split('|'); if (holds[id]?.by !== by) heldTurn.delete(k); }
  for (const [id, h] of Object.entries(holds)) {
    if (pres?.bodies?.[id]) continue;              // thrown or dropped: the launch is folded, the flight draws it
    const obj = entities.get(id); if (!obj) continue;
    const at = heldPose(id, h, obj); if (!at) continue;
    if (!at.q) { const bq = bodyYawQ(h.by);
      if (bq) { const key = `${id}|${h.by}`; let r = heldTurn.get(key);
        if (!r) { r = bq.clone().invert().multiply(obj.getWorldQuaternion(new THREE.Quaternion())); heldTurn.set(key, r); }
        at.q = bq.clone().multiply(r); } }
    const pull = pulls.get(id);
    if (pull) { const k = Math.min(1, (now - pull.t0) / pull.dur); if (k >= 1) pulls.delete(id); else at.p.lerpVectors(pull.from, at.p, easeOut(k)); }
    setWorldPose(obj, at.p, at.q);
    let d = drawnHeld.get(id); if (!d) drawnHeld.set(id, (d = { p: new THREE.Vector3(), q: new THREE.Quaternion() }));
    obj.updateWorldMatrix(true, false); obj.getWorldPosition(d.p); obj.getWorldQuaternion(d.q);
  }
  for (const id of drawnHeld.keys()) if (!holds[id]) drawnHeld.delete(id);
  poseHolders();
}
// What holding does to each holder's body (avatar.js setHoldPose): the grip's finger preset on each holding hand, and,
// for a body without tracked hands, the arms' hold pose (grabbable.pose, else by size). Recomputed every frame from the
// authority's record; an avatar that stops holding lets go.
const posed = new Set();
function poseHolders() {
  const want = new Map();
  for (const [id, h] of Object.entries(holds)) {
    const av = avatarOf(h.by); if (!av?.vrm) continue;
    const g = grabOf(compsOf(id)); const side = h.hand ?? 'right';
    let m = want.get(av); if (!m) want.set(av, (m = { bones: {}, fingers: {} }));
    const grip = h.grip ? g?.grips?.[h.grip] : null;
    if (g?.source === 'physics') continue;   // a dynamic thing with no grabbable: held as before (and VR fingers keep the controller's curl)
    Object.assign(m.bones, fingerPose(grip?.fingers ?? 'fist', side, grip?.hold ?? {})); m.fingers[side] = true;
    if (h.second) { const sg = h.second.grip ? g?.grips?.[h.second.grip] : null; Object.assign(m.bones, fingerPose(sg?.fingers ?? 'fist', h.second.hand, sg?.hold ?? {})); m.fingers[h.second.hand] = true; }
    // (a dynamic thing with no grabbable is held as before: in the hand where the arm already is, no hold pose)
    if (!tracked(h.by) && g && g.source !== 'physics') { const preset = holdPoseOf(g, sizeOf(id, entities.get(id)));
      Object.assign(m.bones, armPose(preset, side));
      if (bothArms(preset)) { const o = side === 'right' ? 'left' : 'right'; Object.assign(m.bones, fingerPose('fist', o)); m.fingers[o] = true; } }
  }
  for (const av of posed) if (!want.has(av)) { av.setHoldPose?.(null); if (av.vrm?.userData) av.vrm.userData._holdFingers = null; posed.delete(av); }
  for (const [av, m] of want) { av.setHoldPose?.(m.bones); (av.vrm.userData ||= {})._holdFingers = m.fingers; posed.add(av); }
}
/** Where a thing I hold is drawn (its origin, world): the release pose sent with throw/drop. */
function heldPos(id) { const obj = entities.get(id); if (!obj) return null; obj.updateWorldMatrix(true, false); return obj.getWorldPosition(new THREE.Vector3()); }

// ---------------------------------------------------------------- flights (the engine's, at display time)
let pres = null, presV = -1, tickSeen = -1;
const prev = new Map();      // id -> [x, y, z] at the tick before pres.tick (the interval's start)
const spins = new Map();     // id -> presentation state {q, kind, r, arm, box}
const presOwns = (id) => !!pres?.bodies?.[id];
const _dq = new THREE.Quaternion(), _p = new THREE.Vector3();
/** Console/probe surface: the displayed sim (a copy), and the canonical fold's view. */
export const simShown = () => pres;
// ---- my own release, predicted (DESIGN-physics-responsiveness §3; STRIKES PH-S1-3: a throw stayed in the hand one round
// trip, then jumped RTT/2 along the arc). On send, the launch is folded into the PRESENTATION copy only, at the tick the
// entry will most likely take (now + rtt/2 + one tick), with the inputs the authority will stamp (p as sent, q as sent, v
// scaled by grabbable.throw and capped as launch() does). When the real entry arrives the fresh copy of the canonical fold
// is the truth: same tick and inputs give the same bits (Covenant IV), so nothing shows; otherwise the truth replaces it
// and a per-body draw offset decays the difference (Fiedler's error offset, never a blend of states). A refusal, or no
// entry within PENDING_MS, removes it and the thing eases back into the hand. Nothing here is ever read back into a
// request (Covenant III): whereIs, reach and the canonical fold never see a provisional body.
const pending = new Map();   // id -> { ts, args, sentAt }
const PENDING_MS = 1500, OFFSET_SNAP = 3, OFFSET_DEAD = 0.02;   // a reply normally lands within 300 ms; while a guess is pending, others' news waits (second review S3)
let predictOn = true;        // lab knob (physicsApi.predict(false)): the old shape, for the probe's control arm
const swapFrom = new Map();  // id -> drawn world position before a copy swap (the offset starts from it)
function planRelease(id, pos, v, w) {
  const canon = replica.sim; if (!predictOn || !canon?.sim || canon.foreign || !pos || clockRtt() === null) return null;
  const obj = entities.get(id); if (!obj) return null;
  const vv = planVelocity(v, grabOf(compsOf(id)), ENGINES[canon.spec?.engine]?.maxSpeed, 'throw').v;   // the authority's own arithmetic (launchplan.js)
  const q = obj.getWorldQuaternion(new THREE.Quaternion()).normalize().toArray();
  return { id, p: pos, q, v: vv, ...(w ? { w } : {}) };
}
function predict(args) {
  if (presV !== replica.simVersion || !pres) { pres = replica.simClone(); presV = replica.simVersion; tickSeen = -1; stats.clones++; if (!pres) return false; }
  const now = serverNow(); const ts = now + clockRtt() / 2 + pres.epoch.tickMs;
  pending.set(args.id, { ts, args, sentAt: now }); applyPending(args.id); return true;
}
function applyPending(id) {
  const pd = pending.get(id); if (!pd || !pres?.epoch || !replica.st) return;
  const floor = pres.epoch.ts + pres.tick * pres.epoch.tickMs; const ts = Math.max(pd.ts, floor);   // never earlier than what's drawn
  const view = engineViewM(replica.st, {}); const base = view.entities[id]; if (!base) return;
  view.entities[id] = { ...base, pos: pd.args.p };
  simEntry(pres, { seq: -1, ts, actor: net.you, verb: 'launch', args: pd.args }, view);
  if (pres.bodies[id]) pres.bodies[id].provisional = true;
}
function unpredict(id) {
  if (!pending.delete(id)) return;
  const obj = entities.get(id); if (obj) { obj.updateWorldMatrix(true, false); pulls.set(id, { from: obj.getWorldPosition(new THREE.Vector3()), t0: performance.now(), dur: 150 }); }
  presV = -1;   // the next frame takes a fresh copy of the truth, where it is still in the hand
}
const pendingNow = () => Object.fromEntries([...pending].map(([id, p]) => [id, { ts: p.ts, sentAt: p.sentAt }]));
function drawFlights(wall, now) {
  const canon = replica.sim;
  if (!canon?.sim || canon.foreign) { if (pres) { for (const id of Object.keys(pres.bodies)) suspendCollider(id, false); } pres = null; prev.clear(); return; }
  // while one of my releases is still a guess (no entry yet), keep this copy: a fresh copy of the canonical fold stands at
  // the latest entry's tick, which may be past the guess's, and re-folding the guess there would restart it from the hand
  // (full probe 10-11: a 0.6 m forward jump when the truth then landed). Other bodies' news waits one round trip, no more.
  const guessing = pres && presV !== -1 && pending.size > 0 && ![...pending].some(([id, pd]) => canon.launched[id] || wall - pd.sentAt > PENDING_MS);
  if (presV !== replica.simVersion && !guessing) {
    const was = pres ? Object.keys(pres.bodies) : [];
    swapFrom.clear(); if (pres) for (const id of was) { const o = entities.get(id); if (o) { o.updateWorldMatrix(true, false); swapFrom.set(id, o.getWorldPosition(new THREE.Vector3())); } }
    pres = replica.simClone(); presV = replica.simVersion; tickSeen = -1; stats.clones++;
    // my predicted releases: the real launch folded is the truth (drop the guess); not yet, re-fold the guess into this copy
    for (const [id, pd] of pending) { if (canon.launched[id] || wall - pd.sentAt > PENDING_MS) pending.delete(id); else applyPending(id); }
    for (const id of was) if (!pres.bodies[id] && !holds[id]) suspendCollider(id, false);   // its rest is the fold's now
  }
  const target = tickOf(pres, wall);
  if (pres.tick !== tickSeen) prev.clear();
  if (pres.tick < target) {
    if (pres.tick < target - 1) advanceSim(pres, target - 1);
    for (const id in pres.bodies) { const b = pres.bodies[id]; let pv = prev.get(id); if (!pv) prev.set(id, (pv = [0, 0, 0])); pv[0] = b.p[0]; pv[1] = b.p[1]; pv[2] = b.p[2];
      if (b.q) { if (!pv.q) pv.q = new THREE.Quaternion(); pv.q.set(b.q[0], b.q[1], b.q[2], b.q[3]); } }
    advanceSim(pres, target);
  }
  tickSeen = pres.tick;
  const k = Math.min(1, Math.max(0, (wall - pres.epoch.ts) / pres.epoch.tickMs - (pres.tick - 1)));
  for (const id in pres.bodies) {
    // (a body here is a launch folded AFTER any grab: a grab is a lift, which takes the body out, so the engine wins
    //  over a hold the authority hasn't yet said is over)
    const b = pres.bodies[id]; const obj = entities.get(id); if (!obj) continue;
    let sp = spins.get(id);
    if (!sp) { obj.getWorldQuaternion(_hq); sp = { q: _hq.clone() }; spins.set(id, sp); suspendCollider(id, true);
      // the engine owns a launched body until its rest: it hangs from the scene, not from what it rode on (R 10-11: a stack's
      // riders stayed under the box she took, dragged along by its hold, until the rest re-parented them seconds later)
      if (obj.parent && !obj.parent.isScene) bus.emit('flight-detach', { id }); }
    const pv = b.resting ? undefined : prev.get(id);
    if (pv) _p.set(pv[0] + (b.p[0] - pv[0]) * k, pv[1] + (b.p[1] - pv[1]) * k, pv[2] + (b.p[2] - pv[2]) * k);
    else _p.set(b.p[0], b.p[1], b.p[2]);
    // a copy swap that moved this body's drawn place: carry the difference as a draw offset and let it decay (2 cm: gone;
    // a metre or more: fast; 3 m: snap; a logged rest eases too, a slide beats a pop). The truth (base.pos, colliders) never carries it.
    const from = swapFrom.get(id); if (from) { swapFrom.delete(id); const d = from.sub(_p); if (d.length() >= OFFSET_DEAD) { stats.swaps.push({ id, tick: pres.tick, target, k: +k.toFixed(2), prov: !!b.provisional, resting: !!b.resting, d: +d.length().toFixed(3), from: from.toArray().map((n) => +n.toFixed(3)), to: _p.toArray().map((n) => +n.toFixed(3)) }); if (stats.swaps.length > 12) stats.swaps.shift(); }
      if (d.length() >= OFFSET_DEAD && d.length() < OFFSET_SNAP) sp.dp = d; else delete sp.dp; }
    if (sp.dp) { if (sp.dp.length() < OFFSET_DEAD) delete sp.dp; else { _p.add(sp.dp); sp.dp.multiplyScalar(sp.dp.length() >= 1 ? 0.8 : 0.9); } }
    const q = sp.q;
    // the engine carries the body's own rotation: draw that, nothing invented (a body without one keeps the rotation it has)
    if (b.q) { q.set(b.q[0], b.q[1], b.q[2], b.q[3]); if (pv?.q) q.copy(_dq.copy(pv.q).slerp(q, k)); }
    setWorldPose(obj, _p, q);
    if (obj.userData.base?.pos) { obj.userData.base.pos[0] = b.p[0]; obj.userData.base.pos[1] = b.p[1]; obj.userData.base.pos[2] = b.p[2]; }
  }
  for (const id of spins.keys()) if (!pres.bodies[id]) spins.delete(id);
  swapFrom.clear();
}

const stats = { frames: 0, ms: 0, clones: 0, maxMs: 0, swaps: [] };   // swaps: the last copy swaps that moved a drawn body (probe)
/** One presentation frame. `wall` (the server clock, ms) may be given: a probe can sample the real applier at exact
 *  display times without depending on the page's frame rate (simworld's bench rule). */
function frame(wall) {
  if (!replica.active) return;
  const now = performance.now();
  drawFlights(wall ?? serverNow(), now);
  drawHeld();
  drawSettles(now);
  drawPressFx();
  tickTrack(now);
  const ms = performance.now() - now; stats.frames++; stats.ms += ms; if (ms > stats.maxMs) stats.maxMs = ms;
}

// ---------------------------------------------------------------- acts (requests)
const say = (t) => logChat('*', t);
// the same refusal again within REPEAT_MS is said once (a squeeze repeated, a retry): words are for news, not a metronome
const REPEAT_MS = 5000, saidAt = new Map();
// (keyed by the words with their numbers taken out: a too-fast or solid reason names a distance or a spot that changes
// every step, so the same refusal never matched itself; review round 2)
const refused = (what, r, id = '') => { const x = r?.refused, now = performance.now();
  // a let-go out of reach is the server's body track a step behind mine, not something she did (R 10-11: 'Not obvious what's wrong')
  const text = x?.code === 'out-of-reach' && (what === 'throw' || what === 'drop') ? `Couldn't ${what} it from there: the server still has you a step back from where you see yourself. Try again — standing still a moment helps` : plain(what, r);
  // at a desk: the status bar, in the attention colour, EVERY time you ask (R, 10-10: the chat line came "not every time
  // I try - only every 5s or so"; it is no longer a chat line). The event below (a headset's card, the probes) keeps
  // its once-per-5-s rule: a squeeze repeated is not news.
  if (!xrActive()) flashHint(text, 3800, 'attn');
  const key = `${what}|${id}|${x?.code ?? ''}|${text.replace(/-?\d+(?:\.\d+)?/g, '#')}`;   // + the thing: 'crate 2' and 'crate 3' stay two (review round 3)
  if (now - (saidAt.get(key) ?? -Infinity) < REPEAT_MS) return r;
  saidAt.delete(key); saidAt.set(key, now); if (saidAt.size > 64) saidAt.delete(saidAt.keys().next().value);
  bus.emit('thingphysics-refused', { verb: what, refused: x, text }); return r; };   // a person's words (plainwords.js)
// what a hand may pick up: grabbable (shared/grab.js grabOf: the authority's own reader, so a dynamic thing with no grabbable
// counts, as at the authority); what a foot may punt: physics {kind: 'dynamic'}
let gIds = { st: null, head: -2, ids: [] };   // per fold (the fold is applied in place: keyed by its object and its head)
const grabbableIds = () => { const st = replica.st; if (gIds.st !== st || gIds.head !== replica.head) { const es = st?.entities ?? {}; gIds = { st, head: replica.head, ids: Object.keys(es).filter((id) => grabOf(es[id].c)?.enabled) }; } return gIds.ids; };
const dynamicIds = () => { const es = replica.st?.entities ?? {}; return Object.keys(es).filter((id) => es[id].c.physics?.kind === 'dynamic'); };
/** Where the thing is now, as the authority sees it: someone's hand, the air (the engine), or the log. */
function whereIs(id) {
  const b = pres?.bodies?.[id]; if (b && !b.resting) return b.p;
  const st = settledTruth(id); if (st) return st.toArray();
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
const _rh = new THREE.Vector3(), _rn = new THREE.Vector3();
/** reach is measured to the NEAREST POINT of the thing's box when it stands in the world (R 10-11 23:27: a barrel's origin
 *  is at its base, so standing against it read as out of reach and the walk-to found the barrels "in the way") */
const nearestOf = (p, id, hand) => { const o = id && !myHolds().includes(id) ? entities.get(id) : null; if (!o) return p;
  try { _bx.setFromObject(o); if (_bx.isEmpty()) return p; _bx.clampPoint(_rh.set(hand[0], hand[1], hand[2]), _rn); return [_rn.x, _rn.y, _rn.z]; } catch { return p; } };
const inHand = (p, f, id) => { const hand = [f[0], f[1] + HAND_Y, f[2]], q = nearestOf(p, id, hand); const d = Math.hypot(q[0] - hand[0], q[1] - hand[1], q[2] - hand[2]); return d <= (id ? rangeOf(id) : REACH) ? d : null; };
const atFeet = (p, f) => { const dh = Math.hypot(p[0] - f[0], p[2] - f[2]), dy = p[1] - f[1]; return dh <= KICK.reach && dy >= KICK.below && dy <= KICK.above ? dh : null; };

/** Pick something up: the named thing, or the nearest you can reach. */
export async function grab(name) {
  if (!replica.active) return say('carrying works in worlds');
  const id = name || nearest(inHand, grabbableIds(), prioOf);
  if (!id) return say('nothing here you can pick up within reach (things with a grabbable component)');
  await track(true);
  const r = await sendRequest('grab', { id });
  if (!r?.ok) return refused('grab', r, id);
  flashHint(`holding ${id}${r.notes?.some((n) => n.takenFrom) ? ' (taken from someone)' : ''} — T puts it down, C throws`);
  return r;
}
/** Set down what you hold (straight down onto what's below your hand). */
export async function put(name, spot = null) {
  const id = name || myHolds()[0]; if (!id) return say('you aren\'t holding anything');
  await track(true);
  // a spot [x, z] (where the cursor is): set it down there, on whatever is below; the authority checks my reach
  if (Array.isArray(spot)) { const r = await sendRequest('put', { id, at: [r3(spot[0]), r3(spot[1])] }); return r?.ok ? r : refused('put', r, id); }
  // in front of my feet, clear of my body (the authority's default is under the hand, which is inside my own footprint:
  // a wrecking ball set down there shoved me 0.67 m aside, and the camera with me; R, 10-10). The authority works out
  // the height and what it lands on.
  const f = feet(), yaw = hooks?.myState?.()?.yaw, obj = entities.get(id), sz = obj ? sizeOf(id, obj) : null;
  const out = Math.min(1.2, colliderFor(hooks?.me?.()?.userScale).r + (Array.isArray(sz) ? Math.max(sz[0], sz[2]) / 2 : 0.15) + 0.12);   // my walking capsule + its half-width + a gap
  // in front of me; facing the world's edge, beside me, else behind (the authority refuses a spot past its bounds)
  const B = compsOf('@world')?.bounds, half = Array.isArray(sz) ? Math.max(sz[0], sz[2]) / 2 : 0.15;
  const inside = (x, z) => !B?.min || (x - half >= B.min[0] && x + half <= B.max[0] && z - half >= B.min[2] && z + half <= B.max[2]);
  let at = null;
  if (f && Number.isFinite(yaw)) for (const turn of [0, Math.PI / 2, -Math.PI / 2, Math.PI]) { const x = f[0] + Math.sin(yaw + turn) * out, z = f[2] + Math.cos(yaw + turn) * out;
    if (inside(x, z)) { at = [r3(x), r3(z)]; break; } }
  const r = await sendRequest('put', { id, ...(at ? { at } : {}) });
  return r?.ok ? r : refused('put', r, id);
}
/** Let go: it falls (with physics) from where your hand is. */
export async function drop(name) {
  const id = name || myHolds()[0]; if (!id) return say('you aren\'t holding anything');
  await track(true);
  const pos = heldPos(id); const r = await sendRequest('drop', { id, ...(pos ? { pos: pos.toArray().map(r3) } : {}) });
  return r?.ok ? r : refused('drop', r, id);
}
/** Throw what you hold along your view, from your hand. */
/** Throw what I hold (the newest). `aim`: a world point [x, y, z] to land on (where the cursor is: R, 10-10, "it just aims
 *  away from your camera view, not at the spot you're aiming with your cursor"): a lob that comes down there, as hard as
 *  the distance needs, up to the engine's limit. No aim: ahead of my body, the way it faces. A number is a speed. */
export async function throwHeld(arg) {
  const id = myHolds()[0]; if (!id) return say('you aren\'t holding anything');
  // the guess goes up BEFORE the body's position is confirmed with the door (track awaits a move's round trip, which
  // queues behind the engine's beat while dominoes fly: R 10-11 23:17 "throwing with C still takes a good 1-2 s")
  const pos = letGoAt(heldPos(id)), aim = Array.isArray(arg) && arg.length === 3 && arg.every(Number.isFinite) ? arg : null;
  let v;
  if (aim && pos) {
    const dx = aim[0] - pos.x, dz = aim[2] - pos.z, d = Math.hypot(dx, dz), dy = aim[1] - pos.y;
    if (d < 0.3) v = [0, 1, 0];   // at my own feet: let it go
    else { // a lob at THROW.lob that passes through the point: v² = g d² / (2 cos²θ (d tanθ − Δy)); steeper when the point is high
      let th = Math.max(THROW.lob, Math.atan2(dy, d) + 0.35); th = Math.min(1.25, th);
      const den = 2 * Math.cos(th) ** 2 * (d * Math.tan(th) - dy);
      const sp = Math.min(20, Math.max(1.5, den > 1e-6 ? Math.sqrt(9.81 * d * d / den) : 20));
      v = [dx / d * Math.cos(th) * sp, Math.sin(th) * sp, dz / d * Math.cos(th) * sp].map(r3); }
  } else {
    const speed = Math.min(20, Math.max(1, parseFloat(arg) || THROW.speed)), yaw = hooks?.myState?.()?.yaw ?? 0;
    v = [Math.sin(yaw) * Math.cos(THROW.arc) * speed, Math.sin(THROW.arc) * speed, Math.cos(yaw) * Math.cos(THROW.arc) * speed].map(r3);
  }
  // a thrown thing tumbles forward, as an overhand throw does (R 10-10: "naturally there would be some" spin): about the
  // level axis across the throw, faster for a harder throw. A VR hand sends its own measured spin instead.
  const fl = Math.hypot(v[0], v[2]), sp = Math.hypot(...v), mag = Math.min(8, 0.8 * sp);
  const w = fl > 0.2 ? [v[2] / fl * mag, 0, -v[0] / fl * mag].map(r3) : null;
  const sent = pos ? pos.toArray().map(r3) : null; const plan = planRelease(id, sent, v, w); if (plan) predict(plan);
  await track(true);
  const r = await sendRequest('throw', { id, v, ...(w ? { w } : {}), ...(sent ? { pos: sent } : {}), ...(plan ? { q: plan.q } : {}) });
  if (!r?.ok) unpredict(id);
  return r?.ok ? r : refused('throw', r, id);
}
/** A hand's grab (VR grip, or any caller with a hand position [x, y, z]): the nearest thing it can carry within reach of
 *  that point and of the authority's hand. The same request the desktop key sends. */
export async function grabNear(at, within = 0.6) {
  const f = feet(); if (!f) return null; let best = null, bd = within;
  for (const id of grabbableIds()) { if (holds[id]) continue; const obj = entities.get(id); if (!obj) continue;
    const c = obj.getWorldPosition(new THREE.Vector3()).add(localCentre(id, obj).applyQuaternion(obj.getWorldQuaternion(_cq))); const d = Math.hypot(c.x - at[0], c.y - at[1], c.z - at[2]);
    if (d < bd && inHand(c.toArray(), f, id) !== null) { bd = d; best = id; } }
  return best ? grab(best) : null;
}
/** A hand letting go with a velocity (VR: the controller's; [0,0,0] is a drop), from where the thing is drawn in it. */
export async function release(v = [0, 0, 0], name) {
  const id = name || myHolds()[0]; if (!id) return null;
  await track(true);
  const pos = letGoAt(heldPos(id)); const still = v.every((n) => Math.abs(n) < 0.05);
  const sent = pos ? pos.toArray().map(r3) : null; const plan = still ? null : planRelease(id, sent, v.map(r3), null); if (plan) predict(plan);
  const r = await sendRequest(still ? 'drop' : 'throw', { id, ...(still ? {} : { v: v.map(r3) }), ...(sent ? { pos: sent } : {}), ...(plan ? { q: plan.q } : {}) });
  if (!r?.ok) unpredict(id);
  return r?.ok ? r : refused(still ? 'drop' : 'throw', r, id);
}
/** /punt [thing] [power]: kick the named thing, or the nearest at your feet, through it from where you stand. */
export async function punt(arg) {
  if (!replica.active) return say('punting works in worlds');
  const parts = (arg || '').trim().split(/\s+/).filter(Boolean);
  const named = parts.find((x) => !/^[\d.]+$/.test(x));
  const power = Math.min(20, Math.max(0.5, parseFloat(parts.find((x) => /^[\d.]+$/.test(x))) || PUNT_POWER));
  const id = named || nearest(atFeet);
  if (!id) return say('nothing at your feet to punt (things with physics {kind: dynamic})');
  await track(true);
  const r = await sendRequest('punt', { id, power });
  if (!r?.ok) return refused('punt', r, id);
  flashHint(`you punt ${id}${r.volley ? ' (a volley)' : ''}`);
  return r;
}

// ---------------------------------------------------------------- use while held (grabbable.use; research grab §3-4)
// The use button while you hold a thing: a request per press and per release (use.down, use.up: each one act; a
// hose turns on, then off), and, while it's pressed, presence (pose.use) every client draws the thing's fx from. Desktop:
// the left mouse button while holding something usable (outside edit mode); phone: a button that appears while you do;
// VR: the trigger (xr.js calls useHeld). Rapid effects are never a stream of acts: the authority rate-limits acts on purpose.
const usable = () => myHolds().find((id) => grabOf(compsOf(id))?.use) ?? null;
let pressing = null;   // the id my use is held down on
/** Press (phase 'down') or release ('up') the use of what I hold. Returns the authority's reply, or null if nothing to use. */
export async function useHeld(phase = 'down', name) {
  const id = name || (phase === 'up' ? pressing : usable()); if (!id) return null;
  const h = holds[id]; const g = grabOf(compsOf(id));
  const st = hooks?.myState?.();
  if (phase === 'down') { pressing = id; if (st && g?.fx) st.useHeld = { id, hand: h?.hand ?? 'right' }; }
  else { if (pressing === id) pressing = null; if (st?.useHeld?.id === id) st.useHeld = null; }
  if (!g?.use || !(phase === 'down' ? g.use.down : g.use.up)) return { ok: true, recorded: false, note: `nothing happens on use ${phase}` };
  const r = await sendRequest('use', { id, args: { held: true, hand: h?.hand ?? 'right', phase } });
  return r?.ok ? r : refused('use', r, id);
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
    if (e.button !== 0 || e.target?.tagName !== 'CANVAS' || hooks?.editing?.() || !replica.active || !usable()) return;
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
  bus.on('holds', () => setTimeout(sync, 0));
}

// ---------------------------------------------------------------- VR hands (research grab §4; xr.js calls xrHand per hand)
// The owner took world grabbing out of xr.js until it was "a proper object component" (09-07): this is that. Per hand,
// each frame: the grip pressed takes the nearest thing within a 0.4 m sphere × the avatar's scale (VRChat's number),
// choosing by grabbable.priority, then a grip for this hand, then distance; nothing near, the laser reaches out to the
// thing's grabbable.range and it flies to the hand. hold auto/press is press-to-hold: letting the grip go lets go, with
// the hand's velocity averaged over the last 0.1 s (the authority scales it by grabbable.throw); hold toggle takes a second
// press. The trigger while holding is use. The other hand on what you hold takes it in both (twoHanded) or swaps. A
// hand's take is felt (a firm pulse), and so is the first frame it can reach something (a light tick).
const AVG_MS = 100;
const vrHands = { left: { grip: false, trig: false, hist: [], hover: null, busy: false }, right: { grip: false, trig: false, hist: [], hover: null, busy: false } };
const _bx = new THREE.Box3(), _hv = new THREE.Vector3();
/** What my `side` hand holds now (as the authority has it), or null. */
const heldIn = (side) => { for (const [id, h] of Object.entries(holds)) if (h.by === net.you && (h.hand === side || h.second?.hand === side)) return id; return null; };
function nearest4(side, at, scale) {
  const R = NEAR_GRAB * (scale || 1); let best = null;
  for (const id of grabbableIds()) {
    if (holds[id]?.by === net.you && (holds[id].hand === side || holds[id].second?.hand === side)) continue;   // already in this hand
    const obj = entities.get(id); if (!obj) continue;
    const d = _bx.setFromObject(obj).distanceToPoint(at); if (d > R) continue;
    const g = grabOf(compsOf(id)); const k = [g.priority, pickGrip(g, side) ? 1 : 0, -d];
    if (!best || k[0] > best.k[0] || (k[0] === best.k[0] && (k[1] > best.k[1] || (k[1] === best.k[1] && k[2] > best.k[2])))) best = { id, k };
  }
  return best?.id ?? null;
}
/** One hand, one frame. pos: the hand's world position (the controller grip); grip/trig: buttons; pick(): the laser's
 *  first entity {id, dist} or null; scale: the avatar's; haptic(v, ms). Returns {holding, took} so xr.js knows the hand
 *  is busy (no panel chord or select with it). */
export function xrHand(side, { pos, grip, mayTake = true, trig, pick, scale = 1, haptic = () => {}, now = performance.now() }) {
  const H = vrHands[side]; if (!H || !pos || !replica.active) return { holding: null };
  H.hist.push({ t: now, p: [pos.x, pos.y, pos.z] }); while (H.hist.length > 2 && now - H.hist[0].t > AVG_MS) H.hist.shift();
  const mine = heldIn(side); const g = mine ? grabOf(compsOf(mine)) : null;
  const near = !mine && !H.busy ? nearest4(side, pos, scale) : null;
  if (near && near !== H.hover) haptic(0.15, 10); H.hover = near;
  let took = false;
  if (grip && !H.grip && !H.busy) {
    if (mine && g?.hold === 'toggle') void vrLetGo(side, mine);
    else if (!mine && mayTake) { let id = near;
      if (!id) { const hit = pick?.(); const hg = hit ? grabOf(compsOf(hit.id)) : null; const obj = hit ? entities.get(hit.id) : null;
        if (hg?.enabled && obj && obj.getWorldPosition(_hv).distanceTo(pos) <= hg.range) id = hit.id; }
      if (id) { took = true; void vrTake(side, id, !near, haptic); } }
  }
  if (!grip && H.grip && mine && g?.hold !== 'toggle') void vrLetGo(side, mine);
  if (mine && g?.use) { if (trig && !H.trig) void useHeld('down', mine); else if (!trig && H.trig) void useHeld('up', mine); }
  H.grip = grip; H.trig = trig;
  return { holding: mine, took };
}
// the offset a near hand takes a thing at: where it is in the palm's frame now (held where grabbed: Unreal Free)
function offsetIn(side, id) {
  const obj = entities.get(id); const palm = palmOf(net.you, side, { p: new THREE.Vector3(), q: new THREE.Quaternion() }); if (!obj || !palm) return null;
  obj.updateWorldMatrix(true, false); const qi = palm.q.clone().invert();
  const p = obj.getWorldPosition(new THREE.Vector3()).sub(palm.p).applyQuaternion(qi);
  if (p.length() > 1.9) return null;
  const q = qi.multiply(obj.getWorldQuaternion(new THREE.Quaternion()));
  return { pos: p.toArray().map(r3), q: q.normalize().toArray().map((n) => Math.round(n * 1e6) / 1e6) };
}
async function vrTake(side, id, far, haptic) {
  const H = vrHands[side]; H.busy = true;
  try {
    const g = grabOf(compsOf(id)); const off = !far && !Object.keys(g?.grips ?? {}).length ? offsetIn(side, id) : null;
    await track(true);
    const r = await sendRequest('grab', { id, hand: side, ...(off ? { offset: off } : {}) });
    if (r?.ok) haptic(0.4, 30); else { haptic(0.25, 25); setTimeout(() => haptic(0.25, 25), 90); refused('grab', r, id); }   // a refusal is two short pulses in the hand that asked
    H.busy = false;
    // a quick tap: the grip let go before the authority answered. Press-to-hold means it lets go now (it never stays stuck)
    if (r?.ok && !H.grip && grabOf(compsOf(id))?.hold !== 'toggle') await vrLetGo(side, id);
    return r;
  } finally { H.busy = false; }
}
async function vrLetGo(side, id) {
  const H = vrHands[side]; const h = holds[id]; H.busy = true;
  try {
    if (h?.second) { await track(true); return await sendRequest('drop', { id, hand: side }); }   // the other hand keeps it
    const a = H.hist[0], b = H.hist[H.hist.length - 1]; const dt = a && b ? (b.t - a.t) / 1000 : 0;
    const v = dt > 0.02 ? b.p.map((x, i) => (x - a.p[i]) / dt) : [0, 0, 0];
    return await release(v, id);
  } finally { H.busy = false; }
}

// ---------------------------------------------------------------- keys: T take/put · C throw/punt
const KEYS = [
  { code: 'KeyT', key: 'T', id: 'body:take', title: 'pick up / put down', keywords: ['grab', 'carry', 'hold', 'take', 'put'], icon: 'hand',
    run: () => (myHolds().length ? put() : grab()) },
  { code: 'KeyC', key: 'C', id: 'body:throw', title: 'throw what you hold / punt what\'s at your feet', keywords: ['throw', 'kick', 'punt', 'toss'],
    run: () => (myHolds().length ? throwHeld(hooks?.aim?.() ?? undefined) : punt()) },   // at the spot under the cursor (main.js hands me aim())
];
for (const { code, ...a } of KEYS) registerAction({ ...a, group: 'body' });
bus.on('key', (e) => {
  if (e.repeat || e.ctrlKey || e.metaKey || e.altKey || hooks?.editing?.()) return;
  KEYS.find((k) => k.code === e.code)?.run();
});

/** The hint bar's line about my hands (localbody.js updateSeatHint): what I hold and how to let go, else what's in reach
 *  to pick up. R, 10-10: "there's no help option to assist me while I'm holding anything". Null in a headset, in edit mode,
 *  outside a world. */
export function handsHint() {
  if (!replica.active || hooks?.editing?.() || xrActive()) return null;
  const held = myHolds()[0];
  if (held) return html`holding <b>${nameOf(held) ?? held}</b> — click a spot to set it down there · <kbd>T</kbd> at your feet · <kbd>C</kbd> throws at the cursor · right-click for more`;
  const near = nearest(inHand, grabbableIds(), prioOf);
  return near ? html`click or <kbd>T</kbd> to pick up <b>${nameOf(near) ?? near}</b>` : null;
}

/** The surface a runtime mod scripts against (mods.js EW.physics): the same requests the keys send. */
/** Could my hand set something down at this spot on the floor from where I stand (the authority's reach, with a margin)? */
// where a let-go starts: the thing as drawn in my hand, but never further from the authority's hand than its reach. A big
// thing carried two-armed is drawn pushed out from the chest, and the authority's track of a walking body runs a step
// behind: R 10-11 14:25, 'Couldn't throw: … is 1.586 m from your hand as the authority tracks your body; you can reach 1.5 m'
const letGoAt = (pos) => { const f = feet(); if (!pos || !f) return pos; const h = new THREE.Vector3(f[0], f[1] + HAND_Y, f[2]);
  const d = pos.distanceTo(h), lim = REACH - 0.15; return d <= lim ? pos : h.lerp(pos, lim / d); };
const canPutAt = (x, y, z) => { const f = feet(); return !!f && Math.hypot(x - f[0], y - (f[1] + HAND_Y), z - f[2]) <= REACH - 0.08; };
/** Can my hand reach it from where I stand (the authority's own measure: hand to thing, within its range)? */
const inReach = (id) => { const f = feet(), p = whereIs(id); return !!f && !!p && inHand(p, f, id) !== null; };
/** Where it is and how far along the floor from my feet: {at: [x, y, z], flat} or null. */
const canPunt = (id) => { const f = feet(), p = whereIs(id); return !!f && !!p && atFeet(p, f) !== null; };
const whereFromMe = (id) => { const f = feet(), p = whereIs(id); return f && p ? { at: p, flat: Math.hypot(p[0] - f[0], p[2] - f[2]) } : null; };
export const physicsApi = { grab, put, drop, throw: throwHeld, punt, canPunt, grabNear, release, use: useHeld, xrHand, holds: holdsNow, mine: myHolds, shown: simShown, pending: pendingNow, swaps: () => stats.swaps, predict: (on) => (predictOn = on !== false), lag: (ms) => (lagMs = Math.max(0, ms | 0)), settle: (ms) => (SETTLE_MS = Math.max(0, ms | 0)), settling: () => [...settles.keys()], whereIs, inReach, whereFromMe, canPutAt,
  /** the held things whose fx this client is drawing now (grabbable's presence tier) */
  fx: () => pressFxOn(),
  /** what a hand may do with a thing (shared/grab.js grabOf over this client's fold), or null */
  grabbable: (id) => grabOf(compsOf(id)),
  /** probe surface: where a held thing should be drawn now (heldPose, fresh) beside where it is drawn */
  heldAt: (id) => { const h = holds[id], obj = entities.get(id); if (!h || !obj) return null; obj.updateWorldMatrix(true, false);
    const at = heldPose(id, h, obj); return { want: at ? { p: at.p.toArray(), q: at.q?.toArray() ?? null } : null, drawn: { p: obj.getWorldPosition(new THREE.Vector3()).toArray(), q: obj.getWorldQuaternion(new THREE.Quaternion()).toArray() }, rec: h }; },
  /** probe surface: the palm frame a holder's hand gives ({p, q} world arrays), and the hold pose a body wears */
  palm: (actorId, side = 'right') => { const o = palmOf(actorId ?? net.you, side, { p: new THREE.Vector3(), q: new THREE.Quaternion() }); return o ? { p: o.p.toArray(), q: o.q.toArray() } : null; },
  track: () => track(true), request: (verb, args) => sendRequest(verb, args), frame: (wall) => frame(wall),
  /** the canonical fold's flights: id -> the launch seq it flies from */
  launched: () => Object.fromEntries(Object.entries(replica.sim?.launched ?? {}).map(([id, l]) => [id, l.seq])),
  /** what this client believes about its authority-tracked body (diagnostics) */
  body: () => ({ arrived, trackedAt, feet: feet(), lastMove, stats: { ...stats, ms: Math.round(stats.ms), maxMs: +stats.maxMs.toFixed(2) } }) };
