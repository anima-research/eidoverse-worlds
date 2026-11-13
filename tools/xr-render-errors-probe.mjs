// bun tools/xr-render-errors-probe.mjs [--shots <dir>] [--frames N] [--control] — A VR SESSION RENDERS WITHOUT A SINGLE RENDER ERROR.
// Every IWER session logged `frame render TypeError: Invalid value used as weak map key at WebGLState.drawBuffers`
// ~0.5 s after entry (spotted in passing at eb300ee). Cause (xr_nullfb.js): the emulator's XRWebGLLayer.framebuffer is
// null — it draws to the default framebuffer — and three r186's WebGL backend keys a WeakMap on that framebuffer. The
// throw lands inside renderer._renderOutput between `xr.enabled = false; autoClear = false` and their restore, so it
// also left XR switched OFF on the renderer: later frames drew the desktop camera into the canvas, not the eyes.
// Checks, over N session frames (default 40), on the real client (?xr=1), the real visor click, IWER (Quest 3):
//   errors  — zero `frame …` reports (report() rate-limits but ALWAYS prints the first, so zero is meaningful)
//   state   — renderer.xr.enabled and autoClear are still on, and the session is presenting
//   eyes    — the eye output really reaches the layer: every app frame in the session draws into the XR target
// --control disarms the fix before entry (xr_nullfb's handle) — the checks above must go red.
//   gated   — the fix installed only because this session's layer framebuffer is null (on hardware it never does)
// Real hardware returns an opaque WebGLFramebuffer here and never took this path; this is the emulator's (and the
// Immersive Web Emulator extension's) path, which every headless VR probe rides.
// Run one headless browser at a time; clouds are forced off before boot here.
import { launchBrowser, ownedWorld, checker } from './probe-harness.mjs';
import { readFileSync, mkdirSync } from 'node:fs';

const { check, done } = checker();
const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };
const shotDir = arg('--shots'); const FRAMES = Number(arg('--frames') ?? 40); const CONTROL = process.argv.includes('--control');
if (shotDir) mkdirSync(shotDir, { recursive: true });
const IWER_RAW = readFileSync(new URL('../node_modules/iwer/build/iwer.js', import.meta.url), 'utf8');
const DEVICE_LOOP = 'globalThis.requestAnimationFrame(this[P_SESSION].onDeviceFrame)';
if (IWER_RAW.split(DEVICE_LOOP).length !== 2) throw new Error(`iwer build changed: expected exactly one '${DEVICE_LOOP}'`);
const IWER = `globalThis.__iwerNativeRAF = globalThis.requestAnimationFrame.bind(globalThis);\n` +
  IWER_RAW.replace(DEVICE_LOOP, 'globalThis.__iwerNativeRAF(this[P_SESSION].onDeviceFrame)');

const world = await ownedWorld({ env: { SKIP_OPT_SWEEP: '1' } });
const { browser, page } = await launchBrowser();
const pg = await page();
const ev = (fn, a) => Promise.race([pg.evaluate(fn, a), new Promise((_, rej) => setTimeout(() => rej(new Error('page main thread pinned for 30 s')), 30000))]);

await pg.addInitScript(() => { try { localStorage.setItem('ew-cloud-quality', 'off'); } catch {} });   // THE SKY GUARD, before boot
await pg.addInitScript(IWER);
await pg.addInitScript(() => {
  if (window.__probe) return;
  const { XRDevice, metaQuest3 } = window.IWER ?? {};
  if (!XRDevice) { window.__probe = { fatal: 'IWER did not load' }; return; }
  const device = new XRDevice(metaQuest3);
  device.installRuntime({ forceInstall: true });
  window.__iwerDevice = device;
  try { delete window.IWER; } catch { window.IWER = undefined; }
  window.__probe = { grants: 0, sessionFrames: 0 };
  const real = navigator.xr.requestSession.bind(navigator.xr);
  navigator.xr.requestSession = async (...a) => {
    const s = await real(...a); window.__probe.grants++; window.__probe.frameAtGrant = globalThis.__perf?.frameNo ?? NaN;
    const sRaf = s.requestAnimationFrame.bind(s);
    s.requestAnimationFrame = (cb) => sRaf((t, fr) => { window.__probe.sessionFrames++; return cb(t, fr); });
    return s;
  };
});
const frameErrs = [], otherErrs = [], pageErrs = [];
pg.on('pageerror', (e) => pageErrs.push(String(e)));
pg.on('console', (m) => {
  if (m.type() !== 'error') return;
  const t = m.text().replace(/\s+/g, ' ').slice(0, 300);
  if (/status of 401/.test(t)) return;   // net.js: a non-OK /whoami is "not signed in" by design
  (/^frame \S+ /.test(t) ? frameErrs : otherErrs).push(t);
});
pg.on('dialog', (d) => d.dismiss().catch(() => {}));

try {
  await pg.goto(`${world.origin}/?world=staging&name=xrerrprobe&key=${world.key}&xr=1`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await pg.waitForFunction(() => { const b = document.querySelector('#xrbtn'); return !!b && getComputedStyle(b).display !== 'none'; }, null, { timeout: 90000 }).catch(() => {});
  const boot = await ev(async () => ({ xrbtn: !!document.querySelector('#xrbtn'), fatal: window.__probe?.fatal ?? null, backend: (await import('./lib/core.js')).backendName() }));
  check('booted on the WebGL backend with the visor showing (her headset\'s path)', boot.xrbtn && !boot.fatal && boot.backend === 'webgl', JSON.stringify(boot));
  if (!boot.xrbtn) throw new Error('boot gate failed');
  const deskErrs = frameErrs.length;

  // count the eye output's drawBuffers calls (the XR render target) — observation only, passes straight through
  const fix = await ev(async (control) => {
    const { renderer } = await import('./lib/core.js');
    const st = renderer.backend.state;
    const had = !!globalThis.__xrNullFb && !globalThis.__xrNullFb.installed;   // armed, not yet installed before a session
    if (control) globalThis.__xrNullFb?.disarm();
    const od = st.drawBuffers;
    window.__probe.xrDraws = 0;
    st.drawBuffers = function (rc, fb) { if (rc?.renderTarget?.isXRRenderTarget) window.__probe.xrDraws++; return od.call(this, rc, fb); };
    return { installed: had, control };
  }, CONTROL);
  console.log(`  · fix ${fix.installed ? 'armed, not installed before entry' : 'ABSENT or pre-installed'}${fix.control ? ' — CONTROL RUN: disarmed' : ''}`);
  check('gated: before any session the fix is armed but nothing is patched', fix.installed, JSON.stringify(fix));
  await ev(() => document.querySelector('#xrbtn').click());
  // a pre-entry voice ask (the mic-consent step in flight on this branch) may stand between the click and the session:
  // answer "Not now" if one shows, so this probe measures rendering and nothing about voice
  await pg.waitForFunction(() => {
    if (window.__probe.grants > 0) return true;
    const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === 'Not now' && x.offsetParent);
    if (b) b.click();
    return false;
  }, null, { timeout: 60000, polling: 500 }).catch(() => {});
  await pg.waitForFunction((n) => window.__probe.sessionFrames >= n, FRAMES, { timeout: 240000, polling: 500 }).catch(() => {});
  const st = await ev(async () => {
    const { renderer } = await import('./lib/core.js');
    const base = renderer.xr._glBaseLayer;
    return { appFrames: (globalThis.__perf?.frameNo ?? NaN) - window.__probe.frameAtGrant, grants: window.__probe.grants, frames: window.__probe.sessionFrames, presenting: renderer.xr.isPresenting, xrEnabled: renderer.xr.enabled,
      autoClear: renderer.autoClear, fixInstalled: !!globalThis.__xrNullFb?.installed, xrDraws: window.__probe.xrDraws, baseFb: base ? String(base.framebuffer) : 'no base layer' };
  });
  console.log(`  · after ${st.frames} session frames: ${JSON.stringify(st)}`);
  // for the eye (not asserted): the session's screen after a 180° head turn — fixed, the eyes show the world behind;
  // under --control the desktop path drew instead (and on 09-30 the desktop-mirror guard tripped its banner)
  if (shotDir) {
    const turnAt = await ev(() => { window.__iwerDevice.quaternion.set(0, 1, 0, 0); return window.__probe.sessionFrames; });
    await pg.waitForFunction((n) => window.__probe.sessionFrames >= n, turnAt + 8, { timeout: 60000, polling: 500 }).catch(() => {});
    const f = `${shotDir}/xr-render-${CONTROL ? 'control-' : ''}turned-180.png`; await pg.screenshot({ path: f }); console.log(`  · shot ${f}`);
  }
  check(`entered: one session granted, ${FRAMES} session frames ticked`, st.grants === 1 && st.frames >= FRAMES, `grants=${st.grants} frames=${st.frames}`);
  if (!CONTROL) check('gated: the session\'s null layer framebuffer installed it', st.fixInstalled && st.baseFb === 'null', `installed=${st.fixInstalled} baseFb=${st.baseFb}`);
  check('errors: zero `frame …` render reports during the session', frameErrs.length - deskErrs === 0, frameErrs.slice(deskErrs, deskErrs + 2).join(' | '));
  check('state: the renderer is still presenting with XR on and autoClear restored', st.presenting && st.xrEnabled && st.autoClear, JSON.stringify({ presenting: st.presenting, xrEnabled: st.xrEnabled, autoClear: st.autoClear }));
  check('eyes: every app frame in the session draws into the XR target', st.appFrames > 0 && st.xrDraws >= st.appFrames, `${st.xrDraws} XR-target draws over ${st.appFrames} app frames (${st.frames} session callbacks)`);
  check('no page errors', pageErrs.length === 0, pageErrs.slice(0, 2).join(' | '));
  if (otherErrs.length) console.log(`  · other console errors (not asserted): ${otherErrs.length}: ${otherErrs.slice(0, 3).join(' | ')}`);
  await ev(() => window.__iwerDevice.activeSession?.end()).catch(() => {});
} finally {
  try { await browser.close(); } catch {}
  try { await world.close(); } catch {}
}
done();
