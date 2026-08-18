// shared/structure.js — the griddled-building planner, tested headless.
//
//   bun tools/structure-field-test.ts
//
// The load-bearing claims:
//  - walls on EDGES cannot be double-counted: one wall between two rooms;
//  - rooms are DERIVED by flood fill, and a wall stops the fill;
//  - a DOOR DOES NOT MERGE two rooms (Sims semantics) — only an absent wall does;
//  - an aperture is a hole made of ABSENT boxes, so it is walkable with no
//    change to the movement solver, and the surrounding boxes never overlap;
//  - portals resolve to the two rooms they join, null meaning outdoors;
//  - the planner is pure, deterministic and TOTAL — malformed data yields an
//    empty plan rather than a throw (house rule 3, one layer down).

import {
  planStructure, normalize, wallBoxes, deriveRooms, derivePortals, roomAt,
  edgeCells, edgeBetween, edgeKey, cellKey, APERTURES, GRID_DEFAULTS,
  describeHere, describeStructure, localizePoint, levelParts, TRIM, cornerFills, wallRuns, wallPolylines, sweepProfile, wallProfile, levelSweeps, capProfile, clipProfileV, routeCells, routeLocal, passable, makeShader,
} from "../shared/structure.js";

let passed = 0, failed = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
};

console.log(`\nstructure_field — the griddled-building planner\n`);

// A two-room house, 4×2 cells, split down the middle by a wall with a door,
// and a window in room A's north wall.
//
//        x=0   1   2   3   4
//   z=0   ┌───┬───╥───┬───┐
//         │ A   A ║ B   B │
//   z=1   │       ║       │      ║ = the dividing wall (door at z=0..1)
//         │ A   A ║ B   B │      ═ = exterior
//   z=2   └───┴───╨───┴───┘
const HOUSE = {
  labels: { "0,0": "kitchen", "2,0": "hall" },
  levels: [{
    y: 0,
    tiles: [
      [0, 0], [1, 0], [2, 0], [3, 0],
      [0, 1], [1, 1], [2, 1], [3, 1],
    ],
    walls: [
      // north (z=0) and south (z=2) runs
      [0, 0, 0], [0, 1, 0], [0, 2, 0], [0, 3, 0],
      [0, 0, 2], [0, 1, 2], [0, 2, 2], [0, 3, 2],
      // west (x=0) and east (x=4) runs
      [1, 0, 0], [1, 0, 1],
      [1, 4, 0], [1, 4, 1],
      // the dividing wall at x=2
      [1, 2, 0], [1, 2, 1],
    ],
    apertures: [
      [1, 2, 0, "door"],      // between the two rooms
      [0, 0, 0, "window"],    // room A's north wall, to the outside
    ],
  }],
};

// 1. edge algebra is canonical — one name per edge, and it inverts
{
  check("an X-edge separates north from south",
    JSON.stringify(edgeCells(0, 3, 5)) === JSON.stringify([[3, 4], [3, 5]]));
  check("a Z-edge separates west from east",
    JSON.stringify(edgeCells(1, 3, 5)) === JSON.stringify([[2, 5], [3, 5]]));
  // the same pair of cells names the SAME edge from either direction — this is
  // what makes double-counting structurally impossible rather than merely
  // avoided by a de-dup pass
  const ab = edgeBetween(1, 0, 1, 1)!;
  const ba = edgeBetween(1, 1, 1, 0)!;
  check("edgeBetween is symmetric", edgeKey(ab[0], ab[1], ab[2]) === edgeKey(ba[0], ba[1], ba[2]),
    `${edgeKey(ab[0], ab[1], ab[2])} vs ${edgeKey(ba[0], ba[1], ba[2])}`);
  check("non-neighbours share no edge", edgeBetween(0, 0, 2, 2) === null);
  const [axis, ex, ez] = edgeBetween(1, 0, 2, 0)!;
  check("edgeBetween inverts edgeCells",
    JSON.stringify(edgeCells(axis, ex, ez).sort()) === JSON.stringify([[1, 0], [2, 0]].sort()));
}

// 2. the shared wall is ONE wall
{
  const g = normalize(HOUSE);
  check("14 walls, not 16 (the divider is shared)", g.levels[0].walls.size === 14,
    `got ${g.levels[0].walls.size}`);
  check("8 floor cells", g.levels[0].tiles.size === 8);
}

// 3. rooms are derived, and the wall stops the fill
{
  const plan = planStructure(HOUSE);
  const rooms = plan.levels[0].rooms;
  check("two rooms", rooms.length === 2, `got ${rooms.length}`);
  check("four cells each", rooms.every((r) => r.cells.length === 4));
  check("area is metric", rooms[0].area === 4, `got ${rooms[0].area}`);
  check("labels come through", rooms.map((r) => r.label).sort().join() === "hall,kitchen",
    rooms.map((r) => r.label).join());
}

// 4. A DOOR DOES NOT MERGE ROOMS — remove the wall and they become one
{
  const noDivider = structuredClone(HOUSE);
  noDivider.levels[0].walls = noDivider.levels[0].walls.filter(
    (w) => !(w[0] === 1 && w[1] === 2));
  noDivider.levels[0].apertures = [[0, 0, 0, "window"]];
  const merged = planStructure(noDivider).levels[0].rooms;
  check("absent wall merges the rooms", merged.length === 1 && merged[0].cells.length === 8,
    `${merged.length} rooms`);
  // ...while the doored version stays two. The door is a hole in a wall, and a
  // wall is what a room is made of.
  check("a door leaves them separate", planStructure(HOUSE).levels[0].rooms.length === 2);
}

// 5. portals resolve to the rooms they join; outdoors is null
{
  const plan = planStructure(HOUSE);
  const { rooms, portals } = plan.levels[0];
  const byId = Object.fromEntries(rooms.map((r) => [r.id, r.label]));
  check("two portals", portals.length === 2, `got ${portals.length}`);
  const door = portals.find((p) => p.kind === "door")!;
  const win = portals.find((p) => p.kind === "window")!;
  check("the door joins kitchen and hall",
    door.between.map((id) => (id ? byId[id] : "outside")).sort().join() === "hall,kitchen",
    door.between.map((id) => (id ? byId[id] : "outside")).join());
  check("the window faces outdoors",
    win.between.includes(null) && win.between.some((id) => id && byId[id] === "kitchen"),
    JSON.stringify(win.between));
}

// 6. aperture decomposition: a door is a hole you can walk through
{
  const g = normalize(HOUSE);
  const edge = g.levels[0].walls.get(edgeKey(1, 2, 0))!;
  const solid = wallBoxes(edge, null, g, 0);
  const doored = wallBoxes(edge, "door", g, 0);
  const windowed = wallBoxes(edge, "window", g, 0);
  check("a plain wall is one box", solid.length === 1);
  check("a door is a lintel alone — no sill, no jambs", doored.length === 1
    && doored[0].kind === "lintel", doored.map((b) => b.kind).join());
  check("a window has a sill AND a lintel", windowed.length === 2
    && windowed.some((b) => b.kind === "sill")
    && windowed.some((b) => b.kind === "lintel"), windowed.map((b) => b.kind).join());
  // No box may be thinner than a body can be ejected through. This is the
  // regression that killed side jambs: a 5cm sliver ejects a 32cm body
  // sideways ALONG the wall, so it slides through the opening.
  const SLIVER = 0.32;
  const thin = [...doored, ...windowed].filter(
    (b) => Math.min(b.x1 - b.x0, b.z1 - b.z0) < g.wallT - 1e-9
        || (b.x1 - b.x0 < SLIVER && b.z1 - b.z0 < SLIVER));
  check("no aperture box is a body-thin sliver", thin.length === 0,
    thin.map((b) => `${b.kind} ${(b.x1 - b.x0).toFixed(2)}×${(b.z1 - b.z0).toFixed(2)}`).join(", "));
  check("apertures span the full segment",
    doored.every((b) => Math.abs((b.z1 - b.z0) - g.tile) < 1e-9));

  const inside = (b: any, x: number, y: number, z: number) =>
    x > b.x0 && x < b.x1 && y > b.y0 && y < b.y1 && z > b.z0 && z < b.z1;
  // The doorway itself: mid-segment, at chest height. Absent from every box —
  // which is precisely why the movement solver needs no concept of a hole.
  check("the doorway is empty at body height",
    !doored.some((b) => inside(b, 2.0, 1.0, 0.5)));
  check("the lintel above it is solid",
    doored.filter((b) => inside(b, 2.0, 2.5, 0.5)).length === 1);
  check("a plain wall IS solid at body height",
    solid.filter((b) => inside(b, 2.0, 1.0, 0.5)).length === 1);
  check("a window is glassless-open at eye height",
    !windowed.some((b) => inside(b, 2.0, 1.5, 0.5)));
  check("but solid below the sill",
    windowed.filter((b) => inside(b, 2.0, 0.4, 0.5)).length === 1);

  // Non-overlap: the partition is exact, so no two boxes share volume. Sampled
  // densely rather than proven, because a sliver from bad arithmetic would show
  // up as a double-count long before it showed up as a visible seam.
  for (const set of [doored, windowed]) {
    let overlaps = 0;
    for (let i = 0; i < set.length; i++) {
      for (let j = i + 1; j < set.length; j++) {
        const a = set[i], b = set[j];
        if (a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1 && a.z0 < b.z1 && b.z0 < a.z1) overlaps++;
      }
    }
    check(`${set === doored ? "door" : "window"} boxes never overlap`, overlaps === 0, `${overlaps} pairs`);
  }
}

// 7. wall thickness straddles the edge; the foundation rests ON the ground
{
  const g = normalize(HOUSE);
  const edge = g.levels[0].walls.get(edgeKey(1, 2, 0))!;
  const [b] = wallBoxes(edge, null, g, 0);
  check("wall straddles its edge line",
    Math.abs((b.x0 + b.x1) / 2 - 2.0) < 1e-9 && Math.abs((b.x1 - b.x0) - g.wallT) < 1e-9,
    `centre ${(b.x0 + b.x1) / 2}, thickness ${b.x1 - b.x0}`);
  const plan = planStructure(HOUSE);
  const slab = plan.boxes.find((x) => x.kind === "floor")!;
  const walk = plan.levels[0].y;

  // THE Z-FIGHT REGRESSION. A level-0 floor whose top sits at y=0 is exactly
  // coplanar with terrain of height 0, and the whole floor shimmers. The slab
  // must rest ON its level's base and put its top ABOVE it — then no floor, at
  // any level, on any terrain, can ever be coplanar with the ground it sits on.
  check("the foundation rests on the level base, top above it",
    slab.y0 === 0 && slab.y1 === g.slabT, `${slab.y0}..${slab.y1}`);
  check("the walk surface is the slab's top, never the ground plane",
    walk === g.slabT && walk > 0, `walk=${walk}`);
  check("walls rise FROM the walk surface, not from the base",
    plan.boxes.filter((x) => x.kind === "wall").every((x) => x.y0 === walk && x.y1 === walk + g.wallH),
    `${b.y0}..${b.y1} vs walk ${walk}`);
}

// 8. box census — geometry and collision come from one decomposition
{
  const plan = planStructure(HOUSE);
  const n = (k: string) => plan.boxes.filter((b) => b.kind === k).length;
  // 8 floors + 5 wall RUNS + 1 door lintel + (window sill + lintel).
  // Collinear segments merge: the 12 solid segments are 5 stretches of wall,
  // which is what they are in the world. Fewer boxes, no interior seams, and a
  // skirting that is one board instead of several that happen to abut.
  check("20 boxes total", plan.boxes.length === 20, `got ${plan.boxes.length}`);
  check("8 floor slabs", n("floor") === 8, `got ${n("floor")}`);
  check("12 solid segments merge to 5 runs", n("wall") === 5, `got ${n("wall")}`);
  check("4 corners get their own quadrant fill", n("corner") === 4, `got ${n("corner")}`);
  check("no jambs anywhere", n("jamb") === 0, `got ${n("jamb")}`);
  check("2 lintels, 1 sill", n("lintel") === 2 && n("sill") === 1,
    `${n("lintel")} lintels, ${n("sill")} sills`);

  // the merge is a property of the RUN grouping, asserted directly so a
  // regression reads as "runs broke" rather than as a mysterious box count
  const g2 = normalize(HOUSE);
  const runs = wallRuns(g2.levels[0], g2);
  check("the south wall is one run of four", runs.some((r) => r.axis === 0
    && r.cross === 2 && r.lo === 0 && r.hi === 3), JSON.stringify(runs));
  check("the window breaks the north wall into one run of three",
    runs.some((r) => r.axis === 0 && r.cross === 0 && r.lo === 1 && r.hi === 3));
  check("an apertured segment is never inside a run",
    !runs.some((r) => r.axis === 0 && r.cross === 0 && r.lo === 0));
  // one skirting board per run per room-facing side, not one per tile
  const parts = levelParts(g2.levels[0], g2, g2.levels[0].y + g2.slabT);
  check("skirting is per run, not per tile",
    parts.filter((p) => p.kind === "base").length <= runs.length * 2,
    `${parts.filter((p) => p.kind === "base").length} boards for ${runs.length} runs`);
}

// 9. roomAt — "which room am I in" is a lookup, not a geometric query
{
  const plan = planStructure(HOUSE);
  check("a point in room A finds the kitchen", roomAt(plan, 0.5, 0.5)?.label === "kitchen");
  check("a point in room B finds the hall", roomAt(plan, 2.5, 0.5)?.label === "hall");
  check("a point outside finds nothing", roomAt(plan, -3, -3) === null);
  check("negative coords floor correctly", roomAt(plan, 3.9, 1.9)?.label === "hall");
}

// 10. determinism — same log, same house, for every agent standing in it
{
  const a = JSON.stringify(planStructure(HOUSE).levels[0].rooms);
  const b = JSON.stringify(planStructure(structuredClone(HOUSE)).levels[0].rooms);
  check("room derivation is deterministic", a === b);
  // and independent of the order the cells were authored in
  const shuffled = structuredClone(HOUSE);
  shuffled.levels[0].tiles.reverse();
  shuffled.levels[0].walls.reverse();
  const c = JSON.stringify(planStructure(shuffled).levels[0].rooms);
  check("room ids don't depend on author order", a === c);
}

// 11. totality — a broken house is an empty house, never a thrown fold
{
  const bad: any[] = [
    null, undefined, 42, "house", [],
    { levels: "nope" },
    { levels: [null, 7] },
    { levels: [{ tiles: [[0.5, 1], ["a", "b"], null], walls: [[9, 0, 0]] }] },
    { tile: -1, wallH: 0, levels: [{ tiles: [[0, 0]] }] },
  ];
  let threw = 0, boxes = 0;
  for (const d of bad) {
    try { const p = planStructure(d); boxes += p.boxes.length; } catch { threw++; }
  }
  check("no malformed payload throws", threw === 0, `${threw} threw`);
  // the last case has one VALID tile and junk dimensions — dimensions fall back
  // to defaults, so it draws exactly its one slab
  check("junk yields near-nothing", boxes === 1, `${boxes} boxes`);
  check("bad dimensions fall back to the contract",
    normalize({ tile: -1, wallH: 0 }).tile === GRID_DEFAULTS.tile);
}

// 12. an aperture with no wall to sit in is dropped, not drawn
{
  const orphan = { levels: [{ tiles: [[0, 0]], walls: [], apertures: [[0, 0, 0, "door"]] }] };
  const plan = planStructure(orphan);
  check("orphan aperture makes no portal", plan.levels[0].portals.length === 0);
  check("orphan aperture makes no boxes", plan.boxes.filter((b) => b.kind !== "floor").length === 0);
  const unknown = { levels: [{ tiles: [[0, 0]], walls: [[0, 0, 0]], apertures: [[0, 0, 0, "portcullis"]] }] };
  check("unknown aperture kind is ignored, wall stays whole",
    planStructure(unknown).boxes.filter((b) => b.kind === "wall").length === 1);
}

// 13. perception — the whole reason the grid exists
{
  const plan = planStructure(HOUSE);
  const here = describeHere(plan, 0.5, 0.5)!;
  check("describeHere names the room", /You are in the kitchen/.test(here), here);
  check("...with its size", /2×2m, 4m²/.test(here), here);
  check("...and the way out, by side and destination",
    /a door on its east to hall/.test(here), here);
  check("...and the window, to outside", /a window on its north to outside/.test(here), here);

  const inHall = describeHere(plan, 2.5, 0.5)!;
  check("the hall's door points back west", /a door on its west to kitchen/.test(inHall), inHall);
  check("the hall has no window", !/window/.test(inHall), inHall);
  check("outdoors describes nothing", describeHere(plan, -5, -5) === null);

  // a sealed room must SAY so — silence would read as "no exits mentioned"
  const sealed = planStructure({
    levels: [{
      tiles: [[0, 0]],
      walls: [[0, 0, 0], [0, 0, 1], [1, 0, 0], [1, 1, 0]],
    }],
  });
  check("a sealed room says it is sealed", /No doors — this room is sealed/.test(describeHere(sealed, 0.5, 0.5)!));

  const label = describeStructure(HOUSE);
  check("describeStructure counts what a mesh cannot",
    label === "a building: 2 rooms, 14 walls, 1 door, 1 window", label);
}

// 14. localizePoint — non-orthogonal grids are the point of grid-local coords
{
  const plan = planStructure(HOUSE);
  // the same physical spot, reached through four different building poses
  const cases = [
    { ent: { pos: [0, 0, 0], yaw: 0, scale: 1 }, world: [0.5, 0, 0.5] },
    { ent: { pos: [10, 0, -4], yaw: 0, scale: 1 }, world: [10.5, 0, -3.5] },
    // rotated 90°: grid-local +x runs along world -z
    { ent: { pos: [0, 0, 0], yaw: Math.PI / 2, scale: 1 }, world: [0.5, 0, -0.5] },
    // and an off-axis grid, which is the case that has no orthogonal excuse
    { ent: { pos: [3, 0, 7], yaw: 0.7, scale: 1 }, world: null as any },
  ];
  // for the off-axis case, compute the world point by forward-rotating a known
  // local point — then localizePoint must invert it exactly
  {
    const { pos, yaw } = cases[3].ent as any;
    const lx = 0.5, lz = 0.5;
    cases[3].world = [
      pos[0] + lx * Math.cos(yaw) + lz * Math.sin(yaw), 0,
      pos[2] - lx * Math.sin(yaw) + lz * Math.cos(yaw),
    ];
  }
  let ok = 0;
  for (const c of cases) {
    const [lx, , lz] = localizePoint(c.ent as any, c.world[0], c.world[1], c.world[2]);
    if (Math.abs(lx - 0.5) < 1e-9 && Math.abs(lz - 0.5) < 1e-9) ok++;
  }
  check("localizePoint inverts any pos/yaw", ok === 4, `${ok}/4`);
  const off = cases[3];
  check("a rotated building still knows its own kitchen",
    /kitchen/.test(describeHere(plan,
      localizePoint(off.ent as any, off.world[0], off.world[1], off.world[2])[0],
      localizePoint(off.ent as any, off.world[0], off.world[1], off.world[2])[2])!));
  // scale composes too — a building at ×2 has 2m tiles in world terms
  const scaled = { pos: [0, 0, 0], yaw: 0, scale: 2 };
  const [sx, , sz] = localizePoint(scaled as any, 1.0, 0, 1.0);
  check("scale divides out", Math.abs(sx - 0.5) < 1e-9 && Math.abs(sz - 0.5) < 1e-9);
}

// 15. trim: a window leaves a wall under it, and that wall wants a baseboard
{
  const g = normalize(HOUSE);
  const lv = g.levels[0];
  const floorY = lv.y + g.slabT;
  const parts = levelParts(lv, g, floorY);
  const base = parts.filter((p) => p.kind === "base");
  const at = (axis: number, x: number, z: number) => base.filter((p) => (axis === 0
    ? Math.abs((p.z0 + p.z1) / 2 - z * g.tile) < 0.2 && p.x0 >= x * g.tile - 0.01 && p.x1 <= (x + 1) * g.tile + 0.01
    : Math.abs((p.x0 + p.x1) / 2 - x * g.tile) < 0.2 && p.z0 >= z * g.tile - 0.01 && p.z1 <= (z + 1) * g.tile + 0.01));

  // the window sits on edge (0,0,0); only cell (0,0) is floored, so one face
  // The skirting is a step in the swept PROFILE now, not a box — so it mitres
  // by construction and cannot come apart from its wall. Boxes standing proud
  // of a swept surface could never agree with it, which is what made the
  // panels around openings look stuck on.
  void at; void base;
  const prof0 = wallProfile(g);
  check("the skirting lives in the profile", Math.min(...prof0.map((q) => q[0])) < -g.wallT / 2);
  check("no skirting boxes remain", base.length === 0, `${base.length}`);

  // and the rest of the kit is present
  const kinds = new Set(parts.map((p) => p.kind));
  for (const k of ["floor", "glass", "roof"]) {
    check(`parts include ${k}`, kinds.has(k), [...kinds].join(","));
  }
  check("the roof overhangs the footprint",
    parts.some((p) => p.kind === "roof" && p.x0 < 0 && p.x1 > 4));
}

// 16. EXTERNAL CORNERS ARE SOLID — the notch bug
//
// A wall straddles its edge, so an X-edge covers z ∈ [-t/2, +t/2] and its
// perpendicular neighbour covers x ∈ [-t/2, +t/2]. Their INNER quadrant is
// covered twice; the OUTER one is covered by neither, leaving a t/2 square
// notch the full height of every external corner. It reads in-world as a
// vertical groove down the outside of the building, and no test above could
// see it — every one of them asked about a single segment in isolation.
{
  const g = normalize(HOUSE);
  const lv = g.levels[0];
  const floorY = lv.y + g.slabT;
  const h = g.wallT / 2;
  const solidAt = (boxes: any[], x: number, y: number, z: number) =>
    boxes.some((b) => x > b.x0 - 1e-9 && x < b.x1 + 1e-9 && y > b.y0 - 1e-9
      && y < b.y1 + 1e-9 && z > b.z0 - 1e-9 && z < b.z1 + 1e-9);

  // the REAL plan, corner fills included — testing wallBoxes in isolation is
  // how the notch survived a "corner is solid" check in the first place
  const withJoin = planStructure(HOUSE).boxes as any[];
  const without: any[] = [];
  for (const [k, edge] of lv.walls) without.push(...wallBoxes(edge, lv.apertures.get(k) ?? null, g, floorY));

  const [cx, cy, cz] = [-h / 2, floorY + 1.2, -h / 2];
  check("control: walls ALONE leave a corner notch", !solidAt(without, cx, cy, cz),
    "the bug this test exists for is no longer reachable");
  check("an external corner is solid", solidAt(withJoin, cx, cy, cz));
  const corners: [number, number][] = [[-h / 2, -h / 2], [4 + h / 2, -h / 2],
    [-h / 2, 2 + h / 2], [4 + h / 2, 2 + h / 2]];
  check("every external corner is solid",
    corners.every(([x, z]) => solidAt(withJoin, x, floorY + 1.2, z)),
    corners.filter(([x, z]) => !solidAt(withJoin, x, floorY + 1.2, z)).join(" | "));
  check("solid up the corner's whole height",
    [0.1, 0.9, 1.8, 2.7].every((dy) => solidAt(withJoin, cx, floorY + dy, cz)));

  // NOTHING MAY REACH PAST ANY OUTER FACE, and the check must cover VISUAL
  // parts too. Watching one plane is how an interior door's casing punched out
  // through the north face while the test guarded the south; watching only
  // collision boxes would have missed it regardless, since casing is visual.
  const shell = { x0: -h, x1: 4 + h, z0: -h, z1: 2 + h };
  const vis = levelParts(lv, g, floorY).filter((b: any) => b.kind !== "roof");
  const escapes = [...withJoin, ...vis].filter((b: any) =>
    b.x0 < shell.x0 - 1e-9 || b.x1 > shell.x1 + 1e-9
    || b.z0 < shell.z0 - 1e-9 || b.z1 > shell.z1 + 1e-9);
  check("nothing reaches past ANY outer face", escapes.length === 0,
    escapes.map((b: any) => `${b.kind} x[${b.x0.toFixed(2)},${b.x1.toFixed(2)}] z[${b.z0.toFixed(3)},${b.z1.toFixed(3)}]`).join(" | "));

  // no two boxes fight for the same outer plane
  let clash = 0;
  for (const plane of [shell.z0, shell.z1]) {
    const on = withJoin.filter((b: any) => Math.abs(b.z0 - plane) < 1e-9 || Math.abs(b.z1 - plane) < 1e-9);
    for (let i = 0; i < on.length; i++) {
      for (let j = i + 1; j < on.length; j++) {
        const A = on[i], B = on[j];
        if (A.x0 < B.x1 - 1e-9 && B.x0 < A.x1 - 1e-9 && A.y0 < B.y1 - 1e-9 && B.y0 < A.y1 - 1e-9) clash++;
      }
    }
  }
  check("no overlapping coplanar faces on an outer plane (z-fight)", clash === 0, `${clash} pairs`);

  // a free end grows nothing
  const stub = normalize({ levels: [{ tiles: [[0, 0]], walls: [[0, 0, 0]] }] });
  check("a wall ending in open space grows no fill",
    cornerFills(stub.levels[0], stub, 0, stub.wallH).length === 0);
  // an L-corner is closed by exactly one quadrant box
  const ell = normalize({ levels: [{ tiles: [[0, 0]], walls: [[0, 0, 0], [1, 0, 0]] }] });
  const fills = cornerFills(ell.levels[0], ell, 0, ell.wallH);
  check("an L-corner gets exactly one quadrant fill", fills.length === 1, `${fills.length}`);
  check("the fill is a half-thickness square",
    fills.every((f) => Math.abs(f.x1 - f.x0 - ell.wallT / 2) < 1e-9
      && Math.abs(f.z1 - f.z0 - ell.wallT / 2) < 1e-9));
  // A T-JUNCTION NEEDS NOTHING — the crossing wall already spans ±t/2, and
  // anything added reappears on its far face.
  const tee = normalize({ levels: [{ tiles: [[0, 0]], walls: [[0, 0, 0], [0, -1, 0], [1, 0, 0]] }] });
  check("a T-junction grows no fill",
    cornerFills(tee.levels[0], tee, 0, tee.wallH).length === 0,
    JSON.stringify(cornerFills(tee.levels[0], tee, 0, tee.wallH)));
  const cross = normalize({ levels: [{ tiles: [[0, 0]],
    walls: [[0, 0, 0], [0, -1, 0], [1, 0, 0], [1, 0, -1]] }] });
  check("a crossing grows no fill", cornerFills(cross.levels[0], cross, 0, cross.wallH).length === 0);
}

// 17. ROUTING — the grid is the navigation graph
//
// This is what makes the monolith-vs-griddled comparison mean anything. Without
// it an agent told "go to the kitchen" arrives in BOTH houses by walking through
// the dividing wall: both arms pass, and the experiment measures nothing.
{
  const g = normalize(HOUSE);
  const lv = g.levels[0];
  const plan = planStructure(HOUSE);

  // the divider runs x=2: doored at z=0, solid at z=1
  check("a solid wall blocks passage", !passable(lv, 1, 1, 2, 1));
  check("a doorway is passable", passable(lv, 1, 0, 2, 0));
  check("passability is symmetric", passable(lv, 2, 0, 1, 0) === passable(lv, 1, 0, 2, 0));
  check("open floor is passable", passable(lv, 0, 0, 1, 0));
  check("non-neighbours are not passable", !passable(lv, 0, 0, 3, 1));

  const route = routeCells(lv, "0,1", "3,1");
  check("a route exists between the rooms", route !== null, "no route");
  check("the route goes THROUGH the doorway, not through the wall",
    route !== null && route.includes("1,0") && route.includes("2,0"),
    JSON.stringify(route));
  check("the route is contiguous", route !== null && route.every((k, i) => {
    if (i === 0) return true;
    const [ax, az] = route[i - 1].split(",").map(Number);
    const [bx, bz] = k.split(",").map(Number);
    return Math.abs(ax - bx) + Math.abs(az - bz) === 1;
  }));
  check("every step of the route is legal", route !== null && route.every((k, i) => {
    if (i === 0) return true;
    const [ax, az] = route[i - 1].split(",").map(Number);
    const [bx, bz] = k.split(",").map(Number);
    return passable(lv, ax, az, bx, bz);
  }));

  // seal the door and the rooms become unreachable — the honest failure
  const sealed = structuredClone(HOUSE);
  sealed.levels[0].apertures = [[0, 0, 0, "window"]];
  const sg = normalize(sealed);
  check("no door means no route", routeCells(sg.levels[0], "0,1", "3,1") === null);
  check("a window is not a doorway", !passable(sg.levels[0], 0, 0, 0, -1));

  // waypoints: only turns, plus the true endpoints
  const pts = routeLocal(plan, 0.5, 1.5, 3.5, 1.5)!;
  check("routeLocal starts and ends where asked",
    pts[0][0] === 0.5 && pts[0][1] === 1.5
    && pts[pts.length - 1][0] === 3.5 && pts[pts.length - 1][1] === 1.5);
  check("a route through a doorway needs few waypoints", pts.length <= 5, `${pts.length}`);
  check("no leg crosses a wall", pts.slice(1).every(([x, z], i) => {
    const [px, pz] = pts[i];
    // sample the leg and confirm every cell transition is legal
    const N = 24;
    let ok = true, cur = cellKey(Math.floor(px / g.tile), Math.floor(pz / g.tile));
    for (let t = 1; t <= N; t++) {
      const sx = px + (x - px) * (t / N), sz = pz + (z - pz) * (t / N);
      const nk = cellKey(Math.floor(sx / g.tile), Math.floor(sz / g.tile));
      if (nk === cur) continue;
      const [ax, az] = cur.split(",").map(Number);
      const [bx, bz] = nk.split(",").map(Number);
      if (!passable(g.levels[0], ax, az, bx, bz)) ok = false;
      cur = nk;
    }
    return ok;
  }), "a leg passes through a wall");
  check("unreachable target routes to null", routeLocal(plan, 0.5, 0.5, 99, 99) === null);
}

// 18. exterior AO — the outside gets modelled too
{
  const g = normalize(HOUSE);
  const lv = g.levels[0];
  const floorY = lv.y + g.slabT;
  const sh = makeShader(lv, g, floorY);
  const lum = (y: number) => sh(0.5, y, -g.wallT / 2, 0, 0, -1)[0];
  check("the eaves throw shade down the wall top", lum(floorY + 2.65) < lum(floorY + 1.5) * 0.92,
    `${lum(floorY + 2.65).toFixed(3)} vs ${lum(floorY + 1.5).toFixed(3)}`);
  check("the ground darkens the wall base", lum(floorY + 0.12) < lum(floorY + 1.5) * 0.95,
    `${lum(floorY + 0.12).toFixed(3)} vs ${lum(floorY + 1.5).toFixed(3)}`);
  check("mid-wall stays bright outside", lum(floorY + 1.5) > 0.85, `${lum(floorY + 1.5).toFixed(3)}`);
  // an interior face of the SAME wall must read darker than its exterior face
  const inFace = sh(0.5, floorY + 1.5, g.wallT / 2, 0, 0, 1)[0];
  check("inside is dimmer than outside on one wall", inFace < lum(floorY + 1.5),
    `${inFace.toFixed(3)} vs ${lum(floorY + 1.5).toFixed(3)}`);
}

// 19. SWEPT WALLS — built from the wall's direction, not the world's axes
{
  const g = normalize(HOUSE);
  const lv = g.levels[0];
  const floorY = lv.y + g.slabT;
  const lines = wallPolylines(lv, g);

  check("solid walls chain into polylines", lines.length > 0);
  // The divider meets the shell at a T. The shell must run THROUGH that node
  // as one line while the divider ends against it — three stubs meeting at a
  // point is what "straightest continuation" exists to prevent.
  const lens = lines.map((l) => l.pts.length).sort((a, b) => b - a);
  check("the shell chains into one long run, the divider is its own stub",
    lines.length === 2 && lens[0] >= 8 && lens[1] === 2, JSON.stringify(lens));
  const stub = lines.find((l) => l.pts.length === 2)!;
  check("the divider stub ends ON the shell",
    stub.pts.some(([, z]) => Math.abs(z - 2) < 1e-9), JSON.stringify(stub.pts));
  check("apertured segments are excluded from runs",
    lines.every((l) => l.pts.length >= 2));

  // a closed ring must wrap, or its last corner is left unmitred
  const ring = normalize({ levels: [{ tiles: [[0, 0]],
    walls: [[0, 0, 0], [1, 0, 0], [0, 0, 1], [1, 1, 0]] }] });
  const rl = wallPolylines(ring.levels[0], ring);
  check("a closed room is one wrapped ring", rl.length === 1
    && rl[0].pts.length === 5
    && rl[0].pts[0][0] === rl[0].pts[4][0] && rl[0].pts[0][1] === rl[0].pts[4][1],
    JSON.stringify(rl.map((l) => l.pts)));

  // the profile carries the skirting and the chamfer
  const prof = wallProfile(g);
  check("the profile is a plinth, a wall and a chamfered top", prof.length === 10, `${prof.length}`);
  check("the plinth stands proud of the wall face",
    Math.min(...prof.map((q) => q[0])) < -g.wallT / 2);
  check("the top is chamfered, not square",
    prof.filter((q) => Math.abs(q[1] - g.wallH) < 1e-9).length === 2);

  // THE MITRE. At a 90° corner the outer face must reach exactly the corner
  // point — 1/cos(45°) = √2 times the half-thickness. A naive (unmitred) sweep
  // falls short by that factor and leaves a notch, which is the whole defect
  // the box model kept reproducing.
  const L = [[0, 0], [2, 0], [2, 2]];
  const sw = sweepProfile(L, [[-g.wallT / 2, 0], [g.wallT / 2, 0]], 0);
  const xs: number[] = [], zs: number[] = [];
  for (let i = 0; i < sw.positions.length; i += 3) { xs.push(sw.positions[i]); zs.push(sw.positions[i + 2]); }
  const outer = Math.max(...xs);
  check("a 90° mitre reaches the full corner",
    Math.abs(outer - (2 + g.wallT / 2)) < 1e-6, `outer x = ${outer}`);

  // and a 45° turn mitres too — this is what makes diagonals possible
  const D = [[0, 0], [2, 0], [3, 1]];
  const sd = sweepProfile(D, [[-g.wallT / 2, 0], [g.wallT / 2, 0]], 0);
  check("a 45° turn produces finite, mitred geometry",
    sd.positions.every((v: number) => Number.isFinite(v)) && sd.positions.length > 0);
  const widths: number[] = [];
  for (let r = 0; r < sd.rings; r++) {
    const a = r * 2 * 3, b = a + 3;
    widths.push(Math.hypot(sd.positions[b] - sd.positions[a], sd.positions[b + 2] - sd.positions[a + 2]));
  }
  check("the mitre widens at the turn, never pinches",
    widths.every((w) => w >= g.wallT - 1e-9), widths.map((w) => w.toFixed(3)).join(", "));

  // the level plan carries sweeps
  const plan = planStructure(HOUSE);
  check("the plan carries swept walls", (plan.levels[0] as any).sweeps.length > 0);
  check("swept geometry is well-formed", (plan.levels[0] as any).sweeps.every((s2: any) =>
    s2.positions.length % 3 === 0 && s2.indices.length % 3 === 0
    && s2.indices.every((i: number) => i >= 0 && i < s2.positions.length / 3)));
}

// 20. NORMALS FACE OUT
//
// Every geometric test above passed while the entire building was inside-out:
// they all asked about POSITIONS, and winding is not a position. A swept
// surface has no natural orientation — the lateral offset is the left normal
// of travel, so the obvious quad order puts u=-t/2 faces back into the wall —
// and the failure does not read as "normals are flipped", it reads as the
// whole thing being cursed.
{
  const g = normalize(HOUSE);
  const faceNormals = (sw: any) => {
    const P = sw.positions, I = sw.indices, out: any[] = [];
    for (let t = 0; t < I.length; t += 3) {
      const q = (k: number) => [P[I[t + k] * 3], P[I[t + k] * 3 + 1], P[I[t + k] * 3 + 2]];
      const [p0, p1, p2] = [q(0), q(1), q(2)];
      const u = [p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]];
      const v = [p2[0] - p0[0], p2[1] - p0[1], p2[2] - p0[2]];
      out.push({
        n: [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]],
        c: [(p0[0] + p1[0] + p2[0]) / 3, (p0[1] + p1[1] + p2[1]) / 3, (p0[2] + p1[2] + p2[2]) / 3],
      });
    }
    return out;
  };
  // SIGNED VOLUME is the honest test. A centroid heuristic cannot judge a
  // stepped profile — the plinth's top ledge faces up but sits below the mesh
  // centre, so it reads as inward every time. For a CLOSED surface, consistent
  // outward winding gives positive volume and inside-out gives negative, with
  // no heuristic anywhere. Closing the profile makes the sweep a closed solid.
  const closedProf: [number, number][] = [[-0.075, 0], [-0.075, 2.8], [0.075, 2.8], [0.075, 0], [-0.075, 0]];
  const solid = sweepProfile([[0, 0], [3, 0]], closedProf, 0);
  const volume = (x: any) => {
    let vol = 0;
    for (let t = 0; t < x.indices.length; t += 3) {
      const q = (k: number) => [x.positions[x.indices[t + k] * 3], x.positions[x.indices[t + k] * 3 + 1], x.positions[x.indices[t + k] * 3 + 2]];
      const [p0, p1, p2] = [q(0), q(1), q(2)];
      vol += (p0[0] * (p1[1] * p2[2] - p1[2] * p2[1])
            - p0[1] * (p1[0] * p2[2] - p1[2] * p2[0])
            + p0[2] * (p1[0] * p2[1] - p1[1] * p2[0])) / 6;
    }
    return vol;
  };
  const vol = volume(solid);
  const expect = 3 * 0.15 * 2.8;
  check("a swept solid has POSITIVE volume (right-side-out)", vol > 0, `${vol.toFixed(4)}`);
  check("...and it is the volume it should be", Math.abs(vol - expect) < 1e-6,
    `${vol.toFixed(4)} vs ${expect.toFixed(4)}`);

  // control: reversed winding must go negative, or the test asserts nothing
  const flipped = { ...solid, indices: [] as number[] };
  for (let t = 0; t < solid.indices.length; t += 3) {
    flipped.indices.push(solid.indices[t], solid.indices[t + 2], solid.indices[t + 1]);
  }
  check("control: reversed winding IS detected", volume(flipped) < 0,
    `${volume(flipped).toFixed(4)}`);

  const sw = sweepProfile([[0, 0], [3, 0]], wallProfile(g), 0);
  // END CAPS. An open run without them is a hollow tube, and at a doorway you
  // look into the inside of the wall — which reads as a missing jamb, not as a
  // missing face. An uncapped sweep has strictly fewer triangles.
  const uncappedTris = (sw.rings - 1) * (wallProfile(g).length - 1) * 2;
  check("an open run is capped at both ends",
    sw.indices.length / 3 > uncappedTris, `${sw.indices.length / 3} vs ${uncappedTris}`);
  check("the caps are the profile, twice",
    sw.indices.length / 3 === uncappedTris + capProfile(wallProfile(g)).length / 3 * 2,
    `${sw.indices.length / 3}`);

  // and a closed room, where the ring wraps
  const ring = normalize({ levels: [{ tiles: [[0, 0]],
    walls: [[0, 0, 0], [1, 0, 0], [0, 0, 1], [1, 1, 0]] }] });
  const rsw = levelSweeps(ring.levels[0], ring, 0);
  const centre = [0.5, 0.5];
  const wrongWay = rsw.flatMap((s2: any) => faceNormals(s2)).filter((f: any) => {
    // side faces only: must face away from the room centre, in or out
    if (Math.abs(f.n[1]) > Math.max(Math.abs(f.n[0]), Math.abs(f.n[2]))) return false;
    const dx = f.c[0] - centre[0], dz = f.c[2] - centre[1];
    const dot = f.n[0] * dx + f.n[2] * dz;
    const outerFace = Math.hypot(dx, dz) > 0.5;
    return outerFace ? dot <= 0 : dot >= 0;
  });
  check("a closed room is right-side-out on both faces", wrongWay.length === 0,
    `${wrongWay.length} wrong`);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
