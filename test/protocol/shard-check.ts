// test/protocol/shard-check.ts — CI's sharded gate (shard.ts, merge-receipts.ts): shards cover SUITES exactly once whatever
// the timings say, the same way every time, and a merge passes only the whole gate at one head, every suite green. Each OS
// packs by its own times (T), and the workflow runs every shard of each OS's split (W).
//   bun test/protocol/shard-check.ts
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ENGINE } from "../gate/common.ts";
import { ORDER } from "../gate/suites.ts";
import { suite } from "../gate/suite.ts";
import { NAMES, loadTimes, merge, parseShard, partition, partitionHash, timesFrom, DEFAULT_SECONDS, PLATFORMS, TIMES_FILE, type Receipt } from "../gate/shard.ts";
import * as S from "../gate/shard.ts";

const { ok, na, done } = suite("shard-check");
const names = NAMES(), times = loadTimes();
const covers = (bins: string[][], want = names) => { const all = bins.flat(); return all.length === want.length && new Set(all).size === all.length && want.every((n) => all.includes(n)); };

// ---- P: the partition ----
const n18 = [1, 2, 3, 4, 5, 6, 7, 8];
ok(n18.every((n) => { const b = partition(names, times, n); return b.length === n && covers(b); }), `P1 for N = 1..8 the shards are N disjoint bins whose union is SUITES (${names.length} suites)`,
  n18.map((n) => partition(names, times, n).map((b) => b.length).join("+")).join(" "));
const stale: Record<string, number>[] = [{}, Object.fromEntries(names.map((n) => [n, NaN])), Object.fromEntries(names.map((n, i) => [n, i % 2 ? -5 : 1e9])), { "no-such-suite": 9999, [names[0]]: "x" as unknown as number }];
ok(stale.every((t) => n18.every((n) => covers(partition(names, t, n)))), "P2 timings that are empty, NaN, negative, huge, or name suites that are gone still cover SUITES exactly once (a time moves a suite, never drops one)");
{ const five = names.slice(0, 5), odd = { [five[0]]: -1, [five[1]]: "bad" as unknown as number, [five[2]]: NaN, [five[3]]: 0, [five[4]]: 12.5 }, u = (S as any).untimed?.(names, odd) as string[] | undefined;
  const order = partition(five, odd, 1)[0], want = [...five.slice(0, 3)].sort((x, y) => (x < y ? -1 : 1)).concat(five[4], five[3]);   // one bin: heaviest first, so the three at the default 30 s, then 12.5, then 0
  ok(!!u && u.length === names.length - 2 && !u.includes(five[3]) && !u.includes(five[4]) && JSON.stringify(order) === JSON.stringify(want),
    "P2b the untimed count is the partition's own rule: a time that is negative, not a number or missing weighs the default and is counted untimed; 0 and 12.5 are times", { untimed: u?.length, of: names.length, order }); }
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
const good = (of = 4, bins = partition(names, times, of), platform: string = process.platform): { file: string; receipt: Receipt }[] => bins.map((assigned, i) => ({ file: `shard-${i + 1}.json`, receipt: {
  v: 1, verdict: "SHARD", head: HEAD, dirty: false, os: { platform, release: "x", arch: "x64" }, runtimes: {}, library: null, scratch: { dir: `/s${i}`, kept: true }, seconds: 10 + i,
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
// two OSes whose times certainly split the gate differently (the checked-in tables may one day agree: they are regenerated)
const TWO: Record<string, Record<string, number>> = { win32: { [names[0]]: 5000 }, linux: { [names[1]]: 5000 } }, timesOf = (p: string) => TWO[p] ?? {};
const w6 = partition(names, TWO.win32, 6), l6 = partition(names, TWO.linux, 6), split = /^shard \d\/6: (?:partition|assigned)/;
{ // M15: the merge recomputes the split with the times of the OS the shards ran on, not the merging runner's
  const asWin = merge(good(6, w6, "win32"), { of: 6, head: HEAD, times: timesOf }), relabelled = merge(good(6, w6, "linux"), { of: 6, head: HEAD, times: timesOf });
  ok(partitionHash(w6) !== partitionHash(l6) && asWin.problems.length === 0 && says(relabelled, split),
    "M15 Windows shards packed by Windows' times merge to PASS on any runner; the same receipts saying Linux FAIL (Linux's times split the gate differently)", { win: asWin.problems.slice(0, 2), relabelled: relabelled.problems.slice(0, 2) }); }
{ // M16: a stray receipt doesn't choose whose times the split is recomputed with
  const lin = good(6, l6, "linux"), stray = { file: "whole-gate.json", receipt: { ...lin[0].receipt, shard: undefined } }, wrongOf = { file: "old-split.json", receipt: { ...lin[1].receipt, shard: { ...lin[1].receipt.shard!, of: 4 } } };
  const r = merge([stray, wrongOf, ...good(6, w6, "win32")], { of: 6, head: HEAD, times: timesOf });
  ok(r.problems.length === 2 && says(r, /^whole-gate\.json: not a shard receipt/) && says(r, /^old-split\.json: shard 2\/4, but this gate is 6 shards/) && !r.problems.some((p) => split.test(p)),
    "M16 a Linux receipt that is no shard of this gate (no shard field, or another N), read before six good Windows shards, FAILS by name and nothing else: the Windows shards are still held to Windows' split", r.problems.slice(0, 4)); }
{ // M17: a shard that doesn't say its OS can't have its split checked
  const g = good(6, partition(names, timesOf(process.platform), 6)); for (const x of g) x.receipt.os = {} as Receipt["os"];
  const r = merge(g, { of: 6, head: HEAD, times: timesOf }), g1 = good(6, w6, "win32"); g1[2].receipt.os = {} as Receipt["os"]; const r1 = merge(g1, { of: 6, head: HEAD, times: timesOf });
  ok(says(r, /^shard-1\.json: shard 1\/6 doesn't say which OS it ran on/) && r.problems.length === 6 && says(r1, /^shard-3\.json: shard 3\/6 doesn't say which OS/) && r1.problems.length === 1,
    "M17 a shard receipt with no os.platform FAILS the merge, named (all six, or one among Windows shards): the merging runner's OS never stands in for it", [r.problems.slice(0, 2), r1.problems]); }

// ---- T: each OS's own times ----
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "shard-check-"));
{ const f = path.join(tmp, "times.json"); fs.writeFileSync(f, JSON.stringify({ linux: { [names[0]]: 1 }, win32: { [names[0]]: 9 } }));
  const got = { linux: loadTimes("linux", f)[names[0]], win32: loadTimes("win32", f)[names[0]], darwin: loadTimes("darwin", f) };
  ok(got.linux === 1 && got.win32 === 9 && JSON.stringify(got.darwin) === "{}", "T1 suite-times.json holds one table per OS: each OS reads its own, an OS with none reads {} (every suite then weighs the default)", got); }
{ const j = JSON.parse(fs.readFileSync(TIMES_FILE, "utf8")), cover = Object.fromEntries(PLATFORMS.map((p) => [p, names.filter((n) => Number.isFinite(j?.[p]?.[n])).length]));
  ok(PLATFORMS.every((p) => cover[p] >= 0.9 * names.length), `T2 the checked-in suite-times.json times at least 90% of the ${names.length} suites on each of ${PLATFORMS.join(", ")} (bun test/gate/shard.ts --fetch-times regenerates it)`, cover); }
{ const rec = (platform: string, suites: [string, string, number][], extra = {}) => ({ v: 1, verdict: "SHARD", head: HEAD, os: { platform }, suites: suites.map(([name, status, ms]) => ({ name, lane: "main", status, ms, leftovers: 0 })), ...extra });
  const [a, b, c] = names, d = path.join(tmp, "receipts"); fs.mkdirSync(path.join(d, "run2"), { recursive: true });
  const put = (rel: string, v: unknown) => fs.writeFileSync(path.join(d, rel), typeof v === "string" ? v : JSON.stringify(v));
  put("l1.json", rec("linux", [[a, "pass", 1000], [b, "pass", 4000]]));
  put("run2/l2.json", rec("linux", [[a, "pass", 3000], [b, "fail", 900000]]));
  put("run2/l3.json", rec("linux", [[a, "pass", 8000]]));
  put("w1.json", rec("win32", [[a, "pass", 20000], [c, "pass", 500]]));
  put("run2/w2.json", rec("win32", [[a, "pass", 30000]]));   // two samples: the median is their mean
  put("merged.json", rec("win32", [[c, "pass", 99000]], { shards: [] }));
  const t = timesFrom([d]); fs.writeFileSync(path.join(tmp, "gate.log"), "== x [main] (y) PASS 1.0 s\n");
  const refusal = (...inputs: string[]) => { try { timesFrom(inputs); return ""; } catch (e) { return (e as Error).message; } };
  const refused = refusal(path.join(tmp, "gate.log"));
  ok(t.linux?.[a] === 3 && t.linux?.[b] === 4 && t.win32?.[a] === 25 && t.win32?.[c] === 0.5 && !t.darwin && /doesn't say which OS/.test(refused),
    "T3 --times takes each OS's median per suite from the receipts (dirs walked; of two samples, their mean), counting only suites that passed and skipping a merged receipt; a gate log given by name is refused (it doesn't name its OS)", { t, refused });
  // T4: what sits beside the receipts in a directory
  put("README", "the receipts of two runs\n"); put("run2/gate.log", "== x [main] (y) PASS 1.0 s\n");
  const beside = refusal(d), same = JSON.stringify((() => { try { return timesFrom([d]); } catch { return null; } })()) === JSON.stringify(t);
  put("run2/notes.json", { suites: [] }); const noOs = refusal(d); fs.rmSync(path.join(d, "run2", "notes.json"));
  put("run2/half.json", "{\"suites\": ["); const cut = refusal(d); fs.rmSync(path.join(d, "run2", "half.json"));
  ok(beside === "" && same && /notes\.json: not a gate receipt/.test(noOs) && /half\.json: not JSON/.test(cut),
    "T4 a directory is walked for *.json only (a README and a log beside the receipts change nothing); a .json there that is no receipt, or is cut short, is refused by name, never passed over", { beside, same, noOs, cut });
  // T5: the file writeTimes leaves, and what it says of each OS
  put("run2/d1.json", rec("darwin", [[a, "fail", 900000]])); put("run2/f1.json", rec("freebsd", [[a, "pass", 7000]]));
  const f = path.join(tmp, "written.json"), was = { linux: { [a]: 99 }, darwin: { [b]: 42 }, win32: {} }; fs.writeFileSync(f, JSON.stringify(was));
  let said: string[] = []; try { said = (S as any).writeTimes([d], f); } catch (e) { said = [`threw ${(e as Error).message}`]; }
  const j = JSON.parse(fs.readFileSync(f, "utf8")), line = (re: RegExp) => said.find((l) => re.test(l)) ?? "";
  ok(JSON.stringify(Object.keys(j)) === JSON.stringify([...PLATFORMS]) && JSON.stringify(j.linux) === JSON.stringify(t.linux) && JSON.stringify(j.win32) === JSON.stringify(t.win32) && JSON.stringify(j.darwin) === JSON.stringify(was.darwin)
    && /kept: no suite passed in this OS's receipts/.test(line(/^darwin/)) && !/kept/.test(line(/^linux/)) && /^ignored: receipts from freebsd/.test(line(/^ignored/)) && fs.readdirSync(tmp).filter((n) => n.startsWith("written")).length === 1,
    "T5 writeTimes writes each OS's fresh table and nothing beside the file; an OS whose receipts passed nothing keeps its old table and is told apart from an OS with no receipt; receipts from an OS the gate has no table for are named as ignored", { said, darwin: j.darwin });
  { const tw = { linux: { [a]: 1 }, darwin: {}, win32: {} }; fs.writeFileSync(f, JSON.stringify(tw));
    const only = path.join(tmp, "only-darwin-fail"); fs.mkdirSync(only); fs.writeFileSync(path.join(only, "d.json"), JSON.stringify(rec("darwin", [[a, "fail", 1]])));
    const l = ((): string[] => { try { return (S as any).writeTimes([only], f); } catch (e) { return [`threw ${(e as Error).message}`]; } })();
    ok(/^linux .*kept: no receipt from this OS/.test(l.find((x) => /^linux/.test(x)) ?? "") && /^darwin .*kept: no suite passed/.test(l.find((x) => /^darwin/.test(x)) ?? ""), "T5b …\"no receipt from this OS\" is said only of an OS no receipt names", l); } }
{ // T6: --fetch-times reads its count, and says so when gh isn't there (PATH emptied: nothing here reaches the network or the checked-in table)
  const cli = (...a: string[]) => spawnSync(process.execPath, ["test/gate/shard.ts", ...a], { cwd: ENGINE, encoding: "utf8", env: { ...process.env, PATH: "", Path: "", BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" } });
  const before = fs.readFileSync(TIMES_FILE, "utf8"), typo = cli("--fetch-times", "typo"), zero = cli("--fetch-times", "0"), nogh = cli("--fetch-times", "3"), out = (r: typeof typo) => (r.stdout + r.stderr).trim().split("\n").slice(-2).join(" / ");
  ok(typo.status === 2 && /takes how many runs.*"typo"/.test(typo.stdout) && zero.status === 2 && /"0"/.test(zero.stdout) && nogh.status === 1 && /gh run list failed: gh could not be started/.test(nogh.stdout) && !/TypeError/.test(nogh.stdout + nogh.stderr) && fs.readFileSync(TIMES_FILE, "utf8") === before,
    "T6 --fetch-times refuses a count that is not a whole number of runs (typo, 0: exit 2, never a silent 8), and with no gh to run says so and how to get it (exit 1), not a TypeError", [typo.status, out(typo), zero.status, out(zero), nogh.status, out(nogh)]);
  // T7: the downloads' temp dir goes on every way out (a stand-in gh: its run list names one run, its downloads all fail)
  if (process.platform === "win32") na("T7 --fetch-times leaves no temp dir when every download fails", "the stand-in gh is a shell script; the exit handler that removes the dir is the same code on Windows");
  else { const bin = path.join(tmp, "bin"), td = path.join(tmp, "td"); fs.mkdirSync(bin); fs.mkdirSync(td);
    fs.writeFileSync(path.join(bin, "gh"), "#!/bin/sh\nif [ \"$2\" = list ]; then echo 111; exit 0; fi\necho 'no artifacts' >&2; exit 1\n", { mode: 0o755 });
    const r = spawnSync(process.execPath, ["test/gate/shard.ts", "--fetch-times", "1"], { cwd: ENGINE, encoding: "utf8", env: { ...process.env, PATH: bin, TMPDIR: td, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" } });
    ok(r.status === 2 && /run 111: no receipts \(no artifacts\)/.test(r.stdout) && fs.readdirSync(td).length === 0 && fs.readFileSync(TIMES_FILE, "utf8") === before,
      "T7 --fetch-times with every download failing says so, writes nothing, and leaves no temp dir behind (it exits through process.exit, which skips a finally)", { status: r.status, out: r.stdout.trim().split("\n"), left: fs.readdirSync(td) }); } }
fs.rmSync(tmp, { recursive: true, force: true });
{ // P7: --plan says the split and runs nothing (a bare --shard here would run the bin for real wherever the preflight passes, this suite among them)
  const t0 = performance.now(), r = run("--shard", "1/6", "--plan"), secs = (performance.now() - t0) / 1000, at = r.stdout.match(/partition ([0-9a-f]{12}), packed by (\w+)'s times/);
  const bins = partition(names, loadTimes(process.platform), 6), mine = partitionHash(bins).slice(0, 12), other = PLATFORMS.filter((p) => p !== process.platform && partitionHash(partition(names, loadTimes(p), 6)).slice(0, 12) !== mine);
  ok(r.status === 0 && at?.[1] === mine && at?.[2] === process.platform && r.stdout.includes(`  suites    ${bins[0].join(" ")}\n`) && !/^(?:== |-- start |runtimes)/m.test(r.stdout),
    `P7 run.ts --shard 1/6 --plan names this OS's (${process.platform}) split and its suites, and stops there: exit 0, no preflight, no suite started (its hash tells it from ${other.join(", ") || "no other OS's today: their tables split alike"})`,
    { status: r.status, secs: +secs.toFixed(1), at: at?.slice(1) ?? r.stdout.split("\n").filter((l) => /shard|FAILED/.test(l)).slice(0, 3) }); }

// ---- W: the workflow runs each OS's whole split and merges it with the same N ----
// GitHub's expansion: the lists' product, less `exclude`; then each `include` row adds its keys to every combination it doesn't
// contradict on a key the lists gave (os, shard), and a row that fits none is a combination of its own
const expand = (m: any): any[] => { const keys = Object.keys(m).filter((k) => k !== "include" && k !== "exclude");
  const base: any[] = keys.reduce((acc: any[], k) => acc.flatMap((c) => m[k].map((v: unknown) => ({ ...c, [k]: v }))), [{}]).filter((c) => !(m.exclude ?? []).some((e: any) => Object.entries(e).every(([k, v]) => c[k] === v)));
  const out = base.map((c) => ({ ...c })), alone: any[] = [];
  for (const i of m.include ?? []) { const fits = base.map((c, n) => (keys.every((k) => !(k in i) || i[k] === c[k]) ? n : -1)).filter((n) => n >= 0); if (fits.length) for (const n of fits) Object.assign(out[n], i); else alone.push({ ...i }); }
  return [...out, ...alone]; };
{ const got = expand({ os: ["a", "b"], shard: [1, 2, 3], exclude: [{ os: "b", shard: 3 }], include: [{ os: "a", of: 3 }, { os: "b", shard: 1, of: 2 }, { os: "c", shard: 9, of: 9 }] });
  const of = (o: string) => got.filter((c) => c.os === o).map((c) => `${c.shard}/${c.of}`).join(" ");
  ok(of("a") === "1/3 2/3 3/3" && of("b") === "1/2 2/undefined" && of("c") === "9/9" && got.length === 6,
    "W0 the row's reading of a matrix is GitHub's: an include row naming os and shard reaches that one job (the OS's other shards get no `of`), one naming only os reaches all of its shards, one that fits no job is a job of its own", got.map((c) => `${c.os} ${c.shard}/${c.of}`)); }
{ const y = Bun.YAML.parse(fs.readFileSync(ENGINE + ".github/workflows/protocol-gate.yml", "utf8")) as any, sm = y.jobs.shard.strategy.matrix, gm = y.jobs.gate.strategy.matrix;
  const combos = expand(sm);
  const gateOf = Object.fromEntries((gm.include ?? []).map((i: any) => [i.os, i.of]));
  const per = Object.fromEntries([...new Set(combos.map((c: any) => c.os))].map((o: any) => { const cs = combos.filter((c: any) => c.os === o), of = cs[0]?.of;
    return [o, { of, shards: cs.map((c: any) => c.shard).join(","), sameOf: cs.every((c: any) => c.of === of), gateOf: gateOf[o] }]; }));
  const steps = JSON.stringify(y.jobs.shard.steps) + JSON.stringify(y.jobs.gate.steps);
  ok(Object.values(per).every((p: any) => p.sameOf && Number.isInteger(p.of) && p.shards === Array.from({ length: p.of }, (_, i) => i + 1).join(",") && p.gateOf === p.of)
    && JSON.stringify(Object.keys(gateOf).sort()) === JSON.stringify([...sm.os].sort())
    && y.jobs.shard.name === "shard (${{ matrix.os }}, ${{ matrix.shard }})" && y.jobs.gate.name === "gate (${{ matrix.os }})" && steps.includes('--shard \\"${{ matrix.shard }}/${{ matrix.of }}\\"') && steps.includes("merge-receipts.ts --of ${{ matrix.of }}"),
    "W1 the workflow runs shards 1..N of each OS's N (run.ts --shard I/N) and merges that OS with --of N, the same N in both jobs; the jobs keep their check names (`of` would otherwise join them)", { per, names: [y.jobs.shard.name, y.jobs.gate.name] }); }

done(`: ${names.length} suites`);
