// rigmeasure — what the body engines MEASURE and how they SPEAK, extracted.
//
// Two engines simulate a body going limp (bodysim.js's seam): the Verlet
// particle skeleton (ragdoll.js) and the Bullet rig (ammodoll.js). They are
// deliberately different machines — one relaxes particles, one solves rigid
// bodies — and this file is NOT an attempt to merge them. It holds only the
// truths they must AGREE on, which used to live as hand-mirrored copies
// (survey §B2, the disease house rule 1 exists to kill):
//
//   * the BODY CUT — which 12 segments a humanoid is, for either solver;
//   * the segment-vs-segment closest-point solve, spelled once;
//   * the rig frame measured from rest positions (up/lateral/forward);
//   * the HANDOVER FORMAT — the {j,p,v} snapshot a drag-release hands the
//     next sim, across engines and across machines. That one is a wire
//     surface: a verlet on this machine seeds a bullet rig on another, so
//     the pack and the parse must be one truth or the seam drops motion
//     (the dropped-seedVel incident, 2026-08-04).
//
// The lifecycle spine the engines also share (settle clocks, impulse law,
// root-follow) is a class, not a measurement — see bodyengine.js.

import { THREE } from './core.js';

// ---------------------------------------------------------------------------
// the body cut
// ---------------------------------------------------------------------------

// Which bones a body engine drives, each as (bone -> the child joint it points
// at). A reduced set: enough to read as a body, few enough to stay stable and
// to keep the streamed pose small. Order matters: parents before children —
// the verlet's drive walk and feed-forward limit sweep, and the bullet rig's
// build order, both lean on it.
//
// Driving the PELVIS is what lets a body actually lie down — without it the
// pelvis keeps its standing orientation forever and every limb folds ~90°
// around an upright anchor, which reads as a crumple.
//
// This table was byte-identical in three engines (survey §B2); it is the one
// place a segment can be added or renamed now.
export const SEGMENTS = [
  ['hips', 'spine'],
  ['spine', 'chest'], ['chest', 'neck'], ['neck', 'head'],
  ['leftUpperArm', 'leftLowerArm'], ['leftLowerArm', 'leftHand'],
  ['rightUpperArm', 'rightLowerArm'], ['rightLowerArm', 'rightHand'],
  ['leftUpperLeg', 'leftLowerLeg'], ['leftLowerLeg', 'leftFoot'],
  ['rightUpperLeg', 'rightLowerLeg'], ['rightLowerLeg', 'rightFoot'],
];

// Every joint tracked as a particle / segment endpoint (bones + leaf children).
export const JOINTS = [...new Set(SEGMENTS.flat())];

// The bones an engine actually writes a rotation for. Everything else in the
// humanoid — upperChest, the shoulders, hands, feet, toes, every finger — is
// the locomotion mixer's, and must be parked before a tumble starts or the
// clip keeps animating a corpse. avatar.setLimp does the parking; this is the
// list it parks around, exported so the two cannot drift apart.
export const DRIVEN_BONES = SEGMENTS.map(([bone]) => bone);

// ---------------------------------------------------------------------------
// segment geometry
// ---------------------------------------------------------------------------

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();
const _p1 = new THREE.Vector3();
const _p2 = new THREE.Vector3();
const _sd = { s: 0, t: 0 };

/** Closest points between two segments, as parameters along each. The classic
 *  clamped-parametric solve; degenerate (zero-length) segments fall back to an
 *  endpoint rather than dividing by zero. Both engines' self-collision builds
 *  run this — it was spelled twice, differently, before this file. */
export function closestParams(p1, q1, p2, q2, out) {
  _a.copy(q1).sub(p1); _b.copy(q2).sub(p2); _c.copy(p1).sub(p2);
  const A = _a.dot(_a), E = _b.dot(_b), F = _b.dot(_c);
  let s, t;
  if (A < 1e-9 && E < 1e-9) { out.s = 0; out.t = 0; return; }
  if (A < 1e-9) { s = 0; t = THREE.MathUtils.clamp(F / E, 0, 1); }
  else {
    const C = _a.dot(_c);
    if (E < 1e-9) { t = 0; s = THREE.MathUtils.clamp(-C / A, 0, 1); }
    else {
      const B = _a.dot(_b), den = A * E - B * B;
      s = den > 1e-9 ? THREE.MathUtils.clamp((B * F - C * E) / den, 0, 1) : 0;
      t = (B * s + F) / E;
      if (t < 0) { t = 0; s = THREE.MathUtils.clamp(-C / A, 0, 1); }
      else if (t > 1) { t = 1; s = THREE.MathUtils.clamp((B - C) / A, 0, 1); }
    }
  }
  out.s = s; out.t = t;
}

/** Distance between two segments — closestParams, evaluated. */
export function segDistance(p1, q1, p2, q2) {
  closestParams(p1, q1, p2, q2, _sd);
  _p1.copy(p1).lerp(q1, _sd.s);
  _p2.copy(p2).lerp(q2, _sd.t);
  return _p1.distanceTo(_p2);
}

// ---------------------------------------------------------------------------
// the rig frame
// ---------------------------------------------------------------------------

/** The rig's anatomical frame, measured from a map of rest WORLD positions:
 *  up along the trunk, lateral across the shoulders (hips as fallback),
 *  forward as their cross product — which comes out correct for VRM 0.x and
 *  1.0 alike without needing to know which (they face opposite ways on +Z,
 *  and the lateral vector flips with them, so the cross product cancels the
 *  convention out). Every value is a fresh vector; callers own them. */
export function rigFrameOf(restP) {
  const up = (restP.neck ?? restP.chest ?? restP.spine ?? restP.head)
    ?.clone().sub(restP.hips ?? new THREE.Vector3()).normalize() ?? new THREE.Vector3(0, 1, 0);
  const lateral = restP.leftUpperArm && restP.rightUpperArm
    ? restP.leftUpperArm.clone().sub(restP.rightUpperArm)
    : (restP.leftUpperLeg && restP.rightUpperLeg
      ? restP.leftUpperLeg.clone().sub(restP.rightUpperLeg)
      : new THREE.Vector3(1, 0, 0));
  lateral.addScaledVector(up, -lateral.dot(up));
  if (lateral.lengthSq() < 1e-9) lateral.set(1, 0, 0);
  lateral.normalize();
  const forward = new THREE.Vector3().crossVectors(lateral, up).normalize();
  return { up, lateral, forward };
}

// ---------------------------------------------------------------------------
// the handover format
// ---------------------------------------------------------------------------

/** Builder for the {j,p,v} handover snapshot — joint names, world positions,
 *  world velocities, flat-packed and rounded. Rounded on purpose: this rides a
 *  presence message, and a millimetre and a millimetre-per-second are far
 *  below what anyone can see. Both engines' snapshot() speaks through this so
 *  the format cannot fork. */
export function snapshotPacker() {
  const j = [], p = [], v = [];
  return {
    add(name, pos, vel) {
      j.push(name);
      // FULL PRECISION. A handover is the SAME body continuing on another
      // machine, and a tumbling body is chaotic: rounding positions to 0.1mm
      // and velocities to 1mm/s here read as 0.01cm after one step and
      // 1–35cm after eighty on 20 of 44 fleet rigs, while the exact numbers
      // continue to 0.00cm (§24t-8). JSON's shortest-round-trip formatting
      // is exact; a snapshot is a rare event and ~1KB is nothing on the wire.
      p.push(pos.x, pos.y, pos.z);
      v.push(vel.x, vel.y, vel.z);
    },
    pack() { return { j, p, v }; },
  };
}

/** Iterate a handover snapshot ({j,p,v}, optional dy height shift): yields
 *  { name, px,py,pz, vx,vy,vz } per joint, dy already applied to the position.
 *  The parse half of snapshotPacker, and the other place the format used to
 *  be spelled twice. */
export function* seedJoints(seed) {
  const { j: names, p: pos, v: vel, dy = 0 } = seed;
  for (let i = 0; i < names.length; i++) {
    const k = i * 3;
    yield {
      name: names[i],
      px: pos[k], py: pos[k + 1] + dy, pz: pos[k + 2],
      vx: vel[k], vy: vel[k + 1], vz: vel[k + 2],
    };
  }
}
