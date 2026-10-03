// bun tools/ground-now-probe.mjs — World › ground shows what the world HAS ("world: …") above the composer dials
// (which default to meadow and read like a report — the owner and I misread galleta_dry as meadow, 09-24). Grows two
// different plantings through the real grass verb, then mows, and reads the line after each.
import { launchBrowser, ownedWorld, checker } from './probe-harness.mjs';
const { check, done } = checker();
const world = await ownedWorld({});
const { browser, page } = await launchBrowser();
try {
  const pg = await page();
  const errs = []; pg.on('pageerror', (e) => errs.push(String(e)));
  await pg.goto(`${world.origin}/?world=staging&name=groundnow&key=${world.key}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await pg.waitForFunction(() => globalThis.__ewEngineUp && document.querySelector('#sec-ground-tab'), null, { timeout: 90000 });
  const read = () => pg.evaluate(() => document.querySelector('#sec-ground .ground-now .state-world')?.textContent ?? null);
  await pg.evaluate(() => document.querySelector('#sec-ground-tab').click());
  await pg.waitForFunction(() => document.querySelector('#sec-ground .ground-now'), null, { timeout: 20000 });
  const empty = await read();
  const grow = async (args) => { await pg.evaluate(async (a) => { const { sendVerb } = await import('./lib/net.js'); sendVerb('grass', a); }, args); await pg.waitForTimeout(2500); return read(); };
  const tufts = await grow({ species: 'galleta_dry', width: 40, depth: 40, center: [0, 0], height: 0.42, density: 0.5 });
  const meadow = await grow({ species: 'grass', width: 40, depth: 40, center: [0, 0], height: 0.6, density: 0.8 });
  // log entries that do not change the grass (a light placed, then removed) must not touch the line: an unchanged write
  // still swaps its text node, and in VR the World panel re-rasterises on every mutation
  const quiet = await pg.evaluate(async () => {
    const el = document.querySelector('#sec-ground .ground-now'); let n = 0;
    const seen = []; const mo = new MutationObserver((l) => { n += l.length; for (const m of l) seen.push([m.type, m.target.nodeName, m.target.className ?? '', (m.target.textContent ?? '').slice(0, 80)]); }); mo.observe(el, { childList: true, characterData: true, subtree: true });
    const { sendVerb } = await import('./lib/net.js');
    sendVerb('light', { id: 'gnq1', pos: [3, 1, 3], color: 0xffd9a0, intensity: 4, range: 5 });
    await new Promise((r) => setTimeout(r, 1200));
    sendVerb('remove', { id: 'gnq1' });
    await new Promise((r) => setTimeout(r, 1200));
    mo.disconnect(); globalThis.__gnSeen = seen; return n;
  });
  check('unrelated log entries leave the readout untouched (0 mutations)', quiet === 0, JSON.stringify(await pg.evaluate(() => globalThis.__gnSeen)));
  // "you:" appears only while this client draws less than the world has, and names why
  const you = () => pg.evaluate(() => { const y = document.querySelector('#sec-ground .state-you'); return y && !y.hidden ? y.textContent : null; });
  const youFull = await you();
  await pg.evaluate(async () => { const t = await import('./lib/terrain.js'); t.setGrassQuality('low'); });
  await pg.waitForTimeout(300);
  const youLow = await you();
  await pg.evaluate(async () => { const t = await import('./lib/terrain.js'); t.setGrassQuality('off'); });
  await pg.waitForTimeout(300);
  const youOff = await you();
  await pg.evaluate(async () => { const t = await import('./lib/terrain.js'); t.setGrassQuality('full'); });
  await pg.waitForTimeout(300);
  const youBack = await you();
  console.log('   ', JSON.stringify({ youFull, youLow, youOff, youBack }));
  // headless draws in software, so the auto governor may shed on its own mid-probe; that shows in "you:" too (correctly)
  check('full cap: "you:" doesn\'t name your grass⚙', !/your grass⚙/.test(youFull ?? ''), youFull);
  check('low cap: "you:" names your grass⚙', /^you: drawing ×[\d.]+ of it \(.*your grass⚙ low\)/.test(youLow ?? ''), youLow);
  check('off cap: "you: no grass drawn"', /^you: no grass drawn/.test(youOff ?? ''), youOff);
  check('back to full: your grass⚙ leaves the line', !/your grass⚙/.test(youBack ?? ''), youBack);
  const mown = await grow({ clear: true });
  console.log('   ', JSON.stringify({ empty, tufts, meadow, mown }));
  check('empty world: "world: no grass"', /^world: no grass/.test(empty ?? ''), empty);
  check('galleta_dry reads as the palette\'s "tufts", with its numbers', /^world: tufts \(galleta_dry\) · density 0\.5 · height 0\.42/.test(tufts ?? ''), tufts);
  check('the line follows a new planting (meadow)', /^world: meadow \(grass\) · density 0\.8/.test(meadow ?? ''), meadow);
  check('…and a mow', /^world: no grass/.test(mown ?? ''), mown);
  check('no page errors', errs.length === 0, errs.slice(0, 2).join(' | ') || 'none');
} catch (e) { check('probe ran', false, String(e).slice(0, 300)); }
finally { await browser.close(); await world.close(); }
done();
