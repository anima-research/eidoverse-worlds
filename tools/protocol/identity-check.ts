// tools/protocol/identity-check.ts — who a joiner is, against a real sequencer (security review 2026-10-06). Scratch port,
// scratch WORLDS_DIR, its own tokens.json and a test aid1 issuer; never 8968/8970. usage: bun tools/protocol/identity-check.ts
//   C1  a credential proven on one join never carries to a second join on the same socket
//   C2  an aid1 credential is an agent only if its kind says agent; an enrolment's listed aid1 subject is that agent;
//       C2f (10-18 L11) a reserved name is matched folded ("Wre n", "wren." are Wren) and refused without the enrolment's proof
//   C3  WORLD_ADMIN naming a bare display name refuses to boot
//   H1  typing someone's name doesn't kick them, take over their session, or show as them; a guest is named a guest
//   H3  a world name nobody founded is refused, and nothing appears on disk
//   H4  a guest is never given the world's default role; a door ban removes the person now; a guest's ban names the
//       connection, so reconnecting as a fresh guest is refused
//   H5  an owner can't demote the founder; default-role can't be owner; an owner can't be banned
//   ID  one account is the same identity in every world on the authority (per-world ids, review M6, withdrawn: R 10-06)
//   HB  presence is keyed by identity, never a display name (pass 2 H-B): a second account asking to be "Marigold" is shown
//       with a disambiguator (pass 3 H2), and doesn't get the first one's remembered pose; the real one does
//   MA  a pose past the size cap isn't relayed or remembered; one websocket message past the cap closes the socket
//   LC  on a box with a JOIN_TOKEN, /worlds, /snap and /geom?world need a key a join would take
//   RS  roles and moderation at the server (research roles S4): your-rights from the authority, voice-moderate as the authority's
//       identity-keyed logged mute (surviving a reconnect), a kick's cooldown at join, ghost hidden server-side, warn and
//       mute notices, access (listed / max with the moderator bypass); RS7 reset is the most senior owner's, fork is rate-limited;
//       RS8 whisper is removed (R 10-18: refused `removed`, delivered to nobody); RS9 ghost history/presence, the ban list,
//       a guest's kick by address; RS10 speech is arrival-only: no say before you arrived reaches a non-admin by either
//       history route or the join, a moderator included; an owner who joins later reads the master log
//   GG  a guest's mute and ghost carry by hashed address to the next guest from it (R 10-07: reconnecting sheds nothing);
//       lifting them lifts the address record; a signed-in person is untouched
//   AG  @world.access.minAccountDays: a Discord account's age from its snowflake (pure), and the join gate (young human
//       refused with when they qualify, a guest refused, an enrolled agent exempt, a moderator's bypass, the range)
// @ts-nocheck
import fs from "node:fs";
import path from "node:path";
import { generateKeyPairSync, sign as cryptoSign } from "node:crypto";
import { ENGINE, scratch } from "./common.ts";
import { idAliases } from "./idalias.ts";
const IDS = idAliases();   // R 10-17: the suite's names ride as placeholders and minted ids

const root = scratch("identity");
let pass = 0, fail = 0;
const ok = (cond, what, detail?) => { if (cond) pass++; else { fail++; console.log(`  FAIL ${what}${detail !== undefined ? ` — ${JSON.stringify(detail).slice(0, 400)}` : ""}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// a test home-node issuer
const pair = generateKeyPairSync("ed25519");
const spki = pair.publicKey.export({ type: "spki", format: "der" }) as Buffer;
const ISSUER = `ed25519:${spki.subarray(spki.length - 32).toString("base64url")}`;
let jti = 0;
const mint = (over = {}) => { const now = Math.floor(Date.now() / 1000);
  const p = { v: 1, iss: "id.test", sub: "human:discord:1", kind: "human", name: "Someone", aud: "eidoverse", scopes: ["worlds:join"], iat: now, exp: now + 600, jti: `j${jti++}`, ...over };
  const seg = Buffer.from(JSON.stringify(p)).toString("base64url");
  return `aid1.${seg}.${cryptoSign(null, Buffer.from(`aid1.${seg}`), pair.privateKey).toString("base64url")}`; };

const W = path.join(root, "w"); fs.mkdirSync(W, { recursive: true });
const TOK = path.join(root, "tokens.json");
fs.writeFileSync(TOK, JSON.stringify({ "tok-rowan": { id: "Rowan" }, "tok-wren": { id: "Wren", subs: ["agent:wren@home.test"] }, "tok-moss": { id: "Moss" }, "tok-fern": { id: "Fern" } }));
const env = (extra = {}) => ({ ...process.env, WORLDS_DIR: W, OPT_DIR: path.join(root, "opt"), SKIP_OPT_SWEEP: "1", HOST: "127.0.0.1",
  BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0", JOIN_TOKEN: "", WORLD_ADMIN: "", AGENT_TOKENS_PATH: TOK, SESSIONS_PATH: path.join(root, "sessions.json"), HN_ISSUER_KEY: ISSUER, HN_ISS: "id.test", TRUST_NAMES: "1", ...extra });
const tool = (args) => { const r = Bun.spawnSync(["bun", "tools/protocol/world.ts", ...args], { cwd: ENGINE, env: env() }); return { code: r.exitCode, out: r.stdout.toString() + r.stderr.toString() }; };
async function start(extra = {}) {
  let port = 9310; for (; port < 9400; port++) { try { const s = Bun.listen({ hostname: "127.0.0.1", port, socket: { data() {} } }); s.stop(true); break; } catch {} }
  const logf = path.join(root, `srv-${port}.log`);
  const p = Bun.spawn(["bun", "server/server.ts"], { cwd: ENGINE, env: env({ PORT: String(port), ...extra }), stdout: Bun.file(logf), stderr: Bun.file(logf + ".err") });
  for (let i = 0; i < 80; i++) { await sleep(150); if (p.exitCode != null) return { port, proc: p, dead: true, log: logf };
    try { if ((await fetch(`http://127.0.0.1:${port}/version`, { signal: AbortSignal.timeout(800) })).ok) return { port, proc: p, log: logf }; } catch {} }
  return { port, proc: p, dead: true, log: logf };
}
/** A socket that can join more than once (C1 needs two joins on ONE socket). */
async function sock(port, headers = undefined) {
  const ws = headers ? new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers }) : new WebSocket(`ws://127.0.0.1:${port}/ws`); const msgs = []; let n = 0; const waiters = new Map();
  ws.onmessage = (ev) => { const m = JSON.parse(String(ev.data)); msgs.push(m); if (m.type === "reply") waiters.get(m.id)?.(m.reply); };
  let closed = null; ws.onclose = (e) => { closed = e.code; };
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  const s = {
    msgs, get closed() { return closed; },
    async join(world, id, extra = {}) { const k = msgs.length; ws.send(JSON.stringify({ type: "join", world, id, avatar: "", replica: true, ...extra }));
      for (let i = 0; i < 60; i++) { if (msgs.slice(k).some((m) => m.type === "snapshot" || m.type === "error") || closed != null) break; await sleep(50); }
      await sleep(50); return { snapshot: msgs.slice(k).find((m) => m.type === "snapshot"), errors: msgs.slice(k).filter((m) => m.type === "error").map((m) => m.error) }; },
    req: (verb, args = {}) => new Promise((res) => { const id = `r${++n}`; waiters.set(id, (r) => res(IDS.back(r))); ws.send(JSON.stringify({ type: "request", id, verb, args: IDS.out(verb, args) })); setTimeout(() => res({ ok: false, timeout: true }), 4000); }),
    raw: (m) => ws.send(JSON.stringify(m)),
    close: () => ws.close(),
  };
  return s;
}
const you = (j) => j.snapshot?.cut?.you;

// ---- C3: a bare name in WORLD_ADMIN refuses to boot (accounts only) ----
{ const s = await start({ WORLD_ADMIN: "Marigold" });
  const err = fs.existsSync(s.log + ".err") ? fs.readFileSync(s.log + ".err", "utf8") : "";
  ok(s.dead && /isn't an account|aren't accounts/.test(err), "C3 WORLD_ADMIN=<a display name> refuses to boot, saying why", err.slice(-300));
  try { s.proc.kill(); } catch {} }

ok(tool(["found", "garden", "--owner", "Ann"]).code === 0 && tool(["found", "orchard", "--owner", "Ann"]).code === 0, "(setup) found two worlds, Ann owns both");
const srv = await start();
ok(!srv.dead, "(setup) the server is up", srv.dead ? fs.readFileSync(srv.log + ".err", "utf8").slice(-400) : "");

// ---- H3: no founding by joining ----
{ const g = await sock(srv.port); const j = await g.join("nowhere", "Ann");
  ok(!j.snapshot && /no world called "nowhere"/.test(j.errors.join(" ")) && !fs.existsSync(path.join(W, "nowhere")), "H3 joining a name nobody founded is refused; nothing is written", j.errors); g.close(); }

// ---- C1: a token's proof dies with its join ----
{ const s = await sock(srv.port);
  const a = await s.join("garden", "Rowan", { agentToken: "tok-rowan" });
  ok(!!a.snapshot && a.snapshot.you === "Rowan", "(C1 setup) Rowan joins with Rowan's enrolment token", a.errors);
  const b = await s.join("garden", "Wren");   // same socket, no token, another enrolled agent's name
  ok(!b.snapshot, "C1 a second join on the same socket can't wear another agent's name", b.errors);
  s.close(); }
{ const s = await sock(srv.port);   // the review's exploit: an UNenrolled aid1 agent's proof reused to become another name
  const a = await s.join("garden", "x", { agentToken: mint({ kind: "agent", name: "Moth", sub: "agent:moth@home.test" }) });
  const b = await s.join("garden", "Lark");
  ok(!!a.snapshot && !b.snapshot, "C1 a proven aid1 agent can't rejoin on its socket as another (unenrolled) name and keep the proof", [a.snapshot?.you, b.snapshot?.you, b.errors]);
  s.close(); }
{ const s = await sock(srv.port);   // and the other way: a guest socket can't later become an agent without a NEW socket
  await s.join("garden", "drifter");
  const b = await s.join("garden", "Rowan", { agentToken: "tok-rowan" });
  ok(!b.snapshot && /already joined as someone else/.test(b.errors.join(" ")), "C1 a socket's identity is fixed at its first join (reconnect to be someone else)", b.errors);
  s.close(); }

// ---- C2: aid1 agents ----
{ const h = await sock(srv.port); const j = await h.join("garden", "fable", { agentToken: mint({ kind: "human", name: "Fable", sub: "human:discord:77" }) });
  ok(!j.snapshot && /isn't an agent's/.test(j.errors.join(" ")), "C2 a HUMAN's aid1 credential presented as an agent token is refused", j.errors); h.close(); }
{ const a1 = await sock(srv.port); const j1 = await a1.join("garden", "x", { agentToken: mint({ kind: "agent", name: "Wren", sub: "agent:wren@home.test" }) });
  const t1 = await sock(srv.port); const j2 = await t1.join("orchard", "Wren", { agentToken: "tok-wren" });
  ok(j1.snapshot?.you === "Wren", "C2 an aid1 agent whose subject an enrolment lists IS that enrolled agent (named by the enrolment)", [j1.snapshot?.you, j1.errors]);
  const imp = await sock(srv.port); const j3 = await imp.join("garden", "x", { agentToken: mint({ kind: "agent", name: "Wren", sub: "agent:wren@elsewhere.test" }) });
  ok(!j3.snapshot || (j3.snapshot.you !== "Wren" && you(j3) !== you(j1)), "C2 another aid1 agent whose NAME slugs to an enrolled agent's isn't them (reserved, or its own identity)", [j3.snapshot?.you, j3.errors]);
  a1.close(); t1.close(); imp.close(); }
// C2f (security review 10-18 L11): a reserved name is matched FOLDED, as display collisions are: "Wre n" and "wren." are Wren
{ const out = [];
  for (const typed of ["Wre n", "wren.", "WREN", "W r e n"]) { const s = await sock(srv.port); const j = await s.join("orchard", typed, {}); out.push([typed, j.errors, s.closed, !!j.snapshot]); s.close(); }
  ok(out.every(([, errs, closed, got]) => !got && closed === 4004 && errs.some((e) => /reserved agent name/.test(e))), "C2f a reserved agent name folded (spaces, punctuation, case) is refused to anyone without that enrolment's proof", out); }

// ---- H1: names aren't identities ----
{ const ann = await sock(srv.port); const ja = await ann.join("garden", "Ann");   // TRUST_NAMES: local:ann, the founder
  const fake = await sock(srv.port); const jf = await fake.join("garden", "Ann​");   // zero-width trick
  await sleep(200);
  // on a private TRUST_NAMES server a typed name IS the account (local:ann): the zero-width trick folds away, so this is Ann's
  // own session again, replacing her stale one (a reconnect) — same account, same identity
  ok(jf.snapshot?.you === "Ann" && you(jf) === you(ja) && ann.closed === 4002, "H1 'Ann\\u200B' folds to Ann: on a TRUST_NAMES server that's her own account, so it's her reconnect (takeover)", [jf.snapshot?.you, ann.closed]);
  ann.close(); fake.close(); }

const S2 = await start({ TRUST_NAMES: "" });   // the public door: typed names are no account
{ const ann = await sock(S2.port); const ja = await ann.join("garden", "Ann", { agentToken: mint({ kind: "agent", sub: "agent:ann@home.test", name: "Annbot" }) });
  const g = await sock(S2.port); const jg = await g.join("garden", "Annbot");
  await sleep(200);
  ok(ann.closed == null && jg.snapshot && /\(guest\)/.test(jg.snapshot.you) && you(jg) !== you(ja), "H1 a guest typing a present agent's name is a separate guest, shown as one; nobody is kicked", [jg.snapshot?.you, ann.closed]);
  ann.close(); g.close(); }

// ---- H4 / H5 on the public door ----
{ // the founder (local:ann) can't reach the public door; make a world whose owner is an agent account we can prove
  const fo = tool(["found", "meadow", "--owner", "agent:token:rowan"]);
  ok(fo.code === 0, "(H setup) found meadow owned by the Rowan enrolment", fo.out);
  const S3 = await start({ TRUST_NAMES: "", VOICE_TRANSPORT: "sfu" });   // voice on: the voice-moderate gate is tested here
  const own = await sock(S3.port); const jo = await own.join("meadow", "Rowan", { agentToken: "tok-rowan" });
  ok(jo.snapshot?.yourRights?.role === "owner", "(H setup) Rowan owns meadow", jo.snapshot?.yourRights);
  ok((await own.req("set", { id: "@world", component: "default-role", value: { role: "builder" } })).ok, "(H setup) meadow's default role: builder");
  const g = await sock(S3.port); const jg = await g.join("meadow", "drifter");
  ok(jg.snapshot?.yourRights?.role === "visitor" && (await g.req("create", { id: "box1", model: "crate" })).refused?.code === "rights", "H4 a guest is never given the default role: a visitor, and refused a build", jg.snapshot?.yourRights);
  const wren = await sock(S3.port); const jw = await wren.join("meadow", "Wren", { agentToken: "tok-wren" });
  ok(jw.snapshot?.yourRights?.role === "builder", "H4 …while a proven account does get it (builder)", jw.snapshot?.yourRights);
  // …unless the world's owner opts guests in (R 10-06: whether strangers without an account may build is the world's
  // choice; the Commons does). Explicit, default off, and never above the world's default role.
  ok((await own.req("set", { id: "@world", component: "default-role", value: { role: "visitor", guests: "builder" } })).refused?.code === "shape", "H4g guests can't be given more than everyone else (guests ≤ the default role)");
  ok((await own.req("set", { id: "@world", component: "default-role", value: { role: "builder", guests: "builder" } })).ok, "(H4g setup) meadow lets guests build");
  { const g2 = await sock(S3.port); const jg2 = await g2.join("meadow", "drifter2"); await sleep(100);
    const made = await g2.req("create", { id: "guestbox", model: "crate_large_red.glb" });
    ok(jg2.snapshot?.yourRights?.role === "builder" && made.ok, "H4g …and a guest arriving now is a builder, and can build", [jg2.snapshot?.yourRights, made.refused]);
    g2.close(); }
  ok((await own.req("set", { id: "@world", component: "default-role", value: { role: "builder" } })).ok, "(H4g teardown) back to guests-as-visitors");
  { const rb = await own.req("set", { id: "@world", component: "roles:bob", value: { role: "builder" } });
    ok(rb.refused?.code === "shape" && /identity/.test(rb.refused.reason ?? ""), "T1c roles:<key> must be someone the directory knows (roles:bob matched nobody, silently)", rb.refused);
    ok((await own.req("set", { id: "@world", component: `roles:${jw.snapshot.cut.you}`, value: { role: "builder" } })).ok, "T1c …a known person's identity is taken"); }
  // H5: default-role owner refused; a junior owner can't demote the founder; owners can't be banned
  ok((await own.req("set", { id: "@world", component: "default-role", value: { role: "owner" } })).refused?.code === "shape", "H5 default-role can't be owner");
  ok((await own.req("set", { id: "@world", component: `roles:${you(jw)}`, value: { role: "owner" } })).ok, "(H5 setup) Rowan makes Wren an owner");
  const demote = await wren.req("set", { id: "@world", component: `roles:${you(jo)}`, value: { role: "visitor" } });
  ok(demote.refused?.code === "rights" && /longer than you/.test(demote.refused.reason), "H5 the junior owner can't demote the founder", demote.refused);
  ok((await wren.req("ban", { who: you(jo) })).refused?.code === "rights", "H5 an owner can't be banned");
  ok((await own.req("set", { id: "@world", component: `roles:${you(jw)}`, value: { role: "builder" } })).ok, "H5 …but the senior owner can demote the junior one");
  // H4: a door ban removes the guest now, and the guest's reconnect is refused
  const ban = await own.req("ban", { who: you(jg), reason: "test" }); await sleep(300);
  ok(ban.ok && g.closed != null, "H4 a door ban removes the banned guest at once", [ban, g.closed]);
  const again = await sock(S3.port); const ja2 = await again.join("meadow", "someone-new");
  ok(!ja2.snapshot && /banned/.test(ja2.errors.join(" ")), "H4 the banned guest reconnecting as a fresh guest is refused (their connection is named)", ja2.errors);
  // world-bans reads the authority's moderation record (it read v1 state.bans: a world always said "nobody is banned")
  { const k = own.msgs.length; own.raw({ type: "world-bans" }); await sleep(300);
    const t = own.msgs.slice(k).find((m) => m.type === "mod")?.text ?? "";
    ok(/banned from "meadow" \(1\)/.test(t) && /test/.test(t), "world-bans lists the authority's bans (who, and why)", t); }
  // a live drag is presence gated on the AUTHORITY's role for the person's directory identity (it looked up their name).
  // Proven accounts only here: this world now bans every guest from this address (H4 above)
  { const moss = await sock(S3.port); const jm = await moss.join("meadow", "Moss", { agentToken: "tok-moss" });
    await own.req("set", { id: "@world", component: `roles:${you(jm)}`, value: { role: "visitor" } }); await sleep(100);
    const k = own.msgs.length;
    moss.raw({ type: "drag", id: "x", pos: [1, 0, 1] }); wren.raw({ type: "drag", id: "x", pos: [2, 0, 2] }); await sleep(300);
    const drags = own.msgs.slice(k).filter((m) => m.type === "drag").map((m) => m.pos[0]);
    ok(!!jm.snapshot && JSON.stringify(drags) === "[2]", "a visitor's live drag isn't relayed; a builder's is (the authority's role for their identity)", [drags, jm.errors]);
    moss.close(); }
  // muting someone for EVERYONE is the owner's (it read v1 rights by typed name, and a role the v1 table didn't know,
  // `none`, compared undefined < 2 → false: it passed). A listed visitor and an unlisted stranger under default-role
  // none both try; the owner's own mute is the control that the gate is reachable at all.
  { await own.req("set", { id: "@world", component: "default-role", value: { role: "none" } });
    const fern = await sock(S3.port); const jf = await fern.join("meadow", "Fern", { agentToken: "tok-fern" });
    const vis = await sock(S3.port); const jv = await vis.join("meadow", "Moss", { agentToken: "tok-moss" });
    const k = own.msgs.length;
    fern.raw({ type: "voice-moderate", id: "Wren", muted: true }); vis.raw({ type: "voice-moderate", id: "Wren", muted: true }); await sleep(300);
    const byOthers = own.msgs.slice(k).filter((m) => m.type === "voice-moderated").map((m) => m.by);
    own.raw({ type: "voice-moderate", id: "Wren", muted: false }); await sleep(300);
    const all = own.msgs.slice(k).filter((m) => m.type === "voice-moderated").map((m) => m.by);
    ok(jf.snapshot?.yourRights?.role === "none" && jv.snapshot?.yourRights?.role === "visitor" && byOthers.length === 0 && all.length === 1,
      "voice-moderate (mute for everyone) is the owner's alone: a 'none' stranger and a visitor are refused, the owner isn't", [jf.snapshot?.yourRights?.role, jv.snapshot?.yourRights?.role, all]);
    await own.req("set", { id: "@world", component: "default-role", value: { role: "builder" } });
    fern.close(); vis.close(); }
  const elsewhere = await sock(S3.port); const je = await elsewhere.join("garden", "someone-new");
  ok(!!je.snapshot, "H4 …in that world only", je.errors);
  for (const s of [own, wren, again, elsewhere]) s.close(); S3.proc.kill(); }

// ---- RS: roles and moderation at the server (research roles S4; PLAN ghost) ----
{ ok(tool(["found", "heath", "--owner", "agent:token:rowan"]).code === 0, "(RS setup) found heath owned by the Rowan enrolment");
  const S4 = await start({ TRUST_NAMES: "", VOICE_TRANSPORT: "sfu" });
  const own = await sock(S4.port); const jo = await own.join("heath", "Rowan", { agentToken: "tok-rowan" });
  const fern = await sock(S4.port); const jf = await fern.join("heath", "Fern", { agentToken: "tok-fern" });
  const wren = await sock(S4.port); const jw = await wren.join("heath", "Wren", { agentToken: "tok-wren" });
  const moss = await sock(S4.port); const jm = await moss.join("heath", "Moss", { agentToken: "tok-moss" });
  await own.req("set", { id: "@world", component: `roles:${you(jf)}`, value: { role: "moderator" } });
  await own.req("set", { id: "@world", component: `roles:${you(jw)}`, value: { role: "builder" } });
  await own.req("set", { id: "@world", component: "default-role", value: { role: "builder", can: { generate: true } } }); await sleep(300);
  // RS1: your-rights is the authority's {role, rank, permissions}; the v1 rightsOf merge is gone (a Commons-like stranger builds and generates)
  { const r = (sock) => [...sock.msgs].reverse().find((m) => m.type === "your-rights")?.rights;
    const or = jo.snapshot?.yourRights, fr = r(fern), mr = r(moss);
    ok(or?.rank === 255 && or.permissions?.includes("ban") && or.permissions?.includes("fly") && fr?.role === "moderator" && fr.rank === 200 && fr.permissions?.includes("mute")
      && mr?.role === "builder" && mr.permissions?.includes("build") && mr.permissions?.includes("generate") && mr.gen === true && !mr.permissions?.includes("mute"),
      "RS1 your-rights comes from the authority: owner 255 with every permission; moderator 200 with mute; a stranger under default-role {builder, can: {generate}} builds and generates", [or, fr, mr]); }
  // RS2: voice-moderate is the authority's identity-keyed, logged mute; a name nobody present answers to mutes nobody
  { const k = own.msgs.length;
    fern.raw({ type: "voice-moderate", id: "Nobody", muted: true }); await sleep(300);
    const none = fern.msgs.slice(-3).some((m) => m.type === "error" && /nobody here/.test(m.error));
    fern.raw({ type: "voice-moderate", id: "Moss", muted: true, minutes: 30 }); await sleep(400);
    const note = own.msgs.slice(k).find((m) => m.type === "voice-moderated");
    const log = await fern.req("modlog", { who: you(jm) });
    const diag = await (await fetch(`http://127.0.0.1:${S4.port}/relay-diag?world=heath`)).json();
    ok(none && note?.actorId === you(jm) && note.muted === true && log.ok && log.records?.[0]?.verb === "mute" && log.records[0].who === you(jm) && JSON.stringify(log.records[0].channels) === '["voice"]'
      && (diag.moderatorMuted ?? []).includes("Moss"), "RS2 voice-moderate mutes the IDENTITY standing there (logged in the moderator log, applied at the SFU); a name nobody here answers to mutes nobody",
      [none, note, log.records?.[0], diag.moderatorMuted]);
    // …and it survives a reconnect (re-applied on join, keyed on the identity)
    moss.close(); await sleep(2500); const diag1 = await (await fetch(`http://127.0.0.1:${S4.port}/relay-diag?world=heath`)).json();
    const m2 = await sock(S4.port); const jm2 = await m2.join("heath", "Moss", { agentToken: "tok-moss" });   // join() returns at the snapshot: no sweep tick in between
    const diag2 = await (await fetch(`http://127.0.0.1:${S4.port}/relay-diag?world=heath`)).json();
    ok(jm2.snapshot?.yourRights?.muted?.channels?.includes("voice") && !(diag1.moderatorMuted ?? []).includes("Moss") && (diag2.moderatorMuted ?? []).includes("Moss"),
      "RS2 a voice mute survives a reconnect: released from the display id while they're gone, re-applied the moment they join, and the person is told", [jm2.snapshot?.yourRights, diag1.moderatorMuted, diag2.moderatorMuted]);
    // …and asking for a fresh relay leg keeps it (review of #260): the mint resets the id's mute at the SFU, and the
    // sweep applies the sanctions in force to the new leg
    m2.raw({ type: "relay-cred" }); await sleep(2600);   // past a sweep tick (2 s): the sweep alone must not be what's missing
    const gotCred = m2.msgs.some((m) => m.type === "relay-cred");
    const diag3 = await (await fetch(`http://127.0.0.1:${S4.port}/relay-diag?world=heath`)).json();
    ok(gotCred && (diag3.moderatorMuted ?? []).includes("Moss"), "RS2b a muted person who asks for a fresh relay credential is still muted at the SFU", [gotCred, diag3.moderatorMuted]);
    // a builder (no mute permission) can't, and an unmute by the moderator lifts it at the SFU
    wren.raw({ type: "voice-moderate", id: "Moss", muted: false }); await sleep(300);
    const still = (await (await fetch(`http://127.0.0.1:${S4.port}/relay-diag?world=heath`)).json()).moderatorMuted ?? [];
    fern.raw({ type: "voice-moderate", id: "Moss", muted: false }); await sleep(400);
    const after = (await (await fetch(`http://127.0.0.1:${S4.port}/relay-diag?world=heath`)).json()).moderatorMuted ?? [];
    ok(still.includes("Moss") && !after.includes("Moss"), "RS2 a builder's voice-moderate is refused (needs mute); the moderator's unmute lifts it", [still, after]);
    // RS3: a kick bars rejoining until its cooldown ends, then lets them in; the removal says when
    const kk = await fern.req("kick", { who: you(jm2), minutes: 0.03, reason: "cool off" }); await sleep(300);
    const said = m2.msgs.find((m) => m.type === "error" && m.until);
    const m3 = await sock(S4.port); const jm3 = await m3.join("heath", "Moss", { agentToken: "tok-moss" });
    await sleep(2200);
    const m4 = await sock(S4.port); const jm4 = await m4.join("heath", "Moss", { agentToken: "tok-moss" });
    // join() waits 3 s for the snapshot; a loaded host can take longer (the snapshot then arrives late, not never)
    for (let i = 0; i < 100 && !jm4.snapshot && !jm4.errors.length && m4.closed == null; i++) { await sleep(100); jm4.snapshot = m4.msgs.find((m) => m.type === "snapshot"); }
    ok(kk.ok && m2.closed === 4006 && !!said && !jm3.snapshot && /may come back/.test(jm3.errors.join(" ")) && !!jm4.snapshot, "RS3 a kick: removed now (4006, with until), refused while the cooldown runs, admitted after it", [kk, m2.closed, said, jm3.errors, !!jm4.snapshot, jm4.errors]);
    m3.close();
    // RS4 RETIRED (R 10-20: ghost removed). Its setup stays: RS10 reads back the line said here, RS5 uses the rejoin
    await own.req("say", { text: "the secret word is heron" }); await sleep(400);
    const rejoin = await sock(S4.port); const jr = await rejoin.join("heath", "Moss", { agentToken: "tok-moss" }); await sleep(300);
    // RS5: warn reaches its person as a notice; a mute is told to its person and the muted badge set goes to everyone
    const wn = await fern.req("warn", { who: you(jm4), reason: "keep it kind" }); await sleep(300);
    const mt = await fern.req("mute", { who: you(jw), minutes: 10, channels: ["chat"] }); await sleep(2500);
    ok(wn.ok && rejoin.msgs.some((m) => m.type === "warned" && m.reason === "keep it kind") && mt.ok && wren.msgs.some((m) => m.type === "moderated" && m.verb === "mute" && m.you)
      && own.msgs.some((m) => m.type === "mod-state" && m.muted?.[you(jw)]), "RS5 a warning reaches its person; a mute is told to its person and to everyone's badges (mod-state)", [wn.ok, mt.ok]);
    // RS6: access: 'listed' admits only people with a role here; a moderator gets in past max
    await own.req("set", { id: "@world", component: "access", value: { join: "listed" } });
    const st = await sock(S4.port); const js = await st.join("heath", "Stranger", { agentToken: mint({ kind: "agent", name: "Stranger", sub: "agent:stranger@home.test" }) });
    await own.req("set", { id: "@world", component: "access", value: { join: "anyone", max: 1 } });
    const fz = await sock(S4.port); const jfz = await fz.join("heath", "Fern", { agentToken: "tok-fern" });
    const full = await sock(S4.port); const jfull = await full.join("heath", "Other", { agentToken: mint({ kind: "agent", name: "Other", sub: "agent:other@home.test" }) });
    await own.req("delete", { id: "@world", component: "access" });
    // the words (upstream #258's decision 4): a refusal says only that the world isn't open to you, nothing about who is listed
    ok(!js.snapshot && /isn't open to you/.test(js.errors.join(" ")) && !!jfz.snapshot && !jfull.snapshot && /full/.test(jfull.errors.join(" ")),
      "RS6 access: 'listed' refuses someone with no role here; past max a moderator still gets in, a stranger doesn't", [js.errors, !!jfz.snapshot, jfull.errors]);
    for (const x of [st, fz, full, rejoin]) x.close(); }
  // RS7 (review 10-06): erasing is the most senior owner's; a fork can't run in a loop
  { await own.req("set", { id: "@world", component: `roles:${you(jw)}`, value: { role: "owner" } }); await sleep(200);
    const k = wren.msgs.length; wren.raw({ type: "world-reset", name: "heath" }); await sleep(500);
    const junior = wren.msgs.slice(k).find((m) => m.type === "error" || m.type === "world-reset");
    const k2 = own.msgs.length; own.raw({ type: "world-fork", to: "heath-copy" }); await sleep(1500); own.raw({ type: "world-fork", to: "heath-copy2" }); await sleep(1500);
    const forks = own.msgs.slice(k2).filter((m) => m.type === "world-forked" || m.type === "error").map((m) => m.type === "error" ? m.error : `forked ${m.to}`);
    ok(junior?.type === "error" && /most senior/.test(junior.error) && forks[0] === "forked heath-copy" && /copied .* ago/.test(forks[1] ?? ""),
      "RS7 a junior owner can't erase the world (the most senior owner's act); a second copy within a minute is refused", [junior, forks]); }
  // RS8: whisper was removed (R 10-18): the ws message is refused in the registry's words (`removed`) and reaches nobody,
  // held for nobody; the authority's request of that name is refused `removed` too, never as an unknown verb
  { const vy = await sock(S4.port); const jv = await vy.join("heath", "Vole", { agentToken: mint({ kind: "agent", name: "Vole", sub: "agent:vole@home.test" }) });
    const mo = await sock(S4.port); await mo.join("heath", "Fern", { agentToken: "tok-fern" });   // Fern: still a moderator
    const k = vy.msgs.length; vy.raw({ type: "whisper", to: "Fern", text: "why was I muted?" }); await sleep(400);
    const vyRef = vy.msgs.slice(k).find((m) => m.type === "error" && m.about === "whisper");
    const rq = await vy.req("whisper", { to: "Fern", text: "psst" });
    const fernGot = mo.msgs.some((m) => m.type === "whisper" || JSON.stringify(m).includes("why was I muted") || JSON.stringify(m).includes("psst"));
    ok(vyRef?.refused?.code === "removed" && /removed/.test(vyRef?.error ?? "") && rq.ok === false && rq.refused?.code === "removed" && !fernGot,
      "RS8 whisper is removed: the message is refused as `removed` in words, the request of that name likewise, and nothing reaches the person named", [vyRef, rq.refused, fernGot]);
    // RS9 (review 10-07): a visitor can't read the ban list; a guest's kick holds against a fresh guest connection (its ghost half retired 10-20)
    const gv = await sock(S4.port); const jg = await gv.join("heath", "visitor-x");   // a guest (no account on this server)
    const kb = gv.msgs.length; gv.raw({ type: "world-bans" }); await sleep(300);
    const visBans = gv.msgs.slice(kb).find((m) => m.type === "error")?.error ?? "";   // a refusal, not a mod result (review of #260, server I33)
    const kk = await own.req("kick", { who: you(jg), minutes: 0.5 }); await sleep(300);
    const g2 = await sock(S4.port); const jg2 = await g2.join("heath", "visitor-y");
    ok(/moderation power/.test(visBans) && kk.ok && !jg2.snapshot,
      "RS9 the ban list is for moderators; a guest's kick holds against a fresh guest from the same address", [visBans.slice(0, 60), kk.ok, jg2.errors]);
    // RS10 (R 10-18): speech is arrival-only. "the secret word is heron" was said (RS4) before Fern's new leg (mo) and Newt
    // arrived: neither a moderator nor a stranger reads it back, by the history message, the authority's history or the
    // join's window; an owner (Wren, an owner since RS7) joining later reads the master log, and its join counts it
    const hist2 = (c) => new Promise((res) => { const id = `h${Math.random()}`; const k5 = c.msgs.length; c.raw({ type: "history", reqId: id, limit: 300 });
      setTimeout(() => res(c.msgs.slice(k5).find((m) => m.type === "history" && m.reqId === id) ?? null), 500); });
    const nt = await sock(S4.port); const jn = await nt.join("heath", "Newt", { agentToken: mint({ kind: "agent", name: "Newt", sub: "agent:newt@home.test" }) });
    const w2 = await sock(S4.port); const jw2 = await w2.join("heath", "Wren", { agentToken: "tok-wren" });   // a takeover of Wren's leg: a fresh arrival
    const heron = (x) => JSON.stringify(x ?? null).includes("heron");
    const seen10 = { newtWs: heron(await hist2(nt)), newtReq: heron(await nt.req("history", { limit: 200 })), newtJoin: heron(jn.snapshot?.state) || jn.snapshot?.state?.chatTotal !== 0,
      fernWs: heron(await hist2(mo)), fernReq: heron(await mo.req("history", { verbs: ["say"], limit: 200 })),
      ownerWs: heron(await hist2(w2)), ownerReq: heron(await w2.req("history", { verbs: ["say"], limit: 200 })), ownerTotal: jw2.snapshot?.state?.chatTotal, ownerWindow: jw2.snapshot?.state?.recentChat?.length };
    ok(!!jn.snapshot && !!jw2.snapshot && !seen10.newtWs && !seen10.newtReq && !seen10.newtJoin && !seen10.fernWs && !seen10.fernReq && seen10.ownerWs && seen10.ownerReq && seen10.ownerTotal > 0 && seen10.ownerWindow === 0,
      "RS10 speech is arrival-only: a stranger and a moderator who arrived after a say read none of it back (history, the authority's history, the join); an owner arriving later reads the master log", seen10);
    for (const x of [vy, mo, gv, g2, nt, w2]) x.close(); }
  for (const x of [own, fern, wren]) x.close(); S4.proc.kill(); }

// ---- AG (pure): a Discord account's age is its snowflake's timestamp; the gate's policy, case by case ----
{ let A = null; try { A = await import(path.join(ENGINE, "server/accountage.ts")); } catch (e) { A = null; }
  // Discord's own documented example: snowflake 175928847299117063 was made at 1462015105796 ms (2016-04-30 11:18:25.796 UTC)
  const t = A?.accountCreatedAt?.("human:discord:175928847299117063");
  ok(t === 1462015105796 && new Date(t).toISOString() === "2016-04-30T11:18:25.796Z" && A.accountCreatedAt("human:discord:abc") === null
    && A.accountCreatedAt("agent:token:rowan") === null && A.accountCreatedAt("human:discord:") === null,
    "AG1 a Discord account's creation time is its snowflake's (id >> 22) + 1420070400000; anything else has none", [t, A ? Object.keys(A) : "no module"]);
  const now = Date.UTC(2026, 9, 7, 12), DAY = 86400000;
  const flake = (ms) => (BigInt(ms - 1420070400000) << 22n).toString();
  const R = (o) => A?.accountAgeRefusal?.({ world: "moor", minDays: 7, now, anonymous: false, account: null, ...o });
  const young = R({ account: `human:discord:${flake(now - 2 * DAY - 3600_000)}` });
  ok(!!A && /at least 7 days old/.test(young ?? "") && /in 5 days/.test(young ?? "") && R({ account: "human:discord:175928847299117063" }) === null
    && R({ anonymous: true }) === '"moor" is for signed-in people whose account is at least 7 days old' && R({ account: "agent:token:moss" }) === null && R({ account: "aid1:id.test:agent:x@y" }) === null
    && R({ account: `human:discord:${flake(now - DAY)}`, minDays: 0 }) === null && /how old/.test(R({ account: "human:github:5" }) ?? ""),
    "AG2 the policy: a young Discord account is told when it qualifies; an old one passes; a guest is refused; agents are exempt; 0 is off; an account whose age can't be read is refused",
    [young, R({ anonymous: true }), R({ account: "human:github:5" })]); }

// ---- GG / AG (server): a guest's mute and ghost carry by address; minimum account age ----
{ ok(tool(["found", "moor", "--owner", "agent:token:rowan"]).code === 0, "(GG setup) found moor owned by the Rowan enrolment");
  const S5 = await start({ TRUST_NAMES: "", VOICE_TRANSPORT: "sfu" });
  const own = await sock(S5.port); const jo = await own.join("moor", "Rowan", { agentToken: "tok-rowan" });
  const guest = async (n) => { const s = await sock(S5.port); const j = await s.join("moor", n); return [s, j]; };
  const rights = (j) => j.snapshot?.yourRights ?? {};
  // GG1: a guest's chat mute carries to the next guest from the same address, channels kept; a signed-in person is untouched
  { const [g1, j1] = await guest("drifter");
    const m = await own.req("mute", { who: you(j1), minutes: 10, channels: ["chat"], reason: "spam" }); await sleep(200);
    g1.close(); await sleep(300);
    const [g2, j2] = await guest("drifter2");
    const said = await g2.req("say", { text: "still here" });
    const log = await own.req("modlog", { who: you(j2) });
    const moss = await sock(S5.port); const jm = await moss.join("moor", "Moss", { agentToken: "tok-moss" });
    ok(m.ok && !!j2.snapshot && you(j2) !== you(j1) && JSON.stringify(rights(j2).muted?.channels) === '["chat"]' && said.refused?.code === "muted"
      && log.records?.some((r) => r.verb === "mute" && r.who === you(j2) && r.actor === you(jo)) && !rights(jm).muted,
      "GG1 a guest's chat mute holds against the next guest from the same address (channels kept, filed as the moderator's); a signed-in person isn't touched",
      [m.ok, you(j1), you(j2), rights(j2).muted, said.refused?.code, log.records, rights(jm).muted]);
    // GG2: unmuting the carried identity lifts the address record: the next guest is free
    const um = await own.req("unmute", { who: you(j2) }); g2.close(); await sleep(300);
    const [g3, j3] = await guest("drifter3");
    ok(um.ok && !!j3.snapshot && !rights(j3).muted, "GG2 an unmute lifts the address record too: the next guest from it isn't muted", [um, rights(j3)]);
    // GG3, GG4 RETIRED (R 10-20: ghost removed)
    g3.close(); await sleep(300);
    const [g5, j5] = await guest("drifter5");
    // GG5: the voice control's mute (voice-moderate) is a mute like any other: it carries, and its unmute lifts it
    own.raw({ type: "voice-moderate", actorId: you(j5), muted: true, minutes: 5 }); await sleep(400); g5.close(); await sleep(300);
    const [g6, j6] = await guest("drifter6");
    own.raw({ type: "voice-moderate", actorId: you(j6), muted: false }); await sleep(400); g6.close(); await sleep(300);
    const [g7, j7] = await guest("drifter7");
    ok(JSON.stringify(rights(j6).muted?.channels) === '["voice"]' && !rights(j7).muted, "GG5 a voice-control mute carries by address (voice only), and its unmute lifts it", [rights(j6).muted, rights(j7).muted]);
    for (const x of [moss, g7]) x.close(); }
  // AG3-5: minAccountDays at the join
  { const DAY = 86400000; const flake = (ms) => (BigInt(ms - 1420070400000) << 22n).toString();
    const login = async (sub, name) => { const r = await fetch(`http://127.0.0.1:${S5.port}/auth`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: mint({ kind: "human", sub, name }) }) });
      const ck = (r.headers.get("set-cookie") ?? "").split(";")[0]; return ck; };
    const as = async (cookie, name) => { const s = await sock(S5.port, { cookie }); const j = await s.join("moor", name); return [s, j]; };
    const ckYoung = await login(`human:discord:${flake(Date.now() - 2 * DAY - 3600_000)}`, "Sprout");
    const ckMod = await login(`human:discord:${flake(Date.now() - 1 * DAY)}`, "Bud");
    const ckOld = await login("human:discord:175928847299117063", "Oak");
    // Bud is young but a moderator here: their identity comes from a first visit before the rule
    const [b0, jb0] = await as(ckMod, "Bud"); await own.req("set", { id: "@world", component: `roles:${you(jb0)}`, value: { role: "moderator" } }); b0.close(); await sleep(200);
    const set = await own.req("set", { id: "@world", component: "access", value: { join: "anyone", minAccountDays: 7 } });
    const [y, jy] = await as(ckYoung, "Sprout"); const [o, jo2] = await as(ckOld, "Oak");
    ok(set.ok && !!ckYoung && !jy.snapshot && /at least 7 days old/.test(jy.errors.join(" ")) && /in 5 days/.test(jy.errors.join(" ")) && y.closed === 4010 && !!jo2.snapshot,   // 4010: the door's own refusal (server/access.ts), not redialled
      "AG3 minAccountDays: a Discord account younger than the rule is refused and told when it qualifies; an older one comes in", [set.ok, set.refused, jy.errors, y.closed, !!jo2.snapshot, jo2.errors]);
    const [gq, jg] = await guest("passerby");
    const ag = await sock(S5.port); const ja = await ag.join("moor", "Wren", { agentToken: "tok-wren" });
    const [b1, jb1] = await as(ckMod, "Bud");
    ok(!jg.snapshot && /signed-in/.test(jg.errors.join(" ")) && !/how old/.test(jg.errors.join(" ")) && !!ja.snapshot && !!jb1.snapshot,
      "AG4 with minAccountDays a guest is refused like 'signed-in'; an enrolled agent is exempt; a young moderator keeps the bypass", [jg.errors, ja.errors, jb1.errors]);
    const big = await own.req("set", { id: "@world", component: "access", value: { join: "anyone", minAccountDays: 400 } });
    const neg = await own.req("set", { id: "@world", component: "access", value: { join: "anyone", minAccountDays: -1 } });
    const zero = await own.req("set", { id: "@world", component: "access", value: { join: "anyone", minAccountDays: 0 } });
    const [y2, jy2] = await as(ckYoung, "Sprout");
    ok(big.refused?.code === "bounds" && neg.refused?.code === "bounds" && zero.ok && !!jy2.snapshot, "AG5 minAccountDays is 0–365 (0 is off: the young account comes in)", [big.refused, neg.refused, zero.ok, jy2.errors]);
    await own.req("delete", { id: "@world", component: "access" });
    for (const x of [o, gq, ag, b1, y2]) x.close(); }
  own.close(); S5.proc.kill(); }

// ---- one person, one identity on this server (R 10-06: friends, messages, invites need it; per-world ids withdrawn) ----
{ const a = await sock(S2.port); const ja = await a.join("garden", "x", { agentToken: "tok-rowan" });
  const b = await sock(S2.port); const jb = await b.join("orchard", "x", { agentToken: "tok-rowan" });
  ok(you(ja) && you(ja) === you(jb), "ID one account is the same identity in every world on the authority", [you(ja), you(jb)]);
  a.close(); b.close(); }

// ---- HB: presence by identity (pass 2 H-B). Marigold (an aid1 human) leaves; a different account (TRUST_NAMES: a typed
// name is local:<name>) joins wearing her name: no remembered pose (a held whisper was checked here too, until whisper
// was removed, R 10-18) ----
{ const tokR = () => mint({ kind: "agent", name: "Marigold", sub: "agent:marigold@home.test" });   // an aid1 account (an agent: a person signs in by cookie)
  const r1 = await sock(srv.port); const j1 = await r1.join("garden", "x", { agentToken: tokR() });
  const name = j1.snapshot?.you ?? "marigold";
  r1.raw({ type: "pose", pose: { p: [7, 0, -3], yaw: 0.5, speed: 0, clip: "idle" } }); await sleep(250); r1.close(); await sleep(300);
  const other = await sock(srv.port); const jo = await other.join("garden", name);   // TRUST_NAMES: local:<name>, another account
  await sleep(250);
  // since pass 3 (H2) the second account isn't even SHOWN as her: a name another account claimed gets a disambiguator
  // (presence-check PN); what it may never get is hers either way — her remembered pose
  ok(!!j1.snapshot && !!jo.snapshot && you(jo) !== you(j1) && jo.snapshot.you !== name && jo.snapshot.you.startsWith(name), "HB (setup) two accounts asking for one display name: the second is shown with a disambiguator", [you(j1), you(jo), jo.snapshot?.you, name, j1.errors, jo.errors]);
  ok(!jo.snapshot?.restore, "HB a different account wearing an absent person's name doesn't inherit her remembered pose", jo.snapshot?.restore);
  other.close(); await sleep(300);
  const r2 = await sock(srv.port); const j2 = await r2.join("garden", "x", { agentToken: tokR() }); await sleep(250);
  ok(Array.isArray(j2.snapshot?.restore?.p) && j2.snapshot.restore.p[0] === 7, "HB the real Marigold wakes where she stood", j2.snapshot?.restore);
  r2.close(); }

// ---- MA: a pose past the cap is dropped, never relayed or remembered; one message past the cap closes the socket ----
{ const a = await sock(srv.port); await a.join("garden", "Sorrel"); const b = await sock(srv.port); await b.join("garden", "Yarrow");
  const big = { p: [1, 0, 1], yaw: 0, speed: 0, clip: "idle", pose: Object.fromEntries(Array.from({ length: 400 }, (_, i) => [`b${i}`, Array.from({ length: 30 }, () => 0.123456789)])) };
  const k = b.msgs.length;
  a.raw({ type: "pose", pose: big }); await sleep(400);
  const relayed = b.msgs.slice(k).filter((m) => m.type === "frame" && JSON.stringify(m).length > 40_000).length;
  ok(JSON.stringify(big).length > 40_000 && relayed === 0, "MA a pose past 32 KB isn't relayed to anyone", [JSON.stringify(big).length, relayed]);
  a.raw({ type: "pose", pose: { p: [2, 0, 2], yaw: 0, speed: 0, clip: "idle" } }); await sleep(300);
  ok(b.msgs.slice(k).some((m) => m.type === "frame"), "MA …and an ordinary pose still is (the control)", b.msgs.slice(k).map((m) => m.type).slice(0, 8));
  const huge = await sock(srv.port); await huge.join("garden", "Burdock");
  huge.raw({ type: "typing", pad: "x".repeat(3 * 1024 * 1024) }); await sleep(600);
  ok(huge.closed != null, "MA one websocket message past 2 MiB closes the socket (Bun's default took 16 MB)", huge.closed);
  a.close(); b.close(); }

// ---- NM: a name with markup in it is refused at the door (security pass 3, H1's belt-and-braces) ----
// The client shows names as text now (client/lib/markup.js); a name that IS markup is still refused, so no other reader
// of the presence plane (an agent's page, a bot, a future sink) ever has to be careful with one. < > and " — the three
// that open a tag or close an attribute; & and ' stay (Tom & Jerry, O'Brien are names, and escape cleanly).
{ for (const bad of [`<img src=x onerror="alert(1)">`, "Ann<b>", "x>y", `Ro"wan`]) {
    const g = await sock(srv.port); const j = await g.join("garden", bad);
    ok(!j.snapshot && j.errors.some((e) => /name/i.test(e) && /</.test(e)) && !/[{}]/.test(j.errors.join(" ")), `NM a name with markup characters is refused, in words (${JSON.stringify(bad)})`, j.errors);
    g.close(); }
  for (const good of ["Tom & Jerry", "O'Brien", "Zoë 🌙"]) {
    const g = await sock(srv.port); const j = await g.join("garden", good);
    ok(!!j.snapshot, `NM …and an ordinary name with & ' or an emoji still gets in (${JSON.stringify(good)})`, j.errors);
    g.close(); }
  const { nameAtDoor } = await import("../../server/names.ts");
  ok(nameAtDoor("Ann<b>", { typed: true }).refused && nameAtDoor("Ann<b>", { typed: false }).name === "Ann\u2039b\u203A", "NM a name the identity service gave (not typed here) gets look-alikes (\u2039 \u203A) instead of its owner being turned away — never deleted, which could empty it or make a reserved name (upstream #224 review)",
    [nameAtDoor("Ann<b>", { typed: true }), nameAtDoor("Ann<b>", { typed: false })]); }

// ---- M3: the perf beacon keeps no raw address (security pass 3) ----
{ const r = await fetch(`http://127.0.0.1:${srv.port}/perflog`, { method: "POST", headers: { "x-real-ip": "203.0.113.77" }, body: JSON.stringify({ kind: "load", ms: 1234 }) });
  await sleep(100);
  const f = path.join(W, ".perflogs.jsonl"); const txt = fs.existsSync(f) ? fs.readFileSync(f, "utf8") : "";
  const last = txt.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)).at(-1);
  ok(r.ok && last?.ms === 1234, "(M3 setup) the beacon line was written", [r.status, last]);
  ok(!txt.includes("203.0.113.77") && last && !("ip" in last) && /^[0-9a-f]{16,}$/.test(String(last.addr ?? "")), "M3 /perflog stores a hashed address, never the raw IP", last); }

// ---- LC: the world's live state is behind the same door as a join ----
{ const S4 = await start({ JOIN_TOKEN: "door-key" });
  const get = (p, key) => fetch(`http://127.0.0.1:${S4.port}${p}`, { headers: key ? { authorization: `Bearer ${key}` } : {}, signal: AbortSignal.timeout(3000) }).then((r) => r.status).catch(() => -1);
  const noKey = [await get("/worlds"), await get("/geom?world=garden"), await get("/snap?world=garden&follow=x")];
  const withKey = [await get("/worlds", "door-key"), await get("/geom?world=garden", "tok-rowan")];
  ok(noKey.every((c) => c === 401) && withKey.every((c) => c === 200), "LC /worlds, /geom?world and /snap answer 401 without a key a join would take, 200 with the authority key or an agent token", [noKey, withKey]);
  S4.proc.kill(); }

S2.proc.kill(); srv.proc.kill();
console.log(`[identity-check] ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
