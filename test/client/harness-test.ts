// Failure paths retain owned server/browser evidence, not just startup errors.
// bun test/client/harness-test.ts
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scratchBench, scratchSequencer, mkCheck, ROOT } from '../harness/harness.ts';
import { until } from '../gate/wait.ts';
const mode = process.argv[2];
if (mode === 'assertion') {
  const { evalJson, cleanup, SCRATCH } = await scratchBench('harness-assertion', { portFrom: 9010 });
  const { check } = mkCheck();
  await evalJson(`console.warn('retained-console-sentinel'); setTimeout(() => { throw Error('retained-runtime-sentinel'); }, 0);`);
  await until('the runtime sentinel is recorded', () => { try { return readFileSync(join(SCRATCH, 'browser.events.jsonl'), 'utf8').includes('retained-runtime-sentinel'); } catch { return false; } }, { ms: 5000 });
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
if (mode === 'collision') {
  // another process takes our port between the probe and the child's bind (two suites on one runner): readiness must move to a fresh port
  let squatted = 0, squatter: any;
  const run = await scratchSequencer('harness-collision', { portFrom: 9010, prepare: (_s, port) => {
    squatted = port;
    squatter = Bun.serve({ port, hostname: '127.0.0.1', fetch: () => Response.json({ ok: true, nonce: 'squatter', pid: -1 }) });
  } });
  squatter?.stop(true);
  if (!squatted || run.PORT === squatted) { console.error(`stayed on the squatted port ${squatted}`); process.exit(1); }
  await run.cleanup(0);
  process.exit(0);
}
const { check, tally } = mkCheck();
const scratch = mkdtempSync(join(tmpdir(), 'ew-harness-test-'));
try {
  const preload = join(scratch, 'foreign.ts');
  writeFileSync(preload, `process.env.BENCH_NONCE = 'another-child';\n`);
  {
    const p = Bun.spawn([process.execPath, import.meta.path, 'collision'], { cwd: ROOT, stdout: 'pipe', stderr: 'pipe' });
    const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    check('a squatter on our port moves readiness to a fresh port', code === 0, code === 0 ? '' : out + err);
  }
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
    } finally { try { rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); } catch { /* best effort: a Windows browser may still hold a log (EBUSY) */ } }
  }
} finally { try { rmSync(scratch, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); } catch { /* best effort, as harness.ts */ } }
{ // cdp-pw (the probes' driver) gives a console message what playwright's does: type, text, location
  const { launchCdp } = await import('../harness/cdp-pw.mjs');
  const b = await launchCdp(); const msgs: any[] = [];
  try {
    const pg = await b.page();
    pg.on('console', (m: any) => { try { msgs.push({ type: m.type(), text: m.text(), url: m.location().url }); } catch (e) { msgs.push({ threw: String(e) }); } });
    await pg.evaluate(() => { console.error('cdp-pw-console-sentinel'); });
    await until('the console message arrives', () => msgs.length > 0, { ms: 10_000 }).catch(() => {});
  } finally { await b.close(); }
  check('cdp-pw: a console message has type(), text() and location()', msgs.some((m) => m.type === 'error' && m.text === 'cdp-pw-console-sentinel' && typeof m.url === 'string'), JSON.stringify(msgs));
}
console.log(`${tally.passed} passed, ${tally.failed} failed`);
process.exit(tally.failed ? 1 : 0);
