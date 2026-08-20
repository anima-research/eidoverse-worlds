// landmarks — where a named contact point actually IS on a particular body.
//
// shared/contact.js says "the top of the head" and which way that is. This
// finds the millimetre, per avatar, by asking the mesh.
//
// It casts a ray from outside the body toward the bone and takes the first
// surface it meets. That is deliberately NOT the obvious method. The obvious
// method is a statistic over the skinned vertices that belong to a bone —
// lowest, outermost, mean — and that is exactly the reader that got the
// seated pelvis wrong (#seat): it locked onto a vertex hanging below the
// visible mass and reported a confident number 0.2m from the truth, and
// because the number was then VERIFIED with the same reader, derivation and
// verification agreed perfectly while both were wrong.
//
// A cast has a property no vertex statistic has: it returns the surface a
// hand would actually meet, because that is the same question. A stray vertex
// inside the body is not on the ray; a stray vertex outside it gets hit, which
// is visible rather than silent. And it yields a NORMAL, which a contact point
// needs as much as a position — a palm on a shoulder has to lie along the
// surface, and without one hands go through people.
//
// Two rules this file obeys, both learned expensively:
//   - measure in the REST pose, never the live one;
//   - store the answer in the BONE's local space, so it follows the body for
//     free and is never re-derived from a moving skeleton.

import { THREE } from './core.js';
import { CONTACT_POINTS } from '../../shared/contact.js';
import { bodyFrame, fromBody } from '../../shared/joints.js';

const _v = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _m = new THREE.Matrix3();
const _ray = new THREE.Raycaster();

/**
 * Derive every contact point for one avatar. Call once per body.
 * @returns {Map<string, {bone: string, node: object, offset: THREE.Vector3,
 *          normal: THREE.Vector3, tier: string, how: 'surface'|'fallback'}>}
 */
export function deriveLandmarks(avatar) {
  const h = avatar?.vrm?.humanoid;
  const scene = avatar?.vrm?.scene;
  if (!h || !scene) return new Map();

  // ---- rest pose, and put it back afterwards whatever happens.
  //
  // humanoid.update() is NOT optional here, and leaving it out is a trap that
  // looks like it works: identity-ing the NORMALIZED bones and calling
  // updateMatrixWorld refreshes the normalized hierarchy only. The mesh is
  // skinned to the RAW rig, which three-vrm writes from the normalized one
  // inside humanoid.update() — so without it the bones are in a T-pose while
  // the geometry is still wherever the idle clip left it, and rays are cast at
  // a skeleton the mesh is not wearing. Measured on the claude rig: the left
  // hand bone stood 0.12m beyond ANY geometry, every hand cast missed, and the
  // ray sailed on to hit the far side of the torso. The fallback flag is what
  // made that visible instead of a plausible wrong number.
  const saved = [];
  for (const name of Object.keys(h.humanBones ?? {})) {
    const n = h.getNormalizedBoneNode(name);
    if (n) { saved.push([n, n.quaternion.clone()]); n.quaternion.identity(); }
  }
  h.update();
  avatar.root.updateMatrixWorld(true);

  const out = new Map();
  try {
    const P = {};
    for (const name of Object.keys(h.humanBones ?? {})) {
      const n = h.getNormalizedBoneNode(name);
      if (n) P[name] = n.getWorldPosition(new THREE.Vector3()).toArray();
    }
    const F = bodyFrame(P);
    if (!F) return out;

    const meshes = [];
    scene.traverse((o) => { if ((o.isMesh || o.isSkinnedMesh) && o.geometry) meshes.push(o); });
    if (!meshes.length) return out;

    // A body's own size sets both how far to stand back and how far a
    // fallback point sits off the bone — hardcoding metres is the seat bug in
    // another costume.
    const hips = P.hips ? new THREE.Vector3(...P.hips) : null;
    const head = P.head ? new THREE.Vector3(...P.head) : null;
    const scale = (hips && head) ? Math.max(0.2, head.distanceTo(hips)) : 0.6;
    const standBack = scale * 3;

    for (const [name, spec] of Object.entries(CONTACT_POINTS)) {
      const node = h.getNormalizedBoneNode(spec.bone);
      if (!node) continue;
      const at = node.getWorldPosition(new THREE.Vector3());
      const dirArr = fromBody(spec.from, F);
      const dir = new THREE.Vector3(dirArr[0], dirArr[1], dirArr[2]);
      if (dir.lengthSq() < 1e-9) continue;
      dir.normalize();

      _ray.set(_v.copy(at).addScaledVector(dir, standBack), dir.clone().negate());
      _ray.firstHitOnly = true;
      const hits = _ray.intersectObjects(meshes, true);
      // The first hit is the OUTERMOST surface along the approach, which is
      // the one a hand meets. Later hits are the far side of the body.
      const hit = hits.find((x) => x.point && x.distance > 1e-4) ?? null;

      let point, normal, how;
      if (hit) {
        point = hit.point.clone();
        normal = hit.face
          ? hit.face.normal.clone().applyMatrix3(_m.getNormalMatrix(hit.object.matrixWorld)).normalize()
          : dir.clone();
        // A back-facing hit means the ray started INSIDE the mesh (an
        // accessory wrapping the cast origin). Flip it rather than hand back
        // a normal pointing into the body.
        if (normal.dot(dir) > 0) normal.negate();
        how = 'surface';
      } else {
        // No surface on that line: a concave region, or a body with nothing
        // there. Sit proportionally off the bone and SAY it was a fallback,
        // so a caller can tell a measured point from a guessed one.
        point = at.clone().addScaledVector(dir, scale * 0.18);
        normal = dir.clone();
        how = 'fallback';
      }

      out.set(name, {
        bone: spec.bone, node, tier: spec.tier, how,
        offset: node.worldToLocal(point.clone()),
        normal: normal.clone().applyQuaternion(_q.copy(node.getWorldQuaternion(_q)).invert()),
      });
    }
  } finally {
    for (const [n, q] of saved) n.quaternion.copy(q);
    h.update();
    avatar.root.updateMatrixWorld(true);
  }
  return out;
}

/** Where a landmark is NOW, in world space, with the surface normal it sits
 *  on. `standoff` lifts the point off the skin so a hand rests on it instead
 *  of inside it — in metres, and the caller's choice because a fingertip and
 *  a palm are different distances. */
export function landmarkWorld(entry, standoff = 0, outPos = new THREE.Vector3(), outNormal = new THREE.Vector3()) {
  if (!entry?.node) return null;
  outPos.copy(entry.offset);
  entry.node.localToWorld(outPos);
  outNormal.copy(entry.normal).applyQuaternion(entry.node.getWorldQuaternion(_q)).normalize();
  if (standoff) outPos.addScaledVector(outNormal, standoff);
  return { pos: outPos, normal: outNormal };
}

/** Draw every landmark as a pip with a normal whisker, so a person can LOOK
 *  at them. This exists because the derivation cannot check itself: the seat
 *  bug passed every arithmetic test it had, and what finally caught it was
 *  antra's eye. Colour is by tier (social green, familiar amber, intimate
 *  red) and a FALLBACK point is drawn white — an unmeasured guess should not
 *  look like a measurement. */
export function debugMarkers(avatar, marks, scene, on = true) {
  const key = '__landmarkDebug';
  let group = avatar.root.getObjectByName(key);
  if (group) { group.parent.remove(group); group.traverse((o) => { o.geometry?.dispose?.(); o.material?.dispose?.(); }); }
  if (!on) return null;

  group = new THREE.Group();
  group.name = key;
  const TIER = { social: 0x44dd66, familiar: 0xffaa22, intimate: 0xff3344 };
  for (const [name, e] of marks) {
    const hit = landmarkWorld(e, 0);
    if (!hit) continue;
    const colour = e.how === 'fallback' ? 0xffffff : (TIER[e.tier] ?? 0x8888ff);
    const pip = new THREE.Mesh(
      new THREE.SphereGeometry(0.012, 10, 8),
      new THREE.MeshBasicMaterial({ color: colour, depthTest: false }));
    pip.position.copy(hit.pos);
    pip.renderOrder = 999;
    pip.name = `lm:${name}`;
    group.add(pip);

    const end = hit.pos.clone().addScaledVector(hit.normal, 0.045);
    const line = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([hit.pos.clone(), end]),
      new THREE.LineBasicMaterial({ color: colour, depthTest: false }));
    line.renderOrder = 999;
    group.add(line);
  }
  scene.add(group);
  return group;
}
