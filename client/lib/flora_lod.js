// flora_lod — blade-level LOD index subsets for tiled 'blades' strokes,
// DOM-free (unit-tested in tools/flora.test.ts). §17b.
//
// The upstream tuft (vegetation.js bunchGeometry) builds perBunch blades as
// CONTIGUOUS runs: each blade pushes (LOOPS+1)×2 = 10 vertices, then LOOPS×6
// = 24 index entries referencing only its own 10 (meadow grass 8 blades →
// 80 verts/192 entries; galleta 34 → 340/816). A far-LOD geometry keeps
// whole blades by keeping whole 24-entry runs: the subset index still points
// into the SHARED vertex buffers — dropped blades' vertices simply go
// unreferenced — so the far variant costs one small index buffer per stroke
// and not one byte of copied vertex data.
//
// The layout is verified against the construction loop upstream AND
// re-verified structurally here at runtime, entry by entry: version skew in
// vegetation.js degrades to "no LOD" (null), never to a torn tuft.

export const BLADE_VERTS = 10;    // (LOOPS+1) × 2 — vegetation.js LOOPS = 4
export const BLADE_INDICES = 24;  // LOOPS × 6

/** Far-LOD index subset: keep ceil(blades × keep) whole blades, evenly
 *  strided across the tuft (every kth blade, NOT the first k — construction
 *  order scatters blades radially, so a stride keeps the tuft balanced).
 *  `index` is the source index array, `vertexCount` the geometry's position
 *  count, `keep` the fraction of blades the far field draws. Returns a
 *  same-typed array of index entries, or null when the geometry is not
 *  blade-shaped or the subset would not actually drop anything. */
export function bladeLodIndex(index, vertexCount, keep) {
  if (!index || !(keep > 0) || keep >= 1) return null;
  const blades = index.length / BLADE_INDICES;
  if (!Number.isInteger(blades) || blades < 2) return null;
  if (vertexCount !== blades * BLADE_VERTS) return null;
  for (let b = 0; b < blades; b++) {          // whole-blade contiguity proof
    const lo = b * BLADE_VERTS, hi = lo + BLADE_VERTS;
    for (let e = b * BLADE_INDICES; e < (b + 1) * BLADE_INDICES; e++) {
      const v = index[e];
      if (v < lo || v >= hi) return null;     // cross-blade reference: not our layout
    }
  }
  const kept = Math.ceil(blades * keep);
  if (kept >= blades) return null;            // nothing to save
  const out = new index.constructor(kept * BLADE_INDICES);
  for (let i = 0; i < kept; i++) {
    const b = Math.floor((i * blades) / kept);    // even stride across the tuft
    const s = b * BLADE_INDICES, d = i * BLADE_INDICES;
    for (let e = 0; e < BLADE_INDICES; e++) out[d + e] = index[s + e];
  }
  return out;
}

// §22n — VERTEX LOD, the successor to the retired blade-count subset above.
// With opaque blades (§22m) the fragment bill collapsed and the vertex
// program became the far field's cost. The coarse index keeps EVERY blade
// (no count pop — the §22d lesson) but spans its quads across loops 0→2→4
// instead of 0→1→2→3→4: 12 index entries referencing 6 of the blade's 10
// verts. Same fitted silhouette sampled coarser, same shared buffers, and —
// because an index subset never renumbers vertices — the §22h dither's
// bladeId (vertexIndex / 10) still lands on the right blade.
export const BLADE_COARSE_INDICES = 12;   // 2 quads: loops 0→2→4
const COARSE_QUADS = [0, 1, 4, 1, 5, 4, 4, 5, 8, 5, 9, 8];  // original winding, loops skipped

/** Coarse far index: every blade at 2 segments instead of 4. Same structural
 *  proof as bladeLodIndex — version skew degrades to null, never a torn tuft. */
export function bladeCoarseIndex(index, vertexCount) {
  if (!index) return null;
  const blades = index.length / BLADE_INDICES;
  if (!Number.isInteger(blades) || blades < 1) return null;
  if (vertexCount !== blades * BLADE_VERTS) return null;
  for (let b = 0; b < blades; b++) {          // whole-blade contiguity proof
    const lo = b * BLADE_VERTS, hi = lo + BLADE_VERTS;
    for (let e = b * BLADE_INDICES; e < (b + 1) * BLADE_INDICES; e++) {
      const v = index[e];
      if (v < lo || v >= hi) return null;     // cross-blade reference: not our layout
    }
  }
  const out = new index.constructor(blades * BLADE_COARSE_INDICES);
  for (let b = 0; b < blades; b++) {
    const base = b * BLADE_VERTS, d = b * BLADE_COARSE_INDICES;
    for (let e = 0; e < BLADE_COARSE_INDICES; e++) out[d + e] = base + COARSE_QUADS[e];
  }
  return out;
}
