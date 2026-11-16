// boot-check: does the served client BOOT, and FINISH booting? The node-side suite can't see a syntax error that
// kills the browser at module load; this is the client's "what does it print when broken" instrument.
// TERMINAL BOOT, not panel existence: finishBoot ran for 'ready' (not the 45 s ceiling, not skip), the splash is gone,
// the phase reads 'welcome', and the body settled (its path on the ok line). The splash rays worker is asserted
// started+released only where index.html has a .sp-rays canvas, else reported DORMANT. On failure it prints the
// stalled phase and what it was waiting for.
// 🔴 OWNS ITS SERVER: spawns a child bound to a per-run nonce (as served-routes-test), so a stale server can't buy
// a green. `bun test/client/boot-check.mjs http://host:port` probes a LIVE deployment instead, identity checks skipped.
// Recipe: `bun test/client/boot-check.mjs` (needs `bun install` in root + client and a Playwright Chromium). Knobs:
//   BOOT_CHECK_QUERY='&xr=1' (appended to the boot URL; the asserted decisions follow from it)
//   BOOT_CHECK_VIEWPORT=1000x700 (below the default arrangement's width: bar hidden at boot, capability card top-centre)
//   BOOT_CHECK_ABORT_VRM=1 (every body request fails: the failed-body arrival path)
//   BOOT_CHECK_REQUIRE_BODY=1 (a body ON SCREEN, not merely settled: for a clone serving the library)
//   BOOT_CHECK_RESIZE_TO=390x844 (shrink mid-run). No command runs a viewport matrix now; the old one (deleted in
//   2c69ca486) was 390x844, 800x700, 844x390, 1024x800 and 1280x720→390x844, one run each.
//   BOOT_MAX_MS (poll budget, default 40000), JOIN_KEY (the owned child's join token), BOOT_CHECK_CLOUDS_OFF=1 (no cloud bake)
// The child runs with SKIP_OPT_SWEEP=1. Without the library (LIBRARY_DIR absent) it arrives by the failed-body path
// and SAYS SO on its ok line; still a terminal boot.
import { launchBrowser, ownedWorld } from '../harness/probe-harness.mjs';

const LIVE = process.argv[2];                 // explicit live-deployment mode
const KEY = process.env.JOIN_KEY || 'dev';
const BOOT_MAX_MS = Number(process.env.BOOT_MAX_MS || 40000);  // under the client's 45 s ceiling, so a ceiling exit is caught as one
let world;
// SKIP_OPT_SWEEP: the boot optimize sweeps aren't measured here, and on a laptop each spawn otherwise forks a
// minute-long encoder storm that slows the NEXT run's body parse into a false 'never finished'
try { world = await ownedWorld({ live: LIVE || null, key: KEY, env: { SKIP_OPT_SWEEP: '1' } }); }
catch (e) { console.log(`FAIL — ${e.message}`); process.exit(1); }
const ORIGIN = world.origin;
let page;

// a red run must still reach the finally (process.exit() in the try leaves the server squatting its port): failures throw
class Fail extends Error {}
const fail = (msg) => { throw new Fail(msg); };
const RESIZE_TO = process.env.BOOT_CHECK_RESIZE_TO ?? '';  // WxH to shrink to mid-run
let resized = '';
let barOpened = '';
let close = async () => {};
try {
  ({ page, close } = await launchBrowser());
  const pg = await page();
  // BOOT_CHECK_CLOUDS_OFF=1: the sky guard, before any module reads localStorage (sky.js): a cloudy sky bakes on the CPU
  // in headless Chromium and has frozen a small host
  if (process.env.BOOT_CHECK_CLOUDS_OFF === '1') await pg.addInitScript(() => { try { localStorage.setItem('ew-cloud-quality', 'off'); } catch {} });
  const errs = [], logs = [], bodyErrs = [];
  pg.on('pageerror', e => errs.push(e.message));
  pg.on('console', m => { const t = m.text(); if (/^\[boot\]|^\[body\]|^\[render\]/.test(t)) logs.push(t); if (/^avatar\b/.test(t)) bodyErrs.push(t); });
  // domcontentloaded, not networkidle: a live client never goes network-idle
  // BOOT_CHECK_ABORT_VRM=1: every body request fails; a failed body must settle the boot, never hold the splash to 45 s
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
      tolerance: !!globalThis.__renderListTolerance, xrShadow: globalThis.__xrShadowPatched === true, xrPixelRatio: globalThis.__xrPixelRatioGuarded === true, xrPass: globalThis.__xrPassSplit === true, raysCanvas: !!document.querySelector('#splash .sp-rays'),
      hasBody: !!globalThis.EW?.me?.(),
      capsule: !!globalThis.EW?.me?.()?.isCapsule,  // the body of last resort (capsulebody.js): an avatar error BEFORE it is the expected story
      // REACHABILITY, not scrollWidth: html,body are overflow:hidden, so an off-viewport frame never reports overflow
      vw: innerWidth, vh: innerHeight,
      // chrome, not just frames: a control is reachable only if the pixel at its centre belongs to it
      chrome: ['#dock', '.capnotice', '#micbtn', '#earbtn', '#emenu', '#stick', '#hintbar', '#trayzone']
        .map((sel) => { const e = document.querySelector(sel); if (!e) return null;
          const r = e.getBoundingClientRect(); if (!r.width || !r.height) return null;
          return { id: sel, x: Math.round(r.x), y: Math.round(r.y), right: Math.round(r.right), bottom: Math.round(r.bottom),
                   pe: getComputedStyle(e).pointerEvents }; })
        .filter(Boolean),
      // every visible control's centre and who owns that pixel; '.frame button' also reaches section headers (ui.js
      // makeSection's BUTTON.head), which the card can cover
      controls: [...document.querySelectorAll('.frame .tile, .frame button, #dock button')]
        .filter((t) => { const r = t.getBoundingClientRect(); return r.width && r.height; })
        .map((t) => { const r = t.getBoundingClientRect();
          const cx = Math.round(r.left + r.width / 2), cy = Math.round(r.top + r.height / 2);
          const hit = document.elementFromPoint(cx, cy);
          const owner = hit && !(t === hit || t.contains(hit))
            ? (['#dock', '.capnotice', '#micbtn', '#earbtn', '#emenu', '#stick'].find((s) => hit.closest(s)) ?? 'other')
            : null;
          return { id: (t.title || t.getAttribute('aria-label') || t.textContent || '?').trim().slice(0, 18), owner }; })
        .filter((c) => c.owner),
      // the capability card may cover anything while its dismiss button is visible and clickable (owns its centre pixel)
      capDismissable: (() => { const bts = [...document.querySelectorAll('.capnotice .cn-ok')]; if (!bts.length) return null;
        return bts.every((bt) => { const r = bt.getBoundingClientRect(); if (!r.width || !r.height) return false;
          const h = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return bt === h || bt.contains(h); }); })(),  // EVERY item's
      // how many controls were measurable: at 390x844 the bar is hidden, so `.frame .tile` is nine zero-size nodes, and
      // an empty collection must not read green
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
  // THE DECISIONS ARE ASSERTED, NOT PRINTED (presence-only ?xr passed a fixture that only reported xr.enabled);
  // expectations follow from the query
  const wantXR = /(^|&)xr=1(&|$)/.test(QUERY);
  if (s.xrEnabled !== wantXR) { fail(`xr.enabled=${s.xrEnabled} but query "${QUERY}" ${wantXR ? 'is' : 'is not'} an XR boot`); }
  if (s.tolerance !== wantXR) { fail(`tolerant render list ${s.tolerance ? 'installed' : 'not installed'} at boot; it must install only for an XR boot (query "${QUERY}")`); }
  if (!s.xrShadow) { fail('the ShadowNode XR-off patch was not applied at boot (core.js → xrshadow.js)'); }
  if (!s.xrPass) { fail('stereo renders were not split into their own pass at boot (core.js → xrpass.js): every VR switch rebuilds'); }
  if (!s.xrPixelRatio) { fail('the XR pixel-ratio guard (#32 split vision) was not applied at boot (core.js → xrpixelratio.js)'); }
  // every visible frame lies inside the viewport. Factored so the live-resize phase re-runs it; try
  // BOOT_CHECK_VIEWPORT=390x844 and 800x700.
  const checkGeometry = (g, where) => {
    // two frames collide only when they overlap on BOTH axes
    const pairs = [];
    const rs = g.rects ?? [];
    for (let i = 0; i < rs.length; i++) for (let j = i + 1; j < rs.length; j++) {
      const a = rs[i], b = rs[j];
      if (a.x < b.right && b.x < a.right && a.y < b.bottom && b.y < a.bottom) pairs.push(`${a.id} [${a.x},${a.y},${a.right},${a.bottom}] × ${b.id} [${b.x},${b.y},${b.right},${b.bottom}]`);
    }
    if (pairs.length) { fail(`frames overlap at ${g.vw}x${g.vh} (a covered control cannot be clicked):\n  ` + pairs.join('\n  ')); }
    // a control whose centre pixel belongs to something else can't be tapped (every thief counts, even unlisted ones),
    // except the capability card while dismissable
    if (g.capDismissable === false) fail(`the capability card's dismiss button is not clickable at ${g.vw}x${g.vh} (${where})`);
    const stolen = (g.controls ?? []).filter((c) => !(c.owner === '.capnotice' && g.capDismissable));
    if (stolen.length) {
      fail(`controls unreachable at ${g.vw}x${g.vh} — the pixel at their centre belongs to other chrome (${where}):\n  `
        + stolen.map((c) => `"${c.id}" covered by ${c.owner}`).join('\n  '));
    }
    // the product's margins: x clamps at innerWidth - 8 (windows.js fit/snapPosition), south resize at innerHeight - 4; +1 sub-pixel
    const MARGIN_X = 8, MARGIN_Y = 4;
    const off = (g.rects ?? []).filter((r) => r.right > g.vw - MARGIN_X + 1 || r.bottom > g.vh - MARGIN_Y + 1);
    if (off.length) {
      fail(`frames unreachable at ${g.vw}x${g.vh} (overflow:hidden — no scrolling to them):\n  `
        + off.map((r) => `${r.id} x=${r.x} y=${r.y} right=${r.right} bottom=${r.bottom}`).join('\n  '));
    }
  };
  checkGeometry(s, `boot ${s.vw}x${s.vh}`);

  // at phone widths fitsDefaults() hides the bar, so tap the dock as a user would; tilesSized rides the ok line so an
  // empty measurement can't pass (a bar the dock can't open skips the measurement, silently)
  const opened = await pg.evaluate(async () => {
    // TOGGLE, not open: at a wide viewport the bar is ALREADY open, so only click when it's hidden
    const isOpen = () => [...document.querySelectorAll('.frame')]
      .some((f) => /action bar/i.test(f.querySelector('.fr-title')?.textContent || '')
                && getComputedStyle(f).display !== 'none');
    if (isOpen()) return 'already open';
    const btn = [...document.querySelectorAll('#dock button')]
      .find((b) => /action bar/i.test(b.title || b.getAttribute('aria-label') || ''));
    if (!btn) return 'no action bar dock button';
    btn.click();
    await new Promise((r) => setTimeout(r, 900));
    return isOpen() ? 'opened' : 'click did not open it';
  });
  if (opened === 'opened' || opened === 'already open') {
    const s3 = await state();
    if (!s3.tilesSized) { fail(`the action bar was opened from the dock but no tile has a size (tilesInDom=${s3.tilesInDom}) — the B2 hit-test would measure nothing`); }
    checkGeometry(s3, `action bar open at ${s3.vw}x${s3.vh}`);
    barOpened = ` · action bar ${opened}: ${s3.tilesSized} tiles measured, none covered`;
  }
  if (/(^|&)webgl=1(&|$)/.test(QUERY) && s.backend !== 'webgl') { fail(`?webgl=1 but backend=${s.backend}`); }
  if (wantXR && s.backend !== 'webgl') { fail(`XR boot without WebGPU-XR must ride WebGL, got backend=${s.backend}`); }
  // arrival means the BODY settled too (unless spectating): a checkReady that stops waiting for it lifts the splash early
  // and still logs ready; the marks tell them apart
  const spectating = /(^|&)(spectate|renderer)(=|&|$)/.test(QUERY);  // viewers by PRESENCE, as base.js reads them: no body of their own
  if (!spectating && !/body: \d+/.test(ready)) { fail(`finished without a body mark (the splash lifted before the body settled): ${ready}`); }
  // the body PATH is read from the scene (EW.me()), not console text: a silent report() must not turn a failed body into "on screen"
  let body;
  if (spectating) body = 'viewer (no body)';
  else if (s.hasBody && s.capsule) { body = `CAPSULE on screen (${bodyErrs.length ? 'after ' + bodyErrs[0].replace(/\s+/g, ' ').slice(0, 60) : 'no avatar error reported — why the capsule?'})`; if (!bodyErrs.length) fail(`the capsule stand-in is on screen but no avatar error was reported — it must only ever follow a failed load`); }
  else if (s.hasBody) { if (bodyErrs.length) fail(`a body is on screen AND the client reported an avatar error: ${bodyErrs[0].slice(0, 120)}`); body = 'body on screen'; }
  else body = `body FAILED → failed-body path (${bodyErrs.length ? bodyErrs[0].replace(/\s+/g, ' ').slice(0, 90) : 'no avatar error reported'})`;
  if (process.env.BOOT_CHECK_REQUIRE_BODY === '1' && !spectating && !s.hasBody) fail(`BOOT_CHECK_REQUIRE_BODY=1 but ${body}`);
  // the capsule counts as 'a body' only when the run MEANT to fail the real one: a library body failing silently must not pass
  const capsuleExpected = ABORT_VRM || /(^|&)capsule(=|&|$)/.test(QUERY);   // the client honours params.has('capsule'), any value
  if (process.env.BOOT_CHECK_REQUIRE_BODY === '1' && !spectating && s.capsule && !capsuleExpected) fail(`BOOT_CHECK_REQUIRE_BODY=1 but the body on screen is the capsule stand-in (${body})`);
  // the splash rays worker exists only where index.html has a .sp-rays canvas: asserted when present, DORMANT when not,
  // never claimed released when it never ran
  let rays;
  // __raysStarted catches the start; the worker's ack (or nogl) catches a broken module, since a Worker that fails to
  // parse doesn't throw. ACK and NOGL pass; silence fails.
  if (s.raysCanvas) { if (!s.raysStarted) { fail('.sp-rays canvas present but __raysStarted was never set (main never reached the start block)'); }
    if (!s.raysAck && !s.raysNoGl) { fail('.sp-rays canvas present but the worker never acknowledged: no first-frame ready and no nogl — a broken worker or a suppressed ack looks exactly like this'); }
    if (s.raysHandle) { fail('the rays worker handle is still advertised after boot (stopRays did not release it)'); }
    rays = s.raysAck ? 'rays acked+released (worker-originated)' : 'rays nogl fallback (worker declined, canvas hidden)'; }
  else rays = 'rays DORMANT (no .sp-rays canvas at this rung)';
  // containment is per-frame but arrangement global, so a wide boot narrowed live can overlap; fitsDefaults() re-fires on resize
  if (RESIZE_TO) {
    const m = /^(\d+)x(\d+)$/.exec(RESIZE_TO);
    if (!m) fail(`BOOT_CHECK_RESIZE_TO="${RESIZE_TO}" is not WxH`);
    await pg.setViewportSize({ width: +m[1], height: +m[2] });
    // the rule runs on the resize event and repaints: settle before measuring
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
