// The body-first gate's contract (client/lib/bodygate.js): dormant until armed, released once, and the
// wait at the load boundary (awaitBodyGate — assets.js) resolves at once when unarmed or open, and never
// past its cap when armed and stuck. No imports in the module; none needed here.
import { armBodyGate, bodyGateArmed, releaseBodyGate, bodyGateOpen, awaitBodyGate } from '../client/lib/bodygate.js';

// a wait that never resolves is the failure this file exists to catch — it must go RED, not hang
setTimeout(() => { console.log('  FAIL  a gate wait hung past 5 s\n\nHUNG'); process.exit(1); }, 5000).unref?.();
let pass = 0, fail = 0;
const check = (name, ok, note = '') => { if (ok) { pass++; console.log(`  ok    ${name}`); } else { fail++; console.log(`  FAIL  ${name}${note ? `  -- ${note}` : ''}`); } };
const timed = async (p) => { const t = performance.now(); const v = await p; return { v, ms: performance.now() - t }; };

console.log('BODY GATE');
check('starts unarmed and closed', !bodyGateArmed() && !bodyGateOpen());
{ const { v, ms } = await timed(awaitBodyGate(5000)); check('unarmed: the wait resolves at once', v === 'unarmed' && ms < 50, `${v} after ${ms.toFixed(0)}ms`); }
armBodyGate();
check('armBodyGate arms', bodyGateArmed() && !bodyGateOpen());
{ const { v, ms } = await timed(awaitBodyGate(120)); check('armed + stuck: the wait times out at its cap, not before', v === 'timeout' && ms >= 100 && ms < 1000, `${v} after ${ms.toFixed(0)}ms`); }
check('a timed-out wait does not open the gate', !bodyGateOpen());
{ const p = timed(awaitBodyGate(5000)); setTimeout(() => releaseBodyGate('test'), 30); const { v, ms } = await p; check('release resolves a pending wait as open', v === 'open' && ms < 1000, `${v} after ${ms.toFixed(0)}ms`); }
check('released once → open', bodyGateOpen());
releaseBodyGate('again'); check('a second release is a no-op', bodyGateOpen());
{ const { v, ms } = await timed(awaitBodyGate(5000)); check('open: later waits resolve at once', v === 'open' && ms < 50, `${v} after ${ms.toFixed(0)}ms`); }

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
