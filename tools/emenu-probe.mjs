// emenu-probe — the ∃ menu as a File-style waterfall (owner, 10-01), in the REAL client against an owned scratch world
// (probe-harness), with a real mouse, a real touchscreen and real timing. Clouds forced OFF before boot (a cloudy sky
// bakes on the CPU in headless Chromium and has frozen the host).
//
//   bun tools/emenu-probe.mjs [--shots <dir>]
//
// What must hold:
//   the menu hangs from the ∃, to its right, OVER the mic/headphones glyphs (on top of them); its top level reads
//     Save world · Load world | Panels ▸ · Lite client | Log in · Help · Keys · About ▸; Save/Load greyed for now and a
//     press says why; Lite client asks first in a centred dialog (Esc: nothing happens), and yes lands in lite, saved;
//   Panels ▸ opens on hover beside its row, inside the viewport; every enabled pin there goes on → off → on under a
//     real mouse with the menu and the flyout open throughout, its highlight and its stored choice agreeing; the rail
//     follows; after a reload every pin's highlight still matches what was stored;
//   a held click on any lantern toggle (the rail's search, the flyout's lantern and search rows) closes an open
//     lantern rather than reopening it, and a pin pressed while the lantern is open leaves it open;
//   HUD layout mode is a switch in Panels ▸: the menu stays when it is turned on, goes on mouse-away, and the mode
//     outlives it until Esc;
//   Help opens the help sheet and the menu goes; About ▸ shows the sha /version reports; the mouse leaving the menu
//     dismisses it; Esc closes the flyout first, then the menu;
//   on a phone (touch): a tap opens it on screen, Panels ▸ opens by tap on screen, a tap outside dismisses it.
// --shots writes the screenshots: closed, open, Panels ▸, About ▸, layout mode, the phone's menu and flyout.
import { launchBrowser, ownedWorld, checker } from './probe-harness.mjs';
import { mkdirSync } from 'node:fs';

const { check, done } = checker();
const shotDir = (() => { const i = process.argv.indexOf('--shots'); return i > 0 ? process.argv[i + 1] : null; })();
if (shotDir) mkdirSync(shotDir, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const world = await ownedWorld({ env: { SKIP_OPT_SWEEP: '1' } });
const { browser, close } = await launchBrowser();

async function boot(ctxOpts, name) {
  const ctx = await browser.newContext(ctxOpts);
  await ctx.addInitScript(() => { try { localStorage.setItem('ew-cloud-quality', 'off'); } catch {} });
  const pg = await ctx.newPage();
  const errs = [];
  pg.on('pageerror', (e) => errs.push(e.message));
  pg.on('dialog', (d) => d.dismiss().catch(() => {}));
  await pg.goto(`${world.origin}/?world=emenu&name=${name}&key=${world.key}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await settle(pg);
  return { ctx, pg, errs };
}
async function settle(pg) {
  await pg.waitForFunction(() => document.getElementById('splash')?.classList.contains('gone') && !!globalThis.EW?.me?.(), null, { timeout: 120000 });
  await sleep(3500);
  await pg.evaluate(() => document.getElementById('toasts')?.replaceChildren());
}
const shot = async (pg, file) => { if (shotDir) await pg.screenshot({ path: `${shotDir}/${file}` }); };
const box = (pg, sel) => pg.evaluate((s) => { const e = document.querySelector(s); if (!e) return null; const r = e.getBoundingClientRect();
  const cs = getComputedStyle(e); if (!r.width || cs.display === 'none' || e.hidden) return null;
  return { l: r.left, t: r.top, r: r.right, b: r.bottom, cx: r.left + r.width / 2, cy: r.top + r.height / 2 }; }, sel);
const state = (pg) => pg.evaluate(() => ({
  menu: !document.getElementById('emenu').hidden,
  sub: !document.getElementById('emenu-sub').hidden,
  arranging: document.body.classList.contains('arranging'),
  lantern: !document.getElementById('lantern')?.hidden,
  pins: Object.fromEntries([...document.querySelectorAll('#emenu-sub .mpin[data-pin]')].map((p) => [p.dataset.pin, p.disabled ? 'dead' : p.classList.contains('on')])),
  rail: Object.fromEntries([...document.querySelectorAll('#dock button[data-toggles]')].map((b) => [b.dataset.toggles, !b.hidden])),
  glyphs: Object.fromEntries(['mic', 'ear'].map((k) => [k, getComputedStyle(document.getElementById(`${k}btn`)).display !== 'none'])),
  pill: !document.getElementById('lantern-pill').classList.contains('unpinned'),
  ls: { dock: JSON.parse(localStorage.getItem('ew-dock-pins') ?? 'null'), lantern: localStorage.getItem('ew-lantern-pinned'),
    mic: localStorage.getItem('ew-mic-pinned'), ear: localStorage.getItem('ew-ear-pinned') },
}));
// what the stored choice says for one pin
const stored = (s, id) => id === 'lantern' ? s.ls.lantern !== '0' : id.startsWith('glyph:') ? s.ls[id.slice(6)] !== '0' : (s.ls.dock ?? []).includes(id);
// what the HUD shows for one pin (the rail button, the floating glyph, the resting line)
const shown = (s, id) => id === 'lantern' ? s.pill : id.startsWith('glyph:') ? s.glyphs[id.slice(6)] : s.rail[id];
const openMenu = async (pg) => { if (!(await state(pg)).menu) { await pg.click('#hud'); await sleep(250); } };
// hover opens it; a click opens it too (never shuts it) — the probe hovers, and clicks only if the hover did not take,
// saying so (a hover that never opens is worth seeing)
const openPanels = async (pg) => {
  await openMenu(pg);
  const b = await box(pg, '#emenu .mrow[data-item="panels"]');
  await pg.mouse.move(b.cx - 4, b.cy); await pg.mouse.move(b.cx, b.cy); await sleep(300);
  if (!(await state(pg)).sub) { console.log('  · Panels ▸: the hover did not open it; clicking'); await pg.mouse.click(b.cx, b.cy); await sleep(200); }
};
const away = async (pg) => { await pg.mouse.move(900, 420); await sleep(700); };

try {
  // ------------------------------------------------------------ desktop 1280x720
  const { ctx, pg, errs } = await boot({ viewport: { width: 1280, height: 720 } }, 'emenudesk');
  await pg.mouse.move(900, 420);
  await shot(pg, '01-closed-1280x720.png');

  // THE TOP LEVEL, hanging from the ∃ over the glyphs
  await pg.click('#hud'); await sleep(300);
  const hud = await box(pg, '#hud'), m = await box(pg, '#emenu'), mic = await box(pg, '#micbtn');
  check('∃ opens the menu to the right of the ∃, its top level with the ∃', m && hud && Math.abs(m.l - (hud.r + 6)) <= 1 && Math.abs(m.t - hud.t) <= 1, JSON.stringify({ hud, m }));
  check('…over the mic/ear glyphs, and on top of them', mic && m.l < mic.r && m.r > mic.l && m.t < mic.b && m.b > mic.t
    && await pg.evaluate(([x, y]) => !!document.elementFromPoint(x, y)?.closest('#emenu'), [mic.cx, mic.cy]), JSON.stringify({ m, mic }));
  check('…and opening it is not HUD layout mode', !(await state(pg)).arranging);
  const items = await pg.evaluate(() => [...document.getElementById('emenu').children].map((c) => c.dataset.item ?? (c.className === 'msep' ? '|' : '?')).join(' '));
  check('top level: save load | panels lite | login help keys about', items === 'save load | panels lite | login help keys about', items);
  await shot(pg, '02-open-1280x720.png');
  { const b = await box(pg, '#emenu .mrow[data-item="save"]'); await pg.mouse.click(b.cx, b.cy); await sleep(300); }   // a real mouse press: Playwright's click() refuses an aria-disabled element
  const saveToast = await pg.evaluate(() => [...document.querySelectorAll('#toasts .toast')].map((t) => t.textContent).join(' / '));
  check('Save world is greyed, a press says why (no server save points yet), and the menu stays', /^Save world — not yet/.test(saveToast) && /server support/.test(saveToast) && (await state(pg)).menu, saveToast);
  await pg.evaluate(() => document.getElementById('toasts')?.replaceChildren());

  // PANELS ▸
  await openPanels(pg);
  const sub = await box(pg, '#emenu-sub'), prow = await box(pg, '#emenu .mrow[data-item="panels"]'), m2 = await box(pg, '#emenu');
  check('hovering Panels opens its flyout beside the menu, level with its row, inside the viewport',
    sub && Math.abs(sub.l - (m2.r + 2)) <= 1 && Math.abs(sub.t - (prow.t - 6)) <= 1 && sub.b <= 720 && sub.r <= 1280, JSON.stringify({ sub, prow, m2 }));
  await shot(pg, '03-panels-1280x720.png');

  // EVERY PIN, on → off → on, under a real mouse
  const s0 = await state(pg);
  const ids = Object.keys(s0.pins).filter((id) => s0.pins[id] !== 'dead');
  check('the flyout lists pins for the voice glyphs, the lantern, every window and the wrench', ['glyph:mic', 'glyph:ear', 'lantern', 'chat', 'world', 'search', 'settings', 'edit'].every((id) => ids.includes(id)), ids.join());
  for (const id of ids) {
    const seen = [];
    const start = (await state(pg)).pins[id];
    for (let i = 0; i < 3; i++) {
      await pg.click(`#emenu-sub .mpin[data-pin="${id}"]`); await sleep(200);
      const s = await state(pg);
      seen.push(`${s.pins[id]}/${stored(s, id)}/${s.menu && s.sub ? 'open' : 'CLOSED'}`);
    }
    const want = [!start, start, !start].map((v) => `${v}/${v}/open`);
    if (seen.join() !== want.join()) console.log('  · under', id, JSON.stringify(await pg.evaluate((id) => { const p = document.querySelector(`#emenu-sub .mpin[data-pin="${id}"]`); const r = p.getBoundingClientRect();
      const h = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return { r: [r.left, r.top, r.width, r.height], hit: h && (h.id || h.className?.baseVal || h.className || h.tagName), inPin: !!h?.closest('.mpin') }; }, id)));
    check(`pin ${id}: lit and stored alike through ${start ? 'on→off→on→off' : 'off→on→off→on'}, menu and flyout open throughout`, seen.join() === want.join(), seen.join(' '));
    await pg.click(`#emenu-sub .mpin[data-pin="${id}"]`); await sleep(150);
  }
  // the HUD follows: a closed window's rail button, a glyph, the resting line — each shows iff pinned (open windows show anyway)
  { await pg.evaluate(async () => { const F = await import('/lib/frames.js'); for (const f of F.allFrames()) f.hide(); });
    await sleep(300);
    for (const id of ['glyph:mic', 'lantern', 'world', 'search', 'edit']) {
      await pg.click(`#emenu-sub .mpin[data-pin="${id}"]`); await sleep(200);
      const a = await state(pg);
      await pg.click(`#emenu-sub .mpin[data-pin="${id}"]`); await sleep(200);
      const b = await state(pg);
      check(`the HUD follows ${id}'s pin both ways`, shown(a, id) === a.pins[id] && shown(b, id) === b.pins[id] && a.pins[id] !== b.pins[id], JSON.stringify({ a: [a.pins[id], shown(a, id)], b: [b.pins[id], shown(b, id)] }));
    }
  }

  // THE LANTERN: held clicks on its toggles close it; a pin pressed while it is open leaves it open
  { const toggle = async (sel) => {
      await pg.keyboard.press('Control+k'); await sleep(250);
      const b = await box(pg, sel);
      if (!b) return 'absent';
      await pg.mouse.move(b.cx, b.cy); await pg.mouse.down(); await sleep(260); await pg.mouse.up(); await sleep(300);
      return (await state(pg)).lantern ? 'OPEN' : 'closed';
    };
    check('a held click on the rail\'s search entry closes an open lantern', (await toggle('#dock button[data-toggles="search"]')) === 'closed');
    await openPanels(pg);
    check('…on the flyout\'s lantern row too', (await toggle('#emenu-sub .mrow[data-row="lantern"]')) === 'closed');
    await openPanels(pg);
    check('…and its search row', (await toggle('#emenu-sub .mrow[data-row="search"]')) === 'closed');
    await openPanels(pg);
    await pg.keyboard.press('Control+k'); await sleep(250);
    await pg.click('#emenu-sub .mpin[data-pin="chat"]'); await sleep(400);
    const s = await state(pg);
    check('a pin pressed while the lantern is open leaves the lantern open, and the menu', s.lantern && s.menu && s.sub, JSON.stringify({ l: s.lantern, m: s.menu, sub: s.sub }));
    await pg.click('#emenu-sub .mpin[data-pin="chat"]'); await sleep(150);
    await pg.keyboard.press('Escape'); await sleep(200);
  }

  // HUD LAYOUT MODE (chat back on screen, so the shot shows a frame wearing its arrange chrome)
  await pg.evaluate(async () => (await import('/lib/frames.js')).getFrame('chat')?.show());
  await openPanels(pg);
  await pg.click('#emenu-sub .mrow[data-layout]'); await sleep(250);
  let s = await state(pg);
  check('Panels ▸ HUD layout mode turns arranging on, and the menu stays', s.arranging && s.menu && s.sub, JSON.stringify(s));
  await away(pg);
  s = await state(pg);
  check('the mouse leaving dismisses the menu; the mode outlives it, its marker beside the ∃', !s.menu && s.arranging && !!(await box(pg, '#layoutbar')), JSON.stringify({ menu: s.menu, arranging: s.arranging }));
  await shot(pg, '04-layout-mode-1280x720.png');
  await pg.keyboard.press('Escape'); await sleep(250);
  check('Esc ends HUD layout mode', !(await state(pg)).arranging);

  // DISMISSAL
  await openPanels(pg);
  await pg.keyboard.press('Escape'); await sleep(200);
  s = await state(pg);
  check('Esc closes the flyout first, the menu stays', s.menu && !s.sub, JSON.stringify({ menu: s.menu, sub: s.sub, arranging: s.arranging, lantern: s.lantern }));
  await pg.keyboard.press('Escape'); await sleep(200);
  check('…then the menu', !(await state(pg)).menu);
  await openMenu(pg);
  await pg.mouse.click(900, 420); await sleep(250);
  check('a click outside dismisses it', !(await state(pg)).menu);

  // HELP, ABOUT
  await openMenu(pg);
  await pg.click('#emenu .mrow[data-item="help"]'); await sleep(300);
  check('Help opens the help sheet and the menu goes', await pg.evaluate(() => document.getElementById('help').classList.contains('open')) && !(await state(pg)).menu);
  await pg.keyboard.press('Escape'); await sleep(200);
  await openMenu(pg);
  { const b = await box(pg, '#emenu .mrow[data-item="about"]'); await pg.mouse.move(b.cx, b.cy); await sleep(600); }
  const sha = await pg.evaluate(async () => String((await (await fetch('/version')).json()).sha).slice(0, 7));
  const about = await pg.evaluate(() => document.getElementById('emenu-sub').textContent);
  check('About ▸ shows the build /version reports', about.includes(`build ${sha}`), JSON.stringify({ sha, about }));
  await shot(pg, '05-about-1280x720.png');
  await away(pg);

  // A RELOAD: every pin's highlight still matches what was stored, and the HUD agrees — a few left unpinned first
  await openPanels(pg);
  for (const id of ['world', 'glyph:ear', 'lantern']) { await pg.click(`#emenu-sub .mpin[data-pin="${id}"]`); await sleep(150); }
  await pg.reload({ waitUntil: 'domcontentloaded' }); await settle(pg);
  await openPanels(pg);
  s = await state(pg);
  const bad = Object.keys(s.pins).filter((id) => s.pins[id] !== 'dead' && s.pins[id] !== stored(s, id));
  check('after a reload every pin is lit exactly as stored (world, ears and the lantern were left unpinned)', bad.length === 0 && s.pins.world === false && s.pins['glyph:ear'] === false && s.pins.lantern === false,
    JSON.stringify({ bad, pins: s.pins, ls: s.ls }));
  for (const id of ['world', 'glyph:ear', 'lantern']) { await pg.click(`#emenu-sub .mpin[data-pin="${id}"]`); await sleep(150); }
  check('no page errors on the desktop run', errs.length === 0, errs.slice(0, 3).join(' | '));

  // LITE CLIENT: the row this PR added. Each step opens the menu through the real ∃ (openMenu clicks #hud when shut).
  await pg.keyboard.press('Escape'); await sleep(200); await pg.keyboard.press('Escape'); await sleep(200);
  await openMenu(pg);
  await pg.click('#emenu .mrow[data-item="lite"]'); await sleep(300);
  const cc = await box(pg, '#confirm-center .cc-card');
  const ccText = await pg.evaluate(() => ({ t: document.querySelector('#cc-title')?.textContent, ok: document.querySelector('#confirm-center .cc-ok')?.textContent, focus: document.activeElement?.className }));
  check('Lite client asks first: a dialog centred on screen, "Switch" focused', !!cc && Math.abs(cc.cx - 640) <= 2 && Math.abs(cc.cy - 360) <= 2 && /lite client/i.test(ccText.t ?? '') && ccText.ok === 'Switch' && ccText.focus === 'cc-ok', JSON.stringify({ cc, ccText }));
  await pg.keyboard.press('Escape'); await sleep(300);
  check('…Esc says no: the dialog goes, nothing navigates, nothing is saved', await pg.evaluate(() => !document.getElementById('confirm-center') && globalThis.__ewLite === false && !new URLSearchParams(location.search).has('lite') && localStorage.getItem('ew-lite') === null));
  await openMenu(pg);
  check('…the menu reopens through the ∃ and offers the row again', await pg.locator('#emenu .mrow[data-item="lite"]').isVisible());
  await pg.click('#emenu .mrow[data-item="lite"]'); await sleep(300);
  const nav = pg.waitForEvent('framenavigated', { timeout: 15000 }).catch(() => null);
  await pg.click('#confirm-center .cc-ok'); await nav;
  check('…Switch lands in the lite client, the choice saved and the address clean', await pg.waitForFunction(() => globalThis.__ewLite === true && localStorage.getItem('ew-lite') === '1' && !new URLSearchParams(location.search).has('lite'), null, { timeout: 30000, polling: 250 }).then(() => true, () => false));
  await ctx.close();

  // ------------------------------------------------------------ phone 390x844, touch
  const ph = await boot({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 1 }, 'emenuphone');
  await ph.pg.tap('#hud'); await sleep(300);
  const pm = await box(ph.pg, '#emenu');
  check('phone: a tap opens the menu on screen', pm && pm.l >= 0 && pm.r <= 390 && pm.t >= 0 && pm.b <= 844, JSON.stringify(pm));
  await shot(ph.pg, '06-phone-open-390x844.png');
  await ph.pg.tap('#emenu .mrow[data-item="panels"]'); await sleep(300);
  const ps = await box(ph.pg, '#emenu-sub');
  const prow2 = await box(ph.pg, '#emenu .mrow[data-item="panels"]');
  check('phone: a tap on Panels opens its flyout on screen', ps && ps.l >= 0 && ps.r <= 390 && ps.t >= 0 && ps.b <= 844, JSON.stringify(ps));
  check('phone: with no room beside the menu the flyout drops below its row, which stays in view', ps.t >= prow2.b && await ph.pg.evaluate(([x, y]) => !!document.elementFromPoint(x, y)?.closest('[data-item="panels"]'), [prow2.cx, prow2.cy]),
    JSON.stringify({ ps, prow2 }));
  check('phone: …and every row in it can be reached (it scrolls inside the screen)', await ph.pg.evaluate(() => { const s = document.getElementById('emenu-sub'); return s.scrollHeight <= s.clientHeight + 1 || getComputedStyle(s).overflowY === 'auto'; }));
  await shot(ph.pg, '07-phone-panels-390x844.png');
  await ph.pg.tap('#emenu-sub .mpin[data-pin="world"]'); await sleep(250);
  check('phone: a pin taps on and the menu stays', (await state(ph.pg)).menu);
  await ph.pg.tap('#emenu-sub .mpin[data-pin="world"]'); await sleep(250);
  await ph.pg.touchscreen.tap(300, 700); await sleep(300);
  check('phone: a tap outside dismisses it', !(await state(ph.pg)).menu);
  check('no page errors on the phone run', ph.errs.length === 0, ph.errs.slice(0, 3).join(' | '));
  await ph.ctx.close();
} catch (e) { check('probe ran', false, e.stack ?? e.message); }
finally { try { await close(); } catch {} try { await world.close(); } catch {} }
done();
