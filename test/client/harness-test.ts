// Failure paths retain owned server/browser evidence, not just startup errors.
// bun test/client/harness-test.ts
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scratchBench, scratchSequencer, mkCheck, ROOT } from '../harness/harness.ts';
import { until, tryUntil, pause } from '../gate/wait.ts';
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
    // `to` carries $& and $': a string replacement would splice in the matched and trailing source there (review #375 23)
    const m = { file: 'crlf-target.js', from: 'const a = 1;\nconst b = 2;', to: "const a = 10;\nconst b = 20; console.log('lit $& $\\'');" };
    const p = Bun.spawn([process.execPath, '--preload', join(import.meta.dir, '../harness/contact-mutation-preload.ts'), join(dir, 'entry.js')],
      { cwd: ROOT, env: { ...process.env, CONTACT_MUTATION: JSON.stringify(m) }, stdout: 'pipe', stderr: 'pipe' });
    const [o, e, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    check('contact-mutation-preload: an LF anchor applies to a CRLF file, its replacement taken literally ($& and $\' stay as written)', code === 0 && e.includes('CONTACT_MUTATION_APPLIED') && o.includes('sum 30') && o.includes("lit $& $'"), (o + e).slice(-300));
  } finally { try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } }
}
if (process.platform === 'win32') na('probe-harness: a hangup (SIGHUP) kills the owned world and exits 129', 'win32: a SIGHUP comes from closing the console window, not from another process');
else { // a closed terminal (SIGHUP) takes a probe's owned world with it, as Ctrl-C does (#333 backlog G2-087)
  const p = Bun.spawn([process.execPath, import.meta.path, 'sighup'], { cwd: ROOT, stdout: 'pipe', stderr: 'pipe' });
  let out = ''; void (async () => { for await (const c of p.stdout) out += new TextDecoder().decode(c); })();
  const origin = await until('the owned world is up', () => /ORIGIN (\S+)/.exec(out)?.[1], { ms: 90_000 }).catch(() => null);
  const kids = spawnSync('pgrep', ['-P', String(p.pid)], { encoding: 'utf8' }).stdout.split('\n').filter(Boolean).map(Number);
  p.kill('SIGHUP'); const code = await p.exited;
  // gone means its process is gone, not that a fetch failed: a server too busy to answer in time is still alive (review #375 22)
  const alive = (k: number) => { try { process.kill(k, 0); return true; } catch { return false; } };
  const gone = !!origin && kids.length > 0 && !!(await tryUntil('the owned world\'s process is gone', () => kids.every((k) => !alive(k)), { ms: 5000 }));
  const left = kids.filter(alive);
  for (const k of left) try { process.kill(k, 'SIGKILL'); } catch { /* gone, as it should be */ }
  check('probe-harness: a hangup (SIGHUP) kills the owned world and exits 129', gone && code === 129, JSON.stringify({ origin, code, gone, kids, left }));
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
    await row('cdp-pw: a page\'s own route answers before its context\'s, and the latest route first; a context\'s unroute leaves the page\'s, as playwright (review #375 4; cold review C2 nit)', async () => {
      await ctx.route('**/u.txt', (r: any) => r.fulfill({ body: 'ctx' }));
      const p = await ctx.newPage(); await p.goto(at);
      const fetchU = () => p.evaluate(() => fetch('/u.txt').then((r) => r.text()));
      const ctxOnly = await fetchU();
      await p.route('**/u.txt', (r: any) => r.fulfill({ body: 'page' })); const pageFirst = await fetchU();
      await p.route('**/u.txt', (r: any) => r.fulfill({ body: 'page-later' })); const latest = await fetchU();
      await ctx.unroute('**/u.txt'); const after = await fetchU(); await p.close();
      return [ctxOnly === 'ctx' && pageFirst === 'page' && latest === 'page-later' && after === 'page-later', { ctxOnly, pageFirst, latest, after }]; });
    await row('cdp-pw: a context\'s route() added after a page opened applies to that page too (review #375 24)', async () => {
      // a context with no route yet: its page opened with nothing to intercept, so the route must reach it after the fact
      const c3 = await b.newContext(); const p = await c3.newPage(); await p.goto(at);
      await c3.route('**/late.txt', (r: any) => r.fulfill({ body: 'ctx-late' }));
      const got = await p.evaluate(() => fetch('/late.txt').then((r) => r.text())); await c3.close();
      return [got === 'ctx-late', { got }]; });
    await row('cdp-pw: a context\'s route() still reaches its open pages after one of them closed (review #375 13)', async () => {
      const c2 = await b.newContext(); const p1 = await c2.newPage(), p2 = await c2.newPage(); await p2.goto(at); await p1.close();
      let err = ''; try { await c2.route('**/c.txt', (r: any) => r.fulfill({ body: 'ctx2' })); } catch (e) { err = String(e); }
      const got = await p2.evaluate(() => fetch('/c.txt').then((r) => r.text())); await c2.close();
      return [!err && got === 'ctx2', { err, got }]; });
    const pg = await b.page(); await pg.goto(at);
    pg.on('console', (m: any) => msgs.push(m.text()));
    // #b counts its clicks: each row that reads the count starts it from zero, so a row that threw can't leave one behind (review #375 21)
    const resetB = () => pg.evaluate(() => { delete (document.getElementById('b') as any).dataset.n; });
    const countB = () => pg.evaluate(() => (document.getElementById('b') as any).dataset.n ?? '0');
    // an overlay over the whole page that counts the clicks it takes; only the row removes it (never a timer)
    const cover = (id: string, css = 'position:fixed;inset:0;background:#000') => pg.evaluate(([i, c]) => { const o = document.createElement('div'); o.id = i; o.style.cssText = c; o.onclick = () => { o.dataset.hit = String(+(o.dataset.hit ?? 0) + 1); }; document.body.append(o); }, [id, css]);
    const uncover = (id: string) => pg.evaluate((i) => { const o = document.getElementById(i); const h = o?.dataset.hit ?? '0'; o?.remove(); return h; }, id);
    // a pointer action that waits for the target: still pending with the overlay up (it had time to land, and didn't), done
    // on the target once the row removes it. One that never checks lands on the overlay instead (review #375 18, 3)
    const waitsOutCover = async (act: () => Promise<unknown>) => {
      await resetB(); await cover('cover'); let settled = false, err = '';
      const p = act().then(() => { settled = true; }, (e) => { settled = true; err = String(e); });
      await pause('a click that ignores the overlay has this long to land on it', 600);
      const pendingWhileCovered = !settled, overlayHits = await uncover('cover'); await p;
      return { pendingWhileCovered, overlayHits, n: await countB(), err };
    };
    await row('cdp-pw: console text renders an object, an array, null and undefined as playwright does (boot-check\'s body mark)', async () => {
      await pg.evaluate(() => { console.log('[boot] ready in', 12, { body: 3, why: 'ok' }, [1, 'a'], null, undefined); });
      await until('the console line arrives', () => msgs.some((t) => t.startsWith('[boot]')), { ms: 10_000 });
      const t = msgs.find((x) => x.startsWith('[boot]')); return [t === "[boot] ready in 12 {body: 3, why: ok} [1, a] null undefined", t]; });
    await row('cdp-pw: locator evaluate() hands the element and the arg (lite-banner-probe)', async () => {
      const v = await pg.locator('#in').evaluate((el: any, a: string) => el.id + a, '!'); return [v === 'in!', v]; });
    await row('cdp-pw: locator pressSequentially() types into the element (lite-banner-probe)', async () => {
      await pg.locator('#in').pressSequentially('abc'); const v = await pg.evaluate(() => (document.getElementById('in') as any).value); return [v === 'abc', v]; });
    await row('cdp-pw: click({timeout}) waits out its timeout and then gives up, not a fixed 30 s and not at once (picture-editor-probe; review #375 20)', async () => {
      const t0 = performance.now(); let threw = false; try { await pg.click('#absent', { timeout: 1000 }); } catch { threw = true; }
      const s = (performance.now() - t0) / 1000; return [threw && s >= 0.95 && s < 15, { threw, s }]; });
    await row('cdp-pw: click waits until the target, not an overlay over it, takes the pointer (lite-banner-probe: the splash; review #375 18)', async () => {
      const r = await waitsOutCover(() => pg.click('#b', { timeout: 30_000 })); return [r.pendingWhileCovered && r.overlayHits === '0' && r.n === '1' && !r.err, r]; });
    await row('cdp-pw: an element handle\'s click waits for the pointer the same way (library-badge-probe; review #375 3)', async () => {
      const h = (await pg.evaluateHandle(() => document.getElementById('b'))).asElement();
      const r = await waitsOutCover(() => h.click({ timeout: 30_000 })); return [r.pendingWhileCovered && r.overlayHits === '0' && r.n === '1' && !r.err, r]; });
    await row('cdp-pw: click({timeout: 0}) waits with no deadline, as playwright (review #375 9)', async () => {
      const r = await waitsOutCover(() => pg.click('#b', { timeout: 0 })); return [r.pendingWhileCovered && r.overlayHits === '0' && r.n === '1' && !r.err, r]; });
    await row('cdp-pw: waitForFunction({timeout: 0}) waits with no deadline too (review #375 9)', async () => {
      let settled = false, err = ''; const p = pg.waitForFunction(() => (window as any).__go === 1, null, { timeout: 0 }).then(() => { settled = true; }, (e) => { settled = true; err = String(e); });
      await pause('a wait that took 0 as a deadline has this long to give up', 600); const pending = !settled;
      await pg.evaluate(() => { (window as any).__go = 1; }); await p; return [pending && !err, { pending, err }]; });
    await row('cdp-pw: click aims at the visible part of a fixed element taller than the window (review #375 6)', async () => {
      await pg.evaluate(() => { const t = document.createElement('div'); t.id = 'tall'; t.style.cssText = 'position:fixed;left:0;top:0;width:120px;height:4000px;background:#08f'; t.onclick = () => { t.dataset.n = '1'; }; document.body.append(t); });
      let err = ''; try { await pg.click('#tall', { timeout: 3000 }); } catch (e) { err = String(e); }
      const n = await pg.evaluate(() => { const t = document.getElementById('tall'); const v = t?.dataset.n ?? '0'; t?.remove(); return v; }); return [!err && n === '1', { err, n }]; });
    await row('cdp-pw: the point the hit check passed is the point clicked: nothing runs between them (review #375 8)', async () => {
      // stand-in for a layout that changes between the check and a second read: #b's second scrollIntoView puts an overlay up
      await resetB();
      await pg.evaluate(() => { const b = document.getElementById('b') as any; let calls = 0; b.scrollIntoView = function () { if (++calls === 2) { const o = document.createElement('div'); o.id = 'late'; o.style.cssText = 'position:fixed;inset:0'; document.body.append(o); } }; });
      let err = ''; try { await pg.click('#b', { timeout: 3000 }); } catch (e) { err = String(e); }
      const late = await uncover('late'); await pg.evaluate(() => { delete (document.getElementById('b') as any).scrollIntoView; }); const n = await countB();
      return [!err && n === '1', { err, n, late }]; });
    await row('cdp-pw: fill and focus reach an input under an opacity:0 overlay at once; only pointer actions hit-check, as playwright (cold review C2-1)', async () => {
      await pg.evaluate(() => { const o = document.createElement('div'); o.id = 'glass'; o.style.cssText = 'position:fixed;inset:0;opacity:0'; document.body.append(o); });
      const t0 = performance.now(); let err = '';
      try { await pg.fill('#in', 'xyz'); await pg.evaluate(() => (document.activeElement as any)?.blur()); await pg.focus('#in'); } catch (e) { err = String(e); }
      const s = (performance.now() - t0) / 1000;   // reported, not judged: a fill that waited on the overlay throws at its 30 s (review #375 19)
      const st = await pg.evaluate(() => { document.getElementById('glass')?.remove(); const i = document.getElementById('in') as any; const r = { v: i.value, focused: document.activeElement === i }; i.value = ''; i.blur(); return r; });
      return [!err && st.v === 'xyz' && st.focused, { err, s, ...st }]; });
    await row('cdp-pw: click({force:true}) skips the hit-target wait, as playwright (it lands on what is on top)', async () => {
      await pg.evaluate(() => { const o = document.createElement('div'); o.id = 'glass'; o.style.cssText = 'position:fixed;inset:0;opacity:0'; o.onclick = () => { o.dataset.hit = '1'; }; document.body.append(o); });
      // the overlay stays up throughout: a click that waited on it throws at its timeout, so no clock is judged (review #375 19)
      let err = ''; try { await pg.click('#b', { force: true, timeout: 3000 }); } catch (e) { err = String(e); }
      const hit = await pg.evaluate(() => { const o = document.getElementById('glass'); const h = o?.dataset.hit ?? '0'; o?.remove(); return h; });
      return [!err && hit === '1', { err, hit }]; });
    await row('cdp-pw: evaluateHandle(...).asElement() is an element handle: $, click, evaluate (library-badge-probe)', async () => {
      await resetB(); const box = (await pg.evaluateHandle(() => document.getElementById('box'))).asElement();
      const btn = await box?.$('#b'); await btn?.click(); await btn?.click();
      const n = await btn?.evaluate((e: any, k: string) => e.dataset[k], 'n');
      const none = (await pg.evaluateHandle(() => 7)).asElement();
      return [n === '2' && none === null && (await box.$('#nope')) === null, { n, none }]; });
    await row('cdp-pw: evaluate and a handle\'s jsonValue keep -0, NaN, Infinity and a bigint (review #375 10)', async () => {
      const bare = { negZero: await pg.evaluate(() => -0), nan: await pg.evaluate(() => NaN), inf: await pg.evaluate(() => Infinity), big: await pg.evaluate(() => 2n ** 70n) };
      const viaHandle = { negZero: await (await pg.evaluateHandle(() => -0)).jsonValue(), big: await (await pg.evaluateHandle(() => 5n)).jsonValue() };
      const okv = Object.is(bare.negZero, -0) && Number.isNaN(bare.nan) && bare.inf === Infinity && bare.big === 2n ** 70n && Object.is(viaHandle.negZero, -0) && viaHandle.big === 5n;
      return [okv, { bare: Object.fromEntries(Object.entries(bare).map(([k, v]) => [k, Object.is(v, -0) ? '-0' : String(v)])), viaHandle: Object.fromEntries(Object.entries(viaHandle).map(([k, v]) => [k, Object.is(v, -0) ? '-0' : String(v)])) }]; });
  } finally { await b.close(); srv.stop(true); }
}
console.log(`${tally.passed} passed, ${tally.failed} failed${tally.nas ? `, ${tally.nas} not applicable` : ''}`);
process.exit(tally.failed ? 1 : 0);
