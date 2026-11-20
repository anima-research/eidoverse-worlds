// shared/protocol/sculpt.js — one brush stroke on the ground's sculpted layer (shared/terrainshape.js SCULPT).
//
// A stroke is worked out ONCE, by the authority, against the tiles and the ground AT HEAD. What it writes is whole
// tiles of whole millimetres, so every reader (a browser's mesh, an agent's feet, the sim) reads the same numbers and
// none of them ever runs a brush. This file is pure: a stroke in, new tile values out; the authority admits them like
// any write.
//
//   raise, lower   add or take `strength` metres along the path, fading to nothing at `radius`. An integer add per
//                  sample, so two such strokes land the same in either order and one can be undone under the other.
//   flatten        bring the ground toward one height (`height`, or the ground's own at the path's first point)
//   smooth         bring each sample toward the mean of the ground round it (a window that grows with the radius)
//   strength for flatten and smooth is how far to go, 0–1 (absent: all the way).
import { SCULPT, tileKey } from "../terrainshape.js";

export const BRUSHES = ["raise", "lower", "flatten", "smooth"];
export const ADDITIVE = new Set(["raise", "lower"]);
export const MAX_RADIUS = 64;      // metres
export const MAX_POINTS = 256;     // in a path
export const MAX_STRENGTH = 100;   // metres, a raise or a lower
// samples one stroke may weigh: a stroke is priced by the ground it covers before any of it is worked out
const VISITS = 1_000_000;

const { spacing: SP, tile: T, span: SPAN, origin: O, limit: LIM } = SCULPT, N = T * SPAN;
// round-topped, as a hill feature is: 1 on the path, 0 at the radius, flat at both
const bell = (d2, r) => { const t2 = d2 / (r * r); if (t2 >= 1) return 0; const k = 1 - t2; return k * k; };

/** Every sample within `radius` of the path, with its weight: Map(sample number -> 0..1], or null when the stroke
 *  covers more ground than one stroke may. A sample's weight is by its distance to the nearest part of the path. */
function footprint(path, radius) {
  const segs = path.length === 1 ? [[path[0], path[0]]] : path.slice(1).map((p, i) => [path[i], p]);
  const span = (a, b) => [Math.max(0, Math.ceil((Math.min(a, b) - radius - O) / SP)), Math.min(N - 1, Math.floor((Math.max(a, b) + radius - O) / SP))];
  let visits = 0;
  for (const [a, b] of segs) { const [x0, x1] = span(a[0], b[0]), [z0, z1] = span(a[1], b[1]); if (x1 >= x0 && z1 >= z0) visits += (x1 - x0 + 1) * (z1 - z0 + 1); }
  if (visits > VISITS) return null;
  const out = new Map();
  for (const [a, b] of segs) {
    const [x0, x1] = span(a[0], b[0]), [z0, z1] = span(a[1], b[1]);
    const ex = b[0] - a[0], ez = b[1] - a[1], L2 = ex * ex + ez * ez;
    for (let gz = z0; gz <= z1; gz++) for (let gx = x0; gx <= x1; gx++) {
      const x = O + gx * SP, z = O + gz * SP;
      let t = L2 > 0 ? ((x - a[0]) * ex + (z - a[1]) * ez) / L2 : 0; t = t < 0 ? 0 : t > 1 ? 1 : t;
      const dx = x - (a[0] + ex * t), dz = z - (a[1] + ez * t), w = bell(dx * dx + dz * dz, radius);
      if (w > 0) { const k = gz * N + gx; if (!(out.get(k) >= w)) out.set(k, w); }
    }
  }
  return out;
}

/** One stroke. `tiles`: Map(tile key -> mm) at head (a tile that isn't there is level). `heightAt`: the ground at head,
 *  sculpting included (flatten and smooth read it). Returns {writes: Map(tile key -> mm | null), clamped}: every tile the
 *  stroke changes, whole, null where it leaves the tile level; clamped when a sample met the layer's limit. Or
 *  {tooBig: true}. */
export function applyStroke(tiles, { brush, path, radius, strength, height }, heightAt) {
  const fp = footprint(path, radius);
  if (!fp) return { tooBig: true };
  const cur = (gx, gz) => { const v = tiles.get(tileKey(Math.floor(gx / T), Math.floor(gz / T))); return v ? v[(gz % T) * T + (gx % T)] : 0; };
  const s = ADDITIVE.has(brush) ? strength : strength ?? 1;
  const target = brush === "flatten" ? height ?? heightAt(path[0][0], path[0][1]) : 0;
  const step = Math.max(1, Math.round(radius / (4 * SP))) * SP;   // smooth's window: a quarter of the radius each way
  const next = new Map(); let clamped = false;
  for (const [k, w] of fp) {
    const gx = k % N, gz = Math.floor(k / N), c = cur(gx, gz); let v;
    if (brush === "raise") v = c + Math.round(s * 1000 * w);
    else if (brush === "lower") v = c - Math.round(s * 1000 * w);
    else { const x = O + gx * SP, z = O + gz * SP, here = heightAt(x, z); let to = target;
      if (brush === "smooth") { to = 0; for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) to += heightAt(x + dx * step, z + dz * step); to /= 9; }
      v = c + Math.round((to - here) * 1000 * w * s); }
    if (v > LIM) { v = LIM; clamped = true; } else if (v < -LIM) { v = -LIM; clamped = true; }
    if (v !== c) next.set(k, v);
  }
  const writes = new Map();
  for (const [k, v] of next) {
    const gx = k % N, gz = Math.floor(k / N), key = tileKey(Math.floor(gx / T), Math.floor(gz / T));
    let mm = writes.get(key);
    if (!mm) writes.set(key, (mm = tiles.get(key)?.slice() ?? new Array(T * T).fill(0)));
    mm[(gz % T) * T + (gx % T)] = v;
  }
  for (const [key, mm] of writes) if (mm.every((n) => n === 0)) writes.set(key, null);
  return { writes, clamped };
}
