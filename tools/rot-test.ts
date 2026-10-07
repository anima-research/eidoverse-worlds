// Orientation as quaternions (PROTOCOL §9 amendment) — `bun tools/rot-test.ts`.
// Checks shared/rot.js against three.js (an independent implementation), and
// that rot.js owns its numerics. (The v1 fold's q semantics that lived here went
// with the v1 fold: a v4 transform carries q itself, folded by shared/v4/fold.js.)
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as THREE from "three";
import { qNorm, qFromYaw, qMul, qRotate, qHeading, qWithHeading } from "../shared/rot.js";

let pass = 0, fail = 0;
const ok = (name: string, cond: boolean, detail = "") => { if (cond) pass++; else { fail++; console.log("  ✗", name, detail); } };
const near = (a: number[] | undefined, b: number[], eps = 1e-12) => !!a && a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) <= eps);
const sameRot = (a: number[] | undefined, b: number[], eps = 1e-12) => !!a && (near(a, b, eps) || near(a, b.map(v => -v), eps));   // q ≡ −q

// ---- the math, against three.js
const rnd = (() => { let s = 12345; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296) - 0.5; })();
for (let i = 0; i < 200; i++) {
  const a = qNorm([rnd(), rnd(), rnd(), rnd()])!, b = qNorm([rnd(), rnd(), rnd(), rnd()])!, v = [rnd() * 9, rnd() * 9, rnd() * 9];
  const ta = new THREE.Quaternion(...a), tb = new THREE.Quaternion(...b);
  const m = new THREE.Quaternion().multiplyQuaternions(ta, tb);
  ok(`qMul == three.multiply #${i}`, near(qMul(a, b), [m.x, m.y, m.z, m.w], 1e-14));
  const tv = new THREE.Vector3(...v).applyQuaternion(ta);
  ok(`qRotate == three.applyQuaternion #${i}`, near(qRotate(a, v), [tv.x, tv.y, tv.z], 1e-12));
  const yaw = rnd() * 12;
  const ty = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
  ok(`qFromYaw == axis-angle about +Y #${i}`, sameRot(qFromYaw(yaw), [ty.x, ty.y, ty.z, ty.w], 1e-14));
  const f = new THREE.Vector3(0, 0, 1).applyQuaternion(ta);
  ok(`qHeading == atan2 of facing #${i}`, Math.abs(qHeading(a) - Math.atan2(f.x, f.z)) < 1e-13);
  const turned = qWithHeading(a, yaw)!;
  const wrap = (x: number) => Math.atan2(Math.sin(x), Math.cos(x));
  ok(`qWithHeading sets heading #${i}`, Math.abs(wrap(qHeading(turned) - yaw)) < 1e-12);
  const up = (q: number[]) => qRotate(q, [0, 1, 0])[1];
  ok(`qWithHeading keeps tilt #${i}`, Math.abs(up(turned) - up(a)) < 1e-12);
}
for (const [name, q] of [["face down", qNorm([-Math.SQRT1_2, 0, 0, Math.SQRT1_2])!], ["on its back", qNorm([Math.SQRT1_2, 0, 0, Math.SQRT1_2])!]] as const)
  for (const yaw of [-2, 0.3, 3]) ok(`heading of a thing ${name}, turned to ${yaw}`, Math.abs(qHeading(qWithHeading(q, yaw)!) - yaw) < 1e-12);
ok("qNorm refuses junk", [null, [1, 2, 3], [0, 0, 0, 0], [NaN, 0, 0, 1], "q", [1, 0, 0, Infinity]].every(q => qNorm(q as any) === null));

// ---- owned numerics: no host transcendentals in rot.js (PROTOCOL_v2 Covenant I's discipline, applied to the instant fold)
const rotSrc = readFileSync(join(import.meta.dir, "..", "shared", "rot.js"), "utf8").replace(/\/\/.*$/gm, "");
ok("rot.js uses no host sin/cos/atan2/pow/exp", !/Math\.(sin|cos|tan|atan2?|asin|acos|pow|exp|log|hypot)\b/.test(rotSrc));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
