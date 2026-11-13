// bun tools/shadow-res-probe.mjs — Video › shadow resolution governs EVERY caster: the sun takes n, the lamp slot
// scales from its tuned 256 (2048 → exactly 256: the default look is unchanged). Boots with a stored 4096 so the
// module-init path runs (a TDZ there would take the client down), then steps 1024 and 2048.
import { launchBrowser, ownedWorld, checker } from './probe-harness.mjs';
const { check, done } = checker();
const world = await ownedWorld({});
const { browser, page } = await launchBrowser();
try {
  const pg = await page();
  const errs = []; pg.on('pageerror', (e) => errs.push(String(e)));
  await pg.addInitScript(() => { try { localStorage.setItem('ew-shadow-res', '4096'); } catch {} });
  await pg.goto(`${world.origin}/?world=staging&name=shprobe&key=${world.key}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await pg.waitForFunction(() => globalThis.__ewEngineUp, null, { timeout: 60000 });
  const r = await pg.evaluate(async () => {
    const L = await import('./lib/lightrig.js'); const { sun } = await import('./lib/core.js');
    const at = () => ({ sun: sun.shadow.mapSize.x, lamp: L.lampShadowState()?.map });
    const boot = at();
    L.setShadowRes(1024); const low = at();
    L.setShadowRes(2048); const def = at();
    return { boot, low, def };
  });
  console.log('  ', JSON.stringify(r));
  check('boot with a stored 4096: sun 4096, lamp 512', r.boot.sun === 4096 && r.boot.lamp === 512, JSON.stringify(r.boot));
  check('1024: sun 1024, lamp 128', r.low.sun === 1024 && r.low.lamp === 128, JSON.stringify(r.low));
  check('2048 (default): sun 2048, lamp exactly its tuned 256', r.def.sun === 2048 && r.def.lamp === 256, JSON.stringify(r.def));
  check('no page errors', errs.length === 0, errs.slice(0, 2).join(' | ') || 'none');
} catch (e) { check('probe ran to completion', false, String(e).slice(0, 300)); }
finally { await browser.close(); await world.close(); }
done();
