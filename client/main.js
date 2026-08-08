// eidoverse-worlds browser client.
//
// Two planes: the world log (verbs, ordered, replayed on join) and presence
// (intent state at ~15Hz, interpolated). The client owns its own avatar; the
// server sequences and relays. This file is boot and the frame loop — every
// system lives in lib/.

import {
  THREE, scene, camera, renderer, sun, canvas, CONFIG, BASE_PIXEL_RATIO,
  bus, report, setName,
} from './lib/core.js';
import { contributeThumbnail, makeAvatar, EMOTE_ORDER, EMOTES } from './lib/avatar.js';
import { updateSky, updateAutoSystems, skyArgs, skyImpl,
  CLOUD_QUALITY, getCloudQuality, setCloudQuality } from './lib/sky.js';
import { setSkyArgsSource, entities, liveEntities, buildsPending, roleOf, worldHasOwner, comps, avatarMounts, mountTransform, socketWorldPos } from './lib/world.js';
import { hasGrass, setGrassDensity, getGrassDensity } from './lib/terrain.js';
// side-effecting: the `particles` component's host wires itself to the comp
// and entity buses on import (it has no boot step of its own)
import { emitterCount, emitterQuality, setEmitterQuality } from './lib/emitters.js';
import { tickMotion } from './lib/motion.js';
import {
  myState, updateMe, updateFollowCamera, updateSpectator, setCamYaw, setPosture,
  togglePhotoMode, setCameraCollisionTargets, keys, setSeatHook,
} from './lib/controller.js';
import {
  remotes, updateRemotes, updateGaze, noteSpeaking, setLodBias,
} from './lib/remotes.js';
import { net, connect, initIdentity, loginUrl, wireNet, sendVerb, sendPose, sendPuppet, sendWhisper, sendTyping, sendWorldFork, sendWorldReset, sendMod, requestDebug } from './lib/net.js';
import {
  initPalette, updateBuild, wireAvatarSwitch, setMyAvatarPath, toggleBuildMenu,
  hasGhost, hasSelection, toggleEditMode, isEditing,
} from './lib/build.js';
import { initConjure } from './lib/conjure.js';
import { initVoice, micOn, isMuted, micAnalyserLevel, peerLevels } from './lib/voice.js';
import './lib/mictoggle.js'; // mic + headphone toggles beside the HUD, both off by default
import { initAudioPanel } from './lib/audiopanel.js';
import { initSceneGraph, sceneAttach, sceneDetach } from './lib/scenegraph.js';
import {
  toast, setHud, setHint, setAmbientHint, flashHint, buildHelp, toggleHelp,
  openDoor, toggleRoster, initRoster, initDock, paintRoster, panelFrame, el,
} from './lib/ui.js';
import { initDebug, updateDebug, toggleDebug } from './lib/debug.js';
import { dragSim } from './lib/bodydrag.js';
import { initChat, logChat, chat, openConvo } from './lib/chat.js';
import { makeFrame } from './lib/frames.js';
import { jointPositions } from './lib/ragdoll.js';
import { makeRagdoll, bodyEngine, setBodyEngine } from './lib/bodysim.js';
import { initBodyDrag, updateBodyDrag, beingDragged, revokeDragged, dragState } from './lib/bodydrag.js';
import { initPhysObj, tickPhysObj, kick, leaseApi } from './lib/physobj.js';
import { initMods, tickMods, modsApi } from './lib/mods.js';
import { shedALight, litCount } from './lib/lights.js';
import { initBoot, markPhase, finishBoot, bootDone } from './lib/boot.js';
import { framesHeld } from './lib/loadwork.js';
import { startPrefetch } from './lib/prefetch.js';

// ---- crash breadcrumbs (?bc=1): streamed over a BroadcastChannel so a
// SECOND same-origin tab can hold them in its own memory — the only place
// that reliably outlives a renderer crash (localStorage writes from a dying
// renderer turn out to be discardable). Dev-only diagnostics.
let _bcN = 0;
const BC = new URLSearchParams(location.search).has('bc')
  ? (tag) => {
    // over the live world socket: the server rings the last 40 per client and
    // prints them when the socket dies — the only observer a renderer crash
    // cannot take down with it (same-origin tabs share the renderer process,
    // and localStorage writes from a dying renderer are discardable).
    try { net.ws?.readyState === 1 && net.ws.send(JSON.stringify({ type: 'bc', tag: `${++_bcN} ${tag}` })); } catch { /* dying */ }
  }
  : () => {};
globalThis.__ewBC = BC;

// ---------------------------------------------------------------- identity

const roster = await fetch('/avatars').then((r) => r.json()).catch(() => []);
const want = CONFIG.params.get('avatar') || localStorage.getItem('ew-avatar-name') || 'claude';
let myAvatarPath = want.includes('/')
  ? want
  : (roster.find((a) => a.name === want)?.path ?? 'eidoverse/assets/vrms/claude.vrm');
let myAvatarName = want.includes('/') ? want.split('/').pop().replace(/\.vrm.*$/, '') : want;
setMyAvatarPath(myAvatarPath);

let me = null;
const isViewer = CONFIG.spectate || CONFIG.renderer;

// ---------------------------------------------------------------- minting
// ?mintthumbs — render a portrait for every body on the roster and post them
// back, then stop. Contribution-as-you-wear keeps the roster fresh, but it
// cannot SEED it: a first visitor met one portrait and seventeen blank cards.
// This is the one-time (and after-adding-VRMs) pass that gives it a baseline.

if (CONFIG.params.has('mintthumbs')) {
  const { loadVRM } = await import('./lib/assets.js');
  const list = await fetch('/avatars').then((r) => r.json());
  const out = [];
  for (const a of list) {
    try {
      const vrm = await loadVRM(a.path);
      await contributeThumbnail(a.name, vrm, CONFIG.token, { force: true });
      out.push(`ok ${a.name}`);
    } catch (e) { out.push(`FAIL ${a.name}: ${e.message}`); }
    console.log(`[mint] ${out[out.length - 1]}  (${out.length}/${list.length})`);
  }
  console.log(`[mint] done ${out.filter((s) => s.startsWith('ok')).length}/${list.length}`);
  globalThis.__mintDone = out;
} else {

// ---------------------------------------------------------------- lighting
// No shadows at all meant everything floated: objects had no contact with the
// ground and a jump had no readable height. One cascade off the sun plus the
// per-avatar blob shadows is the biggest visual-quality-per-line change here.

renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.near = 1;
sun.shadow.camera.far = 160;
const S = 46;
Object.assign(sun.shadow.camera, { left: -S, right: S, top: S, bottom: -S });
sun.shadow.bias = -0.0006;
sun.shadow.normalBias = 0.02;
sun.shadow.camera.updateProjectionMatrix();

setSkyArgsSource(skyArgs);
setCameraCollisionTargets(liveEntities);

// ---------------------------------------------------------------- boot

initBoot({ world: CONFIG.world, name: CONFIG.name });
buildHelp();
initChat({
  send: (text) => sendVerb('say', { text }),
  whisper: sendWhisper,
  typing: (to) => { sendTyping(to); me?.setTyping(); },
  people,
});
initRoster(people);
initEmoteBar();
initDock([
  { id: 'chat', label: '💬' },
  { id: 'world', label: '🧱' },
  { id: 'who', label: '👥' },
  { id: 'emotes', label: '👋' },
  { id: 'debug', label: '🐞' },
]);
initDebug({
  // the body in your HAND wins over your own — that is the one being worked on
  ragdoll: () => dragSim() ?? ragdoll,
  downed: () => !!dragSim() || downed,
  dragging: () => !!dragSim(),
  fps: () => fps,
  // drop again from where you stand, so a shape can be reproduced back to back
  reLimp: () => { if (downed) getUp(); goLimp(); },
});

// Verified identity resolves BEFORE anything reads CONFIG.name — otherwise the
// door panel and the local nameplate greet a stale localStorage name while the
// server (correctly) calls this person by their Discord name.
await initIdentity();

if (isViewer) {
  panelFrame().hide();
  markPhase('body', 1);
  start();
} else {
  // The front door: ask once for a name and a body, remember, never ask again.
  // A person handed a bare link used to become `guest-a1b2` in the default body
  // with no way to change either and no idea what the keys were.
  const firstRun = !CONFIG.params.has('name') && localStorage.getItem('ew-name-set') !== '1';
  if (firstRun) {
    openDoor({
      roster,
      needsKey: CONFIG.params.has('needkey'),
      login: loginUrl(),
      onEnter: ({ avatar, avatarName }) => {
        if (avatar) { myAvatarPath = avatar; myAvatarName = avatarName; setMyAvatarPath(avatar); }
        start();
      },
    });
  } else start();
}

// A rejected door key re-opens the door with a key field instead of retrying
// into a wall forever.
bus.on('bad-key', () => {
  toast('that door key was refused', 'err', 20000);
  openDoor({
    roster, needsKey: true, login: loginUrl(),
    onEnter: ({ avatar, avatarName }) => {
      if (avatar) { myAvatarPath = avatar; myAvatarName = avatarName; setMyAvatarPath(avatar); }
      connect();
    },
  });
});

function start() {
  connect();
  initPalette();
  initConjure();   // the orrery panel — prompt → your pick of images → mesh → world
  initVoice(CONFIG.name);
  initAudioPanel();   // 🔊 categories: voices / world / TTS + consent rows
  initSceneGraph();   // 🌳 the world as a tree + 📜 the scripts that animate it
  setHint('<kbd>WASD</kbd> move · <kbd>Enter</kbd> chat · <kbd>B</kbd> build · <kbd>?</kbd> help');

  if (!isViewer) {
    makeAvatar(CONFIG.name, myAvatarPath, { urgent: true }) // your body skips the load queue
      .then((av) => {
        me = av;
        markPhase('body', 1);
        // Contribute a portrait of this body so the next person picks from
        // faces instead of filenames. Deferred — it costs an offscreen render,
        // and the first seconds belong to getting the person into the world.
        setTimeout(() => contributeThumbnail(myAvatarName, av.vrm, CONFIG.token), 4000);
      })
      .catch((e) => { markPhase('body', 1); report('avatar', e); });
  }
}

wireNet({
  myAvatarPath: () => myAvatarPath,
  myState,
  me: () => me,
  onRestore: (r) => {
    myState.pos.set(r.p[0], r.p[1] ?? 0, r.p[2]);
    myState.yaw = r.yaw ?? 0;
    setCamYaw(myState.yaw + Math.PI); // camera behind you, facing your way
    if (r.clip === 'sit' || r.clip === 'sitchair' || r.clip === 'lie') {
      setPosture(r.clip === 'lie' ? 'lie' : 'sit');
    }
    // an enacted pose is authored content — wake holding it, like the spot
    // you stood on. It rides the next presence packet, so everyone sees it.
    // EXCEPT a remembered ragdoll frame (pre-sanitizer entries): that is
    // wreckage, not authorship — wake standing instead of hung mid-tumble.
    if (r.clip === 'ragdoll') { myState.pos.y = 0; return; }
    if (r.pose) myState.pose = r.pose;
  },
  onSnapshotDone: () => {},
});

// ---------------------------------------------------------------- avatar swap

wireAvatarSwitch(async (path, name) => {
  if (path === myAvatarPath) return;
  toast(`changing into ${name}…`, 'info', 3000);
  try {
    const next = await makeAvatar(CONFIG.name, path, { urgent: true }); // build before shedding the old
    me?.dispose();
    me = next;
    myAvatarPath = path;
    myAvatarName = name;
    setMyAvatarPath(path);
    localStorage.setItem('ew-avatar-name', name);
    contributeThumbnail(name, next.vrm, CONFIG.token);
    if (net.joined) {
      // re-announce: everyone rebuilds my remote with the new body
      const { sendJoin } = await import('./lib/net.js');
      sendJoin();
    }
  } catch (e) { report(`avatar switch ${name}`, e); }
});

bus.on('sky-degraded', ({ msg }) => toast(msg, 'warn', 12000));

bus.on('avatar-updated', ({ path, name, fresh }) => {
  if (myAvatarPath.split('?')[0] === path) {
    toast(`your body "${name}" was updated — refreshing`, 'info');
    myAvatarPath = fresh;
    makeAvatar(CONFIG.name, fresh, { urgent: true }).then((av) => { me?.dispose(); me = av; }).catch((e) => report('reload avatar', e));
  }
});

// ---------------------------------------------------------------- speech

// Ragdoll — owner-simulated, presence-streamed, captured to a held pose.
//
// Only this client simulates its own body; the result rides the pose field
// like any other pose, so remotes need no ragdoll code at all. On settle the
// final bones stay as a held pose (lastPose), so a reconnect or a late joiner
// gets the settled RESULT, not a replay of the flop.
let ragdoll = null;
let downed = false;

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

function goLimp(lean = null) {
  if (!me || downed) return;
  downed = true;
  // Park the undriven bones and stop the clip BEFORE constructing the sim.
  // Both of the sim's reference skeletons are read in here — the neutral rest
  // it measures its limits against, and the live pose the tumble starts from —
  // and neither may still have the walk cycle in it.
  me.setLimp(true);
  ragdoll = makeRagdoll(me, lean ?? toppleVelocity(), me.restBonePositions());
  myState.clip = 'ragdoll';
  flashHint('limp — move to get up');
}
function getUp() {
  if (!downed) return;
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
function updateMountedMe() {
  const sw = mountTransform(CONFIG.name, _seatP);
  if (!sw) return;                       // parent still downloading
  myState.pos.copy(_seatP);
  myState.yaw = sw.yaw;
  myState.speed = 0;
  myState.clip = sw.pose;
  if (me) {
    me.root.position.copy(_seatP);
    me.root.rotation.y = sw.yaw;
    me.setClip(sw.pose, 0);
  }
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
function trySitOn(arg) {
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

// X reaches the socket system through the controller's hook: mounted → get
// up; a declared seat in reach → mount it; anything else falls through to
// the controller's own layers (geometry seat pans, then the ground sit).
setSeatHook(() => {
  if (avatarMounts.has(CONFIG.name)) { dismountMe(); return true; }
  if (downed) return false;
  return trySitOn(null);
});

// The world's standing offer, kept current at a walk: when a declared seat
// is within reach the hint bar says so — an affordance nobody can discover
// is indistinguishable from one that doesn't exist. Checked ~2×/s.
let _hintAcc = 0;
function updateSeatHint(dt) {
  _hintAcc += dt;
  if (_hintAcc < 0.45) return;
  _hintAcc = 0;
  if (CONFIG.renderer || CONFIG.spectate) return;
  let hint = null;
  if (avatarMounts.has(CONFIG.name)) hint = '<kbd>X</kbd> get up · <kbd>WASD</kbd> hop off';
  else if (!downed && nearestSeat(null, 3.5)) hint = '<kbd>X</kbd> — sit';
  setAmbientHint(hint);
}

function stepRagdoll(dt) {
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
  if (!me) return;
  ragdoll?.dispose?.(); ragdoll = null;   // the dragger's sim owns the tumble now
  downed = true;
  me.setLimp(true);
  myState.clip = 'ragdoll';
  flashHint(`${by} grabs you — move to break free`);
}

function applyDraggedSample({ pose, p, yaw }) {
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
  for (const [j, at] of myPins) ragdoll.setPin(j, _pinV.set(at[0], at[1], at[2]));
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

initPhysObj({ myPos: () => myState.pos });
initMods();   // 🧩 runtime client scripts: local trusted mods + world offers

initBodyDrag({
  pushable: () => pushable,
  isDowned: () => downed,
  myPos: () => myState.pos,
  beginDragged: beginDraggedMode,
  applyDragged: applyDraggedSample,
  endDragged: endDraggedMode,
  getPins: () => [...myPins].map(([j, at]) => ({ j, at })),
  addPin,
  removePin,
});

// Being posed by someone else.
//
// A puppet is an input to MY body, applied by MY client — never a pose forced
// on me from outside. So it goes through the same presence path as my own
// movement: a pose becomes my held pose (and broadcasts), an animation I play
// and re-send as mine. Humans opt in (a director staging a scene is welcome; a
// stranger yanking your limbs is not); agents accept by default, since being
// directed is the point of a performer.
let posable = localStorage.getItem('ew-posable') === '1';
function setPosable(v) { posable = v; localStorage.setItem('ew-posable', v ? '1' : '0'); }

// Being SHOVED is a separate consent from being POSED. Posing is directorial —
// someone else deciding what your body expresses — and stays opt-in. A shove
// is the world's rough-and-tumble: it moves you without speaking for you, so
// it defaults ON (the first one tells you how to refuse). Both are still only
// requests: my client applies them to my body, or doesn't.
let pushable = localStorage.getItem('ew-pushable') !== '0';
function setPushable(v) { pushable = v; localStorage.setItem('ew-pushable', v ? '1' : '0'); }

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

bus.on('puppet', ({ by, pose, anim, ragdoll: rag }) => {
  // A ragdoll request runs the sim on MY body — I own it, so I simulate and
  // stream. That is the sync guarantee: the requester never simulates me.
  if (rag) {
    if (!pushable) {
      toast(`${by} tried to knock you over — /pushable on to allow`, 'warn', 6000);
      return;
    }
    // rag is true (undirected — old wire, old clients) or {lean:[x,y,z]} m/s
    const l = Array.isArray(rag?.lean) && rag.lean.length === 3 && rag.lean.every(Number.isFinite)
      ? _shove.set(rag.lean[0], rag.lean[1], rag.lean[2]) : null;
    applyShove(l, by);
    return;
  }
  if (!posable) {
    toast(`${by} tried to pose you — enable it in settings to allow`, 'warn', 6000);
    return;
  }
  if (pose) { myState.pose = pose; flashHint(`${by} posed you`); }
  if (anim) { me?.playAnimation(anim); sendAnim(anim); }
});

// A force verb reaching us live: an instantaneous radial CAUSE (blast, gust).
// It folded to nothing — replays and late joiners never re-detonate — and its
// only effect on my body happens here, gated by the same consent as a push.
// Linear falloff to the rim; at ground zero direction is meaningless, so you
// topple the way you were already leaning.
bus.on('force', ({ actor, at, radius = 4, power = 3 }) => {
  if (!me || !pushable) return;
  if (!Array.isArray(at) || at.length !== 3) return;
  const dx = myState.pos.x - at[0], dz = myState.pos.z - at[2];
  const d = Math.hypot(dx, dz);
  if (d > radius) return;
  const mag = Math.min(MAX_PUSH, power * (1 - d / Math.max(radius, 0.001)));
  if (mag < 0.3 && !ragdoll) return;             // a breeze, not a blow
  const lean = d > 0.05
    ? _shove.set((dx / d) * mag, 0, (dz / d) * mag)
    : toppleVelocity().setLength(Math.max(mag, 0.5));
  applyShove(lean, actor);
});

// ---- live voice as presence (R, 23:30) --------------------------------------
// The same two-plane split we built for the agent voice, pointed at humans:
// the SOUND is already live over the mesh (zero latency, no waiting on
// transcription), so the visible half must be live too — mouth driven by real
// amplitude, 🎙 glyph while the mic is hot. STT stays on the LOG plane, landing
// afterward as an ordinary say. Nobody waits for words to know you're talking.
const VOICE_GATE = 0.045;        // below this is room tone, not speech
let _micGlyphOn = false, _micGlyphAt = 0, _micTail = 0;

function updateVoiceMouths(now) {
  // mine: local analyser, no round trip
  if (me) {
    const live = micOn() && !isMuted();
    me.voiceLevel = live ? micAnalyserLevel() : null;
    // 🎙 means SOUND IS COMING OUT OF ME, not "my mic is plugged in" (R,
    // 23:38: "it's not just if the mic is capturing my voice activity, it's
    // if the mic is simply ON"). An always-on badge is furniture — it stops
    // carrying information the second everyone wears one. So it tracks
    // actual speech, with a short tail so ordinary pauses between words
    // don't strobe it.
    const speaking = live && me.voiceLevel > VOICE_GATE;
    if (speaking) _micTail = now + 900;
    const show = now < _micTail;
    if (show !== _micGlyphOn || (show && now - _micGlyphAt > 1500)) {
      _micGlyphOn = show; _micGlyphAt = now;
      sendTyping(null, show ? 'mic' : null);
      me.setTyping(show ? 'mic' : null);
    }
    if (speaking) me.speakUntil = now + 400;   // keeps head/gaze life going
  }
  // theirs: one analyser per inbound stream
  const levels = peerLevels();
  for (const [id, r] of remotes) {
    const lv = levels.get(id);
    if (r.avatar) r.avatar.voiceLevel = lv == null ? null : lv;
    if (lv != null && lv > VOICE_GATE) noteSpeaking(id, 600);
  }
}

// Two-plane speech, timer-free (R, 16:09): captions are the live performance
// (bubble + mouth, paced to the voice); the logged say carries spoken:true
// and world.js never re-performs it. No dedup windows, no content matching —
// the message itself says which plane it belongs to.
bus.on('caption', ({ actor, text }) => {
  const av = actor === CONFIG.name ? me : remotes.get(actor)?.avatar;
  av?.say(text);
  if (actor !== CONFIG.name) noteSpeaking(actor, Math.min(12000, 3000 + text.length * 30));
});

bus.on('speech', ({ actor, text }) => {
  const av = actor === CONFIG.name ? me : remotes.get(actor)?.avatar;
  av?.say(text);
  if (actor !== CONFIG.name) noteSpeaking(actor, Math.min(12000, 3000 + text.length * 30));
});

// ---------------------------------------------------------------- keys

bus.on('key', (e) => {
  if (e.code === 'Slash' && e.shiftKey) { toggleHelp(); return; }
  if (e.code === 'KeyH' && !isEditing()) { toggleHelp(); return; }
  if (e.code === 'Tab') { e.preventDefault(); toggleRoster(); return; }
  if (e.code === 'KeyB') { toggleEditMode(); return; }
  if (e.code === 'KeyP') { togglePhotoMode(); return; }
  if (e.code === 'F1') { e.preventDefault(); document.body.classList.toggle('photo'); return; }
  if (e.code === 'F2') { e.preventDefault(); saveScreenshot(); return; }
  if (e.code === 'F3') { e.preventDefault(); toggleDebug(); return; }
  if (e.code === 'KeyR' && !isEditing()) { downed ? getUp() : goLimp(); return; }
  // any movement stands you back up
  if (downed && ['KeyW','KeyA','KeyS','KeyD','ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Space'].includes(e.code)) getUp();
  // emotes on the number row — the world is a performance space and there was
  // no way to wave at anyone
  const n = /^Digit([1-6])$/.exec(e.code);
  if (n && me) {
    const name = EMOTE_ORDER[Number(n[1]) - 1];
    me.playEmote(name);
    myState.emote = name;
    flashHint(name);
  }
});

function people() {
  const list = [{ id: CONFIG.name, me: true, dist: null }];
  for (const r of remotes.values()) {
    list.push({
      id: r.id, me: false, agent: !!r.agent,
      dist: r.avatar ? r.avatar.root.position.distanceTo(myState.pos) : null,
    });
  }
  return list;
}
// ---------------------------------------------------------------- /commands

bus.on('your-rights', (r) => {
  // only worth a line when the world actually restricts — open worlds stay silent
  if (!r.open && r.role !== 'owner') {
    logChat('*', `this world has an owner — you are a ${r.role}${r.gen ? ' +gen' : ''} here`);
  }
});

bus.on('command', ({ cmd, arg }) => {
  if (cmd === 'help') return toggleHelp();
  if (cmd === 'role') {
    const who = (arg || '').trim() || CONFIG.name;
    if (who === CONFIG.name && !worldHasOwner() && net.myRights?.open !== false) {
      return logChat('*', 'this world is open — everyone here can build');
    }
    const r = who === CONFIG.name ? (roleOf(who) ?? net.myRights) : roleOf(who);
    if (!r) return logChat('*', `${who} holds no role here (visitor)`);
    return logChat('*', `${who}: ${r.role}${r.gen ? ' +gen' : ''}`);
  }
  if (cmd === 'grant') {
    // /grant <name> owner|builder|visitor [+gen|-gen] — server enforces owner-only
    const parts = (arg || '').trim().split(/\s+/).filter(Boolean);
    const id = parts[0];
    const role = parts.find((p) => ['owner', 'builder', 'visitor'].includes(p.toLowerCase()))?.toLowerCase();
    const genFlag = parts.find((p) => p === '+gen' || p === '-gen');
    if (!id || (!role && !genFlag)) {
      return logChat('*', 'usage: /grant <name> owner|builder|visitor [+gen|-gen]');
    }
    sendVerb('grant', { id, ...(role ? { role } : {}), ...(genFlag ? { gen: genFlag === '+gen' } : {}) });
    return;
  }
  if (cmd === 'kick') {
    // one word, two acts (the /push pattern): a THING within the world gets
    // the physics kick; a PERSON gets moderation. Things win the lookup —
    // and /punt is always the physics verb, /ban always the moderation one.
    const first = (arg || '').trim().split(/\s+/)[0];
    if (!first || entities.has(first) || !remotes.has(first)) { kick(arg); return; }
    // falls through into moderation below (a person's name)
  }
  if (cmd === 'punt') { kick(arg); return; }
  if (cmd === 'kick' || cmd === 'ban') {
    // /kick /ban <name> [reason…] — owner-only, the server enforces (and
    // narrates the act into chat via the log entry it broadcasts back).
    const [id, ...rest] = (arg || '').trim().split(/\s+/).filter(Boolean);
    if (!id) return logChat('*', `usage: /${cmd} <name> [reason] — ${cmd === 'kick' ? 'they can rejoin; /ban keeps them out' : 'a kick that sticks — /unban lifts it'}`);
    sendVerb(cmd, { id, ...(rest.length ? { reason: rest.join(' ') } : {}) });
    return;
  }
  if (cmd === 'unban') {
    const id = (arg || '').trim();
    if (!id) return logChat('*', 'usage: /unban <name>');
    sendVerb('unban', { id });
    return;
  }
  if (cmd === 'bans') return sendMod('world-bans');
  if (cmd === 'gban' || cmd === 'gunban') {
    // global moderation — WORLD_ADMIN only, the server enforces
    const [id, ...rest] = (arg || '').trim().split(/\s+/).filter(Boolean);
    if (!id) return logChat('*', `usage: /${cmd} <name>${cmd === 'gban' ? ' [reason] — bans from every world on this server' : ''}`);
    sendMod(cmd === 'gban' ? 'global-ban' : 'global-unban', { id, ...(rest.length ? { reason: rest.join(' ') } : {}) });
    return;
  }
  if (cmd === 'gbans') return sendMod('global-bans');
  if (cmd === 'push') {
    // /push [name] [power] — a REQUEST to the target's client, which owns the
    // body and decides (pushable). Range-gated here out of honesty, not
    // security: a shove is an arm's reach, and the receiver caps magnitude
    // anyway. No name = the nearest person within reach.
    const REACH = 2.5;
    const parts = (arg || '').trim().split(/\s+/).filter(Boolean);
    const named = parts.find((p) => !/^[\d.]+$/.test(p));
    // one word, two acts: /push swing1 is the swing's use-reaction (the old
    // alias, kept working), /push bob is a shove. Things win the name lookup
    // because they were here first; /shove is always the person verb.
    if (named && entities.has(named)) { sendVerb('use', { id: named, action: 'push' }); return; }
    const pow = Math.min(4, Math.max(0.5, parseFloat(parts.find((p) => /^[\d.]+$/.test(p))) || 2.2));
    let target = named ?? null;
    if (!target) {
      let bestD = REACH;
      for (const [id, r] of remotes) {
        if (!r.avatar) continue;
        const d = Math.hypot(r.avatar.root.position.x - myState.pos.x, r.avatar.root.position.z - myState.pos.z);
        if (d < bestD) { bestD = d; target = id; }
      }
      if (!target) return logChat('*', 'nobody within reach to push');
    }
    const r = remotes.get(target);
    if (!r?.avatar) return logChat('*', `${target} isn't here to push`);
    const tp = r.avatar.root.position;
    const d = Math.hypot(tp.x - myState.pos.x, tp.z - myState.pos.z);
    if (d > REACH) return logChat('*', `${target} is too far away to push (${d.toFixed(1)}m)`);
    // straight through the target from where I stand; face-to-face at zero
    // distance falls back to the way I'm facing
    const nx = d > 0.05 ? (tp.x - myState.pos.x) / d : Math.sin(myState.yaw);
    const nz = d > 0.05 ? (tp.z - myState.pos.z) / d : Math.cos(myState.yaw);
    sendPuppet(target, { ragdoll: { lean: [nx * pow, 0, nz * pow] } });
    logChat('*', `you push ${target}`);
    return;
  }
  if (cmd === 'pushable') {
    const v = (arg || '').trim().toLowerCase();
    if (v === 'on' || v === 'off') setPushable(v === 'on');
    return logChat('*', `shoves and blasts ${pushable ? 'CAN' : 'can NOT'} knock you over${v ? '' : ' — /pushable on|off to change'}`);
  }
  if (cmd === 'boom') {
    // /boom [power] [radius] — an instantaneous force verb at my feet. The
    // server gates it at builder rank and bounds the numbers; every pushable
    // body in radius (mine included — standing at your own blast is on you)
    // applies its own shove.
    const nums = (arg || '').trim().split(/\s+/).map(parseFloat).filter(Number.isFinite);
    sendVerb('force', {
      at: [myState.pos.x, myState.pos.y, myState.pos.z],
      ...(nums[0] ? { power: nums[0] } : {}),
      ...(nums[1] ? { radius: nums[1] } : {}),
    });
    return;
  }
  if (cmd === 'fork') {
    // /fork <new-name> — copy this world, all history included (owner-only,
    // the server enforces). The reply arrives as a world-forked message.
    const to = (arg || '').trim();
    if (!to) return logChat('*', 'usage: /fork <new-name> — copies this world into a new one');
    if (!/^[a-z0-9_-]{1,64}$/i.test(to)) return logChat('*', `"${to}" won't do as a world name — letters, digits, - and _ only`);
    sendWorldFork(to);
    return;
  }
  if (cmd === 'reset') {
    // /reset alone only tells you what it would do; erasing a world takes
    // typing its own name back. The server checks the same confirmation.
    const confirm = (arg || '').trim();
    if (confirm !== CONFIG.world) {
      return logChat('*', `this erases "${CONFIG.world}" back to zero — everything built and said here goes to the archive. `
        + `if you mean it: /reset ${CONFIG.world}`);
    }
    sendWorldReset();
    return;
  }
  if (cmd === 'debug') {
    // /debug [n] — why things bounced: denials, rejections, rate limits,
    // reaction outcomes. The log says what happened; this says why it didn't.
    const n = Math.min(50, Math.max(1, parseInt(arg, 10) || 12));
    requestDebug({ limit: n }).then(({ events }) => {
      if (!events?.length) return logChat('*', 'flight recorder is empty — nothing has bounced recently');
      for (const { ts, kind, ...rest } of events) {
        const t = new Date(ts).toTimeString().slice(0, 8);
        logChat('*', `${t} [${kind}] ${Object.entries(rest).map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`).join(' ')}`);
      }
    });
    return;
  }
  if (cmd === 'mount') {
    // /mount <thing> <onto> [slot] — glue where it stands, or seat in a socket
    const [child, parent, slot] = (arg || '').trim().split(/\s+/);
    if (!child || !parent) return logChat('*', 'usage: /mount <thing> <onto> [slot] — parents one thing to another, keeping its pose');
    if (!entities.get(child) || !entities.get(parent)) return logChat('*', 'both things must exist (and be loaded) here');
    sceneAttach(child, parent, slot);
    return;
  }
  if (cmd === 'dismount') {
    const id = (arg || '').trim();
    if (!id) return logChat('*', 'usage: /dismount <thing>');
    if (!entities.get(id)?.userData?.mountedTo) return logChat('*', `${id} isn't mounted on anything`);
    sceneDetach(id);
    return;
  }
  if (cmd === 'use') {
    // /use <entity> [action] — rank 0: using the world is for everyone.
    // Reactions (the swing's push, a door's open) come back as log entries.
    const [id, action] = (arg || '').trim().split(/\s+/);
    if (!id) return logChat('*', 'usage: /use <thing> [action] — e.g. /push swing1');
    if (!entities.has(id)) return logChat('*', `nothing here called "${id}"`);
    sendVerb('use', { id, action: action || 'use' });
    return;
  }
  if (cmd === 'sit') {
    // /sit [thing] — a declared seat nearby wins; otherwise sit on the ground
    if (!trySitOn((arg || '').trim() || null)) setPosture('sit');
    return;
  }
  if (cmd === 'emote') {
    const name = (arg || '').trim().toLowerCase();
    if (!EMOTE_ORDER.includes(name) && !Object.keys(EMOTES).includes(name)) {
      return logChat('*', `emotes: ${Object.keys(EMOTES).join(', ')}`);
    }
    me?.playEmote(name);
    myState.emote = name;
    return;
  }
  if (cmd === 'goto') {
    const target = [...remotes.values()].find((r) =>
      r.id.toLowerCase() === (arg || '').trim().toLowerCase());
    if (!target?.avatar) return logChat('*', `no one here called "${arg}"`);
    // walk-to is the agent verb; for a person it's a hint plus a marker
    const p = target.avatar.root.position;
    flashHint(`${target.id} is ${p.distanceTo(myState.pos).toFixed(0)}m away, bearing ${bearingTo(p)}`);
    return;
  }
});

// ---------------------------------------------------------------- emotes
// They were number keys and a slash command — invisible unless you read the
// help. On a performance platform the gestures should be somewhere you can
// see them.

function initEmoteBar() {
  const f = makeFrame('emotes', {
    title: 'emotes', x: -252, y: -10, w: 232, h: 44, minW: 120, minH: 34, hidden: true,
  });
  const wrap = document.createElement('div');
  wrap.style.cssText = 'display:flex; flex-wrap:wrap; gap:4px; padding:7px;';
  const ICON = { wave: '👋', cheer: '🙌', dance: '💃', point: '👉', salute: '🫡', clap: '👏' };
  EMOTE_ORDER.forEach((name, i) => {
    const b = document.createElement('button');
    b.textContent = `${ICON[name] ?? '✨'}`;
    b.title = `${name}  (${i + 1})`;
    b.onclick = () => { me?.playEmote(name); myState.emote = name; };
    wrap.appendChild(b);
  });
  f.body.appendChild(wrap);
  return f;
}

function bearingTo(p) {
  const a = Math.atan2(p.x - myState.pos.x, p.z - myState.pos.z);
  const dirs = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  return dirs[Math.round(((a + Math.PI * 2) % (Math.PI * 2)) / (Math.PI / 4)) % 8];
}

async function saveScreenshot() {
  try {
    renderer.render(scene, camera);
    const url = renderer.domElement.toDataURL('image/png');
    const a = document.createElement('a');
    a.href = url;
    a.download = `eidoverse-${CONFIG.world}-${new Date().toISOString().replace(/[:.]/g, '-')}.png`;
    a.click();
    flashHint('saved');
  } catch (e) { report('screenshot', e); }
}

// ---------------------------------------------------------------- readiness
// "Ready" is not "the page loaded" — it's the moment there is something to
// stand in: your body exists, the log has been folded, and no heavy build
// (terrain, grass, the sky's first bake) is still running. Dropping someone
// into a dark grid the instant the socket opens is how the old boot felt
// instantaneous and looked broken.

let hydrated = false;
bus.on('hydrated', () => { hydrated = true; checkReady(); });

// An empty world is indistinguishable from a broken one: no ground, no sky,
// no objects, no explanation. That is what a mistyped world name gets you,
// and it is the worst possible first impression because everything is working
// exactly as designed.
bus.on('hydrated', () => {
  if (entities.size > 0) return;
  const named = CONFIG.params.has('world');
  logChat('*', named
    ? `"${CONFIG.world}" is empty — nothing has ever been built here.`
    : `you are in "${CONFIG.world}", which is empty. Add ?world=<name> to the link to go somewhere else.`);
  logChat('*', 'press B to start building, or ? for the controls.');
  toast(`"${CONFIG.world}" is an empty world — press B to build in it`, 'warn', 14000);
});
bus.on('build-queue', checkReady);

function checkReady() {
  if (bootDone()) return;
  const bodyReady = isViewer || !!me;
  if (!bodyReady || !hydrated || buildsPending() > 0) return;
  // one frame with everything in place before the curtain lifts
  requestAnimationFrame(() => requestAnimationFrame(() => finishBoot('ready')));
}

// A world with no entities drains its build queue before anything subscribes,
// so poll as a backstop rather than relying on an edge that may never fire.
const readyPoll = setInterval(() => {
  if (bootDone()) { clearInterval(readyPoll); return; }
  checkReady();
}, 400);

// ---------------------------------------------------------------- frame loop

let last = performance.now();
let frames = 0, fpsAt = last, fps = 0;
let pixelRatio = BASE_PIXEL_RATIO;
let slowFor = 0;

function frame(now) {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  const t = now / 1000;
  globalThis._sceneTime = t;

  BC('frame');
  updateAutoSystems(t);          // grass wind, particles
  BC('motion');
  tickMotion();                  // the world's moving parts (log-authored)
  BC('sky');
  updateSky(now, t);

  BC('me-drive');
  if (CONFIG.renderer) { /* camera is driven per snap request */ }
  else if (CONFIG.spectate) updateSpectator(dt, CONFIG.follow ? remotes.get(CONFIG.follow) : null);
  else if (downed) stepRagdoll(dt);     // the controller yields while limp
  else if (avatarMounts.has(CONFIG.name)) updateMountedMe();  // seated: derived, not driven
  else updateMe(dt, me);
  updateSeatHint(dt);            // "X — sit" while a declared seat is in reach

  // my own held pose: apply on change so I see what everyone else sees of me.
  // While downed the ragdoll owns setPose directly, so skip this path.
  BC('held-pose');
  if (!downed && me && myState.pose !== me._poseSig) {
    me._poseSig = myState.pose;
    if (myState.pose) me.setPose(myState.pose); else me.clearPose();
  }
  BC('me-update');
  updateVoiceMouths(now);        // BEFORE the avatar updates that consume it
  me?.update(dt, now);
  BC('bodydrag');
  updateBodyDrag(dt, now);       // BEFORE remotes: the takeover sim's pose must
                                 // land in the same frame's avatar.update
  BC('physobj');
  tickPhysObj(dt, now);          // entity leases I hold (kicked balls, etc.)
  BC('mods');
  tickMods(dt, now);             // runtime-loaded client scripts (🧩 mods)
  BC('remotes');
  updateRemotes(dt, now);
  BC('gaze');
  updateGaze(myState.pos, me, CONFIG.name, now);
  BC('build');
  updateBuild();
  BC('debug');
  updateDebug(now);              // collider/ragdoll wireframes, when F3 is up
  BC('send-pose');
  sendPose(now);

  // A held frame = a whole-scene pipeline settle is in progress (sky arrival
  // invalidates everything at once). Presentation pauses for one bounded
  // beat; everything above still ticked, so the world snaps current on resume.
  BC('render');
  if (!framesHeld()) renderer.render(scene, camera);
  BC('post-render');

  frames++;
  if (now - fpsAt > 1000) {
    fps = frames; frames = 0; fpsAt = now;
    governPerformance(fps);
    paintHud();
  }
  requestAnimationFrame(frame);
}

// Shed pixels before shedding frames; shed animation detail before pixels.
// Clouds come off before pixels do. The volumetric march measured 40fps at
// high vs 60 at medium under identical GPU-bound load — a bigger lever than
// resolution, and a slightly plainer sky reads better than a blurry whole
// world. Stepped at most once every few seconds so a hitch cannot cascade
// the setting all the way to 'off'.
let lastLightDrop = 0;
function shedLight() {
  const now = performance.now();
  if (now - lastLightDrop < 6000 || litCount() === 0) return false;
  lastLightDrop = now;
  if (!shedALight()) return false;
  toast('turned a light down to keep the frame rate — it still glows', 'warn', 6000);
  return true;
}
let lastCloudDrop = 0;
function shedClouds(now) {
  if (now - lastCloudDrop < 8000) return false;
  const i = CLOUD_QUALITY.indexOf(getCloudQuality());
  if (i <= 0) return false;
  lastCloudDrop = now;
  const next = CLOUD_QUALITY[i - 1];
  setCloudQuality(next);
  toast(`clouds turned down to "${next}" to keep the frame rate — change it in the sky panel`, 'warn', 8000);
  return true;
}

// Thin the meadow before dropping resolution: 318k blades of fill is the
// frame budget on some browsers (Safari, measured 08-02 — "grass really
// kills visual smoothness"), and a 60% field at full resolution reads far
// better than a full field at 70% resolution. Sticky across re-grows.
// Steps from the EFFECTIVE density (the resident's grass⚙ cap already
// applies), so a capped meadow isn't "shed" to a value the cap was already
// below — that would toast without changing a single blade.
function shedGrass() {
  const eff = getGrassDensity();
  if (!hasGrass() || eff <= 0.35) return false;
  setGrassDensity(eff > 0.65 ? 0.6 : 0.35);
  toast(`grass thinned to keep the frame rate`, 'warn', 8000);
  return true;
}

// Emitters are alpha-blended fill like grass is, and a long shared session
// accumulates them (#25 requirement 5). Thinning is a per-emitter instance
// count — no rebuild, no hitch — and it changes only how many sprites THIS
// machine draws: preset, state, seed and provenance stay shared facts, so two
// people on different tiers are still looking at the same fire.
const EMITTER_TIERS = ['auto', 'med', 'low'];
function shedEmitters() {
  if (!emitterCount()) return false;
  const i = EMITTER_TIERS.indexOf(emitterQuality());
  if (i < 0 || i >= EMITTER_TIERS.length - 1) return false;
  if (!setEmitterQuality(EMITTER_TIERS[i + 1])) return false;
  toast('particle effects thinned to keep the frame rate', 'warn', 8000);
  return true;
}

function governPerformance(f) {
  if (f > 0 && f < 26) {
    slowFor++;
    if (slowFor > 2 && shedClouds(performance.now())) { /* clouds first */ }
    else if (slowFor > 2 && shedLight()) { /* then a light — point lights are costly */ }
    else if (slowFor > 2 && shedEmitters()) { /* then sprite fill — cheapest to give back */ }
    else if (slowFor > 2 && shedGrass()) { /* then the meadow — fill rate */ }
    else if (slowFor > 2 && pixelRatio > 0.7) {
      pixelRatio = Math.max(0.7, pixelRatio - 0.25);
      renderer.setPixelRatio(pixelRatio);
    } else if (slowFor > 4) {
      setLodBias(2);              // far bodies animate at half rate again
      if (sun.shadow.mapSize.width > 1024) {
        sun.shadow.mapSize.set(1024, 1024);
        sun.shadow.map?.dispose();
        sun.shadow.map = null;
      }
    }
  } else if (f > 52) {
    slowFor = 0;
    setLodBias(1);
    if (pixelRatio < BASE_PIXEL_RATIO) {
      pixelRatio = Math.min(BASE_PIXEL_RATIO, pixelRatio + 0.125);
      renderer.setPixelRatio(pixelRatio);
    }
  }
}

const statusDot = {
  live: '<span class="ok">●</span>', connecting: '<span>○</span>',
  retrying: '<span class="bad">●</span>', rejected: '<span class="bad">✕</span>',
};
function paintHud() {
  const n = remotes.size;
  setHud(
    `${statusDot[net.status] ?? ''} <b>${CONFIG.name}</b> @ ${CONFIG.world}   ` +
    `${fps}fps   ${n} other${n === 1 ? '' : 's'}` +
    (isEditing() ? '   <span class="edit">✎ editing</span>' : '') +
    (skyImpl() === 'skymesh' ? '   <span style="opacity:.6">basic sky</span>' : ''),
  );
}

requestAnimationFrame(frame);

// Idle bandwidth streams the rest of the library into the HTTP cache — fire
// and forget; it waits out the boot and yields to every real load on its own
// (stats live at __ewPrefetch, opt out with ?prefetch=0).
startPrefetch().catch((e) => report('prefetch', e));

// ---------------------------------------------------------------- debug

globalThis.EW = {
  me: () => me, remotes, entities, myState, THREE, net, scene, camera, renderer, bus,
  skyArgs, sendVerb, setPosable, get posable() { return posable; },
  setPushable, get pushable() { return pushable; }, dragState,
  lease: leaseApi,   // the entity-lease surface runtime plugins script against
  mods: modsApi,     // load/run/offer runtime client scripts (🧩)
  bodysim: { engine: bodyEngine, setEngine: setBodyEngine },  // swappable body physics
};

} // end of the normal-boot branch (?mintthumbs takes the path above)
