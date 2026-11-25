// Failure paths retain owned server/browser evidence, not just startup errors.
// bun test/client/harness-test.ts
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scratchBench, scratchSequencer, mkCheck, ROOT } from '../harness/harness.ts';
import { until, pause } from '../gate/wait.ts';
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
{ // cdp-pw hands requestfinished/requestfailed the request object 'request' saw (playwright's identity), so a probe's
  // pending set empties and a failure names its URL (xr-lifecycle-probe's tracking)
  const { launchCdp } = await import('../harness/cdp-pw.mjs');
  const dead = Bun.serve({ port: 0, fetch: () => new Response('') }); const deadPort = dead.port; dead.stop(true);
  const srv = Bun.serve({ port: 0, fetch: (r) => new URL(r.url).pathname === '/' ? new Response(`<link rel="icon" href="data:,"><img src="/a.png"><script src="http://127.0.0.1:${deadPort}/gone.js"></script>`, { headers: { 'content-type': 'text/html' } }) : new Response('x') });
  const b = await launchCdp(); const pending = new Set<any>(), failed: string[] = [], finished: string[] = [];
  try {
    const pg = await b.page();
    pg.on('request', (r: any) => pending.add(r)); pg.on('requestfinished', (r: any) => { if (pending.delete(r)) finished.push(r.url()); });
    pg.on('requestfailed', (r: any) => { pending.delete(r); failed.push(r.url()); });
    await pg.goto(`http://127.0.0.1:${srv.port}/`);
    await until('the page\'s requests settle', () => pending.size === 0 && failed.length > 0, { ms: 10_000 }).catch(() => {});
  } finally { await b.close(); srv.stop(true); }
  check('cdp-pw: a finished request is the one requested, and a failed one names its URL', pending.size === 0 && failed.some((u) => u.endsWith('/gone.js')) && finished.some((u) => u.endsWith('/a.png')), JSON.stringify({ pending: [...pending].map((r) => r.url()), failed, finished }));
}
{ // the rest of playwright's slice the probes call: a context's userAgent, unroute, and a waitForFunction whose poll never settles
  const { launchCdp } = await import('../harness/cdp-pw.mjs');
  let sawUA = '';
  const srv = Bun.serve({ port: 0, fetch: (r) => { const u = new URL(r.url); if (u.pathname === '/') sawUA = r.headers.get('user-agent') ?? ''; return new Response(u.pathname === '/r.txt' ? 'server' : '<link rel="icon" href="data:,">', { headers: { 'content-type': u.pathname === '/' ? 'text/html' : 'text/plain' } }); } });
  const b = await launchCdp(), UA = 'cdp-pw-ua-sentinel (Linux; Android 14) Mobile';
  const row = async (name: string, f: () => Promise<[boolean, unknown]>) => { try { const [ok, d] = await f(); check(name, ok, JSON.stringify(d)); } catch (e) { check(name, false, String(e)); } };
  try {
    const ctx = await b.newContext({ userAgent: UA }); const pg = await ctx.newPage();
    await pg.goto(`http://127.0.0.1:${srv.port}/`);
    await row('cdp-pw: newContext({userAgent}) is the page\'s navigator.userAgent and its requests\' header', async () => { const nav = await pg.evaluate(() => navigator.userAgent); return [nav === UA && sawUA === UA, { nav, sawUA }]; });
    const get = () => pg.evaluate(() => fetch('/r.txt').then((r) => r.text()));
    await row('cdp-pw: unroute stops a route, and the request reaches the server again', async () => {
      await pg.route('**/r.txt', (r: any) => r.fulfill({ body: 'routed' })); const a = await get();
      await pg.unroute('**/r.txt'); const z = await get(); return [a === 'routed' && z === 'server', { a, z }]; });
    await row('cdp-pw: waitForFunction ends at its timeout when the page\'s promise never settles', async () => {
      const t0 = performance.now(); let threw = false;
      try { await pg.waitForFunction(() => new Promise(() => {}), null, { timeout: 1500 }); } catch { threw = true; }
      const s = (performance.now() - t0) / 1000; return [threw && s < 15, { threw, s }]; });
  } finally { await b.close(); srv.stop(true); }
}
{ // cdp-pw's keys: macOS reads nativeVirtualKeyCode as a Mac key code, where the Windows VK codes cdp-pw has are other
  // keys, and Chrome there floods the page with keydowns of a key never released (#359's xr-confirm: one KeyW typed
  // "wwww…" into every later field, on macos-latest only). The params row holds on every host; the press row is the
  // flood itself, red only where Chrome floods (macOS) — mutation: send nativeVirtualKeyCode on darwin in nativeKey
  const { launchCdp, keyParams } = await import('../harness/cdp-pw.mjs');
  const W = { key: 'w', code: 'KeyW', vk: 87, text: 'w' };
  const mac = keyParams('keyDown', W, 0, 'darwin'), win = keyParams('keyDown', W, 0, 'win32');
  check('cdp-pw: a key sent on macOS carries no nativeVirtualKeyCode (a Windows VK there is another key), and on Windows its own VK',
    !('nativeVirtualKeyCode' in mac) && mac.windowsVirtualKeyCode === 87 && mac.code === 'KeyW' && win.nativeVirtualKeyCode === 87, JSON.stringify({ mac, win }));
  const b = await launchCdp(); let got: any = null;
  try {
    const pg = await b.page();
    await pg.evaluate(() => { document.body.innerHTML = '<input id="f">'; (globalThis as any).__downs = 0; addEventListener('keydown', () => { (globalThis as any).__downs++; }, true); document.getElementById('f')!.focus(); return true; });
    await pg.keyboard.press('KeyW');
    await pause('the row is that nothing more arrives: a flood is thousands of keydowns a second, so 750 ms after the keyup shows it', 750);
    got = await pg.evaluate(() => ({ value: (document.getElementById('f') as HTMLInputElement).value, downs: (globalThis as any).__downs }));
  } catch (e) { got = { threw: String(e) }; } finally { await b.close(); }
  check(`cdp-pw: one press of KeyW is one keydown and one "w" (${process.platform})`, got?.value === 'w' && got?.downs === 1, JSON.stringify(got));
}
console.log(`${tally.passed} passed, ${tally.failed} failed`);
process.exit(tally.failed ? 1 : 0);
