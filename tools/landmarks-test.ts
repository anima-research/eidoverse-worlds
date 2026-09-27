// bun tools/landmarks-test.ts — actual raycasts plus independent bone FK.
import { plugin } from 'bun';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
const STUB = fileURLToPath(new URL('./core-stub.mjs', import.meta.url));
plugin({ name: 'landmark-core', setup(b) { b.onResolve({ filter: /^\.\/core\.js$/ }, () => ({ path: STUB })); } });
const { THREE } = await import('./core-stub.mjs');
const { deriveLandmarks, derivePalmAnchor, landmarkWorld } = await import('../client/lib/landmarks.js');
const { measureChain, solveChain } = await import('../client/lib/reachbone.js');
const { rigs, libraryRigs, makeAvatar } = await import('./rig-load.mjs');

const P = Object.fromEntries(Object.entries({ hips: [0, 1, 0], spine: [0, 1.2, 0],
  chest: [0, 1.4, 0], head: [0, 1.7, 0], leftUpperArm: [.2, 1.4, 0],
  leftLowerArm: [.5, 1.4, 0], leftHand: [.8, 1.4, 0],
  rightUpperArm: [-.2, 1.4, 0], rightLowerArm: [-.5, 1.4, 0], rightHand: [-.8, 1.4, 0],
  leftUpperLeg: [.1, 1, 0], rightUpperLeg: [-.1, 1, 0],
}).map(([k, p]) => [k, new THREE.Vector3(...p)]));
function avatar() {
  const av: any = makeAvatar(P);
  av.vrm.scene = av.root;
  av.vrm.humanoid.update = () => {};
  return av;
}
{
  const av = avatar();
  const far = new THREE.Mesh(new THREE.BoxGeometry(.15, .15, .15), new THREE.MeshBasicMaterial());
  far.position.set(1.5, 1.4, 0); av.root.add(far); av.root.updateMatrixWorld(true);
  const specs = { hand: { bone: 'leftHand', from: [1, 0, 0], radius: .22 } };
  assert.equal(deriveLandmarks(av, specs).get('hand').how, 'fallback', 'unrelated geometry cannot become the hand');
  const hand = new THREE.Mesh(new THREE.BoxGeometry(.08, .04, .06), new THREE.MeshBasicMaterial());
  hand.position.set(.8, 1.4, 0); av.root.add(hand);
  const mark = deriveLandmarks(av, specs).get('hand');
  assert.equal(mark.how, 'surface');
  assert.ok(Math.abs(landmarkWorld(mark).pos.x - .84) < 1e-6, 'known hand surface');
  const palm = derivePalmAnchor(av, 'left');
  assert.ok(palm && Math.abs(palm.offset.y + .02) < 1e-6, 'palm surface measured below wrist');
  const forearm = new THREE.Mesh(new THREE.BoxGeometry(.3, .06, .06), new THREE.MeshBasicMaterial());
  forearm.position.set(.65, 1.4, 0); av.root.add(forearm);
  const arm = deriveLandmarks(av).get('forearm_l');
  assert.equal(arm.how, 'surface');
  assert.ok(Math.abs(landmarkWorld(arm).pos.x - .65) < 1e-6, 'forearm target is halfway to wrist');
}
{
  const av = avatar(), hand = av.nodes.leftHand;
  const geometry = new THREE.BoxGeometry(.08, .04, .06).translate(.8, 1.4, 0);
  const n = geometry.attributes.position.count;
  geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(new Uint16Array(n * 4), 4));
  const weights = new Float32Array(n * 4); for (let i = 0; i < n; i++) weights[i * 4] = 1;
  geometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute(weights, 4));
  const mesh = new THREE.SkinnedMesh(geometry, new THREE.MeshBasicMaterial());
  av.root.add(mesh); mesh.bind(new THREE.Skeleton([hand]));
  av.nodes.leftUpperArm.rotation.z = 1;
  av.root.updateMatrixWorld(true); mesh.skeleton.update();
  mesh.computeBoundingSphere(); mesh.computeBoundingBox();
  const oldSphere = mesh.boundingSphere, oldBox = mesh.boundingBox;
  const palm = derivePalmAnchor(av, 'left');
  assert.ok(palm && Math.abs(palm.offset.y + .02) < 1e-6, 'stale animated bounds cannot hide rest-pose hand');
  assert.equal(mesh.boundingSphere, oldSphere); assert.equal(mesh.boundingBox, oldBox);
  assert.ok(Math.abs(av.nodes.leftUpperArm.rotation.z - 1) < 1e-6, 'live pose restored');
}
// New named targets: known surfaces, optional eye/toe bones, and wire names.
{
  const { canonicalPoint, pointsUpTo } = await import('../shared/contact.js');
  const { normalizeReachTarget } = await import('../shared/reachwire.js');
  const av = avatar();
  function bone(name, position, parent = av.root) {
    const node = new THREE.Object3D(); node.position.fromArray(position); parent.add(node);
    av.nodes[name] = node; av.vrm.humanoid.humanBones[name] = {};
  }
  function box(position, size) {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(...size), new THREE.MeshBasicMaterial());
    mesh.position.fromArray(position); av.root.add(mesh);
  }
  bone('neck', [0, 1.55, 0]);
  box([0, 1.60, 0], [.1, .18, .1]);
  for (const [side, sign] of [['left', 1], ['right', -1]] as const) {
    bone(side + 'Eye', [sign * .035, .08, .04], av.nodes.head);
    box([sign * .035, 1.78, .04], [.04, .04, .04]);
    bone(side + 'Foot', [sign * .1, .08, .02]);
    bone(side + 'Toes', [sign * .1, .08, .18]);
    box([sign * .1, .08, .1], [.12, .06, .24]);
    box([sign * .8, 1.4, 0], [.08, .04, .06]);
  }
  const marks = deriveLandmarks(av);
  for (const name of ['eye_l', 'eye_r', 'foot_l', 'foot_r', 'wrist_l', 'wrist_r', 'neck_back']) {
    assert.equal(marks.get(name)?.how, 'surface', name + ' has a measured surface');
    assert.equal(normalizeReachTarget({ who: 'someone', point: name })?.point, name);
  }
  for (const suffix of ['l', 'r']) {
    assert.ok(Math.abs(landmarkWorld(marks.get('foot_' + suffix)).pos.z - .1) < 1e-6, 'instep lies between ankle and toes');
    assert.ok(Math.abs(landmarkWorld(marks.get('wrist_' + suffix)).pos.y - 1.42) < 1e-6, 'wrist stays at forearm end');
    assert.ok(Math.abs(landmarkWorld(marks.get('eye_' + suffix)).pos.z - .06) < 1e-6, 'eye front surface');
  }
  assert.ok(Math.abs(landmarkWorld(marks.get('neck_back')).pos.z + .05) < 1e-6, 'nape is behind neck');
  const eye = marks.get('eye_l'), before = landmarkWorld(eye).pos.clone();
  av.nodes.leftEye.rotation.y = .8; av.root.updateMatrixWorld(true);
  assert.ok(landmarkWorld(eye).pos.distanceTo(before) < 1e-6, 'gaze does not drag eye target');
  av.nodes.head.rotation.y = .4; av.root.updateMatrixWorld(true);
  assert.ok(landmarkWorld(eye).pos.distanceTo(before) > .001, 'eye target follows head');
  delete av.nodes.leftEye; delete av.nodes.rightEye;
  delete av.nodes.leftToes; delete av.nodes.rightToes;
  const estimated = deriveLandmarks(av);
  for (const name of ['eye_l', 'eye_r', 'foot_l', 'foot_r']) {
    assert.equal(estimated.get(name)?.how, 'fallback', name + ' is explicit when optional bones are absent');
  }
  for (const [alias, name] of [['left eye', 'eye_l'], ['right wrist', 'wrist_r'], ['right foot', 'foot_r'], ['back of the neck', 'neck_back'], ['nape', 'neck_back']]) {
    assert.equal(canonicalPoint(alias), name);
  }
  assert.ok(!pointsUpTo('familiar').includes('eye_l'), 'eyes retain intimate tier');
}
let tested = 0, worst = 0;
const good = [...rigs(), ...libraryRigs()].filter((r: any) => !r.err);
assert.ok(good.length >= 18, 'include the library rigs');
for (const rig of good) for (const side of ['left', 'right']) for (const normal of [[0, -1, 0], [0, 0, -1]]) {
  const av = makeAvatar(rig.P, { realParent: rig.realParent, vrm0: rig.vrm0 });
  const chain: any = measureChain(av, side + 'Hand');
  assert.ok(chain);
  // A known nonzero local palm anchor tests the correction independently of
  // ray placement, across the shipped bone hierarchies (including VRM0).
  chain.palmOffset = [.025, -.018, .012];
  chain.guards = [];
  av.root.rotation.y = .7; av.root.scale.setScalar(1.3); av.root.updateMatrixWorld(true);
  const shoulder = av.root.worldToLocal(chain.nodes.upper.getWorldPosition(new THREE.Vector3()));
  const target = av.root.localToWorld(shoulder.add(new THREE.Vector3(0, -.12, (chain.L1 + chain.L2) * .7)));
  const out: any = solveChain(chain, av, target.toArray(), null, { palm: { dir: normal } });
  assert.ok(out.ok);
  chain.nodes.upper.quaternion.fromArray(out.upper);
  chain.nodes.lower.quaternion.fromArray(out.lower);
  chain.nodes.end.quaternion.fromArray(out.hand);
  av.root.updateMatrixWorld(true);
  const actual = chain.nodes.end.localToWorld(new THREE.Vector3(...chain.palmOffset));
  const gap = actual.distanceTo(target);
  assert.ok(Math.abs(gap - out.res.gap) < 1e-6, `${rig.name}/${side}: reported gap follows actual palm`);
  assert.ok(gap <= Math.hypot(...chain.palmOffset) * 1.3 + 1e-6, 'difficult orientations never worsen the initial palm gap');
  if (normal[1] === -1 && !out.res.bound.length) { worst = Math.max(worst, gap); tested++; }
}
assert.ok(tested > 15);
assert.ok(worst < .005, `palm should land within 5mm, worst ${worst}`);
console.log(`Landmark regressions passed; ${tested} unbounded palm reaches across ${good.length} rigs, worst ${(worst * 1000).toFixed(2)}mm.`);
