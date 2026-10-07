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
import { advanceSim, tickOf } from '../../shared/sim.js';
import { onWorldChange } from './state.js';

const REACH = 1.5, HAND_Y = 1.1;                  // the door's: a hand reaches 1.5 m from feet + 1.1 m (door.js)
const KICK = { reach: 1.6, below: -0.5, above: 2.0 }; // the door's punt reach, from the feet
const TRACK_MS = 200, TRACK_MIN = 0.05;           // the body track: at most 5 moves a second, only when moved
const THROW = { speed: 8, arc: 0.45 };            // a desktop throw: along the view's heading, ~26° up
const PUNT_POWER = 4;                             // physobj's default: a barrel hops a couple of metres

let hooks = null;   // { myPos(): {x,y,z}, me(): Avatar|null, camera, editing(): bool }
export function initV4Phys(h) { hooks = h; pushHostHook(frame); }

// ---------------------------------------------------------------- who holds what (door presence)
let holds = {};     // id -> { by: v4 identity }
bus.on('v4-holds', (h) => {
  const before = holds; holds = h && typeof h === 'object' ? h : {};
  for (const id of Object.keys(before)) if (!holds[id]) released(id);
  for (const id of Object.keys(holds)) if (!before[id]) suspendCollider(id, true);
});
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
  for (const id in es) if (es[id].c.physics?.kind === 'dynamic') return true; return false; };
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
/** Where a holder's hand is in the world: their avatar's right hand bone, else in front of their chest. */
function handOf(v4id, out = _hp) {
  const pid = presenceIdOf(v4id);
  const av = pid === null ? hooks?.me() : pid ? remotes.get(pid)?.avatar : null;
  // the RAW bone: the skinned skeleton the person sees. (The normalized rig is a proxy; on a cloned avatar it can be
  // another body's — the browser probe saw Bob's box drawn in Ann's hand through it.)
  const bone = av?.vrm?.humanoid?.getRawBoneNode?.('rightHand') ?? av?.vrm?.humanoid?.getNormalizedBoneNode?.('rightHand');
  if (bone) { bone.updateWorldMatrix(true, false); return bone.getWorldPosition(out); }
  const root = av?.root; if (!root) return null;
  root.getWorldPosition(out); root.getWorldDirection(_fw); _fw.y = 0; if (_fw.lengthSq() > 1e-9) _fw.normalize();
  return out.set(out.x + _fw.x * 0.35, out.y + HAND_Y, out.z + _fw.z * 0.35);
}
// a thing's visual centre, local to its origin (its collider box): held by its middle, not its base
const _c = new THREE.Vector3();
function localCentre(id, obj) {
  const b = colliders.get(id)?.box; if (!b) return _c.set(0, 0.1, 0);
  const s = obj.scale ?? { x: 1, y: 1, z: 1 };
  return _c.set((b.min.x + b.max.x) / 2 * (s.x || 1), (b.min.y + b.max.y) / 2 * (s.y || 1), (b.min.z + b.max.z) / 2 * (s.z || 1));
}
const _w = new THREE.Vector3(), _q = new THREE.Quaternion(), _m = new THREE.Matrix4(), _s = new THREE.Vector3();
/** Draw obj at a WORLD pose whatever its scene parent (a thing that rested on a table may hang under it). */
function setWorldPose(obj, pos, quat) {
  if (!obj.parent || obj.parent.isScene) { obj.position.copy(pos); if (quat) obj.quaternion.copy(quat); return; }
  obj.parent.updateWorldMatrix(true, false);
  _m.copy(obj.parent.matrixWorld).invert();
  obj.position.copy(pos).applyMatrix4(_m);
  if (quat) { obj.parent.matrixWorld.decompose(_w, _q, _s); obj.quaternion.copy(_q.invert().multiply(quat)); }
}
const _held = new THREE.Vector3(), _hq = new THREE.Quaternion();
function drawHeld() {
  for (const [id, h] of Object.entries(holds)) {
    if (pres?.bodies?.[id]) continue;              // thrown or dropped: the launch is folded, the flight draws it
    const obj = entities.get(id); if (!obj) continue;
    const hand = handOf(h.by); if (!hand) continue;
    obj.getWorldQuaternion(_hq);
    _held.copy(localCentre(id, obj)).applyQuaternion(_hq);
    setWorldPose(obj, _w.copy(hand).sub(_held), null);
  }
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
  tickTrack(now);
  const ms = performance.now() - now; stats.frames++; stats.ms += ms; if (ms > stats.maxMs) stats.maxMs = ms;
}

// ---------------------------------------------------------------- acts (door requests)
const say = (t) => logChat('*', t);
const refused = (what, r) => { const x = r?.refused; say(`${what}: ${x?.reason ?? 'the door said no'}${x?.teach ? ` (${x.teach})` : ''}`); bus.emit('v4phys-refused', { tool: what, refused: x }); return r; };
const dynamicIds = () => { const es = v4.st?.entities ?? {}; return Object.keys(es).filter((id) => es[id].c.physics?.kind === 'dynamic'); };
/** Where the thing is now, as the door sees it: someone's hand, the air (the engine), or the log. */
function whereIs(id) {
  const b = pres?.bodies?.[id]; if (b && !b.resting) return b.p;
  const obj = entities.get(id); if (obj) { obj.updateWorldMatrix(true, false); return obj.getWorldPosition(new THREE.Vector3()).toArray(); }
  return null;
}
function nearest(ok) {
  const f = feet(); if (!f) return null; let best = null, bd = Infinity;
  for (const id of dynamicIds()) { if (holds[id]) continue; const p = whereIs(id); if (!p) continue; const d = ok(p, f); if (d !== null && d < bd) { bd = d; best = id; } }
  return best;
}
const inHand = (p, f) => { const d = Math.hypot(p[0] - f[0], p[1] - (f[1] + HAND_Y), p[2] - f[2]); return d <= REACH ? d : null; };
const atFeet = (p, f) => { const dh = Math.hypot(p[0] - f[0], p[2] - f[2]), dy = p[1] - f[1]; return dh <= KICK.reach && dy >= KICK.below && dy <= KICK.above ? dh : null; };

/** Pick something up: the named thing, or the nearest you can reach. */
export async function grab(name) {
  if (!v4.active) return say('carrying works in v4 worlds');
  const id = name || nearest(inHand);
  if (!id) return say('nothing here you can pick up within reach (things with physics {kind: dynamic})');
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
  for (const id of dynamicIds()) { if (holds[id]) continue; const obj = entities.get(id); if (!obj) continue;
    const c = obj.getWorldPosition(new THREE.Vector3()).add(localCentre(id, obj)); const d = Math.hypot(c.x - at[0], c.y - at[1], c.z - at[2]);
    if (d < bd && inHand(c.toArray(), f) !== null) { bd = d; best = id; } }
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
export const physicsApi = { grab, put, drop, throw: throwHeld, punt, grabNear, release, holds: holdsNow, mine: myHolds, shown: simShown,
  track: () => track(true), request: (tool, args) => requestV4(tool, args), frame: (wall) => frame(wall),
  /** the canonical fold's flights: id -> the launch seq it flies from */
  launched: () => Object.fromEntries(Object.entries(v4.sim?.launched ?? {}).map(([id, l]) => [id, l.seq])),
  /** what this client believes about its door body (diagnostics) */
  body: () => ({ arrived, doorAt, feet: feet(), lastMove, stats: { ...stats, ms: Math.round(stats.ms), maxMs: +stats.maxMs.toFixed(2) } }) };
