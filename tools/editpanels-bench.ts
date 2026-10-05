// editpanels-bench — the Hierarchy and Inspector frames actually PAINT and
// EDIT, in a real browser, against an owned world.
//
//   bun tools/editpanels-bench.ts
//
// panels-test.ts binds the factory headless; this is the seam it cannot see:
// the frames mount in the real dock, edit mode shows them, a placed light
// (no asset needed) lands in the tree, the Inspector draws ONE card per
// component (design §5: Transform with its channel box, Light, Bob, Seats …,
// then Add Component) from the one fields declaration, and a typed `+=4` on
// brightness reaches the light through dispatch → updateLight → the coalesced
// `light` verb. (Before components-B the inspector was a flat channel strip
// labelled `light · brightness` plus a group repeating the same fields — two
// lanes; B has one, so the checks below read card labels.)

import { scratchBench, mkCheck, sleep } from './harness.ts';

// VERB_RATE: the server allows 12 verbs / 4 s per connection and DROPS the rest. This bench fires
// bursts no person would (a motion edit, a sockets comp and a spin inside one window), so which
// check's verb landed 13th was a timing lottery — the degree-channel flake, seen beside "slow down
// — verb rate limit". Proven 09-23 by squeezing it (BENCH_VERB_RATE=4 fails deterministically).
// The bench tests the editor, not the limiter; a person editing still meets the real limit.
const { cdp, cws, evalJson, cleanup, die, BASE, SCRATCH } = await scratchBench('editpanels', { serverEnv: { VERB_RATE: process.env.BENCH_VERB_RATE ?? '1000' } });
const { check, tally } = mkCheck();

// Headless Chrome (no working swap chain) delivers rAF callbacks late — the
// trace showed a repaint requested at t=1304 land at t=2838. The panels
// coalesce repaints on rAF by design, so the bench WAITS for the paint
// instead of sleeping a guess.
const waitFor = async (expr: string, ms = 6000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (await evalJson(expr)) return true; await sleep(100); }
  return false;
};
// …and when the next step READS a row (a right-click menu reads the row's live field, a key acts on what the
// inspector shows), wait for two real frames: the repaint that carries the new value is the next rAF
const painted = () => evalJson(`new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true))))`);

await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
  source: `window.__errs = [];
    addEventListener('error', (e) => __errs.push('error: ' + e.message));
    const ce = console.error.bind(console);
    console.error = (...a) => { __errs.push('console: ' + a.map(String).join(' ')); ce(...a); };`,
});
await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: `window.__refused = []; window.__keys = []; import('/lib/base.js').then((m) => { m.bus.on('verb-refused', (e) => window.__refused.push(e?.error ?? '')); m.bus.on('key', (e) => window.__keys.push(e.code)); });` });
await cdp.send('Page.navigate', { url: `${BASE}/?name=editbot&world=editbench` });

{
  let secs = 0;
  for (let i = 0; i < 120 && secs < 4; i++) {
    secs = (await evalJson(`document.querySelectorAll('.sec').length`)) ?? 0;
    if (secs < 4) await sleep(500);
  }
  check('client boots', secs >= 4, `${secs} sections`);
  // Headless never finishes the body load (dead WebGPU swap chain), so the
  // boot splash stays at --spp 0.6, full-screen at z-100, and steals every
  // elementFromPoint below. A real browser dismisses it. Make it transparent
  // to hit-tests here; every "can a pointer reach it" check depends on this.
  await evalJson(`(() => { const s = document.querySelector('#splash'); if (s && !s.classList.contains('gone')) s.style.pointerEvents = 'none'; return true; })()`);
}

console.log('\nedit mode shows the two frames:');
// four edit frames: Build and Hierarchy share the left column's top pane as tabs (step 5: Build replaced
// Create, 10-02), the Inspector is on the right, the Console is opt-in
check('frames exist before edit mode, hidden', await evalJson(`[...document.querySelectorAll('.frame.edit')].length === 4 && [...document.querySelectorAll('.frame.edit')].every((f) => getComputedStyle(f).display === 'none')`));
check('a fresh viewer has no remembered tab', await evalJson(`(() => { try { return !(JSON.parse(localStorage.getItem('ew-edit-layout') || 'null')?.tabV); } catch { return true; } })()`));
await evalJson(`dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyB' })), true`);
// design §5: B enters edit mode on the Build tab
check('B opens on the Build tab: Build + Inspector show, the Hierarchy waits behind its tab, NOT the console', await waitFor(`(() => { const F = [...document.querySelectorAll('.frame.edit')]; const vis = F.filter((f) => getComputedStyle(f).display !== 'none').map((f) => f.dataset.frame).sort().join(); return vis === 'build,inspector' && document.querySelector('.edit-tab.on')?.dataset.tab === 'build'; })()`), JSON.stringify(await evalJson(`[...document.querySelectorAll('.frame.edit')].map((f) => [f.dataset.frame, getComputedStyle(f).display])`)));
check('titles are Build / Console / Hierarchy / Inspector', await evalJson(`[...document.querySelectorAll('.frame.edit .fr-title')].map((t) => t.textContent).sort().join('|') === 'Build|Console|Hierarchy|Inspector'`));
check('the tabs read Build, Hierarchy', await evalJson(`[...document.querySelectorAll('.edit-tab')].map((b) => b.textContent).join('|') === 'Build|Hierarchy'`));
check('Build has its three sections: Blueprints · Tools · World', await waitFor(`(() => { const t = [...document.querySelectorAll('[data-frame="build"] .sp-group')].map((g) => g.textContent.slice(2)); return t.join('|') === 'Blueprints|Tools|World'; })()`), JSON.stringify(await evalJson(`[...document.querySelectorAll('[data-frame="build"] .sp-group')].map((g) => g.textContent)`)));
// the tree checks below point at rows by their on-screen boxes: show the Hierarchy page
await evalJson(`document.querySelector('.edit-tab[data-tab="hierarchy"]').click(), true`);
check('the Hierarchy tab swaps the pane', await waitFor(`getComputedStyle(document.querySelector('[data-frame="hierarchy"]')).display !== 'none' && getComputedStyle(document.querySelector('[data-frame="build"]')).display === 'none'`));
check('…and is remembered (this viewer, this browser)', await evalJson(`(() => { const L = JSON.parse(localStorage.getItem('ew-edit-layout') || '{}'); return L.leftTab === 'hierarchy' && L.tabV === 2; })()`));
check('empty world: hierarchy says so', await evalJson(`!!document.querySelector('[data-frame="hierarchy"] .sp-empty')`));
check('…with the World row pinned above the tree', await evalJson(`(() => { const r = document.querySelector('[data-frame="hierarchy"] .sp-item'); return !!r && !r.textContent.includes('@world') && r.textContent.length > 0; })()`), await evalJson(`document.querySelector('[data-frame="hierarchy"] .sp-item')?.textContent ?? null`));
check('nothing selected: inspector says so', await evalJson(`/nothing selected/.test(document.querySelector('[data-frame="inspector"] .sp-info')?.textContent ?? '')`));

console.log('\nthe workspace: docked columns, strips, a slim rail:');
// the column's top pane is Build | Hierarchy under a tab strip (was Hierarchy | Create, 09-30)
check('hierarchy is docked in the left column, above chat — tabbed with Build', await evalJson(`(() => { const L = document.querySelector('.edit-left'); const ids = [...L.children].map((c) => c.dataset?.frame ?? c.className); return JSON.stringify(ids) === JSON.stringify(['edit-tabs', 'build', 'hierarchy', 'edit-split edit-split-h', 'chat']); })()`), await evalJson(`JSON.stringify([...document.querySelector('.edit-left').children].map((c) => c.dataset?.frame ?? c.className))`));
check('inspector is docked in the right column', await evalJson(`document.querySelector('.edit-right [data-frame="inspector"]') !== null`));
check('top strip + tools column are up', await evalJson(`!document.querySelector('.edit-top').hidden && document.querySelectorAll('.edit-tools .edit-tool').length === 5`));
check('mic / ear / goggles sit IN the top bar (inside its box, hit-testable)', await evalJson(`(() => { const bar = document.querySelector('.edit-top').getBoundingClientRect(); const ok = (sel) => { const e = document.querySelector(sel); if (!e) return sel === '.xr-chip'; const r = e.getBoundingClientRect(); const inside = r.top >= bar.top && r.bottom <= bar.bottom + 1 && r.right <= bar.right; const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return inside && (hit === e || e.contains(hit)); }; return ok('#micbtn') && ok('#earbtn') && ok('.xr-chip'); })()`), await evalJson(`JSON.stringify(['#micbtn','#earbtn','.xr-chip'].map((s) => { const e = document.querySelector(s); const r = e?.getBoundingClientRect(); return r ? [s, r.left|0, r.top|0, r.width|0, r.height|0] : [s, null]; }))`));
await evalJson(`document.querySelector('.edit-vbtn[data-view="wire"]').click(), true`);
check('wireframe sets a scene override material', await evalJson(`import('/lib/core.js').then((m) => !!m.scene.overrideMaterial?.wireframe)`));
await evalJson(`document.querySelector('.edit-vbtn[data-view="wire"]').click(), true`);
check('…and clears it', await evalJson(`import('/lib/core.js').then((m) => m.scene.overrideMaterial === null)`));
check('rail shows only the wrench among toggles', await evalJson(`[...document.querySelectorAll('#dock button[data-toggles]')].filter((b) => getComputedStyle(b).display !== 'none').map((b) => b.dataset.toggles).join() === 'edit'`));
check('the World panel is parked (it would sit behind the Inspector)', await evalJson(`!document.querySelector('[data-frame="world"]') || getComputedStyle(document.querySelector('[data-frame="world"]')).display === 'none'`));
check('docked frames ignore their floating geometry', await evalJson(`(() => { const h = document.querySelector('[data-frame="hierarchy"]'); const cs = getComputedStyle(h); return cs.position === 'relative' && h.getBoundingClientRect().left >= 40; })()`));
await evalJson(`document.querySelector('.edit-tool[data-tool="rotate"]').click(), true`);
check('clicking a tool sets it (rotate)', await evalJson(`globalThis.__editLayout?.().tool === 'rotate'`));
await evalJson(`document.querySelector('.edit-tool[data-tool="move"]').click(), true`);
check('Edit ▾ opens a menu with undo (and it is the only one showing)', await evalJson(`(() => { [...document.querySelectorAll('.edit-menu > .edit-btn')].find((b) => /^Edit/.test(b.textContent)).click(); const shown = [...document.querySelectorAll('.edit-menu-pop')].filter((p) => getComputedStyle(p).display !== 'none'); return shown.length === 1 && [...shown[0].querySelectorAll('.edit-menu-item')].some((i) => /undo/.test(i.textContent)); })()`));
await evalJson(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })), true`);
check('Esc closes the menu (computed, not the attribute)', await evalJson(`[...document.querySelectorAll('.edit-menu-pop')].every((p) => getComputedStyle(p).display === 'none')`));

console.log('\na placed light lands in the tree and the inspector:');
await evalJson(`import('/lib/net.js').then((m) => m.sendVerb('light', { id: 'benchlamp', pos: [1, 1, 1], color: 0xffd9a0, intensity: 16, range: 10 })), true`);
{
  let ok = false;
  for (let i = 0; i < 30 && !ok; i++) { ok = await evalJson(`import('/lib/world.js').then((m) => !!m.entities.get('benchlamp'))`); if (!ok) await sleep(200); }
  check('the light folded locally', ok);
}
check('tree row appears (after the coalesced repaint)', await waitFor(`[...document.querySelectorAll('.frame.edit .sp-tree-row .sp-item-label')].some((l) => /benchlamp/.test(l.textContent))`));
await evalJson(`import('/lib/scenegraph.js').then((m) => m.sceneSelect('benchlamp')), true`);
await waitFor(`!!document.querySelector('.frame.edit .sp-tree-row.active')`);
const insp = `[...document.querySelectorAll('.frame.edit')].find((f) => /Inspector/.test(f.querySelector('.fr-title')?.textContent))`;
// Add Component is ONE button opening a searchable list (R 10-04): '+ X' is the list's item X (opened FRESH each time:
// the list is a snapshot of the selection it opened on)
const popItem = (label: string) => `(() => { document.querySelector('.sp-pop-search')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); ${insp}.querySelector('.sp-pop-btn')?.click(); return [...document.querySelectorAll('.sp-pop-item')].find((b) => b.textContent.trim().replace(/…$/, '') === ${JSON.stringify(label.replace(/^\+ /, ''))}); })()`;
const popItems = `(() => { document.querySelector('.sp-pop-search')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); ${insp}.querySelector('.sp-pop-btn')?.click(); return [...document.querySelectorAll('.sp-pop-item')].map((b) => '+ ' + b.textContent.trim().replace(/…$/, '')); })()`;
const popClose = `(document.querySelector('.sp-pop-search')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })), true)`;
check('row is active', await evalJson(`!!document.querySelector('.frame.edit .sp-tree-row.active')`));
// B: the number rows are the cards' own — Transform's translate x/y/z, then Light's brightness/range,
// each ONCE, with no `light · ` prefix (the card title says whose they are). A light-verb light has no
// Rotate and no scale (a point light has no facing), as it had no yaw.
const numLabels = `[...${insp}.querySelectorAll('.sp-f-num .sp-label')].map((l) => l.textContent)`;
check('number rows are the cards\' own: translate x/y/z, brightness, range — once each, no rotate on a light', await evalJson(`JSON.stringify(${numLabels}) === JSON.stringify(['translate x', 'translate y', 'translate z', 'brightness', 'range'])`), JSON.stringify(await evalJson(numLabels)));
const cardTitles = `[...${insp}.querySelectorAll('.sp-group')].map((g) => g.textContent.slice(2))`;
check('one card per component (a root\'s quiet Parent · none last), then ONE Add Component button (no Channels strip, no Flags group; R 10-04)', await evalJson(`JSON.stringify(${cardTitles}) === JSON.stringify(['Transform', 'Light', 'Parent · none']) && ${insp}.querySelectorAll('.sp-pop-btn').length === 1`), JSON.stringify(await evalJson(cardTitles)));
check('the header carries name + hidden above the cards (Unity\'s name and active box)', await evalJson(`(() => { const rows = [...${insp}.querySelector('.sp-group').closest('.sp-row').parentElement.children]; const first = rows.findIndex((r) => r.querySelector('.sp-group')); const head = rows.slice(0, first).map((r) => r.querySelector('.sp-label')?.textContent).filter(Boolean); return head[0] === 'name' && head.includes('hidden'); })()`));
check('the light group renders from the registry', await evalJson(`[...${insp}.querySelectorAll('.sp-group')].some((g) => /light/i.test(g.textContent)) && !!${insp}.querySelector('input[type=color]')`));
// was "lock / keep / noon toggles" (Flags held locked): in B a lock is a component — "+ Lock" under Add
// Component, a Lock card once added (checked further down) — so the toggles here are hidden, keep, noon
check('hidden / keep lit / noon toggles (locked is not a toggle until a Lock is added)', await evalJson(`(() => { const L = [...${insp}.querySelectorAll('.sp-f-check .sp-label')].map((l) => l.textContent); return L.includes('hidden') && L.includes('keep lit') && L.includes('burns at noon') && !L.includes('locked'); })()`), JSON.stringify(await evalJson(`[...${insp}.querySelectorAll('.sp-f-check .sp-label')].map((l) => l.textContent)`)));
check('compact channels have no bumpers', await evalJson(`${insp}.querySelectorAll('.sp-step.compact .sp-bump').length === 0 && ${insp}.querySelectorAll('.sp-step.compact').length >= 5`));
check('grey scope: the edit frame re-points --brand to the grey', await evalJson(`getComputedStyle(${insp}).getPropertyValue('--brand').trim() === '#d2d2d6'`));

console.log('\nediting through the channel box reaches the light:');
await evalJson(`(() => { const i = [...${insp}.querySelectorAll('.sp-f-num')].find((r) => r.querySelector('.sp-label').textContent === 'brightness').querySelector('.sp-num'); i.value = '+=4'; i.dispatchEvent(new Event('change')); return true; })()`);
check('brightness is 20 on the light', await waitFor(`import('/lib/world.js').then((m) => m.entities.get('benchlamp')?.userData?.lightParams?.intensity === 20)`));
// was "…and the light group agrees (same declaration, two lanes)": the channel strip AND the light
// group each drew brightness. B retired the second lane (one card owns each field), so the same
// behaviour now reads: exactly ONE brightness row, and it shows the committed 20.
check('…and the Light card\'s one brightness row shows 20 (one lane: B drew it twice before)', await waitFor(`(() => { const R = [...${insp}.querySelectorAll('.sp-f-num')].filter((r) => /brightness/.test(r.querySelector('.sp-label').textContent)); return R.length === 1 && R[0].querySelector('.sp-num').value === '20'; })()`), JSON.stringify(await evalJson(`[...${insp}.querySelectorAll('.sp-f-num')].map((r) => r.querySelector('.sp-label').textContent + '=' + r.querySelector('.sp-num').value)`)));
await sleep(1500);   // past EDIT_COMMIT_MS and the echo: a refusal would have rolled it back by now
check('…and it stayed (the verb was accepted, not rolled back)', (await evalJson(`import('/lib/world.js').then((m) => m.entities.get('benchlamp')?.userData?.lightParams?.intensity)`)) === 20);

console.log('\nundo: Ctrl+Z after a light edit restores the fold value:');
await evalJson(`dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyZ', ctrlKey: true, bubbles: true })), true`);
check('brightness back to 16', await waitFor(`import('/lib/world.js').then((m) => m.entities.get('benchlamp')?.userData?.lightParams?.intensity === 16)`));

// early on purpose: headless leaks heap with time (see editworkspace-bench's header), and checks added at the
// end of this long bench ran it into perf-guard's memory floor (10-02)
console.log('\nBuild — Blueprints · Tools · World, and the world entity (design §5, step 5):');
{
  const bf = `document.querySelector('[data-frame="build"]')`;
  const shown = (id: string) => `getComputedStyle(document.querySelector('[data-frame="${id}"]')).display !== 'none'`;
  // the tab memory: the Hierarchy was picked earlier — leaving and pressing B again opens on it
  await evalJson(`import('/lib/build.js').then((m) => (m.setEditMode(false), true))`);
  await waitFor(`document.querySelector('.edit-top').hidden`);
  await evalJson(`dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyB' })), true`);
  check('B again opens on the tab used last (Hierarchy), not Build', await waitFor(`${shown('hierarchy')} && !(${shown('build')}) && document.querySelector('.edit-tab.on')?.dataset.tab === 'hierarchy'`));
  await evalJson(`document.querySelector('.edit-tab[data-tab="build"]').click(), true`);
  check('the Build tab shows Build', await waitFor(`${shown('build')} && !(${shown('hierarchy')})`));
  check('Blueprints: add light, the library search, the starters as picture tiles, and an empty "saved here"', await waitFor(`!!${bf}.querySelector('.sp-text[placeholder^="search the library"]') && ${bf}.querySelectorAll('.sp-tiles-img .sp-tile img').length >= 8 && /none yet/.test(${bf}.textContent) && [...${bf}.querySelectorAll('.sp-btn')].some((b) => /add light/.test(b.textContent))`));
  const tile = (label: string) => `[...${bf}.querySelectorAll('.sp-tile')].find((t) => t.textContent.trim() === '${label}')`;
  check('Tools: select / move / rotate / scale, the six building tools and seat, as tiles', await evalJson(`['select', 'move', 'rotate', 'scale', 'room', 'wall', 'door', 'window', 'floor', 'erase', 'seat'].every((l) => !!([...${bf}.querySelectorAll('.sp-tile')].find((t) => t.textContent.trim() === l)))`));
  check('…the active transform tool reads armed (move)', await waitFor(`${tile('move')}?.classList.contains('on') && !${tile('rotate')}?.classList.contains('on')`));
  await evalJson(`${tile('rotate')}.click(), true`);
  check('a tool tile activates its tool: rotate, the same as E', await waitFor(`globalThis.__editLayout?.().tool === 'rotate' && ${tile('rotate')}?.classList.contains('on') && document.querySelector('.edit-tool[data-tool="rotate"]').classList.contains('on')`));
  await evalJson(`${tile('wall')}.click(), true`);
  check('a building tile arms its tool, and the transform tile stops reading armed (one tool owns the click)', await waitFor(`import('/lib/structure_ui.js').then((m) => m.currentTool() === 'wall') && ${tile('wall')}?.classList.contains('on') && !${tile('rotate')}?.classList.contains('on')`));
  await evalJson(`${tile('move')}.click(), true`);
  check('…and a transform tile puts the building tool down', await waitFor(`import('/lib/structure_ui.js').then((m) => m.currentTool() === null) && globalThis.__editLayout?.().tool === 'move' && ${tile('move')}?.classList.contains('on')`));
  await evalJson(`import('/lib/build.js').then((m) => (m.deselectAll(), true))`);
  check('seat waits for a selection (disabled, saying so)', await waitFor(`(() => { const t = ${tile('seat')}; return !!t && t.disabled && /select a thing first/.test(t.title); })()`), await evalJson(`${tile('seat')}?.title ?? null`));
  await evalJson(`import('/lib/scenegraph.js').then((m) => (m.sceneSelect('benchlamp'), true))`);
  check('…and with a thing selected, says where the sitter goes', await waitFor(`(() => { const t = ${tile('seat')}; return !!t && !t.disabled && /on benchlamp/.test(t.title); })()`), await evalJson(`${tile('seat')}?.title ?? null`));

  // World: the presets come from the defs; a sky pick REPLACES the sky
  check('World: sky presets, ground shapes and tints, plantings + mow, weathers', await waitFor(`['golden', 'dusk', 'hills', 'rugged', 'arid', 'meadow', 'tufts', 'mow', 'rain', 'storm'].every((l) => !!([...${bf}.querySelectorAll('.sp-tile')].find((t) => t.textContent.trim() === l)))`), await evalJson(`[...${bf}.querySelectorAll('.sp-tile')].map((t) => t.textContent.trim()).join(',')`));
  await evalJson(`import('/lib/net.js').then((m) => (m.sendVerb('sky', { hours: 3, rate: 6, exposure: 0.6, fog: 2, clouds: 'stratus' }), true))`);
  check('(a hand-authored sky with a rate, exposure and fog folds)', await waitFor(`import('/lib/state.js').then((m) => m.state.st.sky?.exposure === 0.6)`));
  await evalJson(`import('/lib/net.js').then((m) => (m.sendVerb('weather', { weather: 'rain' }), true))`);
  await waitFor(`import('/lib/state.js').then((m) => m.state.st.sky?.weather === 'rain')`);
  await evalJson(`${tile('golden')}.click(), true`);
  const golden = await evalJson(`fetch('/defs/sky/_presets.json').then((r) => r.ok ? r.json() : null).then((p) => p?.golden ?? null).catch(() => null)`);
  check('a Sky pick REPLACES the sky: the preset\'s hours and clouds, no rate / exposure / fog left over', await waitFor(`import('/lib/state.js').then((m) => { const s = m.state.st.sky; return s?.hours === 17.6 && s.clouds === 'cumulus' && !('rate' in s) && !('exposure' in s) && !('fog' in s); })`),
    await evalJson(`import('/lib/state.js').then((m) => JSON.stringify(m.state.st.sky))`) + ` (preset ${JSON.stringify(golden)})`);
  check('…the weather (another component) stays', await evalJson(`import('/lib/state.js').then((m) => m.state.st.sky?.weather === 'rain')`));
  check('…and the golden tile reads armed', await waitFor(`${tile('golden')}?.classList.contains('on') && ${tile('rain')}?.classList.contains('on')`));
  // the ground and grass picks are worldentity-test's: a terrain mesh is a cost this headless renderer need not pay

  // the world entity in the Inspector
  await evalJson(`${bf}.querySelector('.sp-item[data-id="@world"] .sp-item-main')?.click(), true`);
  const cards = `[...${insp}.querySelectorAll('.sp-group')].map((g) => g.textContent.slice(2))`;
  check('the World row selects @world: the Inspector shows its four cards', await waitFor(`(() => { const t = ${cards}; return t[0] === 'Sky' && t[1] === 'Weather' && t[2] === 'Ground · default' && t[3] === 'Grass · default' && t.length === 4; })()`), JSON.stringify(await evalJson(cards)));
  check('…headed by its name, with @world as its id (R 10-04)', await evalJson(`(() => { const rows = [...${insp}.querySelectorAll('.sp-row')].map((r) => [r.querySelector('.sp-label')?.textContent, r.querySelector('.sp-info')?.textContent]); return rows[0]?.[0] === 'name' && rows[1]?.[0] === 'id' && rows[1]?.[1] === '@world'; })()`));
  check('…and the World row reads active (the thing selection cleared)', await evalJson(`!!${bf}.querySelector('.sp-item.active') && globalThis.__editPanels?.().worldSel === true && globalThis.__editPanels?.().selected == null`));
  const hoursIn = `[...${insp}.querySelectorAll('.sp-f-num')].find((r) => r.querySelector('.sp-label')?.textContent === 'time of day')?.querySelector('.sp-num')`;
  check('the Sky card shows the preset\'s hour', await evalJson(`(() => { const i = ${hoursIn}; return !!i && Math.abs(parseFloat(i.value) - 17.6) < 0.05; })()`), await evalJson(`${hoursIn}?.value ?? null`));
  await evalJson(`(() => { const i = ${hoursIn}; if (!i) return false; i.value = '6'; i.dispatchEvent(new Event('change')); return true; })()`);
  check('typing an hour in the Sky card commits it through the sky verb, keeping the rest', await waitFor(`import('/lib/state.js').then((m) => m.state.st.sky?.hours === 6 && m.state.st.sky.clouds === 'cumulus' && m.state.st.sky.weather === 'rain')`), await evalJson(`import('/lib/state.js').then((m) => JSON.stringify(m.state.st.sky))`));
  await evalJson(`import('/lib/build.js').then((m) => (m.undo(), true))`);
  check('…one Ctrl+Z puts the hour back', await waitFor(`import('/lib/state.js').then((m) => m.state.st.sky?.hours === 17.6)`), await evalJson(`import('/lib/state.js').then((m) => JSON.stringify(m.state.st.sky))`));
  // the VR quad paints the same declarations (panels-schema path, edit chrome)
  const vr = await evalJson(`import('/lib/panels.js').then((m) => { const P = globalThis.__editPanels(); const c = document.createElement('canvas'); const B = m.renderCanvas(c, P.buildVRFields(), { theme: 'edit' }); const I = m.renderCanvas(document.createElement('canvas'), P.inspFields(), { theme: 'edit' }); return { sky: B.some((r) => r.action === 'wsky' && r.payload === 'golden'), place: B.some((r) => r.action === 'place'), world: B.some((r) => r.action === 'wsel'), noTools: !B.some((r) => r.action === 'ttool' || r.action === 'stool'), hours: I.some((r) => r.action === 'ed:sky.hours'), wx: I.some((r) => String(r.action).startsWith('ed:weather.state')) }; })`);
  check('the VR quad paints Build (a sky tile, the library, the World row; the desktop-only tools named, not drawn) and @world\'s cards', vr && Object.values(vr).every(Boolean), JSON.stringify(vr));
  // selecting a thing again leaves the world
  await evalJson(`import('/lib/scenegraph.js').then((m) => (m.sceneSelect('benchlamp'), true))`);
  check('selecting a thing clears @world from the Inspector', await waitFor(`globalThis.__editPanels?.().worldSel === false && !/@world — the world entity/.test(${insp}.textContent)`));
  // as the next section expects: the Hierarchy page up, benchlamp in the Inspector
  await evalJson(`document.querySelector('.edit-tab[data-tab="hierarchy"]').click(), true`);
  await waitFor(`${shown('hierarchy')} && ${insp}.querySelector('.sp-info')?.textContent === 'benchlamp'`);
}

// step 6b: a blueprint from the store, placed as a copy from Build › Blueprints — the ghost, the click, the tree
// it spawns, the link, the Hierarchy saying so, one Ctrl+Z; the VR body's place-ahead; a big copy paced
console.log('\nBlueprints — placing a copy (design §3, step 6b):');
{
  const { blueprintHash } = await import('../shared/blueprint.js');
  const bf = `document.querySelector('[data-frame="build"]')`;
  const lib = await evalJson(`import('/lib/palette.js').then((m) => m.starterModels()[0]?.path ?? null)`);
  const rec: any = { kind: 'eido.blueprint', v: 1, name: 'Bench lamp', root: { components: [
    { type: 'Transform', params: {} }, { type: 'Model', params: { lib } }, { type: 'Label', key: 'label', params: { text: 'bench lamp' } },
  ], children: [
    // a keyless Light: a part saved from a legacy kind:"light" entity — placed as comp.light (owner, 10-02)
    { id: 'bulb', components: [{ type: 'Transform', params: { pos: [0, 1.2, 0], yaw: 0 } }, { type: 'Light', params: { color: 0xffffff, intensity: 4, range: 3 } }], children: [] },
  ] } };
  const H = blueprintHash(rec);
  await evalJson(`import('/lib/net.js').then((m) => (m.sendVerb('blueprint', { hash: '${H}', record: ${JSON.stringify(rec)} }), true))`);
  const bpTile = `${bf}.querySelector('.sp-tile[data-v="${H}"]')`;
  check('a published blueprint appears under "saved here" as a tile, with its version', await waitFor(`!!${bpTile} && /Bench lamp v1/.test(${bpTile}.textContent) && /1 blueprint in this world/.test(${bf}.textContent)`), await evalJson(`${bf}.textContent.slice(0, 400)`));
  await evalJson(`(${bpTile}.click(), true)`);
  check('picking it carries a copy as the ghost (edit mode, the whole tree)', await waitFor(`import('/lib/build.js').then((m) => m.hasGhost() && m.isEditing())`));
  const before = await evalJson(`import('/lib/state.js').then((m) => Object.keys(m.state.st.entities).length)`);
  await evalJson(`import('/lib/core.js').then((m) => (m.canvas.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: innerWidth / 2, clientY: innerHeight * 0.7 })), true))`);
  const rootQ = `Object.entries(m.state.st.entities).find(([, e]) => e.comp?.blueprint?.hash === '${H}')?.[0]`;
  check('a click places it: the root holds the link {hash, name}', await waitFor(`import('/lib/state.js').then((m) => { const r = ${rootQ}; const e = r && m.state.st.entities[r]; return !!e && e.lib === ${JSON.stringify(lib)} && e.comp.blueprint.name === 'Bench lamp' && e.comp.label === 'bench lamp'; })`, 8000));
  const root = await evalJson(`import('/lib/state.js').then((m) => ${rootQ} ?? null)`);
  check('…the bulb rides it at its local pose, an Empty with comp.light (not the light verb), marked as part "bulb"', await waitFor(`import('/lib/state.js').then((m) => { const b = m.state.st.entities['${root}-bulb']; return !!b && b.parent?.to === '${root}' && JSON.stringify(b.parent.offset) === '[0,1.2,0]' && b.kind == null && b.lib == null && b.comp?.light?.intensity === 4 && b.comp?.blueprint?.part === 'bulb'; })`), await evalJson(`import('/lib/state.js').then((m) => JSON.stringify(m.state.st.entities['${root}-bulb'] ?? null))`));
  check('…the ghost is put down', await evalJson(`import('/lib/build.js').then((m) => !m.hasGhost())`));
  check('read back in the page: the copy is its record (no overrides)', await evalJson(`Promise.all([import('/lib/state.js'), import('/shared/blueprint.js')]).then(([s, b]) => { const t = b.copyTree(s.state.st.entities, '${root}', s.state.st.blueprints['${H}'].record); return !!t && b.overridesOf(t.tree, s.state.st.blueprints['${H}'].record).length === 0 && t.parts.bulb === '${root}-bulb'; })`));
  check('the Hierarchy marks the copy and its part', await waitFor(`(() => { const t = document.querySelector('[data-frame="hierarchy"]').textContent; return t.includes('Bench lamp copy') && t.includes('part bulb'); })()`), await evalJson(`document.querySelector('[data-frame="hierarchy"]').textContent.slice(0, 300)`));
  check('the tile says a copy is placed', await waitFor(`/1 copy placed/.test(${bpTile}?.title ?? '')`), await evalJson(`${bpTile}?.title ?? null`));
  await evalJson(`import('/lib/build.js').then((m) => (m.undo(), true))`);
  check('ONE Ctrl+Z takes the whole copy away', await waitFor(`import('/lib/state.js').then((m) => !m.state.st.entities['${root}'] && !m.state.st.entities['${root}-bulb'] && Object.keys(m.state.st.entities).length === ${before})`, 8000));
  // the VR body: the tile is painted, and a pick places a copy 1.5 m ahead
  const vrbp = await evalJson(`import('/lib/panels.js').then((m) => m.renderCanvas(document.createElement('canvas'), globalThis.__editPanels().buildVRFields(), { theme: 'edit' }).some((r) => r.action === 'bp' && r.payload === '${H}'))`);
  check('the VR quad paints the saved blueprint', vrbp === true);
  await evalJson(`(globalThis.__editPanels().buildVRDo('bp', '${H}'), true)`);
  check('a VR pick places a copy ahead of you (no ghost to carry)', await waitFor(`import('/lib/state.js').then((m) => { const r = ${rootQ}; return !!r && !!m.state.st.entities[r + '-bulb']?.parent; })`, 8000));
  await evalJson(`import('/lib/build.js').then((m) => (m.undo(), true))`);
  check('…and one undo takes it away', await waitFor(`import('/lib/state.js').then((m) => !(${rootQ}))`, 8000));
  // a copy of 7 parts is ~30 verbs: more than the door lets through at once — the run is paced, and all of it lands
  const big: any = { kind: 'eido.blueprint', v: 1, name: 'Bench row', root: { components: [{ type: 'Transform', params: {} }, { type: 'Model', params: { lib } }],
    children: Array.from({ length: 6 }, (_, i) => ({ id: `post${i}`, components: [{ type: 'Transform', params: { pos: [i * 0.6 - 1.5, 0, 0] } }, { type: 'Model', params: { lib } }, { type: 'Label', key: 'label', params: { text: `post ${i}` } }], children: [] })) } };
  const HB = blueprintHash(big);
  await evalJson(`import('/lib/net.js').then((m) => (m.sendVerb('blueprint', { hash: '${HB}', record: ${JSON.stringify(big)} }), true))`);
  await waitFor(`import('/lib/state.js').then((m) => !!m.state.st.blueprints?.['${HB}'])`);
  const paced = await evalJson(`Promise.all([import('/lib/build.js'), import('/lib/state.js'), import('/lib/net.js')]).then(([b, s, n]) => { const p = b.placeBlueprint('${HB}', s.state.st.blueprints['${HB}'].record, { id: 'row1', pos: [4, 0, -4], yaw: 0 }); return { verbs: p?.verbs.length, pending: n.verbPace().pending }; })`);
  check(`a big copy is paced: ${paced?.verbs} verbs, ${paced?.pending} waiting at once`, paced?.verbs > 20 && paced?.pending > 0, JSON.stringify(paced));
  check('…and every part lands, mounted, in order', await waitFor(`import('/lib/state.js').then((m) => [0, 1, 2, 3, 4, 5].every((i) => m.state.st.entities['row1-post' + i]?.parent?.to === 'row1' && m.state.st.entities['row1-post' + i]?.comp?.blueprint?.part === 'post' + i))`, 25000));
  check('…with nothing refused on the way', await evalJson(`!(window.__refused ?? []).some((e) => /slow down|row1/.test(e))`), JSON.stringify(await evalJson(`window.__refused`)));
  await evalJson(`import('/lib/build.js').then((m) => (m.undo(), true))`);
  check('…and its undo (7 removes, paced behind it) takes all of it away', await waitFor(`import('/lib/state.js').then((m) => !Object.keys(m.state.st.entities).some((k) => k.startsWith('row1')))`, 15000));
  // as the next section expects: the Hierarchy page up, benchlamp in the Inspector
  await evalJson(`import('/lib/scenegraph.js').then((m) => (m.sceneSelect('benchlamp'), true))`);
  await waitFor(`${insp}.querySelector('.sp-info')?.textContent === 'benchlamp'`);
}

console.log('\na no-op scrub on one thing must not leak its pose into the next selection:');
{
  const inpX = `[...${insp}.querySelectorAll('.sp-f-num')].find((r) => r.querySelector('.sp-label').textContent === 'translate x').querySelector('.sp-num')`;
  const pe = (t: string, x: number, extra = '') => `new PointerEvent('${t}', { clientX: ${x}, clientY: 0, button: 0, pointerId: 9, bubbles: true, isPrimary: true${extra} })`;
  // ctrl-scrub a few px and release: rounds back to the start value (a live call AT the start pose)
  await evalJson(`(() => { const i = ${inpX}; i.dispatchEvent(${pe('pointerdown', 100)}); i.dispatchEvent(${pe('pointermove', 108, ', ctrlKey: true')}); i.dispatchEvent(${pe('pointerup', 108, ', ctrlKey: true')}); return true; })()`);
  await evalJson(`import('/lib/net.js').then((m) => m.sendVerb('light', { id: 'lamp2', pos: [5, 1, 5], color: 0xffd9a0, intensity: 8, range: 6 })), true`);
  await waitFor(`import('/lib/world.js').then((m) => !!m.entities.get('lamp2'))`);
  await evalJson(`import('/lib/scenegraph.js').then((m) => m.sceneSelect('lamp2')), true`);
  await waitFor(`${insp}.querySelector('.sp-info')?.textContent === 'lamp2'`);
  await evalJson(`(() => { const i = ${inpX}; i.dispatchEvent(${pe('pointerdown', 100)}); i.dispatchEvent(${pe('pointermove', 150)}); i.dispatchEvent(${pe('pointerup', 150)}); return true; })()`);
  check('lamp2 moved by +1 on x from ITS OWN pose (6,1,5), not benchlamp\'s', await waitFor(`import('/lib/world.js').then((m) => { const p = m.entities.get('lamp2')?.position; return p && Math.abs(p.x - 6) < 0.01 && Math.abs(p.z - 5) < 0.01; })`), await evalJson(`import('/lib/world.js').then((m) => m.entities.get('lamp2')?.position.toArray().map((v) => +v.toFixed(2)))`));
  await evalJson(`import('/lib/scenegraph.js').then((m) => m.sceneSelect('benchlamp')), true`);
  await waitFor(`${insp}.querySelector('.sp-info')?.textContent === 'benchlamp'`);
}

console.log('\nstandard keys and the hierarchy context menu:');
await evalJson(`dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyR', bubbles: true })), true`);
check('R → scale tool (Maya\'s R; S walks)', await evalJson(`globalThis.__editLayout?.().tool === 'scale'`));
await evalJson(`dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyE', bubbles: true })), true`);
check('E → rotate tool', await evalJson(`globalThis.__editLayout?.().tool === 'rotate'`));
await evalJson(`dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyG', bubbles: true })), true`);
check('G → move tool', await evalJson(`globalThis.__editLayout?.().tool === 'move'`));
await evalJson(`dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyW', bubbles: true })), true`);
check('W is still walking — no tool change', await evalJson(`globalThis.__editLayout?.().tool === 'move'`));
// …and LET GO of W. A keydown with no keyup is a key held for the rest of the run: the avatar walked off
// (W here, D after Alt+D below) at ~1.5 m/s, new ground streamed into view, ~20 shader builds a second were
// retained, and the renderer hit V8's heap limit near the filter section (traced 10-01: the same OOM on
// this bench at d7f382c, before components-B — a bench bug, not the editor's)
await evalJson(`dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyW' })), true`);
check('tool buttons show their letters', await evalJson(`[...document.querySelectorAll('.edit-tool-key')].map((k) => k.textContent).join('') === 'QGERP'`));   // P: the pivot tool (R 10-04)
check('hierarchy has no button row', await evalJson(`document.querySelector('.edit-left [data-frame="hierarchy"] .sp-btn') === null`));
await evalJson(`(() => { const row = [...document.querySelectorAll('.edit-left .sp-tree-row')].find((r) => /lamp2/.test(r.textContent)); row.dispatchEvent(new MouseEvent('contextmenu', { clientX: 120, clientY: 130, bubbles: true, cancelable: true })); return true; })()`);
check('right-click opens the row menu with find / parent to / lock / remove', await evalJson(`(() => { const m = document.querySelector('.sp-ctx'); const T = m ? [...m.querySelectorAll('.sp-ctx-item')].map((i) => i.textContent) : []; return T.some((t) => /find/.test(t)) && T.some((t) => /parent to/.test(t)) && T.some((t) => /lock/.test(t)) && T.some((t) => /remove/.test(t)); })()`));
await evalJson(`[...document.querySelectorAll('.sp-ctx-item')].find((i) => /remove/.test(i.textContent)).click(), true`);
check('menu → remove takes lamp2 out of the world', await waitFor(`import('/lib/world.js').then((m) => !m.entities.has('lamp2'))`));
check('…and the menu is gone', await evalJson(`document.querySelector('.sp-ctx') === null`));
check('∃ and the wrench are VISIBLE on the band (elementFromPoint, not a class)', await evalJson(`(() => { const hit = (el) => { const r = el.getBoundingClientRect(); const e = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return e === el || el.contains(e); }; return hit(document.querySelector('#hud')) && hit(document.querySelector('#dock button[data-toggles="edit"]')); })()`));
check('rim is gone; the wrench wears the amber box', await evalJson(`(() => { const w = document.querySelector('#dock button[data-toggles="edit"]'); return w && w.classList.contains('on') && getComputedStyle(w).boxShadow !== 'none' && getComputedStyle(document.body, '::after').content !== '""'; })()`));

// the corner, the wrench's way out, and the Create panel have their own browser: tools/editworkspace-bench.ts
// (this bench is long enough already — headless leaks heap with time, so a longer run here OOMs the renderer)
await evalJson(`import('/lib/scenegraph.js').then((m) => m.sceneSelect('benchlamp')), true`);
await waitFor(`${insp}.querySelector('.sp-info')?.textContent === 'benchlamp'`);

console.log('\nEsc mid-scrub, in a real browser (the key lands on the document, not the blurred input):');
{
  const pe = (t: string, x: number) => `new PointerEvent('${t}', { clientX: ${x}, clientY: 0, button: 0, pointerId: 7, bubbles: true, isPrimary: true })`;
  const inp = `[...${insp}.querySelectorAll('.sp-f-num')].find((r) => r.querySelector('.sp-label').textContent === 'range').querySelector('.sp-num')`;
  await evalJson(`(() => { const i = ${inp}; i.dispatchEvent(${pe('pointerdown', 100)}); i.dispatchEvent(${pe('pointermove', 130)}); i.dispatchEvent(${pe('pointermove', 160)}); return true; })()`);
  check('scrub previews (range 10 → 22 on the face)', await evalJson(`${inp}.value === '22'`), await evalJson(`${inp}.value`));
  check('…and the input is not focused while scrubbing', await evalJson(`document.activeElement !== ${inp}`));
  await evalJson(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })), true`);
  // a live coalesced commit may already have gone out mid-scrub; the Esc sends
  // the start value back through the same coalescer, so the restore is on the
  // WIRE one pacing interval later — wait for the face AND the fold
  check('Esc restores the face — and the fold, if a live commit had already gone out', await waitFor(`${inp}.value === '10' && import('/lib/state.js').then((m) => m.state.st.entities.benchlamp.range === 10)`, 4000), 'face=' + await evalJson(`${inp}.value`) + ' channels=' + JSON.stringify(await evalJson(`[...${insp}.querySelectorAll('.sp-f-num')].map((r) => r.querySelector('.sp-label').textContent + '=' + r.querySelector('.sp-num').value)`)) + ' fold=' + JSON.stringify(await evalJson(`import('/lib/state.js').then((m) => { const e = m.state.st.entities.benchlamp; return { intensity: e?.intensity, range: e?.range }; })`)));
  await evalJson(`${inp}.dispatchEvent(${pe('pointerup', 160)}), true`);
  await sleep(700);
  check('…and the light never left 10 (nothing committed)', (await evalJson(`import('/lib/world.js').then((m) => m.entities.get('benchlamp')?.userData?.lightParams?.range)`)) === 10);
}

console.log('\nmotion: a bob on the light — a Bob card, driven channels, an edit that keeps t0:');
await evalJson(`import('/lib/net.js').then((m) => m.sendVerb('motion', { id: 'benchlamp', type: 'bob', amp: 0.3, period: 2 })), true`);
// B: the motion's type IS the card ("Bob"), not a type dropdown inside a Motion group — changing it is
// remove + add — so the check reads the card title and its own fields (axis / amp / period / phase)
check('a Bob card renders from motion.js (the type is the card, not a dropdown)', await waitFor(`(() => { const T = ${cardTitles}; const L = ${numLabels}; return T.includes('Bob') && !T.some((t) => /^motion/i.test(t)) && L.includes('amp') && L.includes('period') && ![...${insp}.querySelectorAll('select.sp-enum')].some((s) => s.value === 'bob'); })()`), JSON.stringify(await evalJson(cardTitles)));
check('pos channels are DRIVEN (rest pose, marked)', await evalJson(`${insp}.querySelectorAll('.sp-f-num.driven').length >= 3`));
{
  // axis AND driven at once (R, 09-30): the label keeps x/y/z; the FIELD wears the amber edge and a ~
  const look = await evalJson(`(() => { const o = {}; const rows = [...${insp}.querySelectorAll('.sp-f-num.driven')]; for (const ax of ['x', 'y', 'z']) { const r = rows.find((q) => q.dataset.axis === ax); if (!r) { o[ax] = null; continue; } o[ax] = { label: getComputedStyle(r.querySelector('.sp-label')).color, edge: getComputedStyle(r.querySelector('.sp-num')).borderTopColor, mark: r.querySelector('.sp-drv')?.textContent ?? null, title: r.title }; } return o; })()`);
  const L = look as any;
  check('driven pos x / y / z labels keep their AXIS colours', L.x?.label === 'rgb(224, 106, 98)' && L.y?.label === 'rgb(130, 196, 94)' && L.z?.label === 'rgb(95, 149, 232)', JSON.stringify(L));
  check('…the field carries driven: amber edge + a ~ marker', ['x', 'y', 'z'].every((a) => L[a]?.edge === 'rgba(201, 162, 74, 0.45)' && L[a]?.mark === '~'), JSON.stringify(L));
  check('…titled "driven by motion — editing moves its rest pose"', ['x', 'y', 'z'].every((a) => L[a]?.title === 'driven by motion — editing moves its rest pose'), JSON.stringify(L.x?.title));
}
check('amp / period are the Bob card\'s rows, once each (no "motion · " lane)', await evalJson(`(() => { const L = ${numLabels}; return L.filter((l) => l === 'amp').length === 1 && L.filter((l) => l === 'period').length === 1 && !L.some((l) => /^motion · /.test(l)); })()`), JSON.stringify(await evalJson(numLabels)));
const t0 = await evalJson(`import('/lib/world.js').then((m) => m.comps.get('benchlamp')?.motion?.t0)`);
check('the fold stamped a t0', typeof t0 === 'number' && t0 > 0, String(t0));
await evalJson(`(() => { const i = [...${insp}.querySelectorAll('.sp-f-num')].find((r) => r.querySelector('.sp-label').textContent === 'amp').querySelector('.sp-num'); i.value = '+=0.2'; i.dispatchEvent(new Event('change')); return true; })()`);
check('amp is 0.5 after +=0.2', await waitFor(`import('/lib/world.js').then((m) => Math.abs((m.comps.get('benchlamp')?.motion?.amp ?? 0) - 0.5) < 1e-9)`));
check('…and t0 was kept (no phase restart)', (await evalJson(`import('/lib/world.js').then((m) => m.comps.get('benchlamp')?.motion?.t0)`)) === t0);
// was the Motion group's "come to rest" button; B's card carries its own remove (the same verb: motion type null)
await evalJson(`(() => { const b = [...${insp}.querySelectorAll('.sp-btn')].find((x) => x.textContent === 'remove Bob'); b.dispatchEvent(new PointerEvent('pointerdown', { clientX: 1, clientY: 1, bubbles: true })); b.click(); return true; })()`);
check('the Bob card\'s "remove Bob" removes the motion', await waitFor(`import('/lib/world.js').then((m) => !m.comps.get('benchlamp')?.motion)`));

console.log('\nsockets: a seat on the light — a Seats card, list, per-slot channels, ✕ through the merged write:');
await evalJson(`import('/lib/net.js').then((m) => m.sendVerb('comp', { id: 'benchlamp', type: 'sockets', data: { seat: { pos: [0, 0.5, 0], yaw: 0 } } })), true`);
check('a Seats card with the seat row', await waitFor(`${cardTitles}.includes('Seats') && [...${insp}.querySelectorAll('.sp-item-label')].some((l) => l.textContent === 'seat')`), JSON.stringify(await evalJson(cardTitles)));
check('seat x/y/z/yaw are the Seats card\'s rows, once each (no "sockets · " lane)', await evalJson(`(() => { const L = ${numLabels}; return ['seat x', 'seat y', 'seat z', 'seat yaw'].every((n) => L.filter((l) => l === n).length === 1) && !L.some((l) => /^sockets · /.test(l)); })()`), JSON.stringify(await evalJson(numLabels)));
await evalJson(`import('/lib/net.js').then((m) => m.sendVerb('motion', { id: 'benchlamp', type: 'spin', degPerSec: 30 })), true`);
await waitFor(`${cardTitles}.includes('Spin')`);
if (process.env.EDIT_SHOT) {   // a look, not a trust: the grey scope is a design claim
  const shot = await cdp.send<any>('Page.captureScreenshot', { format: 'png' });
  await Bun.write(process.env.EDIT_SHOT, Buffer.from(shot.data, 'base64'));
  console.log(`  screenshot → ${process.env.EDIT_SHOT}`);
}
await evalJson(`(() => { const i = [...${insp}.querySelectorAll('.sp-f-num')].find((r) => r.querySelector('.sp-label').textContent === 'seat yaw').querySelector('.sp-num'); i.value = '90'; i.dispatchEvent(new Event('change')); return true; })()`);
check('typing 90 into a degree channel lands as π/2 in the fold (not π/2/57)', await waitFor(`import('/lib/world.js').then((m) => Math.abs((m.comps.get('benchlamp')?.sockets?.seat?.yaw ?? 0) - Math.PI / 2) < 1e-3)`), 'yaw=' + JSON.stringify(await evalJson(`import('/lib/world.js').then((m) => m.comps.get('benchlamp')?.sockets?.seat?.yaw)`)));
check('no raw-JSON row for a type an editor speaks for', await evalJson(`![...${insp}.querySelectorAll('.sp-f-text .sp-label')].some((l) => /^(sockets|motion)$/.test(l.textContent))`));
// a settle before the ✕: the bench fires verbs faster than a person, and the
// server's VERB_RATE window (12 per 4 s) is the one thing that can make this
// click do nothing with no error in the page — the detail prints refusals
await sleep(1500);
await evalJson(`(() => { const b = [...${insp}.querySelectorAll('.sp-mini.danger')].find((x) => x.textContent === '✕'); b.dispatchEvent(new PointerEvent('pointerdown', { clientX: 1, clientY: 1, bubbles: true })); b.click(); return true; })()`);
check('✕ removes the only seat → sockets comp gone', await waitFor(`import('/lib/world.js').then((m) => !m.comps.get('benchlamp')?.sockets)`), 'sockets=' + JSON.stringify(await evalJson(`import('/lib/world.js').then((m) => m.comps.get('benchlamp')?.sockets)`)) + ' refused=' + JSON.stringify(await evalJson(`window.__refused`)));

console.log('\nhierarchy: label · hidden · filter · disclosure · duplicate · arrows:');
await sleep(1500);   // settle: the verb-rate window (see the ✕ note above)
const hier = `[...document.querySelectorAll('.frame.edit')].find((f) => /Hierarchy/.test(f.querySelector('.fr-title')?.textContent))`;
await evalJson(`(() => { const i = [...${insp}.querySelectorAll('.sp-f-text')].find((r) => r.querySelector('.sp-label')?.textContent === 'name').querySelector('.sp-text'); i.value = 'porch'; i.dispatchEvent(new Event('change')); return true; })()`);
check('label typed in the header → the hierarchy row shows it', await waitFor(`[...${hier}.querySelectorAll('.sp-tree-row .sp-item-label')].some((l) => l.textContent === 'porch  (benchlamp)')`), 'rows=' + await evalJson(`[...${hier}.querySelectorAll('.sp-tree-row .sp-item-label')].map((l) => l.textContent).join('|')`) + ' label-comp=' + JSON.stringify(await evalJson(`import('/lib/world.js').then((m) => m.comps.get('benchlamp')?.label)`)) + ' refused=' + JSON.stringify(await evalJson(`window.__refused`)));
await evalJson(`(() => { const c = [...${insp}.querySelectorAll('.sp-f-check')].find((r) => r.querySelector('.sp-label')?.textContent === 'hidden').querySelector('input'); c.checked = true; c.dispatchEvent(new Event('change')); return true; })()`);
check('hidden checkbox → the mesh is not drawn (obj.visible false, still in the fold)', await waitFor(`import('/lib/world.js').then((m) => m.entities.get('benchlamp')?.visible === false && !!m.comps.get('benchlamp')?.hidden)`));
await evalJson(`(() => { const c = [...${insp}.querySelectorAll('.sp-f-check')].find((r) => r.querySelector('.sp-label')?.textContent === 'hidden').querySelector('input'); c.checked = false; c.dispatchEvent(new Event('change')); return true; })()`);
check('…and back', await waitFor(`import('/lib/world.js').then((m) => m.entities.get('benchlamp')?.visible === true)`));
await evalJson(`import('/lib/net.js').then((m) => m.sendVerb('light', { id: 'lamp3', pos: [1, 1.5, 1], color: 0xffffff, intensity: 4, range: 3 })), true`);
await waitFor(`import('/lib/world.js').then((m) => !!m.entities.get('lamp3'))`);
await evalJson(`import('/lib/net.js').then((m) => m.sendVerb('mount', { id: 'lamp3', to: 'benchlamp', offset: [0, 0.5, 0] })), true`);
check('a mounted light indents under its carrier', await waitFor(`(() => { const R = [...${hier}.querySelectorAll('.sp-tree-row')]; const r = R.find((x) => /lamp3/.test(x.querySelector('.sp-item-label').textContent)); return !!r && parseInt(r.style.paddingLeft) > 10; })()`), 'parent=' + JSON.stringify(await evalJson(`import('/lib/state.js').then((m) => m.state.st.entities.lamp3?.parent)`)) + ' mountedTo=' + JSON.stringify(await evalJson(`import('/lib/world.js').then((m) => m.entities.get('lamp3')?.userData?.mountedTo)`)) + ' refused=' + JSON.stringify(await evalJson(`window.__refused`)));
await evalJson(`(() => { const R = [...${hier}.querySelectorAll('.sp-tree-row')]; const r = R.find((x) => /benchlamp/.test(x.querySelector('.sp-item-label').textContent)); r.querySelector('.sp-disc').click(); return true; })()`);
check('disclosure folds the carrier: lamp3 row gone', await waitFor(`![...${hier}.querySelectorAll('.sp-tree-row .sp-item-label')].some((l) => /lamp3/.test(l.textContent))`));
await evalJson(`(() => { const R = [...${hier}.querySelectorAll('.sp-tree-row')]; const r = R.find((x) => /benchlamp/.test(x.querySelector('.sp-item-label').textContent)); r.querySelector('.sp-disc').click(); return true; })()`);
check('…and unfolds', await waitFor(`[...${hier}.querySelectorAll('.sp-tree-row .sp-item-label')].some((l) => /lamp3/.test(l.textContent))`));
await evalJson(`(() => { const i = ${hier}.querySelector('.sp-f-text .sp-text'); i.value = 'zzz-nothing'; i.dispatchEvent(new Event('change')); return true; })()`);
check('a filter with no match empties the tree and says so', await waitFor(`${hier}.querySelectorAll('.sp-tree-row').length === 0 && /nothing matches/.test(${hier}.querySelector('.sp-empty')?.textContent ?? '')`));
await evalJson(`(() => { const i = ${hier}.querySelector('.sp-f-text .sp-text'); i.value = 'lamp3'; i.dispatchEvent(new Event('change')); return true; })()`);
check('a match keeps its ancestor (dimmed) and itself', await waitFor(`(() => { const R = [...${hier}.querySelectorAll('.sp-tree-row')]; return R.length === 2 && R[0].classList.contains('dim') && /lamp3/.test(R[1].textContent) && !R[1].classList.contains('dim'); })()`), await evalJson(`[...${hier}.querySelectorAll('.sp-tree-row')].map((r) => r.className + ':' + r.querySelector('.sp-item-label').textContent).join('|')`));
await evalJson(`(() => { const i = ${hier}.querySelector('.sp-f-text .sp-text'); i.value = ''; i.dispatchEvent(new Event('change')); return true; })()`);
await waitFor(`${hier}.querySelectorAll('.sp-tree-row').length >= 2`);
await evalJson(`import('/lib/scenegraph.js').then((m) => m.sceneSelect('benchlamp')), true`);
await waitFor(`${insp}.querySelector('.sp-info')?.textContent.startsWith('benchlamp')`);
await evalJson(`(() => { const s = ${hier}.querySelector('.schema-scroll'); s.focus(); s.dispatchEvent(new KeyboardEvent('keydown', { code: 'ArrowDown', bubbles: true, cancelable: true })); return true; })()`);
await evalJson(`import('/lib/scenegraph.js').then((m) => m.sceneSelect('benchlamp')), true`);
await waitFor(`import('/lib/scenegraph.js').then((m) => m.sceneSelected() === 'benchlamp')`);
await evalJson(`(() => { const s = ${hier}.querySelector('.schema-scroll'); s.focus(); s.dispatchEvent(new KeyboardEvent('keydown', { code: 'ArrowDown', bubbles: true, cancelable: true })); return true; })()`);
check('↓ in the focused tree selects the next row (lamp3)', await waitFor(`import('/lib/scenegraph.js').then((m) => m.sceneSelected() === 'lamp3')`), 'sel=' + JSON.stringify(await evalJson(`import('/lib/scenegraph.js').then((m) => m.sceneSelected())`)) + ' rows=' + JSON.stringify(await evalJson(`globalThis.__editPanels?.().rows`)) + ' focus=' + JSON.stringify(await evalJson(`document.activeElement?.className`)) + ' inFrame=' + JSON.stringify(await evalJson(`${hier}.contains(${hier}.querySelector('.schema-scroll'))`)));
check('…and the keystroke never reached the walking keys (positive control: W did)', (await evalJson(`window.__keys.includes('KeyW')`)) && !(await evalJson(`window.__keys.includes('ArrowDown')`)), 'keys=' + JSON.stringify(await evalJson(`window.__keys.slice(-5)`)));
await evalJson(`(() => { const s = ${hier}.querySelector('.schema-scroll'); s.focus(); s.dispatchEvent(new KeyboardEvent('keydown', { code: 'ArrowUp', bubbles: true, cancelable: true })); return true; })()`);
check('↑ selects the previous', await waitFor(`import('/lib/scenegraph.js').then((m) => m.sceneSelected() === 'benchlamp')`));
await evalJson(`dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyD', altKey: true, bubbles: true })), true`);
await evalJson(`dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyD', altKey: true, bubbles: true })), true`);   // let go (see the W note: a held D strafes)
check('Alt+D duplicates: a new light carrying the SOURCE\'s components (minus lock), nudged', await waitFor(`import('/lib/world.js').then((m) => { const id = [...m.entities.keys()].find((k) => /^benchlamp~[0-9a-f]{4}$/.test(k)); const o = m.entities.get(id); if (!o) return false; const strip = (b) => { const c = { ...(b ?? {}) }; delete c.lock; return JSON.stringify(c); }; return strip(m.comps.get(id)) === strip(m.comps.get('benchlamp')) && Math.abs(o.position.x - 1.5) < 0.01; })`), await evalJson(`import('/lib/world.js').then((m) => { const id = [...m.entities.keys()].find((k) => /^benchlamp~[0-9a-f]{4}$/.test(k)); return JSON.stringify({ id, comps: m.comps.get(id), src: m.comps.get('benchlamp'), pos: m.entities.get(id)?.position.toArray() }); })`));
check('…and the copy is selected', await waitFor(`import('/lib/scenegraph.js').then((m) => /^benchlamp~[0-9a-f]{4}$/.test(m.sceneSelected() ?? ''))`));
await evalJson(`import('/lib/scenegraph.js').then((m) => m.sceneSelect('benchlamp')), true`);
await waitFor(`${insp}.querySelector('.sp-info')?.textContent.startsWith('benchlamp')`);

console.log('\ndrag-reparent in the tree: detach onto empty space, attach onto a row, refuse a cycle, undo:');
await sleep(1500);   // verb window
const rowOf = (id) => `[...${hier}.querySelectorAll('.sp-tree-row')].find((x) => x.querySelector('.sp-item-label').textContent.includes(${JSON.stringify('')} + ${JSON.stringify(id)}))`;
const dragTo = async (id, targetExpr) => evalJson(`(() => { const src = ${rowOf(id)}; const dst = ${targetExpr}; if (!src || !dst) return 'missing:' + !!src + !!dst; src.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: new DataTransfer() })); dst.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: new DataTransfer() })); dst.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: new DataTransfer() })); src.dispatchEvent(new DragEvent('dragend', { bubbles: true })); return 'ok'; })()`);
check('rows are draggable; riders are not', await evalJson(`${rowOf('lamp3')}?.draggable === true`));
check('lamp3 starts mounted on benchlamp', await evalJson(`import('/lib/state.js').then((m) => m.state.st.entities.lamp3?.parent?.to === 'benchlamp')`));
const d1 = await dragTo('lamp3', `${hier}.querySelector('.sp-tree')`);
check('drop onto empty tree space → detached (dismount, absolute pose stamped)', await waitFor(`import('/lib/state.js').then((m) => !m.state.st.entities.lamp3?.parent)`), d1 + ' parent=' + JSON.stringify(await evalJson(`import('/lib/state.js').then((m) => m.state.st.entities.lamp3?.parent)`)) + ' refused=' + JSON.stringify(await evalJson(`window.__refused`)));
await sleep(600);
const d2 = await dragTo('lamp3', rowOf('porch  (benchlamp)'));
check('drop onto a row → mounted on it (in place)', await waitFor(`import('/lib/state.js').then((m) => m.state.st.entities.lamp3?.parent?.to === 'benchlamp')`), d2 + ' parent=' + JSON.stringify(await evalJson(`import('/lib/state.js').then((m) => m.state.st.entities.lamp3?.parent)`)));
await sleep(600);
const d3 = await dragTo('porch  (benchlamp)', rowOf('lamp3'));
await sleep(400);
check('dropping a carrier onto its own cargo is refused with a hint naming the path, nothing sent', d3 === 'ok' && await evalJson(`import('/lib/state.js').then((m) => m.state.st.entities.lamp3?.parent?.to === 'benchlamp' && !m.state.st.entities.benchlamp?.parent)`) && await evalJson(`/lamp3 is inside benchlamp/.test(document.querySelector('#hintbar, .hint, #hint')?.textContent ?? document.body.textContent)`), await evalJson(`document.querySelector('#hintbar')?.textContent`));
await evalJson(`import('/lib/build.js').then((m) => m.undo()), true`);
check('Ctrl+Z undoes the attach → detached again', await waitFor(`import('/lib/state.js').then((m) => !m.state.st.entities.lamp3?.parent)`), JSON.stringify(await evalJson(`import('/lib/state.js').then((m) => m.state.st.entities.lamp3?.parent)`)));
await sleep(600);
await evalJson(`import('/lib/build.js').then((m) => m.undo()), true`);
check('…and once more undoes the detach → mounted again with its old offset', await waitFor(`import('/lib/state.js').then((m) => m.state.st.entities.lamp3?.parent?.to === 'benchlamp' && Math.abs((m.state.st.entities.lamp3.parent.offset ?? [0])[1] - 0.5) < 1e-6)`), JSON.stringify(await evalJson(`import('/lib/state.js').then((m) => m.state.st.entities.lamp3?.parent)`)));
await evalJson(`import('/lib/scenegraph.js').then((m) => m.sceneSelect('benchlamp')), true`);
await waitFor(`${insp}.querySelector('.sp-info')?.textContent.startsWith('benchlamp')`);

console.log('\ngizmo: TransformControls on the selection, rotate about any axis committing q, one place on release, undo:');
await sleep(1200);
await evalJson(`import('/lib/build.js').then((m) => m.setTool('move')), true`);
check('move tool + a selection → the gizmo is attached to it in translate mode', await waitFor(`globalThis.__gizmo?.().attached === 'benchlamp' && globalThis.__gizmo().mode === 'translate'`), JSON.stringify(await evalJson(`(() => { const g = globalThis.__gizmo?.(); return g && { attached: g.attached, mode: g.mode }; })()`)));
check('the helper is in the scene', await evalJson(`import('/lib/core.js').then((m) => !!m.scene.getObjectByName('edit-gizmo'))`));
await evalJson(`import('/lib/build.js').then((m) => m.setTool('rotate')), true`);
check('rotate tool on a LIGHT → still no gizmo (a point light has no facing: no rot.qw to drag)', await waitFor(`globalThis.__gizmo?.().attached === null`), JSON.stringify(await evalJson(`(() => { const g = globalThis.__gizmo?.(); return g && { attached: g.attached, mode: g.mode }; })()`)));
await evalJson(`import('/lib/net.js').then((m) => m.sendVerb('spawn', { id: 'crate1', lib: 'eidoverse/assets/models/unit_quad_picture_plane.glb', pos: [3, 0, 3], yaw: 0 })), true`);
await waitFor(`import('/lib/world.js').then((m) => !!m.entities.get('crate1'))`, 8000);
await evalJson(`import('/lib/scenegraph.js').then((m) => m.sceneSelect('crate1')), true`);
// was "only the Y ring (the log has no pitch/roll)": B stores the full q, so all three rings show (design §5)
check('rotate tool on a MODEL → rotate mode with ALL three rings (q is stored, not only yaw)', await waitFor(`globalThis.__gizmo?.().attached === 'crate1' && globalThis.__gizmo().mode === 'rotate' && globalThis.__gizmo().controls.showX && globalThis.__gizmo().controls.showY && globalThis.__gizmo().controls.showZ`), JSON.stringify(await evalJson(`(() => { const g = globalThis.__gizmo?.(); return g && { attached: g.attached, mode: g.mode, lib: null }; })()`)) + ' lib=' + JSON.stringify(await evalJson(`import('/lib/world.js').then((m) => m.entityMeta.get('crate1')?.lib)`)));
{
  // a tilt on the X ring, driven through the controls' own events (as the translate drag below):
  // release commits ONE place carrying the full q, pos untouched; undo goes back to the yaw-only record
  const D = Math.PI / 180;
  const qWant = [Math.sin(20 * D), 0, 0, Math.cos(20 * D)];   // 40° about +X
  await evalJson(`(() => { const c = globalThis.__gizmo().controls; c.dispatchEvent({ type: 'dragging-changed', value: true }); return import('/lib/world.js').then((m) => { m.entities.get('crate1').quaternion.set(${qWant.join(',')}); c.dispatchEvent({ type: 'objectChange' }); c.dispatchEvent({ type: 'dragging-changed', value: false }); return true; }); })()`);
  check('a tilt on the X ring commits ONE place carrying the full q (pitch survives, pos untouched)', await waitFor(`import('/lib/state.js').then((m) => { const e = m.state.st.entities.crate1; return Array.isArray(e.q) && Math.abs(Math.abs(e.q[0] * ${qWant[0]} + e.q[3] * ${qWant[3]}) - 1) < 1e-6 && e.pos[0] === 3 && e.pos[2] === 3; })`), JSON.stringify(await evalJson(`import('/lib/state.js').then((m) => m.state.st.entities.crate1)`)) + ' refused=' + JSON.stringify(await evalJson(`window.__refused`)));
  check('…and the channel box reads it: rotate x = 40', await waitFor(`(() => { const r = [...${insp}.querySelectorAll('.sp-f-num')].find((x) => x.querySelector('.sp-label').textContent === 'rotate x'); return !!r && Math.abs(+r.querySelector('.sp-num').value - 40) < 0.01; })()`), JSON.stringify(await evalJson(`[...${insp}.querySelectorAll('.sp-f-num')].map((r) => r.querySelector('.sp-label').textContent + '=' + r.querySelector('.sp-num').value)`)));
  await sleep(600);
  await evalJson(`import('/lib/build.js').then((m) => m.undo()), true`);
  check('undo restores the upright crate (no tilt left in the fold)', await waitFor(`import('/lib/state.js').then((m) => { const e = m.state.st.entities.crate1; return !e.q || (Math.abs(e.q[0]) < 1e-9 && Math.abs(e.q[2]) < 1e-9); })`), JSON.stringify(await evalJson(`import('/lib/state.js').then((m) => m.state.st.entities.crate1)`)));
  await sleep(600);
}
await evalJson(`import('/lib/scenegraph.js').then((m) => m.sceneSelect('benchlamp')), true`);
await evalJson(`import('/lib/build.js').then((m) => m.setTool('move')), true`);
await waitFor(`globalThis.__gizmo?.().mode === 'translate'`);
// a drag, driven through the controls' own events (headless has no pointer on a WebGPU handle):
// begin → the object moves → change → end → ONE place with the full pose
const gx0 = await evalJson(`import('/lib/state.js').then((m) => m.state.st.entities.benchlamp.pos[0])`);
await evalJson(`(() => { const c = globalThis.__gizmo().controls; c.dispatchEvent({ type: 'dragging-changed', value: true }); return import('/lib/world.js').then((m) => { m.entities.get('benchlamp').position.x += 1; c.dispatchEvent({ type: 'objectChange' }); c.dispatchEvent({ type: 'dragging-changed', value: false }); return true; }); })()`);
check('release commits ONE place: pos.x +1 in the fold', await waitFor(`import('/lib/state.js').then((m) => Math.abs(m.state.st.entities.benchlamp.pos[0] - (${gx0} + 1)) < 1e-6)`), 'x=' + JSON.stringify(await evalJson(`import('/lib/state.js').then((m) => m.state.st.entities.benchlamp.pos)`)) + ' refused=' + JSON.stringify(await evalJson(`window.__refused`)));
await sleep(600);
await evalJson(`import('/lib/build.js').then((m) => m.undo()), true`);
check('undo puts it back — and pops the GIZMO\'s entry, not an older one (the copy still exists)', await waitFor(`import('/lib/state.js').then((m) => Math.abs(m.state.st.entities.benchlamp.pos[0] - ${gx0}) < 1e-6 && Object.keys(m.state.st.entities).some((k) => /^benchlamp~/.test(k)))`), JSON.stringify(await evalJson(`import('/lib/state.js').then((m) => Object.keys(m.state.st.entities))`)));
await evalJson(`import('/lib/scenegraph.js').then((m) => m.sceneSelect('benchlamp')), true`);
await waitFor(`globalThis.__gizmo?.().attached === 'benchlamp'`);
await evalJson(`import('/lib/inspect.js').then((m) => m.commitEdit('benchlamp', 'flags.lock', true)), true`);
check('locking the thing detaches the gizmo (a handle you can\'t drag is a lie)', await waitFor(`import('/lib/world.js').then((m) => !!m.comps.get('benchlamp')?.lock) && globalThis.__gizmo?.().attached === null`), JSON.stringify(await evalJson(`(() => { const g = globalThis.__gizmo?.(); return g && { attached: g.attached }; })()`)));
await sleep(600);
await evalJson(`import('/lib/inspect.js').then((m) => m.commitEdit('benchlamp', 'flags.lock', false)), true`);
check('unlocking re-attaches', await waitFor(`import('/lib/world.js').then((m) => !m.comps.get('benchlamp')?.lock) && globalThis.__gizmo?.().attached === 'benchlamp'`));
await evalJson(`import('/lib/build.js').then((m) => m.setTool('select')), true`);
check('select tool → no gizmo', await waitFor(`globalThis.__gizmo?.().attached === null`));
await evalJson(`import('/lib/build.js').then((m) => m.setTool('move')), true`);
await sleep(600);

console.log('\nthe channel box on a model (design §5): Maya\'s rows, the rotate order, the Quaternion row, gimbal lock:');
{
  await sleep(1200);   // verb window
  await evalJson(`import('/lib/scenegraph.js').then((m) => (m.sceneSelect('crate1'), true))`);
  await waitFor(`${insp}.querySelector('.sp-info')?.textContent.startsWith('crate1')`);
  // the rows a card owns: from its header to the next header (renderDOM draws groups as flat markers)
  const cardRows = (title: string) => `(() => { const R = [...${insp}.querySelectorAll('.sp-row')]; const i = R.findIndex((r) => r.querySelector('.sp-group')?.textContent.slice(2) === ${JSON.stringify(title)}); if (i < 0) return []; const out = []; for (const r of R.slice(i + 1)) { if (r.querySelector('.sp-group')) break; out.push(r); } return out; })()`;
  const cardLabels = (title: string) => `${cardRows(title)}.map((r) => r.querySelector('.sp-label')?.textContent ?? r.textContent)`;
  const chan = (label: string) => `[...${insp}.querySelectorAll('.sp-f-num')].find((r) => r.querySelector('.sp-label').textContent === ${JSON.stringify(label)})?.querySelector('.sp-num')`;
  const type = (label: string, v: string) => evalJson(`(() => { const i = ${chan(label)}; if (!i) return false; i.value = ${JSON.stringify(v)}; i.dispatchEvent(new Event('change')); return true; })()`);
  const faces = `['rotate x', 'rotate y', 'rotate z'].map((l) => +[...${insp}.querySelectorAll('.sp-f-num')].find((r) => r.querySelector('.sp-label').textContent === l)?.querySelector('.sp-num').value)`;
  const rec = () => evalJson(`import('/lib/state.js').then((m) => m.state.st.entities.crate1)`);
  const orderSel = `${cardRows('Advanced')}.find((r) => r.querySelector('.sp-label')?.textContent === 'rotate order')?.querySelector('select')`;
  const setOrder = (v: string) => evalJson(`(() => { const s = ${orderSel}; if (!s) return false; s.value = ${JSON.stringify(v)}; s.dispatchEvent(new Event('change')); return true; })()`);
  // in-page: does the fold's q equal the channels' faces recomposed in this order? (the shared math, not a copy)
  const facesCompose = (order: string) => `import('/shared/euler.js').then((E) => import('/lib/state.js').then((S) => { const f = ${faces}.map((d) => d * Math.PI / 180); const q = E.qFromEuler(f, ${JSON.stringify(order)}); const e = S.state.st.entities.crate1; return !!e.q && E.sameRotation(q, e.q, 1e-3); }))`;

  check('the Transform card is Maya\'s channel box: translate x/y/z, rotate x/y/z, scale (rotate order lives in Advanced, R 10-04; the heading alias not drawn)', await waitFor(`JSON.stringify(${cardLabels('Transform')}) === JSON.stringify(['translate x', 'translate y', 'translate z', 'rotate x', 'rotate y', 'rotate z', 'scale'])`), JSON.stringify(await evalJson(cardLabels('Transform'))));
  check('…the Rotate rows carry their axis (x / y / z label colours)', await evalJson(`['x', 'y', 'z'].every((a) => ${cardRows('Transform')}.find((r) => r.querySelector('.sp-label')?.textContent === 'rotate ' + a)?.dataset.axis === a)`));
  check('the Advanced group follows the Transform card, collapsed (header only: rotate order and the quaternion, R 10-04)', await evalJson(`(() => { const G = ${cardTitles}; return G[G.indexOf('Transform') + 1] === 'Advanced' && [...${insp}.querySelectorAll('.sp-group')].some((g) => g.textContent === '▸ Advanced') && ${cardRows('Advanced')}.length === 0; })()`), JSON.stringify(await evalJson(cardTitles)));
  await evalJson(`([...${insp}.querySelectorAll('.sp-group')].find((g) => g.textContent === '▸ Advanced')?.click(), true)`);
  await waitFor(`!![...${insp}.querySelectorAll('.sp-group')].find((g) => g.textContent === '▾ Advanced')`);
  check('rotate order is a dropdown of Maya\'s six orders + quaternion, reading XYZ', await evalJson(`(() => { const s = ${orderSel}; return !!s && [...s.options].map((o) => o.value).join() === 'XYZ,XZY,YXZ,YZX,ZXY,ZYX,quat' && s.value === 'XYZ'; })()`), JSON.stringify(await evalJson(`(() => { const s = ${orderSel}; return s ? [s.value, [...s.options].map((o) => o.value)] : null; })()`)));

  await type('rotate x', '30');
  check('typing rotate x = 30 writes q (30° about X) into the fold, pos and scale untouched', await waitFor(`import('/lib/state.js').then((m) => { const e = m.state.st.entities.crate1; const h = 15 * Math.PI / 180; return Array.isArray(e.q) && Math.abs(Math.abs(e.q[0] * Math.sin(h) + e.q[3] * Math.cos(h)) - 1) < 1e-6 && e.pos[0] === 3 && e.pos[2] === 3 && (e.scale ?? 1) === 1; })`), JSON.stringify(await rec()));
  check('…and the channels read back (30, 0, 0)', await waitFor(`(() => { const f = ${faces}; return f[0] === 30 && f[1] === 0 && f[2] === 0; })()`), JSON.stringify(await evalJson(faces)));
  await sleep(400);
  await type('rotate y', '45');
  check('then rotate y = 45: x still reads 30, z still 0 (one axis edit composes into q, no drift)', await waitFor(`(() => { const f = ${faces}; return f[0] === 30 && f[1] === 45 && f[2] === 0; })()`), JSON.stringify(await evalJson(faces)));
  check('…and those three faces recomposed in XYZ ARE the fold\'s q', await waitFor(facesCompose('XYZ')), JSON.stringify(await rec()));
  await sleep(400);
  const qBefore = JSON.stringify(((await rec()) as any).q);
  await setOrder('ZXY');
  check('rotate order → ZXY writes comp rotOrder and leaves q bit-identical (changing the order never moves the thing)', await waitFor(`import('/lib/world.js').then((m) => m.comps.get('crate1')?.rotOrder === 'ZXY') && import('/lib/state.js').then((m) => JSON.stringify(m.state.st.entities.crate1.q) === ${JSON.stringify(qBefore)})`), JSON.stringify(await rec()));
  check('…and the channels now read that same q in ZXY (recomposing them in ZXY gives q)', await waitFor(`(async () => (await import('/lib/world.js')).comps.get('crate1')?.rotOrder === 'ZXY' && ${orderSel}?.value === 'ZXY' && await ${facesCompose('ZXY')})()`), JSON.stringify(await evalJson(faces)));
  await sleep(400);
  await setOrder('XYZ');
  check('back to XYZ removes the comp (absent means XYZ)', await waitFor(`import('/lib/world.js').then((m) => m.comps.get('crate1')?.rotOrder == null)`), JSON.stringify(await evalJson(`import('/lib/world.js').then((m) => m.comps.get('crate1'))`)));
  await sleep(400);
  await type('rotate y', '90');
  check('rotate y = 90 (XYZ\'s middle axis): the Transform card says it is in gimbal lock', await waitFor(`${cardRows('Transform')}.some((r) => r.classList.contains('sp-f-info') && /gimbal lock/.test(r.textContent))`), JSON.stringify(await evalJson(cardLabels('Transform'))));
  await sleep(400);
  check('the open Advanced group holds rotate order and quat x / y / z / w', await waitFor(`JSON.stringify(${cardLabels('Advanced')}) === JSON.stringify(['rotate order', 'quat x', 'quat y', 'quat z', 'quat w'])`), JSON.stringify(await evalJson(cardLabels('Advanced'))));
  check('…reading the fold\'s q', await waitFor(`import('/lib/state.js').then((m) => { const q = m.state.st.entities.crate1.q; const v = ${cardRows('Advanced')}.filter((r) => r.querySelector('.sp-num')).map((r) => +r.querySelector('.sp-num').value); return v.length === 4 && v.every((x, i) => Math.abs(x - q[i]) < 1e-3); })`), JSON.stringify([await evalJson(`${cardRows('Quaternion')}.map((r) => r.querySelector('.sp-num').value)`), ((await rec()) as any).q]));
  const qLock = ((await rec()) as any).q;
  await type('quat w', '2');
  check('typing quat w = 2 commits a NORMALIZED q (clamped to 1, then the whole q scaled to unit length)', await waitFor(`import('/lib/state.js').then((m) => { const q = m.state.st.entities.crate1.q; return Array.isArray(q) && Math.abs(Math.hypot(...q) - 1) < 1e-9 && q[3] > ${qLock[3]} + 1e-3; })`), JSON.stringify(await rec()));
  await sleep(600);
  await evalJson(`import('/lib/build.js').then((m) => (m.undo(), true))`);
  check('one undo puts the gimbal-locked q back', await waitFor(`import('/lib/state.js').then((m) => { const q = m.state.st.entities.crate1.q; return Array.isArray(q) && q.every((x, i) => Math.abs(x - ${JSON.stringify(qLock)}[i]) < 1e-9); })`, 10000), JSON.stringify(await rec()) + ' want=' + JSON.stringify(qLock));
  // folding the Transform card must fold its Quaternion row too (renderDOM draws groups as FLAT markers, so a
  // sub-header that is open would otherwise reopen its rows under a closed card)
  await evalJson(`([...${insp}.querySelectorAll('.sp-group')].find((g) => g.textContent === '▾ Transform')?.click(), true)`);
  check('folding Transform hides its rows AND the open Advanced group inside it', await waitFor(`(() => { const L = [...${insp}.querySelectorAll('.sp-label')].map((l) => l.textContent); return [...${insp}.querySelectorAll('.sp-group')].some((g) => g.textContent === '▸ Transform') && !L.includes('rotate x') && !L.includes('quat w') && !${cardTitles}.includes('Quaternion'); })()`), JSON.stringify({ groups: await evalJson(cardTitles), labels: await evalJson(`[...${insp}.querySelectorAll('.sp-label')].map((l) => l.textContent)`) }));
  // folds persist per lib (localStorage): put both back the way later sections expect them
  await waitFor(`[...${insp}.querySelectorAll('.sp-group')].some((g) => g.textContent === '▸ Transform')`);
  await evalJson(`([...${insp}.querySelectorAll('.sp-group')].find((g) => g.textContent === '▸ Transform')?.click(), true)`);
  await waitFor(`[...${insp}.querySelectorAll('.sp-group')].some((g) => g.textContent === '▾ Advanced')`);
  await evalJson(`([...${insp}.querySelectorAll('.sp-group')].find((g) => g.textContent === '▾ Advanced')?.click(), true)`);
  check('…and unfolding brings the card back with the Advanced group as it was left', await waitFor(`${cardLabels('Transform')}.includes('rotate x') && [...${insp}.querySelectorAll('.sp-group')].some((g) => g.textContent === '▸ Advanced')`), JSON.stringify(await evalJson(`[...${insp}.querySelectorAll('.sp-group')].map((g) => g.textContent)`)));
}

console.log('\npick: an armed attach completes on a viewport click, not only a row click; both attach paths undo:');
await sleep(1500);   // verb window
check('crate1 is a root to start', await evalJson(`import('/lib/state.js').then((m) => !m.state.st.entities.crate1?.parent)`));
await evalJson(`import('/lib/scenegraph.js').then((m) => m.sceneSelect('crate1')), true`);
await evalJson(`(() => { const row = [...${hier}.querySelectorAll('.sp-tree-row')].find((r) => /crate1/.test(r.textContent)); row.dispatchEvent(new MouseEvent('contextmenu', { clientX: 120, clientY: 130, bubbles: true, cancelable: true })); const it = [...document.querySelectorAll('.sp-ctx .sp-ctx-item')].find((i) => /parent to/.test(i.textContent)); it.click(); return true; })()`);
check('attach armed on crate1: the hint names the world as a target', await waitFor(`globalThis.__editPanels?.().arming === 'crate1' && /in the world/.test(document.querySelector('#hintbar')?.textContent ?? '')`), JSON.stringify(await evalJson(`({ arming: globalThis.__editPanels?.().arming, hint: document.querySelector('#hintbar')?.textContent })`)));
// a viewport pick = build.js select(id) → sceneSelect(id): the same seam, driven directly
await evalJson(`import('/lib/build.js').then((m) => m.select('benchlamp')), true`);
check('picking benchlamp in the viewport mounts crate1 on it and re-selects crate1', await waitFor(`import('/lib/state.js').then((m) => m.state.st.entities.crate1?.parent?.to === 'benchlamp') && import('/lib/scenegraph.js').then((m) => m.sceneSelected() === 'crate1')`), 'parent=' + JSON.stringify(await evalJson(`import('/lib/state.js').then((m) => m.state.st.entities.crate1?.parent)`)) + ' sel=' + JSON.stringify(await evalJson(`import('/lib/scenegraph.js').then((m) => m.sceneSelected())`)) + ' refused=' + JSON.stringify(await evalJson(`window.__refused`)));
check('…and arming is cleared', await evalJson(`globalThis.__editPanels?.().arming === null`));
await sleep(600);
await evalJson(`import('/lib/build.js').then((m) => m.undo()), true`);
check('undo frees it again (the row-click path now shares this undo)', await waitFor(`import('/lib/state.js').then((m) => !m.state.st.entities.crate1?.parent)`), JSON.stringify(await evalJson(`import('/lib/state.js').then((m) => m.state.st.entities.crate1?.parent)`)));
await evalJson(`import('/lib/scenegraph.js').then((m) => m.sceneSelect('benchlamp')), true`);
await waitFor(`${insp}.querySelector('.sp-info')?.textContent.startsWith('benchlamp')`);

console.log('\nthe tree (step 4): kind hints, folds kept, a folded filter hit, reveal on select, the root strip, a scaled carrier kept in place, the Parent field:');
await sleep(1500);   // verb window
{
  const sub = (id: string) => `(${rowOf(id)}?.querySelector('.sp-item-sub')?.textContent ?? '')`;
  check('rows carry a kind hint: a light says light, a model its file stem', await waitFor(`${sub('lamp3')}.startsWith('light') && ${sub('crate1')}.startsWith('unit quad picture')`), await evalJson(`[${sub('lamp3')}, ${sub('crate1')}]`));
  const FOLD = `JSON.parse(localStorage.getItem('ew-hier-fold:editbench') || '[]')`;
  await evalJson(`(${rowOf('porch  (benchlamp)')}.querySelector('.sp-disc').click(), true)`);
  check('folding benchlamp hides lamp3 and is remembered in this browser', await waitFor(`!${rowOf('lamp3')} && ${FOLD}.includes('benchlamp')`), JSON.stringify(await evalJson(FOLD)));
  await evalJson(`(() => { const i = ${hier}.querySelector('.sp-f-text .sp-text'); i.value = 'lamp3'; i.dispatchEvent(new Event('change')); return true; })()`);
  check('a filter hit inside the FOLDED benchlamp shows the path: benchlamp (dimmed) › lamp3', await waitFor(`(() => { const R = [...${hier}.querySelectorAll('.sp-tree-row')]; return R.length === 2 && R[0].classList.contains('dim') && /lamp3/.test(R[1].textContent); })()`),
    await evalJson(`[...${hier}.querySelectorAll('.sp-tree-row')].map((r) => r.className + ':' + r.querySelector('.sp-item-label').textContent).join('|')`));
  await evalJson(`(() => { const i = ${hier}.querySelector('.sp-f-text .sp-text'); i.value = ''; i.dispatchEvent(new Event('change')); return true; })()`);
  check('…clearing the filter leaves the fold as it was', await waitFor(`!${rowOf('lamp3')} && !!${rowOf('crate1')}`));
  await evalJson(`import('/lib/scenegraph.js').then((m) => m.sceneSelect('lamp3')), true`);
  check('selecting lamp3 (inside the fold) reveals it: benchlamp unfolds, the row is active', await waitFor(`!!${rowOf('lamp3')}?.classList.contains('active') && !${FOLD}.includes('benchlamp')`), JSON.stringify(await evalJson(FOLD)));
  await sleep(600);
  // the root strip: only while a row is in flight, and a drop on it unparents
  check('no root strip at rest', await evalJson(`(${hier}.querySelector('.sp-tree-root')?.offsetHeight ?? -1) === 0`));
  const strip = await evalJson(`(() => { const src = ${rowOf('lamp3')}; const z = ${hier}.querySelector('.sp-tree-root'); src.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: new DataTransfer() })); const shown = z.offsetHeight > 0 && /no parent/.test(z.textContent); z.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: new DataTransfer() })); z.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: new DataTransfer() })); src.dispatchEvent(new DragEvent('dragend', { bubbles: true })); return shown; })()`);
  check('dragging shows the "no parent" strip; dropping on it unparents lamp3', strip === true && await waitFor(`import('/lib/state.js').then((m) => !m.state.st.entities.lamp3?.parent)`), String(strip));
  await sleep(600);
  await evalJson(`import('/lib/build.js').then((m) => m.undo()), true`);
  check('…one undo puts it back', await waitFor(`import('/lib/state.js').then((m) => m.state.st.entities.lamp3?.parent?.to === 'benchlamp')`));
  await sleep(1500);
  // a scaled, turned carrier: the dragged child keeps its world position AND size (mount + a scale place, one undo)
  await evalJson(`import('/lib/net.js').then((m) => { m.sendVerb('place', { id: 'crate1', pos: [3, 0.5, 3], q: [0.2, 0.3, 0.1, 0.93], scale: 2 }); m.sendVerb('spawn', { id: 'cup1', lib: 'eidoverse/assets/models/unit_quad_picture_plane.glb', pos: [4, 1.2, 3.5], yaw: 0.7, scale: 0.5 }); }), true`);
  await waitFor(`import('/lib/world.js').then((m) => !!m.entities.get('cup1') && Math.abs(m.entities.get('crate1').scale.x - 2) < 1e-6)`, 8000);
  const WP = `import('/lib/world.js').then((m) => { const o = m.entities.get('cup1'); o.updateWorldMatrix(true, false); const p = new o.position.constructor(), s = new o.position.constructor(); o.getWorldPosition(p); o.getWorldScale(s); return [p.x, p.y, p.z, s.x]; })`;
  const w0 = await evalJson(WP);
  await sleep(600);
  const d = await dragTo('cup1', rowOf('crate1'));
  check('cup1 dropped on the scaled crate1 → under it', d === 'ok' && await waitFor(`import('/lib/state.js').then((m) => m.state.st.entities.cup1?.parent?.to === 'crate1' && Math.abs((m.state.st.entities.cup1.scale ?? 1) - 0.25) < 1e-3)`), d + ' ' + JSON.stringify(await evalJson(`import('/lib/state.js').then((m) => [m.state.st.entities.cup1?.parent, m.state.st.entities.cup1?.scale])`)));
  const w1 = await evalJson(WP);
  check('…and did not move or resize in the world (three.js, after the echo)', await waitFor(`${WP}.then((w) => w.every((v, i) => Math.abs(v - ${JSON.stringify(w0)}[i]) < 2e-3))`), JSON.stringify({ w0, w1 }));
  await evalJson(`import('/lib/scenegraph.js').then((m) => m.sceneSelect('cup1')), true`);
  const ref = (label: string) => `[...${insp}.querySelectorAll('.sp-f-ref')].find((x) => x.querySelector('.sp-label')?.textContent === ${JSON.stringify(label)})`;
  check('the inspector header shows Parent: crate1', await waitFor(`/crate1/.test(${ref('parent')}?.querySelector('.sp-ref-name')?.textContent ?? '')`), await evalJson(`${insp}.textContent.slice(0, 300)`));
  check('…and its Translate reads LOCAL (the mount offset), said so on the card', await waitFor(`(() => { const f = (l) => [...${insp}.querySelectorAll('.sp-f-num')].find((r) => r.querySelector('.sp-label')?.textContent === l); const x = f('translate x'); return !!x && Math.abs(parseFloat(x.querySelector('.sp-num').value) - 4) > 0.05 && /local to its parent, crate1/.test(${insp}.textContent); })()`),
    await evalJson(`[...${insp}.querySelectorAll('.sp-f-num')].slice(0, 3).map((r) => r.querySelector('.sp-label')?.textContent + '=' + r.querySelector('.sp-num').value).join(' ')`));
  await evalJson(`import('/lib/scenegraph.js').then((m) => m.sceneSelect('crate1')), true`);
  check('crate1\'s inspector does NOT list its children: that is the Hierarchy\'s job (R 10-04)', await evalJson(`![...${insp}.querySelectorAll('.sp-f-info')].some((r) => r.querySelector('.sp-label')?.textContent === 'children')`));
  await sleep(600);
  await evalJson(`import('/lib/build.js').then((m) => m.undo()), true`);
  check('ONE undo for the drag: a root again, its own scale back, same world pose', await waitFor(`import('/lib/state.js').then((m) => !m.state.st.entities.cup1?.parent && m.state.st.entities.cup1?.scale === 0.5)`) && await waitFor(`${WP}.then((w) => w.every((v, i) => Math.abs(v - ${JSON.stringify(w0)}[i]) < 2e-3))`),
    JSON.stringify(await evalJson(`import('/lib/state.js').then((m) => m.state.st.entities.cup1)`)));
  await sleep(1200);
  // the Parent field: pick (the VR / agent path — no drag), then ✕ to unparent
  // arm only once the inspector SHOWS cup1 (a stale crate1 inspector also has a Parent field), and
  // click the row only once the pick is armed — the same order a person's eyes enforce
  await evalJson(`import('/lib/scenegraph.js').then((m) => { m.sceneSelect('cup1'); return true; })`);
  await waitFor(`${insp}.querySelector('.sp-info')?.textContent.startsWith('cup1') && !!${ref('parent')}`);
  await evalJson(`(${ref('parent')}.querySelector('.sp-ref-name').click(), true)`);
  await waitFor(`/click a target/.test(${ref('parent')}?.querySelector('.sp-ref-name')?.textContent ?? '') && /new parent/.test(document.querySelector('#hintbar')?.textContent ?? '')`);
  await evalJson(`([...${hier}.querySelectorAll('.sp-tree-row')].find((r) => r.dataset.id === 'crate1').querySelector('.sp-item-main').click(), true)`);
  check('Parent: pick crate1 (a row) → parented in place, the inspector stays on cup1', await waitFor(`import('/lib/state.js').then((m) => m.state.st.entities.cup1?.parent?.to === 'crate1')`) && await waitFor(`import('/lib/scenegraph.js').then((m) => m.sceneSelected() === 'cup1')`) && await waitFor(`${WP}.then((w) => w.every((v, i) => Math.abs(v - ${JSON.stringify(w0)}[i]) < 2e-3))`),
    JSON.stringify(await evalJson(`Promise.all([import('/lib/state.js'), import('/lib/scenegraph.js')]).then(([m, g]) => ({ parent: m.state.st.entities.cup1?.parent, sel: g.sceneSelected(), hint: document.querySelector('#hintbar')?.textContent }))`)) + ' w=' + JSON.stringify(await evalJson(WP)));
  await sleep(600);
  await waitFor(`!!${ref('parent')}?.querySelector('.sp-ref-clear')`);
  await evalJson(`(${ref('parent')}?.querySelector('.sp-ref-clear')?.click(), true)`);
  check('Parent ✕ → a root again, where it stood', await waitFor(`import('/lib/state.js').then((m) => !m.state.st.entities.cup1?.parent)`) && await waitFor(`${WP}.then((w) => w.every((v, i) => Math.abs(v - ${JSON.stringify(w0)}[i]) < 2e-3))`), JSON.stringify(await evalJson(WP)));
  // the VR quad paints the same tree (one fields declaration)
  // the VR quad paints the same declaration: render it to a canvas as the quad does and read its hit regions
  await evalJson(`import('/lib/net.js').then((m) => m.sendVerb('mount', { id: 'cup1', to: 'crate1', offset: [0, 0.5, 0] })), true`);
  await waitFor(`import('/lib/state.js').then((m) => m.state.st.entities.cup1?.parent?.to === 'crate1')`);
  const vr = await evalJson(`import('/lib/panels.js').then((m) => { const c = document.createElement('canvas'); const R = m.renderCanvas(c, globalThis.__editPanels().hierFields(), { theme: 'edit' }); return { cup: R.some((r) => r.action === 'sel' && r.payload === 'cup1'), disc: R.some((r) => r.action === 'open' && r.payload === 'crate1') }; })`);
  check('the VR quad paints the same tree: a cup1 row to pick, a disclosure on crate1', vr?.cup && vr?.disc, JSON.stringify(vr));
  await evalJson(`import('/lib/net.js').then((m) => m.sendVerb('remove', { id: 'cup1' })), true`);   // leave the world as the later sections expect it
  await waitFor(`import('/lib/state.js').then((m) => !m.state.st.entities.cup1)`);
  await sleep(1200);
}
await evalJson(`import('/lib/scenegraph.js').then((m) => m.sceneSelect('benchlamp')), true`);
await waitFor(`${insp}.querySelector('.sp-info')?.textContent.startsWith('benchlamp')`);

console.log('\nmulti-selection: intersected channels, field-wise writes, one undo:');
await sleep(1500);   // verb window
const copyId = await evalJson(`import('/lib/world.js').then((m) => [...m.entities.keys()].find((k) => /^benchlamp~[0-9a-f]{4}$/.test(k)))`);
await evalJson(`(() => { const R = [...${hier}.querySelectorAll('.sp-tree-row')]; const r = R.find((x) => x.querySelector('.sp-item-label').textContent.includes(${JSON.stringify(copyId)})); r.querySelector('.sp-item-main').dispatchEvent(new MouseEvent('click', { ctrlKey: true, bubbles: true })); return true; })()`);
check('Ctrl-click a second row → 2 selected, primary unchanged', await waitFor(`globalThis.__editPanels?.().selection.length === 2 && globalThis.__editPanels().selection[0] === 'benchlamp'`), JSON.stringify(await evalJson(`globalThis.__editPanels?.().selection`)));
check('the inspector says so and shows only SHARED channels (both lights: brightness, no sockets)', await waitFor(`/2 selected/.test(${insp}.textContent) && [...${insp}.querySelectorAll('.sp-f-num .sp-label')].some((l) => /brightness/.test(l.textContent)) && ![...${insp}.querySelectorAll('.sp-f-num .sp-label')].some((l) => /sockets/.test(l.textContent))`), JSON.stringify(await evalJson(`[...${insp}.querySelectorAll('.sp-f-num .sp-label')].map((l) => l.textContent)`)));
check('the second row is marked multi, the first active', await evalJson(`${hier}.querySelectorAll('.sp-tree-row.multi').length === 1 && ${hier}.querySelectorAll('.sp-tree-row.active').length === 1`));
const before = await evalJson(`import('/lib/state.js').then((m) => [m.state.st.entities.benchlamp.intensity, m.state.st.entities[${JSON.stringify(copyId)}].intensity])`);
await evalJson(`(() => { const i = [...${insp}.querySelectorAll('.sp-f-num')].find((r) => /brightness/.test(r.querySelector('.sp-label').textContent)).querySelector('.sp-num'); i.value = '33'; i.dispatchEvent(new Event('change')); return true; })()`);
check('typing 33 into brightness lands on BOTH lights', await waitFor(`import('/lib/state.js').then((m) => m.state.st.entities.benchlamp.intensity === 33 && m.state.st.entities[${JSON.stringify(copyId)}].intensity === 33)`), 'before=' + JSON.stringify(before) + ' now=' + JSON.stringify(await evalJson(`import('/lib/state.js').then((m) => [m.state.st.entities.benchlamp.intensity, m.state.st.entities[${JSON.stringify(copyId)}].intensity])`)) + ' refused=' + JSON.stringify(await evalJson(`window.__refused`)));
await sleep(1200);
await evalJson(`import('/lib/build.js').then((m) => m.undo()), true`);
check('ONE undo restores both', await waitFor(`import('/lib/state.js').then((m) => m.state.st.entities.benchlamp.intensity === ${before[0]} && m.state.st.entities[${JSON.stringify(copyId)}].intensity === ${before[1]})`), JSON.stringify(await evalJson(`import('/lib/state.js').then((m) => [m.state.st.entities.benchlamp.intensity, m.state.st.entities[${JSON.stringify(copyId)}].intensity])`)));
await evalJson(`import('/lib/scenegraph.js').then((m) => m.sceneSelect('benchlamp')), true`);
check('after undo + a plain select, the set is back to one', await waitFor(`globalThis.__editPanels?.().selection.length === 1`), 'sel=' + JSON.stringify(await evalJson(`globalThis.__editPanels?.().selection`)));
await evalJson(`(() => { const R = [...${hier}.querySelectorAll('.sp-tree-row')]; const r = R.find((x) => x.querySelector('.sp-item-label').textContent.includes(${JSON.stringify(copyId)})); r.querySelector('.sp-item-main').dispatchEvent(new MouseEvent('click', { ctrlKey: true, bubbles: true })); return true; })()`);
check('Ctrl-click extends again → 2', await waitFor(`globalThis.__editPanels?.().selection.length === 2`), JSON.stringify(await evalJson(`globalThis.__editPanels?.().selection`)));
await evalJson(`(() => { const R = [...${hier}.querySelectorAll('.sp-tree-row')]; const r = R.find((x) => x.querySelector('.sp-item-label').textContent.includes(${JSON.stringify(copyId)})); r.querySelector('.sp-item-main').dispatchEvent(new MouseEvent('click', { ctrlKey: true, bubbles: true })); return true; })()`);
check('Ctrl-click the extra again drops it → 1 selected', await waitFor(`globalThis.__editPanels?.().selection.length === 1`), 'selection=' + JSON.stringify(await evalJson(`globalThis.__editPanels?.().selection`)) + ' rows=' + JSON.stringify(await evalJson(`[...${hier}.querySelectorAll('.sp-tree-row')].map((r) => r.className.replace('sp-item sp-tree-row', '') + ':' + r.querySelector('.sp-item-label').textContent)`)));
await evalJson(`(() => { const R = [...${hier}.querySelectorAll('.sp-tree-row')]; const r = R.find((x) => x.querySelector('.sp-item-label').textContent.includes(${JSON.stringify(copyId)})); r.querySelector('.sp-item-main').dispatchEvent(new MouseEvent('click', { bubbles: true })); return true; })()`);
check('a plain click collapses to that one thing', await waitFor(`globalThis.__editPanels?.().selection.length === 1 && globalThis.__editPanels().selection[0] === ${JSON.stringify(copyId)}`));
await evalJson(`import('/lib/scenegraph.js').then((m) => m.sceneSelect('benchlamp')), true`);
await waitFor(`${insp}.querySelector('.sp-info')?.textContent.startsWith('benchlamp')`);

console.log('\nthe legacy World›Scene section still gets the light editor (adapter):');
// main's World panel holds its sections as TABS (ui.js makeSection): the head is #sec-scene-tab, beside the pane, not in it
await evalJson(`document.querySelector('#sec-scene-tab')?.click(), true`);
check('scene section renders the light fields through editorsFor', await waitFor(`!!document.querySelector('#sec-scene [data-fe] .sp-num')`));

console.log('\nref field: pick another entity as a value (look.target):');
// add an empty `look` comp to benchlamp so its ref field appears, then select it
await evalJson(`import('/lib/net.js').then((m) => m.sendVerb('comp', { id: 'benchlamp', type: 'look', data: {} })), true`);
await waitFor(`import('/lib/world.js').then((m) => !!m.comps.get('benchlamp')?.look)`);
await evalJson(`(() => { const R = [...${hier}.querySelectorAll('.sp-tree-row')]; const r = R.find((x) => /active.*benchlamp|benchlamp/.test(x.querySelector('.sp-item-label').textContent)); r.querySelector('.sp-item-main').click(); return true; })()`);
check('the look comp gives benchlamp a ref field reading "— pick —"', await waitFor(`(() => { const w = ${insp}; if (!w) return false; const r = [...w.querySelectorAll('.sp-f-ref')].find((x) => x.querySelector('.sp-label')?.textContent === 'target'); return !!r && /pick/.test(r.querySelector('.sp-ref-name').textContent); })()`), 'refs=' + JSON.stringify(await evalJson(`(() => { const w = ${insp}; return w ? [...w.querySelectorAll('.sp-f-ref .sp-ref-name')].map((n) => n.textContent) : 'no inspector'; })()`)));
// click the ref name → arm the pick
await evalJson(`(() => { const w = ${insp}; const r = [...w.querySelectorAll('.sp-f-ref')].find((x) => x.querySelector('.sp-label')?.textContent === 'target'); r.querySelector('.sp-ref-name').click(); return true; })()`);
check('clicking the ref arms the pick (the name says "click a target…" and __editLayout reports it)', await waitFor(`(() => { const w = ${insp}; const r = [...w.querySelectorAll('.sp-f-ref')].find((x) => x.querySelector('.sp-label')?.textContent === 'target'); return !!r && /click a target/.test(r.querySelector('.sp-ref-name').textContent); })()`));
// click the lamp3 row → it becomes the target (a ROW-click completion)
await evalJson(`(() => { const R = [...${hier}.querySelectorAll('.sp-tree-row')]; const r = R.find((x) => /lamp3/.test(x.querySelector('.sp-item-label').textContent)); r.querySelector('.sp-item-main').click(); return true; })()`);
check('picking the lamp3 row commits look.target = lamp3', await waitFor(`import('/lib/world.js').then((m) => m.comps.get('benchlamp')?.look?.target === 'lamp3')`), 'look=' + JSON.stringify(await evalJson(`import('/lib/world.js').then((m) => m.comps.get('benchlamp')?.look)`)) + ' refused=' + JSON.stringify(await evalJson(`window.__refused`)));
check('…and the inspector stayed on benchlamp (re-selected after the pick)', await waitFor(`import('/lib/scenegraph.js').then((m) => m.sceneSelected() === 'benchlamp')`));
check('…and the ref field now shows the target id, not "pick"', await waitFor(`(() => { const w = ${insp}; const r = [...w.querySelectorAll('.sp-f-ref')].find((x) => x.querySelector('.sp-label')?.textContent === 'target'); return !!r && /lamp3/.test(r.querySelector('.sp-ref-name').textContent); })()`));
// the ✕ clears it
await evalJson(`(() => { const w = ${insp}; const r = [...w.querySelectorAll('.sp-f-ref')].find((x) => x.querySelector('.sp-label')?.textContent === 'target'); r.querySelector('.sp-ref-clear').click(); return true; })()`);
check('the ✕ clears the reference → look comp gone (its only field emptied)', await waitFor(`import('/lib/world.js').then((m) => !m.comps.get('benchlamp')?.look)`), 'look=' + JSON.stringify(await evalJson(`import('/lib/world.js').then((m) => m.comps.get('benchlamp')?.look)`)));

console.log('\nDel / Backspace act on what the INSPECTOR shows (a tree pick), not the last viewport pick:');
{
  const L = (id: string, x: number) => evalJson(`import('/lib/net.js').then((m) => m.sendVerb('light', { id: '${id}', pos: [${x}, 1, -3], color: 0xffffff, intensity: 4, range: 3 })), true`);
  const alive = (id: string) => `import('/lib/world.js').then((m) => !!m.entities.get('${id}'))`;
  const rowClick = (id: string, extra = '') => evalJson(`(() => { const r = [...${hier}.querySelectorAll('.sp-tree-row')].find((x) => x.querySelector('.sp-item-label').textContent.trim() === '${id}' || new RegExp('\\\\b${id}\\\\b').test(x.querySelector('.sp-item-label').textContent)); if (!r) return false; const m = r.querySelector('.sp-item-main'); const b = m.getBoundingClientRect(); const at = { bubbles: true, clientX: b.left + 8, clientY: b.top + b.height / 2${extra} }; m.dispatchEvent(new PointerEvent('pointerdown', at)); m.dispatchEvent(new PointerEvent('pointerup', at)); m.dispatchEvent(new MouseEvent('click', at)); return true; })()`);
  // click the way a pointer does — down, up, click at the row's own spot — or panels.js's nav/action
  // guard (guardActions) measures travel from some earlier step's pointerdown and swallows it, correctly
  const key = (code: string) => evalJson(`(document.activeElement?.blur?.(), dispatchEvent(new KeyboardEvent('keydown', { code: '${code}' })), true)`);
  await L('delA', -2); await L('delB', 2);
  await waitFor(`(async () => (await ${alive('delA')}) && (await ${alive('delB')}))()`);
  // …and for their tree ROWS: the hierarchy repaints on a late headless rAF, and a click before it found no row (seen 10-01)
  await waitFor(`['delA', 'delB'].every((id) => [...${hier}.querySelectorAll('.sp-tree-row .sp-item-label')].some((l) => l.textContent.trim() === id))`);
  // AWAIT the import: a trailing `, true` returned before it resolved, and the pick landed AFTER the tree click below
  await evalJson(`import('/lib/build.js').then((m) => (m.select('delA'), true))`);          // viewport pick: build.js's own `selected`
  await sleep(150);
  await evalJson(`(window.__clk = [], document.addEventListener('click', (e) => __clk.push(['cap', e.target.className]), true), addEventListener('click', (e) => __clk.push(['bub', e.target.className]))), import('/lib/scenegraph.js').then((m) => { window.__sgs = m.sceneSelected; }), true`);
  await evalJson(`import('/lib/base.js').then((m) => { window.__sel = []; m.bus.on('sg:selected', (id) => __sel.push(id)); }), true`);
  check('the tree row for delB is clickable', await rowClick('delB'));
  check('…and the inspector now shows delB', await waitFor(`import('/lib/scenegraph.js').then((m) => m.sceneSelected() === 'delB')`));
  await key('Delete');
  check('Delete removed delB — the thing the inspector showed', await waitFor(`${alive('delB')}.then((a) => !a)`));
  check('…and NOT delA, the stale viewport pick', await evalJson(alive('delA')), 'refused=' + JSON.stringify(await evalJson(`window.__refused`)));
  await evalJson(`import('/lib/build.js').then((m) => m.undo()), true`);
  check('one undo brings delB back', await waitFor(alive('delB')));
  await sleep(300);
  await rowClick('delA'); await sleep(100);
  await rowClick('delB', ', ctrlKey: true');
  check('Ctrl-click extends: two selected', await waitFor(`Promise.resolve(globalThis.__editPanels?.().selection?.length === 2 || (document.querySelectorAll('.sp-tree-row.multi').length + document.querySelectorAll('.sp-tree-row.active').length) >= 2)`));
  await key('Backspace');
  check('Backspace removes BOTH selected', await waitFor(`(async () => !(await ${alive('delA')}) && !(await ${alive('delB')}))()`));
  await evalJson(`import('/lib/build.js').then((m) => m.undo()), true`);
  check('…and ONE undo restores both', await waitFor(`(async () => (await ${alive('delA')}) && (await ${alive('delB')}))()`));
  await sleep(300);
  await rowClick('delA'); await sleep(100);
  await waitFor(`JSON.stringify(globalThis.__editPanels?.().selection) === '["delA"]'`);   // the click collapsed the pair to delA (not a stale two)
  await evalJson(`import('/lib/net.js').then((m) => m.sendVerb('comp', { id: 'delA', type: 'lock', data: true })), true`);
  await waitFor(`import('/lib/world.js').then((m) => !!m.comps.get('delA')?.lock)`);
  await painted();
  await key('KeyX');
  await sleep(600);
  check('X on a locked thing removes nothing', await evalJson(alive('delA')), 'sel=' + JSON.stringify(await evalJson(`globalThis.__editPanels?.().selection`)) + ' hint=' + JSON.stringify(await evalJson(`document.querySelector('#hintbar')?.textContent`)));
}

console.log('\ndeselect is deliberate (Esc / Edit ▸ deselect); undo keeps what you are working on; badges once:');
{
  const L = (id: string, x: number) => evalJson(`import('/lib/net.js').then((m) => (m.sendVerb('light', { id: '${id}', pos: [${x}, 1, -5], color: 0xffffff, intensity: 4, range: 3 }), true))`);
  await L('selA', -1);
  await waitFor(`import('/lib/world.js').then((m) => !!m.entities.get('selA'))`);
  await evalJson(`import('/lib/scenegraph.js').then((m) => (m.sceneSelect('selA'), true))`);
  await evalJson(`import('/lib/net.js').then((m) => (m.sendVerb('comp', { id: 'selA', type: 'hidden', data: true }), true))`);
  check('a hidden thing wears "hidden" ONCE in the tree', await waitFor(`(() => { const r = [...${hier}.querySelectorAll('.sp-tree-row')].find((x) => /selA/.test(x.querySelector('.sp-item-label').textContent)); const sub = r?.querySelector('.sp-item-sub')?.textContent ?? ''; return (sub.match(/hidden/g) ?? []).length === 1; })()`), JSON.stringify(await evalJson(`[...${hier}.querySelectorAll('.sp-tree-row')].map((x) => x.querySelector('.sp-item-sub')?.textContent)`)));
  await evalJson(`(document.activeElement?.blur?.(), true)`);
  const inspectorId = `(${insp}.querySelector('.sp-info')?.textContent ?? '')`;
  await evalJson(`import('/lib/build.js').then((m) => (m.undo(), true))`);   // undoes the hidden flag
  await sleep(400);
  check('undo keeps the inspector on selA (Unity/Godot: undo never drops your selection)', await waitFor(`import('/lib/scenegraph.js').then((m) => m.sceneSelected() === 'selA')`), JSON.stringify(await evalJson(`import('/lib/scenegraph.js').then((m) => m.sceneSelected())`)));
  await evalJson(`(dispatchEvent(new KeyboardEvent('keydown', { code: 'Escape' })), true)`);
  check('Esc clears what the inspector shows (not only a viewport pick)', await waitFor(`import('/lib/scenegraph.js').then((m) => m.sceneSelected() == null)`) && await waitFor(`/nothing selected/.test(${inspectorId})`), await evalJson(inspectorId));
  check('…and the first Esc did NOT leave edit mode', await evalJson(`import('/lib/build.js').then((m) => m.isEditing())`));
}

console.log('\npicture + sound in the inspector (schema groups; uploads through the real chooser and /upload):');
{
  const { writeFileSync } = await import('node:fs');
  const png = `${SCRATCH}/bench-red.png`, wav = `${SCRATCH}/bench-tone.wav`;
  writeFileSync(png, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAIAAAAmkwkpAAAAEElEQVR4nGM4oaEBRwzEcQDRQxGBSNLB6wAAAABJRU5ErkJggg==', 'base64'));
  { // 0.25 s of 8 kHz mono 16-bit silence: a real RIFF/WAVE the store sniffs as audio
    const n = 2000, b = Buffer.alloc(44 + n * 2);
    b.write('RIFF', 0); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVE', 8); b.write('fmt ', 12); b.writeUInt32LE(16, 16);
    b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(8000, 24); b.writeUInt32LE(16000, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
    b.write('data', 36); b.writeUInt32LE(n * 2, 40); writeFileSync(wav, b);
  }
  // answer the NATIVE file chooser the gesture opens, with our fixture
  let nextFile = '';
  await cdp.send('Page.setInterceptFileChooserDialog', { enabled: true });
  cws.addEventListener('message', (ev: any) => {
    const m = JSON.parse(String(ev.data));
    if (m.method === 'Page.fileChooserOpened' && nextFile) void cdp.send('DOM.setFileInputFiles', { files: [nextFile], backendNodeId: m.params.backendNodeId });
  });
  const comp = (t: string) => evalJson(`import('/lib/world.js').then((m) => m.comps.get('crate1')?.${t} ?? null)`);
  // a person's click carries user ACTIVATION, which the file chooser requires (Chrome: "File chooser dialog can only be
  // shown with a user activation"); a plain Runtime.evaluate click does not — say it is a gesture
  const btn = async (label: string) => (await cdp.send<any>('Runtime.evaluate', { userGesture: true, returnByValue: true, expression: `(() => { const b = ${label.startsWith('+ ') ? popItem(label) : `[...${insp}.querySelectorAll('button')].find((x) => x.textContent.trim() === ${JSON.stringify(label)})`}; if (!b) return false; b.click(); return true; })()` }))?.result?.value;
  const field = (label: string, value: string) => evalJson(`(() => { const r = [...${insp}.querySelectorAll('.sp-row')].find((x) => x.querySelector('.sp-label')?.textContent === ${JSON.stringify(label)}); const i = r?.querySelector('input, select'); if (!i) return false; i.value = ${JSON.stringify(value)}; i.dispatchEvent(new Event('change')); return true; })()`);
  await evalJson(`import('/lib/scenegraph.js').then((m) => (m.sceneSelect('crate1'), true))`);
  // was the Components group's "+ picture…" / "+ sound…"; B lists them under Add Component as "+ Picture" /
// "+ Sound" (same gesture keys, comp.add:picture / comp.add:sound, so the same chooser opens)
check('a model with named parts: Add Component offers "+ Picture" and "+ Sound"', await waitFor(`(() => { const t = ${popItems}; return t.includes('+ Picture') && t.includes('+ Sound'); })()`), JSON.stringify(await evalJson(`[...${insp}.querySelectorAll('button')].map((b) => b.textContent.trim())`)));
  nextFile = png;
  check('+ Picture opens the chooser', await btn('+ Picture'));
  check('…the image goes through /upload and hangs on the first named part', await waitFor(`import('/lib/world.js').then((m) => { const p = m.comps.get('crate1')?.picture; return !!p && p.src.startsWith('store/images/') && typeof p.part === 'string' && p.part.length > 0; })`, 10000), JSON.stringify(await comp('picture')) + ' refused=' + JSON.stringify(await evalJson(`window.__refused`)));
  check('the inspector grows a Picture card whose part is a dropdown', await waitFor(`!![...${insp}.querySelectorAll('.sp-f-enum')].find((r) => r.querySelector('.sp-label')?.textContent === 'part')`));
  await field('what it shows', 'a red square, hung by the bench');
  check('typing "what it shows" updates look, keeps src', await waitFor(`import('/lib/world.js').then((m) => m.comps.get('crate1')?.picture?.look === 'a red square, hung by the bench' && m.comps.get('crate1').picture.src.startsWith('store/images/'))`), JSON.stringify(await comp('picture')));
  await field('image', 'https://example.com/x.png');
  await sleep(500);
  check('a URL is refused before the wire (src unchanged)', ((await comp('picture')) as any)?.src?.startsWith('store/images/'), JSON.stringify(await comp('picture')));
  check('the legacy Scene section still shows ONE picture editor, its own (no double from the schema)', await evalJson(`document.querySelectorAll('#sec-scene [data-pe-root]').length === 1 && ![...document.querySelectorAll('#sec-scene [data-fe] .sp-label')].some((l) => l.textContent === 'what it shows')`));
  // was the picture group's "take down"; B's Picture card removes itself (the same comp picture null)
  check('the Picture card\'s "remove Picture" takes it down', (await btn('remove Picture')) && await waitFor(`import('/lib/world.js').then((m) => !m.comps.get('crate1')?.picture)`));
  nextFile = wav;
  check('+ Sound opens the chooser', await btn('+ Sound'));
  check('…the audio goes through /upload and lands PAUSED (no t0)', await waitFor(`import('/lib/world.js').then((m) => { const s = m.comps.get('crate1')?.sound; return !!s && s.src.startsWith('store/audio/') && s.playing === false && s.t0 == null; })`, 10000), JSON.stringify(await comp('sound')) + ' refused=' + JSON.stringify(await evalJson(`window.__refused`)));
  check('▶ play starts it with a t0', (await btn('▶ play')) && await waitFor(`import('/lib/world.js').then((m) => m.comps.get('crate1')?.sound?.playing === true && m.comps.get('crate1').sound.t0 > 0)`), JSON.stringify(await comp('sound')));
  const t0 = ((await comp('sound')) as any)?.t0;
  await sleep(300);
  await field('volume', '0.5');
  check('turning the volume of a PLAYING sound keeps its t0', await waitFor(`import('/lib/world.js').then((m) => m.comps.get('crate1')?.sound?.volume === 0.5 && m.comps.get('crate1').sound.t0 === ${t0})`), JSON.stringify(await comp('sound')));
  // was the sound group's "silence"; B's Sound card removes itself
  check('the Sound card\'s "remove Sound" silences it', (await btn('remove Sound')) && await waitFor(`import('/lib/world.js').then((m) => !m.comps.get('crate1')?.sound)`));
  await cdp.send('Page.setInterceptFileChooserDialog', { enabled: false });
}

console.log('\nrevert to default (↺): shown only when a value differs; an ordinary, undoable edit:');
{
  await evalJson(`import('/lib/scenegraph.js').then((m) => (m.sceneSelect('benchlamp'), true))`);
  await sleep(300);
  const rowOf = (label: string) => `[...${insp}.querySelectorAll('.sp-f-num')].find((r) => r.querySelector('.sp-label')?.textContent === ${JSON.stringify(label)})`;
  const I = () => evalJson(`import('/lib/state.js').then((m) => m.state.st.entities.benchlamp.intensity)`);
  await evalJson(`(() => { const i = ${rowOf('brightness')}.querySelector('.sp-num'); i.value = '16'; i.dispatchEvent(new Event('change')); return true; })()`);
  await waitFor(`import('/lib/state.js').then((m) => m.state.st.entities.benchlamp.intensity === 16)`);
  check('at the default, no ↺', await waitFor(`${rowOf('brightness')}?.querySelector('.sp-revert')?.hidden === true`), JSON.stringify(await I()));
  await evalJson(`(() => { const i = ${rowOf('brightness')}.querySelector('.sp-num'); i.value = '40'; i.dispatchEvent(new Event('change')); return true; })()`);
  check('off the default, ↺ appears (titled with the default)', await waitFor(`(() => { const b = ${rowOf('brightness')}?.querySelector('.sp-revert'); return !!b && b.hidden === false && /16/.test(b.title); })()`), JSON.stringify(await I()));
  // REBUILD the row while it's off-default (select away and back): a row updated in place keeps the
  // field it was BUILT with, and built at 16 a mutant committing f.value instead of f.def passed (09-23)
  await evalJson(`import('/lib/scenegraph.js').then((m) => (m.sceneSelect('crate1'), true))`); await sleep(250);
  await evalJson(`import('/lib/scenegraph.js').then((m) => (m.sceneSelect('benchlamp'), true))`); await sleep(250);
  await waitFor(`${rowOf('brightness')}?.querySelector('.sp-revert')?.hidden === false`);
  await evalJson(`(${rowOf('brightness')}.querySelector('.sp-revert').click(), true)`);
  check('↺ commits the default', await waitFor(`import('/lib/state.js').then((m) => m.state.st.entities.benchlamp.intensity === 16)`), JSON.stringify(await I()));
  check('…and hides itself', await waitFor(`${rowOf('brightness')}?.querySelector('.sp-revert')?.hidden === true`));
  await evalJson(`import('/lib/build.js').then((m) => (m.undo(), true))`);
  check('one undo brings 40 back (revert is an ordinary edit)', await waitFor(`import('/lib/state.js').then((m) => m.state.st.entities.benchlamp.intensity === 40)`), JSON.stringify(await I()));
  check('position has no ↺ (no meaningful default)', await evalJson(`!${rowOf('translate x')}?.querySelector('.sp-revert')`));
}

console.log('\nAdd Component (design §3/§5): categories, blocked entries say why, + Lock adds a Lock card, its remove takes it off:');
{
  await evalJson(`import('/lib/scenegraph.js').then((m) => (m.sceneSelect('benchlamp'), true))`);
  await waitFor(`${insp}.querySelector('.sp-info')?.textContent.startsWith('benchlamp')`);
  const addBtn = (name: string) => name.startsWith('+ ') ? popItem(name) : `[...${insp}.querySelectorAll('.sp-btn')].find((b) => b.textContent.trim() === ${JSON.stringify(name)})`;
  const isLocked = `import('/lib/world.js').then((m) => m.comps.get('benchlamp')?.lock === true)`;
  check('Add Component is ONE button after the cards, and its list groups entries under category captions', await evalJson(`(() => { const G = ${cardTitles}; const b = ${insp}.querySelectorAll('.sp-pop-btn'); if (b.length !== 1 || G.includes('Add Component')) return false; ${insp}.querySelector('.sp-pop-btn').click(); const caps = [...document.querySelectorAll('.sp-pop-cat')].length; document.querySelector('.sp-pop-search')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); return caps >= 3; })()`), JSON.stringify(await evalJson(cardTitles)));
  check('a light is offered "+ Lock"; "+ Model" is there but disabled, titled with why', await evalJson(`(() => { const l = ${addBtn('+ Lock')}, m = ${addBtn('+ Model')}; return !!l && !l.disabled && !!m && m.disabled && (m.title ?? '').length > 10; })()`), JSON.stringify(await evalJson(`(() => { const m = ${addBtn('+ Model')}; return m ? { disabled: m.disabled, why: m.closest('.sp-row')?.title } : null; })()`)));
  await evalJson(`(${addBtn('+ Lock')}.click(), true)`);
  check('+ Lock adds the lock component', await waitFor(isLocked), JSON.stringify(await evalJson(`import('/lib/world.js').then((m) => m.comps.get('benchlamp'))`)) + ' refused=' + JSON.stringify(await evalJson(`window.__refused`)));
  check('…a Lock card appears with its checked "locked" box, and "+ Lock" leaves Add Component', await waitFor(`(() => { const R = [...${insp}.querySelectorAll('.sp-row')]; const i = R.findIndex((r) => r.querySelector('.sp-group')?.textContent === '▾ Lock'); const box = i >= 0 ? R[i + 1]?.querySelector('input[type=checkbox]') : null; return !!box && box.checked && R[i + 1].querySelector('.sp-label')?.textContent === 'locked' && !${addBtn('+ Lock')}; })()`), JSON.stringify(await evalJson(cardTitles)));
  await sleep(600);
  await evalJson(`(${addBtn('remove Lock')}.click(), true)`);
  check('the Lock card\'s "remove Lock" takes the component off, and "+ Lock" is offered again', await waitFor(`import('/lib/world.js').then((m) => !m.comps.get('benchlamp')?.lock) && !${cardTitles}.includes('Lock') && !!${addBtn('+ Lock')}`), JSON.stringify(await evalJson(cardTitles)));
  await sleep(600);
  await evalJson(`import('/lib/build.js').then((m) => (m.undo(), true))`);
  check('one undo puts the Lock back (remove is an ordinary edit)', await waitFor(isLocked));
  await sleep(600);
  await evalJson(`import('/lib/build.js').then((m) => (m.undo(), true))`);
  check('…and one more takes it off again (the add undoes too)', await waitFor(`import('/lib/world.js').then((m) => !m.comps.get('benchlamp')?.lock)`));
}

console.log('\nthe first seat in one step (Add Component ▸ + Seats, which was Components ▸ + seat…):');
{
  await evalJson(`import('/lib/net.js').then((m) => (m.sendVerb('comp', { id: 'crate1', type: 'sockets', data: null }), true))`);
  await evalJson(`import('/lib/scenegraph.js').then((m) => (m.sceneSelect('crate1'), true))`);
  const btn = popItem('+ Seats');
  check('a model without sockets is offered "+ Seats"', await waitFor(`!!${btn}`), JSON.stringify(await evalJson(popItems)));
  await evalJson(`(${btn}.click(), true)`);
  check('clicking it arms seat placement directly (no empty sockets comp first)', await waitFor(`import('/lib/seatedit.js').then((m) => m.seatArmed())`), JSON.stringify(await evalJson(`({ btn: (() => { const b = ${btn}; return b ? { disabled: b.disabled, title: b.closest('.sp-row')?.title } : null; })(), hint: document.querySelector('#hintbar')?.textContent, sel: globalThis.__editPanels?.().selection, errs: (window.__errs ?? []).slice(-3), refused: window.__refused })`)));
  check('…and wrote nothing yet', await evalJson(`import('/lib/world.js').then((m) => !m.comps.get('crate1')?.sockets)`));
  await evalJson(`(document.activeElement?.blur?.(), dispatchEvent(new KeyboardEvent('keydown', { code: 'Escape' })), true)`);
  check('Esc cancels the arming', await waitFor(`import('/lib/seatedit.js').then((m) => !m.seatArmed())`));
  await evalJson(`import('/lib/net.js').then((m) => (m.sendVerb('comp', { id: 'crate1', type: 'sockets', data: { seat: { pos: [0, 0.5, 0], yaw: 0 } } }), true))`);
  check('once it has a seat, "+ Seats" gives way to the Seats card', await waitFor(`!${btn} && ${cardTitles}.includes('Seats')`), JSON.stringify(await evalJson(cardTitles)));
  await evalJson(`import('/lib/net.js').then((m) => (m.sendVerb('comp', { id: 'crate1', type: 'sockets', data: null }), true))`);
}

console.log('\nright-click a field: copy value, paste value, copy path, reset to default:');
{
  await evalJson(`import('/lib/scenegraph.js').then((m) => (m.sceneSelect('benchlamp'), true))`);
  await sleep(300);
  const rowOf = (label: string) => `[...${insp}.querySelectorAll('.sp-f-num')].find((r) => r.querySelector('.sp-label')?.textContent === ${JSON.stringify(label)})`;
  const menuOn = async (label: string) => (await painted(), evalJson(`(() => { const l = ${rowOf(label)}.querySelector('.sp-label'); l.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 1400, clientY: 300 })); return [...document.querySelectorAll('.sp-ctx-item')].map((i) => i.textContent); })()`));
  const pick = (re: string) => evalJson(`(() => { const i = [...document.querySelectorAll('.sp-ctx-item')].find((x) => new RegExp(${JSON.stringify(re)}).test(x.textContent)); i?.click(); return !!i; })()`);
  const E = (k: string) => evalJson(`import('/lib/state.js').then((m) => m.state.st.entities.benchlamp.${k})`);
  await evalJson(`(() => { const i = ${rowOf('brightness')}.querySelector('.sp-num'); i.value = '25'; i.dispatchEvent(new Event('change')); return true; })()`);
  // wait for the PAINT as well as the fold: the menu reads the row's live field, which the rAF-coalesced
  // repaint updates — headless delivers rAF late, and a right-click before it copied the old 40 (seen 10-01)
  await waitFor(`import('/lib/state.js').then((m) => m.state.st.entities.benchlamp.intensity === 25) && ${rowOf('brightness')}?.querySelector('.sp-num').value === '25'`);
  const items = await menuOn('brightness') as string[];
  check('the menu offers copy value, copy path (light.intensity) and reset to default', items.some((t) => /^copy value/.test(t)) && items.some((t) => /copy path\s+\(light\.intensity\)/.test(t)) && items.some((t) => /reset to default/.test(t)), JSON.stringify(items));
  await pick('^copy value');
  check('copy value holds the LIVE value (25)', await evalJson(`import('/lib/panels.js').then((m) => m._fieldClip()?.value === 25)`), JSON.stringify(await evalJson(`import('/lib/panels.js').then((m) => m._fieldClip())`)) + ' fold=' + JSON.stringify(await evalJson(`import('/lib/state.js').then((m) => m.state.st.entities.benchlamp)`)) + ' sel=' + JSON.stringify(await evalJson(`globalThis.__editPanels?.().selection`)) + ' refused=' + JSON.stringify(await evalJson(`window.__refused`)) + ' hint=' + JSON.stringify(await evalJson(`document.querySelector('#hintbar')?.textContent`)) + ' focus=' + JSON.stringify(await evalJson(`(() => { const a = document.activeElement; return a ? [a.tagName, a.className, a.placeholder ?? null, !!a.closest?.('[data-frame]'), a.closest?.('[data-frame]')?.dataset.frame] : null; })()`)) + ' face=' + JSON.stringify(await evalJson(`${rowOf('brightness')}?.querySelector('.sp-num').value`)));
  const rItems = await menuOn('range') as string[];
  check('another number field offers "paste value (25)"', rItems.some((t) => /paste value\s+\(25\)/.test(t)), JSON.stringify(rItems));
  await pick('^paste value');
  check('paste commits it: range = 25', await waitFor(`import('/lib/state.js').then((m) => m.state.st.entities.benchlamp.range === 25)`), JSON.stringify(await E('range')));
  await menuOn('range'); await pick('reset to default');
  check('reset to default: range = 10', await waitFor(`import('/lib/state.js').then((m) => m.state.st.entities.benchlamp.range === 10)`), JSON.stringify(await E('range')));
  await menuOn('brightness'); await pick('^copy path');
  check('copy path puts the address a model uses on the clip', await evalJson(`import('/lib/panels.js').then((m) => m._fieldClip()?.value === 'light.intensity')`));
}

console.log('\ninspector filter: retired (R 10-04: it did nothing useful in a panel this small); client-check I2 checks it is gone');
check('the Inspector has no filter box', await evalJson(`![...${insp}.querySelectorAll('.sp-text')].some((x) => /filter properties/.test(x.placeholder ?? ''))`));

console.log('\nrename in the tree: double-click, F2, or the row menu; commits the label comp:');
{
  const label = () => evalJson(`import('/lib/world.js').then((m) => m.comps.get('crate1')?.label ?? null)`);
  const rowOf = `[...${hier}.querySelectorAll('.sp-tree-row')].find((x) => x.dataset.id === 'crate1')`;
  await evalJson(`import('/lib/scenegraph.js').then((m) => (m.sceneSelect('crate1'), true))`);
  await sleep(300);
  await evalJson(`(${rowOf}.querySelector('.sp-item-main').dispatchEvent(new MouseEvent('dblclick', { bubbles: true })), true)`);
  check('double-click swaps the label for an input', await waitFor(`!!${rowOf}?.querySelector('input.sp-rename')`));
  await evalJson(`(() => { const i = ${rowOf}.querySelector('input.sp-rename'); i.value = 'the old bell'; i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); return true; })()`);
  check('Enter commits the label comp', await waitFor(`import('/lib/world.js').then((m) => m.comps.get('crate1')?.label === 'the old bell')`), JSON.stringify(await label()));
  check('…and the row shows it', await waitFor(`/the old bell/.test(${rowOf}?.querySelector('.sp-item-label')?.textContent ?? '')`));
  await evalJson(`(() => { const sc = ${hier}.querySelector('.schema-scroll'); sc.focus(); sc.dispatchEvent(new KeyboardEvent('keydown', { code: 'F2', key: 'F2', bubbles: true })); return true; })()`);
  check('F2 on the focused tree renames the selected row', await waitFor(`!!${rowOf}?.querySelector('input.sp-rename')`));
  await evalJson(`(() => { const i = ${rowOf}.querySelector('input.sp-rename'); i.value = 'nope'; i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); return true; })()`);
  await sleep(400);
  check('Esc cancels: the label is unchanged', (await label()) === 'the old bell', JSON.stringify(await label()));
  await evalJson(`(${rowOf}.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 200, clientY: 200 })), true)`);
  await evalJson(`([...document.querySelectorAll('.sp-ctx-item')].find((i) => /rename/.test(i.textContent))?.click(), true)`);
  check('the row menu has "rename (F2)" and it opens the input', await waitFor(`!!${rowOf}?.querySelector('input.sp-rename')`));
  await evalJson(`(() => { const i = ${rowOf}.querySelector('input.sp-rename'); i.value = ''; i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); return true; })()`);
  check('an empty name clears the label (the row shows its id again)', await waitFor(`import('/lib/world.js').then((m) => m.comps.get('crate1')?.label == null)`), JSON.stringify(await label()));
}

console.log('\nJSON: raw comps as a multi-line editor; every typed group keeps a { } JSON hatch:');
{
  const V = (v: string, a: any) => evalJson(`import('/lib/net.js').then((m) => (m.sendVerb('${v}', ${JSON.stringify(a)}), true))`);
  const comp = (t: string) => evalJson(`import('/lib/world.js').then((m) => m.comps.get('crate1')?.[${JSON.stringify(t)}] ?? null)`);
  await V('comp', { id: 'crate1', type: 'recipe', data: { wood: 2 } });
  await V('comp', { id: 'crate1', type: 'sockets', data: { seat: { pos: [0, 0.5, 0], yaw: 0 } } });
  await evalJson(`import('/lib/scenegraph.js').then((m) => (m.sceneSelect('crate1'), true))`);
  const rowTa = (label: string) => `[...${insp}.querySelectorAll('.sp-f-json')].find((r) => r.querySelector('.sp-label')?.textContent === ${JSON.stringify(label)})?.querySelector('.sp-json-ta')`;
  check('a raw comp is a multi-line JSON editor, pretty-printed', await waitFor(`(() => { const t = ${rowTa('recipe')}; return !!t && t.value.includes('\\n') && /"wood": 2/.test(t.value); })()`), JSON.stringify(await evalJson(`${rowTa('recipe')}?.value ?? null`)));
  const typeInto = (sel: string, text: string) => evalJson(`(() => { const t = ${sel}; t.focus(); t.value = ${JSON.stringify(text)}; t.dispatchEvent(new Event('input')); t.blur(); return t.classList.contains('bad'); })()`);
  check('invalid JSON marks the box red…', await typeInto(rowTa('recipe'), '{ "wood": 3,'));
  await sleep(500);
  check('…and commits nothing', JSON.stringify(await comp('recipe')) === '{"wood":2}', JSON.stringify(await comp('recipe')));
  await typeInto(rowTa('recipe'), '{\n  "wood": 3,\n  "nails": 12\n}');
  check('valid JSON commits on blur (wholesale)', await waitFor(`import('/lib/world.js').then((m) => JSON.stringify(m.comps.get('crate1')?.recipe) === '{"wood":3,"nails":12}')`), JSON.stringify(await comp('recipe')));
  const hatch = `[...${insp}.querySelectorAll('.sp-json-tog')].map((b) => b.closest('.sp-row')).find((r) => /"seat"/.test(r.querySelector('.sp-json-ta')?.value ?? ''))`;
  check('the sockets group has a collapsed { } JSON hatch', await waitFor(`(() => { const r = ${hatch}; return !!r && r.querySelector('.sp-json-ta').hidden === true; })()`));
  await evalJson(`(${hatch}.querySelector('.sp-json-tog').click(), true)`);
  check('the toggle opens it', await evalJson(`${hatch}.querySelector('.sp-json-ta').hidden === false`));
  await typeInto(`${hatch}.querySelector('.sp-json-ta')`, JSON.stringify({ seat: { pos: [0, 0.5, 0], yaw: 0, part: 'plank' } }, null, 2));
  check('a key no field speaks for (socket part) is editable through the hatch', await waitFor(`import('/lib/world.js').then((m) => m.comps.get('crate1')?.sockets?.seat?.part === 'plank')`), JSON.stringify(await comp('sockets')));
  await V('comp', { id: 'crate1', type: 'recipe', data: null });
  await V('comp', { id: 'crate1', type: 'sockets', data: null });
}

console.log('\nConsole: every bound script, and one script\'s live world.log() (the legacy 📜 scripts panel, as a frame):');
{
  const con = `document.querySelector('[data-frame="console"]')`;
  const src = `world.log('bench says hello'); world.every(5, () => world.log('tick'));`;
  const up = await evalJson(`fetch('/upload?as=script', { method: 'POST', body: ${JSON.stringify(src)} }).then((r) => r.json()).then((j) => j.path ?? JSON.stringify(j))`);
  check('a script uploads into the store', typeof up === 'string' && up.startsWith('store/scripts/'), String(up));
  await evalJson(`import('/lib/net.js').then((m) => (m.sendVerb('behavior', { id: 'benchbhv', src: ${JSON.stringify(up)}, attach: 'crate1' }), true))`);
  await evalJson(`import('/lib/scenegraph.js').then((m) => (m.sceneSelect('crate1'), true))`);
  check('the inspector lists it under Behaviors', await waitFor(`[...${insp}.querySelectorAll('.sp-item-label')].some((l) => /benchbhv/.test(l.textContent))`, 12000), JSON.stringify(await evalJson(`globalThis.__editPanels?.().behaviors`)));
  check('the Console is not open yet', await evalJson(`getComputedStyle(${con}).display === 'none'`));
  await evalJson(`(() => { const l = [...${insp}.querySelectorAll('.sp-item-main')].find((m) => /benchbhv/.test(m.textContent)); l?.click(); return !!l; })()`);
  check('clicking the script row opens the Console, watching it', await waitFor(`getComputedStyle(${con}).display !== 'none' && globalThis.__editPanels?.().watching === 'benchbhv'`), JSON.stringify(await evalJson(`globalThis.__editPanels?.()`)));
  check('its world.log() line is in the log', await waitFor(`/bench says hello/.test(${con}.querySelector('.sp-log')?.textContent ?? '')`, 8000), JSON.stringify(await evalJson(`${con}.querySelector('.sp-log')?.textContent ?? null`)));
  check('the header says it is running', await evalJson(`/benchbhv — running/.test(${con}.textContent)`), await evalJson(`${con}.querySelector('.sp-group')?.textContent ?? null`));
  check('View ▸ lists the console', await evalJson(`(() => { const b = [...document.querySelectorAll('.edit-menu > .edit-btn')].find((x) => /^View/.test(x.textContent)); b.click(); const t = [...document.querySelectorAll('.edit-menu-item')].map((i) => i.textContent); document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); return t.some((x) => /console/.test(x)); })()`));
  await evalJson(`(() => { const r = [...${con}.querySelectorAll('.sp-item')].find((x) => /benchbhv/.test(x.textContent)); [...r.querySelectorAll('button')].find((b) => b.textContent === 'unbind').click(); return true; })()`);
  check('unbind from the Console removes it from the roster', await waitFor(`!(globalThis.__editPanels?.().behaviors)`, 10000), JSON.stringify(await evalJson(`globalThis.__editPanels?.().behaviors`)));
  await evalJson(`(${con}.querySelector('.fr-btn')?.click(), true)`);
}

console.log('\nleaving:');
await evalJson(`dispatchEvent(new KeyboardEvent('keydown', { code: 'Escape' })), true`);
await sleep(200);
await evalJson(`dispatchEvent(new KeyboardEvent('keydown', { code: 'Escape' })), true`);   // deselect, then leave
check('leaving undocks: frames are back on the body, workspace chrome hidden', await waitFor(`document.querySelector('[data-frame="hierarchy"]').parentElement === document.body && document.querySelector('[data-frame="inspector"]').parentElement === document.body && document.querySelector('.edit-top').hidden && !document.querySelector('.frame.docked')`));
check('Esc hides the frames (Build among them)', await waitFor(`(() => { const F = [...document.querySelectorAll('.frame.edit')]; return F.length === 4 && F.every((f) => getComputedStyle(f).display === 'none'); })()`));
// `hidden` is an attribute; the strips' own display:flex outranks the UA's [hidden] — so ask what is PAINTED
check('…and the workspace chrome is not painted any more (bar, rail, columns, tool strip)', await waitFor(`[...document.querySelectorAll('.edit-strip, .edit-col, .edit-split-v, .edit-toolstrip')].every((e) => getComputedStyle(e).display === 'none')`), JSON.stringify(await evalJson(`[...document.querySelectorAll('.edit-strip, .edit-col, .edit-split-v, .edit-toolstrip')].map((e) => e.className + ':' + getComputedStyle(e).display)`)));
check('…and the ∃ is back on the HUD, its glyphs beside it', await evalJson(`(() => { const h = document.querySelector('#hud').getBoundingClientRect(), m = document.querySelector('#micbtn').getBoundingClientRect(); const hit = document.elementFromPoint(h.left + h.width / 2, h.top + h.height / 2); return (hit === document.querySelector('#hud') || document.querySelector('#hud').contains(hit)) && m.left >= h.right && Math.abs((m.top + m.bottom) / 2 - (h.top + h.bottom) / 2) <= 2; })()`));
const errs: string[] = (await evalJson(`window.__errs`)) ?? [];
const mine = errs.filter((e) => /editpanels|editlayout|editschema|panels\.js|inspect\.js|lights\.js|seatedit|scenegraph/.test(e));
check('no page errors from the edit surface', mine.length === 0, mine.slice(0, 3).join(' | '));

console.log(`\n${tally.passed} passed, ${tally.failed} failed`);
if (tally.failed) await die(1, 'editpanels-bench: FAILED');
await cleanup();
process.exit(0);
