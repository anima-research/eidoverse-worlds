// The VR pointer's policy (client/lib/xrpointer.js), run without a headset: the "pointer laser" setting.
// tools/xr-pointer-probe.mjs is the browser half: the real loop under IWER, the setting's row in the VR settings quad.
//   BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun tools/xrpointer-test.mjs
import * as P from '../client/lib/xrpointer.js';
let pass = 0, fail = 0;
const check = (name, ok, note = '') => { if (ok) { pass++; console.log(`  ok    ${name}`); } else { fail++; console.log(`  FAIL  ${name}${note ? `  -- ${note}` : ''}`); } };

console.log('POINTER LASER SETTING');
check('three modes, contextual the default', P.LASER_MODES.join() === 'always,never,contextual' && P.LASER_DEFAULT === 'contextual');
check('an unknown or missing stored value reads as contextual', P.laserMode('sparkly') === 'contextual' && P.laserMode(undefined) === 'contextual' && P.laserMode('never') === 'never');
const cases = [{}, { target: true }, { grip: true }, { trig: true }, { target: true, grip: true, trig: true }];
const row = (m) => cases.map((c) => +P.laserVisible(m, c)).join('');
check('contextual: hidden on nothing; shown on a target, with grip, with trigger', row('contextual') === '01111', row('contextual'));
check('always: shown on nothing too', row('always') === '11111', row('always'));
check('never: hidden even on a target with both buttons held', row('never') === '00000', row('never'));
check('an unknown mode behaves as contextual', row('bogus') === row('contextual'));
const w = (m) => [{}, { grip: true }, { trig: true }].map((c) => +P.looksAtWorld(m, c)).join('');
check('the world is raycast only with a button held, or always in "always"', w('contextual') === '011' && w('never') === '011' && w('always') === '111', `${w('contextual')} ${w('never')} ${w('always')}`);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
