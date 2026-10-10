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
const { cdp, evalJson, cleanup, die, BASE } = await scratchBench("shiplist", {
  prepare: (scratch) => {
    worldsDir = path.join(scratch, "worlds"); fs.mkdirSync(worldsDir, { recursive: true });
    const r = Bun.spawnSync(["bun", "tools/protocol/world.ts", "found", WORLD, "--owner", ME, "--title", "ship list probe"], { cwd: ENGINE, env: { ...process.env, WORLDS_DIR: worldsDir, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" } });
    if (r.exitCode !== 0) throw new Error("founding failed: " + r.stderr.toString());
  },
});
const { check: check0, tally } = mkCheck();
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
  const stage = async (id: string, fn: () => Promise<void>) => { try { await fn(); } catch (e) { check(`${id} (the stage threw)`, false, String(e?.message ?? e)); } };
  // ---- D: the authority, as a desktop visitor meets it ----
  const me = await evalJson(`import('/lib/controller.js').then((m) => m.myState.pos.toArray())`);
  const at = [me[0] + 1.2, me[2]];
  await stage("D", async () => {
  const made = await page(`const m = await import('/lib/net.js'); return await m.sendRequest('create', { id: 'gate', model: '${CRATE}', components: { label: 'Gate', pivot: { pos: [-0.5, 0, 0] }, openable: { open: false, locked: false, angle: ${Math.PI / 2}, time: 1.2 }, reactions: { open: { kind: 'toggle', unless: 'locked' } }, transform: { pos: [${at[0]}, ${me[1]}, ${at[1]}], q: [0, 0, 0, 1], scale: [1, 1, 1] } } });`);
  check("(setup) a gate beside me (openable + its open action)", made?.ok, made);
  await waitFor(`import('/lib/world.js').then((m) => m.entities.has('gate') && !!m.entities.get('gate').userData.base)`);
  check("D1 the hint bar offers it: E open “Gate”", await waitFor(`/E\\s*open\\s*“Gate”/.test(${hint})`, 6000), await evalJson(hint));
  const q0 = await evalJson(`import('/lib/world.js').then((m) => m.entities.get('gate').quaternion.toArray())`);
  const uses0 = entries().filter((e: any) => e.kind === "act" && e.verb === "use").length;
  // an in-page sampler (CDP round trips are too slow to time a 1.2 s swing): how open the tween says, and the angle the
  // gate is DRAWN at, every 40 ms for 4 s from just before E
  await evalJson(`(window.__samp = (async () => { const [o, w] = await Promise.all([import('/lib/openable.js'), import('/lib/world.js')]); const out = []; const t0 = performance.now();
    while (performance.now() - t0 < 4000) { const s = o.openableState('gate'); const q = w.entities.get('gate').quaternion; out.push([Math.round(performance.now() - t0), s?.f ?? null, s?.to ?? null, 2 * Math.acos(Math.min(1, Math.abs(q.w)))]); await new Promise((r) => setTimeout(r, 40)); }
    return out; })(), true)`);
  await key("KeyE");
  check("D2 E opens it through the authority: one use act, openable.open = true", await waitDisk(() => disk().entities.gate?.c.openable?.open === true && entries().filter((e: any) => e.kind === "act" && e.verb === "use").length === uses0 + 1),
    { open: disk().entities.gate?.c.openable, refused: await evalJson(`__refused.map((r) => r.text)`) });
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
  check("D5 E closes it", await waitDisk(() => disk().entities.gate?.c.openable?.open === false));
  await sleep(1600);
  const q2 = await evalJson(`import('/lib/world.js').then((m) => m.entities.get('gate').quaternion.toArray())`);
  check("D6 …and it's drawn shut again where it stood", Math.abs(Math.abs(q0[0] * q2[0] + q0[1] * q2[1] + q0[2] * q2[2] + q0[3] * q2[3]) - 1) < 1e-4, { q0, q2 });

  });
  // ---- F: a refusal, in a person's words ----
  await stage("F", async () => {
  await page(`const m = await import('/lib/net.js'); return await m.sendRequest('create', { id: 'box1', model: '${CRATE}', components: { label: 'Toy box' }, place: { at: [${at[0] + 3}, ${at[1]}] } });`);
  const r0 = await evalJson(`__refused.length`);
  await page(`const e = await import('/lib/editwrites.js'); return (await e.send({ verb: 'set', args: { id: 'box1', component: 'reactions', value: { open: { kind: 'toggle' } } } }, { what: 'change box1' })).ok;`);
  check("F1 a refusal is shown", await waitFor(`__refused.length > ${r0}`));
  const f = await evalJson(`__refused.at(-1)`);
  check("F2 …in a person's words: what and why, the thing by its label, no refusal code, no tool syntax, no ids", f && /^Couldn't change “Toy box”/.test(f.text) && !/no-target|\{|box1|openable \{/.test(f.text) && /\(no-target\)/.test(f.agentText ?? ""), f);
  check("F3 …the same words on screen (a toast)", await waitFor(`[...document.querySelectorAll('.toast')].some((t) => t.textContent.includes("Couldn't change “Toy box”"))`, 3000));

  });
  // ---- W: a warning, shown ----
  await stage("W", async () => {
  const w0 = await evalJson(`__warned.length`);
  await page(`const e = await import('/lib/editwrites.js'); return (await e.send({ verb: 'create', args: { id: 'cloud', model: '${CRATE}', components: { label: 'Floating crate', transform: { pos: [${at[0] + 5}, 1.5, ${at[1]}], q: [0, 0, 0, 1], scale: [1, 1, 1] } } } }, { what: 'place a crate' })).ok;`);
  check("W1 a write the authority warns about shows the warning, by label", await waitFor(`__warned.length > ${w0} && /“Floating crate” floats/.test(__warned.at(-1).text)`, 5000), await evalJson(`__warned.at(-1) ?? null`));
  check("W2 …on screen (a toast)", await waitFor(`[...document.querySelectorAll('.toast')].some((t) => /Done, but “Floating crate”/.test(t.textContent))`, 3000));

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
  await waitFor(`import('/lib/world.js').then((m) => m.entities.has('anchor'))`);
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
  await waitFor(`import('/lib/world.js').then((m) => m.entities.has('crate-2') && m.entities.has('crate-3'))`);
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
  check("E2 'hinge on its right edge' puts its pivot on the +x edge of its box (one act)", clicked && await waitDisk(() => (disk().entities.gate?.c.pivot?.pos?.[0] ?? -1) > 0.2), { clicked, pivot: disk().entities.gate?.c.pivot });
  await page(`(await import('/lib/scenegraph.js')).sceneSelect('box1'); return true;`);
  await waitFor(`import('/lib/scenegraph.js').then((m) => m.sceneSelected() === 'box1')`); await sleep(400);
  await evalJson(`${insp}.querySelector('.sp-pop-btn').click(), true`);
  await waitFor(`!!document.querySelector('.sp-pop-search')`);
  const all = await evalJson(`[...document.querySelectorAll('.sp-pop-item')].map((b) => b.textContent)`);
  await evalJson(`(() => { const i = document.querySelector('.sp-pop-search'); i.value = 'door'; i.dispatchEvent(new Event('input')); return true; })()`);
  const items = await evalJson(`[...document.querySelectorAll('.sp-pop-item')].map((b) => b.textContent)`);
  check("E3 Add Component offers Path and LookAt (what the authority takes: look-at since batch 2), and 'door' finds Openable", all?.some((t: string) => /^Path/.test(t)) && all?.some((t: string) => /^LookAt/.test(t)) && items?.some((t: string) => /Openable/.test(t)), { all, items });
  await evalJson(`[...document.querySelectorAll('.sp-pop-item')].find((b) => /Openable/.test(b.textContent))?.click(), true`);
  check("E4 …adding it writes its state and its open action: the toy box opens with E", await waitDisk(() => disk().entities.box1?.c.openable?.open === false && disk().entities.box1?.c.reactions?.open?.kind === "toggle"), { c: disk().entities.box1?.c });
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
  const re = await waitFor(`import('/lib/thingphysics.js').then((m) => m.physicsApi.body().arrived)`, 1500);
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
  await waitFor(`import('/lib/world.js').then((m) => m.entities.has('cuball'))`);
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
  check("CU1 a press that travels 60 px is a drag (the camera's), not a click: nothing is picked up", at0?.onScreen && !(await holds())?.includes("cuball"), { at0, holds: await holds() });
  await click(2);
  const menu = await waitFor(`!!document.querySelector('.sp-ctx')`, 2000), items = await evalJson(`[...document.querySelectorAll('.sp-ctx-item')].map((b) => b.textContent)`);
  check("CU2 right-click on it opens its menu: pick up first, kick among the rest", menu && /^pick up/.test(items?.[0] ?? "") && items?.some((t: string) => /^kick/.test(t)), items);
  await evalJson(`(document.querySelector('.sp-ctx-item')?.click(), true)`);
  check("CU3 …and choosing 'pick up' there picks it up", await waitFor(`import('/lib/thingphysics.js').then((m) => m.physicsApi.mine().includes('cuball'))`, 4000), { holds: await holds(), said: await evalJson(`__phys.slice(-2)`) });
  await page(`const m = await import('/lib/thingphysics.js'); await m.physicsApi.put('cuball'); return true;`);
  await waitFor(`import('/lib/thingphysics.js').then((m) => !m.physicsApi.mine().includes('cuball'))`, 4000);
  await sleep(1200);
  await click(0);
  check("CU4 left-click on it is its primary use: I hold it", await waitFor(`import('/lib/thingphysics.js').then((m) => m.physicsApi.mine().includes('cuball'))`, 4000), await holds());
  // letting go (R, holding the wrecking ball: "left-click doesn't drop it and there's no help option to assist me")
  await sleep(800);
  const hint = await waitFor(`/holding/.test(document.body.innerText) && /put it down/.test(document.body.innerText)`, 3000);
  check("CU5 while I hold it the hint bar says so, and how to let go", hint, await evalJson(`[...document.querySelectorAll('*')].filter((e) => !e.children.length && /holding|pick up/.test(e.textContent)).map((e) => e.textContent).slice(0, 3)`));
  // a click on NOTHING (in third person my own body hides what I hold): scan for a pixel no usable thing is under
  const bare = await page(`const c = await import('/lib/core.js'), cu = await import('/lib/clickuse.js'); const r = c.canvas.getBoundingClientRect(); let at = null;
    for (let gy = 1; gy < 12 && !at; gy++) for (let gx = 1; gx < 16 && !at; gx++) { const x = r.left + r.width * gx / 16, y = r.top + r.height * gy / 12; if (cu.thingAt(x, y) === null) at = [x, y]; }
    if (!at) return null;
    const ev = (t) => new MouseEvent(t, { bubbles: true, cancelable: true, button: 0, clientX: at[0], clientY: at[1] });
    c.canvas.dispatchEvent(ev('mousedown')); c.canvas.dispatchEvent(ev('mouseup')); return at;`);
  check("CU6 holding it, a left-click on nothing puts it down", bare && await waitFor(`import('/lib/thingphysics.js').then((m) => !m.physicsApi.mine().includes('cuball'))`, 4000), { bare, holds: await holds() });
  await sleep(1500);
  await click(0);
  await waitFor(`import('/lib/thingphysics.js').then((m) => m.physicsApi.mine().includes('cuball'))`, 4000); await sleep(800);
  await click(0);
  check("CU7 …and so does a left-click on the thing itself", await waitFor(`import('/lib/thingphysics.js').then((m) => !m.physicsApi.mine().includes('cuball'))`, 4000), await holds());
  });
  // ---- EC: the camera in edit mode (R, 10-10: "we need camera moving controls in edit mode ... Blender or Maya ... or
  // left-click hold and move wherever there's a bare space (not even this last one works)") ----
  await stage("EC", async () => {
  await evalJson(`import('/lib/build.js').then((m) => (m.setEditMode(true), true))`);
  const cam = () => evalJson(`import('/lib/controller.js').then((c) => ({ yaw: c.camYaw, pitch: c.camPitch, dist: c.camDist, pan: c.editPan.toArray() }))`);
  // a drag: press at (x, y), three moves, release. where: 'cuball' = a pixel on that thing, 'bare' = a pixel no thing is under
  const drag = (where: string, button: number, alt: boolean, mx: number, my: number) => page(`const c = await import('/lib/core.js'), w = await import('/lib/world.js'), T = c.THREE;
    const r = c.canvas.getBoundingClientRect(), R = new T.Raycaster(), all = [...w.entities.values()].filter(Boolean);
    const under = (x, y) => { R.setFromCamera(new T.Vector2(((x - r.left) / r.width) * 2 - 1, -((y - r.top) / r.height) * 2 + 1), c.camera); let o = R.intersectObjects(all, true)[0]?.object; while (o && !o.userData.entityId) o = o.parent; return o?.userData.entityId ?? null; };
    let at = null;
    for (let gy = 1; gy < 16 && !at; gy++) for (let gx = 1; gx < 24 && !at; gx++) { const x = r.left + r.width * gx / 24, y = r.top + r.height * gy / 16, u = under(x, y); if (${where === "bare" ? "u === null" : `u === '${where}'`}) at = [x, y]; }
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
  check("EC4 a left-drag on bare space orbits, and keeps what was selected", d4?.at && Math.abs(c4.yaw - c3.yaw) > 0.2 && s0 === "cuball" && s1 === "cuball", { d4, c3, c4, s0, s1 });
  await drag("bare", 0, false, 0, 0);
  check("EC5 …and a left CLICK on bare space (no travel) deselects, as before", (await sel()) === null, await sel());
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
  const w = await evalJson(`(() => { const l = ${H}.querySelector('.sp-list .sp-item-main'); return { label: l?.querySelector('.sp-item-label')?.textContent, icon: !!l?.querySelector('.sp-ico svg'), title: l?.title }; })()`);
  check("HQ1 the World row says which world it is, with the planet icon and a tooltip", /^World: \S/.test(w?.label ?? "") && w?.icon && /world itself/.test(w?.title ?? ""), w);
  const r0 = await row();
  check("HQ2 a row is the name alone; its id and kind are on hover", r0?.label === "Clicker" && r0.sub === null && /id cuball/.test(r0.title), r0);
  const pick = async (k: string) => { await evalJson(`(${H}.querySelector('.sp-pop-btn').click(), true)`); await waitFor(`!!document.querySelector('.sp-pop-item')`, 2000);
    await evalJson(`([...document.querySelectorAll('.sp-pop-item')].find((b) => b.textContent.includes('${k}'))?.click(), true)`); await sleep(400); };
  await pick("show ids");
  const r1 = await row();
  check("HQ3 View ▸ show ids: the row carries its id again", /Clicker\s+\(cuball\)/.test(r1?.label ?? ""), r1);
  await pick("list components");
  const cs = await evalJson(`[...${H}.querySelectorAll('.sp-tree-row')].filter((x) => (x.dataset.id ?? '').startsWith('comp:cuball:')).map((x) => x.querySelector('.sp-item-label').textContent)`);
  check("HQ4 View ▸ list components: its components are rows under it (grabbable, physics)", cs?.includes("grabbable") && cs?.includes("physics") && !cs?.includes("label"), cs);
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
  check("CB3 a drag on the name 'translate x' scrubs its value", +v("translate x", r1)?.v > 7.6 && Math.abs(disk().entities.cuball.c.transform.pos[0] - +v("translate x", r1).v) < 0.01, { face: v("translate x", r1)?.v, disk: disk().entities.cuball.c.transform.pos });
  await onLabel("translate x", "click"); await onLabel("translate z", "click", "ctrlKey: true"); await sleep(200);
  const r2 = await rows();
  check("CB4 a click on a name selects the channel; Ctrl-click adds another", v("translate x", r2)?.sel && v("translate z", r2)?.sel && !v("translate y", r2)?.sel, r2?.filter((r: any) => r.sel).map((r: any) => r.label));
  await onLabel("translate z", "menu");
  const items = await evalJson(`[...document.querySelectorAll('.sp-ctx-item')].map((b) => b.textContent)`);
  await evalJson(`([...document.querySelectorAll('.sp-ctx-item')].find((b) => /reset the 2 selected/.test(b.textContent))?.click(), true)`);
  check("CB5 right-click offers 'reset the 2 selected channels', and it sets both to their defaults (y stays)", items?.some((t: string) => /reset the 2 selected channels/.test(t))
    && await waitDisk(() => { const p = disk().entities.cuball.c.transform.pos; return p[0] === 0 && p[2] === 0 && p[1] === 0.25; }), { items, pos: disk().entities.cuball.c.transform.pos });
  // the reset keys follow the tools' letters (G move, E rotate, R scale): Alt+G / Alt+E / Alt+R, and Ctrl+G for all
  await page(`const n = await import('/lib/net.js'); await n.sendRequest('set', { id: 'cuball', component: 'transform', value: { pos: [3, 0.25, 4], q: [0, 0.3826834, 0, 0.9238795], scale: [0.5, 0.5, 0.5] } }); (await import('/lib/scenegraph.js')).sceneSelect('cuball'); return true;`);
  await sleep(600);
  const key = (code: string, mods: string) => evalJson(`(window.dispatchEvent(new KeyboardEvent('keydown', { code: '${code}', key: '${code.slice(3).toLowerCase()}', bubbles: true, cancelable: true, ${mods} })), true)`);
  const tr = () => disk().entities.cuball.c.transform;
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
