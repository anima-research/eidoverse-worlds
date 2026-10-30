// swim-lists-test — the browser's swimming query (watervolumes.js waterAt) reads every water body and dry pocket, as the
// shared law does, not only the ones the fog keeps (MAX_WATER bodies, MAX_AIR pockets).
//
//   BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun tools/swim-lists-test.ts
import { scratchBench, mkCheck } from './harness.ts';
import { pageWaiter, tryUntil } from './protocol/wait.ts';

const WORLD = 'swim';
const { cdp, evalJson, cleanup, die, BASE } = await scratchBench('swim-lists', { worlds: [WORLD], owner: 'swimmer', serverEnv: { TRUST_NAMES: '1' } });
const { check, tally } = mkCheck();
try {
  await cdp.send('Page.navigate', { url: `${BASE}/?name=swimmer&world=${WORLD}&spectate=1&webgl=1` });
  if (!(await tryUntil('the water module', () => evalJson('!!globalThis.__waterDebug').catch(() => false), { ms: 30000 }))) await die(1, 'the water module never loaded');
  await pageWaiter(evalJson)(`import('/lib/state.js').then((m) => !!m.state.hydrated)`, 10000);
  const out = await evalJson(`(async () => {
    const st = await import('/lib/state.js');
    const { MAX_WATER, MAX_AIR } = await import('/shared/water.js');
    const w = await import('/lib/watervolumes.js'); w.setWaterObjects(() => new Map());
    const rec = (pos, comps) => ({ pos, q: [0, 0, 0, 1], scale: 1, ...comps });
    const entities = {};
    for (let i = 0; i <= MAX_WATER; i++) entities['pool' + i] = rec([i * 20, -5, 0], { zone: { shape: 'box', size: [10, 10, 10], priority: i }, water: {} });
    entities.sea = rec([0, -5, 200], { zone: { shape: 'box', size: [400, 10, 10], priority: MAX_WATER + 1 }, water: {} });
    for (let i = 0; i <= MAX_AIR; i++) entities['dry' + String(i).padStart(2, '0')] = rec([i * 10 - 150, -5, 200], { zone: { shape: 'box', size: [4, 4, 4], priority: MAX_WATER + 2 }, 'water-exclusion': {} });
    st.applyView({ ...st.state.st, entities }); w.updateWater();
    const at = (p) => w.waterAt(p)?.id ?? null;
    return { MAX_WATER, MAX_AIR, debug: w.waterDebug(), pool0: at([0, -5, 0]), top: at([MAX_WATER * 20, -5, 0]), dropped: at([-150, -5, 200]), kept: at([MAX_AIR * 10 - 150, -5, 200]), open: at([100, -5, 200]) };
  })()`);
  const fog = out?.debug ?? {};
  check('(setup) more bodies and pockets than the fog keeps', fog.waters === out?.MAX_WATER && fog.air === out?.MAX_AIR, JSON.stringify(out));
  check('the lowest-priority body, one the fog drops, is water to swim in', out?.pool0 === 'pool0', JSON.stringify(out));
  check('…as the highest is', out?.top === `pool${out?.MAX_WATER}`, JSON.stringify(out));
  check('a pocket the fog drops still keeps the water out', out?.dropped === null, JSON.stringify(out));
  check('…as one it keeps does, while the open sea beside them is water', out?.kept === null && out?.open === 'sea', JSON.stringify(out));
} catch (e: any) { check('the test ran to the end', false, String(e?.stack ?? e).slice(0, 500)); }
finally {
  console.log(`\n${tally.passed} passed, ${tally.failed} failed`);
  await cleanup(tally.failed ? 1 : 0);
}
process.exit(tally.failed ? 1 : 0);
