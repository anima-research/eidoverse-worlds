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
  describeHere, describeStructure, localizePoint, levelParts, TRIM, joinExtents, wallRuns,
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
  check("16 boxes total", plan.boxes.length === 16, `got ${plan.boxes.length}`);
  check("8 floor slabs", n("floor") === 8, `got ${n("floor")}`);
  check("12 solid segments merge to 5 runs", n("wall") === 5, `got ${n("wall")}`);
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
  check("a windowed segment still gets its baseboard", at(0, 0, 0).length === 1,
    `${at(0, 0, 0).length} pieces`);
  // the door on edge (1,2,0) opens to the floor on both sides — no wall, no skirting
  check("a doored segment gets none (the opening reaches the floor)",
    at(1, 2, 0).length === 0, `${at(1, 2, 0).length} pieces`);
  check("baseboards sit ON the floor, one board high",
    base.every((p) => Math.abs(p.y0 - floorY) < 1e-9 && Math.abs(p.y1 - floorY - TRIM.base.h) < 1e-9));
  check("every baseboard stands proud of its wall face",
    base.every((p) => Math.min(p.x1 - p.x0, p.z1 - p.z0) > 0));

  // and the rest of the kit is present
  const kinds = new Set(parts.map((p) => p.kind));
  for (const k of ["floor", "wall", "base", "case", "sill", "glass", "roof"]) {
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

  const withJoin: any[] = [], without: any[] = [];
  for (const [k, edge] of lv.walls) {
    const ap = lv.apertures.get(k) ?? null;
    withJoin.push(...wallBoxes(edge, ap, g, floorY, joinExtents(lv, edge.axis, edge.x, edge.z, g)));
    without.push(...wallBoxes(edge, ap, g, floorY));      // the negative control
  }

  // the NW outer corner quadrant, at chest height
  const [cx, cy, cz] = [-h / 2, floorY + 1.2, -h / 2];
  check("control: unjoined segments DO leave a corner notch", !solidAt(without, cx, cy, cz),
    "the bug this test exists for is no longer reachable");
  check("an external corner is solid", solidAt(withJoin, cx, cy, cz));

  // all four corners of the rectangular shell, and the full height of one
  const corners: [number, number][] = [[-h / 2, -h / 2], [4 + h / 2, -h / 2],
    [-h / 2, 2 + h / 2], [4 + h / 2, 2 + h / 2]];
  check("every external corner is solid",
    corners.every(([x, z]) => solidAt(withJoin, x, floorY + 1.2, z)),
    corners.filter(([x, z]) => !solidAt(withJoin, x, floorY + 1.2, z)).join(" | "));
  check("solid up the corner's whole height",
    [0.1, 0.9, 1.8, 2.7].every((dy) => solidAt(withJoin, cx, floorY + dy, cz)));

  // a free end must NOT grow a nub — extension is for joints only
  const stub = normalize({ levels: [{ tiles: [[0, 0]], walls: [[0, 0, 0]] }] });
  const sl = stub.levels[0];
  const [e0, e1] = joinExtents(sl, 0, 0, 0, stub);
  check("a wall ending in open space is not extended", e0 === 0 && e1 === 0, `${e0}, ${e1}`);
  // ...while a corner joint extends on exactly the joined side
  const ell = normalize({ levels: [{ tiles: [[0, 0]], walls: [[0, 0, 0], [1, 0, 0]] }] });
  const el = ell.levels[0];
  const [f0, f1] = joinExtents(el, 0, 0, 0, ell);
  check("a joined end extends by half a thickness", f0 === ell.wallT / 2 && f1 === 0,
    `${f0}, ${f1}`);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
