// bun tools/lod-census.ts <libDir> [outDir] — what each candidate vertex FLOOR would do to a library, under this generation's
// reducer (its recipe: ratio, screen-space budget, texture-only share, texel cap; permissive retry; preservation and GPU
// gates): #207 review, blocker 2.
//
// The floor only decides which objects ENTER reduction; an object's LOD is the same at any floor it passes. So each model
// runs once, at the lowest floor asked for, and every floor's census is a filter on the original's vertex count.
// Per floor: objects that enter, built vs each typed refusal class, the permissive-only builds, and totals: vertices,
// triangles, bytes and decoded texture MB (glbperf's estimate) of the originals that got a LOD vs their LODs.
// Writes census.json (every model's row) and census.md to outDir. Sequential, one encoder at a time.
//   FLOORS=12000,1000,500,250 bun tools/lod-census.ts /path/to/models notes-dir
import { readdirSync, readFileSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { join, relative } from "node:path";
import { optimizeGlbLod, optimizeGlbKtx2 } from "../server/optimize.ts";
import { glbPerf } from "../server/glbperf.ts";
import { findKtx2Encoder } from "../server/tools-stamp.ts";
import { LOD_RECIPE, LOD_RATIO, LOD_TEX_ONLY } from "../server/store-variants.ts";

const [lib, outDir = "."] = process.argv.slice(2);
if (!lib) { console.error("usage: bun tools/lod-census.ts <libDir> [outDir]"); process.exit(2); }
const FLOORS = (process.env.FLOORS ?? "12000,1000,500,250").split(",").map(Number).sort((a, b) => b - a);
const MIN = FLOORS[FLOORS.length - 1];
const encoder = findKtx2Encoder();

const walk = (d: string): string[] => readdirSync(d).flatMap((n) => {
  const p = join(d, n);
  return statSync(p).isDirectory() ? walk(p) : /\.glb$/i.test(n) && !/\.(ktx2|lod\.[^.]+)\.glb$/i.test(n) ? [p] : [];
});
const files = walk(lib).sort();
type Row = { name: string; bytes: number; before: number; after: number; kind: string; verdict: string | null; permissive: boolean; texOnly: boolean;
  lodBytes: number | null; tris: number | null; lodTris: number | null; texMB: number | null; lodTexMB: number | null; ktx2TexMB: number | null; draws: number | null; ms: number };
const rows: Row[] = [];
console.log(`census: ${files.length} models under ${lib}, reducer ${LOD_RECIPE} (ratio ${LOD_RATIO}), run at floor ${MIN}, encoder ${encoder ?? "none"}`);
for (const f of files) {
  const bytes = new Uint8Array(readFileSync(f));
  const t0 = performance.now();
  let r: Awaited<ReturnType<typeof optimizeGlbLod>> | null = null, err: string | null = null;
  try { r = await optimizeGlbLod(bytes, encoder, undefined, { minVerts: MIN }); } catch (e: any) { err = String(e?.message ?? e).slice(0, 160); }
  const po = (() => { try { return glbPerf(bytes); } catch { return null; } })();
  const pl = r?.out ? (() => { try { return glbPerf(r!.out!); } catch { return null; } })() : null;
  // the fair baseline for textures: what a viewer is served up close (the KTX2 variant), not the raw original
  let ktx2TexMB: number | null = null;
  if (r?.out && encoder) try { const k = await optimizeGlbKtx2(bytes, encoder); ktx2TexMB = glbPerf(k.out ?? bytes)?.texMB ?? null; } catch { /* none */ }
  const row: Row = {
    name: relative(lib, f), bytes: bytes.length, before: r?.before ?? 0, after: r?.after ?? 0,
    kind: err ? "error" : r?.out ? "built" : (r?.kind ?? (r?.verdict === "__no_encoder__" ? "no-encoder" : "other")),
    verdict: err ?? r?.verdict ?? null, permissive: !!r?.permissive, texOnly: !!r?.texOnly, lodBytes: r?.out?.length ?? null,
    tris: po?.tris ?? null, lodTris: pl?.tris ?? null, texMB: po?.texMB ?? null, lodTexMB: pl?.texMB ?? null, ktx2TexMB, draws: po?.draws ?? null,
    ms: Math.round(performance.now() - t0),
  };
  rows.push(row);
  console.log(`  ${row.kind.padEnd(12)} ${String(row.before).padStart(7)} → ${String(row.after).padStart(7)}${row.permissive ? " (permissive)" : ""}${row.texOnly ? " (texture-only)" : ""}  ${row.name}`);
}

const sum = (xs: (number | null)[]) => xs.reduce<number>((a, x) => a + (x ?? 0), 0);
const fmt = (n: number) => n.toLocaleString("en-US");
const lines: string[] = [];
lines.push(`# LOD floor census`, ``, `Library: ${files.length} models. Reducer: \`${LOD_RECIPE}\` minus its floor (ratio ${LOD_RATIO}). ` +
  `Each model ran once at floor ${MIN}. At a higher floor, a model under it keeps its geometry but still gets a ` +
  `texture-only LOD when its LOD textures come to at most ${LOD_TEX_ONLY} of the KTX2 tier's (the reducer's rule): ` +
  `such rows are PROJECTED from the measured run (verts and tris unchanged, texture MB as measured, LOD bytes those of ` +
  `the measured LOD, an approximation); the rest read as light. ` +
  `Texture MB is glbperf's GPU-size estimate: raw images at full size, KTX2 at its compressed size. The KTX2 variant ` +
  `is what a viewer is served up close, so it is the fair baseline for what a LOD saves on textures. ` +
  `Animated, skinned and morph-target models are refused before counting (structural) at every floor and aren't in the rows.`, ``);
lines.push(`| Floor | Enter | Built | (permissive) | (texture-only) | Refused: light | ineffective | preservation | structural | gpu | size | other/error | Verts in → out | Tris in → out | Bytes in → out | Tex MB: raw / KTX2 variant → LOD |`);
lines.push(`|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|`);
// a model under floor F: geometry untouched; a texture-only LOD if its measured LOD textures qualify, else light
const atFloor = (r: any, F: number) => {
  if (r.before >= F || r.kind === "error" || r.kind === "structural") return r;
  if (r.kind === "built" && r.ktx2TexMB > 0 && r.lodTexMB / r.ktx2TexMB <= LOD_TEX_ONLY)
    return { ...r, texOnly: true, permissive: false, after: r.before, lodTris: r.tris };
  return { ...r, kind: "light" };
};
for (const F of FLOORS) {
  const enter = rows.filter((r) => r.kind !== "error").map((r) => atFloor(r, F));
  const built = enter.filter((r) => r.kind === "built");
  const k = (x: string) => enter.filter((r) => r.kind === x).length;
  lines.push(`| ${fmt(F)} | ${enter.length} | ${built.length} | ${built.filter((r) => r.permissive).length} | ${built.filter((r) => r.texOnly).length} | ${k("light")} | ${k("ineffective")} | ${k("preservation")} | ${k("structural")} | ${k("gpu")} | ${k("size")} | ${enter.length - built.length - ["light", "ineffective", "preservation", "structural", "gpu", "size"].reduce((a, x) => a + k(x), 0)} | ` +
    `${fmt(sum(built.map((r) => r.before)))} → ${fmt(sum(built.map((r) => r.after)))} | ${fmt(sum(built.map((r) => r.tris)))} → ${fmt(sum(built.map((r) => r.lodTris)))} | ` +
    `${fmt(sum(built.map((r) => r.bytes)))} → ${fmt(sum(built.map((r) => r.lodBytes)))} | ${sum(built.map((r) => r.texMB)).toFixed(1)} / ${sum(built.map((r) => r.ktx2TexMB)).toFixed(1)} → ${sum(built.map((r) => r.lodTexMB)).toFixed(1)} |`);
}
const band = (hi: number, lo: number) => rows.filter((r) => r.kind === "built" && r.before < hi && r.before >= lo);
lines.push(``, `## What each step down adds`, ``);
for (let i = 0; i + 1 < FLOORS.length; i++) {
  const b = band(FLOORS[i], FLOORS[i + 1]);
  lines.push(`- **${fmt(FLOORS[i + 1])}–${fmt(FLOORS[i])} verts**: ${b.length} more LODs, saving ${fmt(sum(b.map((r) => r.before - r.after)))} vertices in total ` +
    `(median original ${b.length ? fmt([...b].sort((x, y) => x.before - y.before)[b.length >> 1].before) : "-"}), at ${fmt(sum(b.map((r) => r.lodBytes)))} extra bytes of LOD files.`);
}
lines.push(``, `## Permissive-only, refused and errored models`, ``);
for (const r of rows.filter((r) => r.permissive || r.texOnly || (r.kind !== "built" && r.kind !== "light")))
  lines.push(`- \`${r.name}\`: ${r.kind}${r.permissive ? " (permissive retry)" : ""}${r.texOnly ? " (texture-only)" : ""}, ${fmt(r.before)} → ${fmt(r.after)} verts${r.verdict ? `: ${r.verdict.slice(0, 140)}` : ""}`);
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, "census.json"), JSON.stringify({ recipe: LOD_RECIPE, floors: FLOORS, runAt: MIN, encoder, rows }, null, 1));
writeFileSync(join(outDir, "census.md"), lines.join("\n") + "\n");
console.log("\n" + lines.join("\n"));
