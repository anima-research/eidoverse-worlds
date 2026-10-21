// armsolve-test — the swivel arm solver (xrbody.js solveArm/relaxArm, Basis's BasisArmSolveCore port) on a
// synthetic humanoid. What this proves, node-side, before a headset does: the hand lands on the grip (soft
// reach at the end, never a pop); the elbow angle is CONTINUOUS across a wide sweep (no flip — the old pole
// solver flipped at its singularity); the elbow stays outside the torso capsule when the hand crosses the
// body; the wrist twist is split (forearm rolls, hand takes the remainder — grip orientation still exact);
// the twist is continuous across the forearm's real range, ~100° pronation to ~190° supination (no forearm flip);
// and a lost grip holds 0.5 s then relaxes to the clip instead of snapping.
// Recipe: `bun tools/armsolve-test.ts`
import { plugin } from "bun";
const here = (p: string) => new URL(p, import.meta.url).pathname;
plugin({
  name: "armsolve-stubs",
  setup(b) {
    b.onResolve({ filter: /^\.\/core\.js$/ }, () => ({ path: here("./core-stub.mjs") }));
    b.onResolve({ filter: /^\.\/base\.js$/ }, () => ({ path: here("./core-stub.mjs") }));
    b.onResolve({ filter: /^\.\/controller\.js$/ }, () => ({ path: here("./armsolve-xr-stub.mjs") }));
    b.onResolve({ filter: /^\.\/xr\.js$/ }, () => ({ path: here("./armsolve-xr-stub.mjs") }));
  },
});
globalThis.location ??= { search: "" } as any;   // xrbody reads ?torsoplay at import
const { THREE } = await import("./core-stub.mjs");
const { solveArm, relaxArm, solveLeg, gaitInit, gaitTick } = await import("../client/lib/xrbody.js");
const { makeCapsuleVrm } = await import("../client/lib/capsulebody.js");

let pass = 0, fail = 0;
const ok = (c: boolean, m: string) => { if (c) pass++; else { fail++; console.log("  FAIL", m); } };

// a VRM-shaped humanoid: hips→spine→chest→upperChest→neck→head; shoulders off upperChest; arms along ±X
function humanoid(scale = 1) {
  const mk = (name: string, x: number, y: number, z: number, parent?: any) => { const o = new THREE.Object3D(); o.name = name; o.position.set(x, y, z); parent?.add(o); return o; };
  const scene = new THREE.Object3D(); scene.scale.setScalar(scale);
  const hips = mk('hips', 0, 0.95, 0, scene), spine = mk('spine', 0, 0.1, 0, hips), chest = mk('chest', 0, 0.12, 0, spine), upperChest = mk('upperChest', 0, 0.12, 0, chest);
  const neck = mk('neck', 0, 0.12, 0, upperChest), head = mk('head', 0, 0.08, 0, neck);
  const bones: Record<string, any> = { hips, spine, chest, upperChest, neck, head };
  for (const side of ['left', 'right']) {
    const s = side === 'left' ? 1 : -1;
    const U = mk(side + 'UpperArm', s * 0.17, 0.08, 0, upperChest), L = mk(side + 'LowerArm', s * 0.28, 0, 0, U), H = mk(side + 'Hand', s * 0.26, 0, 0, L);
    bones[side + 'UpperArm'] = U; bones[side + 'LowerArm'] = L; bones[side + 'Hand'] = H;
  }
  scene.updateMatrixWorld(true);
  return { scene, userData: {}, humanoid: { getNormalizedBoneNode: (n: string) => bones[n] ?? null }, bones };
}
const torsoOf = (v: any) => ({ a: v.bones.hips.getWorldPosition(new THREE.Vector3()), b: v.bones.neck.getWorldPosition(new THREE.Vector3()), r: 0.12 });
const handAt = (v: any, side: string) => v.bones[side + 'Hand'].getWorldPosition(new THREE.Vector3());
const elbowAt = (v: any, side: string) => v.bones[side + 'LowerArm'].getWorldPosition(new THREE.Vector3());
const ident = new THREE.Quaternion();

// 1. reach: near, mid, and beyond full extension — the hand lands on the target (soft at the end)
{
  const v = humanoid(); const sh = v.bones.rightUpperArm.getWorldPosition(new THREE.Vector3());
  for (const [dist, label] of [[0.25, 'near'], [0.45, 'mid'], [0.53, 'at 98%'], [0.7, 'beyond']] as [number, string][]) {
    const t = sh.clone().add(new THREE.Vector3(-0.4, 0.1, 0.8).normalize().multiplyScalar(dist));
    ok(solveArm(v, 'right', t, ident, { dt: 1 / 72, torso: torsoOf(v) }), `solve ${label}`);
    v.scene.updateMatrixWorld(true);
    const err = handAt(v, 'right').distanceTo(t), chain = 0.54;
    if (dist <= chain * 0.98) ok(err < 0.02, `${label}: hand on target (err ${err.toFixed(3)})`);
    else ok(err < dist - chain * 0.97 + 0.02 && err > 0, `${label}: soft reach short of a hard stop (err ${err.toFixed(3)})`);
  }
}

// 2. continuity: sweep the right hand through 180° in front of and across the body over 400 frames; the
//    elbow position must move smoothly — never a jump larger than a frame's worth of 720°/s on a 0.28 m arm
{
  const v = humanoid(); const sh = v.bones.rightUpperArm.getWorldPosition(new THREE.Vector3());
  let maxJump = 0, prev: any = null, solved = 0;
  for (let i = 0; i <= 400; i++) {
    const a = -Math.PI * 0.55 + Math.PI * 1.1 * (i / 400);   // from far right, across the chest, to the left
    const t = sh.clone().add(new THREE.Vector3(Math.sin(a) * 0.42, -0.05 + 0.15 * Math.sin(i / 23), Math.cos(a) * 0.42));
    if (solveArm(v, 'right', t, ident, { dt: 1 / 72, torso: torsoOf(v), head: v.bones.head.getWorldPosition(new THREE.Vector3()) })) solved++;
    v.scene.updateMatrixWorld(true);
    const e = elbowAt(v, 'right'); if (prev) maxJump = Math.max(maxJump, e.distanceTo(prev)); prev = e;
  }
  ok(solved === 401, `sweep solved every frame (${solved}/401)`);
  const perFrame = 0.28 * (720 * Math.PI / 180) / 72;   // arc a 0.28 m upper arm can swing per frame at the rate cap
  ok(maxJump < perFrame * 1.1, `elbow continuous across the sweep (max jump ${(maxJump * 100).toFixed(2)} cm/frame, cap ${(perFrame * 100).toFixed(2)})`);
}

// 3. torso: hand across the body at chest height — the elbow stays outside the capsule (+ its skin)
{
  const v = humanoid(); const torso = torsoOf(v);
  const t = new THREE.Vector3(0.2, 1.25, 0.25);   // right hand reaching to the left side, in front
  for (let i = 0; i < 60; i++) solveArm(v, 'right', t, ident, { dt: 1 / 72, torso });
  v.scene.updateMatrixWorld(true);
  const e = elbowAt(v, 'right'); const ab = torso.b.clone().sub(torso.a); const tt = THREE.MathUtils.clamp(e.clone().sub(torso.a).dot(ab) / ab.lengthSq(), 0, 1);
  const dist = e.distanceTo(torso.a.clone().addScaledVector(ab, tt));
  ok(dist > torso.r, `elbow clear of the torso capsule (${(dist * 100).toFixed(1)} cm from the axis, radius ${torso.r * 100} cm)`);
}

// 4. wrist split: a 100° twist about the forearm — the hand still lands on the grip orientation exactly, and
//    the forearm carries most of it (hand keeps ≤ 15°)
{
  const v = humanoid(); const sh = v.bones.rightUpperArm.getWorldPosition(new THREE.Vector3());
  const t = sh.clone().add(new THREE.Vector3(-0.1, 0, 0.45));
  solveArm(v, 'right', t, ident, { dt: 1 / 72 }); v.scene.updateMatrixWorld(true);
  const q0 = v.bones.rightHand.getWorldQuaternion(new THREE.Quaternion());
  // now demand the same hand orientation rotated 100° about the forearm's world axis
  const fa = v.bones.rightHand.getWorldPosition(new THREE.Vector3()).sub(v.bones.rightLowerArm.getWorldPosition(new THREE.Vector3())).normalize();
  const twist = new THREE.Quaternion().setFromAxisAngle(fa, 100 * Math.PI / 180);
  // targetQuat is composed as parentInv · targetQuat · WRIST — recover the grip that yields q0, then twist it
  const grip0 = ident.clone();   // first solve used identity grip
  const gripT = twist.clone().multiply(grip0);
  const lowerBefore = v.bones.rightLowerArm.quaternion.clone();
  solveArm(v, 'right', t, gripT, { dt: 1 / 72 }); v.scene.updateMatrixWorld(true);
  const q1 = v.bones.rightHand.getWorldQuaternion(new THREE.Quaternion());
  const want = twist.clone().multiply(q0);
  ok(Math.abs(q1.angleTo(want)) < 0.02, `hand orientation exact after the split (err ${(q1.angleTo(want) * 180 / Math.PI).toFixed(2)}°)`);
  const forearmRoll = lowerBefore.angleTo(v.bones.rightLowerArm.quaternion) * 180 / Math.PI;
  ok(forearmRoll > 70 && forearmRoll < 100, `forearm carried the bulk of the twist (${forearmRoll.toFixed(1)}° of 100°)`);
}

// 6. twist continuity (owner, 09-23, tigerbee: thumb-down/palm-out → thumb-out/palm-up and the forearm "tries to
//    flip the other way"). Inside a forearm's real range — ~100° of pronation past palm-down to ~190° of supination
//    — every roll of the grip, from any start, must move the forearm smoothly. The old split wrapped the twist to
//    ±180° about the REST hand and faded 155–178°: 9.4° of forearm per degree of grip, near palm-up.
//    NOT asked: 270° both ways from every start on the circle — no single-valued twist survives that (a first cut of
//    this test asked it and failed both solvers). The rig mapping below is MEASURED on this synthetic humanoid
//    (grip roll about the forearm → twist from rest, palm-down ≈ 0, supination + on the right, − on the left) and
//    guarded, so a change to the rig or WRIST_R says so here instead of silently shifting the band.
{
  for (const side of ['right', 'left']) {
    const sg = side === 'right' ? 1 : -1, gripOf = (tw: number) => sg * tw + sg * 120.7;
    const band: [number, number] = [-100, 190];   // twist, supination-positive
    const setup = () => {
      // a virtual clock: one 72 Hz frame per solve (the solver reseeds its twist after a gap, so time is an input)
      let clk = 0; const frame = () => (clk += 1000 / 72);
      const v = humanoid(); const sh = v.bones[side + 'UpperArm'].getWorldPosition(new THREE.Vector3());
      const t = sh.clone().add(new THREE.Vector3(side === 'right' ? -0.1 : 0.1, 0, 0.45));
      solveArm(v, side, t, ident, { dt: 1 / 72, now: frame() }); v.scene.updateMatrixWorld(true);
      const fa = v.bones[side + 'Hand'].getWorldPosition(new THREE.Vector3()).sub(v.bones[side + 'LowerArm'].getWorldPosition(new THREE.Vector3())).normalize();
      const ax = v.bones[side + 'Hand'].position.clone().normalize();
      const at = (tw: number) => { solveArm(v, side, t, new THREE.Quaternion().setFromAxisAngle(fa, gripOf(tw) * Math.PI / 180), { dt: 1 / 72, now: frame() }); v.scene.updateMatrixWorld(true); };
      const roll = () => { const q = v.bones[side + 'LowerArm'].quaternion; return 2 * Math.atan2(q.x * ax.x + q.y * ax.y + q.z * ax.z, q.w) * 180 / Math.PI; };
      // SEED at the start, the way the product does at a session start or a tracking regain: a gap in the solves (a
      // one-frame 180° jump there is not a motion). This used to delete the arm state, a reset the product never did
      // (review 10a M1): the stale twist then put a fresh grip on the far branch. `gap` is the product's own rule now.
      const gap = (ms: number) => { clk += ms; };
      const seed = (tw: number) => { gap(1000); at(tw); };
      const twist = () => sg * (v.userData._arm?.[side]?.twist ?? NaN) * 180 / Math.PI;   // supination-positive, both sides
      return { v, at, roll, seed, gap, twist };
    };
    { const { v, seed } = setup(); seed(0); const tw = v.userData._arm?.[side]?.twist;
      // a finite NUMBER, not merely defined: the seed path writes st.twist = null, so `!== undefined` passed on a solver
      // that never reported a twist at all (watched: the mutant stayed green)
      ok(Number.isFinite(tw), `${side}: the solver reports its twist (st.twist is a number) — the rig-mapping guard below has a subject`);
      if (Number.isFinite(tw)) ok(Math.abs(tw * 180 / Math.PI) < 1.5, `${side}: rig mapping as measured (palm-down grip → twist ${(tw * 180 / Math.PI).toFixed(1)}°, want ≈0)`); }
    const sweep = (from: number, to: number) => {
      const { at, roll, seed } = setup(); seed(from);
      let prev = roll(), worst = 0; const dir = Math.sign(to - from);
      for (let tw = from + dir; dir > 0 ? tw <= to : tw >= to; tw += dir) { at(tw); const r = roll(); let j = Math.abs(r - prev); j = Math.min(j, 360 - j); worst = Math.max(worst, j); prev = r; }
      return worst;
    };
    const reported = Math.max(sweep(-100, 185), sweep(185, -100));
    ok(reported < 2.5, `${side}: the reported path, thumb-down/palm-out ↔ palm-up, forearm continuous (worst ${reported.toFixed(2)}°/°)`);
    let worst = 0, worstAt = '';
    for (const s0 of [-100, -45, 0, 45, 90, 135, 190]) for (const end of band) if (end !== s0) {
      const w = sweep(s0, end); if (w > worst) { worst = w; worstAt = `${s0}° → ${end}°`; } }
    ok(worst < 2.5, `${side}: every sweep inside the forearm's range continuous (worst ${worst.toFixed(2)}°/° at ${worstAt})`);
    // 6b. RESEED AFTER A GAP (review 10a M1): palm-up at the end of one session (twist ≈ 200°), then the next session
    //     starts with the grip pronated (−100°) at the same place (no teleport). The twist must land on the NEAR branch.
    {
      const up = (s: ReturnType<typeof setup>) => { s.seed(0); for (let tw = 1; tw <= 200; tw++) s.at(tw); };
      const g = setup(); up(g); const before = g.twist();
      g.gap(500); g.at(-100);                       // 0.5 s without a solve: an exit/entry, an emote, a short loss
      const ref = setup(); ref.seed(-100);          // the same grip, solved from nothing
      ok(Math.abs(before - 200) < 3 && Math.abs(g.twist() + 100) < 3, `${side}: after a 0.5 s gap a pronated grip reseeds on the near branch (twist ${before.toFixed(0)}° → ${g.twist().toFixed(1)}°, want ≈ −100°)`);
      ok(Math.abs(g.roll() - ref.roll()) < 1, `${side}: …and the forearm rolls as a fresh solve does (${g.roll().toFixed(1)}° vs ${ref.roll().toFixed(1)}°)`);
      // controls: the measurement has a subject — with NO gap the unwrap carries the old branch (it's a real 300° swing
      // of the grip in one frame, which the continuity rule reads as −60°); and a dropped frame or two (0.1 s) is no gap
      const c = setup(); up(c); c.at(-100);
      ok(Math.abs(c.twist() + 100) > 90, `${side}: control, no gap: the twist stays on the old branch (${c.twist().toFixed(0)}°)`);
      // (230°: past the middle + 180°, so a reseed there WOULD land on the other branch, −130°: the check has a subject)
      const d = setup(); d.seed(0); for (let tw = 1; tw <= 230; tw++) d.at(tw); d.gap(100); d.at(230);
      ok(Math.abs(d.twist() - 230) < 3, `${side}: control, a 0.1 s hitch keeps the unwrap (230° stays 230°, got ${d.twist().toFixed(1)}°)`);
    }
  }
}

// 5. hold-then-relax: after a solve, losing the grip holds the pose 0.5 s, then eases to the clip; after ~1.5 s it's gone
{
  const v = humanoid(); const sh = v.bones.rightUpperArm.getWorldPosition(new THREE.Vector3());
  const t = sh.clone().add(new THREE.Vector3(-0.1, 0.2, 0.4));
  solveArm(v, 'right', t, ident, { dt: 1 / 72 }); const held = v.bones.rightUpperArm.quaternion.clone();
  const clip = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0, -1.2));   // what the mixer would write each frame
  const frame = () => { v.bones.rightUpperArm.quaternion.copy(clip); v.bones.rightLowerArm.quaternion.identity(); v.bones.rightHand.quaternion.identity(); return relaxArm(v, 'right', 1 / 60); };
  let t0 = 0; for (let i = 0; i < 24; i++) { frame(); t0 += 1 / 60; }   // 0.4 s: inside the hold
  ok(v.bones.rightUpperArm.quaternion.angleTo(held) < 1e-6, 'held for 0.4 s (pose unchanged)');
  for (let i = 0; i < 12; i++) frame();   // 0.6 s: relaxing
  const mid = v.bones.rightUpperArm.quaternion.angleTo(held), toClip = v.bones.rightUpperArm.quaternion.angleTo(clip);
  ok(mid > 0.01 && toClip > 0.01, `relaxing between held and clip at 0.6 s (from held ${mid.toFixed(3)}, to clip ${toClip.toFixed(3)})`);
  let ours = true; for (let i = 0; i < 90; i++) ours = frame();
  ok(!ours && v.bones.rightUpperArm.quaternion.angleTo(clip) < 1e-6, 'released to the clip by 2 s');
}

// 6. the LEG solver runs on the same module (09-19: a scratch vector shared with the old arm solver was deleted with
//    it; solveLeg threw '_pole is not defined' every frame inside feetTick and the whole XR tick died before the
//    arms — one leg straight out, hands not IKing, in the owner's headset). The capsule puppet has legs; plant both feet.
{
  const v: any = makeCapsuleVrm(); v.scene.updateMatrixWorld(true);
  let threw: any = null;
  for (const side of ['left', 'right']) {
    const foot = v.humanoid.getNormalizedBoneNode(side + 'Foot').getWorldPosition(new THREE.Vector3());
    const t = foot.clone(); t.y = 0.08; t.z += 0.12;
    try { solveLeg(v, side, t, 0); } catch (e) { threw = e; }
    v.scene.updateMatrixWorld(true);
    const f2 = v.humanoid.getNormalizedBoneNode(side + 'Foot').getWorldPosition(new THREE.Vector3());
    ok(!threw, `solveLeg ${side} runs (${threw ? String(threw.message).slice(0, 60) : 'no throw'})`);
    ok(!threw && f2.distanceTo(t) < 0.06, `${side} foot near its target (err ${(f2.distanceTo(t) * 100).toFixed(1)} cm)`);
  }
}

// 7. the gait's planted foot follows the GROUND (09-19: a foot planted at a jump's apex kept its airborne y after
//    landing, because the re-plant test was x/z only — 'stuck in the air until you move around a bit')
{
  const L = new THREE.Vector3(0.09, 0.08, 0), R = new THREE.Vector3(-0.09, 0.08, 0);
  const g = gaitInit(L, R, 0); let t = 0; const step = (dl: any, dr: any) => { t += 1 / 60; return gaitTick(g, dl, dr, 0, t, 1 / 60); };
  for (let i = 0; i < 10; i++) step(L, R);
  const up = 0.9; const Lu = L.clone().setY(L.y + up), Ru = R.clone().setY(R.y + up);   // the root rises 0.9 m: targets rise with it, no x/z change
  let o: any; for (let i = 0; i < 10; i++) o = step(Lu, Ru);
  ok(Math.abs(o.L.pos.y - Lu.y) < 1e-6, `foot y follows the root up (${o.L.pos.y.toFixed(3)} vs ${Lu.y.toFixed(3)})`);
  for (let i = 0; i < 10; i++) o = step(L, R);   // landing: targets back on the floor, still no x/z change
  ok(Math.abs(o.L.pos.y - L.y) < 1e-6 && Math.abs(o.R.pos.y - R.y) < 1e-6, `both feet back on the floor after landing without an x/z step (L ${o.L.pos.y.toFixed(3)}, R ${o.R.pos.y.toFixed(3)})`);
  ok(!g.L.step && !g.R.step, 'no step was needed to come down');
}

// 8. A SCALED BODY (review 09-30 B1). vrm.scene wears the chosen size × the VR fit (u/k), so the bones' local offsets
//    are not world lengths; targets are world. Lengths read model-local put the hand up to ~80 cm off the grip at u=2.
//    Reaches are a fraction of THIS body's chain; the leg plants a foot a scaled step ahead.
for (const u of [0.5, 1.5, 2]) {
  const v = humanoid(u); const sh = v.bones.rightUpperArm.getWorldPosition(new THREE.Vector3()), chain = 0.54 * u;
  for (const frac of [0.45, 0.8, 0.95]) {
    const t = sh.clone().add(new THREE.Vector3(-0.4, 0.1, 0.8).normalize().multiplyScalar(chain * frac));
    solveArm(v, 'right', t, ident, { dt: 1 / 72, torso: { ...torsoOf(v), r: 0.12 * u } }); v.scene.updateMatrixWorld(true);
    const err = handAt(v, 'right').distanceTo(t);
    ok(err < 0.02 * u, `scale ${u}, reach ${frac * 100}% of the chain: hand on target (err ${(err * 100).toFixed(1)} cm)`);
  }
  const c: any = makeCapsuleVrm(); c.scene.scale.setScalar(u); c.scene.updateMatrixWorld(true);
  const foot = c.humanoid.getNormalizedBoneNode('leftFoot').getWorldPosition(new THREE.Vector3());
  const t = foot.clone(); t.y += 0.03 * u; t.z += 0.12 * u;
  solveLeg(c, 'left', t, 0); c.scene.updateMatrixWorld(true);
  const err = c.humanoid.getNormalizedBoneNode('leftFoot').getWorldPosition(new THREE.Vector3()).distanceTo(t);
  ok(err < 0.06 * u, `scale ${u}: foot near its target (err ${(err * 100).toFixed(1)} cm)`);
}

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
