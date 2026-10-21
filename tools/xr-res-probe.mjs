// xr-res-probe — Settings › VR › resolution reaches the session layer. Real client + IWER: one session with the pref at
// 'auto', one at '50' (a fresh page each: the factor is read once as a session starts). Binds what we control: the row
// offers the four choices in order, three is set to the factor, and the layer three creates ASKS the runtime for it.
// Whether the runtime honours it is the runtime's (IWER sizes its layer from the canvas and ignores it; Chrome clamps to
// 0.2–1.0) — a headset's "[xr] enter" line prints scale= and target=WxH. Empty world (no sky).
//   bun tools/xr-res-probe.mjs   (with SKIP_OPT_SWEEP=1 its server starts no asset-optimizer jobs)
import { launchBrowser, ownedWorld, checker } from './probe-harness.mjs';
import { readFileSync } from 'node:fs';
const { check, done } = checker();
const IWER_RAW = readFileSync(new URL('../node_modules/iwer/build/iwer.js', import.meta.url), 'utf8');
const LOOP = 'globalThis.requestAnimationFrame(this[P_SESSION].onDeviceFrame)';
const IWER = `globalThis.__iwerNativeRAF = globalThis.requestAnimationFrame.bind(globalThis);\n` + IWER_RAW.replace(LOOP, 'globalThis.__iwerNativeRAF(this[P_SESSION].onDeviceFrame)');
const world = await ownedWorld({});
const { browser, page } = await launchBrowser();
const errs = [];

async function session(res) {
  const pg = await page();
  pg.on('pageerror', (e) => errs.push(`[${res}] ${e}`));
  await pg.addInitScript(IWER);
  await pg.addInitScript(() => { const { XRDevice, metaQuest3 } = window.IWER ?? {}; const d = new XRDevice(metaQuest3); d.installRuntime({ forceInstall: true });
    window.__iwerDevice = d; try { delete window.IWER; } catch { window.IWER = undefined; } });
  await pg.addInitScript(() => {
    window.__layerAsk = [];
    const L = window.XRWebGLLayer;
    if (L) window.XRWebGLLayer = class extends L { constructor(s, g, init) { super(s, g, init); window.__layerAsk.push(['base', init?.framebufferScaleFactor ?? null]); } };
    const B = window.XRWebGLBinding?.prototype;
    if (B?.createProjectionLayer) { const f = B.createProjectionLayer; B.createProjectionLayer = function (init) { window.__layerAsk.push(['proj', init?.scaleFactor ?? null]); return f.call(this, init); }; }
  });
  await pg.addInitScript((r) => { try { localStorage.setItem('ew-xr-prefs', JSON.stringify({ res: r })); } catch {} }, res);
  await pg.goto(`${world.origin}/?world=staging&name=resprobe&key=${world.key}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await pg.waitForFunction(() => { const b = document.querySelector('#xrbtn'); return !!b && getComputedStyle(b).display !== 'none'; }, null, { timeout: 120000 });
  // the settings row, as a person finds it
  const row = await pg.evaluate(async () => {
    document.querySelector('#sec-vr-tab')?.click(); await new Promise((r) => setTimeout(r, 400));
    const sel = [...document.querySelectorAll('#sec-vr select')].find((s) => [...s.options].some((o) => /headset asks/.test(o.textContent)));
    return sel ? { opts: [...sel.options].map((o) => o.value), value: sel.value } : null;
  });
  await pg.evaluate(() => document.querySelector('#xrbtn').click());
  await pg.waitForFunction(() => globalThis.EW?.renderer?.xr?.isPresenting, null, { timeout: 30000, polling: 250 });
  await pg.waitForTimeout(1500);
  const r = await pg.evaluate(() => { const xr = globalThis.EW.renderer.xr; const t = xr._xrRenderTarget;
    return { scale: xr.getFramebufferScaleFactor(), asked: window.__layerAsk, w: t?.width ?? null, h: t?.height ?? null, proj: !!xr._glProjLayer }; });
  await pg.close();
  return { row, ...r };
}

try {
  const a = await session('auto');
  console.log('  · auto', JSON.stringify(a));
  const h = await session('50');
  console.log('  · 50  ', JSON.stringify(h));
  check('the VR settings row offers auto / 85 / 70 / 50, in that order', JSON.stringify(a.row?.opts) === '["auto","85","70","50"]', JSON.stringify(a.row));
  check('…showing the stored pref', a.row?.value === 'auto' && h.row?.value === '50', `${a.row?.value} / ${h.row?.value}`);
  check('auto asks for the runtime\'s size (factor 1)', a.scale === 1, String(a.scale));
  check('50% asks for factor 0.5', h.scale === 0.5, String(h.scale));
  // what the RUNTIME is asked for, at the layer three actually creates. Whether it honours the factor is the runtime's
  // job (Chrome clamps to 0.2–1.0; IWER sizes its layer from the canvas and ignores it, so sizes can't be compared here)
  check('the session layer is asked for factor 1 at auto', a.asked?.length === 1 && a.asked[0][1] === 1, JSON.stringify(a.asked));
  check('…and for 0.5 at 50%', h.asked?.length === 1 && h.asked[0][1] === 0.5, JSON.stringify(h.asked));
  if (h.w === a.w) console.log(`  · (disclosed: the emulator's eye target is ${a.w}x${a.h} both times — it ignores the factor; a headset's [xr] enter line prints target=WxH)`);
  check('no page errors', errs.length === 0, errs.slice(0, 3).join(' | '));
} catch (e) { check('probe ran', false, e.message); }
finally { try { await browser.close(); } catch {} try { await world.close(); } catch {} }
done();
