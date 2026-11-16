// remotes — everyone else's bodies. Presence is lossy and arrives at ~15 Hz; each body is drawn where it was
// INTERP_MS or more ago (interpdelay.js), between the two samples that bracket that moment; only a lone sample snaps (applyImmediate).

import { THREE, camera, scene } from '../core.js';
import { report, angleDelta, CONFIG } from '../base.js';
import { makeAvatar, makeCapsuleAvatar } from '../avatar/avatar.js';
import { onceAnimOf } from '../../../shared/onceanim.js';
import { avatarMounts, setBodySeat } from '../world.js';
import { driveOccupied, releaseOccupied } from '../avatar/occupybody.js';
import { declareOccupyState, clearOccupyState } from './occupants.js';
import { applyRemoteReach, noteReachEvents } from './reachnet.js';
import { syncClipPhase } from '../avatar/poseclips.js';
import { applyWingFoldPresence } from '../../../shared/wingpresence.js';
import { poseChannels, setOwn } from '../../../shared/humanoid.js';
import { applyPresenceWire, applyVoiceWire, applyBodyWire, sampleTime } from '../../../shared/presencewire.js';
import { applyRemoteXR, resetFingers } from '../xr/xrbody.js';

export const remotes = new Map(); // id -> RemoteBody

// ?capsule=1: every remote arrives as the capsule too
const loadBody = (id, path) => CONFIG.params.has('capsule') ? Promise.reject(new Error('?capsule=1: body loads refused')) : makeAvatar(id, path);
// how far behind serverNow() each body is drawn: at least 110 ms, more on a slow link (interpdelay.js)
import { noteLateness, interpDelay } from './interpdelay.js';
const BUF_MAX = 12;

// the server clock (serverclock.js), re-exported where net.js and the body code find it
export { noteServerTime, serverNow } from '../serverclock.js';
import { serverNow } from '../serverclock.js';   // a re-export binds no local name
import { climbAt } from './climb.js';
import { DEFAULT_BODY } from '../../../shared/avatardefs.js';

/** Per-identity generation counter, bumped by every authoritative (re)creation; async continuations compare
 *  record identity before touching the scene, so a departed generation cannot delete or repopulate its successor. */
const gens = new Map();

/** The capsule is a floor, not a verdict: a record wearing it carries `capsuleFor`, the path it still owes, and
 *  retryBody pays that debt (RETRY_MAX attempts with backoff, guarded by record identity).
 *  test/client/capsule-recovery-test.mjs */
const RETRY_MAX = 3;
// mutable so a test can shrink it, or run the timers on its own clock (capsule-recovery-test)
let RETRY_BACKOFF_MS = [400, 1600, 5000], retryTimer = (fn, ms) => setTimeout(fn, ms);
export function __setRetryBackoffForTest(ms, timer = retryTimer) { RETRY_BACKOFF_MS = ms; retryTimer = timer; }
function retryBody(r) {
  if (!r?.capsuleFor || r.retrying) return;
  const id = r.id, path = r.capsuleFor;
  const n = r.retries ?? 0;
  if (n >= RETRY_MAX) return;
  r.retrying = true;
  r.retries = n + 1;
  retryTimer(async () => {
    if (remotes.get(id) !== r) return;            // superseded while we waited: not ours to pay
    try {
      const av = await loadBody(id, path);
      if (remotes.get(id) !== r) { av.dispose(); return; }   // superseded while loading
      r.avatar?.dispose();                        // the capsule steps down
      r.avatar = av;
      r.capsuleFor = null;
      r.retries = 0;
      if (r.buf.length) applyImmediate(r);
    } catch (e) {
      report(`avatar ${id} retry`, e);            // still down; the capsule stays, the debt stands
    } finally {
      if (remotes.get(id) === r) r.retrying = false;
    }
  }, RETRY_BACKOFF_MS[Math.min(n, RETRY_BACKOFF_MS.length - 1)]);
}

export async function ensureRemote(id, avatarPath, meta = {}) {
  const existing = remotes.get(id);
  if (existing) {
    if (meta.declares !== undefined) existing.declares = meta.declares;   // the word they declared at the door (§6a), or null
    // same person, new body: rebuild (a switch mid-load deletes the entry and the stale load's guard disposes it;
    // dispose returns the VRM to the instance pool, so a switch back skips the re-parse)
    if (avatarPath && existing.avatarPath !== avatarPath) {
      remotes.delete(id);
      existing.avatar?.dispose();
    } else {
      // same body re-announced by the authority = a takeover: a FRESH record (every continuation guard compares
      // record identity); the loaded avatar transplants, the pose buffer stays on the orphan
      if (meta.authority) {
        // the mesh transplants; its expressions (typing, bubble, held pose, limp, gaze) were the predecessor's
        existing.avatar?.resetTransients?.();
        const fresh = {
          id, avatar: existing.avatar, avatarPath: existing.avatarPath,
          loading: false, declares: meta.declares ?? existing.declares ?? null,
          gen: (gens.get(id) ?? 0) + 1,
          buf: [], lastClip: 'idle', lodAcc: 0, lodTick: 0, speakingUntil: 0,
        };
        // a capsule's debt and attempt count transplant too, or a flapping peer re-arms at the shortest backoff forever
        fresh.capsuleFor = existing.capsuleFor ?? null;
        fresh.retries = existing.retries ?? 0;
        gens.set(id, fresh.gen);
        remotes.set(id, fresh);
        if (fresh.avatar && fresh.capsuleFor) retryBody(fresh);
        // predecessor still mid-load: its completion disposes (not its record); the successor starts its own load
        if (!fresh.avatar) {
          fresh.loading = true;
          try {
            const av = await loadBody(id, fresh.avatarPath || DEFAULT_BODY).catch((e) => { report(`avatar ${id}`, e); fresh.capsuleFor = fresh.avatarPath || DEFAULT_BODY; return makeCapsuleAvatar(id); });   // the capsule floor
            if (remotes.get(id) !== fresh) { av.dispose(); return fresh; }
            fresh.avatar = av;
            if (fresh.buf.length) applyImmediate(fresh);
          } catch (e) { report(`avatar ${id}`, e); }
          fresh.loading = false;
        }
        return fresh;
      }
      // same body, no authority change: nothing to rebuild, but a capsule still owes a body
      if (existing.capsuleFor) retryBody(existing);
      return existing;
    }
  }
  const r = {
    id, avatar: null, avatarPath, loading: true, declares: meta.declares ?? null,
    gen: (gens.get(id) ?? 0) + 1,
    buf: [],                 // [{ t, p:[x,y,z], yaw, speed, clip, pitch }]
    lastClip: 'idle',
    lodAcc: 0, lodTick: 0,
    speakingUntil: 0,
  };
  gens.set(id, r.gen);
  remotes.set(id, r);
  try {
    r.avatar = await loadBody(id, avatarPath || DEFAULT_BODY).catch((e) => { report(`avatar ${id}`, e); r.capsuleFor = avatarPath || DEFAULT_BODY; return makeCapsuleAvatar(id); });   // the capsule floor
    // stale-load guard: they left or switched bodies while this loaded (record identity, not key presence)
    if (remotes.get(id) !== r) { r.avatar.dispose(); return r; }
    if (r.buf.length) applyImmediate(r);
  } catch (e) { report(`avatar ${id}`, e); }
  r.loading = false;
  return r;
}

/** Remove a body. Idempotent; with `expected`, only if that record still owns the id, so a predecessor's late
 *  cleanup cannot delete the successor. Returns the dropped record, or null. */
export function dropRemote(id, expected) {
  const r = remotes.get(id);
  if (!r) return null;
  if (expected && r !== expected) return null;   // a successor owns this id now
  remotes.delete(id);
  r.avatar?.dispose();
  setBodySeat(id, null);   // its seat rode its frames: gone with the body
  return r;
}

/** Feed one presence sample. `t` is the server stamp when available. */
export function pushPose(id, pose, t) {
  const r = remotes.get(id);
  if (!r || !pose) return;
  // the sender's capture time when stamped and sane, else the frame's (shared/presencewire.js sampleTime)
  const stamp = sampleTime(pose, typeof t === 'number' ? t : serverNow());
  const last = r.buf[r.buf.length - 1];
  if (last && stamp <= last.t) return;    // out of order — drop
  r.late = noteLateness(r.late ?? null, serverNow() - stamp);
  r.buf.push({ ...pose, t: stamp });
  setBodySeat(id, pose.seat ?? null);   // a seat rides the frame while it holds (presence; world.js)
  while (r.buf.length > BUF_MAX) r.buf.shift();
  // reach/touch events ride the raw stream: a touch while this body's avatar is still loading must be heard
  noteReachEvents(r, pose);
}

function applyImmediate(r) {
  const s = r.buf[r.buf.length - 1];
  if (!r.avatar || !s) return;
  r.avatar.root.position.set(...s.p);
  if (s.q) r.avatar.root.quaternion.fromArray(s.q).normalize();   // a swimmer's whole-body turn (presence q)
  else r.avatar.root.rotation.set(0, s.yaw ?? 0, 0);
  r.avatar.locomotion = s.locomotion ?? null;
}

// bone blending scratch: per bone, per remote, per frame, so nothing here may allocate
const _up = new THREE.Vector3(0,1,0);
const _qa = new THREE.Quaternion(), _qb = new THREE.Quaternion(), _qk = new THREE.Quaternion();
/** Marks "the bones are mid-blend": non-null so a release still clears, never `===` a sample's pose. */
const POSE_BLEND = {};

/** The held pose (bones), blended a→b by the same k as the root. Change detection is pose-object identity. */
function applyPose(r, a, b, k) {
  const pa = a.pose, pb = b.pose;
  if (!pb) {                            // nobody is posed, or just released
    if (r.lastPose != null) { r.lastPose = null; r.avatar.clearPose(); }
    return;
  }
  if (!pa || pa === pb) {               // fading in, or the single-sample hold
    if (r.lastPose !== pb) { r.lastPose = pb; r.avatar.setPose(pb); }
    return;
  }
  // re-plan per bracketing pair (~15 Hz), not per frame
  if (r.poseA !== pa || r.poseB !== pb) planPoseBlend(r, pa, pb);
  for (const s of r.poseSlots) {
    if (s.a) { _qa.fromArray(s.a); _qb.fromArray(s.b); _qk.slerpQuaternions(_qa, _qb, k).toArray(s.q); }
    if (s.ta) for (let i = 0; i < 3; i++) s.t[i] = s.ta[i] + (s.tb[i] - s.ta[i]) * k;
    if (s.sa) for (let i = 0; i < 3; i++) s.s[i] = s.sa[i] + (s.sb[i] - s.sa[i]) * k;
  }
  r.lastPose = POSE_BLEND;
  r.avatar.setPose(r.poseOut);
}

// a tracked (VR) body's head + hands: rides presence as `xr` (xrbody.js), blended a→b like the root and re-solved
// in the avatar's pre-vrm.update hook; no sample → hook off, the clip owns the bones
const _xq1 = new THREE.Quaternion(), _xq2 = new THREE.Quaternion(), _xv1 = new THREE.Vector3(), _xv2 = new THREE.Vector3();
const blendQ = (qa, qb, k) => { _xq1.fromArray(qa); _xq2.fromArray(qb); return _xq1.slerp(_xq2, k).toArray(); };
const blendGrip = (ga, gb, k) => {
  if (!ga || !gb) return gb || ga;
  _xv1.fromArray(ga); _xv2.fromArray(gb); _xv1.lerp(_xv2, k);
  return [..._xv1.toArray(), ...blendQ(ga.slice(3), gb.slice(3), k)];
};
function blendXR(xa, xb, k) {
  if (!xa || xa === xb || k >= 1) return xb;
  const o = { h: blendQ(xa.h, xb.h, k), c: xb.c && xa.c ? xb.c.map((v, i) => xa.c[i] + (v - xa.c[i]) * k) : xb.c };
  const l = blendGrip(xa.l, xb.l, k), r = blendGrip(xa.r, xb.r, k);
  if (l) o.l = l; if (r) o.r = r;
  return o;
}
function applyXRPresence(r, a, b, k) {
  const xb = b?.xr;
  if (!xb) {
    if (r.xrOn) { r.xrOn = false; if (r.xrHookAv) { r.xrHookAv.onBeforeVrmUpdate = null; resetFingers(r.xrHookAv.vrm); } r.xrHookAv = null; }   // their last sample was a trigger pull: fingers back to the clip
    return;
  }
  r.xrOn = true;
  r.xrSample = blendXR(a?.xr, xb, k);
  if (r.xrHookAv !== r.avatar || r.avatar.onBeforeVrmUpdate !== r.xrHook) {   // fresh avatar (swap) or first sample
    r.xrState = r.xrState || { look: new THREE.Vector3() };
    r.xrHook = (dt) => applyRemoteXR(r.avatar, r.xrSample, r.xrState, dt);
    r.xrHookAv = r.avatar; r.avatar.onBeforeVrmUpdate = r.xrHook;
  }
}

/** Merged bone list for one pair, with the output arrays setPose will read. A bone or channel on only one side
 *  is held, not blended from rest: senders drop bones they aren't driving. */
function planPoseBlend(r, pa, pb) {
  r.poseA = pa; r.poseB = pb;
  r.poseSlots = []; r.poseOut = {};
  // per channel (shared/humanoid.js poseChannels): rotation slerps, translation and scale lerp
  for (const n of new Set([...Object.keys(pa), ...Object.keys(pb)])) {
    const ca = poseChannels(pa[n]), cb = poseChannels(pb[n]);
    if (!ca && !cb) continue;
    const pick = (ch) => { const x = ca?.[ch] ?? cb?.[ch], y = cb?.[ch] ?? ca?.[ch]; return x ? [x, y] : [null, null]; };
    const [qa, qb] = pick('q'), [ta, tb] = pick('t'), [sa, sb] = pick('s');
    const slot = { a: qa, b: qb, q: qa && [0, 0, 0, 1], ta, tb, t: ta && [0, 0, 0], sa, sb, s: sa && [1, 1, 1] };
    r.poseSlots.push(slot);
    setOwn(r.poseOut, n, !ta && !sa ? slot.q : { ...(qa ? { q: slot.q } : {}), ...(ta ? { t: slot.t } : {}), ...(sa ? { s: slot.s } : {}) });
  }
}

/** A remote's chosen size and plate lift (shared/presencewire.js bodyWire), written every sample so a body swap picks
 *  it up at once. Exported for test/client/bodyscale-test.ts. */
export function applyRemoteBody(r, s) {
  applyBodyWire(r, s);
  r.avatar?.setUserScale?.(r.scale);
  r.avatar?.setPlateY?.(r.plateY);
}

/** Presence extras that aren't position or bones (once anim, clip, presence, voice, size, reach): driven by the
 *  newer sample, never blended. */
function applyPresenceExtras(r, s) {
  applyWingFoldPresence(r.avatar, s);
  applyPresenceWire(r, s);            // present / away / busy, for the Who panel
  applyVoiceWire(r, s);              // mic / hear, for the hover card
  applyRemoteBody(r, s);             // their chosen size / plate lift (absence = default)
  const clip = s.clip ?? 'idle';
  const once = onceAnimOf(s);
  if (once && once !== r.lastAnim) {
    r.lastAnim = once;
    r.avatar.playOnce(once);
  } else {
    // the once anim has passed: forget it, so the SAME one can fire again
    if (!once) r.lastAnim = null;
    if (clip !== r.lastClip) r.lastClip = clip;
    // 'ragdoll' is not a clip: the streamed pose owns the bones while down
    if (clip === 'ragdoll') r.avatar.setLimp(true);
    else {
      r.avatar.setLimp(false); r.avatar.setClip(clip, s.speed ?? 0);
      // each phase sample is applied once, so the clip keeps advancing between packets
      syncClipPhase(r.avatar, s, r.clipPhaseStamp ??= {});
    }
  }
  // edge-triggered inside, so per-frame reapplication costs nothing when idle
  applyRemoteReach(r, s);
}

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();

// animation LOD: position interpolates every frame; skeletal updates tick every 1/2/4 frames by distance with
// accumulated dt, so a far avatar animates at lower temporal resolution, not in slow motion
const LOD_NEAR = 8, LOD_MID = 20;
export let lodBias = 1;                 // raised by the perf governor under load
export function setLodBias(v) { lodBias = v; }

// bodies whose sim runs on THIS machine (bodydrag takeover): inbound presence is our own echo, the local sim owns them
export const draggedLocal = new Set();

const _eye = new THREE.Vector3();
export function updateRemotes(dt, now = performance.now()) {
  const now0 = serverNow();
  // animation LOD by distance from the camera's WORLD position (in XR camera.position is the head's offset inside the rig)
  const eye = camera.getWorldPosition(_eye);

  for (const r of remotes.values()) {
    if (!r.avatar) continue;
    if (draggedLocal.has(r.id)) { r.avatar.update(dt, now); continue; }
    const buf = r.buf;
    const renderAt = now0 - interpDelay(r.late ?? null);

    // a mounted body is derived from its parent's live transform and socket, not streamed: an occupant rides the swing
    if (avatarMounts.has(r.id)) {
      const s0 = buf[buf.length - 1];
      // the same driver my own seat runs (occupybody.js), so an occupant looks the same on every screen
      const seated = driveOccupied(r.avatar, r.id, { dt, nowMs: serverNow(), path: r.avatarPath, xr: s0?.xr ?? null });
      const sw = seated?.sw;
      if (sw) {
        r.avatar.root.position.copy(seated.pos);
        r.avatar.root.quaternion.copy(seated.q);   // the socket's whole rotation
        r.avatar.locomotion = null;
        // declared seat state: the ≈ marker and one console line per transition
        r.avatar.setSeatApprox(sw.seatState === 'approximate');
        declareOccupyState(r.id, sw.host ?? sw.to, sw.slot, sw.seatState, sw.seatReason);
        // the seat owns root and base clip, not expressiveness: the newest sample still delivers gestures and held poses
        const s = buf[buf.length - 1];
        if (s) {
          applyPose(r, s, s, 1);
          applyWingFoldPresence(r.avatar, s);   // a seated vigil still folds
          applyPresenceWire(r, s);
          applyVoiceWire(r, s);
          applyRemoteBody(r, s);
          const once = onceAnimOf(s);
          if (once && once !== r.lastAnim) {
            r.lastAnim = once;
            r.avatar.playOnce(once);
          } else if (!once) r.lastAnim = null;
          applyRemoteReach(r, s);   // a seated body still puts a hand out
          applyXRPresence(r, s, s, 1);   // …and still looks around / points
        }
        r.avatar.setLimp(false);
        r.lastClip = seated.clip;   // the seat's pose layer owns the base clips (avatar.setSeatBlend); gestures still play over it
        const d = r.avatar.root.position.distanceTo(eye);
        const every = Math.round((d < LOD_NEAR ? 1 : d < LOD_MID ? 2 : 4) * lodBias);
        r.lodAcc += dt;
        r.lodTick = (r.lodTick + 1) % Math.max(1, every);
        if (r.lodTick === 0) { r.avatar.update(r.lodAcc, now); r.lodAcc = 0; }
        continue;
      }
      // parent still downloading — fall through to normal presence meanwhile
    } else {
      if (r.avatar._seatState) releaseOccupied(r.avatar);   // stood up: the seat lets go of the body
      if (r.avatar._seatApprox) {
        // stood up: the marker comes off and the next sit declares afresh
        r.avatar.setSeatApprox(false);
        clearOccupyState(r.id);
      }
    }

    if (buf.length >= 2) {
      // find the pair bracketing renderAt
      let i = buf.length - 1;
      while (i > 0 && buf[i - 1].t > renderAt) i--;
      const b = buf[i], a = buf[i - 1] ?? b;
      const span = b.t - a.t;
      const limpEdge = (a.clip === 'ragdoll') !== (b.clip === 'ragdoll');
      const k = span > 0 && !limpEdge ? THREE.MathUtils.clamp((renderAt - a.t) / span, 0, 1) : 1;

      _a.set(...a.p); _b.set(...b.p);
      r.avatar.root.position.copy(_a).lerp(_b, k);
      if (a.q || b.q) {   // a swimmer's whole-body turn (presence q): slerped, so a dive tilts as smoothly as a turn
        if (a.q) _qa.fromArray(a.q).normalize(); else _qa.setFromAxisAngle(_up, a.yaw ?? 0);
        if (b.q) _qb.fromArray(b.q).normalize(); else _qb.setFromAxisAngle(_up, b.yaw ?? 0);
        r.avatar.root.quaternion.copy(_qa).slerp(_qb, k);
      } else r.avatar.root.rotation.set(0, (a.yaw ?? 0) + angleDelta(a.yaw ?? 0, b.yaw ?? a.yaw ?? 0) * k, 0);   // upright (a dismount from a tilted seat)
      // on a climb route: {host, progress} through the host's live pose, so a moving carrier never leaves its climber (shared/climb.js)
      if (b.climb) { const c = climbAt(a.climb?.host === b.climb.host ? { host: b.climb.host, progress: a.climb.progress + (b.climb.progress - a.climb.progress) * k } : b.climb);
        if (c) { r.avatar.root.position.fromArray(c.pos); r.avatar.root.rotation.set(0, c.yaw, 0); } }
      r.avatar.locomotion = b.locomotion ?? null;
      r.avatar.pitch = (a.pitch ?? 0) + ((b.pitch ?? 0) - (a.pitch ?? 0)) * k;
      // drop samples we've moved past, but always keep one behind renderAt
      while (buf.length > 2 && buf[1].t < renderAt - 400) buf.shift();
      applyPose(r, limpEdge ? b : a, b, k);
      applyXRPresence(r, a, b, k);
      applyPresenceExtras(r, b);
    } else if (buf.length === 1) {
      applyImmediate(r);
      // a late joiner's single snapshot pose must still apply its held bones (a fallen body would otherwise stand)
      applyPose(r, buf[0], buf[0], 1);
      applyXRPresence(r, buf[0], buf[0], 1);
      applyPresenceExtras(r, buf[0]);
    }

    const d = r.avatar.root.position.distanceTo(eye);
    const every = Math.round((d < LOD_NEAR ? 1 : d < LOD_MID ? 2 : 4) * lodBias);
    r.lodAcc += dt;
    r.lodTick = (r.lodTick + 1) % Math.max(1, every);
    if (r.lodTick === 0) { r.avatar.update(r.lodAcc, now); r.lodAcc = 0; }
  }
}

/** Mark someone as currently speaking, so other bodies turn to look at them. */
export function noteSpeaking(id, ms = 4000) {
  const r = remotes.get(id);
  if (r) r.speakingUntil = performance.now() + ms;
}

/** Point every body at whatever deserves attention: the most recent speaker if
 *  there is one, otherwise the nearest other body (the VRM lookAt rig). */
let _gazeAt = 0;
export function updateGaze(myPos, myAvatar, myName, now = performance.now()) {
  // attention changes at conversational rate (4 Hz); the VRM lookAt rig eases the turn itself
  if (now - _gazeAt < 250) return;
  _gazeAt = now;
  let speaker = null;
  for (const r of remotes.values()) {
    if (r.speakingUntil > now && r.avatar) {
      if (!speaker || r.speakingUntil > speaker.speakingUntil) speaker = r;
    }
  }

  const focusOf = (self) => {
    if (speaker && speaker !== self) {
      return _a.copy(speaker.avatar.root.position).setY(speaker.avatar.root.position.y + 1.5);
    }
    // nearest other body, including me
    let best = null, bestD = 9;
    const from = self ? self.avatar.root.position : myPos;
    if (self && myPos) {
      const d = from.distanceTo(myPos);
      if (d < bestD) { bestD = d; best = _a.copy(myPos).setY(myPos.y + 1.5); }
    }
    for (const o of remotes.values()) {
      if (o === self || !o.avatar) continue;
      const d = from.distanceTo(o.avatar.root.position);
      if (d < bestD) { bestD = d; best = _a.copy(o.avatar.root.position).setY(o.avatar.root.position.y + 1.5); }
    }
    return best;
  };

  for (const r of remotes.values()) {
    if (!r.avatar) continue;
    r.avatar.setGazeTarget(focusOf(r));
  }
  if (myAvatar) {
    const f = speaker ? _b.copy(speaker.avatar.root.position).setY(speaker.avatar.root.position.y + 1.5) : null;
    myAvatar.setGazeTarget(f);
  }
}
