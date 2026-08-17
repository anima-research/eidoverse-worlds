// import-tripo-avatar — Janus's Blender exports become wearable VRMs, in one
// command. Born from three mythos-PAINT imports in three days, each export
// missing something different; every repair below was needed at least once.
//
//   bun tools/import-tripo-avatar.ts <in.glb> --name mythos_paint3 \
//       [--donor path.glb] [--max-verts 200000] [--height 1.7] [--out dir]
//
// Stages, all detect-and-repair (a clean export passes through untouched):
//   1. STRIP: BODY_PROXY (the rig pipeline's hand-sculpted collision hull
//      ships inside some exports and would render as a blocky shell).
//   2. MATERIALS: Blender exports from the rig blend LOSE the texture images
//      and the paint (three for three so far). tripo_* materials get their
//      texture set transplanted from a known-good donor (same mesh UUID —
//      the UVs hold); PORCELAIN/RAVEN/GOLD get the factor materials the
//      avatar actually looks right in (white glaze / iridescent black /
//      default-metallic gold). A material that arrives WITH textures keeps
//      them.
//   3. DIET: weld + meshopt-simplify toward --max-verts (PAINT-inner shipped
//      1.5M vertices — 12x the proven-good density; a skinned mesh that size
//      is unwearable). Skipped when already under budget.
//   4. VRMIFY: VRMC_vrm 1.0 humanoid stamped on (52-bone Tripo→VRM map,
//      thumbs Metacarpal/Proximal/Distal, Pinky→Little; twist bones and
//      finger metacarpals stay unmapped and FK-follow, per spec).
//   5. SCALE: uniform bake to --height (node translations + POSITIONs + the
//      inverse-bind translation row — no scale nodes, so every consumer,
//      including rig-load's scale-blind worldPositions, agrees).
//   6. VERIFY: the fleet suite's own fixtures drive a fall under BOTH the
//      ammo engine (the avatar's native rig) and the verlet — settle, full
//      pose, fingers if the rig has digits, no skipped joints.
//
// Output: <out>/<name>.vrm + a report. Install is a copy into
// assets/opt/eidoverse/assets/vrms/ (any sequencer picks it up live) — this
// tool never touches a box; deploy stays a human/scp step.

import { plugin } from 'bun';
const STUB = new URL('./core-stub.mjs', import.meta.url).pathname;
plugin({ name: 'core-stub', setup(b) { b.onResolve({ filter: /^\.\/core\.js$/ }, () => ({ path: STUB })); } });

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS, KHRMaterialsClearcoat, KHRMaterialsIridescence } from '@gltf-transform/extensions';
import { prune, weld, simplify } from '@gltf-transform/functions';
import { MeshoptSimplifier } from 'meshoptimizer';

// ---- args -------------------------------------------------------------------
const args = process.argv.slice(2);
const input = args.find((a) => !a.startsWith('--'));
const opt = (k: string, d: string | null = null) => {
  const i = args.indexOf(`--${k}`);
  return i >= 0 ? args[i + 1] : d;
};
if (!input || !opt('name')) {
  console.error('usage: bun tools/import-tripo-avatar.ts <in.glb> --name <avatar_name> [--donor glb] [--max-verts N] [--height M] [--out dir]');
  process.exit(2);
}
const NAME = opt('name')!;
const MAX_VERTS = Number(opt('max-verts', '200000'));
const HEIGHT = Number(opt('height', '1.7'));
const OUT_DIR = opt('out', dirname(resolve(input!)))!;
const DONOR = opt('donor', join(dirname(resolve(input!)), 'mythos-PAINT2.glb'));

const say = (s: string) => console.log(`  ${s}`);
console.log(`import-tripo-avatar: ${input} → ${NAME}.vrm`);

// ---- 1-3: gltf-transform stages --------------------------------------------
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
const doc = await io.read(input!);
const root = doc.getRoot();

for (const node of root.listNodes()) {
  if (node.getName() === 'BODY_PROXY') { node.dispose(); say('stripped BODY_PROXY'); }
}

const donorDoc = existsSync(DONOR!) ? await io.read(DONOR!) : null;
const donorMats = donorDoc
  ? Object.fromEntries(donorDoc.getRoot().listMaterials().map((m) => [m.getName(), m])) : {};
const texCache = new Map();
const carry = (srcTex: any) => {
  if (!srcTex) return null;
  if (!texCache.has(srcTex)) {
    texCache.set(srcTex, doc.createTexture(srcTex.getName())
      .setImage(srcTex.getImage()).setMimeType(srcTex.getMimeType()));
  }
  return texCache.get(srcTex);
};
const clearcoatExt = doc.createExtension(KHRMaterialsClearcoat);
const iridescenceExt = doc.createExtension(KHRMaterialsIridescence);
// "Does this primitive have a COLOR_0" is NOT a paint test — Blender happily
// exports an all-white layer, and that trap produced white eyeballs right
// after a log line said "vertex-painted, kept". Paint means the values VARY:
// sample the prim's COLOR_0 and call it painted only if a real fraction of
// verts is non-white.
const primPainted = (mat: any): boolean =>
  root.listMeshes().some((mesh2) => mesh2.listPrimitives().some((p2) => {
    if (p2.getMaterial() !== mat) return false;
    const col = p2.getAttribute('COLOR_0');
    if (!col) return false;
    const n = col.getCount(), e = [0, 0, 0, 0];
    let nonWhite = 0, seen = 0;
    for (let i = 0; i < n; i += Math.max(1, n >> 10)) {
      col.getElement(i, e); seen++;
      if (Math.min(e[0], e[1], e[2]) < 0.98) nonWhite++;
    }
    return nonWhite / Math.max(1, seen) > 0.05;
  }));
for (const mat of root.listMaterials()) {
  const name = mat.getName();
  if (name.startsWith('tripo_material') && !mat.getBaseColorTexture()) {
    // A PAINTED body must not have donor textures stomped on top of it —
    // the bake IS the look; texture × paint double-darkens. The donor
    // transplant is a repair for paintless exports only.
    if (primPainted(mat)) { say(`${name}: vertex-painted, donor transplant skipped`); continue; }
    const src = (donorMats as any)[name];
    if (src?.getBaseColorTexture()) {
      mat.setBaseColorTexture(carry(src.getBaseColorTexture()));
      mat.setMetallicRoughnessTexture(carry(src.getMetallicRoughnessTexture()));
      mat.setNormalTexture(carry(src.getNormalTexture()));
      mat.setMetallicFactor(src.getMetallicFactor()).setRoughnessFactor(src.getRoughnessFactor());
      say(`textures transplanted onto ${name}`);
    } else say(`⚠ ${name} is textureless and the donor cannot help (${DONOR})`);
  } else if (name === 'RAVEN') {
    // AUTHOR WINS: an export that arrives with its own factors or extensions
    // (Janus ships her own iridescence now) passes through untouched — the
    // house look below is a REPAIR for bare materials, not a house style
    if (mat.getBaseColorFactor().some((v: number, i: number) => v !== 1 && i < 3)
      || mat.listExtensions().length) { say('RAVEN: author-provided, kept'); continue; }
    mat.setBaseColorFactor([0.015, 0.015, 0.022, 1]).setMetallicFactor(0.2)
      .setRoughnessFactor(0.22).setDoubleSided(true);
    mat.setExtension('KHR_materials_clearcoat',
      clearcoatExt.createClearcoat().setClearcoatFactor(0.5).setClearcoatRoughnessFactor(0.1));
    mat.setExtension('KHR_materials_iridescence',
      iridescenceExt.createIridescence().setIridescenceFactor(0.55).setIridescenceIOR(1.3)
        .setIridescenceThicknessMinimum(200).setIridescenceThicknessMaximum(500));
    say('RAVEN → iridescent black');
  } else if (name === 'PORCELAIN') {
    if (mat.getBaseColorFactor().some((v: number, i: number) => v !== 1 && i < 3)
      || mat.listExtensions().length) { say('PORCELAIN: author-provided, kept'); continue; }
    for (const k of ['BaseColor', 'MetallicRoughness'] as const) (mat as any)[`set${k}Texture`](null);
    mat.setNormalTexture(null);
    mat.setBaseColorFactor([1, 1, 1, 1]).setMetallicFactor(0).setRoughnessFactor(0.28).setDoubleSided(true);
    mat.setExtension('KHR_materials_clearcoat',
      clearcoatExt.createClearcoat().setClearcoatFactor(0.25).setClearcoatRoughnessFactor(0.12));
    say('PORCELAIN → white glaze');
  } else if (name === 'HAIR_UNDER') {
    // The rig pipeline's hair_underlayer duplicates the hair inward as a
    // second surface — it arrives wearing Blender's default light grey and
    // glows PALE through every parting between locks ("vertices within the
    // hair that don't have color", 08-12). It is the shadow layer: match
    // the RAVEN locks but darker and matte, no sheen — depth should read
    // as occlusion, not as a second head of hair.
    if (mat.getBaseColorFactor().some((v: number, i: number) => v < 0.7 && i < 3)
      || mat.listExtensions().length) { say('HAIR_UNDER: author-provided, kept'); continue; }
    mat.setBaseColorFactor([0.008, 0.008, 0.014, 1]).setMetallicFactor(0.1)
      .setRoughnessFactor(0.6).setDoubleSided(true);
    say('HAIR_UNDER → matte shadow black');
  } else if (name === 'GOLD') {
    mat.setDoubleSided(true);            // factor + default metallic already right
  } else if (name === 'eyeballs' && !mat.getBaseColorTexture()) {
    // AUTHOR WINS here too (the black-eyeballs incident): vertex-painted
    // eyes (Janus paints the sclera per-vertex) pass through untouched; the
    // dark gloss is a repair for eyes with no paint of ANY kind, which
    // would otherwise render blank white. Tested by VALUE, not COLOR_0
    // presence — an all-white COLOR_0 once passed this check and shipped
    // white eyeballs right after the log said "vertex-painted, kept".
    if (primPainted(mat)) { say('eyeballs: vertex-painted, kept'); continue; }
    mat.setBaseColorFactor([0.06, 0.05, 0.06, 1]).setMetallicFactor(0).setRoughnessFactor(0.1);
    say('eyeballs → dark gloss (no paint of any kind)');
  }
}

let verts = 0;
for (const mesh of root.listMeshes()) for (const prim of mesh.listPrimitives()) {
  verts += prim.getAttribute('POSITION')?.getCount() ?? 0;
}
say(`${verts.toLocaleString()} vertices`);
if (verts > MAX_VERTS) {
  const ratio = MAX_VERTS / verts;
  say(`diet: simplify toward ${MAX_VERTS.toLocaleString()} (ratio ${ratio.toFixed(3)})`);
  await doc.transform(weld(), simplify({ simplifier: MeshoptSimplifier, ratio, error: Number(opt('diet-error', '0.01')) }));
  let after = 0;
  for (const mesh of root.listMeshes()) for (const prim of mesh.listPrimitives()) {
    after += prim.getAttribute('POSITION')?.getCount() ?? 0;
  }
  say(`diet result: ${after.toLocaleString()} vertices`);
}
await doc.transform(prune());

const tmpGlb = join(OUT_DIR, `.${NAME}.tmp.glb`);
await io.write(tmpGlb, doc);

// ---- 4: vrmify (JSON-chunk surgery — gltf-transform would strip VRMC_vrm) --
const buf = readFileSync(tmpGlb);
const jsonLen = buf.readUInt32LE(12);
const g = JSON.parse(buf.subarray(20, 20 + jsonLen).toString());
const rest0 = buf.subarray(20 + jsonLen);
const idx = new Map(g.nodes.map((n: any, i: number) => [n.name, i]));
const need = (n: string) => {
  if (!idx.has(n)) throw new Error(`missing bone ${n} — not a Tripo rig?`);
  return idx.get(n);
};
const MAP: Record<string, string> = {
  hips: 'Hip', spine: 'Waist', chest: 'Spine01', upperChest: 'Spine02',
  neck: 'NeckTwist01', head: 'Head',
  // eye bones arrived with the baked-dec-eyebones generation (08-12);
  // mapping them gives three-vrm gaze for free. Eyelid bones have no VRM
  // slot and FK-follow the head, per spec. Absent bones simply skip.
  leftEye: 'L_Eye', rightEye: 'R_Eye',
  leftShoulder: 'L_Clavicle', leftUpperArm: 'L_Upperarm', leftLowerArm: 'L_Forearm', leftHand: 'L_Hand',
  rightShoulder: 'R_Clavicle', rightUpperArm: 'R_Upperarm', rightLowerArm: 'R_Forearm', rightHand: 'R_Hand',
  leftUpperLeg: 'L_Thigh', leftLowerLeg: 'L_Calf', leftFoot: 'L_Foot', leftToes: 'L_ToeBase',
  rightUpperLeg: 'R_Thigh', rightLowerLeg: 'R_Calf', rightFoot: 'R_Foot', rightToes: 'R_ToeBase',
};
for (const side of ['left', 'right']) {
  const S = side === 'left' ? 'L' : 'R';
  MAP[`${side}ThumbMetacarpal`] = `${S}_Thumb0`;
  MAP[`${side}ThumbProximal`] = `${S}_Thumb1`;
  MAP[`${side}ThumbDistal`] = `${S}_Thumb2`;
  for (const [vrm, tri] of [['Index', 'Index'], ['Middle', 'Middle'], ['Ring', 'Ring'], ['Little', 'Pinky']]) {
    MAP[`${side}${vrm}Proximal`] = `${S}_${tri}1`;
    MAP[`${side}${vrm}Intermediate`] = `${S}_${tri}2`;
    MAP[`${side}${vrm}Distal`] = `${S}_${tri}3`;
  }
}
const humanBones: Record<string, { node: unknown }> = {};
for (const [vrm, tri] of Object.entries(MAP)) {
  const ni = need(tri);
  if (ni != null) humanBones[vrm] = { node: ni };   // optional bones (eyes) skip when absent
}
g.extensionsUsed = [...new Set([...(g.extensionsUsed ?? []), 'VRMC_vrm'])];
g.extensions = g.extensions ?? {};
g.extensions.VRMC_vrm = {
  specVersion: '1.0',
  meta: {
    name: NAME, version: input!.split('/').pop(),
    authors: ['Janus (socketteer)'],
    copyrightInformation: 'Avatar of Mythos/Fable; paint by Janus',
    licenseUrl: 'https://vrm.dev/licenses/1.0/',
    avatarPermission: 'onlySeparatelyLicensedPerson',
    commercialUsage: 'personalNonProfit', creditNotation: 'required', modification: 'prohibited',
  },
  humanoid: { humanBones },
};
say(`vrmified: ${Object.keys(humanBones).length} humanoid bones`);

// ---- 4b: HAIR → VRM SpringBone --------------------------------------------
// The rig pipeline builds per-lock bone chains (Hair_<chain>_<idx>, built by
// hair_rig.py from hand-painted marks). Declared as VRMC_springBone, three-vrm
// simulates them client-side every frame — hair that moves while WALKING, not
// only in a Bullet fall, at zero engine cost. Parameters are the source's
// hair-tuning translated to springbone semantics: stiffness ramps DOWN the
// chain (roots hold shape, tips swing), a touch of gravity, and a head-sphere
// collider so locks rest on the skull instead of inside it.
{
  const chains = new Map<string, { idx: number; node: number }[]>();
  for (const [name, ni] of idx.entries()) {
    const m = /^Hair_(\d+)_(\d+)$/.exec(String(name));
    if (m) {
      const c = chains.get(m[1]) ?? [];
      c.push({ idx: Number(m[2]), node: ni as number });
      chains.set(m[1], c);
    }
  }
  if (chains.size && !args.includes('--no-hair-springs')) {
    const springs: unknown[] = [];
    for (const [cname, joints] of chains) {
      joints.sort((a, b) => a.idx - b.idx);
      if (joints.length < 2) continue;
      springs.push({
        name: `hair_${cname}`,
        // center=hips: tails simulate RELATIVE to the hips, so locomotion
        // does not excite the hair at all (without it, every walk step
        // translates the root under world-anchored tails and the whole mass
        // sweeps back like wind — drag/stiffness scalars cannot fix that;
        // drag only damps accumulated velocity, and the displacement is
        // instantaneous). Rotation and lean still give natural sway.
        center: need('Hip'),
        joints: joints.map((j, i) => {
          const t = i / Math.max(1, joints.length - 1);   // 0 root → 1 tip
          return {
            node: j.node,
            hitRadius: 0.012,
            // Tuned on mythos_painthair (08-12), with center=hips doing the
            // heavy lifting (see above). Three field iterations to get here:
            // flat-stiff (1.2/0.6) read as rigid; flat-soft (0.75/0.45) let
            // the ROOT segments swing as freely as the tips and the scalp
            // showed through while running. Thick locks are anchored firm at
            // the scalp and loosen toward the ends — so the ramp is
            // root-heavy (quadratic falloff), not flat: roots hold coverage
            // near the old-stiff numbers, tips stay softer than the flat-
            // soft cut. Near-zero gravity: the droop is already modelled in.
            stiffness: 0.35 + 0.95 * (1 - t) ** 2,
            gravityPower: 0.01 + 0.02 * t,
            gravityDir: [0, -1, 0],
            dragForce: 0.7 - 0.3 * t,
          };
        }),
        colliderGroups: [0],
      });
    }
    // WINGS GET SPRINGBONES TOO, for the one case the client cannot cover.
    //
    // A wing is DRIVEN while the body is alive (the flap) and simulated in
    // Bullet while it is limp — but only on the client that owns the body.
    // Everyone else sees a REMOTE: no local doll, and the flap is gated on not
    // being limp, so a fallen body's wings froze mid-stroke for every observer.
    // Hair never had that problem because three-vrm was always catching it,
    // which is exactly the fallback wings were missing.
    //
    // Stiffer and heavier-falling than hair: a wing is a limb, not a filament,
    // so the root barely gives and the tip trails. Same hips center, so
    // walking does not excite them. While a local sim owns the body these are
    // suppressed wholesale (avatar.js), so this costs nothing where Bullet runs.
    const wingChains = new Map<string, { idx: number; node: number }[]>();
    for (const [name, ni] of idx.entries()) {
      const m = /^([LR]_Wing_(?:Upper|Lower))(?:_(\d+))?$/.exec(String(name));
      if (!m) continue;
      const c = wingChains.get(m[1]) ?? [];
      c.push({ idx: m[2] ? Number(m[2]) : 0, node: ni as number });
      wingChains.set(m[1], c);
    }
    let wingSprings = 0;
    if (!args.includes('--no-wing-springs')) {
      for (const [cname, joints] of wingChains) {
        joints.sort((a, b) => a.idx - b.idx);
        if (joints.length < 2) continue;
        springs.push({
          name: `wing_${cname}`,
          center: need('Hip'),
          joints: joints.map((j, i) => {
            const t = i / Math.max(1, joints.length - 1);
            return {
              node: j.node,
              hitRadius: 0.02,
              stiffness: 1.6 - 0.9 * t,     // shoulder holds, tip trails
              gravityPower: 0.05 + 0.15 * t, // a limp wing hangs
              gravityDir: [0, -1, 0],
              dragForce: 0.75 - 0.25 * t,
            };
          }),
        });
        wingSprings++;
      }
    }
    g.extensionsUsed = [...new Set([...(g.extensionsUsed ?? []), 'VRMC_springBone'])];
    g.extensions.VRMC_springBone = {
      specVersion: '1.0',
      // radius is a PLACEHOLDER — stage 5b re-fits it to the largest sphere
      // that clears the authored rest pose, after the scale bake.
      colliders: [{ node: need('Head'), shape: { sphere: { offset: [0, 0.05, 0.01], radius: 0.095 } } }],
      colliderGroups: [{ name: 'head', colliders: [0] }],
      springs,
    };
    say(`springbones: ${springs.length - wingSprings} hair chains`
      + `${wingSprings ? ` + ${wingSprings} wing chains` : ''} declared (+head collider)`);
  }
}

// ---- 5: scale bake ----------------------------------------------------------
// measure current height from hips..head span the way the engines do
// FULL TRS walk — translations alone once measured a NEGATIVE height on an
// export whose armature carried a rotation, and the tool nearly baked a
// mirror-flip ×-5.857 into the avatar
let wpReset = () => {};
let wq: (i: number) => number[] = () => [0, 0, 0, 1];
const wp = (() => {
  const parent = new Map();
  g.nodes.forEach((n: any, i: number) => (n.children ?? []).forEach((c: number) => parent.set(c, i)));
  const qmul = (a: number[], b: number[]) => [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2]];
  const qrot = (q: number[], v: number[]) => {
    const t = qmul(qmul(q, [v[0], v[1], v[2], 0]), [-q[0], -q[1], -q[2], q[3]]);
    return [t[0], t[1], t[2]];
  };
  const memo = new Map();
  wpReset = () => memo.clear();
  const world = (i: number): { p: number[]; q: number[] } => {
    if (memo.has(i)) return memo.get(i);
    const n = g.nodes[i];
    const t = n.translation ?? [0, 0, 0];
    const q = n.rotation ?? [0, 0, 0, 1];
    const par: number | undefined = parent.get(i);
    let out;
    if (par == null) out = { p: [...t], q: [...q] };
    else {
      const pw = world(par);
      const rt = qrot(pw.q, t);
      out = { p: [pw.p[0] + rt[0], pw.p[1] + rt[1], pw.p[2] + rt[2]], q: qmul(pw.q, q) };
    }
    memo.set(i, out); return out;
  };
  wq = (i: number) => world(i).q;
  return (i: number) => world(i).p;
})();
// AXIS DETECTION: the rig pipeline's own exports are Z-up ("no conversion
// anywhere" is its doctrine); a Y-span measured on one is ~0 and the abort
// below would end the import. If the head-foot delta runs dominantly along
// Z, rebase every parentless node with a -90° X rotation (Z-up → Y-up) and
// re-measure — three-vrm normalizes rest rotations, so a rotated root is
// legitimate VRM.
{
  const h0 = wp(need('Head') as number), f0 = wp(need('L_Foot') as number);
  const d = [h0[0] - f0[0], h0[1] - f0[1], h0[2] - f0[2]].map(Math.abs);
  if (d[2] > d[1] && d[2] > d[0]) {
    const hasParent = new Set<number>();
    g.nodes.forEach((n: any) => (n.children ?? []).forEach((c: number) => hasParent.add(c)));
    const RX = [-Math.SQRT1_2, 0, 0, Math.SQRT1_2];   // -90° about X
    const qm = (a: number[], b: number[]) => [
      a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
      a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
      a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
      a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2]];
    g.nodes.forEach((n: any, i: number) => {
      if (hasParent.has(i)) return;
      n.rotation = qm(RX, n.rotation ?? [0, 0, 0, 1]);
    });
    wpReset();
    say('Z-up export detected — rebased to Y-up');
  }
}
const headY = wp(need('Head') as number)[1];
const footY = wp(need('L_Foot') as number)[1];
const span = headY - footY;
if (!(span > 0.05)) {
  console.error(`ABORT: measured head-foot span ${span.toFixed(3)} — a non-positive or degenerate`
    + ' span would bake a mirror/garbage scale. Inspect the export.');
  process.exit(1);
}
const S = HEIGHT / (span * 1.16);
say(`scale ×${S.toFixed(3)} (head-foot span ${(headY - footY).toFixed(2)} → target ${HEIGHT}m)`);
const bin = Buffer.from(rest0.subarray(8));
for (const n of g.nodes) if (n.translation) n.translation = n.translation.map((x: number) => x * S);
// An accessor's bufferView is OPTIONAL. Without one its values are all zeros,
// which a `sparse` block may then override for named indices — and that is
// exactly what a rig with SHAPE KEYS exports: every morph-target POSITION comes
// through as a sparse accessor with no bufferView of its own, because most
// vertices do not move. Indexing g.bufferViews[undefined] threw outright
// ("undefined is not an object") the first time a blend with shape keys reached
// this stage.
//
// Skipping them would stop the crash and quietly break the file instead: the
// base mesh would scale by S and the morph DELTAS would not, so every shape key
// would apply at the old scale on a body 1.8x bigger. Sparse values are the
// real data for the vertices they name, so they take the same multiply. (Sparse
// value blocks are tightly packed — the spec forbids byteStride on them.)
const accBytes = (a: any) => {
  if (a.bufferView == null) return null;
  const bv = g.bufferViews[a.bufferView];
  return { base: (bv.byteOffset ?? 0) + (a.byteOffset ?? 0), stride: bv.byteStride ?? 0 };
};
const scaleVec3s = (base: number, count: number, step: number) => {
  for (let i = 0; i < count; i++) for (let c = 0; c < 3; c++) {
    const off = base + i * step + c * 4;
    bin.writeFloatLE(bin.readFloatLE(off) * S, off);
  }
};
let sparseScaled = 0;
const seen = new Set();
for (const m of g.meshes ?? []) for (const p of m.primitives) {
  for (const ai of [p.attributes.POSITION, ...(p.targets ?? []).map((t: any) => t.POSITION)]) {
    if (ai == null || seen.has(ai)) continue;
    seen.add(ai);
    const a = g.accessors[ai];
    const loc = accBytes(a);
    if (loc) scaleVec3s(loc.base, a.count, loc.stride || 12);
    if (a.sparse?.values) {
      const bv = g.bufferViews[a.sparse.values.bufferView];
      scaleVec3s((bv.byteOffset ?? 0) + (a.sparse.values.byteOffset ?? 0), a.sparse.count, 12);
      sparseScaled++;
    }
    if (a.min) a.min = a.min.map((x: number) => x * S);
    if (a.max) a.max = a.max.map((x: number) => x * S);
  }
}
if (sparseScaled) say(`scaled ${sparseScaled} sparse morph-target accessor(s)`);
for (const sk of g.skins ?? []) {
  const a = g.accessors[sk.inverseBindMatrices];
  const loc = accBytes(a);
  if (!loc) continue;                 // a skin with no bind matrices to scale
  const { base, stride } = loc;
  const step = stride || 64;
  for (let i = 0; i < a.count; i++) for (const e of [12, 13, 14]) {
    const off = base + i * step + e * 4;
    bin.writeFloatLE(bin.readFloatLE(off) * S, off);
  }
}
// ---- 5b: collider fit — a springbone collider must never intersect the
// authored rest pose (bit 08-12 on mythos_painthair: an eyeballed r=0.095
// head sphere reached past the crown roots' rest tails and expelled every
// back lock 37–94° AT IDLE — "misshapen bones in the back of the hair").
// The largest safe sphere is a property of the rig, not a constant: min
// rest-tail distance to the collider center, minus the joint hitRadius and
// a margin, clamped to sanity. Runs AFTER the scale bake so the measurement
// is in the same final-space units as the emitted radii.
{
  const sb = (g.extensions ?? {}).VRMC_springBone;
  const sph = sb?.colliders?.[0]?.shape?.sphere;
  if (sb?.springs?.length && sph) {
    wpReset();
    const qmul = (a: number[], b: number[]) => [
      a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
      a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
      a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
      a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2]];
    const qrot = (q: number[], v: number[]) => {
      const t = qmul(qmul(q, [v[0], v[1], v[2], 0]), [-q[0], -q[1], -q[2], q[3]]);
      return [t[0], t[1], t[2]];
    };
    const hi = sb.colliders[0].node as number;
    const hp = wp(hi), off = qrot(wq(hi), sph.offset ?? [0, 0, 0]);
    const c = [hp[0] + off[0], hp[1] + off[1], hp[2] + off[2]];
    let minD = Infinity, hit = 0.012;
    for (const s of sb.springs) {
      for (let i = 1; i < s.joints.length; i++) {   // joint i is joint i-1's tail
        const t = wp(s.joints[i].node);
        minD = Math.min(minD, Math.hypot(t[0] - c[0], t[1] - c[1], t[2] - c[2]));
        hit = Math.max(hit, s.joints[i - 1].hitRadius ?? 0);
      }
    }
    const fitted = Math.min(0.09, Math.max(0.03, +(minD - hit - 0.005).toFixed(3)));
    say(`collider fit: nearest rest tail ${minD.toFixed(3)} → head sphere r=${fitted}`
      + (fitted < sph.radius ? ` (was ${sph.radius})` : ''));
    sph.radius = fitted;
  }
}
let jsonBuf = Buffer.from(JSON.stringify(g));
const pad = (4 - (jsonBuf.length % 4)) % 4;
if (pad) jsonBuf = Buffer.concat([jsonBuf, Buffer.alloc(pad, 0x20)]);
const out = Buffer.alloc(12 + 8 + jsonBuf.length + 8 + bin.length);
out.writeUInt32LE(0x46546c67, 0); out.writeUInt32LE(2, 4); out.writeUInt32LE(out.length, 8);
out.writeUInt32LE(jsonBuf.length, 12); out.writeUInt32LE(0x4e4f534a, 16);
jsonBuf.copy(out, 20);
out.writeUInt32LE(bin.length, 20 + jsonBuf.length);
out.writeUInt32LE(0x004e4942, 24 + jsonBuf.length);
bin.copy(out, 28 + jsonBuf.length);
const outPath = join(OUT_DIR, `${NAME}.vrm`);
writeFileSync(outPath, out);
await Bun.file(tmpGlb).unlink?.() ?? Bun.spawnSync(['rm', tmpGlb]);
say(`wrote ${outPath} (${(out.length / 1048576).toFixed(1)}MB)`);

// ---- 6: verify with the fleet fixtures + both engines -----------------------
const { glbJson, humanBones: hb, worldPositions, makeAvatar, toppleLean } = await import('./rig-load.mjs');
const { AmmoRagdoll, ensureAmmo } = await import('../client/lib/ammodoll.js');
const { Ragdoll } = await import('../client/lib/ragdoll.js');
const g2 = glbJson(readFileSync(outPath));
const bones2 = hb(g2);
const wpos = worldPositions(g2);
const P: Record<string, unknown> = {};
for (const [b, n] of Object.entries(bones2)) if (g2.nodes[n as number]) P[b] = wpos(n);
const nodeOf = new Map(Object.entries(bones2).map(([b, n]) => [n, b]));
const up = new Map();
g2.nodes.forEach((n: any, i: number) => (n.children ?? []).forEach((c: number) => up.set(c, i)));
const realParent: Record<string, string | null> = {};
for (const [b, n] of Object.entries(bones2)) {
  let a: any = up.get(n);
  while (a !== undefined && !nodeOf.has(a)) a = up.get(a);
  realParent[b] = a === undefined ? null : (nodeOf.get(a) as string);
}
let ok = true;
const checkV = (name: string, cond: boolean, detail = '') => {
  console.log(`  ${cond ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
  ok &&= cond;
};
checkV('wasm door opens', await ensureAmmo());
for (const [label, Engine] of [['ammo', AmmoRagdoll], ['verlet', Ragdoll]] as any) {
  const av = makeAvatar(P, { realParent });
  av.root.updateMatrixWorld(true);
  const rd: any = new Engine(av, toppleLean(), av.restBonePositions());
  let steps = 0;
  while (!rd.done && steps < 900) { rd.step(1 / 60); steps++; }
  const pose = rd.finalPose ?? {};
  const finite = Object.values(pose).every((q: any) => q.every(Number.isFinite));
  checkV(`${label}: falls, settles, finite pose`, rd.done && finite && Object.keys(pose).length >= 8,
    `${Object.keys(pose).length} bones in ${steps} steps`);
  if (label === 'ammo') {
    checkV('ammo: no detached joints', !(rd.skipped?.length), (rd.skipped ?? []).join(','));
    const fingers = Object.keys(pose).filter((k) => /Proximal|Intermediate|Thumb/.test(k)).length;
    say(`ammo drives ${fingers} finger bones`);
  }
}
console.log(ok ? `\nPASS — install: cp ${outPath} assets/opt/eidoverse/assets/vrms/` : '\nFAIL — do not install');
process.exit(ok ? 0 : 1);
