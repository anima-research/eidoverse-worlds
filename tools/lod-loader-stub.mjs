// tools/lod-loader-stub.mjs — what tools/lod-loader-probe.ts injects BELOW
// the real client/lib/assets.js: a renderer that never draws, and the
// frame-budget conductors (loadwork, warmqueue) that run their work at once.
// Everything above — the /version handshake, resolveLoadRequest, fetchBytes,
// the GLTF parse, the identity stamps, the proto cache and the clone — is
// the production module, unmodified. The probe's fetch shim is the only
// other seam, and it sits at the network.
import * as THREE from '../client/node_modules/three/build/three.module.js';
export { THREE };

// ---- core.js ----------------------------------------------------------------
export const scene = new THREE.Scene();
export const camera = new THREE.PerspectiveCamera();
// KTX2Loader.detectSupport reads the WebGPU feature set off this; assets.js
// reads GPU memory for the pressure signal and uploads textures through it
export const renderer = {
  isWebGPURenderer: true,
  hasFeature: () => false,
  initTexture() {},
  compileAsync: async () => {},
  info: { memory: { total: 0 } },
  domElement: null,
};
export const report = (where, e) => { console.error(`[report] ${where}`, e); };
export const CONFIG = {};

// ---- loadwork.js ------------------------------------------------------------
export const beginWork = () => ({ phase() {}, async yield() {}, async tick() {}, end() {} });
export const enqueue = (fn) => Promise.resolve().then(fn);
export const nextFrame = () => Promise.resolve();
export const loadNote = () => {};
export const laneBusy = () => false;

// ---- warmqueue.js -----------------------------------------------------------
export const warm = (label, fn) => Promise.resolve().then(fn);
export const warmStats = () => ({ pending: 0, running: false });

// ---- materials.js / draw_batches.js ----------------------------------------
export const prepareObject = () => {};
export const markDrawBatchSource = () => {};
