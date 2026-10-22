// One worldPose, one set of quaternion functions (audit 10-22, finding 7). The authority's composer (simlayer, whose
// output checks.js compares as JSON text) and the scene tree's (hierarchy) must give the same bits for the same chain,
// and every quaternion helper elsewhere must be shared/rot.js's: a few thousand seeded chains and quaternions, compared
// bit for bit. Deterministic: one fixed seed.
//   bun tools/protocol/onepose-check.ts
import * as rot from "../../shared/rot.js";
import { worldPose as simPose } from "../../shared/protocol/simlayer.js";
import { worldPose as treePose } from "../../shared/hierarchy.js";
import * as particlesim from "../../shared/particlesim.js";
import * as motioneval from "../../client/lib/motioneval.js";
import * as reach from "../../shared/reach.js";

let pass = 0, fail = 0;
const check = (n: string, ok: boolean, info?: unknown) => { if (ok) { pass++; console.log(`ok   ${n}`); } else { fail++; console.log(`FAIL ${n}`); if (info !== undefined) console.log("     ", JSON.stringify(info).slice(0, 600)); } };

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
const same = (a: unknown, b: unknown): boolean => (Array.isArray(a) && Array.isArray(b) ? a.length === b.length && a.every((x, i) => same(x, b[i])) : a === b || (Number.isNaN(a) && Number.isNaN(b)));
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
  const depth = 1 + Math.floor(rnd() * 4);
  const chain: Local[] = Array.from({ length: depth }, () => ({ pos: vec(), q: quat(), scale: scale() }));
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

// ---- the quaternion helpers, each against rot.js ----
const helpers: [string, (q: number[], b: number[], ang: number, axis: number[]) => [unknown, unknown] | null][] = [
  ["particlesim.qRotate", (q, b) => [particlesim.qRotate(q, b), rot.qRotate(q, b)]],
  ["particlesim.qRotate into out", (q, b) => { const out = [9, 9, 9]; particlesim.qRotate(q, b, out); return [out, rot.qRotate(q, b)]; }],
  ["motioneval.qMul", (q, b) => [motioneval.qMul(q, b), rot.qMul(q, b)]],
  ["motioneval.qApply", (q, b) => [motioneval.qApply(q, b), rot.qRotate(q, b)]],
  ["motioneval.qAxisAngle", (_q, _b, ang, axis) => { const n = Math.hypot(axis[0], axis[1], axis[2]) || 1;
    return (rot as any).qAxisAngle ? [motioneval.qAxisAngle(axis, ang), (rot as any).qAxisAngle([axis[0] / n, axis[1] / n, axis[2] / n], ang)] : null; }],
  ["reach.qMulq", (q, b) => [reach.qMulq(q, b), rot.qMul(q, b)]],
  ["reach.qRot", (q, b) => [reach.qRot(q, b), rot.qRotate(q, b)]],
  ["reach.qConj", (q) => ((rot as any).qConj ? [reach.qConj(q), (rot as any).qConj(q)] : null)],
  ["reach.qAxisAngle", (_q, _b, ang, axis) => ((rot as any).qAxisAngle ? [reach.qAxisAngle(axis, ang), (rot as any).qAxisAngle(axis, ang)] : null)],
];
for (const [name, f] of helpers) {
  let differ = 0, worst = 0, example: unknown, missing = false;
  for (let t = 0; t < N; t++) {
    const q = quat(), v = name.includes("Mul") ? quat() : vec(), ang = range(-7, 7), ax = rot.qRotate(quat(), [0, 0, 1]);
    const r = f(q, v, ang, ax);
    if (!r) { missing = true; break; }
    if (!same(r[0], r[1])) { differ++; const d = gap(r[0] as number[], r[1] as number[]); if (d >= worst) { worst = d; example = { q, v, ang, axis: ax, copy: r[0], rot: r[1] }; } }
  }
  check(`OQ ${name} is rot.js's, bit for bit on ${N} inputs`, !missing && !differ, missing ? "rot.js has no such function" : { differ, worstAbs: worst, within1e12: worst <= 1e-12, example });
}

console.log(`[onepose-check] ${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
