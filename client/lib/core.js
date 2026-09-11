// core — the PRESENTATION substrate: renderer, scene, camera, canvas, the
// base lights and stage floor, and the eidoverse module-host contract. The
// renderer-free substrate (bus, CONFIG, report, colours, helpers) lives in
// base.js (RENDERER-SEAM move 2) — modules that never touch the GPU import
// THAT and stop depending on this file transitively.
//
// Import rule: core imports nothing from the client except base.js (which
// imports nothing at all). Everything else may import either. The module
// graph stays acyclic at load time even where the runtime call graph is
// circular.

import * as THREE from 'three';
import * as TSL from 'three/tsl';
import { CONFIG } from './base.js';
import { decideBackend } from './backend_choice.js';
import { patchShadowNodeForXR } from './xrshadow.js';

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
// focusable so pointer-lock re-entry works after an Esc unlock: Chrome wants
// the request to come from a focused target, and a canvas is not focusable by
// default.
canvas.tabIndex = -1;
canvas.style.outline = 'none';
document.body.prepend(canvas);

// MSAA policy (§22n measured, §22r reverted to ON): the 4×MSAA resolve at
// 2× retina costs ~4ms/frame (+10fps when dropped, drift-controlled A/B),
// but a silently-vanished AA reads as a rendering bug to anyone not holding
// the measurement — so MSAA stays the default everywhere and ?msaa=0 is the
// opt-out lever (the +10fps is one flag away; §22q bought the frames back
// for the default look). The dPR-gated auto-off waits for a real settings
// row alongside the other quality dials.
// ?webgl=1 forces three's WebGL 2 backend — the path a browser without WebGPU
// (Firefox stable, older Safari, most WebXR runtimes today) takes on its own.
// Both are renderer-construction choices, so they apply on the next load: the
// URL param wins for a session (the A/B lever), the persisted preference
// (video settings) otherwise.
export const PREF_MSAA = 'ew-msaa', PREF_BACKEND = 'ew-backend';
export const PREF_HEADSET_SEEN = 'ew-headset-seen';   // set once initXR confirms immersive-vr support; lets the NEXT boot pick WebGL up front so the visor ENTERS instead of RELOADING (R 09-07: the reload tax is the porch-vs-us gap)
const pref = (k) => { try { return localStorage.getItem(k); } catch { return null; } };   // a storage throw must not kill boot
// ?xr=1 is a BOOT flag, not a runtime toggle: three's XRManager (0.185–0.186) rides
// WebGPU (XRGPUBinding — Chrome, flags today) but only if the adapter was
// requested xrCompatible, which the backend reads off renderer.xr.enabled at
// init() time. So the flag sets xr.enabled BEFORE init below.
// The backend is a CONSTRUCTION choice, so "WebGPU if it can do VR, else
// WebGL" has to be decided here, not at the visor button: on a WebGPU backend
// the xrCompatible adapter request never resolved on Chrome 152 + RTX
// (09-06 11:12, splash 'still waking after 20s', twice) — three did NOT fall
// back on its own. An XR boot therefore takes WebGL unless the page opts into
// ?webgpu=1 AND the browser exposes XRGPUBinding; when Chrome ships WebGPU-XR
// unflagged, flip the default here and nowhere else.
// The decision itself (which backend, whether this is an XR boot, whether the tolerant render list installs)
// is a pure function in backend_choice.js — importable headless, so the matrix is TESTED rather than trusted
// (tools/backend-choice-test.mjs). ?xr is value-parsed: `?xr=1` boots XR, `?xr=0` and absence do not.
export const WEBGPU_XR = 'XRGPUBinding' in globalThis;               // WebGPU can present VR here (Chrome flags)
export const WEBGPU_POSSIBLE = typeof navigator !== 'undefined' && !!navigator.gpu;   // WebGPU API exists at all
const _choice = decideBackend({ params: CONFIG.params, backendPref: pref(PREF_BACKEND), headsetSeen: pref(PREF_HEADSET_SEEN) === '1', webgpuXR: WEBGPU_XR });
export const XR_BOOT = _choice.xrBoot;
const _forceWebGL = _choice.forceWebGL;
// TOLERANT RENDER LIST (XR strobe, 08-05): something leaves holes in the
// per-eye render list mid-session ("Cannot destructure 'object' of
// renderList[i]"), and the stock loop throws — one hole kills the whole
// frame, which reads as the world blinking in the headset. Skip holes, render
// everything else, log the first few with a stack. Patched on the CLASS
// PROTOTYPE before construction — an instance patch verifiably engaged yet
// raw crashes continued (some path holds a constructor-time binding).
// REIMPLEMENTED, not wrapped: the list mutates DURING iteration (the stock
// loop caches its length and then dereferences a vacated slot).
// Installed at boot under ?xr=1, otherwise by enterVR() right before the session request (xr.js) — a desktop
// session never runs the replacement loop (review 2026-09-08: navigator.xr exists in every Chrome).
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
// SHADOWS FROM THE SUN, NOT THE HEAD (R 09-07 18:48 'why do shadows tank the frame rate? nothing casts a shadow
// on the ground'): while presenting, Renderer.render() swaps in xr.getCamera() for EVERY render call
// (three.webgpu.js r186 'use XR camera for rendering') — including the shadow pass's own render
// from shadow.camera. So in VR the 2048² map was drawn from the eyes: a full extra scene pass per frame that
// produced no usable shadow (the old fix was to disable shadows in XR and eat a whole-scene recompile both
// ways). Same cure as render.js renderAside: xr off around the pass, so the sun camera is honoured. Unity
// (Basis: 8192 map, 4 cascades, 150 m) renders its map once per frame from the light — this is that.
globalThis.__xrShadowPatched = patchShadowNodeForXR(THREE.ShadowNode?.prototype);   // xrshadow.js — importable, so the patch is TESTED (tools/xrshadow-test.mjs); the global lets boot-check assert it was APPLIED
// Spectators start a notch lower — an audience laptop's job is 30fps for an
// hour, not maximum sharpness. Adaptive scaling adjusts from here.
export const BASE_PIXEL_RATIO = Math.min(devicePixelRatio, CONFIG.spectate ? 1.5 : 2);
renderer.setPixelRatio(BASE_PIXEL_RATIO);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
await renderer.init();
// the splash watchdog (index.html) stops worrying: modules resolved and the
// GPU answered — everything past this point can report its own failures
globalThis.__ewEngineUp = true;

export const scene = new THREE.Scene();
// the construct (no sky yet) wears the PANEL family — deep-ocean dark — not a
// navy that fought the teal chrome (R, 09-05)
scene.background = new THREE.Color(0x0b0f12);   // the page's own --bg: neutral, so the teal chrome is the only colour (R, 09-05: teal ground read odd)
scene.fog = new THREE.FogExp2(0x0b0f12, 0.018);

// The far plane has to hold the SKY, not just the scene. Skye's world-space
// sky builds a cloud dome ~3200 units out, and the ringworld package hangs its
// band 4940 up — at the old far plane of 300 the entire atmosphere was clipped
// away and the sky rendered black while the ground looked perfectly fine.
// WebGPU's reversed-Z keeps depth precision honest across this range in a way
// WebGL's would not.
export const camera = new THREE.PerspectiveCamera(55, innerWidth / innerHeight, 0.15, 20000);
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
// monochrome grid (R, 09-05). GridHelper draws every line in ONE buffer, so
// its bright centre lines lose the depth test wherever a dark line crosses
// them at the same y and come out dashed — so the grid is all dark, and the
// two axis lines are their own object, a hair higher, drawn after it.
export const grid = new THREE.GridHelper(160, 80, 0x1e2328, 0x1e2328);
export const axisLines = new THREE.LineSegments(
  new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(-80, 0, 0), new THREE.Vector3(80, 0, 0), new THREE.Vector3(0, 0, -80), new THREE.Vector3(0, 0, 80)]),
  new THREE.LineBasicMaterial({ color: 0x6a7078 }));
// Floor lines do not WRITE depth, and they sit clear of the ground: on the WebGL backend (every VR
// session — no reversed-Z) the 3 mm between grid (0.01) and axes (0.013) was inside the 24-bit
// depth error a few metres out, so the axis lines strobed and the grid cut through them (R in the
// headset, 09-06 11:31). Testing against the ground only, at 2 cm / 4 cm, is stable on both backends.
axisLines.material.depthWrite = false;
grid.material.depthWrite = false;
axisLines.position.y = 0.04; axisLines.renderOrder = 2; axisLines.frustumCulled = false;
scene.add(axisLines);
// XR per-eye frustum culling misjudges huge planes (in-headset 08-05: the
// ground VANISHES at some head angles) — one draw call each, never cull them
ground.frustumCulled = false;
grid.frustumCulled = false;
grid.position.y = 0.02; grid.renderOrder = 1;
scene.add(grid);

// ---------------------------------------------------------- eidoverse host
// The browser as a compliant eidoverse module host: same globalThis contract as
// render_scene.mjs, so toolkit files (terrain.js, grass.js, sky_system.js, …)
// eval-load UNMODIFIED from Skye's repo via /library.

globalThis.THREE = Object.assign({}, THREE, TSL); // engine merges three/tsl into THREE
// We render FORWARD (single color target), not the engine's MRT pipeline.
// Eidoverse modules guard their G-buffer opt-outs on the presence of THREE.mrt,
// and an mrtNode in a forward pipeline emits an EMPTY fragment output struct
// that Chrome/Tint rejects. Two belts: a non-MRT host honestly declares itself
// by not exposing mrt, AND upstream now honours an explicit opt-out flag
// (EANPA_NO_MRT), which is the supported way as of the eanpa sky port.
delete globalThis.THREE.mrt;
globalThis.EANPA_NO_MRT = true;
globalThis._s = scene; globalThis._c = camera; globalThis._r = renderer;
globalThis._sun = sun; globalThis._hemi = hemi;
globalThis._sceneTime = 0;
