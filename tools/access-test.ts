// World access test matrix (docs/DESIGN-world-access.md). Self-contained: a
// scratch issuer, a scratch sequencer wired to it, real HTTP + websockets.
//
//   bun run tools/access-test.ts
//
// Walks: members-only worlds (closing removes non-members at once; they are
// unlisted and every world read answers like a world that does not exist),
// granting someone who is not present (the directory binds the grant to their
// sub), unverified names never matching a member in a closed world, watch-only
// worlds, timed grants (warning, then removal, then the revoke in the log),
// the lockout guards, revoke, the access listing, reset keeping a closed world
// closed, the agent's durable sub, and the daily founding cap.
import { generateKeyPairSync, createPublicKey, sign as cryptoSign, randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// A port nothing listens on right now (bind :0, release), and a nonce the
// server echoes at /version — so every request below provably reaches the
// server THIS run spawned. (A fixed port once reached another session's test
// server: on a shared machine, a free-looking port is not an owned one.)
const PORT = Number(process.env.PORT ?? await new Promise<number>((res, rej) => {
  const s = createServer(); s.once("error", rej);
  s.listen(0, "127.0.0.1", () => { const p = (s.address() as { port: number }).port; s.close(() => res(p)); });
}));
const NONCE = randomUUID();
const HTTP = `http://localhost:${PORT}`;
const WS_URL = `ws://localhost:${PORT}/ws`;
const DOOR = "test-door";

// ---- scratch issuer (same minting as authtest.ts) ----
const pair = generateKeyPairSync("ed25519");
const spki = createPublicKey(pair.privateKey).export({ format: "der", type: "spki" }) as Buffer;
const ISSUER_ID = `ed25519:${spki.subarray(spki.length - 32).toString("base64url")}`;
const ISS = "id.test";
let jtiN = 0;
function mint(over: Record<string, unknown> = {}): string {
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    v: 1, iss: ISS, sub: "human:discord:1", kind: "human", name: "Someone",
    aud: "eidoverse", scopes: ["worlds:join", "worlds:spectate"],
    iat: now, exp: now + 600, jti: `a${jtiN++}`, ...over,
  };
  const seg = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = cryptoSign(null, Buffer.from(`aid1.${seg}`), pair.privateKey);
  return `aid1.${seg}.${sig.toString("base64url")}`;
}

let passed = 0, failed = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(pred: () => boolean, ms = 4000) {
  const t0 = Date.now();
  while (!pred() && Date.now() - t0 < ms) await sleep(25);
  return pred();
}

async function login(sub: string, name: string, scopes?: string[]): Promise<string> {
  const r = await fetch(`${HTTP}/auth`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: mint({ sub, name, ...(scopes ? { scopes } : {}) }) }),
  });
  return /ew_sess=[a-f0-9]{64}/.exec(r.headers.get("set-cookie") ?? "")?.[0] ?? "";
}

type Sock = {
  ws: WebSocket; msgs: any[]; errors: string[]; closedWith: number | null;
  snap(): any; verb(verb: string, args: unknown): void; send(m: unknown): void; close(): void;
};
function open(world: string, joinMsg: Record<string, unknown>, cookie = ""): Promise<Sock> {
  return new Promise((resolve) => {
    const ws = new WebSocket(WS_URL, cookie ? ({ headers: { cookie } } as any) : undefined);
    const s: Sock = {
      ws, msgs: [], errors: [], closedWith: null,
      snap: () => s.msgs.find((m) => m.type === "snapshot"),
      verb: (verb, args) => ws.send(JSON.stringify({ type: "verb", verb, args })),
      send: (m) => ws.send(JSON.stringify(m)),
      close: () => { try { ws.close(); } catch { /* closed */ } },
    };
    ws.onopen = () => ws.send(JSON.stringify({ type: "join", world, ...joinMsg }));
    ws.onmessage = (ev) => {
      const m = JSON.parse(String(ev.data));
      s.msgs.push(m);
      if (m.type === "error") s.errors.push(String(m.error));
    };
    ws.onclose = (ev) => { s.closedWith = ev.code; };
    // resolve once the join is answered either way
    const t0 = Date.now();
    const iv = setInterval(() => {
      if (s.snap() || s.closedWith != null || Date.now() - t0 > 3000) { clearInterval(iv); resolve(s); }
    }, 20);
  });
}
const lastLog = (s: Sock, pred: (e: any) => boolean) => [...s.msgs].reverse().find((m) => m.type === "log" && pred(m.entry))?.entry;
async function ask(s: Sock, verb: string, args: unknown) {
  const n = s.errors.length, m = s.msgs.length;
  s.verb(verb, args);
  await until(() => s.errors.length > n || s.msgs.slice(m).some((x) => x.type === "log" && x.entry?.verb === verb), 2000);
  return s.errors.length > n ? s.errors[s.errors.length - 1]! : null;
}
async function worldsAs(headers: Record<string, string> = {}) {
  const r = await fetch(`${HTTP}/worlds`, { headers });
  return ((await r.json()) as { worlds: any[] }).worlds;
}

// ---- boot scratch sequencer ----
const worldsDir = mkdtempSync(join(tmpdir(), "ew-access-"));
const optDir = mkdtempSync(join(tmpdir(), "access-opt-"));
const scratch = mkdtempSync(join(tmpdir(), "access-tok-"));
const tokensPath = join(scratch, "tokens.json");
writeFileSync(tokensPath, "{}");
const proc = Bun.spawn([process.execPath, "run", join(import.meta.dir, "..", "server", "server.ts")], {
  env: {
    ...process.env, PORT: String(PORT), WORLDS_DIR: worldsDir, OPT_DIR: optDir, JOIN_TOKEN: DOOR,
    // scratch sessions too: the logins below must not write the checkout's .sessions.json
    AGENT_TOKENS_PATH: tokensPath, HN_SESSIONS_FILE: join(scratch, "sessions.json"), HN_ISSUER_KEY: ISSUER_ID, HN_ISS: ISS, HN_REQUIRE_LOGIN: "0",
    ACCESS_SWEEP_MS: "300", FOUND_DAILY_CAP: "2", WORLD_ADMIN: "", VERB_RATE: "500", EIDO_BOOT_NONCE: NONCE,
    RENDERER_TOKEN: "test-renderer-key",
  },
  stdout: "ignore", stderr: "inherit",
});
let ours = false;
for (let i = 0; i < 100 && !ours; i++) {
  try { ours = ((await (await fetch(`${HTTP}/version`)).json()) as { nonce?: string }).nonce === NONCE; } catch { /* not up yet */ }
  if (!ours) await sleep(100);
}
if (!ours) { proc.kill(); console.error(`the server on port ${PORT} is not the one this run spawned (no nonce echo) — refusing to test someone else's`); process.exit(1); }

const W = `acc-${Date.now()}`;
const socks: Sock[] = [];
const keep = (s: Sock) => (socks.push(s), s);
try {
  const alice = await login("human:discord:1001", "Alice");
  const bob = await login("human:discord:1002", "Bob");
  const dave = await login("human:discord:1004", "Dave");
  const eve = await login("human:discord:1005", "Eve");
  const ferroTok = mint({ sub: "agent:ferro@guest", kind: "agent", name: "Ferro", scopes: ["worlds:join"], jti: undefined });
  const ferroJoin = { id: "ferro", agent: true, token: DOOR, agentToken: ferroTok };

  console.log("1. an owned world starts open; agents carry their durable sub");
  const A = keep(await open(W, {}, alice));
  check("alice founds the world and owns it", A.snap()?.yourRights?.role === "owner", JSON.stringify(A.snap()?.yourRights));
  const B = keep(await open(W, {}, bob));
  check("bob walks into an open world", B.snap()?.yourRights?.role === "builder");
  const F = keep(await open(W, ferroJoin));
  check("the agent's snapshot carries its sub from the aid1 credential", F.snap()?.yourSub === "agent:ferro@guest", `yourSub=${F.snap()?.yourSub}`);
  const listed0 = await worldsAs();
  check("an open world is listed for anonymous callers, door 'open'", listed0.some((w) => w.name === W && w.access === "open"));

  console.log("2. closing the world removes everyone who is not a member, at once");
  check("alice closes it", (await ask(A, "grant", { id: "*", role: "none" })) === null);
  await until(() => B.closedWith != null && F.closedWith != null);
  check("bob is removed with 4010", B.closedWith === 4010, `code=${B.closedWith}`);
  check("…and told his access changed", B.errors.some((e) => /access to .* changed/.test(e)), B.errors.join(" | "));
  check("the agent is removed with 4010 too", F.closedWith === 4010, `code=${F.closedWith}`);
  check("alice stays", A.closedWith == null);

  console.log("3. a members-only world is unlisted and invisible to non-members");
  check("not listed for anonymous callers", !(await worldsAs()).some((w) => w.name === W));
  check("not listed for bob", !(await worldsAs({ cookie: bob })).some((w) => w.name === W));
  check("not listed for the agent (bearer)", !(await worldsAs({ authorization: `Bearer ${ferroTok}` })).some((w) => w.name === W));
  const mine = (await worldsAs({ cookie: alice })).find((w) => w.name === W);
  check("listed for alice as members-only, and she may enter", mine?.access === "members" && mine?.you === "enter", JSON.stringify(mine));
  const geomAnon = await fetch(`${HTTP}/geom?world=${W}`);
  check("/geom: 404 'no such world' for anonymous", geomAnon.status === 404 && (await geomAnon.json()).error === "no such world");
  check("/geom: 404 for the agent's bearer", (await fetch(`${HTTP}/geom?world=${W}`, { headers: { authorization: `Bearer ${ferroTok}` } })).status === 404);
  check("/geom: 200 for alice", (await fetch(`${HTTP}/geom?world=${W}`, { headers: { cookie: alice } })).status === 200);
  check("/heightmap: anonymous gets 'no such world' (not 'no terrain')", (await (await fetch(`${HTTP}/heightmap?world=${W}`)).text()) === "no such world");
  check("/heightmap: alice gets the real answer (no terrain)", /no terrain/.test(await (await fetch(`${HTTP}/heightmap?world=${W}`, { headers: { cookie: alice } })).text()));
  check("/snap: 'unknown world' for anonymous", (await (await fetch(`${HTTP}/snap?world=${W}&follow=Alice`)).text()) === "unknown world");
  const B2 = keep(await open(W, {}, bob));
  check("bob's rejoin is refused 4010", B2.closedWith === 4010, `code=${B2.closedWith}`);
  check("…saying only that it isn't open to him", B2.errors.some((e) => e === `"${W}" isn't open to you`), B2.errors.join(" | "));
  const B3 = keep(await open(W, { spectate: true }, bob));
  check("bob may not even watch", B3.closedWith === 4010);

  console.log("4. granting someone who is not here binds the grant to their sub");
  check("alice grants bob (absent) visitor", (await ask(A, "grant", { id: "Bob", role: "visitor" })) === null);
  check("the grant carries bob's sub from the directory", lastLog(A, (e) => e.verb === "grant" && e.args.id === "Bob")?.args?.sub === "human:discord:1002");
  const B4 = keep(await open(W, {}, bob));
  check("bob comes in as a visitor", B4.snap()?.yourRights?.role === "visitor", `code=${B4.closedWith} ${B4.errors.join("|")}`);
  check("alice grants the agent (absent) by name", (await ask(A, "grant", { id: "ferro", role: "visitor" })) === null);
  check("…bound to the agent's sub", lastLog(A, (e) => e.verb === "grant" && e.args.id === "ferro")?.args?.sub === "agent:ferro@guest");
  const F2 = keep(await open(W, ferroJoin));
  check("the agent comes back in", F2.snap()?.yourRights?.role === "visitor", `code=${F2.closedWith}`);

  console.log("5. a name is not a key to a closed world");
  const nMod = A.msgs.length;
  check("alice grants Carol, whom the world has never seen (name-keyed)", (await ask(A, "grant", { id: "Carol", role: "visitor" })) === null);
  check("…no sub to bind yet", !lastLog(A, (e) => e.verb === "grant" && e.args.id === "Carol")?.args?.sub);
  await until(() => A.msgs.slice(nMod).some((m) => m.type === "mod"));
  check("…and alice is told it is by name only", A.msgs.slice(nMod).some((m) => m.type === "mod" && /by name only/.test(m.text)));
  const C1 = keep(await open(W, { id: "Carol", token: DOOR }));
  check("someone typing 'Carol' at the door-key door is refused", C1.closedWith === 4010, `code=${C1.closedWith}`);
  const carol = await login("human:discord:1003", "Carol");   // first sighting: after the grant
  const C2 = keep(await open(W, {}, carol));
  check("a signed-in 'Carol' is not let in by a name-only grant either (display names are self-chosen)", C2.closedWith === 4010, `code=${C2.closedWith}`);
  check("alice revokes and grants Carol again, now that she has signed in", (await ask(A, "grant", { id: "Carol", revoke: true })) === null
    && (await ask(A, "grant", { id: "Carol", role: "visitor" })) === null);
  check("…which binds to Carol's sub", lastLog(A, (e) => e.verb === "grant" && e.args.id === "Carol" && !e.args.revoke)?.args?.sub === "human:discord:1003");
  const C2b = keep(await open(W, {}, carol));
  check("the real Carol comes in", C2b.snap()?.yourRights?.role === "visitor", `code=${C2b.closedWith}`);
  C2b.close();

  console.log("5b. review regressions: identity is per join, revoke touches only its record");
  check("alice grants Dana (never seen, name-keyed)", (await ask(A, "grant", { id: "Dana", role: "visitor" })) === null);
  const FX = keep(await open(`${W}-pub`, ferroJoin));   // the agent founds a public world as itself…
  FX.send({ type: "join", world: W, id: "Dana", token: DOOR });   // …then travels, same socket, typing a member's name
  await until(() => FX.closedWith != null || FX.msgs.filter((m) => m.type === "snapshot").length > 1, 3000);
  check("a credentialed socket re-joining under a typed name is not verified", FX.closedWith === 4010, `code=${FX.closedWith}`);
  const FQ = keep(await open(`${W}-pub`, ferroJoin));
  FQ.send({ type: "join", world: `${W}-pub`, id: "Quentin", token: DOOR });
  await until(() => FQ.msgs.filter((m) => m.type === "snapshot").length > 1 || FQ.closedWith != null, 3000);
  FQ.close();
  check("…nor files its sub under the typed name (grant to absent Quentin stays name-keyed)",
    (await ask(A, "grant", { id: "Quentin", role: "visitor" })) === null && !lastLog(A, (e) => e.verb === "grant" && e.args.id === "Quentin")?.args?.sub);
  check("alice grants lowercase 'zed' while nobody by that name has been seen (name-keyed)", (await ask(A, "grant", { id: "zed", role: "builder" })) === null);
  const zed = await login("human:discord:3001", "Zed");
  check("…then Zed signs in and alice makes 'Zed' an owner", (await ask(A, "grant", { id: "Zed", role: "owner" })) === null);
  check("…Zed's owner grant is bound to him", lastLog(A, (e) => e.verb === "grant" && e.args.id === "Zed")?.args?.sub === "human:discord:3001");
  check("revoking 'zed' writes a revoke of that record only", (await ask(A, "grant", { id: "zed", revoke: true })) === null
    && !lastLog(A, (e) => e.verb === "grant" && e.args.id === "zed" && e.args.revoke)?.args?.sub);
  const Z = keep(await open(W, {}, zed));
  check("…and co-owner Zed still gets in as owner", Z.snap()?.yourRights?.role === "owner", `code=${Z.closedWith}`);
  Z.close();

  console.log("6. watch-only: anyone may watch, only the listed may come in");
  check("alice makes it watch-only", (await ask(A, "grant", { id: "*", role: "spectator" })) === null);
  const D1 = keep(await open(W, {}, dave));
  check("dave (not listed) may not come in embodied", D1.closedWith === 4010 && D1.errors.some((e) => /may watch/.test(e)), D1.errors.join("|"));
  const D2 = keep(await open(W, { spectate: true }, dave));
  check("dave may watch", Boolean(D2.snap()), `code=${D2.closedWith}`);
  const dv = (await worldsAs({ cookie: dave })).find((w) => w.name === W);
  check("listed for dave as watch-only, you: watch", dv?.access === "watch" && dv?.you === "watch", JSON.stringify(dv));
  check("alice closes it again", (await ask(A, "grant", { id: "*", role: "none" })) === null);
  await until(() => D2.closedWith != null);
  check("dave's watching socket is removed", D2.closedWith === 4010, `code=${D2.closedWith}`);

  console.log("7. a timed grant: warned, then removed, and the end is in the log");
  check("alice gives dave three seconds", (await ask(A, "grant", { id: "Dave", role: "visitor", until: Date.now() + 3000 })) === null);
  const D3 = keep(await open(W, {}, dave));
  check("dave comes in", D3.snap()?.yourRights?.role === "visitor" && typeof D3.snap()?.yourRights?.until === "number", JSON.stringify(D3.snap()?.yourRights));
  await until(() => D3.msgs.some((m) => m.type === "notice"), 2000);
  check("dave is warned his access is ending", D3.msgs.some((m) => m.type === "notice" && /ends in/.test(m.text)));
  await until(() => D3.closedWith != null, 6000);
  check("…and removed when it ends (4010)", D3.closedWith === 4010, `code=${D3.closedWith}`);
  check("…told his time ended", D3.errors.some((e) => /time in .* has ended/.test(e)), D3.errors.join("|"));
  check("the expiry is settled into the log as a revoke", Boolean(lastLog(A, (e) => e.verb === "grant" && e.args.id === "Dave" && e.args.revoke && e.args.expired)));
  const D4 = keep(await open(W, {}, dave));
  check("dave's next join is refused", D4.closedWith === 4010);

  console.log("8. the guards");
  check("the wildcard can't expire", /wildcard can't expire/.test((await ask(A, "grant", { id: "*", role: "none", for: "1h" })) ?? ""));
  check("ownership doesn't expire", /ownership doesn't expire/.test((await ask(A, "grant", { id: "Alice", role: "owner", for: "1h" })) ?? ""));
  check("revoke Zed's ownership (a co-owner) is allowed", (await ask(A, "grant", { id: "Zed", revoke: true })) === null);
  check("the last owner of a closed world can't be revoked", /no owner while it's closed/.test((await ask(A, "grant", { id: "Alice", revoke: true })) ?? ""));
  check("…or demoted", /no owner while it's closed/.test((await ask(A, "grant", { id: "Alice", role: "builder" })) ?? ""));
  check("a nonsense duration is refused", /duration like/.test((await ask(A, "grant", { id: "Bob", role: "builder", for: "banana" })) ?? ""));
  check("revoking someone with no grant says so", /no grant here to revoke/.test((await ask(A, "grant", { id: "Nobody", revoke: true })) ?? ""));
  check("a typed 'for 2h' works", (await ask(A, "grant", { id: "Carol", for: "2h" })) === null
    && typeof lastLog(A, (e) => e.verb === "grant" && e.args.id === "Carol")?.args?.until === "number");

  console.log("9. revoke takes someone out");
  check("alice revokes bob", (await ask(A, "grant", { id: "Bob", revoke: true })) === null);
  await until(() => B4.closedWith != null);
  check("bob is removed (4010)", B4.closedWith === 4010, `code=${B4.closedWith}`);

  console.log("9b. Greptile #258 regressions");
  {
    // #1 a revoke by SUBJECT touches only that subject's record, even when the
    // subject's newest name is filed for someone else
    await login("human:discord:6001", "Kit");
    check("alice grants Kit (bound to 6001)", (await ask(A, "grant", { id: "Kit", role: "visitor" })) === null
      && lastLog(A, (e) => e.verb === "grant" && e.args.id === "Kit")?.args?.sub === "human:discord:6001");
    await login("human:discord:6002", "Rowan");
    check("alice grants Rowan (bound to 6002)", (await ask(A, "grant", { id: "Rowan", role: "builder" })) === null
      && lastLog(A, (e) => e.verb === "grant" && e.args.id === "Rowan")?.args?.sub === "human:discord:6002");
    await login("human:discord:6002", "Kit");   // Rowan now goes by Kit too
    check("revoking subject 6002 is accepted", (await ask(A, "grant", { id: "human:discord:6002", revoke: true })) === null);
    const rv = lastLog(A, (e) => e.verb === "grant" && e.args.revoke);
    check("…and revokes ROWAN's record (6002), not Kit's (6001)", rv?.args?.id === "Rowan" && rv?.args?.sub === "human:discord:6002", JSON.stringify(rv?.args));
    // #2 a sign-in with no Eidoverse scope is not an identity for private reads,
    // and a watch-only sign-in is told it may watch, not enter
    const kitNoScope = await login("human:discord:6001", "Kit", ["music:upload"]);
    check("a session without worlds:join/spectate doesn't see the closed world", !(await worldsAs({ cookie: kitNoScope })).some((w) => w.name === W));
    check("…nor read it", (await fetch(`${HTTP}/geom?world=${W}`, { headers: { cookie: kitNoScope } })).status === 404);
    const kitWatch = await login("human:discord:6001", "Kit", ["worlds:spectate"]);
    const acc = await (await fetch(`${HTTP}/access?world=${W}`, { headers: { cookie: kitWatch } })).json() as any;
    check("a watch-only session of a member: /access says watch, not enter", acc.you === "watch", JSON.stringify(acc));
    // #3 an idle closed world with a CORRUPT snapshot still admits its owner and stays hidden
    const IW = `${W}-idle`;
    mkdirSync(join(worldsDir, IW), { recursive: true });
    const t = Date.now();
    writeFileSync(join(worldsDir, IW, "log.jsonl"), [
      { seq: 0, ts: t, actor: "world", verb: "genesis", args: { v: 2, dialect: "eidoverse-log" } },
      { seq: 1, ts: t, actor: "world", verb: "grant", args: { id: "Alice", role: "owner", gen: true, sub: "human:discord:1001" } },
      { seq: 2, ts: t, actor: "Alice", verb: "grant", args: { id: "*", role: "none" } },
    ].map((e) => JSON.stringify(e)).join("\n") + "\n");
    writeFileSync(join(worldsDir, IW, "snapshot.json"), "{ this is not json");
    check("the idle closed world (corrupt snapshot) is hidden from anonymous callers", !(await worldsAs()).some((w) => w.name === IW));
    check("…and listed for its owner", (await worldsAs({ cookie: alice })).some((w) => w.name === IW && w.you === "enter"));
    const AI = keep(await open(IW, {}, alice));
    check("…who gets in", AI.snap()?.yourRights?.role === "owner", `code=${AI.closedWith} ${AI.errors.join("|")}`);
    AI.close();
    // #7 a SUBJECT string is a subject: a visitor whose display name is set to
    // look like someone's subject does not receive that person's grant
    const SW = `${W}-subj`;
    const AS = keep(await open(SW, {}, alice));
    check("alice founds an open world for this", AS.snap()?.yourRights?.role === "owner", `code=${AS.closedWith}`);
    await login("human:discord:8001", "Tamsin");
    const mimic = await login("human:discord:8002", "human:discord:8001");
    const M = keep(await open(SW, {}, mimic));
    check("a visitor named \"human:discord:8001\" is standing here", Boolean(M.snap()), `code=${M.closedWith} ${M.errors.join("|")}`);
    check("alice adds subject human:discord:8001 as builder", (await ask(AS, "grant", { id: "human:discord:8001", role: "builder" })) === null);
    const g7 = lastLog(AS, (e) => e.verb === "grant" && e.args.sub && e.args.role === "builder");
    check("…the grant goes to that subject (Tamsin), not to the namesake", g7?.args?.sub === "human:discord:8001" && g7?.args?.id === "Tamsin", JSON.stringify(g7?.args));
    // #9 a member whose display name mimics another subject: their grant is
    // filed under THEIR subject, so later edits of it can't reach the mimicked
    // person; and the panel data carries subjects to editors only
    const stateOf = async (s: Sock) => {
      const n = s.msgs.length; s.send({ type: "access-state" });
      await until(() => s.msgs.slice(n).some((m) => m.type === "access-state"));
      return s.msgs.slice(n).find((m) => m.type === "access-state");
    };
    check("alice adds the mimic by subject (8002)", (await ask(AS, "grant", { id: "human:discord:8002", role: "visitor" })) === null);
    const g9 = lastLog(AS, (e) => e.verb === "grant" && e.args.sub === "human:discord:8002");
    check("…filed under its own subject, not its subject-shaped name", g9?.args?.id === "human:discord:8002", JSON.stringify(g9?.args));
    const ms = await stateOf(M);
    check("a non-owner's panel data carries no subjects", Array.isArray(ms?.members) && ms.members.length > 0 && !ms.members.some((m: any) => m.sub), JSON.stringify(ms?.members));
    const as = await stateOf(AS);
    check("an owner's panel data carries them", as?.members?.some((m: any) => m.sub === "human:discord:8002"), JSON.stringify(as?.members));
    check("promoting the mimic BY ITS SUBJECT (as the panel does) is accepted", (await ask(AS, "grant", { id: "human:discord:8002", role: "builder" })) === null);
    const after9 = await stateOf(AS);
    const r8001 = after9?.members?.find((m: any) => m.sub === "human:discord:8001"), r8002 = after9?.members?.find((m: any) => m.sub === "human:discord:8002");
    check("…the mimic is builder and Tamsin (8001) is untouched", r8002?.role === "builder" && r8001?.role === "builder" && after9.members.filter((m: any) => m.sub === "human:discord:8002").length === 1, JSON.stringify(after9?.members));
    // #10 a person whose display name is "*": granting and revoking them by
    // subject never touches the wildcard
    await login("human:discord:9001", "*");
    check("alice closes the world, then adds subject 9001 (display name \"*\")",
      (await ask(AS, "grant", { id: "*", role: "none" })) === null && (await ask(AS, "grant", { id: "human:discord:9001", role: "visitor" })) === null);
    check("revoking subject 9001 is accepted", (await ask(AS, "grant", { id: "human:discord:9001", revoke: true })) === null);
    const rv10 = lastLog(AS, (e) => e.verb === "grant" && e.args.revoke);
    check("…and revokes 9001's record, not the wildcard", rv10?.args?.id === "human:discord:9001" && rv10?.args?.sub === "human:discord:9001", JSON.stringify(rv10?.args));
    check("…so the world stays closed", !(await worldsAs()).some((w) => w.name === SW));
    check("alice opens it again for the next check", (await ask(AS, "grant", { id: "*", role: "builder" })) === null);
    // #8 `revoke *` takes the door back to the default (a closed world opens)
    check("alice closes the subject-test world", (await ask(AS, "grant", { id: "*", role: "none" })) === null);
    check("…and revoking * is accepted", (await ask(AS, "grant", { id: "*", revoke: true })) === null);
    check("…which opens it again (anonymous callers see it, door open)", (await worldsAs()).some((w) => w.name === SW && w.access === "open"));
    // #11 an edit by subject keeps the subject's record where it is — it is
    // never merged into a name-only record under the person's newest name
    check("alice grants Kai, never seen, as owner (name-only)", (await ask(AS, "grant", { id: "Kai", role: "owner" })) === null
      && !lastLog(AS, (e) => e.verb === "grant" && e.args.id === "Kai")?.args?.sub);
    const pell = await login("human:discord:6101", "Pell");
    check("alice grants Pell visitor (bound to 6101)", (await ask(AS, "grant", { id: "Pell", role: "visitor" })) === null
      && lastLog(AS, (e) => e.verb === "grant" && e.args.id === "Pell")?.args?.sub === "human:discord:6101");
    const pellAsKai = await login("human:discord:6101", "Kai");   // Pell now goes by Kai
    check("giving Pell an hour BY SUBJECT (as the panel does) is accepted", (await ask(AS, "grant", { id: "human:discord:6101", for: "1h" })) === null);
    const s11 = await stateOf(AS);
    const p11 = s11?.members?.find((m: any) => m.sub === "human:discord:6101"), k11 = s11?.members?.find((m: any) => m.id === "Kai");
    check("…Pell's record stays visitor, now with an end, and is not merged into the name-only owner record",
      p11?.id === "Pell" && p11?.role === "visitor" && typeof p11?.until === "number" && k11?.role === "owner" && !k11?.sub, JSON.stringify(s11?.members));
    // …and binding the name-only "Kai" to the Kai standing here, who already
    // has their own record, is refused rather than merged
    const PK = keep(await open(SW, {}, pellAsKai));
    check("Pell, signed in as Kai, is here (as Pell's visitor grant)", PK.snap()?.yourRights?.role === "visitor", `code=${PK.closedWith} ${JSON.stringify(PK.snap()?.yourRights)}`);
    check("granting \"Kai\" +gen now is refused as ambiguous", /listed by name only, and the Kai standing here already has their own grant/.test((await ask(AS, "grant", { id: "Kai", gen: true })) ?? ""));
    // …but REVOKING the stale name-only record is not ambiguous: only it goes
    check("revoking the name-only \"Kai\" while Pell-as-Kai is here is accepted", (await ask(AS, "grant", { id: "Kai", revoke: true })) === null);
    const s13 = await stateOf(AS);
    check("…it removes only that record; Pell's grant stands", !s13?.members?.some((m: any) => m.id === "Kai") && s13?.members?.some((m: any) => m.sub === "human:discord:6101" && m.role === "visitor"), JSON.stringify(s13?.members));
    PK.close();
    M.close(); AS.close();
  }

  console.log("9c. a world from older history: several records for one subject");
  {
    // A snapshot written before the one-record-per-subject migration can carry
    // duplicates; rightsIn reads them as ambiguous (the wildcard). A grant by
    // subject must not continue one of them (it would resurrect its role).
    const HW = `${W}-hist`;
    mkdirSync(join(worldsDir, HW), { recursive: true });
    const t = Date.now();
    const log = JSON.stringify({ seq: 0, ts: t, actor: "world", verb: "genesis", args: { v: 2, dialect: "eidoverse-log" } }) + "\n";
    writeFileSync(join(worldsDir, HW, "log.jsonl"), log);
    writeFileSync(join(worldsDir, HW, "snapshot.json"), JSON.stringify({ seq: 0, bytes: Buffer.byteLength(log), state: {
      entities: {}, terrain: null, grass: null, sky: null, assets: [], recentChat: [], chatTotal: 0, bans: {},
      roles: {
        Alice: { role: "owner", gen: true, sub: "human:discord:1001" },
        OldMira: { role: "owner", gen: true, sub: "human:discord:6201" },
        Mira: { role: "visitor", sub: "human:discord:6201" },
      } } }));
    const AH = keep(await open(HW, {}, alice));
    check("alice enters the historical world as its owner", AH.snap()?.yourRights?.role === "owner", `code=${AH.closedWith} ${AH.errors.join("|")}`);
    check("a grant by subject to a subject with two records is refused", /more than one grant here from older history/.test((await ask(AH, "grant", { id: "human:discord:6201", fly: true })) ?? ""));
    check("…a revoke by subject clears them all", (await ask(AH, "grant", { id: "human:discord:6201", revoke: true })) === null);
    check("…after which a fresh grant works", (await ask(AH, "grant", { id: "human:discord:6201", role: "visitor", fly: true })) === null);
    const hs = await new Promise<any>(async (res) => { const n = AH.msgs.length; AH.send({ type: "access-state" }); await until(() => AH.msgs.slice(n).some((m) => m.type === "access-state")); res(AH.msgs.slice(n).find((m) => m.type === "access-state")); });
    const mira = hs?.members?.filter((m: any) => m.sub === "human:discord:6201");
    check("…one record, a visitor with fly — no resurrected owner", mira?.length === 1 && mira[0].role === "visitor" && mira[0].fly === true, JSON.stringify(hs?.members));
    AH.close();
  }

  console.log("10. who can come in — the listing");
  const n0 = A.msgs.length;
  A.send({ type: "world-access" });
  await until(() => A.msgs.slice(n0).some((m) => m.type === "mod"));
  const listing = A.msgs.slice(n0).find((m) => m.type === "mod")?.text ?? "";
  check("names the door: members only", /members only/.test(listing), listing);
  check("lists Carol with her time left", /Carol — visitor \(\d+ h left\)/.test(listing), listing);
  check("does not list the expired or revoked", !/Dave|Bob/.test(listing), listing);

  console.log("11. erasing a closed world keeps it closed");
  A.send({ type: "world-reset", name: W });
  await until(() => A.msgs.some((m) => m.type === "world-reset"));
  await sleep(300);
  check("still unlisted for anonymous callers after the reset", !(await worldsAs()).some((w) => w.name === W));
  const C3 = keep(await open(W, {}, carol));
  check("Carol is still a member after the reset", Boolean(C3.snap()), `code=${C3.closedWith}`);
  const B5 = keep(await open(W, {}, bob));
  check("bob is still out", B5.closedWith === 4010);

  console.log("11b. renderers are the agents' vision: trusted by their own credential, everywhere");
  {
    const RKEY = "test-renderer-key";
    const fake = keep(await open(W, { id: "fake-renderer", renderer: true, token: DOOR }));
    check("a client merely SAYING renderer (door key) may not watch the closed world", fake.closedWith === 4010, `code=${fake.closedWith}`);
    const sneaky = keep(await open(W, { id: "sneaky", token: RKEY }));
    check("the renderers' credential without the renderer flag opens no door", sneaky.closedWith === 4003, `code=${sneaky.closedWith}`);
    const real = keep(await open(W, { id: "mac-renderer", renderer: true, token: RKEY }));
    check("a renderer holding the renderers' credential watches the closed world", Boolean(real.snap()), `code=${real.closedWith} ${real.errors.join("|")}`);
    check("alice opens and closes the world again", (await ask(A, "grant", { id: "*", role: "builder" })) === null && (await ask(A, "grant", { id: "*", role: "none" })) === null);
    await sleep(400);
    check("…and the trusted renderer is not removed by the closing", real.closedWith == null, `code=${real.closedWith}`);
    real.close(); await sleep(300);
    // roamers: the dispatcher sends only one the destination will let in
    const LOBBY = `${W}-lobby`;
    keep(await open(LOBBY, { id: "lobbykeeper", token: DOOR }));
    const plainRoamer = keep(await open(LOBBY, { id: "roam-plain", renderer: true, roam: true, token: DOOR }));
    check("a plain roamer waits in an open lobby", Boolean(plainRoamer.snap()), `code=${plainRoamer.closedWith}`);
    const r1 = await fetch(`${HTTP}/snap?world=${W}&follow=Alice`, { headers: { cookie: alice } });
    const t1 = await r1.text();
    check("a member's snapshot of the closed world, with only a plain roamer free: 503, saying why", r1.status === 503 && /no roaming renderer holding the renderers' credential/.test(t1), `${r1.status} ${t1}`);
    check("…and the plain roamer was NOT sent there (it would have been refused and gone dead)", !plainRoamer.msgs.some((m) => m.type === "renderer-travel") && plainRoamer.closedWith == null);
    const trustedRoamer = keep(await open(LOBBY, { id: "roam-trusted", renderer: true, roam: true, token: RKEY }));
    check("a trusted roamer waits in the lobby too", Boolean(trustedRoamer.snap()), `code=${trustedRoamer.closedWith}`);
    const ac = new AbortController();
    const pendingSnap = fetch(`${HTTP}/snap?world=${W}&follow=Alice`, { headers: { cookie: alice }, signal: ac.signal }).catch(() => null);
    await until(() => trustedRoamer.msgs.some((m) => m.type === "renderer-travel"), 3000);
    check("a member's snapshot summons the TRUSTED roamer into the closed world", trustedRoamer.msgs.some((m) => m.type === "renderer-travel" && m.world === W));
    check("…and still never the plain one", !plainRoamer.msgs.some((m) => m.type === "renderer-travel"));
    ac.abort(); await pendingSnap;
    plainRoamer.close(); trustedRoamer.close();
    await sleep(300);
    // a WATCH-ONLY world admits ordinary renderers, so its no-renderer answer
    // must not claim it is members-only (Greptile #259). (Another world: the
    // summons above is still in flight for this one, by design, for travelMs.)
    const SW2 = keep(await open(`${W}-subj`, {}, alice));
    check("alice makes her other world watch-only", Boolean(SW2.snap()) && (await ask(SW2, "grant", { id: "*", role: "spectator" })) === null, `code=${SW2.closedWith}`);
    const r3 = await fetch(`${HTTP}/snap?world=${W}-subj&follow=Alice`, { headers: { cookie: alice } });
    const t3 = await r3.text();
    check("…with no roamer free, the answer is the ordinary one, not \"members-only\"", r3.status === 503 && !/members-only/.test(t3) && /no renderer is currently serving/.test(t3), `${r3.status} ${t3}`);
    SW2.close();
  }

  console.log("12. founding: every member may, a few per day");
  const E1 = keep(await open(`${W}-e1`, {}, eve));
  const E2 = keep(await open(`${W}-e2`, {}, eve));
  check("eve founds two worlds", E1.snap()?.yourRights?.role === "owner" && E2.snap()?.yourRights?.role === "owner");
  const E3 = keep(await open(`${W}-e3`, {}, eve));
  check("the third in a day is refused (cap 2)", E3.closedWith === 4010 && E3.errors.some((e) => /limit/.test(e)), E3.errors.join("|"));
  const ghost = await fetch(`${HTTP}/geom?world=${W}-e3`);
  check("…and leaves no world behind", ghost.status === 404);
  const S1 = keep(await open(`${W}-nowhere`, { spectate: true }, dave));
  check("watching a world that doesn't exist founds nothing (4011: retry later)", S1.closedWith === 4011 && (await fetch(`${HTTP}/geom?world=${W}-nowhere`)).status === 404, `code=${S1.closedWith}`);
  const T1 = keep(await open(`${W}-typed`, { id: "Tess", token: DOOR }));
  check("a typed-name joiner founds and owns a world", T1.snap()?.yourRights?.role === "owner", `code=${T1.closedWith}`);
  check("…but may not close it: it would shut her out", /shut you out.*sign in first/.test((await ask(T1, "grant", { id: "*", role: "none" })) ?? ""));
  const E4 = keep(await open(`${W}-e1`, {}, eve));
  check("returning to a world she made is not founding", E4.snap()?.yourRights?.role === "owner", `code=${E4.closedWith}`);
} finally {
  for (const s of socks) s.close();
  proc.kill();
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
