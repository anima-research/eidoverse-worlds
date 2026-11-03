// sky-bakelock-test — the sky's ONE-BAKE-AT-A-TIME wrapper (client/lib/sky_bakelock.js), headless.
//   node tools/sky-bakelock-test.mjs      (or bun)
// A fake engine: bakeEnv awaits a promise the test resolves, and reads/writes _envTarget the way sky_system's does.
// Review 10b H2: when bake N resolved, a bake queued behind it (the VR prebuild, which swaps a TEMPORARY target in)
// started BEFORE the awaiting caller's continuation, so the baked dome attached to the temporary. The fix runs the
// post-bake work inside the lock (BAKE_AFTER); a queued bake re-checks whether it's still wanted at its turn (BAKE_GUARD).
import { serializeBakes, BAKE_AFTER, BAKE_GUARD, BAKE_HELD } from '../client/lib/sky_bakelock.js';
let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) { pass++; console.log(`  ok    ${n}`); } else { fail++; console.log(`  FAIL  ${n}  ${d}`); } };
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const within = (p, ms = 2000) => Promise.race([p, new Promise((r) => setTimeout(r, ms))]);   // a deadlocked mutant fails, not hangs
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

console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
