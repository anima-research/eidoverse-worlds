// xr-mirror-probe — Settings › VR › desktop view draws the scene onto the canvas at the CANVAS's size while presenting.
// The bug (xrmirror.js header): three's XRManager gives the renderer's CanvasTarget the XR layer's size for the whole
// session, so every canvas pass drew through an intermediate target the size of both eyes. IWER sizes its layer from
// the canvas, which hides that; this probe makes the mismatch a real headset has by calling three's own
// _setXRLayerSize with a big layer after entry. Real client + IWER, empty world (no sky).
//   bun tools/xr-mirror-probe.mjs [out.png]   (with SKIP_OPT_SWEEP=1 its server starts no asset-optimizer jobs)
import { launchBrowser, ownedWorld, checker } from './probe-harness.mjs';
import { readFileSync, writeFileSync } from 'node:fs';
const { check, done } = checker();
const OUT = process.argv[2] ?? null;
const IWER_RAW = readFileSync(new URL('../node_modules/iwer/build/iwer.js', import.meta.url), 'utf8');
const LOOP = 'globalThis.requestAnimationFrame(this[P_SESSION].onDeviceFrame)';
const IWER = `globalThis.__iwerNativeRAF = globalThis.requestAnimationFrame.bind(globalThis);\n` + IWER_RAW.replace(LOOP, 'globalThis.__iwerNativeRAF(this[P_SESSION].onDeviceFrame)');
const LAYER = [4000, 2000];
const world = await ownedWorld({});
const { browser, page } = await launchBrowser();
const errs = [];

async function run(mode, { hold = true, slowMs = 0 } = {}) {
  const pg = await page();
  pg.on('pageerror', (e) => errs.push(`[${mode}] ${e}`));
  await pg.addInitScript(IWER);
  await pg.addInitScript(() => { const { XRDevice, metaQuest3 } = window.IWER ?? {}; const d = new XRDevice(metaQuest3); d.installRuntime({ forceInstall: true });
    window.__iwerDevice = d; try { delete window.IWER; } catch { window.IWER = undefined; } });
  await pg.addInitScript((m) => { try { localStorage.setItem('ew-xr-prefs', JSON.stringify({ mirror: m })); } catch {} }, mode);
  await pg.goto(`${world.origin}/?world=staging&name=mirrorprobe&key=${world.key}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await pg.waitForFunction(() => { const b = document.querySelector('#xrbtn'); return !!b && getComputedStyle(b).display !== 'none'; }, null, { timeout: 120000 });
  await pg.waitForTimeout(2000);
  // The killswitch (30 frames over 30 ms → off) is a separate property with its own run below. Held here so a slow
  // headless frame clock can't end the specimen before it's sampled (antra's #206 review: it did, on a slower host).
  await pg.waitForFunction(() => !!globalThis.__xrMirror, null, { timeout: 30000 });
  await pg.evaluate((h) => { globalThis.__xrMirror.holdKill = h; }, hold);
  await pg.evaluate(() => document.querySelector('#xrbtn').click());
  await pg.waitForFunction(() => globalThis.EW?.renderer?.xr?.isPresenting, null, { timeout: 30000, polling: 250 });
  const r = await pg.evaluate(async ([lw, lh, slowMs]) => {
    const R = globalThis.EW.renderer, ct = R._canvasTarget;
    // a marker the first-person view must show: a bright magenta box 3 m ahead of the head, kept there every frame
    const THREE = await import('three');
    const box = new THREE.Mesh(new THREE.BoxGeometry(1.2, 1.2, 1.2), new THREE.MeshBasicNodeMaterial({ color: 0xff00ff }));
    box.frustumCulled = false; globalThis.EW.scene.add(box);
    const xc = R.xr.getCamera(), p = new THREE.Vector3(), q = new THREE.Quaternion(), sc = new THREE.Vector3();
    const follow = () => { xc.matrixWorld.decompose(p, q, sc); box.position.copy(p).add(new THREE.Vector3(0, 0, -3).applyQuaternion(q)); box.updateMatrixWorld(true); };
    const fid = setInterval(follow, 16); follow();
    if (!globalThis.__noResize) R._setXRLayerSize(lw, lh);   // what a real headset's layer does at session start
    // spy: the canvas intermediate target's size at each canvas render, and the CanvasTarget's size between passes
    const seen = [];
    const orig = R.render.bind(R);
    // killswitch run: every frame made slow on purpose, so the switch trips on any host, fast or slow
    const spin = (ms) => { const t = performance.now(); while (performance.now() - t < ms) { /* a slow frame */ } };
    // recorded in a finally: a canvas pass that THROWS partway (HEAD's did) has still sized the target by then
    R.render = (sc, cam) => { const canvasPass = !R.xr.enabled && R.getRenderTarget() === null && (R.getOutputRenderTarget?.() ?? null) === null;
      if (slowMs && R.xr.enabled) spin(slowMs);
      try { return orig(sc, cam); } finally { if (canvasPass) { const f = R._frameBufferTargets?.get(ct); seen.push({ fbt: f ? `${f.width}x${f.height}` : null }); } } };
    // the killswitch run waits for the TRIP (30 frames, however long they take on this host), capped at 90 s; the
    // visual runs sample for 4 s with the switch held
    if (slowMs) { const t0 = performance.now(); while (!globalThis.__xrMirror?.killed && performance.now() - t0 < 90000) await new Promise((res) => setTimeout(res, 250)); await new Promise((res) => setTimeout(res, 1500)); }
    else await new Promise((res) => setTimeout(res, 4000));
    R.render = orig;
    return { seen: seen.slice(-3), n: seen.length, mirror: globalThis.__xrMirror ? { ...globalThis.__xrMirror } : null, between: `${ct._width * (ct._pixelRatio || 1)}x${ct._height * (ct._pixelRatio || 1)}`,
      canvas: `${R.domElement.width}x${R.domElement.height}`, presenting: R.xr.isPresenting };
  }, [...LAYER, slowMs]);
  await pg.evaluate(() => { const c = globalThis.EW.renderer.domElement; c.id ||= '__ewcanvas';
    const st = document.createElement('style'); st.textContent = 'body *:not(canvas):not(:has(canvas)){visibility:hidden !important}'; document.head.appendChild(st); });   // the renderer's pixels only, no HUD
  const passesBefore = await pg.evaluate(() => globalThis.__xrMirror?.passes ?? 0);
  const shot = await pg.screenshot({ timeout: 30000 });
  const after = await pg.evaluate(() => ({ passes: globalThis.__xrMirror?.passes ?? 0, killed: !!globalThis.__xrMirror?.killed,
    wouldKill: !!globalThis.__xrMirror?.wouldKill, banner: document.querySelector('.xr-mirror-off')?.textContent ?? null }));
  const liveAcrossShot = after.passes > passesBefore && !after.killed;   // the whole page with the HUD hidden = the renderer's canvas as a person sees it
  const stats = await pg.evaluate(async (b64) => {
    const img = new Image(); img.src = `data:image/png;base64,${b64}`; await img.decode();
    const c = new OffscreenCanvas(img.width, img.height); const x = c.getContext('2d'); x.drawImage(img, 0, 0);
    const cx = x.getImageData((img.width >> 1) - 20, (img.height >> 1) - 20, 40, 40).data; let mg = 0;
    for (let i = 0; i < cx.length; i += 4) if (cx[i] > 150 && cx[i + 2] > 150 && cx[i + 1] < 90) mg++;
    const d = x.getImageData(0, 0, img.width, img.height).data; let sum = 0, sq = 0, n = 0;
    for (let i = 0; i < d.length; i += 16) { const l = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]; sum += l; sq += l * l; n++; }
    const mean = sum / n; return { mean: +mean.toFixed(1), sd: +Math.sqrt(Math.max(0, sq / n - mean * mean)).toFixed(1), magentaCentre: +(mg / (cx.length / 4)).toFixed(2) };
  }, shot.toString('base64'));
  await pg.close();
  return { ...r, stats, shot, liveAcrossShot, after };
}

try {
  const off = await run('off');
  console.log('  · off  ', JSON.stringify({ ...off, shot: undefined }));
  const first = await run('first');
  console.log('  · first', JSON.stringify({ ...first, shot: undefined }));
  const third = await run('third');
  console.log('  · third', JSON.stringify({ ...third, shot: undefined }));
  const slow = await run('first', { hold: false, slowMs: 45 });
  console.log('  · kill ', JSON.stringify({ ...slow, shot: undefined, seen: undefined }));
  if (OUT) { writeFileSync(OUT, first.shot); writeFileSync(OUT.replace(/\.png$/, '-off.png'), off.shot); writeFileSync(OUT.replace(/\.png$/, '-third.png'), third.shot); }
  const canvas = first.canvas;
  check('(setup) the session layer is bigger than the canvas, as on a headset', first.between === `${LAYER[0]}x${LAYER[1]}` && canvas !== first.between, `${first.between} vs canvas ${canvas}`);
  check('mirror "first" draws to the canvas while presenting', first.presenting && (first.mirror?.passes ?? 0) > 3, JSON.stringify(first.mirror));
  check('…through a CANVAS-sized intermediate target, not a layer-sized one', first.seen.length > 0 && first.seen.every((s) => s.fbt === canvas), JSON.stringify(first.seen));
  check('the eyes get the layer size back between passes', first.between === `${LAYER[0]}x${LAYER[1]}`, first.between);
  check('mode "third" draws too, through the same canvas-sized path', (third.mirror?.passes ?? 0) > 3 && third.seen.every((s) => s.fbt === canvas), JSON.stringify({ m: third.mirror, seen: third.seen }));
  check('mode "off" draws nothing', (off.mirror?.passes ?? 0) === 0, JSON.stringify(off.mirror));
  check('the mirror was LIVE across the screenshot (passes advanced, not killed)', first.liveAcrossShot && third.liveAcrossShot,
    JSON.stringify({ first: first.after, third: third.after }));
  check('the desktop shows what the eyes face: the marker box fills the centre with "first"', first.stats.magentaCentre > 0.8, JSON.stringify(first.stats));
  check('…and not with "off" (the canvas is not drawn while presenting)', off.stats.magentaCentre < 0.1, JSON.stringify(off.stats));
  console.log('  · pixels (info only):', JSON.stringify({ first: first.stats, third: third.stats, off: off.stats }));
  // THE KILLSWITCH, on its own: every frame forced over 30 ms, hold off → the mirror turns itself off and says so.
  check('killswitch: 30 slow frames switch the mirror off for the session', slow.after.killed === true, JSON.stringify(slow.after));
  check('…and it stops drawing once off (passes stop advancing)', !slow.liveAcrossShot, JSON.stringify(slow.after));
  check('…and says so on the desktop (banner)', /Desktop view paused/.test(slow.after.banner ?? ''), slow.after.banner);
  check('the visual runs held it without hiding a trip (hold is harness-only; wouldKill is how a trip shows there)',
    first.after.killed === false && third.after.killed === false, JSON.stringify({ first: first.after, third: third.after }));
  check('no page errors', errs.length === 0, errs.slice(0, 3).join(' | '));
} catch (e) { check('probe ran', false, e.message); }
finally { try { await browser.close(); } catch {} try { await world.close(); } catch {} }
done();
