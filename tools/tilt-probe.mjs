// tilt-probe — does a real browser SHOW the fold's full orientation?
// (PROTOCOL §9 amendment.) Spawns things over a raw websocket with q, a
// yaw-only control, and a tilted thing that then gets a bare-yaw place,
// then boots Chromium into the world and compares each object's live
// quaternion with what the fold says.
//
//   WORLDS_DIR=$(mktemp -d) PORT=8998 SKIP_OPT_SWEEP=1 bun run server/server.ts &
//   node tools/tilt-probe.mjs [ws://localhost:8998]
import { chromium } from 'playwright-core';

const BASE = (process.argv[2] ?? 'ws://localhost:8998').replace(/\/$/, '');
const HTTP = BASE.replace(/^ws/, 'http');
const WORLD = `tilt-${Math.random().toString(36).slice(2, 7)}`;
const H = Math.SQRT1_2;
const LAMP = 'eidoverse/assets/models/streetlight_lamp_light_street_blade_runner_cyberpunk.glb', CRATE = 'eidoverse/assets/models/crate_large_red.glb';
const CASES = {
  back:  { lib: LAMP, q: [H, 0, 0, H] },                     // a lamppost on its back
  edge:  { lib: CRATE, q: [0.3826834323650898, 0, 0, 0.9238795325112867] },   // a crate tipped 45° onto an edge (not 120° about the diagonal: that maps a cube onto itself and LOOKS upright)
  plain: { lib: LAMP, yaw: 1.2 },                            // control: yaw only, standing
  spun:  { lib: LAMP, q: [H, 0, 0, H], thenYaw: 2.0 },       // toppled, then a bare yaw
};
const timed = (p, ms, what) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`timeout: ${what}`)), ms))]);
const sameRot = (a, b, eps = 1e-6) => a && b && (a.every((v, i) => Math.abs(v - b[i]) < eps) || a.every((v, i) => Math.abs(v + b[i]) < eps));

let browser, ws, failed = 0;
const check = (name, ok, detail = '') => { if (!ok) failed++; console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`); };
try {
  // 1. author the world over a raw socket
  ws = new WebSocket(`${BASE}/ws?name=builder`);
  const errs = [];
  await timed(new Promise((res, rej) => {
    ws.onopen = () => ws.send(JSON.stringify({ type: 'join', world: WORLD, id: 'builder', token: process.env.JOIN_TOKEN ?? '' }));
    ws.onmessage = (e) => { const m = JSON.parse(String(e.data)); if (m.type === 'snapshot') res(); if (m.type === 'error') errs.push(m.error); };
    ws.onerror = rej;
  }), 10000, 'join snapshot');
  ws.onmessage = (e) => { const m = JSON.parse(String(e.data)); if (m.type === 'error') errs.push(m.error); };
  const send = (verb, args) => ws.send(JSON.stringify({ type: 'verb', verb, args }));
  let x = 0;
  for (const [id, c] of Object.entries(CASES)) {
    send('spawn', { id, lib: c.lib, pos: [x, 1, 3], ...(c.q ? { q: c.q } : {}), ...(c.yaw != null ? { yaw: c.yaw } : {}) });
    x += 4;
  }
  send('place', { id: 'spun', yaw: CASES.spun.thenYaw });
  await new Promise(r => setTimeout(r, 300));
  console.log('stage: authored', Object.keys(CASES).length, '| verb errors:', JSON.stringify(errs));
  if (errs.length) throw new Error('authoring refused');

  // 2. boot the client
  browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(`${HTTP}/?name=watcher&world=${WORLD}`);
  const ready = await page.waitForFunction(
    ids => globalThis.EW?.entities && ids.every(id => globalThis.EW.entities.get(id)),
    Object.keys(CASES), { timeout: 60000 }).then(() => true, () => false);
  const stage = await timed(page.evaluate(() => ({ ew: !!globalThis.EW, n: globalThis.EW?.entities?.size ?? -1,
    ids: [...(globalThis.EW?.entities?.keys() ?? [])] })), 5000, 'stage eval');
  console.log('stage: ready', ready, JSON.stringify(stage));
  if (!ready) { console.log('page errors:', errors.slice(-8)); throw new Error('readiness gate failed'); }

  // 3. compare live transforms with the fold
  const live = await timed(page.evaluate(ids => Object.fromEntries(ids.map(id => {
    const o = globalThis.EW.entities.get(id);
    return [id, { quat: o.quaternion.toArray(), base: o.userData.base ?? null }];
  })), Object.keys(CASES)), 5000, 'transform eval');
  const THREE_UP = (q) => { const [x, y, z, w] = q; return [2 * (x * y - w * z), 1 - 2 * (x * x + z * z), 2 * (y * z + w * x)]; };
  for (const [id, c] of Object.entries(CASES)) {
    const L = live[id];
    if (c.q && !c.thenYaw) check(`${id}: rendered orientation == spawned q`, sameRot(L.quat, c.q), JSON.stringify(L.quat));
    if (c.q && !c.thenYaw) check(`${id}: rest pose carries q (motion composes on the tilt)`, sameRot(L.base?.q, c.q), JSON.stringify(L.base));
    if (!c.q) check(`${id}: yaw-only renders as a pure yaw`, sameRot(L.quat, [0, Math.sin(c.yaw / 2), 0, Math.cos(c.yaw / 2)]), JSON.stringify(L.quat));
    if (c.thenYaw != null) {
      const up = THREE_UP(L.quat);
      check(`${id}: a bare yaw kept the tilt (up stays horizontal)`, Math.abs(up[1]) < 1e-6, JSON.stringify(up));
      check(`${id}: ...and turned it to face the new heading`, Math.abs(Math.atan2(-up[0], -up[2]) - c.thenYaw) < 1e-6 || Math.abs(Math.atan2(up[0], up[2]) - c.thenYaw) < 1e-6, JSON.stringify(up));
    }
  }
  const shot = process.env.SHOT ?? '/tmp/tilt-probe.png';
  const goIn = page.getByText('go in anyway');
  if (await goIn.isVisible().catch(() => false)) await goIn.click();
  for (const t of ['got it']) { const b = page.getByText(t, { exact: true }); if (await b.isVisible().catch(() => false)) await b.click(); }
  // bring the props to the camera: pos-only places, which must NOT touch orientation
  const cam = await timed(page.evaluate(() => { const c = globalThis.EW.camera, d = new globalThis.EW.THREE.Vector3(); c.getWorldDirection(d);
    return { p: c.position.toArray(), d: d.toArray() }; }), 5000, 'camera');
  const fx = cam.d[0], fz = cam.d[2], n = Math.hypot(fx, fz) || 1, ux = fx / n, uz = fz / n, rx = uz, rz = -ux;
  const spots = {};
  Object.keys(CASES).forEach((id, k) => {
    const side = (k < 2 ? -1 : 1) * (3.2 + (k % 2) * 3.4), dist = 10;
    spots[id] = [cam.p[0] + ux * dist + rx * side, 0.6, cam.p[2] + uz * dist + rz * side];
    send('place', { id, pos: spots[id] });
  });
  const arrived = await page.waitForFunction(sp => Object.entries(sp).every(([id, p]) => {
    const o = globalThis.EW.entities.get(id); return o && Math.hypot(o.position.x - p[0], o.position.z - p[2]) < 0.01; }), spots, { timeout: 20000 }).then(() => true, () => false);
  console.log('stage: props moved to camera', arrived);
  const after = await timed(page.evaluate(ids => Object.fromEntries(ids.map(id => [id, globalThis.EW.entities.get(id).quaternion.toArray()])), Object.keys(CASES)), 5000, 'after');
  for (const id of ['back', 'edge']) check(`${id}: a pos-only place leaves the tilt alone`, sameRot(after[id], CASES[id].q), JSON.stringify(after[id]));
  // the REAL model path, not the placeholder's: wait for every swap, then check again
  const real = await page.waitForFunction(ids => ids.every(id => { const o = globalThis.EW.entities.get(id); return o && !o.userData.placeholder; }),
    Object.keys(CASES), { timeout: 120000 }).then(() => true, () => false);
  console.log('stage: real models realized', real);
  if (real) {
    const R = await timed(page.evaluate(ids => Object.fromEntries(ids.map(id => { const o = globalThis.EW.entities.get(id);
      return [id, { quat: o.quaternion.toArray(), base: o.userData.base ?? null }]; })), Object.keys(CASES)), 5000, 'real eval');
    for (const [id, c] of Object.entries(CASES)) {
      if (c.q && !c.thenYaw) check(`${id} (real model): rendered == q, base carries q`, sameRot(R[id].quat, c.q) && sameRot(R[id].base?.q, c.q), JSON.stringify(R[id]));
      if (!c.q) check(`${id} (real model): pure yaw`, sameRot(R[id].quat, [0, Math.sin(c.yaw / 2), 0, Math.cos(c.yaw / 2)]));
      if (c.thenYaw != null) check(`${id} (real model): still toppled`, Math.abs(THREE_UP(R[id].quat)[1]) < 1e-6, JSON.stringify(R[id].quat));
    }
  }
  await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(r)))));
  await page.screenshot({ path: shot });
  console.log('screenshot:', shot, '| page errors:', JSON.stringify(errors).slice(0, 600));
} catch (e) {
  failed++;
  console.log('PROBE FAILED:', e.message);
} finally {
  try { ws?.close(); } catch {}
  await browser?.close().catch(() => {});
}
console.log(failed ? `\n${failed} failed` : '\nall green');
process.exit(failed ? 1 : 0);
