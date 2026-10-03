// sky-bakegraph-probe — sky_system keeps one bake graph and disposed it whenever a bake with another key arrived, so
// switching tiers back and forth re-created the 1.76M-char bake program (owner's rig 09-27: a ~3 s GPU stall on
// high→medium). sky.js now keeps evicted graphs alive (one per key), so their programs stay in three's source-keyed
// program cache. Headless-safe: the off tier, cloudless bakes only. Cloudless graphs share one shader at every size,
// so this can't show the program-cache hit itself (that needs the cloud march): it checks the retention the hit rests on.
//   bun tools/sky-bakegraph-probe.mjs
import { launchBrowser, ownedWorld, checker } from './probe-harness.mjs';
const { check, done } = checker();
const world = await ownedWorld({});
const { browser, page } = await launchBrowser(); const pg = await page();
const errs = []; pg.on('pageerror', (e) => errs.push(String(e)));
const lines = []; pg.on('console', (m) => lines.push(m.text()));
try {
  await pg.goto(`${world.origin}/`, { waitUntil: 'domcontentloaded' });
  await pg.evaluate(() => localStorage.setItem('ew-cloud-quality', 'off'));
  await pg.goto(`${world.origin}/?world=staging&name=bakegraph&key=${world.key}&lite=0`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await pg.waitForFunction(() => globalThis.__ewEngineUp, null, { timeout: 120000 });
  await pg.evaluate(async () => { const { sendVerb } = await import('./lib/net.js'); sendVerb('sky', { hours: 12, rate: 0, clouds: 'clear', weather: 'clear' }); });
  for (let i = 0; i < 180 && !lines.some((l) => /the real sky is up/.test(l)); i++) await pg.waitForTimeout(500);
  const r = await pg.evaluate(async () => {
    const { api, sys } = (await import('./lib/sky.js')).skyForProbe();
    const ev = []; const seen = new Map(); let n = 0;
    const tag = (b) => { if (!b) return 'null'; if (!seen.has(b)) { const t = `${b.key.split('|')[0]}#${n++}`; seen.set(b, t); b.scene.children[0].material.addEventListener('dispose', () => ev.push(`x${t}`)); } return seen.get(b); };
    const bake = async (w) => { await api.bakeEnv({ width: w, height: w / 2, cloudPasses: 1, includeClouds: false }); ev.push(`=${tag(sys._envBake)}`); };
    ev.push(`=${tag(sys._envBake)}`);
    await bake(512); await bake(1024);
    const beforeTeardown = ev.filter((e) => e[0] === 'x').length, keptKeys = sys.__keptBakeKeys?.() ?? [];
    sys.__disposeKeptBakes?.();
    return { trace: ev.join(' '), beforeTeardown, keptKeys, freed: ev.filter((e) => e[0] === 'x').length - beforeTeardown, graphs: n };
  });
  console.log('   ', JSON.stringify(r));
  check('an evicted bake graph is kept alive, not disposed, through later bakes (its program stays cached)', r.beforeTeardown === 0 && r.keptKeys?.length === 2, JSON.stringify(r));
  check('teardown frees every graph (kept and current)', r.freed === r.graphs && r.graphs === 3, JSON.stringify(r));
  check('no page errors', errs.length === 0, errs.slice(0, 3).join(' | '));
} catch (e) { check('probe ran', false, e.message); }
finally { try { await browser.close(); } catch {} try { await world.close(); } catch {} }
done();
