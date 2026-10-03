// bun tools/lod-budget-test.ts — the LOD's screen-space budget (gen 3): geometry error and texture size both follow
// from the closest distance the client shows the LOD (shared/lod-distance.js) at a headset's pixel density.
//   - lodBudget: the error is 2 px there, in world metres, off the model's WORLD diagonal (node scale included);
//   - lodTexelCaps: each texture keeps the texels that distance can resolve, from its own UV texel density;
//     a texture it cannot measure (KHR_texture_transform) keeps the house cap; an extension texture follows its
//     material's measured cap.
//   - the bounds gate: a silhouette moved by less than the budget passes (a 1 m prop: 2 cm gate, 4 cm budget); one
//     moved by twice the budget is still refused;
//   - a texture-only LOD: vertices stuck over 0.6×, but textures at ≤ LOD_TEX_ONLY of the full tier → served (needs the
//     real KTX2 encoder; without one the check FAILS, never a silent pass), and the capped maps are IN the file;
//   - the density rule: the least-dense area binds (area-weighted p10), never above the house cap; every instance and
//     every axis of a node's scale counts.
// Mutations witnessed red: texelsPerMetre → Infinity in lodTexelCaps (every cap back to the house cap); the node's
// scale ignored in lodBudget (the world diagonal read from raw positions); the budget dropped from the bounds gate's
// tolerance (the 2.5 cm push refused); the gate's box read from raw positions, node transforms ignored (the cm model refused); the texture-only branch
// disabled (the 1024² field refused as ineffective).
import { Document } from "@gltf-transform/core";
import { KHRTextureTransform, KHRMaterialsSpecular } from "@gltf-transform/extensions";
import { NodeIO } from "@gltf-transform/core";
import { lodBudget, lodTexelCaps, optimizeGlbLod, findKtx2Encoder, meshWorldScale, minTexelDensity } from "../server/optimize.ts";
// these tests exercise the REDUCER's mechanics on fixtures sized around a 1,000-vertex floor; the production floor
// (LOD_MIN_VERTS, a policy) is pinned in store-variants-test
const lodAtTestFloor = (b: Uint8Array, e: string | null, m?: (d: any) => void) => optimizeGlbLod(b, e, m, { minVerts: 1_000 });
import { getBounds } from "@gltf-transform/core";
import draco3d from "draco3dgltf";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import { parseGlb } from "../server/glbparse.ts";
import { LOD_NEAR_MIN } from "../client/lib/lod_policy.js";
import sharp from "sharp";
import { lodNearest } from "../shared/lod-distance.js";
import { LOD_PX, LOD_PPD, LOD_TEXELS_PER_PX, LOD_TEX_ONLY, KTX2_TEXEL_CAP } from "../server/store-variants.ts";

let pass = 0, fail = 0;
const check = (n: string, ok: boolean, d: unknown = "") => { ok ? pass++ : fail++; console.log(`  ${ok ? "\x1b[32m✓" : "\x1b[31m✗"}\x1b[0m ${n}${ok ? "" : `  ${JSON.stringify(d)}`}`); };

/** A PNG header is all getSize() reads: the IHDR width/height. */
function pngHeader(w: number, h: number) {
  const b = new Uint8Array(33); b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  const dv = new DataView(b.buffer); dv.setUint32(16, w); dv.setUint32(20, h); return b;
}
/** A flat quad `side` metres square (drawn at node scale `scale`), UV 0..1 over a `tex`² base-colour map. */
function quad(side: number, tex: number, { scale = 1, transform = false, specular = false, vertical = false, png = null as Uint8Array | null } = {}) {
  const doc = new Document(); const buf = doc.createBuffer(); const s = side / scale;
  const P = new Float32Array(vertical ? [0, 0, 0, s, 0, 0, s, s, 0, 0, s, 0] : [0, 0, 0, s, 0, 0, s, 0, s, 0, 0, s]), T = new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]);
  const t = doc.createTexture("base").setImage(png ?? pngHeader(tex, tex)).setMimeType("image/png");
  const m = doc.createMaterial("m").setBaseColorTexture(t);
  if (transform) m.getBaseColorTextureInfo()!.setExtension("KHR_texture_transform", doc.createExtension(KHRTextureTransform).createTransform().setScale([4, 4]));
  let spec = null;
  if (specular) {
    spec = doc.createTexture("spec").setImage(pngHeader(tex, tex)).setMimeType("image/png");
    m.setExtension("KHR_materials_specular", doc.createExtension(KHRMaterialsSpecular).createSpecular().setSpecularTexture(spec));
  }
  const prim = doc.createPrimitive().setMaterial(m)
    .setAttribute("POSITION", doc.createAccessor().setType("VEC3").setArray(P).setBuffer(buf))
    .setAttribute("TEXCOORD_0", doc.createAccessor().setType("VEC2").setArray(T).setBuffer(buf))
    .setIndices(doc.createAccessor().setType("SCALAR").setArray(new Uint32Array([0, 2, 1, 0, 3, 2])).setBuffer(buf));
  doc.createScene().addChild(doc.createNode("q").setScale([scale, scale, scale]).setMesh(doc.createMesh("q").addPrimitive(prim)));
  return { doc, t, spec };
}
const pxPerMetre = (side: number) => (LOD_PPD * 180 / Math.PI) / lodNearest(Math.hypot(side, 0, side));

// geometry: the budget is 2 px at lodNearest, world metres, and node scale counts
{
  const { doc } = quad(2, 1024), b = lodBudget(doc);
  check("the budget's distance is the client's lodNearest of the world diagonal", Math.abs(b.nearest - lodNearest(Math.hypot(2, 0, 2))) < 1e-9, b);
  check(`the geometry error is ${LOD_PX} px there, in metres`, Math.abs(b.errWorld - LOD_PX / pxPerMetre(2)) < 1e-9, b.errWorld);
  const scaled = lodBudget(quad(2, 1024, { scale: 100 }).doc);   // positions 0.02 m under a 100× node: the same 2 m quad
  check("a model authored in other units (node scale) gets the same world budget", Math.abs(scaled.errWorld - b.errWorld) < 1e-9 && Math.abs(scaled.diag - b.diag) < 1e-6, { scaled, b });
}
// textures: sized to what the closest distance resolves
{
  const { doc, t } = quad(2, 1024), b = lodBudget(doc);
  const need = 1024 * (LOD_TEXELS_PER_PX * pxPerMetre(2)) / 512;   // 1024 texels over 2 m = 512 texels/m
  const want = 2 ** Math.ceil(Math.log2(need));
  const cap = lodTexelCaps(doc, b.texelsPerMetre).get(t);
  check(`a 2 m prop's 1024² map drops to what ${lodNearest(Math.hypot(2, 0, 2)).toFixed(0)} m resolves (${want}), not the house cap`, cap === want && want < KTX2_TEXEL_CAP, { cap, need });
  const big = quad(40, 1024), bb = lodBudget(big.doc);
  check("a 40 m wall's 1024² map is already under what its distance resolves: it keeps the house cap", lodTexelCaps(big.doc, bb.texelsPerMetre).get(big.t) === KTX2_TEXEL_CAP);
  const tiny = quad(0.05, 1024), tb = lodBudget(tiny.doc);
  check("never below 64", lodTexelCaps(tiny.doc, tb.texelsPerMetre).get(tiny.t) === 64);
  const tr = quad(2, 1024, { transform: true });
  check("a texture under KHR_texture_transform is not measured: no cap, the house cap applies", !lodTexelCaps(tr.doc, lodBudget(tr.doc).texelsPerMetre).has(tr.t));
  const sp = quad(2, 1024, { specular: true }), caps = lodTexelCaps(sp.doc, lodBudget(sp.doc).texelsPerMetre);
  { // core slots with DIFFERENT caps: a 1024² base (→ capped) and a 64² ORM (→ 64); the specular map takes the larger
  const sp2 = quad(2, 1024, { specular: true }); const mt = sp2.doc.getRoot().listMaterials()[0];
  mt.setMetallicRoughnessTexture(sp2.doc.createTexture("orm").setImage(pngHeader(64, 64)).setMimeType("image/png"));
  const c2 = lodTexelCaps(sp2.doc, lodBudget(sp2.doc).texelsPerMetre);
  check("…and when its material's core maps got different caps, it takes the LARGEST of them", c2.get(sp2.spec!) === c2.get(sp2.t) && c2.get(sp2.t)! > 64, [...c2.values()]); }
check("an extension texture (KHR_materials_specular) follows its material's measured cap", caps.get(sp.spec!) === caps.get(sp.t) && caps.get(sp.t) === want, [...caps.values()]);
}
// the percentile: ONE 1024² map over three regions of one mesh — A 5% of the area at 50 texels/m, B 40% at 200, C 55%
// at 800. Shrinking the map scales them all alike, so the LEAST dense area binds: the area-weighted 10th percentile
// lands in B (A is a sliver under 10%). min → 1024 (A), p10 → 256 (B), median and max → 64 (C), unweighted by count → A.
{
  const doc = new Document(); const buf = doc.createBuffer();
  const t = doc.createTexture("atlas").setImage(pngHeader(1024, 1024)).setMimeType("image/png");
  const m = doc.createMaterial("m").setBaseColorTexture(t);
  const P: number[] = [], T: number[] = [], I: number[] = [];
  let x = 0, u = 0;
  for (const [area, dens] of [[0.05, 50], [0.40, 200], [0.55, 800]]) {
    const side = Math.sqrt(area), us = dens * side / 1024, base = P.length / 3;
    P.push(x, 0, 0, x + side, 0, 0, x + side, 0, side, x, 0, side); T.push(u, 0, u + us, 0, u + us, us, u, us);
    I.push(base, base + 2, base + 1, base, base + 3, base + 2); x += side + 0.1; u += us + 0.01;
  }
  const prim = doc.createPrimitive().setMaterial(m)
    .setAttribute("POSITION", doc.createAccessor().setType("VEC3").setArray(new Float32Array(P)).setBuffer(buf))
    .setAttribute("TEXCOORD_0", doc.createAccessor().setType("VEC2").setArray(new Float32Array(T)).setBuffer(buf))
    .setIndices(doc.createAccessor().setType("SCALAR").setArray(new Uint32Array(I)).setBuffer(buf));
  doc.createScene().addChild(doc.createNode("r").setMesh(doc.createMesh("r").addPrimitive(prim)));
  const tpm = 48;   // fixed, so the expected caps are exact: 1024·48/200 = 246 → 256; /50 → 1024; /800 → 64
  const cap = lodTexelCaps(doc, tpm).get(t);
  check("the LEAST-dense region binds (area-weighted p10): a 5%-area sliver doesn't pin the map, the 40% region sets it — 256, not 1024 (min) or 64 (median/max)", cap === 256, cap);
}
// the per-triangle measure against an INDEPENDENT reference — √λmin of T·(EᵀE)⁻¹·Tᵀ (E the world edges as columns, T
// the texel edges), a different route to the same singular value — exactly, not through a power-of-two cap that could
// hide a swapped term (407 vs 512 both round to 512)
{
  const ref = (f: number[], g: number[], t1: number[], t2: number[]) => {
    const a = f[0] * f[0] + f[1] * f[1] + f[2] * f[2], b = f[0] * g[0] + f[1] * g[1] + f[2] * g[2], c = g[0] * g[0] + g[1] * g[1] + g[2] * g[2];
    const det = a * c - b * b, i00 = c / det, i01 = -b / det, i11 = a / det;   // (EᵀE)⁻¹
    // M = T · Ginv · Tᵀ, T = [[t1x, t2x], [t1y, t2y]]
    const T = [[t1[0], t2[0]], [t1[1], t2[1]]], G = [[i00, i01], [i01, i11]];
    const TG = [[T[0][0] * G[0][0] + T[0][1] * G[1][0], T[0][0] * G[0][1] + T[0][1] * G[1][1]], [T[1][0] * G[0][0] + T[1][1] * G[1][0], T[1][0] * G[0][1] + T[1][1] * G[1][1]]];
    const m00 = TG[0][0] * T[0][0] + TG[0][1] * T[0][1], m01 = TG[0][0] * T[1][0] + TG[0][1] * T[1][1], m11 = TG[1][0] * T[1][0] + TG[1][1] * T[1][1];
    const tr = m00 + m11, dd = m00 * m11 - m01 * m01; return Math.sqrt((tr - Math.sqrt(Math.max(0, tr * tr - 4 * dd))) / 2);
  };
  const rot = (t: number[], a: number) => [t[0] * Math.cos(a) - t[1] * Math.sin(a), t[0] * Math.sin(a) + t[1] * Math.cos(a)];
  const cases: [string, number[], number[], number[], number[]][] = [
    ["sheared UVs", [1, 0, 0], [0.3, 0, 1], [300, 0], [250, 900]],
    ["rotated UVs (37°)", [2, 0, 0], [0, 0, 1], rot([400, 0], 0.645), rot([0, 700], 0.645)],
    ["mirrored UVs", [1, 0, 0], [0, 1, 0], [-512, 0], [0, 128]],
    ["a tilted triangle, a short first edge", [0.01, 0.02, 0], [0.4, -0.1, 0.9], [3, 5], [120, 410]],
    ["non-square map, anisotropic", [3, 0, 0], [0, 0, 0.5], [2048, 0], [0, 64]],
  ];
  const bad = cases.map(([n, f, g, t1, t2]) => [n, minTexelDensity(f, g, t1, t2), ref(f, g, t1, t2)] as const).filter(([, d, r]) => !(Math.abs(d - r) <= 1e-9 * r));
  check("the per-axis density matches an independent reference exactly (sheared, rotated, mirrored, tilted, non-square)", bad.length === 0, bad);
  check("…and a degenerate triangle is 0, never NaN", minTexelDensity([1, 0, 0], [2, 0, 0], [5, 0], [0, 5]) === 0 && minTexelDensity([0, 0, 0], [1, 0, 0], [5, 0], [0, 5]) === 0);
}
// ANISOTROPY: the least dense AXIS binds, not the geometric mean of the two
function mapped(w: number, d: number, tw: number, th: number) {   // a w × d metre quad, UV 0..1 over a tw × th map
  const doc = new Document(); const buf = doc.createBuffer();
  const t = doc.createTexture("m").setImage(pngHeader(tw, th)).setMimeType("image/png");
  const prim = doc.createPrimitive().setMaterial(doc.createMaterial("m").setBaseColorTexture(t))
    .setAttribute("POSITION", doc.createAccessor().setType("VEC3").setArray(new Float32Array([0, 0, 0, w, 0, 0, w, 0, d, 0, 0, d])).setBuffer(buf))
    .setAttribute("TEXCOORD_0", doc.createAccessor().setType("VEC2").setArray(new Float32Array([0, 0, 1, 0, 1, 1, 0, 1])).setBuffer(buf))
    .setIndices(doc.createAccessor().setType("SCALAR").setArray(new Uint32Array([0, 2, 1, 0, 3, 2])).setBuffer(buf));
  doc.createScene().addChild(doc.createNode("q").setMesh(doc.createMesh("q").addPrimitive(prim)));
  return { doc, t };
}
{ const strip = mapped(10, 1, 1024, 1024);   // u: 102.4 texels/m, v: 1024 — the geometric mean (324) read it as 3× over
  check("a stretched mapping binds on its stretched axis: a 10 m × 1 m strip at 100 texels/m keeps 1024 (u has 102/m), not 512",
    lodTexelCaps(strip.doc, 100).get(strip.t) === 1024, lodTexelCaps(strip.doc, 100).get(strip.t));
  const wide = mapped(1, 1, 2048, 512);      // u: 2048/m, v: 512/m → 2048 · 100 / 512 = 400 → 512
  check("a non-square map binds on its sparser axis: 2048×512 on 1 m² at 100 texels/m → 512 (v has 512/m), not 256",
    lodTexelCaps(wide.doc, 100).get(wide.t) === 512, lodTexelCaps(wide.doc, 100).get(wide.t)); }
// the ceiling: a 2048² source on a 40 m wall resolves more than the house cap — it gets the house cap, never 2048
{ const big = quad(40, 2048);   // 2048 texels over 40 m = 51/m; asking 1000/m would want all 2048 and more
  check("a LOD texture never exceeds the house cap: a 2048² source that would need all of it gets 1024", lodTexelCaps(big.doc, 1000).get(big.t) === KTX2_TEXEL_CAP, lodTexelCaps(big.doc, 1000).get(big.t)); }
// scale: the strictest instance wins, and every axis of a non-uniform scale counts
{
  const { doc } = quad(2, 1024), mesh = doc.getRoot().listMeshes()[0], node = doc.getRoot().listNodes()[0];
  node.setScale([1, 1, 10]);
  check("a non-uniform scale [1,1,10] budgets the mesh at its LARGEST axis (10)", Math.abs(meshWorldScale(mesh) - 10) < 1e-9, meshWorldScale(mesh));
  node.setScale([1, 1, 1]);
  doc.getRoot().listScenes()[0].addChild(doc.createNode("big").setScale([4, 4, 4]).setTranslation([10, 0, 0]).setMesh(mesh));
  check("a mesh drawn at ×1 and ×4 is simplified for the ×4 instance (its error bound is errWorld / 4)", Math.abs(meshWorldScale(mesh) - 4) < 1e-9, meshWorldScale(mesh));
  // texel density: the ×4 instance spreads the same texels over 16× the area, so IT binds — the caps must equal those
  // of the ×4 instance drawn alone, not the ×1 instance measured first
  const alone = quad(2, 1024, { scale: 1 }); alone.doc.getRoot().listNodes()[0].setScale([4, 4, 4]);
  const tpm = 20;
  check("texel density is measured over EVERY drawing instance (the ×4 one binds)",
    lodTexelCaps(doc, tpm).get(doc.getRoot().listTextures()[0]) === lodTexelCaps(alone.doc, tpm).get(alone.t), [lodTexelCaps(doc, tpm).get(doc.getRoot().listTextures()[0]), lodTexelCaps(alone.doc, tpm).get(alone.t)]);
}
check("the budget's diagonal is the full 3D one (a vertical 2 m quad: 2√2, not 2)", Math.abs(lodBudget(quad(2, 1024, { vertical: true }).doc).diag - 2 * Math.SQRT2) < 1e-9);
check("the near floor is 10 m, a contract: everything within reach is full detail with its collider", LOD_NEAR_MIN === 10, LOD_NEAR_MIN);

// the bounds gate, through optimizeGlbLod's mutation seam: a 0.5 m sphere (budget ~3.9 cm; 2% of its extent is 1 cm)
// reduces, then its outermost +x vertex is pushed further out by `push` metres
async function sphereGlb(unit: number, { seg = 48, ring = 32, png = null as Uint8Array | null, radius = 0.25 } = {}) {   // unit: positions authored at 1/unit metres, drawn under a 1/unit node
  const doc = new Document(); const buf = doc.createBuffer(); const P: number[] = [], I: number[] = [], UV: number[] = [];
  const rad = radius * unit;
  for (let r = 0; r <= ring; r++) for (let q = 0; q <= seg; q++) { const th = (r / ring) * Math.PI, ph = (q / seg) * Math.PI * 2;
    P.push(rad * Math.sin(th) * Math.cos(ph), rad * Math.cos(th), rad * Math.sin(th) * Math.sin(ph)); UV.push(q / seg, r / ring); }
  for (let r = 0; r < ring; r++) for (let q = 0; q < seg; q++) { const a = r * (seg + 1) + q, b = a + seg + 1; if (r > 0) I.push(a, a + 1, b); if (r < ring - 1) I.push(a + 1, b + 1, b); }
  const mat = doc.createMaterial("m");
  if (png) mat.setBaseColorTexture(doc.createTexture("t").setImage(png).setMimeType("image/png"));
  const prim = doc.createPrimitive().setMaterial(mat)
    .setAttribute("POSITION", doc.createAccessor().setType("VEC3").setArray(new Float32Array(P)).setBuffer(buf))
    .setIndices(doc.createAccessor().setType("SCALAR").setArray(new Uint32Array(I)).setBuffer(buf));
  if (png) prim.setAttribute("TEXCOORD_0", doc.createAccessor().setType("VEC2").setArray(new Float32Array(UV)).setBuffer(buf));
  doc.createScene().addChild(doc.createNode("s").setScale([1 / unit, 1 / unit, 1 / unit]).setMesh(doc.createMesh("s").addPrimitive(prim)));
  return new NodeIO().writeBinary(doc);
}
{
  const src = await sphereGlb(1);
  const push = (d: number, ax = 0) => (dd: Document) => {
    for (const m of dd.getRoot().listMeshes()) for (const p of m.listPrimitives()) {
      const pos = p.getAttribute("POSITION")!; let best = 0; const e = [0, 0, 0];
      for (let i = 0; i < pos.getCount(); i++) if (pos.getElement(i, e)[ax] > pos.getElement(best, [0, 0, 0])[ax]) best = i;
      pos.getElement(best, e); e[ax] += d; pos.setElement(best, e);
    }
  };
  const inBudget = await lodAtTestFloor(src, null, push(0.025));
  check("a 2.5 cm silhouette shift on a 0.5 m prop — over the old 1 cm gate, under the ~3.9 cm budget — is served", !!inBudget.out, { kind: inBudget.kind, verdict: inBudget.verdict });
  const spike = await lodAtTestFloor(src, null, push(0.08));
  check("an 8 cm shift, twice the budget, is still refused as a preservation failure", !spike.out && spike.kind === "preservation", { kind: spike.kind, verdict: spike.verdict });
  // the gate is WORLD space: the same sphere authored in centimetres under a 0.01 node, pushed 2.5 local units (2.5 cm)
  // — a raw-POSITION box reads 2.5 units against its 2% floor of 1 unit and refuses it
  const cm = await sphereGlb(100);
  const cmIn = await lodAtTestFloor(cm, null, push(2.5));
  check("…and it is judged in WORLD space: the same 2.5 cm push on a model authored in cm under a 0.01 node is served", !!cmIn.out, { kind: cmIn.kind, verdict: cmIn.verdict });
  const cmOut = await lodAtTestFloor(cm, null, push(8));
  check("…as is its 8 cm refusal", !cmOut.out && cmOut.kind === "preservation", { kind: cmOut.kind });
  check("…on EVERY axis: an 8 cm push along Y and along Z is refused too",
    (await Promise.all([1, 2].map((ax) => lodAtTestFloor(src, null, push(0.08, ax))))).every((r) => !r.out && r.kind === "preservation"));
  // the budget is WORLD metres divided by the node's scale ONCE: a 10 m sphere (its facets near the ~6 cm budget, so
  // the ERROR binds, not meshopt's 25% ratio floor) authored in cm reduces like the one authored in metres
  const bigM = await lodAtTestFloor(await sphereGlb(1, { radius: 10 }), null), bigCm = await lodAtTestFloor(await sphereGlb(100, { radius: 10 }), null);
  check("a model authored in cm under a 0.01 node reduces like the same model in metres (within 5%), where the error budget binds",
    !!bigM.out && !!bigCm.out && bigM.after > 0.3 * bigM.before && Math.abs(bigM.after - bigCm.after) <= 0.05 * bigM.after, [bigM.before, bigM.after, bigCm.after]);
  const mSph = await lodAtTestFloor(src, null);
  check("a smooth, seam-free sphere reduces on the REGULAR pass — the Permissive retry is only for when that can't reach the bar",
    !!mSph.out && mSph.permissive === false, mSph.permissive);
}
// texture-only: a faceted jagged 6 m field (every vertex on a hard edge — its vertices can't come under 0.6×) with a
// base-colour map. 1024² over 6 m is ~170 texels/m flat — less on its steepest facets, which bind — against the ~37
// its LOD distance resolves → 512², a quarter of the memory: served for its textures. The same field at 64² has nothing to give (the floor): refused as ineffective.
{
  const enc = findKtx2Encoder();
  check("(setup) a KTX2 encoder on this host — the texture-only checks need the real encoder", !!enc, null);
  async function field(texSize: number, F = 6, withSphere = false) {   // texSize 0: untextured; withSphere: + a smooth, reducible sphere
    const n = 40; let seed = 7; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const grid: number[][] = [];
    for (let z = 0; z <= n; z++) for (let x = 0; x <= n; x++) grid.push([F * x / n, F * (rnd() - 0.5) * 1.6 / n, F * z / n]);
    const P: number[] = [], N: number[] = [], T: number[] = [];
    for (let z = 0; z < n; z++) for (let x = 0; x < n; x++) {
      const a = z * (n + 1) + x, b = a + n + 1;
      for (const tri of [[a, b, a + 1], [a + 1, b, b + 1]]) {
        const [p, q, r] = tri.map((i) => grid[i]);
        const e1 = q.map((v, k) => v - p[k]), e2 = r.map((v, k) => v - p[k]);
        const fn = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]]; const l = Math.hypot(...fn) || 1;
        for (const i of tri) { P.push(...grid[i]); N.push(...fn.map((v) => -v / l)); T.push(grid[i][0] / F, grid[i][2] / F); }
      }
    }
    const doc = new Document(); const buf = doc.createBuffer();
    // noise, not a flat colour: prune() folds a solid-colour texture into its material factor and the map is gone
    const m = doc.createMaterial("m");
    if (texSize > 0) {
      const px = new Uint8Array(texSize * texSize * 3).map(() => Math.floor(rnd() * 256));
      const png = new Uint8Array(await sharp(px, { raw: { width: texSize, height: texSize, channels: 3 } }).png().toBuffer());
      m.setBaseColorTexture(doc.createTexture("t").setImage(png).setMimeType("image/png"));
    }
    const prim = doc.createPrimitive().setMaterial(m)
      .setAttribute("POSITION", doc.createAccessor().setType("VEC3").setArray(new Float32Array(P)).setBuffer(buf))
      .setAttribute("NORMAL", doc.createAccessor().setType("VEC3").setArray(new Float32Array(N)).setBuffer(buf))
      .setAttribute("TEXCOORD_0", doc.createAccessor().setType("VEC2").setArray(new Float32Array(T)).setBuffer(buf))
      .setIndices(doc.createAccessor().setType("SCALAR").setArray(new Uint32Array(P.length / 3).map((_, i) => i)).setBuffer(buf));
    doc.createScene().addChild(doc.createNode("f").setMesh(doc.createMesh("f").addPrimitive(prim)));
    if (withSphere) {
      // 221 vertices: few enough that the Permissive retry (the field alone reaches 0.65×) stays over the bar
      const S: number[] = [], SI: number[] = [], seg = 16, ring = 12;
      for (let r = 0; r <= ring; r++) for (let q = 0; q <= seg; q++) { const th = (r / ring) * Math.PI, ph = (q / seg) * Math.PI * 2;
        // 10 cm, inside the field's own bounds: the budget (off the world diagonal) is the field's alone
        S.push(F / 2 + 0.1 * Math.sin(th) * Math.cos(ph), 0.1 * Math.cos(th), F / 2 + 0.1 * Math.sin(th) * Math.sin(ph)); }
      for (let r = 0; r < ring; r++) for (let q = 0; q < seg; q++) { const a = r * (seg + 1) + q, b = a + seg + 1; if (r > 0) SI.push(a, a + 1, b); if (r < ring - 1) SI.push(a + 1, b + 1, b); }
      const sp = doc.createPrimitive().setMaterial(doc.createMaterial("s"))
        .setAttribute("POSITION", doc.createAccessor().setType("VEC3").setArray(new Float32Array(S)).setBuffer(buf))
        .setIndices(doc.createAccessor().setType("SCALAR").setArray(new Uint32Array(SI)).setBuffer(buf));
      doc.getRoot().listScenes()[0].addChild(doc.createNode("s").setMesh(doc.createMesh("s").addPrimitive(sp)));
    }
    return new NodeIO().writeBinary(doc);
  }
  if (enc) {
    const big = await lodAtTestFloor(await field(1024), enc);
    check("a 1024²-textured field whose vertices stay over 0.6× is served as a TEXTURE-ONLY LOD", !!big.out && big.texOnly === true && big.after > big.before * 0.6 && (big.texRatio ?? 1) <= LOD_TEX_ONLY,
      { kind: big.kind, verdict: big.verdict, before: big.before, after: big.after, texRatio: big.texRatio });
    // the caps must reach the FILE, not only the returned ratio: the base-colour map inside the LOD is 256², read off
    // the KTX2 header in the output GLB
    const dims = (out: Uint8Array) => { const { json, bin } = parseGlb(out); return (json.images ?? []).map((im: any) => {
      const bv = json.bufferViews[im.bufferView]; return new DataView(bin!.buffer, bin!.byteOffset + (bv.byteOffset ?? 0), bv.byteLength).getUint32(20, true); }); };
    const fieldDoc = await new NodeIO().readBinary(await field(1024));
    const want = lodTexelCaps(fieldDoc, lodBudget(fieldDoc).texelsPerMetre).get(fieldDoc.getRoot().listTextures()[0]);
    check(`…and the LOD FILE carries the capped map (${want}², what the field's density needs), not the 1024² the full tier has`,
      !!big.out && want! < 1024 && JSON.stringify(dims(big.out)) === JSON.stringify([want]), { file: big.out ? dims(big.out) : null, want });
    check("…on the REGULAR pass's geometry, not the Permissive retry's seam-crossing collapses", big.permissive === false, big.permissive);
    const small = await lodAtTestFloor(await field(64), enc);
    check("…and the same field at 64², with nothing to give, is refused as ineffective", !small.out && small.kind === "ineffective", { kind: small.kind, texRatio: small.texRatio });
    // a simplify that breaks a gate must not cost the texture saving: the regular pass is forced to move the bounds
    // (the mutation seam runs only when simplifying) — texture-only on the UNTOUCHED geometry
    const pushed = await lodAtTestFloor(await field(1024), enc, (dd: Document) => {
      const pos = dd.getRoot().listMeshes()[0].listPrimitives()[0].getAttribute("POSITION")!; const e = pos.getElement(0, [0, 0, 0]); e[1] += 2; pos.setElement(0, e); });
    check("a regular pass that breaks a gate still leaves a TEXTURE-ONLY LOD on the untouched geometry",
      !!pushed.out && pushed.texOnly === true && pushed.after === pushed.before, { kind: pushed.kind, verdict: pushed.verdict, after: pushed.after, before: pushed.before });
    // …and it IS the untouched geometry (the broken pass moved a vertex 2 m: the world bounds must be the source's), and
    // its caps reach the file (keyed to the untouched doc's own textures, not the discarded pass's)
    const reader = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ "draco3d.decoder": await draco3d.createDecoderModule() });
    const bb = async (bytes: Uint8Array) => getBounds((await reader.readBinary(bytes)).getRoot().listScenes()[0]);
    const srcB = await bb(await field(1024)), outB = pushed.out ? await bb(pushed.out) : null;
    check("…its geometry is the SOURCE's (world bounds unchanged), not the broken pass's",
      !!outB && [0, 1, 2].every((i) => Math.abs(outB.min[i] - srcB.min[i]) < 1e-3 && Math.abs(outB.max[i] - srcB.max[i]) < 1e-3), { srcB, outB });
    check("…and its maps are capped in the file", !!pushed.out && JSON.stringify(dims(pushed.out)) === JSON.stringify([want]), pushed.out ? dims(pushed.out) : null);
    // a regular pass that reduces PARTLY (not to the bar) and breaks nothing: texture-only rides ITS geometry — the
    // irreducible faceted field plus a smooth sphere that reduces, together over 0.6×
    const mixed = await lodAtTestFloor(await field(1024, 6, true), enc);
    check("a texture-only LOD on a regular pass that reduced part-way keeps that reduction (fewer vertices than the source)",
      !!mixed.out && mixed.texOnly === true && mixed.permissive === false && mixed.after < mixed.before && mixed.after > 0.6 * mixed.before,
      { kind: mixed.kind, verdict: mixed.verdict, before: mixed.before, after: mixed.after });
    // the texture-only LOD's stamp: its basis is the textures, and it is NOT labelled permissive (the card reads that)
    const extrasOf = (out: Uint8Array) => parseGlb(out).json?.asset?.extras ?? {};
    check("…stamped lodBasis 'textures', never 'permissive'", !!big.out && extrasOf(big.out).lodBasis === "textures" && extrasOf(big.out).simplify === undefined, big.out ? extrasOf(big.out) : null);
    // a 2 m field: the regular pass can't reach the bar, the Permissive retry can (09-29 scan: 9600 → ~1370)
    const permTex = await lodAtTestFloor(await field(1024, 2), enc);
    check("a Permissive geometry LOD carries CAPPED textures too (its own doc's caps reach the encoder)",
      !!permTex.out && permTex.permissive === true && dims(permTex.out)[0] < 1024, { permissive: permTex.permissive, dims: permTex.out ? dims(permTex.out) : null });
    const permBroken = await lodAtTestFloor(await field(0, 2), null, (dd: Document) => { dd.getRoot().listNodes()[0].setName("renamed"); });
    check("a Permissive retry that breaks a gate is refused — every gate applies to the retry, not only the regular pass",
      !permBroken.out && permBroken.kind === "preservation", { kind: permBroken.kind, verdict: permBroken.verdict });
    // under the vertex floor: nothing is simplified, but a heavy map still earns a texture-only LOD
    const noise = async (n: number) => { let sd = 11; const rr = () => ((sd = (sd * 16807) % 2147483647) / 2147483647);
      return new Uint8Array(await sharp(new Uint8Array(n * n * 3).map(() => Math.floor(rr() * 256)), { raw: { width: n, height: n, channels: 3 } }).png().toBuffer()); };
    const lightTex = await lodAtTestFloor(await new NodeIO().writeBinary(quad(2, 1024, { png: await noise(1024) }).doc), enc);
    check("a 4-vertex quad with a 1024² map — under the vertex floor — gets a TEXTURE-ONLY LOD, geometry untouched",
      !!lightTex.out && lightTex.texOnly === true && lightTex.after === lightTex.before && JSON.stringify(dims(lightTex.out)) !== "[1024]",
      { kind: lightTex.kind, verdict: lightTex.verdict, after: lightTex.after, before: lightTex.before, dims: lightTex.out ? dims(lightTex.out) : null });
    const lightPlain = await lodAtTestFloor(await new NodeIO().writeBinary(quad(2, 64, { png: await noise(64) }).doc), enc);
    check("…and the same quad with a 64² map is 'already light'", !lightPlain.out && lightPlain.kind === "light", { kind: lightPlain.kind, verdict: lightPlain.verdict });
    // under the floor nothing is SIMPLIFIED: an 841-vertex textured sphere (the 4-vertex quad can't show it — meshopt
    // can't reduce a quad) keeps every vertex in its texture-only LOD
    const under = await lodAtTestFloor(await sphereGlb(1, { seg: 28, ring: 28, png: await noise(1024) }), enc);
    check("an 841-vertex textured sphere under the floor: texture-only, every vertex kept", !!under.out && under.texOnly === true && under.after === under.before && under.before === 841,
      { kind: under.kind, verdict: under.verdict, before: under.before, after: under.after });
  }
}
console.log(`${fail ? "\x1b[31m" : "\x1b[32m"}${pass} passed, ${fail} failed\x1b[0m`); process.exit(fail ? 1 : 0);
