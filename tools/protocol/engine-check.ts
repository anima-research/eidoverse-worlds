// What "carries" means (house answer on #260, 10-21): a server carries an engine version when its implementation
// reproduces that version's conformance digests. Each scenario in spec/conformance/physics/ is a log holding a throw's
// inputs and no rest; replayed through a version, its rests (id, pose rounded to the millimetre, rest tick) hash to
// spec/conformance/physics/digests.json[version][scenario], and its rests' exact float bits with the engine's final snapshot
// (simlayer digestOf, what the live L3 check compares) hash to digests-exact.json. A change that still reproduces them needs no cut; a change
// meant to alter results is a new version with its own digests.
//   bun tools/protocol/engine-check.ts            check every carried version
//   bun tools/protocol/engine-check.ts --write    write the digests of a carried version the file doesn't hold yet (and of a
//                                                 new scenario); never an existing digest: a changed one means the engine
//                                                 changed its results under the same name, which --write refuses
//   EN4 holds the same against git: a version's digests equal that version's at the base (and at the file's previous version)
import fs from "node:fs";
import { createHash } from "node:crypto";
import { readLog } from "../../shared/protocol/fold.js";
import { ENGINES, digestOf as simDigest } from "../../shared/protocol/simlayer.js";
import { simFold } from "./labmodels.js";   // the sim over the lab table (its logs name lab models)
import { r3 } from "../../shared/protocol/round.js";
import * as PH from "./pinhistory.ts";
import * as FR from "./fixture-repin.ts";
import { fileURLToPath } from "node:url";

const DIR = fileURLToPath(new URL("../../spec/conformance/physics/", import.meta.url)), DIG = `${DIR}digests.json`, EXACT = `${DIR}digests-exact.json`;
let pass = 0, fail = 0;
const check = (n: string, ok: boolean, info?: unknown) => { if (ok) { pass++; console.log(`ok   ${n}`); } else { fail++; console.log(`FAIL ${n}`); if (info !== undefined) console.log("     ", JSON.stringify(info).slice(0, 400)); } };
const scenarios = fs.readdirSync(DIR).filter((f) => f.endsWith(".jsonl")).map((f) => f.slice(0, -6)).sort();

/** a scenario replayed as `version`: its epoch is set to that engine; the fold at the scenario's end + 30 s */
function replayed(text: string, version: string): any {
  const asVersion = (o: any) => o?.id === "@world" && o.comp === "physics-engine" && o.value ? { ...o, value: { ...o.value, engine: version } } : o;
  const L = readLog(text).map((e: any) => {
    const b = e?.body, body = Array.isArray(b?.ops) ? { ...b, ops: b.ops.map(asVersion) } : asVersion(b);
    return body === b ? e : { ...e, body };
  });
  return simFold(L, (L.at(-1) as any).ts + 30000);
}
const hex = (o: unknown) => createHash("sha256").update(JSON.stringify(o)).digest("hex").slice(0, 16);
const liveOf = (v: any) => Object.keys(v.sim?.bodies ?? {}).filter((id) => !v.sim.bodies[id].resting && v.sim.bodies[id].dyn).sort();
const bits = (x: number) => { const b = new DataView(new ArrayBuffer(8)); b.setFloat64(0, x); return b.getBigUint64(0).toString(16); };
/** what came to rest, and where (to the millimetre), and when */
export const roundedOf = (v: any) => hex({ rests: [...v.rested].sort((a: any, b: any) => (a.id < b.id ? -1 : 1)).map((r: any) => [r.id, r.p.map(r3), r.q.map(r3), r.restTick]), live: liveOf(v) });
/** the same, bit for bit, with the engine's final state */
export const exactOf = (v: any) => hex({ rests: [...v.rested].sort((a: any, b: any) => (a.id < b.id ? -1 : 1)).map((r: any) => [r.id, r.p.map(bits), r.q.map(bits), r.restTick]), live: liveOf(v), sim: v.sim ? simDigest(v.sim) : null });
export const digestOf = (text: string, version: string) => roundedOf(replayed(text, version));
export const exactDigestOf = (text: string, version: string) => exactOf(replayed(text, version));
const carried = Object.keys(ENGINES).sort();
const FILES: [string, (t: string, v: string) => string][] = [[DIG, digestOf], [EXACT, exactDigestOf]];
if (process.argv.includes("--write")) {
  const moved: string[] = [], added: string[] = [], outs: [string, unknown][] = [];
  for (const [file, of] of FILES) { const out: Record<string, Record<string, string>> = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
    for (const ver of carried) { const had = out[ver] ?? {}; const next: Record<string, string> = { ...had };
      for (const s of scenarios) { const d = of(fs.readFileSync(`${DIR}${s}.jsonl`, "utf8"), ver);
        if (s in had) { if (had[s] !== d) moved.push(`${file.slice(DIR.length)} ${ver} ${s}: ${had[s]} → ${d}`); } else { next[s] = d; added.push(`${file.slice(DIR.length)} ${ver} ${s}`); } }
      out[ver] = next; }
    outs.push([file, out]); }
  if (moved.length) { console.log(`refusing to write: the engine changed its results under the same name (a change meant to alter results is a new version with its own digests; never a rewrite of an existing one):\n  ${moved.join("\n  ")}`); process.exit(1); }
  for (const [file, out] of outs) fs.writeFileSync(file, JSON.stringify(out, null, 2) + "\n");
  console.log(`[engine-check] wrote ${added.length} new digest(s)${added.length ? `: ${added.join(", ")}` : " (nothing new)"}`); process.exit(0);
}
const pinned = fs.existsSync(DIG) ? JSON.parse(fs.readFileSync(DIG, "utf8")) : null, exact = fs.existsSync(EXACT) ? JSON.parse(fs.readFileSync(EXACT, "utf8")) : null;
check("EN0 the digests file exists, and there are scenarios to hold an engine to", !!pinned && scenarios.length >= 5, { pinned: !!pinned, scenarios });
for (const ver of carried) {
  const d = pinned?.[ver] ?? {};
  check(`EN1 ${ver}: every scenario has a digest (a carried version without its digests is carried by nothing)`, scenarios.every((s) => typeof d[s] === "string"), { have: Object.keys(d), scenarios });
  for (const s of scenarios) {
    const got = digestOf(fs.readFileSync(`${DIR}${s}.jsonl`, "utf8"), ver);
    check(`EN2 ${ver} reproduces ${s}`, got === d[s], { got, want: d[s] });
    const bit = exactDigestOf(fs.readFileSync(`${DIR}${s}.jsonl`, "utf8"), ver);
    check(`EN2x ${ver} reproduces ${s} bit for bit, engine state included (digests-exact.json)`, bit === exact?.[ver]?.[s], { got: bit, want: exact?.[ver]?.[s] });
  }
}
// EN6: a rest moved by one ulp, which the live L3 check calls a disagreement, changes the exact digest
{ const s = scenarios[0], v = replayed(fs.readFileSync(`${DIR}${s}.jsonl`, "utf8"), carried[0]); const n = structuredClone(v);
  const r = n.rested[0]; if (r) { const b = new DataView(new ArrayBuffer(8)); b.setFloat64(0, r.p[0]); b.setBigUint64(0, b.getBigUint64(0) + 1n); r.p[0] = b.getFloat64(0); }
  check(`EN6 ${s}: one rest nudged by one ulp is a different exact digest (the rounded one can't see it: ${roundedOf(v) === roundedOf(n) ? "same" : "differs"})`, !!r && exactOf(v) !== exactOf(n), { at: r?.p }); }
{ const none = "no-such-engine@0";
  const same = scenarios.filter((s) => { const d = digestOf(fs.readFileSync(`${DIR}${s}.jsonl`, "utf8"), none); return carried.some((ver) => pinned?.[ver]?.[s] === d); });
  check(`EN5 a scenario replays as the version it's given: as ${none}, which nothing carries, it reproduces no carried version's digest`, !same.length, same); }
// a scenario must actually exercise the engine: every one ends with something at rest that was thrown
for (const s of scenarios) {
  const v: any = simFold(readLog(fs.readFileSync(`${DIR}${s}.jsonl`, "utf8")), 1e15);
  check(`EN3 ${s} has a rest to hold the engine to`, (v.rested?.length ?? 0) > 0, v.rested);
}
// EN6: the knock wakes the sleeper — crate-1 is never thrown, yet comes to rest beside the ball
{ const s = "knock-a-sleeper-2", f = `${DIR}${s}.jsonl`; const v: any = fs.existsSync(f) ? simFold(readLog(fs.readFileSync(f, "utf8")), 1e15) : null;
  const ids = (v?.rested ?? []).map((r: any) => r.id);
  check(`EN6 ${s}: the thrown ball knocks crate-1 awake (both come to rest; the crate was never thrown)`, ids.includes("ball") && ids.includes("crate-1"), ids); }
// EN4: a version's digests never change under its name, against the record (a --write that rewrote them by hand, or an edit of
// the file, would otherwise pass EN2 against the changed engine). An exact digest may move only under a fixture-repins.json
// acknowledgement that binds both files' hashes and explains every log difference (tools/protocol/fixture-repin.ts).
const ROOT = fileURLToPath(new URL("../../", import.meta.url)), REPINS = `${DIR}fixture-repins.json`, REL = "spec/conformance/physics/";
const repins: any[] = fs.existsSync(REPINS) ? JSON.parse(fs.readFileSync(REPINS, "utf8")).repins : [];
const of = { exact: exactDigestOf, rounded: digestOf, replay: (t: string) => replayed(t, carried[0]) }, cur = (s: string) => fs.readFileSync(`${DIR}${s}.jsonl`, "utf8");
// the old side is always the acknowledgement's receipt, never a log read from git (a merge parent may hold another dialect)
const covers = (a: any, ver: string, d: Record<string, string>, nowV: Record<string, string>, R = FR.receiptOf(a, DIR)) => [...R.bad, ...FR.uncovered(a, ver, scenarios, d, nowV, R.log, cur, of)];
for (const [F, now] of [[`${REL}digests.json`, pinned], [`${REL}digests-exact.json`, exact]] as const) {
  const e = PH.earlier(ROOT, [F], (f) => (fs.existsSync(ROOT + f) ? fs.readFileSync(ROOT + f, "utf8") : null));
  const moved = e.out.flatMap(({ rev, was }) => Object.entries<any>(was[F] ?? {}).flatMap(([ver, d]) => { const m = Object.entries<any>(d).filter(([s, x]) => now?.[ver]?.[s] !== x);
    const a = F.endsWith("exact.json") && m.length ? repins.find((r) => r.exactOld === FR.sha(PH.showAt(ROOT, rev, F) ?? "") && r.exactNew === FR.sha(fs.readFileSync(ROOT + F, "utf8"))) : null;
    const why = a ? covers(a, ver, d, now?.[ver] ?? {}) : [];
    if (a && !why.length) return [];
    return [...why, ...m.map(([s, x]) => `${F.split("/").pop()} ${ver} ${s}: ${x} at ${rev.slice(0, 8)} → ${now?.[ver]?.[s] ?? "gone"}${a ? "" : " (no acknowledgement binds these two files)"}`)]; }));
  check(`EN4 ${F.split("/").pop()}: each version's digests equal that version's at the base (and at the file's previous version) where it had them, or move under a fixture-repins.json acknowledgement: a change meant to alter results is a new version (judged: ${e.out.map((o) => `${o.rev.slice(0, 8)} ${o.why}`).join(", ") || "no earlier version"})`, !moved.length, moved.slice(0, 6)); }
// EN9: each acknowledgement's receipt holds the bytes it hashes; the one in force (its exactNew is today's file) replays to it
// from the receipt alone, so a squash with no PR ancestry still verifies it
const exactNow = FR.sha(fs.readFileSync(EXACT, "utf8")), inForce = repins.find((r) => r.exactNew === exactNow);
for (const a of repins) { const R = FR.receiptOf(a, DIR), why = [...R.bad, ...(a === inForce ? FR.uncovered(a, a.engine, scenarios, R.was, exact?.[a.engine] ?? {}, R.log, cur, of) : [])];
  check(`EN9 ${a.receipt}: the receipt holds the old bytes the acknowledgement hashes${a === inForce ? ", and they replay to it (it is in force)" : ""}`, !why.length, why.slice(0, 4)); }
// EN7: each acknowledged scenario's build box is set before the physics epoch, and is the box its old log had there
for (const a of repins) for (const [s, x] of Object.entries<any>(a.scenarios ?? {})) { const f = `${DIR}${s}.jsonl`; if (!fs.existsSync(f) || FR.sha(fs.readFileSync(f, "utf8")) !== x.logNew) continue;
  const t = fs.readFileSync(f, "utf8"), L = t.split("\n").filter(Boolean).map((l) => JSON.parse(l)), ep = FR.epochOf(L), ins = Object.keys(x.inserted).map(Number), at = FR.atEpoch(t)["@world"]?.bounds;
  check(`EN7 ${s}: its inserted bounds set (${ins.join(",") || "none: founding's box is its box"}) comes before the physics epoch (#${ep}), and @world.bounds there is the old log's`, ins.every((j) => j < ep && (L[j].body?.args?.component === "bounds" || L[j].body?.comp === "bounds")) && JSON.stringify(at) === JSON.stringify(x.bounds), { ep, ins, at, want: x.bounds }); }
// EN8: what the acknowledgement in force must NOT cover, each a mutation of its receipt or of today's logs
if (!inForce) check("EN8 no acknowledgement is in force (none names today's digests-exact.json), so there is none to probe", true);
else if (FR.receiptOf(inForce, DIR).bad.length) check("EN8 the acknowledgement in force has no whole receipt to probe (EN9 says what is missing)", false);
else { const a = inForce, ver = a.engine, s = "crate-slide", x = a.scenarios[s], R = FR.receiptOf(a, DIR), was = R.was;
  const o = R.log(s)!, n = cur(s), L = n.split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const txt = (M: any[]) => M.map((e) => JSON.stringify(e)).join("\n") + "\n", ins = Object.keys(x.inserted).map(Number);
  const drop = (M: any[], js: number[]) => M.filter((_e, j) => !js.includes(j)).map((e) => (Number.isInteger(e.cause) ? { ...e, cause: e.cause - js.filter((j) => j < e.cause).length } : e));
  const un = (t: string, map = x.map) => FR.unexplained(o, t, map, x.bounds, of.replay);
  const withOld = (f: (k: string) => string | null) => FR.uncovered(a, ver, scenarios, was, exact?.[ver] ?? {}, (k) => (k === s ? f(k) : R.log(k)), cur, of);
  const moveAfter = (() => { const M = drop(L, ins), ep = FR.epochOf(M), r = { ...L[ins[0]] }; M.splice(ep + 1, 0, r, { ...L[ins[1]], cause: ep + 1 }); return M.map((e, j) => (j > ep + 2 && Number.isInteger(e.cause) && e.cause > ep ? { ...e, cause: e.cause + 2 } : e)); })();
  const rows: [string, () => unknown[]][] = [
    ["a wrong old hash", () => repins.some((r) => r.exactOld === FR.sha("x" + R.exact) && r.exactNew === a.exactNew) ? [] : ["no acknowledgement binds these hashes"]],
    ["a wrong new hash", () => repins.some((r) => r.exactOld === a.exactOld && r.exactNew === FR.sha("x" + fs.readFileSync(EXACT, "utf8"))) ? [] : ["no acknowledgement binds these hashes"]],
    ["a missing scenario", () => FR.uncovered({ ...a, scenarios: Object.fromEntries(Object.entries(a.scenarios).filter(([k]) => k !== s)) }, ver, scenarios, was, exact?.[ver] ?? {}, R.log, cur, of)],
    ["a missing old log", () => withOld(() => null)],
    ["an old log that isn't the acknowledged bytes", () => withOld(() => o.replace('"ts":', '"ts": '))],
    ["an old log in another dialect, even one the acknowledgement hashed (a merge parent's base may hold one): red, not a throw", () => { const t = o.replaceAll('"op":', '"verb":');
      return FR.uncovered({ ...a, scenarios: { ...a.scenarios, [s]: { ...x, logOld: FR.sha(t) } } }, ver, scenarios, was, exact?.[ver] ?? {}, (k) => (k === s ? t : R.log(k)), cur, of); }],
    ["an extra changed field (the throw 1 mm/s faster)", () => un(txt(L.map((e) => (e.verb === "launch" ? { ...e, body: { ...e.body, v: [e.body.v[0] + 0.001, ...e.body.v.slice(1)] } } : e))))],
    ["a bounds change (the restored box's floor at −10)", () => un(txt(L.map((e, j) => (ins.includes(j) ? JSON.parse(JSON.stringify(e).replaceAll('"min":[-20,0,-20]', '"min":[-20,-10,-20]')) : e))))],
    ["a timestamp change (the scenario 900 ms later)", () => un(txt(L.map((e) => ({ ...e, ts: e.ts + 900 }))))],
    ["a timestamp change the sim can't see (founding 900 ms earlier)", () => un(txt(L.map((e, j) => (j < 3 ? { ...e, ts: e.ts - 900 } : e))))],
    ["the bounds set omitted", () => un(txt(drop(L, ins)), x.map.map((j: number | null) => (j === null ? null : j - ins.filter((i) => i < j).length)))],
    ["the bounds set moved after the epoch", () => un(txt(moveAfter), x.map.map((j: number | null) => (j === null || j < ins[0] ? j : j - 2 <= FR.epochOf(drop(L, ins)) ? j - 2 : j)))],
  ];
  for (const [what, f] of rows) { const got = f(); check(`EN8 ${s}: ${what} is not covered by the acknowledgement`, got.length > 0, got.slice(0, 3)); } }
console.log(`[engine-check] ${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
