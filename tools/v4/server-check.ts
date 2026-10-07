// tools/v4/server-check.ts — slice 2 at the server: real sequencer processes, real WebSockets, scratch ports and a
// scratch WORLDS_DIR (never the repo's worlds, never ports 8968/8970). usage: bun tools/v4/server-check.ts
//   S1  found a v4 world (tools/v4/world.ts), join it: the snapshot says v4, the founder is its owner
//   S2  writes are door requests: create (a measured GLB), place ON it (the engine catalogue), every client sees it
//   S3  refusals reach the asker: a locked edit (v4 message and old-UI verb; the old guard refused by name), a visitor's create, a spectator's write
//   S4  undo through the door; the log on disk is v4, strictly readable, and every client's own v4 fold = the log
//   S5  an agent's building tools (mcpl/tools.ts HANDLERS) wait for the door: accepted, and refused with the reason
//   S6  translate a v1 world once into a new v4 world: the v1 log's bytes are untouched, the v4 copy is visitable
//   S8  clients fold v4: the v4 cut and stream, no `log` entries; a client that doesn't read v4 is refused (3c)
//   SP  physics: v4-holds to everyone, a joiner's cut carries holds and the sim, leaving while holding drops it
//   S7  joining never founds a world (H3); [was: v1 worlds byte-compared against slice 1 — the server serves no v1 now]
//      
//       compared (logs, snapshots and every message each client received, with clock fields masked)
// @ts-nocheck
import fs from "node:fs";
import path from "node:path";
import { ENGINE, scratch } from "./common.ts";
import { readLog, fold, digest } from "../../shared/v4/fold.js";
import { makeV4Client } from "../../shared/v4/client.js";
import { enc } from "../../shared/v4/names.js";
import { worldPose } from "../../shared/hierarchy.js";

const BASE = process.env.V4_BASE ?? "097eedcc"; // slice 1's head: the v1 server before this slice
const root = scratch("server");
let pass = 0, fail = 0;
const ok = (cond: any, what: string, detail?: any) => { if (cond) pass++; else { fail++; console.log(`  FAIL ${what}${detail !== undefined ? ` — ${JSON.stringify(detail).slice(0, 500)}` : ""}`); } };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---- a measured model: a 1.2 × 0.75 × 0.8 m box, origin at its base centre, written as a real GLB ----
async function writeBoxGlb(file: string, [sx, sy, sz]: number[]) {
  const { Document, NodeIO } = await import("@gltf-transform/core");
  const doc = new Document(); const buf = doc.createBuffer();
  const x = sx / 2, z = sz / 2;
  const P = [[-x, 0, -z], [x, 0, -z], [x, sy, -z], [-x, sy, -z], [-x, 0, z], [x, 0, z], [x, sy, z], [-x, sy, z]];
  const F = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [3, 7, 6], [3, 6, 2], [0, 4, 7], [0, 7, 3], [1, 2, 6], [1, 6, 5]];
  const pos = doc.createAccessor().setType("VEC3").setArray(new Float32Array(P.flat())).setBuffer(buf);
  const idx = doc.createAccessor().setType("SCALAR").setArray(new Uint16Array(F.flat())).setBuffer(buf);
  const mesh = doc.createMesh().addPrimitive(doc.createPrimitive().setAttribute("POSITION", pos).setIndices(idx));
  doc.createScene().addChild(doc.createNode("box").setMesh(mesh));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  await new NodeIO().write(file, doc);
}

// ---- servers ----
async function freePort(from: number) { for (let p = from; p < from + 200; p++) { if (p === 8968 || p === 8970) continue;
  const ok2 = await new Promise((res) => { try { const s = Bun.listen({ hostname: "0.0.0.0", port: p, socket: { data() {} } }); s.stop(true); res(true); } catch { res(false); } }); if (ok2) return p; } throw new Error("no free port"); }
const procs: any[] = [];
process.on("exit", () => { for (const p of procs) try { p.kill(); } catch {} });
async function startServer(tree: string, worlds: string, opt: string, tag: string) {
  const port = await freePort(8990 + procs.length * 7);
  const logf = path.join(root, `${tag}.log`);
  const p = Bun.spawn(["bun", "server/server.ts"], { cwd: tree, env: { ...process.env, PORT: String(port), WORLDS_DIR: worlds, OPT_DIR: opt, SKIP_OPT_SWEEP: "1", TRUST_NAMES: "1",
    BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0", JOIN_TOKEN: "", WORLD_ADMIN: "", EIDO_FLIGHT_REHEARSAL: "" }, stdout: Bun.file(logf), stderr: Bun.file(logf + ".err") });
  procs.push(p);
  for (let i = 0; i < 100; i++) { await sleep(150); try { const r = await fetch(`http://127.0.0.1:${port}/worlds`, { signal: AbortSignal.timeout(1000) }); if (r.ok) return { port, proc: p, log: logf }; } catch {} } // bounded: on this host a closed local port can drop the SYN instead of refusing it
  throw new Error(`${tag} server didn't come up: ${fs.existsSync(logf + ".err") ? fs.readFileSync(logf + ".err", "utf8").slice(-800) : ""}`);
}

// ---- a client: joins, keeps every message, sends v4 requests and v1 verbs ----
async function client(port: number, world: string, id: string, extra: any = {}) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const msgs: any[] = []; const waiters = new Map(); let n = 0;
  ws.onmessage = (ev) => { const m = JSON.parse(String(ev.data)); msgs.push(m); if (m.type === "v4-result") { const f = waiters.get(m.id); if (f) { waiters.delete(m.id); f(m.reply); } } };
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  ws.send(JSON.stringify({ type: "join", world, id, avatar: "", ...extra }));
  for (let i = 0; i < 60 && !msgs.some((m) => m.type === "snapshot" || m.type === "error"); i++) await sleep(50);
  const c = {
    id, ws, msgs, snapshot: msgs.find((m) => m.type === "snapshot"),
    req: (tool: string, args: any = {}) => new Promise<any>((res) => { const rid = `${id}-${++n}`; waiters.set(rid, res); ws.send(JSON.stringify({ type: "v4", id: rid, tool, args })); setTimeout(() => { if (waiters.delete(rid)) res({ ok: false, refused: { code: "timeout" } }); }, 6000); }),
    verb: (verb: string, args: any) => ws.send(JSON.stringify({ type: "verb", verb, args })),
    send: (m: any) => ws.send(JSON.stringify(m)),
    of: (type: string) => msgs.filter((m) => m.type === type),
    close: () => ws.close(),
  };
  return c;
}
/** What this client holds now: its own v4 fold (shared/v4/client.js) of its snapshot's cut and every v4-log it was
 *  sent, restarting at each snapshot. */
function heldBy(c: any) {
  let k = null;
  for (const m of c.msgs) {
    if (m.type === "snapshot" && m.v4?.state) { k = makeV4Client(); k.adopt(JSON.parse(JSON.stringify(m.v4))); }
    else if (m.type === "v4-log" && k) k.ingest(JSON.parse(JSON.stringify(m.entries)), m.from);
  }
  return k;
}
const V4 = { v4fold: true };   // every client in a v4 world folds v4 (slice 3c)

// ================= v4 =================
const W4 = path.join(root, "w4"), OPT = path.join(root, "opt");
fs.mkdirSync(W4, { recursive: true });
await writeBoxGlb(path.join(OPT, "test/table.glb"), [1.2, 0.75, 0.8]);
await writeBoxGlb(path.join(OPT, "test/cup.glb"), [0.1, 0.12, 0.1]);
const tool = (args: string[], worlds = W4) => { const r = Bun.spawnSync(["bun", "tools/v4/world.ts", ...args], { cwd: ENGINE, env: { ...process.env, TRUST_NAMES: "1", WORLDS_DIR: worlds, OPT_DIR: OPT, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" } });
  return { code: r.exitCode, out: r.stdout.toString() + r.stderr.toString() }; };

const f = tool(["found", "garden", "--owner", "Ann", "--title", "a v4 garden"]);
ok(f.code === 0 && /founded v4 world "garden"/.test(f.out), "S1 tools/v4/world.ts found makes a v4 world", f.out);
ok(tool(["found", "garden", "--owner", "Ann"]).code !== 0, "S1 founding over an existing world is refused");
const srv = await startServer(ENGINE, W4, OPT, "v4");
{ const ws0 = await (await fetch(`http://127.0.0.1:${srv.port}/worlds`)).json();
  ok(ws0.worlds?.some((w) => w.name === "garden" && w.loaded === false), "S1 /worlds lists the v4 world on disk before anyone loads it (travel discovery)", ws0); }
const ann = await client(srv.port, "garden", "Ann", V4);
ok(ann.snapshot?.v4?.version === 4, "S1 the snapshot says v4", ann.snapshot?.v4);
ok(ann.snapshot?.yourRights?.role === "owner", "S1 the founder is the owner (the tool's account local:ann is the name Ann joins as on a TRUST_NAMES server)", ann.snapshot?.yourRights);
const ANN = ann.snapshot?.v4?.you;
ok(/^u-[a-z2-7]{20}$/.test(ANN ?? ""), "S1 a v4 joiner is told its identity: an opaque directory id, not its name (round-2 R1)", ann.snapshot?.v4?.you);
ok(!fs.existsSync(path.join(W4, "garden", "log.jsonl")), "S1 no v1 log appears beside the v4 one (no genesis, no land-rush grant)");
const bob = await client(srv.port, "garden", "Bob", V4), vic = await client(srv.port, "garden", "Vic", V4);
await sleep(200);
// an owner grants a PERSON: the id their arrival carries (presence knows people; roles know ids), never a typed name
const idSeen = (name: string) => ann.msgs.find((m: any) => m.type === "arrive" && m.id === name)?.v4id;
const BOB = idSeen("Bob"), VIC = idSeen("Vic");
ok(BOB && BOB === bob.snapshot?.v4?.you && VIC === vic.snapshot?.v4?.you, "S1 an arrival carries the person's identity, the same one they're told", [BOB, VIC]);
for (const [who, id, role] of [["Bob", BOB, "builder"], ["Vic", VIC, "visitor"]]) ok((await ann.req("set", { id: "@world", component: `roles:${id}`, value: { role } })).ok, `S1 Ann makes ${who} a ${role}`);
// SB: a door ban (moderator log, by id) also closes the door at JOIN — it only refused requests, so a banned person
// could still walk in, be seen and look around (v4-vs-v1 review 10-06 #1: two sources of truth for bans)
{ const mal = await client(srv.port, "garden", "Mal", V4); await sleep(150);
  const MAL = mal.snapshot?.v4?.you; mal.close(); await sleep(100);
  ok((await ann.req("ban", { who: MAL, reason: "test" })).ok, "SB1 Ann bans Mal through the door");
  const again = await client(srv.port, "garden", "Mal", V4);
  ok(!again.snapshot && again.of("error").some((m) => /banned/.test(m.error)), "SB2 a door-banned person can't join (no snapshot, told why)", again.msgs.map((m) => m.type));
  again.close(); }
const spec = await client(srv.port, "garden", "Watcher", { spectate: true, ...V4 });
await sleep(200);
ok(bob.of("your-rights").at(-1)?.rights?.role === "builder" && vic.of("your-rights").at(-1)?.rights?.role === "visitor", "S1 roles set through the door reach each client's rights", [bob.of("your-rights").at(-1), vic.of("your-rights").at(-1)]);

const t1 = await ann.req("create", { id: "tbl", model: "test/table.glb", place: { at: [0, 3] } });
ok(t1.ok, "S2 create a measured model", t1);
const c1 = await bob.req("create", { id: "cup", model: "test/cup.glb", place: { on: "tbl" } });
const placed = c1.notes?.find((n) => n.placed)?.placed;
ok(c1.ok && Math.abs(placed?.restsAt - 0.75) < 0.002 && placed?.on === "tbl", "S2 place ON it: the engine catalogue measured the GLB's top at 0.75 m", c1);
await sleep(150);
ok(vic.of("v4-log").length >= 2 && vic.of("log").length === 0, "S2 another client is sent the raw v4 entries (v4-log), and no v1 `log` entries", [vic.of("v4-log").length, vic.of("log").length]);
{ const m = heldBy(vic)?.view()?.entities?.cup?.parent; const loc = fold(readLog(fs.readFileSync(path.join(W4, "garden", "v4.jsonl")))).entities.cup.c.transform.pos;
  ok(m?.to === "tbl" && Array.isArray(m?.offset) && Math.abs(m.offset[0] - loc[0]) < 1e-9 && Math.abs(m.offset[2] - loc[2]) < 1e-9 && Math.abs(m.offset[2]) < 0.5, "S2 in that client's own fold the cup hangs from the table at the door's LOCAL transform (the table stands at z = 3; the cup's offset is near 0)", [m, loc]); }

ok((await ann.req("set", { id: "tbl", component: "lock", value: true })).ok, "S3 Ann locks the table");
const mv = await bob.req("set", { id: "cup", component: "transform", value: { pos: [0.2, 0.75, 0] } });
ok(mv.ok === false && mv.refused?.code === "locked" && /through_lock/.test(mv.refused.teach), "S3 Bob's move of the cup ON the locked table is refused, to Bob, with the reason and the way through", mv);
const errsBefore = bob.of("error").length, headBefore = readLog(fs.readFileSync(path.join(W4, "garden", "v4.jsonl"))).length;
bob.verb("remove", { id: "cup" }); await sleep(300);
ok(bob.of("error").length === errsBefore + 1 && /takes door requests, not v1 verbs/.test(bob.of("error").at(-1)?.error) && readLog(fs.readFileSync(path.join(W4, "garden", "v4.jsonl"))).length === headBefore,
  "S3 a raw v1 verb sent to a v4 world is refused by name, and nothing is written (clients spell verbs as requests at their own edge, 3c)", bob.of("error").at(-1));
{ const vr = await new Promise((res) => { const rid = "raw-1"; const on = (ev) => { const m = JSON.parse(String(ev.data)); if (m.type === "v4-result" && m.id === rid) { bob.ws.removeEventListener("message", on); res(m.reply); } }; bob.ws.addEventListener("message", on); bob.send({ type: "v4", id: rid, verb: "remove", args: { id: "cup" } }); });
  ok(vr?.ok === false && vr.refused?.code === "v1-verb", "S3 …and a v1 verb inside a v4 request is refused the same way", vr); }
{ const { editOps } = await import("../../shared/editschema.js");
  const r = editOps({ pos: [0, 0.75, 0], q: [0, 0, 0, 1], scale: 1, lib: "test/cup.glb", comp: {} }, "cup", { "flags.guard": true });
  ok(!r.ops.length && /merged into `lock`/.test(r.errors.join(" ")), "S3 the old guard flag is refused by name by the shared planner every surface plans with: guard merged into lock (§5)", r); }
ok((await vic.req("create", { id: "vics", model: "test/cup.glb" })).refused?.code === "rights", "S3 a visitor's create is refused (rights)");
ok((await spec.req("create", { id: "x" })).refused?.code === "spectator" && (await spec.req("look")).ok, "S3 a spectator may read, not write");
ok((await bob.req("set", { id: "cup", component: "label", value: "Bob's cup" })).ok, "S3 a label isn't lock-guarded");

const u = await bob.req("undo", {});
ok(u.ok && u.after?.cup && u.after.cup.label === null, "S4 Bob undoes his own last act (the label goes)", u);
// F2 (decided 10-05): revert goes along rank, never upward. A visitor can't undo Bob's act; an owner may (here the
// table's lock still stops it, which is the lock doing its job, not rank)
const u2v = await vic.req("undo", { act: c1.act });
ok(u2v.ok === false && u2v.refused?.code === "rank", "S4 a visitor can't undo someone else's act (rank)", u2v);
const u2 = await ann.req("undo", { act: c1.act });
ok(u2.refused?.code !== "rank", "S4 …an owner may revert it (here only the lock decides)", u2);
const ins = await vic.req("inspect", { id: "cup" });
ok(ins.ok && ins.derived?.madeBy === BOB, "S4 inspect says who made it (a view over the log)", ins);
await sleep(200);
const L = readLog(fs.readFileSync(path.join(W4, "garden", "v4.jsonl")));
const st = fold(L);
ok(st.status === "ok" && !st.diagnostics.some(([, k]) => String(k).startsWith("malformed")), "S4 the log on disk is v4 and reads back strictly", st.diagnostics.slice(0, 3));
ok(L.every((e, i) => i === 0 || e.ts >= L[i - 1].ts) && L.filter((e) => e.kind === "act").length >= 6, "S4 ts never decreases; every write is an act + its result");
ok(L.filter((e) => e.kind === "act").every((e) => [ANN, BOB].includes(e.actor) || (e.actor === VIC && e.body?.refused)), "S4 acts are stamped with the connection's identity, never the payload's (Vic's are his refused attempts, recorded: round-2 R7)", [...new Set(L.map((e) => e.actor))]);
for (const c of [ann, bob, vic, spec]) ok(digest(heldBy(c).st) === digest(st), `S4 what ${c.id} holds (its own v4 fold of what it was sent) = the log on disk (digest)`);
ok([ann, bob, vic].every((c) => c.of("snapshot").length === 1), "S4 no resync was needed (one snapshot each)", [ann, bob, vic].map((c) => c.of("snapshot").length));
{ // the sky (which the v1 projection could only resync for) is just another entry in the stream now
  ok((await ann.req("set", { id: "@world", component: "sky", value: { hours: 18 } })).ok, "S4b Ann sets the sky (owner)"); await sleep(250);
  const t2 = fold(readLog(fs.readFileSync(path.join(W4, "garden", "v4.jsonl"))));
  ok([ann, bob, vic].every((c) => c.of("snapshot").length === 1), "S4b no resync: no second snapshot to anyone", [ann, bob, vic].map((c) => c.of("snapshot").length));
  for (const c of [ann, bob, vic]) ok(digest(heldBy(c).st) === digest(t2) && heldBy(c).view().sky?.hours === 18, `S4b …and ${c.id} holds it (its fold = the log, sky included)`); }

// ---- S5: an agent's tools (mcpl/tools.ts) over this connection ----
{ const { HANDLERS } = await import("../../mcpl/tools.ts");
  const { WorldAgent } = await import("../../mcpl/agent.ts");
  // the real MCPL body (mcpl/agent.ts), joined as Bob: its snapshot sets ag.v4, and its door() awaits v4-result
  const ag: any = new WorldAgent({ url: `ws://127.0.0.1:${srv.port}/ws`, name: "Bob", world: "garden", avatar: "" });
  await ag.connect(); for (let i = 0; i < 40 && !ag.v4; i++) await sleep(50);
  ok(ag.v4?.version === 4, "S5 the MCPL agent learns from its snapshot that this is a v4 world", ag.v4);
  ag.verb = () => { throw new Error("a v4 world's building tool must not fire-and-forget"); };
  const sp = await HANDLERS.spawn(ag, { lib: "test/cup.glb", x: 2, z: 2, id: "agentcup" }, {} as any, "spawn");
  ok(!sp.isError && /accepted/.test(sp.content[0].text), "S5 the agent's spawn waits for the door and says it was accepted", sp.content[0].text);
  const rm = await HANDLERS.remove(ag, { id: "cup" }, {} as any, "remove");
  ok(rm.isError && /locked/.test(rm.content[0].text), "S5 the agent's remove of a locked thing comes back as an error naming the lock (PARITY (d)1)", rm.content[0].text);
  const dr = await HANDLERS.door(ag, { tool: "place", args: { id: "agentcup", on: "tbl" } }, {} as any, "door");
  ok(!dr.isError && /"ok": true/.test(dr.content[0].text), "S5 the door tool exposes the v4 vocabulary (relational place)", dr.content[0].text.slice(0, 200));
  const un0 = await HANDLERS.door(ag, { tool: "undo", args: {} }, {} as any, "door");
  ok(un0.isError && /locked/.test(un0.content[0].text), "S5 undoing that place is refused now (the inverse goes through admit: the table is locked)", un0.content[0].text.slice(0, 200));
  await HANDLERS.door(ag, { tool: "set", args: { id: "agentcup", component: "label", value: "mine" } }, {} as any, "door");
  const un = await HANDLERS.door(ag, { tool: "undo", args: {} }, {} as any, "door");
  ok(!un.isError && /"label": null/.test(un.content[0].text), "S5 …and an undo the agent may make goes through (agents had none: PARITY (b)1)", un.content[0].text.slice(0, 200));
  // slice 3c: the agent folds the v4 stream itself (joined v4fold), never the v1 projection
  ok(ag.v4c?.active === true && ag.entities.has("agentcup"), "S5b the agent folds the door's own stream, and sees what it made there", [ag.v4c?.active, [...ag.entities.keys()]]);
  const mk = await HANDLERS.door(ag, { tool: "create", args: { id: "plank", model: "test/table.glb", place: { at: [6, 6] } } }, {} as any, "door");
  const sc = await HANDLERS.door(ag, { tool: "set", args: { id: "plank", component: "transform", value: { pos: [6, 0, 6], q: [0, 0, 0, 1], scale: [2, 1, 0.5] } } }, {} as any, "door");
  ok(!mk.isError && !sc.isError, "S5b (the agent makes a plank and stretches it)", [mk.content[0].text.slice(0, 160), sc.content[0].text.slice(0, 160)]);
  for (let i = 0; i < 40 && JSON.stringify(ag.entities.get("plank")?.scale3) !== "[2,1,0.5]"; i++) await sleep(50);
  ok(JSON.stringify(ag.entities.get("plank")?.scale3) === "[2,1,0.5]", "S5b a stretched thing stays stretched in what the agent holds (the v1 replay flattened it)", ag.entities.get("plank"));
  ok(JSON.stringify(ag.st.entities.plank?.scale3) === "[2,1,0.5]", "S5b …and in its view of the world (the record its look/inspect read)", ag.st.entities.plank);
  // the world's own keys and chat reach it from the stream too (a v1 world's agent got them as verbs)
  ok((await ann.req("set", { id: "@world", component: "sky", value: { hours: 7 } })).ok && (await ann.req("say", { text: "hello, agent" })).ok, "S5c (Ann sets the sky, then speaks)");
  for (let i = 0; i < 40 && !(ag.skyState?.hours === 7 && ag.inbox.some((m) => m.text === "hello, agent")); i++) await sleep(50);
  ok(ag.skyState?.hours === 7, "S5c the agent's sky follows a v4 world's sky", ag.skyState);
  ok(ag.inbox.some((m) => m.kind === "say" && m.who === "Ann" && m.text === "hello, agent") && ag.st.recentChat?.some((m) => m.text === "hello, agent"), "S5c …and a chat line lands in its inbox and its chat window", [ag.inbox.slice(-2), ag.st.recentChat?.slice(-1)]);
  // the agent's own voice and its reading of the log, with no v1 verb on the wire (3c: the server refuses them now)
  await HANDLERS.say(ag, { text: "hello, Ann" }, {} as any, "say");
  const saidOnDisk = async () => readLog(fs.readFileSync(path.join(W4, "garden", "v4.jsonl"))).some((e) => e.kind === "say" && e.actor === BOB && e.body?.text === "hello, Ann");
  for (let i = 0; i < 40 && !(await saidOnDisk()); i++) await sleep(50);
  ok(await saidOnDisk(), "S5d the agent's say reaches a v4 world's log (as a door request, spelled by the agent)");
  const wh = await HANDLERS.world_history(ag, { limit: 20 }, {} as any, "world_history");
  ok(!wh.isError && /Bob: set /.test(wh.content[0].text) && /say "hello, Ann"|hello, Ann/.test(wh.content[0].text), "S5d world_history in a v4 world reads the v4 log (acts and says), not v1's chat-only history", wh.content[0].text.slice(0, 400));
  ag.close(); }

// ---- S6: translate a v1 world into a new v4 world ----
{ // an old (v1) world's log, as one arrives for translation: the server has no v1 runtime, so it's written as a file
  // (the same verbs the old client sent: a grant, a spawn, a comp, a mount by offset and by socket, a say)
  const T0 = 1790000000000; const L = [
    { actor: "world", verb: "grant", args: { id: "Ann", role: "owner", gen: true } },
    { actor: "Ann", verb: "spawn", args: { id: "lamp_1", lib: "test/table.glb", pos: [1, 0, 1], yaw: 0.5 } },
    { actor: "Ann", verb: "comp", args: { id: "lamp_1", type: "label", data: "the old table" } },
    { actor: "Ann", verb: "spawn", args: { id: "cup_1", lib: "test/cup.glb", pos: [1, 0.75, 1] } },
    { actor: "Ann", verb: "mount", args: { id: "cup_1", to: "lamp_1", offset: [0, 0.75, 0] } },
    { actor: "Ann", verb: "comp", args: { id: "lamp_1", type: "sockets", data: { seat: { pos: [0.3, 0.75, 0.1], yaw: 1 } } } },
    { actor: "Ann", verb: "spawn", args: { id: "mug_1", lib: "test/cup.glb", pos: [7, 0, 7] } },
    { actor: "Ann", verb: "mount", args: { id: "mug_1", to: "lamp_1", slot: "seat" } },
    { actor: "Ann", verb: "say", args: { text: "hello from v1" } }];
  fs.mkdirSync(path.join(W4, "oldtown"), { recursive: true });
  fs.writeFileSync(path.join(W4, "oldtown", "log.jsonl"), L.map((e, k) => JSON.stringify({ seq: k, ts: T0 + k * 1000, ...e })).join("\n") + "\n");
  const v1log = path.join(W4, "oldtown", "log.jsonl"); const before = fs.readFileSync(v1log);
  const tr = tool(["translate", "oldtown", "oldtown-v4"]);
  ok(tr.code === 0 && /0 divergences/.test(tr.out) && /mtime unchanged: true/.test(tr.out), "S6 translate writes a new v4 world and reports 0 divergences", tr.out);
  ok(Buffer.compare(before, fs.readFileSync(v1log)) === 0, "S6 the v1 log's bytes are unchanged (R9)");
  const [g, t1] = fs.readFileSync(path.join(W4, "oldtown-v4", "v4.jsonl"), "utf8").split("\n").slice(0, 2).map((l) => JSON.parse(l));
  ok(g.body.minor === 0 && typeof g.body.nonce === "string" && /^ed25519:/.test(g.body.sequencer) && !("translatedFrom" in g.body), "S6 genesis is §2.4's (minor, nonce, sequencer; no translatedFrom)", g.body);
  ok(t1.verb === "translated" && /^eidoverse\/translate-v1@/.test(t1.body.from?.translator) && /^[0-9a-f]{16}$/.test(t1.body.from?.fold), "S6 the act after genesis names the engine translator and the v1 fold build", t1.body);
  ok(tool(["translate", "oldtown", "oldtown-v4"]).code !== 0, "S6 translating onto an existing world is refused");
  // the old world as the old fold reads its log (the translator's own reader; nothing serves v1 any more) vs the v4 copy
  const { emptyState: v1Empty, foldEntry: v1Fold } = await import("../../shared/fold.js");
  const v1st = v1Empty(); for (const l of fs.readFileSync(v1log, "utf8").split("\n").filter(Boolean)) v1Fold(v1st, JSON.parse(l));
  const old = { snapshot: { state: v1st } }, neu = await client(srv.port, "oldtown-v4", "Ann", V4);
  const oldv1 = await client(srv.port, "oldtown", "Ann");
  ok(!oldv1.snapshot && oldv1.of("error").some((m) => /no world called "oldtown"/.test(m.error)), "S6 the server doesn't serve the old world itself: v4 only, an old log is translated", oldv1.msgs.map((m) => m.type)); oldv1.close();
  // what a person SEES: each thing's world pose as the renderer composes it (shared/hierarchy.js). A riding thing's own
  // v1 pos is its unused pre-mount pose, so comparing raw `pos` would compare a hidden field (translate-v1@2 DROPPED)
  const r6 = (v) => v.map((n) => Math.round(n * 1e6) / 1e6);
  const E = (s) => Object.fromEntries(Object.entries(s.entities).map(([id, e]) => { const p = worldPose(s.entities, id);
    return [id, { lib: e.lib, at: r6(p.pos), q: r6(p.q), label: e.comp?.label, parent: e.parent?.to, slot: e.parent?.slot }]; }));
  ok(JSON.stringify(E(old.snapshot.state)) === JSON.stringify(E(neu.snapshot.state)), "S6 the v4 copy shows the same things to today's client, where they are (mounted at an offset and at a socket)", [E(old.snapshot.state), E(neu.snapshot.state)]);
  const v4c = fold(readLog(fs.readFileSync(path.join(W4, "oldtown-v4", "v4.jsonl")))).entities;
  ok(JSON.stringify(v4c[enc("mug_1")].c.parent) === JSON.stringify({ to: enc("lamp_1"), order: "a0", slot: "seat" }) && JSON.stringify(v4c[enc("mug_1")].c.transform.pos) === "[0.3,0.75,0.1]",
    "S6 a translated mount is in the door's shape: transform local to the parent (here the socket's pos), parent {to, order, slot}", [v4c[enc("mug_1")].c.parent, v4c[enc("mug_1")].c.transform]);
  ok(neu.snapshot.v4?.version === 4 && neu.snapshot.yourRights?.role === "owner" && !old.snapshot.v4, "S6 v4 copy: v4, and Ann still owns it (the original log is read only by the translator)", [neu.snapshot.yourRights, old.snapshot.v4]);
  ok(neu.snapshot.state.recentChat?.some((m) => m.text === "hello from v1"), "S6 the chat window comes across");
  const ed = await neu.req("set", { id: enc("lamp_1"), component: "label", value: "the new table" });
  ok(ed.ok, "S6 the translated world takes v4 edits from its owner", ed);
  void old; neu.close(); }

// ---- S8: clients that fold v4 themselves (slice 3b): the v4 cut at join, the v4 stream, no projection ----
{ ok(tool(["found", "meadow", "--owner", "Ann"]).code === 0, "S8 found a second v4 world");
  const a = await client(srv.port, "meadow", "Ann", { v4fold: true });
  ok(a.snapshot?.v4?.state?.["@world"] && Number.isInteger(a.snapshot.v4.head) && Array.isArray(a.snapshot.v4.mine), "S8 a v4-folding client's snapshot carries the fold, its head and my undoable acts", Object.keys(a.snapshot?.v4 ?? {}));
  const bv = await client(srv.port, "meadow", "Bob", { v4fold: true }); // Bob folds v4 too: nobody reads the projection
  ok(bv.snapshot?.yourRights?.role === "visitor", "S8 Bob arrives a visitor", bv.snapshot?.yourRights);
  const r1 = await a.req("create", { id: "box", model: "test/table.glb", place: { at: [1, 1] } });
  ok((await a.req("set", { id: "@world", component: `roles:${bv.snapshot?.v4?.you}`, value: { role: "builder" } })).ok, "S8 Ann makes Bob a builder");
  await sleep(200);
  ok(bv.of("your-rights").at(-1)?.rights?.role === "builder", "S8 …and Bob is told at once (the door's role, not v1's stranger default)", bv.of("your-rights").map((m) => m.rights?.role));
  { const g = await fetch(`http://127.0.0.1:${srv.port}/geom?world=meadow&id=box`, { signal: AbortSignal.timeout(3000) });
    ok(g.status === 200, "S8 an HTTP reader of the world's view (/geom) sees a thing just made (the view is rebuilt for its reader, never stale)", g.status); }
  bv.close();
  ok(r1.ok && a.of("log").length === 0 && a.of("v4-log").length >= 2, "S8 it gets v4-log and no `log` entries", [a.of("log").length, a.of("v4-log").length]);
  const c = makeV4Client(); c.adopt(a.snapshot.v4);
  for (const m of a.of("v4-log")) c.ingest(m.entries, m.from);
  const disk = fold(readLog(fs.readFileSync(path.join(W4, "meadow", "v4.jsonl"))));
  ok(digest(c.st) === digest(disk), "S8 its own fold of the stream = the log on disk (digest)");
  // a client that doesn't read v4 (an old page, an old agent build) is refused, with the reason, and isn't redialed (4005)
  const b = await client(srv.port, "meadow", "Bob");
  for (let i = 0; i < 40 && b.ws.readyState !== 3; i++) await sleep(50);
  ok(!b.snapshot && /protocol v4 world/.test(b.of("error").at(-1)?.error ?? "") && b.ws.readyState === 3, "S8 a joiner that doesn't read v4 is refused, told why, and closed", [b.of("error").at(-1), b.ws.readyState]);
  const r2 = await a.req("set", { id: "box", component: "label", value: "after the refusal" }); await sleep(200);
  ok(r2.ok && a.of("log").length === 0, "S8 …and the world carries on, still sending no `log` entries", a.of("log").length);
  ok(a.snapshot.v4.mine.length === 0 && (await client(srv.port, "meadow", "Ann", { v4fold: true })).snapshot.v4.mine.includes(r2.act), "S8 a rejoin's undo stack holds my acts (Ctrl+Z survives a reload)");
  a.close(); }
// ---- SP: physics at the server (design 20): who holds what is sent to everyone; a joiner's cut carries it and the sim;
// a person who leaves while holding something drops it into the world ----
{ ok(tool(["found", "pitch", "--owner", "Ann"]).code === 0, "SP found a physics world");
  const a = await client(srv.port, "pitch", "Ann", V4); await sleep(100);
  ok((await a.req("set", { id: "@world", component: "sim", value: { engine: "eidosim@0.5.0" } })).ok, "SP Ann turns physics on");
  ok((await a.req("create", { id: "ball", model: "test/cup.glb", components: { physics: { kind: "dynamic", who: "visitor" } }, place: { at: [0, 1] } })).ok, "SP a cup anyone may carry");
  const b = await client(srv.port, "pitch", "Bob", V4); await sleep(150); const B = b.snapshot?.v4?.you;
  ok((await b.req("move", { to: [0, 0, 0.5] })).ok && (await b.req("grab", { id: "ball" })).ok, "SP Bob arrives and picks it up");
  await sleep(200);
  ok(a.of("v4-holds").at(-1)?.holds?.ball?.by === B, "SP1 everyone is told who holds it (v4-holds: presence, never logged)", a.of("v4-holds"));
  const c = await client(srv.port, "pitch", "Cy", V4);
  ok(c.snapshot?.v4?.holds?.ball?.by === B, "SP2 a joiner's cut says who holds what", c.snapshot?.v4?.holds);
  ok(c.snapshot?.v4?.sim?.spec?.engine === "eidosim@0.5.0" && c.snapshot.v4.sim.sim?.epoch, "SP2 …and carries the sim where the door's clock stands (a joiner folds later launches with it)", c.snapshot?.v4?.sim?.spec);
  const n = a.of("v4-log").length; b.close(); await sleep(400);
  const launched = a.of("v4-log").slice(n).flatMap((m) => m.entries).filter((e) => e?.kind === "sim" && e.verb === "launch" && e.body?.id === "ball");
  ok(launched.length === 1 && a.of("v4-holds").at(-1)?.holds?.ball === undefined, "SP3 Bob leaves holding it: it's dropped into the world (a launch), and nobody holds it", [launched.length, a.of("v4-holds").at(-1)]);
  // wait until the door has it at rest: the door's clock is the wall clock made monotonic, and this host's wall clock
  // has been seen to step BACK 1.4 s under load (WSL), which stalls physics time for as long (never reorders it)
  let wr = null; for (let i = 0; i < 20; i++) { await sleep(500); wr = await a.req("wait", {}); if (!Object.keys(wr?.inFlight ?? {}).length) break; }
  let k = null; for (let i = 0; i < 40; i++) { await sleep(100); k = heldBy(c); if (k?.sim?.checks?.agree >= 1) break; } // (the rest's v4-log reaching Cy)
  const rest = fold(readLog(fs.readFileSync(path.join(W4, "pitch", "v4.jsonl")))).entities.ball.c.transform.pos;
  ok(rest[1] === 0 && k?.sim?.checks?.agree >= 1 && !k.sim.checks.disagree.length, "SP4 it rests on the ground, and Cy's own fold (from his cut) agrees with the door's rest", [rest, k?.sim?.checks, wr]);
  a.close(); c.close(); }
for (const c of [ann, bob, vic, spec]) c.close();
await sleep(200);
// ================= S7: joining never founds a world (security review 10-06 H3) =================
// (S7 used to byte-compare v1 worlds against slice 1's tree; the server has no v1 runtime now, by design)
{ const ghost = await client(srv.port, "nobodyhome", "Ann", V4);
  ok(!ghost.snapshot && ghost.of("error").some((m) => /no world called "nobodyhome"/.test(m.error)) && !fs.existsSync(path.join(W4, "nobodyhome")),
    "S7 joining a world name that doesn't exist is refused, and nothing is created on disk", [ghost.msgs.map((m) => m.type), fs.existsSync(path.join(W4, "nobodyhome"))]);
  ghost.close(); }

const errlog = fs.existsSync(srv.log + ".err") ? fs.readFileSync(srv.log + ".err", "utf8") : "";
ok(!/failed server-side|v1 '.*' write has no path/.test(errlog + fs.readFileSync(srv.log, "utf8")), "S* the v4 server logged no server-side failure", errlog.slice(-600));
srv.proc.kill();


console.log(`[server-check] ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
