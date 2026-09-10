// Runtime adapter for shared CPU body/terrain modules that otherwise import
// the browser's core. Three scene objects and shader nodes are real; there is
// no WebGPU renderer, canvas, test material imitation or fixture dependency.
import * as THREE from 'three/webgpu';
import * as TSL from 'three/tsl';
export { THREE, TSL };
export const scene = new THREE.Scene();
export const ground = null;
export const grid = null;
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
