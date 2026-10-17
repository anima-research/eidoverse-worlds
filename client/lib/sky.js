// sky — time of day, weather, and the lighting that follows from them.
//
// Two implementations behind one verb:
//
//   1. Skye's world packages (`makeSky({world})` from sky_worlds.js) — a real
//      raymarched atmosphere, volumetric clouds, weather states with rain and
//      lightning, baked environment reflections, and whole alternate worlds
//      (ringworld, red-giant shieldworld). This is the good one.
//   2. three's SkyMesh — the fallback, kept because the toolkit branch is not
//      merged upstream yet and a client that hard-fails when the library moves
//      is a client nobody can run.
//
// The VERB is stable across both: {hours, rate, weather, clouds, …}. Which
// renderer answers it is an implementation detail the world log never sees.

import { THREE, scene, sun, hemi, renderer, camera } from './core.js';
// ?shadowdebug=1 — R 09-07 19:17: 'crank it way up to see if it's there at all'. Sun shadows measured ~10 % darker than lit
// ground (fill light drowns the sun's share); this dims the fill to a fifth so the shadow map's coverage is legible.
const SHADOW_DEBUG_FILL = new URLSearchParams(globalThis.location?.search ?? '').has('shadowdebug') ? 0.2 : 1;
import { report, bus, tee, teeNow, CONFIG } from './base.js';
import { loadEidoModule, primeFiles, listLibrary, fetchBytes } from './assets.js';
import { markPhase } from './boot.js';
import { bandCuts, bandedBakeRender, bakeGeneration } from './sky_baked.js';
import { BAKE_INTERCEPT, attachBakedDome, detachBakedDome, updateBakedDome, bakedActive, requestBake, holdLiveDomes, releaseLiveDomes, liveDomesHeld, takeHeldDomes,
  envTexture, adoptEnvironment, whenBakeReady, bakedRefreshing } from './sky_baked.js';
import { beginWork } from './loadwork.js';
import { makeSwapChain, SHOWN_UNKNOWN } from './sky_swapchain.js';
import { serializeBakes as serializeBakesWith, BAKE_GUARD, BAKE_AFTER, BAKE_HELD } from './sky_bakelock.js';
import { showInterimSky, updateInterimSky, hideInterimSky, interimSkyShown } from './sky_interim.js';
import { busy as loadingBusy } from './framebudget.js';
import { bootDone } from './boot.js';
import { setDayness, releaseForeignLights } from './lightrig.js';
import { warm, P_AMBIENT } from './warmqueue.js';
import { WEATHERS, effectiveSky, hoursAt } from '../../shared/forecast.js';
// Who owns which per-frame hook. The sky claims by diffing a GLOBAL array
// around its own async build; anything another subsystem marks as its own is
// off limits, whenever it appeared.
import { claimUnowned, releaseHook } from './autohooks.js';

// The environment exists from the first frame — BLACK, contributing nothing —
// so every material's lighting graph is born with its env branch in place.
// scene.environment flipping null→texture later regrew the lighting branch of
// EVERY PBR material at once (a whole-scene recompile, the biggest single
// invalidation behind the post-splash freezes). Now the sky's bakes change
// this texture's CONTENT; the object never changes; nothing ever recompiles
// for the environment again.
scene.environment = envTexture();

// ---------------------------------------------------------------- state

let impl = null;           // 'eidoverse' | 'skymesh' | null
let skyApi = null;         // Skye's sky object when impl === 'eidoverse'
let skyInner = null;       // _internals.sky — upstream's declared escape hatch (§18b)
let skyMesh = null;
// The skymesh-path fill light is born EAGERLY: light topology is frozen at
// boot (TEL0S_NOTES §12.1 — a light appearing later recompiles every lit
// material, and the old lazy creation fired exactly when the sky DEGRADED,
// the worst possible moment to pay a recompile storm). On the eidoverse
// path it idles at intensity 0, which costs its loop iteration and nothing
// else. (The emissive-lamp system that lived here is lightrig.js now —
// lamps are slot requests, not scene lights.)
const fillLight = new THREE.DirectionalLight(0xffffff, 0);
scene.add(fillLight);
let clock = null;          // { args, t0 } — the server-stamped epoch
let currentWorld = null;

export const skyArgs = () => clock?.args ?? {};
export const skyImpl = () => impl;
/** §22m diag: the sky-owned scene roots, for cost-attribution phases that
 *  hide the sky's DRAW without touching its state. Read-only. */
export const skyOwnedObjects = () => skyOwned ?? [];
/** 0 at night → 1 at noon. Lamps and other night-aware things read this. */
export let dayness = 1;

// ---------------------------------------------------------------- quality
//
// The volumetric cloud march is the single most expensive thing this client
// draws — measured on this hardware at roughly 120fps without it and 30 with.
// Its cost is dominated by `cloudPasses`, which sky_system defaults to 8;
// Skye's TIER=balanced drops that to 3, and even 3 is too much for a live
// frame budget on some machines.
//
// So every tier below 'high' now shows a BAKED sky instead of marching live
// (see sky_baked.js): the same march rendered once into the env-bake equirect
// and displayed on a static dome, re-baked only when the sky actually changes.
// The tier's cost moves from per-frame to per-bake, which is why 'medium'
// can afford the FULL 8-pass march — it looks better than the old live
// 3-pass tier and costs a texture lookup per pixel at runtime. The trade is
// stillness: clouds hold their shapes between re-bakes. 'high' keeps the live
// march (below).
//
// This is a CLIENT preference, not world state. It is deliberately never a
// verb: how many cloud passes your GPU can afford has nothing to do with what
// the world looks like, and one person's laptop must not dictate everyone
// else's sky. Stored locally, applied at build.
export const CLOUD_QUALITY = ['off', 'low', 'medium', 'high'];
// low, medium and high construct the SAME sky system (owner, 09-27: one system, so a switch among them never tears the
// sky down): the tiers differ only in what's shown (a bake at some size, or the live march). 'off' still builds its own.
const QUALITY_OPTS = {
  off: { cloudPasses: 1 },                     // plus setClouds('clear') below
  low: {},
  medium: {},
  high: {},                                    // the live march
};
// A stored 'live' (09-27's short-lived fifth tier) is today's 'high'.
if (localStorage.getItem('ew-cloud-quality') === 'live') localStorage.setItem('ew-cloud-quality', 'high');
// Baked-tier bake parameters. Anything listed here shows the baked dome; 'high' is deliberately absent: it is the live
// march, for people who want truly volumetric clouds (parallax, flying into them, continuous motion, full sharpness) and
// have the GPU: its program is a 1–2 MB shader whose first compile stalls the GPU process for seconds, and it marches
// every pixel every frame (40 fps on the owner's desktop card). (For part of 09-27 a baked 'high' existed, with the live
// march renamed 'live'; the bake was medium's to the texel, so the owner folded it back.) One resolution/pass
// choice PER SESSION per tier: bakeEnv keys its cached node graph on
// (W, H, passes), so every bake call must repeat the same values or each
// re-bake would rebuild and recompile the whole march pipeline.
// intervalMs is the crossfade cadence — sky_baked re-bakes on that clock and
// dissolves between bakes, which is what keeps the clouds' slow evolution
// smooth instead of stepping. The bake itself is banded (~2ms/frame), so a
// bigger equirect costs bake LATENCY, not frame rate — which is why 'medium'
// can afford 4096x2048 (the 2048 bake was ~4x undersampled against the
// screen and read as mush).
const BAKED_TIERS = {
  off: { width: 1024, height: 512, cloudPasses: 1, intervalMs: 12000 },   // clear sky anyway
  low: { width: 2048, height: 1024, cloudPasses: 3, intervalMs: 12000 },
  medium: { width: 4096, height: 2048, cloudPasses: 8, intervalMs: 9000 },
};
const bakeOpts = () => {
  const { width, height, cloudPasses } = BAKED_TIERS[cloudQuality] ?? {};
  // 'off' bakes no cloud branch whatever the weather (audit M3: weather_system's setWeather respells the preset to
  // cumulus/stratus under storm/rain/overcast, and the off tier then paid a cloud-program compile it opted out of)
  return width ? { width, height, cloudPasses, ...(cloudQuality === 'off' ? { includeClouds: false } : {}) } : {};
};
let cloudQuality = localStorage.getItem('ew-cloud-quality') ?? 'medium';
const BAND_BUDGET = 0.4e6;   // texels x passes per boot-bake band — sky_baked's cadence budget (~a few ms a strip)
export const getCloudQuality = () => cloudQuality;

// VR CAP: in a headset on the WEBGL backend, clouds never run 'high' (it falls back to 'medium', the baked panorama).
// 'high' is the volumetric march, per pixel
// PER EYE at the headset's full size (5920x2960 on the reporting headset) — 12-13 fps — and each eye marches from its
// own origin with its own noise, so the two eyes see different skies (sky double-vision, the world fine). 'medium' is
// the baked panorama both eyes look AT: stereo-correct and cheap. The saved choice is untouched and comes back on exit.
// ⚑ REVISIT WITH WEBGPU (owner, 09-27: 'not a mode in VR for the foreseeable future … revisit when WebGPU is more
// standard'). Live in VR is a giant per-eye cost on WebGL; once VR rides WebGPU-XR, measure fps and eye agreement with
// live clouds and lift this cap if they hold. WebGPU sessions aren't capped by this line today because VR runs WebGL.
let xrPresenting = false;
let xrCappedFrom = null;          // the level the cap replaced, restored on exit
const CAP_FROM = 'high', CAP_TO = 'medium';
const vrCapApplies = () => xrPresenting && !!renderer.backend?.isWebGLBackend;
// NO SKY REBUILD WHILE PRESENTING: a cloud-quality flip in VR rebuilt the sky system — the ~1.7MB cloud graph linked on
// the render path (100 s BLOCKING on one build in a live session), then a 4096x2048 boot bake whose frame held the GPU
// 4.3 s and tripped the driver watchdog: context lost, session gone. A rebuild is the single most expensive thing the
// client does and nothing about it is urgent inside a headset, so it waits for the exit. The dropdown keeps the choice
// (saved as usual); the world's own sky changes — time, weather, cloud kind — are uniform writes plus the cadence
// re-bake, which already paces itself between XR frames (sky_baked xrPumpTick), so everyone still sees the same sky.
// What waits is only what would REBUILD: a quality flip, or a switch of sky world.
let heldQuality = null;           // a quality chosen in the headset, applied at exit
let heldRebuild = false;          // a sky-world switch that arrived in the headset
/** What the headset is holding back, for the probe and the debug panel: { quality, rebuild } or null. */
export const skyHeld = () => (heldQuality || heldRebuild ? { quality: heldQuality, rebuild: heldRebuild } : null);
// In a headset the live cloud march never shows when a baked dome is on its way: held out until it attaches
// (sky_baked.holdLiveDomesInXR), and the gradient stands in (review 10b M1: holding every dome, atmosphere included, with
// nothing behind the world was a black sky in the headset for the minutes a cold bake takes). A tier with no baked dome
// (high, where the VR cap doesn't apply) keeps its march; so does a sky build whose baked dome failed to attach (P4:
// a costly sky beats no clouds; the 1 Hz render re-held them after that release, review 10b M1).
let attachFailedFor = null;       // the sky build whose baked dome could not attach
let bakeRetriedFor = null;        // the sky build whose failed bake already had its one retry
let headsetGradient = false;      // the gradient is up because holdLiveInHeadset put it there
function holdLiveInHeadset() {
  if (!xrPresenting || !BAKED_TIERS[cloudQuality] || cloudQuality === 'off' || bakedActive() || attachFailedFor === skyApi) return;
  if (holdLiveDomes(skyApi, 'in a headset until the baked dome is ready') && !interimSkyShown()) { showInterimSky(skyInner?.uniforms); headsetGradient = true; }
}
// The cap's deferred flip at entry (waiting for the entry curtain), cleared at every entry and exit: a quick exit and
// re-entry left the first session's timer armed into the next one (review 10b L1).
let capWait = null;
const clearCapWait = () => { capWait?.off?.(); clearTimeout(capWait?.tm); capWait = null; };
bus.on('xr:state', (on) => {
  xrPresenting = !!on;
  clearCapWait();
  if (on) { headsetGradient = false; holdLiveInHeadset(); }
  else if (!interimFor) {
    releaseLiveDomes();   // the desktop shows the live march until its bake lands (unless the boot hold is still waiting for the real sky)
    // the gradient only the headset needed goes with it; a swap in flight or a rebuild keeps its own
    if (headsetGradient && !swapping && !building) hideInterimSky();
  }
  headsetGradient = headsetGradient && !!on;
  // At exit, what was held applies: a held quality first (a same-system swap, or a rebuild for 'off'), then a held
  // sky-world switch once the sky is up (render() rebuilds on its own when the world differs). With the cap active, a
  // held quality is the cap's stand-in and its restore below replaces it; a held world switch rides after that restore.
  if (!on && (heldQuality || heldRebuild) && !xrCappedFrom) {
    const q = heldQuality, w = heldRebuild; heldQuality = null; heldRebuild = false;
    tee(`[sky] VR exit: applying the sky change held during the session (${[q && `clouds → ${q}`, w && 'sky world'].filter(Boolean).join(', ')})`);
    const done = q ? setCloudQuality(q, { persist: false }).catch((e) => report('sky held change (exit)', e)) : Promise.resolve();
    if (w) applyHeldWorldWhenUp(done);   // review 12b L2: both held used to drop the world
    return;
  }
  // a sky-world switch held while CAPPED survives to the cap's restore below (review 11b M1: it was dropped here; latent
  // today, SKY_WORLDS is earth only). A quality held while capped is the cap's own stand-in, which the restore replaces.
  const heldWorld = !on && heldRebuild && !!xrCappedFrom;
  if (!on) { heldQuality = null; heldRebuild = false; }
  // the tier the sky is running OR about to arrive as: a 'high' chosen on the desktop while the sky was arriving is
  // still only pending at entry, and was adopted inside the headset with no cap (review 10b H3: the per-eye live march
  // for the whole session). The cap takes the pending choice too.
  if (on && vrCapApplies() && (pendingTier ?? cloudQuality) === CAP_FROM) {
    xrCappedFrom = CAP_FROM;
    if (pendingTier === CAP_FROM) pendingTier = CAP_TO === cloudQuality ? null : CAP_TO;
    tee(`[sky] VR on WebGL: clouds capped ${CAP_FROM} → ${CAP_TO} (baked) for the session (the saved choice stays ${CAP_FROM})`);
    bus.emit('cloud-cap', { from: CAP_FROM, to: CAP_TO });
    // after the entry curtain is actually on screen (xr.js emits it), so the swap's bake doesn't take the GPU process
    // before the headset's first frames: that showed black or the runtime's own construct (owner's rig 09-27 22:24)
    // (a session that ended before this fires must not drop the desktop to medium: review 7, M2)
    // The cap's flip is the one quality change let through in the headset, and only this call carries the pass: a
    // module flag spanning the whole (minutes-long) swap let any pick made meanwhile through too, and 'off' then did a
    // full rebuild in VR (review 10b M2).
    const w = capWait = { off: null, tm: 0 };
    const go = () => { if (capWait !== w) return; clearCapWait(); if (!xrPresenting || xrCappedFrom !== CAP_FROM) return;
      setCloudQuality(CAP_TO, { persist: false, capFlip: true }).catch((e) => report('sky VR cap', e));
      holdLiveInHeadset();   // review 12b M1: a re-entry during the previous session's cap bake left the march on screen until it attached
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

// A held sky-world switch, applied once the preceding change has settled AND the sky is up, and only outside a
// headset (a new session holds it again). No forced currentWorld reset: render() rebuilds when the world differs
// (review 12b L1: the forced reset rebuilt twice and could drop the tier chosen while the sky arrived).
function applyHeldWorldWhenUp(after) {
  after.then(() => whenSkyUp()).then(() => {
    if (xrPresenting) { heldRebuild = true; return; }
    tee('[sky] VR exit: applying the sky world held during the session'); skyBuilds = 0; if (clock) render();
  });
}
/** The VR cap in force, for the sky panel's note: { from, to } or null. */
export const cloudCap = () => (xrCappedFrom ? { from: xrCappedFrom, to: CAP_TO } : null);
/** What the person CHOSE — a settings row shows this, not the level the VR cap is running meanwhile. */
// the cap's memory first: choosing the capped level in a headset HOLDS its stand-in (high → medium held), and the choice
// is still high (sky-cap-ui-probe caught the stand-in shown)
export const getCloudChoice = () => xrCappedFrom ?? heldQuality ?? pendingTier ?? cloudQuality;   // a choice made in the headset (or while the sky arrives: review 10b L3) shows at once
export const skyInXR = () => xrPresenting;

/** Change the local cloud budget. Rebuilds the sky, since passes are baked in
 *  at construction. */
// Where a sky rebuild's main-thread time goes (owner, 09-24 night: 4-5 s hitch on every cloud-quality flip). One line per
// rebuild: each phase's wall time + the long tasks (>50 ms, Chrome's longtask entries) that landed inside it — the
// hitch IS the long tasks. Teed so the owner's flips report to the server with no console.
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

export async function setCloudQuality(level, { persist = true, capFlip = false } = {}) {
  if (!CLOUD_QUALITY.includes(level)) return;
  // asking for 'high' INSIDE a WebGL headset session: remember it for the exit, run the baked 'medium' now
  if (level === CAP_FROM && vrCapApplies()) {
    xrCappedFrom = CAP_FROM;
    if (persist) localStorage.setItem('ew-cloud-quality', level);
    tee(`[sky] VR on WebGL: ${CAP_FROM} clouds held at ${CAP_TO} (baked) until exit`);
    bus.emit('cloud-cap', { from: CAP_FROM, to: CAP_TO });
    level = CAP_TO;
    persist = false;
  }
  else if (persist && xrPresenting && xrCappedFrom) { xrCappedFrom = null; bus.emit('cloud-cap', null); }   // a deliberate uncapped choice in the headset replaces the cap's memory
  if (persist) localStorage.setItem('ew-cloud-quality', level);   // before the no-op return: choosing the level already running is still a choice
  // choosing the running tier again also cancels a tier queued while the sky was arriving (review 7, M1: otherwise the
  // sky arrived as the tier the person had backed out of, e.g. an early VR entry and exit before arrival)
  if (level === cloudQuality) { heldQuality = null; if (pendingTier) { pendingTier = null; tee(`[sky] queued tier cancelled: staying ${level}`); } return; }
  if (xrPresenting && !capFlip) {   // capFlip: the VR cap's own entry flip, the one change let through (review 10b M2)
    heldQuality = level;
    tee(`[sky] clouds ${cloudQuality}→${level} held until VR exit (a rebuild in the headset stalls it for seconds)`);
    bus.emit('sky-held', { quality: level });
    return;
  }
  // A new choice gets its own single retry of a failed bake. The allowance was per sky BUILD, and a switch among low,
  // medium and high doesn't rebuild, so after one failure a later choice's failed bake never retried (sky-lifecycle-test).
  bakeRetriedFor = null;
  // low, medium and high construct the SAME sky system (audit, 09-27): a switch among them swaps what's shown instead of
  // tearing down and re-linking identical giant programs (every rebuild re-linked them, and three's WebGL backend never
  // frees a GL program, so each one also leaked in the GPU process). The VR cap's entry/exit flip rides this too.
  if (SAME_SYSTEM.has(cloudQuality) && SAME_SYSTEM.has(level) && skyApi && impl === 'eidoverse' && !building) {
    // Still arriving (the gradient's up, finishSky running): wait for it, THEN swap. A rebuild here threw the arriving
    // sky away, the VR cap's prebuilt program with it (owner's rig 09-27 22:05: VR entry 9 s after load, the medium
    // bake then compiled cold from scratch). The latest choice wins if several arrive meanwhile.
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

// sky_system.js ASSIGNS globalThis.makeSkySystem when sky_worlds evals it, and
// sky_worlds calls it in the same breath — so there is no moment in between to
// wrap it. Intercepting the assignment itself is the only seam, and it keeps
// Skye's files untouched.
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
      // AT BIRTH: the system adds its domes to the scene synchronously here, and makeSky then awaits more work, so
      // frames ran with the domes in the scene and the ~1 MB cloud program went to the render path on the very next
      // frame (the owner's reloads, 16:32/16:33: GPU process busy, Chrome and devtools frozen). Pull them out in the
      // same tick, before any frame; the interim gradient stands in and finishSky decides when (and whether) they
      // are ever built.
      // makeSkySystem is async with no await before its scene.add calls, so it resolves in a microtask: this .then runs
      // before sky_worlds' own await continues, and no frame can run in between.
      const hold = (sy) => {
        if (sy?.domes?.length && holdLiveDomes({ _internals: { sky: sy } }, 'from birth until the real sky is ready')) showInterimSky(sy.uniforms);
        return sy;
      };
      return typeof sys?.then === 'function' ? sys.then(hold) : hold(sys);
    };
  },
  set(fn) { _realMakeSkySystem = fn; },
});

// The canonical weather list lives in forecast.js (pure, shared with the
// sequencer fold and the mcpl agent) — re-exported here so existing importers
// keep their path.
export { WEATHERS } from '../../shared/forecast.js';
export const CLOUDS = ['clear', 'cumulus', 'stratus', 'cirrus'];
// Only `earth` is offered.
//
// ringworld and shieldworld each drag ~20MB of celestial geometry and add a
// second raymarched layer on top of the cloud dome; on this hardware they
// crawl and then take the tab down. They are not deleted from the toolkit —
// a log that asks for one is coerced below rather than refused — but nothing
// in the UI will hand someone a world that hangs their browser.
export const SKY_WORLDS = ['earth'];
const KNOWN_HEAVY = ['ringworld', 'shieldworld'];

// ---------------------------------------------------------------- entry point

/** Called by the world log's `sky` verb. `ts` is the server stamp — it is what
 *  makes every client's sun agree without the server simulating anything. */
export async function applySky(args = {}, ts) {
  // folded args carry their own ts (the shared fold stamps it); the param
  // stays as a fallback for un-folded callers like the tuner's preview path
  clock = { args: { ...args }, t0: args.ts ?? ts ?? Date.now() };
  logged = { args: clock.args, t0: clock.t0 };
  previewing = false;
  await render();
}

/** Local preview (the tuner) — same path, no new epoch. */
export async function previewSky(args) {
  clock = { args: { ...args }, t0: clock?.t0 ?? Date.now() };
  previewing = true;
  await render();
}

// What the LOG says, apart from what this client draws: a preview replaces `clock` but never `logged`.
let logged = null, previewing = false, rendering = 0;
export const loggedSky = () => logged;
export const skyPreviewing = () => previewing;
// 'sky-busy' comes from the sky's own arrival (a stand-in gradient, a tier swap compiling): loading too. Harmless unheard.
let arriving = false;
bus.on('sky-busy', (b) => { arriving = !!b; bus.emit('sky-state'); });
// A render only reads as 'loading…' once it has run past LOAD_SHOW_MS: a rated sky, a real clock or a forecast re-render
// every second and finish in a frame, and flashing the line at 1 Hz re-rasterised the whole World panel in VR
// (review 3, M3 / U1). Real builds and swaps take seconds, so they still show.
const LOAD_SHOW_MS = 400;
let renderSince = 0;
export const skyRendering = () => arriving || (rendering > 0 && performance.now() - renderSince >= LOAD_SHOW_MS);
export const skyDegraded = () => degrade >= 2;

function nowHours() {
  // the shared formula — the fold's hours-rebase on weather verbs uses the
  // same one, which is what keeps the sun from snapping (issue #29)
  return clock ? hoursAt({ ...clock.args, ts: clock.t0 }, Date.now()) : 12;
}

// How far the sky has been degraded to keep it working on this GPU.
//   0 = everything on
//   1 = GPU caches off — sky_system's light cache writes through
//       T3.textureStore, and three's WebGPU backend answers some uniform
//       layouts with `Uniform "storageTexture" not implemented`. Skye already
//       exposes LCACHE/DCACHE for this exact bisect, so the first fallback is
//       her supported knob, not our sledgehammer.
//   2 = give up, use three's SkyMesh
let degrade = 0;
// Rebuilding the sky is expensive and stacks (each makeSky evals its own
// sky_system + weather_system). A per-frame fault fires 60 times a second, so
// without a hard budget the "recovery" path builds six atmospheres and is far
// worse than the fault it was recovering from. Ask me how I know.
let skyBuilds = 0;
const MAX_SKY_BUILDS = 2;

// Every sky verb in a log calls render(), and replay no longer awaits them —
// so without this they run CONCURRENTLY, each entering the retry ladder with
// its own idea of how degraded things are, and each building its own sky.
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

  // No hold, no settle beat, no ordering dependency. A sky arriving used to
  // be the single most disruptive moment a running client had — weather
  // wraps rewrote materials, the env flip invalidated every pipeline, a new
  // light changed the topology — and holdObjectCompiles/holdFrames existed
  // to absorb exactly that. The factory (materials.js) now applies the
  // wraps at material birth, the env texture is persistent, and the light
  // rig swallows the weather's bolt: sky arrival invalidates NOTHING. The
  // sky's own meshes precompile detached inside buildSky, so even their
  // first frame doesn't stall. (TEL0S_NOTES §12.7 — the holds are gone.)
  {
    while (degrade < 2 && skyBuilds < MAX_SKY_BUILDS) {
    try {
      await renderEidoverse(a);
      return;
    } catch (e) {
      const why = e?.message ?? String(e);
      // An unsupported server is a fact, not a transient fault — stop dead.
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
      // the build budget counts FAILURES (§18b): it used to count every
      // build, so one failed-then-recovered boot left skyBuilds at MAX and
      // every later sky verb stacked a SkyMesh over the working eidoverse
      // sky without a teardown — and froze its updates (updateSky gates on
      // impl === 'eidoverse')
      skyBuilds++;
      degrade++;
      skyApi = null;
      currentWorld = null;
    }
    }
    // Falling to the basic sky without a full teardown (build budget spent):
    // the weather system will not be rebuilt, so its adopted bolt must not
    // outlive it here either.
    releaseForeignLights();
    impl = 'skymesh';
    // a rebuilding teardown may have put the stand-in gradient up; the basic sky replaces it, so 'sky-busy' can't stick
    // (UI review 3, L2a). Anyone waiting on the old build checks skyApi, which is null.
    interimFor = null; hideInterimSky(); markSkyUp();
    await renderSkyMesh(a);
    markPhase('sky', 1);
  }
}

// ============================================================ Skye's sky

// Which extra bytes a world package needs. Discovered from the server's
// directory listing rather than hardcoded — but split by world so `earth`
// doesn't drag 20MB of ringworld geometry through the door.
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
    // The toolkit sky reads its own assets synchronously, so the client has to
    // know what they ARE before handing control over — which it learns from
    // /library-list. A sequencer without that endpoint is older than this
    // client, and no amount of retrying will conjure it.
    const e = new Error('this world\'s sequencer is older than this client (no /library-list) — detailed sky unavailable');
    e.skyUnsupported = true;
    throw e;
  }
  const wanted = skyFiles.map((f) => f.path).filter((p) => {
    if (p.includes('/audio/')) return wantAudio;
    // ~20MB of ring geometry and asteroid fields — only for the worlds that
    // actually have them in the sky
    if (p.includes('/celestial/')) return world !== 'earth';
    return true;
  });
  await primeFiles([...MODULES, ...wanted, ...particles.map((f) => f.path)]);
}

// Single-flight. Replaying a log no longer AWAITS each sky verb (waiting for
// the atmosphere was most of a cold boot), which means several sky entries in
// one log fire concurrently — and every one of them saw `skyApi === null`,
// because none had finished yet, and built its own atmosphere. Six sky verbs
// produced six stacked sky systems and six weather systems. The guard has to
// be the in-flight PROMISE, not the finished result.
let building = null;

// The FIRST sky's warm, as a single-shot promise the boot gate can race
// (world.applySkyFolded): resolved when the first eidoverse build's dome
// warm drains through the conductor, OR when the sky lands on the skymesh
// fallback (its dome is one small material — nothing left worth gating on),
// whichever a degrading retry ladder reaches first. Later verbs/rebuilds
// never re-arm it: a mid-session sky has no curtain.
let _skyWarmResolve = null;
const _skyWarmDone = new Promise((r) => { _skyWarmResolve = r; });
function resolveSkyWarm() { _skyWarmResolve?.(); _skyWarmResolve = null; }
export const whenSkyWarm = () => _skyWarmDone;

// What the last sky build put into the scene.
//
// makeSky returns an api with no dispose — so `skyApi?.dispose?.()` was a
// no-op and every rebuild stacked another dome, weather system, particle hook
// and set of wrapped materials on top of the last. That is the accumulation:
// each world switch made the scene permanently heavier until it fell over.
// Since upstream cannot tell us what it added, we diff the scene around the
// build and own the difference.
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
    // never claim anything the world itself owns — entities, bodies, the
    // terrain, the meadow, debug groups: all can be added by other code
    // while an async sky build is in flight. skyExempt is the positive
    // marker world-owned roots wear at their add site (§17c — tel0s's
    // trace caught the claim swallowing the TERRAIN: a later sky rebuild
    // would have removed the ground with the old dome set)
    // (isDebug: debug.js has worn this marker with a "sky must not adopt"
    // comment since it was written — the filter just never read it)
    && !c.userData?.entityId && !c.userData?.isBody
    && !c.userData?.skyExempt && !c.userData?.isDebug);
  // Hooks are claimed the same way the scene children above are: by identity,
  // and never something another owner marked as theirs. It used to be a LENGTH
  // mark, which meant anything that registered a per-frame hook after the sky
  // built — a `particles` emitter on an entity — was silently truncated away
  // by the next sky rebuild and stopped billboarding, still in the scene,
  // facing wherever the camera happened to be. Identity alone is not enough:
  // this build is ASYNC, so a hook that appeared while it was in flight is new
  // but is not therefore ours — hence the host-owned marker.
  autoSystemsOwned = claimUnowned(snap.autos);
}
function teardownSky({ rebuilding = false } = {}) {
  // A rebuild keeps a gradient up through the teardown and the new build's module/texture loads (audit M2: a black gap on
  // every quality flip, and in the headset). The palette uniforms are plain objects and outlive the system. A teardown
  // to the basic sky drops it. A pending finishSky sees skyApi change and stops.
  interimFor = null; pendingTier = null; swaps.reset(); markSkyUp();   // anyone waiting for the old build: it's gone (they check skyApi)
  if (rebuilding && skyInner?.uniforms) showInterimSky(skyInner.uniforms); else hideInterimSky();
  // Held domes are taken, not put back (audit M5): never compiled, they must not reach the scene on the way out.
  const held = takeHeldDomes();
  // The adopted lightning first: the scene diff below cannot see it (the
  // rig's seam kept it OUT of the scene), and on teardowns that never
  // build a replacement weather system its registry-eviction release never
  // fires — without this, a dead mirror holds a reserved slot forever,
  // frozen at whatever the last strike left it.
  releaseForeignLights();
  // Put the parked live domes back first: the diff below claimed them at
  // build time, so restoring them lets the disposal pass find and free them.
  detachBakedDome();
  // §22b: the engine's OWN dispose — the only path to the ~64MB _envTarget,
  // the bake target, and the noise/weather textures. detachBakedDome above
  // deliberately leaves target A alive (it blits from it), and the api never
  // exposed dispose — so every cloud-quality rebuild leaked all of it
  // (measured: textures 69→77, renderTargets 7→11 across two flips — the
  // sticky-35fps ratchet on a unified-memory Mac). cloudShadowRoots is empty
  // in this client (the factory marks every mesh noCloudShadow), so the
  // unwrap loop inside is a no-op — no recompiles. Runs AFTER the blit,
  // BEFORE the dome disposal walk (double-dispose is idempotent in three).
  if (skyInner) skyInner.__dead = true;   // queued bakes skip it (serializeBakes)
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
  // the per-frame hooks the sky registered would otherwise keep running
  // against a dome that is no longer in the scene — and only those: everyone
  // else's hooks stay where they are (see claimSkyAdditions)
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
    const work = beginWork('sky build'); // names the module-eval + system-construction frame gaps
    building = buildSky(a, world, wantAudio).finally(() => work.end());
    try { await building; } finally { building = null; }
  }
  applyLive(a);
  // THE WORLD FIRST, THE SKY LAST (owner, 09-27). After a fresh build the real sky's domes stay out of the scene and
  // one plain gradient in the hour's own colours stands in; the curtain no longer waits on the sky (§19a's gate hid a
  // render-path stall that syncgate and this deferral now remove). The cloud programs start compiling only once the
  // world near you has loaded, and never inside the serial warm conductor. Detached, so later sky verbs (a preview, a
  // rated sky's 1 Hz re-render) apply at once instead of queueing behind minutes of compile.
  if (fresh && (holdLiveDomes(skyApi, 'until the real sky is ready') || liveDomesHeld())) {
    interimFor = skyApi;
    showInterimSky(skyInner?.uniforms);
    // Under the boot splash (owner, 09-27 22:03: 'move the pre-build step into the splash'): boot waits on this warm, so
    // the VR cap's bake program compiles while the splash is still up (its stall freezes the splash, not the world).
    // Capped at 40 s, inside the splash's own 45 s ceiling; a cold cache that takes longer finishes in-world.
    // Only at boot (review 7, L2): a later fresh build to high (off→high, a world switch) mustn't block the render chain
    // for 40 s in-world; finishSky's +15 s prebuild covers it.
    if (!BAKED_TIERS[cloudQuality] && !bootDone()) await Promise.race([prebuildCapBake(skyApi), new Promise((r) => setTimeout(r, 40000))]);
    resolveSkyWarm();
    finishSky(skyApi).catch((e) => report('sky finish', e));
    return;
  }
  if (interimFor) return;                // the real sky is still on its way: finishSky owns the bake
  holdLiveInHeadset();                   // a build in a headset: no live march on screen while its bake is coming
  const bake = beginWork('sky bake');    // names the env-bake + reflections gaps
  phase('apply');
  try { await ensureSkyBake(); } finally { bake.end(); }
  phase('bake');
  if (bakedActive()) await whenBakeReady();
  // a fresh build whose domes couldn't be held (engine internals moved) after a rebuilding teardown showed the stand-in:
  // nothing else hides it (UI review 3, L2b). Fresh only: a 1 Hz re-apply must not hide a size swap's gradient.
  if (fresh) hideInterimSky();
  resolveSkyWarm();
}

async function finishSky(api) {
  phase('apply');
  await worldSettled();
  if (skyApi !== api) return;            // torn down / rebuilt while we waited: the newer build owns the sky
  // a tier chosen while we waited (the VR cap at an early entry): same system, so just arrive as that tier
  if (pendingTier) { tee(`[sky] arriving as ${pendingTier} (chosen while the sky was loading)`); cloudQuality = pendingTier; pendingTier = null; }
  const bake = beginWork('sky bake');
  if (!BAKED_TIERS[cloudQuality]) {
    // the live tier: its env bake only lights reflections, so the clouds don't wait for it. On the owner's rig (09-27
    // 20:30) that bake's cold link took 120 s while the domes were ready sooner; the sky sat on the gradient throughout.
    // Both compile side by side; the domes show as soon as theirs are linked.
    ensureSkyBake().catch((e) => report('sky env bake', e)).finally(() => bake.end());
  } else {
    try { await ensureSkyBake(); } finally { bake.end(); }
  }
  phase('bake');
  if (bakedActive()) await whenBakeReady();
  // No baked dome (the high tier, a failed attach): the live domes ARE the sky. Compile them off the render path,
  // then show them. (A baked tier parks them unseen, so their programs are never built at all.)
  if (!bakedActive() && skyApi === api) await compileLiveDomes();
  if (skyApi !== api) return;
  // A baked tier chosen WHILE the live domes compiled (the VR cap, entering in those minutes; review 7, M3): releasing
  // would put the per-eye live march in the headset first. Arrive as the chosen tier instead: bake, the dome parks them.
  if (!bakedActive() && pendingTier && BAKED_TIERS[pendingTier]) {
    tee(`[sky] arriving as ${pendingTier} (chosen while the live domes compiled): baked, the live march never shown`);
    cloudQuality = pendingTier; pendingTier = null;
    bakePending = true;
    const late = beginWork('sky bake');
    try { await ensureSkyBake(); } catch (e) { report('sky bake', e); } finally { late.end(); }
    if (bakedActive()) await whenBakeReady();
    if (skyApi !== api) return;
  }
  if (!bakedActive()) releaseLiveDomes();   // compiled above: safe to show, headset or not
  interimFor = null;
  hideInterimSky();
  tee(`[sky] the real sky is up (${bakedActive() ? 'baked dome' : 'live domes'}); the interim gradient is gone`);
  markSkyUp();
  if (!BAKED_TIERS[cloudQuality] && capPrebuiltFor !== api) prebuildCapBakeWhenHeadset(api);   // a build that wasn't under the splash
}

// ENTERING VR FROM HIGH (owner, 09-27 21:52: 'pre-building medium in anticipation of a headset entry is a good idea').
// The VR cap swaps high → medium at entry, and medium's bake program (1.76M chars) compiled right then: the GPU process
// was busy for seconds, so no frame, not even the entry curtain, could be presented, and the headset showed its own
// WebXR construct (first frame +2.6 s). With a headset present, the program is compiled on the desktop instead, once,
// ~15 s after the sky is up. A bake's shader doesn't depend on its size, so it's built by a 64x32 bake of medium's
// pass count into a TEMPORARY target (the live tier's own env target and reflection fallback are put back), and
// retainBakeGraphs keeps that graph, so its program stays cached for the entry's 4096 bake.
let capPrebuiltFor = null;   // the sky build whose cap program is already compiled (or compiling)
const headsetPresent = async () => { try { return !!(await navigator.xr?.isSessionSupported?.('immersive-vr')); } catch { return false; } };
async function prebuildCapBake(api) {
  if (capPrebuiltFor === api || !(await headsetPresent())) return;
  if (skyApi !== api || BAKED_TIERS[cloudQuality] || xrPresenting) return;
  capPrebuiltFor = api;
  // the same guards again INSIDE the bake lock: queued behind a minutes-long bake, the prebuild's turn can come after a
  // VR entry (review 10b H2: its temporary target in a live session, and the cap's attach then read it)
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
  // the whole swap under the bake lock: no other bake may see the temporary target (see serializeBakes)
  let ran = false;
  await lock(async () => {
    if (sys.__dead) return;
    if (stillWanted && !stillWanted()) { tee('[sky] the VR cap\'s bake prebuild: no longer wanted when its turn came (skipped)'); return; }
    ran = true;
    const keepT = sys._envTarget, keepFb = sys._envFbNode?.value;
    sys._envTarget = null;
    try {
      // through the api (it adds the world's own bake options); BAKE_HELD tells the lock's wrapper this call already
      // holds the lock. (It used to step the wrapper aside by swapping sys.bakeEnv for the raw bake for the whole await,
      // so any bake called meanwhile ran unlocked, straight into this temporary target.)
      await api.bakeEnv({ width: 64, height: 32, cloudPasses, ...opts, [BAKE_HELD]: true });
    } catch (e) { ran = false; report('sky prebuild', e); }   // a failed prebuild isn't a prebuilt program
    finally {
      // put the real target and reflection fallback back NOW, not after the link wait below: for the minutes a cold
      // link takes, reflections would otherwise sample the undrawn 64x32 (review 7, L1). The graph keeps the program.
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
// 'sky-busy' (true/false): the sky is still arriving here (the stand-in gradient is up, or a tier swap is compiling or
// baking). Two listeners: xr.js's entry curtain, which waits on it (capped at 15 s), and the `arriving` flag above,
// which feeds skyRendering() and so the World › sky panel's "you: loading…".
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
// sky_system keeps ONE bake graph (sys._envBake) and disposes it whenever a bake with another key (size, passes, clouds)
// arrives. On the owner's rig (09-27 19:29) high's small env bake evicted medium's 1.76M-char bake program, so switching
// back re-created it: a ~3 s GPU-process stall even with Chrome's blob cache. three looks programs up by shader SOURCE
// and releases one only when no live material uses it, so the evicted graphs are kept (their dispose deferred, one per
// key) and a rebuild of the same graph is a program-cache hit. All of them go at teardown. Skye's file is untouched.
// ONE BAKE AT A TIME: sky_bakelock.js (serializeBakes, pure, tested by tools/sky-bakelock-test.mjs).
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
// ONE SWAP AT A TIME, LATEST CHOICE WINS: the chain and its SHOWN bookkeeping live in sky_swapchain.js (pure, tested by
// tools/sky-swapchain-test.mjs). swapTierInner below does the screen work.
const swaps = makeSwapChain({ inner: (from, to) => swapTierInner(from, to), want: () => cloudQuality, api: () => skyApi, log: (l) => tee(l) });
function swapTier(from) {
  swapping++; announceBusy();
  return swaps.swap(from).finally(() => { swapping--; announceBusy(); });
}
async function swapTierInner(from, to) {
  const t0 = performance.now(), api = skyApi;
  const F = BAKED_TIERS[from], T = BAKED_TIERS[to];
  // from = SHOWN_UNKNOWN (a superseded run left no tier on screen: the gradient up, the domes held or the live march
  // back): a baked `to` takes the baked→baked path, which assumes nothing about the screen (detach whatever dome, hold
  // the domes, gradient up, bake, attach); `high` takes !T, which compiles and then shows the live domes from any state
  // (detachBakedDome releases held domes, hideInterimSky drops the gradient). Review 10b H1.
  if ((F || from === SHOWN_UNKNOWN) && T) {
    // baked → baked at another size (low ↔ medium): a new bake into a new target. The old dome can't stay up (its
    // texture is the target the new bake re-creates), and detaching it brings back the live march, so the march is held
    // out and the gradient stands in until the new dome attaches (attachBakedDome parks the held domes itself).
    detachBakedDome();
    holdLiveDomes(skyApi, 'while the sky re-bakes at the new size');
    showInterimSky(skyInner?.uniforms);
    bakePending = true;
    try { await ensureSkyBake(); } catch (e) { report('sky tier swap', e); }
    if (bakedActive()) await whenBakeReady();
    // a newer choice arrived while this baked: its bake declined to attach (M1), and the queued swap owns the sky now,
    // so leave the gradient/hold up for it rather than release the live march in between. 'superseded' makes the chain
    // record NO tier as shown (SHOWN_UNKNOWN): the queued run always acts (final review H1: medium→low→medium stuck
    // cloudless; review 10b H1: recording `to` stranded A→B→C→B when C's run stood down)
    if (skyApi !== api) return false;
    if (cloudQuality !== to) return 'superseded';
    if (!bakedActive()) releaseLiveDomes();
    hideInterimSky();
  } else if (!T) {
    // the baked dome stays up while the live domes compile off the render path; then they replace it
    await compileLiveDomes();
    if (skyApi !== api || BAKED_TIERS[cloudQuality]) return false;
    detachBakedDome();
    hideInterimSky();                   // a superseded bake swap may have left the gradient up (H1)
    scheduleEnvBake({ force: true });   // the live tier's own env-IBL
  } else {
    // live → baked: the live march stays on screen while the bake runs (in a headset it's held out, the gradient
    // stands in: no per-eye march), then the baked dome parks it
    if (xrPresenting && holdLiveDomes(skyApi, 'in a headset until the baked dome is ready')) showInterimSky(skyInner?.uniforms);
    bakePending = true;
    try { await ensureSkyBake(); } catch (e) { report('sky tier swap', e); }
    if (bakedActive()) await whenBakeReady();
    // a newer choice arrived while this baked: its bake declined to attach (M1), and the queued swap owns the sky now,
    // so leave the gradient/hold up for it rather than release the live march in between. 'superseded' makes the chain
    // record NO tier as shown (SHOWN_UNKNOWN): the queued run always acts (final review H1: medium→low→medium stuck
    // cloudless; review 10b H1: recording `to` stranded A→B→C→B when C's run stood down)
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
  // compileAsync skips invisible objects; a hidden cloud dome would otherwise link later, on the render path (audit L3)
  const forced = domes.filter((d) => !d.parent && !d.visible);   // only while OUT of the scene: in it, visible = drawn
  for (const d of forced) d.visible = true;
  try { await Promise.all(domes.map((d) => renderer.compileAsync(d, camera, scene).catch(() => {}))); }
  // put back only what we flipped, and only if nothing else wrote it during the (minutes-long) compile (review 7, L6)
  finally { for (const d of forced) if (d.visible === true && !d.parent) d.visible = false; }
  tee(`[sky] live domes compiled in ${(performance.now() - t0).toFixed(0)} ms (off the render path)`);
}

async function buildSky(a, world, wantAudio) {
  {
    // tear down a previous world's sky before building another
    try { skyApi?.dispose?.(); } catch { /* upstream has none; the diff below is the real teardown */ }
    teardownSky({ rebuilding: true });
    skyApi = null;
    const ownership = snapshotSceneOwnership();
    // Quality tier. The volumetric cloud march is the single most expensive
    // thing in the client — it was authored for offline batch renders, where a
    // slow frame costs nothing. A live world needs a frame budget, so we ask
    // for the tier Skye already provides for this (3 cloud passes instead of
    // the full march) unless a world explicitly asks for the good one.
    const envKnobs = (globalThis.__ewEnv ??= {});
    envKnobs.TIER = a.quality === 'high' ? undefined : 'balanced';
    // GPU caches OFF by default.
    //
    // sky_system's light cache writes through T3.textureStore, and three's
    // WebGPU backend answers that with `Uniform "storageTexture" not
    // implemented` — as an UNHANDLED REJECTION from inside the pipeline, once
    // per frame, which no try/catch of ours can catch and which Chrome logs
    // itself no matter what we do. It reproduces on a real desktop Chrome while
    // passing in headless here, so it is not something to feature-detect
    // optimistically. Skye ships CACHE/LCACHE/DCACHE for exactly this bisect
    // and notes the density cache has a measured backend fault of its own.
    // Correctness first: opt IN with quality:'high', don't opt out after it
    // has already flooded someone's console.
    // Surgical: LCACHE only. CACHE=0 kills the density cache too and the sky
    // renders BLACK without it — the offending textureStore is in the LIGHT
    // cache alone (sky_system.js:1060), so that is the only thing to give up.
    envKnobs.CACHE = undefined;
    envKnobs.DCACHE = undefined;
    envKnobs.LCACHE = a.quality === 'high' ? undefined : '0';

    // (An `await whenBooted()` lived here — a bandwidth yield so the sky's
    // assets wouldn't race the body's through one pipe. It had to go: during
    // initial hydration arrival now GATES on this build's warm
    // (world.applySkyFolded, §16.2.D), and a sky that waits for boot while
    // boot waits for the sky is a splash that never lifts. The gating order
    // itself provides what the wait was for — the sky is no longer
    // competing with boot-critical work, it IS boot work.)
    phase('teardown');
    await primeFor(world, wantAudio);
    phase('prime');
    await loadEidoModule('sky_worlds.js');
    phase('module');
    if (typeof globalThis.makeSky !== 'function') throw new Error('sky_worlds.js exposed no makeSky');
    if (skyMesh) { scene.remove(skyMesh); skyMesh = null; }
    // A fresh build asserts state rather than easing into it — reset the
    // applyLive guards so the first applyLive after this re-asserts
    // everything against the new skyApi.
    forecastCursor = null; appliedWeather = null; appliedClouds = null; appliedColors = null;
    lastLiveHours = null;
    // Construct at the DERIVED weather, not the raw authored field — under a
    // forecast the authored field may be segments stale. Mid-transition, start
    // from the segment's previous state; applyLive transitions the remainder.
    const eff0 = effectiveSky(a, Date.now());
    const w0 = (eff0.source === 'forecast' && eff0.inTransition && eff0.seg.prevState)
      ? eff0.seg.prevState : eff0.weather;
    skyApi = await globalThis.makeSky({
      scene, camera, renderer, world,
      hours: nowHours(),
      clouds: cloudQuality === 'off' ? 'clear' : (CLOUDS.includes(a.clouds) ? a.clouds : 'cumulus'),
      weather: WEATHERS.includes(w0) ? w0 : 'clear',
      sun, hemi,
      audio: wantAudio,
    });
    phase('makeSky');
    claimSkyAdditions(ownership);
    // ---- the clear↔cloudy fence (§18b, pre-paid §19a) ----------------------
    // The baked tier's graph cache keys on preset !== 'clear' (sky_system
    // bakeKey …|c0/c1), and building the cloud-carrying graph costs a
    // ~1.5MB-WGSL compile that stalls the whole GPU process ~5-10s cold —
    // even async (Chrome serializes submits behind Tint). Nothing can hide
    // that compile; the only question is WHEN a session pays it. tel0s's
    // call (2026-08-10): inside the boot splash — so on cloud-capable
    // tiers 'clear' is ALWAYS respelled as an empty cumulus (finalMul 0 —
    // the march gates itself off at runtime): the preset is never 'clear',
    // the c1 graph pins at the boot bake (inside the sky gate, cap raised
    // for it), and every later sky change — dawn, dusk, clouds, weather —
    // is uniform writes. Warm-cache visits (Dawn's disk cache) pay ~none
    // of it. The wrap sits on the INTERNAL setter because the weather
    // system drives setClouds('clear') behind the api (WEATHER.clear).
    // The 'off' tier keeps genuine 'clear' always: it constructs c0 and
    // must stay there. When Skye lands the upstream asks (Addendum 2:
    // per-bakeKey cache / authoritative includeClouds), this whole fence
    // shrinks to one option flag.
    skyInner = skyApi?._internals?.sky ?? null;
    retainBakeGraphs(skyInner);
    serializeBakes(skyInner);
    // held from birth, the domes were never in the scene for the diff above: claim them by identity, so a teardown
    // (which puts held domes back first) still finds and frees them
    for (const d of skyInner?.domes ?? []) if (d && !skyOwned.includes(d)) skyOwned.push(d);
    if (skyInner?.setClouds && cloudQuality !== 'off') {
      const orig = skyInner.setClouds.bind(skyInner);
      skyInner.setClouds = (kind, over) => (kind === 'clear'
        ? orig('cumulus', { ...(over ?? {}), finalMul: 0, wispOn: 0, stormCanopy: 0 })
        : orig(kind, over));
    }
    // Warm the sky's OWN pipelines off the render path: the cloud march is
    // the biggest single compile in the client, and a regular render that
    // meets an uncompiled dome creates its pipeline SYNCHRONOUSLY — one big
    // stall exactly when the sky first appears. Each claimed addition goes
    // through the warm conductor (§16.2.A) — one item per dome, serialized
    // against every other pipeline warm, a real frame between items: it
    // detaches, compiles against the live scene, re-adds warm (the grass
    // precompile pattern). Nothing ELSE needs settling — sky arrival no
    // longer invalidates the rest of the scene. During initial hydration
    // the curtain waits for this loop (whenSkyWarm below) — measured 3.1s
    // that used to land squarely in the visible window (§16.1g).
    // THE DOMES DO NOT GO THROUGH THE CONDUCTOR. It runs one item at a time, and on a cold GPU cache the cloud dome's
    // link takes minutes on WebGL (owner's rig, 09-27: 125 s), so every model pipeline queued behind it waited: the
    // world sat unloaded while the sky compiled ("backwards", the owner). They stay out of the scene now, under the
    // interim sky, and compile after the world near you has loaded (renderEidoverse). Everything else still warms here.
    const bigDomes = new Set(skyInner?.domes ?? []);
    const warmed = new Set();
    for (const o of skyOwned) {
      if (bigDomes.has(o)) continue;
      warmed.add(o);
      // P_AMBIENT: dome warmth never queues ahead of the ground/models a
      // person is actually waiting for (the 16s-boot lesson, warmqueue.js)
      await warm(`sky warm ${(o.name || o.type || 'dome').slice(0, 24)}`, async () => {
        scene.remove(o);
        try { await renderer.compileAsync(o, camera, scene).catch(() => {}); }
        finally { scene.add(o); }
      }, { p: P_AMBIENT });
    }
    tee(`[sky] build owns ${skyOwned.length}: ${skyOwned.map((o) => `${o.geometry?.type ?? o.type}${warmed.has(o) ? '=warmed' : '=later'}`).join(' ')}`);
    // resolveSkyWarm moved to renderEidoverse (§19a): the gate now waits
    // for the first BAKE too, not just the dome warms
    phase('dome-warm');
    currentWorld = world;
    impl = 'eidoverse';
    scene.background = null;

    // The first bake + baked-dome attach happen AFTER applyLive (see
    // ensureSkyBake) — the verb's clouds/weather must be asserted first.
    // makeSky's own weather default is 'clear', which OVERRIDES the cloud
    // preset (sky_worlds documents the trap), and bakeEnv caches its node
    // graph keyed on whether clouds exist at bake time: baking here pinned
    // a graph with NO cloud branch and the baked sky came out empty.
    bakePending = true;
    markPhase('sky', 1);
    bus.emit('sky-ready', { impl, world });
  }

}

// Once per build, after the log's sky verb has been applied: bake the
// environment and (on baked tiers) swap the live domes for the baked one.
let bakePending = false;
async function ensureSkyBake() {
  if (!bakePending || !skyApi) return;
  bakePending = false;
  // the tier this bake is FOR: its size and passes come from it (bakeOpts), and so must the attach below. A choice
  // made while it ran (the VR cap, adopted in finishSky: review 8, M1) queues its own bake, which owns the attach.
  const tier = cloudQuality;
  // Environment reflections. `scene.environment` was never set, so every PBR
  // material in the world was lit by a hemisphere and a directional only —
  // metals and glossy surfaces read as dead plastic. The sky can bake itself.
  // (sky_worlds' bakeEnv takes ONE options bag — the old `(renderer, {})`
  // call was spreading the renderer into the options and working by luck.)
  // On baked tiers this same bake IS the visible sky, so it renders at the
  // tier's display resolution and full march quality.
  const gen = bakeGeneration();       // a teardown mid-bake bumps it: the strips stop, nothing attaches to a dead sky
  const api = skyApi;
  // Everything after the bake that reads the engine's target and graph (adopting the env, the attach), run INSIDE the
  // bake lock by serializeBakes (BAKE_AFTER): after the lock is released a queued bake can swap in the VR prebuild's
  // temporary target or resize the target for the live tier, and the dome attached to that (review 10b H2). Once.
  let posted = false, baked = false;
  const post = ({ ok }) => {
    if (posted) return; posted = true;
    if (ok) {
      lastBakeHours = nowHours();
      lastBakeAt = performance.now();
      if (bakeGeneration() === gen) {
        api.enableReflections?.({});
        // the engine just pointed scene.environment at ITS target — copy the
        // content into the persistent texture and put it back (see module top)
        adoptEnvironment();
      }
    }
    if (bakeGeneration() !== gen || skyApi !== api) return;   // torn down while baking: a newer build owns the sky now
    if (tier !== cloudQuality) { tee(`[sky] bake for ${tier} finished after the choice moved to ${cloudQuality}: not attached (its own bake will)`); return; }
    if (!ok && BAKED_TIERS[tier]) {
      // a failed bake left the target undrawn: attaching would show a black dome. Same policy as a failed attach below:
      // the live march stays (a costly sky beats no clouds; review 12b L4)
      attachFailedFor = skyApi;   // or the 1 Hz render's holdLiveInHeadset re-holds them within a second
      // while the sky is still arriving, finishSky releases them once COMPILED (review 13 L2), as on success
      if (!interimFor) releaseLiveDomes();
      // ONE retry after a pause (review 13 L1: without it, one failure kept the live march for the whole visit; the old
      // black dome at least re-baked on its cadence). A second failure stays on the live march until the next choice.
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
        // engine internals moved (or the bake failed) — the live march is
        // still in the scene, so the sky stays correct, just expensive. Domes held out in a headset come back too:
        // a costly sky beats no clouds for the whole session (review 09-27, P4). The headset hold stands down for this
        // sky build from here on (review 10b M1: the 1 Hz render re-held them, no dome and no gradient).
        attachFailedFor = api;
        if (!interimFor) releaseLiveDomes();   // while the sky is arriving, finishSky releases them once COMPILED
        console.warn('[sky] baked dome could not attach — staying on the live cloud march');
        tee('[sky] baked dome could not attach — the live cloud march stays (in a headset too)');
      } else {
        attachFailedFor = null;
        if (headsetGradient) { headsetGradient = false; hideInterimSky(); }   // the dome it stood in for is up (M1)
      }
    } else if (!interimFor) releaseLiveDomes();   // while the sky is arriving, finishSky releases them once COMPILED
  };
  try {
    // The boot bake as BANDS (sky_baked.js bandedBakeRender): bakeEnv's one full-quad renderAsync is intercepted for
    // this call only and re-issued as cost-weighted strips across frames — same material, same texels. ?skyband=0 = off.
    const opts = bakeOpts();
    let outer = renderer.getRenderTarget();
    let origRA = renderer.renderAsync;
    const band = CONFIG.params.get('skyband') !== '0' && opts.width
      && bandCuts(opts.width, opts.height, opts.cloudPasses ?? 8, BAND_BUDGET).length > 3;
    // the decision, teed: on the owner's GPU (09-24 night) the banded line never appeared — say WHICH gate refused
    const strips = opts.width ? bandCuts(opts.width, opts.height, opts.cloudPasses ?? 8, BAND_BUDGET).length - 1 : 0;
    tee(`[sky] boot bake: ${band ? 'banding' : CONFIG.params.get('skyband') !== '0' ? 'one-shot, precompiled' : 'ONE-SHOT'} (skyband=${CONFIG.params.get('skyband') ?? 'default'}, ${opts.width}x${opts.height}, passes ${opts.cloudPasses ?? 8}, ${strips} strips, inner ${skyInner ? 'yes' : 'NO'})`);
    let seen = 0;
    // ONE-SHOT bakes (a tier with no baked dome — 'high' bakes only the env, at bakeEnv's default size — or a bake too
    // small to band) still compile their pipeline OFF the render path first: the owner's GPU, 09-24, switch → high:
    // "render-path build 1295 ms (BLOCKING) NodeMaterial fs 925288 chars". Same bytes, same single draw — only the
    // compile moves earlier (compileAsync, as the banded path already does). ?skyband=0 keeps the old path untouched.
    const precompile = !band && CONFIG.params.get('skyband') !== '0';
    const interceptor = !(band || precompile) ? null : function (sc, cam) {
      if (sc !== skyInner?._envBake?.scene) { if (seen++ < 2) tee(`[sky] boot bake: a renderAsync passed through (not the bake scene: ${sc?.type ?? typeof sc}, envBake ${skyInner?._envBake ? 'set' : 'unset'})`); return origRA.call(this, sc, cam); }
      renderer.renderAsync = origRA;
      if (precompile) {
        // the bake target is bound on entry (bakeEnv) — capture it: during the await, frames run and render.js's
        // self-heal UNBINDS any target left bound at frame start, so the draw must re-bind it or it lands on the canvas
        const target = renderer.getRenderTarget();
        const t0 = performance.now();
        const compiling = renderer.compileAsync(sc, cam);   // the target is read here, at the call…
        renderer.setRenderTarget(outer ?? null);            // …so nothing stays bound while it links (frames run meanwhile)
        return compiling.catch(() => {})
          .then(() => globalThis.__syncGate?.whenGiantLinked?.())   // a deferred giant link must land before the one draw (09-27)
          .then(() => { tee(`[sky] one-shot bake precompiled in ${(performance.now() - t0).toFixed(0)} ms`); renderer.setRenderTarget(target); return origRA.call(renderer, sc, cam); });
      }
      const target = renderer.getRenderTarget();
      renderer.setRenderTarget(outer ?? null);   // bakeEnv left the bake target bound; the frames between bands are the world's
      const t0 = performance.now();
      // In a headset the live domes are the full per-eye cloud march (the ~12 fps double vision the VR cap exists to
      // avoid), on screen for every frame of the bake: out of the scene while it bands, back before the baked dome
      // attaches (which parks them properly). On the desktop they stay: correct, just slower for a couple of seconds.
      const hidden = renderer.xr?.isPresenting ? (skyApi?._internals?.sky?.domes ?? []).filter((d) => d?.parent).map((d) => [d, d.parent]) : [];
      for (const [d, p] of hidden) p.remove(d);
      return bandedBakeRender(renderer, sc, cam, target, { cloudPasses: opts.cloudPasses ?? 8, passTexelBudget: BAND_BUDGET, budget: true, alive: () => bakeGeneration() === gen, sys: skyInner })
        .then((n) => { const l = `[sky] boot bake banded: ${n} bands over ${(performance.now() - t0).toFixed(0)} ms`; console.log(l); tee(l); renderer.setRenderTarget(target); })
        .finally(() => { if (bakeGeneration() === gen) for (const [d, p] of hidden) if (!d.parent) p.add(d); });   // torn down: those domes were disposed
    };
    // installed inside the bake lock, right before THIS bake runs (review 7, B1)
    const install = interceptor && (() => { origRA = renderer.renderAsync; outer = renderer.getRenderTarget(); renderer.renderAsync = interceptor;
      return () => { if (renderer.renderAsync === interceptor) renderer.renderAsync = origRA; }; });
    await api.bakeEnv?.({ ...opts, ...(install ? { [BAKE_INTERCEPT]: install } : {}), [BAKE_AFTER]: post });
    baked = true;
  } catch (e) { console.warn('sky reflections unavailable', e); tee(`[sky] boot bake failed: ${e?.message ?? e}`); }
  post({ ok: baked, skipped: false });     // no lock wrapper (engine internals moved): the same work, here
}

// Re-baking the environment map.
//
// bakeEnv runs once at construction, and `scene.environment` then dominates
// every PBR surface in the world — so the ground stayed lit at whatever hour
// the sky happened to be built at. Midnight rendered a correct starfield over
// grass at full noon brightness, which is the "lighting doesn't change" that
// was reported: the SKY was changing the whole time, the IBL lighting
// everything under it was not.
//
// The bake is 512x256 and costs a render, so it is debounced and rate-limited
// rather than run per frame or per slider tick.
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
  // On baked tiers the crossfade loop owns the re-bake clock — a stray
  // timer must not blocking-render a full-quad bake on top of it.
  if (bakedActive()) return requestBake();
  // …and a baked tier whose dome hasn't attached YET (the interim wait, world-first) must not either: this full-quad
  // bake was the synchronous caller of the 1.76 MB bake program the owner's GPU froze on (09-27, runEnvBake in the
  // backstop's caller stack), and its deferred draw left the first target black. The boot bake covers env there.
  if (BAKED_TIERS[cloudQuality] || interimFor) return;
  tee(`[sky] env re-bake (${cloudQuality} tier, live env)`);
  lastBakeAt = performance.now();
  lastBakeHours = nowHours();
  const api = skyApi;
  // the same checks again INSIDE the bake lock (BAKE_GUARD): queued behind a minutes-long bake (a superseded medium one),
  // this 512x256 bake resized the target in place and swapped the graph right before medium's dome attached to it: a
  // 512 mush dome (review 10b H2). And the re-adopt runs inside the lock too (BAKE_AFTER), before anything else bakes.
  const stillLive = () => skyApi === api && !bakedActive() && !BAKED_TIERS[cloudQuality] && !interimFor;
  let called = false;
  const adopt = ({ ok }) => {
    if (called) return; called = true;
    if (!ok) return;
    // live tier: the engine rebaked into its own target — re-point (engine
    // reassigns) then re-adopt, so the persistent env picks up the new light
    api.enableReflections?.({});
    adoptEnvironment();
  };
  try {
    // Same opts every time — bakeEnv caches its node graph keyed on them.
    await api.bakeEnv({ ...bakeOpts(), [BAKE_GUARD]: stillLive, [BAKE_AFTER]: adopt });
    adopt({ ok: true });   // no lock wrapper (it calls adopt exactly once, skipped or not): here, as before
  } catch (e) {
    console.warn('[sky] env re-bake failed', e?.message ?? e);
  }
}

/** Settings that apply to an already-built sky — cheap, idempotent, and safe
 *  to run for every sky verb in a log AND once a second under a forecast or a
 *  rated day (see updateSky), which is why everything below is guarded to
 *  fire only on actual change. */
let forecastCursor = null;   // O(1) live ticking — the segment walk never re-runs from epoch
let appliedWeather = null;   // `state|k` last asserted on skyApi; null = fresh build
let appliedClouds = null;
let appliedColors = null;
let lastLiveHours = null;    // detects VERB-driven clock jumps (§18b)
function applyLive(a) {
  if (!skyApi) return;
  const h = nowHours();
  skyApi.setTime?.(h);
  // Baked tiers re-bake on their own cadence (which covers TOD drift too);
  // the debounced TOD bake only serves the live ('high') tier's env-IBL.
  if (!bakedActive() && !BAKED_TIERS[cloudQuality] && !interimFor) scheduleEnvBake();   // the live tier only
  let changed = false;
  // A dusk/dawn VERB used to wait out the 9s bake cadence before the
  // visible dome moved (§18b) — a clock JUMP asks for a bake now. Circular
  // delta so the daily midnight wrap doesn't read as a jump; TOD drift
  // between 1Hz calls stays far under the threshold.
  if (lastLiveHours !== null) {
    const d = Math.abs(h - lastLiveHours);
    if (Math.min(d, 24 - d) > 0.75) changed = true;
  }
  lastLiveHours = h;
  // An authored 'clear' flows to the setter like any other kind — the §18b
  // fence renders it as an EMPTY cumulus on capable tiers so the graph
  // never flips flavours. Unauthored stays null (construction's default
  // look, exactly as before).
  const clouds = cloudQuality === 'off' ? 'clear'
    : (a.clouds && CLOUDS.includes(a.clouds) ? a.clouds : null);
  if (clouds && clouds !== appliedClouds) {
    skyApi.setClouds?.(clouds);
    appliedClouds = clouds;
    changed = true;
  }
  // What the sky should show NOW — authored weather, the forecast's current
  // segment, or a manual override that holds until the segment boundary. The
  // derivation is shared with the sequencer and the mcpl agent (forecast.js),
  // so every client and every text-tier perceiver lands on the same state
  // without the server simulating anything.
  const eff = effectiveSky(a, Date.now(), forecastCursor);
  forecastCursor = eff.cursor;
  if (eff.weather) {
    const key = `${eff.weather}|${(eff.k ?? 1).toFixed(2)}`;
    if (key !== appliedWeather) {
      const fresh = appliedWeather === null;
      if (fresh && eff.source === 'forecast' && eff.inTransition && eff.seg.prevState) {
        // joined mid-transition: ease in over the REMAINING time so this
        // client's sky finishes changing when everyone else's does
        const remain = Math.max(1, (eff.seg.startMs + eff.seconds * 1000 - Date.now()) / 1000);
        skyApi.transitionTo?.(eff.weather, eff.k ?? 1, remain);
      } else if (!fresh && eff.seconds) {
        skyApi.transitionTo?.(eff.weather, eff.k ?? 1, eff.seconds);
      } else {
        skyApi.setWeather?.(eff.weather, eff.k ?? 1);
      }
      // provenance stays legible: a derived change names its policy, a manual
      // one its actor — an ambient world, but never an unattributed one
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
  // The baked dome only changes when a bake lands — a change to the sky's
  // look asks for one now (the crossfade eases it in, and the rolling
  // cadence carries any longer weather transition by itself).
  if (bakedActive() && changed) {
    requestBake();
  }

  // NOTE the ownership boundary: makeSky was handed `sun` and `hemi` and it
  // drives them itself (colour, intensity, and the fog/haze that follow the
  // weathered sky). Re-deriving those here would fight it — a sunset would get
  // our noon-ish curve stamped back over Skye's. So on this path the tuner
  // only applies the knobs the world genuinely owns: exposure, and the lamp
  // response to time of day.
  applyTuning(a, Math.max(0, Math.sin(((nowHours() - 6) / 12) * Math.PI)), undefined, null, true);
}

// ============================================================ SkyMesh fallback

async function renderSkyMesh(a) {
  const hours = nowHours();
  const { SkyMesh } = await import('three/addons/objects/SkyMesh.js');
  if (!skyMesh) {
    skyMesh = new SkyMesh();
    skyMesh.scale.setScalar(280);
    // FogExp2(0.018) over a 280-unit dome = e^-5 — the atmosphere would render
    // as pure fog colour. The sky is not IN the weather; exempt it.
    skyMesh.material.fog = false;
    skyMesh.userData.noCamCollide = true;
    scene.add(skyMesh);
  }
  impl = 'skymesh';

  const day = Math.max(0, Math.sin(((hours - 6) / 12) * Math.PI)); // 0 night → 1 noon
  const elev = -8 + 68 * day;
  const phi = THREE.MathUtils.degToRad(90 - elev);
  const theta = THREE.MathUtils.degToRad(a.azimuth ?? 180);
  const sunPos = new THREE.Vector3().setFromSphericalCoords(1, phi, theta);
  skyMesh.sunPosition.value.copy(sunPos);
  // Haze thickens as the sun drops — that's what actually paints a sunset dome;
  // a clear noon atmosphere at 13° elevation just looks grey.
  const warmth = Math.pow(1 - day, 1.5);
  skyMesh.turbidity.value = 6 + 7 * warmth;
  skyMesh.rayleigh.value = 1.6 + 1.6 * warmth;
  skyMesh.mieCoefficient.value = 0.004 + 0.012 * warmth;
  skyMesh.mieDirectionalG.value = 0.8;

  sun.position.copy(sunPos).multiplyScalar(60);
  // Light temperature follows the sun: white and hard at noon, warm and soft
  // near the horizon (a low sun that stays noon-white reads as overcast).
  sun.color.lerpColors(new THREE.Color(0xfff2e0), new THREE.Color(0xffab5e), warmth);
  hemi.color.lerpColors(new THREE.Color(0xbfd4ff), new THREE.Color(0xe0b98f), warmth * 0.85);
  hemi.groundColor.lerpColors(new THREE.Color(0x283024), new THREE.Color(0x5a4630), warmth);
  scene.background = null;

  applyTuning(a, day, warmth, sunPos);
  // every degraded/fallback route ends here — the boot gate must not wait
  // for a dome warm that will never come
  resolveSkyWarm();
}

// ============================================================ shared tuning
// The exposure/fill/fog knobs apply to whichever sky is underneath, so the
// tuner sliders behave identically on both.

function applyTuning(a, day, warmth = Math.pow(1 - day, 1.5), sunPos = null, skyOwnsLights = false) {
  if (!skyOwnsLights) {
    sun.intensity = (0.4 + 2.2 * day) * (a.sun ?? 1);
    // Low sun ≠ dark subjects: golden hour is FULL of scattered warm light.
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

  // Fog DENSITY is the world's on both paths: the real sky drives fog
  // COLOR (applyToLights) and never the density — so this slider was dead
  // on the shipped sky for no reason at all (§12.6's tuner audit).
  if (scene.fog) scene.fog.density = 0.018 * (a.fog ?? 1);

  // Exposure is the world's, not the sky's — it's the tuner's one global knob
  // and it must work identically on both implementations.
  renderer.toneMappingExposure = (skyOwnsLights ? 1 : (1.0 - 0.22 * warmth)) * (a.exposure ?? 1);

  dayness = day;
  // the rig dims lamps and placed lights on this same clock (lamp inference
  // itself lives there too — lightrig.attachLamps, requests not lights)
  setDayness(day);
}

// ---------------------------------------------------------------- per-frame

let lastClockTick = 0;
let updateFailures = 0;
export function updateSky(nowMs, t) {
  // A toolkit sky that throws from its PER-FRAME update is invisible to the
  // try/catch around construction: the object exists, renders nothing, and
  // rejects once per frame forever — a black sky and a console filling at
  // 60Hz. Count failures and fall back for good.
  if (impl === 'eidoverse' && skyApi?.update) {
    try {
      const r = skyApi.update(t);
      if (r && typeof r.catch === 'function') r.catch(noteSkyFailure);
      else updateFailures = 0;
    } catch (e) { noteSkyFailure(e); }
    // The sun/ambient sliders, rescued: the engine's applyToLights rewrites
    // sun/hemi intensity EVERY frame inside update(t), so a multiplier
    // applied after it neither fights nor compounds — the palette drives,
    // the resident garnishes. (This is the layering sky_worlds' own
    // comment invites: "update, then adjust, then render".)
    const a = clock?.args;
    if (a) {
      if (a.sun != null && a.sun !== 1) sun.intensity *= a.sun;
      if (a.ambient != null && a.ambient !== 1) hemi.intensity *= a.ambient;
    }
    updateBakedDome(nowMs);   // camera-follow + the band-bake/crossfade cycle
    updateInterimSky();
  }
  // A rated sky advances everyone's sun in lockstep, and a forecast needs the
  // same heartbeat to notice its segment boundaries. ~1Hz is plenty — even at
  // rate 24 the sun moves 0.1°/s, and the forecast's cursor makes each check
  // O(1) (never a re-walk from the policy epoch).
  if (((clock?.args.rate ?? 0) !== 0 || clock?.args.clock === 'real' || clock?.args.forecast) && nowMs - lastClockTick > 1000) {
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
  // Deliberately NOT rebuilding. A fault that fires every frame would rebuild
  // every few frames, and each rebuild stacks another atmosphere and weather
  // system on the scene. Report it once and leave the sky alone; a wrong sky
  // you can still walk under beats six right ones fighting each other.
  if (!skyFaultReported) {
    skyFaultReported = true;
    bus.emit('sky-degraded', { msg: `the sky hit a GPU fault (${why.slice(0, 70)}) — reload to retry it` });
  }
}
let skyFaultReported = false;

/** Skye's modules register per-frame hooks here (grass wind, particles). */
export function updateAutoSystems(t) {
  for (const fn of globalThis._autoParticleSystems ?? []) fn(t);
}
