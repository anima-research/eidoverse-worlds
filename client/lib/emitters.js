// emitters — the browser host for the `particles` component.
//
// Owns the THREE/DOM-bound half: resolving a stored value into its effect (shared/particle_effects.js: an Essential, or
// a document stored in the world, fetched once with the `effect` request), priming and caching sprite textures, building
// each emitter (client/lib/particlefx.js: shared/particlesim.js, Godot's CPUParticles3D ported, drawn as instanced
// quads) with a DETERMINISTIC random stream from its seed, parenting it to the thing (or the model part) that owns it, and
// handing the handle to the registry that knows how to take it back out again.
//
// The split mirrors flora:
//   particle_effects.js — what a `particles` value MEANS (shared with the authority and the mcpl agent)
//   particlesim.js      — the simulation (pure)
//   emitter_field.js    — lifecycle/registry, DOM-free and unit-tested
//   particlefx.js       — the GPU half of one emitter
//   this file           — hosting
//
// `playing: false` is Godot's emitting = false: the living particles finish and none are born; turning it back on
// resumes the same emitter (no rebuild).

import { THREE, scene } from './core.js';
import { bus } from './base.js';
import { primeFiles } from './assets.js';
import { entities, findPart } from './world.js';
import { resolveParticles, effectBlobName, effectProblem, readableEffect, QUALITY_TIERS } from '../../shared/particle_effects.js';
import { buildEmitter } from './particlefx.js';
import { makeEmitterRegistry, retireEmitter } from './emitter_field.js';
import { autoHooks as autos, ownHook } from './autohooks.js';
import { sendRequest } from './net.js';

// ---- textures --------------------------------------------------------------
// Sprite textures are SHARED, immutable, and small; one flame_05 serves every
// hearth in the world. They are therefore cached per path and deliberately NOT
// disposed when an emitter retires — texture ownership is explicit (#25 item
// 3): the cache owns them, the emitter borrows. Disposing a borrowed texture
// is how you blank every other fire in the world by putting one out.
const textureCache = new Map();

async function spriteTexture(path) {
  if (!path) return null;
  if (!textureCache.has(path)) {
    textureCache.set(path, (async () => {
      await primeFiles([path]);
      const bytes = globalThis.Deno.readFileSync(path);
      return globalThis.loadImageTexture(bytes, { srgb: true });
    })().catch((e) => {
      // A missing sprite is not a missing emitter: the builder's procedural
      // dot always works, and a hearth that reads as fire in text but shows a
      // soft glow beats a hearth that shows nothing.
      console.warn(`[emitters] sprite ${path} unavailable — using the preset's own look`, e);
      textureCache.delete(path);
      return null;
    }));
  }
  return textureCache.get(path);
}

// ---- quality ---------------------------------------------------------------
// One world-wide tier, lowered by the perf governor. It scales DRAWN sprites
// and nothing else: preset, state, seed and provenance stay identical on every
// machine, which is what makes two people talking about the same fire be
// talking about the same fire.
let tier = 'auto';
const handles = new Set();

export function setEmitterQuality(next) {
  if (!Object.hasOwn(QUALITY_TIERS, next) || next === tier) return false;
  tier = next;
  for (const h of handles) h.setTier?.(tier);
  return true;
}
export const emitterQuality = () => tier;
/** Live emitters — the governor's cue to bother at all, and the cleanup test's
 *  window onto whether anything leaked. */
export const emitterCount = () => handles.size;

// ---- stored effects ---------------------------------------------------------
// A document stored in the world (effect: 'sha256:<hex>') is fetched once and kept: a content address names fixed bytes,
// so a cached one is never stale. The authority checked it when it was named; it is checked again here (readableEffect: its
// known parts, every bound) because a viewer runs what it draws.
const stored = new Map();          // blob name → doc | null (refused) | Promise
const waiting = new Map();         // blob name → Set of ids to re-apply when it lands
function lookup(name) { const d = stored.get(name); return d && typeof d.then !== 'function' ? d : null; }
function fetchEffect(name, id) {
  (waiting.get(name) ?? waiting.set(name, new Set()).get(name)).add(id);
  if (stored.has(name)) return;
  stored.set(name, sendRequest('effect', { name }).then((r) => {
    // the unknown-field policy (lead 10-17): keep the parts this build knows (readableEffect), so a document using an
    // addition this client predates draws what it can instead of nothing
    const doc = r?.ok && r.effect ? readableEffect(r.effect) : null;
    if (!doc) console.warn(`[emitters] effect ${name}: ${r?.refused?.reason ?? (r?.effect ? effectProblem(r.effect) : 'not stored here')}`);
    stored.set(name, doc);
    for (const x of waiting.get(name) ?? []) { const v = lastValue.get(x); if (v !== undefined) applyFrom(x, v); }
    waiting.delete(name);
  }).catch(() => { stored.delete(name); }));
}
const lastValue = new Map();       // id → the stored value last seen (what a landed effect re-applies)
/** A stored effect document this viewer has loaded, by blob name (the inspector's knobs read it), or null. */
export const effectLookup = (name) => lookup(name);

// ---- build -----------------------------------------------------------------

/** A viewer's share of particles: its tier (the governor lowers it). */
const budget = () => QUALITY_TIERS[tier] ?? 1;

async function build(resolved, { id }) {
  const ent = entities.get(id);
  // `null` is a spawn reservation whose GLB is still downloading, and an absent id is an entity that was removed under
  // us. Either way there is nothing to hang a local origin off, and a world-origin emitter is drift (#25 requirement 2).
  if (!ent) throw new Error(`entity ${id} is not in the scene`);
  // a part (picture.part, openable.part): its node, once the model has it; until then the thing itself, re-hung below
  const host = (resolved.part && findPart(ent, resolved.part)) || ent;
  const group = new THREE.Group();
  group.name = `particles_${id}_${resolved.effect}`;
  group.position.set(resolved.at[0], resolved.at[1], resolved.at[2]);
  group.scale.setScalar(resolved.scale);
  const parts = [];
  try {
    for (const [i, em] of resolved.emitters.entries()) {
      const map = await spriteTexture(em.render.texture);
      // each emitter of an effect its own stream: the instance's seed, then the emitter's place in the document
      const fx = buildEmitter(em, { map, seed: (resolved.seed + Math.imul(i, 0x9e3779b1)) >>> 0, name: `${group.name}_${i}`, budget });
      if (!resolved.playing) fx.setEmitting(false);
      parts.push(fx); group.add(fx.mesh);
    }
  } catch (e) { for (const fx of parts) fx.dispose(); throw e; }
  host.add(group);
  // The world owns this, not the sky: an async sky build that snapshots scene.children mid-flight must never claim (and
  // then dispose) somebody's hearth. And the weather sweep must not wet a fire.
  for (const o of [group, ...parts.map((p) => p.mesh)]) { o.userData.emitterOf = id; o.userData.entityId = id; o.userData.noWet = true; o.userData.noCloudShadow = true; }
  const update = ownHook(() => {
    if (resolved.part && group.parent === ent) { const p = findPart(ent, resolved.part); if (p) p.add(group); }   // the GLB landed
    const now = performance.now(); for (const fx of parts) fx.update(now); });
  autos().push(update);
  const handle = {
    id, update, mesh: group, parts,
    setEmitting(on) { for (const fx of parts) fx.setEmitting(on); },
    setTier() { /* drawn counts follow budget() every frame */ },
    dispose() {
      handles.delete(handle);
      group.parent?.remove(group);
      for (const fx of parts) fx.dispose();
      // NOT the texture: see textureCache above.
    },
  };
  handles.add(handle);         // last: nothing after this can throw and strand it
  return handle;
}

const registry = makeEmitterRegistry({
  autos: autos(),
  build,
  onError: (e, id) => console.warn(`[emitters] ${id}: ${e?.message ?? e}`),
});

// ---- wiring ----------------------------------------------------------------
// Deferred attach: a `comp` can (and on replay usually does) arrive before the
// entity's GLB has landed. The bag is already folded — perception is correct
// the whole time — so the emitter just waits for something to hang off.
const pending = new Map();

const sansPlaying = (r) => (r ? JSON.stringify({ ...r, playing: undefined, notes: undefined }) : null);
function applyFrom(id, data) {
  if (data == null) { lastValue.delete(id); pending.delete(id); void registry.apply(id, null); return; }
  lastValue.set(id, data);
  const norm = resolveParticles(data, { entityId: id, lookup });
  if (!norm.ok) {
    const name = effectBlobName(data?.effect);
    if (norm.pending && name) { fetchEffect(name, id); return; }   // it builds when the document lands
    // Legible, and only once per authoring: the component still folds, still persists, and still reads as an emitter
    // in every text-tier look().
    console.warn(`[emitters] ${id}: ${norm.why}`);
    void registry.apply(id, null);
    return;
  }
  if (norm.notes?.length) console.warn(`[emitters] ${id}: ${norm.notes.join(' · ')}`);
  delete norm.notes;
  if (!entities.get(id)) { pending.set(id, norm); return; }
  pending.delete(id);
  // only playing changed: the same emitter stops or resumes spawning (Godot's emitting), nothing is rebuilt
  const cur = registry.emitterOf(id), h = registry.get(id);
  if (cur && h && sansPlaying(cur) === sansPlaying(norm) && cur.playing !== norm.playing) { h.setEmitting(norm.playing); cur.playing = norm.playing; return; }
  void registry.apply(id, norm);
}

bus.on('comp', ({ id, type, data }) => {
  if (type !== 'particles') return;
  applyFrom(id, data);
});

bus.on('entity', ({ id, kind }) => {
  if (kind === 'remove' || kind === 'demote') {
    // demote (residency §13.3): the entity's subtree left the scene with the
    // emitter mesh inside it — retire the handle or its per-frame hook keeps
    // ticking against a detached group. Promotion re-announces the comp bag
    // and the emitter re-attaches through the ordinary pending path.
    pending.delete(id);
    registry.retire(id);
  } else if (kind === 'spawn') {
    // a promote replaces the placeholder SUBTREE — an emitter attached to the
    // stand would survive as a live hook on a detached mesh, and the comp
    // re-announcement would hit the registry's same-key idempotence guard and
    // keep the stale handle (review B2). Retire first (no-op when none), so
    // the re-announced bag rebuilds on the real object.
    registry.retire(id);
    if (pending.has(id)) {
      const emitter = pending.get(id);
      pending.delete(id);
      void registry.apply(id, emitter);
    }
  }
});

bus.on('world-reset', () => clearEmitters());

// ---- the presence tier of a held thing (grabbable.fx) -----------------------
// While a holder presses use, every client draws the thing's own fx (a hose's spray, a muzzle flash), from its
// component data and the holder's presence (pose.use): never a stream of logged acts. Its own registry, keyed
// fx:<id>, so it never replaces the thing's own particles component; the emitter hangs off the thing at fx.at.
const fxRegistry = makeEmitterRegistry({
  autos: autos(),
  build: (emitter, { id }) => build(emitter, { id: id.slice(3) }),
  onError: (e, id) => console.warn(`[emitters] ${id}: ${e?.message ?? e}`),
});
const fxOn = new Set();
/** Turn a held thing's fx on (fx = grabbable.fx {particles, at}) or off (null). Idempotent. */
export function setPressFx(id, fx) {
  if (!fx) { if (fxOn.delete(id)) void fxRegistry.apply(`fx:${id}`, null); return; }
  if (!entities.get(id)) return;
  const norm = resolveParticles(fx.particles, { entityId: id, lookup });
  if (!norm.ok) { if (norm.pending) fetchEffect(effectBlobName(fx.particles?.effect), id); if (fxOn.delete(id)) void fxRegistry.apply(`fx:${id}`, null); return; }
  delete norm.notes; norm.at = fx.at ?? norm.at;   // a held thing's fx hangs at fx.at
  fxOn.add(id); void fxRegistry.apply(`fx:${id}`, norm);
}
export const pressFxOn = () => [...fxOn];

/** World teardown (a world switch, a reset): every emitter goes, and the
 *  global hook array comes back to where it started. */
export function clearEmitters() {
  pending.clear(); lastValue.clear();
  registry.retireAll();
  fxRegistry.retireAll(); fxOn.clear();
  for (const h of [...handles]) retireEmitter(h, autos());
  handles.clear();
}

export { registry as _registry };
