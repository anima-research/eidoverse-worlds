// tools/protocol/agenttools-check.ts — the agent's tools (mcpl/tools.ts HANDLERS on a real mcpl/agent.ts WorldAgent) against a
// real sequencer: scratch port, scratch WORLDS_DIR/OPT_DIR, TRUST_NAMES, never 8968/8970. Edit mode v1's worst tool bugs
// (AUDIT-tools-vs-protocol 2026-10-07, AUDIT-human-agent-parity 2026-10-07). usage: bun tools/protocol/agenttools-check.ts
//   AT1  E1 "two bodies": the agent's move walks the AUTHORITY's body (move steps, as a person's client streams them), so
//        a wall the authority calls solid stops it, and the hand verbs find it where it stands (grab/put after a walk)
//   AT2  create {from: <a thing's id>} duplicates from the tool (at as a point; with no at, beside its source), and its
//        description carries an example
//   AT3  ragdoll reports the server's refusal as an error naming the consent class (shove), and its description no longer
//        says agents are performers by default (every body is Normal)
//   AT4  every advertised tool carries a title and honest MCP annotations (readOnly / destructive / idempotent / openWorld)
//   AT5  look points at a real tool where one exists (lock and hidden are edit fields), not at the act hatch
// @ts-nocheck
import fs from "node:fs";
import path from "node:path";
import { ENGINE, scratch } from "./common.ts";

const root = scratch("agenttools");
let pass = 0, fail = 0;
const ok = (cond, what, detail?) => { if (cond) pass++; else { fail++; console.log(`  FAIL ${what}${detail !== undefined ? ` — ${JSON.stringify(detail).slice(0, 600)}` : ""}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const T = (r) => { const t = r?.content?.[0]?.text ?? ""; if (process.env.AT_SHOW) console.log(`    · ${t.slice(0, 400)}`); return t; };

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

// ---- AT4 needs no server: the table itself ----
const { HANDLERS, TOOLS, toolList } = await import("../../mcpl/tools.ts");
{ const listed = [...toolList({ travel: true }), ...toolList({ travel: false })];
  const HINTS = ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"];
  const bad = listed.filter((t) => typeof t.title !== "string" || !t.title.trim() || !t.annotations || HINTS.some((h) => typeof t.annotations[h] !== "boolean"));
  ok(listed.length > 40 && !bad.length, "AT4 every advertised tool has a title and all four annotation hints", bad.map((t) => t.name));
  ok(TOOLS.every((t) => t.annotations?.title === undefined || t.annotations.title === t.title), "AT4 (a title said once: the tool's own, not a second one in annotations)");
  const by = Object.fromEntries(TOOLS.map((t) => [t.name, t.annotations ?? {}]));
  const reads = ["look", "inspect", "measure", "world_history", "world_debug", "hierarchy", "blueprints", "whois", "list_bans", "body_state", "screenshot", "list_library", "library_sheet", "library_preview", "worlds", "flight_status", "catch_up"];
  ok(reads.every((n) => by[n]?.readOnlyHint === true && by[n]?.destructiveHint === false), "AT4 the reads are read-only and not destructive", reads.filter((n) => !(by[n]?.readOnlyHint === true && by[n]?.destructiveHint === false)));
  const writes = ["move", "create", "place", "edit", "remove", "act", "say", "ragdoll", "kick", "ban", "light", "blueprint_place", "attach", "travel"];
  ok(writes.every((n) => by[n]?.readOnlyHint === false), "AT4 everything that changes the world or a body is not read-only", writes.filter((n) => by[n]?.readOnlyHint !== false));
  ok(["remove", "act", "edit", "kick", "ban"].every((n) => by[n]?.destructiveHint === true) && ["create", "say", "move", "unban"].every((n) => by[n]?.destructiveHint === false), "AT4 deleting, editing in place and removing people are destructive; making, saying and walking are not",
    Object.fromEntries(["remove", "act", "edit", "kick", "ban", "create", "say", "move", "unban"].map((n) => [n, by[n]?.destructiveHint])));
  ok(["say", "whisper", "ragdoll", "kick"].every((n) => by[n]?.openWorldHint === true) && ["look", "inspect", "move"].every((n) => by[n]?.openWorldHint === false), "AT4 what reaches other people is open-world; reading the world and walking in it are not");
  // the stdio host adds one tool of its own (mcpl/server.ts can't be imported here: it connects at load)
  const src = fs.readFileSync(path.join(ENGINE, "mcpl/server.ts"), "utf8");
  const pp = src.slice(src.indexOf("const PENDING_PINGS_TOOL"), src.indexOf("};", src.indexOf("const PENDING_PINGS_TOOL")));
  ok(/title:/.test(pp) && HINTS.every((h) => new RegExp(`${h}:\\s*(true|false)`).test(pp)), "AT4 …and the stdio host's own pending_pings tool too", pp.slice(0, 400));
  // AT3 / AT2 descriptions
  const desc = Object.fromEntries(TOOLS.map((t) => [t.name, t.description]));
  ok(!/default for agent performers/.test(desc.ragdoll) && /Normal/.test(desc.ragdoll) && /shove/.test(desc.ragdoll), "AT3 the ragdoll description says every body starts Normal (no agent default) and names the class", desc.ragdoll);
  ok(/create \{from: "[^"]+", at: \[/.test(desc.create) && !/with at: \[x, z\]\)/.test(desc.create), "AT2 create's description has a duplicate example in the shape the tool takes", desc.create); }

// ---- the server ----
const W = path.join(root, "w"), OPT = path.join(root, "opt"); fs.mkdirSync(W, { recursive: true });
await writeBoxGlb(path.join(OPT, "test/wall.glb"), [6, 2.4, 0.2]);   // a wall: 6 m along x, 2.4 m tall, 0.2 m thick
await writeBoxGlb(path.join(OPT, "test/cup.glb"), [0.1, 0.12, 0.1]);
const env = (extra = {}) => ({ ...process.env, WORLDS_DIR: W, OPT_DIR: OPT, SKIP_OPT_SWEEP: "1", HOST: "127.0.0.1",
  BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0", JOIN_TOKEN: "", WORLD_ADMIN: "", TRUST_NAMES: "1", EIDO_FLIGHT_REHEARSAL: "", SESSIONS_PATH: path.join(root, "sessions.json"), ...extra });
const r0 = Bun.spawnSync(["bun", "tools/protocol/world.ts", "found", "yard", "--owner", "Ann"], { cwd: ENGINE, env: env() });
ok(r0.exitCode === 0, "(setup) found yard, Ann owns it", r0.stderr.toString().slice(-300));
let port = 9540; for (; port < 9640; port++) { try { const s = Bun.listen({ hostname: "127.0.0.1", port, socket: { data() {} } }); s.stop(true); break; } catch {} }
const logf = path.join(root, "srv.log");
const proc = Bun.spawn(["bun", "server/server.ts"], { cwd: ENGINE, env: env({ PORT: String(port) }), stdout: Bun.file(logf), stderr: Bun.file(logf + ".err") });
process.on("exit", () => { try { proc.kill(); } catch {} });
let up = false; for (let i = 0; i < 80 && !up; i++) { await sleep(150); try { up = (await fetch(`http://127.0.0.1:${port}/version`, { signal: AbortSignal.timeout(800) })).ok; } catch {} }
ok(up, "(setup) the server is up");

async function sock(name) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`); const msgs = [];
  ws.onmessage = (ev) => msgs.push(JSON.parse(String(ev.data)));
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  ws.send(JSON.stringify({ type: "join", world: "yard", id: name, avatar: "", replica: true }));
  for (let i = 0; i < 80 && !msgs.some((m) => m.type === "snapshot" || m.type === "error"); i++) await sleep(50);
  const snap = msgs.find((m) => m.type === "snapshot"); let rn = 0;
  return { ws, msgs, snap, actor: snap?.cut?.you ?? null, close: () => ws.close(),
    at: (x, z) => ws.send(JSON.stringify({ type: "pose", pose: { p: [x, 0, z], yaw: 0, speed: 0, clip: "idle" } })),
    req: async (verb, args = {}) => { const id = `q${++rn}`; ws.send(JSON.stringify({ type: "request", id, verb, args }));
      for (let i = 0; i < 80; i++) { const r = msgs.find((m) => m.type === "reply" && m.id === id); if (r) return r.reply; await sleep(50); } return { ok: false, timeout: true }; } };
}

const ann = await sock("Ann");
const { WorldAgent } = await import("../../mcpl/agent.ts");
const ag = new WorldAgent({ url: `ws://127.0.0.1:${port}/ws`, name: "Hep", world: "yard", avatar: "" });
await ag.connect(); for (let i = 0; i < 60 && !ag.cut; i++) await sleep(50);
const HEP = ag.cut?.you;
ok(/^u-/.test(HEP ?? "") && ag.replica?.active, "(setup) the agent joins and folds the world", ag.cut);
ok((await ann.req("set", { id: "@world", component: `roles:${HEP}`, value: { role: "builder" } })).ok, "(setup) Ann makes the agent a builder");
ok((await ann.req("create", { id: "wall", model: "test/wall.glb", components: { transform: { pos: [0, 0, 3], q: [0, 0, 0, 1], scale: [1, 1, 1] } } })).ok, "(setup) Ann builds a wall across z = 3");
ok((await ann.req("create", { id: "mug", model: "test/cup.glb", components: { transform: { pos: [6.4, 0, 0], q: [0, 0, 0, 1], scale: [1, 1, 1] }, grabbable: { who: "visitor" } } })).ok, "(setup) …and a mug anyone may carry, at x = 6.4");
for (let i = 0; i < 60 && !(ag.entities.has("wall") && ag.entities.has("mug")); i++) await sleep(50);
const call = (name, a = {}) => HANDLERS[name](ag, a, { agent: ag, canPush: () => false, heldActivity: [], cursor: { caughtUpTo: null } }, name);

// ---- AT5: the light tool's id (port of upstream #216) ----
// id omitted or null = a new light; an id that IS given must be a non-empty string — "" or "   " used to be minted
// over silently, and a non-string went to the wire to bounce off the grammar in the grammar's words, not the tool's.
{ const before = [...ag.entities.keys()].length;
  for (const id of ["", "   ", 4, [], {}]) {
    const r = await call("light", { id, x: 1, z: 1 });
    ok(r.isError && /id/.test(T(r)) && /non-empty string|omit/.test(T(r)), `AT5a light refuses a given id that isn't a non-empty string, in its own words: ${JSON.stringify(id)}`, T(r));
  }
  await sleep(300);
  ok([...ag.entities.keys()].length === before, "AT5a …and minted nothing for them", [...ag.entities.keys()].length - before);
  const b2 = [...ag.entities.keys()].length;
  const r = await call("light", { id: null, x: 1, z: 1 });
  for (let i = 0; i < 40 && [...ag.entities.keys()].length === b2; i++) await sleep(50);
  ok(!r.isError && [...ag.entities.keys()].length === b2 + 1, "AT5b id: null is 'omitted' — one new light", T(r)); }

// ---- AT1: one body ----
{ const thru = await call("move", { to: [0, 6], run: true });
  ok(thru.isError && /solid|in the way/.test(T(thru)) && /wall/.test(T(thru)), "AT1a walking at a wall: the authority's solid stops the agent, and the tool says so (an error naming the wall)", T(thru));
  ok(ag.pos.z < 3 - 0.1, "AT1a …and the agent's body stopped on its side of the wall (no second body walked on through it)", ag.pos);
  const side = await call("move", { to: [6, 0], run: true });
  ok(!side.isError && /arrived/.test(T(side)) && Math.abs(ag.pos.x - 6) < 0.05, "AT1b in the open it walks there as before", T(side));
  const g = await call("act", { verb: "grab", args: { id: "mug" } });
  ok(!g.isError, "AT1b after its move, the authority finds the agent's body where it stands: grab works (it said 'your body isn't in the world yet')", T(g).slice(0, 300));
  const away = await call("move", { to: [10, 0], run: true });
  ok(!away.isError && Math.abs(ag.pos.x - 10) < 0.05, "AT1c it walks on carrying the mug", T(away));
  const put = await call("act", { verb: "put", args: { id: "mug" } }); await sleep(300);
  const mx = ag.foldRecord("mug")?.pos?.[0];
  ok(!put.isError && Number.isFinite(mx) && Math.abs(mx - 10) < 1.6, "AT1c …and puts it down where it IS (x≈10), not where the authority last saw it (the probe's 'two bodies')", [T(put).slice(0, 200), ag.foldRecord("mug")?.pos]);
  // a body moved without walking (a flight, a seat, a drag): the authority's track is stale; the next walk re-arrives it
  ag.pos.x = 10; ag.pos.z = -9;
  const stale = await call("move", { to: [10, -8] });
  ok(!stale.isError && /re-arrived/.test(T(stale)) && Math.abs(ag.pos.z + 8) < 0.05, "AT1d after a move that wasn't a walk, the next walk re-arrives the authority's body there (a teleport, said) and walks on", T(stale));
  // a visitor in a world with a spawn arrives at the spawn, as a person does
  ok((await ann.req("set", { id: "@world", component: "spawn", value: { pos: [-8, 0, -8], radius: 2 } })).ok, "(AT1e setup) Ann gives the yard a spawn at (-8, -8)");
  const vee = new WorldAgent({ url: `ws://127.0.0.1:${port}/ws`, name: "Vee", world: "yard", avatar: "" });
  await vee.connect(); for (let i = 0; i < 60 && !vee.replica?.active; i++) await sleep(50);
  const vm = await HANDLERS.move(vee, { to: [-6, -8], run: true }, { agent: vee, canPush: () => false, heldActivity: [], cursor: { caughtUpTo: null } }, "move");
  ok(!vm.isError && /spawn/.test(T(vm)) && Math.abs(vee.pos.x + 6) < 0.05 && Math.abs(vee.pos.z + 8) < 0.05, "AT1e a visitor's first walk in a world with a spawn arrives there and walks on (not stuck behind 'spawn')", [T(vm), vee.pos]);
  vee.close(); }

// ---- AT2: duplicate from the tool ----
{ const d1 = await call("create", { from: "mug", at: [8, 2] }); await sleep(200);
  const made = (T(d1).match(/\[([a-z0-9-]+)\]/) ?? [])[1];
  const p = made ? ag.foldRecord(made)?.pos : null;
  ok(!d1.isError && made && made !== "mug" && Array.isArray(p) && Math.abs(p[0] - 8) < 0.01 && Math.abs(p[2] - 2) < 0.01, "AT2a create {from: <id>, at: [x, z]} duplicates the thing there", [T(d1), p]);
  const d2 = await call("create", { from: "mug" }); await sleep(200);
  const made2 = (T(d2).match(/\[([a-z0-9-]+)\]/) ?? [])[1];
  ok(!d2.isError && made2 && made2 !== made && ag.foldRecord(made2), "AT2b create {from: <id>} with no at puts the copy beside its source", T(d2));
  const d3 = await call("create", { from: "mug", at: { pos: [9, 0, 2] } });
  ok(!d3.isError, "AT2c …and the authority's own {pos, yaw|q} still passes through", T(d3)); }

// ---- AT3: a refused shove is an error ----
{ const vic = await sock("Vic"); await sleep(200);
  vic.at(ag.pos.x + 1, ag.pos.z); await sleep(300);   // in reach (shove: 3 m)
  const no = await call("ragdoll", { target: "Vic" });
  ok(no.isError && /shove/.test(T(no)) && /consent|nobody/.test(T(no)), "AT3a Vic's body is Normal: the shove is refused, and the tool says so as an error naming the class", T(no));
  ok((await vic.req("consent", { set: { class: "shove", tier: "strangers", mode: "everyone" } })).ok, "(AT3 setup) Vic opens shove to strangers");
  const k = vic.msgs.length; const yes = await call("ragdoll", { target: "Vic" }); await sleep(300);
  ok(!yes.isError && vic.msgs.slice(k).some((m) => m.type === "puppet" && m.ragdoll), "AT3b once Vic allows it, the shove goes through and reports no error", [T(yes), vic.msgs.slice(k).map((m) => m.type)]);
  vic.close(); }

// ---- AT5: look points at the real tool ----
{ ok((await ann.req("create", { id: "post", model: "test/cup.glb", components: { transform: { pos: [12, 0, 0], q: [0, 0, 0, 1], scale: [1, 1, 1] }, lock: true, hidden: true } })).ok, "(AT5 setup) a locked, hidden post");
  for (let i = 0; i < 60 && !ag.entities.has("post"); i++) await sleep(50);
  const line = T(await call("look")).split("\n").find((l) => /\[post\]/.test(l)) ?? "";
  ok(/locked/.test(line) && /edit \{id: "post", set: \{"flags\.lock": false\}\}/.test(line) && /edit \{id: "post", set: \{"flags\.hidden": false\}\}/.test(line) && !/act \{verb: "delete"/.test(line), "AT5 look teaches edit flags.lock / flags.hidden, not act delete", line);
  const un = await call("edit", { id: "post", set: { "flags.lock": false, "flags.hidden": false } }); await sleep(200);
  ok(!un.isError && !ag.foldRecord("post")?.comp?.lock && !ag.foldRecord("post")?.comp?.hidden, "AT5 …and what it teaches works", T(un)); }

ag.close(); ann.close();
console.log(`agenttools: ${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
