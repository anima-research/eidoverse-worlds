// A lamp inside a SKINNED body is located through the SKELETON, not by
// rotating its bind-pose centre (client/lib/lightrig.js worldPosOf).
//
// Janus: "there seems to be a directional bias to the light. if i face in a
// different direction, it hits mostly my left wing, and in another, mostly
// right wing, etc." Measured on the live body while turning in place, the
// light swept 0.34m in x and 0.36m in z -- orbiting its own mean by ~0.17m,
// inside a chest cavity about 0.2m deep.
//
// THE CAUSE. attachLamps stores the emissive mesh's bounding-sphere centre as
// `offset`, and worldPosOf did:
//
//     worldPos(obj) + offset.applyQuaternion(worldQuat(obj))
//
// correct for a rigid object with a small local offset. But a SkinnedMesh's
// node sits at the body root while its vertices are in BIND-POSE coordinates,
// so that centre is an ABSOLUTE (0, 1.47, 0.0155) -- the full height off the
// floor. Rotating a 1.47m vector by body yaw rides the light around an arc.
// Yaw hid the worst of it (the offset is nearly vertical); a pitched body
// would throw the light clear of the body entirely.
//
// Uses a REAL THREE.Skeleton, not a stub: the defect is in the interaction
// between bind-space geometry and bone matrices, and a stub skeleton would
// have let the broken form pass.
import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register();
HTMLCanvasElement.prototype.getContext = function () { const a = new Proxy(function () {}, { get: (_t, k) => (k === 'width' ? 100 : a), apply: () => a, set: () => true }); return new Proxy({}, { get: (_t, k) => (k === 'measureText' ? () => ({ width: 100 }) : a), set: () => true }); };
import { plugin } from 'bun';
const HERE = import.meta.dir; const here = (p) => `${HERE}/${p.replace(/^\.\//, '')}`;
plugin({ name: 'core-stub', setup(build) {
  build.onResolve({ filter: /^\.\/core\.js$/ }, () => ({ path: here('./core-stub.mjs') }));
  build.onResolve({ filter: /^\.\/base\.js$/ }, () => ({ path: here('./core-stub.mjs') }));
  build.onResolve({ filter: /^\.\/assets\.js$/ }, () => ({ path: here('./assets-stub.mjs') }));
  build.onResolve({ filter: /^\.\/loadwork\.js$/ }, () => ({ path: here('./loadwork-stub.mjs') }));
} });
// the rig's own THREE, so Skeleton/Bone are the same classes it tests against
const { THREE } = await import('./core-stub.mjs');
const rig = await import('../client/lib/lightrig.js');

let pass = 0, fail = 0;
const check = (name, ok, note = '') => { if (ok) { pass++; console.log(`  ok    ${name}`); } else { fail++; console.log(`  FAIL  ${name}${note ? `  -- ${note}` : ''}`); } };

// A body-like rig: root on the floor, chest bone at y=1.47, lamp geometry
// authored in BIND space the way the VRM's is (absolute, not relative).
// The bulb in BIND space: the chest bone's rest position plus the real
// measured 1.55cm forward offset. Absolute, the way the VRM authors it.
const CHEST_REST = new THREE.Vector3(0.012 - 0.004 + 0.006, 1.0 + 0.24 + 0.23, -0.035 + 0.018 - 0.009);
const BULB = CHEST_REST.clone().add(new THREE.Vector3(0, 0, 0.0155));
function makeBody() {
  const root = new THREE.Group(); root.name = 'bodyRoot';
  // VRM0 faces -Z and the importer flips the scene node 180 degrees about Y
  // (VRMUtils.rotateVRM0), so the mesh node's world rotation is NOT the
  // identity even on a standing body. That flip is half of why the old math
  // drifted, and a test rig without it cannot show the defect.
  const scene0 = new THREE.Group(); scene0.name = 'vrmScene';
  scene0.rotation.set(0, Math.PI, 0);
  root.add(scene0);
  // A REAL spine is not a straight vertical line: each joint carries its own
  // rest offset, so the chest bone does not sit directly above the root and
  // rotating the body moves bone and bind-offset along DIFFERENT arcs. The
  // first cut of this test used a perfectly axial two-bone chain, where a pure
  // yaw rotates both identically -- the old math passed, and the control could
  // not fail. These offsets are what make the two disagree.
  const hips = new THREE.Bone(); hips.position.set(0.012, 1.0, -0.035); hips.name = 'Hips';
  const spine = new THREE.Bone(); spine.position.set(-0.004, 0.24, 0.018); spine.name = 'Spine';
  const chest = new THREE.Bone(); chest.position.set(0.006, 0.23, -0.009); chest.name = 'Spine02';
  spine.add(chest); hips.add(spine); scene0.add(hips);
  const geo = new THREE.BufferGeometry();
  const verts = [], si = [], sw = [];
  for (const d of [[0, 0, 0], [0.02, 0, 0], [-0.02, 0, 0], [0, 0.02, 0]]) {
    verts.push(BULB.x + d[0], BULB.y + d[1], BULB.z + d[2]);
    si.push(2, 0, 0, 0); sw.push(1, 0, 0, 0);     // joint 2 == chest, weight 1
  }
  geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
  geo.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(si, 4));
  geo.setAttribute('skinWeight', new THREE.Float32BufferAttribute(sw, 4));
  const mesh = new THREE.SkinnedMesh(geo, new THREE.MeshBasicMaterial());
  mesh.name = 'lamp';
  scene0.add(mesh);            // where the glTF importer parents it
  root.updateMatrixWorld(true);
  // joint order [hips, spine, chest] -> the geometry's skinIndex 2 is chest
  mesh.bind(new THREE.Skeleton([hips, spine, chest]));
  root.updateMatrixWorld(true);
  return { root, chest, mesh, scene0 };
}

const { root, chest, mesh, scene0 } = makeBody();
rig.requestLight('lamp:test:0', { obj: mesh, offset: BULB.clone(), keep: true, intensity: 8, range: 10, shadows: true });
const lampPos = () => rig.rigDebug()._slots[0].position;
const at = (rx, ry, t) => { root.rotation.set(rx, ry, 0); root.updateMatrixWorld(true); rig.updateRig(t); return lampPos().clone(); };

console.log('LAMP IN A SKINNED BODY — yaw');
const sweep = [0, 45, 90, 135, 180, 225, 270].map((d, i) => at(0, d * Math.PI / 180, 1000 + i * 700));
const xs = sweep.map((p) => p.x), zs = sweep.map((p) => p.z), ys = sweep.map((p) => p.y);
// The bulb IS 1.55cm in front of its bone, so it legitimately rotates through
// a 3.1cm circle. What it must not do is ride the 1.47m arc.
const xSweep = Math.max(...xs) - Math.min(...xs);
const zSweep = Math.max(...zs) - Math.min(...zs);
check('x sweep is the bulb-to-bone offset (~3cm), not a 1.47m arc', xSweep < 0.05,
  `x sweep ${xSweep.toFixed(4)} m`);
check('z sweep likewise', zSweep < 0.05, `z sweep ${zSweep.toFixed(4)} m`);
check('height is constant under yaw', Math.max(...ys) - Math.min(...ys) < 1e-6,
  `y ${Math.min(...ys).toFixed(4)}..${Math.max(...ys).toFixed(4)}`);
check('the bulb stays at chest height', Math.abs(ys[0] - BULB.y) < 1e-6, `y=${ys[0]} want ${BULB.y.toFixed(4)}`);

console.log('LAMP IN A SKINNED BODY — pitch (limp, ragdolling, flying)');
// This is the case yaw was hiding: rotating a 1.47m vector by a 90-degree
// pitch puts the light a metre from the body.
const p90 = at(Math.PI / 2, 0, 9000);
const bone = chest.getWorldPosition(new THREE.Vector3());
const d = p90.distanceTo(bone);
check('the bulb stays with its BONE when pitched 90 degrees', d < 0.05,
  `bulb ${d.toFixed(4)} m from the chest bone at (${bone.x.toFixed(3)}, ${bone.y.toFixed(3)}, ${bone.z.toFixed(3)})`);
// THE CONTROL, stated carefully. The old math was
//     worldPos(node) + offset.applyQuaternion(worldQuat(node))
// and its damage depends on where the NODE is. On the real VRM the skinned
// mesh node sits at the body ROOT (the glTF importer parents every skinned
// primitive there), so worldPos(node) is the feet and the rotated 1.47m offset
// swings the light around them. This synthetic body must reproduce THAT
// arrangement or the control proves nothing -- and in the first cut it did
// not: the mesh was a child of the rotating root, so the old math happened to
// land 15mm away and the control failed honestly.
//
// So: measure against a node that is where the importer puts it.
// THE CONTROL, and it took three tries to state honestly.
//
// For a RIGID body under one rotation the old math and the bone math AGREE to
// within the bulb's own 1.55cm offset -- the mesh node and the bones ride the
// same transform, so rotating the bind-space centre gives the right answer by
// coincidence. Two earlier versions of this control asserted a large error
// under yaw and under pitch, and both failed correctly; the rig was not the
// problem, my claim was.
//
// The old math diverges when the BONES MOVE RELATIVE TO THE BODY -- i.e. an
// actual pose. That is the live case: Mythos breathes, walks, and flaps, and
// his chest bone is driven every frame. A bind-space offset cannot see any of
// it, so the light stays pinned to the rest pose while the body moves around
// it. That is the directional bias Janus saw.
root.rotation.set(0, 0.6, 0);
chest.rotation.set(0.35, 0.25, -0.2);      // a posed chest, as breathing gives
chest.position.set(0.006 + 0.05, 0.23 + 0.04, -0.009 - 0.03);
root.updateMatrixWorld(true);
rig.updateRig(15000);
const posedBone = chest.getWorldPosition(new THREE.Vector3());
const posedLight = lampPos().clone();
check('a POSED chest still carries its lamp', posedLight.distanceTo(posedBone) < 0.05,
  `bulb ${posedLight.distanceTo(posedBone).toFixed(4)} m from the posed chest bone`);
const oldWay = mesh.getWorldPosition(new THREE.Vector3())
  .add(BULB.clone().applyQuaternion(mesh.getWorldQuaternion(new THREE.Quaternion())));
check('...and the bind-rotate math would have left it behind', oldWay.distanceTo(posedBone) > 0.06,
  `old math lands ${oldWay.distanceTo(posedBone).toFixed(4)} m from the bone — the control`);

console.log('LAMP IN A SKINNED BODY — the bone drives it');
// move the CHEST alone: the light must follow the bone, not the root
root.rotation.set(0, 0, 0); root.updateMatrixWorld(true); rig.updateRig(12000);
const before = lampPos().clone();
chest.position.y += 0.30; root.updateMatrixWorld(true); rig.updateRig(13000);
const after = lampPos().clone();
check('raising the chest bone 30cm raises the light 30cm', Math.abs((after.y - before.y) - 0.30) < 1e-3,
  `moved ${(after.y - before.y).toFixed(4)} m`);

console.log('THE POSITION NUDGE — forward/up/side, in the bone\'s frame');
// Janus thought `dist` was moving the light up and down. It never did (it only
// divides into normalBias), but normalBias offsets along each surface's NORMAL,
// and on a torso those point mostly up -- so raising it pushes shadows up and
// off exactly as though the bulb had risen. There was no position dial; this
// is it.
root.rotation.set(0, 0, 0);
chest.rotation.set(0, 0, 0);
chest.position.set(0.006, 0.23, -0.009);
root.updateMatrixWorld(true);
rig.setLampShadow({ forward: 0, up: 0, side: 0 });
rig.updateRig(20000);
const base = lampPos().clone();
rig.setLampShadow({ forward: 0.10 });
rig.updateRig(21000);
const fwd = lampPos().clone();
// WHAT THIS CAN AND CANNOT CHECK. `forward` maps to -z in the BONE frame,
// measured off the real rig: L_Eye/R_Eye sit at z = -0.085 relative to Head, so
// the face looks down -z in bind space (assets.js calls VRMUtils.rotateVRM0
// afterwards, flipping the SCENE node so the body faces +z in the world -- but
// the nudge is applied inside the bone's frame, upstream of that).
//
// This synthetic skeleton has no eye bones and its own axis convention, so
// asserting a world-space SIGN here would be pinning the stub's geometry, not
// the product's. (My first cut did exactly that, twice: once claiming +z and
// once claiming -z, and the check flipped with the code instead of holding it
// still.) What IS checkable here, and is what the dial promises: forward moves
// the bulb along the bone's z by the requested MAGNITUDE, touches no other
// axis, and reads back as the positive number that was asked for.
check('forward moves the bulb along the bone z axis by the amount asked',
  Math.abs(Math.abs(fwd.z - base.z) - 0.10) < 1e-3 && Math.abs(fwd.y - base.y) < 1e-3,
  `moved dz=${(fwd.z - base.z).toFixed(4)} dy=${(fwd.y - base.y).toFixed(4)}`);
check('...and reads back as +0.10 forward, whatever the internal sign',
  Math.abs(rig.lampShadowState().forward - 0.10) < 1e-6,
  `reported forward=${rig.lampShadowState().forward}`);
rig.setLampShadow({ forward: 0, up: 0.07 });
rig.updateRig(22000);
const upp = lampPos().clone();
check('up moves the bulb along +y only (up is unambiguous)',
  Math.abs((upp.y - base.y) - 0.07) < 1e-3 && Math.abs(upp.z - base.z) < 1e-3,
  `moved dy=${(upp.y - base.y).toFixed(4)} dz=${(upp.z - base.z).toFixed(4)}`);
check('forward and up are independent dials', Math.abs(fwd.y - base.y) < 1e-3,
  'forward changed the height too');
// THE POINT of applying it in the bone's frame: a world-space offset would
// swing relative to the chest as the body turns, which is the defect this
// whole thread began with.
rig.setLampShadow({ forward: 0.10, up: 0, side: 0 });
const rel = [];
for (const [i, deg] of [0, 90, 180, 270].entries()) {
  root.rotation.set(0, deg * Math.PI / 180, 0);
  root.updateMatrixWorld(true);
  rig.updateRig(23000 + i * 500);
  rel.push(lampPos().clone().sub(chest.getWorldPosition(new THREE.Vector3())).length());
}
const spread = Math.max(...rel) - Math.min(...rel);
check('the nudge rides the bone through a full turn', spread < 1e-3,
  `bulb-to-bone distance varied ${spread.toFixed(5)} m across 0/90/180/270`);
rig.setLampShadow({ forward: 0, up: 0, side: 0 });

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
