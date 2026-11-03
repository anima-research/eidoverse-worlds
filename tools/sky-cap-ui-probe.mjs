// sky-cap-ui-probe — in a headset 'high' (live-march) clouds are unavailable (owner, 09-27): World › sky greys 'high',
// and when high is YOUR choice a note says what runs instead and why; both go away at exit. Clouds start at 'low' and
// 'high' is only ever HELD (a headset holds rebuilds), then replaced by 'low' before exit: nothing heavy builds headless.
// Real client + IWER.
//   bun tools/sky-cap-ui-probe.mjs
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
await pg.addInitScript(() => { try { localStorage.setItem('ew-cloud-quality', 'low'); } catch {} });
const errs = []; pg.on('pageerror', (e) => errs.push(String(e)));
try {
  await pg.goto(`${world.origin}/?world=staging&name=skycapui&key=${world.key}&xr=1`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await pg.waitForFunction(() => { const b = document.querySelector('#xrbtn'); return !!b && getComputedStyle(b).display !== 'none'; }, null, { timeout: 90000 });
  await pg.evaluate(() => document.querySelector('#xrbtn').click());
  await pg.waitForFunction(() => globalThis.EW?.renderer?.xr?.isPresenting, null, { timeout: 30000, polling: 250 });
  await pg.waitForTimeout(1500);
  const ui = () => pg.evaluate(async () => {
    const wdom = [...document.querySelectorAll('#sec-sky')][0];
    if (!wdom?.querySelector('.cloud-cap-note')) document.querySelector('#sec-sky-tab')?.click();
    await new Promise((r) => setTimeout(r, 300));
    const sel = [...document.querySelectorAll('#sec-sky select')].find((s) => [...s.options].some((o) => o.value === 'high'));
    const note = document.querySelector('#sec-sky .cloud-cap-note');
    return { liveDisabled: [...(sel?.options ?? [])].find((o) => o.value === 'high')?.disabled ?? null, note: note && !note.hidden ? note.textContent : null };
  });
  const inVR = await ui();
  await pg.evaluate(async () => (await import('./lib/sky.js')).setCloudQuality('high'));
  await pg.waitForTimeout(400);
  const capped = await ui();
  const running = await pg.evaluate(async () => { const s = await import('./lib/sky.js'); return { q: s.getCloudQuality(), choice: s.getCloudChoice(), cap: s.cloudCap(), held: s.skyHeld() }; });
  await pg.evaluate(async () => (await import('./lib/sky.js')).setCloudQuality('low'));   // replace the cap before exit (no live-march build headless)
  await pg.waitForTimeout(400);
  const replaced = await ui();
  await pg.evaluate(async () => { await window.__iwerDevice.activeSession?.end(); });
  await pg.waitForFunction(() => !globalThis.EW?.renderer?.xr?.isPresenting, null, { timeout: 60000, polling: 500 }).catch(() => {});
  await pg.waitForTimeout(800);
  const out = await ui();
  console.log('   ', JSON.stringify({ inVR, capped, running, replaced, out }));
  check("in VR 'high' (the live march) is greyed", inVR.liveDisabled === true, JSON.stringify(inVR));
  check('…with no note while high is not your choice', inVR.note === null, inVR.note);
  check('choosing high in VR: runs medium, remembers high, says why', running.cap?.from === 'high' && running.choice === 'high' && /medium \(baked\)/.test(capped.note ?? ''), JSON.stringify({ running, note: capped.note }));
  check('choosing another level clears the note', replaced.note === null, replaced.note);
  check("out of VR 'high' is available again, no note", out.liveDisabled === false && out.note === null, JSON.stringify(out));
  check('no page errors', errs.length === 0, errs.slice(0, 3).join(' | '));
} catch (e) { check('probe ran', false, e.message); }
finally { try { await browser.close(); } catch {} try { await world.close(); } catch {} }
done();
