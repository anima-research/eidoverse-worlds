// Failure paths retain owned server/browser evidence, not just startup errors.
// bun tools/harness-test.ts
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scratchBench, scratchSequencer, mkCheck, ROOT, sleep } from './harness.ts';
const mode = process.argv[2];
if (mode === 'assertion') {
  const { evalJson, cleanup } = await scratchBench('harness-assertion', { portFrom: 9010 });
  const { check } = mkCheck();
  await evalJson(`console.warn('retained-console-sentinel'); setTimeout(() => { throw Error('retained-runtime-sentinel'); }, 0);`);
  await sleep(100);
  let caught = false;
  try { await evalJson(`throw Error('retained-eval-sentinel')`); } catch { caught = true; }
  check('evalJson surfaces exceptionDetails', caught);
  check('intentional assertion failure', false);
  await cleanup(); // must preserve evidence even on this ordinary path
  process.exit(1);
}
if (mode === 'nonce') {
  await scratchSequencer('harness-nonce', { portFrom: 9010, preload: process.argv[3] });
  throw Error('accepted a foreign nonce');
}
const { check, tally } = mkCheck();
const scratch = mkdtempSync(join(tmpdir(), 'ew-harness-test-'));
try {
  const preload = join(scratch, 'foreign.ts');
  writeFileSync(preload, `process.env.BENCH_NONCE = 'another-child';\n`);
  for (const scenario of ['nonce', 'assertion']) {
    const p = Bun.spawn([process.execPath, import.meta.path, scenario, preload], { cwd: ROOT, stdout: 'pipe', stderr: 'pipe' });
    const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    const dir = /failure diagnostics retained at ([^\r\n]+)/.exec(err)?.[1];
    check(`${scenario}: fails with an evidence directory`, code === (scenario === 'nonce' ? 2 : 1) && !!dir && existsSync(dir), code === (scenario === 'nonce' ? 2 : 1) && dir ? '' : out + err);
    if (!dir || !existsSync(dir)) continue;
    try {
      check(`${scenario}: server output survives cleanup`, readFileSync(join(dir, 'sequencer.log'), 'utf8').includes('sequencer on'));
      check(`${scenario}: relay incarnation stays in the scratch directory`, existsSync(join(dir, 'relay-incarnation')));
      if (scenario === 'nonce') {
        check('readiness refuses a different responder nonce', err.includes("another sequencer's nonce"));
      } else {
        const events = readFileSync(join(dir, 'browser.events.jsonl'), 'utf8');
        check('browser process output is retained', existsSync(join(dir, 'browser.stderr.log')) && existsSync(join(dir, 'browser.log')));
        check('browser console, runtime and evaluate errors survive', ['retained-console-sentinel','retained-runtime-sentinel','retained-eval-sentinel'].every(s => events.includes(s)));
        check('evaluate exceptions are thrown to the caller', out.includes('✓') && out.includes('evalJson surfaces exceptionDetails'));
      }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
} finally { rmSync(scratch, { recursive: true, force: true }); }
console.log(`${tally.passed} passed, ${tally.failed} failed`);
process.exit(tally.failed ? 1 : 0);
