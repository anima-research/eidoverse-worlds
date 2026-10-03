// The LOD distance geometry, in one place. The client decides tiers with it (client/lib/lod_policy.js,
// client/lib/realize/models.js); the server budgets each LOD against it (server/optimize.ts) — a LOD is built for the
// closest distance it can be seen from, so the two must never disagree about where that is.

/** Residency radius R = R_BASE + bbox diagonal × DIAG_K (metres): big things stay resident longer. */
export const R_BASE = 80;
export const DIAG_K = 4;
/** Fraction of the residency radius beyond which 'auto' fetches the reduced tier. R = 80m + diag×4, so a 2m prop
 *  goes reduced past ~40m, a 20m building past ~70m. */
export const LOD_FRACTION = 0.45;
/** Band hysteresis: upgrade below edge×(1−H), downgrade above edge×(1+H). */
export const LOD_HYST = 0.25;

export const residencyRadiusFor = (diag) => R_BASE + diag * DIAG_K;
/** The closest distance 'auto' ever shows the reduced tier: the band edge less its hysteresis. The eco dial and
 *  device pressure halve it (lod_policy.js PRESSURE_EDGE). */
export const lodNearest = (diag) => residencyRadiusFor(diag) * LOD_FRACTION * (1 - LOD_HYST);
