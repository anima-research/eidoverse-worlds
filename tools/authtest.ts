// archipelago-home door test matrix (home-node.md §7). Self-contained: mints
// its own scratch issuer keypair, boots a scratch sequencer wired to it, and
// walks both doors over real HTTP + websockets.
//
//   bun run tools/authtest.ts
//
// Token minting here is a deliberate re-implementation of archipelago-home's
// mintToken (10 lines) so this repo tests its OWN verifier copy against
// independently-produced bytes — format drift between the repos shows up as
// failures here, not in production.
import { generateKeyPairSync, createPublicKey, sign as cryptoSign } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyToken } from "../server/aid1.ts";

const PORT = Number(process.env.PORT ?? 8992);
const HTTP = `http://localhost:${PORT}`;
const WS_URL = `ws://localhost:${PORT}/ws`;
const DOOR = "test-door";

// ---- scratch issuer ----
const pair = generateKeyPairSync("ed25519");
const spki = createPublicKey(pair.privateKey).export({ format: "der", type: "spki" }) as Buffer;
const ISSUER_ID = `ed25519:${spki.subarray(spki.length - 32).toString("base64url")}`;
const ISS = "id.test";

let jtiN = 0;
function mint(over: Record<string, unknown> = {}): string {
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    v: 1, iss: ISS, sub: "human:discord:1230001", kind: "human", name: "Guest One",
    aud: "eidoverse", scopes: ["worlds:join", "worlds:spectate"],
    iat: now, exp: now + 600, jti: `t${jtiN++}`, ...over,
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

async function auth(token: string): Promise<{ status: number; cookie: string; body: any }> {
  const r = await fetch(`${HTTP}/auth`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token }),
  });
  const cookie = /ew_sess=[a-f0-9]{64}/.exec(r.headers.get("set-cookie") ?? "")?.[0] ?? "";
  return { status: r.status, cookie, body: await r.json().catch(() => ({})) };
}

type Sock = { ws: WebSocket; msgs: any[]; errors: string[]; closedWith: number | null };
function open(joinMsg: Record<string, unknown>, cookie = ""): Promise<Sock> {
  return new Promise((resolve) => {
    const ws = new WebSocket(WS_URL, cookie ? ({ headers: { cookie } } as any) : undefined);
    const s: Sock = { ws, msgs: [], errors: [], closedWith: null };
    ws.onopen = () => ws.send(JSON.stringify({ type: "join", world: "authtest", ...joinMsg }));
    ws.onmessage = (ev) => {
      const m = JSON.parse(String(ev.data));
      s.msgs.push(m);
      if (m.type === "error") s.errors.push(m.error);
    };
    ws.onclose = (ev) => { s.closedWith = ev.code; };
    setTimeout(() => resolve(s), 700);
  });
}
const snap = (s: Sock) => s.msgs.find((m) => m.type === "snapshot");

// ---- boot scratch sequencer ----
const worldsDir = mkdtempSync(join(tmpdir(), "ew-authtest-"));
// process.execPath, not "bun": the PATH "bun" is an npm .cmd shim on Windows
// whose pid dies immediately, orphaning the real sequencer on this port where
// it poisons the next run.
const proc = Bun.spawn([process.execPath, "run", join(import.meta.dir, "..", "server", "server.ts")], {
  env: {
    ...process.env, PORT: String(PORT), WORLDS_DIR: worldsDir, JOIN_TOKEN: DOOR,
    HN_ISSUER_KEY: ISSUER_ID, HN_ISS: ISS, HN_REQUIRE_LOGIN: "0",
  },
  stdout: "ignore", stderr: "inherit",
});
for (let i = 0; i < 50; i++) {
  try { await fetch(`${HTTP}/authcfg`); break; } catch { await Bun.sleep(100); }
}

try {
  // ---- HTTP door ----
  const cfg = await (await fetch(`${HTTP}/authcfg`)).json();
  check("authcfg advertises login url", typeof cfg.login === "string" && cfg.login.includes("id.test"));

  check("garbage token → 403", (await auth("aid1.not.real")).status === 403);
  check("expired token → 403", (await auth(mint({ exp: Math.floor(Date.now() / 1000) - 5 }))).status === 403);
  check("wrong-audience token → 403", (await auth(mint({ aud: "orrery" }))).status === 403);

  const tok = mint();
  const a1 = await auth(tok);
  check("good token → session cookie", a1.status === 200 && a1.cookie.length > 0 && a1.body.name === "Guest One");
  check("token replay → 403 (jti)", (await auth(tok)).status === 403);

  const who = await fetch(`${HTTP}/whoami`, { headers: { cookie: a1.cookie } });
  const whoBody = await who.json();
  check("whoami sees the session", who.status === 200 && whoBody.sub === "human:discord:1230001");
  check("whoami without cookie → 401", (await fetch(`${HTTP}/whoami`)).status === 401);

  // ---- WS door ----
  const s1 = await open({ id: "impostor-name" }, a1.cookie);
  check("session join: no door key needed", Boolean(snap(s1)));
  check("session OWNS the id (msg.id ignored)", snap(s1)?.you === "Guest One", `you=${snap(s1)?.you}`);

  const s2 = await open({ id: "x" });
  check("no session, no key → rejected 4003", s2.closedWith === 4003);

  const s3 = await open({ id: "keyed-guest", token: DOOR });
  check("door key still works (legacy door)", snap(s3)?.you === "keyed-guest");

  const spectTok = await auth(mint({ sub: "human:discord:1230002", name: "Watcher", scopes: ["worlds:spectate"] }));
  const s4 = await open({}, spectTok.cookie);
  check("spectate-only scope: embodied join refused", s4.closedWith === 4003, `code=${s4.closedWith}`);
  const spectTok2 = await auth(mint({ sub: "human:discord:1230002", name: "Watcher", scopes: ["worlds:spectate"] }));
  const s5 = await open({ spectate: true }, spectTok2.cookie);
  check("spectate-only scope: spectating works", Boolean(snap(s5)));

  const twinA = await auth(mint({ sub: "human:discord:5550001", name: "Twin" }));
  const twinB = await auth(mint({ sub: "human:discord:5550002", name: "Twin" }));
  const t1 = await open({}, twinA.cookie);
  const t2 = await open({}, twinB.cookie);
  check("same nick, different person → suffixed, no takeover",
    snap(t2)?.you === "Twin-0002" && t1.closedWith === null,
    `you=${snap(t2)?.you} t1closed=${t1.closedWith}`);
  const t1b = await open({}, (await auth(mint({ sub: "human:discord:5550001", name: "Twin" }))).cookie);
  check("same person re-arriving → takeover still works", snap(t1b)?.you === "Twin" && t1.closedWith === 4002,
    `t1closed=${t1.closedWith}`);

  const spoof = await auth(mint({ sub: "human:discord:6660001", name: "claude" }));
  const s6 = await open({}, spoof.cookie);
  check("agent name via Discord nick → reserved, rejected", s6.closedWith === 4004, `code=${s6.closedWith}`);

  // ---- /upload gate: aid1 reaches the script tier (Digi's finding #5) ----
  const upTok = mint({ sub: "agent:ferro@guest", kind: "agent", name: "Ferro", scopes: ["worlds:join"], jti: undefined });
  const up = (tok: string, body = "world.log('hi')") =>
    fetch(`${HTTP}/upload?as=script&token=${encodeURIComponent(tok)}`, { method: "POST", body });
  const u1 = await up(upTok);
  const u1body = u1.status === 200 ? await u1.json() : null;
  check("aid1 token uploads a script", u1.status === 200 && typeof u1body?.path === "string",
    `status=${u1.status}`);
  check("aid1 upload is repeatable (no jti burn)", (await up(upTok)).status === 200);
  check("garbage aid1 at /upload → 401", (await up("aid1.not.real")).status === 401);
  check("spectate-only scope at /upload → 401",
    (await up(mint({ kind: "agent", scopes: ["worlds:spectate"], jti: undefined }))).status === 401);

  // ---- agent-door verifier (the same copy net-server.ts uses) ----
  const agentTok = mint({ sub: "agent:ferro@guest", kind: "agent", name: "Ferro", scopes: ["worlds:join"], jti: undefined });
  const v = verifyToken(agentTok, { issuerId: ISSUER_ID, iss: ISS, aud: "eidoverse", requireScopes: ["worlds:join"] });
  check("agent aid1 verifies at the MCPL door", v.ok && v.ok === true && v.payload.sub === "agent:ferro@guest");
  const vBad = verifyToken(agentTok, { issuerId: ISSUER_ID, iss: ISS, aud: "orrery" });
  check("agent aid1 for another audience refused", !vBad.ok);

  for (const s of [s1, s2, s3, s4, s5, t1, t2, t1b, s6]) { try { s.ws.close(); } catch { /* closed */ } }
} finally {
  proc.kill();
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
