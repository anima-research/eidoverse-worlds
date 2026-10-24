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
//   AT8  a dropped agent dials again on shared/redial.js's schedule (reset by the join), not a fixed 1.5 s (review r5 F4)
//   AT7  an agent is a body under the same consent as a person (its table on join; no `pushable`; say takes `to`)
//   AT9  an alias runs the new tool with the OLD argument shape (walk_to, spawn, world_verb, snapshot); renumbered from a
//        second AT7 (claims r10 O4)
// @ts-nocheck
import fs from "node:fs";
import path from "node:path";
import { ENGINE, scratch } from "./common.ts";
import { tryUntil, pause } from "./wait.ts";

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
const { HANDLERS, TOOLS, TOOL_ALIASES, toolList, handleTool: handleToolDoor } = await import("../../mcpl/tools.ts");
{ const listed = [...toolList({ travel: true }), ...toolList({ travel: false })];
  const HINTS = ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"];
  const bad = listed.filter((t) => typeof t.title !== "string" || !t.title.trim() || !t.annotations || HINTS.some((h) => typeof t.annotations[h] !== "boolean"));
  ok(listed.length > 28 && !bad.length, "AT4 every advertised tool has a title and all four annotation hints", bad.map((t) => t.name));
  ok(TOOLS.every((t) => t.annotations?.title === undefined || t.annotations.title === t.title), "AT4 (a title said once: the tool's own, not a second one in annotations)");
  const by = Object.fromEntries(TOOLS.map((t) => [t.name, t.annotations ?? {}]));
  const reads = ["look", "inspect", "measure", "world_history", "world_debug", "hierarchy", "blueprints", "whois", "body_state", "screenshot", "library", "worlds", "catch_up"];
  ok(reads.every((n) => by[n]?.readOnlyHint === true && by[n]?.destructiveHint === false), "AT4 the reads are read-only and not destructive", reads.filter((n) => !(by[n]?.readOnlyHint === true && by[n]?.destructiveHint === false)));
  const writes = ["move", "create", "place", "edit", "act", "say", "attach", "travel", "set_avatar", "anim", "reach"];
  ok(writes.every((n) => by[n]?.readOnlyHint === false), "AT4 everything that changes the world or a body is not read-only", writes.filter((n) => by[n]?.readOnlyHint !== false));
  ok(["act", "edit"].every((n) => by[n]?.destructiveHint === true) && ["create", "say", "move"].every((n) => by[n]?.destructiveHint === false), "AT4 act (delete, kick, ban…) and editing in place are destructive; making, saying and walking are not",
    Object.fromEntries(["act", "edit", "create", "say", "move"].map((n) => [n, by[n]?.destructiveHint])));
  ok(["say", "act", "anim"].every((n) => by[n]?.openWorldHint === true) && !by.whisper && ["look", "inspect", "move"].every((n) => by[n]?.openWorldHint === false), "AT4 what reaches other people is open-world; reading the world and walking in it are not");
  // the stdio host adds one tool of its own (mcpl/server.ts can't be imported here: it connects at load)
  const src = fs.readFileSync(path.join(ENGINE, "mcpl/server.ts"), "utf8");
  const pp = src.slice(src.indexOf("const PENDING_PINGS_TOOL"), src.indexOf("};", src.indexOf("const PENDING_PINGS_TOOL")));
  ok(/title:/.test(pp) && HINTS.every((h) => new RegExp(`${h}:\\s*(true|false)`).test(pp)), "AT4 …and the stdio host's own pending_pings tool too", pp.slice(0, 400));
  // AT3 / AT2 descriptions
  const desc = Object.fromEntries(TOOLS.map((t) => [t.name, t.description]));
  ok(!/default for agent performers/.test(desc.act) && /owner's call \(their consent switch/.test(desc.act) && /shove \{target/.test(desc.act), "AT3 act's shove says the body's owner decides, the same for every body (no agent default)", desc.act.slice(0, 200));
  // ---- AT6: the surface itself ----
  const names = TOOLS.map((t) => t.name);
  const folded = ["take_off", "climb_to", "glide_to", "land_at", "rehearse_down", "rehearse_recover", "fold_wings", "unfold_wings", "flight_status",
    "clear_pose", "clear_reach", "posture", "ragdoll", "library_sheet", "library_preview", "list_library", "light", "remove", "blueprint_place", "kick", "ban", "unban", "list_bans"];
  ok(names.length <= 32 && names.length >= 28, `AT6 the table is ~30 tools (${names.length})`, names);
  ok(!folded.some((n) => names.includes(n)), "AT6 none of the folded names is a tool of its own", folded.filter((n) => names.includes(n)));
  ok(["move", "act", "anim", "reach", "library", "set_avatar", "create", "edit", "body_state"].every((n) => names.includes(n)) && !Object.keys(TOOL_ALIASES).filter((n) => TOOL_ALIASES[n] === "anim").some((n) => names.includes(n)) && Object.values(TOOL_ALIASES).filter((v) => v === "anim").length === 4, "AT6 the general tools they folded into exist (anim: R 10-17 15:31; the four old body tools are hidden aliases of it)");
  ok(/mode/.test(desc.move) && /fly/.test(desc.move) && /altitude/.test(desc.move) && /name/.test(desc.move), "AT6 move documents mode: \"fly\" (altitude) and to: <a name>", desc.move.slice(0, 300));
  ok(/land/.test(desc.act) && /kick/.test(desc.act) && /\bbans\b/.test(desc.act) && /delete/.test(desc.act), "AT6 act documents land, kick/ban/unban/bans and delete", desc.act.slice(0, 200));
  ok(/wings-folded/.test(desc.anim) && /stop/.test(desc.anim) && /mode/.test(desc.anim) && /joints/.test(desc.anim) && /tracks/.test(desc.anim), "AT6 anim documents names (wings-folded), mode, joints, tracks and stop");
  ok(/release/.test(desc.reach), "AT6 reach documents release");
  ok(/query/.test(desc.library) && /preview/.test(desc.library) && /sheet|page/.test(desc.library), "AT6 library documents query, preview and the sheet");
  ok(/light/.test(desc.create) && /\bat\b/.test(desc.create), "AT6 create documents a light and at");
  const { resolveTool, handleTool } = await import("../../mcpl/tools.ts");
  ok(resolveTool("set_avatar")?.name === "set_avatar" && resolveTool("wear") === null && resolveTool("walk_to")?.name === "move", "AT6 set_avatar keeps its name (R: unambiguous; wear could mean a hat), the old renames still alias");
  ok(/ragdoll: true/.test(desc.anim) && !/limp: true/.test(desc.anim) && !/shove \{target/.test(desc.anim) && /shove \{target/.test(desc.act), "AT6 anim documents ragdoll (one vocabulary with the browser: a body going limp); the push's form (shove {target…}) is act's alone");
  ok(resolveTool("take_off") === null && resolveTool("kick") === null, "AT6 a folded tool does not resolve to a handler (it folded, it was not renamed)");
  const gone = await handleTool({ agent: null } as any, "take_off", {});
  ok(gone.isError && /move \{mode: "fly"/.test(gone.content[0].text), "AT6 calling a folded name teaches where it went", gone.content[0].text);
  const gone2 = await handleTool({ agent: null } as any, "kick", {});
  ok(gone2.isError && /act \{verb: "kick"/.test(gone2.content[0].text), "AT6 …kick too", gone2.content[0].text);
  { // AT7 (parity sweep 10-14): an agent is a body under the same consent as a person. It sends its table on join (the
    // server's default preset by NAME, never a literal), carries no private "pushable" flag, and can address someone through say.
    const agentSrc = fs.readFileSync(path.join(ENGINE, "mcpl/agent.ts"), "utf8"), toolsSrc = fs.readFileSync(path.join(ENGINE, "mcpl/tools.ts"), "utf8");
    ok(!/\bpushable\b/.test(agentSrc), "AT7a agent.ts has no `pushable` flag: the authority's consent table is the one answer to a shove");
    // It pins the default's NAME in the table the agent starts with. Every arrival sends that table as a person's client
    // does: it reads what the authority holds and sets each cell that differs, never a preset, which empties the cells
    // (review of #260). The arrival calls replaySwitch() (lifted out for house 6340433633); that method is read here.
    const at = agentSrc.indexOf("async replaySwitch()"), end = agentSrc.indexOf("\n  }", at);
    const arrival = at < 0 || end < 0 || !/void this\.replaySwitch\(\)/.test(agentSrc) ? "" : agentSrc.slice(at, end);
    ok(/this\.request\("consent", \{\}\)/.test(arrival) && /this\.request\("consent", \{ switch: want \}\)/.test(arrival) && !/\bpreset\b|\{ set \}/.test(arrival) && !/DEFAULT_PRESET/.test(agentSrc),
      "AT7b (recut A2) an arrival reads the authority and sends the agent's switch only if it differs; no preset, no cells", arrival.slice(0, 300));
    const sayTool = toolsSrc.slice(toolsSrc.indexOf('name: "say"'), toolsSrc.indexOf('name: "say"') + 1200);
    ok(/\bto: \{ type: "string"/.test(sayTool) && /say\(text: string, extra\?: \{[^}]*\bto\?: string/.test(agentSrc), "AT7c say takes `to` on both the tool's schema and ag.say (the client sends it; the authority logs it)");
  }
  { // AT8 (parity sweep 10-14, verified 19:19): kick/ban/unban resolved a person by NAME through whois, while mute/unmute/
    // warn/ghost/unghost went through bare `act` and took only a raw identity — two ways to say who. One resolver, used by
    // both the kick family and `act` for every verb whose arguments name a `who`.
    const toolsSrc = fs.readFileSync(path.join(ENGINE, "mcpl/tools.ts"), "utf8");
    ok(/async function resolveWho\(/.test(toolsSrc), "AT8a tools.ts has ONE resolveWho (name or u-… → identity, via whois)");
    ok((toolsSrc.match(/await ag\.request\("whois", \{ name/g) ?? []).length === 2, "AT8b whois-by-name is called from exactly two places — the resolver and the whois tool itself — not once per verb");
    ok(/Object\.hasOwn\(BODY_VERBS, verb\)\) return[\s\S]{0,400}resolveWho\(/.test(toolsSrc.slice(toolsSrc.indexOf("act: async"))), "AT8c `act` resolves args.who through the resolver before sending a who-taking verb");
    ok(!/sky, weather, terrain and grass verbs/.test(toolsSrc), "AT8d inspect's description no longer cites the sky/weather/terrain/grass verbs (they are `edit {id: \"@world\"}` now)");
  }
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
const up = !!(await tryUntil("the server answers /version", async () => (await fetch(`http://127.0.0.1:${port}/version`, { signal: AbortSignal.timeout(800) })).ok, { ms: 76_000, step: 150 }));
ok(up, "(setup) the server is up");

async function sock(name) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`); const msgs = [];
  ws.onmessage = (ev) => msgs.push(JSON.parse(String(ev.data)));
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  ws.send(JSON.stringify({ type: "join", world: "yard", id: name, avatar: "", replica: true }));
  await tryUntil(`${name}'s join is answered`, () => msgs.some((m) => m.type === "snapshot" || m.type === "error"), { ms: 4000, step: 50 });
  const snap = msgs.find((m) => m.type === "snapshot"); let rn = 0;
  return { ws, msgs, snap, actor: snap?.cut?.you ?? null, close: () => ws.close(),
    at: (x, z) => ws.send(JSON.stringify({ type: "pose", pose: { p: [x, 0, z], yaw: 0, speed: 0, clip: "idle" } })),
    req: async (verb, args = {}) => { const id = `q${++rn}`; ws.send(JSON.stringify({ type: "request", id, verb, args }));
      const r = await tryUntil(`the reply to ${verb}`, () => msgs.find((m) => m.type === "reply" && m.id === id), { ms: 4000, step: 50 }); return r ? r.reply : { ok: false, timeout: true }; } };
}

const ann = await sock("Ann");
const { WorldAgent } = await import("../../mcpl/agent.ts");
const ag = new WorldAgent({ url: `ws://127.0.0.1:${port}/ws`, name: "Hep", world: "yard", avatar: "" });
await ag.connect(); await tryUntil("the agent has its cut", () => ag.cut, { ms: 3000, step: 50 });
const HEP = ag.cut?.you;
ok(/^u-/.test(HEP ?? "") && ag.replica?.active, "(setup) the agent joins and folds the world", ag.cut);
ok((await ann.req("set", { id: "@world", component: `roles:${HEP}`, value: { role: "builder" } })).ok, "(setup) Ann makes the agent a builder");
// R 10-17: a writer never chooses an id. Ann names each thing with a placeholder and a label; the authority mints its id
// (ID[name]); the agent's tools reach it by that label, by its handle, or by any unique prefix of its id
const ID: Record<string, string> = {};
const make = async (name: string, args: any) => { const r = await ann.req("create", { ...args, id: `$${name}`, components: { ...(args.components ?? {}), label: name } }); if (r?.ids?.[`$${name}`]) ID[name] = r.ids[`$${name}`]; return r; };
ok((await make("wall", { model: "test/wall.glb", components: { transform: { pos: [0, 0, 3], q: [0, 0, 0, 1], scale: [1, 1, 1] } } })).ok, "(setup) Ann builds a wall across z = 3");
ok((await make("mug", { model: "test/cup.glb", components: { transform: { pos: [6.4, 0, 0], q: [0, 0, 0, 1], scale: [1, 1, 1] }, grabbable: { who: "inhabitant" } } })).ok, "(setup) …and a mug anyone may carry, at x = 6.4");
await tryUntil("the agent holds the wall and the mug", () => ag.entities.has(ID.wall) && ag.entities.has(ID.mug), { ms: 3000, step: 50 });
ok(/^[a-z2-7]{26}$/.test(ID.mug ?? ""), "(setup) the authority minted the mug an opaque id", ID);
const call = (name, a = {}) => handleToolDoor({ agent: ag, canPush: () => false, heldActivity: [], cursor: { caughtUpTo: null } }, name, a);   // through the door a host uses (aliases included)

// ---- AT5: a light is create {components: {light}} (the light tool folded; #216's id rule rides create's own) ----
{ const before = [...ag.entities.keys()].length;
  for (const id of ["", "   ", 4, [], {}]) {
    const r = await call("create", { id, components: { light: { intensity: 8 } } });
    ok(r.isError && /id/.test(T(r)), `AT5a create refuses a given id that isn't a non-empty string, in its own words: ${JSON.stringify(id)}`, T(r));
  }
  await pause("refused creates have had their chance to mint something (they must not)", 300);
  ok([...ag.entities.keys()].length === before, "AT5a …and minted nothing for them", [...ag.entities.keys()].length - before);
  const b2 = [...ag.entities.keys()].length;
  const r = await call("create", { components: { light: { intensity: 8 } } });
  await tryUntil("the agent holds the new light", () => [...ag.entities.keys()].length !== b2, { ms: 2000, step: 50 });
  const lid = (T(r).match(/ id ([a-z2-7]{26})/) ?? [])[1];
  const lrec = lid ? ag.foldRecord(lid) : null;
  ok(!r.isError && [...ag.entities.keys()].length === b2 + 1 && lrec?.light?.intensity === 8 && Number.isFinite(lrec?.pos?.[1]) && lrec.pos[1] > 1, "AT5b create {components: {light}} with nowhere said: one new light, in front of you at about eye height", [T(r), lrec?.pos]);
  const r2 = await call("create", { components: { light: { color: 0xff5533 } }, at: [1, 2.5, 1] });
  await tryUntil("the second light is in the agent's fold", () => { const id = (T(r2).match(/ id ([a-z2-7]{26})/) ?? [])[1]; return id && ag.foldRecord(id); }, { ms: 2000 });
  const lid2 = (T(r2).match(/ id ([a-z2-7]{26})/) ?? [])[1]; const p2 = lid2 ? ag.foldRecord(lid2)?.pos : null;
  ok(!r2.isError && Array.isArray(p2) && Math.abs(p2[0] - 1) < 0.01 && Math.abs(p2[1] - 2.5) < 0.01 && Math.abs(p2[2] - 1) < 0.01, "AT5c create {…, at: [x, y, z]} puts it exactly there (no model, so no place solve)", [T(r2), p2]);
  const e = await call("edit", { id: lid2, set: { "light.intensity": 24 } });
  await tryUntil("the light is dimmed to 24 in the agent's fold", () => ag.foldRecord(lid2)?.light?.intensity === 24, { ms: 2000 });
  ok(!e.isError && ag.foldRecord(lid2)?.light?.intensity === 24 && ag.foldRecord(lid2)?.light?.color === 0xff5533, "AT5d edit {\"light.intensity\"} dims it and keeps its colour (the old light-update path)", [T(e), ag.foldRecord(lid2)?.light]);
  const del = await call("act", { verb: "delete", args: { id: lid2 } });
  await tryUntil("the light is gone from the agent's fold", () => !ag.foldRecord(lid2), { ms: 2000 });
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
  const put = await call("act", { verb: "put", args: { id: "mug" } });
  await tryUntil("the mug is down near x = 10 in the agent's fold", () => Math.abs(ag.foldRecord(ID.mug)?.pos?.[0] - 10) < 1.6, { ms: 3000 });
  const mx = ag.foldRecord(ID.mug)?.pos?.[0];
  ok(!put.isError && Number.isFinite(mx) && Math.abs(mx - 10) < 1.6, "AT1c …and puts it down where it IS (x≈10), not where the authority last saw it (the probe's 'two bodies')", [T(put).slice(0, 200), ag.foldRecord(ID.mug)?.pos]);
  // a body moved without walking (a flight, a seat, a drag): the authority's track is stale; the next walk re-arrives it
  ag.pos.x = 10; ag.pos.z = -9;
  const stale = await call("move", { to: [10, -8] });
  ok(!stale.isError && /placed you here directly/.test(T(stale)) && Math.abs(ag.pos.z + 8) < 0.05, "AT1d after a move that wasn't a walk, the next walk re-arrives the authority's body there (a teleport, said) and walks on", T(stale));
  // a visitor in a world with a spawn arrives at the spawn, as a person does
  ok((await ann.req("set", { id: "@world", component: "spawn", value: { pos: [-8, 0, -8], radius: 2 } })).ok, "(AT1e setup) Ann gives the yard a spawn at (-8, -8)");
  // the spawn binds those who can't build (bodyverbs: a builder may arrive anywhere), and a new world's newcomers build (R 10-21)
  ok((await ann.req("set", { id: "@world", component: "default-role", value: { role: "inhabitant" } })).ok, "(AT1e setup) the yard's newcomers are inhabitants");
  const vee = new WorldAgent({ url: `ws://127.0.0.1:${port}/ws`, name: "Vee", world: "yard", avatar: "" });
  await vee.connect(); await tryUntil("Vee's replica is active", () => vee.replica?.active, { ms: 3000, step: 50 });
  const vm = await HANDLERS.move(vee, { to: [-6, -8], run: true }, { agent: vee, canPush: () => false, heldActivity: [], cursor: { caughtUpTo: null } }, "move");
  ok(!vm.isError && /spawn/.test(T(vm)) && Math.abs(vee.pos.x + 6) < 0.05 && Math.abs(vee.pos.z + 8) < 0.05, "AT1e an inhabitant's first walk in a world with a spawn arrives there and walks on (not stuck behind 'spawn')", [T(vm), vee.pos]);
  vee.close(); }

// ---- AT2: duplicate from the tool ----
{ const d1 = await call("create", { from: "mug", at: [8, 2] });   // by its label
  await tryUntil("the copy is in the agent's fold", () => { const id = (T(d1).match(/ id ([a-z2-7]{26})/) ?? [])[1]; return id && ag.foldRecord(id); }, { ms: 2000 });
  const made = (T(d1).match(/ id ([a-z2-7]{26})/) ?? [])[1];
  const p = made ? ag.foldRecord(made)?.pos : null;
  ok(!d1.isError && made && made !== ID.mug && Array.isArray(p) && Math.abs(p[0] - 8) < 0.01 && Math.abs(p[2] - 2) < 0.01, "AT2a create {from: <label>, at: [x, z]} duplicates the thing there", [T(d1), p]);
  // the copy wears the label too: "mug" now names two things, and a lookup by it is refused with both (R 10-17), never one picked
  const amb = await call("create", { from: "mug" });
  ok(amb.isError && /"mug" is the label of 2 things/.test(T(amb)) && T(amb).includes(`[${ag.handle(ID.mug)}]`) && T(amb).includes(`[${ag.handle(made)}]`), "AT2d a label two things share is refused with the candidates (label, what, where, handle)", T(amb));
  const d2 = await call("create", { from: ag.handle(ID.mug) });   // by its handle
  await tryUntil("the second copy is in the agent's fold", () => { const id = (T(d2).match(/ id ([a-z2-7]{26})/) ?? [])[1]; return id && ag.foldRecord(id); }, { ms: 2000 });
  const made2 = (T(d2).match(/ id ([a-z2-7]{26})/) ?? [])[1];
  ok(!d2.isError && made2 && made2 !== made && ag.foldRecord(made2), "AT2b create {from: <handle>} with no at puts the copy beside its source", T(d2));
  const d3 = await call("create", { from: ID.mug.slice(0, 9), at: { pos: [9, 0, 2] } });   // by a longer prefix of its id
  ok(!d3.isError, "AT2c …and the authority's own {pos, yaw|q} still passes through (a unique id prefix names the source)", T(d3));
  const chosen = await call("create", { id: "my-mug", model: "test/cup.glb" });
  ok(chosen.isError && /mint/.test(T(chosen)) && /\$my-mug/.test(T(chosen)), "AT2e an id the agent chooses is refused, and the words name the placeholder", T(chosen)); }

// ---- AT3: a refused shove is an error ----
{ const vic = await sock("Vic"); await sleep(200);
  vic.at(ag.pos.x + 1, ag.pos.z); await sleep(300);   // in reach (shove: 3 m)
  const sw = await vic.req("consent", { switch: "refuse" }); ok(sw?.ok, "(AT3 setup) Vic sets her body to refuse (recut A2: the default accepts)", sw);
  const no = await call("act", { verb: "shove", args: { target: "Vic" } });
  ok(no.isError && /shove/.test(T(no)) && /consent|nobody/.test(T(no)), "AT3a Vic's body refuses: act shove is refused, and the tool says so as an error naming the class", T(no));
  ok((await vic.req("consent", { switch: "accept" })).ok, "(AT3 setup) Vic sets her body back to accept");
  const k = vic.msgs.length; const yes = await call("act", { verb: "shove", args: { target: "Vic" } });
  await tryUntil("Vic is sent the shove's ragdoll", () => vic.msgs.slice(k).some((m) => m.type === "puppet" && m.ragdoll), { ms: 3000 });
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
  const sit = await call("anim", { name: "sit" });
  ok(!sit.isError && /"playing":"sit","mode":"loop"/.test(T(sit)) && ag.clip === "sit", "AT6d anim {name: \"sit\"} sits, looped (its own mode)", [T(sit), ag.clip]);
  const stand = await call("pose", { posture: "stand" });
  ok(!stand.isError && /pose is now called anim/.test(T(stand)) && /"playing":"stand"/.test(T(stand)) && ag.clip === "idle", "AT6d …the old pose {posture: \"stand\"} answers as anim {name: \"stand\"}", [T(stand), ag.clip]);
  const posed = await call("anim", { joints: { head: [0, 0.2, 0, 0.98] }, hold: true });
  const cleared = await call("anim", { stop: true });
  ok(!posed.isError && /"playing":"live","mode":"hold"/.test(T(posed)) && !cleared.isError && ag.heldPose == null, "AT6e anim {joints} holds a live frame; anim {stop: true} releases it (clear_pose folded)", [T(posed).slice(0, 120), T(cleared), ag.heldPose]);
  // ragdoll = a body going limp: pose {ragdoll: true} (R 10-14: one vocabulary with the browser;: shoving is moving someone else; going limp is a body state)
  const limp = await call("anim", { ragdoll: true });
  ok(!limp.isError && /limp|down/.test(T(limp)) && ag.clip === "ragdoll", "AT6p anim {ragdoll: true} drops your own body limp (clip ragdoll)", [T(limp), ag.clip]);
  const up = await call("anim", { name: "stand" });
  ok(!up.isError && ag.clip !== "ragdoll", "AT6p …and standing picks it back up", [T(up), ag.clip]);
  const k2 = vic.msgs.length; const theirs = await call("anim", { ragdoll: true, target: "Vic" });
  await tryUntil("Vic is asked to go limp", () => vic.msgs.slice(k2).some((m) => m.type === "puppet" && m.ragdoll === true), { ms: 3000 });
  ok(!theirs.isError && vic.msgs.slice(k2).some((m) => m.type === "puppet" && m.ragdoll === true), "AT6q anim {ragdoll: true, target} asks THEIR body to go limp (an undirected ragdoll, not a shove)", [T(theirs), vic.msgs.slice(k2).map((m) => m.type)]);
  const wings = await call("pose", { wings: "fold" });
  // this body's bones aren't known here, so nothing folds: the door answers that as failed, in the fold's words
  ok(wings.isError && /wings unchanged/.test(T(wings)) && /pose is now called anim/.test(T(wings)), "AT6f the old pose {wings: \"fold\"} answers as anim {name: \"wings-folded\"} (this body: nothing folded, failed, in the fold's words)", T(wings));
  const letgo = await call("reach", { release: true });
  ok(!letgo.isError && /releas|let go|weren't reaching/.test(T(letgo)), "AT6g reach {release: true} lets go (clear_reach folded; nothing held: said)", T(letgo));
  // the library
  // the sequencer's search walks eidoverse/assets/models only (server/routes.ts /library-models): under the library checkout
  // (EIDOVERSE_DIR, ../eidoverse-video by default) when the host has one, and this scratch OPT_DIR has none. With no
  // library the honest answers are "no matches" and the sheet's own words for nothing ("there are no models to show
  // yet": Antra's run of f91840e5 had no library and this read "0 models", wording the tool never printed). The dispatch
  // is what this bench can prove; EIDOVERSE_DIR=<an empty dir> runs the no-library branch
  const lib = await call("library", { query: "cup" });
  ok(!lib.isError && /no matches|\.glb/.test(T(lib)), "AT6h library {query} searches models (list_library folded)", T(lib));
  const sheet = await call("library", { kind: "models" });
  ok(!sheet.isError && (sheet.content.some((c) => c.type === "image") || /^there are no models to show yet$/.test(T(sheet))), "AT6i library {kind} is the contact sheet (library_sheet folded)", T(sheet));
  const none = await call("library", {});
  ok(none.isError && /query/.test(T(none)) && /preview/.test(T(none)), "AT6i …and library with nothing teaches its three forms", T(none));
  const prev = await call("library", { preview: "test/cup.glb" });
  // a preview the library can't give is failed, said; an image is the call done
  ok(prev.content.some((c) => c.type === "image") ? !prev.isError : prev.isError && /no preview/.test(T(prev)), "AT6j library {preview} is one item (library_preview folded; none here: failed, said)", T(prev));
  // walking by name (socketteer's walk-by-place-name, as move {to: <name>}): a thing's id walks you up to it
  const mp = ag.foldRecord(ID.mug)?.pos;
  const byName = await call("move", { to: ag.handle(ID.mug) });   // its handle ("mug" names its copies too since AT2)   // walking: a run this long rides the authority's token bucket at its edge (walkTo pacing, not this tool's)
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
{ ok((await make("post", { model: "test/cup.glb", components: { transform: { pos: [12, 0, 0], q: [0, 0, 0, 1], scale: [1, 1, 1] }, lock: true, hidden: true } })).ok, "(AT5 setup) a locked, hidden post");
  await tryUntil("the agent holds the post", () => ag.entities.has(ID.post), { ms: 3000, step: 50 });
  const h = ag.handle(ID.post);
  const line = T(await call("look")).split("\n").find((l) => l.includes(`[${h}]`)) ?? "";
  ok(h.length >= 4 && h.length < 26 && ID.post.startsWith(h) && /"post"/.test(line) && !line.includes(ID.post), "AT5a look reads a thing by its label, what it is and a short handle (a unique prefix of its id, never the whole 26)", [h, line]);
  ok(/locked/.test(line) && line.includes(`edit {id: "${h}", set: {"flags.lock": false}}`) && line.includes(`edit {id: "${h}", set: {"flags.hidden": false}}`) && !/act \{verb: "delete"/.test(line), "AT5 look teaches edit flags.lock / flags.hidden, not act delete", line);
  const un = await call("edit", { id: "post", set: { "flags.lock": false, "flags.hidden": false } });   // by its label
  await tryUntil("the post is unlocked and shown in the agent's fold", () => !ag.foldRecord(ID.post)?.lock && !ag.foldRecord(ID.post)?.hidden, { ms: 2000 });
  ok(!un.isError && !ag.foldRecord(ID.post)?.lock && !ag.foldRecord(ID.post)?.hidden, "AT5 …and what it teaches works (by its label too)", T(un)); }

// ---- AT9: an alias runs the new tool with the OLD argument shape (review 10-15 #5: walk_to {x, z} was a shape error) ----
{ const { handleTool } = await import("../../mcpl/tools.ts");
  const ctx = { agent: ag, canPush: () => false, heldActivity: [], cursor: { caughtUpTo: null } };
  const x0 = ag.pos.x, z0 = ag.pos.z;
  const w = await handleTool(ctx as any, "walk_to", { x: x0 + 1.5, z: z0, tolerance: 0.2 });
  ok(!w.isError && /is now called move/.test(T(w)) && Math.abs(ag.pos.x - (x0 + 1.5)) < 0.25, "AT9 walk_to {x, z, tolerance} walks the body (move {to}), and says the new name", { text: T(w).slice(0, 160), x: ag.pos.x, x0 });
  const n0 = ag.entities.size;
  const sp = await handleTool(ctx as any, "spawn", { lib: "test/cup.glb", x: x0 + 3, z: z0 + 3, id: "alias-cup" });
  const named = (n) => { const t = ag.thingRef(n); return "id" in t ? t.id : null; };   // the old spawn's id is the thing's label now (R 10-17)
  await tryUntil("the agent knows alias-cup", () => named("alias-cup"), { ms: 3000, step: 50 });
  ok(!sp.isError && !!named("alias-cup") && ag.entities.size === n0 + 1, "AT9 spawn {lib, x, z, id} creates the thing (create {model, at}, the id its label: the authority mints ids)", T(sp).slice(0, 200));
  // M1 (holes review 10-15): with a yaw the alias builds at {pos, yaw}, which buildCreate never read: ok, at the origin.
  // Mutation (must go red): drop the `a.at` branch in authority.js buildCreate.
  const spAt = async (args, id) => { const r = await handleTool(ctx as any, "spawn", { lib: "test/cup.glb", ...args, id }); await tryUntil(`the agent knows ${id}`, () => named(id), { ms: 3000, step: 50 }); return { r, rec: ag.foldRecord(named(id)) as any }; };
  const near = (p, x, z) => Array.isArray(p) && Math.abs(p[0] - x) < 0.05 && Math.abs(p[2] - z) < 0.05;
  const xz = await spAt({ x: x0 - 3, z: z0 + 3 }, "alias-cup-xz");
  ok(!xz.r.isError && near(xz.rec?.pos, x0 - 3, z0 + 3), "AT9 spawn {lib, x, z} lands at x, z (not the origin)", [T(xz.r).slice(0, 200), xz.rec?.pos]);
  const yw = await spAt({ x: x0 - 3, z: z0 - 3, yaw: 1 }, "alias-cup-yaw");
  const qy = [0, Math.sin(0.5), 0, Math.cos(0.5)];
  ok(!yw.r.isError && near(yw.rec?.pos, x0 - 3, z0 - 3) && Array.isArray(yw.rec?.q) && yw.rec.q.every((n, i) => Math.abs(n - qy[i]) < 1e-3), "AT9 spawn {lib, x, z, yaw} lands at x, z facing yaw (create {at: {pos, yaw}})", [T(yw.r).slice(0, 200), yw.rec?.pos, yw.rec?.q]);
  // review r2 F8: with a yaw and no y the alias put the origin at y 0 (create {at: {pos: [x, 0, z], yaw}}): never seated on
  // what's under x, z. Now it is place {at: [x, z], yaw}, the same seat as without a yaw: over the wall (top at 2.4) it lands ON it
  const ywOn = await spAt({ x: 1, z: 3, yaw: 1 }, "alias-cup-yaw-on");
  const noYaw = await spAt({ x: -1, z: 3 }, "alias-cup-on");
  ok(!ywOn.r.isError && near(ywOn.rec?.pos, 1, 3) && Math.abs(ywOn.rec?.pos?.[1] - 2.4) < 0.02 && Math.abs(noYaw.rec?.pos?.[1] - ywOn.rec?.pos?.[1]) < 1e-6
    && Array.isArray(ywOn.rec?.q) && ywOn.rec.q.every((n, i) => Math.abs(n - qy[i]) < 1e-3),
    "AT9 spawn {lib, x, z, yaw} over the wall sits on its top, like spawn without a yaw, facing yaw (review r2 F8)", [T(ywOn.r).slice(0, 200), ywOn.rec?.pos, ywOn.rec?.q, noYaw.rec?.pos]);
  const sq = await handleTool(ctx as any, "spawn", { query: "cup" });
  ok(sq.isError && /library \{query/.test(T(sq)), "AT9 spawn {query} is refused with the two calls that do it now", T(sq).slice(0, 200));
  const wv = await handleTool(ctx as any, "world_verb", { verb: "say", args: { text: "alias says" } });
  ok(!wv.isError && /is now called act/.test(T(wv)), "AT9 world_verb {verb, args} runs act", T(wv).slice(0, 160));
  const sn = await handleTool(ctx as any, "snapshot", { view: "third" });
  ok(/is now called screenshot/.test(T(sn)) && !/\bto\b.*required|shape/i.test(T(sn)), "AT9 snapshot {view} reaches screenshot with its own shape (no spectator here is fine; a shape error is not)", T(sn).slice(0, 160)); }

// ---- AT8 (review r5 F4): a dropped agent dials again on the browser's schedule (shared/redial.js), not a fixed 1.5 s ----
{ const rid = new WorldAgent({ url: `ws://127.0.0.1:${port}/ws`, name: "Rid", world: "yard", avatar: "" });
  await rid.connect(); await tryUntil("Rid has joined", () => rid.joined, { ms: 3000, step: 50 });
  const t0 = rid.redial?.tries;
  rid.ws.close(1000, "a drop");
  await tryUntil("Rid knows it was dropped", () => !rid.joined, { ms: 200, step: 10 });
  // the try is counted when the close is handled, which a loaded runner takes longer than a fixed 30 ms to get to (CI 10-23:
  // tries 0). Watch for it instead; the redial waits ≥ a connect, so a 5 ms poll sees 1 before the rejoin resets it
  await tryUntil("the drop counted one try", () => rid.redial?.tries === 1, { ms: 1500, step: 5 });
  ok(t0 === 0 && rid.redial?.tries === 1, "AT8 a dropped agent's next dial is the shared backoff's (one try counted)", { t0, tries: rid.redial?.tries });
  await tryUntil("Rid gets back in by itself", () => rid.joined, { ms: 4000, step: 50 });
  ok(rid.joined && rid.redial?.tries === 0, "AT8 …it gets back in by itself, and the join resets the backoff", { joined: rid.joined, tries: rid.redial?.tries });
  rid.close(); }

ag.close(); ann.close();
console.log(`agenttools: ${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
