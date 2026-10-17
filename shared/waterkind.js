// waterkind — what kind of water this is, read from the SHAPE of what the level fills.
//
// One water level per world (shared/terrainshape.js waterParams) makes every low place wet, and the
// places it makes wet are not all alike: a bowl holds a pond, a long channel holds a river, and a body
// that runs off the edge of the world and opens wide is the sea. Nobody authors which is which — the
// ground already says it:
//
//   ocean   touches the world's edge along a real stretch, and is BIG (an area, or a reach far from any
//           shore). Its waves travel toward the nearest shore.
//   river   long for its width (length ≥ RIVER_ELONG × width) and never wider than RIVER_MAX_WIDTH. It
//           flows along its channel, from source to mouth: the mouth is the end that leaves the world
//           (or, failing that, the end whose bed is deeper) — with a flat surface, the ground's
//           continuation and the bed are all that can say downstream.
//   still   everything else: ponds and lakes.
//
// Computed on a vertex grid over the terrain square — the same grid the client's water mesh uses, so
// each vertex is told its kind, its flow and its way to shore. Pure JS, no rendering: the agents read the
// same answers (`look`: "standing in a river 0.6m deep, flowing east"). Not sim law — nothing here
// moves a body, so it is free to be an estimate.
//
// `water.kind` ('still' | 'river' | 'ocean') overrides the guess for every body; `water.flow: [x, z]`
// gives rivers a direction instead.
//
// COST. Runs synchronously when a world's water is built (the browser's applyWater, an agent's
// buildTerrain), so every pass is linear or N log N in the grid's cells — no per-cell neighbourhood scans.
// Budget: the 513² maximum grid (waterGridSeg), filled wall to wall and forced to be a river (the costliest
// case), analyses in about a third of a second on a laptop; tools/waterkind-test.ts holds it under 1.2 s.

import { riverSpeed } from './waves.js';

export const RIVER_ELONG = 3.5;
export const RIVER_MAX_WIDTH = 30;      // metres
export const OCEAN_EDGE = 25;           // metres of world edge it must touch
export const OCEAN_REACH = 18;          // metres from the nearest shore somewhere inside it…
export const OCEAN_AREA = 0.12;         // …or this share of the world square
export const KINDS = ['still', 'river', 'ocean'];
/** The analysis grid's segments a side for a terrain square — the water mesh's, about a metre a vertex
 *  (2 m on the biggest worlds). Browser and agent both use it, so both read the same water. */
export const waterGridSeg = (size) => Math.max(32, Math.min(512, Math.round(size)));

/**
 * @param {(x: number, z: number) => number} heightAt  the shaped ground
 * @param {number} size   the terrain square, metres
 * @param {{level: number, kind?: string, flow?: number[]}} water
 * @param {number} seg    grid segments a side (the water mesh's)
 */
export function analyzeWater(heightAt, size, water, seg) {
  const n = seg + 1, N = n * n, cell = size / seg, half = size / 2;
  const at = (i, j) => j * n + i;
  const depth = new Float32Array(N), wet = new Uint8Array(N);
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const k = at(i, j), d = water.level - heightAt(-half + i * cell, -half + j * cell);
    depth[k] = d; wet[k] = d > 0 ? 1 : 0;
  }

  // distance to the nearest DRY point (metres), two-pass chamfer — the world's edge is not a shore
  const INF = 1e9, D1 = cell, D2 = cell * Math.SQRT2;
  const shore = new Float32Array(N);
  for (let k = 0; k < N; k++) shore[k] = wet[k] ? INF : 0;
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const k = at(i, j); if (!wet[k]) continue;
    let v = shore[k];
    if (i > 0) v = Math.min(v, shore[k - 1] + D1);
    if (j > 0) { v = Math.min(v, shore[k - n] + D1); if (i > 0) v = Math.min(v, shore[k - n - 1] + D2); if (i < n - 1) v = Math.min(v, shore[k - n + 1] + D2); }
    shore[k] = v;
  }
  for (let j = n - 1; j >= 0; j--) for (let i = n - 1; i >= 0; i--) {
    const k = at(i, j); if (!wet[k]) continue;
    let v = shore[k];
    if (i < n - 1) v = Math.min(v, shore[k + 1] + D1);
    if (j < n - 1) { v = Math.min(v, shore[k + n] + D1); if (i < n - 1) v = Math.min(v, shore[k + n + 1] + D2); if (i > 0) v = Math.min(v, shore[k + n - 1] + D2); }
    shore[k] = v;
  }
  for (let k = 0; k < N; k++) if (shore[k] >= INF) shore[k] = size;   // a world all water: far from any shore

  // connected bodies (4-neighbour)
  const comp = new Int32Array(N).fill(-1), bodies = [];
  const stack = [];
  for (let k0 = 0; k0 < N; k0++) {
    if (!wet[k0] || comp[k0] >= 0) continue;
    const id = bodies.length, b = { id, cells: [], edge: 0, sumShore: 0, maxShore: 0, sumBed: 0 };
    comp[k0] = id; stack.push(k0);
    while (stack.length) {
      const k = stack.pop(), i = k % n, j = (k - i) / n;
      b.cells.push(k); b.sumShore += shore[k]; b.sumBed += depth[k];
      if (shore[k] > b.maxShore) b.maxShore = shore[k];
      if (i === 0 || j === 0 || i === n - 1 || j === n - 1) b.edge++;
      if (i > 0 && wet[k - 1] && comp[k - 1] < 0) { comp[k - 1] = id; stack.push(k - 1); }
      if (i < n - 1 && wet[k + 1] && comp[k + 1] < 0) { comp[k + 1] = id; stack.push(k + 1); }
      if (j > 0 && wet[k - n] && comp[k - n] < 0) { comp[k - n] = id; stack.push(k - n); }
      if (j < n - 1 && wet[k + n] && comp[k + n] < 0) { comp[k + n] = id; stack.push(k + n); }
    }
    bodies.push(b);
  }

  const forced = KINDS.includes(water.kind) ? water.kind : null;
  for (const b of bodies) {
    const area = b.cells.length * cell * cell;
    // a channel of width w has its shore distance running 0 → w/2 → 0, averaging w/4
    b.width = Math.max(cell, 4 * (b.sumShore / b.cells.length));
    b.length = area / b.width;
    b.area = area;
    b.kind = forced
      ?? (b.edge * cell >= OCEAN_EDGE && (area >= OCEAN_AREA * size * size || b.maxShore >= OCEAN_REACH) ? 'ocean'
        : b.length >= RIVER_ELONG * b.width && 2 * b.maxShore <= RIVER_MAX_WIDTH ? 'river'
        : 'still');
  }

  // rivers: geodesic distance from the source end along the channel; flow is its gradient
  const flow = new Float32Array(N * 2), speed = new Float32Array(N);
  const geo = new Float64Array(N).fill(-1);   // 64-bit: the heap compares in doubles, and a float32 round-trip would re-relax settled cells
  const heap = new MinHeap();
  const bfs = (b, from) => {   // 8-neighbour Dijkstra (two costs) within one body — O(N log N)
    for (const k of b.cells) geo[k] = INF;
    geo[from] = 0;
    heap.clear(); heap.push(from, 0);
    while (heap.size) {
      const g0 = heap.topKey(), k = heap.pop();
      if (g0 > geo[k]) continue;   // a stale entry: k was settled nearer since
      const i = k % n, j = (k - i) / n;
      for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
        if (!di && !dj) continue;
        const ii = i + di, jj = j + dj;
        if (ii < 0 || jj < 0 || ii >= n || jj >= n) continue;
        const m = at(ii, jj);
        if (comp[m] !== b.id) continue;
        const g = g0 + (di && dj ? D2 : D1);
        if (g < geo[m] - 1e-6) { geo[m] = g; heap.push(m, g); }
      }
    }
    let far = from;   // the far end, once every distance has settled
    for (const k of b.cells) if (geo[k] > geo[far]) far = k;
    return far;
  };
  // the far end by STEPS (8-neighbour, unit cost): a plain O(N) breadth-first search — finding a channel's
  // two ends needs no exact metres, only the exact flow distance after does (bfs)
  const hops = new Int32Array(N);
  const farthest = (b, from) => {
    for (const k of b.cells) hops[k] = -1;
    hops[from] = 0;
    const q = new Int32Array(b.cells.length); let head = 0, tail = 0, far = from;
    q[tail++] = from;
    while (head < tail) {
      const k = q[head++], i = k % n, j = (k - i) / n;
      if (hops[k] > hops[far]) far = k;
      for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
        const ii = i + di, jj = j + dj;
        if ((!di && !dj) || ii < 0 || jj < 0 || ii >= n || jj >= n) continue;
        const m = at(ii, jj);
        if (comp[m] !== b.id || hops[m] >= 0) continue;
        hops[m] = hops[k] + 1; q[tail++] = m;
      }
    }
    return far;
  };
  const isEdge = (k) => { const i = k % n, j = (k - i) / n; return i < 3 || j < 3 || i > n - 4 || j > n - 4; };
  const bedNear = (b, k) => {   // mean depth within 5 cells of k, in this body
    const i0 = k % n, j0 = (k - i0) / n; let s = 0, c = 0;
    for (let j = Math.max(0, j0 - 5); j <= Math.min(n - 1, j0 + 5); j++) for (let i = Math.max(0, i0 - 5); i <= Math.min(n - 1, i0 + 5); i++) {
      const m = at(i, j); if (comp[m] === b.id) { s += depth[m]; c++; }
    }
    return c ? s / c : 0;
  };
  for (const b of bodies) {
    if (b.kind !== 'river') continue;
    let src, mouth;
    if (Array.isArray(water.flow) && water.flow.length === 2 && water.flow.every(Number.isFinite) && Math.hypot(...water.flow) > 0) {
      // a given direction: the source is the cell furthest UPstream along it
      const [fx, fz] = water.flow; let lo = Infinity, hi = -Infinity;
      for (const k of b.cells) {
        const i = k % n, j = (k - i) / n, s = i * fx + j * fz;
        if (s < lo) { lo = s; src = k; } if (s > hi) { hi = s; mouth = k; }
      }
    } else {
      const a = farthest(b, b.cells[0]), c = farthest(b, a);   // the channel's two far ends
      const score = (k) => (isEdge(k) ? 100 : 0) + bedNear(b, k);
      [src, mouth] = score(a) > score(c) ? [c, a] : [a, c];
    }
    bfs(b, src);
    b.source = src; b.mouth = mouth;
    // Narrower runs faster: the current follows the channel's LOCAL width — twice its centre line's
    // shore distance (the centre line is half the width from either bank). Each cell finds its centre
    // line by climbing the shore-distance field: visited highest first, a cell takes the half-width of
    // its steepest uphill neighbour (a ridge cell keeps its own) — one sorted pass, O(N log N), whatever
    // the river's breadth. The ripples it carries run at one speed for the whole river (its mean width's),
    // rounded to wrap with the wave clock: a speed that varied across the water would shear the ripple
    // trains apart as the clock ran.
    b.waveSpeed = riverSpeed(Math.min(2.2, Math.max(0.5, 18 / b.width)));
    const halfW = ridgeHalfWidth(b, shore, comp, n, cell);
    b.cells.forEach((k, c) => { speed[k] = Math.min(2.2, Math.max(0.5, 18 / Math.max(cell, 2 * halfW[c]))); });
    smoothScalar(speed, b, comp, n, 3);
    for (const k of b.cells) {
      const i = k % n, j = (k - i) / n;
      const g = (ii, jj) => { const m = at(ii, jj); return comp[m] === b.id ? geo[m] : geo[k]; };
      const gx = (i < n - 1 ? g(i + 1, j) : geo[k]) - (i > 0 ? g(i - 1, j) : geo[k]);
      const gz = (j < n - 1 ? g(i, j + 1) : geo[k]) - (j > 0 ? g(i, j - 1) : geo[k]);
      const len = Math.hypot(gx, gz) || 1;
      flow[2 * k] = gx / len; flow[2 * k + 1] = gz / len;
    }
    b.flowDir = [(mouth % n) - (src % n), Math.floor(mouth / n) - Math.floor(src / n)];
  }
  smoothVectors(flow, wet, comp, n, 3, bodies, 'river');

  // oceans: the waves' way in — down the shore-distance field, toward the nearest shore
  const toShore = new Float32Array(N * 2);
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const k = at(i, j); if (!wet[k] || bodies[comp[k]].kind !== 'ocean') continue;
    const s = (ii, jj) => shore[at(Math.min(n - 1, Math.max(0, ii)), Math.min(n - 1, Math.max(0, jj)))];
    const gx = s(i + 1, j) - s(i - 1, j), gz = s(i, j + 1) - s(i, j - 1);
    const len = Math.hypot(gx, gz) || 1;
    toShore[2 * k] = -gx / len; toShore[2 * k + 1] = -gz / len;
  }
  smoothVectors(toShore, wet, comp, n, 4, bodies, 'ocean');

  const kind = new Uint8Array(N);
  for (let k = 0; k < N; k++) kind[k] = wet[k] ? KINDS.indexOf(bodies[comp[k]].kind) : 0;

  /** The water at a point: null on dry ground. Bilinear between the four grid points around it — the
   *  same continuous surface the drawn sheet interpolates — so a body floating across a cell boundary
   *  sees no jump in depth, current or wave direction. Its body (kind, width) is the wettest corner's,
   *  and only that body's corners are blended. */
  const sample = (x, z) => {
    const u = (x + half) / cell, v = (z + half) / cell;
    if (u < 0 || v < 0 || u > n - 1 || v > n - 1) return null;
    const i = Math.min(n - 2, Math.floor(u)), j = Math.min(n - 2, Math.floor(v)), fu = u - i, fv = v - j;
    const ks = [at(i, j), at(i + 1, j), at(i, j + 1), at(i + 1, j + 1)];
    const ws = [(1 - fu) * (1 - fv), fu * (1 - fv), (1 - fu) * fv, fu * fv];
    const d = depth[ks[0]] * ws[0] + depth[ks[1]] * ws[1] + depth[ks[2]] * ws[2] + depth[ks[3]] * ws[3];
    if (!(d > 0)) return null;
    let top = -1;
    for (let c = 0; c < 4; c++) if (wet[ks[c]] && (top < 0 || ws[c] > ws[top])) top = c;
    if (top < 0) return null;
    const b = bodies[comp[ks[top]]];
    let W = 0, sh = 0, fx = 0, fz = 0, sp = 0, tx = 0, tz = 0;
    for (let c = 0; c < 4; c++) {
      const k = ks[c]; if (comp[k] !== b.id) continue;
      const w = ws[c]; W += w; sh += shore[k] * w;
      fx += flow[2 * k] * w; fz += flow[2 * k + 1] * w; sp += speed[k] * w;
      tx += toShore[2 * k] * w; tz += toShore[2 * k + 1] * w;
    }
    const unit = (a, c) => { const L = Math.hypot(a, c); return L > 1e-9 ? [a / L, c / L] : null; };
    const river = b.kind === 'river', ocean = b.kind === 'ocean';
    return { kind: b.kind, depth: d, shore: sh / W, width: b.width,
      flow: river ? unit(fx, fz) : null, speed: river ? sp / W : 0, waveSpeed: river ? b.waveSpeed : 0,
      toShore: ocean ? unit(tx, tz) : null };
  };
  return { n, cell, depth, shore, kind, flow, speed, toShore, comp, bodies, sample };
}

/** For each of a body's cells (in b.cells order), the shore distance of the centre line it lies across:
 *  cells highest-first, each taking its steepest same-body uphill neighbour's value, or its own on a ridge. */
function ridgeHalfWidth(b, shore, comp, n, cell) {
  const order = Uint32Array.from(b.cells.keys()).sort((x, y) => shore[b.cells[y]] - shore[b.cells[x]]);
  const slot = new Map();
  b.cells.forEach((k, c) => slot.set(k, c));
  const out = new Float32Array(b.cells.length);
  for (const c of order) {
    const k = b.cells[c], i = k % n, j = (k - i) / n, s0 = shore[k];
    let best = -1, bestRise = 0;
    for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
      if (!di && !dj) continue;
      const ii = i + di, jj = j + dj;
      if (ii < 0 || jj < 0 || ii >= n || jj >= n) continue;
      const m = jj * n + ii;
      if (comp[m] !== b.id) continue;
      const rise = (shore[m] - s0) / (di && dj ? cell * Math.SQRT2 : cell);
      if (rise > bestRise) { bestRise = rise; best = m; }
    }
    out[c] = best < 0 ? s0 : Math.max(s0, out[slot.get(best)]);
  }
  return out;
}

/** A binary min-heap of grid indices by key (Dijkstra's frontier). */
class MinHeap {
  constructor() { this.k = []; this.v = []; }
  get size() { return this.v.length; }
  clear() { this.k.length = 0; this.v.length = 0; }
  topKey() { return this.k[0]; }
  push(v, key) {
    const K = this.k, V = this.v; let i = V.length; K.push(key); V.push(v);
    while (i > 0) { const p = (i - 1) >> 1; if (K[p] <= key) break; K[i] = K[p]; V[i] = V[p]; i = p; }
    K[i] = key; V[i] = v;
  }
  pop() {
    const K = this.k, V = this.v, top = V[0], key = K.pop(), v = V.pop(), N = V.length;
    if (N) {
      let i = 0;
      for (;;) {
        let c = 2 * i + 1; if (c >= N) break;
        if (c + 1 < N && K[c + 1] < K[c]) c++;
        if (K[c] >= key) break;
        K[i] = K[c]; V[i] = V[c]; i = c;
      }
      K[i] = key; V[i] = v;
    }
    return top;
  }
}

/** Average a scalar over each cell's same-body neighbours, `passes` times. */
function smoothScalar(v, b, comp, n, passes) {
  const tmp = new Float32Array(b.cells.length);
  for (let p = 0; p < passes; p++) {
    b.cells.forEach((k, c) => {
      const i = k % n, j = (k - i) / n; let s = 0, m = 0;
      for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
        const ii = i + di, jj = j + dj;
        if (ii < 0 || jj < 0 || ii >= n || jj >= n) continue;
        const q = jj * n + ii; if (comp[q] !== b.id) continue;
        s += v[q]; m++;
      }
      tmp[c] = s / m;
    });
    b.cells.forEach((k, c) => { v[k] = tmp[c]; });
  }
}

/** Average each wet vector with its same-body neighbours, `passes` times, and renormalize — the grid's
 *  gradients are blocky, and water should turn smoothly. */
function smoothVectors(v, wet, comp, n, passes, bodies, only) {
  if (!bodies.some((b) => b.kind === only)) return;   // no water of this kind: nothing to smooth
  const tmp = new Float32Array(v.length);
  for (let p = 0; p < passes; p++) {
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
      const k = j * n + i;
      if (!wet[k]) { tmp[2 * k] = tmp[2 * k + 1] = 0; continue; }
      if (bodies[comp[k]].kind !== only) { tmp[2 * k] = v[2 * k]; tmp[2 * k + 1] = v[2 * k + 1]; continue; }
      let sx = 0, sz = 0;
      for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
        const ii = i + di, jj = j + dj;
        if (ii < 0 || jj < 0 || ii >= n || jj >= n) continue;
        const m = jj * n + ii;
        if (comp[m] !== comp[k]) continue;
        sx += v[2 * m]; sz += v[2 * m + 1];
      }
      const len = Math.hypot(sx, sz);
      tmp[2 * k] = len > 1e-6 ? sx / len : v[2 * k]; tmp[2 * k + 1] = len > 1e-6 ? sz / len : v[2 * k + 1];
    }
    v.set(tmp);
  }
}

/** A compass word for a world direction (+z is south, as `look` reads bearings). */
export function compass(x, z) {
  const a = Math.atan2(x, -z);   // 0 = north (−z), clockwise
  return ['north', 'northeast', 'east', 'southeast', 'south', 'southwest', 'west', 'northwest'][((Math.round(a / (Math.PI / 4)) % 8) + 8) % 8];
}
