// tools/protocol/setup-check.ts — the first-run setup link (R 10-28; server/setup.ts, server/operators.ts), against real sequencers.
// Scratch ports and WORLDS_DIRs, its own sessions, tokens.json and a test aid1 issuer. usage: bun tools/protocol/setup-check.ts
//   SU1 no operator: one boot line names /setup#token=<≥128 bits>; the token is in no other line, nor the page, nor any reply
//   SU2 refused, and the token still works after: a guest, another site's page (Sec-Fetch-Site), a wrong token (same "refused" as a used one)
//   SU3 a signed-in person claims it: "You're this server's operator.", stored 0600, operator at once (an old world's join says operator)
//   SU4 then the link is used up: a second claim and GET /setup are a missing page, the token itself is gone; a restart prints no link and keeps the operator
//   SU5 with SERVER_OPERATORS set, or an operators file, no link is printed and /setup is a missing page
//   SU6 an agent claims with its Bearer (aid1 and enrolled): the stored account is the one its ws join proves (that join says operator)
//   SU7 more than five tries a minute from one address are refused (429)
//   SU9 the operators file is written safely: a planted .operators.json.tmp symlink is never followed, and a symlinked .operators.json is refused, unchanged
//   SU8 the page reads the token from the fragment only: a ?token= link posts nothing and says so (it would sit in proxy logs and history)
//   SU10 an authenticated valid-token claim accepts 1024 body bytes and refuses 1025, declared or chunked, including before an unfinished sender ends
// @ts-nocheck
import fs from "node:fs";
import path from "node:path";
import { generateKeyPairSync, sign as cryptoSign } from "node:crypto";
import http from "node:http";
import { ENGINE, scratch, linkFile, canLinkFiles } from "./common.ts";
import { tryUntil } from "./wait.ts";

const root = scratch("setup");
let pass = 0, fail = 0;
const ok = (cond, what, detail?) => { if (cond) { pass++; console.log(`  ok   ${what}`); } else { fail++; console.log(`  FAIL ${what}${detail !== undefined ? ` — ${JSON.stringify(detail).slice(0, 500)}` : ""}`); } };

const pair = generateKeyPairSync("ed25519");
const spki = pair.publicKey.export({ type: "spki", format: "der" }) as Buffer;
const ISSUER = `ed25519:${spki.subarray(spki.length - 32).toString("base64url")}`;
let jti = 0;
const mint = (over = {}) => { const now = Math.floor(Date.now() / 1000);
  const p = { v: 1, iss: "id.test", sub: "agent:quill@home.test", kind: "agent", name: "Quill", aud: "eidoverse", scopes: ["worlds:join"], iat: now, exp: now + 600, jti: `j${jti++}`, ...over };
  const seg = Buffer.from(JSON.stringify(p)).toString("base64url");
  return `aid1.${seg}.${cryptoSign(null, Buffer.from(`aid1.${seg}`), pair.privateKey).toString("base64url")}`; };

const TOK = path.join(root, "tokens.json");
fs.writeFileSync(TOK, JSON.stringify({ "tok-rowan": { id: "Rowan" } }));
const ANN = "a".repeat(64), BEA = "b".repeat(64), SESS = path.join(root, "sessions.json");
fs.writeFileSync(SESS, JSON.stringify({ [ANN]: { sub: "human:test:ann", name: "Ann", scopes: ["worlds:join"], exp: Date.now() + 3600_000 },
  [BEA]: { sub: "human:test:bea", name: "Bea", scopes: ["worlds:join"], exp: Date.now() + 3600_000 } }), { mode: 0o600 });
const V1 = path.resolve(ENGINE, "spec/fixtures/01-build/log.jsonl");
const worldsDir = (tag) => { const W = path.join(root, tag); const d = path.join(W, "old-x"); fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, "log.jsonl"), fs.readFileSync(V1, "utf8").split("\n").slice(0, 200).filter(Boolean).join("\n") + "\n"); return W; };
const env = (W, extra = {}) => ({ ...process.env, WORLDS_DIR: W, OPT_DIR: path.join(root, "opt"), BACKUPS_DIR: path.join(root, `${path.basename(W)}-backups`), SKIP_OPT_SWEEP: "1", HOST: "127.0.0.1",
  BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0", JOIN_TOKEN: "", SERVER_OPERATORS: "", AGENT_TOKENS_PATH: TOK, SESSIONS_PATH: SESS, HN_ISSUER_KEY: ISSUER, HN_ISS: "id.test", ...extra });
let nextPort = 9410;
async function start(W, extra = {}) {
  let port = nextPort; for (; port < 9500; port++) { try { const s = Bun.listen({ hostname: "127.0.0.1", port, socket: { data() {} } }); s.stop(true); break; } catch {} }
  nextPort = port + 1;
  const logf = path.join(root, `srv-${port}.log`);
  const p = Bun.spawn(["bun", "server/server.ts"], { cwd: ENGINE, env: env(W, { PORT: String(port), ...extra }), stdout: Bun.file(logf), stderr: Bun.file(logf + ".err") });
  const s = { port, proc: p, dead: false, log: () => (fs.existsSync(logf) ? fs.readFileSync(logf, "utf8") : "") + (fs.existsSync(logf + ".err") ? fs.readFileSync(logf + ".err", "utf8") : ""), stop: async () => { try { p.kill(); } catch {} await p.exited; } };
  const up = await tryUntil("the server answers /version, or exits", async () => p.exitCode != null ? "dead"
    : (await fetch(`http://127.0.0.1:${port}/version`, { signal: AbortSignal.timeout(800) }).then((r) => r.ok, () => false)) ? "up" : null, { ms: 12000, step: 150 });
  s.dead = up !== "up"; return s;
}
const tokenOf = (log) => /\/setup#token=([A-Za-z0-9_-]+)/.exec(log)?.[1] ?? null;
const setupLines = (log) => log.split("\n").filter((l) => /No operator yet/.test(l));
const post = (port, body, headers = {}) => fetch(`http://127.0.0.1:${port}/setup`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) })
  .then(async (r) => ({ status: r.status, text: await r.text() }));
const sizedBody = (token, bytes) => {
  const blank = JSON.stringify({ token, pad: "" });
  const padding = bytes - Buffer.byteLength(blank);
  if (padding < 0) throw new Error("setup body limit test fixture is too small");
  return JSON.stringify({ token, pad: "x".repeat(padding) });
};
const postRaw = (port, body, headers = {}) => fetch("http://127.0.0.1:" + port + "/setup", { method: "POST", headers: { "content-type": "application/json", ...headers }, body })
  .then(async (r) => ({ status: r.status, text: await r.text() }));
const postChunked = (port, body, headers = {}, finish = true) => new Promise((resolve, reject) => {
  const req = http.request({ hostname: "127.0.0.1", port, path: "/setup", method: "POST", agent: false,
    headers: { "content-type": "application/json", "transfer-encoding": "chunked", connection: "close", ...headers } }, (res) => {
    let text = "";
    res.setEncoding("utf8");
    res.on("data", (chunk) => { text += chunk; });
    res.on("end", () => {
      const result = { status: res.statusCode, text };
      if (finish) return resolve(result);
      const socket = req.socket;
      if (socket && !socket.destroyed) socket.once("close", () => resolve(result));
      else resolve(result);
      req.destroy();
    });
  });
  req.on("error", reject);
  req.setTimeout(5000, () => req.destroy(new Error("setup body response timed out")));
  req.write(body.slice(0, 700));
  if (finish) req.end(body.slice(700));
  else req.write(body.slice(700));
});
const get = (port, headers = {}) => fetch(`http://127.0.0.1:${port}/setup`, { headers }).then(async (r) => ({ status: r.status, text: await r.text(), csp: r.headers.get("content-security-policy") }));
const missing = (port) => fetch(`http://127.0.0.1:${port}/no-such-page-here`).then(async (r) => ({ status: r.status, text: await r.text() }));
const cookie = (sid) => ({ cookie: `ew_sess=${sid}` });
/** An old world's join refusal says whether the joiner is an operator (refused.operator): the ws door's own isOperator, live. */
const operatorAtJoin = (port, { headers, agentToken }: any = {}) => new Promise((res) => {
  const ws = headers ? new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers }) : new WebSocket(`ws://127.0.0.1:${port}/ws`); let refused = null;
  ws.onopen = () => ws.send(JSON.stringify({ type: "join", world: "old-x", id: "probe", avatar: "", replica: true, ...(agentToken ? { agentToken } : {}) }));
  ws.onmessage = (ev) => { const m = JSON.parse(String(ev.data)); if (m.type === "error" && m.refused) refused = m.refused; };
  ws.onclose = () => res(refused?.operator ?? null);
  setTimeout(() => { try { ws.close(); } catch {} res(null); }, 8000);
});
const stored = (W) => { const f = path.join(W, ".operators.json"); return fs.existsSync(f) ? { list: JSON.parse(fs.readFileSync(f, "utf8")).operators, mode: fs.statSync(f).mode & 0o777 } : null; };
const replies = [];   // every reply body, to look for the token in
const WIN = process.platform === "win32";
/** The stored file is private: 0600 where POSIX modes exist; on Windows (no modes on NTFS) a plain file, no temp left beside it. */
const privately = (W, st) => { const f = path.join(W, ".operators.json");
  return WIN ? fs.lstatSync(f).isFile() && !fs.readdirSync(W).some((n) => /^\.operators\.json\.[0-9a-f]+\.tmp$/.test(n)) : st?.mode === 0o600; };
const modeOf = (f) => fs.statSync(f).mode & 0o777;
/** Run the setup page's script against a fake location: what it posted (null: nothing) and what it said. */
async function runPage(html, { hash = "", search = "" }) {
  const js = /<script>([\s\S]*)<\/script>/.exec(html)?.[1] ?? ""; let posted = null; const m = { textContent: "" };
  const fetchStub = async (_u, o) => { posted = JSON.parse(o.body); return { ok: true, status: 200, json: async () => ({ words: "done" }) }; };
  await new Function("location", "document", "fetch", "history", `return ${js.trim().replace(/;$/, "")}`)({ hash, search }, { getElementById: () => m }, fetchStub, { replaceState() {} });
  return { posted, said: m.textContent };
}

// ---- a person claims it ----
const W1 = worldsDir("w1");
let s = await start(W1);
ok(!s.dead, "(setup) the server is up", s.dead ? s.log().slice(-400) : "");
const t1 = tokenOf(s.log());
{ const lines = setupLines(s.log());
  ok(lines.length === 1 && t1 && Buffer.from(t1, "base64url").length >= 16 && lines[0].includes(`http://127.0.0.1:${s.port}/setup#token=${t1}`) && /signed in \(person or agent\)/.test(lines[0]) && /become this server's operator/.test(lines[0]),
    "SU1 no operator: one boot line, '<base>/setup#token=…' with ≥128 bits, signed in (person or agent)", lines); }
{ const page = await get(s.port); replies.push(page.text);
  ok(page.status === 200 && /\/setup/.test(page.text) && !page.text.includes(t1) && /sha256-/.test(page.csp ?? ""), "SU1 GET /setup is the page that posts the link's token back (its script hashed in the CSP), without the token", { status: page.status }); }
{ const page = await get(s.port), q = await runPage(page.text, { search: "?token=abc" }), f = await runPage(page.text, { hash: "#token=abc" });
  ok(q.posted === null && /incomplete/.test(q.said) && /#token=/.test(q.said) && f.posted?.token === "abc" && f.said === "done",
    "SU8 the page reads the token from the fragment only: a ?token= link posts nothing and says to open the whole #token= link; the fragment's is posted", { q, f }); }
{ const before = await operatorAtJoin(s.port, { headers: cookie(ANN) });
  const guest = await post(s.port, { token: t1 }); replies.push(guest.text);
  ok(guest.status === 401 && /Sign in first/.test(guest.text) && /agent/.test(guest.text) && stored(W1) === null, "SU2 a guest (no sign-in) with the right token is refused, and nothing is stored", guest);
  const cross = await post(s.port, { token: t1 }, { ...cookie(ANN), "sec-fetch-site": "cross-site" }); replies.push(cross.text);
  const sibling = await post(s.port, { token: t1 }, { ...cookie(ANN), "sec-fetch-site": "same-site" }); replies.push(sibling.text);
  ok(cross.status === 403 && sibling.status === 403 && stored(W1) === null, "SU2 the right token from another site's page (cross-site, same-site) is refused (CSRF)", { cross, sibling });
  const wrong = await post(s.port, { token: t1.slice(0, -2) + (t1.endsWith("AA") ? "BB" : "AA") }, cookie(BEA)); replies.push(wrong.text);
  ok(wrong.status === 403 && JSON.parse(wrong.text).error === "refused" && stored(W1) === null, "SU2 a wrong token, signed in, is a plain refusal (no hint)", wrong);
  const claim = await post(s.port, { token: t1 }, cookie(ANN)); replies.push(claim.text);
  const j = JSON.parse(claim.text || "{}"), st = stored(W1), after = await operatorAtJoin(s.port, { headers: cookie(ANN) });
  ok(claim.status === 200 && j.words === "You're this server's operator." && j.account === "human:test:ann", "SU3 …and then a signed-in person's claim works: \"You're this server's operator.\"", claim);
  ok(JSON.stringify(st?.list) === JSON.stringify(["human:test:ann"]) && privately(W1, st), "SU3 the operator is stored in <worlds>/.operators.json, 0600 (Windows: a plain file, no temp left)", st);
  ok(before === false && after === true, "SU3 isOperator is live: the same session's old-world join said not-operator before the claim, operator after (no restart)", { before, after });
  const again = await post(s.port, { token: t1 }, cookie(BEA)), page = await get(s.port), none = await missing(s.port); replies.push(again.text);
  ok(again.status === 404 && page.status === 404 && again.text === none.text && page.text === none.text && JSON.stringify(stored(W1)?.list) === JSON.stringify(["human:test:ann"]) && (await operatorAtJoin(s.port, { headers: cookie(BEA) })) === false,
    "SU4 the link is used up: a second claim (another person) and GET /setup are a missing page, and Bea is not an operator", { again: again.status, page: page.status }); }
{ const log = s.log(), seen = log.split(t1).length - 1;
  ok(seen === 1 && !replies.some((r) => r.includes(t1)), "SU1 the token is in the log exactly once (the boot line) and in no reply", { seen }); }
await s.stop();
// in-process: the token dies with its use, not only because an operator now exists (the operator set emptied, the same token is still refused)
{ const W8 = worldsDir("w8"); const code = `const m = await import("./server/operators.ts"); const t = m.mintSetupToken();
    const one = m.claimSetup(t, "human:test:ann"); m.OPERATORS.clear(); console.log(JSON.stringify({ one, two: m.claimSetup(t, "human:test:bea"), open: m.setupOpen() }));`;
  const r = Bun.spawnSync(["bun", "-e", code], { cwd: ENGINE, env: env(W8) }); let o = {}; try { o = JSON.parse(r.stdout.toString().trim().split("\n").pop()); } catch {}
  ok(o.one === "ok" && o.two === "refused" && o.open === false, "SU4 the token is destroyed by its use (with the operator set emptied, the same token is still refused)", { o, err: r.stderr.toString().slice(-300) }); }
s = await start(W1);
ok(!s.dead && setupLines(s.log()).length === 0 && !tokenOf(s.log()) && (await get(s.port)).status === 404 && (await operatorAtJoin(s.port, { headers: cookie(ANN) })) === true,
  "SU4 a restart: no link printed, /setup missing, and Ann is still the operator (read from the file)", s.log().slice(-300));
await s.stop();

{
  const W = worldsDir("w12"), a = await start(W), token = tokenOf(a.log());
  const over = sizedBody(token, 1025), exact = sizedBody(token, 1024);
  const declaredOver = await postRaw(a.port, over, cookie(ANN));
  const chunkedOver = await postChunked(a.port, over, cookie(ANN));
  ok(!a.dead && Buffer.byteLength(over) === 1025 && declaredOver.status === 413 && chunkedOver.status === 413 && stored(W) === null,
    "SU10 a valid-token 1025-byte setup body is refused with or without a declared length, leaving no operator", { declaredOver, chunkedOver, stored: stored(W) });
  const chunkedExact = await postChunked(a.port, exact, cookie(ANN));
  ok(Buffer.byteLength(exact) === 1024 && chunkedExact.status === 200 && JSON.stringify(stored(W)?.list) === JSON.stringify(["human:test:ann"]),
    "SU10 a valid-token 1024-byte chunked setup body claims the operator", { chunkedExact, stored: stored(W) });
  await a.stop();
}
{
  const W = worldsDir("w13"), a = await start(W), token = tokenOf(a.log());
  const exact = sizedBody(token, 1024), declaredExact = await postRaw(a.port, exact, cookie(ANN));
  ok(!a.dead && Buffer.byteLength(exact) === 1024 && declaredExact.status === 200 && JSON.stringify(stored(W)?.list) === JSON.stringify(["human:test:ann"]),
    "SU10 a valid-token 1024-byte declared setup body claims the operator", { declaredExact, stored: stored(W) });
  await a.stop();
}

{
  const W = worldsDir("w14"), a = await start(W), token = tokenOf(a.log());
  const unfinishedOver = await postChunked(a.port, sizedBody(token, 1025), cookie(ANN), false);
  ok(!a.dead && unfinishedOver.status === 413 && stored(W) === null,
    "SU10 a 1025-byte chunked body is refused before the sender finishes it", { unfinishedOver, stored: stored(W) });
  const claim = await postRaw(a.port, sizedBody(token, 1024), cookie(ANN));
  ok(claim.status === 200 && JSON.stringify(stored(W)?.list) === JSON.stringify(["human:test:ann"]),
    "SU10 the setup token still works after an unfinished oversize body was refused", { claim, stored: stored(W) });
  await a.stop();
}

// ---- operators already named ----
{ const W2 = worldsDir("w2"); const e = await start(W2, { SERVER_OPERATORS: "human:test:bea" });
  ok(!e.dead && setupLines(e.log()).length === 0 && !/setup#token/.test(e.log()) && (await get(e.port)).status === 404 && (await post(e.port, { token: "x" }, cookie(ANN))).status === 404 && stored(W2) === null,
    "SU5 SERVER_OPERATORS set: no link printed, GET and POST /setup are a missing page", e.log().slice(-300));
  await e.stop(); }
{ const W5 = worldsDir("w5"); fs.writeFileSync(path.join(W5, ".operators.json"), JSON.stringify({ operators: ["Ann"] }));
  const e = await start(W5);
  ok(!e.dead && /REFUSED: .*\.operators\.json lists "Ann", which isn't an account/.test(e.log()) && setupLines(e.log()).length === 1,
    "SU5 a bare name in the operators file is refused loudly, naming the file; the server boots (no lockout) and, with no operator left, prints the setup link", e.log().slice(-300));
  await e.stop(); }
{ const W6 = worldsDir("w6"); const e = await start(W6, { SERVER_OPERATORS: "Ann" });
  ok(!e.dead && /setup link/.test(e.log()) && /SERVER_OPERATORS=human:discord:/.test(e.log()) && setupLines(e.log()).length === 1, "SU5 the refusal of a bare SERVER_OPERATORS name mentions the setup link, and the link is printed", e.log().slice(-300));
  await e.stop(); }

// ---- an agent claims it, by Bearer ----
for (const [tag, cred, account] of [["w3", mint(), "aid1:id.test:agent:quill@home.test"], ["w4", "tok-rowan", "agent:token:rowan"]]) {
  const W = worldsDir(tag); const a = await start(W); const t = tokenOf(a.log());
  const bearer = { authorization: `Bearer ${cred}` };
  const viaQuery = await fetch(`http://127.0.0.1:${a.port}/setup?token=${t}`, { method: "POST", headers: { "content-type": "application/json", ...bearer }, body: "{}" }).then((r) => r.status);   // the claim reads the body, never the URL
  const before = await operatorAtJoin(a.port, { agentToken: cred === "tok-rowan" ? cred : mint() });
  const claim = await post(a.port, { token: t }, bearer), j = JSON.parse(claim.text || "{}");
  const after = await operatorAtJoin(a.port, { agentToken: cred === "tok-rowan" ? cred : mint() });
  ok(viaQuery === 403 && claim.status === 200 && j.account === account && JSON.stringify(stored(W)?.list) === JSON.stringify([account]) && before === false && after === true,
    `SU6 an agent (${tag === "w3" ? "aid1" : "enrolled"}) claims with its Bearer: stored as ${account}, the account its ws join proves (operator at that join, no restart)`, { claim, before, after, viaQuery });
  await a.stop();
}

// ---- a planted symlink beside the operators file (SU9) ----
if (!canLinkFiles()) console.log("  SKIP SU9 (both rows): file symlinks need Developer Mode on Windows, so the planted link can't be made here");
else {
{ const W = worldsDir("w10"), victim = path.join(root, "victim-tmp"); fs.writeFileSync(victim, "victim\n", { mode: 0o644 });
  linkFile(victim, path.join(W, ".operators.json.tmp")); const vmode = modeOf(victim), a = await start(W);
  const claim = await post(a.port, { token: tokenOf(a.log()) }, cookie(ANN)), st = stored(W);
  ok(claim.status === 200 && fs.readFileSync(victim, "utf8") === "victim\n" && modeOf(victim) === vmode && (WIN || vmode === 0o644) && !fs.lstatSync(path.join(W, ".operators.json")).isSymbolicLink()
    && fs.lstatSync(path.join(W, ".operators.json.tmp")).isSymbolicLink() && JSON.stringify(st?.list) === JSON.stringify(["human:test:ann"]) && privately(W, st),
    "SU9 a planted .operators.json.tmp symlink is never followed: the claim stores a fresh 0600 file, the symlink's target untouched", { claim, st, victim: fs.readFileSync(victim, "utf8") });
  await a.stop(); }
{ const W = worldsDir("w11"), victim = path.join(root, "victim-target"), body = JSON.stringify({ operators: [] }); fs.writeFileSync(victim, body, { mode: 0o644 });
  linkFile(victim, path.join(W, ".operators.json")); const vmode = modeOf(victim), a = await start(W);
  const claim = await post(a.port, { token: tokenOf(a.log()) }, cookie(ANN));
  const got = { status: claim.status, link: fs.lstatSync(path.join(W, ".operators.json")).isSymbolicLink(), body: fs.readFileSync(victim, "utf8") === body, mode: modeOf(victim) === vmode && (WIN || vmode === 0o644),
    op: await operatorAtJoin(a.port, { headers: cookie(ANN) }), said: /symlink/.test(a.log()) };
  ok(got.status === 500 && got.link && got.body && got.mode && got.op === false && got.said,
    "SU9 a symlinked .operators.json is refused (not stored, not operator, the console says why), the link and its target unchanged", { got, log: a.log().slice(-300) });
  await a.stop(); }
}

// ---- rate limit ----
{ const W7 = worldsDir("w7"); const r = await start(W7); const codes = [];
  for (let i = 0; i < 7; i++) codes.push((await post(r.port, { token: "nope" + i }, cookie(ANN))).status);
  ok(JSON.stringify(codes.slice(0, 5)) === JSON.stringify([403, 403, 403, 403, 403]) && codes[5] === 429 && codes[6] === 429 && stored(W7) === null, "SU7 a sixth try in a minute from one address is refused (429)", codes);
  await r.stop(); }

console.log(`[setup-check] ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
