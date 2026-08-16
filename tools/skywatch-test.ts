// skywatch-test — the ambient sky percept, serverless.
//
// The contract (issue #29 follow-up): resting agents must HEAR the sky change,
// not merely be able to ask. One ambient event per meaningful boundary —
// forecast segment change, manual override landing/expiring, coarse day-phase
// crossing — deduped by signature, derived from the same pure oracle look()
// uses, never a synthetic log verb, never a continuous clock.
//
// Run: bun tools/skywatch-test.ts
//
// Worktree reproduction note (#65 review N4): importing mcpl/agent.ts pulls
// three/webgpu, so a bare worktree needs the NESTED node_modules symlinks —
// client/node_modules and mcpl/node_modules — from the main checkout, not
// just the top-level one, or this suite dies at import and looks broken
// when it isn't.

import { WorldAgent } from "../mcpl/agent.ts";
import { normalizePolicy, segmentAt, foldSkyEntry } from "../shared/forecast.js";

let pass = 0, fail = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`); }
}

const T0 = 1_754_000_000_000;
const MIN = 60e3, HOUR = 3600e3;
const policyArgs = { seed: 7, states: ["clear", "overcast", "rain"], dwellSec: [300, 900], transitionSec: 20 };

function rig(skyEntry: any) {
  const ag = new WorldAgent({ name: "skywatch" });
  const events: any[] = [];
  ag.onEvent = (ev) => { if (ev.kind === "weather") events.push(ev); };
  const A = ag as any;
  A.applyEntry(skyEntry, false);
  return { ag: A, events };
}

// ---------------------------------------------------------------- A: forecast boundaries (rate 0 — no phase noise)

{
  const { ag, events } = rig({ verb: "sky", args: { hours: 12, rate: 0, forecast: policyArgs }, ts: T0, seq: 100, actor: "antra" });
  const p = normalizePolicy(ag.skyState.forecast)!;
  const seg0 = segmentAt(p, T0);

  ag.checkSky(T0 + 1000);
  check("first observation is silent (arrival is look()'s job)", events.length === 0);
  ag.checkSky(T0 + (seg0.endMs - T0) / 2);
  check("mid-segment ticks stay quiet", events.length === 0);

  ag.checkSky(seg0.endMs + 1000);
  check("segment boundary emits exactly one event", events.length === 1);
  check("boundary event carries provenance",
    /forecast/.test(events[0]?.text) && /seq 100/.test(events[0]?.text) && /antra/.test(events[0]?.text),
    events[0]?.text);
  ag.checkSky(seg0.endMs + 2000);
  ag.checkSky(seg0.endMs + 3000);
  check("deduped: repeated checks in the same segment add nothing", events.length === 1);

  // walk three more boundaries — one event each, all states from the policy
  const seg1 = segmentAt(p, seg0.endMs + 1000);
  const seg2 = segmentAt(p, seg1.endMs + 1000, seg1);
  const seg3 = segmentAt(p, seg2.endMs + 1000, seg2);
  ag.checkSky(seg2.startMs + 1000);
  ag.checkSky(seg3.startMs + 1000);
  check("each later boundary emits once", events.length === 3, `got ${events.length}`);
  check("no day-phase events under rate 0", events.every((e: any) => /world weather/.test(e.text)));
}

// ---------------------------------------------------------------- B: day phases (rate 24, authored-only weather)

{
  const { ag, events } = rig({ verb: "sky", args: { hours: 8, rate: 24, weather: "clear" }, ts: T0, seq: 100, actor: "antra" });
  ag.checkSky(T0 + 1000);                       // world hour ~8 — day; init silent
  check("phase init is silent", events.length === 0);
  ag.checkSky(T0 + (4 / 24) * HOUR);            // world hour 12 — still day
  check("no event within one phase", events.length === 0);
  ag.checkSky(T0 + (10.5 / 24) * HOUR);         // world hour 18.5 — dusk
  check("dusk crossing emits", events.length === 1 && /dusk/.test(events[0]?.text), events[0]?.text);
  ag.checkSky(T0 + (13.5 / 24) * HOUR);         // world hour 21.5 — night
  check("night crossing emits", events.length === 2 && /night/.test(events[1]?.text), events[1]?.text);
  ag.checkSky(T0 + (14 / 24) * HOUR);           // world hour 22 — still night
  check("still-night tick is quiet", events.length === 2);
  check("no weather-change events without a forecast or verb", events.every((e: any) => !/world weather/.test(e.text)));
}

// ---------------------------------------------------------------- C: manual override lands, then expires

{
  const { ag, events } = rig({ verb: "sky", args: { hours: 12, rate: 0, forecast: policyArgs }, ts: T0, seq: 100, actor: "antra" });
  const p = normalizePolicy(ag.skyState.forecast)!;
  ag.checkSky(T0 + 1000);                       // init
  const seg = segmentAt(p, T0 + 20 * MIN);
  const tO = T0 + 20 * MIN;
  ag.applyEntry({ verb: "weather", args: { weather: "storm", weatherK: 1.1 }, ts: tO, seq: 101, actor: "digi" }, true);
  // boundary events between init and the override (if any) are legitimate —
  // count from here
  const before = events.length;
  ag.checkSky(tO + 1000);
  check("override landing emits with the actor's name",
    events.length === before + 1 && /storm/.test(events.at(-1)?.text) && /digi/.test(events.at(-1)?.text),
    events.at(-1)?.text);
  ag.checkSky(tO + 2000);
  check("override event is deduped", events.length === before + 1);
  ag.checkSky(seg.endMs + 1000);
  check("override expiry emits the forecast's resumption",
    events.length === before + 2 && /forecast/.test(events.at(-1)?.text), events.at(-1)?.text);
}

// ---------------------------------------------------------------- D: static skies stay silent

{
  const { ag, events } = rig({ verb: "sky", args: { hours: 12, rate: 0, weather: "rain" }, ts: T0, seq: 100, actor: "antra" });
  for (let i = 0; i < 10; i++) ag.checkSky(T0 + i * 10 * MIN);
  check("authored-only static sky never speaks", events.length === 0);

  const agNone = new WorldAgent({ name: "skywatch-none" }) as any;
  let boomed = false;
  try { agNone.checkSky(T0); } catch { boomed = true; }
  check("no sky at all is a no-op, not a crash", !boomed);
}

// the folded-state parity leg: the watcher keys off the SAME fold the
// sequencer writes, so a late-join snapshot resumes the watch without a spam
// burst — synthetic replay folds to the identical skyState
{
  const liveFold = foldSkyEntry(null, { verb: "sky", args: { hours: 12, rate: 0, forecast: policyArgs }, ts: T0, seq: 100, actor: "antra" });
  const { ag, events } = rig({ verb: "sky", args: liveFold, ts: Date.now(), seq: -1, actor: "world" });
  check("synthetic late-join fold matches the live fold", JSON.stringify(ag.skyState) === JSON.stringify(liveFold));
  ag.checkSky(T0 + 5 * MIN);
  check("late join initializes the watch silently", events.length === 0);
}

// ---------------------------------------------------------------- E: two agents, one boundary id

{
  const entry = { verb: "sky", args: { hours: 12, rate: 0, forecast: policyArgs }, ts: T0, seq: 100, actor: "antra" };
  const a = rig(entry), b = rig(entry);
  const p = normalizePolicy(a.ag.skyState.forecast)!;
  const seg0 = segmentAt(p, T0);
  // b joins late — different first observation time, same oracle
  a.ag.checkSky(T0 + 1000);
  b.ag.checkSky(seg0.startMs + (seg0.endMs - seg0.startMs) / 2);
  a.ag.checkSky(seg0.endMs + 1000);
  b.ag.checkSky(seg0.endMs + 1000);
  check("two agents emit at the same boundary", a.events.length === 1 && b.events.length === 1);
  check("two agents derive the same boundary id (signature key match)",
    a.ag.lastSkyKey === b.ag.lastSkyKey && /forecast:1:/.test(a.ag.lastSkyKey),
    `${a.ag.lastSkyKey} vs ${b.ag.lastSkyKey}`);
  check("their narrated states agree", a.events[0]?.text === b.events[0]?.text, `${a.events[0]?.text} vs ${b.events[0]?.text}`);
}

// ---------------------------------------------------------------- F: look()'s World.sky stays a structured object
// (postdeploy regression, Sill: #37 briefly replaced the object with a bare
//  description string, silently breaking every consumer of {hours, clouds,
//  ts, …}. Type stability is now pinned: folded fields preserved, derivation
//  ADDED — currentHour/currentWeather/source/description alongside, never
//  instead.)

{
  const { ag } = rig({ verb: "sky", args: { hours: 8, rate: 24, clouds: "cumulus", azimuth: 200, forecast: policyArgs }, ts: T0, seq: 100, actor: "antra" });
  ag.look();
  const sky = ag.worldInfo.sky;
  check("World.sky is an object, not a string", typeof sky === "object" && sky !== null && typeof sky !== "string");
  check("authored/folded fields survive (hours, clouds, azimuth, ts, forecast)",
    sky.hours === 8 && sky.clouds === "cumulus" && sky.azimuth === 200 && sky.ts === T0 && !!sky.forecast,
    JSON.stringify(sky));
  check("derived fields ride alongside",
    typeof sky.currentHour === "number" && typeof sky.description === "string"
      && ["authored", "forecast", "manual"].includes(sky.source)
      && (sky.currentWeather === undefined || typeof sky.currentWeather === "string"),
    JSON.stringify({ currentHour: sky.currentHour, currentWeather: sky.currentWeather, source: sky.source }));

  // pre-forecast worlds keep their exact old shape too (plus the new derived fields)
  const plain = rig({ verb: "sky", args: { hours: 12, weather: "rain" }, ts: T0, seq: 1, actor: "antra" });
  plain.ag.look();
  const ps = plain.ag.worldInfo.sky;
  check("authored-only sky is structured with derivation added",
    typeof ps === "object" && ps.hours === 12 && ps.weather === "rain" && ps.source === "authored"
      && ps.currentWeather === "rain" && typeof ps.description === "string",
    JSON.stringify(ps));
}

// ---------------------------------------------------------------- F: clock contract in look() (#65)
// The issue's receipt was look() itself: one sky object carrying stale
// hours/rate beside clock:'real'. The agent plane must serialize the
// normalized bag plus the canonical effectiveClock, and ambient day-phase
// perception must keep working with no top-level rate at all.

{
  // accelerated commons shape, then the owner flips to real time re-issuing
  // the standing bag (the tuner's gather() spread — the seq 4777 shape)
  const { ag, events } = rig({ verb: "sky", args: { hours: 6.8, rate: 24, clouds: "cumulus", forecast: policyArgs }, ts: T0, seq: 2561, actor: "mica" });
  ag.applyEntry({ verb: "sky", args: { ...ag.skyState, clock: "real", tz: "America/Los_Angeles" }, ts: T0 + HOUR, seq: 4777, actor: "antra" }, false);
  ag.look();
  const sky = ag.worldInfo.sky;
  check("#65 look(): no stale active-looking hours/rate under a real clock",
    sky.rate === undefined && sky.hours === undefined && sky.clock === "real",
    JSON.stringify({ hours: sky.hours, rate: sky.rate, clock: sky.clock }));
  check("#65 look(): prior rated clock is explicit inactive provenance",
    sky.dormantRated?.hours === 6.8 && sky.dormantRated?.rate === 24, JSON.stringify(sky.dormantRated));
  check("#65 look(): canonical effectiveClock rides alongside",
    sky.effectiveClock?.mode === "real" && sky.effectiveClock?.tz === "America/Los_Angeles"
      && typeof sky.effectiveClock?.hour === "number"
      && sky.effectiveClock?.seq === 4777 && sky.effectiveClock?.by === "antra",
    JSON.stringify(sky.effectiveClock));
  check("#65 look(): narration says real time, never ×24",
    sky.description.includes("real time, America/Los_Angeles") && !sky.description.includes("advancing"),
    sky.description);

  // day phases still move with no rate field: LA 4:50 (night) → 5:10 (dawn)
  const night = Date.UTC(2026, 0, 15, 12, 50, 0), dawn = Date.UTC(2026, 0, 15, 13, 10, 0);
  ag.checkSky(night);
  const before = events.length;
  ag.checkSky(dawn);
  // (a forecast segment boundary may also land in the 20min window — only
  // the phase crossing itself is under test here)
  check("#65 ambient day-phase crossing still fires under a real clock",
    events.slice(before).some((e: any) => /dawn/.test(e?.text ?? "")),
    JSON.stringify(events.slice(before)));

  // return to accelerated: effective source changes once, with new provenance
  ag.applyEntry({ verb: "sky", args: { hours: 6.8, rate: 24, clouds: "cumulus" }, ts: T0 + 2 * HOUR, seq: 5100, actor: "antra" }, false);
  ag.look();
  const back = ag.worldInfo.sky;
  check("#65 look(): back to rated — active fields return, dormant drops",
    back.rate === 24 && back.hours === 6.8 && back.dormantRated === undefined
      && back.effectiveClock?.mode === "rated" && back.effectiveClock?.seq === 5100,
    JSON.stringify({ rate: back.rate, dormant: back.dormantRated, ck: back.effectiveClock }));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
