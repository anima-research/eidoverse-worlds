// rowcontrols-probe — the entity row controls (R 10-12): the Inspector header's ENABLED box on all three surfaces, the
// Hierarchy's [☑][name][👁][🔒] columns, and the eye that hides a thing for ME only.
//
//   code/scripts/eido-probe.sh -C <worktree> -t 400 tools/rowcontrols-probe.ts
//
// A real browser against an owned world. The owner places a crate (a GLB: it has a collider; `clickthrough` gives it a
// component row), a second crate, and a child riding the first.
//   H  the Inspector header leads with an ENABLED box (no power button): on the desktop frame, the legacy quad and the
//      edit quad, the box switches the thing off (the `disabled` component) and back on; switched off, the Inspector is
//      the unticked box + the name + a state line, and the quads still paint the box
//   R  every entity row is [☑][name][👁][🔒] in that order; the eye and lock columns sit at one x down the list; a row
//      with no box (a component row) starts its name where a boxed row at its depth does; the row box switches off and
//      on; a switched-off row is marked off; both quads paint the box and the eye as targets
//   E  the eye: hiding writes nothing to the log (a known write after it is the only new entry) and is kept in this
//      browser; the hidden thing is not drawn and a viewport click there does not select it (it did, before hiding);
//      it still collides (my body standing in it is pushed out); my body bumping it fades in a hazy outline with a
//      crossed-out eye that fades out after the contact ends; a crate I did NOT hide shows no outline; the Hierarchy row
//      still selects it; its eye is tinted "only you"
// Hygiene (memory reference_browser_probe_hygiene.md): teardown in finally, a failed gate stops with its reason, waits are
// on conditions, every evaluate races a clock.
import fs from 'node:fs';
import path from 'node:path';
import { scratchBench, mkCheck, sleep } from './harness.ts';
import { pagedEval } from './protocol/idalias.ts';

const WORLD = 'rows', CRATE = 'eidoverse/assets/models/crate_large_blue.glb';
const { evalJson: evalRaw, cleanup, die, cdp, BASE, SCRATCH } = await scratchBench('rowcontrols', { worlds: [WORLD], owner: 'editbot', serverEnv: { TRUST_NAMES: '1', VERB_RATE: '1000' } });
// R 10-17: the page names what it makes with placeholders (tools/protocol/idalias.ts pageIds); quoted scene names in page
// code are read as ids, every answer brings the minted ids back, and N(name) reads one for the node-side checks
const NAMES = ["crate", "box2", "cup", "toy", "lamp", "deep1", "deep2", "deep3", "deep4", "deep5", "deep6"]; const NODE = new Map<string, string>(); const N = (n: string) => NODE.get(n) ?? n;
const evalJson = pagedEval(evalRaw, NAMES, NODE);
const { check, tally } = mkCheck();
const ev = (e: string, ms = 15000) => Promise.race([evalJson(e), sleep(ms).then(() => { throw new Error(`evaluate timed out after ${ms} ms: ${e.slice(0, 90)}`); })]);
const waitFor = async (e: string, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await ev(e).catch(() => false)) return true; await sleep(100); } return false; };
const painted = () => ev(`new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true))))`);
const LOG = () => path.join(SCRATCH, 'worlds', WORLD, 'world.jsonl');
const logLines = () => fs.readFileSync(LOG(), 'utf8').split('\n').filter(Boolean);
const D = `(await import('/lib/editpanels.js')).editPanelsDebug()`;
const offOf = (id: string) => `(await import('/lib/net.js')).replica.st.entities['${id}']?.c?.disabled === true`;
const log = (k: string, v: unknown) => console.log(`  · ${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`);
const gate = async (name: string, ok: boolean, detail = '') => { check(name, ok, detail); if (!ok) await die(1, `gate failed: ${name}`, detail, JSON.stringify(await ev(`window.__errs`).catch(() => 'unreadable'))); };

try {
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: `window.__errs = []; addEventListener('error', (e) => __errs.push('error: ' + e.message));
    window.__mangle = null; const WS = WebSocket.prototype.send; WebSocket.prototype.send = function (d) { if (window.__mangle && typeof d === 'string' && d.includes('"request"') && d.includes('disabled')) { d = d.split(window.__mangle[0]).join(window.__mangle[1]); window.__mangle = null; } return WS.call(this, d); };
    window.__hints = []; new MutationObserver(() => { const h = document.getElementById('hintbar'); if (h) { const t = h.textContent.trim(); if (t && window.__hints.at(-1) !== t) { window.__hints.push(t); (window.__hintT ??= []).push([Math.round(performance.now()), t.slice(0, 40)]); } } }).observe(document, { subtree: true, childList: true, characterData: true });` });
  await cdp.send('Page.navigate', { url: `${BASE}/?name=editbot&world=${WORLD}` });
  let secs = 0;
  for (let i = 0; i < 120 && secs < 4; i++) { secs = (await ev(`document.querySelectorAll('.sec').length`).catch(() => 0)) ?? 0; if (secs < 4) await sleep(500); }
  await gate('client boots', secs >= 4, `${secs} sections`);
  await gate('the fold is live', await waitFor(`import('/lib/net.js').then((m) => m.replica.active)`, 20000));
  await ev(`dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyB' })), true`);
  await gate('edit mode', await waitFor(`[...document.querySelectorAll('.frame.edit')].some((f) => getComputedStyle(f).display !== 'none')`));
  await ev(`(() => { document.querySelector('.edit-tabs:not(.edit-rtabs) .edit-tab[data-tab="hierarchy"]')?.click(); return true; })()`);
  await gate('the Hierarchy tab is showing', await waitFor(`(() => { const f = document.querySelector('[data-frame="hierarchy"]'); return !!f && f.getBoundingClientRect().width > 100; })()`));

  // the crate goes 5 m along the camera's view, so a click at its projected centre is a click on it
  const at = await ev(`(async () => { const { camera, THREE } = await import('/lib/core.js'); const p = camera.getWorldPosition(new THREE.Vector3()), d = camera.getWorldDirection(new THREE.Vector3()); d.y = 0; d.normalize(); return [p.x + d.x * 5, p.z + d.z * 5]; })()`);
  const mk = (id: string, x: number, z: number, extra = '') => ev(`import('/lib/net.js').then((m) => m.sendRequest('create', { id: '${id}', model: '${CRATE}', components: { transform: { pos: [${x}, 0, ${z}], q: [0, 0, 0, 1], scale: [1, 1, 1] }, label: '${id}' ${extra} } }))`);
  const made = [await mk('crate', at[0], at[1], `, clickthrough: true`), await mk('box2', at[0] + 6, at[1] + 6), await mk('cup', 0, 1.5, `, parent: { to: 'crate', order: 'a0' }`),
    await mk('toy', at[0] - 7, at[1] + 7, `, grabbable: { who: 'visitor' }, sockets: { seat: { pos: [0, 0.5, 0], body: {} } }, openable: { open: false }, reactions: { open: { kind: 'toggle', component: 'openable', field: 'open' } }`)];
  check('(setup) the owner places a crate, a second crate, a cup riding the first, and a toy to grab, use and sit on', made.every((r: any) => r?.ok === true), JSON.stringify(made.map((r: any) => r?.refused ?? 'ok')));
  await gate('(setup) …all three realized, the crate with a collider', await waitFor(`Promise.all([import('/lib/world.js'), import('/lib/colliders.js')]).then(([w, c]) => ['crate', 'box2', 'cup', 'toy'].every((k) => w.entities.get(k)) && c.colliders.has('crate'))`, 30000));
  await ev(`import('/lib/scenegraph.js').then((m) => m.sceneSelect('crate')), true`);
  await gate('(setup) the crate is selected', await waitFor(`(async () => ${D}.selected === 'crate')()`));
  await painted();

  // ---------------------------------------------------------------- H: the Inspector header's ENABLED box
  const head = () => ev(`(() => { const f = document.querySelector('[data-frame="inspector"]'); const box = f?.querySelector('.sp-row.sp-enabled input[type=checkbox]'); const title = f?.querySelector('.sp-row.sp-title');
    return { box: !!box, checked: box?.checked ?? null, before: !!(box && title && (box.compareDocumentPosition(title) & Node.DOCUMENT_POSITION_FOLLOWING)), state: [...(f?.querySelectorAll('.sp-row') ?? [])].some((r) => /switched off: nobody/.test(r.textContent)), name: title?.textContent?.trim() || title?.querySelector('input')?.value || null }; })()`);
  const h0 = await head();
  check('H1 the desktop Inspector header leads with a ticked ENABLED box, before the name', h0.box && h0.checked === true && h0.before, JSON.stringify(h0));
  const fieldsNow = await ev(`(async () => ${D}.inspFields().map((f) => f.k))()`);
  check('H1 …and no power button (the switch-it-back-on button is gone)', !fieldsNow.includes('hoff'), JSON.stringify(fieldsNow.slice(0, 8)));
  await ev(`(() => { const b = document.querySelector('[data-frame="inspector"] .sp-row.sp-enabled input[type=checkbox]'); b?.click(); return !!b; })()`);
  check('H2 desktop: unticking it switches the crate off (the record says disabled)', await waitFor(`(async () => ${offOf('crate')})()`));
  await painted(); await painted();
  const h1 = await head();
  check('H2 …switched off, the Inspector is the unticked box + the name + a state line', h1.box && h1.checked === false && h1.before && h1.state && h1.name === 'crate', JSON.stringify(h1));
  await ev(`(() => { const b = document.querySelector('[data-frame="inspector"] .sp-row.sp-enabled input[type=checkbox]'); b?.click(); return !!b; })()`);
  check('H2 …ticking it switches the crate back on', await waitFor(`(async () => !(${offOf('crate')}))()`));
  await gate('(setup) …and it is realized again', await waitFor(`import('/lib/world.js').then((w) => !!w.entities.get('crate'))`, 20000));
  await ev(`import('/lib/scenegraph.js').then((m) => m.sceneSelect('crate')), true`); await painted();
  for (const [surf, opt] of [['legacy', '{}'], ['edit', `{ theme: 'edit' }`]] as const) {
    const hit = (want: string) => ev(`(async () => { const P = await import('/lib/panels.js'); const c = document.createElement('canvas'); const regs = P.renderCanvas(c, ${D}.inspFields(), ${opt}); const r = regs.find((x) => x.action === 'henabled'); return r ? { payload: r.payload ${want} } : null; })()`);
    const r0 = await hit('');
    check(`H3 ${surf} quad: the header paints the ENABLED box as a target (it would switch off)`, r0?.payload === false, JSON.stringify(r0));
    if (r0) await ev(`(async () => { ${D}.inspDo?.('henabled', ${JSON.stringify(r0.payload)}); return true; })()`);
    check(`H3 ${surf} quad: its target switches the crate off`, await waitFor(`(async () => ${offOf('crate')})()`));
    await painted();
    const r1 = await hit('');
    check(`H3 ${surf} quad: switched off, the quad still paints the box (it would switch on)`, r1?.payload === true, JSON.stringify(r1));
    if (r1) await ev(`(async () => { ${D}.inspDo?.('henabled', true); return true; })()`);
    check(`H3 ${surf} quad: …and switches it back on`, await waitFor(`(async () => !(${offOf('crate')}))()`));
    await gate(`(setup) …realized again after the ${surf} quad`, await waitFor(`import('/lib/world.js').then((w) => !!w.entities.get('crate'))`, 20000));
    await ev(`import('/lib/scenegraph.js').then((m) => m.sceneSelect('crate')), true`); await painted();
  }

  // ---------------------------------------------------------------- R: the Hierarchy's columns
  await ev(`(async () => { ${D}.hierDo?.('fold:all-open'); return true; })()`); await painted(); await painted();
  const cols = await ev(`(() => { const out = {}; for (const [k, id] of [['k:crate', 'crate'], ['k:box2', 'box2'], ['k:cup', 'cup']]) { const row = document.querySelector('[data-frame="hierarchy"] .sp-tree-row[data-id="' + id + '"]'); if (!row) { out[k.slice(2)] = null; continue; }
      const kids = [...row.children].map((e) => e.classList.contains('sp-row-on') ? 'box' : e.classList.contains('sp-item-main') ? 'name' : e.classList.contains('sp-eye') ? 'eye' : e.classList.contains('sp-lock') ? 'lock' : null).filter(Boolean);
      const x = (s) => Math.round(row.querySelector(s)?.getBoundingClientRect().left ?? -1);
      out[k.slice(2)] = { order: kids.join(','), box: x('.sp-row-on'), name: x('.sp-item-label'), eye: x('.sp-eye'), lock: x('.sp-lock') }; } return out; })()`);
  check('R1 every entity row is [☑][name][👁][🔒], in that order', ['crate', 'box2', 'cup'].every((k) => cols[k]?.order === 'box,name,eye,lock'), JSON.stringify(cols));
  check('R1 …the eye and the lock columns sit at one x down the list', cols.crate && cols.crate.eye === cols.box2.eye && cols.box2.eye === cols.cup.eye && cols.crate.lock === cols.cup.lock && cols.crate.eye > 0, JSON.stringify(cols));
  check('R1 …and two rows at one depth start their box and name at one x', cols.crate?.box === cols.box2?.box && cols.crate?.name === cols.box2?.name && cols.cup?.name > cols.crate?.name, JSON.stringify(cols));
  await ev(`(async () => { ${D}.hierDo?.('hopt:comps'); ${D}.hierDo?.('fold:all-open'); return true; })()`); await painted(); await painted();
  const comp = await ev(`(() => { const r = document.querySelector('[data-frame="hierarchy"] .sp-tree-row[data-id^="comp:' + 'crate' + ':"]'); const cup = document.querySelector('[data-frame="hierarchy"] .sp-tree-row[data-id="cup"]');
    const x = (row) => Math.round(row?.querySelector('.sp-item-label')?.getBoundingClientRect().left ?? -1); return { id: r?.dataset.id ?? null, comp: x(r), cup: x(cup), rows: [r, cup].map((row) => [...(row?.children ?? [])].map((e) => e.className.split(' ')[0] + '@' + Math.round(e.getBoundingClientRect().left) + '+' + Math.round(e.getBoundingClientRect().width) + ':' + getComputedStyle(e).marginLeft + '/' + getComputedStyle(e).marginRight).join(' ')) }; })()`);
  check('R1 a row with no box (a component row) starts its name where a boxed row at its depth does', comp.id && comp.comp === comp.cup && comp.cup > 0, JSON.stringify(comp));
  await ev(`(async () => { ${D}.hierDo?.('hopt:comps'); return true; })()`); await painted();
  await ev(`(() => { const b = document.querySelector('[data-frame="hierarchy"] .sp-tree-row[data-id="box2"] .sp-row-on'); b?.click(); return !!b; })()`);
  check('R2 the row box switches box2 off', await waitFor(`(async () => ${offOf('box2')})()`));
  check('R2 …its row is marked off and its box unticked', await waitFor(`(() => { const r = document.querySelector('[data-frame="hierarchy"] .sp-tree-row[data-id="box2"]'); return !!r && r.classList.contains('off') && r.querySelector('.sp-row-on')?.checked === false; })()`));
  await ev(`(() => { const b = document.querySelector('[data-frame="hierarchy"] .sp-tree-row[data-id="box2"] .sp-row-on'); b?.click(); return !!b; })()`);
  check('R2 …and back on', await waitFor(`(async () => !(${offOf('box2')}))()`));
  for (const [surf, opt] of [['legacy', '{}'], ['edit', `{ theme: 'edit' }`]] as const) {
    const regs = await ev(`(async () => { const P = await import('/lib/panels.js'); const c = document.createElement('canvas'); return P.renderCanvas(c, ${D}.hierFields(), ${opt}).filter((r) => (r.action === 'enable' && r.payload?.id === 'crate') || (r.action === 'myhide' && r.payload === 'crate') || (r.action === 'lock' && r.payload === 'crate')).map((r) => ({ a: r.action, x: Math.round(r.x), h: Math.round(r.h) })); })()`);
    const a = (k: string) => regs.find((r: any) => r.a === k);
    check(`R3 ${surf} quad: the crate's row paints the box, the eye and the lock as targets, left to right`, a('enable') && a('myhide') && a('lock') && a('enable').x < a('myhide').x && a('myhide').x < a('lock').x, JSON.stringify(regs));
  }

  // ---------------------------------------------------------------- E: the eye, mine only
  const n0 = logLines().length;
  // the camera is turned to face it and put back inside one task, so no frame sees the turn
  const click = (id: string) => ev(`(async () => { const { camera, THREE } = await import('/lib/core.js'); const w = await import('/lib/world.js'); const b = await import('/lib/build.js'); const o = w.entities.get('${id}');
    const q = camera.quaternion.clone(); const ctr = new THREE.Box3().setFromObject(o).getCenter(new THREE.Vector3()); camera.lookAt(ctr); camera.updateMatrixWorld(true);
    try { const c = ctr.clone().project(camera); return b.pickAt ? b.pickAt(c.x, c.y) : 'no pickAt'; } finally { camera.quaternion.copy(q); camera.updateMatrixWorld(true); } })()`);
  const why = (id: string) => ev(`(async () => { const { camera, THREE } = await import('/lib/core.js'); const w = await import('/lib/world.js'); const o = w.entities.get('${id}'); const c = new THREE.Box3().setFromObject(o).getCenter(new THREE.Vector3()).project(camera); const rc = new THREE.Raycaster(); rc.setFromCamera(new THREE.Vector2(c.x, c.y), camera); const hits = rc.intersectObject(o, true); return { ndc: [c.x, c.y, c.z].map((v) => +v.toFixed(3)), raw: hits.length, layer: (await import('/shared/layers.js')).layerOf((await import('/lib/state.js')).state.st.entities, '${id}') }; })()`).catch((e) => String(e));
  const before = await click('crate');
  check('E0 (control) before hiding, a viewport click at the crate selects the crate', before === N('crate'), JSON.stringify({ before, why: await why('crate') }));
  await ev(`(async () => { ${D}.hierDo?.('myhide', 'crate'); return true; })()`);
  check('E1 the eye hides it in my view: not drawn', await waitFor(`import('/lib/world.js').then((w) => w.entities.get('crate')?.visible === false)`));
  check('E1 …kept in this browser, per world', await ev(`(() => { try { return JSON.parse(localStorage.getItem('ew-myhidden-${WORLD}') ?? '[]').includes('crate'); } catch { return false; } })()`));
  const after = await click('crate');
  check('E2 a viewport click at the hidden crate does not select it', after !== 'crate' && after !== 'cup', JSON.stringify(after));
  check('E3 the Hierarchy row still selects it', await ev(`(async () => { ${D}.hierDo?.('sel', 'box2'); ${D}.hierDo?.('sel', 'crate'); return ${D}.selected === 'crate'; })()`));
  await painted();
  const eye = await ev(`(() => { const e = document.querySelector('[data-frame="hierarchy"] .sp-tree-row[data-id="crate"] .sp-eye'); return e ? { on: e.classList.contains('on'), color: getComputedStyle(e).color, title: e.title } : null; })()`);
  check('E4 its row eye is on, tinted "only you" (not the accent of a shared switch), and says so', eye?.on && eye.color === 'rgb(176, 138, 216)' && /^Only you/.test(eye.title), JSON.stringify(eye));
  // a known write after the hide: the log grows by exactly that one entry
  const ren = await ev(`import('/lib/net.js').then((m) => m.sendRequest('set', { id: 'box2', component: 'label', value: 'box two' }))`);
  check('(setup) a known write (rename box2) lands', ren?.ok === true && await waitFor(`import('/lib/net.js').then((m) => m.replica.st.entities['box2']?.c.label === 'box two')`), JSON.stringify(ren?.refused));
  await ev(`(async () => { ${D}.hierDo?.('myhide', 'box2'); ${D}.hierDo?.('myhide', 'box2'); return true; })()`);
  await sleep(600);
  const added = logLines().slice(n0).map((l) => JSON.parse(l));
  const acts = added.filter((e) => e.kind === 'act');
  check('E5 hiding wrote nothing to the log: the rename is the only new act', acts.length === 1 && /box two/.test(JSON.stringify(acts[0])) && added.every((e) => e.kind !== 'act' || e === acts[0]),
    `${added.length} entries, ${acts.length} acts: ${added.map((e) => JSON.stringify(e).slice(0, 200)).join(' | ')}`);

  // collision: my body put inside the hidden crate is pushed out, and the bump mark comes up
  const into = (id: string) => ev(`(async () => { const w = await import('/lib/world.js'); const c = await import('/lib/controller.js'); const o = w.entities.get('${id}'); c.myState.pos.set(o.position.x + 0.05, o.position.y, o.position.z + 0.05); return [c.myState.pos.x, c.myState.pos.z]; })()`);
  const pushedOut = (id: string) => ev(`(async () => { const w = await import('/lib/world.js'); const c = await import('/lib/controller.js'); const o = w.entities.get('${id}'); return Math.hypot(c.myState.pos.x - o.position.x, c.myState.pos.z - o.position.z) > 0.3; })()`);
  const marks = () => ev(`import('/lib/hiddenbump.js').then((m) => m.bumpMarks())`).catch(() => []);
  await into('crate');
  check('E6 the hidden crate still collides: my body standing in it is pushed out', await waitFor(`(async () => { const w = await import('/lib/world.js'); const c = await import('/lib/controller.js'); const o = w.entities.get('crate'); return Math.hypot(c.myState.pos.x - o.position.x, c.myState.pos.z - o.position.z) > 0.3; })()`, 5000));
  let peak: any = null;
  { const t0 = Date.now(); while (Date.now() - t0 < 4000) { await into('crate'); await painted(); const m = (await marks()).find((x: any) => x.id === N('crate')); if (m && m.a > (peak?.a ?? 0)) peak = m; if (peak?.a >= 0.5) break; } }
  check('E7 bumping it fades in its outline with the crossed-out eye ("you hid this")', peak && peak.a >= 0.5 && peak.eye > 0.4, JSON.stringify(peak));
  await ev(`(async () => { const c = await import('/lib/controller.js'); const w = await import('/lib/world.js'); const o = w.entities.get('crate'); c.myState.pos.set(o.position.x - 12, o.position.y, o.position.z - 12); return true; })()`);
  check('E8 …and it fades out after the contact ends', !!peak && await waitFor(`import('/lib/hiddenbump.js').then((m) => !m.bumpMarks().some((x) => x.id === 'crate'))`, 5000), JSON.stringify(await marks()));
  // a crate I did not hide: solid, and no mark
  let seen: any[] = [];
  { const t0 = Date.now(); while (Date.now() - t0 < 1500) { await into('box2'); await painted(); seen = seen.concat(await marks()); } }
  check('E9 (control) a crate I did not hide pushes me out too, and shows no mark', await pushedOut('box2') && !seen.some((x: any) => x.id === N('box2')), JSON.stringify(seen.slice(0, 3)));
  await ev(`(async () => { ${D}.hierDo?.('myhide', 'crate'); return true; })()`);
  check('E10 the eye again shows it: drawn', await waitFor(`import('/lib/world.js').then((w) => w.entities.get('crate')?.visible === true)`));
  const back = await click('crate');
  check('E10 …and a viewport click lands on it again (the crate, or the cup riding it)', back === N('crate') || back === N('cup'), JSON.stringify({ back, why: await why('crate') }));

  // ---------------------------------------------------------------- S3-5: my private view never shapes a shared write
  await ev(`(async () => { ${D}.hierDo?.('myhide', 'crate'); return true; })()`);
  const aimY = await ev(`(async () => { const { camera, canvas, THREE } = await import('/lib/core.js'); const w = await import('/lib/world.js'); const cu = await import('/lib/clickuse.js'); const o = w.entities.get('crate');
    const q = camera.quaternion.clone(); const b = new THREE.Box3().setFromObject(o); const top = new THREE.Vector3((b.min.x + b.max.x) / 2, b.max.y - 0.02, (b.min.z + b.max.z) / 2); camera.lookAt(top); camera.updateMatrixWorld(true);
    try { const n = top.clone().project(camera), r = canvas.getBoundingClientRect(); const p = cu.clickUseApi.aimPoint((n.x + 1) / 2 * r.width + r.left, (1 - n.y) / 2 * r.height + r.top); return { y: p?.[1] ?? null, top: b.max.y, n: [n.x, n.y, n.z].map((v) => +v.toFixed(2)), rect: [r.width, r.height] }; } finally { camera.quaternion.copy(q); camera.updateMatrixWorld(true); } })()`);
  check('S5 a put aimed at a thing hidden in my view lands ON it (it is solid for everyone), not on the floor inside it', aimY?.y != null && aimY.y > aimY.top - 0.3, JSON.stringify(aimY));
  await ev(`(async () => { ${D}.hierDo?.('myhide', 'crate'); return true; })()`);

  // ---------------------------------------------------------------- P: no proximity verb offers a thing hidden in my view
  await ev(`(async () => { ${D}.hierDo?.('myhide', 'toy'); return true; })()`);
  await ev(`dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyB' })), true`);
  await waitFor(`![...document.querySelectorAll('.frame.edit')].some((f) => getComputedStyle(f).display !== 'none')`);
  await ev(`(async () => { const w = await import('/lib/world.js'); const c = await import('/lib/controller.js'); const o = w.entities.get('toy'); c.myState.pos.set(o.position.x + 1.3, o.position.y, o.position.z); return true; })()`);
  await sleep(800);
  const hh = await ev(`(async () => { const t = await import('/lib/thingphysics.js'); const h = t.handsHint(); return h == null ? null : String(h.strings ? h.strings.join('|') + JSON.stringify(h.values) : h); })()`).catch((e) => 'err ' + e);
  check('P1 the ambient hint does not offer to pick up the toy I hid', !/toy/.test(String(hh)), String(hh));
  const use = await ev(`import('/lib/useprompt.js').then((m) => m.usable())`).catch((e) => 'err ' + e);
  // the toy's id is minted, and its seat a socket child with an id of its own (R 10-17): the checks name both, never the word
  const toyIds = [N('toy'), ...((await ev(`import('/lib/world.js').then((w) => w.socketsOn('toy').map((s) => s.id))`)) ?? [])];
  const mentionsToy = (x: unknown) => toyIds.some((id) => JSON.stringify(x).includes(id));
  check('P2 E (the use prompt) does not target the toy I hid', toyIds.length >= 2 && !mentionsToy(use ?? null), JSON.stringify({ use, toyIds }));
  const hap = await ev(`(async () => { const t = await import('/lib/thingphysics.js'); const { THREE } = await import('/lib/core.js'); const w = await import('/lib/world.js'); const o = w.entities.get('toy'); const c = new THREE.Box3().setFromObject(o).getCenter(new THREE.Vector3()); let n = 0;
      t.xrHand('left', { pos: c, grip: false, trig: false, haptic: () => n++ }); return n; })()`).catch((e) => 'err ' + e);
  check('P3 an XR hand inside the hidden toy gets no hover pulse (near-grab would not take it)', hap === 0, String(hap));
  const g = await ev(`(async () => { const t = await import('/lib/thingphysics.js'); const r = await t.grab(); return { r: r?.ok ?? null, holds: t.myHolds() }; })()`).catch((e) => 'err ' + e);
  check('P4 T / grab() with no name does not pick up the toy I hid', !mentionsToy(g), JSON.stringify({ g, toyIds }));
  await ev(`(async () => { const t = await import('/lib/thingphysics.js'); if (t.myHolds().length) await t.drop(); return true; })()`);
  const sit = await ev(`(async () => { const l = await import('/lib/localbody.js'); const w = await import('/lib/world.js'); const c = await import('/lib/controller.js'); const o = w.entities.get('toy'); c.myState.pos.set(o.position.x + 1.0, o.position.y, o.position.z); const r = l.trySitOn(); await new Promise((s) => setTimeout(s, 1200)); const { CONFIG } = await import('/lib/base.js'); return { r, mount: w.avatarMounts.get(CONFIG.name) ?? null }; })()`).catch((e) => 'err ' + e);
  check('P5 X (trySitOn) does not sit me on the toy I hid', !mentionsToy(sit), JSON.stringify({ sit, toyIds }));
  const seatHint = await ev(`(async () => { window.__hints.length = 0; const l = await import('/lib/localbody.js'); l.updateSeatHint(1); return window.__hints.join(' | ') + ' || ' + (document.getElementById('hintbar')?.textContent ?? ''); })()`);
  check('P5 …and the hint bar does not offer "X — sit" beside it', !/X\s*—\s*sit/.test(String(seatHint)), String(seatHint));
  const named = await ev(`(async () => { const l = await import('/lib/localbody.js'); const r = l.trySitOn('toy'); await new Promise((s) => setTimeout(s, 1200)); const w = await import('/lib/world.js'); const { CONFIG } = await import('/lib/base.js'); const m = w.avatarMounts.get(CONFIG.name) ?? null; return { r, mount: m }; })()`).catch((e) => 'err ' + e);
  check('P6 (control) sitting on it BY NAME still works (the Hierarchy-row equivalent)', mentionsToy(named), JSON.stringify({ named, toyIds }));
  await ev(`dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyX' })), true`); await sleep(600);
  await ev(`(async () => { const w = await import('/lib/world.js'); const c = await import('/lib/controller.js'); const o = w.entities.get('toy'); c.myState.pos.set(o.position.x + 1.3, o.position.y, o.position.z); return true; })()`);
  await ev(`(async () => { ${D}.hierDo?.('myhide', 'toy'); return true; })()`); await sleep(300);
  const hh2 = await ev(`(async () => { const t = await import('/lib/thingphysics.js'); const h = t.handsHint(); return h == null ? null : String(h.strings ? h.strings.join('|') + JSON.stringify(h.values) : h); })()`).catch((e) => 'err ' + e);
  check('P7 (control) shown again, the hint offers the toy', /toy/.test(String(hh2)), String(hh2));
  await ev(`dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyB' })), true`);
  await gate('(setup) back in edit mode', await waitFor(`[...document.querySelectorAll('.frame.edit')].some((f) => getComputedStyle(f).display !== 'none')`));
  await ev(`(() => { document.querySelector('.edit-tabs:not(.edit-rtabs) .edit-tab[data-tab="hierarchy"]')?.click(); return true; })()`);
  await ev(`(async () => { ${D}.hierDo?.('fold:all-open'); return true; })()`); await painted(); await painted();

  // ---------------------------------------------------------------- RC: a REAL mouse click (CDP input), not element.click()
  const clickAt = async (sel: string) => { const r = await ev(`(() => { const e = document.querySelector('${sel}'); if (!e) return null; e.scrollIntoView({ block: 'center' }); const b = e.getBoundingClientRect(); return [b.left + b.width / 2, b.top + b.height / 2]; })()`);
    if (!r) return false; for (const type of ['mousePressed', 'mouseReleased']) await cdp.send('Input.dispatchMouseEvent', { type, x: r[0], y: r[1], button: 'left', clickCount: 1 }); return true; };
  const ROWBOX = '[data-frame="hierarchy"] .sp-tree-row[data-id="box2"] .sp-row-on', HEADBOX = '[data-frame="inspector"] .sp-row.sp-enabled input[type=checkbox]';
  await gate('(setup) a real mouse click on box2\'s row box', await clickAt(ROWBOX));
  check('RC0 …switches box2 off', await waitFor(`(async () => ${offOf('box2')})()`));
  check('RC1 after a real click the box does not keep focus', await waitFor(`!/^INPUT/.test(document.activeElement?.tagName ?? '')`, 3000), await ev(`document.activeElement?.tagName + '.' + document.activeElement?.className`));
  check('RC2 …and the row repaints as off without waiting for a blur', await waitFor(`!!document.querySelector('[data-frame="hierarchy"] .sp-tree-row[data-id="box2"]')?.classList.contains('off')`, 4000));
  await ev(`dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyB' })), true`);
  check('RC3 B is not swallowed: it leaves edit mode', await waitFor(`![...document.querySelectorAll('.frame.edit')].some((f) => getComputedStyle(f).display !== 'none')`, 3000));
  await ev(`(document.activeElement?.blur?.(), true)`);
  if (await ev(`![...document.querySelectorAll('.frame.edit')].some((f) => getComputedStyle(f).display !== 'none')`)) await ev(`dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyB' })), true`);
  await gate('(setup) back in edit mode', await waitFor(`[...document.querySelectorAll('.frame.edit')].some((f) => getComputedStyle(f).display !== 'none')`));
  await ev(`(() => { document.querySelector('.edit-tabs:not(.edit-rtabs) .edit-tab[data-tab="hierarchy"]')?.click(); return true; })()`); await painted();
  await ev(`(document.activeElement?.blur?.(), true)`); await ev(`import('/lib/net.js').then((m) => m.replica.st.entities['box2']?.c.disabled ? m.sendRequest('delete', { id: 'box2', component: 'disabled' }) : null)`);
  await gate('(setup) box2 back on', await waitFor(`(async () => !(${offOf('box2')}))()`) && await waitFor(`import('/lib/world.js').then((w) => !!w.entities.get('box2'))`, 20000),
    JSON.stringify(await ev(`(async () => ({ off: ${offOf('box2')}, comp: (await import('/lib/net.js')).replica.st.entities['box2']?.c, ent: !!(await import('/lib/world.js')).entities.get('box2') }))()`)));
  await ev(`import('/lib/scenegraph.js').then((m) => m.sceneSelect('box2')), true`); await painted(); await painted();
  await gate('(setup) a real mouse click on the Inspector ENABLED box', await clickAt(HEADBOX));
  check('RC4 the Inspector switches to its off form (state line) without waiting for a blur', await waitFor(`(async () => ${offOf('box2')})()`) && await waitFor(`[...document.querySelectorAll('[data-frame="inspector"] .sp-row')].some((r) => /switched off: nobody/.test(r.textContent))`, 4000));
  await ev(`(document.activeElement?.blur?.(), true)`); await ev(`import('/lib/net.js').then((m) => m.replica.st.entities['box2']?.c.disabled ? m.sendRequest('delete', { id: 'box2', component: 'disabled' }) : null)`);
  await gate('(setup) box2 on again', await waitFor(`(async () => !(${offOf('box2')}))()`) && await waitFor(`import('/lib/world.js').then((w) => !!w.entities.get('box2'))`, 20000));

  // ---------------------------------------------------------------- K: a refused toggle leaves no lie behind
  // a lock refuses the switch (b1d9c7dd: a lock covers everything on the thing), so the authority says no
  await ev(`import('/lib/net.js').then((m) => m.sendRequest('set', { id: 'box2', component: 'lock', value: true }))`);
  await gate('(setup) box2 locked', await waitFor(`import('/lib/net.js').then((m) => !!m.replica.st.entities['box2']?.c.lock)`));
  await painted(); await painted();
  await ev(`(async () => { const { bus } = await import('/lib/base.js'); window.__asked = []; bus.on('edit-lock-asked', (e) => window.__asked.push(e.choice)); bus.on('edit-done', (e) => window.__asked.push('done:' + e.what)); return true; })()`);
  // RC4's own "switched off" flash may still be held (a hint under the pointer doesn't expire): replace it first
  await ev(`import('/lib/ui.js').then((u) => (u.flashHint('probe: K begins', 60), true))`); await sleep(400);
  await ev(`(window.__hints.length = 0, true)`);
  log('K click at', await ev(`Math.round(performance.now())`)); await ev(`(window.__hintT = [], true)`);
  await clickAt(ROWBOX);
  // the owner may lift the lock, so it asks "Move anyway?": cancel is the refusal (nothing written)
  const asked = await waitFor(`!!document.querySelector('.cc-no')`, 4000);
  log('lock dialog', { asked, buttons: await ev(`[...document.querySelectorAll('.cc-ok, .cc-no, .cc-alt, .cc-danger')].map((b) => b.className + ':' + b.textContent.trim())`) });
  await ev(`(document.querySelector('.cc-no')?.click(), true)`);
  await sleep(1500); await painted(); await painted();
  log('lock answers', await ev(`window.__asked`)); log('hint times', await ev(`window.__hintT`));
  const hintsK = await ev(`window.__hints`);
  check('K2 a refused untick never claims "switched off for everyone"', !hintsK.some((h: string) => /switched off for everyone/.test(h)), JSON.stringify(hintsK));
  check('K3 (control) the refusal held: box2 is still on', !(await ev(`(async () => ${offOf('box2')})()`)));
  check('K4 …and its row box is ticked again (from the record)', await waitFor(`document.querySelector('${ROWBOX}')?.checked === true`, 4000), String(await ev(`document.querySelector('${ROWBOX}')?.checked`)));
  await ev(`import('/lib/scenegraph.js').then((m) => m.sceneSelect('box2')), true`); await painted(); await painted();
  await ev(`(window.__hints.length = 0, true)`);
  await clickAt(HEADBOX);
  await waitFor(`!!document.querySelector('.cc-no')`, 4000); await ev(`(document.querySelector('.cc-no')?.click(), true)`);
  await sleep(1500); await painted(); await painted();
  check('K5 the Inspector header box is ticked again after a refused untick', !(await ev(`(async () => ${offOf('box2')})()`)) && await waitFor(`document.querySelector('${HEADBOX}')?.checked === true`, 4000), String(await ev(`document.querySelector('${HEADBOX}')?.checked`)));
  await ev(`import('/lib/net.js').then((m) => m.sendRequest('delete', { id: 'box2', component: 'lock' }))`);
  await waitFor(`import('/lib/net.js').then((m) => !m.replica.st.entities['box2']?.c.lock)`);
  // a refusal with no dialog in between (nothing takes focus, nothing else repaints): the authority's own answer, to a
  // switch the probe re-addresses on the wire to a thing that isn't there
  for (const [k, sel] of [['K6 row', ROWBOX], ['K7 Inspector header', HEADBOX]] as const) {
    await ev(`import('/lib/scenegraph.js').then((m) => m.sceneSelect('box2')), true`); await painted(); await painted();
    await ev(`(window.__mangle = ['"box2"', '"nosuch"'], true)`);
    const t0 = Date.now(); await clickAt(sel);
    // inside the click's 3 s hold, so it is the refusal's answer that re-ticks the box, not the hold running out
    const back = await waitFor(`document.querySelector('${sel}')?.checked === true`, 1500), took = Date.now() - t0;
    check(`${k}: a refused untick (no dialog) leaves box2 on, and its box ticked again from the record within the 3 s hold`, back && took < 2800 && !(await ev(`(async () => ${offOf('box2')})()`)), `${back} after ${took} ms`);
    await sleep(2500);
    await ev(`(document.activeElement?.blur?.(), window.__mangle = null, true)`); await painted();
  }

  // ---------------------------------------------------------------- S3-1: Alt+Shift+A switches the selection on and off
  await ev(`(async () => { ${D}.hierDo?.('sel', 'box2'); return true; })()`); await painted();
  await ev(`(document.activeElement?.blur?.(), document.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyA', key: 'A', altKey: true, shiftKey: true, bubbles: true })), true)`);
  check('KB1 Alt+Shift+A switches the selected thing off', await waitFor(`(async () => ${offOf('box2')})()`));
  await ev(`(document.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyA', key: 'A', altKey: true, shiftKey: true, bubbles: true })), true)`);
  check('KB1 …and back on', await waitFor(`(async () => !(${offOf('box2')}))()`));
  await waitFor(`import('/lib/world.js').then((w) => !!w.entities.get('box2'))`, 20000);

  // ---------------------------------------------------------------- F: filters
  await ev(`(async () => { ${D}.hierDo?.('hopt:comps'); ${D}.hierDo?.('honly:locked'); ${D}.hierDo?.('filter', 'clickthrough'); return true; })()`); await painted(); await painted();
  const fr = await ev(`(async () => ${D}.hierFields().find((f) => f.t === 'tree')?.rows.map((r) => r.id))()`);
  check('F1 "only locked" + a search: no unlocked thing comes back through its component row', !(fr ?? []).some((x: string) => x.startsWith('comp:' + N('crate')) || x === N('crate')), JSON.stringify(fr));
  await ev(`(async () => { ${D}.hierDo?.('filter', ''); return true; })()`); await painted(); await painted();
  const face = await ev(`(() => [...document.querySelectorAll('[data-frame="hierarchy"] .sp-pop-btn, [data-frame="hierarchy"] button')].map((b) => b.textContent.trim()).find((t) => /^Options/.test(t)) ?? null)()`);
  check('F2 an active row filter shows on the bar', /locked/.test(String(face)), String(face));
  await ev(`(async () => { ${D}.hierDo?.('honly:all'); ${D}.hierDo?.('hopt:comps'); ${D}.hierDo?.('fold:all-open'); return true; })()`); await painted(); await painted();
  const face2 = await ev(`(() => [...document.querySelectorAll('[data-frame="hierarchy"] button')].map((b) => b.textContent.trim()).find((t) => /^Options/.test(t)) ?? null)()`);
  check('F2 (control) with no filter the bar says just "Options ▾"', face2 === 'Options ▾', String(face2));

  // ---------------------------------------------------------------- S3-4: the legacy quad clips names short of the eye
  const LONG = 'a very long name for a thing nobody would type but someone will paste';
  await ev(`import('/lib/net.js').then((m) => m.sendRequest('set', { id: 'cup', component: 'label', value: '${LONG}' }))`);
  { let par = 'cup'; for (let i = 1; i <= 6; i++) { await ev(`import('/lib/net.js').then((m) => m.sendRequest('create', { id: 'deep${i}', components: { transform: { pos: [0, 0.2, 0], q: [0, 0, 0, 1], scale: [1, 1, 1] }, label: 'deep${i} ${LONG}', parent: { to: '${par}', order: 'a0' } } }))`); par = `deep${i}`; } }
  await waitFor(`import('/lib/net.js').then((m) => !!m.replica.st.entities['deep6'])`);
  await ev(`(async () => { ${D}.hierDo?.('fold:all-open'); return true; })()`);
  await ev(`(async () => { ${D}.hierDo?.('hopt:kinds'); return true; })()`);
  await waitFor(`import('/lib/net.js').then((m) => m.replica.st.entities['cup']?.c.label?.startsWith('a very'))`);
  const clip = await ev(`(async () => { const P = await import('/lib/panels.js'); const c = document.createElement('canvas'); const g = c.getContext('2d'); const ft = g.fillText.bind(g), rec = [];
    g.fillText = (s, x, y) => { rec.push({ s: String(s), x, y, w: g.measureText(String(s)).width }); return ft(s, x, y); };
    const regs = P.renderCanvas(c, ${D}.hierFields(), {}); const eye = regs.find((r) => r.action === 'myhide'); const over = rec.filter((t) => t.x < eye.x && t.x + t.w > eye.x - 2).map((t) => t.s.slice(0, 30) + '@' + Math.round(t.x + t.w));
    return { eye: Math.round(eye.x), over }; })()`);
  check('S4 legacy quad: no name or badge text runs under the eye column', clip && clip.over.length === 0, JSON.stringify(clip));
  await ev(`(async () => { ${D}.hierDo?.('hopt:kinds'); return true; })()`);

  // ---------------------------------------------------------------- N: a typed number is written as typed (refused, never clamped)
  const lamp = await ev(`import('/lib/net.js').then((m) => m.sendRequest('create', { id: 'lamp', components: { transform: { pos: [${at[0] + 2}, 1, ${at[1]}], q: [0, 0, 0, 1], scale: [1, 1, 1] }, label: 'lamp', light: { color: 16767392, intensity: 16, range: 10 } } }))`);
  check('(setup) a lamp with a light', lamp?.ok === true, JSON.stringify(lamp?.refused));
  await waitFor(`import('/lib/world.js').then((w) => !!w.entities.get('lamp'))`, 20000);
  await ev(`import('/lib/scenegraph.js').then((m) => m.sceneSelect('lamp')), true`); await painted(); await painted();
  const typed = await ev(`(async () => { const f = document.querySelector('[data-frame="inspector"]');
    let row = [...f.querySelectorAll('.sp-row')].find((r) => r.querySelector('.sp-label')?.textContent.trim() === 'range' && r.querySelector('input.sp-num'));
    if (!row) { [...f.querySelectorAll('.sp-group')].find((g) => /Light/.test(g.textContent))?.click(); await new Promise((r) => setTimeout(r, 400)); row = [...f.querySelectorAll('.sp-row')].find((r) => r.querySelector('.sp-label')?.textContent.trim() === 'range' && r.querySelector('input.sp-num')); }
    const n = row?.querySelector('input.sp-num'); if (!n) return 'no range field'; n.focus(); n.value = '0.5'; n.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); return 'typed'; })()`);
  check('N1 a typed 0.5 m light range is written as 0.5 (the slider minimum of 1 m is not a clamp)', typed === 'typed' && await waitFor(`import('/lib/net.js').then((m) => m.replica.st.entities['lamp']?.c.light?.range === 0.5)`, 5000), `${typed} · range ${await ev(`import('/lib/net.js').then((m) => m.replica.st.entities['lamp']?.c.light?.range)`)}`);
  check('no page errors', (await ev(`window.__errs`))?.length === 0, JSON.stringify(await ev(`window.__errs`)));
} finally {
  console.log(`\n${tally.passed} passed, ${tally.failed} failed`);
  await cleanup(tally.failed ? 1 : 0);
}
process.exit(tally.failed ? 1 : 0);
