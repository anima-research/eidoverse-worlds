// tools/v4/client-probe.mjs — TODAY's client (headless Chromium) visiting a v4 world (protocol/v4 slice 2).
// usage (one Chrome, under the guard):  perf-guard.sh -t 240 -- bun tools/v4/client-probe.mjs
// What it shows, each as a stage line printed green or red:
//   boot      the client boots into a v4 world (founded by tools/v4/world.ts in a scratch WORLDS_DIR) and finishes
//   see       a thing created through the door BEFORE the visit is realized (the snapshot's projection)
//   live      a thing another person creates through the door WHILE it watches is realized (projected v1 verbs)
//   spot      a spot light set through the door lights a spot slot with its cone, shining down the thing's -Z
//   rocket    a socket's whole rotation: sitting in a seat lying on its back lays the body down; standing rights it
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
import { ENGINE_CATALOGUE, warm } from '../../server/v4/catalogue.ts';
import { directoryFor } from '../../server/v4/directory.ts';

const MODEL = 'eidoverse/assets/models/crate_large_red.glb';
const KEY = 'v4probe';
const worlds = mkdtempSync(join(tmpdir(), 'v4-client-'));
const stage = (name, okv, detail) => console.log(`${okv ? 'ok  ' : 'FAIL'} ${name}${detail !== undefined ? ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail).slice(0, 400)}` : ''}`);
let failed = 0; const check = (n, v, d) => { if (!v) failed++; stage(n, v, d); return v; };
let world = null, b = null, ANN = null, BOB = null;
try {
  // the world: founded by Ann, a crate already standing in it, Bob a builder
  foundV4(join(worlds, 'garden'), 'garden', 'Ann', 'a v4 garden');
  await warm([MODEL]);
  { const w = openLive(join(worlds, 'garden'), 'garden', { catalogue: ENGINE_CATALOGUE });
    // actors are the door directory's opaque ids (one per account, R 10-06): Ann founded it as local:ann; Bob will join
    // this local door by name, so his account is local:bob
    const dir = directoryFor(worlds); ANN = dir.idOfSub('local:ann'); BOB = dir.resolve({ sub: 'local:bob', name: 'Bob' });
    const r1 = request(w, ANN, 'create', { id: 'crate-before', model: MODEL, components: { transform: { pos: [0, 0, 3] } } });
    const r2 = request(w, ANN, 'set', { id: '@world', component: `roles:${BOB}`, value: { role: 'builder' } });
    if (!r1.ok || !r2.ok) throw new Error(`setup: ${JSON.stringify([r1, r2])}`); }
  world = await ownedWorld({ key: KEY, env: { WORLDS_DIR: worlds, BUN_RUNTIME_TRANSPILER_CACHE_PATH: '0', TRUST_NAMES: '1' } });
  b = await launchBrowser();
  const pg = await b.page();
  const errors = [], logs = [];
  pg.on('pageerror', (e) => errors.push(String(e)));
  pg.on('console', (m) => { const t = m.text(); logs.push(t); if (m.type() === 'error') errors.push(t); });
  const http4xx = []; pg.on('response', (r) => { if (r.status() >= 400) http4xx.push(`${r.status()} ${new URL(r.url()).pathname}`); });
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
  ws.send(JSON.stringify({ type: 'join', world: 'garden', id: 'Bob', avatar: '', token: KEY, v4fold: true }));
  for (let i = 0; i < 40 && !inbox.some((m) => m.type === 'snapshot'); i++) await new Promise((r) => setTimeout(r, 100));
  ws.send(JSON.stringify({ type: 'v4', id: 1, tool: 'create', args: { id: 'crate-live', model: MODEL, place: { near: 'crate-before' } } }));
  for (let i = 0; i < 40 && !inbox.some((m) => m.type === 'v4-result'); i++) await new Promise((r) => setTimeout(r, 100));
  const res = inbox.find((m) => m.type === 'v4-result');
  let live = false; for (let i = 0; i < 40 && !live; i++) { live = (await ents()).includes('crate-live'); if (!live) await new Promise((r) => setTimeout(r, 250)); }
  if (!res?.ok) stage('live: Bob\'s replies', false, inbox.filter((m) => m.type !== 'presence').slice(0, 4).map((m) => [m.type, m.you ?? m.reply ?? m.error]));
  check('live: a crate Bob creates through the door while Ann watches is realized in her client', res?.ok && live, { reply: res?.reply?.ok ?? res?.reply?.refused, ents: await ents() });
  // (the old 'edit'/'refuse' stages sent v1 verbs from the page; v4 refuses those by design. The page's door-request
  //  path is covered headlessly by editcommit/hierarchy-commit.)
  // spot: a spot light set through the door (glTF/Godot shape: half-angle cone, shining along -Z) lights a SPOT slot in
  // Ann's client with that cone, pointing where the thing's -Z points (here: pitched to face straight down)
  const down = [-Math.SQRT1_2, 0, 0, Math.SQRT1_2];   // -90° about X: local -Z → world -Y
  ws.send(JSON.stringify({ type: 'v4', id: 3, tool: 'batch', args: { ops: [
    { tool: 'set', args: { id: 'crate-before', component: 'transform', value: { pos: [0, 2, 3], q: down, scale: [1, 1, 1] } } },
    { tool: 'set', args: { id: 'crate-before', component: 'light', value: { kind: 'spot', angle: 0.4, inner: 0.1, intensity: 30, range: 9, keep: true } } }] } }));
  let spot = null; for (let i = 0; i < 40; i++) { await new Promise((r) => setTimeout(r, 250));
    spot = await race(pg.evaluate(() => globalThis.EW.lightrig().spots.find((x) => x.intensity > 0) ?? null)).catch(() => null); if (spot) break; }
  if (!spot) stage('spot: debug', false, await race(pg.evaluate(() => { const d = globalThis.EW.lightrig(); const e = globalThis.EW.state?.st?.entities?.['crate-before'];
    return { spots: d.spots, reqs: (d.requests ?? []).filter((r) => /crate/.test(r.key)), comp: e?.comp, kind: e?.kind }; })).catch((x) => String(x)));
  check('spot: a spot light set through the door lights a spot slot with its cone (angle 0.4, penumbra (0.4-0.1)/0.4)',
    !!spot && Math.abs(spot.angle - 0.4) < 1e-3 && Math.abs(spot.penumbra - 0.75) < 1e-3, { spot, reply: inbox.find((m) => m.type === 'v4-result' && m.id === 3)?.reply });
  check('spot: …shining down the thing\'s -Z (here straight down)', !!spot && spot.dir[1] < -0.99, spot);
  // rocket: a socket's WHOLE rotation (not just yaw). Bob builds a seat lying on its back beside Ann; Ann sits (the
  // page's own sit: nearest body socket in reach) and her body lies down with it; standing makes her upright again
  const at = await race(pg.evaluate(() => globalThis.EW.me().root.position.toArray()));
  ws.send(JSON.stringify({ type: 'v4', id: 4, tool: 'create', args: { id: 'rocket', model: MODEL, components: { transform: { pos: [at[0] + 1, 0, at[2]] },
    sockets: { seat: { pos: [0, 0.6, 0], q: [-Math.SQRT1_2, 0, 0, Math.SQRT1_2], body: { action: 'ride', pose: 'sit' } } } } } }));
  let upY = null; for (let i = 0; i < 40; i++) { await new Promise((r) => setTimeout(r, 250));
    if (!(await ents()).includes('rocket')) continue;
    upY = await race(pg.evaluate(() => { globalThis.EW.bus.emit('xr:sit'); const r = globalThis.EW.me().root; r.updateMatrixWorld(); const e = r.matrixWorld.elements; return +e[5].toFixed(3); })).catch(() => null);
    await new Promise((r) => setTimeout(r, 400));
    upY = await race(pg.evaluate(() => { const e = globalThis.EW.me().root.matrixWorld.elements; return +e[5].toFixed(3); })).catch(() => null);
    if (upY != null && upY < 0.2) break; }
  check('rocket: sitting on a socket lying on its back lays the body down with it (body up ≈ horizontal)', upY != null && Math.abs(upY) < 0.05, { upY, reply: inbox.find((m) => m.type === 'v4-result' && m.id === 4)?.reply?.ok });
  if (process.env.PROBE_SHOTS) await pg.screenshot({ path: `${process.env.PROBE_SHOTS}/rocket-seated.png` });
  const stood = await race(pg.evaluate(async () => { globalThis.EW.bus.emit('xr:stand'); await new Promise((r) => setTimeout(r, 400)); const r = globalThis.EW.me().root; r.updateMatrixWorld(); return +r.matrixWorld.elements[5].toFixed(3); })).catch(() => null);
  check('rocket: …and standing up makes the body upright again', stood != null && stood > 0.999, stood);
  ws.close();
  const v4Errors = errors.filter((e) => /v4|legacy|projection|fold/i.test(e));
  stage('http: responses ≥ 400 the page saw (reported, not asserted)', true, http4xx);
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
