// reachnet — reach descriptors ⇄ the live scene; both browser ends of shared/reachwire.js.
//   sending — my reach is a descriptor bag (myReachBag rides every presence packet); my arm runs the same
//   resolution path everyone else will, and my solver's verdict keeps the `reached` attestation honest.
//   receiving — a remote body's descriptors are diffed per sample (applyRemoteReach) and each new aim resolved
//   against MY copy of the scene into a live target function for avatar.setReach.
// A reach aimed at my body surfaces on the bus (the same edges an agent hears through its door):
//   'reach' { who, limb, point?, entry }   they aim at me
//   'touch' { who, limb, point?, entry }   their solve arrived
//   'release' { who, limb }                they let go

import { bus } from './base.js';
import { deriveLandmarks, landmarkWorld } from './avatar/landmarks.js';
import {
  REACH_LIMBS, TOUCH_GAP, normalizeReachBag, normalizeReachTarget, sameReach,
  reachTargetsWho, diffReach,
} from '../../shared/reachwire.js';

let hooks = {
  me: () => null,          // my avatar
  myId: () => null,        // my participant id
  avatarOf: () => null,    // id -> avatar (me included)
};
export function initReachNet(h) { hooks = { ...hooks, ...h }; }

/** Where a named contact point on an avatar is now: { pos, normal } in world space, or null. */
function contactFrameOf(avatar, point, standoff = 0.02) {
  if (!avatar) return null;
  avatar.__marks ??= deriveLandmarks(avatar);
  const e = avatar.__marks.get(point);
  const hit = e && landmarkWorld(e, standoff);
  return hit ? { pos: hit.pos.toArray(), normal: hit.normal.toArray() } : null;
}

/** A normalized entry → the live target function avatar.setReach re-evaluates every frame. `ownerId` is the
 *  reacher (for 'self' space). Bodies resolve lazily, so a reach at someone still loading tracks once they exist. */
function resolveEntryFn(ownerId, entry) {
  const t = entry.t;
  if (t.who !== undefined) {
    const standoff = t.standoff ?? 0.02;
    if (entry.palm === false) {
      return () => contactFrameOf(hooks.avatarOf(t.who), t.point, standoff)?.pos ?? null;
    }
    return () => contactFrameOf(hooks.avatarOf(t.who), t.point, standoff);
  }
  const p = t.p;
  if (!t.space) return () => p;
  const frameOf = t.space === 'self' ? () => hooks.avatarOf(ownerId) : () => hooks.avatarOf(t.space);
  return () => {
    const av = frameOf();
    if (!av) return null;
    const v = (av.__reachScratch ??= av.root.position.clone());
    v.set(p[0], p[1], p[2]);
    av.root.localToWorld(v);
    return [v.x, v.y, v.z];
  };
}

// ---------------------------------------------------------------- receiving

/** Apply the newest presence sample's reach bag to a remote body (remotes.js, with the other presence extras). */
export function applyRemoteReach(r, sample) {
  if (r.avatar) r.avatar._reachOwner = r.id;
  const bag = normalizeReachBag(sample?.reach);
  const prev = r.lastReach ?? null;
  if (bag === prev) return;                       // both absent, the common case
  for (const limb of REACH_LIMBS) {
    const d = bag?.[limb] ?? null, p = prev?.[limb] ?? null;
    if (d && (!p || !sameReach(p, d))) {
      r.avatar?.setReach(limb, resolveEntryFn(r.id, d), { relation: d.t, palm: d.palm });
    } else if (!d && p) {
      r.avatar?.clearReach(limb);
    } else if (d && r.avatar && !r.avatar._limp && !r.avatar._reach?.has(limb)) {
      // going limp clears the avatar's reach map but not the descriptor (the reacher's to clear): re-assert once up
      r.avatar.setReach(limb, resolveEntryFn(r.id, d), { relation: d.t, palm: d.palm });
    }
  }
  r.lastReach = bag;
}

/** Reach/touch/release events off the raw sample stream, apart from applyRemoteReach (which waits for the avatar)
 *  so a touch during a VRM load is still heard. Edge-triggered; a body first seen mid-reach seeds silently. */
export function noteReachEvents(r, pose) {
  const bag = normalizeReachBag(pose?.reach);
  const prev = r.lastReachEvt;
  if (bag === null && prev == null) { r.lastReachEvt = null; return; }
  const myId = hooks.myId();
  if (prev !== undefined && myId) {
    for (const ev of diffReach(prev, bag, myId)) {
      bus.emit(ev.type, { who: r.id, limb: ev.limb, point: ev.entry?.t?.point, entry: ev.entry });
    }
  }
  r.lastReachEvt = bag;
}

/** A body left or was replaced: its arms let go and its edge state resets. */
export function dropRemoteReach(r) {
  if (r.lastReach) for (const limb of Object.keys(r.lastReach)) r.avatar?.clearReach(limb);
  r.lastReach = undefined;
}

// ---------------------------------------------------------------- sending

let myBag = null;          // { limb: entry } | null — what rides the wire

/**
 * Reach with my own body. `spec` shapes (generous: this is the EW console surface):
 *   'head_top'                      a name on my own body
 *   ['mythos', 'shoulder_l']        a landmark on someone
 *   [x, y, z]                       a world point
 *   { who, point, standoff? }       the wire form, spelled out
 *   { p, space? }                   a point in 'world' | 'self' | '<id>' frame
 * Returns null on success or a string saying what was wrong.
 */
export function setMyReach(limb, spec, opts = {}) {
  const me = hooks.me();
  if (!me) return 'no body yet';
  let t = spec;
  if (typeof spec === 'string') t = { who: hooks.myId(), point: spec };
  else if (Array.isArray(spec) && spec.length === 2 && typeof spec[1] === 'string') t = { who: spec[0], point: spec[1] };
  else if (Array.isArray(spec) && spec.length === 3) t = { p: spec };
  const target = normalizeReachTarget(t);
  if (!target) return 'unusable target — a contact point name, [who, point], [x,y,z], or {p, space}';
  const entry = { t: target, ...(opts.palm === false ? { palm: false } : {}) };
  me._reachOwner = hooks.myId();
  if (!me.setReach(limb, resolveEntryFn(hooks.myId(), entry), { ...opts, relation: target })) return `no reachable chain "${limb}"`;
  myBag = { ...(myBag ?? {}), [limb]: entry };
  return null;
}

export function clearMyReach(limb = null) {
  hooks.me()?.clearReach(limb);
  if (limb == null) { myBag = null; return; }
  if (myBag && myBag[limb]) {
    const { [limb]: _, ...rest } = myBag;
    myBag = Object.keys(rest).length ? rest : null;
  }
}

/** What sendPose carries this packet: the bag, with `reached` set from my solver's last frame; undefined when I
 *  reach for nothing, so the field leaves the wire. */
export function myReachBag() {
  if (!myBag) return undefined;
  const status = hooks.me()?.reachStatus?.() ?? {};
  let changed = false;
  const out = {};
  for (const [limb, entry] of Object.entries(myBag)) {
    const s = status[limb];
    const arrived = !!s && s.weight > 0.5 && Number.isFinite(s.gap) && s.gap <= TOUCH_GAP
      && !(s.bound ?? []).includes('no-target');
    if (arrived !== !!entry.reached) {
      out[limb] = arrived ? { ...entry, reached: true } : (({ reached: _, ...e }) => e)(entry);
      changed = true;
    } else out[limb] = entry;
  }
  if (changed) myBag = out;
  return myBag;
}
