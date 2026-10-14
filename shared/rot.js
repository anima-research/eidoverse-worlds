// rot — entity orientation as a unit quaternion [x, y, z, w], with yaw as
// the friendly subset (PROTOCOL §9: "quaternions where full rotation is
// needed — never Euler triples").
//
// Folds run on every runtime and must agree bit for bit, so nothing here
// touches a host transcendental: trig goes through simmath's owned kernels,
// everything else is + − × ÷ and sqrt (exact everywhere).

import { sinT, cosT, atan2T, PI } from './simmath.js';

/** A usable quaternion arg, normalized — or null (the fold's "finite or
 *  nothing" rule: a malformed q shapes nothing). */
export function qNorm(q) {
  if (!Array.isArray(q) || q.length !== 4 || !q.every(Number.isFinite)) return null;
  const n = Math.sqrt(q[0] * q[0] + q[1] * q[1] + q[2] * q[2] + q[3] * q[3]);
  if (!(n > 1e-9)) return null;
  return [q[0] / n, q[1] / n, q[2] / n, q[3] / n];
}

/** The rotation of `yaw` radians about +Y. */
export function qFromYaw(yaw) {
  const h = yaw / 2;
  return [0, sinT(h), 0, cosT(h)];
}

/** Hamilton product a ⊗ b (apply b, then a). */
export function qMul(a, b) {
  return [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
  ];
}

/** Rotate vector v by unit quaternion q. */
export function qRotate(q, v) {
  const [x, y, z, w] = q;
  const tx = 2 * (y * v[2] - z * v[1]), ty = 2 * (z * v[0] - x * v[2]), tz = 2 * (x * v[1] - y * v[0]);
  return [
    v[0] + w * tx + (y * tz - z * ty),
    v[1] + w * ty + (z * tx - x * tz),
    v[2] + w * tz + (x * ty - y * tx),
  ];
}

/** Heading of an orientation: yaw = atan2(fx, fz) of where +Z ends up
 *  (PROTOCOL §9's definition). When the thing faces straight up or down
 *  that direction has no heading, so read it off the thing's TOP instead —
 *  the continuous limit: tip a chair onto its face and its top points where
 *  it was facing; onto its back, away. Turning about +Y therefore always
 *  moves the heading by exactly the turn, tipped or not. */
export function qHeading(q) {
  const f = qRotate(q, [0, 0, 1]);
  if (f[0] * f[0] + f[2] * f[2] > 1e-12) return atan2T(f[0], f[2]);
  const u = qRotate(q, [0, 1, 0]), s = f[1] < 0 ? 1 : -1;
  return atan2T(s * u[0], s * u[2]);
}

/** Turn an orientation about world +Y so its heading becomes `yaw`,
 *  keeping its tilt — a yaw-only `place` on a toppled chair spins it where
 *  it lies instead of standing it up. */
export function qWithHeading(q, yaw) {
  return qNorm(qMul(qFromYaw(yaw - qHeading(q)), q));
}

/** The orientation an entity folds to: its q if it has one, else its yaw. */
export function orientOf(ent) {
  return ent?.q ?? qFromYaw(ent?.yaw ?? 0);
}

// A thing lying down (a tumbling engine lays things on their sides): the yaw of its horizontal axes and its local box
// [min, max] turned into that yawed frame, for readers that work root-local with a yaw (the walker, an agent's support).
// null while it stands (its own up within 10° of the world's): read it by its yaw as always. Exact when it lies on a
// face; the bounding box when it balances on an edge. Yaw in three's convention (rotation.y; +x turns toward -z).
const UPRIGHT = cosT(10 * PI / 180);
export function lyingFrame(q, min, max) {
  const [x, y, z, w] = q;
  const R = [[1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
    [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
    [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)]];
  const ups = [0, 1, 2].map((k) => Math.abs(R[1][k])); const k = ups.indexOf(Math.max(...ups));
  if (k === 1 && R[1][1] > UPRIGHT) return null;
  const j = k === 0 ? 1 : 0; const yaw = atan2T(-R[2][j], R[0][j]); const c = cosT(yaw), s = sinT(yaw);
  const M = [0, 1, 2].map((r) => [0, 1, 2].map((col) => (r === 0 ? c * R[0][col] - s * R[2][col] : r === 2 ? s * R[0][col] + c * R[2][col] : R[1][col])));
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const cx of [min[0], max[0]]) for (const cy of [min[1], max[1]]) for (const cz of [min[2], max[2]])
    for (let r = 0; r < 3; r++) { const v = M[r][0] * cx + M[r][1] * cy + M[r][2] * cz; if (v < lo[r]) lo[r] = v; if (v > hi[r]) hi[r] = v; }
  return { yaw, min: lo, max: hi };
}
