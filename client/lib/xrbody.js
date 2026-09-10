// xrbody — the body follows the headset (Tier A1 + A2 of the 09-05 gap list;
// porch-old index.html:6186–6236 ported, Basis's design). Before this, VR moved
// only the camera and the body's yaw: the VRM's head never tilted and the body
// stood wherever the controller put it, so a tall person floated above a
// short avatar and remotes saw a mannequin. Now, every presenting frame, AFTER
// the controller placed the root and BEFORE the render:
//   1. distributed look-at — the HMD's pitch / roll / residual yaw, expressed
//      relative to the body's facing, is spread over spine→chest→upperChest→
//      neck→head with porch's weights, damped, yaw faded near vertical gaze —
//      no single joint snaps;
//   2. eye anchor — the whole VRM is translated (root-local) by (hmd − eye), so
//      the avatar's eyes coincide with the headset by construction; the body
//      HANGS BENEATH the head. Order matters: after the look chain (the head
//      pose moves the eyes), before any arm solve (shoulders under the head).
// DeviceScale (xr.js) scales the PUPPET to the player (Basis); tracking stays 1:1.
import { THREE, renderer } from './core.js';
import { CONFIG, tee } from './base.js';
import { myState } from './controller.js';
import { isPresenting, puppetScale, xrRig, xrHands, xrFingerCurl, syncRigToBody, applyTurnEarly } from './xr.js';

let getSelf = () => null;
let hooked = null;
export const bindXRBodySelf = (fn) => { getSelf = fn; };
// called each frame (system 'xrbody', early): make sure THIS frame's self avatar
// carries the hook — the avatar object changes on every body swap
export function ensureXRBodyHook() {
  const av = getSelf();
  if (!av || av === hooked) return;
  av.onBeforeVrmUpdate = (dt) => tickXRBody(dt);
  hooked = av;
}

const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const _qs = new URLSearchParams(location.search);
const TORSO_DEADBAND = (+(_qs.get('torsoplay') ?? 0) || 0) * Math.PI / 180;   // Basis VR default 0° (rigid); 30° = VSpineTorsoYawPlayInVR; desktop 45°
const TORSO_BLEND = 8;                                                          // BasisSettingsDefaults.cs:2111
const TORSO_RELOCK = 6 * Math.PI / 180;                                         // TorsoYawRelockSpeedDeg (BasisVirtualSpineCore.cs:18)
const latch = { anchor: null, broken: false, follow: 0, yaw: 0, lastHead: 0 };
const hipsBase = new THREE.Quaternion(), qHip = new THREE.Quaternion(), hipsLast = new THREE.Quaternion(0, 0, 0, 2), hipsStored = new THREE.Quaternion();   // hipsLast starts unequal to any unit quat
const CHAIN = ['spine', 'chest', 'upperChest', 'neck', 'head'];
const wY = [.12, .12, .16, .25, .35],   // porch-old's twist share: the body chases the head slowly (below), the uncaught part rides the spine
 wP = [.10, .12, .16, .26, .36], wR = [.08, .10, .14, .28, .40];
const look = new THREE.Vector3();          // damped pitch / yaw / roll
const hmdPos = new THREE.Vector3(), hmdQ = new THREE.Quaternion(), tmpS = new THREE.Vector3();
const qRel = new THREE.Quaternion(), qYaw = new THREE.Quaternion(), qFlip = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, Math.PI, 0));
const eul = new THREE.Euler(0, 0, 0, 'YXZ');
const eyeW = new THREE.Vector3(), delta = new THREE.Vector3(), rigQ = new THREE.Quaternion(), v1 = new THREE.Vector3();
const sa = (a) => Math.atan2(Math.sin(a), Math.cos(a));   // shortest-arc wrap

const dbg = { ticks: 0, notPresenting: 0, noSelf: 0, ran: 0, sim: false, hmdQ: null, pitchRaw: 0, arms: { left: false, right: false } };
const gripP = new THREE.Vector3(), gripQ = new THREE.Quaternion();
export const xrAvatarYaw = () => { const av = getSelf(); const v = av?.vrm; return v ? (av.root.rotation.y + latch.yaw + (v.scene.userData.restYaw ?? 0)) : null; };
export const xrLookPitch = () => dbg.look?.[0] ?? 0;
export const xrBodyDebug = () => ({ look: look.toArray().map((v) => +v.toFixed(3)), ...dbg });
// harness hook (?xrsim only): override the HMD pose xrbody reads. IWER's fake
// headset exposes no orientation setter, so the look-at math is tested by
// feeding the pose directly — the one input this module consumes.
let simHead = null;
export const xrSimActive = () => !!simHead;
// C18 (R 09-05 20:03: body root stays yaw-only; tracked head/hands ride the wire as full quaternions,
// Basis's shape). Everything here is FACING-relative — the wire `yaw` IS the facing (xrAvatarYaw), and a
// remote sets its root to it, so a receiver's root frame equals the sender's facing frame by construction:
// h = qRel (the look-chain input), l/r = grip [px,py,pz,qx,qy,qz,qw] in that frame, c = curls [lI,lG,rI,rG].
// Receivers RE-SOLVE (reach's pattern: a relation, not bones). Absent when not tracked; a side is absent
// while an emote owns the arms or the grip is untracked.
const wire = { on: false, h: null, l: null, r: null, c: null };
const r4 = (v) => +v.toFixed(4);
const facingQ = new THREE.Quaternion(), facingInv = new THREE.Quaternion(), rootP = new THREE.Vector3(), fp = new THREE.Vector3(), fq = new THREE.Quaternion();
export const xrWire = () => wire.on ? { h: wire.h, ...(wire.l ? { l: wire.l } : {}), ...(wire.r ? { r: wire.r } : {}), c: wire.c } : null;
export const xrSimHead = (pos, quat) => { if (CONFIG.params.has('xrsim')) simHead = pos ? { pos, quat } : null; };
const simGrip = { left: null, right: null };
export const xrSimGrip = (side, pos, quat) => { if (CONFIG.params.has('xrsim')) simGrip[side] = pos ? { pos, quat } : null; };

// ---- arm IK (Tier A3; porch-old index.html:5941 _solveArm + _aimBone) ------
// Two-bone solve per side to the controller grip: elbow interior angle clamped
// 23°–178° (Basis) so the wrist never snaps at full extension; the elbow pole
// is CHEST-LOCAL (down-and-back relative to the torso) so elbows stay right at
// any body yaw; the wrist takes the grip orientation through a per-hand
// calibration (porch's measured right, left = mirror). Emotes trump IK.
const WRIST_R = new THREE.Quaternion(0.5812875774993174, 0.7123369384133019, 0.08586779365740962, -0.38380664895827776);
const WRIST_L = new THREE.Quaternion(-WRIST_R.x, WRIST_R.y, WRIST_R.z, -WRIST_R.w).normalize();   // mirror across YZ
const _p = new THREE.Vector3(), _q = new THREE.Quaternion(), _d = new THREE.Vector3(), _pole = new THREE.Vector3(), _axis = new THREE.Vector3(), _u = new THREE.Vector3(), _elbow = new THREE.Vector3(), _rest = new THREE.Vector3();
// solver scratch — these run per side, per body (remotes too since C18), per frame: nothing here may allocate
const _uPos = new THREE.Vector3(), _toT = new THREE.Vector3(), _fwd = new THREE.Vector3(), _fq2 = new THREE.Quaternion(), _e2 = new THREE.Euler();
function aimBone(bone, targetWorld, childRestLocal) {
  bone.getWorldPosition(_p);
  bone.parent.getWorldQuaternion(_q).invert();
  _d.subVectors(targetWorld, _p).applyQuaternion(_q).normalize();
  bone.quaternion.setFromUnitVectors(_rest.copy(childRestLocal).normalize(), _d);
}
export function solveArm(vrm, side, targetPos, targetQuat) {
  const h = vrm.humanoid;
  const U = h.getNormalizedBoneNode(side + 'UpperArm'), L = h.getNormalizedBoneNode(side + 'LowerArm'), H = h.getNormalizedBoneNode(side + 'Hand');
  if (!U || !L || !H) return false;
  U.quaternion.identity(); L.quaternion.identity(); H.quaternion.identity();
  vrm.scene.updateMatrixWorld(true);
  const uPos = U.getWorldPosition(_uPos);
  const l1 = L.position.length(), l2 = H.position.length();
  const toT = _toT.subVectors(targetPos, uPos);
  let d = THREE.MathUtils.clamp(toT.length(), Math.abs(l1 - l2) + 0.02, l1 + l2 - 0.02);
  const E = Math.acos(THREE.MathUtils.clamp((l1 * l1 + l2 * l2 - d * d) / (2 * l1 * l2), -1, 1));
  const Ec = THREE.MathUtils.clamp(E, 23 * Math.PI / 180, 178 * Math.PI / 180);
  if (Ec !== E) d = Math.sqrt(Math.max(1e-6, l1 * l1 + l2 * l2 - 2 * l1 * l2 * Math.cos(Ec)));
  const dir = toT.normalize();   // aliases _toT; not read again after the pole
  const a = Math.acos(THREE.MathUtils.clamp((l1 * l1 + d * d - l2 * l2) / (2 * l1 * d), -1, 1));
  const chest = h.getNormalizedBoneNode('upperChest') || h.getNormalizedBoneNode('chest') || h.getNormalizedBoneNode('spine');
  chest ? chest.getWorldQuaternion(_q) : _q.identity();
  _pole.set(side === 'left' ? 0.3 : -0.3, -1, -0.5).normalize().applyQuaternion(_q);
  _axis.crossVectors(dir, _pole);
  if (_axis.lengthSq() < 1e-6) _axis.set(0, 0, 1); else _axis.normalize();
  _u.copy(dir).applyAxisAngle(_axis, a);
  _elbow.copy(uPos).addScaledVector(_u, l1);
  aimBone(U, _elbow, L.position); vrm.scene.updateMatrixWorld(true);
  aimBone(L, targetPos, H.position); vrm.scene.updateMatrixWorld(true);
  if (targetQuat) {
    H.parent.getWorldQuaternion(_q).invert();
    H.quaternion.copy(_q.multiply(targetQuat).multiply(side === 'left' ? WRIST_L : WRIST_R));
  }
  return true;
}

// ---- finger curl (Tier A4; porch-old :5917–5939 verbatim) ------------------
// Index ← trigger, Middle/Ring/Little ← grip, across Proximal/Intermediate/
// Distal at [1.22, 1.57, 0.96] rad for a full fist, handed sign. ASSIGN base×
// curl every frame — never multiply onto last frame's result: nothing resets
// finger bones in VR, so an accumulated curl integrates into spin (porch's
// spinning-fingertips bug). Base quats are captured on first touch.
const CURL = [1.22, 1.57, 0.96];
const curlQ = new THREE.Quaternion(), curlE = new THREE.Euler();
const simCurl = { left: null, right: null };
export const xrSimCurl = (side, c) => { if (CONFIG.params.has('xrsim')) simCurl[side] = c ? { ...c } : null; };
/** Put every finger bone back where the clip left it — the curl is a per-tick overlay, and the last tick of a
 *  session is a trigger pull (leave = trigger) that would otherwise stay on the desktop body and every remote's copy. */
export function resetFingers(vrm) {
  const base = vrm?.userData?._fingerBase; if (!base) return;
  for (const [b, q0] of base) b.quaternion.copy(q0);
  base.clear();
}
function fingerTick(vrm, curls) {
  const h = vrm.humanoid; if (!h) return;
  const ud = vrm.userData = vrm.userData || {};
  const base = ud._fingerBase || (ud._fingerBase = new Map());
  for (const side of ['left', 'right']) {
    const sgn = side === 'left' ? -1 : 1;
    const cur = curls[side] || {};
    for (const [finger, key] of [['Index', 'index'], ['Middle', 'grip'], ['Ring', 'grip'], ['Little', 'grip']]) {
      const amt = Math.min(1, Math.max(0, cur[key] || 0));
      ['Proximal', 'Intermediate', 'Distal'].forEach((seg, i) => {
        const b = h.getNormalizedBoneNode(side + finger + seg); if (!b) return;
        let b0 = base.get(b); if (!b0) { b0 = b.quaternion.clone(); base.set(b, b0); }
        curlQ.setFromEuler(curlE.set(0, 0, sgn * CURL[i] * amt));
        b.quaternion.copy(b0).multiply(curlQ);
      });
    }
  }
}

/** The distributed look-at, given the head in the body's facing frame. `lk` is the caller's damped
 *  pitch/yaw/roll state (one per body). Returns the raw clamped pitch. */
function applyLookChain(h, qIn, lk, dt) {
  eul.setFromQuaternion(qIn, 'YXZ');
  const pitch = THREE.MathUtils.clamp(eul.x, -0.7, 0.7), roll = THREE.MathUtils.clamp(eul.z, -0.5, 0.5), yaw = sa(eul.y);
  // dt is 0 after a >2 s hitch (frame.js clamps it) — headless XR runs at ~0.5 fps and
  // every frame is one; a zero step would freeze the chain, so take a half step instead
  const s = dt > 0 ? Math.min(1, dt * 9) : 0.5;
  lk.x += (pitch - lk.x) * s; lk.y += (yaw - lk.y) * s; lk.z += (roll - lk.z) * s;
  const yawFade = Math.max(0, Math.cos(lk.x));
  const bones = CHAIN.map((n) => h.getNormalizedBoneNode(n));
  let sY = 0, sP = 0, sR = 0; bones.forEach((b, i) => { if (b) { sY += wY[i]; sP += wP[i]; sR += wR[i]; } });
  bones.forEach((b, i) => { if (!b) return; b.quaternion.setFromEuler(eul.set(lk.x * (wP[i] / sP), lk.y * (wY[i] / sY) * yawFade, lk.z * (wR[i] / sR), 'YXZ')); });
  return pitch;
}

/** C18 receiver: pose a REMOTE body from its wire sample — same look chain, same arm solve, same curls,
 *  in the remote root's frame (== the sender's facing frame). No latch (the wire yaw already carries it),
 *  no eye anchor (the remote stands on its root). `st` = per-remote state { look: Vector3 }. */
export function applyRemoteXR(av, xr, st, dt) {
  const vrm = av?.vrm, h = vrm?.humanoid;
  if (!h || !xr || !Array.isArray(xr.h) || xr.h.length !== 4) return;
  qRel.fromArray(xr.h);
  applyLookChain(h, qRel, st.look, dt);
  if (!av.emote) {
    av.root.getWorldQuaternion(facingQ); av.root.getWorldPosition(rootP);
    for (const side of ['left', 'right']) {
      const g = xr[side[0]];
      if (!Array.isArray(g) || g.length !== 7) continue;
      fp.set(g[0], g[1], g[2]).applyQuaternion(facingQ).add(rootP);
      fq.set(g[3], g[4], g[5], g[6]).premultiply(facingQ);
      solveArm(vrm, side, fp, fq);
    }
  }
  const c = Array.isArray(xr.c) && xr.c.length === 4 ? xr.c : [0, 0, 0, 0];
  fingerTick(vrm, { left: { index: c[0], grip: c[1] }, right: { index: c[2], grip: c[3] } });
}

// ---- foot IK + gait (Tier C14; porch-old index.html:6068–6163, porch-old's 2026-07-09 gait v1, ported
// whole) — only with real HMD data (desktop keeps the mixer's legs); ?nofootik opts out. Feet are
// PLANTED in the world and STEP when the desired spot (under the hips at rest hip-width, on the
// root's floor) drifts past STEP or the body twists past YAWT; a stride is a 0.28 s sine-lift toward
// desired + velocity-lead; a foot won't step while its partner is airborne unless past EMERG (both
// airborne = running). Deterministic. When the eye anchor lifts the body beyond leg reach the feet
// dangle (reach-clamped); when it lowers the body the knees bend — that is how crouching reads.
const NOFOOT = _qs.has('nofootik');
const GAIT = { STEP: 0.16, EMERG: 0.42, YAWT: 0.7, DUR: 0.28, LIFT: 0.055, LEAD: 0.15, LEADMAX: 0.35, SNAP: 1.5 };
const _fv = new THREE.Vector3(), _fq = new THREE.Quaternion();
function measureLegs(vrm) {
  const h = vrm.humanoid, ud = vrm.userData = vrm.userData || {};
  if (ud.ankleH != null) return true;
  const hips = h.getNormalizedBoneNode('hips'), uL = h.getNormalizedBoneNode('leftUpperLeg'), fL = h.getNormalizedBoneNode('leftFoot');
  if (!hips || !uL || !fL) return false;
  vrm.scene.updateMatrixWorld(true);
  const floorY = vrm.scene.getWorldPosition(_fv).y;
  ud.ankleH = Math.max(0.02, fL.getWorldPosition(new THREE.Vector3()).y - floorY);   // near-straight idle legs ≈ rest
  ud.hipHalfW = Math.max(0.04, uL.getWorldPosition(new THREE.Vector3()).distanceTo(hips.getWorldPosition(new THREE.Vector3())) * 0.95);
  tee(`[xr] legs: ankleH ${ud.ankleH.toFixed(3)} hipHalfW ${ud.hipHalfW.toFixed(3)} (measured)`);
  return true;
}
function footTargets(vrm, floorY) {
  const h = vrm.humanoid, hips = h.getNormalizedBoneNode('hips');
  if (!hips) return null;
  const hp = hips.getWorldPosition(new THREE.Vector3()), hq = hips.getWorldQuaternion(new THREE.Quaternion());
  const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(hq); fwd.y = 0;
  if (fwd.lengthSq() < 1e-6) fwd.set(0, 0, 1); else fwd.normalize();
  const left = new THREE.Vector3(fwd.z, 0, -fwd.x);   // +x is the model's left at rest (porch: sign locked by test)
  const w = vrm.userData.hipHalfW, y = floorY + vrm.userData.ankleH;
  return { left: new THREE.Vector3(hp.x + left.x * w, y, hp.z + left.z * w), right: new THREE.Vector3(hp.x - left.x * w, y, hp.z - left.z * w), yaw: Math.atan2(fwd.x, fwd.z) };
}
function gaitLead(des, vel) { const l = vel.clone().multiplyScalar(GAIT.LEAD); if (l.length() > GAIT.LEADMAX) l.setLength(GAIT.LEADMAX); l.y = 0; return des.clone().add(l); }
function gaitInit(desL, desR, yaw) { return { L: { p: desL.clone(), yaw, step: null }, R: { p: desR.clone(), yaw, step: null }, vel: new THREE.Vector3(), lastMid: null }; }
function gaitTick(g, desL, desR, bodyYaw, t, dt) {
  const mid = desL.clone().add(desR).multiplyScalar(0.5);
  if (g.lastMid) g.vel.copy(mid).sub(g.lastMid).divideScalar(Math.max(dt, 1e-4)); else g.lastMid = new THREE.Vector3();
  g.lastMid.copy(mid);
  const D = { L: desL, R: desR };
  for (const sd of ['L', 'R']) {
    const f = g[sd], o = g[sd === 'L' ? 'R' : 'L'], des = D[sd];
    if (f.step) {
      const p = (t - f.step.t0) / f.step.dur;
      if (p >= 1) { f.p.copy(f.step.to); f.yaw = f.step.toYaw; f.step = null; }
      else { if (p < 0.5) f.step.to.copy(gaitLead(des, g.vel)); continue; }
    }
    const err = Math.hypot(f.p.x - des.x, f.p.z - des.z);
    if (err > GAIT.SNAP) { f.p.copy(des); f.yaw = bodyYaw; continue; }   // teleport: re-plant, no cross-room glide
    const yerr = Math.abs(wrap(bodyYaw - f.yaw));
    if ((err > GAIT.STEP || yerr > GAIT.YAWT) && (!o.step || err > GAIT.EMERG))
      f.step = { from: f.p.clone(), fromYaw: f.yaw, to: gaitLead(des, g.vel), toYaw: bodyYaw, t0: t, dur: GAIT.DUR };
  }
  const out = {};
  for (const sd of ['L', 'R']) { const f = g[sd];
    if (f.step) { const p = Math.min(1, (t - f.step.t0) / f.step.dur), e = p * p * (3 - 2 * p), dy = wrap(f.step.toYaw - f.step.fromYaw);
      out[sd] = { pos: f.step.from.clone().lerp(f.step.to, e), yaw: f.step.fromYaw + dy * e, lift: GAIT.LIFT * Math.sin(Math.PI * p) }; }
    else out[sd] = { pos: f.p.clone(), yaw: f.yaw, lift: 0 };
  }
  return out;
}
export function solveLeg(vrm, side, targetPos, footYaw) {
  const h = vrm.humanoid;
  const U = h.getNormalizedBoneNode(side + 'UpperLeg'), L = h.getNormalizedBoneNode(side + 'LowerLeg'), F = h.getNormalizedBoneNode(side + 'Foot');
  if (!U || !L || !F) return false;
  U.quaternion.identity(); L.quaternion.identity(); F.quaternion.identity();
  vrm.scene.updateMatrixWorld(true);
  const uPos = U.getWorldPosition(_uPos);
  const l1 = L.position.length(), l2 = F.position.length();
  const toT = _toT.subVectors(targetPos, uPos);
  let d = THREE.MathUtils.clamp(toT.length(), Math.abs(l1 - l2) + 0.02, l1 + l2 - 0.01);
  const K = Math.acos(THREE.MathUtils.clamp((l1 * l1 + l2 * l2 - d * d) / (2 * l1 * l2), -1, 1));
  const Kc = THREE.MathUtils.clamp(K, 25 * Math.PI / 180, 178 * Math.PI / 180);   // no hyperextension snap
  if (Kc !== K) d = Math.sqrt(Math.max(1e-6, l1 * l1 + l2 * l2 - 2 * l1 * l2 * Math.cos(Kc)));
  const dir = toT.normalize();
  const a = Math.acos(THREE.MathUtils.clamp((l1 * l1 + d * d - l2 * l2) / (2 * l1 * d), -1, 1));
  const hips = h.getNormalizedBoneNode('hips'); hips ? hips.getWorldQuaternion(_fq) : _fq.identity();
  const pole = _pole.set(0, -0.15, 1).normalize().applyQuaternion(_fq);   // knees forward-and-slightly-down
  const axis = _axis.crossVectors(dir, pole);
  if (axis.lengthSq() < 1e-6) axis.set(1, 0, 0); else axis.normalize();
  const knee = _elbow.copy(uPos).addScaledVector(_u.copy(dir).applyAxisAngle(axis, a), l1);
  aimBone(U, knee, L.position); vrm.scene.updateMatrixWorld(true);
  aimBone(L, targetPos, F.position); vrm.scene.updateMatrixWorld(true);
  const fwd = footYaw !== undefined ? _fwd.set(Math.sin(footYaw), 0, Math.cos(footYaw)) : _fwd.set(0, 0, 1).applyQuaternion(_fq); fwd.y = 0;
  if (fwd.lengthSq() > 1e-6) { fwd.normalize();
    F.parent.getWorldQuaternion(_fq).invert();
    F.quaternion.copy(_fq.multiply(_fq2.setFromEuler(_e2.set(0, Math.atan2(fwd.x, fwd.z), 0)))); }   // flat foot, toes along the planted yaw
  return true;
}
function feetTick(vrm, av, dt) {
  if (NOFOOT || !measureLegs(vrm)) return;
  const floorY = av.root.getWorldPosition(_fv).y;
  const ft = footTargets(vrm, floorY); if (!ft) return;
  const ud = vrm.userData;
  ud._gaitT = (ud._gaitT || 0) + (dt > 0 ? dt : 1 / 30);
  if (!ud._gait) ud._gait = gaitInit(ft.left, ft.right, ft.yaw);
  const gp = gaitTick(ud._gait, ft.left, ft.right, ft.yaw, ud._gaitT, dt > 0 ? dt : 1 / 30);
  gp.L.pos.y += gp.L.lift; gp.R.pos.y += gp.R.lift;
  solveLeg(vrm, 'left', gp.L.pos, gp.L.yaw); solveLeg(vrm, 'right', gp.R.pos, gp.R.yaw);
  dbg.feet = { L: gp.L.pos.toArray().map((v) => +v.toFixed(3)), R: gp.R.pos.toArray().map((v) => +v.toFixed(3)), stepping: !!(ud._gait.L.step || ud._gait.R.step) };
}
export const xrGaitDebug = () => dbg.feet ?? null;

export function tickXRBody(dt) {
  dbg.ticks++;
  // ?xrsim with a fed head pose runs the chain WITHOUT a session: the headless
  // fake session lives ~1 frame/2 s and drops unpredictably; the math and the
  // frame ordering are what this path tests (the session itself is proven apart)
  if (!isPresenting() && !simHead) { dbg.notPresenting++; wire.on = false; return; }
  const av = getSelf(); const vrm = av?.vrm; const h = vrm?.humanoid;
  if (!h || !av.root) { dbg.noSelf++; wire.on = false; return; }
  dbg.ran++; wire.on = true; wire.l = wire.r = null;
  const rig = xrRig();
  if (!simHead) { applyTurnEarly(dt); syncRigToBody(); }   // THIS frame's turn, then the rig (and the stereo camera) follow THIS frame's root — before anything here reads them

  // the HMD in world, then scaled about the rig (DeviceScale: tracked targets, not the view)
  if (simHead) { hmdPos.fromArray(simHead.pos); hmdQ.fromArray(simHead.quat); }
  else renderer.xr.getCamera().matrixWorld.decompose(hmdPos, hmdQ, tmpS);
  // DeviceScale, Basis's way: the PUPPET wears the scale (vrm.scene.scale = 1/k), tracking stays 1:1 —
  // hands land on the controllers by construction. A change re-measures the legs (ankle height and
  // hip width are read in world units) and is announced once.
  { const ps = simHead ? 1 : puppetScale(); const ud = vrm.userData = vrm.userData || {};
    if (Math.abs(vrm.scene.scale.x - ps) > 1e-4) { vrm.scene.scale.setScalar(ps); ud.ankleH = null; ud._gait = null; tee(`[xr] puppet scale ${ps.toFixed(3)} (avatar sized to you; targets 1:1)`); } }

  // 1. distributed look-at
  // facing = the body's TRUE world yaw. The controller already turns the body to
  // the HMD's yaw every frame (setCamYaw → myState.yaw → root.rotation.y), so the
  // residual here is only what the head has turned beyond the body. R's first
  // headset read (09-05 19:55): computing this against rig.rotation.y (0 at
  // entry) while the body faced her heading gave a constant residual ≈ her
  // heading — the spine twisted toward it, the anchor pulled, the controller
  // re-asserted: 'snap back' and 'the back of my avatar'.
  // 1a. THE HIPS CHASE THE HEAD — Basis's torso-yaw latch (BasisVirtualSpineCore.cs:246–284; R 09-05
  // 21:15: "do Basis's hip IK method — their methods are hard-won"). The controller owns the root
  // (stick); the HIPS bone — the humanoid root, legs come along — carries a yaw offset toward the
  // head's world yaw: the torso holds an ANCHOR; the head roams freely inside a deadband (VR default
  // 0° = rigid; ?torsoplay=30 is Basis's opt-in shoulder play; desktop 45°); exceeding it — or
  // locomoting at all — breaks the anchor and `follow` ramps to 1 at blend 8/s; once fully
  // followed and the head has slowed below 6°/s the anchor re-latches. Output = slerp(anchor, head,
  // follow). The look chain below is the spine solver between hips and the tracked head. The rest
  // offset (which way THIS model faces at hips identity, in root space) is measured once.
  av.root.getWorldQuaternion(qYaw); eul.setFromQuaternion(qYaw, 'YXZ'); const rootYaw = eul.y;
  const hips = h.getNormalizedBoneNode('hips');
  if (vrm.scene.userData.restYaw == null) {
    const hb = hips ?? h.getNormalizedBoneNode('head'); hb.updateWorldMatrix(true, false);
    const f = tmpS.set(0, 0, 1).applyQuaternion(hb.getWorldQuaternion(rigQ));   // eido's facing = (sin yaw, 0, cos yaw): +Z is forward
    av.root.getWorldQuaternion(rigQ).invert(); f.applyQuaternion(rigQ);
    vrm.scene.userData.restYaw = Math.atan2(f.x, f.z);
    tee(`[xr] body rest yaw ${vrm.scene.userData.restYaw.toFixed(2)} (measured; VRM${vrm.meta?.metaVersion ?? '?'})`);
  }
  const restYaw = vrm.scene.userData.restYaw;
  { const hf = tmpS.set(0, 0, -1).applyQuaternion(hmdQ); const headYaw = wrap(Math.atan2(hf.x, hf.z) - rootYaw - restYaw);   // head yaw as a hips OFFSET
    const L = latch; const dtc = dt > 0 ? dt : 1 / 30;
    if (L.anchor == null) { L.anchor = headYaw; L.lastHead = headYaw; }
    const headSpeed = Math.abs(wrap(headYaw - L.lastHead)) / dtc; L.lastHead = headYaw;
    const locomoting = (myState.speed ?? 0) > 0.05;
    if (!L.broken && (Math.abs(wrap(headYaw - L.anchor)) > TORSO_DEADBAND || locomoting)) L.broken = true;
    L.follow += ((L.broken ? 1 : 0) - L.follow) * (1 - Math.exp(-TORSO_BLEND * dtc));
    if (L.broken && L.follow >= 0.999 && headSpeed <= TORSO_RELOCK) { L.broken = false; L.anchor = headYaw; }
    L.yaw = wrap(L.anchor + wrap(headYaw - L.anchor) * L.follow);
    if (hips) {
      // The base is the MIXER's pose. If the bone still holds what WE wrote last frame (a clip that
      // doesn't own hips, an emote ending), reuse the stored base — else the latch compounds into a
      // fast spin (R, 09-05 22:14: 'a strobing tumbleweed… spinning extremely fast' after a wave).
      if (hipsLast.equals(hips.quaternion)) hipsBase.copy(hipsStored); else { hipsBase.copy(hips.quaternion); hipsStored.copy(hipsBase); }
      qHip.setFromEuler(eul.set(0, L.yaw, 0, 'YXZ')); hips.quaternion.copy(qHip).multiply(hipsBase); hipsLast.copy(hips.quaternion); hips.updateWorldMatrix(true, true);
    }
    dbg.hipsYaw = L.yaw; dbg.follow = L.follow; }
  // the look chain measures the head against the BODY'S ACTUAL FACING = root + hips offset + rest
  const facing = rootYaw + latch.yaw + restYaw;
  qYaw.setFromEuler(eul.set(0, facing, 0, 'YXZ')).invert();
  // porch-old :6185 `qRel = R_y(rigY+sceneY)⁻¹ · hq · R_y(π)`: the HMD is a −Z-forward camera frame, the
  // body is +Z-forward (eido's facing = (sin yaw, 0, cos yaw); `restYaw` measured it). Conjugating through
  // R_y(π) expresses the head in the body's frame — and negates pitch/roll correctly (the two frames call
  // 'up' opposite X rotations; porch's inversion fix 2026-07-09). Probe 09-05 20:58 without it: residual yaw −π.
  qRel.copy(qYaw).multiply(hmdQ).multiply(qFlip);
  wire.h = qRel.toArray().map(r4);
  dbg.sim = !!simHead; dbg.hmdQ = hmdQ.toArray().map((v) => +v.toFixed(3));
  dbg.pitchRaw = +applyLookChain(h, qRel, look, dt).toFixed(3);

  // 2. eye anchor — measured eye if the VRM has eye bones, else head + (0, .06, .10)
  vrm.scene.position.set(0, 0, 0); vrm.scene.updateMatrixWorld(true);
  const le = h.getNormalizedBoneNode('leftEye'), re = h.getNormalizedBoneNode('rightEye'), hd = h.getNormalizedBoneNode('head');
  if (le && re) eyeW.copy(le.getWorldPosition(v1)).add(re.getWorldPosition(tmpS)).multiplyScalar(0.5);
  else if (hd) eyeW.copy(hd.getWorldPosition(v1)).add(tmpS.set(0, 0.06, 0.10).applyQuaternion(hd.getWorldQuaternion(rigQ)));
  else return;
  delta.copy(hmdPos).sub(eyeW);
  av.root.getWorldQuaternion(rigQ).invert();          // root-local: the controller owns the root; we offset the VRM inside it
  vrm.scene.position.copy(delta.applyQuaternion(rigQ));
  vrm.scene.updateMatrixWorld(true);

  // 2b. feet planted on the floor (C14) — after the anchor moved the hips, before the arms; stays
  //     tracked through emotes like the head does (porch's rule)
  feetTick(vrm, av, dt);

  // 3. arms to the grips (A3) — emotes trump IK (R's rule: an emote you chose
  // always wins); an untracked grip (sitting at the rig origin) leaves the arm
  // to the clip. Targets are DeviceScaled about the rig like the head.
  const live = xrFingerCurl();
  const curls = { left: simCurl.left ?? live.left ?? {}, right: simCurl.right ?? live.right ?? {} };
  wire.c = [curls.left.index, curls.left.grip, curls.right.index, curls.right.grip].map((v) => r4(Math.min(1, Math.max(0, v || 0))));
  if (av.emote) { dbg.arms.left = dbg.arms.right = false; fingerTick(vrm, curls); return; }
  const hands = xrHands();
  facingQ.setFromEuler(eul.set(0, facing, 0, 'YXZ')); facingInv.copy(facingQ).invert(); av.root.getWorldPosition(rootP);
  for (const side of ['left', 'right']) {
    const grip = hands[side]?.grip;
    let ok = false;
    if (simGrip[side]) { gripP.fromArray(simGrip[side].pos); gripQ.fromArray(simGrip[side].quat); ok = solveArm(vrm, side, gripP, gripQ); }
    else if (grip) {
      grip.matrixWorld.decompose(gripP, gripQ, tmpS);
      if (gripP.distanceToSquared(rig.position) > 1e-4) ok = solveArm(vrm, side, gripP, gripQ);   // 1:1 — the puppet is scaled, not the target
    }
    dbg.arms[side] = ok;
    if (ok) { fp.copy(gripP).sub(rootP).applyQuaternion(facingInv); fq.copy(facingInv).multiply(gripQ); wire[side[0]] = [...fp.toArray(), ...fq.toArray()].map(r4); }
  }
  fingerTick(vrm, curls);   // after the arms: curls compose onto the solved pose
}
