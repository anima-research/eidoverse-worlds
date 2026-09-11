// The splash rays worker (client/lib/boot.js) is one resource with three parts — the Worker, its window
// resize listener, the harness handle globalThis.__raysWorker — and one owner. Review 2026-09-10 #3:
// stopRays posted 'stop' and nulled the local only; the listener and the public handle outlived the splash,
// and a stopRays that abandoned the worker without 'stop' passed every committed test. This drives the real
// module under happy-dom with a recording Worker: normal finish, repeated finish, nogl, failed creation, ?rays=0.
import { GlobalRegistrator } from '@happy-dom/global-registrator';
// ?rays=0 is read from location.search at module scope, so that case runs in a CHILD process registered at
// that URL (SPLASH_RAYS0=1); happy-dom's replaceState does not rewrite location.search.
const RAYS0 = process.env.SPLASH_RAYS0 === '1';
GlobalRegistrator.register({ url: RAYS0 ? 'http://localhost/?rays=0' : 'http://localhost/' });
import { plugin } from 'bun';
const HERE = import.meta.dir; const here = (p) => `${HERE}/${p.replace(/^\.\//, '')}`;
plugin({ name: 'core-stub', setup(build) {
  build.onResolve({ filter: /^\.\/base\.js$/ }, () => ({ path: here('./core-stub.mjs') }));
  build.onResolve({ filter: /^\.\/assets\.js$/ }, () => ({ path: here('./assets-stub.mjs') }));
} });

// ---- the world the splash lives in
document.body.innerHTML = `<div id="splash"><canvas class="sp-rays"></canvas><div class="sp-status"><div class="sp-world"></div><div class="sp-name"></div></div>
  <div class="sp-bar"><div class="sp-bar-fill"></div></div><div class="sp-phase"></div><div class="sp-detail"></div><div class="sp-items"></div><div class="sp-tip"></div><button class="sp-skip"></button></div>`;
const splash = document.getElementById('splash'), cv = splash.querySelector('.sp-rays');
globalThis.OffscreenCanvas = class {};
HTMLCanvasElement.prototype.transferControlToOffscreen = function () { return { offscreen: true }; };
globalThis.matchMedia = () => ({ matches: false });
const workers = [];
let ctorThrows = false;
class RecordingWorker {
  constructor(url, opts) { if (ctorThrows) throw new Error('no worker here'); this.url = String(url); this.opts = opts; this.msgs = []; this.onmessage = null; workers.push(this); }
  postMessage(m) { this.msgs.push(m); }
}
globalThis.Worker = RecordingWorker;
const resizeListeners = new Set();
const _add = globalThis.addEventListener.bind(globalThis), _rm = globalThis.removeEventListener.bind(globalThis);
globalThis.addEventListener = (t, fn, o) => { if (t === 'resize') resizeListeners.add(fn); return _add(t, fn, o); };
globalThis.removeEventListener = (t, fn, o) => { if (t === 'resize') resizeListeners.delete(fn); return _rm(t, fn, o); };

const { initBoot, finishBoot, bootDone, startRays, stopRays, raysActive } = await import('../client/lib/boot.js');

let pass = 0, fail = 0;
const check = (name, ok, note = '') => { if (ok) { pass++; console.log(`  ok    ${name}`); } else { fail++; console.log(`  FAIL  ${name}${note ? `  -- ${note}` : ''}`); } };
const stops = (w) => w.msgs.filter((m) => m.type === 'stop').length;

if (RAYS0) {
  console.log('SPLASH — ?rays=0 (child process)');
  startRays(splash);
  check('the A/B flag starts no worker', workers.length === 0 && resizeListeners.size === 0 && raysActive() === false && !globalThis.__raysWorker);
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

console.log('SPLASH — normal boot');
initBoot({ world: 'w', name: 'n' });
check('one worker started, module type, from splashrays.worker.js', workers.length === 1 && workers[0].opts?.type === 'module' && /splashrays\.worker\.js/.test(workers[0].url), workers[0]?.url);
check('init carries the offscreen canvas', workers[0].msgs[0]?.type === 'init' && workers[0].msgs[0].canvas?.offscreen === true);
check('resize listener registered', resizeListeners.size === 1);
check('harness handle advertised', globalThis.__raysWorker === workers[0]);
check('raysActive while the splash is up', raysActive() === true);
resizeListeners.forEach((fn) => fn());
check('a resize forwards a size message', workers[0].msgs.some((m) => m.type === 'size'));
finishBoot('ready');
check('finishBoot marks done', bootDone() === true && splash.classList.contains('gone'));
check('the worker was told to stop — exactly once', stops(workers[0]) === 1, `${stops(workers[0])} stop(s)`);
check('resize listener removed', resizeListeners.size === 0);
check('harness handle cleared (a closed worker is not the instrument)', !globalThis.__raysWorker);
check('raysActive false after', raysActive() === false);
finishBoot('ready'); stopRays();
check('a repeated finish / stop is a no-op (still one stop)', stops(workers[0]) === 1 && resizeListeners.size === 0);
resizeListeners.forEach((fn) => fn());
check('nothing posts after teardown', !workers[0].msgs.slice(workers[0].msgs.findIndex((m) => m.type === 'stop') + 1).length);

console.log('SPLASH — the worker reports nogl');
{ const before = workers.length; startRays(splash);
  const w = workers[before]; check('a fresh worker starts', !!w && resizeListeners.size === 1 && globalThis.__raysWorker === w);
  w.onmessage({ data: { type: 'nogl' } });
  check('canvas hidden (static gradient shows through)', cv.style.display === 'none');
  check('nogl tears everything down', stops(w) === 1 && resizeListeners.size === 0 && !globalThis.__raysWorker && raysActive() === false); }

console.log('SPLASH — Worker construction throws');
{ cv.style.display = ''; ctorThrows = true; const before = workers.length; startRays(splash); ctorThrows = false;
  check('no worker, no listener, no handle', workers.length === before && resizeListeners.size === 0 && !globalThis.__raysWorker && raysActive() === false);
  check('canvas hidden', cv.style.display === 'none'); }

console.log('SPLASH — postMessage throws AFTER the worker exists (a throw mid-startRays)');
{ cv.style.display = ''; const before = workers.length; RecordingWorker.prototype.postMessage = function () { throw new Error('detached'); };
  startRays(splash); RecordingWorker.prototype.postMessage = function (m) { this.msgs.push(m); };
  check('the half-started worker is released: no handle, no listener, not active', workers.length === before + 1 && resizeListeners.size === 0 && !globalThis.__raysWorker && raysActive() === false);
  check('canvas hidden', cv.style.display === 'none'); }

console.log('SPLASH — startRays twice');
{ cv.style.display = ''; const before = workers.length; startRays(splash); startRays(splash);
  const [a, b] = workers.slice(before);
  check('the first worker was stopped and only the second is live', stops(a) === 1 && stops(b) === 0 && globalThis.__raysWorker === b && resizeListeners.size === 1, `stops=${stops(a)},${stops(b)} listeners=${resizeListeners.size}`);
  stopRays();
  check('one stop each, nothing left', stops(a) === 1 && stops(b) === 1 && resizeListeners.size === 0 && !globalThis.__raysWorker); }

console.log('SPLASH — ?rays=0');
{ const r = Bun.spawnSync(['bun', import.meta.path], { env: { ...process.env, SPLASH_RAYS0: '1' }, stdout: 'pipe', stderr: 'pipe' });
  const out = new TextDecoder().decode(r.stdout);
  check('the A/B flag starts no worker (child at ?rays=0)', r.exitCode === 0 && /1 passed, 0 failed/.test(out), out.trim().split('\n').slice(-3).join(' | ')); }

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
