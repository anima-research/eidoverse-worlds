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
import { report, bus } from './base.js';
import { loadEidoModule, primeFiles, listLibrary, fetchBytes } from './assets.js';
import { markPhase } from './boot.js';
import { attachBakedDome, detachBakedDome, updateBakedDome, bakedActive, requestBake,
  envTexture, adoptEnvironment, whenBakeReady } from './sky_baked.js';
import { beginWork } from './loadwork.js';
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
// stillness: clouds hold their shapes between re-bakes. 'high' keeps the
// real thing.
//
// This is a CLIENT preference, not world state. It is deliberately never a
// verb: how many cloud passes your GPU can afford has nothing to do with what
// the world looks like, and one person's laptop must not dictate everyone
// else's sky. Stored locally, applied at build.
export const CLOUD_QUALITY = ['off', 'low', 'medium', 'high'];
const QUALITY_OPTS = {
  off: { cloudPasses: 1 },                     // plus setClouds('clear') below
  low: { cloudPasses: 1, stormSamples: 6 },
  medium: { cloudPasses: 3 },
  high: {},                                    // sky_system's own defaults (8)
};
// Baked-tier bake parameters. Anything listed here shows the baked dome;
// 'high' is deliberately absent — it is the live march. One resolution/pass
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
  return width ? { width, height, cloudPasses } : {};
};
let cloudQuality = localStorage.getItem('ew-cloud-quality') ?? 'medium';
export const getCloudQuality = () => cloudQuality;

/** Change the local cloud budget. Rebuilds the sky, since passes are baked in
 *  at construction. */
export async function setCloudQuality(level) {
  if (!CLOUD_QUALITY.includes(level) || level === cloudQuality) return;
  cloudQuality = level;
  localStorage.setItem('ew-cloud-quality', level);
  currentWorld = null;          // force a rebuild at the new budget
  skyBuilds = 0;
  if (clock) await render();
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
    return (args = {}) => _realMakeSkySystem({
      ...args,
      opts: { ...(args.opts ?? {}), ...QUALITY_OPTS[cloudQuality] },
    });
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
  await render();
}

/** Local preview (the tuner) — same path, no new epoch. */
export async function previewSky(args) {
  clock = { args: { ...args }, t0: clock?.t0 ?? Date.now() };
  await render();
}

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
  renderChain = renderChain.then(renderOnce, renderOnce);
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
function teardownSky() {
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
  try { skyInner?.dispose?.(); } catch (e) { console.warn('[sky] engine dispose', e?.message ?? e); }
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
  if (!skyApi || currentWorld !== world) {
    const work = beginWork('sky build'); // names the module-eval + system-construction frame gaps
    building = buildSky(a, world, wantAudio).finally(() => work.end());
    try { await building; } finally { building = null; }
  }
  applyLive(a);
  const bake = beginWork('sky bake');    // names the env-bake + reflections gaps
  try { await ensureSkyBake(); } finally { bake.end(); }
  // §19a: on baked tiers the curtain waits for the first bake's band
  // pipeline too — the one big cloud-graph compile lands behind the splash
  // (tel0s's call), not in the first visible minute. Non-baked tiers and
  // degraded paths resolve through renderSkyMesh/dome-warm as before.
  if (bakedActive()) await whenBakeReady();
  resolveSkyWarm();
}

async function buildSky(a, world, wantAudio) {
  {
    // tear down a previous world's sky before building another
    try { skyApi?.dispose?.(); } catch { /* upstream has none; the diff below is the real teardown */ }
    teardownSky();
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
    await primeFor(world, wantAudio);
    await loadEidoModule('sky_worlds.js');
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
    for (const o of skyOwned) {
      // P_AMBIENT: dome warmth never queues ahead of the ground/models a
      // person is actually waiting for (the 16s-boot lesson, warmqueue.js)
      await warm(`sky warm ${(o.name || o.type || 'dome').slice(0, 24)}`, async () => {
        scene.remove(o);
        try { await renderer.compileAsync(o, camera, scene).catch(() => {}); }
        finally { scene.add(o); }
      }, { p: P_AMBIENT });
    }
    // resolveSkyWarm moved to renderEidoverse (§19a): the gate now waits
    // for the first BAKE too, not just the dome warms
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
  // Environment reflections. `scene.environment` was never set, so every PBR
  // material in the world was lit by a hemisphere and a directional only —
  // metals and glossy surfaces read as dead plastic. The sky can bake itself.
  // (sky_worlds' bakeEnv takes ONE options bag — the old `(renderer, {})`
  // call was spreading the renderer into the options and working by luck.)
  // On baked tiers this same bake IS the visible sky, so it renders at the
  // tier's display resolution and full march quality.
  try {
    await skyApi.bakeEnv?.(bakeOpts());
    lastBakeHours = nowHours();
    lastBakeAt = performance.now();
    skyApi.enableReflections?.({});
    // the engine just pointed scene.environment at ITS target — copy the
    // content into the persistent texture and put it back (see module top)
    adoptEnvironment();
  } catch (e) { console.warn('sky reflections unavailable', e); }
  if (BAKED_TIERS[cloudQuality]) {
    const { cloudPasses, intervalMs } = BAKED_TIERS[cloudQuality];
    if (!attachBakedDome(skyApi, { cloudPasses, intervalMs })) {
      // engine internals moved (or the bake failed) — the live march is
      // still in the scene, so the sky stays correct, just expensive
      console.warn('[sky] baked dome could not attach — staying on the live cloud march');
    }
  }
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
  lastBakeAt = performance.now();
  lastBakeHours = nowHours();
  try {
    // Same opts every time — bakeEnv caches its node graph keyed on them.
    await skyApi.bakeEnv(bakeOpts());
    // live tier: the engine rebaked into its own target — re-point (engine
    // reassigns) then re-adopt, so the persistent env picks up the new light
    skyApi.enableReflections?.({});
    adoptEnvironment();
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
  // the debounced TOD bake only serves the live 'high' tier's env-IBL.
  if (!bakedActive()) scheduleEnvBake();
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
    hemi.intensity = (0.6 + 0.4 * day) * (a.ambient ?? 1);

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
