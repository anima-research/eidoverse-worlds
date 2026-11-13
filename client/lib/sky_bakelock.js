// sky_bakelock — ONE BAKE AT A TIME over the sky engine's bakeEnv, kept out of sky.js so a node test can drive it
// (tools/sky-bakelock-test.mjs). No GPU, no three: it only wraps a function.
export const BAKE_INTERCEPT = Symbol.for('ew.bakeIntercept');   // the same symbol sky_baked.js exports (Symbol.for)
export const BAKE_GUARD = Symbol.for('ew.bakeGuard');
export const BAKE_AFTER = Symbol.for('ew.bakeAfter');
export const BAKE_HELD = Symbol.for('ew.bakeHeld');   // the caller already holds the lock (the prebuild's own bake)
// ONE BAKE AT A TIME (owner's rig 09-27 22:24–22:30: the VR sky went black). Every bake shares the engine's single
// _envTarget and _envBake. The VR prebuild swapped a temporary target in and held it for its whole cold link (11 min);
// meanwhile the live tier's env bake and then the VR cap's 4096 bake ran INTO that temporary; when the prebuild finished
// it put the old target back and disposed the temporary, which was the target the cap's bake had just drawn: attach
// failed, black sky. Now every sys.bakeEnv (all callers go through it) queues behind the one before, and the prebuild
// holds the queue around its whole swap. A queued bake for a torn-down sky still runs (bakeEnv checks nothing), but
// the callers already stop on a generation/skyApi change.
export function serializeBakes(sys, { log = () => {}, report = () => {} } = {}) {
  if (!sys?.bakeEnv || sys.__rawBakeEnv) return;
  const raw = sys.bakeEnv.bind(sys);
  let tail = Promise.resolve();
  sys.__rawBakeEnv = raw;
  sys.__withBakeLock = (fn) => { const run = tail.then(fn, fn); tail = run.catch(() => {}); return run; };
  // a bake still queued when its sky is torn down is skipped: it would rebuild a target and a giant graph on the dead
  // system that nothing frees, and on a cold cache the next sky's bake would wait on its link (review 7, H1)
  // BAKE_GUARD (a function, optional): asked INSIDE the lock, right before the bake; false skips it. A bake queued behind
  // a minutes-long one decides whether it's still wanted when its turn comes, not when it queued (review 10b H2).
  // BAKE_AFTER (a function, optional): called INSIDE the lock once the bake is done (or skipped/failed), with
  // { ok, skipped }. Whatever reads the engine's _envTarget/_envBake after a bake (the baked-dome attach, adopting the
  // env) must run here: once the lock is released, a queued bake (the VR prebuild's temporary 64x32 target, the live
  // tier's 512x256 resize) can swap or resize them before an awaiting caller's continuation runs (review 10b H2).
  // It's called exactly once, synchronously; it must not throw or await the lock.
  sys.bakeEnv = (r, o, ...rest) => (o?.[BAKE_HELD] ? raw(r, o, ...rest) : sys.__withBakeLock(async () => {
    const after = (res) => { try { o?.[BAKE_AFTER]?.(res); } catch (e) { report('sky bake (after)', e); } };
    if (sys.__dead) { log('[sky] a bake queued for a torn-down sky: skipped'); after({ ok: false, skipped: true }); return; }
    if (o?.[BAKE_GUARD] && !o[BAKE_GUARD]()) { after({ ok: false, skipped: true }); return; }
    const restore = o?.[BAKE_INTERCEPT]?.();
    let ok = false;
    try { const v = await raw(r, o, ...rest); ok = true; return v; } finally { restore?.(); after({ ok, skipped: false }); }
  }));
}
