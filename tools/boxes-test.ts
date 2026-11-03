// Process-wide concurrency, in-flight deduplication, and failed-read recovery.
// bun tools/boxes-test.ts
import { mock } from 'bun:test';
import { mkCheck } from './harness.ts';
const { check, tally } = mkCheck();
let active = 0, peak = 0;
const reads = new Map<string, number>(), release: (() => void)[] = [];
mock.module(new URL('../server/lint.ts', import.meta.url).pathname, () => ({ resolveLibFile: (lib: string) => lib }));
mock.module(new URL('../server/geometry.ts', import.meta.url).pathname, () => ({
  summarizeGlb: async (lib: string) => {
    reads.set(lib, (reads.get(lib) ?? 0) + 1); peak = Math.max(peak, ++active);
    await new Promise<void>(done => release.push(done));
    active--;
    if (lib === 'bad.glb') throw new Error('unreadable GLB');
    return { bbox: { min: [0.0002, 0, 0], max: [1.0002, 1, 1] } };
  },
}));
const { warmBoxes, boxOf } = await import('../server/boxes.ts');
const libs = [...Array.from({ length: 11 }, (_, i) => `model${i}.glb`), 'bad.glb'];
let done = false;
const jobs = Promise.all(Array.from({ length: 10 }, () => warmBoxes(libs))).then(() => { done = true; });
check('ten callers share four worker slots', active === 4 && reads.size === 4);
for (let turn = 0; turn < 100 && !done; turn++) {
  release.splice(0).forEach(resolve => resolve());
  await Bun.sleep(0);
}
if (!done) throw new Error('warming failed to drain');
await jobs;
check('the global peak is four', peak === 4);
check('each library was summarized once across all callers', reads.size === libs.length && [...reads.values()].every(n => n === 1));
check('failed reads release their slot and become boxless', active === 0 && boxOf('bad.glb') === null);
check('successful reads retain the millimetre stamp', JSON.stringify(boxOf('model0.glb')) === '[[0,0,0],[1,1,1]]');
await warmBoxes(libs);
check('warm repeats, including failures, perform no more reads', [...reads.values()].every(n => n === 1));
console.log(`${tally.passed} passed, ${tally.failed} failed`);
process.exit(tally.failed ? 1 : 0);
