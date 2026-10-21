// heightmap readiness in a real browser: the page never builds noise in a heightmap's place. With the
// grid's fetch failing, the ground already standing stays (here: none — the stage floor) and the page
// says it is pending; once the fetch succeeds, the authored grid is the ground, built once. A newer
// terrain supersedes a waiting one, whose grid arriving later changes nothing.
//   bun tools/heightmap-readiness-browser-test.ts [--headed]
// The agent half: tools/heightmap-readiness-test.ts.
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodeGrid } from '../shared/terrainshape.js';
import { terrainParams, makeHeightField } from '../shared/terrainmath.js';
import { scratchBench, mkCheck, sleep } from './harness.ts';

const OPT = mkdtempSync(join(tmpdir(), 'hm-ready-opt-'));
const REF_A = 'store/heightmaps/00000000000000b1.json', REF_B = 'store/heightmaps/00000000000000b2.json';
mkdirSync(join(OPT, 'store', 'heightmaps'), { recursive: true });
const white = JSON.stringify(encodeGrid({ w: 2, h: 2, data: new Uint16Array([65535, 65535, 65535, 65535]) }));
for (const r of [REF_A, REF_B]) writeFileSync(join(OPT, r), white);
const HM_A = { seed: 7, size: 80, segments: 64, heightmap: { grid: REF_A, min: 0, max: 12 } };
const HM_B = { seed: 7, size: 80, segments: 64, heightmap: { grid: REF_B, min: 0, max: 30 } };
const PLAIN = { seed: 9, size: 80, segments: 64, amplitude: 5, flatRadius: 4 };
const plainAt = makeHeightField(terrainParams(PLAIN));
const P = [17, -11];   // the probe point

const { PORT, BASE, cws, cdp, evalJson, cleanup, die } = await scratchBench('hm-ready', {
  headed: process.argv.includes('--headed'), portFrom: 9440, serverEnv: { OPT_DIR: OPT, SKIP_OPT_SWEEP: '1' },
});
const { check, tally } = mkCheck();
async function until(f: () => any, label: string, timeout = 90_000) {
  const start = Date.now();
  while (!await f()) { if (Date.now() - start > timeout) await die(1, `timed out: ${label}`); await sleep(150); }
}
// the network fault: every grid request fails while `failing`, and is counted
let failing = true, failed = 0, served = 0;
cws.addEventListener('message', (ev) => {
  const m = JSON.parse(String(ev.data));
  if (m.method !== 'Fetch.requestPaused') return;
  if (failing) { failed++; void cdp.send('Fetch.failRequest', { requestId: m.params.requestId, errorReason: 'ConnectionFailed' }); }
  else { served++; void cdp.send('Fetch.continueRequest', { requestId: m.params.requestId }); }
});
await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*store/heightmaps/*' }] });

const WORLD = `hmready-${crypto.randomUUID().slice(0, 8)}`;
const msgs: any[] = [];
const dws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
dws.onmessage = (ev) => msgs.push(JSON.parse(String(ev.data)));
await new Promise((r, j) => { dws.onopen = r as any; dws.onerror = j as any; });
dws.send(JSON.stringify({ type: 'join', world: WORLD, id: 'hmdriver', token: '' }));
await until(() => msgs.some((m) => m.type === 'snapshot'), 'driver join');
async function terrain(args: unknown) {
  const start = msgs.length;
  dws.send(JSON.stringify({ type: 'verb', verb: 'terrain', args }));
  await until(() => msgs.slice(start).some((m) => (m.entry ?? m).verb === 'terrain' || m.type === 'error'), 'terrain echo', 10_000);
  const error = msgs.slice(start).find((m) => m.type === 'error');
  if (error) await die(1, `terrain refused: ${error.error}`);
}
const state = () => evalJson(`(async () => {
  const t = await import('/lib/terrain.js');
  const mesh = t.getTerrainMesh();
  globalThis.__meshIds ??= new WeakMap(); globalThis.__meshN ??= 0;
  if (mesh && !__meshIds.has(mesh)) __meshIds.set(mesh, ++__meshN);
  return { has: t.hasTerrain(), pending: EW.terrainPending, y: t.heightAt(${P[0]}, ${P[1]}), mesh: mesh ? __meshIds.get(mesh) : 0 };
})()`);

try {
  await terrain(HM_A);
  await cdp.send('Page.navigate', { url: `${BASE}/?name=hmviewer&world=${WORLD}` });
  await until(() => evalJson(`!!globalThis.EW && EW.terrainArgs !== null`).catch(() => false), 'page has the terrain bag');
  await until(() => failed >= 2, 'the grid fetch failing (twice: first try and one retry)');
  let s = await state();
  check('a heightmap whose grid failed is not built: no noise ground', !s.has && s.y === 0, JSON.stringify(s));
  check('...and the page says the terrain is pending', s.pending === true, JSON.stringify(s));
  failing = false;
  await until(async () => (await state()).has, 'the terrain built once the grid came');
  s = await state();
  check(`the ground is the authored grid's (${s.y.toFixed(2)} m), not noise`, Math.abs(s.y - 12) < 1e-6 && !s.pending, JSON.stringify(s));
  const first = s.mesh;
  await sleep(2500);
  check('...built exactly once', (await state()).mesh === first && first === 1, JSON.stringify(await state()));

  // a waiting heightmap overtaken by a newer terrain
  failing = true; const before = failed;
  await terrain(HM_B);
  await until(() => failed > before, 'the second grid failing');
  s = await state();
  check('the next heightmap, its grid failing, leaves the standing ground in place', Math.abs(s.y - 12) < 1e-6 && s.pending === true, JSON.stringify(s));
  await terrain(PLAIN);
  await until(async () => Math.abs((await state()).y - plainAt(P[0], P[1])) < 1e-4, 'the newer plain terrain');
  failing = false;
  await sleep(3500);   // past the waiting heightmap's retry
  s = await state();
  check('the superseded heightmap never builds, though its grid is now there', Math.abs(s.y - plainAt(P[0], P[1])) < 1e-4 && !s.pending, JSON.stringify(s));
} catch (e) {
  process.exitCode = 1; throw e;
} finally {
  dws.close();
  await cleanup(tally.failed || process.exitCode ? 1 : 0);
}
console.log(`${tally.passed} passed, ${tally.failed} failed`);
process.exit(tally.failed ? 1 : 0);
