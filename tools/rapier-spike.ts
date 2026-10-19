// Rapier spike — stage 0 of the real-solver body tier.
//
// Question, falsifiable: does an articulated Rapier ragdoll built from OUR
// fleet rig data beat the shipped Verlet on our own metrics? Same rig, same
// topple, same measurements, side by side. If it doesn't, we learned cheaply.
//
//   bun run tools/rapier-spike.ts [rigName]
//
// What "articulated" buys that particles cannot: rigid segments (bone
// stretch is 0 BY CONSTRUCTION), rotational inertia (limbs swing through,
// torsos carry rotation), real contacts with friction/restitution, and
// MOTORED joints — muscle tone, the active-ragdoll lever (a small
// stiffness decaying to zero as the body goes limp).

import { fileURLToPath } from "node:url";
import { plugin } from "bun";
const STUB = fileURLToPath(new URL("./core-stub.mjs", import.meta.url));
plugin({ name: "core-stub", setup(b) { b.onResolve({ filter: /^\.\/core\.js$/ }, () => ({ path: STUB })); } });

import RAPIER from "@dimforge/rapier3d-compat";
import * as THREE from "../client/node_modules/three/build/three.module.js";
const { Ragdoll } = await import("../client/lib/ragdoll.js");
const { rigs, makeAvatar, toppleLean, segDist } = await import("./rig-load.mjs");

await RAPIER.init();

const rigName = process.argv[2] ?? "fox_adventurer";
const rig: any = rigs().find((r: any) => r.name === rigName && !r.err);
if (!rig) { console.error(`no rig "${rigName}"`); process.exit(1); }
console.log(`rig: ${rig.name}\n`);

// ---------------------------------------------------------------- skeleton
// The game-standard 13-body decomposition, cut along OUR humanoid chain.
const SEGMENTS: Array<[string, string]> = [
  ["hips", "spine"], ["spine", "neck"], ["neck", "head"],
  ["leftUpperArm", "leftLowerArm"], ["leftLowerArm", "leftHand"],
  ["rightUpperArm", "rightLowerArm"], ["rightLowerArm", "rightHand"],
  ["leftUpperLeg", "leftLowerLeg"], ["leftLowerLeg", "leftFoot"],
  ["rightUpperLeg", "rightLowerLeg"], ["rightLowerLeg", "rightFoot"],
];
// joint bone -> [parent segment, child segment, kind]
const JOINTS_DEF: Array<{ at: string; parent: string; child: string; kind: "spherical" | "knee" | "elbow" }> = [
  { at: "spine", parent: "hips", child: "spine", kind: "spherical" },
  { at: "neck", parent: "spine", child: "neck", kind: "spherical" },
  { at: "leftUpperArm", parent: "spine", child: "leftUpperArm", kind: "spherical" },
  { at: "rightUpperArm", parent: "spine", child: "rightUpperArm", kind: "spherical" },
  { at: "leftLowerArm", parent: "leftUpperArm", child: "leftLowerArm", kind: "elbow" },
  { at: "rightLowerArm", parent: "rightUpperArm", child: "rightLowerArm", kind: "elbow" },
  { at: "leftUpperLeg", parent: "hips", child: "leftUpperLeg", kind: "spherical" },
  { at: "rightUpperLeg", parent: "hips", child: "rightUpperLeg", kind: "spherical" },
  { at: "leftLowerLeg", parent: "leftUpperLeg", child: "leftLowerLeg", kind: "knee" },
  { at: "rightLowerLeg", parent: "rightUpperLeg", child: "rightLowerLeg", kind: "knee" },
];
// anatomical radii as fractions of the measured torso radius (ragdoll.js's table)
const RADIUS_FRAC: Record<string, number> = {
  "hips|spine": 1.0, "spine|neck": 0.95, "neck|head": 0.6,
  "leftUpperArm|leftLowerArm": 0.5, "leftLowerArm|leftHand": 0.35,
  "rightUpperArm|rightLowerArm": 0.5, "rightLowerArm|rightHand": 0.35,
  "leftUpperLeg|leftLowerLeg": 0.62, "leftLowerLeg|leftFoot": 0.45,
  "rightUpperLeg|rightLowerLeg": 0.62, "rightLowerLeg|rightFoot": 0.45,
};

type Built = {
  world: any;
  segs: Map<string, { body: any; halfLen: number; r: number; a: string; b: string }>;
  motors: any[];
};

function buildRagdoll(world: any, P: Record<string, any>, offset = new THREE.Vector3()): Built {
  const shoulderSpan = P.leftUpperArm && P.rightUpperArm
    ? P.leftUpperArm.distanceTo(P.rightUpperArm) : 0.3;
  const torsoR = Math.max(0.05, shoulderSpan * 0.22);

  const segs = new Map<string, any>();
  const bodyOf = new Map<string, any>();      // named by PARENT bone of the segment
  const up = new THREE.Vector3(0, 1, 0);
  const q = new THREE.Quaternion();

  for (const [a, b] of SEGMENTS) {
    if (!P[a] || !P[b]) continue;
    const pa = P[a].clone().add(offset), pb = P[b].clone().add(offset);
    const mid = pa.clone().add(pb).multiplyScalar(0.5);
    const dir = pb.clone().sub(pa);
    const len = Math.max(dir.length(), 0.04);
    const r = Math.min(torsoR * (RADIUS_FRAC[`${a}|${b}`] ?? 0.5), len * 0.45) * 0.9;
    q.setFromUnitVectors(up, dir.clone().normalize());
    const body = world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(mid.x, mid.y, mid.z)
        .setRotation({ x: q.x, y: q.y, z: q.z, w: q.w })
        .setLinearDamping(0.15).setAngularDamping(0.7),
    );
    const half = Math.max(0.01, len / 2 - r * 0.5);
    world.createCollider(
      RAPIER.ColliderDesc.capsule(half, r).setFriction(0.8).setRestitution(0.05).setDensity(1000),
      body,
    );
    segs.set(`${a}|${b}`, { body, halfLen: len / 2, r, a, b });
    bodyOf.set(a, body);
  }

  // world→local for a body created with rotation q at mid: local = q⁻¹ (p − mid)
  const local = (body: any, worldPos: THREE.Vector3) => {
    const t = body.translation(), rq = body.rotation();
    const inv = new THREE.Quaternion(rq.x, rq.y, rq.z, rq.w).invert();
    return worldPos.clone().sub(new THREE.Vector3(t.x, t.y, t.z)).applyQuaternion(inv);
  };

  const motors: any[] = [];
  for (const J of JOINTS_DEF) {
    const pb = bodyOf.get(J.parent), cb = bodyOf.get(J.child);
    if (!pb || !cb || !P[J.at]) continue;
    const at = P[J.at].clone().add(offset);
    const a1 = local(pb, at), a2 = local(cb, at);
    let jd: any;
    if (J.kind === "spherical") {
      jd = RAPIER.JointData.spherical(a1, a2);
    } else {
      // hinge axis in the PARENT's local frame. Knees bend about the body's
      // lateral axis; elbows about the axis perpendicular to arm and forward.
      const lateral = new THREE.Vector3(1, 0, 0);
      const fwd = new THREE.Vector3(0, 0, 1);
      const boneDir = P[J.child].clone().sub(P[J.parent]).normalize();
      const axisWorld = J.kind === "knee"
        ? lateral
        : new THREE.Vector3().crossVectors(fwd, boneDir).normalize();
      if (axisWorld.lengthSq() < 1e-6) axisWorld.set(1, 0, 0);
      const rq = pb.rotation();
      const axisLocal = axisWorld.clone().applyQuaternion(new THREE.Quaternion(rq.x, rq.y, rq.z, rq.w).invert());
      jd = RAPIER.JointData.revolute(a1, a2, axisLocal);
      jd.limitsEnabled = true;
      // our fleet-measured stance: a knee folds one way and stops (0..150°),
      // hyperextension ~5° of slop, no more
      jd.limits = J.kind === "knee" ? [-2.6, 0.09] : [-0.09, 2.6];
    }
    const joint = world.createImpulseJoint(jd, pb, cb, true);
    joint.setContactsEnabled(false);            // jointed neighbours never collide
    if (J.kind !== "spherical") {
      motors.push(joint);
    } else if (typeof (joint as any).configureMotorPosition === "function") {
      motors.push(joint);
    }
  }
  return { world, segs, motors };
}

/** Muscle tone: drive every motored joint toward rest with a stiffness that
 *  decays — a body going limp, not a power-cut puppet. */
function setTone(built: Built, stiffness: number, damping: number) {
  for (const j of built.motors) {
    try { (j as any).configureMotorPosition(0, stiffness, damping); } catch { /* joint kind without motor */ }
  }
}

/** Height-weighted topple, same law as the Verlet's constructor lean. */
function topple(built: Built, lean: THREE.Vector3) {
  let lo = Infinity, hi = -Infinity;
  for (const s of built.segs.values()) { const y = s.body.translation().y; lo = Math.min(lo, y); hi = Math.max(hi, y); }
  const span = hi - lo || 1;
  for (const s of built.segs.values()) {
    const w = (s.body.translation().y - lo) / span;
    s.body.setLinvel({ x: lean.x * w, y: 0, z: lean.z * w }, true);
  }
}

/** bone -> world position, from segment endpoints (same shape the Verlet's
 *  rd.p has, so the metrics below run identically on both engines). */
function bonePositions(built: Built): Record<string, THREE.Vector3> {
  const out: Record<string, THREE.Vector3> = {};
  for (const s of built.segs.values()) {
    const t = s.body.translation(), rq = s.body.rotation();
    const q2 = new THREE.Quaternion(rq.x, rq.y, rq.z, rq.w);
    const axis = new THREE.Vector3(0, 1, 0).applyQuaternion(q2).multiplyScalar(s.halfLen);
    out[s.a] = new THREE.Vector3(t.x, t.y, t.z).sub(axis);
    out[s.b] = new THREE.Vector3(t.x, t.y, t.z).add(axis);
  }
  return out;
}

// ---------------------------------------------------------------- metrics
type Metrics = {
  settleS: number | null; footKick: number; pelvisY: number; maxY: number;
  stretchPct: number; shinGap: number;
};
function measure(run: () => { p: Record<string, THREE.Vector3>; maxSpeed: number; footSpeed: number }[],
  restLens: Array<[string, string, number]>): Metrics {
  const frames = run();
  let settleAt: number | null = null, still = 0, landedAt: number | null = null, footKick = 0;
  frames.forEach((f, i) => {
    if (landedAt == null && f.p.hips && f.p.hips.y < 0.45) landedAt = i;
    if (landedAt != null && i > landedAt + 6) footKick = Math.max(footKick, f.footSpeed);
    if (f.maxSpeed < 0.08) { still++; if (still >= 24 && settleAt == null) settleAt = i; }
    else still = 0;
  });
  const last = frames[frames.length - 1].p;
  let stretch = 0;
  for (const [a, b, len] of restLens) {
    if (last[a] && last[b]) stretch = Math.max(stretch, Math.abs(last[a].distanceTo(last[b]) - len) / len);
  }
  const ys = Object.values(last).map((v) => v.y);
  const gap = last.leftUpperLeg && last.rightUpperLeg && last.leftLowerLeg && last.rightLowerLeg
    ? segDist(last.leftUpperLeg, last.leftLowerLeg, last.rightUpperLeg, last.rightLowerLeg) : NaN;
  return {
    settleS: settleAt != null ? +(settleAt / 60).toFixed(2) : null,
    footKick: +footKick.toFixed(2),
    pelvisY: +(last.hips?.y ?? NaN).toFixed(2),
    maxY: +Math.max(...ys).toFixed(2),
    stretchPct: +(stretch * 100).toFixed(1),
    shinGap: +gap.toFixed(3),
  };
}

const restLens: Array<[string, string, number]> = SEGMENTS
  .filter(([a, b]) => rig.P[a] && rig.P[b])
  .map(([a, b]) => [a, b, rig.P[a].distanceTo(rig.P[b])]);

const lean = toppleLean(0.6, 1.2);

// ---- Rapier run -----------------------------------------------------------
function rapierRun(withTone: boolean): Metrics {
  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  world.timestep = 1 / 60;
  world.createCollider(RAPIER.ColliderDesc.cuboid(50, 0.5, 50).setTranslation(0, -0.5, 0).setFriction(0.9));
  const built = buildRagdoll(world, rig.P);
  let tone = withTone ? 28 : 0;
  setTone(built, tone, withTone ? 3 : 0.5);
  topple(built, new THREE.Vector3(lean.x, 0, lean.z));
  const frames: any[] = [];
  for (let i = 0; i < 600; i++) {
    if (withTone && i % 6 === 0) { tone *= 0.82; setTone(built, Math.max(tone, 0), 3); }
    world.step();
    let maxSpeed = 0, footSpeed = 0;
    for (const s of built.segs.values()) {
      const v = s.body.linvel(); const sp = Math.hypot(v.x, v.y, v.z);
      maxSpeed = Math.max(maxSpeed, sp);
      if (s.b === "leftFoot" || s.b === "rightFoot") footSpeed = Math.max(footSpeed, sp);
    }
    frames.push({ p: bonePositions(built), maxSpeed, footSpeed });
  }
  capture(withTone ? "rapier+tone" : "rapier", frames);
  return measure(() => frames, restLens);
}

// ---- Verlet run -----------------------------------------------------------
function verletRun(): Metrics {
  const av = makeAvatar(rig.P);
  const rd: any = new Ragdoll(av, lean.clone(), av.restBonePositions());
  const frames: any[] = [];
  let prevFeet: THREE.Vector3[] | null = null;
  for (let i = 0; i < 600; i++) {
    rd.step(1 / 60);
    const p: Record<string, THREE.Vector3> = {};
    for (const [k, v] of Object.entries(rd.p)) p[k] = (v as THREE.Vector3).clone();
    const feet = [p.leftFoot, p.rightFoot].filter(Boolean);
    let footSpeed = 0;
    if (prevFeet && feet.length === prevFeet.length) {
      footSpeed = Math.max(...feet.map((f, j) => f.distanceTo(prevFeet![j]) * 60));
    }
    prevFeet = feet;
    frames.push({ p, maxSpeed: rd.maxV, footSpeed });
    if (rd.done) break;
  }
  while (frames.length < 600) frames.push(frames[frames.length - 1]);
  capture("verlet", frames);
  return measure(() => frames, restLens);
}

// frame capture for the visual side-by-side (tools/spike-viewer)
const captured: Record<string, number[][][]> = {};
const BONES = [...new Set(SEGMENTS.flat())].filter((b) => rig.P[b]);
function capture(name: string, frames: any[]) {
  captured[name] = frames.filter((_, i) => i % 2 === 0)   // 30fps is plenty
    .map((f) => BONES.map((b) => f.p[b] ? [+f.p[b].x.toFixed(3), +f.p[b].y.toFixed(3), +f.p[b].z.toFixed(3)] : [0, 0, 0]));
}

console.log("metric              verlet      rapier      rapier+tone");
const V = verletRun(), R = rapierRun(false), T = rapierRun(true);
const row = (k: keyof Metrics, label: string, unit = "") =>
  console.log(`${label.padEnd(18)} ${String(V[k] ?? "—").padStart(7)}${unit}  ${String(R[k] ?? "—").padStart(7)}${unit}  ${String(T[k] ?? "—").padStart(9)}${unit}`);
row("settleS", "settle time", "s");
row("footKick", "foot kick", " m/s");
row("stretchPct", "bone stretch", "%");
row("pelvisY", "rest pelvis y", "m");
row("maxY", "rest max y", "m");
row("shinGap", "thigh-thigh gap", "m");

// dump the streams for the visual side-by-side
const links = SEGMENTS.filter(([a, b]) => rig.P[a] && rig.P[b])
  .map(([a, b]) => [BONES.indexOf(a), BONES.indexOf(b)]);
await Bun.write("/tmp/spike-frames.json", JSON.stringify({
  rig: rig.name, fps: 30, bones: BONES, links, runs: captured,
  metrics: { verlet: V, rapier: R, "rapier+tone": T },
}));
console.log(`\nframes → /tmp/spike-frames.json (${Object.keys(captured).join(", ")})`);

// ---- perf: K articulated bodies in one world ------------------------------
console.log("\nperf (13 rigid bodies + 10 joints each, one shared world):");
for (const K of [1, 5, 10, 25, 50]) {
  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  world.timestep = 1 / 60;
  world.createCollider(RAPIER.ColliderDesc.cuboid(200, 0.5, 200).setTranslation(0, -0.5, 0));
  const builts: Built[] = [];
  for (let i = 0; i < K; i++) {
    const b = buildRagdoll(world, rig.P, new THREE.Vector3((i % 10) * 2.5, 0, Math.floor(i / 10) * 2.5));
    topple(b, new THREE.Vector3(Math.sin(i), 0, Math.cos(i)).multiplyScalar(1.5));
    builts.push(b);
  }
  for (let f = 0; f < 30; f++) world.step();
  const t0 = performance.now();
  for (let f = 0; f < 120; f++) world.step();
  const ms = (performance.now() - t0) / 120;
  console.log(`  ${String(K).padStart(3)} ragdolls: ${ms.toFixed(2)} ms/frame${ms > 16 ? "  ← past budget" : ""}`);
}
process.exit(0);
