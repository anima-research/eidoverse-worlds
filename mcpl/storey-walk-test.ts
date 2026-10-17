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
  ag.entities.set("house", { id: "house", lib: "house", pos: opts.pos ?? [0, 0, 0], yaw: 0, actor: "test",
    ...(opts.scale ? { scale: opts.scale } : {}), comp: { structure: opts.house ?? HOUSE } });
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
  // the terrain is the terrain's too: a floor walk's grid could step off it
  const LOW = { levels: [{ y: 0.43, tiles, walls: [], apertures: [] }] };
  const lowY = planStructure(LOW).levels[0].y;
  const ag = agentIn(lowY, { house: LOW });
  check("a floor within the walk grid's step of the terrain (0.53 m) doesn't hold the feet either", ag.groundAt(ag.pos.x, ag.pos.z) === 0, `${ag.groundAt(ag.pos.x, ag.pos.z)} (floor ${lowY})`);
  const ABOVE = { levels: [{ y: 0.5, tiles, walls: [], apertures: [] }] };
  const aboveY = planStructure(ABOVE).levels[0].y;
  const up = agentIn(aboveY, { house: ABOVE });
  check("…and one just past it (0.6 m) does", Math.abs(up.groundAt(up.pos.x, up.pos.z) - aboveY) < 1e-9, `${up.groundAt(up.pos.x, up.pos.z)} (floor ${aboveY})`);
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
  ag.entities.set("next", { id: "next", lib: "house", pos: [10, 0, 0], yaw: 0, actor: "test", comp: { structure: DECK } });
  ag.heightAt = (x: number, z: number) => (x > 3 && x < 10 ? deckY - 0.3
    : x >= 1 && x < 2 && z >= 1 ? deckY + 1 : x >= 2 && x < 3 && z >= 1 ? deckY + 0.3
    : x >= 0 && x < 0.5 && z >= 1 ? deckY + 0.53 : x >= 0.5 && x < 1 && z >= 1 ? deckY + 0.57 : 0);
  const probe = ag.walkProbeGround(ag.walkSupport());
  check("a floor walk's probe stands on its own floor", Math.abs(probe(0.5, 0.5) - deckY) < 1e-9, String(probe(0.5, 0.5)));
  check("…and on it at its low end, where the ground beneath rises to 0.3 m below it", Math.abs(probe(3.5, 0.5) - deckY) < 1e-9, String(probe(3.5, 0.5)));
  check("…and where the ground comes up within a step above it", Math.abs(probe(2.5, 1.5) - deckY) < 1e-9, String(probe(2.5, 1.5)));
  check("…but where the ground rises more than a step above it, the deck is buried: a drop", deckY - probe(1.5, 1.5) > NAV_STEP, String(probe(1.5, 1.5)));
  check("…the step being the grid's (0.55 m): ground 0.53 m above it still leaves the deck", Math.abs(probe(0.25, 1.5) - deckY) < 1e-9, String(probe(0.25, 1.5)));
  check("…and ground 0.57 m above it buries it", deckY - probe(0.75, 1.5) > NAV_STEP, String(probe(0.75, 1.5)));
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
console.log(failures ? `\n${failures} failed` : "\nall passed");
process.exit(failures ? 1 : 0);
