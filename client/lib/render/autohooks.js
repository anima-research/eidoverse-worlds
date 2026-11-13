// autohooks — who owns what in the engine's per-frame hook array.
//
// `globalThis._autoParticleSystems` is a global the toolkit drains every frame (sky.js's
// updateAutoSystems), pushed into by the sky, the meadow and entity emitters. A subsystem that
// claims its entries by DIFFING the array around an async build would also claim a hook someone
// else registered meanwhile. Rule: a host subsystem marks the per-frame hooks it keeps, and a
// claim-by-diff skips marked hooks.
//
// DOM-free and THREE-free; unit-tested in test/client/particles-test.ts.

/** The engine's hook array, created on demand. Never captured in a module
 *  const — the toolkit makes it lazily and this file may load first. */
export const autoHooks = () => (globalThis._autoParticleSystems ||= []);

/** Hooks a host subsystem owns and will retire itself. Identity, not index. */
const hostOwned = new Set();

/** Mark an already-registered hook as host-owned. Used when the hook was
 *  pushed by upstream code we called (makeParticles registers its own
 *  billboard update) rather than by us. */
export function ownHook(fn) {
  if (typeof fn === 'function') hostOwned.add(fn);
  return fn;
}

/** Register a host-owned per-frame hook. */
export function pushHostHook(fn) {
  autoHooks().push(ownHook(fn));
  return fn;
}

/** Unregister a hook by IDENTITY and drop its ownership mark. Returns whether
 *  it was actually in the array. Safe to call twice. */
export function releaseHook(fn, autos = autoHooks()) {
  if (typeof fn !== 'function') return false;
  hostOwned.delete(fn);
  if (!Array.isArray(autos)) return false;
  const i = autos.indexOf(fn);
  if (i >= 0) autos.splice(i, 1);
  return i >= 0;
}

export const isHostOwned = (fn) => hostOwned.has(fn);

/** What a claim-by-diff may call its own: hooks new since `before` (a Set snapshotted at build
 *  start) that no host subsystem has claimed — a hook registered during the build is new but not the builder's. */
export function claimUnowned(before, autos = autoHooks()) {
  const seen = before instanceof Set ? before : new Set(before ?? []);
  return (autos ?? []).filter((h) => !seen.has(h) && !hostOwned.has(h));
}
