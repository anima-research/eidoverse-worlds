// server/solids.ts — a model's solid parts, measured from its triangles (review 10-06 S0-3: nobody could walk into a
// building, because the authority took each model's ONE bounding box as solid).
//
// The authority already reads a catalogue entry's `solids` (boxes in the model's frame; shared/protocol/authority.js obbs): the lab's
// shelf and swing frame are hand-written that way. This measures them for a library model, from the same triangles the
// client renders:
//   1. surface voxels: every triangle is sampled densely enough that no cell it crosses is missed; each cell keeps the
//      tight bounds of the geometry inside it (a floor slab's cell ends at the floor's top, not the cell's);
//   2. the outside: empty cells reachable from the box's boundary (6-connected) are outside. Empty cells NOT reachable
//      are enclosed (a crate's inside, a closed hut's) and count as solid: an authority can't take a body into a closed box.
//      A house with a doorway is reached through it, so its rooms stay open;
//   3. the solid cells are merged greedily into boxes (x, then z, then y), each the union of its cells' bounds.
// Only models with room for a body inside them are measured (at least minHeight tall and minSpan across): furniture
// and props keep their bounding box, as does anything past the limits (null): conservative, and what the authority did before.
type V3 = [number, number, number];
export const SOLIDS = { minHeight: 2, minSpan: 2, maxBoxes: 128, maxCells: 160_000, maxSamples: 6_000_000, cellsAcross: 32, minCell: 0.08 };

/** Boxes [[lo], [hi]] in the model's frame covering what's solid in `soup` (x,y,z per vertex, 3 vertices per triangle),
 *  or null when the bounding box should stand (small, too big to measure, or too many boxes). */
export function solidsFromTriangles(soup: ArrayLike<number>, min: number[], max: number[]): number[][][] | null {
  const size = [0, 1, 2].map((i) => max[i] - min[i]); const big = Math.max(...size);
  if (!(size[1] >= SOLIDS.minHeight && Math.max(size[0], size[2]) >= SOLIDS.minSpan) || !size.every(Number.isFinite) || soup.length < 9) return null;
  for (let cell = Math.max(big / SOLIDS.cellsAcross, SOLIDS.minCell); cell <= big / 3; cell *= 1.5) {
    const r = attempt(soup, min, size, cell);
    if (r === "too-big") continue;   // the budget is per attempt: a coarser cell takes fewer samples
    if (r && r.length <= SOLIDS.maxBoxes) return r;
  }
  return null;
}

function attempt(soup: ArrayLike<number>, min: number[], size: number[], cell: number): number[][][] | null | "too-big" {
  const n = size.map((s) => Math.max(1, Math.ceil(s / cell - 1e-9))) as V3; const [nx, ny, nz] = n; const N = nx * ny * nz;
  if (N > SOLIDS.maxCells) return null;   // a coarser cell next
  const idx = (i: number, j: number, k: number) => (k * ny + j) * nx + i;
  const occ = new Uint8Array(N); const lo = new Float64Array(N * 3).fill(Infinity), hi = new Float64Array(N * 3).fill(-Infinity);
  const put = (x: number, y: number, z: number) => {
    const i = Math.min(nx - 1, Math.max(0, Math.floor((x - min[0]) / cell))), j = Math.min(ny - 1, Math.max(0, Math.floor((y - min[1]) / cell))), k = Math.min(nz - 1, Math.max(0, Math.floor((z - min[2]) / cell)));
    const c = idx(i, j, k); occ[c] = 1; const b = c * 3;
    if (x < lo[b]) lo[b] = x; if (x > hi[b]) hi[b] = x; if (y < lo[b + 1]) lo[b + 1] = y; if (y > hi[b + 1]) hi[b + 1] = y; if (z < lo[b + 2]) lo[b + 2] = z; if (z > hi[b + 2]) hi[b + 2] = z; };
  // 1. surface cells: each triangle split at its longest edge until every piece is under half a cell, and every piece's
  // corners and centre sampled (a sliver costs its length, not its length squared)
  let samples = 0; const step = cell / 2, step2 = step * step; const tri: number[] = [];
  for (let t = 0; t + 8 < soup.length; t += 9) {
    tri.length = 0; for (let q = 0; q < 9; q++) tri.push(soup[t + q]);
    if (!tri.every(Number.isFinite)) continue;
    while (tri.length) {
      const cz = tri.pop()!, cy = tri.pop()!, cx = tri.pop()!, bz = tri.pop()!, by = tri.pop()!, bx = tri.pop()!, az = tri.pop()!, ay = tri.pop()!, ax = tri.pop()!;
      const ab = (bx - ax) ** 2 + (by - ay) ** 2 + (bz - az) ** 2, bc = (cx - bx) ** 2 + (cy - by) ** 2 + (cz - bz) ** 2, ca = (ax - cx) ** 2 + (ay - cy) ** 2 + (az - cz) ** 2;   // squared
      if (ab <= step2 && bc <= step2 && ca <= step2) { put(ax, ay, az); put(bx, by, bz); put(cx, cy, cz); put((ax + bx + cx) / 3, (ay + by + cy) / 3, (az + bz + cz) / 3);
        if ((samples += 4) > SOLIDS.maxSamples) return "too-big"; continue; }
      // split the longest edge at its middle: two triangles
      if (ab >= bc && ab >= ca) { const mx = (ax + bx) / 2, my = (ay + by) / 2, mz = (az + bz) / 2; tri.push(ax, ay, az, mx, my, mz, cx, cy, cz, mx, my, mz, bx, by, bz, cx, cy, cz); }
      else if (bc >= ca) { const mx = (bx + cx) / 2, my = (by + cy) / 2, mz = (bz + cz) / 2; tri.push(ax, ay, az, bx, by, bz, mx, my, mz, ax, ay, az, mx, my, mz, cx, cy, cz); }
      else { const mx = (cx + ax) / 2, my = (cy + ay) / 2, mz = (cz + az) / 2; tri.push(ax, ay, az, bx, by, bz, mx, my, mz, mx, my, mz, bx, by, bz, cx, cy, cz); }
    }
  }
  // samples land up to a step short of a cell's face; where the geometry carries on into the next cell, the face is its
  // bound (so a floor's cells abut exactly and merge). A bound further from the face than a step is the geometry's own.
  for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) { const c = idx(i, j, k); if (!occ[c]) continue; const b = c * 3; const g = [i, j, k];
    for (let a = 0; a < 3; a++) { const f0 = min[a] + g[a] * cell, f1 = f0 + cell;
      const nb = (d: number) => { const h = g.slice(); h[a] += d; return h[a] >= 0 && h[a] < n[a] && occ[idx(h[0], h[1], h[2])] === 1; };
      if (lo[b + a] - f0 < step * 1.01 && nb(-1)) lo[b + a] = f0;
      if (f1 - hi[b + a] < step * 1.01 && nb(1)) hi[b + a] = f1; } }
  // 2. the outside: empty cells reached from the boundary
  const out = new Uint8Array(N); const q: number[] = [];
  const seed = (i: number, j: number, k: number) => { const c = idx(i, j, k); if (!occ[c] && !out[c]) { out[c] = 1; q.push(c); } };
  for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) if (i === 0 || j === 0 || k === 0 || i === nx - 1 || j === ny - 1 || k === nz - 1) seed(i, j, k);
  while (q.length) { const c = q.pop()!; const i = c % nx, j = Math.floor(c / nx) % ny, k = Math.floor(c / (nx * ny));
    if (i > 0) seed(i - 1, j, k); if (i < nx - 1) seed(i + 1, j, k); if (j > 0) seed(i, j - 1, k); if (j < ny - 1) seed(i, j + 1, k); if (k > 0) seed(i, j, k - 1); if (k < nz - 1) seed(i, j, k + 1); }
  const solid = (c: number) => occ[c] === 1 || out[c] === 0;
  // an enclosed (unreached, empty) cell is solid through and through
  for (let c = 0; c < N; c++) if (!occ[c] && !out[c]) { const i = c % nx, j = Math.floor(c / nx) % ny, k = Math.floor(c / (nx * ny)); const b = c * 3;
    lo[b] = min[0] + i * cell; hi[b] = min[0] + (i + 1) * cell; lo[b + 1] = min[1] + j * cell; hi[b + 1] = min[1] + (j + 1) * cell; lo[b + 2] = min[2] + k * cell; hi[b + 2] = min[2] + (k + 1) * cell; }
  // 3. greedy boxes (x, then z, then y). Cells merge only where their bounds line up, so a box stays as tight as its cells:
  // a floor's cells (ending at the floor's top) never merge with the foot of a wall (the whole cell high), which would
  // lift the floor's box a cell above the floor
  const used = new Uint8Array(N); const boxes: number[][][] = [];
  const free = (i: number, j: number, k: number) => { const c = idx(i, j, k); return solid(c) && !used[c]; };
  const eq = (a: number, b: number) => Math.abs(a - b) <= 1e-3;
  const same = (c: number, d: number, a: number) => eq(lo[c * 3 + a], lo[d * 3 + a]) && eq(hi[c * 3 + a], hi[d * 3 + a]);
  const xExt = (j: number, k: number, i0: number, i1: number) => [lo[idx(i0, j, k) * 3], hi[idx(i1, j, k) * 3]];
  // a row i0..i1 at (j, k): every cell free, with the y and z bounds of the row's reference cell `ref`
  const rowOk = (j: number, k: number, i0: number, i1: number, ref: number, yRef: number) => {
    for (let x = i0; x <= i1; x++) { if (!free(x, j, k)) return false; const c = idx(x, j, k); if (!same(c, ref, 2) || !same(c, yRef, 1)) return false; } return true; };
  for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) { if (!free(i, j, k)) continue;
    const s0 = idx(i, j, k);
    let i1 = i; while (i1 + 1 < nx && free(i1 + 1, j, k) && same(idx(i1 + 1, j, k), s0, 1) && same(idx(i1 + 1, j, k), s0, 2)) i1++;
    const X = xExt(j, k, i, i1);
    let k1 = k; while (k1 + 1 < nz && rowOk(j, k1 + 1, i, i1, idx(i, j, k1 + 1), s0) && (() => { const e = xExt(j, k1 + 1, i, i1); return eq(e[0], X[0]) && eq(e[1], X[1]); })() && eq(lo[idx(i, j, k1 + 1) * 3 + 2], hi[idx(i, j, k1) * 3 + 2]) ) k1++;
    let j1 = j; up: while (j1 + 1 < ny) { const y0 = idx(i, j1 + 1, k);
      for (let z = k; z <= k1; z++) { if (!rowOk(j1 + 1, z, i, i1, idx(i, j, z), y0)) break up; const e = xExt(j1 + 1, z, i, i1); if (!eq(e[0], X[0]) || !eq(e[1], X[1])) break up; }
      if (!eq(lo[y0 * 3 + 1], hi[idx(i, j1, k) * 3 + 1])) break; j1++; }
    const L = [Infinity, Infinity, Infinity], H = [-Infinity, -Infinity, -Infinity];
    for (let z = k; z <= k1; z++) for (let y = j; y <= j1; y++) for (let x = i; x <= i1; x++) { const c = idx(x, y, z); used[c] = 1; const b = c * 3;
      for (let a = 0; a < 3; a++) { if (lo[b + a] < L[a]) L[a] = lo[b + a]; if (hi[b + a] > H[a]) H[a] = hi[b + a]; } }
    boxes.push([L.map((v) => Math.floor(v * 1000) / 1000), H.map((v) => Math.ceil(v * 1000) / 1000)]);
    if (boxes.length > SOLIDS.maxBoxes) return null;
  }
  return boxes;
}
