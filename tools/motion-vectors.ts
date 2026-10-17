// Generates shared/conformance/motion.json: reference outputs of
// client/lib/motioneval.js for native ports (Unreal) to reproduce.
//   bun tools/motion-vectors.ts          write the file
//   bun tools/motion-vectors.ts --check  fail if the file is stale
import { evalWholeMotion } from "../client/lib/motioneval.js";
import { readFileSync, writeFileSync } from "node:fs";

const base = (pos: number[], yaw = 0) => ({ pos, yaw });
const T0 = 1_700_000_000_000;
const motions: [string, any, any][] = [
  ["pendulum default pivot", base([1, 2, 3], .4), { type: "pendulum", amp: .6, period: 2.5, phase: .3, t0: T0 }],
  ["pendulum damped string axis", base([0, 0, 0]), { type: "pendulum", amplitude: 1.1, axis: "z", pivot: [0, 3, 1], damp: .2, t0: T0 }],
  ["spin rpm", base([5, 0, -2], 1.2), { type: "spin", rpm: 10, t0: T0 }],
  ["spin deg/s tilted pivot", base([0, 1, 0]), { type: "spin", degPerSec: -45, axis: [1, 1, 0], pivot: [2, 0, 0], phase: .5, t0: T0 }],
  ["orbit facing", base([0, 4, 0]), { type: "orbit", center: [10, 5, -3], radius: 7, degPerSec: 20, phase: 1, t0: T0 }],
  ["orbit no face default center", base([2, 1, 2], .7), { type: "orbit", radius: 2, face: false, t0: T0 }],
  ["bob axis x", base([3, 3, 3], -.5), { type: "bob", axis: "-x", amp: .8, period: 3, phase: .2, t0: T0 }],
  ["bob defaults", base([0, 0, 0]), { type: "bob", t0: T0 }],
  ["path loop", base([0, 0, 0]), { type: "path", points: [[0, 0, 0], [10, 0, 0], [10, 2, 10], [0, 0, 5]], speed: 3, t0: T0 }],
  ["path pingpong duration", base([0, 0, 0], .9), { type: "path", points: [[1, 1, 1], [4, 5, 1]], duration: 4, loop: "pingpong", face: false, t0: T0 }],
  ["path once", base([0, 0, 0]), { type: "path", points: [[0, 0, 0], [0, 0, 8], [6, 0, 8]], speed: 2, loop: "once", t0: T0 }],
  ["part motion leaves root", base([1, 0, 1], 2), { type: "spin", part: "rotor", rpm: 30, t0: T0 }],
  ["unknown type refused", base([0, 0, 0]), { type: "teleport", t0: T0 }],
  ["short path refused", base([0, 0, 0]), { type: "path", points: [[0, 0, 0]], t0: T0 }],
  ["before t0 clamps to zero", base([0, 0, 0]), { type: "bob", amp: 1, period: 2, phase: 1, t0: T0 + 60_000 }],
];
const times = [0, 250, 1_337, 4_000, 9_999, 61_234, 3_600_000];
const round = (v: any): any => typeof v === "number" ? Number(v.toPrecision(12)) : Array.isArray(v) ? v.map(round) : v;
const cases = motions.flatMap(([name, b, m]) => times.map(dt => {
  const r: any = evalWholeMotion(b, m, T0 + dt);
  return { name, base: b, motion: m, nowMs: T0 + dt,
    expect: r.ok ? { ok: true, pos: round(r.pos), yaw: round(r.yaw), quat: round(r.quat), rot: r.rot } : { ok: false } };
}));
const out = JSON.stringify({ source: "client/lib/motioneval.js", tolerance: 1e-6, cases }, null, 1) + "\n";
const path = new URL("../shared/conformance/motion.json", import.meta.url);
if (process.argv.includes("--check")) {
  if (readFileSync(path, "utf8") !== out) { console.error("motion.json is stale: run bun tools/motion-vectors.ts"); process.exit(1); }
  console.log(`MOTION_VECTORS_CURRENT ${cases.length} cases`);
} else { writeFileSync(path, out); console.log(`wrote ${cases.length} cases`); }
