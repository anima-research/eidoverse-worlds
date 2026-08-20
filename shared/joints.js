// shared/joints.js — what a humanoid joint may do, as measured.
//
// These tables were measured against the shipped rigs by the ragdoll (see
// tools/ragdoll-test.ts, which runs them on all 14). They lived in
// client/lib/ragdoll.js until the reach solver needed the same numbers, and a
// second copy would have been the exact "mirrored math" this directory exists
// to retire: an arm that can REACH where it could never FALL is two different
// bodies wearing one skin. One table, two consumers — the particle sim clamps
// to it while tumbling, the IK clamps to it while reaching.
//
// Angles are DEGREES here, as authored and as commented. Consumers convert.
// Pure data plus one derivation; no THREE, no scene graph.

// BEHIND — how far a limb may point behind the body's frontal plane.
//
// The CONE is circular, so it cannot express the one shape a hip actually has:
// a long way forward, barely anything backward, and a moderate amount out to
// the side. Tilting the cone forward far enough to bound the back also walls
// off abduction, because it moves the whole envelope. A separate one-sided
// plane says exactly the intended thing and nothing else. Without it the fleet
// put its thighs 46° behind the body — the pose you would need a chair to hold.
export const BEHIND = [
  ['leftUpperLeg', 'leftLowerLeg', 30],
  ['rightUpperLeg', 'rightLowerLeg', 30],
  ['leftUpperArm', 'leftLowerArm', 65],       // a shoulder does reach back
  ['rightUpperArm', 'rightLowerArm', 65],
];

// CONE — the limb's direction relative to the BODY, not to its parent link.
// A shoulder and a hip are ball joints; what bounds them is where the limb
// points relative to the torso, and anchoring to the torso is also what makes
// the limit mean the same thing on a T-pose rig and an A-pose one.
// `tilt` leans the cone axis forward, because a hip is not symmetric: the
// thigh swings far forward and barely backward.
export const CONE = [
  // bone           child            half°  tilt° (toward body forward)
  ['leftUpperArm',  'leftLowerArm',   85,    0],
  ['rightUpperArm', 'rightLowerArm',  85,    0],
  ['leftUpperLeg',  'leftLowerLeg',   55,   25],
  ['rightUpperLeg', 'rightLowerLeg',  55,   25],
];

// HINGE — a knee bends backward and an elbow bends forward, and neither bends
// sideways. That is a SIGNED constraint, so it needs a handedness the particles
// alone don't carry; _frame derives one from the rig. `dir` is which way the
// joint is allowed to fold, along the body's forward axis.
// `sideways` is slop, not a range — a hinge has no sideways travel at all, and
// every degree given here shows up on screen as a knee bending out of its own
// plane. It cannot go to zero: this model has no hip or shoulder ROTATION, so
// a limb that has twisted has nowhere to put it but here. These are the
// smallest values the fleet stays stable at.
// TWIST — a bone's roll about its own length, as REAL STATE.
//
// The particle sim gives directions, never roll, so roll has to come from
// somewhere. Deriving it against the WORLD (a fixed rest direction, or a
// carried reference) drifts: parallel transport has holonomy, so a limb swung
// around a loop comes back rotated by the solid angle it enclosed, and a
// tumbling arm encloses a lot of sphere. Measured that way, upper arms ended a
// tumble 144° rolled and stayed there.
//
// Deriving it against the PARENT does not drift, because it is a function of
// the current state and not of the path taken to reach it. The one place that
// construction could fail is a bone swung a full 180° from its parent, and the
// joint limits above already forbid that — the hinges stop at 150°, the cones
// at 55-85°, the spine at 25°. The limits are what make this well posed.
//
// What is left over is genuine twist, and it is a state variable with inertia,
// damping, a spring back to neutral and a hard stop, like every other joint
// quantity here. With no driver it sits at zero, which is the right answer for
// a limp limb in a model that carries no angular momentum about a bone's own
// axis — and zero is exactly what the parent-relative frame makes reachable.
// Measured, limb twist at settle: 97° mean and 172° worst before, 0° now, on
// every driven bone but the pelvis (whose "twist" is the body's own roll and
// belongs there). `max` is the stop, in degrees: shoulders and forearms turn a
// lot, spines and shins hardly at all.
export const TWIST = {
  spine: 25, chest: 25, neck: 45,
  leftUpperArm: 75, rightUpperArm: 75,
  leftLowerArm: 80, rightLowerArm: 80,     // pronation/supination
  leftUpperLeg: 40, rightUpperLeg: 40,
  leftLowerLeg: 25, rightLowerLeg: 25,
};
// Which bone each one twists AGAINST. The drive walks CHAINS parents-first, so
// a parent's frame is always resolved before its children ask for it.
export const TWIST_PARENT = {
  spine: 'hips', chest: 'spine', neck: 'chest',
  leftUpperArm: 'chest', rightUpperArm: 'chest',
  leftLowerArm: 'leftUpperArm', rightLowerArm: 'rightUpperArm',
  leftUpperLeg: 'hips', rightUpperLeg: 'hips',
  leftLowerLeg: 'leftUpperLeg', rightLowerLeg: 'rightUpperLeg',
};

export const HINGE = [
  // a               b                 c            dir  maxFlex°  sideways°
  ['leftUpperArm',  'leftLowerArm',  'leftHand',    +1,   145,      12],
  ['rightUpperArm', 'rightLowerArm', 'rightHand',   +1,   145,      12],
  ['leftUpperLeg',  'leftLowerLeg',  'leftFoot',    -1,   150,       6],
  ['rightUpperLeg', 'rightLowerLeg', 'rightFoot',   -1,   150,       6],
];

/** Radians. */
export const D2R = Math.PI / 180;

/**
 * The cone axis for one bone, in BODY-FRAME coordinates: the bone's own rest
 * direction, leaned `tilt` degrees toward forward.
 *
 * Storing it body-relative is what makes one number mean the same thing on a
 * T-pose rig and an A-pose one — the cone is centred on where THAT rig's limb
 * actually rests, and turns with the torso rather than with the world.
 *
 * @param {number[]} restDirBody bone->child rest direction, already expressed
 *        in body-frame coordinates [right, up, forward]
 * @param {number} tiltDeg lean toward forward, degrees
 * @returns {number[]} unit axis in body-frame coordinates
 */
export function coneAxisBody(restDirBody, tiltDeg) {
  const a = [...restDirBody];
  if (tiltDeg) {
    // the forward component perpendicular to the axis, so the lean is a pure
    // rotation in the sagittal plane rather than a shortening
    const f = [-a[2] * a[0], -a[2] * a[1], 1 - a[2] * a[2]];
    const fl = Math.hypot(f[0], f[1], f[2]);
    if (fl > 1e-4) {
      const t = Math.tan(tiltDeg * D2R) / fl;
      a[0] += f[0] * t; a[1] += f[1] * t; a[2] += f[2] * t;
    }
  }
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
}

/** The limits for one bone, gathered from the tables above into the shape
 *  shared/reach.js wants. Angles come out in RADIANS. */
export function limitsFor(bone) {
  const cone = CONE.find((c) => c[0] === bone);
  const behind = BEHIND.find((b) => b[0] === bone);
  const hinge = HINGE.find((h) => h[0] === bone);
  return {
    ...(cone ? { coneHalf: cone[2] * D2R, coneTilt: cone[3] } : {}),
    ...(behind ? { behind: behind[2] * D2R } : {}),
    ...(hinge ? { maxFlex: hinge[4] * D2R, hingeDir: hinge[3], hingeSide: hinge[5] * D2R } : {}),
    ...(TWIST[bone] != null ? { twistMax: TWIST[bone] * D2R } : {}),
    ...(TWIST_PARENT[bone] ? { twistParent: TWIST_PARENT[bone] } : {}),
  };
}

/** The two-bone chains a reach can drive, root -> mid -> end. */
export const REACH_CHAINS = {
  leftHand:  { root: 'leftUpperArm',  mid: 'leftLowerArm',  end: 'leftHand' },
  rightHand: { root: 'rightUpperArm', mid: 'rightLowerArm', end: 'rightHand' },
  leftFoot:  { root: 'leftUpperLeg',  mid: 'leftLowerLeg',  end: 'leftFoot' },
  rightFoot: { root: 'rightUpperLeg', mid: 'rightLowerLeg', end: 'rightFoot' },
};

/**
 * The body's own axes from a set of rest bone positions: right, up, forward.
 *
 * Same construction as the ragdoll's `_frame` — the pelvis bar for right, hips
 * to head for up, their cross for forward, then re-orthogonalize right. It is
 * NOT the same function: the ragdoll's is stateful on purpose (it keeps the
 * last good forward through a fold where the spine lies along the pelvis bar,
 * because a hinge whose handedness jumps mid-tumble is how a knee decides it
 * bends the wrong way). A reach solves from the REST pose, which is never
 * degenerate, so this one is pure and has nothing to remember.
 *
 * @param {Record<string, number[]>} P bone -> [x,y,z]
 * @returns {{r: number[], u: number[], f: number[]}|null}
 */
export function bodyFrame(P) {
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const cross = (a, b) => [
    a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const norm = (a) => { const l = Math.hypot(a[0], a[1], a[2]); return l > 1e-5 ? [a[0] / l, a[1] / l, a[2] / l] : null; };

  let r = (P.leftUpperLeg && P.rightUpperLeg) ? norm(sub(P.leftUpperLeg, P.rightUpperLeg))
        : (P.leftUpperArm && P.rightUpperArm) ? norm(sub(P.leftUpperArm, P.rightUpperArm)) : null;
  let u = (P.head && P.hips) ? norm(sub(P.head, P.hips))
        : (P.chest && P.hips) ? norm(sub(P.chest, P.hips)) : null;
  r ??= [1, 0, 0];
  u ??= [0, 1, 0];
  const f = norm(cross(r, u));
  if (!f) return null;
  const r2 = norm(cross(u, f)) ?? r;
  return { r: r2, u, f };
}

/** A world-space direction, expressed in body-frame coordinates. */
export const toBody = (v, F) => [
  v[0] * F.r[0] + v[1] * F.r[1] + v[2] * F.r[2],
  v[0] * F.u[0] + v[1] * F.u[1] + v[2] * F.u[2],
  v[0] * F.f[0] + v[1] * F.f[1] + v[2] * F.f[2],
];

/** ...and back out again. */
export const fromBody = (b, F) => [
  b[0] * F.r[0] + b[1] * F.u[0] + b[2] * F.f[0],
  b[0] * F.r[1] + b[1] * F.u[1] + b[2] * F.f[1],
  b[0] * F.r[2] + b[1] * F.u[2] + b[2] * F.f[2],
];

// Self-collision radii, as fractions of the torso radius. The torso radius
// itself is MEASURED from the body (shoulder/hip span) so this scales to any
// avatar — a bulky one gets fatter colliders than a slim one. Anatomical
// fractions give limbs their taper: a wrist is thinner than a hip.
export const RADIUS_FRAC = {
  hips: 1.0, spine: 0.95, chest: 1.0, neck: 0.5, head: 0.75,
  leftUpperArm: 0.5, rightUpperArm: 0.5, leftLowerArm: 0.35, rightLowerArm: 0.35,
  leftHand: 0.3, rightHand: 0.3,
  leftUpperLeg: 0.55, rightUpperLeg: 0.55, leftLowerLeg: 0.4, rightLowerLeg: 0.4,
  leftFoot: 0.35, rightFoot: 0.35,
};


/**
 * A body's torso half-thickness, MEASURED — the same derivation the ragdoll
 * uses, so a reach and a fall disagree about nothing. Half the wider of the
 * shoulder or hip span; a fraction of the spine if the limbs are missing.
 *
 * @param {Record<string, number[]>} P rest bone positions
 */
export function torsoRadius(P) {
  const d = (a, b) => (P[a] && P[b]
    ? Math.hypot(P[a][0] - P[b][0], P[a][1] - P[b][1], P[a][2] - P[b][2]) : 0);
  const shoulderW = d('leftUpperArm', 'rightUpperArm');
  const hipW = d('leftUpperLeg', 'rightUpperLeg');
  const spineLen = d('hips', 'head') || 0.5;
  return Math.min(0.25, Math.max(0.05, (Math.max(shoulderW, hipW) * 0.42) || spineLen * 0.26));
}

/** Capsule radius for one bone on a body of the given torso radius. */
export const boneRadius = (bone, torsoR) => torsoR * (RADIUS_FRAC[bone] ?? 0.4);

/** The segments a reaching arm must not pass through: the torso column, the
 *  head, the thighs, and the OTHER arm. Chain-owned bones are excluded by the
 *  caller — a limb cannot collide with itself. */
export const GUARD_SEGMENTS = [
  ['hips', 'spine'], ['spine', 'chest'], ['chest', 'neck'], ['neck', 'head'],
  ['hips', 'leftUpperLeg'], ['hips', 'rightUpperLeg'],
  ['leftUpperLeg', 'leftLowerLeg'], ['rightUpperLeg', 'rightLowerLeg'],
  ['leftUpperArm', 'leftLowerArm'], ['rightUpperArm', 'rightLowerArm'],
  ['leftLowerArm', 'leftHand'], ['rightLowerArm', 'rightHand'],
];
