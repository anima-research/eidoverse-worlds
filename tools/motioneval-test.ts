/**
 * motioneval parity fixture — #92 review B3: the motion.js refactor moved
 * every whole-entity closed form into motioneval.js, so this file pins the
 * evaluator against an INDEPENDENT reference implementation (Rodrigues
 * rotation matrices — a different formulation than the module's
 * quaternions, carried only in this test) plus scalar hand-math, across
 * every extracted root type and rotation policy. #82 must not repair text
 * perception by silently changing existing browser motion.
 *
 * Run: bun run tools/motioneval-test.ts   (no servers, all time injected)
 */

import { evalWholeMotion, qApply } from "../client/lib/motioneval.js";

let failures = 0;
const check = (label: string, ok: boolean, detail?: string) => {
  console.log(ok ? `  \x1b[32m✓\x1b[0m ${label}` : `  \x1b[31m✗ ${label}${detail ? ` — ${detail}` : ""}\x1b[0m`);
  if (!ok) failures++;
};
const near = (a: number, b: number, eps = 1e-9) => Math.abs(a - b) < eps;
const near3 = (a: number[], b: number[], eps = 1e-9) => a.length === 3 && a.every((v, i) => near(v, b[i], eps));

const T0 = 1_700_000_000_000;

// ---- the independent reference: axis-angle as a 3×3 matrix (Rodrigues) -----
type M3 = number[][];
const norm3 = (v: number[]) => { const n = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / n, v[1] / n, v[2] / n]; };
const rodrigues = (axis: number[], th: number): M3 => {
  const [x, y, z] = norm3(axis); const c = Math.cos(th), s = Math.sin(th), C = 1 - c;
  return [
    [c + x * x * C, x * y * C - z * s, x * z * C + y * s],
    [y * x * C + z * s, c + y * y * C, y * z * C - x * s],
    [z * x * C - y * s, z * y * C + x * s, c + z * z * C],
  ];
};
const mApply = (M: M3, v: number[]) => [
  M[0][0] * v[0] + M[0][1] * v[1] + M[0][2] * v[2],
  M[1][0] * v[0] + M[1][1] * v[1] + M[1][2] * v[2],
  M[2][0] * v[0] + M[2][1] * v[1] + M[2][2] * v[2],
];
const mMul = (A: M3, B: M3): M3 => A.map((row, i) => [0, 1, 2].map((j) => row[0] * B[0][j] + row[1] * B[1][j] + row[2] * B[2][j]));
const sub3 = (a: number[], b: number[]) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add3 = (a: number[], b: number[]) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];

/** Reference rotate-at-pivot: pos = base + Ry·(pivot − R·pivot); Rtot = Ry·R. */
const refPivot = (base: { pos: number[]; yaw?: number }, axis: number[], pivot: number[], th: number) => {
  const R = rodrigues(axis, th), Ry = rodrigues([0, 1, 0], base.yaw ?? 0);
  return { pos: add3(base.pos, mApply(Ry, sub3(pivot, mApply(R, pivot)))), Rtot: mMul(Ry, R) };
};
/** A quaternion and a matrix agree iff they act identically on a basis. */
const quatMatchesM = (q: number[], M: M3, eps = 1e-9) =>
  [[1, 0, 0], [0, 1, 0], [0, 0, 1]].every((e) => near3(qApply(q, e), mApply(M, e), eps));

// ---- foundation: the module's quaternion action vs Rodrigues ----------------
console.log("\n━━ foundation: quaternion action ≡ rotation matrix ━━");
{
  const cases = [
    { axis: [1, 0, 0], th: 0.5, v: [0, 2.4, 0] },
    { axis: [0, 1, 0], th: -1.2, v: [1, 0, 3] },
    { axis: [1, 1, 0], th: 2.7, v: [0.3, -0.4, 0.5] },
    { axis: [0.2, -0.5, 0.9], th: 3.9, v: [-2, 1, 0.7] },
  ];
  const { qAxisAngle } = await import("../client/lib/motioneval.js");
  check("qApply agrees with Rodrigues on a mixed grid", cases.every(({ axis, th, v }) =>
    near3(qApply(qAxisAngle(axis, th), v), mApply(rodrigues(axis, th), v))));
}

// ---- pendulum: nontrivial yaw, off-axis, off-origin pivot, damping ---------
console.log("\n━━ pendulum ━━");
{
  const base = { pos: [3, 1, -2], yaw: 0.7 };
  const m = { type: "pendulum", axis: [0, 0, 1], pivot: [0.3, 2, 0.1], amp: 0.6, period: 2.7, phase: 0.4, damp: 0.15, t0: T0 };
  const t = 1.234;
  const th = 0.6 * Math.exp(-0.15 * t) * Math.cos((2 * Math.PI / 2.7) * t + 0.4);
  const ref = refPivot(base, [0, 0, 1], [0.3, 2, 0.1], th);
  const r = evalWholeMotion(base, m, T0 + 1234);
  check("position matches the matrix reference", r.ok && near3(r.pos, ref.pos), JSON.stringify(r));
  check("rotation matches the matrix reference", r.ok && r.rot === true && quatMatchesM(r.quat, ref.Rtot));
  const r2 = evalWholeMotion(base, { ...m, damp: undefined }, T0 + 1234);
  const th2 = 0.6 * Math.cos((2 * Math.PI / 2.7) * t + 0.4);
  check("missing damp = 0 (swings forever)", r2.ok && near3(r2.pos, refPivot(base, [0, 0, 1], [0.3, 2, 0.1], th2).pos));
  const r3 = evalWholeMotion(base, { type: "pendulum", amplitude: 0.6, axis: "z", pivot: [0.3, 2, 0.1], period: 2.7, phase: 0.4, damp: 0.15, t0: T0 }, T0 + 1234);
  check("the generous reader: `amplitude` + axis \"z\"", r3.ok && near3(r3.pos, ref.pos));
}

// ---- spin: string axis, rpm fallback, default pivot ------------------------
console.log("\n━━ spin ━━");
{
  const base = { pos: [-1, 0, 4], yaw: -0.3 };
  const t = 2.5;
  const th = 0.2 + (33 * Math.PI / 180) * t;
  const ref = refPivot(base, [1, 1, 0], [0.5, 0, 0.5], th);
  const r = evalWholeMotion(base, { type: "spin", axis: [1, 1, 0], pivot: [0.5, 0, 0.5], degPerSec: 33, phase: 0.2, t0: T0 }, T0 + 2500);
  check("position matches the matrix reference", r.ok && near3(r.pos, ref.pos), JSON.stringify(r));
  check("rotation matches the matrix reference", r.ok && r.rot === true && quatMatchesM(r.quat, ref.Rtot));
  const rpm = evalWholeMotion(base, { type: "spin", rpm: 10, t0: T0 }, T0 + 2500);
  const refRpm = refPivot(base, [0, 1, 0], [0, 0, 0], (10 * 6 * Math.PI / 180) * t);   // rpm → deg/s ×6; default axis y, pivot origin
  check("rpm fallback (×6) with default axis/pivot", rpm.ok && near3(rpm.pos, refRpm.pos) && quatMatchesM(rpm.quat, refRpm.Rtot));
}

// ---- orbit: face on/off, defaults ------------------------------------------
console.log("\n━━ orbit ━━");
{
  const base = { pos: [7, 0.5, 7], yaw: 1.1 };
  const t = 1.7;
  const a = 0.3 + (45 * Math.PI / 180) * t;
  const on = evalWholeMotion(base, { type: "orbit", center: [1, 2, 3], radius: 2.5, degPerSec: 45, phase: 0.3, t0: T0 }, T0 + 1700);
  check("face on: position on the circle", on.ok && near3(on.pos, [1 + 2.5 * Math.sin(a), 2, 3 + 2.5 * Math.cos(a)]), JSON.stringify(on));
  check("face on: yaw leads the tangent, rot true", on.ok && on.rot === true && near(on.yaw, a + Math.PI / 2));
  const off = evalWholeMotion(base, { type: "orbit", center: [1, 2, 3], radius: 2.5, degPerSec: 45, phase: 0.3, face: false, t0: T0 }, T0 + 1700);
  check("face off: same position, rot false, authored yaw", off.ok && near3(off.pos, on.pos) && off.rot === false && near(off.yaw, 1.1));
  const dflt = evalWholeMotion(base, { type: "orbit", t0: T0 }, T0 + 1700);
  const ad = (12 * Math.PI / 180) * t;   // defaults: center=base.pos, radius 3, 12°/s
  check("defaults: center=base, radius 3, 12°/s", dflt.ok && near3(dflt.pos, [7 + 3 * Math.sin(ad), 0.5, 7 + 3 * Math.cos(ad)]));
}

// ---- bob: off-axis, default amp, rot policy --------------------------------
console.log("\n━━ bob ━━");
{
  const base = { pos: [2, 3, 4], yaw: 0.9 };
  const t = 0.8;
  const offv = Math.sin((2 * Math.PI / 1.9) * t + 0.6) * 0.45;
  const r = evalWholeMotion(base, { type: "bob", axis: "-x", amp: 0.45, period: 1.9, phase: 0.6, t0: T0 }, T0 + 800);
  check("off-axis bob displaces along −x only", r.ok && near3(r.pos, [2 - offv, 3, 4]), JSON.stringify(r));
  check("bob never touches rotation", r.ok && r.rot === false && near(r.yaw, 0.9));
  const d = evalWholeMotion(base, { type: "bob", period: 1.9, phase: 0.6, t0: T0 }, T0 + 800);
  check("default amp 0.3 on default axis y", d.ok && near3(d.pos, [2, 3 + Math.sin((2 * Math.PI / 1.9) * t + 0.6) * 0.3, 4]));
}

// ---- path: corner traversal, all loop modes, face policy -------------------
console.log("\n━━ path ━━");
{
  const base = { pos: [0, 0, 0], yaw: 0.4 };
  const pts = [[0, 0, 0], [4, 0, 0], [4, 0, 4]];                  // total length 8
  const at = (t: number, extra = {}) => evalWholeMotion(base, { type: "path", points: pts, speed: 2, t0: T0, ...extra }, T0 + t * 1000);
  const r1 = at(1);                                               // s=2, mid segment 1 (+x)
  check("mid-segment interpolation", r1.ok && near3(r1.pos, [2, 0, 0]), JSON.stringify(r1));
  check("face: yaw follows the segment (+x = π/2), rot true", r1.ok && r1.rot === true && near(r1.yaw, Math.PI / 2));
  const r2 = at(3);                                               // s=6, segment 2 (+z), f=0.5
  check("corner crossed: second segment, yaw 0", r2.ok && near3(r2.pos, [4, 0, 2]) && near(r2.yaw, 0));
  const loop = at(5);                                             // s=10 → %8 = 2
  check("loop wraps", loop.ok && near3(loop.pos, [2, 0, 0]));
  const ping = at(5, { loop: "pingpong" });                       // s=10 → 16−10=6
  check("pingpong reflects", ping.ok && near3(ping.pos, [4, 0, 2]));
  const once = at(5, { loop: "once" });                           // s clamps at 8
  check("once arrives and stays", once.ok && near3(once.pos, [4, 0, 4]));
  const nf = at(1, { face: false });
  check("face off: rot false, authored yaw kept", nf.ok && near3(nf.pos, [2, 0, 0]) && nf.rot === false && near(nf.yaw, 0.4));
}

// ---- missing t0: the fallback anchor's lifetime ----------------------------
console.log("\n━━ missing t0 ━━");
{
  const base = { pos: [1, 1, 1], yaw: 0 };
  const m: any = { type: "bob", amp: 0.5, period: 2 };            // phase 0, no t0
  const first = evalWholeMotion(base, m, T0);
  check("first evaluation anchors: t=0, at base", first.ok && near3(first.pos, [1, 1, 1]));
  const later = evalWholeMotion(base, m, T0 + 500);               // same object → t=0.5s
  check("same object keeps its anchor", later.ok && near3(later.pos, [1, 1 + Math.sin((2 * Math.PI / 2) * 0.5) * 0.5, 1]));
  const fresh = evalWholeMotion(base, { type: "bob", amp: 0.5, period: 2 }, T0 + 500);
  check("a new object anchors fresh (re-folded comp = new epoch)", fresh.ok && near3(fresh.pos, [1, 1, 1]));
  check("evaluation never mutates the component bag", !("_t0" in m) && !("_len" in m), JSON.stringify(Object.keys(m)));
}

// ---- refusals: explicit, named, and never a throw --------------------------
console.log("\n━━ refusals ━━");
{
  const base = { pos: [0, 0, 0], yaw: 0 };
  const cases: Array<[string, any]> = [
    ["unknown type", { type: "wiggle", t0: T0 }],
    ["path with one point", { type: "path", points: [[0, 0, 0]], t0: T0 }],
    ["path with no points", { type: "path", t0: T0 }],
    ["pendulum with period 0 (non-finite phase)", { type: "pendulum", amp: 1, period: 0, t0: T0 }],
    ["pendulum with NaN pivot", { type: "pendulum", amp: 1, pivot: [NaN, 0, 0], t0: T0 }],
    ["no type at all", {}],
  ];
  for (const [label, m] of cases) {
    let r: any = null, threw = false;
    try { r = evalWholeMotion(base, m, T0 + 1000); } catch { threw = true; }
    check(`${label}: refused, not thrown`, !threw && r && r.ok === false && typeof r.why === "string", JSON.stringify(r));
  }
  const part = evalWholeMotion({ pos: [5, 0, 5], yaw: 0.2 }, { type: "spin", part: "blades", t0: T0 }, T0 + 9000);
  check("part-carrying motion: root unmoved, rot false", part.ok && near3(part.pos, [5, 0, 5]) && part.rot === false && near(part.yaw, 0.2));
}

console.log("");
process.exit(failures ? 1 : 0);
