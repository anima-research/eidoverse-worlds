// ammodoll — the Bullet (ammo.js) body engine, ported from socketteer/ragdoll-physics. Same interface as the verlet
// Ragdoll: the engine contract is BodyEngineBase (bodyengine.js); measurement and the snapshot format are
// rigmeasure.js's.
//
// The source's joint tables, finger springs, tendons and grab tuning were derived in Blender, whose rigid-body
// engine is Bullet, so the numbers transfer unchanged. The rig does not: it is measured from the live VRM skeleton
// at construction (box sizes from bone lengths or mesh extents, masses from Dempster fractions), and every joint
// frame is built on an anatomical basis (Y along the bone = twist, X the flexion axis from the rig's own
// forward/up; never VRM node axes, which sit near-identity at rest).
//
// Structure: a three-body trunk (pelvis, spine, chest); rest-aligned bodies (identity at rest, so limits mean
// "from rest", with joint origins mapped through the live transforms); every joint widened to contain the pose it
// was born in, or the solver annihilates the difference on frame one. Fingers are spring bodies (proximal and
// intermediate only) with weak tendon springs between neighbours; the grab is a point constraint with a hard
// impulse clamp. This ammo build binds no rotational motors, so limpness is damping and limit ERP.
//
// Every Ammo object this instance creates is tracked and destroyed in dispose(); per-frame math reuses module-level
// temporaries. Tuning measurements: docs/research/ammodoll-tuning.md.

import { THREE } from '../core.js';
import { heightAt, waterField } from '../terrain.js';
import { surfaceOffset } from '../../../shared/waves.js';
import { partWaterForce, waterCurrent, swellRise, WATER_ANG_DRAG } from '../../../shared/buoyancy.js';
import { nearColliders, surfaceUnder } from '../colliders.js';
import { segDistance, rigFrameOf, snapshotPacker, seedJoints } from './rigmeasure.js';
import { BodyEngineBase } from './bodyengine.js';
import { AMMO, _bv1, _bv2, _bt1, _bt2, _bq1 } from './ammo-load.js';
import { buildHair, buildWings, retuneWings, retuneHair } from './ammodoll-dressing.js';
import { INTERIOR_REACH, INTERIOR_MAX_TRIS, INTERIOR_NEAR, reportInteriorFallback, interiorTriangles } from './ammodoll-interior.js';
import { DEG, MASS_FRAC, TRUNK_DEPTH, REAL_H, BODY_KG, FINGER_MASS_FRAC, FINGER_STIFFNESS, FINGER_DAMPING,
  FINGER_TENDON, ERP_LIMIT, BT_CONSTRAINT_STOP_ERP, ACTIVE_TAG, LIN_DAMP,
  ANG_DAMP, ANG_DAMP_FINGER, LIN_DAMP_FINGER, FRICTION, RESTITUTION, FIXED_DT, MAX_SUBSTEPS, SETTLE_V, SETTLE_W,
  SETTLE_TIME, DEADLINE, ANG_CEIL, BUILD_WIDEN, PIN_TAU, PIN_CLAMP_X, GRAB_TAU, GRAB_CLAMP_X, HAIR_TUNING,
  WING_TUNING, JOINT_SPECS, TORSO_KEYS, CORE_SEGMENTS, EXTRA_SEGMENTS, CORE_JOINTS, FINGERS, G_STATIC, G_FINGER,
  BODY_BITS, FILTER_MAX } from './ammodoll-tuning.js';

/** The real inertia of a set of child boxes about the body origin: exact box tensors, rotated, parallel-axis
 *  shifted, summed, mass split by volume. (btCompoundShape::calculateLocalInertia approximates from the AABB and
 *  overstates twist inertia on rotated limb boxes, so the twist stops don't hold.) Bullet keeps only the diagonal.
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

const _v = new THREE.Vector3();
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _qp = new THREE.Quaternion();
const _m4 = new THREE.Matrix4();

/** Body world rotation → THREE. Ammo's value-returning methods (getRotation among them) share one static temporary
 *  per method, so two held results alias: consume each immediately. */
function quatOf2(body, out) {
  const r = body.getCenterOfMassTransform().getRotation();
  return out.set(r.x(), r.y(), r.z(), r.w());
}

/** Deterministic frame with Y along `dir`: setFromUnitVectors is singular for antiparallel
 *  inputs and answers them arbitrarily, differently per call. */
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

const _wv = [0, 0, 0], _wf = [0, 0, 0], _wc = [0, 0, 0];   // water scratch (_water)

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

    // ---- live capture + neutral rest -------------------------------------
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
    // neck is optional in VRM, and the head's body and joint hang off it
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
    // rest covers only what the caller sampled (usually the core joints); hands, feet and fingers fill from the
    // avatar's neutral pose, or from the live skeleton
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
    this.rig = rigFrameOf(restP);   // rigmeasure.js
    const rigUp = this.rig.up, rigLat = this.rig.lateral, rigFwd = this.rig.forward;
    // VRM binds a T-pose with the palms down and rest here is the bind pose, so the palm normal is the rig's down
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
    // trunk half-width: the wider of the shoulder span and the source's proxy proportion (an undersized trunk is floppy)
    const torsoR = Math.max(0.05, span * 0.22, H * 0.055);

    // ---- extrapolate missing tips so hands/feet can be bodies: a VRM without finger or toe bones still has a hand
    // and a foot, ~35% of the parent bone, pointing the way the parent was going
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
    const addStatic = (halfX, halfY, halfZ, pos, quat, friction) =>
      addStaticShape(keep(new AMMO.btBoxShape(new AMMO.btVector3(halfX, halfY, halfZ))), pos, quat, friction);
    const addStaticShape = (shape, pos, quat, friction) => {
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
    // Terrain-following ground: box tiles at the field's own heights on a grid around the fall (a flat world keeps
    // the one-cuboid fast path), plus a wide apron at the lowest sampled height for a long tumble. TILE bounds the
    // stair-step error: 0.75m keeps a 40% grade within 15cm.
    {
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
    // the boxes near the fall (nearColliders), placed as colliders.js places them
    for (const [, c] of nearColliders(hips.x, hips.z, 8)) {
      const obj = c.obj;
      if (!obj || c.interior || !c.box) continue;
      if (Math.hypot(obj.position.x - hips.x, obj.position.z - hips.z) > 8) continue;
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
    // Interiors: their real triangles (a box would seal the room solid), one static mesh per thing, bounded by
    // INTERIOR_MAX_TRIS across them all. Too many within reach: only those within INTERIOR_NEAR; still too many: a
    // floor slab under the body (no walls, but never no floor).
    let budget = INTERIOR_MAX_TRIS;
    this.interiorFallback = null;
    for (const [id, c] of nearColliders(hips.x, hips.z, 8)) {
      if (!c.obj || !c.interior || !c.exact?.bvh) continue;
      let got = interiorTriangles(c, hips, INTERIOR_REACH, budget);
      if (got.over) got = interiorTriangles(c, hips, INTERIOR_NEAR, budget);
      if (got.over) {
        const floor = surfaceUnder(hips.x, hips.z, heightAt, hips.y + 0.3).y;
        addStatic(INTERIOR_NEAR, 0.25, INTERIOR_NEAR, { x: hips.x, y: floor - 0.25, z: hips.z }, null, 0.8);
        this.interiorFallback = `${id}: over ${INTERIOR_MAX_TRIS} triangles within ${INTERIOR_NEAR}m — a floor slab at ${floor.toFixed(2)}m stands in`;
        reportInteriorFallback(id, this.interiorFallback);
        continue;
      }
      const tri = got.tris;
      if (!tri.length) continue;
      budget -= tri.length / 9;
      const mesh = keep(new AMMO.btTriangleMesh());
      const a = keep(new AMMO.btVector3(0, 0, 0)), b = keep(new AMMO.btVector3(0, 0, 0)), d = keep(new AMMO.btVector3(0, 0, 0));
      for (let k = 0; k < tri.length; k += 9) {
        a.setValue(tri[k], tri[k + 1], tri[k + 2]);
        b.setValue(tri[k + 3], tri[k + 4], tri[k + 5]);
        d.setValue(tri[k + 6], tri[k + 7], tri[k + 8]);
        mesh.addTriangle(a, b, d, false);
      }
      addStaticShape(keep(new AMMO.btBvhTriangleMeshShape(mesh, true, true)), { x: 0, y: 0, z: 0 }, null, 0.8);
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

    // ---- rest-aligned orientation down the chain ---------------------------
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

    // ---- bodies: each a compound of boxes. Box half-width is rigdef.py's skeleton-only fallback (0.16 × bone
    // length); the trunk's comes from the shoulder span (torsoR), not its bones.
    this.segs = new Map();          // segKey -> seg
    this._bodies = [];              // every dynamic body, build order
    this._cores = [];               // non-finger bodies (settle metrics)
    this._waterR = new Map();       // core body -> its extent either side of its centre (floating)
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
      rb.setRollingFriction(0.05);   // a light foot box landing on a corner would wobble forever; statics carry it too
      rb.setRestitution(RESTITUTION);
      // sleep once converged (per island, so the doll settles together); every pin, impulse or seed wakes it
      rb.setSleepingThresholds(0.02, 0.05);
      rb.setActivationState(ACTIVE_TAG);
      this._bodies.push(rb);
      this._massOf.set(rb, mass);
      if (!isFinger) {
        this._cores.push(rb);
        // the part's reach either side of its centre, for how much of it is under water (_water)
        let r = 0.04;
        for (const bx of boxes) r = Math.max(r, Math.hypot(bx.t.x, bx.t.y, bx.t.z) + Math.hypot(bx.he.x, bx.he.y, bx.he.z) * 0.6);
        this._waterR.set(rb, r);
      }
      this._vol.push({   // the debug overlay's volumes()
        body: rb,
        boxes: boxes.map((bx) => ({ he: bx.he.clone(), t: bx.t.clone(), q: bx.q.clone() })),
      });
      return rb;
    };

    // a box spanning ra→rb in rest coordinates, local to a body whose rest origin is `origin`. minLen: a limb's
    // 0.04 floor; hair passes its own (over-long bars make a lock a stick).
    const boxFor = (origin, ra, rb2, halfW, halfD = halfW, minLen = 0.04) => {
      const dir = rb2.clone().sub(ra);
      const len = Math.max(dir.length(), minLen);
      const mid = ra.clone().add(rb2).multiplyScalar(0.5).sub(origin);
      return { he: new THREE.Vector3(halfW, len / 2, halfD), t: mid, q: frameQuat(dir) };
    };
    const limbW = (ra, rb2) => Math.max(0.02, ra.distanceTo(rb2) * 0.16);

    // the trunk is three bodies (pelvis, spine, chest) jointed by the source's spine and chest limits, so the doll
    // folds at the waist and the arms load a chest, not a half-mass slab
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
    // Degenerate trunk (a rig with no spine/chest bones): one body, as before.
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
    // the trunk body other code asks for by name: what the arms and head hang off
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
      // VRM puts the head bone at the skull base, so the box runs on past it to a height-scaled crown (0.124 of
      // height, less the bone) and its perpendicular extents grow to skull scale, or a prone body sinks face-first.
      // Collision only: seg endpoints, .p and pins keep the true bone.
      const isHead = part === 'head';
      const boxEnd = isHead
        ? rb2.clone().addScaledVector(
          rb2.clone().sub(ra).normalize(),
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

    // ---- self-collision groups: a pair is excluded (symmetrically) when constraint-adjacent or deeply overlapping
    // at rest. This build does not bind setIgnoreCollisionCheck, so the filter is the only per-pair lever, and it
    // freezes at addRigidBody.
    {
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
          // deep at rest pumps contact energy every frame; grazing is fine
          if (segDistance(A2.restA, A2.restB, B2.restA, B2.restB) < (A2.r + B2.r) * 1.05) {
            exclude(A2.body, B2.body);
          }
        }
      }
      // a hand rides its forearm's bit, a foot its calf's: sixteen core bodies don't fit twelve bits (see G_FINGER)
      for (const seg of this.segs.values()) {
        if (!/^(left|right)(Hand|Foot)\|/.test(seg.key ?? '')) continue;
        const parent = [...this.segs.values()].find((s) => s !== seg && s.b === seg.a);
        if (parent && bodyIndex.has(parent.body)) bodyIndex.set(seg.body, bodyIndex.get(parent.body));
      }
      // a shared bit excludes if any of its bodies does, or the thigh's mask re-adds the calf's bit via the foot
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
        if (group > FILTER_MAX) {   // the failure is silent otherwise: the group truncates to zero in wasm
          console.error(`[ammodoll] filter group ${group} exceeds the short budget `
            + `— this body will collide with nothing`);
        }
        this.world.addRigidBody(body, group, mask);
      }
      // any core body past the bit budget joins ground-only (none today)
      for (const body of this._cores) {
        if (!bodyIndex.has(body)) this.world.addRigidBody(body, G_FINGER, G_STATIC);
      }
    }

    // ---- joint frames: Y = rest bone direction (twist), X = swing from the rig's own reference, Z = X×Y. Origin
    // through the live transforms (zero position error at build), basis from rest (limits mean "from rest").
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

      // born excursion per axis in the joint basis: a joint must contain the pose it was born in (one getRotation
      // per statement: see quatOf2)
      quatOf2(parentBody, _q);
      quatOf2(childBody, _qp);
      const rel = _q.invert().multiply(_qp);
      const relF = basis.clone().invert().multiply(rel).multiply(basis);
      const eul = new THREE.Euler().setFromQuaternion(relF, 'XYZ');
      const born = [eul.x, eul.y, eul.z];
      // A seeded body is a handover, and every drag release builds a new doll, so widening to its pose would
      // ratchet the limits outward: on a handover the widening stops at BUILD_WIDEN past the table.
      const cap = seedVel ? BUILD_WIDEN : Infinity;
      const anatLo = lo.slice(), anatHi = hi.slice();
      for (let i = 0; i < 3; i++) {
        // a locked axis (lo === hi) stays locked, but moves to the born angle (a lock the rig is born off would be
        // annihilated on frame one); on a handover no further than BUILD_WIDEN from the table's zero
        if (anatHi[i] - anatLo[i] === 0) {
          lo[i] = hi[i] = Math.max(anatLo[i] - cap, Math.min(anatHi[i] + cap, born[i]));
          continue;
        }
        lo[i] = Math.max(anatLo[i] - cap, Math.min(lo[i], born[i] - BUILD_WIDEN));
        hi[i] = Math.min(anatHi[i] + cap, Math.max(hi[i], born[i] + BUILD_WIDEN));
      }

      // Centre the range on the frame: Bullet wraps the measured Euler angle, so a one-sided range like the knee's
      // has a wrap point one impulse away, past which the limit holds the joint on the wrong side. Rotating the
      // parent frame by the midpoint makes every range symmetric and pushes the wrap point to 180°.
      let mid = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2];
      let midQ = new THREE.Quaternion().setFromEuler(new THREE.Euler(mid[0], mid[1], mid[2], 'XYZ'));
      // Euler angles are not additive across axes, so re-measure the born pose in the centred frame and widen
      // again until the range is a fixed point of its own centering (1–2 rounds)
      for (let round = 0; round < 4; round++) {
        const eulC = new THREE.Euler().setFromQuaternion(midQ.clone().invert().multiply(relF), 'XYZ');
        const bornC = [eulC.x + mid[0], eulC.y + mid[1], eulC.z + mid[2]];
        let moved = false;
        for (let i = 0; i < 3; i++) {
          if (anatHi[i] - anatLo[i] === 0) {
            const v = Math.max(anatLo[i] - cap, Math.min(anatHi[i] + cap, bornC[i]));
            if (v !== lo[i]) { lo[i] = hi[i] = v; moved = true; }
            continue;
          }
          const nlo = Math.max(anatLo[i] - cap, Math.min(lo[i], bornC[i] - BUILD_WIDEN));
          const nhi = Math.min(anatHi[i] + cap, Math.max(hi[i], bornC[i] + BUILD_WIDEN));
          if (nlo !== lo[i] || nhi !== hi[i]) { lo[i] = nlo; hi[i] = nhi; moved = true; }
        }
        if (!moved) break;
        mid = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2];
        midQ = new THREE.Quaternion().setFromEuler(new THREE.Euler(mid[0], mid[1], mid[2], 'XYZ'));
      }
      const basisA = basis.clone().multiply(midQ);

      // frames: basis from rest anatomy (the parent's carries the centering), origin from the live anchor
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
        con.setEquilibriumPoint();   // built in the relaxed pose, so the current state is the rest curl
        this._springs.push(con);
      }
      for (let ax = 3; ax < 6; ax++) con.setParam(BT_CONSTRAINT_STOP_ERP, ERP_LIMIT, ax);
      this.world.addConstraint(con, true);     // linked pair ignores each other
      this._constraints.push(con);
      this.jointMeta.push({
        name, spec, axisX: x.clone(), axisY: y.clone(), axisZ: z.clone(),
        lo: [...lo], hi: [...hi], born: [...born], mid: [...mid],
        parentBody, childBody, basisA, basisB: basis.clone(),
        con, positiveFlexes: S.flex != null ? xhi > 0 : null,
      });
      return con;
    };

    // Named trunk anchors: the legs hang off the PELVIS, the arms and head off the CHEST.
    const metaOf = (ref) => {
      if (ref === 'hips') return segMeta.get('hips|spine');
      if (ref === 'chest') return segMeta.get('chest|neck') ?? segMeta.get('hips|spine');
      return segMeta.get(ref);
    };
    for (const J of CORE_JOINTS) {
      const pm = metaOf(J.parent), cm = metaOf(J.child);
      if (!pm || !cm || pm.body === cm.body) {
        // a skipped joint is a detached body part: say so
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

    // ---- fingers: spring phalanges (proximal and intermediate only, as rigdef.py) + tendons. The thumb gets one
    // body, Proximal→Distal, its metacarpal fused into the palm.
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
      // rest-aligned down the chain: each phalanx composes from its own parent, never two independent shortest arcs
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
    // tendons: a weak orientation spring between neighbouring fingers at the same level, all axes free (lower >
    // upper = free), spring on X only
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

    // ---- Bullet hair and wings (ammodoll-dressing.js): local dressing, excluded from settle, snapshot and the pose wire
    const kit = { H, keep, localOf, mkBody, boxFor };
    buildHair(this, avatar, kit);
    buildWings(this, avatar, kit);

    // hair and wings are one kind of thing to the step loop (`?? []`: a hairless rig never assigns _hairAnchors)
    this._dressAnchors = [...(this._hairAnchors ?? []), ...this._wingAnchors];
    this._dressSegs = [...(this._hairSegs ?? []), ...this._wingSegs];

    // ---- the drive table: both references from the live skeleton (refDir must be the direction the bone points
    // in the pose refQuat describes, or every driven bone renders at twice its offset)
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
        // the body and the orientation it was born holding make roll recoverable (see step)
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
    // how far the render root sits below the hips: measured against the sim's hips for a body at rest, but a seeded
    // or already-fallen body is not at rest, so the measurement is kept only when it agrees with the rig constant
    const restHipsY = this.restP?.hips?.y;
    const measured = (this.p.hips?.y ?? live.hips?.y ?? 0) - avatar.root.position.y;
    const constant = restHipsY != null ? restHipsY - avatar.root.position.y : measured;
    this.hipsOffset = Math.abs(measured - constant) > 0.05 ? constant : measured;
    this._measureHipsLocal(this.restP?.hips ?? null);   // sideways too (bodyengine.js)
  }

  // ---------------------------------------------------------------- instruments (test/client/ammodoll-test.ts)

  /** The collision volumes as the solver holds them, in world space: `[{ p, q, he }]`, one entry per box. The debug
   *  overlay's counterpart to the verlet's `caps`/`radius`. */
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

  /** Re-apply JOINT_SPECS to the live constraints, no rebuild (a tuning dial: write tuned values into the table).
   *  The frames keep the midpoint they were built with, so a range retuned far more asymmetric sits nearer Bullet's
   *  wrap point than a fresh build would. */
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

  /** Push WING_TUNING into the running wings, no rebuild (ammodoll-dressing.js). */
  retuneWings() { return retuneWings(this); }
  /** Push HAIR_TUNING into the running hair, no rebuild (ammodoll-dressing.js). */
  retuneHair() { return retuneHair(this); }

  /** Live per-axis joint angles against their bounds, in anatomical coordinates (the centering midpoint added back). */
  jointAngles() {
    const out = [];
    for (const J of this.jointMeta) {
      quatOf2(J.parentBody, _q);
      quatOf2(J.childBody, _qp);
      const rel = _q.invert().multiply(_qp);
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

  /** The flexion axes as built (rest/world coordinates) with their signed ranges. */
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

  // impulse() lives on BodyEngineBase

  /** `firm` distinguishes a nail from a hand (the source's two settings): a drag calls setPin on every mousemove,
   *  and a nail hauls a limb through its joint stops. */
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
      if (this._pinCons.size === 0) this.rootStartY = this._rootBaseY;   // the lift ceiling is a lease, not a ratchet
      return;
    }
    let pin = this._pinCons.get(joint);
    if (!pin) {
      // a point constraint with a hard impulse clamp: a distant target pulls at bounded force, never teleports
      const anchor = (seg.a === joint ? seg.localA : seg.localB);   // rest-local = body-local (rest-aligned bodies)
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

  /** Drag-release handover in the house packed format (rigmeasure.js snapshotPacker; the far side may be the
   *  verlet): joint names, positions and endpoint velocities (v + ω × r). */
  snapshot() {
    if (this._freed) return null;   // an empty pack would still be truthy on `seedVel?.j`
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

  /** Apply the water's force to every core part in it (see step). True when any part is wet. */
  _water() {
    // a body's own water when it was given one (a headless process can host agents in several worlds); else the page's
    const wf = this.waterSource ? this.waterSource() : waterField();
    if (!wf) return false;
    const t = wf.time();
    let wet = false;
    for (const body of this._cores) {
      const o = body.getCenterOfMassTransform().getOrigin();
      const x = o.x(), y = o.y(), z = o.z(), r = this._waterR.get(body) ?? 0.1;
      const w = wf.sample(x, z);
      const surface = wf.level + surfaceOffset(w, x, z, t);
      if (y - r >= surface) continue;
      const lv = body.getLinearVelocity();
      _wv[0] = lv.x(); _wv[1] = lv.y(); _wv[2] = lv.z();
      const m = this._massOf.get(body) ?? 1;
      const cur = waterCurrent(w);
      _wc[0] = cur[0]; _wc[1] = cur[1];
      _wc[2] = swellRise((tt) => surfaceOffset(w, x, z, tt), t, surface - y);   // the swell carries what floats in it
      const sub = partWaterForce(m, y, r, _wv, surface, _wc, _wf);
      if (sub <= 0) continue;
      wet = true;
      body.activate();   // a sleeping island ignores forces — and water never lets a body lie still
      _bv1.setValue(_wf[0], _wf[1], _wf[2]); body.applyCentralForce(_bv1);
      const av = body.getAngularVelocity(), k = -WATER_ANG_DRAG * sub * 0.4 * m * r * r;
      _bv1.setValue(av.x() * k, av.y() * k, av.z() * k); body.applyTorque(_bv1);
    }
    return wet;
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
    dt = Math.min(0.05, Math.max(0, dt || 0));   // 8 substeps at 1/120 cover 0.067s; the rest would be one residual step
    // kinematic anchors move before the step: Bullet derives their velocity as (new - old)/dt
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
    // water (shared/buoyancy.js, part by part): every submerged core part is buoyed and dragged toward the water's
    // own motion. Bullet holds an applied force through every substep of the one stepSimulation.
    this.floating = dt > 0 && this._water();
    if (dt > 0) this.world.stepSimulation(dt, MAX_SUBSTEPS, FIXED_DT);

    // angular ceiling: nothing anatomical rotates at 20 rad/s
    for (const body of this._cores) {
      const w = body.getAngularVelocity();
      const m = Math.hypot(w.x(), w.y(), w.z());
      if (m > ANG_CEIL) {
        const k = ANG_CEIL / m;
        _bv1.setValue(w.x() * k, w.y() * k, w.z() * k);
        body.setAngularVelocity(_bv1);
      }
    }

    // settle is linear and angular, over the core bodies (fingers twitch at amplitudes the wire never sees)
    let maxSpeed = 0, maxSpin = 0;
    for (const body of this._cores) {
      const v = body.getLinearVelocity(), w = body.getAngularVelocity();
      maxSpeed = Math.max(maxSpeed, Math.hypot(v.x(), v.y(), v.z()));
      maxSpin = Math.max(maxSpin, Math.hypot(w.x(), w.y(), w.z()));
    }
    this.maxV = maxSpeed;
    this.maxW = maxSpin;

    // the clock law is the base's. A floating body never settles: freezing it mid-bob would leave it hanging over a
    // trough.
    this._settleTick(dt, !this.floating && this.maxV < SETTLE_V && this.maxW < SETTLE_W);
    if (this.floating) this.elapsed = 0;

    this._syncP();

    this._followRoot();   // the body lies where it fell — see bodyengine.js

    // bones, parents first (drive is in construction order). The node's position is never written: solver error
    // must stretch a joint, not the mesh.
    const pose = {};
    for (const d of this.drive) {
      const bp = this.p[d.bone], cp = this.p[d.child];
      if (!bp || !cp) continue;
      // the body's rotation, not a swing from the bone's direction (which would discard roll: a knee facing
      // anywhere, no forearm pronation); bodies are rest-aligned, so the body's rotation since build is the bone's
      quatOf2(d.body, _q).multiply(d.q0inv).multiply(d.restQuat);
      d.parent.getWorldQuaternion(_qp).invert();
      _qp.multiply(_q);
      d.node.quaternion.copy(_qp);
      pose[d.bone] = [+_qp.x.toFixed(4), +_qp.y.toFixed(4), +_qp.z.toFixed(4), +_qp.w.toFixed(4)];
    }
    this.pose = pose;
    this.avatar.setPose(pose);

    // hair and wings ride raw nodes: the body's rest→live rotation on the born orientation, into parent-local
    for (const hs of this._dressSegs ?? []) {
      quatOf2(hs.body, _q).multiply(hs.restWorldQ);
      hs.parent.getWorldQuaternion(_qp).invert();
      hs.node.quaternion.copy(_qp.multiply(_q));
      hs.node.updateMatrix();   // a springbone joint has matrixAutoUpdate false: this is the write
    }

    if (this.settledFor >= SETTLE_TIME || this.elapsed >= DEADLINE) {
      this.done = true;
      this.finalPose = pose;
      this.dispose();
      return null;
    }
    return pose;
  }

  /** Free every WASM object this instance created (Bullet objects do not garbage-collect). Safe to call twice;
   *  called automatically at capture. */
  dispose() {
    if (this._freed) return;
    this._freed = true;
    this.done = true;
    // hand the hair back adopting the pose it is in (dishevelled, deliberately): three-vrm resumes from the fallen
    // shape, and the authored shape returns when she gets up (avatar.js _combHair)
    this.avatar?._releaseHair?.({ adopt: true });
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
