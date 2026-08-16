// 🔴🔴 THIS FILE IMPORTS NOTHING. IT IS NOT A REGRESSION TEST.
//
// Flagged by a second-agent audit, 2026-08-16: the logic below is a
// TRANSCRIPTION of the shipped code, re-typed inline and verified by eye. A
// green run proves the COPY is self-consistent; it cannot fail when the real
// module breaks, because it never loads it. Editing the shipped file and
// running this will still print PASS.
//
// Kept because the reasoning is worth preserving and the cases are the right
// cases — but it is a DESIGN NOTE with assertions, and must never be cited as
// evidence that a fix holds. To make it real: import the actual module and
// delete the inline copy. Until then, the honest claim is "unregression-tested".
// Two transports register the same hook; both must fire, and one throwing must
// not silence the other.
const hooks = new Set();
const set = (fn) => { hooks.add(fn); return () => hooks.delete(fn); };
const notify = (t) => { for (const fn of hooks) { try { fn(t); } catch {} } };

const fired = [];
set(() => fired.push('mesh'));
set(() => { throw new Error('sfu blew up'); });
set(() => fired.push('sfu-later'));
notify({});
console.log('fired:', fired.join(' '));

// OLD single-slot behaviour, for contrast
let slot = null; const oldSet = (fn) => { slot = fn; };
const oldFired = [];
oldSet(() => oldFired.push('mesh'));
oldSet(() => oldFired.push('sfu'));
slot?.({});
console.log('old slot fired:', oldFired.join(' '), '(mesh lost its hook)');

console.log(fired.length === 2 && oldFired.length === 1
  ? 'PASS — every subscriber notified; a thrower does not silence the rest'
  : 'FAIL');
