// My body in the world's physics — ragdoll, seats, being dragged, pins,
// shoves. Extracted from main.js (§14 6c). The invariant every section here
// shares: MY client owns MY body. Everything that happens to it — a tumble, a
// seat, someone's hand, a nail, a blast — is applied HERE and rebroadcast
// through ordinary presence, so nobody else ever needs code to simulate me.
//
// logChat arrives through initLocalBody rather than an import: chat.js sits
// in the world→flora→controller→chat→net→world knot, and this module must
// not add another edge into it (§14.2).

import { THREE } from './core.js';
import { CONFIG, bus } from './base.js';
import { radialForce, FORCE_MIN } from '../../shared/force.js';
import {
  myState, updateFollowCamera, setPosture, keys, setSeatHook,
} from './controller.js';
import { avatarMounts, mountTransform, comps, socketWorldPos } from './world.js';
import { sendVerb, sendAnim } from './net.js';
import { makeRagdoll } from './bodysim.js';
import { jointPositions } from './ragdoll.js';
import { initBodyDrag, beingDragged, revokeDragged } from './bodydrag.js';
import { toast, flashHint, setAmbientHint } from './ui.js';
import { posable, pushable } from './consent.js';
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
// transform + socket (same math remotes use for me) — so I visibly swing on
// the swing I'm sitting on. Movement input means "I want off": it emits a
// dismount with my landing spot stamped (the plane-transition invariant),
// and control returns to the normal ground controller.
const _seatP = new THREE.Vector3();
function dismountMe() {
  const sw = mountTransform(CONFIG.name, _seatP);
  const yaw = sw?.yaw ?? myState.yaw;
  const off = sw ? _seatP.clone() : myState.pos.clone();
  off.x += Math.sin(yaw) * 0.7;
  off.z += Math.cos(yaw) * 0.7;
  sendVerb('dismount', { id: CONFIG.name, pos: [off.x, 0, off.z], yaw });
  avatarMounts.delete(CONFIG.name);      // locally immediate; the echo confirms
  myState.pos.set(off.x, 0, off.z);
  setPosture('stand');
}
export function updateMountedMe(dt) {
  const sw = mountTransform(CONFIG.name, _seatP);
  if (!sw) return;                       // parent still downloading
  const me = getMe();
  myState.pos.copy(_seatP);
  myState.yaw = sw.yaw;
  myState.speed = 0;
  myState.clip = sw.pose;
  if (me) {
    me.root.position.copy(_seatP);
    me.root.rotation.y = sw.yaw;
    me.setClip(sw.pose, 0);
  }
  // The camera lives in updateMe, which we skip while seated — so drive it
  // here too (the ragdoll path learned this the same way), or it freezes on
  // the frame you sat down and never rides the seat (#75). First person keeps
  // its own-mesh exclusion; both modes follow the socket, moving or not.
  if (me) updateFollowCamera(dt, me);
  if (['KeyW', 'KeyA', 'KeyS', 'KeyD'].some((k) => keys.has(k))) dismountMe();
}

/** Nearest declared seat: distance to the SOCKET's world point, not the
 *  entity's origin — a swing's pivot frame is not where you sit, and on a
 *  ferry the helm can be a deck-length from the hull's center. Every slot
 *  competes, not just the first. `arg` narrows to one entity by id prefix
 *  (case-insensitive), so `/sit 34` reaches 3485c78e without the full hash. */
const _sitV = new THREE.Vector3();
function nearestSeat(arg, reach) {
  const want = arg ? String(arg).toLowerCase() : null;
  let best = null, bestD = reach;
  for (const [id, bag] of comps) {
    if (!bag.sockets) continue;
    if (want && !id.toLowerCase().startsWith(want)) continue;
    for (const slot of Object.keys(bag.sockets)) {
      const p = socketWorldPos(id, slot, _sitV);
      if (!p) continue;
      const d = Math.hypot(p.x - myState.pos.x, p.z - myState.pos.z);
      if (d < bestD) { bestD = d; best = { id, slot, d }; }
    }
  }
  return best;
}

/** Sit ON something: nearest socket within arm's reach (or a named entity
 *  from anywhere). When nothing is in reach but a seat exists further out,
 *  SAY so — the silent ground-sit fallback read as "sitting is broken" to
 *  anyone standing four meters from a swing they could name but not see. */
export function trySitOn(arg) {
  const best = nearestSeat(arg, arg ? Infinity : 3.5);
  if (!best) {
    const far = arg ? null : nearestSeat(null, 30);
    if (far) logChat('*', `nearest seat is ${far.id} (${far.slot}), ${far.d.toFixed(0)}m away — walk closer, or /sit ${far.id}`);
    return false;
  }
  sendVerb('mount', { id: CONFIG.name, to: best.id, slot: best.slot });
  logChat('*', `you sit on ${best.id} (${best.slot}) — X or move to get off`);
  return true;
}

// The world's standing offer, kept current at a walk: when a declared seat
// is within reach the hint bar says so — an affordance nobody can discover
// is indistinguishable from one that doesn't exist. Checked ~2×/s.
let _hintAcc = 0;
export function updateSeatHint(dt) {
  _hintAcc += dt;
  if (_hintAcc < 0.45) return;
  _hintAcc = 0;
  if (CONFIG.renderer || CONFIG.spectate) return;
  let hint = null;
  if (avatarMounts.has(CONFIG.name)) hint = '<kbd>X</kbd> get up · <kbd>WASD</kbd> hop off';
  else if (!downed && nearestSeat(null, 3.5)) hint = '<kbd>X</kbd> — sit';
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
  if (Number.isFinite(yaw)) { me.root.rotation.y = yaw; myState.yaw = yaw; }
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
  if (avatarMounts.has(CONFIG.name)) return;      // braced on a seat — v1 punts on knock-offs
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

  // X reaches the socket system through the controller's hook: mounted → get
  // up; a declared seat in reach → mount it; anything else falls through to
  // the controller's own layers (geometry seat pans, then the ground sit).
  setSeatHook(() => {
    if (avatarMounts.has(CONFIG.name)) { dismountMe(); return true; }
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

  bus.on('puppet', ({ by, pose, anim, ragdoll: rag }) => {
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
    if (pose) { myState.pose = pose; flashHint(`${by} posed you`); }
    if (anim) { getMe()?.playAnimation(anim); sendAnim(anim); }
  });

  // A force verb reaching us live: an instantaneous radial CAUSE (blast, gust).
  // It folded to nothing — replays and late joiners never re-detonate — and its
  // only effect on my body happens here, gated by the same consent as a push.
  // Linear falloff to the rim; at ground zero direction is meaningless, so you
  // topple the way you were already leaning.
  bus.on('force', ({ actor, at, radius, power }) => {
    if (!getMe() || !pushable()) return;
    // §24l R1: the falloff arithmetic is shared/force.js — one truth with
    // the agent's copy. Consent and the ground-zero direction stay here.
    const f = radialForce(at, myState.pos.x, myState.pos.z, radius, power);
    if (!f) return;
    if (f.mag < FORCE_MIN && !ragdoll) return;     // a breeze, not a blow
    const lean = f.nx != null
      ? _shove.set(f.nx * f.mag, 0, f.nz * f.mag)
      : toppleVelocity().setLength(Math.max(f.mag, 0.5));
    applyShove(lean, actor);
  });
}
