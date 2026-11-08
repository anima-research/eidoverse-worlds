// The one dwell mechanism (client/lib/dwell.js): the nameplate card (desktop and VR), VR tooltips and VR handles all
// ask it whether the pointer has rested on something for a beat.
//   BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun tools/dwell-test.mjs
import { makeDwell, DWELL_MS } from '../client/lib/dwell.js';
let pass = 0, fail = 0;
const check = (name, ok, note = '') => { if (ok) { pass++; console.log(`  ok    ${name}`); } else { fail++; console.log(`  FAIL  ${name}${note ? `  -- ${note}` : ''}`); } };
console.log('DWELL');
check('the delay is the nameplate card\'s 300 ms', DWELL_MS === 300);
const d = makeDwell();
d.step('a', 1000);
check('not ripe on arrival', !d.ripe(1000) && d.ripeKey(1000) === null);
check('not ripe a frame short', !d.ripe(1000 + DWELL_MS - 1));
check('ripe once the same key has held the delay', d.step('a', 1000 + DWELL_MS).ripe(1000 + DWELL_MS) && d.ripeKey(1000 + DWELL_MS) === 'a');
d.step('b', 1400);
check('a new key restarts the clock', d.key === 'b' && d.since === 1400 && !d.ripe(1500));
d.step('b', 1650);
check('…and keeps counting while the key holds', d.since === 1400 && !d.ripe(1650) && d.ripe(1700));
d.step(null, 1800);
check('resting on nothing is never ripe', !d.ripe(99999) && d.key === null);
d.step('b', 1900);
check('coming back is a fresh dwell', d.since === 1900 && !d.ripe(2000));
const e = makeDwell(50); e.step(7, 0);
check('a per-use delay', e.ripe(50) && !e.ripe(49));
const el = {}; const f = makeDwell(); f.step(el, 0); f.step(el, 200);
check('object keys (a panel control element) compare by identity', f.since === 0 && f.ripe(300));
d.reset(5000); check('reset forgets the key', d.key === null && !d.ripe(9e9));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
