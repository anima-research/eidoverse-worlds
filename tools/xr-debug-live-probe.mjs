// xr-debug-live-probe — the Debug pane opened in VR keeps its numbers live (owner, 09-27 20:42: 'the perf numbers are
// locked and never change'). Real client + IWER: opens the debug quad from the ring and reads its frame-timing text
// twice, a few seconds apart.
//   bun tools/xr-debug-live-probe.mjs
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
  await pg.goto(`${world.origin}/?world=staging&name=dbglive&key=${world.key}&xr=1`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await pg.waitForFunction(() => { const b = document.querySelector('#xrbtn'); return !!b && getComputedStyle(b).display !== 'none'; }, null, { timeout: 90000 });
  await pg.evaluate(() => document.querySelector('#xrbtn').click());
  await pg.waitForFunction(() => globalThis.EW?.renderer?.xr?.isPresenting, null, { timeout: 30000, polling: 250 });
  await pg.waitForTimeout(3000);
  const open = await pg.evaluate(async () => {
    const dq = await import('./lib/domquad.js'), xp = await import('./lib/xrpanels.js');
    dq.domQuadShow('debug', true); await new Promise((r) => setTimeout(r, 600));
    return { open: xp.xrPanelOpen('debug'), ids: dq.domQuadIds() };
  });
  const read = () => pg.evaluate(async () => { const t = (await import('./lib/domquad.js')).domQuadTexture('debug'); return t?.dom?.querySelector('pre.dbg-stats')?.textContent ?? null; });
  const a = await read(); await pg.waitForTimeout(4000); const b = await read();
  console.log('   ', JSON.stringify({ open, a: a?.slice(0, 80), b: b?.slice(0, 80) }));
  check('the debug pane is open in VR', open.open === true, JSON.stringify(open));
  check('its frame-timing numbers change over 4 s (live, not frozen)', !!a && !!b && a !== b, JSON.stringify({ a: a?.slice(0, 60), b: b?.slice(0, 60) }));
  check('no page errors', errs.length === 0, errs.slice(0, 3).join(' | '));
} catch (e) { check('probe ran', false, e.message); }
finally { try { await browser.close(); } catch {} try { await world.close(); } catch {} }
done();
