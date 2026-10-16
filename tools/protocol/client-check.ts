// tools/protocol/client-check.ts — slice 3b in a real browser: edit mode in a world sends requests, folds the log and
// waits for the authority. One headless Chromium against a scratch sequencer (tools/harness.ts scratchBench: scratch port,
// scratch WORLDS_DIR, its own profile; never 8968/8970). Run it under the house guards:
//   code/scripts/eido-probe.sh -C <worktree> -t 400 tools/protocol/client-check.ts      (test:protocol's `client` suite does this)
//
//   B   boot: the page knows it's in a world; its own fold of the log stream = the log on disk (digest)
//   P   place from the Build tab's ghost: one `create` act, the page waited for the authority
//   G   a gizmo drag is presence until release: ONE act, `set transform` with expect on where it started
//   U   Ctrl+Z is the authority's undo {act} of MY act; Ctrl+Shift+Z redoes (undo of my undo)
//   C   undo refused when someone changed it since: nothing written, the refusal shown in the agents' words
//   X   Esc mid-drag: the thing goes back, and nothing is written (0 acts)
//   L   a lock refusal (the cup rides a table someone else locked): the dialog offers Move anyway; it re-sends the
//       SAME request with throughLock: the log has one act, the lock is still on
//   D   duplicate (Alt+D) is create {from: <thing>}: one act
//   M   deleting two selected things is ONE batch act
//   S   Save as blueprint is the authority's publish; its tile places a copy (create {from: <hash>})
// The writes go through the real edit code (build.js, gizmo.js, inspect.js, editpanels.js); a few gestures are driven
// at their seams (TransformControls' own events, the panel's buttons, synthetic keydowns), as editpanels-bench does.
// @ts-nocheck
import fs from "node:fs";
import path from "node:path";
import { scratchBench, mkCheck, sleep } from "../harness.ts";
import { readLog, fold, digest } from "../../shared/protocol/fold.js";
import { refusalText } from "../../shared/protocol/refusal.js";

const ENGINE = path.resolve(import.meta.dir, "../..");
const ME = "editbot", WORLD = "edit4";
process.env.TRUST_NAMES = "1"; // a private test server: the name editbot is the account local:editbot (server/config.ts)
const CRATE = "eidoverse/assets/models/crate_large_blue.glb", RED = "eidoverse/assets/models/crate_large_red.glb";
let worldsDir = "";
const { cdp, evalJson, cleanup, die, BASE, SCRATCH } = await scratchBench("client", {
  prepare: (scratch) => {
    worldsDir = path.join(scratch, "worlds"); fs.mkdirSync(worldsDir, { recursive: true });
    const r = Bun.spawnSync(["bun", "tools/protocol/world.ts", "found", WORLD, "--owner", ME, "--title", "client check"], { cwd: ENGINE, env: { ...process.env, WORLDS_DIR: worldsDir, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" } });
    if (r.exitCode !== 0) throw new Error("founding failed: " + r.stderr.toString());
  },
});
const { check: check0, tally } = mkCheck();
const check = (name: string, ok: any, detail?: any) => check0(name, !!ok, detail === undefined ? "" : typeof detail === "string" ? detail.slice(0, 600) : (JSON.stringify(detail) ?? "").slice(0, 600));
const LOG = () => path.join(worldsDir, WORLD, "world.jsonl");
const entries = () => readLog(fs.readFileSync(LOG()));
// my identity is the founder's opaque id (round-2 R1): the actor of the world's founding act
const MY = () => entries().find((e: any) => e?.kind === "act" && e.verb === "create-world")?.actor;
// my acts that CHANGED something: a refused request is recorded too (an act carrying {refused}, round-2 R7), and is
// counted apart (myRefused), so "nothing was written" below means no change, with the attempt on the record
const myActs = () => entries().map((e, seq) => ({ e, seq })).filter(({ e }) => e?.kind === "act" && e.actor === MY() && !e.body?.refused);
const myRefused = () => entries().filter((e) => e?.kind === "act" && e.actor === MY() && e.body?.refused).length;
const disk = () => fold(entries());
const waitFor = async (expr: string, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { if (await evalJson(expr)) return true; } catch { /* page busy */ } await sleep(100); } return false; };
const waitDisk = async (pred: () => boolean, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (pred()) return true; await sleep(100); } return false; };
// a press is a keydown AND a keyup: a held D (Alt+D) or Delete would otherwise walk the body on, and the view with it
const key = (code: string, mods: any = {}) => { const m = Object.entries(mods).map(([k, v]) => `${k}: ${v}`).join(", ");
  return evalJson(`dispatchEvent(new KeyboardEvent('keydown', { code: '${code}', key: '${code}', bubbles: true, ${m} })), dispatchEvent(new KeyboardEvent('keyup', { code: '${code}', key: '${code}', bubbles: true, ${m} })), true`); };
const page = (js: string) => evalJson(`(async () => { ${js} })()`);
// the centre dialog and the Hierarchy, as a person sees them
const dlgTitle = `(document.querySelector('#confirm-center #cc-title')?.textContent ?? null)`;
const dlgBtns = `[...document.querySelectorAll('#confirm-center .cc-btns button')].map((b) => b.textContent)`;
const dlgClick = (re: string) => evalJson(`[...document.querySelectorAll('#confirm-center .cc-btns button')].find((b) => /${re}/.test(b.textContent))?.click(), true`);
const hier = `document.querySelector('[data-frame="hierarchy"]')`;
const lockBtn = (id: string) => `[...${hier}.querySelectorAll('.sp-tree-row')].find((r) => r.dataset.id === ${JSON.stringify(id)})?.querySelector('.sp-lock')`;
const posX = (id: string) => `import('/lib/world.js').then((m) => m.entities.get('${id}')?.position.x)`;

try {
  // ---- a second builder over a plain socket (an agent's view: it still reads the projection) ----
  const bob = new WebSocket(BASE.replace("http", "ws") + "/ws"); const replies = new Map(); let rn = 0;
  let BOB = "";   // bob's identity: the opaque id his snapshot tells him (round-2 R1); a role is granted to it, never to "bob"
  bob.onmessage = (ev) => { const m = JSON.parse(String(ev.data)); if (m.type === "reply") replies.get(m.id)?.(m.reply); if (m.type === "snapshot" && m.cut?.you) BOB = m.cut.you; };
  await new Promise((r, j) => { bob.onopen = r; bob.onerror = j; });
  const bobReq = (verb: string, args: any) => new Promise<any>((res) => { const id = `b${++rn}`; replies.set(id, res); bob.send(JSON.stringify({ type: "request", id, verb, args })); setTimeout(() => res({ ok: false, refused: { code: "timeout" } }), 6000); });

  await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: `window.__errs = []; addEventListener('error', (e) => __errs.push('error: ' + e.message));
    window.__gaps = []; { const w = console.warn.bind(console); console.warn = (...a) => { if (/\\[state\\] seq gap/.test(String(a[0]))) __gaps.push(String(a[0])); return w(...a); }; }
    // every reader runs under a catch-all that lands in console.error (state.js subscribers, the realizer's report()), so a
    // frozen-write throw (C7a: the fold's records are frozen on a dev host) never reaches the window's error event: catch it here.
    // three.js's WebGPU destroyAttribute TypeError on sky dispose is not a reader's and is filtered by its message.
    window.__cerr = []; { const e = console.error.bind(console); console.error = (...a) => { const t = a.map((x) => (x && x.stack) ? String(x.stack) : String(x)).join(' '); if (/read only|not extensible|Cannot (add|delete|assign|define)|TypeError/.test(t) && !/destroyAttribute/.test(t)) __cerr.push(t.slice(0, 300)); return e(...a); }; }
    window.__refused = []; window.__asked = [];
    window.__v1sent = []; { const send = WebSocket.prototype.send; WebSocket.prototype.send = function (d) { try { const m = JSON.parse(d); if (m && m.type === 'verb') __v1sent.push(m.verb); } catch {} return send.call(this, d); }; }
    import('/lib/base.js').then((m) => { m.bus.on('edit-refused', (e) => __refused.push(e)); m.bus.on('edit-lock-asked', (e) => __asked.push(e)); });` });
  await cdp.send("Page.navigate", { url: `${BASE}/?name=${ME}&world=${WORLD}` });
  let secs = 0; for (let i = 0; i < 160 && secs < 4; i++) { secs = (await evalJson(`document.querySelectorAll('.sec').length`).catch(() => 0)) ?? 0; if (secs < 4) await sleep(500); }
  check("boot: the client comes up", secs >= 4, `${secs} sections`);
  if (secs < 4) await die(1, "the page never booted");
  await evalJson(`(() => { const s = document.querySelector('#splash'); if (s) s.style.pointerEvents = 'none'; return true; })()`);
  check("B1 the page knows it's in a world (it adopted the cut)", await waitFor(`import('/lib/net.js').then((m) => m.replicaActive())`));
  bob.send(JSON.stringify({ type: "join", world: WORLD, id: "bob", avatar: "", replica: true })); await sleep(500);   // replica: a world speaks only to clients that fold its log (3c)
  check("(setup) the owner makes bob a builder", (await page(`const m = await import('/lib/net.js'); return (await m.sendRequest('set', { id: '@world', component: 'roles:${BOB}', value: { role: 'builder' } })).ok;`)) === true && /^u-/.test(BOB));
  await evalJson(`import('/lib/build.js').then((m) => (m.setEditMode(true), true))`);
  check("B2 edit mode opens (the owner may build)", await waitFor(`document.body.classList.contains('edit-mode')`));

  // ---- P: place from the ghost ----
  let n0 = myActs().length;
  await page(`const b = await import('/lib/build.js'); await b.holdGhost('${CRATE}', 'crate'); return b.hasGhost();`);
  await waitFor(`import('/lib/build.js').then((m) => m.hasGhost())`);
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 760, y: 470 });
  await sleep(300);
  const under = await evalJson(`(() => { const e = document.elementFromPoint(760, 470); return e ? e.tagName + '#' + e.id + '.' + e.className : null; })()`);
  // the click the canvas listens for (build.js commitSpawn); dispatched on the canvas itself, since headless leaves the
  // boot splash and frames over the viewport (editpanels-bench drives its gestures at their seams the same way)
  await evalJson(`import('/lib/core.js').then((m) => (m.canvas.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 760, clientY: 470 })), true))`);
  check("P1 a click places it: ONE create act, stamped with me", await waitDisk(() => myActs().length === n0 + 1 && myActs().at(-1).e.verb === "create"),
    { acts: myActs().slice(n0).map((a) => a.e.verb), refused: await evalJson(`__refused.map((r) => r.text)`), errs: await evalJson(`__errs`), ghost: await evalJson(`import('/lib/build.js').then((m) => m.hasGhost())`), under });
  const crate = (() => { const a = myActs().at(-1); return a?.e.body?.request?.id; })();
  check("P2 the thing is in the page (its own fold drew it)", !!crate && await waitFor(`import('/lib/world.js').then((m) => m.entities.has('${crate}'))`), crate);

  // ---- G: gizmo drag-release = one act with expect ----
  await page(`(await import('/lib/scenegraph.js')).sceneSelect('${crate}'); (await import('/lib/build.js')).setTool('move'); return true;`);
  check("G0 the gizmo attaches to it", await waitFor(`globalThis.__gizmo?.().attached === '${crate}'`));
  const start = disk().entities[crate].c.transform;
  n0 = myActs().length;
  const drag = (dx: number, end = true) => evalJson(`(() => { const c = globalThis.__gizmo().controls; c.dispatchEvent({ type: 'dragging-changed', value: true });
    return import('/lib/world.js').then((m) => { const o = m.entities.get('${crate}'); o.position.x += ${dx}; c.dispatchEvent({ type: 'objectChange' }); ${end ? "c.dispatchEvent({ type: 'dragging-changed', value: false });" : ""} return true; }); })()`);
  await drag(1);
  check("G1 release = ONE act", await waitDisk(() => myActs().length === n0 + 1), myActs().slice(n0).map((a) => a.e.verb));
  const g = myActs().at(-1);
  const gReq = g?.e.body?.request;
  check("G2 …a set of the transform with expect on where the drag started (§3a)", g?.e.verb === "set" && gReq?.component === "transform" && JSON.stringify(gReq?.expect?.[0]?.value) === JSON.stringify(start), gReq);
  check("G3 …and it moved 1 m on the record", Math.abs(disk().entities[crate].c.transform.pos[0] - (start.pos[0] + 1)) < 1e-3, disk().entities[crate].c.transform);

  // ---- U: undo and redo through the authority ----
  n0 = myActs().length;
  await key("KeyZ", { ctrlKey: true });
  check("U1 Ctrl+Z = undo {act} of my act", await waitDisk(() => myActs().length === n0 + 1 && myActs().at(-1).e.verb === "undo" && myActs().at(-1).e.body.request.act === g.seq), myActs().slice(n0).map((a) => a.e.body));
  check("U2 …it's back where it was", await waitDisk(() => JSON.stringify(disk().entities[crate].c.transform) === JSON.stringify(start)));
  const undoAct = myActs().at(-1).seq;
  // the authority writes before it replies: wait until the page has its reply (the act on its redo stack) before the key
  await waitFor(`globalThis.__editWrites().redo.at(-1) === ${undoAct}`);
  await key("KeyZ", { ctrlKey: true, shiftKey: true });
  check("U3 Ctrl+Shift+Z redoes: undo {act: <my undo>}", await waitDisk(() => myActs().at(-1).e.verb === "undo" && myActs().at(-1).e.body.request.act === undoAct && Math.abs(disk().entities[crate].c.transform.pos[0] - (start.pos[0] + 1)) < 1e-3), myActs().at(-1)?.e.body);
  check("U4 the page's drawing follows (its fold)", await waitFor(`import('/lib/world.js').then((m) => Math.abs(m.entities.get('${crate}').position.x - ${start.pos[0] + 1}) < 1e-3)`));
  const redoAct = myActs().at(-1).seq;
  await waitFor(`globalThis.__editWrites().undo.at(-1) === ${redoAct}`);
  await key("KeyZ", { ctrlKey: true });
  check("U5 Ctrl+Z after a redo undoes the redo (it went back on my undo stack)", await waitDisk(() => myActs().at(-1).e.verb === "undo" && myActs().at(-1).e.body.request.act === redoAct && JSON.stringify(disk().entities[crate].c.transform) === JSON.stringify(start)), myActs().at(-1)?.e.body);
  const undo2 = myActs().at(-1).seq;
  await waitFor(`globalThis.__editWrites().redo.at(-1) === ${undo2}`);
  await key("KeyZ", { ctrlKey: true, shiftKey: true });
  check("U6 …and redo again", await waitDisk(() => myActs().at(-1).e.body.request.act === undo2 && Math.abs(disk().entities[crate].c.transform.pos[0] - (start.pos[0] + 1)) < 1e-3), myActs().at(-1)?.e.body);
  await waitFor(`import('/lib/net.js').then((m) => Math.abs(m.replica.st.entities['${crate}'].c.transform.pos[0] - ${start.pos[0] + 1}) < 1e-3)`);
  // U7 (review 10-14 K1): two quick Ctrl+Z's undo TWO acts (Y then X) — the second press must not read the same top act,
  // be refused "already undone", and drop the act below it unseen
  { const p0 = disk().entities[crate].c.transform.pos[0]; const k = myActs().length;
    await drag(1); await waitDisk(() => myActs().length === k + 1); const x = myActs().at(-1).seq;
    await waitFor(`globalThis.__editWrites().undo.at(-1) === ${x}`);
    await drag(1); await waitDisk(() => myActs().length === k + 2); const y = myActs().at(-1).seq;
    await waitFor(`globalThis.__editWrites().undo.at(-1) === ${y}`);
    // both presses in ONE tick (key-repeat): awaiting between them let the local authority reply in between, which hid the bug
    await evalJson(`(() => { for (let i = 0; i < 2; i++) { dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyZ', key: 'z', ctrlKey: true, bubbles: true })); dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyZ', key: 'z', ctrlKey: true, bubbles: true })); } return true; })()`);
    const both = await waitDisk(() => myActs().length >= k + 4 && myActs().slice(k + 2).filter((a) => a.e.verb === "undo" && a.e.body?.refused === undefined).length === 2);
    const reqs = myActs().slice(k + 2).map((a) => a.e.body?.request?.act);
    check("U7 two quick Ctrl+Z's undo both acts (Y, then X), nothing dropped", both && JSON.stringify(reqs) === JSON.stringify([y, x]) && Math.abs(disk().entities[crate].c.transform.pos[0] - p0) < 1e-3, { reqs, pos: disk().entities[crate].c.transform.pos[0], p0 });
    await waitFor(`globalThis.__editWrites().redo.length >= 2`); }

  // ---- Q: a Ctrl+Z pressed in the same tick as the release undoes THAT release (it waits for the authority's reply) ----
  { n0 = myActs().length; const before = JSON.stringify(disk().entities[crate].c.transform);
    await evalJson(`(() => { const c = globalThis.__gizmo().controls; c.dispatchEvent({ type: 'dragging-changed', value: true });
      return import('/lib/world.js').then((m) => { m.entities.get('${crate}').position.z += 1; c.dispatchEvent({ type: 'objectChange' }); c.dispatchEvent({ type: 'dragging-changed', value: false });
        dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyZ', key: 'KeyZ', ctrlKey: true, bubbles: true })); return true; }); })()`);
    const ok2 = await waitDisk(() => myActs().length === n0 + 2);
    const [rel, und] = myActs().slice(n0);
    check("Q1 release + Ctrl+Z in the same tick: the undo names the release, not the act before it", ok2 && rel.e.verb === "set" && und.e.verb === "undo" && und.e.body.request.act === rel.seq && JSON.stringify(disk().entities[crate].c.transform) === before, myActs().slice(n0).map((a) => [a.seq, a.e.verb, a.e.body.request])); }

  check("N0 by now (a create, a dozen moves, undos and redos) no '[state] seq gap' warning (N1 checks again at the end)", await evalJson(`__gaps.length === 0`), await evalJson(`__gaps.slice(0, 4)`));

  // ---- C: undo refused when someone changed it since ----
  const moved = disk().entities[crate].c.transform;
  check("(setup) bob moves the crate after me", (await bobReq("set", { id: crate, component: "transform", value: { ...moved, pos: [moved.pos[0], moved.pos[1], moved.pos[2] + 2] } })).ok);
  await waitFor(`import('/lib/net.js').then((m) => m.replica.st.entities['${crate}'].c.transform.pos[2] === ${moved.pos[2] + 2})`);
  n0 = myActs().length; const r0 = await evalJson(`__refused.length`);
  await key("KeyZ", { ctrlKey: true });
  check("C1 Ctrl+Z on something bob changed since is refused", await waitFor(`__refused.length > ${r0} && __refused.at(-1).refused.code === 'conflict'`), await evalJson(`__refused.at(-1)`));
  const shown = await evalJson(`__refused.at(-1)`);
  check("C2 …nothing written, bob's move stands", myActs().length === n0 && disk().entities[crate].c.transform.pos[2] === moved.pos[2] + 2);
  // ship list 10-07: a person reads plain words (no code, no tool syntax: plainRefusal); the agents' words ride along as agentText
  check("C3 …and the person reads it in plain words (the agents' words kept beside them), naming who", /^Couldn't undo/.test(shown?.text ?? "") && !/\(conflict\)/.test(shown?.text ?? "") && shown?.agentText === refusalText("undo", { refused: shown?.refused }) && /bob changed it since/.test(JSON.stringify(shown?.refused?.skipped)), shown);

  // ---- X: Esc mid-drag writes nothing ----
  n0 = myActs().length; const here = disk().entities[crate].c.transform.pos;
  await drag(3, false);
  await key("Escape");
  check("X1 Esc puts it back where the log has it", await waitFor(`import('/lib/world.js').then((m) => Math.abs(m.entities.get('${crate}').position.x - ${here[0]}) < 1e-3)`));
  await evalJson(`(() => { globalThis.__gizmo().controls.dispatchEvent({ type: 'dragging-changed', value: false }); return true; })()`);
  await sleep(1500);
  check("X2 …and the release after it wrote nothing (0 acts)", myActs().length === n0, myActs().slice(n0).map((a) => a.e.verb));
  check("X3 Esc left the selection alone (it cancelled the drag, not the edit)", await evalJson(`import('/lib/scenegraph.js').then((m) => m.sceneSelected() === '${crate}')`));

  // ---- L: a lock refusal and Move anyway ----
  check("(setup) bob builds a table with a cup on it and locks the table", (await bobReq("create", { id: "tbl", model: RED, components: { transform: { pos: [6, 0, 0] } } })).ok
    && (await bobReq("create", { id: "cup", model: CRATE, components: { transform: { pos: [0, 1, 0], scale: [0.3, 0.3, 0.3] }, parent: { to: "tbl", order: "a0" } } })).ok
    && (await bobReq("set", { id: "tbl", component: "lock", value: true })).ok);
  check("L0 the page has the cup on the table", await waitFor(`import('/lib/world.js').then((m) => m.entities.get('cup')?.userData?.mountedTo === 'tbl')`, 12000));
  n0 = myActs().length; const a0 = await evalJson(`__asked.length`);
  await page(`(await import('/lib/inspect.js')).commitEdit('cup', 'pos.x', 0.4); return true;`);
  check("L1 moving the cup on bob's locked table asks first: 'This is locked. Move anyway?'", await waitFor(`${dlgTitle} === 'This is locked. Move anyway?'`), await evalJson(dlgTitle));
  const body = await evalJson(`document.querySelector('#confirm-center #cc-body')?.textContent ?? ''`);
  check("L2 …saying in one line which thing is locked and by whom, no agent teaching (R, 10-04)", body === "It rides tbl, which is locked by bob.", body);
  check("L3 …and the refused try changed nothing; the attempt itself is on the record (round-2 R7)", myActs().length === n0 && myRefused() >= 1, myRefused());
  await dlgClick("Move anyway");
  check("L4 Move anyway: ONE act, the same request with throughLock: true", await waitDisk(() => myActs().length === n0 + 1 && myActs().at(-1).e.body.request.throughLock === true && myActs().at(-1).e.body.request.id === "cup"), myActs().slice(n0).map((a) => a.e.body.request));
  check("L5 …the cup moved, and the table is still locked", Math.abs(disk().entities.cup.c.transform.pos[0] - 0.4) < 1e-9 && disk().entities.tbl.c.lock === true, [disk().entities.cup.c.transform, disk().entities.tbl.c.lock]);
  check("L6 the dialog's answer was recorded as yes", await evalJson(`__asked.length === ${a0 + 1} && __asked.at(-1).yes === true`));

  // ---- D: duplicate ----
  n0 = myActs().length;
  await page(`(await import('/lib/scenegraph.js')).sceneSelect('${crate}'); return true;`);
  await waitFor(`import('/lib/scenegraph.js').then((m) => m.sceneSelected() === '${crate}')`);
  await key("KeyD", { altKey: true });
  check("D1 Alt+D = create {from: <the thing>}: ONE act", await waitDisk(() => myActs().length === n0 + 1 && myActs().at(-1).e.verb === "create" && myActs().at(-1).e.body.request.from === crate), myActs().slice(n0).map((a) => a.e.body.request));
  const st1 = disk(); const dup = Object.keys(st1.entities).find((k) => k !== crate && k !== "cup" && st1.entities[k].c.model === CRATE);
  check("D2 …a copy 0.5 m along x, drawn in the page", !!dup && Math.abs(st1.entities[dup].c.transform.pos[0] - st1.entities[crate].c.transform.pos[0] - 0.5) < 1e-6 && await waitFor(`import('/lib/world.js').then((m) => m.entities.has('${dup}'))`), dup);

  // ---- M: multi-delete is one batch ----
  n0 = myActs().length;
  await page(`(await import('/lib/scenegraph.js')).sceneSelect('${crate}'); (await import('/lib/base.js')).bus.emit('edit-extend', '${dup}'); return true;`);
  check("M0 two things selected", await waitFor(`import('/lib/editpanels.js').then((m) => m.selection().length === 2)`), await evalJson(`import('/lib/editpanels.js').then((m) => m.selection())`));
  await key("Delete");
  check("M1 Delete on both = ONE act, a batch of two deletes", await waitDisk(() => myActs().length === n0 + 1 && myActs().at(-1).e.verb === "batch" && myActs().at(-1).e.body.request.ops.length === 2), myActs().slice(n0).map((a) => a.e.body.request));
  check("M2 …both are gone, on disk and in the page", !disk().entities[crate] && !disk().entities[dup] && await waitFor(`import('/lib/world.js').then((m) => !m.entities.has('${crate}') && !m.entities.has('${dup}'))`));
  n0 = myActs().length;
  await key("KeyZ", { ctrlKey: true });
  check("M3 one Ctrl+Z brings both back", await waitDisk(() => myActs().length === n0 + 1 && !!disk().entities[crate] && !!disk().entities[dup]));

  // ---- S: Save as blueprint, and a copy from its tile ----
  await evalJson(`document.querySelector('.edit-tab[data-tab="build"]')?.click(), true`);
  await page(`(await import('/lib/scenegraph.js')).sceneSelect('tbl'); return true;`);
  const bf = `document.querySelector('[data-frame="build"]')`;
  check("S0 Build › Blueprints offers 'save as blueprint' for the selection", await waitFor(`[...${bf}.querySelectorAll('.sp-btn')].some((b) => /save as blueprint/.test(b.textContent) && !b.disabled)`));
  n0 = myActs().length;
  await evalJson(`[...${bf}.querySelectorAll('.sp-btn')].find((b) => /save as blueprint/.test(b.textContent)).click(), true`);
  // it asks for a name (review 10-07 S5); the person types one and saves
  check("S1a it asks for a name first", await waitFor(`!!document.querySelector('#confirm-center input')`, 3000));
  await evalJson(`(() => { const i = document.querySelector('#confirm-center input'); if (!i) return false; i.value = 'tbl'; document.querySelector('#confirm-center .cc-ok').click(); return true; })()`);
  check("S1 it is the authority's publish: ONE act", await waitDisk(() => myActs().length === n0 + 1 && myActs().at(-1).e.verb === "publish"), myActs().slice(n0).map((a) => a.e.verb));
  const lib = Object.keys(disk().entities["@world"].c).find((k) => k.startsWith("blueprints:"));
  check("S2 …this world's library has it (2 parts: the table and its cup)", !!lib && disk().entities["@world"].c[lib].parts === 2, lib && disk().entities["@world"].c[lib]);
  check("S3 …and its tile shows in 'saved here'", await waitFor(`[...${bf}.querySelectorAll('.sp-tile')].some((t) => t.textContent.trim() === 'tbl')`));
  n0 = myActs().length;
  await evalJson(`[...${bf}.querySelectorAll('.sp-tile')].find((t) => t.textContent.trim() === 'tbl').click(), true`);
  check("S4 the tile places a copy: create {from: <hash>}, ONE act", await waitDisk(() => myActs().length === n0 + 1 && myActs().at(-1).e.verb === "create" && /^sha256:/.test(myActs().at(-1).e.body.request.from)), myActs().slice(n0).map((a) => a.e.body.request));

  // ==== research 44: polish for R's first test ====

  // ---- H: the lock icon on each Hierarchy row (builders and owners toggle it; it shows others' locks live) ----
  await evalJson(`document.querySelector('.edit-tab[data-tab="hierarchy"]')?.click(), true`);
  check("H0 the crate's Hierarchy row has a lock icon, open", await waitFor(`!!${lockBtn(crate)} && !${lockBtn(crate)}.classList.contains('on') && !${lockBtn(crate)}.disabled`),
    await evalJson(`[...${hier}?.querySelectorAll('.sp-tree-row') ?? []].map((r) => r.dataset.id + ':' + (r.querySelector('.sp-lock')?.className ?? '-'))`));
  n0 = myActs().length;
  await evalJson(`${lockBtn(crate)}.click(), true`);
  check("H1 a click on it is ONE act: set lock true", await waitDisk(() => myActs().length === n0 + 1 && myActs().at(-1).e.body.request.component === "lock" && myActs().at(-1).e.body.request.id === crate && disk().entities[crate].c.lock === true), myActs().slice(n0).map((a) => a.e.body.request));
  check("H2 …and the icon reads locked", await waitFor(`${lockBtn(crate)}?.classList.contains('on')`));
  check("H3 a lock someone else set shows on its row (bob's table)", await waitFor(`${lockBtn("tbl")}?.classList.contains('on')`));
  check("(setup) bob unlocks his table", (await bobReq("delete", { id: "tbl", component: "lock" })).ok);
  check("H4 …and his unlock shows live", await waitFor(`${lockBtn("tbl")} && !${lockBtn("tbl")}.classList.contains('on')`));

  // ---- K: my own lock asks too: "This is locked. Move anyway?" with ✓ / ✕ / 🔓 ----
  await page(`(await import('/lib/scenegraph.js')).sceneSelect('${crate}'); (await import('/lib/build.js')).setTool('move'); return true;`);
  check("K0 the gizmo attaches to a thing I locked myself (the authority asks; the client no longer blocks the drag)", await waitFor(`globalThis.__gizmo?.().attached === '${crate}'`), await evalJson(`globalThis.__gizmo?.().attached ?? null`));
  const kStart = disk().entities[crate].c.transform;
  n0 = myActs().length;
  await drag(1);
  check("K1 the release asks: 'This is locked. Move anyway?'", await waitFor(`${dlgTitle} === 'This is locked. Move anyway?'`), await evalJson(dlgTitle));
  check("K2 …with three choices, in R's order", JSON.stringify(await evalJson(dlgBtns)) === JSON.stringify(["✓ Move anyway", "✕ Cancel", "🔓 Unlock"]), await evalJson(dlgBtns));
  await dlgClick("Cancel");
  check("K3 ✕ Cancel: it snaps back to where the log has it", await waitFor(`${posX(crate)}.then((x) => Math.abs(x - ${kStart.pos[0]}) < 1e-3)`), await evalJson(posX(crate)));
  await sleep(800);
  check("K4 …and nothing was written (0 acts), the lock still on", myActs().length === n0 && disk().entities[crate].c.lock === true, myActs().slice(n0).map((a) => a.e.body.request));
  await drag(1);
  await waitFor(`${dlgTitle} === 'This is locked. Move anyway?'`);
  await dlgClick("Unlock");
  check("K5 🔓 Unlock: TWO acts, the unlock and then the move (no throughLock)", await waitDisk(() => myActs().length === n0 + 2), myActs().slice(n0).map((a) => a.e.body.request));
  const [ul, mv] = myActs().slice(n0);
  check("K6 …the first deletes the lock, the second moves it; it's unlocked and 1 m along", ul?.e.verb === "delete" && ul?.e.body.request.component === "lock" && mv?.e.verb === "set" && mv?.e.body.request.throughLock === undefined
    && !("lock" in disk().entities[crate].c) && Math.abs(disk().entities[crate].c.transform.pos[0] - (kStart.pos[0] + 1)) < 1e-3, [ul?.e.body.request, mv?.e.body.request]);
  await waitFor(`globalThis.__editWrites().undo.at(-1) === ${mv?.seq}`);
  await key("KeyZ", { ctrlKey: true });
  check("K7 Ctrl+Z undoes the move first (the lock stays off)", await waitDisk(() => myActs().at(-1).e.verb === "undo" && myActs().at(-1).e.body.request.act === mv?.seq && Math.abs(disk().entities[crate].c.transform.pos[0] - kStart.pos[0]) < 1e-3 && !("lock" in disk().entities[crate].c)), myActs().at(-1)?.e.body);
  await waitFor(`globalThis.__editWrites().undo.at(-1) === ${ul?.seq}`);
  await key("KeyZ", { ctrlKey: true });
  check("K8 …and the next Ctrl+Z puts the lock back", await waitDisk(() => myActs().at(-1).e.body.request.act === ul?.seq && disk().entities[crate].c.lock === true), myActs().at(-1)?.e.body);
  n0 = myActs().length;
  await page(`(await import('/lib/scenegraph.js')).sceneSelect('${crate}'); return true;`);
  await waitFor(`import('/lib/scenegraph.js').then((m) => m.sceneSelected() === '${crate}')`);
  await key("Delete");
  check("K9 Delete on a locked thing asks 'This is locked. Delete anyway?'", await waitFor(`${dlgTitle} === 'This is locked. Delete anyway?'`), await evalJson(dlgTitle));
  check("K10 …its first choice says so", (await evalJson(dlgBtns))?.[0] === "✓ Delete anyway", await evalJson(dlgBtns));
  await dlgClick("Delete anyway");
  check("K11 ✓ Delete anyway: ONE act, the delete with throughLock", await waitDisk(() => myActs().length === n0 + 1 && myActs().at(-1).e.verb === "delete" && myActs().at(-1).e.body.request.throughLock === true && !disk().entities[crate]), myActs().slice(n0).map((a) => a.e.body.request));
  await waitFor(`globalThis.__editWrites().undo.at(-1) === ${myActs().at(-1).seq}`);
  await key("KeyZ", { ctrlKey: true });
  check("K12 Ctrl+Z brings it back, still locked", await waitDisk(() => !!disk().entities[crate] && disk().entities[crate].c.lock === true) && await waitFor(`import('/lib/world.js').then((m) => m.entities.has('${crate}'))`, 12000));

  // ---- V: a visitor (who can't lift locks) gets the refusal, no buttons ----
  { const r0 = await evalJson(`__refused.length`);
    await evalJson(`(async () => { const n = await import('/lib/net.js'); globalThis.__wasRights = n.net.myRights; n.net.myRights = { ...n.net.myRights, role: 'visitor' };
      const t = (await import('/lib/editwrites.js')).compsOf('${crate}').transform;
      globalThis.__vis = (await import('/lib/editwrites.js')).send({ verb: 'set', args: { id: '${crate}', component: 'transform', value: { ...t, pos: [t.pos[0] + 2, t.pos[1], t.pos[2]] } } }, { what: 'move ${crate}' });
      return true; })()`);
    const refusedV = await waitFor(`__refused.length > ${r0} && __refused.at(-1).refused.code === 'locked'`);
    const dialogV = await evalJson(`!!document.querySelector('#confirm-center')`);
    check("V1 a visitor's move of a locked thing: the refusal, in a person's words (the agents' beside them), and no dialog", refusedV && !dialogV && /^Couldn't move/.test(await evalJson(`__refused.at(-1).text`)) && (await evalJson(`__refused.at(-1).agentText`))?.startsWith(`move ${crate} refused by the authority (locked)`), { dialogV, last: await evalJson(`__refused.at(-1)`) });
    if (dialogV) await dlgClick("Cancel");
    await page(`const n = await import('/lib/net.js'); n.net.myRights = { ...globalThis.__wasRights, role: 'visitor' }; (await import('/lib/base.js')).bus.emit('your-rights', n.net.myRights); return true;`);
    check("V2 …and its Hierarchy lock icons can't be clicked", await waitFor(`${lockBtn(crate)}?.disabled === true`), await evalJson(`${lockBtn(crate)}?.outerHTML ?? null`));
    await page(`const n = await import('/lib/net.js'); n.net.myRights = globalThis.__wasRights; (await import('/lib/base.js')).bus.emit('your-rights', n.net.myRights); return true;`);
    check("V3 an owner's are clickable again", await waitFor(`${lockBtn(crate)}?.disabled === false`)); }

  // ---- F: the mesh drag of a mounted child moves it in the world's frame (the old frame bug) ----
  // A low plinth (below eye level, so its top is what the pointer meets), turned 90° and scaled 0.6×, with a pebble
  // riding it. The drag keeps its grab offset in WORLD space, so the pebble's world displacement equals the pointer's
  // on the plinth's top. The old code added a world point to a local offset and set it as the local position (so the
  // pebble moved by R·0.6·that, the wrong way), and its ray could hit the pebble itself (it is drawn inside the plinth).
  { const roots = Object.keys(disk().entities).filter((k) => k !== "@world" && !disk().entities[k].c.parent);
    check("(setup) bob clears the field (everything placed so far, through its locks), so only the plinth is under the pointer", (await bobReq("batch", { ops: roots.map((id) => ({ verb: "delete", args: { id } })), throughLock: true })).ok, roots);
    // the view must hold still while the test aims (the body may still be settling, and the camera chases it)
    const camNow = () => evalJson(`import('/lib/core.js').then((c) => { c.camera.updateMatrixWorld(); return c.camera.matrixWorld.elements.map((v) => +v.toFixed(4)).join(); })`);
    const settle = async () => { let last = await camNow(), same = 0; for (let i = 0; i < 60 && same < 5; i++) { await sleep(200); const now = await camNow(); same = now === last ? same + 1 : 0; last = now; } return same >= 5; };
    check("(setup) the view holds still", await settle());
    // the nearest spot ahead where both the plinth's foot and the pebble on it are in view
    const G = await evalJson(`import('/lib/core.js').then((c) => { const T = c.THREE; const cam = c.camera; const f = cam.getWorldDirection(new T.Vector3()); f.y = 0; f.normalize();
      const o = cam.getWorldPosition(new T.Vector3());
      for (let d = 3; d <= 24; d += 0.5) { const g = o.clone().addScaledVector(f, d); g.y = 0;
        if ([g.clone().project(cam), g.clone().setY(1.6).project(cam)].every((s) => Math.abs(s.x) < 0.8 && Math.abs(s.y) < 0.8 && s.z < 1)) return [g.x, g.z]; }
      return { cam: o.toArray(), dir: cam.getWorldDirection(new T.Vector3()).toArray() }; })`);
    check("(setup) a spot in view for the plinth", Array.isArray(G), G);
    const [px, pz] = Array.isArray(G) ? G : [start.pos[0] - 3, start.pos[2]];
    check("(setup) bob builds a low plinth (turned 90°, scaled 0.6×) with a pebble on it", (await bobReq("create", { id: "plinth", model: CRATE, components: { transform: { pos: [px, 0, pz], q: [0, Math.SQRT1_2, 0, Math.SQRT1_2], scale: [0.6, 0.6, 0.6] } } })).ok
      && (await bobReq("create", { id: "pebble", model: CRATE, components: { transform: { pos: [0.25, 1.9, 0.25], scale: [0.4, 0.4, 0.4] }, parent: { to: "plinth", order: "a0" } } })).ok);
    check("F0 the page has the pebble on the plinth", await waitFor(`import('/lib/world.js').then((m) => m.entities.get('pebble')?.userData?.mountedTo === 'plinth')`, 12000));
    await sleep(600);
    // the test's own ray, as build.js aims: the first thing under a screen point that isn't the pebble, if it's the
    // plinth's top (a face pointing up). P = the pebble's world position. press: a point ON the pebble whose ray, past
    // the pebble, meets the plinth's top (its middle may look past the plinth's far edge, to the ground)
    await evalJson(`Promise.all([import('/lib/core.js'), import('/lib/world.js')]).then(([c, w]) => { const T = c.THREE;
      const inside = (o, r) => { for (let q = o; q; q = q.parent) if (q === r) return true; return false; };
      globalThis.__geoF = (x, y) => { const peb = w.entities.get('pebble'), pl = w.entities.get('plinth'); const P = peb.getWorldPosition(new T.Vector3());
        const rc = new T.Raycaster(); rc.setFromCamera(new T.Vector2(x / innerWidth * 2 - 1, -(y / innerHeight) * 2 + 1), c.camera);
        const hs = rc.intersectObjects([...w.entities.values()].filter(Boolean), true);
        const h = hs.find((h) => !inside(h.object, peb)); const top = h && h.face && h.face.normal.clone().transformDirection(h.object.matrixWorld).y > 0.6 && inside(h.object, pl);
        return { P: P.toArray(), A: top ? h.point.toArray() : null, onPebble: !!hs[0] && inside(hs[0].object, peb) }; };
      // every whole pixel (a MouseEvent's clientX is one) over the pebble's drawn box that qualifies as a press point;
      // the one nearest their middle, away from the edges where a sub-pixel would flip the hit
      globalThis.__pressF = () => { const peb = w.entities.get('pebble'); const b = new T.Box3().setFromObject(peb); const xs = [], ys = [];
        for (const cx of [b.min.x, b.max.x]) for (const cy of [b.min.y, b.max.y]) for (const cz of [b.min.z, b.max.z]) { const s = new T.Vector3(cx, cy, cz).project(c.camera); xs.push((s.x + 1) / 2 * innerWidth); ys.push((1 - s.y) / 2 * innerHeight); }
        const ok = []; for (let y = Math.ceil(Math.min(...ys)); y <= Math.max(...ys); y += 2) for (let x = Math.ceil(Math.min(...xs)); x <= Math.max(...xs); x += 2) { const g = __geoF(x, y); if (g.onPebble && g.A) ok.push({ xy: [x, y], g }); }
        if (!ok.length) return null; const mx = ok.reduce((a, o) => a + o.xy[0], 0) / ok.length, my = ok.reduce((a, o) => a + o.xy[1], 0) / ok.length;
        return ok.reduce((best, o) => (Math.hypot(o.xy[0] - mx, o.xy[1] - my) < Math.hypot(best.xy[0] - mx, best.xy[1] - my) ? o : best)); };
      return true; })`);
    const geo = (x: number, y: number) => evalJson(`__geoF(${x}, ${y})`);
    const findPress = () => evalJson(`__pressF()`);
    await settle();
    const pr = await findPress(); const at = pr?.xy ?? null; const press = pr?.g;
    // two pointer points over the plinth's top: past the drag's 4 px slop, then a small move on
    let m0: any = null, m1: any = null, A0: any = null, A1: any = null;
    for (const [dx, dy] of [[0, 6], [6, 0], [-6, 0], [0, -6], [5, 5], [-5, 5], [5, -5], [-5, -5]]) { if (!at || m0) break; const c = [at[0] + dx, at[1] + dy]; const a = (await geo(c[0], c[1])).A; if (a) { m0 = c; A0 = a; } }
    for (const [dx, dy] of [[10, 4], [-10, 4], [10, -4], [-10, -4], [4, 10], [-4, 10], [4, -10], [-4, -10]]) { if (!m0 || m1) break; const c = [m0[0] + dx, m0[1] + dy]; const a = (await geo(c[0], c[1])).A; if (a && Math.hypot(a[0] - A0[0], a[2] - A0[2]) > 0.03) { m1 = c; A1 = a; } }
    const fOk = !!at && !!A0 && !!A1;
    check("(setup) a press point on the pebble, and two pointer points over the plinth's top", fOk, { press, at, m0, m1, A0, A1 });
    if (fOk) {
    await page(`(await import('/lib/build.js')).setTool('move'); return true;`);
    await evalJson(`import('/lib/core.js').then((m) => (m.canvas.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, clientX: ${at?.[0]}, clientY: ${at?.[1]} })), true))`);
    check("F1 a press on the pebble selects it", await waitFor(`import('/lib/scenegraph.js').then((m) => m.sceneSelected() === 'pebble')`));
    const move = (m: number[]) => evalJson(`(dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: ${m?.[0]}, clientY: ${m?.[1]} })), true)`);
    await move(m0); await sleep(400);
    const p0 = (await geo(0, 0)).P;
    await move(m1); await sleep(400);
    const p1 = (await geo(0, 0)).P;
    const d = (u: number[], v: number[]) => [u[0] - v[0], u[1] - v[1], u[2] - v[2]];
    const dp = d(p1, p0), da = A0 && A1 ? d(A1, A0) : null;
    check("F2 the pebble follows the pointer in the world's frame: its move = the pointer's on the plinth's top", !!da && Math.hypot(...d(dp, da)) < 0.02 && Math.hypot(...da) > 0.03, { dp, da, A0, A1, drag: await evalJson(`globalThis.__buildDrag?.()`) });
    check("F3 …and the drag doesn't jump when it starts: the pebble keeps its offset from the point under the pointer (the old ray found the pebble itself)", !!A0 && !!press && Math.hypot(...d(d(p0, A0), d(press.P, press.A))) < 0.02, { p0, A0, press });
    n0 = myActs().length;
    await evalJson(`(dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: ${m1?.[0]}, clientY: ${m1?.[1]} })), true)`);
    check("F4 release = ONE act: set the pebble's transform (local to the plinth), expecting where it was", await waitDisk(() => myActs().length === n0 + 1 && myActs().at(-1).e.verb === "set" && myActs().at(-1).e.body.request.id === "pebble" && !!myActs().at(-1).e.body.request.expect), myActs().slice(n0).map((a) => a.e.body.request));
    await sleep(800);
    const pAfter = (await geo(0, 0)).P;
    check("F5 …and once the authority's echo is drawn, the pebble is where the drag left it", Math.hypot(...d(pAfter, p1)) < 0.02, { pAfter, p1 });
    // a mesh drag of a thing I locked asks too (the old client stopped it before the authority was asked)
    check("(setup) I lock the pebble", (await page(`return (await (await import('/lib/editwrites.js')).lock('pebble', true)).ok;`)) === true);
    n0 = myActs().length;
    await settle();
    const g2 = (await findPress())?.xy ?? at;
    await evalJson(`import('/lib/core.js').then((m) => (m.canvas.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, clientX: ${g2?.[0]}, clientY: ${g2?.[1]} })), true))`);
    await move([g2?.[0] + 10, g2?.[1] + 8]);
    await sleep(400);
    await evalJson(`(dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: ${g2?.[0] + 10}, clientY: ${g2?.[1] + 8} })), true)`);
    check("F6 a mesh drag of my locked pebble asks 'Move anyway?'", await waitFor(`${dlgTitle} === 'This is locked. Move anyway?'`), await evalJson(dlgTitle));
    await dlgClick("Cancel");
    check("F7 ✕ Cancel puts it back, and nothing is written", await waitFor(`import('/lib/world.js').then((m) => { const p = m.entities.get('pebble').getWorldPosition(new (m.entities.get('pebble').position.constructor)()); return Math.hypot(p.x - ${pAfter[0]}, p.y - ${pAfter[1]}, p.z - ${pAfter[2]}) < 0.02; })`) && (await sleep(600), myActs().length === n0), myActs().slice(n0).map((a) => a.e.body.request)); } }
  await evalJson(`document.querySelector('#confirm-center .cc-no')?.click(), true`);   // a dialog a failed check left open would hold the keys

  // ---- I: the Inspector, as R asked on 10-04 (name first, id dim, no lib/filter/parent rows, one Add Component pop-out) ----
  const insp = `document.querySelector('[data-frame="inspector"]')`;
  await page(`(await import('/lib/scenegraph.js')).sceneSelect('pebble'); return true;`);
  await waitFor(`import('/lib/scenegraph.js').then((m) => m.sceneSelected() === 'pebble')`);
  await sleep(600);
  const labels = await evalJson(`[...${insp}.querySelectorAll('.sp-row .sp-label')].map((l) => l.textContent)`);
  // R 10-10 23:48: the name is the first line's title (no label; the eye and padlock beside it), then the id; R 10-12: the
  // ENABLED box leads that line
  const firstIsTitle = await evalJson(`(() => { const r = [...${insp}.querySelectorAll('.sp-row')]; return r[0]?.classList.contains('sp-enabled') && r[1]?.classList.contains('sp-title'); })()`);
  check("I1 the Inspector leads with the ENABLED box and the name (its title line), then the id", firstIsTitle && labels?.[0] === "" && labels?.[1] === "" && labels?.[2] === "id", { firstIsTitle, labels: labels?.slice(0, 3) });
  // R 10-10: parent moved to the Attributes tab ("I don't think we should show 'parent' here at all - this seems like a Hierarchy thing")
  check("I2 …no lib line (the Model card has it), no filter box; no Parent card (it lives in Attributes now)", !labels?.includes("lib") && !(await evalJson(`!!${insp}.querySelector('input[placeholder^="filter"]')`)) && !labels?.includes("parent") && !labels?.includes("children") && !labels?.includes("on"), labels);
  check("I3 …placed by names who made it (the authority's inspect, as an agent asks it)", await waitFor(`[...${insp}.querySelectorAll('.sp-row')].some((r) => r.querySelector('.sp-label')?.textContent === 'placed by' && r.textContent.includes('bob'))`), await evalJson(`[...${insp}.querySelectorAll('.sp-row')].map((r) => r.textContent).slice(0, 5)`));
  check("I4 …rotation order sits inside the folded Advanced group, not in the main Transform", await evalJson(`![...${insp}.querySelectorAll('.sp-row .sp-label')].some((l) => /order/i.test(l.textContent))`), labels);
  check("I5 Add Component is ONE button", await evalJson(`[...${insp}.querySelectorAll('.sp-pop-btn')].length === 1 && ![...${insp}.querySelectorAll('.sp-btn')].some((b) => /^\\+ (Light|Pendulum|Spin)/.test(b.textContent))`), await evalJson(`[...${insp}.querySelectorAll('.sp-btn')].map((b) => b.textContent)`));
  await evalJson(`${insp}.querySelector('.sp-pop-btn').click(), true`);
  check("I6 …it opens a searchable list, focused", await waitFor(`document.activeElement?.classList.contains('sp-pop-search')`));
  await evalJson(`(() => { const i = document.querySelector('.sp-pop-search'); i.value = 'swi'; i.dispatchEvent(new Event('input')); return true; })()`);
  const swi = await evalJson(`[...document.querySelectorAll('.sp-pop-item')].map((b) => b.textContent)`);
  check("I7 …'swi' finds the swinging one (by its description)", swi?.length > 0 && swi.some((t) => /pendulum/i.test(t)), swi);
  await evalJson(`document.querySelector('.sp-pop-search').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })), true`);
  check("I8 …Esc closes it", await waitFor(`!document.querySelector('.sp-pop')`));
  // G on a thing that rides another: the handles come up (R: "g/e/r doesn't always bring up the controls")
  await page(`(await import('/lib/scenegraph.js')).sceneSelect('pebble'); (await import('/lib/build.js')).setTool('select'); return true;`);
  await key("KeyG"); await sleep(400);
  check("I9 G on the pebble (it rides another thing) brings up the move handles", await evalJson(`__gizmo().attached === 'pebble' && __gizmo().mode === 'translate'`), await evalJson(`({ a: __gizmo().attached, m: __gizmo().mode })`));
  await key("KeyE"); await sleep(400);
  check("I10 …and E the rotate handles", await evalJson(`__gizmo().attached === 'pebble' && __gizmo().mode === 'rotate'`), await evalJson(`({ a: __gizmo().attached, m: __gizmo().mode })`));
  await page(`(await import('/lib/build.js')).setTool('select'); return true;`);
  // the Transform card's padlock follows the lock (R: "a padlock next to Transform regardless of its lock status")
  const tfLock = `[...${insp}.querySelectorAll('.sp-group')].find((g) => /Transform/.test(g.textContent))?.querySelector('.sp-ico') != null`;
  await page(`await (await import('/lib/editwrites.js')).lock('pebble', true); return true;`);
  check("I11 a locked thing's Transform card shows the padlock", await waitFor(tfLock), await evalJson(`[...${insp}.querySelectorAll('.sp-group')].map((g) => g.innerHTML.slice(0, 80))`));
  await page(`await (await import('/lib/editwrites.js')).lock('pebble', false); return true;`);
  check("I12 …and unlocking takes it away", await waitFor(`!(${tfLock})`), await evalJson(`[...${insp}.querySelectorAll('.sp-group')].map((g) => g.innerHTML.slice(0, 80))`));

  // three-axis scale (R 10-04): the wire always had [x,y,z]; the page now edits, draws and keeps it
  const sLabels = await evalJson(`[...${insp}.querySelectorAll('.sp-row .sp-label')].map((l) => l.textContent).filter((t) => /scale/.test(t))`);
  check("I13 the Transform shows scale x / y / z", JSON.stringify(sLabels) === JSON.stringify(["scale x", "scale y", "scale z"]), sLabels);
  await page(`(await import('/lib/inspect.js')).commitEdit('pebble', 'pos.sx', 2); return true;`);
  check("I14 …editing scale x writes [2, y, z] to the log (one act)", await waitDisk(() => { const sc = disk().entities.pebble?.c.transform.scale; return sc && sc[0] === 2 && sc[1] !== 2; }), disk().entities.pebble?.c.transform);
  check("I15 …and the page draws it stretched, not uniform", await waitFor(`import('/lib/world.js').then((m) => { const s = m.entities.get('pebble').scale; return Math.abs(s.x - 2) < 1e-6 && Math.abs(s.y - 0.4) < 1e-6 && s.y === s.z; })`), await evalJson(`import('/lib/world.js').then((m) => m.entities.get('pebble').scale.toArray())`));

  // R 10-04: a reload made in edit mode came back with the edit frames floating, squashed, outside edit mode. An edit
  // frame whose saved state says "shown" (saved while docked) must still start hidden; edit mode alone opens it.
  const reborn = await page(`localStorage.setItem('ew-frame-zz-edit', JSON.stringify({ x: 60, y: 60, w: 300, h: 12, hidden: false }));
    localStorage.setItem('ew-frame-zz-plain', JSON.stringify({ x: 60, y: 60, w: 300, h: 200, hidden: false }));
    const F = await import('/lib/windows.js');
    const e = F.makeFrame('zz-edit', { title: 'zz', className: 'edit' }), p = F.makeFrame('zz-plain', { title: 'zz' });
    const r = { edit: e.visible, plain: p.visible }; e.el.remove(); p.el.remove(); return JSON.stringify(r);`);
  check("R1 an edit frame saved 'shown' starts hidden after a reload (a plain frame keeps its saved state)", reborn === JSON.stringify({ edit: false, plain: true }), reborn);

  // the World row: its name big (the protocol keeps it on @world.about), @world small (R 10-04: "World and (@world)?")
  const wrow = await evalJson(`document.querySelector('[data-frame="hierarchy"] .sp-item')?.textContent ?? null`);
  check("W1 the Hierarchy's World row reads WORLD then its name (one line, 38b82c6a), not '(@world)'", /^World\s*client check/.test(wrow ?? "") && !wrow.includes("@world"), wrow);

  // transform space (R 10-04: "gimbal/object/world rotations... a way to switch between them")
  await page(`(await import('/lib/scenegraph.js')).sceneSelect('pebble'); const B = await import('/lib/build.js'); B.setSpace('rotate', 'world'); B.setTool('select'); return true;`);
  await key("KeyE"); await sleep(300);
  const sp0 = await evalJson(`({ s: __gizmo().controls?.space, a: __gizmo().attached })`);
  await key("KeyE"); await sleep(400);
  const sp1 = await evalJson(`import('/lib/build.js').then((B) => ({ tool: B.getTool(), space: B.getSpace('rotate'), gizmo: __gizmo().controls?.space }))`);
  check("T1 E then E again: rotate switches to the thing's own axes, and the gizmo follows", sp0?.s === "world" && sp1?.tool === "rotate" && sp1?.space === "object" && sp1?.gizmo === "local", { sp0, sp1 });
  await key("KeyE"); await sleep(400);
  check("T2 …and E once more goes back to world axes", await evalJson(`import('/lib/build.js').then((B) => B.getSpace('rotate') === 'world' && __gizmo().controls?.space === 'world')`));
  await evalJson(`(document.querySelector('.edit-tool[data-tool="move"]')?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })), true)`);
  const menuRows = await evalJson(`[...document.querySelectorAll('.edit-space-pop .edit-menu-item')].map((r) => r.textContent)`);
  check("T3 right-click on the move tool lists its spaces", JSON.stringify(menuRows) === JSON.stringify(["● world axes", "○ object axes"]), menuRows);
  await evalJson(`[...document.querySelectorAll('.edit-space-pop .edit-menu-item')].find((r) => /object/.test(r.textContent))?.click(), true`);
  check("T4 …picking 'object axes' arms move in the thing's own axes", await waitFor(`import('/lib/build.js').then((B) => B.getTool() === 'move' && B.getSpace('move') === 'object' && __gizmo().controls?.space === 'local')`), await evalJson(`import('/lib/build.js').then((B) => ({ t: B.getTool(), s: B.getSpace('move'), g: __gizmo().controls?.space }))`));
  await page(`const B = await import('/lib/build.js'); B.setSpace('move', 'world'); B.setSpace('rotate', 'world'); B.setTool('select'); return true;`);

  // the pivot (research 52): handles sit at the pivot, and a turn goes ABOUT it (the thing swings round, not in place)
  check("(setup) a crate 'pv' with its pivot 1 m along its own x", (await bobReq("create", { id: "pv", model: CRATE, components: { transform: { pos: [10, 0, 10], q: [0, 0, 0, 1], scale: [1, 1, 1] }, pivot: { pos: [1, 0, 0] } } })).ok);
  await waitFor(`import('/lib/world.js').then((m) => !!m.entities.get('pv') && !!m.bagOf('pv')?.pivot)`, 12000);
  await page(`(await import('/lib/scenegraph.js')).sceneSelect('pv'); (await import('/lib/build.js')).setTool('rotate'); return true;`);
  check("PV1 the rotate handles sit at the pivot (11, 0, 10), not the origin", await waitFor(`(() => { const g = __gizmo(); return g.attached === 'pv' && g.viaProxy && Math.abs(g.proxyPos[0] - 11) < 1e-6 && Math.abs(g.proxyPos[2] - 10) < 1e-6; })()`), await evalJson(`__gizmo().proxyPos`));
  const nPv = myActs().length;
  await evalJson(`(() => { const c = __gizmo().controls; c.dispatchEvent({ type: 'dragging-changed', value: true });
    c.object.quaternion.setFromAxisAngle({ x: 0, y: 1, z: 0, isVector3: true, clone() { return this; } }, Math.PI / 2); c.object.updateMatrixWorld(true);
    c.dispatchEvent({ type: 'objectChange' }); c.dispatchEvent({ type: 'dragging-changed', value: false }); return true; })()`);
  check("PV2 a quarter turn about the pivot is ONE act", await waitDisk(() => myActs().length === nPv + 1), myActs().slice(nPv).map((a) => a.e.verb));
  const pvT = disk().entities.pv?.c.transform;
  check("PV3 …the crate swung round the pivot: its origin went from (10, 0, 10) to (11, 0, 11)", pvT && Math.abs(pvT.pos[0] - 11) < 1e-3 && Math.abs(pvT.pos[2] - 11) < 1e-3, pvT);
  check("PV4 …and the pivot itself stayed where it was (11, 0, 10)", await waitFor(`(() => { const g = __gizmo(); return Math.abs(g.proxyPos[0] - 11) < 1e-3 && Math.abs(g.proxyPos[2] - 10) < 1e-3; })()`), await evalJson(`__gizmo().proxyPos`));
  await page(`(await import('/lib/build.js')).setTool('select'); return true;`);

  // the pivot tool (P): drag the pivot itself; it snaps to the model's centre; the thing never moves
  check("(setup) a crate 'pt' with no pivot", (await bobReq("create", { id: "pt", model: CRATE, components: { transform: { pos: [14, 0, 10], q: [0, 0, 0, 1], scale: [1, 1, 1] } } })).ok);
  await waitFor(`import('/lib/world.js').then((m) => !!m.entities.get('pt'))`, 12000);
  await page(`(await import('/lib/scenegraph.js')).sceneSelect('pt'); (await import('/lib/build.js')).setTool('select'); return true;`);
  await key("KeyP"); await sleep(400);
  check("PT1 P arms the pivot tool: the handles sit at its origin (no pivot yet)", await waitFor(`import('/lib/build.js').then((B) => { const g = __gizmo(); return B.getTool() === 'pivot' && g.attached === 'pt' && g.viaProxy && Math.abs(g.proxyPos[0] - 14) < 1e-6 && Math.abs(g.proxyPos[2] - 10) < 1e-6; })`), await evalJson(`({ g: __gizmo().proxyPos, a: __gizmo().attached })`));
  const ptBefore = JSON.stringify(disk().entities.pt.c.transform);
  const nPt = myActs().length;
  const centre = await page(`const W = await import('/lib/world.js'); const M = await import('/lib/realize/models.js'); const S = await import('/lib/state.js');
    const box = M.boxOf('pt'); const mid = [0, 1, 2].map((i) => (box[0][i] + box[1][i]) / 2);
    const o = W.entities.get('pt'); o.updateWorldMatrix(true, false); const c = __gizmo().controls; c.dispatchEvent({ type: 'dragging-changed', value: true });
    c.object.position.set(mid[0] + 0.05, mid[1] + 0.03, mid[2]).applyMatrix4(o.matrixWorld); c.object.updateMatrixWorld(true);
    c.dispatchEvent({ type: 'objectChange' }); c.dispatchEvent({ type: 'dragging-changed', value: false }); return JSON.stringify(mid.map((v) => Math.round(v * 1e4) / 1e4));`);
  check("PT2 releasing near the middle snaps the pivot to the model's centre: ONE pivot write", await waitDisk(() => myActs().length === nPt + 1 && JSON.stringify(disk().entities.pt?.c.pivot?.pos) === centre), { centre, pivot: disk().entities.pt?.c.pivot, acts: myActs().slice(nPt).map((a) => a.e.body?.request) });
  check("PT3 …and the crate itself did not move", JSON.stringify(disk().entities.pt.c.transform) === ptBefore, [ptBefore, disk().entities.pt.c.transform]);
  await page(`(await import('/lib/build.js')).setTool('select'); return true;`);

  // 👁 Hidden in MY view (R 10-04: "Hidden" is the local one; research 51): never logged, and you can't lose track of it
  const eyeOf = (id: string) => `[...${hier}.querySelectorAll('.sp-tree-row')].find((r) => r.dataset.id === ${JSON.stringify(id)})?.querySelector('.sp-eye')`;
  const nEye = entries().length;
  await evalJson(`(${eyeOf("pt")}?.click(), true)`);
  check("E1 the row's eye hides it in my view (not drawn here)", await waitFor(`import('/lib/world.js').then((m) => m.entities.get('pt')?.visible === false)`), await evalJson(`import('/lib/world.js').then((m) => m.entities.get('pt')?.visible)`));
  await sleep(500);
  check("E2 …and writes NOTHING to the world (a view filter, never logged)", entries().length === nEye && !disk().entities.pt.c.hidden, entries().length - nEye);
  check("E3 …the Hierarchy says so: '1 hidden in your view · show all'", await waitFor(`[...${hier}.querySelectorAll('.sp-btn')].some((b) => /1 hidden in your view/.test(b.textContent))`), await evalJson(`[...${hier}.querySelectorAll('.sp-btn')].map((b) => b.textContent)`));
  await evalJson(`[...${hier}.querySelectorAll('.sp-btn')].find((b) => /hidden in your view/.test(b.textContent))?.click(), true`);
  check("E4 …and 'show all' brings it back", await waitFor(`import('/lib/world.js').then((m) => m.entities.get('pt')?.visible === true)`));

  // scrub feel (R 10-04: Maya's Channel Box speed + hyperbolic icons) and findable modifiers ("SOOOO much hidden knowledge")
  const feel0 = await evalJson(`[...document.querySelectorAll('[data-frame="inspector"] .sp-scrubfeel')].map((b) => b.textContent)`);
  check("SF1 the Inspector header has the scrub-feel dials: speed and accelerating (default medium, accelerating)", JSON.stringify(feel0) === JSON.stringify(["med", "accel"]), feel0);
  await evalJson(`(document.querySelector('[data-frame="inspector"] .sp-scrub-speed').click(), true)`);
  check("SF2 …clicking speed steps it (medium → fast), and it's remembered per viewer", await evalJson(`document.querySelector('[data-frame="inspector"] .sp-scrub-speed').textContent === 'fast' && JSON.parse(localStorage.getItem('ew-scrub-feel')).speed === 'fast'`));
  await evalJson(`(() => { const b = document.querySelector('[data-frame="inspector"] .sp-scrub-speed'); b.click(); b.click(); return true; })()`);
  const tips = await evalJson(`[...document.querySelectorAll('[data-frame="inspector"] .sp-f-num')].filter((r) => !r.classList.contains('disabled')).map((r) => r.title)`);
  check("SF3 every editable number says its modifiers in its tooltip (Shift finer · Ctrl whole numbers)", tips?.length > 0 && tips.every((t) => /Shift finer/.test(t) && /Ctrl whole numbers/.test(t)), tips?.slice(0, 2));
  const travel = await page(`const P = await import('/lib/panels.js'); const a = P.scrubTravel(300); P.setScrubFeel({ accel: false }); const l = P.scrubTravel(300); P.setScrubFeel({ accel: true }); return JSON.stringify([a, l]);`);
  check("SF4 accelerating travels further than linear on a long drag (300 px)", JSON.parse(travel)[0] > JSON.parse(travel)[1] * 2, travel);

  // keyhints (R 10-04): before = tooltip, during = the status line at the bottom
  const moveTip = await evalJson(`document.querySelector('.edit-tool[data-tool="move"]')?.title ?? ''`);
  check("KH1 the move tool's tooltip says the gizmo's hidden key (hold Ctrl to snap) and the tool letters", /hold Ctrl to snap/.test(moveTip) && /P pivot/.test(moveTip), moveTip);
  await page(`(await import('/lib/scenegraph.js')).sceneSelect('pebble'); return true;`); await sleep(500);
  await evalJson(`(() => { const n = [...document.querySelectorAll('[data-frame="inspector"] .sp-f-num .sp-num')].find((x) => !x.disabled); const r = n.getBoundingClientRect();
    n.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerId: 7, clientX: r.left + 5, clientY: r.top + 5 }));
    n.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerId: 7, clientX: r.left + 30, clientY: r.top + 5 })); return true; })()`);
  const during = await evalJson(`document.getElementById('hintbar')?.textContent ?? ''`);
  check("KH2 while scrubbing, the status line says the keys (Shift finer · Ctrl whole numbers)", /Shift finer/.test(during) && /Ctrl whole numbers/.test(during), during);
  await evalJson(`(() => { const n = [...document.querySelectorAll('[data-frame="inspector"] .sp-f-num .sp-num')].find((x) => !x.disabled); n.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 7 })); return true; })()`);
  await sleep(300);
  check("KH3 …and gives the bar back when the drag ends", await evalJson(`!/Shift finer/.test(document.getElementById('hintbar')?.textContent ?? '') || document.getElementById('hintbar').classList.contains('gone')`), await evalJson(`document.getElementById('hintbar')?.textContent`));

  // Ctrl+D duplicates (R 10-04: "isn't it usually ctrl+d?"), the held D never strafes, and copy #2 nudges toward blueprints
  await page(`(await import('/lib/scenegraph.js')).sceneSelect('pt'); return true;`); await sleep(300);
  const nD = myActs().length;
  const me0 = await evalJson(`import('/lib/controller.js').then((m) => [m.myState.pos.x, m.myState.pos.y, m.myState.pos.z])`);
  await evalJson(`(dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyD', key: 'd', ctrlKey: true, bubbles: true, cancelable: true })), true)`);
  await sleep(400);
  const heldD = await evalJson(`import('/lib/controller.js').then((m) => m.keys.has('KeyD'))`);   // the walk reads this set
  await evalJson(`(dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyD', key: 'd', ctrlKey: true, bubbles: true })), true)`);
  check("CD1 Ctrl+D = create {from: pt}: ONE act", await waitDisk(() => myActs().length === nD + 1 && myActs().at(-1).e.body.request.from === "pt"), myActs().slice(nD).map((a) => a.e.body?.request));
  const me1 = await evalJson(`import('/lib/controller.js').then((m) => [m.myState.pos.x, m.myState.pos.y, m.myState.pos.z])`);
  check("CD2 …and the chord never counts as a held D, so it can't strafe the body (the walk reads the held set)", heldD === false && Math.hypot(me1[0] - me0[0], me1[2] - me0[2]) < 0.05, { heldD, me0, me1 });
  await sleep(600);   // the first copy reselects ITSELF 400 ms after it lands (editpanels duplicate): let that happen first
  await page(`(await import('/lib/scenegraph.js')).sceneSelect('pt'); return true;`);
  await waitFor(`import('/lib/scenegraph.js').then((m) => m.sceneSelected() === 'pt')`, 3000);
  await key("KeyD", { ctrlKey: true });
  check("CD3 the second copy of the same unlinked thing says copies are independent, and points at Save as blueprint", await waitFor(`/independent/.test(document.getElementById('hintbar')?.textContent ?? '') && /Save as blueprint/.test(document.getElementById('hintbar').textContent)`, 4000), await evalJson(`document.getElementById('hintbar')?.textContent`));

  // where a value came from (R 10-04): each card's tooltip says who last set it and when, and the cards end in "last change"
  await page(`(await import('/lib/scenegraph.js')).sceneSelect('pt'); return true;`);
  const provOK = await waitFor(`(() => { const g = [...document.querySelectorAll('[data-frame="inspector"] .sp-group')].find((b) => /Transform/.test(b.textContent)); const row = g?.closest('[title]'); return !!row && /(set by|as made by) .+ · (just now|\\d+ min ago)/.test(row.title); })()`, 6000);
  check("PR1 the Transform card's tooltip says who last set it, and when", provOK, await evalJson(`[...document.querySelectorAll('[data-frame="inspector"] .sp-group')].find((b) => /Transform/.test(b.textContent))?.closest('[title]')?.title`));
  check("PR2 the cards end in one 'last change' line (the doorway to History)", await waitFor(`[...document.querySelectorAll('[data-frame="inspector"] .sp-row, [data-frame="inspector"] [class*="sp-f"]')].some((r) => /last change/.test(r.textContent) && /(just now|min ago)/.test(r.textContent))`, 4000), await evalJson(`[...document.querySelectorAll('[data-frame="inspector"] *')].map((r) => r.textContent).find((t) => /last change/.test(t))`));

  // drivers are ordinary cards; a driven field's ~ leads to its driver (R 10-04: follow Blender/Unity/Godot/Roblox/Resonite)
  const mset = await page(`const r = await (await import('/lib/net.js')).sendRequest('set', { id: 'pt', component: 'motion', value: { type: 'pendulum', axis: [0, 0, 1], amp: 0.1, period: 3 } }); return JSON.stringify(r?.ok);`);
  await sleep(600);   // a duplicate earlier in the run reselects its copy after 400 ms (editpanels duplicate); let that land first
  await page(`(await import('/lib/scenegraph.js')).sceneSelect('pt'); return true;`);
  await waitFor(`import('/lib/scenegraph.js').then((m) => m.sceneSelected() === 'pt')`, 3000);
  await waitFor(`!!document.querySelector('[data-frame="inspector"] .sp-drv')`, 5000);
  // fold the Motion card first, so the jump has to open it
  await evalJson(`(() => { const h = [...document.querySelectorAll('[data-frame="inspector"] .sp-group')].find((b) => /Pendulum/.test(b.textContent)); if (h && /▾/.test(h.textContent)) h.click(); return true; })()`);
  check("DR0 (setup) the Pendulum card starts folded", await waitFor(`[...document.querySelectorAll('[data-frame="inspector"] .sp-group')].some((b) => /▸\\s*Pendulum/.test(b.textContent))`, 2000));
  await sleep(300);
  const drv = await evalJson(`document.querySelector('[data-frame="inspector"] .sp-drv')?.title ?? null`);
  check("DR1 a driven channel's ~ says what drives it, and that a click goes there", /driven by its Pendulum \(motion\) — click to go to its card/.test(drv ?? ""), { mset, drv });
  await evalJson(`(document.querySelector('[data-frame="inspector"] .sp-drv')?.click(), true)`);
  check("DR2 …clicking it opens the Pendulum card (it was folded)", await waitFor(`[...document.querySelectorAll('[data-frame="inspector"] .sp-group')].some((b) => /▾\\s*Pendulum/.test(b.textContent))`, 3000), await evalJson(`[...document.querySelectorAll('[data-frame="inspector"] .sp-group')].map((b) => b.textContent)`));
  await page(`await (await import('/lib/net.js')).sendRequest('delete', { id: 'pt', component: 'motion' }); return true;`);

  // History (R 10-04, research 56): a tab beside the Inspector; the 'last change' line opens it; one thing's acts, Older… pages
  await page(`(await import('/lib/scenegraph.js')).sceneSelect('pt'); return true;`);
  await waitFor(`import('/lib/scenegraph.js').then((m) => m.sceneSelected() === 'pt')`, 3000);
  check("HT1 the right column has Inspector | Attributes | History tabs (Attributes: R 10-10)", await evalJson(`JSON.stringify([...document.querySelectorAll('.edit-rtabs .edit-tab')].map((b) => b.textContent)) === '["Inspector","Attributes","History"]'`));
  await waitFor(`[...document.querySelectorAll('[data-frame="inspector"] .sp-btn')].some((b) => /History ›/.test(b.textContent))`, 4000);
  await evalJson(`([...document.querySelectorAll('[data-frame="inspector"] .sp-btn')].find((b) => /History ›/.test(b.textContent)).click(), true)`);
  check("HT2 the Inspector's 'last change … History ›' opens the History tab", await waitFor(`document.querySelector('.edit-right')?.dataset.tab === 'history' && getComputedStyle(document.querySelector('[data-frame="history"]')).display !== 'none' && getComputedStyle(document.querySelector('[data-frame="inspector"]')).display === 'none'`, 3000));
  const hrows = async () => evalJson(`[...document.querySelectorAll('[data-frame="history"] .sp-info')].map((x) => x.textContent)`);
  check("HT3 it lists this thing's acts, newest first, with who and what (pt's motion set and deleted above)", await waitFor(`(() => { const t = [...document.querySelectorAll('[data-frame="history"] .sp-info')].map((x) => x.textContent); const i = t.findIndex((x) => /delete.*motion/.test(x)), j = t.findIndex((x) => /set.*motion/.test(x)); return i >= 0 && j > i; })()`, 5000), await hrows());
  // enough acts to page: 25 label sets on pt, then Older… must reach back to the motion set
  for (let k = 0; k < 25; k++) await page("await (await import('/lib/net.js')).sendRequest('set', { id: 'pt', component: 'label', value: 'pt " + k + "' }); return true;");
  await sleep(800);
  check("HT4 a long history shows a page and an Older… button", await waitFor(`[...document.querySelectorAll('[data-frame="history"] .sp-btn')].some((b) => /Older/.test(b.textContent))`, 5000), await hrows());
  check("HT5 …the first page doesn't reach back to the motion yet", !(await hrows() as string[]).some((x) => /set.*motion/.test(x)));
  await evalJson(`([...document.querySelectorAll('[data-frame="history"] .sp-btn')].find((b) => /Older/.test(b.textContent)).click(), true)`);
  if (process.env.SHOT_DIR) { const r = await cdp.send('Page.captureScreenshot', { format: 'png' }); (await import('node:fs')).writeFileSync(`${process.env.SHOT_DIR}/history-tab.png`, Buffer.from(r.data, 'base64')); }
  check("HT6 …Older… reads further back and finds it", await waitFor(`[...document.querySelectorAll('[data-frame="history"] .sp-info')].some((x) => /set.*motion/.test(x.textContent))`, 5000), (await hrows() as string[]).length);
  await page(`(await import('/lib/scenegraph.js')).sceneSelect(null); return true;`).catch(() => null);
  await evalJson(`(document.querySelector('.edit-rtabs .edit-tab[data-tab="inspector"]').click(), true)`);

  // ---- GR: the ground panel writes in a world (R 10-06: ground & grass panels broken). It sent v1 'terrain'/'grass'
  // verbs, which fromv1 had no spelling for, so the page refused them itself and nothing reached the authority. ----
  { const st4 = () => fold(entries());
    const gpanel = `const d = document.createElement('div'); document.body.appendChild(d); (await import('/lib/groundpanel.js')).paintGround(d); window.__gp = d;
      window.__gbtn = (re) => [...window.__gp.querySelectorAll('button, .sp-btn')].find((b) => re.test(b.textContent)); return true;`;
    await page(gpanel);
    check("GR0 (setup) the ground panel paints, with its palette (async: wait for the button)", await waitFor(`!!window.__gbtn?.(/reshuffle/)`), await evalJson(`window.__gp?.textContent?.slice(0, 200)`));
    const t0 = JSON.stringify(st4().entities["@world"]?.c?.terrain ?? null); let n0 = myActs().length;
    await evalJson(`(window.__gbtn(/reshuffle/).click(), true)`);
    check("GR1 reshuffle is ONE act, set @world terrain, and the ground changed", await waitDisk(() => myActs().length === n0 + 1 && myActs().at(-1).e.verb === "set" && JSON.stringify(st4().entities["@world"]?.c?.terrain ?? null) !== t0),
      { acts: myActs().slice(n0).map((a) => a.e.verb), refused: await evalJson(`__refused.map((r) => r.text)`), toasts: await evalJson(`[...document.querySelectorAll('.toast')].map((t) => t.textContent.slice(0, 160))`) });
    n0 = myActs().length; await evalJson(`(window.__gbtn(/grow/).click(), true)`);
    check("GR2 grow plants grass: set @world grass", await waitDisk(() => myActs().length === n0 + 1 && !!st4().entities["@world"]?.c?.grass), { acts: myActs().slice(n0).map((a) => a.e.verb), refused: await evalJson(`__refused.map((r) => r.text)`) });
    n0 = myActs().length; await evalJson(`(window.__gbtn(/^mow$/).click(), true)`);
    check("GR3 mow clears it: one act, and @world has no grass", await waitDisk(() => myActs().length === n0 + 1 && !st4().entities["@world"]?.c?.grass), { acts: myActs().slice(n0).map((a) => a.e.verb), refused: await evalJson(`__refused.map((r) => r.text)`) });
    await evalJson(`(window.__gp.remove(), true)`); }

  // ---- ST: a seat on a socket that's switched off is no seat on the client either (review 10-12 S3-3) ----
  // The authority clears its record when a socket is disabled; the sitter's own client must let go too (not stay mounted,
  // sending seat {to} frames), so a second body can't come to render on the same socket after a re-enable.
  { const made = await page(`const n = await import('/lib/net.js');
      const a = await n.sendRequest('create', { id: 'ststool', model: '${CRATE}', place: { at: [7, 7] } });
      const b = await n.sendRequest('create', { id: 'ststool-seat', components: { parent: { to: 'ststool' }, transform: { pos: [0, 0.5, 0] }, socket: { name: 'seat', body: { action: 'sit' } } } });
      return JSON.stringify([a.ok, b.ok]);`);
    const mine = `Promise.all([import('/lib/world.js'), import('/lib/base.js')]).then(([w, b]) => w.avatarMounts.get(b.CONFIG.name)?.to ?? null)`;
    await waitFor(`import('/lib/world.js').then((w) => !!w.seatSocket('ststool-seat'))`);
    await page(`(await import('/lib/localbody.js')).trySitOn('ststool'); return true;`);
    const sat = await waitFor(`${mine}.then((t) => t === 'ststool-seat')`);
    const off = await page(`return JSON.stringify((await (await import('/lib/net.js')).sendRequest('set', { id: 'ststool-seat', component: 'disabled', value: true })).ok);`);
    const up = await waitFor(`${mine}.then((t) => t === null)`);
    const closed = await evalJson(`import('/lib/world.js').then((w) => w.seatSocket('ststool-seat') === null)`);
    check("ST1 sitting on a socket that is then switched off: my client lets go of it (no seat), and reads it as no seat", made === "[true,true]" && sat && off === "true" && up && closed, { made, sat, off, up, closed, now: await evalJson(mine) });
    await page(`await (await import('/lib/net.js')).sendRequest('delete', { id: 'ststool' }); return true;`); }

  // ---- the page's own fold, at the end ----
  check("B3 the page's fold = the log on disk (digest), after everything above", await waitFor(`Promise.all([import('/lib/net.js'), import('/shared/protocol/fold.js')]).then(([n, f]) => f.digest(n.replica.st) === '${digest(disk())}')`), [await evalJson(`Promise.all([import('/lib/net.js'), import('/shared/protocol/fold.js')]).then(([n, f]) => f.digest(n.replica.st))`), digest(disk())]);
  check("B4 what the page drew is the view of its own fold: entries ingested, no resync, and state.st = viewState(its fold) — no v1 verbs anywhere (that the server sends it no `log` entries is server-check S8)", await evalJson(`Promise.all([import('/lib/net.js'), import('/lib/state.js'), import('/shared/protocol/view.js'), import('/shared/protocol/viewdiff.js')]).then(([n, s, r, d]) => { const x = d.diffView(s.state.st, r.viewState(n.replica.st)); return n.replica.stats.ingested > 10 && n.replica.stats.resyncs === 0 && !x.things.length && !x.world.length && !('projected' in n.replica.stats); })`), await evalJson(`Promise.all([import('/lib/net.js'), import('/lib/state.js'), import('/shared/protocol/view.js'), import('/shared/protocol/viewdiff.js')]).then(([n, s, r, d]) => ({ stats: n.replica.stats, diff: d.diffView(s.state.st, r.viewState(n.replica.st)) }))`));
  check("B4b the fold's edge index (replica childrenOf/ancestors, kept op by op) agrees with the view after every mount, unparent and delete this run made, and is not empty where the view has edges", await evalJson(`Promise.all([import('/lib/parity.js'), import('/lib/world.js'), import('/lib/state.js')]).then(([p, w, s]) => { const r = p.foldParity(); const E = s.state.st.entities; const edged = Object.keys(E).filter((id) => E[id].parent?.to); return r.edgeDiffs.length === 0 && r.checked > 0 && edged.every((id) => w.ancestorsOf(id)[0] === E[id].parent.to && w.childrenOf(E[id].parent.to).includes(id)); })`), await evalJson(`Promise.all([import('/lib/parity.js'), import('/lib/world.js'), import('/lib/state.js')]).then(([p, w, s]) => { const E = s.state.st.entities; return { edge: p.foldParity().edgeDiffs, edged: Object.keys(E).filter((id) => E[id].parent?.to).map((id) => [id, E[id].parent.to, w.ancestorsOf(id), w.childrenOf(E[id].parent.to)]) }; })`));
  // a UI verb path (the chat box sends through net.js sendVerb('say')), driven for real so B5 has a subject
  await evalJson(`(() => { const t = document.getElementById('chatline'); t.focus(); t.value = 'hello from the page (3c)'; t.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true })); return true; })()`);
  check("B5a the chat box's line (a UI verb) reaches the log, as the person's say", await waitDisk(() => entries().some((e) => e?.kind === "say" && e.actor === MY() && e.body?.text === "hello from the page (3c)")), entries().filter((e) => e?.kind === "say").slice(-2));
  check("B5 the page sent no v1 verb to the world, all run long: every UI verb was spelled as a request at the page (3c)", await evalJson(`window.__v1sent.length === 0`), await evalJson(`window.__v1sent.slice(0, 10)`));
  // ---- CP: the Commons parity audit (old world → new) (10-06): what a person who isn't in the editor sees ----
  { const lines = () => evalJson(`[...document.querySelectorAll('#chatlog .line')].map((l) => l.textContent)`);
    const type = (text: string) => evalJson(`(() => { const t = document.getElementById('chatline'); t.focus(); t.value = ${JSON.stringify(text)}; t.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true })); return true; })()`);
    const lineLike = (re: string, ms = 5000) => waitFor(`[...document.querySelectorAll('#chatlog .line')].some((l) => ${re}.test(l.textContent))`, ms);
    // CP1 role narration names people (the setup above made bob a builder: "editbot made u-… builder")
    check("CP1 the role narration names the person, not their u-… id", await lineLike(`/made bob builder/`, 3000) && !(await lines() as string[]).some((l) => /made u-[a-z2-7]{20}/.test(l)), (await lines() as string[]).filter((l) => /made /.test(l)));
    // CP2 /role <name> is the authority's role (it read v1's role map by name: "bob holds no role here (visitor)")
    await type("/role bob");
    check("CP2 /role bob says builder (the authority's role)", await lineLike(`/bob: builder/`), (await lines() as string[]).slice(-3));
    await type("/role");
    check("CP2 …and /role is mine: owner", await lineLike(`/you: owner/`), (await lines() as string[]).slice(-3));
    // CP3 /use <thing> with no action does its one action (it sent 'use', which the bell doesn't do)
    { const r = await page(`const m = await import('/lib/net.js'); return (await m.sendRequest('create', { id: 'bell', model: '${CRATE}', components: { reactions: { ring: { kind: 'set', component: 'label', value: 'rung' } } }, place: { at: [4, 4] } })).ok;`);
      await waitFor(`import('/lib/world.js').then((m) => m.entities.has('bell'))`);
      await type("/use bell");
      check("CP3 /use bell rings it: the authority did its one action (the label is on the record)", r && await waitDisk(() => disk().entities.bell?.c.label === "rung"), { r, refused: await evalJson(`__refused.map((x) => x.text).slice(-2)`) }); }
    // CP5 a spoken utterance arriving in two says is one chat line again (the port dropped the trio)
    { await bobReq("say", { text: "the first half", spoken: true, utt: 41 }); await bobReq("say", { text: "and the rest", spoken: true, utt: 41 });
      check("CP5 a spoken utterance's continuation merges into its line", await lineLike(`/the first half and the rest/`), (await lines() as string[]).slice(-3)); }
    let carlId = "";
    // CP4 (setup) carl visits, speaks and leaves, BEFORE the page reconnects (CP6): a page that never saw him arrive
    { const carl = new WebSocket(BASE.replace("http", "ws") + "/ws"); await new Promise((r, j) => { carl.onopen = r; carl.onerror = j; });
      carl.onmessage = (ev) => { const m = JSON.parse(String(ev.data)); if (m.type === "snapshot") { carlId = m.cut?.you; carl.send(JSON.stringify({ type: "request", id: 1, verb: "say", args: { text: "carl was here" } })); } };
      carl.send(JSON.stringify({ type: "join", world: WORLD, id: "carl", avatar: "", replica: true }));
      await waitDisk(() => entries().some((e) => e?.kind === "say" && e.body?.text === "carl was here")); carl.close(); await sleep(300); }
    // CP6 a line typed while reconnecting is queued, then sent (the port dropped it as 'offline')
    { await evalJson(`import('/lib/net.js').then((m) => (m.net.ws.close(), true))`);
      await waitFor(`import('/lib/net.js').then((m) => !m.net.joined)`, 3000);
      await type("typed while away");
      check("CP6 typed while disconnected: the page says it's queued", await lineLike(`/queued “typed while away” — reconnecting/`, 3000), (await lines() as string[]).slice(-2));
      check("CP6 …and it reaches the log once the page is back", await waitDisk(() => entries().some((e) => e?.kind === "say" && e.actor === MY() && e.body?.text === "typed while away"), 20000), (await lines() as string[]).slice(-3)); }
    // CP4 /ban someone the page never saw: found by name through the world's lookup; everyone is told who, not why
    { const CARL = carlId;
      await type("/ban carl being rude");
      const modf = path.join(worldsDir, WORLD, "world.mod.jsonl");
      check("CP4 /ban carl reaches carl, who left (it said \"carl isn't here\")", !!CARL && await waitDisk(() => fs.existsSync(modf) && fs.readFileSync(modf, "utf8").includes(`"who":"${CARL}"`)), (await lines() as string[]).slice(-3));
      check("CP4 …and the room is told, with names and without the reason", await lineLike(`/editbot banned carl from this world/`) && !(await lines() as string[]).some((l) => /being rude/.test(l)), (await lines() as string[]).slice(-3)); }
    // CP7 a refused say is shown (the rate limit: the reply was ignored, and the line just didn't appear)
    { await page(`const m = await import('/lib/net.js'); await Promise.all(Array.from({ length: 24 }, (_, i) => m.say('flood ' + i))); return true;`);
      check("CP7 a say refused by the rate limit is shown, in words", await lineLike(`/slow down — you've said a lot/`), (await lines() as string[]).slice(-3)); }
    // CP8 the help sheet and the command bar describe the protocol (first-in owners, /grant * visitor closing a world, objects flying with /punt, +gen)
    { const help = await evalJson(`fetch('/defs').then((r) => r.json()).then((d) => JSON.stringify(d.uiHelp ?? null))`);
      check("CP8 the help sheet has nothing v1-only left", typeof help === "string" && help.length > 100 && !/whoever steps in first|first in owns|\+gen|Objects fly with|everyone else can still build unless/.test(help) && /grant \* builder/.test(help), String(help).slice(0, 160));
      const listed = await evalJson(`import('/lib/commands/registry.js').then((m) => m.COMMANDS.filter((c) => c.listed !== false).map((c) => c.name + ' ' + c.help).join('\\n'))`);
      check("CP8 the command bar lists nothing that sends nothing here (/boom), and no +gen/+fly grant", !/^boom /m.test(listed) && !/\+gen|\+fly/.test(listed), listed); }
    // CP9 /grant * builder keeps the world's guest opt-in (a whole-value set wiped it)
    { await page(`const m = await import('/lib/net.js'); return (await m.sendRequest('set', { id: '@world', component: 'default-role', value: { role: 'builder', guests: 'builder' } })).ok;`);
      await sleep(1200);   // CP7's flood is the say budget; this is an act
      await type("/grant * builder");
      check("CP9 /grant * builder sets the default role and keeps guests: 'builder'", await waitDisk(() => { const d = disk().entities["@world"]?.c["default-role"]; return d?.role === "builder" && d?.guests === "builder" && myActs().at(-1)?.e.body?.request?.merge === true; }), disk().entities["@world"]?.c["default-role"]); }
    // CA1 World Settings › Access: the account-age field writes access.minAccountDays, and emptying it removes the key (R 10-07)
    { await page(`const m = await import('/lib/rolespanels.js'); const b = document.createElement('div'); b.id = '__acc'; document.body.append(b); m._test.paintAccess(b); return true;`);
      const field = `document.querySelector('#__acc [data-k=minAccountDays]')`;
      const shown = await evalJson(`!!${field} && ${field}.min === '0' && ${field}.max === '365'`);
      await evalJson(`(() => { const x = ${field}; x.value = '14'; x.onchange(); return true; })()`);
      const set = await waitDisk(() => disk().entities["@world"]?.c.access?.minAccountDays === 14);
      await waitFor(`${field}?.value === '14'`, 4000);
      await evalJson(`(() => { const x = ${field}; x.value = ''; x.onchange(); return true; })()`);
      const cleared = await waitDisk(() => { const a = disk().entities["@world"]?.c.access; return !!a && !("minAccountDays" in a); });
      await evalJson(`(document.getElementById('__acc')?.remove(), true)`);
      check("CA1 World Settings › Access: 'Accounts at least N days old' (0–365) sets access.minAccountDays; emptying it removes it", shown && set && cleared, { shown, set, cleared, access: disk().entities["@world"]?.c.access, refused: await evalJson(`__refused.map((x) => x.text).slice(-2)`) }); }
    // CW World Settings › World (R 10-14 14:13): capacity, physics, the bare training-consent — owner-gated, and opening it
    // WRITES NOTHING (defaults written on open would put numbers in the log the owner never chose)
    { const W = `document.querySelector('#__w')`;
      const paint = () => page(`const m = await import('/lib/rolespanels.js'); document.getElementById('__w')?.remove(); const b = document.createElement('div'); b.id = '__w'; document.body.append(b); m._test.paintWorld(b); return true;`);
      // the world has written no capacity: what the panel shows is the registry's defaults
      const fresh = !disk().entities["@world"]?.c.capacity;
      // CW1 a visitor sees no dials; the owner sees them with the world's values
      await page(`const n = await import('/lib/net.js'); globalThis.__wasRights = n.net.myRights; n.net.myRights = { ...n.net.myRights, role: 'visitor', permissions: [] }; return true;`);
      await paint();
      const vis = await evalJson(`({ inputs: ${W}.querySelectorAll('input').length, ro: !!${W}.querySelector('.rp-ro'), entities: ${W}.textContent.includes('Entities in this world 10,000'), guests: ${W}.textContent.includes("Guests' entities, together 500"), avatar: ${W}.textContent.includes('Largest avatar (entities) 2,000') })`);
      await page(`const n = await import('/lib/net.js'); n.net.myRights = globalThis.__wasRights; return true;`);
      const n0 = myActs().length, r0 = myRefused();
      await paint(); await sleep(1500);
      const own = await evalJson(`(() => { const t = ${W}.querySelector('[data-cap=entities]'); const a = ${W}.querySelector('[data-cap=avatar]'); return { keys: [...${W}.querySelectorAll('input[data-cap]')].map((x) => x.dataset.cap), inputs: ${W}.querySelectorAll('input[data-cap]').length, min: t?.min, max: t?.max, value: t?.value, placeholder: t?.placeholder, avatar: a && { min: a.min, max: a.max, value: a.value, placeholder: a.placeholder }, phys: ${W}.querySelector('[data-phys]')?.checked, tc: ${W}.querySelector('[data-tc=allow]')?.checked }; })()`);
      check("CW1 World › a visitor sees the numbers (guests' and avatar's too) and no dials; the owner sees three capacity fields (entities, guestEntities, avatar) with the registry's ranges (avatar 1–5000)", fresh && vis.inputs === 0 && vis.ro && vis.entities && vis.guests && vis.avatar && own.inputs === 3 && JSON.stringify(own.keys) === '["entities","guestEntities","avatar"]' && own.min === "1" && own.max === "50000" && own.avatar?.min === "1" && own.avatar?.max === "5000" && own.phys === false && own.tc === false, { fresh, vis, own });
      // CW2 FRESH OPEN WRITES NOTHING: the defaults are shown grey (placeholders), never written
      check("CW2 World › opening it as owner on a world with no capacity sends no set, and shows the defaults (10000, avatar 2000) as placeholders", myActs().length === n0 && myRefused() === r0 && own.value === "" && own.placeholder === "10000" && own.avatar?.value === "" && own.avatar?.placeholder === "2000" && !disk().entities["@world"]?.c.capacity, { acts: myActs().slice(n0).map((a) => a.e.body?.request?.component), own, cap: disk().entities["@world"]?.c.capacity ?? null });
      // CW3 an in-range edit: ONE set, component capacity, merge, the value — and the first write carries the other numbers shown
      await evalJson(`(() => { const x = ${W}.querySelector('[data-cap=entities]'); x.value = '12'; x.onchange(); return true; })()`);
      const wrote = await waitDisk(() => disk().entities["@world"]?.c.capacity?.entities === 12);
      const req = myActs().slice(n0).map((a) => a.e.body?.request);
      check("CW3 World › entities = 12 sends one set {component: 'capacity', merge: true}; the first write carries the other numbers shown (guestEntities 500, avatar 2000) and nothing else", wrote && req.length === 1 && req[0]?.component === "capacity" && req[0]?.merge === true && JSON.stringify(Object.keys(req[0]?.value ?? {}).sort()) === '["avatar","entities","guestEntities"]' && req[0]?.value?.entities === 12 && req[0]?.value?.guestEntities === 500 && req[0]?.value?.avatar === 2000, { req, cap: disk().entities["@world"]?.c.capacity });
      await waitFor(`${W}.querySelector('[data-cap=entities]')?.value === '12'`, 4000);
      // CW3b out of range: nothing sent, the panel says why in the registry's words
      const n1 = myActs().length, r1 = myRefused();
      await evalJson(`(() => { const x = ${W}.querySelector('[data-cap=entities]'); x.value = '99999'; x.onchange(); return true; })()`);
      await sleep(800);
      const noteTxt = await evalJson(`${W}.querySelector('.rp-cap-note')?.hidden === false ? ${W}.querySelector('.rp-cap-note').textContent : null`);
      check("CW3b World › entities = 99999 sends nothing and the panel shows the refusal (≤ 50000)", myActs().length === n1 && myRefused() === r1 && /≤ 50000/.test(noteTxt ?? "") && await evalJson(`${W}.querySelector('[data-cap=entities]').value === '12'`), { noteTxt, acts: myActs().slice(n1).map((a) => a.e.body?.request) });
      // CW4 training-consent: the bare key only; the wire never carries training-consent:<id>
      await evalJson(`(() => { const x = ${W}.querySelector('[data-tc=allow]'); x.checked = true; x.onchange(); return true; })()`);
      const tcWrote = await waitDisk(() => disk().entities["@world"]?.c["training-consent"]?.allow === true);
      const keyed = entries().filter((e: any) => e?.kind === "act" && String(e.body?.request?.component ?? "").startsWith("training-consent:")).length;
      const tcReq = myActs().slice(n1).map((a) => a.e.body?.request);
      check("CW4 World › 'may train' writes set {component: 'training-consent', value: {allow: true}} and nothing keyed by an identity", tcWrote && tcReq.length === 1 && tcReq[0]?.component === "training-consent" && tcReq[0]?.value?.allow === true && keyed === 0 && !Object.keys(disk().entities["@world"]?.c ?? {}).some((k) => k.startsWith("training-consent:")), { tcReq, keyed });
      // CW5 physics: on writes {engine} as the gym does (the authority stamps build and tick); off deletes it
      await waitFor(`${W}.querySelector('[data-tc=allow]')?.checked === true`, 4000);
      await evalJson(`(() => { const x = ${W}.querySelector('[data-phys]'); x.checked = true; x.onchange(); return true; })()`);
      const peOn = await waitDisk(() => !!disk().entities["@world"]?.c["physics-engine"]?.engine);
      await waitFor(`${W}.querySelector('[data-phys]')?.checked === true`, 4000);
      await evalJson(`(() => { const x = ${W}.querySelector('[data-phys]'); x.checked = false; x.onchange(); return true; })()`);
      const peOff = await waitDisk(() => !disk().entities["@world"]?.c["physics-engine"]);
      check("CW5 World › physics on sets @world.physics-engine {engine}; off deletes it", peOn && peOff, { pe: disk().entities["@world"]?.c["physics-engine"] ?? null, refused: await evalJson(`__refused.map((x) => x.text).slice(-2)`) });
      await evalJson(`(document.getElementById('__w')?.remove(), true)`); }
    // CB1 World Settings › Places: empty Bounds fields write NO bounds (they read as 0 and saved a zero box that refused every move, audit 10-09)
    // RK1 (review 10-14 K3): picking a role from the Roles panel keeps the person's exceptions — the set merges when the entry exists
    { const grant = await page(`const m = await import('/lib/net.js'); return (await m.sendRequest('set', { id: '@world', component: 'roles:${BOB}', value: { role: 'builder', can: { pauseScripts: true } } })).ok;`);
      await waitDisk(() => disk().entities["@world"]?.c[`roles:${BOB}`]?.can?.pauseScripts === true);
      await page(`const m = await import('/lib/rolespanels.js'); document.getElementById('__rk')?.remove(); const b = document.createElement('div'); b.id = '__rk'; document.body.append(b); m._test.paintRoles(b); return true;`);
      await sleep(800);
      const picked = await evalJson(`(() => { const s = [...document.querySelectorAll('#__rk select.rp-change')].find((x) => x.dataset.who === '${BOB}'); if (!s) return 'no-select'; s.value = 'visitor'; s.onchange(); return true; })()`);
      const moved = await waitDisk(() => disk().entities["@world"]?.c[`roles:${BOB}`]?.role === "visitor");
      const after = disk().entities["@world"]?.c[`roles:${BOB}`];
      check("RK1 Roles › picking a role from the panel keeps the person's `can` exceptions (merge when the entry exists)", grant && picked === true && moved && after?.can?.pauseScripts === true, { picked, after });
      await page(`const m = await import('/lib/net.js'); return (await m.sendRequest('set', { id: '@world', component: 'roles:${BOB}', value: { role: 'builder' } })).ok;`);   // restore for the rows below
      await waitDisk(() => disk().entities["@world"]?.c[`roles:${BOB}`]?.role === "builder"); }
    { await page(`const m = await import('/lib/rolespanels.js'); const b = document.createElement('div'); b.id = '__pl'; document.body.append(b); m._test.paintPlaces(b); return true;`);
      const before = JSON.stringify(disk().entities["@world"]?.c.bounds ?? null);
      await evalJson(`(() => { const q = (s) => document.querySelectorAll('#__pl ' + s); q('[data-k=min],[data-k=max]').forEach((x) => (x.value = '')); const sp = q('[data-k=spawn]'); [3, 0.5, -2].forEach((v, i) => (sp[i].value = String(v))); q('[data-k=radius]')[0].value = ''; q('[data-save]')[0].click(); return true; })()`);
      const spawned = await waitDisk(() => JSON.stringify(disk().entities["@world"]?.c.spawn?.pos) === "[3,0.5,-2]");
      const after = JSON.stringify(disk().entities["@world"]?.c.bounds ?? null);
      await evalJson(`(document.getElementById('__pl')?.remove(), true)`);
      check("CB1 Places › Save with empty Bounds saves the spawn and leaves bounds as they were (no zero box)", spawned && before === after, { spawned, before, after, toasts: await evalJson(`[...document.querySelectorAll('.toast')].map((t) => t.textContent.slice(0, 100)).slice(-3)`) }); }
    // CP10 removed from the world (4006): a line typed after it isn't queued "until the world is back" (it never comes)
    { await evalJson(`import('/lib/net.js').then((m) => (m.net.ws.close(4006, 'test: as if removed'), true))`);
      await waitFor(`import('/lib/net.js').then((m) => m.net.status === 'rejected')`, 5000);
      const r = await page(`const m = await import('/lib/net.js'); return await Promise.race([m.say('after removal'), new Promise((res) => setTimeout(() => res('pending'), 3000))]);`);
      check("CP10 a say after removal answers at once, in words, and isn't queued", r?.ok === false && await lineLike(`/“after removal” wasn't sent: not connected/`, 2000) && !(await lines() as string[]).some((l) => /queued “after removal”/.test(l)), { r, last: (await lines() as string[]).slice(-2) }); } }
  console.log("  (toasts on screen at the end: " + JSON.stringify(await evalJson(`[...document.querySelectorAll('.toast')].map((t) => t.textContent.slice(0, 120))`)) + ")");
  check("N1 no '[state] seq gap' noise: the v1 numbering a client derives is sparse by design (seq×1000+k), and the log stream checks its own gaps (K4)", await evalJson(`__gaps.length === 0`), await evalJson(`__gaps.slice(0, 4)`));
  check("errors: no page error", await evalJson(`__errs.length === 0`), await evalJson(`__errs`));
  check("errors: no reader threw into a frozen record (console.error carries what the catch-alls swallow)", await evalJson(`__cerr.length === 0`), await evalJson(`__cerr.slice(0, 3)`));
  bob.close();
} catch (e) { check("the run threw", false, String(e?.stack ?? e)); }
console.log(`[client-check] ${tally.passed} passed, ${tally.failed} failed${tally.note()}`);
await cleanup(tally.failed ? 1 : 0);
process.exit(tally.failed ? 1 : 0);
