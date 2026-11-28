// eidoverse browser client: the boot sequence, the frame-system list (lib/render/frameloop.js) and the EW console surface.
//
// Two planes: the world log (verbs, ordered, replayed on join) and presence (intent state at ~15 Hz, interpolated).
// The client owns its own avatar; the server sequences and relays. Every system lives in lib/: identity and the `me`
// handle in mybody.js, my body's physics in localbody.js, consent in consent.js, voice mouths in voicemouths.js,
// /commands in lib/ui/commands/. lite.js is the renderer-free sibling.
import { updateWater, updateWaterView, setWaterObjects, setWaterClock, setSkyHider, waterDebug, applyEnvLight } from './lib/realize/watervolumes.js';

import { say } from './lib/net.js';
import { setInputAvailable } from './lib/player/input.js';
import { updateHelm, helmHull } from './lib/player/vehicles.js';
import { chooseClient } from './lib/ui/litechoice.js';
import { THREE, scene, camera, renderer, canvas } from './lib/core.js';
import { releaseBodyGate, armBodyGate } from './lib/render/bodygate.js';
import { CONFIG, bus, report, tee, colorFor, emptyWorldNotice } from './lib/base.js';
import { versionReady } from './lib/version.js';
import { makeAvatar, makeCapsuleAvatar, ANIM_ORDER } from './lib/avatar/avatar.js';
import { contributeThumbnail } from './lib/avatar/avatar-thumbnail.js';
import { updateSky, updateAutoSystems, skyArgs, setCloudQuality, hideSkyForWater } from './lib/sky/sky.js';
import { setSkyArgsSource, entities, buildsPending, anyBuildsPending, avatarMounts, roleOf, worldHasOwner, bagOf, bags, seatSocket, socketsOn, currentTerrainArgs, terrainEditBase, noteTerrainSent, terrainPending } from './lib/world.js';
import { presence } from './lib/ui/presence.js';
import { initWorldQuad } from './lib/xr/worldquad.js';
import { foldParity } from './lib/debug/parity.js';
import { initModelsRealizer, reconcileModels, residencyDebug, setResidencyFocus, drainPromoteTail } from './lib/realize/models.js';
import { initEnvironmentRealizer } from './lib/realize/environment.js';
import { initSocialRealizer } from './lib/realize/social.js';
import { initStructureRealizer } from './lib/realize/structure.js';
import { initStructureUI } from './lib/edit/structure_ui.js';
import { initCauses } from './lib/realize/livechat.js';
// side-effecting imports: these components wire themselves to the comp and entity buses
import './lib/realize/emitters.js';
import './lib/realize/pictures.js';
import './lib/realize/material.js';   // the material component: an image on a named node of the model
import { tickSounds } from './lib/realize/sounds.js';   // the sound comp: positional audio from an entity
import { tickMotion } from './lib/motion.js';
import { tickLookAt } from './lib/realize/lookats.js';
import { tickTexts } from './lib/realize/texts.js';      // signs (the text component)
import { tickOpenables } from './lib/realize/openable.js';
import {
  myState, updateMe, updateInput, updateSpectator, setCamYaw, setPosture, togglePhotoMode,
  setRightsHook, setMeHook, setFolded, photoMode, setBoundsHook, setRespawnHooks, respawnMe, flying as flyingNow, capSpeed,
} from './lib/player/controller.js';
import { initUsePrompt } from './lib/ui/useprompt.js';
import { setClimbObjects } from './lib/player/climb.js';
import { initClickUse, clickUseApi } from './lib/player/clickuse.js';
import { remotes, updateRemotes, updateGaze, serverNow } from './lib/player/remotes.js';
import { initOccupants } from './lib/player/occupants.js';
// net.js takes the participant registry by injection (lite.js supplies a body-less one); this is the real one
import * as participants from './lib/player/remotes.js';
import { capture, setSnapReadiness } from './lib/render/net_capture.js';
import { setWaveClock } from './lib/water.js';
import { myReachBag } from './lib/player/reachnet.js';
import {
  replica, net, connect, initIdentity, loginUrl, wireNet, sendRequest, sendPose, sendTyping,
  setPoseOverride, sendPuppet, sendAnim, builtIn,
} from './lib/net.js';
import { poseCommands } from './lib/debug/posecommands.js';
import { updateBuild, toggleBuildMode, isBuilding, editSurface } from './lib/edit/build.js';
// may I build here: the build switch (the authority's), else the role (an older server); unknown = no (strict)
const mayBuildStrict = () => (Array.isArray(net.myRights?.permissions) ? net.myRights.permissions.includes('build') : isOwner(net.myRights));
import { initPalette } from './lib/edit/catalog.js';
import { initConjure } from './lib/edit/generate.js';
import { state as worldState } from './lib/state.js';
import { micLive, earOn } from './lib/audio/mictoggle.js'; // mic + headphone toggles beside the HUD, both off by default
import { initAudioPanel } from './lib/audio/audiopanel.js';
import { initSceneGraph, sceneSelect } from './lib/scenegraph.js';
import { initEditPanels } from './lib/edit/panels.js';
import { initEditLayout } from './lib/edit/layout.js';
import { initGizmo } from './lib/edit/gizmo.js';
import { initGripEdit } from './lib/edit/gripedit.js';
import { initMaterialOverrides } from './lib/realize/material_draft.js';
import { initInstances, tickInstances } from './lib/realize/instances-draft.js';
import { initWorldEdge } from './lib/edge.js';
import { initXR, updateXR, bindXRSelf, isPresenting } from './lib/xr/xr.js';
import { initPeople, personOf, isPhone, menuAt as personMenuAt, sheetFor as personSheet, stripFor as personStrip, badgeHtml as personBadge } from './lib/ui/people.js';
import { initRolesPanels, openModeration } from './lib/ui/rolespanels.js';
import { tickXRMirror } from './lib/xr/xrmirror.js';
import { ensureXRBodyHook, bindXRBodySelf, xrAvatarYaw, xrLookPitch, xrWire, xrSimActive } from './lib/xr/xrbody.js';
import { tickXRVignette } from './lib/xr/xrvignette.js';
import { initVRPanel } from './lib/xr/vrpanel.js';
import { trySitOn as xrTrySitOn, dismountMe as xrDismountMe } from './lib/player/localbody.js';
import {
  toast, flashHint, buildHelp, toggleHelp,
  togglePeopleHere, panelFrame, settingsFrame, setLoadingItems,
} from './lib/ui/ui.js';
import { initDock, paintPresence } from './lib/ui/ui-dock.js';
import { setMenuSources } from './lib/ui/ui-menu.js';
import { openDoor } from './lib/ui/ui-door.js';
import { registerXRPanel } from './lib/xr/xrpanels.js';
import { initDebug, updateDebug, toggleDebug } from './lib/debug/debug.js';

// which server build: one console line at boot
versionReady.then((v) => console.log(v ? `[eidoverse] server build ${v.sha}${v.dirty === true ? ' (DIRTY TREE)' : v.dirty === false ? '' : ' (dirty: unknown)'} (code from ${v.commitTime}), up since ${v.startedAt}` : '[eidoverse] server build unknown (/version unavailable)'));
import { dragSim, updateBodyDrag, dragState } from './lib/ragdoll/bodydrag.js';
import { initChat, logChat, chatXRPanel, mentionPerson } from './lib/ui/chat.js';
import { initPlates, updatePlates } from './lib/avatar/platecard.js';
import { bodyEngine, setBodyEngine, listBodyEngines } from './lib/ragdoll/bodysim.js';
import { initThingPhysics, physicsApi, simShown, requestWithBody as thingPhysicsRequest } from './lib/thingphysics.js';
import { initMods, tickMods, modsApi } from './lib/mods.js';
import { initBoot, markPhase, finishBoot, bootDone, setBootAssets } from './lib/boot.js';
import { protoStats, forgetBytes, loadingItems, bootBytes } from './lib/assets.js';
import { grassTiles, heightAt, hasTerrain } from './lib/terrain.js';
import { grassDiag } from './lib/debug/grassdiag.js';
import { warmStats } from './lib/render/warmqueue.js';
import { budgetStats } from './lib/render/framebudget.js';
import { pending, P, onIdle, laneStats as schedLaneStats } from './lib/render/scheduler.js';
import { laneStats as loadLaneStats } from './lib/render/loadwork.js';
import { colliderCacheStats } from './lib/colliders.js';
import { statusChip, paintHud } from './lib/ui/statuschips.js';
import { governPerformance, governorDebug, whenCalm, applyPendingPixelRatio } from './lib/render/governor.js';
import { registerSystem, startFrame, frameDebug } from './lib/render/frameloop.js';
import { perf } from './lib/render/perf.js';
import { renderWorld, drawStats, setDrawBatching } from './lib/render/render.js';
import { updateMaterials, materialsDebug } from './lib/render/materials.js';
import { updateRig, rigDebug, setLampShadow, lampShadowState } from './lib/render/lightrig.js';
import { startPrefetch } from './lib/prefetch.js';
import {
  getMe, setMe, getMyAvatarPath, getMyAvatarName, resolveMyAvatarPath,
  rosterLazy, chooseAvatar, announceWorn } from './lib/player/mybody.js';
import {
  initLocalBody, isDowned, activeRagdoll, goLimp, getUp, updateGetUp,
  stepRagdoll, updateMountedMe, updateSeatHint, seatLeaving,
} from './lib/player/localbody.js';
import { posable, pushable, setPosable, setPushable } from './lib/player/consent.js';
import { updateVoiceMouths } from './lib/audio/voicemouths.js';
import { initActionBar } from './lib/ui/actionbar.js';
import { initXRKeyboard } from './lib/xr/xrkeyboard.js';
import { initXRAsk } from './lib/xr/xrask.js';
import { initCommands, saveScreenshot } from './lib/ui/commands/handlers.js';
import { register as registerAction } from './lib/ui/actions.js';
import { initLantern } from './lib/ui/commandbar.js';
import { deriveLandmarks, debugMarkers, landmarkWorld } from './lib/avatar/landmarks.js';
import { measureChain, solveChain } from './lib/avatar/reachbone.js';
import { canonicalPoint } from '../shared/contact.js';
import { initReachNet, setMyReach, clearMyReach } from './lib/player/reachnet.js';
import { foldedIn } from '../shared/wingpresence.js';
import { readBodyMode } from '../shared/bodymode.js';
import { isOwner } from '../shared/protocol/roles.js';
import { DEFAULT_BODY } from '../shared/avatardefs.js';
import { standingYFromLyingRoot } from './lib/getup.js';
import { holdHeightUntilSolid } from './lib/arrivalhold.js';

if (CONFIG.params.has('mintthumbs')) {
  // ?mintthumbs — seed the roster's portraits, then stop (lib/debug/portraits.js). The else below is the entire normal boot.
  await (await import('./lib/debug/portraits.js')).mintThumbnails();
} else {

const isViewer = CONFIG.spectate || CONFIG.renderer;

// ---------------------------------------------------------------- realizers

setSkyArgsSource(skyArgs);
setResidencyFocus(() => myState?.pos ?? null);   // the body anchors residency
// a renderer takes a snapshot only once the world is realized around the body it follows (net_capture.js settle);
// shaders still warming do not block (a stall, never a missing object)
setSnapReadiness(async (follow) => {
  const r = residencyDebug(), warm = warmStats();
  const body = !!remotes.get(follow)?.avatar, builds = anyBuildsPending();
  return { ready: body && !builds && !r.loading && !r.standins, body, builds, models: r.real,
    loading: r.loading + r.standins, compiling: warm.pending + (warm.running ? 1 : 0) };
});
// The realizers project folded state into the scene; wired before connect() so the first snapshot's hydrated event
// finds them listening. livechat.js takes the fold-inert live verbs off the 'live-entry' bus.
initModelsRealizer();
initEnvironmentRealizer();
initSocialRealizer();
// structure after models: the structure realizer hides whatever object the models realizer made for the anchor entity
initStructureRealizer();
initStructureUI();
initCauses();

// ---------------------------------------------------------------- boot

initBoot({ world: CONFIG.world, name: CONFIG.name });
buildHelp();
const chatApi = initChat({
  send: (text) => say(text),
  typing: (to) => { sendTyping(to); getMe()?.setTyping(); },
  people,
  // the person menu and badges (people.js)
  person: { menuAt: personMenuAt, sheetFor: personSheet, stripFor: personStrip, badgeHtml: personBadge, muted: (n) => personOf(n).muted, presenting: () => isPresenting() },
});
initPeople({ mentionPerson, presenting: () => isPresenting(), toast, openModLog: (who) => openModeration({ tab: 'log', who }) });
initRolesPanels();
// the lantern prompt (Ctrl/Cmd+K): actions from lib/ui/actions.js, speech and /commands through chat's own submit
initLantern({ submit: chatApi.submit });
initActionBar();
initXRKeyboard();   // types into the last-focused text input; a quad in VR
initXRAsk();        // the centre card's questions and refusals, on a quad in VR
initWorldQuad();
initVRPanel();
settingsFrame();               // exists (hidden) so the ∃ menu can open it
initDock([
  { id: 'chat', label: '💬' },
  { id: 'world', label: '🧱' },
  { id: 'actions', label: '👋' },
  { id: 'debug', label: '🐞' },
  { id: 'settings', label: '⚙️', icon: 'gear-six' },
  // the wrench sits apart (`last`): edit is a mode, not a window. Its gate reads the server's answer (net.myRights):
  // an operator is owner everywhere but never in the fold's roles map, so a local role lookup would hide it.
  {
    id: 'edit', label: '🔧', icon: 'wrench', last: true,
    action: toggleBuildMode,
    active: () => isBuilding(),
    // while editing the wrench is the way out, so its tooltip says so
    title: (on) => (on ? 'leave builder mode (B)' : null),
    gate: () => editSurface() && mayBuildStrict(),   // no build mode on a phone (build.js editSurface)
    deadWhy: () => (editSurface() ? null : ' — builder mode is for a desktop or tablet'),
  },
]);
// the ∃ menu's Save/Load are offered to builders (the wrench's own gate), and its Log in follows the deployment's login
setMenuSources({ buildRights: () => editSurface() && mayBuildStrict(), loginUrl: () => loginUrl() });
paintPresence(presence());            // the dot needs the button: after initDock
bus.on('presence:me', paintPresence);
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
// wired before start() opens the socket: sendJoin claims the renderer role only when a capture is wired (net.js)
wireNet({ capture });   // net_capture.js — the one part of the protocol that needs a renderer
// verified identity resolves before anything reads CONFIG.name, or the door and nameplate greet a stale stored name
await initIdentity();

// The splash waits for the body to settle (on screen, or failed), never for a body to exist.
let bodySettled = false;
if (isViewer) releaseBodyGate('viewer — no body expected'); else armBodyGate();   // a body is coming: the world's parses wait for it (assets.js)
if (isViewer) {
  panelFrame().hide();
  bodySettled = true;
  markPhase('body', 1);
  start();
} else {
  // The front door: ask once for a name and a body, remember, never ask again. ?door=1 re-opens it.
  const firstRun = CONFIG.params.has('door') || (!CONFIG.params.has('name') && localStorage.getItem('ew-name-set') !== '1');
  if (firstRun) {
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


// ?sendlayout=1 — tee this browser's saved panel layout (every ew-frame-* key + the viewport), so a hand-arranged
// layout can be baked in as the default
if (CONFIG.params.has('sendlayout')) {
  bus.on('booted', () => setTimeout(() => {
    const frames = {};
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k?.startsWith('ew-frame-')) { try { frames[k.slice(9)] = JSON.parse(localStorage.getItem(k)); } catch { /* skip a bad row */ } }
    }
    tee(`[layout] ${JSON.stringify({ vw: innerWidth, vh: innerHeight, dpr: devicePixelRatio, locked: localStorage.getItem('ew-ui-locked') === '1', frames })}`);
    toast?.(`layout sent — ${Object.keys(frames).length} panels`, 'info', 4000);
  }, 1500));
}

// A desktop whose last full boot never came back boots full again (index.html decideLite, 'retry') and says so,
// with the lite client one press away.
if (globalThis.__ewLiteWhy === 'retry') statusChip({
  id: 'lite-retry', level: 'attn', label: 'last load stalled',
  title: "This world didn't finish loading last time",
  body: "We're trying the full 3D world again. If it keeps stalling or crashing here, the lite client has chat, the action bar and who's here, with no 3D.",
  actions: [{ label: 'switch to the lite client', run: () => chooseClient(true) }, { label: 'stay in 3D', clear: true }],
});

// a rejected door key re-opens the door with a key field
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
  // The SFU is the only voice transport (exactly one playback owner, #104); there is no runtime fallback by design
  // (docs/history/CUTOVER-ROLLBACK.md).
  window.__voiceTransport = 'pending:sfu';
  import('./lib/audio/voicesfubridge.js').then((m) => { m.initVoiceSfu(CONFIG.name); window.__voiceTransport = 'sfu'; })
    .catch((e) => { window.__voiceTransport = 'failed:sfu'; window.__voiceTransportError = String(e); console.error('voice init failed', e); });
  initAudioPanel();   // 🔊 categories: voices / world / TTS + consent rows
  // your own says go through the selected voice (a no-op until a voice exists and the checkbox is on). The identity
  // is the world-log id string: net.myId, what the server settled on, falling back to CONFIG.name before the join.
  import('./lib/audio/tts.js')
    .then((vs) => vs.speakOwnSays(bus, () => net.myId || CONFIG.name))
    .catch((e) => console.warn('[voice] own-say hook not installed:', e));
  initSceneGraph();   // 🌳 the world as a tree + 📜 the scripts that animate it
  const editPanels = initEditPanels();
  bus.on('build-mode', (on) => editPanels.show(!!on));
  initGizmo();        // TransformControls on the selection while a transform tool is up
  initGripEdit();     // the grip editor: a ghost hand and its handles, opened from the grabbable card
  initMaterialOverrides();   // the draft readers hesperus/material and antra/shader (docs/contributing/COMPONENT-LADDER.md)
  initInstances();           // the draft antra/instances reader
  initWorldEdge();           // @world.bounds drawn as a fence
  initEditLayout();   // the workspace: docks the frames while the mode is on (registered after show, so it docks visible frames)

  if (!isViewer) {
    // A body is never optional: if the chosen body fails to load, wear the default and say so (the stale cache is
    // cleared); if the default fails too, wear the capsule. ?capsule=1 refuses every load so the chain can be tested.
    const wear = (path) => CONFIG.params.has('capsule') ? Promise.reject(new Error('?capsule=1: body loads refused')) : makeAvatar(CONFIG.name, path, { urgent: true });   // your body skips the load queue
    resolveMyAvatarPath()
      .then((path) => wear(path).then((av) => ({ av, path })).catch((e) => {
        report('avatar', e);
        const capsule = () => { toast('no body would load — wearing the capsule until one does. Pick another in Profile.', 'warn', 12000); tee('[body] capsule stand-in (chosen + default failed)'); return { av: makeCapsuleAvatar(CONFIG.name), path: 'capsule' }; };
        if (String(path).startsWith(DEFAULT_BODY)) return capsule();
        try { localStorage.removeItem('ew-avatar-path'); } catch { /* private mode */ }
        toast(`your body (${getMyAvatarName()}) failed to load — wearing the default. Pick another in Profile.`, 'warn', 9000);
        chooseAvatar(DEFAULT_BODY, 'claude');
        return wear(DEFAULT_BODY).then((av) => ({ av, path: DEFAULT_BODY })).catch((e2) => { report('avatar default', e2); return capsule(); });      }))
      .then(({ av, path }) => {
        setMe(av);
        if (!av.isCapsule) announceWorn(path.split('/').pop().replace(/\.vrm.*$/, ''), path);   // the roster's name for this file, not a stale ew-avatar-name
        bodySettled = true;
        markPhase('body', 1);
        // a portrait of this body for the roster, deferred until the governor says calm (it costs a compile burst)
        if (!av.isCapsule) whenCalm().then(() => contributeThumbnail(getMyAvatarName(), av.vrm, CONFIG.token, { path: getMyAvatarPath() }));
      })
      .catch((e) => { bodySettled = true; markPhase('body', 1); report('avatar', e); releaseBodyGate('body failed — the world must not wait'); checkReady(); });
  }
}

// ui.js and chat.js don't import these so lite.js can share them; this client has a renderer, so it supplies them
setLoadingItems(loadingItems);
setBootAssets({ items: loadingItems, bytes: bootBytes });
registerXRPanel(chatXRPanel);

let restoredPosition = false;
wireNet({
  participants,
  myReachBag,
  toast,
  forgetBytes,    // the asset ledger, which only a client that loads assets has
  myAvatarPath: () => getMyAvatarPath(),   // a bare name: the server resolves
  myState,
  me: () => getMe(),
  myVoice: () => ({ mic: micLive(), hear: earOn() }),   // rides presence: others' hover card + agents' look
  onRestore: (r) => {
    // a remembered pose can carry null (JSON has no NaN): only finite numbers are a place; anything else is the origin
    const fin = (v, fb = 0) => (Number.isFinite(v) ? v : fb);
    restoredPosition = true;
    holdHeightUntilSolid();   // the floor it wakes on may still be downloading (arrivalhold.js)
    myState.q = r.q; myState.locomotion = r.locomotion;
    myState.pos.set(fin(r.p[0]), fin(r.p[1]), fin(r.p[2]));
    myState.yaw = r.yaw ?? 0;
    setCamYaw(myState.yaw + Math.PI); // camera behind you, facing your way
    { const m = readBodyMode(r); if (m === 'sit' || m === 'lie') setPosture(m); }   // the body-mode survives a rejoin (an older sample: read off its clip)
    // an enacted pose is authored content: wake holding it, like the spot you stood on. A remembered ragdoll
    // frame (pre-sanitizer entries) is wreckage: wake standing instead.
    // A record from before the server's sanitizer still says ragdoll: its root
    // lies below the floor the body lay on, so it wakes on that floor if the
    // record carries it, else at its root raised by how far a root lies below
    // its floor at its scale (shared/presencewire.js), not at height 0.
    // Current records arrive standing (server.ts settledPose).
    if (r.clip === 'ragdoll') { myState.pos.y = standingYFromLyingRoot(fin(r.p[1]), { floor: r.floor, scale: r.scale }); return; }
    if (r.pose) myState.pose = r.pose;
    setFolded(foldedIn(r) === true);   // the named pose wings-folded (or an older record's wingsFolded)
  },
  onSnapshotDone: () => {},
});

bus.on('sky-degraded', ({ msg }) => toast(msg, 'warn', 12000));

initOccupants();   // seat-profile verdicts (#101): fetch on boot, refresh on the two update events

// ---------------------------------------------------------------- my body
// The avatar swap rides mybody.js's import; the physics of being a body (ragdoll, seats, drag, pins, shoves) is
// localbody.js. net.js must not import the controller, so main.js is where the two meet.

setRightsHook(() => net.myRights);   // live, not captured: a role change takes effect on the next resolve
setMeHook(() => getMe());        // the fold pose is written onto the avatar

// physics in a world: carrying, throwing and punting as door requests, flights drawn from this client's own fold
setBoundsHook(() => replica.st?.entities?.['@world']?.c?.bounds ?? null);
setRespawnHooks({ fold: () => replica.st ?? null, send: (args) => thingPhysicsRequest('move', args) });   // KillZ (controller.js respawnMe)
initThingPhysics({ aim: () => clickUseApi.aimPoint(), myPos: () => myState.pos, me: () => getMe(), camera, editing: () => isBuilding(), photo: () => photoMode, seated: () => !!myState.seat || !!avatarMounts.get(CONFIG.name)?.to, myState: () => myState, flying: () => flyingNow(), capSpeed: (v, ms) => capSpeed(v, ms), mounts: () => avatarMounts });
initUsePrompt({ myPos: () => myState.pos, camera, editing: () => isBuilding(), busy: () => photoMode || isDowned() });   // E: use what's in front of you
setInputAvailable(() => net.joined && !CONFIG.renderer);   // input.js: no keys or pad while not in the world (or on a render-only client)
initClickUse({ editing: () => isBuilding(), busy: () => photoMode || isDowned(), myPos: () => myState.pos });   // the mouse: left-click a thing's primary use, right-click its menu
// reach descriptors resolve against the same bodies everyone renders
initReachNet({
  me: () => getMe(),
  myId: () => CONFIG.name,
  avatarOf: (id) => (id === CONFIG.name ? getMe() : remotes.get(id)?.avatar ?? null),
});
initMods();   // 🧩 runtime client scripts: your local trusted mods (a world offers none: its code is its server-side scripts)
initLocalBody({ logChat });
initCommands();   // the /command surface (lib/ui/commands/) + its bus subscriptions

// ---------------------------------------------------------------- keys

// The main keys as data: the handler below dispatches from this table and the lantern prompt lists it
// (lib/ui/actions.js). `id` names an existing action to merge into or a new one; `guard` gates the key only (build mode
// rebinds H and R); `plain` keys answer only with no Ctrl/Alt/Meta held (a browser's own chord stays the browser's).
const MAIN_KEYS = [
  { code: 'KeyH', key: 'H', id: 'key:help', title: 'help — keys and controls', keywords: ['?', 'keys', 'controls', 'how'], group: 'view',
    guard: () => !isBuilding(), run: () => toggleHelp() },
  { code: 'KeyB', key: 'B', id: 'panel:edit', run: () => toggleBuildMode() },
  { code: 'KeyP', key: 'P', id: 'key:photo', title: 'photo mode (free camera)', keywords: ['camera', 'picture'], group: 'view', guard: () => !isBuilding(), run: () => (helmHull() && !photoMode ? flashHint('photo mode needs the controls: get up from the helm first', 4000) : togglePhotoMode()) },   // the helm owns the keys
  { code: 'F1', key: 'F1', id: 'key:hidehud', title: 'hide the HUD', keywords: ['interface', 'clean', 'photo'], group: 'view', icon: 'eye-slash',
    prevent: true, run: () => document.body.classList.toggle('photo') },
  { code: 'F2', key: 'F2', id: 'key:screenshot', title: 'save a screenshot', keywords: ['picture', 'capture'], group: 'view', prevent: true, run: () => saveScreenshot() },
  { code: 'F3', key: 'F3', id: 'panel:debug', prevent: true, run: () => toggleDebug() },
  { code: 'KeyU', key: 'U', id: 'key:people', title: 'people here', keywords: ['who', 'present', 'roster', 'us'], group: 'panels', icon: 'users',
    plain: true, guard: () => !isBuilding(), run: () => togglePeopleHere() },   // plain: Ctrl+U is the browser's view-source
  { code: 'KeyR', key: 'R', id: 'body:limp', title: 'go limp / get up', keywords: ['ragdoll', 'fall', 'flop'], group: 'body',
    guard: () => !isBuilding(), run: () => (isDowned() ? getUp() : goLimp()) },
];
// merge-into rows keep the dock's title/run (the same act) and only add the key; new rows register whole
for (const { code, guard, prevent, plain, ...a } of MAIN_KEYS) registerAction(a.title ? a : { id: a.id, key: a.key });
registerAction({ id: 'panel:chat', key: 'Enter' });

bus.on('key', (e) => {
  if (e.code === 'Slash' && e.shiftKey) { toggleHelp(); return; }
  const k = MAIN_KEYS.find((m) => m.code === e.code && (!m.plain || !(e.ctrlKey || e.altKey || e.metaKey)) && (!m.guard || m.guard()));
  if (k) { if (k.prevent) e.preventDefault(); k.run(); return; }
  // (getting up on movement lives in updateGetUp: it sees keys, stick and touch alike, and unlike an autorepeating
  //  keydown it can require a neutral frame first: a shove must outlive the key you were holding)
  // gestures on the number row, in the action bar's order (_actionbar.json): a ninth listed gesture gets a key for free
  const n = /^Digit([1-9])$/.exec(e.code);
  const me = getMe();
  if (n && me) {
    const name = ANIM_ORDER[Number(n[1]) - 1];
    if (!name) return;
    me.playOnce(name);
    myState.anim = name;
    flashHint(name);
  }
});

// ---------------------------------------------------------------- roster

function people() {
  const list = [{ id: CONFIG.name, me: true, dist: null, presence: presence() }];
  for (const r of remotes.values()) {
    list.push({
      id: r.id, me: false, declares: r.declares ?? null, presence: r.presence ?? 'present',
      dist: r.avatar ? r.avatar.root.position.distanceTo(myState.pos) : null,
    });
  }
  return list;
}

// ---------------------------------------------------------------- readiness
// "Ready" is the moment there is something to stand in: the body settled, the log folded, no heavy build running.

let hydrated = false, propsWait = false;
bus.on('hydrated', () => {
  updateWater();
  if (!restoredPosition) respawnMe(replica.st);   // @world.spawn or a spawn-point, facing its yaw (shared/spawn.js spawnOf)
  hydrated = true; checkReady();
});
bus.on('world-reset', () => { restoredPosition=false;myState.q=undefined;myState.locomotion=undefined; });

// An empty world (a mistyped name, usually) looks broken: no ground, no sky, no objects. Say so.
bus.on('hydrated', () => {
  // the same test net.js uses to keep or forget the remembered world, so the notice and the memory agree on "empty"
  if (entities.size > 0 || builtIn(worldState.st)) return;
  logChat('*', emptyWorldNotice(CONFIG));   // which words depend on how the page got here (base.js)
  logChat('*', 'press B to start building, or ? for the controls.');
  toast(`"${CONFIG.world}" is an empty world — press B to build in it`, 'warn', 14000);
});
bus.on('build-queue', checkReady);

function checkReady() {
  if (bootDone()) return;
  if (!bodySettled || !hydrated || buildsPending() > 0) return;
  // …and every prop inside residency radius has landed (far entities never schedule a load, so they can't hold the
  // door); boot.js's skip button and ceiling remain
  if (pending(P.FAR) > 0) { if (!propsWait) { propsWait = true; onIdle(() => { propsWait = false; checkReady(); }, P.FAR); } return; }
  // one frame with everything in place before the curtain lifts
  requestAnimationFrame(() => requestAnimationFrame(() => finishBoot('ready')));
}

// a world with no entities drains its build queue before anything subscribes: poll as a backstop
const readyPoll = setInterval(() => {
  if (bootDone()) { clearInterval(readyPoll); return; }
  checkReady();
}, 400);

// ---------------------------------------------------------------- frame loop
// The loop lives in lib/render/frameloop.js; this is the list, and registration order is execution order: motion before
// remotes, sky → materials → rig, voice mouths before the avatar update, bodydrag before remotes, gaze after,
// send-pose after every myState writer but the XR tick (updateXR's NaN restore runs after it), render last but for
// the XR desktop mirror. Each system is timed (EW.frame() prints the bill) and the governor may stride cosmetic ones.
// The governor + HUD ride the 1 Hz pulse, registered last.

registerSystem('autos', (dt, t) => updateAutoSystems(t));       // grass wind, particles
registerSystem('motion', () => tickMotion());                   // the world's moving parts
registerSystem('lookat', () => tickLookAt());                   // look-at: things turn to face something (after motion)
registerSystem('texts', () => tickTexts());                     // signs that turn to face you
registerSystem('openable', () => tickOpenables());           // doors, gates and lids tween to their state
registerSystem('sky', (dt, t, now) => { updateSky(now, t); applyEnvLight(); });   // an authored environment's sun wins, before the rig fits shadows
registerSystem('materials', (dt, t, now) => updateMaterials(now)); // weather → uniforms
registerSystem('rig', (dt, t, now) => updateRig(now));          // light slots follow requests
registerSystem('sounds', () => tickSounds(), { every: 2 });      // panners follow entities, the listener the camera
setWaterObjects(() => entities);
setClimbObjects(() => entities);   // climb routes resolve through their hosts' live objects (client/lib/player/climb.js)
setWaterClock(serverNow);
setSkyHider(hideSkyForWater);
registerSystem('water', updateWater);
registerSystem('me-drive', (dt) => {
  updateInput(dt);
  updateGetUp();                            // movement stands a limp body up, once it starts fresh
  if (CONFIG.renderer) { /* camera is driven per snap request */ }
  else if (CONFIG.spectate) updateSpectator(dt, CONFIG.follow ? remotes.get(CONFIG.follow) : null);
  else if (isDowned()) { myState.q = undefined; myState.locomotion = undefined; const me = getMe(); if (me) me.locomotion = null; stepRagdoll(dt); }     // the controller yields while limp
  else if (avatarMounts.has(CONFIG.name) || seatLeaving()) { if (updateHelm(dt) && photoMode) togglePhotoMode(); updateMountedMe(dt); }  // seated (or being carried off a seat): derived, not driven; at a helm the hull moves first, and owns the camera: never photo mode with it
  else updateMe(dt, getMe());
  updateSeatHint(dt);            // "X — sit" while a declared seat is in reach
});
registerSystem('held-pose', () => {
  // my own held pose, applied on change; while downed the ragdoll owns setPose
  const me = getMe();
  if (!isDowned() && me && myState.pose !== me._poseSig) {
    me._poseSig = myState.pose;
    if (myState.pose) me.setPose(myState.pose); else me.clearPose();
  }
});
// XR body before me-update: humanoid bone writes must precede vrm.update or they never reach the skeleton
registerSystem('xrbody', () => ensureXRBodyHook());   // the chain itself runs inside Avatar.update(), before vrm.update
registerSystem('me-update', (dt, t, now) => {
  updateVoiceMouths(now);        // before the avatar update that consumes it
  getMe()?.update(dt, now);
});
registerSystem('bodydrag', (dt, t, now) => updateBodyDrag(dt, now)); // before remotes: the takeover pose lands in this frame's avatar.update
registerSystem('mods', (dt, t, now) => tickMods(dt, now));       // 🧩 runtime scripts
registerSystem('remotes', (dt, t, now) => updateRemotes(dt, now));
registerSystem('gaze', (dt, t, now) => updateGaze(myState.pos, getMe(), CONFIG.name, now));
// the hover card beside a nameplate (desktop pointer, touch tap, VR laser) — after gaze, before render
initPlates({ camera, canvas, scene, remotes, myPos: () => (getMe() ? myState.pos : null), presenting: () => isPresenting(),
  mentionPerson, colorFor, personMenu: (n, x, y) => (isPhone() ? personSheet(n) : personMenuAt(n, x, y)), personStrip });
registerSystem('plates', (dt, t, now) => updatePlates(now));
registerSystem('build', () => updateBuild());
registerSystem('promote-tail', () => drainPromoteTail());        // promote boulders (colliders/lamps/casters) ≤~4 ms/frame; before 'debug' so F3 sees same-frame colliders
registerSystem('debug', (dt, t, now) => updateDebug(now));       // F3 wireframes
registerSystem('send-pose', (dt, t, now) => sendPose(now));
// XR: read hands → fill intent (updateMe already moved the body) → rig follows
registerSystem('xr', (dt) => updateXR(dt));
registerSystem('water-view', () => updateWaterView());   // after the camera's last move this frame (movement, XR): the level's fog and background
registerSystem('xrvignette', (dt) => tickXRVignette(dt));   // comfort tunnel, on the XR camera (Settings › VR)
registerSystem('pixel-ratio', () => applyPendingPixelRatio());   // a resize clears the canvas: before the draw, never after
registerSystem('instances', () => tickInstances());   // a thing's instanced copies take its pose after everything that moves a thing this frame (motion, build drags, XR grabs): never a frame behind
registerSystem('render', renderWorld);
registerSystem('xrmirror', () => tickXRMirror());           // desktop view while presenting (Settings › VR)
// radial-menu actions: the ring speaks through the same flows the keyboard does
bus.on('xr:sit', () => { if (!xrTrySitOn(null)) setPosture('sit'); });
bus.on('xr:stand', () => xrDismountMe('menu'));
bus.on('xr:mic', async () => { const { xrMicPress } = await import('./lib/xr/vrmic.js'); await xrMicPress(); });   // a bounded permission try in VR (vrmic.js)
bus.on('xr:select', (id) => sceneSelect(id));
globalThis.__waterDebug = waterDebug;
let _pulseAt = 0;
registerSystem('pulse', (dt, t, now) => {
  if (now - _pulseAt < 1000) return;
  _pulseAt = now;
  governPerformance(perf.fps);
  paintHud(net.status);
});

startFrame();   // explicit — the loop starts only after identity resolved
initXR();               // the VR chip appears only where immersive-vr is supported
bindXRSelf(() => getMe());   // first-person split + own-label hide need the body
bindXRBodySelf(() => getMe());
setPoseOverride(() => ((isPresenting() || xrSimActive()) ? { yaw: xrAvatarYaw() ?? undefined, pitch: xrLookPitch(), xr: xrWire() ?? undefined } : null));

// idle bandwidth streams the rest of the library into the HTTP cache (prefetch.js; ?prefetch=0 opts out)
startPrefetch().catch((e) => report('prefetch', e));

// ---------------------------------------------------------------- debug

// setVoice(name) — load a voice model from voices/ at any time, through the same loadFromFiles() the picker uses,
// so an agent changes voice without a restart. ?voice= calls it once at boot. Inference runs in this browser.
async function setVoice(name) {
  if (!name) {                       // go quiet, keep the lane
    const { setTtsSource, setTtsEnabled } = await import('./lib/audio/tts.js');
    setTtsSource(null); setTtsEnabled(false);
    return { ok: true, voice: null };
  }
  const base = new URL(`voices/${name}`, location.href).href;
  const [onnx, cfg] = await Promise.all([
    fetch(`${base}.onnx`).then((r) => { if (!r.ok) throw new Error(`${name}.onnx: ${r.status}`); return r.blob(); }),
    fetch(`${base}.onnx.json`).then((r) => { if (!r.ok) throw new Error(`${name}.onnx.json: ${r.status}`); return r.blob(); }),
  ]);
  const files = [new File([onnx], `${name}.onnx`), new File([cfg], `${name}.onnx.json`)];
  const { loadFromFiles } = await import('./lib/audio/voiceengines.js');
  await import('./lib/audio/engines.js');
  const { label } = await loadFromFiles(files, (p) =>
    console.log(`[voice] ${p.text || p.phase || 'loading'}`));
  const { setTtsEnabled } = await import('./lib/audio/tts.js');
  setTtsEnabled(true);
  console.log(`[voice] speaking with ${label} — loaded from disk, no server`);
  return { ok: true, voice: label };
}
if (typeof window !== 'undefined') window.setVoice = setVoice;   // console, harness, or an agent mid-session
{
  const want = CONFIG.params.get('voice');
  if (want) setVoice(want).catch((e) => console.warn('[voice] ?voice failed:', e));
}

// Opt-in synthesized voice endpoint: ?tts or ?tts=<port>. Absent, no endpoint connects (a voice chosen in the audio
// panel, ttsrow.js, is still a source).
{
  const q = CONFIG.params;
  if (q.has('tts')) {
    const port = Number(q.get('tts')) || 8927;
    import('./lib/audio/piperbridge.js')
      .then((m) => m.initPiperVoice({ port }))
      .then(async (ok) => {
        console.log(ok ? `[voice] synthesized voice ready on :${port}`
                       : `[voice] no synthesizer on :${port} — falling back to browser speech`);
        if (!ok) {
          // no synthesizer: fall back to the browser's own voice, which is better than silence
          try {
            const { speechSynthesis } = window;
            if (!speechSynthesis) { console.warn('[voice] no speechSynthesis — microphone only'); return; }
            const vs0 = await import('./lib/audio/tts.js');
            // Web Speech renders to the speakers, not to PCM for the mic lane: audible locally, not transmitted
            vs0.setTtsSource(async (text) => {
              try { speechSynthesis.speak(new SpeechSynthesisUtterance(text)); } catch {}
              return { pcm: new Int16Array(0), sampleRate: 22050, localOnly: true };
            }, 'browser speech (local only — peers will NOT hear this)');
            vs0.setTtsEnabled(true);
            console.warn('[voice] FALLBACK: browser speech. Audible to YOU, not to peers.'
                       + ` Start a synthesizer on :${port} for transmitted voice.`);
          } catch (e) { console.warn('[voice] browser-speech fallback failed:', e); return; }
        }
        const vs = await import('./lib/audio/tts.js');
        // (the own-say hook is installed once, in start(); here would speak each line twice.) A body with a voice
        // means to be heard: open the mic lane. The probe seam goes first, before anything that can hang.
        globalThis.__voiceProbe = () => ({ ...vs.mouthInfo(), track: vs.genTrackInfo() });
        globalThis.__voiceSpeak = (t) => vs.speak(t);   // the APP's mouth, for probes
        const { toggleMic, micOn } = await import('./lib/audio/micstate.js');
        // open the lane the transport owns — the SFU bridge's when it is up — so there is one playback owner
        if (typeof window.__sfuMic === 'function') {
          if (!window.__sfuMicOn?.()) await window.__sfuMic();
        } else if (!micOn()) {
          await toggleMic(CONFIG.name);
        }
        console.log('[voice] TTS wiring complete');
      })
      .catch((e) => console.error('[voice] TTS wiring failed:', e?.message || e));
  }
}

// console probes: my own body, and every body in the scene (otherwise reachable only through private maps)
globalThis.__me = () => getMe();
globalThis.__bodies = () => [
  ...(getMe() ? [['me', getMe()]] : []),
  ...[...remotes.entries()].map(([id, r]) => [id, r.avatar]),
].filter(([, av]) => av).map(([who, av]) => ({
  who,
  limp: !!av._limp,
  clip: av.currentSlot ?? null,
  // at most one of these is true of a limp body: the local sim owns the hair and wings, or three-vrm does (a body with
  // no spring bones, e.g. the capsule, has neither)
  simOwnsDressing: !!av.__simHair,
  springbonesRunning: !av.__simHair && !!av.vrm?.springBoneManager,
  avatar: av,
}));
// The audio isolation test, from the console. It needs a click first for the context, so it reports the context state.
globalThis.testAudioLayers = async () => {
  // the shared context: one of its own could exhaust the context budget and report silence it caused
  const { audioContext } = await import('./lib/audio/audioctx.js');
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
      'below the page · all → page fine', 'color:#fc6');
  }, 3000);
  console.log('%c[audio] ' + JSON.stringify(r, null, 1), 'font-size:14px;color:#6cf');
  return r;
};

// the water's waves run on the world's synced clock, so the swell a swimmer rises on is the one everyone sees
setWaveClock(() => participants.serverNow());

const EW = globalThis.EW = {
  me: () => getMe(), remotes, entities, myState, THREE, net, scene, camera, renderer, bus, sendRequest,
  avatarMounts, serverNow, bagOf, bags,   // who sits where, the sequencer's clock, a thing's fold record / every thing's
  seatSocket, socketsOn,   // a seat ({to: <socket id>}) as {id, host, name, sock}; a thing's sockets
  skyArgs, setPosable, get posable() { return posable(); },
  // EW.pose, EW.clearPose, EW.animate — the same verbs an agent's tools have (posecommands.js)
  ...poseCommands({ state: myState, sendPuppet, play: (a) => { getMe()?.playAnimation(a); sendAnim(a); } }),
  // EW.terrain(patch) edits the world's current terrain bag rather than replacing it, e.g.
  //   EW.terrain({ features: [{ type: 'hill', x: 30, z: -20, radius: 18, height: 9 }] })
  // Feature types: shared/terrainshape.js. Heightmaps: the ground panel's export/import, or GET /heightmap?world=<name>.
  terrain: (patch = {}) => {
    const cur = terrainEditBase() ?? { seed: 7, size: 160, segments: 200, amplitude: 2.6, flatRadius: 16 };
    const next = noteTerrainSent({ ...cur, ...patch });   // a second quick edit composes with this one
    sendRequest('set', { id: '@world', component: 'terrain', value: next });   // the ground is @world's terrain component
    return next;
  },
  get terrainArgs() { return currentTerrainArgs(); },
  // EW.sculpt({brush: 'lower', path: [[x, z], …], radius: 3, strength: 0.4}) is one brush stroke on the ground (the
  // authority's sculpt; no path: where your body stands). EW.feature('cove', {type: 'hill', x, z, radius, height}) sets
  // one named shape of the ground, EW.feature('cove', null) removes it (@world's terrain-feature:<name>).
  sculpt: (args = {}) => sendRequest('sculpt', args),
  feature: (name, value) => (value == null ? sendRequest('delete', { id: '@world', component: `terrain-feature:${name}` }) : sendRequest('set', { id: '@world', component: `terrain-feature:${name}`, value })),
  // the ground as walking reads it, and whether a heightmap terrain is still waiting on its image
  groundAt: (x, z) => heightAt(x, z), get hasTerrain() { return hasTerrain(); },
  get terrainPending() { return terrainPending(); },
  setPushable, get pushable() { return pushable(); }, dragState,
  // reach: aim a hand at a named contact point (the palm turns to meet its surface), a world point, or a live function:
  //     EW.reach('rightHand', 'head_top')                 // your own head
  //     EW.reach('rightHand', ['mythos', 'shoulder_l'])   // someone else's
  //     EW.reach('rightHand', () => [x, y, z])            // a bare point
  // Serializable targets ride the presence stream through reachnet.js, so others see the arm; a function stays local.
  reach: (key, target, opts) => {
    if (typeof target === 'function') return getMe()?.setReach(key, target, opts);
    const err = setMyReach(key, target, opts);
    if (err) { console.warn(`[reach] ${err}`); return false; }
    return true;
  },
  // landmarks: named contact points, derived per body from its own mesh and cached; EW.showLandmarks() draws them
  landmarks: (who) => {
    const av = who ? remotes.get(who)?.avatar : getMe();
    if (!av) return null;
    av.__marks ??= deriveLandmarks(av);
    return av.__marks;
  },
  // where a named contact point on a body is now, in world space; `standoff` lifts it off the skin
  contactAt: (who, name, standoff = 0.02) => {
    const av = who ? remotes.get(who)?.avatar : getMe();
    if (!av) return null;
    av.__marks ??= deriveLandmarks(av);
    const e = av.__marks.get(canonicalPoint(name) ?? name);
    const hit = e && landmarkWorld(e, standoff);
    return hit ? hit.pos.toArray() : null;
  },
  reachVersion: 'reach-6 contact-allowance 2026-08-20',   // bumped when the reach solver changes, so a diagnostic can say which code produced its numbers
  get avatarPath() { try { return getMyAvatarPath() || '(unknown)'; } catch { return '(unknown)'; } },   // vrm.scene.name is often blank
  // which contact points on a body can a hand actually get to: one solve per (point, hand) against the derived landmarks
  reachAudit: (who, standoff = 0.02) => {
    // landmarks come from the body being touched; the reaching chains are always mine
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
        // a limb cannot touch itself: skip the chain that owns the landmark
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
  // position and surface normal, so a reach can put the palm on it
  contactFrame: (who, name, standoff = 0.02) => {
    const av = who ? remotes.get(who)?.avatar : getMe();
    if (!av) return null;
    av.__marks ??= deriveLandmarks(av);
    const e = av.__marks.get(canonicalPoint(name) ?? name);
    const hit = e && landmarkWorld(e, standoff);
    return hit ? { pos: hit.pos.toArray(), normal: hit.normal.toArray() } : null;
  },
  // a green disc on the side of the hand the code believes is the palm: pointing away means the palm axis is wrong on that rig
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
  physics: physicsApi, // grab/put/throw/drop/punt as door requests (thingphysics.js): what runtime mods script against
  mods: modsApi,     // list/put/run/stop your local runtime client scripts (🧩); put and run need your click
  bodysim: { engine: bodyEngine, setEngine: setBodyEngine, list: listBodyEngines },  // swappable body physics
  foldParity,        // fold-vs-scene drift probe (client/lib/debug/parity.js)
  reconcileModels,   // force a full realizer pass (idempotent)
  materials: materialsDebug,   // factory counters + live weather uniforms
  lightrig: rigDebug,          // slot pool + request table
  lampShadow: lampShadowState,   // the chest lamp's shadow map + derived bias
  setLampShadow,                 // ({map, texels, dist}) — live, bias re-derived

  governor: governorDebug,     // the two-way lever ladder
  residency: residencyDebug,   // real/stand-in/loading counts + sweep stats
  gpu: () => ({ ...renderer.info.memory, ...protoStats() }),   // bytes + proto/byte tiers
  draws: drawStats,
  foliage: () => import('./lib/vegetation/foliage.js').then((m) => m.foliageDebug()),
  overdraw: (opts) => import('./lib/debug/overdraw.js').then((m) => m.overdrawCapture(opts)),   // fragments shaded per pixel, by category
  setDrawBatching,
  frame: frameDebug,           // per-system rolling ms + strides
  grass: grassTiles,           // tile-level draw truth
  simShown,                    // the sim as drawn: a copy of this client's sim layer at the server's clock
  grassDiag,                   // `await EW.grassDiag()` — the meadow's GPU cost, attributed by difference
  setCloudQuality,             // the sky pane's tier knob
  water: waterDebug,
  warm: warmStats,             // the warm conductor's queue
  budget: budgetStats,         // the shared per-frame background budget: share, debt, per-lane spend/grants/denials
  lanes: () => ({ sched: schedLaneStats(), load: loadLaneStats() }),  // queue depths vs caps
  colliderCache: colliderCacheStats,   // per-lib shared BVH/lie bytes
};

} // end of the normal-boot branch (?mintthumbs takes the path above)
