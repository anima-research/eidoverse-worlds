// test/protocol/build-probe.ts — ship-list group B (10-07) in a real browser: one headless Chromium against a scratch
// sequencer (test/harness/harness.ts scratchBench), run under the house guards like client-check:
//   code/scripts/eido-probe.sh -C <worktree> -t 400 test/protocol/build-probe.ts      (a host's own guard script, outside this repo; test:protocol's `build-client` runs guarded when the host sets PROTOCOL_HEADLESS_LOCK and PROTOCOL_PERF_GUARD: test/gate/run.ts)
//   ST  a building edit lands on the SELECTED building (not the world's first), as ONE act with expect; Ctrl+Z (the
//       editor's one undo) puts it back; after someone else changes it, Ctrl+Z writes nothing over their work; the
//       Create panel has no second "undo building edit"
//   GH  placing a model: E turns it and . sizes it BEFORE the click (the status line says so), and the click
//       places it turned and sized, as ONE create (Q and , aren't driven)
//   SC  the Inspector's "Add Script…" makes a script: upload, then ONE act (script:<name> + its use reaction); another
//       person's use runs it (bob, a builder here); the Inspector lists it
//   MM  a mesh drag of one of several selected things moves them all as ONE act (one Ctrl+Z), planar: over a floor, a
//       box on a selected table and a crate stepping off a platform keep their heights, and so do the things with them;
//       a rider drawn off its carrier stays out of the batch; a tool switch after the press doesn't change the drag (nor
//       make a select press one); the pivot tool's drag moves only the one thing; a Shift drag stops at the first member's
//       ground, and a member already below its ground, leading or following, doesn't lift the lot; a switch to the pivot
//       tool mid-way through a gizmo drag doesn't take it over (it stays a move); a refused group release puts every member
//       back and leaves no claim open; a lock question cancelled after a newer drag began puts back only what that newer
//       drag doesn't hold; an undo, a deselect or a selection change mid-drag cancels it as Esc does, then goes ahead
// The writes go through the real edit code (structure_ui.js, build.js, scriptcard.js, edit/panels.js); gestures are
// driven at their seams (a mousedown on the canvas, synthetic keydowns, the card's own buttons), as client-check does.
// @ts-nocheck
import fs from "node:fs";
import path from "node:path";
import { scratchBench, mkCheck, sleep } from "../harness/harness.ts";
import { readLog, fold } from "../../shared/protocol/fold.js";
import { emptyStructure, drawRoom } from "../../shared/structure-edit.js";

const ENGINE = path.resolve(import.meta.dir, "../..");
const ME = "editbot", WORLD = "buildp";
process.env.TRUST_NAMES = "1";
const CRATE = "eidoverse/assets/models/crate_large_blue.glb";
let worldsDir = "";
import { inPage } from "../harness/idalias.ts";
import { pageWaiter, tryUntil, WAIT_SCALE } from "../gate/wait.ts";
import { helloOf } from "../../shared/protocol/hello.js";
// R 10-17: the page names what it makes with placeholders (test/harness/idalias.ts pageIds); NODE holds the minted ids
// once read back, so node-side checks and later page code use them
const NODE = new Map<string, string>(); const NAMES = ["house-a", "house-b"];
const { cdp, evalJson: evalRaw, cleanup, die, BASE } = await scratchBench("build", {
  prepare: (scratch) => {
    worldsDir = path.join(scratch, "worlds"); fs.mkdirSync(worldsDir, { recursive: true });
    const r = Bun.spawnSync(["bun", "tools/world.ts", "found", WORLD, "--owner", ME, "--title", "build probe"], { cwd: ENGINE, env: { ...process.env, WORLDS_DIR: worldsDir, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" } });
    if (r.exitCode !== 0) throw new Error("founding failed: " + r.stderr.toString());
  },
});
const evalJson = (expr: string) => evalRaw(inPage(expr, NAMES, NODE));
const { check: check0, tally } = mkCheck();
const check = (name: string, ok: any, detail?: any) => check0(name, !!ok, detail === undefined ? "" : typeof detail === "string" ? detail.slice(0, 600) : (JSON.stringify(detail) ?? "").slice(0, 600));
const entries = () => readLog(fs.readFileSync(path.join(worldsDir, WORLD, "world.jsonl")));
const MY = () => entries().find((e: any) => e?.kind === "request" && e.verb === "create-world")?.actor;
const myActs = () => entries().map((e, seq) => ({ e, seq })).filter(({ e }) => e?.kind === "request" && e.actor === MY() && !e.body?.refused);
const disk = () => fold(entries());
const waitFor = pageWaiter(evalJson);
const waitDisk = async (pred: () => boolean, ms = 8000) => { const t0 = Date.now(); ms *= WAIT_SCALE; while (Date.now() - t0 < ms) { try { if (pred()) return true; } catch { /* mid-write */ } await sleep(100); } return false; };
const key = (code: string, mods: any = {}) => { const m = Object.entries(mods).map(([k, v]) => `${k}: ${v}`).join(", ");
  return evalJson(`dispatchEvent(new KeyboardEvent('keydown', { code: '${code}', key: '${code}', bubbles: true, ${m} })), dispatchEvent(new KeyboardEvent('keyup', { code: '${code}', key: '${code}', bubbles: true, ${m} })), true`); };
const page = (js: string) => evalJson(`(async () => { ${js} })()`);
const SX = 760, SY = 470;   // the viewport point every gesture aims at (client-check's place point: the ground in view)

try {
  const bob = new WebSocket(BASE.replace("http", "ws") + "/ws"); const replies = new Map(); let rn = 0; let BOB = "";
  const bobDrags: any[] = [];   // the live drags bob is shown (MM15–MM19: which samples end a claim, which put a thing back)
  bob.onmessage = (ev) => { const m = JSON.parse(String(ev.data)); if (m.type === "reply") replies.get(m.id)?.(m.reply); if (m.type === "snapshot" && m.actor) BOB = m.actor; if (m.type === "drag") bobDrags.push(m); };
  await new Promise((r, j) => { bob.onopen = r; bob.onerror = j; });
  const bobReq = (verb: string, args: any) => new Promise<any>((res) => { const id = `b${++rn}`; replies.set(id, res); bob.send(JSON.stringify({ type: "request", id, verb, args })); setTimeout(() => res({ ok: false, refused: { code: "timeout" } }), 6000); });
  await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: `window.__errs = []; addEventListener('error', (e) => __errs.push('error: ' + e.message));
    window.__refused = []; window.__hints = [];
    import('/lib/base.js').then((m) => { m.bus.on('edit-refused', (e) => __refused.push(e)); m.bus.on('keyhint', (h) => __hints.push(h)); });` });
  await cdp.send("Page.navigate", { url: `${BASE}/?name=${ME}&world=${WORLD}` });
  let secs = 0; for (let i = 0; i < 160 && secs < 4; i++) { secs = (await evalJson(`document.querySelectorAll('.sec').length`).catch(() => 0)) ?? 0; if (secs < 4) await sleep(500); }
  check("boot: the client comes up", secs >= 4, `${secs} sections`);
  if (secs < 4) await die(1, "the page never booted");
  await evalJson(`(() => { const s = document.querySelector('#splash'); if (s) s.style.pointerEvents = 'none'; return true; })()`);
  await waitFor(`import('/lib/net.js').then((m) => m.replicaActive())`);
  bob.send(JSON.stringify({ type: "join", hello: helloOf(), world: WORLD, id: "bob", avatar: "", replica: true })); await sleep(600);
  check("(setup) the owner makes bob a builder", (await page(`const m = await import('/lib/net.js'); return (await m.sendRequest('set', { id: '@world', component: 'roles:${BOB}', value: { role: 'builder' } })).ok;`)) === true);
  await evalJson(`import('/lib/edit/build.js').then((m) => (m.setBuildMode(true), true))`);
  check("(setup) build mode opens", await waitFor(`document.body.classList.contains('build-mode')`));

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
    // ST4/ST5 evidence: who I am, house-b's id and wall count now, and what the log says happened after a given seq
    const walls = () => { try { return disk().entities[NODE.get("house-b")].c.structure.levels[0].walls.length; } catch { return null; } };
    const logAfter = (seq: number) => entries().slice(seq + 1).map((e) => ({ kind: e?.kind, verb: e?.verb ?? e?.body?.verb, id: e?.body?.id ?? e?.body?.args?.id, refused: e?.body?.refused ?? undefined }));
    const ids = { me: ME, my: MY(), houseA: NODE.get("house-a"), houseB: NODE.get("house-b") };
    const w0 = walls();
    await page(`(await import('/lib/scenegraph.js')).sceneSelect('house-b'); const s = await import('/lib/edit/structure_ui.js'); s.setStructureMode(true); s.setTool('wall'); return true;`);
    check("ST0 the wall tool is armed in build mode", await waitFor(`import('/lib/edit/structure_ui.js').then((m) => m.currentTool() === 'wall' && m.isStructureMode())`),
      { ids, walls: w0, editor: await evalJson(`Promise.all([import('/lib/edit/structure_ui.js'), import('/lib/scenegraph.js')]).then(([s, g]) => ({ tool: s.currentTool(), mode: s.isStructureMode(), selected: g.sceneSelected?.() ?? null, build: document.body.classList.contains('build-mode') }))`).catch((e) => String(e)) });
    let n0 = myActs().length;
    const press = () => evalJson(`import('/lib/core.js').then((m) => (m.canvas.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, clientX: ${SX}, clientY: ${SY} })), true))`);
    // a recompute of the wall tool's aim (its own functions, against B0), sampled just before and just after the click: the
    // camera may move between them, so a drift shows as drift; the requested value below is what decides
    const aimAt = () => evalJson(`(async () => { const B0 = ${B0}, [{ THREE, canvas, camera }, S, E] = await Promise.all([import('/lib/core.js'), import('/shared/structure.js'), import('/shared/structure-edit.js')]);
      const ent = (await import('/lib/state.js')).state.st.entities['house-b'], r = canvas.getBoundingClientRect(), ndc = new THREE.Vector2(((${SX} - r.left) / r.width) * 2 - 1, -((${SY} - r.top) / r.height) * 2 + 1);
      camera.updateMatrixWorld(); const ray = new THREE.Raycaster(); ray.setFromCamera(ndc, camera);
      const y = (ent?.pos?.[1] ?? 0) + (Number.isFinite(B0.levels?.[0]?.y) ? B0.levels[0].y : 0) + (Number.isFinite(B0.slabT) ? B0.slabT : S.GRID_DEFAULTS.slabT), h = new THREE.Vector3(), r3 = (v) => Math.round(v * 1000) / 1000;
      if (!ray.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), -y), h)) return { hit: null };
      const [lx, , lz] = S.localizePoint(ent, h.x, h.y, h.z), e = E.pickEdge(B0, lx, lz);
      return { cam: camera.position.toArray().map(r3), local: [r3(lx), r3(lz)], edge: e && \`\${e.axis}:\${e.x},\${e.z}\`, occupied: !!e && B0.levels[0].walls.some((w) => w[0] === e.axis && w[1] === e.x && w[2] === e.z) }; })()`).catch((e) => String(e).slice(0, 120));
    const view = await evalJson(`(async () => { const { canvas } = await import('/lib/core.js'), r = canvas.getBoundingClientRect(); return { rect: [r.left, r.top, r.width, r.height].map(Math.round), dpr: devicePixelRatio, px: [${SX}, ${SY}], target: (await import('/lib/edit/structure_ui.js')).structureSelection() }; })()`).catch((e) => String(e).slice(0, 80));
    const aimPre = await aimAt();
    await press();
    const aimPost = await aimAt(), aim = { ...(typeof view === "object" ? view : { view }), pre: aimPre, post: aimPost };
    const one = await waitDisk(() => myActs().length === n0 + 1);
    const a = myActs().at(-1); const req = a?.e.body?.args;
    check("ST1 a click with the wall tool edits the SELECTED building (house-b), not the world's first: ONE act", one && req?.id === NODE.get("house-b") && req?.component === "structure", { acts: myActs().slice(n0).map((x) => [x.e.verb, x.e.body?.args?.id]), refused: await evalJson(`__refused.map((r) => r.text)`) });
    check("ST2 …with expect on the building as I saw it", JSON.stringify(req?.expect?.[0]?.value) === B0, req?.expect);
    check("ST3 …and house-a is untouched", JSON.stringify(disk().entities[NODE.get("house-a")].c.structure) === A0);
    await waitDisk(() => JSON.stringify(disk().entities[NODE.get("house-b")].c.structure) !== B0);   // the act lands before its change entry; the fold reads the change
    const B1 = JSON.stringify(disk().entities[NODE.get("house-b")].c.structure);
    const wk = (st: any) => (st?.levels?.[0]?.walls ?? []).map((w: number[]) => `${w[0]}:${w[1]},${w[2]}`);
    const b0w = wk(JSON.parse(B0)), rqw = wk(req?.value);
    const value = { b0: b0w.length, requested: rqw.length, added: rqw.filter((k: string) => !b0w.includes(k)), removed: b0w.filter((k: string) => !rqw.includes(k)) };
    const st4 = B1 !== B0 && disk().entities[NODE.get("house-b")].c.structure.levels[0].walls.length === JSON.parse(B0).levels[0].walls.length + 1;
    // on a red only: did the wall land late, or never (and what followed the act in the log)? no wait on a green
    const st4ev = st4 ? undefined : { aim, value, act: a?.seq, wallsBefore: w0, wallsAtCheck: JSON.parse(B1).levels?.[0]?.walls?.length ?? null,
      landedBy8s: await waitDisk(() => walls() === (w0 ?? -2) + 1), wallsLater: walls(), log: a ? logAfter(a.seq).slice(0, 4) : null,
      refused: await evalJson(`__refused.map((r) => r.text)`), houseB: ids.houseB };
    check("ST4 …a wall was added", st4, st4ev);
    await waitFor(`globalThis.__editWrites().undo.at(-1) === ${a?.seq}`);
    n0 = myActs().length; const nU = entries().length - 1;   // taken before the key, so the log starts at the undo request
    await key("KeyZ", { ctrlKey: true });
    check("ST5 Ctrl+Z (the editor's one undo) takes the wall away: house-b is as it was", await waitDisk(() => JSON.stringify(disk().entities[NODE.get("house-b")].c.structure) === B0 && myActs().at(-1).e.verb === "undo"),
      { wallsBefore: w0, wallsAfterUndo: walls(), acts: myActs().slice(n0).map((x) => x.e.verb), log: logAfter(nU).slice(0, 8), ids, refused: await evalJson(`__refused.map((r) => r.text)`) });
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
    await page(`const s = await import('/lib/edit/structure_ui.js'); s.setTool(null); (await import('/lib/edit/build.js')).deselectAll(); return true;`);
  }

  // ---- GH: turn and size before the click ----
  { const tool0 = await evalJson(`import('/lib/edit/build.js').then((m) => m.getTool())`);
    await page(`const b = await import('/lib/edit/build.js'); await b.holdGhost('${CRATE}', 'crate'); return b.hasGhost();`);
    await waitFor(`import('/lib/edit/build.js').then((m) => m.hasGhost())`);
    await key("KeyE"); await key("KeyE"); await key("Period");
    const pose = await evalJson(`import('/lib/edit/build.js').then((m) => m.ghostPose?.() ?? null)`);
    check("GH1 E E . turn it 30° (clockwise from above) and size it ×1.1 while it's in hand", pose && Math.abs(pose.yaw + Math.PI / 6) < 1e-6 && Math.abs(pose.scale - 1.1) < 1e-6, pose);
    check("GH2 …and E didn't switch the tool under it (the edit tool is unchanged)", (await evalJson(`import('/lib/edit/build.js').then((m) => m.getTool())`)) === tool0);
    check("GH3 the status line names the keys while it's in hand", await evalJson(`__hints.some((h) => h != null && /turn/.test(String(h)) && /size/.test(String(h)))`), await evalJson(`__hints`));
    const n0 = myActs().length;
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: SX - 120, y: SY + 40 }); await sleep(200);
    await evalJson(`import('/lib/core.js').then((m) => (m.canvas.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: ${SX - 120}, clientY: ${SY + 40} })), true))`);
    const placed = await waitDisk(() => myActs().length === n0 + 1 && myActs().at(-1).e.verb === "create");
    const t = myActs().at(-1)?.e.body?.args?.components?.transform;
    const yaw = t ? 2 * Math.atan2(t.q[1], t.q[3]) : null;
    check("GH4 the click places it turned and sized: ONE create, yaw −30°, scale 1.1", placed && Math.abs(yaw + Math.PI / 6) < 1e-3 && t.scale.every((v: number) => Math.abs(v - 1.1) < 1e-6), { t, acts: myActs().slice(n0).map((x) => x.e.verb) });
    check("GH5 the status line is given back once it's placed", await waitFor(`__hints.at(-1) === null`, 2000), await evalJson(`__hints.slice(-2)`));
  }

  // ---- SC: a new script from the Inspector ----
  { const thing = myActs().at(-1)?.e.body?.args?.id;
    await page(`(await import('/lib/scenegraph.js')).sceneSelect('${thing}'); return true;`);
    const btn = `[...document.querySelectorAll('[data-frame="inspector"] button')].find((b) => /Add Script/.test(b.textContent))`;
    check("SC1 the Inspector offers 'Add Script…' on the selected thing", await waitFor(`!!(${btn}) && !(${btn}).disabled`), await evalJson(`[...document.querySelectorAll('[data-frame="inspector"] button')].map((b) => b.textContent).slice(0, 30)`));
    await evalJson(`(${btn})?.click(), true`);
    check("SC2 …it opens the card, a template that runs as it stands already in it", await waitFor(`!!document.querySelector('#script-new .sn-src') && /world\\.on\\("use"/.test(document.querySelector('#script-new .sn-src').value)`));
    const n0 = myActs().length;
    await evalJson(`(() => { const n = document.querySelector('#script-new .sn-name'); if (!n) return false; n.value = 'Greeter'; document.querySelector('#script-new .sn-ok').click(); return true; })()`);
    const made = await waitDisk(() => myActs().length === n0 + 1);
    const b = myActs().at(-1)?.e; const ops = b?.body?.args?.requests ?? [];
    check("SC3 Create: ONE act, script:greeter + its use reaction (the upload isn't an act)", made && b.verb === "batch" && ops.some((o: any) => o.args?.component === "script:greeter") && ops.some((o: any) => o.args?.component === "reactions"),
      { acts: myActs().slice(n0).map((x) => x.e.verb), refused: await evalJson(`__refused.map((r) => r.text)`), card: await evalJson(`document.querySelector('#script-new .sn-err')?.textContent ?? null`) });
    check("SC4 …and the card closes", await waitFor(`!document.querySelector('#script-new')`));
    const used = await bobReq("use", { id: thing });
    check("SC5 another builder's use runs it (Bob's): the counter it keeps is on the record, and it spoke", used.ok && await waitDisk(() => disk().entities[thing]?.c["local/counter"]?.n === 1) && entries().some((e) => e.kind === "say" && /used me \(1\)/.test(e.body?.text ?? "")), [used.refused, disk().entities[thing]?.c["local/counter"]]);
    check("SC6 the Inspector lists it under Scripts", await waitFor(`[...document.querySelectorAll('[data-frame="inspector"]')].some((f) => /greeter/.test(f.textContent))`, 6000));
  }
  // ---- MM: the selection follows a mesh drag (edit/multimove.js) ----
  // a furnished corner off to the side of what the earlier sections built: a floor slab, a table on it with a box on the
  // table, a platform with a crate on it, a chair on the floor; a cart further off carries a kid
  { NAMES.push("mm-floor", "mm-tbl", "mm-box", "mm-plat", "mm-crate", "mm-chair", "mm-post", "mm-sign", "mm-cart", "mm-kid");
    const camNow = () => evalJson(`import('/lib/core.js').then((c) => { c.camera.updateMatrixWorld(); return c.camera.matrixWorld.elements.map((v) => +v.toFixed(4)).join(); })`);
    // the view holds still: five samples in a row, each two frames after the last, see the same camera (polls alone can
    // land between frames on a slow page and read one matrix twice)
    const settle = async () => { let last = await camNow(), same = 0;
      return !!(await tryUntil("the view holds still", async () => { await frames(2); const now = await camNow(); same = now === last ? same + 1 : 0; last = now; return same >= 5 || null; }, { ms: 12000, step: 200 })); };
    const frames = (n: number) => evalJson(`new Promise((r) => { let k = ${n}; const f = () => (--k ? requestAnimationFrame(f) : r(true)); requestAnimationFrame(f); })`);
    await settle();
    const G = await evalJson(`import('/lib/core.js').then((c) => { const T = c.THREE, f = c.camera.getWorldDirection(new T.Vector3()); f.y = 0; f.normalize(); const o = c.camera.getWorldPosition(new T.Vector3());
      return [o.x + f.x * 8 - f.z * 12, o.z + f.z * 8 + f.x * 12]; })`);   // 8 m ahead, 12 m to the right
    const mk = (id: string, p: number[], sc: number[], extra: any = {}) => page(`const m = await import('/lib/net.js'); return (await m.sendRequest('create', { id: '${id}', model: '${CRATE}', components: { transform: { pos: ${JSON.stringify(p)}, q: [0, 0, 0, 1], scale: ${JSON.stringify(sc)} }, ...${JSON.stringify(extra)} } })).ok;`);
    const drawn = (id: string) => waitFor(`import('/lib/world.js').then((m) => { const o = m.entities.get('${id}'); return !!o && o.children.length > 0; })`, 12000);
    const topOf = (id: string) => evalJson(`Promise.all([import('/lib/core.js'), import('/lib/world.js')]).then(([c, w]) => { const b = new c.THREE.Box3().setFromObject(w.entities.get('${id}')); return b.isEmpty() ? null : b.max.y; })`);
    const place = async (id: string, p: number[], sc: number[], extra: any = {}) => { const ok = await mk(id, p, sc, extra); NODE.set(id, await evalJson(`'${id}'`)); return ok && await drawn(id); };
    const [sx, sz] = G;
    let ok = await place("mm-floor", [sx, 0, sz], [4, 0.04, 4]);
    const fy = await tryUntil("the floor has its size", () => topOf("mm-floor"));
    ok = ok && !!fy && await place("mm-tbl", [sx - 2.5, fy, sz], [1, 0.5, 1]) && await place("mm-plat", [sx + 2, fy, sz], [0.6, 0.3, 0.6]) && await place("mm-chair", [sx, fy, sz + 1.8], [0.3, 0.3, 0.3]);
    const ty = await tryUntil("the table has its size", () => topOf("mm-tbl")), py = await tryUntil("the platform has its size", () => topOf("mm-plat"));
    ok = ok && !!ty && !!py && await place("mm-box", [sx - 2.5, ty, sz], [0.4, 0.4, 0.4]) && await place("mm-crate", [sx + 2, py, sz], [0.3, 0.3, 0.3])
      && await place("mm-post", [sx + 4, -0.3, sz - 4.5], [0.2, 0.5, 0.2]) && await place("mm-sign", [sx + 5.5, 0, sz - 4.5], [0.3, 0.3, 0.3])
      && await place("mm-cart", [sx, 0, sz - 7], [0.5, 0.5, 0.5]) && await place("mm-kid", [sx, 0, sz - 7], [1, 1, 1], { parent: { to: "mm-cart", order: "a0" } });
    check("MM (setup) a floor with a table (a box on it), a platform (a crate on it) and a chair; a post sunk 0.3 m and a sign; a cart with a kid further off", ok, { G, fy, ty, py });
    const frame = async (id: string, r: number) => { await page(`const { THREE } = await import('/lib/core.js'); const w = await import('/lib/world.js'); const C = await import('/lib/player/controller.js');
      const b = new THREE.Box3().setFromObject(w.entities.get('${id}')); C.setCamPitch(1); return C.frameOn(b.getCenter(new THREE.Vector3()), ${r});`); await frames(2); await settle(); };
    // a press pixel ON `lead` whose ray, past it, meets the top of `under` (any, with no `under`) (where an aim that doesn't skip `under` lands)
    await evalJson(`Promise.all([import('/lib/core.js'), import('/lib/world.js')]).then(([c, w]) => { const T = c.THREE;
      const inside = (o, r) => { for (let q = o; q; q = q.parent) if (q === r) return true; return false; };
      globalThis.__mmHit = (x, y, lead, under) => { const rc = new T.Raycaster(); rc.setFromCamera(new T.Vector2(x / innerWidth * 2 - 1, -(y / innerHeight) * 2 + 1), c.camera);
        const hs = rc.intersectObjects([...w.entities.values()].filter(Boolean), true), L = w.entities.get(lead), U = w.entities.get(under);
        const past = hs.find((h) => !inside(h.object, L)), up = !!past?.face && past.face.normal.clone().transformDirection(past.object.matrixWorld).y > 0.6;
        return { onLead: !!hs[0] && inside(hs[0].object, L), onTop: !U || (!!past && inside(past.object, U) && up) }; };
      globalThis.__mmPress = (lead, under) => { const b = new T.Box3().setFromObject(w.entities.get(lead)), xs = [], ys = [];
        for (const cx of [b.min.x, b.max.x]) for (const cy of [b.min.y, b.max.y]) for (const cz of [b.min.z, b.max.z]) { const s = new T.Vector3(cx, cy, cz).project(c.camera); xs.push((s.x + 1) / 2 * innerWidth); ys.push((1 - s.y) / 2 * innerHeight); }
        const mx = Math.round((Math.min(...xs) + Math.max(...xs)) / 2), my = Math.round((Math.min(...ys) + Math.max(...ys)) / 2);
        for (let r = 0; r < 40; r += 2) for (const [dx, dy] of [[0, 0], [r, 0], [-r, 0], [0, r], [0, -r]]) { const h = __mmHit(mx + dx, my + dy, lead, under); if (h.onLead && h.onTop) return [mx + dx, my + dy]; }
        return null; };
      globalThis.__mmPx = (p) => { const s = new T.Vector3(...p).project(c.camera); return [Math.round((s.x + 1) / 2 * innerWidth), Math.round((1 - s.y) / 2 * innerHeight)]; };
      return true; })`);
    const pose = (n: string) => disk().entities[NODE.get(n)]?.c.transform?.pos;
    const near = (a: any, b: any, e = 0.01) => !!a && !!b && a.every((v: number, i: number) => Math.abs(v - b[i]) < e);
    const dxz = (a: number[], b: number[]) => [a[0] - b[0], a[2] - b[2]];
    const sameMove = (a0: number[], a1: number[], b0: number[], b1: number[]) => { const [p, q] = [dxz(a1, a0), dxz(b1, b0)]; return Math.hypot(p[0] - q[0], p[1] - q[1]) < 0.01 && Math.hypot(...p) > 0.05; };
    // press, travel past the slop, move to `to` (`mid` runs mid-drag), release; returns the drag as the page had it once armed
    const gesture = async (at: number[], to: number[], mid?: () => Promise<any>, opt: { shift?: boolean, preArm?: () => Promise<any>, arms?: boolean } = {}) => {
      await evalJson(`import('/lib/core.js').then((m) => (m.canvas.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, shiftKey: ${!!opt.shift}, clientX: ${at[0]}, clientY: ${at[1]} })), true))`);
      if (opt.preArm) await opt.preArm();
      await evalJson(`(dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: ${at[0] + 6}, clientY: ${at[1]} })), true)`);
      await waitFor(`globalThis.__buildDrag?.()?.armed === true`, opt.arms === false ? 1500 : undefined); await frames(3);
      const drag = await evalJson(`globalThis.__buildDrag?.()`);
      const half = [Math.round((at[0] + to[0]) / 2), Math.round((at[1] + to[1]) / 2)];
      await evalJson(`(dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: ${half[0]}, clientY: ${half[1]} })), true)`); await frames(3);
      if (mid) { await mid(); await frames(3); }
      await evalJson(`(dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: ${to[0]}, clientY: ${to[1]} })), true)`); await frames(3);
      await evalJson(`(dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: ${to[0]}, clientY: ${to[1]} })), true)`);
      return drag; };
    const actsSince = (n0: number) => myActs().slice(n0).map((x) => [x.e.verb, x.e.body?.args?.id ?? x.e.body?.args?.requests?.map((r: any) => r.args?.id)]);
    const undo = async () => { await waitFor(`globalThis.__editWrites().undo.at(-1) === ${myActs().at(-1)?.seq}`); await key("KeyZ", { ctrlKey: true }); };
    const onRecord = (n: string) => waitFor(`import('/lib/net.js').then((m) => JSON.stringify(m.replica.st.entities['${n}']?.c?.transform?.pos ?? null) === ${JSON.stringify(JSON.stringify(pose(n) ?? null))})`);

    await frame("mm-tbl", 1.5);
    const at = await evalJson(`__mmPress('mm-box', 'mm-tbl')`), to = at ? [at[0] + 30, at[1] + 10] : null;
    check("MM (setup) a press point on the box whose ray past it meets the table's top", !!at, { at });
    if (at && to) {
      // the cart's kid is drawn off its carrier (as a part socket's occupant is, under the part's node): it can't take a move
      await page(`const { scene } = await import('/lib/core.js'); const w = await import('/lib/world.js'); scene.attach(w.entities.get('mm-kid')); return true;`);
      await page(`(await import('/lib/edit/build.js')).setTool('move'); (await import('/lib/edit/selection.js')).set(['mm-tbl', 'mm-box', 'mm-kid']); return true;`);
      const T0 = pose("mm-tbl"), B0 = pose("mm-box"), K0 = pose("mm-kid"); let n0 = myActs().length;
      const sel0 = await evalJson(`import('/lib/edit/selection.js').then((m) => m.selection().ids)`);
      const drag = await gesture(at, to);
      check("MM0 (precondition) the kid is in the selection, and the drag considered it and left it out", sel0?.includes(NODE.get("mm-kid")) && drag?.skipped === 1 && !drag?.follow?.includes(NODE.get("mm-kid")) && drag?.follow?.includes(NODE.get("mm-tbl")), { sel0, drag });
      const one = await waitDisk(() => myActs().length === n0 + 1);
      const act = myActs().at(-1)?.e; const reqs = act?.verb === "batch" ? act.body.args.requests : [];
      const ids = reqs.map((r: any) => r.args?.id);
      check("MM1 a mesh drag of one of several selected things is ONE act: a batch setting the box's and the table's transforms",
        one && act?.verb === "batch" && reqs.length === 2 && ids.includes(NODE.get("mm-box")) && ids.includes(NODE.get("mm-tbl")) && reqs.every((r: any) => r.verb === "set" && r.args.component === "transform"),
        { acts: actsSince(n0), refused: await evalJson(`__refused.map((r) => r.text)`) });
      await waitDisk(() => JSON.stringify(pose("mm-tbl")) !== JSON.stringify(T0));
      const T1 = pose("mm-tbl"), B1 = pose("mm-box");
      check("MM2 (precondition) …the box ended over the floor", !!B1 && Math.abs(B1[0] - sx) < 5 && Math.abs(B1[2] - sz) < 3, { B1, floor: [sx, sz] });
      check("MM2 …over a floor, the drag is planar: the box keeps its height and the table slides level with it (neither drops to the floor nor sinks)",
        !!T1 && !!B1 && Math.abs(T1[1] - T0[1]) < 0.01 && Math.abs(B1[1] - B0[1]) < 0.01 && sameMove(T0, T1, B0, B1), { T0, T1, B0, B1, floorTop: fy });
      check("MM3 …the kid drawn off its carrier stayed out (not in the batch, not moved)", !ids.includes(NODE.get("mm-kid")) && JSON.stringify(pose("mm-kid")) === JSON.stringify(K0), { ids, K0, K1: pose("mm-kid") });
      await undo();
      check("MM4 one Ctrl+Z puts the box and the table back", await waitDisk(() => JSON.stringify(pose("mm-tbl")) === JSON.stringify(T0) && JSON.stringify(pose("mm-box")) === JSON.stringify(B0)), { T: pose("mm-tbl"), B: pose("mm-box") });
      await onRecord("mm-tbl"); await onRecord("mm-box"); await frames(3); await settle();

      // a tool key mid-drag: the gesture stays the one the drag armed with (E would rebuild the followers as a turn from their start)
      const at2 = (await evalJson(`__mmPress('mm-box', 'mm-tbl')`)) ?? at;
      await page(`(await import('/lib/edit/selection.js')).set(['mm-box', 'mm-tbl']); return true;`);
      n0 = myActs().length;
      await gesture(at2, [at2[0] + 30, at2[1] + 10], () => page(`(await import('/lib/edit/build.js')).setTool('rotate'); return true;`));
      await waitDisk(() => myActs().length === n0 + 1, 4000); await waitDisk(() => JSON.stringify(pose("mm-tbl")) !== JSON.stringify(T0), 3000);
      const T2 = pose("mm-tbl"), B2 = pose("mm-box");
      check("MM7 a switch to rotate mid-drag (setTool, what E calls) doesn't change the gesture: the table still moves with the box, as one act", myActs().length === n0 + 1 && sameMove(T0, T2, B0, B2), { T0, T2, B0, B2, acts: actsSince(n0) });
      await page(`(await import('/lib/edit/build.js')).setTool('move'); return true;`);
      if (myActs().length === n0 + 1) { await undo(); await waitDisk(() => JSON.stringify(pose("mm-tbl")) === JSON.stringify(T0)); }
      await onRecord("mm-tbl"); await onRecord("mm-box"); await frames(3); await settle();

      // the pivot tool moves one thing's pivot, never a group's: its mesh drag moves the pressed thing alone
      const at3 = (await evalJson(`__mmPress('mm-box', 'mm-tbl')`)) ?? at;
      await page(`(await import('/lib/edit/build.js')).setTool('pivot'); (await import('/lib/edit/selection.js')).set(['mm-tbl', 'mm-box']); return true;`);
      n0 = myActs().length;
      await gesture(at3, [at3[0] + 30, at3[1] + 10]);
      await waitDisk(() => myActs().length === n0 + 1, 4000);
      const pa = myActs().slice(n0).map((x) => x.e);
      check("MM5 the pivot tool's mesh drag moves the pressed box alone: one set on it, the table where it is",
        JSON.stringify(pose("mm-tbl")) === JSON.stringify(T0) && pa.length === 1 && pa[0].verb === "set" && pa[0].body?.args?.id === NODE.get("mm-box"), { acts: actsSince(n0), T: pose("mm-tbl") });
      await page(`(await import('/lib/edit/build.js')).setTool('move'); return true;`);
      if (pa.length === 1) { await undo(); await waitDisk(() => JSON.stringify(pose("mm-box")) === JSON.stringify(B0)); }
      await onRecord("mm-tbl"); await onRecord("mm-box"); await frames(3); await settle();

      // a tool key between the press and the arm: the press's tool decides both the gesture and who follows
      const at5 = (await evalJson(`__mmPress('mm-box', 'mm-tbl')`)) ?? at;
      await page(`(await import('/lib/edit/selection.js')).set(['mm-box', 'mm-tbl']); return true;`);
      n0 = myActs().length;
      await gesture(at5, [at5[0] + 30, at5[1] + 10], undefined, { preArm: () => page(`(await import('/lib/edit/build.js')).setTool('rotate'); return true;`) });
      await waitDisk(() => myActs().length === n0 + 1, 4000); await waitDisk(() => JSON.stringify(pose("mm-tbl")) !== JSON.stringify(T0), 3000);
      const T5 = pose("mm-tbl"), B5 = pose("mm-box");
      check("MM9 a switch to rotate between the press and the arm (setTool) doesn't change the drag: the table still moves with the box", myActs().length === n0 + 1 && sameMove(T0, T5, B0, B5), { T0, T5, B0, B5, acts: actsSince(n0) });
      await page(`(await import('/lib/edit/build.js')).setTool('move'); return true;`);
      if (myActs().length === n0 + 1) { await undo(); await waitDisk(() => JSON.stringify(pose("mm-tbl")) === JSON.stringify(T0)); }
      await onRecord("mm-tbl"); await onRecord("mm-box"); await frames(3); await settle();

      // Shift: the vertical drag of the lot stops at the first member to reach its ground (the table's feet, not the box's)
      const at6 = (await evalJson(`__mmPress('mm-box', 'mm-tbl')`)) ?? at;
      await page(`(await import('/lib/edit/selection.js')).set(['mm-box', 'mm-tbl']); return true;`);
      n0 = myActs().length;
      await gesture(at6, [at6[0], at6[1] + 300], undefined, { shift: true });
      await waitDisk(() => myActs().length === n0 + 1, 4000); await waitDisk(() => JSON.stringify(pose("mm-box")) !== JSON.stringify(B0), 3000);
      const T6 = pose("mm-tbl"), B6 = pose("mm-box");
      const g6 = await evalJson(`import('/lib/terrain.js').then((m) => m.heightAt(${T0[0]}, ${T0[2]}))`);
      check("MM10 a Shift drag down of the box stops when the selected table reaches its ground: both drop by the table's clearance",
        myActs().length === n0 + 1 && !!T6 && !!B6 && Math.abs((B0[1] - B6[1]) - (T0[1] - g6)) < 0.01 && Math.abs((T6[1] - T0[1]) - (B6[1] - B0[1])) < 0.01, { T0, T6, B0, B6, ground: g6, acts: actsSince(n0) });
      if (myActs().length === n0 + 1) { await undo(); await waitDisk(() => JSON.stringify(pose("mm-box")) === JSON.stringify(B0)); }
      await onRecord("mm-tbl"); await onRecord("mm-box"); await frames(3);
    }

    // the lead steps off an UNSELECTED platform onto the floor: its surface change is not the followers' (no chair underground)
    await frame("mm-plat", 2.5);
    const at4 = await evalJson(`__mmPress('mm-crate', 'mm-plat')`);
    const to4 = at4 ? await evalJson(`__mmPx([${sx + 2}, ${fy}, ${sz + 2.2}])`) : null;
    check("MM (setup) a press point on the crate over the platform's top, and a floor point off the platform", !!at4 && !!to4, { at4, to4 });
    if (at4 && to4) {
      await page(`(await import('/lib/edit/selection.js')).set(['mm-crate', 'mm-chair']); return true;`);
      const C0 = pose("mm-crate"), H0 = pose("mm-chair"); const n0 = myActs().length;
      await gesture(at4, to4);
      await waitDisk(() => myActs().length === n0 + 1); await waitDisk(() => JSON.stringify(pose("mm-chair")) !== JSON.stringify(H0), 3000);
      const C1 = pose("mm-crate"), H1 = pose("mm-chair");
      check("MM6 dragging the crate off the platform keeps the chair on the floor: the crate keeps its height, the chair slides level with it",
        !!C1 && !!H1 && Math.abs(H1[1] - H0[1]) < 0.01 && Math.abs(C1[1] - C0[1]) < 0.01 && sameMove(H0, H1, C0, C1), { C0, C1, H0, H1, floorTop: fy, acts: actsSince(n0) });
    }

    // a follower already below its ground (a sunk post) goes no lower, but doesn't lift the lot: a small Shift nudge up raises
    // the sign and the post by the nudge alone
    await frame("mm-sign", 1.5);
    const at7 = await evalJson(`__mmPress('mm-sign', null)`);
    check("MM (setup) a press point on the sign", !!at7, { at7 });
    if (at7) {
      await page(`(await import('/lib/edit/build.js')).setTool('move'); (await import('/lib/edit/selection.js')).set(['mm-sign', 'mm-post']); return true;`);
      const S0 = pose("mm-sign"), P0 = pose("mm-post"); let n0 = myActs().length;
      await gesture(at7, [at7[0], at7[1] - 10], undefined, { shift: true });
      await waitDisk(() => myActs().length === n0 + 1, 4000); await waitDisk(() => JSON.stringify(pose("mm-post")) !== JSON.stringify(P0), 3000);
      const S1 = pose("mm-sign"), P1 = pose("mm-post");
      check("MM11 a Shift nudge up with a sunk post selected raises both by the nudge (well under the post's 0.3 m depth), not to the post's ground",
        myActs().length === n0 + 1 && !!S1 && !!P1 && S1[1] - S0[1] > 0.005 && S1[1] - S0[1] < 0.2 && Math.abs((P1[1] - P0[1]) - (S1[1] - S0[1])) < 0.01, { S0, S1, P0, P1, acts: actsSince(n0) });
      if (myActs().length === n0 + 1) { await undo(); await waitDisk(() => JSON.stringify(pose("mm-post")) === JSON.stringify(P0)); }
      await onRecord("mm-post"); await onRecord("mm-sign"); await frames(3);

      // a press under the select tool picks: a switch to move before the travel doesn't make it a drag
      n0 = myActs().length;
      await page(`(await import('/lib/edit/build.js')).setTool('select'); (await import('/lib/edit/selection.js')).set(['mm-sign', 'mm-post']); return true;`);
      await gesture(at7, [at7[0] + 30, at7[1] + 10], undefined, { arms: false, preArm: () => page(`(await import('/lib/edit/build.js')).setTool('move'); return true;`) });
      await waitDisk(() => myActs().length > n0, 1500);
      check("MM13 a press under select, then a switch to move before the travel: no drag, nothing written", myActs().length === n0 && JSON.stringify(pose("mm-sign")) === JSON.stringify(S0), { acts: actsSince(n0), S0, S: pose("mm-sign") });
      await page(`(await import('/lib/edit/build.js')).setTool('move'); return true;`);
      if (myActs().length > n0) { await undo(); await waitDisk(() => JSON.stringify(pose("mm-sign")) === JSON.stringify(S0)); }
      await onRecord("mm-sign"); await frames(3);
    }

    // the sunk post LEADING a Shift drag: a nudge up raises both by the nudge, not by the post's depth
    await frame("mm-post", 1.5);
    const at8 = await evalJson(`__mmPress('mm-post', null)`);
    check("MM (setup) a press point on the sunk post", !!at8, { at8 });
    if (at8) {
      await page(`(await import('/lib/edit/build.js')).setTool('move'); (await import('/lib/edit/selection.js')).set(['mm-post', 'mm-sign']); return true;`);
      const S0 = pose("mm-sign"), P0 = pose("mm-post"); const n0 = myActs().length;
      const depth = await evalJson(`import('/lib/terrain.js').then((m) => m.heightAt(${P0[0]}, ${P0[2]}) - ${P0[1]})`);
      await gesture(at8, [at8[0], at8[1] - 10], undefined, { shift: true });
      await waitDisk(() => myActs().length === n0 + 1, 4000); await waitDisk(() => JSON.stringify(pose("mm-sign")) !== JSON.stringify(S0), 3000);
      const S1 = pose("mm-sign"), P1 = pose("mm-post");
      check("MM14 a Shift nudge up led by the sunk post raises both by the nudge (well under its depth), not to its ground",
        myActs().length === n0 + 1 && depth > 0.25 && !!S1 && !!P1 && P1[1] - P0[1] > 0.005 && P1[1] - P0[1] < depth - 0.1 && Math.abs((P1[1] - P0[1]) - (S1[1] - S0[1])) < 0.01, { depth, S0, S1, P0, P1, acts: actsSince(n0) });
      if (myActs().length === n0 + 1) { await undo(); await waitDisk(() => JSON.stringify(pose("mm-post")) === JSON.stringify(P0)); }
    }

    // a refused group release (bob moved the table under the drag: its expect fails) puts EVERY member back where the log has
    // it, writes nothing, and leaves no claim open on anyone else's screen (the put-back samples end the drag)
    await frame("mm-tbl", 1.5);
    const at9 = await evalJson(`__mmPress('mm-box', 'mm-tbl')`);
    check("MM (setup) a press point on the box over the table, again", !!at9, { at9 });
    if (at9) {
      await page(`(await import('/lib/edit/build.js')).setTool('move'); (await import('/lib/edit/selection.js')).set(['mm-box', 'mm-tbl']); return true;`);
      const TT0 = disk().entities[NODE.get("mm-tbl")].c.transform, B0 = pose("mm-box"), n0 = myActs().length, r0 = await evalJson(`__refused.length`);
      const theirs = { ...TT0, pos: [TT0.pos[0] + 0.5, TT0.pos[1], TT0.pos[2]] };
      let bw: any = null, d0 = 0;
      await gesture(at9, [at9[0] + 30, at9[1] + 10], async () => {
        bw = await bobReq("set", { id: NODE.get("mm-tbl"), component: "transform", value: theirs });
        await waitFor(`import('/lib/net.js').then((m) => JSON.stringify(m.replica.st.entities['mm-tbl']?.c?.transform?.pos) === ${JSON.stringify(JSON.stringify(theirs.pos))})`);
        d0 = bobDrags.length; });
      const refused = await waitFor(`__refused.length > ${r0}`, 6000); await sleep(800 * WAIT_SCALE);
      const why = await evalJson(`__refused.slice(${r0}).map((r) => r.refused?.code)`);
      const local = await evalJson(`import('/lib/world.js').then((m) => ['mm-box', 'mm-tbl'].map((n) => m.entities.get(n).position.toArray()))`);
      check("MM15 (setup) bob moves the table during the drag, and the release is refused for it (changed)", bw?.ok && refused && why?.includes("changed"), { bw: bw?.refused, why });
      check("MM15 a refused group release writes nothing and puts every member back where the log has it: the box where it was, the table where bob put it",
        myActs().length === n0 && near(pose("mm-box"), B0) && near(pose("mm-tbl"), theirs.pos) && near(local?.[0], B0) && near(local?.[1], theirs.pos), { local, B0, theirs: theirs.pos, disk: [pose("mm-box"), pose("mm-tbl")], acts: actsSince(n0) });
      const last = Object.fromEntries(["mm-box", "mm-tbl"].map((n) => [n, bobDrags.slice(d0).filter((m) => m.id === NODE.get(n)).at(-1) ?? null]));
      check("MM15 …and the put-back reopens no claim: the last sample bob saw of each member ends the drag, at the log's pose",
        Object.values(last).every((m: any) => m?.end === true) && near(last["mm-box"]?.pos, B0) && near(last["mm-tbl"]?.pos, theirs.pos), last);
      await bobReq("set", { id: NODE.get("mm-tbl"), component: "transform", value: TT0 }); await onRecord("mm-tbl"); await frames(3); await settle();
    }

    // a lock question still open when a newer drag of the box begins: cancelling it puts back the table (the old drag's alone),
    // never the box the newer drag now holds, here or on anyone else's screen; the newer drag's release writes the box
    const at10 = await evalJson(`__mmPress('mm-box', 'mm-tbl')`);
    check("MM (setup) a press point on the box over the table, once more", !!at10, { at10 });
    if (at10) {
      const lk = await page(`const m = await import('/lib/net.js'); return (await m.sendRequest('set', { id: 'mm-tbl', component: 'lock', value: true })).ok;`);
      await waitFor(`import('/lib/net.js').then((m) => m.replica.st.entities['mm-tbl']?.c?.lock === true)`);
      await page(`if (!globalThis.__reverts) { globalThis.__reverts = []; (await import('/lib/base.js')).bus.on('pose-revert', (e) => __reverts.push(e.id)); } (await import('/lib/edit/selection.js')).set(['mm-box', 'mm-tbl']); return true;`);
      const B0 = pose("mm-box"), T0 = pose("mm-tbl"), n0 = myActs().length;
      await gesture(at10, [at10[0] + 30, at10[1] + 10]);
      const asked = await waitFor(`!!document.querySelector('#confirm-center [data-v="cancel"]')`, 6000);
      check("MM16 (setup) the table is locked, and the group release asks the lock question", lk && asked);
      // the newer drag: the box alone, pressed where it is drawn now (the old drag left it moved), held still mid-travel
      await page(`(await import('/lib/edit/selection.js')).set(['mm-box']); return true;`);
      const at11 = (await evalJson(`__mmPress('mm-box', null)`)) ?? at10;
      await evalJson(`import('/lib/core.js').then((m) => (m.canvas.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, clientX: ${at11[0]}, clientY: ${at11[1]} })), true))`);
      await evalJson(`(dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: ${at11[0] + 6}, clientY: ${at11[1]} })), true)`);
      const armed = await waitFor(`globalThis.__buildDrag?.()?.armed === true`);
      await evalJson(`(dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: ${at11[0] + 40}, clientY: ${at11[1] + 10} })), true)`); await frames(3);
      const rv0 = await evalJson(`__reverts.length`), d0 = bobDrags.length;
      await evalJson(`(document.querySelector('#confirm-center [data-v="cancel"]').click(), true)`);
      await frames(3); await sleep(500 * WAIT_SCALE);
      const reverts = await evalJson(`__reverts.slice(${rv0})`);
      const backs = bobDrags.slice(d0).filter((m) => m.id === NODE.get("mm-box") && near(m.pos, B0));
      check("MM16 the cancelled lock question puts the table back, but not the box the newer drag holds (no put-back of it here, nor to bob)",
        armed && reverts.includes(NODE.get("mm-tbl")) && !reverts.includes(NODE.get("mm-box")) && backs.length === 0, { armed, reverts, backs: backs.length });
      await evalJson(`(dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: ${at11[0] + 40}, clientY: ${at11[1] + 10} })), true)`);
      await waitDisk(() => myActs().length === n0 + 1, 4000); await waitDisk(() => !near(pose("mm-box"), B0), 3000);
      check("MM16 …and the newer drag's release writes the box alone (one act), the table left where the log has it", myActs().length === n0 + 1 && !near(pose("mm-box"), B0) && near(pose("mm-tbl"), T0), { acts: actsSince(n0), B0, B: pose("mm-box"), T0, T: pose("mm-tbl") });
      if (myActs().length === n0 + 1) { await undo(); await waitDisk(() => near(pose("mm-box"), B0)); }
      await page(`const m = await import('/lib/net.js'); return (await m.sendRequest('delete', { id: 'mm-tbl', component: 'lock' })).ok;`);
      await onRecord("mm-box"); await onRecord("mm-tbl"); await frames(3); await settle();
    }

    // an undo, a deselect or a selection change mid-drag ends the drag as Esc does (everything it holds goes back where the log
    // has it, the samples end, nothing is written), then the action goes ahead: the drag never outlives its captured lead
    const lastEnds = (names: string[], d0: number) => Object.fromEntries(names.map((n) => [n, bobDrags.slice(d0).filter((m) => m.id === NODE.get(n)).at(-1)?.end === true]));
    const localOf = (names: string[]) => evalJson(`import('/lib/world.js').then((m) => ${JSON.stringify(names)}.map((n) => m.entities.get(n).position.toArray()))`);
    const midCancel = async (label: string, what: () => Promise<any>, extra: (r: any) => boolean = () => true) => {
      const atC = await evalJson(`__mmPress('mm-box', 'mm-tbl')`);
      if (!atC) { check(`${label} (setup) a press point on the box over the table`, false); return; }
      await page(`(await import('/lib/edit/build.js')).setTool('move'); (await import('/lib/edit/selection.js')).set(['mm-box', 'mm-tbl']); return true;`);
      const B0 = pose("mm-box"), T0 = pose("mm-tbl"), H0 = pose("mm-chair"), n0 = myActs().length, d0 = bobDrags.length;
      let during: any = null;
      await gesture(atC, [atC[0] + 30, atC[1] + 10], async () => { await what(); await frames(3); during = await evalJson(`globalThis.__buildDrag?.() ?? null`); });
      await frames(3); await sleep(600 * WAIT_SCALE);
      const local = await localOf(["mm-box", "mm-tbl", "mm-chair"]), ends = lastEnds(["mm-box", "mm-tbl"], d0);
      const r = { during, local, B0, T0, H0, disk: [pose("mm-box"), pose("mm-tbl"), pose("mm-chair")], ends, acts: actsSince(n0) };
      check(label, during === null && near(local?.[0], B0) && near(local?.[1], T0) && near(local?.[2], H0) && near(pose("mm-box"), B0) && near(pose("mm-tbl"), T0) && near(pose("mm-chair"), H0)
        && myActs().slice(n0).every((x) => x.e.verb === "undo") && ends["mm-box"] && ends["mm-tbl"] && extra(r), r);
      await onRecord("mm-box"); await onRecord("mm-tbl"); await frames(3); await settle();
    };
    // Ctrl+Z: a known act of mine (a label on the chair) for it to take once the drag is cancelled
    const la = await page(`const W = await import('/lib/edit/writes.js'); const OP = await import('/shared/requests.js'); return (await W.sendOps([OP.set('mm-chair', 'label', 'undo me')], { what: 'label the chair' })).ok;`);
    await waitFor(`globalThis.__editWrites().undo.at(-1) === ${myActs().at(-1)?.seq}`);
    check("MM17 (setup) a label on the chair, my last act", la && disk().entities[NODE.get("mm-chair")]?.c.label === "undo me");
    await midCancel("MM17 Ctrl+Z mid-drag cancels the drag (the box and the table back where the log has them, every sample ended, nothing written for it), then undoes my last act",
      () => key("KeyZ", { ctrlKey: true }), () => true);
    check("MM17 …the undo it carried on with took the chair's label away", await waitDisk(() => !disk().entities[NODE.get("mm-chair")]?.c.label, 4000), disk().entities[NODE.get("mm-chair")]?.c.label);
    await midCancel("MM18 a deselect mid-drag (Edit ▸ deselect) cancels it: everything back, every sample ended, nothing written",
      () => page(`(await import('/lib/edit/build.js')).deselectAll(); return true;`));
    await midCancel("MM19 a selection change mid-drag (the chair selected in the Hierarchy) cancels it: everything back, the chair never dragged, nothing written",
      () => page(`(await import('/lib/edit/selection.js')).set(['mm-chair']); return true;`));

    // a switch to the pivot tool mid-way through a gizmo drag doesn't take it over: the drag stays the move it began as (as a
    // mesh drag's does, MM7), so the box and the table land moved as one act, and no pivot is written from a proxy it never rode
    await frame("mm-tbl", 1.5);
    await page(`(await import('/lib/edit/build.js')).setTool('move'); (await import('/lib/edit/selection.js')).set(['mm-box', 'mm-tbl']); return true;`);
    check("MM (setup) the gizmo is on the box", await waitFor(`globalThis.__gizmo?.().attached === 'mm-box'`), await evalJson(`globalThis.__gizmo?.().attached ?? null`));
    { const B0 = pose("mm-box"), T0 = pose("mm-tbl"), n0 = myActs().length;
      await evalJson(`(() => { const c = globalThis.__gizmo().controls; c.dispatchEvent({ type: 'dragging-changed', value: true });
        return import('/lib/world.js').then((m) => { m.entities.get('mm-box').position.x += 1; c.dispatchEvent({ type: 'objectChange' }); return true; }); })()`);
      await page(`(await import('/lib/edit/build.js')).setTool('pivot'); globalThis.__gizmo().controls.dispatchEvent({ type: 'dragging-changed', value: false }); return true;`);
      await waitDisk(() => myActs().length > n0, 4000); await waitDisk(() => !near(pose("mm-tbl"), T0), 3000);
      const acts = myActs().slice(n0).map((x) => x.e), reqs = acts[0]?.verb === "batch" ? acts[0].body.args.requests : [];
      const moved = (a: any, b: any) => !!a && !!b && Math.abs(b[0] - a[0] - 1) < 0.01 && Math.abs(b[1] - a[1]) < 0.01 && Math.abs(b[2] - a[2]) < 0.01;
      check("MM8 a gizmo drag the pivot tool is switched to mid-way stays a move: ONE act moving the box and the table by its 1 m, no pivot written",
        acts.length === 1 && reqs.length === 2 && reqs.every((r: any) => r.args?.component === "transform") && moved(B0, pose("mm-box")) && moved(T0, pose("mm-tbl")) && !disk().entities[NODE.get("mm-box")]?.c.pivot,
        { acts: actsSince(n0), B0, B: pose("mm-box"), T0, T: pose("mm-tbl"), pivot: disk().entities[NODE.get("mm-box")]?.c.pivot ?? null });
      await page(`(await import('/lib/edit/build.js')).setTool('move'); return true;`);
      if (acts.length === 1) { await undo(); await waitDisk(() => near(pose("mm-box"), B0) && near(pose("mm-tbl"), T0)); }
    }
    await page(`(await import('/lib/edit/build.js')).setTool('move'); return true;`);
  }
  check("errors: no page error", await evalJson(`__errs.length === 0`), await evalJson(`__errs`));
  bob.close();
} catch (e) { check("the run threw", false, String(e?.stack ?? e)); }
console.log(`[build-probe] ${tally.passed} passed, ${tally.failed} failed`);
await cleanup(tally.failed ? 1 : 0);
process.exit(tally.failed ? 1 : 0);
