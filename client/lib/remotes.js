// remotes — everyone else's bodies.
//
// Presence is lossy and arrives at ~15Hz. Rendering it means answering "where
// was this body 100ms ago, between the two samples that bracket that moment" —
// not "snap to the newest thing that arrived". The old client lerped toward
// the latest sample with an exponential factor, which stutters under jitter and
// freezes-then-teleports under loss.

import { THREE, camera, scene, report, angleDelta } from './core.js';
import { makeAvatar } from './avatar.js';
import { avatarMounts, mountTransform } from './world.js';
import { declareSeatState, clearSeatState } from './seats.js';
import { applyRemoteReach, noteReachEvents } from './reachnet.js';

export const remotes = new Map(); // id -> RemoteBody

const DEFAULT_AVATAR = 'eidoverse/assets/vrms/claude.vrm';
/** How far behind the newest sample we render. One frame of slack at 15Hz is
 *  66ms; 110 gives room for one dropped packet without a visible stall. */
const INTERP_MS = 110;
const BUF_MAX = 12;

// Server-to-local clock offset, smoothed. Frames carry the server's `t`.
let clockOffset = null;
export function noteServerTime(t) {
  if (typeof t !== 'number') return;
  const sample = t - performance.timeOrigin - performance.now();
  clockOffset = clockOffset === null ? sample : clockOffset * 0.92 + sample * 0.08;
}
export const serverNow = () => performance.timeOrigin + performance.now() + (clockOffset ?? 0);

/** Per-identity generation counter (#95): every AUTHORITATIVE (re)creation
 *  of an id bumps it, and async continuations validate record identity
 *  before touching the scene — a departed generation can neither delete
 *  nor repopulate its successor. Session-lifetime, monotonic. */
const gens = new Map();
export const remoteGen = (id) => gens.get(id) ?? 0;

export async function ensureRemote(id, avatarPath, meta = {}) {
  const existing = remotes.get(id);
  if (existing) {
    if (meta.agent !== undefined) existing.agent = meta.agent;
    // same person, new body: rebuild (live avatar switching re-announces via
    // join). A switch that lands while the OLD body is still loading must not
    // be dropped — delete the map entry and let the stale load's own guard
    // dispose it when it completes. This dispose is the §19b release point:
    // the old VRM returns to the instance pool intact, so a switch back —
    // or anyone else arriving in this body — skips the re-parse.
    if (avatarPath && existing.avatarPath !== avatarPath) {
      remotes.delete(id);
      existing.avatar?.dispose();
    } else {
      // Same body re-announced = a TAKEOVER (the server suppresses the old
      // connection's leave and re-arrives the identity — server.ts ~2023).
      // The successor must be a FRESH RECORD OBJECT, not the predecessor's
      // with fields wiped: every continuation guard in this file compares
      // record identity, and a reused object makes a predecessor's captured
      // reference pass as current (#97 review B2). The loaded avatar itself
      // transplants — same mesh, no flicker, single ownership moves to the
      // successor — while streamed state (the pose buffer) stays behind on
      // the orphaned record, uninherited (#95 acceptance 4).
      if (meta.authority) {
        // the mesh transplants; its EXPRESSIONS do not — typing, bubble,
        // held pose, limp, gaze were the predecessor generation's (#97 B2':
        // avatar-owned transients must not survive ownership moving)
        existing.avatar?.resetTransients?.();
        const fresh = {
          id, avatar: existing.avatar, avatarPath: existing.avatarPath,
          loading: false, agent: !!(meta.agent ?? existing.agent),
          gen: (gens.get(id) ?? 0) + 1,
          buf: [], lastClip: 'idle', lodAcc: 0, lodTick: 0, speakingUntil: 0,
        };
        gens.set(id, fresh.gen);
        remotes.set(id, fresh);
        // predecessor still mid-load: its completion will see a record that
        // isn't its own and dispose (the stale-load guard below); the
        // successor starts its OWN load — bytes are cached, so this is
        // cheap, and ownership stays unambiguous
        if (!fresh.avatar) {
          fresh.loading = true;
          try {
            const av = await makeAvatar(id, fresh.avatarPath || DEFAULT_AVATAR);
            if (remotes.get(id) !== fresh) { av.dispose(); return fresh; }
            fresh.avatar = av;
            if (fresh.buf.length) applyImmediate(fresh);
          } catch (e) { report(`avatar ${id}`, e); }
          fresh.loading = false;
        }
        return fresh;
      }
      return existing;
    }
  }
  const r = {
    id, avatar: null, avatarPath, loading: true, agent: !!meta.agent,
    gen: (gens.get(id) ?? 0) + 1,
    buf: [],                 // [{ t, p:[x,y,z], yaw, speed, clip, pitch }]
    lastClip: 'idle',
    lodAcc: 0, lodTick: 0,
    speakingUntil: 0,
  };
  gens.set(id, r.gen);
  remotes.set(id, r);
  try {
    r.avatar = await makeAvatar(id, avatarPath || DEFAULT_AVATAR);
    // Stale-load guard: they left OR switched bodies while this one loaded.
    // Compare against OUR record, not mere key presence — a replacement body
    // re-occupies the key, and checking has(id) let the old avatar finish
    // loading into the scene as an undisposable ghost.
    if (remotes.get(id) !== r) { r.avatar.dispose(); return r; }
    if (r.buf.length) applyImmediate(r);
  } catch (e) { report(`avatar ${id}`, e); }
  r.loading = false;
  return r;
}

/** Remove a body. Idempotent, and GENERATION-CONDITIONAL when handed the
 *  record the caller believes it is dropping: a predecessor's late cleanup
 *  (a drag callback, a stale timer) cannot delete the successor that now
 *  owns the id (#95 acceptance 4). Returns the dropped record, or null when
 *  there was nothing to drop / the record didn't match. */
export function dropRemote(id, expected) {
  const r = remotes.get(id);
  if (!r) return null;
  if (expected && r !== expected) return null;   // a successor owns this id now
  remotes.delete(id);
  r.avatar?.dispose();
  return r;
}

/** Feed one presence sample. `t` is the server stamp when available. */
export function pushPose(id, pose, t) {
  const r = remotes.get(id);
  if (!r || !pose) return;
  const stamp = typeof t === 'number' ? t : serverNow();
  const last = r.buf[r.buf.length - 1];
  if (last && stamp <= last.t) return;    // out of order — drop
  r.buf.push({ t: stamp, ...pose });
  while (r.buf.length > BUF_MAX) r.buf.shift();
  // reach/touch events ride the RAW stream, not the applied one — a touch
  // that begins while this body's avatar is still loading must be heard
  noteReachEvents(r, pose);
}

function applyImmediate(r) {
  const s = r.buf[r.buf.length - 1];
  if (!r.avatar || !s) return;
  r.avatar.root.position.set(...s.p);
  r.avatar.root.rotation.y = s.yaw ?? 0;
}

// Bone blending scratch. This runs per bone, per remote, per frame — nothing
// on that path may allocate.
const _qa = new THREE.Quaternion(), _qb = new THREE.Quaternion(), _qk = new THREE.Quaternion();
/** Marks "the bones are mid-blend": non-null so a later release still clears,
 *  and never `===` a sample's pose so a held pose always re-applies. */
const POSE_BLEND = {};

/** The held pose (bones), blended a→b by the SAME k as the root. Handed `b`
 *  alone, the bones ran up to INTERP_MS ahead of the body they hang off and
 *  stepped at the 66ms send rate — during a ragdoll tumble the limbs visibly
 *  led the fall. Change detection is pose-object identity, not a stringified
 *  signature: every sample carries a freshly decoded pose so `===` is exactly
 *  as strong, and on the blended path the value differs every frame anyway,
 *  which made the JSON.stringify pure per-frame waste. */
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
  // Re-plan per bracketing pair (~15Hz), not per frame: the merged bone list
  // and its output arrays outlive every frame of the span.
  if (r.poseA !== pa || r.poseB !== pb) planPoseBlend(r, pa, pb);
  for (const s of r.poseSlots) {
    _qa.fromArray(s.a); _qb.fromArray(s.b);
    _qk.slerpQuaternions(_qa, _qb, k).toArray(s.out);
  }
  r.lastPose = POSE_BLEND;
  r.avatar.setPose(r.poseOut);
}

const isQuat = (q) => Array.isArray(q) && q.length === 4;

/** Merged bone list for one pair, with the output arrays setPose will read.
 *  A bone named on only one side holds that side's rotation instead of
 *  blending toward rest — senders drop bones they aren't driving, and reading
 *  the gap as identity would fling the limb. */
function planPoseBlend(r, pa, pb) {
  r.poseA = pa; r.poseB = pb;
  r.poseSlots = []; r.poseOut = {};
  for (const n of new Set([...Object.keys(pa), ...Object.keys(pb)])) {
    const qa = isQuat(pa[n]) ? pa[n] : pb[n], qb = isQuat(pb[n]) ? pb[n] : pa[n];
    if (!isQuat(qa) || !isQuat(qb)) continue;
    const out = [0, 0, 0, 1];
    r.poseSlots.push({ a: qa, b: qb, out });
    r.poseOut[n] = out;
  }
}

/** Presence extras that aren't position or bones: emotes and the locomotion
 *  clip. Driven by the NEWER sample of the pair and never blended — these are
 *  discrete events, and half a wave is not a wave. Applied in BOTH the
 *  interpolated and single-sample paths so a late joiner isn't missing them. */
function applyPresenceExtras(r, s) {
  const clip = s.clip ?? 'idle';
  if (s.emote && s.emote !== r.lastEmote) {
    r.lastEmote = s.emote;
    r.avatar.playEmote(s.emote);
  } else {
    // the one-shot has passed — forget it, so the SAME emote can fire again
    // later (lastEmote never resetting meant nobody could wave twice)
    if (!s.emote) r.lastEmote = null;
    if (clip !== r.lastClip) r.lastClip = clip;
    // 'ragdoll' is not a clip and never was: setClip walks CLIP_FALLBACK,
    // finds no entry for it, and hands _setAction undefined — which returns at
    // its first line. So the locomotion clip went on playing underneath every
    // remote tumble, animating the shoulders, hands and head of a body that
    // was supposed to be limp. The streamed pose owns the bones while down.
    if (clip === 'ragdoll') r.avatar.setLimp(true);
    else { r.avatar.setLimp(false); r.avatar.setClip(clip, s.speed ?? 0); }
  }
  // reach descriptors ride the same newest sample; the diff inside is
  // edge-triggered, so per-frame reapplication costs nothing when idle
  applyRemoteReach(r, s);
}

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();

// Camera-aware animation LOD: with a full stage (24 bodies) a midrange laptop
// cannot run 24 complete VRM updates (spring bones, expressions, look-at) every
// frame. Position interpolation stays per-frame (cheap, keeps motion glued);
// skeletal updates tick at 1×/2×/4× by distance, integrating accumulated dt so
// motion SPEED is unchanged — a far avatar animates at lower temporal
// resolution, not in slow motion.
const LOD_NEAR = 8, LOD_MID = 20;
export let lodBias = 1;                 // raised by the perf governor under load
export function setLodBias(v) { lodBias = v; }

// Bodies whose sim runs on THIS machine right now (bodydrag takeover). Their
// inbound presence is our own stream echoed back through the owner — applying
// it would make the body fight its own past by one round trip. The local sim
// owns root and bones; springs/expressions still tick.
export const draggedLocal = new Set();

export function updateRemotes(dt, now = performance.now()) {
  const renderAt = serverNow() - INTERP_MS;

  for (const r of remotes.values()) {
    if (!r.avatar) continue;
    if (draggedLocal.has(r.id)) { r.avatar.update(dt, now); continue; }
    const buf = r.buf;

    // A mounted body is DERIVED, not streamed: its transform comes from the
    // parent entity's live transform (already ticked by motion.js this frame)
    // composed with the socket. This is what makes a sitter visibly ride the
    // swing mid-pendulum — presence samples are ignored while mounted, so a
    // stale stream can't fight the seat.
    if (avatarMounts.has(r.id)) {
      const sw = mountTransform(r.id, _a, { path: r.avatarPath, av: r.avatar });
      if (sw) {
        r.avatar.root.position.copy(_a);
        r.avatar.root.rotation.y = sw.yaw;
        // Declared seat state (#101): the ≈ marker and one console line per
        // transition — an unprofiled seat renders where it always did, but
        // never silently.
        r.avatar.setSeatApprox(sw.seatState === 'approximate');
        declareSeatState(r.id, sw.to, avatarMounts.get(r.id)?.slot, sw.seatState, sw.seatReason);
        // The seat owns WHERE the body is and its base clip — never its
        // expressiveness. The newest presence sample still delivers emotes
        // (one-shots layer over the sit; setClip is emote-aware and won't
        // cut a wave short) and held bone poses (gesturing from the seat).
        // `animate` streams arrive on their own channel and never pass here.
        const s = buf[buf.length - 1];
        if (s) {
          applyPose(r, s, s, 1);
          if (s.emote && s.emote !== r.lastEmote) {
            r.lastEmote = s.emote;
            r.avatar.playEmote(s.emote);
          } else if (!s.emote) r.lastEmote = null;
          applyRemoteReach(r, s);   // a seated body still puts a hand out
        }
        r.avatar.setLimp(false);
        if (r.lastClip !== sw.pose) { r.lastClip = sw.pose; }
        r.avatar.setClip(sw.pose, 0);   // emote-aware: no-ops while a gesture owns the body
        const d = r.avatar.root.position.distanceTo(camera.position);
        const every = Math.round((d < LOD_NEAR ? 1 : d < LOD_MID ? 2 : 4) * lodBias);
        r.lodAcc += dt;
        r.lodTick = (r.lodTick + 1) % Math.max(1, every);
        if (r.lodTick === 0) { r.avatar.update(r.lodAcc, now); r.lodAcc = 0; }
        continue;
      }
      // parent still downloading — fall through to normal presence meanwhile
    } else if (r.avatar._seatApprox) {
      // stood up: the marker comes off and the next sit declares afresh
      r.avatar.setSeatApprox(false);
      clearSeatState(r.id);
    }

    if (buf.length >= 2) {
      // find the pair bracketing renderAt
      let i = buf.length - 1;
      while (i > 0 && buf[i - 1].t > renderAt) i--;
      const b = buf[i], a = buf[i - 1] ?? b;
      const span = b.t - a.t;
      const k = span > 0 ? THREE.MathUtils.clamp((renderAt - a.t) / span, 0, 1) : 1;

      _a.set(...a.p); _b.set(...b.p);
      r.avatar.root.position.copy(_a).lerp(_b, k);
      r.avatar.root.rotation.y = a.yaw + angleDelta(a.yaw, b.yaw ?? a.yaw) * k;
      r.avatar.pitch = (a.pitch ?? 0) + ((b.pitch ?? 0) - (a.pitch ?? 0)) * k;
      // drop samples we've moved past, but always keep one behind renderAt
      while (buf.length > 2 && buf[1].t < renderAt - 400) buf.shift();
      applyPose(r, a, b, k);
      applyPresenceExtras(r, b);
    } else if (buf.length === 1) {
      applyImmediate(r);
      // A late joiner with only the snapshot's single pose must still apply
      // its held bones — otherwise a body that fell before you arrived shows
      // as a STANDING figure sunk into the ground (the root lowers, the pose
      // never folds). This ran only in the interpolation branch before.
      applyPose(r, buf[0], buf[0], 1);
      applyPresenceExtras(r, buf[0]);
    }

    const d = r.avatar.root.position.distanceTo(camera.position);
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

/** Point every body at whatever currently deserves attention: the most recent
 *  speaker if there is one, otherwise the nearest other body. This is the
 *  cheapest presence win in the client — VRM ships a lookAt rig and nothing
 *  was ever aiming it, so every avatar had dead eyes. */
let _gazeAt = 0;
export function updateGaze(myPos, myAvatar, myName, now = performance.now()) {
  // Attention changes at conversational rate, not frame rate — the O(n²)
  // focus pass at 60Hz was hot-path offender #3 (§14.1). 4Hz is beyond
  // perceptual limits for gaze retargeting (the VRM lookAt rig eases the
  // turn itself); the scan is unchanged, just honestly paced.
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

export function clearRemotes() {
  for (const r of remotes.values()) r.avatar?.dispose();
  remotes.clear();
}
