// bun tools/xr-quad-colour-probe.mjs [--shots <dir>] — WHAT THE VR PANELS ACTUALLY PAINT (R's headset pass, 09-30:
// "little black squares like checkboxes" in World › Sky, "all colours washed out", "Style colour hexes don't render").
// The real client, ?xr=1, IWER session, the real domquad staging (its #xr-stage CSS) and the real vendored HTMLMesh.
//   raster  — each quad's canvas (texture.image) is dumped next to the desktop DOM shot of the same frame
//   swatch  — Settings › Style: every <input type=color> paints ITS colour on the quad (not the hex as text)
//   squares — World › Sky: no dark square is painted where the DOM shows none (hidden/unrendered form controls)
//   colour  — the quad's material through the REAL renderer's output pass: token colours in, the same values out
//   panel   — the quad's panel background IS the --panel-rgb token (no lift), in the raster and on screen
//   dimmed  — partial opacity (a disabled range, a dead row) lands as the browser composites it: group, multiplied
//   vr-a    — Settings › Style › VR panel opacity: default 1 (opaque pass), lower → the quad's panel alpha, reset → 1
// On Chromium the engine runs WebGPURenderer's WebGL 2 backend in the headset too (owner, 09-30), so this headless
// path IS the user path for the output transform. What it can't show: the headset's own compositor/display.
// Run one headless browser at a time; clouds are forced off before boot here.
import { launchBrowser, ownedWorld, checker } from './probe-harness.mjs';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';

const { check, done } = checker();
const shotDir = (() => { const i = process.argv.indexOf('--shots'); return i > 0 ? process.argv[i + 1] : null; })();
const shotBase = Number(process.env.SHOT_BASE ?? 100);
if (shotDir) mkdirSync(shotDir, { recursive: true });
const IWER_RAW = readFileSync(new URL('../node_modules/iwer/build/iwer.js', import.meta.url), 'utf8');
const DEVICE_LOOP = 'globalThis.requestAnimationFrame(this[P_SESSION].onDeviceFrame)';
if (IWER_RAW.split(DEVICE_LOOP).length !== 2) throw new Error(`iwer build changed: expected exactly one '${DEVICE_LOOP}'`);
const IWER = `globalThis.__iwerNativeRAF = globalThis.requestAnimationFrame.bind(globalThis);\n` +
  IWER_RAW.replace(DEVICE_LOOP, 'globalThis.__iwerNativeRAF(this[P_SESSION].onDeviceFrame)');

const world = await ownedWorld({ env: { SKIP_OPT_SWEEP: '1' } });
const { browser, page } = await launchBrowser();
const pg = await page();
const ev = (fn, arg) => Promise.race([pg.evaluate(fn, arg),
  new Promise((_, rej) => setTimeout(() => rej(new Error('page main thread pinned for 30 s')), 30000))]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let shotN = shotBase;
const save = (name, dataUrl) => { if (!shotDir || !dataUrl) return; const f = `${shotDir}/${shotN++}-${name}.png`; writeFileSync(f, Buffer.from(dataUrl.split(',')[1], 'base64')); console.log(`  · shot ${f}`); };

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
  window.__probe = { grants: 0 };
  const real = navigator.xr.requestSession.bind(navigator.xr);
  navigator.xr.requestSession = async (...a) => { const s = await real(...a); window.__probe.grants++; return s; };
});
const errs = [];
pg.on('pageerror', (e) => errs.push(String(e)));
pg.on('console', (m) => { if (m.text().startsWith('[colourprobe]')) console.log('  · ' + m.text()); });
pg.on('dialog', (d) => d.dismiss().catch(() => {}));

try {
  await pg.goto(`${world.origin}/?world=staging&name=colourprobe&key=${world.key}&xr=1`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await pg.waitForFunction(() => { const b = document.querySelector('#xrbtn'); return !!b && getComputedStyle(b).display !== 'none'; }, null, { timeout: 90000 }).catch(() => {});
  await pg.waitForFunction(() => !!document.getElementById('sec-style-tab') && !!document.getElementById('sec-sky-tab'), null, { timeout: 60000 }).catch(() => {});   // settings' tabs load lazily (ui.js)
  const gate = await ev(() => ({ xrbtn: !!document.querySelector('#xrbtn'), domQuads: typeof globalThis.__domQuads, sky: !!document.getElementById('sec-sky-tab'), style: !!document.getElementById('sec-style-tab') }));
  check('booted: visor, domquad hook, the sky and style tabs', gate.xrbtn && gate.domQuads === 'function' && gate.sky && gate.style, JSON.stringify(gate));
  if (!(gate.xrbtn && gate.sky && gate.style)) throw new Error('boot gate failed');
  const backend = await ev(async () => (await import('./lib/core.js')).backendName());
  console.log(`  · backend: ${backend}`);

  // ── dimmed, a REAL control: Settings › Audio's mic-sensitivity row, which push-to-talk dims to .45 (audiopanel.js
  // dimFloor) — the state made through the UI's own path (the PTT checkbox). Dimming is measured as the row's mean
  // contrast against its own background, dimmed ÷ live: blending is linear in sRGB on both paths, so that ratio IS the
  // effective alpha whatever each renderer draws for a slider. Desktop: Chrome's compositor (panel made opaque for the
  // shot, so both sit on the same ground). VR: the quad's raster. ──
  const CONTRAST = `(d) => { const h = new Map(); for (let i = 0; i < d.length; i += 4) { const k = (d[i] << 16) | (d[i + 1] << 8) | d[i + 2]; h.set(k, (h.get(k) ?? 0) + 1); }
    let mk = 0, mn = -1; for (const [k, n] of h) if (n > mn) { mk = k; mn = n; } const bg = [mk >> 16, (mk >> 8) & 255, mk & 255];
    let sum = 0; for (let i = 0; i < d.length; i += 4) sum += Math.max(Math.abs(d[i] - bg[0]), Math.abs(d[i + 1] - bg[1]), Math.abs(d[i + 2] - bg[2]));
    return { bg, c: sum / (d.length / 4) }; }`;
  const ptt = (on) => ev(async (on) => {
    const row = [...document.querySelectorAll('#sec-audio .sp-row')].find((l) => l.querySelector('.nm')?.textContent.trim() === 'push-to-talk');
    const cb = row?.querySelector('input[type=checkbox]'); if (!cb) return null;
    if (cb.checked !== on) cb.click();
    await new Promise((r) => setTimeout(r, 150));
    const floor = document.querySelector('#sec-audio [data-meter]')?.closest('.sp-row');
    return { checked: cb.checked, opacity: floor ? getComputedStyle(floor).opacity : null };
  }, on);
  await ev(async () => { const F = await import('./lib/frames.js'); F.getFrame('settings')?.show(); document.getElementById('sec-audio-tab').click();
    document.documentElement.style.setProperty('--panel-a', '1'); });
  await sleep(400);
  const deskDim = {};
  for (const on of [false, true]) {
    const st = await ptt(on);
    await sleep(250);
    const el = await pg.$('#sec-audio [data-meter]');
    const rowEl = el ? await el.evaluateHandle((e) => e.closest('.sp-row')) : null;
    const png = rowEl ? await rowEl.asElement().screenshot() : null;
    if (png && shotDir) { const f = `${shotDir}/${shotN++}-dimmed-real-desktop-${on ? 'ptt-dimmed' : 'live'}.png`; writeFileSync(f, png); console.log(`  · shot ${f}`); }
    deskDim[on ? 'dim' : 'live'] = png ? await ev(async ([b64, fn]) => { const img = new Image(); img.src = 'data:image/png;base64,' + b64; await img.decode();
      const c = document.createElement('canvas'); c.width = img.width; c.height = img.height; const x = c.getContext('2d'); x.drawImage(img, 0, 0);
      return eval(fn)(x.getImageData(0, 0, c.width, c.height).data); }, [png.toString('base64'), CONTRAST]) : null;
    deskDim[on ? 'dimState' : 'liveState'] = st;
  }
  await ptt(false);
  await ev(() => document.documentElement.style.removeProperty('--panel-a'));

  // open both frames on the tabs under test (desktop), and shoot the DOM
  for (const [frame, tab] of [['world', 'sky'], ['settings', 'style']]) {
    await ev(async ([frame, tab]) => { const F = await import('./lib/frames.js'); F.getFrame(frame)?.show(); document.getElementById(`sec-${tab}-tab`).click(); }, [frame, tab]);
  }
  await sleep(800);
  for (const frame of ['world', 'settings']) {
    const el = await pg.$(`.frame[data-frame="${frame}"]`);
    if (shotDir && el) { const f = `${shotDir}/${shotN++}-desktop-${frame}.png`; await el.screenshot({ path: f }); console.log(`  · shot ${f}`); }
  }

  // ── into VR: the real entry stages the frames; show the two quads ──
  await ev(() => document.querySelector('#xrbtn').click());
  await pg.waitForFunction(() => window.__probe.grants >= 1 && globalThis.__domQuads().staged > 0, null, { timeout: 30000 }).catch(() => {});
  const shown = await ev(async () => { const D = await import('./lib/domquad.js'); return [D.domQuadShow('world', true), D.domQuadShow('settings', true)]; });
  check('in a session, the world and settings quads show', shown.every(Boolean), JSON.stringify(shown));
  await sleep(1500);   // SVG icons load async and re-raster through the observer

  const raster = await ev(async () => {
    const D = await import('./lib/domquad.js');
    const out = {};
    for (const id of ['world', 'settings']) {
      const t = D.domQuadTexture(id); const cv = t.image; const ctx = cv.getContext('2d');
      const el = t.dom; const er = el.getBoundingClientRect(); const s = cv.width / er.width;
      const px = (x, y) => Array.from(ctx.getImageData(Math.round(x * s), Math.round(y * s), 1, 1).data);
      // every form control the DOM does NOT render (hidden, display:none via CSS/attribute, zero-size, visibility)
      // must leave nothing on the quad; every one it DOES render is listed with what the quad shows at its centre
      const controls = [...el.querySelectorAll('input, select, option')].map((c) => {
        const r = c.getBoundingClientRect(); const cs = getComputedStyle(c);
        const rendered = r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && !c.closest('[hidden]') && c.checkVisibility?.() !== false;
        return { tag: c.tagName.toLowerCase(), type: c.type ?? null, value: c.value, rendered, x: r.left - er.left, y: r.top - er.top, w: r.width, h: r.height,
          centre: rendered ? px(r.left - er.left + r.width / 2, r.top - er.top + r.height / 2) : null };
      });
      // the panel background = the raster's most common pixel (rgba)
      const all = ctx.getImageData(0, 0, cv.width, cv.height).data; const hist = new Map();
      for (let i = 0; i < all.length; i += 4) { const k = (all[i] << 24 | all[i + 1] << 16 | all[i + 2] << 8 | all[i + 3]) >>> 0; hist.set(k, (hist.get(k) ?? 0) + 1); }
      let mk = 0, mn = -1; for (const [k, n] of hist) if (n > mn) { mk = k; mn = n; }
      const mode = [mk >>> 24, (mk >>> 16) & 255, (mk >>> 8) & 255, mk & 255];
      out[id] = { url: cv.toDataURL('image/png'), w: cv.width, h: cv.height, controls, mode, modeShare: mn / (all.length / 4) };
    }
    return out;
  });
  save('quad-raster-world-sky', raster.world.url);
  save('quad-raster-settings-style', raster.settings.url);

  // ── #3: the Style swatches paint their colour ──
  const colours = raster.settings.controls.filter((c) => c.type === 'color' && c.rendered);
  console.log(`  · style swatches: ${JSON.stringify(colours.map((c) => ({ v: c.value, centre: c.centre })))}`);
  const hexRgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const near = (a, b, tol) => a && b && a.slice(0, 3).every((v, i) => Math.abs(v - b[i]) <= tol);
  check('style: there are four colour swatches on the quad', colours.length === 4, `${colours.length}`);
  check('style: every swatch paints its own colour at its centre (±6)', colours.length > 0 && colours.every((c) => near(c.centre, hexRgb(c.value), 6)),
    JSON.stringify(colours.map((c) => `${c.value} → rgb(${c.centre?.slice(0, 3)})`)));

  // ── panel: the quad's background is the token, no lift (R, 09-30: the 18% lift was ACES compensation, obsolete) ──
  const panelTok = await ev(() => getComputedStyle(document.documentElement).getPropertyValue('--panel-rgb').trim().split(/\s+/).map(Number));
  for (const id of ['settings', 'world']) {
    const r = raster[id];
    console.log(`  · ${id} raster panel (mode, ${(r.modeShare * 100).toFixed(0)}% of pixels): rgba(${r.mode}) — token rgb(${panelTok})`);
    check(`panel: the ${id} quad's raster background is the --panel-rgb token, opaque (Δ ≤ 1)`, near(r.mode, panelTok, 1) && r.mode[3] === 255, `rgba(${r.mode}) vs rgb(${panelTok})`);
  }

  // ── vr-a: Settings › Style › VR panel opacity. Default 1: the quad is opaque, in the opaque pass ──
  const vrA = async (v) => ev(async (v) => {
    const D = await import('./lib/domquad.js');
    const row = [...document.querySelectorAll('#sec-style .row')].find((r) => r.querySelector('.nm')?.textContent === 'VR panel opacity');
    const input = row?.querySelector('input[type=range]');
    if (!input) return { found: false, desktopLabel: [...document.querySelectorAll('#sec-style .row .nm')].map((n) => n.textContent) };
    const before = input.value;
    if (v != null) { input.value = String(v); input.dispatchEvent(new Event('input')); }
    await new Promise((r) => setTimeout(r, 400));   // the re-raster rides the observer/throttle
    const t = D.domQuadTexture('settings');
    const cv = t.image, ctx = cv.getContext('2d');
    const all = ctx.getImageData(0, 0, cv.width, cv.height).data; const hist = new Map();
    for (let i = 0; i < all.length; i += 4) { const k = (all[i] << 24 | all[i + 1] << 16 | all[i + 2] << 8 | all[i + 3]) >>> 0; hist.set(k, (hist.get(k) ?? 0) + 1); }
    let mk = 0, mn = -1; for (const [k, n] of hist) if (n > mn) { mk = k; mn = n; }
    const probeMat = D.domQuadMesh?.('settings')?.material ?? null;
    const cssA = getComputedStyle(document.documentElement).getPropertyValue('--xr-panel-a').trim();
    return { found: true, before, value: input.value, cssA, stored: JSON.parse(localStorage.getItem('ew-style-tokens') || '{}')['--xr-panel-a'] ?? null,
      mode: [mk >>> 24, (mk >>> 16) & 255, (mk >>> 8) & 255, mk & 255], mat: probeMat ? { transparent: probeMat.transparent, depthWrite: probeMat.depthWrite, alphaTest: probeMat.alphaTest } : null };
  }, v);
  const a1 = await vrA(null);
  console.log(`  · VR panel opacity at default: ${JSON.stringify(a1)}`);
  check('vr-a: Settings › Style has a "VR panel opacity" dial, default 1', a1.found && Number(a1.value) === 1, JSON.stringify(a1));
  check('vr-a: at 1 the quad stays opaque (opaque pass, panel alpha 255)', a1.found && a1.mode?.[3] === 255 && a1.mat?.transparent === false, JSON.stringify({ mode: a1.mode, mat: a1.mat }));
  const a06 = await vrA(0.6);
  console.log(`  · VR panel opacity at 0.6: ${JSON.stringify(a06)}`);
  check('vr-a: at the minimum (0.6) the quad\'s panel alpha is 0.6 (153 ±2), its colour still the token', a06.found && Math.abs(a06.mode?.[3] - 153) <= 2 && near(a06.mode, panelTok, 2), JSON.stringify(a06.mode));
  check('vr-a: …and the quad blends (transparent pass, depthWrite on)', a06.mat?.transparent === true && a06.mat?.depthWrite === true, JSON.stringify(a06.mat));
  check('vr-a: …persisted with the style tokens', a06.stored === '0.6', String(a06.stored));

  const aBack = await vrA(1);   // back to opaque for the rest (the bright-scene shots set their own)

  // ── dimmed, the real control in VR: the same row on the settings quad's raster, live and PTT-dimmed ──
  const vrDim = {};
  await ev(() => document.getElementById('sec-audio-tab').click());
  for (const on of [false, true]) {
    await ptt(on);
    await sleep(600);   // the observer re-rasters
    vrDim[on ? 'dim' : 'live'] = await ev(async ([fn, tag]) => {
      const D = await import('./lib/domquad.js');
      const t = D.domQuadTexture('settings'); t.paused = false; t.update();
      const cv = t.image, er = t.dom.getBoundingClientRect(), s = cv.width / er.width;
      const r = document.querySelector('#sec-audio [data-meter]').closest('.sp-row').getBoundingClientRect();
      const x = Math.round((r.left - er.left) * s), y = Math.round((r.top - er.top) * s), w = Math.round(r.width * s), h = Math.round(r.height * s);
      const crop = document.createElement('canvas'); crop.width = w; crop.height = h; crop.getContext('2d').drawImage(cv, x, y, w, h, 0, 0, w, h);
      return { ...eval(fn)(cv.getContext('2d').getImageData(x, y, w, h).data), url: crop.toDataURL('image/png') };
    }, [CONTRAST, on]);
    save(`dimmed-real-quad-${on ? 'ptt-dimmed' : 'live'}`, vrDim[on ? 'dim' : 'live'].url);
  }
  await ptt(false);
  await ev(() => document.getElementById('sec-style-tab').click());
  await sleep(300);
  const aDesk = deskDim.dim && deskDim.live ? deskDim.dim.c / deskDim.live.c : NaN, aVR = vrDim.dim.c / vrDim.live.c;
  console.log(`  · mic-sensitivity row under PTT (opacity ${deskDim.dimState?.opacity}): desktop contrast ${deskDim.live?.c.toFixed(2)} → ${deskDim.dim?.c.toFixed(2)} = alpha ${aDesk.toFixed(3)} (${(aDesk * 255).toFixed(1)}/255); `
    + `VR quad ${vrDim.live.c.toFixed(2)} → ${vrDim.dim.c.toFixed(2)} = alpha ${aVR.toFixed(3)} (${(aVR * 255).toFixed(1)}/255); grounds desktop rgb(${deskDim.live?.bg}) VR rgb(${vrDim.live.bg})`);
  check('dimmed (real): PTT dims the mic-sensitivity row on the desktop (the state exists)', deskDim.dimState?.opacity === '0.45' && aDesk < 0.6, `opacity ${deskDim.dimState?.opacity}, alpha ${aDesk.toFixed(3)}`);
  check('dimmed (real): …and on the VR quad by the same alpha (within 5/255)', Math.abs(aVR - aDesk) * 255 <= 5, `desktop ${(aDesk * 255).toFixed(1)}/255, VR ${(aVR * 255).toFixed(1)}/255`);
  check('vr-a: back at 1 the quad returns to the opaque pass', aBack.mode?.[3] === 255 && aBack.mat?.transparent === false, JSON.stringify({ mode: aBack.mode, mat: aBack.mat }));

  // ── #1: nothing the DOM hides is painted as a box on the quad ──
  const sky = raster.world.controls;
  console.log(`  · sky controls: ${sky.length} (${sky.filter((c) => c.rendered).length} rendered); unrendered: ${JSON.stringify(sky.filter((c) => !c.rendered).map((c) => `${c.tag}${c.type ? ':' + c.type : ''}@${Math.round(c.x)},${Math.round(c.y)} ${Math.round(c.w)}×${Math.round(c.h)}`))}`);
  const squares = await ev(async () => {
    // paint census: every fill/stroke rect the rasteriser makes for an element the DOM does not render. The raster is
    // re-run with fill()/stroke() wrapped so each draw is attributed to the element being drawn at that moment.
    const D = await import('./lib/domquad.js');
    const t = D.domQuadTexture('world'); const root = t.dom;
        const unpainted = (e) => !e.checkVisibility({ opacityProperty: true, visibilityProperty: true });
    const zeroOrHidden = new Set([...root.querySelectorAll('*')].filter(unpainted));
    const inHidden = (e) => { for (let n = e; n && n !== root.parentElement; n = n.parentElement) if (zeroOrHidden.has(n)) return true; return false; };
    const P = CanvasRenderingContext2D.prototype; const of = P.fill, os = P.stroke, ot = P.fillText; const hits = [];
    const gcs = window.getComputedStyle; let cur = null;
    window.getComputedStyle = function (e, ...a) { cur = e; return gcs.call(this, e, ...a); };
    P.fill = function (...a) { if (cur && inHidden(cur)) hits.push(`${cur.tagName.toLowerCase()}${cur.type ? ':' + cur.type : ''}.${cur.className || ''} fill ${this.fillStyle}`); return of.apply(this, a); };
    P.stroke = function (...a) { if (cur && inHidden(cur)) hits.push(`${cur.tagName.toLowerCase()}${cur.type ? ':' + cur.type : ''}.${cur.className || ''} stroke ${this.strokeStyle}`); return os.apply(this, a); };
    P.fillText = function (txt, ...a) { if (cur && inHidden(cur)) hits.push(`${cur.tagName.toLowerCase()}.${cur.className || ''} text '${txt}' ${this.fillStyle}`); return ot.call(this, txt, ...a); };
    try { t.paused = false; t.update(); } finally { P.fill = of; P.stroke = os; P.fillText = ot; window.getComputedStyle = gcs; }
    return { hits, hidden: zeroOrHidden.size, natives: root.querySelectorAll('select.dd-native').length };
  });
  console.log(`  · sky paint census: ${squares.natives} skinned native selects; ${squares.hidden} elements the DOM doesn't render; painted for them: ${JSON.stringify(squares.hits.slice(0, 12))}${squares.hits.length > 12 ? ` (+${squares.hits.length - 12})` : ''}`);
  check('sky: the quad paints NOTHING for an element the DOM does not render', squares.hits.length === 0, `${squares.hits.length} paints`);

  // ── caption: World › Mods' sub-area captions (.sec-cap) paint as headings on the quad, not as body text — the rule
  // above (a one-sided border), the capitals and the brand tint all reach the raster (owner, 10-01) ──
  const caps = await ev(async () => {
    document.getElementById('sec-mods-tab').click();
    await new Promise((r) => setTimeout(r, 400));
    const D = await import('./lib/domquad.js');
    const t = D.domQuadTexture('world'); const root = t.dom;
    const norm = document.createElement('canvas').getContext('2d');
    const P = CanvasRenderingContext2D.prototype; const os = P.stroke, ot = P.fillText; const seen = new Map();
    const gcs = window.getComputedStyle; let cur = null;
    window.getComputedStyle = function (e, ...a) { cur = e; return gcs.call(this, e, ...a); };
    const rec = (e) => { const c = e?.nodeType === 1 ? e : e?.parentElement; const cap = c?.closest?.('.sec-cap'); if (!cap) return null;
      if (!seen.has(cap)) seen.set(cap, { text: cap.textContent, strokes: [], texts: [] }); return seen.get(cap); };
    P.stroke = function (...a) { const r = rec(cur); if (r) r.strokes.push(this.strokeStyle); return os.apply(this, a); };
    P.fillText = function (txt, ...a) { const r = rec(cur); if (r) r.texts.push({ txt, fill: this.fillStyle, font: this.font }); return ot.call(this, txt, ...a); };
    try { t.paused = false; t.update(); } finally { P.stroke = os; P.fillText = ot; window.getComputedStyle = gcs; }
    const out = [...seen.entries()].map(([el, r]) => { const cs = gcs(el); norm.fillStyle = cs.color; const want = norm.fillStyle;
      norm.fillStyle = gcs(el.closest('.body') ?? el.parentElement).color; return { ...r, first: el === el.parentElement.firstElementChild, want, body: norm.fillStyle }; });
    return { caps: out, total: root.querySelectorAll('.sec-cap').length };
  });
  console.log(`  · mods captions: ${JSON.stringify(caps.caps.map((c) => ({ t: c.text, rule: c.strokes.length, texts: c.texts.map((x) => x.txt), fill: c.texts[0]?.fill })))}`);
  check('caption: every World › Mods caption is painted on the quad', caps.total >= 3 && caps.caps.length === caps.total, `${caps.caps.length}/${caps.total}`);
  check('caption: each is painted in capitals, bold, in its own tint (not the body text colour)',
    caps.caps.length > 0 && caps.caps.every((c) => c.texts.length > 0 && c.texts.every((x) => x.txt === x.txt.toUpperCase() && /^(600|bold)/.test(x.font)) && c.texts[0].fill === c.want && c.want !== c.body),
    JSON.stringify(caps.caps.map((c) => [c.text, c.texts[0], c.want, c.body])));
  check('caption: every caption but a pane\'s first strokes a rule above it on the quad',
    caps.caps.length > 0 && caps.caps.every((c) => c.first ? c.strokes.length === 0 : c.strokes.length === 1), JSON.stringify(caps.caps.map((c) => [c.text, c.first, c.strokes])));

  // ── dimmed: partial opacity, desktop (Chrome's own compositor) vs the quad's raster, pixel for pixel ──
  // A: one element at .5 · B: a .5 GROUP whose child covers its own background (per-paint alpha would let the parent's
  // amber bleed through the child) · C: .5 inside .5 = .25 · D: a dead row at .42 (the house `.mrow.dead`) · E: an
  // inline <svg> icon with its own inline opacity .5 (the layer applies it; the serialised clone must not apply it again)
  const fx = await ev(() => {
    const d = document.createElement('div'); d.id = 'dimfx';
    d.style.cssText = 'position:fixed;left:0;top:0;z-index:2147483647;width:310px;height:60px;background:rgb(5,20,20);display:flex;gap:10px;padding:10px;box-sizing:border-box';
    d.innerHTML = '<div style="width:40px;height:40px;background:#8fe8c8;opacity:.5"></div>'
      + '<div style="width:40px;height:40px;background:#ffc46b;opacity:.5"><div style="width:40px;height:40px;background:#8fe8c8"></div></div>'
      + '<div style="width:40px;height:40px;opacity:.5"><div style="width:40px;height:40px;background:#ebebe9;opacity:.5"></div></div>'
      + '<div style="width:40px;height:40px;background:#ebebe9;opacity:.42"></div>'
      + '<svg width="40" height="40" viewBox="0 0 40 40" style="opacity:.5"><rect width="40" height="40" fill="#8fe8c8"/></svg>';
    document.body.appendChild(d);
    return [...d.children].map((c) => { const r = c.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; });
  });
  await sleep(200);
  const deskPng = await pg.screenshot({ clip: { x: 0, y: 0, width: 310, height: 60 } });
  const dim = await ev(async ([png, pts]) => {
    const img = new Image(); img.src = 'data:image/png;base64,' + png; await img.decode();
    const c = document.createElement('canvas'); c.width = img.width; c.height = img.height; const x = c.getContext('2d'); x.drawImage(img, 0, 0);
    const desk = pts.map(([px, py]) => Array.from(x.getImageData(Math.floor(px), Math.floor(py), 1, 1).data).slice(0, 3));
    const { HTMLMesh } = await import('./lib/vendor/htmlmesh.js');
    const d = document.getElementById('dimfx'); const mesh = new HTMLMesh(d, { scale: 1 }); mesh.material.map.pause();
    const svg = d.querySelector('svg'), t0 = performance.now();   // EIDO (2): the icon draws once its image has loaded
    while (!svg.__eidoReady && performance.now() - t0 < 5000) await new Promise((r) => setTimeout(r, 50));
    mesh.material.map.resume(); mesh.material.map.pause();   // one raster with the icon in it
    const q = mesh.material.map.image.getContext('2d');
    const quad = pts.map(([px, py]) => Array.from(q.getImageData(Math.floor(px), Math.floor(py), 1, 1).data).slice(0, 3));
    const url = mesh.material.map.image.toDataURL('image/png');
    mesh.dispose(); d.remove();
    return { desk, quad, url };
  }, [deskPng.toString('base64'), fx]);
  if (shotDir) { const f = `${shotDir}/${shotN++}-dimmed-fixture-desktop.png`; writeFileSync(f, deskPng); console.log(`  · shot ${f}`); }
  save('dimmed-fixture-quad', dim.url);
  const dimNames = ['A .5', 'B .5 group', 'C .5×.5', 'D .42', 'E svg .5'];
  const dimRows = dimNames.map((k, i) => ({ k, desk: dim.desk[i], quad: dim.quad[i], d: Math.max(...dim.desk[i].map((v, j) => Math.abs(v - dim.quad[i][j]))) }));
  console.log(`  · dimmed fixture, desktop vs quad: ${dimRows.map((r) => `${r.k} rgb(${r.desk}) vs rgb(${r.quad}) Δ${r.d}`).join('; ')}`);
  check('dimmed: every partial-opacity case lands on the quad as on the desktop (Δ ≤ 3 of 255)', dimRows.every((r) => r.d <= 3), dimRows.map((r) => `${r.k} Δ${r.d}`).join(', '));

  // ── exit, then #2: the quad material through the real renderer's output pass ──
  // EXIT IS SLOW HERE, NOT HUNG (09-30, chased): session.end() resolves at once, then the desktop's first frames
  // rebuild its pipelines (the TSL warning burst) on a headless main thread already at ~0.7 s/frame, and the page can
  // stay unresponsive for more than ev()'s 30 s. Through the product's own leaveVR (scratch exit-diag, with and without
  // PTT toggled in VR) the session ended ~10 s after the call either way, getUserMedia was never called, and the page
  // answered every 5 s poll after. So: wait for the page to answer again (up to 3 min, measured and printed); if it
  // never does, pause it over CDP and print the JS stack it is stuck in.
  { const t0 = Date.now();
    await pg.evaluate(() => { window.__iwerDevice.activeSession?.end(); });
    let ok = false;
    while (!ok && Date.now() - t0 < 180000) ok = await Promise.race([pg.evaluate(() => !window.__iwerDevice.activeSession), sleep(5000).then(() => false)]);
    console.log(`  · session ended; page answering again after ${((Date.now() - t0) / 1000).toFixed(1)} s`);
    if (!ok) {
      const cdp = await pg.context().newCDPSession(pg); await cdp.send('Debugger.enable');
      const paused = new Promise((r) => cdp.once('Debugger.paused', r)); await cdp.send('Debugger.pause');
      const e = await Promise.race([paused, sleep(10000).then(() => null)]);
      console.log(`  · EXIT HANG — stack: ${e ? e.callFrames.slice(0, 12).map((f) => `${f.functionName || '(anon)'}@${f.url.split('/').pop()}:${f.location.lineNumber + 1}`).join(' < ') : 'no JS pause within 10 s (native/GPU)'}`);
      throw new Error('the page never answered after the session ended (3 min)');
    }
  }
  await pg.waitForFunction(() => !window.__iwerDevice.activeSession, null, { timeout: 10000 }).catch(() => {});
  await sleep(500);
  const tokens = await ev(() => {
    const cs = getComputedStyle(document.documentElement); const n = document.createElement('canvas').getContext('2d');
    const norm = (v) => { n.fillStyle = '#000'; n.fillStyle = v; return n.fillStyle; };
    const out = {};
    for (const k of ['--fg', '--brand', '--attn', '--dim', '--accent']) { const v = cs.getPropertyValue(k).trim(); if (v) out[k] = norm(v); }
    const p = cs.getPropertyValue('--panel-rgb').trim().split(/\s+/).map(Number); if (p.length === 3) out['--panel-rgb'] = norm(`rgb(${p.join(',')})`);
    return out;
  });
  console.log(`  · tokens: ${JSON.stringify(tokens)}`);
  const measure = (exposure = null, path = 'domquad') => ev(async ([tokens, exposureSet, path]) => {
    const { THREE, renderer } = await import('./lib/core.js');
    const D = await import('./lib/domquad.js');
    const names = Object.keys(tokens); const cols = names.map((k) => tokens[k]);
    const cv = document.createElement('canvas'); cv.width = 64 * cols.length; cv.height = 64;
    const c2 = cv.getContext('2d'); cols.forEach((c, i) => { c2.fillStyle = c; c2.fillRect(i * 64, 0, 64, 64); });
    // the quad's OWN material, as domquad builds it (a stand-in HTMLMesh over a div painted in the token colours)
    const { HTMLMesh } = await import('./lib/vendor/htmlmesh.js');
    const div = document.createElement('div'); div.style.cssText = `position:fixed;left:0;top:0;width:${cols.length * 64}px;height:64px;display:flex`;
    for (const c of cols) { const s = document.createElement('div'); s.style.cssText = `width:64px;height:64px;background:${c}`; div.appendChild(s); }
    document.body.appendChild(div);
    let mesh = new HTMLMesh(div, { scale: 1 });
    if (path === 'canvasquads') {   // the ?canvasquads=1 fallback's own quad (xrpanels.makePanel), fed the same pixels
      const X = await import('./lib/xrpanels.js');
      const p = X.makePanel?.({ id: 'probe', fields: () => [], dispatch: () => {} }, 0, 1);
      if (p) { p.canvas.width = mesh.material.map.image.width; p.canvas.height = mesh.material.map.image.height; p.canvas.getContext('2d').drawImage(mesh.material.map.image, 0, 0); p.tex.needsUpdate = true;
        p.mesh.scale.set(cols.length * 0.064, 0.064, 1); p.mesh.position.set(0, 0, 0); p.mesh.rotation.set(0, 0, 0); mesh = p.mesh; mesh.material.map.pause = () => {}; }
    }
    if (path === 'plate') {   // a head-locked canvas plate as vrmic's note and the XR curtain's splash build it: blended, depth off
      const tex = new THREE.CanvasTexture(mesh.material.map.image); tex.colorSpace = THREE.SRGBColorSpace;
      const plate = new THREE.Mesh(new THREE.PlaneGeometry(cols.length * 0.064, 0.064), new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthTest: false, depthWrite: false }));
      (await import('./lib/quadcolour.js')).quadMaterial?.(plate, renderer);
      mesh.dispose(); mesh = plate; tex.pause = () => {};
    }
    if (path === 'domquad') { mesh.material.transparent = false; mesh.material.alphaTest = 0.5; }
    if (path === 'domquad') D.prepareQuadMaterial?.(mesh);   // absent on a parent without the fix: the stand-in then carries the bare HTMLMesh material
    div.remove(); mesh.material.map.pause();
    const sc = new THREE.Scene(); sc.add(mesh);
    const w = cols.length * 0.064, cam = new THREE.OrthographicCamera(-w / 2, w / 2, 0.032, -0.032, 0.01, 10); cam.position.z = 1;
    const size = renderer.getSize(new THREE.Vector2()); const dpr = renderer.getPixelRatio();
    const read = () => { renderer.render(sc, cam); const g = renderer.domElement; const tmp = document.createElement('canvas'); tmp.width = g.width; tmp.height = g.height; const t2 = tmp.getContext('2d'); t2.drawImage(g, 0, 0);
      return names.map((_, i) => Array.from(t2.getImageData(Math.round(((i + 0.5) / cols.length) * g.width), Math.round(g.height / 2), 1, 1).data).slice(0, 3)); };
    const exp0 = renderer.toneMappingExposure; if (exposureSet != null) renderer.toneMappingExposure = exposureSet;
    for (let k = 0; k < 6; k++) { read(); await new Promise((r) => setTimeout(r, 120)); }   // pipelines compile
    const got = read();
    const fbt = [...(renderer._frameBufferTargets?.values?.() ?? [])].map((t) => ({ type: t.texture.type, samples: t.samples }));
    const served = await fetch('/lib/quadcolour.js').then((r) => r.text()).then((t) => /div\(toneMappingExposure\);/.test(t) && !/max\(mat3/.test(t)).catch(() => null);
    const gl = renderer.backend?.gl; const cbf = gl ? !!gl.getExtension('EXT_color_buffer_float') : null;
    console.log('[colourprobe] fbt', JSON.stringify(fbt), 'served-unclamped', served, 'EXT_color_buffer_float', cbf);
    const exposure = renderer.toneMappingExposure, toneMapping = renderer.toneMapping;
    const url = (() => { renderer.render(sc, cam); const g = renderer.domElement; const tmp = document.createElement('canvas'); tmp.width = g.width; tmp.height = g.height; tmp.getContext('2d').drawImage(g, 0, 0); return tmp.toDataURL('image/png'); })();
    renderer.toneMappingExposure = exp0;
    const depth = { test: mesh.material.depthTest, write: mesh.material.depthWrite };
    mesh.dispose?.();   // a plate has none (quadMaterial must not assume one)
    return { names, want: cols, got, exposure, toneMapping, url, size: [size.x, size.y, dpr], depth };
  }, [tokens, exposure, path]);
  const setGrade = (g) => ev(async (g) => (await import('./lib/quadcolour.js').catch(() => null))?.setGrade(g, false) ?? null, g);
  const hadGrade = await setGrade({ saturation: 1, contrast: 1 });   // null on a parent without quadcolour.js
  const m = await measure();
  save('quad-output-swatches', m.url);
  const rows = m.names.map((k, i) => ({ k, want: m.want[i], got: `#${m.got[i].map((v) => v.toString(16).padStart(2, '0')).join('')}`, d: Math.max(...m.got[i].map((v, j) => Math.abs(v - hexRgb(m.want[i])[j]))) }));
  console.log(`  · output pass (toneMapping ${m.toneMapping}, exposure ${m.exposure}):`);
  for (const r of rows) console.log(`      ${r.k.padEnd(20)} token ${r.want}  → on screen ${r.got}   (max Δ ${r.d})`);
  check('colour: every token colour leaves the renderer as it went in (max Δ ≤ 4 of 255)', rows.every((r) => r.d <= 4), rows.map((r) => `${r.k} Δ${r.d}`).join(', '));
  // the sky moves the exposure (sky.js: warmth, the exposure slider); the panel must not move with it
  const me = await measure(0.7);
  const rowsE = me.names.map((k, i) => ({ k, d: Math.max(...me.got[i].map((v, j) => Math.abs(v - hexRgb(me.want[i])[j]))) }));
  console.log(`  · at exposure ${me.exposure}: ${me.names.map((k, i) => `${k} ${me.want[i]}→#${me.got[i].map((v) => v.toString(16).padStart(2, '0')).join('')}`).join(', ')}`);
  check('colour: …and at a dimmer sky\'s exposure (0.7) too', rowsE.every((r) => r.d <= 4), rowsE.map((r) => `${r.k} Δ${r.d}`).join(', '));
  // the ?canvasquads=1 fallback (xrpanels.makePanel): its CanvasTexture carried no colorSpace
  const mc = await measure(null, 'canvasquads');
  const rowsC = mc.names.map((k, i) => ({ k, d: Math.max(...mc.got[i].map((v, j) => Math.abs(v - hexRgb(mc.want[i])[j]))) }));
  console.log(`  · canvasquads fallback: ${mc.names.map((k, i) => `${k} ${mc.want[i]}→#${mc.got[i].map((v) => v.toString(16).padStart(2, '0')).join('')}`).join(', ')}`);
  check('colour: the ?canvasquads fallback quad shows the token colours too', rowsC.every((r) => r.d <= 4), rowsC.map((r) => `${r.k} Δ${r.d}`).join(', '));
  // the head-locked plates (vrmic's in-VR note, the XR curtain's splash) through the same quadMaterial
  const mp = await measure(null, 'plate');
  const rowsP = mp.names.map((k, i) => ({ k, d: Math.max(...mp.got[i].map((v, j) => Math.abs(v - hexRgb(mp.want[i])[j]))) }));
  console.log(`  · head-locked plate: ${mp.names.map((k, i) => `${k} ${mp.want[i]}→#${mp.got[i].map((v) => v.toString(16).padStart(2, '0')).join('')}`).join(', ')}; depth ${JSON.stringify(mp.depth)}`);
  check('colour: a head-locked plate (blended, depth off) shows the token colours too, and keeps its depth settings',
    rowsP.every((r) => r.d <= 4) && mp.depth.test === false && mp.depth.write === false, `${rowsP.map((r) => `${r.k} Δ${r.d}`).join(', ')} ${JSON.stringify(mp.depth)}`);
  // the REAL settings and world quads (their own material, as domquad builds them) through the output pass, for the eye
  for (const id of ['settings', 'world']) {
    const url = await ev(async (id) => {
      const { THREE, renderer } = await import('./lib/core.js');
      const D = await import('./lib/domquad.js');
      const rig = new THREE.Scene(); D.domQuadsEnter(rig); D.domQuadShow(id, true);   // staged again (the session is over) to draw it
      await new Promise((r) => setTimeout(r, 800));
      const mesh = rig.children.find((o) => o.material?.map === D.domQuadTexture(id));
      rig.children.forEach((o) => { o.visible = o === mesh; });
      mesh.position.set(0, 0, 0); mesh.rotation.set(0, 0, 0); mesh.updateMatrixWorld(true);
      const bb = new THREE.Box3().setFromObject(mesh); const w = bb.max.x - bb.min.x, h = bb.max.y - bb.min.y;
      const g = renderer.domElement; const asp = g.width / g.height; const hw = Math.max(w / 2, h / 2 * asp), hh = hw / asp;
      const cam = new THREE.OrthographicCamera(-hw, hw, hh, -hh, 0.01, 10); cam.position.z = 1;
      rig.background = new THREE.Color(0x000000);
      let out = null;
      for (let k = 0; k < 6; k++) { renderer.render(rig, cam); await new Promise((r) => setTimeout(r, 120)); }
      renderer.render(rig, cam); const tmp = document.createElement('canvas'); tmp.width = g.width; tmp.height = g.height; tmp.getContext('2d').drawImage(g, 0, 0); out = tmp.toDataURL('image/png');
      D.domQuadsExit(rig);
      return out;
    }, id);
    save(`quad-rendered-${id}`, url);
  }
  // vr-a over a BRIGHT scene: the settings quad rendered through the real renderer with a bright backdrop behind it,
  // at VR panel opacity 1 (the token, whatever is behind) and at the dial's minimum (the backdrop shows through)
  const bright = [];
  for (const a of [1, 0.6]) {
    const r = await ev(async (a) => {
      const { THREE, renderer } = await import('./lib/core.js');
      const D = await import('./lib/domquad.js'); const S = await import('./lib/stylepanel.js');
      S.setXrPanelAlpha?.(a);
      const rig = new THREE.Scene(); D.domQuadsEnter(rig); D.domQuadShow('settings', true);
      await new Promise((r) => setTimeout(r, 900));
      const mesh = rig.children.find((o) => o.material?.map === D.domQuadTexture('settings'));
      rig.children.forEach((o) => { o.visible = o === mesh; });
      mesh.position.set(0, 0, 0); mesh.rotation.set(0, 0, 0); mesh.updateMatrixWorld(true);
      const bb = new THREE.Box3().setFromObject(mesh); const w = bb.max.x - bb.min.x, h = bb.max.y - bb.min.y;
      const g = renderer.domElement; const asp = g.width / g.height; const hw = Math.max(w / 2, h / 2 * asp) * 1.25, hh = hw / asp;
      const cam = new THREE.OrthographicCamera(-hw, hw, hh, -hh, 0.01, 10); cam.position.z = 1;
      // the bright scene: a lit-sky backdrop with a sun-bright band across it, behind the panel
      const cv = document.createElement('canvas'); cv.width = 256; cv.height = 256; const c2 = cv.getContext('2d');
      c2.fillStyle = '#bfe3ff'; c2.fillRect(0, 0, 256, 256); c2.fillStyle = '#fff4d6'; c2.fillRect(0, 96, 256, 64);
      const tex = new THREE.CanvasTexture(cv); tex.colorSpace = THREE.SRGBColorSpace;
      const back = new THREE.Mesh(new THREE.PlaneGeometry(hw * 2, hh * 2), new THREE.MeshBasicMaterial({ map: tex }));
      back.position.z = -0.3; rig.add(back);
      for (let k = 0; k < 6; k++) { renderer.render(rig, cam); await new Promise((r) => setTimeout(r, 120)); }
      renderer.render(rig, cam);
      const tmp = document.createElement('canvas'); tmp.width = g.width; tmp.height = g.height; const t2 = tmp.getContext('2d'); t2.drawImage(g, 0, 0);
      // the panel's on-screen colour: the most common pixel inside the quad's projected box, in the upper (sky) band
      const p0 = new THREE.Vector3(bb.min.x, bb.max.y, 0).project(cam), p1 = new THREE.Vector3(bb.max.x, bb.min.y, 0).project(cam);
      const X0 = Math.ceil((p0.x + 1) / 2 * g.width) + 4, X1 = Math.floor((p1.x + 1) / 2 * g.width) - 4;
      const Y0 = Math.ceil((1 - p0.y) / 2 * g.height) + 4, Y1 = Math.min(Math.floor((1 - p1.y) / 2 * g.height) - 4, Math.floor(g.height * (96 / 256)) - 2);
      const data = t2.getImageData(X0, Y0, Math.max(1, X1 - X0), Math.max(1, Y1 - Y0)).data; const hist = new Map();
      for (let i = 0; i < data.length; i += 4) { const k = (data[i] << 16) | (data[i + 1] << 8) | data[i + 2]; hist.set(k, (hist.get(k) ?? 0) + 1); }
      let mk = 0, mn = -1; for (const [k, n] of hist) if (n > mn) { mk = k; mn = n; }
      const backPx = Array.from(t2.getImageData(2, 2, 1, 1).data).slice(0, 3);
      // the dial on the quad shows the value the quad is at: readout text, and the thumb where HTMLMesh draws it
      const row = [...document.querySelectorAll('#sec-style .row')].find((r) => r.querySelector('.nm')?.textContent === 'VR panel opacity');
      const inp = row?.querySelector('input[type=range]'), readout = inp?.nextElementSibling?.textContent ?? null, value = inp?.value;
      const tq = D.domQuadTexture('settings'); tq.paused = false; tq.update();
      const qc = tq.image.getContext('2d'), er = tq.dom.getBoundingClientRect(), sc = tq.image.width / er.width;
      const ir = inp.getBoundingClientRect(), H = ir.height, W = ir.width;
      const at = (v) => { const pos = ((v - Number(inp.min)) / (Number(inp.max) - Number(inp.min))) * (W - H);
        return Array.from(qc.getImageData(Math.round((ir.left - er.left + pos + H / 2) * sc), Math.round((ir.top - er.top + H / 2) * sc), 1, 1).data).slice(0, 3); };
      const thumb = at(a), other = at(a === 1 ? 0.6 : 1);   // the thumb at a; and (checked at 0.6) where a stale dial's thumb would sit — bare track
      const url = tmp.toDataURL('image/png');
      rig.remove(back); back.geometry.dispose(); back.material.dispose(); tex.dispose();
      D.domQuadsExit(rig);
      S.setXrPanelAlpha?.(1);
      return { a, panel: [mk >> 16, (mk >> 8) & 255, mk & 255], back: backPx, url, readout, value, thumb, other };
    }, a);
    save(`vr-opacity-${a === 1 ? '1.0' : 'min'}-bright-scene`, r.url);
    bright.push(r);
  }
  console.log(`  · over a bright scene: ${bright.map((r) => `VR opacity ${r.a}: panel rgb(${r.panel}), backdrop rgb(${r.back})`).join('; ')}`);
  for (const r of bright) {
    console.log(`  · VR opacity ${r.a}: dial value ${r.value}, readout ${r.readout}; quad thumb pixel rgb(${r.thumb}), the other end rgb(${r.other})`);
    const lum = (p) => Math.max(...p);
    check(`vr-a: at ${r.a} the quad's own dial shows ${r.a.toFixed(2)} (readout, and the thumb drawn there)`,
      r.readout === r.a.toFixed(2) && Number(r.value) === r.a && lum(r.thumb) > 150 && (r.a === 1 || lum(r.other) < 100), JSON.stringify({ value: r.value, readout: r.readout, thumb: r.thumb, other: r.other }));
  }
  check('vr-a: over a bright scene at 1, the panel is the token, untouched by what is behind (Δ ≤ 4)', near(bright[0].panel, panelTok, 4), `rgb(${bright[0].panel})`);
  check('vr-a: …at 0.6 the scene shows through (panel lighter, still well under the backdrop)',
    bright[1].panel.every((v, i) => v > panelTok[i] + 20 && v < bright[1].back[i] - 20), `rgb(${bright[1].panel}) between rgb(${panelTok}) and rgb(${bright[1].back})`);
  // reset to defaults brings VR panels back to opaque
  const rs = await ev(async () => {
    const S = await import('./lib/stylepanel.js'); S.setXrPanelAlpha?.(0.7);
    document.getElementById('sec-style-tab')?.click();
    const b = [...document.querySelectorAll('#sec-style button')].find((x) => /reset to defaults/.test(x.textContent));
    b?.click();
    return { css: getComputedStyle(document.documentElement).getPropertyValue('--xr-panel-a').trim(), stored: localStorage.getItem('ew-style-tokens'), clicked: !!b };
  });
  check('vr-a: "reset to defaults" returns VR panels to 1', rs.clicked && rs.css === '1' && !/xr-panel-a/.test(rs.stored ?? ''), JSON.stringify(rs));

  if (hadGrade) {   // the VR grade: default and both extremes, against the pure-math twin (tools/quadcolour-test.mjs tests the twin)
    const { gradeSRGB, GRADE_DEFAULT, GRADE_RANGE } = await import('../client/lib/quadgrade.js').catch(() => ({}));
    for (const [tag, g] of [['default', GRADE_DEFAULT], ['low', { saturation: GRADE_RANGE.saturation[0], contrast: GRADE_RANGE.contrast[0] }], ['high', { saturation: GRADE_RANGE.saturation[1], contrast: GRADE_RANGE.contrast[1] }]]) {
      await setGrade(g);
      const mg = await measure(); save(`quad-output-grade-${tag}`, mg.url);
      const errsG = mg.names.map((k, i) => { const want = gradeSRGB(hexRgb(mg.want[i]).map((v) => v / 255), g).map((v) => Math.round(v * 255)); return { k, want, got: mg.got[i], d: Math.max(...want.map((v, j) => Math.abs(v - mg.got[i][j]))) }; });
      console.log(`  · grade ${tag} ${JSON.stringify(g)}: ${errsG.map((r) => `${r.k} want(${r.want}) got(${r.got}) Δ${r.d}`).join('; ')}`);
      check(`grade ${tag}: the quad shows the graded token colours (max Δ ≤ 4)`, errsG.every((r) => r.d <= 4), errsG.map((r) => `${r.k} Δ${r.d}`).join(', '));
    }
    await setGrade(GRADE_DEFAULT);
  }
  if (hadGrade) {   // Settings › VR carries the two sliders, and moving one moves the quads' grade (and persists)
    const vr = await ev(async () => {
      document.getElementById('sec-vr-tab')?.click(); await new Promise((r) => setTimeout(r, 300));
      const rows = [...document.querySelectorAll('#sec-vr .row')].filter((r) => /panel (sat|contr)/.test(r.querySelector('.nm')?.textContent ?? ''));
      const sat = rows.find((r) => /sat/.test(r.textContent))?.querySelector('input[type=range]');
      if (!sat) return { rows: rows.length };
      sat.value = '1.6'; sat.dispatchEvent(new Event('input'));
      const Q = await import('./lib/quadcolour.js');
      const out = { rows: rows.length, grade: Q.currentGrade(), stored: localStorage.getItem('ew-xr-panel-grade') };
      Q.setGrade(Q.GRADE_DEFAULT);
      return out;
    });
    check('Settings › VR: the panel saturation/contrast sliders drive the quads\' grade and persist', vr.rows === 2 && Math.abs(vr.grade?.saturation - 1.6) < 1e-6 && /1\.6/.test(vr.stored ?? ''), JSON.stringify(vr));
  }
  check('no page errors', errs.length === 0, errs.slice(0, 3).join(' | '));
} catch (e) { check('probe ran', false, `${e.stack || e.message}${errs.length ? ` — page errors: ${errs.slice(0, 3).join(' | ')}` : ''}`); }
finally {
  try { await browser.close(); } catch {}
  try { await world.close(); } catch {}
}
done();
