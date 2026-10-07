// lookat — the turn a `look-at` component asks for, as a pure function (batch 2). Each client evaluates it every frame
// (client/lib/motion.js), like motion: the component is logged state, the turn is a view nobody logs. Pure maths, no
// three.js, so bun tests it and every client computes the same angle from the same inputs.
//
//   evalLookAt({rest, frame, at, target, la, prev, dt}) → {q, yaw, pitch, rested}
//     rest    the node's rest rotation, local to its parent [x,y,z,w]
//     frame   the parent's world rotation [x,y,z,w] (identity for a root)
//     at      the node's world position; target: the point to face (null: none in range → back to rest)
//     la      the component: {mode: yaw|aim, forward, up, yaw?: [min,max]°, pitch?: [min,max]°, speed °/s (0 = at once)}
//     prev    last frame's local rotation (null: start at rest); dt: seconds since
// Yaw turns about the node's own up (it stays upright: Blender's Locked Track); aim adds pitch, never roll (Damped Track
// with an up). Limits are degrees from rest. A target straight above a yaw-only node gives no heading: it keeps the last.
export const AXIS = { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1], '-x': [-1, 0, 0], '-y': [0, -1, 0], '-z': [0, 0, -1] };
const D2R = Math.PI / 180;
const axisOf = (a, d) => { const v = typeof a === 'string' ? AXIS[a] : Array.isArray(a) && a.length === 3 ? a : null; const n = v ? Math.hypot(...v) : 0; return n > 1e-9 ? v.map((x) => x / n) : AXIS[d]; };
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (v) => { const n = Math.hypot(...v); return n > 1e-12 ? v.map((x) => x / n) : v; };
export const qmul = (a, b) => [a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1], a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0], a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3], a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2]];
const qinv = (q) => [-q[0], -q[1], -q[2], q[3]];
export const qrot = (q, v) => { const p = qmul(qmul(q, [v[0], v[1], v[2], 0]), qinv(q)); return [p[0], p[1], p[2]]; };
export const qaxis = (ax, ang) => { const s = Math.sin(ang / 2); return [ax[0] * s, ax[1] * s, ax[2] * s, Math.cos(ang / 2)]; };
const qnorm = (q) => { const n = Math.hypot(...q); return n > 1e-12 ? q.map((x) => x / n) : [0, 0, 0, 1]; };
/** The angle between two rotations, radians (0..π). */
export const qangle = (a, b) => 2 * Math.acos(Math.min(1, Math.abs(dot(a, b) + a[3] * b[3])));
function slerp(a, b, t) {
  let c = dot(a, b) + a[3] * b[3]; let bb = b;
  if (c < 0) { c = -c; bb = b.map((x) => -x); }
  if (c > 0.9995) return qnorm(a.map((x, i) => x + (bb[i] - x) * t));
  const th = Math.acos(c), s = Math.sin(th), wa = Math.sin((1 - t) * th) / s, wb = Math.sin(t * th) / s;
  return a.map((x, i) => x * wa + bb[i] * wb);
}
const clamp = (x, lim) => (Array.isArray(lim) && lim.length === 2 ? Math.min(lim[1] * D2R, Math.max(lim[0] * D2R, x)) : x);

export function evalLookAt({ rest = [0, 0, 0, 1], frame = [0, 0, 0, 1], at, target, la = {}, prev = null, dt = 0 }) {
  const F = axisOf(la.forward, 'z');
  let U = axisOf(la.up, 'y'); U = norm(U.map((x, i) => x - dot(U, F) * F[i]));      // up, made square to forward
  if (Math.hypot(...U) < 1e-6) U = Math.abs(F[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  const S = cross(U, F);                                                              // a +yaw turns F toward S
  const R = qmul(frame, rest);                                                        // the rest frame, in the world
  const from = prev ?? rest;
  let want = rest, yaw = 0, pitch = 0, rested = true;
  if (target && at) {
    const d = qrot(qinv(R), [target[0] - at[0], target[1] - at[1], target[2] - at[2]]);
    const f = dot(d, F), s = dot(d, S), u = dot(d, U), h = Math.hypot(f, s);
    if (h < 1e-6) {                                                                    // straight above or below: no heading
      return { q: from, yaw: null, pitch: null, rested: false };
    }
    yaw = clamp(Math.atan2(s, f), la.yaw);
    pitch = la.mode === 'aim' ? clamp(Math.atan2(u, h), la.pitch) : 0;
    want = qmul(rest, qmul(qaxis(U, yaw), qaxis(S.map((x) => -x), pitch)));
    rested = false;
  }
  const speed = Number.isFinite(la.speed) ? la.speed : 240;
  if (speed <= 0 || !prev) return { q: qnorm(want), yaw, pitch, rested };
  const ang = qangle(from, want), step = Math.min(speed, 3600) * D2R * Math.max(0, dt);
  return { q: ang <= step || ang < 1e-9 ? qnorm(want) : qnorm(slerp(from, want, step / ang)), yaw, pitch, rested };
}
