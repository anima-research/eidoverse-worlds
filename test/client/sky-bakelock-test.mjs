// sky-bakelock-test — the sky's ONE-BAKE-AT-A-TIME wrapper (client/lib/sky/sky_bakelock.js), headless.
//   bun test/client/sky-bakelock-test.mjs
// A fake engine: bakeEnv awaits a promise the test resolves, and reads/writes _envTarget the way sky_system's does.
// Review 10b H2: when bake N resolved, a bake queued behind it (the VR prebuild, which swaps a TEMPORARY target in)
// started BEFORE the awaiting caller's continuation, so the baked dome attached to the temporary. The fix runs the
// post-bake work inside the lock (BAKE_AFTER); a queued bake re-checks whether it's still wanted at its turn (BAKE_GUARD).
import { serializeBakes, BAKE_AFTER, BAKE_GUARD, BAKE_HELD, BAKE_INTERCEPT } from '../../client/lib/sky/sky_bakelock.js';
import { pause } from '../gate/wait.ts';
import { suite } from "../gate/suite.ts";
const S = suite("sky-bakelock");
const ok = (n, c, d) => S.check(n, c, d);
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const within = (p, ms = 2000) => Promise.race([p, pause('a deadlocked mutant fails, not hangs', ms)]);   // a deadlocked mutant fails, not hangs
const deferred = () => { let res, rej; const p = new Promise((a, b) => { res = a; rej = b; }); return { p, res, rej }; };

function engine() {
  const sys = { _envTarget: 'REAL', raws: [], gates: [] };
  sys.bakeEnv = async function (r, o) { const d = deferred(); this.raws.push(o); this.gates.push(d); await d.p; return 'baked'; };
  serializeBakes(sys);
  return sys;
}
// the VR prebuild's shape (sky.js prebuildBakeProgram): under the lock, swap a temporary target in, bake, put it back
const prebuild = (sys, log) => sys.__withBakeLock(async () => {
  log.push('prebuild starts'); const keep = sys._envTarget; sys._envTarget = 'TEMP';
  try { await sys.bakeEnv(null, { [BAKE_HELD]: true }); } finally { sys._envTarget = keep; log.push('prebuild restores'); }
});

// 1. H2: the post-bake read happens before the queued prebuild can swap the target
{
  const sys = engine(), log = [];
  let sawInAfter = null, sawAfterAwait = null;
  // the real call path: sky.js ensureSkyBake awaits sky_worlds' api.bakeEnv, an async function that awaits sys.bakeEnv
  const api = { async bakeEnv(o) { const opts = { ...o }; await sys.bakeEnv(null, opts); return api; } };
  const bake = (async () => {
    await api.bakeEnv({ [BAKE_AFTER]: () => { sawInAfter = sys._envTarget; log.push('after'); } });
    sawAfterAwait = sys._envTarget; log.push('caller continues');
  })();
  await flush();
  const pre = prebuild(sys, log);
  await flush();
  ok('the queued prebuild waits for the bake in flight', !log.includes('prebuild starts'), log.join(' > '));
  sys.gates[0].res(); await flush();
  ok('BAKE_AFTER sees the REAL target (it runs inside the lock)', sawInAfter === 'REAL', sawInAfter);
  ok('…and runs before the queued prebuild starts', log.indexOf('after') >= 0 && log.indexOf('after') < log.indexOf('prebuild starts'), log.join(' > '));
  // CONTROL — the measurement has a subject: the awaiting caller's continuation runs AFTER the prebuild swapped the
  // temporary in (the review's microtask order). Reading the target there is exactly what the fix moved away from.
  ok('control: an awaiting caller\'s continuation sees the TEMPORARY target (why the attach moved into BAKE_AFTER)', sawAfterAwait === 'TEMP', `${sawAfterAwait} / ${log.join(' > ')}`);
  ok('the prebuild\'s own bake (BAKE_HELD) ran inside its lock without deadlocking', sys.raws.length === 2 && sys.gates.length === 2, sys.raws.length);
  // a bake asked for WHILE the prebuild's own bake is in flight still queues (the prebuild used to step the wrapper
  // aside by swapping sys.bakeEnv for the raw bake for its whole await: anything called then ran straight into TEMP)
  let lateSaw = null;
  const late = sys.bakeEnv(null, { [BAKE_AFTER]: () => { lateSaw = sys._envTarget; } }); await flush();
  ok('a bake called during the prebuild\'s own bake waits for the prebuild', sys.raws.length === 2, sys.raws.length);
  sys.gates[1]?.res(); await within(pre); await flush();
  ok('…and runs on the REAL target once the prebuild has put it back', sys.raws.length === 3 && sys._envTarget === 'REAL', sys.raws.length);
  sys.gates[2]?.res(); await within(late); await within(bake);
  ok('…its BAKE_AFTER saw the REAL target', lateSaw === 'REAL', lateSaw);
  ok('the prebuild restored the real target', sys._envTarget === 'REAL');
}

// 2. BAKE_GUARD is asked at the bake's TURN, not when it queued
{
  const sys = engine();
  let wanted = true; const after = [];
  const first = sys.bakeEnv(null, {});
  const queued = sys.bakeEnv(null, { [BAKE_GUARD]: () => wanted, [BAKE_AFTER]: (r) => after.push(r) });
  await flush();
  wanted = false;                       // e.g. the VR entry, or the tier moved to a baked one, while it waited
  sys.gates[0].res(); await first; await flush();
  sys.gates[1]?.res(); await within(queued);
  ok('a queued bake no longer wanted at its turn does not run', sys.raws.length === 1, sys.raws.length);
  ok('…and its BAKE_AFTER is told it was skipped (exactly once)', after.length === 1 && after[0].skipped === true && after[0].ok === false, JSON.stringify(after));
  const n = sys.raws.length, third = sys.bakeEnv(null, { [BAKE_GUARD]: () => true });
  await flush(); ok('control: a wanted one runs', sys.raws.length === n + 1, sys.raws.length);
  sys.gates.at(-1).res(); await within(third);
}

// 3. a failed bake: BAKE_AFTER once with ok:false, the error still reaches the caller, and the lock is released
{
  const sys = engine(); const after = [];
  const b = sys.bakeEnv(null, { [BAKE_AFTER]: (r) => after.push(r) });
  await flush(); sys.gates[0].rej(new Error('boom'));
  let err = null; try { await b; } catch (e) { err = e; }
  ok('a failing bake rejects to its caller', err?.message === 'boom', err);
  ok('…BAKE_AFTER ran once with ok:false', after.length === 1 && after[0].ok === false && after[0].skipped === false, JSON.stringify(after));
  const next = sys.bakeEnv(null, {}); await flush();
  ok('…and the next bake still gets its turn', sys.raws.length === 2); sys.gates[1].res(); await next;
}

// 4. a torn-down sky: a queued bake is skipped and its BAKE_AFTER is told so
{
  const sys = engine(); const after = [];
  const first = sys.bakeEnv(null, {});
  const queued = sys.bakeEnv(null, { [BAKE_AFTER]: (r) => after.push(r) });
  await flush(); sys.__dead = true; sys.gates[0].res(); await first; await queued;
  ok('a bake queued for a torn-down sky is skipped, BAKE_AFTER told', sys.raws.length === 1 && after.length === 1 && after[0].skipped, JSON.stringify({ raws: sys.raws.length, after }));
}

// 5. hook × situation: INTERCEPT, GUARD and AFTER run inside the lock at their own bake's turn (after the bake ahead),
// each at most once; INTERCEPT's restore runs exactly once whenever INTERCEPT ran, thrown bake included
for (const sit of ['queued behind another', 'its bake throws', 'its sky is torn down while queued', 'its guard says no']) {
  const sys = engine(); let aheadDone = false;
  const seen = { intercept: [], restore: 0, guard: [], after: [] };
  const ahead = sys.bakeEnv(null, {});
  const mine = sys.bakeEnv(null, {
    [BAKE_INTERCEPT]: () => { seen.intercept.push(aheadDone); return () => { seen.restore++; }; },
    [BAKE_GUARD]: () => { seen.guard.push(aheadDone); return sit !== 'its guard says no'; },
    [BAKE_AFTER]: (r) => seen.after.push(r),
  }).catch((e) => e);
  await flush();
  const early = seen.intercept.length + seen.guard.length + seen.after.length;
  if (sit === 'its sky is torn down while queued') sys.__dead = true;
  aheadDone = true; sys.gates[0].res(); await ahead; await flush();
  if (sys.gates[1]) sit === 'its bake throws' ? sys.gates[1].rej(new Error('boom')) : sys.gates[1].res();
  await within(mine); await flush();
  const skipped = sit === 'its sky is torn down while queued' || sit === 'its guard says no';
  const want = {
    intercept: skipped ? [] : [true], restore: skipped ? 0 : 1, guard: sit === 'its sky is torn down while queued' ? [] : [true],
    after: [{ ok: sit === 'queued behind another', skipped }],
  };
  ok(`${sit}: nothing of its own ran while the bake ahead held the lock`, early === 0, JSON.stringify(seen));
  ok(`${sit}: each hook at its own turn, once; restore ${want.restore}`, JSON.stringify(seen) === JSON.stringify(want), `${JSON.stringify(seen)} want ${JSON.stringify(want)}`);
}
{
  // the holder's own bake (BAKE_HELD) runs raw: no second turn, no hooks of the lock's
  const sys = engine(); let intercepted = 0;
  const held = sys.__withBakeLock(() => sys.bakeEnv(null, { [BAKE_HELD]: true, [BAKE_INTERCEPT]: () => { intercepted++; } }));
  await flush(); ok('a BAKE_HELD bake runs inside its holder\'s lock at once', sys.raws.length === 1, sys.raws.length);
  sys.gates[0].res(); await within(held);
  ok('…and the lock runs none of its hooks', intercepted === 0, intercepted);
}

S.done();
