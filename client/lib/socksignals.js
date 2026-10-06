// socksignals — the signals a socket's pose blends by, computed the same way on every client.
//
// The closed set (shared/sockbody.js SIGNALS):
//   speed  m/s   how fast the thing (its whole-motion transform) is moving
//   turn   rad/s how fast it is turning about its up axis (+ = counter-clockwise seen from above)
//   phase  0..1  where the motion that carries the socket is in its cycle (a swing's period, a wheel's turn, a path's run)
//   swing  -1..1 a pendulum's normalised angle (θ/amp, damping included); cos of the cycle for spins, orbits and bobs
//   throttle, steer          -1..1  the occupant's movement input (input.move drive|walk), riding their presence
//   aimYaw, aimPitch         rad    where the occupant looks, relative to the socket's forward (riding presence)
//   param.<name>             the thing's `params` component (scripts write it)
//
// Every value here is a closed form of data every client already has — the motion component, the server clock, the
// occupant's presence — so two clients looking at one swing put the rider's clip at the same frame. (A thing moved by
// physics, not by a motion component, reads speed/turn 0 here: physics is a later port.)
//
// Pure: imports only the motion closed forms (motioneval.js, itself pure and shared with the agent). It lives beside
// them in client/lib because the browser is served client/ at its root: shared/ code can't reach back into it.

import { evalWholeMotion, since, ampOf } from './motioneval.js';

const TAU = 2 * Math.PI;
const frac = (x) => x - Math.floor(x);
const fin = Number.isFinite;

/** The motion that carries a socket: its part's (`motion:<part>`, or a `motion` naming that part) when it rides one,
 *  else the thing's whole motion. Null when nothing moves it. */
export function carrierMotion(comp, sock) {
  if (!comp) return null;
  const part = typeof sock?.part === 'string' ? sock.part : null;
  if (part) {
    const m = comp[`motion:${part}`] ?? (comp.motion?.part === part ? comp.motion : null);
    if (m?.type) return { m, part: true };
  }
  const w = comp.motion;
  return w?.type && typeof w.part !== 'string' ? { m: w, part: false } : null;
}

/** phase (0..1) and swing (-1..1) of one motion at nowMs. */
export function cycleOf(m, nowMs) {
  if (!m?.type) return { phase: 0, swing: 0 };
  const t = since(m, nowMs);
  switch (m.type) {
    case 'pendulum': {
      const a = (TAU / (m.period ?? 3.5)) * t + (m.phase ?? 0);
      const amp = ampOf(m);
      return { phase: frac(a / TAU), swing: amp ? Math.exp(-(m.damp ?? 0) * t) * Math.cos(a) : 0 };
    }
    case 'spin': {
      const rate = m.degPerSec != null ? m.degPerSec : (m.rpm ?? 6) * 6;
      const a = (m.phase ?? 0) + (rate * Math.PI / 180) * t;
      return { phase: frac(a / TAU), swing: Math.cos(a) };
    }
    case 'orbit': {
      const a = (m.phase ?? 0) + ((m.degPerSec ?? 12) * Math.PI / 180) * t;
      return { phase: frac(a / TAU), swing: Math.cos(a) };
    }
    case 'bob': {
      const a = (TAU / (m.period ?? 4)) * t + (m.phase ?? 0);
      return { phase: frac(a / TAU), swing: Math.sin(a) };
    }
    case 'path': {
      const pts = m.points; if (!Array.isArray(pts) || pts.length < 2) return { phase: 0, swing: 0 };
      let total = 0; for (let i = 1; i < pts.length; i++) total += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1], pts[i][2] - pts[i - 1][2]);
      total ||= 1;
      const speed = m.speed ?? (m.duration ? total / m.duration : 1);
      const loop = m.loop ?? 'loop';
      const s = speed * t;
      const p = loop === 'once' ? Math.min(1, s / total) : loop === 'pingpong' ? frac(s / (2 * total)) : frac(s / total);
      return { phase: p, swing: Math.cos(TAU * p) };
    }
    default: return { phase: 0, swing: 0 };
  }
}

const DT = 50;   // ms: the finite difference speed and turn are read over (every client uses the same)
/** speed (m/s) and turn (rad/s) of a thing's whole motion at nowMs, from the closed form at nowMs and nowMs - DT. */
export function travelOf(base, m, nowMs) {
  if (!m?.type || typeof m.part === 'string' || !base?.pos) return { speed: 0, turn: 0 };
  const a = evalWholeMotion(base, m, nowMs - DT), b = evalWholeMotion(base, m, nowMs);
  if (!a.ok || !b.ok) return { speed: 0, turn: 0 };
  const d = Math.hypot(b.pos[0] - a.pos[0], b.pos[1] - a.pos[1], b.pos[2] - a.pos[2]);
  let dy = b.yaw - a.yaw; dy = Math.atan2(Math.sin(dy), Math.cos(dy));
  return { speed: d / (DT / 1000), turn: dy / (DT / 1000) };
}

/** Every signal for one occupant of one socket. comp: the thing's component bag; base: its rest pose {pos, yaw|q}
 *  (what motion composes on); input: the occupant's {throttle, steer, aimYaw, aimPitch} (absent = 0). */
export function socketSignals({ comp, sock, base, nowMs, input }) {
  const out = { speed: 0, turn: 0, phase: 0, swing: 0, throttle: 0, steer: 0, aimYaw: 0, aimPitch: 0 };
  const c = carrierMotion(comp, sock);
  if (c) Object.assign(out, cycleOf(c.m, nowMs));
  if (comp?.motion?.type && typeof comp.motion.part !== 'string') Object.assign(out, travelOf(base, comp.motion, nowMs));
  for (const k of ['throttle', 'steer']) if (fin(input?.[k])) out[k] = Math.max(-1, Math.min(1, input[k]));
  for (const k of ['aimYaw', 'aimPitch']) if (fin(input?.[k])) out[k] = Math.max(-Math.PI, Math.min(Math.PI, input[k]));
  const params = comp?.params;
  if (params && typeof params === 'object') for (const [k, v] of Object.entries(params)) if (fin(v)) out[`param.${k}`] = v;
  return out;
}
