// shared/climb.js — a climb route (componentspec climb): straight lines between points in the host's own frame, and a
// climber's place on it as one scalar, progress, metres along it from its first point (Godot Path3D + PathFollow3D.progress).
// A pose is resolved through the host's pose each time it is asked (a moving carrier carries its climbers). Pure.
import { qRotate } from "./rot.js";

/** The readings of an absent reach and speed (componentspec climb absentMeans). */
export const CLIMB = Object.freeze({ reach: 1.4, speed: 1.3 });
const fin = Number.isFinite;
const v3 = (p) => Array.isArray(p) && p.length === 3 && p.every(fin);

/** A climb value as a route {points, cum, length, reach, speed, face, ends}, or null when it isn't one (2–16 points). */
export function routeOf(c) {
  const pts = c?.points;
  if (!Array.isArray(pts) || pts.length < 2 || pts.length > 16 || !pts.every(v3)) return null;
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1], pts[i][2] - pts[i - 1][2]));
  const clamp = (x, lo, hi, d) => (fin(x) ? Math.min(hi, Math.max(lo, x)) : d);
  return { points: pts.map((p) => [...p]), cum, length: cum[cum.length - 1], reach: clamp(c.reach, 0.3, 3, CLIMB.reach), speed: clamp(c.speed, 0.3, 4, CLIMB.speed),
    face: localFacing(pts, c.face), ends: ["start", "end"].includes(c.ends) ? c.ends : "both" };
}

/** Which way a climber faces, a unit [x, 0, z] in the host's frame: face's ground part; absent, the route's run from its first
 *  point to its last; a route with no run (collinear and vertical) faces the host's +z. */
export function localFacing(pts, face) {
  const g = (d) => { const n = Math.hypot(d[0], d[2]); return n > 1e-6 ? [d[0] / n, 0, d[2] / n] : null; };
  if (v3(face)) { const f = g(face); if (f) return f; }
  const a = pts[0], b = pts[pts.length - 1];
  return g([b[0] - a[0], 0, b[2] - a[2]]) ?? [0, 0, 1];
}

/** The point at `progress` (metres along, clamped to the route), in the host's frame. */
export function localAt(route, progress) {
  const s = Math.min(route.length, Math.max(0, fin(progress) ? progress : 0)), { points: P, cum } = route;
  let i = 1; while (i < P.length - 1 && cum[i] < s) i++;
  const seg = cum[i] - cum[i - 1], k = seg > 0 ? (s - cum[i - 1]) / seg : 1;
  return [0, 1, 2].map((j) => P[i - 1][j] + (P[i][j] - P[i - 1][j]) * k);
}

/** A point in the host's frame → world, through its pose {pos, q, scale} (simlayer worldPose's, or a renderer's live one). */
export function toWorld(pose, p) {
  const s = v3(pose?.scale) ? pose.scale : [1, 1, 1], r = qRotate(pose?.q ?? [0, 0, 0, 1], [p[0] * s[0], p[1] * s[1], p[2] * s[2]]);
  return [r[0] + pose.pos[0], r[1] + pose.pos[1], r[2] + pose.pos[2]];
}

/** A climber's world pose {pos, yaw} at `progress`, through the host's pose (yaw: atan2(x, z) of the world facing). */
export function climbPose(pose, route, progress) {
  const f = qRotate(pose?.q ?? [0, 0, 0, 1], route.face);
  return { pos: toWorld(pose, localAt(route, progress)), yaw: Math.atan2(f[0], f[2]) };
}

/** The end a body at world point `at` may board: {progress (0 or length), dir (+1 up the route, −1 down), distance}, nearest
 *  first, within reach and allowed by ends; null when none. */
export function boardAt(pose, route, at) {
  let best = null;
  for (const [end, progress, dir] of [["start", 0, 1], ["end", route.length, -1]]) {
    if (route.ends !== "both" && route.ends !== end) continue;
    const p = toWorld(pose, localAt(route, progress)), d = Math.hypot(p[0] - at[0], p[1] - at[1], p[2] - at[2]);
    if (d <= route.reach && (!best || d < best.distance)) best = { progress, dir, distance: d };
  }
  return best;
}

/** One step along the route: {progress, done} (done at the far end). dt is capped at 0.1 s, as upstream's stepTraversal. */
export function stepClimb(route, progress, dir, dt) {
  const p = progress + dir * route.speed * Math.max(0, Math.min(0.1, dt));
  const done = dir > 0 ? p >= route.length : p <= 0;
  return { progress: Math.min(route.length, Math.max(0, p)), done };
}

/** A presence climb {host, progress} as sent (presence only, never the log): null unless host is a short string and progress finite ≥ 0. */
export function climbWire(c) {
  return c && typeof c === "object" && typeof c.host === "string" && c.host.length > 0 && c.host.length <= 256 && fin(c.progress) && c.progress >= 0 ? { host: c.host, progress: Math.round(c.progress * 1000) / 1000 } : null;
}
