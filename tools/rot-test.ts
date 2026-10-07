// Orientation as quaternions (PROTOCOL §9 amendment) — `bun tools/rot-test.ts`.
// Checks shared/rot.js against three.js (an independent implementation) and
// the fold's q semantics: yaw-only logs unchanged, q is the whole truth when
// present, yaw is always its heading, a bare yaw keeps tilt.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as THREE from "three";
import { emptyState, foldEntry, stateToEntries } from "../shared/v4/import-v1/fold.js";
import { qNorm, qFromYaw, qMul, qRotate, qHeading, qWithHeading } from "../shared/rot.js";

let pass = 0, fail = 0;
const ok = (name: string, cond: boolean, detail = "") => { if (cond) pass++; else { fail++; console.log("  ✗", name, detail); } };
const near = (a: number[] | undefined, b: number[], eps = 1e-12) => !!a && a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) <= eps);
const sameRot = (a: number[] | undefined, b: number[], eps = 1e-12) => !!a && (near(a, b, eps) || near(a, b.map(v => -v), eps));   // q ≡ −q
const fold = (entries: any[]) => { const st = emptyState(); let seq = 0; for (const e of entries) foldEntry(st, { seq: seq++, ts: 1000 + seq, actor: "t", ...e }); return st; };
const E = (verb: string, args: any) => ({ verb, args });

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

// ---- fold: yaw-only history is untouched
const yawOnly = fold([
  E("spawn", { id: "a", lib: "x.glb", pos: [1, 0, 2], yaw: 0.7 }),
  E("place", { id: "a", yaw: 2.1 }),
  E("spawn", { id: "b", lib: "y.glb", pos: [0, 0, 0] }),
  E("mount", { id: "b", to: "a", offset: [1, 0, 0], yaw: 0.5 }),
  E("remove", { id: "a" }),
]);
ok("yaw-only fold grows no q", !JSON.stringify(yawOnly).includes('"q"'));
ok("yaw-only orphan math unchanged", near(yawOnly.entities.b.pos, [1 + Math.cos(2.1), 0, 2 - Math.sin(2.1)], 0) && yawOnly.entities.b.yaw === 2.6);

// ---- fold: q is the truth, yaw its heading
const tip = qNorm([Math.sin(Math.PI / 4), 0, 0, Math.cos(Math.PI / 4)])!;         // 90° about +X: lying on its back
const turnedTip = qMul(qFromYaw(1.0), tip);
let st = fold([E("spawn", { id: "c", lib: "c.glb", pos: [0, 0, 0], q: [2 * turnedTip[0], 2 * turnedTip[1], 2 * turnedTip[2], 2 * turnedTip[3]] })]);
ok("spawn q is normalized", sameRot(st.entities.c.q, turnedTip, 1e-15));
ok("spawn q sets yaw = heading", Math.abs(st.entities.c.yaw - qHeading(turnedTip)) < 1e-15);
st = fold([E("spawn", { id: "c", lib: "c.glb", pos: [0, 0, 0], q: tip }), E("place", { id: "c", yaw: 2.5 })]);
ok("bare yaw on a tilted thing keeps the tilt", Math.abs(qRotate(st.entities.c.q, [0, 1, 0])[1] - qRotate(tip, [0, 1, 0])[1]) < 1e-12);
ok("bare yaw on a tilted thing sets its heading", Math.abs(qHeading(st.entities.c.q) - 2.5) < 1e-12 && st.entities.c.yaw === 2.5);
st = fold([E("spawn", { id: "c", lib: "c.glb", pos: [0, 0, 0], q: tip }), E("place", { id: "c", q: [0, 0, 0, 1], yaw: 9 })]);
ok("place q replaces (q wins over yaw)", sameRot(st.entities.c.q, [0, 0, 0, 1]) && st.entities.c.yaw === 0);
st = fold([E("spawn", { id: "c", lib: "c.glb", pos: [0, 0, 0], q: tip }), E("place", { id: "c", q: [0, 0, 0, 0] })]);
ok("malformed q shapes nothing", sameRot(st.entities.c.q, tip));
st = fold([E("spawn", { id: "d", lib: "d.glb", pos: [0, 0, 0], q: "sideways", yaw: 1 })]);
ok("malformed q on spawn falls back to yaw", st.entities.d.q === undefined && st.entities.d.yaw === 1);

// ---- fold: a tilted carrier turns its riders' offsets
st = fold([
  E("spawn", { id: "cart", lib: "c.glb", pos: [5, 1, 5], q: tip }),
  E("spawn", { id: "box", lib: "b.glb", pos: [0, 0, 0] }),
  E("mount", { id: "box", to: "cart", offset: [0, 1, 0] }),
  E("remove", { id: "cart" }),
]);
ok("orphan offset rotates by the carrier's q", near(st.entities.box.pos, [5, 1, 6], 1e-12), JSON.stringify(st.entities.box.pos));
ok("orphan inherits the carrier's tilt", sameRot(st.entities.box.q, tip, 1e-15));
st = fold([
  E("spawn", { id: "cart", lib: "c.glb", pos: [0, 0, 0], yaw: 0 }),
  E("spawn", { id: "box", lib: "b.glb", pos: [0, 0, 0] }),
  E("mount", { id: "box", to: "cart", offset: [0, 0, 0], q: tip }),
  E("remove", { id: "cart" }),
]);
ok("a rider's relative q composes on an upright carrier", sameRot(st.entities.box.q, tip, 1e-15));

// ---- snapshots carry q (a late joiner sees the same tilt)
st = fold([
  E("spawn", { id: "c", lib: "c.glb", pos: [0, 0, 0], q: tip }),
  E("light", { id: "L", pos: [0, 2, 0] }), E("place", { id: "L", q: tip }),
]);
const again = fold(stateToEntries(st) as any[]);
ok("snapshot roundtrip keeps an entity's q", sameRot(again.entities.c.q, tip, 0));
ok("snapshot roundtrip keeps a light's q", sameRot(again.entities.L.q, tip, 0));
st = fold([E("light", { id: "L", pos: [0, 2, 0] }), E("place", { id: "L", q: tip }), E("light", { id: "L", intensity: 40 })]);
ok("a light re-light keeps its q", sameRot(st.entities.L.q, tip, 0));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
