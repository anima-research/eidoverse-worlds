// test/protocol/agenttools-check.ts — the agent's tools (mcpl/tools.ts HANDLERS on a real mcpl/agent.ts WorldAgent) against a
// real sequencer: scratch port, scratch WORLDS_DIR/OPT_DIR, TRUST_NAMES, never 8968/8970. Build mode v1's worst tool bugs
// (AUDIT-tools-vs-protocol 2026-10-07, AUDIT-human-agent-parity 2026-10-07). usage: bun test/protocol/agenttools-check.ts
//   AT1  E1 "two bodies": the agent's move walks the AUTHORITY's body (move steps, as a person's client streams them), so
//        a wall the authority calls solid stops it, and the hand verbs find it where it stands (grab/put after a walk)
//   AT2  create {from: <a thing's id>} duplicates from the tool (at as a point; with no at, beside its source), and its
//        description carries an example
//   AT3  act shove reports the server's refusal as an error naming the consent class (shove), and its description no longer
//        says agents are performers by default (every body is Normal)
//   AT4  every advertised tool carries a title and honest MCP annotations (readOnly / destructive / idempotent / openWorld)
//   AT5  a light is create {components: {light}} (AT5a–e)
//   AT6  the surface after the fold (REPOINT-PLAN 10-14 §4; R's standard 09:47: a name intuitive to everyone AND useful in
//        general situations, or it is an alias): ~30 tools; the flight nine are move {mode: "fly"} + act land; the body
//        sugar is anim {name|joints|ragdoll|stop} (pose is an unknown tool) / reach {release} / act shove; three library tools are one; moderation is
//        act {kick|ban|unban|bans}; light/remove/blueprint_place are create / act delete / create {from}; a folded name
//        resolves to no handler and is refused naming the call that does it now (tools.ts TOOL_FOLDS)
//   AT8  (AT8a–c) one resolveWho for every verb that names a `who`
//   AT7  an agent is a body under the same consent as a person (its table on join; no `pushable`; say takes `to`)
//   AT9  an old name runs nothing and is refused as an unknown tool (walk_to, spawn, snapshot); world_verb and main's old verbs
//        are refused as removed, naming the call that does it now (R 10-27)
//   AT10 catch_up says speech is arrival-only (decision table row 11)
//   AT12 /worlds lists agents apart again; the worlds tool counts humans and agents (decision table row 21)
//   AT11 a timed grant takes main's for: "2h" again through act set (decision table row 14)
//   AT13 yaw says its unit wherever an agent writes or reads it (#147): create's at in radians, measure in degrees (radians beside), edit's pos.yaw in degrees,
//        every angle in a tool schema, verb arg or component doc labelled, and PROTOCOL §9's rule covering verbs, notes and presence
//   AT14 look points at a real tool where one exists (lock and hidden are edit fields), not at the act hatch
//   AT15 a dropped agent dials again on shared/redial.js's schedule (reset by the join), not a fixed 1.5 s (review r5 F4)
//   AT16 upload {data} puts a file's bytes in the world's store and create {model: <its path>} places it; a call that isn't
//        one of data, text or effect, or whose data isn't base64, is refused before any request; the store's own refusal
//        comes back in its words; upload {text} and {effect} are the authority's upload verb, as act sends it
//   AT17 the ground is a builder's from the tool surface: act set terrain, a named feature, act sculpt under the agent's
//        own body (its feet read the new ground), and undo
//   AT18 the agent is told when someone else reshapes the ground near it (one ambient line a quiet window; its own
//        strokes say nothing)
// @ts-nocheck
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ENGINE, scratch } from "../gate/common.ts";
import { tryUntil, pause } from "../gate/wait.ts";
import { suite } from "../gate/suite.ts";
import { startServer } from "../harness/harness.ts";
import { helloOf } from "../../shared/protocol/hello.js";

const root = scratch("agenttools");
const S = suite("agenttools-check", { quiet: true, cap: 600 }), { done } = S;
let lastRow = "(start)";   // the row before a request: busyEvidence() names the section that sent it
const ok = (cond, what, detail?) => { lastRow = String(what).split(" ")[0]; S.ok(cond, what, detail); };
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
const { HANDLERS, TOOLS, toolList, handleTool: handleToolDoor } = await import("../../mcpl/tools.ts");
{ const listed = [...toolList({ travel: true }), ...toolList({ travel: false })];
  const HINTS = ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"];
  const bad = listed.filter((t) => typeof t.title !== "string" || !t.title.trim() || !t.annotations || HINTS.some((h) => typeof t.annotations[h] !== "boolean"));
  ok(listed.length > 28 && !bad.length, "AT4 every advertised tool has a title and all four annotation hints", bad.map((t) => t.name));
  ok(TOOLS.every((t) => t.annotations?.title === undefined || t.annotations.title === t.title), "AT4 (a title said once: the tool's own, not a second one in annotations)");
  const by = Object.fromEntries(TOOLS.map((t) => [t.name, t.annotations ?? {}]));
  const reads = ["look", "inspect", "measure", "world_history", "world_debug", "hierarchy", "blueprints", "whois", "body_state", "screenshot", "library", "worlds", "catch_up"];
  ok(reads.every((n) => by[n]?.readOnlyHint === true && by[n]?.destructiveHint === false), "AT4 the reads are read-only and not destructive", reads.filter((n) => !(by[n]?.readOnlyHint === true && by[n]?.destructiveHint === false)));
  const writes = ["move", "create", "place", "edit", "act", "say", "attach", "travel", "set_avatar", "anim", "reach", "upload"];
  ok(writes.every((n) => by[n]?.readOnlyHint === false), "AT4 everything that changes the world or a body is not read-only", writes.filter((n) => by[n]?.readOnlyHint !== false));
  ok(["act", "edit"].every((n) => by[n]?.destructiveHint === true) && ["create", "say", "move"].every((n) => by[n]?.destructiveHint === false), "AT4 act (delete, kick, ban…) and editing in place are destructive; making, saying and walking are not",
    Object.fromEntries(["act", "edit", "create", "say", "move"].map((n) => [n, by[n]?.destructiveHint])));
  ok(["create", "say", "act", "edit"].every((n) => by[n]?.idempotentHint === false) && ["place", "set_avatar", "travel", "move"].every((n) => by[n]?.idempotentHint === true),
    "AT4 making, saying, act and an edit (relative math) are not idempotent; placing, a body change, travel and a walk are", Object.fromEntries(["create", "say", "act", "edit", "place", "set_avatar", "travel", "move"].map((n) => [n, by[n]?.idempotentHint])));
  ok(["act", "say"].every((n) => by[n]?.openWorldHint === true) && ["edit", "look", "create"].every((n) => by[n]?.openWorldHint === false), "AT4 act and say reach beyond the world record (open world); an edit, a look and a create don't",
    Object.fromEntries(["act", "say", "edit", "look", "create"].map((n) => [n, by[n]?.openWorldHint])));
  ok(["say", "act", "anim"].every((n) => by[n]?.openWorldHint === true) && !by.whisper && ["look", "inspect", "move"].every((n) => by[n]?.openWorldHint === false), "AT4 what reaches other people is open-world; reading the world and walking in it are not");
  // the stdio host adds one tool of its own (mcpl/server.ts can't be imported here: it connects at load)
  const src = fs.readFileSync(path.join(ENGINE, "mcpl/server.ts"), "utf8");
  const pp = src.slice(src.indexOf("const PENDING_PINGS_TOOL"), src.indexOf("};", src.indexOf("const PENDING_PINGS_TOOL")));
  ok(/title:/.test(pp) && HINTS.every((h) => new RegExp(`${h}:\\s*(true|false)`).test(pp)), "AT4 …and the stdio host's own pending_pings tool too", pp.slice(0, 400));
  // AT3 / AT2 descriptions
  const desc = Object.fromEntries(TOOLS.map((t) => [t.name, t.description]));
  ok(!/default for agent performers/.test(desc.act) && /owner's call \(their move gate/.test(desc.act) && desc.act.includes((await import("../../shared/protocol/physconst.js")).bodyRangeWords()) && !/within 3 m/.test(desc.act) && /shove \{target/.test(desc.act), "AT3 act's shove says the body's owner decides, the same for every body (no agent default)", desc.act.slice(0, 200));
  // AT10 (decision table row 11): speech is arrival-only (server/world.ts sayFloor), so catch_up promises no backlog
  ok(/arrival-only/.test(desc.catch_up) && /since you arrived/.test(desc.catch_up) && !/since a point in the world's history/.test(desc.catch_up), "AT10 catch_up's description says speech is arrival-only: chat since you arrived, no backlog", desc.catch_up);
  // AT13 (#147): a bare yaw is radians (PROTOCOL §9); the inspector's pos.yaw is a heading in degrees, like Rotate
  { const create = TOOLS.find((t) => t.name === "create"), { VERBSPEC } = await import("../../shared/protocol/verbspec.js");
    const agents = fs.readFileSync(path.join(ENGINE, "AGENTS.md"), "utf8");
    ok(/yaw[^.;]*radians/.test(create.description) && /radians/.test(create.inputSchema.properties.at.description) && /yaw[^.;]*radians/.test(VERBSPEC.create.args.at.doc),
      "AT13 create's at says its yaw is radians: the tool's description, its at schema, and the authority's create.at", [create.inputSchema.properties.at.description, VERBSPEC.create.args.at.doc]);
    ok(/pos\.yaw \(heading, degrees\)/.test(desc.inspect) && /`pos\.yaw`\s+\(heading, in degrees\b/.test(agents),
      "AT13 …and inspect and AGENTS.md say pos.yaw is a heading in degrees (editOps reads it so)", desc.inspect.slice(0, 300));
    // every angle an agent writes or reads names its unit: a tool's or verb's angle-named argument, and a component field that carries a yaw
    const { COMPONENTS } = await import("../../shared/protocol/componentspec.js");
    const ANGLE = /^(yaw|pitch|roll|heading|azimuth|angle)$/i, UNIT = /radian|\brad\b|degree|°/i, bare: string[] = [];
    const walk = (where, props) => { for (const [k, v] of Object.entries(props ?? {})) {
      if ((ANGLE.test(k) || /\byaw\b/.test(v?.description ?? "")) && !UNIT.test(v?.description ?? "")) bare.push(`${where}.${k}`);
      for (const b of [v, ...(v?.anyOf ?? [])]) { walk(`${where}.${k}`, b?.properties); walk(`${where}.${k}[]`, b?.items?.properties); } } };
    for (const t of TOOLS) walk(t.name, t.inputSchema?.properties);
    for (const [verb, s] of Object.entries(VERBSPEC)) for (const [a, d] of Object.entries(s.args ?? {})) if ((ANGLE.test(a) || /\byaw\b/.test(d?.doc ?? "")) && !UNIT.test(d?.doc ?? "")) bare.push(`verb ${verb}.${a}`);
    // a component's pitch may be a playback rate (sound), so only these names; a tuple's yaw is labelled in the doc, the field's unit being its metres
    for (const [c, def] of Object.entries(COMPONENTS)) for (const [f, doc] of Object.entries(def.docs ?? {}))
      if (((/^(yaw|heading|azimuth|angle)$/.test(f) && !def.units?.[f]) || /,\s*yaw\b/.test(doc)) && !UNIT.test(doc)) bare.push(`component ${c}.${f}`);
    if (!/yaw[^.;]*radians/.test(COMPONENTS.transform.help)) bare.push("component transform's help: set {yaw}");
    ok(!bare.length, "AT13 …and every angle in a tool's schema, a verb's args or a component's docs names its unit", bare);
    const spec = fs.readFileSync(path.join(ENGINE, "spec/PROTOCOL.md"), "utf8"), conv = spec.slice(spec.indexOf("## 9. Conventions"), spec.indexOf("### 9.1"));
    ok(/Angles are radians/.test(conv) && /verb's\s+arguments/.test(conv) && /presence/.test(conv) && /`inspect`/.test(conv) && /`edit`/.test(conv) && /degrees/.test(conv) && /except\s+station `look` yaw\/pitch limits \(§9\.2\)/.test(conv),
      "AT13 …and PROTOCOL §9 (not only §9.2's components) says angles are radians for verb arguments, notes and presence, inspect/edit and the UI are degrees, and points at station `look`'s degrees exception (§9.2)", conv.slice(0, 400)); }
  // ---- AT6: the surface itself ----
  const names = TOOLS.map((t) => t.name);
  const folded = ["take_off", "climb_to", "glide_to", "land_at", "rehearse_down", "rehearse_recover", "fold_wings", "unfold_wings", "flight_status",
    "clear_pose", "clear_reach", "posture", "ragdoll", "library_sheet", "library_preview", "list_library", "light", "remove", "blueprint_place", "kick", "ban", "unban", "list_bans"];
  ok(names.length <= 32 && names.length >= 28, `AT6 the table is ~30 tools (${names.length})`, names);
  ok(!folded.some((n) => names.includes(n)), "AT6 none of the folded names is a tool of its own", folded.filter((n) => names.includes(n)));
  ok(["move", "act", "anim", "reach", "library", "set_avatar", "create", "edit", "body_state"].every((n) => names.includes(n)) && !["walk_to", "snapshot", "spawn", "check_model", "pose", "animate", "em" + "ote", "posture"].some((n) => names.includes(n)), "AT6 the general tools they folded into exist (anim: R 10-17 15:31); no old name is advertised (Mica 11-05)");
  ok(/mode/.test(desc.move) && /fly/.test(desc.move) && /altitude/.test(desc.move) && /name/.test(desc.move), "AT6 move documents mode: \"fly\" (altitude) and to: <a name>", desc.move.slice(0, 300));
  ok(/land/.test(desc.act) && /kick/.test(desc.act) && /\bbans\b/.test(desc.act) && /delete/.test(desc.act), "AT6 act documents land, kick/ban/unban/bans and delete", desc.act.slice(0, 200));
  ok(/wings-folded/.test(desc.anim) && /stop/.test(desc.anim) && /mode/.test(desc.anim) && /joints/.test(desc.anim) && /tracks/.test(desc.anim), "AT6 anim documents names (wings-folded), mode, joints, tracks and stop");
  ok(/release/.test(desc.reach), "AT6 reach documents release");
  ok(/query/.test(desc.library) && /preview/.test(desc.library) && /sheet|page/.test(desc.library), "AT6 library documents query, preview and the sheet");
  ok(/light/.test(desc.create) && /\bat\b/.test(desc.create), "AT6 create documents a light and at");
  const { resolveTool, handleTool } = await import("../../mcpl/tools.ts");
  ok(resolveTool("set_avatar")?.name === "set_avatar" && resolveTool("wear") === null && resolveTool("walk_to") === null, "AT6 set_avatar keeps its name (R: unambiguous; wear could mean a hat); the old renames are not tools");
  ok(/ragdoll: true/.test(desc.anim) && !/limp: true/.test(desc.anim) && !/shove \{target/.test(desc.anim) && /shove \{target/.test(desc.act), "AT6 anim documents ragdoll (one vocabulary with the browser: a body going limp); the push's form (shove {target…}) is act's alone");
  ok(resolveTool("take_off") === null && resolveTool("kick") === null, "AT6 a folded tool does not resolve to a handler (it folded, it was not renamed)");
  const gone = await handleTool({ agent: null } as any, "take_off", {});
  ok(gone.isError && /move \{mode: "fly"/.test(gone.content[0].text), "AT6 calling a folded name teaches where it went", gone.content[0].text);
  const gone2 = await handleTool({ agent: null } as any, "kick", {});
  ok(gone2.isError && /act \{verb: "kick"/.test(gone2.content[0].text), "AT6 …kick too", gone2.content[0].text);
  { // AT7 (parity sweep 10-14): an agent is a body under the same consent as a person. It sends its table on join (the
    // gates it chose and nothing else: a fresh agent sends nothing, the world's default stands), carries no private "pushable" flag, and can address someone through say.
    const agentSrc = fs.readFileSync(path.join(ENGINE, "mcpl/agent.ts"), "utf8"), toolsSrc = fs.readFileSync(path.join(ENGINE, "mcpl/tools.ts"), "utf8");
    const agentAll = fs.readdirSync(path.join(ENGINE, "mcpl")).filter((f) => /^agent(-[a-z]+)?\.ts$/.test(f)).map((f) => fs.readFileSync(path.join(ENGINE, "mcpl", f), "utf8")).join("\n");   // the agent and its pieces
    ok(!/\bpushable\b/.test(agentAll), "AT7a agent.ts has no `pushable` flag: the authority's consent table is the one answer to a shove");
    // Every arrival sends what it chose as a person's client
    // does: it reads what the authority holds and sets each cell that differs, never a preset, which empties the cells
    // (review of #260). The arrival calls replayConsent() (lifted out for house 6340433633); that method is read here.
    const at = agentSrc.indexOf("async replayConsent()"), end = agentSrc.indexOf("\n  }", at);
    const arrival = at < 0 || end < 0 || !/void this\.replayConsent\(\)/.test(agentSrc) ? "" : agentSrc.slice(at, end);
    ok(/this\.request\("consent", \{\}\)/.test(arrival) && /this\.request\("consent", gates\)/.test(arrival) && /unlist/.test(arrival) && !/\bpreset\b|\{ set \}|switch/.test(arrival) && !/DEFAULT_PRESET/.test(agentAll),
      "AT7b (R 10-28) an arrival reads the authority and sends the agent's gates and listed people only where they differ; no preset, no switch", arrival.slice(0, 300));
    const sayTool = toolsSrc.slice(toolsSrc.indexOf('name: "say"'), toolsSrc.indexOf('name: "say"') + 1200);
    ok(/\bto: \{ type: "string"/.test(sayTool) && /say\(text: string, extra\?: \{[^}]*\bto\?: string/.test(agentSrc), "AT7c say takes `to` on both the tool's schema and ag.say (the client sends it; the authority logs it)");
  }
  { // AT8a–c (parity sweep 10-14): one way to say who. One resolver (a name or a u-… identity), used by `act` for every
    // world verb whose arguments name a `who` (a global ban/unban sends it to server moderation as given).
    const toolsSrc = fs.readFileSync(path.join(ENGINE, "mcpl/tools.ts"), "utf8");
    ok(/async function resolveWho\(/.test(toolsSrc), "AT8a tools.ts has ONE resolveWho (name or u-… → identity, via whois)");
    ok((toolsSrc.match(/await ag\.request\("whois", \{ name/g) ?? []).length === 2, "AT8b whois-by-name is called from exactly two places — the resolver and the whois tool itself — not once per verb");
    ok(/Object\.hasOwn\(BODY_VERBS, verb\)\) return[\s\S]{0,400}resolveWho\(/.test(toolsSrc.slice(toolsSrc.indexOf("act: async"))), "AT8c `act` resolves args.who through the resolver before sending a who-taking verb");
  }
  ok(/create \{from: "[^"]+", at: \[/.test(desc.create), "AT2 create's description has a duplicate example in the shape the tool takes", desc.create); }

// ---- the server ----
const W = path.join(root, "w"), OPT = path.join(root, "opt"); fs.mkdirSync(W, { recursive: true });
await writeBoxGlb(path.join(OPT, "test/wall.glb"), [6, 2.4, 0.2]);   // a wall: 6 m along x, 2.4 m tall, 0.2 m thick
await writeBoxGlb(path.join(OPT, "test/cup.glb"), [0.1, 0.12, 0.1]);
const env = (extra = {}) => ({ ...process.env, WORLDS_DIR: W, OPT_DIR: OPT, SKIP_OPT_SWEEP: "1", HOST: "127.0.0.1",
  BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0", JOIN_TOKEN: "", SERVER_OPERATORS: "", TRUST_NAMES: "1", EIDO_FLIGHT_REHEARSAL: "", SESSIONS_PATH: path.join(root, "sessions.json"), ...extra });
const r0 = Bun.spawnSync(["bun", "tools/world.ts", "found", "yard", "--owner", "Ann"], { cwd: ENGINE, env: env() });
ok(r0.exitCode === 0, "(setup) found yard, Ann owns it", r0.stderr.toString().slice(-300));
const { port, proc, dead } = await startServer(env(), root, { from: 9540 });
process.on("exit", () => { try { proc.kill(); } catch {} });
ok(!dead, "(setup) the server is up");

async function sock(name) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`); const msgs = [];
  ws.onmessage = (ev) => msgs.push(JSON.parse(String(ev.data)));
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  ws.send(JSON.stringify({ type: "join", hello: helloOf(), world: "yard", id: name, avatar: "", replica: true }));
  await tryUntil(`${name}'s join is answered`, () => msgs.some((m) => m.type === "snapshot" || m.type === "error"), { ms: 4000, step: 50 });
  const snap = msgs.find((m) => m.type === "snapshot"); let rn = 0;
  return { ws, msgs, snap, actor: snap?.actor ?? null, close: () => ws.close(),
    at: (x, z) => ws.send(JSON.stringify({ type: "pose", pose: { p: [x, 0, z], yaw: 0, speed: 0, clip: "idle" } })),
    req: async (verb, args = {}) => { const id = `q${++rn}`; ws.send(JSON.stringify({ type: "request", id, verb, args }));
      const r = await tryUntil(`the reply to ${verb}`, () => msgs.find((m) => m.type === "reply" && m.id === id), { ms: 4000, step: 50 }); return r ? r.reply : { ok: false, timeout: true }; } };
}

const ann = await sock("Ann");
const { WorldAgent } = await import("../../mcpl/agent.ts");
const ag = new WorldAgent({ url: `ws://127.0.0.1:${port}/ws`, name: "Hep", world: "yard", avatar: "" });
// AT9's evidence when the busy meter refuses a create: ag's requests by the row before them, each round trip (>= its authority ms); the last 10 s at the latest rate refusal
const sent: { after: string; verb: string; t: number; ms: number }[] = []; let atRate: any = null;
const last10 = (now = performance.now()) => { const by: Record<string, number[]> = {}; let ms = 0;
  for (const e of sent) if (now - e.t < 10_000) { const b = (by[`${e.after} ${e.verb}`] ??= [0, 0]); b[0]++; b[1] += Math.round(e.ms); ms += e.ms; }
  return { rttMs: Math.round(ms), by }; };
{ const real = ag.request.bind(ag); ag.request = async (verb: string, args: any) => { const t0 = performance.now(), after = lastRow; const r = await real(verb, args); const t = performance.now();
    sent.push({ after, verb, t, ms: t - t0 }); if (r?.refused?.code === "rate") atRate = { verb, reason: r.refused.reason, ...last10(t) }; return r; }; }
const busyEvidence = () => atRate ?? { rate: "none on ag's connection", ...last10() };
await ag.connect(); await tryUntil("the agent has its cut", () => ag.snapshot, { ms: 3000, step: 50 });
const HEP = ag.replica?.you;
ok(/^u-/.test(HEP ?? "") && ag.replica?.active, "(setup) the agent joins and folds the world", ag.snapshot);
ok((await ann.req("set", { id: "@world", component: `roles:${HEP}`, value: { role: "builder" } })).ok, "(setup) Ann makes the agent a builder");
// R 10-17: a writer never chooses an id. Ann names each thing with a placeholder and a label; the authority mints its id
// (ID[name]); the agent's tools reach it by that label, by its handle, or by any unique prefix of its id
const ID: Record<string, string> = {};
const make = async (name: string, args: any) => { const r = await ann.req("create", { ...args, id: `$${name}`, components: { ...(args.components ?? {}), label: name } }); if (r?.ids?.[`$${name}`]) ID[name] = r.ids[`$${name}`]; return r; };
ok((await make("wall", { model: "test/wall.glb", components: { transform: { pos: [0, 0, 3], q: [0, 0, 0, 1], scale: [1, 1, 1] } } })).ok, "(setup) Ann builds a wall across z = 3");
ok((await make("mug", { model: "test/cup.glb", components: { transform: { pos: [6.4, 0, 0], q: [0, 0, 0, 1], scale: [1, 1, 1] }, grabbable: { who: "member" } } })).ok, "(setup) …and a mug anyone may carry, at x = 6.4");
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
  // a member in a world with a spawn arrives at the spawn, as a person does
  ok((await ann.req("set", { id: "@world", component: "spawn", value: { pos: [-8, 0, -8], radius: 2 } })).ok, "(AT1e setup) Ann gives the yard a spawn at (-8, -8)");
  // the spawn binds those who can't build (bodyverbs: a builder may arrive anywhere), and a new world's newcomers build (R 10-21)
  ok((await ann.req("set", { id: "@world", component: "default-role", value: { role: "member" } })).ok, "(AT1e setup) the yard's newcomers are members");
  const vee = new WorldAgent({ url: `ws://127.0.0.1:${port}/ws`, name: "Vee", world: "yard", avatar: "" });
  await vee.connect(); await tryUntil("Vee's replica is active", () => vee.replica?.active, { ms: 3000, step: 50 });
  const vm = await HANDLERS.move(vee, { to: [-6, -8], run: true }, { agent: vee, canPush: () => false, heldActivity: [], cursor: { caughtUpTo: null } }, "move");
  ok(!vm.isError && /spawn/.test(T(vm)) && Math.abs(vee.pos.x + 6) < 0.05 && Math.abs(vee.pos.z + 8) < 0.05, "AT1e a member's first walk in a world with a spawn arrives there and walks on (not stuck behind 'spawn')", [T(vm), vee.pos]);
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
  const p2 = made2 ? ag.foldRecord(made2)?.pos : null, p0 = ag.foldRecord(ID.mug)?.pos, gap = p2 && p0 ? Math.hypot(p2[0] - p0[0], p2[2] - p0[2]) : NaN;
  ok(!d2.isError && made2 && made2 !== made && gap > 0 && gap < 2, "AT2b create {from: <handle>} with no at puts the copy beside its source (within 2 m, not on it)", [T(d2), p0, p2, gap]);
  const d3 = await call("create", { from: ID.mug.slice(0, 9), at: { pos: [9, 0, 2] } });   // by a longer prefix of its id
  ok(!d3.isError, "AT2c …and the authority's own {pos, yaw|q} still passes through (a unique id prefix names the source)", T(d3));
  // a copy turned a quarter (yaw π/2): an identity fixture would read 0° (0.00 rad) whichever slot the radians went in
  const turned = await call("create", { from: ID.mug.slice(0, 9), at: { pos: [9, 0, 4], yaw: Math.PI / 2 } }), tid = (T(turned).match(/ id ([a-z2-7]{26})/) ?? [])[1];
  await tryUntil("the turned copy is in the agent's fold", () => tid && ag.foldRecord(tid), { ms: 2000 });
  const m = tid ? await call("measure", { id: ag.handle(tid) }) : turned;
  ok(!m.isError && / yaw 90\.0° \(1\.57 rad\)/.test(T(m)), "AT13 measure says where a thing is with its yaw in degrees, and the radians create takes beside it (a quarter turn: 90.0° (1.57 rad))", T(m).slice(0, 300));
  const chosen = await call("create", { id: "my-mug", model: "test/cup.glb" });
  ok(chosen.isError && /mint/.test(T(chosen)) && /\$my-mug/.test(T(chosen)), "AT2e an id the agent chooses is refused, and the words name the placeholder", T(chosen)); }

// ---- AT3: a refused shove is an error ----
// AT12 (decision table row 21): /worlds lists main's agents again (declared, §6a), and the worlds tool counts humans and agents apart
{ const yard = (await (await fetch(`http://127.0.0.1:${port}/worlds`, { headers: ag.readHeaders })).json()).worlds?.find((w) => w.name === "yard");
  const line = T(await call("worlds")).split("\n").find((l) => l.startsWith("- yard")) ?? "";
  ok(JSON.stringify(yard?.agents) === JSON.stringify([ag.name]) && yard.people?.length === 2 && /1 human, 1 agent: /.test(line), "AT12 /worlds' agents lists the declared agent; people is everyone; the worlds tool says 1 human, 1 agent", [yard, line]); }
{ const vic = await sock("Vic"); const vx = ag.pos.x + 1, vz = ag.pos.z;
  vic.at(vx, vz); const seesVic = await tryUntil("the agent sees Vic beside it", () => [...ag.people.values()].some((p) => p.pose?.p && Math.hypot(p.pose.p[0] - vx, p.pose.p[2] - vz) < 0.01), { ms: 3000, step: 20 });
  ok(!!seesVic, "(AT3 setup) the agent folds Vic's pose beside it");   // beside the agent (act shove is forwarded at any distance unless the world sets one: physconst.js BODY_RANGE)
  const sw = await vic.req("consent", { move: false }); ok(sw?.ok, "(AT3 setup) Vic turns her move gate off (its default is on)", sw);
  const no = await call("act", { verb: "shove", args: { target: "Vic" } });
  ok(no.isError && /shove/.test(T(no)) && /consent|nobody/.test(T(no)), "AT3a Vic's body refuses: act shove is refused, and the tool says so as an error naming the class", T(no));
  ok((await vic.req("consent", { move: true })).ok, "(AT3 setup) Vic turns her move gate back on");
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
  const old = await call("pose", { posture: "stand" });
  ok(old.isError && T(old) === `there's no tool named "pose" on this server, so nothing ran (did you mean move?); your tool list has the ones it serves` && ag.clip === "sit", "AT6d …the old pose {posture: \"stand\"} is an unknown tool: refused, and the body still sits (Mica 11-05)", [T(old), ag.clip]);
  const stand = await call("anim", { name: "stand" });
  ok(!stand.isError && /"playing":"stand"/.test(T(stand)) && ag.clip === "idle", "AT6d …anim {name: \"stand\"} stands", [T(stand), ag.clip]);
  const posed = await call("anim", { joints: { head: [0, 0.2, 0, 0.98] }, hold: true });
  const cleared = await call("anim", { stop: true });
  ok(!posed.isError && /"playing":"live","mode":"hold"/.test(T(posed)) && !cleared.isError && ag.heldPose == null, "AT6e anim {joints} holds a live frame; anim {stop: true} releases it (clear_pose folded)", [T(posed).slice(0, 120), T(cleared), ag.heldPose]);
  // ragdoll = a body going limp: anim {ragdoll: true} (R 10-14: one vocabulary with the browser: shoving is moving someone else; going limp is a body state)
  const nIn = ag.inbox.length; const limp = await call("anim", { ragdoll: true });
  ok(!limp.isError && /limp|down/.test(T(limp)) && ag.clip === "ragdoll", "AT6p anim {ragdoll: true} drops your own body limp (clip ragdoll)", [T(limp), ag.clip]);
  const limpAct = ag.inbox.slice(nIn).find((i: any) => i.kind === "act");
  ok(limpAct?.who === ag.name && limpAct?.text === "goes limp", "AT6p …and your inbox reads it as your own act, `* <name> goes limp` (not a bracketed aside)", [limpAct]);
  const up = await call("anim", { name: "stand" });
  ok(!up.isError && ag.clip !== "ragdoll", "AT6p …and standing picks it back up", [T(up), ag.clip]);
  const k2 = vic.msgs.length; const theirs = await call("anim", { ragdoll: true, target: "Vic" });
  await tryUntil("Vic is asked to go limp", () => vic.msgs.slice(k2).some((m) => m.type === "puppet" && m.ragdoll === true), { ms: 3000 });
  ok(!theirs.isError && vic.msgs.slice(k2).some((m) => m.type === "puppet" && m.ragdoll === true), "AT6q anim {ragdoll: true, target} asks THEIR body to go limp (an undirected ragdoll, not a shove)", [T(theirs), vic.msgs.slice(k2).map((m) => m.type)]);
  const wings = await call("anim", { name: "wings-folded" });
  // this body's bones aren't known here, so nothing folds: the door answers that as failed, in the fold's words
  ok(wings.isError && /wings unchanged/.test(T(wings)), "AT6f anim {name: \"wings-folded\"} (this body: nothing folded, failed, in the fold's words)", T(wings));
  const modeWas = ag.bodyMode, wings2 = await call("anim", { name: "wings-folded", bodyMode: "sit" });
  ok(wings2.isError && ag.bodyMode === modeWas, "AT6f2 a refused wings-folded leaves the body-mode as it was (a refused call changes nothing, #604)", { reply: T(wings2), was: modeWas, now: ag.bodyMode });
  const letgo = await call("reach", { release: true });
  ok(!letgo.isError && /releas|let go|weren't reaching/.test(T(letgo)), "AT6g reach {release: true} lets go (clear_reach folded; nothing held: said)", T(letgo));
  // the library
  // the sequencer's search walks eidoverse/assets/models only (server/routes.ts /library-models): under the library checkout
  // (EIDOVERSE_DIR, ../eidoverse-video by default) when the host has one, and this scratch OPT_DIR has none. With no
  // library the honest answers are "no matches" and the sheet's own words for nothing ("there are no models to show
  // yet"). The dispatch is what this bench can prove; EIDOVERSE_DIR=<an empty dir> runs the no-library branch
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
  ok(!byName.isError && /arrived/.test(T(byName)) && Math.hypot(ag.pos.x - mp[0], ag.pos.z - mp[2]) < 1.2 && Math.hypot(ag.pos.x - mp[0], ag.pos.z - mp[2]) > 0.3, "AT6k move {to: <the mug's handle>} walks up to the thing and stops beside it", [T(byName), ag.pos, mp]);
  const noName = await call("move", { to: "no-such-thing" });
  ok(noName.isError && /no-such-thing/.test(T(noName)), "AT6k …and an unknown name is an error naming it", T(noName));
  // moderation through act: the agent becomes an owner, kicks Vic by NAME (resolved to an identity), reads what's in force, unbans
  ok((await ann.req("set", { id: "@world", component: `roles:${HEP}`, value: { role: "owner" } })).ok, "(AT6 setup) Ann makes the agent an owner");
  await tryUntil("the agent folds its owner role", () => ag.replica?.st?.entities?.["@world"]?.c?.[`roles:${HEP}`]?.role === "owner", { ms: 3000, step: 20 });
  const kicked = await call("act", { verb: "kick", args: { who: "Vic", reason: "test" } });
  const vicGone = !!(await tryUntil("Vic's socket is closed by the kick", () => vic.ws.readyState === 3, { ms: 3000, step: 20 }));
  ok(!kicked.isError && /done|kick/.test(T(kicked)) && /u-/.test(T(kicked)) && vicGone, "AT6l act kick {who: a name} resolves the name to an identity and the authority does it", T(kicked));
  const banned = await call("act", { verb: "ban", args: { who: "Vic", days: 1, reason: "test" } }), inforce = await call("act", { verb: "bans" });
  ok(!banned.isError && !inforce.isError && /banned: Vic/.test(T(inforce)), "AT6m act bans lists the ban in force (list_bans folded)", [T(banned), T(inforce)]);
  const lifted = await call("act", { verb: "unban", args: { who: "Vic" } });
  ok(!lifted.isError && /done|unban/.test(T(lifted)), "AT6n act unban lifts it", T(lifted));
  const nobody = await call("act", { verb: "ban", args: { who: "Nobody-Here" } });
  ok(nobody.isError && /Nobody-Here/.test(T(nobody)), "AT6o act ban of a name the world never saw is an error naming it", T(nobody));
  // AT11 (decision table row 14): main's world_access `for: "2h"` again: a timed grant's until is the server's now + 2 h
  const roleOf = () => ag.replica?.st?.entities?.["@world"]?.c?.[`roles:${vic.actor}`];
  const t0 = ag.serverNow(), timed = await call("act", { verb: "set", args: { id: "@world", component: `roles:${vic.actor}`, value: { role: "builder", for: "2h" } } });
  await tryUntil("the agent folds Vic's timed grant", () => Number.isSafeInteger(roleOf()?.until), { ms: 3000, step: 50 });
  ok(!timed.isError && roleOf()?.role === "builder" && Math.abs(roleOf().until - (t0 + 7_200_000)) < 60_000 && !("for" in roleOf()), "AT11 act set roles:<id> {role, for: \"2h\"} stores until = now + 2 h (epoch ms)", [T(timed).slice(0, 200), roleOf(), t0]);
  const until0 = roleOf()?.until, badFor = await call("act", { verb: "set", args: { id: "@world", component: `roles:${vic.actor}`, value: { role: "member", for: "2 fortnights" } } });   // refused before sending: nothing to wait for
  ok(badFor.isError && /not sent/.test(T(badFor)) && /"30m", "2h", "1d" or "1w"/.test(T(badFor)) && roleOf()?.until === until0 && roleOf()?.role === "builder", "AT11 a malformed for is refused before anything is sent, with the durations it takes", [T(badFor), roleOf()]);
  vic.close(); }

// ---- AT14: look points at the real tool ----
{ ok((await make("post", { model: "test/cup.glb", components: { transform: { pos: [12, 0, 0], q: [0, 0, 0, 1], scale: [1, 1, 1] }, lock: true, hidden: true } })).ok, "(AT5 setup) a locked, hidden post");
  await tryUntil("the agent holds the post", () => ag.entities.has(ID.post), { ms: 3000, step: 50 });
  const h = ag.handle(ID.post);
  const line = T(await call("look")).split("\n").find((l) => l.includes(`[${h}]`)) ?? "";
  ok(h.length >= 4 && h.length < 26 && ID.post.startsWith(h) && /"post"/.test(line) && !line.includes(ID.post), "AT14a look reads a thing by its label, what it is and a short handle (a unique prefix of its id, never the whole 26)", [h, line]);
  ok(/locked/.test(line) && line.includes(`edit {id: "${h}", set: {"flags.lock": false}}`) && line.includes(`edit {id: "${h}", set: {"flags.hidden": false}}`) && !/act \{verb: "delete"/.test(line), "AT14 look teaches edit flags.lock / flags.hidden, not act delete", line);
  const un = await call("edit", { id: "post", set: { "flags.lock": false, "flags.hidden": false } });   // by its label
  await tryUntil("the post is unlocked and shown in the agent's fold", () => !ag.foldRecord(ID.post)?.lock && !ag.foldRecord(ID.post)?.hidden, { ms: 2000 });
  ok(!un.isError && !ag.foldRecord(ID.post)?.lock && !ag.foldRecord(ID.post)?.hidden, "AT14 …and what it teaches works (by its label too)", T(un)); }

// ---- AT9: the old names are unknown tools and run nothing (Mica 11-05); create's at / place shapes the old spawn used still land ----
{ const { handleTool } = await import("../../mcpl/tools.ts");
  const ctx = { agent: ag, canPush: () => false, heldActivity: [], cursor: { caughtUpTo: null } };
  const x0 = ag.pos.x, z0 = ag.pos.z;
  const w0 = await handleTool(ctx as any, "walk_to", { x: x0 + 1.5, z: z0, tolerance: 0.2 });
  ok(w0.isError && T(w0) === `there's no tool named "walk_to" on this server, so nothing ran; your tool list has the ones it serves` && Math.abs(ag.pos.x - x0) < 0.05, "AT9 walk_to is refused as an unknown tool and the body stays put (Mica 11-05)", { text: T(w0).slice(0, 160), x: ag.pos.x, x0 });
  const w = await handleTool(ctx as any, "move", { to: [x0 + 1.5, z0], tolerance: 0.2 });
  ok(!w.isError && Math.abs(ag.pos.x - (x0 + 1.5)) < 0.25, "AT9 move {to: [x, z], tolerance} walks the body", { text: T(w).slice(0, 160), x: ag.pos.x, x0 });
  const n0 = ag.entities.size;
  // what the old spawn {lib, x, y?, z, yaw?, id} became (its alias's translation, kept here as the shapes create takes)
  const oldSpawn = (a: any) => { const id = a.id !== undefined ? { components: { label: String(a.id) } } : {};
    if (Number.isFinite(a.yaw) && !Number.isFinite(a.y)) return { model: a.lib, ...id, place: { at: [a.x, a.z], facing: [a.x + Math.sin(a.yaw), a.z + Math.cos(a.yaw)] } };
    return { model: a.lib, ...id, at: a.yaw !== undefined ? { pos: [a.x, a.y, a.z], yaw: a.yaw } : Number.isFinite(a.y) ? [a.x, a.y, a.z] : [a.x, a.z] }; };
  const sp = await handleTool(ctx as any, "create", oldSpawn({ lib: "test/cup.glb", x: x0 + 3, z: z0 + 3, id: "alias-cup" }));
  const named = (n) => { const t = ag.thingRef(n); return "id" in t ? t.id : null; };   // the old spawn's id is the thing's label now (R 10-17)
  await tryUntil("the agent knows alias-cup", () => named("alias-cup"), { ms: 3000, step: 50 });
  ok(!sp.isError && !!named("alias-cup") && ag.entities.size === n0 + 1, "AT9 create from the old spawn shape {lib, x, z, id} creates the thing (create {model, at}, the id its label: the authority mints ids)", [busyEvidence(), T(sp).slice(0, 200)]);
  // M1 (holes review 10-15): create's at must be read, or the thing is made at the origin with ok.
  // Mutation (must go red): drop createAt's read of `a.at` (shared/protocol/authority/writes.js, called by buildCreate).
  const spAt = async (args, id) => { const r = await handleTool(ctx as any, "create", oldSpawn({ lib: "test/cup.glb", ...args, id })); await tryUntil(`the agent knows ${id}`, () => named(id), { ms: 3000, step: 50 }); return { r, rec: ag.foldRecord(named(id)) as any }; };
  const near = (p, x, z) => Array.isArray(p) && Math.abs(p[0] - x) < 0.05 && Math.abs(p[2] - z) < 0.05;
  const xz = await spAt({ x: x0 - 3, z: z0 + 3 }, "alias-cup-xz");
  ok(!xz.r.isError && near(xz.rec?.pos, x0 - 3, z0 + 3), "AT9 create from the old spawn shape {lib, x, z} lands at x, z (not the origin)", [busyEvidence(), T(xz.r).slice(0, 200), xz.rec?.pos]);
  const yw = await spAt({ x: x0 - 3, z: z0 - 3, yaw: 1 }, "alias-cup-yaw");
  const qy = [0, Math.sin(0.5), 0, Math.cos(0.5)];
  ok(!yw.r.isError && near(yw.rec?.pos, x0 - 3, z0 - 3) && Array.isArray(yw.rec?.q) && yw.rec.q.every((n, i) => Math.abs(n - qy[i]) < 1e-3), "AT9 create from the old spawn shape {lib, x, z, yaw} lands at x, z facing yaw (create {place: {at, facing}}: no y)", [busyEvidence(), T(yw.r).slice(0, 200), yw.rec?.pos, yw.rec?.q]);
  // review r2 F8: with a yaw and no y the shape is place {at: [x, z], facing} (oldSpawn above), the same seat as without a
  // yaw, never create {at: {pos: [x, 0, z], yaw}} (the origin at y 0): over the wall (top at 2.4) it lands ON it
  const ywOn = await spAt({ x: 1, z: 3, yaw: 1 }, "alias-cup-yaw-on");
  const noYaw = await spAt({ x: -1, z: 3 }, "alias-cup-on");
  ok(!ywOn.r.isError && near(ywOn.rec?.pos, 1, 3) && Math.abs(ywOn.rec?.pos?.[1] - 2.4) < 0.02 && Math.abs(noYaw.rec?.pos?.[1] - ywOn.rec?.pos?.[1]) < 1e-6
    && Array.isArray(ywOn.rec?.q) && ywOn.rec.q.every((n, i) => Math.abs(n - qy[i]) < 1e-3),
    "AT9 create from the old spawn shape {lib, x, z, yaw} over the wall sits on its top, like spawn without a yaw, facing yaw (review r2 F8)", [busyEvidence(), T(ywOn.r).slice(0, 200), ywOn.rec?.pos, ywOn.rec?.q, noYaw.rec?.pos]);
  const sq = await handleTool(ctx as any, "spawn", { query: "cup" });
  ok(sq.isError && T(sq) === `there's no tool named "spawn" on this server, so nothing ran (did you mean say?); your tool list has the ones it serves` && ag.entities.size === n0 + 5, "AT9 spawn is refused as an unknown tool and creates nothing (Mica 11-05)", [busyEvidence(), T(sq).slice(0, 200), ag.entities.size, n0]);
  const wv = await handleTool(ctx as any, "world_verb", { verb: "say", args: { text: "alias says" } });
  ok(wv.isError && /world_verb was removed/.test(T(wv)) && /act \{verb, args\}/.test(T(wv)), "AT9 world_verb is refused as removed, naming act (R 10-27)", T(wv).slice(0, 160));
  // main's verbs the authority doesn't have are refused as removed with the call that does it now, never a did-you-mean (R 10-27)
  const { VERBSPEC } = await import("../../shared/protocol/verbspec.js");
  for (const v of ["mount", "dismount", "spawn", "remove", "light", "comp", "motion", "behavior", "asset", "terrain", "grass", "epoch", "grant"]) {
    const r = await handleTool(ctx as any, "act", { verb: v, args: {} }); let j = null; try { j = JSON.parse(T(r)); } catch {}
    const names = (j?.refused?.fix ?? "").match(/\b[a-z-]+(?= \{)/g) ?? [];
    ok(r.isError && j?.refused?.code === "removed" && !j?.refused?.didYouMean && names.length > 0 && names.every((n) => VERBSPEC[n] || HANDLERS[n]),
      `AT9 act {verb: "${v}"} is refused as removed, naming only calls that exist (no did-you-mean)`, j?.refused ?? T(r).slice(0, 200)); }
  const hp = await handleTool(ctx as any, "act", { verb: "help", args: { verb: "comp" } }); const hj = JSON.parse(T(hp));
  ok(/removed/.test(hj?.refused?.reason ?? "") && /set \{/.test(hj?.refused?.fix ?? ""), "AT9 help {verb: comp} says it was removed and what does it now", hj);
  const sn = await handleTool(ctx as any, "snapshot", { view: "third" });
  ok(sn.isError && T(sn) === `there's no tool named "snapshot" on this server, so nothing ran; your tool list has the ones it serves`, "AT9 snapshot is refused as an unknown tool (Mica 11-05)", T(sn).slice(0, 160)); }

// ---- AT15 (review r5 F4): a dropped agent dials again on the browser's schedule (shared/redial.js), not a fixed 1.5 s ----
{ const rid = new WorldAgent({ url: `ws://127.0.0.1:${port}/ws`, name: "Rid", world: "yard", avatar: "" });
  await rid.connect(); await tryUntil("Rid has joined", () => rid.joined, { ms: 3000, step: 50 });
  const t0 = rid.redial?.tries;
  rid.ws.close(1000, "a drop");
  await tryUntil("Rid knows it was dropped", () => !rid.joined, { ms: 200, step: 10 });
  // the try is counted when the close is handled, which a loaded runner may take a while to get to: watch for it, not a
  // fixed pause. The redial waits ≥ a connect, so a 5 ms poll sees 1 before the rejoin resets it
  await tryUntil("the drop counted one try", () => rid.redial?.tries === 1, { ms: 1500, step: 5 });
  ok(t0 === 0 && rid.redial?.tries === 1, "AT15 a dropped agent's next dial is the shared backoff's (one try counted)", { t0, tries: rid.redial?.tries });
  await tryUntil("Rid gets back in by itself", () => rid.joined, { ms: 4000, step: 50 });
  ok(rid.joined && rid.redial?.tries === 0, "AT15 …it gets back in by itself, and the join resets the backoff", { joined: rid.joined, tries: rid.redial?.tries });
  rid.close(); }

// ---- AT16: upload puts a file in the world's store, and create places it ----
{ const file = path.join(root, "crate.glb"); await writeBoxGlb(file, [0.6, 0.4, 0.6]);
  const bytes = fs.readFileSync(file), b64 = bytes.toString("base64");
  // what uploads put in the store: files named by their hash. The optimizer adds variants and markers beside an accepted
  // model later, in the background; those aren't uploads, so they aren't counted
  const storeFiles = () => { try { return (fs.readdirSync(path.join(OPT, "store"), { recursive: true }) as string[]).filter((f) => /^[0-9a-f]{16}\.[a-z0-9]+$/.test(path.basename(String(f)))).length; } catch { return 0; } };
  // every POST /upload the tool makes, counted: a call refused for its shape makes none
  const realFetch = globalThis.fetch; let posts = 0;
  globalThis.fetch = ((u, o) => { if (/\/upload(\?|$)/.test(String(u))) posts++; return realFetch(u, o); }) as any;
  const up = await call("upload", { data: b64, name: "test crate" });
  const stored = (T(up).match(/stored as (store\/[0-9a-f]{16}\.glb)/) ?? [])[1];
  const onDisk = stored && fs.existsSync(path.join(OPT, stored)) ? fs.readFileSync(path.join(OPT, stored)) : null;
  ok(!up.isError && posts === 1 && !!onDisk && onDisk.equals(bytes), "AT16a upload {data} puts the file's bytes in the world's store, at the address its reply gives", [T(up), posts]);
  const man = (() => { try { return JSON.parse(fs.readFileSync(path.join(OPT, "store", "manifest.json"), "utf8")); } catch { return {}; } })();
  ok(man[String(stored).slice(6, 22)]?.name === "test crate", "AT16a …under the name it was given", man);
  ok(T(up).includes(`create {model: "${stored}"} places it`) && /SOLID|walk-in/.test(T(up)), "AT16a …and the reply names the call that places it, with the build check's summary", T(up));
  const made = await call("create", { model: stored, at: [14, 2] });
  const cid = (T(made).match(/ id ([a-z2-7]{26})/) ?? [])[1];
  await tryUntil("the uploaded crate is in the agent's fold", () => cid && ag.foldRecord(cid), { ms: 3000, step: 50 });
  ok(!made.isError && !!stored && !!cid && ag.foldRecord(cid)?.model === stored, "AT16b create {model: <the path upload returned>} places it: the world has a thing with that model", [T(made), cid && ag.foldRecord(cid)?.model]);
  // a model is a one-off unless its maker says it is for reuse: stored and placed all the same, and not in the catalog
  const hashOf = String(stored).slice(6, 22), manifest = () => JSON.parse(fs.readFileSync(path.join(OPT, "store", "manifest.json"), "utf8"));
  const inCatalog = async () => ((await (await realFetch(`${ag.httpBase}/library-models?q=crate`)).json()) as { path: string }[]).some((m) => m.path === stored);
  ok(/a one-off kept out of the catalog/.test(T(up)) && man[hashOf]?.catalog === false && !(await inCatalog()), "AT16i an uploaded model is a one-off by default: its reply says so, and the catalog (library) doesn't list it", [T(up).slice(0, 200), man[hashOf]]);
  // the authority's own find is a catalogue too (server/modelcatalogue.ts)
  const found = async () => { const r = await call("act", { verb: "find", args: { kind: "model", query: hashOf } }); let j: any = {}; try { j = JSON.parse(T(r)); } catch { /* not JSON: nothing found */ } return (j.models ?? []).some((m: any) => m.model === stored); };
  ok(!(await found()), "AT16i …and neither does the authority's find {kind: \"model\"}", hashOf);
  const listed = await call("upload", { data: b64, catalog: true });
  ok(!listed.isError && T(listed).includes(`stored as ${stored}, in the catalog`) && manifest()[hashOf]?.catalog === undefined && (await inCatalog()) && (await found()), "AT16i upload {catalog: true} lists the same file in the catalog, at the same address: library and find both have it", [T(listed).slice(0, 200), manifest()[hashOf]]);
  ok(manifest()[hashOf]?.name === "test crate", "AT16i …and an unnamed upload for the catalog keeps the name the file had", manifest()[hashOf]);
  const again = await call("upload", { data: b64 });
  ok(!again.isError && T(again).includes(`stored as ${stored}, in the catalog`) && (await inCatalog()) && manifest()[hashOf]?.name === "test crate", "AT16i listing wins: a later one-off upload of a listed file leaves it listed, under its name, and says so", [T(again).slice(0, 200), manifest()[hashOf]]);
  // a model stored before one-offs existed has no manifest entry, and is listed: a one-off upload of it leaves it listed
  { const old = path.join(root, "old.glb"); await writeBoxGlb(old, [0.3, 0.9, 0.3]); const ob = fs.readFileSync(old);
    const oh = createHash("sha256").update(ob).digest("hex").slice(0, 16), op = `store/${oh}.glb`;
    fs.writeFileSync(path.join(OPT, op), ob);
    const listedNow = async () => ((await (await realFetch(`${ag.httpBase}/library-models`)).json()) as { path: string }[]).some((m) => m.path === op);
    const before = await listedNow();
    const up2 = await call("upload", { data: ob.toString("base64") });
    ok(before && !up2.isError && T(up2).includes(`stored as ${op}, in the catalog`) && manifest()[oh]?.catalog !== false && (await listedNow()), "AT16i a file already in the store and listed, with no manifest entry, stays listed after a one-off upload of it", [before, T(up2).slice(0, 160), manifest()[oh] ?? null]); }
  posts = 0;
  // a call that isn't one of data, text or effect, or whose data isn't base64, or whose kind the store doesn't have: refused before any request
  const n0 = storeFiles(); posts = 0;
  for (const [what, a] of [["nothing", {}], ["data that isn't base64", { data: "not base64!" }], ["data that isn't a string", { data: 7 }], ["empty data", { data: "" }],
    ["data and text together", { data: b64, text: "world.say('hi')" }], ["a kind the store doesn't have", { data: b64, as: "movie" }]] as const) {
    const r = await call("upload", a);
    ok(r.isError && /upload \{data/.test(T(r)) && /text/.test(T(r)) && /effect/.test(T(r)), `AT16c upload with ${what} is refused, saying what the call looks like`, T(r));
  }
  ok(posts === 0 && storeFiles() === n0, "AT16c …and none of them sent a request or stored anything", [posts, storeFiles() - n0]);
  // the store's own refusal, in its words
  const junk = await call("upload", { data: Buffer.from("this is not a model, just forty bytes of text.").toString("base64") });
  ok(junk.isError && posts === 1 && T(junk).includes("not a GLB container (glb/vrm)") && /415/.test(T(junk)) && storeFiles() === n0, "AT16d bytes the store refuses: its own words come back (415, not a GLB container), and nothing is stored", T(junk));
  // another kind: an image lands under store/images/, and the reply says what takes it
  const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
  const img = await call("upload", { data: PNG.toString("base64"), as: "image", name: "one pixel" });
  const ipath = (T(img).match(/stored as (store\/images\/[0-9a-f]{16}\.png)/) ?? [])[1];
  ok(!img.isError && !!ipath && fs.readFileSync(path.join(OPT, ipath)).equals(PNG) && /picture/.test(T(img)) && T(img).includes(`src: "${ipath}"`), "AT16e upload {data, as: \"image\"} stores a picture source and says where it goes (a picture's src)", T(img));
  const hung = await call("act", { verb: "set", args: { id: cid, component: "picture", value: { src: ipath, width: 0.5 } } });
  await tryUntil("the crate shows the picture in the agent's fold", () => ag.foldRecord(cid)?.picture?.src === ipath, { ms: 3000, step: 50 });
  ok(!hung.isError && ag.foldRecord(cid)?.picture?.src === ipath, "AT16e …and the world takes that path as a picture's src", T(hung).slice(0, 200));
  // the other kinds: each lands where the store keeps that kind, and its reply names what takes it
  { const { wavBytes } = await import("../fixtures/wav-fixture.ts"); const { PNG: PngJs } = await import("pngjs");
    const wav = Buffer.from(wavBytes());
    const snd = await call("upload", { data: wav.toString("base64"), as: "audio", name: "quiet tone" });
    const apath = (T(snd).match(/stored as (store\/audio\/[0-9a-f]{16}\.wav)/) ?? [])[1];
    const gray = new PngJs({ width: 2, height: 2, colorType: 0, inputColorType: 0, inputHasAlpha: false }); gray.data = Buffer.from([0, 85, 170, 255]);
    const hm = await call("upload", { data: PngJs.sync.write(gray, { colorType: 0, inputColorType: 0, inputHasAlpha: false }).toString("base64"), as: "heightmap" });
    const gpath = (T(hm).match(/stored as (store\/heightmaps\/[0-9a-f]{16}\.json)/) ?? [])[1];
    const body = await call("upload", { data: b64, as: "avatar", name: "at16 body" });
    ok(!snd.isError && !!apath && fs.readFileSync(path.join(OPT, apath)).equals(wav) && T(snd).includes(`component: "sound", value: {src: "${apath}"}`), "AT16h upload {as: \"audio\"} stores a sound source and names the sound component's src", T(snd));
    ok(!hm.isError && !!gpath && fs.existsSync(path.join(OPT, gpath)) && T(hm).includes(`heightmap: {grid: "${gpath}"`) && /2×2 px/.test(T(hm)), "AT16h upload {as: \"heightmap\"} stores the decoded grid and names the terrain's heightmap.grid", T(hm));
    ok(!body.isError && fs.existsSync(path.join(OPT, "eidoverse/assets/vrms/at16_body.vrm")) && T(body).includes(`set_avatar {avatar: "at16_body"} wears it`), "AT16h upload {as: \"avatar\"} stores a body on the roster under its name (as the store spells it) and names set_avatar", T(body)); }
  // text and effect are the authority's upload verb, answered as act answers it
  posts = 0;
  const src = "world.on('use', () => world.say('rung'));";
  const viaTool = await call("upload", { text: src }), viaAct = await call("act", { verb: "upload", args: { text: src } });
  const J = (r) => { try { return JSON.parse(T(r)); } catch { return {}; } };
  const jt = J(viaTool), ja = J(viaAct);
  ok(!viaTool.isError && jt.ok && /^sha256:[0-9a-f]{64}$/.test(jt.src ?? "") && jt.src === ja.src && posts === 0, "AT16f upload {text} stores a script's source through the authority: its answer, the src act {verb: \"upload\"} gives for the same text", [T(viaTool).slice(0, 200), T(viaAct).slice(0, 200), posts]);
  const fx = { kind: "particle-effect", v: 1, name: "lantern glow", reads: "a warm glow", emitters: [{ spawn: { amount: 40, lifetime: 2 }, shape: { type: "sphere", radius: 0.1 }, velocity: { direction: [0, 1, 0], spread: 0.349, speed: [0.1, 0.3] }, forces: { gravity: [0, 0.2, 0] }, size: { base: 0.08 }, color: { base: 0xffcc66, ramp: [[0, 0xffffff, 0], [0.2, 0xffffff, 1], [1, 0xffffff, 0]] }, render: { blend: "add" } }] };
  const eff = await call("upload", { effect: fx }), je = J(eff);
  const lit = await call("act", { verb: "set", args: { id: cid, component: "particles", value: { effect: je.effect } } });
  await tryUntil("the crate emits the uploaded effect in the agent's fold", () => ag.foldRecord(cid)?.particles?.effect === je.effect, { ms: 3000, step: 50 });
  ok(!eff.isError && /^sha256:[0-9a-f]{64}$/.test(je.effect ?? "") && !lit.isError && ag.foldRecord(cid)?.particles?.effect === je.effect, "AT16g upload {effect} stores a particle effect document, and the world takes its address as a particles effect", [T(eff).slice(0, 200), T(lit).slice(0, 200)]);
  const bad = await call("upload", { effect: { kind: "not-an-effect" } });
  ok(bad.isError && J(bad).ok === false && typeof J(bad).refused?.code === "string", "AT16g …and the authority's refusal of one comes back as it gave it (code, reason, fix), an error", T(bad).slice(0, 300));
  globalThis.fetch = realFetch; }

// ---- AT17: the ground is a builder's from the tool surface (11-20): act set terrain, a named feature, and act sculpt ----
// The toolkit's noise is stubbed level (the server here serves no terrain.js), so every height read is the shaping's own.
{ const J = (r) => { try { return JSON.parse(T(r)); } catch { return null; } };
  // AT6 made the agent an owner: back to builder, so these rows hold for the role they name (an owner may write anything)
  const demoted = await ann.req("set", { id: "@world", component: `roles:${HEP}`, value: { role: "builder" } });
  const sky = await call("act", { verb: "sky", args: { hours: 3 } });
  ok(demoted.ok && J(await call("act", { verb: "help", args: {} }))?.you?.role === "builder" && sky.isError && J(sky)?.refused?.needs === "editWorld", "(AT17 setup) the agent is a builder again: its sky request is refused (needs editWorld)", [demoted.refused ?? demoted.ok, T(sky).slice(0, 160)]);
  const realMk = (globalThis as any).makeTerrain; ag.ground.terrainSrc = "stub"; (globalThis as any).makeTerrain = () => ({ heightAt: () => 0 });
  const set = await call("act", { verb: "set", args: { id: "@world", component: "terrain", value: { kind: "noise", amplitude: 0, size: 80 } } });
  await tryUntil("the agent's ground is built", () => ag.ground.terrain, { ms: 4000, step: 50 });
  ok(!set.isError && J(set)?.ok && !!ag.ground.terrain, "AT17a a builder's agent writes the world's terrain through act (the ground takes build), and stands on it", T(set).slice(0, 200));
  const feat = await call("act", { verb: "set", args: { id: "@world", component: "terrain-feature:mound", value: { type: "hill", x: 30, z: 30, radius: 5, height: 2 } } });
  await tryUntil("the mound is under the agent's feet", () => ag.heightAt(30, 30) === 2, { ms: 4000, step: 50 });
  ok(!feat.isError && ag.heightAt(30, 30) === 2 && ag.heightAt(36, 30) === 0, "AT17b a named feature set through act raises the ground the agent's feet read", [T(feat).slice(0, 160), ag.heightAt(30, 30)]);
  // no path: the brush works where the authority tracks this body; the reply says where, and what the ground did there
  const rev = ag.ground.navTerrainRev;
  const st = await call("act", { verb: "sculpt", args: { brush: "raise", radius: 2, strength: 0.5 } }); const sc = J(st)?.sculpted;
  await tryUntil("the stroke is under the agent's feet", () => sc && Math.abs(ag.heightAt(sc.at[0], sc.at[1]) - sc.now) < 0.001, { ms: 4000, step: 50 });
  // (between the layer's samples, half a metre apart, a stroke's top is a little under its strength: the reply says what the ground did)
  ok(!st.isError && sc?.tiles >= 1 && sc.now - sc.was > 0.4 && sc.now - sc.was <= 0.5 && Math.abs(ag.heightAt(sc.at[0], sc.at[1]) - sc.now) < 0.001 && ag.ground.navTerrainRev > rev && T(st).length < 2500,
    "AT17c act sculpt with no path raises the ground under the agent's own body: the reply says where and by how much in a few lines, the agent's feet read the new height there, and its routes are planned anew", { sc, feet: sc && ag.heightAt(sc.at[0], sc.at[1]), rev: [rev, ag.ground.navTerrainRev], chars: T(st).length, err: st.isError });
  const un = await call("act", { verb: "undo", args: {} });
  await tryUntil("the stroke is gone from under the agent's feet", () => sc && Math.abs(ag.heightAt(sc.at[0], sc.at[1]) - sc.was) < 0.001, { ms: 4000, step: 50 });
  ok(!un.isError && sc && Math.abs(ag.heightAt(sc.at[0], sc.at[1]) - sc.was) < 0.001, "AT17d undo takes the stroke back, and the agent's feet read the ground as it was", T(un).slice(0, 200));
  // ---- AT18: the agent is told when someone ELSE reshapes the ground near it; its own strokes say nothing ----
  const heard: any[] = []; const realOn = ag.onEvent; ag.onEvent = (ev: any) => { if (ev.kind === "world-change") heard.push(ev); };
  await call("act", { verb: "sculpt", args: { brush: "raise", radius: 2, strength: 0.2 } });   // its own
  const [mx, mz] = [ag.pos.x, ag.pos.z];
  const far = await ann.req("sculpt", { brush: "lower", path: [[mx + 6, mz]], radius: 2, strength: 0.5 });
  await tryUntil("the agent hears the ground move beside it", () => heard.length >= 1, { ms: 4000, step: 50 });
  ok(far.ok && heard.length === 1 && heard[0].part === "ground" && /^Ann lowered the ground \d+ m east of you by up to 0\.(4\d|50) m, across about \d+ m\.$/.test(heard[0].text ?? ""),
    "AT18a someone else's stroke near the agent arrives as one ambient line, tagged as the ground: who, where from the agent, how much; the agent's own stroke said nothing", heard.map((e) => e.text));
  // a run of strokes inside the quiet window folds into one line of what it came to, and says how far the agent's own ground moved
  const under = await ann.req("sculpt", { brush: "raise", path: [[mx, mz]], radius: 3, strength: 0.6 }), again = await ann.req("sculpt", { brush: "raise", path: [[mx, mz]], radius: 3, strength: 0.4 });
  await tryUntil("the folded line arrives when the window closes", () => heard.length >= 2, { ms: 9000, step: 100 });
  ok(under.ok && again.ok && heard.length === 2 && /^Ann raised the ground under you by up to (0\.9\d|1\.00) m, across about \d+ m; where you stand it is (0\.9\d|1\.00) m higher now\.$/.test(heard[1]?.text ?? ""),
    "AT18b two more strokes under the agent inside the quiet window are one line of their sum, saying the ground under its own feet rose", heard.map((e) => e.text));
  ag.onEvent = realOn;
  (globalThis as any).makeTerrain = realMk; }

ag.close(); ann.close();
done();
