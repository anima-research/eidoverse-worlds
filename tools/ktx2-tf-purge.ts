// bun tools/ktx2-tf-purge.ts <OPT_DIR> [--apply] — find (and with --apply, delete) the KTX2 variants whose DATA maps
// had the sRGB→linear curve baked in by `ktx create` before the transfer fix (optimize.ts ktx2EncodeArgs --assign-tf).
// The boot sweep (upload.ts) rebuilds every missing variant on the next restart. Dry run by default: it lists.
//
// Which files: a ktx-create-written KTX2 image with a LINEAR transfer (a normal/roughness/occlusion map) —
//   inside a .ktx2.glb / .ktx2.vrm / .lod.*.glb: only when the image lacks optimize.ts's KTX2_TF_MARK (every image
//     encoded since the fix carries it), so a rerun after the rebuild finds nothing;
//   a loose <img>.ktx2: has no wrapper to carry a mark, so EVERY linear one is listed. Run this once, right after
//     deploying the fix; a second run would just rebuild those few images again (seconds each).
// Colour (sRGB) images were never affected: an sRGB source assigned an sRGB format is not converted.
//
// After --apply: restart; the sweep rebuilds what was purged. Built variants are served short-lived + revalidating
// (routes.ts VARIANT_CC), so browsers and nginx pick the rebuilt bytes up within about a minute — no key rotation
// needed for THAT. (A key bump is still how you force every variant to rebuild; that is a separate, deliberate call.)
import { parseGlb } from "../server/glbparse.ts";
import { KTX2_TF_MARK } from "../server/optimize.ts";
import { KTX2_TEXEL_CAP } from "../server/store-variants.ts";
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

/** A variant to purge for SIZE: only images the current encoder did NOT write (no KTX2_TF_MARK) — a marked image came
 *  from today's pipeline, so any size it kept is deliberate or environmental (no resizer on the host), and purging it
 *  would rebuild the same bytes and purge them again every run. Never an avatar: the VRM arm does not resize. */
export function staleOversize(file: string, imgs: { marked: boolean; bytes: Uint8Array | null }[]): boolean {
  if (/\.vrm$/.test(file)) return false;
  return imgs.some((im) => !im.marked && !!im.bytes && overCap(im.bytes));
}

if (import.meta.main) {
const root = process.argv[2];
const apply = process.argv.includes("--apply");
if (!root) { console.error("usage: bun tools/ktx2-tf-purge.ts <OPT_DIR> [--apply]"); process.exit(2); }
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
// a purged variant's verdict markers go with it: a variant can serve beside a .failed (a forced rebuild that failed
// keeps the old one), and every verdict but a stale size/tools one STANDS for the sweep, which would then never rebuild
// what this deleted (Greptile #207). The purge's promise is "the sweep rebuilds it": clear what would stop that.
const markers = [...hits, ...big].flatMap((f) => [`${f}.failed`, `${f}.deferred`]).filter((m) => existsSync(`${root}/${m}`));
for (const m of markers) console.log(`  ${apply ? "deleted" : "would delete"} ${m}  (its variant is purged: the sweep must be free to rebuild it)`);
if (apply) for (const f of [...hits, ...big, ...markers]) rmSync(`${root}/${f}`);
console.log(`${hits.length + big.length} variant(s): ${hits.length} with converted data maps, ${bigAll} over the ${KTX2_TEXEL_CAP}² texel cap (${big.length} of those for that alone)${apply ? " — deleted; restart and the boot sweep rebuilds them" : " (dry run; --apply deletes)"}`);
}
