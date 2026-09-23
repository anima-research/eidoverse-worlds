// Test stand-in for core.js / base.js / world.js under client/lib/perfscope.js — see
// tools/perfscope-test.ts. Real three (the same module instance perfscope's 'three/tsl'
// graph nodes attach to), a REAL Scene and camera the suite fills with a fixture, and a
// renderer whose render() COUNTS what it is handed into renderer.info the way a GPU
// renderer would — so render.js's measured drawStats feed can be driven with no adapter.
//
// core-stub.js's THREE has no MeshBasicNodeMaterial (that class ships only in the WebGPU
// build); perfscope's silhouette hull is one, so a plain-material stand-in with the node
// flags is added here — the hull's TSL positionNode is built, never compiled.
import * as THREE_RAW from '../client/node_modules/three/build/three.module.js';
import { THREE as CORE_THREE } from './core-stub.mjs';
export * from './core-stub.mjs';

class MeshBasicNodeMaterial extends THREE_RAW.MeshBasicMaterial {
  constructor(p) { super(p); this.isNodeMaterial = true; this.isMeshBasicNodeMaterial = true; }
}
export const THREE = Object.freeze({ ...CORE_THREE, MeshBasicNodeMaterial });

export const scene = new THREE_RAW.Scene();
export const camera = new THREE_RAW.PerspectiveCamera(70, 1, 0.1, 200);
camera.position.set(0, 1.6, 6);
camera.updateMatrixWorld(true);
// the loupe listens on the canvas; a real element so add/removeEventListener are honest
export const canvas = document.createElement('canvas');

// ---- the counting renderer, WebGPURenderer-shaped info (render.js reads drawCalls and `calls` = passes):
// one drawCall per drawable mesh, index.count/3 (× instances) triangles, one `calls` per render()
export const renders = [];
const info = { render: { frame: 0, calls: 0, drawCalls: 0, triangles: 0, points: 0, lines: 0 }, memory: { geometries: 0, textures: 0 }, reset() {} };
function countScene(root) {
  let calls = 0, triangles = 0;
  const visit = (o) => {
    if (!o.visible) return;
    if (o.isMesh) {
      const g = o.geometry;
      const idx = g?.index ? g.index.count : (g?.attributes?.position?.count ?? 0);
      const n = o.isInstancedMesh ? o.count : 1;
      calls += 1; triangles += Math.round(idx / 3) * n;
    }
    for (const c of o.children) visit(c);
  };
  visit(root);
  return { calls, triangles };
}
export const renderer = {
  domElement: canvas,
  info,
  shadowMap: { enabled: false, type: 0 },
  backend: { isWebGLBackend: true },
  xr: { enabled: false, isPresenting: false, getCamera: () => null, updateCamera() {}, addEventListener() {}, removeEventListener() {} },
  getRenderTarget: () => null, setRenderTarget() {},
  getSize: () => ({ width: 640, height: 360 }), setSize() {}, setAnimationLoop() {},
  compileAsync: async () => {}, _getShadowNodes: () => ({}),
  extensions: { has: () => false }, capabilities: { isWebGL2: true },
  render(sc, cam) {
    const c = countScene(sc);
    info.render.frame += 1; info.render.calls += 1; info.render.drawCalls += c.calls; info.render.triangles += c.triangles;
    renders.push({ scene: sc, camera: cam, ...c });
  },
};

// ---- world.js: the entity registry perfscope attributes cost to
export const entities = new Map();
export const entityMeta = new Map();
