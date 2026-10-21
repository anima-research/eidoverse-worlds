// Roaming renderers, end to end, in a real browser against a running server.
//   bun tools/roaming-renderer-check.ts http://127.0.0.1:<port> [SHOT=path.png]
// A roaming renderer page waits in a lobby world; an "agent" then joins another world alone and builds there (several
// crates). Its arrival alone must send the renderer over (pre-warm); a snapshot must come only once the world is
// REALIZED (every crate loaded — never a partial frame); a second snapshot is fast (the renderer stays).
import { chromium } from 'playwright';
import { strict as assert } from 'node:assert';
import { writeFileSync } from 'node:fs';
const base = process.argv[2] ?? 'http://127.0.0.1:19347';
const shot = process.env.SHOT;
const world = `roam-build-${Date.now().toString(36)}`, lobby = `roam-lobby-${Date.now().toString(36)}`;
const crates = ['blue', 'green', 'red', 'yellow'].map((c, i) => ({ verb: 'spawn', args: { id: `crate-${c}`, lib: `eidoverse/assets/models/crate_large_${c}.glb`, pos: [Math.cos(i * 1.57) * 4, 0, 6 + Math.sin(i * 1.57) * 4], yaw: 0 } }));
let ws: WebSocket | null = null, keepPose: ReturnType<typeof setInterval> | undefined;
const browser = await chromium.launch({ headless: true, channel: 'chrome', args: ['--enable-unsafe-webgpu', '--use-angle=metal'] });
try {
  const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
  await page.goto(`${base}/?world=${lobby}&renderer&roam&name=roam-check`);
  await page.waitForFunction(() => !!globalThis.__waterDebug, null, { timeout: 60000 });
  await Bun.sleep(3000);
  const rendererWorld = () => page.evaluate(async () => (await import('/lib/base.js')).CONFIG.world);
  // the agent: joins as an agent body, builds, stays
  ws = new WebSocket(base.replace('http', 'ws') + '/ws');
  const sock = ws;
  await new Promise<void>((res, rej) => { sock.onopen = () => res(); sock.onerror = () => rej(new Error('cannot connect')); });
  const joined = new Promise<void>((res) => { sock.onmessage = (e) => { if (JSON.parse(String(e.data)).type === 'snapshot') res(); }; });
  sock.send(JSON.stringify({ type: 'join', world, id: 'builder-agent', agent: true, avatar: 'eidoverse/assets/vrms/shino.vrm' }));
  await joined;
  for (const v of crates) { sock.send(JSON.stringify({ type: 'verb', ...v })); await Bun.sleep(300); }
  const pose = () => sock.send(JSON.stringify({ type: 'pose', pose: { p: [0, 0, 0], yaw: 0, speed: 0, clip: 'idle' } }));
  pose(); keepPose = setInterval(pose, 200);
  // PRE-WARM: the agent's arrival alone sends the roaming renderer to its world, before any snapshot is asked
  const tw = Date.now(); while (Date.now() - tw < 20000 && (await rendererWorld()) !== world) await Bun.sleep(250);
  const prewarmMs = Date.now() - tw;
  assert.equal(await rendererWorld(), world, 'the agent arriving brought the roaming renderer (prewarm)');
  // the agent keeps building while the renderer loads — or (GRACE_MS=0) asks at once: the renderer must WAIT for the
  // world rather than send what it has so far
  await Bun.sleep(Number(process.env.GRACE_MS ?? 4000));
  const snap = async () => { const t0 = Date.now(); const r = await fetch(`${base}/snap?world=${world}&follow=builder-agent&view=third`);
    return { status: r.status, ms: Date.now() - t0, png: r.ok ? new Uint8Array(await r.arrayBuffer()) : null, err: r.ok ? '' : await r.text() }; };
  const first = await snap();
  console.log(JSON.stringify({ first: { status: first.status, ms: first.ms, err: first.err.slice(0, 160) } }));
  assert.equal(first.status, 200, `the roamer came and served the snapshot: ${first.err}`);
  // the frame was taken only once the world was realized: every crate a real model, nothing loading
  const where = await page.evaluate(async () => { const { CONFIG } = await import('/lib/base.js'); const m = await import('/lib/realize/models.js');
    const r = m.residencyDebug(); return { world: CONFIG.world, real: r.real, loading: r.loading, standins: r.standins }; });
  console.log(JSON.stringify({ renderer: where }));
  assert.equal(where.world, world, 'the roaming renderer is in the agent\'s world');
  assert.ok(where.real >= crates.length && where.loading === 0 && where.standins === 0, `every crate loaded at capture: ${JSON.stringify(where)}`);
  if (shot && first.png) writeFileSync(shot, first.png);
  await Bun.sleep(2200);   // the broker's per-renderer cooldown
  const second = await snap();
  console.log(JSON.stringify({ second: { status: second.status, ms: second.ms } }));
  assert.equal(second.status, 200); assert.ok(second.ms < 3000, 'the renderer stays: the next snapshot is fast');
  console.log(`PASS: an agent arriving alone brought a roaming renderer (${prewarmMs} ms); every model loaded (${where.real}) before capture; snapshots ${first.ms} ms then ${second.ms} ms`);
} finally { clearInterval(keepPose); ws?.close(); await browser.close(); }
