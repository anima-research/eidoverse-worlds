// ragdoll — a body going limp, simulated by ONE machine (the body's owner) and streamed.
//
// Single authority, not determinism: the owner streams the resulting sparse bone rotations through the presence
// `pose` field (the channel a held pose already uses, so remotes need no new receiver code), and when it settles,
// captures the final bones as a held pose, never a replay. A late joiner's snapshot has them dropped (server.ts
// settledPose turns a `ragdoll` clip to idle); the owner's next presence packet brings them back. The server
// never simulates and never sees a bone.
//
// The simulator is a Verlet particle skeleton with MASS (constraints split by inverse mass), VOLUME (bones are
// capsules), HANDEDNESS (knees and elbows bend one way, from a body frame the particles supply: _frame) and a FIXED
// STEP (so the physics is not a function of framerate). Everything anatomical is measured from the rig at
// construction, because the shipped avatars disagree about nearly everything.
//
// The reasons and numbers behind the rules: docs/research/verlet-ragdoll.md (cited as verlet-ragdoll.md §N).

import { THREE } from '../core.js';
import { BEHIND, CONE, HINGE, TWIST, TWIST_PARENT, RADIUS_FRAC, torsoRadius } from '../../../shared/joints.js';
import { heightAt } from '../terrain.js';
import { resolveColliders } from '../colliders.js';
import { SEGMENTS, JOINTS, DRIVEN_BONES, closestParams, snapshotPacker, seedJoints } from './rigmeasure.js';
import { BodyEngineBase } from './bodyengine.js';

// ---------------------------------------------------------------------------
// topology
// ---------------------------------------------------------------------------

// The body cut, the joint list and the driven-bone list live in rigmeasure.js
// (one table for both engines); re-exported for avatar.setLimp and bodydrag.
const CHAINS = SEGMENTS;
export { JOINTS, DRIVEN_BONES, closestParams };

// BONES are the segments with physical volume (they collide and are seen). hips->upperLeg and chest->upperArm are
// bones though no chain drives them; avatar.js setLimp neutralizes any upperChest/shoulder in between so the span
// is rigid, as this model assumes.
const BONES = [
  ...CHAINS,
  ['hips', 'leftUpperLeg'], ['hips', 'rightUpperLeg'],
  ['chest', 'leftUpperArm'], ['chest', 'rightUpperArm'],
];

// BRACES carry no volume and are never drawn or collided: they truss the trunk into one body the limbs hang off.
// Their rest lengths come from the NEUTRAL pose (the `rest` constructor argument): a diagonal changes with the pose.
const BRACES = [
  ['leftUpperArm', 'rightUpperArm'],     // shoulder bar
  ['leftUpperLeg', 'rightUpperLeg'],     // pelvis bar
  ['hips', 'chest'],                     // trunk column
  ['spine', 'neck'],
];
const LINKS = [...BONES, ...BRACES];

// Relative mass per joint (only ratios matter): the pelvis and chest are the body, everything else hangs off them.
const MASS = {
  hips: 12, spine: 8, chest: 10, neck: 2, head: 5,
  leftUpperArm: 2.5, rightUpperArm: 2.5,
  leftLowerArm: 1.5, rightLowerArm: 1.5,
  leftHand: 0.5, rightHand: 0.5,
  leftUpperLeg: 7, rightUpperLeg: 7,
  leftLowerLeg: 4, rightLowerLeg: 4,
  leftFoot: 1.2, rightFoot: 1.2,
};

const FIXED_DT = 1 / 60;   // the sim's only clock — see the header
const MAX_FRAMES = 4;
const PIN_JUMP = 0.12;     // metres/frame — past this a pin jumped, it did not move

// Everything tunable, in one mutable object so a sweep (test/labs/rag-tune.mjs)
// can drive it without editing the file. Measurements: verlet-ragdoll.md §2.
export const TUNING = {
  GRAVITY: -9.8,
  // Splitting the TIME step beats relaxing one big step harder at the same
  // cost, mostly for framerate independence; past 2 substeps it stops paying.
  SUBSTEPS: 2,
  ITER: 3,                 // relaxation passes per substep
  // A body HANGING from a pin needs far more passes than a body falling:
  // Gauss-Seidel propagates tension one link per pass. Only paid while pinned.
  ITER_PINNED: 16,
  DAMP: 0.98,              // per FRAME, spread across the substeps
  SLEEP_DAMP: 0.8,         // ...harder once nearly still, see _solve
  YIELD: 0.5,              // fraction of an angular violation fixed per pass
  CAPSULE_SOFT: 0.6,       // fraction of an overlap resolved per pass
  TWIST_DAMP: 0.88,        // per frame, on the twist velocity
  TWIST_STIFF: 26,         // rad/s per rad — passive pull back to neutral
  // A twist driver, off: with no torque to answer, measured it only ever adds twist.
  TWIST_LAG: 0,
  // Live switches for the debug panel: turn a rule off mid-tumble to find which
  // one is responsible for a shape that looks wrong.
  ON_FLEX: 1, ON_CONE: 1, ON_BEHIND: 1, ON_HINGE: 1,
  ON_CAPSULE: 1, ON_BRACE: 1, ON_TWIST: 1, ON_GROUND: 1,
  PAUSED: 0,
  // PIN_VEL gives a pinned joint the PIN's velocity instead of the whole
  // distance it travelled (which drags in energy as torsion). Off by default:
  // a real hand on the debug-panel switch is the test that settles it.
  PIN_VEL: 0,
  SETTLE_V: 0.06,          // speed below which we call it settled...
  SETTLE_TIME: 0.4,        // ...for this long, in SECONDS, not frames
  // The settle test takes the fastest joint in the body; hysteresis means it
  // takes real motion to restart the clock, not a flicker.
  SETTLE_RESET: 3,         // multiple of SETTLE_V that cancels a settle
  // Force the capture after this long: a tumble always ENDS as a held pose,
  // never streaming presence forever.
  DEADLINE: 8,
};

// ---------------------------------------------------------------------------
// joint limits — three kinds (FLEX here; BEHIND/CONE/HINGE in shared/joints.js),
// because one unsigned-bend table could express none of them (verlet-ragdoll.md §3).
// ---------------------------------------------------------------------------

// FLEX — symmetric cones between two adjacent links, for the spine and neck.
// Symmetric is anatomically wrong (too much backbend) and deliberately kept: a
// signed limit flickers near straight. verlet-ragdoll.md §3.
const FLEX = [
  // a         b        c         max° from the rig's own rest angle
  ['hips',   'spine', 'chest',    25],   // lower spine: stiff
  ['spine',  'chest', 'neck',     25],
  ['chest',  'neck',  'head',     45],   // neck: floppier
];

// The joint envelope — BEHIND, CONE, HINGE, TWIST — lives in shared/joints.js,
// shared with the reach solver; what each value cost to find is documented there.

// Self-collision radii live in shared/joints.js too.

const D2R = Math.PI / 180;

const _v = new THREE.Vector3();
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();
const _n = new THREE.Vector3();
const _t = new THREE.Vector3();
const _u = new THREE.Vector3();
const _bz = new THREE.Vector3();
const _by = new THREE.Vector3();
const _mat = new THREE.Matrix4();
const _qd2 = new THREE.Quaternion();
const _qBody = new THREE.Quaternion();
const _qs = new THREE.Quaternion();
const _qsi = new THREE.Quaternion();
const _qL = new THREE.Quaternion();
const _qt = new THREE.Quaternion();
const _qpi = new THREE.Quaternion();
const _t2 = new THREE.Vector3();
const _t3 = new THREE.Vector3();
const _qtw = new THREE.Quaternion();
const _X = new THREE.Vector3(1, 0, 0);
const _s1 = new THREE.Vector3();   // swing: correction direction
const _s2 = new THREE.Vector3();   // swing: velocity probe
const _ca = new THREE.Vector3();
const _cb = new THREE.Vector3();
const _qd = new THREE.Quaternion();
const _qp = new THREE.Quaternion();
// closestParams' two outputs, hoisted: it runs once per capsule pair per pass
const _pr = { s: 0, t: 0 };

/** An orthonormal basis with X down the bone and its roll pinned by `ref`.
 *  Leaves the orthonormalized reference in `_bz` so the caller can carry it
 *  forward. Returns false only when the bone lies along `ref`, where roll is
 *  undefined and the caller must reseed. */
function basisOf(dir, ref, out) {
  _bz.copy(ref).addScaledVector(dir, -ref.dot(dir));
  if (_bz.lengthSq() < 1e-4) return false;
  _bz.normalize();
  _by.crossVectors(_bz, dir);
  _mat.makeBasis(dir, _by, _bz);
  out.setFromRotationMatrix(_mat);
  return true;
}

/** The roll reference for a bone, TRANSPORTED rather than rebuilt: re-squaring
 *  the carried reference against the bone cannot flip, where re-deriving it
 *  from a body axis snaps the roll when a limb swings onto that axis
 *  (verlet-ragdoll.md §7). */
function rollRef(dir, up, frame) {
  if (basisOf(dir, up, _qd2)) { up.copy(_bz); return true; }
  for (const ax of [frame.r, frame.u, frame.f]) {
    if (basisOf(dir, ax, _qd2)) { up.copy(_bz); return true; }
  }
  return false;
}

/** World positions of the simulated joints — the shape a sim is in, so the
 *  next one can be handed both it and the motion it had. */
export function jointPositions(avatar, out = new Map()) {
  const h = avatar?.vrm?.humanoid;
  if (!h) return out;
  for (const j of JOINTS) {
    const n = h.getNormalizedBoneNode(j);
    if (n) out.set(j, n.getWorldPosition(out.get(j) ?? new THREE.Vector3()));
  }
  return out;
}

/** The roll component of `q` about `axis` — the twist half of a swing-twist
 *  decomposition, signed, in radians. */
function twistAbout(q, axis) {
  _t3.set(q.x, q.y, q.z);
  const along = _t3.dot(axis);
  _qtw.set(axis.x * along, axis.y * along, axis.z * along, q.w);
  if (_qtw.lengthSq() < 1e-12) return 0;
  _qtw.normalize();
  let a = 2 * Math.acos(THREE.MathUtils.clamp(_qtw.w, -1, 1));
  if (a > Math.PI) a -= Math.PI * 2;
  return along < 0 ? -a : a;
}

export class Ragdoll extends BodyEngineBase {
  /** @param avatar   the OWNER's Avatar.
   *  @param lean     optional topple velocity in m/s (see _topple).
   *  @param rest     optional map joint -> neutral-rest WORLD position (Avatar.restBonePositions()), captured with
   *                  the root where it is NOW: hipsOffset is the pelvis's height above the root. Every limit is
   *                  measured against this, not the live skeleton, or a body limp mid-stride takes the stride's
   *                  angles as its zero.
   *  @param seedVel  optional map joint -> velocity (m/s), to inherit motion from a sim replaced mid-flight. */
  constructor(avatar, lean = null, rest = null, seedVel = null) {
    super(avatar);                    // lifecycle fields — see bodyengine.js
    this.acc = 0;
    this.steps = 0;                   // step() calls; see the debug panel
    this.frames = 0;                  // ...and substeps actually simulated
    const h = avatar.vrm.humanoid;

    // capture live references in WORLD space, before anything moves
    this.nodes = {};        // joint -> node
    this.p = {};            // joint -> current world pos
    this.prev = {};         // joint -> previous world pos (verlet)
    this.pre = {};          // joint -> position at the start of this step
    for (const j of JOINTS) {
      const node = h.getNormalizedBoneNode(j);
      if (!node) continue;
      this.nodes[j] = node;
      const wp = node.getWorldPosition(new THREE.Vector3());
      this.p[j] = wp.clone();
      // a sim built mid-motion inherits it: Verlet keeps velocity in p - prev
      const v = seedVel?.get?.(j) ?? (seedVel && !seedVel.j ? seedVel[j] : null);
      this.prev[j] = v ? wp.clone().addScaledVector(v, -FIXED_DT) : wp.clone();
      this.pre[j] = wp.clone();      // step-start position, for the settle test
    }
    // a handover snapshot outranks the bones: where the particles actually were, at what speed
    if (seedVel?.j) {
      for (const s of seedJoints(seedVel)) {
        if (!this.p[s.name]) continue;
        this.p[s.name].set(s.px, s.py, s.pz);
        this.prev[s.name].copy(this.p[s.name]).addScaledVector(
          _v.set(s.vx, s.vy, s.vz), -FIXED_DT);
      }
    }

    // the neutral skeleton every limit is measured against; falls back to the
    // live one joint-by-joint so a caller that has no rest map still works
    this.rest = {};
    for (const j of Object.keys(this.p)) {
      this.rest[j] = (rest && rest[j]) ? rest[j].clone() : this.p[j].clone();
    }

    // how it goes over: `lean` (m/s) is applied weighted by height, a topple about the feet; a uniform shove would
    // only slide and pancake it (verlet-ragdoll.md §4)
    if (lean) this._topple(lean);

    // inverse mass; a missing entry gets the lightest plausible weight, never infinite mass
    this.iw = {};
    for (const j of Object.keys(this.p)) this.iw[j] = 1 / (MASS[j] ?? 1);
    this._pinFrom = new Map();        // each pin's target at frame start

    // rest length of each link, from the neutral pose (see BRACES)
    this.links = LINKS.filter(([a, b]) => this.p[a] && this.p[b])
      .map(([a, b]) => ({
        a, b, len: this.rest[a].distanceTo(this.rest[b]),
        brace: BRACES.some((x) => x[0] === a && x[1] === b),
      }))
      .filter((l) => l.len > 1e-5);

    // the rig's own body frame, in which the CONE and HINGE limits are stated
    this.frame = { r: new THREE.Vector3(), u: new THREE.Vector3(), f: new THREE.Vector3() };
    this._frame(this.rest);
    const r0 = this.frame.r.clone(), u0 = this.frame.u.clone(), f0 = this.frame.f.clone();
    const toLocal = (world, out) =>
      out.set(world.dot(r0), world.dot(u0), world.dot(f0));

    // ---- FLEX: symmetric cones between adjacent links, off the rest angle. A row whose rest link is a micro-link
    // (a spine authored millimetres above the hips) is skipped: jitter would read as flexion (verlet-ragdoll.md §3).
    this.flex = [];
    const FLEX_MIN_LINK = 0.03;
    for (const [a, b, c, max] of FLEX) {
      if (!this.rest[a] || !this.rest[b] || !this.rest[c]) continue;
      if (this.rest[b].distanceTo(this.rest[a]) < FLEX_MIN_LINK
        || this.rest[c].distanceTo(this.rest[b]) < FLEX_MIN_LINK) continue;
      _a.copy(this.rest[b]).sub(this.rest[a]).normalize();
      _b.copy(this.rest[c]).sub(this.rest[b]).normalize();
      const at = Math.acos(THREE.MathUtils.clamp(_a.dot(_b), -1, 1));
      this.flex.push({ a, b, c, max: Math.min(Math.PI, at + max * D2R) });
    }

    // ---- BEHIND: the frontal-plane stop, as a minimum forward component
    this.behind = [];
    for (const [b, c, deg] of BEHIND) {
      if (this.p[b] && this.p[c]) this.behind.push({ b, c, minFwd: -Math.sin(deg * D2R) });
    }

    // ---- CONE: limb direction vs the torso, stored in body-frame coordinates
    // so it survives any rig's rest pose. The axis is the rest direction leaned
    // `tilt` degrees toward forward.
    this.cone = [];
    for (const [b, c, half, tilt] of CONE) {
      if (!this.rest[b] || !this.rest[c]) continue;
      const axis = new THREE.Vector3();
      toLocal(_a.copy(this.rest[c]).sub(this.rest[b]).normalize(), axis);
      if (tilt) {
        // the forward component perpendicular to the axis, so the lean is a
        // pure rotation in the sagittal plane rather than a shortening
        _v.set(0, 0, 1).addScaledVector(axis, -axis.z);
        if (_v.lengthSq() > 1e-8) axis.addScaledVector(_v.normalize(), Math.tan(tilt * D2R));
      }
      this.cone.push({ b, c, axis: axis.normalize(), cos: Math.cos(half * D2R) });
    }

    // ---- HINGE: signed, one-sided, with a sideways tolerance. The hinge AXIS
    // is seeded here from the rest pose and then transported with the limb
    // (see _limits) rather than rebuilt from the body each pass.
    this.hinge = [];
    for (const [a, b, c, dir, maxFlex, side] of HINGE) {
      if (!this.rest[a] || !this.rest[b] || !this.rest[c]) continue;
      _a.copy(this.rest[b]).sub(this.rest[a]);
      if (_a.lengthSq() < 1e-8) continue;
      _a.normalize();
      _c.copy(f0).multiplyScalar(dir);          // which way this joint folds
      _c.addScaledVector(_a, -_c.dot(_a));      // ...perpendicular to the limb
      if (_c.lengthSq() < 1e-8) continue;
      this.hinge.push({
        a, b, c, max: maxFlex * D2R, side: Math.sin(side * D2R),
        n: new THREE.Vector3().crossVectors(_a, _c.normalize()).normalize(),
      });
    }
    // a handover carries the transported hinge axes (`h`, in this.hinge order): they are physical state, and a doll
    // rebuilt from the REST normals fires a correction on its first step (verlet-ragdoll.md §5). A snapshot without
    // them (another engine's) gets normals derived from where the limbs are.
    if (seedVel?.j) {
      const h = Array.isArray(seedVel.h) && seedVel.h.length === this.hinge.length * 3 ? seedVel.h : null;
      this.hinge.forEach((H, i) => {
        if (h) { H.n.set(h[i * 3], h[i * 3 + 1], h[i * 3 + 2]); if (H.n.lengthSq() > 1e-8) { H.n.normalize(); return; } }
        _a.copy(this.p[H.b]).sub(this.p[H.a]);
        if (_a.lengthSq() < 1e-8) return;
        _a.normalize();
        // keep the rest normal's fold sense, re-squared against the live limb
        _c.copy(H.n).cross(_a);                    // the fold direction implied by the rest normal
        _c.addScaledVector(_a, -_c.dot(_a));
        if (_c.lengthSq() < 1e-8) return;
        H.n.crossVectors(_a, _c.normalize()).normalize();
      });
    }

    // ---- capsules: every BONE is a fat segment, and pairs of them push apart
    this._buildCapsules();

    // per-driven-bone rest reference (restLocal), in its TWIST PARENT's frame. Each step the minimal arc from
    // restLocal's axis to the live direction carries the frame across: a function of current state only, so no
    // drift; roll is `tw`, integrated below.
    this._frame(this.p);
    _mat.makeBasis(this.frame.r, this.frame.u, this.frame.f);
    const bodyRest = new THREE.Quaternion().setFromRotationMatrix(_mat);
    const axes = [this.frame.r, this.frame.u, this.frame.f];

    this.drive = [];
    this.driveBy = new Map();
    for (const [bone, child] of CHAINS) {
      const bn = this.nodes[bone];
      if (!bn || !this.p[child]) continue;
      const bwp = bn.getWorldPosition(new THREE.Vector3());
      _v.copy(this.p[child]).sub(bwp);
      if (_v.lengthSq() < 1e-8) continue;
      const dir = _v.clone().normalize();
      // any stable reference will do for the REST frame — it is only ever used
      // as the fixed thing the live frame is measured against
      let ref = 0;
      for (let i = 1; i < 3; i++) {
        if (Math.abs(dir.dot(axes[i])) < Math.abs(dir.dot(axes[ref]))) ref = i;
      }
      const restFrame = new THREE.Quaternion();
      if (!basisOf(dir, axes[ref], restFrame)) continue;

      const tp = TWIST_PARENT[bone] ?? null;
      const parentRest = tp ? this.driveBy.get(tp)?.restFrame : bodyRest;
      if (tp && !parentRest) continue;                 // parent bone absent on this rig
      const restLocal = parentRest.clone().invert().multiply(restFrame);

      const d = {
        bone, child, twistParent: tp,
        restFrame,
        restFrameInv: restFrame.clone().invert(),
        restLocal,
        restLocalAxis: new THREE.Vector3(1, 0, 0).applyQuaternion(restLocal),
        restQuat: bn.getWorldQuaternion(new THREE.Quaternion()),
        parent: bn.parent,
        // ---- twist, as state
        tw: 0, twv: 0,
        twMax: (TWIST[bone] ?? 180) * D2R,
        frameW: restFrame.clone(),                     // resolved each step
        swingW: restFrame.clone(),                     // ...before twist
      };
      this.drive.push(d);
      this.driveBy.set(bone, d);
    }
    this.bodyRest = bodyRest;

    this.rootStartY = avatar.root.position.y;
    // how far the model origin sits below the hips: measured from the neutral pose (verlet-ragdoll.md §6)
    this.hipsOffset = this.rest.hips
      ? this.rest.hips.y - avatar.root.position.y
      : 0.82;
    this._measureHipsLocal(this.rest.hips);   // ...and sideways (bodyengine.js)
  }

  /** The body's own frame, from its particles: right across the pelvis, up the spine, forward their cross product,
   *  which is the anatomical forward for VRM 0.x and 1.0 alike (verlet-ragdoll.md §9). */
  _frame(p) {
    const { r, u, f } = this.frame;
    if (p.leftUpperLeg && p.rightUpperLeg) r.copy(p.leftUpperLeg).sub(p.rightUpperLeg);
    else if (p.leftUpperArm && p.rightUpperArm) r.copy(p.leftUpperArm).sub(p.rightUpperArm);
    else r.set(1, 0, 0);
    if (p.head && p.hips) u.copy(p.head).sub(p.hips);
    else if (p.chest && p.hips) u.copy(p.chest).sub(p.hips);
    else u.set(0, 1, 0);
    if (r.lengthSq() < 1e-10) r.set(1, 0, 0);
    if (u.lengthSq() < 1e-10) u.set(0, 1, 0);
    r.normalize(); u.normalize();
    // A body folded until the spine lies along the pelvis bar has no definable
    // forward: keep the last good one, or a hinge's handedness jumps.
    _v.crossVectors(r, u);
    if (_v.lengthSq() > 1e-8) f.copy(_v).normalize();
    else if (f.lengthSq() < 1e-8) f.set(0, 0, 1);      // first call, none to keep
    _v.crossVectors(u, f);
    if (_v.lengthSq() > 1e-8) r.copy(_v).normalize();
  }

  /** Bone capsules, and which pairs of them should push each other apart.
   *  Excluded: pairs sharing a joint (they always touch), and pairs whose
   *  NEUTRAL separation is already inside the combined radius — a constraint
   *  violated at rest is a motor that inflates the torso. */
  _buildCapsules() {
    // shared/joints.js's torsoRadius IS this derivation, shared with the reach solver.
    const P = {};
    for (const j of ['leftUpperArm', 'rightUpperArm', 'leftUpperLeg', 'rightUpperLeg', 'hips', 'head']) {
      if (this.rest[j]) P[j] = [this.rest[j].x, this.rest[j].y, this.rest[j].z];
    }
    const torsoR = torsoRadius(P);

    this.radius = {};
    for (const j of Object.keys(this.p)) this.radius[j] = torsoR * (RADIUS_FRAC[j] ?? 0.4);

    this.caps = BONES
      .filter(([a, b]) => this.p[a] && this.p[b])
      .map(([a, b]) => ({ a, b, r: (this.radius[a] + this.radius[b]) / 2 }));

    this.pairs = [];
    for (let i = 0; i < this.caps.length; i++) {
      for (let k = i + 1; k < this.caps.length; k++) {
        const A = this.caps[i], B = this.caps[k];
        if (A.a === B.a || A.a === B.b || A.b === B.a || A.b === B.b) continue;
        const min = A.r + B.r;
        closestParams(this.rest[A.a], this.rest[A.b], this.rest[B.a], this.rest[B.b], _pr);
        _ca.copy(this.rest[A.a]).lerp(this.rest[A.b], _pr.s);
        _cb.copy(this.rest[B.a]).lerp(this.rest[B.b], _pr.t);
        if (_ca.distanceTo(_cb) < min * 1.02) continue;   // overlapping at rest
        this.pairs.push({ A, B, min });
      }
    }
  }

  // ---- one rendered frame's worth of physics --------------------------------
  _solve() {
    // once the body is nearly still, damp hard (island sleeping), or a hand chatters forever
    const damp = this.maxV < TUNING.SETTLE_V * 4 ? TUNING.SLEEP_DAMP : TUNING.DAMP;
    const n = Math.max(1, TUNING.SUBSTEPS | 0);
    const sdt = FIXED_DT / n;
    const sdamp = Math.pow(damp, 1 / n);   // keeps DAMP meaning "per frame"

    // where the frame started, for the settle test at the bottom
    for (const j of JOINTS) { const p = this.p[j]; if (p) this.pre[j].copy(p); }

    const iters = this.pinned ? TUNING.ITER_PINNED : TUNING.ITER;
    for (let s = 0; s < n; s++) this._substep(sdt, sdamp, iters);

    // Full world collision (props AND terrain) once per FRAME, not per pass
    // (it is a spatial-hash query); the substeps keep a cheap terrain clamp.
    this._world();
    this._limits();

    // speed = distance actually travelled this frame, not Verlet's (p - prev): limits carry their correction into
    // prev, so a joint parked on its limit would otherwise never settle
    let moved = 0;
    for (const j of JOINTS) {
      const p = this.p[j]; if (!p) continue;
      moved = Math.max(moved, p.distanceToSquared(this.pre[j]));
    }
    this.maxV = Math.sqrt(moved) / FIXED_DT;
  }

  _substep(dt, damp, iters = TUNING.ITER) {
    for (const j of JOINTS) {
      const p = this.p[j]; if (!p) continue;
      const pr = this.prev[j];
      _v.copy(p).sub(pr).multiplyScalar(damp);
      pr.copy(p);
      p.add(_v);
      p.y += TUNING.GRAVITY * dt * dt;
    }
    this._pin(dt);
    this._frame(this.p);
    for (let it = 0; it < iters; it++) {
      this._links();
      this._capsules();
      this._terrain();
      this._limits();
    }
    // ...and again at the end: the constraints have had their say, and a nail
    // is a nail. Position only, so it invents no velocity.

  }

  /** Pinned joints go exactly where their pins say. With TUNING.PIN_VEL, prev carries the pin's own velocity, so a
   *  swung body keeps its momentum when let go (verlet-ragdoll.md §2). */
  _pin(dt) {
    if (!this.pins?.size) { this._pinFrom.clear(); return; }
    const k = dt / FIXED_DT;               // this substep, as a fraction of a frame
    for (const [j, t] of this.pins) {
      if (!this.p[j]) continue;
      const from = this._pinFrom.get(j);
      this.p[j].copy(t);
      if (!TUNING.PIN_VEL) continue;                       // position only
      // a pin just set, or dragged faster than any hand moves, is a teleport: land it dead
      _v.copy(t).sub(from ?? t);
      if (!from || _v.lengthSq() > PIN_JUMP * PIN_JUMP) this.prev[j].copy(t);
      else this.prev[j].copy(t).sub(_v.multiplyScalar(k));
    }
    for (const j of [...this._pinFrom.keys()]) if (!this.pins.has(j)) this._pinFrom.delete(j);
  }

  _links() {
    for (const { a, b, len, brace } of this.links) {
      if (brace && !TUNING.ON_BRACE) continue;
      const pa = this.p[a], pb = this.p[b];
      const wa = this.iw[a], wb = this.iw[b], ws = wa + wb;
      if (ws <= 0) continue;
      _v.copy(pb).sub(pa);
      const d = _v.length() || 1e-4;
      _v.multiplyScalar((d - len) / d / ws);
      pa.addScaledVector(_v, wa);
      pb.addScaledVector(_v, -wb);
    }
  }

  /** Capsule-vs-capsule: the bone shafts push apart. The correction lands on all four endpoints, weighted by where
   *  the contact fell and by inverse mass, so a wrist bounces off the chest rather than shoving it. */
  _capsules() {
    if (!TUNING.ON_CAPSULE) return;
    for (const { A, B, min } of this.pairs) {
      const a0 = this.p[A.a], a1 = this.p[A.b], b0 = this.p[B.a], b1 = this.p[B.b];
      closestParams(a0, a1, b0, b1, _pr);
      const s = _pr.s, t = _pr.t;
      _ca.copy(a0).lerp(a1, s);
      _cb.copy(b0).lerp(b1, t);
      _n.copy(_cb).sub(_ca);
      const d = _n.length();
      if (d >= min || d < 1e-6) continue;
      _n.divideScalar(d);
      const wA0 = (1 - s) * this.iw[A.a], wA1 = s * this.iw[A.b];
      const wB0 = (1 - t) * this.iw[B.a], wB1 = t * this.iw[B.b];
      const tot = wA0 + wA1 + wB0 + wB1;
      if (tot <= 1e-9) continue;
      const pen = (min - d) * TUNING.CAPSULE_SOFT / tot;
      a0.addScaledVector(_n, -pen * wA0);
      a1.addScaledVector(_n, -pen * wA1);
      b0.addScaledVector(_n, pen * wB0);
      b1.addScaledVector(_n, pen * wB1);
      // inelastic, as the joint limits are (see _stop): a soft push leaves resting limbs trading energy forever
      _s1.copy(_n);
      this._stop(A.a, -1); this._stop(A.b, -1);
      this._stop(B.a, 1); this._stop(B.b, 1);
    }
  }

  _terrain() {
    // a pure vertical clamp, so a grounded body can creep while an arm fights its limits (open: verlet-ragdoll.md §8)
    for (const j of JOINTS) {
      const p = this.p[j]; if (!p) continue;
      const g = heightAt(p.x, p.z) + this._clear(j);
      if (p.y < g) p.y = g;
    }
  }

  /** Vertical clearance for a joint: its own measured radius (resolveColliders
   *  treats a radius as horizontal, so nothing else holds a joint up). */
  _clear(j) { return Math.max(0.02, this.radius[j] ?? 0.05); }

  /** Terrain and props, through resolveColliders (the walking controller's routine), so a body drapes over a crate. */
  _world() {
    if (!TUNING.ON_GROUND) return;
    for (const j of JOINTS) {
      const p = this.p[j]; if (!p) continue;
      const x0 = p.x, z0 = p.z;
      const r = this._clear(j);
      // `r` twice over: the horizontal radius and the body height above the
      // point — a joint is a bead, so a limb can rest UNDER a table.
      const g = resolveColliders(p, heightAt, r, r) + r;
      const pushed = Math.abs(p.x - x0) > 1e-5 || Math.abs(p.z - z0) > 1e-5;
      if (p.y < g) {
        p.y = g;
        // friction: bleed horizontal motion on contact so it doesn't slide
        this.prev[j].x += (p.x - this.prev[j].x) * 0.4;
        this.prev[j].z += (p.z - this.prev[j].z) * 0.4;
      }
      // a sideways push out of a prop should also lose momentum, or the joint
      // just springs back in next step
      if (pushed) {
        this.prev[j].x += (p.x - this.prev[j].x) * 0.3;
        this.prev[j].z += (p.z - this.prev[j].z) * 0.3;
      }
    }
  }

  /** Move the distal particle so its bone points at `dir`, carrying the move into `prev` so it reads as no velocity.
   *  Distal-only: the tables run proximal->distal, so no clamp disturbs a triple already solved this pass. */
  _swing(b, c, dir, lb) {
    const pb = this.p[b], pc = this.p[c];
    const wb = this.iw[b], wc = this.iw[c], ws = wb + wc;
    if (ws <= 0) return;
    _t.copy(dir).multiplyScalar(lb).sub(pc).add(pb);   // Δ = dir·lb − (pc − pb)
    // a correction worth half the bone is a teleport: land it dead (prev = p) (verlet-ragdoll.md §3)
    const dead = _t.lengthSq() > lb * lb * 0.25;
    _s1.copy(_t).normalize();                // the direction we are correcting
    _u.copy(_t).multiplyScalar(wc / ws);
    pc.add(_u);
    if (dead) this.prev[c].copy(pc); else { this.prev[c].add(_u); this._stop(c, 1); }
    _u.copy(_t).multiplyScalar(-wb / ws);
    pb.add(_u);
    if (dead) this.prev[b].copy(pb); else { this.prev[b].add(_u); this._stop(b, -1); }
  }

  /** A joint limit is a hard stop, not a spring: keep the position, remove only the velocity component driving into
   *  the limit (verlet-ragdoll.md §3). `side` is +1 for the particle moved along the correction, -1 against it. */
  _stop(j, side) {
    const vn = _s2.copy(this.p[j]).sub(this.prev[j]).dot(_s1);
    if (vn * side < 0) this.prev[j].addScaledVector(_s1, vn);
  }

  _limits() {
    // ---- FLEX: symmetric cone between adjacent links
    if (TUNING.ON_FLEX) for (const { a, b, c, max } of this.flex) {
      const pa = this.p[a], pb = this.p[b], pc = this.p[c];
      _a.copy(pb).sub(pa); const la = _a.length();
      _b.copy(pc).sub(pb); const lb = _b.length();
      if (la < 1e-5 || lb < 1e-5) continue;
      _a.divideScalar(la); _b.divideScalar(lb);
      const ang = Math.acos(THREE.MathUtils.clamp(_a.dot(_b), -1, 1));
      if (ang <= max) continue;
      _n.crossVectors(_a, _b);
      if (_n.lengthSq() < 1e-10) continue;      // parallel: already at 0, can't exceed
      _n.normalize();
      // SOFT correction — a multiplicative yield per pass: big violations
      // correct fast (TUNING.YIELD^ITER per step), contested joints lean on the limit.
      _qd.setFromAxisAngle(_n, (max - ang) * TUNING.YIELD);
      this._swing(b, c, _b.applyQuaternion(_qd), lb);
    }

    // ---- CONE: limb direction vs the torso
    const { r, u, f } = this.frame;
    if (TUNING.ON_CONE) for (const { b, c, axis, cos } of this.cone) {
      const pb = this.p[b], pc = this.p[c];
      _b.copy(pc).sub(pb); const lb = _b.length();
      if (lb < 1e-5) continue;
      _b.divideScalar(lb);
      // the stored axis is in body-frame coordinates; rebuild it in the world
      _n.copy(r).multiplyScalar(axis.x)
        .addScaledVector(u, axis.y)
        .addScaledVector(f, axis.z).normalize();
      const d = _b.dot(_n);
      if (d >= cos) continue;
      const ang = Math.acos(THREE.MathUtils.clamp(d, -1, 1));
      const lim = Math.acos(cos);
      _v.crossVectors(_n, _b);
      if (_v.lengthSq() < 1e-10) continue;      // exactly antipodal: no unique plane
      _v.normalize();
      _qd.setFromAxisAngle(_v, -(ang - lim) * TUNING.YIELD);
      this._swing(b, c, _b.applyQuaternion(_qd), lb);
    }

    // ---- BEHIND: a one-sided frontal-plane stop on the limb's direction
    if (TUNING.ON_BEHIND) for (const { b, c, minFwd } of this.behind) {
      const pb = this.p[b], pc = this.p[c];
      _b.copy(pc).sub(pb); const lb = _b.length();
      if (lb < 1e-5) continue;
      _b.divideScalar(lb);
      const fwd = _b.dot(this.frame.f);
      if (fwd >= minFwd) continue;
      // rotating about (limb x forward) swings the limb toward forward, which
      // is the only direction that reduces the violation
      _v.crossVectors(_b, this.frame.f);
      if (_v.lengthSq() < 1e-10) continue;      // limb already along forward
      _v.normalize();
      const need = Math.asin(THREE.MathUtils.clamp(minFwd, -1, 1))
        - Math.asin(THREE.MathUtils.clamp(fwd, -1, 1));
      _qd.setFromAxisAngle(_v, need * TUNING.YIELD);
      this._swing(b, c, _b.applyQuaternion(_qd), lb);
    }

    // ---- HINGE: signed one-sided fold, plus a sideways tolerance
    if (TUNING.ON_HINGE) for (const H of this.hinge) {
      const pa = this.p[H.a], pb = this.p[H.b], pc = this.p[H.c];
      _a.copy(pb).sub(pa); const la = _a.length();
      _b.copy(pc).sub(pb); const lb = _b.length();
      if (la < 1e-5 || lb < 1e-5) continue;
      _a.divideScalar(la); _b.divideScalar(lb);
      // transport the hinge axis, never rebuild it from the body frame: the rebuilt axis flips sign when the limb
      // lines up with forward (verlet-ragdoll.md §3)
      const n = _n.copy(H.n);
      n.addScaledVector(_a, -n.dot(_a));
      if (n.lengthSq() < 1e-8) {
        n.crossVectors(_a, this.frame.f);
        if (n.lengthSq() < 1e-8) continue;
      }
      H.n.copy(n.normalize());
      _c.crossVectors(n, _a);                   // the allowed fold direction

      let changed = false;
      // sideways: how far out of the hinge plane the lower link has strayed
      const oop = _b.dot(n);
      const lim2 = THREE.MathUtils.clamp(oop, -H.side, H.side);
      if (oop !== lim2) { _b.addScaledVector(n, (lim2 - oop) * TUNING.YIELD); changed = true; }
      // hyperextension: the lower link must never cross to the wrong side of
      // straight. The deadband matters: exactly straight, the sign is noise.
      const flexC = _b.dot(_c);
      if (flexC < -0.03) { _b.addScaledVector(_c, -flexC * TUNING.YIELD); changed = true; }
      if (changed) _b.normalize();
      // and the fold has an end
      const ang = Math.acos(THREE.MathUtils.clamp(_b.dot(_a), -1, 1));
      if (ang > H.max) {
        _v.crossVectors(_a, _b);
        if (_v.lengthSq() > 1e-10) {
          _qd.setFromAxisAngle(_v.normalize(), (H.max - ang) * TUNING.YIELD);
          _b.applyQuaternion(_qd);
          changed = true;
        }
      }
      if (changed) this._swing(H.b, H.c, _b, lb);
    }
  }

  /** Apply a velocity height-weighted about the lowest joint: a topple about the feet on a standing body, a roll
   *  away from the push on a lying one. */
  _topple(lean) {
    let lo = Infinity, hi = -Infinity;
    for (const j of JOINTS) {
      const p = this.p[j]; if (!p) continue;
      if (p.y < lo) lo = p.y;
      if (p.y > hi) hi = p.y;
    }
    const span = (hi - lo) || 1;
    for (const j of JOINTS) {
      if (this.prev[j]) this.prev[j].addScaledVector(lean, -(this.p[j].y - lo) / span * FIXED_DT);
    }
  }

  /** Pin a joint to a world-space target (a hand, or bodydrag's nails); several at once is fine. A pinned joint has
   *  infinite mass and snaps to the target each substep. setPin(joint, null) releases one; setPin(null) all. */
  setPin(joint, target, _firm = false) {
    // `_firm` (nail vs hand, ammodoll.setPin) is accepted for interface parity and unused: a Verlet pin is already rigid
    this.pins ??= new Map();
    const unpin = (j) => { this.iw[j] = 1 / (MASS[j] ?? 1); this.pins.delete(j); };
    if (!joint) { for (const j of [...this.pins.keys()]) unpin(j); return; }
    if (!this.p[joint]) return;
    if (!target) { unpin(joint); return; }
    const t = this.pins.get(joint) ?? new THREE.Vector3();
    t.copy(target);
    if (!Number.isFinite(t.x + t.y + t.z)) { unpin(joint); return; }
    this.pins.set(joint, t);
    this.iw[joint] = 0;
  }

  // pinned + impulse live on BodyEngineBase; _topple above is this engine's half

  /** Every joint's world position and velocity: a handover carries this rather than a pose, so the receiver continues
   *  instead of restarting (verlet-ragdoll.md §5). Format: rigmeasure.js snapshotPacker, shared with ammodoll. */
  snapshot() {
    const pack = snapshotPacker();
    for (const name of JOINTS) {
      const q = this.p[name];
      if (!q) continue;
      _v.copy(q).sub(this.prev[name]).divideScalar(FIXED_DT);
      pack.add(name, q, _v);
    }
    const s = pack.pack();
    // the transported hinge axes (see the constructor's handover note); optional, another engine ignores it
    s.h = this.hinge.flatMap((H) => [H.n.x, H.n.y, H.n.z]);   // exact, like p/v
    return s;
  }

  /** Advance the sim and push the result into the avatar as a held pose.
   *  Returns the sparse pose (for streaming) while active, or null once it has
   *  been captured and handed off. */
  step(dt) {
    if (this.done) return null;
    dt = Math.min(0.25, Math.max(0, dt || 0));

    // ---- fixed timestep: the sim only advances in FIXED_DT slices, so the
    // outcome doesn't depend on display rate; a long hitch drops its backlog.
    if (TUNING.PAUSED) dt = 0;
    this.acc += dt;
    let n = 0;
    while (this.acc >= FIXED_DT && n < MAX_FRAMES) { this._solve(); this.acc -= FIXED_DT; n++; }
    if (n === MAX_FRAMES) this.acc = 0;
    // where each pin was this frame, for next frame's pin velocity (per frame, the rate the cursor moves it at)
    if (this.pins?.size) {
      for (const [j, t] of this.pins) {
        const f = this._pinFrom.get(j);
        if (f) f.copy(t); else this._pinFrom.set(j, t.clone());
      }
    }

    this.steps++;
    this.frames += n;
    // the clock law is the base's; the thresholds and hysteresis band are this engine's numbers (seconds, not frames)
    this._settleTick(dt, this.maxV < TUNING.SETTLE_V,
      this.maxV > TUNING.SETTLE_V * TUNING.SETTLE_RESET);

    if (n === 0 && this.pose) return this.pose;   // nothing moved; nothing to resend

    this._followRoot();   // the body lies where it fell — see bodyengine.js

    // ---- map particles back to bone rotations (parent-relative + twist state)
    _mat.makeBasis(this.frame.r, this.frame.u, this.frame.f);
    _qBody.setFromRotationMatrix(_mat);
    const dtF = Math.max(1e-4, n * FIXED_DT);

    const pose = {};
    for (const d of this.drive) {
      const bn = this.nodes[d.bone];
      // the bone's direction runs from where the sim says the joint IS — its
      // particle — to its child's, never from the skeleton's bone position
      // (verlet-ragdoll.md §6).
      const bwp = this.p[d.bone] ?? bn.getWorldPosition(_a);
      _b.copy(this.p[d.child]).sub(bwp);
      if (_b.lengthSq() < 1e-6) continue;
      _b.normalize();

      // the frame this bone hangs off, already resolved (parents come first)
      const par = d.twistParent ? this.driveBy.get(d.twistParent) : null;
      _qp.copy(par ? par.frameW : _qBody);

      // live direction, in that parent frame
      _t2.copy(_b).applyQuaternion(_qpi.copy(_qp).invert());
      if (_t2.dot(d.restLocalAxis) < -0.999) continue;   // 180° from rest: the
      // joint limits are supposed to make this unreachable; if it ever happens,
      // hold the previous frame rather than invent a roll
      _qs.setFromUnitVectors(d.restLocalAxis, _t2);
      _qs.multiply(d.restLocal);                         // swing-free, in parent
      _qL.copy(_qp).multiply(_qs);                       // ...and in the world

      // ---- twist: a limp bone LAGS its parent's roll, then springs back
      const rollRate = twistAbout(_qt.copy(_qL).multiply(_qsi.copy(d.swingW).invert()), _b);
      d.swingW.copy(_qL);
      d.twv -= rollRate * TUNING.TWIST_LAG / dtF;
      d.twv *= TUNING.TWIST_DAMP;
      d.twv -= d.tw * TUNING.TWIST_STIFF * dtF;
      d.tw += d.twv * dtF;
      if (!TUNING.ON_TWIST) { d.tw = 0; d.twv = 0; }
      if (d.tw > d.twMax) { d.tw = d.twMax; d.twv = 0; }
      else if (d.tw < -d.twMax) { d.tw = -d.twMax; d.twv = 0; }

      _qs.multiply(_qt.setFromAxisAngle(_X, d.tw));      // roll in the bone frame
      d.frameW.copy(_qp).multiply(_qs);

      _qd.copy(d.frameW).multiply(d.restFrameInv).multiply(d.restQuat);
      // world -> local (parent may itself have moved this frame)
      d.parent.getWorldQuaternion(_qpi).invert();
      _qpi.multiply(_qd);
      bn.quaternion.copy(_qpi);
      pose[d.bone] = [+_qpi.x.toFixed(4), +_qpi.y.toFixed(4), +_qpi.z.toFixed(4), +_qpi.w.toFixed(4)];
    }
    this.pose = pose;
    // apply locally too, held, so the owner sees its own flop this frame
    this.avatar.setPose(pose);

    // ---- settle detection: hand off to a captured held pose and stop
    if (this.settledFor >= TUNING.SETTLE_TIME || this.elapsed >= TUNING.DEADLINE) {
      this.done = true;
      this.finalPose = pose;
    }
    return pose;
  }
}
