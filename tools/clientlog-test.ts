// bun tools/clientlog-test.ts — the /clientlog tee through the REAL route(): auth, length gates, a known world
// gets its own file, an unknown label shares one, rate buckets answer 429, and a failed append answers 500 —
// never a false ok.
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, chmodSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const wd = mkdtempSync(join(tmpdir(), "clientlog-worlds-")); const ld = join(wd, ".clientlogs");
process.env.WORLDS_DIR = wd; process.env.CLIENTLOG_DIR = ld; process.env.JOIN_TOKEN = "test-door";
mkdirSync(join(wd, "known"), { recursive: true }); writeFileSync(join(wd, "known", "log.jsonl"), "");   // a world with a data dir = known
const { route } = await import("../server/routes.ts");
const ok = (v: unknown, why: string) => { if (!v) { console.error("FAIL", why); process.exit(1); } };
const srv: any = { requestIP: () => ({ address: "127.0.0.1" }), upgrade: () => false };
const post = (q: string, body = "hello", headers: Record<string, string> = { authorization: "Bearer test-door" }) =>
  route(new Request(`http://x/clientlog?${q}`, { method: "POST", body, headers: { "content-length": String(Buffer.byteLength(body)), ...headers } }), srv);
const st = async (r: Response | Promise<Response>) => (await r).status;
ok(await st(post("world=known", "hello", {})) === 401, "no Authorization → 401");
ok(await st(post("world=known", "hello", { authorization: "Bearer wrong" })) === 401, "wrong key → 401");
ok(await st(post("world=known&key=test-door")) === 400, "a key in the URL is refused (400) even when correct — the record path never carries the door");
const streamed = new Request("http://x/clientlog?world=known", { method: "POST", body: new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode("x")); c.close(); } }), duplex: "half", headers: { authorization: "Bearer test-door" } } as RequestInit);
ok(streamed.headers.get("content-length") === null && await st(route(streamed, srv)) === 411, "a streamed body (no content-length) → 411");
ok(await st(post("world=known", "y".repeat(5000))) === 413, "4 KB+ → 413");
ok(await st(post("world=known", "line one")) === 200, "known world → 200");
ok(existsSync(join(ld, "clientlog-known.log")), "known world gets its own file");
ok(await st(post("world=madeup-9x", "from nowhere")) === 200, "unknown label → accepted");
ok(!existsSync(join(ld, "clientlog-madeup-9x.log")) && existsSync(join(ld, "clientlog-~unknown.log")), "unknown label shares the '~unknown' file, never its own");
ok(await st(post("world=KNOWN", "case variant")) === 200 && readFileSync(join(ld, "clientlog-~unknown.log"), "utf8").includes("case variant") && !readFileSync(join(ld, "clientlog-known.log"), "utf8").includes("case variant"), "a case variant of a real world routes to ~unknown, not the known stream (asserted on content — path case aliases on macOS)");
const long = "w".repeat(50); mkdirSync(join(wd, long), { recursive: true }); writeFileSync(join(wd, long, "log.jsonl"), ""); await new Promise((r) => setTimeout(r, 1100));   // past the miss-relist rate limit
ok(await st(post(`world=${long}`, "long name")) === 200 && existsSync(join(ld, `clientlog-${long}.log`)), "a 50-char world name (under the 64 limit) keeps its own file");
ok(readFileSync(join(ld, "clientlog-~unknown.log"), "utf8").includes("from nowhere") && !readFileSync(join(ld, "clientlog-~unknown.log"), "utf8").includes('"ip"'), "line written, no address recorded");
for (let i = 0; i < 64; i++) await post(`world=label${i}`, "z");
ok(await st(post("world=known", "still fine")) === 200, "64 invented labels do not deny a real world (they all shared one bucket)");
let last = 200; for (let i = 0; i < 700; i++) last = await st(post("world=known", "spam"));
ok(last === 429, "per-world minute bucket → 429 after 600");
if (process.getuid?.() !== 0) {
  mkdirSync(join(wd, "fresh"), { recursive: true }); writeFileSync(join(wd, "fresh", "log.jsonl"), "");   // a known world with NO log file yet
  await new Promise((r) => setTimeout(r, 1100));                                                          // past the miss-relist rate limit
  chmodSync(ld, 0o500);                                                                                  // a read-only dir blocks creating one
  ok(await st(post("world=fresh", "into a wall")) === 500, "unwritable log dir → 500, not a false ok");
  chmodSync(ld, 0o700);
} else console.log("(root: skipping the unwritable-dir case)");
console.log("clientlog: 15 ok");
import("node:fs").then((fs) => { try { fs.rmSync(process.env.WORLDS_DIR!, { recursive: true, force: true }); } catch {} });
