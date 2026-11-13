// xr-res-probe — Settings › VR › resolution reaches the session layer. Real client + IWER: one session per choice in
// xr.js XR_RES_SCALES (a fresh page each: the factor is read once as a session starts). Binds what we control: the row
// offers the four choices in order, three is set to the factor, and the layer three creates ASKS the runtime for it.
// Whether the runtime honours it is the runtime's (IWER sizes its layer from the canvas and ignores it; Chrome clamps to
// 0.2–1.0) — a headset's "[xr] enter" line prints scale= and target=WxH. Empty world (no sky).
//   bun test/client/xr-res-probe.mjs   (with SKIP_OPT_SWEEP=1 its server starts no asset-optimizer jobs)
import { launchBrowser, ownedWorld, checker, iwerInit, visorShown, enterVR } from '../harness/probe-harness.mjs';
const { check, done } = checker();
const world = await ownedWorld({});
const { browser, page } = await launchBrowser();
const errs = [];

async function session(res) {
  const pg = await page();
  pg.on('pageerror', (e) => errs.push(`[${res}] ${e}`));
  await iwerInit(pg);
  await pg.addInitScript(() => {
    window.__layerAsk = [];
    const L = window.XRWebGLLayer;
    if (L) window.XRWebGLLayer = class extends L { constructor(s, g, init) { super(s, g, init); window.__layerAsk.push(['base', init?.framebufferScaleFactor ?? null]); } };
    const B = window.XRWebGLBinding?.prototype;
    if (B?.createProjectionLayer) { const f = B.createProjectionLayer; B.createProjectionLayer = function (init) { window.__layerAsk.push(['proj', init?.scaleFactor ?? null]); return f.call(this, init); }; }
  });
  await pg.addInitScript((r) => { try { localStorage.setItem('ew-xr-prefs', JSON.stringify({ res: r })); } catch {} }, res);
  await pg.goto(`${world.origin}/?world=staging&name=resprobe&key=${world.key}&xr=1`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await visorShown(pg, { timeout: 120000 });
  // the settings row, as a person finds it
  const row = await pg.evaluate(async () => {
    document.querySelector('#sec-vr-tab')?.click();
    const pick = () => [...document.querySelectorAll('#sec-vr select')].find((s) => [...s.options].some((o) => /headset asks/.test(o.textContent)));
    for (let i = 0; i < 300 && !pick(); i++) await new Promise((r) => requestAnimationFrame(r));   // the tab draws its rows
    const sel = pick();
    return sel ? { opts: [...sel.options].map((o) => o.value), value: sel.value } : null;
  });
  await enterVR(pg);
  await pg.waitForFunction(() => !!globalThis.EW.renderer.xr._xrRenderTarget?.width, null, { timeout: 30000 });
  const r = await pg.evaluate(async () => { const xr = globalThis.EW.renderer.xr; const t = xr._xrRenderTarget;
    return { scale: xr.getFramebufferScaleFactor(), asked: window.__layerAsk, w: t?.width ?? null, h: t?.height ?? null, proj: !!xr._glProjLayer,
      table: { ...(await import('./lib/xr/xr.js')).XR_RES_SCALES } }; });
  await pg.close();
  return { row, ...r };
}

try {
  const a = await session('auto');
  console.log('  · auto', JSON.stringify(a));
  check('the VR settings row offers auto / 85 / 70 / 50, in that order', JSON.stringify(a.row?.opts) === '["auto","85","70","50"]', JSON.stringify(a.row));
  check('…and every choice it offers is a row of XR_RES_SCALES', !!a.row && a.row.opts.every((o) => typeof a.table[o] === 'number') && a.row.opts.length === Object.keys(a.table).length, JSON.stringify(a.table));
  // what the RUNTIME is asked for, at the layer three actually creates. Whether it honours the factor is the runtime's
  // job (Chrome clamps to 0.2–1.0; IWER sizes its layer from the canvas and ignores it, so sizes can't be compared here)
  const sizes = new Set();
  for (const res of a.row?.opts ?? []) {
    const s = res === 'auto' ? a : await session(res), want = a.table[res];
    if (res !== 'auto') console.log(`  · ${res.padEnd(4)}`, JSON.stringify(s));
    sizes.add(`${s.w}x${s.h}`);
    check(`${res}: the row shows the stored pref`, s.row?.value === res, String(s.row?.value));
    check(`${res}: three asks for factor ${want}`, s.scale === want, String(s.scale));
    check(`${res}: the session layer is asked for ${want}`, s.asked?.length === 1 && s.asked[0][1] === want, JSON.stringify(s.asked));
  }
  if (sizes.size === 1) console.log(`  · (disclosed: the emulator's eye target is ${[...sizes][0]} every time — it ignores the factor; a headset's [xr] enter line prints target=WxH)`);
  check('no page errors', errs.length === 0, errs.slice(0, 3).join(' | '));
} catch (e) { check('probe ran', false, e.message); }
finally { try { await browser.close(); } catch {} try { await world.close(); } catch {} }
done();
