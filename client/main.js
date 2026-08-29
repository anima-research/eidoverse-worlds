// eidoverse-worlds browser client.
//
// Two planes: the world log (verbs, ordered, replayed on join) and presence
// (intent state at ~15Hz, interpolated). The client owns its own avatar; the
// server sequences and relays. This file is the boot sequence and the frame
// system LIST — every system lives in lib/ (§14 6c): identity and the `me`
// handle in mybody.js, my body's physics in localbody.js, consent in
// consent.js, voice mouths in voicemouths.js, /commands in lib/commands/.

import {
  THREE, scene, camera, renderer, CONFIG, bus, report,
} from './lib/core.js';
import { contributeThumbnail, makeAvatar, EMOTE_ORDER } from './lib/avatar.js';
import { updateSky, updateAutoSystems, skyArgs, setCloudQuality } from './lib/sky.js';
import { setSkyArgsSource, entities, buildsPending, avatarMounts } from './lib/world.js';
import { foldParity } from './lib/parity.js';
import { initModelsRealizer, reconcileModels, residencyDebug, setResidencyFocus, drainPromoteTail } from './lib/realize/models.js';
import { initEnvironmentRealizer } from './lib/realize/environment.js';
import { initSocialRealizer } from './lib/realize/social.js';
import { initStructureRealizer } from './lib/realize/structure.js';
import { initSimWorld, simState } from './lib/simworld.js';
import { initStructureUI } from './lib/structure_ui.js';
import { initCauses } from './lib/realize/causes.js';
// side-effecting: the `particles` component's host wires itself to the comp
// and entity buses on import (it has no boot step of its own)
import './lib/emitters.js';
import { tickMotion } from './lib/motion.js';
import {
  myState, updateMe, updateSpectator, setCamYaw, setPosture, togglePhotoMode,
} from './lib/controller.js';
import { remotes, updateRemotes, updateGaze } from './lib/remotes.js';
import {
  net, connect, initIdentity, loginUrl, wireNet, sendVerb, sendPose, sendWhisper, sendTyping,
} from './lib/net.js';
import { updateBuild, toggleEditMode, isEditing } from './lib/build.js';
import { initPalette } from './lib/palette.js';
import { initConjure } from './lib/conjure.js';
import './lib/mictoggle.js'; // mic + headphone toggles beside the HUD, both off by default
import { initAudioPanel } from './lib/audiopanel.js';
import { initSceneGraph } from './lib/scenegraph.js';
import {
  toast, setHint, flashHint, buildHelp, toggleHelp,
  openDoor, toggleRoster, initRoster, initDock, panelFrame,
} from './lib/ui.js';
import { initDebug, updateDebug, toggleDebug } from './lib/debug.js';

// Which build is this world running? One console line at boot, so "what's
// deployed here" is a glance instead of an inference (the 2026-08-07 audio
// mystery). Server route: GET /version — same answer, one curl away, for
// anyone without a browser console.
fetch('/version').then((r) => r.json())
  .then(({ sha, commitTime, dirty, startedAt }) => console.log(`[eidoverse] server build ${sha}${dirty === true ? ' (DIRTY TREE)' : dirty === false ? '' : ' (dirty: unknown)'} (code from ${commitTime}), up since ${startedAt}`))
  .catch(() => console.log('[eidoverse] server build unknown (/version unavailable)'));
import { dragSim, updateBodyDrag, dragState } from './lib/bodydrag.js';
import { initChat, logChat } from './lib/chat.js';
import { bodyEngine, setBodyEngine, listBodyEngines } from './lib/bodysim.js';
import { initPhysObj, tickPhysObj, leaseApi } from './lib/physobj.js';
import { initMods, tickMods, modsApi } from './lib/mods.js';
import { initBoot, markPhase, finishBoot, bootDone } from './lib/boot.js';
import { protoStats } from './lib/assets.js';
import { grassTiles } from './lib/terrain.js';
import { grassDiag } from './lib/grassdiag.js';
import { warmStats } from './lib/warmqueue.js';
import { laneStats as schedLaneStats } from './lib/scheduler.js';
import { laneStats as loadLaneStats } from './lib/loadwork.js';
import { colliderCacheStats } from './lib/colliders.js';
import { governPerformance, governorDebug, whenCalm } from './lib/governor.js';
import { registerSystem, startFrame, frameDebug } from './lib/frame.js';
import { perf } from './lib/perf.js';
import { paintHud } from './lib/hud.js';
import { updateMaterials, materialsDebug } from './lib/materials.js';
import { updateRig, rigDebug } from './lib/lightrig.js';
import { startPrefetch } from './lib/prefetch.js';
import {
  getMe, setMe, getMyAvatarPath, getMyAvatarName, resolveMyAvatarPath,
  rosterLazy, chooseAvatar,
} from './lib/mybody.js';
import {
  initLocalBody, isDowned, activeRagdoll, goLimp, getUp,
  stepRagdoll, updateMountedMe, updateSeatHint,
} from './lib/localbody.js';
import { posable, pushable, setPosable, setPushable } from './lib/consent.js';
import { updateVoiceMouths } from './lib/voicemouths.js';
import { initEmoteBar } from './lib/emotebar.js';
import { initCommands, saveScreenshot } from './lib/commands/handlers.js';
import { deriveLandmarks, debugMarkers, landmarkWorld } from './lib/landmarks.js';
import { measureChain, solveChain } from './lib/reachbone.js';
import { canonicalPoint } from '../shared/contact.js';
import { initReachNet, setMyReach, clearMyReach } from './lib/reachnet.js';

// (Crash breadcrumbs live in lib/bc.js now; the frame loop stamps each
// system's name as it runs. avatar.js still reads globalThis.__ewBC.)

if (CONFIG.params.has('mintthumbs')) {
  // ?mintthumbs — seed the roster's portraits, then stop (lib/mint.js owns
  // the why and the how). The else below is the entire normal boot.
  await (await import('./lib/mint.js')).mintThumbnails();
} else {

const isViewer = CONFIG.spectate || CONFIG.renderer;

// ---------------------------------------------------------------- lighting
// The sun shadow's config and camera-following frustum live in the light
// rig (lightrig.js §12.5) — set at module init, before the first compile,
// because shadowMap enabled/type are pipeline-shape.

setSkyArgsSource(skyArgs);
setResidencyFocus(() => myState?.pos ?? null);   // the body anchors residency too (§13.3)
// The realizers project folded state into the scene. Wired before connect()
// so the hydrated event of the very first snapshot finds them listening;
// causes.js takes the fold-inert live verbs off the 'live-entry' bus.
initModelsRealizer();
initEnvironmentRealizer();
initSocialRealizer();
// structure AFTER models: a building's anchor entity is an ordinary spawn until
// the `kind` amendment lands, and the structure realizer hides whatever object
// the models realizer made for it.
initStructureRealizer();
initStructureUI();
initCauses();
// the deterministic sim's applier (PROTOCOL_v2 dialect 3): advances the
// shadow sim fold to now and moves sim-owned bodies — inert pre-epoch
initSimWorld();

// ---------------------------------------------------------------- boot

initBoot({ world: CONFIG.world, name: CONFIG.name });
buildHelp();
initChat({
  send: (text) => sendVerb('say', { text }),
  whisper: sendWhisper,
  typing: (to) => { sendTyping(to); getMe()?.setTyping(); },
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
  ragdoll: () => dragSim() ?? activeRagdoll(),
  downed: () => !!dragSim() || isDowned(),
  dragging: () => !!dragSim(),
  fps: () => perf.fps,
  perf: () => perf,          // fps + frame ms + worst-of-last-second
  bill: frameDebug,          // per-system EWMA ms — where the frame goes
  // drop again from where you stand, so a shape can be reproduced back to back
  reLimp: () => { if (isDowned()) getUp(); goLimp(); },
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
    // the door is already an interactive pause — its roster fetch is lazy,
    // and the choice is cached so the NEXT boot needs no fetch at all
    rosterLazy().then((roster) => openDoor({
      roster,
      needsKey: CONFIG.params.has('needkey'),
      login: loginUrl(),
      onEnter: ({ avatar, avatarName }) => {
        if (avatar) chooseAvatar(avatar, avatarName, { remember: true });
        start();
      },
    }));
  } else start();
}

// A rejected door key re-opens the door with a key field instead of retrying
// into a wall forever.
bus.on('bad-key', () => {
  toast('that door key was refused', 'err', 20000);
  rosterLazy().then((roster) => openDoor({
    roster, needsKey: true, login: loginUrl(),
    onEnter: ({ avatar, avatarName }) => {
      if (avatar) chooseAvatar(avatar, avatarName);
      connect();
    },
  }));
});

function start() {
  connect();
  initPalette();
  initConjure();   // the orrery panel — prompt → your pick of images → mesh → world
  // 🔴 ONE TRANSPORT, EXACTLY ONE PLAYBACK OWNER (#104 amendment 6, the #132
  // cutover). The P2P mesh is deleted; the in-process SFU is not a flag or a
  // URL param, it is the only voice path the client has. That is deliberate —
  // when transports selected by flag coexisted, a dropped ?sfu=1 served R the
  // mesh for an hour while every result was reported as "SFU" (2026-08-15),
  // and amendment 6's "exactly one playback owner must be visible at all
  // times" is only IMPOSSIBLE to violate when a second owner cannot
  // initialise. The requirement is that the wrong path be impossible, not
  // discouraged. If cutover acceptance fails, the remedy is deploying the
  // previous release during the migration window (notes/CUTOVER-ROLLBACK.md),
  // not a runtime branch back to a transport this bundle no longer contains.
  window.__voiceTransport = 'pending:sfu';
  import('./lib/voicesfubridge.js').then((m) => { m.initVoiceSfu(CONFIG.name); window.__voiceTransport = 'sfu'; })
    .catch((e) => { window.__voiceTransport = 'failed:sfu'; window.__voiceTransportError = String(e); console.error('voice init failed', e); });
  initAudioPanel();   // 🔊 categories: voices / world / TTS + consent rows
  // HEARING YOURSELF IS THE POINT. This hook — your own says going through the
  // selected voice — used to be installed ONLY inside the `?tts=PORT` block, so
  // it existed exclusively for bodies launched with a URL parameter. A human who
  // picked a voice in the panel loaded a 63 MB model, saw "ready", typed, and
  // heard nothing, because nothing was listening for their says (R, 2026-08-09:
  // "I don't hear anything when I type into the chat box. Hearing yourself as a
  // human using TTS is half the fun").
  //
  // It belongs at boot, with everyone: it is a no-op until a voice exists and
  // the checkbox is on, and speakOwnSays() already gates on both.
  // `actor` on the speech event is the world-log ID STRING (world.js:331), so
  // the identity here must be CONFIG.name — not `me`, which is the avatar
  // OBJECT and would never compare equal, leaving the hook installed and
  // permanently silent. Exactly the failure shape that has cost hours today:
  // a check that runs, reports success, and can only ever be false.
  import('./lib/tts.js')
    // net.myId is what the SERVER settled on — it can differ from CONFIG.name
    // when an authenticated identity renames you, or when the server suffixes a
    // duplicate display name. Prefer it; fall back to the requested name before
    // the join completes.
    .then((vs) => vs.speakOwnSays(bus, () => net.myId || CONFIG.name))
    .catch((e) => console.warn('[voice] own-say hook not installed:', e));
  initSceneGraph();   // 🌳 the world as a tree + 📜 the scripts that animate it
  setHint('<kbd>WASD</kbd> move · <kbd>Enter</kbd> chat · <kbd>B</kbd> build · <kbd>?</kbd> help');

  if (!isViewer) {
    resolveMyAvatarPath()
      .then((path) => makeAvatar(CONFIG.name, path, { urgent: true })) // your body skips the load queue
      .then((av) => {
        setMe(av);
        markPhase('body', 1);
        // Contribute a portrait of this body so the next person picks from
        // faces instead of filenames. Deferred behind the governor's calm
        // signal — it costs an offscreen render-target compile burst, and the
        // old t+4s wall clock dropped that into the middle of the boot storm
        // (§16.1g). Calm = 5 smooth seconds with no load work in flight.
        whenCalm().then(() => contributeThumbnail(getMyAvatarName(), av.vrm, CONFIG.token));
      })
      .catch((e) => { markPhase('body', 1); report('avatar', e); });
  }
}

wireNet({
  myAvatarPath: () => getMyAvatarPath(),   // a bare name: the server resolves
  myState,
  me: () => getMe(),
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

bus.on('sky-degraded', ({ msg }) => toast(msg, 'warn', 12000));

// ---------------------------------------------------------------- my body
// The avatar swap + avatar-updated wiring rides mybody.js's import; the
// physics of being a body here (ragdoll, seats, drag, pins, shoves) is
// localbody.js, handed logChat instead of importing chat (§14.2).

initPhysObj({ myPos: () => myState.pos });
// reach descriptors resolve against the same bodies everyone renders; my own
// id is how "a landmark on me" and "a point in my frame" find this body
initReachNet({
  me: () => getMe(),
  myId: () => CONFIG.name,
  avatarOf: (id) => (id === CONFIG.name ? getMe() : remotes.get(id)?.avatar ?? null),
});
initMods();   // 🧩 runtime client scripts: local trusted mods + world offers
initLocalBody({ logChat });
initCommands();   // the /command surface (lib/commands/) + its bus subscriptions

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
  if (e.code === 'KeyR' && !isEditing()) { isDowned() ? getUp() : goLimp(); return; }
  // any movement stands you back up
  if (isDowned() && ['KeyW','KeyA','KeyS','KeyD','ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Space'].includes(e.code)) getUp();
  // emotes on the number row — the world is a performance space and there was
  // no way to wave at anyone
  // the range follows the def-hydrated bar order (§24l) — a ninth listed
  // emote in _emotes.json gets a key with no code change
  const n = /^Digit([1-9])$/.exec(e.code);
  const me = getMe();
  if (n && me) {
    const name = EMOTE_ORDER[Number(n[1]) - 1];
    if (!name) return;
    me.playEmote(name);
    myState.emote = name;
    flashHint(name);
  }
});

// ---------------------------------------------------------------- roster

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
  const bodyReady = isViewer || !!getMe();
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
// The loop itself lives in lib/frame.js (§14.2 6b); this is the LIST — the
// registration order IS the execution order, and it encodes the constraints
// §14.1 documents: motion before remotes, sky → materials → rig,
// voice-mouths before the avatar update, bodydrag before remotes, gaze
// after, send-pose after every myState writer, render last. Each system is
// timed (EW.frame() prints the bill) and the governor may stride cosmetic
// ones. The governor + HUD ride the 1Hz pulse, registered last.

registerSystem('autos', (dt, t) => updateAutoSystems(t));       // grass wind, particles
registerSystem('motion', () => tickMotion());                   // the world's moving parts
registerSystem('sky', (dt, t, now) => updateSky(now, t));
registerSystem('materials', (dt, t, now) => updateMaterials(now)); // weather → uniforms
registerSystem('rig', (dt, t, now) => updateRig(now));          // light slots follow requests
registerSystem('me-drive', (dt) => {
  if (CONFIG.renderer) { /* camera is driven per snap request */ }
  else if (CONFIG.spectate) updateSpectator(dt, CONFIG.follow ? remotes.get(CONFIG.follow) : null);
  else if (isDowned()) stepRagdoll(dt);     // the controller yields while limp
  else if (avatarMounts.has(CONFIG.name)) updateMountedMe(dt);  // seated: derived, not driven
  else updateMe(dt, getMe());
  updateSeatHint(dt);            // "X — sit" while a declared seat is in reach
});
registerSystem('held-pose', () => {
  // my own held pose: apply on change so I see what everyone else sees of
  // me. While downed the ragdoll owns setPose directly, so skip this path.
  const me = getMe();
  if (!isDowned() && me && myState.pose !== me._poseSig) {
    me._poseSig = myState.pose;
    if (myState.pose) me.setPose(myState.pose); else me.clearPose();
  }
});
registerSystem('me-update', (dt, t, now) => {
  updateVoiceMouths(now);        // BEFORE the avatar update that consumes it
  getMe()?.update(dt, now);
});
registerSystem('bodydrag', (dt, t, now) => updateBodyDrag(dt, now)); // before remotes:
                                 // the takeover pose lands in this frame's avatar.update
registerSystem('physobj', (dt, t, now) => tickPhysObj(dt, now)); // entity leases I hold
registerSystem('mods', (dt, t, now) => tickMods(dt, now));       // 🧩 runtime scripts
registerSystem('remotes', (dt, t, now) => updateRemotes(dt, now));
registerSystem('gaze', (dt, t, now) => updateGaze(myState.pos, getMe(), CONFIG.name, now));
registerSystem('build', () => updateBuild());
registerSystem('promote-tail', () => drainPromoteTail());        // §16.2.C: promote
                                 // boulders (colliders/lamps/casters/mount
                                 // re-checks) land ≤~4ms/frame, not six in one;
                                 // before 'debug' so F3 sees same-frame colliders
registerSystem('debug', (dt, t, now) => updateDebug(now));       // F3 wireframes
registerSystem('send-pose', (dt, t, now) => sendPose(now));
registerSystem('render', () => renderer.render(scene, camera));
let _pulseAt = 0;
registerSystem('pulse', (dt, t, now) => {
  if (now - _pulseAt < 1000) return;
  _pulseAt = now;
  governPerformance(perf.fps);
  paintHud();
});

startFrame();   // explicit — the loop starts only after identity resolved

// Idle bandwidth streams the rest of the library into the HTTP cache — fire
// and forget; it waits out the boot and yields to every real load on its own
// (stats live at __ewPrefetch, opt out with ?prefetch=0).
startPrefetch().catch((e) => report('prefetch', e));

// ---------------------------------------------------------------- debug

// setVoice(name) — POINT AT A MODEL ON DISK, at any time, same function a human's
// picker uses.
//
// R: "why does it need to be restarted? I don't have to restart my client to use
// a voice, that's a weird asymmetry." She is right and I built the asymmetry: a
// URL param is a BOOT-TIME decision, so a human got a live control and an agent
// got a restart. Restarting a body is also the single most expensive thing in
// this system — it drops the door, and I have broken her world doing it twice
// today.
//
// So this is a function, callable whenever, and ?voice= merely calls it once at
// boot. The picker only produces File objects and a File is constructible from
// any bytes, so an agent fetches the two files a human would have chosen and
// hands them to the SAME loadFromFiles(). Inference runs in this browser; no
// synth process in the lane, nothing to keep alive, nothing to restart.
async function setVoice(name) {
  if (!name) {                       // setVoice(null) — go quiet, keep the lane
    const { setTtsSource, setTtsEnabled } = await import('./lib/tts.js');
    setTtsSource(null); setTtsEnabled(false);
    return { ok: true, voice: null };
  }
  const base = new URL(`voices/${name}`, location.href).href;
  const [onnx, cfg] = await Promise.all([
    fetch(`${base}.onnx`).then((r) => { if (!r.ok) throw new Error(`${name}.onnx: ${r.status}`); return r.blob(); }),
    fetch(`${base}.onnx.json`).then((r) => { if (!r.ok) throw new Error(`${name}.onnx.json: ${r.status}`); return r.blob(); }),
  ]);
  const files = [new File([onnx], `${name}.onnx`), new File([cfg], `${name}.onnx.json`)];
  const { loadFromFiles } = await import('./lib/voiceengines.js');
  await import('./lib/engines.js');
  const { label } = await loadFromFiles(files, (p) =>
    console.log(`[voice] ${p.text || p.phase || 'loading'}`));
  const { setTtsEnabled } = await import('./lib/tts.js');
  setTtsEnabled(true);
  console.log(`[voice] speaking with ${label} — loaded from disk, no server`);
  return { ok: true, voice: label };
}
// Callable from a console, from a harness, or by an agent mid-session.
if (typeof window !== 'undefined') window.setVoice = setVoice;
{
  const want = new URLSearchParams(location.search).get('voice');
  if (want) setVoice(want).catch((e) => console.warn('[voice] ?voice failed:', e));
}

// Opt-in synthesized voice: ?tts or ?tts=<port>. Absent — the overwhelmingly
// common case — nothing connects and the microphone stays the only source, so
// a human client is byte-for-byte unaffected.
{
  const q = new URLSearchParams(location.search);
  if (q.has('tts')) {
    const port = Number(q.get('tts')) || 8927;
    import('./lib/piperbridge.js')
      .then((m) => m.initPiperVoice({ port }))
      .then(async (ok) => {
        console.log(ok ? `[voice] synthesized voice ready on :${port}`
                       : `[voice] no synthesizer on :${port} — falling back to browser speech`);
        if (!ok) {
          // R, 2026-08-09: "The TTS endpoint should probably default to the
          // browser default if it can't resolve your TTS endpoint so you don't
          // get crazy beeping." An unreachable endpoint used to mean NO voice —
          // the body joined, asked to speak, and produced nothing (or, with a
          // tone generator installed, beeped). browservoice.js already existed
          // and was never imported anywhere: the fallback was written and dead.
          // Web Speech is worse than Piper and strictly better than silence.
          try {
            const { speechSynthesis } = window;
            if (!speechSynthesis) { console.warn('[voice] no speechSynthesis — microphone only'); return; }
            const vs0 = await import('./lib/tts.js');
            // Web Speech renders to the SPEAKERS, not to a PCM buffer we can put
            // on the mic lane — so this is audible locally and NOT transmitted.
            // Being honest about that is the point: silence used to be
            // indistinguishable from a broken endpoint.
            vs0.setTtsSource(async (text) => {
              try { speechSynthesis.speak(new SpeechSynthesisUtterance(text)); } catch {}
              return { pcm: new Int16Array(0), sampleRate: 22050, localOnly: true };
            }, 'browser speech (local only — peers will NOT hear this)');
            vs0.setTtsEnabled(true);
            console.warn('[voice] FALLBACK: browser speech. Audible to YOU, not to peers.'
                       + ` Start a synthesizer on :${port} for transmitted voice.`);
          } catch (e) { console.warn('[voice] browser-speech fallback failed:', e); return; }
        }
        const vs = await import('./lib/tts.js');
        // (own-say hook installed once at boot, line ~220, for every body —
        // not here. Installing it again would speak each line twice, and this
        // copy passed `me`, the avatar OBJECT, which never equals the actor
        // string.)
        // A body that registered a voice means to be heard: open the mic lane
        // so the sender exists before the first utterance, rather than after.
        // Install the seam BEFORE anything that can hang. toggleMic() awaits a
        // source, and a wedged source blocks every line after it — which made
        // the wiring look "never reached" when it had in fact reached and
        // stalled. Observability must not sit downstream of the risky call.
        globalThis.__voiceProbe = () => ({ ...vs.mouthInfo(), track: vs.genTrackInfo() });
        globalThis.__voiceSpeak = (t) => vs.speak(t);   // the APP's mouth, for probes
        const { toggleMic, micOn } = await import('./lib/micstate.js');
        // 🔴 `me` IS NOT IN SCOPE HERE — it was a ReferenceError that threw
        // before the mouth ever opened, so a body with ?tts= joined, logged
        // "synthesized voice ready", and was mute. The comment six lines up
        // already warned that an older copy "passed `me`, the avatar OBJECT";
        // the fix deleted the definition and left the call. toggleMic wants the
        // actor NAME, which is CONFIG.name — the same value every other caller
        // passes.
        // 🔴 OPEN THE LANE THE TRANSPORT ACTUALLY OWNS (2026-08-15). This read
        // the mesh's own mic-state getter and toggle unconditionally — so a
        // ?tts= body on an SFU server opened the MESH mic lane, published to a
        // transport nobody was on, and reported success. Same defect as the
        // HUD mic button had, on the path a voiced agent body depends on, and
        // it violates the "EXACTLY ONE PLAYBACK OWNER" invariant asserted at
        // the top of start(). Ask the bridge first; fall back to the mesh.
        if (typeof window.__sfuMic === 'function') {
          if (!window.__sfuMicOn?.()) await window.__sfuMic();
        } else if (!micOn()) {
          await toggleMic(CONFIG.name);
        }
        console.log('[voice] TTS wiring complete');
      })
      // 🔴 NEVER SWALLOW THIS. It was `.catch(() => {})`, so anything after the
      // "voice ready" line could throw and vanish while the log still claimed
      // success — the exact shape of a check that did not run (2026-08-08).
      .catch((e) => console.error('[voice] TTS wiring failed:', e?.message || e));
  }
}

globalThis.__ambientDebug = () => ambientDebug();
// My own body, for console probes. Chasing "the hair boxes move but the hair
// mesh does not" meant asking whether the bones the sim writes are the same
// objects the SkinnedMesh is bound to — a question answerable in one line from
// the console and in no lines at all without a handle on the avatar.
globalThis.__me = () => getMe();
// EVERY body in the scene, mine and the remotes, for console probes. Added
// because "which system is driving that body's hair right now" — the flap,
// Bullet, or three-vrm's springbones — is answerable in one line and was
// answerable in none: the avatars were reachable only through module-private
// maps, so a question about someone ELSE's body had nowhere to start.
globalThis.__bodies = () => [
  ...(getMe() ? [['me', getMe()]] : []),
  ...[...remotes.entries()].map(([id, r]) => [id, r.avatar]),
].filter(([, av]) => av).map(([who, av]) => ({
  who,
  limp: !!av._limp,
  clip: av.currentSlot ?? null,
  // exactly one of these should be true of a limp body: the local sim owns the
  // hair and wings, or three-vrm does
  simOwnsDressing: !!av.__simHair,
  springbonesRunning: !av.__simHair && !!av.vrm?.springBoneManager,
  avatar: av,
}));
// One command R can paste to answer "why is it silent?" from her own console:
// context state, how many sources exist, whether the gesture hook is waiting.
globalThis.__audioState = () => audioState();
// THE ISOLATION TEST, INSIDE THE WORLD PAGE. A separate probe page meant a new
// URL to type, and the URL was its own obstacle course: /audio-probe 404s,
// /audio-probe.html works, an extensionless copy downloads instead of
// rendering. None of that is the bug we are chasing. This runs where she
// already is. Call it from the console; it needs a click first for the
// context, which console interaction does not provide — so it reports the
// context state rather than pretending.
globalThis.testAudioLayers = async () => {
  // Use the SHARED context. This used to make its own, which on a page already
  // holding five was the sixth — i.e. the diagnostic itself could exhaust the
  // budget and then report silence it had caused.
  const { audioContext } = await import('./lib/audioctx.js');
  const ctx = audioContext();
  await ctx.resume().catch(() => {});
  const SRC = '/assets/audio_test_beacon.ogg';
  const r = { ctx: ctx.state };

  const a = new Audio(SRC); a.loop = true;
  try { await a.play(); r.A_plainAudio = 'playing'; }
  catch (e) { r.A_plainAudio = `FAILED ${e.name}`; }

  const b = new Audio(SRC); b.loop = true;
  try {
    const n = ctx.createMediaElementSource(b);
    const g = ctx.createGain(); g.gain.value = 1;
    n.connect(g).connect(ctx.destination);
    await b.play(); r.B_throughWebAudio = 'playing';
  } catch (e) { r.B_throughWebAudio = `FAILED ${e.name}`; }

  try {
    const o = ctx.createOscillator(); const g = ctx.createGain();
    g.gain.value = 0.15; o.frequency.value = 440;
    o.connect(g).connect(ctx.destination); o.start();
    setTimeout(() => { try { o.stop(); } catch {} }, 6000);
    r.C_oscillator = 'started (6s)';
  } catch (e) { r.C_oscillator = `FAILED ${e.message}`; }

  setTimeout(() => {
    console.log('%c[audio] after 3s — A t=' + a.currentTime.toFixed(2) +
      '  B t=' + b.currentTime.toFixed(2) +
      '  Aerr=' + (a.error?.code ?? 'none') + '  Berr=' + (b.error?.code ?? 'none'),
      'font-size:14px;color:#6cf');
    console.log('%cWHICH DID YOU HEAR?  A only → WebAudio output dead · A+C → ' +
      'createMediaElementSource is the break · C only → decode/file · none → ' +
      'below the page · all → page fine, ambient.js miswired', 'color:#fc6');
  }, 3000);
  console.log('%c[audio] ' + JSON.stringify(r, null, 1), 'font-size:14px;color:#6cf');
  return r;
};

globalThis.whyIsItSilent = () => {
  const s = audioState(), a = ambientDebug();
  console.log('%c[audio] ' + JSON.stringify({ ...s, sources: a }, null, 1),
    'font-size:14px;color:#6cf');
  return { ...s, detail: a };
};

const EW = globalThis.EW = {
  me: () => getMe(), remotes, entities, myState, THREE, net, scene, camera, renderer, bus,
  skyArgs, sendVerb, setPosable, get posable() { return posable(); },
  setPushable, get pushable() { return pushable(); }, dragState,
  // reach: aim a hand at a world point, or at anything that moves. Pass a
  // function and it re-solves every frame; `EW.reach('leftHand', () =>
  // EW.remotes.get('mythos').avatar.root.position.toArray())` follows a body.
  // reach: aim a hand at a world point, at a live function, or — simplest —
  // at a NAMED contact point, in which case the surface normal comes with it
  // and the palm turns to meet the surface:
  //     EW.reach('rightHand', 'head_top')                 // your own head
  //     EW.reach('rightHand', ['mythos', 'shoulder_l'])   // someone else's
  //     EW.reach('rightHand', () => [x, y, z])            // a bare point
  //
  // The name form exists because the point form is a trap: EW.contactAt()
  // returns a position and nothing else, so a reach built on it has no surface
  // to face and the palm stays wherever the forearm left it. That is not
  // visible as a bug — the hand still arrives — until you look at a headpat
  // and find the palm pointing at the sky.
  // Serializable targets (a name, [who, name], [x,y,z], or the wire forms
  // {who, point} / {p, space}) go through reachnet: the descriptor rides the
  // presence stream and EVERY client re-solves the same relation, so other
  // people see the arm too. A function target stays local-only — it cannot
  // travel, and this tab is the only one that can evaluate it.
  reach: (key, target, opts) => {
    if (typeof target === 'function') return getMe()?.setReach(key, target, opts);
    const err = setMyReach(key, target, opts);
    if (err) { console.warn(`[reach] ${err}`); return false; }
    return true;
  },
  // landmarks: named contact points, derived per body from its own mesh.
  // EW.landmarks() derives + caches; EW.showLandmarks() draws them to be
  // LOOKED at, which is the only check the derivation cannot do itself.
  landmarks: (who) => {
    const av = who ? remotes.get(who)?.avatar : getMe();
    if (!av) return null;
    av.__marks ??= deriveLandmarks(av);
    return av.__marks;
  },
  // Where a named contact point on a body IS, right now, in world space.
  // `standoff` lifts it off the skin so a hand rests ON it, not inside it.
  // This is the piece a touch is made of:
  //   EW.reach('rightHand', () => EW.contactAt('mythos', 'shoulder_l', 0.02))
  contactAt: (who, name, standoff = 0.02) => {
    const av = who ? remotes.get(who)?.avatar : getMe();
    if (!av) return null;
    av.__marks ??= deriveLandmarks(av);
    const e = av.__marks.get(canonicalPoint(name) ?? name);
    const hit = e && landmarkWorld(e, standoff);
    return hit ? hit.pos.toArray() : null;
  },
  // Which contact points can a hand ACTUALLY get to on this body? One solve
  // per (point, hand) against the real derived landmarks — no frames needed,
  // because the solve is a pure function of pose and target. Answers the
  // question a demo cannot: not "does reaching work" but "what is in range".
  // Bumped whenever the reach solver changes, so a diagnostic can prove which
  // code produced its numbers. A stale tab is otherwise indistinguishable from
  // a real disagreement about what the arm is doing.
  reachVersion: 'reach-6 contact-allowance 2026-08-20',
  // Which body is being worn — vrm.scene.name is often blank, and "which rig"
  // is the first question when one person's arm does something another's does
  // not.
  get avatarPath() { try { return getMyAvatarPath() || '(unknown)'; } catch { return '(unknown)'; } },
  reachAudit: (who, standoff = 0.02) => {
    // Landmarks come from the body being TOUCHED; the chains doing the
    // reaching are always mine. Using one avatar for both asks "can that body
    // reach its own shoulder", which is a different and much harder question —
    // and it returns identical numbers whoever you name, which is how this was
    // caught.
    const av = getMe();
    const subject = who ? remotes.get(who)?.avatar : av;
    if (!av || !subject) return null;
    subject.__marks ??= deriveLandmarks(subject);
    const self = subject === av;
    const rows = [];
    for (const [name, e] of subject.__marks) {
      const hit = landmarkWorld(e, standoff);
      if (!hit) continue;
      const t = hit.pos.toArray();
      const best = { hand: null, gap: Infinity, bound: [] };
      for (const key of ['leftHand', 'rightHand']) {
        const ch = measureChain(av, key);
        if (!ch) continue;
        // A limb cannot meaningfully touch itself: scoring the left hand
        // against a point ON the left arm returns a triumphant 0mm that means
        // nothing. Skip the chain that owns the landmark.
        if (self && (ch.spec.root === e.bone || ch.spec.mid === e.bone || ch.spec.end === e.bone)) continue;
        const out = solveChain(ch, av, t, null);
        if (!out?.ok) continue;
        if (out.res.gap < best.gap) { best.hand = key === 'leftHand' ? 'L' : 'R'; best.gap = out.res.gap; best.bound = out.res.bound; }
      }
      rows.push({ point: name, tier: e.tier, hand: best.hand ?? '-',
                  mm: Number.isFinite(best.gap) ? Math.round(best.gap * 1000) : null,
                  bound: best.bound.join(',') || '-' });
    }
    rows.sort((a, b) => (a.mm ?? 1e9) - (b.mm ?? 1e9));
    return rows;
  },
  // Position AND the surface normal, so a reach can put the PALM on it.
  // EW.reach('rightHand', () => EW.contactFrame('mythos', 'shoulder_l'))
  contactFrame: (who, name, standoff = 0.02) => {
    const av = who ? remotes.get(who)?.avatar : getMe();
    if (!av) return null;
    av.__marks ??= deriveLandmarks(av);
    const e = av.__marks.get(canonicalPoint(name) ?? name);
    const hit = e && landmarkWorld(e, standoff);
    return hit ? { pos: hit.pos.toArray(), normal: hit.normal.toArray() } : null;
  },
  // Paint the side of the hand the code believes is the PALM: a green disc
  // sitting just off the skin, following the bone. If it ends up against
  // whatever is being touched, the orientation is right and you are simply
  // seeing the back of a hand from outside — which is what you see when a palm
  // is on a hip. If it points away, the palm axis is wrong on that rig and I
  // want to know.
  showPalm: (on = true, key = 'rightHand') => {
    const me = getMe(); if (!me) return null;
    const ch = me._chains?.get(key);
    if (!ch) return 'reach something first, so the chain is measured';
    const node = ch.nodes.end;
    const NAME = '__palmDisc';
    const old = node.getObjectByName(NAME);
    if (old) { node.remove(old); old.geometry.dispose(); old.material.dispose(); }
    if (!on) return 'off';
    const qH0 = new THREE.Quaternion(...ch.restQ.qH);
    const aPalm = new THREE.Vector3(...ch.palmRest).applyQuaternion(qH0.clone().invert());
    const disc = new THREE.Mesh(
      new THREE.CircleGeometry(0.035, 20),
      new THREE.MeshBasicMaterial({ color: 0x33ff66, side: THREE.DoubleSide, depthTest: false }));
    disc.name = NAME;
    disc.renderOrder = 999;
    disc.position.copy(aPalm).multiplyScalar(0.03);
    disc.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), aPalm.clone().normalize());
    node.add(disc);
    return 'green disc marks the palm side';
  },
  showLandmarks: (on = true, who) => {
    const av = who ? remotes.get(who)?.avatar : getMe();
    if (!av) return null;
    av.__marks ??= deriveLandmarks(av);
    debugMarkers(av, av.__marks, scene, on);
    return [...av.__marks].map(([n, e]) => `${n}:${e.how}`).join(' ');
  },
  clearReach: (key) => clearMyReach(key ?? null),
  reachStatus: () => getMe()?.reachStatus(),
  lease: leaseApi,   // the entity-lease surface runtime plugins script against
  mods: modsApi,     // load/run/offer runtime client scripts (🧩)
  bodysim: { engine: bodyEngine, setEngine: setBodyEngine, list: listBodyEngines },  // swappable body physics
  foldParity,        // shadow-mode drift probe (TEL0S_NOTES §11.6)
  reconcileModels,   // force a full realizer pass (idempotent — §11.4)
  materials: materialsDebug,   // factory counters + live weather uniforms (§12.3)
  lightrig: rigDebug,          // slot pool + request table (§12.4)
  governor: governorDebug,     // the two-way lever ladder (§12.6)
  residency: residencyDebug,   // real/stand-in/loading counts + sweep stats (§13.3)
  gpu: () => ({ ...renderer.info.memory, ...protoStats() }),   // bytes + proto/byte tiers
  frame: frameDebug,           // per-system rolling ms + strides (§14.2 6b)
  grass: grassTiles,           // tile-level draw truth (§13.2, landed 8e)
  simFold: simState,           // the deterministic sim's shadow cut (PROTOCOL_v2)
  grassDiag,                   // §22: `await EW.grassDiag()` — the meadow's GPU cost, attributed by difference
  setCloudQuality,             // §22b: the sky pane's tier knob, console-reachable for diagnosis
  warm: warmStats,             // the conductor's queue (§16.2.A)
  lanes: () => ({ sched: schedLaneStats(), load: loadLaneStats() }),  // queue depths vs caps
  colliderCache: colliderCacheStats,   // per-lib shared BVH/lie bytes (§16.2.C)
};

} // end of the normal-boot branch (?mintthumbs takes the path above)
