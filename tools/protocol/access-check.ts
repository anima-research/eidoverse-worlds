// tools/protocol/access-check.ts — WHO MAY COME IN, decided by the world (upstream #258/#259, ported to this protocol
// 2026-10-17: shared/protocol/access.js + server/access.ts), against a real sequencer. Scratch port, scratch WORLDS_DIR, its
// own tokens.json; never 8968/8970. usage: bun tools/protocol/access-check.ts
//   A1  invite-only (@world.access {join: listed}): someone not listed is refused as for no world (world-unavailable);
//       someone listed comes in
//   A2  watch only ({join: listed, watch: anyone}): the same person may watch (spectate), and a body is refused
//   A3  /worlds and the reads are per caller: an invite-only world is on no stranger's map and /geom answers as for no
//       world; a listed caller's bearer sees it (access, you); /access answers enter | watch | none, 404 world-unavailable
//       to whom the world isn't discoverable, and 401 anonymously
//   F23 no existence oracle (docs/DESIGN-log-vocabulary.md §F F-3): O1–O11 at their block (O7–O9: interrupted and old-format
//       worlds, Mica 11-05; O10–O11: the same call sequence, not only the same bytes)
//   A4  closing the door removes whoever is no longer let in, at once (4010); owners stay
//   A5  a timed grant (roles:<id>.until): its holder is told before it ends (notice), and when it passes the authority
//       writes its end (expire-roles) and the door removes them (4010)
//   A6  until is refused in the past and on an owner
//   A7  a reset keeps an invite-only world's door and the people it lists
//   A8  a ban in the moderator log closes the door after a restart too, before the world is loaded: a banned caller
//       still listed in an invite-only world gets 404 from /geom and /heightmap, finds it on no map, and /access says
//       none — the refusal never loads the world (Antra's review of f91840e5 P1: /geom was 200); a kick closes no door
//   A12 (security review 10-18 H1) an operator's SERVER ban binds to the target's account NOW: a present target is removed and
//       can't reconnect (4006, "these worlds"), an absent one can't join; the record carries the account; unban lifts it
//   A12b a server ban by u- identity binds the absent account; days gives it an end; unban by identity lifts it
//   A13 (10-18 H2) the client's address: X-Real-IP / X-Forwarded-For honoured only from a trusted proxy (loopback, TRUSTED_PROXIES);
//       from any other peer the socket's own address is used (a guest can't pick or frame an address)
//   A14 (10-18 M6) a timed grant whose until has passed is ABSENT on every read, loaded or not: an unloaded world's /access and
//       /worlds refuse the ex-member before any sweep, and so does the join, while the log still holds the grant
//   A15 (DESIGN-world-access.md, review 10-17) what a join proves is that join's own credential: a credentialed socket's re-join
//       under a member's name is refused, with its own token it is still itself, and it files no identity under a typed name
//   A16 (review 10-17) the review's second bypass, a name lookup that revoked another record, can't arise: a role is addressed
//       only by the actor's id. Pinned: a role under a bare name is refused, and deleting one member's role leaves a co-owner
//       an owner and the door closed
//   A17 (review 10-17) a revoke takes effect: accepted, the member is removed now (4010), can't rejoin, and the log holds it
//   B5, B7, B12, B14, B16, B17 (anima-review[bot] on #260, 11-02): address bans at the reads, a torn door line, a person's aid1
//       token at the reads, a sweep without custody, /library-list's siblings, a world name's case — each at its block
// @ts-nocheck
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { ENGINE, scratch } from "./common.ts";
import { tryUntil, pause } from "./wait.ts";
import { freePort } from "../harness.ts";
import { helloOf } from "../../shared/protocol/hello.js";

const root = scratch("access");
let pass = 0, fail = 0;
const ok = (cond, what, detail?) => { if (cond) pass++; else { fail++; console.log(`  FAIL ${what}${detail !== undefined ? ` — ${JSON.stringify(detail).slice(0, 400)}` : ""}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const W = path.join(root, "w"); fs.mkdirSync(W, { recursive: true });
const TOK = path.join(root, "tokens.json");
fs.writeFileSync(TOK, JSON.stringify({ "tok-rowan": { id: "Rowan" }, "tok-moss": { id: "Moss" }, "tok-wren": { id: "Wren" }, "tok-fen": { id: "Fen" }, "tok-ivy": { id: "Ivy" } }));
const env = (extra = {}) => ({ ...process.env, WORLDS_DIR: W, OPT_DIR: path.join(root, "opt"), SKIP_OPT_SWEEP: "1", HOST: "127.0.0.1",
  BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0", JOIN_TOKEN: "", SERVER_OPERATORS: "", AGENT_TOKENS_PATH: TOK, SESSIONS_PATH: path.join(root, "sessions.json"),
  TRUST_NAMES: "1", ACCESS_SWEEP_MS: "250", ...extra });
const tool = (args) => { const r = Bun.spawnSync(["bun", "tools/protocol/world.ts", ...args], { cwd: ENGINE, env: env() }); return { code: r.exitCode, out: r.stdout.toString() + r.stderr.toString() }; };
async function start(extra = {}) {
  const port = freePort(9410);   // the shared picker (setup-check took 9410 from a parallel shard, 10-30)
  const logf = path.join(root, `srv-${port}.log`);
  const p = Bun.spawn(["bun", "server/server.ts"], { cwd: ENGINE, env: env({ PORT: String(port), ...extra }), stdout: Bun.file(logf), stderr: Bun.file(logf + ".err") });
  for (let i = 0; i < 80; i++) { await sleep(150); if (p.exitCode != null) return { port, proc: p, dead: true, log: logf };
    try { if ((await fetch(`http://127.0.0.1:${port}/version`, { signal: AbortSignal.timeout(800) })).ok) return { port, proc: p, log: logf }; } catch {} }
  return { port, proc: p, dead: true, log: logf };
}
async function sock(port) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`); const msgs = []; let n = 0; const waiters = new Map();
  ws.onmessage = (ev) => { const m = JSON.parse(String(ev.data)); msgs.push(m); if (m.type === "reply") waiters.get(m.id)?.(m.reply); };
  let closed = null; ws.onclose = (e) => { closed = e.code; };
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  return {
    msgs, get closed() { return closed; },
    async join(world, id, extra = {}) { const k = msgs.length; ws.send(JSON.stringify({ type: "join", hello: helloOf(), world, id, avatar: "", replica: true, ...extra }));
      await tryUntil(`${id}'s join is answered (or its socket closes)`, () => msgs.slice(k).some((m) => m.type === "snapshot" || m.type === "error") || closed != null, { ms: 10_000, step: 50 });   // an upper bound: it returns as soon as the answer lands
      await sleep(80); return { snapshot: msgs.slice(k).find((m) => m.type === "snapshot"), errors: msgs.slice(k).filter((m) => m.type === "error").map((m) => m.error) }; },
    req: (verb, args = {}) => new Promise((res) => { const id = `r${++n}`; waiters.set(id, res); ws.send(JSON.stringify({ type: "request", id, verb, args })); setTimeout(() => res({ ok: false, timeout: true }), 4000); }),
    raw: (m) => ws.send(JSON.stringify(m)),
    close: () => ws.close(),
  };
}
const you = (j) => j.snapshot?.actor;
const worldsAs = async (port, bearer?) => (await (await fetch(`http://127.0.0.1:${port}/worlds`, bearer ? { headers: { authorization: `Bearer ${bearer}` } } : {})).json()).worlds ?? [];
const accessAs = async (port, world, bearer?) => { const r = await fetch(`http://127.0.0.1:${port}/access?world=${world}`, bearer ? { headers: { authorization: `Bearer ${bearer}` } } : {}); return { status: r.status, body: await r.json().catch(() => null) }; };

ok(tool(["found", "keep", "--owner", "Ann"]).code === 0, "(setup) found keep, Ann owns it");
const srv = await start();
ok(!srv.dead, "(setup) the server is up", srv.dead ? fs.readFileSync(srv.log + ".err", "utf8").slice(-400) : "");

const own = await sock(srv.port); const jo = await own.join("keep", "Ann");
ok(!!jo.snapshot && jo.snapshot.yourRights?.role === "owner", "(setup) Ann joins as the owner", [jo.errors, jo.snapshot?.yourRights]);
// people the world has seen (a role names an identity it knows): Rowan (an enrolled agent), Pip (a person), Moss
const ids: Record<string, string> = {};
for (const [name, extra] of [["Rowan", { agentToken: "tok-rowan" }], ["Pip", {}], ["Moss", { agentToken: "tok-moss" }], ["Wren", { agentToken: "tok-wren" }], ["Fen", { agentToken: "tok-fen" }]] as const) {
  const s = await sock(srv.port); const j = await s.join("keep", name, extra); ids[name] = you(j); s.close(); }
await sleep(150);
ok(Object.values(ids).every(Boolean), "(setup) Rowan, Pip and Moss have identities here", ids);
ok((await own.req("set", { id: "@world", component: `roles:${ids.Rowan}`, value: { role: "member" } })).ok, "(setup) Rowan is listed (a member)");

// ---- A4: closing the door removes whoever isn't listed, now ----
const bob = await sock(srv.port); const jb = await bob.join("keep", "Bob");
ok(!!jb.snapshot, "(A4 setup) Bob, not listed, is in the open world");
const close = await own.req("set", { id: "@world", component: "access", value: { join: "listed" } });
const removed = !!(await tryUntil("Bob is removed", () => bob.closed != null, { ms: 4000, step: 50 }));
ok(close.ok && removed && bob.closed === 4010 && bob.msgs.some((m) => m.type === "error" && /isn't open to you/.test(m.error)) && own.closed == null,
  "A4 closing the door removes Bob (4010, in the door's words); the owner stays", [close.ok, bob.closed, bob.msgs.filter((m) => m.type === "error").map((m) => m.error), own.closed]);

// ---- A1: invite-only ----
{ const c = await sock(srv.port); const j = await c.join("keep", "Carl");
  ok(!j.snapshot && c.closed === 4005 && j.errors.join(" ") === "No accessible world named keep.",
    "A1 someone not listed is refused as for no world at all: world-unavailable (4005), words that say nothing more (§F F-3)", [j.errors, c.closed]); c.close();
  const r = await sock(srv.port); const jr = await r.join("keep", "Rowan", { agentToken: "tok-rowan" });
  ok(!!jr.snapshot, "A1 someone listed comes in", jr.errors); r.close();
  const w = await sock(srv.port); const jw = await w.join("keep", "Carl", { spectate: true });
  ok(!jw.snapshot && w.closed === 4011, "A1 …and in an invite-only world the stranger can't even watch (world-unavailable: a watcher's close, as for no world)", [jw.errors, w.closed]); w.close(); }

// ---- A3: per-caller visibility ----
{ const anon = await worldsAs(srv.port), stranger = await worldsAs(srv.port, "tok-moss"), member = await worldsAs(srv.port, "tok-rowan");
  const geom = await fetch(`http://127.0.0.1:${srv.port}/geom?world=keep`);
  const mine = member.find((x) => x.name === "keep");
  ok(!anon.some((x) => x.name === "keep") && !stranger.some((x) => x.name === "keep") && geom.status === 404 && mine?.access === "invite-only" && mine?.you === "enter",
    "A3 an invite-only world is on no stranger's map (/geom answers as for no world); a listed caller sees it, and listed people enter", [anon.map((x) => x.name), stranger.map((x) => x.name), geom.status, mine]);
  const a0 = await accessAs(srv.port, "keep"), a1 = await accessAs(srv.port, "keep", "tok-moss"), a2 = await accessAs(srv.port, "keep", "tok-rowan"), a3 = await accessAs(srv.port, "nowhere", "tok-rowan");
  ok(a0.status === 401 && a1.status === 404 && a1.body?.code === "world-unavailable" && a2.body?.you === "enter" && a3.status === 404 && a3.body?.code === "world-unavailable",
    "A3 /access: 401 anonymously; world-unavailable (404) for a stranger, as for a name with no world; enter for a member", [a0.status, a1.body, a2.body, a3.body]); }
// ---- F23 no existence oracle: one discoverability predicate (access.ts discoverable) behind /worlds, the join, /access and redial ----
{ // the raw bytes of a join: every message as sent, then the close code and reason; the world's name stands as <name>
  const rawJoin = (world, extra = {}) => new Promise((res) => { const ws = new WebSocket(`ws://127.0.0.1:${srv.port}/ws`); const got = [];
    ws.onmessage = (ev) => got.push(String(ev.data)); ws.onclose = (ev) => res([...got, `close ${ev.code} ${ev.reason}`].join("\n").split(world).join("<name>"));
    ws.onopen = () => ws.send(JSON.stringify({ type: "join", hello: helloOf(), world, id: "Moss", agentToken: "tok-moss", avatar: "", replica: true, ...extra })); });
  const rawAccess = async (world, bearer?) => { const r = await fetch(`http://127.0.0.1:${srv.port}/access?world=${world}`, bearer ? { headers: { authorization: `Bearer ${bearer}` } } : {});
    return `${r.status} ${r.headers.get("content-type")} ${(await r.text()).split(world).join("<name>")}`; };
  const body = [await rawJoin("keep"), await rawJoin("nowhere")], watch = [await rawJoin("keep", { spectate: true }), await rawJoin("nowhere", { spectate: true })];
  const acc = [await rawAccess("keep", "tok-moss"), await rawAccess("nowhere", "tok-moss")];
  ok(body[0] === body[1] && watch[0] === watch[1] && acc[0] === acc[1] && /"code":"world-unavailable"/.test(body[0]) && /No accessible world named <name>\./.test(body[0]) && /^close 4005 world-unavailable$/m.test(body[0])
    && /^close 4011 world-unavailable$/m.test(watch[0]) && acc[0] === '404 application/json {"code":"world-unavailable","message":"No accessible world named <name>."}' && !/exists/.test(acc[0] + body[0] + watch[0]),
    "F23-O1 a hidden private world and a missing one are byte-equivalent to a signed stranger: the join (4005), the watcher's redial (4011) and /access (404 world-unavailable, no exists field)", { body, watch, acc });
  const map = (await worldsAs(srv.port, "tok-moss")).map((x) => x.name);
  ok(!map.includes("keep") && !map.includes("nowhere"), "F23-O2 /worlds lists neither the hidden world nor the missing one", map);
  const m = await sock(srv.port); const jm = await m.join("keep", "Rowan", { agentToken: "tok-rowan" }); const am = await accessAs(srv.port, "keep", "tok-rowan");
  ok(!!jm.snapshot && am.body?.exists === true && am.body?.you === "enter" && (await worldsAs(srv.port, "tok-rowan")).some((x) => x.name === "keep"),
    "F23-O3 an authorized member sees the private world (/worlds), is answered by /access (exists, enter) and joins it", [jm.errors, am.body]); m.close();
  ok(tool(["found", "porch", "--owner", "Ann"]).code === 0, "(F23-O4 setup) found porch, Ann owns it");
  const ow = await sock(srv.port); await ow.join("porch", "Ann"); const door = await ow.req("set", { id: "@world", component: "access", value: { join: "listed", watch: "anyone" } }); ow.close();
  const pj = await sock(srv.port); const jp = await pj.join("porch", "Moss", { agentToken: "tok-moss" }); const ap = await accessAs(srv.port, "porch", "tok-moss");
  ok(door.ok && !jp.snapshot && pj.closed === 4010 && /"porch" isn.t open to you.*you may watch/.test(jp.errors.join(" ")) && ap.body?.exists === true && ap.body?.you === "watch",
    "F23-O4 a world the stranger may discover (anyone may watch it) keeps its specific words: a body is refused naming the world and that watching is open; /access says exists, watch", [door.ok, jp.errors, pj.closed, ap.body]); pj.close();
  const anonAcc = [await rawAccess("keep"), await rawAccess("nowhere")], anonJoin = await Promise.all(["keep", "nowhere"].map((w) => new Promise((res) => { const ws = new WebSocket(`ws://127.0.0.1:${srv.port}/ws`); const got = [];
    ws.onmessage = (ev) => got.push(String(ev.data)); ws.onclose = (ev) => res([...got, `close ${ev.code}`].join("\n").split(w).join("<name>"));
    ws.onopen = () => ws.send(JSON.stringify({ type: "join", hello: helloOf(), world: w, id: "Carl", avatar: "", replica: true })); })));
  ok(anonAcc[0] === anonAcc[1] && /^401 /.test(anonAcc[0]) && /sign in/.test(anonAcc[0]) && !/world-unavailable/.test(anonAcc[0]) && acc[0] !== anonAcc[0] && anonJoin[0] === anonJoin[1] && /world-unavailable/.test(anonJoin[0]),
    "F23-O5 the unauthenticated stay classified apart from the signed-but-unentitled: /access says sign in (401) for both names, a stranger's says world-unavailable (404); a guest's join is world-unavailable for both", { anonAcc, anonJoin }); }
// F23-O7–O9 (Mica 11-05, #23 ruling 4): an interrupted conversion and an old-format world are unavailable states too. To a
// stranger every one is a missing world's bytes (join, a watcher's redial, /access, the reads, /worlds, the upgrade request);
// only the operator, and an old world's recognised owner, are told the specific state. Its own server, with an operator (Ivy)
{ const attic = path.join(W, "attic"); fs.mkdirSync(attic, { recursive: true });   // a first-protocol log; Fen owns it (by name)
  fs.writeFileSync(path.join(attic, "log.jsonl"), [{ seq: 0, ts: 1_700_000_000_000, actor: "world", verb: "grant", args: { id: "Fen", role: "owner" } },
    { seq: 1, ts: 1_700_000_001_000, actor: "Fen", verb: "say", args: { text: "mine" } }].map((e) => JSON.stringify(e)).join("\n") + "\n");
  ok(tool(["found", "halfway", "--owner", "Ann"]).code === 0, "(F23-O7 setup) found halfway, then mark it mid-swap");
  fs.writeFileSync(path.join(W, "halfway", "translation.lock"), "{}");
  const TRACE = path.join(root, "access-trace.jsonl");   // server/worldindex.ts accessTrace: the test seam (F23-O10/O11)
  const s3 = await start({ SERVER_OPERATORS: "agent:token:ivy", EIDO_TEST_ACCESS_TRACE: TRACE });
  ok(!s3.dead, "(F23-O7 setup) a server with an operator is up", s3.dead ? fs.readFileSync(s3.log + ".err", "utf8").slice(-400) : "");
  const raw = (world, extra = {}) => new Promise((res) => { const ws = new WebSocket(`ws://127.0.0.1:${s3.port}/ws`); const got = [];
    ws.onmessage = (ev) => got.push(String(ev.data)); ws.onclose = (ev) => res([...got, `close ${ev.code} ${ev.reason}`].join("\n").split(world).join("<name>"));
    ws.onopen = () => ws.send(JSON.stringify({ type: "join", hello: helloOf(), world, id: extra.agentToken ? String(extra.agentToken).slice(4) : "Carl", avatar: "", replica: true, ...extra })); });
  const upgrade = (world, tok) => new Promise((res) => { const ws = new WebSocket(`ws://127.0.0.1:${s3.port}/ws`); const got = [];
    ws.onmessage = (ev) => { got.push(String(ev.data)); if (JSON.parse(String(ev.data)).type === "world-upgrade-review") ws.close(); };
    ws.onclose = () => res(got.filter((g) => /world-upgrade-review/.test(g)).join("\n").split(world).join("<name>"));
    ws.onopen = () => ws.send(JSON.stringify({ type: "world-upgrade-review", id: 1, world, ...(tok ? { agentToken: tok } : {}) })); });
  const http = async (p, world, tok) => { const r = await fetch(`http://127.0.0.1:${s3.port}${p}${world}`, tok ? { headers: { authorization: `Bearer ${tok}` } } : {});
    return `${r.status} ${r.headers.get("content-type")} ${(await r.text()).split(world).join("<name>")}`; };
  const all = async (world, tok) => [await raw(world, tok ? { agentToken: tok } : {}), await raw(world, { spectate: true, ...(tok ? { agentToken: tok } : {}) }),
    await http("/access?world=", world, tok), await http("/geom?world=", world, tok), await http("/heightmap?world=", world, tok), await upgrade(world, tok)];
  const none = await all("nowhere", "tok-moss"), old = await all("attic", "tok-moss"), half = await all("halfway", "tok-moss");
  const map = (await worldsAs(s3.port, "tok-moss")).map((x) => x.name);
  ok(JSON.stringify(old) === JSON.stringify(none) && JSON.stringify(half) === JSON.stringify(none) && /^close 4005 world-unavailable$/m.test(none[0]) && /^close 4011 world-unavailable$/m.test(none[1])
    && /^404 .*world-unavailable/.test(none[2]) && /"code":"world-unavailable"/.test(none[5]) && !/older|interrupted|old-format/.test(old.join() + half.join()) && !map.includes("attic") && !map.includes("halfway"),
    "F23-O7 to a signed stranger an old-format world and an interrupted conversion are a missing world's bytes: the join (4005), the watcher's redial (4011), /access, /geom, /heightmap, the upgrade review; on no /worlds map", { none, old, half, map });
  const gNone = await all("nowhere"), gOld = await all("attic"), gHalf = await all("halfway");
  ok(JSON.stringify(gOld) === JSON.stringify(gNone) && JSON.stringify(gHalf) === JSON.stringify(gNone) && /world-unavailable/.test(gNone[0]),
    "F23-O7 …and to a guest (no credential) too", { gNone, gOld, gHalf });
  const jOld = await raw("attic", { agentToken: "tok-ivy" }), jHalf = await raw("halfway", { agentToken: "tok-ivy" });
  const aOld = await accessAs(s3.port, "attic", "tok-ivy"), aHalf = await accessAs(s3.port, "halfway", "tok-ivy"), aNone = await accessAs(s3.port, "nowhere", "tok-ivy");
  ok(/"code":"old-format"/.test(jOld) && /"operator":true/.test(jOld) && /older version of Eidoverse/.test(jOld) && /^close 4005 old-format world$/m.test(jOld)
    && /interrupted/.test(jHalf) && /^close 4005 interrupted conversion$/m.test(jHalf)
    && aOld.status === 200 && aOld.body?.state === "old-format" && aHalf.status === 200 && aHalf.body?.state === "interrupted" && aNone.status === 404 && aNone.body?.code === "world-unavailable",
    "F23-O8 the operator is told the specific state: the join says old-format (operator, may) or that its conversion was interrupted, and /access says state old-format / interrupted; a missing name is still world-unavailable", { jOld, jHalf, aOld: aOld.body, aHalf: aHalf.body });
  const fOld = await raw("attic", { agentToken: "tok-fen" }), fHalf = await raw("halfway", { agentToken: "tok-fen" }), faOld = await accessAs(s3.port, "attic", "tok-fen");
  ok(/"code":"old-format"/.test(fOld) && /"owner":"(bound|name)"/.test(fOld) && /"may":true/.test(fOld) && faOld.status === 200 && faOld.body?.state === "old-format"
    && /^close 4005 world-unavailable$/m.test(fHalf) && !/interrupted/.test(fHalf),
    "F23-O9 the old world's recognised owner (Fen, the grant's name) is told it is old-format and may upgrade it (join and /access); an interrupted conversion is said to the operator only", { fOld, fHalf, faOld: faOld.body });
  // F23-O10/O11 (Mica 11-05, "timing oracle": byte equality is necessary, not sufficient): a structural receipt. The server
  // traces each access-index lookup, each read of a world's bytes into the index, each owner check and each world load
  // (EIDO_TEST_ACCESS_TRACE). For an unauthorized asker a hidden old-format world, an interrupted conversion and a hidden
  // saved world (keep: invite-only) make the call sequence a missing name makes: index lookups only, no world read or
  // loaded, no owners read; the bytes are O7's. The recognised owner is told from the same lookup (the index's owners).
  const traced = async (fn) => { fs.writeFileSync(TRACE, ""); await fn();   // each trace line is written before its answer is sent
    return fs.readFileSync(TRACE, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)); };
  // the asker's own calls: the index's background sweep ("refresh", every 2 s, whoever asks) is no part of them
  const seq = (t, world) => t.filter((x) => x.ev !== "refresh").map((x) => `${x.ev}:${x.name === world ? "<name>" : x.name}`).join(" ");
  const asked = {};
  // Wren: a stranger to all four whose upgrade-request slots O7 hasn't spent (six per ten minutes, for every name)
  for (const tok of ["tok-wren", undefined]) for (const world of ["nowhere", "attic", "halfway", "keep"]) {
    let bytes; const t = await traced(async () => { bytes = await all(world, tok); }); asked[`${tok ?? "guest"} ${world}`] = { seq: seq(t, world), bytes: JSON.stringify(bytes) }; }
  const want = (tok) => asked[`${tok} nowhere`];
  const same = (tok) => ["attic", "halfway", "keep"].every((w) => asked[`${tok} ${w}`].seq === want(tok).seq && asked[`${tok} ${w}`].bytes === want(tok).bytes);
  ok(/^(lookup:<name> ?)+$/.test(want("tok-wren").seq) && same("tok-wren") && same("guest") && !Object.values(asked).some((a) => /read:|owners:|load:/.test(a.seq)),
    "F23-O10 to a stranger and to a guest, a hidden old-format world, an interrupted conversion and a hidden saved world are a missing name's call sequence (index lookups only: no world read or loaded, no owners read) and its bytes", asked);
  const fen = seq(await traced(() => raw("attic", { agentToken: "tok-fen" })), "attic"), ivy = seq(await traced(() => raw("attic", { agentToken: "tok-ivy" })), "attic");
  ok(/^lookup:<name>$/.test(fen) && /^lookup:<name>$/.test(ivy),
    "F23-O11 the recognised owner (Fen) and the operator (Ivy) are told from the same one lookup: no old log read, no owner CLI (O9 checks what they are told)", { fen, ivy });
  try { s3.proc.kill(); } catch {}
  fs.rmSync(attic, { recursive: true, force: true }); fs.rmSync(path.join(W, "halfway"), { recursive: true, force: true }); }
// F23-O6 (mutation, run by hand and recorded in the commit): restoring `exists: true` on /access for an undiscoverable world, or
// the old split (hidden → 4010 "isn't open to you", missing → 4005/4011 "no such world"), turns F23-O1 red
// A3b: an unloaded world is read in its own case only, as the join door reads it (world.ts worldDirNamed); the variant
// is only a finding on a case-insensitive filesystem (Windows, macOS): elsewhere the stat misses on its own
{ const code = `const { doorFor } = await import(${JSON.stringify(new URL("../../server/access.ts", import.meta.url).href)});
    const fs = await import("node:fs"); const ci = fs.existsSync(${JSON.stringify(path.join(W, "KEEP"))});
    console.log(JSON.stringify({ exact: doorFor("keep") !== null, variant: doorFor("Keep") !== null || doorFor("KEEP") !== null, ci }));`;
  const r = Bun.spawnSync(["bun", "-e", code], { env: env(), stdout: "pipe", stderr: "pipe" }); let j: any = null; try { j = JSON.parse(r.stdout.toString().trim()); } catch {}
  ok(!!j && j.exact && !j.variant, `A3b the unloaded door reader answers for a world's name in its own case only, never a case variant of it${j?.ci ? "" : " (case-sensitive filesystem here: the variant misses on its own)"}`, j ?? r.stderr.toString().slice(0, 300)); }

// ---- A2: watch only ----
{ ok((await own.req("set", { id: "@world", component: "access", value: { join: "listed", watch: "anyone" } })).ok, "(A2 setup) the door: watch only");
  const w = await sock(srv.port); const jw = await w.join("keep", "Carl", { spectate: true });
  const b = await sock(srv.port); const jb2 = await b.join("keep", "Carl");
  const list = (await worldsAs(srv.port)).find((x) => x.name === "keep");
  ok(!!jw.snapshot && !jb2.snapshot && b.closed === 4010 && /you may watch/.test(jb2.errors.join(" ")) && list?.access === "watch" && list?.you === "watch",
    "A2 watch only: a stranger may watch; a body is refused (4010) and told they may watch; /worlds says watch, watch", [!!jw.snapshot, jb2.errors, b.closed, list]);
  w.close(); b.close();
  await own.req("set", { id: "@world", component: "access", value: { join: "listed" } }); }

// ---- A6: until's rules ----
{ const past = await own.req("set", { id: "@world", component: `roles:${ids.Pip}`, value: { role: "member", until: Date.now() - 1000 } });
  const onOwner = await own.req("set", { id: "@world", component: `roles:${ids.Pip}`, value: { role: "owner", until: Date.now() + 60_000 } });
  ok(!past.ok && past.refused?.code === "bounds" && !onOwner.ok && /ownership never expires/.test(onOwner.refused?.reason ?? ""),
    "A6 until is refused in the past, and on an owner", [past.refused, onOwner.refused]); }

// ---- A5: a timed grant ----
{ const set = await own.req("set", { id: "@world", component: `roles:${ids.Pip}`, value: { role: "member", until: Date.now() + 2500 } });
  const p = await sock(srv.port); const jp = await p.join("keep", "Pip");
  const told = !!(await tryUntil("Pip is told the grant ends", () => p.msgs.some((m) => m.type === "notice" && /ends in/.test(m.text)), { ms: 2000, step: 50 }));
  const gone = !!(await tryUntil("Pip is removed when the grant ends", () => p.closed != null, { ms: 6000, step: 50 }));
  const log = fs.readFileSync(path.join(W, "keep", "world.jsonl"), "utf8");
  const ended = log.split("\n").filter(Boolean).map((l) => JSON.parse(l)).find((e) => e.kind === "request" && e.verb === "expire-roles");
  const role = (await own.req("look", {})) && null;
  ok(set.ok && !!jp.snapshot && told && gone && p.closed === 4010 && ended?.actor === "system" && ended?.body?.ids?.includes(ids.Pip),
    "A5 a timed grant: its holder is told before it ends; the authority writes its end (expire-roles, the system's act) and the door removes them (4010)",
    [set.ok, !!jp.snapshot, told, p.closed, ended?.body, p.msgs.filter((m) => m.type === "notice" || m.type === "error").map((m) => m.text ?? m.error)]);
  void role; }

// ---- A7: a reset keeps an invite-only world's door and the people it lists ----
{ const first = () => fs.readFileSync(path.join(W, "keep", "world.jsonl"), "utf8").split("\n")[0];   // the genesis: a reset writes a new one
  const g0 = first(), k0 = own.msgs.length; own.raw({ type: "world-reset", name: "keep" });
  await tryUntil("the reset answers (or the owner's socket closes)", () => own.closed != null || own.msgs.slice(k0).some((m) => m.type === "world-reset" || m.type === "error"), { ms: 6000, step: 50 });
  await sleep(400);
  const log = fs.readFileSync(path.join(W, "keep", "world.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const ops = log.filter((e) => e.kind === "change").flatMap((e) => (Array.isArray(e.body?.ops) ? e.body.ops : [e.body]));   // a batch, or one op
  const access = ops.find((o) => o.id === "@world" && o.comp === "access")?.value;
  const rowan = ops.find((o) => o.id === "@world" && o.comp === `roles:${ids.Rowan}`)?.value;
  const reset = own.msgs.slice(k0).some((m) => m.type === "world-reset") && first() !== g0;   // the reset happened: an error also ends the wait
  ok(reset && access?.join === "listed" && rowan?.role === "member", "A7 a reset keeps an invite-only world's door and the people it lists", [reset, access, rowan, ops.length, own.closed, own.msgs.slice(k0).map((m) => m.type + (m.error ? `: ${m.error}` : "")).slice(0, 6)]);
  // A7b (review of #260, server I7): a signed-in-only door is kept too (only "listed" was, so the reset opened it to guests)
  const set = await own.req("set", { id: "@world", component: "access", value: { join: "signed-in" } });
  const g1 = first(), k1 = own.msgs.length; own.raw({ type: "world-reset", name: "keep" });
  await tryUntil("the second reset answers (or the owner's socket closes)", () => own.closed != null || own.msgs.slice(k1).some((m) => m.type === "world-reset" || m.type === "error"), { ms: 6000, step: 50 });
  await sleep(400);
  const log2 = fs.readFileSync(path.join(W, "keep", "world.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const ops2 = log2.filter((e) => e.kind === "change").flatMap((e) => (Array.isArray(e.body?.ops) ? e.body.ops : [e.body]));
  const access2 = ops2.find((o) => o.id === "@world" && o.comp === "access")?.value;
  const reset2 = own.msgs.slice(k1).some((m) => m.type === "world-reset") && first() !== g1;
  ok(reset2 && set?.ok && access2?.join === "signed-in", "A7b a reset keeps a signed-in-only world's door", [reset2, set?.ok, set?.refused, access2, own.msgs.slice(k1).map((m) => m.type + (m.error ? `: ${m.error}` : "")).slice(0, 6)]);
  // the rest of this suite reads "keep" as invite-only: its door goes back as A7 left it
  const back = await own.req("set", { id: "@world", component: "access", value: access });
  ok(back?.ok, "(A7b) keep's invite-only door is put back for what follows", back?.refused); }

// ---- A8 (setup, loaded): Moss and Wren are listed; Moss is banned, Wren kicked (R 10-28: a kick bars nothing) ----
const geomAs = async (port, world, bearer) => (await fetch(`http://127.0.0.1:${port}/geom?world=${world}`, { headers: { authorization: `Bearer ${bearer}` } })).status;
{ const lm = await own.req("set", { id: "@world", component: `roles:${ids.Moss}`, value: { role: "member" } });
  const lw = await own.req("set", { id: "@world", component: `roles:${ids.Wren}`, value: { role: "member" } });
  const bm = await own.req("ban", { who: ids.Moss, reason: "A8" }), kw = await own.req("kick", { who: ids.Wren, reason: "A8" });
  const gm = await geomAs(srv.port, "keep", "tok-moss"), gw = await geomAs(srv.port, "keep", "tok-wren"), gr = await geomAs(srv.port, "keep", "tok-rowan");
  ok(lm.ok && lw.ok && bm.ok && kw.ok && gm === 404 && gw === 200 && gr === 200, "(A8 setup) listed, then banned / kicked: the loaded world's /geom refuses the banned (404); the kicked and a member still read it",
    [lm.refused, lw.refused, bm.refused, kw.refused, gm, gw, gr]); }

// (A14 setup) Fen is listed for 2.5 s; the server is stopped BEFORE that ends, so no sweep can write the end: the log keeps the grant
const fenUntil = Date.now() + 2500;
{ const r = await own.req("set", { id: "@world", component: `roles:${ids.Fen}`, value: { role: "member", until: fenUntil } }); ok(r.ok, "(A14 setup) Fen holds a timed grant", r.refused); }
own.close();
try { srv.proc.kill(); await srv.proc.exited; } catch {}

// ---- A3 (idle): after a restart, nobody in it, the invite-only world's door is read from its log without loading it ----
// A10's sessions (restored at boot): Rowan's account as a cookie session, once from a native pairing made before
// main #255 (HnSession.nativeWorld) and once not
// (a cookie session is a human's, human:…: that account is bound to Rowan's identity, so it is a member of keep as Rowan is)
const SID_NATIVE = "a".repeat(64), SID_FULL = "b".repeat(64);
{ const { directoryFor } = await import("../../server/directory.ts"); const d = directoryFor(W); d.bind(d.idOfSub("agent:token:rowan"), "human:test:rowan"); }
fs.writeFileSync(path.join(root, "sessions.json"), JSON.stringify({
  [SID_NATIVE]: { sub: "human:test:rowan", name: "Rowan", scopes: ["worlds:join"], exp: Date.now() + 3600_000, nativeWorld: "water" },
  [SID_FULL]: { sub: "human:test:rowan", name: "Rowan", scopes: ["worlds:join"], exp: Date.now() + 3600_000 } }));
{ const s2 = await start();
  const anon = await worldsAs(s2.port), member = (await worldsAs(s2.port, "tok-rowan")).find((x) => x.name === "keep");
  const a1 = await accessAs(s2.port, "keep", "tok-ivy");   // a stranger (Moss is listed by now, for A8; Fen holds A14's timed grant)
  ok(!s2.dead && !anon.some((x) => x.name === "keep") && member?.loaded === false && member?.access === "invite-only" && member?.you === "enter" && a1.body?.code === "world-unavailable",
    "A3 an idle world's door is read from its log (not loaded): a stranger's map lacks it; a member's shows it, members, enter", [anon.map((x) => x.name), member, a1.body]);
  // A14 (security review 10-18 M6): Fen's grant has ended but no sweep ran (the world is unloaded, the log still holds it): the reads refuse
  await pause("Fen's timed grant runs out, with no sweep to write its end", Math.max(0, fenUntil + 51 - Date.now()));
  // …by the SERVER's clock: WSL's wall clock steps back ~1.4 s now and then (identity RS3, 10-22), so a test-side pause can end
  // while the server still reads the grant as live; it then answers Fen 'enter', serves her /geom, and that loads the world.
  // /access is a door read (it loads nothing): wait until it says the grant is over
  await tryUntil("the server's own clock has passed Fen's until", async () => (await accessAs(s2.port, "keep", "tok-fen")).body?.code === "world-unavailable", { ms: 5000, step: 100 });
  { const logHas = fs.readFileSync(path.join(W, "keep", "world.jsonl"), "utf8").includes(`"roles:${ids.Fen}"`) && !fs.readFileSync(path.join(W, "keep", "world.jsonl"), "utf8").includes("expire-roles");
    const map = await worldsAs(s2.port, "tok-fen"), acc = await accessAs(s2.port, "keep", "tok-fen"), g = await geomAs(s2.port, "keep", "tok-fen");
    const still = (await worldsAs(s2.port, "tok-rowan")).find((x) => x.name === "keep");
    ok(logHas && !map.some((x) => x.name === "keep") && acc.body?.code === "world-unavailable" && g === 404 && still?.loaded === false,
      "A14 an ended timed grant is absent on every read: the unloaded world's /worlds, /access and /geom refuse the ex-member (the log still holds the grant, no expire-roles yet), and the refusal loads nothing",
      { logHas, map: map.map((x) => x.name), access: acc.body, geom: g, loaded: still?.loaded }); }
  // A8: the same world, still not loaded — the moderator log is read with the door
  for (const [who, tok] of [["banned Moss", "tok-moss"]]) {
    const map = await worldsAs(s2.port, tok), acc = await accessAs(s2.port, "keep", tok);
    const g1 = await geomAs(s2.port, "keep", tok), g2 = await geomAs(s2.port, "keep", tok);
    const hm = await fetch(`http://127.0.0.1:${s2.port}/heightmap?world=keep&format=json`, { headers: { authorization: `Bearer ${tok}` } }); const hmText = await hm.text();
    const still = (await worldsAs(s2.port, "tok-rowan")).find((x) => x.name === "keep");
    ok(!map.some((x) => x.name === "keep") && acc.body?.you === "none" && g1 === 404 && g2 === 404 && hm.status === 404 && /no such world/.test(hmText) && still?.loaded === false,
      `A8 after a restart, the world unloaded: the ${who} (still listed) is refused by /worlds, /access, /geom (404, twice) and /heightmap, and the refusal loads nothing`,
      { map: map.map((x) => x.name), access: acc.body, geom: [g1, g2], heightmap: [hm.status, hmText.slice(0, 60)], loaded: still?.loaded }); }
  // A14, the join: the first join loads the world; the door reads Fen's ended grant as absent BEFORE any sweep (4010)
  { const logHas = !fs.readFileSync(path.join(W, "keep", "world.jsonl"), "utf8").includes("expire-roles");
    const f = await sock(s2.port); const jf = await f.join("keep", "Fen", { agentToken: "tok-fen" });
    ok(logHas && !jf.snapshot && f.closed === 4005 && jf.errors.join(" ") === "No accessible world named keep.", "A14 …and the join that loads the world is refused at the door (world-unavailable), the grant unswept until then", { logHas, join: jf.errors, closed: f.closed }); f.close(); }
  { // A10 (after A14's join, which must be the one that loads keep) (main #255, Mica 10-17: one sign-in, every world): a native session paired before that, which still carries
    // nativeWorld "water", is the account at every world's door, exactly as the same account's ordinary session
    const cookieGet = (sid, u) => fetch(`http://127.0.0.1:${s2.port}${u}`, { headers: { cookie: `ew_sess=${sid}` } });
    const gN = (await cookieGet(SID_NATIVE, "/geom?world=keep")).status, gF = (await cookieGet(SID_FULL, "/geom?world=keep")).status;
    const mapN = (await (await cookieGet(SID_NATIVE, "/worlds")).json()).worlds ?? [], mapF = (await (await cookieGet(SID_FULL, "/worlds")).json()).worlds ?? [];
    const aN = await (await cookieGet(SID_NATIVE, "/access?world=keep")).json(), aF = await (await cookieGet(SID_FULL, "/access?world=keep")).json();
    ok(gN === 200 && gF === 200 && mapN.some((x) => x.name === "keep") && mapF.some((x) => x.name === "keep") && aN.you === "enter" && aF.you === "enter",
      "A10 an old native session (nativeWorld water) reads another world as its account does (/geom 200, on /worlds, /access enter): no per-world fence",
      { geom: [gN, gF], map: [mapN.map((x) => x.name), mapF.map((x) => x.name)], access: [aN, aF] }); }
  try { s2.proc.kill(); await s2.proc.exited; } catch {} }
{ // A11 (review of PR #260, server.ts:742): a server operator (SERVER_OPERATORS) has a NARROW, RECORDED repair capability through the
  // authority: Fen, an operator not listed in the invite-only world, gets in (the bypass) but an ordinary write is still the
  // world's to judge; operator-repair lifts Moss's ban and lists Fen, each the operator's own act / record marked operator;
  // a non-operator's operator-repair is refused
  // A11b: the address entry a guest's ban of Moss left in keep, which operator-repair's unban must lift too
  const BJ = path.join(W, ".bans.json"), was = fs.existsSync(BJ) ? JSON.parse(fs.readFileSync(BJ, "utf8")) : {};
  fs.writeFileSync(BJ, JSON.stringify({ ...was, "world:keep:addr:a11b": { by: "Rowan", ts: Date.now(), name: "drifter", addr: "a11b", until: Date.now() + 3600_000, world: "keep", who: ids.Moss } }));
  const s3 = await start({ SERVER_OPERATORS: "agent:token:fen" });
  const fen = await sock(s3.port); const jf = await fen.join("keep", "Fen", { agentToken: "tok-fen" }); const fenId = you(jf);
  let k = 0; const repair = async (s, verb, args) => { const id = `op${++k}`; s.raw({ type: "operator-repair", id, verb, args });
    await tryUntil(`the reply to operator-repair ${verb}`, () => s.msgs.some((m) => m.type === "reply" && m.id === id), { ms: 4000, step: 50 }); return s.msgs.find((m) => m.type === "reply" && m.id === id); };
  const plain = await fen.req("set", { id: "@world", component: `roles:${fenId}`, value: { role: "owner" } });
  const unban = await repair(fen, "unban", { who: ids.Moss });
  const list = await repair(fen, "set", { id: "@world", component: `roles:${fenId}`, value: { role: "member" } });
  const wide = await repair(fen, "set", { id: "@world", component: "about", value: { name: "x", text: "" } });
  const row = await sock(s3.port); const jr = await row.join("keep", "Rowan", { agentToken: "tok-rowan" });
  const notOp = await repair(row, "unban", { who: ids.Moss });
  const mossGeom = await geomAs(s3.port, "keep", "tok-moss");
  const log = fs.readFileSync(path.join(W, "keep", "world.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const mod = fs.readFileSync(path.join(W, "keep", "world.mod.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const act = log.find((e) => e.kind === "request" && e.actor === fenId && e.body?.operator === true && e.body?.args?.component === `roles:${fenId}`);
  const rec = mod.find((m) => m.verb === "unban" && m.who === ids.Moss && m.actor === fenId && m.operator === true);
  ok(!!jf.snapshot && !plain.ok && plain.refused?.code === "rights" && unban?.reply?.ok && list?.reply?.ok && wide?.reply?.refused?.code === "rights" && !!jr.snapshot && notOp?.reply?.refused?.code === "rights" && mossGeom === 200 && !!act && !!rec,
    "A11 an operator repairs through the authority, narrowly and on the record: ordinary write refused, operator-repair unbans and lists (act / mod record marked operator), another component refused, a non-operator refused",
    { join: jf.errors, plain: plain.refused, unban: unban?.reply, list: list?.reply, wide: wide?.reply?.refused, notOp: notOp?.reply?.refused, mossGeom, act: !!act, rec: !!rec });
  const left = Object.keys(JSON.parse(fs.readFileSync(BJ, "utf8")));
  ok(unban?.reply?.ok && !left.includes("world:keep:addr:a11b"), "A11b operator-repair's unban lifts the address entry the guest's ban left, as the request path's unban does", left);
  // A12 (security review 10-18 H1): a SERVER ban binds to the account now. Rowan is present: removed, and refused on reconnect;
  // Moss is absent: the directory knows the account wearing that name, and the join is refused; the record names the account
  const modMsgs = () => fen.msgs.filter((m) => m.type === "mod" || m.type === "error").map((m) => m.text ?? m.error);
  const k0 = fen.msgs.length; fen.raw({ type: "server-ban", id: "Rowan", reason: "A12" }); await tryUntil("Rowan is removed by the server ban", () => row.closed != null, { ms: 3000, step: 50 });
  const row2 = await sock(s3.port); const jr2 = await row2.join("keep", "Rowan", { agentToken: "tok-rowan" });
  fen.raw({ type: "server-ban", id: "Moss", reason: "A12" }); await tryUntil("Fen hears back on both server bans", () => fen.msgs.length > k0 + 1, { ms: 2000, step: 50 });
  const moss = await sock(s3.port); const jm = await moss.join("keep", "Moss", { agentToken: "tok-moss" });
  fen.raw({ type: "server-ban", id: "Nobody-Here-At-All" }); await tryUntil("a ban on a name nothing wears is refused", () => modMsgs().some((t) => /nothing a ban could bind to/.test(t)), { ms: 2000, step: 50 });
  const bans = JSON.parse(fs.readFileSync(path.join(W, ".bans.json"), "utf8"));
  const recR = Object.values(bans).find((b) => b.account === "agent:token:rowan"), recM = Object.values(bans).find((b) => b.account === "agent:token:moss");
  ok(row.closed === 4006 && !jr2.snapshot && row2.closed === 4006 && /banned from these worlds/.test(jr2.errors.join(" ")) && !jm.snapshot && moss.closed === 4006 && /these worlds/.test(jm.errors.join(" "))
    && !!recR && recR.name === "Rowan" && !!recM && Object.values(bans).every((b) => b.account || b.addr) && modMsgs().some((t) => /nothing a ban could bind to/.test(t)),
    "A12 a server ban binds now: the present target is removed (4006) and refused on reconnect, the absent target's join is refused, each record names the account (never a bare name), and a name nothing wears is refused",
    { rowClosed: row.closed, reconnect: [jr2.errors, row2.closed], moss: [jm.errors, moss.closed], bans, said: modMsgs().slice(-3) });
  const k1 = fen.msgs.length; fen.raw({ type: "server-unban", id: "Rowan" }); fen.raw({ type: "server-unban", id: "agent:token:moss" }); await tryUntil("Fen hears back on both server unbans", () => fen.msgs.length >= k1 + 2, { ms: 2000, step: 50 });
  const row3 = await sock(s3.port); const jr3 = await row3.join("keep", "Rowan", { agentToken: "tok-rowan" }); const moss2 = await sock(s3.port); const jm2 = await moss2.join("keep", "Moss", { agentToken: "tok-moss" });
  ok(!!jr3.snapshot && !!jm2.snapshot && Object.keys(JSON.parse(fs.readFileSync(path.join(W, ".bans.json"), "utf8"))).length === 0, "A12 server-unban by name or by account lifts it: both join again, the list is empty", [jr3.errors, jm2.errors]);
  row2.close(); row3.close(); moss.close(); moss2.close();
  // A12b: a server ban by u- identity binds the absent person's account, and days gives it an end; unban by identity lifts it
  const k2 = fen.msgs.length; fen.raw({ type: "server-ban", id: ids.Moss, days: 2, reason: "A12b" }); await tryUntil("Fen hears back on the identity ban", () => fen.msgs.slice(k2).some((m: any) => /ban/i.test(JSON.stringify(m))), { ms: 2000, step: 50 });
  const recI: any = Object.values(JSON.parse(fs.readFileSync(path.join(W, ".bans.json"), "utf8"))).find((b: any) => b.account === "agent:token:moss");
  const moss3 = await sock(s3.port); const jm3 = await moss3.join("keep", "Moss", { agentToken: "tok-moss" });
  const k3 = fen.msgs.length; fen.raw({ type: "server-unban", id: ids.Moss }); await tryUntil("Fen hears back on the identity unban", () => fen.msgs.length > k3, { ms: 2000, step: 50 });
  const moss4 = await sock(s3.port); const jm4 = await moss4.join("keep", "Moss", { agentToken: "tok-moss" });
  const { findBan: fb } = await import("../../server/moderation.ts");
  const lapsed = fb({ k: { by: "op", ts: 1, account: "agent:token:x", until: Date.now() - 1 } }, "agent:token:x"), held = fb({ k: { by: "op", ts: 1, account: "agent:token:x", until: Date.now() + 9e6 } }, "agent:token:x");
  ok(!!recI && typeof recI.until === "number" && Math.abs(recI.until - Date.now() - 2 * 86400000) < 60000 && !jm3.snapshot && !!jm4.snapshot && !lapsed && !!held,
    "A12b a server ban by u- identity binds the absent person's account (join refused), days sets until (and findBan lets a lapsed one go), unban by identity lifts it",
    { rec: recI, said: fen.msgs.slice(k2).map((m) => m.text ?? m.error), refused: jm3.errors, again: jm4.errors, lapsed: !!lapsed, held: !!held });
  moss3.close(); moss4.close();
  // A12c: the old global-* names are unknown types (no client of this dialect sends them: an old client gets no session): silence, nothing
  // runs. The server-bans after them answers, so the three were read before it
  const before = fs.readFileSync(path.join(W, ".bans.json"), "utf8"); const k4 = fen.msgs.length;
  for (const type of ["global-ban", "global-unban", "global-bans"]) fen.raw({ type, id: ids.Moss, reason: "A12c" });
  fen.raw({ type: "server-bans" });
  await tryUntil("Fen hears server-bans answer", () => fen.msgs.slice(k4).some((m: any) => m.type === "mod"), { ms: 2000, step: 50 });
  const heard = fen.msgs.slice(k4); const { MESSAGES } = await import("../../server/messages.ts");
  ok(heard.some((m: any) => m.type === "mod") && !heard.some((m: any) => m.type === "error" || /global-/.test(String(m.error ?? m.text ?? ""))) && fs.readFileSync(path.join(W, ".bans.json"), "utf8") === before && ["global-ban", "global-unban", "global-bans"].every((t) => !Object.hasOwn(MESSAGES, t)),
    "A12c global-ban / global-unban / global-bans are unknown types: no handler, no answer, the ban file untouched (server-bans after them is the one reply)",
    { heard: heard.map((m: any) => m.type + ":" + String(m.error ?? m.text).slice(0, 60)) });
  fen.close(); row.close(); try { s3.proc.kill(); await s3.proc.exited; } catch {} }
// ---- A13 (security review 10-18 H2): the client's address, from a trusted proxy only (pure) ----
{ const { clientAddress } = await import("../../server/peer.ts");
  const hdr = (h) => ({ headers: { get: (k) => h[k.toLowerCase()] ?? null } });
  const trusted = new Set(["127.0.0.1", "10.0.0.9"]);
  const fromProxy = clientAddress(hdr({ "x-real-ip": "203.0.113.7" }), "127.0.0.1", trusted), fromProxy2 = clientAddress(hdr({ "x-forwarded-for": "203.0.113.8, 10.0.0.9" }), "10.0.0.9", trusted, "x-forwarded-for");
  const direct = clientAddress(hdr({ "x-real-ip": "203.0.113.7" }), "198.51.100.4", trusted), framed = clientAddress(hdr({ "x-forwarded-for": "203.0.113.8" }), "198.51.100.4", trusted);
  const bare = clientAddress(hdr({}), "198.51.100.4", trusted), none = clientAddress(hdr({ "x-real-ip": "1.2.3.4" }), null, trusted);
  ok(fromProxy === "203.0.113.7" && fromProxy2 === "203.0.113.8" && direct === "198.51.100.4" && framed === "198.51.100.4" && bare === "198.51.100.4" && none === "?",
    "A13 X-Real-IP / X-Forwarded-For are honoured only from a trusted proxy (loopback or TRUSTED_PROXIES); from any other peer the socket address stands, so a direct guest can neither pick nor frame an address", { fromProxy, fromProxy2, direct, framed, bare, none });
  // review of #260: the proxy writes the address into ONE header, and the other arrives as the client sent it
  const xff = (h, p) => clientAddress(hdr(h), p, trusted, "x-forwarded-for");
  const forged = xff({ "x-forwarded-for": "198.51.100.66, 203.0.113.8" }, "10.0.0.9");
  const chained = xff({ "x-forwarded-for": "198.51.100.66, 203.0.113.8, 127.0.0.1" }, "10.0.0.9");
  const realThrough = xff({ "x-real-ip": "198.51.100.66", "x-forwarded-for": "203.0.113.8" }, "10.0.0.9");
  const xffThrough = clientAddress(hdr({ "x-forwarded-for": "198.51.100.66" }), "127.0.0.1", trusted, "x-real-ip");
  ok(forged === "203.0.113.8" && chained === "203.0.113.8" && realThrough === "203.0.113.8" && xffThrough === "127.0.0.1",
    "A13b only the header the proxy writes is read: behind an X-Forwarded-For proxy, a client's own X-Real-IP or left-hand hop is never taken; behind an X-Real-IP proxy, a client's X-Forwarded-For isn't either", { forged, chained, realThrough, xffThrough }); }
// ---- A13e (house 6340433633): PROXY_ADDRESS_HEADER itself picks the header the routes read: the rows above name the header
// as an argument, so nothing went through the setting. addressOf (what routes.ts and upload.ts call) in a fresh process per value
{ const peerTs = new URL("../../server/peer.ts", import.meta.url).href;   // a file URL: a pathname is "/D:/…" on Windows
  const probe = (env) => { const code = `const { addressOf } = await import(${JSON.stringify(peerTs)});
    const req = new Request("http://x/", { headers: { "x-real-ip": "203.0.113.7", "x-forwarded-for": "198.51.100.66, 203.0.113.8" } });
    console.log(addressOf(req, { requestIP: () => ({ address: "127.0.0.1" }) }));`;
    const { PROXY_ADDRESS_HEADER: _drop, ...base } = process.env;
    const r = Bun.spawnSync(["bun", "-e", code], { env: { ...base, ...env }, stdout: "pipe", stderr: "pipe" }); return r.stdout.toString().trim() || r.stderr.toString().trim().slice(0, 200); };
  const unset = probe({}), xff = probe({ PROXY_ADDRESS_HEADER: "X-Forwarded-For" }), real = probe({ PROXY_ADDRESS_HEADER: "x-real-ip" });
  ok(unset === "203.0.113.7" && xff === "203.0.113.8" && real === "203.0.113.7",
    "A13e the setting picks the header the routes read: unset or x-real-ip reads X-Real-IP, X-Forwarded-For (any case) reads its rightmost untrusted hop", { unset, xff, real }); }
// ---- A13m: a damaged ban or sanction file is kept as it was: a later ban or mute never saves over it ----
{ const modTs = new URL("../../server/moderation.ts", import.meta.url).href, D = fs.mkdtempSync(path.join(scratch("a13m"), "w-"));
  const bans = path.join(D, ".bans.json"), sanc = path.join(D, ".addr-sanctions.json"), torn = '{"acct:u-aaaaaaaaaaaaaaaaaaaa": {"by": "op", "ts": 1, "acc';
  fs.writeFileSync(bans, torn); fs.writeFileSync(sanc, torn);
  const code = `const M = await import(${JSON.stringify(modTs)});
    M.serverBans["acct:u-bbbbbbbbbbbbbbbbbbbb"] = { by: "op", ts: 2, account: "u-bbbbbbbbbbbbbbbbbbbb" }; M.saveServerBans();
    M.fileAddrSanction({ kind: "mute", world: "w", addr: "h", actor: "u-cccccccccccccccccccc", by: "op", who: "g-1" });`;
  const r = Bun.spawnSync(["bun", "-e", code], { env: { ...process.env, WORLDS_DIR: D, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" }, stdout: "pipe", stderr: "pipe" });
  const out = r.stdout.toString() + r.stderr.toString(), b = fs.readFileSync(bans, "utf8"), s = fs.readFileSync(sanc, "utf8");
  ok(r.exitCode === 0 && /restore failed/.test(out) && b === torn && s === torn && /not saved/.test(out),
    "A13m an unreadable .bans.json and .addr-sanctions.json are kept byte-identical: a later ban and mute are not saved over them, and the log says so", { exit: r.exitCode, bansKept: b === torn, sancKept: s === torn, out: out.slice(0, 400) });
  // A13m2: a file that parses but isn't an object of records (hand-made) is unreadable the same way: LOCKED, never saved over
  fs.writeFileSync(bans, "[]"); fs.writeFileSync(sanc, "false");
  const r2 = Bun.spawnSync(["bun", "-e", code + `\nconsole.log(M.lockedLine() ?? "not locked");`], { env: { ...process.env, WORLDS_DIR: D, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" }, stdout: "pipe", stderr: "pipe" });
  const out2 = r2.stdout.toString() + r2.stderr.toString();
  ok(r2.exitCode === 0 && /^LOCKED/m.test(out2) && fs.readFileSync(bans, "utf8") === "[]" && fs.readFileSync(sanc, "utf8") === "false",
    "A13m2 a ban or sanction file of the wrong shape (an array, a boolean) locks the door like a torn one and is kept as it was", { exit: r2.exitCode, out: out2.slice(0, 400) }); }
// ---- A13c (review of #260): a server ban made before accounts, on an aid1 agent's bare sub, still holds (pure) ----
{ const { restoreBans, findBan } = await import("../../server/moderation.ts");
  const was = { "old-agent": { by: "op", ts: 1, sub: "agent-7f3a" }, "old-person": { by: "op", ts: 1, sub: "discord|123" }, "namesake": { by: "op", ts: 1, name: "bob" } };
  const R = restoreBans ? restoreBans(was) : Object.fromEntries(Object.entries(was).filter(([, b]) => b.sub).map(([k, b]) => [k, { ...b, account: b.sub }]));
  const agent = findBan(R, "aid1:https://id.example.org:agent-7f3a"), person = findBan(R, "discord|123");
  const other = findBan(R, "aid1:https://id.example.org:agent-7f3a-2"), human = findBan(R, "human:agent-7f3a");
  ok(!!agent && !!person && !other && !human && !R.namesake, "A13c a ban from before accounts holds against the aid1 agent whose sub it named and the person whose account is that sub, and against no one else", { agent: !!agent, person: !!person, other: !!other, human: !!human, keys: Object.keys(R) });
  // …and an unban by the account it holds against lifts it: the same rule the door checks
  const { bansLiftedBy } = await import("../../server/moderation.ts");
  const fold = (s) => s.toLowerCase();
  const byAgent = bansLiftedBy(R, "aid1:https://id.example.org:agent-7f3a", ["aid1:https://id.example.org:agent-7f3a"], fold);
  const byOther = bansLiftedBy(R, "aid1:https://id.example.org:agent-7f3a-2", ["aid1:https://id.example.org:agent-7f3a-2"], fold);
  ok(byAgent.length === 1 && byAgent[0] === "old-agent" && byOther.length === 0,
    "A13c …and an unban by the aid1 account it holds against lifts it, while an unban by another account lifts nothing", { byAgent, byOther }); }
// ---- A13c (door): the operator's global unban, as the door runs it, lifts a ban from before accounts by the aid1 account
// it holds against, and by a name that account wears here; a third ban stays ----
// ---- D12 (door, review of #260, server I14): a spectator's first sight under a 64-character name another account wears
// is recorded as that name cut to keep a tag from its own account, never as the other account's name ----
{ fs.writeFileSync(path.join(W, ".bans.json"), JSON.stringify({ "old-a": { by: "op", ts: 1, sub: "agent-7f3a" }, "old-b": { by: "op", ts: 1, sub: "agent-9c1d" }, "old-c": { by: "op", ts: 1, sub: "agent-5e2b" } }));
  const { directoryFor } = await import("../../server/directory.ts");
  directoryFor(W).resolve({ sub: "aid1:https://id.example.org:agent-9c1d", name: "Nine" });
  ok(tool(["found", "d12", "--owner", "Ann"]).code === 0, "(D12 setup) found d12");
  const s = await start({ SERVER_OPERATORS: "agent:token:fen" });
  const op = await sock(s.port); const jo = await op.join("keep", "Fen", { agentToken: "tok-fen" });
  const k = op.msgs.length; op.raw({ type: "server-unban", id: "aid1:https://id.example.org:agent-7f3a" }); op.raw({ type: "server-unban", id: "Nine" });
  await tryUntil("the operator hears back on both server unbans", () => op.msgs.length >= k + 2, { ms: 3000, step: 50 });
  const left = Object.keys(JSON.parse(fs.readFileSync(path.join(W, ".bans.json"), "utf8")));
  ok(!!jo.snapshot && left.length === 1 && left[0] === "old-c",
    "A13c (door) the global unban lifts a ban from before accounts by the aid1 account it holds against, and by a name that account wears here; another stays",
    { join: jo.errors, left, said: op.msgs.slice(k).map((m) => m.text ?? m.error) });
  const LONG = "L".repeat(64);
  const body = await sock(s.port); const jb = await body.join("d12", LONG);   // its account, local:l…l, wears the long name
  const watch = await sock(s.port); const jw = await watch.join("d12", LONG, { spectate: true, account: "watcher" });   // local:watcher
  const nameOf = (sub) => { try { return Object.values(JSON.parse(fs.readFileSync(path.join(W, ".directory.json"), "utf8")).ids ?? {}).find((e) => (e.subs ?? []).includes(sub))?.name; } catch { return undefined; } };
  await tryUntil("the spectator's directory record is written", () => nameOf("local:watcher") !== undefined, { ms: 5000, step: 50 });   // the spectator's record is written
  const theirs = nameOf(`local:${LONG.toLowerCase()}`), seen = nameOf("local:watcher") ?? "";
  ok(!!jb.snapshot && !!jw.snapshot && theirs === LONG && seen.length <= 64 && seen.endsWith(`-${(await import("../../server/directory.ts")).accountTag("local:watcher")}`) && seen.toLowerCase() !== LONG.toLowerCase(),
    "D12 (door) a spectator's first sight under a 64-character name another account wears records that name cut to keep its own account's tag (accountTag), within the limit, never the other account's name",
    { joins: [jb.errors, jw.errors], snapshots: [!!jb.snapshot, !!jw.snapshot], theirs, seen });
  body.close(); watch.close(); op.close(); try { s.proc.kill(); await s.proc.exited; } catch {} fs.rmSync(path.join(W, ".bans.json"), { force: true }); }
// ---- A13d (review of #260, server I5): two worlds opening the same keys file keep each other's keys ----
{ const { custodyAt } = await import("../../server/custody.ts");
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "custody-")), "keys", "custody.json");
  const one = custodyAt(f), two = custodyAt(f);   // as livehost does, once per world, before either has minted
  const a = one.keyOf("u-aaaaaaaaaaaaaaaaaaaa", true), b = two.keyOf("u-bbbbbbbbbbbbbbbbbbbb", true), s1 = one.sequencer(), s2 = two.sequencer();
  const disk = JSON.parse(fs.readFileSync(f, "utf8"));
  ok(disk.holders?.["u-aaaaaaaaaaaaaaaaaaaa"]?.pub === a && disk.holders?.["u-bbbbbbbbbbbbbbbbbbbb"]?.pub === b && s1 === s2 && disk.sequencer?.pub === s1,
    "A13d two handles on one keys file: both holders' keys are on disk and both sign with the one sequencer key", { a, b, s1, s2, holders: Object.keys(disk.holders ?? {}), seq: disk.sequencer?.pub });
  // …and a key another process wrote behind an open handle is taken, never minted over (the CLI founds while the server runs)
  const g = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "custody-")), "keys", "custody.json");
  const h = custodyAt(g); fs.mkdirSync(path.dirname(g), { recursive: true });
  const other = { pub: "ed25519:written-by-another-process", priv: "" };
  fs.writeFileSync(g, JSON.stringify({ holders: { "u-cccccccccccccccccccc": other }, operator: other }));
  const op = h.operator(), held = h.keyOf("u-cccccccccccccccccccc", true), after = JSON.parse(fs.readFileSync(g, "utf8"));
  ok(op === other.pub && held === other.pub && after.operator?.pub === other.pub && after.holders?.["u-cccccccccccccccccccc"]?.pub === other.pub,
    "A13d …a key another process wrote after the handle opened is taken, not minted over", { op, held, after }); }
// ---- A13f–A13h (review of #260, server I5): custody's lock. A lock file is "<pid> <nonce>", linked into place whole
// (server/custody.ts take); this process holds one the same way, so the children meet a lock held by a live process ----
const custodyTs = path.join(ENGINE, "server/custody.ts");
const lockText = (pid) => { const nonce = crypto.randomBytes(8).toString("hex"); return { nonce, text: `${pid} ${nonce}` }; };
// take `name` as custody does (fails if it's there), or put a new lock in its place in one step (rename over it)
const holdLock = (name, pid = process.pid) => { const { nonce, text } = lockText(pid), t = `${name}.${nonce}.held`;
  fs.writeFileSync(t, text); try { fs.linkSync(t, name); } finally { fs.rmSync(t); } return nonce; };
const replaceLock = (name, pid = process.pid) => { const { nonce, text } = lockText(pid), t = `${name}.${nonce}.held`;
  fs.writeFileSync(t, text); fs.renameSync(t, name); return nonce; };
const exitedPid = async () => { const p = Bun.spawn(["bun", "-e", ""]); await p.exited; return p.pid; };
// A child that opens its handle, marks `ready`, waits for `go` (sleeping, not spinning), mints `each` holder keys and the
// sequencer key, and prints what it got, any error a mint threw, and how long its mints took by its own clock. Its fs is
// watched from inside, so it leaves its own signs of where custody's lock has it: `met-lock` the first time the lock is
// held, a dot in `tries` each time, `met-right` the first time another holds the right to remove a lock, and `holds-right`
// once it holds one itself (with `pause`, it then waits for `resume` before going on).
const minter = (dir, f, go, i, each, { pause = false, waitMs = 0 } = {}) => Bun.spawn(["bun", "-e", `const fs = (await import("node:fs")).default;
  const lock = ${JSON.stringify(`${f}.lock`)}, at = (n) => ${JSON.stringify(dir)} + "/" + n + "-${i}", seen = new Set();
  const mark = (n) => { if (!seen.has(n)) { seen.add(n); fs.writeFileSync(at(n), ""); } };
  const nap = new Int32Array(new SharedArrayBuffer(4)), until = (p) => { while (!fs.existsSync(p)) Atomics.wait(nap, 0, 0, 5); };
  const link = fs.linkSync; fs.linkSync = function (a, b) {
    const right = String(b).startsWith(lock + ".");
    try { const r = link.call(fs, a, b); if (right && !seen.has("holds-right")) { mark("holds-right"); if (${pause}) until(at("resume")); } return r; }
    catch (e) { if (e?.code === "EEXIST") { if (String(b) === lock) { mark("met-lock"); fs.appendFileSync(at("tries"), "."); } else if (right) mark("met-right"); } throw e; } };
  const { custodyAt } = await import(${JSON.stringify(custodyTs)});
  const h = custodyAt(${JSON.stringify(f)}); mark("ready"); until(${JSON.stringify(go)});
  const out = {}, t0 = performance.now();
  try { for (let j = 0; j < ${each}; j++) out["u-p${i}-" + j] = h.keyOf("u-p${i}-" + j, true); out.sequencer = h.sequencer(); }
  catch (e) { out.error = String(e.message ?? e); } out.ms = Math.round(performance.now() - t0); console.log(JSON.stringify(out));`], { cwd: ENGINE, stdout: "pipe", stderr: "pipe", env: { ...process.env, ...(waitMs ? { EIDO_CUSTODY_LOCK_WAIT_MS: String(waitMs) } : {}) } });
// what a child printed, and how it exited: a child that crashed says so rather than printing nothing that compares equal
const resultOf = async (k) => { const code = await k.exited, out = await new Response(k.stdout).text();
  try { return { ...JSON.parse(out), code }; } catch { return { crashed: true, code, stderr: (await new Response(k.stderr).text()).slice(-400) }; } };
const marks = (dir, n) => fs.readdirSync(dir).filter((x) => x.startsWith(`${n}-`)).length;
const triesOf = (dir, i) => { try { return fs.readFileSync(path.join(dir, `tries-${i}`), "utf8").length; } catch { return 0; } };
const keysIn = (f) => fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : {};
const textOf = (f) => { try { return fs.readFileSync(f, "utf8"); } catch { return ""; } };   // a lock may be gone: that's a verdict, not a crash
const besideKeys = (f) => fs.readdirSync(path.dirname(f)).filter((n) => n !== path.basename(f));
const scratchKeys = () => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), "custody-")), f = path.join(dir, "keys", "custody.json");
  fs.mkdirSync(path.dirname(f), { recursive: true }); return { dir, f, lock: `${f}.lock`, go: path.join(dir, "go") }; };
// A13g's child starts first, since it waits out the lock: one this process holds the whole time
const T = scratchKeys(); holdLock(T.lock); fs.writeFileSync(T.go, "");
const tKid = minter(T.dir, T.f, T.go, 0, 1), timedOut = resultOf(tKid);
// ---- A13h: while a live process holds the lock no one mints; released, six processes minting into one keys file at once keep every key ----
{ const { dir, f, lock, go } = scratchKeys(), N = 6, EACH = 8; holdLock(lock);
  const kids = Array.from({ length: N }, (_, i) => minter(dir, f, go, i, EACH, { waitMs: 120_000 }));   // held until all six start: slower than 10 s on a slow runner (Windows CI 41003901034)
  const ready = !!(await tryUntil("every minter has its handle open", () => marks(dir, "ready") === N, { ms: 60_000, step: 50 })); fs.writeFileSync(go, "");
  const met = !!(await tryUntil("every minter meets the held lock", () => marks(dir, "met-lock") === N, { ms: 60_000, step: 50 }));   // each child's own sign: it met the held lock
  const during = Object.keys(keysIn(f).holders ?? {}).length, waiting = kids.every((k) => k.exitCode === null);
  fs.rmSync(lock, { force: true });   // released: the six take it in turn, from the same instant
  const minted = await Promise.all(kids.map(resultOf)), disk = keysIn(f);
  const lost = minted.flatMap((m) => Object.entries(m).filter(([who]) => who.startsWith("u-")).filter(([who, pub]) => disk.holders?.[who]?.pub !== pub).map(([who]) => who));
  const seqs = new Set(minted.map((m) => m.sequencer)), left = besideKeys(f);
  ok(ready && met && during === 0 && waiting && minted.every((m) => m.code === 0 && !m.error && Object.keys(m).filter((k) => k.startsWith("u-")).length === EACH && typeof m.sequencer === "string")
    && lost.length === 0 && seqs.size === 1 && disk.sequencer?.pub === [...seqs][0] && !left.length,
    "A13h six minters each meet the custody lock a live process holds, and none mints while it's held; released, they mint into one keys file at once, every holder key each minted is on disk, they sign with one sequencer key, and nothing is left beside the file",
    { ready, met, during, waiting, results: minted.map((m) => m.error ?? (m.crashed ? `crashed ${m.code}` : "ok")), lost: lost.length, of: N * EACH, seqs: seqs.size, left }); }
// ---- A13f: a lock whose holder exited is removed only by whoever holds the right to remove it (`<lock>.<its nonce>`), and
// only while the lock is still that one ----
const gonePid = await exitedPid();
// while another (live) holds the right, the waiter leaves the stale lock; once that other has put a live lock in its place
// (one step) and given the right back, the waiter leaves the live lock too, and mints when it's released
{ const { dir, f, lock, go } = scratchKeys(); const stale = holdLock(lock, gonePid); holdLock(`${lock}.${stale}`);
  fs.writeFileSync(go, ""); const kid = minter(dir, f, go, 0, 1);
  const metRight = !!(await tryUntil("the waiter finds the removal right held", () => marks(dir, "met-right") === 1, { ms: 60_000, step: 50 }));   // its own sign: it found the right held
  const kept = textOf(lock).endsWith(stale), waited = kid.exitCode === null;
  const mine = replaceLock(lock); fs.rmSync(`${lock}.${stale}`); const n0 = triesOf(dir, 0);
  const tried = !!(await tryUntil("the waiter meets the live lock three more times", () => triesOf(dir, 0) >= n0 + 3, { ms: 60_000, step: 50 }));   // …and has met the live lock three times since
  const live = textOf(lock).endsWith(mine), stillWaiting = kid.exitCode === null;
  fs.rmSync(lock, { force: true }); const got = await resultOf(kid);
  ok(metRight && kept && waited && tried && live && stillWaiting && got.code === 0 && !got.error && typeof got["u-p0-0"] === "string" && keysIn(f).holders?.["u-p0-0"]?.pub === got["u-p0-0"] && !besideKeys(f).length,
    "A13f a waiter leaves a stale lock while another holds the right to remove it, then leaves the live lock put in its place, and mints once that's released; nothing is left beside the file",
    { metRight, kept, waited, tried, live, stillWaiting, got, left: besideKeys(f) }); }
// the waiter holds the right, and the stale lock is replaced before it removes it: the nonce it rechecks stops the removal
{ const { dir, f, lock, go } = scratchKeys(); const stale = holdLock(lock, gonePid);
  fs.writeFileSync(go, ""); const kid = minter(dir, f, go, 0, 1, { pause: true });
  const holds = !!(await tryUntil("the waiter holds the right to remove the stale lock", () => marks(dir, "holds-right") === 1, { ms: 60_000, step: 50 }));   // it holds the right to remove the stale lock, paused
  const mine = replaceLock(lock); const n0 = triesOf(dir, 0); fs.writeFileSync(path.join(dir, "resume-0"), "");
  const tried = !!(await tryUntil("the waiter meets the live lock three more times", () => triesOf(dir, 0) >= n0 + 3, { ms: 60_000, step: 50 }));
  const live = textOf(lock).endsWith(mine), rightGone = !fs.existsSync(`${lock}.${stale}`), stillWaiting = kid.exitCode === null;
  fs.rmSync(lock, { force: true }); const got = await resultOf(kid);
  ok(holds && tried && live && rightGone && stillWaiting && got.code === 0 && !got.error && typeof got["u-p0-0"] === "string" && keysIn(f).holders?.["u-p0-0"]?.pub === got["u-p0-0"] && !besideKeys(f).length,
    "A13f a waiter holding the right to remove a stale lock that has since been replaced leaves the live lock (the nonce differs), gives the right back, and mints once it's released",
    { holds, tried, live, rightGone, stillWaiting, got, left: besideKeys(f) }); }
// a stale lock whose removal right was left by a process that exited too, and a stale lock alone: a mint clears each without
// waiting out the lock's 10 s, and leaves nothing beside the file
{ const { custodyAt } = await import(custodyTs);
  const mint = (f) => { const t0 = Date.now(); try { return { key: custodyAt(f).keyOf("u-again", true), ms: Date.now() - t0 }; } catch (e) { return { error: String(e?.message ?? e), ms: Date.now() - t0 }; } };
  const A = scratchKeys(); const stale = holdLock(A.lock, gonePid); holdLock(`${A.lock}.${stale}`, gonePid); const a = mint(A.f);
  const B = scratchKeys(); holdLock(B.lock, gonePid); const b = mint(B.f);
  const good = (r, X) => !r.error && typeof r.key === "string" && keysIn(X.f).holders?.["u-again"]?.pub === r.key && r.ms < 9_000 && !besideKeys(X.f).length;
  ok(good(a, A), "A13f a stale lock whose removal right was left by a process that exited too is cleared, right first, without the 10 s wait", { ...a, left: besideKeys(A.f) });
  ok(good(b, B), "A13f a stale lock alone is taken over without the 10 s wait", { ...b, left: besideKeys(B.f) });
  // a mint holds the lock only inside one call, so a lock naming this process was left by an earlier one with its pid
  const C = scratchKeys(); holdLock(C.lock, process.pid); const c = mint(C.f);
  ok(good(c, C), "A13f a lock naming this process, which none of its calls holds (a restart got its old pid back), is taken over without the 10 s wait", { ...c, left: besideKeys(C.f) }); }
// ---- A13g: …the refusal that ends the wait: after its 10 s by the child's own clock, naming the lock and its holder ----
{ const met = !!(await tryUntil("A13g's child meets the held lock", () => marks(T.dir, "met-lock") === 1, { ms: 60_000, step: 50 })), metAt = met ? fs.statSync(path.join(T.dir, "met-lock-0")).mtimeMs : Date.now();
  const got = await Promise.race([timedOut, sleep(Math.max(0, metAt + 30_000 - Date.now())).then(() => ({ hung: true }))]);
  if (got.hung) tKid.kill();
  ok(met && typeof got.error === "string" && got.error.includes(T.lock) && got.error.includes(`by process ${process.pid}`) && /held .* for 10 s/.test(got.error) && got.ms >= 9_500 && !keysIn(T.f).holders,
    "A13g a mint that waits on a lock a live process holds gives up after its 10 s, naming the lock and its holder, and mints nothing", { met, got });
  fs.rmSync(T.lock, { force: true }); }
{ // A9 (final review M1): an invite-only door is not opened by default-role / role-defs powers handed to everyone
  const { entryFor } = await import(path.join(ENGINE, "server/access.ts"));
  const { effectiveOf } = await import(path.join(ENGINE, "shared/protocol/roles.js"));
  // an owner, or roleIdOf caps everyone at member; the stranger holds the default role, member
  const base = { access: { join: "listed" }, "roles:u-owner000000000000000000": { role: "owner" } };
  const cases = [
    ["default-role {can:{kick}}", { ...base, "default-role": { role: "member", can: { kick: true } } }],
    ["default-role {role: moderator}", { ...base, "default-role": { role: "moderator" } }],
    ["role-defs.member.can.mute (visitor's new name)", { ...base, "default-role": { role: "member" }, "role-defs": { member: { can: { mute: true } } } }],
  ];
  const powers = cases.map(([n, wc]) => [n, effectiveOf(wc, "u-stranger00000000000000").permissions.filter((p) => ["kick", "mute", "ban"].includes(p))]);
  ok(powers.every(([, p]) => p.length), "A9 (setup) each row really hands the stranger a moderation power", powers);
  const got = cases.map(([n, wc]) => [n, entryFor({ name: "m1", wc, label: "members" }, { account: "acct-stranger", actorId: "u-stranger00000000000000", addr: "1.2.3.4" }, "embody")?.code ?? "admitted"]);
  ok(got.every(([, c]) => c !== "admitted"), "A9 a stranger in an invite-only world stays out even when the default role (or a role-def) carries a moderation power", got);
  const mem = { ...cases[1][1], "roles:u-member0000000000000000": { role: "moderator" } };
  const m = entryFor({ name: "m1", wc: mem, label: "members" }, { account: "acct-m", actorId: "u-member0000000000000000", addr: "1.2.3.5" }, "embody");
  ok(m === null, "A9 a LISTED moderator still gets in", m);
}
// ---- A15–A17 (docs/DESIGN-world-access.md, "Review (independent, 2026-10-17)"): the three bypasses that review reproduced,
// once tools/access-test.ts §5b, on this protocol. A world of their own (door) and an open one (yard), on a fresh server.
{ ok(tool(["found", "door", "--owner", "Ann"]).code === 0 && tool(["found", "yard", "--owner", "Ann"]).code === 0, "(A15 setup) found door and yard, Ann owns both");
  const s4 = await start();
  const ann = await sock(s4.port); const ja = await ann.join("door", "Ann");
  const who: Record<string, string> = {};
  for (const [name, tok] of [["Rowan", "tok-rowan"], ["Moss", "tok-moss"], ["Wren", "tok-wren"], ["Fen", "tok-fen"]] as const) {
    const s = await sock(s4.port); const j = await s.join("door", name, { agentToken: tok }); who[name] = you(j); s.close(); }
  { const s = await sock(s4.port); const j = await s.join("door", "Pip"); who.Pip = you(j); s.close(); }   // a typed-name account here (TRUST_NAMES)
  await sleep(150);
  const set = [["Pip", "member"], ["Rowan", "member"], ["Wren", "member"], ["Fen", "owner"]];
  const listed = [];
  for (const [w, role] of set) listed.push((await ann.req("set", { id: "@world", component: `roles:${who[w]}`, value: { role } })).ok);
  const closed = await ann.req("set", { id: "@world", component: "access", value: { join: "listed" } });
  ok(ja.snapshot?.yourRights?.role === "owner" && new Set(Object.values(who)).size === 5 && listed.every(Boolean) && closed.ok,
    "(A15 setup) door: Ann owns it; Pip, Rowan and Wren are visitors, Fen a co-owner, and only the listed come in", { who, listed, closed: closed.refused });
  // A15: what a join proves is this join's own credential; a re-join on the same socket carries nothing over. Moss (enrolled,
  // not listed) joins yard with his token, then re-joins door on that socket as a listed member
  const x = await sock(s4.port); const jx = await x.join("yard", "Moss", { agentToken: "tok-moss" });
  const asRowan = await x.join("door", "Rowan");
  const y = await sock(s4.port); await y.join("yard", "Moss", { agentToken: "tok-moss" }); const ownTok = await y.join("door", "Rowan", { agentToken: "tok-moss" });
  const v = await sock(s4.port); await v.join("yard", "Moss", { agentToken: "tok-moss" }); const asPip = await v.join("door", "Pip");
  const q = await sock(s4.port); await q.join("yard", "Moss", { agentToken: "tok-moss" }); const asQ = await q.join("yard", "Quentin");
  const fresh = await sock(s4.port); const jq = await fresh.join("yard", "Quentin");
  ok(you(jx) === who.Moss && !asRowan.snapshot && x.closed != null && !ownTok.snapshot && y.closed === 4005 && !asPip.snapshot && /already joined as someone else/.test(asPip.errors.join(" "))
    && !asQ.snapshot && /already joined as someone else/.test(asQ.errors.join(" ")) && !!jq.snapshot && you(jq) !== who.Moss,
    "A15 a credentialed socket's re-join carries nothing over: as a member's typed name it is refused (the reserved name, or 'already joined as someone else' for Pip); with its own token it is still Moss, refused as a stranger (world-unavailable); and it files no identity under a name it types (a fresh Quentin isn't Moss)",
    { asRowan: [asRowan.errors, x.closed], ownTok: [ownTok.errors, y.closed, you(ownTok)], asPip: [asPip.errors, v.closed, you(asPip)], asQ: [asQ.errors, q.closed], fresh: you(jq) });
  [x, y, v, q, fresh].forEach((s) => s.close());
  // A16: a role is keyed by the actor's opaque id, so no request under a name reaches another record. A role under the bare
  // name 'fen' is refused and its delete finds nothing; deleting Wren's role touches Wren's only: co-owner Fen still enters as
  // owner, and door stays closed
  const byName = await ann.req("set", { id: "@world", component: "roles:fen", value: { role: "builder" } });
  const delName = await ann.req("delete", { id: "@world", component: "roles:fen" });
  const delWren = await ann.req("delete", { id: "@world", component: `roles:${who.Wren}` });
  const f = await sock(s4.port); const jf = await f.join("door", "Fen", { agentToken: "tok-fen" });
  const wren = await accessAs(s4.port, "door", "tok-wren"), stranger = await accessAs(s4.port, "door", "tok-ivy"), anonMap = (await worldsAs(s4.port)).some((w) => w.name === "door");
  ok(!byName.ok && byName.refused?.code === "shape" && !delName.ok && delWren.ok && jf.snapshot?.yourRights?.role === "owner" && wren.body?.code === "world-unavailable" && stranger.body?.code === "world-unavailable" && !anonMap,
    "A16 a revoke touches only its own record: a role under a bare name is refused and its delete finds nothing; deleting Wren's role leaves co-owner Fen an owner, and the door stays closed",
    { byName: byName.refused, delName: delName.refused, delWren: delWren.refused, fen: [jf.errors, jf.snapshot?.yourRights?.role], wren: wren.body, stranger: stranger.body, anonMap });
  f.close();
  // A17: a revoke takes effect: Rowan is present; deleting roles:<Rowan> is accepted, removes him now (4010), /access says
  // none, his rejoin is refused, and the log holds the delete
  const r = await sock(s4.port); const jr = await r.join("door", "Rowan", { agentToken: "tok-rowan" });
  const del = await ann.req("delete", { id: "@world", component: `roles:${who.Rowan}` });
  const out = !!(await tryUntil("Rowan is removed by the revoke", () => r.closed != null, { ms: 4000, step: 50 }));
  const acc = await accessAs(s4.port, "door", "tok-rowan");
  const back = await sock(s4.port); const jb = await back.join("door", "Rowan", { agentToken: "tok-rowan" });
  const logged = fs.readFileSync(path.join(W, "door", "world.jsonl"), "utf8").split("\n").filter(Boolean)
    .some((l) => l.includes(`roles:${who.Rowan}`) && l.includes('"delete"'));
  ok(!!jr.snapshot && del.ok && out && r.closed === 4010 && acc.body?.code === "world-unavailable" && !jb.snapshot && back.closed === 4005 && logged,
    "A17 a revoke takes effect: deleting a present member's role is accepted, removes them now (4010), /access and the rejoin answer world-unavailable, and the log holds the delete",
    { joined: !!jr.snapshot, del: del.refused, closed: r.closed, acc: acc.body, back: [jb.errors, back.closed], logged });
  r.close(); back.close(); ann.close(); try { s4.proc.kill(); await s4.proc.exited; } catch {} }
// ---- B5, B12, B16 (anima-review[bot] on #260, 11-02): a server with a door key and an aid1 issuer; yard (A15's) is open ----
//   B5  a guest's address ban holds at the reads: from the banned address /geom, /heightmap and /worlds answer as for no world
//   B12 a person's aid1 token is no Bearer for the reads (it signs in at /auth); an agent's is
//   B16 /library-list stays inside its directories: a sibling sharing the opt directory's name as a prefix lists nothing
{ const pair = crypto.generateKeyPairSync("ed25519"), spki = pair.publicKey.export({ type: "spki", format: "der" });
  const ISSUER = `ed25519:${spki.subarray(spki.length - 32).toString("base64url")}`;
  const mint = (over) => { const now = Math.floor(Date.now() / 1000);
    const seg = Buffer.from(JSON.stringify({ v: 1, iss: "id.test", sub: "agent:quill@home.test", kind: "agent", name: "Quill", aud: "eidoverse", scopes: ["worlds:join"], iat: now, exp: now + 600, jti: crypto.randomUUID(), ...over })).toString("base64url");
    return `aid1.${seg}.${crypto.sign(null, Buffer.from(`aid1.${seg}`), pair.privateKey).toString("base64url")}`; };
  const hashed = (ip) => crypto.createHash("sha256").update(`eidoverse-addr:${ip}`).digest("hex").slice(0, 24);
  fs.writeFileSync(path.join(W, ".bans.json"), JSON.stringify({ [`addr:${hashed("203.0.113.9")}`]: { by: "op", ts: Date.now(), addr: hashed("203.0.113.9"), until: Date.now() + 3600_000, reason: "B5" } }));
  const OPT = path.join(root, "opt");
  fs.mkdirSync(path.join(OPT, "inner"), { recursive: true }); fs.writeFileSync(path.join(OPT, "inner", "a.txt"), "a");
  fs.mkdirSync(path.join(root, "opt-sib"), { recursive: true }); fs.writeFileSync(path.join(root, "opt-sib", "secret.txt"), "s");
  const s5 = await start({ JOIN_TOKEN: "jt-b", HN_ISSUER_KEY: ISSUER, HN_ISS: "id.test" });
  const get = (u, h = {}) => fetch(`http://127.0.0.1:${s5.port}${u}`, { headers: h });
  const as = (ip) => ({ authorization: "Bearer jt-b", "x-real-ip": ip });   // the server's peer is loopback: a trusted proxy, so X-Real-IP stands
  const st = async (u, h) => (await get(u, h)).status;
  const onMap = async (h) => ((await (await get("/worlds", h)).json()).worlds ?? []).some((w) => w.name === "yard");
  const banned = { geom: await st("/geom?world=yard", as("203.0.113.9")), hm: await (await get("/heightmap?world=yard&format=json", as("203.0.113.9"))).text(), map: await onMap(as("203.0.113.9")) };
  const other = { geom: await st("/geom?world=yard", as("203.0.113.10")), map: await onMap(as("203.0.113.10")) };
  ok(!s5.dead && banned.geom === 404 && /no such world/.test(banned.hm) && !banned.map && other.geom === 200 && other.map,
    "B5 a guest's address ban holds at the reads: from the banned address /geom answers 404, /heightmap 'no such world', and /worlds lacks the world; from another address the same key reads it", { banned, other });
  const human = mint({ kind: "human", sub: "human:test:hal", name: "Hal" }), agent = mint({});
  const byHuman = await st("/worlds", { authorization: `Bearer ${human}` }), byAgent = await st("/worlds", { authorization: `Bearer ${agent}` }), byNone = await st("/worlds");
  ok(byHuman === 401 && byAgent === 200 && byNone === 401, "B12 a person's aid1 token is no Bearer for the reads (401: it signs in at /auth); an agent's aid1 credential is (200); nothing is 401", { byHuman, byAgent, byNone });
  const lib = async (dir) => (await (await get(`/library-list?dir=${encodeURIComponent(dir)}`)).json()).map((f) => f.path);
  const inside = await lib("inner"), sibling = await lib("../opt-sib");
  ok(inside.includes("inner/a.txt") && sibling.length === 0, "B16 /library-list lists inside its directory and nothing from a sibling whose name shares its prefix (../opt-sib)", { inside, sibling });
  try { s5.proc.kill(); } catch {} fs.rmSync(path.join(W, ".bans.json"), { force: true }); }
// ---- B7, B14, B17 (anima-review[bot] on #260, 11-02; pure, in a process of their own with its own WORLDS_DIR) ----
//   B7  an unloaded world's door leaves out a torn last line (no newline), as the log's reader does
//   B14 a timed grant that has ended in a world that can't log the end (no custody) still removes its holder at the sweep
//   B17 a world is served in its own case only: on a case-insensitive filesystem "KEEP" is not "keep" (a second authority)
{ const P = fs.mkdtempSync(path.join(root, "pure-")), PW = path.join(P, "worlds");
  const line = (join) => JSON.stringify({ kind: "change", op: "set", body: { id: "@world", comp: "access", value: { join } } });
  // a world's genesis first: a directory with none is no saved world, and has no door (access.ts doorFor, F23 11-05)
  const GENESIS = JSON.stringify({ kind: "genesis", actor: "system", ts: 1, body: { dialect: "eidoverse-log", v: 4, nonce: "b7", owners: [[], []], sequencer: "ed25519:b7" } });
  fs.mkdirSync(path.join(PW, "torn"), { recursive: true }); fs.writeFileSync(path.join(PW, "torn", "world.jsonl"), `${GENESIS}\n${line("listed")}\n${line("anyone")}`);
  fs.mkdirSync(path.join(PW, "keep"), { recursive: true });
  const caseless = fs.existsSync(path.join(PW, "KEEP"));
  const code = `const A = await import(${JSON.stringify(new URL("../../server/access.ts", import.meta.url).href)});
    const Wd = await import(${JSON.stringify(new URL("../../server/world.ts", import.meta.url).href)});
    const now = Date.now(), out = { door: A.doorFor("torn")?.wc?.access?.join, sweep: {}, exists: { lower: Wd.worldExists("keep"), upper: Wd.worldExists("KEEP") } };
    for (const [k, until] of [["ended", now - 1000], ["live", now + 600_000]]) {
      const wc = { access: { join: "listed" }, "roles:u-fen0000000000000000000": { role: "member", until } };
      const c = { id: "Fen", actorId: "u-fen0000000000000000000", account: "agent:token:fen", surface: "world", ws: { send() {} } };
      const w = { name: "t14", clients: new Set([c]), log: { live: { state: () => ({ entities: { "@world": { c: wc } } }) }, expireRoles: () => [], bannedHere: () => false } };
      const gone = []; A.sweepAccess([w], (_w, who, why) => gone.push(why), now); out.sweep[k] = gone; }
    console.log(JSON.stringify(out));`;
  const r = Bun.spawnSync(["bun", "-e", code], { cwd: ENGINE, env: { ...process.env, WORLDS_DIR: PW, OPT_DIR: path.join(P, "opt"), SERVER_OPERATORS: "", JOIN_TOKEN: "" }, stdout: "pipe", stderr: "pipe" });
  let o = null; try { o = JSON.parse(r.stdout.toString().trim().split("\n").pop()); } catch {}
  ok(o?.door === "listed", "B7 an unloaded world's door leaves out a torn last line (complete JSON, no newline): still listed, not anyone", o?.door ?? r.stderr.toString().slice(-300));
  ok(o?.sweep?.ended?.length === 1 && /access/.test(o.sweep.ended[0]) && o?.sweep?.live?.length === 0,
    "B14 in a world that can't log a grant's end (expire-roles writes nothing), the sweep still removes whoever's timed grant has passed; a live grant stays", o?.sweep);
  if (caseless) ok(o?.exists?.lower === true && o?.exists?.upper === false, "B17 on a case-insensitive filesystem a world is served in its own case only: keep exists, KEEP does not", o?.exists);
  else console.log(`  skip B17: ${PW} is case-sensitive, so "KEEP" can't open keep/ here (run with PROTOCOL_SCRATCH on a case-insensitive filesystem)`); }
// ---- A13n (R 11-03 "b"): a ban or sanction file the server can't read LOCKS the door: the owner, an operator
// and a role holder still join; a stranger and an unlisted account are refused with the plain reason; the operator's list says LOCKED
{ const BJ = path.join(W, ".bans.json"), SJ = path.join(W, ".addr-sanctions.json"), torn = '{"acct:u-aaaaaaaaaaaaaaaaaaaa": {"by": "op", "ts": 1, "acc';
  ok(tool(["found", "lockt", "--owner", "Ann"]).code === 0, "(A13n setup) found lockt, Ann owns it, open to anyone");
  const LOCKED = /can't read its ban list right now/;
  const run = async (which) => {
    fs.rmSync(BJ, { force: true }); fs.rmSync(SJ, { force: true }); fs.writeFileSync(which === "bans" ? BJ : SJ, torn);
    const s = await start({ SERVER_OPERATORS: "agent:token:fen", RENDERER_TOKEN: "rend-key" });
    const ann = await sock(s.port); const ja = await ann.join("lockt", "Ann");
    const listed = ja.snapshot ? (await ann.req("set", { id: "@world", component: `roles:${ids.Rowan}`, value: { role: "member" } })).ok : false;
    const row = await sock(s.port); const jr = await row.join("lockt", "Rowan", { agentToken: "tok-rowan" });
    const fen = await sock(s.port); const jf = await fen.join("lockt", "Fen", { agentToken: "tok-fen" });
    const carl = await sock(s.port); const jc = await carl.join("lockt", "Carl");
    const moss = await sock(s.port); const jm = await moss.join("lockt", "Moss", { agentToken: "tok-moss" });
    const rend = await sock(s.port); const jrn = await rend.join("lockt", "renderer", { renderer: true, token: "rend-key" });
    const k = fen.msgs.length; fen.raw({ type: "server-bans" });
    await tryUntil("the operator's ban list answers", () => fen.msgs.length > k, { ms: 3000, step: 50 });
    const said = fen.msgs.slice(k).map((m) => m.text ?? m.error ?? "").join("\n");
    const boot = fs.readFileSync(s.log, "utf8");
    for (const c of [ann, row, fen, carl, moss, rend]) c.close();
    try { s.proc.kill(); await s.proc.exited; } catch {}
    return { owner: !!ja.snapshot, listed, roleHolder: !!jr.snapshot, operator: !!jf.snapshot, renderer: !!jrn.snapshot, stranger: { in: !!jc.snapshot, closed: carl.closed, why: jc.errors }, member: { in: !!jm.snapshot, closed: moss.closed, why: jm.errors },
      list: /LOCKED/.test(said), boot: /WARNING LOCKED/.test(boot) }; };
  const refused = (x) => !x.in && x.closed === 4010 && LOCKED.test(x.why.join(" "));
  const b = await run("bans");
  ok(b.owner && b.listed && b.roleHolder && b.operator && b.renderer && refused(b.stranger) && refused(b.member) && b.list && b.boot,
    "A13n an unreadable .bans.json locks the door: the owner, a role holder, an operator and the trusted renderer join; a guest and an unlisted account are refused (4010) with the plain reason; the boot log and server-bans say LOCKED", b);
  const a = await run("sanctions");
  ok(a.owner && a.roleHolder && a.operator && refused(a.stranger) && a.list, "A13n …and an unreadable .addr-sanctions.json alone locks it the same way", a);
  fs.rmSync(BJ, { force: true }); fs.rmSync(SJ, { force: true });
  const s = await start(); const carl = await sock(s.port); const jc = await carl.join("lockt", "Carl");
  ok(!!jc.snapshot, "A13n …and with both files readable (absent) the stranger joins the open world", jc.errors);
  carl.close(); try { s.proc.kill(); await s.proc.exited; } catch {} }
console.log(`[access-check] ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
