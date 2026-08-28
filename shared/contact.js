// shared/contact.js — the places on a body that can be touched, by name.
//
// A touch names a PLACE, not a coordinate: "your left shoulder", not
// [0.19, 1.34, 0.02]. The coordinate is derived per body, because bodies are
// not the same size or shape and a number that is a shoulder on one rig is
// mid-air on the next. What travels on the wire, and what an agent says, is
// the name.
//
// Each entry says which bone the point belongs to and which way to approach
// it, in BODY-FRAME coordinates [right, up, forward] — so "the top of the
// head" is +up on every rig, whichever way it happens to be facing, and the
// derivation (client/lib/landmarks.js) casts along that direction to find
// where the actual surface is.
//
// `tier` is what a consent policy can key on. It is a description of
// intimacy, not an authorization: nothing here grants anything, and the
// tiers exist so that a body can say yes to a handshake without thereby
// saying yes to everything.

/** @typedef {{bone: string, from: number[], tier: 'social'|'familiar'|'intimate', of?: string}} ContactPoint */

/** @type {Record<string, ContactPoint>} */
export const CONTACT_POINTS = {
  // --- social: the places a stranger may touch in most human cultures
  hand_l:      { bone: 'leftHand',      from: [1, 0.2, 0.3],   tier: 'social' },
  hand_r:      { bone: 'rightHand',     from: [-1, 0.2, 0.3],  tier: 'social' },
  shoulder_l:  { bone: 'leftUpperArm',  from: [0.6, 1, 0],     tier: 'social' },
  shoulder_r:  { bone: 'rightUpperArm', from: [-0.6, 1, 0],    tier: 'social' },
  forearm_l:   { bone: 'leftLowerArm',  from: [1, 0.3, 0],     tier: 'social' },
  forearm_r:   { bone: 'rightLowerArm', from: [-1, 0.3, 0],    tier: 'social' },
  upper_back:  { bone: 'chest',         from: [0, 0.2, -1],    tier: 'social' },

  // --- familiar: friends, and anyone who has said so
  head_top:    { bone: 'head',          from: [0, 1, 0.05],    tier: 'familiar' },
  back:        { bone: 'spine',         from: [0, 0, -1],      tier: 'familiar' },
  arm_l:       { bone: 'leftUpperArm',  from: [1, 0.1, 0],     tier: 'familiar' },
  arm_r:       { bone: 'rightUpperArm', from: [-1, 0.1, 0],    tier: 'familiar' },
  knee_l:      { bone: 'leftLowerLeg',  from: [0.2, 0.2, 1],   tier: 'familiar' },
  knee_r:      { bone: 'rightLowerLeg', from: [-0.2, 0.2, 1],  tier: 'familiar' },

  // --- intimate: never a default, whatever the flag says
  cheek_l:     { bone: 'head',          from: [1, 0.15, 0.5],  tier: 'intimate' },
  cheek_r:     { bone: 'head',          from: [-1, 0.15, 0.5], tier: 'intimate' },
  chest_front: { bone: 'chest',         from: [0, 0.1, 1],     tier: 'intimate' },
  waist_l:     { bone: 'spine',         from: [1, -0.1, 0.2],  tier: 'intimate' },
  waist_r:     { bone: 'spine',         from: [-1, -0.1, 0.2], tier: 'intimate' },
  hip_l:       { bone: 'leftUpperLeg',  from: [1, 0.4, 0],     tier: 'intimate' },
  hip_r:       { bone: 'rightUpperLeg', from: [-1, 0.4, 0],    tier: 'intimate' },
};

export const TIERS = ['social', 'familiar', 'intimate'];

/** Point names at or below a tier. A policy of 'social' admits only social. */
export function pointsUpTo(tier) {
  const max = TIERS.indexOf(tier);
  if (max < 0) return [];
  return Object.entries(CONTACT_POINTS)
    .filter(([, p]) => TIERS.indexOf(p.tier) <= max)
    .map(([n]) => n);
}

/** Resolve a written name, tolerating the obvious variants a person or an
 *  agent will actually type. Returns null rather than guessing wildly. */
export function canonicalPoint(name) {
  if (typeof name !== 'string') return null;
  let k = name.trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (CONTACT_POINTS[k]) return k;
  // left/right written the long way round, or in front
  k = k.replace(/^left_?/, '').replace(/^right_?/, (m) => '') ;
  const side = /left/.test(name.toLowerCase()) ? '_l' : /right/.test(name.toLowerCase()) ? '_r' : '';
  const base = name.trim().toLowerCase().replace(/[\s-]+/g, '_').replace(/left_?|right_?|_l$|_r$/g, '');
  for (const cand of [base + side, base, base + '_l']) if (CONTACT_POINTS[cand]) return cand;
  return null;
}
