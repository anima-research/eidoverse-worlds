// store-variants — the store's serving shadows, named in one place.
//
// A store upload (content-addressed: assets/opt/store/<hash>.glb, immutable)
// gets TWO shadows, both built off the request path by upload.ts's serial
// optimize pump and both served by routes.ts on the ORIGINAL's address:
//
//   store-min/<hash>.glb        draco + webp@1024 — the unflagged answer, what
//                               every client without a KTX2 decoder gets
//   store/<hash>.glb.ktx2.glb   draco + KTX2 (the §20a diet) — the ?ktx2=<key>
//                               answer, beside the original exactly like every
//                               library variant (OPT_DIR/<rel>.ktx2.glb), which
//                               is the path the /library route already resolves
//
// The second shadow is what this module gives a name to. Before it, a KTX2-
// capable client asking for a store upload fell through to store-min: webp
// decodes to full RGBA8 on the GPU (a 1024² map with mips is ~5.3MB of VRAM)
// where KTX2 stays block-compressed (~1.4MB) and skips createImageBitmap
// entirely (§20: 1.0–1.2s/GLB of decode, 4–8× the VRAM). The library got that
// variant on day one; the conjured props that actually fill a world never did
// (#122's own evidence: store/305ea…glb?ktx2=1 → "draco + webp, and no KTX2
// at all").
//
// Beside-the-original carries the ghost-listing obligation (§20c): the variant
// ends in .glb too, so every place that enumerates store/*.glb — the catalog,
// the boot sweep — asks isStoreOriginal, never endsWith(".glb"); and every
// place that LISTS the opt tree (/library-list, which the prefetcher warms
// from) skips isKtx2Variant, or each variant is downloaded a second time under
// its own name.
//
// And one serving rule, in routes.ts: a flagged fetch (?ktx2=<key>, the key
// being shared/ktx2.js's — a generation, rotated when a flagged answer has
// been pinned wrong, as it had been under =1) that falls
// through to the webp shadow is PROVISIONAL for that URL — served no-cache,
// never immutable — because the variant may still be encoding, or the box may
// have no encoder yet. Content-addressed makes the ADDRESS immutable, not the
// flagged answer; pinned for a year, the variant never reaches that cache.
//
// DOM-free and side-effect-free: unit-tested in tools/store-variants-test.ts.

import { existsSync, readFileSync } from "node:fs";
import { join, basename } from "node:path";

/** The variant suffix. `<hash>.glb` + this = the KTX2 shadow's file name. */
export const KTX2_SUFFIX = ".ktx2.glb";

// ---- the texel budget ------------------------------------------------------
// The unflagged answer — the webp shadow every client without a KTX2 decoder
// gets — is capped at 1024² (optimize.ts, `resize: [1024, 1024]`; the
// library's day-one mirror is "draco+webp@1024" too). That is the house
// budget: what a model is allowed to look like in this world. The KTX2 arm
// used to encode from the full-resolution source instead — a Tripo conjure's
// 2048² maps, three of them, two UASTC — and the "variant" came out 1.5× the
// ORIGINAL on the wire (the show box, 2026-08-25: `not smaller (17600988 ->
// 26716692)`, sixteen times over), which the size gate rightly refused. A
// flagged fetch was a silent quality UPGRADE over the unflagged one at ~13×
// the bytes of the webp shadow. So: same budget as the shadow, GPU-native —
// downscale (never up) so the longest side is KTX2_TEXEL_CAP, 4-aligned for
// the block format. toktx does it (--resize) and libvips never touches it.
export const KTX2_TEXEL_CAP = 1024;

/** The resize a texture of `size` needs to fit the budget, or null when it
 *  already does. Aspect kept; both sides rounded to a multiple of 4. */
export function capTexels(size: [number, number] | null | undefined, cap = KTX2_TEXEL_CAP): [number, number] | null {
  if (!size || !(size[0] > 0) || !(size[1] > 0)) return null;
  const [w, h] = size;
  if (w <= cap && h <= cap) return null;
  const k = cap / Math.max(w, h);
  const r = (v: number) => Math.max(4, Math.round((v * k) / 4) * 4);
  return [r(w), r(h)];
}

// A size-gate verdict (`.failed` = "not smaller") is only as durable as the
// RECIPE that produced it: change the recipe and every refusal is a question
// again. So the CLI stamps the recipe into the verdict, and the sweeps treat
// a size verdict without the CURRENT stamp as stale — re-measured once, then
// re-stamped. The sixteen refusals above get retried the first boot after
// this lands, with no operator step. Content verdicts ("no convertible raster
// images", a corrupt container) carry no stamp and stand.
export const KTX2_RECIPE = "texel1024";
export const recipeStamp = (recipe = KTX2_RECIPE) => `recipe=${recipe}`;

// ---- the geometry LOD (objects only — v1 contract, PR #142 thread) ---------
// A far or VRAM-pressed client can ask for a decimated variant of a PLACEABLE
// OBJECT: `<rel>.lod1.glb` beside the original — weld + meshopt-simplify
// (the avatar importer's own proven diet) at LOD_RATIO, textures at the
// ktx2 texel budget, draco. BODIES ARE OUT OF SCOPE AND FAIL CLOSED, by
// positive structural detection, never filename folklore: skins / joint
// weights, VRM metadata, morph targets, morph-weight animation channels —
// any of them means NO variant and a typed verdict ("unsupported: skinned/
// avatar asset"), the original staying the only served representation. The
// variant binds its identity in asset.extras: source sha256 + this recipe +
// exact tool versions. Named nodes, materials, and bounds are asserted
// unchanged after the reduce — a failed assert is a typed verdict too, not
// a half-valid object.
export const LOD_RECIPE = "lod1-r25e01-texel1024";   // ratio 0.25, error 0.01, ktx2 texel budget
export const LOD_MIN_VERTS = 12_000;                 // under this, there is nothing worth reducing

/** A geometry-LOD serving artifact — ANY recipe generation's, not only the
 *  current one (old generations must stay unlisted and uncatalogued too). */
export function isLodVariant(name: string): boolean {
  return /\.lod\.[a-z0-9.-]+\.glb$/i.test(name);
}

/** Where the LOD shadow of an original lives: beside it, like the KTX2 one —
 *  and the RECIPE IS IN THE NAME, exactly as it is in the URL (review of
 *  #156, point 1): a new recipe is a new file under a new URL, so a recipe
 *  change can never serve yesterday's reduction under today's address. The
 *  old generation's file simply stops being asked for (and the pump deletes
 *  it when the new one lands). */
export function lodVariantPath(original: string, recipe = LOD_RECIPE): string {
  return `${original}.lod.${recipe}.glb`;
}

/** Does a `.failed` verdict still stand under the current recipe? A size
 *  verdict ("not smaller") stands only if it carries the current stamp;
 *  anything else stands regardless. */
export function verdictStands(content: string, recipe = KTX2_RECIPE): boolean {
  if (!/not smaller/i.test(content)) return true;
  return content.includes(recipeStamp(recipe));
}

/** Any KTX2 serving artifact, of any asset class: `<rel>.ktx2.glb` (models,
 *  library and store), `<rel>.ktx2.vrm` (bodies, §20c), `<img>.ktx2` (loose
 *  toolkit images, §20d). Reached only through the ORIGINAL's path + the
 *  ?ktx2=<key> negotiation; never a listing entry of its own. */
export function isKtx2Variant(name: string): boolean {
  return /\.ktx2(\.glb|\.vrm)?$/i.test(name);
}

/** Anything the opt tree holds that is not an asset a client addresses by
 *  name: a KTX2 variant, a `.failed` marker (the pump's diagnostic verdict on
 *  a pass), a `.tmp` (a pass mid-write). None is a listing entry — the
 *  prefetcher pushes every listed store path as a fetch, and a marker fetched
 *  as a model is a 404 on a good day. */
export function isServingArtifact(name: string): boolean {
  return isKtx2Variant(name) || isLodVariant(name) || /\.(failed|tmp)$/i.test(name);
}

/** Is this store/ entry an upload, as opposed to a variant of one? The
 *  predicate every store/*.glb enumeration must use (catalog, boot sweep):
 *  a variant is the SAME model, not a second catalog entry and not a
 *  candidate for its own shadows. */
export function isStoreOriginal(name: string): boolean {
  return name.endsWith(".glb") && !isKtx2Variant(name) && !isLodVariant(name);
}

/** Where the KTX2 shadow of a store original lives: beside it, `<path>.ktx2.glb`
 *  — routes.ts's own resolution for a flagged fetch (`${rel}.ktx2.glb` under
 *  OPT_DIR), so serving needs no change to find it. */
export function ktx2VariantPath(original: string): string {
  return `${original}${KTX2_SUFFIX}`;
}

/** Which shadows a store original still lacks. A `.failed` marker counts as
 *  present — the pass already gave its answer (not smaller / not convertible)
 *  and the sweep must not re-measure it every boot — EXCEPT a KTX2 size
 *  verdict from an older recipe (verdictStands), which is a question again.
 *  `exists`/`read` are injectable for tests; production reads the disk. */
export function storeShadowsMissing(
  original: string,
  minDir: string,
  exists: (p: string) => boolean = existsSync,
  read: (p: string) => string = (p) => { try { return readFileSync(p, "utf8"); } catch { return ""; } },
): { min: boolean; ktx2: boolean; lod: boolean } {
  const min = join(minDir, basename(original));
  const k = ktx2VariantPath(original);
  const kFailed = `${k}.failed`;
  const l = lodVariantPath(original);
  const lFailed = `${l}.failed`;
  return {
    min: !exists(min) && !exists(`${min}.failed`),
    ktx2: !exists(k) && !(exists(kFailed) && verdictStands(read(kFailed))),
    lod: !exists(l) && !(exists(lFailed) && verdictStands(read(lFailed), LOD_RECIPE)),
  };
}
