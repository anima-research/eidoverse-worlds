// tools/protocol/agentshove-check.ts — body shove for an agent's body: a real mcpl/agent.ts WorldAgent walking (the move
// tool, walk_to's new name) against a real sequencer running eidosim. Its walk pushes loose things it walks into through the
// same punt {contact: true} a person's client sends (shared/shove.js decides, the authority admits). Scratch port, scratch
// WORLDS_DIR/OPT_DIR, never 8968/8970.   usage: BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun tools/protocol/agentshove-check.ts
//   AS1  a low crate (the authority's body steps over it) in the path: shoved along the walk, the walk arrives
//   AS2  a tall crate (solid to the authority): the walk goes up against it instead of stopping short, shoves it, and asks
//        again; bounded tries, then it stops as any refused walk does
//   AS3  walking along a crate's face and standing still beside it: no punt
//   AS4  a locked crate in the path: no punt (walked through: it is low)
//   AS5  a STATIC tall crate (the same size as AS2's) in the path: the planner routes round it — no punt, it stays put,
//        the walk arrives, and the body left the straight line to get there (the navgrid's value for what isn't shoveable)
//   AS6  a HEAVY dynamic tall crate (2000 kg: a walking body's shove slides it less than the shover's own "it moved") in
//        the path: routed round as AS5's is — no shove, the walk arrives off the straight line (review r4 F1a)
//   AS7  a light crate, passable when the walk is planned, locked while the body walks to it: the authority calls it
//        solid, and the walk re-plans once with it as an obstacle and arrives round it (review r4 F1b)
//   AS8  AS7's re-planned walk superseded by a new move, which is then stopped: neither walk reports the first walk's
//        crate (the re-plan's answer is written only while it is still the walk under way; review r5 F1)
//   AS9  AS7's crate, unlocked where it stands: walked into again (a misjudged mark holds only while its lock, physics and
//        mass do; review r5 F5)
//   AS10 a light long crate backed against two locked posts: the walk presses it, it doesn't budge, the walk stalls, re-plans
//        round it and arrives (the stall branch's row; review r5 F5)
//   AS11 a stall blames only a thing the stride presses into, not one it grazes (pure; review r5 F5)
//   AS12 a cup on a table: move {to: "cup"} is accepted and ends beside the table on the floor (review r6 L1)
//   AS13 a child thing with no physics shape: walked to at its world position; labels' nearest by world position (r6 L2)
//   AS14 a misjudged crate rescaled in place is judged afresh (pure; review r6 L3)
// @ts-nocheck
import fs from "node:fs";
import path from "node:path";
import { ENGINE, scratch } from "./common.ts";
import { readLog } from "../../shared/protocol/fold.js";

const root = scratch("agentshove");
let pass = 0, fail = 0;
const ok = (cond, what, detail?) => { if (cond) { pass++; console.log(`  ok   ${what}`); } else { fail++; console.log(`  FAIL ${what}${detail !== undefined ? ` — ${JSON.stringify(detail).slice(0, 700)}` : ""}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const T = (r) => r?.content?.[0]?.text ?? "";

async function writeBoxGlb(file, [sx, sy, sz]) {
  const { Document, NodeIO } = await import("@gltf-transform/core");
  const doc = new Document(); const buf = doc.createBuffer();
  const x = sx / 2, z = sz / 2;
  const P = [[-x, 0, -z], [x, 0, -z], [x, sy, -z], [-x, sy, -z], [-x, 0, z], [x, 0, z], [x, sy, z], [-x, sy, z]];
  const F = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [3, 7, 6], [3, 6, 2], [0, 4, 7], [0, 7, 3], [1, 2, 6], [1, 6, 5]];
  const pos = doc.createAccessor().setType("VEC3").setArray(new Float32Array(P.flat())).setBuffer(buf);
  const idx = doc.createAccessor().setType("SCALAR").setArray(new Uint16Array(F.flat())).setBuffer(buf);
  doc.createScene().addChild(doc.createNode("box").setMesh(doc.createMesh().addPrimitive(doc.createPrimitive().setAttribute("POSITION", pos).setIndices(idx))));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  await new NodeIO().write(file, doc);
}

const W = path.join(root, "w"), OPT = path.join(root, "opt"); fs.mkdirSync(W, { recursive: true });
await writeBoxGlb(path.join(OPT, "test/lowcrate.glb"), [0.6, 0.5, 0.6]);
await writeBoxGlb(path.join(OPT, "test/tallcrate.glb"), [0.6, 1.2, 0.6]);
await writeBoxGlb(path.join(OPT, "test/longcrate.glb"), [3, 1.2, 0.6]);
await writeBoxGlb(path.join(OPT, "test/post.glb"), [0.3, 1.2, 0.3]);
const env = (extra = {}) => ({ ...process.env, WORLDS_DIR: W, OPT_DIR: OPT, SKIP_OPT_SWEEP: "1", HOST: "127.0.0.1",
  BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0", JOIN_TOKEN: "", WORLD_ADMIN: "", TRUST_NAMES: "1", EIDO_FLIGHT_REHEARSAL: "", SESSIONS_PATH: path.join(root, "sessions.json"), ...extra });
const r0 = Bun.spawnSync(["bun", "tools/protocol/world.ts", "found", "yard", "--owner", "Ann"], { cwd: ENGINE, env: env() });
ok(r0.exitCode === 0, "(setup) found yard, Ann owns it", r0.stderr.toString().slice(-300));
import { idAliases } from "./idalias.ts";
const IDS = idAliases();
let port = 9640; for (; port < 9740; port++) { try { const s = Bun.listen({ hostname: "127.0.0.1", port, socket: { data() {} } }); s.stop(true); break; } catch {} }
const logf = path.join(root, "srv.log");
const proc = Bun.spawn(["bun", "server/server.ts"], { cwd: ENGINE, env: env({ PORT: String(port) }), stdout: Bun.file(logf), stderr: Bun.file(logf + ".err") });
let ag = null, ann = null;
const done = (code) => { try { ag?.close(); } catch {} try { ann?.close(); } catch {} try { proc.kill(); } catch {} console.log(`agentshove: ${pass} pass, ${fail} fail`); process.exit(code); };
process.on("exit", () => { try { proc.kill(); } catch {} });
try {
  let up = false; for (let i = 0; i < 80 && !up; i++) { await sleep(150); try { up = (await fetch(`http://127.0.0.1:${port}/version`, { signal: AbortSignal.timeout(800) })).ok; } catch {} }
  ok(up, "(setup) the server is up"); if (!up) done(1);

  async function sock(name) {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`); const msgs = [];
    ws.onmessage = (ev) => msgs.push(JSON.parse(String(ev.data)));
    await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
    ws.send(JSON.stringify({ type: "join", world: "yard", id: name, avatar: "", replica: true }));
    for (let i = 0; i < 80 && !msgs.some((m) => m.type === "snapshot" || m.type === "error"); i++) await sleep(50);
    let rn = 0;
    return { ws, msgs, close: () => ws.close(),
      // R 10-17: the suite's names ride as placeholders and minted ids (tools/protocol/idalias.ts)
      req: async (verb, args = {}) => { const id = `q${++rn}`; ws.send(JSON.stringify({ type: "request", id, verb, args: IDS.out(verb, args) }));
        for (let i = 0; i < 80; i++) { const r = msgs.find((m) => m.type === "reply" && m.id === id); if (r) return IDS.back(r.reply); await sleep(50); } return { ok: false, timeout: true }; } };
  }
  ann = await sock("Ann");
  const { WorldAgent } = await import("../../mcpl/agent.ts");
  const { HANDLERS } = await import("../../mcpl/tools.ts");
  ag = new WorldAgent({ url: `ws://127.0.0.1:${port}/ws`, name: "Hep", world: "yard", avatar: "" });
  await ag.connect(); for (let i = 0; i < 60 && !ag.cut; i++) await sleep(50);
  const HEP = ag.cut?.you;
  ok(/^u-/.test(HEP ?? "") && ag.replica?.active, "(setup) the agent joins and folds the world");
  ok((await ann.req("set", { id: "@world", component: "physics-engine", value: { engine: "eidosim@1.0.0" } })).ok, "(setup) the yard runs eidosim");
  // empty crates (20 and 30 kg): a body's push (BODY_MASS 70 kg, elastic) sends them well along; a full one wouldn't budge much
  // R 10-17: a writer never chooses an id: each thing is made with a placeholder and labelled with its scene name; the
  // authority mints its id (ID[name]); N(name) reads the scene name as that id
  const N = (n) => IDS.of(n);
  const mk = (name, args) => ann.req("create", { ...args, id: `$${name}`, components: { label: name, ...(args.components ?? {}) } });
  const crate = (id, model, pos, extra = {}, mass = 20) => mk(id, { model, components: { transform: { pos, q: [0, 0, 0, 1], scale: [1, 1, 1] }, physics: { kind: "dynamic", who: "visitor", mass }, ...extra } });
  for (const [id, model, pos, extra, mass] of [["low", "test/lowcrate.glb", [0, 0, 2]], ["tall", "test/tallcrate.glb", [6, 0, 2], {}, 30], ["still", "test/lowcrate.glb", [12, 0, 2]], ["locked", "test/lowcrate.glb", [18, 0, 2], { lock: true }]] as any) {
    const r = await crate(id, model, pos, extra, mass); ok(r.ok, `(setup) ${id} crate`, r); }
  for (let i = 0; i < 80 && !["low", "tall", "still", "locked"].every((id) => ag.replica?.st?.entities?.[N(id)]?.c?.physics?.shape); i++) await sleep(50);
  ok(["low", "tall", "still", "locked"].every((id) => Array.isArray(ag.replica?.st?.entities?.[N(id)]?.c?.physics?.shape)), "(setup) the authority measured each crate's shape (the agent folds it)");
  const call = (name, a = {}) => HANDLERS[name](ag, a, { agent: ag, canPush: () => false, heldActivity: [], cursor: { caughtUpTo: null } }, name);
  const entries = () => readLog(fs.readFileSync(path.join(W, "yard", "world.jsonl")));
  const shoves = (id) => entries().filter((e) => e.kind === "act" && e.verb === "punt" && e.actor === HEP && !e.body?.refused && e.body?.request?.id === N(id) && e.body?.request?.contact === true);
  const anyPunt = (id) => entries().filter((e) => e.kind === "act" && e.verb === "punt" && e.actor === HEP && JSON.stringify(e.body ?? {}).includes(`"${N(id)}"`));
  const posOf = (id) => ag.replica?.st?.entities?.[N(id)]?.c?.transform?.pos ?? null;
  const settle = async (id) => { for (let i = 0; i < 100; i++) { await sleep(100); if (!ag.replica?.sim?.sim?.bodies?.[N(id)]) { await ann.req("wait", {}); return; } } };

  // AS1
  { const m0 = await call("move", { to: [0, 0] }); ok(!m0.isError, "(AS1 setup) the agent stands at the origin", T(m0));
    const w = await call("move", { to: [0, 4.5] }); await settle("low"); await sleep(400);
    const s = shoves("low"), p = posOf("low");
    ok(s.length >= 1, "AS1 a low crate in the walk's path is shoved: a punt {contact: true} by the agent", { n: s.length, sample: s[0] ?? null, any: anyPunt("low").map((e) => e.body) });
    ok(Array.isArray(p) && p[2] > 2.2, "AS1 …and it moved along the walk (+z)", p);
    ok(!w.isError, "AS1 …and the walk arrived (the authority's body steps over a low crate)", T(w)); }
  // AS2
  { const m0 = await call("move", { to: [6, 0] }); ok(!m0.isError, "(AS2 setup) the agent stands south of the tall crate", T(m0));
    const p0 = posOf("tall");
    const w = await call("move", { to: [6, 5] }); await settle("tall"); await sleep(400);
    const s = shoves("tall"), p = posOf("tall");
    ok(s.length >= 1 && s.length <= 5, "AS2 a tall crate (solid to the authority) is walked up to and shoved, a bounded number of times", { n: s.length, text: T(w) });
    ok(Array.isArray(p) && Array.isArray(p0) && p[2] > p0[2] + 0.1, "AS2 …and it moved along the walk", { p0, p });
    ok(ag.pos.z > 1.0, "AS2 …and the body got up against it (not stopped a whole stretch short)", ag.pos); }
  // AS3
  { const m0 = await call("move", { to: [10.5, 1.36] }); ok(!m0.isError, "(AS3 setup) the agent stands west of the third crate's face line", T(m0));
    const n0 = anyPunt("still").length;
    const w = await call("move", { to: [12, 1.36] }); await sleep(2500);
    ok(!w.isError && anyPunt("still").length === n0, "AS3 walking along its face, then standing beside it 2.5 s: no punt", { punts: anyPunt("still").map((e) => e.body), text: T(w) }); }
  // AS4
  { const m0 = await call("move", { to: [18, 0] }); ok(!m0.isError, "(AS4 setup) the agent stands south of the locked crate", T(m0));
    const w = await call("move", { to: [18, 4] }); await sleep(800);
    ok(anyPunt("locked").length === 0, "AS4 a locked crate in the path: no punt (not even a refused one)", anyPunt("locked").map((e) => e.body)); }
  // AS5
  { const r = await mk("fixed", { model: "test/tallcrate.glb", components: { transform: { pos: [-6, 0, 2], q: [0, 0, 0, 1], scale: [1, 1, 1] }, physics: { kind: "static" } } });
    ok(r.ok, "(AS5 setup) a static tall crate", r);
    for (let i = 0; i < 80 && !Array.isArray(ag.replica?.st?.entities?.[N("fixed")]?.c?.physics?.shape); i++) await sleep(50);
    await sleep(1500);   // its collider is fitted (the mesh is fetched) before the walk plans
    const m0 = await call("move", { to: [-6, 0] }); ok(!m0.isError, "(AS5 setup) the agent stands south of the static crate", T(m0));
    const p0 = posOf("fixed"); let off = 0, walking = true;
    const w = call("move", { to: [-6, 5] }).finally(() => { walking = false; });
    while (walking) { off = Math.max(off, Math.abs(ag.pos.x + 6)); await sleep(30); }
    const t = T(await w), p = posOf("fixed");
    ok(anyPunt("fixed").length === 0, "AS5 a static crate of the same size in the path: no punt", anyPunt("fixed").map((e) => e.body));
    ok(JSON.stringify(p) === JSON.stringify(p0), "AS5 …it stays put", { p0, p });
    ok(/^arrived/.test(t), "AS5 …the walk arrives", t);
    ok(off > 0.3, "AS5 …routed round it: the body left the straight line", { off }); }
  // AS6
  { const r = await crate("heavy", "test/tallcrate.glb", [-12, 0, 2], {}, 2000); ok(r.ok, "(AS6 setup) a 2000 kg dynamic tall crate", r);
    for (let i = 0; i < 80 && !Array.isArray(ag.replica?.st?.entities?.[N("heavy")]?.c?.physics?.shape); i++) await sleep(50);
    await sleep(1500);
    const m0 = await call("move", { to: [-12, 0] }); ok(!m0.isError, "(AS6 setup) the agent stands south of the heavy crate", T(m0));
    let off = 0, walking = true;
    const w = call("move", { to: [-12, 5] }).finally(() => { walking = false; });
    while (walking) { off = Math.max(off, Math.abs(ag.pos.x + 12)); await sleep(30); }
    const t = T(await w);
    ok(/^arrived/.test(t), "AS6 a 2000 kg dynamic crate in the path: the walk arrives", t);
    ok(shoves("heavy").length === 0, "AS6 …with no shove", shoves("heavy").map((e) => e.body));
    ok(off > 0.3, "AS6 …routed round it: the body left the straight line", { off }); }
  // AS7
  { const r = await crate("late", "test/tallcrate.glb", [-18, 0, 2], {}, 30); ok(r.ok, "(AS7 setup) a light tall crate", r);
    for (let i = 0; i < 80 && !Array.isArray(ag.replica?.st?.entities?.[N("late")]?.c?.physics?.shape); i++) await sleep(50);
    await sleep(1500);
    const m0 = await call("move", { to: [-18, 0] }); ok(!m0.isError, "(AS7 setup) the agent stands south of it", T(m0));
    let off = 0, walking = true;
    const w = call("move", { to: [-18, 5] }).finally(() => { walking = false; });
    for (let i = 0; i < 100 && !ag.target; i++) await sleep(10);
    const planned = !!ag.target && Math.abs(ag.target.x + 18) < 1e-6;   // planned straight through it (it was passable)
    const lk = await ann.req("set", { id: "late", component: "lock", value: true });
    ok(planned && lk.ok, "(AS7 setup) the walk planned straight through it, then it was locked", { planned, target: ag.target, lk });
    while (walking) { off = Math.max(off, Math.abs(ag.pos.x + 18)); await sleep(30); }
    const t = T(await w);
    ok(/^arrived/.test(t), "AS7 a crate made un-shoveable mid-walk: the walk re-plans round it and arrives", t);
    ok(/late wouldn't move for your shove/.test(t), "AS7 …and says why it went round", t);
    ok(off > 0.3, "AS7 …the body left the straight line", { off }); }
  // AS8
  { const r = await crate("late2", "test/tallcrate.glb", [0, 0, -10], {}, 30); ok(r.ok, "(AS8 setup) a light tall crate", r);
    for (let i = 0; i < 80 && !Array.isArray(ag.replica?.st?.entities?.[N("late2")]?.c?.physics?.shape); i++) await sleep(50);
    await sleep(1500);
    const m0 = await call("move", { to: [0, -12] }); ok(!m0.isError, "(AS8 setup) the agent stands south of it", T(m0));
    const wA = call("move", { to: [0, -7] });
    for (let i = 0; i < 100 && !ag.target; i++) await sleep(10);
    const lk = await ann.req("set", { id: "late2", component: "lock", value: true });
    for (let i = 0; i < 400 && !/late2 wouldn't move/.test(ag.lastWalkNote ?? ""); i++) await sleep(10);
    ok(lk.ok && /late2 wouldn't move/.test(ag.lastWalkNote ?? ""), "(AS8 setup) locked mid-walk: the re-planned walk is under way", { lk, note: ag.lastWalkNote });
    const wB = call("move", { to: [6, -12] });
    await sleep(50);
    const state = { lastWalkRefusal: ag.lastWalkRefusal, walkStopReason: ag.walkStopReason };
    ok(!state.lastWalkRefusal && !state.walkStopReason, "AS8 a move superseding the re-planned walk carries none of its answer", state);
    const tA = T(await wA);
    await call("stop", {});
    const tB = T(await wB);
    ok(!/late2/.test(tB), "AS8 …and stopped, it does not report the first walk's crate", tB);
    ok(!/solid|late2 is in the way/.test(tA), "AS8 …nor does the superseded walk claim the authority refused it", tA); }
  // AS9
  { const m0 = await call("move", { to: [-18, 0] }); ok(!m0.isError, "(AS9 setup) the agent stands south of AS7's crate, still locked", T(m0));
    const ul = await ann.req("delete", { id: "late", component: "lock" });
    for (let i = 0; i < 80 && ag.replica?.st?.entities?.[N("late")]?.c?.lock; i++) await sleep(50);
    ok(ul.ok && !ag.replica?.st?.entities?.[N("late")]?.c?.lock, "(AS9 setup) unlocked where it stands", ul);
    const w = call("move", { to: [-18, 5] });
    for (let i = 0; i < 100 && !ag.target; i++) await sleep(10);
    const planned = !!ag.target && Math.abs(ag.target.x + 18) < 1e-6;
    ok(planned, "AS9 a crate once found solid, then unlocked where it stood, is walked into again (planned straight through it)", { target: ag.target });
    await call("stop", {}); await w; }
  // AS10
  { const r = await crate("jam", "test/longcrate.glb", [12, 0, -6], {}, 30); ok(r.ok, "(AS10 setup) a light long crate", r);
    for (const [id, x] of [["postw", 11], ["poste", 13]] as any) {
      const p = await ann.req("create", { id, model: "test/post.glb", components: { transform: { pos: [x, 0, -5.55], q: [0, 0, 0, 1], scale: [1, 1, 1] }, physics: { kind: "static" }, lock: true } });
      ok(p.ok, `(AS10 setup) a locked post behind it (${id})`, p); }
    for (let i = 0; i < 80 && !["jam", "postw", "poste"].every((id) => Array.isArray(ag.replica?.st?.entities?.[N(id)]?.c?.physics?.shape)); i++) await sleep(50);
    await sleep(1500);
    const m0 = await call("move", { to: [12, -9] }); ok(!m0.isError, "(AS10 setup) the agent stands south of it", T(m0));
    let off = 0, walking = true, stalled = null;
    const w = call("move", { to: [12, -3] }).finally(() => { walking = false; });
    for (let i = 0; i < 100 && !ag.target; i++) await sleep(10);
    const planned = !!ag.target && Math.abs(ag.target.x - 12) < 1e-6;
    while (walking) { off = Math.max(off, Math.abs(ag.pos.x - 12)); await sleep(30); }
    const t = T(await w);
    console.log("   AS10:", t, JSON.stringify(posOf("jam")), shoves("jam").length);
    ok(planned, "(AS10 setup) the walk planned straight through it (30 kg: its shove would move it)", { target: ag.target });
    ok(/^arrived/.test(t) && /jam wouldn't move for your shove/.test(t), "AS10 a light crate backed against locked posts: the walk presses it, it doesn't budge, the walk re-plans round it and arrives", t);
    ok(off > 1.2, "AS10 …round its end (the body left the straight line by more than half its length)", { off }); }
  // AS15 (review of #260): a rejoin resends the agent's consent table without a preset. A preset
  // empties the agent's cells, so a cell it closed would stand open until its set landed. The rejoin reads what the
  // authority holds and sets only what differs; the closed cell is closed throughout and after
  { const closed = await ag.request("consent", { switch: "refuse" });
    const sent: any[] = []; const orig = ag.request.bind(ag);
    ag.request = (verb: string, args: any) => { if (verb === "consent") sent.push(args); return orig(verb, args); };
    ag.ws?.close();
    for (let i = 0; i < 100 && ag.joined; i++) await sleep(50);
    for (let i = 0; i < 300 && !ag.joined; i++) await sleep(50);
    for (let i = 0; i < 40 && !sent.length; i++) await sleep(50); await sleep(500);
    const after = await orig("consent", {});
    ag.request = orig;
    ok(closed?.ok && ag.joined && sent.length > 0 && sent.every((a) => a.preset === undefined) && after?.table?.everyone?.touch === "deny",
      "AS15 a rejoin resends the agent's consent table with no preset (which would empty its cells first): what it closed stays closed", { closed, joined: ag.joined, sent, touch: after?.table?.everyone?.touch }); }
  // AS11 (pure: a body that never joins) — a stall blames only a thing the stride presses INTO
  { const stallAgainst = (at) => {
      const b = new WorldAgent({ url: "ws://127.0.0.1:1/ws", name: "Bea", world: "w", avatar: "" });
      b.replica = { st: { entities: { "@world": { c: {} }, box: { c: { transform: { pos: at, q: [0, 0, 0, 1], scale: [1, 1, 1] }, physics: { kind: "dynamic", shape: [[-0.3, 0, -0.3], [0.3, 1.2, 0.3]] } } } } } };
      b.pos = { x: 0, y: 0, z: 0 }; b.target = { x: 0, z: 5, run: false, tolerance: 0.01 }; b.legs = [];
      b.walkPlan = { x: 0, z: 5, run: false, timeoutMs: 1000, tolerance: 0.01, y: undefined, near: {}, passable: new Set(["box"]), replanned: false };
      b.walkDone = () => {}; b.stallTicks = 1e6;
      try { b.noteWalkProgress(5, 1); } catch { /* the re-plan has no world to plan in: what it marked is what's read */ }
      const r = { blamed: b.misjudged.has("box"), stall: b.walkStall };
      try { b.close(); } catch {}
      return r; };
    const ahead = stallAgainst([0, 0, 0.5]), beside = stallAgainst([0.5, 0, 0]);
    ok(ahead.blamed, "(AS11 setup) a stall pressed into a passable crate ahead blames it (re-plans round it)", ahead);
    ok(!beside.blamed && /^blocked at/.test(beside.stall ?? ""), "AS11 a stall that only grazes a passable crate beside the stride doesn't blame it: the walk stops, saying so", beside); }
  // AS12 (review r6 L1) — a thing on a table: move {to: it} is accepted and ends beside the table, on the floor
  { await writeBoxGlb(path.join(OPT, "test/table.glb"), [2, 0.8, 2]); await writeBoxGlb(path.join(OPT, "test/cup.glb"), [0.1, 0.12, 0.1]);
    const m0 = await call("move", { to: [-12, -14] }); ok(!m0.isError, "(AS12 setup) the agent stands at (-12, -14)", T(m0));
    const tb = await mk("table", { model: "test/table.glb", components: { transform: { pos: [-16, 0, -14], q: [0, 0, 0, 1], scale: [1, 1, 1] }, physics: { kind: "static" } } });
    const cp = await mk("cup", { model: "test/cup.glb", components: { transform: { pos: [-16, 0.8, -14], q: [0, 0, 0, 1], scale: [1, 1, 1] }, physics: { kind: "static" } } });
    for (let i = 0; i < 80 && !["table", "cup"].every((id) => Array.isArray(ag.replica?.st?.entities?.[N(id)]?.c?.physics?.shape)); i++) await sleep(50);
    await sleep(1500);   // their colliders are fitted before the walk plans
    ok(tb.ok && cp.ok && ["table", "cup"].every((id) => Array.isArray(ag.replica?.st?.entities?.[N(id)]?.c?.physics?.shape)), "(AS12 setup) a 2×2 m table, 0.8 m tall, and a cup on it (shapes measured)", { tb, cp });
    const t = T(await call("move", { to: "cup" }));
    ok(/^arrived at \[cup\]/.test(t), "AS12 move {to: a cup on a table} is accepted and arrives", t);
    ok(Math.abs(ag.pos.y) < 0.05 && ag.pos.x > -15 && ag.pos.x < -14 && Math.abs(ag.pos.z + 14) < 1.1, "AS12 …beside the table, on the floor", ag.pos); }
  // AS13 (review r6 L2) — a child thing with no physics shape, on an offset parent: aimed at where it IS (its world position),
  // and of two things with one label the nearest is judged by where they are, not by a child's parent-relative offset
  { const me = { x: ag.pos.x, z: ag.pos.z }, L = [me.x + 1.5, 1.2, me.z + 1.5], P = [16, 0, 16], W = [P[0] + L[0], P[2] + L[2]];
    const pl = await mk("plinth", { model: "test/post.glb", components: { transform: { pos: P, q: [0, 0, 0, 1], scale: [1, 1, 1] }, physics: { kind: "static" } } });
    const lp = await mk("lamp", { components: { transform: { pos: L, q: [0, 0, 0, 1], scale: [1, 1, 1] }, parent: { to: N("plinth") }, label: "beacon" } });
    const mr = await mk("marker", { model: "test/post.glb", components: { transform: { pos: [me.x + 5, 0, me.z], q: [0, 0, 0, 1], scale: [1, 1, 1] }, label: "beacon" } });
    for (let i = 0; i < 80 && !["plinth", "lamp", "marker"].every((id) => ag.entities.get(N(id))); i++) await sleep(50);
    ok(pl.ok && lp.ok && mr.ok && !ag.replica?.st?.entities?.[N("lamp")]?.c?.physics, "(AS13 setup) a lamp (no model, so no physics) on a plinth at (16, 16), parent-relative ~2 m from the body: it stands ~25 m off", { pl: pl.ok, lp, mk: mr.ok, L, W, c: ag.replica?.st?.entities?.[N("lamp")]?.c });
    const d = ag.destination(ag.handle(N("lamp")));   // by its handle: its label is "beacon", which the marker wears too
    ok(!("refusal" in d) && Math.hypot(d.x - W[0], d.z - W[1]) < 1.0, "AS13 move {to: the lamp} aims at its world position, not its offset from the plinth", { d, W, me });
    // R 10-17 (binding): a label two things share is refused with both candidates, never resolved to the nearest
    const b = ag.destination("beacon");
    ok("refusal" in b && /"beacon" is the label of 2 things/.test(b.refusal) && b.refusal.includes(`[${ag.handle(N("lamp"))}]`) && b.refusal.includes(`[${ag.handle(N("marker"))}]`), "AS13 …and of two things labelled \"beacon\", move {to: \"beacon\"} is refused with both (label, what, where, handle)", b); }
  // AS14 (pure; review r6 L3) — a misjudged crate rescaled in place (its mass goes with its size) is judged afresh
  { const b = new WorldAgent({ url: "ws://127.0.0.1:1/ws", name: "Bea", world: "w", avatar: "" });
    const box = { c: { transform: { pos: [0, 0, 2], q: [0, 0, 0, 1], scale: [1, 1, 1] }, physics: { kind: "dynamic", density: 40, shape: [[-0.3, 0, -0.3], [0.3, 1.2, 0.3]] } } };
    b.replica = { st: { entities: { "@world": { c: {} }, box } }, sim: { sim: {}, foreign: false } };
    b.misjudged.set("box", { at: [0, 2], sig: b.shoveState("box") });
    const before = b.mayWalkInto("box", false);
    box.c = { ...box.c, transform: { ...box.c.transform, scale: [0.5, 0.5, 0.5] } };
    const after = b.mayWalkInto("box", false);
    try { b.close(); } catch {}
    ok(before === false, "(AS14 setup) a crate found solid stays solid while nothing about it changes", { before });
    ok(after === true, "AS14 the same crate rescaled in place (its centre unmoved) is judged afresh: walked into again", { after }); }
} catch (e) { ok(false, "threw", String(e?.stack ?? e).slice(0, 600)); }
done(fail ? 1 : 0);
