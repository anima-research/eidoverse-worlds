// tools/v4/identity-check.ts — who a joiner is, against a real sequencer (security review 2026-10-06). Scratch port,
// scratch WORLDS_DIR, its own tokens.json and a test aid1 issuer; never 8968/8970. usage: bun tools/v4/identity-check.ts
//   C1  a credential proven on one join never carries to a second join on the same socket
//   C2  an aid1 credential is an agent only if its kind says agent; an enrolment's listed aid1 subject is that agent
//   C3  WORLD_ADMIN naming a bare display name refuses to boot
//   H1  typing someone's name doesn't kick them, take over their session, or show as them; a guest is named a guest
//   H3  a world name nobody founded is refused, and nothing appears on disk
//   H4  a guest is never given the world's default role; a door ban removes the person now; a guest's ban names the
//       connection, so reconnecting as a fresh guest is refused
//   H5  an owner can't demote the founder; default-role can't be owner; an owner can't be banned
//   ID  one account is the same identity in every world on the door (per-world ids, review M6, withdrawn: R 10-06)
//   RS  roles and moderation at the server (research roles S4): your-rights from the door, voice-moderate as the door's
//       identity-keyed logged mute (surviving a reconnect), a kick's cooldown at join, ghost hidden server-side, warn and
//       mute notices, access (listed / max with the moderator bypass)
// @ts-nocheck
import fs from "node:fs";
import path from "node:path";
import { generateKeyPairSync, sign as cryptoSign } from "node:crypto";
import { ENGINE, scratch } from "./common.ts";

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
  BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0", JOIN_TOKEN: "", WORLD_ADMIN: "", AGENT_TOKENS_PATH: TOK, HN_ISSUER_KEY: ISSUER, HN_ISS: "id.test", TRUST_NAMES: "1", ...extra });
const tool = (args) => { const r = Bun.spawnSync(["bun", "tools/v4/world.ts", ...args], { cwd: ENGINE, env: env() }); return { code: r.exitCode, out: r.stdout.toString() + r.stderr.toString() }; };
async function start(extra = {}) {
  let port = 9310; for (; port < 9400; port++) { try { const s = Bun.listen({ hostname: "127.0.0.1", port, socket: { data() {} } }); s.stop(true); break; } catch {} }
  const logf = path.join(root, `srv-${port}.log`);
  const p = Bun.spawn(["bun", "server/server.ts"], { cwd: ENGINE, env: env({ PORT: String(port), ...extra }), stdout: Bun.file(logf), stderr: Bun.file(logf + ".err") });
  for (let i = 0; i < 80; i++) { await sleep(150); if (p.exitCode != null) return { port, proc: p, dead: true, log: logf };
    try { if ((await fetch(`http://127.0.0.1:${port}/worlds`, { signal: AbortSignal.timeout(800) })).ok) return { port, proc: p, log: logf }; } catch {} }
  return { port, proc: p, dead: true, log: logf };
}
/** A socket that can join more than once (C1 needs two joins on ONE socket). */
async function sock(port) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`); const msgs = []; let n = 0; const waiters = new Map();
  ws.onmessage = (ev) => { const m = JSON.parse(String(ev.data)); msgs.push(m); if (m.type === "v4-result") waiters.get(m.id)?.(m.reply); };
  let closed = null; ws.onclose = (e) => { closed = e.code; };
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  const s = {
    msgs, get closed() { return closed; },
    async join(world, id, extra = {}) { const k = msgs.length; ws.send(JSON.stringify({ type: "join", world, id, avatar: "", v4fold: true, ...extra }));
      for (let i = 0; i < 60; i++) { if (msgs.slice(k).some((m) => m.type === "snapshot" || m.type === "error") || closed != null) break; await sleep(50); }
      await sleep(50); return { snapshot: msgs.slice(k).find((m) => m.type === "snapshot"), errors: msgs.slice(k).filter((m) => m.type === "error").map((m) => m.error) }; },
    req: (tool, args = {}) => new Promise((res) => { const id = `r${++n}`; waiters.set(id, res); ws.send(JSON.stringify({ type: "v4", id, tool, args })); setTimeout(() => res({ ok: false, timeout: true }), 4000); }),
    raw: (m) => ws.send(JSON.stringify(m)),
    close: () => ws.close(),
  };
  return s;
}
const you = (j) => j.snapshot?.v4?.you;

// ---- C3: a bare name in WORLD_ADMIN refuses to boot (accounts only) ----
{ const s = await start({ WORLD_ADMIN: "Riannon" });
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

// ---- H1: names aren't identities ----
{ const ann = await sock(srv.port); const ja = await ann.join("garden", "Ann");   // TRUST_NAMES: local:ann, the founder
  const fake = await sock(srv.port); const jf = await fake.join("garden", "Ann​");   // zero-width trick
  await sleep(200);
  // on a private TRUST_NAMES door a typed name IS the account (local:ann): the zero-width trick folds away, so this is Ann's
  // own session again, replacing her stale one (a reconnect) — same account, same identity
  ok(jf.snapshot?.you === "Ann" && you(jf) === you(ja) && ann.closed === 4002, "H1 'Ann\\u200B' folds to Ann: on a TRUST_NAMES door that's her own account, so it's her reconnect (takeover)", [jf.snapshot?.you, ann.closed]);
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
    ok((await own.req("set", { id: "@world", component: `roles:${jw.snapshot.v4.you}`, value: { role: "builder" } })).ok, "T1c …a known person's identity is taken"); }
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
  // world-bans reads the door's moderation record (it read v1 state.bans: a v4 world always said "nobody is banned")
  { const k = own.msgs.length; own.raw({ type: "world-bans" }); await sleep(300);
    const t = own.msgs.slice(k).find((m) => m.type === "mod")?.text ?? "";
    ok(/banned from "meadow" \(1\)/.test(t) && /test/.test(t), "world-bans lists the door's bans (who, and why)", t); }
  // a live drag is presence gated on the DOOR's role for the person's directory identity (it looked up their name).
  // Proven accounts only here: this world now bans every guest from this address (H4 above)
  { const moss = await sock(S3.port); const jm = await moss.join("meadow", "Moss", { agentToken: "tok-moss" });
    await own.req("set", { id: "@world", component: `roles:${you(jm)}`, value: { role: "visitor" } }); await sleep(100);
    const k = own.msgs.length;
    moss.raw({ type: "drag", id: "x", pos: [1, 0, 1] }); wren.raw({ type: "drag", id: "x", pos: [2, 0, 2] }); await sleep(300);
    const drags = own.msgs.slice(k).filter((m) => m.type === "drag").map((m) => m.pos[0]);
    ok(!!jm.snapshot && JSON.stringify(drags) === "[2]", "a visitor's live drag isn't relayed; a builder's is (the door's role for their identity)", [drags, jm.errors]);
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
  await own.req("set", { id: "@world", component: "default-role", value: { role: "builder", gen: true } }); await sleep(300);
  // RS1: your-rights is the door's {role, rank, switches}; the v1 rightsOf merge is gone (a Commons-like stranger builds and generates)
  { const r = (sock) => [...sock.msgs].reverse().find((m) => m.type === "your-rights")?.rights;
    const or = jo.snapshot?.yourRights, fr = r(fern), mr = r(moss);
    ok(or?.rank === 255 && or.switches?.includes("ban") && or.switches?.includes("fly") && fr?.role === "moderator" && fr.rank === 200 && fr.switches?.includes("mute")
      && mr?.role === "builder" && mr.switches?.includes("build") && mr.switches?.includes("generate") && mr.gen === true && !mr.switches?.includes("mute"),
      "RS1 your-rights comes from the door: owner 255 with every switch; moderator 200 with mute; a stranger under default-role {builder, gen} builds and generates", [or, fr, mr]); }
  // RS2: voice-moderate is the door's identity-keyed, logged mute; a name nobody present answers to mutes nobody
  { const k = own.msgs.length;
    fern.raw({ type: "voice-moderate", id: "Nobody", muted: true }); await sleep(300);
    const none = fern.msgs.slice(-3).some((m) => m.type === "error" && /nobody here/.test(m.error));
    fern.raw({ type: "voice-moderate", id: "Moss", muted: true, minutes: 30 }); await sleep(400);
    const note = own.msgs.slice(k).find((m) => m.type === "voice-moderated");
    const log = await fern.req("modlog", { who: you(jm) });
    const diag = await (await fetch(`http://127.0.0.1:${S4.port}/relay-diag?world=heath`)).json();
    ok(none && note?.v4id === you(jm) && note.muted === true && log.ok && log.records?.[0]?.verb === "mute" && log.records[0].who === you(jm) && JSON.stringify(log.records[0].channels) === '["voice"]'
      && (diag.moderatorMuted ?? []).includes("Moss"), "RS2 voice-moderate mutes the IDENTITY standing there (logged in the moderator log, applied at the SFU); a name nobody here answers to mutes nobody",
      [none, note, log.records?.[0], diag.moderatorMuted]);
    // …and it survives a reconnect (re-applied on join, keyed on the identity)
    moss.close(); await sleep(2500); const diag1 = await (await fetch(`http://127.0.0.1:${S4.port}/relay-diag?world=heath`)).json();
    const m2 = await sock(S4.port); const jm2 = await m2.join("heath", "Moss", { agentToken: "tok-moss" });   // join() returns at the snapshot: no sweep tick in between
    const diag2 = await (await fetch(`http://127.0.0.1:${S4.port}/relay-diag?world=heath`)).json();
    ok(jm2.snapshot?.yourRights?.muted?.channels?.includes("voice") && !(diag1.moderatorMuted ?? []).includes("Moss") && (diag2.moderatorMuted ?? []).includes("Moss"),
      "RS2 a voice mute survives a reconnect: released from the display id while they're gone, re-applied the moment they join, and the person is told", [jm2.snapshot?.yourRights, diag1.moderatorMuted, diag2.moderatorMuted]);
    // a builder (no mute switch) can't, and an unmute by the moderator lifts it at the SFU
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
    ok(kk.ok && m2.closed === 4006 && !!said && !jm3.snapshot && /may come back/.test(jm3.errors.join(" ")) && !!jm4.snapshot, "RS3 a kick: removed now (4006, with until), refused while the cooldown runs, admitted after it", [kk, m2.closed, said, jm3.errors, !!jm4.snapshot]);
    m3.close();
    // RS4: ghost: unseen by others (leave, no frames), no chat (says arrive emptied), and back (arrive) when lifted
    const gk = own.msgs.length;
    const gh = await fern.req("ghost", { who: you(jm4), minutes: 5, reason: "trolling" }); await sleep(500);
    const left = own.msgs.slice(gk).some((m) => m.type === "leave" && m.id === "Moss");
    m4.raw({ type: "pose", pose: { p: [1, 0, 1], r: 0 } }); await sleep(400);
    const framed = own.msgs.slice(gk).some((m) => m.type === "frame" && m.poses && "Moss" in m.poses);
    await own.req("say", { text: "the secret word is heron" }); await sleep(400);
    const heard = m4.msgs.filter((m) => m.type === "v4-log").flatMap((m) => m.entries).filter((e) => e?.kind === "say");
    const leak = JSON.stringify(heard).includes("heron");
    const mSay = await m4.req("say", { text: "boo" });
    const rejoin = await sock(S4.port); const jr = await rejoin.join("heath", "Moss", { agentToken: "tok-moss" }); await sleep(300);   // a takeover: the same ghost, fresh snapshot
    const window = JSON.stringify(jr.snapshot?.state?.recentChat ?? []);
    const seen = (jo2) => (jo2.snapshot?.present ?? []).some((x) => x.id === "Moss");
    const late = await sock(S4.port); const jl = await late.join("heath", "Late", { agentToken: mint({ kind: "agent", name: "Late", sub: "agent:late@home.test" }) });
    ok(gh.ok && left && !framed && heard.length >= 1 && !leak && mSay.refused?.code === "ghost" && !window.includes("heron") && jr.snapshot?.yourRights?.ghost && !seen(jl),
      "RS4 a ghost is hidden server-side: others get leave and no frames, a late joiner doesn't list them; their log has says emptied, their chat window is empty, and they can't talk", [gh.ok, left, framed, heard.length, leak, mSay.refused?.code, window.slice(0, 80), jr.snapshot?.yourRights?.ghost, seen(jl)]);
    const bk = own.msgs.length; const ug = await fern.req("unghost", { who: you(jm4) }); await sleep(2500);
    ok(ug.ok && own.msgs.slice(bk).some((m) => m.type === "arrive" && m.id === "Moss"), "RS4 …and unghosting brings them back (arrive)", [ug, own.msgs.slice(bk).map((m) => m.type)]);
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
    ok(!js.snapshot && /only people with a role/.test(js.errors.join(" ")) && !!jfz.snapshot && !jfull.snapshot && /full/.test(jfull.errors.join(" ")),
      "RS6 access: 'listed' refuses someone with no role here; past max a moderator still gets in, a stranger doesn't", [js.errors, !!jfz.snapshot, jfull.errors]);
    for (const x of [st, fz, full, rejoin, late]) x.close(); }
  for (const x of [own, fern, wren]) x.close(); S4.proc.kill(); }

// ---- one person, one identity on this door (R 10-06: friends, messages, invites need it; per-world ids withdrawn) ----
{ const a = await sock(S2.port); const ja = await a.join("garden", "x", { agentToken: "tok-rowan" });
  const b = await sock(S2.port); const jb = await b.join("orchard", "x", { agentToken: "tok-rowan" });
  ok(you(ja) && you(ja) === you(jb), "ID one account is the same identity in every world on the door", [you(ja), you(jb)]);
  a.close(); b.close(); }

S2.proc.kill(); srv.proc.kill();
console.log(`[identity-check] ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
