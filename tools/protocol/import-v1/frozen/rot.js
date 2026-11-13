// rot — entity orientation as a unit quaternion [x, y, z, w], with yaw as
// the friendly subset (PROTOCOL §9: "quaternions where full rotation is
// needed — never Euler triples").
//
// Folds run on every runtime and must agree bit for bit, so nothing here
// touches a host transcendental: trig goes through simmath's owned kernels,
// everything else is + − × ÷ and sqrt (exact everywhere).

import { sinT, cosT, atan2T } from './simmath.js';

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
