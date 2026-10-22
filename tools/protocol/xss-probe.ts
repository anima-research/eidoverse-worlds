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

const WORLD = "xss3";
// the reviewer's payload, and a <svg onload> (fires synchronously on insertion, no network) for the seam stage
const IMG = `<img src=x onerror="window.__xss=(window.__xss||0)+1">`;
const SVG = `<svg onload="window.__xss=(window.__xss||0)+1">`;
const { cdp, evalJson, cleanup, die, BASE } = await scratchBench("xss", { worlds: [WORLD], owner: "owner", cspExpected: true });   // stage C causes violations on purpose; boot asserts none of its own
const { check: check0, tally } = mkCheck();
const check = (name: string, ok: any, detail?: any) => check0(name, !!ok, detail === undefined ? "" : typeof detail === "string" ? detail.slice(0, 600) : (JSON.stringify(detail) ?? "").slice(0, 600));
const waitFor = async (expr: string, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { if (await evalJson(expr)) return true; } catch { /* busy */ } await sleep(100); } return false; };
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
    wreq("consent", { switch: "accept" });
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

  // ---- K: my body's one switch (recut A2) is what the authority holds for me ----
  await stage("K", async () => {
    const sw = `import('/lib/net.js').then((m) => m.sendRequest('consent', {})).then((r) => r?.table?.switch ?? null)`;
    for (const v of ["refuse", "ask", "accept"]) {
      await evalJson(`import('/lib/consent.js').then((m) => (m.setSwitch(${JSON.stringify(v)}), true))`);
      check(`K1 switch ${v} set in the browser lands at the authority`, await waitFor(`${sw}.then((t) => t === ${JSON.stringify(v)})`, 5000), await evalJson(sw));
    }
    await evalJson(`import('/lib/consent.js').then((m) => (m.setPushable(false), true))`);
    check("K2 /pushable off is refuse at the authority", await waitFor(`${sw}.then((t) => t === 'refuse')`, 5000), await evalJson(sw));
    check("K3 the choice is persisted under ew-body-switch", await evalJson(`localStorage.getItem('ew-body-switch') === 'refuse'`));
    await evalJson(`(async () => { (await import('/lib/windows.js')).getFrame('settings')?.show(); document.getElementById('sec-body-tab')?.click(); return true; })()`);
    check("K4 Settings ▸ body is one select, reading the switch", await evalJson(`(() => { const sels = document.querySelectorAll('#sec-body select'); return sels.length === 1 && sels[0].value === 'refuse'; })()`));
    await evalJson(`import('/lib/consent.js').then((m) => (m.setPushable(true), true))`);
  });

  // ---- Q: `ask` is wired (R 10-14). A stranger's act that meets an `ask` cell files an ask at the authority; it is pushed
  // to me as body-inbox, marks their row in People Here, and their menu answers it: Allow / Not now / Never. The Consent ▸
  // sub-list on every person is my table's strangers row as a checklist. ASK_SHOTS=<dir> saves PNGs for the owner.
  await stage("Q", async () => {
    const shot = async (name: string) => { if (!process.env.ASK_SHOTS) return; try { const r = await cdp.send<any>("Page.captureScreenshot", { format: "png" }); fs.mkdirSync(process.env.ASK_SHOTS, { recursive: true }); fs.writeFileSync(path.join(process.env.ASK_SHOTS, name), Buffer.from(r.data, "base64")); } catch (e) { console.log(`  (shot ${name} failed: ${String(e)})`); } };
    const full = `import('/lib/net.js').then((m) => m.sendRequest('consent', {})).then((r) => r?.table ?? null)`;
    await evalJson(`(async () => { (await import('/lib/windows.js')).getFrame('settings')?.hide?.(); if (document.querySelector('.chat-side')?.classList.contains('closed')) (await import('/lib/ui.js')).togglePeopleHere(); return true; })()`);
    await evalJson(`import('/lib/consent.js').then((m) => (m.setSwitch('ask'), true))`);
    check("(Q setup) my switch is `ask` at the authority", await waitFor(`${full}.then((t) => t && t.switch === 'ask')`, 5000), await evalJson(full));
    const wren = guest("Wren"); const { snap } = await wren.join(); const wrenActor = snap?.cut?.you;
    check("(Q setup) Wren is here with an identity, and the page knows it", /^u-/.test(wrenActor ?? "") && await waitFor(`import('/lib/net.js').then((m) => m.identities.get('Wren') === ${JSON.stringify(wrenActor)})`, 5000));
    const victim = await evalJson(`import('/lib/net.js').then((m) => m.net.you)`);
    const mine = await evalJson(`import('/lib/controller.js').then((m) => m.myState.pos.toArray())`);
    let rq = 0; const wreq = async (verb: string, args: any) => { const id = `q${++rq}`; wren.send({ type: "request", id, verb, args }); const t0 = Date.now(); while (Date.now() - t0 < 5000) { const r = wren.msgs.find((m) => m.type === "reply" && m.id === id); if (r) return r; await sleep(50); } return null; };
    const mv = await wreq("move", { to: [mine[0] + 1, mine[1], mine[2]] });   // the authority tracks bodies that moved (presence); a pose needs no reach
    const mv2 = await evalJson(`import('/lib/net.js').then((m) => m.sendRequest('move', { to: ${JSON.stringify(mine.map((n: number) => Math.round(n * 1000) / 1000))} }))`);   // and mine (in play, thingphysics does this on arrival)
    check("(Q setup) both bodies are in the world at the authority (move)", mv?.ok === true && mv2?.ok === true, { wren: mv, me: mv2 });
    const r1 = await wreq("body", { to: victim, kind: "pose", spec: { head: [0, 0, 0, 1] } });
    const askId = r1?.reply?.ask;
    check("Q1 Wren's pose meets my `ask` cell: the authority files an ask (outcome asked)", r1?.reply?.outcome === "asked" && typeof askId === "string", r1);
    const marked = await waitFor(`!!document.querySelector('.who-row[data-name="Wren"] .who-ask')`, 5000);
    check("Q2 the ask reached my page: Wren's row in People Here carries the mark, titled with the class", marked && await waitFor(`!!document.querySelector('.who-row[data-name="Wren"] .who-ask') && document.querySelector('.who-row[data-name="Wren"] .who-ask').title === 'asks to pose my body'`, 5000), await evalJson(`document.querySelector('.who-row[data-name="Wren"]')?.outerHTML ?? null`));
    check("Q3 …and said once as a toast, in words (who, what, how long)", await waitFor(`[...document.querySelectorAll('.toast')].filter((t) => /Wren asks to pose my body/.test(t.textContent) && /20 s/.test(t.textContent)).length === 1`, 3000), await evalJson(`[...document.querySelectorAll('.toast')].map((t) => t.textContent)`));
    const rows = await evalJson(`import('/lib/people.js').then((m) => { m.menuAt('Wren', 180, 120); return [...document.querySelectorAll('.sp-ctx .sp-ctx-item')].map((b) => b.textContent); })`);
    check("Q4 right-click Wren: Allow (this once) / Not now / Never lead the menu, and Consent ▸ is on it", rows?.[0] === "Allow: pose my body (this once)" && rows?.[1] === "Not now" && rows?.[2] === "Never (pose: deny for them)" && rows.includes("Consent ▸"), rows);
    await shot("ask-1-people-here-menu.png");
    await evalJson(`(() => { document.querySelector('.sp-ctx .sp-ctx-item').click(); return true; })()`);
    check("Q5 Allow answers the ask: Wren hears body-reply ok (consent {answer, yes: true} landed) and the pose was delivered", await (async () => { const t0 = Date.now(); while (Date.now() - t0 < 5000) { if (wren.msgs.some((m) => m.type === "body-inbox" && m.messages?.some((x: any) => x.type === "body-reply" && x.ask === askId && x.ok === true && x.applied === true))) return true; await sleep(50); } return false; })(), wren.msgs.filter((m) => m.type === "body-inbox"));
    check("Q6 …and the mark is gone", marked && await waitFor(`!document.querySelector('.who-row[data-name="Wren"] .who-ask')`, 3000));
    // review of #260: a row answers the ask it SHOWED. Kit's ask A is on the open menu; A is answered elsewhere
    // (yes, as the XR ask panel would: a no would cool Kit's asks down), then Kit asks again (B). Pressing the row that
    // showed A must answer nothing, and B stays pending. Kit is a second guest: the authority takes at most 2 asks a minute from one.
    { const kit = guest("Kit"); const { snap: ks } = await kit.join(); const kitActor = ks?.cut?.you;
      await waitFor(`import('/lib/net.js').then((m) => m.identities.get('Kit') === ${JSON.stringify(kitActor)})`, 5000);
      let kq = 0; const kreq = async (verb: string, args: any) => { const id = `k${++kq}`; kit.send({ type: "request", id, verb, args }); const t0 = Date.now(); while (Date.now() - t0 < 5000) { const r = kit.msgs.find((m) => m.type === "reply" && m.id === id); if (r) return r; await sleep(50); } return null; };
      await kreq("move", { to: [mine[0] - 1, mine[1], mine[2]] });
      const ra = await kreq("body", { to: victim, kind: "pose", spec: { head: [0, 0, 0, 1] } }); const askA = ra?.reply?.ask;
      await waitFor(`import('/lib/people.js').then((m) => m.consentInbox.asks().some((k) => k.id === ${JSON.stringify(askA)}))`, 5000);
      await evalJson(`import('/lib/people.js').then((m) => { m.menuAt('Kit', 180, 120); window.__allowA = [...document.querySelectorAll('.sp-ctx .sp-ctx-item')].find((b) => b.textContent.startsWith('Allow')); return !!window.__allowA; })`);
      const ansA = await evalJson(`Promise.all([import('/lib/people.js'), import('/lib/net.js')]).then(([p, n]) => p.consentInbox.answer(${JSON.stringify(askA)}, true, n.sendRequest))`);
      await waitFor(`import('/lib/people.js').then((m) => !m.consentInbox.asks().length)`, 3000); await sleep(300);
      const rb = await kreq("body", { to: victim, kind: "pose", spec: { head: [0, 0, 0, 1] } }); const askB = rb?.reply?.ask;
      await waitFor(`import('/lib/people.js').then((m) => m.consentInbox.asks().some((k) => k.id === ${JSON.stringify(askB)}))`, 5000);
      await evalJson(`(() => { window.__allowA?.click(); return true; })()`); await sleep(800);
      const bAnswered = kit.msgs.some((m) => m.type === "body-inbox" && m.messages?.some((x: any) => x.type === "body-reply" && x.ask === askB));
      const bPending = await evalJson(`import('/lib/people.js').then((m) => m.consentInbox.asks().some((k) => k.id === ${JSON.stringify(askB)}))`);
      check("Q6b the Allow row answers the ask it showed: with that ask gone and a newer one pending, pressing it answers nothing (the newer ask is still pending, unanswered)",
        typeof askA === "string" && typeof askB === "string" && askA !== askB && !bAnswered && bPending === true, { askA, ansA, askB, rb: rb?.reply, bAnswered, bPending });
      await evalJson(`Promise.all([import('/lib/people.js'), import('/lib/net.js')]).then(([p, n]) => p.consentInbox.answer(${JSON.stringify(askB)}, true, n.sendRequest)).then(() => true)`);
      kit.ws.close(); }
    // a second ask, answered Never: no to this one, and a standing deny for Wren's pose at the authority (consent {deny, class})
    await evalJson(`(() => { window.__creq = []; const s = WebSocket.prototype.send; WebSocket.prototype.send = function (d) { try { const m = JSON.parse(d); if (m.type === 'request' && m.verb === 'consent') __creq.push(m.args); } catch {} return s.call(this, d); }; return true; })()`);
    const r2 = await wreq("body", { to: victim, kind: "pose", spec: { head: [0, 0, 0, 1] } }); const ask2 = r2?.reply?.ask;
    check("(Q7 setup) a second ask is filed and marked", typeof ask2 === "string" && await waitFor(`!!document.querySelector('.who-row[data-name="Wren"] .who-ask')`, 5000), r2);
    await evalJson(`import('/lib/people.js').then((m) => { m.menuAt('Wren', 180, 120); [...document.querySelectorAll('.sp-ctx .sp-ctx-item')].find((b) => b.textContent.startsWith('Never')).click(); return true; })`);
    check("Q7 Never: Wren hears no, and my page sent consent {answer, yes: false} then consent {deny: Wren, class: pose}", await (async () => { const t0 = Date.now(); while (Date.now() - t0 < 5000) { const no = wren.msgs.some((m) => m.type === "body-inbox" && m.messages?.some((x: any) => x.type === "body-reply" && x.ask === ask2 && x.ok === false)); const sent = await evalJson(`__creq`); if (no && sent.some((a: any) => a.answer === ask2 && a.yes === false) && sent.some((a: any) => a.deny === wrenActor && a.class === 'pose')) return true; await sleep(100); } return false; })(), { creq: await evalJson(`__creq`), wren: wren.msgs.filter((m) => m.type === "body-inbox") });
    check("Q8 …and the mark is gone", await waitFor(`!document.querySelector('.who-row[data-name="Wren"] .who-ask')`, 3000));
    // review of #260: Never's standing no goes to the ask's own sender, not to whoever holds that name when it's pressed.
    // Rook asks and the row is kept; Rook leaves, and once the page has seen it go (the server drops a client before it
    // broadcasts the leave, so the name is free), another guest joins as Rook before the press.
    { await evalJson(`import('/lib/base.js').then((m) => { window.__torn = []; m.bus.on('participant-teardown', (id) => window.__torn.push(id)); return true; })`);
      const rookA = guest("Rook"); const { snap: sa } = await rookA.join(); const actorA = sa?.cut?.you;
      await waitFor(`import('/lib/net.js').then((m) => m.identities.get('Rook') === ${JSON.stringify(actorA)})`, 5000);
      let aq = 0; const areq = async (verb: string, args: any) => { const id = `a${++aq}`; rookA.send({ type: "request", id, verb, args }); const t0 = Date.now(); while (Date.now() - t0 < 5000) { const r = rookA.msgs.find((m) => m.type === "reply" && m.id === id); if (r) return r; await sleep(50); } return null; };
      await areq("move", { to: [mine[0] - 1, mine[1], mine[2] + 1] });
      const ra = await areq("body", { to: victim, kind: "pose", spec: { head: [0, 0, 0, 1] } }); const askR = ra?.reply?.ask;
      await waitFor(`import('/lib/people.js').then((m) => m.consentInbox.asks().some((k) => k.id === ${JSON.stringify(askR)}))`, 5000);
      await evalJson(`import('/lib/people.js').then((m) => { m.menuAt('Rook', 180, 120); window.__neverR = [...document.querySelectorAll('.sp-ctx .sp-ctx-item')].find((b) => b.textContent.startsWith('Never')); return !!window.__neverR; })`);
      rookA.ws.close();
      const left = await waitFor(`window.__torn.includes('Rook')`, 8000);
      const rookB = guest("Rook"); const { snap: sb } = await rookB.join(); const actorB = sb?.cut?.you;
      const handed = await waitFor(`import('/lib/net.js').then((m) => m.identities.get('Rook') === ${JSON.stringify(actorB)})`, 8000);
      const n0 = await evalJson(`__creq.length`);
      await evalJson(`(() => { window.__neverR?.click(); return true; })()`);
      let denies: any[] = []; for (const t0 = Date.now(); Date.now() - t0 < 5000 && !denies.length; await sleep(100)) denies = (await evalJson(`__creq.slice(${n0})`)).filter((a: any) => a?.deny !== undefined);
      const told = await waitFor(`[...document.querySelectorAll('.toast')].some((t) => t.textContent.includes('the one who asked as Rook may not'))`, 5000);
      check("Q8b Never files its standing no against the ask's own sender, though another guest holds that name by the press, and its toast names them as the one who asked",
        typeof askR === "string" && !!actorA && !!actorB && actorA !== actorB && left && handed && denies.length === 1 && denies[0].deny === actorA && denies[0].class === "pose" && told, { askR, actorA, actorB, left, handed, denies, told });
      rookB.ws.close(); }
    // review of #260: a reply that never comes isn't a refusal. Lark asks and I press Never, but neither the answer nor the
    // deny reaches the authority (the page drops both sends), so each ends in sendRequest's timeout, shortened here to
    // 300 ms: the toast must say each may have landed, never that the ask had gone or that the no didn't land.
    { const lark = guest("Lark"); const { snap: sl } = await lark.join(); const larkActor = sl?.cut?.you;
      await waitFor(`import('/lib/net.js').then((m) => m.identities.get('Lark') === ${JSON.stringify(larkActor)})`, 5000);
      let lq = 0; const lreq = async (verb: string, args: any) => { const id = `l${++lq}`; lark.send({ type: "request", id, verb, args }); const t0 = Date.now(); while (Date.now() - t0 < 5000) { const r = lark.msgs.find((m) => m.type === "reply" && m.id === id); if (r) return r; await sleep(50); } return null; };
      await lreq("move", { to: [mine[0] + 1, mine[1], mine[2] + 1] });
      const rl = await lreq("body", { to: victim, kind: "pose", spec: { head: [0, 0, 0, 1] } }); const askL = rl?.reply?.ask;
      await waitFor(`import('/lib/people.js').then((m) => m.consentInbox.asks().some((k) => k.id === ${JSON.stringify(askL)}))`, 5000);
      await evalJson(`(() => { window.__dropped = []; const send = WebSocket.prototype.send, st = window.setTimeout; window.__restore = () => { WebSocket.prototype.send = send; window.setTimeout = st; };
        WebSocket.prototype.send = function (d) { try { const m = JSON.parse(d); if (m.type === 'request' && m.verb === 'consent') { __dropped.push(m.args); return; } } catch {} return send.call(this, d); };
        window.setTimeout = (f, ms, ...a) => st(f, ms === 15000 ? 300 : ms, ...a); return true; })()`);
      await evalJson(`import('/lib/people.js').then((m) => { m.menuAt('Lark', 180, 120); const b = [...document.querySelectorAll('.sp-ctx .sp-ctx-item')].find((x) => x.textContent.startsWith('Never')); b?.click(); return !!b; })`);
      const shown = await waitFor(`[...document.querySelectorAll('.toast')].some((t) => t.textContent.includes('the standing no may have landed'))`, 5000);
      const text = await evalJson(`[...document.querySelectorAll('.toast')].map((t) => t.textContent).find((x) => x.includes('the standing no may have landed')) ?? null`);
      const dropped = await evalJson(`(() => { window.__restore(); return __dropped; })()`);
      check("Q8c a Never whose answer and deny get no reply says each may have landed, not that the ask had gone or the no didn't land",
        typeof askL === "string" && shown && /the answer may have landed/.test(text ?? "") && !/had gone|didn't land/.test(text ?? "")
          && ((ad) => ad.length === 2 && ad[0].answer === askL && ad[1].deny === larkActor)(dropped.filter((x: any) => x && ("answer" in x || "deny" in x))), { askL, shown, text, dropped });
      lark.ws.close(); }
    // the Consent ▸ sub-list (recut A2): my body's switch as three choices, ✓ on the current one; a press sets it
    const sub = await evalJson(`import('/lib/people.js').then((m) => { m.menuAt('Wren', 180, 120); [...document.querySelectorAll('.sp-ctx .sp-ctx-item')].find((b) => b.textContent === 'Consent ▸').click(); return [...document.querySelectorAll('.sp-ctx[data-consent] .sp-ctx-item')].map((b) => b.textContent); })`);
    check("Q9 Consent ▸ lists the three choices, ✓ on ask (my switch now)", sub?.length === 3 && sub.filter((x: string) => x.startsWith("✓")).length === 1 && sub.includes("✓ ask — ask me first, every time"), sub);
    await shot("ask-2-consent-sublist.png");
    const pick = (v: string) => evalJson(`(() => { [...document.querySelectorAll('.sp-ctx[data-consent] .sp-ctx-item')].find((b) => b.textContent.replace(/^✓ /, '').startsWith(${JSON.stringify(v)})).click(); return true; })()`);
    await pick("refuse"); const t10 = Date.now(); const landed = await waitFor(`${full}.then((t) => t && t.switch === 'refuse')`, 12000);
    check("Q10 pressing refuse sets it at the authority, and the list stays open with its ✓", landed && await evalJson(`[...document.querySelectorAll('.sp-ctx[data-consent] .sp-ctx-item')].some((b) => b.textContent.startsWith('✓ refuse'))`), { ms: Date.now() - t10, authority: await evalJson(full) });
    await pick("accept");
    check("Q11 pressing accept sets it back", await waitFor(`${full}.then((t) => t && t.switch === 'accept')`, 5000), await evalJson(full));
    await evalJson(`import('/lib/panels.js').then((m) => (m.closeContextMenu(), true))`);
    wren.ws.close();
    await evalJson(`import('/lib/consent.js').then((m) => (m.setPushable(true), true))`);
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
