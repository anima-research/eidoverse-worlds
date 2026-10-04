// tools/v4/client-check.ts — slice 3b in a real browser: edit mode in a v4 world sends v4 requests, folds v4 and
// waits for the door. One headless Chromium against a scratch sequencer (tools/harness.ts scratchBench: scratch port,
// scratch WORLDS_DIR, its own profile; never 8968/8970). Run it under the house guards:
//   code/scripts/eido-probe.sh -C <worktree> -t 400 tools/v4/client-check.ts      (test:v4's `client` suite does this)
//
//   B   boot: the page knows it's in a v4 world; its own fold of the v4 stream = the log on disk (digest)
//   P   place from the Build tab's ghost: one `create` act, the page waited for the door
//   G   a gizmo drag is presence until release: ONE act, `set transform` with expect on where it started
//   U   Ctrl+Z is the door's undo {act} of MY act; Ctrl+Shift+Z redoes (undo of my undo)
//   C   undo refused when someone changed it since: nothing written, the refusal shown in the agents' words
//   X   Esc mid-drag: the thing goes back, and nothing is written (0 acts)
//   L   a lock refusal (the cup rides a table someone else locked): the dialog offers Move anyway; it re-sends the
//       SAME request with through_lock: the log has one act, the lock is still on
//   D   duplicate (Alt+D) is create {from: <thing>}: one act
//   M   deleting two selected things is ONE batch act
//   S   Save as blueprint is the door's publish; its tile places a copy (create {from: <hash>})
// The writes go through the real edit code (build.js, gizmo.js, inspect.js, editpanels.js); a few gestures are driven
// at their seams (TransformControls' own events, the panel's buttons, synthetic keydowns), as editpanels-bench does.
// @ts-nocheck
import fs from "node:fs";
import path from "node:path";
import { scratchBench, mkCheck, sleep } from "../harness.ts";
import { readLog, fold, digest } from "../../shared/v4/fold.js";
import { refusalText } from "../../shared/v4/refusal.js";

const ENGINE = path.resolve(import.meta.dir, "../..");
const ME = "editbot", WORLD = "edit4";
const CRATE = "eidoverse/assets/models/crate_large_blue.glb", RED = "eidoverse/assets/models/crate_large_red.glb";
let worldsDir = "";
const { cdp, evalJson, cleanup, die, BASE, SCRATCH } = await scratchBench("v4client", {
  prepare: (scratch) => {
    worldsDir = path.join(scratch, "worlds"); fs.mkdirSync(worldsDir, { recursive: true });
    const r = Bun.spawnSync(["bun", "tools/v4/world.ts", "found", WORLD, "--owner", ME, "--title", "client check"], { cwd: ENGINE, env: { ...process.env, WORLDS_DIR: worldsDir, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" } });
    if (r.exitCode !== 0) throw new Error("founding failed: " + r.stderr.toString());
  },
});
const { check: check0, tally } = mkCheck();
const check = (name: string, ok: any, detail?: any) => check0(name, !!ok, detail === undefined ? "" : typeof detail === "string" ? detail.slice(0, 600) : (JSON.stringify(detail) ?? "").slice(0, 600));
const LOG = () => path.join(worldsDir, WORLD, "v4.jsonl");
const entries = () => readLog(fs.readFileSync(LOG()));
const myActs = () => entries().map((e, seq) => ({ e, seq })).filter(({ e }) => e?.kind === "act" && e.actor === ME);
const disk = () => fold(entries());
const waitFor = async (expr: string, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { if (await evalJson(expr)) return true; } catch { /* page busy */ } await sleep(100); } return false; };
const waitDisk = async (pred: () => boolean, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (pred()) return true; await sleep(100); } return false; };
const key = (code: string, mods: any = {}) => evalJson(`dispatchEvent(new KeyboardEvent('keydown', { code: '${code}', key: '${code}', bubbles: true, ${Object.entries(mods).map(([k, v]) => `${k}: ${v}`).join(", ")} })), true`);
const page = (js: string) => evalJson(`(async () => { ${js} })()`);

try {
  // ---- a second builder over a plain socket (an agent's view: it still reads the projection) ----
  const bob = new WebSocket(BASE.replace("http", "ws") + "/ws"); const replies = new Map(); let rn = 0;
  bob.onmessage = (ev) => { const m = JSON.parse(String(ev.data)); if (m.type === "v4-result") replies.get(m.id)?.(m.reply); };
  await new Promise((r, j) => { bob.onopen = r; bob.onerror = j; });
  const bobReq = (tool: string, args: any) => new Promise<any>((res) => { const id = `b${++rn}`; replies.set(id, res); bob.send(JSON.stringify({ type: "v4", id, tool, args })); setTimeout(() => res({ ok: false, refused: { code: "timeout" } }), 6000); });

  await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: `window.__errs = []; addEventListener('error', (e) => __errs.push('error: ' + e.message));
    window.__refused = []; window.__asked = [];
    import('/lib/base.js').then((m) => { m.bus.on('v4-refused', (e) => __refused.push(e)); m.bus.on('v4-lock-asked', (e) => __asked.push(e)); });` });
  await cdp.send("Page.navigate", { url: `${BASE}/?name=${ME}&world=${WORLD}` });
  let secs = 0; for (let i = 0; i < 160 && secs < 4; i++) { secs = (await evalJson(`document.querySelectorAll('.sec').length`).catch(() => 0)) ?? 0; if (secs < 4) await sleep(500); }
  check("boot: the client comes up", secs >= 4, `${secs} sections`);
  if (secs < 4) await die(1, "the page never booted");
  await evalJson(`(() => { const s = document.querySelector('#splash'); if (s) s.style.pointerEvents = 'none'; return true; })()`);
  check("B1 the page knows it's in a v4 world (it adopted the v4 cut)", await waitFor(`import('/lib/net.js').then((m) => m.isV4())`));
  bob.send(JSON.stringify({ type: "join", world: WORLD, id: "bob", avatar: "" })); await sleep(500);
  check("(setup) the owner makes bob a builder", (await page(`const m = await import('/lib/net.js'); return (await m.requestV4('set', { id: '@world', component: 'roles:bob', value: { role: 'builder' } })).ok;`)) === true);
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

  // ---- U: undo and redo through the door ----
  n0 = myActs().length;
  await key("KeyZ", { ctrlKey: true });
  check("U1 Ctrl+Z = undo {act} of my act", await waitDisk(() => myActs().length === n0 + 1 && myActs().at(-1).e.verb === "undo" && myActs().at(-1).e.body.request.act === g.seq), myActs().slice(n0).map((a) => a.e.body));
  check("U2 …it's back where it was", await waitDisk(() => JSON.stringify(disk().entities[crate].c.transform) === JSON.stringify(start)));
  const undoAct = myActs().at(-1).seq;
  // the door writes before it replies: wait until the page has its reply (the act on its redo stack) before the key
  await waitFor(`globalThis.__v4edit().redo.at(-1) === ${undoAct}`);
  await key("KeyZ", { ctrlKey: true, shiftKey: true });
  check("U3 Ctrl+Shift+Z redoes: undo {act: <my undo>}", await waitDisk(() => myActs().at(-1).e.verb === "undo" && myActs().at(-1).e.body.request.act === undoAct && Math.abs(disk().entities[crate].c.transform.pos[0] - (start.pos[0] + 1)) < 1e-3), myActs().at(-1)?.e.body);
  check("U4 the page's drawing follows (its fold)", await waitFor(`import('/lib/world.js').then((m) => Math.abs(m.entities.get('${crate}').position.x - ${start.pos[0] + 1}) < 1e-3)`));
  const redoAct = myActs().at(-1).seq;
  await waitFor(`globalThis.__v4edit().undo.at(-1) === ${redoAct}`);
  await key("KeyZ", { ctrlKey: true });
  check("U5 Ctrl+Z after a redo undoes the redo (it went back on my undo stack)", await waitDisk(() => myActs().at(-1).e.verb === "undo" && myActs().at(-1).e.body.request.act === redoAct && JSON.stringify(disk().entities[crate].c.transform) === JSON.stringify(start)), myActs().at(-1)?.e.body);
  const undo2 = myActs().at(-1).seq;
  await waitFor(`globalThis.__v4edit().redo.at(-1) === ${undo2}`);
  await key("KeyZ", { ctrlKey: true, shiftKey: true });
  check("U6 …and redo again", await waitDisk(() => myActs().at(-1).e.body.request.act === undo2 && Math.abs(disk().entities[crate].c.transform.pos[0] - (start.pos[0] + 1)) < 1e-3), myActs().at(-1)?.e.body);
  await waitFor(`import('/lib/net.js').then((m) => Math.abs(m.v4.st.entities['${crate}'].c.transform.pos[0] - ${start.pos[0] + 1}) < 1e-3)`);

  // ---- Q: a Ctrl+Z pressed in the same tick as the release undoes THAT release (it waits for the door's reply) ----
  { n0 = myActs().length; const before = JSON.stringify(disk().entities[crate].c.transform);
    await evalJson(`(() => { const c = globalThis.__gizmo().controls; c.dispatchEvent({ type: 'dragging-changed', value: true });
      return import('/lib/world.js').then((m) => { m.entities.get('${crate}').position.z += 1; c.dispatchEvent({ type: 'objectChange' }); c.dispatchEvent({ type: 'dragging-changed', value: false });
        dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyZ', key: 'KeyZ', ctrlKey: true, bubbles: true })); return true; }); })()`);
    const ok2 = await waitDisk(() => myActs().length === n0 + 2);
    const [rel, und] = myActs().slice(n0);
    check("Q1 release + Ctrl+Z in the same tick: the undo names the release, not the act before it", ok2 && rel.e.verb === "set" && und.e.verb === "undo" && und.e.body.request.act === rel.seq && JSON.stringify(disk().entities[crate].c.transform) === before, myActs().slice(n0).map((a) => [a.seq, a.e.verb, a.e.body.request])); }

  // ---- C: undo refused when someone changed it since ----
  const moved = disk().entities[crate].c.transform;
  check("(setup) bob moves the crate after me", (await bobReq("set", { id: crate, component: "transform", value: { ...moved, pos: [moved.pos[0], moved.pos[1], moved.pos[2] + 2] } })).ok);
  await waitFor(`import('/lib/net.js').then((m) => m.v4.st.entities['${crate}'].c.transform.pos[2] === ${moved.pos[2] + 2})`);
  n0 = myActs().length; const r0 = await evalJson(`__refused.length`);
  await key("KeyZ", { ctrlKey: true });
  check("C1 Ctrl+Z on something bob changed since is refused", await waitFor(`__refused.length > ${r0} && __refused.at(-1).refused.code === 'conflict'`), await evalJson(`__refused.at(-1)`));
  const shown = await evalJson(`__refused.at(-1)`);
  check("C2 …nothing written, bob's move stands", myActs().length === n0 && disk().entities[crate].c.transform.pos[2] === moved.pos[2] + 2);
  check("C3 …and the person reads the agents' words (shared/v4/refusal.js), naming who", shown?.text === refusalText("undo", { refused: shown?.refused }) && /bob changed it since/.test(JSON.stringify(shown?.refused?.skipped)), shown);

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
  check("L1 moving the cup on bob's locked table asks first (centre dialog: Move anyway)", await waitFor(`!!document.querySelector('#confirm-center .cc-ok') && document.querySelector('#confirm-center .cc-ok').textContent === 'Move anyway'`));
  const body = await evalJson(`document.querySelector('#confirm-center #cc-body')?.textContent ?? ''`);
  check("L2 …saying why, in the door's words (attached to tbl, which is locked by bob)", /cup is attached to tbl, which is locked \(locked by bob/.test(body) && /through_lock/.test(body), body);
  check("L3 …and the refused try wrote nothing", myActs().length === n0);
  await evalJson(`document.querySelector('#confirm-center .cc-ok').click(), true`);
  check("L4 Move anyway: ONE act, the same request with through_lock: true", await waitDisk(() => myActs().length === n0 + 1 && myActs().at(-1).e.body.request.through_lock === true && myActs().at(-1).e.body.request.id === "cup"), myActs().slice(n0).map((a) => a.e.body.request));
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
  check("S1 it is the door's publish: ONE act", await waitDisk(() => myActs().length === n0 + 1 && myActs().at(-1).e.verb === "publish"), myActs().slice(n0).map((a) => a.e.verb));
  const lib = Object.keys(disk().entities["@world"].c).find((k) => k.startsWith("library:"));
  check("S2 …this world's library has it (2 parts: the table and its cup)", !!lib && disk().entities["@world"].c[lib].parts === 2, lib && disk().entities["@world"].c[lib]);
  check("S3 …and its tile shows in 'saved here'", await waitFor(`[...${bf}.querySelectorAll('.sp-tile')].some((t) => t.textContent.trim() === 'tbl')`));
  n0 = myActs().length;
  await evalJson(`[...${bf}.querySelectorAll('.sp-tile')].find((t) => t.textContent.trim() === 'tbl').click(), true`);
  check("S4 the tile places a copy: create {from: <hash>}, ONE act", await waitDisk(() => myActs().length === n0 + 1 && myActs().at(-1).e.verb === "create" && /^sha256:/.test(myActs().at(-1).e.body.request.from)), myActs().slice(n0).map((a) => a.e.body.request));

  // ---- the page's own fold, at the end ----
  check("B3 the page's v4 fold = the log on disk (digest), after everything above", await waitFor(`Promise.all([import('/lib/net.js'), import('/shared/v4/fold.js')]).then(([n, f]) => f.digest(n.v4.st) === '${digest(disk())}')`), [await evalJson(`Promise.all([import('/lib/net.js'), import('/shared/v4/fold.js')]).then(([n, f]) => f.digest(n.v4.st))`), digest(disk())]);
  check("B4 what the page drew came from its own fold: v4 entries ingested, v1 verbs derived locally, no resync (that the server sends it no `log` entries is server-check S8)", await evalJson(`import('/lib/net.js').then((m) => m.v4.stats.ingested > 10 && m.v4.stats.projected > 0 && m.v4.stats.resyncs === 0)`), await evalJson(`import('/lib/net.js').then((m) => m.v4.stats)`));
  console.log("  (toasts on screen at the end: " + JSON.stringify(await evalJson(`[...document.querySelectorAll('.toast')].map((t) => t.textContent.slice(0, 120))`)) + ")");
  check("errors: no page error", await evalJson(`__errs.length === 0`), await evalJson(`__errs`));
  bob.close();
} catch (e) { check("the run threw", false, String(e?.stack ?? e)); }
console.log(`[client-check] ${tally.passed} passed, ${tally.failed} failed`);
await cleanup(tally.failed ? 1 : 0);
process.exit(tally.failed ? 1 : 0);
