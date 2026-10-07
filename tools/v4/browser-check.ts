// tools/v4/browser-check.ts — the shared v4 core in a real browser (headless Chromium), against the same work in bun.
// A grep for node: imports isn't evidence that the client can import these files; loading them in a page is.
// One static server (this process, /shared only), one page, no world server, no WebGL. (The old-world importer,
// shared/v4/import-v1/, runs once at the operator's command, never in a browser: it isn't loaded here.)
// Checks, each computed in the page AND here, then compared:
//   1. every shared/v4 module a client runs imports (fold, hash, catalogue, toolspec, simlayer, door, names, record, …);
//   2. the page hashes with the portable sync sha256 (no Bun there), and agrees with bun's native hasher;
//   3. the lab cottage folds to the lab's digest;
//   4. the door, over in-memory storage at a pinned clock, writes a byte-identical log for the same requests.
// usage: bun tools/v4/browser-check.ts   (CHROME=<path> to pick a browser build)
import fs from "node:fs";
import { chromium } from "playwright";
import { ENGINE } from "./common.ts";
import { sha256 } from "../../shared/v4/hash.js";

const LAB_DIGEST = "22a27ab081644ca125718b3ad3e376e6b300f8c07930bd9868e01014577f663b";
const MODS = ["fold", "hash", "catalogue", "toolspec", "simlayer", "door", "names", "record", "client", "ops", "refusal"];

// the work, as one function that runs unchanged in bun and in the page (only the import base differs)
const work = async (base: string, texts: { cottage: string }) => {
  const imp = (m: string) => import(`${base}/shared/v4/${m}.js`);
  const loaded: Record<string, boolean> = {};
  const M: Record<string, any> = {};
  for (const m of ["fold", "hash", "catalogue", "toolspec", "simlayer", "door", "names", "record", "client", "ops", "refusal"]) {
    try { M[m] = await imp(m); loaded[m] = true; } catch (e) { loaded[m] = false; M[m] = String(e); }
  }
  const { readLog, fold, digest } = M.fold;
  const H = M.hash.sha256;
  const st = fold(readLog(texts.cottage));
  // the door over in-memory storage, clock pinned
  let T = 1800000000000; const lines: string[] = []; const blobs = new Map<string, string>();
  const io = { name: "mem", entries: [] as any[], now: () => T, writeLine: (l: string) => { lines.push(l); },
    getBlob: (h: string) => { const s = blobs.get(h); if (s === undefined || `sha256:${H(s)}` !== h) throw new Error("missing"); return JSON.parse(s); },
    putBlob: (v: any) => { const s = M.fold.jcs(v); const h = `sha256:${H(s)}`; if (!blobs.has(h)) blobs.set(h, s); return h; },
    // §2.4 custody, fixed test keys (a browser door holds no key file; the lab's conformance sequencer key)
    // seeded bytes for genesis's nonce and every set's salt: both sides draw the same, so the logs compare byte for byte
    random: (() => { let k = 0; return (n: number) => Uint8Array.from({ length: n }, () => (k = (k * 1103515245 + 12345) >>> 0) >>> 24); })(),
    custody: { sequencer: () => "ed25519:rRoIPhqlc8rDxC1GZlfHOe1IBJYWQ8MDNg9QuZzMsic", operator: () => "ed25519:BP7aKo17f474DD1aBSLG0a3Pb29Qs3yqQ6Ve0wSRVD0", keyOf: () => "ed25519:BP7aKo17f474DD1aBSLG0a3Pb29Qs3yqQ6Ve0wSRVD0" } };
  const w = M.door.worldOf(io);
  const reqs: [string, string, any][] = [["olive", "new", { title: "mem" }], ["olive", "set", { id: "@world", component: "roles:bob", value: { role: "builder" } }],
    ["bob", "create", { id: "table-1", model: "table", place: { at: [0, 0] } }], ["bob", "create", { id: "crate-1", model: "crate", place: { on: "table-1" } }],
    ["olive", "set", { id: "table-1", component: "lock", value: true }], ["bob", "delete", { id: "table-1" }], ["bob", "undo", {}]];
  const results = reqs.map(([a, t, x]) => { T += 100; const r = M.door.request(w, a, t, x); return r.ok ? "ok" : `refused ${r.refused?.code}`; });
  return { loaded, portable: H === M.hash.sha256Portable, abc: H("abc"), cottage: st.status === "ok" ? digest(st) : st.status,
    door: { results, log: H(lines.join("\n")), n: lines.length } };
};

const texts = {
  cottage: fs.readFileSync(ENGINE + "spec/v4/fixtures/lab-cottage.jsonl", "utf8"),
};
const here = await work("file://" + ENGINE.replace(/\/$/, ""), texts);

const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch(req) {
  const p = decodeURIComponent(new URL(req.url).pathname);
  if (p === "/") return new Response("<!doctype html><meta charset=utf-8><link rel=icon href=\"data:,\"><title>v4</title>", { headers: { "content-type": "text/html" } });
  if (!/^\/(shared)\/[A-Za-z0-9_\-./]+\.js$/.test(p) || p.includes("..")) return new Response("no", { status: 404 });
  const f = ENGINE + p.slice(1); if (!fs.existsSync(f)) return new Response("missing", { status: 404 });
  return new Response(fs.readFileSync(f), { headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" } });
} });
// playwright's own build if it's installed; else the newest headless shell already in its cache (a version bump of
// the package shouldn't fail this check for want of a download); CHROME overrides both
function fallbackChrome() {
  try { if (fs.existsSync(chromium.executablePath())) return undefined; } catch {}
  const cache = (process.env.HOME ?? "") + "/.cache/ms-playwright/";
  const dirs = fs.existsSync(cache) ? fs.readdirSync(cache).filter((d) => /^chromium_headless_shell-\d+$/.test(d)).sort((a, b) => Number(b.split("-")[1]) - Number(a.split("-")[1])) : [];
  for (const d of dirs) { const f = `${cache}${d}/chrome-headless-shell-linux64/chrome-headless-shell`; if (fs.existsSync(f)) return f; }
  return undefined;
}
let browser: any = null, page: any, fails: string[] = [], errors: string[] = [];
try {
  browser = await chromium.launch({ executablePath: process.env.CHROME ?? fallbackChrome(), args: ["--disable-gpu"] });
  page = await browser.newPage();
  page.on("pageerror", (e: any) => errors.push(`pageerror ${e.message}`));
  page.on("console", (m: any) => { if (m.type() === "error") errors.push(`console.error ${m.text()}`); });
  await page.goto(`http://127.0.0.1:${server.port}/`);
  const there: any = await Promise.race([
    page.evaluate(`(${work.toString()})(location.origin, ${JSON.stringify(texts)})`),
    new Promise((_, rej) => setTimeout(() => rej(new Error("page.evaluate timed out after 120 s")), 120_000)),
  ]);
  const ua = await page.evaluate("navigator.userAgent");
  console.log(`browser: ${String(ua).match(/(Headless)?Chrome\/[\d.]+/)?.[0] ?? ua}`);
  for (const m of MODS) if (!there.loaded[m]) fails.push(`page could not import shared/v4/${m}.js`);
  if (!there.portable) fails.push("the page used something other than the portable sha256 (Bun leaked into the browser path?)");
  if (here.portable) fails.push("bun used the portable sha256 (the native path is off)");
  const cmp: [string, any, any][] = [["sha256('abc')", here.abc, there.abc], ["cottage digest", here.cottage, there.cottage],
    ["door results", JSON.stringify(here.door.results), JSON.stringify(there.door.results)], ["door log", here.door.log, there.door.log]];
  for (const [k, a, b] of cmp) { console.log(`${a === b ? "same" : "DIFF"} ${k.padEnd(16)} bun ${String(a).slice(0, 64)}${a === b ? "" : `  page ${String(b).slice(0, 64)}`}`); if (a !== b) fails.push(`${k} differs`); }
  if (here.cottage !== LAB_DIGEST) fails.push("cottage digest is not the lab's");
  if (here.door.n < 8 || !here.door.results.includes("ok")) fails.push(`the door scenario wrote too little (${here.door.n} lines)`);
  console.log(`door: ${here.door.results.join(", ")} (${here.door.n} lines)`);
} catch (e: any) { fails.push(`probe: ${e.message}`); }
finally { try { await browser?.close(); } catch {} server.stop(true); }
for (const e of errors) { console.log(e); fails.push("page reported an error"); }
for (const f of fails) console.log(`FAIL ${f}`);
console.log(fails.length ? `browser: ${fails.length} failed` : `browser: ${MODS.length} modules import in the page; hash, fold and the door agree with bun byte for byte`);
process.exit(fails.length ? 1 : 0);
