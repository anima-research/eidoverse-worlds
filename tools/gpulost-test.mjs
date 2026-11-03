// gpulost's decisions, headless: reload once, never loop; the XR boot flag is dropped. `node tools/gpulost-test.mjs`
import { gpuLostAction, recoveryUrl, recentGpuLosses, installGpuLostRecovery, GPU_LOST_KEY, GPU_LOST_WINDOW_MS, GPU_LOST_LONG_MS } from '../client/lib/gpulost.js';
let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) pass++; else { fail++; console.log(`  FAIL ${n} ${d}`); } };
const now = 1_000_000;
ok('first loss reloads', gpuLostAction(now, []).reload === true);
ok('…and records it', JSON.stringify(gpuLostAction(now, []).recent) === `[${now}]`);
ok('a second loss inside the window does NOT reload (no loop)', gpuLostAction(now, [now - 5000]).reload === false);
ok('a loss outside the window reloads again', gpuLostAction(now, [now - GPU_LOST_WINDOW_MS - 1]).reload === true);
ok('stale and junk history is dropped', JSON.stringify(gpuLostAction(now, [now - GPU_LOST_LONG_MS - 1, 'x', null, now + 99999]).recent) === `[${now}]`);
ok('…a loss inside 15 min is kept (the long window counts it)', JSON.stringify(gpuLostAction(now, [now - GPU_LOST_WINDOW_MS - 1]).recent) === `[${now - GPU_LOST_WINDOW_MS - 1},${now}]`);
// review 10a M2: a boot-loop whose period is longer than 2 min (a cold boot + the fatal draw) — every loss 130 s apart.
// Simulate the page: each loss reads the stored history, stores the new one, and reloads or stops.
{ let hist = [], t = now, reloads = 0, stoppedAt = 0;
  for (let i = 1; i <= 6 && !stoppedAt; i++) { const a = gpuLostAction(t, hist); hist = a.recent; if (a.reload) reloads++; else stoppedAt = i; t += 130000; }
  ok('a loss loop 130 s apart stops by the third loss', stoppedAt === 3 && reloads === 2, JSON.stringify({ stoppedAt, reloads }));
  ok('…and says why', /3 losses inside 15 min/.test(gpuLostAction(now + 260000, [now, now + 130000]).why ?? ''), gpuLostAction(now + 260000, [now, now + 130000]).why); }
ok('control: two losses 16 min apart both reload (the long window forgets)', gpuLostAction(now + GPU_LOST_LONG_MS + 60000, [now]).reload === true);
ok('recovery drops ?xr and ?why, keeps world/name/key', recoveryUrl('https://h:1/?world=commons&name=Ada&key=K&xr=1&why=vr-webgl&vrprobe=1') === 'https://h:1/?world=commons&name=Ada&key=K&vrprobe=1');
// the count the graphics chip shows: losses inside the long window, junk and stale entries not counted
{ const store = (v) => ({ sessionStorage: { getItem: (k) => (k === GPU_LOST_KEY ? v : null) } });
  ok('recentGpuLosses counts the losses inside 15 min', recentGpuLosses(store(JSON.stringify([now - 1000, now - 60000])), now) === 2);
  ok('…not stale, future or junk entries', recentGpuLosses(store(JSON.stringify([now - GPU_LOST_LONG_MS - 1, now + 5, 'x', now])), now) === 1);
  ok('…and 0 for nothing or garbage', recentGpuLosses(store(null), now) === 0 && recentGpuLosses(store('{bad'), now) === 0 && recentGpuLosses({}, now) === 0); }
// 10-08: Chrome reports reason 'destroyed' for a device it destroyed itself (headless: the swap chain's shared image
// failed, "GPU state invalid") — no JS called destroy(). Ignoring every 'destroyed' left the page rendering into a dead
// device, throwing each frame (and three's callDepth climbing: a fresh shader build per frame). Only OUR destroy is deliberate.
{ const fakeWin = () => ({ sessionStorage: { getItem: () => '[]', setItem: () => {} }, localStorage: { removeItem: () => {} }, location: { href: 'https://h/?world=w', search: '?world=w', replace: () => {} }, setTimeout: () => {} });
  const fakeDevice = () => { let res; const d = { lost: new Promise((r) => { res = r; }), destroy() { res({ reason: 'destroyed', message: 'Device was destroyed.' }); } }; d.loseExternally = () => res({ reason: 'destroyed', message: 'Device was destroyed.' }); return d; };
  const d1 = fakeDevice(); const r1 = installGpuLostRecovery({ renderer: { backend: { device: d1 } }, win: fakeWin() });
  d1.loseExternally(); await new Promise((r) => setTimeout(r, 0));
  ok("a device the BROWSER destroyed (reason 'destroyed', no destroy() from us) is a loss: recovery fires", r1.fired === true);
  const d2 = fakeDevice(); const r2 = installGpuLostRecovery({ renderer: { backend: { device: d2 } }, win: fakeWin() });
  d2.destroy(); await new Promise((r) => setTimeout(r, 0));
  ok("…a device the PAGE destroyed (its own destroy()) is not", r2.fired === false);
  const d3 = { lost: Promise.resolve({ reason: 'unknown', message: 'GPU process crashed' }) }; const r3 = installGpuLostRecovery({ renderer: { backend: { device: d3 } }, win: fakeWin() });
  await new Promise((r) => setTimeout(r, 0));
  ok("control: reason 'unknown' still fires", r3.fired === true); }
console.log(`${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
