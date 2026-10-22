// tools/protocol/access-check.ts — WHO MAY COME IN, decided by the world (upstream #258/#259, ported to this protocol
// 2026-10-17: shared/protocol/access.js + server/access.ts), against a real sequencer. Scratch port, scratch WORLDS_DIR, its
// own tokens.json; never 8968/8970. usage: bun tools/protocol/access-check.ts
//   A1  members only (@world.access {join: listed}): someone not listed is refused at the door, 4010, in words that say
//       only that the world isn't open to them; someone listed comes in
//   A2  watch only ({join: listed, watch: anyone}): the same person may watch (spectate), and a body is refused
//   A3  /worlds and the reads are per caller: a members-only world is on no stranger's map and /geom answers as for no
//       world; a listed caller's bearer sees it (access, you); /access answers enter | watch | none, and 401 anonymously
//   A4  closing the door removes whoever is no longer let in, at once (4010); owners stay
//   A5  a timed grant (roles:<id>.until): its holder is told before it ends (notice), and when it passes the authority
//       writes its end (expire-roles) and the door removes them (4010)
//   A6  until is refused in the past and on an owner
//   A7  a reset keeps a members-only world's door and members
//   A8  a ban or kick in the moderator log closes the door after a restart too, before the world is loaded: a banned
//       (and a kicked) caller still listed in a members-only world gets 404 from /geom and /heightmap, finds it on no
//       map, and /access says none — the refusal never loads the world (Antra's review of f91840e5 P1: /geom was 200)
//   A12 (security review 10-18 H1) an operator's GLOBAL ban binds to the target's account NOW: a present target is removed and
//       can't reconnect (4006, "these worlds"), an absent one can't join; the record carries the account; unban lifts it
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
// @ts-nocheck
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { ENGINE, scratch } from "./common.ts";

const root = scratch("access");
let pass = 0, fail = 0;
const ok = (cond, what, detail?) => { if (cond) pass++; else { fail++; console.log(`  FAIL ${what}${detail !== undefined ? ` — ${JSON.stringify(detail).slice(0, 400)}` : ""}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const W = path.join(root, "w"); fs.mkdirSync(W, { recursive: true });
const TOK = path.join(root, "tokens.json");
fs.writeFileSync(TOK, JSON.stringify({ "tok-rowan": { id: "Rowan" }, "tok-moss": { id: "Moss" }, "tok-wren": { id: "Wren" }, "tok-fen": { id: "Fen" }, "tok-ivy": { id: "Ivy" } }));
const env = (extra = {}) => ({ ...process.env, WORLDS_DIR: W, OPT_DIR: path.join(root, "opt"), SKIP_OPT_SWEEP: "1", HOST: "127.0.0.1",
  BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0", JOIN_TOKEN: "", WORLD_ADMIN: "", AGENT_TOKENS_PATH: TOK, SESSIONS_PATH: path.join(root, "sessions.json"),
  TRUST_NAMES: "1", ACCESS_SWEEP_MS: "250", ...extra });
const tool = (args) => { const r = Bun.spawnSync(["bun", "tools/protocol/world.ts", ...args], { cwd: ENGINE, env: env() }); return { code: r.exitCode, out: r.stdout.toString() + r.stderr.toString() }; };
async function start(extra = {}) {
  let port = 9410; for (; port < 9500; port++) { try { const s = Bun.listen({ hostname: "127.0.0.1", port, socket: { data() {} } }); s.stop(true); break; } catch {} }
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
    async join(world, id, extra = {}) { const k = msgs.length; ws.send(JSON.stringify({ type: "join", world, id, avatar: "", replica: true, ...extra }));
      for (let i = 0; i < 60; i++) { if (msgs.slice(k).some((m) => m.type === "snapshot" || m.type === "error") || closed != null) break; await sleep(50); }
      await sleep(80); return { snapshot: msgs.slice(k).find((m) => m.type === "snapshot"), errors: msgs.slice(k).filter((m) => m.type === "error").map((m) => m.error) }; },
    req: (verb, args = {}) => new Promise((res) => { const id = `r${++n}`; waiters.set(id, res); ws.send(JSON.stringify({ type: "request", id, verb, args })); setTimeout(() => res({ ok: false, timeout: true }), 4000); }),
    raw: (m) => ws.send(JSON.stringify(m)),
    close: () => ws.close(),
  };
}
const you = (j) => j.snapshot?.cut?.you;
const worldsAs = async (port, bearer?) => (await (await fetch(`http://127.0.0.1:${port}/worlds`, bearer ? { headers: { authorization: `Bearer ${bearer}` } } : {})).json()).worlds ?? [];
const accessAs = async (port, world, bearer?) => { const r = await fetch(`http://127.0.0.1:${port}/access?world=${world}`, bearer ? { headers: { authorization: `Bearer ${bearer}` } } : {}); return { status: r.status, body: await r.json().catch(() => null) }; };
const waitFor = async (f, ms = 4000) => { for (let t = 0; t < ms; t += 50) { if (f()) return true; await sleep(50); } return !!f(); };

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
ok((await own.req("set", { id: "@world", component: `roles:${ids.Rowan}`, value: { role: "inhabitant" } })).ok, "(setup) Rowan is listed (an inhabitant)");

// ---- A4: closing the door removes whoever isn't listed, now ----
const bob = await sock(srv.port); const jb = await bob.join("keep", "Bob");
ok(!!jb.snapshot, "(A4 setup) Bob, not listed, is in the open world");
const close = await own.req("set", { id: "@world", component: "access", value: { join: "listed" } });
const removed = await waitFor(() => bob.closed != null);
ok(close.ok && removed && bob.closed === 4010 && bob.msgs.some((m) => m.type === "error" && /isn't open to you/.test(m.error)) && own.closed == null,
  "A4 closing the door removes Bob (4010, in the door's words); the owner stays", [close.ok, bob.closed, bob.msgs.filter((m) => m.type === "error").map((m) => m.error), own.closed]);

// ---- A1: members only ----
{ const c = await sock(srv.port); const j = await c.join("keep", "Carl");
  ok(!j.snapshot && c.closed === 4010 && /"keep" isn't open to you/.test(j.errors.join(" ")) && !/role|listed/.test(j.errors.join(" ")),
    "A1 someone not listed is refused at the door: 4010, and the words say only that it isn't open to them", [j.errors, c.closed]); c.close();
  const r = await sock(srv.port); const jr = await r.join("keep", "Rowan", { agentToken: "tok-rowan" });
  ok(!!jr.snapshot, "A1 someone listed comes in", jr.errors); r.close();
  const w = await sock(srv.port); const jw = await w.join("keep", "Carl", { spectate: true });
  ok(!jw.snapshot && w.closed === 4010, "A1 …and in a members-only world the stranger can't even watch", [jw.errors, w.closed]); w.close(); }

// ---- A3: per-caller visibility ----
{ const anon = await worldsAs(srv.port), stranger = await worldsAs(srv.port, "tok-moss"), member = await worldsAs(srv.port, "tok-rowan");
  const geom = await fetch(`http://127.0.0.1:${srv.port}/geom?world=keep`);
  const mine = member.find((x) => x.name === "keep");
  ok(!anon.some((x) => x.name === "keep") && !stranger.some((x) => x.name === "keep") && geom.status === 404 && mine?.access === "invite-only" && mine?.you === "enter",
    "A3 a members-only world is on no stranger's map (/geom answers as for no world); a listed caller sees it, members, enter", [anon.map((x) => x.name), stranger.map((x) => x.name), geom.status, mine]);
  const a0 = await accessAs(srv.port, "keep"), a1 = await accessAs(srv.port, "keep", "tok-moss"), a2 = await accessAs(srv.port, "keep", "tok-rowan"), a3 = await accessAs(srv.port, "nowhere", "tok-rowan");
  ok(a0.status === 401 && a1.body?.you === "none" && a2.body?.you === "enter" && a3.body?.exists === false && a3.body?.found?.ok === false,
    "A3 /access: 401 anonymously; none for a stranger, enter for a member; a name with no world says joining never founds one", [a0.status, a1.body, a2.body, a3.body]); }

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
{ const past = await own.req("set", { id: "@world", component: `roles:${ids.Pip}`, value: { role: "inhabitant", until: Date.now() - 1000 } });
  const onOwner = await own.req("set", { id: "@world", component: `roles:${ids.Pip}`, value: { role: "owner", until: Date.now() + 60_000 } });
  ok(!past.ok && past.refused?.code === "bounds" && !onOwner.ok && /ownership never expires/.test(onOwner.refused?.reason ?? ""),
    "A6 until is refused in the past, and on an owner", [past.refused, onOwner.refused]); }

// ---- A5: a timed grant ----
{ const set = await own.req("set", { id: "@world", component: `roles:${ids.Pip}`, value: { role: "inhabitant", until: Date.now() + 2500 } });
  const p = await sock(srv.port); const jp = await p.join("keep", "Pip");
  const told = await waitFor(() => p.msgs.some((m) => m.type === "notice" && /ends in/.test(m.text)), 2000);
  const gone = await waitFor(() => p.closed != null, 6000);
  const log = fs.readFileSync(path.join(W, "keep", "world.jsonl"), "utf8");
  const ended = log.split("\n").filter(Boolean).map((l) => JSON.parse(l)).find((e) => e.kind === "act" && e.verb === "expire-roles");
  const role = (await own.req("look", {})) && null;
  ok(set.ok && !!jp.snapshot && told && gone && p.closed === 4010 && ended?.actor === "system" && ended?.body?.ids?.includes(ids.Pip),
    "A5 a timed grant: its holder is told before it ends; the authority writes its end (expire-roles, the system's act) and the door removes them (4010)",
    [set.ok, !!jp.snapshot, told, p.closed, ended?.body, p.msgs.filter((m) => m.type === "notice" || m.type === "error").map((m) => m.text ?? m.error)]);
  void role; }

// ---- A7: a reset keeps a members-only world's door and members ----
{ const k0 = own.msgs.length; own.raw({ type: "world-reset", name: "keep" });
  await waitFor(() => own.closed != null || own.msgs.slice(k0).some((m) => m.type === "world-reset" || m.type === "error"), 6000);
  await sleep(400);
  const log = fs.readFileSync(path.join(W, "keep", "world.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const ops = log.filter((e) => e.kind === "change").flatMap((e) => (Array.isArray(e.body?.ops) ? e.body.ops : [e.body]));   // a batch, or one op
  const access = ops.find((o) => o.id === "@world" && o.comp === "access")?.value;
  const rowan = ops.find((o) => o.id === "@world" && o.comp === `roles:${ids.Rowan}`)?.value;
  ok(access?.join === "listed" && rowan?.role === "inhabitant", "A7 a reset keeps a members-only world's door and its members", [access, rowan, ops.length, own.closed, own.msgs.slice(k0).map((m) => m.type + (m.error ? `: ${m.error}` : "")).slice(0, 6)]);
  // A7b (review of #260, server I7): a signed-in-only door is kept too (only "listed" was, so the reset opened it to guests)
  const set = await own.req("set", { id: "@world", component: "access", value: { join: "signed-in" } });
  const k1 = own.msgs.length; own.raw({ type: "world-reset", name: "keep" });
  await waitFor(() => own.closed != null || own.msgs.slice(k1).some((m) => m.type === "world-reset" || m.type === "error"), 6000);
  await sleep(400);
  const log2 = fs.readFileSync(path.join(W, "keep", "world.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const ops2 = log2.filter((e) => e.kind === "change").flatMap((e) => (Array.isArray(e.body?.ops) ? e.body.ops : [e.body]));
  const access2 = ops2.find((o) => o.id === "@world" && o.comp === "access")?.value;
  ok(set?.ok && access2?.join === "signed-in", "A7b a reset keeps a signed-in-only world's door", [set?.ok, set?.refused, access2, own.msgs.slice(k1).map((m) => m.type + (m.error ? `: ${m.error}` : "")).slice(0, 6)]);
  // the rest of this suite reads "keep" as members-only: its door goes back as A7 left it
  const back = await own.req("set", { id: "@world", component: "access", value: access });
  ok(back?.ok, "(A7b) keep's members-only door is put back for what follows", back?.refused); }

// ---- A8 (setup, loaded): Moss and Wren are listed; Moss is banned, Wren kicked for 30 min; the loaded door refuses both ----
const geomAs = async (port, world, bearer) => (await fetch(`http://127.0.0.1:${port}/geom?world=${world}`, { headers: { authorization: `Bearer ${bearer}` } })).status;
{ const lm = await own.req("set", { id: "@world", component: `roles:${ids.Moss}`, value: { role: "inhabitant" } });
  const lw = await own.req("set", { id: "@world", component: `roles:${ids.Wren}`, value: { role: "inhabitant" } });
  const bm = await own.req("ban", { who: ids.Moss, reason: "A8" }), kw = await own.req("kick", { who: ids.Wren, minutes: 30, reason: "A8" });
  const gm = await geomAs(srv.port, "keep", "tok-moss"), gw = await geomAs(srv.port, "keep", "tok-wren"), gr = await geomAs(srv.port, "keep", "tok-rowan");
  ok(lm.ok && lw.ok && bm.ok && kw.ok && gm === 404 && gw === 404 && gr === 200, "(A8 setup) listed, then banned / kicked: the loaded world's /geom refuses both (404), a member still reads it",
    [lm.refused, lw.refused, bm.refused, kw.refused, gm, gw, gr]); }

// (A14 setup) Fen is listed for 2.5 s; the server is stopped BEFORE that ends, so no sweep can write the end: the log keeps the grant
const fenUntil = Date.now() + 2500;
{ const r = await own.req("set", { id: "@world", component: `roles:${ids.Fen}`, value: { role: "inhabitant", until: fenUntil } }); ok(r.ok, "(A14 setup) Fen holds a timed grant", r.refused); }
own.close();
try { srv.proc.kill(); } catch {}
await sleep(300);

// ---- A3 (idle): after a restart, nobody in it, the members-only world's door is read from its log without loading it ----
// A10's sessions (restored at boot): Rowan's account as a cookie session, once narrowed to `water` (native pairing,
// HnSession.nativeWorld) and once not
const SID_NATIVE = "a".repeat(64), SID_FULL = "b".repeat(64);
fs.writeFileSync(path.join(root, "sessions.json"), JSON.stringify({
  [SID_NATIVE]: { sub: "agent:token:rowan", name: "Rowan", scopes: ["worlds:join"], exp: Date.now() + 3600_000, nativeWorld: "water" },
  [SID_FULL]: { sub: "agent:token:rowan", name: "Rowan", scopes: ["worlds:join"], exp: Date.now() + 3600_000 } }));
{ const s2 = await start();
  const anon = await worldsAs(s2.port), member = (await worldsAs(s2.port, "tok-rowan")).find((x) => x.name === "keep");
  const a1 = await accessAs(s2.port, "keep", "tok-ivy");   // a stranger (Moss is listed by now, for A8; Fen holds A14's timed grant)
  ok(!s2.dead && !anon.some((x) => x.name === "keep") && member?.loaded === false && member?.access === "invite-only" && member?.you === "enter" && a1.body?.you === "none",
    "A3 an idle world's door is read from its log (not loaded): a stranger's map lacks it; a member's shows it, members, enter", [anon.map((x) => x.name), member, a1.body]);
  // A14 (security review 10-18 M6): Fen's grant has ended but no sweep ran (the world is unloaded, the log still holds it): the reads refuse
  while (Date.now() <= fenUntil + 50) await sleep(50);
  { const logHas = fs.readFileSync(path.join(W, "keep", "world.jsonl"), "utf8").includes(`"roles:${ids.Fen}"`) && !fs.readFileSync(path.join(W, "keep", "world.jsonl"), "utf8").includes("expire-roles");
    const map = await worldsAs(s2.port, "tok-fen"), acc = await accessAs(s2.port, "keep", "tok-fen"), g = await geomAs(s2.port, "keep", "tok-fen");
    const still = (await worldsAs(s2.port, "tok-rowan")).find((x) => x.name === "keep");
    ok(logHas && !map.some((x) => x.name === "keep") && acc.body?.you === "none" && g === 404 && still?.loaded === false,
      "A14 an ended timed grant is absent on every read: the unloaded world's /worlds, /access and /geom refuse the ex-member (the log still holds the grant, no expire-roles yet), and the refusal loads nothing",
      { logHas, map: map.map((x) => x.name), access: acc.body, geom: g, loaded: still?.loaded }); }
  // A8: the same world, still not loaded — the moderator log is read with the door
  for (const [who, tok] of [["banned Moss", "tok-moss"], ["kicked Wren", "tok-wren"]]) {
    const map = await worldsAs(s2.port, tok), acc = await accessAs(s2.port, "keep", tok);
    const g1 = await geomAs(s2.port, "keep", tok), g2 = await geomAs(s2.port, "keep", tok);
    const hm = await fetch(`http://127.0.0.1:${s2.port}/heightmap?world=keep&format=json`, { headers: { authorization: `Bearer ${tok}` } }); const hmText = await hm.text();
    const still = (await worldsAs(s2.port, "tok-rowan")).find((x) => x.name === "keep");
    ok(!map.some((x) => x.name === "keep") && acc.body?.you === "none" && g1 === 404 && g2 === 404 && hm.status === 404 && /no such world/.test(hmText) && still?.loaded === false,
      `A8 after a restart, the world unloaded: the ${who} (still listed) is refused by /worlds, /access, /geom (404, twice) and /heightmap, and the refusal loads nothing`,
      { map: map.map((x) => x.name), access: acc.body, geom: [g1, g2], heightmap: [hm.status, hmText.slice(0, 60)], loaded: still?.loaded }); }
  { // A10 (review of PR #260, access.ts:161; Antra's repro): a native session approved only for `water` keeps that limit over
    // HTTP — at the members-only world Rowan is listed in it is no one (/geom 404, off its /worlds map, /access none), while
    // the same account's unnarrowed session reads it (200, on the map, enter)
    const cookieGet = (sid, u) => fetch(`http://127.0.0.1:${s2.port}${u}`, { headers: { cookie: `ew_sess=${sid}` } });
    const gN = (await cookieGet(SID_NATIVE, "/geom?world=keep")).status, gF = (await cookieGet(SID_FULL, "/geom?world=keep")).status;
    const mapN = (await (await cookieGet(SID_NATIVE, "/worlds")).json()).worlds ?? [], mapF = (await (await cookieGet(SID_FULL, "/worlds")).json()).worlds ?? [];
    const aN = await (await cookieGet(SID_NATIVE, "/access?world=keep")).json(), aF = await (await cookieGet(SID_FULL, "/access?world=keep")).json();
    ok(gN === 404 && gF === 200 && !mapN.some((x) => x.name === "keep") && mapF.some((x) => x.name === "keep") && aN.you === "none" && aF.you === "enter",
      "A10 a native session narrowed to water is no one at another world's door over HTTP (/geom 404, not on /worlds, /access none); the same account unnarrowed reads it",
      { geom: [gN, gF], map: [mapN.map((x) => x.name), mapF.map((x) => x.name)], access: [aN, aF] }); }
  // A14, the join: the first join loads the world; the door reads Fen's ended grant as absent BEFORE any sweep (4010)
  { const logHas = !fs.readFileSync(path.join(W, "keep", "world.jsonl"), "utf8").includes("expire-roles");
    const f = await sock(s2.port); const jf = await f.join("keep", "Fen", { agentToken: "tok-fen" });
    ok(logHas && !jf.snapshot && f.closed === 4010 && /isn't open to you/.test(jf.errors.join(" ")), "A14 …and the join that loads the world is refused at the door (4010), the grant unswept until then", { logHas, join: jf.errors, closed: f.closed }); f.close(); }
  try { s2.proc.kill(); } catch {} }
{ // A11 (review of PR #260, server.ts:742): an operator (WORLD_ADMIN) has a NARROW, RECORDED repair capability through the
  // authority: Fen, an operator not listed in the members-only world, gets in (the bypass) but an ordinary write is still the
  // world's to judge; operator-repair lifts Moss's ban and lists Fen, each the operator's own act / record marked operator;
  // a non-operator's operator-repair is refused
  const s3 = await start({ WORLD_ADMIN: "agent:token:fen" });
  const fen = await sock(s3.port); const jf = await fen.join("keep", "Fen", { agentToken: "tok-fen" }); const fenId = you(jf);
  let k = 0; const repair = async (s, verb, args) => { const id = `op${++k}`; s.raw({ type: "operator-repair", id, verb, args });
    await waitFor(() => s.msgs.some((m) => m.type === "reply" && m.id === id), 4000); return s.msgs.find((m) => m.type === "reply" && m.id === id); };
  const plain = await fen.req("set", { id: "@world", component: `roles:${fenId}`, value: { role: "owner" } });
  const unban = await repair(fen, "unban", { who: ids.Moss });
  const list = await repair(fen, "set", { id: "@world", component: `roles:${fenId}`, value: { role: "inhabitant" } });
  const wide = await repair(fen, "set", { id: "@world", component: "about", value: { name: "x", text: "" } });
  const row = await sock(s3.port); const jr = await row.join("keep", "Rowan", { agentToken: "tok-rowan" });
  const notOp = await repair(row, "unban", { who: ids.Moss });
  const mossGeom = await geomAs(s3.port, "keep", "tok-moss");
  const log = fs.readFileSync(path.join(W, "keep", "world.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const mod = fs.readFileSync(path.join(W, "keep", "world.mod.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const act = log.find((e) => e.kind === "act" && e.actor === fenId && e.body?.operator === true && e.body?.request?.component === `roles:${fenId}`);
  const rec = mod.find((m) => m.verb === "unban" && m.who === ids.Moss && m.actor === fenId && m.operator === true);
  ok(!!jf.snapshot && !plain.ok && plain.refused?.code === "rights" && unban?.reply?.ok && list?.reply?.ok && wide?.reply?.refused?.code === "rights" && !!jr.snapshot && notOp?.reply?.refused?.code === "rights" && mossGeom === 200 && !!act && !!rec,
    "A11 an operator repairs through the authority, narrowly and on the record: ordinary write refused, operator-repair unbans and lists (act / mod record marked operator), another component refused, a non-operator refused",
    { join: jf.errors, plain: plain.refused, unban: unban?.reply, list: list?.reply, wide: wide?.reply?.refused, notOp: notOp?.reply?.refused, mossGeom, act: !!act, rec: !!rec });
  // A12 (security review 10-18 H1): a GLOBAL ban binds to the account now. Rowan is present: removed, and refused on reconnect;
  // Moss is absent: the directory knows the account wearing that name, and the join is refused; the record names the account
  const modMsgs = () => fen.msgs.filter((m) => m.type === "mod" || m.type === "error").map((m) => m.text ?? m.error);
  const k0 = fen.msgs.length; fen.raw({ type: "global-ban", id: "Rowan", reason: "A12" }); await waitFor(() => row.closed != null, 3000);
  const row2 = await sock(s3.port); const jr2 = await row2.join("keep", "Rowan", { agentToken: "tok-rowan" });
  fen.raw({ type: "global-ban", id: "Moss", reason: "A12" }); await waitFor(() => fen.msgs.length > k0 + 1, 2000);
  const moss = await sock(s3.port); const jm = await moss.join("keep", "Moss", { agentToken: "tok-moss" });
  fen.raw({ type: "global-ban", id: "Nobody-Here-At-All" }); await waitFor(() => modMsgs().some((t) => /nothing a ban could bind to/.test(t)), 2000);
  const bans = JSON.parse(fs.readFileSync(path.join(W, ".bans.json"), "utf8"));
  const recR = Object.values(bans).find((b) => b.account === "agent:token:rowan"), recM = Object.values(bans).find((b) => b.account === "agent:token:moss");
  ok(row.closed === 4006 && !jr2.snapshot && row2.closed === 4006 && /banned from these worlds/.test(jr2.errors.join(" ")) && !jm.snapshot && moss.closed === 4006 && /these worlds/.test(jm.errors.join(" "))
    && !!recR && recR.name === "Rowan" && !!recM && Object.values(bans).every((b) => b.account || b.addr) && modMsgs().some((t) => /nothing a ban could bind to/.test(t)),
    "A12 a global ban binds now: the present target is removed (4006) and refused on reconnect, the absent target's join is refused, each record names the account (never a bare name), and a name nothing wears is refused",
    { rowClosed: row.closed, reconnect: [jr2.errors, row2.closed], moss: [jm.errors, moss.closed], bans, said: modMsgs().slice(-3) });
  const k1 = fen.msgs.length; fen.raw({ type: "global-unban", id: "Rowan" }); fen.raw({ type: "global-unban", id: "agent:token:moss" }); await waitFor(() => fen.msgs.length >= k1 + 2, 2000);
  const row3 = await sock(s3.port); const jr3 = await row3.join("keep", "Rowan", { agentToken: "tok-rowan" }); const moss2 = await sock(s3.port); const jm2 = await moss2.join("keep", "Moss", { agentToken: "tok-moss" });
  ok(!!jr3.snapshot && !!jm2.snapshot && Object.keys(JSON.parse(fs.readFileSync(path.join(W, ".bans.json"), "utf8"))).length === 0, "A12 global-unban by name or by account lifts it: both join again, the list is empty", [jr3.errors, jm2.errors]);
  row2.close(); row3.close(); moss.close(); moss2.close();
  fen.close(); row.close(); try { s3.proc.kill(); } catch {} await sleep(300); }
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
// ---- A13c (review of #260): a global ban made before accounts, on an aid1 agent's bare sub, still holds (pure) ----
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
  const s = await start({ WORLD_ADMIN: "agent:token:fen" });
  const op = await sock(s.port); const jo = await op.join("keep", "Fen", { agentToken: "tok-fen" });
  const k = op.msgs.length; op.raw({ type: "global-unban", id: "aid1:https://id.example.org:agent-7f3a" }); op.raw({ type: "global-unban", id: "Nine" });
  await waitFor(() => op.msgs.length >= k + 2, 3000);
  const left = Object.keys(JSON.parse(fs.readFileSync(path.join(W, ".bans.json"), "utf8")));
  ok(!!jo.snapshot && left.length === 1 && left[0] === "old-c",
    "A13c (door) the global unban lifts a ban from before accounts by the aid1 account it holds against, and by a name that account wears here; another stays",
    { join: jo.errors, left, said: op.msgs.slice(k).map((m) => m.text ?? m.error) });
  const LONG = "L".repeat(64);
  const body = await sock(s.port); const jb = await body.join("d12", LONG);   // its account, local:l…l, wears the long name
  const watch = await sock(s.port); const jw = await watch.join("d12", LONG, { spectate: true, account: "watcher" });   // local:watcher
  await sleep(150);
  const dirFile = JSON.parse(fs.readFileSync(path.join(W, ".directory.json"), "utf8"));
  const nameOf = (sub) => Object.values(dirFile.ids ?? {}).find((e) => (e.subs ?? []).includes(sub))?.name;
  const theirs = nameOf(`local:${LONG.toLowerCase()}`), seen = nameOf("local:watcher") ?? "";
  ok(!!jb.snapshot && !!jw.snapshot && theirs === LONG && seen.length <= 64 && seen.endsWith("-cher") && seen.toLowerCase() !== LONG.toLowerCase(),
    "D12 (door) a spectator's first sight under a 64-character name another account wears records that name cut to keep its own account's tag (-cher), within the limit, never the other account's name",
    { joins: [jb.errors, jw.errors], theirs, seen });
  body.close(); watch.close(); op.close(); try { s.proc.kill(); } catch {} await sleep(300); fs.rmSync(path.join(W, ".bans.json"), { force: true }); }
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
// ---- A13e–A13g (review of #260, server I5): custody's lock. A lock file is "<pid> <nonce>", linked into place whole
// (server/custody.ts take); this process holds one the same way, so the children meet a lock held by a live process ----
const holdLock = (name, pid = process.pid) => { const nonce = crypto.randomBytes(8).toString("hex"), t = `${name}.${nonce}.held`;
  fs.writeFileSync(t, `${pid} ${nonce}`); fs.linkSync(t, name); fs.rmSync(t); return nonce; };
const custodyTs = path.join(ENGINE, "server/custody.ts");
// a child that opens its handle, says it's ready, waits for `go` (sleeping, not spinning), mints `each` holder keys and the
// sequencer key, and prints what it got; or prints the error a mint threw
const minter = (dir, f, go, i, each) => Bun.spawn(["bun", "-e", `const fs = require("node:fs"); const { custodyAt } = await import(${JSON.stringify(custodyTs)});
  const h = custodyAt(${JSON.stringify(f)}); fs.writeFileSync(${JSON.stringify(dir)} + "/ready-${i}", "");
  const nap = new Int32Array(new SharedArrayBuffer(4)); while (!fs.existsSync(${JSON.stringify(go)})) Atomics.wait(nap, 0, 0, 5);
  const out = {}; try { for (let j = 0; j < ${each}; j++) out["u-p${i}-" + j] = h.keyOf("u-p${i}-" + j, true); out.sequencer = h.sequencer(); }
  catch (e) { out.error = String(e.message ?? e); } console.log(JSON.stringify(out));`], { cwd: ENGINE, stdout: "pipe", stderr: "pipe" });
const resultOf = async (k) => { await k.exited; return JSON.parse((await new Response(k.stdout).text()) || "{}"); };
const readyIn = (dir) => fs.readdirSync(dir).filter((n) => n.startsWith("ready-")).length;
const keysIn = (f) => fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : {};
const textOf = (f) => { try { return fs.readFileSync(f, "utf8"); } catch { return ""; } };   // a lock may be gone: that's a verdict, not a crash
// A13g first, since it waits out the lock: a lock held by a live process the whole time ends the wait with a refusal that
// names the lock and its holder
const tDir = fs.mkdtempSync(path.join(os.tmpdir(), "custody-")), tFile = path.join(tDir, "keys", "custody.json");
fs.mkdirSync(path.dirname(tFile), { recursive: true }); holdLock(`${tFile}.lock`);
fs.writeFileSync(path.join(tDir, "go"), ""); const tStart = Date.now(), tKid = minter(tDir, tFile, path.join(tDir, "go"), 0, 1), timedOut = resultOf(tKid);
// ---- A13e: while a live process holds the lock no one mints; released, six processes minting into one keys file at once keep every key ----
{ const dir = fs.mkdtempSync(path.join(os.tmpdir(), "custody-")), f = path.join(dir, "keys", "custody.json"), go = path.join(dir, "go"), N = 6, EACH = 8;
  fs.mkdirSync(path.dirname(f), { recursive: true }); holdLock(`${f}.lock`);
  const kids = Array.from({ length: N }, (_, i) => minter(dir, f, go, i, EACH));
  const ready = await waitFor(() => readyIn(dir) === N, 60_000);
  fs.writeFileSync(go, ""); await sleep(600);   // every child has met the held lock by now, and waits on it
  const during = Object.keys(keysIn(f).holders ?? {}).length, waiting = kids.every((k) => k.exitCode === null);
  fs.rmSync(`${f}.lock`, { force: true });   // released: the six take it in turn, from the same instant
  const minted = await Promise.all(kids.map(resultOf));
  const disk = keysIn(f);
  const lost = minted.flatMap((m) => Object.entries(m).filter(([who]) => who.startsWith("u-")).filter(([who, pub]) => disk.holders?.[who]?.pub !== pub).map(([who]) => who));
  const seqs = new Set(minted.map((m) => m.sequencer)), left = fs.readdirSync(path.dirname(f)).filter((n) => n !== "custody.json");
  ok(ready && during === 0 && waiting && minted.every((m) => !m.error && Object.keys(m).length === EACH + 1) && lost.length === 0 && seqs.size === 1 && disk.sequencer?.pub === [...seqs][0] && !left.length,
    "A13e while a live process holds the custody lock, six minters all wait and none mints; released, they mint into one keys file at once, every holder key each minted is on disk, they sign with one sequencer key, and nothing is left beside the file",
    { ready, during, waiting, errors: minted.map((m) => m.error).filter(Boolean), lost: lost.length, of: N * EACH, seqs: seqs.size, left }); }
// ---- A13f: a lock whose holder exited is removed, once, by whoever holds the right to remove it (`<lock>.<its nonce>`) ----
{ const dir = fs.mkdtempSync(path.join(os.tmpdir(), "custody-")), f = path.join(dir, "keys", "custody.json"), go = path.join(dir, "go"), lock = `${f}.lock`;
  const gone = Bun.spawn(["bun", "-e", ""]); await gone.exited;   // a pid that has exited
  fs.mkdirSync(path.dirname(f), { recursive: true }); const stale = holdLock(lock, gone.pid);
  const right = holdLock(`${lock}.${stale}`);   // this process is part way through removing it
  fs.writeFileSync(go, ""); const kid = minter(dir, f, go, 0, 1); await waitFor(() => readyIn(dir) === 1, 60_000); await sleep(600);
  const kept = textOf(lock).endsWith(stale), waited = kid.exitCode === null;
  // …it finishes: removes the stale lock, takes the lock itself, gives the right back: the child must not remove a live lock
  fs.rmSync(lock, { force: true }); let mine = null; try { mine = holdLock(lock); } catch {} fs.rmSync(`${lock}.${stale}`, { force: true }); await sleep(600);
  const live = !!mine && textOf(lock).endsWith(mine), stillWaiting = kid.exitCode === null;
  fs.rmSync(lock, { force: true }); const got = await resultOf(kid);
  // and a lock whose holder exited, with no one removing it, is taken over at once
  const g = path.join(dir, "again", "custody.json"); fs.mkdirSync(path.dirname(g), { recursive: true }); holdLock(`${g}.lock`, gone.pid);
  const { custodyAt } = await import(custodyTs); const t0 = Date.now(); let k2 = null, err2;
  try { k2 = custodyAt(g).keyOf("u-again", true); } catch (e) { err2 = String(e?.message ?? e); } const took = Date.now() - t0;
  const leftF = fs.readdirSync(path.dirname(f)).filter((n) => n !== "custody.json"), leftG = fs.readdirSync(path.dirname(g)).filter((n) => n !== "custody.json");
  ok(kept && waited && live && stillWaiting && !got.error && keysIn(f).holders?.["u-p0-0"]?.pub === got["u-p0-0"] && !!k2 && keysIn(g).holders?.["u-again"]?.pub === k2 && took < 2000 && !leftF.length && !leftG.length,
    "A13f a lock whose holder exited is left alone while another holds the right to remove it, and a live lock that replaced it is never removed; with no one removing it, a mint takes it over at once; nothing is left beside the file",
    { kept, waited, live, stillWaiting, error: got.error, err2, took, leftF, leftG, right }); }
// ---- A13g: …the refusal that ends the wait ----
{ const got = await Promise.race([timedOut, sleep(Math.max(0, 25_000 - (Date.now() - tStart))).then(() => ({ hung: true }))]), waited = Date.now() - tStart;
  if (got.hung) tKid.kill();
  ok(typeof got.error === "string" && got.error.includes(`${tFile}.lock`) && got.error.includes(`by process ${process.pid}`) && /held .* for 10 s/.test(got.error) && waited >= 9_500 && !keysIn(tFile).holders,
    "A13g a mint that waits 10 s on a lock a live process holds gives up, naming the lock and its holder, and mints nothing", { got, waited });
  fs.rmSync(`${tFile}.lock`, { force: true }); }
{ // A9 (final review M1): a members-only door is not opened by default-role / role-defs powers handed to everyone
  const { entryFor } = await import(path.join(ENGINE, "server/access.ts"));
  const base = { access: { join: "listed" } };
  const cases = [
    ["default-role {can:{kick}}", { ...base, "default-role": { role: "inhabitant", can: { kick: true } } }],
    ["default-role {role: moderator}", { ...base, "default-role": { role: "moderator" } }],
    ["role-defs.visitor.can.mute", { ...base, "default-role": { role: "inhabitant" }, "role-defs": { visitor: { can: { mute: true } } } }],
  ];
  const got = cases.map(([n, wc]) => [n, entryFor({ name: "m1", wc, label: "members" }, { account: "acct-stranger", actorId: "u-stranger00000000000000", addr: "1.2.3.4" }, "embody")?.code ?? "admitted"]);
  ok(got.every(([, c]) => c !== "admitted"), "A9 a stranger in a members-only world stays out even when the default role (or a role-def) carries a moderation power", got);
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
  const set = [["Pip", "inhabitant"], ["Rowan", "inhabitant"], ["Wren", "inhabitant"], ["Fen", "owner"]];
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
  ok(you(jx) === who.Moss && !asRowan.snapshot && x.closed != null && !ownTok.snapshot && y.closed === 4010 && !asPip.snapshot && /already joined as someone else/.test(asPip.errors.join(" "))
    && !asQ.snapshot && /already joined as someone else/.test(asQ.errors.join(" ")) && !!jq.snapshot && you(jq) !== who.Moss,
    "A15 a credentialed socket's re-join carries nothing over: as a member's typed name it is refused (the reserved name, or 'already joined as someone else' for Pip); with its own token it is still Moss, refused as a stranger (4010); and it files no identity under a name it types (a fresh Quentin isn't Moss)",
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
  ok(!byName.ok && byName.refused?.code === "shape" && !delName.ok && delWren.ok && jf.snapshot?.yourRights?.role === "owner" && wren.body?.you === "none" && stranger.body?.you === "none" && !anonMap,
    "A16 a revoke touches only its own record: a role under a bare name is refused and its delete finds nothing; deleting Wren's role leaves co-owner Fen an owner, and the door stays closed",
    { byName: byName.refused, delName: delName.refused, delWren: delWren.refused, fen: [jf.errors, jf.snapshot?.yourRights?.role], wren: wren.body, stranger: stranger.body, anonMap });
  f.close();
  // A17: a revoke takes effect: Rowan is present; deleting roles:<Rowan> is accepted, removes him now (4010), /access says
  // none, his rejoin is refused, and the log holds the delete
  const r = await sock(s4.port); const jr = await r.join("door", "Rowan", { agentToken: "tok-rowan" });
  const del = await ann.req("delete", { id: "@world", component: `roles:${who.Rowan}` });
  const out = await waitFor(() => r.closed != null, 4000);
  const acc = await accessAs(s4.port, "door", "tok-rowan");
  const back = await sock(s4.port); const jb = await back.join("door", "Rowan", { agentToken: "tok-rowan" });
  const logged = fs.readFileSync(path.join(W, "door", "world.jsonl"), "utf8").split("\n").filter(Boolean)
    .some((l) => l.includes(`roles:${who.Rowan}`) && l.includes('"delete"'));
  ok(!!jr.snapshot && del.ok && out && r.closed === 4010 && acc.body?.you === "none" && !jb.snapshot && back.closed === 4010 && logged,
    "A17 a revoke takes effect: deleting a present member's role is accepted, removes them now (4010), /access says none, the rejoin is refused, and the log holds the delete",
    { joined: !!jr.snapshot, del: del.refused, closed: r.closed, acc: acc.body, back: [jb.errors, back.closed], logged });
  r.close(); back.close(); ann.close(); try { s4.proc.kill(); } catch {} await sleep(300); }
console.log(`[access-check] ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
