// test/gate/shard.ts — the gate split over N CI jobs: which suites shard I/N runs (1-based: 1/4 … 4/4), and whether
// N shard receipts add up to the gate (merge-receipts.ts). Suites are LPT bin-packed by suite-times.json; a time only moves
// a suite between shards, never in or out of the gate. shard-check.ts holds the rows.
//   bun test/gate/shard.ts --times <gate log | receipt.json>…   rewrite suite-times.json (each suite's max over the inputs)
import fs from "node:fs";
import { createHash } from "node:crypto";
import { ENGINE } from "./common.ts";
import { SUITES, ORDER } from "./suites.ts";

export const TIMES_FILE = ENGINE + "test/gate/suite-times.json";
export const DEFAULT_SECONDS = 30;   // a suite the timings don't know yet
export const NAMES = () => SUITES.map(([n]) => n);

export function loadTimes(file = TIMES_FILE): Record<string, number> {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return {}; }
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
  shard?: { index: number; of: number; hash: string; assigned: string[] }; prHead?: string | null; mergeOf?: string[] | null;
  /** run.ts's OPTIONAL lines, one per name: an extension that did not run, or a row that can't be observed on this host */
  optional?: Record<string, string> };

/** Whether `got` (shard receipts, any order, unparseable ones as null) is the whole gate at `head`, split `of` ways as this
 *  checkout's SUITES and timings split it; and the merged receipt (run.ts's shape, plus `shards`). Any problem fails. */
export function merge(got: { file: string; receipt: Receipt | null }[], o: { of: number; head: string | null; names?: string[]; times?: Record<string, number>; bins?: string[][] }) {
  const names = o.names ?? NAMES(), bins = o.bins ?? partition(names, o.times ?? loadTimes(), o.of), hash = partitionHash(bins);   // bins: a test's stand-in partition
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
  // every shard's OPTIONAL lines, one per name as run.ts keeps them (the lowest shard's text wins; each shard's own stay
  // under shards[]): a suite's N/A evidence on one shard must not vanish at the merge
  const optional: Record<string, string> = {};
  for (const r of shards) for (const [k, v] of Object.entries(r.optional ?? {})) if (!Object.hasOwn(optional, k)) optional[k] = v;
  const merged = {
    v: 1, verdict: problems.length ? "FAILED" : "PASS", head: first?.head ?? null, prHead: first?.prHead ?? null, mergeOf: first?.mergeOf ?? null, dirty: shards.some((r) => r.dirty),
    os: first?.os ?? null, runtimes: first?.runtimes ?? null, library: first?.library ?? null,
    scratch: { dir: null, kept: shards.every((r) => r.scratch?.kept) },   // per shard: shards[].scratch
    seconds: Math.max(0, ...shards.map((r) => r.seconds)), tally, notSelected: names.length - suites.length, suites, optional,
    logSha256: createHash("sha256").update(suites.map((x) => `${x.name}\t${x.outSha256 ?? ""}`).join("\n")).digest("hex"),
    shards: shards.map((r) => ({ index: r.shard!.index, of: o.of, hash: r.shard!.hash, verdict: r.verdict, head: r.head, prHead: r.prHead ?? null, seconds: r.seconds, suites: r.suites.length, scratch: r.scratch, logSha256: r.logSha256, optional: r.optional ?? {} })),
    partition: { of: o.of, hash }, problems,
  };
  return { problems, merged };
}

// ---- --times: suite-times.json from gate logs (`== name [lane] (file) PASS … 12.3 s`) and receipts (suites[].ms) ----
export function timesFrom(files: string[], names = NAMES()): Record<string, number> {
  const t: Record<string, number> = {};
  const take = (n: string, s: number) => { if (names.includes(n) && Number.isFinite(s)) t[n] = Math.max(t[n] ?? 0, Math.round(s * 10) / 10); };
  for (const f of files) {
    const text = fs.readFileSync(f, "utf8");
    if (f.endsWith(".json")) { for (const s of (JSON.parse(text) as Receipt).suites ?? []) take(s.name, s.ms / 1000); continue; }
    for (const l of text.split("\n")) { const m = /^== (\S+) \[(?:core|main|browser)\] .* (?:PASS|FAIL|SKIP)\b.* (\d+(?:\.\d+)?) s(?: ·.*)?$/.exec(l); if (m) take(m[1], +m[2]); }
  }
  return Object.fromEntries(names.filter((n) => n in t).map((n) => [n, t[n]]));
}
if (import.meta.main) {
  const argv = process.argv.slice(2), files = argv.slice(argv.indexOf("--times") + 1);
  if (!argv.includes("--times") || !files.length) { console.log("bun test/gate/shard.ts --times <gate log | receipt.json>…"); process.exit(2); }
  const t = timesFrom(files); fs.writeFileSync(TIMES_FILE, JSON.stringify(t, null, 1) + "\n");
  const missing = NAMES().filter((n) => !(n in t));
  console.log(`suite-times.json: ${Object.keys(t).length} suites from ${files.length} file(s)${missing.length ? `; ${missing.length} weigh the default ${DEFAULT_SECONDS} s: ${missing.join(" ")}` : ""}`);
}
