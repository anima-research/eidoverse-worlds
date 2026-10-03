// sky-busy-probe — the sky panel's 'you: loading…' line follows sky.js's busy signal (UI review 3, L1: 691e84e had no
// committed probe). Off tier, cloudless: headless-safe.
// Shows the stand-in gradient by hand: 'loading…' must appear at once (an arrival isn't debounced; a render is), and clear after.
//   bun tools/sky-busy-probe.mjs
import { launchBrowser, ownedWorld, checker } from './probe-harness.mjs';
const { check, done } = checker();
const world = await ownedWorld({});
const { browser, page } = await launchBrowser(); const pg = await page();
const errs = []; pg.on('pageerror', (e) => errs.push(String(e)));
try {
  await pg.goto(`${world.origin}/`, { waitUntil: 'domcontentloaded' });
  await pg.evaluate(() => localStorage.setItem('ew-cloud-quality', 'off'));
  await pg.goto(`${world.origin}/?world=staging&name=busy&key=${world.key}&lite=0`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await pg.waitForFunction(() => globalThis.__ewEngineUp, null, { timeout: 120000 });
  await pg.waitForTimeout(6000);
  const r = await pg.evaluate(async () => {
    const wait = (ms) => new Promise((res) => setTimeout(res, ms));
    if (!document.querySelector('#sec-sky .state-you')) document.querySelector('#sec-sky-tab')?.click();
    await wait(400);
    const you = () => { const e = document.querySelector('#sec-sky .state-you'); return e && !e.hidden ? e.textContent : ''; };
    const before = you();
    const si = await import('./lib/sky_interim.js'), s = await import('./lib/sky.js');
    si.showInterimSky(null); await wait(100); const early = you(); await wait(800); const during = you(); const busy = s.skyBusy();
    si.hideInterimSky(); await wait(300); const after = you();
    return { before, early, during, busy, after };
  });
  console.log('   ', JSON.stringify(r));
  check("the stand-in gradient shows 'loading…' in the sky panel, and skyBusy() agrees", /loading/.test(r.during) && r.busy === true, JSON.stringify(r));
  // the ARRIVAL shows at once (the stand-in lasts minutes); only render calls wait LOAD_SHOW_MS (sky-state-probe binds that)
  check('…at once: the arrival is not debounced like a render', /loading/.test(r.early), r.early);
  check('…and it goes away after', !/loading/.test(r.after), r.after);
  check('no page errors', errs.length === 0, errs.slice(0, 2).join(' | '));
} catch (e) { check('probe ran', false, e.message); }
finally { try { await browser.close(); } catch {} try { await world.close(); } catch {} }
done();
