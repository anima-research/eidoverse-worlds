// bun test/client/xr-lifecycle-probe.mjs: THE SHIPPING DELEGATION, IN A BROWSER. The LINE IN xr.js THAT CALLS the seam modules
// can only be bound in the real client (no bun suite can import xr.js): IWER installs a synthetic XRDevice before boot,
// the probe CLICKS THE REAL VISOR, and the real enterVR runs. These mutations must turn it red:
//   1. bypass the handleEntryFailure() call in shipping xr.js
//   2. bypass the installEntryClock() call in shipping xr.js
// SwiftShader proves ORCHESTRATION, not rendering quality, foveation or ergonomics. The 'reload' verdict (WebGPU refusal
// → ?webgl=1) isn't bound here: ?xr=1 without XRGPUBinding boots WebGL (backend_choice.js decideBackend).
// Usage: bun test/client/xr-lifecycle-probe.mjs [origin]
import { launchBrowser, ownedWorld, checker, iwerInit, enterVR } from '../harness/probe-harness.mjs';
import { pause } from '../gate/wait.ts';

const { check, done } = checker();
// IWER's device loop rides the NATIVE clock, as a headset runtime does (probe-harness iwerSource). Both clocks run at
// 60 Hz here, so this proves the swap happens and is undone, not that it helps a throttled window clock

const world = await ownedWorld({ live: process.argv[2] ?? null });
const { browser, page } = await launchBrowser();
const pg = await page();
// a pinned main thread makes page.evaluate wait forever and a hung probe prints NOTHING: every evaluate races a clock
const ev = (fn, arg) => Promise.race([
  pg.evaluate(fn, arg),
  new Promise((_, rej) => setTimeout(() => rej(new Error('page main thread pinned for 20 s — evaluate never returned')), 20000)),
]);

// IWER before ANY client code: navigator.xr must exist when core.js decides the backend. iwerInit hides it (no
// `globalThis.IWER`) so the product takes a real headset's branch (installEntryClock abstains under an emulator)
await iwerInit(pg);
await pg.addInitScript(() => {
  if (window.__probe) return;   // idempotence only: each document gets a fresh window, so this never fires in practice
  if (!window.__iwerDevice) { window.__probe = { fatal: 'IWER did not load' }; return; }
  window.__probe_installed = navigator.xr?.constructor?.name;
  // instrumentation the probe reads: observations of the REAL objects (nothing in the product writes these), so a bypassed
  // call site shows as an absence
  window.__probe = {
    rafOwner: () => (window.requestAnimationFrame.name || '(anon)'),
    nativeRAF: window.requestAnimationFrame,
    sessions: [], grants: 0, requests: 0, failures: [],
  };
  const realRequest = navigator.xr.requestSession.bind(navigator.xr);
  navigator.xr.requestSession = async (...a) => {
    window.__probe.requests++;
    if (window.__probe.failNext > 0) {      // a CONTROLLED busy failure
      window.__probe.failNext--;
      const e = new Error('there is already an active, immersive XRSession');
      e.name = 'InvalidStateError';
      window.__probe.failures.push(e.name);
      throw e;
    }
    const s = await realRequest(...a);
    window.__probe.grants++; window.__probe.sessions.push(s);
    // PROVE FRAMES: a session that granted and never ticked passes every grant/clock check, so count the session callbacks
    // that actually FIRE (three's loop and the product's shim both arrive here)
    window.__probe.sessionFrames = 0;
    const sRaf = s.requestAnimationFrame.bind(s);
    s.requestAnimationFrame = (cb) => sRaf((t, fr) => { window.__probe.sessionFrames++; return cb(t, fr); });
    return s;
  };
});

const errs = [];
pg.on('pageerror', (e) => errs.push(String(e)));
// THE IMPORT GRAPH: a boot that stalls before initXR is a module fetch or top-level await the console is silent about,
// so track every request and, at an early stop, print what never finished and what failed
const pending = new Map(), failed = [];
pg.on('request', (r) => pending.set(r, Date.now()));
pg.on('requestfinished', (r) => pending.delete(r));
pg.on('requestfailed', (r) => { pending.delete(r); failed.push(`${r.failure()?.errorText ?? 'failed'} ${r.url()}`); });
try {
// pageerror never sees an exception thrown inside a frame callback (frameloop.js catches per system and hands it to
// report(), which console.error()s; tee() goes to the network, not the console): capture console errors
// IWER's null XRWebGLLayer.framebuffer is handled by client/lib/xr/xr_nullfb.js: its WeakMap error counts here like any other
const reports = [], consoleTail = [];
pg.on('console', (m) => {
  consoleTail.push(`${m.type()}: ${m.text().replace(/\s+/g, ' ').slice(0, 200)}`); if (consoleTail.length > 40) consoleTail.shift();
  if (m.type() !== 'error') return;
  const t = `${m.text()} ${m.location()?.url ?? ''}`.replace(/\s+/g, ' ').slice(0, 300);
  if (/status of 401 .*\/whoami/.test(t)) return;   // net.js treats a non-OK /whoami as "not signed in" by design; Chrome logs the fetch anyway
  reports.push(t);
});
// ?xr=1 IS THE BOOT MODE: without it a WebGPU host's first click reloads to WebGL and leaves the probe's state; with it
// the click enters in place on any host (client/lib/render/backend_choice.js decideBackend)
await pg.goto(`${world.origin}/?world=staging&name=xrprobe&key=${world.key}&xr=1`, { waitUntil: 'domcontentloaded', timeout: 60000 });
// wait for the glyph to be VISIBLE: mictoggle shows it only once the product's own isSessionSupported answered and the
// XR hook is registered; clicking earlier is before the product said it was ready
await pg.waitForFunction(() => { const b = document.querySelector('#xrbtn'); return !!b && getComputedStyle(b).display !== 'none'; }, null, { timeout: 60000 }).catch(() => {});
// WHEN THIS GATE FAILS, SAY WHICH LINK BROKE: initIdentity → startFrame → initXR → isSessionSupported → makeHand×2 →
// registerXrGlyph → ensure() (needs #hud) → display; a red names the last stage that left its mark
const glyphStage = () => ev(async () => {
  const b = document.querySelector('#xrbtn');
  let pin = null; try { pin = localStorage.getItem('ew-xr-pinned'); } catch {}
  return {
    href: location.href.replace(/key=[^&]+/, 'key=…'), visibility: document.visibilityState,
    engineUp: !!globalThis.__ewEngineUp,                          // core.js past renderer.init()
    frameNo: globalThis.__perf?.frameNo ?? null,                   // startFrame() ran → initXR() was CALLED
    supported: await navigator.xr.isSessionSupported('immersive-vr'),
    hud: !!document.querySelector('#hud'),                        // ensure() needs it
    xrbtn: !!b, display: b ? getComputedStyle(b).display : null,  // exists ⇒ registerXrGlyph ran; visible ⇒ pinned && hook
    pinned: pin === null ? 'default(true)' : pin,
    hudAbsent: !!b && b.classList.contains('hud-absent'),
  };
});
const gs = await glyphStage();
console.log(`  · glyph stage: ${JSON.stringify(gs)}`);   // printed on green too, so a red has something to compare to
check('the visor glyph became visible on its own (XR hook registered)', gs.xrbtn && gs.display !== 'none', JSON.stringify(gs));
check('a headset machine installed the dual warm (xrwarm.js: both variants at load; in-session compiles land where frames draw)',
  await ev(() => globalThis.__xrDualWarm === true), String(await ev(() => globalThis.__xrDualWarm)));
if (!(gs.xrbtn && gs.display !== 'none')) {
  // STOP HERE: every later check needs a booted product (and would leak the browser and the world); print the boot's reason
  console.log(`  · boot did not reach the glyph. page errors (${errs.length}): ${errs.slice(0, 3).join(' | ') || '—'}`);
  console.log(`  · console.error (${reports.length}): ${reports.slice(0, 3).join(' | ') || '—'}`);
  console.log(`  · last console lines (${consoleTail.length}):\n      ${consoleTail.slice(-15).join('\n      ')}`);
  const now = Date.now();
  const stuck = [...pending.entries()].map(([r, t]) => `${((now - t) / 1000).toFixed(1)}s ${r.resourceType()} ${r.url().replace(/key=[^&]+/, 'key=…')}`);
  console.log(`  · requests still PENDING at the stop (${stuck.length}):\n      ${stuck.slice(0, 12).join('\n      ') || '—'}`);
  console.log(`  · requests FAILED (${failed.length}):\n      ${failed.slice(0, 12).join('\n      ') || '—'}`);
  if (gs.xrbtn === false) console.log('  · xrbtn:false ⇒ mictoggle.js never evaluated: the stall is in the import graph BEFORE it (a fetch above, or an upstream top-level await), not in renderer.init()');
  throw new Error('readiness gate failed — stopped before entry; see the stage line and the boot output above');
}

const probeOk = await ev(() => !!window.__probe && !window.__probe.fatal);
check('IWER installed a synthetic XR runtime before the client booted', probeOk,
  await ev(() => window.__probe?.fatal ?? 'no __probe'));
check('the client sees an immersive-vr capable device',
  await ev(async () => await navigator.xr.isSessionSupported('immersive-vr')),
  await ev(() => `navigator.xr is ${window.__probe_installed}`));

// ── 1. the shipping entry path, driven by the real visor ──────────────────────
const clickVisor = () => ev(() => { document.querySelector('#xrbtn').click(); });   // as shown, not forced

// an ?xr=1 boot must not have entered on its own, or "the click drove enterVR" is true for the wrong reason (enterVR's
// two callers are the visor handler and the retry effect)
check('no session was requested before the first click (an XR boot warms, it does not enter)',
  await ev(() => window.__probe.requests === 0), await ev(() => `requests=${window.__probe.requests} before any click`));
await clickVisor();
await pg.waitForFunction(() => window.__probe.grants > 0 || window.__probe.requests > 2, null, { timeout: 30000 }).catch(() => {});
const afterEnter = await ev(() => ({
  requests: window.__probe.requests, grants: window.__probe.grants,
  presenting: !!window.__iwerDevice?.activeSession,
  rafIsNative: window.requestAnimationFrame === window.__probe.nativeRAF,
  rafSrc: String(window.requestAnimationFrame).slice(0, 60),
}));
// WHAT "RESTORED" MEANS: captureNative saves a BOUND copy (xr_frame_clock.js), never `===` the original, so restored
// = no longer the shim we watched, and native code (a bound native prints `function () { [native code] }`)
await ev(() => { window.__probe.shim = window.requestAnimationFrame; });
// a bound shim prints as [native code] too, so also: the restored object is IDENTICAL across exits and named
// `bound requestAnimationFrame` (a re-capture is `bound bound …`), and the desktop loop must actually TICK afterwards
const restoredState = async () => {
  await pg.waitForFunction(() => !window.__iwerDevice?.activeSession, null, { timeout: 10000 }).catch(() => {});
  const a = await ev(() => ({ f0: globalThis.__perf?.frameNo ?? -1, t: performance.now() }));
  // a condition, not a clock: a fixed window is a frame-rate floor SwiftShader can miss; the dead-loop bug advances by
  // exactly 0, so waiting for +2 with a bound keeps the mutation red without the host's speed being the verdict
  await pg.waitForFunction((f0) => (globalThis.__perf?.frameNo ?? -1) - f0 >= 2, a.f0, { timeout: 10000 }).catch(() => {});
  return ev((a) => {
    const f = window.requestAnimationFrame;
    if (!window.__probe.restoredObj) window.__probe.restoredObj = f;   // exit 1 sets the reference
    return { isShim: f === window.__probe.shim, name: f.name, sameObjAsFirstExit: f === window.__probe.restoredObj,
             desktopFramesAfterExit: (globalThis.__perf?.frameNo ?? -1) - a.f0, presenting: !!window.__iwerDevice?.activeSession };
  }, a);
};
const isRestored = (st) => !st.isShim && st.name === 'bound requestAnimationFrame' && st.sameObjAsFirstExit && st.desktopFramesAfterExit >= 2;   // SwiftShader desktop renders at ~4 Hz; the dead-loop bug reads exactly 0
check('clicking the visor drove the real enterVR to a granted session',
  afterEnter.grants === 1, JSON.stringify(afterEnter));
check('installEntryClock SHIMMED window.requestAnimationFrame on the NON-EMULATED product path',
  afterEnter.rafIsNative === false,
  `window.rAF is still native — the install was bypassed (IWER visible to the product? ${await ev(() => !!globalThis.IWER)})`);
await pause('the session frame loop runs for 600 ms', 600);
const sf = await ev(() => window.__probe.sessionFrames);
check('the XR frame loop is DRIVEN: session callbacks fired after the grant', sf > 5, `sessionFrames=${sf} in 600 ms`);

// ── 2. exit restores the desktop clock ────────────────────────────────────────
await ev(async () => { await window.__iwerDevice.activeSession?.end(); });
const afterExit = await restoredState();
check('session end restores the desktop clock', isRestored(afterExit), JSON.stringify(afterExit));

// ── 3. re-entry, and a stale completion cannot affect it ──────────────────────
await clickVisor();
await pg.waitForFunction(() => window.__probe.grants > 1, null, { timeout: 30000 }).catch(() => {});
const afterReenter = await ev(() => ({
  grants: window.__probe.grants,
  rafIsNative: window.requestAnimationFrame === window.__probe.nativeRAF,
}));
check('re-entry grants a second session', afterReenter.grants === 2, JSON.stringify(afterReenter));
check('…and the second session owns the clock', afterReenter.rafIsNative === false);
await ev(() => { window.__probe.shim = window.requestAnimationFrame; });   // the SECOND session's shim
await ev(async () => { await window.__iwerDevice.activeSession?.end(); });
const afterExit2 = await restoredState();
check('…and its exit restores the desktop clock again', isRestored(afterExit2), JSON.stringify(afterExit2));

// ── 4. a CONTROLLED busy failure: exactly one retry, then give up ─────────────
await ev(() => { window.__probe.failNext = 1; window.__probe.requests = 0; window.__probe.grants = 0; });
await clickVisor();
// WAIT FOR THE CONDITION, NOT THE CLOCK: the 1.5 s retry timer runs late under a SwiftShader render storm
await pg.waitForFunction(() => window.__probe.grants >= 1 || window.__probe.requests >= 3, null, { timeout: 15000 }).catch(() => {});
const afterBusy = await ev(() => ({ requests: window.__probe.requests, grants: window.__probe.grants }));
check('a busy failure is retried EXACTLY once by the shipping path — handleEntryFailure ran',
  afterBusy.requests === 2 && afterBusy.grants === 1,
  `requests=${afterBusy.requests} grants=${afterBusy.grants} (want 2 requests, 1 grant)`);
// THE VERDICT IS OBEYED, not just produced: `handleEntryFailure(...); throw e;` keeps the retry (the counts stay green),
// but the rethrow lands in enterVR's outer catch, which posts a 30 s 'err' toast the 'handled' path never does
const failToasts = await ev(() => [...document.querySelectorAll('.toast.err')].map((n) => n.textContent.trim().slice(0, 120)).filter((t) => /VR failed to start/.test(t)));
check("…and the 'handled' verdict was OBEYED: no 'VR failed to start' toast for a handled busy failure", failToasts.length === 0, JSON.stringify(failToasts));
await ev(async () => { await window.__iwerDevice.activeSession?.end(); });
await pg.waitForFunction(() => !window.__iwerDevice?.activeSession, null, { timeout: 10000 }).catch(() => {});

// ── 5. two busy failures: one retry, then give up — NO third request ──────────
await ev(() => { window.__probe.failNext = 2; window.__probe.requests = 0; window.__probe.grants = 0; });
await clickVisor();
// two requests must happen (click + one retry); then one more full retry window must pass with NO third
await pg.waitForFunction(() => window.__probe.requests >= 2, null, { timeout: 15000 }).catch(() => {});
await pause('> BUSY_RETRY_MS (1500): a third request would have landed by now', 2500);
const afterGiveUp = await ev(() => ({ requests: window.__probe.requests, grants: window.__probe.grants }));
check('a SECOND busy failure gives up rather than retrying forever',
  afterGiveUp.requests === 2 && afterGiveUp.grants === 0,
  `requests=${afterGiveUp.requests} grants=${afterGiveUp.grants} (want exactly 2 requests, 0 grants)`);

check('no page errors during the whole lifecycle', errs.length === 0, errs.slice(0, 2).join(' | '));
check('no console.error during the whole lifecycle (report() speaks here)', reports.length === 0, `${reports.length}: ` + reports.slice(0, 4).join('\n      '));

} finally {
  // ALWAYS: a throw anywhere above must not leak the owned Chrome and the world server
  try { await browser.close(); } catch {}
  try { await world.close(); } catch {}
}
done();
