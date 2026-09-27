// client/lib/lod_policy.js — the tier chooser, tested headless.
//
//   bun tools/lod-policy-test.ts
//
// The contract under test (the #156 client half): the tier is chosen BEFORE
// the fetch from the resident's dial, the distance against the entity's own
// residency radius, and device pressure — and NEVER asked for unless the
// running sequencer published a recipe (the split-brain gate, third time
// applied). Hysteresis keeps a band-edge placement from flip-flopping; the
// governor's shed and GPU pressure pull the reduce-at edge inward; the dial
// pins full; 'eco' is the pressured band, always — near stays full on every
// dial (the first field run's arm's-length slabs). The served tier is read
// off the reducer's identity stamp — lodOf plus the RUNNING recipe, never a
// bare `recipe` extra an author may have written — and the tier a load IS
// is what crossed the wire (askFor), never what the policy wished: no KTX2
// transcoder, no key, no recipe, no .glb → no lod ask, reported as none.
//
// Negative control: on main this file dies at import (no lod_policy.js).

import { MODEL_QUALITY, LOD_FRACTION, LOD_HYST, PRESSURE_EDGE, PRESSURE_AT,
  makeModelQuality, chooseTier, tierOf, askFor } from "../client/lib/lod_policy.js";

let failures = 0;
const check = (label: string, ok: boolean, detail?: string) => {
  console.log(`  ${ok ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m"} ${label}${!ok && detail ? `\n      ${detail}` : ""}`);
  if (!ok) failures++;
};
console.log("\nlod_policy — the tier chooser:\n");

const R = 100;                       // a residency radius; edge = 45m at LOD_FRACTION 0.45
const REC = "lod1-r25e01-texel1024";
const edge = R * LOD_FRACTION;

// ---- the gate: no recipe, no tier — ever
check("no recipe published → 'full', however far", chooseTier({ dist: 1e6, radius: R, recipe: null }) === "full");
check("…even on 'eco'", chooseTier({ dist: 1e6, radius: R, recipe: null, quality: "eco" }) === "full");
check("…even under pressure and shed", chooseTier({ dist: 1e6, radius: R, recipe: null, pressure: 9, shed: true }) === "full");

// ---- the dial's extremes ignore distance
check("'full' never reduces", chooseTier({ dist: 1e6, radius: R, recipe: REC, quality: "full" }) === "full");
check("'eco' is the pressured band, always — reduces past the HALVED edge",
  chooseTier({ dist: edge * PRESSURE_EDGE * 1.2, radius: R, recipe: REC, quality: "eco" }) === "lod"
  && chooseTier({ dist: edge * PRESSURE_EDGE * 1.2, radius: R, recipe: REC }) === "full");
check("…and what you stand beside stays full on 'eco': no dial reduces near",
  chooseTier({ dist: edge * PRESSURE_EDGE * 0.8, radius: R, recipe: REC, quality: "eco" }) === "full"
  && chooseTier({ dist: 1, radius: R, recipe: REC, quality: "eco" }) === "full");

// ---- 'auto': the distance band against the entity's OWN radius
check("near → full", chooseTier({ dist: edge * 0.5, radius: R, recipe: REC }) === "full");
check("far → lod", chooseTier({ dist: edge * 1.5, radius: R, recipe: REC }) === "lod");
check("a bigger entity (bigger radius) goes reduced later", chooseTier({ dist: 60, radius: 100, recipe: REC }) === "lod"
  && chooseTier({ dist: 60, radius: 200, recipe: REC }) === "full");
check("a missing/zero radius falls back to the base radius, never divides by zero",
  chooseTier({ dist: 1, radius: 0, recipe: REC }) === "full" && chooseTier({ dist: 1e6, radius: 0, recipe: REC }) === "lod");

// ---- hysteresis: the edge you cross depends on what you wear
const inner = edge * (1 - LOD_HYST), outer = edge * (1 + LOD_HYST);
check("wearing full, just past the edge is still full (no flip at the line)", chooseTier({ dist: edge * 1.1, radius: R, recipe: REC, current: "full" }) === "full");
check("wearing full, past the OUTER edge → lod", chooseTier({ dist: outer * 1.01, radius: R, recipe: REC, current: "full" }) === "lod");
check("wearing lod, just inside the edge is still lod", chooseTier({ dist: edge * 0.9, radius: R, recipe: REC, current: "lod" }) === "lod");
check("wearing lod, inside the INNER edge → full", chooseTier({ dist: inner * 0.99, radius: R, recipe: REC, current: "lod" }) === "full");
{ // a walk across the band flips exactly once each way
  let tier = "full"; let flips = 0;
  for (let d = 0; d <= 2 * edge; d += edge / 50) { const t = chooseTier({ dist: d, radius: R, recipe: REC, current: tier }); if (t !== tier) { flips++; tier = t; } }
  for (let d = 2 * edge; d >= 0; d -= edge / 50) { const t = chooseTier({ dist: d, radius: R, recipe: REC, current: tier }); if (t !== tier) { flips++; tier = t; } }
  check("a walk out and back flips tier exactly twice (once each way), never chatters", flips === 2 && tier === "full", `${flips} flips, ends ${tier}`);
}

// ---- pressure and shed pull the edge inward
const pressuredEdge = edge * PRESSURE_EDGE;
check("under GPU pressure the edge halves (a mid-distance object goes reduced)",
  chooseTier({ dist: pressuredEdge * 1.2, radius: R, recipe: REC, pressure: PRESSURE_AT }) === "lod"
  && chooseTier({ dist: pressuredEdge * 1.2, radius: R, recipe: REC, pressure: PRESSURE_AT * 0.5 }) === "full");
check("the governor's shed does the same, without pressure", chooseTier({ dist: pressuredEdge * 1.2, radius: R, recipe: REC, shed: true }) === "lod");
check("but neither overrides the resident's 'full'", chooseTier({ dist: 1e6, radius: R, recipe: REC, quality: "full", pressure: 9, shed: true }) === "full");

// ---- the dial: persisted, refuses unknowns, shed is session-only
{
  const store = new Map<string, string>();
  const fake = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); } };
  const q = makeModelQuality(fake);
  check("defaults to 'auto'", q.quality === "auto" && MODEL_QUALITY[0] === "auto");
  check("a choice persists", q.setQuality("eco") === "eco" && store.get("ew-model-quality") === "eco");
  check("…and comes back on the next boot", makeModelQuality(fake).quality === "eco");
  check("an unknown level is refused, the current one stands", q.setQuality("ultra" as any) === "eco");
  check("the governor's shed is a session dial — never written", q.setShed(true) === true && !store.has("shed") && makeModelQuality(fake).shed === false);
  check("no store at all → session-only, still works", makeModelQuality(undefined).setQuality("full") === "full");
}

// ---- the served tier is the REDUCER's stamp, bound to the running recipe (review of #170, point 1)
const stamped = (recipe: string) => ({ asset: { extras: { lodOf: "9f2c…", recipe, tools: { meshoptimizer: "0.2x", encoder: "toktx" } } } });
check("the reducer's stamp under the running recipe is 'lod'", tierOf(stamped(REC), REC) === "lod");
check("an authored model's own `recipe` extra is NOT a lod — source extras survive the reducer, and a full model must keep its collider",
  tierOf({ asset: { extras: { recipe: "chef-special" } } }, REC) === "full"
  && tierOf({ asset: { extras: { recipe: REC } } }, REC) === "full");
check("a WRONG-GENERATION stamp is 'full' — a stale variant is not this recipe's tier", tierOf(stamped("lod0-r50e05-texel2048"), REC) === "full");
check("without the stamp — the original chain answered — 'full', honestly", tierOf({ asset: { extras: {} } }, REC) === "full" && tierOf({}, REC) === "full" && tierOf(null, REC) === "full");
check("no running recipe → nothing is ever 'lod', stamp or not", tierOf(stamped(REC), null) === "full");

// ---- the WIRE truth (review of #170, point 2): the tier a load IS is what the URL asks, never what the policy wished
{
  const lib = "eidoverse/assets/models/thing.glb";
  const yes = askFor({ libPath: lib, key: "3", capable: true, recipe: REC, tier: "lod" });
  check("transcoder + key + recipe: a lod ask crosses the wire, on top of the ktx2 negotiation",
    yes.tier === "lod" && yes.url === `${lib}?ktx2=3&lod=${encodeURIComponent(REC)}`, yes.url);
  const noTranscoder = askFor({ libPath: lib, key: "3", capable: true && false, recipe: REC, tier: "lod" });
  check("no KTX2 transcoder: NO lod on the wire — the ask is honestly 'full', and not even ktx2 negotiates",
    noTranscoder.tier === "full" && noTranscoder.url === lib, noTranscoder.url);
  const noKey = askFor({ libPath: lib, key: null, capable: true, recipe: REC, tier: "lod" });
  check("no key published: the same — an older sequencer is exactly today's behaviour", noKey.tier === "full" && noKey.url === lib);
  const noRecipe = askFor({ libPath: lib, key: "3", capable: true, recipe: null, tier: "lod" });
  check("no recipe published: ktx2 negotiates, lod does not", noRecipe.tier === "full" && noRecipe.url === `${lib}?ktx2=3`, noRecipe.url);
  const body = askFor({ libPath: "eidoverse/assets/vrms/body.vrm", key: "3", capable: true, recipe: REC, tier: "lod" });
  check("a non-.glb path never negotiates a tier (bodies are the server's refusal AND the client's silence)", body.tier === "full" && !body.url.includes("lod="));
  const full = askFor({ libPath: lib, key: "3", capable: true, recipe: REC, tier: "full" });
  check("a 'full' choice is a plain ktx2 fetch", full.tier === "full" && full.url === `${lib}?ktx2=3`);
}

console.log(failures ? `\n\x1b[31m${failures} failed\x1b[0m` : "\n\x1b[32m0 failed\x1b[0m");
process.exit(failures ? 1 : 0);
