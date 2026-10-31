// What "carries" means (house answer on #260, 10-21): a server carries an engine version when its implementation
// reproduces that version's conformance digests. Each scenario in spec/conformance/physics/ is a log holding a throw's
// inputs and no rest; replayed through a version, its rests (id, pose rounded as the log rounds it, rest tick) hash to
// spec/conformance/physics/digests.json[version][scenario]. A change that still reproduces them needs no cut; a change
// meant to alter results is a new version with its own digests.
//   bun tools/protocol/engine-check.ts            check every carried version
//   bun tools/protocol/engine-check.ts --write    write the digests of a carried version the file doesn't hold yet (and of a
//                                                 new scenario); never an existing digest: a changed one means the engine
//                                                 changed its results under the same name, which --write refuses
//   EN4 holds the same against git: a version's digests equal that version's at the base (and at the file's previous version)
import fs from "node:fs";
import { createHash } from "node:crypto";
import { readLog } from "../../shared/protocol/fold.js";
import { simFold, ENGINES } from "../../shared/protocol/simlayer.js";
import { r3 } from "../../shared/protocol/round.js";
import * as PH from "./pinhistory.ts";
import { fileURLToPath } from "node:url";

const DIR = fileURLToPath(new URL("../../spec/conformance/physics/", import.meta.url)), DIG = `${DIR}digests.json`;
let pass = 0, fail = 0;
const check = (n: string, ok: boolean, info?: unknown) => { if (ok) { pass++; console.log(`ok   ${n}`); } else { fail++; console.log(`FAIL ${n}`); if (info !== undefined) console.log("     ", JSON.stringify(info).slice(0, 400)); } };
const scenarios = fs.readdirSync(DIR).filter((f) => f.endsWith(".jsonl")).map((f) => f.slice(0, -6)).sort();

/** a scenario replayed as `version`: its epoch is set to that engine; the result is what came to rest, and where, and when */
export function digestOf(text: string, version: string): string {
  const asVersion = (o: any) => o?.id === "@world" && o.comp === "physics-engine" && o.value ? { ...o, value: { ...o.value, engine: version } } : o;
  const L = readLog(text).map((e: any) => {
    const b = e?.body, body = Array.isArray(b?.ops) ? { ...b, ops: b.ops.map(asVersion) } : asVersion(b);
    return body === b ? e : { ...e, body };
  });
  const v: any = simFold(L, (L.at(-1) as any).ts + 30000);
  const rests = [...v.rested].sort((a: any, b: any) => (a.id < b.id ? -1 : 1)).map((r: any) => [r.id, r.p.map(r3), r.q.map(r3), r.restTick]);
  const live = Object.keys(v.sim?.bodies ?? {}).filter((id) => !v.sim.bodies[id].resting && v.sim.bodies[id].dyn).sort();
  return createHash("sha256").update(JSON.stringify({ rests, live })).digest("hex").slice(0, 16);
}

const carried = Object.keys(ENGINES).sort();
if (process.argv.includes("--write")) {
  const out: Record<string, Record<string, string>> = fs.existsSync(DIG) ? JSON.parse(fs.readFileSync(DIG, "utf8")) : {};
  const moved: string[] = [], added: string[] = [];
  for (const ver of carried) { const had = out[ver] ?? {}; const next: Record<string, string> = { ...had };
    for (const s of scenarios) { const d = digestOf(fs.readFileSync(`${DIR}${s}.jsonl`, "utf8"), ver);
      if (s in had) { if (had[s] !== d) moved.push(`${ver} ${s}: ${had[s]} → ${d}`); } else { next[s] = d; added.push(`${ver} ${s}`); } }
    out[ver] = next; }
  if (moved.length) { console.log(`refusing to write: the engine changed its results under the same name (a change meant to alter results is a new version with its own digests; never a rewrite of an existing one):\n  ${moved.join("\n  ")}`); process.exit(1); }
  fs.writeFileSync(DIG, JSON.stringify(out, null, 2) + "\n"); console.log(`[engine-check] wrote ${added.length} new digest(s)${added.length ? `: ${added.join(", ")}` : " (nothing new)"}`); process.exit(0);
}
const pinned = fs.existsSync(DIG) ? JSON.parse(fs.readFileSync(DIG, "utf8")) : null;
check("EN0 the digests file exists, and there are scenarios to hold an engine to", !!pinned && scenarios.length >= 5, { pinned: !!pinned, scenarios });
for (const ver of carried) {
  const d = pinned?.[ver] ?? {};
  check(`EN1 ${ver}: every scenario has a digest (a carried version without its digests is carried by nothing)`, scenarios.every((s) => typeof d[s] === "string"), { have: Object.keys(d), scenarios });
  for (const s of scenarios) {
    const got = digestOf(fs.readFileSync(`${DIR}${s}.jsonl`, "utf8"), ver);
    check(`EN2 ${ver} reproduces ${s}`, got === d[s], { got, want: d[s] });
  }
}
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
{ const F = "spec/conformance/physics/digests.json"; const ROOT = fileURLToPath(new URL("../../", import.meta.url));
  const e = PH.earlier(ROOT, [F], (f) => (fs.existsSync(ROOT + f) ? fs.readFileSync(ROOT + f, "utf8") : null));
  const moved = e.out.flatMap(({ rev, was }) => Object.entries<any>(was[F] ?? {}).flatMap(([ver, d]) => Object.entries<any>(d).filter(([s, x]) => pinned?.[ver]?.[s] !== x).map(([s, x]) => `${ver} ${s}: ${x} at ${rev.slice(0, 8)} → ${pinned?.[ver]?.[s] ?? "gone"}`)));
  check(`EN4 each version's digests equal that version's at the base (and at the file's previous version) where it had them: a change meant to alter results is a new version (judged: ${e.out.map((o) => `${o.rev.slice(0, 8)} ${o.why}`).join(", ") || "no earlier version"})`, !moved.length, moved.slice(0, 6)); }
console.log(`[engine-check] ${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
