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
//
// Usage: bun tools/xr-lifecycle-probe.mjs [origin]
import { launchBrowser, ownedWorld, checker } from './probe-harness.mjs';
import { readFileSync } from 'node:fs';

const { check, done } = checker();
const IWER = readFileSync(new URL('../node_modules/iwer/build/iwer.js', import.meta.url), 'utf8');

const world = await ownedWorld({ live: process.argv[2] ?? null });
const { browser, page } = await launchBrowser();
const pg = await page();

// IWER before ANY client code: navigator.xr must exist when core.js decides the backend.
await pg.addInitScript(IWER);
await pg.addInitScript(() => {
  // RUN ONCE. addInitScript fires on every navigation and every frame; the block below deletes
  // window.IWER on purpose, so a second run would take the !XRDevice branch and overwrite __probe —
  // wiping the counters the probe waits on, which hangs it. Guard first, delete later.
  if (window.__probe) return;
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
    return s;
  };
});

const errs = [];
pg.on('pageerror', (e) => errs.push(String(e)));
await pg.goto(`${world.origin}/?world=staging&name=xrprobe&key=${world.key}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
await pg.waitForFunction(() => document.querySelector('#xrbtn'), null, { timeout: 60000 }).catch(() => {});

const probeOk = await pg.evaluate(() => !!window.__probe && !window.__probe.fatal);
check('IWER installed a synthetic XR runtime before the client booted', probeOk,
  await pg.evaluate(() => window.__probe?.fatal ?? 'no __probe'));
check('the client sees an immersive-vr capable device',
  await pg.evaluate(async () => await navigator.xr.isSessionSupported('immersive-vr')),
  await pg.evaluate(() => `navigator.xr is ${window.__probe_installed}`));

// ── 1. the shipping entry path, driven by the real visor ──────────────────────
const clickVisor = () => pg.evaluate(() => { const b = document.querySelector('#xrbtn'); b.style.display = 'block'; b.click(); });

await clickVisor();
await pg.waitForFunction(() => window.__probe.grants > 0 || window.__probe.requests > 2, null, { timeout: 30000 }).catch(() => {});
const afterEnter = await pg.evaluate(() => ({
  requests: window.__probe.requests, grants: window.__probe.grants,
  presenting: !!window.__iwerDevice?.activeSession,
  rafIsNative: window.requestAnimationFrame === window.__probe.nativeRAF,
}));
check('clicking the visor drove the real enterVR to a granted session',
  afterEnter.grants === 1, JSON.stringify(afterEnter));
check('installEntryClock SHIMMED window.requestAnimationFrame on the NON-EMULATED product path',
  afterEnter.rafIsNative === false,
  `window.rAF is still native — the install was bypassed (IWER visible to the product? ${await pg.evaluate(() => !!globalThis.IWER)})`);

// ── 2. exit restores the desktop clock ────────────────────────────────────────
await pg.evaluate(async () => { await window.__iwerDevice.activeSession?.end(); });
await pg.waitForTimeout(400);
const afterExit = await pg.evaluate(() => ({
  rafIsNative: window.requestAnimationFrame === window.__probe.nativeRAF,
  presenting: !!window.__iwerDevice?.activeSession,
}));
check('session end restores the desktop clock', afterExit.rafIsNative === true, JSON.stringify(afterExit));

// ── 3. re-entry, and a stale completion cannot affect it ──────────────────────
await clickVisor();
await pg.waitForFunction(() => window.__probe.grants > 1, null, { timeout: 30000 }).catch(() => {});
const afterReenter = await pg.evaluate(() => ({
  grants: window.__probe.grants,
  rafIsNative: window.requestAnimationFrame === window.__probe.nativeRAF,
}));
check('re-entry grants a second session', afterReenter.grants === 2, JSON.stringify(afterReenter));
check('…and the second session owns the clock', afterReenter.rafIsNative === false);
await pg.evaluate(async () => { await window.__iwerDevice.activeSession?.end(); });
await pg.waitForTimeout(400);
check('…and its exit restores the desktop clock again',
  await pg.evaluate(() => window.requestAnimationFrame === window.__probe.nativeRAF));

// ── 4. a CONTROLLED busy failure: exactly one retry, then give up ─────────────
await pg.evaluate(() => { window.__probe.failNext = 1; window.__probe.requests = 0; window.__probe.grants = 0; });
await clickVisor();
await pg.waitForTimeout(3500);   // BUSY_RETRY_MS is 1500; one retry lands inside this window
const afterBusy = await pg.evaluate(() => ({ requests: window.__probe.requests, grants: window.__probe.grants }));
check('a busy failure is retried EXACTLY once by the shipping path — handleEntryFailure ran',
  afterBusy.requests === 2 && afterBusy.grants === 1,
  `requests=${afterBusy.requests} grants=${afterBusy.grants} (want 2 requests, 1 grant)`);
await pg.evaluate(async () => { await window.__iwerDevice.activeSession?.end(); });

// ── 5. two busy failures: one retry, then give up — NO third request ──────────
await pg.evaluate(() => { window.__probe.failNext = 2; window.__probe.requests = 0; window.__probe.grants = 0; });
await clickVisor();
await pg.waitForTimeout(4000);
const afterGiveUp = await pg.evaluate(() => ({ requests: window.__probe.requests, grants: window.__probe.grants }));
check('a SECOND busy failure gives up rather than retrying forever',
  afterGiveUp.requests === 2 && afterGiveUp.grants === 0,
  `requests=${afterGiveUp.requests} grants=${afterGiveUp.grants} (want exactly 2 requests, 0 grants)`);

check('no page errors during the whole lifecycle', errs.length === 0, errs.slice(0, 2).join(' | '));

await browser.close(); await world.close();
done();
