// tools/protocol/xss-probe.ts — security pass 3 (H1, and H2's client half: P) in a real browser (one headless Chromium against a scratch sequencer,
// tools/harness.ts scratchBench; test:protocol runs it under the house guards, like the other browser suites).
//
// The reviewer's exploit: a guest joins named `<img src=x onerror=…>` and knocks over / grabs / poses a visitor on
// DEFAULT settings (pushable defaults true); the status bar rendered the name as HTML and the onerror ran.
//   A   end to end over a raw socket: the hostile name either never gets in (the door refuses it, in words) or, if a
//       name with markup ever reaches the page, nothing it carries runs
//   S   the client's own sinks, independent of the door (the input emulated at its seam, the bus): every presence
//       message that names its sender (knock-over, grab, pose, release, refused drag, broke-free) and the chat
//       lines show a hostile name as TEXT — the literal characters on screen, no element made from them, no script run
//   C   the page runs under a Content-Security-Policy that refuses inline script: an injected inline handler and an
//       injected <script> do not run, and the browser reports the violation
// Every stage asserts its trigger FIRED (the hint/line actually shows the name) before it asserts nothing ran — a check
// whose subject never arrived is not evidence.
// @ts-nocheck
import fs from "node:fs";
import path from "node:path";
import { scratchBench, mkCheck, sleep } from "../harness.ts";
import { pageWaiter } from "./wait.ts";

const WORLD = "xss3";
// the reviewer's payload, and a <svg onload> (fires synchronously on insertion, no network) for the seam stage
const IMG = `<img src=x onerror="window.__xss=(window.__xss||0)+1">`;
const SVG = `<svg onload="window.__xss=(window.__xss||0)+1">`;
const { cdp, evalJson, cleanup, die, BASE } = await scratchBench("xss", { worlds: [WORLD], owner: "owner", cspExpected: true });   // stage C causes violations on purpose; boot asserts none of its own
const { check: check0, tally } = mkCheck();
const check = (name: string, ok: any, detail?: any) => check0(name, !!ok, detail === undefined ? "" : typeof detail === "string" ? detail.slice(0, 600) : (JSON.stringify(detail) ?? "").slice(0, 600));
const waitFor = pageWaiter(evalJson);
const hint = `(document.getElementById('hintbar')?.textContent ?? '')`;
// nothing made from a payload: no element carrying an inline handler anywhere in the document, and the flag unset
const clean = `(window.__xss === undefined && !document.querySelector('[onerror],[onload]'))`;
const stage = async (id: string, fn: () => Promise<void>) => { try { await fn(); } catch (e) { check(`${id} (the stage threw)`, false, String(e?.message ?? e)); } };

function guest(name: string) {
  const ws = new WebSocket(BASE.replace("http", "ws") + "/ws"); const msgs: any[] = [];
  ws.onmessage = (ev) => { try { msgs.push(JSON.parse(String(ev.data))); } catch {} };
  const opened = new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  return { ws, msgs, opened, send: (m: any) => ws.send(JSON.stringify(m)),
    async join() { await opened; ws.send(JSON.stringify({ type: "join", world: WORLD, id: name, avatar: "", replica: true }));
      const t0 = Date.now(); while (Date.now() - t0 < 5000) { const s = msgs.find((m) => m.type === "snapshot"), e = msgs.find((m) => m.type === "error"); if (s || e) return { snap: s, err: e }; await sleep(50); } return {}; } };
}

try {
  await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: `window.__errs = []; addEventListener('error', (e) => __errs.push('error: ' + e.message));
    window.__csp = []; document.addEventListener('securitypolicyviolation', (e) => __csp.push({ dir: e.effectiveDirective, blocked: e.blockedURI, sample: e.sample }));` });
  await cdp.send("Page.navigate", { url: `${BASE}/?name=Victim&world=${WORLD}` });   // a guest, default settings
  let secs = 0; for (let i = 0; i < 160 && secs < 4; i++) { secs = (await evalJson(`document.querySelectorAll('.sec').length`).catch(() => 0)) ?? 0; if (secs < 4) await sleep(500); }
  check("boot: the client comes up", secs >= 4, `${secs} sections`);
  if (secs < 4) await die(1, "the page never booted");
  await evalJson(`(() => { const s = document.querySelector('#splash'); if (s) s.style.pointerEvents = 'none'; return true; })()`);
  check("boot: a world", await waitFor(`import('/lib/net.js').then((m) => m.replicaActive())`));
  // R 10-12: nobody is shove-able by default (3b84e149). The exploit under test is the HTML-rendered NAME, which needs the
  // knock to land — so the victim opts in explicitly below; the default itself is asserted first.
  check("boot: default settings — the body accepts (recut A2, 10-20: permissive default; worlds and people narrow it)", (await evalJson(`import('/lib/consent.js').then((m) => m.pushable())`)));
  await evalJson(`import('/lib/consent.js').then((m) => (m.setPushable?.(true), true)).catch(() => true)`);
  check("boot: the victim opted in to being knocked over", await evalJson(`import('/lib/consent.js').then((m) => m.pushable())`));
  const me = await evalJson(`import('/lib/base.js').then((m) => m.CONFIG.name)`);
  check("boot: my body is in (a knock-over needs one)", await waitFor(`import('/lib/mybody.js').then((m) => !!m.getMe())`, 30000));
  check("boot: no CSP violation from the client itself", (await evalJson(`__csp`)).length === 0, await evalJson(`__csp`));

  // ---- A: the reviewer's exploit, end to end ----
  await stage("A", async () => {
    const eve = guest(IMG);
    const { snap, err } = await eve.join();
    if (err) {
      check("A1 the door refuses a name with markup in it, in words a person reads", /name/i.test(err.error) && !/[{}]|code/.test(err.error), err);
      check("A2 …and nothing reached the page", await evalJson(clean), await evalJson(`({ xss: window.__xss, hint: ${hint} })`));
      return;
    }
    check("A1 (the door let the name in) the attacker joined", !!snap);
    await sleep(600);
    eve.send({ type: "puppet", target: me, ragdoll: true });
    check("A2 the knock-over reached the victim (the hint names the attacker, as text)", await waitFor(`${hint}.includes(${JSON.stringify(IMG + " knocked you over")})`, 5000), { hint: await evalJson(hint), me, eve: eve.msgs.filter((m) => m.type === "error" || m.type === "arrive").slice(0, 6) });
    eve.send({ type: "bodydrag", target: me, grab: { joint: "hips" } });
    check("A3 the grab reached the victim (as text)", await waitFor(`${hint}.includes(${JSON.stringify(IMG + " grabs you")})`, 5000), await evalJson(hint));
    await sleep(800);   // an <img onerror> fires after its (failed) load
    check("A4 nothing the name carried ran", await evalJson(clean), await evalJson(`({ xss: window.__xss, hint: document.getElementById('hintbar')?.innerHTML })`));
    eve.ws.close();
  });

  // ---- S: every sink that shows a sender's name, fed at the bus (no door in the way) ----
  await stage("S", async () => {
    const emit = (ev: string, msg: any) => evalJson(`import('/lib/base.js').then((m) => (m.bus.emit(${JSON.stringify(ev)}, ${JSON.stringify(msg)}), true))`);
    // stand up first (a previous stage may have left us limp)
    await evalJson(`import('/lib/localbody.js').then((m) => (m.getUp?.(), true)).catch(() => true)`);
    const cases: [string, string, any, string][] = [
      ["S1 knock-over", "puppet", { by: SVG, ragdoll: true }, "knocked you over"],
      ["S2 grab", "bodydrag", { by: SVG, grab: { joint: "hips" } }, "grabs you"],
      ["S3 pose", "puppet", { by: SVG, pose: { head: [0, 0, 0, 1] } }, "posed you"],
      ["S4 release", "puppet", { by: SVG, pose: {} }, "released your pose"],
    ];
    await evalJson(`import('/lib/consent.js').then((m) => (m.setPosable?.(true), true)).catch(() => true)`);
    for (const [name, ev, msg, words] of cases) {
      await emit(ev, msg);
      const fired = await waitFor(`${hint}.includes(${JSON.stringify(words)})`, 3000);
      check(`${name}: the hint shows the name as text`, fired && await evalJson(`${hint}.includes(${JSON.stringify(SVG)})`), await evalJson(`document.getElementById('hintbar')?.innerHTML`));
      check(`${name}: …and nothing ran`, await evalJson(clean), await evalJson(`window.__xss`));
    }
    // Until 10-20 the client refused a drag itself and toasted "<by> tried to drag you"; the authority is now the one decider
    // (#260 recut A1), so with my switch off an arriving grab raises no client refusal at all (S1/S2 already pin the names
    // the remaining hints show as text).
    await evalJson(`import('/lib/consent.js').then((m) => (m.setPushable?.(false), true)).catch(() => true)`);
    await emit("bodydrag", { by: SVG, grab: { joint: "hips" } }); await sleep(800);
    check("S5 no client-side refusal toast: the authority decided before it arrived", !(await evalJson(`[...document.querySelectorAll('.toast')].some((t) => t.textContent.includes('tried to drag you'))`)) && await evalJson(clean));
    await evalJson(`import('/lib/consent.js').then((m) => (m.setPushable?.(true), true)).catch(() => true)`);
    // the chat log (a whisper line too, until whisper was removed, R 10-18)
    await evalJson(`import('/lib/chat.js').then((m) => (m.logChat(${JSON.stringify(SVG)}, 'hello ' + ${JSON.stringify(SVG)}), true))`);
    check("S6 a chat line shows the name and words as text", await waitFor(`(document.getElementById('chatlog')?.textContent ?? '').includes('hello ' + ${JSON.stringify(SVG)})`, 3000));
    await sleep(300);
    check("S7 after all of it, nothing ran", await evalJson(clean), await evalJson(`({ xss: window.__xss, tags: [...document.querySelectorAll('[onerror],[onload]')].map((e) => e.outerHTML.slice(0, 120)) })`));
  });

  // ---- M: our own markup still renders as markup (text-by-default must not flatten <kbd>) ----
  await stage("M", async () => {
    await evalJson(`import('/lib/ui.js').then((m) => (m.flashHint(m.html\`press <kbd>M</kbd> for \${'<b>x</b>'}\`), true))`);
    check("M1 html`` renders its literal markup and escapes its value", await waitFor(`(() => { const h = document.getElementById('hintbar'); return !!h.querySelector('kbd') && !h.querySelector('b') && h.textContent === 'press M for <b>x</b>'; })()`, 2000),
      await evalJson(`document.getElementById('hintbar')?.innerHTML`));
    await evalJson(`import('/lib/base.js').then((m) => (m.bus.emit('esc-quiet', 'closed'), true))`);
    check("M2 a built-in hint (the panels were put away) still shows its key — Tab brings them back (R 10-11)", await waitFor(`!!document.getElementById('hintbar').querySelector('kbd') && /Tab/.test(document.getElementById('hintbar').textContent)`, 2000));
    await evalJson(`import('/lib/base.js').then((m) => (m.bus.emit('esc-quiet', 'restored'), true))`);
  });

  // ---- R: what the client legitimately does still runs under the policy ----
  await stage("R", async () => {
    const before = (await evalJson(`__csp`)).length;
    for (const mod of ["terrain.js", "particles.js", "sky_worlds.js"])
      check(`R1 the eval-hosted toolkit module ${mod} loads`, await evalJson(`import('/lib/assets.js').then((m) => m.loadEidoModule('${mod}')).then(() => true, (e) => String(e))`) === true);
    // a draco-compressed GLB (as the store's optimize pass makes them) decodes with the self-hosted decoder: its wrapper
    // and wasm fetched from this server, its worker a blob:, its wasm compiled under the policy
    const { Document, NodeIO } = await import("@gltf-transform/core");
    const { KHRDracoMeshCompression } = await import("@gltf-transform/extensions");
    const draco3d = (await import("draco3dgltf")).default;
    const doc = new Document(); const buf = doc.createBuffer();
    const P = [], I = []; for (let i = 0; i < 16; i++) { const a = i / 16 * Math.PI * 2; P.push(Math.cos(a), Math.sin(a), 0); } P.push(0, 0, 0);
    for (let i = 0; i < 16; i++) I.push(16, i, (i + 1) % 16);
    const prim = doc.createPrimitive().setAttribute("POSITION", doc.createAccessor().setType("VEC3").setArray(new Float32Array(P)).setBuffer(buf))
      .setIndices(doc.createAccessor().setType("SCALAR").setArray(new Uint16Array(I)).setBuffer(buf));
    doc.createScene().addChild(doc.createNode("disc").setMesh(doc.createMesh().addPrimitive(prim)));
    doc.createExtension(KHRDracoMeshCompression).setRequired(true).setEncoderOptions({});
    const glb = await new NodeIO().registerExtensions([KHRDracoMeshCompression]).registerDependencies({ "draco3d.encoder": await draco3d.createEncoderModule(), "draco3d.decoder": await draco3d.createDecoderModule() }).writeBinary(doc);
    check("(setup) the GLB really is draco-compressed", Buffer.from(glb).includes("KHR_draco_mesh_compression"));
    const b64 = Buffer.from(glb).toString("base64");
    const dec = await evalJson(`(async () => { const b = Uint8Array.from(atob('${b64}'), (c) => c.charCodeAt(0)); const s = await globalThis.loadGLBBytes(b.buffer);
      let n = 0; s.traverse((o) => { if (o.isMesh) n += o.geometry.attributes.position.count; }); return n; })().catch((e) => String(e))`);
    check("R2 a draco GLB decodes with the decoder this server serves (no third-party origin)", dec === 17, dec);
    check("R3 …and none of it broke the policy", (await evalJson(`__csp`)).length === before, (await evalJson(`__csp`)).slice(before));
  });

  // ---- D: code that only holds EW can't plant a mod that outlives it (the world-mods note; client/lib/mods.js) ----
  await stage("D", async () => {
    const stored = `import('/lib/mods.js').then((m) => m.modsApi.list()).then((l) => l.map((s) => s.name))`;
    const r1 = await evalJson(`(async () => { try { await EW.mods.put({ name: 'planted', auto: true, source: 'window.__planted = 1' }); return 'stored'; } catch (e) { return String(e.message); } })()`);
    check("D1 EW.mods.put from code with no click behind it is refused (and says why)", /needs a click/.test(r1) && !(await evalJson(stored)).includes("planted"), r1);
    const r2 = await evalJson(`(async () => { try { await EW.mods.run('planted', 'window.__planted = 1'); return 'ran'; } catch (e) { return String(e.message); } })()`);
    check("D2 …and EW.mods.run likewise: nothing ran", /needs a click/.test(r2) && await evalJson(`window.__planted === undefined`), r2);
    // the control: the same call from a real click (CDP input is a trusted gesture) is the person's own act and works
    await evalJson(`(() => { const b = document.createElement('button'); b.id = '__byhand'; b.textContent = 'x'; b.style.cssText = 'position:fixed;left:4px;top:4px;width:40px;height:40px;z-index:2147483647';
      b.onclick = () => { window.__putR = EW.mods.put({ name: 'byhand', auto: false, source: 'export default () => {}' }).then(() => 'stored', (e) => String(e.message)); }; document.body.append(b); return true; })()`);
    for (const type of ["mousePressed", "mouseReleased"]) await cdp.send("Input.dispatchMouseEvent", { type, x: 20, y: 20, button: "left", clickCount: 1 });
    check("D3 control: from a real click it's stored (the gate is the hand, not a dead switch)", (await evalJson(`window.__putR`)) === "stored" && (await evalJson(stored)).includes("byhand"), await evalJson(`window.__putR ?? null`));
    await evalJson(`(async () => { document.getElementById('__byhand')?.remove(); const d = await new Promise((r) => { const q = indexedDB.open('ew-mods', 1); q.onsuccess = () => r(q.result); });
      await new Promise((r) => { const t = d.transaction('scripts', 'readwrite'); t.objectStore('scripts').delete('byhand'); t.oncomplete = r; }); return true; })()`);
  });

  // ---- P: the page names the people it reaches by identity (H2): puppet, drag and typing carry the actor id (whisper did, until it was removed, R 10-18) ----
  await stage("P", async () => {
    const wren = guest("Wren");
    const { snap } = await wren.join();
    const wrenActor = snap?.cut?.you;
    check("(P setup) a second person is here, with an identity", /^u-/.test(wrenActor ?? ""), snap ? Object.keys(snap) : null);
    check("(P setup) …and the page knows it from their arrival", await waitFor(`import('/lib/net.js').then((m) => m.identities.get('Wren') === ${JSON.stringify(wrenActor)})`, 5000));
    // Wren stands beside me and takes poses and drags from strangers (the server checks a body's consent and reach first)
    const mine = await evalJson(`import('/lib/controller.js').then((m) => m.myState.pos.toArray())`);
    wren.send({ type: "pose", pose: { p: [mine[0] + 1, mine[1], mine[2]], yaw: 0, speed: 0, clip: "idle" } });
    let rq = 0; const wreq = (verb: string, args: any) => { const id = `w${++rq}`; wren.send({ type: "request", id, verb, args }); };
    wreq("consent", { move: true, touch: true });
    await sleep(500);
    await evalJson(`(() => { window.__sent = []; const s = WebSocket.prototype.send; WebSocket.prototype.send = function (d) { try { const m = JSON.parse(d); if (['puppet', 'bodydrag', 'typing'].includes(m.type)) __sent.push(m); } catch {} return s.call(this, d); }; return true; })()`);
    await evalJson(`import('/lib/net.js').then((m) => { m.sendPuppet('Wren', { pose: { head: [0, 0, 0, 1] } }); m.sendBodyDrag('Wren', { end: true }); m.sendTyping('Wren'); return true; })`);
    const sent = await evalJson(`__sent`);
    const by = (t: string) => sent.find((m: any) => m.type === t) ?? null;
    check("P1 puppet and bodydrag name the identity (targetActor) beside the name", by("puppet")?.targetActor === wrenActor && by("bodydrag")?.targetActor === wrenActor, sent);
    check("P2 typing names it too (toActor)", by("typing")?.toActor === wrenActor, sent);
    await sleep(500);
    check("P3 …and the server delivered them to that identity", wren.msgs.some((m) => m.type === "puppet" && m.by === me), wren.msgs.map((m) => m.type).slice(-12));
    wren.ws.close();
  });

  // ---- K: my body's two gates (R 10-28) are what the authority holds for me ----
  await stage("K", async () => {
    const tbl = `import('/lib/net.js').then((m) => m.sendRequest('consent', {})).then((r) => r?.table ?? null)`;
    for (const [g, on] of [["move", false], ["touch", true], ["touch", false], ["move", true]] as const) {
      await evalJson(`import('/lib/consent.js').then((m) => (m.setGate(${JSON.stringify(g)}, ${on}), true))`);
      check(`K1 ${g} ${on ? "on" : "off"} set in the browser lands at the authority`, await waitFor(`${tbl}.then((t) => t && t[${JSON.stringify(g)}] === ${on})`, 5000), await evalJson(tbl));
    }
    await evalJson(`import('/lib/consent.js').then((m) => (m.setPushable(false), true))`);
    check("K2 /pushable off is the move gate off at the authority", await waitFor(`${tbl}.then((t) => t && t.move === false)`, 5000), await evalJson(tbl));
    check("K3 the choice is persisted under ew-body-consent", await evalJson(`(() => { const v = JSON.parse(localStorage.getItem('ew-body-consent') ?? '{}'); return v.v === 4 && v.move === false && v.touch === false; })()`));
    await evalJson(`(async () => { (await import('/lib/windows.js')).getFrame('settings')?.show(); document.getElementById('sec-body-tab')?.click(); return true; })()`);
    const panel = await evalJson(`(() => { const b = [...document.querySelectorAll('#sec-body input[type=checkbox][data-gate]')]; return b.map((x) => ({ g: x.dataset.gate, on: x.checked, tip: x.title, label: x.closest('.row')?.querySelector('.nm')?.textContent })); })()`);
    check("K4 Settings ▸ body is two checkboxes, Allow being moved and Allow being posed and touched, reading the gates", JSON.stringify(panel?.map((x: any) => [x.g, x.on, x.label])) === JSON.stringify([["move", false, "Allow being moved"], ["touch", false, "Allow being posed and touched"]]), panel);
    check("K5 …each with a tooltip saying in plain words what it covers", /shove/.test(panel?.[0]?.tip ?? "") && /drag/.test(panel?.[0]?.tip ?? "") && /carry/.test(panel?.[0]?.tip ?? "") && /sit/.test(panel?.[0]?.tip ?? "") && /hands on you/.test(panel?.[1]?.tip ?? "") && /intimate/.test(panel?.[1]?.tip ?? "") && /pose/.test(panel?.[1]?.tip ?? ""), panel);
    await evalJson(`(() => { const b = document.querySelector('#sec-body input[data-gate=move]'); b.checked = true; b.dispatchEvent(new Event('change')); return true; })()`);
    check("K6 ticking Allow being moved in the panel lands at the authority", await waitFor(`${tbl}.then((t) => t && t.move === true)`, 5000), await evalJson(tbl));
  });

  // ---- L: per-person lists (R 10-28) from People Here: right-click someone → Always allow / Never allow / Default; the
  // lists show in Settings ▸ body with a remove button each; the authority decides by them, whatever the gates say.
  await stage("L", async () => {
    const tbl = `import('/lib/net.js').then((m) => m.sendRequest('consent', {})).then((r) => r?.table ?? null)`;
    await evalJson(`(async () => { if (document.querySelector('.chat-side')?.classList.contains('closed')) (await import('/lib/ui.js')).togglePeopleHere(); return true; })()`);
    await evalJson(`import('/lib/consent.js').then((m) => (m.setGate('move', true), m.setGate('touch', false), true))`);
    const wren = guest("Wren"); const { snap } = await wren.join(); const wrenActor = snap?.cut?.you;
    check("(L setup) Wren is here with an identity, and the page knows it", /^u-/.test(wrenActor ?? "") && await waitFor(`import('/lib/net.js').then((m) => m.identities.get('Wren') === ${JSON.stringify(wrenActor)})`, 5000));
    const victim = await evalJson(`import('/lib/net.js').then((m) => m.net.you)`);
    const mine = await evalJson(`import('/lib/controller.js').then((m) => m.myState.pos.toArray())`);
    let rq = 0; const wreq = async (verb: string, args: any) => { const id = `l${++rq}`; wren.send({ type: "request", id, verb, args }); const t0 = Date.now(); while (Date.now() - t0 < 5000) { const r = wren.msgs.find((m) => m.type === "reply" && m.id === id); if (r) return r.reply; await sleep(50); } return null; };
    const mv = await wreq("move", { to: [mine[0] + 1, mine[1], mine[2]] });
    const mv2 = await evalJson(`import('/lib/net.js').then((m) => m.sendRequest('move', { to: ${JSON.stringify(mine.map((n: number) => Math.round(n * 1000) / 1000))} }))`);
    check("(L setup) both bodies are in the world at the authority (move)", mv?.ok === true && mv2?.ok === true, { wren: mv, me: mv2 });
    const items = () => evalJson(`import('/lib/people.js').then((m) => { m.menuAt('Wren', 180, 120); const r = [...document.querySelectorAll('.sp-ctx .sp-ctx-item')].map((b) => b.textContent); return r; })`);
    const press = (label: string) => evalJson(`import('/lib/people.js').then((m) => { m.menuAt('Wren', 180, 120); const b = [...document.querySelectorAll('.sp-ctx .sp-ctx-item')].find((x) => x.textContent.replace(/^✓ /, '') === ${JSON.stringify(label)}); b?.click(); return !!b; })`);
    const rows0 = await items();
    check("L1 right-click Wren: Always allow / Never allow / Default, ✓ on Default, and nothing that asks", ["Always allow", "Never allow", "✓ Default"].every((x) => rows0?.includes(x)) && !rows0?.some((x: string) => /ask|this once|Not now|Consent ▸/.test(x)), rows0);
    const pose = { to: victim, kind: "pose", spec: { head: [0, 0, 0, 1] } };
    check("(L2 setup) with my touch gate off, Wren's pose is refused", (await wreq("body", pose))?.refused?.code === "consent");
    check("L2 Always allow: pressed, it lands at the authority as my allow list", await press("Always allow") && await waitFor(`${tbl}.then((t) => t && t.allow.includes(${JSON.stringify(wrenActor)}))`, 5000), await evalJson(tbl));
    check("L2b …and Wren's pose now lands, though my touch gate is off", (await wreq("body", pose))?.ok === true);
    check("L2c …and the menu shows ✓ Always allow", (await items())?.includes("✓ Always allow"));
    await evalJson(`(async () => { (await import('/lib/panels.js')).closeContextMenu(); (await import('/lib/windows.js')).getFrame('settings')?.show(); document.getElementById('sec-body-tab')?.click(); return true; })()`);
    check("L3 Settings ▸ body lists Wren under Always allowed, with a remove button", await waitFor(`(() => { const r = document.querySelector('#sec-body [data-list=allow][data-id=${JSON.stringify(wrenActor)}]'); return !!r && /Wren/.test(r.textContent) && !!r.querySelector('button'); })()`, 3000), await evalJson(`document.querySelector('#sec-body [data-lists]')?.outerHTML ?? null`));
    check("L4 Never allow: pressed, Wren moves to my block list (off allow)", await press("Never allow") && await waitFor(`${tbl}.then((t) => t && t.block.includes(${JSON.stringify(wrenActor)}) && !t.allow.includes(${JSON.stringify(wrenActor)}))`, 5000), await evalJson(tbl));
    await evalJson(`import('/lib/consent.js').then((m) => (m.setGate('move', true), true))`);
    check("L4b …and Wren's shove is refused though my move gate is on", (await wreq("body", { to: victim, kind: "shove" }))?.refused?.code === "consent");
    check("L4c …and the panel shows Wren under Never allowed", await waitFor(`!!document.querySelector('#sec-body [data-list=block][data-id=${JSON.stringify(wrenActor)}]') && !document.querySelector('#sec-body [data-list=allow]')`, 3000));
    await evalJson(`(() => { document.querySelector('#sec-body [data-list=block][data-id=${JSON.stringify(wrenActor)}] button').click(); return true; })()`);
    check("L5 the panel's remove takes Wren off at the authority, and the switches answer them again (a shove lands)", await waitFor(`${tbl}.then((t) => t && !t.block.includes(${JSON.stringify(wrenActor)}) && !t.allow.includes(${JSON.stringify(wrenActor)}))`, 5000) && (await wreq("body", { to: victim, kind: "shove" }))?.ok === true && await evalJson(`!document.querySelector('#sec-body [data-list]')`), await evalJson(tbl));
    await press("Always allow"); await waitFor(`${tbl}.then((t) => t && t.allow.length > 0)`, 5000);
    check("L6 Default from the menu takes them off too", await press("Default") && await waitFor(`${tbl}.then((t) => t && !t.allow.length && !t.block.length)`, 5000), await evalJson(tbl));
    await evalJson(`import('/lib/panels.js').then((m) => (m.closeContextMenu(), true))`);
    wren.ws.close();
  });

  // ---- C: the page's own policy refuses inline script ----
  await stage("C", async () => {
    const before = (await evalJson(`__csp`)).length;
    await evalJson(`(() => { const d = document.createElement('div'); d.innerHTML = ${JSON.stringify(`<img src="data:," onerror="window.__inline=1">`)}; document.body.append(d);
      const s = document.createElement('script'); s.textContent = 'window.__inline2 = 1'; document.body.append(s); return true; })()`);
    await sleep(600);
    check("C1 an injected inline handler does not run", await evalJson(`window.__inline === undefined`));
    check("C2 an injected inline <script> does not run", await evalJson(`window.__inline2 === undefined`));
    check("C3 the browser reports the violations (script-src)", await waitFor(`__csp.length > ${before} && __csp.slice(${before}).some((v) => /script-src/.test(v.dir))`, 2000), await evalJson(`__csp`));
    const h = await (await fetch(`${BASE}/?world=${WORLD}`)).headers.get("content-security-policy");
    check("C4 the page is served with a Content-Security-Policy header", !!h && /script-src/.test(h) && !/unsafe-inline'[^;]*script|script-src[^;]*'unsafe-inline'/.test(h), h);
  });

  check("no page errors along the way", (await evalJson(`__errs`)).length === 0, await evalJson(`__errs`));
} catch (e) {
  check("the probe threw", false, String(e?.stack ?? e));
}
console.log(`[xss-probe] ${tally.passed} passed, ${tally.failed} failed${tally.note()}`);
await cleanup(tally.failed ? 1 : 0);
process.exit(tally.failed ? 1 : 0);
