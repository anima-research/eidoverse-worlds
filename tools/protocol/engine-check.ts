// What "carries" means (house answer on #260, 10-21): a server carries an engine version when its implementation
// reproduces that version's conformance digests. Each scenario in spec/conformance/physics/ is a log holding a throw's
// inputs and no rest; replayed through a version, its rests (id, pose rounded to the millimetre, rest tick) hash to
// spec/conformance/physics/digests.json[version][scenario], and its rests' exact float bits with the engine's final snapshot
// (simlayer digestOf, what the live L3 check compares) hash to digests-exact.json (bot review #260 35). A change that still reproduces them needs no cut; a change
// meant to alter results is a new version with its own digests.
//   bun tools/protocol/engine-check.ts            check every carried version
//   bun tools/protocol/engine-check.ts --write    write the digests of a carried version the file doesn't hold yet (and of a
//                                                 new scenario); never an existing digest: a changed one means the engine
//                                                 changed its results under the same name, which --write refuses
//   EN4 holds the same against git: a version's digests equal that version's at the base (and at the file's previous version)
import fs from "node:fs";
import { createHash } from "node:crypto";
import { readLog } from "../../shared/protocol/fold.js";
import { simFold, ENGINES, digestOf as simDigest } from "../../shared/protocol/simlayer.js";
import { r3 } from "../../shared/protocol/round.js";
import * as PH from "./pinhistory.ts";
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
// EN6 (bot review #260 35): a rest moved by one ulp, which the live L3 check calls a disagreement, changes the exact digest
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
// EN4: a version's digests never change under its name, against the record (a --write that rewrote them by hand, or an edit of
// the file, would otherwise pass EN2 against the changed engine)
for (const [F, now] of [["spec/conformance/physics/digests.json", pinned], ["spec/conformance/physics/digests-exact.json", exact]] as const) { const ROOT = fileURLToPath(new URL("../../", import.meta.url));
  const e = PH.earlier(ROOT, [F], (f) => (fs.existsSync(ROOT + f) ? fs.readFileSync(ROOT + f, "utf8") : null));
  const moved = e.out.flatMap(({ rev, was }) => Object.entries<any>(was[F] ?? {}).flatMap(([ver, d]) => Object.entries<any>(d).filter(([s, x]) => now?.[ver]?.[s] !== x).map(([s, x]) => `${F.split("/").pop()} ${ver} ${s}: ${x} at ${rev.slice(0, 8)} → ${now?.[ver]?.[s] ?? "gone"}`)));
  check(`EN4 ${F.split("/").pop()}: each version's digests equal that version's at the base (and at the file's previous version) where it had them: a change meant to alter results is a new version (judged: ${e.out.map((o) => `${o.rev.slice(0, 8)} ${o.why}`).join(", ") || "no earlier version"})`, !moved.length, moved.slice(0, 6)); }
console.log(`[engine-check] ${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
