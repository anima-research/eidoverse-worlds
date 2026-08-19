// Test stand-in for client/lib/core.js — see tools/ragdoll-test.ts.
// core.js builds a WebGPURenderer at import time; headless tests swap in this
// module, which exports only what ragdoll's dependency cone touches.
// three is imported by explicit path because tools/ sits outside client/,
// where the npm install lives — this resolves to the SAME module instance
// colliders.js gets for its bare 'three' specifier.
import * as THREE from '../client/node_modules/three/build/three.module.js';
export { THREE };
export const scene = { add() {}, remove() {} };
export const ground = null;
export const grid = null;
export const bus = { on() {}, emit() {} };

// avatar.js pulls a wider slice of core than ragdoll's cone does. None of it
// is exercised by the limp/clip lifecycle under test — the point is only to
// let the module import without a renderer.
export const camera = { position: new THREE.Vector3(), quaternion: new THREE.Quaternion() };
export const renderer = { domElement: null };
export const report = () => {};
export const angleDelta = (a, b) => {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
};
export const CONFIG = {};
// warmqueue.js reaches for the shader-node namespace and the sun. Neither means
// anything headless, but a MISSING export is a SyntaxError at import time, which
// takes the whole suite down before a single test runs (see loadwork-stub).
export const sun = { position: new THREE.Vector3(0, 1, 0) };
export const TSL = new Proxy({}, { get: () => () => {} });
