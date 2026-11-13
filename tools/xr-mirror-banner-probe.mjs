// xr-mirror-banner-probe — when the desktop mirror switches itself off in a session (30 frames over 30 ms, or a
// failure), a banner centred on the desktop says why, for as long as the session lasts, and leaves at exit (the owner,
// 09-27: the 8 s toast was easy to miss). Headless frames take 200–500 ms, so the real killswitch trips on its own.
// Also: 'mirror my eyes' is the default. Real client + IWER.
//   bun tools/xr-mirror-banner-probe.mjs
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
const errs = []; pg.on('pageerror', (e) => errs.push(String(e)));
try {
  await pg.goto(`${world.origin}/?world=staging&name=mirrorbanner&key=${world.key}&xr=1`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await pg.waitForFunction(() => { const b = document.querySelector('#xrbtn'); return !!b && getComputedStyle(b).display !== 'none'; }, null, { timeout: 90000 });
  await pg.evaluate(() => document.querySelector('#xrbtn').click());
  await pg.waitForFunction(() => globalThis.EW?.renderer?.xr?.isPresenting, null, { timeout: 30000, polling: 250 });
  await pg.waitForTimeout(1500);
  const pref = await pg.evaluate(async () => (await import('./lib/xr.js')).xrPrefs.mirror);
  let text = null;
  try { await pg.waitForFunction(() => !!document.querySelector('.xr-mirror-off'), null, { timeout: 150000, polling: 1000 }); } catch {}
  text = await pg.evaluate(async () => (await import('./lib/xrmirror.js')).mirrorBannerText());
  const box = await pg.evaluate(() => { const b = document.querySelector('.xr-mirror-off'); if (!b) return null; const r = b.getBoundingClientRect();
    return { cx: Math.round(r.left + r.width / 2 - innerWidth / 2), cy: Math.round(r.top + r.height / 2 - innerHeight / 2), z: getComputedStyle(b).zIndex }; });
  await pg.waitForTimeout(3000);
  const still = await pg.evaluate(async () => (await import('./lib/xrmirror.js')).mirrorBannerText());
  await pg.evaluate(async () => { await window.__iwerDevice.activeSession?.end(); });
  // (the exit rebuild pins the headless main thread past short polls, as in sky-xr-hold-probe: wait on the observable)
  await pg.waitForFunction(() => !document.querySelector('.xr-mirror-off'), null, { timeout: 90000, polling: 500 }).catch(() => {});
  const after = await pg.evaluate(async () => (await import('./lib/xrmirror.js')).mirrorBannerText());
  console.log('  ·', JSON.stringify({ pref, text, box, stillThere: !!still, after }));
  check("'mirror my eyes' is the default", pref === 'first', pref);
  check('the killswitch puts up a banner saying why', /costing the headset frames/.test(text ?? ''), text);
  check('…centred on the desktop, over the frames', box && Math.abs(box.cx) <= 2 && Math.abs(box.cy) <= 2 && Number(box.z) > 60, JSON.stringify(box));
  check('…and it stays (not a toast)', !!still);
  check('it leaves when the session ends', after === null, after);
  check('no page errors', errs.length === 0, errs.slice(0, 3).join(' | '));
} catch (e) { check('probe ran', false, e.message); }
finally { try { await browser.close(); } catch {} try { await world.close(); } catch {} }
done();
