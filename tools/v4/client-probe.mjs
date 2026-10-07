// tools/v4/client-probe.mjs — TODAY's client (headless Chromium) visiting a v4 world (protocol/v4 slice 2).
// usage (one Chrome, under the guard):  perf-guard.sh -t 240 -- bun tools/v4/client-probe.mjs
// What it shows, each as a stage line printed green or red:
//   boot      the client boots into a v4 world (founded by tools/v4/world.ts in a scratch WORLDS_DIR) and finishes
//   see       a thing created through the door BEFORE the visit is realized (the snapshot's projection)
//   live      a thing another person creates through the door WHILE it watches is realized (projected v1 verbs)
//   spot      a spot light set through the door lights a spot slot with its cone, shining down the thing's -Z
//   rocket    a socket's whole rotation: sitting in a seat lying on its back lays the body down; standing rights it
//   throw     a thing Bob throws through the door FLIES on Ann's screen (its position changes frame to frame) and comes
//             to rest bit for bit where the door logs the rest (her client folds the launch with the door's engine)
//   carry     Ann picks a thing up (her page's own grab: the door tracks her body), it follows her hand as she walks,
//             and her throw flies and rests where the door says
//   punt      Ann punts a ball at her feet (the C key's act): it flies, and rests where the door logs it
//   remote    a thing Bob holds is drawn in Bob's hand on Ann's screen, and follows him when he moves
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
import { restsOf } from '../../shared/v4/simlayer.js';

const MODEL = 'eidoverse/assets/models/crate_large_red.glb';
const SMALL = 0.3;   // the crate at 0.3 scale (0.75 × 0.6 × 0.45 m): something to carry (its GLB is already loaded and compiled)
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
    const r3 = request(w, ANN, 'set', { id: '@world', component: 'sim', value: { engine: 'eidosim@0.5.0' } }); // the world runs physics
    if (!r1.ok || !r2.ok || !r3.ok) throw new Error(`setup: ${JSON.stringify([r1, r2, r3])}`); }
  world = await ownedWorld({ key: KEY, env: { WORLDS_DIR: worlds, BUN_RUNTIME_TRANSPILER_CACHE_PATH: '0', TRUST_NAMES: '1' } });
  b = await launchBrowser();
  const pg = await b.page();
  const errors = [], logs = [];
  pg.on('pageerror', (e) => errors.push(String(e)));
  pg.on('console', (m) => { const t = m.text(); logs.push(t); if (m.type() === 'error') errors.push(t); });
  const http4xx = []; pg.on('response', (r) => { if (r.status() >= 400) http4xx.push(`${r.status()} ${new URL(r.url()).pathname}`); });
  await pg.goto(`${world.origin}/?world=garden&name=Ann&key=${KEY}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  const race = (p, ms = 20000) => Promise.race([p, new Promise((_, j) => setTimeout(() => j(new Error(`evaluate stalled ${ms} ms`)), ms))]);
  const ents = () => race(pg.evaluate(() => [...(globalThis.EW?.entities?.keys?.() ?? [])]));
  // boot: the client's own ready line, and the splash gone
  let ready = null; const t0 = Date.now();
  while (Date.now() - t0 < 90000) { ready = logs.find((l) => /^\[boot\] ready in \d+ms/.test(l)) ?? null;
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
  stage('physics: frame cost of v4phys so far (reported)', true, await race(pg.evaluate(() => globalThis.EW.physics.body())).catch(() => null));
  // ---- physics (design 20 on the client) ----
  { let n = 1000; const bobReq = (tool, args) => new Promise((res) => { const id = ++n; const t = setTimeout(() => res({ ok: false, refused: { code: 'timeout' } }), 8000);
      const h = (ev) => { const m = JSON.parse(String(ev.data)); if (m.type === 'v4-result' && m.id === id) { clearTimeout(t); ws.removeEventListener('message', h); res(m.reply); } };
      ws.addEventListener('message', h); ws.send(JSON.stringify({ type: 'v4', id, tool, args })); });
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const LOGF = join(worlds, 'garden', 'v4.jsonl'); const rests = () => restsOf(readLog(readFileSync(LOGF)));
    const shots = process.env.PROBE_SHOTS;
    // record a thing's drawn world position (and the displayed engine body) every frame, for ms
    // A flight is sampled at exact display times: the page's own per-frame applier (v4phys frame) is run at the launch's
    // ts + k·33 ms and the drawn position read back after each. (A headless page on a loaded host draws under a frame a
    // second and its timers starve; sampling by the clock the applier is given is simworld's bench rule.) The launch's
    // ts is the door's, read from the log; the page samples once its own fold has the launch.
    const LAUNCH = (id) => { const L = readLog(readFileSync(LOGF)); for (let i = L.length - 1; i >= 0; i--) if (L[i]?.kind === 'sim' && L[i].verb === 'launch' && L[i].body?.id === id) return L[i].ts; return null; };
    let recOut = null;
    const record = (id) => { recOut = null; return true; };
    const sample = async (id) => { const ts = LAUNCH(id);
      recOut = await race(pg.evaluate(async ({ id, ts }) => { const EW = globalThis.EW; const t0 = performance.now();
        while (EW.physics.launched()[id] === undefined && performance.now() - t0 < 30000) await new Promise((r) => setTimeout(r, 100));
        const out = []; const V = EW.THREE.Vector3;
        for (let k = 0; k <= 150; k++) { EW.physics.frame(ts + k * 33); const o = EW.entities.get(id); if (!o) continue; const v = o.getWorldPosition(new V()); const b = EW.simShown()?.bodies?.[id];
          out.push([k * 33, +v.x.toFixed(4), +v.y.toFixed(4), +v.z.toFixed(4), b ? b.resting : null, b ? JSON.stringify(b.p) : null]); }
        return out; }, { id, ts }), 45000).catch((e) => [[0, 0, 0, 0, null, String(e)]]); return recOut; };
    const recd = async () => recOut ?? [];
    // distinct: drawn positions that differ frame to frame; apex: how far above where it came to rest it flew
    const flew = (rec) => { const ys = rec.map((r) => r[2]); const distinct = new Set(rec.map((r) => `${r[1]},${r[2]},${r[3]}`)).size; return { frames: rec.length, distinct, rise: +(Math.max(...ys) - ys[ys.length - 1]).toFixed(3) }; };
    // realized: the model is loaded and drawn (the map holds a null while a new GLB loads and compiles; slow headless)
    const realized = async (id, ms = 40000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await race(pg.evaluate((id) => !!globalThis.EW.entities.get(id), id)).catch(() => false)) return true; await sleep(300); } return false; };
    const worldPos = (id) => race(pg.evaluate((id) => { const o = globalThis.EW.entities.get(id); return o ? o.getWorldPosition(new globalThis.EW.THREE.Vector3()).toArray() : null; }, id));
    const restCheck = (name, rec, id) => { const r = rests().filter((x) => x.id === id).at(-1); const shown = [...rec].reverse().find((x) => x[4] === true)?.[5] ?? null;
      check(`${name}: …and it rests on her screen bit for bit where the door logs the rest`, !!r && shown === JSON.stringify(r.at), { shown, logged: r?.at }); return r; };
    const ann = await race(pg.evaluate(() => globalThis.EW.me().root.position.toArray().map((v) => +v.toFixed(3))));
    // pull the camera back (the wheel zooms out to 16 m) so a screenshot shows the play, not a close-up of Ann
    if (shots) await race(pg.evaluate(() => { globalThis.EW.renderer.domElement.dispatchEvent(new WheelEvent('wheel', { deltaY: 1200, bubbles: true, cancelable: true })); return true; })).catch(() => null);
    const fps = await race(pg.evaluate(() => new Promise((res) => { let n = 0; const t0 = performance.now(); const f = () => { n++; if (performance.now() - t0 < 3000) requestAnimationFrame(f); else res(+(n / ((performance.now() - t0) / 1000)).toFixed(1)); }; requestAnimationFrame(f); })), 15000).catch(() => null);
    stage('physics: the page\'s frame rate here (reported)', true, { fps, body: await race(pg.evaluate(() => globalThis.EW.physics.body())).catch(() => null) });
    // throw: Bob, beside Ann, throws a crate through the door
    const P = [ann[0] + 2.5, 0, ann[2]];
    const arrive = await bobReq('move', { to: P }); ws.send(JSON.stringify({ type: 'pose', pose: { p: P, yaw: 0 } }));
    const mk = await bobReq('create', { id: 'toy', model: MODEL, components: { physics: { kind: 'dynamic', who: 'visitor' } }, place: { at: [P[0], P[2] + 0.6] } });
    let seenToy = false; for (let i = 0; i < 40 && !seenToy; i++) { seenToy = (await ents()).includes('toy'); if (!seenToy) await sleep(250); }
    const g = await bobReq('grab', { id: 'toy' });
    await sleep(600);
    await record('toy', 7000);
    const th = await bobReq('throw', { id: 'toy', v: [0, 7, 2.5] });   // ~1.5 s in the air
    await sample('toy');   // at once: any later request (Ann's own body track included) lets the door log the rest
    const rec = await recd(); const fw = flew(rec);
    if (!th?.ok) stage('throw: Bob\'s replies', false, { arrive, mk: mk?.ok ?? mk?.refused, g: g?.ok ?? g?.refused, th: th?.refused });
    check('throw: a crate Bob throws through the door flies on Ann\'s screen (its position changes frame to frame, it rises)', th?.ok && fw.distinct >= 8 && fw.rise > 0.8, fw);
    await sleep(4000); await bobReq('wait', {}); await sleep(800);   // (sampling ran ahead of the clock: let the door's flight end)
    const r1 = restCheck('throw', rec, 'toy');
    const drawn = await worldPos('toy');
    check('throw: …and once the rest is logged it stands exactly there (the fold\'s word)', r1 && drawn && drawn.every((v, i) => Math.abs(v - r1.at[i]) < 1e-6), { drawn, logged: r1?.at });
    if (shots) await pg.screenshot({ path: `${shots}/phys-throw-rest.png` });
    // carry: Ann picks a crate up with her own page (the door tracks her body), walks, and it follows her hand
    const ann2 = await race(pg.evaluate(() => globalThis.EW.me().root.position.toArray().map((v) => +v.toFixed(3))));
    const mk2 = await bobReq('create', { id: 'toy2', model: MODEL, components: { transform: { scale: SMALL }, physics: { kind: 'dynamic', who: 'visitor' } }, place: { at: [ann2[0] + 0.7, ann2[2]] } });
    const seen2 = await realized('toy2');
    const from2 = await worldPos('toy2');
    const ag = await race(pg.evaluate(() => globalThis.EW.physics.grab('toy2')), 15000).catch((e) => ({ ok: false, refused: { reason: String(e) } }));
    await sleep(800);
    const hand = () => race(pg.evaluate(() => { const av = globalThis.EW.me(); const b = av?.vrm?.humanoid?.getRawBoneNode('rightHand'); const V = globalThis.EW.THREE.Vector3;
      return (b ? b.getWorldPosition(new V()) : av.root.getWorldPosition(new V())).toArray(); }));
    const centre = (id) => race(pg.evaluate((id) => { const o = globalThis.EW.entities.get(id); if (!o) return null; const bb = new globalThis.EW.THREE.Box3().setFromObject(o); return bb.getCenter(new globalThis.EW.THREE.Vector3()).toArray(); }, id));
    const d3 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
    if (!mk2?.ok || !seen2) stage('carry: Bob\'s create of the ball', false, { mk2: mk2?.refused ?? mk2?.ok, seen2 });
    const h0 = await hand(), c0 = await centre('toy2');
    check('carry: Ann\'s own grab goes through the door (her body arrives, then grab)', ag?.ok, mk2?.ok ? { ag, body: await race(pg.evaluate(() => globalThis.EW.physics.body())).catch(() => null), ann: await race(pg.evaluate(() => globalThis.EW.me().root.position.toArray())).catch(() => null) } : mk2);
    check('carry: …and the box is drawn in her hand', ag?.ok && c0 && from2 && d3(h0, c0) < 0.25 && d3(c0, from2) > 0.3, { hand: h0, centre: c0, logged: from2 });
    if (shots) await pg.screenshot({ path: `${shots}/phys-held.png` });
    // walk 2 m along +x the way the controller does (its own state moves the body)
    for (let i = 0; i < 4; i++) { await race(pg.evaluate(() => { globalThis.EW.myState.pos.x += 0.5; return true; }), 10000); await sleep(500); }
    await sleep(900);
    const h1 = await hand(), c1 = await centre('toy2');
    const insp = await bobReq('inspect', { id: 'toy2' });
    check('carry: …it follows her hand as she walks (2 m)', c1 && c0 && d3(h1, c1) < 0.25 && c1[0] - c0[0] > 1.6, { hand: h1, centre: c1, moved: +(c1[0] - c0[0]).toFixed(3) });
    check('carry: …and the door\'s own track carried it with her (inspect: heldAt moved too)', insp?.heldAt && insp.heldAt[0] - ann2[0] > 1.6, { heldBy: insp?.heldBy, heldAt: insp?.heldAt });
    await record('toy2', 7000);
    const at2 = await race(pg.evaluate(() => globalThis.EW.physics.throw()), 15000).catch((e) => ({ ok: false, refused: { reason: String(e) } }));
    if (at2?.ok) await sample('toy2');
    const rec2 = await recd(); const fw2 = flew(rec2);
    check('carry: her throw flies on her screen', at2?.ok && fw2.distinct >= 8 && fw2.rise > 0.2, { reply: at2?.ok ?? at2?.refused, ...fw2 });
    await sleep(4000); await bobReq('wait', {}); await sleep(800);   // (sampling ran ahead of the clock: let the door's flight end)
    restCheck('carry', rec2, 'toy2');
    // punt: Ann kicks a ball at her feet (the C key's act, /punt): it flies on her screen and rests where the door says
    const ann3 = await race(pg.evaluate(() => globalThis.EW.me().root.position.toArray().map((v) => +v.toFixed(3))));
    const mk4 = await bobReq('create', { id: 'toy4', model: MODEL, components: { transform: { scale: SMALL }, physics: { kind: 'dynamic', who: 'visitor' } }, place: { at: [ann3[0] + 0.6, ann3[2]] } });
    const seen4 = await realized('toy4');
    await record('toy4', 7000);
    const ap = await race(pg.evaluate(() => globalThis.EW.physics.punt('toy4 7')), 15000).catch((e) => ({ ok: false, refused: { reason: String(e) } }));
    if (ap?.ok) await sample('toy4');
    const rec4 = await recd(); const fw4 = flew(rec4);
    check('punt: Ann punts the box at her feet through the door, and it flies on her screen', ap?.ok && fw4.distinct >= 8 && fw4.rise > 0.2, { reply: ap?.ok ?? ap?.refused, mk4: mk4?.ok ?? mk4?.refused, seen4, ...fw4 });
    await sleep(4000); await bobReq('wait', {}); await sleep(800);   // (sampling ran ahead of the clock: let the door's flight end)
    restCheck('punt', rec4, 'toy4');
    // remote: Bob holds a crate; Ann sees it in Bob's hand, following him
    const mk3 = await bobReq('create', { id: 'toy3', model: MODEL, components: { transform: { scale: SMALL }, physics: { kind: 'dynamic', who: 'visitor' } }, place: { at: [P[0] + 0.6, P[2]] } });
    const seen3 = await realized('toy3');
    const g3 = await bobReq('grab', { id: 'toy3' });
    for (let i = 0; i < 30; i++) { await sleep(500); if (await race(pg.evaluate(() => !!globalThis.EW.physics.holds().toy3)).catch(() => false)) break; } await sleep(800);
    const bobRoot = () => race(pg.evaluate(() => { const av = globalThis.EW.remotes.get('Bob')?.avatar; const b = av?.vrm?.humanoid?.getRawBoneNode('rightHand') ?? av?.root;
      return b ? b.getWorldPosition(new globalThis.EW.THREE.Vector3()).toArray() : null; }));
    if (!mk3?.ok || !seen3) stage('remote: Bob\'s create of the ball', false, { mk3: mk3?.refused ?? mk3?.ok, seen3 });
    const b0 = await bobRoot(), t0 = await centre('toy3');
    const Q = [P[0], 0, P[2] + 2];
    await bobReq('move', { to: Q }); for (let i = 0; i < 12; i++) { ws.send(JSON.stringify({ type: 'pose', pose: { p: [P[0], 0, P[2] + (i + 1) / 6], yaw: 0 } })); await sleep(80); }
    for (let i = 0; i < 30; i++) { await sleep(500); const b = await bobRoot(); if (b && b[2] - P[2] > 1.8) break; }   // his poses landing on a slow page
    await sleep(800);
    const b1 = await bobRoot(), t1 = await centre('toy3');
    check('remote: a box Bob holds is drawn in Bob\'s hand, on Ann\'s screen', g3?.ok && b0 && t0 && Math.hypot(t0[0] - b0[0], t0[1] - b0[1], t0[2] - b0[2]) < 0.25, { g3: g3?.ok ?? g3?.refused ?? mk3?.refused, bob: b0, crate: t0 });
    check('remote: …and follows his hand when he moves (2 m)', b1 && t1 && t0 && Math.hypot(t1[0] - b1[0], t1[1] - b1[1], t1[2] - b1[2]) < 0.25 && t1[2] - t0[2] > 1.6, { bob: b1, crate: t1 });
    if (shots) await pg.screenshot({ path: `${shots}/phys-remote-held.png` });
    // a picture of a flight (no check rides on it): Bob throws the box he holds, and the page is drawn 0.5 s into it
    if (shots) { await bobReq('throw', { id: 'toy3', v: [2, 6, 0] });
      await race(pg.evaluate(async (ts) => { const t0 = performance.now(); while (globalThis.EW.physics.launched().toy3 === undefined && performance.now() - t0 < 30000) await new Promise((r) => setTimeout(r, 100));
        globalThis.EW.physics.frame(ts + 500); }, LAUNCH('toy3')), 40000).catch(() => null);
      await pg.screenshot({ path: `${shots}/phys-throw-midair.png` }); }
  }
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
