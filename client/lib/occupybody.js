// seatbody — a body at a socket, every frame: where it is, how it got there, and what it does there.
//
// One driver for every seated body — mine (localbody.js) and everyone else's (remotes.js) — so a sitter looks the same
// on every screen: the same transform (world.js mountTransform: the socket, its part's motion, the anchor), the same
// signals (client/lib/socksignals.js: closed forms of the thing's motion, the occupant's input from their presence), the
// same pose evaluation (shared/sockbody.js evalPose) and the same reach targets. What the socket says is data
// (shared/sockbody.js); this module only realizes it on an Avatar (avatar.js: setSeatBlend, setSeatHold,
// setSeatLook, setAnchorWant, setReach).
//
// Getting on: with no approach and no enter clip the body eases onto the seat (0.35 s). An `approach` point (socket
// frame) brings it there first, walking; an `enter` clip then plays with its time locked to the carry, so the clip's
// own motion lands on the seat (motion warping, Unreal's name for it, done as a time-lock rather than root motion).

import { THREE } from './core.js';
import { avatarMounts, mountTransform, bagOf, entities, findPart, seatSocket } from './world.js';
import { bodyOf, evalPose, choosePose, reachWins } from '../../shared/sockbody.js';
import { socketSignals } from './socksignals.js';
import { xrHandWorld } from './xrbody.js';

const D2R = Math.PI / 180;
// a neck turns about this far whatever a socket allows (the socket's look narrows it, never widens it)
const NECK = { yaw: [-110, 110], pitch: [-60, 70] };
const EASE_ON = 0.35, WALK = 1.4, ENTER_WAIT = 2;
const smooth = (u) => u * u * (3 - 2 * u);
const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));

const _p = new THREE.Vector3(), _a = new THREE.Vector3(), _q = new THREE.Quaternion(), _qa = new THREE.Quaternion();
const _m = new THREE.Matrix4(), _mv = new THREE.Vector3(), _mq = new THREE.Quaternion();

/** The pose choices that bear on one occupant: their own, and (in a sync group) every occupant's of the same thing
 *  whose socket shares the group — all from presence, so every client gathers the same list. */
export function occupyChoices(riderId, m, body) {
  if (!body?.sync) return m?.pose ? [{ name: m.pose, at: m.at ?? 0 }] : [];
  const host = seatSocket(m.to)?.host;
  const out = [];
  for (const [id, o] of avatarMounts) {
    if (!o.pose) continue;
    const s = o.to === m.to ? null : seatSocket(o.to);   // another seat on the same thing, in the same group
    if (id !== riderId && (!s || s.host !== host || bodyOf(s.station)?.sync !== body.sync)) continue;
    out.push({ name: o.pose, at: o.at ?? 0 });
  }
  return out;
}

/** A point given in a thing's frame, live in the world: through the thing's transform and, when it names a part, that
 *  part's displacement from rest (the same rule a socket's pos follows). Also carries a rotation when `q` is given. */
function thingPoint(id, at, part, out, qIn = null, qOut = null) {
  const obj = entities.get(id);
  if (!obj) return null;
  obj.updateWorldMatrix(true, false);
  out.set(at[0], at[1], at[2]).applyMatrix4(obj.matrixWorld);
  if (qOut) obj.getWorldQuaternion(qOut).multiply(_mq.fromArray(qIn ?? [0, 0, 0, 1]));
  const p = part ? findPart(obj, part) : null;
  if (p && p.parent && p.userData.mbase) {
    const b = p.userData.mbase;
    p.updateWorldMatrix(true, false);
    _m.compose(_mv.fromArray(b.pos), _mq.fromArray(b.quat), p.scale).premultiply(p.parent.matrixWorld);
    if (qOut) { const rest = new THREE.Quaternion(); _m.decompose(_mv, rest, new THREE.Vector3()); p.getWorldQuaternion(_mq); qOut.premultiply(rest.invert()).premultiply(_mq); }
    out.applyMatrix4(_m.invert()).applyMatrix4(p.matrixWorld);
  }
  return out;
}

/** Drive one seated body for one frame. Returns {pos, q, yaw, clip, sw, signals, stage} — the root's world pose to set,
 *  the clip name presence should carry, and how far into getting on it is — or null when it isn't seated (or its seat
 *  isn't live yet: the thing is still loading). `xr` is a remote occupant's tracked-hands sample (presence `xr`); the
 *  local occupant's hands are read from the headset. */
export function driveOccupied(av, riderId, { dt, nowMs, path = null, local = false, xr = null }) {
  const m = avatarMounts.get(riderId);
  if (!m || !av) return null;
  const seat = seatSocket(m.to);   // m.to is the socket; what it hangs on carries the motion, the reach and exit frames
  const sock = seat?.sock;
  const body = bodyOf(seat?.station);
  if (!body || seat.host == null) return null;
  const comp = bagOf(seat.host);
  const obj = entities.get(seat.host);
  const base = obj?.userData?.base ?? (obj ? { pos: obj.position.toArray(), yaw: obj.rotation.y } : null);
  // the occupant's input counts only where the socket routes it: movement (throttle/steer) when input.move takes the
  // keys, the look (aimYaw/aimPitch) unless the view is locked — the same filter on every client
  const inp = m.in ? { ...(body.input.move !== 'none' ? { throttle: m.in.throttle, steer: m.in.steer } : {}), ...(body.input.look !== 'locked' ? { aimYaw: m.in.aimYaw, aimPitch: m.in.aimPitch } : {}) } : null;
  const signals = socketSignals({ comp, sock, base, nowMs, input: inp });
  const chosen = choosePose(body, occupyChoices(riderId, m, body));
  const ev = evalPose(chosen.spec, signals);
  const sw = mountTransform(riderId, _p, { path, av }, ev.offset);
  if (!sw) return null;

  // ---- getting on (the transition starts the first frame this client sees the body on this seat)
  const key = m.to;
  let st = av._seatState;
  if (!st || st.key !== key) {
    if (st) releaseLimbs(av, st);
    av.root.updateMatrixWorld();
    st = av._seatState = { key, t0: nowMs, from: av.root.position.clone(), fromQ: av.root.quaternion.clone(), reach: new Set(), sig: '' };
    if (body.approach) {
      const ap = body.approach;
      st.A = new THREE.Vector3(ap[0], ap[1], ap[2]).applyQuaternion(_q.fromArray(sw.socketQ)).add(_a.fromArray(sw.socketPos));
      const f = new THREE.Vector3(0, 0, 1).applyQuaternion(_q.fromArray(sw.socketQ).multiply(_qa.setFromAxisAngle(new THREE.Vector3(0, 1, 0), ap[3])));
      st.AQ = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.atan2(f.x, f.z));   // standing upright there
      const d = st.from.distanceTo(st.A);
      st.da = d < 0.05 ? 0 : Math.min(4, d / WALK);
    } else st.da = 0;
    // a body first seen already far from its seat (a late joiner's view of someone seated, a body still loading at the
    // origin) is simply there: a glide across the world would be a lie about how they got on
    st.instant = st.from.distanceTo(_p) > 6;
  }
  // the socket's data changed under the sitter (an edit, a script): re-read hold and reach
  const sig = JSON.stringify(sock);
  if (st.sig !== sig) { st.sig = sig; releaseLimbs(av, st); av.setSeatHold(body.hold); }

  st.now = nowMs;   // the clock this frame's pose was read at (a probe compares the closed forms at exactly this time)
  // the enter and leave clips load as soon as the body heads for the seat; the enter waits for its clip (up to
  // ENTER_WAIT s at the approach point), so the carry and the clip start together
  const enterAction = body.enter ? av.ensureClip(body.enter) : null;
  if (body.leave) av.ensureClip(body.leave);
  const de = st.de = body.enter ? (enterAction ? enterAction.getClip().duration : 1.2) : EASE_ON;
  const t = st.instant ? Infinity : Math.max(0, (nowMs - st.t0) / 1000);
  if (st.enterAt == null && t >= st.da && (!body.enter || enterAction || t - st.da > ENTER_WAIT)) st.enterAt = Number.isFinite(t) ? t : 0;
  const pos = new THREE.Vector3(), q = new THREE.Quaternion();
  let stage = 'seated';
  if (t < st.da || st.enterAt == null) {
    const u = st.da ? smooth(Math.min(1, t / st.da)) : 1;
    pos.copy(st.from).lerp(st.A ?? st.from, u); q.copy(st.fromQ).slerp(st.AQ ?? st.fromQ, u);
    av.setSeatBlend([[t < st.da ? 'walk' : 'idle', 1]]);
    stage = 'approach';
  } else if (t < st.enterAt + de) {
    const u = (t - st.enterAt) / de;
    pos.copy(st.A ?? st.from).lerp(_p, smooth(u)); q.copy(st.AQ ?? st.fromQ).slerp(_q.fromArray(sw.q), smooth(u));
    if (body.enter) av.setSeatBlend([[body.enter, 1]], u); else av.setSeatBlend(ev.clips, ev.time === 'phase' ? signals.phase : null);
    stage = 'enter';
  } else {
    pos.copy(_p); q.fromArray(sw.q);
    av.setSeatBlend(ev.clips, ev.time === 'phase' ? signals.phase : null);
  }
  st.stage = stage;
  av.postureSlot = body.clip;   // the plate reads posture from it (seated plates hang lower)

  // ---- the head: where the occupant looks (their aim, from presence), within the socket's limits and a neck's
  const aim = m.in;
  if (body.input.look === 'locked') av.setSeatLook({ yaw: 0, pitch: 0 });
  else if (aim && Number.isFinite(aim.aimYaw)) {
    const lim = (r, n) => [Math.max(r[0], n[0]) * D2R, Math.min(r[1], n[1]) * D2R];
    const [y0, y1] = lim(body.look.yaw, NECK.yaw), [p0, p1] = lim(body.look.pitch, NECK.pitch);
    av.setSeatLook({ yaw: Math.min(y1, Math.max(y0, wrap(aim.aimYaw))), pitch: Math.min(p1, Math.max(p0, aim.aimPitch ?? 0)) });
  } else av.setSeatLook(null);

  // ---- the limbs: IK targets in the thing's frame (or riding a part), with the VR hand policy
  av._seatArms ??= {};
  for (const [limb, r] of Object.entries(body.reach)) {
    const side = limb === 'leftHand' ? 'left' : limb === 'rightHand' ? 'right' : null;
    const target = thingPoint(seat.host, r.at, r.part, new THREE.Vector3());
    if (!target) continue;
    let hand = null;
    if (side && local) hand = xrHandWorld(side, new THREE.Vector3())?.toArray() ?? null;
    else if (side && xr && Array.isArray(xr[side[0]]) && xr[side[0]].length === 7) {
      const g = xr[side[0]]; av.root.getWorldQuaternion(_mq); av.root.getWorldPosition(_mv);
      hand = new THREE.Vector3(g[0], g[1], g[2]).applyQuaternion(_mq).add(_mv).toArray();
    }
    const wins = reachWins(r.vr, hand, target.toArray());
    if (side) av._seatArms[side] = !!hand && wins;
    const cur = av._reach?.get(limb);
    if (!wins) { if (cur?.owner === 'seat') { av.clearReach(limb); st.reach.delete(limb); } continue; }
    if (cur && cur.owner !== 'seat' && cur.wantWeight > 0) continue;   // the person's own reach outranks the seat's
    if (!cur || cur.wantWeight === 0 || !st.reach.has(limb)) {
      const to = seat.host, at = r.at, part = r.part, rq = r.q, hint = r.hint;
      const tq = new THREE.Quaternion(), tp = new THREE.Vector3(), hp = new THREE.Vector3();
      av.setReach(limb, () => {
        if (!thingPoint(to, at, part, tp, rq, rq ? tq : null)) return null;
        // q: the hand's frame; the palm faces its -Y, so the surface it rests on faces +Y
        return rq ? { pos: tp.toArray(), normal: new THREE.Vector3(0, 1, 0).applyQuaternion(tq).toArray() } : tp.toArray();
      }, { owner: 'seat', palm: !!rq, hint: hint ? () => thingPoint(to, hint, part, hp)?.toArray() ?? null : null });
      st.reach.add(limb);
    }
  }
  for (const limb of [...st.reach]) if (!body.reach[limb]) { if (av._reach?.get(limb)?.owner === 'seat') av.clearReach(limb); st.reach.delete(limb); }

  const f = new THREE.Vector3(0, 0, 1).applyQuaternion(q);
  return { pos, q, yaw: Math.atan2(f.x, f.z), clip: stage === 'enter' && body.enter ? body.enter : body.clip, sw, body, signals, stage, pose: chosen.name, eval: ev };
}

function releaseLimbs(av, st) {
  for (const limb of st.reach) if (av._reach?.get(limb)?.owner === 'seat') av.clearReach(limb);
  st.reach.clear();
  av._seatArms = null;
}

/** Everything a seat put on a body, let go: the pose layer, held bones, the head's turn, the hands, the anchor. */
export function releaseOccupied(av) {
  if (!av) return;
  const st = av._seatState;
  if (st) releaseLimbs(av, st);
  av._seatState = null; av._seatArms = null;
  av.setSeatBlend?.(null); av.setSeatHold?.(null); av.setSeatLook?.(null); av.setAnchorWant?.(null);
}
