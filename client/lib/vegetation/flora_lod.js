// flora_lod — blade-level LOD index subsets for tiled 'blades' strokes,
// DOM-free (unit-tested in test/client/flora-test.ts).
//
// The upstream tuft (vegetation.js bunchGeometry) builds each blade as a CONTIGUOUS run: 10 vertices, then 24 index
// entries referencing only its own 10. A far-LOD index keeps whole runs, still pointing into the SHARED vertex
// buffers, so it costs one small index buffer per stroke. The layout is re-verified entry by entry at runtime: version
// skew degrades to "no LOD" (null), never to a torn tuft.

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

// VERTEX LOD, the successor to the blade-count subset above: keeps EVERY blade (no count pop) but spans its
// quads across loops 0→2→4: 12 entries referencing 6 of the 10 verts. An index subset never renumbers vertices, so the
// dither's bladeId (vertexIndex / 10) still lands on the right blade.
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
