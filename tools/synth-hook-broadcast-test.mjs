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
