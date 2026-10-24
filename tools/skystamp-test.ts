// skystamp-test — the sky's provenance survives the real authority (#260 review I286).
// The authority stores @world.sky without seq/by (a value doesn't carry its own log position; the log does), so the
// replica names the entry that wrote it and the agent stamps the view with it: a forecast boundary still reads
// "policy sky seq N by <who>", as skywatch-test requires of the serverless path.
//
//   BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun tools/skystamp-test.ts
import "./protocol/fixture-ids.ts";
import { scratchWorld } from "./protocol/scratchworld.ts";
import { makeReplica, wireState } from "../shared/protocol/replica.js";
import { effectiveSky } from "../shared/forecast.js";

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail: unknown = "") => {
  if (ok) { pass++; console.log(`  ok  ${name}`); } else { fail++; console.log(`FAIL  ${name} — ${JSON.stringify(detail)}`); }
};
const W = scratchWorld("skystamp").seed({});
const r = makeReplica(); r.adopt(JSON.parse(JSON.stringify({ state: wireState(W.state()), head: W.entries().length - 1 })));
const from = W.entries().length;
const res = W.send({ verb: "sky", args: { forecast: { seed: 7, states: ["clear", "rain"], dwellSec: [300, 900], transitionSec: 20 } } });
check("(setup) the owner sets a forecast", res?.ok === true, res);
const got = r.ingest(JSON.parse(JSON.stringify(W.entries().slice(from))), from);
const stored = r.st.entities["@world"]?.c.sky;
check("the stored value carries no seq/by (the log does)", stored && stored.forecast && stored.forecast.seq === undefined, stored?.forecast);
check("the replica names the entry that wrote the sky: its seq and who", Number.isInteger(got.sky?.seq) && typeof got.sky?.by === "string" && got.sky.by.length > 0, got.sky);
const eff = effectiveSky(stored, Date.now());
check("the forecast is live from that value (so the stamp is what names it)", eff.source === "forecast", eff.source);
console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
