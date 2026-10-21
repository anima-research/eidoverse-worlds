// capnotice-probe — the status strip (statuschips.js) in the real client: the visit's notices are small CHIPS on the
// ∃'s status line, past the mic/ear glyphs, not a card over the world. Headless Chromium runs WebGL 2, so the
// 'WebGL 2' chip is up; a graphics-reset chip is seeded the way a real recovery leaves it (sessionStorage, read once by
// the next boot) and the governor's quality-reduced chip is driven through the governor's own 1 Hz input.
//   bun tools/capnotice-probe.mjs [--shots <dir>]
// What must hold, desktop 1280x720:
//   the WebGL chip is amber, small, its text folded away; the graphics chip is red and shows its count (×2);
//   the strip sits on the ∃'s row, right of the glyphs, overlapping none of the rail/glyphs/emote bar;
//   slow seconds → a 'reduced detail' chip; smooth seconds → it goes (the reduction lifted);
//   a click opens the full text under the chip, inside the viewport, with "got it" / "don’t show again";
//   Esc folds the popover and nothing else (the panels stay); "got it" folds it and the chip stays;
//   the ∃ menu opens clear of the strip (its tab too);
//   "don’t show again" removes the chip and remembers it (same key as the card) across a reload.
// Phone 390x844 (touch): the strip is on screen and clear of the rail and glyphs — on the default rail and on a
// rail welded to the top edge (the strip then runs down the ∃'s column).
import { launchBrowser, ownedWorld, checker } from './probe-harness.mjs';
import { mkdirSync } from 'node:fs';
const { check, done } = checker();
const shotDir = (() => { const i = process.argv.indexOf('--shots'); return i > 0 ? process.argv[i + 1] : null; })();
if (shotDir) mkdirSync(shotDir, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const world = await ownedWorld({ env: { SKIP_OPT_SWEEP: '1' } });
const { browser, close } = await launchBrowser();

async function boot(ctxOpts, name, init = () => {}) {
  const ctx = await browser.newContext(ctxOpts);
  // THE SKY GUARD, before any module reads localStorage (sky.js): a cloudy sky bakes on the CPU in headless and has
  // frozen the host
  await ctx.addInitScript(() => { try { localStorage.setItem('ew-cloud-quality', 'off'); } catch {} });
  await ctx.addInitScript(init);
  const pg = await ctx.newPage();
  const errs = [];
  pg.on('pageerror', (e) => errs.push(e.message));
  await pg.goto(`${world.origin}/?world=capnotice&name=${name}&key=${world.key}&lite=0`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await pg.waitForFunction(() => document.getElementById('splash')?.classList.contains('gone') && !!globalThis.EW?.me?.(), null, { timeout: 120000 });
  await sleep(3000);
  return { ctx, pg, errs };
}
// where box `m` (the open ∃ menu) overlaps `sel`, the topmost element at the overlap's centre belongs to the menu
const onTop = async (pg, m, sel) => pg.evaluate(([m, sel]) => {
  const o = document.querySelector(sel)?.getBoundingClientRect(); if (!o || !o.width) return true;
  const l = Math.max(m.l, o.left), r = Math.min(m.r, o.right), t = Math.max(m.t, o.top), b = Math.min(m.b, o.bottom);
  if (l >= r || t >= b) return true;
  return !!document.elementFromPoint((l + r) / 2, (t + b) / 2)?.closest('#emenu, #emenu-sub');
}, [m, sel]);
const shot = async (pg, file) => { if (shotDir) await pg.screenshot({ path: `${shotDir}/${file}` }); };
const box = (pg, sel) => pg.evaluate((s) => { const e = document.querySelector(s); if (!e) return null; const r = e.getBoundingClientRect();
  const cs = getComputedStyle(e); if (!r.width || cs.display === 'none' || e.hidden) return null;
  return { l: r.left, t: r.top, r: r.right, b: r.bottom, w: r.width, h: r.height }; }, sel);
const meets = (a, b) => !!(a && b && a.l < b.r && a.r > b.l && a.t < b.b && a.b > b.t);
const chip = (pg, id) => pg.evaluate((i) => { const c = document.getElementById(`stchip-${i}`); if (!c) return null; const r = c.getBoundingClientRect();
  return { label: c.textContent.trim(), level: c.dataset.level, w: r.width, h: r.height, l: r.left, t: r.top, b: r.bottom, color: getComputedStyle(c).color }; }, id);
const popState = (pg) => pg.evaluate(() => { const p = document.getElementById('stpop'); if (!p) return null; const r = p.getBoundingClientRect();
  return { hidden: p.hidden, text: p.textContent, l: r.left, t: r.top, r: r.right, b: r.bottom, inView: r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight }; });
// the governor's own input, synchronously so the real 1 Hz pulse can't interleave
const drive = (pg, fps, n) => pg.evaluate(async ({ fps, n }) => { const G = await import('/lib/governor.js'); for (let i = 0; i < n; i++) G.governPerformance(fps); }, { fps, n });
const shedOn = (pg) => pg.evaluate(async () => (await import('/lib/realize/models.js')).modelQuality.shed);
// a chip overlapping any fixed chrome on the ∃'s line
const clash = (pg) => pg.evaluate(() => {
  const s = document.getElementById('hudstatus')?.getBoundingClientRect(); if (!s?.width) return ['no strip'];
  const out = [];
  for (const sel of ['#dock', '#micbtn', '#earbtn', '#xrbtn', '.frame[data-frame="emotes"]']) {
    const e = document.querySelector(sel); if (!e || getComputedStyle(e).display === 'none') continue;
    const g = e.getBoundingClientRect(); if (!g.width) continue;
    if (s.left < g.right && s.right > g.left && s.top < g.bottom && s.bottom > g.top) out.push(sel);
  }
  if (s.left < 0 || s.right > innerWidth || s.top < 0 || s.bottom > innerHeight) out.push('off-screen');
  return out;
});

try {
  // ------------------------------------------------------------ desktop 1280x720
  // a real recovery leaves the reason (read once by the next boot) and the recent losses: seeded once, not on reload
  const seed = () => { try { if (!sessionStorage.getItem('probe-seeded')) { sessionStorage.setItem('probe-seeded', '1');
    sessionStorage.setItem('ew-gpu-recovered', 'webgl context lost'); sessionStorage.setItem('ew-gpu-lost', JSON.stringify([Date.now() - 90000, Date.now() - 20000])); } } catch {} };
  const { ctx, pg, errs } = await boot({ viewport: { width: 1280, height: 720 } }, 'capdesk', seed);
  const web = await chip(pg, 'webgl'), gpu = await chip(pg, 'gpu-recovered');
  console.log('  ·', JSON.stringify({ web, gpu }));
  check('the WebGL 2 note is a small amber chip (≤ 140×32), not a card', web && web.label === 'WebGL 2' && web.level === 'attn' && web.w <= 140 && web.h <= 32
    && !(await pg.$('.capnotice:not(#lite-banner)')), JSON.stringify(web));
  check('…its text folded away until asked', (await popState(pg))?.hidden === true);
  check('the graphics-reset chip is RED and shows the count gpulost recorded (×2)', gpu && gpu.level === 'err' && gpu.label === 'graphics reset ×2', JSON.stringify(gpu));
  const hud = await box(pg, '#hud'), strip = await box(pg, '#hudstatus'), ear = await box(pg, '#earbtn'), mic = await box(pg, '#micbtn');
  check('the strip sits on the ∃’s row: its first line’s centre is the ∃’s', hud && strip && web && Math.abs((web.t + web.b) / 2 - (hud.t + hud.b) / 2) <= 1.5, JSON.stringify({ hud, strip, web }));
  check('…past the mic/ear glyphs', strip && strip.l >= Math.max(ear?.r ?? 0, mic?.r ?? 0), JSON.stringify({ strip, ear, mic }));
  check('…overlapping none of the rail, the glyphs or the emote bar', (await clash(pg)).length === 0, JSON.stringify(await clash(pg)));

  // QUALITY REDUCED: a state, not an event — slow seconds post it, smooth ones lift it. The real 1 Hz pulse is paused
  // while the probe feeds the governor its seconds (headless is slow: it would shed again between them)
  const pulse = (pg, on) => pg.evaluate(async (on) => (await import('/lib/frame.js')).setSystemEnabled('pulse', on), on);
  await pulse(pg, false);
  for (let i = 0; i < 12 && !(await shedOn(pg)); i++) await drive(pg, 10, 4);
  const red = await chip(pg, 'quality-reduced');
  check('slow seconds: the governor sheds model detail and a "reduced detail" caveat chip appears', (await shedOn(pg)) && red?.level === 'attn' && red?.label === 'reduced detail', JSON.stringify(red));
  check('…and no "distant objects reduced" toast', !(await pg.evaluate(() => [...document.querySelectorAll('.toast')].some((t) => /distant objects/.test(t.textContent)))));
  check('three chips still clear of the rail, glyphs and emote bar', (await clash(pg)).length === 0, JSON.stringify(await clash(pg)));
  await pg.mouse.move(640, 500);
  await shot(pg, '10-status-chips-1280x720.png');

  await pg.click('#stchip-webgl'); await sleep(250);
  const p1 = await popState(pg), wc = await chip(pg, 'webgl');
  check('a click opens the full text with "got it" and "don’t show again", inside the viewport',
    p1 && !p1.hidden && /Running on WebGL 2/.test(p1.text) && /WebGPU/.test(p1.text) && /got it/.test(p1.text) && /show again/.test(p1.text) && p1.inView, JSON.stringify(p1));
  check('…anchored to its chip: just under it, left edges aligned', p1 && wc && p1.t >= wc.b && p1.t - wc.b <= 10 && Math.abs(p1.l - wc.l) <= 1, JSON.stringify({ p1, wc }));
  await shot(pg, '11-chip-popover.png');
  const framesOpen = () => pg.evaluate(() => [...document.querySelectorAll('.frame')].filter((f) => getComputedStyle(f).display !== 'none').length);
  const before = await framesOpen();
  await pg.keyboard.press('Escape'); await sleep(200);
  check('Esc folds the popover — and only that (the panels stay open)', (await popState(pg)).hidden && (await framesOpen()) === before && before > 0, JSON.stringify({ before, after: await framesOpen() }));
  await pg.click('#stchip-webgl'); await sleep(150);
  await pg.click('#stpop button:has-text("got it")'); await sleep(150);
  check('"got it" folds it; the chip stays for the visit', (await popState(pg)).hidden && !!(await chip(pg, 'webgl')));

  // the lift
  for (let i = 0; i < 30 && (await shedOn(pg)); i++) { await drive(pg, 60, 60); await sleep(500); }   // the governor holds still while loading (grace)
  check('smooth seconds: the reduction lifts and its chip goes', !(await shedOn(pg)) && !(await chip(pg, 'quality-reduced')), JSON.stringify(await pg.evaluate(async () => { const d = (await import('/lib/governor.js')).governorDebug(); const FB = await import('/lib/framebudget.js'); const M = await import('/lib/realize/models.js'); return { grace: d.grace, goodFor: d.goodFor, busy: FB.busy(), tail: M.promoteTailPending(), shed: M.modelQuality.shed, pr: d.pixelRatio }; })));

  await pulse(pg, true);

  // the ∃ menu opens clear of the strip, tab included — with the panels put away (Esc), so its default spot beside the
  // rail is free and no frame-dodge moves it anyway
  await pg.mouse.click(900, 300); await pg.keyboard.press('Escape'); await sleep(200);
  await pg.click('#hud'); await sleep(300);
  const menu = await pg.evaluate(() => { const m = document.getElementById('emenu'); const r = m.getBoundingClientRect(); const tab = m.querySelector(':scope > .fr-head')?.offsetHeight ?? 0;
    return { l: r.left, r: r.right, t: r.top - tab, b: r.bottom, hidden: m.hidden }; });
  console.log('  · menu', JSON.stringify(menu));
  // the ∃ menu is a dropdown that opens OVER the ∃'s row (owner, 10-01: "over the mic/headphones/vr visor icons"): where
  // it meets the chips it is the thing on top
  check('the ∃ menu opens over the chips — on top wherever they meet', !menu.hidden && await onTop(pg, menu, '#hudstatus'), JSON.stringify({ menu, strip: await box(pg, '#hudstatus') }));
  await pg.click('#hud'); await sleep(200);
  await pg.keyboard.press('Escape'); await sleep(200);   // the panels come back

  // don't show again: gone for good, under the card's old key
  await pg.click('#stchip-webgl'); await sleep(150);
  await pg.click('#stpop button:has-text("show again")'); await sleep(150);
  check('"don’t show again" removes the chip and remembers it (ew-capnotice-dismissed)', !(await chip(pg, 'webgl'))
    && (await pg.evaluate(() => JSON.parse(localStorage.getItem('ew-capnotice-dismissed') || '[]').includes('webgl'))));
  await pg.reload({ waitUntil: 'domcontentloaded' });
  await pg.waitForFunction(() => document.getElementById('splash')?.classList.contains('gone'), null, { timeout: 120000 }); await sleep(2500);
  check('…across a reload; the graphics chip was the last boot’s news and is gone too', !(await chip(pg, 'webgl')) && !(await chip(pg, 'gpu-recovered')));
  check('no page errors on the desktop run', errs.length === 0, errs.slice(0, 3).join(' | '));
  await ctx.close();

  // ------------------------------------------------------------ phone 390x844
  const phone = { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 1 };
  const ph = await boot(phone, 'capphone', seed);
  await drive(ph.pg, 10, 40);
  const pc = await clash(ph.pg);
  const three = await Promise.all(['webgl', 'gpu-recovered', 'quality-reduced'].map((i) => chip(ph.pg, i)));
  check('phone: three chips on screen, clear of the rail and glyphs (they wrap rather than slide back over them)',
    pc.length === 0 && three.every(Boolean), JSON.stringify({ pc, three }));
  await ph.pg.mouse.move(200, 600);
  await shot(ph.pg, '16-phone-chips-390x844.png');
  await ph.pg.tap('#stchip-webgl'); await sleep(250);
  check('phone: the popover opens inside the viewport', (await popState(ph.pg))?.inView === true, JSON.stringify(await popState(ph.pg)));
  check('no page errors on the phone run', ph.errs.length === 0, ph.errs.slice(0, 3).join(' | '));
  await ph.ctx.close();

  // a rail welded to the top edge: the ∃'s row IS the rail, so the strip runs down the ∃'s column
  const top = await boot(phone, 'captop', () => { try { if (!localStorage.getItem('ew-dock-pos')) localStorage.setItem('ew-dock-pos', JSON.stringify({ edge: 'top', along: 10 })); } catch {} });
  const edge = await top.pg.evaluate(() => document.getElementById('dock')?.dataset.edge);
  const tc = await clash(top.pg), th = await box(top.pg, '#hud'), ts = await box(top.pg, '#hudstatus');
  check('top rail: the strip runs down the ∃’s column, clear of the rail and glyphs', edge === 'top' && tc.length === 0 && ts && th && ts.t > th.b && Math.abs(ts.l - th.l) <= 1,
    JSON.stringify({ edge, tc, th, ts }));
  await top.pg.tap('#hud'); await sleep(300);
  const tm = await top.pg.evaluate(() => { const m = document.getElementById('emenu'); const r = m.getBoundingClientRect(); const tab = m.querySelector(':scope > .fr-head')?.offsetHeight ?? 0;
    return { l: r.left, r: r.right, t: r.top - tab, b: r.bottom, hidden: m.hidden }; });
  check('top rail: the ∃ menu opens over the chips — on top wherever they meet', !tm.hidden && await onTop(top.pg, tm, '#hudstatus'), JSON.stringify({ tm, ts }));
  await shot(top.pg, '16b-phone-top-rail-390x844.png');
  check('no page errors on the top-rail run', top.errs.length === 0, top.errs.slice(0, 3).join(' | '));
  await top.ctx.close();
} catch (e) { check('probe ran', false, e.stack ?? e.message); }
finally { try { await close(); } catch {} try { await world.close(); } catch {} }
done();
