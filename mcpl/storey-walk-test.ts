/**
 * Storey-aware walking on a bare WorldAgent — the product half of ew#140.
 *
 * Run: bun mcpl/storey-walk-test.ts
 *
 * The planner tests (tools/structure-field-test.ts §13a) prove that
 * routeLocal honours a storey when it is TOLD the height. This proves the
 * door tells it: walkTo() used to clamp the body to the terrain before it
 * localized the point it handed the router, so a body upstairs was routed
 * against the ground floor. The effective height (groundAt) is the terrain
 * unless the body stands on an upper storey's floor at its cell — the body's
 * own y only bounds which real floor qualifies, never becomes the height.
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

function agentIn(y: number, opts: { pos?: number[]; scale?: number } = {}) {
  const ag: any = new WorldAgent({ name: "climber", world: "test" });
  ag.entities.set("house", { id: "house", lib: "house", pos: opts.pos ?? [0, 0, 0], yaw: 0, actor: "test",
    ...(opts.scale ? { scale: opts.scale } : {}), comp: { structure: HOUSE } });
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

console.log(failures ? `\n${failures} failed` : "\nall passed");
process.exit(failures ? 1 : 0);
