// reachnet — reach descriptors ⇄ the live scene.
//
// shared/reachwire.js says what a reach IS on the wire; this file is the two
// ends of that wire in a browser:
//
//   sending — my reach lives here as a descriptor bag (myReachBag rides every
//   presence packet, like a held pose), my own arm is driven through the same
//   resolution path everyone else will run, and my solver's verdict maintains
//   the `reached` attestation the far end's touch event fires on.
//
//   receiving — a remote body's descriptors are diffed per sample
//   (applyRemoteReach), each new aim resolved against MY copy of the scene
//   into a live target function for avatar.setReach. Every viewer re-solves
//   the same relation; the closed-form solver is what makes them agree.
//
// Events: a reach aimed at MY body surfaces on the bus —
//   bus.emit('reach'  , { who, limb, point?, entry })   they aim at me
//   bus.emit('touch'  , { who, limb, point?, entry })   their solve arrived
//   bus.emit('release', { who, limb })                  they let go
// — the same edges an agent hears through its door. UI can listen; nothing
// here renders anything.

import { bus } from './core.js';
import { deriveLandmarks, landmarkWorld } from './landmarks.js';
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

/** Where a named contact point on an avatar is NOW: { pos, normal } in world
 *  space, or null. Landmarks derive once per body and live on it. */
export function contactFrameOf(avatar, point, standoff = 0.02) {
  if (!avatar) return null;
  avatar.__marks ??= deriveLandmarks(avatar);
  const e = avatar.__marks.get(point);
  const hit = e && landmarkWorld(e, standoff);
  return hit ? { pos: hit.pos.toArray(), normal: hit.normal.toArray() } : null;
}

/**
 * A normalized entry → the live target function avatar.setReach re-evaluates
 * every frame. `ownerId` is the REACHER (for 'self' space). Bodies resolve
 * lazily inside the function: a reach at someone still loading starts
 * tracking them the moment their avatar exists, instead of failing once at
 * descriptor time and never again.
 */
export function resolveEntryFn(ownerId, entry) {
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

/**
 * Apply the newest presence sample's reach bag to a remote body. Called from
 * remotes.js wherever the other presence extras are applied — including the
 * mounted branch, because a seated body still gestures.
 */
export function applyRemoteReach(r, sample) {
  const bag = normalizeReachBag(sample?.reach);
  const prev = r.lastReach ?? null;
  if (bag === prev) return;                       // both absent, the common case
  for (const limb of REACH_LIMBS) {
    const d = bag?.[limb] ?? null, p = prev?.[limb] ?? null;
    if (d && (!p || !sameReach(p, d))) {
      r.avatar?.setReach(limb, resolveEntryFn(r.id, d));
    } else if (!d && p) {
      r.avatar?.clearReach(limb);
    } else if (d && r.avatar && !r.avatar._limp && !r.avatar._reach?.has(limb)) {
      // self-heal: going limp clears the avatar's reach map (a corpse does
      // not keep reaching) without touching the DESCRIPTOR, which is the
      // reacher's to clear. Once the body is back up, re-assert.
      r.avatar.setReach(limb, resolveEntryFn(r.id, d));
    }
  }
  r.lastReach = bag;
}

/**
 * Reach/touch/release EVENTS off the raw sample stream — deliberately
 * decoupled from applyRemoteReach, which runs only once the avatar has
 * loaded: a touch that begins during a multi-second VRM load must still be
 * heard (this exact race ate the first live event). Called per pushed
 * sample; edge-triggered, so idle samples cost one null check.
 *
 * A body FIRST OBSERVED mid-reach is a baseline, not a transition (the
 * approach lesson, issue #39): a late joiner must not hear "X touches you"
 * for a hand that has rested there since before they arrived — the first
 * sample seeds silently.
 */
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
 * Reach with my own body. `spec` shapes (generous — this is the EW surface):
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
  if (!me.setReach(limb, resolveEntryFn(hooks.myId(), entry), opts)) return `no reachable chain "${limb}"`;
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

/** What sendPose should carry this packet: the bag, with `reached` kept
 *  honest from my own solver's last frame. Undefined when I reach for
 *  nothing, so the field vanishes from the wire. */
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
