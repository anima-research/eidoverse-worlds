// bun tools/draw-batches-test.ts — scene ownership and batching eligibility.
import { strict as assert } from 'node:assert';
import * as T from '../client/node_modules/three/build/three.module.js';
import { DrawBatches, canInstanceMesh, markDrawBatchSource, instanceTransformSafe } from '../client/lib/draw_batches.js';

const scene = new T.Scene();
const camera = new T.PerspectiveCamera();
camera.position.set(7, 12, 28);
camera.lookAt(7, 0, 7);
camera.updateMatrixWorld(true);
const geometry = new T.BoxGeometry();
const material = new T.MeshStandardMaterial();
const meshes = Array.from({ length: 130 }, (_, i) => {
  const m = new T.Mesh(geometry, material);
  m.position.set(1 + (i % 10), 1, 1 + Math.floor(i / 10));
  scene.add(m);
  return m;
});
markDrawBatchSource(scene);
scene.updateMatrixWorld(true);
const batches = new DrawBatches();
const renderer = { render(s, c) { s.updateMatrixWorld(true); s.onBeforeRender(this, s, c); } };

batches.render({ render(s, c) {
  renderer.render(s, c);
  assert.equal(batches.debug().instanced, 130);
  assert.equal(batches.debug().batches, 3);
  assert.equal(batches.debug().savedColorDraws, 127);
  assert(meshes.every((m) => m.layers.mask === 0));
  // A recursive shadow render must not re-collect the temporarily hidden scene.
  s.onBeforeRender(this, s, c);
  assert.equal(batches.debug().instanced, 130);
  const instance = s.children.find((o) => o.isInstancedMesh);
  const matrix = new T.Matrix4();
  instance.getMatrixAt(0, matrix);
  assert.deepEqual(matrix.elements, meshes[0].matrixWorld.elements);
}}, scene, camera);
assert.equal(scene.children.length, 130);
assert(meshes.every((m) => m.layers.mask === 1));

const before = scene.onBeforeRender;
assert.throws(() => batches.render({ render(s, c) {
  renderer.render(s, c);
  throw Error('simulated render failure');
}}, scene, camera));
assert.equal(scene.onBeforeRender, before);
assert.equal(scene.children.length, 130);
assert(meshes.every((m) => m.layers.mask === 1));
assert.equal(batches.active, false);

// Dynamic parts retain their Object3D identity and live world transform.
const parent = new T.Group();
scene.add(parent);
parent.attach(meshes[0]);
parent.attach(meshes[1]);
parent.rotation.y = 0.4;
parent.position.x = 50;
batches.render(renderer, scene, camera);
assert.equal(meshes[0].parent, parent);
assert.equal(meshes[1].parent, parent);
assert.equal(meshes[0].layers.mask, 1);
parent.visible = false;
batches.render(renderer, scene, camera);
assert.equal(batches.debug().eligible, 128);
parent.visible = true;
parent.scale.set(2, 1, 1);
batches.render(renderer, scene, camera);
assert.equal(batches.debug().eligible, 128);
parent.scale.set(1, 1, 1);

// A hidden source mesh must not swallow visible children with their own layers.
meshes[2].add(new T.Mesh(new T.SphereGeometry(), material));
batches.render({ render(s, c) {
  renderer.render(s, c);
  assert.equal(meshes[2].visible, true);
  assert.equal(meshes[2].children[0].layers.mask, 1);
}}, scene, camera);

const m = meshes[3];
assert(canInstanceMesh(m));
for (const [key, value] of Object.entries({ transparent: true, transmission: 1, alphaHash: true,
  depthWrite: false, depthTest: false, stencilWrite: true, positionNode: {} })) {
  const original = material[key];
  material[key] = value;
  assert(!canInstanceMesh(m), `material ${key}`);
  material[key] = original;
}
const original = m.onBeforeRender;
m.onBeforeRender = () => {};
assert(!canInstanceMesh(m));
m.onBeforeRender = original;
m.userData.noDrawBatch = true;
assert(!canInstanceMesh(m));
delete m.userData.noDrawBatch;
geometry.morphAttributes.position = [geometry.attributes.position];
assert(!canInstanceMesh(m));
delete geometry.morphAttributes.position;
assert(instanceTransformSafe(new T.Matrix4().makeScale(2, 3, 4)));
assert(!instanceTransformSafe(new T.Matrix4().makeScale(-1, 1, 1)));
assert(!instanceTransformSafe(new T.Matrix4().makeScale(0, 1, 1)));
assert(!instanceTransformSafe(new T.Matrix4().makeShear(1, 0, 0, 0, 0, 0)));

// Cast/receive policy and layers never bleed across a batch.
meshes[4].castShadow = meshes[5].castShadow = true;
meshes[6].receiveShadow = meshes[7].receiveShadow = true;
meshes[8].layers.set(2); meshes[9].layers.set(2);
batches.render({ render(s, c) {
  renderer.render(s, c);
  const proxies = s.children.filter((o) => o.isInstancedMesh);
  assert(proxies.some((o) => o.castShadow && o.count === 2));
  assert(proxies.some((o) => o.receiveShadow && o.count === 2));
  // Camera-invisible layers remain original draws (including their shadows).
  assert(!proxies.some((o) => o.layers.mask === 4));
}}, scene, camera);
assert.equal(meshes[8].layers.mask, 4);

// Pending warm never hides originals; retiring during warm releases ONLY the
// instance buffer after that warm finishes, without disposing borrowed assets.
let finish;
let disposed = 0, assetDisposed = 0;
geometry.addEventListener('dispose', () => assetDisposed++);
material.addEventListener('dispose', () => assetDisposed++);
const warming = new DrawBatches({ warm: async (mesh) => {
  mesh.addEventListener('dispose', () => disposed++);
  await new Promise((resolve) => { finish = resolve; });
} });
const tiny = new T.Scene();
for (let i = 0; i < 2; i++) {
  const o = new T.Mesh(geometry, material);
  o.position.set(i + 1, 1, 1); tiny.add(o);
}
markDrawBatchSource(tiny);
warming.render(renderer, tiny, camera);
assert.equal(warming.debug().instanced, 0);
assert(tiny.children.every((o) => o.layers.mask === 1));
await Promise.resolve();
warming.dispose();
assert.equal(disposed, 0);
finish();
await new Promise((r) => setTimeout(r, 0));
assert.equal(disposed, 1);
assert.equal(assetDisposed, 0);

// Coplanar sheets and intersecting solids preserve original depth tie order.
const overlapScene = new T.Scene();
const sheet = new T.PlaneGeometry(3,3);
for (let i=0;i<2;i++) {
  const o = new T.Mesh(sheet,material);
  o.position.set(7+i,1,7);
  overlapScene.add(o);
}
markDrawBatchSource(overlapScene);
batches.render(renderer,overlapScene,camera);
assert.equal(batches.debug().overlapping,2);
assert.equal(batches.debug().instanced,0);

// Prototype disposal evicts borrowed pools immediately, without reaching any
// other prototype's storage or keeping the retired source Object3D alive.
const disposable = new DrawBatches();
disposable.render(renderer,tiny,camera);
assert.equal(disposable.debug().pools,1);
tiny.clear();
geometry.dispose();
assert.equal(disposable.debug().pools,0);
assert.equal(assetDisposed,1);
disposable.dispose();

// Shared animated tangent bases reuse their pool as the angle changes, rather
// than enqueueing one compile per frame. Instance matrices remain translations.
const spinning = new T.Scene();
const spinRoot = new T.Group();
spinRoot.position.set(7,0,7);
spinning.add(spinRoot);
const tangentGeometry = new T.BoxGeometry(); tangentGeometry.computeTangents();
for (const x of [-2,2]) {
  const o = new T.Mesh(tangentGeometry,new T.MeshStandardMaterial());
  o.material = material;
  o.position.set(x,1,0); spinRoot.add(o);
}
markDrawBatchSource(spinRoot);
const spinBatches = new DrawBatches();
for(let i=0;i<10;i++) {
  spinRoot.rotation.y = i*0.08;
  spinBatches.render(renderer,spinning,camera);
  assert.equal(spinBatches.debug().instanced,2);
  assert.equal(spinBatches.debug().pools,1);
}
spinBatches.dispose();

// Removed entities leave no proxy draws; idle cells release instance buffers.
scene.clear();
for (let i = 0; i < 121; i++) batches.render(renderer, scene, camera);
assert.equal(batches.debug().pools, 0);
assert.equal(batches.debug().instanced, 0);
assert.equal(assetDisposed, 1);
batches.dispose();
console.log('draw batches: lifecycle, fallback, transforms, shadows, layers, warm retirement passed');
