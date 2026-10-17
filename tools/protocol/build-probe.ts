// tools/protocol/build-probe.ts — ship-list group B (10-07) in a real browser: one headless Chromium against a scratch
// sequencer (tools/harness.ts scratchBench), run under the house guards like client-check:
//   code/scripts/eido-probe.sh -C <worktree> -t 400 tools/protocol/build-probe.ts      (test:protocol's `build-client` does this)
//   ST  a building edit lands on the SELECTED building (not the world's first), as ONE act with expect; Ctrl+Z (the
//       editor's one undo) puts it back; after someone else changes it, Ctrl+Z writes nothing over their work; the
//       Create panel has no second "undo building edit"
//   GH  placing a model: Q / E turn it and , / . size it BEFORE the click (the status line says so), and the click
//       places it turned and sized, as ONE create
//   SC  the Inspector's "Add Script…" makes a script: upload, then ONE act (script:<name> + its use reaction); a
//       visitor's use runs it; the Inspector lists it
// The writes go through the real edit code (structure_ui.js, build.js, scriptnew.js, editpanels.js); gestures are
// driven at their seams (a mousedown on the canvas, synthetic keydowns, the card's own buttons), as client-check does.
// @ts-nocheck
import fs from "node:fs";
import path from "node:path";
import { scratchBench, mkCheck, sleep } from "../harness.ts";
import { readLog, fold } from "../../shared/protocol/fold.js";
import { emptyStructure, drawRoom } from "../../shared/structure_edit.js";

const ENGINE = path.resolve(import.meta.dir, "../..");
const ME = "editbot", WORLD = "buildp";
process.env.TRUST_NAMES = "1";
const CRATE = "eidoverse/assets/models/crate_large_blue.glb";
let worldsDir = "";
import { inPage } from "./idalias.ts";
// R 10-17: the page names what it makes with placeholders (tools/protocol/idalias.ts pageIds); NODE holds the minted ids
// once read back, so node-side checks and later page code use them
const NODE = new Map<string, string>(); const NAMES = ["house-a", "house-b"];
const { cdp, evalJson: evalRaw, cleanup, die, BASE } = await scratchBench("build", {
  prepare: (scratch) => {
    worldsDir = path.join(scratch, "worlds"); fs.mkdirSync(worldsDir, { recursive: true });
    const r = Bun.spawnSync(["bun", "tools/protocol/world.ts", "found", WORLD, "--owner", ME, "--title", "build probe"], { cwd: ENGINE, env: { ...process.env, WORLDS_DIR: worldsDir, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" } });
    if (r.exitCode !== 0) throw new Error("founding failed: " + r.stderr.toString());
  },
});
const evalJson = (expr: string) => evalRaw(inPage(expr, NAMES, NODE));
const { check: check0, tally } = mkCheck();
const check = (name: string, ok: any, detail?: any) => check0(name, !!ok, detail === undefined ? "" : typeof detail === "string" ? detail.slice(0, 600) : (JSON.stringify(detail) ?? "").slice(0, 600));
const entries = () => readLog(fs.readFileSync(path.join(worldsDir, WORLD, "world.jsonl")));
const MY = () => entries().find((e: any) => e?.kind === "act" && e.verb === "create-world")?.actor;
const myActs = () => entries().map((e, seq) => ({ e, seq })).filter(({ e }) => e?.kind === "act" && e.actor === MY() && !e.body?.refused);
const disk = () => fold(entries());
const waitFor = async (expr: string, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { if (await evalJson(expr)) return true; } catch { /* busy */ } await sleep(100); } return false; };
const waitDisk = async (pred: () => boolean, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { if (pred()) return true; } catch { /* mid-write */ } await sleep(100); } return false; };
const key = (code: string, mods: any = {}) => { const m = Object.entries(mods).map(([k, v]) => `${k}: ${v}`).join(", ");
  return evalJson(`dispatchEvent(new KeyboardEvent('keydown', { code: '${code}', key: '${code}', bubbles: true, ${m} })), dispatchEvent(new KeyboardEvent('keyup', { code: '${code}', key: '${code}', bubbles: true, ${m} })), true`); };
const page = (js: string) => evalJson(`(async () => { ${js} })()`);
const SX = 760, SY = 470;   // the viewport point every gesture aims at (client-check's place point: the ground in view)

try {
  const bob = new WebSocket(BASE.replace("http", "ws") + "/ws"); const replies = new Map(); let rn = 0; let BOB = "";
  bob.onmessage = (ev) => { const m = JSON.parse(String(ev.data)); if (m.type === "reply") replies.get(m.id)?.(m.reply); if (m.type === "snapshot" && m.cut?.you) BOB = m.cut.you; };
  await new Promise((r, j) => { bob.onopen = r; bob.onerror = j; });
  const bobReq = (verb: string, args: any) => new Promise<any>((res) => { const id = `b${++rn}`; replies.set(id, res); bob.send(JSON.stringify({ type: "request", id, verb, args })); setTimeout(() => res({ ok: false, refused: { code: "timeout" } }), 6000); });
  await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: `window.__errs = []; addEventListener('error', (e) => __errs.push('error: ' + e.message));
    window.__refused = []; window.__hints = []; addEventListener('ew-keyhint', (e) => __hints.push(e.detail));
    import('/lib/base.js').then((m) => { m.bus.on('edit-refused', (e) => __refused.push(e)); });` });
  await cdp.send("Page.navigate", { url: `${BASE}/?name=${ME}&world=${WORLD}` });
  let secs = 0; for (let i = 0; i < 160 && secs < 4; i++) { secs = (await evalJson(`document.querySelectorAll('.sec').length`).catch(() => 0)) ?? 0; if (secs < 4) await sleep(500); }
  check("boot: the client comes up", secs >= 4, `${secs} sections`);
  if (secs < 4) await die(1, "the page never booted");
  await evalJson(`(() => { const s = document.querySelector('#splash'); if (s) s.style.pointerEvents = 'none'; return true; })()`);
  await waitFor(`import('/lib/net.js').then((m) => m.replicaActive())`);
  bob.send(JSON.stringify({ type: "join", world: WORLD, id: "bob", avatar: "", replica: true })); await sleep(600);
  check("(setup) the owner makes bob a builder", (await page(`const m = await import('/lib/net.js'); return (await m.sendRequest('set', { id: '@world', component: 'roles:${BOB}', value: { role: 'builder' } })).ok;`)) === true);
  await evalJson(`import('/lib/build.js').then((m) => (m.setEditMode(true), true))`);
  check("(setup) edit mode opens", await waitFor(`document.body.classList.contains('edit-mode')`));

  // ---- ST: buildings ----
  { // where the viewport point meets the floor plane of a building (y = its slab's top), then two buildings: A first (the
    // world's first building), B around that point so the click lands inside B's cell (1, 0)–(1, 1) edge at local (1.5, 1)
    const H = await page(`const { THREE, camera, canvas } = await import('/lib/core.js'); camera.updateMatrixWorld(); const r = canvas.getBoundingClientRect();
      const ray = new THREE.Raycaster(); ray.setFromCamera(new THREE.Vector2(((${SX} - r.left) / r.width) * 2 - 1, -((${SY} - r.top) / r.height) * 2 + 1), camera);
      const h = new THREE.Vector3(); return ray.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), -0.1), h) ? [h.x, h.y, h.z] : null;`);
    const room = drawRoom(emptyStructure(), { x: 0, z: 0 }, { x: 2, z: 2 });
    const T = (p: number[]) => ({ pos: p, q: [0, 0, 0, 1], scale: [1, 1, 1] });
    const mk = (id: string, p: number[]) => page(`const m = await import('/lib/net.js'); return (await m.sendRequest('create', { id: '${id}', model: '${CRATE}', components: { transform: ${JSON.stringify(T(p))}, structure: ${JSON.stringify(room)} } })).ok;`);
    const okA = await mk("house-a", [H[0] - 14, 0, H[2]]), okB = await mk("house-b", [H[0] - 1.5, 0, H[2] - 1]);
    for (const n of NAMES) NODE.set(n, await evalJson(`'${n}'`));   // the ids the authority minted for them
    check("(setup) two buildings: house-a (the world's first) and house-b around the aim point", okA && okB && !!H, H);
    await waitFor(`import('/lib/world.js').then((m) => m.entities.has('house-b'))`);
    const A0 = JSON.stringify(disk().entities[NODE.get("house-a")].c.structure), B0 = JSON.stringify(disk().entities[NODE.get("house-b")].c.structure);
    await page(`(await import('/lib/scenegraph.js')).sceneSelect('house-b'); const s = await import('/lib/structure_ui.js'); s.setStructureMode(true); s.setTool('wall'); return true;`);
    check("ST0 the wall tool is armed in edit mode", await waitFor(`import('/lib/structure_ui.js').then((m) => m.currentTool() === 'wall' && m.isStructureMode())`));
    let n0 = myActs().length;
    const press = () => evalJson(`import('/lib/core.js').then((m) => (m.canvas.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, clientX: ${SX}, clientY: ${SY} })), true))`);
    await press();
    const one = await waitDisk(() => myActs().length === n0 + 1);
    const a = myActs().at(-1); const req = a?.e.body?.request;
    check("ST1 a click with the wall tool edits the SELECTED building (house-b), not the world's first: ONE act", one && req?.id === NODE.get("house-b") && req?.component === "structure", { acts: myActs().slice(n0).map((x) => [x.e.verb, x.e.body?.request?.id]), refused: await evalJson(`__refused.map((r) => r.text)`) });
    check("ST2 …with expect on the building as I saw it", JSON.stringify(req?.expect?.[0]?.value) === B0, req?.expect);
    check("ST3 …and house-a is untouched", JSON.stringify(disk().entities[NODE.get("house-a")].c.structure) === A0);
    const B1 = JSON.stringify(disk().entities[NODE.get("house-b")].c.structure);
    check("ST4 …a wall was added", B1 !== B0 && disk().entities[NODE.get("house-b")].c.structure.levels[0].walls.length === JSON.parse(B0).levels[0].walls.length + 1);
    await waitFor(`globalThis.__editWrites().undo.at(-1) === ${a?.seq}`);
    n0 = myActs().length;
    await key("KeyZ", { ctrlKey: true });
    check("ST5 Ctrl+Z (the editor's one undo) takes the wall away: house-b is as it was", await waitDisk(() => JSON.stringify(disk().entities[NODE.get("house-b")].c.structure) === B0 && myActs().at(-1).e.verb === "undo"), myActs().slice(n0).map((x) => x.e.body));
    // someone else changes house-b after my edit: my Ctrl+Z must not write over theirs
    await waitFor(`import('/lib/net.js').then((m) => JSON.stringify(m.replica.st.entities['house-b'].c.structure) === ${JSON.stringify(B0)})`);
    await press();
    await waitDisk(() => JSON.stringify(disk().entities[NODE.get("house-b")].c.structure) === B1);
    const mine = myActs().at(-1).seq; await waitFor(`globalThis.__editWrites().undo.at(-1) === ${mine}`);
    const theirs = drawRoom(emptyStructure(), { x: 0, z: 0 }, { x: 3, z: 3 });
    const bw = await bobReq("set", { id: NODE.get("house-b"), component: "structure", value: theirs });
    check("(setup) bob changes house-b after my edit", bw.ok, bw.refused);
    await waitFor(`import('/lib/net.js').then((m) => m.replica.st.entities['house-b'].c.structure.levels[0].tiles.length === 16)`);
    const nE = entries().length;
    await key("KeyZ", { ctrlKey: true });
    await sleep(1500);
    const after = disk();
    check("ST6 …then my Ctrl+Z writes nothing over bob's building, and house-a is still untouched",
      JSON.stringify(after.entities[NODE.get("house-b")].c.structure) === JSON.stringify(theirs) && JSON.stringify(after.entities[NODE.get("house-a")].c.structure) === A0,
      { written: entries().slice(nE).filter((e) => e.kind === "change").map((e) => e.body?.id), refused: await evalJson(`__refused.slice(-1).map((r) => r.text)`) });
    const panel = await evalJson(`[...document.querySelectorAll('button')].map((b) => b.textContent.trim()).filter((t) => /undo building/i.test(t))`);
    check("ST7 the Create panel has no second undo ('undo building edit'): Ctrl+Z is the one undo", Array.isArray(panel) && panel.length === 0, panel);
    await page(`const s = await import('/lib/structure_ui.js'); s.setTool(null); (await import('/lib/build.js')).deselectAll(); return true;`);
  }

  // ---- GH: turn and size before the click ----
  { const tool0 = await evalJson(`import('/lib/build.js').then((m) => m.getTool())`);
    await page(`const b = await import('/lib/build.js'); await b.holdGhost('${CRATE}', 'crate'); return b.hasGhost();`);
    await waitFor(`import('/lib/build.js').then((m) => m.hasGhost())`);
    await key("KeyE"); await key("KeyE"); await key("Period");
    const pose = await evalJson(`import('/lib/build.js').then((m) => m.ghostPose?.() ?? null)`);
    check("GH1 E E . turn it 30° (clockwise from above) and size it ×1.1 while it's in hand", pose && Math.abs(pose.yaw + Math.PI / 6) < 1e-6 && Math.abs(pose.scale - 1.1) < 1e-6, pose);
    check("GH2 …E didn't permission the tool under it", (await evalJson(`import('/lib/build.js').then((m) => m.getTool())`)) === tool0);
    check("GH3 the status line names the keys while it's in hand", await evalJson(`__hints.some((h) => h != null && /turn/.test(String(h)) && /size/.test(String(h)))`), await evalJson(`__hints`));
    const n0 = myActs().length;
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: SX - 120, y: SY + 40 }); await sleep(200);
    await evalJson(`import('/lib/core.js').then((m) => (m.canvas.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: ${SX - 120}, clientY: ${SY + 40} })), true))`);
    const placed = await waitDisk(() => myActs().length === n0 + 1 && myActs().at(-1).e.verb === "create");
    const t = myActs().at(-1)?.e.body?.request?.components?.transform;
    const yaw = t ? 2 * Math.atan2(t.q[1], t.q[3]) : null;
    check("GH4 the click places it turned and sized: ONE create, yaw −30°, scale 1.1", placed && Math.abs(yaw + Math.PI / 6) < 1e-3 && t.scale.every((v: number) => Math.abs(v - 1.1) < 1e-6), { t, acts: myActs().slice(n0).map((x) => x.e.verb) });
    check("GH5 the status line is given back once it's placed", await waitFor(`__hints.at(-1) === null`, 2000), await evalJson(`__hints.slice(-2)`));
  }

  // ---- SC: a new script from the Inspector ----
  { const thing = myActs().at(-1)?.e.body?.request?.id;
    await page(`(await import('/lib/scenegraph.js')).sceneSelect('${thing}'); return true;`);
    const btn = `[...document.querySelectorAll('[data-frame="inspector"] button')].find((b) => /Add Script/.test(b.textContent))`;
    check("SC1 the Inspector offers 'Add Script…' on the selected thing", await waitFor(`!!(${btn}) && !(${btn}).disabled`), await evalJson(`[...document.querySelectorAll('[data-frame="inspector"] button')].map((b) => b.textContent).slice(0, 30)`));
    await evalJson(`(${btn})?.click(), true`);
    check("SC2 …it opens the card, a template that runs as it stands already in it", await waitFor(`!!document.querySelector('#script-new .sn-src') && /world\\.on\\("use"/.test(document.querySelector('#script-new .sn-src').value)`));
    const n0 = myActs().length;
    await evalJson(`(() => { const n = document.querySelector('#script-new .sn-name'); if (!n) return false; n.value = 'Greeter'; document.querySelector('#script-new .sn-ok').click(); return true; })()`);
    const made = await waitDisk(() => myActs().length === n0 + 1);
    const b = myActs().at(-1)?.e; const ops = b?.body?.request?.ops ?? [];
    check("SC3 Create: ONE act, script:greeter + its use reaction (the upload isn't an act)", made && b.verb === "batch" && ops.some((o: any) => o.args?.component === "script:greeter") && ops.some((o: any) => o.args?.component === "reactions"),
      { acts: myActs().slice(n0).map((x) => x.e.verb), refused: await evalJson(`__refused.map((r) => r.text)`), card: await evalJson(`document.querySelector('#script-new .sn-err')?.textContent ?? null`) });
    check("SC4 …and the card closes", await waitFor(`!document.querySelector('#script-new')`));
    const used = await bobReq("use", { id: thing });
    check("SC5 a visitor's use runs it: the counter it keeps is on the record, and it spoke", used.ok && await waitDisk(() => disk().entities[thing]?.c["local/counter"]?.n === 1) && entries().some((e) => e.kind === "say" && /used me \(1\)/.test(e.body?.text ?? "")), [used.refused, disk().entities[thing]?.c["local/counter"]]);
    check("SC6 the Inspector lists it under Scripts", await waitFor(`[...document.querySelectorAll('[data-frame="inspector"]')].some((f) => /greeter/.test(f.textContent))`, 6000));
  }
  check("errors: no page error", await evalJson(`__errs.length === 0`), await evalJson(`__errs`));
  bob.close();
} catch (e) { check("the run threw", false, String(e?.stack ?? e)); }
console.log(`[build-probe] ${tally.passed} passed, ${tally.failed} failed`);
await cleanup(tally.failed ? 1 : 0);
process.exit(tally.failed ? 1 : 0);
