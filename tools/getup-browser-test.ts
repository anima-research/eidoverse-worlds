// getting up and rejoining after going limp, in a real browser: the body
// stands on the floor it lay on — a stair landing, an upper floor — through
// the shipping call sites (localbody.js getUp; a reload's restore through the
// server's settledPose and main.js), not at height 0 and not at its root,
// which lies below that floor.
//   bun tools/getup-browser-test.ts [--headed]
// The helper half: tools/getup-floor-test.ts.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildGlb } from './two-storey-fixture.ts';
import { scratchBench, mkCheck, sleep } from './harness.ts';

const OPT = mkdtempSync(join(tmpdir(), 'getup-opt-'));
const { PORT, BASE, cdp, cws: cws0, evalJson, cleanup, die } = await scratchBench('getup', {
  headed: process.argv.includes('--headed'), portFrom: 9460, serverEnv: { OPT_DIR: OPT, SKIP_OPT_SWEEP: '1' },
});
const { check, tally } = mkCheck();
const restores: any[] = [];
(await import('./harness.ts'));

async function until(f: () => any, label: string, timeout = 60_000) {
  const start = Date.now();
  while (!await f()) { if (Date.now() - start > timeout) await die(1, `timed out: ${label}`); await sleep(150); }
}

// an 8×8m house, walls 7m: ground floor 0.3, a solid stair landing (2×3m,
// 1.8m up) in one corner, an upper floor at 3.3 over the west half
const FLOOR = 0.3, LANDING = 1.8, UPPER = 3.3;
const boxes = [
  [-4, 0, -4, 4, FLOOR, 4],
  [-4, FLOOR, -4, -3.8, 7, 4], [3.8, FLOOR, -4, 4, 7, 4], [-4, FLOOR, -4, 4, 7, -3.8], [-4, FLOOR, 3.8, 4, 7, 4],
  [1.8, 0, -3.8, 3.8, LANDING, -0.8],
  [-3.8, 3.1, -3.8, -0.5, UPPER, 3.8],
];
const WORLD = `getup-${crypto.randomUUID().slice(0, 8)}`;
const msgs: any[] = [];
const dws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
dws.onmessage = (ev) => msgs.push(JSON.parse(String(ev.data)));
await new Promise((r, j) => { dws.onopen = r as any; dws.onerror = j as any; });
dws.send(JSON.stringify({ type: 'join', world: WORLD, id: 'builder', token: '' }));
await until(() => msgs.some((m) => m.type === 'snapshot'), 'driver join');
async function verb(v: string, args: unknown) {
  const start = msgs.length;
  dws.send(JSON.stringify({ type: 'verb', verb: v, args }));
  await until(() => msgs.slice(start).some((m) => (m.entry ?? m).verb === v || m.type === 'error'), `${v} echo`, 10_000);
  const error = msgs.slice(start).find((m) => m.type === 'error');
  if (error) await die(1, `${v} refused: ${error.error}`);
}

const page = `${BASE}/?name=lier&world=${WORLD}`;
/** The page is up, its body exists, and the house's collider is fitted. */
const ready = () => evalJson(`(async () => {
  if (!globalThis.EW) return false;
  const [{ getMe }, C] = await Promise.all([import('/lib/mybody.js'), import('/lib/colliders.js')]);
  return !!getMe() && [...C.nearColliders(0, 0, 8)].some(([id]) => id === 'house');
})()`).catch(() => false);
const body = () => evalJson(`(async () => {
  const [{ myState }, L] = await Promise.all([import('/lib/controller.js'), import('/lib/localbody.js')]);
  return { y: myState.pos.y, x: myState.pos.x, z: myState.pos.z, clip: myState.clip, downed: L.isDowned(), settling: !!L.activeRagdoll(), floor: myState.floor ?? null };
})()`);
async function standAt(x: number, y: number, z: number) {
  await evalJson(`(async () => { const { myState } = await import('/lib/controller.js'); myState.pos.set(${x}, ${y}, ${z}); })()`);
  await sleep(800);
}
async function lieDown() {
  await evalJson(`(async () => { (await import('/lib/localbody.js')).goLimp(); })()`);
  await until(async () => { const b = await body(); return b.downed && !b.settling; }, 'the doll settles', 60_000);
}

try {
  const up = await (await fetch(`${BASE}/upload?name=house`, { method: 'POST', body: await buildGlb(boxes as any) })).json() as { path: string };
  await verb('terrain', { seed: 3, size: 80, segments: 32, amplitude: 0.0, flatRadius: 40 });
  await verb('spawn', { id: 'house', lib: up.path, pos: [0, 0, 0], yaw: 0, collide: 'exact' });
  await cdp.send('Page.navigate', { url: page });
  await until(ready, 'the page, its body and the house', 180_000);   // a headless page loads its avatar slowly

  for (const [where, x, z, floor] of [['on the stair landing', 2.8, -2.3, LANDING], ['upstairs', -2.2, 0, UPPER]] as [string, number, number, number][]) {
    await standAt(x, floor + 0.05, z);
    const before = await body();
    check(`(standing ${where} first: ${floor}m)`, Math.abs(before.y - floor) < 0.06, JSON.stringify(before));
    await lieDown();
    const lying = await body();
    check(`lying ${where}, the body knows the floor it lies on`, lying.floor != null && Math.abs(lying.floor - floor) < 0.02, JSON.stringify(lying));
    await evalJson(`(async () => { (await import('/lib/localbody.js')).getUp(); })()`);
    await sleep(1200);                                   // the controller runs on from there
    const stood = await body();
    check(`getting up ${where}: on that floor (${floor}m), and still there a second later`,
      !stood.downed && Math.abs(stood.y - floor) < 0.06, JSON.stringify(stood));
  }

  {
    await standAt(-2.2, UPPER + 0.05, 0);
    await sleep(800);
    await cdp.send('Page.navigate', { url: page });
    await until(ready, 'the reloaded page (standing)', 180_000);
    await sleep(1500);
    const stood = await body();
    check('reloading while standing upstairs wakes upstairs (3.3m) — held until the house is solid, not dropped to the ground floor', Math.abs(stood.y - UPPER) < 0.06, JSON.stringify(stood));
  }
  // rejoin while lying on the stair landing: the server remembers the body
  // standing on the floor it lay on; the reload wakes there — not at its
  // root, which lies inside the solid stair, over a metre below the landing
  await standAt(2.8, LANDING + 0.05, -2.3);
  await lieDown();
  const lay = await body();
  await sleep(600);                                      // presence (with `floor`) has gone out
  await cdp.send('Page.navigate', { url: page });
  await until(ready, 'the reloaded page', 180_000);
  await sleep(1500);
  const woke = await body();
  check('reloading while lying on the stair landing wakes standing on it (1.8m), not inside the stair',
    !woke.downed && Math.abs(woke.y - LANDING) < 0.06, `lay with its root at ${lay.y.toFixed(2)}; woke ${JSON.stringify(woke)}`);
} catch (e) {
  process.exitCode = 1; throw e;
} finally {
  dws.close();
  await cleanup(tally.failed || process.exitCode ? 1 : 0);
}
console.log(`${tally.passed} passed, ${tally.failed} failed`);
process.exit(tally.failed ? 1 : 0);
