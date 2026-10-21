// bun tools/lod-normals-test.ts — a served LOD keeps its shading: the reducer weighs normals and UVs (optimize.ts
// simplifyAttributes), so a collapse across a hard edge or a UV seam costs what it breaks.
//
// The bug this binds (09-29): gltf-transform's simplify() handed meshoptimizer positions only, and the permissive
// retry then collapsed freely across normal and UV seams — a hovercar lost a wheel and went dark along its flank, a
// Joshua tree's foliage went dull. Two synthetic models, so the test needs no library files:
//   - a FACETED jagged heightfield: every triangle carries its own normal, neighbours tens of degrees apart, so every vertex is on a seam and the regular pass can't
//     reduce; the permissive retry runs. Position-only, it smears the facet normals across neighbours. Whatever is served
//     must shade like the surface it covers (area with a vertex normal > 60° off its face ≤ 5%); refusing is fine.
//   - a SMOOTH UV sphere with a UV seam: the reducer must still reduce it (≤ 40% of its vertices), so a reducer that
//     refuses everything can't pass.
// Mutation witnessed red: normals and UVs weighted 0 in simplifyAttributes (= the old position-only behaviour).
import { Document, NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import draco3d from "draco3dgltf";
import { optimizeGlbLod } from "../server/optimize.ts";
// these tests exercise the REDUCER's mechanics on fixtures sized around a 1,000-vertex floor; the production floor
// (LOD_MIN_VERTS, a policy) is pinned in store-variants-test
const lodAtTestFloor = (b: Uint8Array, e: string | null, m?: (d: any) => void) => optimizeGlbLod(b, e, m, { minVerts: 1_000 });

let pass = 0, fail = 0;
const check = (n: string, ok: boolean, d: unknown = "") => { ok ? pass++ : fail++; console.log(`  ${ok ? "\x1b[32m✓" : "\x1b[31m✗"}\x1b[0m ${n}${ok ? "" : `  ${JSON.stringify(d)}`}`); };

function sphere(seg: number, ring: number) {
  const pos: number[][] = [], uv: number[][] = [];
  for (let r = 0; r <= ring; r++) for (let s = 0; s <= seg; s++) {
    const th = (r / ring) * Math.PI, ph = (s / seg) * Math.PI * 2;
    pos.push([Math.sin(th) * Math.cos(ph), Math.cos(th), Math.sin(th) * Math.sin(ph)]); uv.push([s / seg, r / ring]);
  }
  const tri: number[] = [];
  for (let r = 0; r < ring; r++) for (let s = 0; s < seg; s++) {
    const a = r * (seg + 1) + s, b = a + seg + 1;
    if (r > 0) tri.push(a, a + 1, b);
    if (r < ring - 1) tri.push(a + 1, b + 1, b);
  }
  return { pos, uv, tri };
}
// 6 m, not 1: the reducer's error budget is SCREEN-SPACE (gen 3: 2 px at the closest distance the LOD is shown), and the
// field's size decides whether its relief is above it. Scanned 09-29 (weighted 0.25/1 vs zeroed, off-shaded share):
//   1 m 14% vs 23% · 2 m 13% vs 23% · 3 m 10% vs 21% · 4 m 6% vs 17% · 6 m REFUSED vs 11% · 10 m refused vs refused.
// Below ~4 m the facets are ~1–4 px at the LOD distance and their shading is noise a viewer can't resolve; at 10 m the
// relief refuses either way and the weights bind nothing. 6 m is where the weights DECIDE: served smeared without them.
const FIELD = 6;
/** A jagged heightfield: seeded heights about the cell size, so neighbouring facets differ by tens of degrees — the
 *  hard edges a position-only collapse smears (a hovercar's arches), unlike a sphere's few-degree facets. */
function jagged(n: number) {
  let seed = 7; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const pos: number[][] = [], uv: number[][] = [], tri: number[] = [];
  for (let z = 0; z <= n; z++) for (let x = 0; x <= n; x++) { pos.push([FIELD * x / n, FIELD * (rnd() - 0.5) * 1.6 / n, FIELD * z / n]); uv.push([x / n, z / n]); }
  for (let z = 0; z < n; z++) for (let x = 0; x < n; x++) { const a = z * (n + 1) + x, b = a + n + 1; tri.push(a, b, a + 1, a + 1, b, b + 1); }
  return { pos, uv, tri };
}
async function glb(faceted: boolean) {
  const { pos, uv, tri } = faceted ? jagged(40) : sphere(48, 32);
  const doc = new Document(); const buf = doc.createBuffer();
  let P: number[] = [], N: number[] = [], T: number[] = [], I: number[] = [];
  if (faceted) {
    for (let t = 0; t < tri.length; t += 3) {
      const [a, b, c] = [pos[tri[t]], pos[tri[t + 1]], pos[tri[t + 2]]];
      const e1 = a.map((v, k) => b[k] - v), e2 = a.map((v, k) => c[k] - v);
      const fn = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
      const l = Math.hypot(...fn) || 1;
      for (const i of [tri[t], tri[t + 1], tri[t + 2]]) { P.push(...pos[i]); N.push(...fn.map((v) => -v / l)); T.push(...uv[i]); I.push(I.length); }
    }
  } else { P = pos.flat(); N = pos.flat(); T = uv.flat(); I = tri; }
  const prim = doc.createPrimitive()
    .setAttribute("POSITION", doc.createAccessor().setType("VEC3").setArray(new Float32Array(P)).setBuffer(buf))
    .setAttribute("NORMAL", doc.createAccessor().setType("VEC3").setArray(new Float32Array(N)).setBuffer(buf))
    .setAttribute("TEXCOORD_0", doc.createAccessor().setType("VEC2").setArray(new Float32Array(T)).setBuffer(buf))
    .setIndices(doc.createAccessor().setType("SCALAR").setArray(new Uint32Array(I)).setBuffer(buf))
    .setMaterial(doc.createMaterial("m"));
  doc.createScene().addChild(doc.createNode("sphere").setMesh(doc.createMesh("sphere").addPrimitive(prim)));
  return new NodeIO().writeBinary(doc);
}
/** Share of triangle area whose vertex normals point more than 60° away from the triangle's own facing (either side). */
const reader = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ "draco3d.decoder": await draco3d.createDecoderModule() });
async function offShading(bytes: Uint8Array) {
  const doc = await reader.readBinary(bytes);   // LODs ship Draco-compressed
  let area = 0, off = 0;
  for (const m of doc.getRoot().listMeshes()) for (const p of m.listPrimitives()) {
    const pos = p.getAttribute("POSITION")!, nor = p.getAttribute("NORMAL")!, idx = p.getIndices()!.getArray()!;
    for (let t = 0; t < idx.length; t += 3) {
      const [a, b, c] = [0, 1, 2].map((k) => pos.getElement(idx[t + k], [0, 0, 0]));
      const e1 = a.map((v, k) => b[k] - v), e2 = a.map((v, k) => c[k] - v);
      const fn = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
      const L = Math.hypot(...fn); if (!L) continue; area += L;
      let bad = 0;
      for (let k = 0; k < 3; k++) { const n = nor.getElement(idx[t + k], [0, 0, 0]); if (Math.abs(n[0] * fn[0] + n[1] * fn[1] + n[2] * fn[2]) / (L * (Math.hypot(...n) || 1)) < 0.5) bad++; }
      off += (L * bad) / 3;
    }
  }
  return off / area;
}

const facetedSrc = await glb(true), smoothSrc = await glb(false);
check("(setup) the faceted source shades like its surface", (await offShading(facetedSrc)) < 0.01, await offShading(facetedSrc));
const f = await lodAtTestFloor(facetedSrc, null);
const fOff = f.out ? await offShading(f.out) : 0;
console.log(`  · faceted: ${f.out ? `LOD ${f.before}→${f.after}${f.permissive ? " (permissive)" : ""}, off-shaded ${(100 * fOff).toFixed(1)}%` : `refused ${f.kind}: ${f.verdict}`}`);
check("faceted jagged field: a served LOD shades like its surface (≤ 5% of area > 60° off), or none is served", !f.out || fOff <= 0.05, { after: f.after, fOff });
const s = await lodAtTestFloor(smoothSrc, null);
const sOff = s.out ? await offShading(s.out) : 1;
console.log(`  · smooth:  ${s.out ? `LOD ${s.before}→${s.after}${s.permissive ? " (permissive)" : ""}, off-shaded ${(100 * sOff).toFixed(1)}%` : `refused ${s.kind}: ${s.verdict}`}`);
check("smooth UV sphere: still reduced to ≤ 40% of its vertices", !!s.out && s.after <= s.before * 0.4, { before: s.before, after: s.after, kind: s.kind });
check("…and it shades like its surface", sOff <= 0.05, sOff);
console.log(`${fail ? "\x1b[31m" : "\x1b[32m"}${pass} passed, ${fail} failed\x1b[0m`); process.exit(fail ? 1 : 0);
