// sky-bakelock-probe — the bake lock (serializeBakes) runs each bake's renderAsync interceptor INSIDE the lock, right
// before that bake (review 7, B1: patched outside, it caught the bake queued ahead and its own went out as one full-quad
// draw), and skips a bake still queued when its sky is torn down (H1). Off tier, cloudless: headless-safe. Adapted from
// the reviewer's scratch probe.
//   bun tools/sky-bakelock-probe.mjs
import { launchBrowser, ownedWorld, checker } from './probe-harness.mjs';
const { check, done } = checker();
const world = await ownedWorld({});
const { browser, page } = await launchBrowser(); const pg = await page();
const errs = []; pg.on('pageerror', (e) => errs.push(String(e)));
try {
  await pg.goto(`${world.origin}/`, { waitUntil: 'domcontentloaded' });
  await pg.evaluate(() => localStorage.setItem('ew-cloud-quality', 'off'));
  await pg.goto(`${world.origin}/?world=staging&name=r7&key=${world.key}&lite=0`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await pg.waitForFunction(() => globalThis.__ewEngineUp, null, { timeout: 120000 });
  await pg.evaluate(async () => { const { sendVerb } = await import('./lib/net.js'); sendVerb('sky', { hours: 12, rate: 0, clouds: 'clear', weather: 'clear' }); });
  for (let i = 0; i < 90 && !(await pg.evaluate(async () => (await import('./lib/sky_baked.js')).bakedActive())); i++) await pg.waitForTimeout(1000);
  const A = await pg.evaluate(async () => {
    const s = await import('./lib/sky.js'); const { sys, api } = s.skyForProbe(); const r = globalThis.EW.renderer;
    const out = { caught: [], realBakeRenders: [] };
    const REAL = r.renderAsync;
    r.renderAsync = function (sc, cam) {   // spy on the real one: which bakes reach it un-intercepted
      if (sc === sys._envBake?.scene) out.realBakeRenders.push(`${r.getRenderTarget()?.width}x${r.getRenderTarget()?.height}`);
      return REAL.call(this, sc, cam);
    };
    const SPY = r.renderAsync;
    let rel; const hold = sys.__withBakeLock(() => new Promise((res) => { rel = res; }));
    await new Promise((res) => setTimeout(res, 50));
    const q1 = api.bakeEnv({ width: 1024, height: 512, cloudPasses: 1, includeClouds: false });   // a queued bake with no interceptor (runEnvBake)
    // the client's pattern now: the interceptor rides on the bake's opts and is installed inside the lock
    const { BAKE_INTERCEPT } = await import('./lib/sky_baked.js');
    let origRA = null;
    const interceptor = function (sc, cam) {
      if (sc !== sys._envBake?.scene) return origRA.call(this, sc, cam);
      r.renderAsync = origRA;
      out.caught.push(`${r.getRenderTarget()?.width}x${r.getRenderTarget()?.height}`);
      return origRA.call(this, sc, cam);
    };
    const install = () => { origRA = r.renderAsync; r.renderAsync = interceptor; return () => { if (r.renderAsync === interceptor) r.renderAsync = origRA; }; };
    const q2 = api.bakeEnv({ width: 512, height: 256, cloudPasses: 1, includeClouds: false, [BAKE_INTERCEPT]: install });
    rel(); await hold; await q1; await q2;
    r.renderAsync = REAL;
    return out;
  });
  console.log('    A', JSON.stringify(A));
  check('an interceptor catches ITS OWN bake (512x256), not the one queued ahead', A.caught.length === 1 && A.caught[0] === '512x256', JSON.stringify(A));
  const B = await pg.evaluate(async () => {
    const s = await import('./lib/sky.js'); const { sys, api } = s.skyForProbe();
    let rel; const hold = sys.__withBakeLock(() => new Promise((res) => { rel = res; }));
    await new Promise((res) => setTimeout(res, 50));
    const q = api.bakeEnv({ width: 1024, height: 512, cloudPasses: 1, includeClouds: false });
    await s.applySky({ system: 'skymesh', hours: 12 });   // teardown to the basic sky: the engine is disposed
    const afterTeardown = { target: !!sys._envTarget, bake: !!sys._envBake, impl: s.skyImpl() };
    rel(); await hold; let err = null; try { await q; } catch (e) { err = String(e?.message ?? e); }
    return { afterTeardown, afterQueued: { target: sys._envTarget ? `${sys._envTarget.width}x${sys._envTarget.height}` : null, bake: sys._envBake?.key ?? null }, err };
  });
  console.log('    B', JSON.stringify(B));
  check('a bake queued when its sky is torn down is skipped (nothing rebuilt on the dead system)', B.afterTeardown.impl === 'skymesh' && B.afterQueued.target === null && B.afterQueued.bake === null, JSON.stringify(B));
  check('no page errors', errs.length === 0, errs.slice(0, 3).join(' | '));
} catch (e) { check('probe ran', false, e.message); }
finally { try { await browser.close(); } catch {} try { await world.close(); } catch {} }
done();
