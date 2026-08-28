/**
 * Denoise gate test — no servers needed. Exercises the four noise classes
 * from Fable's 2026-08-02 field report:
 *   1. arrive/leave flaps collapse to nothing (both directions)
 *   2. posture/emote cycles: refractory + short-stint "gets up" swallow
 *   3. self-echo: own say never fans out as an event
 *   4. approach: hysteresis re-arm + long refractory
 *
 * Run: cd mcpl && bun run denoise-test.ts
 * (env windows are shrunk below BEFORE the modules load — order matters)
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

const { NoiseGate } = await import("./denoise.ts");
const { WorldAgent } = await import("./agent.ts");

let failures = 0;
const check = (label: string, ok: boolean, detail?: string) => {
  console.log(ok ? `  \x1b[32m✓\x1b[0m ${label}` : `  \x1b[31m✗ ${label}${detail ? ` — ${detail}` : ""}\x1b[0m`);
  if (!ok) failures++;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---- 1. presence: hold-and-cancel + battery --------------------------------
console.log("\n━━ presence: flaps collapse, real events pass, chronic noise drains ━━");
{
  const out: string[] = [];
  const gate = new NoiseGate((ev) => out.push(`${ev.kind}:${ev.who}`));

  gate.presence("digi", "arrive");
  await sleep(120);
  check("real arrive emits after the hold", out.join(",") === "arrive:digi", out.join(","));

  out.length = 0;
  gate.presence("digi", "leave");
  await sleep(10);
  gate.presence("digi", "arrive"); // reconnect flap
  await sleep(120);
  check("leave→arrive flap collapses to nothing", out.length === 0, out.join(","));
  check("flap counted in stats", gate.stats.flapsCollapsed === 1, String(gate.stats.flapsCollapsed));

  out.length = 0;
  gate.presence("fc", "arrive");
  await sleep(10);
  gate.presence("fc", "leave"); // smoke-test visit
  await sleep(120);
  check("arrive→leave brief visit collapses to nothing", out.length === 0, out.join(","));

  // battery: real pairs beyond the hold window still drain the identity
  out.length = 0;
  for (let i = 0; i < 3; i++) {
    gate.presence("flappy", "leave");
    await sleep(90);
    gate.presence("flappy", "arrive");
    await sleep(90);
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
  gate.act("digi", "emote:dance", "emotes: dance");
  check("a DIFFERENT act from the same person still speaks", out.length === 2, out.join(" | "));
  await sleep(250);
  gate.act("digi", "clip:jump", 'starts "jump"');
  check("after the refractory the act speaks again", out.length === 3, String(out.length));
  gate.dispose();
}

// ---- agent-level: jump stint, self-echo, approach --------------------------
console.log("\n━━ agent: jump = one thing not two; long sits still narrate ━━");
{
  const agent = new WorldAgent({ name: "claude" });
  const acts: string[] = [];
  agent.onEvent = (ev) => { if (ev.kind === "act") acts.push(ev.text!); };
  const np = (id: string, clip: string, x = 5, z = 5) =>
    (agent as any).notePose(id, { p: [x, 0, z], yaw: 0, speed: 0, clip });

  np("digi", "idle");
  np("digi", "jump");
  np("digi", "idle"); // back within the stint window
  await sleep(20);
  check("jump cycle → one event, no 'gets up'", acts.length === 1 && acts[0] === 'starts "jump"', acts.join(" | "));

  acts.length = 0;
  np("digi", "sit");
  await sleep(220); // outlives both the stint minimum and the act refractory
  np("digi", "idle");
  check("a real sit still earns its 'gets up'", acts.includes("gets up"), acts.join(" | "));
  agent.close();
}

console.log("\n━━ agent: own say is not an event ━━");
{
  const agent = new WorldAgent({ name: "claude" });
  const heard: string[] = [];
  agent.onEvent = (ev) => { if (ev.kind === "say") heard.push(`${ev.who}:${ev.text}`); };
  await (agent as any).applyEntry({ verb: "say", args: { text: "me talking" }, actor: "claude", ts: Date.now(), seq: 1 }, true);
  await (agent as any).applyEntry({ verb: "say", args: { text: "hey claude" }, actor: "digi", ts: Date.now(), seq: 2 }, true);
  check("own say suppressed, other's say delivered", heard.length === 1 && heard[0].startsWith("digi:"), heard.join(" | "));
  check("own say still lands in the inbox (honest scrollback)",
    agent.inbox.some((m) => m.kind === "say" && m.who === "claude"), JSON.stringify(agent.inbox));
  agent.close();
}

console.log("\n━━ agent: approach = knock once, not a metronome ━━");
{
  const agent = new WorldAgent({ name: "claude" }); // agent at origin
  // VIRTUAL CLOCK. An approach is now confirmed by DWELL, so every assertion
  // here is a claim about time; driving it off real sleeps would make the
  // block both slow and racy (the refractory is 300ms and the old version had
  // no sleeps at all inside it, so added sleeps eat that margin). notePose
  // takes `now` for exactly this reason.
  // Offset from a real epoch, not from 0: `cooled` measures against a
  // last-approach time that defaults to 0, so a clock starting near zero reads
  // as "approached a moment ago" and refuses the very first knock.
  const T0 = Date.now();
  const np = (id: string, x: number, z: number, t: number) =>
    (agent as any).notePose(id, { p: [x, 0, z], yaw: 0, speed: 0, clip: "walk" }, T0 + t);
  const approaches = () => agent.pings.filter((p) => p.kind === "approach").length;

  np("digi", 10, 0, 0);    // baseline, far → armed
  np("digi", 2, 0, 10);    // crosses 2.5m — opens a pending approach
  np("digi", 2, 0, 100);   // still there 90ms later (dwell is 50ms here)
  check("first approach pings", approaches() === 1);

  np("digi", 3, 0, 110);   // steps out — but NOT past the re-arm radius
  np("digi", 2, 0, 120);   // crosses again
  np("digi", 2, 0, 170);
  np("digi", 4, 0, 180);
  np("digi", 2, 0, 190);
  np("digi", 2, 0, 240);
  check("pacing at the boundary does not re-ping (not re-armed)",
    approaches() === 1, String(agent.pings.length));

  np("digi", 8, 0, 250);   // genuinely goes away — re-arms
  np("digi", 2, 0, 260);   // comes right back, but refractory (300ms) still holds
  np("digi", 2, 0, 320);
  check("re-armed but inside the refractory: still silent",
    approaches() === 1, String(agent.pings.length));

  np("digi", 8, 0, 500);   // away again; refractory expires at 400
  np("digi", 2, 0, 510);
  np("digi", 2, 0, 600);
  check("gone away + refractory over → the knock counts again",
    approaches() === 2, String(agent.pings.length));

  // The departure earned by the first walk-away, at t=250. Exactly one: the
  // second trip past the re-arm radius (t=500) had no delivered approach
  // outstanding, because the visit at t=260 was refused by the refractory.
  check("going away past the re-arm radius pings depart — once, for the visit that counted",
    agent.pings.filter((p) => p.kind === "depart").length === 1,
    JSON.stringify(agent.pings.map((p) => p.kind)));
  agent.close();
}

console.log("\n━━ agent: activity pulse — regular wakes only while life is near ━━");
{
  const agent = new WorldAgent({ name: "claude" }); // at origin
  const pulses: string[] = [];
  agent.onEvent = (ev) => { if (ev.kind === "activity") pulses.push(ev.text!); };
  // digi 10m away: walking and talking — inside the 30m radius
  (agent as any).notePose("digi", { p: [10, 0, 0], yaw: 0, speed: 1.5, clip: "walk" });
  await (agent as any).applyEntry({ verb: "say", args: { text: "движуха" }, actor: "digi", ts: Date.now(), seq: 10 }, true);
  // ghost 100m away: also walking and talking — must not count
  (agent as any).notePose("ghost", { p: [100, 0, 0], yaw: 0, speed: 1.5, clip: "walk" });
  await (agent as any).applyEntry({ verb: "say", args: { text: "far away" }, actor: "ghost", ts: Date.now(), seq: 11 }, true);
  await sleep(200);
  check("one pulse while activity is near", pulses.length === 1, JSON.stringify(pulses));
  check("digest names digi, ignores the far ghost",
    (pulses[0] ?? "").includes("digi") && !(pulses[0] ?? "").includes("ghost"), pulses[0]);
  await sleep(250);
  check("quiet nearby → the stream stops by itself", pulses.length === 1, String(pulses.length));
  // a build near the body revives it
  await (agent as any).applyEntry({ verb: "spawn", args: { id: "t1", lib: "x.glb", pos: [3, 0, 3] }, actor: "digi", ts: Date.now() }, true);
  await sleep(200);
  check("a nearby build revives the pulse", pulses.length === 2 && pulses[1].includes("1 thing changed"), JSON.stringify(pulses.slice(1)));
  agent.close();
}

console.log("\n━━ agent: recurrence is not novelty — ambient scenery dedupes ━━");
{
  const agent = new WorldAgent({ name: "claude" }); // at origin
  const pulses: string[] = [];
  agent.onEvent = (ev) => { if (ev.kind === "activity") pulses.push(ev.text!); };
  const np = (x: number) => (agent as any).notePose("digi", { p: [x, 0, 0], yaw: 0, speed: 1.5, clip: "walk" });
  // real travel: 1.5m inside the window
  np(10); np(11.5);
  await sleep(200);
  check("travel makes an ambient pulse", pulses.length === 1 && pulses[0].includes("digi moving about"),
    JSON.stringify(pulses));
  // same scenery next window: digi still pacing — NOT news
  np(10);
  await sleep(130);
  check("same movers again → suppressed (scenery, not news)", pulses.length === 1, String(pulses.length));
  // keep pacing past the refresh horizon — the heartbeat re-confirms (once
  // per refresh window, however long the pacing goes on), compacted
  for (let i = 0; i < 5; i++) { np(i % 2 ? 11.5 : 10); await sleep(130); }
  const afterPacing = pulses.length;
  check("after the refresh the heartbeat re-confirms — at refresh rate, not window rate",
    afterPacing >= 2 && afterPacing <= 3, String(afterPacing));
  check("unchanged cast is a count, not a re-introduction", (pulses[1] ?? "").startsWith("1 nearby"),
    pulses[1]);
  // a discrete event always speaks, even with identical scenery
  np(11.5);
  await (agent as any).applyEntry({ verb: "say", args: { text: "о!" }, actor: "digi", ts: Date.now(), seq: 30 }, true);
  await sleep(200);
  check("speech cuts through the dedupe",
    pulses.length === afterPacing + 1 && pulses[pulses.length - 1].includes("1 message"),
    JSON.stringify(pulses.slice(afterPacing)));
  agent.close();
}

console.log("\n━━ agent: idle jitter is not movement ━━");
{
  const agent = new WorldAgent({ name: "claude" });
  const pulses: string[] = [];
  agent.onEvent = (ev) => { if (ev.kind === "activity") pulses.push(ev.text!); };
  // fidgeting: many pose packets, centimetres of travel
  for (let i = 0; i < 10; i++)
    (agent as any).notePose("digi", { p: [10 + (i % 2) * 0.03, 0, 0], yaw: 0, speed: 1.5, clip: "walk" });
  await sleep(200);
  check("jitter under the travel floor → no pulse at all", pulses.length === 0, JSON.stringify(pulses));
  agent.close();
}

console.log("\n━━ agent: activity dial — the sense is the agent's own to tune ━━");
{
  const agent = new WorldAgent({ name: "claude" });
  const pulses: string[] = [];
  agent.onEvent = (ev) => { if (ev.kind === "activity") pulses.push(ev.text!); };
  let cur = agent.setActivity({ radiusM: 5 });
  check("radius setter returns the applied value", cur.radiusM === 5, JSON.stringify(cur));
  // digi walks and talks at 10m — outside the shrunk 5m sense
  (agent as any).notePose("digi", { p: [10, 0, 0], yaw: 0, speed: 1.5, clip: "walk" });
  await (agent as any).applyEntry({ verb: "say", args: { text: "outside" }, actor: "digi", ts: Date.now(), seq: 20 }, true);
  await sleep(200);
  check("activity beyond the tuned radius → no pulse", pulses.length === 0, JSON.stringify(pulses));
  cur = agent.setActivity({ pulseSec: 0, radiusM: 50 });
  check("pulse_sec 0 turns the sense off", cur.pulseSec === 0 && cur.radiusM === 50, JSON.stringify(cur));
  (agent as any).notePose("digi", { p: [10, 0, 0], yaw: 0, speed: 1.5, clip: "walk" });
  await sleep(200);
  check("off means off — activity nearby, no pulse", pulses.length === 0, String(pulses.length));
  cur = agent.setActivity({ pulseSec: 3 });
  check("re-enabling clamps to the 10s floor", cur.pulseSec === 10, String(cur.pulseSec));
  agent.close();
}

console.log(failures ? `\n\x1b[31m${failures} failure(s)\x1b[0m` : "\n\x1b[32mall checks passed\x1b[0m");
process.exit(failures ? 1 : 0);
