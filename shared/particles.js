// particles — the `particles` component's MEANING, as one pure module.
//
// A `comp {id, type: "particles", data: {...}}` entry declares that an entity
// EMITS something: a hearth on fire, a lamp shedding embers, a censer smoking.
// This file owns what that declaration means — which presets exist, which
// overrides are allowed and inside what bounds, which seed the emitter has,
// and how the emitter reads in prose. Nothing here touches THREE, the DOM, or
// the log; it is imported verbatim by
//
//   client/lib/emitters.js   the browser host (GPU sprites, lifecycle)
//   mcpl/agent.ts            text-tier perception: look() + the live percept
//   server/server.ts         the advisory lint that says why a bag won't render
//
// so a renderer client, a late joiner, and a resident who perceives by reading
// cannot disagree about what is burning. Same discipline as forecast.js: the
// SHARED FACTS (preset, state, seed, provenance) come out of one function, and
// only the sprite count is allowed to differ between machines.
//
// Unit-tested in tools/particles-test.ts.

/** The presets the upstream engine (`eidoverse/particles.js`) actually ships.
 *  A `preset` outside this list does not render — but it is never erased
 *  either: it folds, persists, and still reads as an emitter in look(), the
 *  same forward-compatibility the component bag has everywhere else. */
export const PARTICLE_PRESETS = Object.freeze({
  fire:   { count: 150, reads: 'fire' },
  sparks: { count: 220, reads: 'sparks' },
  embers: { count: 140, reads: 'embers' },
  smoke:  { count: 70,  reads: 'smoke' },
  dust:   { count: 160, reads: 'drifting dust' },
  snow:   { count: 320, reads: 'falling snow' },
  magic:  { count: 180, reads: 'motes of light' },
  stars:  { count: 420, reads: 'a field of stars' },
  muzzle: { count: 48,  reads: 'a muzzle flash' },
});

/** Hard ceiling on sprites per emitter, independent of quality tier. A count
 *  is a shared-state parameter, so it is bounded in the DECLARATION rather
 *  than only at the renderer: an authored `count: 5e6` must fail at the door
 *  of meaning, not silently melt the one client with a good GPU. */
export const PARTICLE_MAX_COUNT = 600;

/** Quality tiers scale sprite count and NOTHING else. Preset, state, seed and
 *  provenance are shared facts across clients (#25's "visual quality may
 *  reduce count, but preset/state/provenance are shared facts").
 *
 *  Two tiers compose, and they compose as a MINIMUM. The authored `quality` on
 *  the component is a shared upper bound — the author saying "this emitter is
 *  never worth more than a quarter of its count anywhere" — and the client's
 *  own tier is a local budget the perf governor lowers. Neither may raise the
 *  other: an authored `low` stays low on the strongest GPU in the world, and a
 *  governor that has dropped to `low` is not overruled by an authored `high`.
 *  (`auto` is the identity on both sides: no opinion.) */
export const QUALITY_TIERS = Object.freeze({ auto: 1, high: 1, med: 0.5, low: 0.25 });

/** The scale a tier name asks for; an unknown name asks for nothing. */
const tierScale = (name) => (Object.hasOwn(QUALITY_TIERS, name) ? QUALITY_TIERS[name] : 1);

/** Where an authored texture may point. The library route serves the whole
 *  eidoverse-video checkout; a component is authored by anyone with builder
 *  rights, so the texture field names a file in the particle library and
 *  nowhere else. */
const TEXTURE_DIR = 'eidoverse/assets/particle_textures/';

/** Every key an authored `particles` bag may carry, with its bound. Anything
 *  outside this table is reported by name rather than quietly dropped — a
 *  parameter the evaluator ignores is exactly the class of bug the motion
 *  lint exists to surface. */
const NUMERIC_BOUNDS = {
  count:    [1, PARTICLE_MAX_COUNT],
  size:     [0.005, 4],
  opacity:  [0, 1],
  speed:    [0.05, 8],
  lifetime: [0.05, 30],
  area:     [0, 8],
};
const KNOWN_KEYS = new Set(['preset', 'seed', 'texture', 'origin', 'quality', ...Object.keys(NUMERIC_BOUNDS)]);

// ---- determinism -----------------------------------------------------------

/** mulberry32 — small, fast, and the same sequence everywhere. The upstream
 *  builder draws its per-instance spawn attributes from `Math.random()`, so
 *  "deterministic" for us means: the same seed produces the same DRAWS. The
 *  host installs this around the (synchronous) build call; see
 *  `withSeededRandom`. */
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

/** Run `fn` with `Math.random` replaced by this emitter's own stream, then put
 *  the real one back — even if `fn` throws. This is the ONE seam where the
 *  upstream builder's `Math.random()` spawn attributes become replay-stable,
 *  deliberately kept to a single call site so that when the engine grows a
 *  first-class `seed` option the shim is a one-line deletion. It is safe only
 *  because the builder is synchronous: nothing else can observe the swap. */
export function withSeededRandom(seed, fn) {
  const real = Math.random;
  Math.random = mulberry32(seed);
  try {
    return fn();
  } finally {
    Math.random = real;
  }
}

/** FNV-1a over a string → a 32-bit seed. Used only when the author did not
 *  write one down. */
export function hashSeed(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < String(str).length; i++) {
    h ^= String(str).charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** The emitter's seed: the authored one if there is one, otherwise derived
 *  from the entity id and the preset. Derived is enough for an ORDINARY
 *  emitter — it is persistent (the id is), it travels with the component, and
 *  every client and every replay computes the same number without a round
 *  trip. A resident whose BODY is an emitter field needs more than this: the
 *  seed then belongs to the body definition and is #14's problem, not this
 *  file's (#25's scope fence). */
export function emitterSeed(entityId, data) {
  const authored = data?.seed;
  if (typeof authored === 'number' && Number.isFinite(authored)) return Math.floor(authored) >>> 0;
  return hashSeed(`${entityId}:${data?.preset ?? ''}`);
}

// ---- validation ------------------------------------------------------------

const clamp = (v, [lo, hi]) => Math.min(hi, Math.max(lo, v));

function normalizeOrigin(origin, problems) {
  if (origin == null) return [0, 0, 0];
  if (!Array.isArray(origin) || origin.length !== 3 || !origin.every((n) => typeof n === 'number' && Number.isFinite(n))) {
    problems.push('origin must be [x, y, z] numbers (entity-relative metres)');
    return [0, 0, 0];
  }
  // Entity-RELATIVE by contract: the emitter hangs off the thing that owns it
  // and travels with it. A 200m offset is not a local origin, it is a second
  // entity nobody can see, move or remove.
  if (origin.some((n) => Math.abs(n) > 8)) {
    problems.push('origin is entity-relative and bounded to ±8m — place a far emitter on its own entity');
    return origin.map((n) => clamp(n, [-8, 8]));
  }
  return origin.slice();
}

/**
 * Normalize an authored `particles` bag into the emitter a renderer builds.
 *
 * Returns `{ok: true, emitter, notes}` — `notes` naming anything that was
 * clamped — or `{ok: false, why}` when the bag names no renderable preset.
 * A failure here is never a fold failure: the component still persists and
 * still reads as an emitter (`describeParticles`). It only means no sprites.
 */
export function normalizeParticles(data, { entityId = '' } = {}) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { ok: false, why: 'particles data must be an object {preset, …}' };
  }
  const preset = data.preset;
  if (typeof preset !== 'string' || !Object.hasOwn(PARTICLE_PRESETS, preset)) {
    return {
      ok: false,
      why: `preset ${JSON.stringify(preset ?? null)} is not one this client can render (${Object.keys(PARTICLE_PRESETS).join('/')}) — it will read as an emitter but show nothing until an evaluator learns it`,
    };
  }
  const notes = [];
  const unknown = Object.keys(data).filter((k) => !KNOWN_KEYS.has(k) && !k.startsWith('_'));
  if (unknown.length) notes.push(`ignored by the evaluator: ${unknown.join(', ')} (accepted: ${[...KNOWN_KEYS].join(', ')})`);

  const emitter = {
    preset,
    seed: emitterSeed(entityId, data),
    origin: normalizeOrigin(data.origin, notes),
    quality: Object.hasOwn(QUALITY_TIERS, data.quality) ? data.quality : 'auto',
  };
  if (data.quality != null && !Object.hasOwn(QUALITY_TIERS, data.quality)) {
    notes.push(`quality ${JSON.stringify(data.quality)} is unknown (${Object.keys(QUALITY_TIERS).join('/')}) — using auto`);
  }
  if (data.texture != null) {
    const t = String(data.texture);
    if (!t.startsWith(TEXTURE_DIR) || !t.endsWith('.png')) {
      notes.push(`texture must be a .png under ${TEXTURE_DIR} — using the preset's own look`);
    } else emitter.texture = t;
  }
  for (const [key, bound] of Object.entries(NUMERIC_BOUNDS)) {
    const v = data[key];
    if (v == null) continue;
    // `area` also accepts per-axis extents upstream; both forms are bounded.
    if (key === 'area' && Array.isArray(v)) {
      if (v.length !== 3 || !v.every((n) => typeof n === 'number' && Number.isFinite(n))) {
        notes.push('area must be a number or [x, y, z] numbers — using the preset');
        continue;
      }
      const fixed = v.map((n) => clamp(n, bound));
      if (fixed.some((n, i) => n !== v[i])) notes.push(`area clamped to [${bound[0]}, ${bound[1]}]`);
      emitter.area = fixed;
      continue;
    }
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      notes.push(`${key} must be a finite number — using the preset`);
      continue;
    }
    const fixed = clamp(v, bound);
    if (fixed !== v) notes.push(`${key} clamped to [${bound[0]}, ${bound[1]}]`);
    emitter[key] = key === 'count' ? Math.round(fixed) : fixed;
  }
  if (emitter.count == null) emitter.count = PARTICLE_PRESETS[preset].count;
  return { ok: true, emitter, notes };
}

/** Sprites this machine will actually draw: the authored cap and the local
 *  tier, whichever asks for less. The only number allowed to differ between
 *  two clients looking at the same fire. */
export function resolvedCount(emitter, tier = 'auto') {
  const k = Math.min(tierScale(emitter?.quality ?? 'auto'), tierScale(tier));
  return Math.max(1, Math.round((emitter?.count ?? 0) * k));
}

// ---- perception ------------------------------------------------------------

/**
 * How an emitter reads in prose, from the RAW component bag.
 *
 * Deliberately tolerant where `normalizeParticles` is strict: #25 requires
 * that an unknown preset "remains legible as an emitter rather than
 * disappearing", so a bag this client cannot render still says what the world
 * says it is. Names the semantic thing on the owning entity — never a sprite
 * count first, never a bare `components: particles`.
 */
export function describeParticles(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return 'emitting something (particles; malformed declaration)';
  const preset = typeof data.preset === 'string' ? data.preset : null;
  const known = preset && Object.hasOwn(PARTICLE_PRESETS, preset);
  const what = known ? PARTICLE_PRESETS[preset].reads : preset ? `"${preset}"` : 'something';
  const bits = ['particles'];
  const o = Array.isArray(data.origin) && data.origin.length === 3 && data.origin.every((n) => typeof n === 'number' && Number.isFinite(n))
    ? data.origin : null;
  bits.push(`local origin [${(o ?? [0, 0, 0]).join(', ')}]`);
  if (!known) bits.push('preset unknown to this client');
  // "active" is the honest claim: the component IS the emitter's state, and a
  // present component means it is emitting. Heat, light, sound and contact are
  // NOT claimed here — separate authored components provide those, and saying
  // a fire is warm when nothing models warmth is a lie a resident would act on.
  bits.push('active');
  return `emitting ${what} (${bits.join('; ')})`;
}

/** begin / change / end, from the two component states around a live `comp`.
 *  `null` on either side means the emitter was not there. Returns null when
 *  nothing perceptible happened (an identical re-author). */
export function emitterTransition(prev, next) {
  const p = prev && typeof prev === 'object' ? prev : null;
  const n = next && typeof next === 'object' ? next : null;
  if (!p && !n) return null;
  if (!p) return { kind: 'begin', preset: n.preset ?? null };
  if (!n) return { kind: 'end', preset: p.preset ?? null };
  if (JSON.stringify(p) === JSON.stringify(n)) return null;
  return { kind: 'change', preset: n.preset ?? null, from: p.preset ?? null };
}

const readsAs = (preset) => (preset && Object.hasOwn(PARTICLE_PRESETS, preset)
  ? PARTICLE_PRESETS[preset].reads : preset ? `"${preset}"` : 'something');

/**
 * The one ambient line a live attach/replace/remove produces. Carries the
 * actor, the entity, the preset and which of begin/change/end happened —
 * everything #25's live-change contract asks for, and nothing per-particle or
 * per-frame. `who` is the line's subject; the caller supplies the tags.
 */
export function transitionLine(actor, entityId, transition) {
  if (!transition) return null;
  if (transition.kind === 'begin') return `${actor} lights ${readsAs(transition.preset)} on [${entityId}] (particles)`;
  if (transition.kind === 'end') return `${actor} puts out the ${readsAs(transition.preset)} on [${entityId}] (particles)`;
  return transition.from && transition.from !== transition.preset
    ? `${actor} changes [${entityId}]'s emitter: ${readsAs(transition.from)} → ${readsAs(transition.preset)} (particles)`
    : `${actor} retunes the ${readsAs(transition.preset)} on [${entityId}] (particles)`;
}
