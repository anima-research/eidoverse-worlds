// event-wire-test — the tag set each world event goes out with, held to the
// kind facet (MCPL RFC-001 rev 3): a notice nobody sent carries chat:system
// beside chat:ambient, so a host never puts an agent's plain speech in the
// world because a forecast line arrived there last; speech never does.
//
// Run: bun test/mcpl/event-wire-test.ts

const { eventTags, catchupHeaderTags, catchupReplayTags } = await import("../../mcpl/event-wire.ts");
const { CHAT, EIDO } = await import("../../mcpl/declaration.ts");

let pass = 0, fail = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`); }
}
const has = (t: string[], tag: string) => t.includes(tag);
const show = (t: string[]) => JSON.stringify(t);

// ---------------------------------------------------------------- notices: nobody spoke
for (const [kind, own] of [
  ["weather", EIDO.weather],
  ["world-change", EIDO.worldChange],
  ["arrive", EIDO.presence],
  ["leave", EIDO.presence],
  ["activity", EIDO.activityDigest],
] as const) {
  const t = eventTags(kind);
  check(`${kind} is a chat:system notice`, has(t, CHAT.system), show(t));
  check(`${kind} keeps chat:ambient, so ambient wake rules still match`, has(t, CHAT.ambient), show(t));
  check(`${kind} carries its own tag`, has(t, own), show(t));
  check(`${kind} is not addressed`, !has(t, CHAT.addressed), show(t));
}
check("world-change also names the emitter", has(eventTags("world-change"), EIDO.particles));
// a notice carries no sender facet; the declaration rides as metadata (§6a rule 3)
check("an arrival is the world's notice, with no sender facet",
  !has(eventTags("arrive"), CHAT.fromAgent));

{
  const h = catchupHeaderTags();
  check("the catch-up header is a notice", has(h, CHAT.system) && has(h, CHAT.ambient) && has(h, EIDO.catchup), show(h));
  const r = catchupReplayTags();
  check("a replayed mention keeps its addressing and is NOT a notice",
    has(r, CHAT.mention) && has(r, CHAT.addressed) && has(r, EIDO.catchup) && !has(r, CHAT.system), show(r));
}

// ---------------------------------------------------------------- people: someone did something
{
  const t = eventTags("act");
  check("act is ambient", has(t, CHAT.ambient), show(t));
  check("act is not a notice: someone did it", !has(t, CHAT.system), show(t));
}
{
  const overheard = eventTags("say");
  check("overheard speech is ambient, not a notice", has(overheard, CHAT.ambient) && !has(overheard, CHAT.system), show(overheard));
  const named = eventTags("say", { declares: "agent", mention: true });
  check("speech that names you is addressed, neither ambient nor a notice",
    has(named, CHAT.mention) && has(named, CHAT.addressed) && !has(named, CHAT.ambient) && !has(named, CHAT.system), show(named));
  check("...and says an agent spoke it", has(named, CHAT.fromAgent), show(named));
  check("a declared word other than \"agent\" is no kind", !has(eventTags("say", { declares: "bot" }), CHAT.fromAgent));
}

// ---------------------------------------------------------------- the ground reshaped near a body (mcpl/ground-words.ts)
{
  const { groundChange, groundLine } = await import("../../mcpl/ground-words.ts");
  const t = eventTags("world-change", { part: "ground" });
  check("a world-change that is the ground carries eidoverse:ground beside eidoverse:world-change, and not the emitter's tag",
    has(t, EIDO.worldChange) && has(t, EIDO.ground) && !has(t, EIDO.particles) && has(t, CHAT.ambient) && has(t, CHAT.system) && !has(eventTags("world-change"), EIDO.ground), show(t));
  const level = () => new Array(1024).fill(0);
  const bag = { kind: "noise", seed: 1, amplitude: 0 }, me = { x: 0, z: 0 };
  // tile 128-128 starts at the world's centre: its sample k is at x = 0.5 (k % 32), z = 0.5 floor(k / 32)
  const up = level(); up[12 * 32 + 12] = 500; up[12 * 32 + 13] = 300;   // round (6, 6)
  const v0 = { terrain: bag, terrainFeatures: {}, terrainTiles: {} }, v1 = { ...v0, terrainTiles: { "128-128": up } };
  const c1 = groundChange(v0, v1)!;
  check("a stroke is read as where the ground moved and by how much", JSON.stringify(c1.sculpt) === JSON.stringify({ box: [6, 6, 6.5, 6], up: 500, down: 0 }) && !c1.terrain && !c1.features.length, JSON.stringify(c1));
  check("nothing changed reads as nothing", groundChange(v1, { ...v1 }) === null && groundChange(v0, { ...v0, terrainTiles: {} }) === null);
  const l1 = groundLine("Mica", c1, me, 30);
  check("a raise near a body: who, how far and which way from it, how much, how wide", l1 === "Mica raised the ground 8 m southeast of you by up to 0.50 m, across about 1 m.", String(l1));
  check("…beyond the body's radius it says nothing", groundLine("Mica", c1, me, 5) === null);
  const down = level(); down[0] = -400; down[1] = -200; down[32] = -100;
  const c2 = groundChange(v0, { ...v0, terrainTiles: { "128-128": down } })!;
  check("a lower under the body says under you, and how far its own ground moved", groundLine("Mica", c2, me, 30, -0.4) === "Mica lowered the ground under you by up to 0.40 m, across about 1 m; where you stand it is 0.40 m lower now.", String(groundLine("Mica", c2, me, 30, -0.4)));
  const both = level(); both[12 * 32 + 12] = 300; both[12 * 32 + 14] = -200;
  check("a stroke that raised and lowered is a reshape, both ways said", /^Mica reshaped the ground 8 m southeast of you \(up to 0\.30 m up and 0\.20 m down\), across about 2 m\.$/.test(groundLine("Mica", groundChange(v0, { ...v0, terrainTiles: { "128-128": both } })!, me, 30) ?? ""), String(groundLine("Mica", groundChange(v0, { ...v0, terrainTiles: { "128-128": both } })!, me, 30)));
  const hill = { type: "hill", x: -12, z: 0, radius: 6, height: 2 }, f1 = { ...v0, terrainFeatures: { cove: hill } };
  check("a named feature added: what it is, where, its name and size", groundLine("Sol", groundChange(v0, f1)!, me, 30) === 'Sol added a hill to the ground 12 m west of you: "cove", 6 m in radius, 2 m high.', String(groundLine("Sol", groundChange(v0, f1)!, me, 30)));
  check("…changed, and taken out", groundLine("Sol", groundChange(f1, { ...v0, terrainFeatures: { cove: { ...hill, height: -1 } } })!, me, 30) === 'Sol changed the pit "cove" in the ground, 12 m west of you: now 6 m in radius, 1 m deep.'
    && groundLine("Sol", groundChange(f1, v0)!, me, 30) === 'Sol took the hill "cove" out of the ground, 12 m west of you.', String(groundLine("Sol", groundChange(f1, v0)!, me, 30)));
  check("a feature whose reach ends short of the body's radius says nothing, one that reaches into it speaks", groundLine("Sol", groundChange(v0, { ...v0, terrainFeatures: { far: { ...hill, x: -60 } } })!, me, 30) === null
    && groundLine("Sol", groundChange(v0, { ...v0, terrainFeatures: { far: { ...hill, x: -35 } } })!, me, 30) !== null);
  check("the terrain itself changed, was removed, was made: said wherever the body stands", groundLine("Ann", groundChange(v0, { ...v0, terrain: { ...bag, amplitude: 4 } })!, me, 1, 1.25) === "Ann changed this world's terrain: the whole ground may have moved; where you stand it is 1.25 m higher now."
    && groundLine("Ann", groundChange(v0, { ...v0, terrain: null })!, me, 1) === "Ann removed this world's terrain: the ground is level now."
    && groundLine("Ann", groundChange({ ...v0, terrain: null }, v0)!, me, 1) === "Ann gave this world a terrain: the ground is no longer the level floor.");
  check("ground that moved under the body from a change centred out of its radius is still said", /^Sol reshaped the ground, and where you stand it is 0\.10 m higher now\.$/.test(groundLine("Sol", groundChange(v0, { ...v0, terrainFeatures: { far: { ...hill, x: -60 } } })!, me, 30, 0.1) ?? ""));
}

// ---------------------------------------------------------------- the door uses this table, not its own copy
{
  const door = await Bun.file(new URL("../../mcpl/net-server.ts", import.meta.url)).text();
  check("net-server.ts takes every event's tags from event-wire.ts", /from "\.\/event-wire\.ts"/.test(door)
    && ["eventTags(", "catchupHeaderTags(", "catchupReplayTags("].every((f) => door.includes(f)));
  check("...and builds none inline", !/\btags\(CHAT\.|speechTags\(/.test(door));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
