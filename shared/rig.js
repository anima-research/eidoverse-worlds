// CPU rig primitives for runtime body perception and physics.
// Inputs are GLB bytes or parsed node data; no I/O, fixture paths, corpus
// enumeration, renderer initialization or test dependencies live here.

/** The JSON chunk of a .glb / .vrm. */
export function glbJson(buf) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (dv.getUint32(0, true) !== 0x46546c67) throw new Error('not a GLB');
  let off = 12;
  while (off < dv.byteLength) {
    const len = dv.getUint32(off, true), type = dv.getUint32(off + 4, true);
    if (type === 0x4e4f534a) {
      return JSON.parse(new TextDecoder().decode(buf.subarray(off + 8, off + 8 + len)));
    }
    off += 8 + len + ((4 - (len % 4)) % 4);
  }
  throw new Error('no JSON chunk');
}

/** VRM0 normalized bones have a half-turn about Y relative to the root,
 * matching the browser's conversion from -Z-facing VRM0 to +Z-facing VRM1. */
export function isVrm0(g) {
  return !g.extensions?.VRMC_vrm && !!g.extensions?.VRM;
}

export function humanBones(g) {
  const v1 = g.extensions?.VRMC_vrm?.humanoid?.humanBones;
  if (v1) return Object.fromEntries(Object.entries(v1).map(([b, v]) => [b, v.node]));
  const v0 = g.extensions?.VRM?.humanoid?.humanBones;
  if (v0) {
    // Match three-vrm's VRM0 -> normalized VRM1 humanoid vocabulary. Keeping
    // the old thumb names shifts every thumb rotation onto the wrong joint.
    const rename = { leftThumbProximal: 'leftThumbMetacarpal', leftThumbIntermediate: 'leftThumbProximal',
      rightThumbProximal: 'rightThumbMetacarpal', rightThumbIntermediate: 'rightThumbProximal' };
    return Object.fromEntries(v0.map((h) => [rename[h.bone] ?? h.bone, h.node]));
  }
  return null;
}

// The humanoid parent chain the ragdoll's particle model assumes. Rigs that
// carry upperChest/shoulder collapse onto this: goLimp parks those bones at
// rest before the sim starts, which is what makes the span rigid.
export const PARENT = {
  hips: null, spine: 'hips', chest: 'spine', neck: 'chest', head: 'neck',
  leftUpperArm: 'chest', leftLowerArm: 'leftUpperArm', leftHand: 'leftLowerArm',
  rightUpperArm: 'chest', rightLowerArm: 'rightUpperArm', rightHand: 'rightLowerArm',
  leftUpperLeg: 'hips', leftLowerLeg: 'leftUpperLeg', leftFoot: 'leftLowerLeg',
  rightUpperLeg: 'hips', rightLowerLeg: 'rightUpperLeg', rightFoot: 'rightLowerLeg',
};

/** Bind the small vector/matrix API supplied by the host. This keeps shared
 * parsing free of package-layout assumptions; runtime and fixtures use their
 * own already-installed Three dependency. */
export function rigMath(THREE) {
  /** World rest position of any node, by walking the TRS tree. */
  function worldPositions(g) {
    const parent = new Map();
    g.nodes.forEach((n, i) => (n.children ?? []).forEach((c) => parent.set(c, i)));
    const memo = new Map();
    // Full matrices, because SCALE is load-bearing here. Composing only
    // translation and rotation (and reading a matrix node's translation column
    // while dropping its basis) silently drops any scale on an ancestor — and
    // glb2vrm bakes a uniform scale on the Armature to bring a ~1m Tripo export
    // to human height, so mythospaint's armature carries 1.651. The headless
    // skeleton came out 0.86m tall while the browser rendered her at 1.65m.
    // Bone quaternions are scale-free, so limbs still looked right and nothing
    // complained; only the streamed ROOT was in the small frame, which put her
    // ~0.46m — a foot and a half — above the floor for everyone watching.
    const localMatrix = (n) => (n.matrix
      ? new THREE.Matrix4().fromArray(n.matrix)
      : new THREE.Matrix4().compose(
        new THREE.Vector3(...(n.translation ?? [0, 0, 0])),
        new THREE.Quaternion(...(n.rotation ?? [0, 0, 0, 1])),
        new THREE.Vector3(...(n.scale ?? [1, 1, 1])),
      ));
    const world = (i) => {
      if (memo.has(i)) return memo.get(i);
      const m = localMatrix(g.nodes[i]);
      const p = parent.get(i);
      const out = p === undefined ? m : world(p).clone().multiply(m);
      memo.set(i, out);
      return out;
    };
    return (i) => new THREE.Vector3().setFromMatrixPosition(world(i));
  }

  /** Build private normalized bone nodes from world rest positions. */
  function makeAvatar(P, { realParent = null, vrm0 = false } = {}) {
    const root = new THREE.Object3D();
    // three-vrm's half-turn for VRM0, reproduced as a pivot the bones hang from,
    // so every normalized bone reads a 180° world rotation against the root
    // exactly as it does in the browser. Without it the harness silently models
    // a VRM1 body and any frame error on the other six goes unseen.
    const pivot = new THREE.Object3D();
    if (vrm0) pivot.rotation.y = Math.PI;
    root.add(pivot);
    const nodes = {};
    // `realParent` builds the rig's ACTUAL humanoid hierarchy — upperChest,
    // shoulders and all — so `d.parent` is the node the shipped rig would give.
    // Without it every rig is tested as though it were one of the simple ones.
    const par = realParent ?? PARENT;
    const order = Object.keys(realParent ? P : PARENT).filter((j) => P[j]);
    const depth = (j) => { let d = 0, k = j; while (par[k]) { k = par[k]; if (++d > 40) break; } return d; };
    order.sort((a, b) => depth(a) - depth(b));
    for (const j of order) {
      const n = new THREE.Object3D();
      n.name = j;
      const p = par[j];
      const base = p && P[p] ? P[p] : new THREE.Vector3(0, 0, 0);
      n.position.copy(P[j]).sub(base);
      ((p && nodes[p]) ? nodes[p] : pivot).add(n);
      nodes[j] = n;
    }
    root.updateMatrixWorld(true);

    const av = {
      root, nodes, poses: 0, limp: false,
      vrm: { meta: { metaVersion: vrm0 ? "0" : "1" }, humanoid: {
        normalizedRestPose: Object.fromEntries(Object.entries(nodes).map(([k, n]) => [k, { position: n.position.toArray(), rotation: [0, 0, 0, 1] } ])),
        humanBones: Object.fromEntries(Object.keys(nodes).map((k) => [k, {}])),
        getNormalizedBoneNode: (j) => nodes[j] ?? null,
      } },
      setPose() { this.poses++; },
      clearPose() {},
      setLimp(on) { this.limp = !!on; },
      restBonePositions() {
        const saved = Object.values(nodes).map((n) => [n, n.quaternion.clone()]);
        for (const [n] of saved) n.quaternion.identity();
        root.updateMatrixWorld(true);
        const out = {};
        for (const [k, n] of Object.entries(nodes)) out[k] = n.getWorldPosition(new THREE.Vector3());
        for (const [n, q] of saved) n.quaternion.copy(q);
        root.updateMatrixWorld(true);
        return out;
      },
    };

    return av;
  }
  return { worldPositions, makeAvatar };
}
