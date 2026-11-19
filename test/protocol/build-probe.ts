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
//   MM  a mesh drag of one of several selected things moves them all as ONE act (one Ctrl+Z); a box resting on a selected
//       table keeps its height (the drag aims past the things moving with it); a rider drawn off its carrier stays out of
//       the batch; the pivot tool's drag moves only the one thing
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
import { pageWaiter } from "../gate/wait.ts";
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
const waitDisk = async (pred: () => boolean, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { if (pred()) return true; } catch { /* mid-write */ } await sleep(100); } return false; };
const key = (code: string, mods: any = {}) => { const m = Object.entries(mods).map(([k, v]) => `${k}: ${v}`).join(", ");
  return evalJson(`dispatchEvent(new KeyboardEvent('keydown', { code: '${code}', key: '${code}', bubbles: true, ${m} })), dispatchEvent(new KeyboardEvent('keyup', { code: '${code}', key: '${code}', bubbles: true, ${m} })), true`); };
const page = (js: string) => evalJson(`(async () => { ${js} })()`);
const SX = 760, SY = 470;   // the viewport point every gesture aims at (client-check's place point: the ground in view)

try {
  const bob = new WebSocket(BASE.replace("http", "ws") + "/ws"); const replies = new Map(); let rn = 0; let BOB = "";
  bob.onmessage = (ev) => { const m = JSON.parse(String(ev.data)); if (m.type === "reply") replies.get(m.id)?.(m.reply); if (m.type === "snapshot" && m.actor) BOB = m.actor; };
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
  { NAMES.push("mm-tbl", "mm-box", "mm-cart", "mm-kid");
    const roots = Object.keys(disk().entities).filter((k) => k !== "@world" && !disk().entities[k].c.parent);
    check("MM (setup) the owner clears the field", await page(`const m = await import('/lib/net.js'); return (await m.sendRequest('batch', { requests: ${JSON.stringify(roots)}.map((id) => ({ verb: 'delete', args: { id } })), throughLock: true })).ok;`), roots);
    const camNow = () => evalJson(`import('/lib/core.js').then((c) => { c.camera.updateMatrixWorld(); return c.camera.matrixWorld.elements.map((v) => +v.toFixed(4)).join(); })`);
    const settle = async () => { let last = await camNow(), same = 0; for (let i = 0; i < 60 && same < 5; i++) { await sleep(200); const now = await camNow(); same = now === last ? same + 1 : 0; last = now; } return same >= 5; };
    const frames = (n: number) => evalJson(`new Promise((r) => { let k = ${n}; const f = () => (--k ? requestAnimationFrame(f) : r(true)); requestAnimationFrame(f); })`);
    await settle();
    // a spot ahead where the table's foot and a box on it are in view
    const G = await evalJson(`import('/lib/core.js').then((c) => { const T = c.THREE, cam = c.camera, f = cam.getWorldDirection(new T.Vector3()); f.y = 0; f.normalize(); const o = cam.getWorldPosition(new T.Vector3());
      for (let d = 4; d <= 24; d += 0.5) { const g = o.clone().addScaledVector(f, d); g.y = 0; if ([g.clone().project(cam), g.clone().setY(2).project(cam)].every((s) => Math.abs(s.x) < 0.6 && Math.abs(s.y) < 0.6 && s.z < 1)) return [g.x, g.z, f.x, f.z]; }
      return null; })`);
    const mkT = (id: string, p: number[], sc: number[], extra: any = {}) => page(`const m = await import('/lib/net.js'); return (await m.sendRequest('create', { id: '${id}', model: '${CRATE}', components: { transform: { pos: ${JSON.stringify(p)}, q: [0, 0, 0, 1], scale: ${JSON.stringify(sc)} }, ...${JSON.stringify(extra)} } })).ok;`);
    const okT = Array.isArray(G) && await mkT("mm-tbl", [G[0], 0, G[1]], [1, 0.5, 1]);
    for (const n of ["mm-tbl"]) NODE.set(n, await evalJson(`'${n}'`));
    const drawn = (id: string) => waitFor(`import('/lib/world.js').then((m) => { const o = m.entities.get('${id}'); return !!o && o.children.length > 0; })`, 12000);
    await drawn("mm-tbl"); await sleep(400);
    const topY = await evalJson(`Promise.all([import('/lib/core.js'), import('/lib/world.js')]).then(([c, w]) => { const b = new c.THREE.Box3().setFromObject(w.entities.get('mm-tbl')); return b.isEmpty() ? null : b.max.y; })`);
    // the box rests ON the table (not parented); a cart off to the side carries a kid
    const side = Array.isArray(G) ? [G[0] - G[3] * 3, G[1] + G[2] * 3] : [0, 0];
    const okB = !!topY && await mkT("mm-box", [G[0], topY, G[1]], [0.4, 0.4, 0.4]);
    const okC = await mkT("mm-cart", [side[0], 0, side[1]], [0.5, 0.5, 0.5]);
    for (const n of ["mm-box", "mm-cart"]) NODE.set(n, await evalJson(`'${n}'`));
    const okK = await mkT("mm-kid", [side[0], 0, side[1]], [1, 1, 1], { parent: { to: "mm-cart", order: "a0" } });
    NODE.set("mm-kid", await evalJson(`'mm-kid'`));
    check("MM (setup) a table, a box resting on it, and a cart with a kid off to the side", okT && okB && okC && okK && await drawn("mm-box") && await drawn("mm-kid"), { G, topY });
    // frame the pair (F's own framing), looking down on them, so the gesture's pixels are on them whatever the earlier
    // sections did to the view
    await page(`const { THREE } = await import('/lib/core.js'); const C = await import('/lib/player/controller.js'); C.setCamPitch(1); return C.frameOn(new THREE.Vector3(${G?.[0]}, ${topY ?? 1}, ${G?.[1]}), 1.5);`);
    await sleep(600); await settle();
    // a press pixel ON the box whose ray, past it, meets the table's top (where an aim that doesn't skip the table lands);
    // a move pixel whose ray, past the box and the table, meets the ground
    await evalJson(`Promise.all([import('/lib/core.js'), import('/lib/world.js')]).then(([c, w]) => { const T = c.THREE;
      const inside = (o, r) => { for (let q = o; q; q = q.parent) if (q === r) return true; return false; };
      globalThis.__mmHit = (x, y) => { const rc = new T.Raycaster(); rc.setFromCamera(new T.Vector2(x / innerWidth * 2 - 1, -(y / innerHeight) * 2 + 1), c.camera);
        const hs = rc.intersectObjects([...w.entities.values()].filter(Boolean), true); const box = w.entities.get('mm-box'), tbl = w.entities.get('mm-tbl');
        const idOf = (o) => { for (let q = o; q; q = q.parent) if (q.userData?.entityId) return q.userData.entityId; return null; };
        const past = hs.find((h) => !inside(h.object, box)), up = !!past?.face && past.face.normal.clone().transformDirection(past.object.matrixWorld).y > 0.6;
        return { onBox: !!hs[0] && inside(hs[0].object, box), onTop: !!past && inside(past.object, tbl) && up, clear: !hs.some((h) => !inside(h.object, box) && !inside(h.object, tbl)), hits: hs.slice(0, 4).map((h) => idOf(h.object)) }; };
      globalThis.__mmPress = () => { const box = w.entities.get('mm-box'), b = new T.Box3().setFromObject(box), xs = [], ys = [];
        for (const cx of [b.min.x, b.max.x]) for (const cy of [b.min.y, b.max.y]) for (const cz of [b.min.z, b.max.z]) { const s = new T.Vector3(cx, cy, cz).project(c.camera); xs.push((s.x + 1) / 2 * innerWidth); ys.push((1 - s.y) / 2 * innerHeight); }
        const mx = Math.round((Math.min(...xs) + Math.max(...xs)) / 2), my = Math.round((Math.min(...ys) + Math.max(...ys)) / 2);
        for (let r = 0; r < 30; r += 2) for (const [dx, dy] of [[0, 0], [r, 0], [-r, 0], [0, r], [0, -r]]) { const h = __mmHit(mx + dx, my + dy); if (h.onBox && h.onTop && h.clear) return [mx + dx, my + dy]; }
        return null; };
      return true; })`);
    const pose = (n: string) => disk().entities[NODE.get(n)]?.c.transform?.pos;
    const gesture = async (at: number[], to: number[]) => {
      await evalJson(`import('/lib/core.js').then((m) => (m.canvas.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, clientX: ${at[0]}, clientY: ${at[1]} })), true))`);
      await evalJson(`(dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: ${at[0] + 6}, clientY: ${at[1]} })), true)`);
      await waitFor(`globalThis.__buildDrag?.()?.armed === true`); await frames(3);
      await evalJson(`(dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: ${to[0]}, clientY: ${to[1]} })), true)`); await frames(3);
      await evalJson(`(dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: ${to[0]}, clientY: ${to[1]} })), true)`); };
    const at = await evalJson(`__mmPress()`);
    const to = at ? [at[0] + 24, at[1]] : null;
    check("MM (setup) a press point on the box, the ground beyond it", !!at && !!(await evalJson(`__mmHit(${to?.[0]}, ${to?.[1]}).clear`)),
      { at, to, G, topY, box: await evalJson(`Promise.all([import('/lib/core.js'), import('/lib/world.js')]).then(([c, w]) => { const T = c.THREE, b = new T.Box3().setFromObject(w.entities.get('mm-box')); const m = b.getCenter(new T.Vector3()).project(c.camera); const x = (m.x + 1) / 2 * innerWidth, y = (1 - m.y) / 2 * innerHeight; return { x, y, hit: __mmHit(x, y), size: b.getSize(new T.Vector3()).toArray(), ids: { tbl: 'mm-tbl', box: 'mm-box', cart: 'mm-cart', kid: 'mm-kid' }, cam: c.camera.getWorldPosition(new T.Vector3()).toArray() }; })`).catch((e) => String(e)) });
    if (at && to) {
      // the cart's kid is drawn off its carrier (as a part socket's occupant is, under the part's node): it can't take a move
      await page(`const { scene } = await import('/lib/core.js'); const w = await import('/lib/world.js'); scene.attach(w.entities.get('mm-kid')); return true;`);
      await page(`(await import('/lib/edit/build.js')).setTool('move'); (await import('/lib/edit/selection.js')).set(['mm-tbl', 'mm-box', 'mm-kid']); return true;`);
      const T0 = pose("mm-tbl"), B0 = pose("mm-box"), K0 = pose("mm-kid"); let n0 = myActs().length;
      await gesture(at, to);
      const one = await waitDisk(() => myActs().length === n0 + 1);
      const act = myActs().at(-1)?.e; const reqs = act?.verb === "batch" ? act.body.args.requests : [];
      const ids = reqs.map((r: any) => r.args?.id);
      check("MM1 a mesh drag of one of several selected things is ONE act: a batch setting the box's and the table's transforms",
        one && act?.verb === "batch" && reqs.length === 2 && ids.includes(NODE.get("mm-box")) && ids.includes(NODE.get("mm-tbl")) && reqs.every((r: any) => r.verb === "set" && r.args.component === "transform"),
        { acts: myActs().slice(n0).map((x) => [x.e.verb, x.e.body?.args?.id ?? x.e.body?.args?.requests?.map((r: any) => r.args?.id)]), refused: await evalJson(`__refused.map((r) => r.text)`) });
      await waitDisk(() => JSON.stringify(pose("mm-tbl")) !== JSON.stringify(T0));
      const T1 = pose("mm-tbl"), B1 = pose("mm-box");
      check("MM2 …the box resting on the selected table keeps its height, and the table moved with it level (not into the ground)",
        !!T1 && !!B1 && Math.abs(T1[1] - T0[1]) < 0.01 && Math.abs(B1[1] - B0[1]) < 0.05 && Math.hypot(T1[0] - T0[0], T1[2] - T0[2]) > 0.05
          && Math.hypot(T1[0] - T0[0] - (B1[0] - B0[0]), T1[2] - T0[2] - (B1[2] - B0[2])) < 0.01, { T0, T1, B0, B1 });
      check("MM3 …the kid drawn off its carrier stayed out (not in the batch, not moved)", !ids.includes(NODE.get("mm-kid")) && JSON.stringify(pose("mm-kid")) === JSON.stringify(K0), { ids, K0, K1: pose("mm-kid") });
      await waitFor(`globalThis.__editWrites().undo.at(-1) === ${myActs().at(-1)?.seq}`);
      await key("KeyZ", { ctrlKey: true });
      check("MM4 one Ctrl+Z puts the box and the table back", await waitDisk(() => JSON.stringify(pose("mm-tbl")) === JSON.stringify(T0) && JSON.stringify(pose("mm-box")) === JSON.stringify(B0)), { T: pose("mm-tbl"), B: pose("mm-box") });
      // the pivot tool moves one thing's pivot, never a group's: its mesh drag moves the pressed thing alone
      await waitFor(`import('/lib/net.js').then((m) => JSON.stringify(m.replica.st.entities['mm-tbl']?.c?.transform?.pos ?? m.replica.st.entities['mm-tbl']?.pos) === ${JSON.stringify(JSON.stringify(T0))})`); await frames(3); await settle();
      const at2 = (await evalJson(`__mmPress()`)) ?? at;
      await page(`(await import('/lib/edit/build.js')).setTool('pivot'); (await import('/lib/edit/selection.js')).set(['mm-tbl', 'mm-box']); return true;`);
      n0 = myActs().length;
      await gesture(at2, [at2[0] + 24, at2[1]]);
      await waitDisk(() => myActs().length === n0 + 1, 4000);
      const pa = myActs().slice(n0).map((x) => x.e);
      check("MM5 the pivot tool's mesh drag moves the pressed box alone: one set on it, the table where it is",
        JSON.stringify(pose("mm-tbl")) === JSON.stringify(T0) && pa.length === 1 && pa[0].verb === "set" && pa[0].body?.args?.id === NODE.get("mm-box"),
        { acts: pa.map((e: any) => [e.verb, e.body?.args?.id ?? e.body?.args?.requests?.map((r: any) => r.args?.id)]), T: pose("mm-tbl") });
      await page(`(await import('/lib/edit/build.js')).setTool('move'); return true;`);
    }
  }
  check("errors: no page error", await evalJson(`__errs.length === 0`), await evalJson(`__errs`));
  bob.close();
} catch (e) { check("the run threw", false, String(e?.stack ?? e)); }
console.log(`[build-probe] ${tally.passed} passed, ${tally.failed} failed`);
await cleanup(tally.failed ? 1 : 0);
process.exit(tally.failed ? 1 : 0);
