// bun tools/xr-lifecycle-probe.mjs — THE SHIPPING DELEGATION, IN A BROWSER.
//
// Required by the #197 round-three review. The seam modules are executable and well covered, but the
// LINE IN xr.js THAT CALLS THEM is not: rewriting it as `false ? seam(...) : 'throw'` keeps every
// source regex satisfied and leaves the bun suites green. xr.js imports 21 modules including three
// and the renderer, so no bun suite can import it — binding that last line needs the real client.
//
// So: IWER installs a synthetic XRDevice before the client boots, the probe CLICKS THE REAL VISOR,
// and the real enterVR runs. The two mutations the review named must turn this red:
//   1. bypass the handleEntryFailure() call in shipping xr.js
//   2. bypass the installEntryClock() call in shipping xr.js
//
// SwiftShader is fine for these claims. It proves ORCHESTRATION, not rendering quality, foveation,
// controller ergonomics, or the desktop mirror. Those stay with the named real-headset receipt.
// The 'reload' verdict (WebGPU refusal → ?webgl=1) is NOT bound here by design: the probe boots ?xr=1 on a
// host with no XRGPUBinding, and decideBackend (backend_choice.js) gives such a boot WebGL, so gpu is false.
// A host WITH the WebGPU-XR flags rides WebGPU-XR under the same boot — that is the product's intent (R
// 09-07: ONE renderer control) and this probe does not exercise it. Binding 'reload' needs a WebGPU desktop
// boot plus a navigation intercept — a separate probe, not a premise about the host.
//
// Usage: bun tools/xr-lifecycle-probe.mjs [origin]
import { launchBrowser, ownedWorld, checker } from './probe-harness.mjs';
import { readFileSync } from 'node:fs';

const { check, done } = checker();
// A REAL HEADSET'S RUNTIME DOES NOT RUN ITS FRAME LOOP ON window.rAF — that is the entire reason the
// product shims window.rAF onto the session while presenting. IWER's does: its device loop reschedules
// itself with `globalThis.requestAnimationFrame(onDeviceFrame)`, looked up at CALL time
// (lib/session/XRSession.js:81). So once the product installs the shim, that lookup hits the shim,
// routes to session.requestAnimationFrame, and the session dispatches it SYNCHRONOUSLY inside the
// frame it is already in: onDeviceFrame re-enters itself, every level rendering stereo under
// SwiftShader, until V8's stack overflows — then no native frame was ever rescheduled at any level and
// the emulated session goes silently dead. That is why the first cut of this probe printed two checks
// and hung for 420 s with no output (and it is the bench crash the xr_frame_clock header dates 09-07
// 19:15). Pin the emulator's own loop to the NATIVE clock, captured before anything runs, and it does
// what a hardware runtime does: dispatch session callbacks from a clock that is not window.rAF. (Not a
// full hardware model — here both clocks run at 60 Hz, so the probe proves the SWAP happens and is
// undone, not that it helps against a throttled window clock. That claim stays with the headset.)
const IWER_RAW = readFileSync(new URL('../node_modules/iwer/build/iwer.js', import.meta.url), 'utf8');
const DEVICE_LOOP = 'globalThis.requestAnimationFrame(this[P_SESSION].onDeviceFrame)';
if (IWER_RAW.split(DEVICE_LOOP).length !== 2) throw new Error(`iwer build changed: expected exactly one '${DEVICE_LOOP}'`);
const IWER = `globalThis.__iwerNativeRAF = globalThis.requestAnimationFrame.bind(globalThis);\n` +
  IWER_RAW.replace(DEVICE_LOOP, 'globalThis.__iwerNativeRAF(this[P_SESSION].onDeviceFrame)');

const world = await ownedWorld({ live: process.argv[2] ?? null });
const { browser, page } = await launchBrowser();
const pg = await page();
// A pinned main thread makes page.evaluate wait forever, and a probe that hangs prints NOTHING —
// which is what the first cut of this file did. Every evaluate races a clock so the failure has a line.
const ev = (fn, arg) => Promise.race([
  pg.evaluate(fn, arg),
  new Promise((_, rej) => setTimeout(() => rej(new Error('page main thread pinned for 20 s — evaluate never returned')), 20000)),
]);

// IWER before ANY client code: navigator.xr must exist when core.js decides the backend.
await pg.addInitScript(IWER);
await pg.addInitScript(() => {
  if (window.__probe) return;   // idempotence only: each document gets a fresh window, so this never fires in practice
  const { XRDevice, metaQuest3 } = window.IWER ?? {};
  if (!XRDevice) { window.__probe = { fatal: 'IWER did not load' }; return; }
  const device = new XRDevice(metaQuest3);
  window.__probeDeviceKept = true;
  // forceInstall IS REQUIRED. Headless Chromium ships a navigator.xr stub, and IWER declines to
  // clobber an existing runtime — installRuntime() returns early with only a console.warn, so the
  // install silently no-ops and every isSessionSupported('immersive-vr') answers false against
  // Chromium's stub rather than the emulator. (XRDevice.js:340.)
  device.installRuntime({ forceInstall: true });
  window.__probe_installed = navigator.xr?.constructor?.name;
  // THE NON-EMULATED PRODUCT PATH, which is what the review asked the probe to bind. installEntryClock
  // abstains when it sees an IWER on globals — correctly, because IWER drives the session clock ON
  // window.rAF and shimming would feed it to itself. But then the shim install is never exercised.
  // So the emulator stays as the XR RUNTIME and stops advertising itself as an emulator: navigator.xr
  // is synthetic, `globalThis.IWER` is gone, and the product takes exactly the branch a real headset
  // takes. The device object is kept privately for the probe to drive.
  window.__iwerDevice = device;
  try { delete window.IWER; } catch { window.IWER = undefined; }
  // The instrumentation the probe reads. Nothing in the product writes these; they are observations
  // of the REAL objects, so a bypassed call site shows up here as an absence.
  window.__probe = {
    rafOwner: () => (window.requestAnimationFrame.name || '(anon)'),
    nativeRAF: window.requestAnimationFrame,
    sessions: [], grants: 0, requests: 0, failures: [],
  };
  const realRequest = navigator.xr.requestSession.bind(navigator.xr);
  navigator.xr.requestSession = async (...a) => {
    window.__probe.requests++;
    if (window.__probe.failNext > 0) {      // a CONTROLLED busy failure, as the review scripted
      window.__probe.failNext--;
      const e = new Error('there is already an active, immersive XRSession');
      e.name = 'InvalidStateError';
      window.__probe.failures.push(e.name);
      throw e;
    }
    const s = await realRequest(...a);
    window.__probe.grants++; window.__probe.sessions.push(s);
    // PROVE FRAMES. Every check before this counted grants and clock identity; a session that granted and
    // never ticked passed all of them (both reviewers). Count the session callbacks that actually FIRE —
    // three's loop and the product's shim both arrive here — so "driven" is measured, not assumed.
    window.__probe.sessionFrames = 0;
    const sRaf = s.requestAnimationFrame.bind(s);
    s.requestAnimationFrame = (cb) => sRaf((t, fr) => { window.__probe.sessionFrames++; return cb(t, fr); });
    return s;
  };
});

const errs = [];
pg.on('pageerror', (e) => errs.push(String(e)));
// THE IMPORT GRAPH. Mica's red reads xrbtn:false — mictoggle.js never evaluated (its module-load ensure()
// makes the button) — so the stall is a module fetch that never resolved or a top-level await upstream of
// it, and the console is silent about that. Track every request; at an early stop, print what never
// finished and what failed. That is the instrument for "boot stalled before initXR".
const pending = new Map(), failed = [];
pg.on('request', (r) => pending.set(r, Date.now()));
pg.on('requestfinished', (r) => pending.delete(r));
pg.on('requestfailed', (r) => { pending.delete(r); failed.push(`${r.failure()?.errorText ?? 'failed'} ${r.url()}`); });
try {
// pageerror never sees an exception thrown inside a frame callback: frame.js:99 catches per system and
// hands it to report(), which console.error()s `context, err` (base.js:128) — tee() goes to the network,
// NOT the console, so a '[report]' filter here measured nothing and read green. Capture console errors.
const reports = [], artifacts = [], consoleTail = [];
// KNOWN EMULATOR ARTIFACT, disclosed not hidden: IWER's XRWebGLLayer.framebuffer returns null by design
// (lib/layers/XRWebGLLayer.js:44-46 — it draws to the default framebuffer); a real runtime returns an opaque
// WebGLFramebuffer. three's WebGL backend keys a WeakMap on that object (WebGLState.drawBuffers) and throws
// on null. The product's per-system catch (frame.js:99) contains it. Counted and printed; never asserted.
const ARTIFACT = /Invalid value used as weak map key.*WebGLState\.drawBuffers/;
pg.on('console', (m) => {
  consoleTail.push(`${m.type()}: ${m.text().replace(/\s+/g, ' ').slice(0, 200)}`); if (consoleTail.length > 40) consoleTail.shift();
  if (m.type() !== 'error') return;
  const t = `${m.text()} ${m.location()?.url ?? ''}`.replace(/\s+/g, ' ').slice(0, 300);
  if (/status of 401 .*\/whoami/.test(t)) return;   // net.js:254 treats a non-OK /whoami as "not signed in" by design; Chrome logs the fetch anyway
  (ARTIFACT.test(t) ? artifacts : reports).push(t);
});
// ?xr=1 IS THE BOOT MODE, NOT A HOST ACCIDENT (Mica, review host, 2026-09-21). Without it the product
// picks its backend from the host — Chrome on her Mac boots WebGPU — and the first click takes the
// product's reload-to-WebGL branch, navigating away from the probe's state: 8/14 with requests=0. Under
// ?xr=1, decideBackend gives a host WITHOUT XRGPUBinding WebGL (enter in place) and a host WITH it
// WebGPU-XR — either way the click enters without a reload, which is what makes the receipt portable. The
// earlier disclosure "headless is WebGL-only" was a fact about my Linux box, written down as a premise;
// and my first correction misquoted a stale core.js comment as the rule. The rule is backend_choice.js.
await pg.goto(`${world.origin}/?world=staging&name=xrprobe&key=${world.key}&xr=1`, { waitUntil: 'domcontentloaded', timeout: 60000 });
// Wait for the glyph to be VISIBLE: mictoggle shows it only once the product's own isSessionSupported has
// answered and the XR hook is registered (mictoggle.js:214). Forcing display and clicking early was
// clicking before the product said it was ready.
await pg.waitForFunction(() => { const b = document.querySelector('#xrbtn'); return !!b && getComputedStyle(b).display !== 'none'; }, null, { timeout: 60000 }).catch(() => {});
// WHEN THIS GATE FAILS, SAY WHICH LINK BROKE (Mica, round six: intermittent "glyph never visible" on her
// host with no error anywhere). The chain is main.js: await initIdentity() → startFrame() → initXR() →
// isSessionSupported → makeHand×2 → registerXrGlyph → ensure() (needs #hud) → display if pinned && hook.
// Each stage leaves a mark the page can read; a red here names the last one that did.
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
if (!(gs.xrbtn && gs.display !== 'none')) {
  // STOP HERE. Every later check needs a booted product; running them would throw on a missing glyph and
  // (before this) leak the browser and the world. Print what the boot said instead — that is the reason.
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

// An ?xr=1 boot must not have entered on its own, or "the click drove enterVR" is true for the wrong
// reason. enterVR has exactly two callers (the visor handler and the retry effect); this pins it.
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
// WHAT "RESTORED" MEANS. captureNative saves a BOUND copy of the window clock (xr_frame_clock.js:27), so
// a correct restore leaves `bound requestAnimationFrame` — native code, but not `===` the original. The
// first cut of this probe tested identity against the original and called a correct restore a failure.
// The discriminating test: the clock is no longer the shim we watched it become, and it is native code
// (the shim prints as an arrow function; a bound native prints `function () { [native code] }`).
await ev(() => { window.__probe.shim = window.requestAnimationFrame; });
// `bind()` of ANYTHING — including the shim — prints as [native code], so that regex alone would accept
// the exact regression save-once guards against (a bound SHIM captured as "native"). Two sharper facts:
// the product binds native exactly once per page, so the restored object must be IDENTICAL across exits
// and named `bound requestAnimationFrame` (a re-capture yields `bound bound …`); and the desktop loop
// must actually TICK afterwards — the 09-07 22:41 bug left window.rAF native AND the loop dead, because
// three's 'end' listener restarted it through a shim that still pointed at the ended session.
const restoredState = async () => {
  await pg.waitForFunction(() => !window.__iwerDevice?.activeSession, null, { timeout: 10000 }).catch(() => {});
  const a = await ev(() => ({ f0: globalThis.__perf?.frameNo ?? -1, t: performance.now() }));
  // a condition, not a clock: a 700 ms window wanted ≥2 frames, which is a 3 Hz floor for SwiftShader —
  // it read 1 under a real asset library (1 of 5 runs, 09-21). The dead-loop bug advances by exactly 0,
  // so waiting for +2 with a bound keeps the mutation red and stops the speed of the host being the verdict.
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
await pg.waitForTimeout(600);
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
// WAIT FOR THE CONDITION, NOT THE CLOCK. A fixed 3.5 s read `requests=1` in 1 of 5 runs here (the 1.5 s
// retry timer ran late under a SwiftShader render storm) and would read it more often on a slower host.
await pg.waitForFunction(() => window.__probe.grants >= 1 || window.__probe.requests >= 3, null, { timeout: 15000 }).catch(() => {});
const afterBusy = await ev(() => ({ requests: window.__probe.requests, grants: window.__probe.grants }));
check('a busy failure is retried EXACTLY once by the shipping path — handleEntryFailure ran',
  afterBusy.requests === 2 && afterBusy.grants === 1,
  `requests=${afterBusy.requests} grants=${afterBusy.grants} (want 2 requests, 1 grant)`);
// THE VERDICT IS OBEYED, not just produced: `handleEntryFailure(...); throw e;` keeps the retry (the seam's
// side effects schedule it) so the counts above stay green — but the rethrow lands in enterVR's outer
// catch, which posts a 30 s 'err' toast the 'handled' path never does.
const failToasts = await ev(() => [...document.querySelectorAll('.toast.err')].map((n) => n.textContent.trim().slice(0, 120)).filter((t) => /VR failed to start/.test(t)));
check("…and the 'handled' verdict was OBEYED: no 'VR failed to start' toast for a handled busy failure", failToasts.length === 0, JSON.stringify(failToasts));
await ev(async () => { await window.__iwerDevice.activeSession?.end(); });
await pg.waitForFunction(() => !window.__iwerDevice?.activeSession, null, { timeout: 10000 }).catch(() => {});

// ── 5. two busy failures: one retry, then give up — NO third request ──────────
await ev(() => { window.__probe.failNext = 2; window.__probe.requests = 0; window.__probe.grants = 0; });
await clickVisor();
// two requests must happen (click + one retry); then one more full retry window must pass with NO third
await pg.waitForFunction(() => window.__probe.requests >= 2, null, { timeout: 15000 }).catch(() => {});
await pg.waitForTimeout(2500);   // > BUSY_RETRY_MS (1500): a third request would have landed by now
const afterGiveUp = await ev(() => ({ requests: window.__probe.requests, grants: window.__probe.grants }));
check('a SECOND busy failure gives up rather than retrying forever',
  afterGiveUp.requests === 2 && afterGiveUp.grants === 0,
  `requests=${afterGiveUp.requests} grants=${afterGiveUp.grants} (want exactly 2 requests, 0 grants)`);

check('no page errors during the whole lifecycle', errs.length === 0, errs.slice(0, 2).join(' | '));
check('no console.error during the whole lifecycle (report() speaks here)', reports.length === 0, `${reports.length}: ` + reports.slice(0, 4).join('\n      '));
if (artifacts.length) console.log(`  · ${artifacts.length} known-emulator-artifact error(s) (IWER null framebuffer → three WeakMap) — disclosed, not counted`);

} finally {
  // ALWAYS: a throw anywhere above used to leak the owned Chrome and the world server (Mica had to kill them).
  try { await browser.close(); } catch {}
  try { await world.close(); } catch {}
}
done();
