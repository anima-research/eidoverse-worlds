// instances — what the DRAFT component `antra/instances` says (docs/guide/INSTANCES.md): one thing drawn many times.
// Pure (no THREE, no DOM): the reader (client/lib/realize/instances-draft.js), the Inspector and the tests all get a
// thing's copies from readInstances, so every viewer derives the same copies from the same value.
//
//   antra/instances = {
//     at?: [[x, y, z], [x, y, z, yaw], [x, y, z, yaw, scale], [x, y, z, qx, qy, qz, qw], [x, y, z, qx, qy, qz, qw, scale], …],
//     scatter?: {count, shape?, radius?, inner?, size?, to?, seed?, scale?, yaw?, tilt?, jitter?},
//     ground?: true,          // each copy stands on the world's ground under it
//     original?: false,       // false: only the copies are drawn, not the thing itself
//   }
// Places are in the thing's own frame (metres before its scale), so the copies move, turn and scale with it. A scatter
// is a function of its seed: nothing is stored per copy, and a hundred thousand copies cost one small value.

import { mulberry32 } from './rand.js';

export const INSTANCES = 'antra/instances';
/** Copies one thing may draw. A value asking for more draws this many. */
export const INSTANCE_MAX = 100000;
export const SCATTER_SHAPES = Object.freeze(['disc', 'ring', 'box', 'grid', 'line', 'sphere']);
/** What each shape reads, and what an absent field means. */
export const SCATTER_DEFAULTS = Object.freeze({ shape: 'disc', radius: 5, inner: 0, size: [10, 0, 10], to: [10, 0, 0], scale: 1, tilt: 0, jitter: 0 });

const fin = (v) => typeof v === 'number' && Number.isFinite(v);
const num = (v, d, lo = -1e6, hi = 1e6) => (fin(v) ? Math.min(hi, Math.max(lo, v)) : d);
const vec = (v, d) => (Array.isArray(v) && v.length === 3 && v.every(fin) ? v.map((x) => num(x, 0)) : d);
/** A stable seed from an id (FNV-1a), for a scatter that names none: each thing scatters its own way, the same for everyone. */
export function seedOf(s) { let h = 2166136261; for (const ch of String(s)) { h ^= ch.codePointAt(0); h = Math.imul(h, 16777619); } return h >>> 0; }

const yawQuat = (yaw) => [0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2)];
// a ⊗ b (apply b, then a)
const qmul = ([ax, ay, az, aw], [bx, by, bz, bw]) => [aw * bx + ax * bw + ay * bz - az * by, aw * by - ax * bz + ay * bw + az * bx, aw * bz + ax * by - ay * bx + az * bw, aw * bw - ax * bx - ay * by - az * bz];

function row(r) {
  if (!Array.isArray(r) || !r.every(fin) || r.length < 3 || r.length > 8 || r.length === 6) return null;
  const [x, y, z] = r;
  if (r.length <= 5) return [x, y, z, ...yawQuat(r[3] ?? 0), num(r[4], 1, 1e-4, 1e4)];
  const l = Math.hypot(r[3], r[4], r[5], r[6]); if (!(l > 1e-9)) return null;
  return [x, y, z, r[3] / l, r[4] / l, r[5] / l, r[6] / l, num(r[7], 1, 1e-4, 1e4)];
}

function scatter(s, id, room, out) {
  if (!s || typeof s !== 'object' || Array.isArray(s)) return;
  const count = Math.min(room, Math.floor(num(s.count, 0, 0, INSTANCE_MAX)));
  if (count < 1) return;
  const shape = SCATTER_SHAPES.includes(s.shape) ? s.shape : SCATTER_DEFAULTS.shape;
  const radius = num(s.radius, SCATTER_DEFAULTS.radius, 0), inner = Math.min(radius, num(s.inner, SCATTER_DEFAULTS.inner, 0));
  const size = vec(s.size, SCATTER_DEFAULTS.size).map(Math.abs), to = vec(s.to, SCATTER_DEFAULTS.to);
  const jitter = num(s.jitter, SCATTER_DEFAULTS.jitter, 0, 1), tilt = num(s.tilt, SCATTER_DEFAULTS.tilt, 0, Math.PI);
  const sc = Array.isArray(s.scale) && s.scale.length === 2 && s.scale.every(fin) ? s.scale : [num(s.scale, 1), num(s.scale, 1)];
  const [smin, smax] = [Math.min(sc[0], sc[1]), Math.max(sc[0], sc[1])].map((v) => num(v, 1, 1e-4, 1e4));
  // which way each copy faces: every way (random), away from the middle (out), toward it (in), or one heading (radians)
  const facing = fin(s.yaw) || ['random', 'out', 'in'].includes(s.yaw) ? s.yaw : shape === 'ring' ? 'out' : shape === 'grid' || shape === 'line' ? 0 : 'random';
  const rnd = mulberry32(fin(s.seed) ? s.seed >>> 0 : seedOf(id));
  const nx = shape === 'grid' ? Math.max(1, Math.min(count, size[2] > 0 ? Math.round(Math.sqrt(count * size[0] / size[2])) || 1 : count)) : 1, nz = Math.ceil(count / nx);
  for (let i = 0; i < count; i++) {
    // seven draws a copy, whatever the options: changing one option never reshuffles the rest
    const u1 = rnd(), u2 = rnd(), u3 = rnd(), uy = rnd(), ut = rnd(), ua = rnd(), us = rnd();
    let x = 0, y = 0, z = 0;
    if (shape === 'disc') { const r = Math.sqrt(inner * inner + u1 * (radius * radius - inner * inner)), a = 2 * Math.PI * u2; x = r * Math.cos(a); z = r * Math.sin(a); }
    else if (shape === 'ring') { const a = 2 * Math.PI * (i + jitter * (u1 - 0.5)) / count; x = radius * Math.sin(a); z = radius * Math.cos(a); }
    else if (shape === 'box') { x = (u1 - 0.5) * size[0]; y = u2 * size[1]; z = (u3 - 0.5) * size[2]; }
    else if (shape === 'grid') { const cx = size[0] / nx, cz = size[2] / nz, ix = i % nx, iz = Math.floor(i / nx);
      x = -size[0] / 2 + (ix + 0.5 + jitter * (u1 - 0.5)) * cx; z = -size[2] / 2 + (iz + 0.5 + jitter * (u3 - 0.5)) * cz; }
    else if (shape === 'line') { const t = count === 1 ? 0.5 : (i + jitter * (u1 - 0.5)) / (count - 1); x = to[0] * t; y = to[1] * t; z = to[2] * t; }
    else { const cy = 2 * u1 - 1, a = 2 * Math.PI * u2, r = radius * Math.sqrt(1 - cy * cy); x = r * Math.cos(a); y = radius * cy; z = r * Math.sin(a); }   // sphere: on its surface
    const yaw = facing === 'random' ? 2 * Math.PI * uy : facing === 'out' ? Math.atan2(x, z) : facing === 'in' ? Math.atan2(-x, -z) : facing;
    let q = yawQuat(yaw);
    if (tilt > 0) { const lean = tilt * ut, a = 2 * Math.PI * ua, h = Math.sin(lean / 2); q = qmul([h * Math.cos(a), 0, h * Math.sin(a), Math.cos(lean / 2)], q); }
    out.push(x, y, z, q[0], q[1], q[2], q[3], smin + us * (smax - smin));
  }
}

/** A thing's copies from its `antra/instances` value. Null when the value says nothing drawable (malformed is absent,
 *  never a throw). {count, copies: Float32Array (8 a copy: x y z, qx qy qz qw, scale), ground, original}. */
export function readInstances(value, id = '') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const out = [];
  if (Array.isArray(value.at)) for (const r of value.at) { if (out.length / 8 >= INSTANCE_MAX) break; const c = row(r); if (c) out.push(...c); }
  scatter(value.scatter, id, INSTANCE_MAX - out.length / 8, out);
  if (!out.length) return null;
  return { count: out.length / 8, copies: Float32Array.from(out), ground: value.ground === true, original: value.original !== false };
}

/** One line for someone who reads rather than sees ("drawn 400 times, scattered in a disc of 12 m"); null when it draws nothing. */
export function describeInstances(value, id = '') {
  const r = readInstances(value, id); if (!r) return null;
  const s = value.scatter && typeof value.scatter === 'object' ? value.scatter : null;
  const shape = s && SCATTER_SHAPES.includes(s.shape) ? s.shape : 'disc';
  const where = !s || !(num(s.count, 0) >= 1) ? 'placed by hand' : shape === 'disc' || shape === 'ring' || shape === 'sphere'
    ? `${shape === 'disc' ? 'scattered in a disc' : shape === 'ring' ? 'spaced round a ring' : 'scattered over a sphere'} of radius ${num(s.radius, SCATTER_DEFAULTS.radius, 0)} m`
    : shape === 'line' ? 'spaced along a line' : shape === 'grid' ? 'laid out in a grid' : 'scattered in a box';
  return `drawn ${r.original ? r.count + 1 : r.count} times, ${where}${r.ground ? ', standing on the ground' : ''}`;
}
