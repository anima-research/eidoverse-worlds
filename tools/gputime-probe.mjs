// bun tools/gputime-probe.mjs — Debug › gpu timer (client/lib/gputime.js).
// SwiftShader has no real GPU clock, so this runs the page TWICE:
//   native   — whatever this headless browser exposes; if the extension is missing the row must say so and refuse
//   emulated — a fake EXT_disjoint_timer_query_webgl2 (TIME_ELAPSED = performance.now() between begin/end, a
//              switchable DISJOINT flag). It proves the PLUMBING — ring readback, disjoint discard, the shadow A/B
//              really holding the maps, restore — never GPU truth. Real numbers come from the headset.
import { launchBrowser, ownedWorld, checker } from './probe-harness.mjs';

const { check, done } = checker();
const world = await ownedWorld({});
const { browser, page } = await launchBrowser();

const EMULATE = () => {
  const TE = 0x88BF, DJ = 0x8FBB;
  const P = WebGL2RenderingContext.prototype;
  const oGet = P.getExtension, oBegin = P.beginQuery, oEnd = P.endQuery, oQP = P.getQueryParameter, oGP = P.getParameter;
  const t = new WeakMap();
  window.__em = { begins: 0, disjoint: false };
  P.getExtension = function (n) { return n === 'EXT_disjoint_timer_query_webgl2' ? { TIME_ELAPSED_EXT: TE, GPU_DISJOINT_EXT: DJ, TIMESTAMP_EXT: 0x8E28 } : oGet.call(this, n); };
  P.beginQuery = function (target, q) { if (target !== TE) return oBegin.call(this, target, q); window.__em.begins++; t.set(q, { a: performance.now(), b: null }); };
  P.endQuery = function (target) { if (target !== TE) return oEnd.call(this, target); for (const q of window.__em.open ?? []) void q; window.__em.lastEnd = performance.now(); window.__em.pendingEnd = true; };
  // endQuery has no query argument: stamp the most recently begun open query
  const oBegin2 = P.beginQuery;
  P.beginQuery = function (target, q) { oBegin2.call(this, target, q); if (target === TE) window.__em.cur = q; };
  const oEnd2 = P.endQuery;
  P.endQuery = function (target) { oEnd2.call(this, target); if (target === TE && window.__em.cur) { const r = t.get(window.__em.cur); if (r) r.b = performance.now(); window.__em.cur = null; } };
  P.getQueryParameter = function (q, pname) {
    const r = t.get(q);
    if (!r) return oQP.call(this, q, pname);
    if (pname === this.QUERY_RESULT_AVAILABLE) return r.b != null;
    if (pname === this.QUERY_RESULT) return Math.round((r.b - r.a) * 1e6);
    return oQP.call(this, q, pname);
  };
  P.getParameter = function (p) { return p === DJ ? window.__em.disjoint : oGP.call(this, p); };
};

async function boot(emulate) {
  const pg = await page();
  const errs = []; pg.on('pageerror', (e) => errs.push(String(e)));
  if (emulate) await pg.addInitScript(EMULATE);
  await pg.goto(`${world.origin}/?world=staging&name=gpuprobe&key=${world.key}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await pg.waitForFunction(() => globalThis.__ewEngineUp, null, { timeout: 60000 });
  await pg.waitForTimeout(4000);
  return { pg, errs };
}

try {
  // ---- native
  {
    const { pg, errs } = await boot(false);
    const r = await pg.evaluate(async () => {
      const G = await import('./lib/gputime.js');
      const st = G.setGpuTimer(true);
      return { st, line: G.gpuLine() };
    });
    console.log(`  native: ${JSON.stringify(r)}`);
    if (r.st.supported) check('native: extension exposed — timer turns on', r.st.on === true, r.line);
    else check('native: extension missing — the row says why and the timer stays off', r.st.on === false && /unavailable/.test(r.line), r.line);
    check('native: no page errors', errs.length === 0, errs.slice(0, 2).join(' | ') || 'none');
    await pg.close();
  }
  // ---- emulated
  {
    const { pg, errs } = await boot(true);
    const r = await pg.evaluate(async () => {
      const G = await import('./lib/gputime.js');
      const { renderer } = await import('./lib/core.js');
      const wait = (ms) => new Promise((res) => setTimeout(res, ms));
      const out = {};
      G.setGpuTimer(true);
      for (let i = 0; i < 60 && G.gpuTimerState().frames < 12; i++) await wait(500);   // headless frames are slow: count frames, not seconds
      out.on = G.gpuTimerState();
      // disjoint: samples must stop growing (discarded, not averaged)
      window.__em.disjoint = true;
      await wait(300);                           // let in-flight clean results land first
      const before = G.gpuTimerState().frames, beginsBefore = window.__em.begins;
      for (let i = 0; i < 60 && window.__em.begins - beginsBefore < 8; i++) await wait(500);
      out.disjoint = { before, after: G.gpuTimerState().frames, begins: window.__em.begins - beginsBefore };
      window.__em.disjoint = false;
      // shadow A/B: count ORTHO (sun shadow) renders during it — held frames must not draw the map
      let ortho = 0; const orig = renderer.render;
      renderer.render = function (sc, cam) { if (cam?.isOrthographicCamera && G.gpuTimerState().abStepping) ortho++; return orig.call(this, sc, cam); };
      const lights = []; (await import('./lib/core.js')).scene.traverse((o) => { if (o.isLight && o.castShadow) lights.push([o, o.shadow.autoUpdate]); });
      const ab = await G.measureShadowPass(40);
      renderer.render = orig;
      out.ab = ab; out.ortho = ortho;
      out.restored = lights.every(([l, a]) => l.shadow.autoUpdate === a);
      out.line = G.shadowPassLine();
      // off: no more queries
      G.setGpuTimer(false);
      const b0 = window.__em.begins; await wait(1000); out.offBegins = window.__em.begins - b0;
      return out;
    });
    console.log(`  emulated: on ${JSON.stringify(r.on)} | disjoint ${JSON.stringify(r.disjoint)} | ab ${JSON.stringify(r.ab)} ortho ${r.ortho} | ${r.line}`);
    check('emulated: timer on → frames accumulate with a finite average', r.on.on && r.on.frames > 10 && Number.isFinite(r.on.avgMs), JSON.stringify(r.on));
    check('emulated: DISJOINT frames are discarded (queries still run, samples do not grow)', r.disjoint.begins >= 8 && r.disjoint.after <= r.disjoint.before + 1, JSON.stringify(r.disjoint));
    const [dn, hd] = (r.ab.frames || '0/0').split('/').map(Number);
    check('emulated: A/B collects both halves', dn >= 30 && hd >= 30, r.ab.frames);
    check('emulated: HELD frames do not redraw the shadow map (ortho renders ≈ drawn frames, not 2×)', r.ortho >= dn - 3 && r.ortho <= dn + 3, `ortho ${r.ortho} vs drawn ${dn} / held ${hd}`);
    check('emulated: shadow autoUpdate restored after the A/B', r.restored === true, String(r.restored));
    check('emulated: timer off → no queries issued', r.offBegins === 0, `${r.offBegins} begins after off`);
    check('emulated: no page errors', errs.length === 0, errs.slice(0, 2).join(' | ') || 'none');
    await pg.close();
  }
} catch (e) { check('probe ran to completion', false, String(e).slice(0, 300)); }
finally { await browser.close(); await world.close(); }
done();
