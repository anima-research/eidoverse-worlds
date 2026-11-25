// Stand-in for the browser's core module, so shared CPU body/terrain modules load headless.
// Three scene objects and TSL nodes are real; there is no renderer or canvas.
import * as THREE from 'three/webgpu';
import * as TSL from 'three/tsl';
export { THREE, TSL };
export const scene = new THREE.Scene();
export const ground = null;
export const grid = null;
export const axisLines = null;          // terrain.js toggles it with the grid
export const backendName = () => 'none';   // avatar.js calls it for the renderer backend; there is none here
export const XR_BOOT = false;           // frameloop.js: this is never an XR boot
export const camera = new THREE.PerspectiveCamera();
// Client light setup reads shadow configuration even when nothing draws.
export const renderer = { domElement: null, shadowMap: { enabled: false, type: 0 }, _getShadowNodes: () => ({}) };
export const CONFIG = { params: new URLSearchParams(), name: 'headless' };
export const sun = new THREE.DirectionalLight(0xffffff, 1);
sun.position.set(0, 1, 0);
export const report = () => {};
export const angleDelta = (a, b) => {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
};
