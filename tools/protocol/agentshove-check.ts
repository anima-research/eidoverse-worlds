// tools/protocol/agentshove-check.ts — body shove for an agent's body: a real mcpl/agent.ts WorldAgent walking (the move
// tool, walk_to's new name) against a real sequencer running eidosim. Its walk pushes loose things it walks into through the
// same punt {shove: true} a person's client sends (shared/shove.js decides, the authority admits). Scratch port, scratch
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
const env = (extra = {}) => ({ ...process.env, WORLDS_DIR: W, OPT_DIR: OPT, SKIP_OPT_SWEEP: "1", HOST: "127.0.0.1",
  BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0", JOIN_TOKEN: "", WORLD_ADMIN: "", TRUST_NAMES: "1", EIDO_FLIGHT_REHEARSAL: "", SESSIONS_PATH: path.join(root, "sessions.json"), ...extra });
const r0 = Bun.spawnSync(["bun", "tools/protocol/world.ts", "found", "yard", "--owner", "Ann"], { cwd: ENGINE, env: env() });
ok(r0.exitCode === 0, "(setup) found yard, Ann owns it", r0.stderr.toString().slice(-300));
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
      req: async (verb, args = {}) => { const id = `q${++rn}`; ws.send(JSON.stringify({ type: "request", id, verb, args }));
        for (let i = 0; i < 80; i++) { const r = msgs.find((m) => m.type === "reply" && m.id === id); if (r) return r.reply; await sleep(50); } return { ok: false, timeout: true }; } };
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
  const crate = (id, model, pos, extra = {}, mass = 20) => ann.req("create", { id, model, components: { transform: { pos, q: [0, 0, 0, 1], scale: [1, 1, 1] }, physics: { kind: "dynamic", who: "visitor", mass }, ...extra } });
  for (const [id, model, pos, extra, mass] of [["low", "test/lowcrate.glb", [0, 0, 2]], ["tall", "test/tallcrate.glb", [6, 0, 2], {}, 30], ["still", "test/lowcrate.glb", [12, 0, 2]], ["locked", "test/lowcrate.glb", [18, 0, 2], { lock: true }]] as any) {
    const r = await crate(id, model, pos, extra, mass); ok(r.ok, `(setup) ${id} crate`, r); }
  for (let i = 0; i < 80 && !["low", "tall", "still", "locked"].every((id) => ag.replica?.st?.entities?.[id]?.c?.physics?.shape); i++) await sleep(50);
  ok(["low", "tall", "still", "locked"].every((id) => Array.isArray(ag.replica?.st?.entities?.[id]?.c?.physics?.shape)), "(setup) the authority measured each crate's shape (the agent folds it)");
  const call = (name, a = {}) => HANDLERS[name](ag, a, { agent: ag, canPush: () => false, heldActivity: [], cursor: { caughtUpTo: null } }, name);
  const entries = () => readLog(fs.readFileSync(path.join(W, "yard", "world.jsonl")));
  const shoves = (id) => entries().filter((e) => e.kind === "act" && e.verb === "punt" && e.actor === HEP && !e.body?.refused && e.body?.request?.id === id && e.body?.request?.shove === true);
  const anyPunt = (id) => entries().filter((e) => e.kind === "act" && e.verb === "punt" && e.actor === HEP && JSON.stringify(e.body ?? {}).includes(`"${id}"`));
  const posOf = (id) => ag.replica?.st?.entities?.[id]?.c?.transform?.pos ?? null;
  const settle = async (id) => { for (let i = 0; i < 100; i++) { await sleep(100); if (!ag.replica?.sim?.sim?.bodies?.[id]) { await ann.req("wait", {}); return; } } };

  // AS1
  { const m0 = await call("move", { to: [0, 0] }); ok(!m0.isError, "(AS1 setup) the agent stands at the origin", T(m0));
    const w = await call("move", { to: [0, 4.5] }); await settle("low"); await sleep(400);
    const s = shoves("low"), p = posOf("low");
    ok(s.length >= 1, "AS1 a low crate in the walk's path is shoved: a punt {shove: true} by the agent", { n: s.length, sample: s[0] ?? null, any: anyPunt("low").map((e) => e.body) });
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
  { const r = await ann.req("create", { id: "fixed", model: "test/tallcrate.glb", components: { transform: { pos: [-6, 0, 2], q: [0, 0, 0, 1], scale: [1, 1, 1] }, physics: { kind: "static" } } });
    ok(r.ok, "(AS5 setup) a static tall crate", r);
    for (let i = 0; i < 80 && !Array.isArray(ag.replica?.st?.entities?.fixed?.c?.physics?.shape); i++) await sleep(50);
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
    for (let i = 0; i < 80 && !Array.isArray(ag.replica?.st?.entities?.heavy?.c?.physics?.shape); i++) await sleep(50);
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
    for (let i = 0; i < 80 && !Array.isArray(ag.replica?.st?.entities?.late?.c?.physics?.shape); i++) await sleep(50);
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
} catch (e) { ok(false, "threw", String(e?.stack ?? e).slice(0, 600)); }
done(fail ? 1 : 0);
