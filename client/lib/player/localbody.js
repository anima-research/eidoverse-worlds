// localbody — my body in the world's physics: ragdoll, seats, being dragged, pins, shoves. The invariant every
// section shares: my client owns my body. Everything that happens to it (a tumble, a seat, someone's hand, a nail, a
// blast) is applied here and rebroadcast through ordinary presence, so nobody else needs code to simulate me.
//
// logChat arrives through initLocalBody rather than an import: chat.js sits in an import cycle this module must
// not add another edge to.

import { bodyOf } from '../../../shared/components.js';
import { mayLeave, vacatedFromMine, vacatedAt, OCCUPY_REACH, ESCAPE_HOLD_S, ESCAPE_REPEAT_S } from '../../../shared/sockbody.js';
import { driveOccupied, releaseOccupied } from '../avatar/occupybody.js';
import { serverNow } from './remotes.js';
import { sendRequest, identities } from '../net.js';
import { plain, called, typeable } from '../ui/plainwords.js';
import { usePromptHint } from '../ui/useprompt.js';
import { handsHint, physicsApi as _phys } from '../thingphysics.js';
const myHoldsNow = () => _phys.mine().length > 0;
import { THREE } from '../core.js';
import { CONFIG, bus } from '../base.js';
import { mergePose } from '../../../shared/humanoid.js';
import {
  myState, updateFollowCamera, setPosture, keys, setOccupyHook, setMountedHook, camYaw, camPitch, setCamYaw, xrIntent,
} from './controller.js';
import { camera } from '../core.js';
import { avatarMounts, mountTransform, bags, bagOf, socketWorldPos, setBodySeat, entities, seatSocket, socketsOn, parentIdOf } from '../world.js';
import { outOfMyView } from '../edit/myview.js';
import { sendAnim } from '../net.js';
import { makeRagdoll } from '../ragdoll/bodysim.js';
import { jointPositions } from '../ragdoll/ragdoll.js';
import { initBodyDrag, beingDragged, revokeDragged } from '../ragdoll/bodydrag.js';
import { toast, flashHint, setAmbientHint, html } from '../ui/ui.js';
import { pushable, bodyTable, onConsentChange, noteHeld, forget, landed, useWorld, takeNotice } from './consent.js';
import { makeConsentSync } from './consentsync.js';
import { bodyActAsPuppet, refusedNotice } from './bodyact.js';
import { clearMyReach } from './reachnet.js';
import { getMe } from './mybody.js';

let logChat = () => {};

// Ragdoll: owner-simulated, presence-streamed, captured to a held pose. Only this client simulates its own body; the
// result rides the pose field like any other pose, so remotes need no ragdoll code. On settle the final bones stay
// as a held pose, not a replay of the flop; a late joiner gets them from the next presence packet (server.ts
// settledPose drops a `ragdoll` clip's bones from the snapshot).
let ragdoll = null;
let downed = false;

export function isDowned() { return downed; }
export function activeRagdoll() { return ragdoll; }

// Which way you go over: the way you were facing, harder the faster you were moving. (A body dropped straight down
// has nowhere to put its leg length and kicks its knees back out.)
const _fall = new THREE.Vector3();
function toppleVelocity() {
  return _fall.set(Math.sin(myState.yaw), 0, Math.cos(myState.yaw))
    .multiplyScalar(0.9 + Math.min(1.2, (myState.speed ?? 0) * 0.35));
}

export function goLimp(lean = null) {
  const me = getMe();
  if (!me || downed) return;
  downed = true;
  // park the undriven bones and stop the clip before constructing the sim: its reference skeletons (the neutral rest
  // and the live start pose) are read here, and neither may still have the walk cycle in it
  me.setLimp(true, { bake: true });
  clearMyReach();   // a knocked-over body's reach is gone, descriptor and arm (as mcpl/agent.ts knockDown)
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
// While I occupy a seat, my body is derived from the parent entity's live transform + socket (the same math remotes
// use: occupybody.js). Getting off is the socket's to allow (shared/sockbody.js mayLeave): moving, jumping, the
// explicit get-up, or only a script. It emits no verb: my next frame simply carries no seat.
const _seatP = new THREE.Vector3();
let leaving = null;            // {from, to, yaw, clip, t0, dur}: carried off the seat while a leave clip plays
export const seatLeaving = () => !!leaving;
/** My seat's socket body (shared/sockbody.js bodyOf), or null when I'm not seated. */
export function occupiedBody() {
  const m = avatarMounts.get(CONFIG.name);
  return m ? bodyOf(seatSocket(m.to)?.station) : null;
}
// The escape: a seat that lets you go only when the world does still can't hold you. The explicit get-up pressed
// again within ESCAPE_REPEAT_S of its refusal, or X held for ESCAPE_HOLD_S, always gets you up.
let escapeArmedAt = -Infinity, escapeHeld = 0, escapeTile = false;
bus.on('escape-hold', (on) => { escapeTile = !!on; });   // the stand tile pressed and held (actionbar.js), as X held
/** Get off my seat, if the socket lets this kind of leaving through ('move' | 'jump' | 'menu' | 'script'). True when
 *  I'm off (or on my way off, with a leave clip). `at`: where the authority let me go ([x, y, z], its `vacated.at`). */
export function dismountMe(kind = 'menu', at = null) {
  const m = avatarMounts.get(CONFIG.name);
  if (!m) return false;
  const body = occupiedBody();
  if (kind === 'menu' && !mayLeave(body, kind) && body?.leaveBy === 'script' && performance.now() - escapeArmedAt < ESCAPE_REPEAT_S * 1000) kind = 'escape';
  if (!mayLeave(body, kind)) {
    if (body?.leaveBy === 'script' && kind === 'menu') escapeArmedAt = performance.now();
    flashHint(body?.leaveBy === 'script' ? html`this seat lets you go when the world does — <kbd>X</kbd> again (or hold it) to get up anyway` : body?.leaveBy === 'jump' ? html`<kbd>Space</kbd> or <kbd>X</kbd> to get off` : html`<kbd>X</kbd> to get off`);
    return false;
  }
  escapeArmedAt = -Infinity; escapeHeld = 0;
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
  if (at) off.set(at[0], at[1], at[2]);
  sitTicket++;                           // an answer still on its way for an earlier sit is stale now
  setBodySeat(CONFIG.name, null);        // presence: my next frame carries no seat, and everyone stands me up
  const from = me ? me.root.position.clone() : off.clone();
  const leaveClip = me ? body?.leave ?? null : null;
  releaseOccupied(me);
  if (leaveClip && me) {
    // carried off while the leave clip plays, its time locked to the carry (the same warp that carries you on)
    const a = me.ensureClip(leaveClip);
    leaving = { from, to: new THREE.Vector3(off.x, off.y, off.z), yaw: exitYaw, clip: leaveClip, t0: performance.now(), dur: a ? a.getClip().duration : 1.2 };
    myState.clip = leaveClip;
  } else {
    me?.root.rotation.set(0, exitYaw, 0);  // stand upright again (a rocket seat may have had me on my back)
    myState.pos.set(off.x, off.y, off.z); myState.yaw = exitYaw;   // at the height I'm let go at: a seat upstairs stands me upstairs
    myState.q = undefined;
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
  myState.q = undefined; myState.locomotion = undefined;
  if (me) {
    me.root.position.copy(myState.pos);
    me.locomotion = null;
    me.root.quaternion.slerp(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), leaving.yaw), Math.min(1, 10 * dt));
    me.setSeatBlend([[leaving.clip, 1]], u);
    updateFollowCamera(dt, me);
  }
  if (u >= 1) {
    me?.setSeatBlend(null); me?.root.rotation.set(0, leaving.yaw, 0);
    myState.pos.copy(leaving.to); myState.clip = 'idle'; leaving = null;   // where the carry ended, its height kept (never reset to 0)
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
  const body = occupiedBody();
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
  const r = driveOccupied(me, CONFIG.name, { dt, nowMs: serverNow(), local: true });
  if (!r) { updateFollowCamera(dt, me); return; }   // parent still downloading
  lastSeat = r;
  myState.pos.copy(r.pos);
  myState.yaw = r.yaw;
  myState.speed = 0;
  myState.clip = r.clip;
  myState.q = r.q.toArray();   // presence carries the socket's whole rotation: the reach gate turns my capsule by it (server/reachgate.ts)
  me.root.position.copy(r.pos);
  me.root.quaternion.copy(r.q);   // the socket's whole rotation: upright on a chair, on your back in a rocket
  // look locked: the view faces the way the seat does (the camera sits behind it)
  if (body.input.look === 'locked') setCamYaw(r.yaw + Math.PI);
  // the camera lives in updateMe, which is skipped while seated, so drive it here or it freezes on the frame you sat
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
  // the escape: X (or the stand tile) held, on a seat that otherwise lets you go only when the world does
  if ((keys.has('KeyX') || escapeTile) && !mayLeave(body, 'menu')) { escapeHeld += dt; if (escapeHeld >= ESCAPE_HOLD_S) { camera.up.set(0, 1, 0); dismountMe('escape'); } }
  else escapeHeld = 0;
}

const _sitV = new THREE.Vector3();
// a plain X offers only a seat you could climb onto (height counts); naming one (/sit <name>) still reaches any.
// One source with the authority's sit check: shared/sockbody.js OCCUPY_REACH.
const SEAT_RISE = { up: OCCUPY_REACH.up, down: OCCUPY_REACH.down };
/** Nearest declared seat: distance to the socket's world point, not the entity's origin (a ferry's helm can be a
 *  deck-length from the hull's centre). `arg` narrows to one entity by id prefix (case-insensitive). A taken seat is
 *  skipped; the seat I'm on doesn't count. */
function nearestSeat(arg, reach) {
  const want = arg ? String(arg).toLowerCase() : null;
  const mine = avatarMounts.get(CONFIG.name);
  const taken = new Set([...avatarMounts].filter(([id]) => id !== CONFIG.name).map(([, o]) => o.to));
  let best = null, bestD = reach;
  // every socket child in the world (a seat is a socket with a body block): its host is what you name and see
  for (const [sid, c] of bags()) {
    if (!c?.socket || typeof c.socket !== 'object' || c.disabled === true) continue;
    const body = bodyOf(c.station);
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

/** Sit on something: the nearest socket within arm's reach (or a named entity from anywhere). When nothing is in
 *  reach but a seat exists further out, say so. The authority is asked first (`use {id, action}`): it checks who
 *  may and answers with what the body does. Already seated, I may move straight to a socket that allows it (fromSeat). */
let sitTicket = 0;   // the latest sit ask; getting up (or asking again) makes every earlier answer stale
export function trySitOn(arg, slot = null) {
  const mine = avatarMounts.get(CONFIG.name);
  const best = nearestSeat(arg, arg ? Infinity : OCCUPY_REACH.r);
  if (best && slot && best.slot !== slot) { const o = socketsOn(best.id).find((x) => x.name === slot); const b = bodyOf(o?.station); if (b) Object.assign(best, { sock: o.id, slot, body: b }); }
  if (!best) {
    const far = arg ? null : nearestSeat(null, 30);
    if (far) logChat('*', `nearest seat is on ${called(far.id)} (${far.slot}), ${far.d.toFixed(0)}m away — get closer`);
    return false;
  }
  if (mine && !best.body.fromSeat) { logChat('*', `get up first — ${called(best.id)} (${best.slot}) doesn't take you straight from another seat`); return true; }
  const ticket = ++sitTicket;
  const take = () => {
    // only the latest ask may seat me, and only if I haven't sat, stood or asked again since: a late answer must
    // never put me back on a seat I already left
    if (ticket !== sitTicket || avatarMounts.get(CONFIG.name) !== mine) return;
    if (mine) releaseOccupied(getMe());
    setBodySeat(CONFIG.name, { to: best.sock });   // presence: my frames carry the seat, the socket's id (world.js)
    const lb = best.body.leaveBy;
    logChat('*', `you ${best.body.action} on ${called(best.id)} (${best.slot}) — ${lb === 'script' ? 'it lets you go when the world does (hold X to get up anyway)' : lb === 'menu' ? 'X to get up' : lb === 'jump' ? 'Space or X to get up' : 'X or move to get off'}`);
  };
  sendRequest('use', { id: best.sock, action: best.body.action }).then((r) => {
    if (r?.ok) take(); else logChat('*', plain(`${best.body.action} on ${best.id}`, r));   // a person's words (plainwords.js)
  });
  return true;
}

// While my camera is free of my body in edit mode, the body holds a working pose so people can see I've stepped
// out. It ends when the camera comes back; a pose held before is not restored. Arms forward and a little down,
// palms out, head bent.
const WORKING_POSE = { leftUpperArm: [0.0772, -0.5863, -0.1053, 0.7995], rightUpperArm: [0.0772, 0.5863, 0.1053, 0.7995], leftLowerArm: [0, -0.3007, 0, 0.9537], rightLowerArm: [0, 0.3007, 0, 0.9537],
  leftHand: [0, 0, 0.6428, 0.766], rightHand: [0, 0, -0.6428, 0.766], head: [0.0872, 0, 0, 0.9962] };
let working = false;
bus.on('edit-freecam', (on) => {
  const me = getMe(); if (!me) return;
  if (on && !working) { working = true; me.setPose(WORKING_POSE); myState.pose = WORKING_POSE; }
  else if (!on && working) { working = false; if (myState.pose === WORKING_POSE) { myState.pose = null; me.clearPose(); } }
});

// The hint bar's standing offer: a seat within reach, what I hold, what's in front of me to use. Checked ~2×/s.
let _hintAcc = 0;
// builder mode has its own keys (edit/build.js): the world's play offers ("X — sit") would advertise a delete key as
// a seat, so the bar carries the builder's hints there instead
let _building = false;
bus.on('build-mode', (on) => { _building = !!on; _hintAcc = 1; });
export function updateSeatHint(dt) {
  _hintAcc += dt;
  if (_hintAcc < 0.45) return;
  _hintAcc = 0;
  if (CONFIG.renderer || CONFIG.spectate) return;
  if (_building) { setAmbientHint(null); return; }
  let hint = null;
  if (avatarMounts.has(CONFIG.name)) { const b = occupiedBody();
    hint = !b || b.leaveBy === 'any' ? (b?.input.move !== 'none' && b ? html`<kbd>X</kbd> get up · <kbd>WASD</kbd> drive` : html`<kbd>X</kbd> get up · <kbd>WASD</kbd> hop off`)
      : b.leaveBy === 'script' ? html`this seat lets you go when the world does · hold <kbd>X</kbd> to get up anyway` : b.leaveBy === 'jump' ? html`<kbd>Space</kbd> or <kbd>X</kbd> get up` : html`<kbd>X</kbd> get up`; }
  else if (!downed && nearestSeat(null, OCCUPY_REACH.r)) hint = html`<kbd>X</kbd> — sit`;
  // my hands come first: what I hold and how to let go, else what's in reach to pick up
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
  // the camera lives in updateMe, which is skipped while limp: drive it here too
  if (me) updateFollowCamera(dt, me);
}

// ---------------------------------------------------------------- dragged
// Someone else's sim is driving my limp body (bodydrag.js holds the protocol; these are the hands it moves). My
// client stays the authority: it applies the stream to itself and rebroadcasts through normal presence.

function beginDraggedMode(by) {
  const me = getMe();
  if (!me) return;
  ragdoll?.dispose?.(); ragdoll = null;   // the dragger's sim owns the tumble now
  downed = true;
  me.setLimp(true, { bake: true });
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

// While a hand holds me, my body is a stream of poses with no sim behind it, so its velocity only exists as the
// difference between arriving frames. Sampled here so the sim can start with that motion when the hand lets go.
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
  // land on their final frame, then settle under my own sim from wherever the hand let go
  if (msg?.pose || msg?.p) applyDraggedSample(msg);
  me.root.updateMatrixWorld(true);
  // the hand's own sim state outranks anything we sampled from its stream
  ragdoll = makeRagdoll(me, null, me.restBonePositions(), msg?.sim ?? dragVel);
  dragSnap = null; dragVel = null;
  applyMyPins();
  myState.clip = 'ragdoll';
}

// ---------------------------------------------------------------- pins
// Nails through my body (bodydrag's persistent pins): my state, my sim enforcing them, streamed in my presence so
// everyone sees the markers. A dragger may place one (the release message carries it) or ask to pull one; my
// movement key tears them all out. Session-scoped: pins are presence, not history.
const myPins = new Map();            // joint -> [x, y, z]
const _pinV = new THREE.Vector3();
const MAX_PINS = 8;

function syncPins() {
  myState.pins = myPins.size ? [...myPins].map(([j, at]) => ({ j, at })) : null;
}
function applyMyPins() {
  if (!ragdoll) return;
  // everything in myPins is a nail, so it takes the nail's firm tuning, as the dragger's takeover sim does
  // (bodydrag.js): the same nail must hold the same on whichever machine simulates
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
  // freed of a nail while lying with no live sim (and nobody's hand on me): wake my own sim so the body settles
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

// the hard ceiling on any shove that arrives over the wire, in m/s: nobody launches a body across the map
const MAX_PUSH = 6;
const _shove = new THREE.Vector3();

/** Every external force on my body lands here (a directed push, a blast, an undirected knock-over). Standing → the
 *  sim starts with this lean; mid-tumble → the running sim takes it as an impulse; settled-but-down → a fresh sim
 *  starts from the lying pose. */
function applyShove(lean, by) {
  const me = getMe();
  if (!me) return;
  if (avatarMounts.has(CONFIG.name)) return;      // braced on a seat: a seat holds you through a knock
  if (beingDragged()) return;                     // a held body answers to the hand, not the blast
  if (lean && lean.lengthSq() > MAX_PUSH * MAX_PUSH) lean.setLength(MAX_PUSH);
  if (downed) {
    if (ragdoll) ragdoll.impulse(lean ?? toppleVelocity());
    else {
      // still limp from the last fall (getUp clears it): the new sim starts from the lying pose
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

  // my body's consent (two gates, two lists) as the authority takes it (consentsync.js: only what differs): every
  // arrival, every change; a refusal is a toast and a retry
  useWorld(CONFIG.world);
  const consentSync = makeConsentSync({ table: bodyTable, send: sendRequest, toast, on: (ev, fn) => bus.on(ev, fn), enabled: () => !(CONFIG.renderer || CONFIG.spectate), held: noteHeld, gone: forget, landed });
  onConsentChange(consentSync.sync);
  // an old "allow posing" setting couldn't carry into the wider one: said once, to a person, never a renderer (consent.js TOUCH_NOTICE)
  if (!(CONFIG.renderer || CONFIG.spectate)) { const told = takeNotice(); if (told) toast(told, 'info', 15000); }

  // X reaches the socket system through the controller's hook: mounted → get up; a declared seat in reach → mount
  // it; anything else falls through to the controller's own layers (geometry seats, then the ground sit)
  setMountedHook(() => avatarMounts.has(CONFIG.name));
  // someone else's edit moved the seat I sat on and the authority let me go (its `vacated` inbox message,
  // shared/protocol/authority.js): get off as when the world lets go
  bus.on('body-inbox', (msg) => {
    // only from the seat I'm on now: a late message never stands me up from a seat taken since
    const u = Array.isArray(msg?.messages) ? msg.messages.find((m) => m?.type === 'vacated') : null;
    if (u && vacatedFromMine(u, avatarMounts.get(CONFIG.name)) && dismountMe('script', vacatedAt(u))) toast(`${typeof u.by === 'string' ? u.by : 'someone'} moved what you were occupying, so you stood up`, 'info', 5000);
    // an act the authority delivered (an ask I said yes to) is applied as a puppet is
    const nameOf = (a) => (typeof a === 'string' ? ([...identities].find(([, id]) => id === a)?.[0] ?? a) : null);
    for (const m of Array.isArray(msg?.messages) ? msg.messages : []) {
      // someone tried, and my consent turned it away: said quietly, once per person per minute (the authority's TRIED_NOTE_MS)
      const said = refusedNotice(m, nameOf); if (said) { toast(said, 'info', 6000); continue; }
      const p = bodyActAsPuppet(m); if (!p) continue;
      applyPuppet({ by: nameOf(m.from) ?? 'someone', ...p });
    }
  });
  setOccupyHook(() => {
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

  bus.on('puppet', applyPuppet);
}

function applyPuppet({ by, pose, merge, anim, ragdoll: rag }) {
  // a ragdoll request runs the sim on my body: I own it, so I simulate and stream; the requester never simulates me.
  // The authority already decided (server/messages.ts puppet): what arrives applies.
  if (rag) {
    // rag is true (undirected: old wire, old clients) or {lean:[x,y,z]} m/s
    const l = Array.isArray(rag?.lean) && rag.lean.length === 3 && rag.lean.every(Number.isFinite)
      ? _shove.set(rag.lean[0], rag.lean[1], rag.lean[2]) : null;
    applyShove(l, by);
    return;
  }
  // merge: only the bones they sent (null releases one); otherwise their pose replaces mine whole, and an empty one
  // is a release
  if (pose) {
    myState.pose = merge ? mergePose(myState.pose, pose) : (Object.keys(pose).length ? pose : null);
    flashHint(myState.pose ? `${by} posed you` : `${by} released your pose`);
  }
  if (anim) {
    const data = { ...anim, replace: anim.replace !== false }; // legacy puppets replace
    if (data.replace) myState.pose = null;          // a replacing animation ends the held pose too
    getMe()?.playAnimation(data); sendAnim(data);
  }
}
