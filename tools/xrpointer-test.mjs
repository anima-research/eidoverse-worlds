// The VR pointer's policy (client/lib/xrpointer.js), run without a headset: the "pointer laser" setting, the ray's
// low-pass.
// tools/xr-pointer-probe.mjs is the browser half: the real loop under IWER, the setting's row in the VR settings quad.
//   BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun tools/xrpointer-test.mjs
import * as P from '../client/lib/xrpointer.js';
import * as THREE from 'three';
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

console.log('\nRAY SMOOTHING');
const pose = (yaw = 0, x = 0) => { const o = new THREE.Object3D(); o.position.set(x, 1.2, 0); o.quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw); return o; };
const yawOf = (o) => 2 * Math.atan2(o.quaternion.y, o.quaternion.w);
{ const out = pose(0.3, 0.2), st = { init: false };
  check('first frame snaps to the controller (no swoop in from the origin)', P.smoothPose(out, pose(0.05), 1 / 90, st) === 'snap' && Math.abs(yawOf(out) - 0.05) < 1e-9 && st.init); }
{ // a 0.1 rad step: after τ about 63% of it is closed, at 72, 90 and 120 Hz alike (frame-rate independence)
  const at = (hz) => { const out = pose(0), st = { init: true }, to = pose(0.1); let t = 0; while (t + 1 / hz <= P.POINTER_TAU + 1e-9) { P.smoothPose(out, to, 1 / hz, st); t += 1 / hz; }
    return { got: yawOf(out) / 0.1, want: 1 - Math.exp(-t / P.POINTER_TAU) }; };
  const r = [72, 90, 120].map(at);
  check('a step closes 1 − e^(−t/τ) of the gap, whatever the frame rate', r.every((x) => Math.abs(x.got - x.want) < 0.01), JSON.stringify(r));
  const half = (hz) => { const out = pose(0), st = { init: true }, to = pose(0.1); for (let i = 0; i < hz * 0.06; i++) P.smoothPose(out, to, 1 / hz, st); return yawOf(out); };
  check('…the same place after 60 ms at 60 Hz and at 120 Hz (< 0.1 mrad apart)', Math.abs(half(60) - half(120)) < 1e-4, `${half(60)} vs ${half(120)}`);
  check('…and settled (< 1% left) within 150 ms (5 τ): short enough not to feel laggy', (() => { const out = pose(0), st = { init: true }, to = pose(0.1); for (let i = 0; i < 90 * 0.15; i++) P.smoothPose(out, to, 1 / 90, st); return Math.abs(yawOf(out) - 0.1) < 0.001; })());
  check('τ is tens of ms', P.POINTER_TAU >= 0.01 && P.POINTER_TAU <= 0.06, P.POINTER_TAU);
}
{ // tremor: a 10 Hz ±0.3° wobble at 90 Hz comes out under ~60% of its amplitude; a 1 Hz deliberate sweep keeps > 95%
  const amp = (f) => { const A = 0.3 * Math.PI / 180, out = pose(0), st = { init: true }; let lo = 1, hi = -1;
    for (let i = 0; i < 90 * 3; i++) { const to = pose(A * Math.sin(2 * Math.PI * f * i / 90)); P.smoothPose(out, to, 1 / 90, st); if (i > 90) { const y = yawOf(out); lo = Math.min(lo, y); hi = Math.max(hi, y); } }
    return (hi - lo) / 2 / A; };
  console.log(`  ·     10 Hz → ${amp(10).toFixed(3)}, 1 Hz → ${amp(1).toFixed(3)}`);
  check('10 Hz tremor is damped to under 60% (the beam\'s far end shakes less)', amp(10) < 0.6, amp(10).toFixed(3));
  check('a 1 Hz deliberate motion keeps over 95% of its size', amp(1) > 0.95, amp(1).toFixed(3));
}
{ const out = pose(0), st = { init: true };
  check('a one-frame jump past the snap angle snaps (tracking came back, a recentre)', P.smoothPose(out, pose(P.POINTER_SNAP_RAD + 0.05), 1 / 90, st) === 'snap');
  check('…as does a jump past the snap distance', P.smoothPose(out, pose(P.POINTER_SNAP_RAD + 0.05, 0.8), 1 / 90, st) === 'snap');
  check('a zero or negative dt does not move it (a stalled frame)', (() => { const o = pose(0), s2 = { init: true }; P.smoothPose(o, pose(0.1), 0, s2); P.smoothPose(o, pose(0.1), -1, s2); return yawOf(o) === 0; })()); }

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
