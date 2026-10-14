// My body in the world's physics — ragdoll, seats, being dragged, pins,
// shoves. Extracted from main.js (§14 6c). The invariant every section here
// shares: MY client owns MY body. Everything that happens to it — a tumble, a
// seat, someone's hand, a nail, a blast — is applied HERE and rebroadcast
// through ordinary presence, so nobody else ever needs code to simulate me.
//
// logChat arrives through initLocalBody rather than an import: chat.js sits
// in the world→flora→controller→chat→net→world knot, and this module must
// not add another edge into it (§14.2).

import { bodyOf } from '../../shared/components.js';
import { mayLeave } from '../../shared/sockbody.js';
import { driveSeat, releaseSeat } from './seatbody.js';
import { serverNow } from './remotes.js';
import { sendRequest } from './net.js';
import { plain } from './plainwords.js';
import { usePromptHint } from './useprompt.js';
import { handsHint, physicsApi as _phys } from './thingphysics.js';
const myHoldsNow = () => _phys.mine().length > 0;
import { THREE } from './core.js';
import { CONFIG, bus } from './base.js';
import { mergePose } from '../../shared/humanoid.js';
import {
  myState, updateFollowCamera, setPosture, keys, setSeatHook, setMountedHook, camYaw, camPitch, setCamYaw, xrIntent,
} from './controller.js';
import { camera } from './core.js';
import { avatarMounts, mountTransform, bags, bagOf, socketWorldPos, setBodySeat, entities, seatSocket, socketsOn, parentIdOf } from './world.js';
import { outOfMyView } from './myview.js';
import { sendAnim } from './net.js';
import { makeRagdoll } from './bodysim.js';
import { jointPositions } from './ragdoll.js';
import { initBodyDrag, beingDragged, revokeDragged } from './bodydrag.js';
import { toast, flashHint, setAmbientHint, html } from './ui.js';
import { posable, pushable, bodyTable, onConsentChange } from './consent.js';
import { makeConsentSync } from './consentsync.js';
import { clearMyReach } from './reachnet.js';
import { getMe } from './mybody.js';

let logChat = () => {};

// Ragdoll — owner-simulated, presence-streamed, captured to a held pose.
//
// Only this client simulates its own body; the result rides the pose field
// like any other pose, so remotes need no ragdoll code at all. On settle the
// final bones stay as a held pose (lastPose), so a reconnect or a late joiner
// gets the settled RESULT, not a replay of the flop.
let ragdoll = null;
let downed = false;

export function isDowned() { return downed; }
export function activeRagdoll() { return ragdoll; }

// Which way you go over. A limp body does not drop straight down — its support
// fails and the mass above the feet keeps going — and one that DOES drop
// straight down has nowhere to put its leg length, so it folds its knees into
// their stops under its own weight and then kicks them back out. You fall the
// way you were facing, harder the faster you were moving.
const _fall = new THREE.Vector3();
function toppleVelocity() {
  return _fall.set(Math.sin(myState.yaw), 0, Math.cos(myState.yaw))
    .multiplyScalar(0.9 + Math.min(1.2, (myState.speed ?? 0) * 0.35));
}

export function goLimp(lean = null) {
  const me = getMe();
  if (!me || downed) return;
  downed = true;
  // Park the undriven bones and stop the clip BEFORE constructing the sim.
  // Both of the sim's reference skeletons are read in here — the neutral rest
  // it measures its limits against, and the live pose the tumble starts from —
  // and neither may still have the walk cycle in it.
  me.setLimp(true);
  clearMyReach();   // a knocked-over body's reach is gone — descriptor AND arm (mirrors agent.ts knockDown)
  ragdoll = makeRagdoll(me, lean ?? toppleVelocity(), me.restBonePositions());
  myState.clip = 'ragdoll';
  flashHint('limp — move to get up');
}
export function getUp() {
  if (!downed) return;
  const me = getMe();
  revokeDragged();                 // if someone is dragging me, I take myself back
  clearPins();                     // standing up tears every nail out
  downed = false; ragdoll?.dispose?.(); ragdoll = null;
  myState.pose = null; me?.clearPose();
  me?.setLimp(false);
  myState.clip = 'idle';
  // resume from where the body ended up
  myState.pos.copy(me.root.position);
  myState.pos.y = 0;
}
// ---------------------------------------------------------------- mounted
// While seated/riding, my body is DERIVED from the parent entity's live
// transform + socket (same math remotes use for me: seatbody.js) — so I visibly
// swing on the swing I'm sitting on. Getting off is the socket's to allow
// (body.leaveBy, shared/sockbody.js mayLeave): moving, jumping, the explicit
// get-up (X, the stand tile, the radial menu), or only a script. Getting off
// emits no verb — my next frame simply carries no seat — and stamps where I land.
const _seatP = new THREE.Vector3();
let leaving = null;            // {from, to, yaw, clip, t0, dur}: carried off the seat while a leave clip plays
export const seatLeaving = () => !!leaving;
/** My seat's socket body (shared/sockbody.js bodyOf), or null when I'm not seated. */
export function mySeatBody() {
  const m = avatarMounts.get(CONFIG.name);
  return m ? bodyOf(seatSocket(m.to)?.sock) : null;
}
/** Get off my seat, if the socket lets this kind of leaving through ('move' | 'jump' | 'menu' | 'script'). True when
 *  I'm off (or on my way off, with a leave clip). */
export function dismountMe(kind = 'menu') {
  const m = avatarMounts.get(CONFIG.name);
  if (!m) return false;
  const body = mySeatBody();
  if (!mayLeave(body, kind)) {
    flashHint(body?.leaveBy === 'script' ? "this seat lets you go only when the world does" : body?.leaveBy === 'jump' ? html`<kbd>Space</kbd> or <kbd>X</kbd> to get off` : html`<kbd>X</kbd> to get off`);
    return false;
  }
  const me = getMe();
  const sw = mountTransform(CONFIG.name, _seatP, { av: me });
  const yaw = sw?.yaw ?? myState.yaw;
  const off = sw ? _seatP.clone() : myState.pos.clone();
  let exitYaw = yaw;
  // the socket's exit (its own frame), where it names one: off a horse to the side, out of a car door
  const ex = body?.exit;
  const host = seatSocket(m.to)?.host;   // the exit is in the thing's frame
  if (ex && host != null && entities.get(host)) {
    const obj = entities.get(host); obj.updateWorldMatrix(true, false);
    off.set(ex[0], ex[1], ex[2]).applyMatrix4(obj.matrixWorld);
    if (ex.length === 4) { const f = new THREE.Vector3(Math.sin(ex[3]), 0, Math.cos(ex[3])).transformDirection(obj.matrixWorld); exitYaw = Math.atan2(f.x, f.z); }
  } else { off.x += Math.sin(yaw) * 0.7; off.z += Math.cos(yaw) * 0.7; }
  sitTicket++;                           // an answer still on its way for an earlier sit is stale now
  setBodySeat(CONFIG.name, null);        // presence: my next frame carries no seat, and everyone stands me up
  const from = me ? me.root.position.clone() : off.clone();
  const leaveClip = me ? body?.leave ?? null : null;
  releaseSeat(me);
  if (leaveClip && me) {
    // carried off while the leave clip plays, its time locked to the carry (the same warp that carries you on)
    const a = me.ensureClip(leaveClip);
    leaving = { from, to: new THREE.Vector3(off.x, off.y, off.z), yaw: exitYaw, clip: leaveClip, t0: performance.now(), dur: a ? a.getClip().duration : 1.2 };
    myState.clip = leaveClip;
  } else {
    me?.root.rotation.set(0, exitYaw, 0);  // stand upright again (a rocket seat may have had me on my back)
    myState.pos.set(off.x, 0, off.z); myState.yaw = exitYaw;
    setPosture('stand');
  }
  return true;
}
function stepLeaving(dt) {
  const me = getMe();
  const u = Math.min(1, (performance.now() - leaving.t0) / 1000 / leaving.dur);
  const k = u * u * (3 - 2 * u);
  myState.pos.copy(leaving.from).lerp(leaving.to, k);
  myState.yaw = leaving.yaw; myState.speed = 0; myState.clip = leaving.clip;
  if (me) {
    me.root.position.copy(myState.pos);
    me.root.quaternion.slerp(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), leaving.yaw), Math.min(1, 10 * dt));
    me.setSeatBlend([[leaving.clip, 1]], u);
    updateFollowCamera(dt, me);
  }
  if (u >= 1) {
    me?.setSeatBlend(null); me?.root.rotation.set(0, leaving.yaw, 0);
    myState.pos.y = 0; myState.clip = 'idle'; leaving = null;
    setPosture('stand');
  }
}

const MOVE = { fwd: ['KeyW', 'ArrowUp'], back: ['KeyS', 'ArrowDown'], left: ['KeyA', 'ArrowLeft'], right: ['KeyD', 'ArrowRight'] };
const held = (l) => l.some((k) => keys.has(k));
const _camUp = new THREE.Vector3(), _camQ = new THREE.Quaternion(), _camO = new THREE.Vector3(), _camD = new THREE.Vector3();
let lastSeat = null;
export function updateMountedMe(dt) {
  if (leaving) { stepLeaving(dt); return; }
  const me = getMe();
  const m = avatarMounts.get(CONFIG.name);
  if (!m || !me) return;
  const body = mySeatBody();
  if (!body) {   // the socket went away under me (removed, or a script took the seat away): that is how a script lets go
    dismountMe('script');
    return;
  }
  // my input, where the socket routes it: published as signals on my seat frame (net.js), never as physics here
  const seatYaw = lastSeat?.yaw ?? myState.yaw;
  const inp = {};
  if (body.input.move !== 'none') {
    inp.throttle = Math.max(-1, Math.min(1, (held(MOVE.fwd) ? 1 : 0) - (held(MOVE.back) ? 1 : 0) + (xrIntent.active ? xrIntent.fwd : 0)));
    inp.steer = Math.max(-1, Math.min(1, (held(MOVE.right) ? 1 : 0) - (held(MOVE.left) ? 1 : 0) + (xrIntent.active ? xrIntent.strafe : 0)));
  }
  if (body.input.look !== 'locked') {   // where I look, relative to the seat: the camera looks back along camYaw
    inp.aimYaw = Math.atan2(Math.sin(camYaw + Math.PI - seatYaw), Math.cos(camYaw + Math.PI - seatYaw));
    inp.aimPitch = Math.max(-1.5, Math.min(1.5, -(camPitch - 0.32)));
  }
  m.in = inp;
  me.pitch = 0;   // the seat turns the head (setSeatLook); the walking head pitch stays off while seated
  const r = driveSeat(me, CONFIG.name, { dt, nowMs: serverNow(), local: true });
  if (!r) { updateFollowCamera(dt, me); return; }   // parent still downloading
  lastSeat = r;
  myState.pos.copy(r.pos);
  myState.yaw = r.yaw;
  myState.speed = 0;
  myState.clip = r.clip;
  me.root.position.copy(r.pos);
  me.root.quaternion.copy(r.q);   // the socket's whole rotation: upright on a chair, on your back in a rocket
  // look locked: the view faces the way the seat does (the camera sits behind it)
  if (body.input.look === 'locked') setCamYaw(r.yaw + Math.PI);
  // The camera lives in updateMe, which we skip while seated — so drive it
  // here too (the ragdoll path learned this the same way), or it freezes on
  // the frame you sat down and never rides the seat (#75). First person keeps
  // its own-mesh exclusion; both modes follow the socket, moving or not.
  updateFollowCamera(dt, me);
  // look.up 'socket': the view rolls with the thing (a rocket, a loop-the-loop); 'world' keeps the horizon level
  if (body.look.up === 'socket') {
    _camQ.fromArray(r.sw.socketQ); const f = new THREE.Vector3(0, 0, 1).applyQuaternion(_camQ);
    const tilt = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.atan2(f.x, f.z)).invert().premultiply(_camQ);   // the socket's rotation without its heading
    const pivot = me.headWorldPosition(new THREE.Vector3()) ?? r.pos;
    camera.getWorldDirection(_camD);
    _camO.copy(camera.position).sub(pivot).applyQuaternion(tilt);
    camera.position.copy(pivot).add(_camO);
    camera.up.copy(_camUp.set(0, 1, 0).applyQuaternion(tilt));
    camera.lookAt(_camO.copy(camera.position).add(_camD.applyQuaternion(tilt)));
  } else camera.up.set(0, 1, 0);
  // getting off, as the socket allows: movement keys (only when the seat doesn't take them), jump
  if (['KeyW', 'KeyA', 'KeyS', 'KeyD'].some((k) => keys.has(k)) && body.input.move === 'none') { if (mayLeave(body, 'move')) { camera.up.set(0, 1, 0); dismountMe('move'); } }
  else if (keys.has('Space') || (xrIntent.active && xrIntent.jump)) { if (mayLeave(body, 'jump')) { camera.up.set(0, 1, 0); dismountMe('jump'); } }
}

/** Pick one of my seat's named poses (its `poses` menu), or its default (null). Rides my seat frames with the time I
 *  chose it, so a sync group follows the latest choice on every screen. Returns the menu, or null when not seated. */
export function chooseSeatPose(name) {
  const m = avatarMounts.get(CONFIG.name); const b = mySeatBody();
  if (!m || !b) return null;
  const menu = Object.keys(b.poses);
  if (name == null || name === '') return menu;   // just asking
  if (name === 'default') { delete m.pose; delete m.at; return menu; }
  if (!menu.includes(name)) return menu;
  m.pose = name; m.at = serverNow();
  return menu;
}

/** Nearest declared seat: distance to the SOCKET's world point, not the
 *  entity's origin — a swing's pivot frame is not where you sit, and on a
 *  ferry the helm can be a deck-length from the hull's center. Every slot
 *  competes, not just the first. `arg` narrows to one entity by id prefix
 *  (case-insensitive), so `/sit 34` reaches 3485c78e without the full hash.
 *  A seat someone is already on is taken (one occupant per socket); the seat
 *  I'm on doesn't count. */
const _sitV = new THREE.Vector3();
// R 10-11 00:47: X near the crates lifted her ~5 m: a seat declared on a sign 3 m up counted as 'near' (only the ground
// distance was read). A plain X offers only a seat you could climb onto; naming one (/sit <name>) still reaches any.
const SEAT_RISE = { up: 1.6, down: 1.0 };
function nearestSeat(arg, reach) {
  const want = arg ? String(arg).toLowerCase() : null;
  const mine = avatarMounts.get(CONFIG.name);
  const taken = new Set([...avatarMounts].filter(([id]) => id !== CONFIG.name).map(([, o]) => o.to));
  let best = null, bestD = reach;
  // every socket child in the world (a seat is a socket with a body block): its host is what you name and see
  for (const [sid, c] of bags()) {
    if (!c?.socket || typeof c.socket !== 'object' || c.disabled === true) continue;
    const body = bodyOf(c.socket);
    if (!body) continue;   // an attachment point for things, not a seat
    const id = parentIdOf(sid);
    if (id == null) continue;
    if (want && !id.toLowerCase().startsWith(want) && !sid.toLowerCase().startsWith(want)) continue;
    if (!want && entities.get(id) && outOfMyView(entities.get(id))) continue;   // a seat I hid is not offered; naming it still sits
    if (mine && mine.to === sid) continue;
    if (taken.has(sid)) continue;
    const p = socketWorldPos(sid, _sitV);
    if (!p) continue;
    const d = Math.hypot(p.x - myState.pos.x, p.z - myState.pos.z);
    if (!want && (p.y - myState.pos.y > SEAT_RISE.up || myState.pos.y - p.y > SEAT_RISE.down)) continue;   // out of climbing reach
    if (d < bestD) { bestD = d; best = { id, sock: sid, slot: c.socket.name, d, body }; }
  }
  return best;
}

/** Sit ON something: nearest socket within arm's reach (or a named entity
 *  from anywhere). When nothing is in reach but a seat exists further out,
 *  SAY so — the silent ground-sit fallback read as "sitting is broken" to
 *  anyone standing four meters from a swing they could name but not see.
 *  In a world the authority is asked first (`use {id, action, args: {slot}}`):
 *  it checks who may and answers with what the body does; nothing is logged.
 *  Already seated, I may move straight to a socket that allows it (fromSeat). */
let sitTicket = 0;   // the latest sit ask; getting up (or asking again) makes every earlier answer stale
export function trySitOn(arg, slot = null) {
  const mine = avatarMounts.get(CONFIG.name);
  const best = nearestSeat(arg, arg ? Infinity : 3.5);
  if (best && slot && best.slot !== slot) { const o = socketsOn(best.id).find((x) => x.name === slot); const b = bodyOf(o?.sock); if (b) Object.assign(best, { sock: o.id, slot, body: b }); }
  if (!best) {
    const far = arg ? null : nearestSeat(null, 30);
    if (far) logChat('*', `nearest seat is ${far.id} (${far.slot}), ${far.d.toFixed(0)}m away — walk closer, or /sit ${far.id}`);
    return false;
  }
  if (mine && !best.body.fromSeat) { logChat('*', `get up first — ${best.id} (${best.slot}) doesn't take you straight from another seat`); return true; }
  const ticket = ++sitTicket;
  const take = () => {
    // only the latest ask may seat me, and only if I haven't sat, moved or stood since asking: a late answer (a slow
    // door, X pressed twice) must never put me back on a seat I already left
    if (ticket !== sitTicket || avatarMounts.get(CONFIG.name) !== mine) return;
    if (mine) releaseSeat(getMe());
    setBodySeat(CONFIG.name, { to: best.sock });   // presence: my frames carry the seat, the socket's id (world.js)
    const lb = best.body.leaveBy;
    logChat('*', `you ${best.body.action} on ${best.id} (${best.slot}) — ${lb === 'script' ? 'it lets you go when the world does' : lb === 'menu' ? 'X to get up' : lb === 'jump' ? 'Space or X to get up' : 'X or move to get off'}`);
  };
  sendRequest('use', { id: best.sock, action: best.body.action }).then((r) => {
    if (r?.ok) take(); else logChat('*', plain(`${best.body.action} on ${best.id}`, r));   // a person's words (plainwords.js)
  });
  return true;
}

// "I'm working on this" (R, 10-10): while my camera is free of my body in edit mode, the body holds a working pose, so
// the people around it can see I've stepped out: forearms raised as at a console, head bent to it. Mine to give up: it
// ends when the camera comes back (the Body switch, or B), and any pose I held before is not restored (moving ends a
// pose anyway).
// R, 10-10, on seeing it: "extend the arms out further in front of the body and rotate the hands palm out, kind of like a
// mage casting magic". Arms forward and a little down (Y −80°, Z −15°), elbows barely bent, wrists back 80° so the palms face out.
// R 10-10 23:33: 'relax the elbows and spread the arms apart like 15 degrees' (7.5° each arm, elbows 15° → 35°)
const WORKING_POSE = { leftUpperArm: [0.0772, -0.5863, -0.1053, 0.7995], rightUpperArm: [0.0772, 0.5863, 0.1053, 0.7995], leftLowerArm: [0, -0.3007, 0, 0.9537], rightLowerArm: [0, 0.3007, 0, 0.9537],
  leftHand: [0, 0, 0.6428, 0.766], rightHand: [0, 0, -0.6428, 0.766], head: [0.0872, 0, 0, 0.9962] };
let working = false;
bus.on('edit-freecam', (on) => {
  const me = getMe(); if (!me) return;
  if (on && !working) { working = true; me.setPose(WORKING_POSE); myState.pose = WORKING_POSE; }
  else if (!on && working) { working = false; if (myState.pose === WORKING_POSE) { myState.pose = null; me.clearPose(); } }
});

// The world's standing offer, kept current at a walk: when a declared seat
// is within reach the hint bar says so — an affordance nobody can discover
// is indistinguishable from one that doesn't exist. Checked ~2×/s.
let _hintAcc = 0;
// builder mode has its own keys (build.js: X and Del remove, E rotates): the world's play offers ("X — sit", "E open")
// would advertise a delete key as a seat (review 10-07 B5). The bar carries the builder's hints there instead.
let _building = false;
bus.on('edit-mode', (on) => { _building = !!on; _hintAcc = 1; });
export function updateSeatHint(dt) {
  _hintAcc += dt;
  if (_hintAcc < 0.45) return;
  _hintAcc = 0;
  if (CONFIG.renderer || CONFIG.spectate) return;
  if (_building) { setAmbientHint(null); return; }
  let hint = null;
  if (avatarMounts.has(CONFIG.name)) { const b = mySeatBody();
    hint = !b || b.leaveBy === 'any' ? (b?.input.move !== 'none' && b ? html`<kbd>X</kbd> get up · <kbd>WASD</kbd> drive` : html`<kbd>X</kbd> get up · <kbd>WASD</kbd> hop off`)
      : b.leaveBy === 'script' ? 'this seat lets you go when the world does' : b.leaveBy === 'jump' ? html`<kbd>Space</kbd> or <kbd>X</kbd> get up` : html`<kbd>X</kbd> get up`; }
  else if (!downed && nearestSeat(null, 3.5)) hint = html`<kbd>X</kbd> — sit`;
  // my hands come first: what I hold and how to let go (it must never be a secret), else what's in reach to pick up
  if (!downed) { const hh = handsHint(); if (hh && (myHoldsNow() || !hint)) hint = hh; }
  if (!hint && !downed) hint = usePromptHint();   // E: what's in front of you to use (useprompt.js)
  setAmbientHint(hint);
}

export function stepRagdoll(dt) {
  const me = getMe();
  if (ragdoll) {
    const pose = ragdoll.step(dt);
    if (pose) myState.pose = pose;               // stream it through presence
    myState.pos.copy(me.root.position);          // streamed root tracks the sim
    if (ragdoll.done) { myState.pose = ragdoll.finalPose; ragdoll = null; }
  }
  // The camera lives in updateMe, which we skip while limp — so drive it here
  // too, or it freezes on the frame you fell (which is what it did).
  if (me) updateFollowCamera(dt, me);
}

// ---------------------------------------------------------------- dragged
// Someone else's sim is driving my limp body (bodydrag takeover — the drag
// module holds the protocol; these are the hands it moves). My client stays
// the authority: it APPLIES the stream to itself and rebroadcasts through
// normal presence, so everyone else sees the drag as ordinary motion of mine.

function beginDraggedMode(by) {
  const me = getMe();
  if (!me) return;
  ragdoll?.dispose?.(); ragdoll = null;   // the dragger's sim owns the tumble now
  downed = true;
  me.setLimp(true);
  myState.clip = 'ragdoll';
  flashHint(`${by} grabs you — move to break free`);
}

function applyDraggedSample({ pose, p, yaw }) {
  const me = getMe();
  if (!me) return;
  if (Array.isArray(p) && p.length === 3 && p.every(Number.isFinite)) {
    me.root.position.set(p[0], p[1], p[2]);
    myState.pos.set(p[0], p[1], p[2]);
  }
  if (Number.isFinite(yaw)) { yaw = Math.atan2(Math.sin(yaw), Math.cos(yaw)); me.root.rotation.y = yaw; myState.yaw = yaw; }
  if (pose && typeof pose === 'object') { me.setPose(pose); myState.pose = pose; }
  me.root.updateMatrixWorld(true);
  noteDraggedMotion();
  myState.clip = 'ragdoll';
  myState.speed = 0;
}

// While a hand holds me, my body is a stream of poses with no sim behind it —
// so its VELOCITY only exists as the difference between the frames arriving.
// Sampled here so the moment the hand lets go the sim can start with the
// motion the body already had, instead of at a dead stop.
let dragSnap = null, dragVel = null;
function noteDraggedMotion() {
  const me = getMe();
  if (!me) return;
  const now = performance.now();
  const pos = jointPositions(me);
  if (dragSnap && now > dragSnap.t) {
    const dt = Math.min(0.5, (now - dragSnap.t) / 1000);
    dragVel ??= new Map();
    for (const [j, p] of pos) {
      const was = dragSnap.pos.get(j);
      if (was) dragVel.set(j, (dragVel.get(j) ?? new THREE.Vector3()).copy(p).sub(was).divideScalar(dt));
    }
  }
  dragSnap = { t: now, pos: new Map([...pos].map(([j, p]) => [j, p.clone()])) };
}

function endDraggedMode(msg) {
  const me = getMe();
  if (!me || !downed) return;
  // land on their final frame, then settle under MY OWN sim from wherever the
  // hand let go — dropped from a height, the body falls; the takeover was
  // only ever the moving part
  if (msg?.pose || msg?.p) applyDraggedSample(msg);
  me.root.updateMatrixWorld(true);
  // the hand's own sim state outranks anything we sampled from its stream
  ragdoll = makeRagdoll(me, null, me.restBonePositions(), msg?.sim ?? dragVel);
  dragSnap = null; dragVel = null;
  applyMyPins();
  myState.clip = 'ragdoll';
}

// ---------------------------------------------------------------- pins
// Nails through my body (bodydrag's persistent pins): MY state, MY sim
// enforcing them, streamed in MY presence so everyone sees the markers. A
// dragger may place one (the release message carries it) or ask to pull one;
// my movement key tears them all out — the body is always its own final
// authority. Session-scoped on purpose: pins are presence, not history.
const myPins = new Map();            // joint -> [x, y, z]
const _pinV = new THREE.Vector3();
const MAX_PINS = 8;

function syncPins() {
  myState.pins = myPins.size ? [...myPins].map(([j, at]) => ({ j, at })) : null;
}
function applyMyPins() {
  if (!ragdoll) return;
  // §24k R0: everything in myPins is a NAIL (placed on release / pulled on
  // request), so it takes the nail's firm tuning — the dragger's takeover
  // sim already passed firm=true (bodydrag.js), while the owner's own
  // re-apply here didn't: the same nail held with different physics
  // depending on whose machine was simulating.
  for (const [j, at] of myPins) ragdoll.setPin(j, _pinV.set(at[0], at[1], at[2]), true);
}
function addPin(j, at) {
  if (!Array.isArray(at) || at.length !== 3 || !at.every(Number.isFinite)) return;
  if (myPins.size >= MAX_PINS && !myPins.has(j)) return;
  myPins.set(j, at.map(Number));
  applyMyPins();
  syncPins();
}
function removePin(j) {
  if (!myPins.delete(j)) return;
  ragdoll?.setPin(j, null);
  syncPins();
  // freed of a nail while lying with no live sim (and nobody's hand on me):
  // wake my own sim so the body sags from what remains and settles honestly
  const me = getMe();
  if (downed && !ragdoll && me && !beingDragged()) {
    me.root.updateMatrixWorld(true);
    ragdoll = makeRagdoll(me, null, me.restBonePositions());
    applyMyPins();
    myState.clip = 'ragdoll';
  }
}
function clearPins() {
  if (!myPins.size) return;
  myPins.clear();
  ragdoll?.setPin(null);
  syncPins();
}

// ---------------------------------------------------------------- shove

// The hard ceiling on any shove that arrives over the wire, in m/s. The sim
// has its own stability cap; this one is about the WORLD — nobody gets to
// launch a body across the map no matter what numbers they put in a message.
const MAX_PUSH = 6;
const _shove = new THREE.Vector3();

/** Every external force on my body lands here — a directed push, a blast,
 *  an undirected knock-over. I own the body, so I simulate: standing → the
 *  sim starts with this lean; mid-tumble → the running sim takes it as an
 *  impulse; settled-but-down → a fresh sim starts from the lying pose (a
 *  corpse can be kicked, and tumbles again). */
function applyShove(lean, by) {
  const me = getMe();
  if (!me) return;
  if (avatarMounts.has(CONFIG.name)) return;      // braced on a seat: a seat holds you through a knock
  if (beingDragged()) return;                     // a held body answers to the hand, not the blast
  if (lean && lean.lengthSq() > MAX_PUSH * MAX_PUSH) lean.setLength(MAX_PUSH);
  if (downed) {
    if (ragdoll) ragdoll.impulse(lean ?? toppleVelocity());
    else {
      // still limp from the last fall (getUp is what clears it) — the new sim
      // reads the lying pose as its start and the neutral rest as its limits
      ragdoll = makeRagdoll(me, lean ?? toppleVelocity(), me.restBonePositions());
      applyMyPins();               // a nailed body shoved is a nailed body swinging
      myState.clip = 'ragdoll';
    }
  } else {
    goLimp(lean);
  }
  if (by) flashHint(`${by} knocked you over`);
}

// ---------------------------------------------------------------- wiring

export function initLocalBody({ logChat: logChatFn }) {
  logChat = logChatFn;

  // my whole consent table (every class × strangers/friends) as the authority takes it (consentsync.js: the preset, then
  // the cells that depart from it): every arrival, every change; a refusal
  // is a toast and a retry
  const consentSync = makeConsentSync({ table: bodyTable, send: sendRequest, toast, on: (ev, fn) => bus.on(ev, fn), enabled: () => !(CONFIG.renderer || CONFIG.spectate) });
  onConsentChange(consentSync.sync);

  // X reaches the socket system through the controller's hook: mounted → get
  // up; a declared seat in reach → mount it; anything else falls through to
  // the controller's own layers (geometry seat pans, then the ground sit).
  setMountedHook(() => avatarMounts.has(CONFIG.name));
  setSeatHook(() => {
    if (avatarMounts.has(CONFIG.name)) { dismountMe('menu'); return true; }
    if (downed) return false;
    return trySitOn(null);
  });

  initBodyDrag({
    pushable: () => pushable(),
    isDowned: () => downed,
    myPos: () => myState.pos,
    beginDragged: beginDraggedMode,
    applyDragged: applyDraggedSample,
    endDragged: endDraggedMode,
    getPins: () => [...myPins].map(([j, at]) => ({ j, at })),
    addPin,
    removePin,
  });

  bus.on('puppet', ({ by, pose, merge, anim, ragdoll: rag }) => {
    // A ragdoll request runs the sim on MY body — I own it, so I simulate and
    // stream. That is the sync guarantee: the requester never simulates me.
    if (rag) {
      if (!pushable()) {
        toast(`${by} tried to knock you over — /pushable on to allow`, 'warn', 6000);
        return;
      }
      // rag is true (undirected — old wire, old clients) or {lean:[x,y,z]} m/s
      const l = Array.isArray(rag?.lean) && rag.lean.length === 3 && rag.lean.every(Number.isFinite)
        ? _shove.set(rag.lean[0], rag.lean[1], rag.lean[2]) : null;
      applyShove(l, by);
      return;
    }
    if (!posable()) {
      toast(`${by} tried to pose you — enable it in settings to allow`, 'warn', 6000);
      return;
    }
    // merge: only the bones they sent (null releases one); otherwise their
    // pose replaces mine whole — and an EMPTY one is a release. It used to
    // become an empty held pose, which setPose ignores: `clear_pose target`
    // never let a human go.
    if (pose) {
      myState.pose = merge ? mergePose(myState.pose, pose) : (Object.keys(pose).length ? pose : null);
      flashHint(myState.pose ? `${by} posed you` : `${by} released your pose`);
    }
    if (anim) {
      const data = { ...anim, replace: anim.replace !== false }; // legacy puppets replace
      if (data.replace) myState.pose = null;          // a replacing animation ends the held pose too
      getMe()?.playAnimation(data); sendAnim(data);
    }
  });

}
