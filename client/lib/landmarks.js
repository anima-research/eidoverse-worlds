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
import { CONTACT_POINTS, contactSeed } from '../../shared/contact.js';
import { bodyFrame, fromBody } from '../../shared/joints.js';

const _v = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _m = new THREE.Matrix3();
const _ray = new THREE.Raycaster();

/** Every drawable with geometry under a scene. */
function meshesOf(scene) {
  const out = [];
  scene.traverse((o) => { if ((o.isMesh || o.isSkinnedMesh) && o.geometry) out.push(o); });
  return out;
}

// Raycast bounds are pose-dependent too. Updating the skeleton alone leaves
// cached bounds from the last frame, which can reject valid rest-pose hits.
function refreshBounds(scene, saved) {
  for (const mesh of meshesOf(scene)) {
    if (!mesh.isSkinnedMesh) continue;
    saved.push([mesh, mesh.boundingSphere, mesh.boundingBox]);
    mesh.skeleton.update();
    mesh.boundingSphere = null;
    mesh.boundingBox = null;
    mesh.computeBoundingSphere();
  }
}
function restoreBounds(saved) {
  for (const [mesh, sphere, box] of saved) {
    mesh.boundingSphere = sphere;
    mesh.boundingBox = box;
  }
}

/** A short fan of rays near the intended anatomical site. Never accept the
 * far side of the body when a ray misses a thin hand or forearm. Prefer the
 * central ray; nearby rays rescue gaps without averaging points into air. */
function localSurface(meshes, at, dir, radius) {
  const tangent = new THREE.Vector3(0, 1, 0);
  if (Math.abs(tangent.dot(dir)) > 0.9) tangent.set(1, 0, 0);
  tangent.cross(dir).normalize();
  const bitangent = dir.clone().cross(tangent);
  for (const [u, v] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]]) {
    const aim = at.clone().addScaledVector(tangent, u * radius * 0.12)
      .addScaledVector(bitangent, v * radius * 0.12);
    _ray.set(aim.addScaledVector(dir, radius), dir.clone().negate());
    _ray.near = 0;
    _ray.far = radius * 1.15;
    _ray.firstHitOnly = false;
    // meshesOf already flattened the hierarchy: recursion visits children twice.
    const hit = _ray.intersectObjects(meshes, false).find((h) =>
      h.distance > 1e-4 && h.point.distanceTo(at) <= radius);
    if (hit) return hit;
  }
  return null;
}

/** The source contact is the palm surface, not the wrist pivot. If a rig
 * cannot supply a surface, leave the correction unavailable. */
export function derivePalmAnchor(avatar, side) {
  const marks = deriveLandmarks(avatar, { palm: {
    bone: side + 'Hand', toward: side + 'MiddleProximal', along: 0.55,
    extendFrom: side + 'LowerArm',
    from: [0, -1, 0], radius: 0.22, tier: 'social',
  } });
  const mark = marks.get('palm');
  return mark?.how === 'surface' ? mark : null;
}

/**
 * Derive every contact point for one avatar. Call once per body.
 * @returns {Map<string, {bone: string, node: object, offset: THREE.Vector3,
 *          normal: THREE.Vector3, tier: string, how: 'surface'|'fallback'}>}
 */
export function deriveLandmarks(avatar, specs = CONTACT_POINTS) {
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
  const bounds = [];
  const out = new Map();
  try {
    h.update();
    avatar.root.updateMatrixWorld(true);
    refreshBounds(scene, bounds);
    // ⚠ AND the skinning has to be recomputed, or the rays are cast at one
    // pose and hit another.
    //
    // three only refreshes Skeleton.boneMatrices at DRAW time. Posing the rig
    // and calling updateMatrixWorld moves the bones but leaves those matrices
    // describing the last RENDERED pose — so a cast aimed at a rest-pose bone
    // meets a mesh still skinned to the idle pose. Deriving from the console
    // (after a render) hides it; deriving inside a frame, which is what the
    // first contactAt() in a reach does, does not.
    //
    // On claude the idle and rest poses are close enough that the answers
    // agreed and this looked fine for a day. On orion they are not: hip_l came
    // out ABOVE the shoulder, the reach dutifully raised the arm to it, and
    // the landmark table dumped afterwards from the console read perfectly
    // correct — the two derivations disagreeing was the whole bug.
    for (const o of meshesOf(scene)) o.skeleton?.update?.();
    const P = {};
    for (const name of Object.keys(h.humanBones ?? {})) {
      const n = h.getNormalizedBoneNode(name);
      if (n) P[name] = n.getWorldPosition(new THREE.Vector3()).toArray();
    }
    const F = bodyFrame(P);
    if (!F) return out;

    const meshes = meshesOf(scene);
    if (!meshes.length) return out;

    // A body's own size sets both how far to stand back and how far a
    // fallback point sits off the bone — hardcoding metres is the seat bug in
    // another costume.
    const hips = P.hips ? new THREE.Vector3(...P.hips) : null;
    const head = P.head ? new THREE.Vector3(...P.head) : null;
    const scale = (hips && head) ? Math.max(0.2, head.distanceTo(hips)) : 0.6;

    for (const [name, spec] of Object.entries(specs)) {
      const node = h.getNormalizedBoneNode(spec.bone);
      if (!node) continue;
      const seed = contactSeed(P, spec, F, scale);
      if (!seed) continue;
      const at = new THREE.Vector3(...seed.at);
      const radius = scale * (spec.radius ?? 0.45);
      const dirArr = fromBody(spec.from, F);
      const dir = new THREE.Vector3(dirArr[0], dirArr[1], dirArr[2]);
      if (dir.lengthSq() < 1e-9) continue;
      dir.normalize();

      const hit = localSurface(meshes, at, dir, radius);

      let point, normal, how;
      if (hit) {
        point = hit.point.clone();
        normal = hit.face
          ? hit.face.normal.clone().applyMatrix3(_m.getNormalMatrix(hit.object.matrixWorld)).normalize()
          : dir.clone();
        // ⚠ SIGN. The ray travels along -dir (from outside, inward), so a
        // surface facing OUT of the body has its normal along +dir — back the
        // way the ray came. This test used to negate exactly those, which
        // inverted every landmark normal in the table.
        //
        // It went unnoticed because nothing consumed the normal until the palm
        // did, and then it was wrong in the one way that is hard to see: the
        // hand still arrived at the right PLACE, just turned inside out. antra
        // caught it on head_top, where a palm facing the sky is unmistakable —
        // on a shoulder or a hip the same error reads as merely an awkward
        // wrist.
        //
        // A normal pointing along -dir means the ray began inside the mesh (an
        // accessory wrapping the cast origin); THOSE are the ones to flip.
        if (normal.dot(dir) < 0) normal.negate();
        how = seed.estimated ? 'fallback' : 'surface';
      } else {
        // No surface on that line: a concave region, or a body with nothing
        // there. Sit proportionally off the bone and SAY it was a fallback,
        // so a caller can tell a measured point from a guessed one.
        point = at.clone().addScaledVector(dir, Math.min(scale * 0.18, radius * 0.5));
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
    restoreBounds(bounds);
    for (const [n, q] of saved) n.quaternion.copy(q);
    h.update();
    avatar.root.updateMatrixWorld(true);
    for (const o of meshesOf(scene)) o.skeleton?.update?.();
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

/**
 * How deep the torso actually is, measured — half-depth front-to-back at chest
 * height, in metres.
 *
 * The collision model inherits torsoRadius from the ragdoll, which is 0.42x
 * the wider of shoulder or hip span: a half-WIDTH. A capsule is isotropic, so
 * that number silently becomes the half-depth too, and a forearm crossing in
 * FRONT of the belly — exactly what reaching your opposite hip requires — reads
 * as inside the body. Bodies are not round. This asks the mesh how deep this
 * one is, the same way the contact points ask it where its shoulder is.
 *
 * Returns null if it cannot be measured, so a caller can fall back rather than
 * silently use a guess.
 */
export function torsoHalfDepth(avatar) {
  const h = avatar?.vrm?.humanoid;
  const scene = avatar?.vrm?.scene;
  if (!h || !scene) return null;
  const saved = [];
  for (const name of Object.keys(h.humanBones ?? {})) {
    const n = h.getNormalizedBoneNode(name);
    if (n) { saved.push([n, n.quaternion.clone()]); n.quaternion.identity(); }
  }
  const bounds = [];
  try {
    h.update();
    avatar.root.updateMatrixWorld(true);
    refreshBounds(scene, bounds);
    const meshes = meshesOf(scene);
    if (!meshes.length) return null;
    for (const o of meshes) o.skeleton?.update?.();
    const P = {};
    for (const name of Object.keys(h.humanBones ?? {})) {
      const n = h.getNormalizedBoneNode(name);
      if (n) P[name] = n.getWorldPosition(new THREE.Vector3()).toArray();
    }
    const F = bodyFrame(P);
    const chest = P.chest ?? P.spine;
    if (!F || !chest) return null;
    const at = new THREE.Vector3(...chest);
    const fwd = new THREE.Vector3(...fromBody([0, 0, 1], F)).normalize();
    const reach = 3 * Math.max(0.2, Math.hypot(
      (P.head?.[0] ?? 0) - chest[0], (P.head?.[1] ?? 0) - chest[1], (P.head?.[2] ?? 0) - chest[2]));
    const hitAt = (dir) => {
      _ray.near = 0; _ray.far = reach * 1.15;
      _ray.set(_v.copy(at).addScaledVector(dir, reach), dir.clone().negate());
      const hits = _ray.intersectObjects(meshes, true);
      const hit = hits.find((x) => x.point && x.distance > 1e-4);
      return hit ? hit.point.distanceTo(at) : null;
    };
    const front = hitAt(fwd), back = hitAt(fwd.clone().negate());
    if (front == null && back == null) return null;
    // the spine does not sit centred front-to-back, so take the mean of the
    // two surfaces rather than either one
    const d = (front != null && back != null) ? (front + back) / 2 : (front ?? back);
    return d > 1e-3 ? d : null;
  } finally {
    restoreBounds(bounds);
    for (const [n, q] of saved) n.quaternion.copy(q);
    h.update();
    avatar.root.updateMatrixWorld(true);
    for (const o of meshesOf(scene)) o.skeleton?.update?.();
  }
}
