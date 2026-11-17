// simmath — deterministic sin/cos/atan2/exp for sim code. The host's Math.* are implementation-approximated, and two
// correct engines disagreeing in the last bit is a forked world; everything here is built only from IEEE-754-exact
// operations (+ − × ÷, sqrt, comparisons, floor/abs/min/max, explicit-endian byte views) in a FIXED order, so the
// result is bit-identical on every conforming engine.
//
// THE COEFFICIENTS ARE THE VERSION: changing any constant, reduction word or polynomial order changes what old logs
// replay to. That is an epoch bump (SIMMATH_ID), never a patch.
//
// Accuracy: within ~4.5e-16 absolute of libm (about 2 ulp of a result near 1; near a zero of sin/cos that is many ulps of
// the tiny result), not correctly rounded (identical matters, not perfect). Two-word Cody–Waite reduction keeps full
// accuracy to |x| ≤ ~1e6 rad; beyond that it degrades identically everywhere. NaN in → NaN out; sinT/cosT(±∞) → NaN;
// expT(−∞) → 0, expT(+∞) → +∞.

export const SIMMATH_ID = 'simmath@0.1.0';

// Math.PI is the spec-exact double nearest π.
export const PI = Math.PI;
export const TAU = 2 * PI;

// ---- exact building blocks --------------------------------------------------

// π/2 as a Cody–Waite pair: PIO2_HI carries ~33 leading bits so n·PIO2_HI is exact for |n| < ~2^20; the tail is PIO2_LO.
const PIO2_HI = 1.57079632673412561417e+00;
const PIO2_LO = 6.07710050650619224932e-11;
const TWO_OVER_PI = 2 / PI;

// ln2 split the same way, for expT's reduction.
const LN2_HI = 6.93147180369123816490e-01;
const LN2_LO = 1.90821492927058770002e-10;
const INV_LN2 = 1 / LN2_HI;   // reduction estimate only — exactness not required

// Taylor coefficients as divisions of exact integers (every factorial < 2^53): the same double on every engine.
const S3 = -1 / 6, S5 = 1 / 120, S7 = -1 / 5040, S9 = 1 / 362880;
const S11 = -1 / 39916800, S13 = 1 / 6227020800, S15 = -1 / 1307674368000;
const S17 = 1 / 355687428096000;
const C2 = -1 / 2, C4 = 1 / 24, C6 = -1 / 720, C8 = 1 / 40320;
const C10 = -1 / 3628800, C12 = 1 / 479001600, C14 = -1 / 87178291200;
const C16 = 1 / 20922789888000;
const E2 = 1 / 2, E3 = 1 / 6, E4 = 1 / 24, E5 = 1 / 120, E6 = 1 / 720;
const E7 = 1 / 5040, E8 = 1 / 40320, E9 = 1 / 362880, E10 = 1 / 3628800;
const E11 = 1 / 39916800, E12 = 1 / 479001600, E13 = 1 / 6227020800;
const A3 = -1 / 3, A5 = 1 / 5, A7 = -1 / 7, A9 = 1 / 9, A11 = -1 / 11;
const A13 = 1 / 13, A15 = -1 / 15, A17 = 1 / 17, A19 = -1 / 19;

// 2^k from exponent bits through a DataView with endianness pinned (a bare Uint32Array would flip words on a
// big-endian host). Normal range only: callers split larger |k| into two steps. The self-check at the bottom guards it.
const _bv = new DataView(new ArrayBuffer(8));
function pow2(k) {
  _bv.setUint32(0, 0, true);
  _bv.setUint32(4, (k + 1023) << 20, true);
  return _bv.getFloat64(0, true);
}

// kernel sine on |r| ≤ π/4 + reduction slack: fixed Horner order.
function sinK(r) {
  const z = r * r;
  return r + r * (z * (S3 + z * (S5 + z * (S7 + z * (S9 + z * (S11
    + z * (S13 + z * (S15 + z * S17))))))));
}
// kernel cosine on the same range: fixed Horner order.
function cosK(r) {
  const z = r * r;
  return 1 + z * (C2 + z * (C4 + z * (C6 + z * (C8 + z * (C10
    + z * (C12 + z * (C14 + z * C16)))))));
}

/** Reduce x to (k mod 4, r) with x ≈ k·π/2 + r, |r| ≲ π/4: accurate to |x| ≈ 1e6 (two words of π/2); past that r drifts. */
function reduce(x) {
  const n = Math.floor(x * TWO_OVER_PI + 0.5);
  const r = (x - n * PIO2_HI) - n * PIO2_LO;
  // k = n mod 4 in {0,1,2,3} — exact integer arithmetic on doubles
  const k = n - 4 * Math.floor(n / 4);
  return { k, r };
}

/** Deterministic sine. @param {number} x radians */
export function sinT(x) {
  if (!Number.isFinite(x)) return NaN;
  const { k, r } = reduce(x);
  return k === 0 ? sinK(r) : k === 1 ? cosK(r) : k === 2 ? -sinK(r) : -cosK(r);
}

/** Deterministic cosine. @param {number} x radians */
export function cosT(x) {
  if (!Number.isFinite(x)) return NaN;
  const { k, r } = reduce(x);
  return k === 0 ? cosK(r) : k === 1 ? -sinK(r) : k === 2 ? -cosK(r) : sinK(r);
}

// arctangent kernel on |t| ≤ ~0.2 (after two halvings): fixed Horner order.
function atanK(t) {
  const z = t * t;
  return t + t * (z * (A3 + z * (A5 + z * (A7 + z * (A9 + z * (A11
    + z * (A13 + z * (A15 + z * (A17 + z * A19)))))))));
}
// atan on [0, 1]: two halvings by atan(t) = 2·atan(t / (1 + √(1+t²))), then the kernel, then ×4.
function atan01(t) {
  const t1 = t / (1 + Math.sqrt(1 + t * t));
  const t2 = t1 / (1 + Math.sqrt(1 + t1 * t1));
  return 4 * atanK(t2);
}

/** Deterministic atan2 — the four-quadrant angle of (x, y), in (−π, π].
 *  @param {number} y @param {number} x */
export function atan2T(y, x) {
  if (!Number.isFinite(y) || !Number.isFinite(x)) return NaN;
  if (y === 0 && x === 0) return 0;          // the origin has no direction — fixed word
  const ay = Math.abs(y), ax = Math.abs(x);
  let a;                                      // the acute angle in [0, π/2]
  if (ay <= ax) a = atan01(ay / ax);
  else a = PI / 2 - atan01(ax / ay);          // PI/2 is an exact-op constant
  if (x >= 0) return y >= 0 ? a : -a;
  return y >= 0 ? PI - a : a - PI;
}

/** Deterministic natural exponential. @param {number} x */
export function expT(x) {
  if (Number.isNaN(x)) return NaN;
  if (x === Infinity) return Infinity;
  if (x === -Infinity) return 0;
  if (x > 709.782712893384) return Infinity;  // overflow threshold, fixed
  if (x < -745.2) return 0;                   // underflow-to-zero, fixed
  const k = Math.floor(x * INV_LN2 + 0.5);
  const r = (x - k * LN2_HI) - k * LN2_LO;
  const p = 1 + r * (1 + r * (E2 + r * (E3 + r * (E4 + r * (E5 + r * (E6
    + r * (E7 + r * (E8 + r * (E9 + r * (E10 + r * (E11 + r * (E12
    + r * E13))))))))))));
  // scale by 2^k in exact halves: each factor stays in pow2's normal range
  if (k >= -1021 && k <= 1023) return p * pow2(k);
  if (k > 1023) {
    const q = p * pow2(1023);
    return q * pow2(k - 1023);                // may overflow to Infinity — fine
  }
  const q = p * pow2(-1021);
  return q * pow2(k + 1021);                  // may denormalize/underflow — fine
}

// ---- self-check: a build whose pow2 assembly is broken refuses at import rather than folding worlds wrong quietly ----
if (pow2(0) !== 1 || pow2(3) !== 8 || pow2(-3) !== 0.125 || pow2(-1021) * pow2(-1) !== Number.MIN_VALUE * 4503599627370496) {
  throw new Error('[simmath] pow2 bit-assembly failed its self-check — this host cannot serve the sim covenant');
}
