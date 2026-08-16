// motioneval — the whole-entity motion closed forms, as pure math.
//
// Extracted from motion.js (#82 review): the browser render loop and the
// agent's text-tier perception must agree on where a moving thing IS, and
// the only way two runtimes agree forever is to evaluate the same file.
// This module is deliberately dependency-free — no THREE, no DOM, no scene,
// no clock: callers pass {base, motion, nowMs} in and get a transform out.
// motion.js consumes it per frame; mcpl/agent.ts consumes it at read time.
//
// Contract: evalWholeMotion returns a FINITE transform or an explicit
// refusal ({ok:false, why}) — never a partially-composed number. Unknown
// motion types are a refusal here even though the renderer quietly shows
// such things at rest: a renderer that draws stillness is visibly guessing,
// but a printed coordinate claims to be truth (#82's whole disease).
//
// Part-frame motion (`motion:<part>` keys, or a `motion` carrying `part`)
// does not displace the entity's ROOT transform at all — those stay in
// motion.js, THREE-side, and this module reports the root as unmoved.

// ---- quaternions, the four lines of them we need ---------------------------
// [x, y, z, w], same layout THREE uses. Right-handed, Y-up, radians.

export const qAxisAngle = (axis, angle) => {
  const [x, y, z] = axis;
  const n = Math.hypot(x, y, z) || 1;
  const s = Math.sin(angle / 2);
  return [(x / n) * s, (y / n) * s, (z / n) * s, Math.cos(angle / 2)];
};

export const qMul = (a, b) => {
  const [ax, ay, az, aw] = a, [bx, by, bz, bw] = b;
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ];
};

export const qApply = (q, v) => {
  // v' = v + 2 * cross(q.xyz, cross(q.xyz, v) + w*v)
  const [qx, qy, qz, qw] = q, [vx, vy, vz] = v;
  const cx = qy * vz - qz * vy + qw * vx;
  const cy = qz * vx - qx * vz + qw * vy;
  const cz = qx * vy - qy * vx + qw * vz;
  return [
    vx + 2 * (qy * cz - qz * cy),
    vy + 2 * (qz * cx - qx * cz),
    vz + 2 * (qx * cy - qy * cx),
  ];
};

/** Yaw of a quaternion, by the house convention: the yaw whose +Z-forward
 *  matches the quaternion's, `atan2(x, z)` of the rotated forward vector. */
export const yawOfQuat = (q) => {
  const [fx, , fz] = qApply(q, [0, 0, 1]);
  return Math.atan2(fx, fz);
};

const yawQuat = (yaw) => qAxisAngle([0, 1, 0], yaw ?? 0);

// ---- the generous reader (verbatim from motion.js — see its history) -------
// Text-tier authors improvise dialect: `amplitude` for amp, `axis: "x"` for
// [1,0,0], no t0 at all. Parsing is where generosity lives; the closed form
// stays exact.

const AXES = { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1],
  '-x': [-1, 0, 0], '-y': [0, -1, 0], '-z': [0, 0, -1] };

export const axisOf = (m, def) => {
  const a = m.axis;
  if (Array.isArray(a) && a.length === 3) return a;
  if (typeof a === 'string' && AXES[a.toLowerCase()]) return AXES[a.toLowerCase()];
  return def;
};

export const ampOf = (m, def = 0) => {
  const v = Number(m.amp ?? m.amplitude ?? def);
  return Number.isFinite(v) ? v : def;
};

/** Seconds since the motion's epoch. A motion with NO t0 anchors to when
 *  this process first evaluated it — same per-client fallback motion.js has
 *  always had, held here in a WeakMap instead of a stowaway `_t0` property
 *  so evaluation never mutates a component bag it does not own. */
const t0Fallback = new WeakMap();
export const since = (m, nowMs) => {
  let t0 = m.t0;
  if (t0 == null) {
    t0 = t0Fallback.get(m);
    if (t0 == null) t0Fallback.set(m, (t0 = nowMs));
  }
  return Math.max(0, (nowMs - t0) / 1000);
};

/** ⚠ MIRRORS pendulumImpulse math in server/reactions.ts — keep in sync, or a
 *  joiner's swing disagrees with the one being pushed.
 *  Missing damp = 0 = swings FOREVER (friction is opt-in; see motion.js). */
export function pendulumTheta(m, t) {
  const w0 = (2 * Math.PI) / (m.period ?? 3.5);
  return ampOf(m) * Math.exp(-(m.damp ?? 0) * t) * Math.cos(w0 * t + (m.phase ?? 0));
}

/** rotateAtPivot, pure: rotate by `theta` about local `axis` at local point
 *  `pivot`, composed on the base pose. Returns {pos, quat}. */
function rotateAtPivot(base, axis, pivot, theta) {
  const q = qAxisAngle(axis ?? [0, 1, 0], theta);
  const qy = yawQuat(base.yaw);
  const quat = qMul(qy, q);
  const pv = pivot ?? [0, 0, 0];
  const rp = qApply(q, pv);                                  // pivot after rotation
  const shift = qApply(qy, [pv[0] - rp[0], pv[1] - rp[1], pv[2] - rp[2]]);
  return { pos: [base.pos[0] + shift[0], base.pos[1] + shift[1], base.pos[2] + shift[2]], quat };
}

// Path arc-length tables, cached per component object. A re-folded comp is a
// new object, so the cache invalidates exactly when the points can change —
// the same lifetime the old `m._len` stowaway had, without the mutation.
const pathLen = new WeakMap();

export function evalPath(m, t, base) {
  const pts = m.points;
  if (!Array.isArray(pts) || pts.length < 2) return { ok: false, why: "path needs ≥ 2 points" };
  let len = pathLen.get(m);
  if (!len) {
    len = [0];
    for (let i = 1; i < pts.length; i++) {
      const [ax, ay, az] = pts[i - 1]; const [bx, by, bz] = pts[i];
      len.push(len[i - 1] + Math.hypot(bx - ax, by - ay, bz - az));
    }
    pathLen.set(m, len);
  }
  const total = len[len.length - 1] || 1;
  const speed = m.speed ?? (m.duration ? total / m.duration : 1);
  let s = speed * t;
  const loop = m.loop ?? 'loop';
  if (loop === 'loop') s %= total;
  else if (loop === 'pingpong') { s %= 2 * total; if (s > total) s = 2 * total - s; }
  else s = Math.min(s, total);                               // 'once': arrive and stay
  let i = 1;
  while (i < len.length - 1 && len[i] < s) i++;
  const seg = len[i] - len[i - 1] || 1;
  const f = (s - len[i - 1]) / seg;
  const [ax, ay, az] = pts[i - 1]; const [bx, by, bz] = pts[i];
  const pos = [ax + (bx - ax) * f, ay + (by - ay) * f, az + (bz - az) * f];
  if (m.face !== false) {
    const yaw = Math.atan2(bx - ax, bz - az);
    return { ok: true, pos, yaw, quat: yawQuat(yaw), rot: true };
  }
  return { ok: true, pos, yaw: base.yaw ?? 0, quat: yawQuat(base.yaw), rot: false };
}

/**
 * Evaluate a WHOLE-ENTITY motion component at `nowMs`, composed on the
 * entity's logged base pose.
 *
 *   base:  {pos: [x,y,z], yaw}    — the spawn/place rest transform
 *   m:     the motion component's data ({type, ...params, t0?})
 *   nowMs: epoch ms on the sequencer's clock (caller's responsibility —
 *          motion.js passes serverNow(), the agent passes its own estimate)
 *
 * Returns {ok:true, pos, yaw, quat, rot} — `rot: false` means this motion
 * type leaves the entity's authored rotation alone (bob; face:false orbit
 * and path), which the renderer honors by not touching obj.rotation —
 * or {ok:false, why} for anything it will not vouch for: unknown types,
 * malformed paths, non-finite params. Part-frame motion (`m.part`) returns
 * the base pose unchanged with rot:false — parts swing, roots stand still.
 */
export function evalWholeMotion(base, m, nowMs) {
  if (!m || typeof m.type !== "string") return { ok: false, why: "no motion type" };
  if (typeof m.part === "string") {
    // animates ONE NAMED NODE of the model; the root transform is untouched
    return { ok: true, pos: [...base.pos], yaw: base.yaw ?? 0, quat: yawQuat(base.yaw), rot: false };
  }
  const t = since(m, nowMs);
  let r;
  switch (m.type) {
    case 'pendulum':
      r = { ok: true, rot: true, yaw: null,
        ...rotateAtPivot(base, axisOf(m, [1, 0, 0]), m.pivot ?? [0, 2, 0], pendulumTheta(m, t)) };
      break;
    case 'spin': {
      const rate = m.degPerSec != null ? m.degPerSec : (m.rpm ?? 6) * 6;   // rpm → deg/s
      r = { ok: true, rot: true, yaw: null,
        ...rotateAtPivot(base, axisOf(m, [0, 1, 0]), m.pivot ?? [0, 0, 0],
          (m.phase ?? 0) + (rate * Math.PI / 180) * t) };
      break;
    }
    case 'orbit': {
      const c = m.center ?? base.pos;
      const rad = m.radius ?? 3;
      const a = (m.phase ?? 0) + ((m.degPerSec ?? 12) * Math.PI / 180) * t;
      const pos = [c[0] + rad * Math.sin(a), (c[1] ?? base.pos[1]), c[2] + rad * Math.cos(a)];
      r = m.face !== false
        ? { ok: true, pos, yaw: a + Math.PI / 2, quat: yawQuat(a + Math.PI / 2), rot: true }
        : { ok: true, pos, yaw: base.yaw ?? 0, quat: yawQuat(base.yaw), rot: false };
      break;
    }
    case 'bob': {
      const off = Math.sin((2 * Math.PI / (m.period ?? 4)) * t + (m.phase ?? 0)) * ampOf(m, 0.3);
      const ax = axisOf(m, [0, 1, 0]);
      const n = Math.hypot(...ax) || 1;
      r = { ok: true, rot: false, yaw: base.yaw ?? 0, quat: yawQuat(base.yaw),
        pos: [base.pos[0] + (ax[0] / n) * off, base.pos[1] + (ax[1] / n) * off, base.pos[2] + (ax[2] / n) * off] };
      break;
    }
    case 'path':
      r = evalPath(m, t, base);
      break;
    default:
      return { ok: false, why: `motion type "${m.type}" not supported here` };
  }
  if (!r.ok) return r;
  if (r.yaw == null) r.yaw = yawOfQuat(r.quat);
  if (!r.pos.every(Number.isFinite) || !Number.isFinite(r.yaw) || !r.quat.every(Number.isFinite)) {
    return { ok: false, why: `motion "${m.type}" produced a non-finite transform` };
  }
  return r;
}
