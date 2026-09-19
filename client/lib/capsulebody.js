// capsulebody — the body you get when no body loads (R, 09-11: "capsule avatar + hand capsules", assigned to
// the VR PR; 09-19: arrived bodiless behind a flapping tunnel — "I thought we fixed this").
//
// Not a bare mesh: a VRM-SHAPED puppet. A synthetic humanoid skeleton (hips → spine → chest → upperChest →
// neck → head; shoulders → upperArm → lowerArm → hand, both sides) with a capsule on each bone, wrapped as
// the four things the Avatar class asks of a vrm — `scene`, `humanoid.getNormalizedBoneNode/getRawBoneNode`,
// `update(dt)`, and a tolerated absence of lookAt/expressions/springbones. So it is a real Avatar: it takes
// the label, the emote bar, the ragdoll, the XR arm solver (hand capsules land on the controllers) and the
// C18 wire without a single consumer learning a new case. Its proportions are the ones armsolve-test
// proves the solver on.
import { THREE } from './core.js';

const BRAND = 0x8fe8c8;   // --brand; the same green as the ∃
const H = 1.62;           // eye height ≈ 1.52: the puppet is sized like the default body so DeviceScale reads sane

function capsule(len, r, color, opacity = 0.92) {
  const g = new THREE.CapsuleGeometry(r, Math.max(0.01, len - 2 * r), 4, 10);
  const m = new THREE.MeshStandardMaterial({ color, roughness: 0.55, metalness: 0.05, transparent: opacity < 1, opacity });
  const mesh = new THREE.Mesh(g, m);
  mesh.castShadow = true; mesh.receiveShadow = false;
  return mesh;
}
/** A capsule lying along +Y from the bone's origin (Capsule is Y-centred, so shift by half) */
function alongY(bone, len, r, color, opacity) { const c = capsule(len, r, color, opacity); c.position.y = len / 2; bone.add(c); return c; }
/** A capsule lying along the bone's local +X (arms) or −X (mirror) */
function alongX(bone, len, r, color, sign, opacity) { const c = capsule(len, r, color, opacity); c.rotation.z = -sign * Math.PI / 2; c.position.x = sign * len / 2; bone.add(c); return c; }

export function makeCapsuleVrm() {
  const scene = new THREE.Group(); scene.name = 'capsule-body';
  const mk = (name, x, y, z, parent) => { const b = new THREE.Bone(); b.name = name; b.position.set(x, y, z); parent.add(b); return b; };
  const bones = {};
  bones.hips = mk('hips', 0, 0.93, 0, scene);
  bones.spine = mk('spine', 0, 0.10, 0, bones.hips);
  bones.chest = mk('chest', 0, 0.12, 0, bones.spine);
  bones.upperChest = mk('upperChest', 0, 0.12, 0, bones.chest);
  bones.neck = mk('neck', 0, 0.13, 0, bones.upperChest);
  bones.head = mk('head', 0, 0.08, 0, bones.neck);
  // torso: one tall capsule from hips to the base of the neck, drawn on the hips bone (the latch yaws it)
  alongY(bones.hips, 0.47, 0.15, BRAND, 0.85);
  // head: a sphere-ish capsule; the eyes are two dark dots so a viewer can tell which way it faces
  const head = alongY(bones.head, 0.24, 0.11, BRAND, 0.95);
  for (const s of [-1, 1]) { const e = capsule(0.02, 0.014, 0x0f2024, 1); e.position.set(s * 0.04, 0.14, 0.095); bones.head.add(e); }
  for (const side of ['left', 'right']) {
    const s = side === 'left' ? 1 : -1;
    bones[side + 'Shoulder'] = mk(side + 'Shoulder', s * 0.06, 0.10, 0, bones.upperChest);
    bones[side + 'UpperArm'] = mk(side + 'UpperArm', s * 0.11, 0, 0, bones[side + 'Shoulder']);
    bones[side + 'LowerArm'] = mk(side + 'LowerArm', s * 0.28, 0, 0, bones[side + 'UpperArm']);
    bones[side + 'Hand'] = mk(side + 'Hand', s * 0.26, 0, 0, bones[side + 'LowerArm']);
    alongX(bones[side + 'UpperArm'], 0.28, 0.045, BRAND, s, 0.9);
    alongX(bones[side + 'LowerArm'], 0.26, 0.04, BRAND, s, 0.9);
    alongX(bones[side + 'Hand'], 0.16, 0.045, BRAND, s, 0.95);   // the hand capsule — what the controller drives
    bones[side + 'UpperArm'].rotation.z = -s * 1.35;   // rest = arms at the sides, not a T-pose: there are no clips to lower them
    bones[side + 'UpperLeg'] = mk(side + 'UpperLeg', s * 0.09, -0.02, 0, bones.hips);
    bones[side + 'LowerLeg'] = mk(side + 'LowerLeg', 0, -0.42, 0, bones[side + 'UpperLeg']);
    bones[side + 'Foot'] = mk(side + 'Foot', 0, -0.42, 0, bones[side + 'LowerLeg']);
    const ul = alongY(bones[side + 'UpperLeg'], 0.42, 0.06, BRAND, 0.85); ul.position.y = -0.21;
    const ll = alongY(bones[side + 'LowerLeg'], 0.42, 0.05, BRAND, 0.85); ll.position.y = -0.21;
  }
  scene.updateMatrixWorld(true);
  const humanoid = {
    getNormalizedBoneNode: (n) => bones[n] ?? null,
    getRawBoneNode: (n) => bones[n] ?? null,
    normalizedHumanBones: Object.fromEntries(Object.entries(bones).map(([k, node]) => [k, { node }])),
  };
  // what three-vrm-animation's clip builder reads (createVRMAnimationHumanoidTracks): uniquely named bones,
  // the hips' rest height for the walk's root motion, and a VRM-1 meta so no 180° legacy flip is applied
  humanoid.normalizedRestPose = { hips: { position: [0, bones.hips.position.y, 0] } };
  return { scene, humanoid, meta: { name: 'capsule', metaVersion: '1' }, lookAt: null, expressionManager: null, springBoneManager: null,
    update() {}, isCapsuleBody: true, height: H };
}
