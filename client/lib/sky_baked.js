// baked sky — the volumetric clouds as a texture instead of a per-pixel march.
//
// The cloud dome's raymarch re-shades every screen pixel every frame, but the
// sky it draws is a function of VIEW DIRECTION alone: the domes are
// camera-centred and the cloud shell is hundreds of metres up, so walking
// around a world produces no parallax a person can see. Re-marching a
// direction-only signal 60 times a second is where the frame budget went —
// measured here at ~120fps without clouds vs ~30 with.
//
// sky_system already knows how to render that signal into an equirect
// RenderTarget by explicit per-texel direction — bakeEnv(). This module shows
// that bake on a static dome and keeps it ALIVE:
//
//   - TWO targets, front and back. The dome cross-dissolves between them, so
//     the sky is always easing toward a bake a few seconds newer — clouds
//     keep their slow evolution (forming, growing, drifting) instead of
//     teleporting on every re-bake. v1 swapped one texture in place and the
//     cloud field's natural nucleate-and-grow read as stepwise jumps.
//   - Bakes are BANDED: the engine's cached bake material is re-rendered a
//     horizontal strip per frame (~2ms each) instead of one blocking
//     full-quad pass, which is what makes a 4096x2048 bake affordable — v1's
//     2048 was ~4x undersampled against the screen and read as mush.
//   - The freshest bake keeps feeding scene.environment and the reflection
//     hook's fallback, so IBL agrees with the visible sky.
//
// Still traded away, deliberately: per-frame lightning illumination INSIDE
// the clouds (bolts and the scene flash stay live; bakeEnv refuses to bake a
// lightning pulse), and the fine per-pixel shimmer of the true march. The
// live march remains the 'high' cloud-quality tier.
//
// Coupling note: this reaches through skyApi._internals (sky_worlds'
// declared engine-work escape hatch) for `sys.domes`, `sys._envTarget` and
// the cached `sys._envBake` {scene, camera}. If a toolkit update moves any
// of them, attach() returns false and sky.js stays on the live march —
// degraded performance, never a broken sky.

import { THREE, TSL, scene, camera, renderer } from './core.js';
import { warm, P_AMBIENT } from './warmqueue.js';

let dome = null;
let mat = null;
let parked = null;     // the live domes we pulled out of the scene graph
let sys = null;        // sky_system internals
let targets = null;    // [A, B] — A is the engine's _envTarget, B is ours
let blendU = null;     // 0 → targets[0] on the dome, 1 → targets[1]
let front = 0;         // index the blend currently rests on
let bandScene = null;
let bandMeshes = null;
let bandGeos = null;
let bakeCam = null;
let pinnedCloudsOn = null;   // whether the pinned bake graph HAS a cloud branch
/** The §18b fence in sky.js consults this: 'clear' is respelled as an empty
 *  cumulus ONLY once a cloud-carrying graph is pinned — an eager respell
 *  would build the ~1.5MB-WGSL cloud graph at boot for clear worlds, and
 *  even an ASYNC compile of that monster stalls the whole GPU process ~9s
 *  (measured — Chrome serializes queue submits behind Tint). Lazy pinning
 *  means a session pays that compile at most ONCE, at the user's own first
 *  cloudy change, instead of every clear↔cloudy flip (the old behavior) or
 *  at every clear-world boot (the eager fence). */
export const bakedCloudsPinned = () => pinnedCloudsOn === true;

// §19a: arrival gates on the FIRST bake's band pipeline being warm (the
// boot pays the one big cloud-graph compile behind the splash — tel0s's
// call). Single-shot; only meaningful on baked tiers (sky.js guards).
let _bakeReadyResolve = null;
const _bakeReady = new Promise((r) => { _bakeReadyResolve = r; });
export const whenBakeReady = () => _bakeReady;
function resolveBakeReady() { _bakeReadyResolve?.(); _bakeReadyResolve = null; }
// scene.environment stays a dedicated small target (what IBL was sized for
// all along) — PMREM from the full 4096 display bake was a ~150ms stall
// every cycle. Each fresh bake is blitted down into this instead.
//
// PERSISTENT, module-lifetime, never disposed, never replaced: assigning a
// DIFFERENT texture object to scene.environment regrows the lighting branch
// of every PBR material in the world — the whole-scene recompile behind the
// post-splash freezes (measured 08-02). The world boots with this target
// already assigned (black — contributes nothing) and every bake, engine
// takeover, and tier switch BLITS INTO it. Content changes; the object never
// does; no material ever recompiles for the environment again.
let envRT = null;
let blitScene = null;
let blitTexNode = null;
let blitGeo = null;
let blitMat = null;
let blitCam = null;    // own ortho cam — identical to the engine's bake cam,
                       // so the rig works before any sky exists

function ensureEnvRig() {
  if (envRT) return;
  envRT = new THREE.RenderTarget(512, 256, {
    type: THREE.HalfFloatType, format: THREE.RGBAFormat,
    depthBuffer: false, stencilBuffer: false,
  });
  envRT.texture.mapping = THREE.EquirectangularReflectionMapping;
  envRT.texture.minFilter = THREE.LinearFilter;
  envRT.texture.magFilter = THREE.LinearFilter;
  envRT.texture.colorSpace = THREE.LinearSRGBColorSpace;
  envRT.texture.name = 'sky_baked_env';
  envRT.texture.userData._pmremPreInit = true;
  blitCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  blitCam.position.z = 0.5;
  blitScene = new THREE.Scene();
  blitGeo = new THREE.PlaneGeometry(2, 2);
  blitMat = new THREE.MeshBasicNodeMaterial();
  blitMat.toneMapped = false;              // environment must stay linear HDR
  blitTexNode = TSL.texture(envRT.texture); // real source set per blit
  blitMat.colorNode = blitTexNode;
  blitScene.add(new THREE.Mesh(blitGeo, blitMat));
}

/** The persistent environment texture — assign this to scene.environment at
 *  boot (black until a sky bakes) and never assign anything else. */
export function envTexture() {
  ensureEnvRig();
  return envRT.texture;
}

/** If anything (the engine's enableReflections, an old code path) assigned a
 *  different texture to scene.environment, copy its content into the
 *  persistent target and put the persistent texture back — the graphs never
 *  see the object change. Idempotent; cheap (one 512x256 quad). */
export function adoptEnvironment() {
  ensureEnvRig();
  const cur = scene.environment;
  if (!cur) { scene.environment = envRT.texture; return; }
  if (cur === envRT.texture) return;
  blitTexNode.value = cur;
  const prev = renderer.getRenderTarget();
  renderer.setRenderTarget(envRT);
  renderer.render(blitScene, blitCam);
  renderer.setRenderTarget(prev ?? null);
  envRT.texture.needsPMREMUpdate = true;
  scene.environment = envRT.texture;
}

// cycle state machine: idle → baking (a band per frame) → fading → idle
// ('refreshing' while a preset flip rebuilds the engine's bake graph)
let state = 'idle';
let bandIdx = 0;
let cycleStart = 0;
let cycleForced = false;
let fade = null;       // { from, to, t0, dur }
let nextAt = 0;
let pendingForce = false;

let cfg = {
  intervalMs: 9000,        // cycle start → next cycle start
  forcedFadeMs: 2500,      // verb-driven changes ease in faster
  // Band size in TEXELS x MARCH PASSES per frame — the unit the GPU cost
  // roughly follows (bands are additionally cost-weighted by march chord
  // length, see attach). A 4096x2048 8-pass bake spreads over ~170 frames
  // (~2.8s of a 9s cycle) at a few ms each.
  passTexelBudget: 0.4e6,
  cloudPasses: 8,
};

export const bakedActive = () => Boolean(dome);

/** Swap the live march domes for the crossfading baked dome.
 *  Call AFTER the first full bakeEnv has rendered the target. */
export function attachBakedDome(skyApi, opts = {}) {
  const s = skyApi?._internals?.sky;
  const A = s?._envTarget;
  const bake = s?._envBake;
  const bakeMat = bake?.scene?.children?.[0]?.material;
  if (!s?.domes?.length || !A?.texture || !bakeMat || !bake.camera) return false;
  detachBakedDome();
  sys = s;
  cfg = { ...cfg, ...opts };
  bakeCam = bake.camera;

  // Park the domes OUT of the scene graph rather than flipping .visible —
  // sky.update() re-asserts cloudDome.visible on every weather/cloud change,
  // so a visibility flag would not stay put. Off-scene meshes cost nothing,
  // and update()'s position/visible writes against them stay harmless.
  parked = s.domes.filter((d) => d?.parent);
  for (const d of parked) d.parent.remove(d);

  // The back buffer — same spec as sky_system's _ensureEnvTarget.
  const B = new THREE.RenderTarget(A.width, A.height, {
    type: THREE.HalfFloatType, format: THREE.RGBAFormat,
    depthBuffer: false, stencilBuffer: false,
  });
  B.texture.mapping = THREE.EquirectangularReflectionMapping;
  B.texture.minFilter = THREE.LinearFilter;
  B.texture.magFilter = THREE.LinearFilter;
  B.texture.colorSpace = THREE.LinearSRGBColorSpace;
  B.texture.name = 'sky_baked_back';
  B.texture.userData._pmremPreInit = true;
  targets = [A, B];
  // Binding a never-rendered RT texture at pipeline compile races texture
  // init on the wgpu backend (sky_system hit intermittent "OutputType is
  // invalid" from exactly this) — clear B once so it exists before the dome
  // material ever samples it.
  {
    const prev = renderer.getRenderTarget();
    renderer.setRenderTarget(B);
    renderer.render(new THREE.Scene(), bake.camera);
    renderer.setRenderTarget(prev ?? null);
  }

  // Band strips over the engine's cached bake material: a fullscreen ortho
  // quad split into horizontal slices with GLOBAL uvs, so rendering one
  // slice per frame (no clear) re-marches just that strip of the equirect.
  //
  // The slices are COST-WEIGHTED, not equal-height: texel cost is dominated
  // by march chord length, which blows up toward the horizon rows (a grazing
  // ray crosses tens of km of cloud shell where a zenith ray crosses ~1km) —
  // uniform slices measured 27-48ms frames at the horizon and ~0ms at the
  // nadir. Weight rows by an inverse-elevation chord estimate and cut slices
  // of equal WEIGHT instead, so every band costs about the same few ms.
  const bands = Math.max(1, Math.ceil((A.width * A.height * cfg.cloudPasses) / cfg.passTexelBudget));
  const ROWS = 256;                       // weighting resolution in v
  const w = [];
  let wSum = 0;
  for (let r = 0; r < ROWS; r++) {
    const v = (r + 0.5) / ROWS;
    const lat = (0.5 - v) * Math.PI;      // the bake's uv→dir convention
    // chord ∝ 1/max(|sin lat|, eps), clamped like the march's fadeDist is;
    // below-horizon rows never march clouds — nearly free
    const chord = lat <= 0 ? 0.05 : Math.min(1 / Math.max(Math.sin(lat), 0.03), 30);
    w.push(0.05 + chord);                 // small floor: bg gradient is never free
    wSum += 0.05 + chord;
  }
  const cuts = [0];                        // band edges in v, equal weight per band
  let acc = 0;
  let nextCut = wSum / bands;
  for (let r = 0; r < ROWS; r++) {
    acc += w[r];
    while (acc >= nextCut - 1e-9 && cuts.length < bands) {
      cuts.push((r + 1) / ROWS);
      nextCut += wSum / bands;
    }
  }
  cuts.push(1);
  bandScene = new THREE.Scene();
  bandMeshes = [];
  bandGeos = [];
  for (let i = 0; i < cuts.length - 1; i++) {
    const v0 = cuts[i];
    const v1 = cuts[i + 1];
    if (v1 - v0 < 1e-6) continue;
    // v runs 0→1 as quad y runs -1→+1 (PlaneGeometry's own uv convention)
    const g = new THREE.PlaneGeometry(2, (v1 - v0) * 2);
    g.translate(0, -1 + (v0 + v1), 0);
    const uv = g.attributes.uv;
    for (let j = 0; j < uv.count; j++) uv.setY(j, v0 + uv.getY(j) * (v1 - v0));
    const m = new THREE.Mesh(g, bakeMat);
    m.visible = false;
    m.frustumCulled = false;
    bandScene.add(m);
    bandMeshes.push(m);
    bandGeos.push(g);
  }
  // bakeEnv keys its cached graph on whether clouds existed at bake time —
  // a graph built under a 'clear' preset has NO cloud branch at all, and no
  // uniform can bring one back. Remember which flavour we pinned so a later
  // clear↔cloudy preset flip can rebuild it (see maybeRefreshGraph).
  pinnedCloudsOn = /\|c1$/.test(bake.key ?? '');

  // The persistent env rig (module-lifetime — see its comment above).
  ensureEnvRig();
  blitEnvFrom(A);                          // boot bake → env, before its 4096 PMREM ever runs

  // One dome where two were: the bake already composites clouds over the
  // atmosphere. (If ringworld ever comes off the KNOWN_HEAVY list its band
  // renders BETWEEN the live domes — this single dome would need splitting.)
  const radius = (s.domes[0]?.geometry?.parameters?.radius ?? 15000) * 0.99;
  mat = new THREE.MeshBasicNodeMaterial({ side: THREE.BackSide, depthWrite: false, fog: false });
  // Linear HDR in the targets; tone-map with the frame like the live domes.
  mat.toneMapped = true;
  // A vertex of a centred sphere IS its own view direction, and the bake's
  // uv→dir mapping is authored as the exact inverse of three's equirectUV()
  // (that is what lets the same texture serve as scene.environment).
  blendU = TSL.uniform(0);
  const suv = TSL.equirectUV(TSL.normalize(TSL.positionLocal));
  mat.colorNode = TSL.mix(
    TSL.texture(A.texture, suv),
    TSL.texture(B.texture, suv),
    blendU,
  ).rgb;

  dome = new THREE.Mesh(new THREE.SphereGeometry(radius, 48, 24), mat);
  dome.renderOrder = -100;             // the bg dome's slot: first, behind everything
  dome.frustumCulled = false;
  dome.userData.noSupportCheck = true;
  dome.userData.noCamCollide = true;
  dome.userData.noWet = true;
  scene.add(dome);

  front = 0;
  // §18b: the pinned graph's WGSL is enormous once it carries clouds (the
  // 8-pass march ≈ 1.5MB of shader text), and the BAND context (bandScene +
  // targets[]) is a different pipeline than the boot bake's own — the first
  // renderBand that met it cold paid NodeBuilder plus a BLOCKING pipeline
  // compile inside one frame (measured 12s on the first cadence cycle). The
  // cycle holds in 'warming' until the band pipeline exists.
  state = 'warming';
  warmBakePipeline().then(() => {
    if (state === 'warming') state = 'idle';
    resolveBakeReady();          // §19a: the boot gate may lift now
  });
  pendingForce = false;
  nextAt = performance.now() + cfg.intervalMs;
  console.log(`[sky] baked dome crossfade loop — ${A.width}x${A.height}, `
    + `${bands} bands/cycle, ${(cfg.intervalMs / 1000).toFixed(1)}s cadence`);
  return true;
}

/** Compile the band material's pipeline off the render path, through the
 *  conductor (§16.2.A): same scene, same camera, same target formats as
 *  renderBand — the real band render is then a pure cache hit. All bands
 *  share one material and one geometry layout, so warming band 0 covers
 *  every strip. */
function warmBakePipeline() {
  const m0 = bandMeshes[0];
  if (!m0) return Promise.resolve();
  return warm('sky bake pipeline', async () => {
    if (!bandMeshes[0] || !bakeCam) return;   // torn down while queued
    const prevRT = renderer.getRenderTarget();
    const saveVis = m0.visible;
    m0.visible = true;
    let compiled;
    try {
      renderer.setRenderTarget(targets[0]);
      compiled = renderer.compileAsync(m0, bakeCam, bandScene);
    } finally {
      renderer.setRenderTarget(prevRT);
      m0.visible = saveVis;
    }
    await (compiled?.catch(() => {}) ?? Promise.resolve());
  }, { p: P_AMBIENT });
}

/** Ask for a fresh bake soon (verb changed the sky's look). If one is
 *  mid-flight it re-runs after; if a dissolve is playing it is shortened so
 *  the new look lands promptly. */
export function requestBake() {
  if (!dome) return;
  pendingForce = true;
  if (state === 'fading' && fade) {
    const now = performance.now();
    fade.dur = Math.min(fade.dur, (now - fade.t0) + 700);
  }
}

/** Per frame from updateSky(): follow the camera, advance the bake/fade
 *  cycle. The camera-follow matches the live domes (x/z only — sky_system
 *  keeps dome centres at ground level). */
export function updateBakedDome(now = performance.now()) {
  if (!dome) return;
  dome.position.set(camera.position.x, 0, camera.position.z);

  if (state === 'baking') {
    renderBand(bandIdx);
    bandIdx += 1;
    if (bandIdx >= bandMeshes.length) finishBake(now);
    return;
  }
  if (state === 'fading') {
    const k = Math.min(1, (now - fade.t0) / fade.dur);
    const e = k < 0.5 ? 2 * k * k : 1 - ((-2 * k + 2) ** 2) / 2;   // easeInOut
    blendU.value = fade.from + (fade.to - fade.from) * e;
    if (k >= 1) {
      front = fade.to;
      fade = null;
      state = 'idle';
    }
    return;
  }
  if (state !== 'idle') return;        // 'refreshing': a graph rebuild is in flight
  if (pendingForce || now >= nextAt) {
    if (maybeRefreshGraph()) return;   // clear↔cloudy flip: rebuild first
    cycleForced = pendingForce;
    pendingForce = false;
    cycleStart = now;
    nextAt = now + cfg.intervalMs;
    bandIdx = 0;
    state = 'baking';
  }
}

// A weather/cloud verb can move the preset across the clear↔cloudy line,
// and the pinned bake graph is the wrong flavour on the far side (a 'clear'
// graph simply has no cloud branch). Rebuild through the engine's own
// bakeEnv — a one-frame full-quad render plus a recompile, acceptable for a
// change this dramatic — and re-pin its fresh material.
function maybeRefreshGraph() {
  const wantClouds = sys.state?.preset !== 'clear';
  if (wantClouds === pinnedCloudsOn) return false;
  // One direction only (§18b): a c1 graph with finalMul→0 draws a correct
  // clear sky, so cloudy→clear NEVER needs the full-quad rebake (the
  // measured ~5s halt). Only c0→c1 is genuinely impossible to render
  // without a rebuild (a graph built with no cloud branch cannot grow
  // one) — and the §18b fence in sky.js keeps capable tiers pinned c1
  // from the first bake, so even that direction is normally unreachable.
  if (!wantClouds) return false;
  state = 'refreshing';
  const A = targets[0];
  Promise.resolve(sys.bakeEnv(renderer, {
    width: A.width, height: A.height, cloudPasses: cfg.cloudPasses,
  })).then(() => {
    const bake = sys._envBake;
    const bakeMat = bake?.scene?.children?.[0]?.material;
    if (!bakeMat) throw new Error('bake graph missing after refresh');
    for (const m of bandMeshes) m.material = bakeMat;
    bakeCam = bake.camera;
    pinnedCloudsOn = /\|c1$/.test(bake.key ?? '');
    // the full bake landed in A — show it, take the env back from it, and
    // let the cadence resume from there. The fresh graph's band pipeline
    // warms first (§18b) — the re-pinned material is as cold in the band
    // context as the boot one was.
    blitEnvFrom(A);
    blendU.value = 0;
    front = 0;
    fade = null;
    nextAt = performance.now() + cfg.intervalMs;
    state = 'warming';
    return warmBakePipeline().then(() => { if (state === 'warming') state = 'idle'; });
  }).catch((e) => {
    console.warn('[sky] bake graph refresh failed', e?.message ?? e);
    pinnedCloudsOn = wantClouds;   // stop retrying every cycle
    state = 'idle';
  });
  return true;
}

// Downsample a fresh bake into the small env target and keep it installed —
// PMREM then reads 512x256 every cycle instead of stalling on the full bake.
function blitEnvFrom(target) {
  blitTexNode.value = target.texture;
  const prev = renderer.getRenderTarget();
  renderer.setRenderTarget(envRT);
  renderer.render(blitScene, blitCam);   // rig cam — identical to the engine's bake cam
  renderer.setRenderTarget(prev ?? null);
  envRT.texture.needsPMREMUpdate = true;
  if (sys._envFbNode) sys._envFbNode.value = envRT.texture;
  const env = scene.environment;
  if (!env || env === envRT.texture
      || env === targets[0].texture || env === targets[1].texture) {
    scene.environment = envRT.texture;
  }
}

function renderBand(i) {
  const back = targets[1 - front];
  for (let j = 0; j < bandMeshes.length; j++) bandMeshes[j].visible = j === i;
  const prev = renderer.getRenderTarget();
  const autoClear = renderer.autoClear;
  renderer.autoClear = false;          // bands accumulate; each strip fully overdraws its own texels
  renderer.setRenderTarget(back);
  renderer.render(bandScene, bakeCam);
  renderer.setRenderTarget(prev ?? null);
  renderer.autoClear = autoClear;
}

function finishBake(now) {
  const back = targets[1 - front];
  blitEnvFrom(back);   // IBL + reflection fallback follow the freshest bake

  // Dissolve toward the fresh bake across the remainder of the interval so
  // the sky reads as continuously evolving, never stepping. Verb-driven
  // bakes land faster.
  fade = {
    from: blendU.value,
    to: 1 - front,
    t0: now,
    dur: cycleForced
      ? cfg.forcedFadeMs
      : Math.max(2500, cfg.intervalMs - (now - cycleStart) - 250),
  };
  state = 'fading';
}

/** Restore the live domes and drop everything of ours. Safe when inactive.
 *  sky.js's teardown diff claimed the real domes at build time, so putting
 *  them back in the scene lets its disposal pass find them again. */
export function detachBakedDome() {
  if (parked) {
    for (const d of parked) scene.add(d);
    parked = null;
  }
  if (dome) {
    scene.remove(dome);
    dome.geometry.dispose();
    mat.dispose();
    dome = null;
    mat = null;
  }
  if (bandGeos) {
    for (const g of bandGeos) g.dispose();   // the material is the engine's — leave it
    bandGeos = null;
    bandMeshes = null;
    bandScene = null;
  }
  if (envRT) {
    // The persistent env target SURVIVES teardown — handing scene.environment
    // a different texture object would recompile every PBR material (the
    // exact storm this rig exists to prevent). Refill it from the engine's
    // own target instead so a live-tier sky keeps correct reflections; the
    // engine's fallback node goes back to its own texture as before.
    if (targets) {
      blitTexNode.value = targets[0].texture;
      const prev = renderer.getRenderTarget();
      renderer.setRenderTarget(envRT);
      renderer.render(blitScene, blitCam);
      renderer.setRenderTarget(prev ?? null);
      envRT.texture.needsPMREMUpdate = true;
      if (sys?._envFbNode) sys._envFbNode.value = targets[0].texture;
    }
    // rig stays alive — it is the world's environment now and forever
  }
  if (targets) {
    targets[1].dispose();                    // A is the engine's _envTarget — leave it
    targets = null;
  }
  sys = null;
  blendU = null;
  fade = null;
  state = 'idle';
  pendingForce = false;
  pinnedCloudsOn = null;
}
