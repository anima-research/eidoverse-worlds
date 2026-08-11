// ammodoll — the Bullet body engine, ported from socketteer/ragdoll-physics.
// Same interface as Ragdoll/RapierRagdoll (see rapierdoll.js's contract):
// constructor(avatar, lean, rest, seedVel), step(dt) → sparse local-quat pose
// (and it drives the avatar directly), impulse(v), setPin(joint, target)/
// setPin(null), .pins/.pinned/.done/.finalPose/.p/.maxV, snapshot(), dispose().
//
// What this engine IS: Janus's measured rig, retargeted. ragdoll-physics
// derived its joint-limit tables, finger springs, tendon coupling and grab
// tuning against real avatars in Blender — and Blender's rigid-body engine IS
// Bullet, so every number transfers to ammo.js unchanged where rapierdoll had
// to re-derive its constraints from scratch. What does NOT transfer is the
// avatar contract: the source rig is a Tripo biped with rig.json baked from a
// hand-sculpted proxy mesh, Z-up, bones along local +Y. Here the rig is
// measured from the live VRM skeleton at construction (rapierdoll's approach):
// box sizes from bone lengths (rigdef.py's own skeleton-only fallback), masses
// from Dempster fractions, and every joint frame built from an ANATOMICAL
// basis — Y along the bone (twist), X the flexion axis derived from the rig's
// own forward/up (never from a node's local axes: VRM nodes sit near-identity
// at rest, so their local frames mean nothing anatomical).
//
// Structural choices inherited from the housemates, deliberately:
//
//   • THE TORSO IS ONE RIGID BODY (rapierdoll's lesson, kept): spine joints
//     cannot be defended at impact — a fold forms faster than any limit
//     responds, then ground friction pins it; measured 142° of swing against a
//     25° cone. The source keeps pelvis/spine/chest jointed because its doll
//     is posed kinematically and handled gently; ours hits the ground at
//     speed. The spine's looseness reads in the head and limbs, which keep
//     their joints (and the source's limits).
//   • REST-ALIGNED BODIES (rapierdoll's frame law, kept): each body's
//     orientation is the rotation carrying its rest configuration to its live
//     one — identity at rest — so a joint frame built from rest anatomy reads
//     the BORN excursion at build, and limits mean "from rest" the way the
//     source's tables intend. Joint anchor ORIGINS are still mapped through
//     the live transforms (zero position error at build: the rest-shaped
//     rigid torso disagrees with the live spine about where a shoulder is,
//     and handing that difference to the solver was measured at 115 mm → the
//     angular-velocity ceiling within six frames).
//   • A JOINT MUST CONTAIN THE POSE IT WAS BORN IN: every angular bound is
//     widened to admit the build pose plus slack, per axis, or the solver
//     annihilates the difference on frame one.
//
// And from the source, verbatim where it transfers:
//
//   • the full JOINTS table (rigdef.py) in degrees — elbow (−145, 2), knee
//     (0, 145), the wrist whose "X is side-to-side roll and Z is flexion",
//     the thumb's per-side sign — re-expressed on the anatomical basis;
//   • fingers as real spring bodies (btGeneric6DofSpringConstraint, stiffness
//     12 / damping 0.9, equilibrium snapshotted at build), proximal and
//     intermediate only — the distal is the measured dead end: 290° against
//     an 80° limit at the end of a three-link chain of 10 g bodies;
//   • tendons: neighbouring fingers coupled by a weak orientation spring
//     (stiffness 8), because explicit torques on 1.6e-6 kg·m² of inertia
//     NaN'd at every gain — the solver couples them implicitly and stably;
//   • solver settings (30 iterations, split impulse, step (dt, 8, 1/120)),
//     limit stiffness via btTypedConstraint::setParam (this ammo build does
//     not bind getRotationalLimitMotor — which also means NO muscle-tone
//     motors: limpness here is the source's tuned damping and limit ERP,
//     not rapierdoll's decaying tone);
//   • the grab: btPoint2PointConstraint with a hard impulse clamp — the clamp
//     is what makes a distant pin a pull instead of a teleport;
//   • body damping (0.12, 0.45), friction 0.85, restitution 0.03.
//
// WASM lifetime discipline (the source leaked ~7000 objects/second before it
// learned this): every Ammo object this instance creates is tracked and
// destroyed in dispose(); per-frame math reuses module-level temporaries.

import { THREE } from './core.js';
import { heightAt } from './terrain.js';
import { colliders } from './colliders.js';

let AMMO = null;
let ammoLoading = null;
export async function ensureAmmo() {
  if (AMMO) return true;
  if (ammoLoading) return ammoLoading;
  ammoLoading = (async () => {
    try {
      if (typeof document === 'undefined') {
        // headless (bun): the glue has a CommonJS tail
        const [{ createRequire }, { fileURLToPath }] = await Promise.all([
          import('node:module'), import('node:url'),
        ]);
        const req = createRequire(import.meta.url);
        const dir = fileURLToPath(new URL('../vendor/ammo/', import.meta.url));
        AMMO = await req(dir + 'ammo.wasm.js')({ locateFile: (f) => dir + f });
      } else {
        // browser: classic Emscripten script, not an ES module — script tag
        if (!globalThis.Ammo) {
          await new Promise((res, rej) => {
            const s = document.createElement('script');
            s.src = '/vendor/ammo/ammo.wasm.js';
            s.onload = res;
            s.onerror = () => rej(new Error('vendor/ammo failed to load'));
            document.head.appendChild(s);
          });
        }
        AMMO = await globalThis.Ammo({ locateFile: (f) => '/vendor/ammo/' + f });
      }
      _initTemps();
      return true;
    } catch (e) {
      console.error('[ammodoll] wasm init failed — verlet stays', e);
      AMMO = null;
      return false;
    } finally {
      ammoLoading = null;
    }
  })();
  return ammoLoading;
}
export const ammoReady = () => !!AMMO;

// ---------------------------------------------------------------- constants

const DEG = Math.PI / 180;

// Dempster's segment fractions (rigdef.py BODIES), torso rows summed because
// the torso is one body here. Mass from proxy volume was the measured mistake:
// a 0.4 kg pelvis "whipped around like a bead".
const MASS_FRAC = {
  torso: 0.14 + 0.14 + 0.16,
  head: 0.081,
  upperArm: 0.028, lowerArm: 0.016, hand: 0.006,
  upperLeg: 0.100, lowerLeg: 0.047, foot: 0.015,
};
const REAL_H = 1.70;            // rigdef.py: reference height for the mass budget
const BODY_KG = 62.0;           // at REAL_H, scaled by (H/1.70)³
const FINGER_MASS_FRAC = 0.0016; // per phalanx body (~20 g at 62 kg); thumb ×1.4

const FINGER_STIFFNESS = 12.0;  // rigdef.py, measured sag plateau
const FINGER_DAMPING = 0.9;
const FINGER_TENDON = 8.0;

const ERP_LIMIT = 0.35;         // source default: how hard limits are held
const BT_CONSTRAINT_STOP_ERP = 3; // this build's setParam id (source, verbatim)
const ACTIVE_TAG = 1;

const LIN_DAMP = 0.12;          // source setDamping(0.12, —)
// 0.7, not the source's 0.45: rapierdoll's validated value for this regime.
// The source's doll is posed and grounded; ours tumbles, and at 0.45 the
// light extremities (hands carrying nine spring phalanges, the head) ring at
// 1-12 rad/s indefinitely — the island never quiets enough to sleep, and the
// deadline captures mid-jitter.
const ANG_DAMP = 0.7;
const ANG_DAMP_FINGER = 0.95;   // spring-driven 20 g boxes: dissipate hard
const LIN_DAMP_FINGER = 0.3;
const FRICTION = 0.85;
const RESTITUTION = 0.03;

const FIXED_DT = 1 / 120;       // source stepSimulation(dt, 8, 1/120)
const MAX_SUBSTEPS = 8;
const SETTLE_V = 0.07;          // the house settle law (rapierdoll's numbers)
const SETTLE_W = 0.6;
const SETTLE_TIME = 0.45;
const DEADLINE = 8;
const ANG_CEIL = 20;            // rad/s backstop
const BUILD_WIDEN = 0.12;       // rad of slack over the born excursion
const PIN_TAU = 0.9;            // source: the shift-click pin, held firm
const PIN_CLAMP_X = 8;          // × total mass

// Anatomical joint table — the source's rigdef.py JOINTS in degrees, re-keyed
// to the basis built in _jointBasis(): Y = bone (twist), X = primary swing
// (flexion where the joint has one), Z = X×Y (the other swing). Directional
// entries carry `flex`/`ext` and a `want` (which way flexion moves the child's
// tip); the sign of X's range is DERIVED from the built axis, never assumed —
// the two sides of the body mirror, and a hard-coded sign is wrong on one
// (rapierdoll's law; also the source's thumb lesson).
//   ref: what X is crossed against — 'fwd' | 'up' | 'palm' | 'pinky'
const JOINT_SPECS = {
  head: { ref: 'fwd', x: [-40, 40], twist: 45, z: [-35, 35] },
  upperArm: { ref: 'fwd', x: [-85, 85], twist: 70, z: [-85, 85] },
  lowerArm: { ref: 'fwd', flex: 145, ext: 2, want: 'fwd', twist: 5, z: [-5, 5] },
  // wrist, translated by MEANING not by letter: the source measured flexion
  // ±45, deviation ±15, twist ±8 (its own X/Z were "the other way round")
  hand: { ref: 'palm', flex: 45, ext: 45, want: 'palm', twist: 8, z: [-15, 15] },
  upperLeg: { ref: 'fwd', flex: 90, ext: 45, want: 'fwd', twist: 30, z: [-45, 45] },
  lowerLeg: { ref: 'fwd', flex: 145, ext: 0, want: 'back', twist: 5, z: [-5, 5] },
  foot: { ref: 'up', x: [-35, 35], twist: 15, z: [-20, 20] },
  fingerProx: { ref: 'palm', flex: 90, ext: 6, want: 'palm', twist: 8, z: [-12, 12] },
  fingerMid: { ref: 'palm', flex: 100, ext: 0, want: 'palm', twist: 4, z: [-4, 4] },
  thumb: { ref: 'pinky', flex: 55, ext: 10, want: 'pinky', twist: 12, z: [-25, 25] },
};

// The body cut. Core mirrors rapierdoll's SEGMENTS (the torso rows share one
// rigid body); hands and feet are the source's additions, and the fingers ride
// on the hands. `tip` marks endpoints that may need extrapolating on rigs
// whose VRM lacks the child bone.
const TORSO_KEYS = new Set(['hips|spine', 'spine|chest', 'chest|neck']);
const CORE_SEGMENTS = [
  ['hips', 'spine'], ['spine', 'chest'], ['chest', 'neck'], ['neck', 'head'],
  ['leftUpperArm', 'leftLowerArm'], ['leftLowerArm', 'leftHand'],
  ['rightUpperArm', 'rightLowerArm'], ['rightLowerArm', 'rightHand'],
  ['leftUpperLeg', 'leftLowerLeg'], ['leftLowerLeg', 'leftFoot'],
  ['rightUpperLeg', 'rightLowerLeg'], ['rightLowerLeg', 'rightFoot'],
];
const EXTRA_SEGMENTS = [
  { a: 'leftHand', b: 'leftMiddleProximal', part: 'hand' },
  { a: 'rightHand', b: 'rightMiddleProximal', part: 'hand' },
  { a: 'leftFoot', b: 'leftToes', part: 'foot' },
  { a: 'rightFoot', b: 'rightToes', part: 'foot' },
];
const CORE_JOINTS = [
  { at: 'neck', parent: 'chest', child: 'neck|head', spec: 'head' },
  { at: 'leftUpperArm', parent: 'chest', child: 'leftUpperArm|leftLowerArm', spec: 'upperArm' },
  { at: 'rightUpperArm', parent: 'chest', child: 'rightUpperArm|rightLowerArm', spec: 'upperArm' },
  { at: 'leftLowerArm', parent: 'leftUpperArm|leftLowerArm', child: 'leftLowerArm|leftHand', spec: 'lowerArm' },
  { at: 'rightLowerArm', parent: 'rightUpperArm|rightLowerArm', child: 'rightLowerArm|rightHand', spec: 'lowerArm' },
  { at: 'leftHand', parent: 'leftLowerArm|leftHand', child: 'leftHand|leftMiddleProximal', spec: 'hand' },
  { at: 'rightHand', parent: 'rightLowerArm|rightHand', child: 'rightHand|rightMiddleProximal', spec: 'hand' },
  { at: 'leftUpperLeg', parent: 'hips', child: 'leftUpperLeg|leftLowerLeg', spec: 'upperLeg' },
  { at: 'rightUpperLeg', parent: 'hips', child: 'rightUpperLeg|rightLowerLeg', spec: 'upperLeg' },
  { at: 'leftLowerLeg', parent: 'leftUpperLeg|leftLowerLeg', child: 'leftLowerLeg|leftFoot', spec: 'lowerLeg' },
  { at: 'rightLowerLeg', parent: 'rightUpperLeg|rightLowerLeg', child: 'rightLowerLeg|rightFoot', spec: 'lowerLeg' },
  { at: 'leftFoot', parent: 'leftLowerLeg|leftFoot', child: 'leftFoot|leftToes', spec: 'foot' },
  { at: 'rightFoot', parent: 'rightLowerLeg|rightFoot', child: 'rightFoot|rightToes', spec: 'foot' },
];
// VRM humanoid digit chains: [prox, mid, distal]. "little", not "pinky" —
// the tendon chain below couples index→middle→ring→little exactly as the
// source's TENDON_CHAIN does (thumb excluded: no shared tendon).
const FINGERS = ['Index', 'Middle', 'Ring', 'Little'];

// collision filter bits — the filter is an OR of BOTH directions
// ((groupA & maskB) || (groupB & maskA)), and it FREEZES at addRigidBody:
// changing it later does nothing (source, the day it cost)
// Bullet's filter group/mask are ints (btBroadphaseProxy), so there is room:
// bit 0 statics, bits 1..16 per-core-body (torso + head + 8 limb segments +
// 2 hands + 2 feet = 14 today), bit 30 the shared finger group.
const G_STATIC = 1;
const G_FINGER = 1 << 30;
const BODY_BITS = 16;

// ---------------------------------------------------------------- wasm temps

let _bv1, _bv2, _bt1, _bt2, _bq1;
function _initTemps() {
  if (_bv1) return;
  _bv1 = new AMMO.btVector3(); _bv2 = new AMMO.btVector3();
  _bt1 = new AMMO.btTransform(); _bt2 = new AMMO.btTransform();
  _bq1 = new AMMO.btQuaternion(0, 0, 0, 1);
}
const _v = new THREE.Vector3();
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _qp = new THREE.Quaternion();
const _m4 = new THREE.Matrix4();

/** Body world rotation → THREE, consumed IMMEDIATELY. Ammo's value-returning
 *  methods (getRotation among them) share one static temporary per method —
 *  two held results alias each other. Every rotation read goes through here. */
function quatOf2(body, out) {
  const r = body.getCenterOfMassTransform().getRotation();
  return out.set(r.x(), r.y(), r.z(), r.w());
}

/** Deterministic frame with Y along `dir` — rapierdoll's frameQuat, kept for
 *  the same reason: setFromUnitVectors is singular for antiparallel inputs and
 *  answers them arbitrarily, differently per call. */
function frameQuat(dir, out = new THREE.Quaternion()) {
  const y = dir.clone().normalize();
  const ref = Math.abs(y.z) < 0.9 ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(1, 0, 0);
  const x = new THREE.Vector3().crossVectors(ref, y).normalize();
  const z = new THREE.Vector3().crossVectors(x, y);
  return out.setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, z));
}

/** Shortest arc with the antiparallel case answered deterministically. */
const _sa1 = new THREE.Vector3(); const _sa2 = new THREE.Vector3(); const _sa3 = new THREE.Vector3();
function shortestArc(from, to, out = new THREE.Quaternion()) {
  const f = _sa1.copy(from).normalize();
  const t = _sa2.copy(to).normalize();
  const d = f.dot(t);
  if (d > 0.999999) return out.set(0, 0, 0, 1);
  if (d < -0.999999) {
    _sa3.set(Math.abs(f.x) < 0.9 ? 1 : 0, Math.abs(f.x) < 0.9 ? 0 : 1, 0);
    _sa3.crossVectors(f, _sa3).normalize();
    return out.setFromAxisAngle(_sa3, Math.PI);
  }
  _sa3.crossVectors(f, t);
  out.set(_sa3.x, _sa3.y, _sa3.z, 1 + d);
  return out.normalize();
}

export class AmmoRagdoll {
  constructor(avatar, lean = null, rest = null, seedVel = null) {
    if (!AMMO) throw new Error('ammodoll: wasm not ready — ensureAmmo() first');
    this.avatar = avatar;
    this.done = false;
    this.pose = null;
    this.finalPose = null;
    this.pins = new Map();          // joint -> THREE.Vector3 (world) — bodydrag reads this
    this._pinCons = new Map();      // joint -> { con, body }
    this.settledFor = 0;
    this.elapsed = 0;
    this.maxV = Infinity;
    this.maxW = Infinity;
    this.p = {};                    // joint -> world pos (debug + parity surface)
    this._refs = [];                // every wasm object we own, freed in dispose()
    const keep = (o) => { this._refs.push(o); return o; };

    const h = avatar.vrm.humanoid;
    avatar.root.updateMatrixWorld(true);
    const node = (j) => h?.getNormalizedBoneNode?.(j) ?? null;

    // ---- live capture + neutral rest (rapierdoll's two-skeleton law) -------
    const wanted = new Set(CORE_SEGMENTS.flat());
    for (const e of EXTRA_SEGMENTS) { wanted.add(e.a); wanted.add(e.b); }
    for (const side of ['left', 'right']) {
      for (const f of FINGERS) {
        for (const lvl of ['Proximal', 'Intermediate', 'Distal']) wanted.add(`${side}${f}${lvl}`);
      }
      for (const lvl of ['ThumbMetacarpal', 'ThumbProximal', 'ThumbDistal']) wanted.add(`${side}${lvl}`);
    }
    const live = {};
    for (const j of wanted) {
      const n = node(j);
      if (n) live[j] = n.getWorldPosition(new THREE.Vector3());
    }
    if (!live.chest && live.spine && live.neck) {
      live.chest = live.spine.clone().add(live.neck).multiplyScalar(0.5);
    }
    // neck is optional in VRM, and both the head's body and its joint hang off
    // it — a missing bone must not detach a head (rapierdoll's law)
    if (!live.neck && live.chest && live.head) {
      live.neck = live.chest.clone().lerp(live.head, 0.75);
    }
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
    // rest covers only what the caller sampled (the 12 core joints, usually);
    // hands, feet and fingers fill from the avatar's own neutral pose, or, on
    // a stand-in without one, from the live skeleton
    const restExtra = avatar.restBonePositions?.([...wanted]) ?? null;
    for (const j of wanted) {
      if (restP[j]) continue;
      const src = restExtra?.[j] ?? live[j];
      if (src) restP[j] = src.clone();
    }
    if (!restP.chest && restP.spine && restP.neck) {
      restP.chest = restP.spine.clone().add(restP.neck).multiplyScalar(0.5);
    }
    if (!restP.neck && restP.chest && restP.head) {
      restP.neck = restP.chest.clone().lerp(restP.head, 0.75);
    }
    this.restP = restP;

    // ---- rig frame + scale --------------------------------------------------
    const rigUp = (restP.neck ?? restP.chest ?? restP.spine ?? restP.head)
      ?.clone().sub(restP.hips ?? new THREE.Vector3()).normalize() ?? new THREE.Vector3(0, 1, 0);
    let rigLat = restP.leftUpperArm && restP.rightUpperArm
      ? restP.leftUpperArm.clone().sub(restP.rightUpperArm)
      : (restP.leftUpperLeg && restP.rightUpperLeg
        ? restP.leftUpperLeg.clone().sub(restP.rightUpperLeg)
        : new THREE.Vector3(1, 0, 0));
    rigLat.addScaledVector(rigUp, -rigLat.dot(rigUp));
    if (rigLat.lengthSq() < 1e-9) rigLat.set(1, 0, 0);
    rigLat.normalize();
    const rigFwd = new THREE.Vector3().crossVectors(rigLat, rigUp).normalize();
    this.rig = { up: rigUp, lateral: rigLat, forward: rigFwd };
    // VRM binds a T-pose with the palms DOWN, and rest here IS the bind pose
    // (restBonePositions zeroes every humanoid rotation) — so the palm normal
    // is the rig's down, and finger flexion curls toward it
    const palmN = rigUp.clone().negate();

    let hiUp = -Infinity, loUp = Infinity;
    for (const v of Object.values(restP)) {
      const d = v.dot(rigUp);
      hiUp = Math.max(hiUp, d); loUp = Math.min(loUp, d);
    }
    const H = Math.min(2.5, Math.max(0.4, (hiUp - loUp) * 1.12));   // + skull/sole
    this.height = H;
    const massScale = BODY_KG * (H / REAL_H) ** 3;
    const span = restP.leftUpperArm && restP.rightUpperArm
      ? restP.leftUpperArm.distanceTo(restP.rightUpperArm) : H * 0.3;
    const torsoR = Math.max(0.05, span * 0.22);

    // ---- extrapolate missing tips so hands/feet can be bodies --------------
    // rigdef's skeleton-only fallback sizes a box from the bone alone; a VRM
    // without finger or toe bones still has a hand and a foot worth ~35% of
    // the parent bone, pointing the way the parent was going
    const extrapolate = (m, from, parentFrom, frac = 0.35) => {
      if (!m[from] || !m[parentFrom]) return null;
      const d = m[from].clone().sub(m[parentFrom]);
      if (d.lengthSq() < 1e-8) return null;
      return m[from].clone().addScaledVector(d, frac);
    };
    for (const e of EXTRA_SEGMENTS) {
      const parent = e.part === 'hand'
        ? (e.a === 'leftHand' ? 'leftLowerArm' : 'rightLowerArm')
        : (e.a === 'leftFoot' ? 'leftLowerLeg' : 'rightLowerLeg');
      if (!live[e.b]) {
        const l = extrapolate(live, e.a, parent);
        const r = extrapolate(restP, e.a, parent);
        if (l && r) { live[e.b] = l; restP[e.b] = r; }
      }
    }

    // ---- the physics world -------------------------------------------------
    const cfg = keep(new AMMO.btDefaultCollisionConfiguration());
    const dispatcher = keep(new AMMO.btCollisionDispatcher(cfg));
    const broadphase = keep(new AMMO.btDbvtBroadphase());
    const solver = keep(new AMMO.btSequentialImpulseConstraintSolver());
    this.world = keep(new AMMO.btDiscreteDynamicsWorld(dispatcher, broadphase, solver, cfg));
    _bv1.setValue(0, -9.81, 0);
    this.world.setGravity(_bv1);
    const info = this.world.getSolverInfo();
    info.set_m_numIterations(30);                       // source: 30, not stock 4
    info.set_m_splitImpulse(true);
    info.set_m_splitImpulsePenetrationThreshold(-0.02);

    this._statics = [];
    const addStatic = (halfX, halfY, halfZ, pos, quat, friction) => {
      const shape = keep(new AMMO.btBoxShape(new AMMO.btVector3(halfX, halfY, halfZ)));
      _bt1.setIdentity();
      _bv1.setValue(pos.x, pos.y, pos.z); _bt1.setOrigin(_bv1);
      if (quat) { _bq1.setValue(quat.x, quat.y, quat.z, quat.w); _bt1.setRotation(_bq1); }
      const ms = keep(new AMMO.btDefaultMotionState(_bt1));
      _bv1.setValue(0, 0, 0);
      const ci = keep(new AMMO.btRigidBodyConstructionInfo(0, ms, shape, _bv1));
      const rb = keep(new AMMO.btRigidBody(ci));
      rb.setFriction(friction);
      rb.setRollingFriction(0.05);
      rb.setRestitution(0);
      this.world.addRigidBody(rb, G_STATIC, -1);
      this._statics.push(rb);
      return rb;
    };
    const hips = live.hips ?? avatar.root.position;
    this.groundY = heightAt(hips.x, hips.z);
    addStatic(60, 0.5, 60, { x: hips.x, y: this.groundY - 0.5, z: hips.z }, null, FRICTION);
    for (const [, c] of colliders) {
      const obj = c.obj;
      if (!obj || c.interior || !c.box) continue;
      if (Math.hypot(obj.position.x - hips.x, obj.position.z - hips.z) > 8) continue;
      // scale applies to the centre offset as well as the size, and rotation
      // is part of where the box is (colliders.js's world-placement law)
      const sc = obj.scale ?? { x: 1, y: 1, z: 1 };
      const size = c.box.getSize(new THREE.Vector3()).multiply(_v.set(sc.x, sc.y, sc.z));
      const centre = c.box.getCenter(new THREE.Vector3())
        .multiply(_v.set(sc.x, sc.y, sc.z))
        .applyQuaternion(obj.quaternion ?? new THREE.Quaternion())
        .add(obj.position);
      addStatic(
        Math.max(size.x / 2, 0.02), Math.max(size.y / 2, 0.02), Math.max(size.z / 2, 0.02),
        centre, obj.quaternion ?? null, 0.8,
      );
    }

    // ---- torso: one rigid body, rest-aligned -------------------------------
    const upperOf = (m) => m.chest ?? m.neck ?? m.spine ?? m.head;
    const restUpper = upperOf(restP), liveUpper = upperOf(live);
    if (!restUpper || !liveUpper || !restP.hips || !live.hips) {
      throw new Error('ammodoll: rig has no usable torso chain');
    }
    const topOf = (m) => m.neck ?? m.chest ?? m.spine ?? m.head;
    const torsoQ = shortestArc(
      restUpper.clone().sub(restP.hips), liveUpper.clone().sub(live.hips), new THREE.Quaternion());
    const restTorsoMid = restP.hips.clone().add(topOf(restP)).multiplyScalar(0.5);
    const liveTorsoMid = live.hips.clone().add(topOf(live)).multiplyScalar(0.5);

    // ---- rest-aligned orientation down the chain (rapierdoll's quatOf) -----
    const SEGKEYS = CORE_SEGMENTS.map((s) => s.join('|'));
    const parentSegOf = new Map();
    for (const J of CORE_JOINTS) {
      if (SEGKEYS.includes(J.child) || J.child.includes('|')) parentSegOf.set(J.child, J.parent);
    }
    const bodyQuat = new Map();
    const quatOf = (key, seen = new Set()) => {
      if (bodyQuat.has(key)) return bodyQuat.get(key);
      if (TORSO_KEYS.has(key) || key === 'hips') { bodyQuat.set(key, torsoQ); return torsoQ; }
      if (seen.has(key)) return torsoQ;
      seen.add(key);
      const [a, b] = key.split('|');
      if (!live[a] || !live[b] || !restP[a] || !restP[b]) return torsoQ;
      const pk = parentSegOf.get(key);
      const qParent = pk && pk !== 'hips' && pk !== 'chest' && !TORSO_KEYS.has(pk)
        ? quatOf(pk, seen) : torsoQ;
      const liveLocal = live[b].clone().sub(live[a]).applyQuaternion(qParent.clone().invert());
      const q = qParent.clone().multiply(
        shortestArc(restP[b].clone().sub(restP[a]), liveLocal, new THREE.Quaternion()));
      bodyQuat.set(key, q);
      return q;
    };

    // ---- bodies ------------------------------------------------------------
    // Each body is a compound of boxes. Box half-width is rigdef.py's own
    // skeleton-only fallback (0.16 × bone length), trunk pieces excepted:
    // trunk is VOLUME, its width comes from the shoulder span (rapierdoll's
    // torsoR), not from however short its bones happen to be.
    this.segs = new Map();          // segKey -> seg
    this._bodies = [];              // every dynamic body, build order
    this._cores = [];               // non-finger bodies (settle metrics)
    this._massOf = new Map();       // body -> mass (Bullet only hands back 1/m)
    const bodyIndex = new Map();    // body -> filter bit index (core only)

    const mkBody = (mass, originLive, orient, boxes, isFinger) => {
      const compound = keep(new AMMO.btCompoundShape());
      for (const bx of boxes) {
        const shape = keep(new AMMO.btBoxShape(new AMMO.btVector3(bx.he.x, bx.he.y, bx.he.z)));
        _bt1.setIdentity();
        _bv1.setValue(bx.t.x, bx.t.y, bx.t.z); _bt1.setOrigin(_bv1);
        _bq1.setValue(bx.q.x, bx.q.y, bx.q.z, bx.q.w); _bt1.setRotation(_bq1);
        compound.addChildShape(_bt1, shape);
      }
      _bt1.setIdentity();
      _bv1.setValue(originLive.x, originLive.y, originLive.z); _bt1.setOrigin(_bv1);
      _bq1.setValue(orient.x, orient.y, orient.z, orient.w); _bt1.setRotation(_bq1);
      const ms = keep(new AMMO.btDefaultMotionState(_bt1));
      _bv1.setValue(0, 0, 0);
      compound.calculateLocalInertia(mass, _bv1);
      const ci = keep(new AMMO.btRigidBodyConstructionInfo(mass, ms, compound, _bv1));
      const rb = keep(new AMMO.btRigidBody(ci));
      rb.setDamping(isFinger ? LIN_DAMP_FINGER : LIN_DAMP, isFinger ? ANG_DAMP_FINGER : ANG_DAMP);
      rb.setFriction(FRICTION);
      // Rolling friction, which the source never needed: its boxes sat on a
      // plane under a posed doll, ours land tumbling — and a 20-gram foot box
      // wobbling on a corner spikes to the angular ceiling in single steps,
      // holding settle off until the deadline. Rolling friction is Bullet's
      // own damper for exactly this (it needs a value on both bodies of the
      // pair — the statics carry 0.05 too).
      rb.setRollingFriction(0.05);
      rb.setRestitution(RESTITUTION);
      // Let it SLEEP once converged (source, verbatim): pinned awake with
      // DISABLE_DEACTIVATION, the solver re-solves every body forever and the
      // residual noise reads as extremities twitching indefinitely — measured
      // here as light foot boxes jittering at the 20 rad/s ceiling minutes
      // into a fall. Bullet deactivates per island, so the doll settles
      // together, and every pin, impulse or seed calls activate() to wake it.
      rb.setSleepingThresholds(0.02, 0.05);
      rb.setActivationState(ACTIVE_TAG);
      this._bodies.push(rb);
      this._massOf.set(rb, mass);
      if (!isFinger) this._cores.push(rb);
      return rb;
    };

    // a box spanning ra→rb in REST coordinates, expressed local to a body
    // whose rest origin is `origin` (identity orientation at rest)
    const boxFor = (origin, ra, rb2, halfW, halfD = halfW) => {
      const dir = rb2.clone().sub(ra);
      const len = Math.max(dir.length(), 0.04);
      const mid = ra.clone().add(rb2).multiplyScalar(0.5).sub(origin);
      return { he: new THREE.Vector3(halfW, len / 2, halfD), t: mid, q: frameQuat(dir) };
    };
    const limbW = (ra, rb2) => Math.max(0.02, ra.distanceTo(rb2) * 0.16);

    // torso body: pelvis + spine + chest boxes on ONE rigid body
    const torsoBoxes = [];
    for (const key of ['hips|spine', 'spine|chest', 'chest|neck']) {
      const [a, b2] = key.split('|');
      if (!restP[a] || !restP[b2]) continue;
      torsoBoxes.push(boxFor(restTorsoMid, restP[a], restP[b2], torsoR, torsoR * 0.6));
    }
    if (!torsoBoxes.length) {       // degenerate trunk: one box hips→upper
      torsoBoxes.push(boxFor(restTorsoMid, restP.hips, restUpper, torsoR, torsoR * 0.6));
    }
    const torsoBody = mkBody(MASS_FRAC.torso * massScale, liveTorsoMid, torsoQ, torsoBoxes, false);
    this.torsoBody = torsoBody;
    bodyIndex.set(torsoBody, 0);

    const segMeta = new Map();      // segKey -> { body, restOrigin }
    for (const key of TORSO_KEYS) {
      const [a, b2] = key.split('|');
      if (!restP[a] || !restP[b2] || !live[a] || !live[b2]) continue;
      const seg = {
        key, a, b: b2, body: torsoBody, torso: true,
        restA: restP[a].clone(), restB: restP[b2].clone(),
        localA: restP[a].clone().sub(restTorsoMid),
        localB: restP[b2].clone().sub(restTorsoMid),
        r: torsoR,
      };
      this.segs.set(key, seg);
      segMeta.set(key, { body: torsoBody, restOrigin: restTorsoMid });
    }

    // limb + head + hand/foot bodies
    let nextBit = 1;
    const partOf = (key) => {
      if (key === 'neck|head') return 'head';
      if (/UpperArm\|/.test(key)) return 'upperArm';
      if (/LowerArm\|/.test(key)) return 'lowerArm';
      if (/Hand\|/.test(key)) return 'hand';
      if (/UpperLeg\|/.test(key)) return 'upperLeg';
      if (/LowerLeg\|/.test(key)) return 'lowerLeg';
      if (/Foot\|/.test(key)) return 'foot';
      return null;
    };
    const allSegs = [
      ...CORE_SEGMENTS.filter(([a]) => !TORSO_KEYS.has(`${a}|`)).map(([a, b2]) => `${a}|${b2}`)
        .filter((k) => !TORSO_KEYS.has(k)),
      ...EXTRA_SEGMENTS.map((e) => `${e.a}|${e.b}`),
    ];
    for (const key of allSegs) {
      if (this.segs.has(key)) continue;
      const [a, b2] = key.split('|');
      if (!live[a] || !live[b2] || !restP[a] || !restP[b2]) continue;
      const part = partOf(key);
      if (!part) continue;
      const ra = restP[a], rb2 = restP[b2];
      const restMid = ra.clone().add(rb2).multiplyScalar(0.5);
      const liveMid = live[a].clone().add(live[b2]).multiplyScalar(0.5);
      const qB = quatOf(key);
      // the head is a skull, not a stick: widen toward the trunk's scale
      const w = part === 'head' ? Math.max(limbW(ra, rb2), torsoR * 0.55)
        : part === 'foot' ? Math.max(limbW(ra, rb2), 0.03)
          : limbW(ra, rb2);
      const body = mkBody(
        MASS_FRAC[part] * massScale, liveMid, qB,
        [boxFor(restMid, ra, rb2, w)], false);
      const seg = {
        key, a, b: b2, body, torso: false,
        restA: ra.clone(), restB: rb2.clone(),
        localA: ra.clone().sub(restMid), localB: rb2.clone().sub(restMid),
        r: w,
      };
      this.segs.set(key, seg);
      segMeta.set(key, { body, restOrigin: restMid });
      if (nextBit <= BODY_BITS) bodyIndex.set(body, nextBit++);
    }

    // ---- self-collision groups ---------------------------------------------
    // Per-body membership bits; a pair is excluded (symmetrically — OR-of-both
    // -directions law) when it is constraint-adjacent or DEEPLY overlapping at
    // rest. This build does not bind setIgnoreCollisionCheck, so the filter is
    // the only per-pair lever, and it freezes at addRigidBody — everything is
    // computed before the bodies enter the world.
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
      const segList = [...this.segs.values()];
      const adjacent = (x, y) => x.body === y.body
        || x.a === y.a || x.a === y.b || x.b === y.a || x.b === y.b;
      const excluded = new Map();   // body -> Set(body)
      const exclude = (x, y) => {
        if (!excluded.has(x)) excluded.set(x, new Set());
        if (!excluded.has(y)) excluded.set(y, new Set());
        excluded.get(x).add(y); excluded.get(y).add(x);
      };
      for (let i = 0; i < segList.length; i++) {
        for (let j2 = i + 1; j2 < segList.length; j2++) {
          const A2 = segList[i], B2 = segList[j2];
          if (A2.body === B2.body) continue;
          if (adjacent(A2, B2)) { exclude(A2.body, B2.body); continue; }
          // deep at rest = buried, pumps contact energy every frame; grazing
          // is fine (rapierdoll's threshold)
          if (segd(A2.restA, A2.restB, B2.restA, B2.restB) < (A2.r + B2.r) * 1.05) {
            exclude(A2.body, B2.body);
          }
        }
      }
      for (const [body, bit] of bodyIndex) {
        let mask = G_STATIC;
        for (const [other, obit] of bodyIndex) {
          if (other === body) continue;
          if (excluded.get(body)?.has(other)) continue;
          mask |= (G_STATIC << 1) << obit;
        }
        this.world.addRigidBody(body, (G_STATIC << 1) << bit, mask);
      }
      // any core body past the bit budget joins ground-only (none today:
      // torso + head + 8 limbs + 2 hands + 2 feet = 13 ≤ 1+12 bits)
      for (const body of this._cores) {
        if (!bodyIndex.has(body)) this.world.addRigidBody(body, G_FINGER, G_STATIC);
      }
    }

    // ---- joint frames: anatomy on the anatomical basis ---------------------
    // Basis: Y = rest bone direction (twist), X = swing derived from the rig's
    // own reference, Z = X×Y. ORIGIN through the LIVE transforms (zero position
    // error at build), BASIS from rest (limits mean "from rest"): rest-aligned
    // bodies make both true at once.
    this._constraints = [];
    this._springs = [];
    this.jointMeta = [];            // { name, spec, axisX/Y/Z world-at-rest, lo, hi }
    this.skipped = [];

    const towardPinky = (side) => {
      const a2 = restP[`${side}LittleProximal`] ?? restP[`${side}Hand`];
      const b2 = restP[`${side}ThumbProximal`] ?? restP[`${side}ThumbMetacarpal`];
      if (!a2 || !b2) return rigFwd.clone();
      const d = a2.clone().sub(b2);
      return d.lengthSq() > 1e-8 ? d.normalize() : rigFwd.clone();
    };
    const refVec = (ref, side) =>
      ref === 'up' ? rigUp.clone()
        : ref === 'palm' ? palmN.clone()
          : ref === 'pinky' ? towardPinky(side) : rigFwd.clone();
    const wantVec = (want, side) =>
      want === 'back' ? rigFwd.clone().negate()
        : want === 'palm' ? palmN.clone()
          : want === 'pinky' ? towardPinky(side) : rigFwd.clone();

    const localOf = (body, worldPos) => {
      const t = body.getCenterOfMassTransform();
      const o = t.getOrigin(), r = t.getRotation();
      return worldPos.clone().sub(_v.set(o.x(), o.y(), o.z()))
        .applyQuaternion(_q.set(r.x(), r.y(), r.z(), r.w()).invert()).clone();
    };

    const addJoint = ({ name, parentBody, childBody, parentRestOrigin, childRestOrigin,
      restAt, liveAt, boneDir, spec, side, spring }) => {
      const S = JOINT_SPECS[spec];
      // X: primary swing axis
      let x = new THREE.Vector3().crossVectors(boneDir, refVec(S.ref, side));
      if (x.lengthSq() < 1e-6) x.crossVectors(boneDir, rigLat);
      if (x.lengthSq() < 1e-6) x.copy(rigLat);
      x.normalize();
      const y = boneDir.clone().normalize();
      const z = new THREE.Vector3().crossVectors(x, y).normalize();
      x.crossVectors(y, z).normalize();               // re-orthogonalise
      const basis = new THREE.Quaternion().setFromRotationMatrix(_m4.makeBasis(x, y, z));

      // signed X range: which way does +X rotation move the child's tip?
      let xlo, xhi;
      if (S.flex != null) {
        const move = new THREE.Vector3().crossVectors(x, boneDir);
        const positiveFlexes = move.dot(wantVec(S.want, side)) > 0;
        xlo = (positiveFlexes ? -S.ext : -S.flex) * DEG;
        xhi = (positiveFlexes ? S.flex : S.ext) * DEG;
      } else {
        xlo = S.x[0] * DEG; xhi = S.x[1] * DEG;
      }
      const lo = [xlo, -S.twist * DEG, S.z[0] * DEG];
      const hi = [xhi, S.twist * DEG, S.z[1] * DEG];

      // born excursion per axis, in the joint basis — a joint must contain
      // the pose it was born in.
      // ⚠️ ONE getRotation() PER STATEMENT: ammo's value-returning methods
      // hand back a single static temporary per method, so holding two
      // results before reading makes them alias — rel computed from a held
      // pair is ALWAYS identity, which silently disabled this widening (and
      // the jointAngles instrument, vacuously greening the limits gate).
      // Consume each into a THREE object before the next call.
      quatOf2(parentBody, _q);
      quatOf2(childBody, _qp);
      const rel = _q.invert().multiply(_qp);
      const relF = basis.clone().invert().multiply(rel).multiply(basis);
      const eul = new THREE.Euler().setFromQuaternion(relF, 'XYZ');
      const born = [eul.x, eul.y, eul.z];
      for (let i = 0; i < 3; i++) {
        lo[i] = Math.min(lo[i], born[i] - BUILD_WIDEN);
        hi[i] = Math.max(hi[i], born[i] + BUILD_WIDEN);
      }

      // CENTER THE RANGE ON THE FRAME. Bullet's angular limit logic wraps the
      // measured Euler angle to whichever representation violates least, so a
      // wide one-sided range like the knee's (−145°, +7°) has a wrap midpoint
      // at (hi+lo+2π)/2 ≈ 111° — one contact impulse on a light shin crosses
      // it inside a substep, and from there the limit HOLDS the joint on the
      // wrong side (measured: knees pinned at +145° hyperextension, sustained
      // — antra's "knees bend only backwards", live, 2026-08-10). Rotating the
      // PARENT frame by the range midpoint makes every range symmetric and
      // pushes the wrap point to 180°: the same forbidden-way shove that ran
      // to 145° then stops at 7°, and a 10× kick still does.
      const mid = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2];
      const midQ = new THREE.Quaternion().setFromEuler(new THREE.Euler(mid[0], mid[1], mid[2], 'XYZ'));
      const basisA = basis.clone().multiply(midQ);

      // frames: basis from rest anatomy (parent's carries the centering),
      // origin from the live anchor
      const mkFrame = (body, frameBasis) => {
        const tr = keep(new AMMO.btTransform());
        tr.setIdentity();
        const o = localOf(body, liveAt);
        _bv2.setValue(o.x, o.y, o.z); tr.setOrigin(_bv2);
        _bq1.setValue(frameBasis.x, frameBasis.y, frameBasis.z, frameBasis.w);
        tr.setRotation(_bq1);
        return tr;
      };
      const fa = mkFrame(parentBody, basisA);
      const fb = mkFrame(childBody, basis);
      const C = spring ? AMMO.btGeneric6DofSpringConstraint : AMMO.btGeneric6DofConstraint;
      const con = keep(new C(parentBody, childBody, fa, fb, true));
      _bv1.setValue(0, 0, 0);
      con.setLinearLowerLimit(_bv1); con.setLinearUpperLimit(_bv1);
      _bv1.setValue(lo[0] - mid[0], lo[1] - mid[1], lo[2] - mid[2]); con.setAngularLowerLimit(_bv1);
      _bv1.setValue(hi[0] - mid[0], hi[1] - mid[1], hi[2] - mid[2]); con.setAngularUpperLimit(_bv1);
      if (spring) {
        for (let ax = 3; ax < 6; ax++) {
          con.enableSpring(ax, true);
          con.setStiffness(ax, FINGER_STIFFNESS);
          con.setDamping(ax, FINGER_DAMPING);
        }
        // the bodies are BUILT in the relaxed pose, so snapshotting the
        // current state is exactly the rest curl (source, verbatim)
        con.setEquilibriumPoint();
        this._springs.push(con);
      }
      for (let ax = 3; ax < 6; ax++) con.setParam(BT_CONSTRAINT_STOP_ERP, ERP_LIMIT, ax);
      this.world.addConstraint(con, true);     // linked pair ignores each other
      this._constraints.push(con);
      this.jointMeta.push({
        name, spec, axisX: x.clone(), axisY: y.clone(), axisZ: z.clone(),
        lo: [...lo], hi: [...hi], born: [...born], mid: [...mid],
        parentBody, childBody, basisA, basisB: basis.clone(),
      });
      return con;
    };

    const metaOf = (ref) => {
      if (ref === 'hips' || ref === 'chest' || TORSO_KEYS.has(ref)) {
        return { body: torsoBody, restOrigin: restTorsoMid };
      }
      return segMeta.get(ref);
    };
    for (const J of CORE_JOINTS) {
      const pm = metaOf(J.parent), cm = metaOf(J.child);
      if (!pm || !cm || pm.body === cm.body) {
        // a skipped joint is a DETACHED body part — the loudest possible
        // physics failure, and it used to happen in total silence
        if (cm && pm !== cm && this.segs.get(J.child)) {
          this.skipped.push(J.at);
          console.warn(`[ammodoll] no joint at ${J.at} — ${J.child} is unattached`);
        }
        continue;
      }
      if (!restP[J.at] || !live[J.at]) continue;
      const cs = this.segs.get(J.child);
      addJoint({
        name: J.at, parentBody: pm.body, childBody: cm.body,
        parentRestOrigin: pm.restOrigin, childRestOrigin: cm.restOrigin,
        restAt: restP[J.at], liveAt: live[J.at],
        boneDir: cs.restB.clone().sub(cs.restA).normalize(),
        spec: J.spec, side: J.at.startsWith('left') ? 'left' : 'right',
        spring: false,
      });
    }

    // ---- fingers: spring phalanges + tendons -------------------------------
    // proximal and intermediate only (rigdef.py: the distal is the measured
    // dead end); each spans its bone to the next; the thumb gets ONE body,
    // Proximal→Distal, its metacarpal fused into the palm like the source's.
    this._fingerSegs = [];
    const fingerBodies = new Map();  // `${side}|${digit}|${lvl}` -> body
    const fingerQuat = new Map();    // same key -> rest→live orientation
    const addFingerBody = (side, digit, lvl, aName, bName, spec, parentRef) => {
      if (!live[aName] || !live[bName] || !restP[aName] || !restP[bName]) return;
      const handMeta = segMeta.get(`${side}Hand|${side}MiddleProximal`);
      if (!handMeta) return;
      const ra = restP[aName], rb2 = restP[bName];
      if (ra.distanceTo(rb2) < 0.005) return;
      const restMid = ra.clone().add(rb2).multiplyScalar(0.5);
      const liveMid = live[aName].clone().add(live[bName]).multiplyScalar(0.5);
      // rest-aligned DOWN THE CHAIN (rapierdoll's zero-roll law): each phalanx
      // composes from its own parent — the proximal from the hand, the
      // intermediate from the proximal — never two independent shortest arcs
      const qParent = (lvl === 2 ? fingerQuat.get(`${side}|${digit}|1`) : null)
        ?? quatOf(`${side}Hand|${side}MiddleProximal`);
      const liveLocal = live[bName].clone().sub(live[aName]).applyQuaternion(qParent.clone().invert());
      const qB = qParent.clone().multiply(
        shortestArc(rb2.clone().sub(ra), liveLocal, new THREE.Quaternion()));
      fingerQuat.set(`${side}|${digit}|${lvl}`, qB);
      const mass = FINGER_MASS_FRAC * massScale * (digit === 'Thumb' ? 1.4 : 1);
      const w = Math.max(0.006, ra.distanceTo(rb2) * 0.22);
      const body = mkBody(mass, liveMid, qB, [boxFor(restMid, ra, rb2, w)], true);
      this.world.addRigidBody(body, G_FINGER, G_STATIC);   // fingers hit the ground only
      const seg = {
        key: `${aName}|${bName}`, a: aName, b: bName, body, torso: false, finger: true,
        restA: ra.clone(), restB: rb2.clone(),
        localA: ra.clone().sub(restMid), localB: rb2.clone().sub(restMid),
        r: w,
      };
      this.segs.set(seg.key, seg);
      segMeta.set(seg.key, { body, restOrigin: restMid });
      this._fingerSegs.push(seg);
      fingerBodies.set(`${side}|${digit}|${lvl}`, body);
      const parentMeta = parentRef ? segMeta.get(parentRef) : handMeta;
      addJoint({
        name: aName, parentBody: parentMeta.body, childBody: body,
        parentRestOrigin: parentMeta.restOrigin, childRestOrigin: restMid,
        restAt: ra, liveAt: live[aName],
        boneDir: rb2.clone().sub(ra).normalize(),
        spec, side, spring: true,
      });
    };
    for (const side of ['left', 'right']) {
      if (!segMeta.get(`${side}Hand|${side}MiddleProximal`)) continue;
      for (const digit of FINGERS) {
        addFingerBody(side, digit, 1,
          `${side}${digit}Proximal`, `${side}${digit}Intermediate`, 'fingerProx', null);
        addFingerBody(side, digit, 2,
          `${side}${digit}Intermediate`, `${side}${digit}Distal`, 'fingerMid',
          `${side}${digit}Proximal|${side}${digit}Intermediate`);
      }
      addFingerBody(side, 'Thumb', 1,
        `${side}ThumbProximal`, `${side}ThumbDistal`, 'thumb', null);
    }
    // tendons: a weak orientation spring between neighbouring fingers at the
    // same level, all axes free (lower > upper = free), spring on X only
    for (const side of ['left', 'right']) {
      for (const lvl of [1, 2]) {
        for (let k = 0; k + 1 < FINGERS.length; k++) {
          const ra = fingerBodies.get(`${side}|${FINGERS[k]}|${lvl}`);
          const rb2 = fingerBodies.get(`${side}|${FINGERS[k + 1]}|${lvl}`);
          if (!ra || !rb2) continue;
          _bt1.setIdentity(); _bt2.setIdentity();
          const con = keep(new AMMO.btGeneric6DofSpringConstraint(ra, rb2, _bt1, _bt2, true));
          _bv1.setValue(1, 1, 1); con.setLinearLowerLimit(_bv1); con.setAngularLowerLimit(_bv1);
          _bv1.setValue(-1, -1, -1); con.setLinearUpperLimit(_bv1); con.setAngularUpperLimit(_bv1);
          con.enableSpring(3, true);
          con.setStiffness(3, FINGER_TENDON);
          con.setDamping(3, 0.9);
          con.setEquilibriumPoint();
          this.world.addConstraint(con, true);
          this._constraints.push(con);
        }
      }
    }

    // ---- the drive table (rapierdoll's law: BOTH references from the live
    // skeleton — refDir must be the direction the bone points in the pose
    // refQuat describes, or every driven bone renders at twice its offset) ---
    this.drive = [];
    for (const seg of this.segs.values()) {
      const bn = node(seg.a);
      const cnPos = live[seg.b];
      if (!bn || !live[seg.a] || !cnPos) continue;
      const refDir = cnPos.clone().sub(live[seg.a]);
      if (refDir.lengthSq() < 1e-8) continue;
      this.drive.push({
        bone: seg.a, child: seg.b, node: bn, parent: bn.parent,
        restDir: refDir.normalize(),
        restQuat: bn.getWorldQuaternion(new THREE.Quaternion()),
      });
    }
    this.drivenBones = new Set(this.drive.map((d) => d.bone));
    this.totalMass = 0;
    for (const part of Object.keys(MASS_FRAC)) {
      const n = part === 'torso' || part === 'head' ? 1 : 2;
      this.totalMass += MASS_FRAC[part] * massScale * n;
    }

    // ---- inherited velocities: recover the SPIN, not just the drift --------
    {
      const samples = new Map();
      for (const s of this.segs.values()) {
        for (const name of [s.a, s.b]) {
          if (!seedV[name] || !live[name]) continue;
          if (!samples.has(s.body)) samples.set(s.body, []);
          const list = samples.get(s.body);
          if (list.some((x2) => x2.name === name)) continue;
          list.push({ name, p: live[name].clone(), v: seedV[name].clone() });
        }
      }
      for (const [body, list] of samples) {
        if (!list.length) continue;
        const t = body.getCenterOfMassTransform().getOrigin();
        const comV = new THREE.Vector3(t.x(), t.y(), t.z());
        let w = new THREE.Vector3();
        if (list.length >= 2) {
          let best = null, bestD = 0;
          for (let i = 0; i < list.length; i++) {
            for (let j2 = i + 1; j2 < list.length; j2++) {
              const d = list[i].p.distanceToSquared(list[j2].p);
              if (d > bestD) { bestD = d; best = [list[i], list[j2]]; }
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
          _bv1.setValue(vc.x, vc.y, vc.z); body.setLinearVelocity(_bv1);
        }
        if (Number.isFinite(w.x) && Number.isFinite(w.y) && Number.isFinite(w.z)) {
          _bv1.setValue(w.x, w.y, w.z); body.setAngularVelocity(_bv1);
        }
      }
    }

    this.rootStartY = avatar.root.position.y;
    this._rootBaseY = avatar.root.position.y;

    if (lean) this._topple(lean);
    this._syncP();
    // measured against the sim's OWN hips (the rest-shaped torso reconstructs
    // p.hips a few mm off the live skeleton's — rapierdoll's frame-one jump)
    this.hipsOffset = (this.p.hips?.y ?? live.hips?.y ?? 0) - avatar.root.position.y;
  }

  // ---------------------------------------------------------------- instruments
  // (not used by the sim; the suite asserts on them — metrics that only ask
  // "is it finite / did it settle" cannot see an anatomy failure)

  /** Live per-axis joint angles against their bounds, in the joint basis. */
  jointAngles() {
    const out = [];
    for (const J of this.jointMeta) {
      // one getRotation per statement — see quatOf2
      quatOf2(J.parentBody, _q);
      quatOf2(J.childBody, _qp);
      const rel = _q.invert().multiply(_qp);
      // measure in the constraint's own frames (parent carries the range
      // centering), then report in ANATOMICAL coordinates by adding the
      // midpoint back — lo/hi here are the anatomical table values
      const relF = J.basisA.clone().invert().multiply(rel).multiply(J.basisB);
      const eul = new THREE.Euler().setFromQuaternion(relF, 'XYZ');
      const ang = [eul.x + J.mid[0], eul.y + J.mid[1], eul.z + J.mid[2]];
      out.push({
        name: J.name, spec: J.spec, angles: ang, lo: J.lo, hi: J.hi,
        over: Math.max(...ang.map((a2, i) => Math.max(J.lo[i] - a2, a2 - J.hi[i], 0))),
      });
    }
    return out;
  }

  /** The flexion axes as BUILT (rest/world coordinates) with their signed
   *  ranges — the axis-roles surface the suite checks anatomy against. */
  flexAxes() {
    return this.jointMeta.map((J) => ({
      name: J.name, spec: J.spec,
      axisX: J.axisX.clone(), axisY: J.axisY.clone(), axisZ: J.axisZ.clone(),
      lo: J.lo, hi: J.hi, born: J.born,
    }));
  }

  massSplit() {
    let torso = 0, total = 0;
    const seen = new Set();
    for (const s of this.segs.values()) {
      if (seen.has(s.body)) continue;
      seen.add(s.body);
      const m = this._massOf.get(s.body) ?? 0;
      total += m;
      if (s.torso) torso += m;
    }
    return { torso, total, frac: total > 0 ? torso / total : 0 };
  }

  // ---------------------------------------------------------------- dynamics

  _topple(lean) {
    let lo = Infinity, hi = -Infinity;
    for (const body of this._cores) {
      const y = body.getCenterOfMassTransform().getOrigin().y();
      lo = Math.min(lo, y); hi = Math.max(hi, y);
    }
    const span = (hi - lo) || 1;
    _v.copy(lean);
    const cap = 8;
    if (_v.lengthSq() > cap * cap) _v.setLength(cap);
    for (const body of this._cores) {
      const t = body.getCenterOfMassTransform().getOrigin();
      const w = (t.y() - lo) / span;
      const cur = body.getLinearVelocity();
      _bv1.setValue(cur.x() + _v.x * w, cur.y(), cur.z() + _v.z * w);
      body.setLinearVelocity(_bv1);
      body.activate();
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
      for (const j of [...this._pinCons.keys()]) this.setPin(j, null);
      return;
    }
    const seg = [...this.segs.values()].find((s) => s.a === joint || s.b === joint);
    if (!seg) return;
    if (!target) {
      const pin = this._pinCons.get(joint);
      if (pin) {
        this.world.removeConstraint(pin.con);
        AMMO.destroy(pin.con);
        const i = this._refs.indexOf(pin.con);
        if (i >= 0) this._refs.splice(i, 1);
        this._pinCons.delete(joint);
        this.pins.delete(joint);
      }
      // the lift ceiling is a LEASE, not a ratchet
      if (this._pinCons.size === 0) this.rootStartY = this._rootBaseY;
      return;
    }
    let pin = this._pinCons.get(joint);
    if (!pin) {
      // a p2p with a hard impulse clamp: a distant target PULLS the body at
      // bounded force instead of teleporting it (the clamp is the source's
      // whole grab feel, and its stability)
      const anchor = (seg.a === joint ? seg.localA : seg.localB);
      // seg.local* are rest-local = body-local (rest-aligned bodies)
      _bv1.setValue(anchor.x, anchor.y, anchor.z);
      const con = new AMMO.btPoint2PointConstraint(seg.body, _bv1);
      con.get_m_setting().set_m_impulseClamp(this.totalMass * PIN_CLAMP_X);
      con.get_m_setting().set_m_tau(PIN_TAU);
      this.world.addConstraint(con, false);
      this._refs.push(con);
      pin = { con, body: seg.body };
      this._pinCons.set(joint, pin);
      this.pins.set(joint, new THREE.Vector3());
    }
    this.pins.get(joint).copy(target);
    _bv1.setValue(target.x, target.y, target.z);
    pin.con.setPivotB(_bv1);
    for (const body of this._bodies) body.activate();
  }

  get pinned() { return this.pins.size > 0; }

  /** Drag-release handover, the house packed format: joint names + positions
   *  + endpoint velocities (v + ω × r from the centre of mass). */
  snapshot() {
    // {j:[],p:[],v:[]} would be TRUTHY on `seedVel?.j` — say nothing instead
    if (this._freed) return null;
    this._syncP();
    const j = [], p = [], v = [];
    const seen = new Set();
    for (const s of this.segs.values()) {
      if (s.finger) continue;          // the wire carries the core skeleton
      const t = s.body.getCenterOfMassTransform().getOrigin();
      const lv = s.body.getLinearVelocity(), av = s.body.getAngularVelocity();
      for (const name of [s.a, s.b]) {
        if (seen.has(name) || !this.p[name]) continue;
        seen.add(name);
        const q2 = this.p[name];
        j.push(name);
        p.push(+q2.x.toFixed(4), +q2.y.toFixed(4), +q2.z.toFixed(4));
        _a.set(q2.x - t.x(), q2.y - t.y(), q2.z - t.z());
        _b.set(av.x(), av.y(), av.z()).cross(_a).add(_v.set(lv.x(), lv.y(), lv.z()));
        v.push(+_b.x.toFixed(3), +_b.y.toFixed(3), +_b.z.toFixed(3));
      }
    }
    return { j, p, v };
  }

  _syncP() {
    for (const s of this.segs.values()) {
      const t = s.body.getCenterOfMassTransform();
      const o = t.getOrigin(), r = t.getRotation();
      _qp.set(r.x(), r.y(), r.z(), r.w());
      _a.copy(s.localA).applyQuaternion(_qp);
      (this.p[s.a] ??= new THREE.Vector3()).set(o.x() + _a.x, o.y() + _a.y, o.z() + _a.z);
      _a.copy(s.localB).applyQuaternion(_qp);
      (this.p[s.b] ??= new THREE.Vector3()).set(o.x() + _a.x, o.y() + _a.y, o.z() + _a.z);
    }
  }

  step(dt) {
    if (this.done) return null;
    dt = Math.min(0.25, Math.max(0, dt || 0));
    if (dt > 0) this.world.stepSimulation(dt, MAX_SUBSTEPS, FIXED_DT);

    // angular ceiling: nothing anatomical rotates at 20 rad/s, and residual
    // solver energy hides there first
    for (const body of this._cores) {
      const w = body.getAngularVelocity();
      const m = Math.hypot(w.x(), w.y(), w.z());
      if (m > ANG_CEIL) {
        const k = ANG_CEIL / m;
        _bv1.setValue(w.x() * k, w.y() * k, w.z() * k);
        body.setAngularVelocity(_bv1);
      }
    }

    // settle is LINEAR AND ANGULAR, over the CORE bodies — fingers are 20 g
    // springs and twitch at amplitudes the wire never sees; the source pinned
    // them quiet with island sleeping, we keep them out of the metric instead
    let maxSpeed = 0, maxSpin = 0;
    for (const body of this._cores) {
      const v = body.getLinearVelocity(), w = body.getAngularVelocity();
      maxSpeed = Math.max(maxSpeed, Math.hypot(v.x(), v.y(), v.z()));
      maxSpin = Math.max(maxSpin, Math.hypot(w.x(), w.y(), w.z()));
    }
    this.maxV = maxSpeed;
    this.maxW = maxSpin;

    this.elapsed += dt;
    if (this.pinned) { this.settledFor = 0; this.elapsed = 0; }
    if (this.maxV < SETTLE_V && this.maxW < SETTLE_W) this.settledFor += dt;
    else this.settledFor = 0;

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

    // bones: rest direction → live direction, world-reference, parents first
    // (drive is in construction order: torso out to fingertips). The node's
    // POSITION is never written — solver error must stretch a joint, not the
    // mesh (the source drives fingers rotation-only for the same reason).
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

  /** Free every WASM object this instance created — Bullet objects do not
   *  garbage-collect. Safe to call twice; called automatically at capture. */
  dispose() {
    if (this._freed) return;
    this._freed = true;
    this.done = true;
    try {
      for (const c of this._constraints) this.world.removeConstraint(c);
      for (const [, pin] of this._pinCons) this.world.removeConstraint(pin.con);
      for (const b of this._bodies) this.world.removeRigidBody(b);
      for (const b of this._statics) this.world.removeRigidBody(b);
    } catch { /* half-built world */ }
    for (let i = this._refs.length - 1; i >= 0; i--) {
      try { AMMO.destroy(this._refs[i]); } catch { /* already gone */ }
    }
    this._refs.length = 0;
    this._constraints.length = 0;
    this._bodies.length = 0;
    this._cores.length = 0;
    this._statics.length = 0;
    this.segs.clear();
    this._pinCons.clear();
    this.pins.clear();
    this.world = null;
  }
}
