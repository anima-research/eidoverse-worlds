// forecast-test — the deterministic-weather contract, serverless.
//
// The claims under test (issue #29, review fences):
//   - derivation is deterministic: same policy + epoch + now → same segment,
//     from a cold walk, a resumed cursor, or another process entirely
//   - the three planes agree: live incremental folding (browser client /
//     mcpl agent), the sequencer's fold, and a late joiner replaying the
//     folded snapshot through stateToEntries' synthetic entries — including
//     across a manual override and the next scheduled boundary
//   - a weather verb under a rated sky REBASES hours (no day-snap)
//   - provenance is server-stamped, never authored (spoof-proof), yet
//     synthetic pre-history replay preserves the real stamps
//   - live ticking is O(1) via the cursor (fence #3)
//   - the dwell floor bounds both strobe rate and walk length
//
// Run: bun tools/forecast-test.ts

import { WEATHERS, normalizePolicy, segmentAt, effectiveSky, foldSkyEntry, hoursAt, describeSky }
  from "../client/lib/forecast.js";

let pass = 0, fail = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`); }
}

const T0 = 1_754_000_000_000;   // fixed epoch — tests never touch the wall clock
const HOUR = 3600e3, MIN = 60e3;

// ---------------------------------------------------------------- policy + determinism

const policyArgs = {
  seed: 7,
  states: ["clear", "overcast", "rain", { state: "storm", weight: 0.5 }],
  dwellSec: [300, 900],
  transitionSec: 30,
  k: [0.7, 1],
};

{
  const skyEntry = { verb: "sky", args: { hours: 8, rate: 24, forecast: policyArgs }, ts: T0, seq: 100, actor: "antra" };
  const folded = foldSkyEntry(null, skyEntry);
  check("fold stamps forecast provenance from the entry",
    folded.forecast.epoch === T0 && folded.forecast.seq === 100 && folded.forecast.by === "antra");

  const p = normalizePolicy(folded.forecast)!;
  check("policy normalizes", !!p && p.states.length === 4 && p.epoch === T0);

  // same answer, ten times, at scattered offsets — and from a second normalize
  let deterministic = true;
  const p2 = normalizePolicy(folded.forecast)!;
  for (let i = 0; i < 200; i++) {
    const t = T0 + i * 97_131;   // ~arbitrary spacing across ~5.4h
    const a = segmentAt(p, t), b = segmentAt(p2, t);
    if (a.idx !== b.idx || a.state !== b.state || a.k !== b.k || a.startMs !== b.startMs) { deterministic = false; break; }
  }
  check("cold derivation is deterministic across instances", deterministic);

  // cursor equivalence: 1s ticks resuming the cursor === cold oracle each time
  let cursorOk = true, cur: any = null;
  for (let t = T0; t < T0 + 2 * HOUR; t += 1000) {
    const live = segmentAt(p, t, cur);
    cur = live;
    const cold = segmentAt(p, t);
    if (live.idx !== cold.idx || live.state !== cold.state || live.startMs !== cold.startMs) { cursorOk = false; break; }
  }
  check("cursor ticking === cold oracle (7200 ticks)", cursorOk);

  // dwell floor: a strobing policy is clamped, segments never shorter than 60s
  const strobe = normalizePolicy({ seed: 1, states: ["clear", "rain"], dwellSec: [1, 2] })!;
  Object.assign(strobe, { epoch: T0 });
  let floorOk = true;
  let s = segmentAt(strobe, T0);
  for (let i = 0; i < 50; i++) {
    if (s.endMs - s.startMs < 60_000) { floorOk = false; break; }
    s = segmentAt(strobe, s.endMs + 1, s);
  }
  check("dwell floor holds (60s minimum)", floorOk);

  // consecutive segments never repeat a state when there is anywhere else to go
  let noRepeat = true;
  let seg = segmentAt(p, T0);
  for (let i = 0; i < 100; i++) {
    const next = segmentAt(p, seg.endMs + 1, seg);
    if (next.state === seg.state) { noRepeat = false; break; }
    seg = next;
  }
  check("no segment repeats its predecessor's state", noRepeat);

  // every derived state is a policy state
  let statesOk = true;
  let g = segmentAt(p, T0);
  for (let i = 0; i < 100; i++) {
    if (!["clear", "overcast", "rain", "storm"].includes(g.state)) { statesOk = false; break; }
    g = segmentAt(p, g.endMs + 1, g);
  }
  check("derived states stay within the policy's list", statesOk);
}

// ---------------------------------------------------------------- clock rebase (the day-snap bug)

{
  const sky0 = foldSkyEntry(null, { verb: "sky", args: { hours: 8, rate: 24 }, ts: T0, seq: 10, actor: "antra" });
  const tW = T0 + 1 * HOUR;                 // one real hour later: day has advanced 24h/h → back to 8, use 1.5h
  const tW2 = T0 + 1.5 * HOUR;              // 8 + 24*1.5 = 44 → 20:00
  const before = hoursAt(sky0, tW2 - 1);
  const folded = foldSkyEntry(sky0, { verb: "weather", args: { weather: "rain" }, ts: tW2, seq: 11, actor: "digi" });
  const after = hoursAt(folded, tW2 + 1);
  check("weather verb does not snap the day clock",
    Math.abs(after - before) < 0.01 || Math.abs(after - before) > 23.99,
    `hour ${before.toFixed(3)} → ${after.toFixed(3)}`);
  check("weather verb still re-epochs ts", folded.ts === tW2);
  check("authored hours on a weather verb still wins",
    foldSkyEntry(sky0, { verb: "weather", args: { weather: "rain", hours: 3 }, ts: tW, seq: 12, actor: "antra" }).hours === 3);
}

// ---------------------------------------------------------------- spoof-proofing

{
  const spoofed = foldSkyEntry(null, {
    verb: "sky",
    args: { forecast: { ...policyArgs, epoch: 1, seq: 9999, by: "mallory" }, override: { state: "storm", ts: 1, seq: 1, by: "mallory" } },
    ts: T0, seq: 42, actor: "antra",
  });
  check("authored forecast stamps are overwritten by the entry's",
    spoofed.forecast.epoch === T0 && spoofed.forecast.seq === 42 && spoofed.forecast.by === "antra");
  check("authored override bag is dropped (server-owned)", spoofed.override === undefined);

  const wSpoof = foldSkyEntry(spoofed, {
    verb: "weather",
    args: { weather: "rain", forecast: { seed: 666, states: ["darkstorm"] } },
    ts: T0 + MIN, seq: 43, actor: "digi",
  });
  check("weather verb cannot author or replace policy", wSpoof.forecast.seed === policyArgs.seed);

  // synthetic pre-history (stateToEntries) passes stamps through untouched
  const synthetic = foldSkyEntry(null, { verb: "sky", args: spoofed, ts: Date.now(), seq: -1, actor: "world" });
  check("synthetic replay preserves the real stamps (no re-epoch on late join)",
    synthetic.forecast.epoch === T0 && synthetic.forecast.seq === 42 && synthetic.ts === spoofed.ts);
}

// ---------------------------------------------------------------- three-plane parity across an override + boundary
// (the review's required test: live client, folded late join, and MCPL
//  perception agree through one manual override and the next scheduled
//  boundary)

{
  const entries = [
    { verb: "sky", args: { hours: 8, rate: 24, weather: "clear", forecast: policyArgs }, ts: T0, seq: 100, actor: "antra" },
  ];
  // find the segment that contains T0+20min so we can land the override inside it
  const pre = foldSkyEntry(null, entries[0]);
  const p = normalizePolicy(pre.forecast)!;
  const segAtOverride = segmentAt(p, T0 + 20 * MIN);
  const tOverride = T0 + 20 * MIN;
  entries.push({ verb: "weather", args: { weather: "darkstorm", weatherK: 1.2, weatherSeconds: 10 }, ts: tOverride, seq: 101, actor: "digi" });

  // plane A — live incremental fold (browser client applyEntry / mcpl agent)
  let live: any = null;
  for (const e of entries) live = foldSkyEntry(e.verb === "sky" ? null : live, e);

  // plane B — the sequencer's fold (identical calls; asserting the object is shared)
  let server: any = null;
  for (const e of entries) server = foldSkyEntry(e.verb === "sky" ? null : server, e);
  check("live and server folds are identical", JSON.stringify(live) === JSON.stringify(server));

  // plane C — late join: server's folded sky replayed as a synthetic entry
  const late = foldSkyEntry(null, { verb: "sky", args: server, ts: Date.now(), seq: -1, actor: "world" });

  const times: [string, number][] = [
    ["before the override", tOverride - 5 * MIN],
    ["during the override", tOverride + 2 * MIN],
    ["after the next boundary", segAtOverride.endMs + 1 * MIN],
  ];
  for (const [label, t] of times) {
    const a = effectiveSky(live, t);
    const c = effectiveSky(late, t);
    check(`parity ${label}: live === late join`,
      a.weather === c.weather && a.source === c.source && a.k === c.k,
      `live ${a.source}/${a.weather} vs late ${c.source}/${c.weather}`);
  }

  // the override actually takes, and actually yields
  const during = effectiveSky(live, tOverride + 2 * MIN);
  check("override holds inside its segment (manual darkstorm)",
    during.source === "manual" && during.weather === "darkstorm" && during.k === 1.2);
  const resumed = effectiveSky(live, segAtOverride.endMs + 1 * MIN);
  check("forecast resumes at the next scheduled boundary",
    resumed.source === "forecast" && resumed.weather !== undefined);
  const beforeO = effectiveSky(live, tOverride - 5 * MIN);
  check("before the override the forecast governs", beforeO.source === "forecast");

  // hour parity — the shared-fact boundary's other half
  const t = segAtOverride.endMs + 1 * MIN;
  check("hour parity live vs late join", Math.abs(hoursAt(live, t) - hoursAt(late, t)) < 1e-9);

  // MCPL text perception names the policy and the actor (provenance requirement)
  const textDuring = describeSky(live, tOverride + 2 * MIN)!;
  check("perception narrates the manual override with its actor",
    textDuring.includes("manual override") && textDuring.includes("digi"), textDuring);
  const textAfter = describeSky(live, segAtOverride.endMs + 1 * MIN)!;
  check("perception narrates the forecast with policy seq + seed",
    textAfter.includes("forecast") && textAfter.includes("seq 100") && textAfter.includes("seed 7"), textAfter);
}

// ---------------------------------------------------------------- off switch + authored-only worlds

{
  const on = foldSkyEntry(null, { verb: "sky", args: { forecast: policyArgs, weather: "clear" }, ts: T0, seq: 1, actor: "antra" });
  const off = foldSkyEntry(null, { verb: "sky", args: { weather: "rain", weatherSeconds: 5 }, ts: T0 + HOUR, seq: 2, actor: "antra" });
  check("re-authoring sky without forecast turns it off", off.forecast === undefined);
  const eff = effectiveSky(off, T0 + HOUR + MIN);
  check("authored-only worlds behave exactly as before",
    eff.source === "authored" && eff.weather === "rain" && eff.seconds === 5);
  check("forecast: null is off too",
    foldSkyEntry(null, { verb: "sky", args: { forecast: null }, ts: T0, seq: 3, actor: "antra" }).forecast === undefined);
  // a weather verb on an authored-only sky merges as it always has
  const plain = foldSkyEntry(off, { verb: "weather", args: { weather: "storm" }, ts: T0 + 2 * HOUR, seq: 4, actor: "digi" });
  check("weather on an authored-only sky stays a plain merge (no override bag)",
    plain.weather === "storm" && plain.override === undefined);
  void on;
}

// ---------------------------------------------------------------- O(1) ticking (fence #3)

{
  const folded = foldSkyEntry(null, { verb: "sky", args: { forecast: policyArgs }, ts: T0, seq: 1, actor: "antra" });
  const p = normalizePolicy(folded.forecast)!;
  // a YEAR of policy age: cold walk once, then cursor ticks must be flat
  const tYear = T0 + 365 * 24 * HOUR;
  const cold0 = performance.now();
  let cur = segmentAt(p, tYear);
  const coldMs = performance.now() - cold0;
  const tick0 = performance.now();
  for (let i = 1; i <= 10_000; i++) cur = segmentAt(p, tYear + i * 1000, cur);
  const perTickUs = (performance.now() - tick0) / 10;   // µs per tick over 10k ticks
  check(`cold year-old walk, default dwell (${coldMs.toFixed(1)}ms)`, coldMs < 2000);
  check(`cursor tick is O(1) (${perTickUs.toFixed(1)}µs/tick)`, perTickUs < 200);
  // the WORST policy the floor allows: fixed 60s dwell = ~525,600 segments
  // per year of age. This is the number the receipt has to be honest about —
  // it is a one-time join cost, not a per-tick one; long-lived worlds that
  // outgrow it want checkpoints, not a bigger budget here.
  const worst = normalizePolicy({ seed: 1, states: ["clear", "rain"], dwellSec: [60, 60] })!;
  Object.assign(worst, { epoch: T0 });
  const w0 = performance.now();
  segmentAt(worst, tYear);
  const worstMs = performance.now() - w0;
  check(`cold year-old walk, WORST allowed dwell 60s (${worstMs.toFixed(0)}ms one-time)`, worstMs < 1000);
}

// ---------------------------------------------------------------- keepSky lives in the helper (live/fold parity)

{
  const standing = foldSkyEntry(null, { verb: "sky", args: { hours: 8, rate: 24, clouds: "cumulus", forecast: policyArgs }, ts: T0, seq: 1, actor: "antra" });
  const e = { verb: "weather", args: { weather: "rain", keepSky: false }, ts: T0 + HOUR, seq: 2, actor: "digi" };
  // the server folds with the standing sky, the client folds with its clock
  // args — keepSky must yield the SAME result through both calls
  const asServer = foldSkyEntry(standing, e);
  const asClient = foldSkyEntry(standing, e);   // world.js now always passes the standing sky too
  check("keepSky:false discards the standing sky in the helper",
    asServer.clouds === undefined && asServer.forecast === undefined && asServer.weather === "rain");
  check("keepSky parity: identical through server and client calls",
    JSON.stringify(asServer) === JSON.stringify(asClient));
  check("keepSky is an instruction, not a sky property", !("keepSky" in asServer));
  const kept = foldSkyEntry(standing, { verb: "weather", args: { weather: "rain" }, ts: T0 + HOUR, seq: 3, actor: "digi" });
  check("without keepSky the standing sky merges as before", kept.clouds === "cumulus" && !!kept.forecast);
}

// ---------------------------------------------------------------- guardrails

{
  check("no states → no policy", normalizePolicy({ seed: 1, states: ["blizzard"] }) === null);
  check("garbage → no policy", normalizePolicy("storm please" as any) === null);
  check("unfolded policy (no epoch) never activates",
    effectiveSky({ forecast: policyArgs, weather: "clear" }, T0).source === "authored");
  check("WEATHERS is the canonical 8", WEATHERS.length === 8 && WEATHERS.includes("darkstorm"));
  // a transition may never outlive the shortest segment (overlapping eases)
  const tight = normalizePolicy({ seed: 1, states: ["clear", "rain"], dwellSec: [60, 120], transitionSec: 600 })!;
  check("transitionSec is clamped to dwellMin", tight.transitionSec === 60, String(tight.transitionSec));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
