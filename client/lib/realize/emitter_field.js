// emitter_field — the `particles` component's lifecycle, DOM- and THREE-free (test/client/particles-test.ts).
//
// A built emitter adds a mesh to the scene and a hook to the shared per-frame array (autohooks.js), and only its
// owner's dispose() takes them back out; this registry owns every emitter so a replacement retires the old one
// instead of stacking a second system. Idempotent: the same state twice is a no-op, and a build that finishes after its entity was replaced
// retires itself.

import { releaseHook } from '../render/autohooks.js';

/** Retire one built emitter: unhook its per-frame update, release its GPU resources, detach its mesh. Safe to call
 *  twice. Hooks come off by identity, never by index: the array is shared with grass wind and the sky. */
export function retireEmitter(handle, autos) {
  if (!handle || handle.retired) return;
  handle.retired = true;
  const hooks = handle.hooks ?? (handle.update ? [handle.update] : []);
  for (const h of hooks) releaseHook(h, autos);
  try {
    handle.dispose?.();
  } catch { /* a failed teardown must not strand the registry entry */ }
}

/** Give back a raw system (mesh in the scene, hook registered) not yet owned by a handle: what `adoptSystem`
 *  unwinds to when an attach step throws. Disposes geometry and material, never the texture (emitters.js's cache). */
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

/** Run the host's attach steps over a fresh upstream system; unwind the raw allocation if one throws. */
export function adoptSystem(sys, autos, attach) {
  try {
    return attach(sys);
  } catch (e) {
    retireRawSystem(sys, autos);
    throw e;
  }
}

/** The world's emitter registry. `build(emitter, {id})` is the host's (THREE-bound) half: it returns, or resolves
 *  to, a handle `{mesh?, update?, hooks?, dispose()}`. `autos` is the per-frame hook array the frame loop drains.
 *  `apply(id, emitter)` is the only entry point the fold uses: the normalized emitter to attach or replace, `null`
 *  to end it. */
export function makeEmitterRegistry({ autos, build, onError } = {}) {
  /** id -> { gen, key, handle|null, emitter } — one live emitter per entity. */
  const live = new Map();
  let gen = 0;

  const keyOf = (emitter) => (emitter ? JSON.stringify(emitter) : null);

  async function apply(id, emitter) {
    const key = keyOf(emitter);
    const cur = live.get(id);
    // the identical bag (a replay, a snapshot) must not churn GPU resources or re-register a hook
    if (cur && cur.key === key) return cur.handle;

    const mine = ++gen;
    // retire the old one first: never two emitters overlapping across the await
    if (cur) {
      retireEmitter(cur.handle, autos);
      live.delete(id);
    }
    if (!emitter) return null;

    const slot = { gen: mine, key, handle: null, emitter };
    live.set(id, slot);
    let handle = null;
    try {
      handle = await build(emitter, { id });
    } catch (e) {
      if (live.get(id) === slot) live.delete(id);
      onError?.(e, id);
      return null;
    }
    // Replaced, removed or cleared while building: retire it, or it is a mesh with no entry to reach it by.
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

  return {
    apply,
    retire,
    retireAll,
    has: (id) => live.has(id),
    get: (id) => live.get(id)?.handle ?? null,
    emitterOf: (id) => live.get(id)?.emitter ?? null,
    /** The same emitter stops or resumes spawning (emitters.js's playing-only path): the slot's key follows, so the bag it
     *  now matches is recognised as already applied. */
    setPlaying(id, on) { const s = live.get(id); if (!s) return false; s.emitter.playing = on; s.key = keyOf(s.emitter); s.handle?.setEmitting?.(on); return true; },
    get size() { return live.size; },
  };
}
