// Ported from the protocol lab (the protocol lab, 2026-10-05) unchanged.
// Sculpt (PROTOCOL §3b; research 40 §6). Ground = a base (the `terrain` value) + integer-millimetre deltas in keyed
// tiles `terrain-tile:<i>-<j>` {mm: [tile² ints, row-major]} on a grid `terrain-grid` {spacing, tile, origin, extent,
// limits: {raise, lower}}. Tiles partition samples (no shared edges). An absent tile is all zero. This file is pure:
// it turns a stroke and the tiles AT HEAD into whole new tile values. The authority admits them like any write.
export const ADDITIVE = new Set(["raise", "lower"]);
export const BRUSHES = ["raise", "lower", "smooth"];
const key = (i, j) => `terrain-tile:${i}-${j}`;
export const tileKey = key;
export function parseKey(comp) { const m = /^terrain-tile:(\d+)-(\d+)$/.exec(comp); return m ? [Number(m[1]), Number(m[2])] : null; }
// every sample (global gx, gz) within `radius` of any path point, with its brush weight summed per dab (linear falloff)
function footprint(g, path, radius) {
  const t = g.tile, N = [g.extent[0] * t, g.extent[1] * t], s = g.spacing, out = new Map();
  for (const [px, pz] of path) {
    const cx = (px - g.origin[0]) / s, cz = (pz - g.origin[1]) / s, rr = radius / s;
    for (let gx = Math.max(0, Math.ceil(cx - rr)); gx <= Math.min(N[0] - 1, Math.floor(cx + rr)); gx++)
      for (let gz = Math.max(0, Math.ceil(cz - rr)); gz <= Math.min(N[1] - 1, Math.floor(cz + rr)); gz++) {
        const d = Math.hypot(gx - cx, gz - cz) * s; if (d > radius) continue;
        const k = gx * N[1] + gz; out.set(k, (out.get(k) ?? 0) + (1 - d / radius)); } }
  return { out, N };
}
const sampleAt = (tiles, g, gx, gz) => { const t = g.tile; const v = tiles.get(key(Math.floor(gx / t), Math.floor(gz / t))); return v ? v[(gx % t) * t + (gz % t)] : 0; };
// stroke -> { writes: Map(comp -> mm[]), clamped }. `tiles`: Map(comp -> mm[]) at head (absent = zeros).
export function applyStroke(g, tiles, { brush, path, radius, strength }) {
  const { out, N } = footprint(g, path, radius); const t = g.tile, lo = -(g.limits?.lower ?? 1e9), hi = g.limits?.raise ?? 1e9;
  const writes = new Map(); let clamped = false;
  const tileOf = (gx, gz) => { const c = key(Math.floor(gx / t), Math.floor(gz / t)); if (!writes.has(c)) writes.set(c, (tiles.get(c) ?? new Array(t * t).fill(0)).slice()); return writes.get(c); };
  const next = new Map();
  for (const [k, wgt] of out) { const gx = Math.floor(k / N[1]), gz = k % N[1]; const cur = sampleAt(tiles, g, gx, gz); let v;
    if (ADDITIVE.has(brush)) v = cur + (brush === "lower" ? -1 : 1) * Math.round(strength * wgt); // an integer add per sample: strokes commute
    else { let sum = 0, n = 0; for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) { const x = gx + dx, z = gz + dz; if (x < 0 || z < 0 || x >= N[0] || z >= N[1]) continue; sum += sampleAt(tiles, g, x, z); n++; }
      v = Math.round(cur + (sum / n - cur) * Math.min(1, wgt)); } // reads its neighbours at head: order matters
    if (v > hi) { v = hi; clamped = true; } if (v < lo) { v = lo; clamped = true; }
    next.set(k, v); }
  for (const [k, v] of next) { const gx = Math.floor(k / N[1]), gz = k % N[1]; tileOf(gx, gz)[(gx % t) * t + (gz % t)] = v; }
  return { writes, clamped };
}
// the sculpt's own height delta (m) at a world point, without the terrain's base: not the ground height (add the base for that)
export function heightAt(g, tiles, x, z) { const gx = Math.round((x - g.origin[0]) / g.spacing), gz = Math.round((z - g.origin[1]) / g.spacing); return sampleAt(tiles, g, gx, gz) / 1000; }
