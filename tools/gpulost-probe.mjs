// gpulost-probe — real Chromium: kill the WebGL context (WEBGL_lose_context), expect a reload into the
// same world without ?xr=1 and a red 'graphics reset' status chip (statuschips.js); kill it again inside 2 min, expect
// NO reload and a red 'graphics lost ×2' chip that opens itself ('Graphics lost again') and replaces the reset chip.   bun tools/gpulost-probe.mjs   (an owned server; SHOT=<png> saves the last frame)
// …and once stopped, render / compileAsync / renderWorld reach nothing in three (live control before the loss; each gate is red-on-revert).
import { launchBrowser, ownedWorld, checker } from './probe-harness.mjs';
const { check: ok, done } = checker();
const world = await ownedWorld({});
const { browser, page } = await launchBrowser();
try {
  const p = await page(); const errs = [], tees = [];
  // THE SKY GUARD, before any module reads localStorage (sky.js): a cloudy sky in headless has frozen the host
  await p.context().addInitScript(() => { try { localStorage.setItem('ew-cloud-quality', 'off'); } catch {} });
  p.on('pageerror', (e) => errs.push(e.message));
  p.on('console', (m) => { if (/\[gpu\]/.test(m.text())) tees.push(m.text()); });
  const booted = () => p.waitForFunction(() => globalThis.__gpuLost && globalThis.EW?.renderer, null, { timeout: 90000 });
  await p.goto(`${world.origin}/?world=gpulost&name=g&key=${world.key}&xr=0&vrprobe=1`); await booted();
  const kill = () => p.evaluate(() => { const gl = globalThis.EW.renderer.backend.gl; gl.getExtension('WEBGL_lose_context').loseContext(); });
  const nav1 = p.waitForEvent('framenavigated', { timeout: 15000 }).then(() => true, () => false);
  await kill();
  ok('a lost context reloads the page', await nav1);
  await p.waitForFunction(() => globalThis.__ewLite !== undefined, null, { timeout: 30000 });
  if (await p.evaluate(() => !globalThis.__ewLite)) await booted();
  ok('…into the FULL client, not lite (a recovery is not a crash)', await p.evaluate(() => globalThis.__ewLite === false), await p.evaluate(() => String(globalThis.__ewLiteWhy)));
  ok('…into the same world, without the XR boot flag', /world=gpulost/.test(p.url()) && !/[?&]xr=/.test(p.url()), p.url());
  await p.waitForTimeout(3000);
  for (const t of ['go in anyway']) { const x = p.getByText(t, { exact: true }); if (await x.isVisible().catch(() => false)) await x.click(); }
  const chipOf = (id) => p.evaluate((i) => { const c = document.getElementById(`stchip-${i}`); return c ? { label: c.textContent.trim(), level: c.dataset.level } : null; }, id);
  const c1 = await chipOf('gpu-recovered');
  ok("…and says why: a RED 'graphics reset' status chip", c1?.level === 'err' && /^graphics reset/.test(c1.label), JSON.stringify(c1));
  await p.click('#stchip-gpu-recovered'); await p.waitForTimeout(200);
  const pop1 = await p.evaluate(() => document.getElementById('stpop')?.textContent ?? '');
  ok("…whose popover gives the reason ('Graphics reset' … 'webgl context lost')", /Graphics reset/.test(pop1) && /webgl context lost/.test(pop1), pop1.slice(0, 160));
  await p.keyboard.press('Escape');
  // THE GATES (#228 review): instrument the page's own renderer BEFORE the second loss, on the module instances the page
  // actually loaded (foliage-probe's pattern), and count entries into three UNDER render.js's wrappers: render →
  // _renderScene, renderWorld's self-heal → getRenderTarget, compileAsync → its FIRST statement (three reads
  // this._isDeviceLost before anything else), counted only inside a synchronous window around the call, so no backend
  // work and no later frame can add or hide an entry. A LIVE control runs now, on a healthy backend with nothing lowered;
  // after the loss, a second control lowers only the loss flag; then every gated call must count zero. Remove any gate
  // and its line goes red. gpulost-gate-test.mjs binds the same three gates with no browser at all.
  const live = await p.evaluate(async () => {
    const before = globalThis.EW.renderer.render, t0 = performance.now();   // captured BEFORE the imports: a second render.js instance would re-wrap it
    const { renderWorld } = await import('./lib/render.js'), { renderer: r, scene, camera } = await import('./lib/core.js');
    const n = { scene: 0, cam: 0, rt: 0 }, undo = [], zero = () => { for (const k in n) n[k] = 0; };   // each leg counts only itself
    for (const [k, c] of [['_renderScene', 'scene'], ['getRenderTarget', 'rt']]) {
      const f = r[k]; r[k] = function (...a) { n[c]++; return f.apply(this, a); }; undo.push(() => { delete r[k]; if (r[k] !== f) r[k] = f; });
    }
    const st = { lostFlag: r._isDeviceLost, inWin: false };
    Object.defineProperty(r, '_isDeviceLost', { configurable: true, enumerable: true, get() { if (st.inWin) n.cam++; return st.lostFlag; }, set(v) { st.lostFlag = v; } });
    undo.push(() => { delete r._isDeviceLost; r._isDeviceLost = st.lostFlag; });
    const compileOnce = () => { st.inWin = true; let q; try { q = r.compileAsync(scene, camera, scene); } finally { st.inWin = false; } return Promise.resolve(q).catch(() => {}); };
    globalThis.__gateProbe = { r, scene, camera, renderWorld, n, zero, undo, compileOnce, render: before };
    const c = { fired: !!globalThis.__gpuLost?.fired, sameRenderer: r === globalThis.EW.renderer && r.render === before };
    zero(); try { r.render(scene, camera); } catch {} c.render = n.scene;
    zero(); await compileOnce(); c.compile = n.cam;
    zero(); try { renderWorld(); } catch {} c.world = n.rt; zero();
    c.ms = Math.round(performance.now() - t0);   // the second loss must land inside gpulost's 2-min window: a slow control shows here
    return c;
  });
  ok('before the second loss, on the page\'s own healthy renderer, the same calls DO enter three (live control)',
    !live.fired && live.sameRenderer && live.render > 0 && live.compile > 0 && live.world > 0, JSON.stringify(live));
  const nav2 = p.waitForEvent('framenavigated', { timeout: 6000 }).then(() => true, () => false);
  await kill();
  ok('a second loss inside 2 min does NOT reload (no loop)', !(await nav2));
  await p.waitForTimeout(300);
  const c2 = await chipOf('gpu-stop'), pop2 = await p.evaluate(() => { const q = document.getElementById('stpop'); return q && !q.hidden ? q.textContent : ''; });
  ok("…and says so: a RED 'graphics lost ×2' chip, its text already open ('Graphics lost again', no 'don’t show again')",
    c2?.level === 'err' && c2.label === 'graphics lost ×2' && /Graphics lost again/.test(pop2) && !/show again/.test(pop2), JSON.stringify({ c2, pop2: pop2.slice(0, 120) }));
  ok('…replacing the reset chip (one chip for the GPU)', !(await chipOf('gpu-recovered')));
  const g = await p.evaluate(async () => {
    const { r, scene, camera, renderWorld, n, zero, undo, compileOnce, render } = globalThis.__gateProbe;
    const out = { fired: !!globalThis.__gpuLost?.fired, sameRenderer: r === globalThis.EW.renderer && r.render === render };
    try {
      // POSITIVE CONTROL after the loss: lower only the loss flag for a moment; the same calls reach three again
      const lost = globalThis.__gpuLost; globalThis.__gpuLost = { ...lost, fired: false };
      out.control = {};
      try {
        zero(); try { r.render(scene, camera); } catch {} out.control.render = n.scene;
        zero(); await compileOnce(); out.control.compile = n.cam;
        zero(); try { renderWorld(); } catch {} out.control.world = n.rt;
      } finally { globalThis.__gpuLost = lost; }
      zero(); for (let i = 0; i < 20; i++) try { r.render(scene, camera); } catch {}
      out.render = n.scene;
      zero(); for (let i = 0; i < 5; i++) await compileOnce();
      out.compile = n.cam;
      zero(); for (let i = 0; i < 20; i++) try { renderWorld(); } catch {}
      out.world = n.rt + n.scene;
    } finally { undo.forEach((u) => u()); delete globalThis.__gateProbe; }
    return out;
  });
  ok('stopped after the second loss, on the page\'s own renderer', g.fired && g.sameRenderer, JSON.stringify(g));
  ok('…and after it, with only the loss flag lowered, they enter three again', g.control?.render > 0 && g.control?.compile > 0 && g.control?.world > 0, JSON.stringify(g.control));
  ok('…renderer.render() never enters three (20 calls)', g.render === 0, JSON.stringify(g));
  ok('…renderer.compileAsync() never enters three (5 calls)', g.compile === 0, JSON.stringify(g));
  ok('…renderWorld() does none of its work (20 calls)', g.world === 0, JSON.stringify(g));
  console.log('  · gates:', JSON.stringify({ live, after: g }));   // the counts behind the green lines, for the receipt
  ok('no page errors', errs.length === 0, errs.slice(0, 3).join(' | '));
  console.log('  · tees:', tees.join(' ;; ').slice(0, 300));
  if (process.env.SHOT) await p.screenshot({ path: process.env.SHOT });
} catch (e) { ok('probe ran', false, e.message); }
finally { try { await browser.close(); } catch {} try { await world.close(); } catch {} }
done();
