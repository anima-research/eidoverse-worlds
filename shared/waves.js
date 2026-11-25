// waves — the water surface's height, everywhere it is computed: the shader that draws it (client/lib/water.js,
// from these constants) and the bodies that float on it (shared/buoyancy.js, from these functions).
//
// ONE CLOCK. The surface runs on the world's synced clock (serverNow) so everyone sees the same wave. A float32
// shader can't hold epoch seconds, so the clock wraps every WAVE_PERIOD seconds and every frequency is rounded to a
// whole number of cycles per period: at the wrap nothing jumps.
//
// The sea: two swells along `toShore`, deep-water dispersion ω = √(g·k), a second harmonic for peaked crests, height
// growing with depth (0.2 m at the shore → 0.6 m offshore). Rivers and still water carry centimetre ripples.

export const WAVE_PERIOD = 600;   // seconds
const TAU = 2 * Math.PI;
/** a frequency rounded to a whole number of cycles per WAVE_PERIOD */
export const cyc = (w) => (TAU * Math.max(1, Math.round((w * WAVE_PERIOD) / TAU))) / WAVE_PERIOD;

export const OCEAN = {
  k1: 0.2, w1: cyc(Math.sqrt(9.8 * 0.2)),     // the long swell: 31 m, ~7 m/s
  k2: 0.33, w2: cyc(Math.sqrt(9.8 * 0.33)),   // the shorter: 19 m, ~5.5 m/s
  share2: 0.45,                               // its height, as a share of the long swell's
  crestK: 0.045, crestBend: 1.4,              // crests wavy along the shore
  across2: 0.12,                              // the short swell runs a little off the long one
  harmonic: 0.18,                             // peaked crests
  ampShore: 0.2, ampDeep: 0.6, ampFrom: -1.0, ampTo: 5.0,   // metres, by depth
};
export const RIVER = { amp: 0.025, k: 1.4 };
// A river's chop runs at speed·k, with two more shader trains at 0.6 and 0.4 of that; speeds snap to this step so all
// three are whole cycles per WAVE_PERIOD (0.037 m/s, finer than anyone can see).
export const RIVER_SPEED_STEP = (5 * TAU) / (WAVE_PERIOD * RIVER.k);
/** A river speed (m/s) rounded so its ripples wrap with the clock. */
export const riverSpeed = (v) => RIVER_SPEED_STEP * Math.max(1, Math.round(v / RIVER_SPEED_STEP));
export const STILL = { amp: 0.012, kx: 0.9, kz: 0.4, w: cyc(0.8) };

/** The wave clock for the world's synced milliseconds — seconds into the current WAVE_PERIOD. */
export const waveClock = (serverMs) => ((serverMs % (WAVE_PERIOD * 1000)) + WAVE_PERIOD * 1000) % (WAVE_PERIOD * 1000) / 1000;

const sm = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

/** How far above (or below) the still level the surface stands at (x, z) at wave time `t`.
 *  `w` is shared/waterkind.js's sample there (it reads {kind, depth, flow, waveSpeed, toShore}), or null on dry ground. */
export function surfaceOffset(w, x, z, t) {
  if (!w) return 0;
  if (w.kind === 'ocean' && w.toShore) {
    const O = OCEAN, [sx, sz] = w.toShore;
    const o = x * sx + z * sz, oc = z * sx - x * sz;
    const p1 = o * O.k1 - t * O.w1 + Math.sin(oc * O.crestK) * O.crestBend;
    const p2 = o * O.k2 + oc * O.across2 - t * O.w2;
    const amp = O.ampShore + (O.ampDeep - O.ampShore) * sm(O.ampFrom, O.ampTo, w.depth);
    const crest = (p) => Math.sin(p) + O.harmonic * Math.sin(2 * p);
    return amp * crest(p1) + amp * O.share2 * crest(p2);
  }
  if (w.kind === 'river' && w.flow) {
    const a = x * w.flow[0] + z * w.flow[1];
    return RIVER.amp * Math.sin((a - t * w.waveSpeed) * RIVER.k);
  }
  return STILL.amp * Math.sin(x * STILL.kx + z * STILL.kz - t * STILL.w);
}
