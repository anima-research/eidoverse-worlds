// euler — the channel box's Rotate X/Y/Z, read from and written into the
// stored quaternion `q` (shared/rot.js), in an entity's rotation order.
//
// ORDER NAMES ARE MAYA'S (and Blender's): "XYZ" means X is applied first, then
// Y, then Z, all about the parent's fixed axes — R = Rz · Ry · Rx, so Z is the
// outermost gimbal ring and X the innermost. three.js spells the same rotation
// with the letters reversed (its Euler order "ZYX"); tools/euler-test.ts pins
// the correspondence against three for all six orders.
//
// `q` is what the log stores, so Euler angles here are a READING of it, never
// state. Two consequences the editor relies on:
//   - every triple composes exactly into q (no gimbal accumulation), and an
//     edit to one channel recomposes from the other two as read;
//   - a rotation has two Euler readings (a, b, c) and (a+180°, 180°−b, c+180°),
//     plus 360° wraps of each. eulerFromQ picks the one nearest a HINT (the
//     triple the viewer last saw), so the channels do not jump while you work;
//     without a hint, the middle angle reads in [−90°, 90°] and the others in
//     (−180°, 180°].
// Gimbal lock (middle angle at ±90°): the inner and outer axes coincide and
// only their sum (or difference) is defined. The inner channel then keeps the
// hint's value (0 with no hint) and the outer channel takes the rest — so an
// edit there still turns the thing by exactly what was typed, and the reading
// that comes back is the one the viewer typed when they pass it as the hint.
//
// UI math, not fold math: the q written from here is recorded as a result, so
// host Math is fine (rot.js keeps the owned trig the fold needs).

export const ROT_ORDERS = ['XYZ', 'XZY', 'YXZ', 'YZX', 'ZXY', 'ZYX'];
export const QUAT_MODE = 'quat';
export const ROT_MODES = [...ROT_ORDERS, QUAT_MODE];
/** The order an entity's channels read in: comp.rotOrder when valid, else XYZ. */
export const rotOrderOf = (ent) => (ROT_MODES.includes(ent?.comp?.rotOrder) ? ent.comp.rotOrder : 'XYZ');

const AX = { X: 0, Y: 1, Z: 2 };
const TAU = 2 * Math.PI;
/** The gimbal-lock threshold: cos(middle) below this = locked (≈0.00006° from ±90°). */
export const LOCK_EPS = 1e-6;

function axisQ(i, a) {
  const q = [0, 0, 0, Math.cos(a / 2)];
  q[i] = Math.sin(a / 2);
  return q;
}
function mul(a, b) {
  return [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
  ];
}
function norm(q) {
  const n = Math.hypot(q[0], q[1], q[2], q[3]);
  return [q[0] / n, q[1] / n, q[2] / n, q[3] / n];
}
/** Row-major 3×3 rotation matrix of a unit quaternion. */
function matOf([x, y, z, w]) {
  return [
    [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
    [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
    [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)],
  ];
}
const T = (m) => [[m[0][0], m[1][0], m[2][0]], [m[0][1], m[1][1], m[2][1]], [m[0][2], m[1][2], m[2][2]]];
const mm = (a, b) => a.map((r) => [0, 1, 2].map((j) => r[0] * b[0][j] + r[1] * b[1][j] + r[2] * b[2][j]));
function axisMat(i, a) {
  const c = Math.cos(a), s = Math.sin(a);
  const m = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  const p = (i + 1) % 3, r = (i + 2) % 3;
  m[p][p] = c; m[r][r] = c; m[r][p] = s; m[p][r] = -s;
  return m;
}
const axesOf = (order) => [...order].map((ch) => AX[ch]);
const wrapNear = (a, ref) => a - TAU * Math.round((a - ref) / TAU);

/** The quaternion of an Euler triple [x, y, z] (radians, indexed by AXIS, not
 *  by application order) in `order`: q = q_C ⊗ q_B ⊗ q_A for order "ABC". */
export function qFromEuler(e, order = 'XYZ') {
  const [i, j, k] = axesOf(order);
  return norm(mul(axisQ(k, e[k]), mul(axisQ(j, e[j]), axisQ(i, e[i]))));
}

/** The Euler reading [x, y, z] (radians, indexed by axis) of unit quaternion q
 *  in `order`, nearest `hint` ([x, y, z] or null). See the header for the
 *  branch and gimbal rules. Returns { e, locked }. */
export function eulerFromQ(q, order = 'XYZ', hint = null) {
  const [i, j, k] = axesOf(order);
  const s = (j - i + 3) % 3 === 1 ? 1 : -1;   // +1 for the cyclic orders (XYZ, YZX, ZXY)
  const R = matOf(norm(q));
  const cb = Math.hypot(R[k][j], R[k][k]);
  const b0 = Math.atan2(-s * R[k][i], cb);   // atan2, not asin: asin loses ~1e-8 rad near ±90°, exactly where it matters
  const locked = cb < LOCK_EPS;
  // the outer angle given the inner two, from what is left: R_k(c) = R · R_i(a)ᵀ · R_j(b)ᵀ.
  // Always consistent with (a, b), so the triple composes back to q even near the lock.
  const outer = (a, b) => {
    const M = mm(mm(R, T(axisMat(i, a))), T(axisMat(j, b)));
    const p = (k + 1) % 3, r = (k + 2) % 3;
    return Math.atan2(M[r][p], M[p][p]);
  };
  const cands = [];
  if (!locked) {
    const a0 = Math.atan2(s * R[k][j], R[k][k]);
    cands.push([a0, b0], [a0 + Math.PI, Math.PI - b0]);
  } else cands.push([hint ? hint[i] : 0, b0]);
  let best = null, bestD = Infinity;
  for (const [a, b] of cands) {
    const c = outer(a, b);
    const t = [0, 0, 0];
    t[i] = a; t[j] = b; t[k] = c;
    const ref = hint ?? [0, 0, 0];
    for (const ax of [0, 1, 2]) t[ax] = wrapNear(t[ax], ref[ax]);
    if (!hint) { if (!best) best = t; continue; }
    const d = Math.abs(t[0] - ref[0]) + Math.abs(t[1] - ref[1]) + Math.abs(t[2] - ref[2]);
    if (d < bestD - 1e-12) { best = t; bestD = d; }
  }
  return { e: best, locked };
}

/** One channel edit composed into q: read q in `order` (near `hint`), set
 *  axis `ax` (0|1|2) to `value` radians, recompose. Returns { q, e } — e is
 *  the triple that was composed, the viewer's next hint. */
export function setEulerChannel(q, order, hint, ax, value) {
  const { e } = eulerFromQ(q, order, hint);
  const next = [...e];
  next[ax] = value;
  return { q: qFromEuler(next, order), e: next };
}

/** q ≡ −q: the same rotation. */
export function sameRotation(a, b, eps = 1e-9) {
  const d = Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]);
  return d >= 1 - eps;
}
