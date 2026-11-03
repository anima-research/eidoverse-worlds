import * as T from 'three';
import { positionWorld, normalWorld, mix, vec3, float, sin } from 'three/tsl';
import { DrawBatches, markDrawBatchSource } from '/client/lib/draw_batches.js';

const renderer = new T.WebGPURenderer({ antialias: true });
renderer.setSize(800, 600);
renderer.setPixelRatio(1);
renderer.toneMapping = T.ACESFilmicToneMapping;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = T.PCFSoftShadowMap;
document.body.append(renderer.domElement);
await renderer.init();
renderer.info.autoReset = false;
const scene = new T.Scene();
scene.background = new T.Color(0x849cab);
scene.fog = new T.FogExp2(0x849cab, 0.016);
const camera = new T.PerspectiveCamera(55, 4/3, 0.15, 200);
camera.position.set(14, 13, 22);
camera.lookAt(5, 0, 5);
scene.add(new T.HemisphereLight(0xbfd4ff, 0x283024, 1));
const sun = new T.DirectionalLight(0xfff2e0, 3);
sun.position.set(-10, 20, 10);
sun.castShadow = true;
sun.shadow.mapSize.set(1024, 1024);
Object.assign(sun.shadow.camera, { left: -25, right: 25, top: 25, bottom: -25, near: 0.5, far: 80 });
sun.shadow.bias = -0.0005;
scene.add(sun);
const ground = new T.Mesh(new T.PlaneGeometry(150, 150).rotateX(-Math.PI/2),
  new T.MeshStandardNodeMaterial({ color: 0x85735c, roughness: 0.9 }));
ground.receiveShadow = true;
scene.add(ground);
const geo = new T.BoxGeometry(0.7, 0.7, 0.7);
const material = new T.MeshStandardNodeMaterial({ color: 0x63a5c2, roughness: 0.65 });
// World-space weather-style nodes must retain their coordinates and normals.
material.colorNode = mix(vec3(0.08, 0.3, 0.45), vec3(0.35, 0.7, 0.4), sin(positionWorld.x.mul(0.45)).mul(0.5).add(0.5));
material.roughnessNode = mix(float(0.12), float(0.8), normalWorld.y.mul(0.5).add(0.5));
const root = new T.Group();
const items = [];
for (let i = 0; i < 144; i++) {
  const mesh = new T.Mesh(geo, material);
  mesh.position.set(0.7 + (i%12)*1.15, 0.55, 0.7 + Math.floor(i/12)*1.15);
  mesh.rotation.set(0.07*(i%3), (i%7)*0.2, 0);
  mesh.scale.set(1, 0.8 + (i%3)*0.3, 1);
  mesh.receiveShadow = true;
  mesh.castShadow = i%3 === 0;
  root.add(mesh);
  items.push(mesh);
}
markDrawBatchSource(root);
scene.add(root);
const batches = new DrawBatches();
let special;
window.setCase = (name) => {
  special?.removeFromParent(); special = null;
  root.visible = true;
  root.position.set(0,0,0); root.rotation.set(0,0,0); root.scale.set(1,1,1);
  for (let i=0; i<items.length; i++) {
    const mesh = items[i];
    mesh.visible = true; mesh.material = material; mesh.layers.set(0);
    mesh.geometry = geo;
    mesh.position.set(0.7 + (i%12)*1.15, 0.55, 0.7 + Math.floor(i/12)*1.15);
  }
  if (name === 'motion') { root.position.set(2,0,-1); root.rotation.y = 0.48; }
  if (name === 'hidden') { for (let i=0;i<50;i++) items[i].visible = false; }
  if (name === 'mirrored') root.scale.x = -1;
  if (name === 'sheared') root.scale.set(1.6, 0.8, 1);
  if (name === 'layers') { for (let i=0;i<50;i++) items[i].layers.set(2); }
  if (name === 'frustum') { root.position.x = 12; }
  if (name === 'shadow-only') {
    // Casters behind the eye still project shadows into the visible scene.
    for (let i=0;i<36;i++) items[i].position.set(6+(i%6), 5, 19+Math.floor(i/6));
  }
  if (name === 'transparent') {
    const glass = new T.MeshPhysicalNodeMaterial({ color: 0xe0bbff, transparent: true,
      opacity: 0.4, side: T.DoubleSide, roughness: 0.1 });
    for (let i=0;i<36;i++) items[i].material = glass;
  }
  if (name === 'cutout') {
    const bytes = new Uint8Array(4*4*4).fill(255);
    for (let i=0;i<16;i++) bytes[i*4+3] = i%3 ? 255 : 0;
    const tex = new T.DataTexture(bytes,4,4); tex.needsUpdate = true;
    const cutout = new T.MeshStandardNodeMaterial({ map: tex, alphaTest: 0.5, side: T.DoubleSide });
    for (const item of items) item.material = cutout;
  }
  if (name === 'tangents' || name === 'overlap') {
    const tangents = geo.clone();
    tangents.computeTangents();
    const bytes = new Uint8Array([170,90,235,255, 80,150,235,255, 140,190,235,255, 100,60,235,255]);
    const tex = new T.DataTexture(bytes,2,2); tex.needsUpdate = true;
    const normalMapped = new T.MeshStandardNodeMaterial({ color:0x63a5c2, normalMap:tex, roughness:0.5 });
    for (const item of items) { item.geometry = tangents; item.material = normalMapped; }
    if (name === 'overlap') for (const item of items) {
      item.position.x *= 0.4;
      item.position.z *= 0.4;
    }
  }
  if (name === 'removed') root.visible = false;
};
window.capture = async (enabled) => {
  batches.enabled = enabled;
  // Two frames settle renderer caches and uniform uploads before the receipt.
  for (let i=0;i<2;i++) {
    renderer.info.reset();
    batches.render(renderer, scene, camera);
    await new Promise(requestAnimationFrame);
  }
  renderer.info.reset();
  const t0 = performance.now();
  batches.render(renderer, scene, camera);
  const ms = performance.now()-t0;
  return { png: renderer.domElement.toDataURL('image/png'), drawCalls: renderer.info.render.drawCalls,
    triangles: renderer.info.render.triangles, ms, batches: batches.debug() };
};
window.ready = true;
