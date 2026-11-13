// sky-bake-time-probe — every strip of a bake draws at ONE sky time (owner, 09-27: VR sky 'banding'). A bake is drawn in
// strips across many frames; each strip used to march the clouds at its own frame's time, so strip edges were seams.
// Real client, the clear-sky tier (cloudless: headless-safe): spies the draws into the bake targets and reads the sky
// time uniform at each, across a few cadence cycles. The sun check binds: after each strip the probe nudges the LIVE sun
// (in a microtask, i.e. after the draw's snapshot restore), so a strip that isn't drawn from the snapshot records it.
//   bun test/client/sky-bake-time-probe.mjs
import { launchBrowser, ownedWorld, checker, skyBoot } from '../harness/probe-harness.mjs';
const { check, done } = checker();
const world = await ownedWorld({ owner: 'baketime', env: { TRUST_NAMES: '1' } });   // the page owns staging, so its @world writes are admitted
const { browser, page } = await launchBrowser(); const pg = await page();
const errs = []; pg.on('pageerror', (e) => errs.push(String(e)));
try {
  await skyBoot(pg, world, 'baketime', { sky: { hours: 9, rate: 60, clouds: 'clear', weather: 'clear' }, baked: true });   // a fast day: the sun moves between strips
  await pg.evaluate(async () => {
    const { sys } = (await import('./lib/sky/sky.js')).skyForProbe(); const r = globalThis.EW.renderer;
    const W = sys._envTarget?.width; globalThis.__bt = [];
    // "separate frames" is counted in animation frames, not ms: a fast host draws consecutive strips 16 ms apart (macOS CI)
    globalThis.__frame = 0; const tick = () => { globalThis.__frame++; requestAnimationFrame(tick); }; requestAnimationFrame(tick);
    const orig = r.render.bind(r);
    r.render = (sc, cam) => { const t = r.getRenderTarget(); if (t && t.width === W && sc?.children?.[0]?.material === sys._envBake?.scene?.children?.[0]?.material) { const d = sys.uniforms.sunDir.value; globalThis.__bt.push([performance.now(), sys.uniforms.time.value, `${d.x.toFixed(5)},${d.y.toFixed(5)}`, globalThis.__frame]); queueMicrotask(() => { sys.uniforms.sunDir.value.x += 0.001; }); } return orig(sc, cam); };
  });
  // until two multi-strip bakes are recorded (cadence bakes; the probe's verdicts read the same cycles)
  await pg.waitForFunction(() => { let n = 0, cur = null; for (const [ms, , , f] of globalThis.__bt) { if (!cur || ms - cur.last > 1500) { if (cur && cur.n > 1 && cur.frames.size > 1) n++; cur = { n: 0, last: ms, frames: new Set() }; } cur.n++; cur.last = ms; cur.frames.add(f); } return n >= 2; }, null, { timeout: 120000, polling: 1000 }).catch(() => {});
  const r = await pg.evaluate(() => {
    const v = globalThis.__bt; const cycles = []; let cur = null;
    for (const [ms, t, sd, f] of v) { if (!cur || ms - cur.last > 1500) { cur = { times: new Set(), suns: new Set(), frames: new Set(), n: 0, first: ms, last: ms }; cycles.push(cur); } cur.times.add(t.toFixed(4)); cur.suns.add(sd); cur.frames.add(f); cur.n++; cur.last = ms; }
    return cycles.map((c) => ({ strips: c.n, frames: c.frames.size, distinctTimes: c.times.size, distinctSuns: c.suns.size, spanMs: Math.round(c.last - c.first) }));
  });
  console.log('   ', JSON.stringify(r));
  const multi = r.filter((c) => c.strips > 1 && c.frames > 1);
  check('cadence bakes ran with strips on separate frames', multi.length >= 2, JSON.stringify(r));
  check('every strip of a bake is drawn at one sky time', multi.length >= 2 && multi.every((c) => c.distinctTimes === 1), JSON.stringify(multi));
  check('…and one sun position, with the day running fast (the atmosphere bands)', multi.length >= 2 && multi.every((c) => c.distinctSuns === 1), JSON.stringify(multi));
  check('no page errors', errs.length === 0, errs.slice(0, 3).join(' | '));
} catch (e) { check('probe ran', false, e.message); }
finally { try { await browser.close(); } catch {} try { await world.close(); } catch {} }
done();
