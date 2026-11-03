// approach-dwell-test — an approach means they STOPPED, and a departure means
// they had arrived first.
//
// The defect this pins: `declaration.ts` has always promised that
// eidoverse:approach means "someone walked up to your body AND STOPPED within
// arm's reach", while the implementation was a bare edge-trigger on crossing
// APPROACH_RADIUS. The three gates around it (re-arm past REARM_RADIUS, the
// per-identity refractory, #39's baseline seeding) all suppress REPEATS — none
// of them could tell a knock from a body crossing your bubble on its way to
// the door. Antra, 2026-08-25: "likely debounced so that passing through does
// not trigger it."
//
// The complement, asked for in the same breath and never implemented: the
// outward crossing re-armed in silence, so nothing ever closed the bracket.
//
// Everything here runs on an INJECTED clock (notePose's third argument). Dwell
// is a claim about time; a suite that cannot move the clock either sleeps —
// slow, and racy against the refractory — or quietly asserts nothing.
//
// Run: bun tools/approach-dwell-test.ts

import { WorldAgent } from "../mcpl/agent.ts";
import { APPROACH_DWELL_MS, APPROACH_MAX_WAIT_MS, APPROACH_RADIUS, REARM_RADIUS } from "../mcpl/denoise.ts";

let pass = 0, fail = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`); }
}

/** A body at (x,z). `clip` and `speed` are what the SENDER claims about
 *  itself — deliberately mismatched with reality in one test below. */
const pose = (x: number, z: number, clip = "walk", speed = 0) =>
  ({ p: [x, 0, z], yaw: 0, speed, clip });

function rig() {
  const ag = new WorldAgent({ name: "dwelltest" }) as any;
  ag.pos = { x: 0, y: 0, z: 0 };
  // A real epoch, not 0: `cooled` measures against a last-approach time that
  // defaults to 0, so a clock starting near zero reads as "approached a moment
  // ago" and refuses the very first knock.
  const T0 = Date.now();
  const seen: { kind: string; who: string; text?: string }[] = [];
  ag.onPing = (p: any) => seen.push({ kind: p.kind, who: p.who, ...(p.text != null ? { text: p.text } : {}) });
  return {
    ag, T0, seen,
    at: (t: number, x: number, z: number, clip?: string, speed?: number, who = "digi") =>
      ag.notePose(who, pose(x, z, clip, speed), T0 + t),
    count: (kind: string) => seen.filter((p) => p.kind === kind).length,
  };
}

const DIST = (x: number, z: number) => Math.hypot(x, z);

// ---------------------------------------------------------------- the headline: passing through is not a knock

{
  const { at, count } = rig();
  // A straight walk past the agent at 1.4 m/s (strolling), sampled at 5Hz:
  // 0.28m per sample. The line runs along x at z = 1.5, so the closest
  // approach is 1.5m — well inside arm's reach — and the body is genuinely
  // within APPROACH_RADIUS for ~2.9s of the walk.
  let t = 0, inside = 0;
  for (let x = -6; x <= 6.0001; x += 0.28) {
    at(t, x, 1.5);
    if (DIST(x, 1.5) < APPROACH_RADIUS) inside++;
    t += 200;
  }
  // VACUITY GUARD: if the path never actually entered the radius, "no ping"
  // would be true for the wrong reason and this whole test would be theatre.
  check("(guard) the pass-through really did enter arm's reach", inside >= 10, `${inside} samples inside`);
  check("walking straight past you is NOT an approach", count("approach") === 0,
    `${count("approach")} pings`);
  check("...and a body that never arrived never departs either", count("depart") === 0);
}

// ---------------------------------------------------------------- the control: same walk, but they stop

{
  const { at, count } = rig();
  // Identical approach leg — then they stop at 1.5m instead of walking on.
  let t = 0;
  for (let x = -6; x <= -1.5; x += 0.28) { at(t, x, 1.5); t += 200; }
  check("(control) still nothing while they are still moving", count("approach") === 0);
  // parked, same spot, sampled across the dwell window
  for (let i = 0; i <= APPROACH_DWELL_MS + 600; i += 200) at(t + i, -1.5, 1.5);
  check("walking up and STOPPING is an approach", count("approach") === 1, `${count("approach")} pings`);
  check("...and it knocks exactly once while they stand there", count("approach") === 1);
}

// ---------------------------------------------------------------- stillness is observed, never taken on trust

{
  const { at, count } = rig();
  at(0, 10, 0);
  at(100, 1.2, 0, "walk", 9.9);   // crosses in, LOUDLY claiming to be sprinting
  for (let i = 0; i <= APPROACH_DWELL_MS + 400; i += 200) at(100 + i, 1.2, 0, "walk", 9.9);
  check("a body whose own pose says 'walking at 9.9 m/s' still counts as still, because it did not move",
    count("approach") === 1, `${count("approach")} pings`);
}

{
  const { at, count } = rig();
  at(0, 10, 0);
  // Crosses in and keeps moving fast, while claiming clip "idle" at speed 0.
  let t = 100, x = 2.4;
  for (; x > -2.4; x -= 0.3) { at(t, x, 0.4, "idle", 0); t += 200; }
  check("a body claiming 'idle, speed 0' while crossing at 1.5 m/s is NOT an approach",
    count("approach") === 0, `${count("approach")} pings`);
}

// ---------------------------------------------------------------- someone who never settles is still someone who came over

{
  const { at, count } = rig();
  at(0, 10, 0);
  at(100, 2.0, 0);   // crossing
  // Circling inside arm's reach, never still, for longer than the max wait.
  let t = 300;
  for (let i = 0; t <= 100 + APPROACH_MAX_WAIT_MS + 1000; i++) {
    const a = i * 0.6;
    at(t, Math.cos(a) * 1.8, Math.sin(a) * 1.8);
    t += 200;
  }
  check("pacing in your face never reads as 'still' — but still announces, once, via the max wait",
    count("approach") === 1, `${count("approach")} pings`);
}

// ---------------------------------------------------------------- the closing bracket

{
  const { at, count, seen } = rig();
  at(0, 10, 0);
  at(100, 1.5, 0);
  for (let i = 0; i <= APPROACH_DWELL_MS + 400; i += 200) at(100 + i, 1.5, 0);
  check("(setup) approached", count("approach") === 1);

  at(20_000, 4.0, 0);   // drifts out of arm's reach, but stays nearby
  check("drifting to 4m is not a departure — the bracket closes at the re-arm radius, not the approach one",
    count("depart") === 0, `${count("depart")} pings`);

  at(21_000, REARM_RADIUS + 2, 0);
  check("going properly away IS a departure", count("depart") === 1);
  check("...and their own movement carried them out, so the wire may say so",
    seen.find((p) => p.kind === "depart")?.text === "walked away",
    JSON.stringify(seen.filter((p) => p.kind === "depart")));

  at(22_000, REARM_RADIUS + 5, 0);
  at(23_000, REARM_RADIUS + 9, 0);
  check("...and it fires once, not once per sample out there", count("depart") === 1,
    JSON.stringify(seen.map((p) => p.kind)));
}

// ---------------------------------------------------------------- a passer-by's exit is traffic, not a departure

{
  const { at, count } = rig();
  let t = 0;
  for (let x = -6; x <= 6.0001; x += 0.28) { at(t, x, 1.5); t += 200; }
  at(t + 1000, 12, 1.5);   // walks off past the re-arm radius
  check("the body that only passed through leaves without a departure",
    count("approach") === 0 && count("depart") === 0,
    `approach=${count("approach")} depart=${count("depart")}`);
}

// ---------------------------------------------------------------- the filter must not deafen you

{
  const { at, count } = rig();
  // First: a pass-through, which must be swallowed.
  let t = 0;
  for (let x = -6; x <= 6.0001; x += 0.28) { at(t, x, 1.5); t += 200; }
  check("(setup) the pass-through was swallowed", count("approach") === 0);
  // Then they go properly away and come back for real, well past the
  // refractory. The cancelled pending must not have left the gate stuck.
  at(700_000, 12, 0);
  at(700_100, 1.4, 0);
  for (let i = 0; i <= APPROACH_DWELL_MS + 400; i += 200) at(700_100 + i, 1.4, 0);
  check("a real walk-up AFTER a swallowed pass-through still knocks",
    count("approach") === 1, `${count("approach")} pings`);
}

// ---------------------------------------------------------------- two bodies do not share a gate

{
  const { at, count, seen } = rig();
  at(0, 10, 0, "walk", 0, "digi");
  at(0, 10, 0, "walk", 0, "rabscuttle");
  // digi walks up and stays; rabscuttle merely passes through.
  at(100, 1.5, 0, "walk", 0, "digi");
  let t = 100;
  for (let x = -6; x <= 6.0001; x += 0.28) { at(t, x, 1.5, "walk", 0, "rabscuttle"); t += 200; }
  for (let i = 0; i <= APPROACH_DWELL_MS + 400; i += 200) at(100 + i, 1.5, 0, "walk", 0, "digi");
  check("the stopper is announced and the passer-by is not",
    count("approach") === 1 && seen.find((p) => p.kind === "approach")?.who === "digi",
    JSON.stringify(seen));
}

// ---------------------------------------------------------------- who moved? the wire must not author OUR walk as THEIRS

// Antra's review vector (PR #145): after digi earns an approach at (1.5,0),
// the AGENT teleports to (10,0) and digi's next sample is the same unmoved
// pose. The bracket must close — the relation really did end — but the old
// wire said "* digi walked away" about a body that never took a step. The
// depart ping now carries its own text: "walked away" only when the departing
// body is beyond the re-arm edge measured from where WE stood when the
// approach fired; otherwise the actor-neutral "is no longer nearby".

{
  const { ag, at, count, seen } = rig();
  at(0, 10, 0);
  at(100, 1.5, 0);
  for (let i = 0; i <= APPROACH_DWELL_MS + 400; i += 200) at(100 + i, 1.5, 0);
  check("(setup) approached", count("approach") === 1);

  ag.pos = { x: 10, y: 0, z: 0 };       // WE move; digi does not
  at(20_000, 1.5, 0);                    // digi's unmoved pose, now 8.5m from us
  check("self walking away still closes the bracket", count("depart") === 1,
    `${count("depart")} pings`);
  check("...but the wire does not claim digi moved",
    seen.find((p) => p.kind === "depart")?.text === "is no longer nearby",
    JSON.stringify(seen.filter((p) => p.kind === "depart")));
}

{
  const { ag, at, count, seen } = rig();
  at(0, 10, 0);
  at(100, 1.5, 0);
  for (let i = 0; i <= APPROACH_DWELL_MS + 400; i += 200) at(100 + i, 1.5, 0);
  check("(setup) approached", count("approach") === 1);

  // Both drift apart: we to (-4,0), digi to (4,0). 8m apart — past the re-arm
  // edge — but digi is only 4m from where we stood at the approach, so no
  // single party "walked away"; the separation is shared.
  ag.pos = { x: -4, y: 0, z: 0 };
  at(20_000, 4, 0);
  check("a separation both parties caused is worded neutrally",
    count("depart") === 1 && seen.find((p) => p.kind === "depart")?.text === "is no longer nearby",
    JSON.stringify(seen.filter((p) => p.kind === "depart")));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
