// splashes and ripples in a real browser: the water's ripple shader compiles and draws, a splash throws drops
// that come back down, rings live and fade, and a body standing in the water rings it by itself.
//   bun tools/splash-browser-test.ts [--headed] [--shot out.png]
import { writeFileSync } from 'node:fs';
import { scratchBench, mkCheck, sleep } from './harness.ts';

// a pond beside the spawn point: the viewer stands knee-deep at its edge
const TERRAIN = { seed: 3, size: 80, segments: 80, amplitude: 0.2, flatRadius: 30,
  features: [{ type: 'hill', x: 5, z: -4, radius: 12, height: -2.5 }], water: { level: -0.45 } };
const shotAt = process.argv.includes('--shot') ? process.argv[process.argv.indexOf('--shot') + 1] : null;
const { PORT, BASE, cws, cdp, evalJson, cleanup, die } = await scratchBench('splash', {
  headed: process.argv.includes('--headed'), portFrom: 9460, serverEnv: { SKIP_OPT_SWEEP: '1' },
});
const { check, tally } = mkCheck();
const errors: string[] = [];
cws.addEventListener('message', (ev) => {
  const m = JSON.parse(String(ev.data));
  const text = m.method === 'Runtime.exceptionThrown' ? m.params.exceptionDetails?.exception?.description ?? m.params.exceptionDetails?.text
    : m.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(m.params.type) ? (m.params.args ?? []).map((a: any) => a.value ?? a.description ?? '').join(' ') : null;
  // real failures only: the loader's own [jank]/[longtask]/[load] timing lines are not errors
  if (text && !/^\[(jank|longtask|load|warm)\]/.test(String(text)) && /water|ripple|splashes|WGSL|pipeline|shader|uniform/i.test(String(text))) errors.push(String(text).slice(0, 300));
});
async function until(f: () => any, label: string, timeout = 120_000) {
  const start = Date.now();
  while (!await f()) { if (Date.now() - start > timeout) await die(1, `timed out: ${label}`); await sleep(200); }
}
const WORLD = `splash-${crypto.randomUUID().slice(0, 8)}`;
const msgs: any[] = [];
const dws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
dws.onmessage = (ev) => msgs.push(JSON.parse(String(ev.data)));
await new Promise((r, j) => { dws.onopen = r as any; dws.onerror = j as any; });
dws.send(JSON.stringify({ type: 'join', world: WORLD, id: 'splashdriver', token: '' }));
await until(() => msgs.some((m) => m.type === 'snapshot'), 'driver join');
dws.send(JSON.stringify({ type: 'verb', verb: 'terrain', args: TERRAIN }));
dws.send(JSON.stringify({ type: 'verb', verb: 'sky', args: { hours: 12, clouds: 'none' } }));
await sleep(500);
dws.close();

try {
  await cdp.send('Page.navigate', { url: `${BASE}/?name=splashviewer&world=${WORLD}` });
  await until(() => evalJson(`(async () => { const w = await import('/lib/water.js'); return w.waterLevel() !== null && !!globalThis.EW?.waterFx; })()`).catch(() => false), 'water built');
  // let the sheet's pipeline compile and draw a few frames
  await until(() => evalJson(`(async () => { const { scene } = await import('/lib/core.js'); return !!scene.getObjectByName('water'); })()`).catch(() => false), 'water mesh in the scene');
  await sleep(3000);
  // stand the viewer in the pond, a few metres from where the water will be thrown — once its body is here (a
  // spawn arriving later would put it back on the shore) — and wait until the splashes system has it in the water
  await until(() => evalJson(`!!EW.me()?.root`).catch(() => false), 'the viewer\'s body');
  await until(async () => {
    await evalJson(`(() => { EW.myState.pos.set(1.5, -1.2, 1.5); return true; })()`);
    await sleep(1500);
    return (await evalJson(`EW.waterFx()`)).bodies >= 1;
  }, 'the viewer standing in the pond');
  const spot = await evalJson(`(async () => { const w = await import('/lib/water.js'); return w.surfaceHeightAt(5, -4); })()`);
  check('the pond has a surface where we will splash', typeof spot === 'number', `${spot}`);
  await evalJson(`(async () => { await import('/lib/splashes.js'); return true; })()`);
  const before = (await evalJson(`EW.waterFx()`)).made;
  // (rings are counted as MADE: on a software renderer one frame can outlast a ring's 3.5 s)
  const [thrown, fx] = await evalJson(`[EW.splash(5, -4, 1), EW.waterFx()]`);
  check(`a full splash throws drops and rings the water (${fx.drops} drops, ${fx.made - before} rings)`, thrown === true && fx.drops > 40 && fx.made > before, JSON.stringify(fx));
  for (let i = 0; i < 6; i++) await evalJson(`EW.ripple(${3 + i * 0.8}, -2, 0.7)`);
  await sleep(120);
  if (shotAt) {
    const { data } = await cdp.send<any>('Page.captureScreenshot', { format: 'png' });
    writeFileSync(shotAt, Buffer.from(data, 'base64'));
    console.log(`  screenshot → ${shotAt}`);
  }
  // (counted in this page's frames, not the wall clock: a software renderer draws a frame every second or two)
  const landed = await (async () => { const end = Date.now() + 90_000; while (Date.now() < end) { if ((await evalJson(`EW.waterFx()`)).drops === 0) return true; await sleep(500); } return false; })();
  check('the drops all come back down', landed, JSON.stringify(await evalJson(`EW.waterFx()`)));
  const faded = await (async () => { const end = Date.now() + 90_000; while (Date.now() < end) { if ((await evalJson(`EW.waterFx()`)).ripples <= 2) return true; await sleep(500); } return false; })();
  const settled = await evalJson(`EW.waterFx()`);
  check('...and the rings fade (a body standing in the water still rings it faintly now and then)', faded, JSON.stringify(settled));
  check('the viewer is tracked as a body in the water', settled.bodies >= 1, JSON.stringify(settled));
  console.log(`  body splashes: ${JSON.stringify(settled.recent)}`);
  console.log(`  viewer at ${JSON.stringify(await evalJson(`EW.myState.pos.toArray().map((v) => +v.toFixed(2))`))}`);
  check('no shader, pipeline or splash errors', errors.length === 0, errors.slice(0, 3).join(' | '));
} catch (e) {
  process.exitCode = 1; throw e;
} finally {
  await cleanup(tally.failed || process.exitCode ? 1 : 0);
}
console.log(`${tally.passed} passed, ${tally.failed} failed`);
process.exit(tally.failed ? 1 : 0);
