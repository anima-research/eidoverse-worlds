// tools/v4/client-probe.mjs — TODAY's client (headless Chromium) visiting a v4 world (protocol/v4 slice 2).
// usage (one Chrome, under the guard):  perf-guard.sh -t 240 -- bun tools/v4/client-probe.mjs
// What it shows, each as a stage line printed green or red:
//   boot      the client boots into a v4 world (founded by tools/v4/world.ts in a scratch WORLDS_DIR) and finishes
//   see       a thing created through the door BEFORE the visit is realized (the snapshot's projection)
//   live      a thing another person creates through the door WHILE it watches is realized (projected v1 verbs)
//   edit      the old UI's write path (a v1 `comp` verb from the page) becomes a door act in the v4 log
//   refuse    a refused old-UI write reaches the page as an error (it toasts it; verb-refused)
//   errors    no page error and no console.error from the v4 path
// The owned server runs with SKIP_OPT_SWEEP=1 and a scratch WORLDS_DIR; the world has no sky (the headless-sky
// rule: no cloud bake in SwiftShader). Teardown (browser, server, scratch) is in finally.
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { launchBrowser, ownedWorld } from '../probe-harness.mjs';
import { foundV4 } from '../../server/v4/world.ts';
import { openLive } from '../../server/v4/live.ts';
import { request } from '../../shared/v4/door.js';
import { readLog } from '../../shared/v4/fold.js';
import { enc } from '../../shared/v4/names.js';

const MODEL = 'eidoverse/assets/models/crate_large_red.glb';
const KEY = 'v4probe';
const worlds = mkdtempSync(join(tmpdir(), 'v4-client-'));
const stage = (name, okv, detail) => console.log(`${okv ? 'ok  ' : 'FAIL'} ${name}${detail !== undefined ? ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail).slice(0, 400)}` : ''}`);
let failed = 0; const check = (n, v, d) => { if (!v) failed++; stage(n, v, d); return v; };
let world = null, b = null;
try {
  // the world: founded by Ann, a crate already standing in it, Bob a builder
  foundV4(join(worlds, 'garden'), 'garden', 'Ann', 'a v4 garden');
  { const w = openLive(join(worlds, 'garden'), 'garden');
    const r1 = request(w, enc('Ann'), 'create', { id: 'crate-before', model: MODEL, components: { transform: { pos: [0, 0, 3] } } });
    const r2 = request(w, enc('Ann'), 'set', { id: '@world', component: `roles:${enc('Bob')}`, value: { role: 'builder' } });
    if (!r1.ok || !r2.ok) throw new Error(`setup: ${JSON.stringify([r1, r2])}`); }
  world = await ownedWorld({ key: KEY, env: { WORLDS_DIR: worlds, BUN_RUNTIME_TRANSPILER_CACHE_PATH: '0' } });
  b = await launchBrowser();
  const pg = await b.page();
  const errors = [], logs = [];
  pg.on('pageerror', (e) => errors.push(String(e)));
  pg.on('console', (m) => { const t = m.text(); logs.push(t); if (m.type() === 'error') errors.push(t); });
  await pg.goto(`${world.origin}/?world=garden&name=Ann&key=${KEY}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  const race = (p, ms = 8000) => Promise.race([p, new Promise((_, j) => setTimeout(() => j(new Error(`evaluate stalled ${ms} ms`)), ms))]);
  const ents = () => race(pg.evaluate(() => [...(globalThis.EW?.entities?.keys?.() ?? [])]));
  // boot: the client's own ready line, and the splash gone
  let ready = null; const t0 = Date.now();
  while (Date.now() - t0 < 40000) { ready = logs.find((l) => /^\[boot\] ready in \d+ms/.test(l)) ?? null;
    const gone = await race(pg.evaluate(() => { const sp = document.getElementById('splash'); return !sp || sp.classList.contains('gone'); })).catch(() => false);
    if (ready && gone) break; await new Promise((r) => setTimeout(r, 250)); }
  const net = await race(pg.evaluate(() => ({ joined: !!globalThis.EW?.net?.joined, you: globalThis.EW?.net?.myId, role: globalThis.EW?.net?.myRights?.role })));
  if (!check('boot: the client finishes booting into the v4 world, as its owner', !!ready && net.joined && net.role === 'owner', { ready, net, errors: errors.slice(0, 3), tail: logs.slice(-5) })) throw new Error('boot gate failed');
  // see
  let seen = false; for (let i = 0; i < 40 && !seen; i++) { seen = (await ents()).includes('crate-before'); if (!seen) await new Promise((r) => setTimeout(r, 250)); }
  check('see: the crate created through the door before the visit is realized', seen, await ents());
  // live: Bob, through the door, over his own socket
  const ws = new WebSocket(world.origin.replace('http', 'ws') + '/ws');
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  const inbox = []; ws.onmessage = (ev) => inbox.push(JSON.parse(String(ev.data)));
  ws.send(JSON.stringify({ type: 'join', world: 'garden', id: 'Bob', avatar: '', token: KEY }));
  for (let i = 0; i < 40 && !inbox.some((m) => m.type === 'snapshot'); i++) await new Promise((r) => setTimeout(r, 100));
  ws.send(JSON.stringify({ type: 'v4', id: 1, tool: 'create', args: { id: 'crate-live', model: MODEL, place: { near: 'crate-before' } } }));
  for (let i = 0; i < 40 && !inbox.some((m) => m.type === 'v4-result'); i++) await new Promise((r) => setTimeout(r, 100));
  const res = inbox.find((m) => m.type === 'v4-result');
  let live = false; for (let i = 0; i < 40 && !live; i++) { live = (await ents()).includes('crate-live'); if (!live) await new Promise((r) => setTimeout(r, 250)); }
  check('live: a crate Bob creates through the door while Ann watches is realized in her client', res?.ok && live, { reply: res?.reply?.ok ?? res?.reply?.refused, ents: await ents() });
  // edit: the old UI's write path, from the page (the same send the Inspector's comp edits use)
  await race(pg.evaluate(() => globalThis.EW.net.ws.send(JSON.stringify({ type: 'verb', verb: 'comp', args: { id: 'crate-live', type: 'label', data: 'labelled from the old UI' } }))));
  let acted = null; for (let i = 0; i < 30 && !acted; i++) { await new Promise((r) => setTimeout(r, 200));
    acted = readLog(readFileSync(join(worlds, 'garden', 'v4.jsonl'))).find((e) => e.kind === 'act' && e.actor === enc('Ann') && e.body?.request?.component === 'label') ?? null; }
  check('edit: the page\'s v1 `comp` verb became a door act in the v4 log (stamped Ann)', !!acted, acted);
  // refuse: Ann pins it, Bob (over the page? no: Ann herself is owner) — the page tries to remove a pinned thing
  ws.send(JSON.stringify({ type: 'v4', id: 2, tool: 'set', args: { id: 'crate-live', component: 'pinned', value: true } }));
  await new Promise((r) => setTimeout(r, 300));
  const refusals = await race(pg.evaluate(() => new Promise((res) => { const got = []; globalThis.EW.bus.on?.('verb-refused', (e) => got.push(e));
    globalThis.EW.net.ws.send(JSON.stringify({ type: 'verb', verb: 'remove', args: { id: 'crate-live' } })); setTimeout(() => res(got), 1500); })), 5000);
  check('refuse: removing a pinned thing from the page is refused, and the page hears why (verb-refused)', refusals.length === 1 && /pinned/.test(refusals[0]?.error), refusals);
  check('refuse: …and the crate is still there', (await ents()).includes('crate-live'));
  ws.close();
  const v4Errors = errors.filter((e) => /v4|legacy|projection|fold/i.test(e));
  check('errors: no page error, and no console.error mentioning the v4 path', !errors.some((e) => /pageerror|TypeError|ReferenceError/.test(e)) && !v4Errors.length, errors.slice(0, 6));
} catch (e) {
  failed++; stage('probe', false, String(e?.stack ?? e).slice(0, 600));
} finally {
  try { await b?.close(); } catch {}
  try { await world?.close(); } catch {}
  rmSync(worlds, { recursive: true, force: true });
}
console.log(failed ? `client-probe: ${failed} failed` : 'client-probe: today\'s client boots into a v4 world, sees it, edits it through the door, and hears refusals');
process.exit(failed ? 1 : 0);
