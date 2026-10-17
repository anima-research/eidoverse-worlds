// buoyancy — how a body floats on the water surface (shared/waves.js), for swimmers now and floating
// ragdolls and objects next: the same law, per body or per part.
//
// A body is a COLUMN of height H that floats at rest with SWIM_AT·H of itself under water (the chest at
// the surface). Buoyancy pushes in proportion to how much is submerged, gravity pulls, and water drag damps
// the vertical motion — critically-ish (ζ ≈ 0.6). So a long, gentle swell lifts it nearly all the way, but
// a short or steep wave arrives faster than the body can rise: the water climbs up the body before it
// bobs up, and the body is still rising after the crest has passed. The surface is sampled over the
// body's footprint, not at a point, so chop averages out instead of jolting it.

import { SWIM_AT } from './terrainshape.js';

const G = 9.8;
export const FLOAT_ZETA = 0.6;      // damping ratio: settles in about one bob, without a long ring
export const FOOTPRINT = 0.35;      // metres: the surface is averaged over the body's own width

/** Mean surface height over a body's footprint at (x, z): `surfaceAt(x, z)` is the surface there. */
export function footprintSurface(surfaceAt, x, z, r = FOOTPRINT) {
  return (surfaceAt(x, z) * 2 + surfaceAt(x + r, z) + surfaceAt(x - r, z) + surfaceAt(x, z + r) + surfaceAt(x, z - r)) / 6;
}

/** Advance a floating column by `dt` seconds: `s` is {y, vy} — y the body's feet (its column's foot) —
 *  under a surface at `surfaceY`, for a body of height `H`; `floor` keeps it off the bed. Mutates and
 *  returns `s`. Substepped, so a 10 Hz agent tick and a 60 Hz browser frame trace the same bob. */
export function floatStep(s, surfaceY, H, dt, floor = -Infinity) {
  const sub0 = SWIM_AT * H;
  const c = 2 * FLOAT_ZETA * Math.sqrt(G / sub0);
  const n = Math.max(1, Math.ceil(dt / (1 / 120)));
  const h = dt / n;
  for (let i = 0; i < n; i++) {
    const sub = Math.min(H, Math.max(0, surfaceY - s.y));
    const a = G * (sub / sub0 - 1) - c * s.vy;
    s.vy += a * h;
    s.y += s.vy * h;
    if (s.y < floor) { s.y = floor; if (s.vy < 0) s.vy = 0; }
  }
  return s;
}

// ---- floating bodies, part by part ------------------------------------------------
// A ragdoll floats by the same law, applied to each of its parts (client/lib/ammodoll.js): every part
// is buoyed in proportion to how much of it is under the surface, floating at rest with PART_FLOAT of
// itself submerged (people float face near the surface), and dragged toward the WATER's own motion —
// so a body drifts down a river with its current and is pushed in toward the shore by the surf.

export const PART_FLOAT = 0.82;
export const WATER_DRAG = 2.0;       // 1/s, on what is under water, relative to the water's motion
export const WATER_DRAG2 = 1.6;      // 1/m: the quadratic part — water resists speed squared, so a body that
                                     // drops in fast is stopped within half a metre, not carried two down
export const WATER_ANG_DRAG = 3.0;   // 1/s, on spin

/** The water's own horizontal motion where `w` (a shared/waterkind.js sample) was taken, m/s: a river's
 *  flow; the sea's drift in toward the shore, strongest in the surf; still water none. */
export function waterCurrent(w) {
  if (!w) return [0, 0];
  if (w.kind === 'river' && w.flow) return [w.flow[0] * w.speed, w.flow[1] * w.speed];
  if (w.kind === 'ocean' && w.toShore) {
    const surf = 1 - Math.min(1, Math.max(0, w.depth / 2.5));
    const k = 0.12 + 0.38 * surf * surf * (3 - 2 * surf);
    return [w.toShore[0] * k, w.toShore[1] * k];
  }
  return [0, 0];
}

/** The water's force on one floating part, excluding gravity (the solver applies that): `mass` kg, its
 *  centre at height `y` with extent `r` (metres either side), moving at `v` [x,y,z], under a surface at
 *  `surface`. The water itself moves at `current` [x, z, y?] — a river's flow, the surf's drift, and (the
 *  third, optional) the swell's own rise and fall, which carries a floating body with it. Drag is linear
 *  plus quadratic in the velocity RELATIVE to that. Writes newtons into `out` [x,y,z] and returns the
 *  submerged share (0 when the part is clear of the water). */
export function partWaterForce(mass, y, r, v, surface, current, out) {
  const sub = Math.min(1, Math.max(0, (surface - (y - r)) / (2 * r)));
  if (sub <= 0) { out[0] = out[1] = out[2] = 0; return 0; }
  const rx = v[0] - current[0], ry = v[1] - (current[2] ?? 0), rz = v[2] - current[1];
  const d = mass * sub * (WATER_DRAG + WATER_DRAG2 * Math.hypot(rx, ry, rz));
  out[0] = -d * rx;
  out[1] = mass * G * sub / PART_FLOAT - d * ry;
  out[2] = -d * rz;
  return sub;
}

/** The swell's vertical motion at depth `below` under its surface: the surface's own rise rate, fading as
 *  e^(−k·below) (a wave's orbits shrink with depth). `eta(t)` is the surface offset at the point. */
export function swellRise(eta, t, below, k = 0.2) {
  const dt = 0.05;
  return ((eta(t + dt) - eta(t - dt)) / (2 * dt)) * Math.exp(-k * Math.max(0, below));
}
