// force — the radial-cause falloff, as one pure module (§24l R1, survey
// B1). The `force` verb folds to nothing (a cause, not a state — PROTOCOL
// §3); its only effect is live bodies deciding, under their own consent,
// how hard the blast reaches them. That arithmetic was mirrored between
// the browser (localbody.js) and the MCPL agent with a "keep in sync"
// comment that had already gone stale about which file it mirrored. One
// implementation now; the CONSENT and the ground-zero direction choice
// (facing vs current lean) stay with each body, where they belong.
//
// Same constraints as everything in shared/: pure, dependency-free.

export const FORCE_RADIUS = 4;   // metres, default blast rim
export const FORCE_POWER = 3;    // m/s at ground zero, default
export const FORCE_CAP = 6;      // m/s ceiling whatever the verb claims
export const FORCE_MIN = 0.3;    // below this it is a breeze, not a blow
export const FORCE_EPS = 0.05;   // inside this, direction is meaningless

/** Linear falloff to the rim. Returns null when the body is outside the
 *  blast or the args are unusable; `nx/nz` are null at ground zero (the
 *  caller picks a direction — facing, or the lean it already had).
 *  @param {unknown} at blast origin, [x, y, z]
 *  @param {number} x @param {number} z the body's ground position
 *  @param {unknown} [radius] @param {unknown} [power]
 *  @returns {{ mag: number, d: number, nx: number|null, nz: number|null } | null} */
export function radialForce(at, x, z, radius, power) {
  if (!Array.isArray(at) || at.length !== 3) return null;
  const dx = x - at[0], dz = z - at[2];
  const d = Math.hypot(dx, dz);
  const r = Math.max(Number(radius ?? FORCE_RADIUS) || FORCE_RADIUS, 0.001);
  if (d > r) return null;
  const mag = Math.min(FORCE_CAP, (Number(power ?? FORCE_POWER) || FORCE_POWER) * (1 - d / r));
  return { mag, d, nx: d > FORCE_EPS ? dx / d : null, nz: d > FORCE_EPS ? dz / d : null };
}
