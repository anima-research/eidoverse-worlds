// ammodoll-tuning — the Bullet ragdoll's numbers and tables: masses, damping, the joint table, hair and wing tuning,
// the body cut and the collision bits. debug.js retunes HAIR_TUNING, WING_TUNING and JOINT_SPECS live.
import { SEGMENTS } from './rigmeasure.js';

export const DEG = Math.PI / 180;

// Dempster's segment fractions (rigdef.py BODIES). Not mass from proxy volume: a 0.4 kg pelvis whips like a bead.
export const MASS_FRAC = {
  torso: 0.14 + 0.14 + 0.16,   // the degenerate no-spine-bones trunk
  pelvis: 0.14, spineSeg: 0.14, chestSeg: 0.16,   // rigdef.py's rows, used apart
  head: 0.081,
  upperArm: 0.028, lowerArm: 0.016, hand: 0.006,
  upperLeg: 0.100, lowerLeg: 0.047, foot: 0.015,
};
// trunk depth as a fraction of its half-width (the source's proxy boxes: nearly as deep as broad)
export const TRUNK_DEPTH = 0.88;
export const REAL_H = 1.70;            // rigdef.py: reference height for the mass budget
export const BODY_KG = 62.0;           // at REAL_H, scaled by (H/1.70)³
export const FINGER_MASS_FRAC = 0.0016; // per phalanx body (~100 g at 62 kg); thumb ×1.4

export const FINGER_STIFFNESS = 12.0;  // rigdef.py, measured sag plateau
export const FINGER_DAMPING = 0.9;
export const FINGER_TENDON = 8.0;

export const ERP_LIMIT = 0.35;         // source default: how hard limits are held
export const BT_CONSTRAINT_STOP_ERP = 3; // this build's setParam id (source, verbatim)
export const ACTIVE_TAG = 1;
// Bullet's own enum values (ammo.js does not export them)
export const CF_KINEMATIC = 2;            // btCollisionObject::CF_KINEMATIC_OBJECT
export const DISABLE_DEACTIVATION = 4;    // never sleep — a kinematic anchor must not

export const LIN_DAMP = 0.12;          // source setDamping(0.12, —)
export const ANG_DAMP = 0.7;           // 0.7, not the source's 0.45: at 0.45 hands and head ring indefinitely and never sleep
export const ANG_DAMP_FINGER = 0.95;   // spring-driven ~100 g boxes: dissipate hard
export const LIN_DAMP_FINGER = 0.3;
export const FRICTION = 0.85;
export const RESTITUTION = 0.03;

export const FIXED_DT = 1 / 120;       // source stepSimulation(dt, 8, 1/120)
export const MAX_SUBSTEPS = 8;
export const SETTLE_V = 0.07;          // the house settle law
export const SETTLE_W = 0.6;
export const SETTLE_TIME = 0.45;
export const DEADLINE = 8;
export const ANG_CEIL = 20;            // rad/s backstop
export const BUILD_WIDEN = 0.12;       // rad of slack over the born excursion
export const PIN_TAU = 0.9;            // source: the shift-click pin, held firm
export const PIN_CLAMP_X = 8;          // × total mass
// the source's other setting, for a hand rather than a nail (a nail-stiff grab overpowers the joint stops)
export const GRAB_TAU = 0.4;
export const GRAB_CLAMP_X = 1.2;       // × total mass

/** Hair tuning, live (retuneHair). Tuned in-world by eye: docs/research/ammodoll-tuning.md § Hair. */
export const HAIR_TUNING = {
  mass: 0.003,      // kg per segment
  tension: 7.25,    // 6DOF angular spring stiffness
  damping: 0.31,    // both the spring's and the body's angular damping
  gravity: 0.45,    // fraction of world gravity
  limit: 25,        // degrees at the TIP
  rootExp: 1.2,     // ramp exponent: lim = limit * (j/n)^rootExp
};

/** Wing tuning, live (retuneWings). Same shape as HAIR_TUNING; the target is dead weight that swings from the
 *  shoulder and trails the body. Measured: docs/research/ammodoll-tuning.md § Wings. */
export const WING_TUNING = {
  mass: 0.55,       // kg per segment (a 20 g plate a metre long is all lever and reads as paper)
  tension: 8,       // 6DOF angular spring stiffness
  damping: 0.15,    // the spring's and the body's angular damping (Bullet's spring damping is a velocity gain: more = snappier)
  gravity: 1.0,     // fraction of world gravity
  limit: 70,        // degrees at the outermost segment
  rootExp: 1.0,     // ramp exponent: lim = limit * ((j+1)/n)^rootExp
};

// The anatomical joint table: the source's rigdef.py JOINTS in degrees on the basis addJoint builds (Y = bone/twist,
// X = primary swing, Z = the other swing). Directional rows carry flex/ext and `want` (which way flexion moves the
// child's tip); X's sign is derived from the built axis, since the two sides mirror. `ref`: what X is crossed
// against. Tuned by hand in-world (debug.js retunes running constraints); a ragdoll with no muscle tone spends
// all of a living spine's range. Twist 0 / z [0,0] lock an axis, exempt from the born-widening.
export const JOINT_SPECS = {
  spine: { ref: 'fwd', x: [-10, 10], twist: 0, z: [-4, 4] },
  chest: { ref: 'fwd', x: [-20, 20], twist: 0, z: [-6, 6] },
  head: { ref: 'fwd', x: [-33, 33], twist: 24, z: [-19, 19] },
  upperArm: { ref: 'fwd', x: [-85, 85], twist: 56, z: [-85, 85] },
  lowerArm: { ref: 'fwd', flex: 145, ext: 2, want: 'fwd', twist: 5, z: [-5, 5] },
  hand: { ref: 'palm', flex: 45, ext: 45, want: 'palm', twist: 8, z: [-15, 15] },
  upperLeg: { ref: 'fwd', flex: 90, ext: 8, want: 'fwd', twist: 0, z: [-13, 13] },
  lowerLeg: { ref: 'fwd', flex: 123, ext: 0, want: 'back', twist: 3, z: [0, 0] },
  foot: { ref: 'up', x: [-35, 35], twist: 12, z: [-12, 12] },
  fingerProx: { ref: 'palm', flex: 90, ext: 6, want: 'palm', twist: 8, z: [-12, 12] },
  fingerMid: { ref: 'palm', flex: 100, ext: 0, want: 'palm', twist: 4, z: [-4, 4] },
  thumb: { ref: 'pinky', flex: 55, ext: 10, want: 'pinky', twist: 12, z: [-25, 25] },
};

// The body cut is rigmeasure.js's SEGMENTS (one table for both engines). Here the torso rows are the trunk bodies
// (TORSO_KEYS), hands and feet are extra segments, and the fingers ride on the hands.
export const TORSO_KEYS = new Set(['hips|spine', 'spine|chest', 'chest|neck']);
export const CORE_SEGMENTS = SEGMENTS;
export const EXTRA_SEGMENTS = [
  { a: 'leftHand', b: 'leftMiddleProximal', part: 'hand' },
  { a: 'rightHand', b: 'rightMiddleProximal', part: 'hand' },
  { a: 'leftFoot', b: 'leftToes', part: 'foot' },
  { a: 'rightFoot', b: 'rightToes', part: 'foot' },
];
export const CORE_JOINTS = [
  { at: 'spine', parent: 'hips|spine', child: 'spine|chest', spec: 'spine' },
  { at: 'chest', parent: 'spine|chest', child: 'chest|neck', spec: 'chest' },
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
// VRM humanoid digit names; the tendon chain couples them in this order (thumb excluded: no shared tendon)
export const FINGERS = ['Index', 'Middle', 'Ring', 'Little'];

// Collision filter bits: (groupA & maskB) && (groupB & maskA), frozen at addRigidBody. ammo.js declares group and
// mask as SHORT, so the budget is 15 bits: bit 0 statics, bits 1..12 the core bodies that self-collide (3 trunk +
// head + 8 limb segments; hands and feet ride their parent limb's bit), bit 14 everything that only wants the
// ground. A group above bit 14 truncates to 0 and collides with nothing.
export const G_STATIC = 1;
export const G_FINGER = 1 << 14;
export const BODY_BITS = 12;
export const FILTER_MAX = 1 << 14;    // anything above this does not survive the call
