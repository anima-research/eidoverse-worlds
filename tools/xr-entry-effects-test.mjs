// bun tools/xr-entry-effects-test.mjs — the ENTRY EFFECT OWNER, executed, not source-checked.
//
// WHY THIS EXISTS. The round-two reviewer mutated the shipping xr.js so every busy verdict entered
// the retry branch, including give-up:
//     if (true) { // MUTANT: every busy verdict retries
// and xr-entry-policy-test still passed 31/31 — because it drove the pure policy correctly and then
// checked the WIRING with regexes. Reproduced here before writing a line of this file.
//
// This suite imports client/lib/xr_entry_effects.js — the same module xr.js imports — and runs it
// with fake timers. Breaking the scheduling breaks this.
import { makeEntryEffects } from '../client/lib/xr_entry_effects.js';
import { decideEntryFailure } from '../client/lib/xr_entry_policy.js';
import { readFileSync } from 'node:fs';

let pass = 0, fail = 0;
const check = (n, ok, extra = '') => { if (ok) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${n}`); }
  else { fail++; console.log(`  \x1b[31m✗\x1b[0m ${n}${extra ? ` — ${extra}` : ''}`); } };

// a fake clock: timers fire only when we say so, so "1.5 s later" is a function call
function rig() {
  const log = { tee: [], toast: [], enters: [], absent: [] };
  let seq = 0; const timers = new Map();
  const eff = makeEntryEffects({
    setTimer: (fn, ms) => { const id = ++seq; timers.set(id, { fn, ms }); return id; },
    clearTimer: (id) => timers.delete(id),
    tee: (m) => log.tee.push(m), toast: (m, k) => log.toast.push([m, k]),
    enter: (o) => log.enters.push(o), markAbsent: (v) => log.absent.push(v),
  });
  return { eff, log, timers,
    fire: () => { const live = [...timers.entries()]; timers.clear(); live.forEach(([, t]) => t.fn()); return live.length; } };
}
const busy = () => Object.assign(new Error('there is already an active, immersive XRSession'), { name: 'InvalidStateError' });
const noDev = () => Object.assign(new Error('no XR device found'), { name: 'NotFoundError' });
const weird = () => Object.assign(new Error('something else entirely'), { name: 'DataError' });
// the REAL policy drives the effects, so the two are bound end to end
const onBusy = (isRetry) => decideEntryFailure(busy(), { isRetry, gpu: false });

console.log('\n— 1. exactly one automatic retry per entry intent (the reviewer’s mutation) —');
{
  const { eff, log, fire } = rig();
  check('a first busy failure schedules exactly one delayed retry',
    eff.apply(onBusy(false), { intent: 1 }) === 'retried' && eff.hasPending);
  const fired = fire();
  check('…and the timer, when it fires, re-enters carrying its intent',
    fired === 1 && log.enters.length === 1 && log.enters[0].retryOf === 1, JSON.stringify(log.enters));
  // the retry's own failure is the SECOND one on this intent
  const second = eff.apply(onBusy(true), { intent: 1 });
  check('the SECOND busy failure on the same intent gives up', second === 'gave-up', `got ${second}`);
  check('…and schedules NOTHING (the mutation that kept the old suite green)', !eff.hasPending);
  check('…and says so out loud, once', log.toast.filter(([, k]) => k === 'warn').length === 1);
}

console.log('\n— 2. a stale callback can never request a session —');
{
  const { eff, log, fire } = rig();
  eff.apply(onBusy(false), { intent: 1 });
  eff.apply(onBusy(false), { intent: 2 });          // a NEW click supersedes the first
  check('a newer entry intent takes ownership of the pending retry', eff.pendingFor === 2);
  fire();
  check('only ONE re-entry happens, and it belongs to the newer intent',
    log.enters.length === 1 && log.enters[0].retryOf === 2, JSON.stringify(log.enters));
}
{
  const { eff, log, fire } = rig();
  eff.apply(onBusy(false), { intent: 1 });
  eff.cancel('leave');                                // leaveVR's path
  check('cancel clears the pending flag', !eff.hasPending && eff.pendingFor === null);
  check('…and a fired stale timer requests nothing', fire() === 0 && log.enters.length === 0);
}
{
  // the nastiest ordering: the timer fires but a newer intent took over in between
  const { eff, log } = rig();
  const captured = [];   // keep EVERY scheduled callback, so intent 1's can fire after intent 2 exists
  const eff2 = makeEntryEffects({
    setTimer: (fn) => { captured.push(fn); return captured.length; }, clearTimer: () => {},
    tee: (m) => log.tee.push(m), toast: () => {}, enter: (o) => log.enters.push(o), markAbsent: () => {},
  });
  eff2.apply(onBusy(false), { intent: 1 });
  eff2.apply(onBusy(false), { intent: 2 });   // intent 2 now owns it
  captured[0]();                               // intent 1's timer fires late — it must NOT enter
  check('a late timer from a superseded intent drops instead of entering',
    log.enters.length === 0, JSON.stringify(log.enters));
  check('…and says why', log.tee.some((m) => /dropped/.test(m)));
}

console.log('\n— 3. an explicit click after give-up starts a fresh budget —');
{
  const { eff, log, fire } = rig();
  eff.apply(onBusy(false), { intent: 1 }); fire();
  eff.apply(onBusy(true), { intent: 1 });                 // gave up
  const again = eff.apply(onBusy(false), { intent: 2 });  // the user clicks the visor again
  check('a new click retries again (retryOf is null, so it is a first failure)', again === 'retried');
  check('…and it is the new intent that owns it', eff.pendingFor === 2);
  fire();
  check('…and it re-enters once more', log.enters.length === 2);
}

console.log('\n— 4. the other three verdicts are ACTED ON, not just decided —');
{
  const { eff, log } = rig();
  const err = noDev();
  check('an absent verdict marks the headset absent',
    eff.apply(decideEntryFailure(err, { gpu: false }), { intent: 1, error: err }) === 'absent' && log.absent[0] === true);
  check('…and carries the policy’s wording onto the error for the outer catch',
    /no headset detected/.test(err.userMessage ?? ''));
  const e2 = weird();
  check('a WebGPU refusal reloads and does NOT mark absent',
    eff.apply(decideEntryFailure(e2, { gpu: true }), { intent: 1, error: e2 }) === 'reload' && log.absent.length === 1);
  const e3 = weird();
  check('an unknown error on WebGL surfaces', eff.apply(decideEntryFailure(e3, { gpu: false }), { intent: 1, error: e3 }) === 'surface');
  check('…and surfacing schedules nothing', !eff.hasPending);
}

console.log('\n— 5. the PRODUCT uses this owner (the wiring the reviewer broke) —');
{
  const xr = readFileSync(new URL('../client/lib/xr.js', import.meta.url), 'utf8');
  check('xr.js imports the effect owner', /import \{ makeEntryEffects \} from '\.\/xr_entry_effects\.js'/.test(xr));
  check('xr.js constructs it with real timers', /makeEntryEffects\(\{[\s\S]*?setTimeout/.test(xr));
  check('the entry catch delegates to it rather than scheduling inline',
    /entryEffects\.apply\(verdict, \{ intent: myEntry, error: e \}\)/.test(xr));
  check('NO setTimeout survives in the entry catch path', !/busyTimer = setTimeout/.test(xr));
  check('leaveVR cancels through the owner before its no-session return',
    xr.indexOf('entryEffects.hasPending') < xr.indexOf("if (!session) { tee(`[xr] leave"));
}

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
