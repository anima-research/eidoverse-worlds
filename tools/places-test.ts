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
const { scratchSequencer, mkCheck, sleep } = await import("./harness.ts");
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

const h = await scratchSequencer("places", { serverEnv: { SKIP_OPT_SWEEP: "1" }, portFrom: 9500 });
const { WorldAgent } = await import("../mcpl/agent.ts");
const { handleTool } = await import("../mcpl/tools.ts");
const URL_ = h.BASE.replace("http", "ws") + "/ws";
const a: any = new WorldAgent({ name: "visitor", world: "places", url: URL_ });
const friend: any = new WorldAgent({ name: "friend", world: "places", url: URL_ });
const ctx = { agent: a, canPush: () => false, heldActivity: [], cursor: { caughtUpTo: null } };
const tool = async (name: string, args: Record<string, any>) => {
  const r: any = await handleTool(ctx as any, name, args);
  return (r.content ?? []).map((c: any) => c.text ?? "").join("\n");
};
const near = (v: number, want: number, tol = 0.05) => Math.abs(v - want) <= tol;
const at = () => `(${a.pos.x.toFixed(2)}, ${a.pos.y.toFixed(2)}, ${a.pos.z.toFixed(2)})`;
try {
  await a.connect(); await friend.connect();
  const upload = async (name: string, glb: Uint8Array) =>
    ((await (await fetch(`${h.BASE}/upload?name=${name}`, { method: "POST", body: glb })).json()) as { path: string }).path;
  const lib = await upload("tower", await buildGlb(boxes, { building }));
  const gy = a.heightAt(0, 0);
  a.verb("spawn", { id: "tower", lib, pos: [0, gy, 0], yaw: 0 });
  // a second, identical tower 30m east, for "the nearest of two"
  a.verb("spawn", { id: "tower2", lib, pos: [30, a.heightAt(30, 0), 0], yaw: 0 });
  for (let i = 0; i < 100 && !(a.supportIds?.get("tower") && a.supportIds?.get("tower2")); i++) await sleep(50);
  await a.supportReady(); await sleep(300);

  await a.walkTo(0, 7, true);
  const seen = await tool("look", {});
  check("look lists a thing's places, from its model's own description",
    /\[tower\].*places \(walk_to \{to: "tower\/<place>"\}\): .*hall "the hall".*upstairs "the upper room".*front_door.*entrance/.test(seen.replace(/\n/g, " ")),
    seen.split("\n").find((l) => l.includes("[tower]")) ?? "(no tower line)");

  let r = await tool("walk_to", { to: "tower", run: true });
  check("walk_to a thing goes to its entrance", /arrived at tower\/entrance/.test(r) && near(a.pos.z, 5, 0.6), `${r} ${at()}`);
  r = await tool("walk_to", { to: "tower/upstairs", run: true });
  check("walk_to thing/room reaches the room, on its own floor — up the stair",
    /arrived at tower\/upstairs/.test(r) && near(a.pos.y, gy + UPPER) && a.pos.x < 1.55, `${r} ${at()}`);
  const look1 = await tool("look", {});
  check("...and look says which room the body is in", /You are in the upper room \(tower\/upstairs\)/.test(look1),
    look1.split("\n").find((l) => l.startsWith("You are in")) ?? "(no 'You are in' line)");
  r = await tool("walk_to", { to: "the hall", run: true });
  check("a place's label alone works (the nearest thing that has it)", /arrived at tower\/hall/.test(r) && near(a.pos.y, gy + FLOOR) && Math.abs(a.pos.x) < 3, `${r} ${at()}`);
  r = await tool("walk_to", { to: "front door", run: true });
  check("doors are places too", /arrived at tower\/front_door/.test(r) && near(a.pos.z, 2.9, 0.7), `${r} ${at()}`);

  // naming a spot after the building exists — standing on the stair landing
  await tool("walk_to", { x: 2.2, z: -2.3, y: gy + UPPER, run: true });
  r = await tool("name_place", { name: "landing", label: "the top of the stair" });
  check("name_place names the spot where the body stands, on the thing it is in", /named this spot "landing" on \[tower\]/.test(r), r);
  await sleep(300);
  check("...as an entry in that thing's places component, in its own frame",
    Array.isArray(a.entities.get("tower")?.comp?.places?.landing?.at) && near(a.entities.get("tower").comp.places.landing.at[1], UPPER, 0.06),
    JSON.stringify(a.entities.get("tower")?.comp?.places));
  await tool("walk_to", { to: "entrance", run: true });
  r = await tool("walk_to", { to: "the top of the stair", run: true });
  check("...and walk_to reaches it by its label, from outside, up the stair", /arrived at tower\/landing/.test(r) && near(a.pos.y, gy + UPPER) && near(a.pos.x, 2.2, 0.15), `${r} ${at()}`);

  // a raw comp edit: re-point the name, retire a model place
  const cur = { ...a.entities.get("tower").comp.places, landing: { at: [-2, FLOOR, -2], label: "the corner" }, upstairs: null };
  a.verb("comp", { id: "tower", type: "places", data: cur });
  await sleep(400);
  r = await tool("walk_to", { to: "tower/landing", run: true });
  check("a builder can re-point a name with a plain comp — the walk follows", /arrived at tower\/landing/.test(r) && near(a.pos.y, gy + FLOOR) && near(a.pos.x, -2, 0.2), `${r} ${at()}`);
  r = await tool("walk_to", { to: "tower/upstairs" });
  check("a place the model declared can be retired (null)", /has no place called "upstairs"/.test(r), r);
  r = await tool("name_place", { name: "upstairs", remove: true, on: "tower" });
  check("name_place remove on a model place keeps it hidden", /retired "upstairs"/.test(r) && a.entities.get("tower").comp.places.upstairs === null, r);

  // a footstool a step above a named spot on the floor is not that spot
  const stool = await upload("stool", await buildGlb([[-0.25, 0, -0.2, 0.25, 0.32, 0.2]]));
  a.verb("spawn", { id: "stool", lib: stool, pos: [-1.5, gy + FLOOR, 1.0], yaw: 0, collide: "box" });
  a.verb("comp", { id: "tower", type: "places", data: { ...a.entities.get("tower").comp.places, by_stool: { at: [-1.0, FLOOR, 1.0] } } });
  for (let i = 0; i < 40 && !a.supportIds?.get("stool"); i++) await sleep(50);
  await a.supportReady(); await sleep(400);
  await tool("walk_to", { to: "tower/entrance", run: true });
  r = await tool("walk_to", { to: "tower/by_stool", run: true });
  check("a named spot on the floor is reached on the floor, not on the footstool beside it",
    /arrived at tower\/by_stool/.test(r) && near(a.pos.y, gy + FLOOR), `${r} ${at()}`);

  // a person
  await friend.walkTo(-1.5, -1.5, true);
  r = await tool("walk_to", { to: "friend", run: true });
  const d = Math.hypot(a.pos.x - friend.pos.x, a.pos.z - friend.pos.z);
  check("walk_to a person stops short of them, beside them", /arrived at friend/.test(r) && d > 0.5 && d < 1.3, `${r} — ${d.toFixed(2)}m apart`);

  // the nearest of two
  await tool("walk_to", { x: 30, z: 7, run: true });
  r = await tool("walk_to", { to: "the hall", run: true });
  check("with two things offering the same place, the nearest is taken", /arrived at tower2\/hall/.test(r) && a.pos.x > 25, `${r} ${at()}`);

  // moved things take their places with them
  a.verb("place", { id: "tower2", pos: [30, a.heightAt(30, -20), -20], yaw: Math.PI / 2 });
  for (let i = 0; i < 40 && a.entities.get("tower2")?.pos?.[2] !== -20; i++) await sleep(50);
  await a.supportReady(); await sleep(400);
  r = await tool("walk_to", { to: "tower2/entrance", run: true });
  // entrance [0,0,5] in the model frame, turned a quarter and moved to (30, -20)
  const want = P.toWorld({ id: "tower2", pos: [30, 0, -20], yaw: Math.PI / 2 }, [0, 0, 5]);
  check("a thing that is moved and turned takes its places with it", /arrived at tower2\/entrance/.test(r) && Math.hypot(a.pos.x - want[0], a.pos.z - want[2]) < 0.6, `${r} ${at()} want (${want[0].toFixed(2)}, ${want[2].toFixed(2)})`);

  // a long room whose middle is full: reached at the clear floor it has
  const ry = a.heightAt(50, -20);
  const rug = await upload("rug", await buildGlb([[-6, 0, -1.5, 6, 0.05, 1.5], [-1.5, 0.05, -1.5, 1.5, 1.05, 1.5]]));
  a.verb("spawn", { id: "rug", lib: rug, pos: [50, ry, -20], yaw: 0, collide: "exact" });
  a.verb("comp", { id: "rug", type: "places", data: {
    long_room: { min: [-6, 0.05, -1.5], max: [6, 3, 1.5], label: "the long room" },
    loft: { min: [-6, 3, -1.5], max: [6, 5, 1.5] } } });
  const perchY = a.heightAt(50, -12);
  a.verb("spawn", { id: "perch", lib: stool, pos: [50, perchY, -12], yaw: 0, scale: 4, collide: "box" });
  a.verb("comp", { id: "perch", type: "places", data: { seat: { at: [0, 0.32, 0], kind: "seat" } } });
  for (let i = 0; i < 60 && !(a.supportIds?.get("rug") && a.supportIds?.get("perch")); i++) await sleep(50);
  await a.supportReady(); await sleep(400);
  r = await tool("walk_to", { to: "the long room", run: true });
  check("a room whose middle is furnished is reached at its clear floor, toward an end",
    /arrived at rug\/long_room/.test(r) && near(a.pos.y, ry + 0.05) && Math.abs(a.pos.x - 50) > 1.5 && Math.abs(a.pos.x - 50) < 6, `${r} ${at()}`);
  r = await tool("walk_to", { to: "rug/loft" });
  check("a room whose floor is not there is refused — not the floor beneath it", /nowhere to stand anywhere in it on its floor.*no floor there/.test(r) && !/arrived/.test(r), r);
  r = await tool("walk_to", { to: "perch/seat", run: true });
  check("a seat on a thing scaled 4× is reached on the floor beside it", /arrived at perch\/seat/.test(r) && near(a.pos.y, perchY, 0.1), `${r} ${at()}`);

  // name_place's coordinates: x and z, y found; never silently dropped
  r = await tool("name_place", { name: "rug_end", x: 55, z: -20, on: "rug" });
  check("name_place with x and z only names the floor there", /named this spot "rug_end" on \[rug\]/.test(r)
    && near(a.entities.get("rug")?.comp?.places?.rug_end?.at?.[1], 0.05) && near(a.entities.get("rug").comp.places.rug_end.at[0], 5), `${r} ${JSON.stringify(a.entities.get("rug")?.comp?.places?.rug_end)}`);
  r = await tool("name_place", { name: "nowhere", y: 2 });
  check("...and with y alone is refused, not quietly named where the body stands", /need x and z/.test(r) && !a.entities.get("rug").comp.places.nowhere, r);
  a.verb("light", { id: "lamp", pos: [50, ry + 2, -20], intensity: 5 });
  for (let i = 0; i < 40 && !a.entities.get("lamp"); i++) await sleep(50);
  r = await tool("name_place", { name: "glow", on: "lamp" });
  check("a light cannot carry places — refused, not saved where nothing reads it", /is a light/.test(r) && !a.entities.get("lamp")?.comp?.places, r);
  // two names in a row, before the first echo: both land
  const [r1, r2] = await Promise.all([
    tool("name_place", { name: "west_end", x: 45, z: -20, on: "rug" }),
    tool("name_place", { name: "east_end", x: 55.5, z: -20, on: "rug" })]);
  const pl = a.entities.get("rug").comp.places;
  check("two name_place calls at once both land — the second does not erase the first",
    /named/.test(r1) && /named/.test(r2) && pl.west_end && pl.east_end && pl.rug_end && pl.long_room, `${r1} | ${r2} | ${Object.keys(pl).join(",")}`);

  r = await tool("walk_to", { to: "the moon" });
  check("an unknown name is refused, listing the names that exist", /nothing here is called "the moon" — named places: .*tower\/hall/.test(r), r);
} finally {
  try { a.close(); friend.close(); } catch { /* gone */ }
  await h.cleanup(tally.failed || process.exitCode ? 1 : 0);
}
console.log(`${tally.passed} passed, ${tally.failed} failed`);
process.exit(tally.failed ? 1 : 0);
