// particles — how a `particles` component READS: the one prose line a text-tier resident gets for an emitter, and the
// begin / change / end narration of a live change. What a value MEANS (its effect document, params, limits, the older
// spelling) is shared/particle_effects.js; the simulation is shared/particlesim.js. Pure; imported by
//
//   mcpl/agent.ts            text-tier perception: look() + the live percept
//   shared/a11y.js           the authority's and the inspector's reading (name, description, what it can do, its state)
//
// so a renderer client, a late joiner, and a resident who perceives by reading cannot disagree about what is burning.
//
// Unit-tested in tools/particles-test.ts.
import { ESSENTIALS, ESSENTIAL_NAMES, instanceOf, effectBlobName, effectFor, hashSeed, QUALITY_TIERS, essentialNameOf } from './particle_effects.js';
import { quoted } from './text.js';

export { hashSeed, QUALITY_TIERS };
/** The Essentials and how each reads (the first protocol's presets, now documents). */
export const PARTICLE_PRESETS = Object.freeze(Object.fromEntries(ESSENTIAL_NAMES.map((k) => [k, { count: ESSENTIALS[k].emitters[0].spawn.amount, reads: ESSENTIALS[k].reads }])));
export const PARTICLE_MAX_COUNT = 600;

/** mulberry32 — small, fast, and the same sequence everywhere. */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function rnd() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
/** The emitter's seed: the authored one if there is one, otherwise derived from the entity id and the effect (persistent:
 *  the id is; every client and every replay computes the same number without a round trip). */
export function emitterSeed(entityId, data) {
  const inst = instanceOf(data) ?? {};
  if (typeof inst.seed === 'number' && Number.isFinite(inst.seed)) return Math.floor(inst.seed) >>> 0;
  return hashSeed(`${entityId}:${essentialNameOf(inst.effect) ?? inst.effect ?? ''}`);   // an Essential's name, stored as its address or not
}
/** Particles one viewer draws of `amount`: the effect's own ratio (an older value's quality) and the viewer's tier,
 *  whichever asks for less. The only number allowed to differ between two clients looking at the same fire. */
export function drawnCount(amount, ratio = 1, tier = 'auto') {
  const k = Math.min(ratio, Object.hasOwn(QUALITY_TIERS, tier) ? QUALITY_TIERS[tier] : 1);
  return Math.max(1, Math.round(amount * k));
}

const short = (addr) => `${addr.replace(/^eido:sha256\//, 'sha256:').slice(0, 19)}…`;
/** What an effect reads as: an Essential's own words; a stored document's `reads` (author text, quoted as data) when the
 *  reader has it; else its address, shortened. */
function readsAs(effect, lookup) {
  if (typeof effect !== 'string' || !effect) return 'something';
  const ess = essentialNameOf(effect); if (ess) return ESSENTIALS[ess].reads;   // a name, or the address it is stored as
  const doc = effectFor(effect, lookup);
  if (doc) return doc.reads || doc.name ? quoted(doc.reads || doc.name, 80) : `a stored effect (${short(effect)})`;
  if (effectBlobName(effect)) return `a stored effect (${short(effect)})`;
  return JSON.stringify(effect);
}

/**
 * How an emitter reads in prose, from the RAW component value (either spelling). Tolerant: an effect this reader doesn't
 * know still reads as an emitter rather than disappearing. Names the semantic thing on the owning entity — never a
 * sprite count, never a bare `components: particles`. Heat, light, sound and contact are NOT claimed: separate
 * authored components provide those, and a resident who reads "warm" acts on it.
 */
export function describeParticles(data, { lookup = () => null } = {}) {
  const inst = instanceOf(data);
  if (!inst) return 'emitting something (particles; malformed declaration)';
  const known = !!essentialNameOf(inst.effect) || !!effectFor(inst.effect, lookup);
  const bits = ['particles'];
  const o = Array.isArray(inst.at) && inst.at.length === 3 && inst.at.every((n) => typeof n === 'number' && Number.isFinite(n)) ? inst.at : null;
  bits.push(`local origin [${(o ?? [0, 0, 0]).join(', ')}]`);
  if (typeof inst.part === 'string') bits.push(`on its ${quoted(inst.part, 64)}`);
  if (!known && !effectBlobName(inst.effect)) bits.push('effect unknown to this client');
  // the component IS the emitter's state: present and playing means it is emitting now
  bits.push(inst.playing === false ? 'stopped' : 'active');
  return `${inst.playing === false ? 'can emit' : 'emitting'} ${readsAs(inst.effect, lookup)} (${bits.join('; ')})`;
}

/** begin / change / end, from the two component states around a live change. `null` on either side means the emitter
 *  was not there. Returns null when nothing perceptible happened (an identical re-author). */
export function emitterTransition(prev, next) {
  const p = instanceOf(prev), n = instanceOf(next);
  if (!p && !n) return null;
  if (!p) return { kind: 'begin', preset: n.effect ?? null };
  if (!n) return { kind: 'end', preset: p.effect ?? null };
  if (JSON.stringify(p) === JSON.stringify(n)) return null;
  if (p.playing !== false && n.playing === false) return { kind: 'stop', preset: n.effect ?? null };
  if (p.playing === false && n.playing !== false) return { kind: 'start', preset: n.effect ?? null };
  return { kind: 'change', preset: n.effect ?? null, from: p.effect ?? null };
}

/** The one ambient line a live attach/replace/remove produces: actor, entity, effect, and which of begin/change/end
 *  happened; nothing per-particle or per-frame. */
export function transitionLine(actor, entityId, transition) {
  if (!transition) return null;
  const r = (e) => readsAs(e, () => null);
  switch (transition.kind) {
    case 'begin': return `${actor} lights ${r(transition.preset)} on [${entityId}] (particles)`;
    case 'end': return `${actor} puts out the ${r(transition.preset)} on [${entityId}] (particles)`;
    case 'stop': return `${actor} stops the ${r(transition.preset)} on [${entityId}] (particles)`;
    case 'start': return `${actor} starts the ${r(transition.preset)} on [${entityId}] again (particles)`;
  }
  return transition.from && transition.from !== transition.preset
    ? `${actor} changes [${entityId}]'s emitter: ${r(transition.from)} → ${r(transition.preset)} (particles)`
    : `${actor} retunes the ${r(transition.preset)} on [${entityId}] (particles)`;
}
