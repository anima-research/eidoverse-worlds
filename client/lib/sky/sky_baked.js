// sky_baked — the volumetric clouds as a texture instead of a per-pixel march.
//
// The cloud dome's picture is a function of view direction alone, so re-marching it every frame buys no parallax.
// The sky engine's bakeEnv() renders it into an equirect target; this module shows the bake on a static dome and
// keeps it alive: two targets cross-dissolved so clouds evolve instead of stepping, bakes drawn as cost-weighted
// horizontal bands (one per frame) so a 4096x2048 bake is affordable, and the freshest bake blitted into
// scene.environment so IBL agrees with the visible sky. The live march stays the 'high' tier
// (docs/research/sky-quality-and-vr.md).
//
// Coupling: this reaches through skyApi._internals for `sys.domes`, `sys._envTarget` and `sys._envBake`
// {scene, camera}. If the engine moves any of them, attach() returns false and sky.js stays on the live march.

import { THREE, TSL, scene, camera, renderer } from '../core.js';
import { tee, bus, CONFIG } from '../base.js';
import { warm, P_AMBIENT } from '../render/warmqueue.js';
import { bandCuts } from './sky_bands.js';
import { ask, spent, turn } from '../render/framebudget.js';

let dome = null;
let mat = null;
let parked = null;     // the live domes we pulled out of the scene graph
let xrHeld = null;     // [dome, parent] pairs held out of the scene in a headset until a baked dome takes over

/** Hold the live domes (the full per-eye cloud march) out of the scene until the baked dome attaches; the sky meanwhile
 *  is the atmosphere without clouds. Idempotent. */
export function holdLiveDomes(skyApi, why = 'in a headset until the baked dome is ready') {
  if (dome || xrHeld) return false;
  const s = skyApi?._internals?.sky;
  const live = (s?.domes ?? []).filter((d) => d?.parent);
  if (!live.length) return false;
  xrHeld = live.map((d) => [d, d.parent]);
  for (const [d, p] of xrHeld) p.remove(d);
  tee(`[sky] ${xrHeld.length} live sky dome(s) held out ${why}`);
  return true;
}
/** Put held domes back (the baked dome is attaching, the sky is being torn down, or the session ended). */
export function releaseLiveDomes() {
  if (!xrHeld) return;
  for (const [d, p] of xrHeld) if (!d.parent) p.add(d);
  xrHeld = null;
}
export const liveDomesHeld = () => !!xrHeld;
/** Teardown: hand back the held domes without re-adding them (held from birth they may be uncompiled). */
export function takeHeldDomes() { const out = (xrHeld ?? []).map(([d]) => d); xrHeld = null; return out; }
export const holdLiveDomesInXR = (skyApi) => holdLiveDomes(skyApi);   // probe name
let sys = null;        // sky engine internals
let targets = null;    // [A, B] — A is the engine's _envTarget, B is ours
let blendU = null;     // 0 → targets[0] on the dome, 1 → targets[1]
let front = 0;         // index the blend currently rests on
let bakeGen = 0;       // bumped at teardown: a band loop or refresh from an older sky stops instead of drawing into freed targets
export const bakeGeneration = () => bakeGen;
let bandScene = null;
let bandMeshes = null;
let bandGeos = null;
let bakeCam = null;
let pinnedCloudsOn = null;   // whether the pinned bake graph has a cloud branch
/** Whether the pinned bake graph has a cloud branch (nothing in client/ reads it; sky.js's fence respells 'clear'
 *  eagerly on cloud-capable tiers, so the cloud graph pins at the boot bake). */
export const bakedCloudsPinned = () => pinnedCloudsOn === true;

// sky.js waits on this before lifting the arrival gate, except at a fresh boot with the live domes held (the interim
// sky lifts it first); single-shot
let _bakeReadyResolve = null;
const _bakeReady = new Promise((r) => { _bakeReadyResolve = r; });
export const whenBakeReady = () => _bakeReady;
function resolveBakeReady() { _bakeReadyResolve?.(); _bakeReadyResolve = null; }
// scene.environment is a dedicated small target each fresh bake is blitted into (PMREM from the full bake stalled).
// Persistent, never replaced: a different texture object on scene.environment recompiles every PBR material.
let envRT = null;
let blitScene = null;
let blitTexNode = null;
let blitGeo = null;
let blitMat = null;
let blitCam = null;    // own ortho cam, identical to the engine's bake cam, so the rig works before any sky exists

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

/** The persistent environment texture: assign it to scene.environment at boot and never assign anything else. */
export function envTexture() {
  ensureEnvRig();
  return envRT.texture;
}

/** If anything assigned a different texture to scene.environment, blit its content into the persistent target and put
 *  the persistent texture back, so the material graphs never see the object change. Idempotent. */
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
let lastCycleMs = 0;   // how long the last bake cycle took (bands + pump spacing)
let refreshing = false;
export const bakedRefreshing = () => refreshing;
// Drift (?skydrift=1, off by default since the bake is one picture and the stars would drift with the clouds): between
// bakes each view ray is carried to the cloud layer and shifted by wind × (sky time since that texture was baked), so
// the next bake lands where the drifted picture already is. Fades out toward the horizon and around the sun.
const DRIFT = CONFIG.params.get('skydrift') === '1';
let sysRef = null, cycleSkyT = 0, cycleSnap = null;
const bakeSkyT = [0, 0];               // sky time each target's picture shows
let driftDt = null;                    // [uniform, uniform]: dt for A and B
const skyTimeNow = () => sysRef?.uniforms?.time?.value ?? 0;
// One sky moment per bake: strips drawn at different sky times showed as seams, so a bake snapshots the sky's scalar
// and vector uniforms when it begins and draws every strip with them, restoring the live values after each draw.
function skySnapshot(sys) {
  const U = sys?.uniforms; if (!U) return null;
  const snap = [];
  for (const [k, u] of Object.entries(U)) {
    const v = u?.value;
    if (typeof v === 'number' || typeof v === 'boolean') snap.push([u, v, false]);
    else if (v && (v.isVector2 || v.isVector3 || v.isVector4 || v.isColor || v.isQuaternion)) snap.push([u, v.clone(), true]);
  }
  return snap;
}
function atSkySnapshot(snap, draw) {
  if (!snap) return draw();
  const keep = snap.map(([u, , obj]) => (obj ? u.value.clone() : u.value));
  for (const [u, v, obj] of snap) { if (obj) u.value.copy(v); else u.value = v; }
  try { return draw(); } finally { snap.forEach(([u, , obj], i) => { if (obj) u.value.copy(keep[i]); else u.value = keep[i]; }); }
}
/** A bake option (a symbol, so the engine never reads it) carrying `() => restore`, installed inside the bake lock right
 *  before that bake runs (sky_bakelock.js), so a renderAsync interceptor can't catch another bake. */
export const BAKE_INTERCEPT = Symbol.for('ew.bakeIntercept');
let bootBakeSkyT = null;   // the time the last banded boot/swap bake was pinned to (attach adopts it for target A)
// the re-bake interval, never shorter than a bake takes plus room to dissolve
const cadenceMs = () => Math.max(cfg.intervalMs, lastCycleMs > 0 ? lastCycleMs + 2500 : 0);
let pendingForce = false;

let cfg = {
  intervalMs: 9000,        // cycle start → next cycle start
  forcedFadeMs: 2500,      // verb-driven changes ease in faster
  passTexelBudget: 0.4e6,  // band size in texels × march passes per frame, the unit the GPU cost roughly follows
  cloudPasses: 8,
};


export { bandCuts } from './sky_bands.js';   // pure maths, its own module so a unit test can load it

/** Render `fn` between XR frames with the pump's discipline (xrPumpTick): xr.enabled off, the stale eye contexts nulled.
 *  Awaits a macrotask first, so a caller woken from a frame callback is out of the frame before it renders. */
async function renderBetweenXRFrames(r, fn) {
  await new Promise((res) => setTimeout(res, 0));
  const xrWas = r.xr.enabled;
  r.xr.enabled = false;
  if (r.backend) r.backend._currentContext = null;
  r._currentRenderContext = null;
  try { return fn(); } finally { r.xr.enabled = xrWas; }
}

/** The boot bake as bands: one full-screen multi-pass draw is past what a GPU watchdog tolerates. Renders the bake
 *  scene's quad into `target` as cost-weighted strips, one per frame, with the same material and global uvs. The band
 *  pipeline is compiled off the render path first. Returns the band count. */
export async function bandedBakeRender(r, bakeScene, bakeCam, target, { cloudPasses = cfg.cloudPasses, passTexelBudget = cfg.passTexelBudget,
  nextFrame = () => new Promise((res) => requestAnimationFrame(res)), budget = false, alive = () => true, sys = null } = {}) {
  const bakeMat = bakeScene.children?.[0]?.material;
  if (!bakeMat) throw new Error('bandedBakeRender: bake scene has no quad');
  const cuts = bandCuts(target.width, target.height, cloudPasses, passTexelBudget);
  const bs = new THREE.Scene();
  const meshes = [], geos = [];
  for (let i = 0; i < cuts.length - 1; i++) {
    const v0 = cuts[i], v1 = cuts[i + 1];
    if (v1 - v0 < 1e-6) continue;
    const g = new THREE.PlaneGeometry(2, (v1 - v0) * 2);   // same construction as attachBakedDome's bands
    g.translate(0, -1 + (v0 + v1), 0);
    const uv = g.attributes.uv;
    for (let j = 0; j < uv.count; j++) uv.setY(j, v0 + uv.getY(j) * (v1 - v0));
    const m = new THREE.Mesh(g, bakeMat);
    m.frustumCulled = false;
    bs.add(m); meshes.push(m); geos.push(g);
  }
  try {
    { const prev = r.getRenderTarget(); r.setRenderTarget(target);
      const tc = performance.now();
      // the target is read when compileAsync is called: unbind it before the (long) await
      let compiling;
      try { compiling = r.compileAsync(bs, bakeCam); } finally { r.setRenderTarget(prev ?? null); }
      await compiling.catch((e) => tee(`[sky] band bake: compileAsync rejected: ${e?.message ?? e}`));
      // and linked: a giant program syncgate.js deferred may still be linking, and drawing now would leave the dome black
      const tl = performance.now();
      await globalThis.__syncGate?.whenGiantLinked?.();
      const waited = performance.now() - tl;
      tee(`[sky] band bake: compiled in ${(performance.now() - tc).toFixed(0)} ms${waited > 50 ? ` (waited ${waited.toFixed(0)} ms for a deferred link)` : ''}, ${meshes.length} bands to draw`); }
    const pinSnap = skySnapshot(sys), pinT = sys?.uniforms?.time?.value ?? null;   // every strip at the moment the drawing began
    bootBakeSkyT = pinT;
    for (let i = 0; i < meshes.length; i++) {
      // each band is a gpu unit of the shared per-frame budget (framebudget.js); nothing is bound across the wait
      const g = budget ? await turn('sky', { gpu: true }) : null;
      if (!alive()) throw new Error('bake cancelled: the sky was torn down mid-bake');   // finally frees the strips
      const draw = () => {
        if (!alive()) throw new Error('bake cancelled: the sky was torn down mid-bake');   // again: a macrotask may have passed
        for (let j = 0; j < meshes.length; j++) meshes[j].visible = j === i;
        const prev = r.getRenderTarget(), autoClear = r.autoClear;
        r.autoClear = false;          // strips abut and each fully overdraws its own texels
        r.setRenderTarget(target);
        const t0 = performance.now();
        try { atSkySnapshot(pinSnap, () => r.render(bs, bakeCam)); } finally { r.setRenderTarget(prev ?? null); r.autoClear = autoClear; }
        if (g) spent('sky', performance.now() - t0, null, g);
      };
      // a bake that runs into a headset session must not render inside an XR frame (xrPumpTick)
      if (r.xr?.isPresenting) await renderBetweenXRFrames(r, draw); else draw();
      if (i === 0 || i % 40 === 39) tee(`[sky] band bake: band ${i + 1}/${meshes.length} drawn`);
      if (i < meshes.length - 1) await nextFrame();
    }
  } finally { for (const g of geos) g.dispose(); }
  return meshes.length;
}

export const bakedActive = () => Boolean(dome);
/** The baked dome mesh while attached (it draws unfogged: hidden under the world's water — sky.js hideSkyForWater). */
export const bakedDomeObject = () => dome;

/** Swap the live march domes for the crossfading baked dome. Call after the first full bakeEnv has rendered the target. */
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

  // park the domes out of the scene graph rather than flipping .visible: sky.update() re-asserts cloudDome.visible
  releaseLiveDomes();   // held in a headset: back in, so the park below takes them
  parked = s.domes.filter((d) => d?.parent);
  for (const d of parked) d.parent.remove(d);

  // the back buffer, same spec as the engine's _envTarget
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
  // binding a never-rendered target texture at pipeline compile races texture init on the WebGPU backend: clear B once
  {
    const prev = renderer.getRenderTarget();
    renderer.setRenderTarget(B);
    renderer.render(new THREE.Scene(), bake.camera);
    renderer.setRenderTarget(prev ?? null);
  }

  // band strips over the engine's cached bake material: a fullscreen quad split into horizontal slices with global
  // uvs, one slice per frame, cost-weighted so every band costs about the same (sky_bands.js)
  const cuts = bandCuts(A.width, A.height, cfg.cloudPasses, cfg.passTexelBudget);
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
  // bakeEnv keys its cached graph on whether clouds existed at bake time (a 'clear' graph has no cloud branch);
  // remember which we pinned so a clear→cloudy flip can rebuild it (maybeRefreshGraph)
  pinnedCloudsOn = /\|c1$/.test(bake.key ?? '');

  ensureEnvRig();
  blitEnvFrom(A);                          // boot bake → env, before its full-size PMREM ever runs

  // one dome where two were: the bake already composites clouds over the atmosphere
  const radius = (s.domes[0]?.geometry?.parameters?.radius ?? 15000) * 0.99;
  mat = new THREE.MeshBasicNodeMaterial({ side: THREE.BackSide, depthWrite: false, fog: false });
  mat.toneMapped = true;   // linear HDR in the targets; tone-map with the frame like the live domes
  // a vertex of a centred sphere is its own view direction, and the bake's uv→dir is the inverse of three's equirectUV()
  blendU = TSL.uniform(0);
  const dirL = TSL.normalize(TSL.positionLocal);
  const U = s.uniforms ?? {};
  sysRef = s;
  let suvA, suvB;
  if (DRIFT && !cfg.noClouds && U.skyWind && U.time && U.sunDir && U.cloudStart && U.cloudHeight) {
    bakeSkyT[0] = bakeSkyT[1] = bootBakeSkyT ?? skyTimeNow();   // A holds the boot bake; B starts as its copy
    driftDt = [TSL.uniform(0), TSL.uniform(0)];
    const layerH = U.cloudStart.add(U.cloudHeight.mul(0.5)).sub(2);   // the bake's eye sits at y=2
    const sunKeep = TSL.smoothstep(Math.cos(14 * Math.PI / 180), Math.cos(6 * Math.PI / 180), TSL.dot(dirL, TSL.normalize(U.sunDir)));
    const w = TSL.smoothstep(0.03, 0.15, dirL.y).mul(TSL.float(1).sub(sunKeep));
    const shifted = (dt) => {
      const hit = dirL.mul(layerH.div(TSL.max(dirL.y, 0.03)));
      // capped at ~12 % of the layer height: a stale picture under a storm wind would pull near-horizon texels overhead
      const d =TSL.vec3(U.skyWind.x.mul(dt), 0, U.skyWind.z.mul(dt));
      const cap = layerH.mul(0.12);
      const moved = hit.add(d.mul(TSL.min(1, cap.div(TSL.max(TSL.length(d), 1e-3)))));
      return TSL.equirectUV(TSL.normalize(TSL.mix(dirL, TSL.normalize(moved), w)));
    };
    suvA = shifted(driftDt[0]); suvB = shifted(driftDt[1]);
    tee('[sky] drift on: the baked clouds follow the wind between bakes, the sun stays put');
  } else { suvA = suvB = TSL.equirectUV(dirL); }
  mat.colorNode = TSL.mix(
    TSL.texture(A.texture, suvA),
    TSL.texture(B.texture, suvB),
    blendU,
  ).rgb;

  dome = new THREE.Mesh(new THREE.SphereGeometry(radius, 48, 24), mat);
  // after the world's opaques (depth-rejects covered pixels instead of shading a whole eye pair), before overlays (>= 1)
  dome.renderOrder = 0.5;
  dome.userData.odTag = 'sky';   // overdraw.js category
  dome.frustumCulled = false;
  dome.userData.noSupportCheck = true;
  dome.userData.noCamCollide = true;
  dome.userData.noWet = true;
  scene.add(dome);

  front = 0;
  // the band context is a different pipeline from the boot bake's; hold in 'warming' until it exists, or the first
  // band pays a blocking compile inside one frame
  state = 'warming';
  warmBakePipeline().then(() => {
    if (state === 'warming') state = 'idle';
    resolveBakeReady();          // the boot gate may lift now
  });
  pendingForce = false;
  nextAt = performance.now() + cfg.intervalMs;
  console.log(`[sky] baked dome crossfade loop — ${A.width}x${A.height}, `
    + `${bandMeshes.length} bands/cycle, ${(cfg.intervalMs / 1000).toFixed(1)}s cadence`);
  return true;
}

/** Compile the band pipeline off the render path with renderBand's scene, camera and target, so the real band render
 *  is a cache hit. All bands share one material and geometry layout, so band 0 covers every strip. */
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

/** Ask for a fresh bake soon (a verb changed the sky's look); a playing dissolve is shortened. */
export function requestBake() {
  if (!dome) return;
  pendingForce = true;
  if (state === 'fading' && fade) {
    const now = performance.now();
    fade.dur = Math.min(fade.dur, (now - fade.t0) + 700);
  }
}

// ── XR: bakes move off the presented frame ──────────────────────────────
// A secondary renderer.render() inside an XR animation frame corrupts the per-eye render list (the world strobes), so
// while presenting, band renders and env blits run from a setTimeout pump between XR frames, one band per
// XR_BAKE_SPACING_MS. Fades stay per-frame. If the pump ever throws, baking freezes for the session and says so once.
const XR_BAKE_SPACING_MS = 40;
let skyWaited = 0;   // band asks age like any waiter (the pump asks last in a frame; it must not starve)
let xrPumpId = 0;
let xrBakeBroken = false;
// 'frozen for this session' means THIS session: a new one gets the pump back (a lasting fault latches again at once)
bus.on('xr:state', (on) => { if (on) xrBakeBroken = false; });

function xrPumpDue() {
  return state === 'baking'
    || (state === 'idle' && (pendingForce || performance.now() >= nextAt));
}

function scheduleXrPump() {
  if (xrPumpId || xrBakeBroken || !xrPumpDue()) return;
  xrPumpId = setTimeout(xrPumpTick, XR_BAKE_SPACING_MS);
}

function xrPumpTick() {
  xrPumpId = 0;
  if (!dome || xrBakeBroken) return;
  if (!renderer.xr?.isPresenting) return;   // session ended: frame path resumes
  const now = performance.now();
  // between frames the renderer must not route through XR state: xr.enabled off around the bake
  const xrWas = renderer.xr.enabled;
  renderer.xr.enabled = false;
  // Three-internals surgery (re-check at every three bump): between XR frames backend._currentContext still points at
  // the last frame's context, and finishRender would restore a framebuffer that no longer exists. Null the pointers
  // and do not restore them (null is the truth between frames). The catch's freeze-latch is the backstop.
  const bk = renderer.backend;
  if (bk) bk._currentContext = null;
  renderer._currentRenderContext = null;
  try {
    if (state === 'idle' && (pendingForce || now >= nextAt)) {
      if (!maybeRefreshGraph()) {
        cycleForced = pendingForce;
        pendingForce = false;
        cycleStart = now; cycleSkyT = skyTimeNow(); cycleSnap = skySnapshot(sysRef);
        nextAt = now + cadenceMs();
        bandIdx = 0;
        state = 'baking';
      }
    } else if (state === 'baking') {
      const g = ask('sky', { gpu: true, waited: skyWaited });
      if (!g) skyWaited++;
      else {
        skyWaited = 0;
        const t0 = performance.now();
        renderBand(bandIdx);                // one band per tick, off-frame
        spent('sky', performance.now() - t0, null, g);
        bandIdx += 1;
        if (bandIdx >= bandMeshes.length) finishBake(now);
      }
    }
  } catch (e) {
    xrBakeBroken = true;
    console.error('[sky] XR off-frame bake failed — sky frozen for this '
      + 'session (please report):', e?.message ?? e,
      '\nSTACK:', String(e?.stack ?? '').slice(0, 600));
    return;
  } finally {
    renderer.xr.enabled = xrWas;
  }
  scheduleXrPump();
}

/** Per frame from updateSky(): follow the camera (x/z only, like the live domes), advance the bake/fade cycle. */
const _domeEye = new THREE.Vector3();
export function updateBakedDome(now = performance.now()) {
  if (!dome) return;
  camera.getWorldPosition(_domeEye);   // world position: in XR camera.position is rig-local

  dome.position.set(_domeEye.x, 0, _domeEye.z);
  if (driftDt) { const t = skyTimeNow(); driftDt[0].value = t - bakeSkyT[0]; driftDt[1].value = t - bakeSkyT[1]; }

  const presenting = Boolean(renderer.xr?.isPresenting);
  if (presenting) scheduleXrPump();        // renders happen between XR frames
  if (state === 'baking') {
    if (presenting) return;                // the pump owns this state in XR
    const g = ask('sky', { gpu: true, waited: skyWaited });   // a band is a gpu unit: at most one per frame, in the shared budget
    if (!g) { skyWaited++; return; }
    skyWaited = 0;
    const t0 = performance.now();
    renderBand(bandIdx);
    spent('sky', performance.now() - t0, null, g);
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
  if (presenting) return;              // idle→baking is the pump's too
  if (pendingForce || now >= nextAt) {
    if (maybeRefreshGraph()) return;   // clear↔cloudy flip: rebuild first
    cycleForced = pendingForce;
    pendingForce = false;
    cycleStart = now; cycleSkyT = skyTimeNow(); cycleSnap = skySnapshot(sysRef);
    nextAt = now + cadenceMs();
    bandIdx = 0;
    state = 'baking';
  }
}

// A weather/cloud verb can move the preset across the clear→cloudy line, and a 'clear' graph has no cloud branch:
// rebuild through the engine's own bakeEnv and re-pin its fresh material.
let refreshHeldLogged = false;
let refreshStats = { held: 0, bands: null };
/** Harness seam: force the clear→cloudy graph refresh on the next cycle (normally unreachable: sky.js pins the cloud
 *  graph at boot) and read what it did. ??= so a probe's second import of this module keeps the live one's seam. */
globalThis.__skyRefresh ??= {
  force: () => { pinnedCloudsOn = false; refreshStats = { held: 0, bands: null }; requestBake(); },
  stats: () => ({ ...refreshStats, state, pinnedCloudsOn, pendingForce, xrBakeBroken, dome: !!dome, presenting: !!renderer.xr?.isPresenting }),
};
/** A frame to wait for between bake strips that never lands inside a headset session (xrPumpTick). */
const nextDesktopFrame = () => new Promise(function wait(res) {
  requestAnimationFrame(() => (renderer.xr?.isPresenting ? setTimeout(() => wait(res), 250) : res()));
});
function maybeRefreshGraph() {
  const wantClouds = !cfg.noClouds && sys.state?.preset !== 'clear';   // the off tier never grows a cloud branch
  if (wantClouds === pinnedCloudsOn) return false;
  // one direction only: a cloud graph with finalMul→0 draws a correct clear sky, so only clear→cloudy needs the rebuild
  if (!wantClouds) return false;
  // never inside a headset: the rebuild can hold an XR frame long enough to trip the GPU watchdog
  if (renderer.xr?.isPresenting) {
    refreshStats.held++;
    if (!refreshHeldLogged) { refreshHeldLogged = true; tee('[sky] clear→cloudy graph refresh held until VR exit'); }
    return false;
  }
  refreshHeldLogged = false;
  state = 'refreshing';
  refreshing = true; bus.emit('sky-refreshing', true);   // the sky panel's 'loading…' (sky.js folds it into 'sky-busy')
  const A = targets[0];
  const gen = bakeGen, alive = () => gen === bakeGen;
  // bakeEnv's single full-quad renderAsync becomes cost-weighted strips, as at boot
  let origRA = renderer.renderAsync;
  let outer = renderer.getRenderTarget();
  const interceptor = function (sc, cam) {
    if (sc !== sys?._envBake?.scene) return origRA.call(this, sc, cam);
    renderer.renderAsync = origRA;
    const target = renderer.getRenderTarget();
    renderer.setRenderTarget(outer ?? null);
    const t0 = performance.now();
    return bandedBakeRender(renderer, sc, cam, target, { cloudPasses: cfg.cloudPasses, passTexelBudget: cfg.passTexelBudget, nextFrame: nextDesktopFrame, budget: true, alive, sys })
      .then((n) => { const ti = targets?.indexOf?.(target) ?? -1; if (ti >= 0 && bootBakeSkyT != null) bakeSkyT[ti] = bootBakeSkyT; refreshStats.bands = n; tee(`[sky] graph refresh baked in ${n} bands over ${(performance.now() - t0).toFixed(0)} ms`); renderer.setRenderTarget(target); });
  };
  const install = () => { origRA = renderer.renderAsync; outer = renderer.getRenderTarget(); renderer.renderAsync = interceptor;
    return () => { if (renderer.renderAsync === interceptor) renderer.renderAsync = origRA; }; };
  Promise.resolve(sys.bakeEnv(renderer, {
    width: A.width, height: A.height, cloudPasses: cfg.cloudPasses, [BAKE_INTERCEPT]: install,
  })).then(() => {
    if (!alive()) return;             // torn down meanwhile
    const bake = sys._envBake;
    const bakeMat = bake?.scene?.children?.[0]?.material;
    if (!bakeMat) throw new Error('bake graph missing after refresh');
    for (const m of bandMeshes) m.material = bakeMat;
    bakeCam = bake.camera;
    pinnedCloudsOn = /\|c1$/.test(bake.key ?? '');
    // the full bake landed in A: show it, take the env from it, and resume the cadence once the band pipeline warms
    blitEnvFrom(A);
    blendU.value = 0;
    front = 0;
    fade = null;
    nextAt = performance.now() + cfg.intervalMs;
    state = 'warming';
    return warmBakePipeline().then(() => { if (state === 'warming') state = 'idle'; });
  }).catch((e) => {
    if (!alive()) return;
    console.warn('[sky] bake graph refresh failed', e?.message ?? e);
    pinnedCloudsOn = wantClouds;   // stop retrying every cycle
    state = 'idle';
  }).finally(() => { refreshing = false; bus.emit('sky-refreshing', false); });
  return true;
}

// downsample a fresh bake into the small env target and keep it installed
function blitEnvFrom(target) {
  blitTexNode.value = target.texture;
  const prev = renderer.getRenderTarget();
  renderer.setRenderTarget(envRT);
  renderer.render(blitScene, blitCam);
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
  // a throw inside the band render must not leave the back target bound or autoClear off for the main pass
  try { atSkySnapshot(cycleSnap, () => renderer.render(bandScene, bakeCam)); }
  catch (e) { tee(`[sky] dome band ${i}/${bandMeshes.length} render threw: ${String(e?.message ?? e).slice(0, 300)}`); throw e; }
  finally { renderer.setRenderTarget(prev ?? null); renderer.autoClear = autoClear; }
}

function finishBake(now) {
  lastCycleMs = now - cycleStart;
  const back = targets[1 - front];
  bakeSkyT[1 - front] = cycleSkyT;   // every strip was drawn at this time
  blitEnvFrom(back);   // IBL + reflection fallback follow the freshest bake

  // dissolve toward the fresh bake across the rest of the interval; verb-driven bakes land faster
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

/** Restore the live domes (so sky.js's disposal pass can find them) and drop everything of ours. Safe when inactive. */
export function detachBakedDome() {
  bakeGen++;
  releaseLiveDomes();
  if (parked) {
    for (const d of parked) scene.add(d);
    parked = null;
  }
  if (dome) {
    scene.remove(dome);
    dome.geometry.dispose();
    mat.dispose();
    dome = null; driftDt = null; sysRef = null; bootBakeSkyT = null;
    mat = null;
  }
  if (bandGeos) {
    for (const g of bandGeos) g.dispose();   // the material is the engine's — leave it
    bandGeos = null;
    bandMeshes = null;
    bandScene = null;
  }
  if (envRT) {
    // the persistent env target survives teardown; refill it from the engine's own target so a live-tier sky keeps
    // correct reflections
    if (targets) {
      blitTexNode.value = targets[0].texture;
      const prev = renderer.getRenderTarget();
      renderer.setRenderTarget(envRT);
      renderer.render(blitScene, blitCam);
      renderer.setRenderTarget(prev ?? null);
      envRT.texture.needsPMREMUpdate = true;
      if (sys?._envFbNode) sys._envFbNode.value = targets[0].texture;
    }
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
