// landmarks — where a named contact point actually IS on a particular body.
//
// shared/contact.js says "the top of the head" and which way that is. This
// finds the millimetre, per avatar, by asking the mesh.
//
// It casts a ray from outside the body toward the bone and takes the first surface it meets: the surface a hand would
// actually meet. Not a statistic over the bone's skinned vertices (a stray vertex below the visible mass gives a
// confident wrong number). A cast also yields a NORMAL, which a contact point needs as much as a position.
//
// Two rules:
//   - measure in the REST pose, never the live one;
//   - store the answer in the BONE's local space, so it follows the body for free.

import { THREE } from '../core.js';
import { CONTACT_POINTS, contactSeed } from '../../../shared/contact.js';
import { bodyFrame, fromBody } from '../../../shared/joints.js';

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
  // humanoid.update() is NOT optional: the mesh is skinned to the RAW rig, which three-vrm writes from the normalized
  // one inside update(); without it rays are cast at a T-pose skeleton the mesh is not wearing.
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
    // ⚠ AND recompute the skinning: three refreshes Skeleton.boneMatrices only at DRAW time, so without this a cast
    // aimed at a rest-pose bone meets a mesh still skinned to the last rendered pose (deriving inside a frame, as the
    // first contactAt() in a reach does, would disagree with a console derivation).
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

    // A body's own size sets how far to stand back and how far a fallback point sits off the bone (never fixed metres).
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
        // ⚠ SIGN. The ray travels along -dir (from outside, inward), so a surface facing OUT of the body has its normal
        // along +dir. A normal along -dir means the ray began inside the mesh (an accessory wrapping the cast origin):
        // only those flip.
        if (normal.dot(dir) < 0) normal.negate();
        how = seed.estimated ? 'fallback' : 'surface';
      } else {
        // No surface on that line (a concave region): sit proportionally off the bone and SAY it was a fallback.
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

/** Draw every landmark as a pip with a normal whisker, so a person can LOOK at them: the derivation cannot check
 *  itself. Colour is by tier (social green, familiar amber, intimate red); a FALLBACK point is white, so a guess
 *  doesn't look like a measurement. */
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
 * The collision model's torsoRadius is a half-WIDTH (0.42× the wider of shoulder or hip span), and a capsule is
 * isotropic, so a forearm crossing in FRONT of the belly reads as inside the body. This asks the mesh how deep it is.
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
