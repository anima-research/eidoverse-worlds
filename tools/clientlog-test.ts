// bun tools/clientlog-test.ts — the /clientlog tee through the REAL route(): the door (auth), the budget (rate, size,
// scrub, disk; server/clientlog.ts), a known world's own directory, an unknown label's shared one, no read path, and a
// failed append answering 500 — never a false ok. The budget's numbers: RESEARCH-clientlog-budget-conventions-2026-11-03.
import { mkdtempSync, existsSync, readFileSync, utimesSync, readdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tryUntil } from "./protocol/wait.ts";
const wd = mkdtempSync(join(tmpdir(), "clientlog-worlds-")); const ld = join(wd, ".clientlogs");
process.env.WORLDS_DIR = wd; process.env.CLIENTLOG_DIR = ld; process.env.JOIN_TOKEN = "test-door";
const { foundWorlds } = await import("./harness.ts");
foundWorlds(wd, ["known"]);   // a world with a log (world.jsonl) = known
const { route } = await import("../server/routes.ts");
const { hnSessions } = await import("../server/auth.ts");
const { ClientLogStore, ClientLogRate, ipBucketKey, scrub, boundLines, LIMITS } = await import("../server/clientlog.ts");
const { tickStats } = await import("../server/tick.ts");
let n = 0;
const ok = (v: unknown, why: string) => { if (!v) { console.error("FAIL", why); process.exit(1); } n++; };
let ip = "10.0.0.1";   // each row its own address unless it is about the address
const srv: any = { requestIP: () => ({ address: ip }), upgrade: () => false };
const post = (q: string, body = "hello", headers: Record<string, string> = { authorization: "Bearer test-door" }, cl = String(Buffer.byteLength(body))) =>
  route(new Request(`http://x/clientlog?${q}`, { method: "POST", body, headers: { "content-length": cl, ...headers } }), srv);
const st = async (r: Response | Promise<Response>) => (await r).status;
let sid = 0;
const session = (sub = `human:u_${++sid}`) => { const id = sid.toString(16).padStart(64, "b"); hnSessions.set(id, { sub, name: "tester", scopes: ["worlds:join"], exp: Date.now() + 60_000 }); return { cookie: `ew_sess=${id}`, "sec-fetch-site": "same-origin" }; };
const logs = (world: string) => existsSync(join(ld, world)) ? readdirSync(join(ld, world)).map((f) => readFileSync(join(ld, world, f), "utf8")).join("") : "";

// ---- the door, as before
ok(await st(post("world=known", "hello", {})) === 401, "A1 no Authorization → 401");
ok(await st(post("world=known", "hello", { authorization: "Bearer wrong" })) === 401, "A2 wrong key → 401");
const s1 = session("human:u_test");
ok(await st(post("world=known", "from a session", s1)) === 200, "A3 a signed-in session with no door key → 200 (any session may post)");
ok(await st(post("world=known", "cross-site", { ...s1, "sec-fetch-site": "same-site" })) === 401, "A4 a session cookie from another origin → 401");
ok(await st(post("world=known&key=test-door")) === 400, "A5 a key in the URL is refused (400) even when correct");
ok(logs("known").includes("from a session") && existsSync(join(ld, "known", "human-u_test.log")), "A6 a session's lines land in <world>/<account>.log");

// ---- size: 256 KB by Content-Length, then by the bytes themselves; lines cut inside
ip = "10.0.1.1";
const streamed = new Request("http://x/clientlog?world=known", { method: "POST", body: new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode("x")); c.close(); } }), duplex: "half", headers: { authorization: "Bearer test-door" } } as RequestInit);
ok(streamed.headers.get("content-length") === null && await st(route(streamed, srv)) === 411, "S1 a streamed body (no content-length) → 411");
ok(await st(post("world=known", "y".repeat(300 * 1024))) === 413, "S2 300 KB by Content-Length → 413");
ip = "10.0.1.2";
ok(await st(post("world=known", "y".repeat(300 * 1024), undefined, "100")) === 413, "S3 300 KB behind a Content-Length that says 100 → 413 (counted while reading)");
ip = "10.0.1.3";
ok(await st(post("world=known", "k".repeat(100 * 1024))) === 200, "S4 a 100 KB body is taken (the old 4 KB cap would have refused it)");
ip = "10.0.1.4";
ok(await st(post("world=known", "L".repeat(2500) + "\nshort")) === 200 && logs("known").includes(`${"L".repeat(2000)} …[cut at 2000 chars]`) && !logs("known").includes("L".repeat(2001)) && logs("known").includes('"short"'), "S5 a 2500-char line keeps its first 2000 and a cut mark; the line after it is kept");
ip = "10.0.1.5";
const many = Array.from({ length: 2500 }, (_, i) => `line${i}`).join("\n");
ok(await st(post("world=known", many)) === 200 && logs("known").includes('"line0"') && logs("known").includes('"line2499"') && logs("known").includes("…[501 lines cut]") && !logs("known").includes('"line1250"'), "S6 2500 lines keep the head and the tail with the cut marked");
ok(boundLines("a\nb").cut === 0, "S7 lines within the limits are not cut");

// ---- rate: per address (IPv6 by /64) before the body is read; per sender, 3 in a row
ip = "10.0.2.1";
let last = 200; for (let i = 0; i < 30; i++) last = await st(post(`world=known`, "z", session()));
ok(last === 200, "R1 30 posts in 10 min from one address (30 accounts) are taken");
const r31 = await post("world=known", "y".repeat(300 * 1024), session());
ok(r31.status === 429 && /^\d+$/.test(r31.headers.get("retry-after") ?? "") && Number(r31.headers.get("retry-after")) >= 1, `R2 the 31st → 429 with Retry-After in seconds, before its (oversized) body is looked at (got ${r31.status}, ${r31.headers.get("retry-after")})`);
ip = "2001:db8:1:2:aaaa::1"; for (let i = 0; i < 30; i++) await post("world=known", "v6", session());
ip = "2001:db8:1:2:ffff::9";
ok(await st(post("world=known", "same /64", session())) === 429, "R3 IPv6 is bucketed by /64: a second host address in the /64 shares the 30");
ok(ipBucketKey("2001:db8:1:2:aaaa::1") === "2001:db8:1:2::/64" && ipBucketKey("::ffff:1.2.3.4") === "1.2.3.4" && ipBucketKey("fe80::1%eth0") === "fe80:0:0:0::/64", "R4 ipBucketKey: /64, an IPv4-mapped address, a zone id");
ok(ipBucketKey("::ffff:102:304") === "1.2.3.4" && ipBucketKey("::FFFF:C0A8:1") === "192.168.0.1", "R4b a hex-form mapped IPv4 is that IPv4's own bucket, not every mapped client in 0:0:0:0::/64");
ip = "10.0.2.2";
const s2 = session();
const burst = []; for (let i = 0; i < 11; i++) burst.push(await st(post("world=known", `e${i}`, s2)));
ok(burst.join() === "200,".repeat(10) + "429", `R5 a sender posts 10 in a row, the 11th → 429 (got ${burst.join()})`);
ip = "10.0.2.3";
const keyed = []; for (let i = 0; i < 11; i++) keyed.push(await st(post("world=known", `k${i}`)));
ok(keyed.join() === "200,".repeat(10) + "429", `R5b a door-key caller is a sender by its address: the same 10 (got ${keyed.join()})`);
const rate = new ClientLogRate(); const t0 = 1_000_000;
for (let i = 0; i < 10; i++) rate.admit("1.1.1.1", "s", t0);
ok(rate.admit("1.1.1.1", "s", t0) === 20 && rate.admit("1.1.1.1", "s", t0 + 20_000) === null && rate.admit("1.1.1.1", "s", t0 + 20_000) === 20, "R7 a sender's token returns one every 20 s (30 per 10 min); Retry-After says 20");
{ const r2 = new ClientLogRate(); for (let i = 0; i < 30; i++) r2.admit("2.2.2.2", "flood", t0);
  ok(r2.admit("2.2.2.2", "quiet", t0) === null, "R8b a sender refused by its own bucket spends nothing from the address: a neighbour behind the same address still posts"); }
ok(rate.admit("1.1.1.1", "other", t0) === null && rate.admit("1.1.1.2", "s", t0 + 20_001) !== null, "R8 another sender on the same address is its own bucket; a sender's bucket is the sender's across addresses");

// ---- scrub at ingest; a private key refuses the whole request
ip = "10.0.3.1";
ok(await st(post("world=known", 'login password=hunter2 ok; {"token":"abc123","n":1} Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig_part_here cookie: ew_sess=deadbeef')) === 200, "C1 a line with secrets is taken");
const stored = logs("known");
ok(stored.includes("password=[Filtered] ok") && stored.includes('\\"token\\":\\"[Filtered]\\"') && stored.includes("Authorization: [Filtered]") && stored.includes("cookie: [Filtered]") && !stored.includes("hunter2") && !stored.includes("abc123") && !stored.includes("eyJhbGci") && !stored.includes("deadbeef") && stored.includes("4 values scrubbed"), "C2 …and stored with each value [Filtered], the keys and the rest of the line kept, the count noted");
ip = "10.0.3.2";
ok(await st(post("world=known", "GET https://user:pw@turn.example/x?access_token=sekret&y=1 iceServers credential: turnpass urls=turn:turn.example")) === 200, "C3 URL auth and ICE credentials are taken");
const s3 = logs("known");
ok(s3.includes("https://[Filtered]@turn.example/x?access_token=[Filtered]&y=1") && s3.includes("credential: [Filtered] urls=turn:turn.example") && !s3.includes("sekret") && !s3.includes("turnpass"), "C4 …user:pass@ and ?access_token= and credential: are [Filtered]");
ok(scrub("cookie: a=1; ew_sess=deadbeef12; b=2").text === "cookie: [Filtered]" && scrub('{"cookie":"a=1; ew_sess=deadbeef12","n":1}').text === '{"cookie":"[Filtered]","n":1}' && scrub("set-cookie: ew_sess=deadbeef12; Path=/; HttpOnly").text === "set-cookie: [Filtered]", "C5b a cookie header is filtered whole: the session id after a `;` never lands");
ok(scrub("[authority] 3 pending, author: bob, token_v2=abc").text === "[authority] 3 pending, author: bob, token_v2=[Filtered]", "C5 'authority' and 'author' are words, not keys; token_v2 is a key");
ip = "10.0.3.3";
const pem = `oops\n-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----\n`;
const rp = await post("world=known", pem);
ok(rp.status === 400 && /private key/.test(await rp.text()) && !logs("known").includes("MIIEow") && !logs("known").includes("oops"), "C6 a private-key block → 400 with a plain reason, nothing of that request stored");

// ---- disk: a sender's newest 2 MB, the store's newest 200 MB oldest-first, 14 days; a new line never waits
const sd = join(wd, "store"); const store = new ClientLogStore(sd, { senderBytes: 1000, totalBytes: 2500, keepMs: 14 * 86_400_000 });
const line = (tag: string, i: number) => `${tag}${String(i).padStart(3, "0")}\n`;
for (let i = 0; i < 300; i++) store.append("w", "a", line("a", i), t0 + i);
const aText = readFileSync(join(sd, "w", "a.log"), "utf8");
ok(store.bytesOf("w", "a") <= 1000 && aText.endsWith("a299\n") && !aText.includes("a000") && aText.startsWith("a"), `D2 a sender past its share keeps its newest lines (${store.bytesOf("w", "a")} bytes, ends a299)`);
store.append("w", "b", "b".repeat(900) + "\n", t0 + 1000); store.append("x", "c", "c".repeat(900) + "\n", t0 + 2000);
ok(!existsSync(join(sd, "w", "a.log")) && existsSync(join(sd, "w", "b.log")) && existsSync(join(sd, "x", "c.log")) && store.totalSize <= 2500, "D3 the store past its cap drops the OLDEST sender's file first; the new line landed");
store.append("w", "b", "more\n", t0 + 3000);
ok(readFileSync(join(sd, "w", "b.log"), "utf8").endsWith("more\n"), "D4 …and keeps taking lines (never 'full')");
const old = join(sd, "x", "c.log"); utimesSync(old, new Date(t0), new Date(t0));
const store2 = new ClientLogStore(sd, store.caps); store2.retire(t0 + 15 * 86_400_000);
ok(!existsSync(old) && existsSync(join(sd, "w", "b.log")), "D5 a file 15 days old is retired; a 3-second-old one stays (a fresh store scans what is on disk)");
// ---- the rails are settings (0 = off), and the 14 days hold on the clock, not only on a post
{ utimesSync(join(sd, "w", "b.log"), new Date(t0), new Date(t0)); const k2 = new ClientLogStore(sd, { ...store.caps, keepMs: 0 }); k2.retire(t0 + 400 * 86_400_000);
  ok(existsSync(join(sd, "w", "b.log")), "D6 CLIENTLOG_KEEP_DAYS=0: a file a year old stays (the size caps alone evict)"); }
ok(tickStats().systems.some((s) => s.name === "clientlog-retire" && s.everyMs === 3_600_000), "D7 retention is a registered hourly system: an idle server retires too");
{ const r3 = new ClientLogRate(); LIMITS.ipPer10Min = 0; let refused = 0; for (let i = 0; i < 40; i++) if (r3.admit("3.3.3.3", `t${i}`, t0) !== null) refused++; LIMITS.ipPer10Min = 30;
  ok(refused === 0, `R9 CLIENTLOG_IP_PER_10MIN=0: no address bucket, forty tabs behind one NAT all post (${refused} refused)`); }
{ const r = Bun.spawnSync(["bun", "-e", `const { LIMITS } = await import(${JSON.stringify(new URL("../server/clientlog.ts", import.meta.url).href)}); console.log(JSON.stringify([LIMITS.ipPer10Min, LIMITS.senderPer10Min, LIMITS.keepMs]));`],
    { env: { ...process.env, CLIENTLOG_IP_PER_10MIN: "0", CLIENTLOG_SENDER_PER_10MIN: "5", CLIENTLOG_KEEP_DAYS: "0", BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" }, stdout: "pipe", stderr: "pipe" });
  ok(r.stdout.toString().trim() === "[0,5,0]", `R9b the three names are read from the environment (got ${r.stdout.toString().trim()} ${r.stderr.toString().slice(0, 200)})`); }

// ---- worlds and labels, as before
ip = "10.0.4.1";
ok(await st(post("world=madeup-9x", "from nowhere")) === 200 && !existsSync(join(ld, "madeup-9x")) && logs("~unknown").includes("from nowhere"), "W1 an unknown label is taken into '~unknown', never a directory of its own");
ok(await st(post("world=KNOWN", "case variant")) === 200 && logs("~unknown").includes("case variant") && !logs("known").includes("case variant"), "W2 a case variant of a real world routes to ~unknown (asserted on content — path case aliases on macOS)");
const long = "w".repeat(50); foundWorlds(wd, [long]); ip = "10.0.4.2";
ok(await st(post(`world=${long}`, "long name")) === 200 && existsSync(join(ld, long)), "W3 a 50-char world name (under the 64 limit) keeps its own directory");
ok(!logs("~unknown").includes('"ip"') && !logs("~unknown").includes("10.0.4"), "W4 no address recorded");
for (let i = 0; i < 64; i++) { ip = `10.0.5.${i + 1}`; await post(`world=label${i}`, "z"); }
ip = "10.0.6.1";
ok(await st(post("world=known", "still fine")) === 200, "W5 64 invented labels do not deny a real world");

// ---- read: no route serves a stored log; it is the operator's, on the box
const get = (p: string) => st(route(new Request(`http://x${p}`, { headers: { authorization: "Bearer test-door" } }), srv));
ok(await get("/clientlog") !== 200 && await get("/clientlog?world=known") !== 200, "G1 GET /clientlog is not a read");
ok(await get("/.clientlogs/known/human-u_test.log") !== 200 && await get("/worlds/.clientlogs/known/human-u_test.log") !== 200 && await get("/known/.clientlogs/human-u_test.log") !== 200, "G2 no static path reaches the store");

{
  ip = "10.0.7.1";
  foundWorlds(wd, ["fresh"]);   // a known world with NO client-log directory yet
  writeFileSync(join(ld, "fresh"), "");   // a file where the world's directory goes: blocks it on every OS, root included
  try { ok(await st(post("world=fresh", "into a wall", session())) === 500, "E1 unwritable log dir → 500, not a false ok"); }
  finally { rmSync(join(ld, "fresh"), { force: true }); }
}

// ---- the client's side (client/lib/base.js): one POST per flush, 429's Retry-After honoured with the lines kept
const calls: { body: string }[] = []; let answer = () => new Response("ok");
(globalThis as any).fetch = (_u: string, init: any) => { calls.push({ body: String(init.body) }); return Promise.resolve(answer()); };
const { tee, teeNow, teeOnHide, CONFIG } = await import("../client/lib/base.js");
CONFIG.name = "tester"; CONFIG.token = "test-door";
tee("one"); tee("two"); teeNow("three");
ok(calls.length === 1 && calls[0]!.body === "tester one\ntester two\ntester three", `T1 three lines go as ONE POST, newline-joined (got ${calls.length} calls)`);
tee("h1"); tee("h2"); teeOnHide();
ok(calls.length === 2 && calls[1]!.body === "tester h1\ntester h2", `T1b the page hiding sends what's queued at once, not after the 10 s batch (got ${calls.length} calls)`);
answer = () => new Response("slow down", { status: 429, headers: { "retry-after": "1" } });
teeNow("r1"); await Promise.resolve();   // the stub's reply is a settled promise: one tick and the 429 has been read
answer = () => new Response("ok"); teeNow("r2");
ok(calls.length === 3, `T3 a 429 with Retry-After pauses the tee: a flush inside the wait sends nothing (got ${calls.length} calls)`);
ok(await tryUntil("the kept lines go after Retry-After", () => (calls.length === 4 ? true : undefined), { ms: 5000 }) && calls[3]!.body === "tester r1\ntester r2", `T4 …and after the wait the 429's lines and the one queued meanwhile go as one POST (got ${JSON.stringify(calls[3]?.body)})`);
console.log(`clientlog: ${n} ok`);
try { (await import("node:fs")).rmSync(wd, { recursive: true, force: true }); } catch {}
process.exit(0);   // the tee's 429 wait is a live timer
