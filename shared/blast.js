// shared/blast.js — the `force` request's arithmetic (R 10-28, item 4: /boom restored): a radial blast's bounds and its
// linear falloff to the rim. Pure. The authority applies it (bodyverbs.js force): bodies through the body gate, loose
// things through the punt. See BLAST in physconst.js for the numbers.
import { BLAST } from "./protocol/physconst.js";

const clamp = (v, b) => { const n = v === undefined ? b.dflt : Number(v); return Number.isFinite(n) ? Math.min(b.max, Math.max(b.min, n)) : null; };

/** A blast's radius and power held to BLAST's bounds (absent: the defaults; not a number: null). */
export function blastArgs(radius, power) { return { radius: clamp(radius, BLAST.radius), power: clamp(power, BLAST.power) }; }

/** How hard a blast at `at` reaches a point `p` (both [x, y, z]): null outside the radius; else {d, mag (power × (1 − d/radius)),
 *  n: [x, z] the way out along the ground, or null at ground zero (the receiver picks a way)}. */
export function falloff(at, p, radius, power) {
  const dx = p[0] - at[0], dy = p[1] - at[1], dz = p[2] - at[2], d = Math.hypot(dx, dy, dz);
  if (!(d <= radius)) return null;
  const h = Math.hypot(dx, dz);
  return { d, mag: power * (1 - d / radius), n: h > BLAST.eps ? [dx / h, dz / h] : null };
}
