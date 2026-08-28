// shared/reachwire.js — the reach DESCRIPTOR: what a reach IS on the wire.
//
// A reach travels as a RELATION, not as solved bone angles: "right hand toward
// mythos's shoulder_l", "left hand toward this point in my own frame". Every
// client that receives the descriptor resolves the target against its own live
// scene and re-solves the arm each frame — the solver is closed-form
// (shared/reach.js) precisely so that independent solvers agree. What can NOT
// travel is a function, which is why the descriptor grammar below exists.
//
// It rides the presence plane (spec/PROTOCOL.md §5): per-frame, lossy, never
// persisted. The server relays the pose bag opaquely; everything in this file
// runs at the two ends. Because the ends don't trust the middle — or each
// other's versions — every reader normalizes: a malformed descriptor folds to
// nothing rather than to a throw in somebody's frame loop.
//
// Two target shapes:
//   { who: 'mythos', point: 'shoulder_l', standoff?: 0.02 }
//       a named contact point (shared/contact.js) on a body — the toucher's
//       own body included. Resolvers derive the millimetre per rig; the name
//       is what travels, because a coordinate that is a shoulder on one body
//       is mid-air on the next.
//   { p: [x,y,z], space?: 'world' | 'self' | '<participant id>' }
//       a bare point. 'world' (the default) is fixed; 'self' lives in the
//       REACHER's root frame and moves with them; a participant id lives in
//       that body's root frame and tracks them.
//
// A limb entry wraps a target with its riders:
//   { t: <target>, palm?: false, reached?: true }
// `palm: false` opts out of turning the palm to meet the surface (name-form
// targets orient the palm by default — see EW.reach's history for why).
// `reached` is set by the REACHER's own solve when the hand arrives; the
// rising edge is what a touch event fires on. It is an attestation, not a
// measurement made by anyone else — same trust level as the pose stream that
// carries it.

import { canonicalPoint } from './contact.js';

/** The limbs a reach can drive — mirror of shared/joints.js REACH_CHAINS. */
export const REACH_LIMBS = ['leftHand', 'rightHand', 'leftFoot', 'rightFoot'];

/** A hand "has arrived" when its solve leaves this little gap or less. The
 *  target already stands off the skin, so 0 is the ideal; the slack absorbs
 *  breathing, interpolation, and the retreat search settling nearby. One
 *  constant for every attester — browser and agent must agree on what a
 *  touch is, or the same hand touches in one process and hovers in another. */
export const TOUCH_GAP = 0.05;

/** Tolerant limb naming: 'right', 'right hand', 'right_hand' → 'rightHand'. */
export function canonicalLimb(name) {
  if (typeof name !== 'string') return null;
  const k = name.trim().toLowerCase().replace(/[\s_-]+/g, '');
  const map = {
    left: 'leftHand', right: 'rightHand',
    lefthand: 'leftHand', righthand: 'rightHand',
    leftfoot: 'leftFoot', rightfoot: 'rightFoot',
    leftleg: 'leftFoot', rightleg: 'rightFoot',
  };
  return map[k] ?? null;
}

const fin3 = (p) => Array.isArray(p) && p.length === 3 && p.every(Number.isFinite);

/** Normalize one target. Returns the canonical form, or null (never throws,
 *  never guesses: a reader of wire data folds garbage to nothing). */
export function normalizeReachTarget(t) {
  if (!t || typeof t !== 'object') return null;
  if (typeof t.who === 'string' && t.who.length && t.who.length <= 64) {
    const point = canonicalPoint(t.point);
    if (!point) return null;
    const out = { who: t.who, point };
    const s = Number(t.standoff);
    if (Number.isFinite(s) && s >= 0) out.standoff = Math.min(0.2, s);
    return out;
  }
  if (fin3(t.p)) {
    const out = { p: [t.p[0], t.p[1], t.p[2]] };
    if (typeof t.space === 'string' && t.space !== 'world' && t.space.length <= 64) out.space = t.space;
    return out;
  }
  return null;
}

/** Normalize a whole `pose.reach` bag from the wire. Unknown limbs and
 *  malformed entries drop; an empty result is null (absence and emptiness
 *  mean the same thing: nobody is reaching). */
export function normalizeReachBag(bag) {
  if (!bag || typeof bag !== 'object') return null;
  const out = {};
  for (const limb of REACH_LIMBS) {
    const e = bag[limb];
    if (!e || typeof e !== 'object') continue;
    const t = normalizeReachTarget(e.t);
    if (!t) continue;
    const entry = { t };
    if (e.palm === false) entry.palm = false;
    if (e.reached === true) entry.reached = true;
    out[limb] = entry;
  }
  return Object.keys(out).length ? out : null;
}

/** Does this entry's target name a particular body? (A landmark on them, or a
 *  point in their root frame — both are reaches TOWARD that person.) */
export function reachTargetsWho(entry, id) {
  const t = entry?.t;
  if (!t || !id) return false;
  return t.who === id || t.space === id;
}

/** Same reach, ignoring the `reached` rider — the identity that edge
 *  detection cares about. Both sides assumed normalized. */
export function sameReach(a, b) {
  if (!a || !b) return false;
  if ((a.palm === false) !== (b.palm === false)) return false;
  const ta = a.t, tb = b.t;
  if (ta.who !== undefined || tb.who !== undefined) {
    return ta.who === tb.who && ta.point === tb.point && (ta.standoff ?? null) === (tb.standoff ?? null);
  }
  return (ta.space ?? null) === (tb.space ?? null)
    && fin3(ta.p) && fin3(tb.p)
    && ta.p[0] === tb.p[0] && ta.p[1] === tb.p[1] && ta.p[2] === tb.p[2];
}

/** Target as words, for tool replies and events. `selfId` renders that body's
 *  own name as "your". */
export function describeTarget(t, selfId = null) {
  if (!t) return 'nothing';
  if (t.who !== undefined) {
    const whose = selfId && t.who === selfId ? 'your' : `${t.who}'s`;
    return `${whose} ${t.point}`;
  }
  const p = `[${t.p.map((v) => (Math.round(v * 100) / 100)).join(', ')}]`;
  if (!t.space) return `the point ${p}`;
  if (t.space === 'self') return `${p} in their own frame`;
  return selfId && t.space === selfId ? `${p} in your frame` : `${p} in ${t.space}'s frame`;
}

/**
 * Diff two normalized bags into the EVENTS a body should hear about.
 * Pure, so the edge/latch logic is testable without an agent or a browser.
 *
 * `selfId` is the body doing the listening; only reaches directed at it (a
 * landmark on it, or a point in its frame) produce events. Returns
 * [{ type: 'reach' | 'touch' | 'release', limb, entry }]:
 *   reach   — a descriptor aimed at self appeared or changed aim
 *   touch   — the reacher's solve reports the hand arrived (rising edge)
 *   release — a descriptor aimed at self went away
 */
export function diffReach(prevBag, bag, selfId) {
  const events = [];
  for (const limb of REACH_LIMBS) {
    const d = bag?.[limb] ?? null, p = prevBag?.[limb] ?? null;
    const dMe = d && reachTargetsWho(d, selfId), pMe = p && reachTargetsWho(p, selfId);
    if (dMe && (!pMe || !sameReach(p, d))) events.push({ type: 'reach', limb, entry: d });
    if (!dMe && pMe) events.push({ type: 'release', limb, entry: p });
    if (dMe && d.reached && !(pMe && sameReach(p, d) && p.reached)) {
      events.push({ type: 'touch', limb, entry: d });
    }
  }
  return events;
}
