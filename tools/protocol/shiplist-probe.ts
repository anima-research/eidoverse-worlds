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
  });
  check("errors: no page error", await evalJson(`__errs.length === 0`), await evalJson(`__errs`));
} catch (e) { check("the run threw", false, String(e?.stack ?? e)); }
console.log(`[shiplist-probe] ${tally.passed} passed, ${tally.failed} failed`);
await cleanup(tally.failed ? 1 : 0);
process.exit(tally.failed ? 1 : 0);
