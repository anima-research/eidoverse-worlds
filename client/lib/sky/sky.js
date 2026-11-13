// sky — time of day, weather, and the lighting that follows from them.
//
// Two implementations behind one verb ({hours, rate, weather, clouds, …}; the world log never sees which answers):
//   1. the sky engine's world packages (`makeSky({world})` from the library's sky_worlds.js): a raymarched atmosphere,
//      volumetric clouds, weather with rain and lightning, baked environment reflections;
//   2. three's SkyMesh, the fallback.
// Quality tiers and the VR rules: docs/research/sky-quality-and-vr.md.

import { THREE, scene, sun, hemi, renderer, camera } from '../core.js';
// ?shadowdebug=1 dims the fill to a fifth so the shadow map's coverage is legible (sun shadows read only ~10% darker)
const SHADOW_DEBUG_FILL = CONFIG.params.has('shadowdebug') ? 0.2 : 1;
import { report, bus, tee, teeNow, CONFIG } from '../base.js';
import { serverNow } from '../serverclock.js';   // a server stamp is read on the authority's clock
import { loadEidoModule, primeFiles, listLibrary, fetchBytes } from '../assets.js';
import { markPhase } from '../boot.js';
import { bandCuts, bandedBakeRender, bakeGeneration } from './sky_baked.js';
import { bakedDomeObject } from './sky_baked.js';
import { BAKE_INTERCEPT, attachBakedDome, detachBakedDome, updateBakedDome, bakedActive, requestBake, holdLiveDomes, releaseLiveDomes, liveDomesHeld, takeHeldDomes,
  envTexture, adoptEnvironment, whenBakeReady, bakedRefreshing } from './sky_baked.js';
import { beginWork } from '../loadwork.js';
import { makeSwapChain, SHOWN_UNKNOWN } from './sky_swapchain.js';
import { serializeBakes as serializeBakesWith, BAKE_GUARD, BAKE_AFTER, BAKE_HELD } from './sky_bakelock.js';
import { showInterimSky, interimSkyObject, updateInterimSky, hideInterimSky, interimSkyShown } from './sky_interim.js';
import { busy as loadingBusy } from '../framebudget.js';
import { bootDone } from '../boot.js';
import { setDayness, releaseForeignLights } from '../lightrig.js';
import { warm, P_AMBIENT } from '../warmqueue.js';
import { WEATHERS, CLOUDS, effectiveSky, hoursAt, skyTicks } from '../../../shared/forecast.js';
import { claimUnowned, releaseHook } from '../autohooks.js';
import { rainSurfaceAt } from '../terrain.js';

// the environment exists from the first frame (black) so every material's lighting graph is born with its env branch;
// flipping null→texture later would recompile every PBR material. Bakes change the content, never the object.
scene.environment = envTexture();

// ---------------------------------------------------------------- state

let impl = null;           // 'eidoverse' | 'skymesh' | null
let skyApi = null;         // the engine's sky object when impl === 'eidoverse'
let skyInner = null;       // skyApi._internals.sky, the engine's declared escape hatch
let skyMesh = null;
// the skymesh-path fill light is born eagerly: a light appearing later recompiles every lit material
const fillLight = new THREE.DirectionalLight(0xffffff, 0);
scene.add(fillLight);
let clock = null;          // { args, t0 } — the server-stamped epoch
let currentWorld = null;

export const skyArgs = () => clock?.args ?? {};
export const skyImpl = () => impl;
// the engine's own quality tier is this viewer's: balanced, or high; read at the next build
export const SKY_QUALITY = ['balanced', 'high'];
let chosenQuality = null;   // this session's choice, kept even where storage refuses
export const skyQuality = () => { if (chosenQuality) return chosenQuality; try { return localStorage.getItem('ew-sky-quality') === 'high' ? 'high' : 'balanced'; } catch { return 'balanced'; } };
export function setSkyQuality(q) { chosenQuality = q === 'high' ? 'high' : 'balanced'; try { localStorage.setItem('ew-sky-quality', chosenQuality); } catch { /* this session only */ } }
/** The sky-owned scene roots, for the perf diagnostics' cost attribution. Read-only. */
export const skyOwnedObjects = () => skyOwned ?? [];
/** Under the world's water (realize/watervolumes.js): the sky draws unfogged, so it is hidden while the camera is
 *  below the surface. Each object goes back to the visibility it had. */
const hiddenForWater = new Map();
export function hideSkyForWater(hide) {
  if (hide) { for (const o of [skyMesh, ...(skyOwned ?? []), bakedDomeObject(), interimSkyObject()]) if (o && !hiddenForWater.has(o)) { hiddenForWater.set(o, o.visible); o.visible = false; } }
  else { for (const [o, v] of hiddenForWater) o.visible = v; hiddenForWater.clear(); }
}
/** 0 at night → 1 at noon. Lamps and other night-aware things read this. */
export let dayness = 1;

// ---------------------------------------------------------------- quality
//
// The volumetric cloud march is the most expensive thing this client draws. Every tier below 'high' shows a baked sky
// (sky_baked.js): the same march rendered into the env-bake equirect and shown on a static dome, re-baked when the sky
// changes. A client preference, never world state: one person's GPU must not dictate everyone's sky.
export const CLOUD_QUALITY = ['off', 'low', 'medium', 'high'];
// low, medium and high construct the same sky system, so a switch among them only swaps what's shown; 'off' builds its own
const QUALITY_OPTS = {
  off: { cloudPasses: 1 },                     // plus setClouds('clear') below
  low: {},
  medium: {},
  high: {},                                    // the live march
};
if (localStorage.getItem('ew-cloud-quality') === 'live') localStorage.setItem('ew-cloud-quality', 'high');   // a retired tier
// Baked-tier bake parameters ('high' is the live march). bakeEnv keys its cached graph on (W, H, passes), so a changed
// value rebuilds the march pipeline. intervalMs is the crossfade cadence. The bake is banded, so a bigger equirect
// costs bake latency, not frame rate.
const BAKED_TIERS = {
  off: { width: 1024, height: 512, cloudPasses: 1, intervalMs: 12000 },   // clear sky anyway
  low: { width: 2048, height: 1024, cloudPasses: 3, intervalMs: 12000 },
  medium: { width: 4096, height: 2048, cloudPasses: 8, intervalMs: 9000 },
};
const bakeOpts = () => {
  const { width, height, cloudPasses } = BAKED_TIERS[cloudQuality] ?? {};
  // 'off' bakes no cloud branch whatever the weather (the engine respells the preset under storm/rain/overcast)
  return width ? { width, height, cloudPasses, ...(cloudQuality === 'off' ? { includeClouds: false } : {}) } : {};
};
let cloudQuality = localStorage.getItem('ew-cloud-quality') ?? 'medium';
const BAND_BUDGET = 0.4e6;   // texels × passes per boot-bake band (sky_baked.js's cadence budget)
export const getCloudQuality = () => cloudQuality;

// VR cap: in a headset on the WebGL backend, clouds never run 'high' (the live march per eye is far too slow, and each
// eye marches its own noise); 'medium' runs instead and the saved choice comes back on exit. Revisit with WebGPU-XR.
let xrPresenting = false;
let xrCappedFrom = null;          // the level the cap replaced, restored on exit
const CAP_FROM = 'high', CAP_TO = 'medium';
const vrCapApplies = () => xrPresenting && !!renderer.backend?.isWebGLBackend;
// No sky rebuild while presenting: it can hold the GPU long enough to trip the driver watchdog and lose the session.
// A quality flip or a sky-world switch waits for the exit; the world's own sky changes still apply.
let heldQuality = null;           // a quality chosen in the headset, applied at exit
let heldRebuild = false;          // a sky-world switch that arrived in the headset
/** What the headset is holding back, for the probe and the debug panel: { quality, rebuild } or null. */
export const skyHeld = () => (heldQuality || heldRebuild ? { quality: heldQuality, rebuild: heldRebuild } : null);
// In a headset the live march never shows when a baked dome is on its way: held out until it attaches, the gradient
// standing in. 'high', and a build whose baked dome failed to attach, keep the march (a costly sky beats no clouds).
let attachFailedFor = null;       // the sky build whose baked dome could not attach
let bakeRetriedFor = null;        // the sky build whose failed bake already had its one retry
let headsetGradient = false;      // the gradient is up because holdLiveInHeadset put it there
function holdLiveInHeadset() {
  if (!xrPresenting || !BAKED_TIERS[cloudQuality] || cloudQuality === 'off' || bakedActive() || attachFailedFor === skyApi) return;
  if (holdLiveDomes(skyApi, 'in a headset until the baked dome is ready') && !interimSkyShown()) { showInterimSky(skyInner?.uniforms); headsetGradient = true; }
}
// the cap's deferred flip at entry (waiting for the entry curtain), cleared at every entry and exit
let capWait = null;
const clearCapWait = () => { capWait?.off?.(); clearTimeout(capWait?.tm); capWait = null; };
bus.on('xr:state', (on) => {
  xrPresenting = !!on;
  clearCapWait();
  if (on) { headsetGradient = false; holdLiveInHeadset(); }
  else if (!interimFor) {
    releaseLiveDomes();   // the desktop shows the live march until its bake lands
    if (headsetGradient && !swapping && !building) hideInterimSky();   // a swap in flight or a rebuild keeps its own gradient
  }
  headsetGradient = headsetGradient && !!on;
  // at exit, what was held applies: a held quality first, then a held sky-world switch once the sky is up. With the
  // cap active, a held quality is the cap's stand-in and the restore below replaces it.
  if (!on && (heldQuality || heldRebuild) && !xrCappedFrom) {
    const q = heldQuality, w = heldRebuild; heldQuality = null; heldRebuild = false;
    tee(`[sky] VR exit: applying the sky change held during the session (${[q && `clouds → ${q}`, w && 'sky world'].filter(Boolean).join(', ')})`);
    const done = q ? setCloudQuality(q, { persist: false }).catch((e) => report('sky held change (exit)', e)) : Promise.resolve();
    if (w) applyHeldWorldWhenUp(done);   // both held: the world rides after the quality
    return;
  }
  const heldWorld = !on && heldRebuild && !!xrCappedFrom;   // a world switch held while capped rides after the restore
  if (!on) { heldQuality = null; heldRebuild = false; }
  // the tier the sky is running or about to arrive as: a pending 'high' at entry is capped too
  if (on && vrCapApplies() && (pendingTier ?? cloudQuality) === CAP_FROM) {
    xrCappedFrom = CAP_FROM;
    if (pendingTier === CAP_FROM) pendingTier = CAP_TO === cloudQuality ? null : CAP_TO;
    tee(`[sky] VR on WebGL: clouds capped ${CAP_FROM} → ${CAP_TO} (baked) for the session (the saved choice stays ${CAP_FROM})`);
    bus.emit('cloud-cap', { from: CAP_FROM, to: CAP_TO });
    // after the entry curtain is on screen (xr.js), so the swap's bake doesn't take the GPU before the headset's
    // first frames; a session that ends first must not drop the desktop to medium
    const w = capWait = { off: null, tm: 0 };
    const go = () => { if (capWait !== w) return; clearCapWait(); if (!xrPresenting || xrCappedFrom !== CAP_FROM) return;
      setCloudQuality(CAP_TO, { persist: false, capFlip: true }).catch((e) => report('sky VR cap', e));
      holdLiveInHeadset();   // a re-entry during the previous session's cap bake
    };
    w.off = bus.on('xr:curtain-shown', go); w.tm = setTimeout(go, 4000);
  } else if (!on && xrCappedFrom) {
    const back = xrCappedFrom; xrCappedFrom = null;
    tee(`[sky] VR exit: clouds back to ${back}`);
    bus.emit('cloud-cap', null);
    setCloudQuality(back, { persist: false }).catch((e) => report('sky VR cap (exit)', e))
      .then(() => { if (heldWorld) applyHeldWorldWhenUp(Promise.resolve()); });
  }
});

// a held sky-world switch, applied once the preceding change has settled and the sky is up, outside a headset
function applyHeldWorldWhenUp(after) {
  after.then(() => whenSkyUp()).then(() => {
    if (xrPresenting) { heldRebuild = true; return; }
    tee('[sky] VR exit: applying the sky world held during the session'); skyBuilds = 0; if (clock) render();
  });
}
/** The VR cap in force, for the sky panel's note: { from, to } or null. */
export const cloudCap = () => (xrCappedFrom ? { from: xrCappedFrom, to: CAP_TO } : null);
/** What the person chose (a settings row shows this), not the level the VR cap is running meanwhile. */
export const getCloudChoice = () => xrCappedFrom ?? heldQuality ?? pendingTier ?? cloudQuality;
export const skyInXR = () => xrPresenting;

// Where a sky rebuild's main-thread time goes: one teed line per rebuild, each phase's wall time plus the long tasks
// (Chrome's longtask entries) inside it.
let phaseLog = null;
function phase(name) {
  if (!phaseLog) return;
  const now = performance.now();
  phaseLog.marks.push([name, now]);
}
function beginPhases(why) {
  const obs = typeof PerformanceObserver !== 'undefined' && PerformanceObserver.supportedEntryTypes?.includes('longtask')
    ? new PerformanceObserver((l) => { for (const e of l.getEntries()) phaseLog?.long.push([e.startTime, e.duration]); }) : null;
  try { obs?.observe({ type: 'longtask', buffered: false }); } catch { /* unsupported */ }
  phaseLog = { why, t0: performance.now(), marks: [], long: [], obs };
}
function endPhases() {
  const L = phaseLog; if (!L) return; phaseLog = null;
  L.obs?.disconnect();
  const pts = [['start', L.t0], ...L.marks, ['end', performance.now()]];
  const parts = [];
  for (let i = 1; i < pts.length; i++) {
    const [name, t] = pts[i], t0 = pts[i - 1][1];
    const lt = L.long.filter(([s0]) => s0 >= t0 && s0 < t);
    const blk = lt.reduce((a, [, d]) => a + d, 0), mx = lt.reduce((a, [, d]) => Math.max(a, d), 0);
    parts.push(`${name} ${(t - t0).toFixed(0)}ms${lt.length ? ` (long ${lt.length}×, ${blk.toFixed(0)}ms, max ${mx.toFixed(0)})` : ''}`);
  }
  const all = L.long.reduce((a, [, d]) => a + d, 0);
  tee(`[sky] rebuild (${L.why}): ${parts.join(' | ')} — main thread blocked ${all.toFixed(0)}ms total${L.obs ? '' : ' (no longtask API)'}`);
}

/** Change the local cloud tier: a same-system swap where possible, else a rebuild. */
export async function setCloudQuality(level, { persist = true, capFlip = false } = {}) {
  if (!CLOUD_QUALITY.includes(level)) return;
  // asking for 'high' inside a WebGL headset session: remember it for the exit, run the baked 'medium' now
  if (level === CAP_FROM && vrCapApplies()) {
    xrCappedFrom = CAP_FROM;
    if (persist) localStorage.setItem('ew-cloud-quality', level);
    tee(`[sky] VR on WebGL: ${CAP_FROM} clouds held at ${CAP_TO} (baked) until exit`);
    bus.emit('cloud-cap', { from: CAP_FROM, to: CAP_TO });
    level = CAP_TO;
    persist = false;
  }
  else if (persist && xrPresenting && xrCappedFrom) { xrCappedFrom = null; bus.emit('cloud-cap', null); }   // a deliberate uncapped choice in the headset replaces the cap's memory
  if (persist) localStorage.setItem('ew-cloud-quality', level);   // choosing the level already running is still a choice
  // choosing the running tier again also cancels a tier queued while the sky was arriving
  if (level === cloudQuality) { heldQuality = null; if (pendingTier) { pendingTier = null; tee(`[sky] queued tier cancelled: staying ${level}`); } return; }
  if (xrPresenting && !capFlip) {   // capFlip: the VR cap's own entry flip, the one change let through
    heldQuality = level;
    tee(`[sky] clouds ${cloudQuality}→${level} held until VR exit (a rebuild in the headset stalls it for seconds)`);
    bus.emit('sky-held', { quality: level });
    return;
  }
  bakeRetriedFor = null;   // a new choice gets its own single retry of a failed bake
  // low, medium and high construct the same sky system: a switch swaps what's shown instead of re-linking identical
  // giant programs (three's WebGL backend never frees a GL program)
  if (SAME_SYSTEM.has(cloudQuality) && SAME_SYSTEM.has(level) && skyApi && impl === 'eidoverse' && !building) {
    // still arriving: wait for it, then swap (a rebuild here would throw the arriving sky away); the latest choice wins
    if (interimFor) {
      pendingTier = level;
      tee(`[sky] clouds → ${level} once the sky has arrived (no rebuild)`);
      const api = skyApi;
      whenSkyUp().then(() => {
        if (skyApi !== api || pendingTier !== level) return;
        pendingTier = null;
        if (level === cloudQuality) return;
        const from = cloudQuality; cloudQuality = level;
        swapTier(from, level).catch((e) => report('sky tier swap', e));
      });
      return;
    }
    const from = cloudQuality;
    cloudQuality = level;
    return swapTier(from, level);
  }
  beginPhases(`clouds ${cloudQuality}→${level}`);
  cloudQuality = level;
  currentWorld = null;          // force a rebuild at the new budget
  skyBuilds = 0;
  try { if (clock) await render(); } finally { endPhases(); }
}

// the library's sky_system.js assigns globalThis.makeSkySystem and sky_worlds.js calls it in the same breath, so
// intercepting the assignment is the only seam (the library's files stay untouched)
let _realMakeSkySystem = null;
Object.defineProperty(globalThis, 'makeSkySystem', {
  configurable: true,
  get() {
    if (!_realMakeSkySystem) return undefined;
    return (args = {}) => {
      const sys = _realMakeSkySystem({
        ...args,
        opts: { ...(args.opts ?? {}), ...QUALITY_OPTS[cloudQuality] },
      });
      // at birth the system adds its domes to the scene synchronously, and the giant cloud program would hit the render
      // path next frame: pull them out in the same tick; the interim gradient stands in and finishSky decides when
      // (and whether) they are built
      const hold = (sy) => {
        if (sy?.domes?.length && holdLiveDomes({ _internals: { sky: sy } }, 'from birth until the real sky is ready')) showInterimSky(sy.uniforms);
        return sy;
      };
      return typeof sys?.then === 'function' ? sys.then(hold) : hold(sys);
    };
  },
  set(fn) { _realMakeSkySystem = fn; },
});

export { WEATHERS, CLOUDS } from '../../../shared/forecast.js';   // the canonical lists, re-exported for existing importers
// only `earth` is offered: ringworld and shieldworld each drag ~20 MB of celestial geometry plus a second raymarched
// layer and take the tab down; a log that asks for one is coerced to earth
export const SKY_WORLDS = ['earth'];
const KNOWN_HEAVY = ['ringworld', 'shieldworld'];

// ---------------------------------------------------------------- entry point

/** Apply the world's folded sky. `ts` is the server stamp, which makes every client's sun agree without the server
 *  simulating anything; folded args carry their own, the param is for un-folded callers. */
export async function applySky(args = {}, ts) {
  clock = { args: { ...args }, t0: args.ts ?? ts ?? serverNow() };
  logged = { args: clock.args, t0: clock.t0 };
  previewing = false;
  await render();
}

/** Local preview (the sky panel): same path, no new epoch. */
export async function previewSky(args) {
  clock = { args: { ...args }, t0: clock?.t0 ?? serverNow() };
  previewing = true;
  await render();
}

// what the log says, apart from what this client draws: a preview replaces `clock` but never `logged`
let logged = null, previewing = false, rendering = 0;
export const loggedSky = () => logged;
export const skyPreviewing = () => previewing;
let arriving = false;   // 'sky-busy': a stand-in gradient is up or a tier swap is compiling
bus.on('sky-busy', (b) => { arriving = !!b; bus.emit('sky-state'); });
// the weather's splash ground is a bake of rainSurfaceAt around the camera: re-read it when the ground moves
bus.on('ground-changed', () => { skyApi?.invalidateGround?.(); });
// a render only reads as 'loading…' past LOAD_SHOW_MS: the 1 Hz re-renders finish in a frame, and flashing the line
// re-rasterises the whole World panel in VR
const LOAD_SHOW_MS = 400;
let renderSince = 0;
export const skyRendering = () => arriving || (rendering > 0 && performance.now() - renderSince >= LOAD_SHOW_MS);
export const skyDegraded = () => degrade >= 2;

function nowHours() {
  // the fold's hours-rebase uses the same formula, which keeps the sun from snapping
  return clock ? hoursAt({ ...clock.args, ts: clock.t0 }, serverNow()) : 12;
}

// How far the sky has been degraded to keep it working on this GPU: 0 = everything on; 1 = the engine's GPU caches
// off (its light cache uses textureStore, which some WebGPU layouts refuse); 2 = three's SkyMesh.
let degrade = 0;
// rebuilds are expensive and stack: without a hard budget a per-frame fault would build atmosphere after atmosphere
let skyBuilds = 0;
const MAX_SKY_BUILDS = 2;

// every sky verb in a log calls render() and replay doesn't await them: without this chain each would build its own sky
let renderChain = Promise.resolve();
function render() {
  bus.emit('sky-state');   // the log/preview state changed (readers write only on change)
  if (rendering++ === 0) {
    renderSince = performance.now();
    const at = renderSince;
    setTimeout(() => { if (rendering > 0 && renderSince === at) bus.emit('sky-state'); }, LOAD_SHOW_MS + 10);
  }
  renderChain = renderChain.then(renderOnce, renderOnce);
  const done = () => { rendering--; bus.emit('sky-state'); };
  renderChain.then(done, done);
  return renderChain;
}

async function renderOnce() {
  const a = clock?.args;
  if (!a) return;
  if (a.system === 'skymesh' || degrade >= 2) {
    if (skyApi || skyOwned.length) { teardownSky(); skyApi = null; currentWorld = null; }
    impl = 'skymesh';
    await renderSkyMesh(a);
    return markPhase('sky', 1);
  }

  // sky arrival invalidates nothing: weather wraps are applied at material birth, the env texture is persistent, the
  // light rig owns the bolt, and the sky's meshes precompile detached in buildSky
  {
    while (degrade < 2 && skyBuilds < MAX_SKY_BUILDS) {
    try {
      await renderEidoverse(a);
      return;
    } catch (e) {
      const why = e?.message ?? String(e);
      // an unsupported server is a fact, not a transient fault
      if (e?.skyUnsupported) {
        degrade = 2;
        console.warn('[sky]', why);
        bus.emit('sky-degraded', { msg: why });
        break;
      }
      const storage = /storageTexture|textureStore|storage texture/i.test(why);
      if (degrade === 0 && storage) {
        console.warn('[sky] GPU cache unsupported here — retrying without it:', why);
        bus.emit('sky-degraded', { msg: 'this GPU cannot do the sky\'s cached lighting — running the simpler path' });
      } else {
        report('eidoverse sky (falling back)', e);
      }
      // the build budget counts failures, so a failed-then-recovered boot doesn't leave later sky verbs stacking a
      // SkyMesh over a working sky
      skyBuilds++;
      degrade++;
      skyApi = null;
      currentWorld = null;
    }
    }
    releaseForeignLights();   // the weather system won't be rebuilt, so its adopted bolt must not outlive it
    impl = 'skymesh';
    // a rebuilding teardown may have put the stand-in gradient up; the basic sky replaces it
    interimFor = null; hideInterimSky(); markSkyUp();
    await renderSkyMesh(a);
    markPhase('sky', 1);
  }
}

// ============================================================ the engine's sky

// which extra bytes a world package needs, from the server's directory listing, split by world
async function primeFor(world, wantAudio) {
  const MODULES = [
    'eidoverse/sky_system.js', 'eidoverse/weather_system.js', 'eidoverse/cloud_spatial.js',
    'eidoverse/ringworld.js', 'eidoverse/redgiant.js', 'eidoverse/asteroid_moon.js',
    'eidoverse/weather_audio.js',
  ];
  const [skyFiles, particles] = await Promise.all([
    listLibrary('eidoverse/assets/sky'),
    // the weather system's rain streaks and splash sprites live here
    listLibrary('eidoverse/assets/particle_textures'),
  ]);
  if (!skyFiles || !particles) {
    // the engine reads its assets synchronously, so the client must list them first (/library-list)
    const e = new Error('this world\'s sequencer is older than this client (no /library-list) — detailed sky unavailable');
    e.skyUnsupported = true;
    throw e;
  }
  const wanted = skyFiles.map((f) => f.path).filter((p) => {
    if (p.includes('/audio/')) return wantAudio;
    // ~20MB of ring geometry and asteroid fields, only for worlds that have them
    if (p.includes('/celestial/')) return world !== 'earth';
    return true;
  });
  const missing = await primeFiles([...MODULES, ...wanted, ...particles.map((f) => f.path)]) ?? [];
  // the weather sounds are the asset library's (assets/sky/audio/), not the engine's: a server without them plays none
  return wantAudio && wanted.some((p) => p.includes('/audio/') && !missing.includes(p)) && !missing.includes('eidoverse/weather_audio.js');
}

let building = null;   // single-flight: the in-flight build promise, so concurrent sky verbs don't each build a sky

// the first sky's warm, a single-shot promise the boot gate races (world.js applySkyFolded): resolved when the first
// build's warm drains, or when the sky lands on the skymesh fallback
let _skyWarmResolve = null;
const _skyWarmDone = new Promise((r) => { _skyWarmResolve = r; });
function resolveSkyWarm() { _skyWarmResolve?.(); _skyWarmResolve = null; }
export const whenSkyWarm = () => _skyWarmDone;

// what the last sky build put into the scene: makeSky's api has no dispose, so we diff the scene around the build and
// own the difference
let skyOwned = [];
let autoSystemsOwned = [];

function snapshotSceneOwnership() {
  return {
    before: new Set(scene.children),
    autos: new Set(globalThis._autoParticleSystems ?? []),
  };
}
function claimSkyAdditions(snap) {
  skyOwned = scene.children.filter((c) => !snap.before.has(c)
    // never claim what the world owns (entities, bodies, terrain, meadow, debug groups), all of which other code can
    // add while the async build is in flight; skyExempt is the marker world-owned roots wear
    && !c.userData?.entityId && !c.userData?.isBody
    && !c.userData?.skyExempt && !c.userData?.isDebug);
  autoSystemsOwned = claimUnowned(snap.autos);   // hooks the same way: by identity, never another owner's
}
function teardownSky({ rebuilding = false } = {}) {
  // a rebuild keeps a gradient up through the teardown and the new build's loads (the palette uniforms are plain
  // objects and outlive the system); a teardown to the basic sky drops it
  interimFor = null; pendingTier = null; swaps.reset(); markSkyUp();   // anyone waiting for the old build checks skyApi
  if (rebuilding && skyInner?.uniforms) showInterimSky(skyInner.uniforms); else hideInterimSky();
  const held = takeHeldDomes();   // taken, not put back: never compiled, they must not reach the scene on the way out
  releaseForeignLights();   // the adopted lightning: the scene diff can't see it (the rig kept it out of the scene)
  detachBakedDome();   // puts the parked live domes back, so the disposal walk below finds them
  // the engine's own dispose is the only path to its env target, bake target and textures
  if (skyInner) skyInner.__dead = true;   // queued bakes skip it (sky_bakelock.js)
  try { skyInner?.dispose?.(); } catch (e) { console.warn('[sky] engine dispose', e?.message ?? e); }
  try { skyInner?.__disposeKeptBakes?.(); } catch (e) { console.warn('[sky] kept bake graphs', e?.message ?? e); }
  skyInner = null;
  for (const o of skyOwned) {
    scene.remove(o);
    o.traverse?.((n) => {
      n.geometry?.dispose?.();
      const m = n.material;
      if (Array.isArray(m)) m.forEach((x) => x?.dispose?.());
      else m?.dispose?.();
    });
  }
  for (const d of held) if (!skyOwned.includes(d)) { d.removeFromParent?.(); d.geometry?.dispose?.(); d.material?.dispose?.(); }
  skyOwned = [];
  for (const h of autoSystemsOwned) releaseHook(h, globalThis._autoParticleSystems);
  autoSystemsOwned = [];
}

async function renderEidoverse(a) {
  if (a.world && KNOWN_HEAVY.includes(a.world)) {
    console.warn(`[sky] "${a.world}" is disabled here (too heavy for a live client) — using earth`);
  }
  const world = SKY_WORLDS.includes(a.world) ? a.world : 'earth';
  const wantAudio = Boolean(a.audio);

  if (building) {
    await building.catch(() => {});   // whoever is already building wins
  }
  if (skyApi && currentWorld !== world && currentWorld !== null && xrPresenting) {
    heldRebuild = true;
    tee(`[sky] sky world ${currentWorld}→${world} held until VR exit`);
    applyLive(a);
    return;
  }
  const fresh = !skyApi || currentWorld !== world;
  if (fresh) {
    const work = beginWork('sky build');
    building = buildSky(a, world, wantAudio).finally(() => work.end());
    try { await building; } finally { building = null; }
  }
  applyLive(a);
  // The world first, the sky last: after a fresh build the real sky's domes stay out of the scene and a gradient in
  // the hour's colours stands in; the cloud programs compile once the world near you has loaded (finishSky), detached,
  // so later sky verbs apply at once.
  if (fresh && (holdLiveDomes(skyApi, 'until the real sky is ready') || liveDomesHeld())) {
    interimFor = skyApi;
    showInterimSky(skyInner?.uniforms);
    // at boot, the VR cap's bake program compiles under the splash (capped at 40 s inside the splash's 45 s ceiling)
    if (!BAKED_TIERS[cloudQuality] && !bootDone()) await Promise.race([prebuildCapBake(skyApi), new Promise((r) => setTimeout(r, 40000))]);
    resolveSkyWarm();
    finishSky(skyApi).catch((e) => report('sky finish', e));
    return;
  }
  if (interimFor) return;                // the real sky is still on its way: finishSky owns the bake
  holdLiveInHeadset();
  const bake = beginWork('sky bake');
  phase('apply');
  try { await ensureSkyBake(); } finally { bake.end(); }
  phase('bake');
  if (bakedActive()) await whenBakeReady();
  if (fresh) hideInterimSky();   // fresh only: a 1 Hz re-apply must not hide a size swap's gradient
  resolveSkyWarm();
}

async function finishSky(api) {
  phase('apply');
  await worldSettled();
  if (skyApi !== api) return;            // torn down / rebuilt while we waited
  // a tier chosen while we waited: same system, so arrive as that tier
  if (pendingTier) { tee(`[sky] arriving as ${pendingTier} (chosen while the sky was loading)`); cloudQuality = pendingTier; pendingTier = null; }
  const bake = beginWork('sky bake');
  if (!BAKED_TIERS[cloudQuality]) {
    // the live tier's env bake only lights reflections, so the clouds don't wait for it
    ensureSkyBake().catch((e) => report('sky env bake', e)).finally(() => bake.end());
  } else {
    try { await ensureSkyBake(); } finally { bake.end(); }
  }
  phase('bake');
  if (bakedActive()) await whenBakeReady();
  // no baked dome (the high tier, a failed attach): the live domes are the sky; compile them off the render path first
  if (!bakedActive() && skyApi === api) await compileLiveDomes();
  if (skyApi !== api) return;
  // a baked tier chosen while the live domes compiled (the VR cap): arrive as that tier, never showing the live march
  if (!bakedActive() && pendingTier && BAKED_TIERS[pendingTier]) {
    tee(`[sky] arriving as ${pendingTier} (chosen while the live domes compiled): baked, the live march never shown`);
    cloudQuality = pendingTier; pendingTier = null;
    bakePending = true;
    const late = beginWork('sky bake');
    try { await ensureSkyBake(); } catch (e) { report('sky bake', e); } finally { late.end(); }
    if (bakedActive()) await whenBakeReady();
    if (skyApi !== api) return;
  }
  if (!bakedActive()) releaseLiveDomes();   // compiled above: safe to show
  interimFor = null;
  hideInterimSky();
  tee(`[sky] the real sky is up (${bakedActive() ? 'baked dome' : 'live domes'}); the interim gradient is gone`);
  markSkyUp();
  if (!BAKED_TIERS[cloudQuality] && capPrebuiltFor !== api) prebuildCapBakeWhenHeadset(api);   // a build that wasn't under the splash
}

// Entering VR from 'high': the cap swaps to 'medium' at entry, and compiling its bake program then left the headset
// with no frame to present. With a headset present it is compiled on the desktop instead, once: a tiny bake of
// medium's pass count into a temporary target (the shader doesn't depend on size), kept by retainBakeGraphs so the
// entry's full bake is a program-cache hit.
let capPrebuiltFor = null;   // the sky build whose cap program is already compiled (or compiling)
const headsetPresent = async () => { try { return !!(await navigator.xr?.isSessionSupported?.('immersive-vr')); } catch { return false; } };
async function prebuildCapBake(api) {
  if (capPrebuiltFor === api || !(await headsetPresent())) return;
  if (skyApi !== api || BAKED_TIERS[cloudQuality] || xrPresenting) return;
  capPrebuiltFor = api;
  // the same guards again inside the bake lock: queued behind a long bake, its turn can come after a VR entry
  const wanted = () => skyApi === api && !BAKED_TIERS[cloudQuality] && !xrPresenting;
  if (!(await prebuildBakeProgram(BAKED_TIERS[CAP_TO].cloudPasses, {}, wanted)) && capPrebuiltFor === api) capPrebuiltFor = null;
}
async function prebuildCapBakeWhenHeadset(api) {
  if (!(await headsetPresent())) return;
  await new Promise((r) => setTimeout(r, 15000));
  await prebuildCapBake(api);
}
/** Compile a bake program (the given pass count) without touching the sky's own env target. Exported for probes. */
export async function prebuildBakeProgram(cloudPasses, opts = {}, stillWanted = null) {
  const api = skyApi, sys = skyInner;
  if (!api?.bakeEnv || !sys) return false;
  const t0 = performance.now();
  const lock = sys.__withBakeLock ?? ((fn) => fn());
  // the whole swap under the bake lock: no other bake may see the temporary target
  let ran = false;
  await lock(async () => {
    if (sys.__dead) return;
    if (stillWanted && !stillWanted()) { tee('[sky] the VR cap\'s bake prebuild: no longer wanted when its turn came (skipped)'); return; }
    ran = true;
    const keepT = sys._envTarget, keepFb = sys._envFbNode?.value;
    sys._envTarget = null;
    try {
      // through the api (it adds the world's own bake options); BAKE_HELD: this call already holds the lock
      await api.bakeEnv({ width: 64, height: 32, cloudPasses, ...opts, [BAKE_HELD]: true });
    } catch (e) { ran = false; report('sky prebuild', e); }
    finally {
      // put the real target back now, not after the link wait, or reflections sample the undrawn 64x32 meanwhile
      const tmp = sys._envTarget;
      sys._envTarget = keepT;
      if (sys._envFbNode && keepFb !== undefined) sys._envFbNode.value = keepFb;
      if (tmp && tmp !== keepT) tmp.dispose();
    }
    // still inside the lock: no bake may start until the prebuilt program has linked
    await globalThis.__syncGate?.whenGiantLinked?.();
  });
  if (!ran) return false;
  tee(`[sky] headset present: the VR cap's bake program (${cloudPasses} passes) prebuilt on the desktop in ${(performance.now() - t0).toFixed(0)} ms`);
  return true;
}

let interimFor = null;    // the sky build the interim gradient is standing in for
let pendingTier = null;   // a tier chosen while the sky was still arriving, swapped in once it has
let skyUpResolve = null, skyUpP = null;
/** Resolves once the current sky build has arrived (finishSky done), at once if nothing is arriving. */
function whenSkyUp() {
  if (!interimFor) return Promise.resolve();
  if (!skyUpP) skyUpP = new Promise((r) => { skyUpResolve = r; });
  return skyUpP;
}
function markSkyUp() { const r = skyUpResolve; skyUpResolve = null; skyUpP = null; r?.(); }
/** Nearby world first: boot finished and no loading work queued, for a second in a row (at most 60 s). */
async function worldSettled() {
  const t0 = performance.now(); let calm = 0;
  while (performance.now() - t0 < 60000) {
    if (bootDone() && !loadingBusy()) { if (++calm >= 4) break; } else calm = 0;
    await new Promise((r) => setTimeout(r, 250));
  }
  teeNow(`[sky] world settled after ${((performance.now() - t0) / 1000).toFixed(1)} s: compiling the sky now`);
}
// 'sky-busy': the sky is still arriving (the stand-in gradient is up, or a tier swap is compiling or baking). Heard by
// xr.js's entry curtain and by `arriving` above.
let swapping = 0, busyShown = false;
function announceBusy() {
  const b = interimSkyShown() || swapping > 0 || bakedRefreshing();
  if (b !== busyShown) { busyShown = b; bus.emit('sky-busy', b); }
}
bus.on('sky-interim', announceBusy);
bus.on('sky-refreshing', announceBusy);
export const skyBusy = () => busyShown;
/** Probes only: the api and the engine object. */
export const skyForProbe = () => ({ api: skyApi, sys: skyInner });
// The engine keeps one bake graph (sys._envBake) and disposes it whenever a bake with another key arrives, evicting
// the giant bake program on every switch. three frees a program only when unused, so evicted graphs are kept (dispose
// deferred, one per key) and a rebuild is a program-cache hit; all go at teardown. One bake at a time: sky_bakelock.js.
const serializeBakes = (sys) => serializeBakesWith(sys, { log: (l) => tee(l), report });
function retainBakeGraphs(sys) {
  if (!sys || Object.getOwnPropertyDescriptor(sys, '_envBake')?.get) return;
  let cur = sys._envBake ?? null;
  const kept = new Map();   // key → a graph whose dispose was deferred
  const keep = (b) => {
    if (!b || b.__realDispose) return b;
    b.__realDispose = b.dispose.bind(b);
    b.dispose = () => {
      const old = kept.get(b.key);
      if (old && old !== b) old.__realDispose();   // the newer graph of that key holds the same programs
      kept.set(b.key, b);
    };
    return b;
  };
  keep(cur);
  Object.defineProperty(sys, '_envBake', { configurable: true, get: () => cur, set: (b) => { cur = keep(b); } });
  sys.__keptBakeKeys = () => [...kept.keys()];
  sys.__disposeKeptBakes = () => { for (const b of new Set([...kept.values(), cur])) b?.__realDispose?.(); kept.clear(); cur = null; };
}
const SAME_SYSTEM = new Set(['low', 'medium', 'high']);
// one swap at a time, latest choice wins: the bookkeeping is sky_swapchain.js's; swapTierInner does the screen work
const swaps = makeSwapChain({ inner: (from, to) => swapTierInner(from, to), want: () => cloudQuality, api: () => skyApi, log: (l) => tee(l) });
function swapTier(from) {
  swapping++; announceBusy();
  return swaps.swap(from).finally(() => { swapping--; announceBusy(); });
}
async function swapTierInner(from, to) {
  const t0 = performance.now(), api = skyApi;
  const F = BAKED_TIERS[from], T = BAKED_TIERS[to];
  // from = SHOWN_UNKNOWN (a superseded run left no tier on screen): a baked `to` takes the baked→baked path, which
  // assumes nothing about the screen; `high` takes !T, which shows the live domes from any state
  if ((F || from === SHOWN_UNKNOWN) && T) {
    // baked → baked at another size: the old dome's texture is the target the new bake re-creates, so the live march
    // is held out and the gradient stands in until the new dome attaches
    detachBakedDome();
    holdLiveDomes(skyApi, 'while the sky re-bakes at the new size');
    showInterimSky(skyInner?.uniforms);
    bakePending = true;
    try { await ensureSkyBake(); } catch (e) { report('sky tier swap', e); }
    if (bakedActive()) await whenBakeReady();
    // a newer choice arrived while this baked: the queued swap owns the sky now, so leave the gradient/hold up for it
    if (skyApi !== api) return false;
    if (cloudQuality !== to) return 'superseded';
    if (!bakedActive()) releaseLiveDomes();
    hideInterimSky();
  } else if (!T) {
    // the baked dome stays up while the live domes compile off the render path; then they replace it
    await compileLiveDomes();
    if (skyApi !== api || BAKED_TIERS[cloudQuality]) return false;
    detachBakedDome();
    hideInterimSky();                   // a superseded bake swap may have left the gradient up
    scheduleEnvBake({ force: true });   // the live tier's own env-IBL
  } else {
    // live → baked: the live march stays on screen while the bake runs (held out in a headset, the gradient standing
    // in), then the baked dome parks it
    if (xrPresenting && holdLiveDomes(skyApi, 'in a headset until the baked dome is ready')) showInterimSky(skyInner?.uniforms);
    bakePending = true;
    try { await ensureSkyBake(); } catch (e) { report('sky tier swap', e); }
    if (bakedActive()) await whenBakeReady();
    if (skyApi !== api) return false;
    if (cloudQuality !== to) return 'superseded';
    if (!bakedActive()) releaseLiveDomes();
    hideInterimSky();
  }
  tee(`[sky] clouds ${from}→${to} without a rebuild (${(performance.now() - t0).toFixed(0)} ms)`);
  return true;
}

async function compileLiveDomes() {
  const domes = skyInner?.domes ?? [];
  const t0 = performance.now();
  // compileAsync skips invisible objects; a hidden cloud dome would otherwise link later, on the render path
  const forced = domes.filter((d) => !d.parent && !d.visible);   // only while out of the scene: in it, visible = drawn
  for (const d of forced) d.visible = true;
  try { await Promise.all(domes.map((d) => renderer.compileAsync(d, camera, scene).catch(() => {}))); }
  // put back only what we flipped, and only if nothing else wrote it meanwhile
  finally { for (const d of forced) if (d.visible === true && !d.parent) d.visible = false; }
  tee(`[sky] live domes compiled in ${(performance.now() - t0).toFixed(0)} ms (off the render path)`);
}

async function buildSky(a, world, wantAudio) {
  {
    // tear down a previous world's sky before building another
    try { skyApi?.dispose?.(); } catch { /* the engine has none; teardownSky is the real teardown */ }
    teardownSky({ rebuilding: true });
    skyApi = null;
    const ownership = snapshotSceneOwnership();
    // the engine's knobs: TIER=balanced unless this viewer chose 'high'
    const envKnobs = (globalThis.__ewEnv ??= {});
    envKnobs.TIER = skyQuality() === 'high' ? undefined : 'balanced';
    // the light cache (LCACHE) off by default: it writes through textureStore, which three's WebGPU backend rejects
    // with an uncatchable per-frame rejection, and it doesn't reproduce headless so it isn't feature-detected. Only the
    // light cache: CACHE=0 kills the density cache too and the sky renders black.
    envKnobs.CACHE = undefined;
    envKnobs.DCACHE = undefined;
    envKnobs.LCACHE = skyQuality() === 'high' ? undefined : '0';

    // no boot yield here: arrival gates on this build's warm (world.js applySkyFolded)
    phase('teardown');
    const audio = await primeFor(world, wantAudio);
    phase('prime');
    await loadEidoModule('sky_worlds.js');
    phase('module');
    if (typeof globalThis.makeSky !== 'function') throw new Error('sky_worlds.js exposed no makeSky');
    if (skyMesh) { scene.remove(skyMesh); skyMesh = null; }
    // reset the applyLive guards so the first applyLive re-asserts everything
    forecastCursor = null; appliedWeather = null; appliedClouds = null; appliedColors = null;
    lastLiveHours = null;
    // the DERIVED weather (the authored field may be segments stale); mid-transition, the segment's previous state
    const eff0 = effectiveSky(a, serverNow());
    const w0 = (eff0.source === 'forecast' && eff0.inTransition && eff0.seg.prevState)
      ? eff0.seg.prevState : eff0.weather;
    skyApi = await globalThis.makeSky({
      scene, camera, renderer, world,
      hours: nowHours(),
      clouds: cloudQuality === 'off' ? 'clear' : (CLOUDS.includes(a.clouds) ? a.clouds : 'cumulus'),
      weather: WEATHERS.includes(w0) ? w0 : 'clear',
      sun, hemi,
      audio,
      groundHeightAt: rainSurfaceAt,   // the rain's splashes land on the terrain or water, not the library's flat y=0
    });
    phase('makeSky');
    claimSkyAdditions(ownership);
    skyInner = skyApi?._internals?.sky ?? null;
    retainBakeGraphs(skyInner);
    serializeBakes(skyInner);
    // held from birth, the domes were never in the scene for the diff above: claim them by identity so teardown frees them
    for (const d of skyInner?.domes ?? []) if (d && !skyOwned.includes(d)) skyOwned.push(d);
    // The clear→cloudy fence: the bake graph keys on preset !== 'clear', and the cloud-carrying graph is a giant
    // compile. On cloud-capable tiers 'clear' is always respelled as an empty cumulus (finalMul 0), so the cloud graph
    // pins at the boot bake and every later sky change is uniform writes. On the internal setter because the weather
    // system calls setClouds('clear') behind the api. The 'off' tier keeps genuine 'clear'.
    if (skyInner?.setClouds && cloudQuality !== 'off') {
      const orig = skyInner.setClouds.bind(skyInner);
      skyInner.setClouds = (kind, over) => (kind === 'clear'
        ? orig('cumulus', { ...(over ?? {}), finalMul: 0, wispOn: 0, stormCanopy: 0 })
        : orig(kind, over));
    }
    // warm the sky's own pipelines off the render path through the warm queue: detach, compile against the live scene,
    // re-add. Not the domes: a cold cloud-dome link takes minutes on WebGL and would starve every model pipeline behind
    // it; they compile after the world near you has loaded (finishSky).
    const bigDomes = new Set(skyInner?.domes ?? []);
    const warmed = new Set();
    for (const o of skyOwned) {
      if (bigDomes.has(o)) continue;
      warmed.add(o);
      // P_AMBIENT: never ahead of the ground/models a person is waiting for
      await warm(`sky warm ${(o.name || o.type || 'dome').slice(0, 24)}`, async () => {
        scene.remove(o);
        try { await renderer.compileAsync(o, camera, scene).catch(() => {}); }
        finally { scene.add(o); }
      }, { p: P_AMBIENT });
    }
    tee(`[sky] build owns ${skyOwned.length}: ${skyOwned.map((o) => `${o.geometry?.type ?? o.type}${warmed.has(o) ? '=warmed' : '=later'}`).join(' ')}`);
    phase('dome-warm');
    currentWorld = world;
    impl = 'eidoverse';
    scene.background = null;

    // the first bake happens after applyLive (ensureSkyBake): makeSky's default weather 'clear' overrides the cloud
    // preset, and baking here would pin a graph with no cloud branch
    bakePending = true;
    markPhase('sky', 1);
    bus.emit('sky-ready', { impl, world });
  }

}

// Once per build, after the log's sky verb has been applied: bake the environment (on baked tiers this same bake is
// the visible sky, at the tier's resolution) and swap the live domes for the baked dome.
let bakePending = false;
async function ensureSkyBake() {
  if (!bakePending || !skyApi) return;
  bakePending = false;
  const tier = cloudQuality;   // the tier this bake is for; a choice made while it runs queues its own bake, which owns the attach
  const gen = bakeGeneration();       // a teardown mid-bake bumps it: the strips stop, nothing attaches to a dead sky
  const api = skyApi;
  // everything after the bake that reads the engine's target and graph runs inside the bake lock (BAKE_AFTER), before
  // a queued bake can swap or resize the target; once
  let posted = false, baked = false;
  const post = ({ ok }) => {
    if (posted) return; posted = true;
    if (ok) {
      lastBakeHours = nowHours();
      lastBakeAt = performance.now();
      if (bakeGeneration() === gen) {
        api.enableReflections?.({});
        adoptEnvironment();   // the engine just pointed scene.environment at its target: copy it into the persistent texture
      }
    }
    if (bakeGeneration() !== gen || skyApi !== api) return;   // torn down while baking
    if (tier !== cloudQuality) { tee(`[sky] bake for ${tier} finished after the choice moved to ${cloudQuality}: not attached (its own bake will)`); return; }
    if (!ok && BAKED_TIERS[tier]) {
      // a failed bake left the target undrawn (attaching would show a black dome): the live march stays
      attachFailedFor = skyApi;   // or the 1 Hz render's holdLiveInHeadset re-holds them within a second
      if (!interimFor) releaseLiveDomes();   // while the sky is still arriving, finishSky releases them once compiled
      // one retry after a pause; a second failure stays on the live march until the next choice
      if (bakeRetriedFor !== api) {
        bakeRetriedFor = api;
        tee('[sky] bake failed: no baked dome attached, the live cloud march stays; retrying once in 10 s');
        setTimeout(() => { if (skyApi !== api || tier !== cloudQuality || bakedActive()) return; bakePending = true; ensureSkyBake().catch((e) => report('sky bake retry', e)); }, 10000);
      } else tee('[sky] bake failed again: the live cloud march stays until the next cloud choice');
      return;
    }
    if (BAKED_TIERS[tier]) {
      const { cloudPasses, intervalMs } = BAKED_TIERS[tier];
      if (!attachBakedDome(api, { cloudPasses, intervalMs, noClouds: tier === 'off' })) {
        // engine internals moved: the live march is still in the scene, so the sky stays correct, just expensive
        attachFailedFor = api;
        if (!interimFor) releaseLiveDomes();
        console.warn('[sky] baked dome could not attach — staying on the live cloud march');
        tee('[sky] baked dome could not attach — the live cloud march stays (in a headset too)');
      } else {
        attachFailedFor = null;
        if (headsetGradient) { headsetGradient = false; hideInterimSky(); }   // the dome it stood in for is up
      }
    } else if (!interimFor) releaseLiveDomes();
  };
  try {
    // the boot bake as bands (sky_baked.js bandedBakeRender): bakeEnv's one full-quad renderAsync is intercepted for
    // this call only and re-issued as cost-weighted strips across frames; ?skyband=0 turns it off
    const opts = bakeOpts();
    let outer = renderer.getRenderTarget();
    let origRA = renderer.renderAsync;
    const band = CONFIG.params.get('skyband') !== '0' && opts.width
      && bandCuts(opts.width, opts.height, opts.cloudPasses ?? 8, BAND_BUDGET).length > 3;
    const strips = opts.width ? bandCuts(opts.width, opts.height, opts.cloudPasses ?? 8, BAND_BUDGET).length - 1 : 0;
    tee(`[sky] boot bake: ${band ? 'banding' : CONFIG.params.get('skyband') !== '0' ? 'one-shot, precompiled' : 'ONE-SHOT'} (skyband=${CONFIG.params.get('skyband') ?? 'default'}, ${opts.width}x${opts.height}, passes ${opts.cloudPasses ?? 8}, ${strips} strips, inner ${skyInner ? 'yes' : 'NO'})`);
    let seen = 0;
    // one-shot bakes (no baked dome, or too small to band) still compile their pipeline off the render path first
    const precompile = !band && CONFIG.params.get('skyband') !== '0';
    const interceptor = !(band || precompile) ? null : function (sc, cam) {
      if (sc !== skyInner?._envBake?.scene) { if (seen++ < 2) tee(`[sky] boot bake: a renderAsync passed through (not the bake scene: ${sc?.type ?? typeof sc}, envBake ${skyInner?._envBake ? 'set' : 'unset'})`); return origRA.call(this, sc, cam); }
      renderer.renderAsync = origRA;
      if (precompile) {
        // the bake target is bound on entry: capture it, since render.js's self-heal unbinds any target left bound
        // at frame start during the await, and re-bind it for the draw
        const target = renderer.getRenderTarget();
        const t0 = performance.now();
        const compiling = renderer.compileAsync(sc, cam);   // the target is read here, at the call
        renderer.setRenderTarget(outer ?? null);
        return compiling.catch(() => {})
          .then(() => globalThis.__syncGate?.whenGiantLinked?.())   // a deferred giant link must land before the one draw
          .then(() => { tee(`[sky] one-shot bake precompiled in ${(performance.now() - t0).toFixed(0)} ms`); renderer.setRenderTarget(target); return origRA.call(renderer, sc, cam); });
      }
      const target = renderer.getRenderTarget();
      renderer.setRenderTarget(outer ?? null);   // the frames between bands are the world's
      const t0 = performance.now();
      // in a headset the live domes are out of the scene while the bake bands, back before the baked dome parks them
      const hidden = renderer.xr?.isPresenting ? (skyApi?._internals?.sky?.domes ?? []).filter((d) => d?.parent).map((d) => [d, d.parent]) : [];
      for (const [d, p] of hidden) p.remove(d);
      return bandedBakeRender(renderer, sc, cam, target, { cloudPasses: opts.cloudPasses ?? 8, passTexelBudget: BAND_BUDGET, budget: true, alive: () => bakeGeneration() === gen, sys: skyInner })
        .then((n) => { const l = `[sky] boot bake banded: ${n} bands over ${(performance.now() - t0).toFixed(0)} ms`; console.log(l); tee(l); renderer.setRenderTarget(target); })
        .finally(() => { if (bakeGeneration() === gen) for (const [d, p] of hidden) if (!d.parent) p.add(d); });   // torn down: those domes were disposed
    };
    // installed inside the bake lock, right before this bake runs
    const install = interceptor && (() => { origRA = renderer.renderAsync; outer = renderer.getRenderTarget(); renderer.renderAsync = interceptor;
      return () => { if (renderer.renderAsync === interceptor) renderer.renderAsync = origRA; }; });
    await api.bakeEnv?.({ ...opts, ...(install ? { [BAKE_INTERCEPT]: install } : {}), [BAKE_AFTER]: post });
    baked = true;
  } catch (e) { console.warn('sky reflections unavailable', e); tee(`[sky] boot bake failed: ${e?.message ?? e}`); }
  post({ ok: baked, skipped: false });     // no lock wrapper (engine internals moved): the same work, here
}

// Re-baking the environment map on the live tier: without re-bakes the ground stays lit at the hour the sky was built.
// Debounced and rate-limited, since a bake costs a render.
let lastBakeHours = null;
let lastBakeAt = 0;
let bakeTimer = null;
const BAKE_MIN_GAP_MS = 900;
const BAKE_HOUR_DELTA = 0.25;

function scheduleEnvBake({ force = false } = {}) {
  const h = nowHours();
  if (!force && lastBakeHours !== null && Math.abs(h - lastBakeHours) < BAKE_HOUR_DELTA
      && Math.abs(h - lastBakeHours) < 12) return;    // (wrap-safe enough for a debounce)
  clearTimeout(bakeTimer);
  const wait = Math.max(0, BAKE_MIN_GAP_MS - (performance.now() - lastBakeAt));
  bakeTimer = setTimeout(runEnvBake, wait + 60);
}

async function runEnvBake() {
  if (!skyApi?.bakeEnv) return;
  if (bakedActive()) return requestBake();   // on baked tiers the crossfade loop owns the re-bake clock
  if (BAKED_TIERS[cloudQuality] || interimFor) return;   // nor before a baked tier's dome has attached
  tee(`[sky] env re-bake (${cloudQuality} tier, live env)`);
  lastBakeAt = performance.now();
  lastBakeHours = nowHours();
  const api = skyApi;
  // the same checks again inside the bake lock (BAKE_GUARD): queued behind a long bake, this small bake would resize
  // the target right before a baked dome attached to it; the re-adopt runs inside the lock too (BAKE_AFTER)
  const stillLive = () => skyApi === api && !bakedActive() && !BAKED_TIERS[cloudQuality] && !interimFor;
  let called = false;
  const adopt = ({ ok }) => {
    if (called) return; called = true;
    if (!ok) return;
    api.enableReflections?.({});   // the engine rebaked into its own target: re-point, then re-adopt
    adoptEnvironment();
  };
  try {
    await api.bakeEnv({ ...bakeOpts(), [BAKE_GUARD]: stillLive, [BAKE_AFTER]: adopt });   // same opts every time: the graph is cached on them
    adopt({ ok: true });   // no lock wrapper: here, as before
  } catch (e) {
    console.warn('[sky] env re-bake failed', e?.message ?? e);
  }
}

// Settings that apply to an already-built sky: cheap, idempotent, run for every sky verb and once a second under a
// forecast or a rated day (updateSky), so everything is guarded to fire only on change.
let forecastCursor = null;   // the forecast's segment walk never re-runs from epoch
let appliedWeather = null;   // `state|k` last asserted on skyApi; null = fresh build
let appliedClouds = null;
let appliedColors = null;
let lastLiveHours = null;    // detects verb-driven clock jumps
function applyLive(a) {
  if (!skyApi) return;
  const h = nowHours();
  skyApi.setTime?.(h);
  if (!bakedActive() && !BAKED_TIERS[cloudQuality] && !interimFor) scheduleEnvBake();   // the live tier only: baked tiers re-bake on their own cadence
  let changed = false;
  // a clock jump (a dusk/dawn verb) asks for a bake now instead of waiting out the cadence; circular, so midnight isn't a jump
  if (lastLiveHours !== null) {
    const d = Math.abs(h - lastLiveHours);
    if (Math.min(d, 24 - d) > 0.75) changed = true;
  }
  lastLiveHours = h;
  // an authored 'clear' flows to the setter like any other kind (the fence in buildSky renders it as an empty cumulus)
  const clouds = cloudQuality === 'off' ? 'clear'
    : (a.clouds && CLOUDS.includes(a.clouds) ? a.clouds : null);
  if (clouds && clouds !== appliedClouds) {
    skyApi.setClouds?.(clouds);
    appliedClouds = clouds;
    changed = true;
  }
  // derived in shared/forecast.js, as the sequencer and agents do, so all agree without the server simulating
  const eff = effectiveSky(a, serverNow(), forecastCursor);
  forecastCursor = eff.cursor;
  if (eff.weather) {
    const key = `${eff.weather}|${(eff.k ?? 1).toFixed(2)}`;
    if (key !== appliedWeather) {
      const fresh = appliedWeather === null;
      if (fresh && eff.source === 'forecast' && eff.inTransition && eff.seg.prevState) {
        // mid-transition: ease over the REMAINING time, finishing when everyone else's does
        const remain = Math.max(1, (eff.seg.startMs + eff.seconds * 1000 - serverNow()) / 1000);
        skyApi.transitionTo?.(eff.weather, eff.k ?? 1, remain);
      } else if (!fresh && eff.seconds) {
        skyApi.transitionTo?.(eff.weather, eff.k ?? 1, eff.seconds);
      } else {
        skyApi.setWeather?.(eff.weather, eff.k ?? 1);
      }
      // provenance stays legible: a derived change names its policy, a manual one its actor
      if (eff.source === 'forecast') {
        console.info(`[weather] ${eff.weather} (forecast — policy sky seq ${eff.seq ?? '?'} by ${eff.by ?? '?'}, seg ${eff.seg.idx})`);
      } else if (eff.source === 'manual') {
        console.info(`[weather] ${eff.weather} (manual override by ${eff.by ?? '?'} — forecast resumes at next boundary)`);
      }
      appliedWeather = key;
      changed = true;
    }
  }
  if (a.colors) {
    const cKey = JSON.stringify(a.colors);
    if (cKey !== appliedColors) {
      skyApi.setColors?.(a.colors);
      appliedColors = cKey;
      changed = true;
    }
  }
  if (bakedActive() && changed) {
    requestBake();   // the baked dome only changes when a bake lands
  }

  // makeSky drives `sun` and `hemi` itself; here only what the world owns applies: exposure and the lamps' day response
  applyTuning(a, Math.max(0, Math.sin(((nowHours() - 6) / 12) * Math.PI)), undefined, null, true);
}

// ============================================================ SkyMesh fallback

async function renderSkyMesh(a) {
  const hours = nowHours();
  const { SkyMesh } = await import('three/addons/objects/SkyMesh.js');
  if (!skyMesh) {
    skyMesh = new SkyMesh();
    skyMesh.scale.setScalar(280);
    skyMesh.material.fog = false;   // fogged, a 280-unit dome would render as pure fog colour
    skyMesh.userData.noCamCollide = true;
    scene.add(skyMesh);
  }
  impl = 'skymesh';

  const day = Math.max(0, Math.sin(((hours - 6) / 12) * Math.PI)); // 0 night → 1 noon
  const elev = -8 + 68 * day;
  const phi = THREE.MathUtils.degToRad(90 - elev);
  const theta = a.azimuth ?? Math.PI;   // radians (default 180°)
  const sunPos = new THREE.Vector3().setFromSphericalCoords(1, phi, theta);
  skyMesh.sunPosition.value.copy(sunPos);
  // haze thickens as the sun drops: that is what paints a sunset dome
  const warmth = Math.pow(1 - day, 1.5);
  skyMesh.turbidity.value = 6 + 7 * warmth;
  skyMesh.rayleigh.value = 1.6 + 1.6 * warmth;
  skyMesh.mieCoefficient.value = 0.004 + 0.012 * warmth;
  skyMesh.mieDirectionalG.value = 0.8;

  sun.position.copy(sunPos).multiplyScalar(60);
  // light temperature follows the sun: white at noon, warm near the horizon
  sun.color.lerpColors(new THREE.Color(0xfff2e0), new THREE.Color(0xffab5e), warmth);
  hemi.color.lerpColors(new THREE.Color(0xbfd4ff), new THREE.Color(0xe0b98f), warmth * 0.85);
  hemi.groundColor.lerpColors(new THREE.Color(0x283024), new THREE.Color(0x5a4630), warmth);
  scene.background = null;

  applyTuning(a, day, warmth, sunPos);
  resolveSkyWarm();   // every fallback route ends here: the boot gate must not wait for a warm that never comes
}

// ============================================================ shared tuning
// the exposure/fill/fog knobs apply to whichever sky is underneath, so the sky panel's sliders behave the same on both

function applyTuning(a, day, warmth = Math.pow(1 - day, 1.5), sunPos = null, skyOwnsLights = false) {
  if (!skyOwnsLights) {
    sun.intensity = (0.4 + 2.2 * day) * (a.sun ?? 1);
    // golden hour is full of scattered warm light: a low sun does not mean dark subjects
    hemi.intensity = (0.6 + 0.4 * day) * (a.ambient ?? 1) * SHADOW_DEBUG_FILL;
    if (SHADOW_DEBUG_FILL !== 1 && scene.environment) scene.environmentIntensity = SHADOW_DEBUG_FILL;

    fillLight.color.copy(hemi.color);
    if (sunPos) {
      fillLight.position.set(-sunPos.x, Math.max(0.35, sunPos.y), -sunPos.z).multiplyScalar(60);
    } else {
      fillLight.position.copy(sun.position).multiplyScalar(-1);
      fillLight.position.y = Math.abs(fillLight.position.y);
    }
    fillLight.intensity = 0.95 * warmth * (a.fill ?? 1);

    if (scene.fog) {
      const cool = new THREE.Color().setHSL(0.6, 0.2, 0.05 + 0.5 * day);
      const warm = new THREE.Color().setHSL(0.07, 0.32, 0.04 + 0.45 * day);
      scene.fog.color.lerpColors(cool, warm, warmth);
    }
  } else {
    fillLight.intensity = 0; // the real sky supplies its own bounce
  }

  // fog density is the world's on both paths (the real sky drives only its colour)
  if (scene.fog) scene.fog.density = 0.018 * (a.fog ?? 1);

  // exposure is the world's, not the sky's: one global knob, the same on both implementations
  renderer.toneMappingExposure = (skyOwnsLights ? 1 : (1.0 - 0.22 * warmth)) * (a.exposure ?? 1);

  dayness = day;
  setDayness(day);   // the light rig dims lamps and placed lights on this same clock
}

// ---------------------------------------------------------------- per-frame

let lastClockTick = 0;
let updateFailures = 0;
export function updateSky(nowMs, t) {
  // a sky that throws from its per-frame update is invisible to the try/catch around construction: count failures
  if (impl === 'eidoverse' && skyApi?.update) {
    try {
      const r = skyApi.update(t);
      if (r && typeof r.catch === 'function') r.catch(noteSkyFailure);
      else updateFailures = 0;
    } catch (e) { noteSkyFailure(e); }
    // the sun/ambient sliders: the engine rewrites sun/hemi intensity every frame inside update(t), so a multiplier
    // applied after it neither fights nor compounds
    const a = clock?.args;
    if (a) {
      if (a.sun != null && a.sun !== 1) sun.intensity *= a.sun;
      if (a.ambient != null && a.ambient !== 1) hemi.intensity *= a.ambient;
    }
    updateBakedDome(nowMs);
    updateInterimSky();
  }
  // a rated sky advances everyone's sun in lockstep, and a forecast needs the same heartbeat for its segment
  // boundaries; ~1 Hz is plenty
  if (skyTicks(clock?.args) && nowMs - lastClockTick > 1000) {   // a tz alone is the wall clock too
    lastClockTick = nowMs;
    render().catch((e) => report('sky clock', e));
  }
}

function noteSkyFailure(e) {
  if (impl !== 'eidoverse') return;
  if (++updateFailures < 8) return;          // tolerate a transient hiccup
  updateFailures = 0;
  const why = e?.message ?? String(e);
  console.error('[sky] per-frame failure:', why);
  // deliberately not rebuilding (a per-frame fault would rebuild every few frames): report once and leave the sky alone
  if (!skyFaultReported) {
    skyFaultReported = true;
    bus.emit('sky-degraded', { msg: `the sky hit a GPU fault (${why.slice(0, 70)}) — reload to retry it` });
  }
}
let skyFaultReported = false;

/** The library's modules register per-frame hooks here (grass wind, particles). */
export function updateAutoSystems(t) {
  for (const fn of globalThis._autoParticleSystems ?? []) fn(t);
}
