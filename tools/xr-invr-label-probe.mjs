// xr-invr-label-probe — with the desktop view set to OFF, the desktop says 'In VR' for the session instead of sitting
// black (owner, 09-27, same style as the mirror-off banner). Follows the pref mid-session; gone at exit. Real client + IWER.
//   bun tools/xr-invr-label-probe.mjs
import { launchBrowser, ownedWorld, checker } from './probe-harness.mjs';
import { readFileSync } from 'node:fs';
const { check, done } = checker();
const IWER_RAW = readFileSync(new URL('../node_modules/iwer/build/iwer.js', import.meta.url), 'utf8');
const LOOP = 'globalThis.requestAnimationFrame(this[P_SESSION].onDeviceFrame)';
const IWER = `globalThis.__iwerNativeRAF = globalThis.requestAnimationFrame.bind(globalThis);\n` + IWER_RAW.replace(LOOP, 'globalThis.__iwerNativeRAF(this[P_SESSION].onDeviceFrame)');
const world = await ownedWorld({});
const { browser, page } = await launchBrowser(); const pg = await page();
await pg.addInitScript(IWER);
await pg.addInitScript(() => { const { XRDevice, metaQuest3 } = window.IWER ?? {}; const d = new XRDevice(metaQuest3); d.installRuntime({ forceInstall: true });
  window.__iwerDevice = d; try { delete window.IWER; } catch { window.IWER = undefined; } });
await pg.addInitScript(() => { try { localStorage.setItem('ew-cloud-quality', 'off'); } catch {} });
const errs = []; pg.on('pageerror', (e) => errs.push(String(e)));
try {
  await pg.goto(`${world.origin}/?world=staging&name=invr&key=${world.key}&xr=1`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await pg.waitForFunction(() => { const b = document.querySelector('#xrbtn'); return !!b && getComputedStyle(b).display !== 'none'; }, null, { timeout: 90000 });
  await pg.evaluate(async () => (await import('./lib/xr.js')).setXrPref('mirror', 'off'));
  const txt = () => pg.evaluate(async () => (await import('./lib/xrmirror.js')).mirrorBannerText());
  const before = await txt();
  await pg.evaluate(() => document.querySelector('#xrbtn').click());
  await pg.waitForFunction(() => globalThis.EW?.renderer?.xr?.isPresenting, null, { timeout: 30000, polling: 250 });
  await pg.waitForTimeout(800);
  const inVR = await txt();
  await pg.evaluate(async () => (await import('./lib/xr.js')).setXrPref('mirror', 'first')); await pg.waitForTimeout(300);
  const mirrorOn = await txt();
  await pg.evaluate(async () => (await import('./lib/xr.js')).setXrPref('mirror', 'off')); await pg.waitForTimeout(300);
  const offAgain = await txt();
  await pg.evaluate(async () => { await window.__iwerDevice.activeSession?.end(); });
  await pg.waitForFunction(() => !globalThis.EW?.renderer?.xr?.isPresenting, null, { timeout: 60000, polling: 500 }).catch(() => {});
  await pg.waitForTimeout(500);
  const after = await txt();
  console.log('   ', JSON.stringify({ before, inVR, mirrorOn, offAgain, after }));
  check('no label on the desktop before VR', before === null, before);
  check("desktop view off: the desktop says 'In VR'", /^In VR/.test(inVR ?? ''), inVR);
  check('turning the mirror on mid-session takes it down', mirrorOn === null, mirrorOn);
  check('…and off again puts it back', /^In VR/.test(offAgain ?? ''), offAgain);
  check('gone when the session ends', after === null, after);
  check('no page errors', errs.length === 0, errs.slice(0, 3).join(' | '));
} catch (e) { check('probe ran', false, e.message); }
finally { try { await pg.evaluate(async () => (await import('./lib/xr.js')).setXrPref('mirror', 'first')); } catch {} try { await browser.close(); } catch {} try { await world.close(); } catch {} }
done();
