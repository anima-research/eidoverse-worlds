// foliage-door-test — one viewer changes their meadow; prove nothing shared moved.
//
// The claim this file exists to check is a PRODUCT claim, not a code one: that
// `/foliage off` is a setting about your own eyes and not an edit to the world.
// A unit test on the dial cannot establish that — the dial could be perfect and
// some caller could still emit a verb. So this stands two real viewers in one
// real world, moves one of their dials through the real command path, and then
// asks the world and the other viewer whether anything happened to them.
//
// Three sources of truth are checked, because a weaker one alone would pass a
// broken build:
//   · the WORLD LOG on disk — the world IS its log; if the log did not grow,
//     nothing was authored. This is the load-bearing one.
//   · the OTHER VIEWER's rendered meadow — blades drawn, applied density, wind
//     amplitudes, hook array, localStorage — read from their page, not inferred.
//   · the ACTING viewer's own meadow, which MUST change. A test where nobody's
//     view moved would pass while proving nothing.
//
// Two separate browser CONTEXTS, not two tabs: localStorage is per origin, and
// two tabs of one profile share the resident's dial by design. Isolating them
// is what makes them two people rather than one person twice.
//
// RUNTIME AND LIFECYCLE (#151 review). The first version used the global
// `WebSocket`, which arrived in node 22 — on the reviewer's node 20.20.2 it
// died with `ReferenceError: WebSocket is not defined` AFTER spawning the
// sequencer and BEFORE reaching its try/finally, leaving a bun process
// listening on :9471 to be killed by hand. Both halves are fixed here: the
// WebSocket is resolved portably, and everything spawned is registered with one
// idempotent Lifecycle the moment it exists, bound to the process so a throw, a
// signal or an unhandled rejection all unwind through the same owner. The child
// is PROVEN ours by nonce echo rather than assumed from a 200.
//
//   node tools/foliage-door-test.mjs
//   node tools/foliage-door-test.mjs --keep-open
//   node tools/foliage-door-test.mjs --fault=post-server   # by-hand leak check
//
// 🔴 node, not bun — Playwright's launch hangs under bun on Windows.

import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';
import {
  Lifecycle, ownedWorld, proveOurs, portIsOpen, resolveWebSocket, NODE_MIN_GLOBAL_WS,
} from './owned-lifecycle.mjs';

const argv = Object.fromEntries(process.argv.slice(2)
  .filter((a) => a.startsWith('--'))
  .map((a) => { const i = a.indexOf('='); return i < 0 ? [a.slice(2), 'true'] : [a.slice(2, i), a.slice(i + 1)]; }));

const FAULT = argv.fault ?? null;
const WORLD = `foliagedoor${Math.random().toString(36).slice(2, 7)}`;

let failures = 0;
const check = (label, ok, detail) => {
  console.log(ok ? `  \x1b[32m✓\x1b[0m ${label}` : `  \x1b[31m✗ ${label}${detail ? ` — ${detail}` : ''}\x1b[0m`);
  if (!ok) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ============================================================================
// CONTROLS — mutations of this harness's own contract, run FIRST. A product
// receipt from a harness that cannot fail is not a receipt.
// ============================================================================

console.log('\n--- harness controls -------------------------------------------------');

// ---- control 1: the runtime contract ---------------------------------------
console.log('\nthe WebSocket contract, on this node and on node 20');
let WS;
{
  const resolved = await resolveWebSocket();
  WS = resolved.WebSocket;
  check(`a WebSocket resolves here — ${resolved.source}`, typeof WS === 'function');

  // MUTATION: take the global away, which is exactly node 20's situation, and
  // prove the fallback carries the door test rather than a ReferenceError.
  const realGlobal = globalThis.WebSocket;
  try {
    delete globalThis.WebSocket;
    const fallback = await resolveWebSocket();
    check(`with no global WebSocket (node < ${NODE_MIN_GLOBAL_WS}) it falls back to the ws package`,
      typeof fallback.WebSocket === 'function' && /ws package/.test(fallback.source), fallback.source);
  } catch (e) {
    check(`with no global WebSocket (node < ${NODE_MIN_GLOBAL_WS}) it falls back to the ws package`,
      false, String(e.message ?? e).slice(0, 200));
  } finally {
    if (realGlobal) globalThis.WebSocket = realGlobal;
  }

  // …and that THIS file uses the resolved constructor. A reintroduced bare
  // `new WebSocket(...)` would pass on node 22 and fail on the house's node 20,
  // which is precisely the defect being fixed.
  // Comments are stripped first: the paragraph above NAMES the construct it
  // forbids, and the first version of this check convicted its own prose.
  const self = readFileSync(new URL(import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
  const bareGlobalUse = /(?<![.\w])new\s+WebSocket\s*\(/.test(self);
  check('this file never reaches for the bare global WebSocket', !bareGlobalUse,
    'use the constructor from resolveWebSocket(), not the global');
}

// ---- control 2: an impostor cannot pass for our child -----------------------
console.log('\nownership is proven, not inferred from a 200');
{
  const impostorLife = new Lifecycle({ bindSignals: false });
  const healthyPort = 8899, wrongPort = 8898;
  try {
    const squatter = createServer((req, res) => {
      if (req.url.startsWith('/version')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end('{"sha":"deadbee","dirty":false}');   // healthy, and not ours
      }
      res.writeHead(200); res.end('ok');
    });
    await new Promise((r) => squatter.listen(healthyPort, '127.0.0.1', r));
    impostorLife.own('impostor', () => new Promise((r) => squatter.close(r)));

    const generic = await fetch(`http://127.0.0.1:${healthyPort}/`).then((r) => r.ok).catch(() => false);
    check('the impostor answers 200 — generic HTTP readiness would accept it', generic);

    const noNonce = await proveOurs(`http://127.0.0.1:${healthyPort}`, 'our-nonce', { tries: 2, gapMs: 50 });
    check('…but the nonce proof refuses it', !noNonce.ours && /no nonce field/.test(noNonce.reason), noNonce.reason);

    const wrong = createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"nonce":"somebody-elses"}');
    });
    await new Promise((r) => wrong.listen(wrongPort, '127.0.0.1', r));
    impostorLife.own('wrong-nonce', () => new Promise((r) => wrong.close(r)));
    const mismatch = await proveOurs(`http://127.0.0.1:${wrongPort}`, 'our-nonce', { tries: 2, gapMs: 50 });
    check("…and refuses a listener echoing somebody else's nonce",
      !mismatch.ours && /wrong nonce/.test(mismatch.reason), mismatch.reason);
  } finally {
    await impostorLife.dispose('impostor control');
  }
  check('the control cleaned up after itself', !(await portIsOpen(healthyPort)));
}

// ---- control 3: a pre-viewer failure leaks nothing --------------------------
console.log('\na failure before the viewers exist leaks no child');
{
  const life3 = new Lifecycle({ bindSignals: false });
  let port = null, pid = null;
  try {
    const w = await ownedWorld(life3, { key: 'control' });
    port = w.port; pid = w.childPid;
    check(`a child came up and PROVED it is ours (:${port}, pid ${pid})`, !!w.origin);
    check('…and the port really is listening', await portIsOpen(port));
    // the exact shape of the reported leak: a throw after the spawn, before
    // anything the old code had inside a try
    throw new Error('injected pre-viewer failure');
  } catch (e) {
    check('the injected failure propagated',
      /injected pre-viewer failure/.test(String(e.message ?? e)), String(e.message ?? e).slice(0, 140));
  } finally {
    await life3.dispose('control 3');
  }
  await sleep(700);
  check('…and the child is gone: nothing listens on that port',
    port !== null && !(await portIsOpen(port)), `:${port} still answers`);
  const second = await new Lifecycle({ bindSignals: false }).dispose();
  check('…and dispose is idempotent (a second call is a no-op)', Array.isArray(second) && second.length === 0);
}

if (FAULT === 'post-server') {
  console.log('\n--fault=post-server: failing deliberately after the child is up');
  const lifeF = new Lifecycle();
  const w = await ownedWorld(lifeF, { key: 'fault' });
  console.log(`  child on :${w.port} pid ${w.childPid} — throwing now; nothing should survive it`);
  try { throw new Error('deliberate --fault=post-server'); } finally { await lifeF.dispose('fault'); }
}

// ============================================================================
// THE PRODUCT DOOR
// ============================================================================

console.log('\n--- the product door -------------------------------------------------');

const life = new Lifecycle();
let world = null;

try {
  world = await ownedWorld(life, { key: 'door-test' });
  console.log(`\nfoliage door test — world "${WORLD}" on :${world.port}, proven ours by nonce\n`);

  const logPath = () => join(world.worldsDir, WORLD, 'log.jsonl');
  const logEntries = () => (existsSync(logPath())
    ? readFileSync(logPath(), 'utf8').split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean)
    : []);

  // ---- plant a meadow, as its owner ----------------------------------------
  {
    const ws = new WS(`ws://127.0.0.1:${world.port}/ws`);
    life.own('seed socket', () => { try { ws.close(); } catch { /* already closed */ } });
    const msgs = [];
    ws.onmessage = (ev) => { try { msgs.push(JSON.parse(String(ev.data))); } catch { /* not ours */ } };
    await new Promise((res, rej) => {
      ws.onopen = res;
      ws.onerror = (e) => rej(new Error(`seed socket failed: ${String(e?.message ?? e)}`));
    });
    ws.send(JSON.stringify({ type: 'join', token: world.key, name: 'planter', world: WORLD }));
    for (let i = 0; i < 80 && !msgs.some((m) => m.type === 'snapshot'); i++) await sleep(100);
    if (!msgs.some((m) => m.type === 'snapshot')) throw new Error('the seed socket never received a snapshot');
    ws.send(JSON.stringify({ type: 'verb', verb: 'grass',
      args: { species: 'grass', width: 60, depth: 60, center: [0, 0], density: 1, height: 0.42, wind: 1 } }));
    await sleep(1500);
    const refused = msgs.filter((m) => m.type === 'error');
    if (refused.length) console.log('  ⚠ seed refusals:', JSON.stringify(refused.slice(0, 2)));
    ws.close();
  }

  if (FAULT === 'pre-viewer') throw new Error('deliberate --fault=pre-viewer (seeded, no browser yet)');

  // ---- two viewers, two profiles -------------------------------------------
  const browser = await chromium.launch({ headless: false, channel: argv.browser ?? 'chrome', timeout: 90_000 });
  life.own('browser', () => browser.close());

  const PLANTED = async () => {
    const t = await import('/lib/terrain.js');
    if (!t.hasGrass()) return false;
    return (t.grassTiles().strokes ?? []).reduce((n, s) => n + (s.drawn ?? 0), 0) > 0;
  };
  // page.waitForFunction with an ASYNC predicate resolves immediately (the
  // dynamic import a terrain probe needs makes the predicate a promise), so
  // both viewers once baselined at zero blades. Poll from this side instead.
  const until = async (page, fn, label, ms = 180_000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) { if (await page.evaluate(fn)) return true; await sleep(500); }
    throw new Error(`timed out waiting for ${label}`);
  };
  async function viewer(nm) {
    const ctx = await browser.newContext({ viewport: { width: 900, height: 640 } });
    life.own(`viewer ${nm}`, () => ctx.close());
    const page = await ctx.newPage();
    await page.goto(`${world.origin}/?name=${nm}&world=${WORLD}&key=${world.key}`,
      { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await until(page, () => (globalThis.EW?.renderer?.info?.render?.triangles ?? 0) > 0, `${nm} to draw`);
    await until(page, PLANTED, `${nm}'s meadow to plant`);
    await sleep(1500);
    return { name: nm, ctx, page };
  }

  // Reads defensively: on a build without the motion dial this must produce
  // NAMED failures, not a stack trace.
  const meadow = (v) => v.page.evaluate(async () => {
    const t = await import('/lib/terrain.js');
    const { autoHooks } = await import('/lib/autohooks.js');
    const call = (n, fb = null) => { try { return t[n]?.() ?? fb; } catch { return fb; } };
    const field = t.getGrassField();
    const strokes = t.grassTiles().strokes ?? [];
    return {
      quality: call('getGrassQuality'), motion: call('getGrassMotion'), preset: call('getFoliagePreset'),
      animates: call('grassAnimates'), density: call('getGrassDensity'),
      applied: call('getGrassApplied')?.status ?? null,
      surface: ['getGrassMotion', 'setGrassMotion', 'setFoliagePreset', 'getFoliagePreset', 'grassAnimates']
        .filter((n) => typeof t[n] === 'function'),
      visible: !!field?.mesh?.visible,
      blades: field?.mesh?.visible ? strokes.reduce((n, s) => n + (s.drawn ?? 0), 0) : 0,
      wind: (field?._strokes ?? []).map((st) => [st.uniforms?.base?.value ?? null, st.uniforms?.gust?.value ?? null]),
      // the exact contents AND ORDER of the shared per-frame hook array
      hookOrder: autoHooks().map((fn) => fn.name || 'anon'),
      hookCount: autoHooks().length,
      storage: { quality: localStorage.getItem('ew-grass-quality'), motion: localStorage.getItem('ew-grass-motion') },
    };
  });

  const say = (v, text) => v.page.evaluate(async (t) => {
    const chat = await import('/lib/chat.js');
    const fn = chat.handleCommand ?? chat.runCommand ?? chat.tryCommand ?? null;
    if (fn) return { via: 'chat', handled: fn(t) };
    const { bus } = await import('/lib/core.js');
    const [cmd, ...rest] = t.replace(/^\//, '').split(/\s+/);
    bus.emit('command', { cmd, arg: rest.join(' ') });
    return { via: 'bus', handled: true };
  }, text);

  const A = await viewer('ash');
  const B = await viewer('brook');
  console.log('two viewers standing in one meadow\n');

  const chatSrc = await (await fetch(`${world.origin}/lib/chat.js`)).text();
  check('chat.js routes a typed /foliage to the handler', /case 'foliage'/.test(chatSrc));
  check('…and /grass as its alias', /case 'grass'/.test(chatSrc));

  const logBefore = logEntries();
  const bBefore = await meadow(B);
  const aBefore = await meadow(A);
  check('this build has the local motion dial at all', aBefore.surface.length === 5, JSON.stringify(aBefore.surface));
  check('both viewers start from the same meadow',
    aBefore.blades > 0 && aBefore.blades === bBefore.blades, `${aBefore.blades} vs ${bBefore.blades}`);
  check('both start animating', aBefore.animates && bBefore.animates);

  // ---- 1. off ---------------------------------------------------------------
  console.log('\nash types /foliage off');
  const r1 = await say(A, '/foliage off');
  await sleep(800);
  const a1 = await meadow(A), b1 = await meadow(B);
  const log1 = logEntries();

  check(`the command reached a handler (via ${r1.via})`, r1.handled !== false);
  check("ASH's meadow went dark", a1.blades === 0 && !a1.visible,
    JSON.stringify({ blades: a1.blades, visible: a1.visible }));
  check("BROOK's meadow is untouched", b1.blades === bBefore.blades && b1.visible,
    `${bBefore.blades} → ${b1.blades}`);
  check("BROOK's dials never moved", b1.quality === bBefore.quality && b1.motion === bBefore.motion,
    `${bBefore.quality}/${bBefore.motion} → ${b1.quality}/${b1.motion}`);
  check('the WORLD LOG did not grow', log1.length === logBefore.length,
    `${logBefore.length} → ${log1.length}: ${JSON.stringify(log1.slice(logBefore.length).map((e) => e.verb))}`);
  check('no grass verb was authored',
    log1.filter((e) => e.verb === 'grass').length === logBefore.filter((e) => e.verb === 'grass').length);
  check("BROOK's browser storage is untouched",
    JSON.stringify(b1.storage) === JSON.stringify(bBefore.storage), JSON.stringify(b1.storage));

  // ---- 2. static ------------------------------------------------------------
  console.log('\nash types /foliage static');
  await say(A, '/foliage static');
  await sleep(800);
  const a2 = await meadow(A), b2 = await meadow(B);
  const log2 = logEntries();

  check('ASH sees the meadow again', a2.blades > 0 && a2.visible, `${a2.blades} blades`);
  check('…and it is STILL: wind amplitude zeroed',
    a2.wind.length > 0 && a2.wind.every(([b, g]) => b === 0 && g === 0), JSON.stringify(a2.wind));
  check('…and it reads as the static preset', a2.preset === 'static' && a2.animates === false,
    `${a2.preset}/${a2.animates}`);
  check("BROOK's wind is still blowing",
    b2.wind.length > 0 && b2.wind.some(([b, g]) => b > 0 || g > 0), JSON.stringify(b2.wind));
  check("BROOK's meadow is still untouched", b2.blades === bBefore.blades && b2.animates);
  check("…and BROOK's hook array was never touched",
    JSON.stringify(b2.hookOrder) === JSON.stringify(bBefore.hookOrder),
    `${JSON.stringify(bBefore.hookOrder)} → ${JSON.stringify(b2.hookOrder)}`);
  check('the WORLD LOG still did not grow', log2.length === logBefore.length,
    `${logBefore.length} → ${log2.length}`);

  // ---- 3. back to full ------------------------------------------------------
  console.log('\nash types /foliage full');
  await say(A, '/foliage full');
  await sleep(800);
  const a3 = await meadow(A), b3 = await meadow(B);
  const log3 = logEntries();

  check('ASH is restored exactly', a3.blades === aBefore.blades && a3.animates && a3.preset === 'full',
    JSON.stringify({ blades: a3.blades, was: aBefore.blades, preset: a3.preset }));
  check('…including the wind amplitudes it borrowed',
    JSON.stringify(a3.wind) === JSON.stringify(aBefore.wind), JSON.stringify(a3.wind));
  check("BROOK never noticed any of it", b3.blades === bBefore.blades && b3.animates
    && b3.quality === bBefore.quality && b3.motion === bBefore.motion);
  check('the world log is byte-identical from first to last',
    JSON.stringify(log3) === JSON.stringify(logBefore), `${logBefore.length} → ${log3.length}`);

  // ---- 4. hook ORDER, with a neighbour on each side ------------------------
  //
  // The meadow's hooks sit among other people's, and the engine drains the
  // array in order. Restoring by appending passes a membership check and still
  // hands the array back rearranged, so the claim "restored as found" needs a
  // test that can see order. Sentinels go in front of and behind the meadow's
  // own hooks, and the whole sequence must come back identical (#151 review).
  console.log('\nwith neighbours on both sides of the meadow in the hook array');
  {
    const planted = await A.page.evaluate(async () => {
      const { autoHooks } = await import('/lib/autohooks.js');
      const before = function sentinelBefore() {}; const after = function sentinelAfter() {};
      globalThis.__sB = before; globalThis.__sA = after;
      autoHooks().unshift(before);
      autoHooks().push(after);
      return autoHooks().map((f) => f.name || 'anon');
    });
    await say(A, '/foliage static');
    await sleep(700);
    const during = await meadow(A);
    await say(A, '/foliage full');
    await sleep(700);
    const after4 = await meadow(A);
    check('the meadow hooks really left the array during static',
      during.hookCount < planted.length, `${planted.length} → ${during.hookCount}`);
    check('…and the whole array came back in exactly the order it was found',
      JSON.stringify(after4.hookOrder) === JSON.stringify(planted),
      `${JSON.stringify(planted)} → ${JSON.stringify(after4.hookOrder)}`);
    check('…with the neighbours still on their original sides',
      after4.hookOrder[0] === 'sentinelBefore'
      && after4.hookOrder[after4.hookOrder.length - 1] === 'sentinelAfter',
      JSON.stringify(after4.hookOrder));
    await A.page.evaluate(async () => {
      const { releaseHook } = await import('/lib/autohooks.js');
      releaseHook(globalThis.__sB); releaseHook(globalThis.__sA);
    });
  }

  // ---- 5. the setting is the viewer's, and it stays -------------------------
  console.log('\nash sets /foliage static and reloads');
  await say(A, '/foliage static');
  await sleep(500);
  await A.page.reload({ waitUntil: 'domcontentloaded' });
  await until(A.page, PLANTED, "ash's meadow to re-plant");
  await sleep(2500);
  const a5 = await meadow(A), b5 = await meadow(B);
  check('ASH gets their own meadow back the way they left it',
    a5.preset === 'static' && a5.animates === false, `${a5.preset}/${a5.animates}`);
  check('a fresh field inherits the choice (sticky across the re-grow)',
    a5.wind.length > 0 && a5.wind.every(([b, g]) => b === 0 && g === 0), JSON.stringify(a5.wind));
  check("BROOK's meadow, still, is the one its author planted", b5.blades === bBefore.blades && b5.animates);
  check('and the world log STILL did not grow', logEntries().length === logBefore.length);
} finally {
  if (argv['keep-open'] === 'true') {
    console.log('[door-test] --keep-open: the world and browser are still up; ctrl-c releases them');
  } else {
    await life.dispose('end of run');
    if (world) {
      await sleep(500);
      check('the harness left nothing listening behind it', !(await portIsOpen(world.port)),
        `something still answers on :${world.port}`);
    }
  }
}

console.log(failures
  ? `\n\x1b[31m${failures} failed\x1b[0m — a viewer's choice reached something it should not have\n`
  : '\n\x1b[32mall green — one viewer changed their eyes, and the world did not notice\x1b[0m\n');
process.exit(failures ? 1 : 0);
