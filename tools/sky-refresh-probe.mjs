// sky-refresh-probe — the clear→cloudy graph refresh (sky_baked maybeRefreshGraph) never issues a one-shot
// full-quad bake inside a headset: it is held until exit. (On the desktop it bakes in strips; see the note below.)
// Runs on LOW clouds (2048x1024, 3 passes): headless draws on the CPU (SwiftShader), and a medium sky there
// exhausted a test machine's memory once (2026-09-26). Always run it under a memory guard.
// ⚠ On a 7 GB machine even the LOW sky's software boot bake reached a 1.5 GB memory floor (twice, 09-26):
// run this where Chromium has a real GPU, or with more RAM. It has NOT yet completed a run.
//   bun tools/sky-refresh-probe.mjs
import { launchBrowser, ownedWorld, checker } from './probe-harness.mjs';
if (process.env.SKY_REFRESH_GPU !== '1') { console.log('sky-refresh-probe: skipped (needs a GPU or more RAM; set SKY_REFRESH_GPU=1)'); process.exit(0); }
import { readFileSync } from 'node:fs';
const { check, done } = checker();
const IWER_RAW = readFileSync(new URL('../node_modules/iwer/build/iwer.js', import.meta.url), 'utf8');
const LOOP = 'globalThis.requestAnimationFrame(this[P_SESSION].onDeviceFrame)';
const IWER = `globalThis.__iwerNativeRAF = globalThis.requestAnimationFrame.bind(globalThis);\n` + IWER_RAW.replace(LOOP, 'globalThis.__iwerNativeRAF(this[P_SESSION].onDeviceFrame)');
const world = await ownedWorld({});
const W = 'skyrefresh';
{ const ws = new WebSocket(world.origin.replace('http', 'ws') + '/ws?name=seed');
  await new Promise((r) => { ws.onopen = () => ws.send(JSON.stringify({ type: 'join', world: W, id: 'seed', token: world.key })); ws.onmessage = (e) => { if (JSON.parse(e.data).type === 'snapshot') r(); }; });
  ws.send(JSON.stringify({ type: 'verb', verb: 'sky', args: { hours: 12, clouds: 'cumulus', weather: 'clear' } }));
  await new Promise((r) => setTimeout(r, 500)); ws.close(); }
const { browser, page } = await launchBrowser(); const pg = await page();
await pg.addInitScript(IWER);
await pg.addInitScript(() => { const { XRDevice, metaQuest3 } = window.IWER ?? {}; const d = new XRDevice(metaQuest3); d.installRuntime({ forceInstall: true });
  window.__iwerDevice = d; try { delete window.IWER; } catch { window.IWER = undefined; } localStorage.setItem('ew-cloud-quality', 'low'); });
const errs = []; pg.on('pageerror', (e) => errs.push(String(e)));
const stats = () => pg.evaluate(() => globalThis.__skyRefresh?.stats() ?? null);
try {
  await pg.goto(`${world.origin}/?world=${W}&name=refresh&key=${world.key}&xr=1`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  const baked = await pg.waitForFunction(() => globalThis.__skyRefresh?.stats().dome === true, null, { timeout: 150000, polling: 1000 }).then(() => true, () => false);
  const info = await pg.evaluate(async () => ({ impl: (await import('./lib/sky.js')).skyImpl(), q: (await import('./lib/sky.js')).getCloudQuality() }));
  check('the baked sky tier is up headless (low clouds)', baked, JSON.stringify(info));
  if (!baked) throw new Error('no baked tier here — nothing to test');
  await pg.waitForFunction(() => globalThis.__skyRefresh?.stats().state === 'idle', null, { timeout: 60000, polling: 500 });
  // headset: forced refresh is held
  await pg.evaluate(() => document.querySelector('#xrbtn').click());
  await pg.waitForFunction(() => globalThis.EW?.renderer?.xr?.isPresenting, null, { timeout: 30000, polling: 250 });
  await pg.evaluate(() => globalThis.__skyRefresh.force());
  await pg.waitForFunction(() => globalThis.__skyRefresh.stats().held > 0, null, { timeout: 30000, polling: 500 }).catch(() => {});
  const v = await stats();
  check('in VR: the refresh is HELD (no bake while presenting)', v?.held > 0 && v?.bands == null && v?.pinnedCloudsOn === false, JSON.stringify(v));
  // NOT exercised here: the refresh itself (after exit, or on the desktop). It compiles the whole cloud graph, and in
  // SwiftShader that alone took ~4 GB and hit the memory guard's floor (2026-09-26). The strips reuse bandedBakeRender
  // (tools/sky-band-probe.mjs); the live proof is the console line '[sky] graph refresh baked in N bands'.
  check('no page errors', errs.length === 0, errs.slice(0, 3).join(' | '));
} catch (e) { check('probe ran', false, e.message); }
finally { try { await browser.close(); } catch {} try { await world.close(); } catch {} }
done();
