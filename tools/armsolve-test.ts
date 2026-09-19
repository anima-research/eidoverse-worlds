// armsolve-test — the swivel arm solver (xrbody.js solveArm/relaxArm, Basis's BasisArmSolveCore port) on a
// synthetic humanoid. What this proves, node-side, before a headset does: the hand lands on the grip (soft
// reach at the end, never a pop); the elbow angle is CONTINUOUS across a wide sweep (no flip — the old pole
// solver flipped at its singularity); the elbow stays outside the torso capsule when the hand crosses the
// body; the wrist twist is split (forearm rolls, hand takes the remainder — grip orientation still exact);
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
const { solveArm, relaxArm, solveLeg } = await import("../client/lib/xrbody.js");
const { makeCapsuleVrm } = await import("../client/lib/capsulebody.js");

let pass = 0, fail = 0;
const ok = (c: boolean, m: string) => { if (c) pass++; else { fail++; console.log("  FAIL", m); } };

// a VRM-shaped humanoid: hips→spine→chest→upperChest→neck→head; shoulders off upperChest; arms along ±X
function humanoid() {
  const mk = (name: string, x: number, y: number, z: number, parent?: any) => { const o = new THREE.Object3D(); o.name = name; o.position.set(x, y, z); parent?.add(o); return o; };
  const scene = new THREE.Object3D();
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
//    arms — one leg straight out, hands not IKing, in R's headset). The capsule puppet has legs; plant both feet.
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

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
