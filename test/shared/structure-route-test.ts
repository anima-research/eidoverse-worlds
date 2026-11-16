// bun test/shared/structure-route-test.ts — routing over a griddled structure (shared/structure.js, shared/structure-route.js),
// renderer/server-free. A planned route never crosses an authored solid wall (a door or arch is open, a window is not, a
// diagonal is a wall), checked by test/shared/structure-oracle.ts apart from the planner; where no route exists it is refused
// with the router's one reason.
//   1. the route table   2. caps and the worst case   3. support bases
// The agent walks over these routes keep their own processes (structure-oracle.ts says why): structure-threshold-test
// (walkTo, the move tool, transformed frames' support and the authored-plan cache, merged) and walk-support-lifecycle-test
// (how a walk ends).
import { strict as assert } from "node:assert";
import { planStructure, prepareRouteLocal } from "../../shared/structure.js";
import { NON_FINITE_ENDPOINT, ROUTE_MAX_CELLS } from "../../shared/structure-route.js";
let checks = 0;
function check(ok: unknown, name: string) { assert.ok(ok, name); checks++; console.log("✓ " + name); }

import { valid, house, sealed, sparse, type P } from "./structure-oracle.ts";
import { WAIT_SCALE } from "../gate/wait.ts";   // a wall-clock bound stretches with PROTOCOL_TIMEOUT_SCALE (bot #333 187, 218)

const terrain = (heightAt: (x: number, z: number) => number = () => 0, step = .5) => ({ kind: "terrain", heightAt, step });
const flat = (h = 0) => terrain(() => h);
const floor = (level: number | undefined, height: number) => ({ kind: "floor", level, height, step: .5 });

// ---- fixtures
const wall = { levels: [{ y: 0, tiles: [], walls: [[1, 1, 0]], apertures: [] }] };
const closed = { levels: [{ y: 0, tiles: [[0, 0]], walls: [[0, 0, 0], [0, 0, 1], [1, 0, 0], [1, 1, 0]] }] };
const upperFloor = { y: 3, tiles: [[0, 0], [2, 0]], walls: [], apertures: [] };
const groundFloor = { y: 0, tiles: [[0, 0], [1, 0], [2, 0]], walls: [[1, 1, 0]], apertures: [[1, 1, 0, "door"]] };
const basement = { y: -3, tiles: [[0, 0]], walls: [], apertures: [] };
const upper = structuredClone(house.levels[0]); upper.y = 3;
const stacked = { levels: [{ ...structuredClone(house.levels[0]), y: 0 }, upper] };
/** A passage that must cross the wall on `axis`: a one-cell room for 0/1, a half-cell room for the diagonals. */
function through(axis: number, kind: string | null) {
  const room = axis < 2
    ? { tiles: [[0, 0]], walls: [[0, 0, 0], [0, 0, 1], [1, 0, 0], [1, 1, 0]] }
    : { tiles: [[0, 0, "floor", "A"]], walls: [[axis, 0, 0], [0, 0, 0], axis === 2 ? [1, 1, 0] : [1, 0, 0]] };
  const opening = axis === 0 ? [0, 0, 0] : axis === 1 ? [1, 0, 0] : [axis, 0, 0];
  const data = { levels: [{ y: 0, ...room, apertures: kind ? [[...opening, kind]] : [] }] };
  const from: P = axis === 0 ? [.5, -2] : axis === 1 ? [-2, .5] : [.5, 2];
  const to: P = axis < 2 ? [.5, .5] : axis === 2 ? [.8, .2] : [.2, .2];
  return { data, from, to };
}

// ---- 1. the route table: {data, from, to, basis, expect}; every row that routes is checked against the oracle
type Row = { name: string; data: any; from: P; to: P; basis?: any; expect: "clear" | "routed" | "route" | { blocked: RegExp }; oracleLevel?: number;
  also?: (r: any, ctx: any) => boolean };
const NO_PATH = /^no path through its doorways and arches connects the start to the destination \(windows don't count\)/;
const NO_FLOOR_PATH = /^no path across this floor connects the start to the destination/;
const BUDGET = /over the 16384-cell routing limit.*nearer endpoints won't help/;
const ROWS: Row[] = [
  { name: "north entry", data: house, from: [.5, -3], to: [3.5, .5], expect: "route" },
  { name: "far-side door approach", data: house, from: [3.5, 3], to: [3.5, .5], expect: "route" },
  { name: "exit to far side", data: house, from: [3.5, .5], to: [3.5, 3], expect: "route" },
  { name: "both outside across building", data: house, from: [-1, 1.5], to: [5, 1.5], expect: "route" },
  { name: "off-center interior endpoints", data: house, from: [.15, 1.88], to: [3.85, 1.12], expect: "route" },
  { name: "through the divider's doorway: few waypoints (its turns, plus its ends)", data: house, from: [.5, 1.5], to: [3.5, 1.5], expect: "routed", also: (r) => r.points.length <= 5 },
  { name: "distant start uses bounded local region", data: house, from: [-100000, 1.5], to: [3.5, .5], expect: "route" },
  { name: "distant destination uses bounded local region", data: house, from: [3.5, .5], to: [100000, 1.5], expect: "route" },
  { name: "unobstructed outdoors is a direct leg", data: house, from: [-2, -2], to: [-1, -1], expect: "clear" },
  { name: "window-only exterior refuses entry (sealed room)", data: sealed, from: [.5, -3], to: [3.5, .5], expect: { blocked: NO_PATH } },
  { name: "a sealed one-cell room refuses the way out", data: closed, from: [.5, .5], to: [2, .5], basis: flat(), expect: { blocked: NO_PATH } },
  { name: "huge sparse bounds: a named budget refusal that says nearer endpoints won't help", data: sparse, from: [-1, .5], to: [1, .5], expect: { blocked: BUDGET } },
  { name: "clear path remains possible beside huge sparse geometry", data: sparse, from: [-1, -1], to: [-2, -2], expect: "clear" },
  { name: "unfloored exterior wall", data: { levels: [{ tiles: [], walls: [[1, 0, 0]], apertures: [] }] }, from: [-.5, .5], to: [.5, .5], expect: "route" },
  ...[2, 3].map((axis): Row => ({ name: "around solid diagonal " + axis, data: { levels: [{ tiles: [[0, 0]], walls: [[axis, 0, 0]], apertures: [] }] },
    from: axis === 2 ? [.8, .2] : [.2, .2], to: axis === 2 ? [.2, .8] : [.8, .8], expect: "route" })),
  { name: "concave outline to reentrant arch", data: { levels: [{ tiles: [[0, 0], [1, 0], [0, 1]],
    walls: [[0, 0, 0], [0, 1, 0], [1, 0, 0], [1, 0, 1], [0, 0, 2], [1, 1, 1], [0, 1, 1], [1, 2, 0]], apertures: [[0, 1, 1, "arch"]] }] },
    from: [2.5, 1.5], to: [.25, 1.75], expect: "route" },
  { name: "unfloored courtyard through its door", data: { levels: [{ tiles: [[0, 0], [1, 0], [2, 0], [0, 1], [2, 1], [0, 2], [1, 2], [2, 2]],
    walls: [[0, 1, 1], [0, 1, 2], [1, 1, 1], [1, 2, 1]], apertures: [[0, 1, 1, "door"]] }] }, from: [1.5, 1.5], to: [3.5, 1.5], expect: "route" },
  { name: "non-finite endpoints are refused, with the router's one reason for them", data: house, from: [NaN, 0], to: [1, 1],
    expect: { blocked: new RegExp("^" + NON_FINITE_ENDPOINT.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "$") } },
  // a point-query terrain can't bound its height over a whole overlap: a leg ALONG an overhead wall's projection is routed away
  { name: "an overhead wall's crossing leaves a terrain leg clear", data: { levels: [{ y: 3, tiles: [], walls: [[0, 0, 0]], apertures: [] }] },
    from: [-1, .5], to: [2, .5], expect: "clear" },
  { name: "a terrain leg along a projected wall is routed away from its line", data: { levels: [{ y: 3, tiles: [], walls: [[0, 0, 0]], apertures: [] }] },
    from: [-1, 0], to: [2, 0], expect: "routed",
    also: (r) => !r.points.some((q: number[], i: number) => i > 0 && r.points[i - 1][1] === 0 && q[1] === 0 && Math.min(r.points[i - 1][0], q[0]) < 1 && Math.max(r.points[i - 1][0], q[0]) > 0) },
  // floor mode: an explicit support owner/height, so the floor branch is tested apart from the standing that selects it
  { name: "upper-storey routes stay on the floor instead of using an outdoor shortcut", data: stacked, from: [.5, 1.5], to: [3.5, 1.5], basis: floor(1, 3.1),
    expect: "routed", oracleLevel: 1, also: (r) => r.points.every(([x, z]: number[]) => x >= 0 && x <= 4 && z >= 0 && z <= 2) },
  { name: "upper-storey exterior destination is a refusal, not vertical navigation", data: stacked, from: [.5, 1.5], to: [.5, -2], basis: floor(1, 3.1),
    expect: { blocked: /^the destination isn't on this floor/ } },
  { name: "same upper-floor point does not detour through the cell center", data: stacked, from: [.2, .2], to: [.2, .2], basis: floor(1, 3.1), expect: "clear" },
  { name: "clear same-cell upper-floor positioning keeps its direct segment", data: stacked, from: [.2, .2], to: [.4, .3], basis: floor(1, 3.1), expect: "clear" },
  ...[[groundFloor, basement], [basement, groundFloor]].map((levels): Row => ({ name: "ground exit above a basement, either level order", data: { levels },
    from: [.5, .5], to: [3.5, .5], basis: flat(), expect: "clear", also: (_r, ctx) => !ctx.confined })),
  ...[[upperFloor], [{ y: 0, tiles: [], walls: [] }, upperFloor], [upperFloor, { y: 0, tiles: [], walls: [] }]].flatMap((levels): Row[] => [
    { name: `overhead tiles do not confine a terrain walker (${levels.length} levels)`, data: { levels }, from: [.5, .5], to: [2.5, .5], basis: flat(), expect: "clear", also: (_r, ctx) => !ctx.confined },
    { name: `an identified raised-only or upper floor cannot bridge its gap (${levels.length} levels)`, data: { levels }, from: [.5, .5], to: [2.5, .5],
      basis: floor(levels.indexOf(upperFloor), 3.1), expect: { blocked: NO_FLOOR_PATH }, also: (_r, ctx) => ctx.confined },
    { name: `an identified floor refuses an exterior support transition (${levels.length} levels)`, data: { levels }, from: [.5, .5], to: [.5, -2],
      basis: floor(levels.indexOf(upperFloor), 3.1), expect: { blocked: /^the destination isn't on this floor/ } },
  ]),
  { name: "a wrong supplied floor height is refused rather than inferred from x/z", data: { levels: [upperFloor] }, from: [.5, .5], to: [2.5, .5], basis: floor(0, 0), expect: { blocked: /./ } },
  { name: "an upper floor not supporting the origin still reports a real wall obstruction",
    data: { levels: [{ y: 0, tiles: [], walls: [], apertures: [] }, { y: 3, tiles: [[10, 10]], walls: [[1, 1, 0]], apertures: [] }] },
    from: [.5, .5], to: [2.5, .5], basis: { kind: "floor", height: 3.1 }, expect: { blocked: /./ } },
  // stacked levels cut one cell along different diagonals: a terrain walker meets the ground floor's ↗, whichever comes first
  ...[[0, 3], [3, 0]].map(([ya, yb]): Row => {
    const levels = [{ y: ya, tiles: [], walls: [[ya === 0 ? 3 : 2, 0, 0]], apertures: [] }, { y: yb, tiles: [], walls: [[yb === 0 ? 3 : 2, 0, 0]], apertures: [] }];
    return { name: `a terrain walker routes around the diagonal it meets, under another level's: ${ya} then ${yb}`, data: { levels },
      from: [.15, .25], to: [.85, .75], expect: "routed", oracleLevel: ya === 0 ? 0 : 1 };
  }),
  // every axis × every opening: a door or arch lets the route through, a window or a solid wall does not
  ...[0, 1, 2, 3].flatMap((axis) => ["door", "arch", "window", null].map((kind): Row => {
    const t = through(axis, kind), open = kind === "door" || kind === "arch";
    return { name: `axis ${axis} ${kind ?? "solid"}: ${open ? "passable" : "refused"}`, ...t, expect: open ? "route" : { blocked: NO_PATH } };
  })),
];
console.log("1. the route table");
for (const row of ROWS) {
  const ctx = prepareRouteLocal(planStructure(row.data), row.basis ?? flat());
  const r = ctx.route(...row.from, ...row.to);
  if (typeof row.expect === "object") {
    check(r.kind === "blocked" && row.expect.blocked.test(r.reason ?? "") && (!row.also || row.also(r, ctx)), `${row.name} [blocked: ${r.reason}]`);
    continue;
  }
  const kindOk = row.expect === "route" ? r.kind !== "blocked" : r.kind === row.expect;
  const ends = r.points?.length && r.points[0][0] === row.from[0] && r.points[0][1] === row.from[1] && r.points.at(-1)[0] === row.to[0] && r.points.at(-1)[1] === row.to[1];
  check(kindOk && ends && valid(row.data, r.points, row.oracleLevel) && (!row.also || row.also(r, ctx)),
    `${row.name} [${r.kind}${r.reason ? ": " + r.reason : ""}]: endpoints kept, no leg through a solid wall`);
}
{
  // upstairs the exterior door opens onto air: the sealed partition can't be bypassed through it
  const s = structuredClone(stacked); s.levels[1].apertures = [[0, 0, 0, "door"]];
  check(prepareRouteLocal(planStructure(s), floor(1, 3.1)).route(.5, 1.5, 3.5, 1.5).kind === "blocked", "upper-storey sealed partition cannot be bypassed across air");
}

// ---- 2. caps and the worst case: the padded region is counted from the plan, not the planner
console.log("2. caps");
const capPlan = (x: number, z: number) => planStructure({ levels: [{ y: 0, tiles: [[x, z]], walls: [[1, 0, 0]], apertures: [] }] });
function paddedCells(plan: any) {
  let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
  const include = (x: number, z: number) => { minX = Math.min(minX, x); minZ = Math.min(minZ, z); maxX = Math.max(maxX, x); maxZ = Math.max(maxZ, z); };
  for (const lv of plan.levels) {
    for (const k of lv.level.tiles.keys()) { const [x, z] = k.split(",").map(Number); include(x, z); include(x + 1, z + 1); }
    for (const e of lv.level.walls.values()) { include(e.x, e.z); include(e.x + 1, e.z + 1); }
  }
  return (maxX - minX + 2) * (maxZ - minZ + 2);
}
check(paddedCells(capPlan(125, 125)) === ROUTE_MAX_CELLS && paddedCells(capPlan(2, 3274)) === ROUTE_MAX_CELLS + 1, "the fixtures' padded regions are 16384 and 16385 cells");
const capData = (x: number, z: number) => ({ levels: [{ y: 0, tiles: [[x, z]], walls: [[1, 0, 0]], apertures: [] }] });
const exact = prepareRouteLocal(capPlan(125, 125), flat()).route(-.5, .5, .5, .5);
check(exact.kind === "routed" && exact.points.length > 2 && valid(capData(125, 125), exact.points), "16384-cell region is admitted and routes around the obstructing wall");
const over = prepareRouteLocal(capPlan(2, 3274), flat()).route(-.5, .5, .5, .5);
check(over.kind === "blocked" && over.reason.includes("5×3277 cells (5×3277 m)") && BUDGET.test(over.reason), "16385-cell region refuses before search, naming its footprint in metres: " + over.reason);
const scaled = prepareRouteLocal(capPlan(2, 3274), { ...flat(), scale: 2 }).route(-.5, .5, .5, .5);
check(scaled.kind === "blocked" && scaled.reason.includes("(10×6554 m)"), "a scaled structure's footprint is given in world metres");
const empty = prepareRouteLocal(planStructure({ levels: [{ y: 0, tiles: [], walls: [] }, { y: 3, tiles: [], walls: [] }] }), floor(1, 3.1)).route(.5, .5, 1.5, .5);
check(empty.kind === "blocked" && empty.reason === "the identified floor has no cells", "a walk on an empty floor is refused as one, not as over the limit");
// a 126×126-cell field of short walls, padded to 16,384 cells, and a sealed destination, so every reachable cell is visited
const field: number[][] = [];
for (let x = 0; x < 126; x += 2) for (let z = 0; z < 126; z += 2) field.push([0, x, z]);
field.push([0, 63, 63], [0, 63, 64], [1, 63, 63], [1, 64, 63], [1, 125, 125]);
const fieldPlan = planStructure({ levels: [{ y: 0, tiles: [], walls: field, apertures: [] }] });
check(paddedCells(fieldPlan) === ROUTE_MAX_CELLS, "the worst-case field is padded to exactly the limit");
const worstFrom = performance.now();
const worst = prepareRouteLocal(fieldPlan, flat()).route(-.5, -.5, 63.5, 63.5);
const worstMs = performance.now() - worstFrom;
check(worst.kind === "blocked" && NO_PATH.test(worst.reason) && worst.reason.endsWith("pick a destination you can reach through an opening") && worstMs < 2000 * WAIT_SCALE,
  `a search of every cell at the limit, among ${field.length} walls, finishes in ${worstMs.toFixed(0)} ms (bound ${2000 * WAIT_SCALE}; PROTOCOL_TIMEOUT_SCALE stretches it)`);

// ---- 3. support bases: the crossing height is the terrain AT the crossing, and the band is the feet-to-step band
console.log("3. support bases");
const clearOn = (data: any, basis: any, a: P, b: P) => prepareRouteLocal(planStructure(data), basis).clear(...a, ...b);
check(!clearOn(wall, flat(), [.5, .5], [1.5, .5]), "ordinary wall base 0.1m above terrain intersects feet-to-step band");
check(!clearOn({ wallH: 5, levels: [{ y: -3, tiles: [], walls: [[1, 1, 0]] }] }, flat(), [.5, .5], [1.5, .5]), "tall basement wall obstructs independently of its floor support");
check(clearOn({ wallH: 2, levels: [{ y: -3, tiles: [], walls: [[1, 1, 0]] }] }, flat(), [.5, .5], [1.5, .5]), "wall ending below the feet does not obstruct");
check(clearOn({ levels: [{ y: 3, tiles: [[0, 0]], walls: [[1, 1, 0]] }] }, flat(), [.5, .5], [1.5, .5]), "overhead wall above the feet-to-step band is irrelevant");
check(clearOn(wall, terrain((x) => 4 * x), [0, .5], [2, .5]), "terrain height at crossing clears a wall despite low start height");
check(!clearOn(wall, terrain((x) => 4 * (x - 1) ** 2), [0, .5], [2, .5]), "terrain dip at crossing obstructs despite high endpoints");
const doorway = { levels: [{ y: 0, tiles: [], walls: [[1, 1, 0]], apertures: [[1, 1, 0, "door"]] }] };
check(clearOn(doorway, flat(), [0, .5], [2, .5]), "door opening is clear at ordinary terrain height");
check(!clearOn(doorway, flat(2), [0, .5], [2, .5]), "higher terrain meets the door lintel");
check(!clearOn(wall, flat(NaN), [0, .5], [2, .5]), "unknown terrain height is not an assumed clear route");
// counts every read of the wall map: checks after preparation must read the prepared geometry, never the map again
let preparedReads = 0;
const preparedPlan = planStructure(wall);
const wallLevel = preparedPlan.levels[0].level;
const wallMap = wallLevel.walls;
wallLevel.walls = new Proxy(wallMap, { get(target, key) {
  preparedReads++; const value = Reflect.get(target, key, target); return typeof value === "function" ? value.bind(target) : value;
} });
const frozenBasis: any = flat();
const frozen = prepareRouteLocal(preparedPlan, frozenBasis);
const readsAfterPrepare = preparedReads;
frozenBasis.kind = "floor"; frozenBasis.height = 100;
for (let i = 0; i < 20; i++) frozen.clear(0, .5, 2, .5);
check(readsAfterPrepare > 0 && preparedReads === readsAfterPrepare, "candidate checks reuse prepared wall geometry, reading the wall map through no accessor");
check(frozen.route(0, .5, 2, .5).kind !== "blocked" && preparedReads === readsAfterPrepare, "and so does a search over it");
check(!frozen.clear(0, .5, 2, .5), "mutating caller basis cannot change the prepared walking mode");

console.log("PASS " + checks + " structure routing checks");
process.exit(0);
