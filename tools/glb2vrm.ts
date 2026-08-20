// glb2vrm — turn a rigged humanoid GLB (Tripo-style skeleton) into a VRM 1.0
// avatar the eidoverse-worlds client can wear.
//
// VRM 1.0 is just glTF + a VRMC_vrm extension (humanoid bone map + meta), so
// no geometry pipeline is needed: we edit the JSON chunk in place. Three real
// transformations happen along the way:
//
//  1. T-pose: VRMA retargeting assumes a T-pose rest. Tripo exports A-pose.
//     We rotate rest joints (upperarm→forearm→hand chain to ±X, thigh→calf
//     to -Y) while KEEPING inverse bind matrices — the mesh re-poses with the
//     skeleton, which is exactly the point.
//  2. Scale: Tripo models are ~1m tall. We bake a uniform scale on the
//     Armature (an ancestor of all skin joints, so the skinned mesh follows).
//  3. Facing: VRM 1.0 avatars face +Z. We measure forward from the foot→toe
//     direction and bake a 180° yaw on the Armature if needed.
//
// Usage:
//   bun tools/glb2vrm.ts input.glb --name cosplay [--height 1.65]
//     [--head-pitch -20] [--out path]
//   bun tools/glb2vrm.ts anything.{glb,vrm} --measure   # just report pose/facing
//
// Bone names are Tripo's (Hip/Pelvis/Spine01/L_Upperarm/...). Extend TRIPO_MAP
// for other generators.

import * as THREE from "../client/node_modules/three/src/Three.js";
import { resolve, join, basename } from "node:path";

// ------------------------------------------------------------------ GLB I/O

function parseGLB(buf: ArrayBuffer) {
  const dv = new DataView(buf);
  if (dv.getUint32(0, true) !== 0x46546c67) throw new Error("not a GLB");
  let off = 12;
  let json: any = null;
  let bin: Uint8Array | null = null;
  while (off < dv.byteLength) {
    const len = dv.getUint32(off, true);
    const type = dv.getUint32(off + 4, true);
    const data = new Uint8Array(buf, off + 8, len);
    if (type === 0x4e4f534a) json = JSON.parse(new TextDecoder().decode(data));
    else if (type === 0x004e4942) bin = data;
    off += 8 + len;
  }
  if (!json) throw new Error("no JSON chunk");
  return { json, bin };
}

function writeGLB(json: any, bin: Uint8Array | null): Uint8Array {
  const jsonBytes = new TextEncoder().encode(JSON.stringify(json));
  const jsonPad = (4 - (jsonBytes.length % 4)) % 4;
  const binPad = bin ? (4 - (bin.length % 4)) % 4 : 0;
  const total = 12 + 8 + jsonBytes.length + jsonPad + (bin ? 8 + bin.length + binPad : 0);
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, 0x46546c67, true);
  dv.setUint32(4, 2, true);
  dv.setUint32(8, total, true);
  let off = 12;
  dv.setUint32(off, jsonBytes.length + jsonPad, true);
  dv.setUint32(off + 4, 0x4e4f534a, true);
  out.set(jsonBytes, off + 8);
  out.fill(0x20, off + 8 + jsonBytes.length, off + 8 + jsonBytes.length + jsonPad); // pad w/ spaces
  off += 8 + jsonBytes.length + jsonPad;
  if (bin) {
    dv.setUint32(off, bin.length + binPad, true);
    dv.setUint32(off + 4, 0x004e4942, true);
    out.set(bin, off + 8);
  }
  return out;
}

// --------------------------------------------------------------- node math

type G = any;

function nodeByName(g: G, name: string): number {
  const i = (g.nodes as any[]).findIndex((n) => n.name === name);
  if (i < 0) throw new Error(`node not found: ${name}`);
  return i;
}

function parentOf(g: G, idx: number): number {
  return (g.nodes as any[]).findIndex((n) => (n.children ?? []).includes(idx));
}

function localMatrix(n: any): THREE.Matrix4 {
  if (n.matrix) return new THREE.Matrix4().fromArray(n.matrix);
  const t = new THREE.Vector3(...(n.translation ?? [0, 0, 0]));
  const q = new THREE.Quaternion(...(n.rotation ?? [0, 0, 0, 1]));
  const s = new THREE.Vector3(...(n.scale ?? [1, 1, 1]));
  return new THREE.Matrix4().compose(t, q, s);
}

/** World matrices for every node, composed from the scene roots. */
function worldMatrices(g: G): THREE.Matrix4[] {
  const W: THREE.Matrix4[] = new Array(g.nodes.length);
  const walk = (idx: number, parent: THREE.Matrix4) => {
    W[idx] = parent.clone().multiply(localMatrix(g.nodes[idx]));
    for (const c of g.nodes[idx].children ?? []) walk(c, W[idx]);
  };
  for (const r of g.scenes[g.scene ?? 0].nodes) walk(r, new THREE.Matrix4());
  return W;
}

const posOf = (m: THREE.Matrix4) => new THREE.Vector3().setFromMatrixPosition(m);
const rotOf = (m: THREE.Matrix4) => {
  const q = new THREE.Quaternion();
  m.decompose(new THREE.Vector3(), q, new THREE.Vector3());
  return q;
};

/** Rotate `bone` (rest pose) so the world direction bone→child becomes
 *  `target`. Inverse bind matrices stay untouched: the mesh re-poses. */
function alignBone(g: G, boneName: string, childName: string, target: THREE.Vector3) {
  const bi = nodeByName(g, boneName);
  const ci = nodeByName(g, childName);
  const W = worldMatrices(g);
  const seg = posOf(W[ci]).sub(posOf(W[bi]));
  if (seg.length() < 1e-6) return 0; // degenerate (co-located pivot bones)
  const dir = seg.normalize();
  const tgt = target.clone().normalize();
  const angle = THREE.MathUtils.radToDeg(dir.angleTo(tgt));
  if (angle < 0.5) return 0;
  const qCorr = new THREE.Quaternion().setFromUnitVectors(dir, tgt);
  const pi = parentOf(g, bi);
  const Rp = pi >= 0 ? rotOf(W[pi]) : new THREE.Quaternion();
  const qLocal = new THREE.Quaternion(...(g.nodes[bi].rotation ?? [0, 0, 0, 1]));
  // R_world = Rp * qLocal ; want qCorr * R_world ⇒ qLocal' = Rp⁻¹·qCorr·Rp·qLocal
  const qNew = Rp.clone().invert().multiply(qCorr).multiply(Rp).multiply(qLocal);
  g.nodes[bi].rotation = qNew.toArray();
  return angle;
}

/** Forward = horizontal component of foot→toe, averaged over both feet. */
function measureForward(g: G, footL: string, toeL: string, footR: string, toeR: string) {
  const W = worldMatrices(g);
  const f = new THREE.Vector3();
  for (const [foot, toe] of [[footL, toeL], [footR, toeR]]) {
    const d = posOf(W[nodeByName(g, toe)]).sub(posOf(W[nodeByName(g, foot)]));
    d.y = 0;
    f.add(d.normalize());
  }
  return f.normalize();
}

/** Mutable float view over an accessor's data in the BIN chunk. */
function accessorFloats(g: G, bin: Uint8Array, accIdx: number, comps: number): Float32Array {
  const acc = g.accessors[accIdx];
  const bv = g.bufferViews[acc.bufferView];
  const off = bin.byteOffset + (bv.byteOffset ?? 0) + (acc.byteOffset ?? 0);
  if (acc.componentType !== 5126) throw new Error("expected float accessor");
  return new Float32Array(bin.buffer, off, acc.count * comps);
}

/** VRM requires a NORMALIZED skeleton: humanoid bone nodes with zero rest
 *  rotation (world-aligned axes). Animation retargeting writes rotations that
 *  assume identity rest — on a rig with rotated rest bones (Tripo: every
 *  joint, plus a -90°X Z-up root) the result is a scrambled heap. So: zero
 *  every joint's rotation, turn locals into world-space translation deltas,
 *  and fold the old orientations into the inverse bind matrices. The rendered
 *  rest pose is unchanged; the bone axes become what VRM expects. */
function normalizeSkeleton(g: G, bin: Uint8Array, rootName: string) {
  const rootIdx = nodeByName(g, rootName);
  const W = worldMatrices(g);
  const sub: number[] = [];
  (function walk(i: number) {
    for (const c of g.nodes[i].children ?? []) { sub.push(c); walk(c); }
  })(rootIdx);
  for (const i of sub) {
    if (g.nodes[i].mesh !== undefined) continue; // skinned mesh node: transform ignored anyway
    const p = parentOf(g, i);
    const parentPos = p === rootIdx ? new THREE.Vector3() : posOf(W[p]);
    g.nodes[i].translation = posOf(W[i]).sub(parentPos).toArray();
    delete g.nodes[i].rotation;
    delete g.nodes[i].scale;
  }
  for (const skin of g.skins ?? []) {
    const ibm = accessorFloats(g, bin, skin.inverseBindMatrices, 16);
    (skin.joints as number[]).forEach((j, k) => {
      const old = new THREE.Matrix4().fromArray(ibm, k * 16);
      const newWorld = new THREE.Matrix4().makeTranslation(posOf(W[j]).x, posOf(W[j]).y, posOf(W[j]).z);
      newWorld.invert().multiply(W[j]).multiply(old).toArray(ibm, k * 16);
    });
  }
}

// ------------------------------------------------------- Tripo → VRM bones

const TRIPO_MAP: Record<string, string> = {
  hips: "Hip",
  spine: "Spine01",
  chest: "Spine02",
  neck: "NeckTwist01",
  head: "Head",
  leftShoulder: "L_Clavicle",
  leftUpperArm: "L_Upperarm",
  leftLowerArm: "L_Forearm",
  leftHand: "L_Hand",
  rightShoulder: "R_Clavicle",
  rightUpperArm: "R_Upperarm",
  rightLowerArm: "R_Forearm",
  rightHand: "R_Hand",
  leftUpperLeg: "L_Thigh",
  leftLowerLeg: "L_Calf",
  leftFoot: "L_Foot",
  leftToes: "L_ToeBase",
  rightUpperLeg: "R_Thigh",
  rightLowerLeg: "R_Calf",
  rightFoot: "R_Foot",
  rightToes: "R_ToeBase",
};

// Digits are OPTIONAL: many rigs have no finger bones, and TRIPO_MAP is checked
// with fail-fast nodeByName, so these cannot live in it. Any entry whose bone is
// missing is simply skipped.
//
// Worth mapping, because ammodoll.js ports the source's finger springs and
// tendon coupling and asks for these exact joints — without them a rig with a
// full hand rig arrives with no finger physics at all.
//
// Tripo's naming, and two traps in it:
//   *0 is the METACARPAL. VRM has a slot for the thumb's and NOT for the other
//      fingers — which matches the source rig's own choice to keep metacarpals
//      fused to the hand body. So Index0/Middle0/Ring0/Pinky0 are deliberately
//      unmapped, and Index1 is the PROXIMAL.
//   VRM says "Little" where Tripo says "Pinky".
const TRIPO_DIGITS: Record<string, string> = (() => {
  const m: Record<string, string> = {};
  for (const [vrmSide, t] of [["left", "L"], ["right", "R"]] as const) {
    m[`${vrmSide}ThumbMetacarpal`] = `${t}_Thumb0`;
    m[`${vrmSide}ThumbProximal`]   = `${t}_Thumb1`;
    m[`${vrmSide}ThumbDistal`]     = `${t}_Thumb2`;
    for (const [vrmFinger, tripoFinger] of
         [["Index", "Index"], ["Middle", "Middle"], ["Ring", "Ring"], ["Little", "Pinky"]] as const) {
      m[`${vrmSide}${vrmFinger}Proximal`]     = `${t}_${tripoFinger}1`;
      m[`${vrmSide}${vrmFinger}Intermediate`] = `${t}_${tripoFinger}2`;
      m[`${vrmSide}${vrmFinger}Distal`]       = `${t}_${tripoFinger}3`;
    }
  }
  return m;
})();

// ------------------------------------------------------------------- main

const argv = Bun.argv.slice(2);
const input = argv.find((a) => !a.startsWith("--"));
if (!input) {
  console.error("usage: bun tools/glb2vrm.ts input.glb --name <name> [--height 1.65] [--head-pitch degrees] [--out path] [--measure]");
  process.exit(1);
}
const flag = (n: string) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const has = (n: string) => argv.includes(`--${n}`);

const { json: g, bin } = parseGLB(await Bun.file(input).arrayBuffer());

if (has("measure")) {
  // Report conventions of any glb/vrm — used to sanity-check against library avatars.
  const v1 = g.extensions?.VRMC_vrm;
  const bones = v1?.humanoid?.humanBones;
  const name = (k: string) => (bones ? g.nodes[bones[k].node].name : TRIPO_MAP[k]);
  const fwd = measureForward(g, name("leftFoot"), name("leftToes"), name("rightFoot"), name("rightToes"));
  const W = worldMatrices(g);
  const headY = posOf(W[nodeByName(g, name("head"))]).y;
  const hipsY = posOf(W[nodeByName(g, name("hips"))]).y;
  const lHand = posOf(W[nodeByName(g, name("leftHand"))]);
  console.log(`${basename(input)}  vrm1=${!!v1}`);
  console.log(`  forward (foot→toe): [${fwd.toArray().map((x) => x.toFixed(2))}]`);
  console.log(`  head Y ${headY.toFixed(2)}  hips Y ${hipsY.toFixed(2)}  leftHand [${lHand.toArray().map((x) => x.toFixed(2))}]`);
  process.exit(0);
}

const name = flag("name") ?? basename(input).replace(/\.(glb|vrm)$/, "");
const targetHeight = Number(flag("height") ?? 1.65);
const out = flag("out") ?? join(import.meta.dir, "..", "assets", "opt", "eidoverse", "assets", "vrms", `${name}.vrm`);

for (const vrmBone of Object.values(TRIPO_MAP)) nodeByName(g, vrmBone); // fail fast on unknown rigs

// Facing quadrant, measured ONCE before any pose surgery and reused by both
// the T-pose step (its side axes are facing-relative!) and the final yaw bake.
// Tripo rigs often face +X; T-posing their arms to world ±X would bake them
// front/back — the one-arm-forward-one-arm-back bug.
const FACE_YAW: Record<string, number> = { "+z": 0, "-z": Math.PI, "+x": Math.PI / 2, "-x": -Math.PI / 2 };
const faceFlag = flag("face")?.toLowerCase();
if (faceFlag !== undefined && !(faceFlag in FACE_YAW)) throw new Error("--face must be one of +z -z +x -x");
const fwdMeasured = measureForward(g, "L_Foot", "L_ToeBase", "R_Foot", "R_ToeBase");
const rawYaw = faceFlag !== undefined ? FACE_YAW[faceFlag] : Math.atan2(fwdMeasured.x, fwdMeasured.z);
const faceYaw = (Math.round(rawYaw / (Math.PI / 2)) * Math.PI) / 2; // snapped: models are axis-aligned
const fwdAxis = new THREE.Vector3(Math.sin(faceYaw), 0, Math.cos(faceYaw));
const leftAxis = new THREE.Vector3(fwdAxis.z, 0, -fwdAxis.x); // up × forward

// -- 1. T-pose. Side axes are relative to the measured facing; left is
// wherever the left leg lives along that axis (don't assume anything).
if (!has("no-tpose")) {
  const W = worldMatrices(g);
  // Compare the two sides to each other instead of to the scene origin. Some
  // scans (Sydney in particular) have the whole armature translated sideways,
  // so both thighs can have the same world-side sign even though the rig
  // itself is not mirrored.
  const dThigh = posOf(W[nodeByName(g, "L_Thigh")]).clone()
    .sub(posOf(W[nodeByName(g, "R_Thigh")]));
  const leftSign = Math.sign(dThigh.dot(leftAxis)) || 1;
  const L = leftAxis.clone().multiplyScalar(leftSign);
  const R = leftAxis.clone().multiplyScalar(-leftSign);
  const DOWN = new THREE.Vector3(0, -1, 0);
  const UP = new THREE.Vector3(0, 1, 0);
  const fixes: [string, string, THREE.Vector3][] = [
    // Torso first: scanned figures keep their stance (fashion-mannequin
    // S-posture = shoulders ~10cm behind hips). Clip rotations are absolute
    // and can't move where the shoulder SOCKETS are — a leaned-back chest
    // makes every animation put the hands inside the lower back. Stack the
    // spine chain vertical so shoulders sit neutrally above the hips, THEN
    // pose the limbs relative to that.
    ["Waist", "Spine01", UP], ["Spine01", "Spine02", UP],
    ["Spine02", "NeckTwist01", UP], ["NeckTwist01", "NeckTwist02", UP],
    ["NeckTwist02", "Head", UP],
    ["L_Upperarm", "L_Forearm", L], ["L_Forearm", "L_Hand", L],
    ["R_Upperarm", "R_Forearm", R], ["R_Forearm", "R_Hand", R],
    ["L_Thigh", "L_Calf", DOWN], ["L_Calf", "L_Foot", DOWN],
    ["R_Thigh", "R_Calf", DOWN], ["R_Calf", "R_Foot", DOWN],
  ];
  for (const [b, c, t] of fixes) {
    const moved = alignBone(g, b, c, t);
    if (moved) console.log(`  t-pose: ${b} rotated ${moved.toFixed(1)}°`);
  }
}

// -- 1.5. Normalize the skeleton (VRM hard requirement — see docstring).
if (!has("no-normalize")) {
  if (!bin) throw new Error("no BIN chunk — cannot rewrite inverse bind matrices");
  normalizeSkeleton(g, bin, "Armature");
  console.log("  normalized: joint rotations zeroed, orientations folded into IBMs");
}

// Some generated characters have a neutral mesh pose with the face pitched
// toward the floor even though their neck joint chain is already vertical.
// A small rotation on the unmapped NeckTwist02 joint re-poses that character's
// head without changing shared VRMA clips or the humanoid mapping. Apply this
// after normalization so the offset remains part of the avatar's neutral pose.
const headPitch = Number(flag("head-pitch") ?? 0);
if (!Number.isFinite(headPitch)) throw new Error("--head-pitch must be a number");
if (headPitch !== 0) {
  const idx = nodeByName(g, "NeckTwist02");
  const q = new THREE.Quaternion(...(g.nodes[idx].rotation ?? [0, 0, 0, 1]));
  const offset = new THREE.Quaternion().setFromAxisAngle(
    new THREE.Vector3(1, 0, 0),
    THREE.MathUtils.degToRad(headPitch),
  );
  g.nodes[idx].rotation = q.multiply(offset).toArray();
  console.log(`  posture: head pitch ${headPitch.toFixed(1)}° on NeckTwist02`);
}

// -- 2 + 3. Scale + facing, baked on the Armature (ancestor of all joints).
if (!has("no-scale")) {
  const W = worldMatrices(g);
  const headY = posOf(W[nodeByName(g, "Head")]).y;
  // True height = mesh bounds when available (includes hair/hat; robust to
  // stylized rigs whose head bone sits low), else head bone + a crown fudge.
  let meshMaxY = 0;
  for (const m of g.meshes ?? []) for (const p of m.primitives) {
    const max = g.accessors[p.attributes.POSITION]?.max;
    if (max) meshMaxY = Math.max(meshMaxY, max[1]);
  }
  const height = Math.max(headY * 1.08, meshMaxY);
  const scale = targetHeight / height;
  // Facing was measured (or overridden via --face) BEFORE the T-pose surgery;
  // faceYaw is the model's yaw away from +Z, snapped to a quadrant. Bake the
  // correction on the Armature so the avatar faces +Z (VRM 1.0).
  const armIdx = nodeByName(g, "Armature");
  const arm = g.nodes[armIdx];
  if (arm.matrix) throw new Error("Armature uses matrix transform — unexpected for Tripo");
  arm.scale = [scale, scale, scale];
  if (faceYaw !== 0) {
    const yaw = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -faceYaw);
    const cur = new THREE.Quaternion(...(arm.rotation ?? [0, 0, 0, 1]));
    arm.rotation = yaw.multiply(cur).toArray();
  }
  const yawDeg = THREE.MathUtils.radToDeg(faceYaw);
  console.log(`  height ${height.toFixed(2)}m → ×${scale.toFixed(3)} = ${targetHeight}m; forward [x=${fwdMeasured.x.toFixed(2)}, z=${fwdMeasured.z.toFixed(2)}]${faceYaw !== 0 ? ` → yawed ${-yawDeg.toFixed(0)}° to +Z` : " (already +Z)"}`);
}

// -- 4. VRMC_vrm extension.
g.extensionsUsed = [...new Set([...(g.extensionsUsed ?? []), "VRMC_vrm"])];
g.extensions = g.extensions ?? {};
g.extensions.VRMC_vrm = {
  specVersion: "1.0",
  meta: {
    name,
    version: "1.0",
    authors: (flag("authors") ?? "antra").split(","),
    licenseUrl: "https://vrm.dev/licenses/1.0/",
    avatarPermission: "onlyAuthor",
    commercialUsage: "personalNonProfit",
    creditNotation: "unnecessary",
    modification: "allowModification",
  },
  humanoid: {
    // Trust geometry, not bone names: some rigs come out mirrored (L_* bones
    // on the -X side). VRM left = +X when facing +Z; binding a "left" clip
    // track to a -X arm rotates it the wrong way (the arms-to-the-sky bug).
    humanBones: (() => {
      const W = worldMatrices(g);
      const leftLegX = posOf(W[nodeByName(g, TRIPO_MAP.leftUpperLeg)]).x;
      const rightLegX = posOf(W[nodeByName(g, TRIPO_MAP.rightUpperLeg)]).x;
      const mirrored = leftLegX < rightLegX;
      if (mirrored) console.log("  rig is mirrored (L_* bones at -X) → swapping left/right in humanoid map");
      const side = (name: string) =>
        mirrored ? name.replace(/^([LR])_/, (_, c) => (c === "L" ? "R_" : "L_")) : name;
      const out: Record<string, { node: number }> = Object.fromEntries(
        Object.entries(TRIPO_MAP).map(([vrm, tripo]) => [vrm, { node: nodeByName(g, side(tripo)) }]),
      );
      let digits = 0;
      for (const [vrm, tripo] of Object.entries(TRIPO_DIGITS)) {
        const idx = g.nodes.findIndex((n: any) => n.name === side(tripo));
        if (idx >= 0) { out[vrm] = { node: idx }; digits++; }
      }
      console.log(digits
        ? `  mapped ${digits} finger bones (ammodoll drives these as spring joints)`
        : "  no finger bones found — hands will be rigid in the body engine");
      return out;
    })(),
  },
};

await Bun.write(out, writeGLB(g, bin));
console.log(`wrote ${resolve(out)} (${((await Bun.file(out).arrayBuffer()).byteLength / 1e6).toFixed(1)} MB)`);
