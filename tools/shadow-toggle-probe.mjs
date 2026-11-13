// shadow-toggle-probe — Video › shadows off/on recompiles nothing (owner, 09-27: 'HUGE hang on Video > shadows'): the
// switch is uniform-level, so no render-path pipeline builds follow it, and three's ShadowNode never reads a torn-down
// map. Real client; syncgate's own counter of render-path builds is the witness.
//   bun tools/shadow-toggle-probe.mjs
import { launchBrowser, ownedWorld, checker } from './probe-harness.mjs';
const { check, done } = checker();
const world = await ownedWorld({});
const { browser, page } = await launchBrowser(); const pg = await page();
const errs = []; pg.on('pageerror', (e) => errs.push(String(e)));
const reports = []; pg.on('console', (m) => { if (/depthTexture|frame render/.test(m.text())) reports.push(m.text().slice(0, 200)); });
try {
  await pg.goto(`${world.origin}/`, { waitUntil: 'domcontentloaded' });
  await pg.evaluate(() => localStorage.setItem('ew-cloud-quality', 'off'));
  await pg.goto(`${world.origin}/?world=staging&name=shadowtoggle&key=${world.key}&lite=0`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await pg.waitForFunction(() => globalThis.__ewEngineUp, null, { timeout: 120000 });
  await pg.waitForTimeout(8000);   // let boot's own compiles finish
  const r = await pg.evaluate(async () => {
    const rig = await import('./lib/lightrig.js'), sg = globalThis.__syncGate;
    const wait = (ms) => new Promise((res) => setTimeout(res, ms));
    const b0 = sg.renderPath; const was = rig.shadowsOn();
    rig.setShadows(!was); await wait(2500); const mid = rig.rigDebug().shadows;
    rig.setShadows(was); await wait(2500); const end = rig.rigDebug().shadows;
    return { builds: sg.renderPath - b0, was, mid: { sun: mid.sunCasting, lamp: mid.slotIsCaster }, end: { sun: end.sunCasting, lamp: end.slotIsCaster } };
  });
  console.log('   ', JSON.stringify(r));
  check('toggling shadows off and on builds no pipelines (no scene recompile)', r.builds === 0, `${r.builds} render-path builds`);
  check('the toggle takes effect both ways', r.mid.sun === !r.was && r.end.sun === r.was, JSON.stringify(r));
  check('no ShadowNode render errors', reports.length === 0, reports.slice(0, 2).join(' | '));
  check('no page errors', errs.length === 0, errs.slice(0, 3).join(' | '));
} catch (e) { check('probe ran', false, e.message); }
finally { try { await browser.close(); } catch {} try { await world.close(); } catch {} }
done();
