// shared/structure_edit.js — the editor's pure half, tested headless.
//
//   bun tools/structure-edit-test.ts
//
// Every operation is data in, data out. That is what makes undo "keep the
// previous value", makes a preview and a commit literally the same function,
// and makes the whole editor testable with no browser and no pointer.

import {
  emptyStructure, pickEdge, pickEdges, pickCell, addWall, removeWall,
  setAperture, setTile, removeTile, drawRoom, eraseRoom, labelCell, pickWalledEdge,
} from "../shared/structure_edit.js";
import { planStructure, normalize, edgeKey } from "../shared/structure.js";

let passed = 0, failed = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
};
const walls = (d: any) => normalize(d).levels[0].walls;
const tiles = (d: any) => normalize(d).levels[0].tiles;

console.log(`\nstructure_edit — the editor's pure half\n`);

const G = { tile: 1 };

// 1. picking
{
  check("near the north edge picks it", pickEdge(G, 0.5, 0.05)!.axis === 0
    && pickEdge(G, 0.5, 0.05)!.z === 0);
  check("near the south edge picks the NEXT z", pickEdge(G, 0.5, 0.95)!.z === 1);
  check("near the west edge picks axis 1", pickEdge(G, 0.05, 0.5)!.axis === 1);
  check("near the east edge picks the NEXT x", pickEdge(G, 0.95, 0.5)!.x === 1);
  // the diagonals cross the middle, so the centre of a cell is nearest to them
  check("the cell centre is nearest a diagonal", pickEdge(G, 0.5, 0.5)!.axis >= 2);
  check("a tool can refuse diagonals", pickEdge(G, 0.5, 0.5, { diagonals: false })!.axis < 2);
  check("picking works in negative coords", pickCell(G, -0.5, -2.5).x === -1
    && pickCell(G, -0.5, -2.5).z === -3);
  check("every edge of the cell is offered", pickEdges(G, 0.3, 0.3).length === 6);
  check("...nearest first", pickEdges(G, 0.3, 0.3).every((e, i, a) => i === 0 || e.d >= a[i - 1].d));
}

// 2. nothing is mutated — the whole undo story rests on this
{
  const a = emptyStructure();
  const before = JSON.stringify(a);
  const b = drawRoom(a, { x: 0, z: 0 }, { x: 2, z: 1 });
  check("the input is untouched", JSON.stringify(a) === before);
  check("the output is different", JSON.stringify(b) !== before);
  check("undo is just the previous value", JSON.stringify(a) === before);
}

// 3. room drag — the primary tool
{
  const d = drawRoom(emptyStructure(), { x: 0, z: 0 }, { x: 2, z: 1 });
  check("floor fills the span", tiles(d).size === 6, `${tiles(d).size}`);
  check("walls run right round it", walls(d).size === 10, `${walls(d).size}`);
  check("it is ONE room", planStructure(d).levels[0].rooms.length === 1);

  // THE POINT OF EDGES: a second room against the first shares their wall
  const two = drawRoom(d, { x: 3, z: 0 }, { x: 4, z: 1 });
  check("an adjoining room SHARES the common wall", walls(two).size === 16,
    `${walls(two).size} (18 would mean two walls in one place)`);
  check("...and they are two rooms", planStructure(two).levels[0].rooms.length === 2);
  // dragging the same room twice changes nothing
  check("drawing a room twice is idempotent",
    JSON.stringify(drawRoom(d, { x: 0, z: 0 }, { x: 2, z: 1 })) === JSON.stringify(d));
  check("drag direction does not matter",
    JSON.stringify(drawRoom(emptyStructure(), { x: 2, z: 1 }, { x: 0, z: 0 })) === JSON.stringify(d));
}

// 4. walls and apertures
{
  let d = drawRoom(emptyStructure(), { x: 0, z: 0 }, { x: 2, z: 1 });
  d = setAperture(d, { axis: 0, x: 1, z: 0 }, "window");
  check("an aperture goes into a wall", planStructure(d).levels[0].portals.length === 1);
  check("...and it knows its kind", planStructure(d).levels[0].portals[0].kind === "window");
  d = setAperture(d, { axis: 0, x: 1, z: 0 }, "door");
  check("re-holing replaces rather than stacking",
    planStructure(d).levels[0].portals.length === 1
    && planStructure(d).levels[0].portals[0].kind === "door");
  d = setAperture(d, { axis: 0, x: 1, z: 0 }, null);
  check("an aperture can be cleared", planStructure(d).levels[0].portals.length === 0);

  const orphan = setAperture(emptyStructure(), { axis: 0, x: 9, z: 9 }, "door");
  check("an aperture with no wall is refused",
    normalize(orphan).levels[0].apertures.size === 0);

  // removing a wall takes its hole with it
  let e = addWall(emptyStructure(), { axis: 0, x: 0, z: 0 });
  e = setAperture(e, { axis: 0, x: 0, z: 0 }, "door");
  e = removeWall(e, { axis: 0, x: 0, z: 0 });
  check("removing a wall removes its aperture",
    walls(e).size === 0 && normalize(e).levels[0].apertures.size === 0);

  check("adding the same wall twice is idempotent",
    walls(addWall(addWall(emptyStructure(), { axis: 0, x: 0, z: 0 }), { axis: 0, x: 0, z: 0 })).size === 1);
  // a cell can hold one diagonal, not two
  let dg = addWall(emptyStructure(), { axis: 2, x: 0, z: 0 });
  dg = addWall(dg, { axis: 3, x: 0, z: 0 });
  check("a second diagonal REPLACES the first (a cell cuts once)",
    walls(dg).size === 1 && walls(dg).has(edgeKey(3, 0, 0)));
}

// 5. erase — a wall survives if it is still someone else's
{
  const two = drawRoom(drawRoom(emptyStructure(), { x: 0, z: 0 }, { x: 1, z: 1 }),
    { x: 2, z: 0 }, { x: 3, z: 1 });
  const before = walls(two).size;
  const gone = eraseRoom(two, { x: 2, z: 0 }, { x: 3, z: 1 });
  check("erasing takes the floor", tiles(gone).size === 4, `${tiles(gone).size}`);
  check("the SHARED wall survives — the neighbour still needs it",
    walls(gone).has(edgeKey(1, 2, 0)) && walls(gone).has(edgeKey(1, 2, 1)),
    `${before} → ${walls(gone).size}`);
  check("the erased room's own outer walls go",
    !walls(gone).has(edgeKey(1, 4, 0)));
  check("what remains is still one whole room",
    planStructure(gone).levels[0].rooms.length === 1);
  check("erasing everything leaves nothing",
    walls(eraseRoom(two, { x: 0, z: 0 }, { x: 3, z: 1 })).size === 0);
}

// 6. tiles and labels
{
  let d = setTile(emptyStructure(), { x: 0, z: 0 });
  check("a tile can be laid", tiles(d).size === 1);
  d = setTile(d, { x: 0, z: 0 }, "floor", "B");
  check("re-laying replaces rather than doubling", tiles(d).size === 1);
  check("...and keeps the half", normalize(d).levels[0].halves.get("0,0") === "B");
  check("a tile can be lifted", tiles(removeTile(d, { x: 0, z: 0 })).size === 0);

  const named = labelCell(drawRoom(emptyStructure(), { x: 0, z: 0 }, { x: 1, z: 1 }),
    { x: 0, z: 0 }, "kitchen");
  check("a room can be named", planStructure(named).levels[0].rooms[0].label === "kitchen");
  check("...and unnamed",
    planStructure(labelCell(named, { x: 0, z: 0 }, null)).levels[0].rooms[0].label === null);
}

// 7. everything an editor emits must survive the planner
{
  let d = emptyStructure();
  d = drawRoom(d, { x: 0, z: 0 }, { x: 3, z: 2 });
  // the divider must span the FULL depth or the space simply flows round it —
  // which is correct, and was my fixture being wrong rather than the planner
  for (let z = 0; z <= 2; z++) d = addWall(d, { axis: 1, x: 2, z });
  d = setAperture(d, { axis: 1, x: 2, z: 1 }, "door");
  d = addWall(d, { axis: 2, x: 3, z: 0 });
  d = setTile(d, { x: 3, z: 0 }, "floor", "B");
  d = labelCell(d, { x: 0, z: 0 }, "hall");
  const plan = planStructure(d);
  check("a hand-built plan derives rooms", plan.levels[0].rooms.length >= 2);
  check("...and sweeps geometry", plan.levels[0].sweeps.length > 0);
  check("...and collides", plan.boxes.length > 0);
  check("...and every sweep is finite",
    plan.levels[0].sweeps.every((s: any) => s.positions.every((v: number) => Number.isFinite(v))));
  check("the whole thing fits the 8KB component cap",
    JSON.stringify(d).length < 8192, `${JSON.stringify(d).length} bytes`);
}

// 8. picking a wall to put a door in
//
// Geometric nearness is the wrong question here. The diagonals cross a cell's
// middle, so anywhere near the centre the nearest edge is a diagonal that
// usually has no wall — and a door click silently did nothing.
{
  const d = drawRoom(emptyStructure(), { x: 0, z: 0 }, { x: 2, z: 1 });
  const mid = pickEdge(d, 1.5, 0.5)!;
  check("control: the plain pick returns a diagonal mid-cell", mid.axis >= 2, `axis ${mid.axis}`);
  const walled = pickWalledEdge(d, 1.5, 0.5)!;
  check("the walled pick returns a real wall", walled !== null && walled.axis < 2,
    JSON.stringify(walled));
  check("...and it is one the building actually has",
    normalize(d).levels[0].walls.has(edgeKey(walled.axis, walled.x, walled.z)));
  // near an edge, both agree
  const near = pickWalledEdge(d, 1.5, 0.04)!;
  check("near a wall it picks that wall", near.axis === 0 && near.z === 0, JSON.stringify(near));
  check("an empty building offers nothing", pickWalledEdge(emptyStructure(), 0.5, 0.5) === null);

  // and the door lands
  const holed = setAperture(d, pickWalledEdge(d, 1.5, 0.5)!, "door");
  check("a door placed by walled-pick actually lands",
    planStructure(holed).levels[0].portals.length === 1);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
