// sky_bakelock — one bake at a time over the sky engine's bakeEnv: every bake shares the engine's single _envTarget,
// and a bake that swaps in a temporary target (the VR prebuild) must not have another draw into it. Pure (no GPU,
// no three), so test/client/sky-bakelock-test.mjs drives it under node.
export const BAKE_INTERCEPT = Symbol.for('ew.bakeIntercept');   // the same symbol sky_baked.js exports (Symbol.for)
export const BAKE_GUARD = Symbol.for('ew.bakeGuard');
export const BAKE_AFTER = Symbol.for('ew.bakeAfter');
export const BAKE_HELD = Symbol.for('ew.bakeHeld');   // the caller already holds the lock (the prebuild's own bake)
export function serializeBakes(sys, { log = () => {}, report = () => {} } = {}) {
  if (!sys?.bakeEnv || sys.__rawBakeEnv) return;
  const raw = sys.bakeEnv.bind(sys);
  let tail = Promise.resolve();
  sys.__rawBakeEnv = raw;
  sys.__withBakeLock = (fn) => { const run = tail.then(fn, fn); tail = run.catch(() => {}); return run; };
  // Options, all read inside the lock: BAKE_GUARD() false skips a queued bake that is no longer wanted; BAKE_AFTER({ ok,
  // skipped }) runs exactly once after the bake, before the next can touch _envTarget (must not throw or await the lock).
  // A bake queued for a torn-down sky is skipped: nothing would free what it built.
  sys.bakeEnv = (r, o, ...rest) => (o?.[BAKE_HELD] ? raw(r, o, ...rest) : sys.__withBakeLock(async () => {
    const after = (res) => { try { o?.[BAKE_AFTER]?.(res); } catch (e) { report('sky bake (after)', e); } };
    if (sys.__dead) { log('[sky] a bake queued for a torn-down sky: skipped'); after({ ok: false, skipped: true }); return; }
    if (o?.[BAKE_GUARD] && !o[BAKE_GUARD]()) { after({ ok: false, skipped: true }); return; }
    const restore = o?.[BAKE_INTERCEPT]?.();
    let ok = false;
    try { const v = await raw(r, o, ...rest); ok = true; return v; } finally { restore?.(); after({ ok, skipped: false }); }
  }));
}
