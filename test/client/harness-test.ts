// Failure paths retain owned server/browser evidence, not just startup errors.
// bun test/client/harness-test.ts
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scratchBench, scratchSequencer, mkCheck, ROOT } from '../harness/harness.ts';
import { until, tryUntil } from '../gate/wait.ts';
import { spawnSync } from 'node:child_process';
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
if (mode === 'sighup') {   // an owned world, then wait: the parent hangs up on us
  const { ownedWorld } = await import('../harness/probe-harness.mjs');
  const w = await ownedWorld(); console.log(`ORIGIN ${w.origin}`); await new Promise(() => {});
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
const { check, na, tally } = mkCheck();
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
{ // contact-mutation-preload reads a CRLF checkout (autocrlf) as LF: an anchor written with \n still applies (#333 backlog G4-111)
  const dir = mkdtempSync(join(tmpdir(), 'ew-cm-crlf-'));
  try {
    writeFileSync(join(dir, 'crlf-target.js'), 'const a = 1;\r\nconst b = 2;\r\nconsole.log("sum", a + b);\r\n');
    writeFileSync(join(dir, 'entry.js'), "import './crlf-target.js';\n");
    const m = { file: 'crlf-target.js', from: 'const a = 1;\nconst b = 2;', to: 'const a = 10;\nconst b = 20;' };
    const p = Bun.spawn([process.execPath, '--preload', join(import.meta.dir, '../harness/contact-mutation-preload.ts'), join(dir, 'entry.js')],
      { cwd: ROOT, env: { ...process.env, CONTACT_MUTATION: JSON.stringify(m) }, stdout: 'pipe', stderr: 'pipe' });
    const [o, e, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    check('contact-mutation-preload: an LF anchor applies to a CRLF file', code === 0 && e.includes('CONTACT_MUTATION_APPLIED') && o.includes('sum 30'), (o + e).slice(-300));
  } finally { try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } }
}
if (process.platform === 'win32') na('probe-harness: a hangup (SIGHUP) kills the owned world and exits 129', 'win32: a SIGHUP comes from closing the console window, not from another process');
else { // a closed terminal (SIGHUP) takes a probe's owned world with it, as Ctrl-C does (#333 backlog G2-087)
  const p = Bun.spawn([process.execPath, import.meta.path, 'sighup'], { cwd: ROOT, stdout: 'pipe', stderr: 'pipe' });
  let out = ''; void (async () => { for await (const c of p.stdout) out += new TextDecoder().decode(c); })();
  const origin = await until('the owned world is up', () => /ORIGIN (\S+)/.exec(out)?.[1], { ms: 90_000 }).catch(() => null);
  const kids = spawnSync('pgrep', ['-P', String(p.pid)], { encoding: 'utf8' }).stdout.split('\n').filter(Boolean).map(Number);
  p.kill('SIGHUP'); const code = await p.exited;
  const gone = !!origin && !!(await tryUntil('the owned world is gone', () => fetch(`${origin}/version`, { signal: AbortSignal.timeout(500) }).then(() => false, () => true), { ms: 5000 }));
  for (const k of kids) try { process.kill(k, 'SIGKILL'); } catch { /* gone, as it should be */ }
  check('probe-harness: a hangup (SIGHUP) kills the owned world and exits 129', gone && code === 129, JSON.stringify({ origin, code, gone, kids }));
}
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
{ // playwright's slice the ungated probes stalled on (#333 backlog G6-003/004/005, G4-108/110): each row names the probe
  const { launchCdp } = await import('../harness/cdp-pw.mjs');
  const PAGE = '<link rel="icon" href="data:,"><input id="in"><div id="box"><button id="b" onclick="this.dataset.n=(+(this.dataset.n||0))+1">b</button></div>';
  const srv = Bun.serve({ port: 0, fetch: (r) => { const u = new URL(r.url); return new Response(u.pathname === '/' ? PAGE : 'server', { headers: { 'content-type': u.pathname === '/' ? 'text/html' : 'text/plain' } }); } });
  const b = await launchCdp(), at = `http://127.0.0.1:${srv.port}/`, msgs: string[] = [];
  const row = async (name: string, f: () => Promise<[boolean, unknown]>) => { try { const [ok, d] = await f(); check(name, ok, JSON.stringify(d)); } catch (e) { check(name, false, String(e)); } };
  try {
    const ctx = await b.newContext();
    await row('cdp-pw: a context\'s route() applies to the pages it opens (logo-probe)', async () => {
      await ctx.route('**/r.txt', (r: any) => r.fulfill({ body: 'ctx-routed' }));
      const p = await ctx.newPage(); await p.goto(at); const got = await p.evaluate(() => fetch('/r.txt').then((r) => r.text()));
      return [got === 'ctx-routed', { got }]; });
    await row('cdp-pw: a context\'s unroute(pattern) leaves a page\'s own route for that pattern, as playwright (cold review C2 nit)', async () => {
      await ctx.route('**/u.txt', (r: any) => r.fulfill({ body: 'ctx' }));
      const p = await ctx.newPage(); await p.goto(at); await p.route('**/u.txt', (r: any) => r.fulfill({ body: 'page' }));
      const fetchU = () => p.evaluate(() => fetch('/u.txt').then((r) => r.text()));
      const before = await fetchU(); await ctx.unroute('**/u.txt'); const after = await fetchU();
      return [before === 'ctx' && after === 'page', { before, after }]; });
    const pg = await b.page(); await pg.goto(at);
    pg.on('console', (m: any) => msgs.push(m.text()));
    await row('cdp-pw: console text renders an object, an array, null and undefined as playwright does (boot-check\'s body mark)', async () => {
      await pg.evaluate(() => { console.log('[boot] ready in', 12, { body: 3, why: 'ok' }, [1, 'a'], null, undefined); });
      await until('the console line arrives', () => msgs.some((t) => t.startsWith('[boot]')), { ms: 10_000 });
      const t = msgs.find((x) => x.startsWith('[boot]')); return [t === "[boot] ready in 12 {body: 3, why: ok} [1, a] null undefined", t]; });
    await row('cdp-pw: locator evaluate() hands the element and the arg (lite-banner-probe)', async () => {
      const v = await pg.locator('#in').evaluate((el: any, a: string) => el.id + a, '!'); return [v === 'in!', v]; });
    await row('cdp-pw: locator pressSequentially() types into the element (lite-banner-probe)', async () => {
      await pg.locator('#in').pressSequentially('abc'); const v = await pg.evaluate(() => (document.getElementById('in') as any).value); return [v === 'abc', v]; });
    await row('cdp-pw: click({timeout}) gives up at its timeout, not a fixed 30 s (picture-editor-probe)', async () => {
      const t0 = performance.now(); let threw = false; try { await pg.click('#absent', { timeout: 1000 }); } catch { threw = true; }
      const s = (performance.now() - t0) / 1000; return [threw && s < 15, { threw, s }]; });
    await row('cdp-pw: click waits until the target, not an overlay over it, takes the pointer (lite-banner-probe: the splash)', async () => {
      await pg.evaluate(() => { const o = document.createElement('div'); o.id = 'cover'; o.style.cssText = 'position:fixed;inset:0;background:#000'; document.body.append(o); setTimeout(() => o.remove(), 1000); });
      await pg.click('#b', { timeout: 10_000 }); const n = await pg.evaluate(() => (document.getElementById('b') as any).dataset.n ?? '0');
      await pg.evaluate(() => { delete (document.getElementById('b') as any).dataset.n; }); return [n === '1', n]; });
    await row('cdp-pw: fill and focus reach an input under an opacity:0 overlay at once; only pointer actions hit-check, as playwright (cold review C2-1)', async () => {
      await pg.evaluate(() => { const o = document.createElement('div'); o.id = 'glass'; o.style.cssText = 'position:fixed;inset:0;opacity:0'; document.body.append(o); });
      const t0 = performance.now(); let err = '';
      try { await pg.fill('#in', 'xyz'); await pg.evaluate(() => (document.activeElement as any)?.blur()); await pg.focus('#in'); } catch (e) { err = String(e); }
      const s = (performance.now() - t0) / 1000;
      const st = await pg.evaluate(() => { document.getElementById('glass')?.remove(); const i = document.getElementById('in') as any; const r = { v: i.value, focused: document.activeElement === i }; i.value = ''; i.blur(); return r; });
      return [!err && s < 5 && st.v === 'xyz' && st.focused, { err, s, ...st }]; });
    await row('cdp-pw: click({force:true}) skips the hit-target wait, as playwright (it lands on what is on top)', async () => {
      await pg.evaluate(() => { const o = document.createElement('div'); o.id = 'glass'; o.style.cssText = 'position:fixed;inset:0;opacity:0'; o.onclick = () => { o.dataset.hit = '1'; }; document.body.append(o); });
      const t0 = performance.now(); let err = ''; try { await pg.click('#b', { force: true, timeout: 3000 }); } catch (e) { err = String(e); }
      const s = (performance.now() - t0) / 1000; const hit = await pg.evaluate(() => { const o = document.getElementById('glass'); const h = o?.dataset.hit ?? '0'; o?.remove(); return h; });
      return [!err && s < 2 && hit === '1', { err, s, hit }]; });
    await row('cdp-pw: evaluateHandle(...).asElement() is an element handle: $, click, evaluate (library-badge-probe)', async () => {
      const box = (await pg.evaluateHandle(() => document.getElementById('box'))).asElement();
      const btn = await box?.$('#b'); await btn?.click(); await btn?.click();
      const n = await btn?.evaluate((e: any, k: string) => e.dataset[k], 'n');
      const none = (await pg.evaluateHandle(() => 7)).asElement();
      return [n === '2' && none === null && (await box.$('#nope')) === null, { n, none }]; });
  } finally { await b.close(); srv.stop(true); }
}
console.log(`${tally.passed} passed, ${tally.failed} failed${tally.nas ? `, ${tally.nas} not applicable` : ''}`);
process.exit(tally.failed ? 1 : 0);
