// shared/drive.js — a hull driven from its helm (componentspec drive; DESIGN.md env-components "Drive"): the spec read with
// its defaults, the helm found, the kinematic step (port of upstream main's client/lib/vehicles.js updateVehicle), and the
// plausibility the authority holds a streamed pose to. Pure; the browser, the agent and the authority ask the same questions.
import { qFromYaw, qHeading, qMul, qConj, qNorm, qRotate } from "./rot.js";

const fin = (x, d) => (typeof x === "number" && Number.isFinite(x) ? x : d);
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const v3 = (a) => Array.isArray(a) && a.length === 3 && a.every(Number.isFinite);
const bag = (v) => !!v && typeof v === "object" && !Array.isArray(v);

/** The slack the authority gives a streamed step: a fraction over the spec's rates, plus a fixed allowance (m, rad) that is a
 *  budget refilling over refillS (per message it compounded: 60 msg/s turned 4 m/s into ~19; review L26). */
export const SLACK = Object.freeze({ rate: 0.25, metres: 0.25, radians: 0.05, maxDt: 1, refillS: 1 / 15 });
/** A lease with no accepted step for this long has lost its driver (ms); a held lease commits at least this often (ms). */
export const LEASE = Object.freeze({ heartbeatMs: 3000, commitMs: 5000 });

/** A thing's `drive`, with its defaults: {maxSpeed, turnRate, climbRate, response, throttle}, or null. */
export function driveOf(c) {
  const d = c?.drive; if (!bag(d)) return null;
  return { maxSpeed: clamp(fin(d.maxSpeed, 4), 0.1, 50), turnRate: clamp(fin(d.turnRate, 0.45), 0.1, 4), climbRate: clamp(fin(d.climbRate, 0), 0, 50),
    response: clamp(fin(d.response, 1 / 1.5), 0.05, 10), throttle: d.throttle === true };
}

/** Is this component bag a helm (a socket's station that drives its host)? */
export const isHelmC = (c) => bag(c?.socket) && bag(c?.station) && c.station.action === "drive" && c.station.input?.move === "drive";

/** The helm of `host`: the id of its socket child whose station drives it, or null (one per host: the door's rule). */
export function helmOf(st, host) {
  for (const id of Object.keys(st?.entities ?? {}).sort()) { const c = st.entities[id].c; if (c.parent?.to === host && isHelmC(c) && c.disabled !== true) return id; }
  return null;
}

/** One kinematic step (upstream's arcade hull): `input` {throttle, steer, rise} each −1..1 (forward is the hull's +Z, steer
 *  positive turns left); velocity eases toward the target with time constant `response`. → {pos, q, vel}. Yaw only. */
export function stepDrive(pose, vel, input, spec, dt) {
  dt = clamp(fin(dt, 0), 0, 0.1);
  const ax = (k) => clamp(fin(input?.[k], 0), -1, 1);
  const yaw = qHeading(pose.q ?? [0, 0, 0, 1]) + ax("steer") * spec.turnRate * dt;
  const q = qFromYaw(yaw), fwd = qRotate(q, [0, 0, ax("throttle") * spec.maxSpeed]);
  const target = [fwd[0], ax("rise") * spec.climbRate, fwd[2]];
  const k = 1 - Math.exp(-dt / spec.response);
  const v = (vel ?? [0, 0, 0]).map((x, i) => x + (target[i] - x) * k);
  return { pos: pose.pos.map((x, i) => x + v[i] * dt), q, vel: v };
}

/** The angle (rad) between two orientations. */
export function turnBetween(a, b) { const d = qMul(qConj(qNorm(a)), qNorm(b)); return 2 * Math.acos(Math.min(1, Math.abs(d[3]))); }

/** The fixed slack a step may spend, `left` (absent: full) refilled over `dtS` seconds: {flat, up, turn}. */
export function slackNow(left, dtS) {
  const k = clamp(fin(dtS, 0), 0, SLACK.maxDt) / SLACK.refillS, full = { flat: SLACK.metres, up: SLACK.metres, turn: SLACK.radians };
  return left ? { flat: Math.min(full.flat, left.flat + full.flat * k), up: Math.min(full.up, left.up + full.up * k), turn: Math.min(full.turn, left.turn + full.turn * k) } : full;
}
/** How far a step went (m flat, m up or down, rad) and what the spec's rates allow in dt (with SLACK.rate), dt capped at SLACK.maxDt. */
function stepOf(prev, next, dtS, spec) {
  const dt = clamp(fin(dtS, 0), 0, SLACK.maxDt), r = 1 + SLACK.rate;
  return { dt, flat: Math.hypot(next.pos[0] - prev.pos[0], next.pos[2] - prev.pos[2]), up: Math.abs(next.pos[1] - prev.pos[1]), turn: turnBetween(prev.q, next.q),
    fl: spec.maxSpeed * dt * r, ul: spec.climbRate * dt * r, tl: spec.turnRate * dt * r };
}
/** The slack left after a taken step spent what it went over the rates. */
export function slackAfter(slack, prev, next, dtS, spec) {
  const s = stepOf(prev, next, dtS, spec);
  return { flat: Math.max(0, slack.flat - Math.max(0, s.flat - s.fl)), up: Math.max(0, slack.up - Math.max(0, s.up - s.ul)), turn: Math.max(0, slack.turn - Math.max(0, s.turn - s.tl)) };
}

/** Could the hull have gone from `prev` to `next` in `dtS` seconds under `spec`, with `slack` (slackNow) to spend? null, or
 *  {what, said}. dt is capped at SLACK.maxDt: a pause in the stream banks no distance. */
export function implausible(prev, next, dtS, spec, slack = slackNow(null, 0)) {
  if (!v3(next?.pos) || !Array.isArray(next.q) || next.q.length !== 4 || !next.q.every(Number.isFinite)) return { what: "shape", said: "a pose is {pos: [x, y, z], q: [x, y, z, w]}" };
  const s = stepOf(prev, next, dtS, spec), { dt, flat, up, turn } = s;
  const fl = s.fl + slack.flat, ul = s.ul + slack.up, tl = s.tl + slack.turn;
  if (flat > fl) return { what: "speed", said: `${flat.toFixed(2)} m in ${dt.toFixed(2)} s; its maxSpeed (${spec.maxSpeed} m/s) allows ${fl.toFixed(2)} m` };
  if (up > ul) return { what: "climb", said: `${up.toFixed(2)} m up or down in ${dt.toFixed(2)} s; its climbRate (${spec.climbRate} m/s) allows ${ul.toFixed(2)} m` };
  if (turn > tl) return { what: "turn", said: `a turn of ${turn.toFixed(3)} rad in ${dt.toFixed(2)} s; its turnRate (${spec.turnRate} rad/s) allows ${tl.toFixed(3)} rad` };
  return null;
}
