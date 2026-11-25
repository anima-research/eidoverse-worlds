// The native login: the HTTP handler isolated (no auth.ts runtime, no files), then the same flow over a real server's HTTP + WS:
// browser auth, approval, an independent session joining any world, the pre-10-17 session on both
// doors, logout isolation, private session persistence.
//
//   BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun test/server/native-login-test.ts
import { generateKeyPairSync, createPublicKey, sign, randomBytes } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNativeLogin } from "../../server/native-login.ts";
import type { HnSession } from "../../server/auth.ts";
import { foundWorlds, freePort, ROOT } from "../harness/harness.ts";
import { pause, until } from "../gate/wait.ts";
import { suite } from "../gate/suite.ts";
import { helloOf } from "../../shared/protocol/hello.js";

const S = suite("native-login");
const check = (name: string, ok: unknown, detail?: unknown) => S.check(name, ok, detail);

// ============================================================ the handler, isolated
console.log("NATIVE LOGIN — the handler");
{
  let time = 1_000_000;
  const issued: HnSession[] = [];
  let browser: HnSession | null = { sub: "human:test", name: "Test Diver", scopes: ["worlds:join", "worlds:spectate", "admin"], exp: time + 3600_000 };
  const origin = "https://eidoverse.animalabs.ai";
  const handler = createNativeLogin({ origin, login: "https://id.animalabs.ai/login?audience=eidoverse", enabled: true,
    now: () => time, session: (c) => c === "browser" ? browser : null,
    issue: (s) => { issued.push(s); return "a".repeat(64); } });
  const post = (path: string, body = {}, headers: Record<string, string> = {}) =>
    handler(new Request(origin + path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) }));
  const approveHeaders = { origin, cookie: "browser" };
  const start = async () => (await post("/native/start")).json();
  const poll = (p: any) => post("/native/poll", { device_code: p.device_code });
  const status = async (what: string, r: Promise<Response>, expected: number) => { const s = (await r).status; check(`${what} → ${expected}`, s === expected, s); };

  const p = await start();
  check("start: a 64-hex device code and a XXXXX-XXXXX user code", /^[a-f0-9]{64}$/.test(p.device_code) && /^[A-F0-9]{5}-[A-F0-9]{5}$/.test(p.user_code), p);
  await status("poll before approval", poll(p), 202);
  check("...and nothing is issued", issued.length === 0);
  await status("a second poll inside the interval", poll(p), 429); time += 2001;
  await status("polling with the user code", post("/native/poll", { device_code: p.user_code }), 410);
  await status("approve with no origin or cookie", post("/native/approve", { user_code: p.user_code }), 403);
  await status("approve from another origin", post("/native/approve", { user_code: p.user_code }, { origin: "https://evil.test", cookie: "browser" }), 403);
  await status("approve with no session", post("/native/approve", { user_code: p.user_code }, { origin }), 401);
  await status("approve", post("/native/approve", { user_code: p.user_code }, approveHeaders), 200);
  await status("approve twice", post("/native/approve", { user_code: p.user_code }, approveHeaders), 410);
  const granted = await poll(p);
  check("the grant: 200 with an HttpOnly SameSite=Lax Secure cookie", granted.status === 200 && /HttpOnly; SameSite=Lax;.*Secure/.test(granted.headers.get("set-cookie") ?? ""), granted.headers.get("set-cookie"));
  check("...an ordinary native session: native mark, no nativeWorld, join+spectate only", issued[0]?.native === true && issued[0]?.nativeWorld === undefined
    && JSON.stringify(issued[0]?.scopes) === JSON.stringify(["worlds:join", "worlds:spectate"]), issued[0]);
  check("...world_scope is every world", (await granted.json()).world_scope === "*");
  check("...it expires with the browser session, which is not marked native", issued[0]?.exp === browser!.exp && browser!.native === undefined);
  await status("a replayed poll", poll(p), 410);
  const expired = await start(); time += 300001; await status("an expired pairing", poll(expired), 410);
  const cancelled = await start(); await status("cancel", post("/native/cancel", { device_code: cancelled.device_code }), 200); await status("a cancelled pairing", poll(cancelled), 410);
  const denied = await start(); await status("deny", post("/native/deny", { user_code: denied.user_code }, approveHeaders), 200); await status("a denied pairing", poll(denied), 403);
  const revoked = await start(); await status("approve, then the browser session goes", post("/native/approve", { user_code: revoked.user_code }, approveHeaders), 200);
  browser = null; await status("a pairing whose approver signed out", poll(revoked), 403);
  browser = { sub: "human:test", name: "Test", scopes: ["worlds:spectate"], exp: time + 3600_000 };
  const limited = await start(); await status("approve from a session without worlds:join", post("/native/approve", { user_code: limited.user_code }, approveHeaders), 403);
  // a native session never approves another pairing: the new mark, and the one sessions from before 2026-10-17 carry
  browser.scopes = ["worlds:join"]; browser.native = true;
  await status("approve from a native session", post("/native/approve", { user_code: limited.user_code }, approveHeaders), 403);
  delete browser.native; browser.nativeWorld = "water";
  await status("approve from a pre-10-17 native session", post("/native/approve", { user_code: limited.user_code }, approveHeaders), 403);
  await status("an oversize start", post("/native/start", { oversize: "x".repeat(2048) }), 413);
  await status("a start from origin null", post("/native/start", {}, { origin: "null" }), 403);
  // Sec-Fetch-Site decides when sent, as for the socket guard (auth.ts crossSiteUpgrade)
  browser = { sub: "human:test", name: "Test", scopes: ["worlds:join"], exp: time + 3600_000 }; const fm = await start();
  await status("approve, Sec-Fetch-Site cross-site with this server's Origin", post("/native/approve", { user_code: fm.user_code }, { ...approveHeaders, "sec-fetch-site": "cross-site" }), 403);
  await status("approve, Sec-Fetch-Site same-site (a sibling subdomain)", post("/native/approve", { user_code: fm.user_code }, { ...approveHeaders, "sec-fetch-site": "same-site" }), 403);
  await status("a start with Sec-Fetch-Site none", post("/native/start", {}, { "sec-fetch-site": "none" }), 403);
  await status("approve, Sec-Fetch-Site same-origin with a proxy's https Origin", post("/native/approve", { user_code: fm.user_code }, { origin: "https://proxied.test", cookie: "browser", "sec-fetch-site": "same-origin" }), 200);
  await status("GET /native/approve", handler(new Request(origin + "/native/approve")), 405);
  const page = await handler(new Request(origin + "/native")); const html = await page.text();
  check("the /native page refuses framing", /frame-ancestors 'none'/.test(page.headers.get("content-security-policy") ?? ""));
  check("...shows Approve and leaks no world or device code", html.includes(">Approve</button>") && !/water|all_worlds/i.test(html) && !html.includes(p.device_code));
  time += 60_001; let starts = 0;
  for (let i = 0; i < 30; i++) if ((await post("/native/start")).status === 200) starts++;
  check("30 starts in a minute are served", starts === 30, starts);
  await status("the 31st start", post("/native/start"), 429);
}

// ============================================================ the same flow on a real server (scratch dirs, a free port)
console.log("NATIVE LOGIN — over a real server's HTTP + WS");
{
  const scratch = mkdtempSync(join(tmpdir(), "ew-native-login-"));
  mkdirSync(join(scratch, "opt"), { recursive: true });
  foundWorlds(join(scratch, "worlds"), ["water", "commons", "native-elsewhere"]);   // a join founds nothing: the worlds it joins exist
  const port = freePort(18000), origin = `http://127.0.0.1:${port}`;
  const pair = generateKeyPairSync("ed25519"), pub = createPublicKey(pair.privateKey).export({ format: "der", type: "spki" }) as Buffer;
  const issuer = `ed25519:${pub.subarray(pub.length - 32).toString("base64url")}`;
  // a native session paired before native sessions became ordinary ones, as the server restores it: nativeWorld "water", no native mark
  const legacySid = randomBytes(32).toString("hex"), legacy = `ew_sess=${legacySid}`;
  writeFileSync(join(scratch, "sessions.json"), JSON.stringify({ [legacySid]: { sub: "human:discord:legacy", name: "Legacy Native",
    scopes: ["worlds:join", "worlds:spectate"], exp: Date.now() + 600_000, nativeWorld: "water" } }), { mode: 0o600 });
  const server = Bun.spawn([process.execPath, join(ROOT, "server/server.ts")], { env: { ...process.env,
    HOST: "127.0.0.1", PORT: String(port), JOIN_TOKEN: "native-test-door", WORLDS_DIR: join(scratch, "worlds"),
    OPT_DIR: join(scratch, "opt"), RELAY_STATE_DIR: join(scratch, "opt"), SKIP_OPT_SWEEP: "1", RECORD_FRAMES: "0",
    HN_SESSIONS_FILE: join(scratch, "sessions.json"), AGENT_TOKENS_PATH: join(scratch, "tokens.json"),
    HN_ISSUER_KEY: issuer, HN_ISS: "id.test", HN_AUD: "eidoverse", HN_NATIVE_ORIGIN: "", HN_REQUIRE_LOGIN: "0",   // unset, as a self-hoster runs it: the pairing page is this server's own origin, never the public show's
  }, stdout: "ignore", stderr: "pipe" });
  const sockets: WebSocket[] = [];
  const post = (path: string, body: object, headers: Record<string, string> = {}) =>
    fetch(origin + path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  const cookie = (r: Response) => /^ew_sess=[a-f0-9]{64}/.exec(r.headers.get("set-cookie") ?? "")?.[0] ?? "";
  async function connect(world: string, session: string) {
    const messages: any[] = []; let closed = 0;
    const ws = new WebSocket(origin.replace("http:", "ws:") + "/ws", { headers: { cookie: session } } as any); sockets.push(ws);
    ws.onopen = () => ws.send(JSON.stringify({ type: "join", hello: helloOf(), world, id: "untrusted-client-name", replica: true }));
    ws.onmessage = (e) => messages.push(JSON.parse(String(e.data))); ws.onclose = (e) => { closed = e.code; };
    await until(`a join result for ${world}`, () => closed !== 0 || messages.some((m) => m.type === "snapshot"));
    return { ws, messages };
  }
  try {
    await until("the scratch server answers /authcfg", async () => {
      if (server.exitCode !== null) throw new Error("scratch server exited: " + await new Response(server.stderr).text());
      return (await fetch(origin + "/authcfg")).ok;
    });
    const now = Math.floor(Date.now() / 1000);
    const payload = { v: 1, iss: "id.test", sub: "human:discord:fixture", kind: "human", name: "Native Fixture", aud: "eidoverse", scopes: ["worlds:join", "worlds:spectate"], iat: now, exp: now + 600, jti: "native-wire-test" };
    const segment = Buffer.from(JSON.stringify(payload)).toString("base64url");
    const token = `aid1.${segment}.${sign(null, Buffer.from(`aid1.${segment}`), pair.privateKey).toString("base64url")}`;
    const auth = await post("/auth", { token }); const browser = cookie(auth);
    check("W1 a signed id token at /auth sets a browser session", auth.status === 200 && !!browser, auth.status);
    const landing = await (await fetch(origin + "/auth")).text();
    check("W2 the /auth landing offers the native pair code", landing.includes("ew-native-pair-code") && landing.includes("/native#code="));
    const p = await (await post("/native/start", {})).json();
    check("W3a a poll before approval is pending (202)", (await post("/native/poll", { device_code: p.device_code })).status === 202);
    const foreign = await post("/native/approve", { user_code: p.user_code }, { cookie: browser, origin: "https://evil.test" });
    check("W3b approval from a foreign Origin is refused on the real route (HN_NATIVE_ORIGIN unset)", foreign.status === 403, foreign.status);
    const show = await post("/native/approve", { user_code: p.user_code }, { cookie: browser, origin: "https://eidoverse.animalabs.ai" });
    check("W3c ...and so is one from the public show's origin: a self-hosted server's pairing is its own, not someone else's site's", show.status === 403, show.status);
    const crossSite = await post("/native/approve", { user_code: p.user_code }, { cookie: browser, origin, "sec-fetch-site": "cross-site" });
    check("W3d Sec-Fetch-Site decides when sent: cross-site is refused even with this server's Origin", crossSite.status === 403, crossSite.status);
    const startCross = await post("/native/start", {}, { "sec-fetch-site": "same-site", origin: "https://sib.127.0.0.1.test" });
    check("W3e a browser start from a sibling site is refused (403)", startCross.status === 403, startCross.status);
    const proxied = await (await post("/native/start", {})).json();
    const viaProxy = await post("/native/approve", { user_code: proxied.user_code }, { cookie: browser, origin: "https://public.example", "sec-fetch-site": "same-origin" });
    check("W3f behind a TLS proxy (the browser's Origin is the public https one, the request http): Sec-Fetch-Site same-origin approves (200)", viaProxy.status === 200, viaProxy.status);
    await pause("the poll interval", 2100);
    const proxGrant = await post("/native/poll", { device_code: proxied.device_code }, { "x-forwarded-proto": "https" });
    check("W3g ...and behind it the native cookie is Secure (x-forwarded-proto https, as routes.ts's /auth cookie reads it)", proxGrant.status === 200 && /; Secure/.test(proxGrant.headers.get("set-cookie") ?? ""), proxGrant.headers.get("set-cookie"));
    // ...so the repository's own TLS front must say so (bot review #364 1): every block that reaches /native or /auth sets it, overwriting a client's
    const conf = readFileSync(join(ROOT, "deploy/nginx-show.conf"), "utf8"), root = /location \/ \{[^}]*\}/.exec(conf)?.[0] ?? "";
    check("W3h deploy/nginx-show.conf's `location /` sets X-Forwarded-Proto $scheme (the native and /auth cookies are Secure on the show)", /proxy_set_header X-Forwarded-Proto \$scheme;/.test(root), root);
    const approved = await post("/native/approve", { user_code: p.user_code }, { cookie: browser, origin });
    check("W3 approval through auth.ts's real session store: 200, and it sets no cookie on the browser", approved.status === 200 && approved.headers.get("set-cookie") === null, approved.status);
    await pause("the poll interval: a poll inside 2 s of the last is a 429", 2100);
    const grant = await post("/native/poll", { device_code: p.device_code }); const native = cookie(grant);
    check("W4c a plain-http server's native cookie isn't Secure (a cookie jar would drop it over http)", !/Secure/.test(grant.headers.get("set-cookie") ?? ""), grant.headers.get("set-cookie"));
    check("W4 the grant is a session independent of the browser's", grant.status === 200 && !!native && native !== browser, grant.status);
    const replay = await post("/native/poll", { device_code: p.device_code });
    check("W4a a replayed poll is refused (410), the grant is single-use", replay.status === 410, replay.status);
    const relay = await (await post("/native/start", {})).json(), redel = await post("/native/approve", { user_code: relay.user_code }, { cookie: native, origin });
    check("W4b the native session never approves another pairing (403)", redel.status === 403, redel.status);
    // an ordinary sign-in: any world the account may join, as the browser's session would
    for (const w of ["water", "commons", "native-elsewhere"]) {
      const c = await connect(w, native); const snap = c.messages.find((m) => m.type === "snapshot");
      check(`W5 the native session joins ${w} (the snapshot names it by its id) under the account's name, not the client's`, /^sha256:/.test(String(snap?.world)) && snap?.name === w && snap?.you === "Native Fixture", snap ? { world: snap.world, name: snap.name, you: snap.you } : "no snapshot");
      c.ws.close();
    }
    // the session paired before native sessions became ordinary ones joins another world, and the HTTP door answers it as the browser's
    const lc = await connect("commons", legacy);
    check("W6 a pre-10-17 native session (nativeWorld water) joins commons", lc.messages.some((m) => m.type === "snapshot")); lc.ws.close();
    const door = async (c: string) => (await (await fetch(origin + "/access?world=commons", { headers: { cookie: c } })).json()).you;
    const [dl, db] = [await door(legacy), await door(browser)];
    check("W7 ...and the HTTP door for commons says enter to it, as to the browser's session", dl === "enter" && db === "enter", { legacy: dl, browser: db });
    check("W8 logout of the native session", (await post("/logout", {}, { cookie: native })).status === 200);
    const [wn, wb] = [(await fetch(origin + "/whoami", { headers: { cookie: native } })).status, (await fetch(origin + "/whoami", { headers: { cookie: browser } })).status];
    check("W9 ...ends it alone: native 401, browser still 200", wn === 401 && wb === 200, { native: wn, browser: wb });
    S.mode("W10 sessions persist private (0600)", join(scratch, "sessions.json"), 0o600);
  } finally { for (const ws of sockets) ws.close(); server.kill(); await server.exited; }
}

S.done();
