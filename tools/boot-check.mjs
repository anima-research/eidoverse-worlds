// boot-check — does the served client BOOT AT ALL, and does it FINISH booting? The whole suite is node-side
// and could not see a syntax error that killed the browser at module load (2026-08-16: the mesh-deletion
// commit left an orphaned `}` in main.js and staging served a dead client for five hours while every test
// stayed green). This is the "what does it print when broken" instrument for the client.
//
// TERMINAL BOOT, not panel existence (review 2026-09-10 #2): nine panels rendered and no page error is
// consistent with a splash that never leaves 'stepping in'. Success here is the real seam — finishBoot ran
// for the reason 'ready' (not the 45 s ceiling, not skip), the splash is gone, the phase reads 'welcome',
// and the body settled (its path is named on the ok line). The splash rays worker is asserted started+released
// only where index.html carries a .sp-rays canvas, and reported DORMANT where it does not. On failure it prints
// the phase the client stalled in and what it was still waiting for.
//
// 🔴 OWNS ITS SERVER (the #128 review lens, applied here before it was asked):
// the first version pointed at whatever answered on :8960, so its verdict was
// about an AMBIENT world — a stale server could buy a green, and on a clean
// checkout there was nothing to answer at all. It now spawns a child bound to
// a per-run nonce identity, exactly like isolation-headers-test. Pass an
// origin argv[1] to probe a LIVE deployment instead (the old behavior, now
// explicit): `bun tools/boot-check.mjs http://host:port` — identity checks are
// skipped in that mode because the deployment is not our child.
//
// Recipe: `bun tools/boot-check.mjs` (owned child; needs `bun install` in root + client and a Playwright
// Chromium). Knobs: BOOT_CHECK_QUERY='&xr=1' (appended to the boot URL; the decisions asserted follow from it),
// BOOT_CHECK_ABORT_VRM=1 (every body request fails at the network — the failed-body arrival path),
// BOOT_CHECK_REQUIRE_BODY=1 (a body must be ON SCREEN, not merely settled — for a clone that serves the library),
// BOOT_MAX_MS (poll budget, default 40000), JOIN_KEY (the owned child's join token). The child runs with
// SKIP_OPT_SWEEP=1 (no background re-encode; served bytes are the same). A run without the library (LIBRARY_DIR
// absent) arrives by the failed-body path and SAYS SO on its ok line; it is still a terminal boot.
import { launchBrowser, ownedWorld } from './probe-harness.mjs';

const LIVE = process.argv[2];                 // explicit live-deployment mode
const KEY = process.env.JOIN_KEY || 'dev';
const BOOT_MAX_MS = Number(process.env.BOOT_MAX_MS || 40000);   // under the client's own 45 s ceiling, so a ceiling exit is caught as one
let world;
// SKIP_OPT_SWEEP: the owned child's boot optimize sweeps (encode pump, ktx2/lod) are not what this measures,
// and on a laptop every spawn otherwise forks a minute-long encoder storm that stretches the NEXT run's
// body parse from 6 s to 29 s (2026-09-10, five stacked sweeps → load 33 → false 'never finished')
try { world = await ownedWorld({ live: LIVE || null, key: KEY, env: { SKIP_OPT_SWEEP: '1' } }); }
catch (e) { console.log(`FAIL — ${e.message}`); process.exit(1); }
const ORIGIN = world.origin;
let page;

// a red run must still reach the finally below: process.exit() inside the try skipped it and left the owned
// server squatting on its port for the NEXT run (seventh review 2026-09-10) — every failure throws instead
class Fail extends Error {}
const fail = (msg) => { throw new Fail(msg); };
let close = async () => {};
try {
  ({ page, close } = await launchBrowser());
  const pg = await page();
  const errs = [], logs = [], bodyErrs = [];
  pg.on('pageerror', e => errs.push(e.message));
  pg.on('console', m => { const t = m.text(); if (/^\[boot\]|^\[body\]|^\[render\]/.test(t)) logs.push(t); if (/^avatar\b/.test(t)) bodyErrs.push(t); });
  // domcontentloaded, not networkidle: a live client never goes network-idle (presence, tee, prefetch), and
  // a goto that waits for it times out before the poll below ever asks the real question
  // BOOT_CHECK_ABORT_VRM=1: every body request fails at the network — the failed-body arrival path (review
  // 2026-09-10 #2: a failed body must SETTLE the boot, never hold the splash to the 45 s ceiling)
  const ABORT_VRM = process.env.BOOT_CHECK_ABORT_VRM === '1';
  if (ABORT_VRM) await pg.route(/\.vrm(\?|$)/, (r) => r.abort());
  // BOOT_CHECK_QUERY='&webgl=1' / '&xr=0' / '&xr=1': the renderer-selection decisions, each its own owned run
  const QUERY = process.env.BOOT_CHECK_QUERY || '';
  await pg.goto(`${ORIGIN}/?world=staging&name=bootcheck&key=${KEY}${QUERY}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  const state = () => pg.evaluate(() => {
    const sp = document.getElementById('splash');
    return { panels: document.querySelectorAll('.sec').length, engine: !!globalThis.__ewEngineUp,
      splashGone: !sp || sp.classList.contains('gone'), splashDisplay: sp ? getComputedStyle(sp).display : 'none',
      phase: sp?.querySelector('.sp-phase')?.textContent ?? null, raysHandle: !!globalThis.__raysWorker,
      backend: globalThis._r?.backend ? (globalThis._r.backend.isWebGLBackend ? 'webgl' : 'webgpu') : null, xrEnabled: !!globalThis._r?.xr?.enabled,
      tolerance: !!globalThis.__renderListTolerance, xrShadow: globalThis.__xrShadowPatched === true, raysCanvas: !!document.querySelector('#splash .sp-rays'),
      hasBody: !!globalThis.EW?.me?.(),
      // REACHABILITY, not scrollWidth: html,body use overflow:hidden, so a frame
      // that runs past the viewport edge is simply unreachable and the document
      // never reports overflow (#185 review).
      vw: innerWidth, vh: innerHeight,
      rects: [...document.querySelectorAll('.frame')]
        .filter((f) => getComputedStyle(f).display !== 'none')
        .map((f) => { const r = f.getBoundingClientRect();
          return { id: f.id || f.dataset?.frame || f.className, x: Math.round(r.x), y: Math.round(r.y),
                   right: Math.round(r.right), bottom: Math.round(r.bottom) }; }) };
  });
  const t0 = Date.now(); let s = await state(), ready = null, raysSeen = false;
  while (Date.now() - t0 < BOOT_MAX_MS) {
    ready = logs.find((l) => /^\[boot\] ready in \d+ms \((\w+)\)/.test(l)) ?? null;
    s = await state();
    if (s.raysHandle) raysSeen = true;
    if (ready && s.splashGone && s.splashDisplay === 'none') break;
    await new Promise(r => setTimeout(r, 250));
  }
  const reason = ready ? ready.match(/\((\w+)\)/)[1] : null;
  const elapsed = Date.now() - t0;
  if (errs.length) { fail('page errors:\n  ' + errs.slice(0, 4).join('\n  ')); }
  if (!s.panels && elapsed < BOOT_MAX_MS) { fail('zero .sec panels rendered (boot died silently)'); }
  if (!ready || !s.splashGone || s.splashDisplay !== 'none') {
    fail(`boot never finished within ${BOOT_MAX_MS}ms: phase="${s.phase}" splashGone=${s.splashGone} splashDisplay=${s.splashDisplay} engine=${s.engine} panels=${s.panels}\n  boot log: ${logs.join(' | ') || '(none)'}`);
  }
  if (reason !== 'ready') { fail(`boot finished by "${reason}", not "ready" (the client gave up, it did not arrive): ${ready}`); }
  if (s.phase !== 'welcome') { fail(`finished but the phase reads "${s.phase}", not "welcome"`); }
  // THE DECISIONS ARE ASSERTED, NOT PRINTED (second review 2026-09-10): reintroducing presence-only ?xr passed a
  // fixture that only reported xr.enabled. Expectations follow from the query the run was given.
  const wantXR = /(^|&)xr=1(&|$)/.test(QUERY);
  if (s.xrEnabled !== wantXR) { fail(`xr.enabled=${s.xrEnabled} but query "${QUERY}" ${wantXR ? 'is' : 'is not'} an XR boot`); }
  if (s.tolerance !== wantXR) { fail(`tolerant render list ${s.tolerance ? 'installed' : 'not installed'} at boot; it must install only for an XR boot (query "${QUERY}")`); }
  if (!s.xrShadow) { fail('the ShadowNode XR-off patch was not applied at boot (core.js → xrshadow.js)'); }
  // REACHABILITY (#185 review). Every visible frame must lie inside the viewport.
  // Not scrollWidth: html,body use overflow:hidden, so a frame past the edge is
  // simply unreachable and the document reports no overflow at all. Run this at a
  // narrow viewport with BOOT_CHECK_VIEWPORT=390x844 (and 800x700 for split-window).
  // OVERLAP (#185 review req 2): two frames collide only when they overlap on
  // BOTH axes. chat is bottom-LEFT and the emote bar bottom-CENTRE, so at a wide
  // viewport they miss entirely and at a narrow one the centred bar slides onto
  // chat's composer. Checking one axis alone answers "always" or "never" — both wrong.
  const pairs = [];
  const rs = s.rects ?? [];
  for (let i = 0; i < rs.length; i++) for (let j = i + 1; j < rs.length; j++) {
    const a = rs[i], b = rs[j];
    if (a.x < b.right && b.x < a.right && a.y < b.bottom && b.y < a.bottom) pairs.push(`${a.id} [${a.x},${a.y},${a.right},${a.bottom}] × ${b.id} [${b.x},${b.y},${b.right},${b.bottom}]`);
  }
  if (pairs.length) { fail(`frames overlap at ${s.vw}x${s.vh} (a covered control cannot be clicked):\n  ` + pairs.join('\n  ')); }
  // The PRODUCT promises right <= innerWidth - 8 (frames.js clamp, snapPosition,
  // and the resize rider all use the same 8px margin). Checking only
  // `right > vw + 1` left a 9px band where a frame violates the clamp and still
  // passes — so this could never catch the most likely way that invariant
  // breaks: someone dropping the -8. Bind the promise, keeping the +1 sub-pixel
  // allowance. (agent review round 3)
  // x and y do NOT share a margin, and that is deliberate in the product:
  // fit()/snapPosition clamp x to 8, but the SOUTH resize clamps to
  // `innerHeight - s0.y - 4` (frames.js:144) so a resize can reach as low as a
  // drag — the comment there records the choice. Asserting 8 on both axes made
  // this probe stricter than the code it guards: a legal resize to the bottom
  // edge produced bottom=840 against a limit of 837 and failed. Match each
  // axis to its own promise. (agent review round 4, my own over-tightening)
  const MARGIN_X = 8, MARGIN_Y = 4;
  const off = (s.rects ?? []).filter((r) => r.right > s.vw - MARGIN_X + 1 || r.bottom > s.vh - MARGIN_Y + 1);
  if (off.length) {
    fail(`frames unreachable at ${s.vw}x${s.vh} (overflow:hidden — no scrolling to them):\n  `
      + off.map((r) => `${r.id} x=${r.x} y=${r.y} right=${r.right} bottom=${r.bottom}`).join('\n  '));
  }
  if (/(^|&)webgl=1(&|$)/.test(QUERY) && s.backend !== 'webgl') { fail(`?webgl=1 but backend=${s.backend}`); }
  if (wantXR && s.backend !== 'webgl') { fail(`XR boot without WebGPU-XR must ride WebGL, got backend=${s.backend}`); }
  // arrival means the BODY settled too (unless spectating): a checkReady that stops waiting for it lifts the splash
  // early and still logs ready — the marks tell them apart
  const spectating = /(^|&)(spectate|renderer)(=|&|$)/.test(QUERY);   // viewers by PRESENCE, as base.js reads them: no body of their own
  if (!spectating && !/body: \d+/.test(ready)) { fail(`finished without a body mark (the splash lifted before the body settled): ${ready}`); }
  // the body PATH is read from the scene (EW.me() — the avatar main.js set), not from console formatting: a
  // report() that stops logging must not turn a failed body into "on screen" (eighth review 2026-09-10)
  let body;
  if (spectating) body = 'viewer (no body)';
  else if (s.hasBody) { if (bodyErrs.length) fail(`a body is on screen AND the client reported an avatar error: ${bodyErrs[0].slice(0, 120)}`); body = 'body on screen'; }
  else body = `body FAILED → failed-body path (${bodyErrs.length ? bodyErrs[0].replace(/\s+/g, ' ').slice(0, 90) : 'no avatar error reported'})`;
  if (process.env.BOOT_CHECK_REQUIRE_BODY === '1' && !spectating && !s.hasBody) fail(`BOOT_CHECK_REQUIRE_BODY=1 but ${body}`);
  // the splash rays worker exists only where index.html carries a .sp-rays canvas (rung 4's markup); here it is
  // asserted when present and reported DORMANT when not — never claimed released when it never ran
  let rays;
  if (s.raysCanvas) { if (!raysSeen) { fail('.sp-rays canvas present but the rays worker handle was never advertised'); }
    if (s.raysHandle) { fail('the rays worker handle is still advertised after boot (stopRays did not release it)'); } rays = 'rays seen+released'; }
  else rays = 'rays DORMANT (no .sp-rays canvas at this rung)';
  console.log(`ok — client boots AND arrives [viewport ${s.vw}x${s.vh}]: ${ready} after ${elapsed}ms, ${s.panels} panels, splash gone, ${rays}, backend=${s.backend} xr.enabled=${s.xrEnabled} tolerance=${s.tolerance} xrShadowPatch=${s.xrShadow}${QUERY ? ` query=${QUERY}` : ''} — decisions asserted, no page errors, ${body}${ABORT_VRM ? ' [body requests ABORTED]' : ''}${LIVE ? ' (live deployment)' : ' (owned child)'}`);
} catch (e) {
  console.log(`FAIL — ${e instanceof Fail ? e.message : (e?.stack ?? e)}`);
  process.exitCode = 1;
} finally {
  await close();
  await world.close();
}
