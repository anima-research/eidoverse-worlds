// emitters — the browser host for the `particles` / `particles:<name>` components.
//
// Owns the THREE/DOM-bound half: eval-loading the toolkit's particle builder
// off the library route, priming and caching sprite textures, building each
// emitter with a DETERMINISTIC random stream, parenting it to the entity that
// owns it, and handing the resulting handle to the registry that knows how to
// take it back out again.
//
// The split mirrors flora:
//   particles.js      — what a `particles` bag MEANS (shared with the mcpl agent)
//   emitter_field.js  — lifecycle/registry, DOM-free and unit-tested
//   this file         — hosting
//
// Two upstream facts shape everything here, both named in eidoverse-worlds #25:
//
//   1. `makeParticles` seeds its per-instance spawn attributes from
//      `Math.random()`. Two clients would therefore render two different fires
//      from one authored component, and a reconnect would render a third. The
//      build call is synchronous, so the seam is a scoped swap of Math.random
//      (`withSeededRandom`) around exactly that call — and nothing else.
//   2. It has no `dispose()` and pushes its billboard `update` into the global
//      `_autoParticleSystems` array with no way to unregister. Retirement is
//      therefore ours: identity-splice the hook, dispose the geometry and
//      material we own, detach the mesh.
//
// Both are adapter-side ON PURPOSE, in one function each, so that when the
// engine grows a `seed` option and a `dispose()` (as `createFlora` already
// did) this file loses code rather than gaining a second path.

import { THREE, scene } from './core.js';
import { bus } from './base.js';
import { loadEidoModule, primeFiles } from './assets.js';
import { entities } from './world.js';
import { normalizeParticles, resolvedCount, withSeededRandom, builderOverrides, isParticlesKey, QUALITY_TIERS } from '../../shared/particles.js';
import { makeEmitterRegistry, retireEmitter, adoptSystem } from './emitter_field.js';
import { autoHooks as autos, ownHook } from './autohooks.js';

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

// ---- build -----------------------------------------------------------------

async function build(emitter, { id, key = 'particles' }) {
  const parent = entities.get(id);
  // `null` is a spawn reservation whose GLB is still downloading, and an
  // absent id is an entity that was removed under us. Either way there is
  // nothing to hang a local origin off, and a world-origin emitter is the
  // drift #25 names in requirement 2 — so we don't build one.
  if (!parent) throw new Error(`entity ${id} is not in the scene`);
  await loadEidoModule('particles.js');
  const map = await spriteTexture(emitter.texture);
  // The AUTHORED cap decides how many instances exist at all — allocating 600
  // sprites for an emitter its author capped at a quarter wastes the memory on
  // every machine. The local tier then draws fewer still, without a rebuild.
  const builtCount = resolvedCount(emitter, 'auto');

  // The scoped-determinism seam. `makeParticles` is fully synchronous, so
  // nothing else in this tab can observe the swapped Math.random.
  // Every authored override goes to the builder as-is: upstream merges opts
  // over the preset (`Object.assign({}, base, opts)`), so sway, velocities,
  // gravity, growth, swirl, twinkle, taper, spin, colour and blending are all
  // the preset's defaults until a bag says otherwise (shared/particles.js
  // bounds and names them).
  const sys = withSeededRandom(emitter.seed, () => globalThis.makeParticles({
    scene,                       // the builder adds the mesh here…
    preset: emitter.preset,
    map,
    count: builtCount,
    origin: [0, 0, 0],           // …and we re-parent it, so the origin is the entity's
    ...builderOverrides(emitter),
    name: `particles_${id}_${key === 'particles' ? '' : `${key.slice(10)}_`}${emitter.preset}`,
  }));
  if (!sys?.mesh) throw new Error('makeParticles returned no mesh');
  // From here the mesh is in the scene and the update is in the global hook
  // array — allocated, and owned by nobody until a handle exists. Everything
  // below therefore runs inside adoptSystem, which unwinds the raw system if
  // any of it throws.
  ownHook(sys.update);           // ours, so no diffing subsystem may claim it

  return adoptSystem(sys, autos(), () => {
    // Entity-relative, not world-origin: the emitter is a CHILD of the thing
    // that owns it, so it rides every place/mount/motion that thing does. The
    // authored origin is a local offset in the entity's own frame.
    sys.mesh.position.set(emitter.origin[0], emitter.origin[1], emitter.origin[2]);
    // `scale` is the emitter's OWN frame. The builder computes every sprite in
    // the mesh's local space (spawn offset + velocity·age + gravity + sway,
    // then a camera-facing quad of `size`), so scaling the mesh scales all of
    // it together and nothing else — the origin stays an entity-frame offset,
    // timing is untouched, and the entity's own scale still composes on top.
    // It is what lets a fire tuned at hearth size burn on a wick.
    sys.mesh.scale.setScalar(emitter.scale ?? 1);
    parent.add(sys.mesh);
    sys.mesh.userData.emitterOf = id;
    sys.mesh.userData.emitterKey = key;
    // The world owns this, not the sky: an async sky build that happens to
    // snapshot scene.children mid-flight must never claim (and then dispose)
    // somebody's hearth. Same marker entities and bodies carry.
    sys.mesh.userData.entityId = id;
    // …and the weather sweep must not wet a fire (or recompile its
    // instanced material mid-session trying)
    sys.mesh.userData.noWet = true;
    sys.mesh.userData.noCloudShadow = true;

    const handle = {
      id,
      key,
      update: sys.update,
      mesh: sys.mesh,
      builtCount,
      setTier(next) {
        // InstancedMesh draws `count` of its instances — thinning is a number,
        // not a rebuild, so the governor can act without a hitch (same lever
        // flora's density dial pulls).
        sys.mesh.count = Math.max(1, Math.min(builtCount, resolvedCount(emitter, next)));
      },
      dispose() {
        handles.delete(handle);
        (sys.mesh.parent ?? scene).remove(sys.mesh);
        sys.mesh.geometry?.dispose?.();
        const m = sys.mesh.material;
        if (Array.isArray(m)) m.forEach((x) => x?.dispose?.()); else m?.dispose?.();
        // NOT the texture: see textureCache above.
      },
    };
    handle.setTier(tier);
    handles.add(handle);         // last: nothing after this can throw and strand it
    return handle;
  });
}

const registry = makeEmitterRegistry({
  autos: autos(),
  build,
  onError: (e, slot) => console.warn(`[emitters] ${slot}: ${e?.message ?? e}`),
});

/** One registry slot per (entity, component). The default emitter's slot is
 *  the bare entity id — what it has always been — and a named one appends its
 *  key, so `particles` and `particles:smoke` on one hearth never collide. */
const slotOf = (id, key) => (key === 'particles' ? id : `${id}\u0000${key}`);
const label = (id, key) => (key === 'particles' ? id : `${id} ${key}`);

// ---- wiring ----------------------------------------------------------------
// Deferred attach: a `comp` can (and on replay usually does) arrive before the
// entity's GLB has landed. The bag is already folded — perception is correct
// the whole time — so the emitter just waits for something to hang off.
/** slot -> { id, key, emitter } */
const pending = new Map();

function applyFrom(id, key, data) {
  const slot = slotOf(id, key);
  const norm = data == null ? { ok: true, emitter: null } : normalizeParticles(data, { entityId: id, key });
  if (!norm.ok) {
    // Legible, and only once per authoring: the component still folds, still
    // persists, and still reads as an emitter in every text-tier look().
    console.warn(`[emitters] ${label(id, key)}: ${norm.why}`);
    pending.delete(slot);
    void registry.apply(slot, null, { entity: id, key });
    return;
  }
  if (norm.notes?.length) console.warn(`[emitters] ${label(id, key)}: ${norm.notes.join(' · ')}`);
  if (norm.emitter && !entities.get(id)) {
    pending.set(slot, { id, key, emitter: norm.emitter });
    return;
  }
  pending.delete(slot);
  void registry.apply(slot, norm.emitter, { entity: id, key });
}

bus.on('comp', ({ id, type, data }) => {
  if (!isParticlesKey(type)) return;
  applyFrom(id, type, data);
});

const pendingOf = (id) => [...pending.entries()].filter(([, p]) => p.id === id);

bus.on('entity', ({ id, kind }) => {
  if (kind === 'remove' || kind === 'demote') {
    // demote (residency §13.3): the entity's subtree left the scene with the
    // emitter meshes inside it — retire the handles or their per-frame hooks
    // keep ticking against a detached group. Promotion re-announces the comp
    // bag and the emitters re-attach through the ordinary pending path. ALL of
    // the entity's emitters, whatever their names.
    for (const [slot] of pendingOf(id)) pending.delete(slot);
    registry.retireEntity(id);
  } else if (kind === 'spawn') {
    // a promote replaces the placeholder SUBTREE — an emitter attached to the
    // stand would survive as a live hook on a detached mesh, and the comp
    // re-announcement would hit the registry's same-key idempotence guard and
    // keep the stale handle (review B2). Retire first (no-op when none), so
    // the re-announced bag rebuilds on the real object.
    registry.retireEntity(id);
    for (const [slot, p] of pendingOf(id)) {
      pending.delete(slot);
      void registry.apply(slot, p.emitter, { entity: id, key: p.key });
    }
  }
});

bus.on('world-reset', () => clearEmitters());

/** World teardown (a world switch, a reset): every emitter goes, and the
 *  global hook array comes back to where it started. */
export function clearEmitters() {
  pending.clear();
  registry.retireAll();
  for (const h of [...handles]) retireEmitter(h, autos());
  handles.clear();
}

export { registry as _registry };
