/**
 * Denoise gate test, no servers needed. The noise classes:
 *   1. arrive/leave flaps collapse to nothing (both directions)
 *   2. posture/gesture cycles: refractory + short-stint "gets up" swallow
 *   3. self-echo: own say never fans out as an event
 *   4. approach: dwell (a pass-through is not a knock), hysteresis re-arm, refractory, depart, first-sight seeding
 *   5. the approach knobs' clamp, under hostile env (a child of this file per env: the knobs are read at load)
 *
 * Run: bun test/mcpl/denoise-test.ts
 * (env windows are shrunk below BEFORE the modules load: order matters)
 */

process.env.EW_ARRIVE_HOLD_SEC = "0.05";
process.env.EW_LEAVE_HOLD_SEC = "0.05";
process.env.EW_PRESENCE_TAU_SEC = "1000";   // effectively no decay within the test
process.env.EW_ACT_REFRACT_SEC = "0.2";
process.env.EW_STINT_MIN_SEC = "0.15";
process.env.EW_APPROACH_REFRACT_SEC = "0.3";
process.env.EW_APPROACH_DWELL_SEC = "0.05";
process.env.EW_ACTIVITY_PULSE_SEC = "0.12";
process.env.EW_ACTIVITY_REFRESH_SEC = "0.35";

const { NoiseGate, APPROACH_DWELL_MS, APPROACH_MAX_WAIT_MS, APPROACH_SAFE_WAIT_MS, APPROACH_STILL_MPS, APPROACH_RADIUS, REARM_RADIUS } =
  await import("../../mcpl/denoise.ts");
const { WorldAgent } = await import("../../mcpl/agent.ts");
const { noWorldUrl } = await import("../harness/no-world.ts");
const { suite } = await import("../gate/suite.ts");
const { tryUntil, pause } = await import("../gate/wait.ts");
const { spawnSync } = await import("node:child_process");

// ---- 5 (child). one hostile env, the slowest straight pass-through that never counts as still ----------------
if (process.argv[2] === "clamp") {
  const S = suite("denoise-clamp");
  S.check("the wait can never sit below the safe bound", APPROACH_MAX_WAIT_MS >= APPROACH_SAFE_WAIT_MS,
    `wait=${APPROACH_MAX_WAIT_MS} safe=${APPROACH_SAFE_WAIT_MS}`);
  S.check("the stillness threshold is positive", APPROACH_STILL_MPS > 0, String(APPROACH_STILL_MPS));
  const ag = new WorldAgent({ url: noWorldUrl(), name: "clamptest" }) as any;
  ag.pos = { x: 0, y: 0, z: 0 };
  const T0 = Date.now(), pings: any[] = [];
  ag.onPing = (p: any) => pings.push(p);
  const stepMs = 200, stepM = APPROACH_STILL_MPS * 1.5 * (stepMs / 1000);
  ag.notePose("digi", { p: [-(REARM_RADIUS + 1), 0, 0.5], yaw: 0, speed: 0, clip: "walk" }, T0 - stepMs);   // first seen far: armed (a first sight inside is a baseline)
  let t = 0, inside = 0;
  for (let x = -(APPROACH_RADIUS + 1); x <= APPROACH_RADIUS + 1.0001; x += stepM) {
    ag.notePose("digi", { p: [x, 0, 0.5], yaw: 0, speed: 0, clip: "walk" }, T0 + t);
    if (Math.hypot(x, 0.5) < APPROACH_RADIUS) inside++;
    t += stepMs;
  }
  S.check("(guard) the path really entered arm's reach", inside > 0);
  S.check("a straight pass-through is not announced, whatever the knobs say",
    pings.filter((p) => p.kind === "approach").length === 0, JSON.stringify(pings));
  ag.close();
  S.done();
}

const { check, done } = suite("denoise");

// ---- 1. presence: hold-and-cancel + battery --------------------------------
console.log("\n━━ presence: flaps collapse, real events pass, chronic noise drains ━━");
{
  const out: string[] = [];
  const gate = new NoiseGate((ev) => out.push(`${ev.kind}:${ev.who}`));

  gate.presence("digi", "arrive");
  await tryUntil("the held arrive", () => out.length);
  check("real arrive emits after the hold", out.join(",") === "arrive:digi", out.join(","));

  out.length = 0;
  gate.presence("digi", "leave");
  gate.presence("digi", "arrive"); // reconnect flap, inside the hold
  await pause("past the hold: a collapsed flap emits nothing", 120);
  check("leave→arrive flap collapses to nothing", out.length === 0, out.join(","));
  check("flap counted in stats", gate.stats.flapsCollapsed === 1, String(gate.stats.flapsCollapsed));

  out.length = 0;
  gate.presence("fc", "arrive");
  gate.presence("fc", "leave"); // smoke-test visit
  await pause("past the hold: a brief visit emits nothing", 120);
  check("arrive→leave brief visit collapses to nothing", out.length === 0, out.join(","));

  // battery: real pairs beyond the hold window still drain the identity
  out.length = 0;
  for (let i = 0; i < 3; i++) {
    gate.presence("flappy", "leave");
    await pause("each half outlives the hold: a real pair, not a flap", 90);
    gate.presence("flappy", "arrive");
    await pause("each half outlives the hold: a real pair, not a flap", 90);
  }
  check("repeated real pairs: first pair narrated, rest silenced by charge",
    out.length === 2 && gate.stats.presenceDropped >= 3,
    `emitted=${out.join(",")} dropped=${gate.stats.presenceDropped}`);
  gate.dispose();
}

// ---- 2. acts: per-(person, act) refractory ---------------------------------
console.log("\n━━ acts: a burst speaks once per window ━━");
{
  const out: string[] = [];
  const gate = new NoiseGate((ev) => out.push(ev.text!));
  for (let i = 0; i < 5; i++) gate.act("digi", "clip:jump", 'starts "jump"');
  check("5 rapid jumps → 1 event", out.length === 1, String(out.length));
  gate.act("digi", "anim:dance", "plays dance (once)");
  check("a DIFFERENT act from the same person still speaks", out.length === 2, out.join(" | "));
  await pause("the act refractory (200 ms) runs out", 250);
  gate.act("digi", "clip:jump", 'starts "jump"');
  check("after the refractory the act speaks again", out.length === 3, String(out.length));
  gate.dispose();
}

// ---- agent-level: jump stint, self-echo, approach --------------------------
console.log("\n━━ agent: jump = one thing not two; long sits still narrate ━━");
{
  const agent = new WorldAgent({ name: "claude", url: noWorldUrl() });
  const acts: string[] = [];
  agent.onEvent = (ev) => { if (ev.kind === "act") acts.push(ev.text!); };
  const np = (id: string, clip: string, x = 5, z = 5) =>
    (agent as any).notePose(id, { p: [x, 0, z], yaw: 0, speed: 0, clip });

  np("digi", "idle");
  np("digi", "jump");
  np("digi", "idle"); // back within the stint window
  check("jump cycle → one event, no 'gets up'", acts.length === 1 && acts[0] === 'starts "jump"', acts.join(" | "));

  acts.length = 0;
  np("digi", "sit");
  await pause("outlive both the stint minimum and the act refractory", 220);
  np("digi", "idle");
  check("a real sit still earns its 'gets up'", acts.includes("gets up"), acts.join(" | "));
  agent.close();
}

console.log("\n━━ agent: own say is not an event ━━");
{
  const agent = new WorldAgent({ name: "claude", url: noWorldUrl() });
  const heard: string[] = [];
  agent.onEvent = (ev) => { if (ev.kind === "say") heard.push(`${ev.who}:${ev.text}`); };
  (agent as any).hearSay({ verb: "say", args: { text: "me talking" }, actor: "claude", ts: Date.now(), seq: 1 }, true);
  (agent as any).hearSay({ verb: "say", args: { text: "hey claude" }, actor: "digi", ts: Date.now(), seq: 2 }, true);
  check("own say suppressed, other's say delivered", heard.length === 1 && heard[0].startsWith("digi:"), heard.join(" | "));
  check("own say still lands in the inbox (honest scrollback)",
    agent.inbox.some((m) => m.kind === "say" && m.who === "claude"), JSON.stringify(agent.inbox));
  agent.close();
}

console.log("\n━━ agent: approach = knock once, not a metronome ━━");
{
  const agent = new WorldAgent({ name: "claude", url: noWorldUrl() }); // agent at origin
  // virtual clock (notePose takes `now`), offset from a real epoch: `cooled` compares to a last-approach time defaulting to 0
  const T0 = Date.now();
  const np = (id: string, x: number, z: number, t: number) =>
    (agent as any).notePose(id, { p: [x, 0, z], yaw: 0, speed: 0, clip: "walk" }, T0 + t);
  const approaches = () => agent.pings.filter((p) => p.kind === "approach").length;

  np("digi", 10, 0, 0);    // baseline, far -> armed
  np("digi", 2, 0, 10);    // crosses 2.5m: opens a pending approach
  np("digi", 2, 0, 100);   // still there 90ms later (dwell is 50ms here)
  check("first approach pings", approaches() === 1);

  np("digi", 3, 0, 110);   // steps out, but NOT past the re-arm radius
  np("digi", 2, 0, 120);   // crosses again
  np("digi", 2, 0, 170);
  np("digi", 4, 0, 180);
  np("digi", 2, 0, 190);
  np("digi", 2, 0, 240);
  check("pacing at the boundary does not re-ping (not re-armed)",
    approaches() === 1, String(agent.pings.length));

  np("digi", 8, 0, 250);   // genuinely goes away: re-arms
  np("digi", 2, 0, 260);   // comes right back, but refractory (300ms) still holds
  np("digi", 2, 0, 320);
  check("re-armed but inside the refractory: still silent",
    approaches() === 1, String(agent.pings.length));

  np("digi", 8, 0, 500);   // away again; refractory expires at 400
  np("digi", 2, 0, 510);
  np("digi", 2, 0, 600);
  check("gone away + refractory over → the knock counts again",
    approaches() === 2, String(agent.pings.length));

  // exactly one departure (t=250): the trip at t=500 had no delivered approach outstanding (the refractory refused t=260)
  check("going away past the re-arm radius pings depart — once, for the visit that counted",
    agent.pings.filter((p) => p.kind === "depart").length === 1,
    JSON.stringify(agent.pings.map((p) => p.kind)));
  agent.close();
}

// ---- approach dwell: an approach means they STOPPED; a departure means they had arrived (injected clock) ------
console.log("\n━━ agent: approach dwell — passing through is not a knock ━━");
{
  const pose = (x: number, z: number, clip = "walk", speed = 0) => ({ p: [x, 0, z], yaw: 0, speed, clip });
  const rigs: any[] = [];
  function rig() {
    const ag = new WorldAgent({ url: noWorldUrl(), name: "dwelltest" }) as any;
    rigs.push(ag);
    ag.pos = { x: 0, y: 0, z: 0 };
    const T0 = Date.now();   // a real epoch: see the virtual clock above
    const seen: { kind: string; who: string; text?: string }[] = [];
    ag.onPing = (p: any) => seen.push({ kind: p.kind, who: p.who, ...(p.text != null ? { text: p.text } : {}) });
    return {
      ag, seen,
      at: (t: number, x: number, z: number, clip?: string, speed?: number, who = "digi") => ag.notePose(who, pose(x, z, clip, speed), T0 + t),
      count: (kind: string) => seen.filter((p) => p.kind === kind).length,
    };
  }
  const passThrough = (at: (t: number, x: number, z: number) => void, t0 = 0) => {
    let t = t0, inside = 0;   // 1.4 m/s at 5 Hz along z = 1.5: ~2.9 s within APPROACH_RADIUS, never still
    for (let x = -6; x <= 6.0001; x += 0.28) { at(t, x, 1.5); if (Math.hypot(x, 1.5) < APPROACH_RADIUS) inside++; t += 200; }
    return { t, inside };
  };
  const knock = (at: (t: number, x: number, z: number) => void) => {
    at(0, 10, 0); at(100, 1.5, 0);
    for (let i = 0; i <= APPROACH_DWELL_MS + 400; i += 200) at(100 + i, 1.5, 0);
  };

  { const { at, count } = rig();
    const { inside } = passThrough(at);
    check("(guard) the pass-through really did enter arm's reach", inside >= 10, `${inside} samples inside`);
    check("walking straight past you is NOT an approach", count("approach") === 0, `${count("approach")} pings`);
    check("...and a body that never arrived never departs either", count("depart") === 0); }

  { const { at, count } = rig();
    let t = 0;
    for (let x = -6; x <= -1.5; x += 0.28) { at(t, x, 1.5); t += 200; }
    check("(control) still nothing while they are still moving", count("approach") === 0);
    for (let i = 0; i <= APPROACH_DWELL_MS + 600; i += 200) at(t + i, -1.5, 1.5);
    check("walking up and STOPPING is an approach, once", count("approach") === 1, `${count("approach")} pings`); }

  { const { at, count } = rig();
    at(0, 10, 0);
    at(100, 1.2, 0, "walk", 9.9);   // crosses in, claiming to sprint
    for (let i = 0; i <= APPROACH_DWELL_MS + 400; i += 200) at(100 + i, 1.2, 0, "walk", 9.9);
    check("a body whose own pose says 'walking at 9.9 m/s' still counts as still, because it did not move",
      count("approach") === 1, `${count("approach")} pings`); }

  { const { at, count } = rig();
    at(0, 10, 0);
    let t = 100;
    for (let x = 2.4; x > -2.4; x -= 0.3) { at(t, x, 0.4, "idle", 0); t += 200; }
    check("a body claiming 'idle, speed 0' while crossing at 1.5 m/s is NOT an approach",
      count("approach") === 0, `${count("approach")} pings`); }

  { const { at, count } = rig();
    at(0, 10, 0);
    at(100, 2.0, 0);
    let t = 300;   // circling inside arm's reach, never still, past the max wait
    for (let i = 0; t <= 100 + APPROACH_MAX_WAIT_MS + 1000; i++) { at(t, Math.cos(i * 0.6) * 1.8, Math.sin(i * 0.6) * 1.8); t += 200; }
    check("pacing in your face never reads as 'still' — but still announces, once, via the max wait",
      count("approach") === 1, `${count("approach")} pings`); }

  { const { at, count, seen } = rig();
    knock(at);
    check("(setup) approached", count("approach") === 1);
    at(20_000, 4.0, 0);   // out of arm's reach, still nearby
    check("drifting to 4m is not a departure — the bracket closes at the re-arm radius, not the approach one",
      count("depart") === 0, `${count("depart")} pings`);
    at(21_000, REARM_RADIUS + 2, 0);
    check("going properly away IS a departure", count("depart") === 1);
    check("...and their own movement carried them out, so the wire may say so",
      seen.find((p) => p.kind === "depart")?.text === "walked away", JSON.stringify(seen.filter((p) => p.kind === "depart")));
    at(22_000, REARM_RADIUS + 5, 0);
    at(23_000, REARM_RADIUS + 9, 0);
    check("...and it fires once, not once per sample out there", count("depart") === 1, JSON.stringify(seen.map((p) => p.kind))); }

  { const { at, count } = rig();
    const { t } = passThrough(at);
    at(t + 1000, 12, 1.5);   // walks off past the re-arm radius
    check("the body that only passed through leaves without a departure",
      count("approach") === 0 && count("depart") === 0, `approach=${count("approach")} depart=${count("depart")}`); }

  { const { at, count } = rig();
    passThrough(at);
    check("(setup) the pass-through was swallowed", count("approach") === 0);
    at(700_000, 12, 0);   // properly away, then a real walk-up: the cancelled pending must not leave the gate stuck
    at(700_100, 1.4, 0);
    for (let i = 0; i <= APPROACH_DWELL_MS + 400; i += 200) at(700_100 + i, 1.4, 0);
    check("a real walk-up AFTER a swallowed pass-through still knocks", count("approach") === 1, `${count("approach")} pings`); }

  { const { at, count, seen } = rig();
    at(0, 10, 0, "walk", 0, "digi");
    at(0, 10, 0, "walk", 0, "rabscuttle");
    at(100, 1.5, 0, "walk", 0, "digi");
    passThrough((t, x, z) => at(t, x, z, "walk", 0, "rabscuttle"), 100);
    for (let i = 0; i <= APPROACH_DWELL_MS + 400; i += 200) at(100 + i, 1.5, 0, "walk", 0, "digi");
    check("two bodies do not share a gate: the stopper is announced and the passer-by is not",
      count("approach") === 1 && seen.find((p) => p.kind === "approach")?.who === "digi", JSON.stringify(seen)); }

  // who moved: depart says "walked away" only when THEY are past the re-arm edge from where WE stood at the approach
  { const { ag, at, count, seen } = rig();
    knock(at);
    check("(setup) approached", count("approach") === 1);
    ag.pos = { x: 10, y: 0, z: 0 };   // WE move; digi does not
    at(20_000, 1.5, 0);
    check("self walking away still closes the bracket", count("depart") === 1, `${count("depart")} pings`);
    check("...but the wire does not claim digi moved",
      seen.find((p) => p.kind === "depart")?.text === "is no longer nearby", JSON.stringify(seen.filter((p) => p.kind === "depart"))); }

  { const { ag, at, count, seen } = rig();
    knock(at);
    check("(setup) approached", count("approach") === 1);
    ag.pos = { x: -4, y: 0, z: 0 };   // both drift: 8m apart, but digi is only 4m from where we stood
    at(20_000, 4, 0);
    check("a separation both parties caused is worded neutrally",
      count("depart") === 1 && seen.find((p) => p.kind === "depart")?.text === "is no longer nearby",
      JSON.stringify(seen.filter((p) => p.kind === "depart"))); }
  for (const ag of rigs) ag.close();
}

// ---- seeding: the FIRST spatial observation of a person is a baseline, not a transition (issue #39) -----------
console.log("\n━━ agent: reconnect replay seeds, never narrates ━━");
{
  const pose = (x: number, z: number, clip = "idle", extra: Record<string, unknown> = {}) => ({ p: [x, 0, z], yaw: 0, speed: 0, clip, ...extra });
  function rig() {
    const ag = new WorldAgent({ url: noWorldUrl(), name: "seedtest" }) as any;
    ag.pos = { x: 0, y: 0, z: 0 };
    const acts: any[] = [];
    ag.onEvent = (ev: any) => { if (ev.kind === "act") acts.push(ev); };
    return { ag, acts, T0: Date.now(), pings: () => ag.takePings().filter((p: any) => p.kind === "approach") };
  }

  { const { ag, acts, T0, pings } = rig();
    const sit = { pose: { head: [0, 0, 0, 1] } };
    ag.notePose("digi", pose(1.0, 0.5, "sitstool", sit));
    check("first observation within arm's reach pings NO approach", pings().length === 0);
    check("first observation narrates NO acts (sitting body stays silent)", acts.length === 0, JSON.stringify(acts));
    ag.notePose("digi", pose(1.2, 0.4, "sitstool", sit));
    ag.notePose("digi", pose(0.8, 0.3, "sitstool", sit));
    check("shuffling in place near you still pings nothing", pings().length === 0);
    ag.notePose("digi", pose(9, 0), T0);   // leave properly, come back and STAY: a real walk-up
    ag.notePose("digi", pose(1.5, 0), T0 + 100);
    ag.notePose("digi", pose(1.5, 0), T0 + 100 + APPROACH_DWELL_MS + 50);
    check("leave-and-return and STAY is a REAL approach and pings once", pings().length === 1);
    ag.close(); }

  { const { ag, acts, T0, pings } = rig();
    ag.notePose("member", pose(15, 0), T0);   // first seen far: baseline, armed
    check("first observation far away pings nothing", pings().length === 0);
    ag.notePose("member", pose(2.0, 0, "walk"), T0 + 200);
    ag.notePose("member", pose(2.0, 0, "walk"), T0 + 200 + APPROACH_DWELL_MS + 50);
    const before = acts.length;
    ag.notePose("member", pose(2.0, 0, "sitchair"), T0 + 400 + APPROACH_DWELL_MS);
    check("a live posture TRANSITION still narrates", acts.length === before + 1 && /sits down/.test(acts.at(-1)?.text), JSON.stringify(acts.at(-1)));
    ag.close(); }

  { const { ag, acts, pings } = rig();
    ag.notePose("ghost", { p: [null as any, 0, null as any], yaw: 0, speed: 0, clip: "idle" });
    ag.notePose("ghost", pose(1.1, 0.2, "lie"));   // first REAL coords, right beside us
    check("shell → first real coords is still a baseline (no approach, no acts)", pings().length === 0 && acts.length === 0, JSON.stringify(acts));
    ag.close(); }
}

// ---- the disconnect rule: a leave after a delivered approach is ONE presence exit, never a synthetic depart ----
console.log("\n━━ agent: disconnect after a delivered approach — one exit, one line ━━");
{
  const ag = new WorldAgent({ url: noWorldUrl(), name: "wiretest" }) as any;
  ag.pos = { x: 0, y: 0, z: 0 };
  const T0 = Date.now(), pings: any[] = [], events: any[] = [];
  ag.onPing = (p: any) => pings.push(p);
  ag.onEvent = (e: any) => events.push(e);
  const at = (t: number, x: number, z: number) => ag.notePose("digi", { p: [x, 0, z], yaw: 0, speed: 0, clip: "walk" }, T0 + t);
  at(0, 10, 0); at(100, 1.5, 0);
  for (let i = 0; i <= APPROACH_DWELL_MS + 400; i += 200) at(100 + i, 1.5, 0);
  check("(setup) approach delivered", pings.filter((p) => p.kind === "approach").length === 1);
  ag.senses.noteLeave("digi");   // the `leave` message path, sans socket
  const leaves = () => events.filter((e) => e.kind === "leave" && e.who === "digi").length;
  await tryUntil("digi's leave past the leave hold", leaves);
  check("disconnect yields one presence exit", leaves() === 1, JSON.stringify(events));
  check("...and no synthetic depart — one exit, one line", pings.filter((p) => p.kind === "depart").length === 0, JSON.stringify(pings));
  check("the re-arm state went with them (a return visit starts clean)",
    !ag.senses.nearArmed.has("digi") && !ag.senses.approachOpen.has("digi") && !ag.senses.approachPending.has("digi"));
  ag.close();
}

// ---- 5. the live knobs may not reintroduce the pass-through defect (PR #145 review vectors) -------------------
console.log("\n━━ approach knobs: the max wait clamps to 2·APPROACH_RADIUS / APPROACH_STILL_MPS ━━");
{
  check("at defaults the invariant holds without clamping",
    APPROACH_MAX_WAIT_MS === 20_000 && APPROACH_SAFE_WAIT_MS <= APPROACH_MAX_WAIT_MS, `wait=${APPROACH_MAX_WAIT_MS} safe=${APPROACH_SAFE_WAIT_MS}`);
  for (const [name, env] of [
    ["EW_APPROACH_MAX_WAIT_SEC=1 (the wait alone)", { EW_APPROACH_MAX_WAIT_SEC: "1" }],
    ["EW_APPROACH_STILL_MPS=0.1 (the threshold alone)", { EW_APPROACH_STILL_MPS: "0.1" }],
    ["EW_APPROACH_STILL_MPS=0 (rejected outright)", { EW_APPROACH_STILL_MPS: "0" }],
  ] as const) {
    const r = spawnSync(process.execPath, [process.argv[1], "clamp"], { env: { ...process.env, ...env }, encoding: "utf-8" });
    process.stdout.write((r.stdout ?? "").replace(/^(?=.)/gm, "    "));
    check(`under ${name} the clamp held`, r.status === 0 && /\[denoise-clamp\] \d+ passed, 0 failed/.test(r.stdout ?? ""), (r.stderr || "").slice(-200));
  }
}

console.log("\n━━ agent: activity pulse — regular wakes only while life is near ━━");
{
  const agent = new WorldAgent({ name: "claude", url: noWorldUrl() }); // at origin
  const pulses: string[] = [];
  agent.onEvent = (ev) => { if (ev.kind === "activity") pulses.push(ev.text!); };
  // digi 10m away, walking and talking: inside the 30m radius
  (agent as any).notePose("digi", { p: [10, 0, 0], yaw: 0, speed: 1.5, clip: "walk" });
  (agent as any).hearSay({ verb: "say", args: { text: "движуха" }, actor: "digi", ts: Date.now(), seq: 10 }, true);
  // ghost 100m away, also walking and talking: must not count
  (agent as any).notePose("ghost", { p: [100, 0, 0], yaw: 0, speed: 1.5, clip: "walk" });
  (agent as any).hearSay({ verb: "say", args: { text: "far away" }, actor: "ghost", ts: Date.now(), seq: 11 }, true);
  await tryUntil("the first pulse", () => pulses.length);
  check("one pulse while activity is near", pulses.length === 1, JSON.stringify(pulses));
  check("digest names digi, ignores the far ghost",
    (pulses[0] ?? "").includes("digi") && !(pulses[0] ?? "").includes("ghost"), pulses[0]);
  await pause("two quiet pulse windows: nothing should arrive", 250);
  check("quiet nearby → the stream stops by itself", pulses.length === 1, String(pulses.length));
  // a build near the body revives it
  (agent as any).noteBuild("digi", [3, 0, 3]);   // what a thing born near the body runs (agent.ts onThingChange 'born')
  await tryUntil("the revived pulse", () => pulses.length >= 2);
  check("a nearby build revives the pulse", pulses.length === 2 && pulses[1].includes("1 thing changed"), JSON.stringify(pulses.slice(1)));
  agent.close();
}

console.log("\n━━ agent: recurrence is not novelty — ambient scenery dedupes ━━");
{
  const agent = new WorldAgent({ name: "claude", url: noWorldUrl() }); // at origin
  const pulses: string[] = [];
  agent.onEvent = (ev) => { if (ev.kind === "activity") pulses.push(ev.text!); };
  const np = (x: number) => (agent as any).notePose("digi", { p: [x, 0, 0], yaw: 0, speed: 1.5, clip: "walk" });
  // real travel: 1.5m inside the window
  np(10); np(11.5);
  await tryUntil("the travel pulse", () => pulses.length);
  check("travel makes an ambient pulse", pulses.length === 1 && pulses[0].includes("digi moving about"), JSON.stringify(pulses));
  // same scenery next window: digi still pacing is NOT news
  np(10);
  await pause("one pulse window passes with the same movers", 130);
  check("same movers again → suppressed (scenery, not news)", pulses.length === 1, String(pulses.length));
  // keep pacing past the refresh horizon: the heartbeat re-confirms once per refresh window, compacted
  for (let i = 0; i < 5; i++) { np(i % 2 ? 11.5 : 10); await pause("pacing across pulse windows: the rate is the row", 130); }
  const afterPacing = pulses.length;
  check("after the refresh the heartbeat re-confirms — at refresh rate, not window rate",
    afterPacing >= 2 && afterPacing <= 3, String(afterPacing));
  check("unchanged cast is a count, not a re-introduction", (pulses[1] ?? "").startsWith("1 nearby"), pulses[1]);
  // a discrete event always speaks, even with identical scenery
  np(11.5);
  (agent as any).hearSay({ verb: "say", args: { text: "о!" }, actor: "digi", ts: Date.now(), seq: 30 }, true);
  await tryUntil("the speech pulse", () => pulses.length > afterPacing);
  check("speech cuts through the dedupe",
    pulses.length === afterPacing + 1 && pulses[pulses.length - 1].includes("1 message"), JSON.stringify(pulses.slice(afterPacing)));
  agent.close();
}

console.log("\n━━ agent: idle jitter is not movement ━━");
{
  const agent = new WorldAgent({ name: "claude", url: noWorldUrl() });
  const pulses: string[] = [];
  agent.onEvent = (ev) => { if (ev.kind === "activity") pulses.push(ev.text!); };
  // fidgeting: many pose packets, centimetres of travel
  for (let i = 0; i < 10; i++)
    (agent as any).notePose("digi", { p: [10 + (i % 2) * 0.03, 0, 0], yaw: 0, speed: 1.5, clip: "walk" });
  await pause("a pulse window passes: nothing should arrive", 200);
  check("jitter under the travel floor → no pulse at all", pulses.length === 0, JSON.stringify(pulses));
  agent.close();
}

console.log("\n━━ agent: activity dial — the sense is the agent's own to tune ━━");
{
  const agent = new WorldAgent({ name: "claude", url: noWorldUrl() });
  const pulses: string[] = [];
  agent.onEvent = (ev) => { if (ev.kind === "activity") pulses.push(ev.text!); };
  let cur = agent.setActivity({ radiusM: 5 });
  check("radius setter returns the applied value", cur.radiusM === 5, JSON.stringify(cur));
  // digi walks and talks at 10m: outside the shrunk 5m sense
  (agent as any).notePose("digi", { p: [10, 0, 0], yaw: 0, speed: 1.5, clip: "walk" });
  (agent as any).hearSay({ verb: "say", args: { text: "outside" }, actor: "digi", ts: Date.now(), seq: 20 }, true);
  await pause("a pulse window passes: nothing should arrive", 200);
  check("activity beyond the tuned radius → no pulse", pulses.length === 0, JSON.stringify(pulses));
  cur = agent.setActivity({ pulseSec: 0, radiusM: 50 });
  check("pulse_sec 0 turns the sense off", cur.pulseSec === 0 && cur.radiusM === 50, JSON.stringify(cur));
  // speech nearby: what the sense always counts, so only the dial being off keeps it quiet
  (agent as any).notePose("digi", { p: [10, 0, 0], yaw: 0, speed: 1.5, clip: "walk" });
  (agent as any).hearSay({ verb: "say", args: { text: "inside now" }, actor: "digi", ts: Date.now(), seq: 21 }, true);
  await pause("a pulse window passes: nothing should arrive", 200);
  check("off means off — activity nearby, no pulse", pulses.length === 0, String(pulses.length));
  cur = agent.setActivity({ pulseSec: 3 });
  check("re-enabling clamps to the 10s floor", cur.pulseSec === 10, String(cur.pulseSec));
  agent.close();
}

done();
