// bun tools/places-test.ts — named places: walking to them, knowing you are in
// them, and naming new ones after a building exists.
//
// mcpl/places.ts reads a thing's places from two sources: the model's own
// description of itself (a `building` object in its glTF extras — rooms,
// doors, seats, arrivals) and its `places` component, which overrides it
// name by name and which anyone with builder rank can change at any time.
// Here, through the real MCP tools (walk_to {to}, name_place, look), a real
// agent on an isolated sequencer:
//   - reads the model's places, and is told which room it stands in;
//   - walks to a room, a door, a thing's entrance, and a place by label;
//   - names a spot after the fact, walks back to it by name, re-points it
//     with a raw `comp`, and retires a place the model declared;
//   - walks to a person (stopping short of them);
//   - picks the nearest of two same-named places;
//   - finds a place where its thing has been moved to.
process.env.AGENT_BODY_ENGINE = "verlet";
process.env.WORLD_TOKEN = "";
const { FLOOR, UPPER, boxes, building, buildGlb } = await import("./two-storey-fixture.ts");
const P = await import("../mcpl/places.ts");
const { scratchSequencer, mkCheck, sleep, legacyVerb, sceneId } = await import("./harness.ts");
const { tryUntil } = await import("./protocol/wait.ts");
const { check, tally } = mkCheck();

console.log("places.ts (pure):");
{
  const model = P.placesFromModel(building);
  check("a model's rooms, doors and arrivals become places (the outside arrival is its entrance)",
    ["hall", "upstairs", "front_door", "entrance"].every((n) => model.has(n)), [...model.keys()].join(","));
  const merged = P.placesOf(building, { upstairs: null, nook: { at: [1, 0.3, 1], label: "the nook" }, "bad name!": { at: [0, 0, 0] }, junk: { at: [1, 2] } });
  check("the component adds places, retires the model's (null), and ignores malformed entries",
    merged.some((p) => p.name === "nook") && !merged.some((p) => p.name === "upstairs") && !merged.some((p) => p.name === "junk" || p.name === "bad name!"),
    merged.map((p) => p.name).join(","));
  check("places are named by name or label, loosely", P.names(model.get("upstairs")!, "The Upper Room") && P.names(model.get("front_door")!, "front door"));
  const e = { id: "t", pos: [10, 1, -5], yaw: Math.PI / 2, scale: 2 };
  const w = P.toWorld(e, [1, 2, 3]), back = P.toLocal(e, w);
  check("model frame ↔ world round-trips through position, yaw and scale", back.every((v, i) => Math.abs(v - [1, 2, 3][i]) < 1e-9), JSON.stringify(back));
}

console.log("a model's own places survive the server's compressed copy:");
{
  const { optimizeGlb } = await import("../server/optimize.ts");
  const { collisionTriangles } = await import("../server/geometry.ts");
  const src = await buildGlb(boxes, { building });
  const opt = await optimizeGlb(src);
  const viaOpt = (await collisionTriangles(opt))?.building;
  check("the optimized (draco) copy still carries the building description", JSON.stringify(viaOpt) === JSON.stringify(building),
    `${JSON.stringify(viaOpt)?.slice(0, 120)} (${src.length} → ${opt.length} bytes)`);
}

const h = await scratchSequencer("places", { serverEnv: { SKIP_OPT_SWEEP: "1", TRUST_NAMES: "1" }, worlds: ["places"], owner: "member", portFrom: 9500 });
const { WorldAgent } = await import("../mcpl/agent.ts");
const { handleTool } = await import("../mcpl/tools.ts");
const URL_ = h.BASE.replace("http", "ws") + "/ws";
const a: any = new WorldAgent({ name: "member", world: "places", url: URL_ });
const friend: any = new WorldAgent({ name: "friend", world: "places", url: URL_ });
const ctx = { agent: a, canPush: () => false, heldActivity: [], cursor: { caughtUpTo: null } };
// what walk_to {x, y?, z, to?} meant, as move's words (the old name runs nothing now, R 10-28)
const walkWords = (a: any) => ({ to: a.to !== undefined ? a.to : a.y != null ? [a.x, a.y, a.z] : [a.x, a.z], ...(a.run !== undefined ? { run: a.run } : {}), ...(a.tolerance !== undefined ? { tolerance: a.tolerance } : {}) });
const tool = async (name: string, args: Record<string, any>) => {
  const r: any = await handleTool(ctx as any, name, args);
  return (r.content ?? []).map((c: any) => c.text ?? "").join("\n");
};
const near = (v: number, want: number, tol = 0.05) => Math.abs(v - want) <= tol;
const at = () => `(${a.pos.x.toFixed(2)}, ${a.pos.y.toFixed(2)}, ${a.pos.z.toFixed(2)})`;
try {
  await a.connect(); await friend.connect();
  // the protocol: a founded world has bounds (±20 m); this test walks to x 50
  await a.request("set", { id: "@world", component: "bounds", value: { min: [-100, -20, -100], max: [100, 60, 100] } });
  const upload = async (name: string, glb: Uint8Array) =>
    ((await (await fetch(`${h.BASE}/upload?name=${name}`, { method: "POST", body: glb })).json()) as { path: string }).path;
  const lib = await upload("tower", await buildGlb(boxes, { building }));
  const gy = a.heightAt(0, 0);
  await legacyVerb(a, "spawn", { id: "tower", lib, pos: [0, gy, 0], yaw: 0 });
  // a second, identical tower 30m east, for "the nearest of two"
  await legacyVerb(a, "spawn", { id: "tower2", lib, pos: [30, a.heightAt(30, 0), 0], yaw: 0 });
  await tryUntil("the towers' supports are registered", () => a.supportIds?.get("tower") && a.supportIds?.get("tower2"), { ms: 5000, step: 50 });
  await a.supportReady(); await sleep(300);

  await a.walkTo(0, 7, true);
  const seen = await tool("look", {});
  // protocol merge (owner 22:40/22:43): look lists the places this body can SEE (line of sight, ≤ 30 m, nearest 12, with
  // distance and floor), each from the model's own description; move {to: "?"} lists every one, seen or not
  const sightLine = seen.split("\n").find((l) => l.startsWith("Places you can see")) ?? "(no places line)";
  check("look lists the places in sight, from the model's own description, with distance and floor",
    /tower\/entrance \(\d+\.\d m, floor -?\d+\.\d\d m\)/.test(sightLine), sightLine);
  check("...but not a room behind walls (the upper room is out of sight from the front lawn)", !/tower\/upstairs/.test(sightLine), sightLine);
  const all = await tool("move", { to: "?" });
  check("move {to: \"?\"} lists every named place, seen or not, and moves nothing",
    /tower\/upstairs "the upper room"/.test(all) && /tower\/hall "the hall"/.test(all) && /tower\/front_door/.test(all) && near(a.pos.z, 7, 0.05), all);
  check("...move's to: \"?\" too (walk_to's words)", /tower\/upstairs/.test(await tool("move", walkWords({ to: "?" }))));

  let r = await tool("move", walkWords({ to: "tower", run: true }));
  check("walk_to a thing goes to its entrance", /arrived at tower\/entrance/.test(r) && near(a.pos.z, 5, 0.6), `${r} ${at()}`);
  r = await tool("move", walkWords({ to: "tower/upstairs", run: true }));
  check("walk_to thing/room reaches the room, on its own floor — up the stair",
    /arrived at tower\/upstairs/.test(r) && near(a.pos.y, gy + UPPER) && a.pos.x < 1.55, `${r} ${at()}`);
  const look1 = await tool("look", {});
  check("...and look says which room the body is in", /You are in the upper room \(tower\/upstairs\)/.test(look1),
    look1.split("\n").find((l) => l.startsWith("You are in")) ?? "(no 'You are in' line)");
  r = await tool("move", walkWords({ to: "the hall", run: true }));
  check("a place's label alone works (the nearest thing that has it)", /arrived at tower\/hall/.test(r) && near(a.pos.y, gy + FLOOR) && Math.abs(a.pos.x) < 3, `${r} ${at()}`);
  r = await tool("move", walkWords({ to: "front door", run: true }));
  check("doors are places too", /arrived at tower\/front_door/.test(r) && near(a.pos.z, 2.9, 0.7), `${r} ${at()}`);

  // move {to: [x, y, z]}: y picks the floor (#236; owner 22:40), and a y no floor matches says which it chose
  r = await tool("move", { to: [-1.5, gy + UPPER, -1.5], run: true });
  check("move [x, upper floor y, z] arrives upstairs", /arrived/.test(r) && near(a.pos.y, gy + UPPER), `${r} ${at()}`);
  r = await tool("move", { to: [-1.5, gy, -1.2], run: true });
  check("move [x, 0, z] goes down to the ground floor (0.3 m up: within a step of 0)", /arrived/.test(r) && near(a.pos.y, gy + FLOOR), `${r} ${at()}`);
  r = await tool("move", { to: [-1.5, -1.5], run: true });
  check("move [x, z] stays on the floor it can reach on its own storey", /arrived/.test(r) && near(a.pos.y, gy + FLOOR), `${r} ${at()}`);
  r = await tool("move", { to: [-1.5, gy + 10, -1.2], run: true });
  check("move [x, 10, z] arrives on the nearest floor and the reply names it", near(a.pos.y, gy + UPPER) && /no floor at .* you're on the floor at/.test(r), `${r} ${at()}`);
  r = await tool("move", { to: [-1.5, gy - 5, -1.5], run: true });
  check("move [x, under every floor, z] arrives on the nearest floor there, and says so", near(a.pos.y, gy + FLOOR) && /no floor at .* you're on the floor at/.test(r), `${r} ${at()}`);
  r = await tool("move", walkWords({ x: -1.5, y: gy + UPPER, z: -1.2, run: true }));
  check("move {to: [x, y, z]} (walk_to's {x, y, z}): y picks the floor the same way", /arrived/.test(r) && near(a.pos.y, gy + UPPER), `${r} ${at()}`);
  r = await tool("move", { to: "tower/hall", run: true });
  check("move {to: \"thing/place\"} directly (the rows above send walk_to's words)", /arrived at tower\/hall/.test(r) && near(a.pos.y, gy + FLOOR), `${r} ${at()}`);

  // naming a spot after the building exists — standing on the stair landing
  await tool("move", walkWords({ x: 2.2, z: -2.3, y: gy + UPPER, run: true }));
  r = await tool("name_place", { name: "landing", label: "the top of the stair" });
  check("name_place names the spot where the body stands, on the thing it is in", /named this spot "landing" on \[tower\]/.test(r), r);
  await sleep(300);
  check("...as an entry in that thing's places component, in its own frame",
    Array.isArray(a.entities.get(sceneId(a, "tower"))?.places?.landing?.at) && near(a.entities.get(sceneId(a, "tower")).places.landing.at[1], UPPER, 0.06),
    JSON.stringify(a.entities.get(sceneId(a, "tower"))?.places));   // "tower" is its label: the authority minted its id (R 10-17)
  await tool("move", walkWords({ to: "entrance", run: true }));
  r = await tool("move", walkWords({ to: "the top of the stair", run: true }));
  check("...and walk_to reaches it by its label, from outside, up the stair", /arrived at tower\/landing/.test(r) && near(a.pos.y, gy + UPPER) && near(a.pos.x, 2.2, 0.15), `${r} ${at()}`);

  // a raw comp edit: re-point the name, retire a model place
  const cur = { ...a.entities.get(sceneId(a, "tower")).places, landing: { at: [-2, FLOOR, -2], label: "the corner" }, upstairs: null };
  await legacyVerb(a, "comp", { id: "tower", type: "places", data: cur });
  await sleep(400);
  r = await tool("move", walkWords({ to: "tower/landing", run: true }));
  check("a builder can re-point a name with a plain comp — the walk follows", /arrived at tower\/landing/.test(r) && near(a.pos.y, gy + FLOOR) && near(a.pos.x, -2, 0.2), `${r} ${at()}`);
  r = await tool("move", walkWords({ to: "tower/upstairs" }));
  check("a place the model declared can be retired (null)", /has no place called "upstairs"/.test(r), r);
  r = await tool("name_place", { name: "upstairs", remove: true, on: "tower" });
  check("name_place remove on a model place keeps it hidden", /retired "upstairs"/.test(r) && a.entities.get(sceneId(a, "tower")).places.upstairs === null, r);

  // a footstool a step above a named spot on the floor is not that spot
  const stool = await upload("stool", await buildGlb([[-0.25, 0, -0.2, 0.25, 0.32, 0.2]]));
  await legacyVerb(a, "spawn", { id: "stool", lib: stool, pos: [-1.5, gy + FLOOR, 1.0], yaw: 0, collide: "box" });
  await legacyVerb(a, "comp", { id: "tower", type: "places", data: { ...a.entities.get(sceneId(a, "tower")).places, by_stool: { at: [-1.0, FLOOR, 1.0] } } });
  await tryUntil("the stool's support is registered", () => a.supportIds?.get("stool"), { ms: 2000, step: 50 });
  await a.supportReady(); await sleep(400);
  await tool("move", walkWords({ to: "tower/entrance", run: true }));
  r = await tool("move", walkWords({ to: "tower/by_stool", run: true }));
  check("a named spot on the floor is reached on the floor, not on the footstool beside it",
    /arrived at tower\/by_stool/.test(r) && near(a.pos.y, gy + FLOOR), `${r} ${at()}`);

  // a person
  await friend.walkTo(-1.5, -1.5, true);
  r = await tool("move", walkWords({ to: "friend", run: true }));
  const d = Math.hypot(a.pos.x - friend.pos.x, a.pos.z - friend.pos.z);
  check("walk_to a person stops short of them, beside them", /arrived at friend/.test(r) && d > 0.5 && d < 1.3, `${r} — ${d.toFixed(2)}m apart`);

  // review r3 F4: a person whose name is a thing's doesn't capture the walk — things and places come first
  {
    const squatter: any = new WorldAgent({ name: "Tower", world: "places", url: URL_ });
    try {
      await squatter.connect();
      await squatter.walkTo(-15, -15, true);
      await tryUntil("a visitor named Tower is here", () => [...a.people.keys()].some((k: string) => k.toLowerCase() === "tower"), { ms: 2000, step: 50 });
      check("(a visitor named \"Tower\" is here)", [...a.people.keys()].some((k: string) => k.toLowerCase() === "tower"), [...a.people.keys()].join(","));
      r = await tool("move", walkWords({ to: "tower", run: true }));
      check("move {to: \"tower\"} goes to the tower's entrance, not to the person called Tower", /arrived at tower\/entrance/.test(r), `${r} ${at()}`);
    } finally { try { squatter.close(); } catch { /* gone */ } }
  }
  // review r4 claims C1: nor does a person whose name is a thing's LABEL (a display name, not its id)
  {
    await a.request("set", { id: sceneId(a, "tower2"), component: "label", value: "Belfry" });
    await tryUntil("tower2 is relabelled Belfry", () => a.entities.get(sceneId(a, "tower2"))?.label === "Belfry", { ms: 2000, step: 50 });
    const squatter: any = new WorldAgent({ name: "Belfry", world: "places", url: URL_ });
    try {
      await squatter.connect();
      await squatter.walkTo(-15, -15, true);
      await tryUntil("a visitor named Belfry is here", () => [...a.people.keys()].some((k: string) => k.toLowerCase() === "belfry"), { ms: 2000, step: 50 });
      check("(tower2 is labelled \"Belfry\", and a visitor named \"Belfry\" is here)", a.entities.get(sceneId(a, "tower2"))?.label === "Belfry" && [...a.people.keys()].some((k: string) => k.toLowerCase() === "belfry"), [...a.people.keys()].join(","));
      r = await tool("move", { to: "belfry", run: true });
      check("move {to: \"belfry\"} goes to the thing labelled Belfry (its entrance), not to the person called Belfry", /arrived at Belfry\/entrance/.test(r), `${r} ${at()}`);   // a thing is read by its label (R 10-17)
    } finally { try { squatter.close(); } catch { /* gone */ } }
  }

  // the nearest of two
  await tool("move", walkWords({ x: 30, z: 7, run: true }));
  r = await tool("move", walkWords({ to: "the hall", run: true }));
  check("with two things offering the same place, the nearest is taken", /arrived at Belfry\/hall/.test(r) && a.pos.x > 25, `${r} ${at()}`);

  // moved things take their places with them
  await legacyVerb(a, "place", { id: "tower2", pos: [30, a.heightAt(30, -20), -20], yaw: Math.PI / 2 });
  await tryUntil("tower2 has moved to z = -20", () => a.entities.get(sceneId(a, "tower2"))?.pos?.[2] === -20, { ms: 2000, step: 50 });
  await a.supportReady(); await sleep(400);
  r = await tool("move", walkWords({ to: "Belfry/entrance", run: true }));   // tower2 is labelled Belfry since the C1 rows
  // entrance [0,0,5] in the model frame, turned a quarter and moved to (30, -20)
  const want = P.toWorld({ id: "tower2", pos: [30, 0, -20], yaw: Math.PI / 2 }, [0, 0, 5]);
  check("a thing that is moved and turned takes its places with it", /arrived at Belfry\/entrance/.test(r) && Math.hypot(a.pos.x - want[0], a.pos.z - want[2]) < 0.6, `${r} ${at()} want (${want[0].toFixed(2)}, ${want[2].toFixed(2)})`);

  // a long room whose middle is full: reached at the clear floor it has
  const ry = a.heightAt(50, -20);
  // protocol merge: the furniture in its middle is 2.2 m tall (it was 1 m), so the model is tall enough for the authority to
  // measure its solid parts (server/solids.ts: under 2 m a model's one box is solid, and a body on the floor at 0.05 m
  // would be inside it); the room's floor and its furnished middle are the same as before
  const rug = await upload("rug", await buildGlb([[-6, 0, -1.5, 6, 0.05, 1.5], [-1.5, 0.05, -1.5, 1.5, 2.2, 1.5]]));
  await legacyVerb(a, "spawn", { id: "rug", lib: rug, pos: [50, ry, -20], yaw: 0, collide: "exact" });
  await legacyVerb(a, "comp", { id: "rug", type: "places", data: {
    long_room: { min: [-6, 0.05, -1.5], max: [6, 3, 1.5], label: "the long room" },
    loft: { min: [-6, 3, -1.5], max: [6, 5, 1.5] } } });
  const perchY = a.heightAt(50, -12);
  await legacyVerb(a, "spawn", { id: "perch", lib: stool, pos: [50, perchY, -12], yaw: 0, scale: 4, collide: "box" });
  const kr = await legacyVerb(a, "comp", { id: "perch", type: "places", data: { seat: { at: [0, 0.32, 0], kind: "seat" } } });
  check("a place's kind is gone: an entry with one is refused (shape audit 10-16: a seat is a station)", kr?.refused?.code === "schema", JSON.stringify(kr?.refused ?? kr));
  await legacyVerb(a, "comp", { id: "perch", type: "places", data: { seat: { at: [0, 0.32, 0] } } });
  await tryUntil("the rug's and perch's supports are registered", () => a.supportIds?.get("rug") && a.supportIds?.get("perch"), { ms: 3000, step: 50 });
  await a.supportReady(); await sleep(400);
  r = await tool("move", walkWords({ to: "the long room", run: true }));
  check("a room whose middle is furnished is reached at its clear floor, toward an end",
    /arrived at rug\/long_room/.test(r) && near(a.pos.y, ry + 0.05) && Math.abs(a.pos.x - 50) > 1.5 && Math.abs(a.pos.x - 50) < 6, `${r} ${at()}`);
  r = await tool("move", walkWords({ to: "rug/loft" }));
  check("a room whose floor is not there is refused — not the floor beneath it", /nowhere to stand anywhere in it on its floor.*no floor there/.test(r) && !/arrived/.test(r), r);
  // retired (shape audit 10-16): "a seat on a thing scaled 4× is reached on the floor beside it" read the place's kind:
  // 'seat'. A component place has no kind now (a seat is a station on a socket; the agent sits by attach), so the stool's
  // place is a point like any other. A seat a MODEL declares (glTF extras `building`) still reads as one (placesFromModel).

  // name_place's coordinates: x and z, y found; never silently dropped
  r = await tool("name_place", { name: "rug_end", x: 55, z: -20, on: "rug" });
  check("name_place with x and z only names the floor there", /named this spot "rug_end" on \[rug\]/.test(r)
    && near(a.entities.get(sceneId(a, "rug"))?.places?.rug_end?.at?.[1], 0.05) && near(a.entities.get(sceneId(a, "rug")).places.rug_end.at[0], 5), `${r} ${JSON.stringify(a.entities.get(sceneId(a, "rug"))?.places?.rug_end)}`);
  r = await tool("name_place", { name: "nowhere", y: 2 });
  check("...and with y alone is refused, not quietly named where the body stands", /need x and z/.test(r) && !a.entities.get(sceneId(a, "rug")).places.nowhere, r);
  await legacyVerb(a, "light", { id: "lamp", pos: [50, ry + 2, -20], intensity: 5 });
  await tryUntil("the agent holds the lamp", () => a.entities.get(sceneId(a, "lamp")), { ms: 2000, step: 50 });
  r = await tool("name_place", { name: "glow", on: "lamp" });
  // a thing with no model still has a frame (its transform), so a light holds a place as a model does
  await tryUntil("the lamp has its glow place", () => a.entities.get(sceneId(a, "lamp"))?.places?.glow, { ms: 2000, step: 50 });
  check("a light carries places too — named in its frame, and saved", /named this spot "glow" on \[lamp\]/.test(r) && !!a.entities.get(sceneId(a, "lamp"))?.places?.glow, r);
  // decision table row 13: main's 8 KB places guard is the authority's general value cap now (gate.js: values under 64 KiB)
  { const lamp = sceneId(a, "lamp"), glow = a.entities.get(lamp).places.glow, bag: Record<string, unknown> = { glow };
    for (let i = 0; JSON.stringify(bag).length < 65_500; i++) bag[`p_${i}`] = { at: [i % 7, 0, 0] };
    const filled = await a.request("set", { id: lamp, component: "places", value: bag });
    await tryUntil("the lamp holds the full bag", () => Object.keys(a.entities.get(lamp)?.places ?? {}).length === Object.keys(bag).length, { ms: 3000, step: 50 });
    r = await tool("name_place", { name: "one_more", on: "lamp" });
    check("a name that takes the places bag past 64 KiB is refused by the general value cap, and nothing is named",
      filled?.ok && /not named — the world refused: .*keeps values under 64 KiB/.test(r) && !("one_more" in a.entities.get(lamp).places), `${JSON.stringify(filled).slice(0, 200)} | ${r.slice(0, 300)}`);
    await a.request("set", { id: lamp, component: "places", value: { glow } });
    await tryUntil("the lamp's bag is back to its glow", () => Object.keys(a.entities.get(lamp)?.places ?? {}).length === 1, { ms: 3000, step: 50 }); }
  // two names in a row, before the first echo: both land
  const [r1, r2] = await Promise.all([
    tool("name_place", { name: "west_end", x: 45, z: -20, on: "rug" }),
    tool("name_place", { name: "east_end", x: 55.5, z: -20, on: "rug" })]);
  const pl = a.entities.get(sceneId(a, "rug")).places;
  check("two name_place calls at once both land — the second does not erase the first",
    /named/.test(r1) && /named/.test(r2) && pl.west_end && pl.east_end && pl.rug_end && pl.long_room, `${r1} | ${r2} | ${Object.keys(pl).join(",")}`);

  // review r3 F5: a remove built from a stale replica does not erase a name written in between
  {
    const orig = a.sendOps.bind(a);
    let once = true;
    a.sendOps = async (ops: any[], extra: any = {}) => {
      if (once) {   // another writer lands a name after this replica was read and before the remove is sent
        once = false;
        await a.request("set", { id: sceneId(a, "rug"), component: "places", value: { late: { at: [2, 0.05, 0] } }, merge: true });
      }
      return orig(ops, extra);
    };
    try { r = await tool("name_place", { name: "rug_end", remove: true, on: "rug" }); } finally { a.sendOps = orig; }
    await sleep(300);
    const pl2 = a.entities.get(sceneId(a, "rug")).places;
    check("name_place remove, raced by another write: the name written in between survives, and the remove still lands",
      /retired "rug_end"/.test(r) && !!pl2.late && pl2.rug_end === null, `${r} | ${JSON.stringify(pl2)}`);
  }

  // review r3 F7: "?" on a built-up world is capped, nearest first, and "?<text>" narrows it
  {
    const many: Record<string, unknown> = {};
    for (let i = 0; i < 230; i++) many[`stall_${i}`] = { at: [-90 - (i % 10), 0, -90 - Math.floor(i / 10)] };
    const wr: any = await a.request("set", { id: "@world", component: "places", value: many });
    await tryUntil("the agent sees at least 230 places", () => a.worldPlaces().length >= 230, { ms: 3000, step: 50 });
    check("(230 places on @world)", wr?.ok !== false && a.worldPlaces().length === 230, `${JSON.stringify(wr).slice(0, 200)} ${a.worldPlaces().length}`);
    const listed = await tool("move", { to: "?" });
    const lines = listed.split("\n").filter((l) => /^  \S/.test(l));
    check("move {to: \"?\"} lists at most 200, nearest first, and says how many more and how to narrow",
      lines.length === 200 && /tower2?\/|rug\/|perch\/|lamp\//.test(lines[0]) && /and \d+ more/.test(listed) && /\?<text>|"\?stall/.test(listed), `${lines.length} lines; ${listed.split("\n").slice(-2).join(" | ")}`);
    const narrowed = await tool("move", { to: "?stall_22" });
    const nl = narrowed.split("\n").filter((l) => /^  \S/.test(l));
    check("move {to: \"?stall_22\"} lists only the places whose name holds that text",
      nl.length === 11 && nl.every((l) => /stall_22/.test(l)), narrowed.slice(0, 300));
    check("...and a narrowing that matches nothing says so", /no named places .*"zzz"/.test(await tool("move", { to: "?zzz" })));
    await a.request("delete", { id: "@world", component: "places" });
    await tryUntil("the agent's places are gone", () => !(a.worldPlaces().length), { ms: 3000, step: 50 });
  }

  console.log("move {to: <a thing with no entrance>} (review r5 F3: one resolver, things before people, the nearest):");
  {
    const { HANDLERS } = await import("../mcpl/tools.ts");
    const mk = (ents: any[], people: any[]) => {
      const ag: any = new WorldAgent({ url: "ws://127.0.0.1:1/ws", name: "P", world: "w", avatar: "" });
      for (const e of ents) ag.entities.set(e.id, e);
      for (const p of people) ag.people.set(p.id, p);
      ag.pos = { x: 0, y: 0, z: 0 };
      let went: number[] | null = null;
      ag.walkTo = async (x: number, z: number) => { went = [x, z]; ag.pos = { x, y: 0, z }; return true; };
      return { ag, went: () => went };
    };
    const txt = (r: any) => (r.content ?? []).map((c: any) => c.text ?? "").join("\n");
    {
      const { ag, went } = mk([{ id: "tower", pos: [10, 0, 0] }], [{ id: "TOWER", pose: { p: [-20, 0, 0] } }]);
      const r = txt(await HANDLERS.move(ag, { to: "TOWER" }, {}, "move")), w = went();
      check("a thing \"tower\" with no entrance and a person \"TOWER\": move {to: \"TOWER\"} walks up to the thing, not the person",
        !!w && w[0] > 8 && w[0] < 10 && Math.abs(w[1]) < 1e-6, `walked to ${JSON.stringify(w)} | ${r}`);
      try { ag.close(); } catch { /* never joined */ }
    }
    {
      const { ag, went } = mk([{ id: "far", pos: [50, 0, 0], label: "Belfry" }, { id: "nearb", pos: [3, 0, 0], label: "Belfry" }], []);
      const r = txt(await HANDLERS.move(ag, { to: "belfry" }, {}, "move")), w = went();
      // R 10-17 (ID HARDENING 5, binding): a label two things share is refused with the candidates, never resolved to one
      check("two things labelled \"Belfry\": move {to: \"belfry\"} is refused with both candidates (label, what, where, handle), and the body stays",
        !w && /is the label of 2 things/.test(r) && /\[far\]/.test(r) && /\[nearb\]/.test(r) && /\(50\.0, 0\.0, 0\.0\)/.test(r), `walked to ${JSON.stringify(w)} | ${r}`);
      const r2 = txt(await HANDLERS.move(ag, { to: "nearb" }, {}, "move")), w2 = went();
      check("...and the handle the refusal named walks there", !!w2 && w2[0] > 1 && w2[0] < 3, `walked to ${JSON.stringify(w2)} | ${r2}`);
      try { ag.close(); } catch { /* never joined */ }
    }
  }

  r = await tool("move", walkWords({ to: "the moon" }));
  check("an unknown name is refused, listing the names that exist", /nothing here is called "the moon" — named places: .*tower\/hall/.test(r), r);
} finally {
  try { a.close(); friend.close(); } catch { /* gone */ }
  await h.cleanup(tally.failed || process.exitCode ? 1 : 0);
}
console.log(`${tally.passed} passed, ${tally.failed} failed`);
process.exit(tally.failed ? 1 : 0);
