// ammodoll — the Bullet body engine, ported from socketteer/ragdoll-physics.
// Same interface as Ragdoll — THE engine contract is stated on
// BodyEngineBase (bodyengine.js), which both engines extend; the shared
// measurement/format truths live in rigmeasure.js. The rapierdoll laws this
// file credits throughout are the retired third engine's.
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
import { nearColliders } from './colliders.js';
import { SEGMENTS, segDistance, rigFrameOf, snapshotPacker, seedJoints } from './rigmeasure.js';
import { BodyEngineBase } from './bodyengine.js';

let AMMO = null;
let ammoLoading = null;
/** The real inertia of a set of child boxes, about the body origin.
 *
 *  btCompoundShape::calculateLocalInertia is documented in Bullet's own source
 *  as "approximation: take the inertia from the aabb" — and every limb box here
 *  is ROTATED inside its compound (a body's local axes are rest-aligned, not
 *  bone-aligned), so that AABB is much larger than the box it stands for.
 *  Measured on this rig's forearm at 45 degrees off axis, the approximation is
 *  4.75x the true inertia ABOUT THE BONE — which is the twist axis, the one
 *  with the tightest limits (elbow and knee twist are +/-5 degrees). A joint
 *  whose twist inertia is five times too heavy is mis-weighted against its
 *  neighbour in every solver iteration, so the stop does not hold: the limit is
 *  pushed through and then dragged back, which reads as a limb twisting further
 *  than it should and then untwisting itself.
 *
 *  So compute it properly: exact box tensor, rotated by the child's own
 *  rotation, parallel-axis shifted to the body origin, summed, mass split by
 *  volume. Bullet can only carry a DIAGONAL local inertia, so the off-diagonal
 *  terms are dropped at the end — but the diagonal of the true tensor is a far
 *  better answer than the tensor of a box nobody has. The playground this was
 *  ported from never needed any of it: its bodies are a single btBoxShape
 *  aligned to the bone, where calculateLocalInertia is exact.
 */
function boxesInertia(boxes, mass) {
  let vol = 0;
  for (const b of boxes) vol += 8 * b.he.x * b.he.y * b.he.z;
  if (!(vol > 0)) return { x: 0, y: 0, z: 0 };
  // accumulate the full 3x3, symmetric
  let xx = 0, yy = 0, zz = 0;
  const m3 = new THREE.Matrix3();
  for (const b of boxes) {
    const m = mass * (8 * b.he.x * b.he.y * b.he.z) / vol;
    const x = 2 * b.he.x, y = 2 * b.he.y, z = 2 * b.he.z;
    // principal moments in the BOX's own frame
    const ix = m / 12 * (y * y + z * z);
    const iy = m / 12 * (x * x + z * z);
    const iz = m / 12 * (x * x + y * y);
    // rotate: I' = R diag(i) R^T  (only the diagonal of I' is kept, below)
    m3.setFromMatrix4(_m4.makeRotationFromQuaternion(b.q));
    const e = m3.elements;   // column-major: e[0..2] = col0
    xx += ix * e[0] * e[0] + iy * e[3] * e[3] + iz * e[6] * e[6];
    yy += ix * e[1] * e[1] + iy * e[4] * e[4] + iz * e[7] * e[7];
    zz += ix * e[2] * e[2] + iy * e[5] * e[5] + iz * e[8] * e[8];
    // parallel axis, to the body origin
    const t = b.t;
    xx += m * (t.y * t.y + t.z * t.z);
    yy += m * (t.x * t.x + t.z * t.z);
    zz += m * (t.x * t.x + t.y * t.y);
  }
  return { x: xx, y: yy, z: zz };
}

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
  torso: 0.14 + 0.14 + 0.16,   // kept for the degenerate no-spine-bones trunk
  pelvis: 0.14, spineSeg: 0.14, chestSeg: 0.16,   // rigdef.py's rows, used apart
  head: 0.081,
  upperArm: 0.028, lowerArm: 0.016, hand: 0.006,
  upperLeg: 0.100, lowerLeg: 0.047, foot: 0.015,
};
// Depth as a fraction of trunk half-width. Was 0.6 — a torso flattened like a
// plank of wood. The proxy-mesh boxes this rig was ported from are 0.096-0.110
// of height deep against 0.093-0.125 wide: a trunk is very nearly as deep as it
// is broad.
const TRUNK_DEPTH = 0.88;
const REAL_H = 1.70;            // rigdef.py: reference height for the mass budget
const BODY_KG = 62.0;           // at REAL_H, scaled by (H/1.70)³
const FINGER_MASS_FRAC = 0.0016; // per phalanx body (~20 g at 62 kg); thumb ×1.4

const FINGER_STIFFNESS = 12.0;  // rigdef.py, measured sag plateau
const FINGER_DAMPING = 0.9;
const FINGER_TENDON = 8.0;

const ERP_LIMIT = 0.35;         // source default: how hard limits are held
const BT_CONSTRAINT_STOP_ERP = 3; // this build's setParam id (source, verbatim)
const ACTIVE_TAG = 1;
// Bullet's own enum values. ammo.js does not export them as constants, and an
// undefined global here bundles clean and throws at the first hair lock.
const CF_KINEMATIC = 2;            // btCollisionObject::CF_KINEMATIC_OBJECT
const DISABLE_DEACTIVATION = 4;    // never sleep — a kinematic anchor must not

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
// ...and the source's OTHER setting, for a hand rather than a nail. A grab that
// is as stiff as a nail does not feel firm, it feels like the joint stops are
// not there — because at this strength they effectively are not.
const GRAB_TAU = 0.4;
const GRAB_CLAMP_X = 1.2;       // × total mass

// Anatomical joint table — the source's rigdef.py JOINTS in degrees, re-keyed
// to the basis built in _jointBasis(): Y = bone (twist), X = primary swing
// (flexion where the joint has one), Z = X×Y (the other swing). Directional
// entries carry `flex`/`ext` and a `want` (which way flexion moves the child's
// tip); the sign of X's range is DERIVED from the built axis, never assumed —
// the two sides of the body mirror, and a hard-coded sign is wrong on one
// (rapierdoll's law; also the source's thumb lesson).
//   ref: what X is crossed against — 'fwd' | 'up' | 'palm' | 'pinky'
/** Hair tuning, live. The values are the source playground's slider defaults
 *  — except where they are DIMENSIONAL, which is the trap: that rig works in a
 *  unit-scaled world (height 0.999, gravity -5.7664) and this one in real
 *  metres at 1.7m and -9.81. Dimensionless quantities (damping, the gravity
 *  FRACTION, the limit ramp) port straight across; mass does not — it goes as
 *  length cubed, so the source's 3 g is ~14.7 g here. Tune in-world and copy
 *  the table back out. */
export const HAIR_TUNING = {
  // TUNED IN-WORLD, on a falling body, with the panel's sliders — not derived.
  // Worth saying that these landed a long way from the source playground's
  // defaults (mass 3 g, tension 8, damping 0.6, gravity 0.45, limit 25,
  // rootExp 1.0), and that transplanting those verbatim did NOT reproduce its
  // look. Some of that is scale — the source works unit-scaled at height 0.999
  // and gravity -5.7664 where this is real metres at 1.7 m and -9.81, so mass
  // and stiffness needed converting and the dimensionless ones did not — but
  // not all of it: full gravity and a root-heavy ramp (rootExp < 1) were found
  // by eye, against theory. Hair is the one system here with no honest headless
  // metric, so the eye is the instrument.
  // ...WITH ONE LARGE ASTERISK, found 08-17: while those values were being
  // tuned, three-vrm's springbones were overwriting every hair bone one system
  // later in the frame (see avatar.js's vrm.update). So the sliders were tuning
  // a simulation nobody could see — which is exactly what it felt like at the
  // time: "hmm, the settings didn't change that much". tension 20 / damping
  // 0.22 is therefore not a hand-tuned value for THIS sim; it is a value chosen
  // against a different one.
  //
  // Re-measured now that the render follows the sim, as mean LOCAL bend per
  // hair joint — world rotation cannot tell "the hair moves" from "the head
  // moves", since a lock riding a tumbling body turns 100 degrees while lying
  // perfectly straight:
  //
  //     tension  damping |  peak bend   at rest   jitter
  //          20     0.22 |     34.9°     12.4°   0.020°/frame   <- as tuned
  //           8     0.22 |     43.5°     15.8°   0.019
  //           3     0.22 |     52.8°     20.3°   0.018
  //           8     0.10 |     47.6°     19.4°   0.017
  //           3     0.10 |     52.9°     24.9°   0.021          <- now
  //
  // Monotonic in both knobs, and the jitter does not pay for any of it. The
  // dials are live and they finally bite, so this is a starting point to tune
  // from by eye rather than a settled answer — hair remains the one system with
  // no honest headless metric for "flows" versus "whips".
  // TUNED BY JANUS, 08-17, and the FIRST tuning of this system done against a
  // render that was actually showing it (see the matrixAutoUpdate note in
  // step()). Every earlier number in this table — mine and theirs — was chosen
  // while watching either three-vrm's springbones or nothing at all, so the
  // history above is a record of what was measured, not of what was seen.
  //
  // Worth noting how close these land to the source playground's own defaults
  // (mass 3 g, tension 8, damping 0.6, gravity 0.45, limit 25, rootExp 1.0),
  // after a year of this port insisting it needed something different. It did
  // not. It needed its output to reach the screen.
  mass: 0.003,      // kg per segment
  tension: 7.25,    // 6DOF angular spring stiffness
  damping: 0.31,    // both the spring's and the body's angular damping
  gravity: 0.45,    // fraction of world gravity
  limit: 25,        // degrees at the TIP
  rootExp: 1.2,     // ramp exponent: lim = limit * (j/n)^rootExp
};

/** Wing tuning, live. Same shape as HAIR_TUNING and the same instrument (the
 *  eye, against a body being dropped), but a wing is not a lock of hair and the
 *  numbers say so: three orders of magnitude more mass per segment, a limit
 *  small enough that a folded wing cannot pass through the back it is attached
 *  to, and a ramp that leaves the shoulder joint STIFFER than the elbow rather
 *  than the reverse.
 *
 *  What a limp wing should look like is a real question and these are a first
 *  answer: dead weight that swings from the shoulder and trails the body,
 *  neither flapping (it is unconscious) nor rigid (it is not a prop). */
export const WING_TUNING = {
  mass: 0.55,       // kg per segment. Wings this size on a real animal would be
                    // lighter, being mostly air — but a 20 g plate a metre long
                    // is all lever and no inertia, and reads as paper.
  // MEASURED, over 4 lean directions per row, because one fall's number is
  // noise. The first guess here was 140/0.5, reasoning that "a wing has a
  // shoulder that resists" — and it did resist, all the way to rigid: the joint
  // spiked on impact and then snapped back to the pose it was born in, which
  // reads exactly as Janus reported it, "rigid and twitchy". The bend a wing
  // KEEPS is the number that matters, not the bend it reaches:
  //
  //     tension  damping |  peak bend   bend at rest   jitter
  //         140     0.15 |     25.9°           0.3°   0.052°/frame
  //          50     0.15 |     38.0°           0.6°   0.047
  //          20     0.15 |     46.6°           1.4°   0.037
  //           8     0.15 |     62.2°          12.5°   0.025   <- both best
  //           3     0.15 |     72.4°          12.4°   0.064
  //
  // 8 is the knee: below it nothing more is gained in fold and the jitter
  // climbs again (a spring too weak to hold its joint quiet against contact).
  // Doubling the damping cost fold and doubled jitter at every tension.
  tension: 8,       // 6DOF angular spring stiffness
  damping: 0.15,    // both the spring's and the body's angular damping. Bullet's
                    // spring "damping" is a target-velocity GAIN, not
                    // dissipation, so more of it means snappier, not calmer.
  gravity: 1.0,     // fraction of world gravity. Real, unlike hair's 1.5 — a
                    // wing is a big surface and if anything falls SLOWER.
  // The RAMP is where the remaining stiffness lived, and it got worse when the
  // chains grew from two bones to three: lim = limit * ((j+1)/n)^rootExp, so at
  // 38/1.6 the shoulder went from 12.5° (n=2) to 6.5° (n=3) without anyone
  // touching a number. Re-measured on the 3-bone rig:
  //
  //     limit  rootExp |  peak bend   bend at rest   jitter
  //        38      1.6 |     69.0°           4.7°   0.119°/frame
  //        70      1.0 |     74.7°           5.9°   0.073        <- more fold,
  //        70      0.7 |     74.4°           5.9°   0.077           less twitch
  //
  // A linear ramp dominates the steep one on BOTH axes, which is the unusual
  // case where there is no trade to make.
  //
  // 0.7 looked calmer still on 4 leans (jitter 0.089 vs 0.130) — and did not
  // survive: paired over 10 leans the difference is -0.003 ± 0.024, t = 0.13,
  // i.e. nothing. Noted because that gap is exactly the size this project has
  // been fooled by before, and the cheap paired re-test is what settles it.
  //
  // Re-measured AGAIN once the boxes were sized from the mesh (see
  // boneMeshExtents — the distal upper segments had been carrying boxes a third
  // of their true length, which is most of why they would not drape): the same
  // row now rests at 9.0° ± 2.0 rather than 5.9°.
  limit: 70,        // degrees at the outermost segment
  rootExp: 1.0,     // ramp exponent — linear: the shoulder gets a third of the
                    // range, the tip all of it.
};

export const JOINT_SPECS = {
  // TUNED BY HAND, in-world, against a real body falling — not derived. The
  // debug panel's "joint limits (live)" section retunes running constraints, so
  // these came from watching and adjusting rather than from argument. Where
  // they depart from rigdef.py that is deliberate: rigdef describes a living
  // spine's range, and a ragdoll with no muscle tone spends all of it.
  //
  // Two axes are LOCKED at zero (trunk twist, knee side-bend). A locked axis is
  // exempt from the born-widening below, which would otherwise hand back
  // ±BUILD_WIDEN of the freedom the zero was there to remove.
  spine: { ref: 'fwd', x: [-10, 10], twist: 0, z: [-4, 4] },
  chest: { ref: 'fwd', x: [-20, 20], twist: 0, z: [-6, 6] },
  head: { ref: 'fwd', x: [-33, 33], twist: 24, z: [-19, 19] },
  upperArm: { ref: 'fwd', x: [-85, 85], twist: 56, z: [-85, 85] },
  lowerArm: { ref: 'fwd', flex: 145, ext: 2, want: 'fwd', twist: 5, z: [-5, 5] },
  hand: { ref: 'palm', flex: 45, ext: 45, want: 'palm', twist: 8, z: [-15, 15] },
  // THE HAND-TUNED ROW, RESTORED (2026-08-29). This row was parked at
  // flex 90 / ext 45 / twist 30 / z ±45 for months because narrowing it made
  // the knees read 125° of "hyperextension" — the wrap-point class: a wide
  // one-sided range put Bullet's wrap midpoint inside reach, and the limit
  // then HELD the knee on the wrong side. The range-centering below (rotate
  // the parent frame by the range midpoint, wrap at 180°) killed that class,
  // and the parking comment said to put this row back once it landed; it
  // landed and the row was forgotten. Measured on restore: every leg joint
  // stays within limits through a full topple on both fleet rigs (worst
  // constraint-frame excursion 6°, the ERP slack), and the 125°-signature
  // reads that remained were the tumble suite's POSITIONAL instrument
  // misreading a legal fetal fold — hips at their 90° stop plus legal spine
  // curl put the thigh past 90° in the torso frame, where a legal backward
  // knee fold has a forward deviation component of exactly -cos(thigh angle).
  // The instrument now predicts the legal fold direction from the thigh's own
  // swing (tools/ammodoll-test.ts).
  upperLeg: { ref: 'fwd', flex: 90, ext: 8, want: 'fwd', twist: 0, z: [-13, 13] },
  lowerLeg: { ref: 'fwd', flex: 123, ext: 0, want: 'back', twist: 3, z: [0, 0] },
  foot: { ref: 'up', x: [-35, 35], twist: 12, z: [-12, 12] },
  fingerProx: { ref: 'palm', flex: 90, ext: 6, want: 'palm', twist: 8, z: [-12, 12] },
  fingerMid: { ref: 'palm', flex: 100, ext: 0, want: 'palm', twist: 4, z: [-4, 4] },
  thumb: { ref: 'pinky', flex: 55, ext: 10, want: 'pinky', twist: 12, z: [-25, 25] },
};

// The body cut is rigmeasure.js's SEGMENTS — one table for both engines (it
// was byte-identical here and in ragdoll.js). This engine's additions ride
// beside it: the torso rows share rigid bodies (TORSO_KEYS), hands and feet
// are the source's extra segments, and the fingers ride on the hands.
const TORSO_KEYS = new Set(['hips|spine', 'spine|chest', 'chest|neck']);
const CORE_SEGMENTS = SEGMENTS;
const EXTRA_SEGMENTS = [
  { a: 'leftHand', b: 'leftMiddleProximal', part: 'hand' },
  { a: 'rightHand', b: 'rightMiddleProximal', part: 'hand' },
  { a: 'leftFoot', b: 'leftToes', part: 'foot' },
  { a: 'rightFoot', b: 'rightToes', part: 'foot' },
];
const CORE_JOINTS = [
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
// VRM humanoid digit chains: [prox, mid, distal]. "little", not "pinky" —
// the tendon chain below couples index→middle→ring→little exactly as the
// source's TENDON_CHAIN does (thumb excluded: no shared tendon).
const FINGERS = ['Index', 'Middle', 'Ring', 'Little'];

// Collision filter bits. The filter is an AND of BOTH directions
// ((groupA & maskB) && (groupB & maskA)), and it FREEZES at addRigidBody:
// changing it later does nothing (source, the day it cost).
//
// THE BUDGET IS 15 BITS, NOT 32. Bullet's own btBroadphaseProxy carries ints,
// which is what the old comment here assumed — but ammo.js's IDL declares
// addRigidBody's group and mask as SHORT, so anything above bit 14 is silently
// truncated on the way into wasm. Measured on this rig, before the fix:
//
//     G_FINGER  1<<30 = 1073741824  ->  short 0      collides with NOTHING
//     core body       =      65536  ->  short 0      collides with NOTHING
//     core body       =      32768  ->  short -32768 sign bit, collides broadly
//
// Group 0 is why hair, wings and fingers fell straight through the floor: a
// body dropped from 2m above the ground passed it and was still falling 100m
// down. It reads as "the sim let them through" because it is exactly that, and
// no amount of tuning touches it.
//
// So: bit 0 statics, bits 1..12 the twelve core bodies that need self-collision
// (3 trunk + head + 8 limb segments), bit 14 everything that only ever wants
// the ground. Hands and feet do NOT get bits of their own — they ride their
// parent limb's (see the assignment below), which costs nothing anatomically
// and is what makes 16 bodies fit in 12 bits.
const G_STATIC = 1;
const G_FINGER = 1 << 14;      // 16384 — the top bit a signed short can hold
const BODY_BITS = 12;
const FILTER_MAX = 1 << 14;    // anything above this does not survive the call

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

/** Per-bone mesh extents, in each bone's OWN rest frame, read off the skin.
 *
 *  For limbs a bone's length is a fine proxy for the flesh on it — head to the
 *  next head, and the box follows. Wings broke that assumption outright:
 *  mythos's upper chain has a 16cm middle bone carrying 44cm of membrane, and
 *  its outermost bone is a LEAF, where the chain builder had nothing to measure
 *  and copied the previous segment's length. Both distal boxes came out about a
 *  THIRD of the wing they stand for — visible in the debug overlay, and the
 *  reason those sections would not drape: gravity's torque goes as the lever
 *  arm, so a box a third the length has a third the pull and a ninth the
 *  inertia to carry a swing with.
 *
 *  So ask the mesh instead. A vertex's position times boneInverse × bindMatrix
 *  is where it sits in that bone's frame at bind time — pose-independent, so
 *  this is computed ONCE per avatar and cached (the doll is rebuilt on every
 *  grab). Vertices are assigned to whichever bone weights them MOST, and only
 *  when that weight is decisive; a vertex split evenly across a joint belongs
 *  to neither box.
 *
 *  Returns Map(boneName -> {c, he}) in bone-local units, or an empty map when
 *  there is no skinned mesh to read — headless rigs have bones and no geometry,
 *  and the caller keeps its bone-length path for them.
 */
function boneMeshExtents(avatar, key, match) {
  // Keyed, because there are TWO callers with different matchers (hair and
  // wings) and a single cached map would hand the second caller the first
  // caller's answer — silently returning no extents and dropping it back to
  // bone-length boxes, with nothing in the log to say the fix had stopped
  // working.
  const cache = avatar.__boneExt ??= new Map();
  if (cache.has(key)) return cache.get(key);
  const out = new Map();
  const acc = new Map();      // bone name -> {lo, hi}
  const v = new THREE.Vector3();
  const m = new THREE.Matrix4();
  avatar.root?.traverse?.((o) => {
    if (!o.isSkinnedMesh || !o.skeleton?.bones?.length) return;
    const pos = o.geometry?.attributes?.position;
    const si = o.geometry?.attributes?.skinIndex;
    const sw = o.geometry?.attributes?.skinWeight;
    if (!pos || !si || !sw) return;
    // which of this skeleton's bones are we being asked about
    const want = new Map();
    o.skeleton.bones.forEach((b, i) => { if (match(b.name)) want.set(i, b.name); });
    if (!want.size) return;
    for (let k = 0; k < pos.count; k++) {
      let bi = -1, bw = 0;
      for (let c = 0; c < 4; c++) {
        const w = sw.getComponent(k, c);
        if (w > bw) { bw = w; bi = si.getComponent(k, c); }
      }
      // 0.4 is "this vertex is decisively one bone's": below it the vertex
      // straddles a joint and would stretch BOTH boxes past the real geometry.
      if (bw < 0.4 || !want.has(bi)) continue;
      const name = want.get(bi);
      m.multiplyMatrices(o.skeleton.boneInverses[bi], o.bindMatrix);
      v.fromBufferAttribute(pos, k).applyMatrix4(m);
      let a = acc.get(name);
      if (!a) acc.set(name, (a = { lo: v.clone(), hi: v.clone(), n: 0 }));
      a.lo.min(v); a.hi.max(v); a.n++;
    }
  });
  for (const [name, a] of acc) {
    // a handful of stray vertices is not a shape; fall back rather than build a
    // box out of noise
    if (a.n < 24) continue;
    out.set(name, {
      c: a.lo.clone().add(a.hi).multiplyScalar(0.5),
      he: a.hi.clone().sub(a.lo).multiplyScalar(0.5),
    });
  }
  cache.set(key, out);
  return out;
}

/** A bone's mesh extent, carried out to world by its live matrix: the box
 *  centre and a single child box oriented with the bone. Returns null when
 *  there is nothing measured for that bone, and the caller keeps its fallback.
 *
 *  `floor` is the minimum half-extent on every axis — a membrane or a lock of
 *  hair can be millimetres thick, and a zero-depth box is a degenerate shape
 *  with no inertia about two of its axes. */
function extBox(nd, ext, floor = 0.01) {
  if (!ext) return null;
  nd.updateWorldMatrix(true, false);
  return {
    center: ext.c.clone().applyMatrix4(nd.matrixWorld),
    boxes: [{
      he: new THREE.Vector3(
        Math.max(ext.he.x, floor), Math.max(ext.he.y, floor), Math.max(ext.he.z, floor)),
      t: new THREE.Vector3(0, 0, 0),
      q: nd.getWorldQuaternion(new THREE.Quaternion()),
    }],
  };
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

export class AmmoRagdoll extends BodyEngineBase {
  constructor(avatar, lean = null, rest = null, seedVel = null) {
    super(avatar);                  // lifecycle fields — see bodyengine.js
    if (!AMMO) throw new Error('ammodoll: wasm not ready — ensureAmmo() first');
    this.pins = new Map();          // joint -> THREE.Vector3 (world) — bodydrag reads this
    this._pinCons = new Map();      // joint -> { con, body }
    this.maxW = Infinity;
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
      for (const s of seedJoints(seedVel)) {
        if (live[s.name]) live[s.name].set(s.px, s.py, s.pz);
        seedV[s.name] = new THREE.Vector3(s.vx, s.vy, s.vz);
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
    this.rig = rigFrameOf(restP);   // measured, one derivation — rigmeasure.js
    const rigUp = this.rig.up, rigLat = this.rig.lateral, rigFwd = this.rig.forward;
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
    // Trunk half-width. span is the distance between the two SHOULDER JOINTS,
    // which is a good deal narrower than a torso, so x0.22 of it made a body
    // 0.12m wide on a 1.5m rig. Measured against the source's proxy-mesh boxes
    // (rig.json, normalised by height): pelvis/spine/chest run 0.093-0.125 of
    // height WIDE and 0.096-0.110 DEEP. Take the wider of the two estimates so
    // a rig with genuinely broad shoulders still governs its own width.
    //
    // This went unnoticed while the trunk was one fused body whose inertia came
    // from btCompoundShape's AABB — the approximation inflated it and hid the
    // undersized boxes. With real inertia the dimensions finally matter, and an
    // undersized trunk is a floppy one.
    const torsoR = Math.max(0.05, span * 0.22, H * 0.055);

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
    // TERRAIN-FOLLOWING GROUND. The Verlet resolves heightAt(x,z) per joint
    // per step, so its bodies follow every slope; a single flat cuboid
    // sampled at the hips buried heads wherever the field rose above that
    // one sample (antra, live on a meadow hillside). Sample a grid around
    // the fall and lay box TILES at the field's own heights; a flat world
    // (every sample within 2cm) keeps the one-cuboid fast path. Beyond the
    // grid, a wide apron at the LOWEST sampled height catches a long tumble
    // without ever poking above a tile inside it.
    {
      // TILE bounds the stair-step error: a flat tile is slope×TILE/2 below the
      // field at its uphill edge — 0.75m keeps a steep 40% grade within 15cm
      // (a box half-width), and gentle meadows within a few cm.
      const GROUND_R = 12, TILE = 0.75;
      const tiles = [];
      let lo = this.groundY, flat = true;
      for (let gx = -GROUND_R; gx <= GROUND_R; gx += TILE) {
        for (let gz = -GROUND_R; gz <= GROUND_R; gz += TILE) {
          const h = heightAt(hips.x + gx, hips.z + gz);
          tiles.push([gx, gz, h]);
          lo = Math.min(lo, h);
          if (Math.abs(h - this.groundY) > 0.02) flat = false;
        }
      }
      if (flat) {
        addStatic(60, 0.5, 60, { x: hips.x, y: this.groundY - 0.5, z: hips.z }, null, FRICTION);
      } else {
        addStatic(60, 0.5, 60, { x: hips.x, y: lo - 0.5, z: hips.z }, null, FRICTION);
        for (const [gx, gz, h] of tiles) {
          addStatic(TILE / 2 + 0.02, 0.5, TILE / 2 + 0.02,
            { x: hips.x + gx, y: h - 0.5, z: hips.z + gz }, null, FRICTION);
        }
      }
    }
    // The spatial hash answers "what is near the fall", never the whole map —
    // rapierdoll carried a grid-bounded query for exactly this and the port
    // originally regressed it to a full scan of `colliders` with a distance
    // filter; nearColliders is that service query, promoted (§14.2 6a).
    for (const [, c] of nearColliders(hips.x, hips.z, 8)) {
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

    this._vol = [];                 // debug: the boxes, body-local, per body
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
      const I = boxesInertia(boxes, mass);
      _bv1.setValue(I.x, I.y, I.z);
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
      // Keep the child boxes for the debug overlay. The volumes are the ONE
      // thing about this engine you cannot infer from the skeleton — a bone
      // line says nothing about the thickness that stops a forearm passing
      // through a torso — and debug.js could not draw them for ammo at all:
      // it reads `caps`/`radius`, which only the verlet has, so the panel drew
      // joints and nothing else. See volumes().
      this._vol.push({
        body: rb,
        boxes: boxes.map((bx) => ({ he: bx.he.clone(), t: bx.t.clone(), q: bx.q.clone() })),
      });
      return rb;
    };

    // a box spanning ra→rb in REST coordinates, expressed local to a body
    // whose rest origin is `origin` (identity orientation at rest)
    // minLen: the 0.04 floor is a LIMB's — it stops a stubby bone becoming a
    // degenerate box. Applied to hair it inflates a 1cm segment into a 4cm bar,
    // and inertia goes as length SQUARED, so the shortest segments carried ~15x
    // the rotational inertia they should. A lock of five 4cm bars is a stick.
    const boxFor = (origin, ra, rb2, halfW, halfD = halfW, minLen = 0.04) => {
      const dir = rb2.clone().sub(ra);
      const len = Math.max(dir.length(), minLen);
      const mid = ra.clone().add(rb2).multiplyScalar(0.5).sub(origin);
      return { he: new THREE.Vector3(halfW, len / 2, halfD), t: mid, q: frameQuat(dir) };
    };
    const limbW = (ra, rb2) => Math.max(0.02, ra.distanceTo(rb2) * 0.16);

    // The trunk is THREE bodies — pelvis, spine, chest — jointed by the source's
    // own spine and chest limits.
    //
    // It was one. A single rigid body from hips to neck cannot bend, so a doll
    // fell as a plank: no fold at the waist, no shoulders leading the hips, no
    // curl on landing. And it is not only a look. Every arm and the head hung
    // off ONE body carrying half the doll's mass, so a hand dragged across the
    // floor loaded the whole arm chain against that slab and the arm joints
    // absorbed all of it — measured at ~118 degrees past their limits, and
    // unchanged by softening the drag handle from x8 to x1.2, because the
    // handle was never what was saturating.
    //
    // The rows of MASS_FRAC.torso were already the three Dempster fractions
    // (0.14 + 0.14 + 0.16) added together; they are simply used apart now.
    const segMeta = new Map();      // segKey -> { body, restOrigin }
    const TRUNK = [
      ['hips|spine', 'pelvis'], ['spine|chest', 'spineSeg'], ['chest|neck', 'chestSeg'],
    ];
    let nextBit = 0;
    let trunkBuilt = 0;
    for (const [key, part] of TRUNK) {
      const [a, b2] = key.split('|');
      if (!restP[a] || !restP[b2] || !live[a] || !live[b2]) continue;
      const ra = restP[a], rb2 = restP[b2];
      const restMid = ra.clone().add(rb2).multiplyScalar(0.5);
      const liveMid = live[a].clone().add(live[b2]).multiplyScalar(0.5);
      const body = mkBody(MASS_FRAC[part] * massScale, liveMid, torsoQ,
        [boxFor(restMid, ra, rb2, torsoR, torsoR * TRUNK_DEPTH)], false);
      const seg = {
        key, a, b: b2, body, torso: true,
        restA: ra.clone(), restB: rb2.clone(),
        localA: ra.clone().sub(restMid), localB: rb2.clone().sub(restMid),
        r: torsoR,
      };
      this.segs.set(key, seg);
      segMeta.set(key, { body, restOrigin: restMid });
      if (nextBit <= BODY_BITS) bodyIndex.set(body, nextBit++);
      trunkBuilt++;
    }
    // Degenerate trunk (a rig with no spine/chest bones): fall back to the old
    // single body, so those rigs behave exactly as before rather than losing
    // their torso entirely.
    if (!trunkBuilt) {
      const body = mkBody(MASS_FRAC.torso * massScale, liveTorsoMid, torsoQ,
        [boxFor(restTorsoMid, restP.hips, restUpper, torsoR, torsoR * TRUNK_DEPTH)], false);
      segMeta.set('hips|spine', { body, restOrigin: restTorsoMid });
      segMeta.set('chest|neck', { body, restOrigin: restTorsoMid });
      this.segs.set('hips|spine', {
        key: 'hips|spine', a: 'hips', b: 'spine', body, torso: true,
        restA: restP.hips.clone(), restB: restUpper.clone(),
        localA: restP.hips.clone().sub(restTorsoMid),
        localB: restUpper.clone().sub(restTorsoMid), r: torsoR,
      });
      if (nextBit <= BODY_BITS) bodyIndex.set(body, nextBit++);
    }
    // The trunk body other code asks for by name. Callers want "the thing the
    // arms and head hang off", which is the chest once the trunk articulates.
    this.torsoBody = (segMeta.get('chest|neck') ?? segMeta.get('hips|spine'))?.body ?? null;

    // limb + head + hand/foot bodies
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
      // …and the skull is a VOLUME the head bone only anchors: VRM puts that
      // bone at the skull base, so a box ending there — and only as wide as
      // the neck — leaves the face and crown hollow, and a prone body sank
      // face-first to the ears before its neck stub touched ground (antra,
      // live, on FLAT terrain — the slope fix was innocent). Two dimensions
      // matter and only one is obvious: the box runs ON past the bone to a
      // height-scaled crown point, and — the one that actually carries a
      // prone head — its PERPENDICULAR half-extents grow to skull scale
      // (extending along the bone axis lifts nothing when that axis lies on
      // the ground; measured: crown-only moved the prone head 2.7→2.9cm).
      // The verlet never shows this because its head particle carries an
      // explicit clearance radius; the source rig never shows it because its
      // head box was measured from the MESH. Collision only — seg endpoints,
      // .p and pins keep the true bone.
      const isHead = part === 'head';
      const boxEnd = isHead
        ? rb2.clone().addScaledVector(
          rb2.clone().sub(ra).normalize(),
          // The skull runs on past the head bone — but only to a real crown.
          // H*0.11 on top of the neck->head bone made a 0.27m head on a 1.5m
          // rig; the proxy mesh measures a head 0.124 of height LONG, so the
          // extension is what is LEFT after the bone itself, not another head.
          Math.min(0.16, Math.max(0.05, H * 0.124 - rb2.distanceTo(ra))))
        : rb2;
      const wHead = isHead ? Math.max(w, H * 0.05) : w;
      const dHead = isHead ? Math.max(w, H * 0.058) : w;
      const body = mkBody(
        MASS_FRAC[part] * massScale, liveMid, qB,
        [boxFor(restMid, ra, boxEnd, wHead, dHead)], false);
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
      // segment-vs-segment distance is rigmeasure.js's (it was this file's
      // second, differently-spelled copy of the verlet's closestParams)
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
          if (segDistance(A2.restA, A2.restB, B2.restA, B2.restB) < (A2.r + B2.r) * 1.05) {
            exclude(A2.body, B2.body);
          }
        }
      }
      // A HAND RIDES ITS FOREARM'S BIT, a foot its calf's.
      //
      // Sixteen core bodies do not fit in the twelve bits a signed short can
      // spare (see G_FINGER), and the alternative — dropping the last three
      // assigned to ground-only — costs whichever bodies happen to be last in
      // construction order their self-collision, asymmetrically: one hand keeps
      // it, the other does not.
      //
      // Sharing is better than dropping AND better than a unique bit. The
      // exclusion sets still work out right: building the forearm's mask skips
      // the hand (adjacent, excluded) and skips itself, so the shared bit is
      // absent and forearm/hand do not collide — which is what was wanted.
      // Every OTHER body sees one bit meaning "that arm, hand included", so a
      // hand still meets the torso, the head, and the opposite arm.
      for (const seg of this.segs.values()) {
        // by KEY, not by a `part` field — the extra segments carry `part` in
        // their table but the seg objects built from them do not, so the first
        // version of this matched nothing and quietly left three bodies on the
        // ground-only fallback
        if (!/^(left|right)(Hand|Foot)\|/.test(seg.key ?? '')) continue;
        const parent = [...this.segs.values()].find((s) => s !== seg && s.b === seg.a);
        if (parent && bodyIndex.has(parent.body)) bodyIndex.set(seg.body, bodyIndex.get(parent.body));
      }
      // A SHARED BIT EXCLUDES IF ANY OF ITS BODIES DOES.
      //
      // The per-body loop below was: OR in `other`'s bit unless `other` is
      // excluded. With one bit per body that is exact. With a bit shared by a
      // limb and its hand, it silently UN-excludes: building the thigh's mask
      // skips the calf (adjacent) but not the foot — which now carries the
      // calf's bit — so the bit went back in and thigh/calf collided at the
      // knee again. Measured: knee hyperextension went from one rig to all six.
      //
      // Over-excluding is the safe direction (a thigh that ignores its own
      // foot costs nothing); under-excluding puts two overlapping bodies in a
      // penetration fight at a joint.
      const bitBodies = new Map();
      for (const [body, bit] of bodyIndex) {
        if (!bitBodies.has(bit)) bitBodies.set(bit, []);
        bitBodies.get(bit).push(body);
      }
      this._groupOf = new Map();
      for (const [body, bit] of bodyIndex) {
        this._groupOf.set(body, (G_STATIC << 1) << bit);
        let mask = G_STATIC;
        for (const [obit, sharers] of bitBodies) {
          if (obit === bit) continue;
          if (sharers.some((o) => excluded.get(body)?.has(o))) continue;
          mask |= (G_STATIC << 1) << obit;
        }
        const group = (G_STATIC << 1) << bit;
        // Loud, because the failure is SILENT: an over-budget group truncates
        // to zero on the way into wasm and the body simply stops colliding.
        if (group > FILTER_MAX) {
          console.error(`[ammodoll] filter group ${group} exceeds the short budget `
            + `— this body will collide with nothing`);
        }
        this.world.addRigidBody(body, group, mask);
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
      // ...but only a FRESH body is born into an arbitrary pose. A seeded body
      // is a HANDOVER — the same tumble continuing on another machine — and its
      // pose is a sim state, not an anatomy. Widening to contain it enshrines
      // whatever bend the body happened to be in as its new limits, and since
      // every drag release constructs a new doll, the limits RATCHET: measured
      // on mythospaint, the neck's lateral range went 70° → 103° → 115° → 132°
      // over four drag-and-release cycles, which is the head "bending weirdly
      // and rotating all the way round" after you let go. So on a handover the
      // widening may buy the solver a little slack, but never more than
      // BUILD_WIDEN past the anatomical table: a joint that arrives outside its
      // range is then pushed BACK into it over the next few steps, which is the
      // behaviour we want, instead of being granted the excursion forever.
      const cap = seedVel ? BUILD_WIDEN : Infinity;
      const anatLo = lo.slice(), anatHi = hi.slice();
      for (let i = 0; i < 3; i++) {
        // An axis the table LOCKS (lo === hi) stays locked. Widening it to
        // contain the born pose would quietly hand back +/-BUILD_WIDEN of the
        // very freedom the zero was there to remove — 6.9 degrees per joint,
        // which up a three-body trunk is most of a spine's worth of corkscrew.
        if (anatHi[i] - anatLo[i] === 0) continue;
        lo[i] = Math.max(anatLo[i] - cap, Math.min(lo[i], born[i] - BUILD_WIDEN));
        hi[i] = Math.min(anatHi[i] + cap, Math.max(hi[i], born[i] + BUILD_WIDEN));
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
        // retune() needs these: the constraint to talk to, and which way +X
        // flexes on THIS side (derived from geometry at build, never assumed).
        con, positiveFlexes: S.flex != null ? xhi > 0 : null,
      });
      return con;
    };

    // Named trunk anchors. The legs hang off the PELVIS and the arms and head
    // off the CHEST; when they all pointed at one fused body these two names
    // resolved to the same thing, which is exactly what made the trunk rigid.
    const metaOf = (ref) => {
      if (ref === 'hips') return segMeta.get('hips|spine');
      if (ref === 'chest') return segMeta.get('chest|neck') ?? segMeta.get('hips|spine');
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

    // ---- BULLET HAIR (the source's per-lock sim, when the rig carries the
    // chains its hair_rig.py builds). Each Hair_<chain>_<idx> bone becomes a
    // thin box body chained to the HEAD body by 6DOF spring constraints:
    // angular limits ramp down each lock ((j+1)/n)^1.5 like the source, the
    // spring's equilibrium is the pose the lock was born in, per-segment
    // gravity is fractional (hair floats a little, always), and CCD keeps
    // fast tips from tunnelling. Hair collides with the world and the skull
    // box only. It is LOCAL DRESSING: excluded from settle, snapshot and the
    // pose wire — remotes render whatever hair system their client runs.
    this._hairSegs = [];
    {
      const headSeg = this.segs.get('neck|head');
      const hairNodes = [];
      avatar.root?.traverse?.((o) => { if (/^Hair_\d+_\d+$/.test(o.name ?? '')) hairNodes.push(o); });
      const chains = new Map();
      for (const nd of hairNodes) {
        const m = nd.name.match(/^Hair_(\d+)_(\d+)$/);
        if (!chains.has(m[1])) chains.set(m[1], []);
        chains.get(m[1]).push({ i: Number(m[2]), node: nd });
      }
      if (headSeg && chains.size) {
        // The combed pose, captured ONCE per avatar and never re-derived.
        //
        // This block used to read whatever pose the hair happened to be in and
        // call setEquilibriumPoint() on it. After a tumble that pose IS the
        // tumble, so "combed" was redefined as "however it looked just then" —
        // and since every drag release rebuilds, the crumple ratcheted in and
        // outlived the ragdoll entirely. HANDOFF.md names this: "Never rebuild
        // a rig from a simulated pose."
        //
        // Stored on the AVATAR, not the doll, because the doll is what keeps
        // being rebuilt.
        if (!avatar.__hairRest) {
          const rest = new Map();
          for (const [, list0] of chains) {
            for (const it of list0) rest.set(it.node, it.node.quaternion.clone());
          }
          avatar.__hairRest = rest;
        }
        // ...and start combed, not mid-tumble.
        // ...and updateMatrix, or this reset never happens either: a
        // springbone joint has matrixAutoUpdate false, so the bodies below
        // would be built at whatever pose three-vrm's matrices still held —
        // the boxes born offset from the hair you can see.
        for (const [nd0, q0] of avatar.__hairRest) {
          nd0.quaternion.copy(q0); nd0.updateMatrix();
        }
        avatar.root.updateMatrixWorld(true);
        const headGroup = this._groupOf.get(headSeg.body) ?? G_STATIC;
        const R = Math.max(0.004 * H, 0.004);
        const hairExt = boneMeshExtents(avatar, 'hair', (n) => /^Hair_\d+_\d+$/.test(n));
        // The source playground's DEFAULTS, transplanted. Where this port
        // guessed, it guessed like a FINGER — hair is built with isFinger=true,
        // so it inherited the finger damping and the finger collision group,
        // and the numbers below had drifted from the ones the hair was actually
        // tuned with. Each value here is the source's slider default; see
        // HANDOFF.md "Hair physics" for what each was measured against.
        const HT = HAIR_TUNING;      // live — see retuneHair()
        const HAIR_LIM = HT.limit * DEG, HAIR_ROOT = HT.rootExp;
        const HAIR_GRAV = HT.gravity, HAIR_MASS = HT.mass;
        const HAIR_TENS = HT.tension, HAIR_DAMP = HT.damping;
        let built = 0;
        this._hairAnchors = [];
        for (const [, list] of chains) {
          list.sort((x2, y2) => x2.i - y2.i);
          // A KINEMATIC anchor per lock, not the dynamic head.
          //
          // Springing a lock's root to the head body makes a loop: every jitter
          // and every collision impulse on the head is injected into all 75
          // locks, and the locks' reaction torques feed back into the head. The
          // source hangs each lock from a mass-0 kinematic box that touches
          // nothing and is re-driven from the skeleton before each step —
          // infinitely stiff, perfectly smooth, and one-way.
          const rootW = list[0].node.getWorldPosition(new THREE.Vector3());
          const aShape = keep(new AMMO.btBoxShape(new AMMO.btVector3(R, R, R)));
          _bt1.setIdentity();
          _bv1.setValue(rootW.x, rootW.y, rootW.z); _bt1.setOrigin(_bv1);
          const aMs = keep(new AMMO.btDefaultMotionState(_bt1));
          _bv1.setValue(0, 0, 0);
          const aCi = keep(new AMMO.btRigidBodyConstructionInfo(0, aMs, aShape, _bv1));
          const anchor = keep(new AMMO.btRigidBody(aCi));
          anchor.setCollisionFlags(anchor.getCollisionFlags() | CF_KINEMATIC);
          anchor.setActivationState(DISABLE_DEACTIVATION);
          this.world.addRigidBody(anchor, G_FINGER, 0);   // mask 0: touches nothing
          this._bodies.push(anchor);
          // where the anchor sits in the HEAD's frame, so it can be carried
          this._hairAnchors.push({
            anchor, head: headSeg.body, local: localOf(headSeg.body, rootW),
          });
          let parentBody = anchor;
          let prevLen = 0.05;
          for (let j2 = 0; j2 < list.length; j2++) {
            const nd = list[j2].node;
            const aW = nd.getWorldPosition(new THREE.Vector3());
            const childNd = list[j2 + 1]?.node;
            const bW = childNd ? childNd.getWorldPosition(new THREE.Vector3())
              : aW.clone().add(nd.getWorldDirection(new THREE.Vector3()).multiplyScalar(-prevLen));
            const len = Math.max(aW.distanceTo(bW), 0.015);
            prevLen = len;
            const mid = aW.clone().add(bW).multiplyScalar(0.5);
            // The lock's own measurements when the mesh offers them (see
            // boneMeshExtents), the bone spacing otherwise. A much SMALLER
            // correction than the wings needed — measured on this rig, the
            // median lock is 48mm long against 36mm of bone spacing, and
            // 17x10mm in section against the 14x14mm the constant gives — so
            // this is a tidy-up, not the fix that the wings' 3x error was.
            // 131 of 346 segments are too sparsely tessellated to measure and
            // keep the constant; they are the thin tips, where it is closest to
            // right anyway.
            const hx = extBox(nd, hairExt.get(nd.name), 0.004);
            const body = hx
              ? mkBody(HAIR_MASS, hx.center, new THREE.Quaternion(), hx.boxes, true)
              : mkBody(HAIR_MASS, mid, new THREE.Quaternion(),
                [boxFor(mid, aW, bW, R, R, len)], true);
            // Angular damping 0.9 was the finger constant. Per Bullet's
            // w *= (1-d)^dt, 0.9 bleeds angular momentum ~2.5x faster per step
            // than 0.6 — hair that cannot carry a swing through its arc reads
            // as rigid, and then snaps between poses instead of flowing.
            body.setDamping(0.25, HAIR_DAMP);
            // Hair does not bounce; it just stops. The body defaults are a
            // LIMB's (friction 0.85, restitution 0.03, rolling 0.05) and give
            // stick-slip chatter against the scalp.
            body.setFriction(0.3);
            body.setRestitution(0.0);
            body.setRollingFriction(0.0);
            body.setCcdMotionThreshold(len * 0.5);
            body.setCcdSweptSphereRadius(R * 0.9);
            // The ROOT segment does not collide with the head.
            //
            // Every lock is anchored AT the scalp, so its first segment is born
            // inside any collider big enough to be a head — and a contact born
            // penetrating cannot be resolved: split impulse only converts
            // penetration to position down to 2cm, and the rest is paid off as
            // kinetic energy. That is the poof. The source excludes j===0 for
            // exactly this reason (and uses a concave mesh collider rather than
            // this box, which is a larger change than this one).
            this.world.addRigidBody(body, G_FINGER,
              j2 === 0 ? G_STATIC : (G_STATIC | headGroup));
            _bv1.setValue(0, -9.81 * HAIR_GRAV, 0);
            body.setGravity(_bv1);       // AFTER addRigidBody — the source's lesson
            // No additive slack. The +0.12 here was BUILD_WIDEN, a limb-joint
            // constant, adding 6.88 degrees to EVERY hair joint — which made the
            // root 9.1 degrees where the source gives it 5.0.
            const lim = HAIR_LIM * Math.pow((j2 + 1) / list.length, HAIR_ROOT);
            const mkF = (bdy) => {
              const tr = keep(new AMMO.btTransform());
              tr.setIdentity();
              const o = localOf(bdy, aW);
              _bv2.setValue(o.x, o.y, o.z); tr.setOrigin(_bv2);
              return tr;
            };
            const con = keep(new AMMO.btGeneric6DofSpringConstraint(
              parentBody, body, mkF(parentBody), mkF(body), true));
            _bv1.setValue(0, 0, 0);
            con.setLinearLowerLimit(_bv1); con.setLinearUpperLimit(_bv1);
            _bv1.setValue(-lim, -lim, -lim); con.setAngularLowerLimit(_bv1);
            _bv1.setValue(lim, lim, lim); con.setAngularUpperLimit(_bv1);
            for (let ax = 3; ax < 6; ax++) {
              con.enableSpring(ax, true);
              // Bullet's spring "damping" is a target-velocity GAIN, not a
              // dissipation term: velFactor = fps * damping / iterations. At
              // 2.0/0.9 this commanded the joint toward equilibrium 1.5x faster
              // than the source while having a QUARTER of the force to hold it
              // there — snaps, then cannot carry itself.
              con.setStiffness(ax, HAIR_TENS);
              con.setDamping(ax, HAIR_DAMP);
              // and no stop-ERP override: the source leaves hair limits at
              // Bullet's default 0.2, where this port drove them at 0.35 — 75%
              // stiffer, so a loose limit gets hit hard.
            }
            con.setEquilibriumPoint();
            this.world.addConstraint(con, true);
            this._constraints.push(con);
            this._hairSegs.push({
              body, node: nd, parent: nd.parent,
              restWorldQ: nd.getWorldQuaternion(new THREE.Quaternion()),
              con, j: j2, n: list.length,   // retuneHair() re-derives the ramp
            });
            parentBody = body;
            built++;
          }
        }
        if (built) {
          // Claim the hair from three-vrm for as long as this doll lives. See
          // avatar.js's vrm.update: without this the springbones overwrite
          // every bone we are about to drive, one system later in the frame.
          avatar.__simHair = true;
          console.log(`[ammodoll] bullet hair: ${chains.size} locks, ${built} segments`);
        }
      }
    }

    // ---- BULLET WINGS. Same shape as the hair above — chains of boxes hung
    // from a KINEMATIC anchor carried in a core body's frame, one-way, local
    // dressing, excluded from settle and the pose wire — and deliberately NOT
    // sharing its code. The two differ in every parameter that matters (mass by
    // 25x, a plate cross-section instead of a filament, an anchor at the chest
    // instead of the skull, a stiff root instead of a stiff tip), and a shared
    // builder would be five booleans with one caller each.
    //
    // The division of labour with avatar.js is the point of the whole thing:
    // while the body is alive its wings are DRIVEN (WING_IDLE's flap, on the raw
    // bones, after vrm.update); the moment it goes limp the doll is built and
    // these chains take the same bones over. Neither writes while the other
    // does, so there is never a frame with two authors.
    this._wingSegs = [];
    this._wingAnchors = [];
    {
      // The chest, not the clavicle: the arms hang off 'chest' in CORE_JOINTS
      // for the same reason — there is no clavicle body in this cut of the rig.
      const chestSeg = this.segs.get('chest|neck') ?? this.segs.get('spine|chest');
      const wingNodes = [];
      avatar.root?.traverse?.((o) => {
        if (/^[LR]_Wing_(Upper|Lower)(_\d+)?$/.test(o.name ?? '')) wingNodes.push(o);
      });
      const wchains = new Map();
      for (const nd of wingNodes) {
        // The index in the name IS the position in the chain. Counting
        // underscores instead collapses _1 and _2 to the same depth, and then
        // the sort below leaves their order to traversal luck — which decides
        // which segment gets built as whose parent.
        const m = nd.name.match(/^([LR]_Wing_(?:Upper|Lower))(?:_(\d+))?$/);
        if (!wchains.has(m[1])) wchains.set(m[1], []);
        wchains.get(m[1]).push({ i: m[2] ? Number(m[2]) : 0, node: nd });
      }
      if (chestSeg && wchains.size) {
        // The AUTHORED pose, captured by avatar.js's _findWings before the flap
        // ever ran, and shared here. Falling back to the live pose would define
        // rest as "wherever the flap happened to be when you grabbed her", so
        // the equilibrium would differ every time the doll was built — and
        // since a drag release rebuilds, that is the hair's crumple ratchet
        // again, in a system where it would read as wings drifting upward.
        if (!avatar.__wingRest) {
          const rest = new Map();
          for (const [, l0] of wchains) for (const it of l0) rest.set(it.node, it.node.quaternion.clone());
          avatar.__wingRest = rest;
        }
        for (const [nd0, q0] of avatar.__wingRest) {
          nd0.quaternion.copy(q0); nd0.updateMatrix();   // harmless when auto is on
        }
        avatar.root.updateMatrixWorld(true);
        const WT = WING_TUNING;
        const WING_LIM = WT.limit * DEG;
        const wingExt = boneMeshExtents(avatar, 'wing', (n) => /^[LR]_Wing_/.test(n));
        let built = 0;
        for (const [, list] of wchains) {
          list.sort((x2, y2) => x2.i - y2.i);
          const rootW = list[0].node.getWorldPosition(new THREE.Vector3());
          const aShape = keep(new AMMO.btBoxShape(new AMMO.btVector3(0.01, 0.01, 0.01)));
          _bt1.setIdentity();
          _bv1.setValue(rootW.x, rootW.y, rootW.z); _bt1.setOrigin(_bv1);
          const aMs = keep(new AMMO.btDefaultMotionState(_bt1));
          _bv1.setValue(0, 0, 0);
          const aCi = keep(new AMMO.btRigidBodyConstructionInfo(0, aMs, aShape, _bv1));
          const anchor = keep(new AMMO.btRigidBody(aCi));
          anchor.setCollisionFlags(anchor.getCollisionFlags() | CF_KINEMATIC);
          anchor.setActivationState(DISABLE_DEACTIVATION);
          this.world.addRigidBody(anchor, G_FINGER, 0);   // mask 0: touches nothing
          this._bodies.push(anchor);
          this._wingAnchors.push({
            anchor, head: chestSeg.body, local: localOf(chestSeg.body, rootW),
          });
          let parentBody = anchor;
          let prevLen = 0.2;
          for (let j2 = 0; j2 < list.length; j2++) {
            const nd = list[j2].node;
            const aW = nd.getWorldPosition(new THREE.Vector3());
            const childNd = list[j2 + 1]?.node;
            const bW = childNd ? childNd.getWorldPosition(new THREE.Vector3())
              : aW.clone().add(nd.getWorldDirection(new THREE.Vector3()).multiplyScalar(-prevLen));
            const len = Math.max(aW.distanceTo(bW), 0.03);
            prevLen = len;
            const mid = aW.clone().add(bW).multiplyScalar(0.5);
            // THE BOX IS THE MESH, when the rig has one to read.
            //
            // See boneMeshExtents: a wing bone's length is not the size of the
            // wing on it. The extents come back in the bone's own frame, so the
            // box rides out to world with the bone's live matrix — centre and
            // orientation both — and needs no guess about span or thickness.
            //
            // The bone-length plate below is the fallback for a rig with no
            // skinned geometry to measure (every headless fixture). It is a
            // PLATE and not a filament on purpose: the width is what stops a
            // wing lying flat inside the ground plane when the body lands on
            // its back, where hair's 4mm cross-section would be a wire.
            const ext = wingExt.get(nd.name);
            let center = mid, boxes;
            if (ext) {
              nd.updateWorldMatrix(true, false);
              center = ext.c.clone().applyMatrix4(nd.matrixWorld);
              boxes = [{
                // a membrane can be millimetres thick, and a zero-depth box is
                // a degenerate shape with no inertia about two of its axes
                he: new THREE.Vector3(
                  Math.max(ext.he.x, 0.01), Math.max(ext.he.y, 0.01),
                  Math.max(ext.he.z, 0.01)),
                t: new THREE.Vector3(0, 0, 0),
                q: nd.getWorldQuaternion(new THREE.Quaternion()),
              }];
            } else {
              const halfSpan = len * 0.45, halfThick = Math.max(0.01, len * 0.05);
              boxes = [boxFor(mid, aW, bW, halfSpan, halfThick, 0.03)];
            }
            const body = mkBody(WT.mass, center, new THREE.Quaternion(), boxes, true);
            body.setDamping(0.35, WT.damping);
            body.setFriction(0.6);        // wings drag on the floor, not slide
            body.setRestitution(0.0);
            body.setRollingFriction(0.0);
            // Wings meet the WORLD only, never the body they hang from.
            //
            // The root segment starts inside the torso box by construction (it
            // is anchored at the shoulder blade), and a contact born penetrating
            // cannot be resolved — that is the hair's poof, and on a plate this
            // size it would fire the whole body across the room. Excluding the
            // torso is not enough either: a folded wing wraps the arm and the
            // leg on that side. So: statics only. A wing can rest on the ground
            // and cannot touch its owner.
            this.world.addRigidBody(body, G_FINGER, G_STATIC);
            _bv1.setValue(0, -9.81 * WT.gravity, 0);
            body.setGravity(_bv1);       // AFTER addRigidBody — the source's lesson
            const lim = WING_LIM * Math.pow((j2 + 1) / list.length, WT.rootExp);
            const mkF = (bdy) => {
              const tr = keep(new AMMO.btTransform());
              tr.setIdentity();
              const o = localOf(bdy, aW);
              _bv2.setValue(o.x, o.y, o.z); tr.setOrigin(_bv2);
              return tr;
            };
            const con = keep(new AMMO.btGeneric6DofSpringConstraint(
              parentBody, body, mkF(parentBody), mkF(body), true));
            _bv1.setValue(0, 0, 0);
            con.setLinearLowerLimit(_bv1); con.setLinearUpperLimit(_bv1);
            _bv1.setValue(-lim, -lim, -lim); con.setAngularLowerLimit(_bv1);
            _bv1.setValue(lim, lim, lim); con.setAngularUpperLimit(_bv1);
            for (let ax = 3; ax < 6; ax++) {
              con.enableSpring(ax, true);
              con.setStiffness(ax, WT.tension);
              con.setDamping(ax, WT.damping);
            }
            // Equilibrium is the pose the wing was BORN in, which the reset
            // above guarantees is the authored one.
            con.setEquilibriumPoint();
            this.world.addConstraint(con, true);
            this._constraints.push(con);
            this._wingSegs.push({
              body, node: nd, parent: nd.parent,
              restWorldQ: nd.getWorldQuaternion(new THREE.Quaternion()),
              con, j: j2, n: list.length,
            });
            parentBody = body;
            built++;
          }
        }
        if (built) {
          // Wings are springbone chains too now (import-tripo-avatar), so the
          // same claim the hair makes has to be made here — otherwise a rig
          // with wings and no hair would have three-vrm and Bullet writing the
          // same bones, and three-vrm runs second.
          avatar.__simHair = true;
          console.log(`[ammodoll] bullet wings: ${wchains.size} chains, ${built} segments`);
        }
      }
    }

    // Hair and wings are the same KIND of thing to the step loop — hung from a
    // carried kinematic anchor, written back to a raw bone, invisible to settle
    // and to the wire. Joined once here rather than concatenated per frame.
    // `?? []` on the hair: _hairAnchors is only assigned INSIDE its build guard,
    // so a rig with no hair leaves it undefined and the spread throws — which is
    // exactly what the fleet's hairless rigs did the first time this ran.
    this._dressAnchors = [...(this._hairAnchors ?? []), ...this._wingAnchors];
    this._dressSegs = [...(this._hairSegs ?? []), ...this._wingSegs];

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
        // ...and the BODY, plus the orientation it was born holding. A bone
        // driven from its direction alone cannot express roll (see step); these
        // two are what make roll recoverable. q0 is identity on a fresh build,
        // where live IS rest — but a seeded body is built mid-tumble, and
        // composing its born orientation onto itself is the "renders at twice
        // its offset" bug this table's own header warns about.
        body: seg.body,
        q0inv: quatOf2(seg.body, new THREE.Quaternion()).invert(),
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
    // How far the render root sits below the hips. This is a property of the
    // RIG (~0.9m on a standing adult), and measuring it against the sim's own
    // hips is right for a fresh body, whose sim starts AT the rest pose — it
    // absorbs the few mm by which the rest-shaped torso reconstructs p.hips off
    // the live skeleton (rapierdoll's frame-one jump).
    //
    // A SEEDED body starts mid-tumble, where p.hips is a metre from rest and
    // near the floor. Measuring there bakes the tumble into the rig: the offset
    // comes out far too small or too large, and every subsequent frame renders
    // the root that much off — she sinks through the ground after a drop, and
    // never on the first push, because only a release rebuilds. restP is the
    // rest pose in WORLD space taken with the root where it is now, so
    // restP.hips.y - root.y is the same constant no matter what the sim is
    // doing or where the root has drifted to.
    // A SEEDED body is not the only one that starts away from rest: the DRAGGER
    // builds a fresh doll on its copy of a body that is already lying down
    // (bodydrag.js), and measuring a standing constant off a prone pose is how
    // she came to land two feet in the air. So do not key on the seed — key on
    // whether the measurement AGREES with the rig. Within a few cm they are the
    // same number and the measured one is kept, preserving the frame-one fix;
    // beyond that the body simply is not at rest, the measurement means
    // nothing, and the rig constant is the only honest answer.
    const restHipsY = this.restP?.hips?.y;
    const measured = (this.p.hips?.y ?? live.hips?.y ?? 0) - avatar.root.position.y;
    const constant = restHipsY != null ? restHipsY - avatar.root.position.y : measured;
    this.hipsOffset = Math.abs(measured - constant) > 0.05 ? constant : measured;
  }

  // ---------------------------------------------------------------- instruments
  // (not used by the sim; the suite asserts on them — metrics that only ask
  // "is it finite / did it settle" cannot see an anatomy failure)

  /** Live per-axis joint angles against their bounds, in the joint basis. */
  /** The collision volumes as the SOLVER holds them, in world space:
   *  `[{ p, q, he }]`, one entry per box (bodies are compounds, so the torso
   *  yields three). The debug overlay's box counterpart to the verlet's
   *  `caps`/`radius`; without it the panel can only draw the skeleton, and the
   *  skeleton is precisely the part that was never in doubt. */
  volumes() {
    const out = [];
    if (!AMMO) return out;
    for (const { body, boxes } of this._vol ?? []) {
      // one value-returning ammo call per statement — see quatOf2
      const t = body.getCenterOfMassTransform();
      const o = t.getOrigin();
      const bp = new THREE.Vector3(o.x(), o.y(), o.z());
      const r = t.getRotation();
      const bq = new THREE.Quaternion(r.x(), r.y(), r.z(), r.w());
      for (const bx of boxes) {
        out.push({
          p: bx.t.clone().applyQuaternion(bq).add(bp),
          q: bq.clone().multiply(bx.q),
          he: bx.he.clone(),
        });
      }
    }
    return out;
  }

  /** Re-apply JOINT_SPECS to the LIVE constraints, no rebuild.
   *
   *  Limits are baked in at construction, so tuning a table by hand and waiting
   *  for the next fall to see it is a slow way to find a number. This pushes
   *  the current table straight into the running joints.
   *
   *  The constraint frames still carry the midpoint they were BUILT with, so
   *  the same midpoint is subtracted back off here — which keeps the numbers
   *  meaning anatomical degrees. What it does not re-do is the frame rotation
   *  itself, so a range retuned to be wildly more asymmetric than it was built
   *  sits closer to Bullet's wrap point than a fresh build would. Tuned values
   *  are meant to be written into the table and rebuilt from; this is the dial,
   *  not the destination.
   */
  retune() {
    if (!AMMO) return 0;
    let n = 0;
    for (const J of this.jointMeta ?? []) {
      const S = JOINT_SPECS[J.spec];
      if (!S || !J.con) continue;
      let xlo, xhi;
      if (S.flex != null) {
        xlo = (J.positiveFlexes ? -S.ext : -S.flex) * DEG;
        xhi = (J.positiveFlexes ? S.flex : S.ext) * DEG;
      } else {
        xlo = S.x[0] * DEG; xhi = S.x[1] * DEG;
      }
      const lo = [xlo, -S.twist * DEG, S.z[0] * DEG];
      const hi = [xhi, S.twist * DEG, S.z[1] * DEG];
      _bv1.setValue(lo[0] - J.mid[0], lo[1] - J.mid[1], lo[2] - J.mid[2]);
      J.con.setAngularLowerLimit(_bv1);
      _bv1.setValue(hi[0] - J.mid[0], hi[1] - J.mid[1], hi[2] - J.mid[2]);
      J.con.setAngularUpperLimit(_bv1);
      J.lo = lo; J.hi = hi;
      n++;
    }
    // a sleeping body will not notice its joints changed under it
    for (const b of this._bodies) b.activate();
    return n;
  }

  /** Push WING_TUNING into the running wings, no rebuild. Same contract as
   *  retuneHair, and the same reason: a wing is being judged on how it settles,
   *  and rebuilding to test a slider throws away the fall you were judging. */
  retuneWings() {
    if (!AMMO || !this._wingSegs?.length) return 0;
    const WT = WING_TUNING;
    for (const ws of this._wingSegs) {
      ws.body.setDamping(0.35, WT.damping);
      _bv1.setValue(0, -9.81 * WT.gravity, 0);
      ws.body.setGravity(_bv1);
      _bv1.setValue(0, 0, 0);
      ws.body.getCollisionShape().calculateLocalInertia(WT.mass, _bv1);
      ws.body.setMassProps(WT.mass, _bv1);
      ws.body.updateInertiaTensor();
      ws.body.activate();
      if (!ws.con) continue;
      const lim = WT.limit * DEG * Math.pow((ws.j + 1) / ws.n, WT.rootExp);
      _bv1.setValue(-lim, -lim, -lim); ws.con.setAngularLowerLimit(_bv1);
      _bv1.setValue(lim, lim, lim); ws.con.setAngularUpperLimit(_bv1);
      for (let ax = 3; ax < 6; ax++) {
        ws.con.setStiffness(ax, WT.tension);
        ws.con.setDamping(ax, WT.damping);
      }
    }
    return this._wingSegs.length;
  }

  /** Push HAIR_TUNING into the running hair, no rebuild.
   *
   *  Everything here is settable on a live body or constraint, so a lock
   *  already swinging changes under your hand — which is the only way to tell
   *  "flows" from "whips" without rebuilding and losing the state you were
   *  looking at. Mass needs its inertia recomputed from the shape, or a heavier
   *  segment keeps a lighter one's resistance to rotation.
   */
  retuneHair() {
    if (!AMMO || !this._hairSegs?.length) return 0;
    const HT = HAIR_TUNING;
    for (const hs of this._hairSegs) {
      hs.body.setDamping(0.25, HT.damping);
      _bv1.setValue(0, -9.81 * HT.gravity, 0);
      hs.body.setGravity(_bv1);
      _bv1.setValue(0, 0, 0);
      hs.body.getCollisionShape().calculateLocalInertia(HT.mass, _bv1);
      hs.body.setMassProps(HT.mass, _bv1);
      hs.body.updateInertiaTensor();
      hs.body.activate();
      if (!hs.con) continue;
      const lim = HT.limit * DEG * Math.pow((hs.j + 1) / hs.n, HT.rootExp);
      _bv1.setValue(-lim, -lim, -lim); hs.con.setAngularLowerLimit(_bv1);
      _bv1.setValue(lim, lim, lim); hs.con.setAngularUpperLimit(_bv1);
      for (let ax = 3; ax < 6; ax++) {
        hs.con.setStiffness(ax, HT.tension);
        hs.con.setDamping(ax, HT.damping);
      }
    }
    return this._hairSegs.length;
  }

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

  // impulse lives on BodyEngineBase — the cap (also applied in _topple above,
  // which the constructor's lean rides through), the topple application and
  // the clock restarts are the shared law.

  /** `firm` distinguishes a NAIL from a HAND. The source has two settings and
   *  ammodoll shipped only the nail's: a drag calls setPin on every mousemove,
   *  so every drag was held by a nail — mass x8 at tau 0.9, a near-rigid handle
   *  hauling a limb through its joint stops, and the contorted result is what
   *  you then let go of. Measured on a haul across the floor, the nail numbers
   *  cost 441 degrees of total limit overshoot against 343 for the hand. */
  setPin(joint, target, firm = false) {
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
      con.get_m_setting().set_m_impulseClamp(this.totalMass * (firm ? PIN_CLAMP_X : GRAB_CLAMP_X));
      con.get_m_setting().set_m_tau(firm ? PIN_TAU : GRAB_TAU);
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

  /** Drag-release handover, the house packed format (rigmeasure.js's
   *  snapshotPacker — the parse on the far side may be the verlet's): joint
   *  names + positions + endpoint velocities (v + ω × r from the centre of
   *  mass). */
  snapshot() {
    // {j:[],p:[],v:[]} would be TRUTHY on `seedVel?.j` — say nothing instead
    if (this._freed) return null;
    this._syncP();
    const pack = snapshotPacker();
    const seen = new Set();
    for (const s of this.segs.values()) {
      if (s.finger) continue;          // the wire carries the core skeleton
      const t = s.body.getCenterOfMassTransform().getOrigin();
      const lv = s.body.getLinearVelocity(), av = s.body.getAngularVelocity();
      for (const name of [s.a, s.b]) {
        if (seen.has(name) || !this.p[name]) continue;
        seen.add(name);
        const q2 = this.p[name];
        _a.set(q2.x - t.x(), q2.y - t.y(), q2.z - t.z());
        _b.set(av.x(), av.y(), av.z()).cross(_a).add(_v.set(lv.x(), lv.y(), lv.z()));
        pack.add(name, q2, _b);
      }
    }
    return pack.pack();
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
    // 0.05, not 0.25 (the source's clamp). 8 substeps at 1/120 covers only
    // 0.067s, so anything past that is handed to the solver as ONE enormous
    // residual step — on hair which, unlike the core bodies, has no angular
    // velocity ceiling. A frame hitch then reads as the hair teleporting.
    dt = Math.min(0.05, Math.max(0, dt || 0));
    // Kinematic roots move BEFORE the step (the source's law): Bullet derives a
    // kinematic body's velocity as (new - old)/dt, so moving one after the step
    // hands the solver a stale offset and the chains get whipped.
    for (const ha of this._dressAnchors ?? []) {
      const t0 = ha.head.getCenterOfMassTransform();
      const o0 = t0.getOrigin();
      _v.set(o0.x(), o0.y(), o0.z());
      const r0 = t0.getRotation();
      _q.set(r0.x(), r0.y(), r0.z(), r0.w());
      _b.copy(ha.local).applyQuaternion(_q).add(_v);
      _bt1.setIdentity();
      _bv1.setValue(_b.x, _b.y, _b.z); _bt1.setOrigin(_bv1);
      _bq1.setValue(_q.x, _q.y, _q.z, _q.w); _bt1.setRotation(_bq1);
      ha.anchor.getMotionState().setWorldTransform(_bt1);
      ha.anchor.setWorldTransform(_bt1);
    }
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

    // the clock law is the base's; this engine's quiet test is linear AND
    // angular, and any noise cancels (no hysteresis band — Bullet's velocities
    // are the solver's own, not a positional estimate that flickers)
    this._settleTick(dt, this.maxV < SETTLE_V && this.maxW < SETTLE_W);

    this._syncP();

    this._followRoot();   // the body lies where it fell — see bodyengine.js

    // bones: rest direction → live direction, world-reference, parents first
    // (drive is in construction order: torso out to fingertips). The node's
    // POSITION is never written — solver error must stretch a joint, not the
    // mesh (the source drives fingers rotation-only for the same reason).
    const pose = {};
    for (const d of this.drive) {
      const bp = this.p[d.bone], cp = this.p[d.child];
      if (!bp || !cp) continue;
      // The BODY's rotation, not the bone's direction.
      //
      // This used to be shortestArc(restDir, liveDir) — the minimal rotation
      // taking the bone from where it pointed to where it points now. That is
      // a pure SWING: it reproduces the direction exactly and discards roll
      // about the bone's own axis completely. So a thigh could be pointing
      // perfectly while its knee faced wherever shortestArc happened to land,
      // which reads as "the leg ended up backwards" — and no twist limit can
      // touch it, because the sim's twist was never what was wrong. Same
      // reason a forearm never showed pronation.
      //
      // Bodies are rest-aligned, so the body's rotation since it was built IS
      // the bone's rotation since it was built. The hair segments (§118) were
      // already driven this way; the core skeleton was not.
      quatOf2(d.body, _q).multiply(d.q0inv).multiply(d.restQuat);
      d.parent.getWorldQuaternion(_qp).invert();
      _qp.multiply(_q);
      d.node.quaternion.copy(_qp);
      pose[d.bone] = [+_qp.x.toFixed(4), +_qp.y.toFixed(4), +_qp.z.toFixed(4), +_qp.w.toFixed(4)];
    }
    this.pose = pose;
    this.avatar.setPose(pose);

    // hair rides raw nodes, local only: world orientation = the body's
    // rest→live rotation composed on the born orientation (rest-aligned
    // bodies make that exact), then into parent-local
    for (const hs of this._dressSegs ?? []) {
      quatOf2(hs.body, _q).multiply(hs.restWorldQ);
      hs.parent.getWorldQuaternion(_qp).invert();
      hs.node.quaternion.copy(_qp.multiply(_q));
      // updateMatrix() IS THE WRITE. Setting .quaternion is not.
      //
      // three-vrm sets `bone.matrixAutoUpdate = false` on every spring-bone
      // joint (three-vrm.module.js:5279) and maintains matrix/matrixWorld by
      // hand inside its own update. So on any rig whose hair is declared as
      // springbones — which is every rig this pipeline builds — a bare
      // quaternion write is composed into `matrix` by nobody and reaches the
      // renderer never. The bones moved, the debug boxes moved, and the mesh
      // stood still: "the hair is bending less than the collider boxes".
      //
      // This is why the WINGS worked from the first try and the hair never did.
      // Wing bones are not springbone joints, so they keep the three.js default
      // and the renderer recomposes them for free.
      hs.node.updateMatrix();
    }

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
    // The hair is left WHERE THE SIM ENDED — dishevelled, and deliberately so:
    // a body that has just been thrown across a room should not stand up with
    // its hair combed. What is NOT left behind is that pose's authority: the
    // combed shape is captured once on the avatar (see __hairRest) and every
    // rebuild snaps back to it before building its springs, so a crumple can
    // never become the next tumble's definition of rest. Restoring the comb
    // here instead is a one-line change if that is ever wanted.
    this.done = true;
    // Hand the hair back ADOPTING the pose it is in.
    //
    // Not handing it back at all was wrong in one specific case, and only that
    // one: a doll disposed MID-TUMBLE — letting go of a body you were dragging
    // — left the hair owned by a sim that no longer existed, frozen in the pose
    // it was dropped in while the body kept falling. Janus saw it on a dragged
    // dummy and never on their own body going limp, which is the tell: a body
    // that falls on its own keeps its doll until it settles.
    //
    // Adopting means three-vrm resumes from the fallen shape rather than
    // combing it (the snap this used to cause), and the hair is LIVE again so
    // it keeps falling with her. The authored shape comes back when she gets
    // up — see _combHair.
    this.avatar?._releaseHair?.({ adopt: true });
    //
    // This used to call springBoneManager.reset() — which does
    // `bone.quaternion.copy(this._initialLocalRotation)` per joint
    // (three-vrm.module.js:5353). That is a snap to the COMBED pose, and since
    // dispose() fires the moment a body settles, it fired a few seconds into
    // every fall: "the hair abruptly jumps back into the default position
    // instead of staying in the position it fell into".
    //
    // A settled corpse keeps the hair the fall gave it. Ownership is released
    // when she gets UP (avatar.js's _releaseHair, off setLimp), which is the
    // moment the shape should start combing itself out again.
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
