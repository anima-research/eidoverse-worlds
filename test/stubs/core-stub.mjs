// Test stand-in for client/lib/core.js (see test/client/ragdoll-test.ts): core.js builds a WebGPURenderer at import, so
// headless tests swap in this module, exporting what the dependency cones touch. three is imported by explicit path
// (test/ is outside client/'s install) so it's the SAME instance colliders.js gets for bare 'three'.
import * as THREE_RAW from '../../client/node_modules/three/build/three.module.js';

// MeshPhysicalNodeMaterial ships ONLY in three's WebGPU build (which wants a GPU at import); without a stand-in the
// transmissive upgrade can only prove its no-op (test/client/transmission-test.mjs). It matches the real class where the
// upgrade depends on it: the `isNodeMaterial`/`isMeshPhysicalNodeMaterial` flags, and `transmission` as a PROTOTYPE
// accessor (the property the test guards). A namespace object is frozen, hence this wrapper.
class MeshPhysicalNodeMaterial extends THREE_RAW.MeshPhysicalMaterial {
  constructor(p) {
    super(p);
    this.isNodeMaterial = true;
    this.isMeshPhysicalNodeMaterial = true;
  }
}
// warmqueue's depth pre-warm builds a NodeMaterial (WebGPU only); a plain Material lets the caster budget run headless
// (test/client/shadow-fade-test.mjs); nothing compiles a shader
class NodeMaterial extends THREE_RAW.Material { constructor(p) { super(); this.isNodeMaterial = true; if (p) this.setValues(p); } }
// avatar.js's nameplate is a SpriteNodeMaterial (WebGPU only); the plain sprite material stands in
class SpriteNodeMaterial extends THREE_RAW.SpriteMaterial { constructor(p) { super(p); this.isNodeMaterial = true; } }
export const THREE = Object.freeze({ ...THREE_RAW, MeshPhysicalNodeMaterial, NodeMaterial, SpriteNodeMaterial });
export const scene = { add() {}, remove() {} };
export const ground = null;
export const grid = null;
export const bus = { on() {}, emit() {} };

// avatar.js pulls a wider slice of core than ragdoll's cone; none is exercised, it only lets the module import
export const camera = new THREE_RAW.PerspectiveCamera();  // a real Object3D: the VR-alpha lightrig reads getWorldPosition/matrixWorld
// lightrig configures the shadow map at module scope (enabled/type are in the pipeline cache key); a bare {} is a
// TypeError there. Inert stand-ins, not a simulated renderer.
export const renderer = {
  domElement: null,
  shadowMap: { enabled: false, type: 0 },
  _getShadowNodes: () => ({}),
  // the VR-alpha client's render.js wraps these at module scope (render census, curtain); inert here
  render() {}, compileAsync: async () => {}, setRenderTarget() {}, getRenderTarget: () => null,
  setAnimationLoop() {}, getSize: () => ({ width: 1, height: 1 }), setSize() {},
  xr: { enabled: false, isPresenting: false, getCamera: () => null, addEventListener() {}, removeEventListener() {} },
  info: { render: { calls: 0, triangles: 0 }, reset() {} }, backend: { isWebGLBackend: true },
  // KTX2Loader.detectSupport (assets.js module scope) asks a WebGL renderer for its extensions
  extensions: { has: () => false }, capabilities: { isWebGL2: true },
};
export const report = () => {};
export const angleDelta = (a, b) => {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
};
// real URLSearchParams: lightrig reads CONFIG.params.get('slots') at module scope; empty query = every default
export const CONFIG = { params: new URLSearchParams(globalThis.location?.search ?? ''), name: 'test' };   // as base.js reads it
// warmqueue.js needs the shader-node namespace and the sun (a MISSING export is a SyntaxError at import); a real
// DirectionalLight, since lightrig configures its shadow fields at module scope
export const sun = (() => {
  const l = new THREE_RAW.DirectionalLight(0xffffff, 1);
  l.position.set(0, 1, 0);
  return l;
})();
// CHAINABLE: materials.js builds real TSL graphs (`clamp(x,0,1).pow(2).mul(U.wet)`); a self-returning node lets the
// graph build into nothing (the wiring is under test, never the shader)
const tslNode = new Proxy(function () {}, {
  get: (_t, k) => (k === 'then' ? undefined : tslNode),  // not a thenable
  apply: () => tslNode,
  construct: () => tslNode,
});
export const TSL = new Proxy({}, { get: () => tslNode });

// --- exports the VR-alpha client adds to core.js / base.js (inert here) ---
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
// core.js exports this predicate (#197: the stored bit is history, not presence); same signature, no-arg → boolean
export const headsetSeenRecently = () => false;
// base.js exports this (#197: 'avatar-worn' normalised through one wornNameOf); bodies.js imports it. Payload or string in, name or null out.
export const wornNameOf = (v) => (typeof v === 'string' ? v : v?.name ?? null);
export const installRenderListTolerance = () => {};
export const tee = () => {};
export const colorFor = () => '#888888';
export const assignColors = () => {};
export const setToken = () => {};
export const setName = () => {};
export const setErrorSink = () => {};
export const forgetRememberedWorlds = () => {};
export const xrPixelRatio = 1;  // core.js: the XR pixel-ratio guard's result; headless, nothing to guard
