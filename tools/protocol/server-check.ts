// tools/protocol/server-check.ts — the server: real sequencer processes, real WebSockets, scratch ports and a
// scratch WORLDS_DIR (never the repo's worlds, never ports 8968/8970). usage: bun tools/protocol/server-check.ts
//   S1  found a world (tools/protocol/world.ts), join it: the snapshot says {dialect, v}, the founder is its owner
//   S2  writes are requests: create (a measured GLB), place ON it (the engine catalogue), every client sees it
//   S3  refusals reach the asker: a locked edit, an old-style verb (writes nothing), a visitor's create, a spectator's write
//   S4  undo through the authority; the log on disk is strictly readable, and every client's own fold = the log
//   S5  an agent's building tools (mcpl/tools.ts HANDLERS) wait for the authority: accepted, and refused with the reason
//   S6  the importer translates an old world once into a new world: the old log's bytes are untouched, the copy is
//       visitable, and the old directory itself is not served
//   S8  clients fold the log: the cut and stream, no `log` entries; a client that doesn't fold it is refused (3c)
//   SP  physics: holds to everyone, a joiner's cut carries holds and the sim, leaving while holding drops it
//   S7  joining never founds a world (H3)
//   CB  the captioner bot through the authority's caption tool (the screen's captioners; the server-stamped generation)
// @ts-nocheck
import fs from "node:fs";
import path from "node:path";
import { ENGINE, scratch } from "./common.ts";
import { readLog, fold, digest } from "../../shared/protocol/fold.js";
import { makeReplica, stateFromWire } from "../../shared/protocol/replica.js";
import { viewState } from "../../shared/protocol/view.js";
import { enc } from "../../shared/protocol/names.js";
import { worldPose } from "../../shared/hierarchy.js";
import { idAliases } from "./idalias.ts";
const IDS = idAliases();


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
  const p = Bun.spawn(["bun", "server/server.ts"], { cwd: tree, env: { ...process.env, PORT: String(port), WORLDS_DIR: worlds, OPT_DIR: opt, SKIP_OPT_SWEEP: "1", TRUST_NAMES: "1", RENAME_COOLDOWN_DAYS: "0.001",
    BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0", JOIN_TOKEN: "", WORLD_ADMIN: "", EIDO_FLIGHT_REHEARSAL: "" }, stdout: Bun.file(logf), stderr: Bun.file(logf + ".err") });
  procs.push(p);
  for (let i = 0; i < 100; i++) { await sleep(150); try { const r = await fetch(`http://127.0.0.1:${port}/worlds`, { signal: AbortSignal.timeout(1000) }); if (r.ok) return { port, proc: p, log: logf }; } catch {} } // bounded: on this host a closed local port can drop the SYN instead of refusing it
  throw new Error(`${tag} server didn't come up: ${fs.existsSync(logf + ".err") ? fs.readFileSync(logf + ".err", "utf8").slice(-800) : ""}`);
}

// ---- a client: joins, keeps every message, sends requests ----
async function client(port: number, world: string, id: string, extra: any = {}) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const msgs: any[] = []; const waiters = new Map(); let n = 0;
  ws.onmessage = (ev) => { const m = JSON.parse(String(ev.data)); msgs.push(m); if (m.type === "reply") { const f = waiters.get(m.id); if (f) { waiters.delete(m.id); f(m.reply); } } };
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  ws.send(JSON.stringify({ type: "join", world, id, avatar: "", ...extra }));
  for (let i = 0; i < 60 && !msgs.some((m) => m.type === "snapshot" || m.type === "error"); i++) await sleep(50);
  const c = {
    id, ws, msgs, snapshot: msgs.find((m) => m.type === "snapshot"),
    // R 10-17: the suite's names for things ride as placeholders and minted ids (tools/protocol/idalias.ts)
    req: (verb: string, args: any = {}) => new Promise<any>((res) => { const rid = `${id}-${++n}`; waiters.set(rid, (r: any) => res(IDS.back(r))); ws.send(JSON.stringify({ type: "request", id: rid, verb, args: IDS.out(verb, args) })); setTimeout(() => { if (waiters.delete(rid)) res({ ok: false, refused: { code: "timeout" } }); }, 6000); }),
    send: (m: any) => ws.send(JSON.stringify(m)),
    of: (type: string) => msgs.filter((m) => m.type === type),
    close: () => ws.close(),
  };
  return c;
}
/** What this client holds now: its own fold (shared/protocol/replica.js) of its snapshot's cut and every log it was
 *  sent, restarting at each snapshot. */
function heldBy(c: any) {
  let k = null;
  for (const m of c.msgs) {
    if (m.type === "snapshot" && m.cut?.state) { k = makeReplica(); k.adopt(JSON.parse(JSON.stringify(m.cut))); }
    else if (m.type === "log" && k) k.ingest(JSON.parse(JSON.stringify(m.entries)), m.from);
  }
  return k;
}
const REPLICA = { replica: true };   // every client in a world folds the log (slice 3c)

// ================= the protocol =================
const W4 = path.join(root, "w4"), OPT = path.join(root, "opt");
fs.mkdirSync(W4, { recursive: true });
await writeBoxGlb(path.join(OPT, "test/table.glb"), [1.2, 0.75, 0.8]);
await writeBoxGlb(path.join(OPT, "test/cup.glb"), [0.1, 0.12, 0.1]);
const tool = (args: string[], worlds = W4) => { const r = Bun.spawnSync(["bun", "tools/protocol/world.ts", ...args], { cwd: ENGINE, env: { ...process.env, TRUST_NAMES: "1", WORLDS_DIR: worlds, OPT_DIR: OPT, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" } });
  return { code: r.exitCode, out: r.stdout.toString() + r.stderr.toString() }; };

const f = tool(["found", "garden", "--owner", "Ann", "--title", "a test garden"]);
ok(f.code === 0 && /founded world "garden"/.test(f.out), "S1 tools/protocol/world.ts found makes a world", f.out);
ok(tool(["found", "garden", "--owner", "Ann"]).code !== 0, "S1 founding over an existing world is refused");
const srv = await startServer(ENGINE, W4, OPT, "main");
{ const ws0 = await (await fetch(`http://127.0.0.1:${srv.port}/worlds`)).json();
  ok(ws0.worlds?.some((w) => w.name === "garden" && w.loaded === false), "S1 /worlds lists the world on disk before anyone loads it (travel discovery)", ws0); }
const ann = await client(srv.port, "garden", "Ann", REPLICA);
ok(ann.snapshot?.cut?.dialect === "eidoverse-log" && ann.snapshot?.cut?.v === 4, "S1 the snapshot says which log this is and which protocol reads it: {dialect, v}", ann.snapshot?.cut);
ok(ann.snapshot?.yourRights?.role === "owner", "S1 the founder is the owner (the tool's account local:ann is the name Ann joins as on a TRUST_NAMES server)", ann.snapshot?.yourRights);
const ANN = ann.snapshot?.cut?.you;
ok(/^u-[a-z2-7]{20}$/.test(ANN ?? ""), "S1 a joiner is told its identity: an opaque directory id, not its name (round-2 R1)", ann.snapshot?.cut?.you);
ok(!fs.existsSync(path.join(W4, "garden", "log.jsonl")), "S1 no v1 log appears beside the new one (no genesis, no land-rush grant)");
const bob = await client(srv.port, "garden", "Bob", REPLICA), vic = await client(srv.port, "garden", "Vic", REPLICA);
await sleep(200);
// an owner grants a PERSON: the id their arrival carries (presence knows people; roles know ids), never a typed name
const idSeen = (name: string) => ann.msgs.find((m: any) => m.type === "arrive" && m.id === name)?.actorId;
const BOB = idSeen("Bob"), VIC = idSeen("Vic");
ok(BOB && BOB === bob.snapshot?.cut?.you && VIC === vic.snapshot?.cut?.you, "S1 an arrival carries the person's identity, the same one they're told", [BOB, VIC]);
for (const [who, id, role] of [["Bob", BOB, "builder"], ["Vic", VIC, "visitor"]]) ok((await ann.req("set", { id: "@world", component: `roles:${id}`, value: { role } })).ok, `S1 Ann makes ${who} a ${role}`);
// SB: a door ban (moderator log, by id) also closes the authority at JOIN — it only refused requests, so a banned person
// could still walk in, be seen and look around (old-vs-new review 10-06 #1: two sources of truth for bans)
{ const mal = await client(srv.port, "garden", "Mal", REPLICA); await sleep(150);
  const MAL = mal.snapshot?.cut?.you; mal.close(); await sleep(100);
  ok((await ann.req("ban", { who: MAL, reason: "test" })).ok, "SB1 Ann bans Mal through the authority");
  const again = await client(srv.port, "garden", "Mal", REPLICA);
  ok(!again.snapshot && again.of("error").some((m) => /banned/.test(m.error)), "SB2 a door-banned person can't join (no snapshot, told why)", again.msgs.map((m) => m.type));
  again.close(); }
const spec = await client(srv.port, "garden", "Watcher", { spectate: true, ...REPLICA });
await sleep(200);
ok(bob.of("your-rights").at(-1)?.rights?.role === "builder" && vic.of("your-rights").at(-1)?.rights?.role === "visitor", "S1 roles set through the authority reach each client's rights", [bob.of("your-rights").at(-1), vic.of("your-rights").at(-1)]);

const t1 = await ann.req("create", { id: "tbl", model: "test/table.glb", place: { at: [0, 3] } });
ok(t1.ok, "S2 create a measured model", t1);
const c1 = await bob.req("create", { id: "cup", model: "test/cup.glb", place: { on: "tbl" } });
const placed = c1.notes?.find((n) => n.placed)?.placed;
ok(c1.ok && Math.abs(placed?.restsAt - 0.75) < 0.002 && placed?.on === IDS.of("tbl"), "S2 place ON it: the engine catalogue measured the GLB's top at 0.75 m", c1);
await sleep(150);
ok(vic.of("log").length >= 2 && vic.of("log").every((m: any) => Array.isArray(m.entries) && m.entries.every((e: any) => typeof e.kind === "string" && typeof e.verb === "string" && !("args" in e))), "S2 another client is sent the raw entries (log), every one a typed entry (kind, verb, body; never a v1 {verb, args})", vic.of("log").map((m: any) => m.entries?.map((e: any) => e.kind)));
{ const m = heldBy(vic)?.view()?.entities?.[IDS.of("cup")]?.parent; const loc = fold(readLog(fs.readFileSync(path.join(W4, "garden", "world.jsonl")))).entities[IDS.of("cup")].c.transform.pos;
  ok(m?.to === IDS.of("tbl") && Array.isArray(m?.offset) && Math.abs(m.offset[0] - loc[0]) < 1e-9 && Math.abs(m.offset[2] - loc[2]) < 1e-9 && Math.abs(m.offset[2]) < 0.5, "S2 in that client's own fold the cup hangs from the table at the authority's LOCAL transform (the table stands at z = 3; the cup's offset is near 0)", [m, loc]); }

ok((await ann.req("set", { id: "tbl", component: "lock", value: true })).ok, "S3 Ann locks the table");
const mv = await bob.req("set", { id: "cup", component: "transform", value: { pos: [0.2, 0.75, 0] } });
ok(mv.ok === false && mv.refused?.code === "locked" && /throughLock/.test(mv.refused.fix), "S3 Bob's move of the cup ON the locked table is refused, to Bob, with the reason and the way through", mv);
const headBefore = readLog(fs.readFileSync(path.join(W4, "garden", "world.jsonl"))).length;
bob.send({ type: "verb", verb: "remove", args: { id: "cup" } }); await sleep(300);   // an old client's message: the server has no handler for it
{ const vr = await new Promise((res) => { const rid = "raw-1"; const on = (ev) => { const m = JSON.parse(String(ev.data)); if (m.type === "reply" && m.id === rid) { bob.ws.removeEventListener("message", on); res(m.reply); } }; bob.ws.addEventListener("message", on); bob.send({ type: "request", id: rid, tool: "remove", args: { id: "cup" } }); });
  ok(vr?.ok === false && readLog(fs.readFileSync(path.join(W4, "garden", "world.jsonl"))).length === headBefore && bob.ws.readyState === 1,
    "S3 an old-style request (a v1 verb message, or a request in the old {tool} spelling with no verb) writes nothing, and the connection stays up", vr); }
{ const { editOps } = await import("../../shared/editschema.js");
  const r = editOps({ pos: [0, 0.75, 0], q: [0, 0, 0, 1], scale: 1, model: "test/cup.glb" }, "cup", { "flags.guard": true });
  ok(!r.ops.length && /merged into `lock`/.test(r.errors.join(" ")), "S3 the old guard flag is refused by name by the shared planner every surface plans with: guard merged into lock (§5)", r); }
ok((await vic.req("create", { id: "vics", model: "test/cup.glb" })).refused?.code === "rights", "S3 a visitor's create is refused (rights)");
ok((await spec.req("create", { id: "x" })).refused?.code === "spectator" && (await spec.req("look")).ok, "S3 a spectator may read, not write");
ok((await bob.req("set", { id: "cup", component: "label", value: "Bob's cup" })).refused?.code === "locked", "S3 a label is lock-guarded too (a lock covers everything, 10-11)");
ok((await bob.req("set", { id: "cup", component: "label", value: "Bob's cup", throughLock: true })).ok, "S3 …and Bob, who may lift it, labels through it");

const u = await bob.req("undo", { throughLock: true });   // the label sits on a locked table: undoing it is an edit too
ok(u.ok && u.after?.[IDS.of("cup")] && u.after[IDS.of("cup")].label === null, "S4 Bob undoes his own last act (the label goes)", u);
// F2 (decided 10-05): revert goes along rank, never upward. A visitor can't undo Bob's act; an owner may (here the
// table's lock still stops it, which is the lock doing its job, not rank)
const u2v = await vic.req("undo", { act: c1.act });
ok(u2v.ok === false && u2v.refused?.code === "rank", "S4 a visitor can't undo someone else's act (rank)", u2v);
const u2 = await ann.req("undo", { act: c1.act });
ok(u2.refused?.code !== "rank", "S4 …an owner may revert it (here only the lock decides)", u2);
const ins = await vic.req("inspect", { id: "cup" });
ok(ins.ok && ins.derived?.madeBy === BOB, "S4 inspect says who made it (a view over the log)", ins);
await sleep(200);
const L = readLog(fs.readFileSync(path.join(W4, "garden", "world.jsonl")));
const st = fold(L);
ok(st.status === "ok" && !st.diagnostics.some(([, k]) => String(k).startsWith("malformed")), "S4 the log on disk reads back strictly", st.diagnostics.slice(0, 3));
ok(L.every((e, i) => i === 0 || e.ts >= L[i - 1].ts) && L.filter((e) => e.kind === "act").length >= 6, "S4 ts never decreases; every write is an act + its result");
ok(L.filter((e) => e.kind === "act").every((e) => [ANN, BOB].includes(e.actor) || (e.actor === VIC && e.body?.refused) || (e.actor === "system" && e.verb === "repair-shapes")), "S4 acts are stamped with the connection's identity, never the payload's (Vic's are his refused attempts, recorded: round-2 R7; the founding's repair-shapes marker is the system's, review r8 M3)", [...new Set(L.map((e) => e.actor))]);
for (const c of [ann, bob, vic, spec]) ok(digest(heldBy(c).st) === digest(st), `S4 what ${c.id} holds (its own fold of what it was sent) = the log on disk (digest)`);
ok([ann, bob, vic].every((c) => c.of("snapshot").length === 1), "S4 no resync was needed (one snapshot each)", [ann, bob, vic].map((c) => c.of("snapshot").length));
{ // the sky (which the v1 projection could only resync for) is just another entry in the stream now
  ok((await ann.req("set", { id: "@world", component: "sky", value: { hours: 18 } })).ok, "S4b Ann sets the sky (owner)"); await sleep(250);
  const t2 = fold(readLog(fs.readFileSync(path.join(W4, "garden", "world.jsonl"))));
  ok([ann, bob, vic].every((c) => c.of("snapshot").length === 1), "S4b no resync: no second snapshot to anyone", [ann, bob, vic].map((c) => c.of("snapshot").length));
  for (const c of [ann, bob, vic]) ok(digest(heldBy(c).st) === digest(t2) && heldBy(c).view().sky?.hours === 18, `S4b …and ${c.id} holds it (its fold = the log, sky included)`); }

// ---- S5: an agent's tools (mcpl/tools.ts) over this connection ----
{ const { HANDLERS } = await import("../../mcpl/tools.ts");
  const { WorldAgent } = await import("../../mcpl/agent.ts");
  // the real MCPL body (mcpl/agent.ts), joined as Bob: its snapshot sets ag.cut, and its request() awaits reply
  const ag: any = new WorldAgent({ url: `ws://127.0.0.1:${srv.port}/ws`, name: "Bob", world: "garden", avatar: "" });
  await ag.connect(); for (let i = 0; i < 40 && !ag.cut; i++) await sleep(50);
  ok(ag.cut?.dialect === "eidoverse-log" && ag.cut?.v === 4, "S5 the MCPL agent learns from its snapshot which log this is and which protocol reads it", ag.cut);
  ag.verb = () => { throw new Error("a world's building tool must not fire-and-forget"); };
  // R 10-17: the agent names what it makes with a placeholder; the reply says the handle and the id it became
  const sp = await HANDLERS.create(ag, { model: "test/cup.glb", place: { at: [2, 2] }, id: "$agentcup" }, {} as any, "create");
  { const m = / id ([a-z2-7]{26})/.exec(sp.content[0].text); if (m) IDS.map.set("agentcup", m[1]); }
  ok(!sp.isError && new RegExp(`created \\[${IDS.of("agentcup").slice(0, 4)}[a-z2-7]*\\]`).test(sp.content[0].text) && /^[a-z2-7]{26}$/.test(IDS.of("agentcup")), "S5 the agent's create waits for the authority and says what it made (its handle and minted id)", sp.content[0].text);
  const rm = await HANDLERS.act(ag, { verb: "delete", args: { id: IDS.of("cup") } }, {} as any, "act");
  ok(rm.isError && /locked/.test(rm.content[0].text), "S5 the agent's act delete of a locked thing comes back as an error naming the lock (PARITY (d)1)", rm.content[0].text);
  const dr = await HANDLERS.act(ag, { verb: "place", args: { id: IDS.of("agentcup"), on: IDS.of("tbl") } }, {} as any, "act");
  ok(!dr.isError && /"ok": true/.test(dr.content[0].text), "S5 the act tool exposes the protocol's vocabulary (relational place)", dr.content[0].text.slice(0, 200));
  const un0 = await HANDLERS.act(ag, { verb: "undo", args: {} }, {} as any, "act");
  ok(un0.isError && /locked/.test(un0.content[0].text), "S5 undoing that place is refused now (the inverse goes through admit: the table is locked)", un0.content[0].text.slice(0, 200));
  await HANDLERS.act(ag, { verb: "set", args: { id: IDS.of("agentcup"), component: "label", value: "mine", throughLock: true } }, {} as any, "act");
  const un = await HANDLERS.act(ag, { verb: "undo", args: { throughLock: true } }, {} as any, "act");
  ok(!un.isError && /"label": null/.test(un.content[0].text), "S5 …and an undo the agent may make goes through (agents had none: PARITY (b)1)", un.content[0].text.slice(0, 200));
  // slice 3c: the agent folds the log stream itself (joined replica), never the v1 projection
  ok(ag.replica?.active === true && ag.entities.has(IDS.of("agentcup")), "S5b the agent folds the authority's own stream, and sees what it made there", [ag.replica?.active, [...ag.entities.keys()]]);
  // R 10-17: the agent names its plank with a placeholder and a label; the set reaches it by that label
  const mk = await HANDLERS.act(ag, { verb: "create", args: { id: "$plank", model: "test/table.glb", components: { label: "plank" }, place: { at: [6, 6] } } }, {} as any, "act");
  for (let i = 0; i < 40 && !("id" in ag.thingRef("plank")); i++) await sleep(50);
  { const t = ag.thingRef("plank"); if ("id" in t) IDS.map.set("plank", t.id); }
  const sc = await HANDLERS.act(ag, { verb: "set", args: { id: "plank", component: "transform", value: { pos: [6, 0, 6], q: [0, 0, 0, 1], scale: [2, 1, 0.5] } } }, {} as any, "act");
  ok(!mk.isError && !sc.isError, "S5b (the agent makes a plank and stretches it)", [mk.content[0].text.slice(0, 160), sc.content[0].text.slice(0, 160)]);
  for (let i = 0; i < 40 && JSON.stringify(ag.entities.get(IDS.of("plank"))?.scale3) !== "[2,1,0.5]"; i++) await sleep(50);
  ok(JSON.stringify(ag.entities.get(IDS.of("plank"))?.scale3) === "[2,1,0.5]", "S5b a stretched thing stays stretched in what the agent holds (the v1 replay flattened it)", ag.entities.get(IDS.of("plank")));
  ok(JSON.stringify(ag.st.entities[IDS.of("plank")]?.scale3) === "[2,1,0.5]", "S5b …and in its view of the world (the record its look/inspect read)", ag.st.entities[IDS.of("plank")]);
  // the world's own keys and chat reach it from the stream too (a v1 world's agent got them as verbs)
  ok((await ann.req("set", { id: "@world", component: "sky", value: { hours: 7 } })).ok && (await ann.req("say", { text: "hello, agent" })).ok, "S5c (Ann sets the sky, then speaks)");
  for (let i = 0; i < 40 && !(ag.skyState?.hours === 7 && ag.inbox.some((m) => m.text === "hello, agent")); i++) await sleep(50);
  ok(ag.skyState?.hours === 7, "S5c the agent's sky follows a world's sky", ag.skyState);
  ok(ag.inbox.some((m) => m.kind === "say" && m.who === "Ann" && m.text === "hello, agent") && ag.st.recentChat?.some((m) => m.text === "hello, agent"), "S5c …and a chat line lands in its inbox and its chat window", [ag.inbox.slice(-2), ag.st.recentChat?.slice(-1)]);
  // the agent's own voice and its reading of the log, with no v1 verb on the wire (3c: the server refuses them now)
  await HANDLERS.say(ag, { text: "hello, Ann" }, {} as any, "say");
  const saidOnDisk = async () => readLog(fs.readFileSync(path.join(W4, "garden", "world.jsonl"))).some((e) => e.kind === "say" && e.actor === BOB && e.body?.text === "hello, Ann");
  for (let i = 0; i < 40 && !(await saidOnDisk()); i++) await sleep(50);
  ok(await saidOnDisk(), "S5d the agent's say reaches a world's log (as a request, spelled by the agent)");
  const wh = await HANDLERS.world_history(ag, { limit: 20 }, {} as any, "world_history");
  ok(!wh.isError && /Bob: set /.test(wh.content[0].text) && /say "hello, Ann"|hello, Ann/.test(wh.content[0].text), "S5d world_history in a world reads the log (acts and says), not v1's chat-only history", wh.content[0].text.slice(0, 400));
  // S5e: the agent at a thing's sockets (shared/sockbody.js): look says what each does; sit picks by action/slot, asks
  // the authority (who), and keeps to how the seat lets you go (leaveBy) and whether it takes you from another (fromSeat)
  ok((await ann.req("create", { id: "carriage", model: "test/table.glb", place: { at: [9, 9] }, components: { sockets: {
    throne: { pos: [0, 0.5, 0], body: { who: "owner" } },
    box: { pos: [0.6, 0.5, 0], body: { action: "drive", leaveBy: "script" } },
    rumble: { pos: [-0.6, 0.5, 0], body: { action: "ride", leaveBy: "menu" } } } } })).ok, "S5e (Ann builds a carriage: an owner's throne, a driver's box that holds you, a rumble seat)");
  // its seats are socket children (PLAN-sockets-entities: the map is lifted at the door): wait for all three
  for (let i = 0; i < 40 && ag.socketsOf(IDS.of("carriage")).length < 3; i++) await sleep(50);
  const seatId = (n: string) => ag.socketsOf(IDS.of("carriage")).find((x: any) => x.name === n)?.id;
  const lk = (await HANDLERS.look(ag, {}, {} as any, "look")).content[0].text;
  ok(/box: drive \(.*lets you go when the world does \(hold X to get up anyway\)/.test(lk) && /throne: sit \([^·]*owners only/.test(lk), "S5e look says what each seat does (box holds you; the throne is owners only)", lk.split("\n").filter((l) => /carriage/.test(l)));
  // grabbable (slice 5): look says what a hand may do with a thing, the authority's own reading (shared/grab.js describeGrab)
  ok((await ann.req("create", { id: "lantern", model: "test/cup.glb", place: { at: [9, 7] }, components: { grabbable: { who: "visitor", use: { down: "light" }, release: "return", prompt: "Take the lantern" } } })).ok, "S5g (Ann makes a lantern anyone may carry)");
  for (let i = 0; i < 40 && !ag.entities.get(IDS.of("lantern"))?.grabbable; i++) await sleep(50);
  const lk2 = (await HANDLERS.look(ag, {}, {} as any, "look")).content[0].text;
  const lh = ag.handle(IDS.of("lantern"));   // look reads a thing by its handle (R 10-17)
  ok(lk2.split("\n").some((l) => l.includes(`[${lh}]`) && /Take the lantern \(anyone may pick it up;[^\n]*use while held: light;[^\n]*goes home when let go\)/.test(l) && l.includes(`act {verb: "grab", args: {id: "${lh}"}}`)), "S5g look says a grabbable thing can be picked up, by whom, what using it does and where it goes", lk2.split("\n").filter((l) => /lantern/.test(l)));
  ok(["throne", "box", "rumble"].every((n) => !!seatId(n) && !lk.includes(seatId(n)!)) && /Things \(\d+\)/.test(lk), "S5e look lists the seats under the carriage by name, never as things of their own (nor as things it carries)", lk.split("\n").filter((l) => /carriage|empty|throne/.test(l)));
  const thId = await HANDLERS.attach(ag, { to: seatId("throne") }, {} as any, "attach");
  ok(thId.isError && /rights/.test(thId.content[0].text) && !ag.myOccupancy, "S5e attach takes a socket's own id too (the throne's: the authority still refuses a builder)", thId.content[0].text);
  const th = await HANDLERS.attach(ag, { to: IDS.of("carriage"), socket: "throne" }, {} as any, "attach");
  ok(th.isError && /rights/.test(th.content[0].text) && !ag.myOccupancy, "S5e attach to the owner's throne: the authority refuses a builder", th.content[0].text);
  const dv = await HANDLERS.attach(ag, { to: IDS.of("carriage"), action: "drive" }, {} as any, "attach");
  ok(!dv.isError && !!seatId("box") && ag.myOccupancy?.to === seatId("box"), "S5e attach {action: 'drive'} picks the driver's box (my seat is its socket child)", [dv.content[0].text, ag.myOccupancy]);
  const up = await HANDLERS.detach(ag, {}, {} as any, "detach"), wk = await HANDLERS.move(ag, { to: [0, 0, 0] }, {} as any, "move");
  ok(up.isError && wk.isError && ag.myOccupancy?.to === seatId("box"), "S5e …it holds you (leaveBy script): neither detaching nor walking gets you off", [up.content[0].text, wk.content[0].text]);
  const hop = await HANDLERS.attach(ag, { to: IDS.of("carriage"), socket: "rumble" }, {} as any, "attach");
  ok(hop.isError && /from another seat/.test(hop.content[0].text) && ag.myOccupancy?.to === seatId("box"), "S5e …and the rumble seat doesn't take you straight from another (no fromSeat)", hop.content[0].text);
  ag.close(); }

// (Bob's own socket was taken over by S5's agent, which joined as Bob: Vic and the watcher are the bystanders here)
// ---- CM: the Commons parity audit (old world → new) (10-06): moderation people can see, names not ids, a name → identity lookup,
// refusals in the flight recorder, the agent's history and look in door terms, a join and a chat line without dead weight ----
{ const { HANDLERS, historyLine } = await import("../../mcpl/tools.ts");
  const { WorldAgent } = await import("../../mcpl/agent.ts");
  const wait = async (f: () => any, ms = 3000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (f()) return true; await sleep(50); } return false; };
  const T = (r: any) => r?.content?.[0]?.text ?? "";
  // CM1 a kick: bystanders are told who removed whom (names), never the reason; the person removed is told the reason
  const kim = await client(srv.port, "garden", "Kim", REPLICA); await sleep(150); const KIM = kim.snapshot?.cut?.you;
  const nB = vic.of("moderated").length; const nS = spec.of("moderated").length;
  ok((await ann.req("kick", { who: KIM, reason: "the secret reason" })).ok, "CM1 (Ann kicks Kim, with a reason)");
  await wait(() => vic.of("moderated").length > nB && spec.of("moderated").length > nS && kim.of("error").length);   // both bystanders, not just vic (raced under load, 10-07)
  const ml = vic.of("moderated").at(-1);
  ok(ml?.text === "Ann removed Kim from this world" && spec.of("moderated").at(-1)?.text === ml?.text, "CM1 bystanders see \"Ann removed Kim\" (v1 showed it; the port told nobody)", vic.of("moderated").slice(nB));
  ok(!/secret/.test(JSON.stringify([...vic.msgs, ...ann.msgs, ...spec.msgs].filter((m) => m.type === "moderated"))) && /secret reason/.test(kim.of("error").at(-1)?.error ?? "") && !kim.of("moderated").length,
    "CM1 …not the reason (that's the person's, and the moderator log's); the person removed gets it, and no bystander line", kim.of("error").at(-1));
  // …and a kick the authority accepts for someone who isn't here (a raw id: the agent skips whois for one) tells nobody anything
  const nK = vic.of("moderated").length;
  ok((await ann.req("kick", { who: KIM })).ok, "CM1 (Ann kicks Kim again, though Kim has gone)"); await sleep(250);
  ok(vic.of("moderated").length === nK, "CM1 …nobody is told \"Ann removed Kim\" when nobody was removed", vic.of("moderated").slice(nK));
  // CM2 role narration names the person: a role written for someone who never acted here carries their name to clients
  const nv = vic.of("log").length;
  ok((await ann.req("set", { id: "@world", component: `roles:${KIM}`, value: { role: "builder" } })).ok, "CM2 (Ann makes the absent Kim a builder)");
  await wait(() => vic.of("log").length > nv);
  ok(vic.of("log").slice(nv).some((m) => m.names?.[KIM] === "Kim"), "CM2 the log that carries a role for someone who never acted names them (narration said \"made u-…\")", vic.of("log").slice(nv).map((m) => m.names));
  // CM3 whois: a name → identity, scoped to this world; the authority's role; here or not
  const zed = await client(srv.port, "garden", "Zed", REPLICA); await zed.req("say", { text: "hi, I'm Zed" }); const ZED = zed.snapshot?.cut?.you; zed.close(); await sleep(200);
  const wz = await vic.req("whois", { name: "zed" });
  ok(wz.ok && wz.people?.length === 1 && wz.people[0].id === ZED && wz.people[0].here === false && wz.people[0].role === "visitor" && !("kind" in wz.people[0]) && !JSON.stringify(wz).includes("local:"),
    "CM3 whois finds someone absent by name (case-folded): their identity, role, not here, and never their account", wz);
  // ---- DR: a live drag is relayed with who is dragging, and its last sample says end (docs/WIRE.md: a live drag is a claim) ----
  { const da = await client(srv.port, "garden", "Dana", REPLICA); const db = await client(srv.port, "garden", "Dev", REPLICA);
    await ann.req("set", { id: "@world", component: "default-role", value: { role: "builder" } });
    const mk = await da.req("create", { id: "drg", model: "test/cup.glb", place: { at: [2, 2] } });
    const k0 = db.msgs.length; da.send({ type: "drag", id: IDS.of("drg"), pos: [2.5, 0, 2], yaw: 0 }); await sleep(300); da.send({ type: "drag", id: IDS.of("drg"), pos: [3, 0, 2], yaw: 0, end: true }); await sleep(400);
    const got = db.msgs.slice(k0).filter((m) => m.type === "drag" && m.id === IDS.of("drg"));
    ok(mk?.ok && got.length === 2 && got[0].by === "Dana" && !got[0].end && got[1].by === "Dana" && got[1].end === true, "DR1 a drag reaches the others with by (the dragger's name) and its last sample carries end", { mk: mk?.ok, got });
    await ann.req("delete", { id: "@world", component: "default-role" });   // back to the world as the later checks expect it
    da.close(); db.close(); await sleep(200); }
  // ---- RN: the rename cooldown is judged on the name a person will actually wear (STRIKES P-S2-5) ----
  { const z1 = await client(srv.port, "garden", "zeph", { ...REPLICA, account: "acct-zp" }); const n1 = z1.snapshot?.you; z1.close(); await sleep(200);
    const z2 = await client(srv.port, "garden", "zeph-two", { ...REPLICA, account: "acct-zp" }); const n2 = z2.snapshot?.you, r2 = z2.snapshot?.renameRefused; z2.close(); await sleep(200);
    const z3 = await client(srv.port, "garden", "zeph-three", { ...REPLICA, account: "acct-zp" }); const n3 = z3.snapshot?.you, r3 = z3.snapshot?.renameRefused;
    ok(n1 === "zeph" && n2 === "zeph-two" && !r2 && n3 === "zeph-two" && r3?.tried === "zeph-three", "RN1 one rename is free; a second inside the cooldown is refused and the last name stands", { n1, n2, r2, n3, r3, e1: z1.of("error")[0], e2: z2.of("error")[0], e3: z3.of("error")[0] });
    // the trap: an account that typed a TAKEN name got a suffixed one it never asked for; that must not start its cooldown
    const y1 = await client(srv.port, "garden", "yan", { ...REPLICA, account: "acct-y" }); const m1 = y1.snapshot?.you; y1.close(); await sleep(200);
    const y2 = await client(srv.port, "garden", "zeph-two", { ...REPLICA, account: "acct-y" }); const m2 = y2.snapshot?.you, q2 = y2.snapshot?.renameRefused; y2.close(); await sleep(200);
    const y3 = await client(srv.port, "garden", "yan", { ...REPLICA, account: "acct-y" }); const m3 = y3.snapshot?.you, q3 = y3.snapshot?.renameRefused;
    ok(m1 === "yan" && m2 !== "zeph-two" && /^zeph-two/.test(String(m2)) && !q2, "RN2 a taken name is suffixed for the newcomer (zeph-two is worn by another account)", { m1, m2, q2 });
    ok(m3 === "yan" && !q3, "RN3 …and going back to their own name is not refused: the suffixed name was never their choice, so it started no cooldown", { m3, q3 });
    z3.close(); y3.close(); await sleep(200);
    // the same account re-arriving under a new name is a takeover: the old socket's later close must not depart the body
    const t1 = await client(srv.port, "garden", "tango", { ...REPLICA, account: "acct-tk" }); await t1.req("move", { to: [1, 0, 1] });
    const t2 = await client(srv.port, "garden", "tango-two", { ...REPLICA, account: "acct-tk" }); const mv = await t2.req("move", { to: [1.2, 0, 1] });
    t1.close(); await sleep(500);
    const after = await t2.req("punt", { id: "no-such-thing" });
    ok(t2.snapshot?.you === "tango-two" && mv?.ok && after?.refused?.code !== "not-here", "RN4 a rename reconnect is a takeover: when the old socket closes, the body is still in the world", { you: t2.snapshot?.you, mv: mv?.refused, after: after?.refused });
    t2.close(); await sleep(200); }
  const wa = await vic.req("whois", { name: "Ann" }), wk = await vic.req("whois", { name: KIM });
  ok(wa.people?.[0]?.role === "owner" && wa.people[0].here === true && wk.people?.[0]?.name === "Kim" && wk.people[0].role === "builder", "CM3 …the authority's role (an owner reads as owner, not v1's visitor), and an identity works as the name", [wa, wk]);
  const ww = await vic.req("whois", { name: "Watcher" });
  ok(ww.ok && ww.people.length === 0 && /has been in this world/.test(ww.note ?? ""), "CM3 …scoped to this world: a spectator who never acted here, in the authority's directory all the same, isn't found", ww);
  ok((await spec.req("whois", { name: "Ann" })).ok, "CM3 …a spectator may ask (it's a read)");
  ok((await vic.req("whois", { name: "🙂" })).refused?.code === "shape", "CM3 …a name with no letters or digits is refused (it folded to \"\" and matched everyone whose name did too)");
  ok(tool(["found", "elsewhere", "--owner", "Una"]).code === 0, "CM3 (a second world, founded by Una, who has never been in this one)");
  { const una = await client(srv.port, "elsewhere", "Una", REPLICA); await una.req("say", { text: "only here" }); una.close(); }
  const wu = await vic.req("whois", { name: "Una" });
  ok(wu.ok && wu.people.length === 0, "CM3 …someone who acted only in another world on this server isn't found from this one", wu);
  // CM4 an agent owner bans an absent person by name, and lifts it; bystanders are told; a kick of someone absent says so
  const oz: any = new WorldAgent({ url: `ws://127.0.0.1:${srv.port}/ws`, name: "Oz", world: "garden", avatar: "" });
  await oz.connect(); for (let i = 0; i < 40 && !oz.replica?.active; i++) await sleep(50);
  ok((await ann.req("set", { id: "@world", component: `roles:${oz.replica?.you}`, value: { role: "owner" } })).ok, "CM4 (Ann makes the agent Oz an owner)");
  const nb2 = vic.of("moderated").length;
  const ban = await HANDLERS.act(oz, { verb: "ban", args: { who: "Zed", reason: "test" } }, {} as any, "act");   // moderation rides act, by name (10-14)
  ok(!ban.isError && /done/.test(T(ban)), "CM4 the agent bans Zed, who isn't here, by name (it needed a u-… id it had no way to find)", T(ban));
  const back = await client(srv.port, "garden", "Zed", REPLICA);
  ok(!back.snapshot && back.of("error").some((m) => /banned/.test(m.error)), "CM4 …and Zed can't come back", back.msgs.map((m) => m.type)); back.close();
  await wait(() => vic.of("moderated").length > nb2);
  ok(vic.of("moderated").at(-1)?.text === "Oz banned Zed from this world", "CM4 …bystanders were told", vic.of("moderated").slice(nb2));
  const wi = HANDLERS.whois ? await HANDLERS.whois(oz, { name: "zed" }, {} as any, "whois") : { isError: true, content: [{ type: "text", text: "(no whois tool)" }] };
  ok(!wi.isError && new RegExp(`${ZED}: visitor here, not here, BANNED`).test(T(wi)), "CM4 the agent's whois tool reads it back", T(wi));
  const kk = await HANDLERS.act(oz, { verb: "kick", args: { who: "Zed" } }, {} as any, "act");
  ok(kk.isError && /isn't here/.test(T(kk)), "CM4 kicking someone absent says they aren't here", T(kk));
  const ub = await HANDLERS.act(oz, { verb: "unban", args: { who: "Zed" } }, {} as any, "act");
  ok(!ub.isError && await wait(() => vic.of("moderated").some((m) => m.text === "Oz lifted the ban on Zed")), "CM4 …and unban by name works, told to bystanders", [T(ub), vic.of("moderated").slice(-2)]);
  const nU = vic.of("moderated").length; ok(!(await HANDLERS.act(oz, { verb: "unban", args: { who: "Zed" } }, {} as any, "act")).isError, "CM4 (Oz unbans Zed again)"); await sleep(250);
  ok(vic.of("moderated").length === nU, "CM4 …a second unban changes nothing, and tells nobody anything", vic.of("moderated").slice(nU));
  // CM5 a refusal reaches the flight recorder (world_debug, /debug), with the authority's reason
  await vic.req("create", { id: "vics2", model: "test/cup.glb" });
  const dbg = await new Promise<any>((res) => { const id = "dbg1"; const on = (ev: any) => { const m = JSON.parse(String(ev.data)); if (m.type === "debug" && m.reqId === id) { vic.ws.removeEventListener("message", on); res(m); } }; vic.ws.addEventListener("message", on); vic.send({ type: "debug", reqId: id, limit: 50 }); setTimeout(() => res({ events: [], timeout: true }), 5000); });
  const rv = dbg.events?.filter((e: any) => e.kind === "refused" && e.who === "Vic" && e.code === "rights").at(-1);
  ok(rv && /Vic's create \$?vics2 was refused \(rights\)/.test(rv.line), "CM5 a refused request is in the flight recorder, in words (world_debug only had raw verb lines)", dbg.events?.slice(-3));
  // bounded: a shape refusal quotes what was sent; a megabyte of it mustn't sit in the ring (or go to everyone who asks)
  await vic.req("history", { limit: "x".repeat(200_000) });
  const dbg2 = await new Promise<any>((res) => { const id = "dbg2"; const on = (ev: any) => { const m = JSON.parse(String(ev.data)); if (m.type === "debug" && m.reqId === id) { vic.ws.removeEventListener("message", on); res(m); } }; vic.ws.addEventListener("message", on); vic.send({ type: "debug", reqId: id, limit: 50 }); setTimeout(() => res({ events: [], timeout: true }), 5000); });
  const big = dbg2.events?.filter((e: any) => e.kind === "refused" && e.verb === "history").at(-1);
  ok(big && JSON.stringify(big).length < 600 && /…$/.test(big.line), "CM5 a refusal quoting 200 KB is recorded in under 600 bytes", big ? JSON.stringify(big).length : dbg2.events?.slice(-2));
  const wd = await HANDLERS.world_debug(oz, { kinds: ["refused"] }, {} as any, "world_debug");
  ok(/Vic's create \$?vics2 was refused \(rights\)/.test(T(wd)), "CM5 …and the agent's world_debug reads it", T(wd).slice(0, 300));
  // CM6 the agent's history: verbs and before reach the authority; a refused attempt reads REFUSED; a v1 entry its own verb
  const wh = await HANDLERS.world_history(oz, { verbs: ["say"], limit: 3 }, {} as any, "world_history");
  ok(!wh.isError && /Zed: say "hi, I'm Zed"/.test(T(wh)) && T(wh).split("\n").filter((l) => /^#\d+/.test(l)).every((l) => / say /.test(l)), "CM6 world_history {verbs: ['say']} returns only says (verbs never reached the authority)", T(wh));
  const whc = await HANDLERS.world_history(oz, { verbs: ["create"], limit: 50 }, {} as any, "world_history");
  ok(/Vic: tried create .*REFUSED \(rights\); nothing changed/.test(T(whc)) && !/Vic: create /.test(T(whc)), "CM6 a refused create reads as refused, not as a create", T(whc).slice(-500));
  const first = Number(/#(\d+)/.exec(T(wh))?.[1]);
  const whb = await HANDLERS.world_history(oz, { limit: 2, before: first }, {} as any, "world_history");
  ok(T(whb).split("\n").filter((l) => /^#\d+/.test(l)).every((l) => Number(/#(\d+)/.exec(l)[1]) < first) && /more before #/.test(T(whb)), "CM6 before pages back (it was ignored)", T(whb));
  ok(typeof historyLine === "function" && historyLine({ seq: 9, ts: 0, actor: "ann", kind: "act", verb: "imported", body: { verb: "comp", args: { id: "x", type: "label", data: "old" }, from: 4 } }) === `#9 ann: comp {"id":"x","type":"label","data":"old"} (imported from the old log, #4)`, "CM6 an imported entry prints the verb and args it was written with, not `legacy {}`");
  // CM7 look speaks door terms: no world_verb, no comp {…}, no dismount
  ok((await ann.req("create", { id: "bell", model: "test/cup.glb", components: { reactions: { ring: { kind: "set", component: "label", value: "rung" } }, lock: true }, place: { at: [3, 3] } })).ok, "CM7 (Ann makes a bell that rings, locked)");
  await wait(() => oz.entities.has(IDS.of("bell")));
  const lk = oz.look();
  ok(!/world_verb|comp \{|dismount|mount \{/.test(lk) && /act \{verb: "use"/.test(lk) && /attach \{to: id/.test(lk) && /throughLock/.test(lk), "CM7 look teaches act {verb: use}, the attach tool and how a lock is lifted (it taught world_verb, which is gone)", lk.split("\n").filter((l) => /bell|use a thing|locked/.test(l)));
  // CM8 the agent's say: a spoken say keeps its trio on disk; a refused say is an error, not "said"
  const sp = await HANDLERS.say(oz, { text: "spoken line", spoken: true, utt: 11 }, {} as any, "say");
  await sleep(200);
  const spk = readLog(fs.readFileSync(path.join(W4, "garden", "world.jsonl"))).filter((e: any) => e.kind === "say" && e.body?.text === "spoken line").at(-1);
  ok(!sp.isError && spk?.body?.spoken === true && spk.body.utt === 11, "CM8 the agent's spoken say reaches the log with spoken/utt (the port dropped them)", spk?.body);
  let lastSay: any = null; for (let i = 0; i < 25 && !lastSay?.isError; i++) lastSay = await HANDLERS.say(oz, { text: `flood ${i}` }, {} as any, "say");
  ok(lastSay?.isError && /rate|too many|slow/i.test(T(lastSay)), "CM8 a say refused by the rate limit comes back as an error in words (it said \"said\")", T(lastSay));
  oz.close();
  // CM9 the join and a chat line, without dead weight
  const st0 = ann.snapshot?.state ?? {};
  ok(JSON.stringify(Object.keys(st0).sort()) === '["chatTotal","recentChat"]' && ann.snapshot?.cut?.state?.["@world"], "CM9 a log-folding joiner's snapshot carries the chat window beside the cut, not a second, v1-shaped copy of the world", Object.keys(st0));
  const nl = vic.of("log").length; const raw: string[] = []; const on = (ev: any) => { if (String(ev.data).includes('"log"')) raw.push(String(ev.data)); }; vic.ws.addEventListener("message", on);
  ok((await ann.req("say", { text: "hi" })).ok, "CM9 (Ann says hi)"); await wait(() => vic.of("log").length > nl); vic.ws.removeEventListener("message", on);
  const line = raw.find((d) => d.includes('"text":"hi"')) ?? ""; const e0 = JSON.parse(line || "{}").entries?.[0] ?? {};
  ok(line.length > 0 && line.length < 200 && !("sig" in e0) && !("head" in e0) && !("world" in e0) && !("salt" in (e0.body ?? {})), "CM9 a two-character say is under 200 bytes on the wire (488: the chain's world, head, sig and salt rode every line, unread)", [line.length, line]);
  ok(heldBy(vic) && digest(heldBy(vic).st) === digest(fold(readLog(fs.readFileSync(path.join(W4, "garden", "world.jsonl"))))), "CM9 …and what Vic folds from the slimmer stream is still the log on disk (digest)"); }

// ---- S6: translate a v1 world into a new world ----
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
  // the approval is bound to the dry run's report hash (review of PR #260 item 6): the dry run first, nothing written
  const dry = tool(["translate", "oldtown", "oldtown-new", "--dry-run", "--no-founder-key"]); const hash = /^report-hash ([0-9a-f]{64})$/m.exec(dry.out)?.[1] ?? "no-hash";
  ok(dry.code === 0 && hash !== "no-hash" && !fs.existsSync(path.join(W4, "oldtown-new")), "S6 the dry run prints the report hash and writes nothing", dry.out.slice(-300));
  const tr = tool(["translate", "oldtown", "oldtown-new", "--no-founder-key", "--approved", hash, "--operator-only-no-owner"]);   // a test world: tier 0 left empty, knowingly (§13); no owner can sign, said so (§14)
  ok(tr.code === 0 && /0 divergences/.test(tr.out) && /mtime unchanged: true/.test(tr.out) && /approved by the operator/.test(tr.out), "S6 translate, approved, writes a new world and reports 0 divergences", tr.out);
  ok(Buffer.compare(before, fs.readFileSync(v1log)) === 0, "S6 the v1 log's bytes are unchanged (R9)");
  const [g, t1] = fs.readFileSync(path.join(W4, "oldtown-new", "world.jsonl"), "utf8").split("\n").slice(0, 2).map((l) => JSON.parse(l));
  ok(g.body.minor === 0 && typeof g.body.nonce === "string" && /^ed25519:/.test(g.body.sequencer) && !("translatedFrom" in g.body), "S6 genesis is §2.4's (minor, nonce, sequencer; no translatedFrom)", g.body);
  ok(t1.verb === "translated" && /^eidoverse\/translate-v1@/.test(t1.body.from?.translator) && /^[0-9a-f]{16}$/.test(t1.body.from?.fold), "S6 the act after genesis names the engine translator and the v1 fold build", t1.body);
  ok(tool(["translate", "oldtown", "oldtown-new"]).code !== 0, "S6 translating onto an existing world is refused");
  // the old world as the old fold reads its log (the translator's own reader; nothing serves v1 any more) vs the new copy
  const { emptyState: v1Empty, foldEntry: v1Fold } = await import("./import-v1/fold.js");
  const v1st = v1Empty(); for (const l of fs.readFileSync(v1log, "utf8").split("\n").filter(Boolean)) v1Fold(v1st, JSON.parse(l));
  // v1's mount names its socket `slot`; today's (and shared/hierarchy.js, the renderer's reading) `socket`
  const v1Translated = (st: any) => ({ ...st, entities: Object.fromEntries(Object.entries<any>(st.entities).map(([id, e]) => [id, e.parent && "slot" in e.parent ? { ...e, parent: (({ slot, ...p }) => ({ ...p, socket: slot }))(e.parent) } : e])) });
  const old = { snapshot: { state: v1Translated(v1st) } }, neu = await client(srv.port, "oldtown-new", "Ann", REPLICA);
  const oldv1 = await client(srv.port, "oldtown", "Ann");
  for (let i = 0; i < 40 && oldv1.ws.readyState !== 3; i++) await sleep(50);
  const OLD_SAY = `"oldtown" was saved by an older version of Eidoverse and needs a one-time conversion by whoever runs this server. Nothing is lost — the world's log is kept as it was.`;
  ok(!oldv1.snapshot && oldv1.of("error").some((m) => m.error === OLD_SAY) && oldv1.ws.readyState === 3, "S6 the server doesn't serve the old world itself: the visitor is told, in plain words, that it needs a one-time conversion and nothing is lost (owner 10-15)", oldv1.msgs.map((m) => m.type === "error" ? m.error : m.type));
  ok(oldv1.of("error").every((m) => !/\bbun\b|tools\/|world\.ts/.test(m.error)), "S6 …with no command line a visitor can't run", oldv1.of("error").map((m) => m.error)); oldv1.close();
  { const { WorldAgent } = await import("../../mcpl/agent.ts");   // an agent is told the same, as its join's error (not a join timeout)
    const ag: any = new WorldAgent({ url: `ws://127.0.0.1:${srv.port}/ws`, name: "Bob", world: "oldtown", avatar: "" });
    let why = ""; try { await ag.connect(); } catch (e) { why = String((e as Error).message); } try { ag.close(); } catch {}
    // the world's words as the cause inside the agent's own sentence (upstream #247: "the world refused the join: …")
    ok(why === `the world refused the join: ${OLD_SAY.replace(/\.+$/, "")}`, "S6 an agent joining the old world is refused with the same words (its connect rejects with them; mcpl travel reports them)", why); }
  // a log of this protocol's family saved before the 2026-10-07 names pass: its genesis stated its number in its own field
  ok(tool(["found", "prenamed", "--owner", "Ann"]).code === 0, "S6 a world to age into a pre-names one");
  { const fp = path.join(W4, "prenamed", "world.jsonl"); const lines = fs.readFileSync(fp, "utf8").split("\n");
    const g = JSON.parse(lines[0]); const { v, ...rest } = g.body; g.body = { ...rest, version: v }; lines[0] = JSON.stringify(g); fs.writeFileSync(fp, lines.join("\n")); }
  const pre = await client(srv.port, "prenamed", "Ann", REPLICA); for (let i = 0; i < 40 && pre.ws.readyState !== 3; i++) await sleep(50);
  const preSay = pre.of("error").at(-1)?.error ?? "";
  ok(!pre.snapshot && /^"prenamed" /.test(preSay) && /whoever runs this server/.test(preSay) && /kept as it was/.test(preSay) && !/\bbun\b|tools\/|world\.ts|translate /.test(preSay) && preSay !== OLD_SAY.replace("oldtown", "prenamed"),
    "S6 a pre-names world is refused in its own plain words (no command line)", preSay); pre.close();
  fs.mkdirSync(path.join(W4, "hollow"));   // a directory with no log in it: no world, not an old one
  const hol = await client(srv.port, "hollow", "Ann", REPLICA);
  ok(!hol.snapshot && /no world called "hollow"/.test(hol.of("error").at(-1)?.error ?? ""), "S6 an empty directory is no world (it was told it was an old-format one)", hol.of("error").map((m) => m.error)); hol.close();
  // what a person SEES: each thing's world pose as the renderer composes it (shared/hierarchy.js). A riding thing's own
  // v1 pos is its unused pre-mount pose, so comparing raw `pos` would compare a hidden field (translate-v1@2 DROPPED)
  const r6 = (v) => v.map((n) => Math.round(n * 1e6) / 1e6);
  // (since sockets are entities, the served world is lifted at its first load: a thing at a socket rides that socket's child,
  // so "at a socket" reads as the host and the child's name; the socket child itself is no thing of v1's)
  const E = (s) => Object.fromEntries(Object.entries(s.entities).filter(([, e]) => !e?.socket).map(([id, e]) => { const p = worldPose(s.entities, id);
    const via = s.entities[e.parent?.to]?.socket ? s.entities[e.parent.to] : null;
    return [id, { model: e.model, at: r6(p.pos), q: r6(p.q), label: e?.label, parent: via ? via.parent?.to : e.parent?.to, socket: via ? via.socket.name : e.parent?.socket }]; }));
  const neuView = viewState(stateFromWire(neu.snapshot.cut.state));   // what the page draws: the view of its own fold of the cut
  // the old server's records keep the old spelling (lib, comp.*): lift them to today's flat record so worldPose reads both sides the same way
  const lift = (s) => ({ ...s, entities: Object.fromEntries(Object.entries(s.entities).map(([id, e]) => { const { comp, lib, ...rest } = e; return [id, { ...rest, ...(lib !== undefined ? { model: lib } : {}), ...(comp ?? {}) }]; })) });
  ok(JSON.stringify(E(lift(old.snapshot.state))) === JSON.stringify(E(neuView)), "S6 the new copy shows the same things to today's client, where they are (mounted at an offset and at a socket)", [E(lift(old.snapshot.state)), E(neuView)]);
  const replica = fold(readLog(fs.readFileSync(path.join(W4, "oldtown-new", "world.jsonl")))).entities;
  const seatC = replica[replica[enc("mug_1")].c.parent?.to]?.c;
  ok(seatC?.socket?.name === "seat" && seatC.parent?.to === enc("lamp_1") && JSON.stringify(seatC.transform.pos) === "[0.3,0.75,0.1]" && !("socket" in replica[enc("mug_1")].c.parent) && replica[enc("mug_1")].c.transform.pos.every((v) => Math.abs(v) < 1e-9),
    "S6 a translated mount is in the authority's shape once the world is loaded: the socket is lamp_1's child at the socket's pos, and the mug rides it (parent {to: <the socket>}, at its origin)", [replica[enc("mug_1")].c.parent, replica[enc("mug_1")].c.transform, seatC]);
  ok(neu.snapshot.cut?.dialect === "eidoverse-log" && neu.snapshot.cut?.v === 4 && neu.snapshot.yourRights?.role === "owner" && !old.snapshot.cut, "S6 the new copy says {dialect, v}, and Ann still owns it (the original log is read only by the translator)", [neu.snapshot.yourRights, old.snapshot.cut]);
  { const h = await neu.req("history", { verbs: ["say"], limit: 50 });   // arrival-only (R 10-18): no window on join; the owner reads the master log
    ok(JSON.stringify(neu.snapshot.state.recentChat) === "[]" && (h.entries ?? []).some((e: any) => e.body?.text === "hello from v1"), "S6 the chat comes across into the log (its owner reads it back; nobody's join replays it)", [neu.snapshot.state.recentChat, (h.entries ?? []).length]); }
  const ed = await neu.req("set", { id: enc("lamp_1"), component: "label", value: "the new table" });
  ok(ed.ok, "S6 the translated world takes edits from its owner", ed);
  void old; neu.close(); }

// ---- S8: clients that fold the log themselves (slice 3b): the cut at join, the log stream, no projection ----
{ ok(tool(["found", "meadow", "--owner", "Ann"]).code === 0, "S8 found a second world");
  const a = await client(srv.port, "meadow", "Ann", { replica: true });
  ok(a.snapshot?.cut?.state?.["@world"] && Number.isInteger(a.snapshot.cut.head) && Array.isArray(a.snapshot.cut.mine), "S8 a log-folding client's snapshot carries the fold, its head and my undoable acts", Object.keys(a.snapshot?.cut ?? {}));
  const bv = await client(srv.port, "meadow", "Bob", { replica: true }); // Bob folds the log too: nobody reads the projection
  ok(bv.snapshot?.yourRights?.role === "visitor", "S8 Bob arrives a visitor", bv.snapshot?.yourRights);
  const r1 = await a.req("create", { id: "box", model: "test/table.glb", place: { at: [1, 1] } });
  ok((await a.req("set", { id: "@world", component: `roles:${bv.snapshot?.cut?.you}`, value: { role: "builder" } })).ok, "S8 Ann makes Bob a builder");
  await sleep(200);
  ok(bv.of("your-rights").at(-1)?.rights?.role === "builder", "S8 …and Bob is told at once (the authority's role, not v1's stranger default)", bv.of("your-rights").map((m) => m.rights?.role));
  { const g = await fetch(`http://127.0.0.1:${srv.port}/geom?world=meadow&id=${IDS.of("box")}`, { signal: AbortSignal.timeout(3000) });
    ok(g.status === 200, "S8 an HTTP reader of the world's view (/geom) sees a thing just made (the view is rebuilt for its reader, never stale)", g.status); }
  bv.close();
  ok(r1.ok && a.of("log").length >= 2 && a.of("log").every((m: any) => Array.isArray(m.entries) && m.entries.every((e: any) => typeof e.kind === "string" && typeof e.verb === "string" && !("args" in e))), "S8 it gets the log stream, entries only", a.of("log").length);
  const c = makeReplica(); c.adopt(a.snapshot.cut);
  for (const m of a.of("log")) c.ingest(m.entries, m.from);
  const disk = fold(readLog(fs.readFileSync(path.join(W4, "meadow", "world.jsonl"))));
  ok(digest(c.st) === digest(disk), "S8 its own fold of the stream = the log on disk (digest)");
  // a client that doesn't fold the log (an old page, an old agent build) is refused, with the reason, and isn't redialed (4005)
  const b = await client(srv.port, "meadow", "Bob");
  for (let i = 0; i < 40 && b.ws.readyState !== 3; i++) await sleep(50);
  ok(!b.snapshot && /needs a client that folds its log/.test(b.of("error").at(-1)?.error ?? "") && b.ws.readyState === 3, "S8 a joiner that doesn't fold the log is refused, told why, and closed", [b.of("error").at(-1), b.ws.readyState]);
  const r2 = await a.req("set", { id: "box", component: "label", value: "after the refusal" }); await sleep(200);
  ok(r2.ok && a.of("log").every((m: any) => Array.isArray(m.entries) && m.entries.every((e: any) => typeof e.kind === "string" && typeof e.verb === "string" && !("args" in e))), "S8 …and the world carries on, still sending only entries", a.of("log").length);
  ok(a.snapshot.cut.mine.length === 0 && (await client(srv.port, "meadow", "Ann", { replica: true })).snapshot.cut.mine.includes(r2.act), "S8 a rejoin's undo stack holds my acts (Ctrl+Z survives a reload)");
  a.close(); }
// ---- SP: physics at the server (design 20): who holds what is sent to everyone; a joiner's cut carries it and the sim;
// a person who leaves while holding something drops it into the world ----
{ ok(tool(["found", "pitch", "--owner", "Ann"]).code === 0, "SP found a physics world");
  const a = await client(srv.port, "pitch", "Ann", REPLICA); await sleep(100);
  ok((await a.req("set", { id: "@world", component: "physics-engine", value: { engine: "eidosim@1.0.0" } })).ok, "SP Ann turns physics on");
  ok((await a.req("create", { id: "ball", model: "test/cup.glb", components: { physics: { kind: "dynamic", who: "visitor" } }, place: { at: [0, 1] } })).ok, "SP a cup anyone may carry");
  const b = await client(srv.port, "pitch", "Bob", REPLICA); await sleep(150); const B = b.snapshot?.cut?.you;
  ok((await b.req("move", { to: [0, 0, 0.5] })).ok && (await b.req("grab", { id: "ball" })).ok, "SP Bob arrives and picks it up");
  await sleep(200);
  ok(a.of("holds").at(-1)?.holds?.[IDS.of("ball")]?.by === B, "SP1 everyone is told who holds it (holds: presence, never logged)", a.of("holds"));
  const c = await client(srv.port, "pitch", "Cy", REPLICA);
  ok(c.snapshot?.cut?.holds?.[IDS.of("ball")]?.by === B, "SP2 a joiner's cut says who holds what", c.snapshot?.cut?.holds);
  ok(c.snapshot?.cut?.sim?.spec?.engine === "eidosim@1.0.0" && c.snapshot.cut.sim.sim?.epoch, "SP2 …and carries the sim where the authority's clock stands (a joiner folds later launches with it)", c.snapshot?.cut?.sim?.spec);
  // the hold record (grabbable, slice 3): which hand rides the same presence message, so every client draws it there
  ok((await b.req("grab", { id: "ball", hand: "left" })).ok, "SP5 Bob moves it to his left hand (presence: nothing logged)"); await sleep(200);
  ok(a.of("holds").at(-1)?.holds?.[IDS.of("ball")]?.hand === "left" && a.of("holds").at(-1)?.holds?.[IDS.of("ball")]?.by === B, "SP5 …and everyone is told which hand holds it", a.of("holds").at(-1));
  const n = a.of("log").length; b.close(); await sleep(400);
  const launched = a.of("log").slice(n).flatMap((m) => m.entries).filter((e) => e?.kind === "sim" && e.verb === "launch" && e.body?.id === IDS.of("ball"));
  ok(launched.length === 1 && a.of("holds").at(-1)?.holds?.[IDS.of("ball")] === undefined, "SP3 Bob leaves holding it: it's dropped into the world (a launch), and nobody holds it", [launched.length, a.of("holds").at(-1)]);
  // wait until the authority has it at rest: the authority's clock is the wall clock made monotonic, and this host's wall clock
  // has been seen to step BACK 1.4 s under load (WSL), which stalls physics time for as long (never reorders it)
  let wr = null; for (let i = 0; i < 20; i++) { await sleep(500); wr = await a.req("wait", {}); if (!Object.keys(wr?.inFlight ?? {}).length) break; }
  let k = null; for (let i = 0; i < 40; i++) { await sleep(100); k = heldBy(c); if (k?.sim?.checks?.agree >= 1) break; } // (the rest's log reaching Cy)
  const rest = fold(readLog(fs.readFileSync(path.join(W4, "pitch", "world.jsonl")))).entities[IDS.of("ball")].c.transform.pos;
  // (a tumbling engine may land a cube on its side, so its origin needn't be at y 0: the authority's word is "on ground")
  ok(wr?.cameToRest?.some((r: any) => r.id === IDS.of("ball") && r.on === "ground") && k?.sim?.checks?.agree >= 1 && !k.sim.checks.disagree.length, "SP4 it rests on the ground, and Cy's own fold (from his cut) agrees with the authority's rest", [rest, k?.sim?.checks, wr]);
  a.close(); c.close(); }
// ---- MR: a burst of requests is always answered (client-check HT, 10-17): 30 label sets, each followed by the history
// re-read an editor sends, as fast as replies come back. Past the connection's message cap a request was dropped SILENTLY,
// and its client waited out its own timeout; now every request gets a reply (run, or refused 'rate') ----
{ const mk = await ann.req("create", { id: "burst", components: { mesh: { shape: "box", size: [1, 1, 1] } } });
  const answers: string[] = [];
  for (let k = 0; k < 30; k++) { const s1 = await ann.req("set", { id: "burst", component: "label", value: `b ${k}` }); const h = await ann.req("history", { id: "burst", limit: 20 });
    answers.push(s1.ok ? "ok" : s1.refused?.code, h.ok ? "ok" : h.refused?.code); }
  ok(mk.ok && answers.length === 60 && !answers.includes("timeout") && answers.every((x) => x === "ok" || x === "rate"), "MR1 30 sets and 30 history reads, back to back: 60 answers (run, or refused 'rate'), never silence", answers.join(" "));
  await sleep(1100); }   // the next rows start in a fresh message window
for (const c of [ann, bob, vic, spec]) c.close();
await sleep(200);
// ================= CB: the captioner bot (tools/captionbot/world.ts) through a real server: the authority's caption tool, the
// screen's captioners list, the server-stamped leg generation, the duplicate refusal read as a receipt =================
{ const { WorldClient } = await import("../captionbot/world.ts");
  const own = await client(srv.port, "garden", "Ann", REPLICA);
  ok((await own.req("create", { id: "screen1", model: "test/table.glb", place: { at: [6, 6] } })).ok, "CB (setup) a screen");
  const logs: string[] = [];
  const bot = new WorldClient({ url: `ws://127.0.0.1:${srv.port}/ws`, token: "", world: "garden", actor: "Capper", screenId: IDS.of("screen1"), title: "the talk", paceMs: 50, ackTimeoutMs: 2000, deedRetryMs: 300, log: (m: string) => logs.push(m) });
  bot.connect();
  for (let i = 0; i < 60 && !bot.you; i++) await sleep(50);
  bot.caption({ t0: 0, t1: 1, text: "before the list" } as any); await sleep(500);
  ok(bot.acked === 0 && bot.pendingCount === 1 && logs.some((l) => /held/.test(l)), "CB a bot that isn't one of the screen's captioners writes nothing; its line is held, not dropped", logs.slice(-3));
  ok((await own.req("set", { id: "screen1", component: "captioners", value: { ids: [bot.you] } })).ok, "CB the screen's owner lists the bot's identity", bot.you);
  for (let i = 0; i < 40 && bot.pendingCount; i++) await sleep(100);
  bot.caption({ t0: 1, t1: 2, text: "and after" } as any);
  for (let i = 0; i < 40 && bot.pendingCount; i++) await sleep(100);
  const bag = heldBy(own)?.view()?.entities?.[IDS.of("screen1")]?.captions;
  ok(bot.acked === 2 && bag?.n === 2 && bag?.line?.text === "and after" && bag.title === "the talk" && bag.gen > 0, "CB once listed, the held line and the next land in order; the bag carries the server-stamped leg generation", [bot.acked, bag]);
  const forged = await own.req("caption", { id: "screen1", session: bag?.session, n: 9, t0: 2, t1: 3, text: "x", gen: 999999999999 });
  ok(!forged.ok && /newer leg/.test(forged.refused?.reason ?? "") && heldBy(own)?.view()?.entities?.[IDS.of("screen1")]?.captions?.gen < 999999999999, "CB a client's own gen is ignored: the server stamps its connection's (the owner's older leg is refused as superseded, however large a gen she sends)", [forged.refused, heldBy(own)?.view()?.entities?.[IDS.of("screen1")]?.captions?.gen]);
  bot.close(); own.close(); await sleep(200); }

// ================= S7: joining never founds a world (security review 10-06 H3) =================
{ const ghost = await client(srv.port, "nobodyhome", "Ann", REPLICA);
  ok(!ghost.snapshot && ghost.of("error").some((m) => /no world called "nobodyhome"/.test(m.error)) && !fs.existsSync(path.join(W4, "nobodyhome")),
    "S7 joining a world name that doesn't exist is refused, and nothing is created on disk", [ghost.msgs.map((m) => m.type), fs.existsSync(path.join(W4, "nobodyhome"))]);
  ghost.close(); }

const errlog = fs.existsSync(srv.log + ".err") ? fs.readFileSync(srv.log + ".err", "utf8") : "";
ok(!/failed server-side|v1 '.*' write has no path/.test(errlog + fs.readFileSync(srv.log, "utf8")), "S* the server logged no server-side failure", errlog.slice(-600));
srv.proc.kill();

// ================= SH: chat history pages back through the whole log, across a restart (Commons audit #2: it stopped
// at the 40 lines heard since load, said hasMore: false, and the page told people this was "the beginning") =================
{ const lines = 50; const w = path.join(W4, "garden");
  const N0 = readLog(fs.readFileSync(path.join(w, "world.jsonl"))).filter((e) => e.kind === "say").length;
  const srvA = await startServer(ENGINE, W4, OPT, "sh");
  { const boot = fs.readFileSync(srvA.log, "utf8");   // the boot sweep TELLS the operator about the old worlds left on disk by S6 (owner 10-15)
    ok(boot.includes(`[boot] old-format world "oldtown" (oldtown/log.jsonl) is NOT being served.`) && boot.includes(`WORLDS_DIR=${W4} bun tools/protocol/world.ts translate oldtown --no-founder-key --approved <the report hash the dry run printed> --operator-only-no-owner`)
      && boot.includes(`[boot] old-format world "prenamed" (prenamed/world.jsonl) is NOT being served.`) && /\[boot\] 2 world\(s\) need translating — see above/.test(boot) && !/"hollow"/.test(boot),
      "SH0 at boot the operator is told, per old world, that it isn't served and the exact command (this WORLDS_DIR), and how many", boot.split("\n").filter((l) => /old-format|need translating|translate /.test(l))); }
  const t = await client(srvA.port, "garden", "Ann", REPLICA);
  let said = 0; for (let i = 0; i < lines; i++) { const r = await t.req("say", { text: `line ${i}` }); if (r.ok) said++; else { await sleep(1100); i--; } }
  t.close(); srvA.proc.kill(); await sleep(300);
  const srvB = await startServer(ENGINE, W4, OPT, "sh2");   // a restart: only what's on disk
  // speech is arrival-only (R 10-18): the master log keeps every say; an admin (Ann owns garden) pages back through all of
  // it, anyone else reads back only what was said since they arrived
  const pager = (r: any) => (before?: number, verbs: string[] | undefined = ["say"]) => new Promise<any>((res) => { const id = `h${Math.random()}`; const on = (ev: any) => { const m = JSON.parse(String(ev.data)); if (m.type === "history" && m.reqId === id) { r.ws.removeEventListener("message", on); res(m); } };
    r.ws.addEventListener("message", on); r.send({ type: "history", reqId: id, limit: 25, ...(verbs ? { verbs } : {}), ...(before !== undefined ? { before } : {}) }); });
  const all = async (r: any) => { const page = pager(r); const got: any[] = []; let p = await page(); got.unshift(...p.entries); let guard = 0;
    while (p.hasMore && guard++ < 20) { p = await page(p.oldestSeq); got.unshift(...p.entries); } return { got, last: p }; };
  const r = await client(srvB.port, "garden", "Ann", REPLICA);
  { const { got, last: p } = await all(r); const texts = got.map((e) => e.args?.text);
    ok(got.length === N0 + lines && texts.at(-1) === `line ${lines - 1}` && texts.indexOf("line 0") === N0 && !p.hasMore,
      "SH1 after a restart, an admin (the owner) paging back with history reaches every chat line ever said here, in order, and says when it's done", [got.length, N0 + lines, texts.slice(0, 3), p.hasMore]); }
  ok(r.snapshot?.state?.chatTotal === N0 + lines && JSON.stringify(r.snapshot?.state?.recentChat) === "[]", "SH2 the owner's join: no line replayed, and chatTotal counts every line the master log holds (not the ones since load)", [r.snapshot?.state?.chatTotal, N0 + lines, r.snapshot?.state?.recentChat?.length]);
  const bob = await client(srvB.port, "garden", "Bob", REPLICA);
  ok(JSON.stringify(bob.snapshot?.state?.recentChat) === "[]" && bob.snapshot?.state?.chatTotal === 0, "SH3 a non-admin's join carries no say from before it arrived (no backscroll) and no count of them", [bob.snapshot?.state?.recentChat?.length, bob.snapshot?.state?.chatTotal]);
  { const { got } = await all(bob); const unf = await pager(bob)(undefined, undefined);
    ok(got.length === 0 && unf.entries.length === 0, "SH4 a non-admin's history page (filtered by say, or not) holds no line said before it arrived", [got.length, unf.entries.length, got.slice(0, 2)]); }
  { const hb = await bob.req("history", { verbs: ["say"], limit: 200 }); const ha = await r.req("history", { verbs: ["say"], limit: 200 });
    const hbAll = await bob.req("history", { limit: 200 });
    ok(hb.ok && (hb.entries ?? []).length === 0 && !(hbAll.entries ?? []).some((e: any) => e.kind === "say") && (ha.entries ?? []).filter((e: any) => e.kind === "say").length === Math.min(200, N0 + lines),
      "SH5 the authority's history request: a non-admin reads no say body from before it arrived (by verbs or not); the owner reads them all", [(hb.entries ?? []).length, (hbAll.entries ?? []).filter((e: any) => e.kind === "say").length, (ha.entries ?? []).length]); }
  ok((await r.req("say", { text: "after bob came" })).ok, "SH6 (Ann speaks once Bob is here)");
  for (let i = 0; i < 60 && !bob.of("log").some((m: any) => (m.entries ?? []).some((e: any) => e.kind === "say" && e.body?.text === "after bob came")); i++) await sleep(50);
  { const { got } = await all(bob); const hb = await bob.req("history", { verbs: ["say"] });
    ok(got.map((e) => e.args?.text).join("|") === "after bob came" && (hb.entries ?? []).map((e: any) => e.body?.text).join("|") === "after bob came",
      "SH6 what was said while Bob was present reaches him live and reads back in his history (both routes), and nothing older", [got.map((e) => e.args?.text), (hb.entries ?? []).map((e: any) => e.body?.text)]); }
  bob.close(); r.close(); srvB.proc.kill(); }

// ================= SK: the server is killed while someone holds a thing (no clean close: no leave, no drop) =================
// The live server keeps presence in memory, so the hold is gone after a restart, but in a world that runs physics the
// grab's `lift` took the thing out of the engine, and nothing settles it: it would stay a ghost (no body, no collider)
// until someone moved it. At load, the authority settles what the log still has lifted with nobody holding it, as leave does
// (door return-held: where the log last had it; a grabbable that returns goes home).
{ ok(tool(["found", "crash", "--owner", "Ann"]).code === 0, "SK found a physics world");
  const srvA = await startServer(ENGINE, W4, OPT, "sk");
  const a = await client(srvA.port, "crash", "Ann", REPLICA); await sleep(100);
  await a.req("set", { id: "@world", component: "physics-engine", value: { engine: "eidosim@1.0.0" } });
  await a.req("create", { id: "ball", model: "test/cup.glb", components: { physics: { kind: "dynamic", who: "visitor" } }, place: { at: [0, 1] } });
  await a.req("create", { id: "torch", model: "test/cup.glb", components: { physics: { kind: "dynamic" }, grabbable: { who: "visitor", release: "return" } }, place: { at: [0.4, 1] } });
  const b = await client(srvA.port, "crash", "Bob", REPLICA); await sleep(150);
  await b.req("move", { to: [0, 0, 0.5] }); const g1 = await b.req("grab", { id: "ball" }); const g2 = await b.req("grab", { id: "torch" });
  ok(g1.ok && g2.ok, "SK Bob holds the ball and the torch", [g1.refused, g2.refused]);
  await b.req("move", { to: [0, 0, 2] }); await sleep(300);
  srvA.proc.kill(9); await srvA.proc.exited; a.ws.close(); b.ws.close();   // SIGKILL: no leave, no drop, no clean close
  const before = readLog(fs.readFileSync(path.join(W4, "crash", "world.jsonl"))).length;
  const srvB = await startServer(ENGINE, W4, OPT, "sk2");
  const c = await client(srvB.port, "crash", "Cy", REPLICA); await sleep(200);
  const L = readLog(fs.readFileSync(path.join(W4, "crash", "world.jsonl")));
  const after = L.slice(before).map((e) => `${e.actor === "system" ? "system" : "?"}:${e.kind}:${e.verb}${e.body?.id ? `:${e.body.id}` : ""}`);
  const k = heldBy(c); const bodies = Object.keys(k?.sim?.sim?.statics ?? {});   // a thing at rest is a static in the engine (shared/sim.js)
  ok(after.includes(`system:act:return-held:${IDS.of("ball")}`) && after.includes(`system:act:return-home:${IDS.of("torch")}`), "SK1 after the restart, the authority settled both: the ball where the log had it (return-held), the torch home (release: return)", after);
  ok(!Object.keys(c.snapshot?.cut?.holds ?? {}).length && bodies.includes(IDS.of("ball")) && bodies.includes(IDS.of("torch")), "SK2 …nobody holds them, and a joiner's engine has them back (colliders again)", [c.snapshot?.cut?.holds, bodies]);
  c.close(); srvB.proc.kill(); }

// ================= SL: the load's socket lift, per host, said to the flight recorder (review 10-12 S2-3) =================
// A world stored in the old spelling, by hand, with one host the door can't lift (a slot called "front seat": a socket's
// name is one word, and the name is a shape, not a value the lift carries) before a healthy one. WorldLog lifts at construction: the healthy host lifts, the bad one is
// left as it was, and attaching the world says it to its flight recorder (world_debug, /debug), with the host's id.
{ const WS = scratch("srvlift"); const script = path.join(WS, "lift.ts");
  fs.writeFileSync(script, `// @ts-nocheck
import fs from "node:fs"; import path from "node:path";
const W = process.env.WORLDS_DIR, E = process.env.ENGINE;
const { custodyAt } = await import(E + "/server/custody.ts"); const { custodyFileIn } = await import(E + "/server/keyfiles.ts");
const { translate } = await import(E + "/tools/protocol/import-v1/translate-v1.js");
const cu = custodyAt(custodyFileIn(W)); const keys = { key: cu.sequencer(), operator: cu.operator() };
const old = [{ seq: 0, ts: 1, actor: "world", verb: "genesis", args: { v: 2, dialect: "eidoverse-log" } }, { seq: 1, ts: 2, actor: "ann", verb: "grant", args: { id: "ann", role: "owner" } },
  { seq: 2, ts: 3, actor: "ann", verb: "spawn", args: { id: "a-cart", lib: "crate", pos: [0, 0, 0] } }, { seq: 3, ts: 4, actor: "ann", verb: "spawn", args: { id: "b-bench", lib: "crate", pos: [3, 0, 0] } },
  { seq: 4, ts: 5, actor: "ann", verb: "comp", args: { id: "a-cart", type: "sockets", data: { "front seat": { pos: [0, 0.5, 0], body: { action: "sit" } } } } },
  { seq: 5, ts: 6, actor: "ann", verb: "comp", args: { id: "b-bench", type: "sockets", data: { seat: { pos: [0, 0.5, 0], body: { action: "sit" } } } } }];
fs.mkdirSync(path.join(W, "liftw"), { recursive: true }); fs.writeFileSync(path.join(W, "liftw", "world.jsonl"), translate(old, keys).out.map((e) => JSON.stringify(e)).join("\\n") + "\\n");
const { WorldLog } = await import(E + "/server/worldlog.ts");
const log = new WorldLog("liftw"); const notes = []; log.attach({ broadcast() {}, rightsChanged() {}, debug: (k, d) => notes.push({ kind: k, ...d }) });
const st0 = log.live.state(); const kids0 = (h) => Object.values(st0.entities).filter((e) => e.c.parent?.to === h && e.c.socket).length;
const atLoad = { notes, a: kids0("a-cart"), aMap: !!st0.entities["a-cart"].c.sockets, b: kids0("b-bench"), entries: log.live.entries.length };
// the operator runs the maintenance command from inside the world (operator-repair {verb: "repair"}): the healthy host lifts, the one the door refuses is named
const r = log.operatorRepair("opie", "repair", {});
const st = log.live.state(); const kids = (h) => Object.values(st.entities).filter((e) => e.c.parent?.to === h && e.c.socket).length;
console.log("SL " + JSON.stringify({ atLoad, r: { ok: r.ok, lift: r.steps?.lift }, a: kids("a-cart"), aMap: !!st.entities["a-cart"].c.sockets, b: kids("b-bench"), by: log.live.entries.find((e) => e?.verb === "lift-sockets")?.body?.by }));
`);
  const r = Bun.spawnSync(["bun", script], { env: { ...process.env, WORLDS_DIR: path.join(WS, "worlds"), ENGINE }, stdout: "pipe", stderr: "pipe" });
  const line = String(r.stdout).split("\n").find((l) => l.startsWith("SL ")); const got = line ? JSON.parse(line.slice(3)) : null;
  ok(!!got && got.atLoad.a === 0 && got.atLoad.b === 0 && got.atLoad.aMap && got.atLoad.notes.some((n) => n.kind === "repair-needed" && n.steps?.includes("lift-sockets") && n.blocking?.includes("lift-sockets")), "SL1 at load nothing is lifted (a load never writes: lead 10-18); the flight recorder is told the world needs lift-sockets and refuses writes meanwhile (repair-needed)", got);
  ok(!!got && got.r.ok && got.b === 1 && got.a === 0 && got.aMap && got.by === "opie" && got.r.lift?.failed?.some((f) => f.host === "a-cart" && f.code === "shape") && got.r.lift?.made?.some((m) => m.host === "b-bench"), "SL1 …the operator's repair (operator-repair {verb: repair}) lifts the healthy host, recorded with the operator's id, and names the host the door refuses ({host, code}), left as it was", got); }

console.log(`[server-check] ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
