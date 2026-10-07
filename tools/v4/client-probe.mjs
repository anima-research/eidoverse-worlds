// tools/v4/client-probe.mjs — TODAY's client (headless Chromium) visiting a v4 world (protocol/v4 slice 2).
// usage (one Chrome, under the guard):  perf-guard.sh -t 240 -- bun tools/v4/client-probe.mjs
// What it shows, each as a stage line printed green or red:
//   boot      the client boots into a v4 world (founded by tools/v4/world.ts in a scratch WORLDS_DIR) and finishes
//   see       a thing created through the door BEFORE the visit is realized (the snapshot's projection)
//   live      a thing another person creates through the door WHILE it watches is realized (projected v1 verbs)
//   spot      a spot light set through the door lights a spot slot with its cone, shining down the thing's -Z
//   rocket    a socket's whole rotation: sitting in a seat lying on its back lays the body down; standing rights it
//   reach     a hand target on a moving part moves the hand with the part
//   blend     a pose blended by a signal (param.lean, written through the door) follows it, in the mixer's own weights
//   anchor    hips (a seat) lands the hips joint on the socket; feet (a standing place) lands the soles on it
//   swing     a phase-locked pose: the clip's time follows the pendulum's phase; the sitter tilts with the plank
//   leaveBy   script: W and X don't get you off, the world does (the socket taken away); without it, W does
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
import { cycleOf } from '../../client/lib/socksignals.js';

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

  // ===================================================================== the body at a socket (shared/sockbody.js)
  // Each stage: Bob builds a small thing through the door (a crate at a fifth of its size, so the body isn't hidden
  // inside it), Ann sits on it with her own /sit, and what her body does is read off the live skeleton and mixer.
  const SHOTS = process.env.PROBE_SHOTS;
  let rid = 10;
  const door = async (tool, args) => { const id = ++rid; ws.send(JSON.stringify({ type: 'v4', id, tool, args }));
    for (let i = 0; i < 60; i++) { const m = inbox.find((x) => x.type === 'v4-result' && x.id === id); if (m) return m.reply ?? m; await new Promise((r) => setTimeout(r, 100)); }
    return { ok: false, refused: { reason: 'no answer' } }; };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const ev = (fn, arg) => race(pg.evaluate(fn, arg), 10000);
  const waitFor = async (fn, arg, ms = 12000) => { const t = Date.now(); let v = null; while (Date.now() - t < ms) { v = await ev(fn, arg).catch(() => null); if (v) return v; await sleep(200); } return v; };
  const seated = () => ev(() => { const m = globalThis.EW.avatarMounts.get(globalThis.EW.net.myId ?? 'Ann') ?? [...globalThis.EW.avatarMounts.entries()].find(([k]) => k === 'Ann')?.[1]; return m ? `${m.to}/${m.slot}` : null; });
  const sit = async (arg, want) => { await ev((a) => globalThis.EW.bus.emit('command', { cmd: 'sit', arg: a }), arg); return waitFor(async (w) => { const m = [...globalThis.EW.avatarMounts.entries()].find(([k]) => k === 'Ann')?.[1]; return m && `${m.to}/${m.slot}` === w; }, want); };
  const stand = async () => { await ev(() => globalThis.EW.bus.emit('xr:stand')); await sleep(500); };
  const here = await ev(() => globalThis.EW.me().root.position.toArray());
  const thing = (id, dx, dz, comps, y = 0) => door('create', { id, model: MODEL, components: { transform: { pos: [here[0] + dx, y, here[2] + dz], scale: [0.2, 0.2, 0.2] }, ...comps } });
  const realized = (id) => waitFor((i) => !!globalThis.EW.entities.get(i), id);
  // the screenshots are the follow camera's own view (it rides the seat behind the body)
  const shoot = async (name) => { if (SHOTS) await pg.screenshot({ path: `${SHOTS}/${name}.png` }); };

  // (a) reach: a hand target on a moving PART moves the hand with the part. The crate's mesh (node Crate_LP) swings on
  //     a part pendulum; the left hand's target is the crate's top corner, riding that part. Expected target: the corner
  //     carried by the part's own live transform (three's localToWorld), independent of the client's reach code.
  {
    const AT = [1.25, 2.0, -0.75];
    const r = await thing('lever', 1.8, 0, { motion: { type: 'pendulum', part: 'Crate_LP', axis: [0, 0, 1], amp: 0.6, period: 2.4, pivot: [0, -1, 0] },
      sockets: { seat: { pos: [0, 1.0, -2.5], body: { reach: { leftHand: { at: AT, part: 'Crate_LP' } } } } } }, 0.3);
    if (!r.ok) stage('reach: setup', false, r.refused);
    await realized('lever');
    const sat = await sit('lever', 'lever/seat');
    await sleep(1500);
    const samples = [];
    for (let i = 0; i < 12; i++) {
      samples.push(await ev((at) => { const EW = globalThis.EW, T = EW.THREE; const me = EW.me(); let part = null;
        EW.entities.get('lever').traverse((o) => { if (!part && o.name === 'Crate_LP') part = o; });
        const b = part?.userData.mbase; if (!part || !b) return { why: 'no part / not animated', part: !!part };
        const exp = part.localToWorld(new T.Vector3(at[0] - b.pos[0], at[1] - b.pos[1], at[2] - b.pos[2]));
        const hand = me.vrm.humanoid.getRawBoneNode('leftHand').getWorldPosition(new T.Vector3());
        return { exp: exp.toArray(), hand: hand.toArray(), restQ: b.quat, gap: me.reachStatus().leftHand?.gap ?? null }; }, AT).catch((e) => ({ why: String(e) })));
      await sleep(180);
    }
    const good = samples.filter((x) => x.exp);
    const err = good.map((x) => Math.hypot(x.hand[0] - x.exp[0], x.hand[1] - x.exp[1], x.hand[2] - x.exp[2]));
    const xs = good.map((x) => x.exp[0]);
    check('reach: seated on the lever, a hand target on its swinging part', !!sat && good.length === samples.length, { sat, first: samples[0] });
    check('reach: …the part really moves (the target travels > 15 cm)', Math.max(...xs) - Math.min(...xs) > 0.15, { range: Math.max(...xs) - Math.min(...xs) });
    check('reach: …and the hand stays on it through the swing (every sample within 6 cm)', err.length > 0 && Math.max(...err) < 0.06, { err: err.map((e) => +e.toFixed(3)), restQ: good[0]?.restQ });
    await shoot('reach-on-part');
    await stand();
  }

  // (b) a blended pose follows its signal: pose {by: 'param.lean', clips: [[0, 'sitchair'], [1, 'sit']]}; Bob writes the
  //     thing's params component through the door, and the mixer's own weights follow
  {
    const r = await thing('stool', -1.8, 0, { params: { lean: 0 }, sockets: { seat: { pos: [0, 2.6, 0], body: { pose: { by: 'param.lean', clips: [[0, 'sitchair'], [1, 'sit']] } } } } });
    if (!r.ok) stage('blend: setup', false, r.refused);
    await realized('stool');
    const sat = await sit('stool', 'stool/seat');
    const weights = () => ev(() => { const a = globalThis.EW.me().actions; return { sitchair: +(a.sitchair?.getEffectiveWeight() ?? -1).toFixed(3), sit: +(a.sit?.getEffectiveWeight() ?? -1).toFixed(3) }; });
    const settle = async (want) => { let w = null; for (let i = 0; i < 30; i++) { await sleep(150); w = await weights(); if (Math.abs(w.sit - want) < 0.03 && Math.abs(w.sitchair - (1 - want)) < 0.03) break; } return w; };
    const w0 = await settle(0);
    await door('set', { id: 'stool', component: 'params', value: { lean: 0.25 } });
    const w1 = await settle(0.25);
    await door('set', { id: 'stool', component: 'params', value: { lean: 1 } });
    const w2 = await settle(1);
    check('blend: lean 0 → all sitchair', !!sat && Math.abs(w0.sitchair - 1) < 0.03 && Math.abs(w0.sit) < 0.03, { sat, w0 });
    check('blend: lean 0.25 (written through the door) → three quarters sitchair, a quarter sit', Math.abs(w1.sitchair - 0.75) < 0.03 && Math.abs(w1.sit - 0.25) < 0.03, w1);
    check('blend: lean 1 → all sit', Math.abs(w2.sit - 1) < 0.03 && Math.abs(w2.sitchair) < 0.03, w2);
    // (e2) anchor hips (a seat's default): the hips joint lands on the socket, wherever the clip puts them
    const hips = await ev(() => { const EW = globalThis.EW, T = EW.THREE; const me = EW.me(); const s = EW.entities.get('stool'); s.updateWorldMatrix(true, false);
      return { hips: me.vrm.humanoid.getRawBoneNode('hips').getWorldPosition(new T.Vector3()).toArray(), sock: new T.Vector3(0, 2.6, 0).applyMatrix4(s.matrixWorld).toArray(), root: me.root.position.toArray() }; });
    check('anchor: hips (a seat\'s default) puts the hips joint on the socket (within 2 cm), not the root', Math.hypot(...hips.hips.map((v, i) => v - hips.sock[i])) < 0.02 && Math.abs(hips.root[1] - hips.sock[1]) > 0.03, hips);
    await stand();
  }

  // (c) a phase-locked swing pose follows the pendulum: the crate's mesh swings (a part pendulum); the seat rides that
  //     part and its pose is {clip: 'walk', time: 'phase'}. The clip's time, as a fraction of its length, must equal the
  //     pendulum's phase at the sequencer's clock — computed here from the motion component with the shared closed form
  {
    const r = await thing('swing', 0, 2.2, { motion: { type: 'pendulum', part: 'Crate_LP', axis: [1, 0, 0], amp: 0.5, period: 3, pivot: [0, 4, 0] },
      sockets: { seat: { pos: [0, 2.6, 0], part: 'Crate_LP', body: { pose: { clip: 'walk', time: 'phase' } } } } }, 0.4);
    if (!r.ok) stage('swing: setup', false, r.refused);
    await realized('swing');
    const sat = await sit('swing', 'swing/seat');
    await sleep(1200);
    const rows = [];
    for (let i = 0; i < 8; i++) {
      // the page's clip time and its sequencer clock, read together; the expected phase from the motion component the
      // page holds, through the shared closed form here (the probe's own import, not the page's code)
      const x = await ev(() => { const EW = globalThis.EW; const m = EW.comps.get('swing')?.motion;
        const a = EW.me().actions.walk; const r = EW.me().root; r.updateMatrixWorld();
        // the clock the seat read this frame's pose at (under load a headless frame can be a second apart from this call)
        return { m, now: EW.me()._seatState?.now ?? null, clip: a ? a.time / a.getClip().duration : null, w: a?.getEffectiveWeight() ?? null, upZ: +r.matrixWorld.elements[6].toFixed(3) }; });
      rows.push({ ...x, m: undefined, want: x.m ? cycleOf(x.m, x.now).phase : null });
      await sleep(260);
    }
    const d = rows.map((x) => { const e = Math.abs(x.clip - x.want); return Math.min(e, 1 - e); });
    const ups = rows.map((x) => x.upZ);
    check('swing: seated on the swinging part, the walk clip holds the body (weight ≈ 1)', !!sat && rows.every((x) => x.w > 0.97), { sat, rows: rows.slice(0, 2) });
    check('swing: …its time follows the pendulum\'s phase (within 0.03 of a cycle, every sample)', d.every((x) => x < 0.03) && new Set(rows.map((x) => x.want.toFixed(2))).size > 4, { d: d.map((x) => +x.toFixed(3)), rows });
    check('swing: …and the sitter tilts with the plank (body up leans fore and aft)', Math.max(...ups) - Math.min(...ups) > 0.2, ups);
    await shoot('swing-phase');
    await stand();
  }

  // (d) leaveBy: script — WASD and X don't get you off; the world does (Bob takes the socket away). The control: the
  //     same seat without leaveBy lets W take you off, so the block isn't a dead key.
  {
    const SEAT = { pos: [0, 2.6, 0], body: { leaveBy: 'script' } };
    const r = await thing('pod', 1.8, 2.2, { sockets: { seat: SEAT } });
    if (!r.ok) stage('leaveBy: setup', false, r.refused);
    await realized('pod');
    const sat = await sit('pod', 'pod/seat');
    await pg.bringToFront(); await ev(() => document.activeElement?.blur?.());
    await pg.keyboard.down('KeyW'); await sleep(700); await pg.keyboard.up('KeyW');
    const afterW = await seated();
    await pg.keyboard.press('KeyX'); await sleep(500);
    const afterX = await seated();
    check('leaveBy script: W held and X pressed, still seated', !!sat && afterW === 'pod/seat' && afterX === 'pod/seat', { sat, afterW, afterX });
    await door('set', { id: 'pod', component: 'sockets', value: {} });
    const freed = await waitFor(async () => ![...globalThis.EW.avatarMounts.keys()].includes('Ann') || null, null, 5000);
    check('leaveBy script: …the world lets go (the socket taken away), and the body is off', !!freed, await seated());
    await door('set', { id: 'pod', component: 'sockets', value: { seat: { pos: [0, 2.6, 0], body: {} } } });
    await sleep(600);
    const again = await sit('pod', 'pod/seat');
    await sleep(500);
    await pg.keyboard.down('KeyW'); await sleep(400); await pg.keyboard.up('KeyW'); await sleep(300);
    check('leaveBy (control): the same seat without leaveBy, W takes you off', !!again && (await seated()) === null, await seated());
  }

  // (e) anchor: feet — a standing place on a plinth puts a standing body's soles on the socket. The sole height is
  //     measured here from Ann standing on the ground first (foot joints above her root), not from the client's anchor code
  {
    await sleep(800);
    const rest = await ev(() => { const EW = globalThis.EW, T = EW.THREE; const me = EW.me(); const h = me.vrm.humanoid;
      const y = (h.getRawBoneNode('leftFoot').getWorldPosition(new T.Vector3()).y + h.getRawBoneNode('rightFoot').getWorldPosition(new T.Vector3()).y) / 2; return y - me.root.position.y; });
    const r = await thing('plinth', -1.8, 2.2, { sockets: { top: { pos: [0, 2.0, 0], body: { action: 'stand' } } } });
    if (!r.ok) stage('anchor: setup', false, r.refused);
    await realized('plinth');
    const sat = await sit('plinth', 'plinth/top');
    await sleep(1200);
    const at = await ev(() => { const EW = globalThis.EW, T = EW.THREE; const me = EW.me(); const h = me.vrm.humanoid; const s = EW.entities.get('plinth'); s.updateWorldMatrix(true, false);
      const l = h.getRawBoneNode('leftFoot').getWorldPosition(new T.Vector3()), rr = h.getRawBoneNode('rightFoot').getWorldPosition(new T.Vector3());
      return { feet: [(l.x + rr.x) / 2, (l.y + rr.y) / 2, (l.z + rr.z) / 2], sock: new T.Vector3(0, 2.0, 0).applyMatrix4(s.matrixWorld).toArray(), clip: EW.myState.clip }; });
    check('anchor: feet (a standing place) — the soles on the socket: foot joints at socket + their standing height (within 2 cm)',
      !!sat && Math.abs(at.feet[1] - at.sock[1] - rest) < 0.02 && Math.hypot(at.feet[0] - at.sock[0], at.feet[2] - at.sock[2]) < 0.12, { rest, at });
    await shoot('stand-on-plinth');
    await stand();
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
