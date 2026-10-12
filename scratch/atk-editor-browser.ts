// ATTACK (editor & components, browser half): one headless chromium on the LIVE gym (:8985) as builder atk-ed-1.
// Sections are independent; each logs what it sent and what came back. Run: /home/claude/eido/probe.sh ../../scratch/atk-editor-browser.ts
// @ts-nocheck
import fs from "node:fs"; import path from "node:path";
import { CHROME, cdpOn, freePort, sleep } from "../tools/harness.ts";
const BASE = process.env.ATK_BASE ?? "http://127.0.0.1:8985"; const NAME = process.env.ATK_NAME ?? "atk-ed-1";
const OUT = "/home/claude/eido/logs/atk-editor-shots"; fs.mkdirSync(OUT, { recursive: true });
const ONLY = (process.env.ONLY ?? "A,B,C,D,E,F,G,H").split(",");
const T = (k, info) => console.log(k, typeof info === "string" ? info : JSON.stringify(info ?? null).slice(0, 700));
// ---- browser
const PROFILE = fs.mkdtempSync("/tmp/atk-ed-profile-"); const DP = freePort(9600);
const browser = Bun.spawn([CHROME, "--headless=new", `--remote-debugging-port=${DP}`, `--user-data-dir=${PROFILE}`, "--no-first-run", "--no-default-browser-check", "--disable-extensions",
  "--disable-background-networking", "--disable-sync", "--mute-audio", "--window-size=1600,1000", "--enable-unsafe-webgpu", "about:blank"], { stdout: "ignore", stderr: Bun.file(path.join(OUT, "browser.stderr.log")) });
let target = null; for (let i = 0; i < 120 && !target; i++) { try { const l = await (await fetch(`http://127.0.0.1:${DP}/json/list`)).json(); target = l.find((t) => t.type === "page"); } catch {} if (!target) await sleep(150); }
const cws = new WebSocket(target.webSocketDebuggerUrl); await new Promise((res, rej) => { cws.onopen = res; cws.onerror = rej; });
const errors = []; cws.addEventListener("message", (ev) => { const m = JSON.parse(String(ev.data)); if (m.method === "Runtime.exceptionThrown") errors.push(String(m.params?.exceptionDetails?.exception?.description ?? m.params?.exceptionDetails?.text).slice(0, 200)); });
const cdp = cdpOn(cws); await Promise.all([cdp.send("Runtime.enable"), cdp.send("Page.enable"), cdp.send("Log.enable")]);
await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: "try { localStorage.setItem('ew-cloud-quality', 'off'); if (!sessionStorage.getItem('ew-gpu-lost')) sessionStorage.setItem('ew-gpu-lost', JSON.stringify([Date.now()])); } catch {}" });
const evalJson = async (expr, timeout = 20000) => { const r = await cdp.send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true, timeout }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text); return r?.result?.value; };
const page = (js, timeout = 20000) => evalJson(`(async () => { ${js} })()`, timeout).catch((e) => ({ TIMEOUT: String(e?.message ?? e).slice(0, 120) }));
const pulse = async () => { const t0 = Date.now(); const r = await evalJson(`1+1`, 8000).then(() => "ok").catch(() => "TIMEOUT"); return `${r}@${Date.now() - t0}ms`; };
const shot = async (name) => { const r = await cdp.send("Page.captureScreenshot", { format: "png" }); fs.writeFileSync(path.join(OUT, name), Buffer.from(r.data, "base64")); };
const click = async (x, y, mods = 0) => { for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) await cdp.send("Input.dispatchMouseEvent", { type, x: Math.round(x), y: Math.round(y), button: "left", clickCount: 1, modifiers: mods, buttons: type === "mousePressed" ? 1 : 0 }); };
const until = async (js, ms = 10000) => { for (let i = 0; i < ms / 250; i++) { if (await evalJson(js).catch(() => false)) return true; await sleep(250); } return false; };
const boot = async () => {
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false });
  await cdp.send("Page.navigate", { url: `${BASE}/?name=${NAME}&world=gym&webgl=1` });
  for (let i = 0; i < 160; i++) { if (((await evalJson(`document.querySelectorAll('.sec').length`).catch(() => 0)) ?? 0) >= 4) break; await sleep(500); }
  for (let i = 0; i < 60; i++) { if (await evalJson(`import('/lib/net.js').then((m) => m.replicaActive())`).catch(() => false)) break; await sleep(300); }
  await sleep(4000);
  await page(`(await import('/lib/build.js')).setEditMode(true); return 1;`); await sleep(1500);
  await page(`[...document.querySelectorAll('button, [role=tab], .edit-tab')].find((b) => b.textContent.trim() === 'Hierarchy')?.click(); return 1;`); await sleep(600);
};
// helpers in the page
const ents = () => page(`return Object.keys((await import('/lib/state.js')).state.st.entities);`);
const mine = async (before) => (await ents()).filter((k) => !before.includes(k));
const menu = async (item) => page(`const b = [...document.querySelectorAll('.edit-menus button, .edit-menus .edit-menu-btn')].find((x) => /^Create/.test(x.textContent.trim())); b?.click(); await new Promise((z) => setTimeout(z, 300));
  const it = [...document.querySelectorAll('.edit-menu-pop .edit-menu-item')].find((x) => x.textContent.trim() === ${JSON.stringify(item)}); it?.click(); return !!it;`);
const canvasAt = (fx, fy) => evalJson(`(() => { const r = document.querySelector('canvas').getBoundingClientRect(); return [r.left + r.width * ${fx}, r.top + r.height * ${fy}]; })()`);
const undo = () => page(`const r = await Promise.race([(await import('/lib/editwrites.js')).undo(), new Promise((z) => setTimeout(() => z({ timeout: true }), 20000))]); return { ok: r?.ok, code: r?.refused?.code, reason: r?.refused?.reason, timeout: r?.timeout };`);
const grew = async (before, ms = 15000) => { for (let i = 0; i < ms / 500; i++) { const n = await mine(before); if (n.length) return n; await sleep(500); } return []; };
const send = (req, what = "atk") => page(`const r = await (await import('/lib/editwrites.js')).send(${JSON.stringify(req)}, { what: ${JSON.stringify(what)} }); return { ok: r?.ok, code: r?.refused?.code, reason: String(r?.refused?.reason ?? '').slice(0, 160), notes: r?.notes, refs: r?.refs };`);
const envState = () => page(`const s = (await import('/lib/state.js')).state.st; const t = await import('/lib/terrain.js'); const c = await import('/lib/controller.js'); const w = await import('/lib/world.js');
  const rows = [...document.querySelectorAll('[data-frame="hierarchy"] .sp-item-sub-row')].map((e) => e.dataset.id);
  let gh = null; try { gh = t.heightAt(c.myState.pos.x, c.myState.pos.z); } catch (e) { gh = 'err ' + e.message; }
  return { sky: s.sky != null, skyKeys: s.sky ? Object.keys(s.sky).slice(0, 12) : null, weather: s.sky?.weather ?? null, terrain: s.terrain != null, grass: s.grass != null, mesh: t.hasTerrain(), rows, bodyY: +c.myState.pos.y.toFixed(2), groundHere: gh, worldC: Object.keys((await import('/lib/net.js')).replica.st.entities['@world'].c).filter((k) => !k.startsWith('roles:')) };`);
const tile = async (frame, hintRe, nth = 0) => page(`const ts = [...document.querySelectorAll('[data-frame="${frame}"] .sp-tile')].filter((b) => ${hintRe}.test(b.title)); const b = ts[${nth}]; if (!b) return { n: ts.length }; b.click(); return { n: ts.length, picked: b.title.slice(0, 60) };`);
const kb = async (text) => { await cdp.send("Input.insertText", { text }); };
const key = async (k, code, mods = 0) => { await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: k, code, modifiers: mods, windowsVirtualKeyCode: k === "Enter" ? 13 : k === "Escape" ? 27 : k === "z" ? 90 : 0 }); await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: k, code, modifiers: mods }); };
const made = []; const C = (id) => { made.push(id); return id; };
const mine0 = mine; const myCreate = (ids) => ids.filter((k) => /^(empty-|light-|atk-)/.test(k) || true);
try {
  await boot(); T("booted", { ents: (await ents()).length, errors });
  const base0 = await ents();
  if (ONLY.includes("A")) {   // ---- Create ▸ Empty / Light / Model… / Blueprint…, each then undone
    T("== A Create menu", "");
    for (const [item, where] of [["Empty", [0.5, 0.72]], ["Light", [0.55, 0.72]]]) {
      const before = await ents(); T(`A ${item}: menu`, await menu(item)); await sleep(500);
      const c = await canvasAt(...where); await click(c[0], c[1]);
      const nw = await grew(before); T(`   made`, nw); T("   pulse", await pulse());
      T("   stacks", await page(`const ew = await import('/lib/editwrites.js'); return ew.stacks().undo.slice(-3);`, 8000));
      const u = await undo(); T("   pulse after undo", await pulse()); await sleep(1500); const after = await mine(before); T(`   undo`, { u, left: after });
      if (u?.timeout || u?.TIMEOUT) { T("   direct undo request (bypassing settled())", await page(`const ew = await import('/lib/editwrites.js'); const act = ew.stacks().undo.at(-1); const r = await ew.send({ verb: 'undo', args: { act } }, { what: 'undo', record: false }); return { act, ok: r.ok, code: r.refused?.code };`, 15000)); T("   left", await mine(before)); }
      if (after.length) made.push(...after);
    }
    { const before = await ents(); T("A Model: menu", await menu("Model from the library…")); await sleep(800);
      const p = await tile("build", /./, 0); T("   first library tile", p); await sleep(600);
      const c = await canvasAt(0.6, 0.72); await click(c[0], c[1]);
      const nw = await grew(before); T("   made", nw); const u = await undo(); await sleep(1200); const after = await mine(before); T("   undo", { u, left: after }); made.push(...after); }
    { // a blueprint of my own: an Empty placed by the menu, published, then Create ▸ Blueprint… ▸ tile ▸ click
      const before = await ents(); await menu("Empty"); await sleep(400); const c = await canvasAt(0.45, 0.72); await click(c[0], c[1]);
      const e1 = await grew(before); T("A Blueprint: source empty", e1); if (e1[0]) made.push(e1[0]);
      const pub = await page(`const r = await (await import('/lib/editwrites.js')).publish(${JSON.stringify(e1)}, 'atk-ed-bp'); return { ok: r?.ok, code: r?.refused?.code, reason: r?.refused?.reason };`); T("   publish", pub); await sleep(800);
      const before2 = await ents(); T("   menu", await menu("Blueprint…")); await sleep(800);
      const p = await tile("build", /atk-ed-bp/, 0); T("   blueprint tile", p); await sleep(600);
      const c2 = await canvasAt(0.4, 0.72); await click(c2[0], c2[1]);
      const nw = await grew(before2); T("   made", nw); const u = await undo(); await sleep(1200); const after = await mine(before2); T("   undo", { u, left: after }); made.push(...after); }
    await shot("A-create.png");
  }
  if (ONLY.includes("B")) {   // ---- Environment: create each twice, then the ✕ rows, then add back
    T("== B Environment", "");
    T("B0 before", await envState());
    const envItem = async (lab) => { const r = await page(`const b = [...document.querySelectorAll('.edit-menus button, .edit-menus .edit-menu-btn')].find((x) => /^Create/.test(x.textContent.trim())); b?.click(); await new Promise((z) => setTimeout(z, 300));
      const it = [...document.querySelectorAll('.edit-menu-pop .edit-menu-item')].find((x) => x.textContent.trim() === ${JSON.stringify(lab)}); it?.click(); return !!it;`); await sleep(900); return r; };
    T("B1 Create ▸ Sky", await envItem("Sky")); T("   inspector", await page(`return document.querySelector('[data-frame="inspector"]')?.innerText.replace(/\\s+/g, ' ').slice(0, 200);`));
    T("   sky tile #1", await tile("build", /the sky at/, 0)); await sleep(2500); T("   after #1", await envState());
    T("   sky tile #2 (second create)", await tile("build", /the sky at/, 1)); await sleep(2500); T("   after #2", await envState());
    T("B2 Create ▸ Terrain", await envItem("Terrain")); T("   shape tile #1", await tile("build", /relief/, 0)); await sleep(4000); T("   after #1", await envState());
    T("   shape tile #2", await tile("build", /relief/, 1)); await sleep(4000); T("   after #2", await envState());
    T("B3 Create ▸ Grass", await envItem("Grass")); T("   plant tile", await tile("build", /plant it/, 0)); await sleep(3000); T("   after", await envState());
    T("B4 Create ▸ Weather", await envItem("Weather")); T("   weather tile (rain?)", await page(`const ts = [...document.querySelectorAll('[data-frame="build"] .sp-tile')].filter((b) => /^(rain|snow|storm|fog|drizzle)/.test(b.title)); ts[0]?.click(); return ts.map((b) => b.title).slice(0, 8);`)); await sleep(2500); T("   after", await envState());
    await shot("B-env-all.png");
    T("B5 Ctrl+Z ×2 (what do the undos take back?)", [await undo(), await undo()]); await sleep(2000); T("   after", await envState());
    // the ✕ rows
    const del = async (k) => { const r = await page(`const row = document.querySelector('[data-frame="hierarchy"] [data-id="env:${k}"]'); const b = row?.querySelector('.sp-mini'); b?.click(); return { row: !!row, btn: b?.textContent }; `); await sleep(3000); return r; };
    for (const k of ["weather", "grass", "terrain", "sky"]) { T(`B6 ✕ ${k}`, await del(k)); T(`   after`, await envState()); }
    await shot("B-env-none.png");
    T("B7 undo ×4", [await undo(), await undo(), await undo(), await undo()]); await sleep(3000); T("   after", await envState());
    for (const k of ["weather", "grass", "terrain", "sky"]) { T(`B8 ✕ ${k} again`, await del(k)); }
    T("   after", await envState());
    // add each back from Create ▸ Environment
    await envItem("Terrain"); T("B9 terrain back", await tile("build", /relief/, 0)); await sleep(4000); T("   after", await envState());
    await envItem("Sky"); T("B9 sky back", await tile("build", /the sky at/, 0)); await sleep(2500); T("   after", await envState());
    await envItem("Weather"); await page(`const ts = [...document.querySelectorAll('[data-frame="build"] .sp-tile')].filter((b) => /^(rain|snow|storm|fog|drizzle)/.test(b.title)); ts[0]?.click(); return 1;`); await sleep(2000); T("B9 weather back", await envState());
    await envItem("Grass"); T("B9 grass back", await tile("build", /plant it/, 0)); await sleep(3000); T("   after", await envState());
    await shot("B-env-back.png");
    T("B10 weather ✕ alone leaves sky?", await del("weather")); T("   after", await envState());
    T("B11 sky ✕ with weather present: weather row?", await del("sky")); T("   after", await envState());
    T("B12 Create ▸ Weather with NO sky", await envItem("Weather")); await page(`const ts = [...document.querySelectorAll('[data-frame="build"] .sp-tile')].filter((b) => /^(rain|snow|storm|fog|drizzle)/.test(b.title)); ts[0]?.click(); return 1;`); await sleep(2000); T("   after", await envState());
    for (const k of ["weather", "grass", "terrain", "sky"]) await del(k);
    T("B13 all removed again (leave the gym as found)", await envState());
  }
  if (ONLY.includes("D")) {   // ---- disabled vs hidden vs eye; reload reconcile
    T("== D disabled / hidden / eye", "");
    const MODEL = await page(`const r = await (await import('/lib/editwrites.js')).send({ verb: 'find', args: { kind: 'model' } }); return r.models[0].model;`);
    const P = "atk-eb" + Date.now().toString(36).slice(-4);
    for (const [id, args] of [[`${P}-par`, { model: MODEL, place: { at: [15, 15] } }], [`${P}-kid`, { model: MODEL, components: { parent: { to: `${P}-par` }, transform: { pos: [0, 1.3, 0] } } }], [`${P}-solo`, { model: MODEL, place: { at: [17, 15] } }]]) { T(`create ${C(id)}`, await send({ verb: "create", args: { id, ...args } })); await sleep(300); }
    await sleep(2500);
    const rowOf = (id) => page(`const w = await import('/lib/world.js'); const r = document.querySelector('[data-frame="hierarchy"] [data-id="${id}"]'); const s = (await import('/lib/state.js')).state.st.entities['${id}']; const mv = await import('/lib/myview.js');
      return { realized: w.entities.has('${id}'), row: r ? { cls: r.className.replace(/sp-item sp-tree-row ?/, ''), text: r.innerText.replace(/\\s+/g, ' ').slice(0, 50), eyeOn: !!r.querySelector('.sp-eye.on') } : null, hidden: s?.comp?.hidden, disabled: s?.comp?.disabled, mine: mv.isMineHidden('${id}') };`);
    T("D0 par/kid/solo", [await rowOf(`${P}-par`), await rowOf(`${P}-kid`), await rowOf(`${P}-solo`)]);
    await page(`(await import('/lib/myview.js')).toggleMineHidden('${P}-par'); return 1;`); await sleep(800); T("D1 eye on par: kid too?", [await rowOf(`${P}-par`), await rowOf(`${P}-kid`)]);
    T("D2 hidden(for all) on par", await send({ verb: "set", args: { id: `${P}-par`, component: "hidden", value: true } })); await sleep(1200); T("   rows", [await rowOf(`${P}-par`), await rowOf(`${P}-kid`)]);
    T("D3 disabled on par (eye + hidden + off)", await send({ verb: "set", args: { id: `${P}-par`, component: "disabled", value: true } })); await sleep(1200); T("   rows", [await rowOf(`${P}-par`), await rowOf(`${P}-kid`)]);
    await page(`(await import('/lib/scenegraph.js')).sceneSelect('${P}-par'); return 1;`); await sleep(800); T("   inspector on an off thing", await page(`return document.querySelector('[data-frame="inspector"]')?.innerText.replace(/\\s+/g, ' ').slice(0, 260);`));
    await page(`(await import('/lib/scenegraph.js')).sceneSelect('${P}-kid'); return 1;`); await sleep(800); T("   inspector on the child of an off thing", await page(`return document.querySelector('[data-frame="inspector"]')?.innerText.replace(/\\s+/g, ' ').slice(0, 260);`));
    T("   eye click on the off row (allowed?)", await page(`const r = document.querySelector('[data-frame="hierarchy"] [data-id="${P}-par"]'); const e = r?.querySelector('.sp-eye'); e?.click(); return { eye: !!e, disabled: e?.disabled }; `)); await sleep(500); T("   rows", [await rowOf(`${P}-par`)]);
    T("D4 un-hide (for all) while off", await send({ verb: "delete", args: { id: `${P}-par`, component: "hidden" } })); await sleep(800); T("   rows", [await rowOf(`${P}-par`), await rowOf(`${P}-kid`)]);
    await shot("D-off.png");
    T("D5 reload with par off", "reloading"); await boot(); await sleep(1500); T("   rows after reload", [await rowOf(`${P}-par`), await rowOf(`${P}-kid`), await rowOf(`${P}-solo`)]);
    T("D6 switch par back on (UI button)", await page(`(await import('/lib/scenegraph.js')).sceneSelect('${P}-par'); await new Promise((z) => setTimeout(z, 600)); const b = [...document.querySelectorAll('[data-frame="inspector"] button')].find((x) => /switch it back on/.test(x.textContent)); b?.click(); return !!b;`));
    await until(`import('/lib/world.js').then((w) => w.entities.has('${P}-par'))`, 15000); await sleep(2500); T("   rows", [await rowOf(`${P}-par`), await rowOf(`${P}-kid`)]);
    T("   kid rides par again?", await page(`const w = await import('/lib/world.js'); const o = w.entities.get('${P}-kid'); return { parent: o?.parent?.userData?.entityId ?? (o ? 'scene' : null), y: o ? +o.getWorldPosition(new (await import('three')).Vector3()).y.toFixed(2) : null };`).catch((e) => String(e).slice(0, 100)));
    T("D7 disable the child only, then move the parent", await send({ verb: "set", args: { id: `${P}-kid`, component: "disabled", value: true } })); await sleep(600);
    T("   move par", await send({ verb: "set", args: { id: `${P}-par`, component: "transform", value: { pos: [16, 0.04, 16] } } })); await sleep(600);
    T("   re-enable kid", await send({ verb: "delete", args: { id: `${P}-kid`, component: "disabled" } })); await sleep(2500);
    T("   kid where?", await page(`const w = await import('/lib/world.js'); const o = w.entities.get('${P}-kid'); const v = o ? o.getWorldPosition(new (await import('three')).Vector3()) : null; return v ? [+v.x.toFixed(2), +v.y.toFixed(2), +v.z.toFixed(2)] : null;`).catch((e) => String(e).slice(0, 100)));
  }
  if (ONLY.includes("E")) {   // ---- one place per thing through the UI
    T("== E model+light through the UI", "");
    const MODEL = await page(`const r = await (await import('/lib/editwrites.js')).send({ verb: 'find', args: { kind: 'model' } }); return r.models[0].model;`);
    const P = "atk-ec" + Date.now().toString(36).slice(-4);
    T(`create ${C(`${P}-m`)}`, await send({ verb: "create", args: { id: `${P}-m`, model: MODEL, place: { at: [18, 15] } } })); await sleep(2500);
    await page(`(await import('/lib/scenegraph.js')).sceneSelect('${P}-m'); return 1;`); await sleep(1000);
    const before = await ents();
    const pop = await page(`const b = [...document.querySelectorAll('[data-frame="inspector"] button')].find((x) => /Add Component/.test(x.textContent)); b?.click(); await new Promise((z) => setTimeout(z, 400));
      const items = [...document.querySelectorAll('.sp-pop-item, .sp-pop button, .sp-popup button, .sp-menu-item')].map((x) => x.textContent.trim()); const li = [...document.querySelectorAll('.sp-pop-item, .sp-pop button, .sp-popup button, .sp-menu-item')].find((x) => x.textContent.trim() === 'Light'); li?.click(); return { btn: !!b, items: items.slice(0, 40), clicked: !!li };`);
    T("E1 Add Component ▸ Light on a model", pop); await sleep(2000);
    const nw = await mine(before); T("   made (a child light?)", nw); made.push(...nw);
    T("   m comps", await page(`return Object.keys((await import('/lib/net.js')).replica.st.entities['${P}-m'].c);`));
    T("E2 direct wire set light on m", await send({ verb: "set", args: { id: `${P}-m`, component: "light", value: { color: 0xffd9a0, intensity: 8, range: 6 } } }));
    T("   toast", await page(`return [...document.querySelectorAll('.toast, .ew-toast, [class*=toast]')].map((e) => e.textContent.trim().slice(0, 120));`));
    // Attributes tab: what JSON floors exist on a model thing, and does one accept a light?
    await page(`[...document.querySelectorAll('button, [role=tab], .edit-tab')].find((b) => b.textContent.trim() === 'Attributes')?.click(); return 1;`); await sleep(800);
    T("E3 Attributes JSON fields", await page(`const f = document.querySelector('[data-frame="attributes"]'); return [...f.querySelectorAll('.sp-json')].map((j) => j.parentElement?.innerText.replace(/\\s+/g, ' ').slice(0, 40));`));
    T("   attributes text", await page(`return document.querySelector('[data-frame="attributes"]')?.innerText.replace(/\\s+/g, ' ').slice(0, 400);`));
    const j = await page(`const f = document.querySelector('[data-frame="attributes"]'); const tas = [...f.querySelectorAll('.sp-json-ta')]; const ta = tas.find((t) => /"kind"|intensity|model|glb/.test(t.value)) ?? tas[0]; if (!ta) return null; ta.closest('.sp-json')?.querySelector('.sp-json-tog')?.click(); ta.focus(); return { n: tas.length, value: ta.value.slice(0, 80) };`);
    T("   a json textarea", j);
    if (j) { await page(`const f = document.querySelector('[data-frame="attributes"]'); const ta = [...f.querySelectorAll('.sp-json-ta')].find((t) => document.activeElement === t) ?? f.querySelector('.sp-json-ta'); ta.focus(); ta.select(); return 1;`);
      await kb(JSON.stringify({ color: 16767392, intensity: 8, range: 6, kind: "point" })); await key("Enter", "Enter", 2); await sleep(1500);
      T("E4 typed a light bag into that JSON floor (Ctrl+Enter)", await page(`const f = document.querySelector('[data-frame="attributes"]'); return { err: f.querySelector('.sp-json-err')?.textContent.slice(0, 160), comps: Object.keys((await import('/lib/net.js')).replica.st.entities['${P}-m'].c) };`)); }
    await page(`[...document.querySelectorAll('button, [role=tab], .edit-tab')].find((b) => b.textContent.trim() === 'Inspector')?.click(); return 1;`); await sleep(500);
    // blueprint: publish m, then create from it with a light folded in (the wire), and the light thing + model
    const pub = await page(`const r = await (await import('/lib/editwrites.js')).publish(['${P}-m'], 'atk-ed-bp2'); return { ok: r?.ok, code: r?.refused?.code, hash: r?.hash ?? r?.refs?.[0]?.id ?? JSON.stringify(r).slice(0, 200) };`); T("E5 publish m", pub); await sleep(500);
    const bps = await page(`return (await import('/lib/editwrites.js')).blueprints().map((b) => ({ hash: b.hash, name: b.name }));`); const bp = bps.find((b) => b.name === "atk-ed-bp2")?.hash; T("   blueprints", bps.slice(-3));
    if (bp) { T("E6 create from blueprint + light", await send({ verb: "create", args: { id: C(`${P}-bpl`), from: bp, components: { light: { color: 0xffd9a0, intensity: 8, range: 6 } } } })); T("   comps", await page(`return Object.keys((await import('/lib/net.js')).replica.st.entities['${P}-bpl']?.c ?? {});`)); }
    T("E7 light thing: Add Component list offers Model?", await page(`const l = Object.keys((await import('/lib/state.js')).state.st.entities).find((k) => k.startsWith('${P}-m-light')); if (!l) return 'no child light'; (await import('/lib/scenegraph.js')).sceneSelect(l); await new Promise((z) => setTimeout(z, 800));
      const b = [...document.querySelectorAll('[data-frame="inspector"] button')].find((x) => /Add Component/.test(x.textContent)); b?.click(); await new Promise((z) => setTimeout(z, 400)); const items = [...document.querySelectorAll('.sp-pop-item, .sp-pop button, .sp-popup button, .sp-menu-item')].map((x) => x.textContent.trim()); document.body.click(); return { l, hasModel: items.some((x) => /model/i.test(x)), n: items.length, items: items.slice(0, 30) };`));
    await shot("E-oneplace.png");
  }
  if (ONLY.includes("F")) {   // ---- the channel box and the label box
    T("== F channel box", "");
    const MODEL = await page(`const r = await (await import('/lib/editwrites.js')).send({ verb: 'find', args: { kind: 'model' } }); return r.models[0].model;`);
    const id = C("atk-ef" + Date.now().toString(36).slice(-4));
    T(`create ${id}`, await send({ verb: "create", args: { id, model: MODEL, place: { at: [19, 15] } } })); await sleep(2500);
    await page(`(await import('/lib/scenegraph.js')).sceneSelect('${id}'); return 1;`); await sleep(1000);
    const nums = await page(`return [...document.querySelectorAll('[data-frame="inspector"] .sp-num')].map((n, i) => ({ i, v: n.value, label: n.closest('.sp-row')?.querySelector('.sp-chan, label, .sp-label')?.textContent.trim().slice(0, 12) }));`); T("F0 number boxes", nums.slice(0, 10));
    const typeNum = async (i, text) => { await page(`const n = [...document.querySelectorAll('[data-frame="inspector"] .sp-num')][${i}]; n.focus(); n.select(); return 1;`); await kb(text); await key("Enter", "Enter"); await sleep(900);
      return page(`const n = [...document.querySelectorAll('[data-frame="inspector"] .sp-num')][${i}]; const e = (await import('/lib/net.js')).replica.st.entities['${id}']; return { box: n?.value, pos: e?.c?.transform?.pos, scale: e?.c?.transform?.scale, q: e?.c?.transform?.q, toast: [...document.querySelectorAll('[class*=toast]')].map((t) => t.textContent.trim().slice(0, 100)).slice(-1) };`); };
    for (const [i, t] of [[0, "0.00"], [0, "-0"], [0, "1e309"], [0, "abc"], [0, "1abc"], [0, "0x10"], [0, "+=10%"], [0, "100000"], [0, "19"], [1, "-5"], [1, "1e-9"]]) T(`F1 pos box[${i}] ← ${JSON.stringify(t)}`, await typeNum(i, t));
    const sc = nums.findIndex((n) => /^s|scale/i.test(n.label ?? "")); const si = sc >= 0 ? sc : 6;
    for (const [i, t] of [[si, "0"], [si, "-1"], [si, "1e5"], [si, "1"]]) T(`F2 scale box[${i}] ← ${JSON.stringify(t)}`, await typeNum(i, t));
    const lab = await page(`const n = document.querySelector('[data-frame="inspector"] input.sp-text'); if (!n) return null; n.focus(); n.select(); return { v: n.value, maxlength: n.maxLength };`); T("F3 label box", lab);
    if (lab) { await kb("L".repeat(5000)); await key("Enter", "Enter"); await sleep(1200);
      T("   after a 5000-char paste + Enter", await page(`const n = document.querySelector('[data-frame="inspector"] input.sp-text'); const e = (await import('/lib/net.js')).replica.st.entities['${id}']; return { boxLen: n?.value.length, stored: String(e?.c?.label ?? '').length, toast: [...document.querySelectorAll('[class*=toast]')].map((t) => t.textContent.trim().slice(0, 100)).slice(-1), row: document.querySelector('[data-frame="hierarchy"] [data-id="${id}"]')?.innerText.replace(/\\s+/g, ' ').slice(0, 60) };`)); }
    await page(`const n = document.querySelector('[data-frame="inspector"] input.sp-text'); n?.focus(); n?.select(); return 1;`); await kb("a\nb​\u0000c"); await key("Enter", "Enter"); await sleep(1000);
    T("F4 label with newline / ZWSP / NUL via the box", await page(`const e = (await import('/lib/net.js')).replica.st.entities['${id}']; return { stored: JSON.stringify(e?.c?.label), row: document.querySelector('[data-frame="hierarchy"] [data-id="${id}"]')?.innerText.slice(0, 40) };`));
    T("F5 label via wire: newline+NUL rendered in the row", await send({ verb: "set", args: { id, component: "label", value: "x\ny\u0000z" } })); await sleep(800);
    T("   row/inspector", await page(`const r = document.querySelector('[data-frame="hierarchy"] [data-id="${id}"]'); return { row: JSON.stringify(r?.innerText.slice(0, 20)), h: r?.getBoundingClientRect().height, insp: JSON.stringify(document.querySelector('[data-frame="inspector"] input.sp-text')?.value) };`));
    await shot("F-channel.png");
  }
  if (ONLY.includes("G")) {   // ---- Hierarchy at 500 things
    T("== G Hierarchy 500", "");
    const P = "atk-eg" + Date.now().toString(36).slice(-4);
    const frame = () => page(`const t0 = performance.now(); let n = 0; await new Promise((z) => { const f = () => { n++; if (performance.now() - t0 < 2000) requestAnimationFrame(f); else z(); }; requestAnimationFrame(f); }); const d = (await import('/lib/editpanels.js')).editPanelsDebug(); const t1 = performance.now(); const rows = d.hierFields(); const t2 = performance.now(); return { fps: +(n / 2).toFixed(1), hierFieldsMs: +(t2 - t1).toFixed(1), rows: d.rows, ents: Object.keys((await import('/lib/state.js')).state.st.entities).length, domRows: document.querySelectorAll('[data-frame="hierarchy"] [data-id]').length };`);
    T("G0 baseline", await frame());
    let okN = 0, t0 = Date.now();
    for (let b = 0; b < 5; b++) { const ops = []; for (let i = 0; i < 100; i++) { const k = b * 100 + i; const id = `${P}-${k}`; ops.push({ verb: "create", args: { id, components: { label: `e${k}`, transform: { pos: [10 + (k % 20) * 0.4, 0.5 + Math.floor(k / 100), -10 + Math.floor((k % 100) / 20) * 0.4] }, ...(k % 10 ? { parent: { to: `${P}-${k - (k % 10)}` } } : {}) } } }); }
      const r = await send({ verb: "batch", args: { ops } }, "batch"); T(`   batch ${b}`, r); if (r.ok) okN += 100; if (!r.ok) break; await sleep(1500); }
    T("G1 created", { okN, ms: Date.now() - t0 }); await sleep(3000);
    T("G2 with 500 more", await frame());
    T("   repaint on one label edit", await page(`const t0 = performance.now(); const r = await (await import('/lib/editwrites.js')).send({ verb: 'set', args: { id: '${P}-0', component: 'label', value: 'e0!' } }, { what: 'label' }); await new Promise((z) => setTimeout(z, 300)); const d = (await import('/lib/editpanels.js')).editPanelsDebug(); const t1 = performance.now(); d.hierFields(); const t2 = performance.now(); return { ok: r.ok, hierFieldsMs: +(t2 - t1).toFixed(1) };`));
    T("   scroll to bottom & hierarchy DOM", await page(`const f = document.querySelector('[data-frame="hierarchy"]'); const sc = [f.querySelector('.sp-tree'), f.querySelector('.schema-scroll')].find((e) => e && e.scrollHeight > e.clientHeight + 4); if (sc) sc.scrollTop = sc.scrollHeight; await new Promise((z) => setTimeout(z, 500)); return { scroller: sc?.className, h: sc?.scrollHeight, rows: f.querySelectorAll('[data-id]').length, lastRow: [...f.querySelectorAll('[data-id]')].at(-1)?.dataset.id };`));
    await shot("G-hier500.png");
    // marquee across layers: shift-drag over the block of new things (they sit at x 10..18, z -10..-8.4)
    if (ONLY.includes("H")) { T("== H marquee", "");
      await page(`const c = await import('/lib/controller.js'); const b = await import('/lib/base.js'); c.myState.pos.set(14, 0, -5); c.myState.yaw = Math.PI; b.bus.emit('cut-adopted'); return 1;`).catch((e) => T("   move", String(e).slice(0, 100))); await sleep(1500);
      const pts = await page(`const w = await import('/lib/world.js'); const r = await import('/lib/render.js').catch(() => null); const THREE = await import('three'); const cam = (r?.camera ?? globalThis.__cam); if (!cam) return null; const cv = document.querySelector('canvas').getBoundingClientRect();
        const out = []; for (const k of [0, 5, 11, 23, 47]) { const o = w.entities.get('${P}-' + k); if (!o) continue; const v = o.getWorldPosition(new THREE.Vector3()).project(cam); out.push({ k, x: Math.round(cv.left + (v.x + 1) / 2 * cv.width), y: Math.round(cv.top + (1 - v.y) / 2 * cv.height), z: +v.z.toFixed(2) }); } return out;`).catch((e) => String(e).slice(0, 120));
      T("   screen points of 5 things", pts);
      if (Array.isArray(pts) && pts.length >= 2) { const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y); const x0 = Math.min(...xs) - 20, y0 = Math.min(...ys) - 20, x1 = Math.max(...xs) + 20, y1 = Math.max(...ys) + 20;
        await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: x0, y: y0, modifiers: 8 }); await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: x0, y: y0, button: "left", buttons: 1, clickCount: 1, modifiers: 8 });
        for (let i = 1; i <= 8; i++) await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: x0 + (x1 - x0) * i / 8, y: y0 + (y1 - y0) * i / 8, buttons: 1, modifiers: 8 });
        await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: x1, y: y1, button: "left", buttons: 0, clickCount: 1, modifiers: 8 }); await sleep(1200);
        T("H1 shift-marquee over them: selection", await page(`const s = (await import('/lib/editpanels.js')).selection(); const st = (await import('/lib/state.js')).state.st.entities; return { n: s.length, depths: s.slice(0, 12).map((id) => ({ id, parent: st[id]?.parent?.to ?? null })), multiRows: document.querySelectorAll('[data-frame="hierarchy"] .sp-tree-row.multi').length };`));
        T("   Inspector with many selected", await page(`return document.querySelector('[data-frame="inspector"]')?.innerText.replace(/\\s+/g, ' ').slice(0, 200);`));
        await shot("H-marquee.png"); }
      // shift-click in the Hierarchy across depths
      T("H2 shift-click rows (a parent, then a grandchild of another parent)", await page(`const f = document.querySelector('[data-frame="hierarchy"]'); const a = f.querySelector('[data-id="${P}-10"]'), b = f.querySelector('[data-id="${P}-23"]'); if (!a || !b) return { a: !!a, b: !!b }; a.dispatchEvent(new MouseEvent('click', { bubbles: true })); await new Promise((z) => setTimeout(z, 300)); b.dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true })); await new Promise((z) => setTimeout(z, 500)); const s = (await import('/lib/editpanels.js')).selection(); return { n: s.length, s: s.slice(0, 20) };`));
    }
    for (let b = 4; b >= 0; b--) { const ops = []; for (let i = 99; i >= 0; i--) ops.push({ verb: "delete", args: { id: `${P}-${b * 100 + i}` } }); const r = await send({ verb: "batch", args: { ops } }, "batch"); T(`   delete batch ${b}`, r.ok ? "ok" : r); await sleep(1200); }
    T("G3 after delete", await frame());
  }
} catch (e) { T("ERR", String(e?.stack ?? e).slice(0, 600)); }
finally {
  for (const id of made.reverse()) { const r = await send({ verb: "delete", args: { id } }).catch(() => null); if (r && !r.ok) T("cleanup " + id, r); await sleep(250); }
  T("page errors", errors.slice(0, 8));
  try { browser.kill(); } catch {} await sleep(500); try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch {}
}
process.exit(0);
