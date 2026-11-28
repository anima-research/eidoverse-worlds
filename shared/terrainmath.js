// terrainmath — the terrain height law in exact arithmetic, so the deterministic sim can ground bodies on it.
//
// A port of the eidoverse toolkit's makeTerrain (mulberry32 → 64×64 value-noise grid → fBm → amplitude + flat-radius
// blend) with its two non-exact calls replaced: Math.pow(0.5, octaves) by halving, Math.hypot by sqrt(x²+z²) (hypot
// differs across engines; the difference is nanometres of ground). The client's mesh still comes from the toolkit's
// function (client/lib/world.js makeTerrain); they agree to ~1 ulp, and every SIM consumer uses this law.
//
// THE CONSTANTS AND THE EVALUATION ORDER ARE THE VERSION: eidosim's conformance digests hold this law
// (test/protocol/engine-check.ts, the onto-hills scenario); anything that moves a digest is a new engine version.
//
// SHAPING (features, heightmap: shared/terrainshape.js) rides on top only when the args use it, so no unshaped
// world's ground moves by a bit.

import { shapeParams, shapeHeight } from './terrainshape.js';

/** Normalize terrain-verb args to the canonical parameter set, with the
 *  TOOLKIT's own defaults — the sim must assume exactly what the mesh
 *  builder assumes. @param {Record<string, unknown>} a */
/** A flat ground's height (terrain {kind: 'flat', height}), else null: the readers that build no mesh for it ask this. */
export const flatHeightOf = (a) => (a?.kind === 'flat' ? (typeof a.height === 'number' && Number.isFinite(a.height) ? a.height : 0) : null);

export function terrainParams(a) {
  const num = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
  if (a?.kind === 'flat') return { flat: num(a.height, 0), size: 200 };   // level ground (componentspec terrain kind flat); size: the no-terrain projection's
  const shape = shapeParams(a);
  return {
    ...(shape ? { shape } : {}),
    size: num(a?.size, 80),
    amplitude: num(a?.amplitude, 3),
    seed: Number.isFinite(a?.seed) ? Math.trunc(/** @type {number} */(a.seed)) : 1,
    flatRadius: num(a?.flatRadius, 0),
    flatHeight: num(a?.flatHeight, 0),
    octaves: Math.max(1, Math.min(8, Math.trunc(num(a?.octaves, 4)))),
    frequency: num(a?.frequency, 2.5),
  };
}

/** Build the height function for one terrain. Pure of everything but its params.
 *  @param {ReturnType<typeof terrainParams>} P
 *  @returns {(x: number, z: number) => number} */
export function makeHeightField(P) {
  if (typeof P.flat === 'number') { const h = P.flat; return () => h; }
  // mulberry32 — integer ops only, bit-exact on every engine; a copy, not shared/rand.js, on purpose: the sim's import closure is pinned (siminputs-check.ts)
  let s = (P.seed | 0) || 1;
  const rand = () => {
    s |= 0; s = (s + 0x6D2B79F5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const GS = 64;
  // Float32Array rounding is IEEE-exact, and it is what the toolkit does, so the grids are bit-identical
  const grid = new Float32Array(GS * GS);
  for (let i = 0; i < grid.length; i++) grid[i] = rand();
  const lerp = (a, b, t) => a + (b - a) * t;
  const sm = (t) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));
  const g = (X, Y) => grid[((Y % GS + GS) % GS) * GS + ((X % GS + GS) % GS)];
  const vnoise = (x, y) => {
    const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
    return lerp(lerp(g(xi, yi), g(xi + 1, yi), sm(xf)),
      lerp(g(xi, yi + 1), g(xi + 1, yi + 1), sm(xf)), sm(yf));
  };
  // 1 - 0.5^octaves, accumulated by exact halving (no Math.pow)
  let norm = 1, half = 1;
  for (let o = 0; o < P.octaves; o++) { half *= 0.5; }
  norm = 1 - half;
  const fbm = (x, y) => {
    let v = 0, a = 0.5, f = 1;
    for (let o = 0; o < P.octaves; o++) { v += a * vnoise(x * f, y * f); a *= 0.5; f *= 2; }
    return v / norm;
  };
  const { size, amplitude, frequency, flatRadius, flatHeight } = P;
  const base = (x, z) => {
    const u = (x / size + 0.5) * frequency, v = (z / size + 0.5) * frequency;
    let h = (fbm(u, v) - 0.5) * 2 * amplitude;
    if (flatRadius > 0) {
      const d = Math.sqrt(x * x + z * z);          // sqrt, not hypot — see header
      const k = sm((d - flatRadius) / Math.max(0.001, flatRadius * 0.6));
      h = lerp(flatHeight, h, k);
    }
    return h;
  };
  return P.shape ? shapeHeight(base, P.shape, size) : base;
}
