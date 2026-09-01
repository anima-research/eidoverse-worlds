// terrainmath — the terrain height law as owned numerics (Covenant I).
//
// A faithful port of the eidoverse toolkit's makeTerrain height function
// (eidoverse-video/eidoverse/terrain.js: mulberry32 → 64×64 value-noise grid
// → fBm → amplitude + flat-radius blend), re-expressed inside the blessed
// exact-op set so the deterministic sim (eidosim@0.2.0) may ground bodies on
// it. The toolkit's law was ALREADY almost covenant-clean — integer-hash
// PRNG, lerp/smoothstep, floor; no transcendental anywhere — with exactly
// two unblessed calls, substituted here:
//
//   - Math.pow(0.5, octaves) → the same value accumulated by halving (for
//     the integer octaves in use the results are bit-identical);
//   - Math.hypot(x, z) → Math.sqrt(x*x + z*z) (hypot is implementation-
//     approximated and historically differs across engines; sqrt is the
//     blessed op; at world scale the overflow guard hypot exists for is
//     irrelevant, and the ~1-ulp difference in the flat-radius blend is
//     nanometres of ground).
//
// One consequence stated honestly: the CLIENT's rendered mesh and walking
// heightAt still come from the toolkit's own function (vendored, eval-
// loaded); this module is the SIM's ground truth. The two agree to ~1 ulp
// everywhere (measured in tools/sim-test.ts), which is nanometres — but the
// covenant identity that matters (server sim ≡ client shadow sim ≡ any
// replay, bit for bit) holds because ALL sim consumers use THIS law.
//
// THE CONSTANTS AND THE EVALUATION ORDER ARE THE VERSION (Covenant II):
// this law is pinned by eidosim@0.2.0 — editing anything here that moves a
// bit is an epoch bump of the SIM, never a patch.

/** Normalize terrain-verb args to the canonical parameter set, with the
 *  TOOLKIT's own defaults — the sim must assume exactly what the mesh
 *  builder assumes. @param {Record<string, unknown>} a */
export function terrainParams(a) {
  const num = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
  return {
    size: num(a?.size, 80),
    amplitude: num(a?.amplitude, 3),
    seed: Number.isFinite(a?.seed) ? Math.trunc(/** @type {number} */(a.seed)) : 1,
    flatRadius: num(a?.flatRadius, 0),
    flatHeight: num(a?.flatHeight, 0),
    octaves: Math.max(1, Math.min(8, Math.trunc(num(a?.octaves, 4)))),
    frequency: num(a?.frequency, 2.5),
  };
}

/** Build the height function for one terrain. Pure of everything but its
 *  params; the grid build is integer-hash exact.
 *  @param {ReturnType<typeof terrainParams>} P
 *  @returns {(x: number, z: number) => number} */
export function makeHeightField(P) {
  // mulberry32 — integer ops only, bit-exact on every engine
  let s = (P.seed | 0) || 1;
  const rand = () => {
    s |= 0; s = (s + 0x6D2B79F5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const GS = 64;
  // Float32Array stores round exactly per IEEE — deterministic; and it is
  // what the toolkit does, so the grids are bit-identical
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
  return (x, z) => {
    const u = (x / size + 0.5) * frequency, v = (z / size + 0.5) * frequency;
    let h = (fbm(u, v) - 0.5) * 2 * amplitude;
    if (flatRadius > 0) {
      const d = Math.sqrt(x * x + z * z);          // sqrt, not hypot — see header
      const k = sm((d - flatRadius) / Math.max(0.001, flatRadius * 0.6));
      h = lerp(flatHeight, h, k);
    }
    return h;
  };
}
