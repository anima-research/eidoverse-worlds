/**
 * Storey-aware walking on a bare WorldAgent — the product half of ew#140.
 *
 * Run: bun mcpl/storey-walk-test.ts
 *
 * The planner tests (tools/structure-field-test.ts §13a) prove that a
 * storey's own walls route a walk when the router is told that storey. This
 * proves the door tells it: a body upstairs gives walkTo an identified-floor
 * support (walkSupport, from storeyUnder), so it is routed on that storey,
 * and its feet stay there while it walks, stands idle, stands up from a
 * tumble and begins or ends a flight (groundAt). The effective height is the
 * terrain unless the body stands on an upper storey's floor at its cell —
 * the body's own y only bounds which real floor qualifies, never becomes the
 * height.
 */
import { WorldAgent } from "./agent.ts";
import { describeHere, planStructure } from "../shared/structure.js";
import { NAV_STEP } from "./navgrid.ts";

let failures = 0;
const check = (label: string, ok: boolean, detail?: string) => {
  console.log(ok ? `  \x1b[32m✓\x1b[0m ${label}` : `  \x1b[31m✗ ${label}${detail ? ` — ${detail}` : ""}\x1b[0m`);
  if (!ok) failures++;
};

// Open-plan ground floor (no divider); upstairs divided at x=2 with the only
// door at the SOUTH end. Same fixture as the issue's second receipt.
const shell = [
  [0, 0, 0], [0, 1, 0], [0, 2, 0], [0, 3, 0],
  [0, 0, 2], [0, 1, 2], [0, 2, 2], [0, 3, 2],
  [1, 0, 0], [1, 0, 1], [1, 4, 0], [1, 4, 1],
];
const tiles = [[0, 0], [1, 0], [2, 0], [3, 0], [0, 1], [1, 1], [2, 1], [3, 1]];
const HOUSE = {
  labels: { "0,0": "kitchen", "2,0": "hall" },
  levels: [
    { y: 0, tiles, walls: shell, apertures: [] },
    { y: 3, tiles, walls: [...shell, [1, 2, 0], [1, 2, 1]], apertures: [[1, 2, 1, "door"]] },
  ],
};
const plan = planStructure(HOUSE);
const upperY = plan.levels[1].y;      // the upstairs walk surface, grid-local == world here (building at origin, scale 1)

function agentIn(y: number, opts: { pos?: number[]; scale?: number; before?: Record<string, any>; house?: any } = {}) {
  const ag: any = new WorldAgent({ name: "climber", world: "test" });
  // entities the agent learned about BEFORE the house: a Map folds in insertion order
  for (const [id, ent] of Object.entries(opts.before ?? {})) ag.entities.set(id, { id, pos: [50, 0, 50], yaw: 0, actor: "test", ...ent });
  ag.entities.set("house", { id: "house", model: "house", pos: opts.pos ?? [0, 0, 0], yaw: 0, actor: "test",
    ...(opts.scale ? { scale: opts.scale } : {}), structure: opts.house ?? HOUSE });
  const [px, py, pz] = opts.pos ?? [0, 0, 0];
  const s = opts.scale ?? 1;
  ag.pos = { x: px + 0.5 * s, y: py + y * s, z: pz + 0.5 * s };
  return ag;
}
/** Tick a body that has stopped walking until its feet are on the ground
 *  at `want` and it is grounded, at most 200 ticks: the landing itself, not
 *  a count of ticks standing in for it. */
function landing(ag: any, want: number) {
  let n = 0;
  for (; n < 200 && !(ag.grounded && Math.abs(ag.pos.y - want) < 1e-9); n++) ag.tick();
  return { ok: ag.grounded && Math.abs(ag.pos.y - want) < 1e-9, detail: `y ${ag.pos.y} after ${n} ticks, want ${want}` };
}
/** Ask for a walk and stop it at once: its own refusal, or that it set off
 *  (a target installed), without ticking it anywhere. */
async function tryWalk(ag: any, x: number, z: number, y?: number, near: any = {}) {
  const receipt = { refusal: null as string | null };
  const r = await Promise.race([ag.walkTo(x, z, false, 30_000, 0.05, y, near, receipt), Bun.sleep(20).then(() => "walking")]);
  const setOff = r === "walking" && ag.target != null;
  if (r === "walking") ag.stop();
  return { refusal: r === false ? String(receipt.refusal ?? ag.walkRefusal ?? "") : "", setOff };
}

/** walkTo plans its legs synchronously before the first tick; read them back. */
function legsOf(ag: any, x: number, z: number) {
  void ag.walkTo(x, z);
  const legs = ag.legs.slice();
  ag.stop();
  return legs;
}

console.log("\nstorey-aware walking\n");
{
  const ag = agentIn(0);
  check("ground floor (open plan): straight walk, no legs", legsOf(ag, 3.5, 0.5).length === 0);
  check("ground floor: feet stay on the terrain", ag.pos.y === 0, String(ag.pos.y));
}
{
  const ag = agentIn(upperY);
  const legs = legsOf(ag, 3.5, 0.5);
  check("upstairs: the walk detours through the south door", legs.length >= 2, JSON.stringify(legs));
  check("upstairs: feet stay on the upper floor, not the terrain", Math.abs(ag.pos.y - upperY) < 1e-9, String(ag.pos.y));
  // Ticked to arrival, through the door, then again over a flood under the
  // house: a body on the floor above the water walks at its dry pace.
  ag.joined = true;
  const drive = async () => {
    ag.pos = { x: 0.5, y: upperY, z: 0.5 };
    const walk = ag.walkTo(3.5, 0.5, false, 30_000, 0.05);
    const ys: number[] = [], speeds: number[] = [];
    for (let i = 0; i < 3000 && ag.target; i++) { ag.tick(); ys.push(ag.pos.y); speeds.push(ag.speed); }
    return { arrived: await walk, ys, speeds };
  };
  const dry = await drive();
  check("…and, ticked, arrives through the door with the feet on the upper floor all the way",
    dry.arrived === true && dry.ys.length > 0 && dry.ys.every((y) => Math.abs(y - upperY) < 1e-6),
    `${String(dry.arrived)} ${String(dry.ys.find((y) => Math.abs(y - upperY) >= 1e-6))}`);
  ag.water = { level: 1 };
  const wet = await drive();
  ag.water = null;
  check("…and over a flood under the house, the floor's walker is not wading, tick for tick",
    wet.arrived === true && wet.speeds.join() === dry.speeds.join() && wet.ys.every((y) => Math.abs(y - upperY) < 1e-6),
    `${wet.speeds.findIndex((s, i) => s !== dry.speeds[i])} first differing tick of ${wet.speeds.length}/${dry.speeds.length}`);
  // the same flood slows a walker on the ground floor, so the water does
  // reach a walk's stance in this setup
  const below = agentIn(0);
  below.joined = true;
  const ticksBelow = async (flood: boolean) => {
    below.pos = { x: 0.5, y: 0, z: 0.5 };
    below.water = flood ? { level: 1 } : null;
    const w = below.walkTo(3.5, 0.5, false, 30_000, 0.05);
    let n = 0;
    for (let i = 0; i < 3000 && below.target; i++) { below.tick(); n++; }
    await w;
    below.water = null;
    return n;
  };
  const dryBelow = await ticksBelow(false), wetBelow = await ticksBelow(true);
  check("…while the same flood slows a walker on the ground floor", wetBelow > dryBelow, `${wetBelow} ticks wet, ${dryBelow} dry`);
  below.joined = false;
}
{
  const ag = agentIn(upperY - 0.3);   // a step below the surface: still that storey
  check("a body a step below the upper floor resolves to it", legsOf(ag, 3.5, 0.5).length >= 2);
}
{
  const ag = agentIn(20);              // floating far above the house: nothing under the feet
  const legs = legsOf(ag, 3.5, 0.5);
  check("a floating y is not trusted: the body resolves to the terrain and walks the ground plan",
    legs.length === 0 && ag.pos.y === 0, `legs=${JSON.stringify(legs)} y=${ag.pos.y}`);
}
{
  const ag = agentIn(upperY);
  ag.pos.x = 4.5;                       // off the building's footprint entirely
  void ag.walkTo(4.5, 0.5); const y = ag.pos.y; ag.stop();
  check("no floor tile under the cell: terrain, even at an upper height", y === 0, String(y));
}
{
  // the rule survives the building being somewhere else, rotated and scaled
  const ag = agentIn(upperY, { pos: [10, 2, -5], scale: 2 });
  ag.entities.get("house").yaw = Math.PI / 2;
  const s = 2, [px, py, pz] = [10, 2, -5];
  // grid-local (0.5, 0.5) → world under yaw π/2 (x' = x·cos + z·sin, z' = −x·sin + z·cos)
  const c = Math.cos(Math.PI / 2), n = Math.sin(Math.PI / 2);
  ag.pos = { x: px + (0.5 * c + 0.5 * n) * s, y: py + upperY * s, z: pz + (-0.5 * n + 0.5 * c) * s };
  const tx = px + (3.5 * c + 0.5 * n) * s, tz = pz + (-3.5 * n + 0.5 * c) * s;
  const legs = legsOf(ag, tx, tz);
  check("placed, rotated, scaled building: still routes the upper storey", legs.length >= 2, JSON.stringify(legs));
  check("…and the feet land on the scaled upper floor", Math.abs(ag.pos.y - (py + upperY * s)) < 1e-9, String(ag.pos.y));
  // a destination's floor is read in the building's own frame as well
  const same = await tryWalk(ag, tx, tz, py + upperY * s), lower = await tryWalk(ag, tx, tz, py + plan.levels[0].y * s);
  check("…and from there a walk given its upper floor's height sets off, one given its ground floor's is refused as ground level",
    same.setOff && /is at ground level, not on the floor you stand on/.test(lower.refusal), `${JSON.stringify(same)} ${lower.refusal}`);
}
{
  // the tick's standing clamp uses the same rule: an upstairs body is not
  // dragged to the terrain between waypoints
  const ag = agentIn(upperY);
  void ag.walkTo(3.5, 0.5);
  ag.joined = true;
  for (let i = 0; i < 5; i++) ag.tick();
  check("tick keeps an upstairs walker on the upper floor", Math.abs(ag.pos.y - upperY) < 1e-9, String(ag.pos.y));
  ag.stop(); ag.joined = false;
}


console.log("\na malformed house elsewhere in the world (Greptile on #200, finding 1)\n");
{
  // comp data is opaque to the server: `structure: "junk"` is accepted and
  // folded. The agent's walk loop used to hold ONE try around every building,
  // so a primitive that a WeakMap refuses as a key threw out of planOf and
  // took the route through the sound house with it — straight through walls.
  for (const junk of ["junk", true, 7]) {
    const ag = agentIn(upperY, { before: { junk: { model: "junk", structure: junk } } });
    check(`structure: ${JSON.stringify(junk)} learned first: the upstairs walk still detours through the door`,
      legsOf(ag, 3.5, 0.5).length >= 2);
    check(`…and the feet stay on the upper floor`, Math.abs(ag.pos.y - upperY) < 1e-9, String(ag.pos.y));
  }
}

console.log("\na corner cut by a diagonal, floored on one half (findings 2 and 3)\n");
{
  // Two cells wide. Upstairs, the east cell is cut ↘ and floored on its
  // north-east half only (the A half; see nodeAtPoint): the south-west half
  // is a hole over the ground-floor room, not a floor.
  const shell2 = [[0, 0, 0], [0, 1, 0], [0, 0, 1], [0, 1, 1], [1, 0, 0], [1, 2, 0]];
  const CORNER = {
    levels: [
      { y: 0, tiles: [[0, 0], [1, 0]], walls: shell2, apertures: [] },
      { y: 3, tiles: [[0, 0], [1, 0, "floor", "A"]], walls: [...shell2, [2, 1, 0]], apertures: [] },
    ],
  };
  const up = planStructure(CORNER).levels[1].y;
  const onFloor = agentIn(0, { house: CORNER });
  check("over the floored half at upper height: the feet are on the upper floor",
    Math.abs(onFloor.groundAt(1.8, 0.2, up) - up) < 1e-9, String(onFloor.groundAt(1.8, 0.2, up)));
  check("over the hole at upper height: the feet resolve to the terrain — the half is not a floor",
    onFloor.groundAt(1.2, 0.8, up) === 0, String(onFloor.groundAt(1.2, 0.8, up)));
  const upstairs = agentIn(up, { house: CORNER });
  const cornerProbe = upstairs.walkProbeGround(upstairs.walkSupport());
  check("a floor walk's probe stands on the cut cell's floored half",
    Math.abs(cornerProbe(1.8, 0.2) - up) < 1e-9, String(cornerProbe(1.8, 0.2)));
  check("…and over its hole finds a drop the grid won't take", up - cornerProbe(1.2, 0.8) > NAV_STEP, String(cornerProbe(1.2, 0.8)));
  // finding 2, from the product side: the router only ever saw an upstairs
  // start in an unfloored half because the standing clamp had held the body
  // there. Once the feet read the half, a body over the hole is on the ground
  // floor, and the ground plan is the right one to route on.
  const ag = agentIn(up, { house: CORNER });
  ag.pos = { x: 1.2, y: up, z: 0.8 };
  const legs = legsOf(ag, 0.5, 0.5);
  check("a body over the hole is not held in the air by walkTo", ag.pos.y === 0, String(ag.pos.y));
  check("…and walks the open ground plan straight, no legs", legs.length === 0, JSON.stringify(legs));
}

console.log("\nwhich levels hold the feet: those raised above their building's base\n");
{
  // a ground floor between a basement and an upper storey rests on the
  // base: it's the terrain's, so a body there walks on the terrain, in and
  // out of the building
  const GB = { levels: [{ y: -3, tiles, walls: [], apertures: [] }, { y: 0, tiles, walls: shell, apertures: [] }, { y: 3, tiles, walls: shell, apertures: [] }] };
  const ag = agentIn(0, { house: GB });
  ag.pos.y = 0;
  check("on a ground floor over a basement, under an upper storey, the feet stand on the terrain", ag.groundAt(ag.pos.x, ag.pos.z) === 0, String(ag.groundAt(ag.pos.x, ag.pos.z)));
  check("…and a walk from there is a terrain walk", ag.walkSupport().kind === "terrain", JSON.stringify(ag.walkSupport()));
}
{
  // a big building's ground-floor slab stands more than a step above the
  // terrain (scale 6: 0.6 m); it still rests on the base, so a body found on
  // it is the terrain's, free to walk out, rather than kept on that floor
  const GB = { levels: [{ y: -3, tiles, walls: [], apertures: [] }, { y: 0, tiles, walls: shell, apertures: [] }, { y: 3, tiles, walls: shell, apertures: [] }] };
  const slab = planStructure(GB).levels[1].y * 6;
  const ag = agentIn(planStructure(GB).levels[1].y, { house: GB, scale: 6 });
  check("on a scaled-up ground floor's slab, the feet are the terrain's", ag.groundAt(ag.pos.x, ag.pos.z) === 0, `${ag.groundAt(ag.pos.x, ag.pos.z)} (slab ${slab}, feet ${ag.pos.y})`);
}
{
  // a deck with nothing under it, its one level raised above the base
  const DECK = { levels: [{ y: 3, tiles, walls: [], apertures: [] }] };
  const deckY = planStructure(DECK).levels[0].y;
  const ag = agentIn(deckY, { house: DECK });
  check("a one-level floor raised above its base holds the feet", Math.abs(ag.groundAt(ag.pos.x, ag.pos.z) - deckY) < 1e-9, String(ag.groundAt(ag.pos.x, ag.pos.z)));
  check("…and a walk from it is a walk on that floor", ag.walkSupport().kind === "floor", JSON.stringify(ag.walkSupport()));
}

{
  // a porch whose floor is within a step of the terrain: walked from the
  // terrain, since a floor route can't step down off it
  const PORCH = { levels: [{ y: 0.3, tiles, walls: [], apertures: [] }] };
  const porchY = planStructure(PORCH).levels[0].y;
  const ag = agentIn(0, { house: PORCH });
  ag.pos.y = 0;
  check("a porch within a step of the terrain doesn't lift the feet onto it", ag.groundAt(ag.pos.x, ag.pos.z) === 0, `${ag.groundAt(ag.pos.x, ag.pos.z)} (porch ${porchY})`);
  check("…and a walk from there is a terrain walk, free to step off", ag.walkSupport().kind === "terrain", JSON.stringify(ag.walkSupport()));
}
{
  // a floor more than a route step but less than the walk grid's step above
  // the terrain is the terrain's too: a floor walk's grid could step off it.
  // The grid's step is the one walker's (NAV_STEP, shared/mover.js); a level's
  // walk surface is 0.1 m over its declared y.
  const LOW = { levels: [{ y: NAV_STEP - 0.12, tiles, walls: [], apertures: [] }] };
  const lowY = planStructure(LOW).levels[0].y;
  const ag = agentIn(lowY, { house: LOW });
  check(`a floor within the walk grid's step of the terrain (${lowY.toFixed(2)} m) doesn't hold the feet either`, ag.groundAt(ag.pos.x, ag.pos.z) === 0, `${ag.groundAt(ag.pos.x, ag.pos.z)} (floor ${lowY})`);
  const ABOVE = { levels: [{ y: NAV_STEP - 0.05, tiles, walls: [], apertures: [] }] };
  const aboveY = planStructure(ABOVE).levels[0].y;
  const up = agentIn(aboveY, { house: ABOVE });
  check(`…and one just past it (${aboveY.toFixed(2)} m) does`, Math.abs(up.groundAt(up.pos.x, up.pos.z) - aboveY) < 1e-9, `${up.groundAt(up.pos.x, up.pos.z)} (floor ${aboveY})`);
}
console.log("\nthe feet keep the storey when the walk ends, after a tumble and around a flight\n");
{
  const ag = agentIn(upperY);
  ag.joined = true;
  for (let i = 0; i < 5; i++) ag.tick();
  check("standing idle upstairs, the tick keeps the feet on the upper floor", Math.abs(ag.pos.y - upperY) < 1e-9, String(ag.pos.y));
  ag.joined = false;
}
{
  const ag = agentIn(upperY);
  const ok = await ag.walkTo(4.5, 0.5);   // off the building's footprint
  check("a walk from the upper floor to a point off it is refused, saying so",
    ok === false && /the destination isn't on this floor/.test(String(ag.walkRefusal)), String(ag.walkRefusal));
  check("…and the feet stay upstairs", Math.abs(ag.pos.y - upperY) < 1e-9, String(ag.pos.y));
}
{
  // A destination whose height means another floor is refused, with the
  // same reason whichever path would plan the walk and whatever gives the
  // destination its height. The floor a height means is move's own rule
  // for a y (floorMeant): the floor nearest it, no more than a step above it
  // and within the destination's bounds, of the ground and the griddled
  // storeys at the point. A walk the planner routes in legs used to go to
  // the same x and z on its floor and report arriving.
  const { handleTool } = await import("./tools.ts");
  const walkTool = async (ag: any, args: Record<string, any>) => {
    // move takes its destination as `to`: [x, y, z], [x, z] or a name
    const to = typeof args.to === "string" ? args.to : args.y != null ? [args.x, args.y, args.z] : [args.x, args.z];
    const r: any = await handleTool({ agent: ag, canPush: () => false, heldActivity: [], cursor: { caughtUpTo: null } } as any, "move", { to });
    return (r.content ?? []).map((c: any) => c.text ?? "").join("\n");
  };
  /** Walk to (x, z) with height y and the bounds move passes on, ticking
   *  to arrival: true, false (refused or stopped) or "pending". */
  const walkThere = async (ag: any, x: number, z: number, y?: number, near: any = {}) => {
    const receipt = { refusal: null as string | null };
    ag.joined = true;
    const walk = ag.walkTo(x, z, false, 30_000, 0.05, y, near, receipt);
    for (let i = 0; i < 3000 && ag.target; i++) ag.tick();
    const r = await Promise.race([walk, Bun.sleep(300).then(() => "pending")]);
    ag.joined = false;
    return { r, refusal: receipt.refusal ?? ag.walkRefusal };
  };
  const toPerson = (ag: any, d: any) => walkThere(ag, d.x, d.z, d.y, { reach: d.reach, above: d.above, below: d.below, bodyAt: d.bodyAt });
  const toGround = /is at ground level, not on the floor you stand on \(3\.10m\)\. A walk from a floor stays on it, since a griddled building's storeys have no stairs between them or to the ground; pick a destination on this floor, or give to as \[x, z\], without y, which stays on it/;
  const cases: [string, Record<string, any>, (ag: any) => void][] = [
    ["coordinates with y 0", { x: 2.5, z: 1.5, y: 0 }, () => {}],
    ["coordinates with y 0 along a row of cell centres, a walk of one leg", { x: 1.5, z: 0.5, y: 0 }, () => {}],
    ["a place named on the ground floor", { to: "house/hearth" }, (ag) => { ag.entities.get("house").places = { hearth: { at: [2.5, 0.1, 1.5] } }; }],
    ["a thing's entrance on the ground floor", { to: "cabinet" }, (ag) => {
      ag.entities.set("cabinet", { id: "cabinet", model: "cabinet", pos: [2.5, 0.1, 1.5], yaw: 0, actor: "test", places: { entrance: { at: [0, 0, -0.6], kind: "door" } } }); }],
    ["a person standing on the ground floor", { to: "friend" }, (ag) => { ag.people.set("friend", { id: "friend", pose: { p: [2.5, 0.1, 1.5], yaw: 0, speed: 0, clip: "idle" } }); }],
    ["a canned slump on the ground floor, its root at its feet", { to: "friend" }, (ag) => { ag.people.set("friend", { id: "friend", pose: { p: [2.5, 0, 1.5], yaw: 0, speed: 0, clip: "ragdoll" } }); }],
  ];
  for (const [what, args, setup] of cases) {
    const ag = agentIn(upperY);
    setup(ag);
    ag.pins.set("hips", [0.5, upperY, 0.5]);
    const said = await walkTool(ag, args);
    check(`from the upper floor, a walk to ${what} is refused, saying why, and the body stays upstairs, its pins kept`,
      toGround.test(said) && Math.abs(ag.pos.y - upperY) < 1e-9 && !ag.target && ag.pins.has("hips"), `${said} at ${ag.pos.y}, pins ${ag.pins.size}`);
  }
  // move's rule for a height, at its edges: the floor no more than a step
  // (NAV_STEP) above y, and no cap above a floor
  for (const [what, y, refused] of [[`${(NAV_STEP - 0.02).toFixed(2)} m below its floor`, upperY - (NAV_STEP - 0.02), false], [`${(NAV_STEP + 0.05).toFixed(2)} m below its floor`, upperY - (NAV_STEP + 0.05), true],
    ["2.9 m above its floor, past the storey's height", upperY + 2.9, false]] as const) {
    const w = await walkThere(agentIn(upperY), 2.5, 1.5, y);
    check(`from the upper floor, a walk whose y is ${what} ${refused ? "is refused" : "walks there on it"}`,
      refused ? w.r === false && toGround.test(String(w.refusal)) : w.r === true, `${String(w.r)} ${w.refusal ?? ""}`);
  }
  const TALL = { levels: [{ y: 0, tiles, walls: shell, apertures: [] }, { y: 3, tiles, walls: shell, apertures: [] }, { y: 6, tiles, walls: shell, apertures: [] }] };
  const tallPlan = planStructure(TALL), mid = tallPlan.levels[1].y, top = tallPlan.levels[2].y;
  const upward = await walkTool(agentIn(mid, { house: TALL }), { x: 2.5, z: 1.5, y: top });
  check("from the middle floor, a walk to the floor above it is refused, saying it's another storey of this building and where",
    /is on another storey of this building, whose floor is at 6\.10m, not on the floor you stand on \(3\.10m\)/.test(upward), upward);
  for (const [what, y, refused] of [[`${(NAV_STEP - 0.02).toFixed(2)} m below the top floor, a step from it`, top - (NAV_STEP - 0.02), true], [`${(NAV_STEP + 0.05).toFixed(2)} m below the top floor`, top - (NAV_STEP + 0.05), false]] as const) {
    const w = await walkThere(agentIn(mid, { house: TALL }), 2.5, 1.5, y);
    check(`from the middle floor, a walk whose y is ${what} ${refused ? "is refused as the top floor" : "walks there on the middle floor"}`,
      refused ? w.r === false && /another storey of this building, whose floor is at 6\.10m/.test(String(w.refusal)) : w.r === true, `${String(w.r)} ${w.refusal ?? ""}`);
  }
  // the floor above counts only where it has a floor: past the end of a
  // shorter top storey, its height is the middle floor's
  const SHORT = { levels: [{ y: 0, tiles, walls: shell, apertures: [] }, { y: 3, tiles, walls: shell, apertures: [] }, { y: 6, tiles: [[0, 0], [1, 0]], walls: [], apertures: [] }] };
  const pastTop = await tryWalk(agentIn(mid, { house: SHORT }), 3.5, 1.5, top);
  check("from the middle floor, a walk to the top floor's height past the end of a shorter top storey sets off", pastTop.setOff, JSON.stringify(pastTop));
  // a shelf high on the middle floor, nearer the floor above than its own:
  // something placed stands at that height, so the walk goes
  {
    const { boxMesh } = await import("../tools/two-storey-fixture.ts");
    const { registerMeshSupport, removeSupport } = await import("./physics.ts");
    const shelfAg = agentIn(mid, { house: TALL });
    const { pos, idx } = boxMesh([[2.1, mid + 2.4, 1.1, 2.9, mid + 2.6, 1.9]]);
    const shelf = `${shelfAg.world}/high-shelf`;
    const fitted = await registerMeshSupport("storey-walk-test", shelf, { positions: new Float32Array(pos), indices: new Uint32Array(idx) }, { position: [0, 0, 0], yaw: 0, scale: 1 });
    const toShelf = await tryWalk(shelfAg, 2.5, 1.5, mid + 2.6);
    check("from the middle floor, a walk to a high shelf on it, nearer the floor above, isn't refused by this check",
      fitted && (toShelf.setOff || toShelf.refusal !== "" && !/not on the floor you stand on/.test(toShelf.refusal)), JSON.stringify(toShelf));
    await removeSupport("storey-walk-test", shelf);
  }
  // what placedNear counts: a placed top on this floor, under the next floor
  // above, within the destination's bounds (a step each way unless given),
  // in this world. From the middle floor, y 5.7 means the top floor (0.4 m
  // up, at 6.10): a shelf just within a step below 5.7, or at 6.05, lets the
  // walk go; one just past a step below doesn't, nor one at 6.2, which rests
  // on the top floor, nor one in another world at 5.7, nor, for a destination
  // whose floor lies no more than 0.1 m below its height, one at 5.2.
  {
    const { boxMesh } = await import("../tools/two-storey-fixture.ts");
    const { registerMeshSupport, removeSupport } = await import("./physics.ts");
    for (const [at, world, below, goes] of [[+(5.7 - NAV_STEP - 0.05).toFixed(2), "", undefined, false], [+(5.7 - NAV_STEP + 0.05).toFixed(2), "", undefined, true], [6.05, "", undefined, true], [6.2, "", undefined, false],
      [5.7, "elsewhere", undefined, false], [5.2, "", 0.1, false]] as const) {
      const ag = agentIn(mid, { house: TALL });
      const { pos, idx } = boxMesh([[2.1, at - 0.05, 1.1, 2.9, at, 1.9]]);
      const id = `${world || ag.world}/band-shelf`;
      const fitted = await registerMeshSupport("storey-walk-test", id, { positions: new Float32Array(pos), indices: new Uint32Array(idx) }, { position: [0, 0, 0], yaw: 0, scale: 1 });
      const w = await tryWalk(ag, 2.5, 1.5, 5.7, below == null ? {} : { below });
      check(`from the middle floor, y 5.7${below == null ? "" : ` (no more than ${below} m above its floor)`} over a shelf at ${at}${world ? " in another world" : ""} ${goes ? "isn't refused by this check" : "is refused as the top floor"}`,
        fitted && (goes ? w.setOff || w.refusal !== "" && !/not on the floor you stand on/.test(w.refusal) : /another storey of this building, whose floor is at 6\.10m/.test(w.refusal)), JSON.stringify(w));
      await removeSupport("storey-walk-test", id);
    }
  }
  // a seat's height is where the hips rest, its floor no higher (above: 0):
  // a perch 2.65 m above the middle floor is the middle floor's, not the top's.
  // A places component names no seat (its kind is gone: shape audit 10-16; a
  // seat is a model's or a socket's), so the seat's destination is the one
  // destination() gives a seat (mcpl/places.ts): 0.05 m under the hips, no
  // floor above that.
  const perch = (_ag: any) => ({ x: 2.5, y: mid + 2.65 - 0.05, z: 1.5, reach: 0.6, above: 0 });
  const onTop = agentIn(top, { house: TALL }), dTop = perch(onTop);
  const fromTop = await walkThere(onTop, dTop.x, dTop.z, dTop.y, { reach: dTop.reach, above: dTop.above });
  check("a seat high above the middle floor, from the top floor: refused as the middle floor's, its bound kept",
    dTop.above === 0 && fromTop.r === false && /another storey of this building, whose floor is at 3\.10m/.test(String(fromTop.refusal)), `above ${dTop.above}: ${String(fromTop.r)} ${fromTop.refusal ?? ""}`);
  const onMid = agentIn(mid, { house: TALL }), dMid = perch(onMid);
  const fromMid = await tryWalk(onMid, dMid.x, dMid.z, dMid.y, { reach: dMid.reach, above: dMid.above });
  check("…and from the middle floor it sets off", fromMid.setOff, JSON.stringify(fromMid));
  // a storey of another building at the point, from a floor walk
  const ROOF = { levels: [{ y: 5.9, tiles, walls: [], apertures: [] }] };
  const under = agentIn(upperY, { before: { roof: { model: "roof", pos: [0, 0, 0], structure: ROOF } } });
  const toRoof = await walkThere(under, 2.5, 1.5, 6);
  check("from the upper floor, a walk to the storey of another building over it is refused, naming another building",
    toRoof.r === false && /is on a storey of another building, whose floor is at 6\.00m/.test(String(toRoof.refusal)), `${String(toRoof.r)} ${toRoof.refusal ?? ""}`);
  // a walk whose y is on its own floor, or that leaves y out, stays on it and arrives
  for (const [what, y] of [["whose y is on its own floor", upperY], ["that leaves y out", undefined]] as const) {
    const ag = agentIn(upperY);
    const w = await walkThere(ag, 2.5, 1.5, y);
    check(`…while one from the upper floor ${what} walks there on the upper floor`,
      w.r === true && Math.abs(ag.pos.y - upperY) < 1e-9 && Math.hypot(ag.pos.x - 2.5, ag.pos.z - 1.5) < 0.06, `${String(w.r)} ${w.refusal ?? ""} at (${ag.pos.x}, ${ag.pos.y}, ${ag.pos.z})`);
  }
  // People: presence carries the root. One standing, or held by a canned
  // slump, has it on its floor; one a sim laid down, under clip "ragdoll" or
  // a physics pose held under another, has it RAGDOLL_ROOT_DROP below the
  // surface it lies on. Their floor lies no more than that drop (and 0.05 m)
  // above the root: for the check, the highest griddled floor within it at
  // their spot; for the navgrid, the place to stand nearest the root within
  // it.
  for (const [what, clip, root] of [["lying limp, laid by a sim", "ragdoll", upperY - 0.7], ["in a canned slump, its root at its feet", "ragdoll", upperY],
    ["lying in a physics pose under another clip", "idle", upperY - 0.7], ["standing", "idle", upperY]] as const) {
    const ag = agentIn(upperY);
    ag.people.set("friend", { id: "friend", pose: { p: [3.5, root, 1.5], yaw: 0, speed: 0, clip } });
    const d = ag.destination("friend");
    const near = (a: number | undefined, b: number) => a != null && Math.abs(a - b) < 1e-9;
    const bounds = near(d.y, root) && near(d.above, 0.75) && d.below === undefined && d.bodyAt?.x === 3.5 && d.bodyAt?.z === 1.5;
    const w = await toPerson(ag, d);
    check(`a walk upstairs to someone ${what} on the same floor goes to them on it`,
      bounds && w.r === true && Math.abs(ag.pos.y - upperY) < 1e-9, `y ${d.y} above ${d.above} below ${d.below}: ${String(w.r)} ${w.refusal ?? ""} at ${ag.pos.y}`);
  }
  // A person's floor is read where they stand: someone on another building's
  // upper floor beside this one, the walk stopping short of them on this
  // floor, is on that building's storey, not this one.
  const PAIR = { levels: [{ y: 3, tiles, walls: [], apertures: [] }] };
  const pairY = planStructure(PAIR).levels[0].y;
  const across = agentIn(pairY, { house: PAIR, before: { next: { model: "deck", pos: [4.5, 0, 0], structure: PAIR } } });
  across.pos = { x: 0.5, y: pairY, z: 1 };
  across.people.set("friend", { id: "friend", pose: { p: [4.6, pairY, 1], yaw: 0, speed: 0, clip: "idle" } });
  const dAcross = across.destination("friend");
  const toAcross = await tryWalk(across, dAcross.x, dAcross.z, dAcross.y, { reach: dAcross.reach, above: dAcross.above, bodyAt: dAcross.bodyAt });
  check("from a deck, a walk to someone on the deck beside it, stopping short of them on this one, is refused as another building's storey",
    dAcross.x < 4 && /^the destination is on a storey of another building, whose floor is at 3\.10m/.test(toAcross.refusal), `stopping at ${dAcross.x.toFixed(2)}: ${JSON.stringify(toAcross)}`);
  // the same through move, with the decks apart along z
  const acrossZ = agentIn(pairY, { house: PAIR, before: { next: { model: "deck", pos: [0, 0, 2.5], structure: PAIR } } });
  acrossZ.pos = { x: 1, y: pairY, z: 0.5 };
  acrossZ.people.set("friend", { id: "friend", pose: { p: [1, pairY, 2.6], yaw: 0, speed: 0, clip: "idle" } });
  const saidZ = await walkTool(acrossZ, { to: "friend" });
  check("…and through move, with the decks apart along z", /is on a storey of another building, whose floor is at 3\.10m/.test(saidZ), saidZ);
  // someone lying limp on a deck a metre up, which the walker stands on: their
  // root is nearer the ground, but their body is on the deck
  const LOWDECK = { levels: [{ y: 0.9, tiles, walls: [], apertures: [] }] };
  const lowDeckY = planStructure(LOWDECK).levels[0].y;
  const onLow = agentIn(lowDeckY, { house: LOWDECK });
  onLow.people.set("friend", { id: "friend", pose: { p: [3.5, lowDeckY - 0.7, 1.5], yaw: 0, speed: 0, clip: "ragdoll" } });
  const dLow = onLow.destination("friend");
  const toLow = await tryWalk(onLow, dLow.x, dLow.z, dLow.y, { reach: dLow.reach, above: dLow.above, bodyAt: dLow.bodyAt });
  check("from a deck a metre up, a walk to someone lying limp on it sets off", toLow.setOff, JSON.stringify(toLow));
  // a height on no floor at all is refused, not walked to on this one
  const sunk = await tryWalk(agentIn(upperY), 2.5, 1.5, -5);
  check("from the upper floor, a walk to a height below every floor is refused, saying it is on no floor here",
    /the destination \(height -5\.00m\) is on no floor here, not on the floor you stand on \(3\.10m\)/.test(sunk.refusal), JSON.stringify(sunk));
  // a building's ground floor at its base is the terrain's, at any scale: six
  // times as large, its slab is 0.6 m up, still the ground's, not a storey
  const big = agentIn(upperY, { scale: 6 });
  const slab = await tryWalk(big, 2.5 * 6, 1.5 * 6, plan.levels[0].y * 6);
  check("from the upper floor of a building six times as large, a walk to its ground-floor slab's height is refused as ground level",
    /is at ground level, not on the floor you stand on/.test(slab.refusal), JSON.stringify(slab));
  // where the ground rises more than a step above a deck, the deck is buried
  // there and the ground is not its own: a walk across it to the ground's
  // height is refused
  const DECK = { levels: [{ y: 3, tiles, walls: [], apertures: [] }] };
  const deckY = planStructure(DECK).levels[0].y;
  const onDeck = agentIn(deckY, { house: DECK });
  onDeck.heightAt = (x: number, z: number) => (x >= 1 && x < 2 && z >= 1 ? deckY + 1 : 0);
  const buried = await tryWalk(onDeck, 1.5, 1.5, deckY + 1);
  check("from a deck, a walk to where the ground rises a metre above it, given the ground's height, is refused as ground level",
    /is at ground level, not on the floor you stand on/.test(buried.refusal), JSON.stringify(buried));
  // two buildings' floors at one height: the walk's own wins, whichever was
  // placed first; another building's storey at the same level index is still
  // another building's
  const SIDE = { levels: [{ y: 3, tiles: [[0, 0], [1, 0]], walls: [], apertures: [] }] };
  const twin = agentIn(upperY, { before: { side: { model: "deck", pos: [2, 0, 1], structure: SIDE } } });
  const tied = await tryWalk(twin, 2.5, 1.5, upperY);
  check("from the upper floor, a walk to a point another building's floor also covers at the same height sets off", tied.setOff, JSON.stringify(tied));
  const SIDE2 = { levels: [{ y: 0, tiles: [[0, 0], [1, 0]], walls: [], apertures: [] }, { y: 3, tiles: [[0, 0], [1, 0]], walls: [], apertures: [] }] };
  const twin2 = agentIn(upperY, { before: { side: { model: "deck", pos: [2, 0, 1], structure: SIDE2 } } });
  const tied2 = await tryWalk(twin2, 2.5, 1.5, upperY);
  check("…and so does one where the other building's floor at that height is at the walk's own level index", tied2.setOff, JSON.stringify(tied2));
  const ROOF2 = { levels: [{ y: 0, tiles, walls: [], apertures: [] }, { y: 5.9, tiles, walls: [], apertures: [] }] };
  const under2 = agentIn(upperY, { before: { roof: { model: "roof", pos: [0, 0, 0], structure: ROOF2 } } });
  const toRoof2 = await tryWalk(under2, 2.5, 1.5, 6);
  check("…and to another building's storey at the same level index is refused, naming another building",
    /is on a storey of another building, whose floor is at 6\.00m/.test(toRoof2.refusal), JSON.stringify(toRoof2));
  // Where something placed on or above this floor stands at about the height
  // asked for, the walk goes: a table upstairs is walked to. One on the floor
  // below is no reason to go, and the height there is refused as it is where
  // nothing is placed.
  const { boxMesh } = await import("../tools/two-storey-fixture.ts");
  const { registerMeshSupport, removeSupport } = await import("./physics.ts");
  const placeBox = async (ag: any, id: string, box: number[]) => {
    const { pos, idx } = boxMesh([box as any]);
    return registerMeshSupport("storey-walk-test", `${ag.world}/${id}`, { positions: new Float32Array(pos), indices: new Uint32Array(idx) }, { position: [0, 0, 0], yaw: 0, scale: 1 });
  };
  const furnished = agentIn(upperY);
  const fitted = await placeBox(furnished, "table", [3.1, 0, 0.1, 3.9, 0.75, 0.9]) && await placeBox(furnished, "upper-table", [3.1, upperY, 1.1, 3.9, upperY + 0.75, 1.9]);
  check("setup: the tables are colliders", fitted);
  const bare = await tryWalk(furnished, 2.5, 0.5, 0.75), overTable = await tryWalk(agentIn(upperY), 3.5, 0.5, 0.75), upTable = await tryWalk(agentIn(upperY), 3.5, 1.5, upperY + 0.75);
  const underUpTable = await tryWalk(agentIn(upperY), 3.5, 1.5, 0.75);
  check("…and so is one to a table's height on the ground floor under the table upstairs",
    /is at ground level, not on the floor you stand on/.test(underUpTable.refusal), JSON.stringify(underUpTable));
  const passed = (w: { refusal: string; setOff: boolean }) => w.setOff || (w.refusal !== "" && !/not on the floor you stand on/.test(w.refusal));
  check("from the upper floor, a walk to a table's height on the ground floor is refused, where nothing is placed and over the table itself, and one to a table upstairs isn't refused by this check",
    /is at ground level, not on the floor you stand on/.test(bare.refusal) && /is at ground level, not on the floor you stand on/.test(overTable.refusal) && passed(upTable), `${JSON.stringify(bare)} ${JSON.stringify(overTable)} ${JSON.stringify(upTable)}`);
  for (const id of ["table", "upper-table"]) await removeSupport("storey-walk-test", `${furnished.world}/${id}`);
  // someone lying limp on a high bed upstairs, a sim's root 0.7 m under its
  // top, is on the upper floor: the walk goes to them there
  const bedside = agentIn(upperY);
  const bedFitted = await placeBox(bedside, "bed", [3, upperY, 1, 4, upperY + 0.9, 2]);
  bedside.people.set("friend", { id: "friend", pose: { p: [3.5, upperY + 0.2, 1.5], yaw: 0, speed: 0, clip: "ragdoll" } });
  const dBed = bedside.destination("friend");
  const toBed = await tryWalk(bedside, dBed.x, dBed.z, dBed.y, { reach: dBed.reach, above: dBed.above, below: dBed.below, bodyAt: dBed.bodyAt });
  check("from the upper floor, a walk to someone lying limp on a high bed upstairs sets off", bedFitted && toBed.setOff, JSON.stringify(toBed));
  await removeSupport("storey-walk-test", `${bedside.world}/bed`);
  // a loft bed 1.8 m high: their body is on the upper floor's storey, so the
  // check lets the walk go. The navgrid takes the bed's top, nearer their
  // root than the floor beside it, finds no way up to it, and routes again
  // within a step: the walk ends on the floor beside the bed.
  // The walk runs along row 0's cell centres of an open upper floor, so the
  // structure planner leaves it one leg, which the navgrid routes.
  const loftside = agentIn(upperY, { house: { levels: [{ y: 0, tiles, walls: shell, apertures: [] }, { y: 3, tiles, walls: shell, apertures: [] }] } });
  const loftFitted = await placeBox(loftside, "loft", [2, upperY, 0.05, 3, upperY + 1.8, 0.95]);
  loftside.people.set("friend", { id: "friend", pose: { p: [2.5, upperY + 1.1, 0.5], yaw: 0, speed: 0, clip: "ragdoll" } });
  const dLoft = loftside.destination("friend");
  const toLoft = await toPerson(loftside, dLoft);
  check("from the upper floor, a walk along a row of cell centres to someone lying on a loft bed upstairs ends on the floor beside it",
    loftFitted && toLoft.r === true && Math.abs(loftside.pos.y - upperY) < 0.05 && loftside.pos.x < 2,
    `${JSON.stringify(toLoft)}, feet at (${loftside.pos.x.toFixed(2)}, ${loftside.pos.y.toFixed(2)}, ${loftside.pos.z.toFixed(2)})`);
  await removeSupport("storey-walk-test", `${loftside.world}/loft`);
}
{
  // The same on a placed model's upper floor, where the navgrid takes the
  // destination's height and bounds as the floor to arrive on (the place to
  // stand nearest the height, within them). Taken from a limp person's root
  // alone, 0.7 m below the floor they lie on, it named the hall beneath them,
  // as on main. The two-storey fixture, placed away from the griddled house;
  // the walker on its upper floor, the friend on it above the hall.
  const { boxMesh, boxes, UPPER } = await import("../tools/two-storey-fixture.ts");
  const { registerMeshSupport, removeSupport } = await import("./physics.ts");
  const { pos, idx } = boxMesh(boxes);
  // A canned slump's root is on its floor: a box a metre high beside one is
  // not taken for it, and the walk ends on the floor.
  const boxBy: number[] = [19.5, UPPER, 20.9, 20.1, UPPER + 1, 21.2];
  // Someone a sim laid on a bed has their root 0.7 m under its top: the
  // floor beside the bed is nearer it than the top, so the walk ends there,
  // whether the bed is low enough to step onto or not.
  const bed = (h: number): number[] => [19.6, UPPER, 21.1, 20.6, UPPER + h, 22.1];
  for (const [what, clip, root, extra] of [["lying limp, laid by a sim", "ragdoll", UPPER - 0.7, null], ["in a canned slump, its root at its feet", "ragdoll", UPPER, null],
    ["in a canned slump beside a box a metre high", "ragdoll", UPPER, boxBy],
    ["lying limp on a bed 0.5 m high", "ragdoll", UPPER + 0.5 - 0.7, bed(0.5)], ["lying limp on a bed 0.9 m high", "ragdoll", UPPER + 0.9 - 0.7, bed(0.9)],
    ["lying in a physics pose under another clip", "idle", UPPER - 0.7, null], ["standing", "idle", UPPER, null]] as const) {
    const ag: any = new WorldAgent({ name: "climber", world: "test" });
    ag.heightAt = () => 0;
    const tower = `${ag.world}/limp-tower`;
    let fitted = await registerMeshSupport("storey-walk-test", tower, { positions: new Float32Array(pos), indices: new Uint32Array(idx) }, { position: [20, 0, 20], yaw: 0, scale: 1 });
    if (extra) {
      const b = boxMesh([extra as any]);
      fitted = fitted && await registerMeshSupport("storey-walk-test", `${ag.world}/limp-box`, { positions: new Float32Array(b.pos), indices: new Uint32Array(b.idx) }, { position: [0, 0, 0], yaw: 0, scale: 1 });
    }
    ag.pos = { x: 18, y: UPPER, z: 18 };
    ag.joined = true;
    for (let i = 0; i < 20; i++) ag.tick();
    const stood = ag.pos.y;
    ag.people.set("friend", { id: "friend", pose: { p: [20, root, 21.5], yaw: 0, speed: 0, clip } });
    const d = ag.destination("friend");
    const receipt = { refusal: null as string | null };
    const toThem = ag.walkTo(d.x, d.z, false, 30_000, 0.05, d.y, { reach: d.reach, above: d.above, below: d.below, bodyAt: d.bodyAt }, receipt);
    for (let i = 0; i < 3000 && ag.target; i++) ag.tick();
    const reached = await Promise.race([toThem, Bun.sleep(300).then(() => "pending")]);
    check(`on a placed model's upper floor, a walk to someone ${what} on it goes to them there, not to the hall beneath`,
      fitted && Math.abs(stood - UPPER) < 0.02 && receipt.refusal === null && reached === true && Math.abs(ag.pos.y - UPPER) < 0.02
        && Math.hypot(ag.pos.x - 20, ag.pos.z - 21.5) < 1.6,
      `collider ${fitted}, stood at ${stood}; destination y ${d.y} above ${d.above} below ${d.below}; ${receipt.refusal ?? ""} ${String(reached)} at (${ag.pos.x}, ${ag.pos.y}, ${ag.pos.z})`);
    await removeSupport("storey-walk-test", tower);
    if (extra) await removeSupport("storey-walk-test", `${ag.world}/limp-box`);
    ag.joined = false;
  }
}
{
  // a slumped body's root lies RAGDOLL_ROOT_DROP (0.7m) below the floor
  // holding it; clearing the slump (setPose(null)) is standing up
  const ag = agentIn(upperY);
  ag.clip = "ragdoll"; ag.pos.y = upperY - 0.7;   // as a sim frame lays it
  ag.setPose(null);
  check("a body tumbled upstairs stands up on the upper floor", Math.abs(ag.pos.y - upperY) < 1e-9, String(ag.pos.y));
}
{
  // a posture chosen while the physics frame still holds the bones
  const ag = agentIn(upperY);
  ag.clip = "ragdoll"; ag.heldPose = { hips: [0, 0, 0, 1] }; ag.heldPoseAuthored = false; ag.pos.y = upperY - 0.7;
  ag.setPosture("idle");
  check("a posture chosen mid-tumble upstairs stands on the upper floor", Math.abs(ag.pos.y - upperY) < 1e-9, String(ag.pos.y));
}
{
  // a body slumped upstairs plans its walk from the floor its feet are on:
  // its root lies RAGDOLL_ROOT_DROP below them, as when it stands up
  const ag = agentIn(upperY);
  ag.clip = "ragdoll"; ag.heldPose = { hips: [0, 0, 0, 1] }; ag.heldPoseAuthored = false; ag.pos.y = upperY - 0.7;
  const legs = legsOf(ag, 3.5, 0.5);
  check("a body slumped upstairs plans a detour, as the upper floor's walls make it", legs.length >= 2, JSON.stringify(legs));
  check("…and its feet are put on the upper floor", Math.abs(ag.pos.y - upperY) < 1e-9, String(ag.pos.y));
}
{
  // a physics pose still held under another clip, as when a posture is
  // relabelled mid-tumble: the root is still low, and the walk plans from
  // the feet
  const ag = agentIn(upperY);
  ag.clip = "idle"; ag.heldPose = { hips: [0, 0, 0, 1] }; ag.heldPoseAuthored = false; ag.pos.y = upperY - 0.7;
  const legs = legsOf(ag, 3.5, 0.5);
  check("a body holding a physics pose under another clip upstairs plans a detour, as the upper floor's walls make it", legs.length >= 2, JSON.stringify(legs));
  check("…and its feet are put on the upper floor", Math.abs(ag.pos.y - upperY) < 1e-9, String(ag.pos.y));
}
{
  // a canned slump, DOWNED_POSE from a knockdown before its sim has run (or
  // with no sim to run), keeps its root where its feet were
  const canned = (y: number, opts = {}) => {
    const ag = agentIn(y, opts);
    ag.knockDown("tester", null, "(knocked over)");
    ag.bodyEpoch++;   // the tumble it starts lapses at its first wait: this is the canned slump it holds until then
    return ag;
  };
  const ag = canned(upperY);
  check("setup: a knockdown holds the canned slump", ag.clip === "ragdoll" && ag.heldPose != null && !ag.heldPoseAuthored, `${ag.clip} ${JSON.stringify(ag.heldPose)?.slice(0, 40)}`);
  const legs = legsOf(ag, 3.5, 0.5);
  check("a body slumped upstairs before any sim has laid it down plans a detour, as the upper floor's walls make it", legs.length >= 2, JSON.stringify(legs));
  check("…and its feet are put on the upper floor", Math.abs(ag.pos.y - upperY) < 1e-9, String(ag.pos.y));
  const up = canned(upperY);
  up.setPosture("idle");
  check("…and standing up, it stands on the upper floor", Math.abs(up.pos.y - upperY) < 1e-9, String(up.pos.y));
  // on the ground under a deck a metre up, a canned slump's feet are on the
  // ground, where a laid-down body's would be within a step of the deck
  const DECK = { levels: [{ y: 3, tiles, walls: [], apertures: [] }] };
  const deckY = planStructure(DECK).levels[0].y;
  const under = canned(deckY - 1, { house: DECK });
  under.heightAt = () => deckY - 1;
  legsOf(under, 2.5, 0.5);
  check("a body slumped before any sim on the ground under a deck a metre up walks on the ground", under.walkRefusal == null && Math.abs(under.pos.y - (deckY - 1)) < 1e-9,
    `${under.pos.y}, ground ${deckY - 1} ${under.walkRefusal ?? ""}`);
  const rise = canned(deckY - 1, { house: DECK });
  rise.heightAt = () => deckY - 1;
  rise.setPosture("idle");
  check("…and standing up, it stands on the ground", Math.abs(rise.pos.y - (deckY - 1)) < 1e-9, `${rise.pos.y}, ground ${deckY - 1}`);
  const cleared = canned(deckY - 1, { house: DECK });
  cleared.heightAt = () => deckY - 1;
  cleared.setPose(null);
  check("…and so does clearing its pose", Math.abs(cleared.pos.y - (deckY - 1)) < 1e-9, `${cleared.pos.y}, ground ${deckY - 1}`);
  // knocked over while holding a pose of its own, the slump is canned all the
  // same: the pose stays held, and the root is where the feet were
  const posed = agentIn(upperY);
  posed.setPose({ hips: [0, 0, 0, 1] });
  posed.knockDown("tester", null, "(knocked over)");
  posed.bodyEpoch++;
  posed.setPosture("idle");
  check("a body knocked over upstairs while holding its own pose stands up on the upper floor", Math.abs(posed.pos.y - upperY) < 1e-9, String(posed.pos.y));
  // and a canned slump given a pose while it lies there walks from its feet
  const repose = canned(upperY);
  repose.setPose({ hips: [0, 0, 0, 1] });
  const reposeLegs = legsOf(repose, 3.5, 0.5);
  check("a canned slump given a pose upstairs walks on the upper floor", reposeLegs.length >= 2 && Math.abs(repose.pos.y - upperY) < 1e-9,
    `${JSON.stringify(reposeLegs)} ${repose.pos.y}`);
  // a body physics has laid, knocked over again, keeps the root it was given
  const again = agentIn(upperY);
  again.clip = "ragdoll"; again.heldPose = { hips: [0, 0, 0, 1] }; again.heldPoseAuthored = false;
  again.pos.y = upperY - 0.7;
  again.knockDown("tester", null, "(knocked over again)");
  again.bodyEpoch++;
  again.setPosture("idle");
  check("a body laid upstairs and knocked over again stands up on the upper floor", Math.abs(again.pos.y - upperY) < 1e-9, String(again.pos.y));
  // once it has stood up, a body knocked over again is a canned slump anew
  again.knockDown("tester", null, "(knocked over a third time)");
  again.bodyEpoch++;
  again.setPosture("idle");
  check("…and once it has stood, knocked over again, it stands up there again", Math.abs(again.pos.y - upperY) < 1e-9, String(again.pos.y));
  // a knockdown's sim moves the root as it runs: from its first frame the
  // slump is no longer canned
  const simmed = canned(upperY);
  simmed.pos.y = upperY - 0.7;   // the sim's frame, settled on the floor
  simmed.setPosture("idle");
  check("a knockdown whose sim has laid it upstairs stands up on the upper floor", Math.abs(simmed.pos.y - upperY) < 1e-9, String(simmed.pos.y));
  // however a canned slump stands up (choosing a posture, clearing its pose,
  // walking), a ragdoll laid there later, as a sim lays one, has its root
  // under its feet again
  const laidLater = (stand: (ag: any) => void) => {
    const ag = canned(upperY);
    stand(ag);
    ag.clip = "ragdoll"; ag.heldPose = { hips: [0, 0, 0, 1] }; ag.heldPoseAuthored = false; ag.pos.y = upperY - 0.7;
    ag.setPose(null);
    return ag.pos.y;
  };
  for (const [how, stand] of [
    ["chose a posture", (ag: any) => ag.setPosture("idle")],
    ["cleared its pose", (ag: any) => ag.setPose(null)],
    ["walked", (ag: any) => legsOf(ag, 3.5, 0.5)],
  ] as const) {
    const y = laidLater(stand);
    check(`a canned slump that ${how}, laid down upstairs later, stands up on the upper floor`, Math.abs(y - upperY) < 1e-9, String(y));
  }
  // a body holding a physics pose under another clip is down already: knocked
  // over there, it keeps the root physics laid
  const held = agentIn(upperY);
  held.clip = "idle"; held.heldPose = { hips: [0, 0, 0, 1] }; held.heldPoseAuthored = false; held.pos.y = upperY - 0.7;
  held.knockDown("tester", null, "(knocked over)");
  held.bodyEpoch++;
  held.setPosture("idle");
  check("a body holding a physics pose under another clip upstairs, knocked over, stands up on the upper floor", Math.abs(held.pos.y - upperY) < 1e-9, String(held.pos.y));
}
{
  const ag = agentIn(upperY);
  ag.flightBegin();
  check("a flight begun upstairs starts from the upper floor", Math.abs(ag.flight?.pos?.y - upperY) < 1e-9, String(ag.flight?.pos?.y));
  ag.pos.y = upperY + 0.2;
  ag.flightEnd();
  check("a flight that ends just above the upper floor leaves the feet on it", Math.abs(ag.pos.y - upperY) < 1e-9, String(ag.pos.y));
}
{
  // A standing flyer's feet are its root: a flight that ends on the terrain
  // under a deck a metre up leaves it there. Read as a laid body's,
  // RAGDOLL_ROOT_DROP above the root, the feet would be within a route step
  // of the deck and stand on it.
  const DECK1 = { levels: [{ y: 0.9, tiles, walls: [], apertures: [] }] };
  const flyer = agentIn(0, { house: DECK1 });
  flyer.flightEnd();
  check("a standing flyer whose flight ends under a deck a metre up stands on the terrain", flyer.pos.y === 0 && !flyer.isSlumped(), `${flyer.pos.y}`);
}

console.log("\na spot named by x/z upstairs is on the upper floor\n");
{
  // name_place's x/z, y left out: "the floor there nearest your height"
  const ag = agentIn(upperY);
  const sent: any[] = [];
  ag.joined = true;
  ag.sendOps = async (ops: any[]) => {   // the authority's answer and the world's echo of a places set
    for (const m of ops) { sent.push(m); if (m.args?.component === "places") { const e = ag.entities.get(m.args.id); e.places = m.args.merge ? { ...(e.places ?? {}), ...m.args.value } : m.args.value; } }
    return { ok: true };
  };
  const said = await ag.namePlaceNow("window", { at: { x: 1.5, z: 0.5 } });
  const at = sent.find((m) => m.args?.component === "places")?.args?.value?.window?.at;
  check("naming a spot by x/z upstairs puts it on the upper floor", Array.isArray(at) && Math.abs(at[1] - upperY) < 1e-3, `${said} ${JSON.stringify(at)}`);
  ag.joined = false;
}

console.log("\nwhat is placed on an upper storey is walked round, as it is on the ground\n");
{
  // navgrid routes round placed models; on a floor walk its probe stands on
  // the walk's own floor (walkProbeGround), since the colliders don't hold a
  // griddled floor. A chest in the middle of an open upper room, in
  // the straight line between two cell centres of one row, from the
  // south wall to past the row's middle, so the way round is north:
  const { boxMesh } = await import("../tools/two-storey-fixture.ts");
  const { registerMeshSupport, removeSupport } = await import("./physics.ts");
  const OPEN = { levels: [{ y: 0, tiles, walls: shell, apertures: [] }, { y: 3, tiles, walls: shell, apertures: [] }] };
  const up = planStructure(OPEN).levels[1].y;
  const ag = agentIn(up, { house: OPEN });
  const { pos, idx } = boxMesh([[1.7, up, 0, 2.3, up + 1, 0.7]]);
  const chest = `${ag.world}/chest`;
  const fitted = await registerMeshSupport("storey-walk-test", chest, { positions: new Float32Array(pos), indices: new Uint32Array(idx) }, { position: [0, 0, 0], yaw: 0, scale: 1 });
  check("setup: the chest is a collider", fitted);
  ag.pos = { x: 0.5, y: up, z: 0.5 };
  ag.joined = true;
  const walk = ag.walkTo(3.5, 0.5, false, 30_000, 0.05);
  const legs = [ag.target, ...ag.legs].filter(Boolean);
  check("the walk across the upper room bends round the chest", legs.length >= 2, JSON.stringify(legs));
  const ys: number[] = [];
  for (let i = 0; i < 600 && ag.target; i++) { ag.tick(); ys.push(ag.pos.y); }
  const arrived = await Promise.race([walk, Bun.sleep(200).then(() => "pending")]);
  check("…and arrives", arrived === true, `${String(arrived)} at (${ag.pos.x.toFixed(2)}, ${ag.pos.z.toFixed(2)}) ${ag.walkStall ?? ""}`);
  check("…with the feet on the upper floor all the way", ys.length > 0 && ys.every((y) => Math.abs(y - up) < 1e-6), String(ys.find((y) => Math.abs(y - up) >= 1e-6)));
  await removeSupport("storey-walk-test", chest);
  ag.joined = false;
}

{
  // A floor walk's grid stands on the whole of the walk's own floor, at its
  // height, where the ground beneath is no more than a step above it, and on
  // what's placed there, but not on the ground: beside a deck, ground within
  // a step below it, and another building's floor at its height, are drops
  // the grid won't take, so it can't leave the floor the walk holds the feet
  // at. Where the ground under the deck itself rises to just below it (its
  // last column, x 3-4, 0.3 m down), the deck is still the walk's floor: the walk
  // crosses it at the deck's height,
  // and once it ends the feet stand on the terrain there, as on a porch, and
  // the next walk is the terrain's. Where the ground rises more than a step
  // above the deck (x 1-2, z 1-2), the deck is buried, and no walk crosses
  // it. The colliders are loaded by now (the chest above), so the walk is
  // routed by the navgrid on this probe.
  const DECK = { levels: [{ y: 3, tiles, walls: [], apertures: [] }] };
  const deckY = planStructure(DECK).levels[0].y;
  const ag = agentIn(deckY, { house: DECK });
  ag.entities.set("next", { id: "next", model: "house", pos: [10, 0, 0], yaw: 0, actor: "test", structure: DECK });
  ag.heightAt = (x: number, z: number) => (x > 3 && x < 10 ? deckY - 0.3
    : x >= 1 && x < 2 && z >= 1 ? deckY + 1 : x >= 2 && x < 3 && z >= 1 ? deckY + 0.3
    : x >= 0 && x < 0.5 && z >= 1 ? deckY + NAV_STEP - 0.02 : x >= 0.5 && x < 1 && z >= 1 ? deckY + NAV_STEP + 0.02 : 0);
  const probe = ag.walkProbeGround(ag.walkSupport());
  check("a floor walk's probe stands on its own floor", Math.abs(probe(0.5, 0.5) - deckY) < 1e-9, String(probe(0.5, 0.5)));
  check("…and on it at its low end, where the ground beneath rises to 0.3 m below it", Math.abs(probe(3.5, 0.5) - deckY) < 1e-9, String(probe(3.5, 0.5)));
  check("…and where the ground comes up within a step above it", Math.abs(probe(2.5, 1.5) - deckY) < 1e-9, String(probe(2.5, 1.5)));
  check("…but where the ground rises more than a step above it, the deck is buried: a drop", deckY - probe(1.5, 1.5) > NAV_STEP, String(probe(1.5, 1.5)));
  check(`…the step being the grid's (${NAV_STEP} m): ground ${(NAV_STEP - 0.02).toFixed(2)} m above it still leaves the deck`, Math.abs(probe(0.25, 1.5) - deckY) < 1e-9, String(probe(0.25, 1.5)));
  check(`…and ground ${(NAV_STEP + 0.02).toFixed(2)} m above it buries it`, deckY - probe(0.75, 1.5) > NAV_STEP, String(probe(0.75, 1.5)));
  check("…beside it, over ground within a step of it, finds a drop the grid won't take", deckY - probe(5, 0.5) > NAV_STEP, String(probe(5, 0.5)));
  check("…and so on another building's floor at its height", deckY - probe(10.5, 0.5) > NAV_STEP, String(probe(10.5, 0.5)));
  ag.joined = true;
  const walk = ag.walkTo(3.5, 0.5, false, 30_000, 0.05);
  const ys: number[] = [];
  for (let i = 0; i < 3000 && ag.target; i++) { ag.tick(); ys.push(ag.pos.y); }
  const arrived = await walk;
  check("a walk across the deck to its low end arrives there, at the deck's height all the way",
    arrived === true && Math.hypot(ag.pos.x - 3.5, ag.pos.z - 0.5) <= 0.05 && ys.length > 0 && ys.every((y) => Math.abs(y - deckY) < 1e-6),
    `${String(arrived)} at (${ag.pos.x.toFixed(2)}, ${ag.pos.z.toFixed(2)}), ${String(ys.find((y) => Math.abs(y - deckY) >= 1e-6))}`);
  const down = landing(ag, deckY - 0.3);
  check("…and then stands on the terrain there, and its next walk is the terrain's",
    down.ok && ag.walkSupport().kind === "terrain", `${down.detail} ${ag.walkSupport().kind}`);
  ag.joined = false;
  // Where the ground comes up within a step above the deck (x 2-3, z 1-2),
  // a walk crosses at the deck's height too, and once it ends the feet go up
  // onto the terrain there.
  const up = agentIn(deckY, { house: DECK });
  up.heightAt = ag.heightAt;
  up.joined = true;
  const upWalk = up.walkTo(2.5, 1.5, false, 30_000, 0.05);
  for (let i = 0; i < 3000 && up.target; i++) up.tick();
  const upArrived = await upWalk;
  const rise = landing(up, deckY + 0.3);
  check("a walk to where the ground is within a step above the deck arrives, and then the feet stand on the terrain there",
    upArrived === true && Math.hypot(up.pos.x - 2.5, up.pos.z - 1.5) <= 0.05 && rise.ok, `${String(upArrived)} at (${up.pos.x.toFixed(2)}, ${up.pos.z.toFixed(2)}), ${rise.detail}`);
  up.joined = false;
  // The same walks given the deck's height as y: where the ground comes
  // within a step of the deck, the ground there is the walk's own floor, so
  // neither is taken for a walk to another floor.
  for (const [what, x, z, y] of [["its low end, the deck's height as y", 3.5, 0.5, deckY], ["its low end, the ground's height there as y", 3.5, 0.5, deckY - 0.3],
    ["where the ground is within a step above it, the deck's height as y", 2.5, 1.5, deckY]] as const) {
    const w = agentIn(deckY, { house: DECK });
    w.heightAt = ag.heightAt;
    w.joined = true;
    const receipt = { refusal: null as string | null };
    const walked = w.walkTo(x, z, false, 30_000, 0.05, y, {}, receipt);
    for (let i = 0; i < 3000 && w.target; i++) w.tick();
    const got = await Promise.race([walked, Bun.sleep(300).then(() => "pending")]);
    check(`a walk across the deck to ${what} arrives there`, got === true && Math.hypot(w.pos.x - x, w.pos.z - z) <= 0.05, `${String(got)} ${receipt.refusal ?? ""}`);
    w.joined = false;
  }
}
{
  // A deck a step (NAV_STEP) above the terrain is one rule's edge
  // for both standing (storeyUnder) and a destination's floor (floorMeant):
  // just under a step up it is the terrain's, so a walk on it is the
  // terrain's, and goes down; just over, it is a storey, which a walk from it
  // can't leave. A walk from the ground isn't checked (#200 doesn't change
  // ground walks).
  for (const [h, storey] of [[+(NAV_STEP - 0.02).toFixed(2), false], [+(NAV_STEP + 0.02).toFixed(2), true]] as const) {
    const LOW = { levels: [{ y: h - 0.1, tiles, walls: [], apertures: [] }] };
    const lowY = planStructure(LOW).levels[0].y;
    const on = agentIn(lowY, { house: LOW });
    const NONE = { entity: "none", level: -2 };   // a walk's own floor that isn't here
    const kind = on.walkSupport().kind, top = on.floorMeant(2.5, 1.5, lowY, {}, NONE)?.entity, groundOf = on.floorMeant(2.5, 1.5, 0, {}, NONE)?.entity;
    const down = await tryWalk(on, 2.5, 1.5, 0);
    const off = agentIn(0, { house: LOW });
    off.pos = { x: -1, y: 0, z: 0.5 };
    const up = await tryWalk(off, 2.5, 1.5, lowY);
    check(`a deck ${h} m up ${storey ? "is a storey: standing on it, and a walk from it to the ground is refused" : "is the terrain's: standing on it, and a walk from it to the ground sets off"}`,
      Math.abs(lowY - h) < 1e-9 && (storey
        ? kind === "floor" && top === "house" && groundOf === null && /is at ground level/.test(down.refusal) && up.setOff
        : kind === "terrain" && top === null && groundOf === null && down.setOff && up.setOff),
      `top at ${lowY}: support ${kind}, its top ${top}, the ground ${groundOf}; down ${JSON.stringify(down)}; up ${JSON.stringify(up)}`);
    if (storey) {
      // nearest, not highest: y 0.1 is the ground's though the deck fits too,
      // and halfway between the two, the tie goes to the walk's own floor
      const own = on.walkSupport(), near01 = on.floorMeant(2.5, 1.5, 0.1, {}, own)?.entity, tieOn = on.floorMeant(2.5, 1.5, h / 2, {}, own)?.entity, tieNone = on.floorMeant(2.5, 1.5, h / 2, {}, NONE)?.entity;
      check("…the floor a height means is the nearest that fits, ties going to the walk's own floor, else to the higher",
        near01 === null && tieOn === "house" && tieNone === "house", `y 0.1: ${near01}; halfway, from the deck: ${tieOn}, for no walk's floor: ${tieNone}`);
    }
  }
}
{
  // A pose the body chose for itself leaves it standing where it is. Under a
  // deck a metre up, a slumped body's feet, RAGDOLL_ROOT_DROP above its y,
  // would be within a step of the deck; this body's are on the ground.
  const DECK = { levels: [{ y: 3, tiles, walls: [], apertures: [] }] };
  const deckY = planStructure(DECK).levels[0].y;
  const ag = agentIn(deckY - 1, { house: DECK });
  ag.heightAt = () => deckY - 1;
  ag.setPose({ hips: [0, 0, 0, 1] });
  legsOf(ag, 2.5, 0.5);
  check("a body holding its own pose on the ground under a deck a metre up walks on the ground",
    ag.walkRefusal == null && Math.abs(ag.pos.y - (deckY - 1)) < 1e-9, `${ag.pos.y}, ground ${deckY - 1} ${ag.walkRefusal ?? ""}`);
}
{
  // Where the only way round something placed on a deck is off it, a floor
  // walk is refused rather than routed over the ground beside the deck,
  // however close below that ground is. A deck one row wide (z 0-1), and a
  // chest across it from its south edge to 0.2 m short of its north edge,
  // too narrow a gap for a body; the ground beside the deck is a step down.
  const { boxMesh } = await import("../tools/two-storey-fixture.ts");
  const { registerMeshSupport, removeSupport } = await import("./physics.ts");
  const ROW = { levels: [{ y: 3, tiles: [[0, 0], [1, 0], [2, 0], [3, 0]], walls: [], apertures: [] }] };
  const deckY = planStructure(ROW).levels[0].y;
  const ag = agentIn(deckY, { house: ROW });
  ag.heightAt = (_x: number, z: number) => (z < 0 || z >= 1 ? deckY - 0.3 : 0);
  const { pos, idx } = boxMesh([[1.7, deckY, 0, 2.3, deckY + 1, 0.8]]);
  const chest = `${ag.world}/row-chest`;
  const fitted = await registerMeshSupport("storey-walk-test", chest, { positions: new Float32Array(pos), indices: new Uint32Array(idx) }, { position: [0, 0, 0], yaw: 0, scale: 1 });
  check("setup: the chest across the deck is a collider", fitted);
  ag.pos = { x: 0.5, y: deckY, z: 0.5 };
  ag.joined = true;
  const walk = ag.walkTo(3.5, 0.5, false, 30_000, 0.05);
  for (let i = 0; i < 600 && ag.target; i++) ag.tick();
  const walked = await Promise.race([walk, Bun.sleep(300).then(() => "pending")]);
  check("a floor walk whose only way round a chest is off the deck is refused, not routed over the ground beside it",
    walked === false && /no walkable way/.test(ag.walkRefusal ?? ""), `${String(walked)} ${ag.walkRefusal}`);
  await removeSupport("storey-walk-test", chest);
  ag.joined = false;
}
{
  // A body a sim has laid down on something placed, a platform 0.4 m high,
  // gets up on it to walk across it: the walk starts from its feet, on the
  // platform, not from its root, under the platform's top.
  const { boxMesh } = await import("../tools/two-storey-fixture.ts");
  const { registerMeshSupport, removeSupport } = await import("./physics.ts");
  const ag = agentIn(0);
  ag.heightAt = () => 0;
  const { pos, idx } = boxMesh([[6, 0, 6, 10, 0.4, 8]]);
  const platform = `${ag.world}/platform`;
  const fitted = await registerMeshSupport("storey-walk-test", platform, { positions: new Float32Array(pos), indices: new Uint32Array(idx) }, { position: [0, 0, 0], yaw: 0, scale: 1 });
  check("setup: the platform is a collider", fitted);
  ag.pos = { x: 6.5, y: 0.4 - 0.7, z: 7 };
  ag.clip = "ragdoll"; ag.heldPose = { hips: [0, 0, 0, 1] }; ag.heldPoseAuthored = false;
  void ag.walkTo(9.5, 7);
  check("a body laid down on a platform starts its walk across it standing on it", ag.walkRefusal == null && Math.abs(ag.pos.y - 0.4) < 1e-6,
    `${ag.pos.y} ${ag.walkRefusal ?? ""}`);
  ag.stop();
  await removeSupport("storey-walk-test", platform);
}
{
  // A canned slump on the ground under a table top 0.65 m up stands up on
  // the ground; a body laid down by a sim there would be read as on the table.
  const { boxMesh } = await import("../tools/two-storey-fixture.ts");
  const { registerMeshSupport, removeSupport } = await import("./physics.ts");
  const ag = agentIn(0);
  ag.heightAt = () => 0;
  const { pos, idx } = boxMesh([[6, 0.6, 6, 8, 0.65, 8]]);
  const table = `${ag.world}/table`;
  const fitted = await registerMeshSupport("storey-walk-test", table, { positions: new Float32Array(pos), indices: new Uint32Array(idx) }, { position: [0, 0, 0], yaw: 0, scale: 1 });
  check("setup: the table top is a collider", fitted);
  ag.pos = { x: 7, y: 0, z: 7 };
  ag.knockDown("tester", null, "(knocked over)");
  ag.bodyEpoch++;   // the tumble it starts lapses at its first wait: this is the canned slump it holds until then
  ag.setPosture("idle");
  check("a body slumped before any sim, under a table, stands up on the ground", Math.abs(ag.pos.y) < 1e-6, String(ag.pos.y));
  // with no body to simulate, the tumble's fallback moves the slump along the
  // shove without lifting or lowering it, its root still at its feet's height:
  // canned all the same
  const shoved = agentIn(0);
  shoved.heightAt = () => 0;
  shoved.body = null;
  shoved.pos = { x: 7, y: 0, z: 7 };
  shoved.knockDown("tester", [1, 0, 0], "(shoved over)");
  for (let i = 0; i < 1000 && shoved.pos.x === 7; i++) await Bun.sleep(5);   // at most 1000 waits of 5 ms, done once it moves
  check("setup: with no body, the fallback moves the slump 0.4 m along the shove, still under the table, at the same height",
    Math.abs(shoved.pos.x - 7.4) < 1e-9 && shoved.pos.z === 7 && shoved.pos.y === 0, `${shoved.pos.x}, ${shoved.pos.y}, ${shoved.pos.z}`);
  shoved.setPosture("idle");
  check("…and it stands up on the ground", Math.abs(shoved.pos.y) < 1e-6, String(shoved.pos.y));
  await removeSupport("storey-walk-test", table);
}
{
  // A body a sim has laid on a bed 0.6 m above an upper floor stands up on
  // the bed, its feet RAGDOLL_ROOT_DROP above its root, over the floor.
  const { boxMesh } = await import("../tools/two-storey-fixture.ts");
  const { registerMeshSupport, removeSupport } = await import("./physics.ts");
  const ag = agentIn(upperY);
  const { pos, idx } = boxMesh([[0.2, upperY, 0.2, 0.8, upperY + 0.6, 0.8]]);
  const bed = `${ag.world}/bed`;
  const fitted = await registerMeshSupport("storey-walk-test", bed, { positions: new Float32Array(pos), indices: new Uint32Array(idx) }, { position: [0, 0, 0], yaw: 0, scale: 1 });
  check("setup: the bed is a collider", fitted);
  ag.clip = "ragdoll"; ag.heldPose = { hips: [0, 0, 0, 1] }; ag.heldPoseAuthored = false;
  ag.pos.y = upperY + 0.6 - 0.7;
  ag.setPosture("idle");
  check("a body laid down on a bed upstairs stands up on the bed", Math.abs(ag.pos.y - (upperY + 0.6)) < 1e-6, `${ag.pos.y}, bed ${upperY + 0.6}`);
  await removeSupport("storey-walk-test", bed);
}

console.log("\nGreptile's review of October 19: a floor walk's lowest ground, the storey's height, a laid body's feet\n");
{
  // A floor walk's feet go no lower than its floor's height, so its grid
  // stands nowhere lower (onOrAboveFloor). On a one-row deck with a chest
  // across it, each walk round the chest below is refused, where the grid
  // used to route it with the feet held at the deck's height over the air.
  const { boxMesh } = await import("../tools/two-storey-fixture.ts");
  const { registerMeshSupport, removeSupport } = await import("./physics.ts");
  const deckOf = (n: number) => ({ levels: [{ y: 3, tiles: Array.from({ length: n }, (_, i) => [i, 0]), walls: [], apertures: [] }] });
  const ROW = deckOf(4);
  const deckY = planStructure(ROW).levels[0].y;
  const walkPast = async (name: string, house: any, parts: [string, number[][]][], toX: number) => {
    const ag = agentIn(deckY, { house });
    ag.heightAt = () => 0;
    let fitted = true;
    for (const [part, boxes] of parts) {
      const { pos, idx } = boxMesh(boxes as any);
      fitted = (await registerMeshSupport("storey-walk-test", `${ag.world}/${name}-${part}`, { positions: new Float32Array(pos), indices: new Uint32Array(idx) }, { position: [0, 0, 0], yaw: 0, scale: 1 })) && fitted;
    }
    check(`setup: the ${name}'s pieces are colliders`, fitted);
    ag.pos = { x: 0.5, y: deckY, z: 0.5 };
    ag.joined = true;
    const walk = ag.walkTo(toX, 0.5, false, 30_000, 0.05);
    const ys: number[] = [];
    for (let i = 0; i < 2000 && ag.target; i++) { ag.tick(); ys.push(ag.pos.y); }
    const walked = await Promise.race([walk, Bun.sleep(300).then(() => "pending")]);
    for (const [part] of parts) await removeSupport("storey-walk-test", `${ag.world}/${name}-${part}`);
    ag.joined = false;
    return { walked, refusal: ag.walkRefusal ?? "", ys, end: { ...ag.pos } };
  };
  const chest: [string, number[][]] = ["chest", [[1.7, deckY, 0, 2.3, deckY + 1, 0.8]]];
  // Greptile's case: stairs of placed slabs, 0.3 m a tread, beside the deck
  // lead down to within a step of the drop walkProbeGround answers off it;
  // the walk went down one stair, across the open air at that drop and up
  // the other.
  const stairs = (x0: number, x1: number) => [[x0, deckY - 0.35, 1.0, x1, deckY - 0.3, 1.6],
    [x0, deckY - 0.65, 1.6, x1, deckY - 0.6, 2.2], [x0, deckY - 0.95, 2.2, x1, deckY - 0.9, 2.8]];
  const down = await walkPast("stairs down", ROW, [chest, ["stairs-a", stairs(0.2, 1.4)], ["stairs-b", stairs(2.6, 3.8)]], 3.5);
  check("a floor walk doesn't go down placed stairs beside its deck and across the air below: the walk round the chest is refused",
    down.walked === false && /no walkable way/.test(down.refusal), `${String(down.walked)} ${down.refusal}`);
  // a platform a step below the deck, beside it the whole way round the
  // chest: within a step, but the feet would be held 0.3 m above it
  const platform = await walkPast("platform", ROW, [chest, ["platform", [[0.2, deckY - 0.35, 1.0, 3.8, deckY - 0.3, 2.0]]]], 3.5);
  check("…nor onto a placed platform a step below the deck to get round it: that walk is refused too",
    platform.walked === false && /no walkable way/.test(platform.refusal), `${String(platform.walked)} ${platform.refusal}`);
}
{
  // A storey holds the feet from a route step below its floor to just under
  // its height above it (the grid's wallH, 2.8 m by default): feet on
  // something placed on the floor are on the storey. At 0.53 m above it they
  // used to be the terrain's.
  const support = (y: number) => agentIn(y).walkSupport();
  const on = support(upperY + 0.53);
  check("feet on a top 0.53 m above the upper floor are on the upper storey", on.kind === "floor" && Math.abs(on.height - upperY) < 1e-9, JSON.stringify(on));
  const tall = support(upperY + 2.7);
  check("…and so are feet 2.7 m above it, inside its 2.8 m", tall.kind === "floor" && Math.abs(tall.height - upperY) < 1e-9, JSON.stringify(tall));
  const roof = support(upperY + 2.8);
  check("…but feet a storey's height above it aren't", roof.kind === "terrain", JSON.stringify(roof));
  // The height is the structure's own wallH, in the building's frame.
  const HIGH = { ...HOUSE, wallH: 4 };
  const highUp = planStructure(HIGH).levels[1].y;
  const high = agentIn(highUp + 3.5, { house: HIGH }).walkSupport();
  check("with a wallH of 4 m, feet 3.5 m above the upper floor are on its storey", high.kind === "floor" && Math.abs(high.height - highUp) < 1e-9, JSON.stringify(high));
  const big = agentIn(upperY + 2.5, { scale: 2 }).walkSupport();
  check("in a building at scale 2, feet 5 m above the upper floor, 2.5 m in its frame, are on its storey",
    big.kind === "floor" && Math.abs(big.height - 2 * upperY) < 1e-9, JSON.stringify(big));
  const bigRoof = agentIn(upperY + 2.9, { scale: 2 }).walkSupport();
  check("…but feet 5.8 m above it, 2.9 m in its frame, aren't", bigRoof.kind === "terrain", JSON.stringify(bigRoof));
  // Where two storeys' ranges meet, the higher floor wins.
  const TALL = { levels: [{ y: 0, tiles, walls: shell, apertures: [] }, { y: 3, tiles, walls: shell, apertures: [] }, { y: 6, tiles, walls: shell, apertures: [] }] };
  const tallPlan = planStructure(TALL), mid = tallPlan.levels[1].y, top = tallPlan.levels[2].y;
  const near = agentIn(top - 0.3, { house: TALL }).walkSupport();
  check("feet a route step under the top floor, inside the middle storey's height too, are on the top storey: the higher floor wins",
    near.kind === "floor" && Math.abs(near.height - top) < 1e-9, `${JSON.stringify(near)} (middle ${mid}, top ${top})`);
  const inMid = agentIn(mid + 2.0, { house: TALL }).walkSupport();
  check("…and feet 2 m above the middle floor, more than a route step under the top one, are on the middle storey",
    inMid.kind === "floor" && Math.abs(inMid.height - mid) < 1e-9, JSON.stringify(inMid));
}
{
  // A body a sim lays on a table upstairs stands up on the table and walks
  // on across the upper floor, its feet on the table to its edge, then
  // down to the floor.
  const { boxMesh } = await import("../tools/two-storey-fixture.ts");
  const { registerMeshSupport, removeSupport } = await import("./physics.ts");
  const OPEN = { levels: [{ y: 0, tiles, walls: shell, apertures: [] }, { y: 3, tiles, walls: shell, apertures: [] }] };
  const up = planStructure(OPEN).levels[1].y;
  const ag = agentIn(up, { house: OPEN });
  const { pos, idx } = boxMesh([[1.5, up, 0.5, 2.5, up + 0.75, 1.5]]);
  const table = `${ag.world}/upstairs-table`;
  const fitted = await registerMeshSupport("storey-walk-test", table, { positions: new Float32Array(pos), indices: new Uint32Array(idx) }, { position: [0, 0, 0], yaw: 0, scale: 1 });
  check("setup: the table upstairs is a collider", fitted);
  ag.pos = { x: 2.0, y: up + 0.75 - 0.7, z: 1.0 };   // as a sim lays a body on the table
  ag.clip = "ragdoll"; ag.heldPose = { hips: [0, 0, 0, 1] }; ag.heldPoseAuthored = false;
  ag.setPose(null);
  check("a body laid on a table 0.75 m above the upper floor stands up on the table", Math.abs(ag.pos.y - (up + 0.75)) < 1e-6, String(ag.pos.y));
  ag.joined = true;
  // a walk the structure planner routes in legs, through the cells' centres
  const walk = ag.walkTo(3.5, 1.5, false, 30_000, 0.05);
  const ys: number[] = [], overTable: number[] = [];
  for (let i = 0; i < 3000 && ag.target; i++) {
    ag.tick(); ys.push(ag.pos.y);
    if (ag.pos.x > 1.55 && ag.pos.x < 2.45 && ag.pos.z > 0.55 && ag.pos.z < 1.45) overTable.push(ag.pos.y);
  }
  const arrived = await Promise.race([walk, Bun.sleep(300).then(() => "pending")]);
  check("…and walks on from it across the upper floor, its feet on the table's top while over it, never below the floor, ending on it",
    arrived === true && overTable.length > 0 && overTable.every((y) => Math.abs(y - (up + 0.75)) < 0.02)
      && ys.every((y) => y >= up - 1e-6) && Math.abs(ag.pos.y - up) < 1e-6,
    `${String(arrived)} ${ag.walkRefusal ?? ""} over the table ${overTable.map((y) => y.toFixed(3)).join(" ")}; lowest ${ys.length ? Math.min(...ys) : NaN}, end ${ag.pos.y}`);
  await removeSupport("storey-walk-test", table);
  ag.joined = false;
  // What's placed above the floor stays standable for a floor walk's grid
  // (onOrAboveFloor), where the feet stand: a body stood up on a stage 0.75 m
  // tall upstairs walks along it on its top. The walk runs along row 0's
  // cell centres, so the planner leaves it one leg, which the grid routes.
  const onStage = agentIn(up, { house: OPEN });
  const stageBox = boxMesh([[0.8, up, 0.1, 3.2, up + 0.75, 0.9]]);
  const stage = `${onStage.world}/upstairs-stage`;
  check("setup: the stage upstairs is a collider", await registerMeshSupport("storey-walk-test", stage,
    { positions: new Float32Array(stageBox.pos), indices: new Uint32Array(stageBox.idx) }, { position: [0, 0, 0], yaw: 0, scale: 1 }));
  onStage.pos = { x: 1.2, y: up + 0.75 - 0.7, z: 0.5 };
  onStage.clip = "ragdoll"; onStage.heldPose = { hips: [0, 0, 0, 1] }; onStage.heldPoseAuthored = false;
  onStage.setPose(null);
  onStage.joined = true;
  const along = onStage.walkTo(2.8, 0.5, false, 30_000, 0.05);
  const alongLegs = [onStage.target, ...onStage.legs].filter(Boolean).length;
  const sy: number[] = [];
  for (let i = 0; i < 3000 && onStage.target; i++) { onStage.tick(); sy.push(onStage.pos.y); }
  const alongDone = await Promise.race([along, Bun.sleep(300).then(() => "pending")]);
  check("a body standing on a stage upstairs walks along its top in one leg, its feet on it all the way",
    alongDone === true && alongLegs === 1 && sy.length > 0 && sy.every((y) => Math.abs(y - (up + 0.75)) < 0.02),
    `${String(alongDone)} ${onStage.walkRefusal ?? ""} legs ${alongLegs}, lowest ${sy.length ? Math.min(...sy) : NaN}, stage ${up + 0.75}`);
  await removeSupport("storey-walk-test", stage);
  onStage.joined = false;
}
{
  // A laid body's floor is found from its feet, RAGDOLL_ROOT_DROP above its
  // root, for a takeoff, a spot it names, and the tick: from the root it was
  // the terrain's.
  const { devFlightProvider } = await import("../shared/flightcap.js");
  const WINGED = ["Hip", "Spine02", "Head", "L_Wing_Upper", "L_Wing_Upper_1", "R_Wing_Upper", "R_Wing_Upper_1", "L_Wing_Lower", "R_Wing_Lower"];
  const flier = (laid: boolean) => {
    const ag = agentIn(upperY);
    ag.avatar = "winged.vrm";
    ag.bodyBoneNames = WINGED; ag.bodyBonesFor = ag.avatar;
    ag.flightCap = devFlightProvider({ allow: [ag.name], bones: WINGED });
    if (laid) { ag.clip = "ragdoll"; ag.heldPose = { hips: [0, 0, 0, 1] }; ag.heldPoseAuthored = false; ag.pos.y = upperY - 0.7; }
    return ag;
  };
  const standing = flier(false), laid = flier(true);
  const saidStanding = await standing.takeOff(), saidLaid = await laid.takeOff();
  check("a body laid down upstairs takes off from the upper floor, as a standing one does",
    /took off/.test(saidLaid) && Math.abs(laid.flight?.pos?.y - standing.flight?.pos?.y) < 1e-9,
    `laid "${saidLaid}" at ${laid.flight?.pos?.y}, standing "${saidStanding}" at ${standing.flight?.pos?.y}`);
  standing.flight = null; laid.flight = null;

  // a flight that ends with the body laid down upstairs, as a flight's
  // ragdoll leaves it, puts its feet on the upper floor
  const lander = agentIn(upperY);
  lander.clip = "ragdoll"; lander.heldPose = { hips: [0, 0, 0, 1] }; lander.heldPoseAuthored = false; lander.pos.y = upperY - 0.7;
  lander.flightEnd();
  check("a flight that ends with the body laid down upstairs stands it on the upper floor", Math.abs(lander.pos.y - upperY) < 1e-9, String(lander.pos.y));

  const namer = agentIn(upperY);
  namer.clip = "ragdoll"; namer.heldPose = { hips: [0, 0, 0, 1] }; namer.heldPoseAuthored = false; namer.pos.y = upperY - 0.7;
  const sent: any[] = [];
  namer.joined = true;
  namer.sendOps = async (ops: any[]) => {   // the authority's answer and the world's echo of a places set
    for (const m of ops) { sent.push(m); if (m.args?.component === "places") { const e = namer.entities.get(m.args.id); e.places = m.args.merge ? { ...(e.places ?? {}), ...m.args.value } : m.args.value; } }
    return { ok: true };
  };
  const said = await namer.namePlaceNow("sill", { at: { x: 1.5, z: 0.5 } });
  const at = sent.find((m) => m.args?.component === "places")?.args?.value?.sill?.at;
  check("a body laid down upstairs names a spot by x/z on the upper floor", Array.isArray(at) && Math.abs(at[1] - upperY) < 1e-3, `${said} ${JSON.stringify(at)}`);
  namer.joined = false;

  // the tick holds a body lying in a physics pose under another clip to the
  // storey under its feet, not the ground under its root
  const held = agentIn(upperY);
  held.clip = "idle"; held.heldPose = { hips: [0, 0, 0, 1] }; held.heldPoseAuthored = false; held.pos.y = upperY - 0.7;
  held.joined = true;
  const ys: number[] = [];
  for (let i = 0; i < 30; i++) { held.tick(); ys.push(held.pos.y); }
  // the tick stands a held physics pose's feet on its ground, as it does on
  // the terrain, here the upper floor
  check("the tick keeps a body lying upstairs in a physics pose under another clip on its storey, standing it on the upper floor",
    ys.every((y) => y >= upperY - 0.7 - 1e-6) && Math.abs(ys.at(-1)! - upperY) < 1e-6, `${ys.slice(0, 3).join(" ")} … ${ys.at(-1)}, root laid at ${upperY - 0.7}`);
  held.joined = false;

  // what a body laid down upstairs is told: the upper floor's room, found
  // from its feet, not the ground floor's under its root
  const upstairsRoom = describeHere(plan, 0.5, 0.5, upperY)!, groundRoom = describeHere(plan, 0.5, 0.5, 0.1)!;
  check("setup: the kitchen upstairs and the room below are described apart", !!upstairsRoom && !!groundRoom && upstairsRoom !== groundRoom, `${upstairsRoom} | ${groundRoom}`);
  const lying = agentIn(upperY);
  lying.clip = "ragdoll"; lying.heldPose = { hips: [0, 0, 0, 1] }; lying.heldPoseAuthored = false; lying.pos.y = upperY - 0.7;
  const told = String(lying.look()).split("\n").find((l: string) => l.includes("(inside [house]")) ?? "";
  check("a body laid down upstairs is told the upper floor's room, as a standing one is", told.startsWith(upstairsRoom), told);
}
console.log(failures ? `\n${failures} failed` : "\nall passed");
process.exit(failures ? 1 : 0);
