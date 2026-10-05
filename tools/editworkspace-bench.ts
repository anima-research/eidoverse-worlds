// editworkspace-bench — the edit WORKSPACE's own chrome, in a real browser (R's 09-30 pass):
//
//   bun tools/editworkspace-bench.ts        (the default ../eidoverse-video library, like editpanels-bench)
//
//   the corner   the ∃ in the top-left cell, the mic / ear (/ goggles) folded to its right exactly as
//                the HUD folds them, the menus after them, the glyphs in the editor's greys;
//   the wrench   the way out: amber on purpose, titled "leave edit mode (B)", the only amber on the rail;
//   Build        Build | Hierarchy tabs in the left column (Build replaced Create in step 5, 10-02; its
//                World section and @world are editpanels-bench's); the six building tools as tiles (structure_ui's
//                TOOLS), "new building", an honest "undo building edit"; the armed tool's strip across the
//                top of the viewport and Esc to drop it; the Library (add light, search, the starters as
//                picture tiles that put the model in your hand); and a VR body that says what it can't do;
//   leaving      the workspace chrome is no longer PAINTED (not merely [hidden]) and the ∃ is home.
//
// Its own browser on purpose: editpanels-bench is long, and headless leaks heap with time (a dead
// WebGPU device; HEAD idles at ~50 MB/s, measured 09-30), so adding these there OOMed its renderer.

import { scratchBench, mkCheck, sleep } from './harness.ts';

const { cdp, evalJson, cleanup, die, BASE } = await scratchBench('editworkspace', { serverEnv: { VERB_RATE: '1000' } });
const { check, tally } = mkCheck();
const waitFor = async (expr: string, ms = 6000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (await evalJson(expr)) return true; await sleep(100); }
  return false;
};

await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
  source: `window.__errs = [];
    addEventListener('error', (e) => __errs.push('error: ' + e.message));
    const ce = console.error.bind(console);
    console.error = (...a) => { __errs.push('console: ' + a.map(String).join(' ')); ce(...a); };`,
});
await cdp.send('Page.navigate', { url: `${BASE}/?name=wsbot&world=wsbench` });
{
  let secs = 0;
  for (let i = 0; i < 120 && secs < 4; i++) {
    secs = (await evalJson(`document.querySelectorAll('.sec').length`)) ?? 0;
    if (secs < 4) await sleep(500);
  }
  check('client boots', secs >= 4, `${secs} sections`);
  // the never-finishing boot splash steals elementFromPoint in headless (editpanels-bench says why)
  await evalJson(`(() => { const s = document.querySelector('#splash'); if (s && !s.classList.contains('gone')) s.style.pointerEvents = 'none'; return true; })()`);
}
await waitFor(`import('/lib/build.js').then((m) => m.mayEdit())`, 10000);
await evalJson(`dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyB' })), true`);
check('B opens the workspace', await waitFor(`!!document.querySelector('.edit-top') && !document.querySelector('.edit-top').hidden && document.body.classList.contains('edit-workspace')`, 10000));

console.log('\nthe corner (R, 09-30): ∃ top-left, mic / ear beside it as on the HUD, then the menus:');
{
  await sleep(1300);   // the corner spacer re-measures on a 1 s tick (and two frames after entry)
  const R = (sel: string) => `(() => { const e = document.querySelector('${sel}'); if (!e || getComputedStyle(e).display === 'none') return null; const r = e.getBoundingClientRect(); return { l: r.left, r: r.right, t: r.top, b: r.bottom }; })()`;
  const geo = await evalJson(`({ hud: ${R('#hud')}, mic: ${R('#micbtn')}, ear: ${R('#earbtn')}, menus: ${R('.edit-menus')}, bar: ${R('.edit-top')}, rail: ${R('.edit-tools')}, wrench: ${R('#dock button[data-toggles="edit"]')} })`);
  const g = geo as any; const cy = (r: any) => (r.t + r.b) / 2;
  check('the ∃ sits in the top-left cell (inside the 48 × 40 corner)', !!g.hud && g.hud.l >= 0 && g.hud.r <= 48 && g.hud.t >= 0 && g.hud.b <= 40, JSON.stringify(g.hud));
  check('the bar runs the full width from x=0; the rail starts under it', g.bar?.l === 0 && g.rail?.t >= 40, JSON.stringify([g.bar, g.rail]));
  check('mic then ear, to the ∃\'s right, on its centre line (the HUD fold)', !!g.mic && !!g.ear && g.mic.l >= g.hud.r && g.ear.l >= g.mic.r - 1 && Math.abs(cy(g.mic) - cy(g.hud)) <= 2 && Math.abs(cy(g.ear) - cy(g.hud)) <= 2, JSON.stringify([g.hud, g.mic, g.ear]));
  check('the menus start after the glyphs, not under them', !!g.menus && g.menus.l >= Math.max(g.mic?.r ?? 0, g.ear?.r ?? 0), JSON.stringify([g.mic, g.ear, g.menus]));
  const dockBtns = await evalJson(`[...document.querySelectorAll('#dock button[data-toggles]')].filter((b) => getComputedStyle(b).display !== 'none').map((b) => b.dataset.toggles)`);
  check('the whole pinned dock is still there in builder mode (chat, world, settings… then the wrench)', Array.isArray(dockBtns) && ['chat', 'world', 'settings', 'edit'].every((k) => dockBtns.includes(k)) && dockBtns.at(-1) === 'edit', dockBtns);
  const below = await evalJson(`(() => { const d = [...document.querySelectorAll('#dock button[data-toggles]')].filter((b) => getComputedStyle(b).display !== 'none'); const t = document.querySelector('.edit-tool'); return { firstDock: d[0].getBoundingClientRect().top, ear: document.querySelector('#earbtn').getBoundingClientRect().bottom, lastDock: d.at(-1).getBoundingClientRect().bottom, tool: t.getBoundingClientRect().top }; })()`);
  check('…the panel buttons start under the bar, and the tools start below the wrench', (below as any).firstDock >= 40 && (below as any).tool >= (below as any).lastDock, below);
  check('the wrench closes the dock, in the column', !!g.wrench && g.wrench.t >= 40 && g.wrench.r <= 48, JSON.stringify(g.wrench));
  // grey-on-grey: the glyph strokes are the editor's greys, not the HUD's teal (mictoggle reads its inks off the button)
  const ink = await evalJson(`(() => { const s = (sel) => { const g = document.querySelector(sel + ' svg g'); return g ? getComputedStyle(g).stroke : null; }; const probe = document.createElement('i'); document.body.append(probe); const c = (v) => { probe.style.color = v; return getComputedStyle(probe).color; }; const out = { mic: s('#micbtn'), ear: s('#earbtn'), dim: c('#8e8e96'), text: c('#d8d8dc'), brand: c(getComputedStyle(document.documentElement).getPropertyValue('--brand').trim()) }; probe.remove(); return out; })()`);
  const k = ink as any;
  check('mic / ear ink is the editor grey (dim off, text on) — not the HUD brand', [k.mic, k.ear].every((v) => v === k.dim || v === k.text) && k.mic !== k.brand, JSON.stringify(k));
}

console.log('\na 1366×768 laptop (≈ 620 px) fits the whole dock; a very short screen (480 px) folds it under ⋯, the tools never fold:');
{
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1366, height: 620, deviceScaleFactor: 1, mobile: false });
  await sleep(1400);
  check('at 620 px the whole dock fits (no ⋯)', await evalJson(`(() => { const m = document.querySelector('#dock .dock-more'); return !m || getComputedStyle(m).display === 'none'; })()`));
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1366, height: 480, deviceScaleFactor: 1, mobile: false });
  await sleep(1400);
  const s = await evalJson(`(() => { const more = document.querySelector('#dock .dock-more'); const tools = [...document.querySelectorAll('.edit-tool')]; return { more: !!more && getComputedStyle(more).display !== 'none', folded: document.querySelectorAll('#dock .edit-overflow').length, toolsBottom: tools.at(-1).getBoundingClientRect().bottom, h: innerHeight, wrench: getComputedStyle(document.querySelector('#dock button[data-toggles="edit"]')).display !== 'none' }; })()`);
  const v = s as any;
  check('⋯ appears and holds the panels that don\'t fit; the wrench stays', v.more && v.folded >= 1 && v.wrench, s);
  check('…every tool is on screen', v.toolsBottom <= v.h, s);
  await evalJson(`(document.querySelector('#dock .dock-more').click(), true)`);
  const rows = await evalJson(`[...document.querySelectorAll('.edit-space-pop .edit-menu-item')].map((r) => r.textContent)`);
  check('…clicking ⋯ lists exactly the folded panels', Array.isArray(rows) && rows.length === v.folded, rows);
  await evalJson(`(document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })), true)`);
  const hud = await evalJson(`(() => { const b = [...document.querySelectorAll('.edit-menu > .edit-btn')].find((x) => /^HUD Panels/.test(x.textContent)); b.click(); const r = [...b.parentElement.querySelectorAll('.edit-menu-item')].map((x) => x.textContent); b.click(); return r; })()`);
  check('HUD Panels ▾ in the bar lists every HUD panel (the fallback, folded or not)', Array.isArray(hud) && hud.some((t) => /Settings/.test(t)) && hud.some((t) => /World/.test(t)), hud);
  const shot = async (name: string) => { if (!process.env.SHOT_DIR) return; const r = await cdp.send('Page.captureScreenshot', { format: 'png' }); (await import('node:fs')).writeFileSync(`${process.env.SHOT_DIR}/${name}.png`, Buffer.from(r.data, 'base64')); };
  await shot('builder-480');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false });
  await sleep(1400);
  await shot('builder-1000');
  check('a tall screen unfolds it again (no ⋯)', await evalJson(`(() => { const m = document.querySelector('#dock .dock-more'); return !m || getComputedStyle(m).display === 'none'; })()`));
}

console.log('\nthe wrench is the way out: amber on purpose, the only amber on the rail:');
{
  check('its title says so: "leave builder mode (B)"', await waitFor(`document.querySelector('#dock button[data-toggles="edit"]')?.title === 'leave builder mode (B)'`, 3000), await evalJson(`document.querySelector('#dock button[data-toggles="edit"]')?.title`));
  const amber = await evalJson(`(() => {
    const probe = document.createElement('i'); document.body.append(probe); probe.style.color = 'var(--attn)'; const A = getComputedStyle(probe).color; probe.remove();
    const rgb = A.match(/[0-9]+/g).slice(0, 3).join(', ');   // no backslashes: this is a template literal
    const amberIn = (cs) => [cs.color, cs.backgroundColor, cs.boxShadow, cs.borderColor].some((v) => v && v.includes(rgb));
    const rail = [...document.querySelectorAll('.edit-tools button, #dock button')].filter((b) => getComputedStyle(b).display !== 'none' && b.getBoundingClientRect().width > 0);
    return { A, wrench: amberIn(getComputedStyle(document.querySelector('#dock button[data-toggles="edit"]'))), others: rail.filter((b) => b.dataset.toggles !== 'edit' && (amberIn(getComputedStyle(b)) || [...b.querySelectorAll('*')].some((c) => amberIn(getComputedStyle(c))))).map((b) => b.dataset.tool ?? b.dataset.toggles ?? b.id ?? b.className), n: rail.length };
  })()`);
  const a = amber as any;
  check('the wrench is amber', a.wrench === true, JSON.stringify(a));
  check('…and no other control on the rail is (tools, ∃)', a.n >= 6 && a.others.length === 0, JSON.stringify(a));
}

console.log('\nBuild — the building tools and the library, docked beside the Hierarchy:');
{
  const create = `document.querySelector('[data-frame="build"]')`;
  // the building tools' own row of tiles (Build's Tools section also holds the transform tiles and seat)
  const stiles = `[...([...${create}.querySelectorAll('.sp-tile')].find((t) => t.textContent.trim() === 'wall')?.closest('.sp-tiles')?.querySelectorAll('.sp-tile') ?? [])]`;
  const tab = (id: string) => `document.querySelector('.edit-tab[data-tab="${id}"]')`;
  const shown = (f: string) => `getComputedStyle(document.querySelector('[data-frame="${f}"]')).display !== 'none'`;
  check('the viewport carries no floating building bar', await evalJson(`!document.querySelector('#structbar')`));
  check('Build is the open tab on a first B (design §5); the Hierarchy waits behind it', await evalJson(`${tab('build')}.classList.contains('on') && ${shown('build')} && !(${shown('hierarchy')})`));
  await evalJson(`${tab('hierarchy')}?.click(), true`);
  check('the Hierarchy tab swaps the pane', await waitFor(`${shown('hierarchy')} && !(${shown('build')}) && ${tab('hierarchy')}.classList.contains('on')`));
  await evalJson(`${tab('build')}?.click(), true`);
  check('the Build tab swaps it back (Build shown, Hierarchy hidden)', await waitFor(`${shown('build')} && !(${shown('hierarchy')}) && ${tab('build')}.classList.contains('on')`));
  check('…in the same place the Hierarchy was (left column, under the tabs)', await evalJson(`(() => { const t = document.querySelector('.edit-tabs').getBoundingClientRect(), c = ${create}.getBoundingClientRect(), L = document.querySelector('.edit-left').getBoundingClientRect(); return Math.abs(c.top - t.bottom) <= 1 && c.left >= L.left && c.right <= L.right + 1 && c.height > 120; })()`));
  check('Structure: the six tools as tiles, in TOOLS order', await waitFor(`${stiles}.map((t) => t.textContent.trim()).join() === 'room,wall,door,window,floor,erase'`), await evalJson(`[...${create}.querySelectorAll('.sp-tile')].map((t) => t.textContent.trim()).join()`));
  check('…each a glyph, titled with its hint', await evalJson(`${stiles}.length === 6 && ${stiles}.every((t) => t.querySelector('svg') && / — /.test(t.title))`));
  const btn = (re: string) => `[...${create}.querySelectorAll('.sp-btn')].find((b) => /${re}/.test(b.textContent))`;
  check('"new building" and an honestly-named "undo building edit" (disabled: nothing to undo)', await evalJson(`!!${btn('new building')} && ${btn('^undo building edit$')}?.disabled === true && /separate from Ctrl.Z/.test(${btn('^undo building edit$')}.closest('.sp-row').title)`), await evalJson(`[...${create}.querySelectorAll('.sp-row')].map((r) => r.textContent.trim() + ' :: ' + r.title).join(' | ')`));
  check('the viewport strip is down while no tool is armed', await evalJson(`document.querySelector('.edit-toolstrip')?.hidden === true`));
  await evalJson(`[...${create}.querySelectorAll('.sp-tile')].find((t) => t.textContent.trim() === 'wall')?.click(), true`);
  check('clicking the wall tile arms the wall tool', await waitFor(`import('/lib/structure_ui.js').then((m) => m.currentTool() === 'wall')`));
  check('…the tile reads armed (and it alone: the transform tile yields the click)', await waitFor(`[...${create}.querySelectorAll('.sp-tile.on')].map((t) => t.textContent.trim()).join() === 'wall'`));
  check('…and the viewport strip names it, with its hint and the way out', await waitFor(`(() => { const s = document.querySelector('.edit-toolstrip'); return s && !s.hidden && /wall/.test(s.textContent) && /click an edge/.test(s.textContent) && /Esc to drop/.test(s.textContent); })()`), await evalJson(`document.querySelector('.edit-toolstrip')?.textContent`));
  check('…laid across the top of the VIEWPORT (between the columns, under the bar)', await evalJson(`(() => { const s = document.querySelector('.edit-toolstrip').getBoundingClientRect(), L = document.querySelector('.edit-left').getBoundingClientRect(), R = document.querySelector('.edit-right').getBoundingClientRect(); return Math.abs(s.left - L.right) <= 1 && Math.abs(s.right - R.left) <= 1 && s.top === 40 && s.height <= 32; })()`));
  await evalJson(`[...${create}.querySelectorAll('.sp-tile')].find((t) => t.textContent.trim() === 'wall')?.click(), true`);
  check('the armed tile again drops it', await waitFor(`import('/lib/structure_ui.js').then((m) => m.currentTool() === null) && document.querySelector('.edit-toolstrip').hidden`));
  await evalJson(`[...${create}.querySelectorAll('.sp-tile')].find((t) => t.textContent.trim() === 'door')?.click(), true`);
  await waitFor(`import('/lib/structure_ui.js').then((m) => m.currentTool() === 'door')`);
  await evalJson(`dispatchEvent(new KeyboardEvent('keydown', { code: 'Escape', key: 'Escape' })), true`);
  check('Esc drops an armed tool (and only that — edit mode stays on)', await waitFor(`import('/lib/structure_ui.js').then((m) => m.currentTool() === null) && document.querySelector('.edit-toolstrip').hidden && import('/lib/build.js').then((b) => b.isEditing())`), JSON.stringify(await evalJson(`import('/lib/build.js').then((b) => b.isEditing())`)));
  // Library: what the World panel's build section offers, here
  check('Library: add light, the search box, the starter models as picture tiles', await evalJson(`!!${btn('add light')} && !!${create}.querySelector('.sp-text[placeholder^="search the library"]') && ${create}.querySelectorAll('.sp-tiles-img .sp-tile img').length >= 8`), await evalJson(`${create}.querySelectorAll('.sp-tiles-img .sp-tile').length`));
  await evalJson(`${btn('add light')}?.click(), true`);
  check('add light: a light in your hand', await waitFor(`import('/lib/build.js').then((m) => m.hasGhost())`), JSON.stringify(await evalJson(`(window.__errs ?? []).filter((e) => /ghost|light/i.test(e)).slice(-3)`)));
  await evalJson(`import('/lib/build.js').then((m) => m.cancelGhost()), true`);
  await evalJson(`[...${create}.querySelectorAll('.sp-tiles-img .sp-tile')].find((t) => t.textContent.trim() === 'crate (red)')?.click(), true`);
  check('a library tile puts the model in your hand (the ghost build.js carries)', await waitFor(`import('/lib/build.js').then((m) => m.hasGhost())`), JSON.stringify(await evalJson(`(window.__errs ?? []).filter((e) => /ghost|glb/i.test(e)).slice(-3)`)));
  await evalJson(`import('/lib/build.js').then((m) => m.cancelGhost()), true`);
  check('the VR body says the building tools are desktop-only, and offers the library and the World', await evalJson(`import('/lib/xrpanels.js').then((m) => { const f = m.xrPanelsDebug().fields.build ?? []; return f.includes('place') && !f.includes('stool') && !f.includes('ttool') && f.includes('info') && f.includes('wsky'); })`), JSON.stringify(await evalJson(`import('/lib/xrpanels.js').then((m) => m.xrPanelsDebug().fields.build)`)));
  await evalJson(`${tab('hierarchy')}?.click(), true`);
  check('back to the Hierarchy tab', await waitFor(`${shown('hierarchy')} && !(${shown('build')})`));
}

console.log('\nleaving:');
await evalJson(`import('/lib/build.js').then((m) => m.setEditMode(false)), true`);
check('the workspace chrome is not painted any more (bar, rail, columns, tool strip)', await waitFor(`[...document.querySelectorAll('.edit-strip, .edit-col, .edit-split-v, .edit-toolstrip')].every((e) => getComputedStyle(e).display === 'none')`), JSON.stringify(await evalJson(`[...document.querySelectorAll('.edit-strip, .edit-col, .edit-split-v, .edit-toolstrip')].map((e) => e.className + ':' + getComputedStyle(e).display)`)));
check('…the ∃ is back on the HUD, hit-testable, its glyphs beside it', await waitFor(`(() => { const h = document.querySelector('#hud').getBoundingClientRect(), m = document.querySelector('#micbtn').getBoundingClientRect(); const hit = document.elementFromPoint(h.left + h.width / 2, h.top + h.height / 2); return (hit === document.querySelector('#hud') || document.querySelector('#hud').contains(hit)) && m.left >= h.right && Math.abs((m.top + m.bottom) / 2 - (h.top + h.bottom) / 2) <= 2; })()`));
check('…the glyphs wear the HUD ink again (not the editor grey)', await waitFor(`(() => { const g = document.querySelector('#micbtn svg g'); const p = document.createElement('i'); document.body.append(p); p.style.color = 'var(--dim)'; const dim = getComputedStyle(p).color; p.remove(); return !!g && getComputedStyle(g).stroke === dim; })()`, 3000));
// plainly = as every dock button is titled on main (ui.js dockTitle: its name · its key)
check('…and the wrench is titled plainly again', await waitFor(`document.querySelector('#dock button[data-toggles="edit"]')?.title === 'Builder mode · B'`, 3000), await evalJson(`document.querySelector('#dock button[data-toggles="edit"]')?.title`));

const errs: string[] = (await evalJson(`window.__errs`)) ?? [];
const mine = errs.filter((e) => /editpanels|editlayout|structure_ui|panels\.js|editpaint|mictoggle|worldquad|palette/.test(e));
check('no page errors from the workspace', mine.length === 0, mine.slice(0, 3).join(' | '));

console.log(`\n${tally.passed} passed, ${tally.failed} failed`);
if (tally.failed) await die(1, 'editworkspace-bench: FAILED');
await cleanup();
process.exit(0);
