// bun tools/assets/ktx2-tf-purge.ts <OPT_DIR> [--apply] — list (with --apply, delete) KTX2 variants built before the
// transfer fix: linear data maps (normal/roughness/occlusion) that `ktx create` wrote with the sRGB curve baked in.
// Variants whose images carry optimize.ts KTX2_TF_MARK are current and skipped; a loose <img>.ktx2 has no mark, so every
// linear one is listed (run once, after deploying the fix). sRGB images were never affected. It also lists a variant whose
// unmarked images exceed KTX2_TEXEL_CAP² (built before the cap), and each purged variant's .failed/.deferred markers.
// After --apply, restart: the boot sweep (upload.ts) rebuilds what is missing, and VARIANT_CC (routes.ts) lets caches
// pick the new bytes up within about a minute. No key bump needed.
import { parseGlb } from "../../server/glbparse.ts";
import { KTX2_TF_MARK } from "../../server/optimize.ts";
import { KTX2_TEXEL_CAP } from "../../server/store-variants.ts";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { Glob } from "bun";


/** Is this KTX2 container a ktx-create image with a LINEAR transfer? */
export function convertedLinear(b: Uint8Array): boolean {
  if (b.length < 80 || b[0] !== 0xab || b[1] !== 0x4b) return false;
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const dfd = dv.getUint32(48, true), kvd = dv.getUint32(56, true), kvl = dv.getUint32(60, true);
  if (dfd + 15 > b.length) return false;
  const kv = new TextDecoder().decode(b.subarray(kvd, Math.min(b.length, kvd + kvl)));
  return b[dfd + 4 + 10] === 1 && /ktx create/.test(kv);
}

/** Is this KTX2 container wider or taller than today's texel cap? (pixelWidth/Height at +20/+24.) A variant built
 *  before the cap keeps its 2048² images forever — a key bump changes the URL, never the file. */
export function overCap(b: Uint8Array, cap = KTX2_TEXEL_CAP): boolean {
  if (b.length < 28 || b[0] !== 0xab || b[1] !== 0x4b) return false;
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  return Math.max(dv.getUint32(20, true), dv.getUint32(24, true)) > cap;
}

/** A variant to purge for SIZE: only unmarked images (a marked one came from today's pipeline, and purging it would
 *  rebuild the same bytes every run). Never an avatar: the VRM arm does not resize. */
export function staleOversize(file: string, imgs: { marked: boolean; bytes: Uint8Array | null }[]): boolean {
  if (/\.vrm$/.test(file)) return false;
  return imgs.some((im) => !im.marked && !!im.bytes && overCap(im.bytes));
}

if (import.meta.main) {
const root = process.argv[2];
const apply = process.argv.includes("--apply");
if (!root) { console.error("usage: bun tools/assets/ktx2-tf-purge.ts <OPT_DIR> [--apply]"); process.exit(2); }
const hits: string[] = [], big: string[] = []; let bigAll = 0;   // a file with BOTH is listed once, counted in both
for (const f of new Glob("**/*").scanSync({ cwd: root, onlyFiles: true })) {
  const path = `${root}/${f}`;
  if (f.endsWith(".ktx2")) { if (convertedLinear(new Uint8Array(readFileSync(path)))) hits.push(f); continue; }
  if (!/\.ktx2\.(glb|vrm)$|\.lod\.[^/]*\.glb$/.test(f)) continue;
  let json: any, bin: Uint8Array;
  try { ({ json, bin } = parseGlb(new Uint8Array(readFileSync(path)))); } catch { continue; }
  const ktx = (im: any) => { const bv = json.bufferViews?.[im.bufferView]; return bv ? bin.subarray(bv.byteOffset ?? 0, (bv.byteOffset ?? 0) + bv.byteLength) : null; };
  const imgs = (json.images ?? []).filter((im: any) => im.mimeType === "image/ktx2");
  const bad = imgs.some((im: any) => { if (im.extras?.[KTX2_TF_MARK]) return false; const b = ktx(im); return !!b && convertedLinear(b); });
  const isBig = staleOversize(f, imgs.map((im: any) => ({ marked: !!im.extras?.[KTX2_TF_MARK], bytes: ktx(im) })));
  if (isBig) bigAll++;
  if (bad) hits.push(f); else if (isBig) big.push(f);
}
for (const f of hits) console.log(`  ${apply ? "deleted" : "would delete"} ${f}  (converted data map)`);
for (const f of big) console.log(`  ${apply ? "deleted" : "would delete"} ${f}  (textures over ${KTX2_TEXEL_CAP}² — built before the cap)`);
// a purged variant's verdict markers go with it: a standing verdict would stop the sweep from rebuilding it (#207)
const markers = [...hits, ...big].flatMap((f) => [`${f}.failed`, `${f}.deferred`]).filter((m) => existsSync(`${root}/${m}`));
for (const m of markers) console.log(`  ${apply ? "deleted" : "would delete"} ${m}  (its variant is purged: the sweep must be free to rebuild it)`);
if (apply) for (const f of [...hits, ...big, ...markers]) rmSync(`${root}/${f}`);
console.log(`${hits.length + big.length} variant(s): ${hits.length} with converted data maps, ${bigAll} over the ${KTX2_TEXEL_CAP}² texel cap (${big.length} of those for that alone)${apply ? " — deleted; restart and the boot sweep rebuilds them" : " (dry run; --apply deletes)"}`);
}
