// Test stand-in for client/lib/core.js — see tools/ragdoll-test.ts.
// core.js builds a WebGPURenderer at import time; headless tests swap in this
// module, which exports only what ragdoll's dependency cone touches.
// three is imported by explicit path because tools/ sits outside client/,
// where the npm install lives — this resolves to the SAME module instance
// colliders.js gets for its bare 'three' specifier.
import * as THREE_RAW from '../client/node_modules/three/build/three.module.js';

// MeshPhysicalNodeMaterial ships ONLY in three's WebGPU build (three.webgpu.js
// wants a GPU adapter at import, so headless tests load three.module.js). The
// materials factory's transmissive upgrade correctly no-ops when the class is
// absent, which means a harness without a stand-in can only ever prove the
// no-op -- see tools/transmission-test.mjs.
//
// The stand-in matches the real class in the two ways the upgrade depends on:
// the `isNodeMaterial`/`isMeshPhysicalNodeMaterial` flags, and `transmission`
// living on the PROTOTYPE as an accessor (inherited from MeshPhysicalMaterial),
// which is the property whose accessor-ness was the bug the test guards.
// A namespace object is frozen, so this wrapper is how it gets added.
class MeshPhysicalNodeMaterial extends THREE_RAW.MeshPhysicalMaterial {
  constructor(p) {
    super(p);
    this.isNodeMaterial = true;
    this.isMeshPhysicalNodeMaterial = true;
  }
}
export const THREE = Object.freeze({ ...THREE_RAW, MeshPhysicalNodeMaterial });
export const scene = { add() {}, remove() {} };
export const ground = null;
export const grid = null;
export const bus = { on() {}, emit() {} };

// avatar.js pulls a wider slice of core than ragdoll's cone does. None of it
// is exercised by the limp/clip lifecycle under test — the point is only to
// let the module import without a renderer.
export const camera = new THREE_RAW.PerspectiveCamera();   // a real Object3D: the VR-alpha lightrig reads getWorldPosition/matrixWorld
// lightrig configures the shadow map at module scope (enabled/type are in the
// pipeline cache key, so they are set once before the first compile). A bare
// {} is a TypeError there; these are inert stand-ins, not a simulated renderer.
export const renderer = {
  domElement: null,
  shadowMap: { enabled: false, type: 0 },
  _getShadowNodes: () => ({}),
  // the VR-alpha client's render.js wraps these at module scope (render census, curtain); inert here
  render() {}, compileAsync: async () => {}, setRenderTarget() {}, getRenderTarget: () => null,
  setAnimationLoop() {}, getSize: () => ({ width: 1, height: 1 }), setSize() {},
  xr: { enabled: false, isPresenting: false, getCamera: () => null, addEventListener() {}, removeEventListener() {} },
  info: { render: { calls: 0, triangles: 0 }, reset() {} }, backend: { isWebGLBackend: true },
};
export const report = () => {};
export const angleDelta = (a, b) => {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
};
// `params` is real URLSearchParams, not {}: lightrig reads
// CONFIG.params.get('slots') at module scope, so an empty object is a
// TypeError before any test runs. Empty query = every default.
export const CONFIG = { params: new URLSearchParams(), name: 'test' };
// warmqueue.js reaches for the shader-node namespace and the sun. Neither means
// anything headless, but a MISSING export is a SyntaxError at import time, which
// takes the whole suite down before a single test runs (see loadwork-stub).
// A REAL DirectionalLight, not a hand-built stand-in: lightrig configures
// sun.shadow.mapSize/bias and the frustum extents at module scope, and three
// already ships that whole structure correctly. Cheaper to borrow than to
// mimic field by field, and it cannot drift from what the real one has.
export const sun = (() => {
  const l = new THREE_RAW.DirectionalLight(0xffffff, 1);
  l.position.set(0, 1, 0);
  return l;
})();
// CHAINABLE, because materials.js builds real TSL graphs -- `clamp(x,0,1).pow(2)
// .mul(U.wet)` and deeper. The old stub returned `() => {}`, so the first call
// yielded undefined and the next `.pow` threw; any test that reached
// prepareMaterial died on the shader graph rather than on its own subject.
// A self-returning node lets the graph build into nothing, which is exactly
// what a headless harness wants: the factory's WIRING is under test, never the
// shader it emits.
const tslNode = new Proxy(function () {}, {
  get: (_t, k) => (k === 'then' ? undefined : tslNode),   // not a thenable
  apply: () => tslNode,
  construct: () => tslNode,
});
export const TSL = new Proxy({}, { get: () => tslNode });

// --- exports the VR-alpha stack's client adds to core.js / base.js (inert here; the test never renders) ---
export const backendName = () => 'webgl';
export const canvas = { width: 1, height: 1, getBoundingClientRect: () => ({ width: 1, height: 1 }) };
export const hemi = null;
export const axisLines = null;
export const XR_BOOT = false;
export const WEBGPU_XR = false;
export const WEBGPU_POSSIBLE = false;
export const BASE_PIXEL_RATIO = 1;
export const PREF_BACKEND = 'ew-backend';
export const PREF_MSAA = 'ew-msaa';
export const PREF_HEADSET_SEEN = 'ew-headset-seen';
export const installRenderListTolerance = () => {};
export const tee = () => {};
export const colorFor = () => '#888888';
export const assignColors = () => {};
export const setToken = () => {};
export const setName = () => {};
export const setErrorSink = () => {};
