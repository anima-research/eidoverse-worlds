// tools/v4/commons-e2e-probe.mjs — a browser in a TRANSLATED copy of a real old world, on a server you started (the
// nov1 end-to-end: R 10-06 "no more v1"). It owns only its browser: the server is yours (E2E_ORIGIN, default
// http://127.0.0.1:9471) and the world is yours (E2E_WORLD, default commons). Run it as
//   perf-guard.sh -t 240 -- bun tools/v4/commons-e2e-probe.mjs
// with the world's sky deleted first (the headless-sky rule: no cloud bake in SwiftShader; it also sets
// ew-cloud-quality off). Stages, each printed green or red:
//   boot    the page boots into the world (its own ready line, the splash gone), joined, with a role
//   see     every placed thing in the authority's cut is realized as an entity (the translated world, drawn)
//   chat    the arrival chat window shows the world's old lines (chat came across the translation)
//   say     a line typed here goes through the authority and comes back as a chat line
//   live    a thing an agent creates through the authority while the page watches is realized; removed, it goes
//   errors  no page error and no console.error
import { launchBrowser } from '../probe-harness.mjs';
const ORIGIN = process.env.E2E_ORIGIN ?? 'http://127.0.0.1:9471', WORLD = process.env.E2E_WORLD ?? 'commons';
let failed = 0;
const stage = (n, v, d) => console.log(`${v ? 'ok  ' : 'FAIL'} ${n}${d !== undefined ? ` — ${JSON.stringify(d).slice(0, 400)}` : ''}`);
const check = (n, v, d) => { if (!v) failed++; stage(n, v, d); return v; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let br = null, ws = null;
try {
  br = await launchBrowser();
  const pg = await br.page();
  const logs = [], errors = [];
  pg.on('console', (m) => { logs.push(m.text()); if (m.type() === 'error') errors.push(m.text()); });
  pg.on('pageerror', (e) => errors.push(`pageerror ${e.message}`));
  pg.on('response', (r) => { if (r.status() >= 400) errors.push(`HTTP ${r.status()} ${r.url().replace(ORIGIN, '')}`); });
  pg.on('requestfailed', (r) => errors.push(`request failed ${r.url().replace(ORIGIN, '')}: ${r.failure()?.errorText}`));
  await pg.addInitScript(() => { try { localStorage.setItem('ew-cloud-quality', 'off'); } catch {} });   // the sky guard
  await pg.goto(`${ORIGIN}/?world=${WORLD}&name=Ann`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  const race = (p, ms = 20000) => Promise.race([p, new Promise((_, j) => setTimeout(() => j(new Error(`evaluate stalled ${ms} ms`)), ms))]);
  let ready = null; const t0 = Date.now();
  while (Date.now() - t0 < 120000) { ready = logs.find((l) => /^\[boot\] ready in \d+ms/.test(l)) ?? null;
    const gone = await race(pg.evaluate(() => { const sp = document.getElementById('splash'); return !sp || sp.classList.contains('gone'); })).catch(() => false);
    if (ready && gone) break; await sleep(250); }
  const net = await race(pg.evaluate(() => ({ joined: !!globalThis.EW?.net?.joined, you: globalThis.EW?.net?.myId, role: globalThis.EW?.net?.myRights?.role, v4: !!globalThis.EW?.net?.v4you })));
  if (!check('boot: the page boots into the translated world and joins it', !!ready && net.joined && !!net.role, { ready, net, errors: errors.slice(0, 3), tail: logs.slice(-6) })) throw new Error('boot gate failed');
  // see: every thing in this client's own fold of the cut is an entity on screen
  const want = (await (await fetch(`${ORIGIN}/geom?world=${WORLD}&boxes=0`)).json()).entities?.length ?? 0;   // the server's view of the authority's state
  const counts = async () => ({ view: want, drawn: await race(pg.evaluate(() => globalThis.EW?.entities?.size ?? 0)) });
  let c = await counts(); for (let i = 0; i < 80 && !(c.view > 0 && c.drawn >= c.view); i++) { await sleep(250); c = await counts(); }
  check('see: every placed thing in the translated world is realized', c.view > 50 && c.drawn >= c.view, c);
  // chat: the arrival window
  const lines = () => race(pg.evaluate(() => [...(document.querySelector('#chatlog')?.children ?? [])].map((d) => d.textContent ?? '')));
  const shown = await lines();
  check('chat: the arrival chat window shows the world\'s old lines', shown.length > 10, { shown: shown.length, last: shown.slice(-2) });
  // say
  const sr = await race(pg.evaluate(() => globalThis.EW.requestV4('say', { text: 'hello from the nov1 browser probe' })));
  let heard = false; for (let i = 0; i < 40 && !heard; i++) { heard = (await lines()).some((t) => t.includes('hello from the nov1 browser probe')); if (!heard) await sleep(200); }
  check('say: a line said through the authority comes back as a chat line on screen', sr?.ok && heard, { sr: sr?.ok ?? sr?.refused });
  // live: an agent-like socket creates and removes a thing through the authority
  ws = new WebSocket(ORIGIN.replace('http', 'ws') + '/ws'); const inbox = [];
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; }); ws.onmessage = (ev) => inbox.push(JSON.parse(String(ev.data)));
  ws.send(JSON.stringify({ type: 'join', world: WORLD, id: 'fable', avatar: '', v4fold: true }));
  for (let i = 0; i < 60 && !inbox.some((m) => m.type === 'snapshot' || m.type === 'error'); i++) await sleep(100);
  const req = (id, verb, args) => { ws.send(JSON.stringify({ type: 'request', id, verb, args })); };
  const LIVE = `nov1-live-${Date.now().toString(36)}`;   // the authority never reuses an id: a fresh one each run
  req('c1', 'create', { id: LIVE, model: 'eidoverse/assets/models/crate_large_red.glb', place: { at: [2, 2] } });
  for (let i = 0; i < 60 && !inbox.some((m) => m.type === 'reply' && m.id === 'c1'); i++) await sleep(100);
  const made = inbox.find((m) => m.type === 'reply' && m.id === 'c1');
  const has = () => race(pg.evaluate((id) => globalThis.EW?.entities?.has?.(id) ?? false, LIVE));
  let live = false; for (let i = 0; i < 60 && !live; i++) { live = await has(); if (!live) await sleep(250); }
  req('c2', 'delete', { id: LIVE });
  let gone = false; for (let i = 0; i < 60 && !gone; i++) { gone = !(await has()); if (!gone) await sleep(250); }
  check('live: a thing created through the authority while the page watches is realized, and goes when it is removed', made?.ok && live && gone, { made: made?.reply?.ok ?? made?.reply?.refused, live, gone });
  // a signed-out visitor's /whoami is a 401 by design (net.js asks whether a home-node session exists); Chrome logs the
  // status as a console error. Anything else counts.
  const real = errors.filter((e) => !/^HTTP 401 \/whoami$/.test(e) && !(/status of 401/.test(e) && errors.includes('HTTP 401 /whoami')));
  check('errors: no page error and no console.error (but the signed-out /whoami 401)', real.length === 0, real.slice(0, 5));
} catch (e) { failed++; console.log(`FAIL probe: ${e.message}`); }
finally { try { ws?.close(); } catch {} try { await br?.close(); } catch {} }
console.log(`[commons-e2e-probe] ${failed ? `${failed} failed` : 'all stages pass'}`);
process.exit(failed ? 1 : 0);
