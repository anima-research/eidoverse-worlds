// logo-probe — the mark (notes: logo r6-E3-concentric + the hand-set small masters) where the client draws it:
// the splash, the ∃ button, the favicon. Clouds are forced OFF before boot (a cloudy sky bakes on the CPU in
// headless Chromium and has frozen the host).
//
//   bun tools/logo-probe.mjs [--shots <dir>]
//
// What must hold:
//   THE SPLASH, driven by boot.js's own phases (main.js is held back, so the static splash stays up and the
//   probe owns the progress): the first paint — before any script — has the peg OFF to the left by the full
//   travel D = 80.5 (the peg's arc tip, x 88, clears the sphere's leftmost x 8 by half a unit) and clipped to the sphere; at p = 0.5 the peg sits at −D·(1 − ease(0.5)) (doorway.html's
//   ease); at p = 1 it has NO transform and NO clip: the still mark. The frame never moves.
//   THE REAL BOOT: the peg is painted by paint() as progress arrives (a value strictly between the ends is
//   seen), and after finishBoot the mark is the still mark.
//   THE ∃ BUTTON carries the 24 px master's geometry (viewBox 0 0 24 24, its three outlines).
//   THE FAVICON: <link rel="icon"> at 32×32 and 16×16 carrying the 32/16 masters; /favicon.ico is the 32.
// --shots writes 20-splash-p0/21-splash-p50/22-splash-p100 and 23-hud-mark-and-favicon.
import { launchBrowser, ownedWorld, checker } from './probe-harness.mjs';
import { mkdirSync } from 'node:fs';

const { check, done } = checker();
const shotDir = (() => { const i = process.argv.indexOf('--shots'); return i > 0 ? process.argv[i + 1] : null; })();
if (shotDir) mkdirSync(shotDir, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const D = 88 - 8 + 0.5;   // boot.js PEG_D: the arc TIP (x 88) clears the sphere's leftmost x (8)
const ease = (p) => { const k = 0.35; return (1 - k) * p + k * (1 - Math.pow(1 - p, 3)); };
const HUD24 = [
  'M4.675 3 L19 3 L19 9 L16 9 L16 6 L1.780 6 A11 11 0 0 1 4.675 3 Z',
  'M1.780 18 L16 18 L16 15 L19 15 L19 21 L4.675 21 A11 11 0 0 1 1.780 18 Z',
  'M6.919 11 L21.954 11 A11 11 0 0 1 21.954 13 L6.919 13 A4.202 4.202 0 0 1 6.919 11 Z',
];
const PEG32 = 'M9.335 14 L28.861 14 A14.5 14.5 0 0 1 28.861 18 L9.335 18 A5.539 5.539 0 0 1 9.335 14 Z';
const FRAME16 = 'M3.894 2 L13 2 L13 14 L3.894 14 A7 7 0 0 1 1.755 12 L11 12 L11 4 L1.755 4 A7 7 0 0 1 3.894 2 Z';

const world = await ownedWorld({ env: { SKIP_OPT_SWEEP: '1' } });
const { browser, close } = await launchBrowser();

// the peg's state as the browser resolves it: the translation x of its computed transform (null = none),
// whether its group is clipped, and the frame's own transforms (must stay none)
const pegState = (pg) => pg.evaluate(() => {
  const peg = document.querySelector('#splash .sp-peg');
  if (!peg) return null;
  const t = getComputedStyle(peg).transform;
  const tx = t === 'none' ? null : new DOMMatrix(t).e;
  const frames = [...document.querySelectorAll('#splash .sp-frame')].map((f) => getComputedStyle(f).transform);
  return { tx, clip: peg.parentNode.getAttribute('clip-path'), frames, bar: document.querySelector('#splash .sp-bar-fill')?.style.width };
});
const near = (a, b, eps = 0.05) => a !== null && Math.abs(a - b) < eps;

try {
  // ------------------------------------------------------------ the splash, driven
  {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    await ctx.addInitScript(() => { try { localStorage.setItem('ew-cloud-quality', 'off'); } catch {} });
    // hold the engine back: the static splash is what paints before any module, and the probe drives boot.js
    await ctx.route(/\/(main|lite)\.js(\?.*)?$/, (r) => r.fulfill({ contentType: 'text/javascript', body: '' }));   // an EMPTY engine, not a failed one (a failed load paints the watchdog's error)
    const pg = await ctx.newPage();
    const errs = []; pg.on('pageerror', (e) => errs.push(e.message));
    await pg.goto(`${world.origin}/?world=logo&name=logo&key=${world.key}&lite=0`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await pg.evaluate(() => { globalThis.__ewEngineUp = true; });   // the watchdog is not the subject
    await sleep(300);
    const s0 = await pegState(pg);
    check('splash p=0, first paint (no script): the peg is off to the left by the full travel D, clipped to the sphere',
      s0 && near(s0.tx, -D) && s0.clip === 'url(#sp-sphere)', JSON.stringify(s0));
    check('splash: the frame never moves', s0 && s0.frames.length === 2 && s0.frames.every((t) => t === 'none'), JSON.stringify(s0));
    await pg.evaluate(async () => { const b = await import('/lib/boot.js'); globalThis.__boot = b; b.initBoot({ world: 'a world', name: 'you' }); });
    // initBoot marks the engine phase (weight 14 of 100); paint() follows it
    await sleep(500);
    const sEng = await pegState(pg);
    check('splash: initBoot\'s engine phase (p=0.14) moves the peg by paint(), to −D·(1−ease(.14))',
      sEng && near(sEng.tx, -D * (1 - ease(0.14))) && sEng.clip === 'url(#sp-sphere)', JSON.stringify(sEng));
    // p0 shot: the peg at the start of its travel, with the splash's live furniture (rays, tips) running
    await pg.evaluate(() => globalThis.__boot.paintPeg(0));
    await sleep(500);
    if (shotDir) await pg.screenshot({ path: `${shotDir}/20-splash-p0.png` });
    // p = .5 through the real phases: engine 14 + connect 6 + world .75×40 = 50
    await pg.evaluate(() => { const b = globalThis.__boot; b.markPhase('connect', 1); b.markPhase('world', 0.75); });
    await sleep(500);
    const s5 = await pegState(pg);
    check('splash p=0.5 (phases engine+connect+¾ world): the peg at −D·(1−ease(.5)), still clipped',
      s5 && near(s5.tx, -D * (1 - ease(0.5))) && s5.clip === 'url(#sp-sphere)' && s5.bar === '50%', JSON.stringify(s5));
    if (shotDir) await pg.screenshot({ path: `${shotDir}/21-splash-p50.png` });
    await pg.evaluate(() => { const b = globalThis.__boot; b.markPhase('world', 1); b.markPhase('body', 1); });
    await sleep(700);
    const s1 = await pegState(pg);
    check('splash p=1: the peg has NO transform and NO clip — the still mark', s1 && s1.tx === null && s1.clip === null, JSON.stringify(s1));
    if (shotDir) await pg.screenshot({ path: `${shotDir}/22-splash-p100.png` });
    check('splash drive: no page errors', errs.length === 0, errs.join(' | '));
    await ctx.close();
  }

  // ------------------------------------------------------------ the ∃ button and the favicon, zoomed (no engine)
  {
    const ctx = await browser.newContext({ viewport: { width: 760, height: 200 }, deviceScaleFactor: 3 });
    await ctx.route(/\/(main|lite)\.js(\?.*)?$/, (r) => r.fulfill({ contentType: 'text/javascript', body: '' }));   // an EMPTY engine, not a failed one (a failed load paints the watchdog's error)
    const pg = await ctx.newPage();
    await pg.goto(`${world.origin}/?world=logo&name=logo&key=${world.key}&lite=0`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await pg.evaluate(() => { globalThis.__ewEngineUp = true; });
    const hud = await pg.evaluate(() => { const s = document.querySelector('#hud svg');
      return s && { vb: s.getAttribute('viewBox'), w: s.getAttribute('width'), ds: [...s.querySelectorAll('path')].map((p) => p.getAttribute('d')), ids: s.querySelectorAll('[id]').length }; });
    check('∃ button: the hand-set 24 px master (viewBox 0 0 24 24, its three outlines, no ids)',
      hud && hud.vb === '0 0 24 24' && hud.w === '24' && JSON.stringify(hud.ds) === JSON.stringify(HUD24) && hud.ids === 0, JSON.stringify(hud));
    const icons = await pg.evaluate(() => [...document.querySelectorAll('link[rel="icon"]')].map((l) => ({ sizes: l.getAttribute('sizes'), type: l.type, raw: l.href, href: decodeURIComponent(l.href) })));
    const i32 = icons.find((i) => i.sizes === '32x32'), i16 = icons.find((i) => i.sizes === '16x16');
    check('favicon: an SVG <link rel="icon"> at 32×32 carrying the 32 px master', !!i32 && i32.type === 'image/svg+xml' && i32.href.includes(PEG32), JSON.stringify(icons).slice(0, 300));
    check('favicon: a 16×16 variant carrying the 16 px master', !!i16 && i16.href.includes(FRAME16), JSON.stringify(icons).slice(0, 300));
    const ico = await (async () => { const r = await fetch(`${world.origin}/favicon.ico`); return { type: r.headers.get('content-type'), body: await r.text() }; })();
    check('/favicon.ico (pages without the link) is the 32 px master', ico.type === 'image/svg+xml' && ico.body.includes(PEG32), ico.body.slice(0, 200));
    if (shotDir) {
      // the button as the page styles it, beside both favicons at 1× and 2× (dark tab strip, light tab strip)
      await pg.evaluate((list) => {
        document.getElementById('splash').style.display = 'none';
        const h = document.getElementById('hud'); Object.assign(h.style, { position: 'fixed', left: '16px', top: '16px' });
        const d = document.createElement('div');
        Object.assign(d.style, { position: 'fixed', left: '80px', top: '12px', display: 'flex', gap: '10px', alignItems: 'center', zIndex: 1e6 });
        // each strip shows the variant its colour scheme would pick (the icon's own @media, resolved by hand here:
        // a headless page has one scheme)
        for (const [bg, dark] of [['#202124', true], ['#dee1e6', false]]) for (const i of list) for (const k of [1, 2]) {
          const w = parseInt(i.sizes) * k; const c = document.createElement('div');
          Object.assign(c.style, { background: bg, padding: '6px', lineHeight: 0 });
          const svg = dark ? i.href.replace(/@media[^{]*\{[^}]*\}\}/, '') : i.href.replace(/path\{fill:#8fe8c8\}/, '');
          const img = new Image(w, w); img.src = 'data:image/svg+xml,' + encodeURIComponent(svg.replace(/^data:image\/svg\+xml,/, ''));
          c.appendChild(img); d.appendChild(c);
        }
        document.body.appendChild(d);
      }, icons);
      await sleep(400);
      await pg.screenshot({ path: `${shotDir}/23-hud-mark-and-favicon.png`, clip: { x: 0, y: 0, width: 760, height: 90 } });
    }
    await ctx.close();
  }

  // ------------------------------------------------------------ the real boot
  {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    await ctx.addInitScript(() => { try { localStorage.setItem('ew-cloud-quality', 'off'); } catch {} });
    // every transform the peg is given, in order, as boot paints it
    await ctx.addInitScript(() => {
      globalThis.__pegSeen = [];
      const arm = () => { const peg = document.querySelector('#splash .sp-peg'); if (!peg) return setTimeout(arm, 0);
        globalThis.__pegSeen.push(peg.style.transform);
        new MutationObserver(() => globalThis.__pegSeen.push(peg.style.transform)).observe(peg, { attributes: true, attributeFilter: ['style'] }); };
      document.addEventListener('DOMContentLoaded', arm);
    });
    const pg = await ctx.newPage();
    const errs = []; pg.on('pageerror', (e) => errs.push(e.message));
    await pg.goto(`${world.origin}/?world=logo&name=logoboot&key=${world.key}&lite=0`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await pg.waitForFunction(() => document.getElementById('splash')?.classList.contains('gone') && !!globalThis.EW?.me?.(), null, { timeout: 120000 });
    await sleep(1000);
    const seen = await pg.evaluate(() => globalThis.__pegSeen);
    const xs = seen.map((t) => { const m = /translateX\((-?[\d.]+)px\)/.exec(t); return m ? +m[1] : (t === '' ? 0 : NaN); });
    check('real boot: paint() moves the peg as progress arrives (a position strictly between the ends is painted)',
      xs.some((x) => x > -D + 0.5 && x < -0.5), JSON.stringify(seen));
    check('real boot: the positions only ever move right (progress is monotone, so is the peg)',
      xs.every((x, i) => i === 0 || x >= xs[i - 1] - 1e-6), JSON.stringify(xs));
    const end = await pegState(pg);
    check('real boot: after finishBoot the mark is the still mark (no transform, no clip)', end && end.tx === null && end.clip === null, JSON.stringify(end));
    check('real boot: no page errors', errs.length === 0, errs.join(' | '));
    await ctx.close();
  }
} finally {
  await close(); await world.close();
}
done();
