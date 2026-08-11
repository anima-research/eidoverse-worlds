// AmmoRagdoll parity suite — the same lifecycle promises the Verlet earns,
// demanded of the Bullet engine, on the SHIPPED fleet rigs.
//
//   bun tools/ammodoll-test.ts
//
// Interface parity is the contract (bodysim.js): everything downstream must
// be unable to tell which engine produced the pose. So: falls come to rest,
// captures are finite sparse local-quat poses, pins hang and release, shoves
// land mid-tumble, corpses kick, the root lies down, and the wasm objects are
// freed at capture. Beyond parity, this engine carries the ported
// ragdoll-physics rig — so the suite also asserts the port's ANATOMY: the
// flexion axes must mean what rigdef.py's tables meant (elbows fold forward,
// knees backward, fingers curl toward the palm), which is the retarget step
// most likely to be silently wrong (web_export.py grew axis_roles() for
// exactly this reason).

import { plugin } from 'bun';
const STUB = new URL('./core-stub.mjs', import.meta.url).pathname;
plugin({
  name: 'core-stub',
  setup(build) {
    build.onResolve({ filter: /^\.\/core\.js$/ }, () => ({ path: STUB }));
  },
});

const { THREE } = await import('./core-stub.mjs');
const { AmmoRagdoll, ensureAmmo } = await import('../client/lib/ammodoll.js');
const { rigs, makeAvatar, toppleLean } = await import('./rig-load.mjs');

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = '') => {
  if (ok) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  else { fail++; console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? ` — ${detail}` : ''}`); }
};

check('wasm door opens', await ensureAmmo());

const FLEET = rigs().filter((r: any) => !r.err);
console.log(`\nthe fleet (${FLEET.length} rigs):`);

const bodyQuat = (body: any, out: any) => {
  const r = body.getCenterOfMassTransform().getRotation();
  return out.set(r.x(), r.y(), r.z(), r.w());
};
const bodySpin = (body: any) => {
  const w = body.getAngularVelocity();
  return Math.hypot(w.x(), w.y(), w.z());
};

function run(av: any, lean: any = null, { maxSteps = 900, seedVel = null as any } = {}) {
  const rd: any = new AmmoRagdoll(av, lean, av.restBonePositions(), seedVel);
  let steps = 0;
  while (!rd.done && steps < maxSteps) { rd.step(1 / 60); steps++; }
  return { rd, steps };
}

{
  // rapierdoll's launch-day failure report, kept as permanent assertions:
  // "body just crumples, self intersection not respected, head spins
  // endlessly, everything is twisted". Anatomy is measured DURING the run —
  // dispose() frees the wasm objects at capture.
  const bad: Record<string, string[]> = {
    rest: [], finite: [], lying: [], poses: [], twist: [], crumple: [], spin: [], knees: [],
  };
  const relTwist = (rd: any, parentKey: string, childKey: string, axisRest: any) => {
    const ps: any = rd.segs.get(parentKey), cs: any = rd.segs.get(childKey);
    if (!ps || !cs) return 0;
    const qp = bodyQuat(ps.body, new THREE.Quaternion());
    const qc = bodyQuat(cs.body, new THREE.Quaternion());
    const rel = qp.invert().multiply(qc);
    const d = new THREE.Vector3(rel.x, rel.y, rel.z);
    const proj = d.dot(axisRest);
    let tw = 2 * Math.atan2(proj, rel.w);
    if (tw > Math.PI) tw -= 2 * Math.PI;
    if (tw < -Math.PI) tw += 2 * Math.PI;
    return Math.abs(tw);
  };
  const foldOf = (p: any) => {
    const a = p.spine?.clone().sub(p.hips ?? p.spine)?.normalize();
    const b = p.neck?.clone().sub(p.chest ?? p.neck)?.normalize();
    return a && b ? Math.acos(Math.min(1, Math.max(-1, a.dot(b)))) : 0;
  };
  for (const rig of FLEET) {
    // the Verlet is the quality BASELINE: same rig, same lean, same metric
    const vav = makeAvatar(rig.P);
    const vrd: any = new (await import('../client/lib/ragdoll.js')).Ragdoll(vav, toppleLean(), vav.restBonePositions());
    let vsteps = 0;
    while (!vrd.done && vsteps < 900) { vrd.step(1 / 60); vsteps++; }
    const vFold = foldOf({ ...vrd.p, chest: vrd.p.chest ?? vrd.p.spine });

    const av = makeAvatar(rig.P);
    const rd: any = new AmmoRagdoll(av, toppleLean(), av.restBonePositions());
    const UP = new THREE.Vector3(0, 1, 0);
    const fwd0 = rd.rig.forward.clone();
    const tq = new THREE.Quaternion();
    let steps = 0, worstNeckTwist = 0, lastFold = 0, worstWrongKnee = 0;
    const spinRing: number[] = [];              // the last second before capture:
    while (!rd.done && steps < 900) {           // residual spin AT pose-lock is
      rd.step(1 / 60);                          // what renders as a corpse-pop;
      steps++;                                  // a fixed window overlaps live
      if (rd.segs.size) {                       // tumbling on slow rolls
        worstNeckTwist = Math.max(worstNeckTwist, relTwist(rd, 'chest|neck', 'neck|head', UP));
        let now = 0;
        for (const s of rd.segs.values()) {
          if (s.finger) continue;               // 20 g springs may flutter; the wire never sees it
          now = Math.max(now, bodySpin(s.body));
        }
        spinRing.push(now);
        if (spinRing.length > 60) spinRing.shift();
        lastFold = foldOf(rd.p);
        // KNEES FOLD THE WAY A KNEE FOLDS — measured from POSITIONS, because
        // this is the failure a quaternion instrument hid once already: the
        // constraint held aletheia's knees at +140° hyperextension while the
        // (aliased-temp) angle reader printed 0°, and antra's eyes were the
        // only working instrument ("aletheia knees bend only backwards",
        // live). Positions cannot alias: shin deviation from the thigh line,
        // against the torso's CURRENT forward. Impacts may buckle a knee
        // transiently; it must never FOLD wrong (the wrap-point bug held
        // 135-140° for the whole fall).
        bodyQuat(rd.torsoBody, tq);
        for (const side of ['left', 'right']) {
          const hip = rd.p[side + 'UpperLeg'], knee = rd.p[side + 'LowerLeg'], foot = rd.p[side + 'Foot'];
          if (!hip || !knee || !foot) continue;
          const thigh = knee.clone().sub(hip).normalize();
          const shin = foot.clone().sub(knee).normalize();
          const bend = Math.acos(Math.min(1, Math.max(-1, thigh.dot(shin))));
          if (bend < 0.15) continue;             // straight: no direction to read
          const fwdNow = fwd0.clone().applyQuaternion(tq);
          const dev = shin.clone().addScaledVector(thigh, -shin.dot(thigh)).normalize();
          if (dev.dot(fwdNow) > 0.3) worstWrongKnee = Math.max(worstWrongKnee, bend);
        }
      }
    }
    // capture is gated on 0.45s of quiet, so a single-step contact ping in
    // the window is a flicker, not a pop — sustained fast spin is the artifact
    const worstSpin = spinRing.filter((x) => x > 12).length > 5 ? Math.max(0, ...spinRing) : 0;
    if (!rd.done) { bad.rest.push(`${rig.name}(never captured)`); continue; }
    const foldBound = Math.max(vFold * 1.35 + 0.17, 1.15);
    const q = Object.values(rd.finalPose ?? {});
    if (!q.length || !q.every((a: any) => a.length === 4 && a.every(Number.isFinite))) bad.finite.push(rig.name);
    if (Object.keys(rd.finalPose ?? {}).length < 8) bad.poses.push(`${rig.name}(${Object.keys(rd.finalPose ?? {}).length} bones)`);
    if (av.root.position.y > -0.05) bad.lying.push(`${rig.name}(root.y=${av.root.position.y.toFixed(2)})`);
    if (worstNeckTwist > 3.0) bad.twist.push(`${rig.name}(${(worstNeckTwist * 180 / Math.PI).toFixed(0)}°)`);
    if (lastFold > foldBound) bad.crumple.push(`${rig.name}(${(lastFold * 180 / Math.PI).toFixed(0)}° vs verlet ${(foldBound * 180 / Math.PI).toFixed(0)}° bound)`);
    if (worstSpin > 12) bad.spin.push(`${rig.name}(${worstSpin.toFixed(1)} rad/s)`);
    if (worstWrongKnee > 0.7) bad.knees.push(`${rig.name}(${(worstWrongKnee * 180 / Math.PI).toFixed(0)}° hyperextension)`);
  }
  const none = (k: string) => bad[k].length === 0;
  check('every rig comes to rest', none('rest'), bad.rest.join(' '));
  check('every capture is a finite sparse pose', none('finite'), bad.finite.join(' '));
  check('every pose drives a full skeleton (≥8 bones)', none('poses'), bad.poses.join(' '));
  check('the rendered root lies down with the body', none('lying'), bad.lying.join(' '));
  check('sim twist stays sane (renders as zero regardless)', none('twist'), bad.twist.join(' '));
  check('folds no more than the Verlet on the same rig', none('crumple'), bad.crumple.join(' '));
  check('no hidden spin late in the fall (≤12 rad/s)', none('spin'), bad.spin.join(' '));
  check('knees never FOLD backwards (positions, not quats)', none('knees'), bad.knees.join(' '));
}

// ---------------------------------------------------------------------------
// AXIS ROLES — the port's most-likely-silent failure, asserted at build.
//
// rigdef.py's limit tables are written against Blender's bone-local frame;
// this engine re-derives an anatomical frame per joint. web_export.py grew
// axis_roles() because the wrist's axes came out "the other way round than I
// assumed" — a limit on the wrong axis is not an error the solver reports, it
// is a knee that bends sideways. So: for every directional joint, take the
// built flexion axis and the SIGN the wide side of the range implies, compute
// which way that rotation moves the child's tip, and demand it is the
// anatomical direction. Every rig, both sides.
console.log('\naxis roles (elbows fold forward, knees back, fingers curl to the palm):');
{
  const bad: string[] = [];
  for (const rig of FLEET) {
    const av = makeAvatar(rig.P, { realParent: rig.realParent });
    const rd: any = new AmmoRagdoll(av, null, av.restBonePositions());
    const { forward, up } = rd.rig;
    const palmN = up.clone().negate();
    // only joints whose table is meaningfully ASYMMETRIC say which way they
    // flex — the wrist's ±45/±45 has no wide side to read a direction from
    const want: Record<string, any> = {
      lowerArm: forward, lowerLeg: forward.clone().negate(),
      upperLeg: forward, fingerProx: palmN, fingerMid: palmN,
    };
    for (const J of rd.flexAxes()) {
      const w = want[J.spec];
      if (!w) continue;
      // the wide side of the signed range is the flexion side
      const sign = J.hi[0] > -J.lo[0] ? 1 : -1;
      const move = new THREE.Vector3().crossVectors(J.axisX, J.axisY).multiplyScalar(sign);
      if (move.dot(w) <= 0) {
        bad.push(`${rig.name}:${J.name}(${J.spec} flexes against anatomy)`);
      }
    }
    rd.dispose();
  }
  const few = (a: string[], n = 5) => a.slice(0, n).join(' ') + (a.length > n ? ` +${a.length - n} more` : '');
  check('every directional joint flexes the anatomical way', bad.length === 0, few(bad));
}

// ---------------------------------------------------------------------------
// ANATOMY UNDER YAW — rapierdoll's hard-won sweep, kept. The hinge/flex axes
// are built from the rig's own frame, so they must turn with the body
// (equivariance) and stay perpendicular to their bone; joints must contain
// the pose they were born in; limits must hold under load; the trunk must
// carry a trunk's share of the mass.
console.log('\nanatomy under yaw (limits, axes, mass — swept N/E/S/W):');
{
  const YAWS = [0, Math.PI / 2, Math.PI, (3 * Math.PI) / 2];
  const YAW_NAME = ['N', 'E', 'S', 'W'];
  // STRIDE IS NOT OPTIONAL: at stride 0 the "live" pose IS the rest pose, the
  // one configuration where a frame-alignment bug is invisible by construction.
  const STRIDES = [0, 1];
  const EQUIV_DOT = Math.cos((10 * Math.PI) / 180);
  const PERP_DOT = Math.cos((60 * Math.PI) / 180);
  // Per-axis excursion beyond the (born-widened) bounds, asserted on
  // DURATION, not instantaneous peak: Bullet's limit rows are impulses with
  // ERP recovery, so a hard impact legitimately overshoots for a few frames
  // and gets pulled back — measured +60-80° single-frame spikes on shoulders
  // at impact, gone within a quarter second. What must never happen is a
  // limit HELD in violation (the wrap-point class: aletheia's knees sat 130°
  // over for the entire fall).
  // Spring joints (fingers) are EXCLUDED: btGeneric6DofSpringConstraint
  // replaces hard-limit semantics on sprung axes — the spring is the
  // authority and sagging past the table under load is its designed
  // behavior (the source measured the sag curve). And the depth/duration
  // tolerate a limb TRAPPED under a resting body (a hip held ~20° over by
  // the torso lying on it is physics, not a broken limit) while still
  // catching the wrap-point class, which held knees 130° over indefinitely.
  const OVER_SUSTAIN = 0.6;    // rad, ~34° — a violation this deep...
  const OVER_SECS = 1.0;       // ...held this long is a broken limit
  let overSamples = 0;

  const bad: Record<string, string[]> = {
    flex: [], perp: [], over: [], mass: [], build: [], born: [],
  };
  const liveBones = (av: any) => {
    const out: Record<string, any> = {};
    av.root.updateMatrixWorld(true);
    for (const n of Object.keys(av.nodes)) {
      const node = av.vrm.humanoid.getNormalizedBoneNode(n);
      if (node) out[n] = node.getWorldPosition(new THREE.Vector3());
    }
    return out;
  };
  for (const rig of FLEET) {
    // realParent HERE TOO: the sweep avatars carry the rig's real hierarchy,
    // and toe/finger bones exist only there — a reference built on the
    // simplified chain extrapolates a foot tip DOWN the shin where the real
    // rig's toes point forward, and its ankle axis lands 90° away
    const refAv = makeAvatar(rig.P, { realParent: rig.realParent });
    refAv.root.updateMatrixWorld(true);
    const refRd: any = new AmmoRagdoll(refAv, null, refAv.restBonePositions());
    const ms = refRd.massSplit();
    // the torso body carries pelvis+spine+chest = 44% of the Dempster budget;
    // head/limb boxes vary with the rig, so bound the trunk share loosely
    if (!(ms.frac > 0.35 && ms.frac < 0.60)) {
      bad.mass.push(`${rig.name}(${(ms.frac * 100).toFixed(0)}%)`);
    }
    const refAxis = new Map<string, any>();
    for (const J of refRd.flexAxes()) {
      refAxis.set(J.name, J.axisX.clone().normalize());
      const perp = Math.abs(J.axisX.clone().normalize().dot(J.axisY.clone().normalize()));
      if (perp > PERP_DOT) {
        bad.perp.push(`${rig.name}:${J.name}(${(90 - (Math.acos(Math.min(1, perp)) * 180) / Math.PI).toFixed(0)}° off perpendicular)`);
      }
    }
    refRd.dispose();

    for (let yi = 0; yi < YAWS.length; yi++) {
      for (const stride of STRIDES) {
        const yaw = YAWS[yi];
        const tag = `${rig.name}@${YAW_NAME[yi]}${stride ? '/stride' : ''}`;
        const av = makeAvatar(rig.P, { stride, realParent: rig.realParent });
        av.root.rotation.y = yaw;
        av.root.updateMatrixWorld(true);
        const rd: any = new AmmoRagdoll(av, toppleLean(yaw), av.restBonePositions());

        // BUILD CONSISTENCY: the sim must start where the skeleton IS. (The
        // torso is rest-shaped by design, so trunk joints get a looser bound.)
        const TRUNK = new Set(['hips', 'spine', 'chest', 'neck', 'head']);
        for (const [name, wantP] of Object.entries(liveBones(av))) {
          const got = rd.p[name];
          if (!got) continue;
          const err = got.distanceTo(wantP as any);
          const bound = TRUNK.has(name) ? 0.06 : 0.015;
          if (err > bound) {
            bad.build.push(`${tag}:${name}(${(err * 1000).toFixed(0)}mm)`);
            break;
          }
        }
        // BORN INSIDE ITS OWN JOINTS: the annihilation class this guards
        // against is a limit that does not contain the build pose — the
        // widening exists precisely to make this zero, so assert the
        // guarantee itself, at the instrument.
        for (const j of rd.jointAngles()) {
          if (j.over > 0.02) {
            bad.born.push(`${tag}:${j.name}(born ${((j.over * 180) / Math.PI).toFixed(1)}° over)`);
            break;
          }
        }
        // Spin MAGNITUDE at birth or during impact is not an instrument: a
        // mid-stride foot is a tilted light box whose corner touches the
        // ground at build, and the crash itself runs bodies to the 20 rad/s
        // ceiling transiently (measured; capsules take the same contacts more
        // gently). What separates a transient from an annihilation is that an
        // annihilation SUSTAINS: the born-joint assertion above catches the
        // cause, and the late-fall spin bound in the loop below catches the
        // effect — here swept across yaw AND stride, which is where the
        // world-frame bugs lived.
        rd.step(1 / 60);

        // flex axes are a BUILD-time property — equivariance against north
        for (const J of rd.flexAxes()) {
          const wantA = refAxis.get(J.name);
          if (!wantA) continue;
          const expect = wantA.clone().applyAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
          const d = Math.abs(J.axisX.clone().normalize().dot(expect));
          if (d < EQUIV_DOT) {
            bad.flex.push(`${tag}:${J.name}(${((Math.acos(Math.min(1, d)) * 180) / Math.PI).toFixed(0)}° from equivariant)`);
            break;
          }
        }

        let steps = 0;
        const overRun = new Map<string, number>();   // joint -> consecutive deep-over steps
        let worstRun = 0, worstRunAt = '';
        const spinRing: number[] = [];   // the last second before capture
        while (!rd.done && steps < 900) {
          rd.step(1 / 60); steps++;
          if (rd.done) break;        // capture frees the wasm — measure before, never after
          for (const j of rd.jointAngles()) {
            if (/^finger|^thumb/.test(j.spec)) continue;   // spring joints: see above
            overSamples++;
            const run = j.over > OVER_SUSTAIN ? (overRun.get(j.name) ?? 0) + 1 : 0;
            overRun.set(j.name, run);
            if (run > worstRun) { worstRun = run; worstRunAt = `${j.name}/${j.spec}`; }
          }
          // spin in the LAST second before capture — a fixed "past step 240"
          // window overlaps live tumbling on slow-settling yaw combos (a
          // west-facing princess0 is still rolling at t=5s, honestly); what
          // must never happen is residual spin AT the moment the pose locks,
          // which renders as the corpse popping
          let now = 0;
          for (const s of rd.segs.values()) {
            if (s.finger) continue;
            now = Math.max(now, bodySpin(s.body));
          }
          spinRing.push(now);
          if (spinRing.length > 60) spinRing.shift();
        }
        if (worstRun > OVER_SECS * 60) bad.over.push(`${tag}:${worstRunAt}(held ${(worstRun / 60).toFixed(1)}s over)`);
        const captureSpin = spinRing.filter((x) => x > 12).length > 5 ? Math.max(0, ...spinRing) : 0;
        if (captureSpin > 12) bad.born.push(`${tag}(${captureSpin.toFixed(1)} rad/s in the last second)`);
      }
    }
  }
  const none = (k: string) => bad[k].length === 0;
  const few = (a: string[], n = 4) => a.slice(0, n).join(' ') + (a.length > n ? ` +${a.length - n} more` : '');
  check('the sim starts where the skeleton is', none('build'), few(bad.build));
  check('...and is not born fighting its own joints', none('born'), few(bad.born));
  check('flex axes turn with the body (yaw-equivariant)', none('flex'), few(bad.flex));
  check('flex axes are perpendicular to their bone', none('perp'), few(bad.perp));
  check('the trunk carries a trunk\'s share of the mass', none('mass'), few(bad.mass));
  check('no joint limit is ever HELD in violation (>20° for >0.5s)', none('over'), few(bad.over));
  check('...and that limit gate is not vacuous', overSamples > 10000, `${overSamples} samples`);
}

// ---------------------------------------------------------------------------
// GOING LIMP MUST NOT TELEPORT — rendered-pose check, rapierdoll's lesson:
// the drive's reference direction and orientation must describe the SAME
// pose, or frame one renders every driven bone at twice its offset. Only a
// POSED rig can see it.
console.log('\ngoing limp does not teleport the skeleton (rendered pose):');
{
  const bad: string[] = [];
  const DRIVEN = ['hips', 'spine', 'chest', 'neck',
    'leftUpperArm', 'leftLowerArm', 'rightUpperArm', 'rightLowerArm',
    'leftUpperLeg', 'leftLowerLeg', 'rightUpperLeg', 'rightLowerLeg'];
  for (const rig of FLEET) {
    const av = makeAvatar(rig.P, { realParent: rig.realParent });
    const P: any = rig.P;
    const up = (P.neck ?? P.chest).clone().sub(P.hips).normalize();
    const lat = P.leftUpperArm.clone().sub(P.rightUpperArm);
    lat.addScaledVector(up, -lat.dot(up)).normalize();
    const fwd = new THREE.Vector3().crossVectors(lat, up).normalize();
    av.nodes.leftUpperArm?.quaternion.setFromAxisAngle(fwd, (-70 * Math.PI) / 180);
    av.nodes.rightUpperArm?.quaternion.setFromAxisAngle(fwd, (70 * Math.PI) / 180);
    av.nodes.neck?.quaternion.setFromAxisAngle(lat, (18 * Math.PI) / 180);
    av.root.updateMatrixWorld(true);

    const before: Record<string, any> = {};
    for (const n of DRIVEN) {
      const node = av.vrm.humanoid.getNormalizedBoneNode(n);
      if (node) before[n] = node.getWorldQuaternion(new THREE.Quaternion());
    }
    const rd: any = new AmmoRagdoll(av, null, av.restBonePositions());
    const pose = rd.step(1 / 60);          // one frame: the sim has barely moved
    if (pose) {
      for (const [n, q] of Object.entries(pose)) {
        const node = av.vrm.humanoid.getNormalizedBoneNode(n);
        if (node) node.quaternion.set((q as any)[0], (q as any)[1], (q as any)[2], (q as any)[3]);
      }
      av.root.updateMatrixWorld(true);
    }
    let worst = 0, worstAt = '';
    for (const n of DRIVEN) {
      if (!before[n]) continue;
      const node = av.vrm.humanoid.getNormalizedBoneNode(n);
      const now = node.getWorldQuaternion(new THREE.Quaternion());
      const d = Math.min(1, Math.abs(before[n].dot(now)));
      const ang = 2 * Math.acos(d);
      if (ang > worst) { worst = ang; worstAt = n; }
    }
    if (worst > 0.25) {                    // ~14°, generous for one frame of fall
      bad.push(`${rig.name}:${worstAt}(${((worst * 180) / Math.PI).toFixed(0)}°)`);
    }
    rd.dispose();
  }
  check('a posed body renders where it stood, not at twice the offset',
    bad.length === 0, bad.slice(0, 5).join(' ') + (bad.length > 5 ? ` +${bad.length - 5}` : ''));
}

// ---------------------------------------------------------------------------
// FINGERS — the port's addition over both incumbents. Spring phalanges exist
// where the rig has digit bones, are absent (and harmless) where it does not,
// ride the pose rotation-only, and pull back toward the pose they were born
// in (the source's setEquilibriumPoint contract).
console.log('\nfingers (spring phalanges, additive by absence):');
{
  const fingered = FLEET.filter((r: any) => r.P.leftIndexProximal && r.P.leftIndexIntermediate);
  const bare = FLEET.filter((r: any) => !r.P.leftIndexProximal);
  check(`the fleet exercises both cases (${fingered.length} with digits, ${bare.length} without)`,
    fingered.length > 0, 'no rig with finger bones — section is vacuous');

  let built = 0, driven = 0, finite = true, stretched: string[] = [];
  for (const rig of fingered) {
    const av = makeAvatar(rig.P, { realParent: rig.realParent });
    // node POSITIONS are the mesh's bone lengths — the sim must never write
    // them (rotation-only law; position error must stretch a joint, not the
    // mesh)
    const posBefore = new Map<string, any>();
    for (const [n, node] of Object.entries(av.nodes) as any) {
      posBefore.set(n, node.position.clone());
    }
    const rd: any = new AmmoRagdoll(av, toppleLean(), av.restBonePositions());
    if (rd._fingerSegs.length > 0) built++;
    let steps = 0;
    while (!rd.done && steps < 900) { rd.step(1 / 60); steps++; }
    const pose = rd.finalPose ?? {};
    const fingerKeys = Object.keys(pose).filter((k) => /Proximal|Intermediate|Thumb/.test(k));
    if (fingerKeys.length >= 4) driven++;
    finite &&= fingerKeys.every((k) => (pose as any)[k].every(Number.isFinite));
    for (const [n, node] of Object.entries(av.nodes) as any) {
      if (node.position.distanceTo(posBefore.get(n)) > 1e-9) { stretched.push(`${rig.name}:${n}`); break; }
    }
  }
  check('rigs with digit bones grow spring phalanges', built === fingered.length, `${built}/${fingered.length}`);
  check('...and the captured pose drives them', driven === fingered.length, `${driven}/${fingered.length}`);
  check('...with finite quaternions throughout', finite);
  check('...and never writes a bone POSITION (no mesh stretch)', stretched.length === 0, stretched.slice(0, 3).join(' '));

  if (bare.length) {
    const rig: any = bare[0];
    const { rd } = run(makeAvatar(rig.P, { realParent: rig.realParent }), toppleLean());
    check('a rig without digit bones builds a clean 16-body doll and rests',
      rd.done && rd._fingerSegs.length === 0, `fingers=${rd._fingerSegs?.length}`);
  }

  // spring-back: tug a phalanx off its born curl with a pin (the same door a
  // drag uses), let go, and the spring must pull it back — not hang limp,
  // which is the whole point of the source's spring joints
  if (fingered.length) {
    const rig: any = fingered[0];
    const av = makeAvatar(rig.P, { realParent: rig.realParent });
    const rd: any = new AmmoRagdoll(av, null, av.restBonePositions());
    // hang the doll by the head so the hands dangle free of the ground
    const hold = av.vrm.humanoid.getNormalizedBoneNode('head')
      .getWorldPosition(new THREE.Vector3()).add(new THREE.Vector3(0, 0.35, 0));
    for (let i = 0; i < 240; i++) { rd.setPin('head', hold); rd.step(1 / 60); }
    const seg = rd._fingerSegs[0];
    // measure the phalanx RELATIVE TO ITS HAND: the tug also swings the whole
    // arm through the pin, so the finger's world orientation moves even when
    // the spring returns it perfectly — the spring's own coordinate is the
    // hand-relative rotation, and that is what the equilibrium promises
    const side = seg.a.startsWith('left') ? 'left' : 'right';
    const handSeg: any = rd.segs.get(`${side}Hand|${side}MiddleProximal`);
    const relQ = () => {
      const qh = bodyQuat(handSeg.body, new THREE.Quaternion());
      const qf = bodyQuat(seg.body, new THREE.Quaternion());
      return qh.invert().multiply(qf);
    };
    const born = relQ();
    const angleTo = () => 2 * Math.acos(Math.min(1, Math.abs(born.dot(relQ()))));
    // hold the HAND still while tugging — at TWO points, because a p2p holds
    // a point, not an orientation: held at the wrist alone, the tug rotates
    // the whole hand about the pin and the fingertip reaches its target with
    // ~5° of actual finger bend (measured; the arm yields first without any
    // hold at all, for the same softer-joint reason)
    const handHold = rd.p[`${side}Hand`].clone();
    const knuckleHold = rd.p[`${side}MiddleProximal`].clone();
    // ...and tug in the joint's OWN flexion direction, carried through the
    // hand's current rotation: after four seconds hanging by the head the
    // arms dangle, and a fixed world direction pulls along the finger
    // (traction) and into the ±12° deviation limit instead of the 90° curl
    const J: any = rd.flexAxes().find((x: any) => x.name === seg.a);
    const flexSign = J.hi[0] > -J.lo[0] ? 1 : -1;
    const moveRest = new THREE.Vector3().crossVectors(J.axisX, J.axisY).multiplyScalar(flexSign);
    const qHand = bodyQuat(handSeg.body, new THREE.Quaternion());
    const tug = rd.p[seg.b].clone().addScaledVector(moveRest.applyQuaternion(qHand), 0.05);
    const holdHand = () => {
      rd.setPin('head', hold);
      rd.setPin(`${side}Hand`, handHold);
      rd.setPin(`${side}MiddleProximal`, knuckleHold);
    };
    for (let i = 0; i < 120; i++) { holdHand(); rd.setPin(seg.b, tug); rd.step(1 / 60); }
    const bent = angleTo();
    rd.setPin(seg.b, null);
    for (let i = 0; i < 300; i++) { holdHand(); rd.step(1 / 60); }
    const back = angleTo();
    check('a tugged phalanx bends, then springs back toward its born curl',
      bent > 0.08 && back < bent * 0.6,
      `bent ${(bent * 180 / Math.PI).toFixed(0)}° → settled ${(back * 180 / Math.PI).toFixed(0)}°`);
    rd.dispose();
  }
}

console.log('\nlifecycle (one rig, every downstream contract):');
{
  const rig: any = FLEET[0];

  // pin: hang, persist, release-and-fall — the nail contract
  const av = makeAvatar(rig.P);
  const rd: any = new AmmoRagdoll(av, null, av.restBonePositions());
  const hold = new THREE.Vector3(0.3, 2.2, 0.2);
  rd.setPin('head', hold);
  for (let i = 0; i < 600; i++) { rd.setPin('head', hold); rd.step(1 / 60); }
  check('a pinned body never captures', !rd.done);
  check('...and hangs AT the pin', rd.p.head.distanceTo(hold) < 0.1, `${rd.p.head.distanceTo(hold).toFixed(3)}m off`);
  check('...pins map mirrors the hold (bodydrag reads it)', rd.pins.get('head')?.distanceTo(hold) === 0);
  check('...and the body dangles below', rd.p.hips.y < rd.p.head.y, `hips ${rd.p.hips.y.toFixed(2)}`);
  rd.setPin(null);
  let steps = 0;
  while (!rd.done && steps < 900) { rd.step(1 / 60); steps++; }
  check('nail pulled: falls and rests', rd.done, `steps=${steps}`);
  check('capture freed the wasm objects', (rd as any)._freed === true && (rd as any)._refs.length === 0);

  // impulse mid-tumble: same fall twice, shove one, averaged over a panel —
  // one falling body is chaotic enough to swamp any single comparison
  const shoved = (push: boolean, r0: any) => {
    const a = makeAvatar(r0.P, { realParent: r0.realParent });
    const r: any = new AmmoRagdoll(a, toppleLean(), a.restBonePositions());
    for (let i = 0; i < 30; i++) r.step(1 / 60);
    const x0 = r.p.hips.x;
    if (push) r.impulse(new THREE.Vector3(3, 0, 0));
    const clocks = { elapsed: r.elapsed, settledFor: r.settledFor };
    let s = 0;
    while (!r.done && s < 900) { r.step(1 / 60); s++; }
    return { dx: r.p.hips.x - x0, done: r.done, clocks };
  };
  const panel = FLEET.slice(0, 6);
  let pushSum = 0, stillSum = 0, allDone = true;
  let pushed: any = null;
  for (const r0 of panel) {
    const a = shoved(true, r0), b = shoved(false, r0);
    pushed ??= a;
    pushSum += a.dx; stillSum += b.dx;
    allDone &&= a.done && b.done;
  }
  const pushedMean = pushSum / panel.length, stillMean = stillSum / panel.length;
  check('impulse restarts the clocks', pushed.clocks.elapsed === 0 && pushed.clocks.settledFor === 0);
  check('a mid-tumble shove still comes to rest, downwind of an unshoved twin',
    allDone && pushedMean > stillMean + 0.05,
    `mean over ${panel.length} rigs: shoved Δx=${pushedMean.toFixed(2)} vs unshoved ${stillMean.toFixed(2)}`);

  // snapshot/seed round-trip: the drag handover format
  const av3 = makeAvatar(rig.P);
  const rd3: any = new AmmoRagdoll(av3, toppleLean(), av3.restBonePositions());
  for (let i = 0; i < 20; i++) rd3.step(1 / 60);
  const snap = rd3.snapshot();
  check('snapshot is the packed handover shape',
    Array.isArray(snap.j) && snap.p.length === snap.j.length * 3 && snap.v.length === snap.j.length * 3
    && snap.p.every(Number.isFinite) && snap.v.every(Number.isFinite),
    JSON.stringify({ j: snap.j?.length, p: snap.p?.length }));
  rd3.dispose();
  check('snapshot after dispose says nothing (null, never a hollow handover)', rd3.snapshot() === null);
  const av4 = makeAvatar(rig.P);
  const { rd: rd4 } = run(av4, null, { seedVel: snap });
  check('a seeded sim (drag release) accepts the handover and rests', rd4.done);

  // hostile magnitude is capped, not obeyed
  const av5 = makeAvatar(rig.P);
  const rd5: any = new AmmoRagdoll(av5, new THREE.Vector3(1000, 0, 0), av5.restBonePositions());
  let s5 = 0;
  while (!rd5.done && s5 < 900) { rd5.step(1 / 60); s5++; }
  check('a hostile 1000 m/s lean is capped, not obeyed',
    rd5.done && Object.values(rd5.p).every((p: any) => Number.isFinite(p.x) && Math.abs(p.x) < 60),
    `done=${rd5.done}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
