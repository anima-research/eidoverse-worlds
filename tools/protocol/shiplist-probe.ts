// tools/protocol/shiplist-probe.ts — the ship list's group A in a real browser (one headless Chromium against a scratch
// sequencer, tools/harness.ts scratchBench; test:protocol runs it under the house guards, like client-check):
//   D   a desktop visitor's door: the hint bar offers "E open “Gate”" within reach; E opens it through the authority (one
//       use act); every client draws it swinging (it turns about its hinge over its time, then rests open); E again
//       offers "close" and closes it
//   F   a refusal reads in a person's words (no code, no tool syntax, the thing by its label), the authority's whole answer
//       still on the event for the console
//   W   a write the authority warns about (it floats) shows the warning to the person, by label
//   V   in a headset (renderer.xr presenting, emulated), a moderator's warning rides the XR quad, not the DOM card
//   E   the editor: the Inspector's Openable card (its rows; a hinge button writes the pivot), and Add Component finds
//       Openable by 'door' and adding it makes the thing usable
// @ts-nocheck
import fs from "node:fs";
import path from "node:path";
import { scratchBench, mkCheck, sleep } from "../harness.ts";
import { readLog, fold } from "../../shared/protocol/fold.js";

const ENGINE = path.resolve(import.meta.dir, "../..");
const ME = "shipbot", WORLD = "ship4";
process.env.TRUST_NAMES = "1";
const CRATE = "eidoverse/assets/models/crate_large_blue.glb";
let worldsDir = "";
import { pagedEval } from "./idalias.ts";
// R 10-17: the page names what it makes with placeholders (tools/protocol/idalias.ts pageIds); every page answer brings the
// minted ids back (NODE), and N(name) reads a scene name as its id for the node-side checks
const NAMES = ["mta", "mtb", "prbox0", "prbox1", "prbox2", "acbox", "anchor", "atbox", "box1", "clbox", "cloud", "ctbox", "cuball", "gate", "getool", "hdsign", "hpball", "htcrate", "hysign", "nhball", "nlbox", "pobase", "potop", "rbbtn", "rbtgt", "slcrate", "slfloor", "sthigh", "stlow", "syb", "syorb", "wbcrate", "wgcrate", "sba", "sbb", "crate-2", "crate-3"];
const NODE = new Map<string, string>(); const N = (n: string) => NODE.get(n) ?? n;
const { cdp, evalJson: evalRaw, cleanup, die, BASE, SCRATCH } = await scratchBench("shiplist", {
  prepare: (scratch) => {
    worldsDir = path.join(scratch, "worlds"); fs.mkdirSync(worldsDir, { recursive: true });
    const r = Bun.spawnSync(["bun", "tools/protocol/world.ts", "found", WORLD, "--owner", ME, "--title", "ship list probe"], { cwd: ENGINE, env: { ...process.env, WORLDS_DIR: worldsDir, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" } });
    if (r.exitCode !== 0) throw new Error("founding failed: " + r.stderr.toString());
  },
});
const evalJson = pagedEval(evalRaw, NAMES, NODE);
const { check: check0, tally } = mkCheck();
const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
const check = (name: string, ok: any, detail?: any) => check0(name, !!ok, detail === undefined ? "" : typeof detail === "string" ? detail.slice(0, 600) : (JSON.stringify(detail) ?? "").slice(0, 600));
const entries = () => readLog(fs.readFileSync(path.join(worldsDir, WORLD, "world.jsonl")));
const disk = () => fold(entries());
const waitFor = async (expr: string, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { if (await evalJson(expr)) return true; } catch { /* busy */ } await sleep(100); } return false; };
const waitDisk = async (pred: () => boolean, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (pred()) return true; await sleep(100); } return false; };
const key = (code: string) => evalJson(`dispatchEvent(new KeyboardEvent('keydown', { code: '${code}', key: '${code}', bubbles: true })), dispatchEvent(new KeyboardEvent('keyup', { code: '${code}', key: '${code}', bubbles: true })), true`);
const page = (js: string) => evalJson(`(async () => { ${js} })()`);
const hint = `(document.getElementById('hintbar')?.textContent ?? '')`;

try {
  await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: `window.__errs = []; addEventListener('error', (e) => __errs.push('error: ' + e.message));
    window.__refused = []; window.__warned = []; window.__phys = [];
    import('/lib/base.js').then((m) => { m.bus.on('edit-refused', (e) => __refused.push(e)); m.bus.on('edit-warned', (e) => __warned.push(e)); m.bus.on('thingphysics-refused', (e) => __phys.push({ verb: e.verb, code: e.refused?.code })); });` });
  await cdp.send("Page.navigate", { url: `${BASE}/?name=${ME}&world=${WORLD}` });
  let secs = 0; for (let i = 0; i < 160 && secs < 4; i++) { secs = (await evalJson(`document.querySelectorAll('.sec').length`).catch(() => 0)) ?? 0; if (secs < 4) await sleep(500); }
  check("boot: the client comes up", secs >= 4, `${secs} sections`);
  if (secs < 4) await die(1, "the page never booted");
  await evalJson(`(() => { const s = document.querySelector('#splash'); if (s) s.style.pointerEvents = 'none'; return true; })()`);
  check("boot: a world", await waitFor(`import('/lib/net.js').then((m) => m.replicaActive())`));

  // each stage stands alone: a stage that throws is a FAIL of that stage, and the next still runs (the base: every stage red)
  const ONLY = process.env.STAGES ? new Set(process.env.STAGES.split(",")) : null;   // STAGES=HT,HP runs just those (a quick look; the suite runs all)
  const stage = async (id: string, fn: () => Promise<void>) => { if (ONLY && !ONLY.has(id)) return; try { await fn(); } catch (e) { check(`${id} (the stage threw)`, false, String(e?.message ?? e)); } };
  // ---- D: the authority, as a desktop visitor meets it ----
  const me = await evalJson(`import('/lib/controller.js').then((m) => m.myState.pos.toArray())`);
  const at = [me[0] + 1.2, me[2]];
  await stage("D", async () => {
  const made = await page(`const m = await import('/lib/net.js'); return await m.sendRequest('create', { id: 'gate', model: '${CRATE}', components: { label: 'Gate', pivot: { pos: [-0.5, 0, 0] }, openable: { open: false, locked: false, angle: ${Math.PI / 2}, time: 1.2 }, reactions: { open: { kind: 'toggle', unless: 'locked' } }, transform: { pos: [${at[0]}, ${me[1]}, ${at[1]}], q: [0, 0, 0, 1], scale: [1, 1, 1] } } });`);
  check("(setup) a gate beside me (openable + its open action)", made?.ok, made);
  await waitFor(`import('/lib/world.js').then((m) => !!m.entities.get('gate') && !!m.entities.get('gate').userData.base)`);
  check("D1 the hint bar offers it: E open “Gate”", await waitFor(`/E\\s*open\\s*“Gate”/.test(${hint})`, 6000), await evalJson(hint));
  const q0 = await evalJson(`import('/lib/world.js').then((m) => m.entities.get('gate').quaternion.toArray())`);
  const uses0 = entries().filter((e: any) => e.kind === "act" && e.verb === "use").length;
  // an in-page sampler (CDP round trips are too slow to time a 1.2 s swing): how open the tween says, and the angle the
  // gate is DRAWN at, every 40 ms for 4 s from just before E
  await evalJson(`(window.__samp = (async () => { const [o, w] = await Promise.all([import('/lib/openable.js'), import('/lib/world.js')]); const out = []; const t0 = performance.now();
    while (performance.now() - t0 < 4000) { const s = o.openableState('gate'); const q = w.entities.get('gate').quaternion; out.push([Math.round(performance.now() - t0), s?.f ?? null, s?.to ?? null, 2 * Math.acos(Math.min(1, Math.abs(q.w)))]); await new Promise((r) => setTimeout(r, 40)); }
    return out; })(), true)`);
  await key("KeyE");
  check("D2 E opens it through the authority: one use act, openable.open = true", await waitDisk(() => disk().entities[N("gate")]?.c.openable?.open === true && entries().filter((e: any) => e.kind === "act" && e.verb === "use").length === uses0 + 1),
    { open: disk().entities[N("gate")]?.c.openable, refused: await evalJson(`__refused.map((r) => r.text)`) });
  const samp: any[] = await evalJson(`window.__samp`);
  const moving = samp.filter(([, f, to]) => to === 1 && f > 0.05 && f < 0.95);
  const first = samp.find(([, f, to]) => to === 1), last = samp.at(-1);
  const rest = samp.find(([, f, to]) => to === 1 && f === 1);
  const drawnMid = moving.filter(([, , , a]) => a > 0.08 && a < Math.PI / 2 - 0.08).length;
  check("D3 it swings, drawn: part-way for a while (the gate itself drawn between shut and open), then at rest a quarter turn from where it stood",
    moving.length >= 5 && drawnMid >= 3 && rest && first && rest[0] - first[0] >= 600 && last[1] === 1 && Math.abs(last[3] - Math.PI / 2) < 0.02,
    { n: samp.length, moving: moving.length, drawnMid, swingMs: rest && first ? rest[0] - first[0] : null, last, some: moving.slice(0, 4) });
  check("D4 open, the hint says close", await waitFor(`/E\\s*close\\s*“Gate”/.test(${hint})`, 4000), await evalJson(hint));
  await key("KeyE");
  check("D5 E closes it", await waitDisk(() => disk().entities[N("gate")]?.c.openable?.open === false));
  await sleep(1600);
  const q2 = await evalJson(`import('/lib/world.js').then((m) => m.entities.get('gate').quaternion.toArray())`);
  check("D6 …and it's drawn shut again where it stood", Math.abs(Math.abs(q0[0] * q2[0] + q0[1] * q2[1] + q0[2] * q2[2] + q0[3] * q2[3]) - 1) < 1e-4, { q0, q2 });

  });
  // ---- WB: the world's edge (R, 10-10 23:00: walked 44 m out of a ±20 m world; the authority's track of her stayed at
  // the edge, and every put and throw after was "25 m from you") ----
  await stage("WB", async () => {
  const me0 = await page(`const c = await import('/lib/controller.js'); return [c.myState.pos.x, c.myState.pos.z, c.myState.yaw];`);
  const edge = +(me0[0] - 1.2).toFixed(2);   // to my -x: stage D leaves a thing 1.2 m to my +x   // close, so nothing an earlier stage left can stand between me and it
  const b = await page(`const m = await import('/lib/net.js'); return await m.sendRequest('set', { id: '@world', component: 'bounds', value: { min: [${edge}, 0, -60], max: [60, 30, 60] } });`);
  check("(setup) this world's edge 1.2 m to my -x", b?.ok, b);
  await sleep(800);
  await evalJson(`import('/lib/edge.js').then((e) => (e.setWorldEdgeShown(true), true))`);   // off by default (R 10-11 23:04); Viewport ▾ 'world edge' turns it on
  const fenceAll = await evalJson(`import('/lib/edge.js').then((e) => e.worldEdgeShown())`); const fence = fenceAll?.box;
  check("WB0 the edge is drawn: a fence at exactly this world's bounds", Array.isArray(fence) && fence[0]?.[0] === edge && fence[1]?.[0] === 60, fenceAll);
  const r = await page(`const c = await import('/lib/controller.js'), n = await import('/lib/net.js'), t = await import('/lib/thingphysics.js');
    const why = await c.walkTo(${me0[0] - 12}, ${me0[1]}, { ms: 6000 }); await new Promise((z) => setTimeout(z, 800));
    const mk = await n.sendRequest('create', { id: 'wbcrate', model: '${CRATE}', components: { label: 'Edge crate', grabbable: { enabled: true }, physics: { kind: 'dynamic', who: 'visitor' }, transform: { pos: [c.myState.pos.x + 0.6, 0, c.myState.pos.z], scale: 0.25 } } });
    await new Promise((z) => setTimeout(z, 1500)); const g = await t.physicsApi.grab('wbcrate'); await new Promise((z) => setTimeout(z, 800));
    const p = await t.physicsApi.put('wbcrate');
    return { why, x: +c.myState.pos.x.toFixed(3), made: !!mk?.ok, grab: g?.ok ?? g?.refused?.code ?? null, put: p?.ok ? true : (p?.refused?.reason ?? p?.why ?? JSON.stringify(p)?.slice(0, 200) ?? null) };`);
  check("WB1 walking at this world's edge stops me at it (as a wall), so the authority still has me where I am: a grab and a put there work", r && r.x >= edge && r.x < edge + 0.6 && r.grab === true && r.put === true, { edge, ...r });
  await page(`const m = await import('/lib/net.js'); return await m.sendRequest('delete', { id: '@world', component: 'bounds' });`).catch(() => null);
  await page(`const m = await import('/lib/net.js'); return await m.sendRequest('delete', { id: 'wbcrate' });`).catch(() => null);
  await page(`const c = await import('/lib/controller.js'); await c.walkTo(${me0[0]}, ${me0[1]}, { ms: 6000 }); c.myState.yaw = ${me0[2]}; await new Promise((z) => setTimeout(z, 600)); return true;`);   // and face the way I did: later stages place things where I look
  const after = await page(`const n = await import('/lib/net.js'); const c = await import('/lib/controller.js'); return { bounds: n.replica.st?.entities?.['@world']?.c?.bounds ?? null, crate: !!n.replica.st?.entities?.['wbcrate'], back: +Math.hypot(c.myState.pos.x - (${me0[0]}), c.myState.pos.z - (${me0[1]})).toFixed(3), yaw: +c.myState.yaw.toFixed(3) };`);
  check("WB2 (cleanup) the test's edge and crate are gone again", !after.bounds && !after.crate, after);
  const fence2 = await evalJson(`import('/lib/edge.js').then((e) => e.worldEdgeShown())`);
  check("WB2b …and so is the fence", fence2 && fence2.box === null, fence2);
  });
  // ---- F: a refusal, in a person's words ----
  await stage("F", async () => {
  await page(`const m = await import('/lib/net.js'); return await m.sendRequest('create', { id: 'box1', model: '${CRATE}', components: { label: 'Toy box' }, place: { at: [${at[0] + 3}, ${at[1]}] } });`);
  const r0 = await evalJson(`__refused.length`);
  await page(`const e = await import('/lib/editwrites.js'); return (await e.send({ verb: 'set', args: { id: 'box1', component: 'reactions', value: { open: { kind: 'toggle' } } } }, { what: 'change ' + 'box1' })).ok;`);   // the request names the thing by its id, as the editor does
  check("F1 a refusal is shown", await waitFor(`__refused.length > ${r0}`));
  const f = await evalJson(`__refused.at(-1)`);
  check("F2 …in a person's words: what and why, the thing by its label, no refusal code, no tool syntax, no ids", f && /^Couldn't change “Toy box”/.test(f.text) && !/no-target|\{|openable \{/.test(f.text) && !f.text.includes(N("box1")) && /\(no-target\)/.test(f.agentText ?? ""), f);
  check("F3 …the same words on screen (a toast)", await waitFor(`[...document.querySelectorAll('.toast')].some((t) => t.textContent.includes("Couldn't change “Toy box”"))`, 3000));

  });
  // ---- W: a warning, shown ----
  await stage("W", async () => {
  const w0 = await evalJson(`__warned.length`);
  await page(`const e = await import('/lib/editwrites.js'); return (await e.send({ verb: 'create', args: { id: 'cloud', model: '${CRATE}', components: { label: 'Floating crate', transform: { pos: [${at[0] + 5}, 1.5, ${at[1]}], q: [0, 0, 0, 1], scale: [1, 1, 1] } } } }, { what: 'place a crate' })).ok;`);
  check("W1 a write the authority warns about shows the warning, by label", await waitFor(`__warned.length > ${w0} && /“Floating crate” floats/.test(__warned.at(-1).text)`, 5000), await evalJson(`__warned.at(-1) ?? null`));
  check("W2 …on screen, on the one status bar (a warning about my own edit; DESIGN-status-bar.md)", await waitFor(`/Done, but “Floating crate”/.test(document.getElementById('hintbar').textContent) && !document.getElementById('hintbar').classList.contains('gone')`, 3000));

  });
  // ---- V: a moderator's warning in a headset ----
  await stage("V", async () => {
  // the input emulated at its seam: renderer.xr says it's presenting (xrask.js xrActive reads exactly this)
  await page(`const c = await import('/lib/core.js'); Object.defineProperty(c.renderer.xr, 'isPresenting', { get: () => true, configurable: true }); return true;`);
  await page(`const b = await import('/lib/base.js'); b.bus.emit('warned', { by: 'Mod Rowan', reason: 'please keep the music down' }); return true;`);
  check("V1 in a headset, a moderator's warning rides the XR quad (title and reason), with its button", await waitFor(`import('/lib/xrask.js').then((m) => { const s = m.xrAskState(); return !!s && /Mod Rowan warned you/.test(s.title) && /music down/.test(s.body) && s.choices.includes('ok'); })`, 4000),
    await evalJson(`import('/lib/xrask.js').then((m) => m.xrAskState())`));
  check("V2 …and not the DOM card nobody could see", !(await evalJson(`!!document.querySelector('#confirm-center') && getComputedStyle(document.querySelector('#confirm-center')).display !== 'none' && /warned you/.test(document.querySelector('#confirm-center').textContent)`)));
  await page(`const m = await import('/lib/xrask.js'); m.xrAnswer('ok'); const c = await import('/lib/core.js'); delete c.renderer.xr.isPresenting; return true;`);
  check("V3 OK answers it", await evalJson(`import('/lib/xrask.js').then((m) => m.xrAskState() === null)`));
  });

  // ---- VP: a physics act refused in a headset (audit 10-09 blocker 5: thingphysics-refused had no listener, so a refused
  // grab or throw in VR showed nothing at all: you can't tell a bug from a rule) ----
  await stage("VP", async () => {
  const made = await page(`const m = await import('/lib/net.js'); return await m.sendRequest('create', { id: 'anchor', model: '${CRATE}', components: { label: 'Anchor', grabbable: { enabled: false }, transform: { pos: [${at[0]}, 0, ${at[1]} + 1.5] } } });`);
  check("(setup) a crate that can't be picked up, beside me", made?.ok, made);
  await waitFor(`import('/lib/world.js').then((m) => !!m.entities.get('anchor'))`);
  await page(`const c = await import('/lib/core.js'); Object.defineProperty(c.renderer.xr, 'isPresenting', { get: () => true, configurable: true }); return true;`);
  const grab = `const m = await import('/lib/thingphysics.js'); const r = await m.physicsApi.grab('anchor'); return { ok: !!r?.ok, code: r?.refused?.code ?? null };`;
  const n0 = await evalJson(`__phys.length`);
  const g = await page(grab);
  check("(setup) the authority refuses the grab", g && !g.ok && g.code, g);
  check("VP1 in a headset, a refused grab rides the XR quad: 'refused', in the person's words, with OK", await waitFor(`import('/lib/xrask.js').then((m) => { const s = m.xrAskState(); return !!s && /refused/.test(s.title) && /anchor|Anchor/.test(s.body) && s.choices.includes('ok'); })`, 4000),
    await evalJson(`import('/lib/xrask.js').then((m) => m.xrAskState())`));
  await page(grab); await page(grab);
  check("VP2 the same refusal three times running is said once (a squeeze repeated, a retry): one event, one chat line", (await evalJson(`__phys.length`)) - n0 === 1, await evalJson(`__phys.slice(${n0})`));
  check("VP3 …and the card goes by itself (play isn't a dialog): gone within 6 s, nobody pressed OK", await waitFor(`import('/lib/xrask.js').then((m) => m.xrAskState() === null)`, 6500),
    await evalJson(`import('/lib/xrask.js').then((m) => m.xrAskState())`));
  await page(`const c = await import('/lib/core.js'); delete c.renderer.xr.isPresenting; return true;`);
  await sleep(5200);   // past the repeat window: the desk grab below is a fresh refusal
  const g2 = await page(grab);
  check("VP4 on the desk, a refusal raises no headset card (the chat line says it there)", g2 && !g2.ok && (await evalJson(`import('/lib/xrask.js').then((m) => m.xrAskState() === null)`)));
  // VP5 (review round 3): two things whose names differ only by a digit are two refusals, both said
  for (const n of ["Crate 2", "Crate 3"]) await page(`const m = await import('/lib/net.js'); return await m.sendRequest('create', { id: '${n.replace(" ", "-").toLowerCase()}', model: '${CRATE}', components: { label: '${n}', grabbable: { enabled: false }, transform: { pos: [${at[0]} - 2, 0, ${at[1]} + ${n.endsWith("2") ? 3 : 5}] } } });`);
  await waitFor(`import('/lib/world.js').then((m) => !!m.entities.get('crate-2') && !!m.entities.get('crate-3'))`);
  const n5 = await evalJson(`__phys.length`);
  await page(`const m = await import('/lib/thingphysics.js'); await m.physicsApi.grab('crate-2'); await m.physicsApi.grab('crate-3'); return true;`);
  check("VP5 'Crate 2' then 'Crate 3' refused: both said (the repeat check keeps two things two)", (await evalJson(`__phys.length`)) - n5 === 2, await evalJson(`__phys.slice(${n5})`));
  });

  // ---- E: the editor's Openable card and Add Component, as a builder meets them ----
  await stage("E", async () => {
  const insp = `document.querySelector('[data-frame="inspector"]')`;
  await evalJson(`import('/lib/build.js').then((m) => (m.setEditMode(true), true))`);
  await waitFor(`document.body.classList.contains('edit-mode')`);
  await page(`(await import('/lib/scenegraph.js')).sceneSelect('gate'); return true;`);
  await waitFor(`import('/lib/scenegraph.js').then((m) => m.sceneSelected() === 'gate')`);
  // a card is its header row (div.sp-f-group holding the .sp-group button) and the rows after it, up to the next header
  // row (panels.js)
  const card = `(() => { const h = [...${insp}.querySelectorAll('.sp-group')].find((g) => /Openable/.test(g.textContent)); if (!h) return null; const box = document.createElement('div');
    for (let n = h.parentElement.nextElementSibling; n && !n.classList.contains('sp-f-group'); n = n.nextElementSibling) box.append(n.cloneNode(true)); box.__live = h; return box; })()`;
  const cardBtn = (re: string) => `(() => { const h = [...${insp}.querySelectorAll('.sp-group')].find((g) => /Openable/.test(g.textContent));
    for (let n = h?.parentElement.nextElementSibling; n && !n.classList.contains('sp-f-group'); n = n.nextElementSibling) { const b = [...(n.matches('button') ? [n] : []), ...n.querySelectorAll('button')].find((b) => ${re}.test(b.textContent)); if (b) { b.click(); return true; } } return false; })()`;
  check("E1 the Inspector shows an Openable card with its rows (open, door locked, opens by, turns, hinge axis, takes)", await waitFor(`(() => { const c = ${card}; if (!c) return false; const L = [...c.querySelectorAll('.sp-label')].map((l) => l.textContent); return ['open', 'door locked', 'opens by', 'turns', 'hinge axis', 'takes'].every((x) => L.includes(x)); })()`, 6000),
    { rows: await evalJson(`[...(${card}?.querySelectorAll('.sp-label') ?? [])].map((l) => l.textContent)`), groups: await evalJson(`[...(${insp}?.querySelectorAll('.sp-group') ?? [])].map((g) => g.textContent.slice(0, 60))`), sel: await evalJson(`import('/lib/scenegraph.js').then((m) => m.sceneSelected())`) });
  const clicked = await evalJson(cardBtn("/hinge on its right edge/"));
  check("E2 'hinge on its right edge' puts its pivot on the +x edge of its box (one act)", clicked && await waitDisk(() => (disk().entities[N("gate")]?.c.pivot?.pos?.[0] ?? -1) > 0.2), { clicked, pivot: disk().entities[N("gate")]?.c.pivot });
  await page(`(await import('/lib/scenegraph.js')).sceneSelect('box1'); return true;`);
  await waitFor(`import('/lib/scenegraph.js').then((m) => m.sceneSelected() === 'box1')`); await sleep(400);
  await evalJson(`${insp}.querySelector('.sp-pop-btn').click(), true`);
  await waitFor(`!!document.querySelector('.sp-pop-search')`);
  const all = await evalJson(`[...document.querySelectorAll('.sp-pop-item')].map((b) => b.textContent)`);
  await evalJson(`(() => { const i = document.querySelector('.sp-pop-search'); i.value = 'door'; i.dispatchEvent(new Event('input')); return true; })()`);
  const items = await evalJson(`[...document.querySelectorAll('.sp-pop-item')].map((b) => b.textContent)`);
  check("E3 Add Component offers Path and LookAt (what the authority takes: look-at since batch 2), and 'door' finds Openable", all?.some((t: string) => /^Path/.test(t)) && all?.some((t: string) => /^LookAt/.test(t)) && items?.some((t: string) => /Openable/.test(t)), { all, items });
  await evalJson(`[...document.querySelectorAll('.sp-pop-item')].find((b) => /Openable/.test(b.textContent))?.click(), true`);
  check("E4 …adding it writes its state and its open action: the toy box opens with E", await waitDisk(() => disk().entities[N("box1")]?.c.openable?.open === false && disk().entities[N("box1")]?.c.reactions?.open?.kind === "toggle"), { c: disk().entities[N("box1")]?.c });
  await evalJson(`import('/lib/build.js').then((m) => (m.setEditMode(false), true))`);
  });
  // ---- VA: the body's arrival refused (a takeover reconnect: the server still has my body where it was, and the client
  // re-arrives with a plain move from far away). Review of 5a978cc0: the arrival retried at 5 Hz, forever ----
  await stage("VA", async () => {
  const on = await page(`const m = await import('/lib/net.js'); return await m.sendRequest('set', { id: '@world', component: 'physics-engine', value: { engine: 'eidosim@1.0.0' } });`);
  check("(setup) physics on (the body is tracked only in a physics world)", on?.ok, on);
  check("(setup) my body arrives", await waitFor(`import('/lib/thingphysics.js').then((m) => m.physicsApi.body().arrived)`, 10000), await evalJson(`import('/lib/thingphysics.js').then((m) => m.physicsApi.body())`));
  const n0 = await evalJson(`__phys.length`);
  await page(`const c = await import('/lib/controller.js'); c.myState.pos.z += 8; const b = await import('/lib/base.js'); b.bus.emit('cut-adopted'); return true;`);
  await sleep(3000);
  const b = await evalJson(`import('/lib/thingphysics.js').then((m) => m.physicsApi.body())`), said = (await evalJson(`__phys.length`)) - n0;
  check("VA1 re-arriving 8 m from where the server last had me: the body arrives again (a teleport re-arrival), said at most once", b?.arrived && said <= 1, { said, body: b, events: await evalJson(`__phys.slice(${n0}, ${n0} + 3)`) });
  // VA3 (review round 3): a fresh re-arrival (refused too-fast, then a teleport), and a walk straight after: the refusal's
  // back-off (2 s) must not outlive the arrival, so my body follows within 1.2 s
  await page(`const c = await import('/lib/controller.js'); c.myState.pos.z += 8; const b = await import('/lib/base.js'); b.bus.emit('cut-adopted'); return true;`);
  const re = await waitFor(`import('/lib/thingphysics.js').then((m) => m.physicsApi.body().arrived)`, 5000);   // the re-arrival itself may be slow on a busy host (red five times on 10-10, each time under load); what VA3 times is the walk AFTER it
  const t0 = (await evalJson(`import('/lib/thingphysics.js').then((m) => m.physicsApi.body())`))?.trackedAt;
  await page(`const c = await import('/lib/controller.js'); c.myState.pos.x += 3; return true;`);
  const followed = await waitFor(`import('/lib/thingphysics.js').then((m) => { const t = m.physicsApi.body().trackedAt; return !!t && Math.abs(t[0] - ${t0?.[0] ?? 0} - 3) < 0.3; })`, 1200);
  check("VA3 …re-arrived, then walking 3 m at once: the body follows within 1.2 s (no leftover back-off)", re && t0 && followed, { re, t0, now: await evalJson(`import('/lib/thingphysics.js').then((m) => m.physicsApi.body())`) });
  // VA2 (review round 2): an arrival that keeps being refused while the person WALKS (inside a crate: the step and the
  // teleport are both "solid", and the reason names coordinates, so no two texts match): said a couple of times, not 5 a second
  const crate = await evalJson(`import('/lib/world.js').then((m) => { const o = m.entities.get('anchor'); return o ? o.position.toArray() : null; })`);
  const n1 = await evalJson(`__phys.length`);
  await page(`const c = await import('/lib/controller.js'); c.myState.pos.set(${crate?.[0] ?? 0}, 0, ${crate?.[2] ?? 0}); const b = await import('/lib/base.js'); b.bus.emit('cut-adopted'); return true;`);
  for (let i = 0; i < 15; i++) { await page(`const c = await import('/lib/controller.js'); c.myState.pos.x = ${crate?.[0] ?? 0} + ${i % 2 ? 0.35 : -0.35}; return true;`); await sleep(200); }
  const said2 = (await evalJson(`__phys.length`)) - n1, b2 = await evalJson(`import('/lib/thingphysics.js').then((m) => m.physicsApi.body())`);
  check("VA2 an arrival refused again and again while I walk (inside a crate) is said at most twice in 3 s, not 5 a second", crate && !b2?.arrived && said2 <= 2, { crate, said2, lastMove: b2?.lastMove, events: await evalJson(`__phys.slice(${n1}, ${n1} + 4)`) });
  });
  // ---- CU: the mouse on things (R, 10-10: "'grab one' ... left-clicking on them doesn't do anything"). Left-click is a
  // thing's primary use; right-click is the menu of everything it offers; a drag stays the camera's ----
  await stage("CU", async () => {
  // VA2 left me standing inside a crate with my body refused: step well clear and let it arrive
  await page(`const c = await import('/lib/controller.js'); c.myState.pos.x += 6; c.myState.pos.z += 6; const b = await import('/lib/base.js'); b.bus.emit('cut-adopted'); return true;`);
  check("(setup) my body arrives clear of the crate", await waitFor(`import('/lib/thingphysics.js').then((m) => m.physicsApi.body().arrived)`, 8000), await evalJson(`import('/lib/thingphysics.js').then((m) => m.physicsApi.body())`));
  await sleep(800);
  // 1 m ahead of me along the camera's heading, so it is in reach AND in view
  const here = await page(`const c = await import('/lib/controller.js'), k = await import('/lib/core.js'); const d = k.camera.getWorldDirection(new k.THREE.Vector3()); const h = Math.hypot(d.x, d.z) || 1; return [c.myState.pos.x + d.x / h, c.myState.pos.z + d.z / h];`);
  const made = await page(`const m = await import('/lib/net.js'); return await m.sendRequest('create', { id: 'cuball', model: '${CRATE}', components: { label: 'Clicker', grabbable: { enabled: true }, physics: { kind: 'dynamic', who: 'visitor' }, transform: { pos: [${here[0]}, 0, ${here[1]}], scale: 0.3 } } });`);
  check("(setup) a small crate I may pick up, within reach", made?.ok, made);
  await waitFor(`import('/lib/world.js').then((m) => !!m.entities.get('cuball'))`);
  await sleep(600);
  // where it is on screen, and a real press there (down and up on the canvas, no travel)
  const click = (button: number, dx = 0) => page(`const c = await import('/lib/core.js'), w = await import('/lib/world.js'), T = c.THREE;
    const o = w.entities.get('cuball'); o.updateWorldMatrix(true, true); const b = new T.Box3().setFromObject(o), p = b.getCenter(new T.Vector3()).project(c.camera);
    const r = c.canvas.getBoundingClientRect(); let x = r.left + (p.x + 1) / 2 * r.width, y = r.top + (1 - p.y) / 2 * r.height;
    // the bench has other usable things about (a gate): take a pixel near its centre where IT is what the pointer is on
    const cu = await import('/lib/clickuse.js'); let found = cu.thingAt(x, y) === 'cuball';
    for (let k = 1; k <= 12 && !found; k++) for (const [ax, ay] of [[0, -1], [0, 1], [-1, 0], [1, 0]]) { const xx = x + ax * k * 6, yy = y + ay * k * 6; if (cu.thingAt(xx, yy) === 'cuball') { x = xx; y = yy; found = true; break; } }
    const ev = (t, xx) => new MouseEvent(t, { bubbles: true, cancelable: true, button: ${button}, buttons: 0, clientX: xx, clientY: y });
    c.canvas.dispatchEvent(ev('mousedown', x)); c.canvas.dispatchEvent(ev('mouseup', x + ${dx}));
    return { x, y, onScreen: found };`);
  const holds = () => evalJson(`import('/lib/thingphysics.js').then((m) => m.physicsApi.mine())`);
  const at0 = await click(0, 60);
  await sleep(700);
  check("CU1 a press that travels 60 px is a drag (the camera's), not a click: nothing is picked up", at0?.onScreen && !(await holds())?.includes(N("cuball")), { at0, holds: await holds() });
  await click(2);
  const menu = await waitFor(`!!document.querySelector('.sp-ctx')`, 2000), items = await evalJson(`[...document.querySelectorAll('.sp-ctx-item')].map((b) => b.textContent)`);
  check("CU2 right-click on it opens its menu: pick up first, punt among the rest", menu && /^pick up/.test(items?.[0] ?? "") && items?.some((t: string) => /^punt/.test(t)), items);
  await evalJson(`(document.querySelector('.sp-ctx-item')?.click(), true)`);
  check("CU3 …and choosing 'pick up' there picks it up", await waitFor(`import('/lib/thingphysics.js').then((m) => m.physicsApi.mine().includes('cuball'))`, 4000), { holds: await holds(), said: await evalJson(`__phys.slice(-2)`) });
  await page(`const m = await import('/lib/thingphysics.js'); await m.physicsApi.put('cuball'); return true;`);
  await waitFor(`import('/lib/thingphysics.js').then((m) => !m.physicsApi.mine().includes('cuball'))`, 4000);
  await sleep(1200);
  await click(0);
  check("CU4 left-click on it is its primary use: I hold it", await waitFor(`import('/lib/thingphysics.js').then((m) => m.physicsApi.mine().includes('cuball'))`, 4000), await holds());
  // letting go (R, holding the wrecking ball: "left-click doesn't drop it and there's no help option to assist me")
  await sleep(800);
  const hint = await waitFor(`/holding/.test(document.getElementById('hintbar').textContent) && /set it down/.test(document.getElementById('hintbar').textContent)`, 3000);
  check("CU5 while I hold it the hint bar says so, and how to let go", hint, await evalJson(`document.getElementById('hintbar').textContent`));
  // a click on a bare spot of floor within reach (in third person my own body hides what I hold): it is set down there
  const bare = await page(`const c = await import('/lib/core.js'), cu = await import('/lib/clickuse.js'), k = await import('/lib/controller.js'); const r = c.canvas.getBoundingClientRect(), me = k.myState.pos; let at = null, spot = null;
    for (let gy = 1; gy < 24 && !at; gy++) for (let gx = 1; gx < 32 && !at; gx++) { const x = r.left + r.width * gx / 32, y = r.top + r.height * gy / 24; if (cu.thingAt(x, y) !== null) continue; const a = cu.clickUseApi.aimPoint(x, y); if (a && Math.abs(a[1] - me.y) < 0.05 && Math.hypot(a[0] - me.x, a[2] - me.z) < 0.85 && Math.hypot(a[0] - me.x, a[2] - me.z) > 0.5) { at = [x, y]; spot = a; } }
    if (!at) return null;
    const ev = (t) => new MouseEvent(t, { bubbles: true, cancelable: true, button: 0, clientX: at[0], clientY: at[1] });
    c.canvas.dispatchEvent(ev('mousedown')); c.canvas.dispatchEvent(ev('mouseup')); return { at, spot };`);
  const put6 = bare && await waitFor(`import('/lib/thingphysics.js').then((m) => !m.physicsApi.mine().includes('cuball'))`, 4000); await sleep(1200);
  const at6 = await page(`const w = await import('/lib/world.js'); const o = w.entities.get('cuball'); o.updateWorldMatrix(true, false); return o.getWorldPosition(new (await import('/lib/core.js')).THREE.Vector3()).toArray();`);
  check("CU6 holding it, a left-click on a bare spot within reach sets it down at that spot", put6 && Math.hypot(at6[0] - bare.spot[0], at6[2] - bare.spot[2]) < 0.3, { bare, at6, holds: await holds() });
  await sleep(1500);
  await click(0);
  await waitFor(`import('/lib/thingphysics.js').then((m) => m.physicsApi.mine().includes('cuball'))`, 4000); await sleep(800);
  await click(0);
  check("CU7 …and so does a left-click on the thing itself", await waitFor(`import('/lib/thingphysics.js').then((m) => !m.physicsApi.mine().includes('cuball'))`, 4000), await holds());
  });
  // ---- FL: flights are drawn on the page's OWN frames (R, 10-10: "object location updates every few seconds", a domino
  // "stuck in this tilted position"). Every other check hands the applier a wall clock; this one doesn't, on purpose. ----
  await stage("FL", async () => {
  await page(`const t = await import('/lib/thingphysics.js'); if (t.physicsApi.mine().length) await t.physicsApi.put(); return true;`); await sleep(1200);
  // look every 50 ms for a second, in the page (a round trip per look is slower than the flight)
  const seen = await page(`const t = await import('/lib/thingphysics.js'), w = await import('/lib/world.js'), T = (await import('/lib/core.js')).THREE; const o = w.entities.get('cuball'), v = new T.Vector3(), out = [];
    const r = await t.physicsApi.punt('cuball 6');
    for (let i = 0; i < 20; i++) { o.updateWorldMatrix(true, false); o.getWorldPosition(v); out.push({ tick: t.simShown()?.tick ?? null, p: [+v.x.toFixed(2), +v.y.toFixed(2), +v.z.toFixed(2)].join() }); await new Promise((z) => setTimeout(z, 50)); }
    return { ok: !!r?.ok, code: r?.refused?.code ?? null, out };`);
  const ticks = (seen?.out?.at(-1)?.tick ?? 0) - (seen?.out?.[0]?.tick ?? 0), places = new Set(seen?.out?.map((x: any) => x.p)).size;
  check("FL1 a punted thing moves on every frame: the displayed sim's clock runs (about 30 ticks a second) and it is seen in many places on the way", seen?.ok && ticks >= 20 && places >= 6, { ok: seen?.ok, code: seen?.code, ticks, places, path: seen?.out?.map((x: any) => x.p).filter((p: string, i: number, a: string[]) => p !== a[i - 1]).slice(0, 8) });
  await sleep(2500);
  });
  // ---- HP: holding and putting down something big whose origin is its centre (R's gym, 10-10: the wrecking ball
  // was held around her body, sat half in the floor when put down, and putting it down shoved her and the camera) ----
  await stage("HP", async () => {
  const here = await page(`const c = await import('/lib/controller.js'); return [c.myState.pos.x, c.myState.pos.z, c.myState.yaw];`);
  const made = await page(`const m = await import('/lib/net.js'); return await m.sendRequest('create', { id: 'hpball', model: 'props/ball.glb', components: { label: 'Big ball', grabbable: {}, physics: { kind: 'dynamic' }, collider: { shape: 'sphere' }, transform: { pos: [${here[0]} + Math.sin(${here[2]}) * 1.0, 0.35, ${here[1]} + Math.cos(${here[2]}) * 1.0] } } });`);
  check("(setup) a 0.7 m ball in front of me (its origin is its centre)", made?.ok, made);
  await waitFor(`import('/lib/world.js').then((m) => !!m.entities.get('hpball'))`); await sleep(1200);   // loaded, not just reserved (a model's slot is null until its GLB lands)
  const r = await page(`const t = await import('/lib/thingphysics.js'), c = await import('/lib/controller.js'), w = await import('/lib/world.js'), T = (await import('/lib/core.js')).THREE; const o = w.entities.get('hpball'), v = new T.Vector3();
    const where = () => { o.updateWorldMatrix(true, false); o.getWorldPosition(v); const me = c.myState.pos; return { flat: +Math.hypot(v.x - me.x, v.z - me.z).toFixed(3), y: +v.y.toFixed(3), me: [+me.x.toFixed(3), +me.z.toFixed(3)] }; };
    const g = await t.physicsApi.grab('hpball'); await new Promise((z) => setTimeout(z, 1500)); const held = where();
    const p = await t.physicsApi.put('hpball'); await new Promise((z) => setTimeout(z, 1500)); const down = where();
    return { grab: !!g?.ok, put: !!p?.ok, code: p?.refused?.code ?? null, held, down, shoved: +Math.hypot(down.me[0] - held.me[0], down.me[1] - held.me[1]).toFixed(3) };`);
  check("HP1 held in both arms it sits against my body, not around it (its near side at least 5 cm out from my centre line)", r?.grab && r.held.flat - 0.35 >= 0.05, r);
  check("HP2 put down, it rests ON the floor (its centre one radius up), in front of me and clear of my body", r?.put && Math.abs(r.down.y - 0.35) < 0.03 && r.down.flat >= 0.35 + 0.32, r);
  check("HP3 …and putting it down does not shove me (the camera rides my body)", r?.put && r.shoved < 0.15, { shoved: r?.shoved });
  });
  // ---- HT: a held thing turns with me (R, 10-10 evening: "they don't rotate with the avatar, they're always oriented the same direction") ----
  await stage("HT", async () => {
  const here = await page(`const c = await import('/lib/controller.js'), k = await import('/lib/core.js'); const d = k.camera.getWorldDirection(new k.THREE.Vector3()); const h = Math.hypot(d.x, d.z) || 1; return [c.myState.pos.x + d.x / h * 0.7, c.myState.pos.z + d.z / h * 0.7];`);
  const htMade = await page(`const m = await import('/lib/net.js'); return await m.sendRequest('create', { id: 'htcrate', model: '${CRATE}', components: { label: 'Turn crate', grabbable: { enabled: true }, physics: { kind: 'dynamic', who: 'visitor' }, transform: { pos: [${here[0]}, 0, ${here[1]}], scale: 0.25 } } });`);
  check("(setup) a crate 0.7 m in front of me", htMade?.ok, htMade);
  await waitFor(`import('/lib/world.js').then((m) => !!m.entities.get('htcrate'))`); await sleep(1200);
  const r = await page(`const t = await import('/lib/thingphysics.js'), c = await import('/lib/controller.js'), w = await import('/lib/world.js'), T = (await import('/lib/core.js')).THREE;
    const yawOf = (o) => { o.updateWorldMatrix(true, false); const f = new T.Vector3(0, 0, 1).applyQuaternion(o.getWorldQuaternion(new T.Quaternion())); return Math.atan2(f.x, f.z); };
    const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a)); const o = w.entities.get('htcrate'), me = t.myAvatar?.()?.root ?? null; if (!o) return { noCrate: true, has: w.entities.has('htcrate') };
    const g = await t.physicsApi.grab('htcrate'); await new Promise((z) => setTimeout(z, 1200));
    const c0 = yawOf(o), b0 = me ? yawOf(me) : null; c.myState.yaw += Math.PI / 2; await new Promise((z) => setTimeout(z, 1200));
    const c1 = yawOf(o), b1 = me ? yawOf(me) : null; await t.physicsApi.put('htcrate');
    return { grab: !!g?.ok, why: g?.refused ?? g?.why ?? null, body: b0 == null ? null : +wrap(b1 - b0).toFixed(3), crate: +wrap(c1 - c0).toFixed(3) };`);
  check("HT1 holding a crate, I turn a quarter: it turns the same quarter with me (within 0.1 rad)", r?.grab && r.body != null && Math.abs(r.body) > 1.2 && Math.abs(wrap(r.crate - r.body)) < 0.1, r);
  });
  // ---- HD: 'hidden for all' from the Attributes tab (R, 10-10 23:48: "VERY slow at updating ... the sign visible but the
  // checkbox still registering 'hidden'") ----
  await stage("HD", async () => {
  const me = await evalJson(`import('/lib/controller.js').then((c) => [c.myState.pos.x, c.myState.pos.z])`);
  await page(`const m = await import('/lib/net.js'); return await m.sendRequest('create', { id: 'hdsign', components: { label: 'Hide sign', transform: { pos: [${me[0]} + 2, 1.2, ${me[1]} + 2] }, text: { text: 'HIDE ME', size: 0.2, width: 2 } } });`);
  await waitFor(`import('/lib/world.js').then((m) => !!m.entities.get('hdsign'))`); await sleep(800);
  const r = await page(`const b = await import('/lib/build.js'), sg = await import('/lib/scenegraph.js'), base = await import('/lib/base.js'), w = await import('/lib/world.js');
    b.setEditMode(true); await new Promise((z) => setTimeout(z, 500)); sg.sceneSelect('hdsign'); await new Promise((z) => setTimeout(z, 700));
    base.bus.emit('edit-righttab', 'attributes'); await new Promise((z) => setTimeout(z, 600));
    const box = () => { const at = document.querySelector('[data-frame="attributes"]'); const row = [...at.querySelectorAll('.sp-row')].find((r) => /hidden for all/.test(r.textContent)); return row?.querySelector('input[type=checkbox]'); };
    const sample = async (ms) => { const out = []; for (let t = 0; t <= ms; t += 100) { const o = w.entities.get('hdsign'); out.push([t, !!box()?.checked, !!o?.visible, w.bagOf('hdsign')?.hidden === true]); await new Promise((z) => setTimeout(z, 100)); } return out; };
    // HD2: in a busy world every frame repaints (each physics rest is a 'comp'); repaint before the authority has answered
    const early = []; box()?.click(); for (let i = 0; i < 6; i++) { base.bus.emit('comp', { id: 'some-other-thing', type: 'transform' }); await new Promise((z) => requestAnimationFrame(z)); early.push(!!box()?.checked); }
    await sample(1500); box()?.click(); await sample(1500);
    box()?.click(); const on = await sample(2500); box()?.click(); const off = await sample(2500);
    base.bus.emit('edit-righttab', 'inspector'); b.setEditMode(false);
    const first = (xs, f) => (xs.find(f) ?? [null])[0];
    return { early, onChecked: first(on, (x) => x[1]), onHiddenRec: first(on, (x) => x[3]), onInvisible: first(on, (x) => !x[2]), offUnchecked: first(off, (x) => !x[1]), offRec: first(off, (x) => !x[3]), offVisible: first(off, (x) => x[2]), tail: [on.at(-1), off.at(-1)] };`);
  check("HD1 ticking 'hidden for all' hides the sign and the box shows it within half a second; unticking brings both back as fast", r && r.onInvisible != null && r.onInvisible <= 500 && r.onChecked != null && r.onChecked <= 500 && r.offVisible != null && r.offVisible <= 500 && r.offUnchecked != null && r.offUnchecked <= 500, r);
  check("HD2 …and in a busy world (a repaint every frame before the authority answers) the box keeps showing what I clicked", r?.early?.length === 6 && r.early.every(Boolean), r?.early);
  await page(`const m = await import('/lib/net.js'); return await m.sendRequest('delete', { id: 'hdsign' });`).catch(() => null);
  });
  // ---- SB: Shift in the viewport (R, 10-11 00:18: "Can shift-select allow me to select multiple objects in the viewport,
  // and shift-select-drag draw a bounding box around objects to select them?") ----
  await stage("SB", async () => {
  const at = await page(`const c = await import('/lib/core.js'), co = await import('/lib/controller.js'); const d = c.camera.getWorldDirection(new c.THREE.Vector3()); const h = Math.hypot(d.x, d.z) || 1;
    const f = [d.x / h, d.z / h], r = [-d.z / h, d.x / h], p = co.myState.pos; return { a: [p.x + f[0] * 4 - r[0] * 0.8, p.z + f[1] * 4 - r[1] * 0.8], b: [p.x + f[0] * 4 + r[0] * 0.8, p.z + f[1] * 4 + r[1] * 0.8] };`);
  for (const [id, xz] of [["sba", at.a], ["sbb", at.b]]) await page(`const m = await import('/lib/net.js'); return await m.sendRequest('create', { id: '${id}', model: '${CRATE}', components: { label: '${id}', transform: { pos: [${xz[0]}, 0, ${xz[1]}], scale: 0.25 } } });`);
  await waitFor(`import('/lib/world.js').then((m) => !!m.entities.get('sba') && !!m.entities.get('sbb'))`); await sleep(1000);
  await page(`(await import('/lib/build.js')).setEditMode(true); return true;`); await sleep(1500);
  const scr = (id) => page(`const c = await import('/lib/core.js'), w = await import('/lib/world.js'), T = c.THREE; const o = w.entities.get('${id}'); o.updateWorldMatrix(true, true);
    const p = new T.Box3().setFromObject(o).getCenter(new T.Vector3()).project(c.camera); const r = c.canvas.getBoundingClientRect(); return [r.left + (p.x + 1) / 2 * r.width, r.top + (1 - p.y) / 2 * r.height];`);
  const A = await scr("sba"), B = await scr("sbb");
  const m = (type, x, y, mods = 0) => cdp.send("Input.dispatchMouseEvent", { type, x: Math.round(x), y: Math.round(y), button: "left", buttons: type === "mouseReleased" ? 0 : 1, clickCount: 1, modifiers: mods });
  const sel = () => page(`const sg = await import('/lib/scenegraph.js'); return [...document.querySelectorAll('[data-frame="hierarchy"] .sp-item.active, [data-frame="hierarchy"] .sp-item.multi')].map((x) => x.closest('[data-id]')?.dataset.id).filter((x) => x === 'sba' || x === 'sbb').sort();`);
  await m("mousePressed", A[0], A[1]); await m("mouseReleased", A[0], A[1]); await sleep(400);
  await m("mousePressed", B[0], B[1], 8); await m("mouseReleased", B[0], B[1], 8); await sleep(600);
  const s1 = await sel();
  await page(`(await import('/lib/base.js')).bus.emit('key', new KeyboardEvent('keydown', { code: 'Escape' })); return true;`); await sleep(400);
  const x0 = Math.min(A[0], B[0]) - 60, x1 = Math.max(A[0], B[0]) + 60, y0 = Math.min(A[1], B[1]) - 60, y1 = Math.max(A[1], B[1]) + 60;
  // start the box on a pixel with nothing under it (other stages leave things about): each corner, pushed out until bare
  const start = await page(`const cu = await import('/lib/clickuse.js'); for (let k = 0; k < 8; k++) for (const [x, y] of [[${x0} - k * 30, ${y0} - k * 30], [${x1} + k * 30, ${y1} + k * 30], [${x0} - k * 30, ${y1} + k * 30], [${x1} + k * 30, ${y0} - k * 30]]) if (!cu.thingAt(x, y)) return [x, y]; return null;`);
  const sx = start?.[0] ?? x0, sy = start?.[1] ?? y0, ex = sx <= x0 ? x1 : x0, ey = sy <= y0 ? y1 : y0;
  await m("mousePressed", sx, sy, 8); for (let k = 1; k <= 6; k++) await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: Math.round(sx + (ex - sx) * k / 6), y: Math.round(sy + (ey - sy) * k / 6), button: "left", buttons: 1, modifiers: 8 });
  await m("mouseReleased", ex, ey, 8); await sleep(600);
  const s2 = await sel();
  check("SB1 Shift-click in the viewport adds a second thing to the selection", JSON.stringify([...(s1 ?? [])].sort()) === JSON.stringify([N("sba"), N("sbb")].sort()), { A, B, s1 });
  check("SB2 Shift-drag on bare space draws a box, and both things inside it are selected", JSON.stringify([...(s2 ?? [])].sort()) === JSON.stringify([N("sba"), N("sbb")].sort()), { box: [sx, sy, ex, ey], start, s2 });
  await page(`(await import('/lib/build.js')).setEditMode(false); const m = await import('/lib/net.js'); await m.sendRequest('delete', { id: 'sba' }); await m.sendRequest('delete', { id: 'sbb' }); return true;`).catch(() => null);
  });
  // ---- SL: selection layers (R, 10-11: "selection layers so people don't select the ground plane all the time") ----
  await stage("SL", async () => {
  await page(`(await import('/lib/build.js')).setEditMode(true); return true;`); await sleep(4000);   // the edit camera first (it eases in): placed and projected from it
  const at = await page(`const c = await import('/lib/core.js'), co = await import('/lib/controller.js'); const d = c.camera.getWorldDirection(new c.THREE.Vector3()); const h = Math.hypot(d.x, d.z) || 1;
    const f = [d.x / h, d.z / h], r = [-d.z / h, d.x / h], p = co.myState.pos; return { me: [p.x, p.z], crate: [p.x + f[0] * 4, p.z + f[1] * 4], floorPt: [p.x + f[0] * 4 + r[0] * 2, p.z + f[1] * 4 + r[1] * 2] };`);
  await page(`const m = await import('/lib/net.js'); await m.sendRequest('create', { id: 'slfloor', model: '${CRATE}', components: { label: 'Floor slab', 'hesperus/layer': 'environment', transform: { pos: [${at.floorPt[0]}, -0.09, ${at.floorPt[1]}], scale: [1.2, 0.05, 1.2] } } });   // a 35 m slab lost the bench's GPU context; size defaults are layers-test's
    return await m.sendRequest('create', { id: 'slcrate', model: '${CRATE}', components: { label: 'Layer crate', transform: { pos: [${at.crate[0]}, 0, ${at.crate[1]}], scale: 0.25 } } });`);
  await waitFor(`import('/lib/world.js').then((m) => !!m.entities.get('slfloor') && !!m.entities.get('slcrate'))`); await sleep(1000);
  await page(`(await import('/lib/build.js')).setEditMode(true); return true;`); await sleep(1500);   // as SB: placed from the play camera, then edit mode
  // find, on screen, a pixel whose NEAREST thing is the crate and one whose nearest is the floor (whatever the camera does)
  const find = (id) => page(`const c = await import('/lib/core.js'), w = await import('/lib/world.js'), T = c.THREE; const rc = new T.Raycaster(), r = c.canvas.getBoundingClientRect();
    const objs = [...w.entities.values()].filter(Boolean); const want = w.entities.get('${id}');
    for (let gy = 0.15; gy < 0.95; gy += 0.025) for (let gx = 0.1; gx < 0.9; gx += 0.025) { rc.setFromCamera(new T.Vector2(gx * 2 - 1, -(gy * 2 - 1)), c.camera);
      const h = rc.intersectObjects(objs, true)[0]; if (!h) continue; let o = h.object; while (o && !o.userData.entityId) o = o.parent; if (o === want) return [r.left + gx * r.width, r.top + gy * r.height]; }
    return null;`);
  const cratePx = await find("slcrate"), floorPx = await find("slfloor");
  if (!cratePx || !floorPx) { const sh = await cdp.send("Page.captureScreenshot", { format: "png" }); const shot = path.join(process.env.PROBE_SHOTS ?? SCRATCH, "sl.png"); fs.writeFileSync(shot, Buffer.from(sh.data, "base64")); console.log(`(screenshot: ${shot})`); }
  check("(setup) both the crate and the floor are on screen", !!cratePx && !!floorPx, { cratePx, floorPx });
  if (!cratePx || !floorPx) return;
  const m = (type, x, y) => cdp.send("Input.dispatchMouseEvent", { type, x: Math.round(x), y: Math.round(y), button: "left", buttons: type === "mouseReleased" ? 0 : 1, clickCount: 1 });
  const clickAt = async (p) => { await m("mousePressed", p[0], p[1]); await m("mouseReleased", p[0], p[1]); await sleep(500); return evalJson(`import('/lib/scenegraph.js').then((s) => s.sceneSelected())`); };
  // Esc only when something is selected: Esc with nothing selected leaves edit mode (and the next click would be ignored)
  const esc = () => page(`if ((await import('/lib/scenegraph.js')).sceneSelected()) (await import('/lib/base.js')).bus.emit('key', new KeyboardEvent('keydown', { code: 'Escape' })); return true;`);
  const a = await clickAt(floorPx); await esc(); await sleep(300);
  const b = await clickAt(cratePx); await esc(); await sleep(300);
  await page(`(await import('/lib/selectmask.js')).setLayerOn('environment', true); return true;`);
  const c2 = await clickAt(floorPx); await esc();
  await page(`(await import('/lib/selectmask.js')).setLayerOn('environment', false); (await import('/lib/build.js')).setEditMode(false); const n = await import('/lib/net.js'); await n.sendRequest('delete', { id: 'slfloor' }); await n.sendRequest('delete', { id: 'slcrate' }); return true;`).catch(() => null);
  check("SL1 a floor slab on 'environment' is off for clicks at first: clicking it selects nothing; the crate on it still selects", a !== N("slfloor") && b === N("slcrate"), { a, b, floorPx, cratePx });
  check("SL2 Select ▸ environment on: the floor is clickable again", c2 === N("slfloor"), { c2 });
  });
  // ---- SY: one selection (R, 10-11 01:13 "agree with each other in the hierarchy and the viewport"; 00:57 "after undoing a
  // few times ... can't unselect them by clicking away"; 00:41 "the bounding box on moving objects update as they translate") ----
  await stage("SY", async () => {
  const at = await page(`const c = await import('/lib/core.js'), co = await import('/lib/controller.js'); const d = c.camera.getWorldDirection(new c.THREE.Vector3()); const h = Math.hypot(d.x, d.z) || 1; const p = co.myState.pos; return [p.x + d.x / h * 4, p.z + d.z / h * 4];`);
  await page(`const m = await import('/lib/net.js'); await m.sendRequest('create', { id: 'syorb', model: '${CRATE}', components: { label: 'Orbiter', transform: { pos: [${at[0]}, 0, ${at[1]}], scale: 0.2 } } });
    await m.sendRequest('set', { id: 'syorb', component: 'motion', value: { type: 'orbit', radius: 1.2, degPerSec: 120, center: [${at[0]}, 0, ${at[1]}] } });
    return await m.sendRequest('create', { id: 'syb', model: '${CRATE}', components: { label: 'Still box', transform: { pos: [${at[0]} + 2, 0, ${at[1]}], scale: 0.25 } } });`);
  await waitFor(`import('/lib/world.js').then((m) => !!m.entities.get('syorb') && !!m.entities.get('syb'))`); await sleep(1000);
  const r = await page(`const b = await import('/lib/build.js'), sg = await import('/lib/scenegraph.js'), w = await import('/lib/world.js'), T = (await import('/lib/core.js')).THREE, n = await import('/lib/net.js');
    const wait = (ms) => new Promise((z) => setTimeout(z, ms));
    b.setEditMode(true); await wait(800);
    // SY1: picked in the TREE (no viewport click): the viewport outlines it
    sg.sceneSelect('syb'); await wait(300); const v1 = b.selectionView(); const cb = new T.Box3().setFromObject(w.entities.get('syb')).getCenter(new T.Vector3());
    const inBox = (v, p) => p.x >= v.min[0] - 0.01 && p.x <= v.max[0] + 0.01 && p.z >= v.min[2] - 0.01 && p.z <= v.max[2] + 0.01;
    // SY3: an orbiting thing: its box follows it
    sg.sceneSelect('syorb'); const follow = []; for (let i = 0; i < 6; i++) { await wait(200); const v = b.selectionView(); const c = new T.Box3().setFromObject(w.entities.get('syorb')).getCenter(new T.Vector3()); follow.push(inBox(v, c) && v.visible); }
    // SY2: an edit, an undo, then a click on empty space deselects everywhere
    sg.sceneSelect('syb'); await wait(200); await n.sendRequest('set', { id: 'syb', component: 'transform', value: { pos: [${at[0]} + 2.3, 0, ${at[1]}], q: [0, 0, 0, 1], scale: [0.25, 0.25, 0.25] } }); await wait(400);
    await b.undo(); await wait(600);
    return { v1, syb: [cb.x, cb.z], sy1: v1.id === 'syb' && v1.visible && inBox(v1, cb), follow, afterUndo: { scene: sg.sceneSelected(), view: b.selectionView().id } };`);
  // a real click on empty sky for SY2
  const bare = await page(`const c = await import('/lib/core.js'), w = await import('/lib/world.js'), T = c.THREE; const r = c.canvas.getBoundingClientRect(), rc = new T.Raycaster(), objs = [...w.entities.values()].filter(Boolean); for (let y = r.top + 60; y < r.bottom - 60; y += 20) for (let x = r.left + 360; x < r.right - 360; x += 30) { if (document.elementFromPoint(x, y) !== c.canvas) continue; rc.setFromCamera(new T.Vector2((x / innerWidth) * 2 - 1, -(y / innerHeight) * 2 + 1), c.camera); if (!rc.intersectObjects(objs, true).length) return [x, y]; } return null;`);   // nothing at all under it (as the viewport's own pick sees things), on the canvas itself   // the canvas itself, not a panel over it
  await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: Math.round(bare[0]), y: Math.round(bare[1]), button: "left", buttons: 1, clickCount: 1 });
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: Math.round(bare[0]), y: Math.round(bare[1]), button: "left", buttons: 0, clickCount: 1 }); await sleep(500);
  const after = await page(`const b = await import('/lib/build.js'), sg = await import('/lib/scenegraph.js'); const o = { scene: sg.sceneSelected(), view: b.selectionView() }; b.setEditMode(false); const n = await import('/lib/net.js'); await n.sendRequest('delete', { id: 'syorb' }); await n.sendRequest('delete', { id: 'syb' }); return o;`);
  check("SY1 picked in the Hierarchy, the viewport outlines the same thing", r?.sy1, r?.v1);
  check("SY2 after an edit and an undo, a click on empty space deselects it in the Hierarchy AND the viewport", r?.afterUndo?.scene === N("syb") && after.scene == null && !after.view.visible, { afterUndo: r?.afterUndo, after });
  check("SY3 the selection box follows a moving (orbiting) thing", r?.follow?.length === 6 && r.follow.every(Boolean), r?.follow);
  });
  // ---- ST: X sits only where I could climb (R, 10-11 00:47: "trying to sit with 'x' near the crates results in me levitating
  // 5m in the air": a seat she had put on a sign 3 m up counted as near) ----
  await stage("ST", async () => {
  const me = await evalJson(`import('/lib/controller.js').then((c) => [c.myState.pos.x, c.myState.pos.z])`);
  await page(`const m = await import('/lib/net.js');
    await m.sendRequest('create', { id: 'sthigh', components: { label: 'High sign', transform: { pos: [${me[0]} + 0.8, 3, ${me[1]}] }, text: { text: 'UP HERE', size: 0.2 }, sockets: { seat: { pos: [0, 0, 0], body: {} } } } });
    return await m.sendRequest('create', { id: 'stlow', model: '${CRATE}', components: { label: 'Low seat', transform: { pos: [${me[0]} - 2.2, 0, ${me[1]}], scale: 0.2 }, sockets: { seat: { pos: [0, 2.2, 0], body: {} } } } });`);
  await waitFor(`import('/lib/world.js').then((m) => !!m.entities.get('sthigh') && !!m.entities.get('stlow'))`); await sleep(1200);
  const r = await page(`const lb = await import('/lib/localbody.js'), w = await import('/lib/world.js'); const did = lb.trySitOn(); await new Promise((z) => setTimeout(z, 1500));
    const on = w.avatarMounts?.get?.((await import('/lib/base.js')).CONFIG.name) ?? null;
    const host = on ? (w.parentIdOf?.(on.to) ?? on.to) : null;   // sockets are child entities (10-14): the mount names the seat, the seat's parent is the thing
    return { did, on: host };`);
  await page(`const lb = await import('/lib/localbody.js'); lb.standUp?.(); (await import('/lib/base.js')).bus.emit('key', new KeyboardEvent('keydown', { code: 'KeyX' })); return true;`).catch(() => null); await sleep(800);
  await page(`const m = await import('/lib/net.js'); await m.sendRequest('delete', { id: 'sthigh' }); await m.sendRequest('delete', { id: 'stlow' }); return true;`).catch(() => null);
  check("ST1 X with a seat 3 m up beside me and one at the ground 2.2 m away: I sit on the one I could climb onto", r?.on === N("stlow"), r);
  });
  // ---- NL: the Inspector's name line (R, 10-10 23:48: "make the 'name' attribute be like Maya ... The eye and lock and
  // disable icons can be on this line to the right") ----
  await stage("NL", async () => {
  const me = await evalJson(`import('/lib/controller.js').then((c) => [c.myState.pos.x, c.myState.pos.z])`);
  await page(`const m = await import('/lib/net.js'); return await m.sendRequest('create', { id: 'nlbox', model: '${CRATE}', components: { label: 'Name box', transform: { pos: [${me[0]} + 2.5, 0, ${me[1]} - 2], scale: 0.3 } } });`);
  await waitFor(`import('/lib/world.js').then((m) => !!m.entities.get('nlbox'))`); await sleep(600);
  await page(`(await import('/lib/build.js')).setEditMode(true); await new Promise((z) => setTimeout(z, 500)); (await import('/lib/scenegraph.js')).sceneSelect('nlbox'); return true;`);
  const insp = `document.querySelector('[data-frame="inspector"]')`;
  await waitFor(`${insp}.querySelector('.sp-row.sp-title input')?.value === 'Name box'`);
  const lockBtn = `[...${insp}.querySelectorAll('.sp-iconbtn button')].find((b) => /Lock it|Locked/.test(b.title))`;
  const before = await evalJson(`(() => { const line = ${insp}.querySelector('.sp-row.sp-title'), lb = ${lockBtn}, eb = [...${insp}.querySelectorAll('.sp-iconbtn button')].find((b) => /YOUR view/.test(b.title));
    return { title: line?.querySelector('input')?.value ?? null, sameLine: !!line && !!lb && !!eb && Math.abs(line.getBoundingClientRect().top - lb.getBoundingClientRect().top) < 8 && Math.abs(eb.getBoundingClientRect().top - lb.getBoundingClientRect().top) < 4, svg: lb?.querySelector('svg')?.innerHTML ?? null }; })()`);
  await evalJson(`(${lockBtn}?.click(), true)`);
  const locked = await waitFor(`import('/lib/world.js').then((m) => !!m.bagOf('nlbox')?.lock)`);
  await sleep(400); const svg1 = await evalJson(`${lockBtn}?.querySelector('svg')?.innerHTML ?? null`);
  await evalJson(`(${lockBtn}?.click(), true)`); await waitFor(`import('/lib/world.js').then((m) => !m.bagOf('nlbox')?.lock)`);
  await page(`(await import('/lib/build.js')).setEditMode(false); const n = await import('/lib/net.js'); await n.sendRequest('delete', { id: 'nlbox' }); return true;`).catch(() => null);
  check("NL1 the Inspector's first line is the name as a title, with the eye and the padlock on it; the padlock locks it, and its icon changes", before.title === "Name box" && before.sameLine && locked && !!svg1 && svg1 !== before.svg, { before: { ...before, svg: !!before.svg }, locked, iconChanged: !!svg1 && svg1 !== before.svg });
  });
  // ---- HY: History says what changed (R, 10-10 23:55: "Is there a reason the history isn't more explicit here?") ----
  await stage("HY", async () => {
  const me = await evalJson(`import('/lib/controller.js').then((c) => [c.myState.pos.x, c.myState.pos.z])`);
  await page(`const m = await import('/lib/net.js'); await m.sendRequest('create', { id: 'hysign', components: { label: 'History sign', transform: { pos: [${me[0]} + 2, 1.2, ${me[1]} + 2] }, text: { text: 'HI', size: 0.2, width: 5.076 } } });
    await new Promise((z) => setTimeout(z, 1600)); return await m.sendRequest('set', { id: 'hysign', component: 'text', value: { text: 'HI', size: 0.2, width: 3.912 } });`);
  await sleep(800);
  const r = await page(`const b = await import('/lib/build.js'), sg = await import('/lib/scenegraph.js'), base = await import('/lib/base.js'); b.setEditMode(true); await new Promise((z) => setTimeout(z, 500)); sg.sceneSelect('hysign'); await new Promise((z) => setTimeout(z, 600));
    base.bus.emit('edit-righttab', 'history'); let lines = []; for (let i = 0; i < 20 && !lines.some((l) => /width/.test(l)); i++) { await new Promise((z) => setTimeout(z, 250)); lines = [...document.querySelectorAll('[data-frame="history"] .sp-info')].map((e) => e.textContent); }
    base.bus.emit('edit-righttab', 'inspector'); b.setEditMode(false); const n = await import('/lib/net.js'); await n.sendRequest('delete', { id: 'hysign' }); return lines.slice(0, 4);`);
  check("HY1 History says what an edit changed: 'text: width 5.076 → 3.912'", r?.some((l: string) => /text: width 5\.076 → 3\.912/.test(l)), r);
  });
  // ---- WG: out of reach (R, 10-10: "it's not giving me much clear feedback about why I can't grab it. The error line
  // appears in chat, but not every time ... an 'attention' color in the status bar ... or your avatar could walk over") ----
  await stage("WG", async () => {
  const bar = () => evalJson(`(() => { const h = document.getElementById('hintbar'); return { attn: h.classList.contains('attn'), gone: h.classList.contains('gone'), text: h.textContent }; })()`);
  const lines0 = await evalJson(`document.querySelectorAll('.chat-log .line').length`);
  await page(`const t = await import('/lib/thingphysics.js'); await t.physicsApi.grab('anchor'); return true;`); const b1 = await bar();
  await evalJson(`(document.getElementById('hintbar').classList.remove('attn'), true)`);
  await page(`const t = await import('/lib/thingphysics.js'); await t.physicsApi.grab('anchor'); return true;`); const b2 = await bar();
  check("WG1 a grab that is refused says why in the status bar, in the attention colour, and again the very next time (no 5 s hush), with no chat line", b1.attn && !b1.gone && /Anchor/.test(b1.text) && b2.attn && /Anchor/.test(b2.text) && (await evalJson(`document.querySelectorAll('.chat-log .line').length`)) === lines0, { b1, b2 });
  // something to pick up 5 m ahead of me, where the camera looks; a real click on it
  const far = await page(`const c = await import('/lib/controller.js'), k = await import('/lib/core.js'); const d = k.camera.getWorldDirection(new k.THREE.Vector3()); const h = Math.hypot(d.x, d.z) || 1; return { at: [c.myState.pos.x + d.x / h * 5, c.myState.pos.z + d.z / h * 5], me: [c.myState.pos.x, c.myState.pos.z] };`);
  const made = await page(`const m = await import('/lib/net.js'); return await m.sendRequest('create', { id: 'wgcrate', model: '${CRATE}', components: { label: 'Far crate', grabbable: { enabled: true }, physics: { kind: 'dynamic', who: 'visitor' }, transform: { pos: [${far.at[0]}, 0, ${far.at[1]}], scale: 0.3 } } });`);
  check("(setup) a small crate 5 m ahead, out of reach", made?.ok, made);
  await waitFor(`import('/lib/world.js').then((m) => !!m.entities.get('wgcrate'))`); await sleep(800);
  const cl = await page(`const c = await import('/lib/core.js'), cu = await import('/lib/clickuse.js'), w = await import('/lib/world.js'), T = c.THREE; const o = w.entities.get('wgcrate'); o.updateWorldMatrix(true, true);
    const p = new T.Box3().setFromObject(o).getCenter(new T.Vector3()).project(c.camera), r = c.canvas.getBoundingClientRect(); let x = r.left + (p.x + 1) / 2 * r.width, y = r.top + (1 - p.y) / 2 * r.height, found = cu.thingAt(x, y) === 'wgcrate';
    for (let k = 1; k <= 12 && !found; k++) for (const [ax, ay] of [[0, -1], [0, 1], [-1, 0], [1, 0]]) { const xx = x + ax * k * 4, yy = y + ay * k * 4; if (cu.thingAt(xx, yy) === 'wgcrate') { x = xx; y = yy; found = true; break; } }
    const ev = (t) => new MouseEvent(t, { bubbles: true, cancelable: true, button: 0, clientX: x, clientY: y }); c.canvas.dispatchEvent(ev('mousedown')); c.canvas.dispatchEvent(ev('mouseup'));
    return { found, walking: (await import('/lib/controller.js')).isAutoWalking() };`);
  const got = await waitFor(`import('/lib/thingphysics.js').then((m) => m.physicsApi.mine().includes('wgcrate'))`, 9000);
  const end = await page(`const c = await import('/lib/controller.js'); return { me: [c.myState.pos.x, c.myState.pos.z], walking: c.isAutoWalking() };`);
  check("WG2 a click on it out of reach walks me over and picks it up", cl?.found && cl.walking && got && Math.hypot(end.me[0] - far.me[0], end.me[1] - far.me[1]) > 2.5 && !end.walking, { cl, got, walked: Math.hypot(end.me[0] - far.me[0], end.me[1] - far.me[1]) });
  await page(`const t = await import('/lib/thingphysics.js'); await t.physicsApi.put('wgcrate'); return true;`); await sleep(600);
  });
  // ---- CT: clicks go through (R 10-11 01:17 queue E8: a per-thing switch; componentspec clickthrough) ----
  await stage("CT", async () => {
  const me = await evalJson(`import('/lib/controller.js').then((c) => [c.myState.pos.x, c.myState.pos.z, c.myState.yaw])`);
  // 1.2 m ahead and 0.7 m to the side: the full run leaves WG's crate straight ahead of me, and a click found that instead
  const made = await page(`const m = await import('/lib/net.js'); return await m.sendRequest('create', { id: 'ctbox', model: '${CRATE}', components: { label: 'Through', grabbable: { enabled: true }, transform: { pos: [${me[0]} + Math.sin(${me[2]}) * 1.2 + Math.cos(${me[2]}) * 0.7, 0.9, ${me[1]} + Math.cos(${me[2]}) * 1.2 - Math.sin(${me[2]}) * 0.7], scale: 0.3 } } });`);
  check("(setup) a crate in front of me", made?.ok, made);
  const seen = await waitFor(`import('/lib/world.js').then((m) => !!m.entities.get('ctbox') && !!m.bagOf('ctbox'))`, 15000); await sleep(600);   // realized, not just listed (the map holds null until the model is in)
  const dbg = await page(`const w = await import('/lib/world.js'); return { has: w.entities.has('ctbox'), comps: w.bagOf('ctbox') ?? null, n: w.entities.size };`);
  check("(setup) the crate is realized in the page", seen && dbg?.has, { seen, dbg });
  const at = () => page(`const c = await import('/lib/core.js'), cu = await import('/lib/clickuse.js'), w = await import('/lib/world.js'), T = c.THREE; const o = w.entities.get('ctbox'); o.updateWorldMatrix(true, true);
    const p = new T.Box3().setFromObject(o).getCenter(new T.Vector3()).project(c.camera), r = c.canvas.getBoundingClientRect(); return cu.thingAt(r.left + (p.x + 1) / 2 * r.width, r.top + (1 - p.y) / 2 * r.height);`);
  const pixel = await page(`const c = await import('/lib/core.js'), w = await import('/lib/world.js'), T = c.THREE; const o = w.entities.get('ctbox'); o.updateWorldMatrix(true, true);
    const p = new T.Box3().setFromObject(o).getCenter(new T.Vector3()).project(c.camera), r = c.canvas.getBoundingClientRect(); return [r.left + (p.x + 1) / 2 * r.width, r.top + (1 - p.y) / 2 * r.height];`);
  const before = await at();
  check("CT0 a click on it finds it", before === N('ctbox'), before);
  await page(`const m = await import('/lib/net.js'); return await m.sendRequest('set', { id: 'ctbox', component: 'clickthrough', value: true });`); await sleep(600);
  const after = await at();
  // what lies behind it is the earlier stages' business (the full run leaves box1 there): the same pixel with ctbox gone
  await page(`const m = await import('/lib/net.js'); return await m.sendRequest('delete', { id: 'ctbox' });`).catch(() => null);
  await waitFor(`import('/lib/world.js').then((m) => !m.entities.has('ctbox'))`, 8000); await sleep(300);
  const behind = await page(`const cu = await import('/lib/clickuse.js'); return cu.thingAt(${pixel[0]}, ${pixel[1]});`);
  check("CT1 with clickthrough set, the same click passes through it to whatever is behind (as if it were gone)", after !== N('ctbox') && after === behind, { after, behind });
  });
  // ---- CL: a live drag by someone else is a claim: an amber box and 'editing: <name>' in the Hierarchy, gone on end ----
  await stage("CL", async () => {
  const me = await evalJson(`import('/lib/controller.js').then((c) => [c.myState.pos.x, c.myState.pos.z])`);
  const made = await page(`const m = await import('/lib/net.js'); return await m.sendRequest('create', { id: 'clbox', model: '${CRATE}', components: { label: 'Claimed', transform: { pos: [${me[0]} + 1.5, 0, ${me[1]} + 1], scale: 0.3 } } });`);
  check("(setup) a crate to be dragged by someone else", made?.ok, made);
  await waitFor(`import('/lib/world.js').then((m) => !!m.entities.get('clbox') && !!m.bagOf('clbox'))`, 15000); await sleep(400);
  await key("KeyE"); await sleep(600);   // edit mode: the Hierarchy is up
  const seen = await page(`const b = await import('/lib/base.js'); b.bus.emit('drag', { id: 'clbox', pos: [${me[0]} + 1.6, 0, ${me[1]} + 1], yaw: 0, by: 'Zed' }); await new Promise((r) => setTimeout(r, 350));
    const bd = await import('/lib/build.js'); const rows = [...document.querySelectorAll('[data-frame="hierarchy"] .schema-scroll *')].map((e) => e.textContent).filter((t) => /editing: Zed/.test(t)).length;
    return { claims: bd.claimsNow(), rows };`);
  check("CL1 while Zed's drag samples flow, clbox is claimed by Zed and the Hierarchy row says so", seen?.claims?.[N('clbox')] === 'Zed' && seen.rows > 0, seen);
  const ended = await page(`const b = await import('/lib/base.js'); b.bus.emit('drag', { id: 'clbox', pos: [${me[0]} + 1.6, 0, ${me[1]} + 1], yaw: 0, by: 'Zed', end: true }); await new Promise((r) => setTimeout(r, 300));
    const bd = await import('/lib/build.js'); return bd.claimsNow();`);
  check("CL2 the last sample (end) drops the claim at once", !ended?.[N('clbox')], ended);
  const lapsed = await page(`const b = await import('/lib/base.js'); b.bus.emit('drag', { id: 'clbox', pos: [${me[0]} + 1.6, 0, ${me[1]} + 1], yaw: 0, by: 'Zed' }); await new Promise((r) => setTimeout(r, 2200));
    const bd = await import('/lib/build.js'); return bd.claimsNow();`);
  check("CL3 …and silence drops it after 1.5 s", !lapsed?.[N('clbox')], lapsed);
  // E2: a live scrub of a transform channel goes out as a drag (with the size), and its commit sends the last sample with end
  const sent = await page(`const ins = await import('/lib/inspect.js'); const out = []; const orig = WebSocket.prototype.send;
    WebSocket.prototype.send = function (s) { try { const m = JSON.parse(s); if (m.type === 'drag') out.push(m); } catch {} return orig.call(this, s); };
    const bd = await import('/lib/build.js'); bd.buildApi?.select?.('clbox');
    ins.commitEdit('clbox', 'pos.x', ${me[0]} + 1.9, { live: true }); ins.commitEdit('clbox', 'pos.x', ${me[0]} + 2.0, { live: true }); ins.commitEdit('clbox', 'pos.x', ${me[0]} + 2.0, {});
    await new Promise((r) => setTimeout(r, 400)); WebSocket.prototype.send = orig; return out;`);
  check("CL4 a live scrub of pos.x sends drag samples with the size, and the commit's last one says end", Array.isArray(sent) && sent.length >= 3 && sent.every((m) => m.id === N('clbox') && Array.isArray(m.scale)) && sent.at(-1).end === true && !sent[0].end, sent);
  await key("KeyE"); await sleep(300);
  await page(`const m = await import('/lib/net.js'); return await m.sendRequest('delete', { id: 'clbox' });`).catch(() => null); await sleep(300);
  });
  // ---- AC: aim at the cursor (R, 10-10: a throw "just aims away from your camera view, not at the spot you're aiming with
  // your cursor", and "my character would try to drop it where the cursor is, not right at their feet") ----
  await stage("AC", async () => {
  await page(`const c = await import('/lib/controller.js'), b = await import('/lib/base.js'); c.myState.pos.x -= 12; c.myState.pos.z += 14; b.bus.emit('cut-adopted'); return true;`);
  await waitFor(`import('/lib/thingphysics.js').then((m) => m.physicsApi.body().arrived)`, 8000); await sleep(1500);
  const me = await evalJson(`import('/lib/controller.js').then((c) => [c.myState.pos.x, c.myState.pos.z, c.myState.yaw])`);
  const made = await page(`const m = await import('/lib/net.js'); return await m.sendRequest('create', { id: 'acbox', model: '${CRATE}', components: { label: 'Aimed', grabbable: { enabled: true }, physics: { kind: 'dynamic', who: 'visitor' }, transform: { pos: [${me[0]} + 0.9, 0, ${me[1]}], scale: 0.3 } } });`);
  check("(setup) a small crate beside me", made?.ok, made);
  await waitFor(`import('/lib/world.js').then((m) => !!m.entities.get('acbox'))`); await sleep(800);
  await page(`const t = await import('/lib/thingphysics.js'); await t.physicsApi.grab('acbox'); return true;`); await sleep(1000);
  // the pixel where a ground point shows: project it, then a real click there
  const clickGround = (wx: number, wz: number) => page(`const c = await import('/lib/core.js'), T = c.THREE; const p = new T.Vector3(${wx}, 0, ${wz}).project(c.camera), r = c.canvas.getBoundingClientRect(), x = r.left + (p.x + 1) / 2 * r.width, y = r.top + (1 - p.y) / 2 * r.height;
    const cu = await import('/lib/clickuse.js'); const aim = cu.clickUseApi.aimPoint(x, y), over = cu.thingAt(x, y);
    const ev = (t) => new MouseEvent(t, { bubbles: true, cancelable: true, button: 0, clientX: x, clientY: y }); c.canvas.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: x, clientY: y })); c.canvas.dispatchEvent(ev('mousedown')); c.canvas.dispatchEvent(ev('mouseup')); return { aim, over, on: Math.abs(p.x) < 1 && Math.abs(p.y) < 1 };`);
  const where = () => page(`const w = await import('/lib/world.js'), T = (await import('/lib/core.js')).THREE; const o = w.entities.get('acbox'); o.updateWorldMatrix(true, false); const v = o.getWorldPosition(new T.Vector3()); return [v.x, v.y, v.z];`);
  const dir = await page(`const k = await import('/lib/core.js'); const d = k.camera.getWorldDirection(new k.THREE.Vector3()); const h = Math.hypot(d.x, d.z) || 1; return [d.x / h, d.z / h];`);
  const spot = [me[0] + dir[0] * 3.5 + dir[1] * 1.2, me[1] + dir[1] * 3.5 - dir[0] * 1.2];   // 3.7 m off, ahead and to one side: out of reach
  const cg = await clickGround(spot[0], spot[1]);
  const down = await waitFor(`import('/lib/thingphysics.js').then((m) => !m.physicsApi.mine().includes('acbox'))`, 9000); await sleep(1500);
  const at = await where();
  check("AC1 holding it, a click on a spot 3.7 m away walks me over and sets it down THERE (within 0.4 m), not at my feet", cg?.on && !cg.over && down && Math.hypot(at[0] - spot[0], at[2] - spot[1]) < 0.4, { cg, spot, at });
  // C throws at the spot under the cursor
  await page(`const t = await import('/lib/thingphysics.js'); await t.physicsApi.grab('acbox'); return true;`); await sleep(1000);
  const me2 = await evalJson(`import('/lib/controller.js').then((c) => [c.myState.pos.x, c.myState.pos.z])`);
  const tgt = [me2[0] + dir[0] * 5 - dir[1] * 2, me2[1] + dir[1] * 5 + dir[0] * 2];
  const mv = await page(`const c = await import('/lib/core.js'), T = c.THREE; const p = new T.Vector3(${tgt[0]}, 0, ${tgt[1]}).project(c.camera), r = c.canvas.getBoundingClientRect(), x = r.left + (p.x + 1) / 2 * r.width, y = r.top + (1 - p.y) / 2 * r.height;
    c.canvas.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: x, clientY: y })); return (await import('/lib/clickuse.js')).clickUseApi.aimPoint();`);
  await key("KeyC");
  // where it first comes down: the lowest-y moment near the ground, sampled in the page
  const land = await page(`const w = await import('/lib/world.js'), T = (await import('/lib/core.js')).THREE; const o = w.entities.get('acbox'), v = new T.Vector3(); let up = false, hit = null;
    for (let i = 0; i < 80 && !hit; i++) { o.updateWorldMatrix(true, false); o.getWorldPosition(v); const lo = new T.Box3().setFromObject(o).min.y; if (v.y > 0.5) up = true; else if (up && (lo < 0.06 || v.y < 0.12)) hit = [v.x, lo, v.z]; await new Promise((z) => setTimeout(z, 33)); } return { up, hit };`);
  check("AC2 C throws it at the spot under the cursor: it rises, and first comes down within 0.9 m of that spot (5.4 m away, off to one side)", mv && land?.up && land.hit && Math.hypot(land.hit[0] - tgt[0], land.hit[2] - tgt[1]) < 0.9, { aim: mv, tgt, land });
  await sleep(2500);
  // the menu: the name bare, in its own span
  await page(`const c = await import('/lib/core.js'), cu = await import('/lib/clickuse.js'), w = await import('/lib/world.js'), T = c.THREE; const o = w.entities.get('acbox'); o.updateWorldMatrix(true, true);
    const p = new T.Box3().setFromObject(o).getCenter(new T.Vector3()).project(c.camera), r = c.canvas.getBoundingClientRect(); let x = r.left + (p.x + 1) / 2 * r.width, y = r.top + (1 - p.y) / 2 * r.height;
    const ev = (t) => new MouseEvent(t, { bubbles: true, cancelable: true, button: 2, clientX: x, clientY: y }); c.canvas.dispatchEvent(ev('mousedown')); c.canvas.dispatchEvent(ev('mouseup')); return true;`);
  const mi = await evalJson(`(() => { const b = document.querySelector('.sp-ctx-item'); return b ? { text: b.textContent, name: b.querySelector('.sp-ctx-name')?.textContent ?? null } : null; })()`);
  await evalJson(`(document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })), true)`);
  check("AC3 the menu names the thing bare (no quotes), in its own accent span", mi?.name === "Aimed" && !/[“”"]/.test(mi.text), mi);
  });
  // ---- PR: my own throw, predicted (DESIGN-physics-responsiveness §3; R 10-10: "balls teleport right out of my hands").
  // The lab knob physicsApi.lag(300) delays the request, as a slow round trip would; the control arm turns prediction off
  // and shows the old shape (the thing waits in the hand for the whole lag), the real arm shows it leave at once. ----
  await stage("PR", async () => {
  await page(`const c = await import('/lib/controller.js'), b = await import('/lib/base.js'); c.myState.pos.x += 9; c.myState.pos.z -= 9; b.bus.emit('cut-adopted'); return true;`);
  await waitFor(`import('/lib/thingphysics.js').then((m) => m.physicsApi.body().arrived)`, 8000); await sleep(1200);
  await page(`const m = await import('/lib/net.js'); const st = m.replica.st; if (!st?.entities?.['@world']?.c?.['physics-engine']) await m.sendRequest('set', { id: '@world', component: 'physics-engine', value: { engine: 'eidosim@1.0.0' } }); return true;`); await sleep(600);
  const pm = await evalJson(`import('/lib/controller.js').then((c) => [c.myState.pos.x, c.myState.pos.z])`);
  // one crate per arm (a thrown one lands out of reach); a gentle throw straight ahead at 2 m/s
  const mk = async (id: string) => { const made = await page(`const m = await import('/lib/net.js'); return await m.sendRequest('create', { id: '${id}', model: '${CRATE}', components: { label: 'Predicted', grabbable: { enabled: true }, physics: { kind: 'dynamic', who: 'visitor' }, transform: { pos: [${pm[0] + 0.7}, 0, ${pm[1] + 0.3}], scale: 0.3 } } });`);
    check(`(setup) a crate for the throw (${id})`, made?.ok, made); await waitFor(`import('/lib/world.js').then((m) => !!m.entities.get('${id}'))`); await sleep(800); };
  // one throw, sampled every frame for 1.2 s: when the drawn crate first leaves the hand (> 5 cm), and the largest one-frame move
  const arm = async (predictOn: boolean, id: string) => { await mk(id); return page(`const t = await import('/lib/thingphysics.js'), w = await import('/lib/world.js'), T = (await import('/lib/core.js')).THREE;
    const r = await t.physicsApi.grab('${id}'); if (!r?.ok) return { grab: r }; await new Promise((res) => setTimeout(res, 900));
    t.physicsApi.predict(${predictOn}); t.physicsApi.lag(300);
    const o = w.entities.get('${id}'), v = new T.Vector3(); const at = () => { o.updateWorldMatrix(true, false); return o.getWorldPosition(v).toArray(); };
    const p0 = at(), t0 = performance.now(), S = []; let prev = p0, jump = 0, left = null;
    const done = t.physicsApi.throw(2);
    await new Promise((res) => { const f = () => { const p = at(), now = performance.now() - t0; const d = Math.hypot(p[0] - p0[0], p[1] - p0[1], p[2] - p0[2]), j = Math.hypot(p[0] - prev[0], p[1] - prev[1], p[2] - prev[2]);
      if (left === null && d > 0.05) left = now; if (j > jump) jump = j; prev = p; S.push([Math.round(now), +d.toFixed(3)]); if (now < 1200) requestAnimationFrame(f); else res(); }; requestAnimationFrame(f); });
    const reply = await done; t.physicsApi.lag(0); t.physicsApi.predict(true);
    await new Promise((res) => setTimeout(res, 2500));
    return { ok: !!reply?.ok, refused: reply?.refused ?? null, left, jump: +jump.toFixed(3), pending: t.physicsApi.pending(), swaps: t.physicsApi.swaps(), tail: S.filter((x, i) => i % 6 === 0).slice(0, 14) };`); };
  const control = await arm(false, 'prbox0');
  check("PR0 (control) with prediction off and a 300 ms request lag, the thrown crate waits in the hand for the lag", control?.ok && control.left !== null && control.left >= 250, control);
  const real = await arm(true, 'prbox1');
  check("PR1 with prediction the crate leaves the hand at least 150 ms sooner than without, under the same lag", real?.ok && real.left !== null && control?.left !== null && real.left < control.left - 150, { real: real?.left, control: control?.left });
  check("PR2 …and when the real entry lands no single frame moves it more than 35 cm (the guess and the truth agree, or the difference decays)", real?.ok && real.jump < 0.35, real);
  check("PR3 …and nothing is left pending once the entry is in", real?.ok && Object.keys(real.pending ?? {}).length === 0, real?.pending);
  // PR4: the page's clock STEPS (10-18: this box's wall clock jumps +1.6 s every ~32 s against the page's monotonic one, and
  // the shiplist went red — PR0 "left": null — whenever a jump fell between clock asks: the estimate kept the old offset,
  // the replica folded the launch at the authority's tick, and the screen drew it ~50 ticks early, i.e. not at all). Here
  // the step is made on purpose: performance.timeOrigin (read only by serverclock.js) moves back 1.6 s, so the page's
  // "now" is 1.6 s behind the authority's, as after a real jump. No prediction, no lag: the throw must still leave the hand
  // within half a second (the launch's own stamp floors the clock and the client re-measures at once)
  const stepped = await (async () => { await mk('prbox2'); return page(`const t = await import('/lib/thingphysics.js'), w = await import('/lib/world.js'), T = (await import('/lib/core.js')).THREE;
    const r = await t.physicsApi.grab('prbox2'); if (!r?.ok) return { grab: r }; await new Promise((res) => setTimeout(res, 900));
    const o0 = performance.timeOrigin; Object.defineProperty(performance, 'timeOrigin', { value: o0 - 1600, configurable: true });
    t.physicsApi.predict(false);
    const o = w.entities.get('prbox2'), v = new T.Vector3(); const at = () => { o.updateWorldMatrix(true, false); return o.getWorldPosition(v).toArray(); };
    const p0 = at(), t0 = performance.now(); let left = null;
    const done = t.physicsApi.throw(2);
    await new Promise((res) => { const f = () => { const p = at(), now = performance.now() - t0; if (left === null && Math.hypot(p[0] - p0[0], p[1] - p0[1], p[2] - p0[2]) > 0.05) left = now; if (now < 1500) requestAnimationFrame(f); else res(); }; requestAnimationFrame(f); });
    const reply = await done; t.physicsApi.predict(true); await new Promise((res) => setTimeout(res, 2000));
    return { ok: !!reply?.ok, left, clock: (await import('/lib/serverclock.js')).clockDebug() };`); })();
  check("PR4 after the page's clock steps 1.6 s (as this box's does), a throw with no prediction still leaves the hand within 500 ms", stepped?.ok && stepped.left !== null && stepped.left < 500, stepped);
  // back where this stage found me: later stages move relative to here
  await page(`const c = await import('/lib/controller.js'), b = await import('/lib/base.js'); c.myState.pos.x -= 9; c.myState.pos.z += 9; b.bus.emit('cut-adopted'); return true;`);
  await waitFor(`import('/lib/thingphysics.js').then((m) => m.physicsApi.body().arrived)`, 8000); await sleep(800);
  });
  // ---- RB: a reset button made from the Edit menu's helpers, used by its left-click offer (R, 10-10) ----
  await stage("RB", async () => {
  const me = await evalJson(`import('/lib/controller.js').then((c) => [c.myState.pos.x, c.myState.pos.z])`);
  const mk = await page(`const m = await import('/lib/net.js'); const a = await m.sendRequest('create', { id: 'rbtgt', model: '${CRATE}', components: { label: 'Reset target', transform: { pos: [${me[0]} + 2, 0, ${me[1]} - 2], scale: 0.3 } } });
    const b = await m.sendRequest('create', { id: 'rbbtn', model: '${CRATE}', components: { label: 'Reset button', transform: { pos: [${me[0]} + 0.8, 0, ${me[1]}], scale: 0.3 } } }); return [a.ok, b.ok];`);
  await waitFor(`import('/lib/world.js').then((m) => !!m.entities.get('rbtgt') && !!m.entities.get('rbbtn'))`); await sleep(600);
  const made = await page(`const e = await import('/lib/editwrites.js'); return await e.makeResetButton('rbbtn', ['rbtgt']);`);
  await sleep(800);
  const moved = await page(`const m = await import('/lib/net.js'); return await m.sendRequest('set', { id: 'rbtgt', component: 'transform', value: { pos: [${me[0]} + 5, 0, ${me[1]} + 5], q: [0, 0, 0, 1], scale: [0.3, 0.3, 0.3] } });`);
  await sleep(800);
  const offer = await page(`const cu = await import('/lib/clickuse.js'); const o = cu.offersOf('rbbtn'); const r = await o[0]?.run(); return { first: o[0]?.label, ok: r?.ok ?? null, why: r?.refused?.reason ?? null };`);
  await sleep(1200);
  const at = await page(`const st = (await import('/lib/state.js')).state.st; return st.entities['rbtgt']?.pos;`);
  check("RZ1 Edit's 'make reset button' + the button's first offer (its left-click): the moved thing is back where it stood when the button was made", mk.every(Boolean) && made?.ok && moved?.ok && /^reset/.test(offer.first ?? "") && offer.ok && Math.hypot(at[0] - me[0] - 2, at[2] - me[1] + 2) < 0.01, { mk, made: made?.ok ?? made, moved: moved?.ok, offer, at });
  });
  // ---- GE: the grip editor (R, 10-10): add a grip, drag it, mirror it, try it; the palm lands on the grip ----
  await stage("GE", async () => {
  const me = await evalJson(`import('/lib/controller.js').then((c) => [c.myState.pos.x, c.myState.pos.z])`);
  await page(`const m = await import('/lib/net.js'); return await m.sendRequest('create', { id: 'getool', model: '${CRATE}', components: { label: 'Grip tool', grabbable: {}, transform: { pos: [${me[0]} + 0.9, 0, ${me[1]}], scale: 0.25 } } });`);
  await waitFor(`import('/lib/world.js').then((m) => !!m.entities.get('getool'))`); await sleep(700);
  const opened = await page(`(await import('/lib/build.js')).setEditMode(true); await new Promise((z) => setTimeout(z, 400)); (await import('/lib/gripedit.js')).openGripEditor('getool');
    const p = globalThis.__gripeditTest(); const add = [...p.panel.querySelectorAll('button')].find((b) => b.textContent === '+ grip'); add.click(); await new Promise((z) => setTimeout(z, 1500));
    const w = await import('/lib/world.js'); return { grips: Object.keys(w.bagOf('getool')?.grabbable?.grips ?? {}), start: w.bagOf('getool')?.grabbable?.grips?.grip1?.pos ?? null, ed: globalThis.__gripedit(), gizmo: globalThis.__gizmo?.().attached ?? null };`);
  check("GE1 the grabbable card's grip editor adds a grip and shows a ghost hand on it (and the main gizmo steps aside)", opened.grips.includes("grip1") && opened.ed?.name === "grip1" && opened.ed?.ghost && !opened.gizmo, opened);
  const dragged = await page(`const t = globalThis.__gripeditTest(); t.proxy.position.y += 0.1; t.proxy.rotateZ(Math.PI / 2); t.controls.dispatchEvent({ type: 'dragging-changed', value: false }); await new Promise((z) => setTimeout(z, 1500));
    const g = (await import('/lib/world.js')).bagOf('getool').grabbable.grips.grip1; return g;`);
  check("GE2 a drag of the ghost writes the grip in the thing's frame (0.1 m up at scale 0.25 is 0.4; a quarter turn about the palm's Z)", Math.abs(dragged.pos[1] - opened.start[1] - 0.4) < 0.01 && Math.abs(dragged.pos[0] - opened.start[0]) < 0.01 && Math.abs(Math.abs(dragged.q[2]) - Math.SQRT1_2) < 0.01, { start: opened.start, dragged });
  const mirrored = await page(`const p = globalThis.__gripeditTest().panel; [...p.querySelectorAll('button')].find((b) => b.textContent === 'mirror').click(); await new Promise((z) => setTimeout(z, 1500));
    const gs = (await import('/lib/world.js')).bagOf('getool').grabbable.grips; return gs;`);
  const L = mirrored["grip1-left"], Rg = mirrored.grip1;
  check("GE3 mirror writes the left hand's grip: x negated, the same palm-out (Z) after the reflection", !!L && L.hand === "left" && Math.abs(L.pos[0] + Rg.pos[0]) < 1e-3 && Math.abs(L.pos[1] - Rg.pos[1]) < 1e-3, { L, R: Rg });
  const tried = await page(`const c = await import('/lib/controller.js'), w = await import('/lib/world.js'), { THREE: T } = await import('/lib/core.js'), tp = await import('/lib/thingphysics.js'), n = await import('/lib/net.js');
    const ge = await import('/lib/gripedit.js'); const tc = globalThis.__gripeditTest(); [...tc.panel.querySelectorAll('.gripedit-row')].find((r) => r.textContent.startsWith('grip1') && !r.textContent.includes('left')).click();
    await new Promise((z) => setTimeout(z, 300)); const r = await [...tc.panel.querySelectorAll('button')].find((b) => b.textContent === 'try it').onclick();
    await new Promise((z) => setTimeout(z, 2500)); const o = w.entities.get('getool'); o.updateWorldMatrix(true, false); const g = w.bagOf('getool').grabbable.grips.grip1;
    const gp = new T.Vector3(...g.pos).applyMatrix4(o.matrixWorld); const P = { p: new T.Vector3(), q: new T.Quaternion() }; const palm = tp.palmOf(n.net.you, 'right', P);
    return { ok: r?.ok ?? null, why: r?.refused?.reason ?? null, gap: palm ? +gp.distanceTo(P.p).toFixed(4) : null };`);
  check("GE4 try it: it is picked up by that grip, and the palm sits on the grip point (within 1 cm)", tried.ok && tried.gap !== null && tried.gap < 0.01, tried);
  await page(`(await import('/lib/gripedit.js')).closeGripEditor(); (await import('/lib/thingphysics.js')).physicsApi?.put?.('getool'); (await import('/lib/build.js')).setEditMode(false);`);
  });
  // ---- NH: the authority has no body for me while I think I'm here (R, 10-10 after a rename): a grab re-arrives ----
  await stage("NH", async () => {
  const me = await evalJson(`import('/lib/controller.js').then((c) => [c.myState.pos.x, c.myState.pos.z])`);
  await page(`const m = await import('/lib/net.js'); return await m.sendRequest('create', { id: 'nhball', model: '${CRATE}', components: { grabbable: {}, transform: { pos: [${me[0]} + 0.7, 0, ${me[1]}], scale: 0.2 } } });`);
  await waitFor(`import('/lib/world.js').then((m) => !!m.entities.get('nhball'))`); await sleep(500);
  const r = await page(`const n = await import('/lib/net.js'), t = await import('/lib/thingphysics.js'); const gone = await n.sendRequest('leave', {});
    const cu = await import('/lib/clickuse.js'); const o = cu.offersOf('nhball'); const g = await o[0]?.run(); await new Promise((z) => setTimeout(z, 600));
    const back = await t.physicsApi.put('nhball'); return { first: o[0]?.label, left: gone?.ok ?? gone?.refused?.code, grab: g?.ok ?? g?.refused?.code, put: back?.ok ?? back?.refused?.code };`);
  check("NH1 my body gone at the authority (leave), a CLICK grab (the left-click offer) still works: the 'not-here' refusal re-arrives and sends it again", r.left === true && r.grab === true, r);
  });
  // ---- PO: holding one thing, right-click another: 'put X on Y' sets it down on top, where the click was (R, 10-10) ----
  await stage("PO", async () => {
  const me = await evalJson(`import('/lib/controller.js').then((c) => [c.myState.pos.x, c.myState.pos.z])`);
  await page(`const m = await import('/lib/net.js'); await m.sendRequest('create', { id: 'pobase', model: '${CRATE}', components: { label: 'Base', grabbable: {}, transform: { pos: [${me[0]} + 0.9, 0, ${me[1]}], scale: 0.4 } } });
    return await m.sendRequest('create', { id: 'potop', model: '${CRATE}', components: { label: 'Small', grabbable: {}, transform: { pos: [${me[0]} - 0.8, 0, ${me[1]}], scale: 0.15 } } });`);
  await waitFor(`import('/lib/world.js').then((m) => !!m.entities.get('pobase') && !!m.entities.get('potop'))`); await sleep(700);
  const r = await page(`const t = await import('/lib/thingphysics.js'), cu = await import('/lib/clickuse.js'), w = await import('/lib/world.js'), { THREE: T } = await import('/lib/core.js');
    const g = await t.physicsApi.grab('potop'); await new Promise((z) => setTimeout(z, 800));
    const b = new T.Box3().setFromObject(w.entities.get('pobase')); const side = [b.max.x, (b.min.y + b.max.y) / 2, (b.min.z + b.max.z) / 2];   // a click on its side
    const o = cu.offersOf('pobase', { spot: side }); const put = o.find((x) => x.k === 'puton'); const res = await put?.run(); await new Promise((z) => setTimeout(z, 1500));
    const tb = new T.Box3().setFromObject(w.entities.get('potop'));
    return { grab: g?.ok ?? null, label: put?.label ?? null, ok: res?.ok ?? res?.refused?.code ?? null, topBottom: +tb.min.y.toFixed(3), baseTop: +b.max.y.toFixed(3), held: t.physicsApi.mine() };`);
  check("PO1 holding one thing, the menu on another offers 'put Small on Base'; a click on its side sets it down ON it", r.grab && /^put Small on Base$/.test(r.label ?? "") && r.ok === true && Math.abs(r.topBottom - r.baseTop) < 0.03 && !r.held.length, r);
  });
  // ---- EP: each mode keeps its own open HUD panels (R, 10-10; Blender's workspaces) ----
  await stage("EP", async () => {
  const r = await page(`const W = await import('/lib/windows.js'), B = await import('/lib/build.js'); const wait = (ms) => new Promise((z) => setTimeout(z, ms));
    const ids = W.allFrames().map((f) => f.id); const a = ['actions', 'profile', 'keyboard', 'debug'].find((x) => ids.includes(x)), b = ['profile', 'keyboard', 'actions', 'debug'].find((x) => ids.includes(x) && x !== a);
    try { localStorage.removeItem('ew.edit.panels'); } catch {}
    W.getFrame(a).show(); W.getFrame(b).hide(); B.setEditMode(true); await wait(500);
    const inEdit1 = [W.getFrame(a).visible, W.getFrame(b).visible]; W.getFrame(b).show(); await wait(200);
    B.setEditMode(false); await wait(500); const inPlay = [W.getFrame(a).visible, W.getFrame(b).visible];
    B.setEditMode(true); await wait(500); const inEdit2 = [W.getFrame(a).visible, W.getFrame(b).visible]; B.setEditMode(false); await wait(400); W.getFrame(a).hide();
    return { a, b, inEdit1, inPlay, inEdit2 };`);
  check("EP1 entering edit mode puts play's panels away; what I open in edit mode comes back next time; play's come back on leaving", JSON.stringify(r.inEdit1) === "[false,false]" && JSON.stringify(r.inPlay) === "[true,false]" && JSON.stringify(r.inEdit2) === "[false,true]", r);
  });
  // ---- CH: the chat's "scroll up for earlier" note appears once, however many times I rejoin (R, 10-10) ----
  await stage("CH", async () => {
  const n = await page(`const c = await import('/lib/chat.js'); for (let i = 0; i < 3; i++) c.noteHistoryContext({ total: null, shown: 40 }); return document.querySelectorAll('.hist-note').length;`);
  check("CH1 three rejoins leave ONE history note in the chat, not three", n === 1, { notes: n });
  });
  // ---- AT: the Attributes tab, the Inspector's eye, a card's ✕ (R, 10-10 18:55) ----
  await stage("AT", async () => {
  const me = await evalJson(`import('/lib/controller.js').then((c) => [c.myState.pos.x, c.myState.pos.z])`);
  await page(`const m = await import('/lib/net.js'); await m.sendRequest('create', { id: 'atbox', model: '${CRATE}', components: { label: 'Attr box', transform: { pos: [${me[0]} + 3, 0, ${me[1]} + 3], scale: 0.3 } } });
    return await m.sendRequest('set', { id: 'atbox', component: 'motion', value: { type: 'spin', axis: [0, 1, 0], degPerSec: 30 } });`);
  await waitFor(`import('/lib/world.js').then((m) => !!m.entities.get('atbox'))`); await sleep(600);
  const r = await page(`(await import('/lib/build.js')).setEditMode(true); await new Promise((z) => setTimeout(z, 500)); (await import('/lib/scenegraph.js')).sceneSelect('atbox'); await new Promise((z) => setTimeout(z, 900));
    const insp = document.querySelector('[data-frame="inspector"]'); const labels = [...insp.querySelectorAll('.sp-label')].map((l) => l.textContent.trim());
    const eye = [...insp.querySelectorAll('.sp-bar button')].find((b) => /YOUR view/.test(b.title)); const hasEyeIcon = !!eye?.querySelector('svg');
    const spinX = [...insp.querySelectorAll('.sp-row.sp-f-group')].find((g) => /^▾?[ ]*Spin/.test(g.textContent.trim()))?.querySelector('.sp-gact');
    (await import('/lib/base.js')).bus.emit('edit-righttab', 'attributes'); await new Promise((z) => setTimeout(z, 600));
    const at = document.querySelector('[data-frame="attributes"]'); const al = [...at.querySelectorAll('.sp-label')].map((l) => l.textContent.trim());
    const ag = [...at.querySelectorAll('.sp-group')].map((g) => g.textContent.slice(2).trim()); const ig = [...insp.querySelectorAll('.sp-group')].map((g) => g.textContent.slice(2).trim());
    (await import('/lib/base.js')).bus.emit('edit-righttab', 'inspector'); await new Promise((z) => setTimeout(z, 300));   // back to the Inspector whatever happens (VM2b measures it)
    let removed = null; if (spinX) { spinX.click(); await new Promise((z) => setTimeout(z, 1500)); removed = !(await import('/lib/world.js')).bagOf('atbox')?.motion; }
    (await import('/lib/build.js')).setEditMode(false);
    return { ag, ig, hiddenCheckbox: labels.includes('hidden'), parentInInspector: labels.includes('parent'), eye: eye?.title ?? null, hasEyeIcon, attr: al, spinX: !!spinX, removed };`);
  check("AT1 the Inspector has the my-view eye (with its icon) and no 'hidden' checkbox or parent row; Attributes has id, hidden for all, parent and every component as JSON", !r.hiddenCheckbox && !r.parentInInspector && r.eye && r.hasEyeIcon && ["id", "hidden for all", "parent", "motion", "label"].every((x) => r.attr.includes(x)), r);
  check("AT1b rotation order and the quaternion are in Attributes ('Rotation, as stored'), not an Inspector 'Advanced' group (R 10-10 23:38)", r?.ag?.includes("Rotation, as stored") && !r?.ig?.includes("Advanced"), { ag: r?.ag, ig: r?.ig });
  check("AT2 a removable card's title line carries a ✕ that removes it (Spin)", r.spinX && r.removed === true, r);
  });
  // ---- MT: the draft hesperus/material, drawn (docs/COMPONENT-LADDER.md rung 1; R 10-10) ----
  await stage("MT", async () => {
  const me = await evalJson(`import('/lib/controller.js').then((c) => [c.myState.pos.x, c.myState.pos.z])`);
  await page(`const m = await import('/lib/net.js'); for (const [id, dx] of [['mta', 2], ['mtb', 3.2]]) await m.sendRequest('create', { id, model: '${CRATE}', components: { transform: { pos: [${me[0]} + dx, 0, ${me[1]} - 3], scale: 0.3 } } }); return true;`);
  await waitFor(`import('/lib/world.js').then((m) => m.entities.get('mta') && m.entities.get('mtb'))`); await sleep(1500);
  const look = (id) => `(() => { const w = globalThis.__mtw; let c = null, r = null, shared = null; w.entities.get('${id}').traverse((o) => { if (o.isMesh && c === null) { const mm = Array.isArray(o.material) ? o.material[0] : o.material; c = mm.color?.getHexString?.() ?? null; r = mm.roughness ?? null; shared = mm; } }); return { c, r, mat: shared }; })()`;
  const r = await page(`globalThis.__mtw = await import('/lib/world.js'); const n = await import('/lib/net.js');
    const before = ${look('mta')}; const set = await n.sendRequest('set', { id: 'mta', component: 'hesperus/material', value: { color: 0xff2200, roughness: 0.15 } });
    await new Promise((z) => setTimeout(z, 1500)); const a = ${look('mta')}, b = ${look('mtb')};
    const del = await n.sendRequest('delete', { id: 'mta', component: 'hesperus/material' }); await new Promise((z) => setTimeout(z, 1500)); const back = ${look('mta')};
    const slot = globalThis.__matoverride.materialsOf('mta')[0]?.slot; await n.sendRequest('set', { id: 'mta', component: 'hesperus/material:' + slot, value: { color: 0x0044ff } });
    await n.sendRequest('set', { id: 'mtb', component: 'hesperus/material:not-a-slot', value: { color: 0x00ff00 } }); await new Promise((z) => setTimeout(z, 1500));
    const sa = ${look('mta')}, sb = ${look('mtb')};
    return { slot, slotA: sa.c, slotB: sb.c, set: set.ok ?? set.refused, before: [before.c, before.r], a: [a.c, a.r], b: [b.c, b.r], sharedWithB: a.mat === b.mat, back: [back.c, back.r], backIsOwn: back.mat === before.mat, del: del.ok ?? del.refused };`);
  check("MT2 a one-slot override (hesperus/material:<its slot>) recolours that slot; a slot the model doesn't have changes nothing", r.slot && r.slotA === "0044ff" && r.slotB === r.before[0], r);
  check("MT1 a hesperus/material override recolours that one thing (a clone; the same model elsewhere is untouched), and deleting it brings the model's own material back", r.set === true && r.a[0] === "ff2200" && Math.abs(r.a[1] - 0.15) < 1e-6 && r.b[0] === r.before[0] && !r.sharedWithB && r.backIsOwn && r.del === true, r);
  });
  // ---- EC: the camera in edit mode (R, 10-10: "we need camera moving controls in edit mode ... Blender or Maya ... or
  // left-click hold and move wherever there's a bare space (not even this last one works)") ----
  await stage("EC", async () => {
  // the earlier stages punted the crate away, walked me off and left things at my feet: step to clear ground and put
  // the crate in the camera's view (ahead of my body along the way the camera looks, once the camera has followed)
  await page(`const c = await import('/lib/controller.js'), b = await import('/lib/base.js'); c.myState.pos.x += 20; c.myState.pos.z += 20; b.bus.emit('cut-adopted'); return true;`);
  await waitFor(`import('/lib/thingphysics.js').then((m) => m.physicsApi.body().arrived)`, 8000); await sleep(1500);
  const put = await page(`const c = await import('/lib/controller.js'), k = await import('/lib/core.js'), n = await import('/lib/net.js'); const d = k.camera.getWorldDirection(new k.THREE.Vector3()); const h = Math.hypot(d.x, d.z) || 1;
    const r = await n.sendRequest('set', { id: 'cuball', component: 'transform', value: { pos: [c.myState.pos.x + d.x / h * 1.5, 0, c.myState.pos.z + d.z / h * 1.5], scale: [0.3, 0.3, 0.3] } }); return { ok: !!r?.ok, code: r?.refused?.code ?? null, dir: [d.x, d.y, d.z] };`); await sleep(2500);
  check("(setup) the crate is back in view, on clear ground", put?.ok, put);
  await evalJson(`import('/lib/build.js').then((m) => (m.setEditMode(true), true))`);
  const cam = () => evalJson(`import('/lib/controller.js').then((c) => ({ yaw: c.camYaw, pitch: c.camPitch, dist: c.camDist, pan: c.editPan.toArray() }))`);
  // a drag: press at (x, y), three moves, release. where: 'cuball' = a pixel on that thing, 'bare' = a pixel no thing is under
  const drag = (where: string, button: number, alt: boolean, mx: number, my: number) => page(`const c = await import('/lib/core.js'), w = await import('/lib/world.js'), T = c.THREE;
    const r = c.canvas.getBoundingClientRect(), R = new T.Raycaster(), all = [...w.entities.values()].filter(Boolean);
    const under = (x, y) => { R.setFromCamera(new T.Vector2(((x - r.left) / r.width) * 2 - 1, -((y - r.top) / r.height) * 2 + 1), c.camera); let o = R.intersectObjects(all, true)[0]?.object; while (o && !o.userData.entityId) o = o.parent; return o?.userData.entityId ?? null; };
    let at = null;
    for (let gy = 1; gy < 64 && !at; gy++) for (let gx = 1; gx < 96 && !at; gx++) { const x = r.left + r.width * gx / 96, y = r.top + r.height * gy / 64, u = under(x, y); if (${where === "bare" ? "u === null" : `u === '${where}'`}) at = [x, y]; }
    if (!at) return { at: null };
    const ev = (t, o = {}) => new MouseEvent(t, { bubbles: true, cancelable: true, button: ${button}, altKey: ${alt}, clientX: at[0], clientY: at[1], ...o });
    c.canvas.dispatchEvent(ev('mousedown'));
    for (let i = 0; i < 3; i++) window.dispatchEvent(ev('mousemove', { movementX: ${mx} / 3, movementY: ${my} / 3, clientX: at[0] + ${mx} * (i + 1) / 3, clientY: at[1] + ${my} * (i + 1) / 3, buttons: 1 }));
    window.dispatchEvent(ev('mouseup', { clientX: at[0] + ${mx}, clientY: at[1] + ${my} }));
    return { at };`);
  const sel = () => evalJson(`import('/lib/build.js').then((m) => (m.hasSelection() ? 'cuball' : null))`);
  const p0 = await page(`const w = await import('/lib/world.js'); return w.entities.get('cuball').position.toArray();`);
  const c0 = await cam(); const d1 = await drag("cuball", 0, true, 90, 0); const c1 = await cam();
  const p1 = await page(`const w = await import('/lib/world.js'); return w.entities.get('cuball').position.toArray();`);
  check("EC1 Alt+left-drag over a thing orbits the camera and leaves the thing where it was", d1?.at && Math.abs(c1.yaw - c0.yaw) > 0.2 && Math.hypot(p1[0] - p0[0], p1[2] - p0[2]) < 1e-6, { d1, c0, c1, p0, p1 });
  const d2 = await drag("bare", 1, false, 120, 60); const c2 = await cam();
  check("EC2 middle-drag pans: the orbit's centre leaves my body, the angles stay", d2?.at && Math.hypot(...c2.pan) > 0.2 && Math.abs(c2.yaw - c1.yaw) < 1e-9, { d2, c1, c2 });
  const d3 = await drag("bare", 2, true, 0, 150); const c3 = await cam();
  check("EC3 Alt+right-drag dollies: the distance changes, nothing else", d3?.at && Math.abs(c3.dist - c2.dist) > 0.5 && Math.abs(c3.yaw - c2.yaw) < 1e-9, { c2, c3 });
  await evalJson(`import('/lib/build.js').then((m) => (m.select('cuball'), true))`);
  const s0 = await sel(); const d4 = await drag("bare", 0, false, 100, 0); const c4 = await cam(); const s1 = await sel();
  check("EC4 a left-drag on bare space orbits, and keeps what was selected", d4?.at && Math.abs(c4.yaw - c3.yaw) > 0.2 && s0 === N("cuball") && s1 === N("cuball"), { d4, c3, c4, s0, s1 });
  await drag("bare", 0, false, 0, 0);
  check("EC5 …and a left CLICK on bare space (no travel) deselects, as before", (await sel()) === null, await sel());
  // F in Body mode on a thing: the eye stays OUTSIDE it (it was pulled into its middle by the wall rule)
  await evalJson(`import('/lib/build.js').then((m) => (m.select('anchor'), true))`); await evalJson(`(window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyF', key: 'f', bubbles: true })), true)`); await sleep(1500);
  const fb = await page(`const k = await import('/lib/core.js'), w = await import('/lib/world.js'), T = k.THREE; const o = w.entities.get('anchor'); const b = new T.Box3().setFromObject(o); return { inside: b.containsPoint(k.camera.position), dist: +k.camera.position.distanceTo(b.getCenter(new T.Vector3())).toFixed(2), half: +(b.getSize(new T.Vector3()).length() / 2).toFixed(2) };`);
  check("EC6b F on a thing in Body mode frames it from outside: the camera is not inside it, and stands back at least its half-size", fb && !fb.inside && fb.dist > fb.half, fb);
  // F frames something far off; then walking brings the camera home
  await page(`const c = await import('/lib/controller.js'), k = await import('/lib/core.js'); c.frameOn(new k.THREE.Vector3(c.myState.pos.x + 30, 2, c.myState.pos.z + 30), 4); return true;`);
  const far = await cam();
  await evalJson(`(window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyW', key: 'w', bubbles: true })), true)`); await sleep(900);
  await evalJson(`(window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyW', key: 'w', bubbles: true })), true)`);
  const home = await cam();
  check("EC7 after F frames a far thing, walking (W) brings the camera back to my body", Math.hypot(...far.pan) > 30 && Math.hypot(...home.pan) < 0.05, { far: far.pan, home: home.pan });
  await evalJson(`import('/lib/build.js').then((m) => (m.setEditMode(false), true))`);
  const c5 = await cam();
  check("EC6 leaving edit mode gives the camera back to the body: no pan, no further than play allows", Math.hypot(...c5.pan) === 0 && c5.dist <= 16, c5);
  });
  // ---- HQ: a quieter hierarchy (R, 10-10: names only, the id on hover, a View menu for ids / kinds / components; and
  // the World row says which world it is) ----
  await stage("HQ", async () => {
  await evalJson(`import('/lib/build.js').then((m) => (m.setEditMode(true), true))`);
  await evalJson(`(localStorage.removeItem('ew.hierarchy.view'), true)`);
  const H = `document.querySelector('[data-frame="hierarchy"]')`;
  const row = () => evalJson(`(() => { const l = [...${H}.querySelectorAll('.sp-tree-row')].find((x) => x.dataset.id === 'cuball'); const m = l?.querySelector('.sp-item-main'); return l ? { label: m.querySelector('.sp-item-label')?.textContent, sub: m.querySelector('.sp-item-sub')?.textContent ?? null, title: m.title } : null; })()`);
  await waitFor(`!!${H}?.querySelector('.sp-tree-row')`, 5000);
  const w = await evalJson(`(() => { const l = ${H}.querySelector('.sp-list .sp-item-main'); const ic = l?.querySelector('.sp-ico')?.getBoundingClientRect(), lb = l?.querySelector('.sp-item-label')?.getBoundingClientRect(); return { label: l?.querySelector('.sp-item-label')?.textContent, icon: !!l?.querySelector('.sp-ico svg'), inline: !!ic && !!lb && Math.abs((ic.top + ic.height / 2) - (lb.top + lb.height / 2)) < 6 && lb.left > ic.right - 1, title: l?.title }; })()`);
  check("HQ1 the World row says which world it is (WORLD, then its name), with its glyph on the same line and a tooltip", /^World\S/.test(w?.label ?? "") && w?.icon && w?.inline && /world itself/.test(w?.title ?? ""), w);
  const r0 = await row();
  check("HQ2 a row is the name alone; its id and kind are on hover", r0?.label === "Clicker" && r0.sub === null && r0.title.includes(`id ${N("cuball")}`), r0);
  const pick = async (k: string) => { await evalJson(`(${H}.querySelector('.sp-pop-btn').click(), true)`); await waitFor(`!!document.querySelector('.sp-pop-item')`, 2000);
    await evalJson(`([...document.querySelectorAll('.sp-pop-item')].find((b) => b.textContent.includes('${k}'))?.click(), true)`); await sleep(400); };
  await pick("show ids");
  const r1 = await row();
  const face = await evalJson(`(() => { const b = ${H}.querySelector('.sp-pop-btn'), r = b.closest('.sp-row'); b.click(); const pop = document.querySelector('.sp-pop'); const o = { btn: b.textContent, rowText: r.textContent, items: [...document.querySelectorAll('.sp-pop-item')].map((x) => x.textContent.trim()), search: (() => { const i = pop?.querySelector('.sp-pop-search'); return i ? i.getBoundingClientRect().height : 0; })() }; document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); return o; })()`);
  check("HQ2b the switches live under ONE 'Options' button (said once), a plain list: each switch once, then expand all / collapse all, no search box", face?.btn === "Options ▾" && face.rowText === "Options ▾"
    // read off the menu, not counted (the row filters joined it 10-12): each line once, the three view switches among them
    && new Set(face.items).size === face.items.length && ["show ids", "show kinds", "list components"].every((w) => face.items.some((t) => t.endsWith(w)))
    && face.items.filter((t) => /expand all|collapse all/.test(t)).length === 2 && face.search < 2, face);
  check("HQ3 Options ▸ show ids: the row carries its id again", new RegExp(`Clicker\\s+\\(${N("cuball")}\\)`).test(r1?.label ?? ""), r1);
  await pick("list components");
  // R 10-11 00:03: with components listed, things start FOLDED; opening one shows its components
  const compRows = () => evalJson(`[...${H}.querySelectorAll('.sp-tree-row')].filter((x) => (x.dataset.id ?? '').startsWith('comp:' + 'cuball' + ':')).map((x) => x.querySelector('.sp-item-label').textContent)`);
  const shut = await compRows();
  await evalJson(`(${H}.querySelector('.sp-tree-row[data-id="cuball"] .sp-disc')?.click(), true)`); await sleep(400);
  const cs = await compRows();
  check("HQ4a …and with them listed, things start folded (no component rows until I open one)", Array.isArray(shut) && shut.length === 0, shut);
  check("HQ4 Options ▸ list components: opened, its components are rows under it (grabbable, physics)", cs?.includes("grabbable") && cs?.includes("physics") && !cs?.includes("label"), cs);
  await evalJson(`(localStorage.removeItem('ew.hierarchy.view'), true)`);
  await evalJson(`import('/lib/build.js').then((m) => (m.setEditMode(false), true))`);
  });
  // ---- DK: the dock folds in edit mode (R, 10-10: a "..." that expands to the full dock and shrinks to just the ∃ and the wrench) ----
  await stage("DK", async () => {
  await evalJson(`(localStorage.removeItem('ew.edit.dock'), true)`);
  const shown = () => evalJson(`(() => { const d = document.getElementById('dock'); const vis = (b) => getComputedStyle(b).display !== 'none' && !b.hidden;
    return { panels: [...d.querySelectorAll('button[data-toggles]')].filter((b) => b.dataset.toggles !== 'edit' && vis(b)).length, wrench: !!d.querySelector('button[data-toggles="edit"]') && vis(d.querySelector('button[data-toggles="edit"]')), more: !!d.querySelector('.dock-more') && vis(d.querySelector('.dock-more')) }; })()`);
  const play = await shown();
  await evalJson(`import('/lib/build.js').then((m) => (m.setEditMode(true), true))`); await sleep(500);
  const folded = await shown();
  check("DK1 entering edit mode, the dock is folded: the wrench and the ⋯, no panel buttons", play.panels > 0 && folded.panels === 0 && folded.wrench && folded.more, { play, folded });
  await evalJson(`(document.querySelector('#dock .dock-more').click(), true)`); await sleep(300);
  const open = await shown();
  check("DK2 the ⋯ opens it: the panel buttons are back", open.panels > 0 && open.wrench && open.more, open);
  await evalJson(`(document.querySelector('#dock .dock-more').click(), true)`); await sleep(300);
  check("DK3 …and the ⋯ again folds it", (await shown()).panels === 0, await shown());
  await evalJson(`import('/lib/build.js').then((m) => (m.setEditMode(false), true))`); await sleep(500);
  const back = await shown();
  check("DK4 leaving edit mode gives the dock back whole, with no ⋯", back.panels === play.panels && !back.more, { play, back });
  await evalJson(`(localStorage.removeItem('ew.edit.dock'), true)`);
  });
  // ---- CB: the channel box, after Maya's (R, 10-10): plain numbers, scale coloured, the name a handle, reset in the menu ----
  await stage("CB", async () => {
  await evalJson(`import('/lib/build.js').then((m) => (m.setEditMode(true), true))`);
  await page(`const n = await import('/lib/net.js'); await n.sendRequest('set', { id: 'cuball', component: 'transform', value: { pos: [7.5, 0.25, 6], scale: [0.5, 0.5, 0.5] } }); (await import('/lib/scenegraph.js')).sceneSelect('cuball'); return true;`);
  const I = `document.querySelector('[data-frame="inspector"]')`;
  const rows = () => evalJson(`[...${I}.querySelectorAll('.sp-row.sp-f-num')].map((r) => ({ label: r.querySelector('.sp-label')?.textContent, v: r.querySelector('.sp-num')?.value, axis: r.dataset.axis ?? null, sel: r.classList.contains('chan-sel'), revert: !!r.querySelector('.sp-revert:not([hidden])') })).filter((r) => /^(translate|rotate|scale) [xyz]/.test(r.label ?? ''))`);
  await waitFor(`[...${I}.querySelectorAll('.sp-label')].some((l) => /^translate x/.test(l.textContent))`, 5000); await sleep(500);
  const r0 = await rows(); const v = (l: string, rs = r0) => rs?.find((r: any) => r.label.startsWith(l));
  check("CB1 numbers are plain: 7.5 not 7.50, 0.25, 6 not 6.00, a bare 0, 0.5 not 0.50", v("translate x")?.v === "7.5" && v("translate y")?.v === "0.25" && v("translate z")?.v === "6" && v("rotate x")?.v === "0" && v("scale x")?.v === "0.5", r0?.map((r: any) => `${r.label}=${r.v}`));
  check("CB2 scale's channels are coloured by axis like the others, and none shows a ↺", ["x", "y", "z"].every((a) => v(`scale ${a}`)?.axis === a) && r0?.every((r: any) => !r.revert), r0);
  // the NAME is a handle: a drag on it scrubs, a click selects
  const onLabel = (name: string, kind: string, o = "") => page(`const l = [...${I}.querySelectorAll('.sp-row.sp-f-num .sp-label')].find((x) => x.textContent.startsWith('${name}')); const b = l.getBoundingClientRect(), x = b.left + 8, y = b.top + b.height / 2;
    const ev = (t, dx = 0, more = {}) => new PointerEvent(t, { bubbles: true, cancelable: true, pointerId: 7, button: 0, clientX: x + dx, clientY: y, ...more });
    if ('${kind}' === 'drag') { l.dispatchEvent(ev('pointerdown')); for (const dx of [6, 20, 40, 60]) l.dispatchEvent(ev('pointermove', dx)); l.dispatchEvent(ev('pointerup', 60)); }
    else if ('${kind}' === 'menu') l.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: x, clientY: y }));
    else { l.dispatchEvent(ev('pointerdown', 0, { ${o} })); l.dispatchEvent(ev('pointerup', 0, { ${o} })); }
    return true;`);
  await onLabel("translate x", "drag"); await sleep(600);
  const r1 = await rows();
  check("CB3 a drag on the name 'translate x' scrubs its value", +v("translate x", r1)?.v > 7.6 && Math.abs(disk().entities[N("cuball")].c.transform.pos[0] - +v("translate x", r1).v) < 0.01, { face: v("translate x", r1)?.v, disk: disk().entities[N("cuball")].c.transform.pos });
  await onLabel("translate x", "click"); await onLabel("translate z", "click", "ctrlKey: true"); await sleep(200);
  const r2 = await rows();
  check("CB4 a click on a name selects the channel; Ctrl-click adds another", v("translate x", r2)?.sel && v("translate z", r2)?.sel && !v("translate y", r2)?.sel, r2?.filter((r: any) => r.sel).map((r: any) => r.label));
  // R 10-10 23:36: "enable click-drag and shift-selecting multiple channels" (Maya's channel box)
  await onLabel("rotate x", "click"); await onLabel("scale y", "click", "shiftKey: true"); await sleep(200);
  const r2b = await rows(); const selOf = (rs: any) => rs?.filter((r: any) => r.sel).map((r: any) => r.label);
  check("CB4b Shift-click selects the run from the last channel clicked (rotate x … scale y)", JSON.stringify(selOf(r2b)) === JSON.stringify(["rotate x", "rotate y", "rotate z", "scale x", "scale y"]), selOf(r2b));
  await page(`const L = [...${I}.querySelectorAll('.sp-row.sp-f-num .sp-label')]; const a = L.find((x) => x.textContent.startsWith('translate y')), b = L.find((x) => x.textContent.startsWith('rotate y'));
    const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect(), x = ra.left + 8; const ev = (t, y) => new PointerEvent(t, { bubbles: true, cancelable: true, pointerId: 9, button: 0, clientX: x, clientY: y });
    a.dispatchEvent(ev('pointerdown', ra.top + ra.height / 2)); for (const k of [0.25, 0.5, 0.75, 1]) dispatchEvent(ev('pointermove', ra.top + ra.height / 2 + (rb.top - ra.top) * k)); dispatchEvent(ev('pointerup', rb.top + rb.height / 2)); a.dispatchEvent(ev('pointerup', rb.top + rb.height / 2)); return true;`); await sleep(300);
  const r2c = await rows();
  check("CB4c dragging DOWN the names selects the run (translate y … rotate y), and scrubs nothing", JSON.stringify(selOf(r2c)) === JSON.stringify(["translate y", "translate z", "rotate x", "rotate y"]) && v("translate y", r2c)?.v === v("translate y", r2b)?.v, { sel: selOf(r2c), ty: [v("translate y", r2b)?.v, v("translate y", r2c)?.v] });
  await onLabel("translate x", "click"); await onLabel("translate z", "click", "ctrlKey: true"); await sleep(200);   // back to CB4's two for CB5
  await onLabel("translate z", "menu");
  const items = await evalJson(`[...document.querySelectorAll('.sp-ctx-item')].map((b) => b.textContent)`);
  await evalJson(`([...document.querySelectorAll('.sp-ctx-item')].find((b) => /reset the 2 selected/.test(b.textContent))?.click(), true)`);
  check("CB5 right-click offers 'reset the 2 selected channels', and it sets both to their defaults (y stays)", items?.some((t: string) => /reset the 2 selected channels/.test(t))
    && await waitDisk(() => { const p = disk().entities[N("cuball")].c.transform.pos; return p[0] === 0 && p[2] === 0 && p[1] === 0.25; }), { items, pos: disk().entities[N("cuball")].c.transform.pos });
  // the reset keys follow the tools' letters (G move, E rotate, R scale): Alt+G / Alt+E / Alt+R, and Ctrl+G for all
  await page(`const n = await import('/lib/net.js'); await n.sendRequest('set', { id: 'cuball', component: 'transform', value: { pos: [3, 0.25, 4], q: [0, 0.3826834, 0, 0.9238795], scale: [0.5, 0.5, 0.5] } }); (await import('/lib/scenegraph.js')).sceneSelect('cuball'); return true;`);
  await sleep(600);
  const key = (code: string, mods: string) => evalJson(`(window.dispatchEvent(new KeyboardEvent('keydown', { code: '${code}', key: '${code.slice(3).toLowerCase()}', bubbles: true, cancelable: true, ${mods} })), true)`);
  const tr = () => disk().entities[N("cuball")].c.transform;
  const chans = await evalJson(`Promise.all([import('/lib/inspect.js'), import('/shared/editschema.js')]).then(([i, e]) => e.channels(i.schemaFor('cuball')).map((c) => c.key))`);
  const n0 = entries().length;
  await key("KeyG", "altKey: true");
  check("CB6 Alt+G resets translate alone (rotate and scale stay), in ONE act", await waitDisk(() => tr().pos.every((v: number) => v === 0)) && tr().scale?.[0] === 0.5 && Math.abs((tr().q?.[1] ?? 0) - 0.3826834) < 1e-6 && entries().length - n0 <= 2, { tr: tr(), chans, acts: entries().length - n0 });
  await key("KeyE", "altKey: true");
  check("CB7 Alt+E resets rotate", await waitDisk(() => { const q = tr().q; return !q || (Math.abs(q[1]) < 1e-9 && Math.abs(Math.abs(q[3]) - 1) < 1e-9) ; }) && tr().scale?.[0] === 0.5, tr());
  await key("KeyR", "altKey: true");
  check("CB8 Alt+R resets scale", await waitDisk(() => { const s = tr().scale; return s === undefined || s === 1 || (Array.isArray(s) && s.every((v: number) => v === 1)); }), tr());
  await page(`const n = await import('/lib/net.js'); await n.sendRequest('set', { id: 'cuball', component: 'transform', value: { pos: [3, 0.25, 4], q: [0, 0.3826834, 0, 0.9238795], scale: [0.5, 0.5, 0.5] } }); return true;`);
  await sleep(600);
  await key("KeyG", "ctrlKey: true");
  check("CB9 Ctrl+G resets all three at once", await waitDisk(() => { const t = tr(), s = t.scale, q = t.q; return t.pos.every((v: number) => v === 0) && (!q || Math.abs(q[1]) < 1e-9) && (s === undefined || s === 1 || (Array.isArray(s) && s.every((v: number) => v === 1))); }), tr());
  await evalJson(`import('/lib/build.js').then((m) => (m.setEditMode(false), true))`);
  });
  // ---- VM: the Viewport menu (R, 10-10: isolate selected, wireframe, flat shaded) ----
  await stage("VM", async () => {
  await evalJson(`import('/lib/build.js').then((m) => (m.setEditMode(true), true))`);
  await page(`(await import('/lib/scenegraph.js')).sceneSelect('cuball'); return true;`); await sleep(300);
  const vis = () => evalJson(`import('/lib/world.js').then((w) => ({ cuball: w.entities.get('cuball')?.visible, anchor: w.entities.get('anchor')?.visible, gate: w.entities.get('gate')?.visible }))`);
  const pickV = async (word: string) => { await evalJson(`(document.querySelector('.edit-menu[data-menu="viewport"] .edit-btn').click(), true)`); await sleep(150);
    const items = await evalJson(`[...document.querySelectorAll('.edit-menu[data-menu="viewport"] .edit-menu-item')].map((b) => b.textContent)`);
    await evalJson(`([...document.querySelectorAll('.edit-menu[data-menu="viewport"] .edit-menu-item')].find((b) => b.textContent.includes('${word}'))?.click(), true)`); await sleep(300); return items; };
  const v0 = await vis(); const items = await pickV("isolate selected"); const v1 = await vis();
  check("VM1 Viewport ▸ isolate selected: only the selection is drawn (in my view)", items?.length === 5 && v0.anchor && v0.gate && v1.cuball && v1.anchor === false && v1.gate === false, { items, v0, v1 });
  const after = await pickV("isolate selected"); const v2 = await vis();
  check("VM2 …it shows as ticked, and choosing it again brings everything back", /✓ isolate/.test(after?.[0] ?? "") && v2.anchor && v2.gate, { after, v2 });
  await pickV("flat shaded");
  const flat = await evalJson(`import('/lib/core.js').then((c) => ({ over: !!c.scene.overrideMaterial, flat: c.scene.overrideMaterial?.flatShading === true }))`);
  await pickV("wireframe");
  const wire = await evalJson(`import('/lib/core.js').then((c) => ({ wire: c.scene.overrideMaterial?.wireframe === true }))`);
  const bar = await evalJson(`(() => { const b = document.querySelector('.edit-viewbar'), t = document.querySelector('.edit-top'), L = document.querySelector('[data-frame="hierarchy"]')?.getBoundingClientRect(), R = document.querySelector('[data-frame="inspector"]')?.getBoundingClientRect(); if (!b) return null; const r = b.getBoundingClientRect();
    return { has: ['.edit-camsw', '.edit-menu[data-menu="viewport"]', '.edit-vbtn[data-view="wire"]'].map((q) => !!b.querySelector(q)), inTop: !!t?.querySelector('.edit-camsw, .edit-menu[data-menu="viewport"]'), between: !!L && !!R && r.left >= L.right - 2 && r.right <= R.left + 2, layout: [...document.querySelectorAll('.edit-top .edit-menu > .edit-btn')].map((x) => x.textContent) }; })()`);
  check("VM2b Body | Free, Viewport and wireframe sit in a bar ON the viewport, between the two columns, not in the top bar; the top bar's menu is 'Layout'", bar?.has.every(Boolean) && !bar.inTop && bar.between && bar.layout.some((t: string) => /^Layout/.test(t)) && !bar.layout.some((t: string) => /^View\b/.test(t)), bar);
  check("VM3 flat shaded and wireframe draw the scene through one override material", flat?.flat && wire?.wire, { flat, wire });
  await pickV("isolate selected");
  await evalJson(`import('/lib/build.js').then((m) => (m.setEditMode(false), true))`); await sleep(300);
  const out = await evalJson(`Promise.all([import('/lib/core.js'), import('/lib/world.js')]).then(([c, w]) => ({ over: !!c.scene.overrideMaterial, anchor: w.entities.get('anchor')?.visible }))`);
  check("VM4 leaving edit mode puts the view back: no override, nothing isolated away", out && !out.over && out.anchor, out);
  });
  // ---- FC: the free camera (R, 10-10: Body | Free on the top line; WASD flies it; the body holds an "I'm working" pose;
  // B steps back into the body and keeps the spot; Body resets) ----
  await stage("FC", async () => {
  await evalJson(`import('/lib/build.js').then((m) => (m.setEditMode(true), true))`); await sleep(300);
  const st = () => evalJson(`Promise.all([import('/lib/controller.js'), import('/lib/core.js')]).then(([c, k]) => ({ free: c.isFreeCam(), focus: c.freeCamState().focus, body: c.myState.pos.toArray(), pose: !!c.myState.pose, cam: k.camera.position.toArray(), sw: [...document.querySelectorAll('.edit-camsw .edit-cam.on')].map((b) => b.dataset.cam) }))`);
  const hold = async (code: string, ms: number) => { await evalJson(`(window.dispatchEvent(new KeyboardEvent('keydown', { code: '${code}', bubbles: true })), true)`); await sleep(ms); await evalJson(`(window.dispatchEvent(new KeyboardEvent('keyup', { code: '${code}', bubbles: true })), true)`); };
  const s0 = await st();
  await evalJson(`(document.querySelector('.edit-camsw .edit-cam[data-cam="free"]').click(), true)`); await sleep(500);
  const s1 = await st();
  if (process.env.SHOT_DIR) { const r = await cdp.send<any>("Page.captureScreenshot", { format: "png" }); fs.writeFileSync(`${process.env.SHOT_DIR}/freecam-pose.png`, Buffer.from(r.data, "base64")); }
  // the pose, measured (the bench has no GPU to look with): both hands in front of the chest, below the shoulders, above the hips
  const limbs = await page(`const { getMe } = await import('/lib/mybody.js'); const me = getMe(); const T = (await import('/lib/core.js')).THREE; me.root.updateMatrixWorld(true); me.update?.(0);
    const h = me.vrm.humanoid, at = (b) => { const n = h.getNormalizedBoneNode(b); n.updateWorldMatrix(true, false); return n.getWorldPosition(new T.Vector3()); };
    const yaw = me.root.rotation.y, f = new T.Vector3(Math.sin(yaw), 0, Math.cos(yaw)), hips = at('hips');
    const rel = (b) => { const p = at(b).sub(hips); return { fwd: +p.dot(f).toFixed(2), up: +p.y.toFixed(2), side: +p.dot(new T.Vector3(f.z, 0, -f.x)).toFixed(2) }; };
    const palm = (b, sgn) => { const n = h.getNormalizedBoneNode(b); n.updateWorldMatrix(true, false); const d = new T.Vector3(0, -1, 0).transformDirection(n.matrixWorld); return +d.dot(f).toFixed(2); };
    return { leftHand: rel('leftHand'), rightHand: rel('rightHand'), leftShoulder: rel('leftUpperArm'), head: rel('head'), palmOut: [palm('leftHand'), palm('rightHand')] };`);
  check("FC1b the working pose (a mage casting): both hands well out in front, below the shoulders, on their own sides, palms facing out", limbs && limbs.leftHand.fwd > 0.35 && limbs.rightHand.fwd > 0.35 && limbs.palmOut[0] > 0.6 && limbs.palmOut[1] > 0.6 && limbs.leftHand.up > 0.05 && limbs.leftHand.up < limbs.leftShoulder.up && limbs.rightHand.up < limbs.leftShoulder.up && limbs.leftHand.side * limbs.rightHand.side < 0, limbs);
  check("FC1 the Free switch: the camera is its own, the switch shows it, and my body holds a pose", s0.sw.join() === "body" && s1.free && s1.sw.join() === "free" && s1.pose && !s0.pose, { s0, s1 });
  await hold("KeyW", 700); const s2 = await st();
  const d = (a: number[], b: number[]) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  check("FC2 W flies the camera's centre; my body stays where it stood", d(s2.focus, s1.focus) > 1 && d(s2.body, s1.body) < 1e-6 && s2.pose, { moved: d(s2.focus, s1.focus), body: d(s2.body, s1.body) });
  await evalJson(`import('/lib/build.js').then((m) => (m.setEditMode(false), true))`); await sleep(600);
  const s3 = await st();
  check("FC3 B (leaving edit mode) puts the view back on my body at once, and the pose ends", !s3.free && !s3.pose && d(s3.cam, s3.body) < 17, s3);
  await evalJson(`import('/lib/build.js').then((m) => (m.setEditMode(true), true))`); await sleep(600);
  const s4 = await st();
  check("FC4 B again returns to where I left the camera, pose and all", s4.free && s4.pose && d(s4.focus, s2.focus) < 1e-6, { s4: s4.focus, s2: s2.focus });
  await evalJson(`(document.querySelector('.edit-camsw .edit-cam[data-cam="body"]').click(), true)`); await sleep(400);
  const s5 = await st();
  check("FC5 the Body switch is the reset: the camera is my body's again, the pose ends", !s5.free && !s5.pose && s5.sw.join() === "body", s5);
  await evalJson(`import('/lib/build.js').then((m) => (m.setEditMode(false), true))`);
  });
  // ---- RB: a row's menu as a button, for where there is no right-click (R, 10-10: "buttons in VR to the right of
  // anywhere that would get a right-click menu, hidden on desktop") ----
  await stage("RB", async () => {
  await evalJson(`import('/lib/build.js').then((m) => (m.setEditMode(true), true))`);
  await page(`(await import('/lib/scenegraph.js')).sceneSelect('cuball'); return true;`); await sleep(500);
  const r = await evalJson(`(() => { const I = document.querySelector('[data-frame="inspector"]'), H = document.querySelector('[data-frame="hierarchy"]');
    const row = [...I.querySelectorAll('.sp-row.sp-f-num')].find((x) => /^scale x/.test(x.querySelector('.sp-label')?.textContent ?? '')), b = row?.querySelector('.sp-ctxbtn');
    const hb = [...H.querySelectorAll('.sp-tree-row')].find((x) => x.dataset.id === 'cuball')?.querySelector('.sp-ctxbtn');
    const probe = document.createElement('div'); const had = document.getElementById('xr-stage'); if (!had) probe.id = 'xr-stage'; (had ?? document.body).appendChild(probe);
    const c = document.createElement('button'); c.className = 'sp-ctxbtn'; probe.appendChild(c); const staged = getComputedStyle(c).display; probe.remove();
    return { field: !!b, fieldShown: b ? getComputedStyle(b).display : null, tree: !!hb, treeShown: hb ? getComputedStyle(hb).display : null, staged }; })()`);
  check("RB1 every row with a menu carries a menu button; on the desktop it isn't drawn; on a headset-staged frame it is", r?.field && r.tree && r.fieldShown === "none" && r.treeShown === "none" && r.staged === "inline-flex", r);
  await evalJson(`(() => { const I = document.querySelector('[data-frame="inspector"]'); [...I.querySelectorAll('.sp-row.sp-f-num')].find((x) => /^scale x/.test(x.querySelector('.sp-label')?.textContent ?? ''))?.querySelector('.sp-ctxbtn')?.click(); return true; })()`);
  const fm = await evalJson(`[...document.querySelectorAll('.sp-ctx-item')].map((b) => b.textContent)`);
  await evalJson(`(document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })), true)`);
  await evalJson(`([...document.querySelector('[data-frame="hierarchy"]').querySelectorAll('.sp-tree-row')].find((x) => x.dataset.id === 'cuball')?.querySelector('.sp-ctxbtn')?.click(), true)`);
  const tm = await evalJson(`[...document.querySelectorAll('.sp-ctx-item')].map((b) => b.textContent)`);
  await evalJson(`(document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })), true)`);
  check("RB2 the button opens the row's own menu: a field's (copy value…), a thing's (rename, duplicate…)", fm?.some((t: string) => /copy value/.test(t)) && tm?.some((t: string) => /^rename/.test(t)) && tm?.some((t: string) => /^duplicate/.test(t)), { fm, tm });
  await evalJson(`import('/lib/build.js').then((m) => (m.setEditMode(false), true))`);
  });
  // ---- NP: a request in flight when the connection drops (review 10-10: pending requests were settled only by their
  // 15 s timer, so a move in flight at a reconnect held the body track for up to 15 s, then spoke a stale timeout) ----
  await stage("NP", async () => {
  const r = await page(`const n = await import('/lib/net.js'); const ws = n.net.ws, send = ws.send.bind(ws);
    ws.send = (m) => { if (!/"verb":"look"/.test(m)) send(m); };   // this one request never reaches the authority
    const t0 = performance.now(); const p = n.sendRequest('look', {}); setTimeout(() => ws.close(), 300);
    const out = await Promise.race([p, new Promise((z) => setTimeout(() => z('still waiting at 2 s'), 2000))]);
    return { out, ms: Math.round(performance.now() - t0) };`);
  check("NP1 a request in flight when the socket drops is answered at once (offline), not 15 s later", r?.out?.ok === false && r?.out?.refused?.code === "offline" && r.ms < 1500, r);
  check("NP2 …and the client reconnects", await waitFor(`import('/lib/net.js').then((m) => m.net.joined)`, 15000));
  });
  check("errors: no page error", await evalJson(`__errs.length === 0`), await evalJson(`__errs`));
} catch (e) { check("the run threw", false, String(e?.stack ?? e)); }
console.log(`[shiplist-probe] ${tally.passed} passed, ${tally.failed} failed`);
await cleanup(tally.failed ? 1 : 0);
process.exit(tally.failed ? 1 : 0);
