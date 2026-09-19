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

// ---- arm IK (Tier A3) — Basis's swivel solver, ported 2026-09-19 -----------
// Was porch-old's two-bone + fixed chest-local pole (elbow flipped at the pole singularity — the
// `_axis=(0,0,1)` fallback — and the wrist wrapped because the hand bone took the whole grip twist).
// Now BasisArmSolveCore.cs (com.basis.eeriemovement, 6377b3eb): the elbow lives on the circle of
// radius upper·sinα about the shoulder→hand axis; a STABLE frame (ex,ey) on that circle is built
// from the torso so the swivel angle is continuous across reach directions; 36 samples + golden
// refine pick the cheapest angle under (a) a prior — rest direction blended toward the head's line
// of sight, (b) last frame's angle, (c) a torso-capsule penalty; a far-cheaper basin only wins after
// a 0.2 s dwell (hysteresis: no flicker between two elbows); the chosen angle is smoothed 0.08 s at
// ≤720°/s, reset outright on a teleport (>0.6·chain). Reach is SOFT at the end (exponential, s=0.02),
// so full extension never pops. The wrist twist is SPLIT: the forearm rolls (keep ≤15°/15% on the
// hand, fade 155–178°, cap 120°) and the hand takes the remainder — the grip orientation still
// lands exactly. Joint-limit costs (humeral/pronation/wrist) are NOT ported: they need Basis's per-
// joint limit tables; a later rung. Emotes trump IK. Lost tracking: hold 0.5 s, then relax to the
// clip at 3 Hz (Basis's tracker-loss rule) instead of snapping in one frame.
const WRIST_R = new THREE.Quaternion(0.5812875774993174, 0.7123369384133019, 0.08586779365740962, -0.38380664895827776);
const WRIST_L = new THREE.Quaternion(-WRIST_R.x, WRIST_R.y, WRIST_R.z, -WRIST_R.w).normalize();   // mirror across YZ
const ARM = { SAMPLES: 36, REFINE: 8, MIN_ELBOW: 22 * Math.PI / 180, MIN_REACH_FRAC: 0.05, SOFT: 0.02, PRIOR_W: 0.5, PREV_W: 0.25,
  TORSO_W: 1.5, LOCAL_BASIN: 60 * Math.PI / 180, BASIN_JUMP: 100 * Math.PI / 180, SWITCH_MARGIN: 0.12, DWELL: 0.2, SMOOTH: 0.08, MAX_RATE: 720 * Math.PI / 180,
  TELEPORT: 0.6, HEAD_FADE: [0.15, 0.45], REST_OUT: 0.35, REST_BACK: 0.25,
  WRIST_KEEP_FRAC: 0.15, WRIST_KEEP_MAX: 15 * Math.PI / 180, ROLL_MAX: 120 * Math.PI / 180, WRAP_FADE: [155 * Math.PI / 180, 178 * Math.PI / 180],
  HOLD: 0.5, RELAX_HZ: 3 };
const _p = new THREE.Vector3(), _q = new THREE.Quaternion(), _d = new THREE.Vector3(), _u = new THREE.Vector3(), _elbow = new THREE.Vector3(), _rest = new THREE.Vector3();
// solver scratch — these run per side, per body (remotes too since C18), per frame: nothing here may allocate
const _uPos = new THREE.Vector3(), _toT = new THREE.Vector3(), _axis = new THREE.Vector3(), _up = new THREE.Vector3(), _fwd = new THREE.Vector3(), _out = new THREE.Vector3();
const _et = new THREE.Vector3(), _er = new THREE.Vector3(), _ex = new THREE.Vector3(), _ey = new THREE.Vector3(), _ctr = new THREE.Vector3(), _dir = new THREE.Vector3();
const _prior = new THREE.Vector3(), _hp = new THREE.Vector3(), _ta = new THREE.Vector3(), _tb = new THREE.Vector3(), _tq = new THREE.Vector3(), _fa = new THREE.Vector3();
const _q2 = new THREE.Quaternion(), _q3 = new THREE.Quaternion(), _qU = new THREE.Quaternion(), _qL = new THREE.Quaternion(), _qH = new THREE.Quaternion();
const smoothstep = (a, b, v) => { const t = THREE.MathUtils.clamp((v - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const wrapA = (a) => a - 2 * Math.PI * Math.floor((a + Math.PI) / (2 * Math.PI));
function aimBone(bone, targetWorld, childRestLocal) {
  bone.getWorldPosition(_p);
  bone.parent.getWorldQuaternion(_q).invert();
  _d.subVectors(targetWorld, _p).applyQuaternion(_q).normalize();
  bone.quaternion.setFromUnitVectors(_rest.copy(childRestLocal).normalize(), _d);
}
// swing–twist split about a unit axis (local frame): returns the signed twist angle
function twistAbout(q, axis) {
  const d = q.x * axis.x + q.y * axis.y + q.z * axis.z;
  const t = 2 * Math.atan2(d, q.w);   // twist quaternion = normalize(w, d·axis)
  return wrapA(t);
}
function armState(vrm, side) {
  const ud = vrm.userData = vrm.userData || {}; const a = ud._arm = ud._arm || {};
  return a[side] = a[side] || { seeded: false, swivel: 0, switchT: 0, lastT: new THREE.Vector3(), lastAxis: new THREE.Vector3(), lost: 0, held: null };
}
// Basis Frame(): a circle basis that stays continuous as the reach axis swings around the body
function swivelFrame(axis, up, fwd, out) {
  _et.set(0, 0, 0).addScaledVector(out, -0.45).addScaledVector(up, -0.6).addScaledVector(fwd, -0.65).normalize();
  _er.copy(up).negate().addScaledVector(_et, -_et.dot(_er));   // -up minus its projection on et
  if (_er.lengthSq() > 1e-8) _er.normalize(); else _er.crossVectors(_et, fwd).normalize();
  _ta.subVectors(axis, _et); _tb.crossVectors(_ta, _er); _ex.crossVectors(_tb, axis);
  if (_ex.lengthSq() > 1e-8) _ex.normalize();
  else { _ex.copy(_er).addScaledVector(axis, -_er.dot(axis)); if (_ex.lengthSq() < 1e-8) _ex.copy(fwd).addScaledVector(axis, -fwd.dot(axis)); _ex.normalize(); }
  _ey.crossVectors(axis, _ex);
}
const dirToAng = (v) => Math.atan2(v.dot(_ey), v.dot(_ex));
const angToDir = (a, o) => o.copy(_ex).multiplyScalar(Math.cos(a)).addScaledVector(_ey, Math.sin(a));
function torsoCost(elbow, a, b, radius) {
  _tq.subVectors(b, a); const abSq = _tq.lengthSq(); const t = abSq > 1e-8 ? THREE.MathUtils.clamp(_fa.subVectors(elbow, a).dot(_tq) / abSq, 0, 1) : 0;
  _tq.multiplyScalar(t).add(a); const dist = elbow.distanceTo(_tq), margin = radius * 1.5;
  if (dist >= margin) return 0;
  const soft = (margin - dist) / Math.max(margin - radius, 1e-5); let c = ARM.TORSO_W * soft * soft;
  if (dist < radius) { const pen = (radius - dist) / Math.max(radius, 1e-5); c += ARM.TORSO_W * 8 * pen * pen; }
  return c;
}
/** Solve one arm to a world grip. `opts.dt` drives smoothing/hysteresis; `opts.head` (world) biases the
 *  elbow prior toward the line of sight; `opts.torso` = {a, b, r} capsule (hips→neck). Returns true when posed. */
export function solveArm(vrm, side, targetPos, targetQuat, opts = {}) {
  const h = vrm.humanoid;
  const U = h.getNormalizedBoneNode(side + 'UpperArm'), L = h.getNormalizedBoneNode(side + 'LowerArm'), H = h.getNormalizedBoneNode(side + 'Hand');
  if (!U || !L || !H) return false;
  const st = armState(vrm, side), dt = opts.dt > 0 ? opts.dt : 1 / 60;
  U.quaternion.identity(); L.quaternion.identity(); H.quaternion.identity();
  vrm.scene.updateMatrixWorld(true);
  const uPos = U.getWorldPosition(_uPos);
  const upper = L.position.length(), lower = H.position.length(), chain = upper + lower;
  if (upper < 1e-5 || lower < 1e-5) return false;
  // torso frame (world): the model faces +Z at hips identity; its left arm is +X
  const chest = h.getNormalizedBoneNode('upperChest') || h.getNormalizedBoneNode('chest') || h.getNormalizedBoneNode('spine');
  chest ? chest.getWorldQuaternion(_q) : _q.identity();
  _up.set(0, 1, 0).applyQuaternion(_q); _fwd.set(0, 0, 1).applyQuaternion(_q); _out.set(side === 'left' ? 1 : -1, 0, 0).applyQuaternion(_q);
  const toT = _toT.subVectors(targetPos, uPos), d = toT.length();
  // MinReach: the 22° interior floor, never less than |upper−lower| or 5 % of the chain
  const minReach = Math.max(Math.sqrt(Math.max(0, upper * upper + lower * lower - 2 * upper * lower * Math.cos(ARM.MIN_ELBOW))), Math.abs(upper - lower) + 1e-5, ARM.MIN_REACH_FRAC * chain);
  if (d > minReach) _axis.copy(toT).divideScalar(d);
  else if (st.seeded && st.lastAxis.lengthSq() > 1e-8) _axis.copy(st.lastAxis);
  else _axis.copy(d > 1e-5 ? toT.divideScalar(d) : _out);
  // SoftReach: exponential approach to full extension instead of a hard clamp
  const sft = ARM.SOFT, startD = chain * (1 - sft);
  let dEff = d <= startD ? d : chain * (1 - sft * Math.exp(-(d - startD) / (sft * chain)));
  dEff = Math.max(dEff, minReach);
  const cosA = THREE.MathUtils.clamp((upper * upper + dEff * dEff - lower * lower) / (2 * upper * dEff), -1, 1), sinA = Math.sqrt(Math.max(0, 1 - cosA * cosA));
  _ctr.copy(uPos).addScaledVector(_axis, upper * cosA); const radius = upper * sinA;
  swivelFrame(_axis, _up, _fwd, _out);
  // prior: rest (out·.35 − fwd·.25 − up) blended toward the head→target line as it leaves the axis
  _prior.set(0, 0, 0).addScaledVector(_out, ARM.REST_OUT).addScaledVector(_fwd, -ARM.REST_BACK).sub(_up);
  _prior.addScaledVector(_axis, -_prior.dot(_axis));
  if (_prior.lengthSq() < 1e-8) _prior.copy(_out).addScaledVector(_axis, -_out.dot(_axis));
  _prior.normalize();
  if (opts.head) {
    _hp.subVectors(targetPos, opts.head); const fLen = _hp.length();
    if (fLen > 1e-5) { _hp.addScaledVector(_axis, -_hp.dot(_axis)); const sin = _hp.length() / fLen, w = smoothstep(ARM.HEAD_FADE[0], ARM.HEAD_FADE[1], sin);
      if (w > 0) { _hp.divideScalar(sin * fLen).multiplyScalar(w).addScaledVector(_prior, 1 - w); if (_hp.lengthSq() > 1e-8) _prior.copy(_hp).normalize(); } }
  }
  const priorA = dirToAng(_prior), prevA = st.seeded ? st.swivel : priorA, prevW = st.seeded ? ARM.PREV_W : 0;
  const torso = opts.torso;
  const cost = (psi) => { angToDir(psi, _dir); _elbow.copy(_ctr).addScaledVector(_dir, radius);
    let c = ARM.PRIOR_W * (1 - Math.cos(psi - priorA)) + prevW * (1 - Math.cos(psi - prevA));
    if (torso) c += torsoCost(_elbow, torso.a, torso.b, torso.r);
    return c; };
  // 36 samples, then the cheapest within 60° of last frame's basin (hysteresis)
  const step = 2 * Math.PI / ARM.SAMPLES; let best = 0, bestC = Infinity, local = -1, localC = Infinity;
  for (let k = 0; k < ARM.SAMPLES; k++) { const psi = k * step - Math.PI, c = cost(psi);
    if (c < bestC) { bestC = c; best = k; }
    if (st.seeded && Math.abs(wrapA(psi - st.swivel)) <= ARM.LOCAL_BASIN && c < localC) { localC = c; local = k; } }
  let chosen = best;
  if (st.seeded && local >= 0 && Math.abs(wrapA(best * step - Math.PI - st.swivel)) > ARM.BASIN_JUMP) {
    if (localC - bestC > ARM.SWITCH_MARGIN) { st.switchT += dt; if (st.switchT >= ARM.DWELL) st.switchT = 0; else chosen = local; }
    else { st.switchT = 0; chosen = local; }
  } else st.switchT = 0;
  // golden-section refine around the chosen sample
  let lo = chosen * step - Math.PI - step, hi = lo + 2 * step; const phi = 0.6180339887;
  let x1 = hi - phi * (hi - lo), x2 = lo + phi * (hi - lo), f1 = cost(x1), f2 = cost(x2);
  for (let it = 0; it < ARM.REFINE; it++) {
    if (f1 < f2) { hi = x2; x2 = x1; f2 = f1; x1 = hi - phi * (hi - lo); f1 = cost(x1); }
    else { lo = x1; x1 = x2; f1 = f2; x2 = lo + phi * (hi - lo); f2 = cost(x2); }
  }
  const target = wrapA(f1 < f2 ? x1 : x2);
  const teleport = st.seeded && targetPos.distanceToSquared(st.lastT) > ARM.TELEPORT * ARM.TELEPORT * chain * chain;
  if (!st.seeded || teleport) st.swivel = target;
  else { const alpha = 1 - Math.exp(-dt / ARM.SMOOTH); let s = wrapA(target - st.swivel) * alpha; const m = ARM.MAX_RATE * dt; s = THREE.MathUtils.clamp(s, -m, m); st.swivel = wrapA(st.swivel + s); }
  st.seeded = true; st.lastT.copy(targetPos); st.lastAxis.copy(_axis);
  angToDir(st.swivel, _dir); _elbow.copy(_ctr).addScaledVector(_dir, radius);
  _u.copy(uPos).addScaledVector(_axis, dEff);   // the hand lands at the SOFT reach, on the axis
  aimBone(U, _elbow, L.position); vrm.scene.updateMatrixWorld(true);
  aimBone(L, _u, H.position); vrm.scene.updateMatrixWorld(true);
  if (targetQuat) {
    // demanded hand-local orientation, then split its twist about the forearm: the forearm rolls the bulk
    H.parent.getWorldQuaternion(_q).invert();
    _qH.copy(_q).multiply(targetQuat).multiply(side === 'left' ? WRIST_L : WRIST_R);
    _fa.copy(H.position).normalize();   // forearm axis in the lower arm's local frame
    const demand = twistAbout(_qH, _fa), mag = Math.abs(demand);
    let roll = (mag - Math.min(ARM.WRIST_KEEP_FRAC * mag, ARM.WRIST_KEEP_MAX)) * (1 - smoothstep(ARM.WRAP_FADE[0], ARM.WRAP_FADE[1], mag));
    roll = Math.min(roll, ARM.ROLL_MAX); if (demand < 0) roll = -roll;
    if (Math.abs(roll) > 1e-4) {
      L.quaternion.multiply(_q2.setFromAxisAngle(_fa, roll)); L.updateWorldMatrix(false, false);
      H.parent.getWorldQuaternion(_q).invert();
      _qH.copy(_q).multiply(targetQuat).multiply(side === 'left' ? WRIST_L : WRIST_R);   // the hand takes what the roll left
    }
    H.quaternion.copy(_qH);
  }
  st.held = st.held || { U: new THREE.Quaternion(), L: new THREE.Quaternion(), H: new THREE.Quaternion(), pos: new THREE.Vector3(), quat: new THREE.Quaternion() };
  st.held.U.copy(U.quaternion); st.held.L.copy(L.quaternion); st.held.H.copy(H.quaternion); st.held.pos.copy(targetPos); if (targetQuat) st.held.quat.copy(targetQuat);
  st.lost = 0;
  return true;
}
/** Tracking lost this frame: hold the last solve for 0.5 s, then relax toward the clip pose at 3 Hz.
 *  Returns true while the arm is still (partly) ours. The bones hold the CLIP's pose on entry. */
export function relaxArm(vrm, side, dt) {
  const st = armState(vrm, side); if (!st.seeded || !st.held) return false;
  const h = vrm.humanoid;
  const U = h.getNormalizedBoneNode(side + 'UpperArm'), L = h.getNormalizedBoneNode(side + 'LowerArm'), H = h.getNormalizedBoneNode(side + 'Hand');
  if (!U || !L || !H) return false;
  st.lost += dt > 0 ? dt : 1 / 60;
  if (st.lost <= ARM.HOLD) { U.quaternion.copy(st.held.U); L.quaternion.copy(st.held.L); H.quaternion.copy(st.held.H); return true; }
  const w = Math.exp(-ARM.RELAX_HZ * (st.lost - ARM.HOLD));   // 1 → 0 after the hold
  if (w < 0.01) { st.seeded = false; return false; }
  _qU.copy(U.quaternion); _qL.copy(L.quaternion); _qH.copy(H.quaternion);   // the clip's pose
  U.quaternion.copy(_qU).slerp(st.held.U, w); L.quaternion.copy(_qL).slerp(st.held.L, w); H.quaternion.copy(_qH).slerp(st.held.H, w);
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
    const torso = torsoCapsule(vrm, h);
    for (const side of ['left', 'right']) {
      const g = xr[side[0]];
      if (!Array.isArray(g) || g.length !== 7) { relaxArm(vrm, side, dt); continue; }   // a side absent from the wire = lost there too
      fp.set(g[0], g[1], g[2]).applyQuaternion(facingQ).add(rootP);
      fq.set(g[3], g[4], g[5], g[6]).premultiply(facingQ);
      solveArm(vrm, side, fp, fq, { dt, torso });
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
  // 3a. the chest follows the hands (Basis: 0.3× the hands' mean yaw off the facing, ±15°, split 60/40
  //     chest/upperChest) — reaching across the body turns the torso a little, as a body does
  let tracked = 0; handMean.set(0, 0, 0);
  for (const side of ['left', 'right']) { const g = simGrip[side] ? gripP.fromArray(simGrip[side].pos) : (hands[side]?.grip ? hands[side].grip.getWorldPosition(gripP) : null);
    if (g && g.distanceToSquared(rig.position) > 1e-4) { handMean.add(g); tracked++; } }
  if (tracked) { handMean.divideScalar(tracked).sub(rootP).applyQuaternion(facingInv);
    const off = THREE.MathUtils.clamp(0.3 * Math.atan2(handMean.x, handMean.z), -CHEST_FOLLOW_MAX, CHEST_FOLLOW_MAX);
    const c = h.getNormalizedBoneNode('chest'), uc = h.getNormalizedBoneNode('upperChest');
    if (c) c.quaternion.premultiply(_q2.setFromAxisAngle(Y_AXIS, off * (uc ? 0.6 : 1)));
    if (uc) uc.quaternion.premultiply(_q2.setFromAxisAngle(Y_AXIS, off * (c ? 0.4 : 1))); }
  torsoCapsule(vrm, h);
  for (const side of ['left', 'right']) {
    const grip = hands[side]?.grip;
    let ok = false;
    const opts = { dt, head: hmdPos, torso: torsoCap };
    if (simGrip[side]) { gripP.fromArray(simGrip[side].pos); gripQ.fromArray(simGrip[side].quat); ok = solveArm(vrm, side, gripP, gripQ, opts); }
    else if (grip) {
      grip.matrixWorld.decompose(gripP, gripQ, tmpS);
      if (gripP.distanceToSquared(rig.position) > 1e-4) ok = solveArm(vrm, side, gripP, gripQ, opts);   // 1:1 — the puppet is scaled, not the target
    }
    dbg.arms[side] = ok;
    if (ok) { fp.copy(gripP).sub(rootP).applyQuaternion(facingInv); fq.copy(facingInv).multiply(gripQ); wire[side[0]] = [...fp.toArray(), ...fq.toArray()].map(r4); }
    else relaxArm(vrm, side, dt);   // hold, then ease back to the clip — never a one-frame snap
  }
  fingerTick(vrm, curls);   // after the arms: curls compose onto the solved pose
}
const handMean = new THREE.Vector3(), Y_AXIS = new THREE.Vector3(0, 1, 0), CHEST_FOLLOW_MAX = 15 * Math.PI / 180;
const torsoCap = { a: new THREE.Vector3(), b: new THREE.Vector3(), r: 0.12 };
function torsoCapsule(vrm, h) {
  const a = h.getNormalizedBoneNode('hips') || h.getNormalizedBoneNode('spine'), b = h.getNormalizedBoneNode('neck') || h.getNormalizedBoneNode('head');
  if (!a || !b) return null;
  a.getWorldPosition(torsoCap.a); b.getWorldPosition(torsoCap.b); torsoCap.r = 0.12 * (vrm.scene.scale.x || 1);
  return torsoCap;
}
