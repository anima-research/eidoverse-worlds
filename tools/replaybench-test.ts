// A replay gate must reject deterministic changes, not just disagreeing runs.
// bun tools/replaybench-test.ts
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ROOT, mkCheck } from './harness.ts';
const { check, tally } = mkCheck();
const scratch = mkdtempSync(join(tmpdir(), 'ew-replay-mutations-'));
const simPath = join(ROOT, 'shared/sim.js');
const mutations = {
  'remove colliders': 's.statics = {};',
  'move collider': 'Object.values(s.statics)[0].aabb[0][0] += 1;',
  'change stamped box': 'Object.values(s.boxes)[0][0][0] += 1;',
  'reverse static insertion order': 's.statics = Object.fromEntries(Object.entries(s.statics).reverse());',
  'reverse body insertion order': 's.bodies = Object.fromEntries(Object.entries(s.bodies).reverse());',
};
try {
  async function run(preload?: string) {
    const p = Bun.spawn([process.execPath, ...(preload ? ['--preload', preload] : []), join(ROOT, 'tools/replaybench.ts'), 'eidosim-order'], {
      cwd: ROOT, env: { ...process.env, WORLDS_DIR: join(scratch, 'worlds') }, stdout: 'pipe', stderr: 'pipe',
    });
    const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    return { out, err, code };
  }
  const control = await run();
  check('committed sim golden baseline passes', control.code === 0, control.out + control.err);
  const runner = join(scratch, 'cross-engine.mjs');
  writeFileSync(runner, `
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {emptySim,simEntry,advanceSim,simSnapshot} from ${JSON.stringify(simPath)};
import {emptyState,foldEntry} from ${JSON.stringify(join(ROOT,'shared/fold.js'))};
const sim=emptySim(), state=emptyState();
for(const line of readFileSync(${JSON.stringify(join(ROOT,'spec/fixtures/replay/eidosim-order/log.jsonl'))},'utf8').trim().split('\\n')) {
  const entry=JSON.parse(line);foldEntry(state,entry);simEntry(sim,entry,state);
}
advanceSim(sim,sim.tick+100000);
const {tick,...normative}=simSnapshot(sim);
console.log(createHash('sha256').update(JSON.stringify(normative)).digest('hex').slice(0,16));
`);
  const golden = JSON.parse(await Bun.file(join(ROOT,'spec/fixtures/replay/.replaybench.json')).text())['eidosim-order'].simDigest;
  for (const engine of ['bun', 'node', 'deno']) {
    const executable = Bun.which(engine);
    if (!executable) { console.log(`  ${engine} unavailable — cross-engine leg not run`); continue; }
    const p = Bun.spawn([executable, ...(engine==='deno'?['run','--allow-read']:[]), runner], { stdout:'pipe', stderr:'pipe' });
    const [out,err,code] = await Promise.all([new Response(p.stdout).text(),new Response(p.stderr).text(),p.exited]);
    check(`${engine}: 0.5 full ordered state matches the golden`, code===0 && out.trim()===golden, code ? err : out.trim());
  }
  for (const [name, mutation] of Object.entries(mutations)) {
    const preload = join(scratch, 'mutation.ts');
    writeFileSync(preload, `import {mock} from 'bun:test';
const real = await import(${JSON.stringify(simPath)});
const snapshot = real.simSnapshot;
mock.module(${JSON.stringify(simPath)}, () => ({...real, simSnapshot(sim) {
  const s = snapshot(sim);
  if(s.statics && Object.keys(s.statics).length && Object.keys(s.bodies).length > 1) { ${mutation} }
  return s;
}}));\n`);
    const result = await run(preload);
    check(`${name} makes the gate red`, result.code === 1 && result.out.includes('SIM BASELINE mismatch'), result.out + result.err);
  }
} finally { rmSync(scratch, { recursive: true, force: true }); }
console.log(`${tally.passed} passed, ${tally.failed} failed`);
process.exit(tally.failed ? 1 : 0);
