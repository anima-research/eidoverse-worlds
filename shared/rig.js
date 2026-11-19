// rig — CPU rig primitives for body perception and physics: GLB parsing, humanoid bone maps, and (given a THREE) a
// stand-in avatar built from rest positions. Inputs are GLB bytes or parsed node data; no I/O.

/** A VRM's JSON chunk is well under a megabyte for any real body; a header claiming more is refused unparsed. */
export const GLB_MAX_JSON = 16 * 1024 * 1024;
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

/** The humanoid map as bone name -> node index; an entry with no integer node (null, malformed) is skipped. */
export function humanBones(g) {
  const v1 = g.extensions?.VRMC_vrm?.humanoid?.humanBones;
  if (v1) return Object.fromEntries(Object.entries(v1).filter(([, v]) => Number.isInteger(v?.node)).map(([b, v]) => [b, v.node]));
  const v0 = g.extensions?.VRM?.humanoid?.humanBones;
  if (v0) {
    // Match three-vrm's VRM0 -> normalized VRM1 humanoid vocabulary. Keeping
    // the old thumb names shifts every thumb rotation onto the wrong joint.
    const rename = { leftThumbProximal: 'leftThumbMetacarpal', leftThumbIntermediate: 'leftThumbProximal',
      rightThumbProximal: 'rightThumbMetacarpal', rightThumbIntermediate: 'rightThumbProximal' };
    return Object.fromEntries((Array.isArray(v0) ? v0 : []).filter((h) => typeof h?.bone === 'string' && Number.isInteger(h.node))
      .map((h) => [rename[h.bone] ?? h.bone, h.node]));
  }
  return null;
}

// The humanoid parent chain the ragdoll's particle model assumes; rigs with upperChest/shoulders collapse onto it.
export const PARENT = {
  hips: null, spine: 'hips', chest: 'spine', neck: 'chest', head: 'neck',
  leftUpperArm: 'chest', leftLowerArm: 'leftUpperArm', leftHand: 'leftLowerArm',
  rightUpperArm: 'chest', rightLowerArm: 'rightUpperArm', rightHand: 'rightLowerArm',
  leftUpperLeg: 'hips', leftLowerLeg: 'leftUpperLeg', leftFoot: 'leftLowerLeg',
  rightUpperLeg: 'hips', rightLowerLeg: 'rightUpperLeg', rightFoot: 'rightLowerLeg',
};

/** The helpers that need vector maths, bound to the host's THREE (so this file imports none). */
export function rigMath(THREE) {
  /** World rest position of any node, by walking the TRS tree. */
  function worldPositions(g) {
    const world = worldMatrices(g);
    return (i) => new THREE.Vector3().setFromMatrixPosition(world(i));
  }

  /** World rest rotation of any node (the axes its own scale acts in; rarely aligned with the model's on a skinned rig). */
  function worldRotations(g) {
    const world = worldMatrices(g);
    return (i) => {
      const q = new THREE.Quaternion();
      world(i).decompose(new THREE.Vector3(), q, new THREE.Vector3());
      return q;
    };
  }

  function worldMatrices(g) {
    const parent = new Map();
    g.nodes.forEach((n, i) => (n.children ?? []).forEach((c) => parent.set(c, i)));
    const memo = new Map();
    // full matrices: an ancestor's SCALE matters (exporters bake one on the Armature to reach human height)
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
    return world;
  }

  /** Build private normalized bone nodes from world rest positions. */
  function makeAvatar(P, { realParent = null, vrm0 = false } = {}) {
    const root = new THREE.Object3D();
    // three-vrm's half-turn for VRM0, as a pivot the bones hang from, so bones read against the root as in the browser
    const pivot = new THREE.Object3D();
    if (vrm0) pivot.rotation.y = Math.PI;
    root.add(pivot);
    const nodes = {};
    // `realParent` builds the rig's ACTUAL humanoid hierarchy (upperChest, shoulders and all); without it, PARENT's
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

    // `pivot` plays vrm.scene's part (the node a body size lives on: client/lib/avatar/avatar.js _applyBodyScale) but is never
    // aliased as vrm.scene, whose readers (landmarks.js) expect meshes
    const av = {
      root, pivot, nodes, poses: 0, limp: false,
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

  /** A body's standing height in metres: its humanoid head joint at rest plus a forehead, the browser's rule
   *  (client/lib/avatar/avatar.js bodyHeight). Meshes don't count. Null without a humanoid head or outside 0.5..4 m. */
  function stature(g) {
    const hb = humanBones(g);
    if (!hb || !Number.isInteger(hb.head)) return null;
    const y = worldPositions(g)(hb.head).y + 0.13;
    return y > 0.5 && y < 4 ? y : null;
  }
  return { worldPositions, worldRotations, makeAvatar, stature };
}
