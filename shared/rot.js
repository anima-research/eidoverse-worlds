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
  const n2 = q[0] * q[0] + q[1] * q[1] + q[2] * q[2] + q[3] * q[3];
  // already unit (to a few ulps): returned as it is, so a quaternion that needs nothing is never moved by one ulp, which
  // happened differently per platform (Windows rounded a unit q's re-normalisation the other way: channelbox, 10-22)
  if (Math.abs(n2 - 1) <= 8 * Number.EPSILON) return [q[0], q[1], q[2], q[3]];
  const n = Math.sqrt(n2);
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

/** Rotate vector v by unit quaternion q (into `out` when given; it may be v). */
export function qRotate(q, v, out = [0, 0, 0]) {
  const [x, y, z, w] = q, a = v[0], b = v[1], c = v[2];
  const tx = 2 * (y * c - z * b), ty = 2 * (z * a - x * c), tz = 2 * (x * b - y * a);
  out[0] = a + w * tx + (y * tz - z * ty);
  out[1] = b + w * ty + (z * tx - x * tz);
  out[2] = c + w * tz + (x * ty - y * tx);
  return out;
}

/** The conjugate: a unit quaternion's inverse. */
export const qConj = (q) => [-q[0], -q[1], -q[2], q[3]];

/** The rotation of `angle` radians about the unit vector `axis`. */
export function qAxisAngle(axis, angle) {
  const h = angle / 2, s = sinT(h);
  return [axis[0] * s, axis[1] * s, axis[2] * s, cosT(h)];
}

/** The world pose of a parent chain, root first, each link a local { pos, q, scale: [x, y, z] } in its parent's frame.
 *  The protocol's rule is glTF's (PROTOCOL §9.3): local = T · R · S, world = parent's world × local. This returns a TRS,
 *  not a matrix, so it is exact for the position (parent pos + R·(S·pos)) and exact for q and scale whenever every
 *  ancestor's scale is uniform; under a non-uniformly scaled ancestor a rotated child's true world transform shears (no
 *  TRS holds it), and here its q is the plain product and its scale the component-wise product (Unity's lossyScale).
 *  The stored data had 0 such cases at the shape audit (10-16).
 *  The authority compares this as JSON text with the engine's rests (authority/checks.js) and the engine's conformance
 *  digests start from it, so its float order is pinned: no renormalization between links. */
// TODO(shape audit 10-16): return the composed matrix (or flag the sheared case) if a reader ever needs the exact one.
export function composePose(chain) {
  let acc = chain[0];
  for (let i = 1; i < chain.length; i++) {
    const L = chain[i], s = acc.scale;
    const r = qRotate(acc.q, [L.pos[0] * s[0], L.pos[1] * s[1], L.pos[2] * s[2]]);
    acc = { pos: [acc.pos[0] + r[0], acc.pos[1] + r[1], acc.pos[2] + r[2]], q: qMul(acc.q, L.q), scale: [L.scale[0] * s[0], L.scale[1] * s[1], L.scale[2] * s[2]] };
  }
  return acc;
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
