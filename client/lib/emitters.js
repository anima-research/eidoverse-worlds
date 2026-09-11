// emitters — the browser host for the `particles` component.
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
import { entities, findPart } from './world.js';
import { normalizeParticles, resolvedCount, withSeededRandom, QUALITY_TIERS } from '../../shared/particles.js';
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

async function build(emitter, { id }) {
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
  const sys = withSeededRandom(emitter.seed, () => globalThis.makeParticles({
    scene,                       // the builder adds the mesh here…
    preset: emitter.preset,
    map,
    count: builtCount,
    origin: [0, 0, 0],           // …and we re-parent it, so the origin is the entity's
    ...(emitter.size != null ? { size: emitter.size } : {}),
    ...(emitter.opacity != null ? { opacity: emitter.opacity } : {}),
    ...(emitter.speed != null ? { speed: emitter.speed } : {}),
    ...(emitter.lifetime != null ? { lifetime: emitter.lifetime } : {}),
    ...(emitter.area != null ? { area: emitter.area } : {}),
    name: `particles_${id}_${emitter.preset}`,
  }));
  if (!sys?.mesh) throw new Error('makeParticles returned no mesh');
  // From here the mesh is in the scene and the update is in the global hook
  // array — allocated, and owned by nobody until a handle exists. Everything
  // below therefore runs inside adoptSystem, which unwinds the raw system if
  // any of it throws.
  ownHook(sys.update);           // ours, so no diffing subsystem may claim it

  return adoptSystem(sys, autos(), () => {
    // A part-relative origin is in the named node's local frame. Parenting
    // composes the entire animated hierarchy, including entity mounts/motion.
    // Missing parts keep the emitter visible in the entity frame; the server
    // records the advisory and this client reports its own realization.
    const part = emitter.part ? findPart(parent, emitter.part) : null;
    if (emitter.part && !part) console.warn(`[emitters] ${id}: part "${emitter.part}" unavailable — using the entity frame`);
    sys.mesh.position.set(emitter.origin[0], emitter.origin[1], emitter.origin[2]);
    (part ?? parent).add(sys.mesh);
    sys.mesh.userData.emitterOf = id;
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
  onError: (e, id) => console.warn(`[emitters] ${id}: ${e?.message ?? e}`),
});

// ---- wiring ----------------------------------------------------------------
// Deferred attach: a `comp` can (and on replay usually does) arrive before the
// entity's GLB has landed. The bag is already folded — perception is correct
// the whole time — so the emitter just waits for something to hang off.
const pending = new Map();

function applyFrom(id, data) {
  const norm = data == null ? { ok: true, emitter: null } : normalizeParticles(data, { entityId: id });
  if (!norm.ok) {
    // Legible, and only once per authoring: the component still folds, still
    // persists, and still reads as an emitter in every text-tier look().
    console.warn(`[emitters] ${id}: ${norm.why}`);
    void registry.apply(id, null);
    return;
  }
  if (norm.notes?.length) console.warn(`[emitters] ${id}: ${norm.notes.join(' · ')}`);
  if (norm.emitter && !entities.get(id)) {
    pending.set(id, norm.emitter);
    return;
  }
  pending.delete(id);
  void registry.apply(id, norm.emitter);
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

/** World teardown (a world switch, a reset): every emitter goes, and the
 *  global hook array comes back to where it started. */
export function clearEmitters() {
  pending.clear();
  registry.retireAll();
  for (const h of [...handles]) retireEmitter(h, autos());
  handles.clear();
}

export { registry as _registry };
