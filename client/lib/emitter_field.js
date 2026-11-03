// emitter_field — the `particles` component's LIFECYCLE, DOM-free and
// THREE-free so it can be unit-tested without a browser (tools/particles-test.ts).
//
// The upstream builder (`eidoverse/particles.js`) is a one-way door: it makes a
// mesh, adds it to a scene, pushes its billboard `update` into the global
// `_autoParticleSystems` array, and hands back no way to undo any of that.
// Flora taught the same lesson and got `dispose()` upstream; until particles
// does, THIS is where the undo lives — one registry that owns every emitter in
// the world, so "replace the fire with smoke" retires the fire instead of
// stacking a second system and a second per-frame hook on top of it.
//
// Everything here is idempotent by construction: applying the same state twice
// is a no-op, removing something that is already gone is a no-op, and a build
// that finishes AFTER its own entity was replaced or removed retires itself on
// arrival rather than leaking into the scene.

import { releaseHook } from './autohooks.js';

/**
 * Retire one built emitter completely: unhook its per-frame update, release
 * its GPU resources, detach its mesh. Safe to call twice.
 *
 * Hooks come off by IDENTITY, never by index — the array is global and shared
 * with grass wind and the sky, so an index captured at build time means
 * unhooking somebody else's emitter.
 */
export function retireEmitter(handle, autos) {
  if (!handle || handle.retired) return;
  handle.retired = true;
  const hooks = handle.hooks ?? (handle.update ? [handle.update] : []);
  for (const h of hooks) releaseHook(h, autos);
  try {
    handle.dispose?.();
  } catch { /* a failed teardown must not strand the registry entry */ }
}

/**
 * Give back a RAW upstream system — one that `makeParticles()` has already
 * allocated but that no handle owns yet.
 *
 * This is the window the adapter promised to close and initially did not: the
 * moment the builder returns, its mesh is in the scene and its update is in
 * the global hook array. If any host step after that point throws (parenting,
 * marking, tier), `build()` rejects before a handle exists and the registry's
 * catch has nothing to retire. Every one of those steps therefore runs inside
 * `adoptSystem`, and this is what it unwinds to.
 *
 * Disposes what the SYSTEM owns — geometry and material — and never the
 * texture, which is cached and shared (see emitters.js).
 */
export function retireRawSystem(sys, autos) {
  if (!sys || sys.__retired) return;
  sys.__retired = true;
  releaseHook(sys.update, autos);
  const mesh = sys.mesh;
  if (!mesh) return;
  try {
    mesh.parent?.remove?.(mesh);
    mesh.geometry?.dispose?.();
    const m = mesh.material;
    if (Array.isArray(m)) m.forEach((x) => x?.dispose?.()); else m?.dispose?.();
  } catch { /* a failed teardown must not mask the error that caused it */ }
}

/**
 * Run the host's own attach steps over a freshly-built upstream system, and
 * unwind the raw allocation if any of them throws. The handle it returns is
 * the first moment anything else can retire this system, so everything before
 * it belongs here.
 */
export function adoptSystem(sys, autos, attach) {
  try {
    return attach(sys);
  } catch (e) {
    retireRawSystem(sys, autos);
    throw e;
  }
}

/**
 * The world's emitter registry.
 *
 * `build(emitter, {id, key})` is the host's (THREE-bound) half: it returns —
 * or resolves to — a handle `{mesh?, update?, hooks?, dispose()}`. `id` is the
 * owning ENTITY and `key` the component (`particles` or `particles:<name>`).
 * `autos` is the per-frame hook array the engine drains
 * (`globalThis._autoParticleSystems`).
 *
 * `apply(slot, emitter, {entity, key})` is the ONLY entry point the fold uses:
 * pass the normalized emitter to attach or replace, `null` to end it. `slot`
 * names one emitter — one per (entity, component); with one emitter per entity
 * the slot can simply be the entity id, which is what `entity` defaults to.
 */
export function makeEmitterRegistry({ autos, build, onError } = {}) {
  /** slot -> { gen, key, entity, component, handle|null, emitter } — one live
   *  emitter per (entity, component). `key` is the emitter's identity for the
   *  idempotence check; `entity` lets an entity's removal retire all of them. */
  const live = new Map();
  let gen = 0;

  const keyOf = (emitter) => (emitter ? JSON.stringify(emitter) : null);

  async function apply(id, emitter, { entity = id, key: component = 'particles' } = {}) {
    const key = keyOf(emitter);
    const cur = live.get(id);
    // Idempotence: re-authoring the identical bag (a replay of the same entry,
    // a snapshot that repeats what the log already said) must not rebuild the
    // fire — a rebuilt emitter re-rolls nothing (the seed is stable) but it
    // does churn GPU resources and re-registers a hook.
    if (cur && cur.key === key) return cur.handle;

    const mine = ++gen;
    // Retire the old one FIRST. Replacement is not two emitters overlapping
    // for the duration of an await: the world says one thing is burning there.
    if (cur) {
      retireEmitter(cur.handle, autos);
      live.delete(id);
    }
    if (!emitter) return null;

    const slot = { gen: mine, key, entity, component, handle: null, emitter };
    live.set(id, slot);
    let handle = null;
    try {
      handle = await build(emitter, { id: entity, key: component });
    } catch (e) {
      if (live.get(id) === slot) live.delete(id);
      onError?.(e, id);
      return null;
    }
    // The entity was replaced, removed, or the world was cleared while the
    // texture downloaded. Whatever we just built belongs to nobody: retire it
    // here or it is a mesh in the scene with no entry to reach it by.
    if (live.get(id) !== slot) {
      retireEmitter(handle, autos);
      return null;
    }
    slot.handle = handle;
    return handle;
  }

  function retire(id) {
    const cur = live.get(id);
    if (!cur) return false;
    live.delete(id);           // delete BEFORE retiring: an in-flight build
    retireEmitter(cur.handle, autos);  // sees the slot is gone and retires itself
    return true;
  }

  function retireAll() {
    for (const id of [...live.keys()]) retire(id);
  }

  /** Every emitter an entity owns — its removal, demotion or replacement takes
   *  them all, whatever their names. Returns how many went. */
  function retireEntity(entity) {
    let n = 0;
    for (const [slot, cur] of [...live.entries()]) if (cur.entity === entity && retire(slot)) n++;
    return n;
  }

  return {
    apply,
    retire,
    retireAll,
    retireEntity,
    slotsOf: (entity) => [...live.entries()].filter(([, cur]) => cur.entity === entity).map(([slot]) => slot),
    has: (id) => live.has(id),
    get: (id) => live.get(id)?.handle ?? null,
    emitterOf: (id) => live.get(id)?.emitter ?? null,
    get size() { return live.size; },
  };
}
