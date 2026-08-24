// store-variants — the store's serving shadows, named in one place.
//
// A store upload (content-addressed: assets/opt/store/<hash>.glb, immutable)
// gets TWO shadows, both built off the request path by upload.ts's serial
// optimize pump and both served by routes.ts on the ORIGINAL's address:
//
//   store-min/<hash>.glb        draco + webp@1024 — the unflagged answer, what
//                               every client without a KTX2 decoder gets
//   store/<hash>.glb.ktx2.glb   draco + KTX2 (the §20a diet) — the ?ktx2=1
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
// And one serving rule, in routes.ts: a flagged fetch (?ktx2=1) that falls
// through to the webp shadow is PROVISIONAL for that URL — served no-cache,
// never immutable — because the variant may still be encoding, or the box may
// have no encoder yet. Content-addressed makes the ADDRESS immutable, not the
// flagged answer; pinned for a year, the variant never reaches that cache.
//
// DOM-free and side-effect-free: unit-tested in tools/store-variants-test.ts.

import { existsSync } from "node:fs";
import { join, basename } from "node:path";

/** The variant suffix. `<hash>.glb` + this = the KTX2 shadow's file name. */
export const KTX2_SUFFIX = ".ktx2.glb";

/** Any KTX2 serving artifact, of any asset class: `<rel>.ktx2.glb` (models,
 *  library and store), `<rel>.ktx2.vrm` (bodies, §20c), `<img>.ktx2` (loose
 *  toolkit images, §20d). Reached only through the ORIGINAL's path + ?ktx2=1;
 *  never a listing entry of its own. */
export function isKtx2Variant(name: string): boolean {
  return /\.ktx2(\.glb|\.vrm)?$/i.test(name);
}

/** Is this store/ entry an upload, as opposed to a variant of one? The
 *  predicate every store/*.glb enumeration must use (catalog, boot sweep):
 *  a variant is the SAME model, not a second catalog entry and not a
 *  candidate for its own shadows. */
export function isStoreOriginal(name: string): boolean {
  return name.endsWith(".glb") && !isKtx2Variant(name);
}

/** Where the KTX2 shadow of a store original lives: beside it, `<path>.ktx2.glb`
 *  — routes.ts's own resolution for a flagged fetch (`${rel}.ktx2.glb` under
 *  OPT_DIR), so serving needs no change to find it. */
export function ktx2VariantPath(original: string): string {
  return `${original}${KTX2_SUFFIX}`;
}

/** Which shadows a store original still lacks. A `.failed` marker counts as
 *  present — the pass already gave its answer (not smaller / not convertible)
 *  and the sweep must not re-measure it every boot. `exists` is injectable
 *  for tests; production passes nothing and reads the disk. */
export function storeShadowsMissing(
  original: string,
  minDir: string,
  exists: (p: string) => boolean = existsSync,
): { min: boolean; ktx2: boolean } {
  const min = join(minDir, basename(original));
  const k = ktx2VariantPath(original);
  return {
    min: !exists(min) && !exists(`${min}.failed`),
    ktx2: !exists(k) && !exists(`${k}.failed`),
  };
}
