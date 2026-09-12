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
const RESIZE_TO = process.env.BOOT_CHECK_RESIZE_TO ?? '';   // B1: WxH to shrink to mid-run
let resized = '';
let barOpened = '';
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
      phase: sp?.querySelector('.sp-phase')?.textContent ?? null, raysHandle: !!globalThis.__raysWorker, raysStarted: globalThis.__raysStarted === true,
      raysAck: globalThis.__raysAck === true, raysNoGl: globalThis.__raysNoGl === true,
      backend: globalThis._r?.backend ? (globalThis._r.backend.isWebGLBackend ? 'webgl' : 'webgpu') : null, xrEnabled: !!globalThis._r?.xr?.enabled,
      tolerance: !!globalThis.__renderListTolerance, xrShadow: globalThis.__xrShadowPatched === true, raysCanvas: !!document.querySelector('#splash .sp-rays'),
      hasBody: !!globalThis.EW?.me?.(),
      // REACHABILITY, not scrollWidth: html,body use overflow:hidden, so a frame
      // that runs past the viewport edge is simply unreachable and the document
      // never reports overflow (#185 review).
      vw: innerWidth, vh: innerHeight,
      // CHROME, not just frames (antra-tess #185 B2). boot-check collected only
      // .frame rects, so #dock, .capnotice, #micbtn/#earbtn and the joystick were
      // structurally invisible — "boot-check checks only .frame pairs, so it
      // cannot observe dock/touch-control occlusion" was exactly right. A control
      // is REACHABLE only if the pixel at its centre belongs to it.
      chrome: ['#dock', '.capnotice', '#micbtn', '#earbtn', '#emenu', '#stick', '#hintbar', '#trayzone']
        .map((sel) => { const e = document.querySelector(sel); if (!e) return null;
          const r = e.getBoundingClientRect(); if (!r.width || !r.height) return null;
          return { id: sel, x: Math.round(r.x), y: Math.round(r.y), right: Math.round(r.right), bottom: Math.round(r.bottom),
                   pe: getComputedStyle(e).pointerEvents }; })
        .filter(Boolean),
      // every visible control's centre, and who actually owns that pixel
      controls: [...document.querySelectorAll('.frame .tile, #dock button')]
        .filter((t) => { const r = t.getBoundingClientRect(); return r.width && r.height; })
        .map((t) => { const r = t.getBoundingClientRect();
          const cx = Math.round(r.left + r.width / 2), cy = Math.round(r.top + r.height / 2);
          const hit = document.elementFromPoint(cx, cy);
          const owner = hit && !(t === hit || t.contains(hit))
            ? (['#dock', '.capnotice', '#micbtn', '#earbtn', '#emenu', '#stick'].find((s) => hit.closest(s)) ?? 'other')
            : null;
          return { id: (t.title || t.getAttribute('aria-label') || t.textContent || '?').trim().slice(0, 18), owner }; })
        .filter((c) => c.owner),
      // how many control surfaces were MEASURABLE at all. A check that reports
      // green from an empty collection is worse than no check: at 390x844 the
      // emote bar is hidden by fitsDefaults, so `.frame .tile` yields nine
      // zero-size nodes, every one filtered out, and the run passed while my
      // standalone probe measured a stolen tile at the same instant.
      tilesSized: [...document.querySelectorAll('.frame .tile')].filter((t) => { const r = t.getBoundingClientRect(); return r.width && r.height; }).length,
      tilesInDom: document.querySelectorAll('.frame .tile').length,
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
  // GEOMETRY, factored so a SECOND phase can re-run it (antra-tess #185 rereview B1).
  // These two checks used to be inline and therefore ran exactly once, at the boot
  // viewport. The review asked for a real setViewportSize() product test: a page
  // that boots wide and is then narrowed keeps all three defaults open and they
  // overlap (emotes x world 352x46px at 390x844) — a state no fixed-viewport boot
  // can reach. Same assertions, same failure text, plus the phase that produced it.
  const checkGeometry = (g, where) => {
    // OVERLAP (#185 review req 2): two frames collide only when they overlap on
    // BOTH axes. chat is bottom-LEFT and the emote bar bottom-CENTRE, so at a wide
    // viewport they miss entirely and at a narrow one the centred bar slides onto
    // chat's composer. Checking one axis alone answers "always" or "never" — both wrong.
    const pairs = [];
    const rs = g.rects ?? [];
    for (let i = 0; i < rs.length; i++) for (let j = i + 1; j < rs.length; j++) {
      const a = rs[i], b = rs[j];
      if (a.x < b.right && b.x < a.right && a.y < b.bottom && b.y < a.bottom) pairs.push(`${a.id} [${a.x},${a.y},${a.right},${a.bottom}] × ${b.id} [${b.x},${b.y},${b.right},${b.bottom}]`);
    }
    if (pairs.length) { fail(`frames overlap at ${g.vw}x${g.vh} (a covered control cannot be clicked):\n  ` + pairs.join('\n  ')); }
    // A CONTROL WHOSE CENTRE BELONGS TO SOMETHING ELSE CANNOT BE TAPPED (#185 B2).
    // Rect overlap alone is not the test: chrome may legitimately sit beside a
    // frame. Hit-testing is, and it is the only thing that catches a z-60 card
    // over a z-25 bar, or the rail once it reorients along the top edge.
    // EVERY thief counts, including ones outside my selector list — dropping
    // 'other' is how #earbtn's inner <rect> made a real occluder invisible.
    const stolen = g.controls ?? [];
    if (stolen.length) {
      fail(`controls unreachable at ${g.vw}x${g.vh} — the pixel at their centre belongs to other chrome (${where}):\n  `
        + stolen.map((c) => `"${c.id}" covered by ${c.owner}`).join('\n  '));
    }
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
    const off = (g.rects ?? []).filter((r) => r.right > g.vw - MARGIN_X + 1 || r.bottom > g.vh - MARGIN_Y + 1);
    if (off.length) {
      fail(`frames unreachable at ${g.vw}x${g.vh} (overflow:hidden — no scrolling to them):\n  `
        + off.map((r) => `${r.id} x=${r.x} y=${r.y} right=${r.right} bottom=${r.bottom}`).join('\n  '));
    }
  };
  checkGeometry(s, `boot ${s.vw}x${s.vh}`);

  // OPEN THE CONTROLS THE REVIEW IS ABOUT, then look again (antra-tess #185 B2).
  // At phone widths fitsDefaults() hides the emote bar, so `.frame .tile` yields
  // nine ZERO-SIZE nodes and the hit-test above has nothing to measure: the run
  // goes green because the collection is empty, not because the tiles are
  // reachable. Her repro is a user tapping the dock to open the bar — so do that,
  // and assert what is on screen afterwards. tilesSized is printed on the ok line
  // so an empty measurement can never again read as a pass.
  const opened = await pg.evaluate(async () => {
    // TOGGLE, not open: at a wide viewport the bar is ALREADY open, so clicking
    // the dock button closed it and the guard below then fired on my own action
    // (FAIL at 1280x720, tilesInDom=9 tilesSized=0). Only click when it is hidden.
    const isOpen = () => [...document.querySelectorAll('.frame')]
      .some((f) => /emote/i.test(f.querySelector('.fr-title')?.textContent || '')
                && getComputedStyle(f).display !== 'none');
    if (isOpen()) return 'already open';
    const btn = [...document.querySelectorAll('#dock button')]
      .find((b) => /emote/i.test(b.title || b.getAttribute('aria-label') || ''));
    if (!btn) return 'no emote dock button';
    btn.click();
    await new Promise((r) => setTimeout(r, 900));
    return isOpen() ? 'opened' : 'click did not open it';
  });
  if (opened === 'opened' || opened === 'already open') {
    const s3 = await state();
    if (!s3.tilesSized) { fail(`the emote bar was opened from the dock but no tile has a size (tilesInDom=${s3.tilesInDom}) — the B2 hit-test would measure nothing`); }
    checkGeometry(s3, `emote bar open at ${s3.vw}x${s3.vh}`);
    barOpened = ` · emote bar ${opened}: ${s3.tilesSized} tiles measured, none covered`;
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
  // STARTED is cumulative (__raysStarted, never cleared); the HANDLE is transient.
  // Polling only the handle raced the worker's own lifetime — 2 of 8 owned runs
  // failed here with the worker perfectly healthy (antra-tess #185 B4).
  // The cumulative flag is asserted ON ITS OWN, not as the second half of an &&
  // that raysSeen short-circuits (agent review 2026-09-12). raysSeen comes from
  // the 250ms handle poll and is true on a normal run, so `!raysSeen && !started`
  // never consulted __raysStarted — the very flag added for B4 carried nothing
  // and could have been deleted with CI green until the sampling race recurred.
  // 2026-09-12, antra-tess #185 exact-head rereview B4: __raysStarted is set by the MAIN thread on the
  // line after new Worker(), and constructing a Worker whose module fails to parse does NOT throw
  // synchronously — so appending invalid JS to the real worker left this green. The receipt is now
  // WORKER-ORIGINATED: splashrays.worker.js posts {type:'ready'} after its first real drawArrays.
  // Three outcomes are kept apart: ACK (it drew and said so) / NOGL (it reached us and declined —
  // a legitimate fallback, not a failure) / SILENCE (neither: broken module, or a suppressed ack) = RED.
  // __raysStarted is KEPT and still asserted: it fixed a real sampling race (the transient handle was
  // polled at 250 ms and missed workers that started and finished between samples — 2 of 8 owned runs).
  if (s.raysCanvas) { if (!s.raysStarted) { fail('.sp-rays canvas present but __raysStarted was never set (main never reached the start block)'); }
    if (!s.raysAck && !s.raysNoGl) { fail('.sp-rays canvas present but the worker never acknowledged: no first-frame ready and no nogl — a broken worker or a suppressed ack looks exactly like this'); }
    if (s.raysHandle) { fail('the rays worker handle is still advertised after boot (stopRays did not release it)'); }
    rays = s.raysAck ? 'rays acked+released (worker-originated)' : 'rays nogl fallback (worker declined, canvas hidden)'; }
  else rays = 'rays DORMANT (no .sp-rays canvas at this rung)';
  // THE LIVE RESIZE PHASE (antra-tess #185 rereview B1, required by name).
  // "boot-check.mjs starts at one fixed viewport and never changes it" — so the
  // claim that a wide->narrow shrink keeps every frame inside was asserted and
  // never executed. It was also false: containment is per-frame, arrangement is
  // global, and each frame clamping itself legally still let emotes x world
  // overlap 352x46px at 390x844. fitsDefaults() now re-fires on viewport change;
  // this is the product path that proves it, at the only moment it can be seen.
  if (RESIZE_TO) {
    const m = /^(\d+)x(\d+)$/.exec(RESIZE_TO);
    if (!m) fail(`BOOT_CHECK_RESIZE_TO="${RESIZE_TO}" is not WxH`);
    await pg.setViewportSize({ width: +m[1], height: +m[2] });
    // the rule runs on the resize event and repaints; settle before measuring
    await new Promise(r => setTimeout(r, 1200));
    const s2 = await state();
    if (s2.vw !== +m[1] || s2.vh !== +m[2]) fail(`asked for ${RESIZE_TO} but the page reports ${s2.vw}x${s2.vh}`);
    checkGeometry(s2, `after live resize ${s.vw}x${s.vh} -> ${s2.vw}x${s2.vh}`);
    resized = ` · live resize -> ${s2.vw}x${s2.vh}: ${(s2.rects ?? []).length} frame(s) open, geometry clean`;
  }
  console.log(`ok — client boots AND arrives [viewport ${s.vw}x${s.vh}]: ${ready} after ${elapsed}ms, ${s.panels} panels, splash gone, ${rays}, backend=${s.backend} xr.enabled=${s.xrEnabled} tolerance=${s.tolerance} xrShadowPatch=${s.xrShadow}${QUERY ? ` query=${QUERY}` : ''} — decisions asserted, no page errors, ${body}${ABORT_VRM ? ' [body requests ABORTED]' : ''}${LIVE ? ' (live deployment)' : ' (owned child)'}${resized}${barOpened}`);
} catch (e) {
  console.log(`FAIL — ${e instanceof Fail ? e.message : (e?.stack ?? e)}`);
  process.exitCode = 1;
} finally {
  await close();
  await world.close();
}
