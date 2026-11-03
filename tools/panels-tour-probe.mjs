// panels-tour-probe — every HUD panel and every tab in it, in the REAL client, at 1280×720 and at a
// 390×844 phone (touch). World and Settings hold their sections as TABS (ui.js makeSection), Debug as
// text tabs by job (debug.js dbgTabs), Profile as its own tabs; Chat is one pane. Clouds are forced OFF
// before boot (a cloudy sky bakes on the CPU in headless Chromium and has frozen the host).
//
//   bun tools/panels-tour-probe.mjs [--shots <dir>]      (desktop shots 30+, phone shots 50+)
//
// What must hold, per tab, at both sizes:
//   the tab opens its OWN pane and no other (the pane .open, the tab .on/aria-selected, every other pane
//   closed) — for World/Settings through the tab AND through its lantern action (section:<host>:<name>);
//   the frame is on screen; the chosen tab is inside the strip's visible width; nothing in the pane is
//   wider than the pane (no sideways scroll, no clipped controls).
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
  await pg.goto(`${world.origin}/?world=tour&name=${name}&key=${world.key}&lite=0`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await pg.waitForFunction(() => document.getElementById('splash')?.classList.contains('gone') && !!globalThis.EW?.me?.(), null, { timeout: 120000 });
  await sleep(3000);
  // the status chip's popover and any toast are not the subject
  await pg.evaluate(() => { document.getElementById('toasts')?.replaceChildren(); });
  return { ctx, pg, errs };
}

// only `id` on screen: every other frame hidden
const solo = (pg, id) => pg.evaluate(async (id) => {
  const F = await import('/lib/frames.js');
  for (const f of F.allFrames()) if (f.visible && f.id !== id && f.el?.dataset.frame !== id) f.hide();
  const f = F.getFrame(id); f?.show(); return !!f;
}, id);

// the state of one tabbed frame: which pane is open, which tab is on, and the layout facts
const tabState = (pg, frameId, paneSel, tabSel) => pg.evaluate(({ frameId, paneSel, tabSel }) => {
  const fr = document.querySelector(`.frame[data-frame="${frameId}"]`);
  const r = fr.getBoundingClientRect();
  const panes = [...fr.querySelectorAll(paneSel)].map((p) => ({ id: p.id || p.dataset.tab, open: p.classList.contains('open') }));
  const tabs = [...fr.querySelectorAll(tabSel)].map((t) => ({ id: t.id || t.dataset.tab, on: t.classList.contains('on'), sel: t.getAttribute('aria-selected') }));
  const strip = fr.querySelector(tabSel)?.parentNode; const on = fr.querySelector(`${tabSel}.on`);
  const sr = strip?.getBoundingClientRect(), tr = on?.getBoundingClientRect();
  // anything in the open pane poking past the pane's right edge (a control clipped or a sideways scroll)
  const open = fr.querySelector(`${paneSel}.open`);
  const pr = (fr.querySelector('.stack') ?? open)?.getBoundingClientRect();   // the scroller's edge: a pane wider than it is itself the overflow
  const scan = fr.querySelector('.stack') ?? open;
  const wide = scan ? [...scan.querySelectorAll('*')].filter((e) => { const b = e.getBoundingClientRect(); return b.width > 0 && b.right > pr.right + 1.5 && getComputedStyle(e).position !== 'fixed'; })
    .slice(0, 3).map((e) => `${e.tagName.toLowerCase()}.${[...e.classList].join('.')}:${Math.round(e.getBoundingClientRect().right - pr.right)}px`) : [];
  const sc = fr.querySelector('.stack') ?? open;
  if (sc && sc.scrollWidth - sc.clientWidth > 1 && !wide.length) {   // name the cause even when it has no box of its own
    const sr2 = sc.getBoundingClientRect();
    for (const e of sc.querySelectorAll('*')) { const b = e.getBoundingClientRect(); if (b.right > sr2.right + 1.5) { wide.push(`${e.tagName.toLowerCase()}.${[...e.classList].join('.')}(w${Math.round(b.width)}):${Math.round(b.right - sr2.right)}px`); if (wide.length > 3) break; } }
  }
  // every tab reachable: the point at its centre hits the tab, not something laid over it
  const covered = [...fr.querySelectorAll(tabSel)].filter((t) => { const b = t.getBoundingClientRect(); if (!b.width) return false;
    const cx = Math.min(Math.max(b.left + b.width / 2, sr.left + 2), sr.right - 2); if (cx < b.left || cx > b.right) return false;   // scrolled out of the strip: not a cover
    const hit = document.elementFromPoint(cx, b.top + b.height / 2); return !(hit && (hit === t || t.contains(hit))); })
    .map((t) => { const b = t.getBoundingClientRect(); const hit = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2); return `${t.id || t.dataset.tab} under ${hit?.id || hit?.className || hit?.tagName}`; });
  return { panes, tabs, frame: [r.left, r.top, r.right, r.bottom].map(Math.round), vw: innerWidth, vh: innerHeight,
    tabIn: !!(sr && tr && tr.left >= sr.left - 1 && tr.right <= sr.right + 1), wide, covered, hscroll: sc ? sc.scrollWidth - sc.clientWidth : 0, fit: strip?.dataset.fit ?? null };
}, { frameId, paneSel, tabSel });

async function tour(pg, tag, base) {
  let n = base;
  const shot = async (name) => { if (shotDir) await pg.screenshot({ path: `${shotDir}/${String(n).padStart(2, '0')}-${name}.png` }); n++; };
  const judge = (label, s, want) => {
    const panesOk = s.panes.every((p) => p.open === (p.id === want.pane));
    const tabsOk = s.tabs.every((t) => t.on === (t.id === want.tab) && t.sel === String(t.id === want.tab));
    check(`${tag} ${label}: its pane alone is open, its tab alone is chosen`, panesOk && tabsOk, JSON.stringify({ panes: s.panes, tabs: s.tabs }));
    check(`${tag} ${label}: the frame is on screen`, s.frame[0] >= -1 && s.frame[1] >= -1 && s.frame[2] <= s.vw + 1 && s.frame[3] <= s.vh + 1, JSON.stringify(s.frame));
    check(`${tag} ${label}: the chosen tab is inside the strip's visible width (fit: ${s.fit || 'full'})`, s.tabIn);
    check(`${tag} ${label}: no tab is covered by other HUD (its centre hits the tab)`, s.covered.length === 0, JSON.stringify(s.covered));
    check(`${tag} ${label}: nothing in the pane is wider than the pane`, s.wide.length === 0 && s.hscroll <= 1, JSON.stringify({ wide: s.wide, hscroll: s.hscroll }));
  };

  // ---- world + settings: through the tab, and through the lantern's action
  for (const host of ['world', 'settings']) {
    await solo(pg, host);
    await sleep(300);
    const ids = await pg.evaluate((h) => [...document.querySelectorAll(`.frame[data-frame="${h}"] .sec-tabs .pf-tab`)].map((t) => t.id.replace(/^sec-|-tab$/g, '')), host);
    check(`${tag} ${host}: every section is a tab (${ids.join(' · ')})`, ids.length >= (host === 'world' ? 8 : 4) && ids.every(Boolean), ids.join());
    for (const id of ids) {
      await pg.click(`#sec-${id}-tab`, { timeout: 3000 }).catch(() => pg.evaluate((id) => document.getElementById(`sec-${id}-tab`).click(), id));
      await sleep(id === 'build' || id === 'avatar' || id === 'scene' ? 1500 : 700);
      judge(`${host} ▸ ${id} (tab)`, await tabState(pg, host, '.sec', '.sec-tabs .pf-tab'), { pane: `sec-${id}`, tab: `sec-${id}-tab` });
      await shot(`${host}-${id}`);
    }
    // the lantern's action for each: from a closed frame, on its own tab
    for (const id of ids) {
      const label = await pg.evaluate((id) => { const t = document.getElementById(`sec-${id}-tab`); return t.title || t._tip; }, id);   // a hovered tab lends its title to the house tooltip (ui.js)
      await pg.evaluate(async (h) => (await import('/lib/frames.js')).getFrame(h).hide(), host);
      await pg.evaluate(async ([h, l]) => (await import('/lib/actions.js')).run(`section:${h}:${l}`), [host, label]);
      await sleep(250);
      const s = await tabState(pg, host, '.sec', '.sec-tabs .pf-tab');
      check(`${tag} action section:${host}:${label} opens ${host} on the ${id} tab`, s.panes.every((p) => p.open === (p.id === `sec-${id}`)) && s.tabs.every((t) => t.on === (t.id === `sec-${id}-tab`)),
        JSON.stringify({ panes: s.panes, tabs: s.tabs }));
    }
  }

  // ---- profile tabs
  await solo(pg, 'profile'); await sleep(500);
  const ptabs = await pg.evaluate(() => [...document.querySelectorAll('.pf-tabs:not(.sec-tabs):not(.dbg-tabs) .pf-tab')].map((t) => t.dataset.tab));
  for (const t of ptabs) {
    await pg.click(`.frame[data-frame="profile"] .pf-tab[data-tab="${t}"]`, { timeout: 3000 }).catch(() => pg.evaluate((t) => document.querySelector(`.frame[data-frame="profile"] .pf-tab[data-tab="${t}"]`).click(), t)); await sleep(700);
    const s = await pg.evaluate((t) => { const fr = document.querySelector('.frame[data-frame="profile"]'); const r = fr.getBoundingClientRect();
      const b = fr.querySelector('.fr-body') ?? fr; return { on: fr.querySelector('.pf-tab.on')?.dataset.tab, frame: [r.left, r.top, r.right, r.bottom].map(Math.round), vw: innerWidth, vh: innerHeight, hscroll: [...fr.querySelectorAll('*')].some((e) => e.scrollWidth - e.clientWidth > 1 && getComputedStyle(e).overflowX === 'auto' && !e.classList.contains('pf-tabs')) }; }, t);
    check(`${tag} profile ▸ ${t}: chosen, on screen, no sideways scroll`, s.on === t && s.frame[2] <= s.vw + 1 && s.frame[3] <= s.vh + 1 && s.frame[0] >= -1 && !s.hscroll, JSON.stringify(s));
    await shot(`profile-${t}`);
  }

  // ---- debug: text tabs by job
  await solo(pg, 'debug'); await sleep(500);
  const dtabs = await pg.evaluate(() => [...document.querySelectorAll('.dbg-tabs .pf-tab')].map((t) => t.dataset.tab));
  check(`${tag} debug: text tabs by job (${dtabs.join(' · ')})`, dtabs.join() === 'physics,body,perf', dtabs.join());
  for (const t of dtabs) {
    await pg.click(`.dbg-tabs .pf-tab[data-tab="${t}"]`, { timeout: 3000 }).catch(() => pg.evaluate((t) => document.querySelector(`.dbg-tabs .pf-tab[data-tab="${t}"]`).click(), t)); await sleep(700);
    judge(`debug ▸ ${t}`, await tabState(pg, 'debug', '.dbg-pane', '.dbg-tabs .pf-tab'), { pane: t, tab: t });
    await shot(`debug-${t}`);
  }

  // ---- chat
  await solo(pg, 'chat'); await sleep(500);
  await shot('chat');

  // ---- the ∃ menu's Panels ▸ (the waterfall, owner 10-01): every window row opens its panel, on screen, and the
  // menu stays open through all of them (a window opening beside the HUD is not "another window")
  await pg.evaluate(async () => { const F = await import('/lib/frames.js'); for (const f of F.allFrames()) f.hide(); });
  await pg.click('#hud'); await sleep(250);
  await pg.click('#emenu .mrow[data-item="panels"]'); await sleep(300);
  await shot('emenu-panels');
  const rows = await pg.evaluate(async () => { const F = await import('/lib/frames.js');
    return [...document.querySelectorAll('#emenu-sub .mrow[data-row]')].map((r) => r.dataset.row).filter((id) => F.getFrame(id)); });
  check(`${tag} Panels ▸ lists a row for every panel (${rows.join(' · ')})`, ['profile', 'chat', 'world', 'emotes', 'debug', 'settings'].every((id) => rows.includes(id)), rows.join());
  for (const id of rows) {
    const sel = `#emenu-sub .mrow[data-row="${id}"]`;
    await pg.click(sel, { position: { x: 30, y: 12 }, timeout: 3000 }).catch(() => pg.evaluate((s) => document.querySelector(s).click(), sel));
    await sleep(400);
    const st = await pg.evaluate((id) => { const fr = document.querySelector(`.frame[data-frame="${id}"]`); const r = fr?.getBoundingClientRect();
      return { shown: !!fr && getComputedStyle(fr).display !== 'none', frame: r ? [r.left, r.top, r.right, r.bottom].map(Math.round) : null, vw: innerWidth, vh: innerHeight,
        lit: document.querySelector(`#emenu-sub .mrow[data-row="${id}"]`)?.classList.contains('open'), menu: !document.getElementById('emenu').hidden && !document.getElementById('emenu-sub').hidden }; }, id);
    check(`${tag} Panels ▸ ${id}: its row opens the panel on screen, lit, the menu still open`,
      st.shown && st.lit && st.menu && st.frame[0] >= -1 && st.frame[1] >= -1 && st.frame[2] <= st.vw + 1 && st.frame[3] <= st.vh + 1, JSON.stringify(st));
    await pg.click(sel, { position: { x: 30, y: 12 }, timeout: 3000 }).catch(() => pg.evaluate((s) => document.querySelector(s).click(), sel));
    await sleep(250);
  }
  await pg.keyboard.press('Escape'); await sleep(150); await pg.keyboard.press('Escape'); await sleep(150);
  return n;
}

try {
  {
    const { ctx, pg, errs } = await boot({ viewport: { width: 1280, height: 720 } }, 'tourdesk');
    await tour(pg, 'desktop', 30);
    check('desktop: no page errors', errs.length === 0, errs.join(' | '));
    await ctx.close();
  }
  {
    const { ctx, pg, errs } = await boot({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true }, 'tourphone');
    await tour(pg, 'phone', 50);
    check('phone: no page errors', errs.length === 0, errs.join(' | '));
    await ctx.close();
  }
} finally {
  await close(); await world.close();
}
done();
