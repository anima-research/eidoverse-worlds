// gpulost's decisions, headless: reload once, never loop; the XR boot flag is dropped. Then render.js's lost-GPU gates:
// once a loss is handled (globalThis.__gpuLost.fired) every GPU entry point reaches nothing, and reads the flag (no latch).
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { plugin } from 'bun';
import { stubResolve } from '../harness/stub.ts';
import { gpuLostAction, recoveryUrl, recentGpuLosses, installGpuLostRecovery, GPU_LOST_KEY, GPU_LOST_WINDOW_MS, GPU_LOST_LONG_MS } from '../../client/lib/gpulost.js';
import { suite } from "../gate/suite.ts";
const S = suite("gpulost");
const ok = (n, c, d) => S.check(n, c, d);
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
  d1.loseExternally(); await new Promise((r) => setImmediate(r));
  ok("a device the BROWSER destroyed (reason 'destroyed', no destroy() from us) is a loss: recovery fires", r1.fired === true);
  const d2 = fakeDevice(); const r2 = installGpuLostRecovery({ renderer: { backend: { device: d2 } }, win: fakeWin() });
  d2.destroy(); await new Promise((r) => setImmediate(r));
  ok("…a device the PAGE destroyed (its own destroy()) is not", r2.fired === false);
  const d3 = { lost: Promise.resolve({ reason: 'unknown', message: 'GPU process crashed' }) }; const r3 = installGpuLostRecovery({ renderer: { backend: { device: d3 } }, win: fakeWin() });
  await new Promise((r) => setImmediate(r));
  ok("control: reason 'unknown' still fires", r3.fired === true); }

// ── the lost-GPU gates (client/lib/render.js), driven against a counting renderer: flag down → entered, up → not, down → again
GlobalRegistrator.register();
const HERE = import.meta.dir; const here = (p) => `${HERE}/${p.replace(/^\.\//, '')}`;
plugin({ name: 'core-stub', setup(build) {
  stubResolve(build, /^(\.\.?\/)+core\.js$/, () => ({ path: here('../stubs/core-stub.mjs') }));
  stubResolve(build, /^(\.\.?\/)+base\.js$/, () => ({ path: here('../stubs/core-stub.mjs') }));
  stubResolve(build, /^(\.\.?\/)+loadwork\.js$/, () => ({ path: here('../stubs/loadwork-stub.mjs') }));
} });
{ const { renderer, scene, camera } = await import('../stubs/core-stub.mjs');
  // installed BEFORE render.js imports: render.js binds renderer.render / compileAsync at module scope
  const n = { render: 0, compile: 0, target: 0, read: 0 };
  const stubRender = () => { n.render++; }, stubCompile = async () => { n.compile++; };
  renderer.render = stubRender; renderer.compileAsync = stubCompile;
  renderer.getRenderTarget = () => { n.target++; return null; };
  const { renderWorld, renderAside } = await import('../../client/lib/render.js');
  renderer.domElement = { toDataURL: () => { n.read++; return 'data:image/png;base64,' + 'A'.repeat(4000); } };
  const { captureFrame } = await import('../../client/lib/capture.js');
  const zero = () => { for (const k in n) n[k] = 0; };
  // a snapshot after a handled loss refuses (throws) rather than read the stale canvas
  let threw = null;
  const legs = {
    'renderer.render': async () => { renderer.render(scene, camera); return n.render; },
    'renderer.compileAsync': async () => { await renderer.compileAsync(scene, camera, scene); return n.compile; },
    'renderWorld()': async () => { renderWorld(); return n.render + n.target; },
    'renderAside()': async () => { renderAside(scene, camera); return n.render; },
    'captureFrame()': async () => { threw = null; let url = null; try { url = captureFrame(); } catch (e) { threw = e; } return typeof url === 'string' ? n.read + n.render : 0; },
  };
  ok('render.js wrapped both methods (the test drives the shipping wrappers)', renderer.render !== stubRender && renderer.compileAsync !== stubCompile);
  for (const [name, leg] of Object.entries(legs)) {
    globalThis.__gpuLost = { fired: false }; zero();
    const down = await leg();
    ok(`flag down: ${name} reaches the renderer`, down > 0, `entries ${down}`);
    globalThis.__gpuLost = { fired: true }; zero();
    const up = await leg();
    ok(`loss handled: ${name} reaches nothing`, up === 0 && n.read === 0 && n.render === 0, `entries ${up}`);
    if (name === 'captureFrame()') ok('…and says why: GPU lost', /GPU lost/.test(String(threw?.message)), String(threw?.message));
    globalThis.__gpuLost = { fired: false }; zero();
    const again = await leg();
    ok(`flag down again: ${name} reaches the renderer again`, again > 0, `entries ${again}`);
  }
  delete globalThis.__gpuLost; }
S.done();
