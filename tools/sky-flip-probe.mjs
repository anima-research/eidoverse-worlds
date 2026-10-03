// bun tools/sky-flip-probe.mjs — time a cloud-quality flip through the REAL setCloudQuality (sky.js), and print the
// per-phase line it tees ("[sky] rebuild (…): phase ms (long N×, blocked ms)"). Headless is SwiftShader, so absolute
// numbers are not the owner's GPU — the SHAPE (which phase holds the long tasks) is what this is for. Env: FLIPS
// (default "off,medium").
// GPU ONLY since 40ab88c (09-27): low/medium/high share one sky system, so a flip among them no longer rebuilds (this
// probe then reads an empty measurement), and the flips that still rebuild (off ↔ a cloudy tier) boot the cloud march,
// which a headless machine renders on the CPU until it runs out of memory. Run it where Chromium has a GPU, with
// SKY_FLIP_GPU=1 and FLIPS=off,medium (say).
import { launchBrowser, ownedWorld, checker } from './probe-harness.mjs';
if (process.env.SKY_FLIP_GPU !== '1') { console.log('sky-flip-probe: skipped (GPU only; set SKY_FLIP_GPU=1 where Chromium has a GPU)'); process.exit(0); }
const { check, done } = checker();
const world = await ownedWorld(process.env.GC_WORLD ? { env: { WORLDS_DIR: process.env.GC_WORLD } } : {});
const { browser, page } = await launchBrowser();
try {
  const pg = await page();
  const lines = []; pg.on('console', (m) => { const t = m.text(); if (/\[sky\]/.test(t)) lines.push(t); });
  const errs = []; pg.on('pageerror', (e) => errs.push(String(e)));
  await pg.goto(`${world.origin}/?world=${process.env.GC_NAME ?? 'staging'}&name=skyflip&key=${world.key}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await pg.waitForFunction(() => globalThis.__ewEngineUp, null, { timeout: 90000 });
  await pg.waitForTimeout(8000);
  // tee() goes to the server, not the console — capture it in the page
  await pg.evaluate(async () => { const B = await import('./lib/base.js'); const o = globalThis.fetch;
    globalThis.__teed = []; globalThis.fetch = (u, init) => { if (String(u).startsWith('/clientlog')) globalThis.__teed.push(String(init?.body ?? '')); return o(u, init); }; });
  for (const q of (process.env.FLIPS ?? 'off,medium').split(',')) {
    const r = await Promise.race([pg.evaluate(async (q) => { const S = await import('./lib/sky.js'); const t0 = performance.now(); await S.setCloudQuality(q); return { q, ms: Math.round(performance.now() - t0), now: S.getCloudQuality() }; }, q),
      new Promise((_, rej) => setTimeout(() => rej(new Error('flip pinned 240 s')), 240000))]);
    console.log(`   flip → ${r.q}: ${r.ms} ms (now ${r.now})`);
    await pg.waitForTimeout(2500);
  }
  const teed = await pg.evaluate(() => globalThis.__teed.join('\n').split('\n').filter((l) => /\[sky\] rebuild/.test(l)));
  for (const l of teed) console.log('   ' + l.slice(0, 400));
  check('the flips actually rebuilt a sky (not an empty measurement)', teed.every((l) => /makeSky/.test(l)), teed.map((l) => l.slice(0, 80)));
  check('each flip teed its phase line', teed.length >= (process.env.FLIPS ?? 'off,medium').split(',').length, teed.length);
  check('no page errors', errs.length === 0, errs.slice(0, 2).join(' | ') || 'none');
} catch (e) { check('probe ran', false, String(e).slice(0, 300)); }
finally { await browser.close(); await world.close(); }
done();
