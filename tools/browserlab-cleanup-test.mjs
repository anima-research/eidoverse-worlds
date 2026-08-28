// browserlab-cleanup-test — throw in the middle of a run and prove the harness
// puts everything back (#42 review, blocker 3).
//
// The diagnostic monkeypatches `console.error` and `console.warn`, installs
// canvas listeners, adds a body class, enters photo mode, releases the meadow's
// per-frame hooks and zeroes its wind uniforms. All of that was restored on the
// happy path and NONE of it on a throw: `trouble.stop()` sat after the arm
// loop's try/finally rather than inside it, so a failed measurement left the
// console patched and the listeners attached for the rest of the session — a
// diagnostic leaking into the thing it was measuring.
//
// This is the test that can tell. It runs the harness twice against one page:
// once with an injected failure on the middle arm, once clean, and compares the
// page's observable state before and after each. The injected failure is a real
// throw from inside the arm loop (`_throwOnArm`), not a simulation.
//
//   node tools/browserlab-cleanup-test.mjs
//   node tools/browserlab-cleanup-test.mjs --url="http://localhost:8949/?...&key=..."
//
// 🔴 node, not bun — Playwright's launch hangs under bun on Windows.

import { chromium } from 'playwright';

const argv = Object.fromEntries(process.argv.slice(2)
  .filter((a) => a.startsWith('--'))
  .map((a) => { const i = a.indexOf('='); return i < 0 ? [a.slice(2), 'true'] : [a.slice(2, i), a.slice(i + 1)]; }));

if (!argv.url) {
  console.error('browserlab-cleanup-test: pass --url=... for a seeded scratch world.');
  console.error('  node tools/browserlab-seed.mjs   # prints the exact --url');
  process.exit(1);
}

let failures = 0;
const check = (label, ok, detail) => {
  console.log(ok ? `  \x1b[32m✓\x1b[0m ${label}` : `  \x1b[31m✗ ${label}${detail ? ` — ${detail}` : ''}\x1b[0m`);
  if (!ok) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.launch({ headless: false, channel: argv.browser ?? 'chrome', timeout: 90_000 });
const ctx = await browser.newContext({ viewport: { width: 1000, height: 700 } });
const page = await ctx.newPage();

/** Everything the harness touches that a later reader could notice. */
const observable = () => page.evaluate(async () => {
  const t = await import('/lib/terrain.js');
  const { autoHooks } = await import('/lib/autohooks.js');
  const c = await import('/lib/controller.js');
  const f = t.getGrassField();
  return {
    // the monkeypatch: a native method stringifies as [native code]
    consoleErrorNative: /\[native code\]/.test(String(console.error)),
    consoleWarnNative: /\[native code\]/.test(String(console.warn)),
    hookCount: autoHooks().length,
    photoMode: c.photoMode,
    bodyPhotoClass: document.body.classList.contains('photo'),
    meshVisible: !!f?.mesh?.visible,
    strokeVisible: (f?._strokes ?? []).map((s) => !!s.mesh?.visible),
    wind: (f?._strokes ?? []).map((s) => [s.uniforms?.base?.value ?? null, s.uniforms?.gust?.value ?? null]),
  };
});

const until = async (fn, label, ms = 180_000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (await page.evaluate(fn)) return true; await sleep(500); }
  throw new Error(`timed out waiting for ${label}`);
};

try {
  console.log(`\nbrowserlab cleanup contract — ${argv.url}\n`);
  await page.goto(argv.url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.bringToFront();
  await until(() => (globalThis.EW?.renderer?.info?.render?.triangles ?? 0) > 0, 'the first frame');
  await until(async () => {
    const t = await import('/lib/terrain.js');
    return t.hasGrass() && (t.grassTiles().strokes ?? []).reduce((n, s) => n + (s.drawn ?? 0), 0) > 0;
  }, 'the meadow to plant');
  await sleep(1500);

  const before = await observable();
  check('the page starts unpatched', before.consoleErrorNative && before.consoleWarnNative, JSON.stringify(before));
  check('…with a visible, animating meadow',
    before.meshVisible && before.wind.length > 0 && before.wind.some(([b, g]) => b > 0 || g > 0),
    JSON.stringify(before.wind));

  // ---- 1. a throw in the middle arm ----------------------------------------
  console.log('\ninjecting a failure on the "static" arm');
  const thrown = await page.evaluate(async () => {
    try {
      await globalThis.EW.browserlab({ secs: 5, settleMs: 500, _throwOnArm: 'static' });
      return { threw: false };
    } catch (e) { return { threw: true, message: String(e.message ?? e).slice(0, 160) }; }
  });
  check('the run really failed (the seam is a throw, not a simulation)',
    thrown.threw && /injected failure/.test(thrown.message ?? ''), JSON.stringify(thrown));

  await sleep(500);
  const after = await observable();
  check('console.error was restored', after.consoleErrorNative, String(after.consoleErrorNative));
  check('console.warn was restored', after.consoleWarnNative, String(after.consoleWarnNative));
  check('the meadow is drawing again', after.meshVisible && after.strokeVisible.every(Boolean),
    JSON.stringify({ mesh: after.meshVisible, strokes: after.strokeVisible }));
  check('every wind amplitude is back to its exact prior value',
    JSON.stringify(after.wind) === JSON.stringify(before.wind),
    `${JSON.stringify(before.wind)} → ${JSON.stringify(after.wind)}`);
  check('every released per-frame hook went back into the array',
    after.hookCount === before.hookCount, `${before.hookCount} → ${after.hookCount}`);
  check('photo mode was exited', after.photoMode === before.photoMode,
    `${before.photoMode} → ${after.photoMode}`);
  check('the UI-hiding body class was removed', after.bodyPhotoClass === before.bodyPhotoClass,
    `${before.bodyPhotoClass} → ${after.bodyPhotoClass}`);

  // ---- 2. a throw on the FIRST arm, before any measurement ------------------
  console.log('\ninjecting a failure on the first arm');
  await page.evaluate(async () => {
    try { await globalThis.EW.browserlab({ secs: 5, settleMs: 500, _throwOnArm: 'full' }); } catch { /* expected */ }
  });
  await sleep(500);
  const after2 = await observable();
  check('an immediate failure also unwinds completely',
    after2.consoleErrorNative && after2.consoleWarnNative && after2.hookCount === before.hookCount
    && after2.meshVisible && JSON.stringify(after2.wind) === JSON.stringify(before.wind),
    JSON.stringify(after2));

  // ---- 3. and the happy path still restores --------------------------------
  console.log('\nand a clean run');
  const lab = await page.evaluate(() => globalThis.EW.browserlab({ secs: 5, settleMs: 500, label: 'cleanup-test' }));
  await sleep(500);
  const after3 = await observable();
  check('a clean run leaves the page exactly as it found it',
    after3.consoleErrorNative && after3.consoleWarnNative && after3.hookCount === before.hookCount
    && after3.meshVisible && JSON.stringify(after3.wind) === JSON.stringify(before.wind),
    JSON.stringify(after3));
  check('…and still produced a receipt', !!lab?.markdown && lab.arms?.length === 3);

  const st0 = lab.arms.find((a) => a.arm === 'static')?.armEffect;
  check('the static arm released meadow hooks', !!st0 && st0.hooksFrozen > 0, JSON.stringify(st0));
  check('…and zeroed the wind rather than only stopping its clock',
    !!st0 && st0.windZeroed > 0, JSON.stringify(st0));

  // ---- 4. the scope claim, exercised rather than assumed --------------------
  //
  // This scratch world happens to register no sky or emitter hooks, so simply
  // counting foreign hooks proves nothing here — the first version of this
  // check passed vacuously at 0 === 0. So plant one: a sentinel that counts its
  // own ticks, standing in for the cloud drift and the entity emitters that a
  // real world would have in that array. The static arm must leave it running.
  console.log('\nwith a foreign per-frame hook planted in the shared array');
  await page.evaluate(async () => {
    const { autoHooks } = await import('/lib/autohooks.js');
    globalThis.__sentinelTicks = 0;
    globalThis.__sentinel = () => { globalThis.__sentinelTicks++; };
    autoHooks().push(globalThis.__sentinel);
  });
  const ticksBefore = await page.evaluate(() => globalThis.__sentinelTicks);
  const lab2 = await page.evaluate(() => globalThis.EW.browserlab({
    secs: 5, settleMs: 500, arms: ['static'], label: 'scope-test',
  }));
  const sentinel = await page.evaluate(async () => {
    const { autoHooks } = await import('/lib/autohooks.js');
    return { ticks: globalThis.__sentinelTicks, present: autoHooks().includes(globalThis.__sentinel) };
  });
  const st = lab2.arms.find((a) => a.arm === 'static')?.armEffect;

  check('the foreign hook was counted, not frozen',
    !!st && st.foreignHooksLeftRunning >= 1 && st.foreignHooksLeftRunning === st.foreignHooksAtStart,
    JSON.stringify(st));
  check('…it kept ticking THROUGH the static arm',
    sentinel.ticks > ticksBefore + 100, `${ticksBefore} → ${sentinel.ticks} over ~5s`);
  check('…and it is still in the array afterwards', sentinel.present);
  check('…while the meadow hooks really were released during it',
    !!st && st.hooksFrozen > 0, JSON.stringify(st));

  await page.evaluate(async () => {
    const { releaseHook } = await import('/lib/autohooks.js');
    releaseHook(globalThis.__sentinel);
  });

  // the counter contract, live
  const full = lab.arms.find((a) => a.arm === 'full');
  check('draws are reported from a counter the harness could classify',
    /^per-frame|^cumulative/.test(full.drawCounter ?? ''), String(full.drawCounter));
  check('…and the lifetime counter is recorded as cumulative, not published as a frame cost',
    full.lifetimeCalls?.kind === 'cumulative' && full.drawCalls !== full.lifetimeCalls.last,
    JSON.stringify(full.lifetimeCalls));
} finally {
  await browser.close();
}

console.log(failures
  ? `\n\x1b[31m${failures} failed\x1b[0m — the diagnostic leaks into what it measures\n`
  : '\n\x1b[32mall green — the harness puts everything back, thrown or not\x1b[0m\n');
process.exit(failures ? 1 : 0);
