// bun tools/sky-band-probe.mjs — bandedBakeRender (sky_baked.js) writes THE SAME TEXELS as one full-quad draw.
//
// Owner's machine 2026-09-23: `[load] sky bake — 89951ms over 1 frame`, then CONTEXT_LOST_WEBGL. sky.js now re-issues
// the boot bake's single full-screen renderAsync as cost-weighted strips across frames (bandedBakeRender). This binds
// the property that makes that safe, in the real client page with the real three:
//   same     — a deterministic bake material (uv-only, no time uniforms) rendered as one quad and as bands gives
//              byte-identical pixels                                         [mutate: --mutate-gap drops one band → red]
//   bands    — it really rendered several strips, one per frame (not one draw)
//   seams    — the rows where strips meet match the one-draw render exactly (checked within 'same', listed)
// NOT bound here: the sky.js interception on the owner's machine. The headless GPU (SwiftShader) never takes the baked
// sky tier, so the boot bake does not run headless at all; the live proof is the owner's console's
// '[sky] boot bake banded: N bands over M ms' line (and ?skyband=0 to compare).
// Usage: bun tools/sky-band-probe.mjs [origin] [--mutate-gap]   (run under a memory guard: headless Chromium renders on the CPU)
import { launchBrowser, ownedWorld, checker } from './probe-harness.mjs';

const { check, done } = checker();
const GAP = process.argv.includes('--mutate-gap');
const world = await ownedWorld({ live: process.argv.slice(2).find((a) => a.startsWith('http')) ?? null });
const { browser, page } = await launchBrowser();
const pg = await page();
const errs = [];
pg.on('pageerror', (e) => errs.push(String(e)));

try {
  await pg.goto(`${world.origin}/?world=staging&name=skyband&key=${world.key}&xr=1`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await pg.waitForFunction(() => globalThis.__ewEngineUp, null, { timeout: 60000 });
  await pg.waitForTimeout(4000);
  const r = await Promise.race([pg.evaluate(async (gap) => {
    const { THREE, TSL, renderer } = await import('./lib/core.js');
    const { bandedBakeRender, bandCuts } = await import('./lib/sky_baked.js');
    const W = 256, H = 128, PASSES = 8, BUDGET = 16000;   // 256*128*8/16000 ≈ 17 strips
    const mat = new THREE.NodeMaterial();
    mat.fragmentNode = TSL.Fn(() => { const u = TSL.uv(); return TSL.vec4(u.x, u.y, TSL.sin(u.x.mul(37.0)).mul(TSL.cos(u.y.mul(23.0))).mul(0.5).add(0.5), 1); })();
    const scene = new THREE.Scene(); scene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat));
    const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    const mk = () => new THREE.RenderTarget(W, H, { type: THREE.UnsignedByteType, depthBuffer: false });
    const A = mk(), B = mk();
    const prev = renderer.getRenderTarget();
    await renderer.compileAsync(scene, cam);
    renderer.setRenderTarget(A); renderer.render(scene, cam); renderer.setRenderTarget(prev);
    // B starts a different colour so a missed strip cannot pass by accident
    { const clr = new THREE.Scene(); clr.background = new THREE.Color(1, 0, 1); renderer.setRenderTarget(B); renderer.render(clr, cam); renderer.setRenderTarget(prev); }
    let frames = 0;
    const nextFrame = () => new Promise((res) => requestAnimationFrame(() => { frames++; res(); }));
    const target = gap ? { width: W, height: H, __skip: true } : B;
    let n;
    if (gap) {   // mutant: render all strips but the middle one
      const origRender = renderer.render.bind(renderer); let k = 0; const cuts = bandCuts(W, H, PASSES, BUDGET); const mid = Math.floor((cuts.length - 1) / 2);
      renderer.render = (s, c) => { if (s.children?.some((m) => m.material === mat)) { if (k++ === mid) return undefined; } return origRender(s, c); };   // band renders only — the world's own frames run in between
      try { n = await bandedBakeRender(renderer, scene, cam, B, { cloudPasses: PASSES, passTexelBudget: BUDGET, nextFrame }); } finally { renderer.render = origRender; }
    } else n = await bandedBakeRender(renderer, scene, cam, target, { cloudPasses: PASSES, passTexelBudget: BUDGET, nextFrame });
    const a = await renderer.readRenderTargetPixelsAsync(A, 0, 0, W, H);
    const b = await renderer.readRenderTargetPixelsAsync(B, 0, 0, W, H);
    let diff = 0, maxd = 0; const badRows = new Set();
    for (let i = 0; i < a.length; i++) { const d = Math.abs(a[i] - b[i]); if (d) { diff++; badRows.add(Math.floor(i / 4 / W)); } if (d > maxd) maxd = d; }
    const cuts = bandCuts(W, H, PASSES, BUDGET).map((v) => Math.round(v * H));
    return { n, frames, diff, maxd, badRows: [...badRows].slice(0, 12), cuts, total: a.length };
  }, GAP), new Promise((_, rej) => setTimeout(() => rej(new Error('page pinned 60 s')), 60000))]);
  console.log('  result:', JSON.stringify(r));
  // the client's two extra shapes (review 2: H2 + the budgeted wait): budget:true, then a renderer reporting a session
  const r2 = GAP ? null : await Promise.race([pg.evaluate(async () => {
    const { THREE, TSL, renderer } = await import('./lib/core.js');
    const { bandedBakeRender } = await import('./lib/sky_baked.js');
    const W = 256, H = 128, PASSES = 8, BUDGET = 16000;
    const mat = new THREE.NodeMaterial();
    mat.fragmentNode = TSL.Fn(() => { const u = TSL.uv(); return TSL.vec4(u.x, u.y, TSL.sin(u.x.mul(37.0)).mul(TSL.cos(u.y.mul(23.0))).mul(0.5).add(0.5), 1); })();
    const scene = new THREE.Scene(); scene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat));
    const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    const mk = () => new THREE.RenderTarget(W, H, { type: THREE.UnsignedByteType, depthBuffer: false });
    const A = mk(); await renderer.compileAsync(scene, cam);
    { const prev = renderer.getRenderTarget(); renderer.setRenderTarget(A); renderer.render(scene, cam); renderer.setRenderTarget(prev); }
    const a = await renderer.readRenderTargetPixelsAsync(A, 0, 0, W, H);
    const same = async (T) => { const b = await renderer.readRenderTargetPixelsAsync(T, 0, 0, W, H); let d = 0; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) d++; return d; };
    // "inside a frame callback": set by every rAF callback, cleared by a timer queued from it (timers run after the frame task)
    const origRAF = globalThis.requestAnimationFrame; let inRaf = false;
    globalThis.requestAnimationFrame = (cb) => origRAF((t) => { inRaf = true; setTimeout(() => { inRaf = false; }, 0); cb(t); });
    try {
      // budget: sample every frame whether the bake target is still bound
      // a hog takes each frame's free grant and overruns, so bands really WAIT for their turn (aging lets them in)
      const fb = await import('./lib/framebudget.js');
      const B = mk(); let boundSeen = 0, sampling = true;
      (function samp() { if (!sampling) return; if (renderer.getRenderTarget() === B) boundSeen++; if (fb.ask('probe-hog')) fb.spent('probe-hog', 40); origRAF(samp); })();
      const d0 = fb.budgetStats().lanes.sky?.denied ?? 0;
      const nB = await bandedBakeRender(renderer, scene, cam, B, { cloudPasses: PASSES, passTexelBudget: BUDGET, budget: true });
      sampling = false;
      const skyWaits = (fb.budgetStats().lanes.sky?.denied ?? 0) - d0;
      // presenting: the renderer as a session would show it to this function
      const C = mk(); const fakeXr = { isPresenting: true, get enabled() { return renderer.xr.enabled; }, set enabled(v) { renderer.xr.enabled = v; } };
      const rp = new Proxy(renderer, { get(t, k) { if (k === 'xr') return fakeXr; const v = t[k]; return typeof v === 'function' ? v.bind(t) : v; } });
      const bandCalls = [];
      const origRender = renderer.render;
      renderer.render = function (s, c) { if (s.children?.some((m) => m.material === mat)) bandCalls.push({ xr: renderer.xr.enabled, inRaf }); return origRender.call(this, s, c); };
      const xrWas = renderer.xr.enabled; renderer.xr.enabled = true;   // a session has it on
      let nC;
      try { nC = await bandedBakeRender(rp, scene, cam, C, { cloudPasses: PASSES, passTexelBudget: BUDGET, budget: true }); }
      finally { renderer.render = origRender; renderer.xr.enabled = xrWas; }
      // teardown mid-bake (review 2, M1): alive() goes false after 3 strips — the bake stops and says so
      const D = mk(); let drawn = 0, cancelErr = null;
      const origR2 = renderer.render;
      renderer.render = function (s, c) { if (s.children?.some((m) => m.material === mat)) drawn++; return origR2.call(this, s, c); };
      try { await bandedBakeRender(renderer, scene, cam, D, { cloudPasses: PASSES, passTexelBudget: BUDGET, alive: () => drawn < 3 }); }
      catch (e) { cancelErr = String(e?.message ?? e); } finally { renderer.render = origR2; }
      return { drawnAfterTeardown: drawn, cancelErr, nB, skyWaits, boundSeen, dB: await same(B), nC, dC: await same(C), bandCalls: bandCalls.length, bad: bandCalls.filter((b) => b.xr || b.inRaf).length };
    } finally { globalThis.requestAnimationFrame = origRAF; }
  }), new Promise((_, rej) => setTimeout(() => rej(new Error('page pinned 60 s (r2)')), 60000))]);
  if (r2) {
    console.log('  client shapes:', JSON.stringify(r2));
    check('(setup) the budget really made bands wait', r2.skyWaits > 0, String(r2.skyWaits));
    check('budgeted: the bake target is never left bound while a frame runs', r2.boundSeen === 0, `${r2.boundSeen} frames saw it bound`);
    check('budgeted: byte-identical to the one-draw bake', r2.nB >= 4 && r2.dB === 0, `${r2.dB} bytes differ over ${r2.nB} strips`);
    check('presenting: every band renders between frames with xr off (never inside an XR frame)', r2.bandCalls >= 4 && r2.bad === 0, `${r2.bad} of ${r2.bandCalls} inside a frame or with xr on`);
    check('presenting: byte-identical to the one-draw bake', r2.dC === 0, `${r2.dC} bytes differ`);
    check('teardown mid-bake: no strip after the sky is gone, and the bake rejects as cancelled', r2.drawnAfterTeardown === 3 && /cancel/.test(r2.cancelErr ?? ''), JSON.stringify({ drawn: r2.drawnAfterTeardown, err: r2.cancelErr }));
  }
  check('bands: the bake was rendered as several strips, across frames', r.n >= 4 && r.frames >= r.n - 1, `${r.n} strips over ${r.frames} frames (cuts at rows ${r.cuts.join(',')})`);
  check('same: banded pixels are byte-identical to the one-draw bake (seam rows included)', r.diff === 0, `${r.diff} of ${r.total} bytes differ (max Δ ${r.maxd}); rows ${r.badRows.join(',') || '-'}`);
  check('no page errors', errs.length === 0, errs.slice(0, 2).join(' | ') || 'none');
} catch (e) { check('probe ran to completion', false, String(e).slice(0, 300)); }
finally { await browser.close(); await world.close(); }
done();
