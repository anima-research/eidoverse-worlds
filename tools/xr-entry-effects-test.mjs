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
import { decideEntryFailure, BUSY_RETRY_MS } from '../client/lib/xr_entry_policy.js';
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
  const { eff, log, fire, timers } = rig();
  check('a first busy failure schedules exactly one delayed retry',
    eff.apply(onBusy(false), { intent: 101 }) === 'retried' && eff.hasPending);
  // THE BACKOFF VALUE, not merely that a timer exists (mutation sweep: `}, 0)` survived green —
  // the rig recorded `ms` and nothing ever read it, so an immediate re-request loop, the exact thing
  // the backoff prevents, was invisible).
  check('the timer is armed with the POLICY’s delay, not zero or a literal',
    [...timers.values()][0].ms === BUSY_RETRY_MS, `ms=${[...timers.values()][0]?.ms}`);
  const fired = fire();
  check('…and the timer, when it fires, re-enters carrying its intent',
    fired === 1 && log.enters.length === 1 && log.enters[0].retryOf === 101, JSON.stringify(log.enters));
  check('…and clears its own pending bookkeeping', eff.pendingFor === null && !eff.hasPending);
  // the retry's own failure is the SECOND one on this intent
  const second = eff.apply(onBusy(true), { intent: 101 });
  check('the SECOND busy failure on the same intent gives up', second === 'gave-up', `got ${second}`);
  check('…and schedules NOTHING (the mutation that kept the old suite green)', !eff.hasPending);
  check('…and says so out loud, once', log.toast.filter(([, k]) => k === 'warn').length === 1);
}

console.log('\n— 2. a stale callback can never request a session —');
{
  const { eff, log, fire, timers } = rig();
  eff.apply(onBusy(false), { intent: 101 });
  eff.apply(onBusy(false), { intent: 102 });          // a NEW click supersedes the first
  check('a newer entry intent takes ownership of the pending retry', eff.pendingFor === 102);
  // THE OLD TIMER MUST BE CLEARED, not merely out-voted by the intent guard (mutation sweep:
  // dropping cancel() survived, because the guard suppressed the stale entry while the timer leaked).
  check('…and the superseded timer is CLEARED, not left to fire and no-op', timers.size === 1, `${timers.size} timers live`);
  fire();
  check('only ONE re-entry happens, and it belongs to the newer intent',
    log.enters.length === 1 && log.enters[0].retryOf === 102, JSON.stringify(log.enters));
}
{
  const { eff, log, fire } = rig();
  eff.apply(onBusy(false), { intent: 101 });
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
  eff2.apply(onBusy(false), { intent: 101 });
  eff2.apply(onBusy(false), { intent: 102 });   // intent 2 now owns it
  captured[0]();                               // intent 1's timer fires late — it must NOT enter
  check('a late timer from a superseded intent drops instead of entering',
    log.enters.length === 0, JSON.stringify(log.enters));
  check('…and says why', log.tee.some((m) => /dropped/.test(m)));
}

console.log('\n— 3. an explicit click after give-up starts a fresh budget —');
{
  const { eff, log, fire } = rig();
  eff.apply(onBusy(false), { intent: 101 }); fire();
  eff.apply(onBusy(true), { intent: 101 });                 // gave up
  const again = eff.apply(onBusy(false), { intent: 102 });  // the user clicks the visor again
  check('a new click retries again (retryOf is null, so it is a first failure)', again === 'retried');
  check('…and it is the new intent that owns it', eff.pendingFor === 102);
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
  // …AND SAYS SO. The suite pinned that xr.js must not re-emit this toast, but never that it is
  // emitted at all — so deleting it from the owner passed, and the page reloaded with NO explanation.
  check('…and the user is TOLD why the page is about to reload',
    log.toast.some(([m, k]) => k === 'info' && /webgl/i.test(m ?? '')), JSON.stringify(log.toast));
  const e3 = weird();
  check('an unknown error on WebGL surfaces', eff.apply(decideEntryFailure(e3, { gpu: false }), { intent: 1, error: e3 }) === 'surface');
  check('…and surfacing schedules nothing', !eff.hasPending);
  // hasPending is what leaveVR gates on, so it must track the TIMER (mutation sweep: rewiring it to
  // pendingFor survived, and with the bookkeeping fix above the two now genuinely differ).
  // hasPending must read the TIMER, not pendingFor. After a normal fire both are null, so that case
  // cannot tell them apart — the distinguishing state is a DROPPED retry: the timer is gone while
  // pendingFor still names the newer intent. leaveVR gates on this, so wiring it to pendingFor would
  // make a leave believe a retry is pending and swallow the leave.
  { const { eff: e2, fire: f2, timers } = rig();
    e2.apply(onBusy(false), { intent: 101 });
    check('hasPending is true while a timer is armed', e2.hasPending === true);
    e2.apply(onBusy(false), { intent: 102 });     // intent 2 supersedes; its timer is now the live one
    f2();                                        // it fires and re-enters, clearing the timer
    check('after the live retry fires, no timer is pending', e2.hasPending === false && timers.size === 0);
    e2.apply(onBusy(false), { intent: 103 });
    e2.cancel('leave');                          // cancel clears the timer AND the intent
    check('…and a cancel leaves nothing pending', e2.hasPending === false && e2.pendingFor === null); }
  { // the distinguishing case: pendingFor set, timer already gone
    const { eff: e3, timers } = rig();
    e3.apply(onBusy(false), { intent: 101 });
    [...timers.values()][0].fn();                // the timer fires by hand; it clears `timer` only
    check('hasPending tracks the TIMER, so a fired retry reports nothing pending',
      e3.hasPending === false, `hasPending=${e3.hasPending} pendingFor=${e3.pendingFor}`); }
}

console.log('\n— 5. the PRODUCT uses this owner (the wiring the reviewer broke) —');
{
  const xr = readFileSync(new URL('../client/lib/xr.js', import.meta.url), 'utf8');
  check('xr.js imports the effect owner', /import \{ makeEntryEffects \} from '\.\/xr_entry_effects\.js'/.test(xr));
  check('xr.js constructs it with real timers', /makeEntryEffects\(\{[\s\S]*?setTimeout/.test(xr));
  check('the entry catch delegates to it rather than scheduling inline',
    /entryEffects\.apply\(verdict, \{ intent: myEntry, error: e \}\)/.test(xr));
  check('NO setTimeout survives in the entry catch path', !/busyTimer = setTimeout/.test(xr));
  // THE SEAM (agent review): apply() already tees and toasts for 'reload-webgl' and returns 'reload'.
  // xr.js had no 'reload' branch, so it fell through to an identical inline tee + toast and the user
  // got the 6-second toast TWICE. The module was tested; the caller's double-emission was not.
  check('xr.js does NOT re-emit the reload toast the owner already sent',
    !/toast\(verdict\.toast, 'info', 6000\)/.test(xr), 'the reload toast fires twice');
  check('…and does not re-tee the reload line either',
    !/tee\(`\[xr\] webgpu session refused/.test(xr));
  check('…but still owns the navigation, which needs `location`',
    /searchParams\.set\('webgl', '1'\)/.test(xr) && /location\.href = u/.test(xr));
  check('leaveVR cancels through the owner before its no-session return',
    xr.indexOf('entryEffects.hasPending') < xr.indexOf("if (!session) { tee(`[xr] leave"));
}

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
