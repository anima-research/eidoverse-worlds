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
const { agentOnDoor } = await import("./agent-scratch.ts");

let pass = 0, fail = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`); }
}

const T0 = 1_754_000_000_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// The world is a scratch authority (tools/agent-scratch.ts), every write a door request at door time T0 (the coalescing
// window is the agent's, not the door's); the agent takes the next view of its own fold after each, live or not.
async function rig(name = "emitters", at: [number, number] = [0, 0]) {
  const ag = new WorldAgent({ name });
  ag.pos.x = at[0]; ag.pos.z = at[1];
  const events: any[] = [];
  ag.onEvent = (ev) => { if (ev.kind === "world-change") events.push(ev); };
  const A = ag as any;
  const door = agentOnDoor(A, "emitters", { start: T0 - 1000 });
  await door.sync(false);
  const must = (r: any, what: string) => { if (!r.ok) throw new Error(`${what} refused: ${JSON.stringify(r.refused)}`); return r; };
  const spawn = async (id: string, pos = [0, 0, 0]) =>
    must(await door.act("create", { id, model: "deco/hearth.glb", components: { transform: { pos } } }, { who: "antra", at: T0, live: false }), `create ${id}`);
  const comp = async (id: string, data: unknown, live = true, actor = "antra", ts = T0) =>
    must(await (data === null ? door.act("delete", { id, component: "particles" }, { who: actor, at: ts, live })
      : door.act("set", { id, component: "particles", value: data }, { who: actor, at: ts, live })), `particles on ${id}`);
  const other = async (id: string, component: string, value: unknown, live = true) =>
    must(await door.act("set", { id, component, value }, { who: "antra", at: T0, live }), `${component} on ${id}`);
  return { ag, A, events, spawn, comp, other, door };
}

// the protocol's spelling (effects are documents, PROTOCOL §4): {effect, at, params}; preset/origin/texture are the first protocol's
const FIRE = { effect: "fire", at: [0, 0.25, 0], params: { texture: "eidoverse/assets/particle_textures/flame_05.png" } };
const SMOKE = { effect: "smoke", at: [0, 0.25, 0] };

// ---------------------------------------------------------------- A: pull perception (look)
{
  const { ag, spawn, comp, other, door } = await rig();
  await spawn("hearth", [2, 0, 0]);
  await comp("hearth", FIRE, false);
  const out = ag.look();
  check("look() names the emitter on the owning entity", /\[hearth\][^\n]*emitting fire/.test(out), out.split("\n").find((l) => l.includes("hearth")));
  check("...with the local origin it was authored at", out.includes("local origin [0, 0.25, 0]"));
  check("...and does not fall back to `components: particles`", !/components:[^\n]*particles/.test(out));
  check("...and enumerates no sprites", !/\b150\b/.test(out));
  check("...and claims no heat, light, sound or contact",
    !/(warm|heat\b|crackl|glow|smell)/i.test(out));

  // an effect nobody has is refused at the door (effects are documents: an Essential's name or a stored address),
  // so nothing unrenderable ever reaches a reader
  const plasma = await door.act("set", { id: "hearth", component: "particles", value: { effect: "plasma" } }, { who: "antra", at: T0, live: false });
  check("an effect that is no Essential and no address is refused at the door, naming the Essentials",
    !plasma.ok && plasma.refused?.code === "shape" && /isn't an Essentials effect/.test(plasma.refused.reason) && /\[hearth\][^\n]*emitting fire/.test(ag.look()), JSON.stringify(plasma.refused));

  await comp("hearth", null, false);
  check("a removed emitter is gone from look()", !ag.look().includes("emitting"));

  // an ordinary component is untouched by any of this
  await other("hearth", "example.org/recipe", { by: "fc" }, false);
  check("other component types still read as they did", ag.look().includes("components: example.org/recipe"));
}

// ---------------------------------------------------------------- B: live change perception
{
  const { events, spawn, comp } = await rig();
  await spawn("hearth", [2, 0, 0]);

  await comp("hearth", FIRE);
  check("lighting a fire nearby is heard once", events.length === 1, `got ${events.length}`);
  check("...carrying actor, entity and preset",
    events[0].who === "antra" && events[0].text.includes("[hearth]") && events[0].text.includes("fire"));
  check("...as a world-change, not a mention", events[0].kind === "world-change" && !events[0].mention);

  await sleep(WINDOW * 2);
  await comp("hearth", SMOKE);
  check("replacing it with smoke is heard once more", events.length === 2, `got ${events.length}`);
  check("...and says what it became", events[1].text.includes("smoke"));

  await sleep(WINDOW * 2);
  await comp("hearth", null);
  check("putting it out is heard", events.length === 3 && events[2].text.includes("puts out"));
}

// ---------------------------------------------------------------- C: coalescing a tuning burst
{
  const { events, spawn, comp } = await rig();
  await spawn("hearth", [1, 0, 0]);
  await comp("hearth", FIRE);
  check("the first change speaks at once", events.length === 1);
  for (let i = 0; i < 20; i++) await comp("hearth", { ...FIRE, params: { ...FIRE.params, size: 0.4 + i * 0.01 } });
  check("twenty tuning entries add NOTHING inside the window", events.length === 1, `got ${events.length}`);
  await sleep(WINDOW * 2);
  check("the window closes with one summary of the net result", events.length === 2, `got ${events.length}`);
  check("...which is a retune, not a second lighting", events[1].text.includes("retunes"));
  await sleep(WINDOW * 2);
  check("a settled emitter then goes quiet", events.length === 2);
}
{
  // A burst that nets out to nothing must not narrate at all.
  const { events, spawn, comp } = await rig();
  await spawn("hearth", [1, 0, 0]);
  await comp("hearth", FIRE);
  await comp("hearth", SMOKE);
  await comp("hearth", FIRE);              // back to where the first line already said
  await sleep(WINDOW * 3);
  check("a burst that returns to the announced state stays silent", events.length === 1, `got ${events.length}`);
}
{
  // …but a burst that ENDS in the window still gets told, at the window's edge.
  const { events, spawn, comp } = await rig();
  await spawn("hearth", [1, 0, 0]);
  await comp("hearth", FIRE);
  await comp("hearth", null);
  await sleep(WINDOW * 3);
  check("an emitter put out inside the window is still reported", events.length === 2 && events[1].text.includes("puts out"));
}

// ---------------------------------------------------------------- D: replay, distance, self
{
  const { events, spawn, comp } = await rig();
  await spawn("hearth", [2, 0, 0]);
  await comp("hearth", FIRE, false);       // replay / late join
  await comp("hearth", SMOKE, false);
  check("replay reconstructs state without re-performing the event", events.length === 0);
}
{
  const { ag, events, spawn, comp } = await rig("emitters", [0, 0]);
  await spawn("bonfire", [400, 0, 0]);
  await comp("bonfire", FIRE);
  check("a fire lit across the world is not a percept", events.length === 0);
  check("...but it is still in look()", ag.look().includes("emitting fire"));
}
{
  const { events, spawn, comp } = await rig("antra");
  await spawn("hearth", [1, 0, 0]);
  await comp("hearth", FIRE, true, "antra");
  check("your own authoring is not delivered back to you as an event", events.length === 0);
}
{
  // Two residents beside the same hearth each hear it once — and derive the
  // same emitter, because the seed is the entity's, not the session's.
  const one = await rig("one", [1, 0]);
  const two = await rig("two", [-1, 0]);
  for (const r of [one, two]) { await r.spawn("hearth", [0, 0, 0]); await r.comp("hearth", FIRE); }
  check("two residents each receive exactly one event",
    one.events.length === 1 && two.events.length === 1);
  check("...and the same text about the same fire", one.events[0].text === two.events[0].text);
}
{
  // Nothing about a NON-particles component changed.
  const { events, spawn, other } = await rig();
  await spawn("swing", [1, 0, 0]);
  await other("swing", "sockets", { seat: { pos: [0, 0.5, 0] } }, true);
  check("other component types narrate nothing (scope fence)", events.length === 0);
}

// ---------------------------------------------------------------- C: several emitters, a scaled one
// Upstream #256 gave a v1 thing several emitters (`particles:<name>`). Here a thing carries one `particles`: emitters
// that burn together are one effect document's emitters, and one lit and put out on its own is a child thing with its
// own `particles` (the translator writes particles:<name> that way). Each reads and narrates on its own terms.
{
  const { ag, events, spawn, comp, door } = await rig();
  await spawn("hearth", [2, 0, 0]);
  await comp("hearth", FIRE, false);
  const child = async (id: string, value: unknown, live = true) => {
    const r = await door.act("create", { id, components: { transform: { pos: [0, 0, 0] }, parent: { to: "hearth" }, label: id.split("-")[1], particles: value } }, { who: "antra", at: T0, live });
    if (!r.ok) throw new Error(`create ${id} refused: ${JSON.stringify(r.refused)}`);
  };
  await child("hearth-candle", { effect: "fire", at: [0.4, 0.9, 0], scale: 0.025 }, false);
  const out = ag.look();
  // a thing's handle may be short ([hearth-]); the child is found by the label it was given
  const line = (name: string) => out.split("\n").find((l) => name === "hearth" ? l.includes("[hearth] ") : l.includes(`"${name}"`)) ?? "";
  check("look() reads the hearth's own emitter and its child's, each on its own thing",
    /emitting fire \(particles;/.test(line("hearth")) && /emitting fire \(particles;[^)]*scale 0\.025/.test(line("candle")) && line("candle").includes("mounted on hearth"), `${line("hearth")} | ${line("candle")}`);
  check("...a scaled one says how small, and one at its own size claims no scale",
    line("candle").includes("scale 0.025") && !line("hearth").includes("scale"));

  await child("hearth-sparks", { effect: "sparks" });
  check("lighting a child's emitter is heard once, under its own thing",
    events.length === 1 && events[0].text.includes("lights sparks on [hearth-sparks]"), events.map((e) => e.text).join(" | "));
  await comp("hearth", { ...FIRE, params: { ...FIRE.params, size: 0.6 } });
  check("...while a change to the hearth's own emitter is its own news, not folded into the child's",
    events.length === 2 && events[1].text.includes("retunes the fire on [hearth]"), events.map((e) => e.text).join(" | "));
  await comp("hearth-sparks", { effect: "sparks", params: { count: 30 } });
  check("a burst on one emitter folds inside its own window", events.length === 2, events.map((e) => e.text).join(" | "));
  await sleep(WINDOW + 80);
  check("...and closes with one net line for that emitter",
    events.length === 3 && events[2].text.includes("retunes the sparks on [hearth-sparks]"), events.map((e) => e.text).join(" | "));

  await sleep(WINDOW + 80);   // past the window the net line reopened, so the ending speaks at once
  const gone = await door.act("delete", { id: "hearth-sparks" }, { who: "antra", at: T0, live: true });
  check("removing the child puts its emitter out, heard once under its own thing, the hearth still burning",
    gone.ok && events.length === 4 && events[3].text.includes("puts out the sparks on [hearth-sparks]") && /\[hearth\] [^\n]*emitting fire/.test(ag.look()),
    JSON.stringify(gone.refused ?? events.map((e) => e.text)));

  // the first protocol's keyed spelling is not this protocol's: refused, saying how to write it
  const keyed = await door.act("set", { id: "hearth", component: "particles:smoke", value: { effect: "smoke" } }, { who: "antra", at: T0, live: false });
  check("particles:<name> is refused (particles isn't keyed), naming the spelling it takes",
    !keyed.ok && keyed.refused?.code === "shape" && /isn't keyed; write 'particles'/.test(keyed.refused.reason), JSON.stringify(keyed.refused));
  await sleep(WINDOW + 80);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);   // (the agents keep timers alive: leave explicitly)
