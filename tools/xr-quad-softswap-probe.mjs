// bun tools/xr-quad-softswap-probe.mjs — THE VR PANELS' SOFT SWAP, IN THE REAL CLIENT.
//
// domquad.js (the default VR panels) used to build an HTMLMesh per frame at EVERY entry — each one
// rasterising its whole frame synchronously on the main thread, for quads that start hidden — and throw
// them all away at exit. Now: staged every session, built on first show, kept across sessions. And the
// ring's 'panels' slot was dead on this path (its xr:panels listener was registered only below the domquad
// return in xrPanelsEnter). What this binds, each with the mutation that must turn it red:
//   lazy        — no quad is built at entry            (mutate: setVisible(q, true) at entry)
//   ring        — the ring's real 'panels' act shows them  (mutate: subscribe below the domquad return)
//   kept        — a re-entry reuses the SAME meshes    (mutate: drop(q) at exit)
//   returned    — every element is back on the desktop after exit, its observer suspended
//   ring lit    — the ring reads shown quads as open (xrPanelOpen → domQuadOpen)
// NOT covered here: whether xrPanelsExit drops the ring subscription (on this path a leaked toggle after exit is inert
// by construction — exit nulls the staged quads — so no observable here could fail); the ?canvasquads fallback path (kept/disposePanel/stale repaint) and domquad's resize rebuild
// (builtAt) — the default path above is what ships; the fallback is a debug flag.
// SwiftShader + IWER prove orchestration, not what a headset feels. The entry time a headset sees is the
// '[xr] panels enter N ms' tee line (printed by xr.js's entry wiring, added in the last commit of this series).
//
//   xrctx       — the boot's XR-ready context is the one three draws into, antialias as three wants it
//                 (whether the RUNTIME says xrCompatible is a headset-machine fact; printed, not asserted)
// Usage: bun tools/xr-quad-softswap-probe.mjs [origin]   (run under a memory guard: headless Chromium renders on the CPU)
import { launchBrowser, ownedWorld, checker } from './probe-harness.mjs';
import { readFileSync } from 'node:fs';

const { check, done } = checker();
// IWER's device loop must ride the NATIVE clock once the product shims window.rAF (see xr-lifecycle-probe.mjs)
const IWER_RAW = readFileSync(new URL('../node_modules/iwer/build/iwer.js', import.meta.url), 'utf8');
const DEVICE_LOOP = 'globalThis.requestAnimationFrame(this[P_SESSION].onDeviceFrame)';
if (IWER_RAW.split(DEVICE_LOOP).length !== 2) throw new Error(`iwer build changed: expected exactly one '${DEVICE_LOOP}'`);
const IWER = `globalThis.__iwerNativeRAF = globalThis.requestAnimationFrame.bind(globalThis);\n` +
  IWER_RAW.replace(DEVICE_LOOP, 'globalThis.__iwerNativeRAF(this[P_SESSION].onDeviceFrame)');

const world = await ownedWorld({ live: process.argv[2] ?? null });
const { browser, page } = await launchBrowser();
const pg = await page();
const ev = (fn, arg) => Promise.race([
  pg.evaluate(fn, arg),
  new Promise((_, rej) => setTimeout(() => rej(new Error('page main thread pinned for 20 s')), 20000)),
]);
await pg.addInitScript(IWER);
await pg.addInitScript(() => {
  const { XRDevice, metaQuest3 } = window.IWER ?? {};
  if (!XRDevice) { window.__probe = { fatal: 'IWER did not load' }; return; }
  const device = new XRDevice(metaQuest3);
  device.installRuntime({ forceInstall: true });   // headless Chromium ships a navigator.xr stub IWER won't clobber otherwise
  window.__iwerDevice = device;
  try { delete window.IWER; } catch { window.IWER = undefined; }   // the product takes the real-headset branch
  window.__probe = { grants: 0 };
  const real = navigator.xr.requestSession.bind(navigator.xr);
  navigator.xr.requestSession = async (...a) => { const s = await real(...a); window.__probe.grants++; return s; };
});
const errs = [], tees = [];
pg.on('pageerror', (e) => errs.push(String(e)));
pg.on('console', (m) => { const t = m.text(); if (/\[xr\] panels (enter|exit)|domquad/.test(t)) tees.push(t); });
pg.on('request', (r) => { const b = r.postData(); if (b && /\[xr\] panels (enter|exit)/.test(b)) tees.push(...(b.match(/\[xr\] panels (enter|exit) [\d.]+ ms/g) ?? [])); });

try {
  await pg.goto(`${world.origin}/?world=staging&name=quadprobe&key=${world.key}&xr=1`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await pg.waitForFunction(() => { const b = document.querySelector('#xrbtn'); return !!b && getComputedStyle(b).display !== 'none'; }, null, { timeout: 60000 }).catch(() => {});
  const ready = await ev(() => !!document.querySelector('#xrbtn') && typeof globalThis.__domQuads === 'function' && typeof globalThis.__xrRingPanels === 'function');
  check('booted: visor visible, the quad and ring hooks exist', ready, await ev(() => `xrbtn=${!!document.querySelector('#xrbtn')} __domQuads=${typeof globalThis.__domQuads} __xrRingPanels=${typeof globalThis.__xrRingPanels}`));
  if (!ready) throw new Error('boot gate failed');
  // ── the XR-ready context (core.js): a WebGL ?xr=1 boot asks for xrCompatible at creation ──
  const ctx = await ev(() => globalThis.__xrCtx ?? null);
  console.log(`  · __xrCtx: ${JSON.stringify(ctx)}`);
  check('an XR boot on WebGL created its context up front', !!ctx, 'no __xrCtx — the gate never fired');
  // NOT a discriminating check on its own: a second getContext('webgl2') on a canvas returns the FIRST context,
  // so three lands in ours even without parameters.context (that mutant stayed green, 09-23). What binds the
  // feature is the check above — the context exists before three's init. This one guards a future three that
  // makes its own canvas/context and would silently strand ours.
  check('…and three renders into THAT context (not one of its own)', ctx?.used === true, JSON.stringify(ctx));
  check("…with the antialias three derives itself (ACES → internal target → canvas MSAA off)", ctx && ctx.antialias === ctx.threeWanted, JSON.stringify(ctx));
  const q = () => ev(() => globalThis.__domQuads());
  const enter = async (n) => {
    await ev(() => document.querySelector('#xrbtn').click());
    await pg.waitForFunction((n) => window.__probe.grants >= n && globalThis.__domQuads().staged > 0, n, { timeout: 30000 }).catch(() => {});
  };
  const exit = async () => {
    await ev(async () => { await window.__iwerDevice.activeSession?.end(); });
    await pg.waitForFunction(() => !window.__iwerDevice.activeSession && globalThis.__domQuads().staged === 0, null, { timeout: 10000 }).catch(() => {});
  };

  // ── session 1 ──
  await enter(1);
  const e1 = await q();
  console.log(`  · after entry 1: ${JSON.stringify(e1)}`);
  check('entry stages every XR frame', e1.staged >= 3, `staged=${e1.staged}`);
  check('LAZY: no quad is built at entry (they start hidden)', e1.built === 0 && e1.builds === 0, `built=${e1.built} builds=${e1.builds}`);
  await ev(() => globalThis.__xrRingPanels());
  const s1 = await q();
  check("the ring's 'panels' slot SHOWS the quads on the default path", s1.shown === true, JSON.stringify({ shown: s1.shown, built: s1.built }));
  // the ring's lit state reads xrPanelOpen → domQuadOpen on this path (the ring was dark while panels were shown)
  const lit = await ev(async () => { const { xrPanelOpen } = await import('./lib/xrpanels.js'); const d = globalThis.__domQuads();
    return d.ids.map((id) => xrPanelOpen(id)); });
  check("…and the ring's lit state reads them as open (xrPanelOpen → domQuadOpen)", lit.length > 0 && lit.every(Boolean), JSON.stringify(lit));
  check('…building each exactly once, on that first show', s1.built === s1.staged && s1.builds === s1.staged, `built=${s1.built} builds=${s1.builds} staged=${s1.staged}`);
  await ev(() => globalThis.__xrRingPanels());
  const h1 = await q();
  check("…and the same slot hides them again, meshes kept", h1.shown === false && h1.built === s1.built && h1.builds === s1.builds, JSON.stringify(h1));
  await ev(() => globalThis.__xrRingPanels());   // leave them shown into the exit — the harder case
  const k1 = await q(); const byId1 = Object.fromEntries(k1.ids.map((id, i) => [id, k1.meshIds[i]]));
  await exit();
  const x1 = await q();
  console.log(`  · after exit 1: ${JSON.stringify(x1)}`);
  check('exit returns every element to the desktop', x1.onDesktop.every(Boolean), JSON.stringify(x1.onDesktop));
  check('…suspends every kept texture observer', x1.observing.every((o) => o === false), JSON.stringify(x1.observing));
  check('…and KEEPS the meshes (soft swap)', x1.built === s1.built, `built=${x1.built}`);

  // ── session 2 ──
  await enter(2);
  const e2 = await q();
  console.log(`  · after entry 2: ${JSON.stringify(e2)}`);
  // a frame registered between sessions (the VR keyboard, on this client) is NEW — staged unbuilt, built on its
  // first show. Every frame session 1 built must come back as the SAME object; only new ones may build.
  const fresh = e2.ids.filter((id) => !(id in byId1));
  console.log(`  · frames new since session 1: ${JSON.stringify(fresh)}`);
  check('re-entry builds NOTHING', e2.builds === s1.builds, `builds ${s1.builds} → ${e2.builds}`);
  check('…reuses the SAME mesh object for every frame session 1 built', Object.entries(byId1).every(([id, u]) => e2.meshIds[e2.ids.indexOf(id)] === u), JSON.stringify({ byId1, now: e2.meshIds }));
  check('…starts hidden again, every kept observer resumed', e2.shown === false && e2.observing.every((o, i) => (e2.meshIds[i] ? o === true : o === null)), JSON.stringify(e2));
  await ev(() => globalThis.__xrRingPanels());
  const s2 = await q();
  check('showing in session 2 builds ONLY the frames new since session 1', s2.shown === true && s2.builds === s1.builds + fresh.length, `builds ${s1.builds} → ${s2.builds}, new frames ${fresh.length}`);
  await exit();
  const x2 = await q();
  check('exit 2 returns every element to the desktop again', x2.onDesktop.every(Boolean), JSON.stringify(x2.onDesktop));
  check('no page errors', errs.length === 0, errs.slice(0, 3).join(' | '));
  console.log(`  · panel timing tees seen: ${tees.join(' ; ') || '(none captured — the tee goes to the server log)'}`);
} finally {
  try { await browser.close(); } catch {}
  try { await world.close(); } catch {}
}
done();
