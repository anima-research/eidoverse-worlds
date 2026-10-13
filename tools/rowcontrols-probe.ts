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

const WORLD = 'rows', CRATE = 'eidoverse/assets/models/crate_large_blue.glb';
const { evalJson, cleanup, die, cdp, BASE, SCRATCH } = await scratchBench('rowcontrols', { worlds: [WORLD], owner: 'editbot', serverEnv: { TRUST_NAMES: '1', VERB_RATE: '1000' } });
const { check, tally } = mkCheck();
const ev = (e: string, ms = 15000) => Promise.race([evalJson(e), sleep(ms).then(() => { throw new Error(`evaluate timed out after ${ms} ms: ${e.slice(0, 90)}`); })]);
const waitFor = async (e: string, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await ev(e).catch(() => false)) return true; await sleep(100); } return false; };
const painted = () => ev(`new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true))))`);
const LOG = () => path.join(SCRATCH, 'worlds', WORLD, 'world.jsonl');
const logLines = () => fs.readFileSync(LOG(), 'utf8').split('\n').filter(Boolean);
const D = `(await import('/lib/editpanels.js')).editPanelsDebug()`;
const offOf = (id: string) => `(await import('/lib/net.js')).replica.st.entities['${id}']?.c?.disabled === true`;
const gate = async (name: string, ok: boolean, detail = '') => { check(name, ok, detail); if (!ok) await die(1, `gate failed: ${name}`, detail, JSON.stringify(await ev(`window.__errs`).catch(() => 'unreadable'))); };

try {
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: `window.__errs = []; addEventListener('error', (e) => __errs.push('error: ' + e.message));` });
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
  const made = [await mk('crate', at[0], at[1], `, clickthrough: true`), await mk('box2', at[0] + 6, at[1] + 6), await mk('cup', 0, 1.5, `, parent: { to: 'crate', order: 'a0' }`)];
  check('(setup) the owner places a crate, a second crate and a cup riding the first', made.every((r: any) => r?.ok === true), JSON.stringify(made.map((r: any) => r?.refused ?? 'ok')));
  await gate('(setup) …all three realized, the crate with a collider', await waitFor(`Promise.all([import('/lib/world.js'), import('/lib/colliders.js')]).then(([w, c]) => ['crate', 'box2', 'cup'].every((k) => w.entities.get(k)) && c.colliders.has('crate'))`, 30000));
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
  const cols = await ev(`(() => { const out = {}; for (const id of ['crate', 'box2', 'cup']) { const row = document.querySelector('[data-frame="hierarchy"] .sp-tree-row[data-id="' + id + '"]'); if (!row) { out[id] = null; continue; }
      const kids = [...row.children].map((e) => e.classList.contains('sp-row-on') ? 'box' : e.classList.contains('sp-item-main') ? 'name' : e.classList.contains('sp-eye') ? 'eye' : e.classList.contains('sp-lock') ? 'lock' : null).filter(Boolean);
      const x = (s) => Math.round(row.querySelector(s)?.getBoundingClientRect().left ?? -1);
      out[id] = { order: kids.join(','), box: x('.sp-row-on'), name: x('.sp-item-label'), eye: x('.sp-eye'), lock: x('.sp-lock') }; } return out; })()`);
  check('R1 every entity row is [☑][name][👁][🔒], in that order', ['crate', 'box2', 'cup'].every((k) => cols[k]?.order === 'box,name,eye,lock'), JSON.stringify(cols));
  check('R1 …the eye and the lock columns sit at one x down the list', cols.crate && cols.crate.eye === cols.box2.eye && cols.box2.eye === cols.cup.eye && cols.crate.lock === cols.cup.lock && cols.crate.eye > 0, JSON.stringify(cols));
  check('R1 …and two rows at one depth start their box and name at one x', cols.crate?.box === cols.box2?.box && cols.crate?.name === cols.box2?.name && cols.cup?.name > cols.crate?.name, JSON.stringify(cols));
  await ev(`(async () => { ${D}.hierDo?.('hopt:comps'); ${D}.hierDo?.('fold:all-open'); return true; })()`); await painted(); await painted();
  const comp = await ev(`(() => { const r = document.querySelector('[data-frame="hierarchy"] .sp-tree-row[data-id^="comp:crate:"]'); const cup = document.querySelector('[data-frame="hierarchy"] .sp-tree-row[data-id="cup"]');
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
  check('E0 (control) before hiding, a viewport click at the crate selects the crate', before === 'crate', JSON.stringify({ before, why: await why('crate') }));
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
  check('(setup) a known write (rename box2) lands', ren?.ok === true && await waitFor(`import('/lib/net.js').then((m) => m.replica.st.entities.box2?.c.label === 'box two')`), JSON.stringify(ren?.refused));
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
  { const t0 = Date.now(); while (Date.now() - t0 < 4000) { await into('crate'); await painted(); const m = (await marks()).find((x: any) => x.id === 'crate'); if (m && m.a > (peak?.a ?? 0)) peak = m; if (peak?.a >= 0.5) break; } }
  check('E7 bumping it fades in its outline with the crossed-out eye ("you hid this")', peak && peak.a >= 0.5 && peak.eye > 0.4, JSON.stringify(peak));
  await ev(`(async () => { const c = await import('/lib/controller.js'); const w = await import('/lib/world.js'); const o = w.entities.get('crate'); c.myState.pos.set(o.position.x - 12, o.position.y, o.position.z - 12); return true; })()`);
  check('E8 …and it fades out after the contact ends', !!peak && await waitFor(`import('/lib/hiddenbump.js').then((m) => !m.bumpMarks().some((x) => x.id === 'crate'))`, 5000), JSON.stringify(await marks()));
  // a crate I did not hide: solid, and no mark
  let seen: any[] = [];
  { const t0 = Date.now(); while (Date.now() - t0 < 1500) { await into('box2'); await painted(); seen = seen.concat(await marks()); } }
  check('E9 (control) a crate I did not hide pushes me out too, and shows no mark', await pushedOut('box2') && !seen.some((x: any) => x.id === 'box2'), JSON.stringify(seen.slice(0, 3)));
  await ev(`(async () => { ${D}.hierDo?.('myhide', 'crate'); return true; })()`);
  check('E10 the eye again shows it: drawn', await waitFor(`import('/lib/world.js').then((w) => w.entities.get('crate')?.visible === true)`));
  const back = await click('crate');
  check('E10 …and a viewport click lands on it again (the crate, or the cup riding it)', back === 'crate' || back === 'cup', JSON.stringify({ back, why: await why('crate') }));
  check('no page errors', (await ev(`window.__errs`))?.length === 0, JSON.stringify(await ev(`window.__errs`)));
} finally {
  console.log(`\n${tally.passed} passed, ${tally.failed} failed`);
  await cleanup(tally.failed ? 1 : 0);
}
process.exit(tally.failed ? 1 : 0);
