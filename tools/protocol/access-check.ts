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
// @ts-nocheck
import fs from "node:fs";
import path from "node:path";
import { ENGINE, scratch } from "./common.ts";

const root = scratch("access");
let pass = 0, fail = 0;
const ok = (cond, what, detail?) => { if (cond) pass++; else { fail++; console.log(`  FAIL ${what}${detail !== undefined ? ` — ${JSON.stringify(detail).slice(0, 400)}` : ""}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const W = path.join(root, "w"); fs.mkdirSync(W, { recursive: true });
const TOK = path.join(root, "tokens.json");
fs.writeFileSync(TOK, JSON.stringify({ "tok-rowan": { id: "Rowan" }, "tok-moss": { id: "Moss" }, "tok-wren": { id: "Wren" }, "tok-fen": { id: "Fen" } }));
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
for (const [name, extra] of [["Rowan", { agentToken: "tok-rowan" }], ["Pip", {}], ["Moss", { agentToken: "tok-moss" }], ["Wren", { agentToken: "tok-wren" }]] as const) {
  const s = await sock(srv.port); const j = await s.join("keep", name, extra); ids[name] = you(j); s.close(); }
await sleep(150);
ok(Object.values(ids).every(Boolean), "(setup) Rowan, Pip and Moss have identities here", ids);
ok((await own.req("set", { id: "@world", component: `roles:${ids.Rowan}`, value: { role: "visitor" } })).ok, "(setup) Rowan is listed (a visitor)");

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
  ok(!anon.some((x) => x.name === "keep") && !stranger.some((x) => x.name === "keep") && geom.status === 404 && mine?.access === "members" && mine?.you === "enter",
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
{ const past = await own.req("set", { id: "@world", component: `roles:${ids.Pip}`, value: { role: "visitor", until: Date.now() - 1000 } });
  const onOwner = await own.req("set", { id: "@world", component: `roles:${ids.Pip}`, value: { role: "owner", until: Date.now() + 60_000 } });
  ok(!past.ok && past.refused?.code === "bounds" && !onOwner.ok && /ownership never expires/.test(onOwner.refused?.reason ?? ""),
    "A6 until is refused in the past, and on an owner", [past.refused, onOwner.refused]); }

// ---- A5: a timed grant ----
{ const set = await own.req("set", { id: "@world", component: `roles:${ids.Pip}`, value: { role: "visitor", until: Date.now() + 2500 } });
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
  ok(access?.join === "listed" && rowan?.role === "visitor", "A7 a reset keeps a members-only world's door and its members", [access, rowan, ops.length, own.closed, own.msgs.slice(k0).map((m) => m.type + (m.error ? `: ${m.error}` : "")).slice(0, 6)]); }

// ---- A8 (setup, loaded): Moss and Wren are listed; Moss is banned, Wren kicked for 30 min; the loaded door refuses both ----
const geomAs = async (port, world, bearer) => (await fetch(`http://127.0.0.1:${port}/geom?world=${world}`, { headers: { authorization: `Bearer ${bearer}` } })).status;
{ const lm = await own.req("set", { id: "@world", component: `roles:${ids.Moss}`, value: { role: "visitor" } });
  const lw = await own.req("set", { id: "@world", component: `roles:${ids.Wren}`, value: { role: "visitor" } });
  const bm = await own.req("ban", { who: ids.Moss, reason: "A8" }), kw = await own.req("kick", { who: ids.Wren, minutes: 30, reason: "A8" });
  const gm = await geomAs(srv.port, "keep", "tok-moss"), gw = await geomAs(srv.port, "keep", "tok-wren"), gr = await geomAs(srv.port, "keep", "tok-rowan");
  ok(lm.ok && lw.ok && bm.ok && kw.ok && gm === 404 && gw === 404 && gr === 200, "(A8 setup) listed, then banned / kicked: the loaded world's /geom refuses both (404), a member still reads it",
    [lm.refused, lw.refused, bm.refused, kw.refused, gm, gw, gr]); }

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
  const a1 = await accessAs(s2.port, "keep", "tok-fen");   // a stranger (Moss is listed by now, for A8)
  ok(!s2.dead && !anon.some((x) => x.name === "keep") && member?.loaded === false && member?.access === "members" && member?.you === "enter" && a1.body?.you === "none",
    "A3 an idle world's door is read from its log (not loaded): a stranger's map lacks it; a member's shows it, members, enter", [anon.map((x) => x.name), member, a1.body]);
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
  const list = await repair(fen, "set", { id: "@world", component: `roles:${fenId}`, value: { role: "visitor" } });
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
  fen.close(); row.close(); try { s3.proc.kill(); } catch {} await sleep(300); }
{ // A9 (final review M1): a members-only door is not opened by default-role / role-defs powers handed to everyone
  const { entryFor } = await import(path.join(ENGINE, "server/access.ts"));
  const base = { access: { join: "listed" } };
  const cases = [
    ["default-role {can:{kick}}", { ...base, "default-role": { role: "visitor", can: { kick: true } } }],
    ["default-role {role: moderator}", { ...base, "default-role": { role: "moderator" } }],
    ["role-defs.visitor.can.mute", { ...base, "default-role": { role: "visitor" }, "role-defs": { visitor: { can: { mute: true } } } }],
  ];
  const got = cases.map(([n, wc]) => [n, entryFor({ name: "m1", wc, label: "members" }, { account: "acct-stranger", actorId: "u-stranger00000000000000", addr: "1.2.3.4" }, "embody")?.code ?? "admitted"]);
  ok(got.every(([, c]) => c !== "admitted"), "A9 a stranger in a members-only world stays out even when the default role (or a role-def) carries a moderation power", got);
  const mem = { ...cases[1][1], "roles:u-member0000000000000000": { role: "moderator" } };
  const m = entryFor({ name: "m1", wc: mem, label: "members" }, { account: "acct-m", actorId: "u-member0000000000000000", addr: "1.2.3.5" }, "embody");
  ok(m === null, "A9 a LISTED moderator still gets in", m);
}
console.log(`[access-check] ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
