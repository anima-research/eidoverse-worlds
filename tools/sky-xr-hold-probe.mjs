// sky-xr-hold-probe — a sky REBUILD never runs inside a headset session; it applies at exit.
// Real client + IWER (emulated Quest 3). Cloud quality flipped mid-session must hold (quality unchanged, no
// rebuild line), and apply on exit. The VR cap's own entry flip still goes through.
//   bun tools/sky-xr-hold-probe.mjs   (spawns its own server via probe-harness)
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
  window.__iwerDevice = d; try { delete window.IWER; } catch { window.IWER = undefined; } window.__g = 0;
  const real = navigator.xr.requestSession.bind(navigator.xr); navigator.xr.requestSession = async (...a) => { const s = await real(...a); window.__g++; return s; };
  localStorage.setItem('ew-cloud-quality', 'medium'); });
const lines = []; const errs = [];
pg.on('console', (m) => { const t = m.text(); if (/\[sky\]/.test(t)) lines.push(t); });
pg.on('request', (r) => { const b = r.postData(); if (b && /\[sky\]/.test(b)) for (const x of b.match(/\[sky\][^"\\]*/g) ?? []) lines.push(x); });
pg.on('pageerror', (e) => errs.push(String(e)));
const ev = (fn, a) => pg.evaluate(fn, a);
const q = () => ev(async () => (await import('./lib/sky.js')).getCloudQuality());
try {
  await pg.goto(`${world.origin}/?world=staging&name=skyhold&key=${world.key}&xr=1`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await pg.waitForFunction(() => { const b = document.querySelector('#xrbtn'); return !!b && getComputedStyle(b).display !== 'none'; }, null, { timeout: 90000 });
  await pg.waitForTimeout(4000);
  check('boots at medium', (await q()) === 'medium', await q());
  await ev(() => document.querySelector('#xrbtn').click());
  await pg.waitForFunction(() => window.__g >= 1 && !!window.__iwerDevice.activeSession, null, { timeout: 30000 });
  await pg.waitForTimeout(1500);
  const before = lines.length;
  await ev(async () => (await import('./lib/sky.js')).setCloudQuality('low'));
  await pg.waitForTimeout(2500);
  const during = lines.slice(before);
  check('in VR: a quality flip is HELD (quality unchanged)', (await q()) === 'medium', await q());
  check('…holds exactly that choice for the exit', JSON.stringify(await ev(async () => (await import('./lib/sky.js')).skyHeld())) === JSON.stringify({ quality: 'low', rebuild: false }));
  console.log('  · tee lines seen during (batched, informational):', during.filter((l) => /held/.test(l)).length);
  check('…and does NOT rebuild', !during.some((l) => /\[sky\] rebuild \(/.test(l)), during.filter((l) => /rebuild/.test(l)).join(' ;; ').slice(0, 300));
  check('…the choice is saved for next time', (await ev(() => localStorage.getItem('ew-cloud-quality'))) === 'low');
  const b2 = lines.length;
  await ev(async () => { await window.__iwerDevice.activeSession?.end(); });
  // (no 'renderer stopped presenting' check: the exit rebuild pins the headless main thread past any poll window; the
  //  held flip applying below is the observable that the exit path ran)
  await pg.waitForFunction(async () => (await import('./lib/sky.js')).getCloudQuality() === 'low', null, { timeout: 30000, polling: 250 }).catch(() => {});
  // tee batches its beacon, so the line can post after the flip lands — give it a few seconds
  for (let i = 0; i < 20 && !lines.slice(b2).some((l) => /applying the sky change held/.test(l)); i++) await new Promise((r) => setTimeout(r, 250));
  const after = lines.slice(b2);
  check('at exit: the held flip applies', (await q()) === 'low', after.join(' ;; ').slice(0, 300));
  check('…and nothing is left held', (await ev(async () => (await import('./lib/sky.js')).skyHeld())) === null);
  console.log('  · exit tee seen (batched, informational):', after.some((l) => /applying the sky change held/.test(l)));
  check('no page errors', errs.length === 0, errs.slice(0, 3).join(' | '));
} catch (e) { check('probe ran', false, e.message); }
finally { try { await browser.close(); } catch {} try { await world.close(); } catch {} }
done();
