// ragdoll sim test — the physics, run headless, no browser and no renderer.
//
//   bun tools/ragdoll-test.ts
//
// core.js builds a WebGPURenderer at import time, so it cannot load under Bun;
// a loader plugin swaps it for a stub exporting just what ragdoll's dependency
// cone actually uses (THREE, and terrain's scene/ground/grid).
//
// This suite runs against the SHIPPED VRM RIGS, not only against an idealised
// skeleton. That is the whole point of it. The previous version tested one
// synthetic T-pose humanoid on the reasoning that "the invariants under test
// live in the particle sim, not in any particular VRM" — and it passed 18/18
// while every real rig in the fleet was broken, because the rigs are the
// variable the sim is most sensitive to. Measured on the shipped avatars at
// that point: 100% bone-shaft interpenetration on all 14, up to 47% bone
// stretch, elbows and knees with no hyperextension limit at all, and a fall
// that landed 10 metres apart depending on the framerate.
//
// So: keep the synthetic cases (they isolate the solver), and add the fleet.

import { plugin } from 'bun';
import { fileURLToPath } from 'node:url';

const STUB = fileURLToPath(new URL('./core-stub.mjs', import.meta.url));
plugin({
  name: 'core-stub',
  setup(build) {
    build.onResolve({ filter: /^\.\/core\.js$/ }, () => ({ path: STUB }));
  },
});

const { THREE } = await import('./core-stub.mjs');
const { Ragdoll, TUNING, DRIVEN_BONES } = await import('../client/lib/ragdoll.js');
const { rigs, makeAvatar, worstOverlap, segDist, toppleLean, footKick } = await import('./rig-load.mjs');

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = '') => {
  if (ok) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  else { fail++; console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? ` — ${detail}` : ''}`); }
};
const deg = (r: number) => (r * 180 / Math.PI).toFixed(1);

// ---- a synthetic T-pose skeleton, for the cases that want a known body
const WORLD: Record<string, [number, number, number]> = {
  hips: [0, 0.95, 0], spine: [0, 1.05, 0], chest: [0, 1.2, 0],
  neck: [0, 1.4, 0], head: [0, 1.5, 0],
  leftUpperArm: [0.18, 1.35, 0], leftLowerArm: [0.45, 1.35, 0], leftHand: [0.7, 1.35, 0],
  rightUpperArm: [-0.18, 1.35, 0], rightLowerArm: [-0.45, 1.35, 0], rightHand: [-0.7, 1.35, 0],
  leftUpperLeg: [0.09, 0.85, 0], leftLowerLeg: [0.09, 0.45, 0], leftFoot: [0.09, 0.05, 0],
  rightUpperLeg: [-0.09, 0.85, 0], rightLowerLeg: [-0.09, 0.45, 0], rightFoot: [-0.09, 0.05, 0],
};
const synth = (scale = 1, opts = {}) => makeAvatar(
  Object.fromEntries(Object.entries(WORLD).map(
    ([k, v]) => [k, new THREE.Vector3(v[0] * scale, v[1] * scale, v[2] * scale)])),
  opts);

function run(av: any, impulse: any = null, { dt = 1 / 60, maxSteps = 1200 } = {}) {
  const rest = av.restBonePositions();
  const rd: any = new Ragdoll(av, impulse, rest);
  let steps = 0;
  while (!rd.done && steps < maxSteps) {
    rd.step(typeof dt === 'function' ? (dt as any)(steps) : dt);
    steps++;
  }
  return { rd, steps };
}
const stretchOf = (rd: any) => Math.max(...rd.links.map((l: any) =>
  Math.abs(rd.p[l.a].distanceTo(rd.p[l.b]) - l.len) / l.len));

const FLEET = rigs().filter((r: any) => !r.err);
const DEADLINE = TUNING.DEADLINE * 60;

console.log('ragdoll sim, headless:\n');
console.log(`the fleet (${FLEET.length} rigs):`);
check('every shipped rig loads with a humanoid and hips',
  rigs().every((r: any) => !r.err), rigs().filter((r: any) => r.err).map((r: any) => `${r.name}: ${r.err}`).join('; '));

// ---------------------------------------------------------------------------
// the fleet: every invariant, on every shipped body
// ---------------------------------------------------------------------------
{
  const bad: Record<string, string[]> = {
    settle: [], overlap: [], stretch: [], under: [], hyper: [], finite: [], pelvis: [],
  };
  const deadlined: string[] = [];
  for (const rig of FLEET) {
    const { rd, steps } = run(makeAvatar(rig.P), toppleLean());

    // The deadline is the designed safety net for a body that finds a
    // marginally stable rest — it must never stream presence forever. What
    // actually matters is that the pose it CAPTURES is a resting pose, not a
    // mid-flail one. meebit uses it: a blocky rig with very wide hips whose
    // legs splay when it lies down, and this model has no hip-rotation DOF, so
    // the splay lands on the knee's sideways stop and the two trade about a
    // millimetre a step forever. Visually motionless; numerically not zero.
    if (steps >= DEADLINE - 2) {
      deadlined.push(`${rig.name}(v=${rd.maxV.toFixed(3)})`);
      if (rd.maxV > 0.1) bad.settle.push(`${rig.name}(FLAILING at capture, v=${rd.maxV.toFixed(3)})`);
    }

    // bone SHAFTS must not pass through each other — the failure that made a
    // limb vanish into the torso on every rig when only joints collided
    const ov = worstOverlap(rd);
    if (ov.frac > 0.35) bad.overlap.push(`${rig.name}(${(ov.frac * 100).toFixed(0)}% ${ov.name})`);

    const st = stretchOf(rd);
    if (st > 0.10) bad.stretch.push(`${rig.name}(${(st * 100).toFixed(0)}%)`);

    if (Object.keys(rd.p).some((j: string) => rd.p[j].y < -0.01)) bad.under.push(rig.name);

    // knees and elbows must not fold the wrong way. The old unsigned bend
    // table could not express this at all: with a rest angle near 0 its
    // "no hyperextension" bound resolved to 0° on all 14 rigs.
    for (const H of rd.hinge) {
      const u = rd.p[H.b].clone().sub(rd.p[H.a]).normalize();
      const v = rd.p[H.c].clone().sub(rd.p[H.b]).normalize();
      const n = H.n.clone().addScaledVector(u, -H.n.dot(u)).normalize();
      const fold = n.clone().cross(u);            // the allowed direction
      if (v.dot(fold) < -0.25) bad.hyper.push(`${rig.name}:${H.b}(${v.dot(fold).toFixed(2)})`);
    }

    const q = Object.values(rd.finalPose ?? {});
    if (!q.length || !q.every((a: any) => a.length === 4 && a.every(Number.isFinite))) {
      bad.finite.push(rig.name);
    }
    if (!rd.finalPose?.hips) bad.pelvis.push(rig.name);
  }
  const none = (k: string) => bad[k].length === 0;
  check('every rig comes to rest — settled, or still when the deadline fires',
    none('settle'), bad.settle.join(' '));
  if (deadlined.length) {
    console.log(`     \x1b[2mused the deadline (at rest): ${deadlined.join(' ')}\x1b[0m`);
  }
  check('no bone shaft passes through another (≤35%)', none('overlap'), bad.overlap.join(' '));
  check('bone lengths survive the tumble (≤10%)', none('stretch'), bad.stretch.join(' '));
  check('nothing settles underground', none('under'), bad.under.join(' '));
  check('no knee or elbow hyperextends', none('hyper'), bad.hyper.join(' '));
  check('every rig captures a finite pose', none('finite'), bad.finite.join(' '));
  check('every rig drives its pelvis', none('pelvis'), bad.pelvis.join(' '));
}

// ---- the same fall must land in the same place at any framerate
{
  const jitter = (lo: number, hi: number) => (i: number) =>
    lo + (hi - lo) * Math.abs((Math.sin(i * 12.9898) * 43758.5453) % 1);
  let worst = 0, who = '';
  for (const rig of FLEET) {
    const at = (dt: any) => run(makeAvatar(rig.P), toppleLean(), { dt }).rd.p.hips.clone();
    const ref = at(1 / 60);
    for (const dt of [1 / 30, 1 / 120, 1 / 144, jitter(1 / 120, 1 / 30) as any]) {
      const d = ref.distanceTo(at(dt));
      if (d > worst) { worst = d; who = rig.name; }
    }
  }
  // Before the fixed timestep this was metres, not centimetres: the Verlet
  // inertia term is a position delta, so raw frame time made gravity and
  // damping per-second both functions of the display rate.
  check('framerate does not change where a body lands (≤5cm)', worst <= 0.05,
    `worst ${(worst * 100).toFixed(1)}cm on ${who}`);
}

// ---- falling mid-stride must not poison the sim's idea of "rest"
{
  let worst = 0, who = '';
  for (const rig of FLEET) {
    const still = run(makeAvatar(rig.P)).rd;
    const mid = run(makeAvatar(rig.P, { stride: 1 })).rd;
    // the LIMITS are what must match: they are measured off the neutral pose,
    // so a body that fell mid-walk must resolve the same ranges as one that
    // fell standing. (Where it lands may legitimately differ — it started in a
    // different shape.)
    for (let i = 0; i < still.flex.length; i++) {
      const d = Math.abs(still.flex[i].max - mid.flex[i].max);
      if (d > worst) { worst = d; who = `${rig.name}:${still.flex[i].b}`; }
    }
    for (let i = 0; i < still.cone.length; i++) {
      const d = still.cone[i].axis.distanceTo(mid.cone[i].axis);
      if (d > worst) { worst = d; who = `${rig.name}:${still.cone[i].b}`; }
    }
  }
  check('limits are measured off the NEUTRAL pose, not the walk cycle',
    worst < 1e-6, `drift ${worst.toExponential(2)} at ${who}`);
}

// ---- handing a body between machines must be lossless
{
  // A streamed POSE is where the bones point. It is not where the particles
  // are, and it says nothing about what they were doing — so a receiver
  // rebuilding a sim from a pose invents the velocity, and invents zero. Every
  // seam in the drag protocol did this: grab, release, nail. snapshot() is the
  // sim itself, and a body handed over with it CONTINUES.
  // ON EVERY RIG: the one-rig version of this check sat on whichever rig
  // sorted first, and that rig barely moved its arms — so a handover that
  // rebuilt the hinge axes from rest (12–22cm of hand drift after ONE step on
  // 41 of 44 prod rigs, §24t-8) passed for weeks.
  const far = (a: any, b: any) => Math.max(...Object.keys(a.p).map(
    (j: string) => a.p[j].distanceTo(b.p[j])));
  let worstState = 0, worstWho = '', fromBonesMin = Infinity;
  for (const rig of FLEET) {
    const upto = (n: number, seed: any = undefined, av0?: any) => {
      const av = av0 ?? makeAvatar(rig.P, { realParent: rig.realParent });
      const rd: any = new Ragdoll(av, seed === undefined ? toppleLean() : null,
        av.restBonePositions(), seed);
      for (let i = 0; i < n; i++) rd.step(1 / 60);
      return { rd, av };
    };
    const straight = upto(40);
    const snap = straight.rd.snapshot();
    for (let i = 0; i < 80; i++) straight.rd.step(1 / 60);
    const handed = upto(40);
    const cont = upto(80, snap, handed.av);
    const withState = far(straight.rd, cont.rd);
    if (withState > worstState) { worstState = withState; worstWho = rig.name; }
    if (rig === FLEET[0]) {
      const naive = upto(40);
      const rebuilt = upto(80, null, naive.av);
      fromBonesMin = far(straight.rd, rebuilt.rd);
    }
  }
  check('a handover carrying sim state continues the same body (≤1cm, every rig)',
    worstState <= 0.01, `${(worstState * 100).toFixed(1)}cm adrift on ${worstWho}`);
  check('...where rebuilding from the bones alone does not', fromBonesMin > 0.1,
    `bones-only was only ${(fromBonesMin * 100).toFixed(1)}cm adrift, so this proves nothing`);
}

// ---- the rest snapshot has to be taken where the root IS
{
  // Everything read out of `rest` is a difference — bone lengths, cone axes —
  // except hipsOffset, which is the pelvis's height above the ROOT. So a
  // snapshot captured at one root height and used at another is wrong by
  // exactly that difference, and the rendered body sits that far from where
  // the sim has it. The headless agent path did this: it cached the snapshot
  // once with the root at y=0 and reused it for drag releases, which begin
  // wherever the hand let go. A plain knock-over starts at zero and never
  // noticed; a body dropped from a metre up was a metre out.
  const rig = FLEET[0];
  const lifted = (stale: boolean) => {
    const av = makeAvatar(rig.P, { realParent: rig.realParent });
    const atZero = av.restBonePositions();          // captured at root y = 0
    av.root.position.y = 1.0;                        // ...then let go of, up here
    av.root.updateMatrixWorld(true);
    const rest = stale ? atZero : av.restBonePositions();
    const rd: any = new Ragdoll(av, null, rest);
    return rd.hipsOffset;
  };
  const good = lifted(false), bad = lifted(true);
  check('hips offset is measured against the CURRENT root', Math.abs(good - bad - 1.0) < 0.01,
    `fresh ${good.toFixed(2)} vs stale ${bad.toFixed(2)} — should differ by the 1m lift`);
  check('...and the fresh one is the real pelvis height', good > 0.2 && good < 1.2,
    `${good.toFixed(2)}m`);
}

// ---- a sim built mid-motion must inherit that motion
{
  // Verlet keeps velocity in p - prev, and a fresh sim sets prev = p — a body
  // at a dead stop. Everything that RE-CREATES a sim (letting go of a dragged
  // body, pulling a nail) therefore threw the momentum away: a body swung at
  // 3 m/s was dropped where it stood and settled on the spot.
  const rig = FLEET[0];
  const fly = new THREE.Vector3(3, 1, 0);
  const seed = new Map<string, any>();
  {
    const av = makeAvatar(rig.P, { realParent: rig.realParent });
    const rd: any = new Ragdoll(av, null, av.restBonePositions());
    for (const j of Object.keys(rd.p)) seed.set(j, fly);
  }
  const runWith = (v: any) => {
    const av = makeAvatar(rig.P, { realParent: rig.realParent });
    const rest = av.restBonePositions();
    const rd: any = new Ragdoll(av, null, rest, v);
    const from = rd.p.hips.clone();
    let steps = 0;
    while (!rd.done && steps < 240) { rd.step(1 / 60); steps++; }
    return { steps, travelled: rd.p.hips.distanceTo(from) };
  };
  const dead = runWith(null);
  const thrown = runWith(seed);
  check('a body handed 3 m/s actually carries it', thrown.travelled > dead.travelled + 0.5,
    `travelled ${thrown.travelled.toFixed(2)}m vs ${dead.travelled.toFixed(2)}m at rest`);
  // not "takes longer to settle" — a body thrown sideways can land and stop
  // sooner than one dropped in place. The thing that matters is that it MOVED.
  check('...and carries it as real travel, not a dead drop',
    thrown.travelled > 1.0, `only ${thrown.travelled.toFixed(2)}m`);
}

// ---- limbs must not TWIST
{
  // The particle sim gives directions, never roll, so roll comes from however
  // the drive derives a frame. Deriving it against the WORLD drifts — parallel
  // transport has holonomy, so a limb swung around a loop returns rotated by
  // the solid angle it enclosed — and a tumbling arm encloses a lot of sphere.
  // Deriving it against the PARENT cannot drift: it is a function of current
  // state, not of the path. Measured at settle, mean limb twist went 97° -> 0°.
  //
  // The measurement has to be the bone's LOCAL rotation — its rotation inside
  // its parent's frame, which is exactly what the streamed pose stores —
  // decomposed about the bone's own rest axis. Measuring against the bone's
  // rest WORLD orientation instead charges the body's whole tumble as twist,
  // which reads as 180° on a body that has merely lain down, and sent me
  // chasing a number that was mostly the floor.
  const twistOf = (q: any, axis: any) => {
    const along = new THREE.Vector3(q.x, q.y, q.z).dot(axis);
    const t = new THREE.Quaternion(axis.x * along, axis.y * along, axis.z * along, q.w);
    if (t.lengthSq() < 1e-12) return 0;
    t.normalize();
    let a = 2 * Math.acos(Math.max(-1, Math.min(1, t.w))) * 180 / Math.PI;
    if (a > 180) a -= 360;
    return Math.abs(a);
  };
  let worst = 0, who = '', sum = 0, n = 0;
  for (const rig of FLEET) {
    const av = makeAvatar(rig.P);
    const rd: any = new Ragdoll(av, toppleLean(), av.restBonePositions());
    let steps = 0, pose: any = null;
    while (!rd.done && steps < 900) { const q = rd.step(1 / 60); if (q) pose = q; steps++; }
    for (const d of rd.drive) {
      // the pelvis is excluded on purpose: it has no parent BONE, so its local
      // rotation is the body's own orientation and "twist" there is the tumble.
      // Keyed on the NAME, not on a field the new drive happens to add — keyed
      // on the field, this test skipped every bone under the old drive and
      // passed vacuously, which is exactly the failure it exists to catch.
      if (d.bone === 'hips') continue;
      const q = pose?.[d.bone]; if (!q) continue;
      const axis = rd.nodes[d.child].position.clone();
      if (axis.lengthSq() < 1e-9) continue;
      const t = twistOf(new THREE.Quaternion(q[0], q[1], q[2], q[3]), axis.normalize());
      if (t > worst) { worst = t; who = `${rig.name}:${d.bone}`; }
      sum += t; n++;
    }
  }
  const mean = n ? sum / n : 0;
  check('limbs do not twist about their own length (mean ≤5°, worst ≤25°)',
    mean <= 5 && worst <= 25, `mean ${mean.toFixed(0)}°, worst ${worst.toFixed(0)}° at ${who}`);
}

// ---- the legs must not kick out from under the body
{
  // A body that drops straight down has nowhere to put its leg length: both
  // ends of a 0.8m leg reach the floor, the knee folds until it jams on its
  // stop under the torso's whole weight, and then unwinds. Measured before the
  // fix, on the production path: 12.9 m/s of foot AFTER the body had already
  // landed. Two things hold it down now — joint limits stop inelastically
  // instead of storing the energy, and goLimp topples the body rather than
  // pancaking it.
  const bad: string[] = [];
  let worst = 0, who = '';
  for (const rig of FLEET) {
    const av = makeAvatar(rig.P);
    const { peak } = footKick(Ragdoll, av, av.restBonePositions(), toppleLean());
    if (peak > worst) { worst = peak; who = rig.name; }
    if (peak > 3) bad.push(`${rig.name}(${peak.toFixed(1)})`);
  }
  check('no leg kicks out after the body has landed (≤3 m/s)', bad.length === 0,
    bad.join(' '));
  console.log(`     \x1b[2mworst foot after landing: ${worst.toFixed(2)} m/s on ${who}\x1b[0m`);
}

// ---- the fleet splits into two rig families, and both must work
{
  const big = FLEET.filter((r: any) => r.P.upperChest);
  const small = FLEET.filter((r: any) => !r.P.upperChest);
  check('the fleet really does contain both rig families',
    big.length > 0 && small.length > 0, `${big.length} with upperChest, ${small.length} without`);
  // A rig with upperChest+shoulder has TWO undriven bones between chest and
  // upperArm. goLimp parks them (avatar.setLimp) so the span is rigid, which
  // is what the sim's chest->upperArm distance constraint assumes. If that
  // ever regresses, the arm span stops matching its rest length.
  let worst = 0, who = '';
  for (const rig of big) {
    const { rd } = run(makeAvatar(rig.P));
    for (const side of ['leftUpperArm', 'rightUpperArm']) {
      const link = rd.links.find((l: any) => l.a === 'chest' && l.b === side);
      if (!link) continue;
      const err = Math.abs(rd.p.chest.distanceTo(rd.p[side]) - link.len) / link.len;
      if (err > worst) { worst = err; who = `${rig.name}:${side}`; }
    }
  }
  check('upperChest rigs keep a rigid chest→upperArm span (≤10%)', worst <= 0.10,
    `worst ${(worst * 100).toFixed(1)}% at ${who}`);
}

// ---------------------------------------------------------------------------
// the solver itself, on a known body
// ---------------------------------------------------------------------------
console.log('\nthe solver:');
{
  const rd: any = new Ragdoll(synth(), null, synth().restBonePositions());
  check('all 3 flex + 4 cone + 4 hinge limits resolve on a full skeleton',
    rd.flex.length === 3 && rd.cone.length === 4 && rd.hinge.length === 4,
    `${rd.flex.length}/${rd.cone.length}/${rd.hinge.length}`);
  check('every hinge axis is unit length and perpendicular to its bone',
    rd.hinge.every((h: any) => {
      const u = rd.p[h.b].clone().sub(rd.p[h.a]).normalize();
      return Math.abs(h.n.length() - 1) < 1e-6 && Math.abs(h.n.dot(u)) < 1e-6;
    }));
  check('mass is not uniform — the pelvis outweighs a hand',
    rd.iw.leftHand > rd.iw.hips * 5, `hand ${rd.iw.leftHand} vs hips ${rd.iw.hips}`);
  check('capsule pairs exclude what already overlaps at rest',
    rd.pairs.every(({ A, B, min }: any) =>
      segDist(rd.rest[A.a], rd.rest[A.b], rd.rest[B.a], rd.rest[B.b]) >= min),
    `${rd.pairs.length} pairs`);
  check('the body frame is right-handed and orthonormal', (() => {
    const { r, u, f } = rd.frame;
    return Math.abs(r.dot(u)) < 1e-6 && Math.abs(r.dot(f)) < 1e-6 && Math.abs(u.dot(f)) < 1e-6
      && Math.abs(r.clone().cross(u).dot(f) - 1) < 1e-6;
  })());
}

// ---- a violent tumble still obeys the rules
{
  const { rd, steps } = run(synth(), new THREE.Vector3(0.09, -0.03, 0.05));
  check('a launched body settles and captures a pose', rd.done && !!rd.finalPose, `steps=${steps}`);
  check('...without stretching the skeleton (≤10%)', stretchOf(rd) <= 0.10,
    `${(stretchOf(rd) * 100).toFixed(1)}%`);
  check('...and the owner saw its own flop every frame', rd.avatar.poses > 0);
}

// ---- proportions: the root-follow offset is measured, not assumed
{
  for (const [label, scale] of [['adult', 1], ['short (youngopus-ish)', 0.62]] as const) {
    const av = synth(scale);
    const { rd } = run(av, new THREE.Vector3(0.09, -0.03, 0.05));
    av.root.updateMatrixWorld(true);
    const boneY = av.nodes.hips.getWorldPosition(new THREE.Vector3()).y;
    check(`${label}: hips bone tracks hips particle (≤2cm)`,
      Math.abs(boneY - rd.p.hips.y) <= 0.02,
      `gap ${(Math.abs(boneY - rd.p.hips.y) * 100).toFixed(1)}cm`);
    const up = new THREE.Vector3(0, 1, 0)
      .applyQuaternion(av.nodes.hips.getWorldQuaternion(new THREE.Quaternion()));
    check(`${label}: pelvis lies down with the body (tilt > 30°)`,
      Math.acos(Math.min(1, Math.abs(up.y))) > 30 * Math.PI / 180 || rd.p.hips.y > 0.3,
      `tilt ${deg(Math.acos(Math.min(1, Math.abs(up.y))))}°`);
  }
}

// ---- the limits are load-bearing, not vacuously satisfied
{
  const hyper = (rd: any) => Math.min(...rd.hinge.map((H: any) => {
    const u = rd.p[H.b].clone().sub(rd.p[H.a]).normalize();
    const v = rd.p[H.c].clone().sub(rd.p[H.b]).normalize();
    const n = H.n.clone().addScaledVector(u, -H.n.dot(u)).normalize();
    return v.dot(n.clone().cross(u));
  }));
  let worstOff = 1;
  for (const rig of FLEET) {
    const rest = makeAvatar(rig.P).restBonePositions();
    const av = makeAvatar(rig.P);
    const rd: any = new Ragdoll(av, new THREE.Vector3(0.2, 0.05, 0.15), rest);
    rd.hinge = [];                       // the control: no hinge limits at all
    let s = 0;
    while (!rd.done && s < 600) { rd.step(1 / 60); s++; }
    rd.hinge = new (Ragdoll as any)(makeAvatar(rig.P), null, rest).hinge;
    worstOff = Math.min(worstOff, hyper(rd));
  }
  check('control: without the hinge limit, joints DO fold backwards',
    worstOff < -0.25, `worst fold-direction dot only ${worstOff.toFixed(2)}`);
}

// ---------------------------------------------------------------------------
// the ragdoll against actual props — the seam where this went wrong
// ---------------------------------------------------------------------------
console.log('\nbodies and furniture:');
{
  const COL: any = await import('../client/lib/colliders.js');
  const prop = (id: string, w: number, h: number, d: number, y0: number, x: number) => {
    const g = new THREE.BoxGeometry(w, h, d);
    g.translate(0, y0 + h / 2, 0);
    const m = new THREE.Mesh(g, undefined);
    m.updateMatrixWorld(true);
    COL.fitCollider(id, m, { collide: 'box' });   // keep it a box, not an interior
    m.position.set(x, 0, 0);
    m.updateMatrixWorld(true);
    COL.reindexCollider(id);
  };

  // a crate the body falls across: nothing may end up buried inside it
  COL.clearColliders();
  prop('crate', 1, 1, 1, 0, 0.5);
  {
    const { rd } = run(synth(), new THREE.Vector3(0.05, 0, 0.02));
    const inside = Object.keys(rd.p).filter((j: string) => {
      const p = rd.p[j], m = 0.02;
      return p.x > 0.0 + m && p.x < 1.0 - m && p.z > -0.5 + m && p.z < 0.5 - m
        && p.y < 1.0 - m && p.y > 0.0 + m;
    });
    check('no joint settles buried inside a crate', inside.length === 0, inside.join(' '));
    check('...and the body still settles', rd.done);
  }

  // An overhang a standing body fits under — a mezzanine, a bridge, a bunk.
  // Before resolveColliders read box.min.y this was impossible: the slab was
  // an infinite column down to the world floor, so every joint of a body
  // collapsing beneath it was ejected sideways out of the footprint.
  COL.clearColliders();
  prop('overhang', 3, 0.2, 3, 1.6, 0);
  {
    const { rd } = run(synth());
    const n = Object.keys(rd.p).length;
    const under = Object.keys(rd.p).filter((j: string) =>
      Math.abs(rd.p[j].x) < 1.5 && Math.abs(rd.p[j].z) < 1.5);
    check('a body collapsing under an overhang stays under it', under.length === n,
      `only ${under.length}/${n} joints still beneath it`);
    check('...and none of it clipped up through the slab',
      Object.keys(rd.p).every((j: string) => rd.p[j].y < 1.6));
  }
  COL.clearColliders();
}

// ---------------------------------------------------------------------------
// impulse: shoves that land on a body already in flight, or already down.
// This is the wire path — puppet {lean} and the force verb both end here.
// ---------------------------------------------------------------------------
console.log('\nimpulse (the wire-borne shove):');
{
  // Mid-tumble: a sideways shove half a second into every rig's fall. The
  // invariants must hold THROUGH the interruption — everything still comes to
  // rest, keeps its bone lengths, stays above ground, captures finite — and
  // the shove must actually MOVE the body the way it points.
  const bad: Record<string, string[]> = { rest: [], stretch: [], under: [], finite: [], moved: [], creep: [] };
  for (const rig of FLEET) {
    const av = makeAvatar(rig.P);
    const rd: any = new Ragdoll(av, toppleLean(), av.restBonePositions());
    const x0 = rd.p.hips.x;
    let steps = 0, x60 = NaN, at3s: any = null;
    while (!rd.done && steps < 1400) {
      if (steps === 30) rd.impulse(new THREE.Vector3(2.5, 0, 0));
      rd.step(1 / 60); steps++;
      if (steps === 90) x60 = rd.p.hips.x;                 // one second after the shove
      if (steps === 180) at3s = rd.p.hips.clone();          // lying by now on every rig
    }
    if (!rd.done) { bad.rest.push(`${rig.name}(never captured)`); continue; }
    if (rd.maxV > 0.1) bad.rest.push(`${rig.name}(flailing at capture, v=${rd.maxV.toFixed(3)})`);
    if (stretchOf(rd) > 0.10) bad.stretch.push(`${rig.name}(${(stretchOf(rd) * 100).toFixed(0)}%)`);
    if (Object.keys(rd.p).some((j: string) => rd.p[j].y < -0.01)) bad.under.push(rig.name);
    const q = Object.values(rd.finalPose ?? {});
    if (!q.length || !q.every((a: any) => a.length === 4 && a.every(Number.isFinite))) bad.finite.push(rig.name);
    // the SHOVE is judged a second after it lands — that is what "goes the way
    // it was shoved" means; where the body creeps to afterwards is the next
    // check's business, and folding the two into one number hid the creep
    // behind a shove that had in fact landed (+37cm) — mythos-2, §24t-8
    const dx = (Number.isFinite(x60) ? x60 : rd.p.hips.x) - x0;
    if (dx < 0.05) bad.moved.push(`${rig.name}(Δx=${dx.toFixed(2)})`);
    // a body that is down should stay put: hips travel from 3s to capture
    if (at3s && at3s.distanceTo(rd.p.hips) > 0.05) {
      bad.creep.push(`${rig.name}(${(at3s.distanceTo(rd.p.hips) * 100).toFixed(0)}cm over ${((steps - 180) / 60).toFixed(1)}s)`);
    }
  }
  const none = (k: string) => bad[k].length === 0;
  check('a mid-tumble shove still comes to rest', none('rest'), bad.rest.join(' '));
  check('...bone lengths survive it (≤10%)', none('stretch'), bad.stretch.join(' '));
  check('...nothing driven underground', none('under'), bad.under.join(' '));
  check('...capture stays finite', none('finite'), bad.finite.join(' '));
  check('...and the body goes the way it was shoved (≥5cm a second after)', none('moved'), bad.moved.join(' '));
  check('...and a body that is down does not creep (≤5cm from 3s to capture)', none('creep'), bad.creep.join(' '));

  // The deadline restarts with the motion: a shove at 7.9s of an 8s window
  // must not capture a body still in the air. impulse() grants the new motion
  // the same full window the original fall had.
  {
    const rd: any = new Ragdoll(synth(), toppleLean(), null);
    // shove while the tumble is still LIVE — a captured sim ignores impulses
    // by design (main.js starts a fresh one instead: the corpse-kick below)
    for (let i = 0; i < 45 && !rd.done; i++) rd.step(1 / 60);
    const before = rd.elapsed;
    rd.impulse(new THREE.Vector3(1, 0, 0));
    check('impulse restarts the settle clock and the deadline',
      !rd.done && rd.elapsed === 0 && rd.settledFor === 0 && before > 0.5,
      `done=${rd.done} elapsed ${before.toFixed(2)} -> ${rd.elapsed}`);
  }

  // The sim caps what it will accept: a hostile magnitude must not shatter
  // the body, whatever the trust boundary upstream let through.
  {
    const av = synth();
    const rd: any = new Ragdoll(av, null, av.restBonePositions());
    for (let i = 0; i < 30; i++) rd.step(1 / 60);
    rd.impulse(new THREE.Vector3(1000, 0, 0));
    let steps = 0;
    while (!rd.done && steps < 1400) { rd.step(1 / 60); steps++; }
    check('a hostile 1000 m/s shove is capped, not obeyed',
      rd.done && stretchOf(rd) < 0.10 && Object.values(rd.p).every((p: any) => Number.isFinite(p.x)),
      `done=${rd.done} stretch=${(stretchOf(rd) * 100).toFixed(0)}%`);
  }

  // Kicking the corpse: a settled body shoved again starts a FRESH sim from
  // its lying pose (main.js re-limp path — downed, ragdoll already handed
  // off). It must tumble again, move, and come back to rest.
  {
    const av = synth();
    const first = run(av, toppleLean());
    check('corpse-kick precondition: the first fall captured', first.rd.done);
    av.root.updateMatrixWorld(true);
    const rd2: any = new Ragdoll(av, new THREE.Vector3(3, 0, 0), av.restBonePositions());
    const x0 = rd2.p.hips.x;
    let steps = 0;
    while (!rd2.done && steps < 1400) { rd2.step(1 / 60); steps++; }
    check('a settled body can be kicked into a fresh tumble',
      rd2.done && rd2.p.hips.x - x0 > 0.1 && stretchOf(rd2) < 0.10,
      `done=${rd2.done} Δx=${(rd2.p.hips.x - x0).toFixed(2)} stretch=${(stretchOf(rd2) * 100).toFixed(0)}%`);
  }
}

// ---------------------------------------------------------------------------
// the pin: a grabbed joint owned by a hand (bodydrag's takeover sim)
// ---------------------------------------------------------------------------
console.log('\npin (the grabbed joint):');
{
  // hang: pin a hand above standing height — the body must dangle from it,
  // the pinned joint must BE at the target, and the sim must neither settle
  // nor deadline while held (a pin is ongoing input).
  const av = synth();
  const rd: any = new Ragdoll(av, null, av.restBonePositions());
  const hold = new THREE.Vector3(0.3, 3.0, 0.2);   // well above standing: the lift must RAISE the root
  rd.setPin('leftHand', hold);
  for (let i = 0; i < 900; i++) { rd.setPin('leftHand', hold); rd.step(1 / 60); }  // 15s >> 8s deadline
  check('the pinned joint is exactly where the hand says',
    rd.p.leftHand.distanceTo(hold) < 0.02, `${rd.p.leftHand.distanceTo(hold).toFixed(3)}m off`);
  check('the body hangs from it, not through it',
    rd.p.hips.y < rd.p.leftHand.y, `hips ${rd.p.hips.y.toFixed(2)} vs hand ${rd.p.leftHand.y.toFixed(2)}`);
  check('a held body never captures — no settle, no deadline',
    !rd.done && rd.elapsed < 1, `done=${rd.done} elapsed=${rd.elapsed.toFixed(1)}`);
  // The RENDERED body must rise with the sim: the root's falling-only ceiling
  // (Math.min against rootStartY) has to lift while pinned, or the particles
  // go up and the mesh stays floor-bound — "it lifts a little, then something
  // keeps them constrained to the ground" (antra, live, 2026-08-02).
  check('...and the rendered root rises with the carried body',
    av.root.position.y > 0.35, `root.y=${av.root.position.y.toFixed(2)}`);
  check('...and its bone lengths survive the hang (≤10%)',
    stretchOf(rd) < 0.10, `${(stretchOf(rd) * 100).toFixed(0)}%`);

  // drag: walk the pin sideways 2m — the body must come along
  const x0 = rd.p.hips.x;
  for (let i = 0; i < 300; i++) {
    hold.x = 0.3 + (i / 300) * 2;
    rd.setPin('leftHand', hold);
    rd.step(1 / 60);
  }
  check('dragging the pin drags the body', rd.p.hips.x - x0 > 1.2,
    `Δx=${(rd.p.hips.x - x0).toFixed(2)}`);

  // release: let go mid-air — the body falls and comes to rest on its own
  rd.setPin(null);
  let steps = 0;
  while (!rd.done && steps < 1400) { rd.step(1 / 60); steps++; }
  check('released, it falls and comes to rest',
    rd.done && Object.keys(rd.p).every((j: string) => rd.p[j].y < 1.2 && rd.p[j].y > -0.01),
    `done=${rd.done}`);
  check('...still holding its skeleton together (≤10%)',
    stretchOf(rd) < 0.10, `${(stretchOf(rd) * 100).toFixed(0)}%`);
}

// multi-pin: hung by both wrists, then one nail pulled, then the other
{
  const av = synth();
  const rd: any = new Ragdoll(av, null, av.restBonePositions());
  const L = new THREE.Vector3(0.5, 2.2, 0), R = new THREE.Vector3(-0.5, 2.2, 0);
  rd.setPin('leftHand', L);
  rd.setPin('rightHand', R);
  for (let i = 0; i < 600; i++) rd.step(1 / 60);
  check('hung by both wrists: both nails hold exactly',
    rd.p.leftHand.distanceTo(L) < 0.02 && rd.p.rightHand.distanceTo(R) < 0.02,
    `L ${rd.p.leftHand.distanceTo(L).toFixed(3)} R ${rd.p.rightHand.distanceTo(R).toFixed(3)}`);
  check('...body hangs between them', rd.p.hips.y < 2.2 && rd.p.hips.y > 0.3,
    `hips.y=${rd.p.hips.y.toFixed(2)}`);
  check('...and never captures while nailed', !rd.done);

  rd.setPin('leftHand', null);                    // pull ONE nail
  for (let i = 0; i < 600; i++) rd.step(1 / 60);
  check('one nail pulled: the freed hand drops, the other holds',
    rd.p.leftHand.y < 1.6 && rd.p.rightHand.distanceTo(R) < 0.02,
    `left.y=${rd.p.leftHand.y.toFixed(2)} R off ${rd.p.rightHand.distanceTo(R).toFixed(3)}`);

  rd.setPin(null);                                // pull everything
  let steps = 0;
  while (!rd.done && steps < 1400) { rd.step(1 / 60); steps++; }
  check('all nails pulled: the body falls and rests',
    rd.done && stretchOf(rd) < 0.10, `done=${rd.done} stretch=${(stretchOf(rd) * 100).toFixed(0)}%`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
