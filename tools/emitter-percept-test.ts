// emitter-percept-test — text-tier perception of the `particles` component,
// serverless.
//
// The contract (eidoverse-worlds #25's agent-perception comment): a resident
// who perceives by reading must (a) find the emitter named semantically on the
// entity that owns it when they look, and (b) HEAR a live attach/replace/
// remove near them — once, coalesced, never per particle or per frame, and
// never re-performed by a replay.
//
// Run: bun tools/emitter-percept-test.ts

// The coalescing window agent.ts reads from the environment, set SHORT so the
// suite doesn't sit for four seconds a leg — the behaviour under test is the
// folding, not the duration. agent.ts reads it at module load, so the import
// has to happen AFTER this line: a static import would be hoisted above it.
process.env.EW_EMITTER_COALESCE_SEC = "0.25";
const WINDOW = 250;
const { WorldAgent } = await import("../mcpl/agent.ts");

let pass = 0, fail = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`); }
}

const T0 = 1_754_000_000_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function rig(name = "emitters", at: [number, number] = [0, 0]) {
  const ag = new WorldAgent({ name });
  ag.pos.x = at[0]; ag.pos.z = at[1];
  const events: any[] = [];
  ag.onEvent = (ev) => { if (ev.kind === "world-change") events.push(ev); };
  const A = ag as any;
  const spawn = (id: string, pos = [0, 0, 0]) =>
    A.applyEntry({ verb: "spawn", args: { id, lib: "deco/hearth.glb", pos }, ts: T0, seq: 1, actor: "antra" }, false);
  const comp = (id: string, data: unknown, live = true, actor = "antra", ts = T0) =>
    A.applyEntry({ verb: "comp", args: { id, type: "particles", data }, ts, seq: 2, actor }, live);
  return { ag, A, events, spawn, comp };
}

const FIRE = { preset: "fire", origin: [0, 0.25, 0], texture: "eidoverse/assets/particle_textures/flame_05.png" };
const SMOKE = { preset: "smoke", origin: [0, 0.25, 0] };

// ---------------------------------------------------------------- A: pull perception (look)
{
  const { ag, spawn, comp } = rig();
  spawn("hearth", [2, 0, 0]);
  comp("hearth", FIRE, false);
  const out = ag.look();
  check("look() names the emitter on the owning entity", /\[hearth\][^\n]*emitting fire/.test(out), out.split("\n").find((l) => l.includes("hearth")));
  check("...with the local origin it was authored at", out.includes("local origin [0, 0.25, 0]"));
  check("...and does not fall back to `components: particles`", !/components:[^\n]*particles/.test(out));
  check("...and enumerates no sprites", !/\b150\b/.test(out));
  check("...and claims no heat, light, sound or contact",
    !/(warm|heat\b|crackl|glow|smell)/i.test(out));

  comp("hearth", { preset: "plasma" }, false);
  const unknown = ag.look();
  check("an unrenderable preset is still legible as an emitter",
    /\[hearth\][^\n]*emitting "plasma"/.test(unknown) && unknown.includes("preset unknown"));

  comp("hearth", null, false);
  check("a removed emitter is gone from look()", !ag.look().includes("emitting"));

  // an ordinary component is untouched by any of this
  const A = ag as any;
  A.applyEntry({ verb: "comp", args: { id: "hearth", type: "recipe", data: { by: "fc" } }, ts: T0, seq: 3, actor: "antra" }, false);
  check("other component types still read as they did", ag.look().includes("components: recipe"));
}

// ---------------------------------------------------------------- B: live change perception
{
  const { events, spawn, comp } = rig();
  spawn("hearth", [2, 0, 0]);

  comp("hearth", FIRE);
  check("lighting a fire nearby is heard once", events.length === 1, `got ${events.length}`);
  check("...carrying actor, entity and preset",
    events[0].who === "antra" && events[0].text.includes("[hearth]") && events[0].text.includes("fire"));
  check("...as a world-change, not a mention", events[0].kind === "world-change" && !events[0].mention);

  await sleep(WINDOW * 2);
  comp("hearth", SMOKE);
  check("replacing it with smoke is heard once more", events.length === 2, `got ${events.length}`);
  check("...and says what it became", events[1].text.includes("smoke"));

  await sleep(WINDOW * 2);
  comp("hearth", null);
  check("putting it out is heard", events.length === 3 && events[2].text.includes("puts out"));
}

// ---------------------------------------------------------------- C: coalescing a tuning burst
{
  const { events, spawn, comp } = rig();
  spawn("hearth", [1, 0, 0]);
  comp("hearth", FIRE);
  check("the first change speaks at once", events.length === 1);
  for (let i = 0; i < 20; i++) comp("hearth", { ...FIRE, size: 0.4 + i * 0.01 });
  check("twenty tuning entries add NOTHING inside the window", events.length === 1, `got ${events.length}`);
  await sleep(WINDOW * 2);
  check("the window closes with one summary of the net result", events.length === 2, `got ${events.length}`);
  check("...which is a retune, not a second lighting", events[1].text.includes("retunes"));
  await sleep(WINDOW * 2);
  check("a settled emitter then goes quiet", events.length === 2);
}
{
  // A burst that nets out to nothing must not narrate at all.
  const { events, spawn, comp } = rig();
  spawn("hearth", [1, 0, 0]);
  comp("hearth", FIRE);
  comp("hearth", SMOKE);
  comp("hearth", FIRE);              // back to where the first line already said
  await sleep(WINDOW * 3);
  check("a burst that returns to the announced state stays silent", events.length === 1, `got ${events.length}`);
}
{
  // …but a burst that ENDS in the window still gets told, at the window's edge.
  const { events, spawn, comp } = rig();
  spawn("hearth", [1, 0, 0]);
  comp("hearth", FIRE);
  comp("hearth", null);
  await sleep(WINDOW * 3);
  check("an emitter put out inside the window is still reported", events.length === 2 && events[1].text.includes("puts out"));
}

// ---------------------------------------------------------------- D: replay, distance, self
{
  const { events, spawn, comp } = rig();
  spawn("hearth", [2, 0, 0]);
  comp("hearth", FIRE, false);       // replay / late join
  comp("hearth", SMOKE, false);
  check("replay reconstructs state without re-performing the event", events.length === 0);
}
{
  const { ag, events, spawn, comp } = rig("emitters", [0, 0]);
  spawn("bonfire", [400, 0, 0]);
  comp("bonfire", FIRE);
  check("a fire lit across the world is not a percept", events.length === 0);
  check("...but it is still in look()", ag.look().includes("emitting fire"));
}
{
  const { events, spawn, comp } = rig("antra");
  spawn("hearth", [1, 0, 0]);
  comp("hearth", FIRE, true, "antra");
  check("your own authoring is not delivered back to you as an event", events.length === 0);
}
{
  // Two residents beside the same hearth each hear it once — and derive the
  // same emitter, because the seed is the entity's, not the session's.
  const one = rig("one", [1, 0]);
  const two = rig("two", [-1, 0]);
  for (const r of [one, two]) { r.spawn("hearth", [0, 0, 0]); r.comp("hearth", FIRE); }
  check("two residents each receive exactly one event",
    one.events.length === 1 && two.events.length === 1);
  check("...and the same text about the same fire", one.events[0].text === two.events[0].text);
}
{
  // Nothing about a NON-particles component changed.
  const { events, spawn, A } = rig();
  spawn("swing", [1, 0, 0]);
  A.applyEntry({ verb: "comp", args: { id: "swing", type: "sockets", data: { seat: { pos: [0, 0.5, 0] } } }, ts: T0, seq: 4, actor: "antra" }, true);
  check("other component types narrate nothing (scope fence)", events.length === 0);
}

// ---------------------------------------------------------------- C: several emitters per entity
{
  // `particles:<name>` — a hearth's fire, smoke and sparks are three emitters,
  // each read and narrated on its own terms.
  const { ag, A, events, spawn } = rig();
  const compK = (id: string, type: string, data: unknown, live = true, ts = T0) =>
    A.applyEntry({ verb: "comp", args: { id, type, data }, ts, seq: 5, actor: "antra" }, live);
  spawn("hearth", [2, 0, 0]);
  compK("hearth", "particles", FIRE, false);
  compK("hearth", "particles:smoke", { ...SMOKE, origin: [0, 0.8, 0], color: "#555566" }, false);
  compK("hearth", "particles:candle", { preset: "fire", origin: [0.4, 0.9, 0], scale: 0.025 }, false);
  const out = ag.look();
  const line = out.split("\n").find((l) => l.includes("[hearth]")) ?? "";
  check("look() names every emitter the entity carries, default first",
    /emitting fire \(particles;[^)]*\)[^\n]*emitting smoke \(particles:smoke;/.test(line), line);
  check("...a scaled one says how small", line.includes("(particles:candle;") && line.includes("scale 0.025"));
  check("...a tinted one names its colour", line.includes("tinted #555566"));
  check("...and none leaks into `components:`", !/components:[^\n]*particles/.test(line));

  compK("hearth", "particles:sparks", { preset: "sparks" });
  check("lighting a named emitter is heard once, under its own name",
    events.length === 1 && events[0].text.includes("lights sparks") && events[0].text.endsWith("(particles:sparks)"),
    events.map((e) => e.text).join(" | "));
  compK("hearth", "particles", { ...FIRE, size: 0.6 });
  check("...while a change to ANOTHER emitter on the same entity is its own news, not folded into the first",
    events.length === 2 && events[1].text.includes("retunes the fire") && events[1].text.endsWith("(particles)"));
  compK("hearth", "particles:sparks", { preset: "sparks", count: 30 });
  check("a burst on one emitter folds inside its own window", events.length === 2);
  await sleep(WINDOW + 80);
  check("...and closes with one net line for that emitter",
    events.length === 3 && events[2].text.includes("retunes the sparks") && events[2].text.endsWith("(particles:sparks)"),
    events.map((e) => e.text).join(" | "));

  compK("hearth", "particles:two words", { preset: "fire" });
  check("a malformed emitter key is an ordinary component: no event, read as a component",
    events.length === 3 && ag.look().includes("components: particles:two words"));
  await sleep(WINDOW + 80);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
