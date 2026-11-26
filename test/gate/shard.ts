// test/gate/shard.ts — the gate split over N CI jobs: which suites shard I/N runs (1-based: 1/6 … 6/6), and whether
// N shard receipts add up to the gate (merge-receipts.ts). Suites are LPT bin-packed by suite-times.json, by the times of the
// OS the shard runs on (party-probe is ~11 min on Linux and ~50 s on Windows); a time only moves a suite between shards,
// never in or out of the gate. shard-check.ts holds the rows.
//   bun test/gate/shard.ts --times <receipt.json | dir>…   rewrite suite-times.json from shard receipts: each OS's median of each suite that passed
//   bun test/gate/shard.ts --fetch-times [runs]           the same from the shard receipts of the last [8] green protocol-gate runs upstream (gh)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { ENGINE } from "./common.ts";
import { SUITES, ORDER } from "./suites.ts";

export const TIMES_FILE = ENGINE + "test/gate/suite-times.json";
export const DEFAULT_SECONDS = 30;   // a suite the timings don't know yet
export const NAMES = () => SUITES.map(([n]) => n);
/** The OSes CI runs the gate on, as process.platform names them: suite-times.json has one table each. */
export const PLATFORMS = ["linux", "darwin", "win32"] as const;

/** One OS's times from suite-times.json ({<platform>: {<suite>: seconds}}); {} when the file or the OS's table is missing. */
export function loadTimes(platform: string = process.platform, file = TIMES_FILE): Record<string, number> {
  try { const t = JSON.parse(fs.readFileSync(file, "utf8"))?.[platform]; return t && typeof t === "object" && !Array.isArray(t) ? t : {}; } catch { return {}; }
}

/** "I/N" → {index, of}, 1 ≤ I ≤ N ≤ 64; else the reason it isn't one. */
export function parseShard(s: string | null): { index: number; of: number } | string {
  const m = /^(\d+)\/(\d+)$/.exec(s ?? "");
  if (!m) return `--shard takes I/N, 1-based (1/4 … 4/4), not "${s ?? ""}"`;
  const index = +m[1], of = +m[2];
  return of >= 1 && of <= 64 && index >= 1 && index <= of ? { index, of } : `--shard ${s}: need 1 ≤ I ≤ N ≤ 64`;
}

/** LPT: heaviest first (ties by name) onto the lightest bin (ties to the lowest index). Every name lands in exactly one bin. */
export function partition(names: string[], times: Record<string, number>, n: number): string[][] {
  const w = (k: string) => { const t = Object.hasOwn(times, k) ? Number(times[k]) : NaN; return Number.isFinite(t) && t >= 0 ? t : DEFAULT_SECONDS; };
  const bins = Array.from({ length: n }, () => ({ load: 0, names: [] as string[] }));
  for (const k of [...names].sort((a, b) => w(b) - w(a) || (a < b ? -1 : a > b ? 1 : 0))) {
    let b = bins[0]; for (const c of bins) if (c.load < b.load) b = c;
    b.load += w(k); b.names.push(k);
  }
  return bins.map((b) => b.names);
}
export const partitionHash = (bins: string[][]) => createHash("sha256").update(JSON.stringify(bins)).digest("hex");

export type SuiteResult = { name: string; lane: string; status: string; why?: string; ms: number; leftovers: number; outSha256?: string };
export type Receipt = { v: number; verdict: string; head: string; dirty: boolean; os: { platform: string; release: string; arch: string };
  runtimes: unknown; library: unknown; scratch: { dir: string | null; kept: boolean } | null; seconds: number;
  tally: Record<string, { pass: number; fail: number; skip: number }>; notSelected: number; suites: SuiteResult[]; logSha256: string;
  shard?: { index: number; of: number; hash: string; assigned: string[] }; prHead?: string | null; mergeOf?: string[] | null };

/** Whether `got` (shard receipts, any order, unparseable ones as null) is the whole gate at `head`, split `of` ways as this
 *  checkout's SUITES and timings split it; and the merged receipt (run.ts's shape, plus `shards`). Any problem fails. */
export function merge(got: { file: string; receipt: Receipt | null }[], o: { of: number; head: string | null; names?: string[]; times?: Record<string, number>; bins?: string[][] }) {
  // the split is recomputed with the times of the OS the shards ran on (they must all agree on it: checked below)
  const platform = got.find((g) => g.receipt?.os?.platform)?.receipt!.os.platform ?? process.platform;
  const names = o.names ?? NAMES(), bins = o.bins ?? partition(names, o.times ?? loadTimes(platform), o.of), hash = partitionHash(bins);   // bins: a test's stand-in partition
  const problems: string[] = [];
  for (const g of got) if (!g.receipt) problems.push(`${g.file}: not a receipt`);
  const rs = got.filter((g) => g.receipt?.shard).map((g) => ({ file: g.file, r: g.receipt! }));
  for (const g of got) if (g.receipt && !g.receipt.shard) problems.push(`${g.file}: not a shard receipt (no shard field)`);
  const byIndex = new Map<number, { file: string; r: Receipt }>();
  for (const x of rs) {
    const s = x.r.shard!;
    if (s.of !== o.of) { problems.push(`${x.file}: shard ${s.index}/${s.of}, but this gate is ${o.of} shards`); continue; }
    if (byIndex.has(s.index)) { problems.push(`shard ${s.index}/${o.of} reported twice (${byIndex.get(s.index)!.file}, ${x.file})`); continue; }
    byIndex.set(s.index, x);
  }
  for (let i = 1; i <= o.of; i++) {
    const x = byIndex.get(i);
    if (!x) { problems.push(`shard ${i}/${o.of} left no receipt (refused at preflight, crashed, timed out or never ran)`); continue; }
    const s = x.r.shard!, ran = x.r.suites.map((r) => r.name);
    if (s.hash !== hash) problems.push(`shard ${i}/${o.of}: partition ${s.hash.slice(0, 12)}, this checkout's is ${hash.slice(0, 12)}`);
    if (JSON.stringify(s.assigned) !== JSON.stringify(bins[i - 1])) problems.push(`shard ${i}/${o.of}: assigned ${s.assigned.length} suite(s), not the ${bins[i - 1].length} this checkout assigns it`);
    if (JSON.stringify([...ran].sort()) !== JSON.stringify([...s.assigned].sort())) problems.push(`shard ${i}/${o.of}: its results are not the suites it was assigned`);
  }
  // the coverage, from SUITES itself and not from the partition: every suite exactly once, and passed
  const seen = new Map<string, SuiteResult[]>();
  for (const x of byIndex.values()) for (const r of x.r.suites) seen.set(r.name, [...(seen.get(r.name) ?? []), r]);
  for (const n of names) { const c = seen.get(n)?.length ?? 0; if (c !== 1) problems.push(`${n}: ran ${c} time(s) across the shards, not once`); }
  for (const n of seen.keys()) if (!names.includes(n)) problems.push(`${n}: ran, but is not a suite in this checkout`);
  for (const [n, rr] of seen) for (const r of rr) if (r.status !== "pass") problems.push(`${n}: ${r.status.toUpperCase()}${r.why ? ` (${r.why})` : ""}`);
  const heads = new Set([...byIndex.values()].map((x) => x.r.head));
  if (heads.size > 1) problems.push(`the shards ran different heads: ${[...heads].map((h) => h.slice(0, 12)).join(", ")}`);
  if (o.head && heads.size && !heads.has(o.head)) problems.push(`the shards ran ${[...heads][0].slice(0, 12)}, not this checkout's ${o.head.slice(0, 12)}`);
  const plats = new Set([...byIndex.values()].map((x) => x.r.os.platform));
  if (plats.size > 1) problems.push(`the shards ran on different OSes: ${[...plats].join(", ")}`);

  const shards = [...byIndex.entries()].sort(([a], [b]) => a - b).map(([, x]) => x.r);
  const at = new Map(ORDER.map((n, i) => [n, i]));
  const suites = shards.flatMap((r) => r.suites).sort((a, b) => (at.get(a.name) ?? 1e9) - (at.get(b.name) ?? 1e9));
  const tally: Receipt["tally"] = {};
  for (const r of shards) for (const [l, t] of Object.entries(r.tally)) { const m = (tally[l] ??= { pass: 0, fail: 0, skip: 0 }); m.pass += t.pass; m.fail += t.fail; m.skip += t.skip; }
  const first = shards[0];
  const merged = {
    v: 1, verdict: problems.length ? "FAILED" : "PASS", head: first?.head ?? null, prHead: first?.prHead ?? null, mergeOf: first?.mergeOf ?? null, dirty: shards.some((r) => r.dirty),
    os: first?.os ?? null, runtimes: first?.runtimes ?? null, library: first?.library ?? null,
    scratch: { dir: null, kept: shards.every((r) => r.scratch?.kept) },   // per shard: shards[].scratch
    seconds: Math.max(0, ...shards.map((r) => r.seconds)), tally, notSelected: names.length - suites.length, suites,
    logSha256: createHash("sha256").update(suites.map((x) => `${x.name}\t${x.outSha256 ?? ""}`).join("\n")).digest("hex"),
    shards: shards.map((r) => ({ index: r.shard!.index, of: o.of, hash: r.shard!.hash, verdict: r.verdict, head: r.head, prHead: r.prHead ?? null, seconds: r.seconds, suites: r.suites.length, scratch: r.scratch, logSha256: r.logSha256 })),
    partition: { of: o.of, hash }, problems,
  };
  return { problems, merged };
}

// ---- --times: suite-times.json from shard receipts (suites[].ms, os.platform) ----
/** Each OS's median seconds per suite over the receipts given (files, or dirs walked for *.json). Only suites that passed
 *  count (a timeout's time is its cap, not the suite's), and a merged receipt (it has `shards`) is skipped: its suites are
 *  its shards' again. A gate log can't be used: it doesn't name its OS. */
export function timesFrom(inputs: string[], names = NAMES()): Record<string, Record<string, number>> {
  const files: string[] = [], walk = (p: string) => { if (fs.statSync(p).isDirectory()) for (const e of fs.readdirSync(p).sort()) walk(path.join(p, e)); else files.push(p); };
  for (const p of inputs) walk(p);
  const seen: Record<string, Record<string, number[]>> = {};
  for (const f of files) {
    if (!f.endsWith(".json")) throw new Error(`${f}: not a receipt (.json); a gate log doesn't say which OS it ran on`);
    let r: Receipt & { shards?: unknown }; try { r = JSON.parse(fs.readFileSync(f, "utf8")); } catch { throw new Error(`${f}: not JSON`); }
    if (!Array.isArray(r?.suites) || !r.os?.platform || r.shards) continue;
    for (const s of r.suites) if (s.status === "pass" && names.includes(s.name) && Number.isFinite(s.ms)) ((seen[r.os.platform] ??= {})[s.name] ??= []).push(s.ms / 1000);
  }
  const median = (v: number[]) => { const s = [...v].sort((a, b) => a - b), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
  return Object.fromEntries(Object.keys(seen).sort().map((p) => [p, Object.fromEntries(names.filter((n) => seen[p][n]).map((n) => [n, Math.round(median(seen[p][n]) * 10) / 10]))]));
}
/** Write suite-times.json from `inputs`; an OS none of them ran on keeps the table it had. Says what each OS's table covers. */
export function writeTimes(inputs: string[], file = TIMES_FILE): string[] {
  const t = timesFrom(inputs), old = (() => { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return {}; } })();
  const out = Object.fromEntries(PLATFORMS.map((p) => [p, t[p] ?? old?.[p] ?? {}]));
  fs.writeFileSync(file, JSON.stringify(out, null, 1) + "\n");
  return PLATFORMS.map((p) => { const missing = NAMES().filter((n) => !(n in out[p]));
    return `${p.padEnd(6)} ${Object.keys(out[p]).length} suites${t[p] ? "" : " (kept: no receipt from this OS)"}${missing.length ? `; ${missing.length} weigh the default ${DEFAULT_SECONDS} s: ${missing.join(" ")}` : ""}`; });
}
if (import.meta.main) {
  const argv = process.argv.slice(2);
  let inputs: string[] = [], tmp = "";
  if (argv.includes("--fetch-times")) {
    // the upstream's green runs (a fork's main can be months stale); each run's shard receipts, every OS
    const runs = Number(argv[argv.indexOf("--fetch-times") + 1] ?? 8) || 8, repo = "anima-research/eidoverse-worlds";
    const list = spawnSync("gh", ["run", "list", "-R", repo, "-w", "protocol-gate", "-s", "success", "-L", String(runs), "--json", "databaseId", "-q", ".[].databaseId"], { encoding: "utf8" });
    if (list.status !== 0) { console.log(`gh run list failed: ${list.stderr.trim()}`); process.exit(1); }
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "suite-times-"));
    for (const id of list.stdout.split("\n").filter(Boolean)) {
      const d = spawnSync("gh", ["run", "download", id, "-R", repo, "-p", "gate-shard-receipt-*", "-D", path.join(tmp, id)], { encoding: "utf8" });
      console.log(`  run ${id}: ${d.status === 0 ? "receipts downloaded" : `no receipts (${d.stderr.trim().split("\n").at(-1)})`}`);
      if (d.status === 0) inputs.push(path.join(tmp, id));
    }
  } else if (argv.includes("--times")) inputs = argv.slice(argv.indexOf("--times") + 1);
  if (!inputs.length) { console.log("bun test/gate/shard.ts --times <receipt.json | dir>…  |  --fetch-times [runs]"); process.exit(2); }
  try { for (const l of writeTimes(inputs)) console.log(`suite-times.json: ${l}`); }
  catch (e) { console.log(`suite-times.json: not written: ${(e as Error).message}`); process.exit(1); }
  finally { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); }
}
