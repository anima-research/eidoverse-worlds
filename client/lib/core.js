// core — the PRESENTATION substrate: renderer, scene, camera, canvas, the base lights and stage floor, and the
// eidoverse module-host contract. The renderer-free substrate (bus, CONFIG, report, colours, helpers) lives in
// base.js (docs/design/RENDERER-SEAM.md), so modules that never touch the GPU import THAT.
//
// Import rule: from the client, core imports base.js (which imports nothing at all) and the render/ and xr/ boot helpers
// it installs (gpulost, backend_choice, syncgate, xr/*), none of which imports core. The module graph
// stays acyclic at load time even where the runtime call graph is circular.

import * as THREE from 'three';
import * as TSL from 'three/tsl';
import { CONFIG, tee, teeNow, bus } from './base.js';
import { installGpuLostRecovery } from './render/gpulost.js';
import { decideBackend } from './render/backend_choice.js';
import { headsetSeenRecently as _headsetSeenRecently, migrateHeadsetSeen as _migrateHeadsetSeen } from './xr/headset_seen.js';
import { guardPixelRatioInXR } from './xr/xrpixelratio.js';
import { separateXRPass } from './xr/xrpass.js';
import { tolerateNullXRFramebuffer } from './xr/xr_nullfb.js';
import { patchShadowNodeForXR } from './xr/xrshadow.js';
import { installSyncGate } from './render/syncgate.js';

export { THREE, TSL };

// ------------------------------------------------------------ wgsl debug
// ?wgsldebug — surface Tint's REAL compilation diagnostics (Chrome only logs
// "invalid due to a previous error" at pipeline time; the substance lives in
// getCompilationInfo on the shader module).
if (CONFIG.params.has('wgsldebug') && globalThis.GPUDevice) {
  const orig = GPUDevice.prototype.createShaderModule;
  GPUDevice.prototype.createShaderModule = function (desc) {
    const mod = orig.call(this, desc);
    mod.getCompilationInfo?.().then((info) => {
      const errs = info.messages.filter((m) => m.type === 'error');
      if (!errs.length) return;
      for (const m of errs.slice(0, 3)) {
        console.error(`[wgsl] ${m.lineNum}:${m.linePos} ${m.message}`);
        const lines = desc.code.split('\n');
        console.error('[wgsl-src]\n' + lines.slice(Math.max(0, m.lineNum - 3), m.lineNum + 2)
          .map((l, i) => `${Math.max(0, m.lineNum - 3) + i + 1}: ${l}`).join('\n'));
      }
    });
    return mod;
  };
}

// ------------------------------------------------------------ renderer
export const canvas = document.createElement('canvas');
// focusable so pointer-lock re-entry works after an Esc unlock (Chrome wants the request from a focused target)
canvas.tabIndex = -1;
canvas.style.outline = 'none';
document.body.prepend(canvas);

// MSAA stays on by default (~4 ms/frame at 2× retina, but a vanished AA reads as a rendering bug); ?msaa=0 is the
// opt-out. ?webgl=1 forces three's WebGL 2 backend. Both are renderer-construction choices, applied on the next load:
// the URL param wins for a session, the persisted preference (video settings) otherwise.
export const PREF_MSAA = 'ew-msaa', PREF_BACKEND = 'ew-backend';
// The stored headset bit is HISTORY, not presence, and it expires — the meaning lives in headset_seen.js so it can be
// driven directly; core.js just supplies the stored value.
export const PREF_HEADSET_SEEN = 'ew-headset-seen';   // ms timestamp of the last granted session (legacy: '1')
const pref = (k) => { try { return localStorage.getItem(k); } catch { return null; } };   // a storage throw must not kill boot
export const headsetSeenRecently = () => {
  // Migrate the legacy '1' marker on first observation and WRITE IT BACK, so it ages out like every real timestamp.
  const now = Date.now(); let raw = pref(PREF_HEADSET_SEEN);
  const migrated = _migrateHeadsetSeen(now, raw);
  if (migrated !== null) { try { localStorage.setItem(PREF_HEADSET_SEEN, migrated); } catch {} raw = migrated; }
  return _headsetSeenRecently(now, raw);
};

// ?xr=1 is a BOOT flag, not a runtime toggle: three's XRManager rides WebGPU (XRGPUBinding — Chrome flags) only if the
// adapter was requested xrCompatible, read off renderer.xr.enabled at init(), so the flag sets it BEFORE init below.
// The backend is a CONSTRUCTION choice: an XR boot rides WebGPU-XR when the browser exposes XRGPUBinding (and WebGL
// is not asked for: ?webgl=1 or the preference), and takes WebGL otherwise (on WebGPU without it the xrCompatible request can hang, and three does not fall back on its own).
// The decision is a pure function, decideBackend in backend_choice.js, tested headless (test/client/backend-choice-test.mjs).
// ?xr is value-parsed: `?xr=1` boots XR, `?xr=0` and absence do not.
export const WEBGPU_XR = 'XRGPUBinding' in globalThis;               // WebGPU can present VR here (Chrome flags)
export const WEBGPU_POSSIBLE = typeof navigator !== 'undefined' && !!navigator.gpu;   // WebGPU API exists at all
const _choice = decideBackend({ params: CONFIG.params, backendPref: pref(PREF_BACKEND), headsetSeen: headsetSeenRecently(), webgpuXR: WEBGPU_XR });
export const XR_BOOT = _choice.xrBoot;
const _forceWebGL = _choice.forceWebGL;
// TOLERANT RENDER LIST: something leaves holes in the per-eye render list mid-session, and the stock loop throws on
// one, blinking the whole frame in the headset. Skip holes, render the rest, log the first few with a stack. Patched
// on the CLASS PROTOTYPE before construction (some path holds a constructor-time binding) and REIMPLEMENTED, not
// wrapped (the list mutates DURING iteration). Installed at boot under ?xr=1, else by enterVR() right before the
// session request (xr.js), so a desktop page runs the replacement loop only from its first VR request on (it stays
// installed after the session ends or is refused).
let renderListToleranceInstalled = false;
export function installRenderListTolerance() {
  if (renderListToleranceInstalled) return; renderListToleranceInstalled = true;
  globalThis.__renderListTolerance = true;   // harness: boot-check asserts this only under ?xr=1
  const proto = THREE.WebGPURenderer?.prototype;
  const orig = proto?._renderObjects;
  let logged = 0;
  if (orig) {
    proto._renderObjects = function (renderList, cam, scn, lightsNode, passId = null) {
      for (let i = 0; i < renderList.length; i++) {
        const item = renderList[i];
        if (!item) {
          if (logged < 5) {
            logged++;
            const err = new Error(`renderList hole at ${i}/${renderList.length}, pass=${passId}, xr=${this.xr?.isPresenting}`);
            globalThis.__errLog?.push?.(`${err.message} :: ${err.stack?.split('\n').slice(2, 5).join(' | ')}`);
            console.warn('[renderlist]', err.message);
          }
          continue;
        }
        const { object, geometry, material, group, clippingContext } = item;
        this._currentRenderObjectFunction(object, scn, cam, geometry, material, group, lightsNode, clippingContext, passId);
      }
    };
  }
}
if (_choice.installTolerance) installRenderListTolerance();

export const renderer = new THREE.WebGPURenderer({ canvas,
  antialias: (CONFIG.params.get('msaa') ?? pref(PREF_MSAA)) !== '0',
  forceWebGL: _forceWebGL });
/** 'webgpu' | 'webgl' — known once renderer.init() resolves. */
export const backendName = () => (renderer.backend?.isWebGLBackend ? 'webgl' : 'webgpu');
if (XR_BOOT) renderer.xr.enabled = true;   // must precede init(): xrCompatible adapter
renderer.setSize(innerWidth, innerHeight);
// SHADOWS FROM THE SUN, NOT THE HEAD: while presenting, Renderer.render() swaps in xr.getCamera() for EVERY render
// call, the shadow pass included, so the map would be drawn from the eyes. Same cure as render.js renderAside: xr off
// around the pass, so the sun camera is honoured (the way Unity renders its map once per frame from the light).
globalThis.__xrShadowPatched = patchShadowNodeForXR(THREE.ShadowNode?.prototype);   // xrshadow.js — importable, so the patch is TESTED (test/client/xrshadow-test.mjs); the global lets boot-check assert it was APPLIED
// Spectators start a notch lower — an audience laptop's job is 30fps for an
// hour, not maximum sharpness. Adaptive scaling adjusts from here.
export const BASE_PIXEL_RATIO = Math.min(devicePixelRatio, CONFIG.spectate ? 1.5 : 2);
renderer.setPixelRatio(BASE_PIXEL_RATIO);
// #32 split vision: while presenting, the pixel ratio belongs to the XR layer — xrpixelratio.js says why.
export const xrPixelRatio = guardPixelRatioInXR(renderer);
globalThis.__xrPixelRatioGuarded = !!xrPixelRatio;   // boot-check asserts the guard was APPLIED, not just importable
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
// XR-READY CONTEXT: three's WebGL backend creates its context without xrCompatible, so the FIRST entry awaits
// gl.makeXRCompatible() (cheap on one GPU, a context switch or loss on a multi-GPU laptop). On a machine a headset was
// seen on, ask at creation instead. Built HERE, not at the constructor: three derives antialias from currentSamples,
// which the tone mapping above has just made 0 (MSAA lives in the internal target). __xrCtx records the cost and
// whether the runtime said yes. ?xrctx=0 = off.
let _xrGl = null;
if (_forceWebGL && (XR_BOOT || headsetSeenRecently()) && CONFIG.params.get('xrctx') !== '0') {
  const t = performance.now();
  const gl = _xrGl = canvas.getContext('webgl2', { antialias: renderer.currentSamples > 0, alpha: true, depth: renderer.depth, stencil: renderer.stencil, xrCompatible: true });
  if (gl) renderer.backend.parameters.context = gl;
  globalThis.__xrCtx = { ms: +(performance.now() - t).toFixed(1), xrCompatible: gl?.getContextAttributes()?.xrCompatible ?? null };
}
await renderer.init();
if (globalThis.__xrCtx) { const a = _xrGl?.getContextAttributes(); Object.assign(globalThis.__xrCtx, { used: !!_xrGl && renderer.backend?.gl === _xrGl, antialias: a?.antialias ?? null, threeWanted: renderer.currentSamples > 0 }); }   // harness: three drew into OUR context, with the antialias it derives itself
// VR enter/exit: stereo renders keep their own render objects, so the switch never rebuilds either variant (xrpass.js).
// Inert without a stereo camera, so every boot gets it — sessions can start from a non-XR boot too.
globalThis.__xrPassSplit = separateXRPass(renderer);
// An emulator's null eye framebuffer is the default framebuffer, not a WeakMap key (xr_nullfb.js). Installs only for a session whose layer has one — never on hardware.
globalThis.__xrNullFb = tolerateNullXRFramebuffer(renderer);
// No pipeline links on the render path: a missed warm pops in late instead of freezing the browser (syncgate.js). ?syncgate=0 = census only.
globalThis.__syncGate = installSyncGate(renderer, { tee: (l, now) => (now ? teeNow(l) : tee(l)), gate: CONFIG.params.get('syncgate') !== '0' });
// A lost context (GPU watchdog reset, driver crash) goes back to the live world instead of a black canvas (gpulost.js).
globalThis.__gpuLost = installGpuLostRecovery({ canvas, renderer, tee, onStop: (why, rule) => bus.emit('gpu-lost-stop', { why, rule }) });
// the splash watchdog (index.html) stops worrying: modules resolved and the
// GPU answered — everything past this point can report its own failures
globalThis.__ewEngineUp = true;

export const scene = new THREE.Scene();
// the construct (no sky yet) wears the PANEL family — deep-ocean dark
scene.background = new THREE.Color(0x0b0f12);   // the page's own --bg: neutral, so the teal chrome is the only colour
scene.fog = new THREE.FogExp2(0x0b0f12, 0.018);

export const DESKTOP_FOV = 55;   // the desktop camera's; leaving VR and photo mode restore it
// The far plane has to hold the SKY, not just the scene: a world-space sky's cloud dome sits ~3200 units out and the
// ringworld band 4940 up. WebGPU's reversed-Z keeps depth precision honest across this range.
export const camera = new THREE.PerspectiveCamera(DESKTOP_FOV, innerWidth / innerHeight, 0.15, 20000);
camera.position.set(3.5, 2.6, 5.5);
camera.lookAt(0, 1, 0);

addEventListener('resize', () => {
  // XR owns the framebuffer while presenting: resizing it mid-session tears
  // the eye buffers. Aspect math is still safe to keep warm.
  if (!renderer.xr?.isPresenting) renderer.setSize(innerWidth, innerHeight);
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
});

// ------------------------------------------------------------ base lighting
// The sky module owns these once a sky verb lands; these are the "empty world"
// defaults so a fresh world is not pitch black.
export const hemi = new THREE.HemisphereLight(0xbfd4ff, 0x283024, 0.75);
scene.add(hemi);
export const sun = new THREE.DirectionalLight(0xfff2e0, 2.2);
sun.position.set(14, 22, 10);
scene.add(sun);

// The stage floor, replaced the moment a terrain verb lands.
export const ground = new THREE.Mesh(
  new THREE.CircleGeometry(80, 64).rotateX(-Math.PI / 2),
  new THREE.MeshStandardNodeMaterial({ color: 0x2a3440, roughness: 0.9, metalness: 0.05 }),
);
ground.receiveShadow = true;
scene.add(ground);
// monochrome grid. GridHelper draws every line in ONE buffer, so its bright centre lines lose the depth test where a
// dark line crosses at the same y and come out dashed — so the grid is all dark, and the two axis lines are their own
// object, a hair higher, drawn after it.
export const grid = new THREE.GridHelper(160, 80, 0x242c36, 0x242c36);   // a shade under the plane (0x2a3440)
export const axisLines = new THREE.LineSegments(
  new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(-80, 0, 0), new THREE.Vector3(80, 0, 0), new THREE.Vector3(0, 0, -80), new THREE.Vector3(0, 0, 80)]),
  new THREE.LineBasicMaterial({ color: 0x6a7078 }));
// Floor lines do not WRITE depth, and sit clear of the ground: on the WebGL backend (most VR sessions: WebGPU-XR needs XRGPUBinding; no reversed-Z)
// 3 mm between grid and axes is inside the depth error a few metres out. Tested against the ground only, at 2 cm /
// 4 cm, it is stable on both backends.
axisLines.material.depthWrite = false;
grid.material.depthWrite = false;
axisLines.position.y = 0.04; axisLines.renderOrder = 2; axisLines.frustumCulled = false;
scene.add(axisLines);
// XR per-eye frustum culling misjudges huge planes (the ground vanishes at some head angles) — one draw call each,
// never cull them
ground.frustumCulled = false;
grid.frustumCulled = false;
grid.position.y = 0.02; grid.renderOrder = 1;
scene.add(grid);

// ---------------------------------------------------------- eidoverse host
// The browser as a compliant eidoverse module host: same globalThis contract as render_scene.mjs, so toolkit files
// (terrain.js, grass.js, sky_system.js, …) eval-load UNMODIFIED from the toolkit repo via /library.

globalThis.THREE = Object.assign({}, THREE, TSL); // engine merges three/tsl into THREE
// We render FORWARD (single color target), not the engine's MRT pipeline: an mrtNode in a forward pipeline emits an
// EMPTY fragment output struct that Chrome/Tint rejects. So this host doesn't expose mrt (modules guard their G-buffer
// opt-outs on it), and upstream also honours the explicit opt-out flag EANPA_NO_MRT.
delete globalThis.THREE.mrt;
globalThis.EANPA_NO_MRT = true;
globalThis._s = scene; globalThis._c = camera; globalThis._r = renderer;
globalThis._sun = sun; globalThis._hemi = hemi;
globalThis._sceneTime = 0;
