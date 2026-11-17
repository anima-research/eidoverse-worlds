// test/protocol/shard-check.ts — CI's sharded gate (shard.ts, merge-receipts.ts): shards cover SUITES exactly once whatever
// the timings say, the same way every time, and a merge passes only the whole gate at one head, every suite green.
//   bun test/protocol/shard-check.ts
import { spawnSync } from "node:child_process";
import { ENGINE } from "../gate/common.ts";
import { ORDER } from "../gate/suites.ts";
import { suite } from "../gate/suite.ts";
import { NAMES, loadTimes, merge, parseShard, partition, partitionHash, DEFAULT_SECONDS, type Receipt } from "../gate/shard.ts";

const { ok, done } = suite("shard-check");
const names = NAMES(), times = loadTimes();
const covers = (bins: string[][], want = names) => { const all = bins.flat(); return all.length === want.length && new Set(all).size === all.length && want.every((n) => all.includes(n)); };

// ---- P: the partition ----
const n18 = [1, 2, 3, 4, 5, 6, 7, 8];
ok(n18.every((n) => { const b = partition(names, times, n); return b.length === n && covers(b); }), `P1 for N = 1..8 the shards are N disjoint bins whose union is SUITES (${names.length} suites)`,
  n18.map((n) => partition(names, times, n).map((b) => b.length).join("+")).join(" "));
const stale: Record<string, number>[] = [{}, Object.fromEntries(names.map((n) => [n, NaN])), Object.fromEntries(names.map((n, i) => [n, i % 2 ? -5 : 1e9])), { "no-such-suite": 9999, [names[0]]: "x" as unknown as number }];
ok(stale.every((t) => n18.every((n) => covers(partition(names, t, n)))), "P2 timings that are empty, NaN, negative, huge, or name suites that are gone still cover SUITES exactly once (a time moves a suite, never drops one)");
const again = n18.every((n) => JSON.stringify(partition(names, times, n)) === JSON.stringify(partition([...names].reverse(), { ...times }, n)));
ok(again && partitionHash(partition(names, times, 4)) === partitionHash(partition(names, times, 4)), "P3 deterministic: the same bins (and hash) on every call, whatever order SUITES lists them in");
{ const b4 = partition(names, times, 4), moved = b4.map((b) => [...b]); moved[1].push(moved[0].shift()!);
  ok(new Set([b4, partition(names, times, 3), moved].map(partitionHash)).size === 3, "P3b the hash fingerprints the split: 3 bins, 4 bins, and 4 bins with one suite moved hash apart"); }
const w = (k: string) => times[k] ?? DEFAULT_SECONDS, total = names.reduce((a, k) => a + w(k), 0), longest = Math.max(...names.map(w));
ok(n18.every((n) => Math.max(...partition(names, times, n).map((b) => b.reduce((a, k) => a + w(k), 0))) <= total / n + longest + 1e-9), "P4 balanced: no shard weighs more than total/N + the longest suite (LPT's bound)",
  `total ${Math.round(total)} s, longest ${longest} s`);
const ps = ["2/4", "1/1", "0/4", "5/4", "4", "a/b", "1/0", "1/65", " 1/4"].map((s) => parseShard(s));
ok(typeof ps[0] === "object" && ps[0].index === 2 && ps[0].of === 4 && typeof ps[1] === "object" && ps.slice(2).every((p) => typeof p === "string"), "P5 --shard is I/N, 1-based, 1 ≤ I ≤ N ≤ 64; 0/4, 5/4, 4, a/b, 1/0, 1/65 are refused", ps);
const run = (...a: string[]) => spawnSync(process.execPath, ["test/gate/run.ts", ...a], { cwd: ENGINE, encoding: "utf8", env: { ...process.env, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" } });
const r1 = run("--shard", "5/4"), r2 = run("--shard", "1/4", "hygiene");
ok(r1.status === 2 && r2.status === 2 && /1-based|N ≤ 64/.test(r1.stdout) && /no suite names/.test(r2.stdout), "P6 run.ts refuses a bad --shard and --shard with suite names, before anything runs (exit 2)", [r1.status, r1.stdout.trim(), r2.status, r2.stdout.trim()]);

// ---- M: merging the shard receipts ----
const HEAD = "a".repeat(40);
const good = (of = 4, bins = partition(names, times, of)): { file: string; receipt: Receipt }[] => bins.map((assigned, i) => ({ file: `shard-${i + 1}.json`, receipt: {
  v: 1, verdict: "SHARD", head: HEAD, dirty: false, os: { platform: "linux", release: "x", arch: "x64" }, runtimes: {}, library: null, scratch: { dir: `/s${i}`, kept: true }, seconds: 10 + i,
  tally: { main: { pass: assigned.length, fail: 0, skip: 0 } }, notSelected: names.length - assigned.length, logSha256: "0",
  suites: assigned.map((name) => ({ name, lane: "main", status: "pass", ms: 1, leftovers: 0, outSha256: "0" })),
  shard: { index: i + 1, of, hash: partitionHash(bins), assigned } } }));
const m = (g: ReturnType<typeof good>, o: Partial<Parameters<typeof merge>[1]> = {}) => merge(g, { of: 4, head: HEAD, ...o });
const says = (r: ReturnType<typeof merge>, re: RegExp) => r.problems.length > 0 && r.merged.verdict === "FAILED" && r.problems.some((p) => re.test(p));
{ const r = m(good()); ok(r.problems.length === 0 && r.merged.verdict === "PASS" && JSON.stringify(r.merged.suites.map((x) => x.name)) === JSON.stringify(ORDER) && r.merged.shards.length === 4 && r.merged.seconds === 13 && r.merged.notSelected === 0,
  "M0 four good shards merge to PASS: every suite once, in gate order, shards listed, seconds = the slowest shard", r.problems); }
{ const g = good(); g.splice(2, 1); ok(says(m(g), /^shard 3\/4 left no receipt/), "M1 a missing shard (refused at preflight: no receipt) FAILS, named", m(g).problems.slice(0, 3)); }
{ const g = good(); const d = g[1].receipt; d.suites.push({ ...g[0].receipt.suites[0] }); ok(says(m(g), new RegExp(`^${g[0].receipt.suites[0].name}: ran 2 time`)), "M2 a suite run twice FAILS, named", m(g).problems.slice(0, 3)); }
{ const g = good(); const gone = g[3].receipt.suites.pop()!; ok(says(m(g), new RegExp(`^${gone.name}: ran 0 time`)), "M3 a suite missing from every shard FAILS, named", m(g).problems.slice(0, 3)); }
{ const g = good(); const s = g[0].receipt.suites[0]; s.status = "fail"; s.why = "exit 1"; ok(says(m(g), new RegExp(`^${s.name}: FAIL \\(exit 1\\)`)), "M4 a FAIL in one shard FAILS the merge", m(g).problems); }
{ const g = good(); g[1].receipt.suites[0].status = "skip"; ok(says(m(g), /: SKIP/), "M5 a SKIP FAILS the merge (every lane is required)", m(g).problems); }
{ const g = good(); g[2].receipt.head = "b".repeat(40); ok(says(m(g), /different heads/), "M6 shards at different heads FAIL", m(g).problems); }
{ const r = m(good(), { head: "c".repeat(40) }); ok(says(r, /not this checkout's/), "M7 shards at a head other than the merging checkout's FAIL", r.problems); }
{ const g = good(); g.push({ ...g[0], file: "again.json" }); ok(says(m(g), /^shard 1\/4 reported twice/), "M8 the same shard twice FAILS", m(g).problems.slice(0, 2)); }
{ const g = [...good(), { file: "junk.json", receipt: null as unknown as Receipt }]; ok(says(m(g), /junk\.json: not a receipt/), "M9 a file that is not a receipt FAILS", m(g).problems); }
{ const r = merge(good(4), { of: 3, head: HEAD }); ok(says(r, /but this gate is 3 shards/), "M10 receipts of a 4-way split merged as 3 FAIL", r.problems.slice(0, 2)); }
{ const lossy = partition(names, times, 4).map((b, i) => (i === 3 ? [] : b));   // a partition that dropped a bin, on both sides
  const r = m(good(4, lossy), { bins: lossy }); ok(says(r, /: ran 0 time/), "M11 coverage is checked against SUITES, not the partition: a partition that lost a bin FAILS even when every shard agrees with it", r.problems.slice(0, 2)); }
{ const g = good(); const a = g[0].receipt.shard!.assigned; g[0].receipt.shard!.assigned = a.slice(1); g[0].receipt.suites = g[0].receipt.suites.slice(1); g[1].receipt.shard!.assigned.push(a[0]); g[1].receipt.suites.push({ name: a[0], lane: "main", status: "pass", ms: 1, leftovers: 0 });
  ok(says(m(g), /^shard 1\/4: assigned/), "M12 a shard that ran another split (stale timings on its side) FAILS: assigned is recomputed here", m(g).problems.slice(0, 3)); }
{ const g = good(); g[0].receipt.shard!.hash = "f".repeat(64);   // the assigned list kept: only the fingerprint is wrong
  ok(says(m(g), /^shard 1\/4: partition f{12}, this checkout's is/), "M13 a shard whose partition hash differs (assigned unchanged) FAILS, named", m(g).problems.slice(0, 2)); }
{ const g = good(); const pr = "d".repeat(40), of = ["e".repeat(40), pr];
  for (const x of g) Object.assign(x.receipt, { prHead: pr, mergeOf: of });
  const r = m(g) as any; ok(r.merged.prHead === pr && JSON.stringify(r.merged.mergeOf) === JSON.stringify(of) && r.merged.shards.every((s: any) => s.prHead === pr),
    "M14 a pull_request run's merged receipt names the PR's head and the merge's parents (the workflow header's promise), as each shard does", { prHead: r.merged.prHead, mergeOf: r.merged.mergeOf }); }

done(`: ${names.length} suites`);
