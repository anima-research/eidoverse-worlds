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
//   AT6  the surface after the fold (REPOINT-PLAN 10-14 §4; R's standard 09:47: a name intuitive to everyone AND useful in
//        general situations, or it is an alias): ~30 tools; the flight nine are move {mode: "fly"} + act land; the body
//        sugar is pose {posture|wings|clear} / reach {release} / act shove; three library tools are one; moderation is
//        act {kick|ban|unban|bans}; light/remove/blueprint_place are create / act delete / create {from}; a folded name
//        still answers, teaching where it went
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
  ok(listed.length > 28 && !bad.length, "AT4 every advertised tool has a title and all four annotation hints", bad.map((t) => t.name));
  ok(TOOLS.every((t) => t.annotations?.title === undefined || t.annotations.title === t.title), "AT4 (a title said once: the tool's own, not a second one in annotations)");
  const by = Object.fromEntries(TOOLS.map((t) => [t.name, t.annotations ?? {}]));
  const reads = ["look", "inspect", "measure", "world_history", "world_debug", "hierarchy", "blueprints", "whois", "body_state", "screenshot", "library", "worlds", "catch_up"];
  ok(reads.every((n) => by[n]?.readOnlyHint === true && by[n]?.destructiveHint === false), "AT4 the reads are read-only and not destructive", reads.filter((n) => !(by[n]?.readOnlyHint === true && by[n]?.destructiveHint === false)));
  const writes = ["move", "create", "place", "edit", "act", "say", "attach", "travel", "set_avatar", "pose", "reach"];
  ok(writes.every((n) => by[n]?.readOnlyHint === false), "AT4 everything that changes the world or a body is not read-only", writes.filter((n) => by[n]?.readOnlyHint !== false));
  ok(["act", "edit"].every((n) => by[n]?.destructiveHint === true) && ["create", "say", "move"].every((n) => by[n]?.destructiveHint === false), "AT4 act (delete, kick, ban…) and editing in place are destructive; making, saying and walking are not",
    Object.fromEntries(["act", "edit", "create", "say", "move"].map((n) => [n, by[n]?.destructiveHint])));
  ok(["say", "whisper", "act", "pose"].every((n) => by[n]?.openWorldHint === true) && ["look", "inspect", "move"].every((n) => by[n]?.openWorldHint === false), "AT4 what reaches other people is open-world; reading the world and walking in it are not");
  // the stdio host adds one tool of its own (mcpl/server.ts can't be imported here: it connects at load)
  const src = fs.readFileSync(path.join(ENGINE, "mcpl/server.ts"), "utf8");
  const pp = src.slice(src.indexOf("const PENDING_PINGS_TOOL"), src.indexOf("};", src.indexOf("const PENDING_PINGS_TOOL")));
  ok(/title:/.test(pp) && HINTS.every((h) => new RegExp(`${h}:\\s*(true|false)`).test(pp)), "AT4 …and the stdio host's own pending_pings tool too", pp.slice(0, 400));
  // AT3 / AT2 descriptions
  const desc = Object.fromEntries(TOOLS.map((t) => [t.name, t.description]));
  ok(!/default for agent performers/.test(desc.act) && /Normal/.test(desc.act) && /shove \{target/.test(desc.act), "AT3 act's shove says every body starts Normal (no agent default) and names the class", desc.act.slice(0, 200));
  // ---- AT6: the surface itself ----
  const names = TOOLS.map((t) => t.name);
  const folded = ["take_off", "climb_to", "glide_to", "land_at", "rehearse_down", "rehearse_recover", "fold_wings", "unfold_wings", "flight_status",
    "clear_pose", "clear_reach", "posture", "ragdoll", "library_sheet", "library_preview", "list_library", "light", "remove", "blueprint_place", "kick", "ban", "unban", "list_bans"];
  ok(names.length <= 32 && names.length >= 28, `AT6 the table is ~30 tools (${names.length})`, names);
  ok(!folded.some((n) => names.includes(n)), "AT6 none of the folded names is a tool of its own", folded.filter((n) => names.includes(n)));
  ok(["move", "act", "pose", "reach", "library", "set_avatar", "create", "edit", "body_state"].every((n) => names.includes(n)), "AT6 the general tools they folded into exist");
  ok(/mode/.test(desc.move) && /fly/.test(desc.move) && /altitude/.test(desc.move) && /name/.test(desc.move), "AT6 move documents mode: \"fly\" (altitude) and to: <a name>", desc.move.slice(0, 300));
  ok(/land/.test(desc.act) && /kick/.test(desc.act) && /\bbans\b/.test(desc.act) && /delete/.test(desc.act), "AT6 act documents land, kick/ban/unban/bans and delete", desc.act.slice(0, 200));
  ok(/posture/.test(desc.pose) && /wings/.test(desc.pose) && /clear/.test(desc.pose), "AT6 pose documents posture, wings and clear");
  ok(/release/.test(desc.reach), "AT6 reach documents release");
  ok(/query/.test(desc.library) && /preview/.test(desc.library) && /sheet|page/.test(desc.library), "AT6 library documents query, preview and the sheet");
  ok(/light/.test(desc.create) && /\bat\b/.test(desc.create), "AT6 create documents a light and at");
  const { resolveTool, handleTool } = await import("../../mcpl/tools.ts");
  ok(resolveTool("set_avatar")?.name === "set_avatar" && resolveTool("wear") === null && resolveTool("walk_to")?.name === "move", "AT6 set_avatar keeps its name (R: unambiguous; wear could mean a hat), the old renames still alias");
  ok(/ragdoll: true/.test(desc.pose) && !/limp: true/.test(desc.pose) && !/shove \{target/.test(desc.pose) && /shove \{target/.test(desc.act), "AT6 pose documents ragdoll (one vocabulary with the browser: a body going limp); the push's form (shove {target…}) is act's alone");
  ok(resolveTool("take_off") === null && resolveTool("kick") === null, "AT6 a folded tool does not resolve to a handler (it folded, it was not renamed)");
  const gone = await handleTool({ agent: null } as any, "take_off", {});
  ok(gone.isError && /move \{mode: "fly"/.test(gone.content[0].text), "AT6 calling a folded name teaches where it went", gone.content[0].text);
  const gone2 = await handleTool({ agent: null } as any, "kick", {});
  ok(gone2.isError && /act \{verb: "kick"/.test(gone2.content[0].text), "AT6 …kick too", gone2.content[0].text);
  ok(!names.some((n) => /^rehearse_/.test(n)) && !/ag\.flightBody(Down|Recovered)\(/.test(fs.readFileSync(path.join(ENGINE, "mcpl/tools.ts"), "utf8")), "AT6 the rehearsal hooks are gone from the tool surface: no tool, no call into the trusted seam (a bench calls the agent's flightBodyDown directly)");
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

// ---- AT5: a light is create {components: {light}} (the light tool folded; #216's id rule rides create's own) ----
{ const before = [...ag.entities.keys()].length;
  for (const id of ["", "   ", 4, [], {}]) {
    const r = await call("create", { id, components: { light: { intensity: 8 } } });
    ok(r.isError && /id/.test(T(r)), `AT5a create refuses a given id that isn't a non-empty string, in its own words: ${JSON.stringify(id)}`, T(r));
  }
  await sleep(300);
  ok([...ag.entities.keys()].length === before, "AT5a …and minted nothing for them", [...ag.entities.keys()].length - before);
  const b2 = [...ag.entities.keys()].length;
  const r = await call("create", { components: { light: { intensity: 8 } } });
  for (let i = 0; i < 40 && [...ag.entities.keys()].length === b2; i++) await sleep(50);
  const lid = (T(r).match(/\[([a-z0-9-]+)\]/) ?? [])[1];
  const lrec = lid ? ag.foldRecord(lid) : null;
  ok(!r.isError && [...ag.entities.keys()].length === b2 + 1 && lrec?.comp?.light?.intensity === 8 && Number.isFinite(lrec?.pos?.[1]) && lrec.pos[1] > 1, "AT5b create {components: {light}} with nowhere said: one new light, in front of you at about eye height", [T(r), lrec?.pos]);
  const r2 = await call("create", { components: { light: { color: 0xff5533 } }, at: [1, 2.5, 1] }); await sleep(200);
  const lid2 = (T(r2).match(/\[([a-z0-9-]+)\]/) ?? [])[1]; const p2 = lid2 ? ag.foldRecord(lid2)?.pos : null;
  ok(!r2.isError && Array.isArray(p2) && Math.abs(p2[0] - 1) < 0.01 && Math.abs(p2[1] - 2.5) < 0.01 && Math.abs(p2[2] - 1) < 0.01, "AT5c create {…, at: [x, y, z]} puts it exactly there (no model, so no place solve)", [T(r2), p2]);
  const e = await call("edit", { id: lid2, set: { "light.intensity": 24 } }); await sleep(200);
  ok(!e.isError && ag.foldRecord(lid2)?.comp?.light?.intensity === 24 && ag.foldRecord(lid2)?.comp?.light?.color === 0xff5533, "AT5d edit {\"light.intensity\"} dims it and keeps its colour (the old light-update path)", [T(e), ag.foldRecord(lid2)?.comp?.light]);
  const del = await call("act", { verb: "delete", args: { id: lid2 } }); await sleep(200);
  ok(!del.isError && !ag.foldRecord(lid2), "AT5e act delete removes it (the remove tool folded)", T(del).slice(0, 200)); }

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
  const no = await call("act", { verb: "shove", args: { target: "Vic" } });
  ok(no.isError && /shove/.test(T(no)) && /consent|nobody/.test(T(no)), "AT3a Vic's body is Normal: act shove is refused, and the tool says so as an error naming the class", T(no));
  ok((await vic.req("consent", { set: { class: "shove", tier: "strangers", mode: "everyone" } })).ok, "(AT3 setup) Vic opens shove to strangers");
  const k = vic.msgs.length; const yes = await call("act", { verb: "shove", args: { target: "Vic" } }); await sleep(300);
  ok(!yes.isError && vic.msgs.slice(k).some((m) => m.type === "puppet" && m.ragdoll), "AT3b once Vic allows it, the shove goes through and reports no error", [T(yes), vic.msgs.slice(k).map((m) => m.type)]);

  // ---- AT6: the folded modes, live ----
  // flight: this body wears no winged rig and holds no fly grant, so the honest answer is the refusal — through the MODE
  const fly = await call("move", { mode: "fly", altitude: 10 });
  ok(fly.isError && /cannot fly here/.test(T(fly)), "AT6a move {mode: \"fly\"} dispatches to the flight door (refused here: no grant, no wings — said in the integrator's words)", T(fly));
  const land = await call("act", { verb: "land", args: { to: [1, 1] } });
  ok(land.isError && /ground|cannot fly/.test(T(land)), "AT6b act land answers from the body (on the ground already), not the authority's 'unknown verb'", T(land));
  const bs = await call("body_state", {});
  ok(!bs.isError && /"flight"/.test(T(bs)) && /on the ground/.test(T(bs)), "AT6c body_state carries the flight status (flight_status folded)", T(bs).slice(0, 300));
  // the body cluster
  const sit = await call("pose", { posture: "sit" });
  ok(!sit.isError && /sit down/.test(T(sit)) && ag.clip === "sit", "AT6d pose {posture: \"sit\"} sits (posture folded)", [T(sit), ag.clip]);
  const stand = await call("pose", { posture: "stand" });
  ok(!stand.isError && /stand up/.test(T(stand)), "AT6d …and stand", T(stand));
  const posed = await call("pose", { bones: { head: [0, 0.2, 0, 0.98] }, hold: true });
  const cleared = await call("pose", { clear: true });
  ok(!posed.isError && !cleared.isError && /released/.test(T(cleared)) && ag.heldPose == null, "AT6e pose {clear: true} releases a held pose (clear_pose folded)", [T(posed).slice(0, 80), T(cleared), ag.heldPose]);
  // ragdoll = a body going limp: pose {ragdoll: true} (R 10-14: one vocabulary with the browser;: shoving is moving someone else; going limp is a body state)
  const limp = await call("pose", { ragdoll: true });
  ok(!limp.isError && /limp|down/.test(T(limp)) && ag.clip === "ragdoll", "AT6p pose {ragdoll: true} drops your own body limp (clip ragdoll)", [T(limp), ag.clip]);
  const up = await call("pose", { posture: "stand" });
  ok(!up.isError && ag.clip !== "ragdoll", "AT6p …and standing picks it back up", [T(up), ag.clip]);
  const k2 = vic.msgs.length; const theirs = await call("pose", { ragdoll: true, target: "Vic" }); await sleep(300);
  ok(!theirs.isError && vic.msgs.slice(k2).some((m) => m.type === "puppet" && m.ragdoll === true), "AT6q pose {ragdoll: true, target} asks THEIR body to go limp (an undirected ragdoll, not a shove)", [T(theirs), vic.msgs.slice(k2).map((m) => m.type)]);
  const wings = await call("pose", { wings: "fold" });
  ok(!wings.isError && /wings/.test(T(wings)), "AT6f pose {wings: \"fold\"} reaches the wing posture (this body: none to fold, said)", T(wings));
  const letgo = await call("reach", { release: true });
  ok(!letgo.isError && /releas|let go|weren't reaching/.test(T(letgo)), "AT6g reach {release: true} lets go (clear_reach folded; nothing held: said)", T(letgo));
  // the library
  // the sequencer's search walks eidoverse/assets/models only (server/routes.ts /library-models), and this scratch OPT_DIR
  // has none there: the honest answers are "no matches" and an empty sheet — the dispatch is what this bench can prove
  const lib = await call("library", { query: "cup" });
  ok(!lib.isError && /no matches|\.glb/.test(T(lib)), "AT6h library {query} searches models (list_library folded)", T(lib));
  const sheet = await call("library", { kind: "models" });
  ok(!sheet.isError && (sheet.content.some((c) => c.type === "image") || /0 models/.test(T(sheet))), "AT6i library {kind} is the contact sheet (library_sheet folded)", T(sheet));
  const none = await call("library", {});
  ok(none.isError && /query/.test(T(none)) && /preview/.test(T(none)), "AT6i …and library with nothing teaches its three forms", T(none));
  const prev = await call("library", { preview: "test/cup.glb" });
  ok(!prev.isError && (prev.content.some((c) => c.type === "image") || /no preview/.test(T(prev))), "AT6j library {preview} is one item (library_preview folded)", T(prev));
  // walking by name (socketteer's walk-by-place-name, as move {to: <name>}): a thing's id walks you up to it
  const mp = ag.foldRecord("mug")?.pos;
  const byName = await call("move", { to: "mug" });   // walking: a run this long rides the authority's token bucket at its edge (walkTo pacing, not this tool's)
  ok(!byName.isError && /arrived/.test(T(byName)) && Math.hypot(ag.pos.x - mp[0], ag.pos.z - mp[2]) < 1.2 && Math.hypot(ag.pos.x - mp[0], ag.pos.z - mp[2]) > 0.3, "AT6k move {to: \"mug\"} walks up to the thing and stops beside it", [T(byName), ag.pos, mp]);
  const noName = await call("move", { to: "no-such-thing" });
  ok(noName.isError && /no-such-thing/.test(T(noName)), "AT6k …and an unknown name is an error naming it", T(noName));
  // moderation through act: the agent becomes an owner, kicks Vic by NAME (resolved to an identity), reads what's in force, unbans
  ok((await ann.req("set", { id: "@world", component: `roles:${HEP}`, value: { role: "owner" } })).ok, "(AT6 setup) Ann makes the agent an owner");
  await sleep(300);
  const kicked = await call("act", { verb: "kick", args: { who: "Vic", minutes: 5, reason: "test" } }); await sleep(300);
  ok(!kicked.isError && /done|kick/.test(T(kicked)) && /u-/.test(T(kicked)), "AT6l act kick {who: a name} resolves the name to an identity and the authority does it", T(kicked));
  const inforce = await call("act", { verb: "bans" });
  ok(!inforce.isError && /Vic|cooling/.test(T(inforce)), "AT6m act bans lists the cooldown in force (list_bans folded)", T(inforce));
  const lifted = await call("act", { verb: "unban", args: { who: "Vic" } });
  ok(!lifted.isError && /done|unban/.test(T(lifted)), "AT6n act unban lifts it (a kick's cooldown too)", T(lifted));
  const nobody = await call("act", { verb: "ban", args: { who: "Nobody-Here" } });
  ok(nobody.isError && /Nobody-Here/.test(T(nobody)), "AT6o act ban of a name the world never saw is an error naming it", T(nobody));
  vic.close(); }

// ---- AT5: look points at the real tool ----
{ ok((await ann.req("create", { id: "post", model: "test/cup.glb", components: { transform: { pos: [12, 0, 0], q: [0, 0, 0, 1], scale: [1, 1, 1] }, lock: true, hidden: true } })).ok, "(AT5 setup) a locked, hidden post");
  for (let i = 0; i < 60 && !ag.entities.has("post"); i++) await sleep(50);
  const line = T(await call("look")).split("\n").find((l) => /\[post\]/.test(l)) ?? "";
  ok(/locked/.test(line) && /edit \{id: "post", set: \{"flags\.lock": false\}\}/.test(line) && /edit \{id: "post", set: \{"flags\.hidden": false\}\}/.test(line) && !/act \{verb: "delete"/.test(line), "AT5 look teaches edit flags.lock / flags.hidden, not act delete", line);
  const un = await call("edit", { id: "post", set: { "flags.lock": false, "flags.hidden": false } }); await sleep(200);
  ok(!un.isError && !ag.foldRecord("post")?.lock && !ag.foldRecord("post")?.hidden, "AT5 …and what it teaches works", T(un)); }

ag.close(); ann.close();
console.log(`agenttools: ${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
