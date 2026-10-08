// tools/protocol/party-probe.ts — the editor's party blockers (review 2026-10-07 edit surface vs platforms, B1–B5 and
// the SHOULD list; audit 10-07 human side) in one headless Chromium against a scratch sequencer, driven with real mouse
// and keyboard events (CDP Input) wherever a person would use them. test:protocol runs it under the house guards.
//   B1  the status chips ("WebGL 2", "reduced detail") never cover the builder's menu bar; the reduced-detail chip can
//       be put away; a real click on Edit ▾ opens the Edit menu
//   B2  Enter in an inspector number field writes once (act + change), with no refused second write
//   B3  World settings opened in builder mode sits over the editor columns, its tabs and row labels readable
//   B5  the hint bar never offers a play key (X sit, E open) in builder mode, where X deletes and E rotates
//   B4  Add Component offers LookAt; "seat", "chair" and "sit" find Sockets; the list is opaque, on screen, one row lit
//   S1  the locked-delete question doesn't have "Delete anyway" focused: Enter deletes nothing
//   S4  Text (and a picture) added to a model shows on its front, outside the model, not at its origin inside it
//   S5  Save as blueprint asks for a name (the thing's label or its model's name, not a hex id)
//   S7  a thing just placed from the library is the selection
//   M   /mute /warn /ghost /unmute /unghost are commands; /bans shows mutes too
//   X   leaving builder mode leaves the old build panel shut; the World inspector's Terrain card offers the ground shapes;
//       toasts sit above the selection bar
//   L   the inspector shows a lock's level; the edit lock and a door's lock read differently; a child of a locked thing
//       shows the inherited lock in the hierarchy
// @ts-nocheck
import fs from "node:fs";
import path from "node:path";
import { scratchBench, mkCheck, sleep } from "../harness.ts";
import { readLog, fold } from "../../shared/protocol/fold.js";

const ENGINE = path.resolve(import.meta.dir, "../..");
const ME = "partyhost", WORLD = "party1";
process.env.TRUST_NAMES = "1";
const CRATE = "eidoverse/assets/models/crate_large_blue.glb";
let worldsDir = "";
const { cdp, evalJson, cleanup, die, BASE } = await scratchBench("party", {
  prepare: (scratch) => {
    worldsDir = path.join(scratch, "worlds"); fs.mkdirSync(worldsDir, { recursive: true });
    const r = Bun.spawnSync(["bun", "tools/protocol/world.ts", "found", WORLD, "--owner", ME, "--title", "party probe"], { cwd: ENGINE, env: { ...process.env, WORLDS_DIR: worldsDir, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" } });
    if (r.exitCode !== 0) throw new Error("founding failed: " + r.stderr.toString());
  },
});
const { check: check0, tally } = mkCheck();
const check = (name: string, ok: any, detail?: any) => check0(name, !!ok, detail === undefined ? "" : typeof detail === "string" ? detail.slice(0, 600) : (JSON.stringify(detail) ?? "").slice(0, 600));
const entries = () => readLog(fs.readFileSync(path.join(worldsDir, WORLD, "world.jsonl")));
const disk = () => fold(entries());
const waitFor = async (expr: string, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { if (await evalJson(expr)) return true; } catch { /* busy */ } await sleep(100); } return false; };
const waitDisk = async (pred: () => boolean, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (pred()) return true; await sleep(100); } return false; };
const page = (js: string) => evalJson(`(async () => { ${js} })()`);
const hint = `(document.getElementById('hintbar')?.textContent ?? '')`;
const shotDir = process.env.PARTY_SHOTS ?? "";
const shot = async (name: string) => { if (!shotDir) return; fs.mkdirSync(shotDir, { recursive: true });
  const r = await cdp.send("Page.captureScreenshot", { format: "png" }); fs.writeFileSync(path.join(shotDir, `${name}.png`), Buffer.from(r.data, "base64")); };
// real input (CDP Input): what a person's mouse and keyboard send
const mouse = async (type: string, x: number, y: number, button = "left") => cdp.send("Input.dispatchMouseEvent", { type, x, y, button, clickCount: type === "mouseMoved" ? 0 : 1, buttons: type === "mousePressed" ? 1 : 0 });
const click = async (x: number, y: number) => { await mouse("mouseMoved", x, y); await mouse("mousePressed", x, y); await mouse("mouseReleased", x, y); };
const KEYS: Record<string, [string, string, number]> = { Enter: ["Enter", "Enter", 13], Escape: ["Escape", "Escape", 27], KeyX: ["x", "KeyX", 88], KeyB: ["b", "KeyB", 66], Tab: ["Tab", "Tab", 9] };
const press = async (k: string) => { const [key, code, vk] = KEYS[k];
  await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key, code, windowsVirtualKeyCode: vk, ...(key.length === 1 ? { text: key } : k === "Enter" ? { text: "\r" } : {}) });
  await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key, code, windowsVirtualKeyCode: vk }); };
const type = (s: string) => cdp.send("Input.insertText", { text: s });
const centre = (sel: string) => evalJson(`(() => { const e = ${sel}; if (!e) return null; e.scrollIntoView?.({ block: 'nearest' }); const r = e.getBoundingClientRect(); return r.width ? [r.left + r.width / 2, r.top + r.height / 2] : null; })()`);
const clickEl = async (sel: string) => { const c = await centre(sel); if (!c) return false; await click(c[0], c[1]); return true; };
const insp = `document.querySelector('[data-frame="inspector"]')`;
const select = async (id: string) => { await page(`(await import('/lib/scenegraph.js')).sceneSelect('${id}'); return true;`); await waitFor(`import('/lib/scenegraph.js').then((m) => m.sceneSelected() === '${id}')`); await sleep(400); };
const editMode = async (on: boolean) => { await evalJson(`import('/lib/build.js').then((m) => (m.setEditMode(${on}), true))`); await waitFor(`document.body.classList.contains('edit-mode') === ${on}`); await sleep(500); };
const make = (id: string, comps: string, at: [number, number, number], model = CRATE) => page(`const m = await import('/lib/net.js'); return await m.sendRequest('create', { id: '${id}', ${model ? `model: '${model}', ` : ""}components: { ${comps} transform: { pos: [${at}], q: [0, 0, 0, 1], scale: [1, 1, 1] } } });`);
const chatLines = `[...document.querySelectorAll('#chatlog .line, #chatlog > *')].map((l) => l.textContent)`;

function guest(name: string) {
  const ws = new WebSocket(BASE.replace("http", "ws") + "/ws"); const msgs: any[] = [];
  ws.onmessage = (ev) => { try { msgs.push(JSON.parse(String(ev.data))); } catch {} };
  const opened = new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  return { ws, msgs, async join() { await opened; ws.send(JSON.stringify({ type: "join", world: WORLD, id: name, avatar: "", replica: true }));
    const t0 = Date.now(); while (Date.now() - t0 < 5000) { if (msgs.some((m) => m.type === "snapshot" || m.type === "error")) return; await sleep(50); } } };
}

try {
  await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: `window.__errs = []; addEventListener('error', (e) => __errs.push('error: ' + e.message));
    window.__refused = []; import('/lib/base.js').then((m) => { m.bus.on('edit-refused', (e) => __refused.push(e)); });` });
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await cdp.send("Page.navigate", { url: `${BASE}/?name=${ME}&world=${WORLD}&webgl=1` });   // WebGL 2: the headless WebGPU path fails its buffers and climbs in memory on this host
  let secs = 0; for (let i = 0; i < 160 && secs < 4; i++) { secs = (await evalJson(`document.querySelectorAll('.sec').length`).catch(() => 0)) ?? 0; if (secs < 4) await sleep(500); }
  check("boot: the client comes up", secs >= 4, `${secs} sections`);
  if (secs < 4) await die(1, "the page never booted");
  await evalJson(`(() => { const s = document.querySelector('#splash'); if (s) s.style.pointerEvents = 'none'; return true; })()`);
  check("boot: a world", await waitFor(`import('/lib/net.js').then((m) => m.replicaActive())`));
  await waitFor(`import('/lib/mybody.js').then((m) => !!m.getMe())`, 30000);
  const T0 = Date.now();
  const ONLY = (process.env.PARTY_ONLY ?? '').split(',').filter(Boolean);   // PARTY_ONLY=B5,S4 runs just those (a re-check)
  const stage = async (id: string, fn: () => Promise<void>) => { if (ONLY.length && !ONLY.includes(id)) return; console.log(`  · ${id} at ${((Date.now() - T0) / 1000).toFixed(0)} s`); try { await fn(); } catch (e) { check(`${id} (the stage threw)`, false, String(e?.message ?? e)); } };
  const me = await evalJson(`import('/lib/controller.js').then((m) => m.myState.pos.toArray())`);
  const near = (dx: number, dz: number): [number, number, number] => [+(me[0] + dx).toFixed(2), +me[1].toFixed(2), +(me[2] + dz).toFixed(2)];

  // ---- B1: the status chips and the menu bar ----
  await stage("B1", async () => {
    await page(`const s = await import('/lib/statuschips.js'); const c = await import('/lib/capnotice.js'); s.statusChip({ id: 'webgl', ...c.WEBGL, actions: [{ label: 'got it' }] }); const g = await import('/lib/governor.js'); s.statusChip(g.REDUCED_CHIP); return true;`);
    await editMode(true); await sleep(2200);   // the strip re-places on its slow tick too
    const covered = await evalJson(`[...document.querySelectorAll('.edit-top .edit-btn, .edit-top .edit-vbtn')].filter((b) => b.getBoundingClientRect().width).map((b) => { const r = b.getBoundingClientRect(); const e = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return b.contains(e) ? null : (b.textContent.trim() || b.title) + ' ← ' + (e?.closest('.stchip')?.textContent ?? e?.className ?? '?'); }).filter(Boolean)`);
    const chips = await evalJson(`[...document.querySelectorAll('.stchip')].map((c) => c.textContent.trim())`);
    check("B1a with both chips up, every menu-bar button is the topmost thing at its own centre", chips.length >= 2 && covered.length === 0, { covered, chips });
    await shot("B1-menubar");
    await clickEl(`[...document.querySelectorAll('.edit-top .edit-btn')].find((b) => /^Edit/.test(b.textContent))`);
    check("B1b a real click on Edit ▾ opens the Edit menu (not a chip's card)", await waitFor(`[...document.querySelectorAll('.edit-menu-pop')].some((p) => !p.hidden && /undo/.test(p.textContent))`, 2000), await evalJson(`document.getElementById('stpop')?.hidden`));
    await press("Escape"); await sleep(300);
    check("B1d Esc closes the menu and leaves you in builder mode", await evalJson(`![...document.querySelectorAll('.edit-menu-pop')].some((p) => !p.hidden) && document.body.classList.contains('edit-mode')`));
    await clickEl(`document.getElementById('stchip-quality-reduced')`);
    const acts = await evalJson(`[...document.querySelectorAll('#stpop .st-btns button')].map((b) => b.textContent)`);
    const hide = await clickEl(`[...document.querySelectorAll('#stpop .st-btns button')].find((b) => /hide|don/.test(b.textContent))`);
    check("B1c the reduced-detail chip can be put away", hide && await waitFor(`!document.getElementById('stchip-quality-reduced')`, 2000), acts);
    await page(`(await import('/lib/statuschips.js')).clearStatusChip('webgl'); return true;`);
  });

  // ---- B2: Enter in a number field ----
  await stage("B2", async () => {
    await editMode(true);
    check("(setup) a crate", (await make("box2", "label: 'Box Two',", near(3, 3)))?.ok);
    await waitFor(`import('/lib/world.js').then((m) => m.entities.has('box2'))`);
    await select("box2");
    const field = `[...${insp}.querySelectorAll('.sp-row')].find((r) => /rotate y/.test(r.querySelector('.sp-label')?.textContent ?? ''))?.querySelector('.sp-num')`;
    check("(setup) the inspector shows rotate y", await waitFor(`!!(${field})`, 5000));
    const n0 = entries().length; const r0 = await evalJson(`__refused.length`);
    await clickEl(field); await sleep(150);
    await evalJson(`(() => { const n = ${field}; n.focus(); n.select(); return document.activeElement === n; })()`);
    await type("45"); await press("Enter");
    await waitDisk(() => entries().length > n0, 4000); await sleep(1500);
    const added = entries().slice(n0).map((e: any) => `${e.kind}:${e.verb ?? ""}${e.refused ? ":REFUSED" : ""}`);
    check("B2a Enter writes once: one act and its change, no refused second write", added.length === 2 && !added.some((a) => /REFUSED/.test(a)), added);
    check("B2b …and no refusal toast", (await evalJson(`__refused.length`)) === r0, await evalJson(`__refused.slice(${r0}).map((r) => r.text)`));
    const q = disk().entities.box2?.c.transform?.q; check("B2c …and it turned to 45°", q && Math.abs(2 * Math.asin(q[1]) * 180 / Math.PI - 45) < 0.5, q);
  });

  // ---- B3: World settings in builder mode ----
  await stage("B3", async () => {
    await editMode(true);
    await clickEl(`document.querySelector('#dock button[data-toggles="world-settings"]')`);
    await waitFor(`!!document.querySelector('[data-frame="world-settings"]') && getComputedStyle(document.querySelector('[data-frame="world-settings"]')).display !== 'none'`, 4000);
    await sleep(1200);
    const hidden = await evalJson(`(() => { const f = document.querySelector('[data-frame="world-settings"]'); const box = (f.querySelector('.fr-body') ?? f).getBoundingClientRect();
      const els = [...f.querySelectorAll('button, .rp-label, label, th, td:first-child, b')].filter((e) => { const r = e.getBoundingClientRect(); const cy = r.top + r.height / 2; return r.width && r.height && cy > Math.max(0, box.top) && cy < Math.min(innerHeight, box.bottom); });
      return { n: els.length, under: els.filter((e) => { const r = e.getBoundingClientRect(); const x = Math.max(r.left + 2, Math.min(r.left + r.width / 2, innerWidth - 2)); const t = document.elementFromPoint(x, r.top + r.height / 2); return !f.contains(t); }).map((e) => e.textContent.trim().slice(0, 20)).slice(0, 12) }; })()`);
    check("B3 World settings opened in builder mode: its tabs and labels are on top, not under the editor columns", hidden.n > 3 && hidden.under.length === 0, hidden);
    await shot("B3-world-settings");
    await clickEl(`document.querySelector('#dock button[data-toggles="world-settings"]')`); await sleep(300);
  });

  // ---- B5: play hints in builder mode ----
  await stage("B5", async () => {
    await editMode(false);
    check("(setup) a bench beside me", (await make("bench5", "label: 'Bench', sockets: { seat: { pos: [0, 0.5, 0], body: { action: 'sit' } } },", near(0.9, 0)))?.ok);
    check("(control) in look mode the hint bar offers X — sit", await waitFor(`/X\\s*—\\s*sit/.test(${hint}) && !document.getElementById('hintbar').classList.contains('gone')`, 6000), await evalJson(hint));
    await editMode(true); await sleep(4000);   // past the builder-mode welcome, which borrows the bar for 2.6 s
    const shown = await evalJson(`({ text: ${hint}, gone: document.getElementById('hintbar').classList.contains('gone') })`);
    check("B5 in builder mode the hint bar doesn't offer 'X — sit' (X deletes here)", shown.gone || !/—\s*sit|E\s*open/.test(shown.text), shown);
    await page(`const m = await import('/lib/net.js'); return await m.sendRequest('delete', { id: 'bench5' });`);
  });

  // ---- B4 (human side): Add Component ----
  await stage("B4", async () => {
    await editMode(true);
    await select("box2");
    await clickEl(`${insp}.querySelector('.sp-pop-btn')`);
    check("(setup) Add Component opens", await waitFor(`!!document.querySelector('.sp-pop-search')`, 3000));
    const all = await evalJson(`[...document.querySelectorAll('.sp-pop-item')].map((b) => b.textContent)`);
    check("B4a Add Component offers LookAt (the authority takes look-at now)", all.some((t: string) => /^LookAt/.test(t)), all);
    const box = await evalJson(`(() => { const b = document.querySelector('.sp-pop'); const r = b.getBoundingClientRect(); const bg = getComputedStyle(b).backgroundColor; const items = [...b.querySelectorAll('.sp-pop-item')];
      const lit = items.filter((i) => { const c = getComputedStyle(i).backgroundColor; const a = /rgba\\([^)]*,\\s*([\\d.]+)\\)/.exec(c); return !(c === 'transparent' || (a && +a[1] < 0.05)); }).length;
      return { bg, inside: r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight, rect: [r.left, r.top, r.right, r.bottom], lit, n: items.length }; })()`);
    check("B4b the list is opaque", !/rgba\([^)]*,\s*0?\.\d+\)/.test(box.bg) && box.bg !== "transparent", box);
    check("B4c …entirely on screen", box.inside, box);
    check("B4d …and at most one row is lit (the keyboard's), not every row", box.lit <= 1 && box.n > 3, box);
    await shot("B4-addcomp");
    for (const w of ["seat", "chair", "sit"]) {
      await evalJson(`(() => { const i = document.querySelector('.sp-pop-search'); i.value = ''; i.focus(); return true; })()`);
      await type(w); await sleep(150);
      const items = await evalJson(`[...document.querySelectorAll('.sp-pop-item')].map((b) => b.textContent)`);
      check(`B4e '${w}' finds the seat component (Sockets)`, items.some((t: string) => /Sockets|seat/i.test(t)), items);
    }
    await press("Escape");
  });

  // ---- S1: the locked-delete question ----
  await stage("S1", async () => {
    await editMode(true);
    check("(setup) a locked crate", (await make("lockd", "label: 'Locked crate', lock: true,", near(-3, 3)))?.ok);
    await waitFor(`import('/lib/world.js').then((m) => m.entities.has('lockd'))`);
    await select("lockd");
    await evalJson(`document.activeElement?.blur?.(), true`);
    await press("KeyX");
    check("(setup) X asks the lock question", await waitFor(`!!document.querySelector('#confirm-center')`, 4000));
    const focus = await evalJson(`document.activeElement?.textContent ?? ''`);
    check("S1a 'Delete anyway' is not the focused answer", !/Delete anyway/.test(focus), focus);
    await shot("S1-locked-X");
    await press("Enter"); await sleep(1200);
    check("S1b Enter on the question deletes nothing", !!disk().entities.lockd && !(await evalJson(`!!document.querySelector('#confirm-center')`)));
  });

  // ---- S4: a sign on a crate shows ----
  await stage("S4", async () => {
    check("(setup) a crate for a sign", (await make("signbox", "label: 'Sign box',", near(-2, 5)))?.ok);
    await waitFor(`import('/lib/world.js').then((m) => !!m.entities.get('signbox')?.userData.base)`, 8000);
    await select("signbox");
    await clickEl(`${insp}.querySelector('.sp-pop-btn')`);
    await waitFor(`!!document.querySelector('.sp-pop-search')`, 3000);
    await clickEl(`[...document.querySelectorAll('.sp-pop-item')].find((b) => /^Text/.test(b.textContent))`);
    const where = `(async () => { const [w, T] = [await import('/lib/world.js'), await import('/lib/core.js')]; const crate = w.entities.get('signbox'); crate.updateWorldMatrix(true, true);
      const kids = new Set([...w.entities.values()].filter((o) => o !== crate)); const own = (o) => { for (let p = o; p && p !== crate; p = p.parent) if (kids.has(p) || p.name === 'sign' || p.userData?.pictureQuad) return false; return true; };
      const cb = new T.THREE.Box3(); crate.traverse((o) => { if (o.isMesh && own(o)) { o.geometry.computeBoundingBox?.(); const b = o.geometry.boundingBox?.clone().applyMatrix4(o.matrixWorld); if (b) cb.union(b); } });
      const signs = []; T.scene.traverse((o) => { if (o.name === 'sign' && o.userData?.sign) signs.push(o); });
      const out = signs.map((s) => { s.updateWorldMatrix(true, true); const b = new T.THREE.Box3().setFromObject(s); const c = b.getCenter(new T.THREE.Vector3()); return { id: s.userData.sign, c: c.toArray().map((v) => +v.toFixed(2)), inside: cb.containsPoint(c) }; });
      return { crate: [cb.min.toArray().map((v) => +v.toFixed(2)), cb.max.toArray().map((v) => +v.toFixed(2))], out }; })()`;
    await waitDisk(() => Object.values(disk().entities).some((e: any) => e.c.text), 5000); await sleep(1500);
    const w = await evalJson(where);
    check("S4a Text added to a crate is drawn on its front face (past it), not at its origin inside it", w.out.length >= 1 && w.out.every((s: any) => !s.inside && s.c[2] >= w.crate[1][2] - 0.02 && s.c[1] > w.crate[0][1] + 0.2), w);
    const sel = await evalJson(`import('/lib/scenegraph.js').then((m) => m.sceneSelected())`);
    const textOn = Object.entries(disk().entities).find(([, e]: any) => e.c.text)?.[0];
    check("S4b …it is its own thing riding the crate, and it is selected (its card is in front of you)", textOn && textOn !== "signbox" && disk().entities[textOn]?.c.parent?.to === "signbox" && sel === textOn, { sel, textOn });
    await shot("S4-sign");
    // a picture, through the same path the upload gesture ends in (the file chooser itself can't open headless)
    await select("signbox");
    const pr = await page(`const m = await import('/lib/facemedia.js'); return await m.addOnFace('signbox', 'picture', { src: 'eidoverse/assets/sky/moon_color_1k.jpg' });`).catch((e) => ({ err: String(e) }));
    await sleep(800);
    const pic = Object.entries(disk().entities).find(([, e]: any) => e.c.picture);
    const pos = pic?.[1].c.transform?.pos;
    check("S4c a picture added to the crate stands on its front face (its own child, past the crate's front)", pic && pic[1].c.parent?.to === "signbox" && pos && pos[2] > 0.2, { pr, pic });
  });

  // ---- S5: Save as blueprint asks for a name ----
  await stage("S5", async () => {
    await editMode(true);
    check("(setup) an unlabelled crate", (await make("bpbox", "", near(4, -3)))?.ok);
    await waitFor(`import('/lib/world.js').then((m) => m.entities.has('bpbox'))`);
    await select("bpbox");
    await page(`(await import('/lib/base.js')).bus.emit('edit-lefttab', 'build'); return true;`);
    await evalJson(`document.querySelector('.edit-left .edit-tab[data-tab="build"]')?.click(), true`); await sleep(500);
    const ok = await clickEl(`[...document.querySelectorAll('.edit-left button')].find((b) => /save as blueprint/.test(b.textContent))`);
    check("(setup) the save button is there", ok);
    const asked = await waitFor(`!!document.querySelector('#confirm-center input')`, 3000);
    const dflt = asked ? await evalJson(`document.querySelector('#confirm-center input').value`) : null;
    check("S5a Save as blueprint asks for a name", asked);
    check("S5b …offering a person's word for it (its model's name), not a hex id", asked && /crate/i.test(dflt) && !/^[0-9a-f]{8}$/.test(dflt), dflt);
    if (asked) { await evalJson(`(() => { const i = document.querySelector('#confirm-center input'); i.focus(); i.select(); return true; })()`); await type("Party stage"); await press("Enter"); }
    check("S5c …and saves it under the name given", await waitDisk(() => Object.entries(disk().entities["@world"]?.c ?? {}).some(([k, v]: any) => k.startsWith("blueprints:") && v?.name === "Party stage"), 5000),
      Object.entries(disk().entities["@world"]?.c ?? {}).filter(([k]) => k.startsWith("blueprints:")).map(([, v]: any) => v?.name));
  });

  // ---- S7: a placed thing is selected ----
  await stage("S7", async () => {
    await page(`(await import('/lib/scenegraph.js')).sceneSelect(null); (await import('/lib/build.js')).deselectAll?.(); return true;`); await sleep(300);
    await page(`await (await import('/lib/build.js')).holdGhost('${CRATE}', 'crate (blue)'); return true;`);
    await sleep(1500);
    const vp = await evalJson(`(() => { const l = parseFloat(getComputedStyle(document.body).getPropertyValue('--edit-left-edge')) || 0; const r = parseFloat(getComputedStyle(document.body).getPropertyValue('--edit-right-w')) || 0; return [l + (innerWidth - r - l) / 2, innerHeight * 0.62]; })()`);
    const before = new Set(Object.keys(disk().entities));
    await mouse("mouseMoved", vp[0] - 20, vp[1]); await sleep(200); await mouse("mouseMoved", vp[0], vp[1]); await sleep(400);
    await click(vp[0], vp[1]);
    await waitDisk(() => Object.keys(disk().entities).some((k) => !before.has(k)), 5000);
    const made = Object.keys(disk().entities).find((k) => !before.has(k));
    check("(setup) a click in the world placed it", !!made, made);
    check("S7 the thing just placed is the selection", made && await waitFor(`import('/lib/scenegraph.js').then((m) => m.sceneSelected() === '${made}')`, 4000), await evalJson(`import('/lib/scenegraph.js').then((m) => m.sceneSelected())`));
    await press("Escape");
  });

  // ---- L: what the inspector and hierarchy say about locks ----
  await stage("L", async () => {
    await editMode(true);
    if (!disk().entities.lockd) await make("lockd", "label: 'Locked crate', lock: true,", near(-3, 3));
    check("(setup) a door-crate under the locked crate", (await make("child1", "label: 'Lid', parent: { to: 'lockd' }, openable: { open: false, locked: false }, reactions: { open: { kind: 'toggle', unless: 'locked' } },", [0, 1.6, 0]))?.ok);
    await select("lockd"); await sleep(400);
    const labels = await evalJson(`[...${insp}.querySelectorAll('.sp-row')].filter((r) => r.querySelector('input[type=checkbox]')).map((r) => r.querySelector('.sp-label')?.textContent ?? '')`);
    const lev = await evalJson(`[...${insp}.querySelectorAll('.sp-row')].map((r) => r.textContent).filter((t) => /builder|moderator|owner/.test(t) && /lock/i.test(t))`);
    check("L1 the inspector shows the lock's level", lev.length > 0, { lev, labels });
    await select("child1"); await sleep(400);
    const cl = await evalJson(`[...${insp}.querySelectorAll('.sp-row')].filter((r) => r.querySelector('input[type=checkbox]')).map((r) => r.querySelector('.sp-label')?.textContent ?? '')`);
    check("L2 the door's lock and the edit lock read differently (no two rows just 'locked')", cl.filter((t: string) => t.trim() === "locked").length === 0, cl);
    await evalJson(`document.querySelector('.edit-left .edit-tab[data-tab="hierarchy"]')?.click(), true`); await sleep(700);
    const row = await evalJson(`(() => { const r = document.querySelector('[data-frame="hierarchy"] .sp-tree-row[data-id="child1"]'); const l = r?.querySelector('.sp-lock'); return r ? { lock: l?.outerHTML.slice(0, 400) ?? null, text: r.textContent } : null; })()`);
    check("L3 the hierarchy shows the child of a locked thing as held by it (not an open padlock)", row?.lock && /inherited/.test(row.lock) && /held by/.test(row.lock), row);
    await evalJson(`document.querySelector('.edit-left .edit-tab[data-tab="build"]')?.click(), true`);
  });

  // ---- M: moderation commands ----
  await stage("M", async () => {
    await editMode(false);
    const vic = guest("vicky"); await vic.join(); await sleep(800);
    const say = async (s: string) => { await clickEl(`document.getElementById('chatline')`); await evalJson(`(() => { const t = document.getElementById('chatline'); t.value = ''; t.focus(); return true; })()`); await type(s); await press("Enter"); await sleep(700); };
    const log = () => evalJson(`document.querySelector('[data-frame="chat"]')?.textContent ?? ''`);
    for (const c of ["/mute vicky 5 chat too loud", "/warn vicky please", "/unmute vicky", "/ghost vicky 5", "/unghost vicky"]) {
      const before = (await log()).split("unknown command").length;
      await say(c); await sleep(500);
      check(`M1 ${c.split(" ")[0]} is a command (not "unknown command")`, (await log()).split("unknown command").length === before, (await log()).slice(-300));
    }
    await say("/mute vicky 5 chat again"); await sleep(1200);
    const lines = async () => ((await log()).match(/muted \((?:chat|voice)[^)]*\): vicky/g) ?? []).length;   // the /bans line's own shape ("muted (chat): vicky until …")
    const n0 = await lines();
    await say("/bans");
    if (await evalJson(`!!document.getElementById('chatline').value.trim()`)) { await press("Enter"); }   // the first Enter took the autocomplete's "/bans "
    await sleep(1500);
    const tail = { before: n0, after: await lines(), end: (await log()).slice(-300) };
    check("M2 /bans lists the mute in force, not only bans", tail.after > tail.before, tail);
    // someone else is here, so the remote-body frame loop runs: it must not throw (staging 10-07: remotes.js re-exported
    // serverNow without importing it, and every frame failed while anyone else was present)
    const frameErrs = await evalJson(`[...document.querySelectorAll('.toast')].map((t) => t.textContent).filter((t) => /frame remotes|is not defined/.test(t))`);
    check("M3 with another person present, the frame loop draws them without an error", frameErrs.length === 0, frameErrs);
    vic.ws.close();
  });
  // ---- X: the leftovers (review 10-07 S14, S15, S11) ----
  await stage("X", async () => {
    await editMode(false);
    const worldOpen = `(() => { const f = document.querySelector('[data-frame="world"]'); return !!f && getComputedStyle(f).display !== 'none'; })()`;
    await page(`(await import('/lib/windows.js')).getFrame('world')?.hide(); return true;`); await sleep(300);
    await editMode(true); await sleep(600); await editMode(false); await sleep(600);
    check("X1 leaving builder mode doesn't leave the old build panel open (it wasn't open before)", !(await evalJson(worldOpen)));
    await editMode(true);
    await evalJson(`document.querySelector('.edit-left .edit-tab[data-tab="hierarchy"]')?.click(), true`); await sleep(600);
    await clickEl(`[...document.querySelectorAll('[data-frame="hierarchy"] .sp-item')].find((r) => r.dataset.id === '@world')`); await sleep(800);
    const card = await evalJson(`(() => { const h = [...${insp}.querySelectorAll('.sp-group')].find((g) => /Terrain/.test(g.textContent)); if (!h) return null; const out = [];
      for (let n = h.parentElement.nextElementSibling; n && !n.classList.contains('sp-f-group'); n = n.nextElementSibling) out.push({ text: n.textContent.slice(0, 80), tiles: n.querySelectorAll('button').length }); return out; })()`);
    check("X2 the World inspector's Terrain card offers the ground shapes when there's no terrain yet", card && card.some((r: any) => r.tiles >= 2), card);
    const t0 = !!disk().entities["@world"]?.c.terrain;
    const picked = await clickEl(`(() => { const h = [...${insp}.querySelectorAll('.sp-group')].find((g) => /Terrain/.test(g.textContent)); for (let n = h?.parentElement.nextElementSibling; n && !n.classList.contains('sp-f-group'); n = n.nextElementSibling) { const b = n.querySelector('button'); if (b) return b; } return null; })()`);
    check("X3 …and a pick there writes the terrain (one act)", picked && !t0 && await waitDisk(() => !!disk().entities["@world"]?.c.terrain, 5000), { picked, t0 });
    await shot("X-terrain-card");
    check("X4 in builder mode the toasts sit above the selection bar", await evalJson(`(() => { const t = document.getElementById('trayzone'); return parseFloat(getComputedStyle(t).bottom) >= 110; })()`));
    await evalJson(`document.querySelector('.edit-left .edit-tab[data-tab="build"]')?.click(), true`);
  });
  check("errors: no page error", await evalJson(`__errs.length === 0`), await evalJson(`__errs`));
} catch (e) { check("the run threw", false, String(e?.stack ?? e)); }
console.log(`[party-probe] ${tally.passed} passed, ${tally.failed} failed`);
await cleanup(tally.failed ? 1 : 0);
process.exit(tally.failed ? 1 : 0);
