// tools/protocol/statecache-check.ts — the derived fold cache (server/statecache.ts): a boot folds only the tail; the log stays the truth.
// usage: BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun tools/protocol/statecache-check.ts
//   SC1 a boot from a valid cache uses it, folds the tail, equals the fold from genesis, and the background re-derive agrees;
//       it is rewritten every N entries, atomically
//   SC2 a corrupted cache: unparseable → folded from genesis; a tampered state → the re-derive finds it, says BUG, discards it,
//       and the live state is the fold from genesis again; SC2b a re-derive that can't run is "couldn't verify", not a BUG
//   SC3 a cache written by another fold (foldKey) is never read; SC3b nor one whose fold sources can't be read (no throw)
//   SC4 a log cut back and regrown past the cache (another line at coversIndex) → not read
//   SC5 a purge: the cache holding the purged value leaves the disk at once; a purge after coversIndex → not read
//   SC6 a fork carries no cache, and the source's cache dropped in a fork is not read
//   SC7 a reset takes the old world's cache away
//   SC8 a backup leaves the cache out (it still verifies)
//   SC9 other doubts: a malformed line after it → not read; a malformed line before it, or an unsigned log → never written
//   SC10 boot time with and without the cache on a generated large log (numbers printed; the fold phase must shrink)
//   SC11 the re-derive runs off the event loop
// @ts-nocheck
import "./fixture-ids.ts";   // fixtures seed the ids they read (R 10-17: writers never choose ids)
import fs from "node:fs";
import path from "node:path";
import { scratch } from "./common.ts";

const root = scratch("statecache");
const W = path.join(root, "worlds");
Object.assign(process.env, { WORLDS_DIR: W, BACKUPS_DIR: path.join(root, "backups"), OPT_DIR: path.join(root, "opt"), SKIP_OPT_SWEEP: "1" });
const { request } = await import("../../shared/protocol/authority.js");
const { readLog, fold, jcs, PURGED } = await import("../../shared/protocol/fold.js");
const { chainStep } = await import("../../shared/protocol/authority/storage.js");
const { openLive } = await import("../../server/livehost.ts");
const SC = await import("../../server/statecache.ts");
const { forkWorld, resetWorld } = await import("../../server/worldlog.ts");
const { backupWorld } = await import("../../server/backups.ts");

let pass = 0, fail = 0;
const ok = (cond, what, detail?) => { if (cond) pass++; else { fail++; console.log(`  FAIL ${what}${detail !== undefined ? ` — ${JSON.stringify(detail).slice(0, 500)}` : ""}`); } };
const canon = (st) => jcs(SC.encodeState(st));
const logOf = (dir) => readLog(fs.readFileSync(path.join(dir, "world.jsonl")));
const truth = (dir) => canon(fold(logOf(dir)));
const cacheP = (dir) => path.join(dir, SC.CACHE_FILE);
const cacheOf = (dir) => JSON.parse(fs.readFileSync(cacheP(dir), "utf8"));
let now = 1800000000000;
const opts = (every) => ({ now: () => now, custodyFile: path.join(W, ".custody.json"), nameOf: () => null, kindOf: () => "human", scripts: null,
  ...(every ? { stateCache: { every } } : {}) });
/** a world in WORLDS_DIR founded by rowan, with `n` labelled things; `every` = the cache's N (0 = no cache) */
function world(name, n = 3, every = 5) {
  const dir = path.join(W, name); fs.mkdirSync(dir, { recursive: true });
  const w = openLive(dir, name, opts(every));
  const call = (verb, args = {}) => { now += 100; return request(w, "rowan", verb, args); };
  call("create-world", { title: name });
  for (let i = 0; i < n; i++) call("create", { id: `t-${i}`, components: { label: `thing ${i}` } });
  return { dir, w, call };
}
const reopen = (dir, every = 5) => openLive(dir, path.basename(dir), opts(every));
/** run f with console.warn/error captured */
async function said(f) { const lines = [], ow = console.warn, oe = console.error; console.warn = console.error = (...a) => lines.push(a.join(" "));
  try { return { r: await f(), lines }; } finally { console.warn = ow; console.error = oe; } }

// ---- SC1 ----
{ const { dir, w, call } = world("a", 3, 5);
  ok(fs.existsSync(cacheP(dir)) && cacheOf(dir).coversIndex >= w.entries.length - 5, "SC1 the cache is written every N (5) entries", fs.existsSync(cacheP(dir)) && cacheOf(dir).coversIndex);
  w.saveCache(); const at = cacheOf(dir).coversIndex;
  ok(at === w.entries.length - 1 && !fs.readdirSync(dir).some((f) => f.endsWith(".tmp")), "SC1 saveCache covers the last line, and leaves no temp file", { at, n: w.entries.length });
  call("set", { id: "t-1", component: "label", value: "after the cache" }); call("create", { id: "t-9", components: { label: "tail" } });
  const b = reopen(dir, 1000);
  ok(b.bootedFromCache === at && canon(b.state()) === truth(dir) && b.state().entities["t-9"]?.c.label === "tail",
    "SC1 a boot from the cache folds the tail onto it and equals the fold from genesis", { from: b.bootedFromCache, at });
  ok(await b.cacheChecked === true, "SC1 the background re-derive agrees with it");
  const off = reopen(dir, 0);
  ok(off.bootedFromCache == null && canon(off.state()) === truth(dir), "SC1 control: no stateCache option, no cache read"); }

// ---- SC2 ----
{ const { dir, w } = world("b", 3, 1000); w.saveCache();
  fs.writeFileSync(cacheP(dir), "{ not json");
  const { r: b, lines } = await said(() => reopen(dir));
  ok(b.bootedFromCache == null && canon(b.state()) === truth(dir) && lines.some((l) => /fold cache not used \(it doesn't parse\)/.test(l)),
    "SC2 an unparseable cache: folded from genesis (equal to the fold), and said", lines);
  SC.writeCache(dir, w.entries, w.state()); const c = cacheOf(dir); c.state.entities["t-0"].c.label = { v: "a lie" }; fs.writeFileSync(cacheP(dir), JSON.stringify(c));
  const { r: x, lines: l2 } = await said(async () => { const x = reopen(dir); x.lied = x.state().entities["t-0"].c.label; x.checked = await x.cacheChecked; return x; });
  ok(x.bootedFromCache === c.coversIndex && x.lied === "a lie", "SC2 (setup) a tampered cache that passes the boot checks is booted from", { from: x.bootedFromCache, lied: x.lied });
  ok(x.checked === false && canon(x.state()) === truth(dir) && x.state().entities["t-0"].c.label === "thing 0" && !fs.existsSync(cacheP(dir)) && l2.some((l) => /BUG: the fold cache/.test(l)),
    "SC2 …the re-derive finds it: BUG said, the cache discarded, the live state the fold from genesis", { checked: x.checked, label: x.state().entities["t-0"].c.label, lines: l2 }); }

// ---- SC2b (review L16): a re-derive that can't run (here: the log away when the Worker reads it) is not a disagreement ----
{ const { dir, w } = world("b2", 3, 1000); w.saveCache(); const log = path.join(dir, "world.jsonl");
  const { r: x, lines } = await said(async () => { const x = reopen(dir); fs.renameSync(log, `${log}.away`); x.checked = await x.cacheChecked; fs.renameSync(`${log}.away`, log); return x; });
  ok(x.bootedFromCache != null && x.checked === null && fs.existsSync(cacheP(dir)) && !lines.some((l) => /BUG/.test(l)) && lines.some((l) => /couldn't be verified/.test(l)),
    "SC2b a re-derive that fails to run says it couldn't verify, keeps the cache and the booted state (no BUG, no refold)", { checked: x.checked, from: x.bootedFromCache, lines }); }

// ---- SC3 ----
{ const { dir, w } = world("c", 3, 1000); w.saveCache();
  const c = cacheOf(dir); c.foldKey = "another fold"; c.state.entities["t-0"].c.label = { v: "read by another fold" }; fs.writeFileSync(cacheP(dir), JSON.stringify(c));
  const { r: b, lines } = await said(() => reopen(dir));
  ok(b.bootedFromCache == null && canon(b.state()) === truth(dir) && lines.some((l) => /another fold/.test(l)), "SC3 a cache from another fold (foldKey) is not read: the boot is the fold from genesis", { from: b.bootedFromCache, lines }); }

// ---- SC3b (review L17): a fold source that can't be read refuses the cache (said once, the failure memoised), never throws ----
{ const { dir, w } = world("c2", 3, 1000); w.saveCache();
  const code = `import fs from "node:fs"; let n = 0; const r = fs.readFileSync;
    fs.readFileSync = (p, ...a) => String(p).endsWith("/shared/protocol/fold.js") ? (n++, (() => { throw new Error("EACCES: unreadable"); })()) : r(p, ...a);
    const SC = await import(${JSON.stringify(new URL("../../server/statecache.ts", import.meta.url).href)}); const why = [];
    const a = SC.readCacheFile(${JSON.stringify(dir)}, (s) => why.push(s)), b = SC.readCacheFile(${JSON.stringify(dir)}, (s) => why.push(s));
    console.log(JSON.stringify({ a, b, why, n }));`;
  const p = Bun.spawnSync([process.execPath, "-e", code], { env: { ...process.env, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" } });
  let o = null; try { o = JSON.parse(p.stdout.toString().trim().split("\n").pop()); } catch { /* says below */ }
  ok(p.exitCode === 0 && o?.a === null && o.b === null && o.why.length === 2 && o.why.every((l) => /can't be read/.test(l)) && o.n === 1,
    "SC3b an unreadable fold source: the cache is refused with why (no throw), and the failure is memoised (one read)", { exit: p.exitCode, o, err: p.stderr.toString().slice(0, 300) }); }

// ---- SC4 ----
{ const { dir, w, call } = world("d", 4, 1000); const t0 = now;
  for (let i = 0; i < 4; i++) call("set", { id: `t-${i}`, component: "label", value: `first ${i}` });
  w.saveCache(); const at = cacheOf(dir).coversIndex;
  const lines = fs.readFileSync(path.join(dir, "world.jsonl"), "utf8").split("\n"); fs.writeFileSync(path.join(dir, "world.jsonl"), lines.slice(0, at - 3).join("\n") + "\n");   // a repair --rollback, say
  const g = reopen(dir, 0); now = t0; const call2 = (v, a) => { now += 100; return request(g, "rowan", v, a); };
  for (let i = 0; i < 6; i++) call2("set", { id: `t-${i % 4}`, component: "label", value: `second ${i}` });
  const b = reopen(dir);
  ok(g.entries.length > at && b.bootedFromCache == null && canon(b.state()) === truth(dir) && b.state().entities["t-0"].c.label === "second 4",
    "SC4 a log cut back and regrown past the cache (another head at coversIndex): not read, the fold from genesis", { n: g.entries.length, at, from: b.bootedFromCache }); }

// ---- SC5 ----
{ const { dir, w, call } = world("e", 2, 5);
  call("set", { id: "t-0", component: "label", value: "a secret" }); const seq = w.entries.length - 1;
  w.saveCache(); ok(fs.readFileSync(cacheP(dir), "utf8").includes("a secret"), "SC5 (setup) the cache holds the value");
  w.append({ kind: "purge", actor: "system", verb: "purge", body: { values: [{ seq }] } });
  ok(!fs.existsSync(cacheP(dir)) || !fs.readFileSync(cacheP(dir), "utf8").includes("a secret"), "SC5 a purge takes the purged value off the disk's cache at once (§12)");
  const p = world("e2", 2, 1000); p.call("set", { id: "t-1", component: "label", value: "purge me" }); const s2 = p.w.entries.length - 1;
  p.call("create", { id: "t-8", components: { label: "more" } }); p.w.saveCache();
  const q = reopen(p.dir, 0); q.append({ kind: "purge", actor: "system", verb: "purge", body: { values: [{ seq: s2 }] } });
  const b = reopen(p.dir);
  ok(b.bootedFromCache == null && b.state().entities["t-1"].c.label === PURGED && canon(b.state()) === truth(p.dir),
    "SC5 a purge after the cache (written by a host without it): not read; the purged value is purged", { from: b.bootedFromCache, label: b.state().entities["t-1"].c.label }); }

// ---- SC6 / SC7 / SC8 ----
{ const { dir, w } = world("f", 3, 1000); w.saveCache();
  const r = forkWorld({ name: "f", live: w }, "f-copy", "rowan"); const copy = path.join(W, "f-copy");
  ok(r.ok && !fs.existsSync(cacheP(copy)), "SC6 a fork carries no cache (the copy derives its own)", r);
  { const c = reopen(copy, 0); for (let i = 0; i < 6; i++) { now += 100; request(c, "rowan", "create", { id: `f-${i}`, components: { label: "the fork's own" } }); }
    ok(c.entries.length > cacheOf(dir).coversIndex, "SC6 (setup) the fork's log grows past the line the source's cache covers"); }
  fs.copyFileSync(cacheP(dir), cacheP(copy));
  const { r: b } = await said(() => reopen(copy));
  ok(b.bootedFromCache == null && canon(b.state()) === truth(copy), "SC6 the source's cache dropped into the fork is not read", { from: b.bootedFromCache });
  const bk = backupWorld(W, "f-copy", { backupsDir: path.join(root, "backups") });
  ok(fs.existsSync(cacheP(copy)) && !fs.existsSync(cacheP(bk.dir)) && !fs.readFileSync(path.join(bk.dir, "SHA256SUMS"), "utf8").includes(SC.CACHE_FILE),
    "SC8 a backup leaves the cache out, and verifies", bk);
  const arch = resetWorld({ name: "f", live: w });
  ok(!fs.existsSync(cacheP(dir)) && !fs.existsSync(cacheP(arch)), "SC7 a reset takes the old world's cache away (the fresh world derives its own)", fs.readdirSync(dir)); }

// ---- SC9 ----
{ const { dir, w, call } = world("g", 2, 1000); w.saveCache(); const at = cacheOf(dir).coversIndex;
  call("create", { id: "t-5", components: { label: "x" } }); const bad = w.entries.length; fs.appendFileSync(path.join(dir, "world.jsonl"), "{\"not\": \"an entry\"}\n");
  const { r: b, lines } = await said(() => reopen(dir));
  ok(b.bootedFromCache == null && canon(b.state()) === truth(dir) && lines.some((l) => new RegExp(`line ${bad} is malformed`).test(l)), "SC9 a malformed line after the cache: not read", lines);
  now += 100; request(b, "rowan", "create", { id: "t-6", components: { label: "signed, after the bad line" } }); b.saveCache();
  ok(typeof b.entries.at(-1).head === "string" && (!fs.existsSync(cacheP(dir)) || cacheOf(dir).coversIndex === at), "SC9 …and a log with a malformed line is never cached");
  const u = path.join(W, "g-unsigned"); fs.mkdirSync(u);
  fs.writeFileSync(path.join(u, "world.jsonl"), logOf(path.join(W, "a")).map(({ head, sig, ...e }) => JSON.stringify(e)).join("\n") + "\n");
  const x = reopen(u); x.saveCache(); ok(!fs.existsSync(cacheP(u)), "SC9 an unsigned log (no head to check) is never cached"); }

// ---- SC10 / SC11: a generated large log ----
{ const K = Number(process.env.SC_ENTRIES ?? 60000);
  const { dir, w } = world("big", 50, 0); const lines = [];
  let head = w.headAt(w.entries.length - 1); const cause = w.entries.findIndex((e) => e.kind === "act" && e.verb === "create");
  for (let i = 0; i < K; i++) { const e = { world: w.worldId, kind: "change", actor: "rowan", cause, verb: "set", body: { id: `t-${i % 50}`, comp: "label", value: `label ${i}`, salt: "AAAAAAAAAAAAAAAAAAAAAA" }, ts: ++now };
    head = chainStep(head, e); lines.push(JSON.stringify({ ...e, head })); }
  fs.appendFileSync(path.join(dir, "world.jsonl"), lines.join("\n") + "\n");
  const time = (f) => { const a = performance.now(); const r = f(); return [performance.now() - a, r]; };
  const best = (f) => Math.min(...[0, 1, 2].map(() => time(f)[0]));
  reopen(dir, 1000).saveCache();
  const entries = logOf(dir);
  const foldMs = best(() => fold(entries)), resumeMs = best(() => SC.resumeFold(SC.readCache(dir, entries, () => {}), entries, () => {}));
  const offMs = best(() => reopen(dir, 0)), onMs = best(() => reopen(dir, 1000));
  console.log(`  SC10 ${entries.length} entries, ${(fs.statSync(path.join(dir, "world.jsonl")).size / 1e6).toFixed(1)} MB: boot ${offMs.toFixed(0)} ms without the cache, ${onMs.toFixed(0)} ms with it; the fold ${foldMs.toFixed(1)} ms from genesis, ${resumeMs.toFixed(1)} ms from the cache`);
  ok(resumeMs * 3 < foldMs, "SC10 the cache cuts the boot's fold phase to under a third (the whole boot is printed, not asserted: parse dominates it)", { foldMs, resumeMs, offMs, onMs });
  const b = reopen(dir, 1000);
  const first = await Promise.race([b.cacheChecked.then(() => "done"), new Promise((r) => setTimeout(() => r("pending"), 0))]);
  ok(first === "pending", "SC11 the boot returns before the re-derive has run (it is not on the boot's path)", first);
  let maxLag = 0, last = performance.now();
  const tick = setInterval(() => { const t = performance.now(); maxLag = Math.max(maxLag, t - last); last = t; }, 5);
  const [, p] = time(() => b.cacheChecked); const t0 = performance.now(); const agreed = await p; const tookMs = performance.now() - t0; clearInterval(tick);
  console.log(`  SC11 the re-derive took ${tookMs.toFixed(0)} ms; the event loop's longest gap meanwhile ${maxLag.toFixed(0)} ms`);
  ok(agreed === true && maxLag < 100 && tookMs > maxLag * 2, "SC11 the re-derive runs off the event loop (agrees; no long gap while it runs)", { agreed, maxLag, tookMs }); }

console.log(`\n${fail ? `FAIL ${fail}` : "ok"}: ${pass} passed${fail ? `, ${fail} failed` : ""}`);
process.exit(fail ? 1 : 0);
