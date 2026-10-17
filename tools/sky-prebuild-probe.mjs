// sky-prebuild-probe — with a headset present on the high tier, the VR cap's bake program is compiled on the desktop
// beforehand (owner, 09-27 21:52), via a 64x32 bake into a TEMPORARY target. This checks the plumbing on the clear-sky
// tier (cloudless: headless-safe): the sky's own env target and reflection fallback are untouched, the prebuilt graph
// is kept (so its program stays cached), and the temporary target is freed.
//   bun tools/sky-prebuild-probe.mjs
import { launchBrowser, ownedWorld, checker } from './probe-harness.mjs';
const { check, done } = checker();
const world = await ownedWorld({});
const { browser, page } = await launchBrowser(); const pg = await page();
const errs = []; pg.on('pageerror', (e) => errs.push(String(e)));
try {
  await pg.goto(`${world.origin}/`, { waitUntil: 'domcontentloaded' });
  await pg.evaluate(() => localStorage.setItem('ew-cloud-quality', 'off'));
  await pg.goto(`${world.origin}/?world=staging&name=prebuild&key=${world.key}&lite=0`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await pg.waitForFunction(() => globalThis.__ewEngineUp, null, { timeout: 120000 });
  await pg.evaluate(async () => { const { sendVerb } = await import('./lib/net.js'); sendVerb('sky', { hours: 12, rate: 0, clouds: 'clear', weather: 'clear' }); });
  for (let i = 0; i < 90 && !(await pg.evaluate(async () => (await import('./lib/sky_baked.js')).bakedActive())); i++) await pg.waitForTimeout(1000);
  const r = await pg.evaluate(async () => {
    const s = await import('./lib/sky.js'); const { sys } = s.skyForProbe();
    const T = sys._envTarget, size = `${T?.width}x${T?.height}`, fb = sys._envFbNode?.value;
    let disposedTemp = 0; const tempWidths = []; const RT = T.constructor, origDispose = RT.prototype.dispose;
    RT.prototype.dispose = function () { if (this !== T) { tempWidths.push(this.width); if (this.width === 64) disposedTemp++; } return origDispose.call(this); };
    // a bake that starts WHILE the prebuild runs (the live tier's env bake, the VR cap's swap) must not draw into the
    // prebuild's temporary target, which is disposed when it ends (owner's rig 09-27 22:30: black VR sky)
    const pre = s.prebuildBakeProgram(8, { includeClouds: false });
    const { api } = s.skyForProbe();
    const concurrent = api.bakeEnv({ width: 1024, height: 512, cloudPasses: 1, includeClouds: false });
    const ok = await pre; await concurrent;
    RT.prototype.dispose = origDispose;
    return { ok, sameTarget: sys._envTarget === T, size, sizeAfter: `${sys._envTarget?.width}x${sys._envTarget?.height}`, fbSame: sys._envFbNode?.value === fb || sys._envFbNode?.value === T.texture, kept: sys.__keptBakeKeys?.() ?? [], cur: sys._envBake?.key, disposedTemp, tempWidths };
  });
  console.log('   ', JSON.stringify(r));
  check('the prebuild ran', r.ok === true, JSON.stringify(r));
  check("the sky's own env target is untouched (same object, same size)", r.sameTarget && r.size === r.sizeAfter, JSON.stringify(r));
  check('the reflection fallback points at the sky\'s own bake (never the temporary)', r.fbSame === true, JSON.stringify(r));
  check('the prebuilt graph is kept (its program stays cached)', r.kept.includes('64x32|p8|c0') || r.cur === '64x32|p8|c0', JSON.stringify(r));
  check('a bake started during the prebuild waits for it: nothing it drew is thrown away', r.tempWidths.every((w) => w === 64), JSON.stringify(r));
  check('the temporary target is freed', r.disposedTemp === 1, JSON.stringify(r));
  // a prebuild whose bake throws is NOT a prebuilt program (Greptile #206): it must say so, so the cap isn't marked ready
  const failed = await pg.evaluate(async () => {
    const s = await import('./lib/sky.js'); const { api } = s.skyForProbe();
    const orig = api.bakeEnv; api.bakeEnv = async () => { throw new Error('probe: forced bake failure'); };
    try { return await s.prebuildBakeProgram(8, { includeClouds: false }); } finally { api.bakeEnv = orig; }
  });
  check('a prebuild whose bake throws reports false (not prebuilt)', failed === false, `returned ${failed}`);
  check('no page errors', errs.length === 0, errs.slice(0, 3).join(' | '));
} catch (e) { check('probe ran', false, e.message); }
finally { try { await browser.close(); } catch {} try { await world.close(); } catch {} }
done();
