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
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { foundWorlds, freePort } from "./harness.ts";
import { verifyToken } from "../server/aid1.ts";
import { accountTag } from "../server/directory.ts";

const PORT = process.env.PORT ? Number(process.env.PORT) : freePort(9420);   // a free port, never a fixed default
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
    ws.onopen = () => ws.send(JSON.stringify({ type: "join", world: "authtest", replica: true, ...joinMsg }));
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
foundWorlds(worldsDir, ["authtest"]);   // joining never founds a world
// the agent enrolments (reserved names) are this run's own, not whatever the checkout's mcpl/tokens.json holds
const tokensPath = join(worldsDir, "tokens.json");
await Bun.write(tokensPath, JSON.stringify({ "authtest-claude-bearer": { id: "claude" } }));
// process.execPath, not "bun": the PATH "bun" is an npm .cmd shim on Windows
// whose pid dies immediately, orphaning the real sequencer on this port where
// it poisons the next run.
const optDir = mkdtempSync(join(tmpdir(), "authtest-opt-"));
const proc = Bun.spawn([process.execPath, "run", join(import.meta.dir, "..", "server", "server.ts")], {
  env: {
    // a scratch store too: the upload legs write files, and they belong in the scratch dir, not assets/opt
    ...process.env, PORT: String(PORT), WORLDS_DIR: worldsDir, JOIN_TOKEN: DOOR,
    HN_NATIVE_ORIGIN: HTTP, HN_ISSUER_KEY: ISSUER_ID, HN_ISS: ISS, HN_REQUIRE_LOGIN: "0", AGENT_TOKENS_PATH: tokensPath, SKIP_OPT_SWEEP: "1", OPT_DIR: optDir,
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
    snap(t2)?.you === `Twin-${accountTag("human:discord:5550002")}` && t1.closedWith === null,   // a hash: none of the account's digits
    `you=${snap(t2)?.you} t1closed=${t1.closedWith}`);
  const t1b = await open({}, (await auth(mint({ sub: "human:discord:5550001", name: "Twin" }))).cookie);
  check("same person re-arriving → takeover still works", snap(t1b)?.you === "Twin" && t1.closedWith === 4002,
    `t1closed=${t1.closedWith}`);

  const spoof = await auth(mint({ sub: "human:discord:6660001", name: "claude" }));
  const s6 = await open({}, spoof.cookie);
  check("agent name via Discord nick → reserved, rejected", s6.closedWith === 4004, `code=${s6.closedWith}`);

  // ---- /upload gate: an aid1 agent credential reaches the upload door (Digi's finding #5). (The v1 runtime-script
  // store, /upload?as=script, went with protocol v1: a script is an `upload {text}` request, tools/protocol/scripts-check.ts.)
  const upTok = mint({ sub: "agent:ferro@guest", kind: "agent", name: "Ferro", scopes: ["worlds:join"], jti: undefined });
  const glb = new Uint8Array(16); new DataView(glb.buffer).setUint32(0, 0x46546c67, true);   // a glTF header
  const up = (tok: string) => fetch(`${HTTP}/upload?token=${encodeURIComponent(tok)}`, { method: "POST", body: glb });
  const u1 = await up(upTok);
  check("aid1 token is accepted at the upload door", u1.status === 200, `status=${u1.status}`);
  check("aid1 upload is repeatable (no jti burn)", (await up(upTok)).status === 200);
  check("garbage aid1 at /upload → 401", (await up("aid1.not.real")).status === 401);
  check("spectate-only scope at /upload → 401",
    (await up(mint({ kind: "agent", scopes: ["worlds:spectate"], jti: undefined }))).status === 401);

  // ---- /upload gate: a person signed in through the home node (session cookie, no door key) ----
  const png = (() => {   // a 2×2 grayscale PNG — the smallest thing the heightmap door takes
    const { PNG } = require("pngjs");
    const p = new PNG({ width: 2, height: 2, colorType: 0, inputColorType: 0, inputHasAlpha: false });
    p.data = Buffer.from([0, 85, 170, 255]);
    return PNG.sync.write(p, { colorType: 0, inputColorType: 0, inputHasAlpha: false });
  })();
  const upAs = (headers: Record<string, string>, q = "") =>
    fetch(`${HTTP}/upload?as=heightmap&name=h.png${q}`, { method: "POST", body: png, headers });
  const hm1 = await upAs({ cookie: a1.cookie, "sec-fetch-site": "same-origin" }, "&by=someone-else");
  const hm1body = hm1.status === 200 ? await hm1.json() : null;
  check("signed-in session (same-origin) uploads a heightmap with no door key", hm1.status === 200 && typeof hm1body?.grid === "string",
    `status=${hm1.status} ${hm1.status !== 200 ? await hm1.text() : ""}`);
  // who it is credited to: the session's name, whatever ?by= claims — read back from the store's own
  // provenance (an image's manifest entry; heightmaps keep none)
  const im = await fetch(`${HTTP}/upload?as=image&name=pic.png&by=someone-else`, { method: "POST", body: png, headers: { cookie: a1.cookie, "sec-fetch-site": "same-origin" } });
  const imPath = im.status === 200 ? (await im.json()).path as string : "";
  const manifest = imPath ? JSON.parse(readFileSync(join(optDir, "store", "images", "manifest.json"), "utf8")) : {};
  const entry = manifest[imPath.replace(/^store\/images\//, "").replace(/\.[a-z]+$/, "")];
  check("...credited to the signed-in name, not the forged ?by=", entry?.by === "Guest One", `status=${im.status} by=${entry?.by}`);
  check("...the cookie from another site's page is not taken", (await upAs({ cookie: a1.cookie, "sec-fetch-site": "same-site" })).status === 401);
  check("no session, no key → 401", (await upAs({ "sec-fetch-site": "same-origin" })).status === 401);
  const spectOnly = await auth(mint({ sub: "human:discord:7770001", name: "Watcher", scopes: ["worlds:spectate"] }));
  check("a spectate-only login cannot upload", spectOnly.cookie.length > 0
    && (await upAs({ cookie: spectOnly.cookie, "sec-fetch-site": "same-origin" })).status === 401);

  // ---- a native client's session (browser-approved pairing, native-login.ts): the cookie the ws join takes, with no
  // fetch metadata (a native client isn't a browser), is taken by /worlds and /upload too (R 10-27; unreal-contract CONTRACT.md)
  const npost = (path: string, body: object, headers: Record<string, string> = {}) =>
    fetch(`${HTTP}${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  const pairing = await (await npost("/native/start", {})).json();
  const approved = await npost("/native/approve", { user_code: pairing.user_code }, { origin: HTTP, cookie: a1.cookie });
  const polled = await npost("/native/poll", { device_code: pairing.device_code });
  const native = /ew_sess=[a-f0-9]{64}/.exec(polled.headers.get("set-cookie") ?? "")?.[0] ?? "";
  check("native pairing: the browser approves, the client's poll gets its own session cookie", approved.status === 200 && polled.status === 200 && native.length > 0 && native !== a1.cookie, `approve=${approved.status} poll=${polled.status}`);
  const sN = await open({}, native);
  check("native session: the ws join takes it with no door key", Boolean(snap(sN)), `closed=${sN.closedWith}`);
  check("native session: GET /worlds (a JOIN_TOKEN box) takes the same cookie → 200", (await fetch(`${HTTP}/worlds`, { headers: { cookie: native } })).status === 200);
  const upN = await upAs({ cookie: native, "x-real-ip": "203.0.113.7" });
  check("native session: POST /upload takes the same cookie → 200", upN.status === 200, `status=${upN.status} ${upN.status !== 200 ? await upN.text() : ""}`);
  check("...a browser's cookie with no fetch-site at all is the same request, and is taken too", (await upAs({ cookie: a1.cookie, "x-real-ip": "203.0.113.8" })).status === 200);
  check("...but the cookie from another site's page (sec-fetch-site: same-site) still isn't, at /worlds or /upload",
    (await fetch(`${HTTP}/worlds`, { headers: { cookie: native, "sec-fetch-site": "same-site" } })).status === 401
    && (await upAs({ cookie: native, "sec-fetch-site": "cross-site", "x-real-ip": "203.0.113.9" })).status === 401);
  check("no cookie, no key: GET /worlds → 401", (await fetch(`${HTTP}/worlds`)).status === 401);
  check("a key in ?token= is not a /worlds credential", (await fetch(`${HTTP}/worlds?token=${DOOR}`)).status === 401);

  // ---- agent-door verifier (the same copy net-server.ts uses) ----
  const agentTok = mint({ sub: "agent:ferro@guest", kind: "agent", name: "Ferro", scopes: ["worlds:join"], jti: undefined });
  const v = verifyToken(agentTok, { issuerId: ISSUER_ID, iss: ISS, aud: "eidoverse", requireScopes: ["worlds:join"] });
  check("agent aid1 verifies at the MCPL door", v.ok && v.ok === true && v.payload.sub === "agent:ferro@guest");
  const vBad = verifyToken(agentTok, { issuerId: ISSUER_ID, iss: ISS, aud: "orrery" });
  check("agent aid1 for another audience refused", !vBad.ok);

  for (const s of [s1, s2, s3, s4, s5, t1, t2, t1b, s6, sN]) { try { s.ws.close(); } catch { /* closed */ } }
} finally {
  proc.kill();
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
