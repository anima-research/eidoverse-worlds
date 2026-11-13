// skywatch-test: the ambient sky percept, serverless. Resting agents must HEAR the sky change, not merely be able to ask:
// one ambient event per meaningful boundary (forecast segment, manual override landing/expiring, coarse day-phase),
// deduped by signature, from the same pure oracle look() uses; never a synthetic log verb, never a continuous clock.
// A bare worktree needs client/node_modules and mcpl/node_modules linked (mcpl/agent.ts pulls three/webgpu).
//   Run: bun test/shared/skywatch-test.ts

import { noWorldUrl } from "../harness/no-world.ts";
import { WorldAgent } from "../../mcpl/agent.ts";
import { normalizePolicy, segmentAt } from "../../shared/forecast.js";
import { agentOnDoor } from "../harness/agent-scratch.ts";
import { makeReplica, wireState } from "../../shared/protocol/replica.js";
import { suite } from "../gate/suite.ts";

const S = suite("skywatch");
const check = (name: string, ok: unknown, detail?: unknown) => S.check(name, ok, detail);

const T0 = 1_754_000_000_000;
const MIN = 60e3, HOUR = 3600e3;
const policyArgs = { seed: 7, states: ["clear", "overcast", "rain"], dwell: [300, 900], transition: 20 };

// the sky is @world's, set through `sky` / `weather` on a pinned-clock scratch door (test/harness/agent-scratch.ts) at T0;
// provenance is the LOG's: the door strips seq/by from the value, so the agent reads them from the entry
async function rig(args: any, who = "antra") {
  const ag = new WorldAgent({ url: noWorldUrl(), name: "skywatch" });
  const events: any[] = [];
  ag.onEvent = (ev) => { if (ev.kind === "weather") events.push(ev); };
  const A = ag as any;
  const door = agentOnDoor(A, "skywatch", { start: T0 - 2000 });
  await door.sync(false);
  const r = await door.act("sky", args, { who, at: T0, live: false });
  if (!r.ok) throw new Error(`sky refused: ${JSON.stringify(r.refused)}`);
  return { ag: A, events, door };
}

// ---------------------------------------------------------------- one rule over every sky source: the first look is
// silent, a crossing emits exactly one event, re-checks within it add none (agent-senses.ts checkSky, lastSkyKey/lastDayPhase)

type Step = [label: string, at: number, adds: number, text?: RegExp];
const fc = { hours: 12, rate: 0, forecast: policyArgs };
const LA = { night: Date.UTC(2026, 0, 15, 12, 50, 0), dawn: Date.UTC(2026, 0, 15, 13, 10, 0) };   // LA 4:50 → 5:10
const SOURCES: { name: string; args: any; steps: (ag: any, door: any) => Promise<Step[]> }[] = [
  { name: "forecast segment", args: fc, steps: async (ag) => {
    const p = normalizePolicy(ag.senses.skyState.forecast)!, s0 = segmentAt(p, T0);
    const s1 = segmentAt(p, s0.endMs + 1000), s2 = segmentAt(p, s1.endMs + 1000, s1), s3 = segmentAt(p, s2.endMs + 1000, s2);
    // the actor is the one the door logged (agent-scratch acts as olive; the rig's who is display only)
    return [["first look", T0 + 1000, 0], ["mid-segment", (T0 + s0.endMs) / 2, 0],
      ["boundary, with the log's seq and actor", s0.endMs + 1000, 1, /world weather.*forecast.*seq \d+.*olive/],
      ["re-check", s0.endMs + 2000, 0], ["re-check", s0.endMs + 3000, 0],
      ["a later boundary", s2.startMs + 1000, 1, /world weather/], ["and the next", s3.startMs + 1000, 1, /world weather/]];
  } },
  { name: "rated day phase (no forecast: no weather events)", args: { hours: 8, rate: 24, weather: "clear" }, steps: async () => [
    ["first look (day)", T0 + 1000, 0], ["within day", T0 + (4 / 24) * HOUR, 0],
    ["dusk", T0 + (10.5 / 24) * HOUR, 1, /^dusk/], ["within dusk", T0 + (10.6 / 24) * HOUR, 0],
    ["night", T0 + (13.5 / 24) * HOUR, 1, /^night/], ["within night", T0 + (14 / 24) * HOUR, 0]] },
  { name: "manual override lands, then expires", args: fc, steps: async (ag, door) => {
    ag.checkSky(T0 + 1000);
    const tO = T0 + 20 * MIN, seg = segmentAt(normalizePolicy(ag.senses.skyState.forecast)!, tO);
    const wr = await door.act("weather", { weather: "storm", weatherK: 1.1 }, { who: "digi", at: tO });
    check("the door takes the weather override", wr.ok, JSON.stringify(wr.refused));
    return [["override lands, with the logged actor", tO + 1000, 1, /storm.*olive/], ["re-check", tO + 2000, 0],
      ["expiry resumes the forecast", seg.endMs + 1000, 1, /forecast/], ["re-check", seg.endMs + 2000, 0]];
  } },
  { name: "real-clock day phase (no rate field)", args: { hours: 6.8, rate: 24, tz: "America/Los_Angeles" }, steps: async () => [
    ["first look (night)", LA.night, 0], ["dawn", LA.dawn, 1, /^dawn/],
    ["a minute later", LA.dawn + MIN, 0], ["ten minutes later", LA.dawn + 10 * MIN, 0]] },
];
for (const src of SOURCES) {
  const { ag, events, door } = await rig(src.args);
  for (const [label, at, adds, text] of await src.steps(ag, door)) {
    const before = events.length; ag.checkSky(at);
    const got = events.slice(before);
    check(`${src.name}: ${label} adds ${adds}`, got.length === adds && (!text || got.every((e: any) => text.test(e.text))),
      JSON.stringify(got.map((e: any) => e.text)));
  }
}

// ---------------------------------------------------------------- D: static skies stay silent

{
  const { ag, events } = await rig({ hours: 12, rate: 0, weather: "rain" });
  for (let i = 0; i < 10; i++) ag.checkSky(T0 + i * 10 * MIN);
  check("authored-only static sky never speaks", events.length === 0);

  const agNone = new WorldAgent({ url: noWorldUrl(), name: "skywatch-none" }) as any;
  let boomed = false;
  try { agNone.checkSky(T0); } catch { boomed = true; }
  check("no sky at all is a no-op, not a crash", !boomed);
}

// late-join parity: the watcher keys off the SAME fold the door writes, so a joiner adopting the cut resumes without a spam burst
{
  const live = await rig({ hours: 12, rate: 0, forecast: policyArgs });
  const ag = new WorldAgent({ url: noWorldUrl(), name: "late" }) as any; const events: any[] = [];
  ag.onEvent = (ev: any) => { if (ev.kind === "weather") events.push(ev); };
  // the live fold's cut, serialized and adopted by a fresh replica: what a joiner gets (never the live object itself)
  ag.replica = makeReplica(); ag.replica.adopt(JSON.parse(JSON.stringify({ dialect: "eidoverse-log", v: 4, state: wireState(live.ag.replica.st), seq: live.ag.replica.seq })));
  await ag.applyView(false, null, T0);
  check("a late joiner's sky is the live agent's", JSON.stringify(ag.senses.skyState) === JSON.stringify(live.ag.senses.skyState), JSON.stringify([ag.senses.skyState, live.ag.senses.skyState]));
  ag.checkSky(T0 + 5 * MIN);
  check("late join initializes the watch silently", events.length === 0);
}

// ---------------------------------------------------------------- E: two agents, one boundary id

{
  const args = { hours: 12, rate: 0, forecast: policyArgs };
  const a = await rig(args), b = await rig(args);
  const p = normalizePolicy(a.ag.senses.skyState.forecast)!;
  const seg0 = segmentAt(p, T0);
  // b joins late — different first observation time, same oracle
  a.ag.checkSky(T0 + 1000);
  b.ag.checkSky(seg0.startMs + (seg0.endMs - seg0.startMs) / 2);
  a.ag.checkSky(seg0.endMs + 1000);
  b.ag.checkSky(seg0.endMs + 1000);
  check("two agents emit at the same boundary", a.events.length === 1 && b.events.length === 1);
  check("two agents derive the same boundary id (signature key match)",
    a.ag.senses.lastSkyKey === b.ag.senses.lastSkyKey && /forecast:1:/.test(a.ag.senses.lastSkyKey),
    `${a.ag.senses.lastSkyKey} vs ${b.ag.senses.lastSkyKey}`);
  check("their narrated states agree", a.events[0]?.text === b.events[0]?.text, `${a.events[0]?.text} vs ${b.events[0]?.text}`);
}

// ---------------------------------------------------------------- F: look()'s World.sky stays a structured object
// folded fields preserved; currentHour/currentWeather/source/description ADDED alongside, never instead

{
  const AZ = 200 * Math.PI / 180;   // radians
  const { ag } = await rig({ hours: 8, rate: 24, clouds: "cumulus", azimuth: AZ, forecast: policyArgs });
  ag.look();
  const sky = ag.worldInfo.sky;
  check("World.sky is an object, not a string", typeof sky === "object" && sky !== null && typeof sky !== "string");
  check("authored/folded fields survive (hours, clouds, azimuth, ts, forecast)",
    sky.hours === 8 && sky.clouds === "cumulus" && sky.azimuth === AZ && sky.ts === T0 && !!sky.forecast,
    JSON.stringify(sky));
  check("derived fields ride alongside",
    typeof sky.currentHour === "number" && typeof sky.description === "string"
      && ["authored", "forecast", "manual"].includes(sky.source)
      && (sky.currentWeather === undefined || typeof sky.currentWeather === "string"),
    JSON.stringify({ currentHour: sky.currentHour, currentWeather: sky.currentWeather, source: sky.source }));

  // pre-forecast worlds keep their exact old shape too (plus the new derived fields)
  const plain = await rig({ hours: 12, weather: "rain" });
  plain.ag.look();
  const ps = plain.ag.worldInfo.sky;
  check("authored-only sky is structured with derivation added",
    typeof ps === "object" && ps.hours === 12 && ps.weather === "rain" && ps.source === "authored"
      && ps.currentWeather === "rain" && typeof ps.description === "string",
    JSON.stringify(ps));
}

// ---------------------------------------------------------------- F: clock contract in look() (#65)
// look() serializes the normalized bag plus the canonical effectiveClock (no stale hours/rate beside clock:'real'), and
// ambient day-phase perception works with no top-level rate

{
  // accelerated commons shape, then the owner flips to real time re-issuing the standing bag (the tuner's gather() spread)
  const { ag, events, door } = await rig({ hours: 6.8, rate: 24, clouds: "cumulus", forecast: policyArgs }, "mica");
  const { ts: _ts, ...standing } = ag.senses.skyState;
  const flip = await door.act("sky", { ...standing, tz: "America/Los_Angeles" }, { who: "antra", at: T0 + HOUR, live: false });
  check("#65 the door takes the clock flip (the standing bag re-issued)", flip.ok, JSON.stringify(flip.refused));
  ag.look();
  const sky = ag.worldInfo.sky;
  // the tz alone says the wall clock governs (render-media-env §13); hours/rate stay as the rated fallback
  check("#65 look(): the clock flip is stored as its tz (no clock field, no dormantRated park)",
    sky.tz === "America/Los_Angeles" && sky.clock === undefined && sky.dormantRated === undefined,
    JSON.stringify({ tz: sky.tz, clock: sky.clock, dormant: sky.dormantRated }));
  check("#65 look(): the rated clock stays as the fallback, and the effective clock is the wall clock",
    sky.hours === 6.8 && sky.rate === 24 && sky.effectiveClock?.mode === "real", JSON.stringify({ hours: sky.hours, rate: sky.rate, ck: sky.effectiveClock }));
  check("#65 look(): canonical effectiveClock rides alongside",
    sky.effectiveClock?.mode === "real" && sky.effectiveClock?.tz === "America/Los_Angeles"
      && typeof sky.effectiveClock?.hour === "number"
      && Number.isInteger(sky.effectiveClock?.seq) && sky.effectiveClock?.by === "olive",   // the actor the door logged (the rig's who is display only)
    JSON.stringify(sky.effectiveClock));
  check("#65 look(): narration says real time, never ×24",
    sky.description.includes("real time, America/Los_Angeles") && !sky.description.includes("advancing"),
    sky.description);

  // return to accelerated: effective source changes once, with new provenance
  await door.act("sky", { hours: 6.8, rate: 24, clouds: "cumulus" }, { who: "antra", at: T0 + 2 * HOUR, live: false });
  ag.look();
  const back = ag.worldInfo.sky;
  check("#65 look(): back to rated — active fields return, dormant drops",
    back.rate === 24 && back.hours === 6.8 && back.dormantRated === undefined
      && back.effectiveClock?.mode === "rated" && Number.isInteger(back.effectiveClock?.seq) && back.effectiveClock.seq !== sky.effectiveClock?.seq,
    JSON.stringify({ rate: back.rate, dormant: back.dormantRated, ck: back.effectiveClock }));
}

S.done();
