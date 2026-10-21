// tools/protocol/parity-check.ts — one kind of participant (research agent/human parity, Part B; R 10-17 12:42: no
// different identities by kind; a status is declared, never inferred). Each row red first (against dfd5107c) and held by
// a mutation below.
//   bun tools/protocol/parity-check.ts                 every row
//   bun tools/protocol/parity-check.ts --only D1,M1    just those
//   bun tools/protocol/parity-check.ts --tree <dir>    against another checkout (a mutant, or the base)
//   bun tools/protocol/parity-check.ts --mutants       remove each fix in turn (a copy of shared/, server/, mcpl/, client/lib,
//                                                     spec/, docs/): its rows must go red; a no-op control must stay green
// Rows:
//   D   a declared status (§6a rule 3): a credential proves who, never what kind (an enrolled or aid1 agent that declares
//       nothing arrives undeclared); a declaration is relayed as sent (arrive, present), a malformed one is none, the old
//       `agent` key is none; the reserved-name rule stays; the log holds no declaration; the agent and the browser read it
//   M   one declaration channel: `move {client}` is gone (unknown-arg; the authority keeps no client kind; nobody sends it)
//   V   the spoken trio is any participant's (guard: no kind gate; the say doc says so)
//   X   the spec and docs say it: §6a's six rules, §8's minted-shaped stand-ins, verbspec's arrival sentence, stale comments
// @ts-nocheck
import fs from "node:fs";
import path from "node:path";
import { generateKeyPairSync, sign as cryptoSign } from "node:crypto";
import { ENGINE, scratch, copyTree } from "./common.ts";
import { readLogBytes, appendDurable, putBlobFile } from "../../server/durable.ts";
import { custodyAt, modLogAt } from "../../server/custody.ts";

const argv = process.argv.slice(2);
const opt = (k: string) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : undefined; };

// [name, file under the tree, find, replace, rows]
const MUTANTS: [string, string, string, string, string[]][] = [
  ["the credential declares for you", "server/server.ts", "c.tokenVerified = true; }", "c.tokenVerified = true; c.declares = \"agent\"; }", ["D1", "D2"]],
  ["the enrolment declares a person", "server/server.ts", "c.tokenVerified = true; }", "c.tokenVerified = true; c.declares = c.declares ?? \"person\"; }", ["D1", "D2"]],
  ["any value is a declaration", "server/server.ts", "return typeof v === \"string\" && /^[a-z][a-z0-9-]{0,31}$/.test(v) ? v : null;", "return v == null ? null : String(v);", ["D3"]],
  ["the old agent key declares", "server/server.ts", "c.declares = declarationOf(msg.declares) ?? undefined;", "c.declares = declarationOf(msg.declares) ?? (msg.agent ? \"agent\" : undefined);", ["D5"]],
  ["arrive drops the declaration", "server/server.ts", "w.broadcast({ type: \"arrive\", id: c.id, avatar: c.avatar, ...(c.declares ? { declares: c.declares } : {}), ...(c.actorId", "w.broadcast({ type: \"arrive\", id: c.id, avatar: c.avatar, ...(c.actorId", ["D3", "D4"]],
  ["present drops the declaration", "server/server.ts", "pose: settledPose(o.lastPose), ...(o.declares ? { declares: o.declares } : {}),", "pose: settledPose(o.lastPose),", ["D3", "D4"]],
  ["no reserved names", "server/server.ts", "if (at.names.has(c.id.toLowerCase()) && account !== `agent:token:${c.id.toLowerCase()}`) {", "if (false) {", ["D6"]],
  ["the agent declares nothing", "mcpl/agent.ts", "process.env.AGENT_DECLARES ?? \"agent\";", "process.env.AGENT_DECLARES ?? \"\";", ["D8"]],
  ["the agent reads the old key", "mcpl/agent.ts", "this.rememberBody(msg.id, msg.avatar, null, msg.declares);", "this.rememberBody(msg.id, msg.avatar, null, !!msg.agent);", ["D8"]],
  ["the browser reads the old key", "client/lib/net.js", "ensureRemote(msg.id, msg.avatar, { declares: msg.declares ?? null, authority: true });", "ensureRemote(msg.id, msg.avatar, { declares: msg.agent ? 'agent' : null, authority: true });", ["D9"]],
  ["move takes client again", "shared/protocol/verbspec.js", "teleport: { type: \"bool\", doc: \"jump there", "client: { type: \"string\", doc: \"a presence claim\" }, teleport: { type: \"bool\", doc: \"jump there", ["M1"]],
  ["the track keeps a client kind", "shared/protocol/authority/bodyverbs.js", "tokens: TRACK.cap, ...(size ? { size } : {})", "tokens: TRACK.cap, client: \"agent\", ...(size ? { size } : {})", ["M1"]],
  ["the browser sends client", "client/lib/thingphysics.js", "sendRequest('move', { to: to.map(r3) });", "sendRequest('move', { to: to.map(r3), client: 'human' });", ["M2"]],
  ["a say's trio by kind (doc)", "shared/protocol/verbspec.js", "spoken: { type: \"any\", doc: \"true: the words were voice-performed", "spoken: { type: \"any\", doc: \"true: a voice leg performs it (an agent)", ["V1"]],
  ["§6a gone", "spec/PROTOCOL.md", "## 6a. One kind of participant", "## 6a. Participants", ["X1"]],
  ["§8 agent-shaped again", "spec/PROTOCOL.md", "one minted-shaped (`u-` and 20 lowercase) and one of another valid shape", "one person-shaped (`u-` and 20 lowercase) and one agent-shaped", ["X2"]],
  ["verbspec: arrival on the record", "shared/protocol/verbspec.js", "Arriving is presence (nothing is logged); teleport: true is an act on the record, and can't carry things", "Your first move (arriving) and teleport: true are acts on the record, and can't carry things", ["X3"]],
  ["the stale consent comment", "client/lib/consent.js", "// staging a scene is welcome; a stranger yanking your limbs is not): the", "// staging a scene is welcome; agents accept by default): the", ["X4"]],
  ["WIRE: the agent flag", "docs/WIRE.md", "`{world, id?, token?, avatar?, surface?, spectate?, declares?, renderer?", "`{world, id?, token?, avatar?, surface?, spectate?, agent?, renderer?", ["X5"]],
  ["whois infers a kind", "server/requestwire.ts", "...(said.has(id) ? { declares: said.get(id) } : {}),", "kind: dir.entry(id)?.subs?.some((x) => /^(agent|aid1):/.test(x)) ? \"agent\" : \"person\",", ["W1"]],
  ["whois drops the declaration", "server/requestwire.ts", "...(said.has(id) ? { declares: said.get(id) } : {}),", "", ["W1"]],
  ["the directory infers a kind", "server/directory.ts", "return add({ name, subs: [sub], kind: \"account\", since: now() }); }", "return add({ name, subs: [sub], kind: (/^(agent|aid1):/.test(sub) ? \"agent\" : \"human\") as any, since: now() }); }", ["W1"]],
  ["the whois tool says a kind", "mcpl/tools.ts", "the word they declare for themselves if they declared one while here", "what they are (person, agent, guest)", ["W2"]],
  ["an old file's kind is kept", "server/directory.ts", "for (const [id, e] of Object.entries(d.ids)) index(id, unkind(e));", "for (const [id, e] of Object.entries(d.ids)) index(id, e);", ["W3"]],
  ["the message is unseated again", "shared/protocol/authority/writes.js", "inboxPush(w.presence, u.who, { type: \"vacated\", socket: u.socket,", "inboxPush(w.presence, u.who, { type: \"unseated\", seat: u.socket,", ["O1"]],
  ["the notes say unseated", "shared/protocol/authority/gate.js", "({ who: u.who, vacated: true, socket: u.socket,", "({ who: u.who, unseated: true, seat: u.socket,", ["O1"]],
  ["presence keeps seats", "shared/protocol/authority/occupants.js", "(w.presence.occupants ??= {})[who]", "(w.presence.seats ??= {})[who]", ["O1"]],
  ["no read-both for an old presence file", "shared/protocol/authority/storage.js", "if (w.presence.seats && !w.presence.occupants) w.presence.occupants = w.presence.seats;", "", ["O2"]],
  ["body kind seat again", "shared/protocol/authority/bodyconsent.js", "\"drag\", \"occupy\", \"carry\"]", "\"drag\", \"seat\", \"carry\"]", ["O3"]],
  ["sockbody reads seat", "shared/sockbody.js", "typeof u.socket === 'string' && u.socket === mount.to", "typeof u.seat === 'string' && u.seat === mount.to", ["O4"]],
  ["CONTROL (no-op: must stay green)", "server/server.ts", "/** A join's declared status (PROTOCOL §6a)", "/**  A join's declared status (PROTOCOL §6a)", []],
];
async function runSelf(tree: string, only: string[] | null) {
  const args = ["bun", path.join(ENGINE, "tools/protocol/parity-check.ts"), "--tree", tree, ...(only ? ["--only", only.join(",")] : [])];
  const r = Bun.spawnSync(args, { cwd: ENGINE, env: { ...process.env, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" } });
  return { code: r.exitCode, out: r.stdout.toString() + r.stderr.toString() };
}
// a mutant tree: shared/, server/, spec/, docs/ and mcpl/ (without node_modules) copied; client/ linked back except lib/,
// whose files are copied; everything else linked back to the checkout
function copyTree(tag: string) { const d = scratch(tag);
  for (const k of ["shared", "server", "spec", "docs"]) copyTree(path.join(ENGINE, k), path.join(d, k));
  fs.cpSync(path.join(ENGINE, "mcpl"), path.join(d, "mcpl"), { recursive: true, filter: (src) => !src.includes(`${path.sep}node_modules`) });
  try { fs.symlinkSync(path.join(ENGINE, "mcpl", "node_modules"), path.join(d, "mcpl", "node_modules")); } catch { /* none */ }
  fs.mkdirSync(path.join(d, "client"), { recursive: true });
  for (const k of fs.readdirSync(path.join(ENGINE, "client"))) if (k !== "lib") fs.symlinkSync(path.join(ENGINE, "client", k), path.join(d, "client", k));
  fs.cpSync(path.join(ENGINE, "client", "lib"), path.join(d, "client", "lib"), { recursive: true });
  for (const k of fs.readdirSync(ENGINE)) if (![".git", "worlds", "store"].includes(k) && !fs.existsSync(path.join(d, k))) try { fs.symlinkSync(path.join(ENGINE, k), path.join(d, k)); } catch { /* best effort */ }
  return d; }
if (argv.includes("--mutants")) {
  let bad = 0, ran = 0;
  for (const [name, file, find, repl, cases] of MUTANTS) {
    ran++; const d = copyTree("paritymut"); const f = path.join(d, file); const src = fs.readFileSync(f, "utf8");
    if (src.split(find).length < 2) { bad++; console.log(`FAIL mutant '${name}': its text isn't found in ${file} (the fix moved?)`); continue; }
    fs.writeFileSync(f, src.split(find).join(repl));
    const r = await runSelf(d, cases.length ? cases : null);
    const redIds = [...r.out.matchAll(/^\s*FAIL (\S+)/gm)].map((m) => m[1]);
    const good = cases.length ? r.code !== 0 && cases.every((c) => redIds.includes(c)) : r.code === 0;
    if (!good) bad++;
    console.log(`${good ? "ok  " : "FAIL"} mutant '${name}' → ${cases.length ? `red: ${redIds.join(",") || "(none)"} (want ${cases.join(",")})` : `exit ${r.code} (want 0)`}`);
    if (!good) console.log(r.out.split("\n").slice(-12).join("\n"));
  }
  console.log(`[parity-check --mutants] ${ran} mutations run, ${bad} wrong (each must turn its rows red; the control must stay green)`); process.exit(bad ? 1 : 0);
}

const TREE = path.resolve(opt("tree") ?? ENGINE) + "/";
const ONLY = opt("only")?.split(",") ?? null;
const want = (ids: string[]) => !ONLY || ids.some((i) => ONLY.includes(i));
const readText = (rel: string) => fs.readFileSync(TREE + rel, "utf8");
const section = (md: string, head: RegExp) => { const i = md.search(head); if (i < 0) return ""; const rest = md.slice(i + 1); const j = rest.search(/\n## /); return md.slice(i, j < 0 ? undefined : i + 1 + j); };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const root = scratch("parity");

// ---------------- a real server from the tree (D rows) ----------------
const pair = generateKeyPairSync("ed25519");
const spki = pair.publicKey.export({ type: "spki", format: "der" }) as Buffer;
const ISSUER = `ed25519:${spki.subarray(spki.length - 32).toString("base64url")}`;
let jti = 0;
const mint = (over = {}) => { const now = Math.floor(Date.now() / 1000);
  const p = { v: 1, iss: "id.test", sub: "agent:moth@home.test", kind: "agent", name: "Moth", aud: "eidoverse", scopes: ["worlds:join"], iat: now, exp: now + 600, jti: `j${jti++}`, ...over };
  const seg = Buffer.from(JSON.stringify(p)).toString("base64url");
  return `aid1.${seg}.${cryptoSign(null, Buffer.from(`aid1.${seg}`), pair.privateKey).toString("base64url")}`; };
const W = path.join(root, "w"); fs.mkdirSync(W, { recursive: true });
const TOK = path.join(root, "tokens.json");
fs.writeFileSync(TOK, JSON.stringify({ "tok-rowan": { id: "Rowan" } }));
const env = (extra = {}) => ({ ...process.env, WORLDS_DIR: W, OPT_DIR: path.join(root, "opt"), SKIP_OPT_SWEEP: "1", HOST: "127.0.0.1",
  BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0", JOIN_TOKEN: "", WORLD_ADMIN: "", AGENT_TOKENS_PATH: TOK, SESSIONS_PATH: path.join(root, "sessions.json"), HN_ISSUER_KEY: ISSUER, HN_ISS: "id.test", TRUST_NAMES: "1", ...extra });
let srv: any = null;
async function server() {
  if (srv) return srv;
  const f = Bun.spawnSync(["bun", TREE + "tools/protocol/world.ts", "found", "glade", "--owner", "Ann"], { cwd: TREE, env: env() });
  if (f.exitCode !== 0) throw new Error(`found: ${f.stderr.toString().slice(-300)}`);
  let port = 9620; for (; port < 9720; port++) { try { const s = Bun.listen({ hostname: "127.0.0.1", port, socket: { data() {} } }); s.stop(true); break; } catch { /* taken */ } }
  const logf = path.join(root, `srv-${port}.log`);
  const p = Bun.spawn(["bun", TREE + "server/server.ts"], { cwd: TREE, env: env({ PORT: String(port) }), stdout: Bun.file(logf), stderr: Bun.file(logf + ".err") });
  process.on("exit", () => { try { p.kill(); } catch { /* gone */ } });
  for (let i = 0; i < 100; i++) { await sleep(150); if (p.exitCode != null) break;
    try { if ((await fetch(`http://127.0.0.1:${port}/version`, { signal: AbortSignal.timeout(800) })).ok) return (srv = { port, proc: p }); } catch { /* not yet */ } }
  throw new Error(`server didn't start: ${fs.existsSync(logf + ".err") ? fs.readFileSync(logf + ".err", "utf8").slice(-400) : ""}`);
}
async function sock(port: number) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`); const msgs: any[] = [];
  ws.onmessage = (ev) => msgs.push(JSON.parse(String(ev.data)));
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  let rq = 0;
  const req = (verb: string, args: any = {}) => new Promise<any>((res) => { const id = `q${++rq}`; const k = msgs.length;
    ws.send(JSON.stringify({ type: "request", id, verb, args }));
    const t0 = Date.now(); const look = () => { const m = msgs.slice(k).find((x) => x.type === "reply" && x.id === id); if (m) return res(m.reply); if (Date.now() - t0 > 4000) return res({ timeout: true }); setTimeout(look, 30); }; look(); });
  return { msgs, req, close: () => ws.close(),
    async join(id: string, extra = {}) { const k = msgs.length; ws.send(JSON.stringify({ type: "join", world: "glade", id, avatar: "", replica: true, ...extra }));
      for (let i = 0; i < 80; i++) { if (msgs.slice(k).some((m) => m.type === "snapshot" || m.type === "error")) break; await sleep(50); }
      return { snapshot: msgs.slice(k).find((m) => m.type === "snapshot"), errors: msgs.slice(k).filter((m) => m.type === "error").map((m) => m.error) }; } };
}
/** `who` joins with `extra` while an observer is here; a late joiner then reads the present list. What each saw of `who`. */
async function seen(name: string, extra: any) {
  const { port } = await server();
  const obs = await sock(port); await obs.join(`obs${name.toLowerCase()}`);
  const s = await sock(port); const j = await s.join(name, extra);
  const you = j.snapshot?.you;
  for (let i = 0; i < 40 && !obs.msgs.some((m) => m.type === "arrive" && m.id === you); i++) await sleep(50);
  const arrive = obs.msgs.find((m) => m.type === "arrive" && m.id === you) ?? null;
  const late = await sock(port); const lj = await late.join(`late${name.toLowerCase()}`);
  const present = lj.snapshot?.present?.find((p: any) => p.id === you) ?? null;
  obs.close(); s.close(); late.close(); await sleep(150);
  const strip = (m: any) => m && { declares: m.declares, agent: m.agent, hasDeclares: "declares" in m, hasAgent: "agent" in m };
  return { you, errors: j.errors, arrive: strip(arrive), present: strip(present) };
}
const undeclared = (o: any) => !!o.arrive && !!o.present && !o.arrive.hasDeclares && !o.arrive.hasAgent && !o.present.hasDeclares && !o.present.hasAgent;
const declared = (o: any, v: string) => o.arrive?.declares === v && o.present?.declares === v && !o.arrive.hasAgent && !o.present.hasAgent;

// ---------------- the authority from the tree (M, V rows) ----------------
const D = await import(TREE + "shared/protocol/authority.js");
D.fixtureIds?.(true);
const F = await import(TREE + "shared/protocol/fold.js");
const SB = await import(TREE + "shared/protocol/sandbox.js");
const VS = await import(TREE + "shared/protocol/verbspec.js");
function openWorld(name: string) {
  const logPath = path.join(root, "worlds", `${name}.jsonl`), storeDir = path.join(root, "store");
  const entries = F.readLog(readLogBytes(logPath)).map(D.posAt);
  const blobPath = (h: string) => path.join(storeDir, `${String(h).replace(/[^a-z0-9]/g, "-")}.json`);
  const w = D.worldOf({ name, entries,
    getBlob: (h: string) => JSON.parse(fs.readFileSync(blobPath(h), "utf8")),
    putBlob: (v: unknown) => { const s = F.jcs(v); const h = `sha256:${F.sha256(s)}`; putBlobFile(blobPath(h), s, h); return h; },
    now: () => Number(process.env.PROTOCOL_NOW), writeLine: (line: string) => appendDurable(logPath, line),
    presence: { bodies: {}, holds: {} }, savePresence: () => {}, scripts: SB.SANDBOX,
    custody: custodyAt(path.join(root, "keys", "custody.json")), ...modLogAt(path.join(root, "worlds", `${name}.mod.jsonl`)) });
  w.catalogue = D.LAB_CATALOGUE;
  return w;
}
let T = 1800000000000, N = 0;
function session() {
  const name = `p${++N}`; let w: any = null; const Wd = () => (w ??= openWorld(name));
  const call = (actor: string, verb: string, args: any = {}) => { T += 1000; process.env.PROTOCOL_NOW = String(T);
    try { return D.request(Wd(), actor, verb, args); } catch (e) { return { crashed: `${e?.constructor?.name}: ${e?.message}`.slice(0, 200) }; } };
  return { name, call, w: Wd, entries: () => Wd().entries };
}
const show = (r: any) => (r?.crashed ? `CRASH ${r.crashed}` : r?.ok ? "ok" : `refused ${r?.refused?.code}: ${String(r?.refused?.reason).slice(0, 160)}`);

type Case = { id: string; what: string; run: (s: any) => any; good: (o: any) => boolean };
const cases: Case[] = [
  // ---------------- D: a declared status, never an inferred one ----------------
  { id: "D1", what: "(§6a rule 3; research #2) an enrolled agent (its bearer token) that declares nothing is named by its enrolment and arrives UNDECLARED: neither `declares` nor `agent` in its arrive or the late joiner's present", async run() {
      return await seen("Rowan", { agentToken: "tok-rowan" }); },
    good: (o) => o.you === "Rowan" && undeclared(o) },
  { id: "D2", what: "…an aid1 credential of kind agent that declares nothing arrives undeclared too", async run() {
      return await seen("x", { agentToken: mint() }); },
    good: (o) => !!o.you && undeclared(o) },
  { id: "D3", what: "(§6a rule 3) a participant with no credential declaring \"agent\" is relayed as declared (arrive, present); \"person\" likewise; a malformed declaration (markup, a number, 40 letters, true) is none", async run() {
      return { agent: await seen("Bram", { declares: "agent" }), person: await seen("Cleo", { declares: "person" }),
        markup: await seen("Dov", { declares: "<b>agent</b>" }), num: await seen("Eli", { declares: 7 }), long: await seen("Fay", { declares: "a".repeat(40) }), bool: await seen("Gus", { declares: true }) }; },
    good: (o) => declared(o.agent, "agent") && declared(o.person, "person") && ["markup", "num", "long", "bool"].every((k) => undeclared(o[k])) },
  { id: "D4", what: "…and a credentialed agent declaring \"person\" is relayed as it declared: the door never overrides a declaration from the credential", async run() {
      return await seen("x", { agentToken: mint({ sub: "agent:quill@home.test", name: "Quill" }), declares: "person" }); },
    good: (o) => !!o.you && declared(o, "person") },
  { id: "D5", what: "(one declaration channel) the old join key `agent: true` is no declaration: nothing is relayed for it", async run() {
      return await seen("Hal", { agent: true }); },
    good: (o) => undeclared(o) },
  { id: "D6", what: "(identity, kept) a reserved enrolment name without its proof is still refused", async run() {
      const { port } = await server(); const s = await sock(port); const j = await s.join("Rowan", { declares: "agent" }); s.close(); return { snap: !!j.snapshot, errors: j.errors }; },
    good: (o) => !o.snap && /reserved/.test(o.errors.join(" ")) },
  { id: "D7", what: "(§6a rule 3) the world's log holds no declaration: after every join above, world.jsonl names neither `declares` nor an `agent` flag", async run() {
      await server(); const t = fs.readFileSync(path.join(W, "glade", "world.jsonl"), "utf8"); return { declares: /"declares"/.test(t), agent: /"agent":\s*(true|false)/.test(t), lines: t.split("\n").length }; },
    good: (o) => !o.declares && !o.agent && o.lines > 1 },
  { id: "D8", what: "the agent harness declares (\"agent\" by default, nothing when told \"\"), sends no `agent` key, and keeps others' `declares` as sent (review r11 L2: never compared to a word)", async run() {
      const A = await import(TREE + "mcpl/agent.ts"); const a = new A.WorldAgent({ name: "x", world: "glade", declares: undefined }); const b = new A.WorldAgent({ name: "y", world: "glade", declares: "" });
      const ja = a.joinMsg(), jb = b.joinMsg(); const src = readText("mcpl/agent.ts");
      return { ja: { d: ja.declares, agent: "agent" in ja }, jb: { d: jb.declares, agent: "agent" in jb }, reads: (src.match(/rememberBody\((p|msg)\.id, (p|msg)\.avatar, [^,]+, (p|msg)\.declares\)/g) ?? []).length, cmp: /(?<!typeof )\b(\w+\.)?declares === "/.test(src), old: /!!(msg|p)\.agent\b/.test(src) }; },
    good: (o) => o.ja.d === "agent" && !o.ja.agent && o.jb.d === undefined && !o.jb.agent && o.reads === 2 && !o.cmp && !o.old },
  { id: "D9", what: "the browser reads `declares` from arrive and present (net.js) and keeps the word as said (R 10-17 14:41: no agent boolean), never an `agent` flag", run() {
      const src = readText("client/lib/net.js"); return { arrive: /\{ declares: msg\.declares \?\? null/.test(src), present: /\{ declares: p\.declares \?\? null/.test(src), old: /(msg|p)\.agent\b/.test(src) }; },
    good: (o) => o.arrive && o.present && !o.old },
  // ---------------- W: whois names no kind ----------------
  { id: "W1", what: "(§6a rule 3; R 10-17 13:41 \"everyone is a person here\") whois infers no kind from the account: an enrolled agent, an aid1 agent and a typed-name account answer with no `kind` and no person/agent word; one who declared shows its own word (\"ai\") while here, nothing otherwise; the directory file holds no inferred kind", async run() {
      const { port } = await server();
      const ro = await sock(port); await ro.join("Rowan", { agentToken: "tok-rowan" });
      const mo = await sock(port); const jm = await mo.join("x", { agentToken: mint({ sub: "agent:wisp@home.test", name: "Wisp" }), declares: "ai" });
      const pe = await sock(port); await pe.join("Ivy");
      const asker = await sock(port); await asker.join("Jem"); await sleep(200);
      const r = await asker.req("whois", { name: "Rowan" }), m = await asker.req("whois", { name: jm.snapshot?.you ?? "wisp" }), i = await asker.req("whois", { name: "Ivy" });
      ro.close(); mo.close(); pe.close(); asker.close(); await sleep(200);
      const files: string[] = []; const walk = (d: string) => { for (const k of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, k.name); if (k.isDirectory()) walk(f); else if (/director/i.test(k.name)) files.push(fs.readFileSync(f, "utf8")); } }; walk(root);
      const one = (x: any) => x?.people?.[0] ?? null;
      return { r: one(r), m: one(m), i: one(i), words: /"(person|agent|human)"/.test(JSON.stringify([r, m, i])), dirKinds: files.some((t) => /"kind":\s*"(agent|human)"/.test(t)), dirs: files.length }; },
    good: (o) => !!o.r && !!o.m && !!o.i && ![o.r, o.m, o.i].some((p: any) => "kind" in p) && !o.words && o.m.declares === "ai" && !("declares" in o.r) && !("declares" in o.i) && o.dirs > 0 && !o.dirKinds },
  { id: "W2", what: "…and nothing user-facing reads a person/agent kind from whois: no KIND_WORD in requestwire, the chat line and the agent's whois tool say a declared word, not \"(an agent)\" or \"(person, agent, guest)\"; the founding gate reads the account, never a directory kind", run() {
      const rw = readText("server/requestwire.ts"), h = readText("client/lib/commands/handlers.js"), t = readText("mcpl/tools.ts"), d = readText("server/directory.ts");
      return { kindWord: /KIND_WORD/.test(rw), dirKind: /\?\.kind === "agent"/.test(rw), chat: /\(an agent\)/.test(h), tool: /person, agent, guest/.test(t) || /\$\{p\.kind\}/.test(t), infer: /kindOfSub|kind: agent \?/.test(d) }; },
    good: (o) => !o.kindWord && !o.dirKind && !o.chat && !o.tool && !o.infer },
  { id: "W3", what: "…a directory file written before keeps no inferred kind: its \"agent\"/\"human\" entries read as \"account\"", async run() {
      const DR = await import(TREE + "server/directory.ts"); const f = path.join(root, "old-directory.json");
      fs.writeFileSync(f, JSON.stringify({ v: 2, ids: { ["u-" + "c".repeat(20)]: { name: "Old", subs: ["agent:token:old"], kind: "agent", since: 1 }, ["u-" + "d".repeat(20)]: { name: "Hu", subs: ["human:discord:9"], kind: "human", since: 1 } } }));
      const d = DR.directoryAt(f); return { a: d.entry("u-" + "c".repeat(20))?.kind, h: d.entry("u-" + "d".repeat(20))?.kind }; },
    good: (o) => o.a === "account" && o.h === "account" },
  // ---------------- O: occupy is the one word family (R 10-17 13:46) ----------------
  { id: "O1", what: "(R 13:46) a socket removed under vic: his inbox has `vacated {socket, by, why, at}` (no `unseated`, no `seat`), the reply's note says `vacated: true, socket`-free of seat words, and presence keeps `occupants` (no `seats`)", run(s) {
      s.call("olive", "create-world", { title: s.name }); s.call("olive", "set", { id: "@world", component: "roles:vic", value: { role: "player" } });
      s.call("olive", "create", { id: "chair", model: "chair", components: { sockets: { a: { pos: [0, 0.45, 0], body: { action: "sit" } } } }, place: { at: [4, 0] } });
      s.call("vic", "move", { to: [4, 0, -0.6] }); const sit = s.call("vic", "use", { id: "chair", action: "sit" });
      const pres = Object.keys(s.w().presence); const occ = s.w().presence.occupants?.vic?.to ?? null;
      const mv = s.call("olive", "set", { id: "chair", component: "transform", value: { pos: [6, 0, 0], q: [0, 0, 0, 1], scale: [1, 1, 1] } });
      const inbox = JSON.parse(JSON.stringify(s.w().presence.inbox?.vic ?? []));
      const m = inbox.find((x: any) => x.type === "vacated") ?? null;
      return { sit: show(sit), occ, pres, mv: show(mv), notes: JSON.stringify(mv.notes ?? []), m, types: inbox.map((x: any) => x.type) }; },
    good: (o) => o.sit === "ok" && !!o.occ && o.pres.includes("occupants") && !o.pres.includes("seats") && o.mv === "ok" && !!o.m && o.m.socket === o.occ && typeof o.m.why === "string" && Array.isArray(o.m.at) && !("seat" in o.m) && !o.types.includes("unseated") && /"vacated":true/.test(o.notes) && /"socket":/.test(o.notes) && !/unseated|"seat":/.test(o.notes) },
  { id: "O1b", what: "…a dry run of that move says who it would stand up (vacates), and changes nothing: vic stays seated", run(s) {
      s.call("olive", "create-world", { title: s.name }); s.call("olive", "set", { id: "@world", component: "roles:vic", value: { role: "player" } });
      s.call("olive", "create", { id: "chair", model: "chair", components: { sockets: { a: { pos: [0, 0.45, 0], body: { action: "sit" } } } }, place: { at: [4, 0] } });
      s.call("vic", "move", { to: [4, 0, -0.6] }); const sit = s.call("vic", "use", { id: "chair", action: "sit" }); const occ = s.w().presence.occupants?.vic?.to ?? null;
      const dry = s.call("olive", "set", { id: "chair", component: "transform", value: { pos: [6, 0, 0], q: [0, 0, 0, 1], scale: [1, 1, 1] }, dry: true });
      return { sit: show(sit), occ, dry: show(dry), vacates: dry?.vacates ?? null, still: s.w().presence.occupants?.vic?.to ?? null }; },
    good: (o) => o.sit === "ok" && !!o.occ && /^ok|dry/.test(o.dry) && JSON.stringify(o.vacates) === JSON.stringify([{ who: "vic", socket: o.occ }]) && o.still === o.occ },
  { id: "O2", what: "…a presence file written before (`seats`) is read as `occupants` and only the new key is kept", run() {
      const w = D.worldOf({ name: "o2", entries: [], getBlob: () => null, putBlob: () => "", now: () => T, writeLine: () => {}, presence: { bodies: {}, holds: {}, seats: { vic: { to: "s1", since: 3 } } }, savePresence: () => {}, scripts: null });
      return { keys: Object.keys(w.presence), occ: w.presence.occupants?.vic?.to ?? null }; },
    good: (o) => o.occ === "s1" && !o.keys.includes("seats") },
  { id: "O3", what: "…body consent's kind is `occupy` (`seat` is no kind), and the reach that bounds taking any station is OCCUPY_REACH (no SIT_REACH/SEAT_REACH)", async run(s) {
      s.call("olive", "create-world", { title: s.name }); s.call("olive", "move", { to: [0, 0, 0] }); s.call("vic", "move", { to: [0.5, 0, 0] });
      const occ = s.call("olive", "body", { to: "vic", kind: "occupy" }), seat = s.call("olive", "body", { to: "vic", kind: "seat" });
      const SK = await import(TREE + "shared/sockbody.js"); const C = await import(TREE + "shared/protocol/consent.js");
      return { occ: show(occ), seat: show(seat), reach: !!SK.OCCUPY_REACH, old: "SIT_REACH" in SK || "SEAT_REACH" in SK, cls: C.KIND_CLASS?.occupy ?? null, oldCls: C.KIND_CLASS?.seat ?? null }; },
    good: (o) => !/^refused shape/.test(o.occ) && /^refused shape/.test(o.seat) && o.reach && !o.old && o.cls === "displace" && o.oldCls === null },
  { id: "O4", what: "…the readers and the words follow: sockbody's vacatedAt/vacatedFromMine read `socket`, the browser and the agent read `vacated`, the spec, AGENTS.md, SCRIPTS.md and WIRE.md say `vacated {socket, …}` and never `unseated`, and the version history records it", async run() {
      const SK = await import(TREE + "shared/sockbody.js"); const lb = readText("client/lib/localbody.js"), ag = readText("mcpl/agent.ts"), md = readText("spec/PROTOCOL.md"), a = readText("AGENTS.md"), sc = readText("docs/SCRIPTS.md"), wi = readText("docs/WIRE.md");
      return { mine: SK.vacatedFromMine?.({ socket: "s1" }, { to: "s1" }) === true && SK.vacatedFromMine?.({ seat: "s1" }, { to: "s1" }) === false, at: JSON.stringify(SK.vacatedAt?.({ at: [1, 2, 3] })),
        lb: /m\?\.type === 'vacated'/.test(lb) && !/'unseated'/.test(lb), ag: /m\.type === "vacated"/.test(ag) && !/"unseated"/.test(ag),
        docs: [md.slice(0, md.indexOf("## Version history")), a, sc, wi].every((t) => !/\bunseat/i.test(t)) && /`vacated \{socket, by,\s+why, at\}`/.test(md) && /`vacated`/.test(a) && /`vacated \{socket, host\?, by, why, at\?\}`/.test(wi), vh: /occupy/.test(md.slice(md.indexOf("## Version history"))) }; },
    good: (o) => o.mine && o.at === "[1,2,3]" && o.lb && o.ag && o.docs && o.vh },
  // ---------------- M: move {client} is gone ----------------
  { id: "M1", what: "(research #14) move takes no `client`: arriving leaves no client kind on the authority's track, and `move {client}` is refused unknown-arg; VERBSPEC.move lists no client", run(s) {
      s.call("olive", "create-world", { title: s.name }); s.call("olive", "set", { id: "@world", component: "roles:vic", value: { role: "player" } });
      const a = s.call("vic", "move", { to: [0, 0, 0.5] }); const body = s.w().presence.bodies.vic ?? null;
      const c = s.call("olive", "move", { to: [1, 0, 0.5], client: "agent" });
      return { a: show(a), keys: body ? Object.keys(body) : null, c: show(c), spec: Object.keys(VS.VERBSPEC?.move?.args ?? {}) }; },
    good: (o) => o.a === "ok" && Array.isArray(o.keys) && !o.keys.includes("client") && /^refused unknown-arg/.test(o.c) && o.spec.includes("to") && !o.spec.includes("client") },
  { id: "M2", what: "…and nobody sends it: the browser's arrival (thingphysics.js) and the agent's moves (agent.ts) carry no client", run() {
      const tp = readText("client/lib/thingphysics.js"), ag = readText("mcpl/agent.ts");
      return { tp: /client: '(human|agent)'/.test(tp), ag: /client: "(human|agent)"/.test(ag), tpMoves: (tp.match(/sendRequest\('move'/g) ?? []).length }; },
    good: (o) => !o.tp && !o.ag && o.tpMoves >= 2 },
  // ---------------- V: the spoken trio is anyone's ----------------
  { id: "V1", what: "(R 10-17: TTS is anyone's) a say marked spoken by a participant who declared nothing keeps its trio (no kind gate, guard); the say doc names any participant, a person using TTS included", run(s) {
      s.call("olive", "create-world", { title: s.name }); s.call("olive", "set", { id: "@world", component: "roles:vic", value: { role: "player" } });
      const r = s.call("vic", "say", { text: "read aloud", spoken: true, utt: 3 }); const e = s.entries().findLast((x: any) => x.kind === "say");
      const doc = String(VS.VERBSPEC?.say?.args?.spoken?.doc ?? "");
      return { r: show(r), body: e?.body ?? null, doc }; },
    good: (o) => o.r === "ok" && o.body?.spoken === true && o.body?.utt === 3 && /anyone|any participant/.test(o.doc) && /TTS/.test(o.doc) && !/agent/.test(o.doc) },
  // ---------------- X: the spec and docs say it ----------------
  { id: "X1", what: "PROTOCOL §6a \"One kind of participant\": six rules (one gate; ids carry no kind; declared never inferred, `declares`, absent undeclared; same constraints on every path; policy by kind in the open; a false declaration is moderation), rule 3 keeping the spoken trio as anyone's; §3.1 points at rule 2; §5 consent decided the same way for every kind of body (recut A2)", run() {
      const md = readText("spec/PROTOCOL.md"); const s6a = section(md, /\n## 6a\. /).replace(/[ \t]*\n[ \t]*(?!\d\. )/g, " "); const s31 = md.slice(md.indexOf("### 3.1"), md.indexOf("\n## 4. ")); const s5 = section(md, /\n## 5\. /);
      const rules = [...s6a.matchAll(/^(\d)\. \*\*/gm)].map((m) => m[1]).join("");
      return { head: /## 6a\. One kind of participant/.test(s6a), rules,
        r1: /\*\*One gate for everyone\.\*\*/.test(s6a) && /MUST NOT read what is behind a participant/.test(s6a),
        r2: /\*\*Ids carry no kind\.\*\*/.test(s6a) && /MUST NOT encode what holds it/.test(s6a),
        r3: /\*\*A declared status, never an inferred one\.\*\*/.test(s6a) && /`declares`/.test(s6a) && /absent means \*\*undeclared\*\*, and no word is assumed in its place/.test(s6a) && /MUST NOT set it for a participant from their credential/.test(s6a),
        tts: /spoken trio/.test(s6a) && /whatever voices the words/.test(s6a) && !/"person"/.test(s6a) && !/a say is a say, however it was spoken/.test(s6a),
        r4: /\*\*The same constraints on every path\.\*\*/.test(s6a), r5: /\*\*Policy by kind is a world's choice, in the open\.\*\*/.test(s6a), r6: /\*\*A false declaration is a moderation matter\*\*/.test(s6a),
        s31: /§6a/.test(s31) && /shape MUST NOT encode what holds it/.test(s31), s5: /the same way for every kind of\s+body/.test(s5) && /Arriving is presence/.test(s5) }; },
    good: (o) => o.head && o.rules === "123456" && o.r1 && o.r2 && o.r3 && o.tts && o.r4 && o.r5 && o.r6 && o.s31 && o.s5 },
  { id: "X2", what: "(research #18) §8, SCRIPTS.md and scriptaudit.js name the stand-ins by shape (minted-shaped and another valid shape), never person- or agent-shaped, and no script \"greets people and not agents\"", run() {
      const md = readText("spec/PROTOCOL.md"), sc = readText("docs/SCRIPTS.md"), au = readText("shared/protocol/scriptaudit.js"); const s8 = section(md, /\n## 8\. /);
      const kindWords = /(person|agent)-\s*shaped|greets people and not\s+agents|stand-ins? of (different|another) KINDS?\b/i;
      return { s8: /one minted-shaped \(`u-` and 20 lowercase\) and one of another valid shape/.test(s8), md: kindWords.test(md), sc: kindWords.test(sc), au: kindWords.test(au), scMint: /minted-shaped/.test(sc), auMint: /minted-shaped/.test(au) }; },
    good: (o) => o.s8 && !o.md && !o.sc && !o.au && o.scMint && o.auMint },
  { id: "X3", what: "(research #14) verbspec's move says arriving is presence (nothing logged) and only a teleport is an act on the record", run() {
      const d = String(VS.VERBSPEC?.move?.doc ?? ""); return { d: d.slice(0, 400), presence: /Arriving is presence \(nothing is logged\)/.test(d), old: /first move \(arriving\)[^.]*on the record/.test(d) }; },
    good: (o) => o.presence && !o.old },
  { id: "X4", what: "(research #12) the stale comments are gone: no \"agents accept by default\" (client consent.js) or \"agents accept, as they accept being posed\" (agent.ts); a caption isn't \"agents perceive, humans watch\"", run() {
      const c = readText("client/lib/consent.js"), a = readText("mcpl/agent.ts"), m = readText("server/messages.ts");
      return { c: /agents accept by default/.test(c), a: /agents accept, as they/.test(a), m: /Agents perceive a paragraph; humans watch/.test(m) }; },
    good: (o) => !o.c && !o.a && !o.m },
  { id: "X5", what: "§1's say names the spoken trio as any participant's (a person using TTS included), and docs/WIRE.md's join and arrive carry `declares`, not `agent`", run() {
      const md = readText("spec/PROTOCOL.md"), wire = readText("docs/WIRE.md"); const say = (md.match(/^- \*\*`say`\*\*[^\n]*(\n  [^\n]*)*/m) ?? [""])[0];
      return { say: /`spoken: true`/.test(say) && /any participant/i.test(say) && /TTS/.test(say), wire: /spectate\?, declares\?, renderer\?/.test(wire) && /`arrive` carries `\{id, avatar, declares\?/.test(wire) && !/`agent` \(self-declared/.test(wire) }; },
    good: (o) => o.say && o.wire },
];

let pass = 0, fail = 0;
for (const c of cases) {
  if (!want([c.id])) continue;
  let o: any; try { o = await c.run(session()); } catch (e) { o = { threw: String(e?.stack ?? e).slice(0, 600) }; }
  let good = false; try { good = !o?.threw && !!c.good(o); } catch { good = false; }
  if (good) { pass++; console.log(`ok   ${c.id} ${c.what}`); }
  else { fail++; console.log(`FAIL ${c.id} ${c.what}\n     ${JSON.stringify(o)?.slice(0, 900)}`); }
}
console.log(`[parity-check] ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
