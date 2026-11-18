// getting up and rejoining after going limp, in a real browser: the body
// stands on the floor it lay on — a stair landing, an upper floor — through
// the shipping call sites (localbody.js getUp; a reload's restore through the
// server's settledPose and main.js), not at height 0 and not at its root,
// which lies below that floor.
//   bun test/client/getup-browser-probe.ts [--headed]
// The helper half: test/client/getup-floor-test.ts.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildGlb } from '../fixtures/two-storey-fixture.ts';
import { scratchBench, mkCheck, sleep, legacyVerb, sceneId } from '../harness/harness.ts';
import { helloOf } from '../../shared/protocol/hello.js';
import { capsule } from '../../shared/mover.js';

const OPT = mkdtempSync(join(tmpdir(), 'getup-opt-'));
// joining never founds a world: the bench founds it, owned by the driver's typed name (TRUST_NAMES)
const WORLD = `getup-${crypto.randomUUID().slice(0, 8)}`;
const { PORT, BASE, cdp, cws: cws0, evalJson, cleanup, die } = await scratchBench('getup', {
  headed: process.argv.includes('--headed'), portFrom: 9460, worlds: [WORLD], owner: 'builder',
  serverEnv: { OPT_DIR: OPT, SKIP_OPT_SWEEP: '1', TRUST_NAMES: '1' },
});
const { check, tally } = mkCheck();
const restores: any[] = [];
(await import('../harness/harness.ts'));

async function until(f: () => any, label: string, timeout = 60_000) {
  const start = Date.now();
  while (!await f()) { if (Date.now() - start > timeout) await die(1, `timed out: ${label}`); await sleep(150); }
}

// an 8×8m house, walls 7m: ground floor 0.3, a solid stair landing (2×3m,
// 1.8m up) in one corner, an upper floor at 3.3 over the west half, and a
// solid dais 3m up in the south-east corner, big enough for a 2× body
// (3.6m square, walled on two sides) to fall and stay on
const FLOOR = 0.3, LANDING = 1.8, UPPER = 3.3, DAIS = 3.0;
const boxes = [
  [-4, 0, -4, 4, FLOOR, 4],
  [-4, FLOOR, -4, -3.8, 7, 4], [3.8, FLOOR, -4, 4, 7, 4], [-4, FLOOR, -4, 4, 7, -3.8], [-4, FLOOR, 3.8, 4, 7, 4],
  [1.8, 0, -3.8, 3.8, LANDING, -0.8],
  [-3.8, 3.1, -3.8, -0.5, UPPER, 3.8],
  [0.2, 0, 0.2, 3.8, DAIS, 3.8],
];
const msgs: any[] = [];
const dws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
dws.onmessage = (ev) => msgs.push(JSON.parse(String(ev.data)));
await new Promise((r, j) => { dws.onopen = r as any; dws.onerror = j as any; });
dws.send(JSON.stringify({ type: 'join', hello: helloOf(), world: WORLD, id: 'builder', token: '', replica: true }));
await until(() => msgs.some((m) => m.type === 'snapshot'), 'driver join');
// every world write is a door request, answered by its reply; the scene is authored in the old words
// through the harness's adapter (legacyVerb), which maps the scene's name for the house to the id the authority mints
let reqN = 0;
const driver: any = {
  async request(v: string, args: unknown) {
    const id = `getup-${++reqN}`;
    dws.send(JSON.stringify({ type: 'request', id, verb: v, args }));
    await until(() => msgs.some((m) => m.type === 'reply' && m.id === id), `${v} reply`, 10_000);
    const r = msgs.find((m) => m.type === 'reply' && m.id === id);
    if (!r.ok) await die(1, `${v} refused: ${JSON.stringify(r.reply?.refused ?? r)}`);
    return r.reply;
  },
};
const verb = (v: string, args: unknown) => v === 'terrain'
  ? driver.request('set', { id: '@world', component: 'terrain', value: args })
  : legacyVerb(driver, v, args);
/** The id the authority minted for the house. */
const HOUSE = () => sceneId(driver, 'house');

const page = `${BASE}/?name=lier&world=${WORLD}`;
// what the page tells the server about a lying body: the floor must have gone
// out before a reload can be expected to wake on it (a headless page renders
// slowly, so a fixed wait isn't a receipt)
let sentFloor: number | null = null;
let sentRoot: number | null = null;   // the root height a pose carrying that floor said
let sentBare = 0;   // lying poses sent without a floor
let lastRestore: unknown = null;
cws0.addEventListener('message', (ev) => {
  const m = JSON.parse(String(ev.data));
  if (m.method === 'Network.webSocketFrameReceived' && m.params.response.payloadData.includes('"restore"')) {
    try { lastRestore = JSON.parse(m.params.response.payloadData).restore ?? null; } catch { /* not json */ }
  }
  if (m.method !== 'Network.webSocketFrameSent' || !m.params.response.payloadData.includes('"ragdoll"')) return;
  try {
    const p = JSON.parse(m.params.response.payloadData).pose;
    if (p?.clip === 'ragdoll') { if (Number.isFinite(p.floor)) { sentFloor = p.floor; sentRoot = p.p?.[1] ?? null; } else sentBare++; }
  } catch { /* not a pose */ }
});
// a slow connection: while `slowModels`, the house's model download is held
// back until the test lets it through — after it has watched the reloaded body
// stand held without it, however long the page took to bring its avatar in
let slowModels = false;
let heldBack: string[] = [];
cws0.addEventListener('message', (ev) => {
  const m = JSON.parse(String(ev.data));
  if (m.method !== 'Fetch.requestPaused') return;
  if (slowModels) heldBack.push(m.params.requestId);
  else cdp.send('Fetch.continueRequest', { requestId: m.params.requestId }).catch(() => {});
});
/** Let the held-back house through. A request the page abandoned (a reload
 *  while it was held) is gone by now: fine. */
function letModelsThrough() {
  for (const requestId of heldBack.splice(0)) cdp.send('Fetch.continueRequest', { requestId }).catch(() => {});
}
await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*store/*.glb*' }] });
async function floorSent(floor: number) {
  await until(() => sentFloor != null && Math.abs(sentFloor - floor) < 0.02, `presence carrying floor ${floor}`, 30_000);
  await sleep(300);
}
/** The page is up, its body exists, and the house's collider is fitted. */
const ready = () => evalJson(`(async () => {
  if (!globalThis.EW) return false;
  const [{ getMe }, C] = await Promise.all([import('/lib/player/mybody.js'), import('/lib/colliders.js')]);
  return !!getMe() && [...C.nearColliders(0, 0, 8)].some(([id]) => id === ${JSON.stringify(HOUSE())});
})()`).catch(() => false);
/** The reloaded page's body is up and its house isn't fitted yet: only the
 *  new page has a body and no house (the old one had the house). */
const bodyUp = () => evalJson(`(async () => {
  if (!globalThis.EW) return false;
  const [{ getMe }, C] = await Promise.all([import('/lib/player/mybody.js'), import('/lib/colliders.js')]);
  return !!getMe() && ![...C.nearColliders(0, 0, 8)].some(([id]) => id === ${JSON.stringify(HOUSE())});
})()`).catch(() => false);
/** Wait until the page's frame loop has stepped `s` seconds of simulated time:
 *  the dt its systems step by, the controller's gravity among them, however
 *  slowly the page runs. */
async function simWait(s: number) {
  const t0 = await evalJson(`(async () => {
    if (globalThis.__simT == null) {
      globalThis.__simT = 0;
      (await import('/lib/render/frameloop.js')).registerSystem('test-sim-clock', (dt) => { globalThis.__simT += dt; });
    }
    return globalThis.__simT;
  })()`);
  await until(async () => (await evalJson('globalThis.__simT')) >= t0 + s, `${s}s of the page's frames`, 120_000);
}
/** Wait up to `ms` for `f`, and say whether it came. */
async function waitFor(f: () => any, ms: number) {
  const start = Date.now();
  while (!await f()) { if (Date.now() - start > ms) return false; await sleep(150); }
  return true;
}
const body = () => evalJson(`(async () => {
  const [{ myState }, L] = await Promise.all([import('/lib/player/controller.js'), import('/lib/player/localbody.js')]);
  return { y: myState.pos.y, x: myState.pos.x, z: myState.pos.z, clip: myState.clip, downed: L.isDowned(), settling: !!L.activeRagdoll(), floor: myState.floor?.y ?? null };
})()`);
/** A reload, watched through the arrival hold: the new page's body is up and
 *  stepped while its house is still held back — and stays at the height it was
 *  restored at, not dropped to the ground floor — then the house is let
 *  through, and once it is solid the hold lets go: a body lifted off its floor
 *  falls back onto it. */
async function reloadThroughHold(label: string, floor: number) {
  heldBack = [];
  await cdp.send('Page.navigate', { url: page });
  await until(bodyUp, `the reloaded page's body (${label}), its house held back`, 300_000);
  await simWait(1.5);                                    // long enough to fall from any floor here, were it not held
  const held = await body();
  const houseStill = await bodyUp();
  check(`(${label}: the house's download was held back while the body stood)`, heldBack.length > 0 && houseStill === true,
    `held requests ${heldBack.length}; house still unfitted: ${houseStill}`);
  check(`${label}: held at its restored height (${floor}m) while the house was still on its way`,
    Math.abs(held.y - floor) < 0.06, JSON.stringify(held));
  letModelsThrough();
  await until(ready, `the reloaded page's house (${label})`, 300_000);
  await simWait(1.0);
  const woke = await body();
  await evalJson(`(async () => { const { myState } = await import('/lib/player/controller.js'); myState.pos.y += 0.5; })()`);
  await simWait(1.0);
  const fell = await body();
  check(`${label}: once the house is solid the hold lets go — lifted half a metre, it falls back onto ${floor}m`,
    Math.abs(fell.y - floor) < 0.06, JSON.stringify(fell));
  return woke;
}
async function standAt(x: number, y: number, z: number) {
  await evalJson(`(async () => { const { myState } = await import('/lib/player/controller.js'); myState.pos.set(${x}, ${y}, ${z}); })()`);
  await sleep(800);
}
/** The controller's step-up at a body's size (colliders.js resolveColliders: the mover's step, grown with the body). */
const stepUp = (u: number) => capsule(u).step;
/** A settled heap's root lies only about 0.9 of a step-up below its floor, at any size, so a wake at the root would be
 *  stepped back onto the floor and hide a lost settledPose rewrite. Placed, not settled: the lying root is put `below`
 *  under the floor the body measured, and the measurement re-stamped there (net.js sends it only while the root is where
 *  it was measured). Then waits until a pose with that root and floor has gone out. */
async function sinkRoot(below: number) {
  sentFloor = null; sentRoot = null;
  const at = await evalJson(`(async () => { const { myState } = await import('/lib/player/controller.js');
    myState.pos.y = myState.floor.y - ${below}; myState.floor = { y: myState.floor.y, root: myState.pos.toArray() };
    return myState.pos.y; })()`);
  await until(() => sentRoot != null && Math.abs(sentRoot - at) < 1e-6, `a pose carrying the placed root ${at.toFixed(2)}`, 30_000);
  return { root: sentRoot as number, floor: sentFloor as number };
}
async function lieDown() {
  sentFloor = null;
  await evalJson(`(async () => { (await import('/lib/player/localbody.js')).goLimp(); })()`);
  await until(async () => { const b = await body(); return b.downed && !b.settling; }, 'the doll settles', 60_000);
}

try {
  const up = await (await fetch(`${BASE}/upload?name=house`, { method: 'POST', body: await buildGlb(boxes as any) })).json() as { path: string };
  await verb('terrain', { seed: 3, size: 80, segments: 32, amplitude: 0.0, flatRadius: 40 });
  await verb('spawn', { id: 'house', lib: up.path, pos: [0, 0, 0], yaw: 0, collide: 'mesh' });   // the protocol's word for the walker's exact (triangle) collider
  await cdp.send('Page.navigate', { url: page });
  await until(ready, 'the page, its body and the house', 300_000);   // a headless page loads its avatar slowly
  slowModels = true;                                     // every reload from here on: the house arrives late

  for (const [where, x, z, floor] of [['on the stair landing', 2.8, -2.3, LANDING], ['upstairs', -2.2, 0, UPPER]] as [string, number, number, number][]) {
    await standAt(x, floor + 0.05, z);
    const before = await body();
    check(`(standing ${where} first: ${floor}m)`, Math.abs(before.y - floor) < 0.06, JSON.stringify(before));
    await lieDown();
    const lying = await body();
    check(`lying ${where}, the body knows the floor it lies on`, lying.floor != null && Math.abs(lying.floor - floor) < 0.02, JSON.stringify(lying));
    // moved off the spot where it measured that floor (as a drag, a shove or
    // an unpin moves it), it stops sending it, and sends it again once back
    await floorSent(floor);
    const bare0 = sentBare;
    await evalJson(`(async () => { (await import('/lib/player/controller.js')).myState.pos.x += 0.5; })()`);
    const bareSent = await waitFor(() => sentBare > bare0, 10_000);
    await evalJson(`(async () => { (await import('/lib/player/controller.js')).myState.pos.x -= 0.5; })()`);
    sentFloor = null;
    const floorAgain = await waitFor(() => sentFloor != null && Math.abs(sentFloor - floor) < 0.02, 10_000);
    check(`lying ${where}, moved half a metre: its poses go out without that floor, and with it again once it is back`,
      bareSent && floorAgain, `poses without a floor while moved: ${sentBare - bare0}; with it again once back: ${floorAgain}`);
    await evalJson(`(async () => { (await import('/lib/player/localbody.js')).getUp(); })()`);
    await sleep(1200);                                   // the controller runs on from there
    const stood = await body();
    check(`getting up ${where}: on that floor (${floor}m), and still there a second later`,
      !stood.downed && Math.abs(stood.y - floor) < 0.06, JSON.stringify(stood));
  }

  {
    await standAt(-2.2, UPPER + 0.05, 0);
    await sleep(800);
    const stood = await reloadThroughHold('reloading while standing upstairs', UPPER);
    check('reloading while standing upstairs wakes upstairs (3.3m) — held until the house is solid, not dropped to the ground floor', Math.abs(stood.y - UPPER) < 0.06, JSON.stringify(stood));
  }
  // rejoin while lying on the stair landing: the server remembers the body
  // standing on the floor it lay on; the reload wakes there — not at its
  // root, placed inside the solid stair out of the step-up's reach (sinkRoot)
  await standAt(2.8, LANDING + 0.05, -2.3);
  await lieDown();
  const lay = await body();
  await floorSent(LANDING);
  const sunk = await sinkRoot(stepUp(1) + 0.4);
  check(`(lying on the stair landing, the pose it sends has its root more than a step-up (${stepUp(1)}m) below the landing)`,
    LANDING - sunk.root > stepUp(1) + 0.3 && Math.abs(sunk.floor - LANDING) < 0.02, `settled root ${lay.y.toFixed(2)}; sent root ${sunk.root.toFixed(2)}, floor ${sunk.floor}`);
  const woke = await reloadThroughHold('reloading while lying on the stair landing', LANDING);
  check('reloading while lying on the stair landing wakes standing on it (1.8m), not inside the stair',
    !woke.downed && Math.abs(woke.y - LANDING) < 0.06, `lay with its root at ${lay.y.toFixed(2)}; restored ${JSON.stringify((lastRestore as any)?.p)}; woke ${JSON.stringify(woke)}`);

  // ...and the same with a 2× body, whose size is remembered too. Its step-up
  // is twice as long (1.6m), and a settled heap lies within it, so its root is
  // placed past it (sinkRoot). The remembered floor (presence `floor` →
  // settledPose) wakes it on the dais; without that rewrite it wakes at its
  // root, out of the step-up's reach, and stays under the dais.
  // chosen as Profile › Avatar chooses it (mybody.js setMyBodyPref): saved for this body in this browser, so the
  // reloaded page wears it again, as a real reload does
  await evalJson(`(async () => { (await import('/lib/player/mybody.js')).setMyBodyPref({ scale: 2 }); })()`);
  await standAt(2.0, DAIS + 0.05, 0.8);
  await lieDown();
  const big = await body();
  check('(a 2× body lies on the dais and knows it)', big.floor != null && Math.abs(big.floor - DAIS) < 0.02, JSON.stringify(big));
  await floorSent(DAIS);
  const bigSunk = await sinkRoot(stepUp(2) + 0.4);
  check(`(a 2× body lying on the dais sends its root more than 1.2m, and more than its step-up (${stepUp(2)}m), below it)`,
    DAIS - bigSunk.root > Math.max(1.2, stepUp(2) + 0.3) && Math.abs(bigSunk.floor - DAIS) < 0.02,
    `settled root ${big.y.toFixed(2)} (${(DAIS - big.y).toFixed(2)}m under); sent root ${bigSunk.root.toFixed(2)} (${(DAIS - bigSunk.root).toFixed(2)}m under), floor ${bigSunk.floor}`);
  const bigWoke = await reloadThroughHold('reloading while a 2× body lies on the dais', DAIS);
  const bigScale = await evalJson(`(async () => (await import('/lib/player/mybody.js')).getMe()?.userScale ?? null)()`);
  check('reloading while a 2× body lies on the dais wakes it standing on the dais (3m), not inside or under it, still 2×',
    !bigWoke.downed && Math.abs(bigWoke.y - DAIS) < 0.06 && bigScale === 2, `lay with its root at ${big.y.toFixed(2)}; woke ${JSON.stringify(bigWoke)} at scale ${bigScale}`);

  // the bound: a hold that runs out lets go while the house is still on its
  // way, and says so once, naming what it was still waiting for
  await standAt(-2.2, UPPER + 0.05, 0);
  await sleep(800);
  heldBack = [];
  await cdp.send('Page.navigate', { url: page });
  await until(bodyUp, 'the reloaded page\'s body (the bound), its house held back', 300_000);
  await evalJson(`(async () => {
    globalThis.__warns = [];
    const warn = console.warn.bind(console);
    console.warn = (...a) => { globalThis.__warns.push(a.map(String).join(' ')); warn(...a); };
    (await import('/lib/arrivalhold.js')).holdHeightUntilSolid(10_000);
    globalThis.__armedAt = performance.now();
  })()`);
  // the hold's bound runs on the page's clock: sample it inside the bound by
  // that clock, and past it by that clock, whatever the frame rate
  const sampled = () => evalJson(`(async () => {
    const { myState } = await import('/lib/player/controller.js');
    return { y: myState.pos.y, elapsed: performance.now() - globalThis.__armedAt };
  })()`);
  await simWait(0.3);
  const inBound = await sampled();
  // past the bound: the hold says when it gives up (its clock starts at the
  // first frame it steps, a little after it was armed), then the body falls
  await waitFor(async () => (await evalJson(`globalThis.__warns.some((w) => w.startsWith('[arrivalhold] gave up'))`)) === true, 60_000);
  await simWait(1.5);                                    // long enough to fall from the upper floor
  const gaveUp = await sampled();
  const warns: string[] = await evalJson(`globalThis.__warns.filter((w) => w.startsWith('[arrivalhold] gave up'))`);
  check('a hold that runs out of its bound lets go while the house is still on its way, and says so once, naming it',
    inBound.elapsed < 10_000 && Math.abs(inBound.y - UPPER) < 0.06 && gaveUp.y < UPPER - 1
      && warns.length === 1 && warns[0].includes('after 10s') && warns[0].includes(HOUSE()),
    `inside the bound ${JSON.stringify(inBound)}; after it ${JSON.stringify(gaveUp)}; warnings ${JSON.stringify(warns)}`);
  letModelsThrough();
} catch (e) {
  process.exitCode = 1; throw e;
} finally {
  dws.close();
  await cleanup(tally.failed || process.exitCode ? 1 : 0);
}
console.log(`${tally.passed} passed, ${tally.failed} failed`);
process.exit(tally.failed ? 1 : 0);
