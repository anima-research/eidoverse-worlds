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
//   · the OTHER VIEWER's rendered meadow — blades drawn, applied density,
//     motion — read from their page, not inferred.
//   · the ACTING viewer's own meadow, which MUST change. A test where nobody's
//     view moved would pass while proving nothing.
//
// Two separate browser CONTEXTS, not two tabs: localStorage is per origin, and
// two tabs of one profile share the resident's dial by design. Isolating them
// is what makes them two people rather than one person twice.
//
// 🔴 node, not bun — Playwright's launch hangs under bun on Windows over
// --remote-debugging-pipe (see docs/browser-perf-receipt.md).
//
//   node tools/foliage-door-test.mjs
//   node tools/foliage-door-test.mjs --keep-open --browser=chrome

import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';

const argv = Object.fromEntries(process.argv.slice(2)
  .filter((a) => a.startsWith('--'))
  .map((a) => { const i = a.indexOf('='); return i < 0 ? [a.slice(2), 'true'] : [a.slice(2, i), a.slice(i + 1)]; }));

const BROWSER = argv.browser ?? 'chrome';
const KEY = 'door-test';
const WORLD = `foliagedoor${Math.random().toString(36).slice(2, 7)}`;
const PORT = 8990 + Math.floor(Math.random() * 500);
const WORLDS = mkdtempSync(join(tmpdir(), 'foliage-door-'));
const BUN = process.env.BUN_PATH || 'C:\\Users\\madal\\.bun\\bin\\bun.exe';
const EIDO = process.env.EIDOVERSE_DIR || join(process.cwd(), '..', 'eidoverse-video');

let failures = 0;
const check = (label, ok, detail) => {
  console.log(ok ? `  \x1b[32m✓\x1b[0m ${label}` : `  \x1b[31m✗ ${label}${detail ? ` — ${detail}` : ''}\x1b[0m`);
  if (!ok) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- a world this run owns --------------------------------------------------

console.log(`\nfoliage door test — world "${WORLD}" on :${PORT}, worlds dir ${WORLDS}\n`);
const srv = spawn(BUN, ['run', 'server/server.ts'], {
  env: { ...process.env, PORT: String(PORT), JOIN_TOKEN: KEY, WORLDS_DIR: WORLDS, EIDOVERSE_DIR: EIDO },
  stdio: ['ignore', 'pipe', 'pipe'],
});
const srvOut = [];
srv.stdout.on('data', (d) => srvOut.push(String(d)));
srv.stderr.on('data', (d) => srvOut.push(String(d)));

const origin = `http://127.0.0.1:${PORT}`;
for (let i = 0; i < 80; i++) {
  try { if ((await fetch(`${origin}/`)).ok) break; } catch { /* not up yet */ }
  await sleep(250);
}

/** The world's log on disk — the only authority on what was authored. */
const logPath = () => join(WORLDS, WORLD, 'log.jsonl');
const logEntries = () => (existsSync(logPath())
  ? readFileSync(logPath(), 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean)
  : []);

// ---- plant a meadow, as its owner ------------------------------------------

{
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  const msgs = [];
  ws.onmessage = (ev) => { try { msgs.push(JSON.parse(String(ev.data))); } catch { /* not ours */ } };
  await new Promise((r) => { ws.onopen = r; });
  ws.send(JSON.stringify({ type: 'join', token: KEY, name: 'planter', world: WORLD }));
  for (let i = 0; i < 60 && !msgs.some((m) => m.type === 'snapshot'); i++) await sleep(100);
  ws.send(JSON.stringify({ type: 'verb', verb: 'grass',
    args: { species: 'grass', width: 60, depth: 60, center: [0, 0], density: 1, height: 0.42, wind: 1 } }));
  await sleep(1200);
  const refused = msgs.filter((m) => m.type === 'error');
  if (refused.length) console.log('  ⚠ seed refusals:', JSON.stringify(refused.slice(0, 2)));
  ws.close();
}

// ---- two viewers, two profiles ---------------------------------------------

const browser = await chromium.launch({ headless: false, channel: BROWSER, timeout: 90_000 });
/** Poll from THIS side with page.evaluate.
 *
 *  page.waitForFunction with an ASYNC predicate resolved immediately here —
 *  the dynamic `import()` a terrain probe needs makes the predicate a promise,
 *  and the wait returned before a single blade was planted. Both viewers then
 *  baselined at zero and every later comparison was against nothing. Evaluate
 *  awaits properly; loop out here where the awaiting is not in doubt. */
async function until(page, fn, label, ms = 180_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await page.evaluate(fn)) return true;
    await sleep(500);
  }
  throw new Error(`timed out after ${Math.round(ms / 1000)}s waiting for ${label}`);
}

/** Is this page drawing a meadow yet? */
const PLANTED = async () => {
  const t = await import('/lib/terrain.js');
  if (!t.hasGrass()) return false;
  return (t.grassTiles().strokes ?? []).reduce((n, s) => n + (s.drawn ?? 0), 0) > 0;
};

/** A viewer is a CONTEXT: its own localStorage, so its own dial. */
async function viewer(name) {
  const ctx = await browser.newContext({ viewport: { width: 900, height: 640 } });
  const page = await ctx.newPage();
  await page.goto(`${origin}/?name=${name}&world=${WORLD}&key=${KEY}`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await until(page, () => (globalThis.EW?.renderer?.info?.render?.calls ?? 0) > 0, `${name} to draw`);
  // hasGrass() is true the moment the FIELD object exists; its tiles are
  // planted after that, and a baseline taken in the gap reads zero blades and
  // an empty stroke list.
  await until(page, PLANTED, `${name}'s meadow to plant`);
  await sleep(1500);
  return { name, ctx, page };
}

/** Everything about this viewer's meadow that a person could see. */
// Reads defensively: on a build without the motion dial this must produce
// NAMED failures, not a stack trace. A negative control that crashes proves
// only that it crashed.
const meadow = (v) => v.page.evaluate(async () => {
  const t = await import('/lib/terrain.js');
  const call = (name, fallback = null) => { try { return t[name]?.() ?? fallback; } catch { return fallback; } };
  const strokes = t.grassTiles().strokes ?? [];
  const field = t.getGrassField();
  return {
    quality: call('getGrassQuality'), motion: call('getGrassMotion'), preset: call('getFoliagePreset'),
    animates: call('grassAnimates'), density: call('getGrassDensity'),
    applied: call('getGrassApplied')?.status ?? null,
    // which of the dials this build even HAS — the control's first answer
    surface: ['getGrassMotion', 'setGrassMotion', 'setFoliagePreset', 'getFoliagePreset', 'grassAnimates']
      .filter((n) => typeof t[n] === 'function'),
    visible: !!field?.mesh?.visible,
    blades: field?.mesh?.visible ? strokes.reduce((n, s) => n + (s.drawn ?? 0), 0) : 0,
    // the wind amplitudes the shader is actually reading
    wind: (field?._strokes ?? []).map((st) => [st.uniforms?.base?.value ?? null, st.uniforms?.gust?.value ?? null]),
    storage: { quality: localStorage.getItem('ew-grass-quality'), motion: localStorage.getItem('ew-grass-motion') },
  };
});

/** Drive the REAL door: the slash command a resident types. */
const say = (v, text) => v.page.evaluate(async (t) => {
  const chat = await import('/lib/chat.js');
  const fn = chat.handleCommand ?? chat.runCommand ?? chat.tryCommand ?? null;
  if (fn) return { via: 'chat', handled: fn(t) };
  const { bus } = await import('/lib/core.js');
  const [cmd, ...rest] = t.replace(/^\//, '').split(/\s+/);
  bus.emit('command', { cmd, arg: rest.join(' ') });
  return { via: 'bus', handled: true };
}, text);

let A, B;
try {
  A = await viewer('ash');
  B = await viewer('brook');
  console.log('two viewers standing in one meadow\n');

  // runCommand is module-local to chat.js, so the driver dispatches on the bus
  // — the same event chat.js emits. Check the typed alias exists too, or the
  // test would pass for a command no resident can actually reach.
  const chatSrc = await (await fetch(`${origin}/lib/chat.js`)).text();
  check("chat.js routes a typed /foliage to the handler", /case 'foliage'/.test(chatSrc));
  check("…and /grass as its alias", /case 'grass'/.test(chatSrc));

  const logBefore = logEntries();
  const bBefore = await meadow(B);
  const aBefore = await meadow(A);
  check('this build has the local motion dial at all',
    aBefore.surface.length === 5, `only: ${JSON.stringify(aBefore.surface)}`);
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
  check("ASH's meadow went dark", a1.blades === 0 && !a1.visible, JSON.stringify({ blades: a1.blades, visible: a1.visible }));
  check("BROOK's meadow is untouched", b1.blades === bBefore.blades && b1.visible,
    `${bBefore.blades} → ${b1.blades}`);
  check("BROOK's dials never moved", b1.quality === bBefore.quality && b1.motion === bBefore.motion,
    `${bBefore.quality}/${bBefore.motion} → ${b1.quality}/${b1.motion}`);
  check('the WORLD LOG did not grow', log1.length === logBefore.length,
    `${logBefore.length} → ${log1.length}: ${JSON.stringify(log1.slice(logBefore.length).map((e) => e.verb))}`);
  check('no grass verb was authored', log1.filter((e) => e.verb === 'grass').length
    === logBefore.filter((e) => e.verb === 'grass').length);
  check("BROOK's browser storage is untouched", JSON.stringify(b1.storage) === JSON.stringify(bBefore.storage),
    JSON.stringify(b1.storage));

  // ---- 2. static ------------------------------------------------------------
  console.log('\nash types /foliage static');
  await say(A, '/foliage static');
  await sleep(800);
  const a2 = await meadow(A), b2 = await meadow(B);
  const log2 = logEntries();

  check('ASH sees the meadow again', a2.blades > 0 && a2.visible, `${a2.blades} blades`);
  check('…and it is STILL: wind amplitude zeroed', a2.wind.length > 0 && a2.wind.every(([b, g]) => b === 0 && g === 0),
    JSON.stringify(a2.wind));
  check('…and it reads as the static preset', a2.preset === 'static' && a2.animates === false,
    `${a2.preset}/${a2.animates}`);
  check("BROOK's wind is still blowing", b2.wind.length > 0 && b2.wind.some(([b, g]) => b > 0 || g > 0),
    JSON.stringify(b2.wind));
  check("BROOK's meadow is still untouched", b2.blades === bBefore.blades && b2.animates);
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

  // ---- 4. the setting is the viewer's, and it stays --------------------------
  console.log('\nash sets /foliage static and reloads');
  await say(A, '/foliage static');
  await sleep(500);
  await A.page.reload({ waitUntil: 'domcontentloaded' });
  await until(A.page, PLANTED, "ash's meadow to re-plant");
  await sleep(2500);
  const a4 = await meadow(A), b4 = await meadow(B);
  check('ASH gets their own meadow back the way they left it', a4.preset === 'static' && a4.animates === false,
    `${a4.preset}/${a4.animates}`);
  check('a fresh field inherits the choice (sticky across the re-grow)',
    a4.wind.length > 0 && a4.wind.every(([b, g]) => b === 0 && g === 0), JSON.stringify(a4.wind));
  check("BROOK's meadow, still, is the one its author planted", b4.blades === bBefore.blades && b4.animates);
  check('and the world log STILL did not grow', logEntries().length === logBefore.length);
} finally {
  if (argv['keep-open'] !== 'true') { await A?.ctx.close(); await B?.ctx.close(); await browser.close(); }
  srv.kill();
}

console.log(failures
  ? `\n\x1b[31m${failures} failed\x1b[0m — a viewer's choice reached something it should not have\n`
  : '\n\x1b[32mall green — one viewer changed their eyes, and the world did not notice\x1b[0m\n');
process.exit(failures ? 1 : 0);
