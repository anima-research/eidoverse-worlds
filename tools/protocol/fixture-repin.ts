// tools/protocol/fixture-repin.ts — a scenario log regenerated under the same engine version, held to its acknowledgement
// (spec/conformance/physics/fixture-repins.json; Mica's EN4 rulings, 11-05): every old→new log difference must be one of the
// named classes, each checked here, and none else. engine-check's EN4 accepts a changed exact digest only through this.
// @ts-nocheck
import fs from "node:fs";
import { createHash } from "node:crypto";
import { readLog, fold, opsOf } from "../../shared/protocol/fold.js";

export const sha = (t: string) => createHash("sha256").update(t).digest("hex");
const lines = (t: string) => t.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
const KEYED = new Set(["world", "head", "sig", "salt", "nonce", "owners", "sequencer"]);   // class 6: re-keyed, re-signed
const blank = (o: any): any => Array.isArray(o) ? o.map(blank) : o && typeof o === "object" ? Object.fromEntries(Object.entries(o).map(([k, v]) => [k, KEYED.has(k) ? "~" : blank(v)])) : o;
const sorted = (o: any): string => JSON.stringify(o, (_k, v) => v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, v[k]])) : v);
const bits = (x: number) => { const b = new DataView(new ArrayBuffer(8)); b.setFloat64(0, x); return b.getBigUint64(0).toString(16); };
/** the seq of the change that starts the physics epoch (sets @world.physics-engine) */
export const epochOf = (L: any[]) => L.findIndex((e) => e.kind === "change" && opsOf(e).some((o: any) => o.id === "@world" && o.comp === "physics-engine"));
/** every entity's components where the epoch starts */
export const atEpoch = (t: string) => { const L = readLog(t), st = fold(L, { until: epochOf(L) - 1 });
  return Object.fromEntries(Object.entries(st.entities ?? {}).map(([id, e]: any) => [id, e.c])); };
const isRepairShapes = (e: any) => e.kind === "request" && e.actor === "system" && e.verb === "repair-shapes" && e.body?.founding === true;
const isBoundsSet = (e: any) => (e.kind === "request" && e.verb === "set" && e.body?.args?.id === "@world" && e.body.args.component === "bounds")
  || (e.kind === "change" && e.op === "set" && e.body?.id === "@world" && e.body.comp === "bounds");
function diffs(a: any, b: any, p: string, out: string[]) {
  if (a && b && typeof a === "object" && typeof b === "object" && Array.isArray(a) === Array.isArray(b)) { for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) diffs(a[k], b[k], `${p}.${k}`, out); return; }
  if (typeof a === "number" && typeof b === "number" ? bits(a) !== bits(b) : a !== b) out.push(`${p}: ${JSON.stringify(a)} → ${JSON.stringify(b)}`);
}

/** The differences between an old and a new scenario log that no accepted class explains ([] = fully explained).
 *  `map[i]` is old entry i's seq in the new log (null: removed); `replay(text)` is engine-check's fold at the scenario's end. */
export function unexplained(oldT: string, newT: string, map: (number | null)[], bounds: unknown, replay: (t: string) => any): string[] {
  const O = lines(oldT), N = lines(newT), out: string[] = [], kept = map.filter((j) => j !== null);
  if (map.length !== O.length || kept.some((j, k) => !Number.isInteger(j) || j < 0 || j >= N.length || (k && j <= kept[k - 1]))) return [`the entry map is not monotone over the old log's ${O.length} entries`];
  const toNew = (c: any) => (Number.isInteger(c) ? map[c] ?? `removed ${c}` : c);
  O.forEach((e, i) => { if (map[i] === null) { if (!isRepairShapes(e)) out.push(`old #${i} removed, and it is not the founding repair-shapes request`); return; }   // class 1
    const was = blank({ ...e, ...(e.cause !== undefined ? { cause: toNew(e.cause) } : {}) });   // class 4: causes follow the map
    if (e.verb === "create-world" && was.body?.shapes === 2) delete was.body.shapes;   // class 2
    const now = blank(N[map[i]!]);   // class 3: founding writes today's default box where an inserted set restores the old one (held below, at the epoch)
    if (e.kind === "change" && O[e.cause]?.verb === "create-world" && N.some((x, j) => !kept.includes(j) && isBoundsSet(x)))
      for (const b of [was, now]) for (const o of b.body?.ops ?? []) if (o.op === "set" && o.id === "@world" && o.comp === "bounds") o.value = "~";
    const d: string[] = []; diffs(JSON.parse(sorted(was)), JSON.parse(sorted(now)), "", d);
    for (const x of d) out.push(`old #${i} → new #${map[i]} ${x}`); });
  // class 3 (ruling 3): the only insertion is one admitted bounds set (its place before the epoch: the bounds there, below)
  N.forEach((e, j) => { if (kept.includes(j)) return;
    if (!isBoundsSet(e)) out.push(`new #${j} inserted, and it is not a bounds set`);
    else if (e.kind === "change" && !(N[e.cause]?.kind === "request" && !kept.includes(e.cause))) out.push(`new #${j}: a bounds change whose request isn't the inserted one`); });
  const oa = atEpoch(oldT), na = atEpoch(newT);   // effective bounds and entities where physics starts
  diffs(oa, na, "at the epoch", out); if (sorted(na["@world"]?.bounds) !== sorted(bounds)) out.push(`at the epoch @world.bounds is ${JSON.stringify(na["@world"]?.bounds)}, the acknowledgement says ${JSON.stringify(bounds)}`);
  const ov = replay(oldT), nv = replay(newT), rest = (v: any) => [...v.rested].sort((a: any, b: any) => (a.id < b.id ? -1 : 1)).map((r: any) => [r.id, r.p, r.q, r.restTick]);
  diffs(rest(ov), rest(nv), "rests", out);
  const sd: string[] = []; diffs(JSON.parse(JSON.stringify(ov.sim)), JSON.parse(JSON.stringify(nv.sim)), "sim", sd);
  for (const x of sd) { const m = /^sim(\.epoch|\.bodies\.[^.]+)\.seq: (\d+) → (\d+)$/.exec(x); if (!m || map[+m[2]] !== +m[3]) out.push(x); }   // class 4
  return out;
}

/** What keeps acknowledgement `a` from covering version `ver`'s exact digests moving from `was` to `now` ([] = covered).
 *  `old(s)`/`cur(s)`: scenario s's log at the judged version / now; `of`: engine-check's exact, rounded and replay. */
export function uncovered(a: any, ver: string, scenarios: string[], was: Record<string, string>, now: Record<string, string>, old: (s: string) => string | null, cur: (s: string) => string, of: { exact: (t: string, v: string) => string; rounded: (t: string, v: string) => string; replay: (t: string) => any }): string[] {
  const out: string[] = [], S = a.scenarios ?? {};
  if (a.engine !== ver) out.push(`acknowledged for ${a.engine}, not ${ver}`);
  if (sorted(Object.keys(S).sort()) !== sorted([...scenarios].sort())) out.push(`acknowledges [${Object.keys(S).sort()}], the scenarios are [${[...scenarios].sort()}]`);
  for (const s of scenarios) { const x = S[s], o = old(s), n = cur(s); if (!x) continue; if (o == null) { out.push(`${s}: no old log in the receipt`); continue; }
    if (sha(o) !== x.logOld) { out.push(`${s} logOld: ${sha(o)} ≠ ${x.logOld} (not the acknowledged bytes; nothing replayed)`); continue; }
    try {
    const O = lines(o), N = lines(n), want: [string, unknown, unknown][] = [["logNew", sha(n), x.logNew], ["worldOld", O[1]?.world, x.worldOld], ["worldNew", N[1]?.world, x.worldNew],
      ["headOld", O.at(-1)?.head, x.headOld], ["headNew", N.at(-1)?.head, x.headNew], ["digestOld", was[s], x.digestOld], ["digestNew", now[s], x.digestNew],
      ["engine unchanged: today's engine replays the old log to digestOld", of.exact(o, ver), x.digestOld], ["rounded digest unchanged", of.rounded(n, ver), of.rounded(o, ver)],
      ["inserted entries' canonical ts", sorted(Object.fromEntries(N.map((e, j) => [String(j), e.ts]).filter(([j]) => !x.map.includes(+j)))), sorted(x.inserted)]];
    for (const [k, got, w] of want) if (got !== w) out.push(`${s} ${k}: ${got} ≠ ${w}`);
    for (const u of unexplained(o, n, x.map, x.bounds, of.replay)) out.push(`${s} ${u}`);
    } catch (e: any) { out.push(`${s}: today's reader can't replay the pair (${e?.code ?? e?.message ?? e}${e?.detail ? ` ${e.detail}` : ""})`); } }
  return out;
}

/** An acknowledgement's receipt (the old bytes its hashes name, kept in the repo so no git history is needed): the old
 *  digests file and logs, and what's missing or doesn't hash to the acknowledgement. */
export function receiptOf(a: any, dir: string) {
  const at = (f: string) => { const p = `${dir}${a.receipt ?? "\0"}${f}`; return typeof a.receipt === "string" && !a.receipt.includes("..") && fs.existsSync(p) ? fs.readFileSync(p, "utf8") : null; };
  const exact = at("digests-exact.json"), bad: string[] = [];
  if (exact == null) bad.push(`receipt ${a.receipt}: no digests-exact.json`); else if (sha(exact) !== a.exactOld) bad.push(`receipt digests-exact.json: ${sha(exact)} ≠ exactOld ${a.exactOld}`);
  for (const [s, x] of Object.entries<any>(a.scenarios ?? {})) { const t = at(`${s}.jsonl`); if (t == null) bad.push(`receipt ${a.receipt}: no ${s}.jsonl`); else if (sha(t) !== x.logOld) bad.push(`receipt ${s}.jsonl: ${sha(t)} ≠ logOld ${x.logOld}`); }
  return { exact, was: exact == null ? {} : JSON.parse(exact)[a.engine] ?? {}, log: (s: string) => at(`${s}.jsonl`), bad };
}
