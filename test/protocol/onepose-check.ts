// One worldPose, one set of quaternion functions (audit 10-22, finding 7). The authority's composer (simlayer, whose
// output checks.js compares as JSON text) and the scene tree's (hierarchy) must give the same bits for the same chain,
// and the quaternion helpers listed below (SAME) must be shared/rot.js's (shared/protocol/authority/math.js keeps its own
// qmul/qrot, not checked here): a few thousand seeded chains and quaternions, compared bit for bit (Object.is: -0 ≠ +0). Deterministic: one fixed seed.
//   bun test/protocol/onepose-check.ts
import * as rot from "../../shared/rot.js";
import { worldPose as simPose } from "../../shared/protocol/simlayer.js";
import { worldPose as treePose } from "../../shared/hierarchy.js";
import * as particlesim from "../../shared/particlesim.js";
import * as motioneval from "../../shared/motioneval.js";
import * as reach from "../../shared/reach.js";
import { suite } from "../gate/suite.ts";

const { check, done } = suite("onepose-check", { cap: 600 });

let seed = 0x0e1d0f5e;
const rnd = () => { seed = (seed + 0x6d2b79f5) | 0; let t = seed; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const range = (a: number, b: number) => a + (b - a) * rnd();
const pick = <T,>(xs: T[]) => xs[Math.floor(rnd() * xs.length)];

const unit = (q: number[]) => rot.qNorm(q) as number[];
function quat(): number[] {
  switch (pick(["any", "any", "near-identity", "half-turn", "yaw", "identity"])) {
    case "near-identity": return unit([range(-1e-7, 1e-7), range(-1e-7, 1e-7), range(-1e-7, 1e-7), 1]);
    case "half-turn": return unit([range(-1, 1), range(-1, 1), range(-1, 1), pick([0, 1e-12, -1e-12])]);
    case "yaw": return unit(rot.qFromYaw(range(-7, 7)));
    case "identity": return [0, 0, 0, 1];
    default: return unit([range(-1, 1), range(-1, 1), range(-1, 1), range(-1, 1)]);
  }
}
function scale(): number[] {
  switch (pick(["one", "uniform", "uneven", "mirrored"])) {
    case "one": return [1, 1, 1];
    case "uniform": { const s = pick([2, 0.5, range(0.01, 50)]); return [s, s, s]; }
    case "mirrored": return [range(0.1, 5), -range(0.1, 5), range(0.1, 5)];
    default: return [range(0.1, 5), range(0.1, 5), range(0.1, 5)];
  }
}
const vec = (r = 50) => [range(-r, r), range(-r, r), range(-r, r)];
// Object.is, not ===: bit for bit means -0 and +0 differ (and NaN equals NaN)
const same = (a: unknown, b: unknown): boolean => (Array.isArray(a) && Array.isArray(b) ? a.length === b.length && a.every((x, i) => same(x, b[i])) : Object.is(a, b));
const gap = (a: number[], b: number[]) => Math.max(...a.map((x, i) => Math.abs(x - b[i])));
const N = 3000;

// ---- the two composers, on the same chain ----
type Local = { pos: number[]; q: number[]; scale: number[] };
function worlds(chain: Local[]) {
  const st: any = { entities: {} }, tree: any = {};
  chain.forEach((L, i) => {
    const id = `e${i}`, to = i ? `e${i - 1}` : undefined;
    st.entities[id] = { c: { transform: { pos: L.pos, q: L.q, scale: L.scale }, ...(to ? { parent: { to } } : {}) } };
    tree[id] = to ? { parent: { to, offset: L.pos, q: L.q }, scale: L.scale } : { pos: L.pos, q: L.q, scale: L.scale };
  });
  return { st, tree, leaf: `e${chain.length - 1}` };
}
const off: Record<string, { n: number; worst: number; example?: unknown }> = {};
const note = (k: string, d: number, example: unknown) => { const o = (off[k] ??= { n: 0, worst: 0 }); o.n++; if (d >= o.worst) { o.worst = d; o.example = example; } };
for (let t = 0; t < N; t++) {
  // the first chain is the signed-zero case: identities at the origin compose to zeros, whose sign must agree too
  const zero = (): Local => ({ pos: [0, 0, 0], q: [0, 0, 0, 1], scale: [1, 1, 1] });
  const chain: Local[] = t === 0 ? [zero(), zero()] : Array.from({ length: 1 + Math.floor(rnd() * 4) }, () => ({ pos: vec(), q: quat(), scale: scale() }));
  const { st, tree, leaf } = worlds(chain);
  const a = simPose(st, leaf), b = treePose(tree, leaf);
  const bs = Array.isArray(b.scale) ? b.scale : [b.scale, b.scale, b.scale];
  for (const [k, x, y] of [["pos", a.pos, b.pos], ["q", a.q, b.q], ["scale", a.scale, bs]] as const)
    if (!same(x, y)) note(`composer ${k}`, gap(x as number[], y as number[]), { chain, simlayer: a, hierarchy: b });
}
for (const k of ["pos", "q", "scale"]) {
  const o = off[`composer ${k}`];
  check(`OP1 ${k}: simlayer.worldPose and hierarchy.worldPose agree bit for bit on ${N} chains of depth 1-4 (uniform, uneven and mirrored scales; near-identity and half-turn q)`, !o, o && { differ: o.n, worstAbs: o.worst, example: o.example });
}
check(`OP2 both composers are rot.js's one composer`, typeof (rot as any).composePose === "function" && (() => {
  for (let t = 0; t < 200; t++) {
    const chain: Local[] = Array.from({ length: 1 + (t % 4) }, () => ({ pos: vec(), q: quat(), scale: scale() }));
    const { st, leaf } = worlds(chain); const a = simPose(st, leaf), b = (rot as any).composePose(chain);
    if (!["pos", "q", "scale"].every((k) => same(a[k], b[k]))) return false;
  }
  return true;
})());

// ---- the quaternion helpers are rot.js's: a re-export is the same function (a pasted copy is not) ----
const SAME: [string, unknown, unknown][] = [
  ["particlesim.qRotate", particlesim.qRotate, rot.qRotate], ["motioneval.qMul", motioneval.qMul, rot.qMul],
  ["motioneval.qApply", motioneval.qApply, rot.qRotate], ["reach.qMulq", reach.qMulq, rot.qMul], ["reach.qRot", reach.qRot, rot.qRotate],
  ["reach.qConj", reach.qConj, (rot as any).qConj], ["reach.qAxisAngle", reach.qAxisAngle, (rot as any).qAxisAngle],
];
for (const [name, f, g] of SAME) check(`OQ ${name} is rot.js's own function`, typeof g === "function" && f === g, typeof f);
// rot.qRotate's out-array contract (its callers pass one, aliased to v too): the rows above pin identity, not this
{ const q = [0, Math.SQRT1_2, 0, Math.SQRT1_2], out = [9, 9, 9], v = [1, 2, 3], want = rot.qRotate(q, [1, 2, 3]);
  const got = rot.qRotate(q, [1, 2, 3], out), alias = rot.qRotate(q, v, v);
  check("OQ rot.qRotate writes into out (and returns it), even when out is v", got === out && alias === v && [out, v].every((a) => a.every((x, i) => Math.abs(x - want[i]) < 1e-12)), { out, v, want }); }
// motioneval.qAxisAngle wraps rot.js's (it normalizes the axis first): the same bits on unit axes
{ let differ = 0, worst = 0, example: unknown;
  for (let t = 0; t < N; t++) {
    const ang = range(-7, 7), ax = rot.qRotate(quat(), [0, 0, 1]); const n = Math.hypot(ax[0], ax[1], ax[2]) || 1;
    const a = motioneval.qAxisAngle(ax, ang), b = (rot as any).qAxisAngle([ax[0] / n, ax[1] / n, ax[2] / n], ang);
    if (!same(a, b)) { differ++; const d = gap(a, b); if (d >= worst) { worst = d; example = { ang, axis: ax, copy: a, rot: b }; } }
  }
  check(`OQ motioneval.qAxisAngle is rot.js's, bit for bit on ${N} inputs`, !differ, { differ, worstAbs: worst, example }); }

done();
