// ATTACK (editor & components, browser half, v2): each section is ONE in-page script (the box is jank-bound: 1–7 s per
// CDP round trip), returning its own log. LIVE gym on :8985 as builder atk-ed-1. ONLY=B|D|E|F|G  /home/claude/eido/probe.sh ../../scratch/atk-editor-b2.ts
// @ts-nocheck
import fs from "node:fs"; import path from "node:path";
import { CHROME, freePort, sleep } from "../tools/harness.ts";
const BASE = "http://127.0.0.1:8985", NAME = process.env.ATK_NAME ?? "atk-ed-1"; const OUT = "/home/claude/eido/logs/atk-editor-shots"; fs.mkdirSync(OUT, { recursive: true });
const SEC = process.env.ONLY ?? "B";
const PROFILE = fs.mkdtempSync("/tmp/atk-ed-profile-"); const DP = freePort(9600);
const browser = Bun.spawn([CHROME, "--headless=new", `--remote-debugging-port=${DP}`, `--user-data-dir=${PROFILE}`, "--no-first-run", "--disable-extensions", "--mute-audio", "--window-size=1600,1000", "--enable-unsafe-webgpu", "about:blank"], { stdout: "ignore", stderr: "ignore" });
let target = null; for (let i = 0; i < 120 && !target; i++) { try { const l = await (await fetch(`http://127.0.0.1:${DP}/json/list`)).json(); target = l.find((t) => t.type === "page"); } catch {} if (!target) await sleep(150); }
const cws = new WebSocket(target.webSocketDebuggerUrl); await new Promise((res, rej) => { cws.onopen = res; cws.onerror = rej; });
let idn = 0; const waiters = new Map(); const exc = [];
cws.addEventListener("message", (ev) => { const m = JSON.parse(String(ev.data)); if (m.id && waiters.has(m.id)) { const w = waiters.get(m.id); waiters.delete(m.id); clearTimeout(w.t); m.error ? w.rej(new Error(m.error.message)) : w.res(m.result); }
  if (m.method === "Runtime.exceptionThrown") exc.push(String(m.params?.exceptionDetails?.exception?.description ?? m.params?.exceptionDetails?.text).slice(0, 200)); });
const send = (method, params = {}, ms = 60000) => new Promise((res, rej) => { const id = ++idn; const t = setTimeout(() => { waiters.delete(id); rej(new Error(method + " timed out")); }, ms); waiters.set(id, { res, rej, t }); cws.send(JSON.stringify({ id, method, params })); });
await Promise.all([send("Runtime.enable"), send("Page.enable")]);
await send("Page.addScriptToEvaluateOnNewDocument", { source: "try { localStorage.setItem('ew-cloud-quality', 'off'); if (!sessionStorage.getItem('ew-gpu-lost')) sessionStorage.setItem('ew-gpu-lost', JSON.stringify([Date.now()])); } catch {}" });
const ev = async (expr, ms = 20000) => { const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }, ms); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text); return r?.result?.value; };
const T = (k, v) => console.log(k, typeof v === "string" ? v : String(JSON.stringify(v)).slice(0, 900));
const shot = async (name) => { try { const r = await send("Page.captureScreenshot", { format: "png" }, 30000); fs.writeFileSync(path.join(OUT, name), Buffer.from(r.data, "base64")); } catch (e) { T("shot failed", e.message); } };
// the in-page toolkit every section gets
const KIT = `
  const L = []; const log = (k, v) => L.push([k, typeof v === 'string' ? v : JSON.stringify(v)?.slice(0, 500)]);
  const z = (ms) => new Promise((r) => setTimeout(r, ms));
  const ew = await import('/lib/editwrites.js'), st = await import('/lib/state.js'), net = await import('/lib/net.js'), wld = await import('/lib/world.js'), sg = await import('/lib/scenegraph.js'), ter = await import('/lib/terrain.js'), ctl = await import('/lib/controller.js'), mv = await import('/lib/myview.js'), ep = await import('/lib/editpanels.js');
  const S = () => st.state.st; const ents = () => Object.keys(S().entities); const C = (id) => Object.keys(net.replica.st.entities[id]?.c ?? {});
  const rq = async (verb, args, what = 'atk') => { const r = await Promise.race([ew.send({ verb, args }, { what }), z(15000).then(() => ({ timeout: true }))]); return r?.ok ? { ok: true, notes: r.notes, refs: r.refs?.map((x) => x.id) } : { ok: false, code: r?.refused?.code, reason: String(r?.refused?.reason ?? '').slice(0, 140), timeout: r?.timeout }; };
  const until = async (f, ms = 12000) => { for (let i = 0; i < ms / 300; i++) { try { if (await f()) return true; } catch {} await z(300); } return false; };
  const Q = (s, root = document) => root.querySelector(s); const QA = (s, root = document) => [...root.querySelectorAll(s)];
  const tab = async (name) => { QA('button, [role=tab], .edit-tab').find((b) => b.textContent.trim() === name)?.click(); await z(500); };
  const menu = async (item) => { QA('.edit-menus button, .edit-menus .edit-menu-btn').find((x) => /^Create/.test(x.textContent.trim()))?.click(); await z(300); const it = QA('.edit-menu-pop .edit-menu-item').find((x) => x.textContent.trim() === item); it?.click(); await z(700); return !!it; };
  const tile = (frame, re, n = 0) => { const ts = QA('[data-frame="' + frame + '"] .sp-tile').filter((b) => re.test(b.title)); ts[n]?.click(); return { n: ts.length, picked: ts[n]?.title.slice(0, 50) ?? null }; };
  const rows = () => QA('[data-frame="hierarchy"] .sp-item-sub-row').map((e) => e.dataset.id);
  const env = () => { const s = S(); let gh = null; try { gh = +ter.heightAt(ctl.myState.pos.x, ctl.myState.pos.z).toFixed(2); } catch (e) { gh = 'err'; } return { sky: s.sky != null, wx: s.sky?.weather ?? null, terrain: s.terrain != null, grass: s.grass != null, mesh: ter.hasTerrain(), rows: rows(), bodyY: +ctl.myState.pos.y.toFixed(2), gh, world: Object.keys(net.replica.st.entities['@world'].c).filter((k) => /^(sky|terrain|grass)/.test(k)) }; };
  const insp = () => Q('[data-frame="inspector"]')?.innerText.replace(/\\s+/g, ' ').slice(0, 220);
  const MODEL = (await ew.send({ verb: 'find', args: { kind: 'model' } }, { what: 'find' })).models[0].model;
  const made = []; const mk = async (id, args) => { const r = await rq('create', { id, ...args }); made.push(id); if (!r.ok) log('create ' + id, r); return r; };
  const sweep = async () => { for (const id of made.reverse()) await rq('delete', { id }); };
`;
const run = async (body, ms = 290000) => { const r = await ev(`(async () => { ${KIT} try { ${body} } catch (e) { log('ERR', String(e?.stack ?? e).slice(0, 400)); } finally { try { await sweep(); } catch {} } return L; })()`, ms); for (const [k, v] of r ?? []) T(k, v ?? ""); };
try {
  await send("Emulation.setDeviceMetricsOverride", { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false });
  await send("Page.navigate", { url: `${BASE}/?name=${NAME}&world=gym&webgl=1` });
  for (let i = 0; i < 120; i++) { if (((await ev(`document.querySelectorAll('.sec').length`, 8000).catch(() => 0)) ?? 0) >= 4) break; await sleep(500); }
  for (let i = 0; i < 40; i++) { if (await ev(`import('/lib/net.js').then((m) => m.replicaActive())`, 8000).catch(() => false)) break; await sleep(400); }
  await sleep(3000); for (let i = 0; i < 3; i++) { if (await ev(`import('/lib/build.js').then((b) => (b.setEditMode(true), true))`, 60000).catch(() => false)) break; } await sleep(1200);
  T("booted", { sec: SEC });
  if (SEC === "B") await run(`
    await tab('Hierarchy'); log('B0 before', env());
    log('B1 Create ▸ Sky', await menu('Sky')); log('   inspector', insp());
    log('   sky tile #1', tile('build', /the sky at/, 0)); await until(() => S().sky != null); await z(2500); log('   after #1', env());
    log('   sky tile #2 (a second create)', tile('build', /the sky at/, 1)); await z(3000); log('   after #2', env());
    log('B2 Create ▸ Terrain', await menu('Terrain')); log('   shape tile #1', tile('build', /relief/, 0)); await until(() => ter.hasTerrain(), 20000); await z(2500); log('   after #1', env());
    log('   shape tile #2', tile('build', /relief/, 1)); await z(5000); log('   after #2', env());
    log('B3 Create ▸ Grass', await menu('Grass')); log('   plant tile', tile('build', /plant it/, 0)); await until(() => S().grass != null); await z(1500); log('   after', env());
    log('B4 Create ▸ Weather', await menu('Weather')); const wt = QA('[data-frame="build"] .sp-tile').filter((b) => /^(rain|snow|storm|fog|drizzle|overcast)/i.test(b.title)); log('   weather tiles', wt.map((b) => b.title).slice(0, 8)); wt[0]?.click(); await until(() => S().sky?.weather && S().sky.weather !== 'clear'); await z(1000); log('   after', env());
    log('B5 undo ×2', [await Promise.race([ew.undo(), z(15000).then(() => 'T/O')]), await Promise.race([ew.undo(), z(15000).then(() => 'T/O')])].map((r) => r?.ok ?? r?.refused?.code ?? r)); await z(2500); log('   after', env());
    const del = async (k) => { const row = Q('[data-frame="hierarchy"] [data-id="env:' + k + '"]'); const b = row?.querySelector('.sp-mini'); b?.click(); await z(3500); return { row: !!row, btn: b?.textContent ?? null }; };
    for (const k of ['weather', 'grass', 'terrain', 'sky']) { log('B6 ✕ ' + k, await del(k)); log('   after', env()); }
    log('B7 undo ×4', (await Promise.all([0, 1, 2, 3].map(() => 0))).length && [await ew.undo(), await ew.undo(), await ew.undo(), await ew.undo()].map((r) => r?.ok ?? r?.refused?.code)); await z(4000); log('   after', env());
    for (const k of ['weather', 'grass', 'terrain', 'sky']) await del(k); log('B8 all ✕ again', env());
    await menu('Terrain'); log('B9 terrain back', tile('build', /relief/, 0)); await until(() => ter.hasTerrain(), 20000); await z(2000); log('   after', env());
    await menu('Sky'); log('B9 sky back', tile('build', /the sky at/, 0)); await until(() => S().sky != null); await z(1500); log('   after', env());
    await menu('Weather'); QA('[data-frame="build"] .sp-tile').filter((b) => /^(rain|snow|storm|fog|drizzle|overcast)/i.test(b.title))[0]?.click(); await z(2500); log('B9 weather back', env());
    await menu('Grass'); log('B9 grass back', tile('build', /plant it/, 0)); await until(() => S().grass != null); await z(1500); log('   after', env());
    log('B10 ✕ weather alone', await del('weather')); log('   after', env());
    log('B11 ✕ sky with weather present', await del('sky')); log('   after', env());
    await menu('Weather'); QA('[data-frame="build"] .sp-tile').filter((b) => /^(rain|snow|storm|fog|drizzle|overcast)/i.test(b.title))[0]?.click(); await z(2500); log('B12 weather with NO sky', env());
    for (const k of ['weather', 'grass', 'terrain', 'sky']) await del(k); log('B13 left as found', env());
  `);
  if (SEC === "D") await run(`
    await tab('Hierarchy'); const P = 'atk-eb' + Date.now().toString(36).slice(-4);
    await mk(P + '-par', { model: MODEL, place: { at: [15, 15] } }); await mk(P + '-kid', { model: MODEL, components: { parent: { to: P + '-par' }, transform: { pos: [0, 1.3, 0] } } }); await mk(P + '-solo', { model: MODEL, place: { at: [17, 15] } });
    await until(() => wld.entities.has(P + '-kid'), 20000); await z(1500);
    const row = (id) => { const r = Q('[data-frame="hierarchy"] [data-id="' + id + '"]'); const s = S().entities[id]; const o = wld.entities.get(id); return { id: id.slice(-4), realized: !!o, visible: o ? o.visible : null, row: r ? { cls: r.className.replace(/sp-item sp-tree-row ?/, ''), text: r.innerText.replace(/\\s+/g, ' ').slice(0, 40), eyeOn: !!r.querySelector('.sp-eye.on') } : null, hidden: s?.comp?.hidden, disabled: s?.comp?.disabled, mine: mv.isMineHidden(id) }; };
    log('D0', [row(P + '-par'), row(P + '-kid'), row(P + '-solo')]);
    mv.toggleMineHidden(P + '-par'); await z(1000); log('D1 eye on par (kid too?)', [row(P + '-par'), row(P + '-kid')]);
    log('D2 hidden-for-all on par', await rq('set', { id: P + '-par', component: 'hidden', value: true })); await z(1500); log('   rows', [row(P + '-par'), row(P + '-kid')]);
    log('D3 disabled on par', await rq('set', { id: P + '-par', component: 'disabled', value: true })); await until(() => !wld.entities.has(P + '-par')); await z(1000); log('   rows', [row(P + '-par'), row(P + '-kid')]);
    sg.sceneSelect(P + '-par'); await z(900); log('   inspector (off thing)', insp());
    sg.sceneSelect(P + '-kid'); await z(900); log('   inspector (child of off)', insp());
    const e = Q('[data-frame="hierarchy"] [data-id="' + P + '-par"] .sp-eye'); e?.click(); await z(600); log('   eye toggled on the off row', { eye: !!e, now: row(P + '-par') });
    log('D4 un-hide while off', await rq('delete', { id: P + '-par', component: 'hidden' })); await z(900); log('   rows', [row(P + '-par'), row(P + '-kid')]);
    log('D5 eye ON a thing then switch it off then on: eye kept?', { before: mv.isMineHidden(P + '-par') });
    sg.sceneSelect(P + '-par'); await z(700); const b = QA('[data-frame="inspector"] button').find((x) => /switch it back on/.test(x.textContent)); b?.click(); log('D6 switch back on button', !!b); await until(() => wld.entities.has(P + '-par'), 25000); await z(2500);
    log('   rows', [row(P + '-par'), row(P + '-kid')]);
    const THREE = await import('three'); const o = wld.entities.get(P + '-kid'); log('   kid rides par?', { parent: o?.parent?.userData?.entityId ?? (o ? 'scene' : null), y: o ? +o.getWorldPosition(new THREE.Vector3()).y.toFixed(2) : null });
    log('D7 disable the kid, move par, re-enable kid', await rq('set', { id: P + '-kid', component: 'disabled', value: true })); await z(500); await rq('set', { id: P + '-par', component: 'transform', value: { pos: [16, 0.04, 16] } }); await z(500); await rq('delete', { id: P + '-kid', component: 'disabled' }); await until(() => wld.entities.has(P + '-kid'), 20000); await z(2000);
    const o2 = wld.entities.get(P + '-kid'); const v = o2 ? o2.getWorldPosition(new THREE.Vector3()) : null; log('   kid where (par at 16,·,16 → kid ≈ 16,1.3,16)?', v ? [+v.x.toFixed(2), +v.y.toFixed(2), +v.z.toFixed(2)] : null);
    mv.showAllMine();
  `);
  if (SEC === "E") await run(`
    await tab('Hierarchy'); const P = 'atk-ec' + Date.now().toString(36).slice(-4);
    await mk(P + '-m', { model: MODEL, place: { at: [18, 15] } }); await until(() => wld.entities.has(P + '-m'), 20000); await z(1000);
    sg.sceneSelect(P + '-m'); await z(1200); const before = ents();
    const ab = QA('[data-frame="inspector"] button').find((x) => /Add Component/.test(x.textContent)); ab?.click(); await z(600);
    const items = QA('.sp-pop-item, .sp-pop button, .sp-popup button, .sp-menu-item, .sp-pop li, [class*=pop] button'); log('E1 Add Component pop', { btn: !!ab, n: items.length, items: items.map((x) => x.textContent.trim()).filter(Boolean).slice(0, 40) });
    const li = items.find((x) => x.textContent.trim() === 'Light'); li?.click(); await z(2500); const nw = ents().filter((k) => !before.includes(k)); made.push(...nw);
    log('   clicked Light → made', { clicked: !!li, nw, mComps: C(P + '-m'), childComps: nw.map((k) => C(k)) });
    log('E2 wire set light on m', await rq('set', { id: P + '-m', component: 'light', value: { color: 16767392, intensity: 8, range: 6 } }));
    await tab('Attributes'); await z(800); const f = Q('[data-frame="attributes"]'); log('E3 Attributes', f?.innerText.replace(/\\s+/g, ' ').slice(0, 300));
    const tas = QA('.sp-json-ta', f); log('   json textareas', tas.map((t) => t.value.slice(0, 40)));
    for (const ta of tas) { ta.closest('.sp-json')?.querySelector('.sp-json-tog')?.click(); } await z(300);
    const ta = tas.find((t) => /glb|model/.test(t.value)) ?? tas[0];
    if (ta) { ta.focus(); ta.value = JSON.stringify({ kind: 'point', color: 16767392, intensity: 8, range: 6 }); ta.dispatchEvent(new Event('input', { bubbles: true })); await z(300); ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true })); ta.blur(); await z(2000);
      log('E4 typed a light bag into the model JSON floor', { err: f.querySelector('.sp-json-err')?.textContent.slice(0, 160), comps: C(P + '-m'), model: net.replica.st.entities[P + '-m']?.c.model }); }
    await tab('Inspector'); await z(500);
    const pub = await ew.publish([P + '-m'], 'atk-ed-bp3'); await z(800); const bp = ew.blueprints().find((b) => b.name === 'atk-ed-bp3')?.hash; log('E5 publish m → blueprint', { ok: pub?.ok, bp: !!bp });
    if (bp) { log('E6 create from blueprint + light folded in', await rq('create', { id: P + '-bpl', from: bp, components: { light: { color: 16767392, intensity: 8, range: 6 } } })); made.push(P + '-bpl'); log('   comps', C(P + '-bpl')); }
    const lightId = nw.find((k) => C(k).includes('light')); if (lightId) { sg.sceneSelect(lightId); await z(1000); const ab2 = QA('[data-frame="inspector"] button').find((x) => /Add Component/.test(x.textContent)); ab2?.click(); await z(500); const it2 = QA('.sp-pop-item, .sp-pop button, .sp-popup button, .sp-menu-item, .sp-pop li, [class*=pop] button').map((x) => x.textContent.trim()).filter(Boolean); document.body.click(); log('E7 on the light: Add Component offers Model?', { offersModel: it2.some((x) => /^model/i.test(x)), n: it2.length }); log('   wire set model on the light', await rq('set', { id: lightId, component: 'model', value: MODEL })); }
  `);
  if (SEC === "F") await run(`
    await tab('Hierarchy'); const id = 'atk-ef' + Date.now().toString(36).slice(-4);
    await mk(id, { model: MODEL, place: { at: [19, 15] } }); await until(() => wld.entities.has(id), 20000); await z(800); sg.sceneSelect(id); await z(1200);
    const nums = () => QA('[data-frame="inspector"] .sp-num'); log('F0 number boxes', nums().slice(0, 9).map((n, i) => ({ i, v: n.value, chan: n.closest('.sp-row')?.querySelector('.sp-chan')?.textContent.trim().slice(0, 10) ?? n.closest('.sp-row')?.innerText.slice(0, 10) })));
    const type = async (i, text) => { const n = nums()[i]; if (!n) return 'no box'; n.focus(); n.value = text; n.onchange(); await z(1100); const e = net.replica.st.entities[id]; return { box: nums()[i]?.value, pos: e?.c?.transform?.pos, scale: e?.c?.transform?.scale, toast: QA('[class*=toast], .hint, .ew-hint').map((t) => t.textContent.trim().slice(0, 90)).filter(Boolean).slice(-1) }; };
    for (const [i, t] of [[0, '0.00'], [0, '-0'], [0, '1e309'], [0, 'abc'], [0, '1abc'], [0, '0x10'], [0, '+=10%'], [0, '100000'], [0, '19'], [1, '-5'], [1, '1e-9'], [1, '0.04']]) log('F1 pos[' + i + '] ← ' + JSON.stringify(t), await type(i, t));
    const si = nums().findIndex((n) => /scale|^s/i.test(n.closest('.sp-group, .sp-card')?.innerText.slice(0, 30) ?? '')); const sc = si >= 0 ? si : 6;
    for (const t of ['0', '-1', '1e5', '1']) log('F2 scale box[' + sc + '] ← ' + t, await type(sc, t));
    const lab = () => Q('[data-frame="inspector"] input.sp-text'); log('F3 label box', { present: !!lab(), maxlength: lab()?.maxLength, v: lab()?.value });
    const typeLab = async (text) => { const n = lab(); n.focus(); n.value = text; n.onchange(); await z(1200); const e = net.replica.st.entities[id]; return { boxLen: lab()?.value.length, stored: JSON.stringify(e?.c?.label)?.slice(0, 40), storedLen: String(e?.c?.label ?? '').length, toast: QA('[class*=toast], .hint, .ew-hint').map((t) => t.textContent.trim().slice(0, 90)).filter(Boolean).slice(-1), row: Q('[data-frame="hierarchy"] [data-id="' + id + '"]')?.innerText.replace(/\\s+/g, ' ').slice(0, 30), rowH: Q('[data-frame="hierarchy"] [data-id="' + id + '"]')?.getBoundingClientRect().height }; };
    log('F4 label ← 5000 chars', await typeLab('L'.repeat(5000)));
    log('F5 label ← newline/ZWSP/NUL', await typeLab('a\\nb\\u200b\\u0000c'));
    log('F6 label ← 80 family emoji', await typeLab('👩‍👩‍👧‍👦'.repeat(80)));
    log('F7 label ← empty', await typeLab(''));
  `);
  if (SEC === "G") await run(`
    await tab('Hierarchy'); const P = 'atk-eg' + Date.now().toString(36).slice(-4);
    const frame = async () => { const t0 = performance.now(); let n = 0; await new Promise((r) => { const f = () => { n++; if (performance.now() - t0 < 2000) requestAnimationFrame(f); else r(); }; requestAnimationFrame(f); }); const d = ep.editPanelsDebug(); const t1 = performance.now(); d.hierFields(); const t2 = performance.now(); return { fps: +(n / 2).toFixed(1), hierFieldsMs: +(t2 - t1).toFixed(1), ents: ents().length, domRows: QA('[data-frame="hierarchy"] [data-id]').length }; };
    log('G0 baseline', await frame());
    let okN = 0; const t0 = Date.now();
    for (let b = 0; b < 5; b++) { const ops = []; for (let i = 0; i < 100; i++) { const k = b * 100 + i; ops.push({ verb: 'create', args: { id: P + '-' + k, components: { label: 'e' + k, transform: { pos: [10 + (k % 20) * 0.4, 0.5 + Math.floor(k / 100), -10 + Math.floor((k % 100) / 20) * 0.4] }, ...(k % 10 ? { parent: { to: P + '-' + (k - (k % 10)) } } : {}) } } }); }
      const r = await rq('batch', { ops }, 'batch'); log('   batch ' + b, r); if (!r.ok) break; okN += 100; await z(1200); }
    for (let k = 0; k < okN; k++) made.push(P + '-' + k);
    log('G1 created', { okN, ms: Date.now() - t0 }); await z(2500);
    log('G2 with ' + okN + ' more', await frame());
    const t1 = performance.now(); await rq('set', { id: P + '-0', component: 'label', value: 'e0!' }); await z(200); log('   one label edit → repaint', { ms: Math.round(performance.now() - t1), hierFieldsMs: (() => { const a = performance.now(); ep.editPanelsDebug().hierFields(); return +(performance.now() - a).toFixed(1); })() });
    const f = Q('[data-frame="hierarchy"]'); const sc = [f.querySelector('.sp-tree'), f.querySelector('.schema-scroll')].find((e) => e && e.scrollHeight > e.clientHeight + 4); if (sc) sc.scrollTop = sc.scrollHeight; await z(600); log('   scrolled', { scroller: sc?.className, h: sc?.scrollHeight, rows: QA('[data-id]', f).length, last: QA('[data-id]', f).at(-1)?.dataset.id?.slice(-6) });
    // H: shift-click across depths in the Hierarchy, then a shift-marquee on the canvas over the block
    const a = Q('[data-id="' + P + '-10"]', f), b = Q('[data-id="' + P + '-23"]', f);
    if (a && b) { a.scrollIntoView(); a.dispatchEvent(new MouseEvent('click', { bubbles: true })); await z(400); b.dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true })); await z(600); const s = ep.selection(); log('H1 Hierarchy: click ' + P.slice(-3) + '-10 (a parent), shift-click -23 (a child of -20)', { n: s.length, s: s.slice(0, 16).map((x) => x.slice(-3)), multiRows: QA('.sp-tree-row.multi', f).length }); }
    const THREE = await import('three'); const r = await import('/lib/render.js').catch(() => null); const cam = r?.camera ?? r?.getCamera?.() ?? null;
    if (cam) { ctl.myState.pos.set(14, 0, -4); ctl.myState.yaw = Math.PI; await z(800); const cv = Q('canvas').getBoundingClientRect(); const pts = [];
      for (const k of [0, 5, 11, 23, 47]) { const o = wld.entities.get(P + '-' + k); if (!o) continue; const v = o.getWorldPosition(new THREE.Vector3()).project(cam); pts.push({ k, x: Math.round(cv.left + (v.x + 1) / 2 * cv.width), y: Math.round(cv.top + (1 - v.y) / 2 * cv.height), z: +v.z.toFixed(2) }); }
      log('   screen points', pts);
      if (pts.length >= 2) { const x0 = Math.min(...pts.map((p) => p.x)) - 20, y0 = Math.min(...pts.map((p) => p.y)) - 20, x1 = Math.max(...pts.map((p) => p.x)) + 20, y1 = Math.max(...pts.map((p) => p.y)) + 20;
        Q('canvas').dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: x0, clientY: y0, button: 0, shiftKey: true })); for (let i = 1; i <= 6; i++) window.dispatchEvent(new MouseEvent('mousemove', { clientX: x0 + (x1 - x0) * i / 6, clientY: y0 + (y1 - y0) * i / 6, shiftKey: true })); await z(200); window.dispatchEvent(new MouseEvent('mouseup', { clientX: x1, clientY: y1, shiftKey: true })); await z(1000);
        const s = ep.selection(); log('H2 shift-marquee over the block', { box: [x0, y0, x1, y1], n: s.length, depths: s.slice(0, 10).map((id) => ({ id: id.slice(-3), parent: S().entities[id]?.parent?.to?.slice(-3) ?? null })), insp: insp()?.slice(0, 120) }); } }
    else log('   no camera export (marquee skipped)', Object.keys(r ?? {}).slice(0, 10));
    const t2 = Date.now(); for (let b = 4; b >= 0; b--) { const ops = []; for (let i = 99; i >= 0; i--) ops.push({ verb: 'delete', args: { id: P + '-' + (b * 100 + i) } }); const r = await rq('batch', { ops }, 'batch'); if (!r.ok) log('   delete batch ' + b, r); await z(800); } made.length = 0;
    log('G3 deleted', { ms: Date.now() - t2 }); await z(2000); log('G4 after', await frame());
  `);
  await shot(`b2-${SEC}.png`);
} catch (e) { T("ERR", String(e?.stack ?? e).slice(0, 500)); }
finally { T("exceptions", exc.slice(0, 6)); try { browser.kill(); } catch {} await sleep(400); try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch {} }
process.exit(0);
