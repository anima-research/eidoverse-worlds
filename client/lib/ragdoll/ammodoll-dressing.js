// ammodoll-dressing — the Bullet hair and wing chains on a doll: thin boxes on a kinematic anchor, one-way, local
// dressing. The doll calls buildHair and buildWings at the same two points of its constructor, with its kit;
// nothing here imports ammodoll.js.
import { THREE } from '../core.js';
import { AMMO, _bv1, _bv2, _bt1 } from './ammo-load.js';
import { DEG, HAIR_TUNING, WING_TUNING, G_STATIC, G_FINGER, CF_KINEMATIC, DISABLE_DEACTIVATION } from './ammodoll-tuning.js';

/** Per-bone mesh extents in each bone's own bind frame, read off the skin once per avatar (and per `key`: hair and
 *  wings match different bones). A bone's length is a fine proxy for a limb but not for a wing membrane or a leaf
 *  bone. Vertices go to the bone that weights them decisively. Returns Map(boneName -> {c, he}); empty when there
 *  is no skinned mesh (headless rigs), and the caller keeps its bone-length path. */
function boneMeshExtents(avatar, key, match) {
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
      // below 0.4 the vertex straddles a joint and would stretch both boxes
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
    if (a.n < 24) continue;   // a handful of stray vertices is not a shape
    out.set(name, {
      c: a.lo.clone().add(a.hi).multiplyScalar(0.5),
      he: a.hi.clone().sub(a.lo).multiplyScalar(0.5),
    });
  }
  cache.set(key, out);
  return out;
}

/** A bone's mesh extent carried to world by its live matrix: the box centre and one child box oriented with the
 *  bone; null when nothing was measured. `floor` is the minimum half-extent (a zero-depth box has no inertia about
 *  two of its axes). */
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

/** The constructor's hair stage: `doll` is the AmmoRagdoll being built, `kit` the constructor's own builders. */
export function buildHair(doll, avatar, { H, keep, localOf, mkBody, boxFor }) {
  // ---- Bullet hair, when the rig carries Hair_<chain>_<idx> bones: each becomes a thin box chained by 6DOF
  // springs to a kinematic anchor, limits ramping down the lock, equilibrium the combed pose, fractional gravity,
  // CCD against tunnelling. Collides with the world and the skull box only. Local dressing: excluded from settle,
  // snapshot and the pose wire.
  doll._hairSegs = [];
  {
    const headSeg = doll.segs.get('neck|head');
    const hairNodes = [];
    avatar.root?.traverse?.((o) => { if (/^Hair_\d+_\d+$/.test(o.name ?? '')) hairNodes.push(o); });
    const chains = new Map();
    for (const nd of hairNodes) {
      const m = nd.name.match(/^Hair_(\d+)_(\d+)$/);
      if (!chains.has(m[1])) chains.set(m[1], []);
      chains.get(m[1]).push({ i: Number(m[2]), node: nd });
    }
    if (headSeg && chains.size) {
      // the combed pose, captured once per avatar (every drag release rebuilds the doll, and a rig rebuilt from a
      // simulated pose would ratchet a crumple in)
      if (!avatar.__hairRest) {
        const rest = new Map();
        for (const [, list0] of chains) {
          for (const it of list0) rest.set(it.node, it.node.quaternion.clone());
        }
        avatar.__hairRest = rest;
      }
      // start combed; updateMatrix because a springbone joint has matrixAutoUpdate false
      for (const [nd0, q0] of avatar.__hairRest) {
        nd0.quaternion.copy(q0); nd0.updateMatrix();
      }
      avatar.root.updateMatrixWorld(true);
      const headGroup = doll._groupOf.get(headSeg.body) ?? G_STATIC;
      const R = Math.max(0.004 * H, 0.004);
      const hairExt = boneMeshExtents(avatar, 'hair', (n) => /^Hair_\d+_\d+$/.test(n));
      const HT = HAIR_TUNING;      // live: retuneHair()
      const HAIR_LIM = HT.limit * DEG, HAIR_ROOT = HT.rootExp;
      const HAIR_GRAV = HT.gravity, HAIR_MASS = HT.mass;
      const HAIR_TENS = HT.tension, HAIR_DAMP = HT.damping;
      let built = 0;
      doll._hairAnchors = [];
      for (const [, list] of chains) {
        list.sort((x2, y2) => x2.i - y2.i);
        // a kinematic anchor per lock, re-driven from the head before each step: one-way, so lock torques never
        // feed back into the head
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
        doll.world.addRigidBody(anchor, G_FINGER, 0);   // mask 0: touches nothing
        doll._bodies.push(anchor);
        doll._hairAnchors.push({   // where the anchor sits in the head's frame, so it can be carried
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
          // the lock's own mesh extents when the mesh offers them, the bone spacing otherwise
          const hx = extBox(nd, hairExt.get(nd.name), 0.004);
          const body = hx
            ? mkBody(HAIR_MASS, hx.center, new THREE.Quaternion(), hx.boxes, true)
            : mkBody(HAIR_MASS, mid, new THREE.Quaternion(),
              [boxFor(mid, aW, bW, R, R, len)], true);
          body.setDamping(0.25, HAIR_DAMP);   // hair that cannot carry a swing reads as rigid
          body.setFriction(0.3);              // the limb defaults give stick-slip chatter on the scalp
          body.setRestitution(0.0);
          body.setRollingFriction(0.0);
          body.setCcdMotionThreshold(len * 0.5);
          body.setCcdSweptSphereRadius(R * 0.9);
          // the root segment is born inside the head box, and a contact born penetrating becomes kinetic energy
          doll.world.addRigidBody(body, G_FINGER,
            j2 === 0 ? G_STATIC : (G_STATIC | headGroup));
          _bv1.setValue(0, -9.81 * HAIR_GRAV, 0);
          body.setGravity(_bv1);       // after addRigidBody, or the world's gravity overwrites it
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
            con.setStiffness(ax, HAIR_TENS);
            con.setDamping(ax, HAIR_DAMP);
          }
          con.setEquilibriumPoint();
          doll.world.addConstraint(con, true);
          doll._constraints.push(con);
          doll._hairSegs.push({
            body, node: nd, parent: nd.parent,
            restWorldQ: nd.getWorldQuaternion(new THREE.Quaternion()),
            con, j: j2, n: list.length,   // retuneHair() re-derives the ramp
          });
          parentBody = body;
          built++;
        }
      }
      if (built) {
        avatar.__simHair = true;   // claim the hair from three-vrm's springbones while this doll lives (avatar.js)
        console.log(`[ammodoll] bullet hair: ${chains.size} locks, ${built} segments`);
      }
    }
  }
}

/** The constructor's wing stage, right after the hair's (same kit). */
export function buildWings(doll, avatar, { H, keep, localOf, mkBody, boxFor }) {
  // ---- Bullet wings: the hair's shape (box chains on a kinematic anchor, one-way, local dressing), not its code,
  // since every parameter differs. While the body is alive avatar.js drives the wings (WING_IDLE); once it goes
  // limp these chains take the same bones over.
  doll._wingSegs = [];
  doll._wingAnchors = [];
  {
    const chestSeg = doll.segs.get('chest|neck') ?? doll.segs.get('spine|chest');
    const wingNodes = [];
    avatar.root?.traverse?.((o) => {
      if (/^[LR]_Wing_(Upper|Lower)(_\d+)?$/.test(o.name ?? '')) wingNodes.push(o);
    });
    const wchains = new Map();
    for (const nd of wingNodes) {
      // The index in the name IS the position in the chain (counting underscores would tie _1 and _2).
      const m = nd.name.match(/^([LR]_Wing_(?:Upper|Lower))(?:_(\d+))?$/);
      if (!wchains.has(m[1])) wchains.set(m[1], []);
      wchains.get(m[1]).push({ i: m[2] ? Number(m[2]) : 0, node: nd });
    }
    if (chestSeg && wchains.size) {
      // the authored pose, captured by avatar.js _findWings before the flap ever ran
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
        doll.world.addRigidBody(anchor, G_FINGER, 0);   // mask 0: touches nothing
        doll._bodies.push(anchor);
        doll._wingAnchors.push({
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
          // the mesh's own extents when the rig has them (boneMeshExtents); a bone-length plate otherwise
          const ext = wingExt.get(nd.name);
          let center = mid, boxes;
          if (ext) {
            nd.updateWorldMatrix(true, false);
            center = ext.c.clone().applyMatrix4(nd.matrixWorld);
            boxes = [{
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
          // statics only: the root is born inside the torso box, and a folded wing wraps that side's arm and leg
          doll.world.addRigidBody(body, G_FINGER, G_STATIC);
          _bv1.setValue(0, -9.81 * WT.gravity, 0);
          body.setGravity(_bv1);       // after addRigidBody
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
          con.setEquilibriumPoint();   // the authored pose, by the reset above
          doll.world.addConstraint(con, true);
          doll._constraints.push(con);
          doll._wingSegs.push({
            body, node: nd, parent: nd.parent,
            restWorldQ: nd.getWorldQuaternion(new THREE.Quaternion()),
            con, j: j2, n: list.length,
          });
          parentBody = body;
          built++;
        }
      }
      if (built) {
        avatar.__simHair = true;   // wings are springbone chains too (tools/assets/import-tripo-avatar.ts)
        console.log(`[ammodoll] bullet wings: ${wchains.size} chains, ${built} segments`);
      }
    }
  }
}

/** Push WING_TUNING into the running wings, no rebuild — same contract as retuneHair. */
export function retuneWings(doll) {
  if (!AMMO || !doll._wingSegs?.length) return 0;
  const WT = WING_TUNING;
  for (const ws of doll._wingSegs) {
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
  return doll._wingSegs.length;
}

/** Push HAIR_TUNING into the running hair, no rebuild. Mass gets its inertia recomputed from the shape. */
export function retuneHair(doll) {
  if (!AMMO || !doll._hairSegs?.length) return 0;
  const HT = HAIR_TUNING;
  for (const hs of doll._hairSegs) {
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
  return doll._hairSegs.length;
}
