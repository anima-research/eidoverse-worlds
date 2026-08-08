// grass_quality — the resident's local meadow budget, DOM-free (unit-tested
// in tools/grass-quality-test.ts).
//
// Two dials own the meadow's draw cost, and they are different people's:
//
//   the CAP is the resident's chosen ceiling (full/medium/low/off) — "my poor
//   gpu" (#60). Persisted per browser, so it survives re-grows, reconnects
//   and restarts.
//
//   the SHED is the frame governor's dial — session-only, lowered under load.
//
// What the field actually draws is min(cap, shed): the governor may thin
// below the resident's ceiling, but can never silently raise above it, and
// the resident raising their cap never un-sheds a machine that measured a
// slow frame. Neither dial is ever a verb — the shared field (species, seed,
// extent, provenance) is world state; how many blades THIS machine fills
// pixels with is not.

export const GRASS_QUALITY = ['full', 'medium', 'low', 'off'];
export const QUALITY_DENSITY = { full: 1, medium: 0.6, low: 0.35, off: 0 };

const KEY = 'ew-grass-quality';

/** The dial state. `store` is localStorage in the browser, anything with
 *  getItem/setItem in tests, or absent (state then lives for the session). */
export function makeGrassQuality(store) {
  const saved = store?.getItem?.(KEY);
  let quality = GRASS_QUALITY.includes(saved) ? saved : 'full';
  let shed = 1;
  return {
    /** the resident's chosen level ('full' | 'medium' | 'low' | 'off') */
    get quality() { return quality; },
    /** the governor's session dial, before the cap is applied */
    get shed() { return shed; },
    /** the resident's cap as a density factor */
    get cap() { return QUALITY_DENSITY[quality]; },
    /** what the field should actually draw */
    effective() { return Math.min(QUALITY_DENSITY[quality], shed); },
    /** choose a level; unknown names are refused, the current level stands */
    setQuality(q) {
      if (!GRASS_QUALITY.includes(q)) return quality;
      quality = q;
      store?.setItem?.(KEY, q);
      return quality;
    },
    /** the governor's handle — clamped to [0, 1] */
    shedTo(f) {
      shed = Math.min(1, Math.max(0, Number.isFinite(f) ? f : 1));
      return shed;
    },
  };
}

/** How many of a stroke's `n` instances a density factor keeps. Off (≤0) is
 *  genuinely zero — an InstancedMesh with count 0 draws nothing — while any
 *  positive factor keeps at least one plant so a thinned field never reads
 *  as mowed. */
export function densityCount(n, f) {
  if (f <= 0) return 0;
  return Math.max(1, Math.round(n * Math.min(1, Math.max(0.05, f))));
}
