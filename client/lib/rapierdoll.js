// rapierdoll — the articulated body engine. Same interface as Ragdoll
// (client/lib/ragdoll.js), different physics underneath: rigid segments with
// rotational inertia, fleet-measured joint limits, real contacts, and joint
// MOTORS — muscle tone, a body going limp rather than a power cut.
//
// Interface parity is the whole contract: constructor(avatar, lean, rest,
// seedVel), step(dt) → sparse local-quat pose (and it drives the avatar
// directly), impulse(v), setPin(joint, target)/setPin(null), .pins/.pinned/
// .done/.finalPose/.p/.maxV, snapshot(), dispose(). Everything downstream —
// drag, nails, corpse-kicks, the presence stream, headless agents — cannot
// tell which engine produced the pose.
//
// ---------------------------------------------------------------------------
// THE REST FRAME IS THE JOINT FRAME. Read this before changing anything here.
//
// The first build of this engine was written against the belief that "rapier's
// JS spherical joints have neither motors nor limits (probed)". That is true
// of the TYPED WRAPPER only — SphericalImpulseJoint and GenericImpulseJoint
// extend ImpulseJoint, not UnitImpulseJoint, so they carry no setLimits or
// configureMotor. The engine underneath has both, per axis, and the raw handle
// is public: `world.impulseJoints.raw.jointSetLimits(h, axis, min, max)` and
// `...jointConfigureMotorPosition(h, axis, target, stiffness, damping)`.
// Measured on 0.19.3: a generic joint given a 0.3 rad limit holds its swing at
// exactly 0.3 rad where the unlimited control reaches 0.375.
//
// So every joint bound is now IN THE SOLVER. The previous build enforced cones
// and twist with torque impulses applied after world.step(), which is a spring
// outside the integrator — unconditionally able to pump. It was held down with
// angular damping of 6 (the validated spike used 0.7), and the result was a
// body that could not swing, could not roll, folded 172° through a 40° cone,
// and twisted 165° through a 45° one. All of that machinery is gone.
//
// The one structural rule that makes it work: `JointData.generic(a1, a2, axis,
// mask)` takes ONE axis vector and uses it as the local axis of BOTH bodies.
// That is only meaningful if the two bodies' local frames agree. So every
// rigid body here is built REST-ALIGNED: its orientation is the rotation that
// carries its own rest configuration to its live one, which is IDENTITY at
// rest. Consequences, all of them load-bearing:
//
//   • at rest every body's frame coincides, so one `axis` vector means the
//     same thing to parent and child — the 90°/180° shoulder and hip frame
//     misalignment that produced "everything is twisted" cannot be expressed;
//   • the joint's zero is the REST pose, so limits are anatomy and motors can
//     target 0 with no restRel bookkeeping at all;
//   • a joint axis is a vector in rest coordinates, which come from the rig
//     (restBonePositions carries the avatar's yaw) — so axes turn with the
//     body for free. The old hinge axes were literal world constants and went
//     degenerate at east/west facing on 9 of the 14 shipped rigs.
//
// The capsule geometry is carried by the COLLIDER's local rotation (= the
// bone's rest frame), not the body's, which is what buys the free frame.
// ---------------------------------------------------------------------------

import { THREE } from './core.js';
import { heightAt } from './terrain.js';
import { colliders, nearColliders } from './colliders.js';

// loaded lazily by bodysim.js — a WASM module has an async init, and the
// Ragdoll interface is synchronous, so readiness is a precondition
let RAPIER = null;
export async function ensureRapier() {
  if (RAPIER) return true;
  try {
    const mod = await import('@dimforge/rapier3d-compat');
    RAPIER = mod.default ?? mod;
    await RAPIER.init();
    return true;
  } catch (e) {
    console.error('[rapierdoll] wasm init failed — verlet stays', e);
    return false;
  }
}
export const rapierReady = () => !!RAPIER;

// Raw per-axis joint API (see header). These indices are RawJointAxis, which
// the compat build does not re-export by name.
const AX_ANG_X = 3, AX_ANG_Y = 4, AX_ANG_Z = 5;

// The body cut mirrors the Verlet's CHAINS.
const SEGMENTS = [
  ['hips', 'spine'], ['spine', 'chest'], ['chest', 'neck'], ['neck', 'head'],
  ['leftUpperArm', 'leftLowerArm'], ['leftLowerArm', 'leftHand'],
  ['rightUpperArm', 'rightLowerArm'], ['rightLowerArm', 'rightHand'],
  ['leftUpperLeg', 'leftLowerLeg'], ['leftLowerLeg', 'leftFoot'],
  ['rightUpperLeg', 'rightLowerLeg'], ['rightLowerLeg', 'rightFoot'],
];

// The torso's SOLID, beyond the spine line. Without these the trunk is a pole:
// measured on mythos, shoulders attach 0.138 m off a 0.041 m-wide spine
// capsule and hips 0.053 m off, so arms and legs swung through empty space
// where a chest and a pelvis should be. That is "self intersection not
// respected" — it was never a collision-group bug, there was simply nothing
// there to hit. Two bars, left attachment to right attachment, which is also
// what the Verlet braces. Colliders on the torso body, not new segments: they
// add volume and mass without adding a joint.
const TORSO_BARS = [
  { a: 'leftUpperArm', b: 'rightUpperArm', frac: 0.80 },
  { a: 'leftUpperLeg', b: 'rightUpperLeg', frac: 0.85 },
];

// `cone` is the PER-AXIS swing bound on each of the two non-twist axes; the
// square's diagonal reaches √2·cone (see the ball branch for why that is the
// right trade). `twist` bounds rotation about the bone.
const JOINTS_DEF = [
  { at: 'spine', parent: 'hips', child: 'spine', kind: 'ball', cone: 0.44, twist: 0.26 },
  { at: 'chest', parent: 'spine', child: 'chest', kind: 'ball', cone: 0.35, twist: 0.26 },
  { at: 'neck', parent: 'chest', child: 'neck', kind: 'ball', cone: 0.70, twist: 0.70 },
  // 1.20, not the Verlet's 1.48: rapier's per-axis angular limits are an
  // Euler-like decomposition, and a limit set AT 85° sits on the 90°
  // degeneracy, where it stops holding — measured 143° of shoulder swing
  // against a 120° bound across the fleet. 69° per axis is well conditioned
  // and the square's diagonal still reaches 97°. Range lost to conditioning is
  // bought back by BUILD_WIDEN below, which is what actually has to hold.
  { at: 'leftUpperArm', parent: 'chest', child: 'leftUpperArm', kind: 'ball', cone: 1.20, twist: 0.79 },
  { at: 'rightUpperArm', parent: 'chest', child: 'rightUpperArm', kind: 'ball', cone: 1.20, twist: 0.79 },
  { at: 'leftLowerArm', parent: 'leftUpperArm', child: 'leftLowerArm', kind: 'elbow' },
  { at: 'rightLowerArm', parent: 'rightUpperArm', child: 'rightLowerArm', kind: 'elbow' },
  { at: 'leftUpperLeg', parent: 'hips', child: 'leftUpperLeg', kind: 'ball', cone: 0.96, twist: 0.52 },
  { at: 'rightUpperLeg', parent: 'hips', child: 'rightUpperLeg', kind: 'ball', cone: 0.96, twist: 0.52 },
  { at: 'leftLowerLeg', parent: 'leftUpperLeg', child: 'leftLowerLeg', kind: 'knee' },
  { at: 'rightLowerLeg', parent: 'rightUpperLeg', child: 'rightLowerLeg', kind: 'knee' },
];
const BAR_INSET = 0.18;          // pull each torso bar in from its attachment points
const BUILD_WIDEN = 0.12;        // slack over the born pose when it exceeds anatomy
const HINGE_FLEX = 2.6;          // how far a knee or elbow folds
const HINGE_SLACK = 0.09;        // and how far it may go the wrong way
const RADIUS_FRAC = {
  'hips|spine': 1.0, 'spine|chest': 0.95, 'chest|neck': 1.0, 'neck|head': 0.6,
  'leftUpperArm|leftLowerArm': 0.5, 'leftLowerArm|leftHand': 0.35,
  'rightUpperArm|rightLowerArm': 0.5, 'rightLowerArm|rightHand': 0.35,
  'leftUpperLeg|leftLowerLeg': 0.62, 'leftLowerLeg|leftFoot': 0.45,
  'rightUpperLeg|rightLowerLeg': 0.62, 'rightLowerLeg|rightFoot': 0.45,
};

const FIXED_DT = 1 / 60;
const MAX_FRAMES = 8;            // a hitch drops its backlog, never simulates a second at once
const SOLVER_ITERS = 16;         // stock is 4; a 14-body articulated chain wants more
const SETTLE_V = 0.07;
const SETTLE_W = 0.6;            // rad/s — a body still turning is not settled
const SETTLE_TIME = 0.45;
const DEADLINE = 8;
const TONE0 = 14;                // motor stiffness, N·m/rad, at the moment of going limp
const TONE_DAMP = 1.2;
const TONE_DECAY = 0.80;         // per 0.1 s — tone is under 1% of TONE0 by ~2 s
const TONE_FLOOR = 0.05;
// Angular damping is now just damping, not a stability budget: the limits it
// used to be compensating for are inside the solver. The spike validated 0.7.
const ANG_DAMP = 0.7;
const ANG_DAMP_TORSO = 1.0;
const LIN_DAMP = 0.15;
const ANG_CEIL = 20;             // rad/s, a backstop and nothing more

const _q = new THREE.Quaternion();
const _qp = new THREE.Quaternion();
const _v = new THREE.Vector3();
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();

/** A DETERMINISTIC frame for a bone direction — never setFromUnitVectors.
 *  That helper is singular for antiparallel inputs (legs point DOWN, the
 *  reference is UP): THREE picks an arbitrary 180° axis, differently per
 *  call, and a rest pose assembled from two arbitrary choices told muscle
 *  tone that "rest" was a body folded into itself. Watched live: the whole
 *  skeleton scrunching into a ball. Frame: Y = bone, X ⟂ via world Z (world
 *  X fallback) — continuous everywhere a humanoid bone can point. */
function frameQuat(dir, out = new THREE.Quaternion()) {
  const y = dir.clone().normalize();
  const ref = Math.abs(y.z) < 0.9 ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(1, 0, 0);
  const x = new THREE.Vector3().crossVectors(ref, y).normalize();
  const z = new THREE.Vector3().crossVectors(x, y);
  return out.setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, z));
}

/** Shortest-arc rotation from one unit vector to another, with the
 *  antiparallel case answered rather than guessed. THREE's setFromUnitVectors
 *  picks an arbitrary perpendicular when the inputs oppose — fine for a one-off
 *  render, poison for a rest frame that has to mean the same thing twice. */
// dedicated temps: callers pass the shared _a/_b in, so this must not use them
const _sa1 = new THREE.Vector3();
const _sa2 = new THREE.Vector3();
const _sa3 = new THREE.Vector3();
function shortestArc(from, to, out = new THREE.Quaternion()) {
  const f = _sa1.copy(from).normalize();
  const t = _sa2.copy(to).normalize();
  const d = f.dot(t);
  if (d > 0.999999) return out.set(0, 0, 0, 1);
  if (d < -0.999999) {
    // 180°: any perpendicular axis is correct, so pick one DETERMINISTICALLY
    _sa3.set(Math.abs(f.x) < 0.9 ? 1 : 0, Math.abs(f.x) < 0.9 ? 0 : 1, 0);
    _sa3.crossVectors(f, _sa3).normalize();
    return out.setFromAxisAngle(_sa3, Math.PI);
  }
  _sa3.crossVectors(f, t);
  out.set(_sa3.x, _sa3.y, _sa3.z, 1 + d);
  return out.normalize();
}

/** Deviation from rest between two bodies' frames, SPLIT into swing and twist
 *  about the joint's own axis. Rest-aligned bodies make the relative rotation
 *  the deviation directly, with no reference rotation to cancel.
 *
 *  The split matters: swing and twist are independent axes with independent
 *  limits, so widening one by the other's excursion loosens a bound nothing
 *  asked for. Widening TWIST by the total gave an arm born 70° down from its
 *  bind pose — pure swing, no twist at all — an 82° twist limit in place of
 *  the anatomical 45°, on every joint of every rig that goes limp off-bind. */
function relSwingTwist(pb, cb, axis) {
  const rp = pb.rotation(), rc = cb.rotation();
  const qP = new THREE.Quaternion(rp.x, rp.y, rp.z, rp.w);
  const qC = new THREE.Quaternion(rc.x, rc.y, rc.z, rc.w);
  const rel = qP.invert().multiply(qC);
  if (rel.w < 0) { rel.x *= -1; rel.y *= -1; rel.z *= -1; rel.w *= -1; }
  const proj = new THREE.Vector3(rel.x, rel.y, rel.z).dot(axis);
  const twistQ = new THREE.Quaternion(
    axis.x * proj, axis.y * proj, axis.z * proj, rel.w).normalize();
  const swingQ = rel.clone().multiply(twistQ.clone().invert());
  let twist = 2 * Math.atan2(proj, rel.w);
  if (twist > Math.PI) twist -= 2 * Math.PI;
  if (twist < -Math.PI) twist += 2 * Math.PI;
  return {
    swing: 2 * Math.acos(Math.min(1, Math.abs(swingQ.w))),
    twist: Math.abs(twist),
  };
}

export class RapierRagdoll {
  constructor(avatar, lean = null, rest = null, seedVel = null) {
    this.avatar = avatar;
    this.done = false;
    this.pose = null;
    this.finalPose = null;
    this.pins = new Map();          // joint -> THREE.Vector3 (world) — bodydrag reads this
    this._pinBodies = new Map();    // joint -> { marker, joint, at }
    this.settledFor = 0;
    this.elapsed = 0;
    this.acc = 0;
    this.maxV = Infinity;
    this.maxW = Infinity;
    this.p = {};                    // joint -> world pos (debug + parity surface)

    const h = avatar.vrm.humanoid;
    avatar.root.updateMatrixWorld(true);

    // live capture (where the body IS) + neutral rest (what limits mean)
    const live = {};
    for (const j of new Set(SEGMENTS.flat())) {
      const n = h?.getNormalizedBoneNode?.(j);
      if (n) live[j] = n.getWorldPosition(new THREE.Vector3());
    }
    if (!live.chest && live.spine && live.neck) {
      live.chest = live.spine.clone().add(live.neck).multiplyScalar(0.5);
    }
    // inherited motion (a drag release carrying the hand's sim state): the
    // packed form also carries POSITIONS — the hand's truth outranks the
    // skeleton's current frame. Velocities land on segments after build.
    const seedV = {};
    if (seedVel?.j) {
      const { j: names, p: pos, v: vel, dy = 0 } = seedVel;
      for (let i = 0; i < names.length; i++) {
        const n = names[i], k = i * 3;
        if (live[n]) live[n].set(pos[k], pos[k + 1] + dy, pos[k + 2]);
        seedV[n] = new THREE.Vector3(vel[k], vel[k + 1], vel[k + 2]);
      }
    } else if (seedVel) {
      for (const j of Object.keys(live)) {
        const v = seedVel.get?.(j) ?? seedVel[j];
        if (v) seedV[j] = new THREE.Vector3(v.x, v.y, v.z);
      }
    }
    const restP = {};
    const restSrc = rest ?? avatar.restBonePositions?.() ?? live;
    for (const [j, v] of Object.entries(restSrc)) {
      restP[j] = v.clone ? v.clone() : new THREE.Vector3(v.x, v.y, v.z);
    }
    if (!restP.chest && restP.spine && restP.neck) {
      restP.chest = restP.spine.clone().add(restP.neck).multiplyScalar(0.5);
    }
    this.restP = restP;

    // ---- the RIG FRAME: up / lateral / forward, from the rest skeleton ------
    // Every joint axis below is expressed in these terms and never in world
    // constants. restBonePositions() carries the avatar's yaw, so this frame
    // turns with the body and the axes turn with it.
    const rigUp = (restP.neck ?? restP.chest ?? restP.spine).clone().sub(restP.hips).normalize();
    let rigLat = restP.leftUpperArm && restP.rightUpperArm
      ? restP.leftUpperArm.clone().sub(restP.rightUpperArm)
      : (restP.leftUpperLeg && restP.rightUpperLeg
        ? restP.leftUpperLeg.clone().sub(restP.rightUpperLeg)
        : new THREE.Vector3(1, 0, 0));
    rigLat.addScaledVector(rigUp, -rigLat.dot(rigUp));           // orthogonalise
    if (rigLat.lengthSq() < 1e-9) rigLat.set(1, 0, 0);
    rigLat.normalize();
    const rigFwd = new THREE.Vector3().crossVectors(rigLat, rigUp).normalize();
    this.rig = { up: rigUp, lateral: rigLat, forward: rigFwd };

    // ---- the drive table: REFERENCE DIRECTION AND REFERENCE ORIENTATION MUST
    // ---- BE THE SAME POSE. This pairing was the "arms go to the other side".
    //
    // The rendered world quaternion is  swing(refDir → simDir) · refQuat.  For
    // that to be the identity map at t=0 — a body that goes limp must not
    // teleport — refDir has to be the direction the bone points in the pose
    // refQuat describes. It was taking refDir from the BIND pose (restP) and
    // refQuat from the LIVE skeleton, so at t=0 the multiplier was not identity
    // but the entire bind→live animation rotation, applied on top of a refQuat
    // that already contained it. Every driven bone rendered at twice its offset
    // from the bind pose the instant R was pressed: arms held 70° down from a
    // T-pose bind snapped to 140°, and an idle's head tilt doubled likewise.
    //
    // setLimp() parks only the NON-driven bones (avatar.js:386) — the driven
    // ones keep their animated rotation — so the live pose is exactly where
    // this bites, and the headless suite could never see it: makeAvatar gives
    // every bone identity, making bind == live, the one pose where the wrong
    // pairing and the right one agree. The Verlet does the same job correctly
    // by dividing the rest frame back out (`restFrameInv`, ragdoll.js), which
    // is why it "sort of works" where this did not.
    //
    // Both references are now taken from the live skeleton at build.
    this.drive = [];
    for (const [bone, child] of SEGMENTS) {
      const bn = h?.getNormalizedBoneNode?.(bone);
      const cn = h?.getNormalizedBoneNode?.(child);
      if (!bn || !cn || !live[bone] || !live[child]) continue;
      const refDir = live[child].clone().sub(live[bone]);
      if (refDir.lengthSq() < 1e-8) continue;
      this.drive.push({
        bone, child, node: bn, parent: bn.parent,
        restDir: refDir.normalize(),
        restQuat: bn.getWorldQuaternion(new THREE.Quaternion()),
      });
    }

    // ---- the physics world: local flat ground + nearby furniture ----------
    this.world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
    this.world.timestep = FIXED_DT;
    this.world.numSolverIterations = SOLVER_ITERS;
    const hips = live.hips ?? avatar.root.position;
    this.groundY = heightAt(hips.x, hips.z);
    this.world.createCollider(
      RAPIER.ColliderDesc.cuboid(60, 0.5, 60)
        .setTranslation(hips.x, this.groundY - 0.5, hips.z).setFriction(0.85),
    );
    // grid-bounded (§14.2 6a): this was a full-map scan with a hand-rolled
    // 8m filter — the same 8m the grid answers directly
    for (const [, c] of nearColliders(hips.x, hips.z, 8)) {
      const obj = c.obj;
      if (!obj || c.interior || !c.box) continue;
      if (Math.hypot(obj.position.x - hips.x, obj.position.z - hips.z) > 8) continue;
      // scale applies to the CENTRE OFFSET as well as the size, and the
      // object's rotation is part of where its box is — dropping either put
      // bodies through furniture they could see. Matches colliders.js's own
      // world-placement law (localCentre * scale, rotated, + position).
      const sc = obj.scale ?? { x: 1, y: 1, z: 1 };
      const size = c.box.getSize(new THREE.Vector3()).multiply(_v.set(sc.x, sc.y, sc.z));
      const centre = c.box.getCenter(new THREE.Vector3())
        .multiply(_v.set(sc.x, sc.y, sc.z))
        .applyQuaternion(obj.quaternion ?? new THREE.Quaternion())
        .add(obj.position);
      const cd = RAPIER.ColliderDesc.cuboid(
        Math.max(size.x / 2, 0.02), Math.max(size.y / 2, 0.02), Math.max(size.z / 2, 0.02),
      ).setTranslation(centre.x, centre.y, centre.z).setFriction(0.8);
      const oq = obj.quaternion;
      if (oq) cd.setRotation({ x: oq.x, y: oq.y, z: oq.z, w: oq.w });
      this.world.createCollider(cd);
    }

    // ---- segments as capsules, REST-ALIGNED (see header) -------------------
    const span = live.leftUpperArm && live.rightUpperArm
      ? live.leftUpperArm.distanceTo(live.rightUpperArm) : 0.3;
    const torsoR = Math.max(0.05, span * 0.22);
    this.segs = new Map();
    const bodyOf = new Map();
    const segList = [];

    // The TORSO IS ONE RIGID BODY. The spine and chest joints could not be
    // defended: a fold forms at impact faster than any limit responds, then
    // ground friction pins it — measured 142° of swing against a 25° cone.
    // Real ragdolls are built this way for this reason; the looseness READS in
    // the head and limbs, which keep their joints.
    const TORSO = new Set(['hips|spine', 'spine|chest', 'chest|neck']);
    // chest is synthesized from spine+neck, so a rig missing BOTH leaves it
    // unsynthesizable — and dereferencing it threw, which bodysim.js would
    // have swallowed into a silent verlet fallback. Walk up whatever the rig
    // does have instead.
    const upperOf = (m) => m.chest ?? m.neck ?? m.spine ?? m.head;
    const restUpper = upperOf(restP), liveUpper = upperOf(live);
    if (!restUpper || !liveUpper || !restP.hips || !live.hips) {
      throw new Error('rapierdoll: rig has no usable torso chain');
    }
    const restTorsoDir = restUpper.clone().sub(restP.hips);
    const liveTorsoDir = liveUpper.clone().sub(live.hips);
    const torsoQ = shortestArc(restTorsoDir, liveTorsoDir, new THREE.Quaternion());
    const topOf = (m) => m.neck ?? m.chest ?? m.spine ?? m.head;
    const restTorsoMid = restP.hips.clone().add(topOf(restP)).multiplyScalar(0.5);
    const liveTorsoMid = live.hips.clone().add(topOf(live)).multiplyScalar(0.5);
    const torsoBody = this.world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(liveTorsoMid.x, liveTorsoMid.y, liveTorsoMid.z)
        .setRotation({ x: torsoQ.x, y: torsoQ.y, z: torsoQ.z, w: torsoQ.w })
        .setLinearDamping(LIN_DAMP).setAngularDamping(ANG_DAMP_TORSO),
    );
    this.torsoBody = torsoBody;

    /** Attach a capsule to `body` so that AT REST it spans ra→rb. Local
     *  rotation is the bone's rest frame; local translation is the rest
     *  midpoint relative to the body's rest origin. Body orientation stays
     *  free to be the rest→live rotation, which is what makes joint frames
     *  agree. */
    const addCapsule = (body, bodyRestOrigin, ra, rb, radius) => {
      const dir = rb.clone().sub(ra);
      const len = Math.max(dir.length(), 0.04);
      const mid = ra.clone().add(rb).multiplyScalar(0.5);
      const localQ = frameQuat(dir);
      const localT = mid.clone().sub(bodyRestOrigin);
      const desc = RAPIER.ColliderDesc
        .capsule(Math.max(0.01, len / 2 - radius * 0.5), radius)
        .setTranslation(localT.x, localT.y, localT.z)
        .setRotation({ x: localQ.x, y: localQ.y, z: localQ.z, w: localQ.w })
        .setFriction(0.8).setRestitution(0.03).setDensity(1000);
      return this.world.createCollider(desc, body);
    };

    // ---- body orientations, DOWN THE CHAIN, not one at a time ---------------
    // A shortest arc is twist-free about its own axis, so composing two of them
    // independently leaves a spurious roll BETWEEN them: measured up to 45° of
    // rotation on a hinge's LOCKED axes at build (shoulder 45° down + elbow
    // flexed 90°), which the solver then annihilates in one step. Roll is not
    // observable from bone positions — the Verlet has the same blind spot and
    // never drives twist either — so the consistent choice is to give the chain
    // ZERO relative roll by construction: each child's orientation is its
    // parent's, times the shortest arc taken IN THE PARENT'S FRAME.
    //
    //   qChild · restDir = qParent · shortestArc(restDir, qParent⁻¹·liveDir)
    //                                 · restDir  =  liveDir           ✓
    //
    // so the direction is still exact, and the relative rotation a joint sees
    // is a pure swing about an axis perpendicular to the bone — which is what
    // its locked axes and its twist bound both assume.
    const parentSegKey = new Map();
    for (const J of JOINTS_DEF) {
      const cKey = SEGMENTS.find((s) => s[0] === J.child);
      const pKey = SEGMENTS.find((s) => s[0] === J.parent);
      if (cKey && pKey) parentSegKey.set(cKey.join('|'), pKey.join('|'));
    }
    const bodyQuat = new Map();
    const quatOf = (key, seen = new Set()) => {
      if (bodyQuat.has(key)) return bodyQuat.get(key);
      if (TORSO.has(key)) { bodyQuat.set(key, torsoQ); return torsoQ; }
      if (seen.has(key)) return torsoQ;                 // cycle guard
      seen.add(key);
      const [a, b] = key.split('|');
      if (!live[a] || !live[b] || !restP[a] || !restP[b]) return torsoQ;
      const pk = parentSegKey.get(key);
      const qParent = pk ? quatOf(pk, seen) : torsoQ;
      const liveLocal = live[b].clone().sub(live[a]).applyQuaternion(qParent.clone().invert());
      const q = qParent.clone().multiply(
        shortestArc(restP[b].clone().sub(restP[a]), liveLocal, new THREE.Quaternion()));
      bodyQuat.set(key, q);
      return q;
    };

    for (const [a, b] of SEGMENTS) {
      if (!live[a] || !live[b] || !restP[a] || !restP[b]) continue;
      const key = `${a}|${b}`;
      const ra = restP[a], rb = restP[b];
      const restLen = Math.max(ra.distanceTo(rb), 0.04);
      const isTorso = TORSO.has(key);
      // The len*0.45 clamp let the SHORTEST trunk bone set the trunk's width:
      // hips|spine is 0.047 m on fox_adventurer, so the pelvis capsule came
      // out 0.019 m thick against a 0.050 m target. Trunk pieces are volume,
      // not sticks — they keep their anatomical radius.
      const frac = RADIUS_FRAC[key] ?? 0.5;
      const r = isTorso ? torsoR * frac * 0.9
        : Math.min(torsoR * frac, restLen * 0.45) * 0.9;

      let body, collider, localA, localB;
      if (isTorso) {
        body = torsoBody;
        collider = addCapsule(body, restTorsoMid, ra, rb, r);
        localA = ra.clone().sub(restTorsoMid);
        localB = rb.clone().sub(restTorsoMid);
      } else {
        const restMid = ra.clone().add(rb).multiplyScalar(0.5);
        const liveMid = live[a].clone().add(live[b]).multiplyScalar(0.5);
        const qB = quatOf(key);
        body = this.world.createRigidBody(
          RAPIER.RigidBodyDesc.dynamic()
            .setTranslation(liveMid.x, liveMid.y, liveMid.z)
            .setRotation({ x: qB.x, y: qB.y, z: qB.z, w: qB.w })
            .setLinearDamping(LIN_DAMP).setAngularDamping(ANG_DAMP),
        );
        collider = addCapsule(body, restMid, ra, rb, r);
        localA = ra.clone().sub(restMid);
        localB = rb.clone().sub(restMid);
      }
      const seg = {
        body, collider, localA, localB, r, a, b,
        restA: ra.clone(), restB: rb.clone(),
        idx: segList.length, torso: isTorso,
      };
      this.segs.set(key, seg);
      segList.push(seg);
      bodyOf.set(a, body);
    }

    // A TORSO BONE ALWAYS MEANS THE TORSO BODY. bodyOf is populated from each
    // segment's START bone, so 'chest' only got mapped if the chest|neck
    // segment survived — and VRM makes `neck` optional. On a rig without one,
    // chest|neck and neck|head both drop out, 'chest' goes unmapped, and every
    // joint hanging off it (BOTH shoulders, and the head) is silently skipped:
    // the arms and head become free rigid bodies that tumble away on the first
    // impulse. Detaching a limb is never the right answer to a missing bone.
    for (const name of ['hips', 'spine', 'chest']) {
      if (live[name] && !bodyOf.has(name)) bodyOf.set(name, torsoBody);
    }

    // ---- the torso's solid: shoulder bar and pelvis bar --------------------
    // The bars must be able to HIT the limbs they hold apart. Two things stop
    // that if you build them naively, and both were happening:
    //
    //  • adjacent() excludes pairs by BONE NAME, and a bar spanning
    //    leftUpperArm→rightUpperArm shares a name with each upper arm — so the
    //    shoulder bar was excluded from both arms and the pelvis bar from both
    //    legs, i.e. from exactly the four pairs the bars exist for. They only
    //    ever blocked the far limbs. Synthetic endpoint names fix that: let
    //    GEOMETRY decide, not nomenclature.
    //  • the limb capsules START at the bar's endpoints, so at rest they
    //    overlap it and the rest-overlap test would exclude them anyway (and
    //    rightly — a permanently-overlapping pair injects contact energy every
    //    frame). So the bar is INSET at both ends: it stops short of the
    //    attachment points, leaving real clearance for the limb to be outside
    //    it at rest and be stopped by it when it swings inward.
    for (const bar of TORSO_BARS) {
      const ra0 = restP[bar.a], rb0 = restP[bar.b];
      if (!ra0 || !rb0 || ra0.distanceTo(rb0) < 1e-4) continue;
      const r = torsoR * bar.frac * 0.9;
      const inset = Math.min(BAR_INSET, 0.35);
      const ra = ra0.clone().lerp(rb0, inset);
      const rb = rb0.clone().lerp(ra0, inset);
      const collider = addCapsule(torsoBody, restTorsoMid, ra, rb, r);
      const seg = {
        body: torsoBody, collider, r, a: `bar:${bar.a}`, b: `bar:${bar.b}`,
        localA: ra.clone().sub(restTorsoMid), localB: rb.clone().sub(restTorsoMid),
        restA: ra.clone(), restB: rb.clone(),
        idx: segList.length, torso: true, bar: true,
      };
      segList.push(seg);          // gets a collision-group bit; NOT in this.segs
    }

    // ---- self-collision, the Verlet's law ported to collision groups ------
    // Rest-overlapping pairs never collide; same-body pairs are moot; the rest
    // may touch. Membership in the high half, filter in the low half, bit 15
    // reserved so statics (groups 0xFFFFFFFF) stay hittable — which caps us at
    // 15 colliders. 12 segments + 2 bars = 14. Adding a third bar needs a
    // different encoding, not a bigger shift.
    {
      const segd = (p1, q1, p2, q2) => {
        const d1 = q1.clone().sub(p1), d2 = q2.clone().sub(p2), rr = p1.clone().sub(p2);
        const A = d1.dot(d1), E = d2.dot(d2), F = d2.dot(rr);
        let s3 = 0, t3 = 0;
        if (A > 1e-9 || E > 1e-9) {
          if (A < 1e-9) { t3 = Math.min(1, Math.max(0, F / E)); }
          else {
            const C = d1.dot(rr);
            if (E < 1e-9) s3 = Math.min(1, Math.max(0, -C / A));
            else {
              const B = d1.dot(d2), den = A * E - B * B;
              s3 = den > 1e-9 ? Math.min(1, Math.max(0, (B * F - C * E) / den)) : 0;
              t3 = (B * s3 + F) / E;
              if (t3 < 0) { t3 = 0; s3 = Math.min(1, Math.max(0, -C / A)); }
              else if (t3 > 1) { t3 = 1; s3 = Math.min(1, Math.max(0, (B - C) / A)); }
            }
          }
        }
        return p1.clone().addScaledVector(d1, s3).sub(p2.clone().addScaledVector(d2, t3)).length();
      };
      const adjacent = (x, y) => x.body === y.body
        || x.a === y.a || x.a === y.b || x.b === y.a || x.b === y.b;
      const filters = segList.map(() => 0);
      for (let i = 0; i < segList.length; i++) {
        for (let j = i + 1; j < segList.length; j++) {
          const A2 = segList[i], B2 = segList[j];
          if (adjacent(A2, B2)) continue;
          // rest endpoints travel ON the segment: the bars carry synthetic
          // bone names so adjacency cannot blanket-exclude them, and a
          // name-keyed lookup would simply miss and silently skip the pair
          const pa1 = A2.restA, pb1 = A2.restB, pa2 = B2.restA, pb2b = B2.restB;
          if (!pa1 || !pb1 || !pa2 || !pb2b) continue;
          // Exclude only pairs that are DEEPLY inside each other at rest, not
          // every pair that merely touches. The bars are trunk VOLUME and the
          // limbs attach at their ends, so at rest they always graze — a
          // touch-level test therefore excluded the bar from precisely the
          // limbs it exists to stop, and the trunk went back to being a pole.
          // A grazing pair resting in contact is fine; a pair buried in each
          // other pumps contact energy every frame, and that is what this is
          // for. Deep is measured against the shallower capsule.
          const sum = A2.r + B2.r;
          const bar = A2.bar || B2.bar;
          const deep = bar ? Math.min(A2.r, B2.r) * 0.9 : sum * 1.05;
          if (segd(pa1, pb1, pa2, pb2b) < deep) continue;
          filters[i] |= (1 << B2.idx);
          filters[j] |= (1 << A2.idx);
        }
      }
      if (segList.length > 15) console.warn('[rapierdoll] >15 colliders — group encoding overflows');
      for (const seg of segList) {
        seg.collider.setCollisionGroups(((1 << seg.idx) << 16) | filters[seg.idx] | 0x8000);
      }
    }

    // ---- joints: every bound IN THE SOLVER --------------------------------
    // Anchors are body-LOCAL. At rest a body's frame is the world frame and
    // its origin is its rest midpoint, so a rest world point maps in by simple
    // subtraction — no quaternion, and nothing to get backwards.
    // ONE world point, mapped into each body through that body's ACTUAL
    // build-time transform. This is zero initial constraint error by
    // construction, whatever the frames are — which matters because the torso
    // is rest-SHAPED (a rigid trunk cannot reproduce a bent live spine), so its
    // idea of where the shoulder is and the arm's idea are not the same point.
    // Deriving each anchor from its own body's rest geometry instead put up to
    // 115 mm between them on a twisted trunk, and the solver answered that
    // error with an impulse: peak angular velocity pinned at the 20 rad/s
    // ceiling within six frames. Anchors are POSITION; the rest-aligned frames
    // above are ORIENTATION. They are independent, and only the second one
    // needs the rest pose.
    const localAnchor = (body, worldPos) => {
      const t = body.translation(), rq = body.rotation();
      return worldPos.clone().sub(new THREE.Vector3(t.x, t.y, t.z))
        .applyQuaternion(new THREE.Quaternion(rq.x, rq.y, rq.z, rq.w).invert());
    };
    const segByParentBone = new Map();
    for (const s of this.segs.values()) segByParentBone.set(s.a, s);

    this.balls = [];
    this.hinges = [];
    this.jointHandles = [];        // every joint that carries a motor
    const raw = this.world.impulseJoints.raw;
    const M = RAPIER.JointAxesMask;

    for (const J of JOINTS_DEF) {
      // any trunk bone means the trunk, even one the rig never defined
      const TRUNK_BONES = new Set(['hips', 'spine', 'chest']);
      const resolve = (n) => bodyOf.get(n) ?? (TRUNK_BONES.has(n) ? torsoBody : undefined);
      const pb = resolve(J.parent), cb = resolve(J.child);
      // A skipped joint is a DETACHED body part, which is the loudest possible
      // physics failure and used to happen in total silence.
      if (!pb || !cb || !restP[J.at] || !live[J.at]) {
        if (pb !== cb) {
          this.skipped = (this.skipped ?? []);
          this.skipped.push(J.at);
          console.warn(`[rapierdoll] no joint at ${J.at} — ${J.child} is unattached`);
        }
        continue;
      }
      if (pb === cb) continue;                    // torso-internal: rigid now
      const ps = segByParentBone.get(J.parent), cs = segByParentBone.get(J.child);
      if (!ps || !cs) continue;
      const a1 = localAnchor(pb, live[J.at]);
      const a2 = localAnchor(cb, live[J.at]);
      const childDir = restP[cs.b].clone().sub(restP[cs.a]).normalize();

      if (J.kind === 'ball') {
        // Twist about the bone, swing on the other two.
        //
        // The cone is the PER-AXIS bound, not the bound on the total. Two
        // independent per-axis limits describe a SQUARE in (y,z) angle space,
        // not a disc: setting each to cone/√2 makes the corner reach `cone` but
        // caps a pure single-axis swing — which is what "arm hangs at the
        // side" actually is — at 0.707·cone. Measured: the shoulder's 84.8°
        // became an effective 60.0°, and an avatar going limp from any ordinary
        // A-pose (arms 65-80° down from a T-pose rest) was therefore built
        // OUTSIDE its own shoulder limit. The solver annihilated that in one
        // step: 15 m/s of linear velocity and angular velocity pinned at the
        // ANG_CEIL clamp, on frame one. The square's diagonal reaching √2·cone
        // is the honest cost of the axis-aligned limits rapier gives us, and a
        // shoulder is mobile enough to spend it; a limit too TIGHT to hold the
        // rest pose is not.
        const jd = RAPIER.JointData.generic(a1, a2, childDir, M.LinX | M.LinY | M.LinZ);
        const joint = this.world.createImpulseJoint(jd, pb, cb, true);
        joint.setContactsEnabled(false);
        // A JOINT MUST CONTAIN THE POSE IT WAS BORN IN. Anatomy is a floor,
        // not a ceiling: a rig whose bind pose is a T-pose, going limp from an
        // arms-down idle, presents ~85° of shoulder swing at build. Declaring
        // a tighter cone than that does not make the arm anatomical, it makes
        // the solver annihilate the difference on frame one (measured: 15 m/s
        // and the angular ceiling, instantly). So widen to admit the build
        // pose, and let tone pull it back toward rest instead.
        // ...each axis widened by ITS OWN excursion, never by the other's.
        const born = relSwingTwist(pb, cb, childDir);
        const cone = Math.max(J.cone, born.swing + BUILD_WIDEN);
        const twist = Math.max(J.twist, born.twist + BUILD_WIDEN);
        raw.jointSetLimits(joint.handle, AX_ANG_X, -twist, twist);
        raw.jointSetLimits(joint.handle, AX_ANG_Y, -cone, cone);
        raw.jointSetLimits(joint.handle, AX_ANG_Z, -cone, cone);
        this.jointHandles.push({ handle: joint.handle, axes: [AX_ANG_X, AX_ANG_Y, AX_ANG_Z] });
        this.balls.push({
          name: J.at, pb, cb, cone, twist, axisL: childDir.clone(),
          declaredCone: J.cone, declaredTwist: J.twist,
          bornSwing: born.swing, bornTwist: born.twist,
        });
      } else {
        // A hinge axis is a RIG quantity. cross(bone, forward) is the flexion
        // axis for a T-pose arm (vertical) and an A-pose arm or a leg
        // (lateral) alike, because it is defined against the body's own
        // facing rather than against north.
        const boneDir = restP[J.child].clone().sub(restP[J.parent]).normalize();
        let axis = new THREE.Vector3().crossVectors(boneDir, rigFwd);
        if (axis.lengthSq() < 1e-6) axis.copy(rigLat);            // bone ∥ forward
        axis.normalize();
        // Which way does it FOLD? A knee takes the foot backward, an elbow
        // takes the hand forward. Rotating the distal segment by +θ about the
        // axis moves its tip along (axis × dir), so the sign of that against
        // the wanted direction picks the range. Derived, never assumed — the
        // two sides of the body mirror and a hard-coded sign is wrong on one.
        const want = J.kind === 'knee' ? rigFwd.clone().negate() : rigFwd.clone();
        const move = new THREE.Vector3().crossVectors(axis, childDir);
        const positiveFolds = move.dot(want) > 0;
        const lo = positiveFolds ? -HINGE_SLACK : -HINGE_FLEX;
        const hi = positiveFolds ? HINGE_FLEX : HINGE_SLACK;
        const jd = RAPIER.JointData.generic(
          a1, a2, axis, M.LinX | M.LinY | M.LinZ | M.AngY | M.AngZ);
        const joint = this.world.createImpulseJoint(jd, pb, cb, true);
        joint.setContactsEnabled(false);
        raw.jointSetLimits(joint.handle, AX_ANG_X, lo, hi);
        this.jointHandles.push({ handle: joint.handle, axes: [AX_ANG_X] });
        this.hinges.push({
          name: J.at, kind: J.kind, axisWorld: axis.clone(), boneDir: boneDir.clone(),
          limits: [lo, hi], pb, cb,
        });
      }
    }

    this.tone = TONE0;
    this._toneAcc = 0;
    this._setTone(this.tone);

    // ---- inherited velocities: recover the SPIN, not just the drift --------
    // snapshot() encodes each endpoint as v + ω × r precisely so a tumbling
    // body can hand over its tumble. Averaging endpoint velocities throws the
    // differential away and keeps only the translation, so a body swung and
    // released stopped rotating the instant it was let go. And the torso owns
    // three segments, so a per-segment setLinvel overwrote the trunk twice —
    // it ended up with whatever `chest|neck` happened to compute, not a blend.
    // Group samples by BODY, then invert the encoding:
    //     ω = (d × Δv) / |d|²   from the most separated endpoint pair
    //     v_com = v₁ − ω × (p₁ − com)
    {
      const samples = new Map();          // body -> [{ p, v }]
      for (const s of this.segs.values()) {
        for (const name of [s.a, s.b]) {
          if (!seedV[name] || !live[name]) continue;
          if (!samples.has(s.body)) samples.set(s.body, []);
          const list = samples.get(s.body);
          if (list.some((x) => x.name === name)) continue;
          list.push({ name, p: live[name].clone(), v: seedV[name].clone() });
        }
      }
      for (const [body, list] of samples) {
        if (!list.length) continue;
        const com = body.worldCom();
        const comV = new THREE.Vector3(com.x, com.y, com.z);
        let w = new THREE.Vector3();
        if (list.length >= 2) {
          let best = null, bestD = 0;
          for (let i = 0; i < list.length; i++) {
            for (let j = i + 1; j < list.length; j++) {
              const d = list[i].p.distanceToSquared(list[j].p);
              if (d > bestD) { bestD = d; best = [list[i], list[j]]; }
            }
          }
          if (best && bestD > 1e-8) {
            const d = best[1].p.clone().sub(best[0].p);
            const dv = best[1].v.clone().sub(best[0].v);
            w = new THREE.Vector3().crossVectors(d, dv).divideScalar(bestD);
            const m = w.length();
            if (m > ANG_CEIL) w.multiplyScalar(ANG_CEIL / m);      // hostile input
          }
        }
        const s0 = list[0];
        const vc = s0.v.clone().sub(
          new THREE.Vector3().crossVectors(w, s0.p.clone().sub(comV)));
        if (Number.isFinite(vc.x) && Number.isFinite(vc.y) && Number.isFinite(vc.z)) {
          body.setLinvel({ x: vc.x, y: vc.y, z: vc.z }, true);
        }
        if (Number.isFinite(w.x) && Number.isFinite(w.y) && Number.isFinite(w.z)) {
          body.setAngvel({ x: w.x, y: w.y, z: w.z }, true);
        }
      }
    }

    // root follow, exactly the Verlet's law
    this.rootStartY = avatar.root.position.y;
    this._rootBaseY = avatar.root.position.y;

    if (lean) this._topple(lean);
    this._syncP();
    // measured against the sim's OWN hips, not the skeleton's. The torso is
    // rest-shaped, so a bent live spine reconstructs p.hips a few mm away from
    // live.hips — and step() drives the root from p.hips, so taking the offset
    // from live.hips made the root jump by exactly that difference on frame one.
    this.hipsOffset = (this.p.hips?.y ?? live.hips?.y ?? 0) - avatar.root.position.y;
  }

  /** Muscle tone: every free axis of every joint gets a position motor toward
   *  0 — which IS the rest pose, because the bodies are rest-aligned. In the
   *  solver, so it cannot pump; decaying to a floor, so limp is a process. */
  _setTone(s) {
    const raw = this.world.impulseJoints.raw;
    for (const j of this.jointHandles) {
      for (const ax of j.axes) {
        raw.jointConfigureMotorPosition(j.handle, ax, 0, s, TONE_DAMP);
      }
    }
  }

  /** INSTRUMENT (not used by the sim): live swing/twist per ball joint against
   *  the anatomy that is supposed to bound them, plus the hinge axes as built.
   *  The parity suite asserts on this. It exists because the suite was 19/19
   *  green while the body visibly folded in half: metrics that only ever ask
   *  "is it finite / did it settle" cannot see an anatomy failure.
   *
   *  Rest-aligned bodies make this cheap — the relative rotation IS the
   *  deviation from rest, with no restRel to cancel out. */
  jointAngles() {
    const out = [];
    for (const B of this.balls) {
      const rp = B.pb.rotation(), rc = B.cb.rotation();
      const qP = new THREE.Quaternion(rp.x, rp.y, rp.z, rp.w);
      const qC = new THREE.Quaternion(rc.x, rc.y, rc.z, rc.w);
      const rel = qP.clone().invert().multiply(qC);
      if (rel.w < 0) { rel.x *= -1; rel.y *= -1; rel.z *= -1; rel.w *= -1; }
      const proj = new THREE.Vector3(rel.x, rel.y, rel.z).dot(B.axisL);
      const twistQ = new THREE.Quaternion(
        B.axisL.x * proj, B.axisL.y * proj, B.axisL.z * proj, rel.w).normalize();
      const swingQ = rel.clone().multiply(twistQ.clone().invert());
      let twist = 2 * Math.atan2(proj, rel.w);
      if (twist > Math.PI) twist -= 2 * Math.PI;
      if (twist < -Math.PI) twist += 2 * Math.PI;
      out.push({
        name: B.name,
        swing: 2 * Math.acos(Math.min(1, Math.abs(swingQ.w))),
        twist: Math.abs(twist),
        cone: B.cone,
        twistLimit: B.twist,
      });
    }
    return out;
  }

  /** The hinge axes as BUILT, in world space (= rest coordinates). An elbow
   *  whose axis does not turn with the body is not an elbow. */
  hingeAxes() {
    return this.hinges.map((h) => ({
      name: h.name, kind: h.kind, limits: h.limits,
      axisWorld: h.axisWorld.clone(), boneDir: h.boneDir.clone(),
    }));
  }

  /** Live hinge angles against their signed ranges. A knee born outside its
   *  own range is annihilated by the solver on frame one — which is what a
   *  mid-stride fall does to a rig whose flexion sign was derived wrong. */
  hingeAngles() {
    const out = [];
    for (const H of this.hinges) {
      const rp = H.pb.rotation(), rc = H.cb.rotation();
      const qP = new THREE.Quaternion(rp.x, rp.y, rp.z, rp.w);
      const qC = new THREE.Quaternion(rc.x, rc.y, rc.z, rc.w);
      const rel = qP.clone().invert().multiply(qC);
      if (rel.w < 0) { rel.x *= -1; rel.y *= -1; rel.z *= -1; rel.w *= -1; }
      const v = new THREE.Vector3(rel.x, rel.y, rel.z);
      const proj = v.dot(H.axisWorld);
      let ang = 2 * Math.atan2(proj, rel.w);
      if (ang > Math.PI) ang -= 2 * Math.PI;
      if (ang < -Math.PI) ang += 2 * Math.PI;
      const offAxis = v.clone().addScaledVector(H.axisWorld, -proj).length();
      out.push({
        name: H.name, kind: H.kind, angle: ang, lo: H.limits[0], hi: H.limits[1],
        offAxis: 2 * Math.asin(Math.min(1, offAxis)),   // rotation on the LOCKED axes
        over: Math.max(H.limits[0] - ang, ang - H.limits[1], 0),
      });
    }
    return out;
  }

  /** Mass split, for the suite: a trunk lighter than the legs gets thrown
   *  around by its own limbs. */
  massSplit() {
    let torso = 0, total = 0;
    const seen = new Set();
    for (const s of this.segs.values()) {
      if (seen.has(s.body)) continue;
      seen.add(s.body);
      const m = s.body.mass();
      total += m;
      if (s.torso) torso += m;
    }
    return { torso, total, frac: total > 0 ? torso / total : 0 };
  }

  _topple(lean) {
    let lo = Infinity, hi = -Infinity;
    for (const s of this.segs.values()) {
      const y = s.body.translation().y; lo = Math.min(lo, y); hi = Math.max(hi, y);
    }
    const span = (hi - lo) || 1;
    _v.copy(lean);
    const cap = 8;
    if (_v.lengthSq() > cap * cap) _v.setLength(cap);
    const seen = new Set();
    for (const s of this.segs.values()) {
      if (seen.has(s.body)) continue;
      seen.add(s.body);
      const w = (s.body.translation().y - lo) / span;
      const cur = s.body.linvel();
      s.body.setLinvel({ x: cur.x + _v.x * w, y: cur.y, z: cur.z + _v.z * w }, true);
    }
  }

  impulse(v) {
    if (this.done) return;
    this._topple(v);
    this.settledFor = 0;
    this.elapsed = 0;
  }

  setPin(joint, target) {
    if (this.done) return;
    if (!joint) {
      for (const j of [...this._pinBodies.keys()]) this.setPin(j, null);
      return;
    }
    const seg = [...this.segs.values()].find((s) => s.a === joint || s.b === joint);
    if (!seg) return;
    if (!target) {
      const pin = this._pinBodies.get(joint);
      if (pin) {
        this.world.removeImpulseJoint(pin.joint, true);
        this.world.removeRigidBody(pin.marker);
        this._pinBodies.delete(joint);
        this.pins.delete(joint);
      }
      // the lift ceiling is a LEASE, not a ratchet: it was raised so a hoisted
      // body could rise, and it comes back down when nothing is holding it.
      if (this._pinBodies.size === 0) this.rootStartY = this._rootBaseY;
      return;
    }
    let pin = this._pinBodies.get(joint);
    if (!pin) {
      // the marker is born AT the joint — zero constraint error at creation —
      // and CHASES the target at capped speed (see _chasePins). Teleporting it
      // resolves the position error as one giant solver impulse: measured
      // 955 km of body displacement in a frame. The chase is also the feel: a
      // hand pulling a body, not a body snapping to a hand.
      const t = seg.body.translation(), rq = seg.body.rotation();
      const anchor = seg.a === joint ? seg.localA : seg.localB;
      _a.copy(anchor).applyQuaternion(_qp.set(rq.x, rq.y, rq.z, rq.w));
      const marker = this.world.createRigidBody(
        RAPIER.RigidBodyDesc.kinematicPositionBased()
          .setTranslation(t.x + _a.x, t.y + _a.y, t.z + _a.z));
      const jd = RAPIER.JointData.spherical(
        { x: 0, y: 0, z: 0 }, { x: anchor.x, y: anchor.y, z: anchor.z });
      const j = this.world.createImpulseJoint(jd, marker, seg.body, true);
      pin = { marker, joint: j, at: new THREE.Vector3(t.x + _a.x, t.y + _a.y, t.z + _a.z) };
      this._pinBodies.set(joint, pin);
      this.pins.set(joint, new THREE.Vector3());
    }
    this.pins.get(joint).copy(target);
    for (const s of this.segs.values()) s.body.wakeUp();
  }

  /** Markers chase their targets at a bounded speed — every substep, so the
   *  injection per solver tick stays small and the sim stays stable. */
  _chasePins() {
    const MAXV = 6 * FIXED_DT;
    for (const [joint, pin] of this._pinBodies) {
      const want = this.pins.get(joint);
      if (!want) continue;
      _v.copy(want).sub(pin.at);
      const d = _v.length();
      if (d > 1e-6) pin.at.addScaledVector(_v, Math.min(1, MAXV / d));
      pin.marker.setNextKinematicTranslation({ x: pin.at.x, y: pin.at.y, z: pin.at.z });
    }
  }

  get pinned() { return this.pins.size > 0; }

  /** The drag-release handover, same packed format as the Verlet's: joint
   *  names + positions + velocities. Endpoint velocity is the rigid-body
   *  truth: v + ω × r — a swung body hands over its swing. r is measured from
   *  the CENTRE OF MASS, which for the compound torso is not the body origin. */
  snapshot() {
    // A disposed sim has no segments, so this would return {j:[],p:[],v:[]} —
    // and `seedVel?.j` is TRUTHY for an empty array, so the receiver would take
    // the hollow handover as authoritative and reset the body. Say nothing
    // instead; every caller already falls back.
    if (this._freed) return null;
    this._syncP();
    const j = [], p = [], v = [];
    const seen = new Set();
    for (const s of this.segs.values()) {
      const com = s.body.worldCom(), lv = s.body.linvel(), av = s.body.angvel();
      for (const [name] of [[s.a], [s.b]]) {
        if (seen.has(name) || !this.p[name]) continue;
        seen.add(name);
        const q = this.p[name];
        j.push(name);
        p.push(+q.x.toFixed(4), +q.y.toFixed(4), +q.z.toFixed(4));
        _a.set(q.x - com.x, q.y - com.y, q.z - com.z);
        _b.set(av.x, av.y, av.z).cross(_a).add(_v.set(lv.x, lv.y, lv.z));
        v.push(+_b.x.toFixed(3), +_b.y.toFixed(3), +_b.z.toFixed(3));
      }
    }
    return { j, p, v };
  }

  _syncP() {
    for (const s of this.segs.values()) {
      const t = s.body.translation(), rq = s.body.rotation();
      _qp.set(rq.x, rq.y, rq.z, rq.w);
      _a.copy(s.localA).applyQuaternion(_qp);
      (this.p[s.a] ??= new THREE.Vector3()).set(t.x + _a.x, t.y + _a.y, t.z + _a.z);
      _a.copy(s.localB).applyQuaternion(_qp);
      (this.p[s.b] ??= new THREE.Vector3()).set(t.x + _a.x, t.y + _a.y, t.z + _a.z);
    }
  }

  step(dt) {
    if (this.done) return null;
    dt = Math.min(0.25, Math.max(0, dt || 0));
    this.acc += dt;
    let n = 0;
    while (this.acc >= FIXED_DT && n < MAX_FRAMES) {
      // muscle tone decays — limp is a process, not a switch
      this._toneAcc += FIXED_DT;
      if (this._toneAcc >= 0.1 && this.tone > TONE_FLOOR) {
        this._toneAcc = 0;
        this.tone = Math.max(TONE_FLOOR, this.tone * TONE_DECAY);
        this._setTone(this.tone);
      }
      this._chasePins();
      this.world.step();
      // absolute ceiling on angular velocity: nothing anatomical rotates at
      // 20 rad/s, and any residual solver energy hides there first
      for (const s2 of this.segs.values()) {
        const w = s2.body.angvel();
        const m = Math.hypot(w.x, w.y, w.z);
        if (m > ANG_CEIL) {
          const k = ANG_CEIL / m;
          s2.body.setAngvel({ x: w.x * k, y: w.y * k, z: w.z * k }, false);
        }
      }
      this.acc -= FIXED_DT;
      n++;
    }
    if (n === MAX_FRAMES) this.acc = 0;

    // Settle is LINEAR AND ANGULAR. Linear-only froze bodies mid-rotation —
    // measured 1.0-1.35 rad/s (58-77°/s) of residual turn at the instant of
    // capture, which reads on screen as the corpse popping as it locks.
    let maxSpeed = 0, maxSpin = 0;
    for (const s of this.segs.values()) {
      const v = s.body.linvel(), w = s.body.angvel();
      maxSpeed = Math.max(maxSpeed, Math.hypot(v.x, v.y, v.z));
      maxSpin = Math.max(maxSpin, Math.hypot(w.x, w.y, w.z));
    }
    this.maxV = maxSpeed;
    this.maxW = maxSpin;

    this.elapsed += dt;
    if (this.pinned) { this.settledFor = 0; this.elapsed = 0; }
    if (this.maxV < SETTLE_V && this.maxW < SETTLE_W) this.settledFor += dt;
    else this.settledFor = 0;

    if (n === 0 && this.pose) return this.pose;
    this._syncP();

    // root follows the hips; the falling-only ceiling lifts while pinned
    const hips = this.p.hips;
    if (hips) {
      this.avatar.root.position.x = hips.x;
      this.avatar.root.position.z = hips.z;
      const y = hips.y - this.hipsOffset;
      if (this.pinned && y > this.rootStartY) this.rootStartY = y;
      this.avatar.root.position.y = Math.min(this.rootStartY, y);
    }

    // bones: rest direction → live direction, world-reference (parents first)
    const pose = {};
    for (const d of this.drive) {
      const bp = this.p[d.bone], cp = this.p[d.child];
      if (!bp || !cp) continue;
      _b.copy(cp).sub(bp);
      if (_b.lengthSq() < 1e-6) continue;
      _b.normalize();
      shortestArc(d.restDir, _b, _q).multiply(d.restQuat);
      d.parent.getWorldQuaternion(_qp).invert();
      _qp.multiply(_q);
      d.node.quaternion.copy(_qp);
      pose[d.bone] = [+_qp.x.toFixed(4), +_qp.y.toFixed(4), +_qp.z.toFixed(4), +_qp.w.toFixed(4)];
    }
    this.pose = pose;
    this.avatar.setPose(pose);

    if (this.settledFor >= SETTLE_TIME || this.elapsed >= DEADLINE) {
      this.done = true;
      this.finalPose = pose;
      this.dispose();
      return null;
    }
    return pose;
  }

  /** Free the WASM world — rigid bodies do not garbage-collect. Safe to call
   *  twice; called automatically at capture. */
  dispose() {
    if (this._freed) return;
    this._freed = true;
    this.done = true;           // a freed world must never be stepped again
    try { this.world.free(); } catch { /* already gone */ }
    this.segs.clear();
    this._pinBodies.clear();
    this.pins.clear();          // a disposed sim is not still holding anything
    this.balls.length = 0;
    this.jointHandles.length = 0;
  }
}
