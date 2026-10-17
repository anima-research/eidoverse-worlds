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
import { planStructure } from "../shared/structure.js";

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
  ag.entities.set("house", { id: "house", lib: "house", pos: opts.pos ?? [0, 0, 0], yaw: 0, actor: "test",
    ...(opts.scale ? { scale: opts.scale } : {}), comp: { structure: opts.house ?? HOUSE } });
  const [px, py, pz] = opts.pos ?? [0, 0, 0];
  const s = opts.scale ?? 1;
  ag.pos = { x: px + 0.5 * s, y: py + y * s, z: pz + 0.5 * s };
  return ag;
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
    const ag = agentIn(upperY, { before: { junk: { lib: "junk", comp: { structure: junk } } } });
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
    ok === false && /isn't on this floor/.test(String(ag.walkRefusal)), String(ag.walkRefusal));
  check("…and the feet stay upstairs", Math.abs(ag.pos.y - upperY) < 1e-9, String(ag.pos.y));
}
{
  // a slumped body's root lies RAGDOLL_ROOT_DROP (0.7m) below the floor
  // holding it; clearing the slump (setPose(null)) is standing up
  const ag = agentIn(upperY);
  ag.clip = "ragdoll"; ag.pos.y = upperY - 0.7;
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
  const ag = agentIn(upperY);
  ag.flightBegin();
  check("a flight begun upstairs starts from the upper floor", Math.abs(ag.flight?.pos?.y - upperY) < 1e-9, String(ag.flight?.pos?.y));
  ag.pos.y = upperY + 0.2;
  ag.flightEnd();
  check("a flight that ends just above the upper floor leaves the feet on it", Math.abs(ag.pos.y - upperY) < 1e-9, String(ag.pos.y));
}

console.log("\na spot named by x/z upstairs is on the upper floor\n");
{
  // name_place's x/z, y left out: "the floor there nearest your height"
  const ag = agentIn(upperY);
  const sent: any[] = [];
  ag.joined = true;
  ag.ws = { readyState: 1, send: (raw: string) => {
    const m = JSON.parse(raw);
    sent.push(m);
    if (m.verb === "comp") ag.entities.get(m.args.id).comp.places = m.args.data;   // the world's echo
  } };
  const said = await ag.namePlaceNow("window", { at: { x: 1.5, z: 0.5 } });
  const at = sent.find((m) => m.verb === "comp")?.args?.data?.window?.at;
  check("naming a spot by x/z upstairs puts it on the upper floor", Array.isArray(at) && Math.abs(at[1] - upperY) < 1e-3, `${said} ${JSON.stringify(at)}`);
  ag.joined = false;
}

console.log("\nwhat is placed on an upper storey is walked round, as it is on the ground\n");
{
  // navgrid routes round placed models; on a floor walk its probe stands on
  // the storey (groundAt at the floor's height), since the colliders don't
  // hold a griddled floor. A chest in the middle of an open upper room, in
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

console.log(failures ? `\n${failures} failed` : "\nall passed");
process.exit(failures ? 1 : 0);
