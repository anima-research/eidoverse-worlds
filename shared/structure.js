// structure_field — the griddled-building model's pure half (§11.4 discipline,
// sibling of models_field.js / flora_field.js / emitter_field.js).
//
// Given one `structure` component's data, decide EVERYTHING the world needs to
// know about that building: the boxes to draw, the boxes to collide, the rooms
// the walls enclose, and the doorways that join them. No THREE, no DOM, no
// scheduler, no colliders import — the hosted half (realize/structure.js)
// executes this plan; this half is the part a headless test can hold to the
// light (tools/structure-field-test.ts).
//
// WHY A GRID AT ALL. A conjured building is one opaque mesh: an agent can be
// told its bounding box and nothing else. It cannot ask which room it is in,
// what that room connects to, or where the door is, because none of that is
// written down anywhere — it is an emergent property of triangles. A griddled
// building writes the topology down, so "you are in the kitchen; the hallway is
// through the south door" is a DERIVATION rather than a guess. Everything in
// this file exists to make that derivation cheap and total.
//
// THE ONE LOAD-BEARING CHOICE: walls live on grid EDGES, not in cells. Sims got
// this right and every alternative goes wrong the same way. An edge is shared
// by exactly two cells, so a wall between the kitchen and the hall is ONE wall —
// it cannot be double-counted, cannot disagree with itself about thickness, and
// corners join because two edges meeting at a lattice point are exactly two
// edges meeting at a point. Cell-owned walls ("this cell has a north wall")
// need a rule for whose wall it is when both neighbours claim one, and every
// such rule leaks.
//
// COORDINATES. Cell (x, z) covers grid-local [x, x+1) × [z, z+1) on the ground
// plane. Edges are canonical by construction:
//   axis 0 — runs along X, from (x, z) to (x+1, z): the boundary between cell
//            (x, z-1) and cell (x, z).
//   axis 1 — runs along Z, from (x, z) to (x, z+1): the boundary between cell
//            (x-1, z) and cell (x, z).
// There is exactly one way to name any given edge, so no canonicalization pass
// is needed and no de-duplication can be forgotten. All coordinates here are
// GRID-LOCAL: a grid is an entity with its own position and yaw, and multiple
// grids at arbitrary angles to each other never need to agree about anything.

/** @typedef {{ x0:number, y0:number, z0:number, x1:number, y1:number, z1:number,
 *              mat:string, kind:'floor'|'wall'|'jamb'|'sill'|'lintel' }} Box */

/** @typedef {{ id:string, label:string|null, cells:string[], area:number,
 *              min:[number,number], max:[number,number],
 *              centre:[number,number] }} Room */

/** @typedef {{ axis:0|1, x:number, z:number, kind:'door'|'window',
 *              between:[string|null, string|null] }} Portal */

/** Defaults chosen once, deliberately, because they are a CONTRACT: every
 *  part ever generated against this grid assumes them, so changing them later
 *  invalidates content rather than just re-rendering it. 1m tiles read well at
 *  a 1.7m avatar height (the Sims metric, and the one the terrain heightfield
 *  is already comfortable with); 2.8m floor-to-floor is a generous domestic
 *  storey; 0.15m walls are thick enough to read as masonry at arm's length
 *  without eating a tile. */
export const GRID_DEFAULTS = Object.freeze({
  tile: 1.0,      // metres per cell
  wallH: 2.8,     // wall height / floor-to-floor
  wallT: 0.15,    // wall thickness
  slabT: 0.10,    // floor slab thickness (top sits at the level's y)
});

/** Aperture profiles. An aperture is a HOLE IN A WALL SEGMENT, not an object:
 *  it owns a whole edge and is described by how much wall is left above and
 *  below it. Keeping them parametric (rather than a boolean subtract against a
 *  mesh) is what lets the same decomposition serve geometry AND collision — the
 *  hole is free on both sides because we never cut anything, we just decline to
 *  emit boxes there. This is why the movement solver needs no concept of a
 *  hole: a doorway is an absence of boxes, and absence is already walkable.
 *
 *  AN APERTURE SPANS ITS WHOLE SEGMENT — it is one tile wide, exactly as in
 *  Sims, and there are no side jambs. That is not a simplification, it is a
 *  correctness requirement, and it was found by test rather than reasoned out:
 *  a 0.9m door in a 1m tile leaves 5cm jambs, and a 5cm box is far thinner than
 *  a 32cm body radius. The movement solver ejects a body through the NEAREST
 *  face, so a sliver jamb pushes you sideways ALONG the wall instead of back
 *  out of it — you slide through the doorframe rather than being stopped by it.
 *  Any jamb narrow enough to leave a usable door in a 1m tile is too narrow to
 *  collide correctly, so the honest answer is not to have one. The neighbouring
 *  wall segments are the jambs; a decorative frame, if wanted later, is trim
 *  and must not collide. */
export const APERTURES = Object.freeze({
  door:   { bottom: 0.00, top: 2.10 },
  window: { bottom: 0.90, top: 2.10 },
  arch:   { bottom: 0.00, top: 2.40 },
});

export const cellKey = (x, z) => `${x},${z}`;
export const edgeKey = (axis, x, z) => `${axis}:${x},${z}`;

/** The two cells an edge separates, in grid-local coords. Order is stable:
 *  [negative side, positive side] along the edge's normal. */
export function edgeCells(axis, x, z) {
  return axis === 0
    ? [[x, z - 1], [x, z]]     // an X-running edge separates north from south
    : [[x - 1, z], [x, z]];    // a Z-running edge separates west from east
}

/** The edge between two orthogonally adjacent cells, or null if they aren't
 *  neighbours. The inverse of edgeCells, and the reason flood fill can ask
 *  "is there a wall in my way" in O(1). */
export function edgeBetween(ax, az, bx, bz) {
  if (ax === bx && az === bz - 1) return [0, ax, bz];       // b is south of a
  if (ax === bx && az === bz + 1) return [0, ax, az];       // b is north of a
  if (az === bz && ax === bx - 1) return [1, bx, az];       // b is east of a
  if (az === bz && ax === bx + 1) return [1, ax, az];       // b is west of a
  return null;
}

/** Grid-local compass. Names are LOCAL to the grid: a grid rotated 40° has its
 *  own north, and the describer that reports to a person is responsible for
 *  composing this with the grid's yaw. Reporting local names as if they were
 *  world names is the obvious bug here, so the vocabulary is deliberately
 *  distinct from the world compass used in look(). */
export const SIDES = Object.freeze({ N: 'north', E: 'east', S: 'south', W: 'west' });

/** Which local side of `cell` this edge lies on. */
export function sideOfCell(axis, x, z, cx, cz) {
  if (axis === 0) return cz === z ? 'N' : 'S';
  return cx === x ? 'W' : 'E';
}

// ---- normalization ----------------------------------------------------------

/** Coerce one component payload into a shape the planner can trust totally.
 *  Total by construction: a malformed structure yields an EMPTY plan, never a
 *  throw. This half runs inside a fold-driven realizer, and the sequencer's
 *  house rule 3 (one bad message may never become a shared outage) applies just
 *  as hard one layer down — a neighbour's broken house must not stop yours from
 *  drawing. Anything unparseable is simply not there. */
export function normalize(data) {
  const d = (data && typeof data === 'object') ? data : {};
  const num = (v, dflt) => (Number.isFinite(v) && v > 0 ? v : dflt);
  const g = {
    tile: num(d.tile, GRID_DEFAULTS.tile),
    wallH: num(d.wallH, GRID_DEFAULTS.wallH),
    wallT: num(d.wallT, GRID_DEFAULTS.wallT),
    slabT: num(d.slabT, GRID_DEFAULTS.slabT),
    levels: [],
    labels: (d.labels && typeof d.labels === 'object') ? d.labels : {},
  };
  const int = (v) => (Number.isInteger(v) ? v : null);
  for (const raw of Array.isArray(d.levels) ? d.levels : []) {
    const lv = (raw && typeof raw === 'object') ? raw : {};
    const tiles = new Map();     // cellKey -> mat
    const walls = new Map();     // edgeKey -> {axis, x, z, mat}
    const apertures = new Map(); // edgeKey -> kind
    for (const t of Array.isArray(lv.tiles) ? lv.tiles : []) {
      const x = int(t?.[0]), z = int(t?.[1]);
      if (x == null || z == null) continue;
      tiles.set(cellKey(x, z), typeof t[2] === 'string' ? t[2] : 'floor');
    }
    for (const w of Array.isArray(lv.walls) ? lv.walls : []) {
      const axis = w?.[0] === 1 ? 1 : w?.[0] === 0 ? 0 : null;
      const x = int(w?.[1]), z = int(w?.[2]);
      if (axis == null || x == null || z == null) continue;
      walls.set(edgeKey(axis, x, z), { axis, x, z, mat: typeof w[3] === 'string' ? w[3] : 'wall' });
    }
    for (const a of Array.isArray(lv.apertures) ? lv.apertures : []) {
      const axis = a?.[0] === 1 ? 1 : a?.[0] === 0 ? 0 : null;
      const x = int(a?.[1]), z = int(a?.[2]);
      const kind = APERTURES[a?.[3]] ? a[3] : null;
      if (axis == null || x == null || z == null || !kind) continue;
      // An aperture with no wall to sit in is not a doorway, it is nothing.
      // Dropping it here keeps every later stage able to assume the wall
      // exists, rather than each of them re-checking.
      const k = edgeKey(axis, x, z);
      if (!walls.has(k)) continue;
      apertures.set(k, kind);
    }
    g.levels.push({ y: Number.isFinite(lv.y) ? lv.y : 0, tiles, walls, apertures });
  }
  return g;
}

// ---- geometry + collision ---------------------------------------------------

/** Decompose one wall edge into boxes, in grid-local metres.
 *
 *  With no aperture that is one box. With an aperture it is at most two — a
 *  sill below and a lintel above, each spanning the full segment:
 *
 *      ┌──────────────────┐
 *      │      lintel      │
 *      ├──────────────────┤   ← the hole: no box, so it is walkable
 *      │       sill       │      by absence, with no solver change
 *      └──────────────────┘
 *
 *  A door has no sill (bottom 0); an arch reaching wallH has no lintel either,
 *  and is then simply an absent wall that still separates two rooms. Boxes that
 *  would be degenerate are never emitted, so no sliver can reach the solver. */
/** How far a segment must run PAST each of its lattice points to close a corner.
 *
 *  A wall straddles its edge, so an X-edge covers z ∈ [-t/2, +t/2] and its
 *  perpendicular neighbour covers x ∈ [-t/2, +t/2]. Where they meet, the inner
 *  quadrant is covered twice and the OUTER quadrant — x ∈ [-t/2, 0] paired with
 *  z ∈ [-t/2, 0] — belongs to neither. That absence is a t/2 square notch
 *  running the full height of every external corner, and it reads in-world as a
 *  vertical groove down the outside of the building.
 *
 *  Extending each segment by half a thickness into any joint it actually
 *  participates in closes it. Free ends are left alone, so a wall that stops in
 *  open space still stops where it says it does. */
/** Fill the missing quadrant at each corner with its OWN small box, rather than
 *  stretching a wall across it.
 *
 *  Stretching was wrong twice over, and both showed in-world:
 *
 *  - AT A T-JUNCTION there is no gap at all. The crossing wall already spans
 *    ±t/2, so it covers the quadrants by itself; extending the stem drove its
 *    end cap out to the crossing wall's OUTER face, flush and coplanar. That is
 *    an interior wall appearing on the outside of the building, and a z-fight
 *    along the seam where it lands.
 *  - AT AN L-CORNER extending does close the notch, but leaves both walls with
 *    a face on the same plane, facing the same way, OVERLAPPING — which is
 *    precisely what z-fights.
 *
 *  A quadrant box does neither. Its faces are coplanar with the walls' faces
 *  but ADJACENT rather than overlapping — they tile the plane instead of
 *  competing for it — and its end caps sit back-to-back with the walls', which
 *  backface culling resolves for free.
 *
 *  A quadrant is uncovered exactly when neither wall bounding it is present,
 *  and it is a CORNER (rather than open air past a free end) exactly when both
 *  opposite walls are. Free ends grow nothing. */
export function cornerFills(level, g, y0, y1) {
  const h = g.wallT / 2;
  const pts = new Set();
  for (const [, e] of level.walls) {
    if (e.axis === 0) { pts.add(`${e.x},${e.z}`); pts.add(`${e.x + 1},${e.z}`); }
    else { pts.add(`${e.x},${e.z}`); pts.add(`${e.x},${e.z + 1}`); }
  }
  const out = [];
  for (const p of [...pts].sort()) {
    const [px, pz] = p.split(',').map(Number);
    const W = level.walls.has(edgeKey(0, px - 1, pz));
    const E = level.walls.has(edgeKey(0, px, pz));
    const N = level.walls.has(edgeKey(1, px, pz - 1));
    const S = level.walls.has(edgeKey(1, px, pz));
    //        sx  sz   would cover it   makes it a corner
    for (const [sx, sz, a, b, c, d] of [
      [+1, -1, E, N, W, S],   // NE
      [+1, +1, E, S, W, N],   // SE
      [-1, +1, W, S, E, N],   // SW
      [-1, -1, W, N, E, S],   // NW
    ]) {
      if (a || b || !c || !d) continue;
      const cx = px * g.tile, cz = pz * g.tile;
      out.push({
        x0: cx + (sx < 0 ? -h : 0), x1: cx + (sx < 0 ? 0 : h),
        y0, y1,
        z0: cz + (sz < 0 ? -h : 0), z1: cz + (sz < 0 ? 0 : h),
        mat: 'wall', kind: 'corner',
      });
    }
  }
  return out;
}

/** Group aperture-free wall segments into RUNS: maximal contiguous collinear
 *  chains sharing a material.
 *
 *  A five-tile wall was five independent boxes, which is the root the corner
 *  notch and the trim discontinuity both grew from — treating a wall as a pile
 *  of unrelated cubes means every join between them is something you have to
 *  remember to repair. A run is one box: no interior seams where collinear
 *  faces met, a fifth of the polygons, and a baseboard that is continuous
 *  because it is a single piece rather than several that happen to abut.
 *
 *  Apertured segments stay solitary — their vertical profile differs, so they
 *  are genuinely a different shape and break the run, exactly as a door breaks
 *  a wall in the world. */
export function wallRuns(level, g) {
  const lines = new Map();   // "axis:cross" -> [{ along, mat }]
  for (const [k, e] of level.walls) {
    if (level.apertures.has(k)) continue;
    const cross = e.axis === 0 ? e.z : e.x;
    const along = e.axis === 0 ? e.x : e.z;
    const lk = `${e.axis}:${cross}`;
    if (!lines.has(lk)) lines.set(lk, []);
    lines.get(lk).push({ along, mat: e.mat });
  }
  const runs = [];
  for (const [lk, items] of lines) {
    const [axis, cross] = lk.split(':').map(Number);
    items.sort((a, b) => a.along - b.along);
    let run = null;
    for (const it of items) {
      if (run && it.along === run.hi + 1 && it.mat === run.mat) { run.hi = it.along; continue; }
      if (run) runs.push(run);
      run = { axis, cross, lo: it.along, hi: it.along, mat: it.mat };
    }
    if (run) runs.push(run);
  }
  // deterministic: two agents folding the same log must build the same house
  runs.sort((a, b) => a.axis - b.axis || a.cross - b.cross || a.lo - b.lo);
  return runs;
}

/** A run's along-axis span in metres, extended into whatever joints it meets. */
export function runSpan(run, level, g) {
  const startEdge = run.axis === 0 ? [0, run.lo, run.cross] : [1, run.cross, run.lo];
  const endEdge = run.axis === 0 ? [0, run.hi, run.cross] : [1, run.cross, run.hi];
  // A run stops where it stops; corners are closed by cornerFills, not by
  // stretching this span past the wall it meets.
  void startEdge; void endEdge;
  return [run.lo * g.tile, (run.hi + 1) * g.tile];
}

export function wallBoxes(edge, aperture, g, y, ext = [0, 0]) {
  const { axis, x, z, mat } = edge;
  const t = g.wallT, h = g.wallH, half = t / 2;
  // Along-axis span in metres, and the fixed cross-axis band the wall occupies.
  const a0 = (axis === 0 ? x * g.tile : z * g.tile) - ext[0];
  const a1 = (axis === 0 ? x * g.tile : z * g.tile) + g.tile + ext[1];
  const cross = (axis === 0 ? z : x) * g.tile;
  const c0 = cross - half, c1 = cross + half;
  // Build in (along, low, high) terms, then project onto world axes once — the
  // projection is the only place the axis distinction appears, so the aperture
  // arithmetic below is written once rather than twice.
  const spans = [];
  const ap = aperture ? APERTURES[aperture] : null;
  if (!ap) {
    spans.push([a0, a1, 0, h, 'wall']);
  } else {
    const top = Math.min(ap.top, h);
    if (ap.bottom > 0) spans.push([a0, a1, 0, ap.bottom, 'sill']);
    if (top < h) spans.push([a0, a1, top, h, 'lintel']);
  }
  return spans.map(([s0, s1, lo, hi, kind]) => (axis === 0
    ? { x0: s0, y0: y + lo, z0: c0, x1: s1, y1: y + hi, z1: c1, mat, kind }
    : { x0: c0, y0: y + lo, z0: s0, x1: c1, y1: y + hi, z1: s1, mat, kind }));
}

/** One floor cell's slab.
 *
 *  A LEVEL'S `y` IS WHERE ITS FOUNDATION RESTS, NOT WHERE YOU WALK. The slab
 *  sits ON that height and occupies [y, y + slabT]; the walk surface is its
 *  TOP, and walls rise from there (see `floorY` in planStructure).
 *
 *  This was the other way round first, with the slab hanging below y so that y
 *  itself was walkable — and it z-fought the ground across every floor in the
 *  building, because a level-0 floor at y=0 is exactly coplanar with a terrain
 *  whose height is 0. The tempting fix is a depth bias on the floor material.
 *  The real one is that a foundation is a thing with thickness that rests on
 *  the ground: give it its thickness in the right direction and the surfaces
 *  cannot be coplanar, at any level, on any terrain, with no bias anywhere. */
export function tileBox(x, z, mat, g, y) {
  return {
    x0: x * g.tile, y0: y, z0: z * g.tile,
    x1: (x + 1) * g.tile, y1: y + g.slabT, z1: (z + 1) * g.tile,
    mat, kind: 'floor',
  };
}

// ---- rooms ------------------------------------------------------------------

/** Flood-fill the tiled cells into rooms, blocked by walls.
 *
 *  A DOOR DOES NOT MERGE TWO ROOMS. This is the Sims semantics and it is the
 *  useful one: a kitchen with a door to the hall is still a kitchen, and a
 *  person asked to go to the hall has somewhere to go. Rooms are separated by
 *  the presence of a WALL, whatever holes that wall has; an opening with no
 *  wall at all is what merges two areas into one room. Apertures therefore
 *  affect geometry, collision, and PORTALS — never room identity.
 *
 *  Determinism matters more than it looks: room ids are derived, and a set that
 *  reorders between two folds of the same log would make the same house
 *  describe itself differently to two agents standing in it. Scanning in sorted
 *  key order makes the labelling a pure function of the data. */
export function deriveRooms(level, g) {
  const seen = new Set();
  const rooms = [];
  const keys = [...level.tiles.keys()].sort();
  for (const start of keys) {
    if (seen.has(start)) continue;
    const cells = [];
    const stack = [start];
    seen.add(start);
    while (stack.length) {
      const k = stack.pop();
      cells.push(k);
      const [cx, cz] = k.split(',').map(Number);
      for (const [nx, nz] of [[cx, cz - 1], [cx + 1, cz], [cx, cz + 1], [cx - 1, cz]]) {
        const nk = cellKey(nx, nz);
        if (seen.has(nk) || !level.tiles.has(nk)) continue;
        const e = edgeBetween(cx, cz, nx, nz);
        if (e && level.walls.has(edgeKey(e[0], e[1], e[2]))) continue;  // a wall stops the fill
        seen.add(nk);
        stack.push(nk);
      }
    }
    cells.sort();
    let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
    for (const k of cells) {
      const [cx, cz] = k.split(',').map(Number);
      if (cx < minX) minX = cx; if (cx + 1 > maxX) maxX = cx + 1;
      if (cz < minZ) minZ = cz; if (cz + 1 > maxZ) maxZ = cz + 1;
    }
    rooms.push({
      id: `r${rooms.length + 1}`,
      label: g.labels[cells[0]] ?? cells.map((k) => g.labels[k]).find((v) => typeof v === 'string') ?? null,
      cells,
      area: cells.length * g.tile * g.tile,
      min: [minX * g.tile, minZ * g.tile],
      max: [maxX * g.tile, maxZ * g.tile],
      centre: [((minX + maxX) / 2) * g.tile, ((minZ + maxZ) / 2) * g.tile],
    });
  }
  return rooms;
}

/** Every aperture, resolved to the two rooms it joins. This is the payoff the
 *  whole grid exists for: "the door on the kitchen's south wall leads to the
 *  hall" is a lookup, not an inference. A null side means outdoors — an
 *  exterior door, which is exactly how you find the way out of a building
 *  without a special "exit" marker. */
export function derivePortals(level, rooms) {
  const roomOf = new Map();
  for (const r of rooms) for (const c of r.cells) roomOf.set(c, r.id);
  const portals = [];
  for (const [k, kind] of level.apertures) {
    const w = level.walls.get(k);
    if (!w) continue;
    const [[ax, az], [bx, bz]] = edgeCells(w.axis, w.x, w.z);
    portals.push({
      axis: w.axis, x: w.x, z: w.z, kind,
      between: [roomOf.get(cellKey(ax, az)) ?? null, roomOf.get(cellKey(bx, bz)) ?? null],
    });
  }
  return portals;
}

// ---- the plan ---------------------------------------------------------------

/** The whole derivation for one structure component: what to draw, what to
 *  collide, what the rooms are, what joins them.
 *
 *  Pure and total — same input, same output, no throw. The hosted half calls
 *  this on every reconcile and diffs nothing: rebuilding a building's geometry
 *  is cheap (hundreds of boxes), buildings are edited rarely and rendered
 *  constantly, and a full rebuild cannot drift from the state the way an
 *  incremental patch can. That trade is the same one `reconcile ∘ reconcile =
 *  reconcile` asks for one level up. */
export function planStructure(data) {
  const g = normalize(data);
  const boxes = [];
  const levels = [];
  for (const level of g.levels) {
    // The walk surface: the top of this level's foundation. Walls rise from it,
    // apertures are measured from it, and a body stands on it.
    const floorY = level.y + g.slabT;
    for (const [k, mat] of level.tiles) {
      const [x, z] = k.split(',').map(Number);
      boxes.push(tileBox(x, z, mat, g, level.y));
    }
    // solid stretches collide as one box per run; apertured segments keep their
    // own decomposition, because a hole is what makes them a different shape
    const half = g.wallT / 2;
    for (const run of wallRuns(level, g)) {
      const [a0, a1] = runSpan(run, level, g);
      boxes.push(edgeSpan(run.axis, run.cross * g.tile, a0, a1, -half, half,
        floorY, floorY + g.wallH, run.mat, 'wall'));
    }
    for (const [k, edge] of level.walls) {
      const ap = level.apertures.get(k);
      if (!ap) continue;
      boxes.push(...wallBoxes(edge, ap, g, floorY));
    }
    boxes.push(...cornerFills(level, g, floorY, floorY + g.wallH));
    const rooms = deriveRooms(level, g);
    levels.push({
      y: floorY, base: level.y, rooms, portals: derivePortals(level, rooms),
      // visual geometry rides alongside, never inside, the collision boxes
      parts: levelParts(level, g, floorY),
      sweeps: levelSweeps(level, g, floorY),
      level,
    });
  }
  return { grid: g, boxes, levels };
}

// ---- visual parts -----------------------------------------------------------
// A SECOND derivation from the same grid, for rendering only. Collision keeps
// `boxes` — simple, exact, and the thing the movement solver walks. Rendering
// wants baseboards and casings and a roof, which collision must never see.
//
// The invariant that matters is not "one list serves both" but "both come from
// one source": every part below is derived from the same normalized grid, so a
// doorway cannot be open to the eye and shut to the body.
//
// WHY TRIM AT ALL. Untrimmed box joins are the whole difference between
// architecture and CAD. A baseboard at the wall-floor line, a casing around
// every opening and a sill that stands proud of the wall face are what make a
// wall read as built rather than extruded — and geometry is the one budget we
// have to burn, since a whole house is presently 1,296 vertices.

export const TRIM = Object.freeze({
  base: { h: 0.11, proud: 0.020 },    // baseboard
  case: { w: 0.09, proud: 0.028 },    // door/window casing
  sill: { out: 0.055, t: 0.045 },     // window sill, protruding both faces
  roof: { over: 0.20, t: 0.16 },      // flat roof slab + overhang
  glass: { t: 0.02 },
});

/** Project an along/cross/vertical span onto world axes for one edge. The only
 *  place the axis distinction lives, so every part below is written once. */
function edgeSpan(axis, cross, a0, a1, c0, c1, y0, y1, mat, kind) {
  return axis === 0
    ? { x0: a0, y0, z0: cross + c0, x1: a1, y1, z1: cross + c1, mat, kind }
    : { x0: cross + c0, y0, z0: a0, x1: cross + c1, y1, z1: a1, mat, kind };
}

/** Which adjacent cells of an edge are floored — i.e. which of its two faces
 *  look into a room and therefore deserve interior trim. Returns signed offsets
 *  (-1 toward the negative side, +1 toward the positive) so callers can place
 *  parts on the correct face without re-deriving the geometry. */
function facesOf(level, axis, x, z) {
  const [[ax, az], [bx, bz]] = edgeCells(axis, x, z);
  const out = [];
  if (level.tiles.has(cellKey(ax, az))) out.push(-1);
  if (level.tiles.has(cellKey(bx, bz))) out.push(+1);
  return out;
}

/** Every visual part for one level. */
export function levelParts(level, g, floorY) {
  const parts = [];
  const t = g.wallT, half = t / 2, h = g.wallH;

  for (const [k, mat] of level.tiles) {
    const [x, z] = k.split(',').map(Number);
    parts.push(tileBox(x, z, mat, g, floorY - g.slabT));
  }

  // Solid stretches and their skirting are SWEPT (see levelSweeps) — geometry
  // built from the wall's own direction rather than the world's axes, so it
  // mitres at every turn and can run at any angle. Only the pieces that are
  // genuinely box-shaped stay here.

  for (const [k, edge] of level.walls) {
    const ap = level.apertures.get(k) ?? null;
    if (!ap) continue;                       // solid stretches ran above
    parts.push(...wallBoxes(edge, ap, g, floorY));

    const { axis, x, z } = edge;
    const a0 = (axis === 0 ? x : z) * g.tile, a1 = a0 + g.tile;
    const cross = (axis === 0 ? z : x) * g.tile;
    const faces = facesOf(level, axis, x, z);
    const prof = APERTURES[ap];

    // Casing frames the opening from the NEIGHBOURING segments' faces rather
    // than intruding into it — an aperture spans its whole tile, so a jamb
    // placed inside would narrow the hole the collider still says is open.
    const oB = floorY + prof.bottom, oT = floorY + Math.min(prof.top, h);
    // CASING MAY ONLY SIT ON WALL THAT EXISTS. It frames the opening from the
    // neighbouring collinear segments, so where there is no neighbour there is
    // nothing to sit on — and the trim does not merely hang in space, it punches
    // out through the face of whatever wall the opening meets. That is what put
    // an interior door's jambs on the OUTSIDE of the building: the door met the
    // exterior wall at a T, had no neighbour on that side, and its casing ran
    // 9cm along an axis whose outer face was 7.5cm away.
    const prevK = axis === 0 ? edgeKey(0, x - 1, z) : edgeKey(1, x, z - 1);
    const nextK = axis === 0 ? edgeKey(0, x + 1, z) : edgeKey(1, x, z + 1);
    const cw0 = level.walls.has(prevK) ? TRIM.case.w : 0;
    const cw1 = level.walls.has(nextK) ? TRIM.case.w : 0;
    const cw = TRIM.case.w;
    for (const s of faces) {
      const c0 = s < 0 ? -half - TRIM.case.proud : half;
      const c1 = c0 + TRIM.case.proud + 0.001;
      // A WINDOW LEAVES A WALL UNDER IT, AND THAT WALL IS STILL A WALL.
      // Skipping trim on every apertured segment is only right for a door,
      // whose opening reaches the floor; under a window there is a real stub
      // of wall meeting the floor, and it wants a baseboard like any other.
      // The skirting ran up to the window and stopped dead.
      if (prof.bottom > TRIM.base.h) {
        const b0 = s < 0 ? -half - TRIM.base.proud : half;
        parts.push(edgeSpan(axis, cross, a0, a1, b0, b0 + TRIM.base.proud + 0.001,
          floorY, floorY + TRIM.base.h, 'trim', 'base'));
      }
      if (cw0) parts.push(edgeSpan(axis, cross, a0 - cw0, a0, c0, c1, oB, oT, 'trim', 'case'));
      if (cw1) parts.push(edgeSpan(axis, cross, a1, a1 + cw1, c0, c1, oB, oT, 'trim', 'case'));
      if (oT < floorY + h) {
        parts.push(edgeSpan(axis, cross, a0 - cw0, a1 + cw1, c0, c1, oT, oT + cw, 'trim', 'case'));
      }
      if (prof.bottom > 0) {
        // sill: stands proud of the face, the one piece of trim you can rest
        // a mug on, and the thing that makes a window read as a window
        parts.push(edgeSpan(axis, cross, a0 - cw0, a1 + cw1,
          s < 0 ? -half - TRIM.sill.out : half, s < 0 ? -half : half + TRIM.sill.out,
          oB - TRIM.sill.t, oB, 'trim', 'sill'));
      }
    }
    if (prof.bottom > 0) {
      parts.push(edgeSpan(axis, cross, a0, a1, -TRIM.glass.t / 2, TRIM.glass.t / 2,
        oB, oT, 'glass', 'glass'));
    }
  }

  // Flat roof with an overhang. From outside, an open-topped box is the single
  // loudest "unfinished" signal; a slab with eaves and the shadow line they
  // throw is most of what makes a silhouette read as a building. Pitched roofs
  // are a straight-skeleton problem and remain deferred on purpose.
  let lo = null, hi = null;
  for (const k of level.tiles.keys()) {
    const [x, z] = k.split(',').map(Number);
    lo = lo ? [Math.min(lo[0], x), Math.min(lo[1], z)] : [x, z];
    hi = hi ? [Math.max(hi[0], x + 1), Math.max(hi[1], z + 1)] : [x + 1, z + 1];
  }
  if (lo) {
    const o = TRIM.roof.over;
    parts.push({
      x0: lo[0] * g.tile - o, y0: floorY + h, z0: lo[1] * g.tile - o,
      x1: hi[0] * g.tile + o, y1: floorY + h + TRIM.roof.t, z1: hi[1] * g.tile + o,
      mat: 'roof', kind: 'roof',
    });
  }
  return parts;
}

// ---- analytic shading -------------------------------------------------------
// The interior problem is a LIGHTING problem, not a texture problem. The scene
// carries one hemisphere light and one sun and no ambient occlusion of any kind
// (grepped: no SSAO, no aoMap, nothing) — so inside a sealed box every surface
// lands on the same value and all form reads flat. Texture on flat lighting is
// textured cardboard.
//
// It cannot be fixed with lights either: lightrig.js keeps 8 slots born at init
// precisely because runtime light-topology changes measured 388–1523ms frames.
// A point light per room is the thing this engine punishes hardest.
//
// So it is baked, analytically, at build time. Everything a screen-space AO
// pass tries to RECOVER from a depth buffer, we already KNOW: where the walls
// are, which joins are concave, which cells are deep interior and which are
// beside a window. Free at runtime, no texture bytes, no extra pass.

/** Per-cell daylight, BFS'd out from the apertures. Light enters through
 *  openings and spreads through open edges and doorways, so a room with a
 *  window is bright at the glass and dimmer at its back wall, and an interior
 *  room reached only through a door is dimmer throughout — which is the whole
 *  reason an interior stops reading as grey gas. */
export function opennessField(level, g) {
  const dist = new Map();
  const q = [];
  for (const k of level.apertures.keys()) {
    const w = level.walls.get(k);
    if (!w) continue;
    for (const [cx, cz] of edgeCells(w.axis, w.x, w.z)) {
      const ck = cellKey(cx, cz);
      if (!level.tiles.has(ck) || dist.has(ck)) continue;
      dist.set(ck, 0); q.push([cx, cz]);
    }
  }
  for (let i = 0; i < q.length; i++) {
    const [cx, cz] = q[i], d = dist.get(cellKey(cx, cz));
    for (const [nx, nz] of [[cx, cz - 1], [cx + 1, cz], [cx, cz + 1], [cx - 1, cz]]) {
      const nk = cellKey(nx, nz);
      if (!level.tiles.has(nk) || dist.has(nk)) continue;
      const e = edgeBetween(cx, cz, nx, nz);
      const ek = e && edgeKey(e[0], e[1], e[2]);
      // a wall blocks light unless it is holed
      if (ek && level.walls.has(ek) && !level.apertures.has(ek)) continue;
      dist.set(nk, d + 1); q.push([nx, nz]);
    }
  }
  const out = new Map();
  for (const k of level.tiles.keys()) {
    const d = dist.get(k);
    // the floor is how dim a windowless corner gets; below about 0.38 an
    // interior stops reading as "dim" and starts reading as "broken"
    out.set(k, d == null ? 0.38 : Math.max(0.38, 1 / (1 + 0.38 * d)));
  }
  return out;
}

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Distance from a point to one edge's line segment, in grid-local metres. */
function distToEdge(px, pz, axis, x, z, tile) {
  const a0 = (axis === 0 ? x : z) * tile, a1 = a0 + tile;
  const cross = (axis === 0 ? z : x) * tile;
  const along = axis === 0 ? px : pz;
  const perp = axis === 0 ? pz : px;
  const clampedAlong = along < a0 ? a0 : along > a1 ? a1 : along;
  return Math.hypot(along - clampedAlong, perp - cross);
}

/** Build the vertex shader for one level: a pure function of position and
 *  normal returning a linear multiplier. Sampling at `p + n·ε` is what lets the
 *  two faces of one wall shade differently — the outside of an exterior wall
 *  sees daylight, the inside sees the room. */
export function makeShader(level, g, floorY) {
  const open = opennessField(level, g);
  return function shade(px, py, pz, nx, ny, nz) {
    const E = 0.07;
    const sx = px + nx * E, sy = py + ny * E, sz = pz + nz * E;
    const cx = Math.floor(sx / g.tile), cz = Math.floor(sz / g.tile);
    const ck = cellKey(cx, cz);
    const inside = level.tiles.has(ck) && sy > floorY - 0.05 && sy < floorY + g.wallH;
    let v = inside ? (open.get(ck) ?? 0.30) : 1.0;

    if (inside) {
      // Concave joins, as a PRODUCT of per-wall falloffs rather than a min —
      // so a corner where two walls meet compounds to roughly 0.3 instead of
      // reading the same as a flat stretch of wall. Corners are most of what
      // sells an interior as a room.
      for (const [axis, ex, ez] of [[0, cx, cz], [0, cx, cz + 1], [1, cx, cz], [1, cx + 1, cz]]) {
        if (!level.walls.has(edgeKey(axis, ex, ez))) continue;
        const d = distToEdge(sx, sz, axis, ex, ez, g.tile);
        v *= 0.56 + 0.44 * clamp01(d / 0.62);
      }
      // contact shadow up from the floor
      const hAbove = py - floorY;
      if (hAbove < 0.55) v *= 0.62 + 0.38 * clamp01(hAbove / 0.55);
      // and down from the ceiling
      const below = floorY + g.wallH - py;
      if (below < 0.40) v *= 0.82 + 0.18 * clamp01(below / 0.40);
      // FLOOR BOUNCE. A downward face indoors is not unlit — it is the surface
      // a real room bounces the most light onto, which is why ceilings read
      // bright rather than black. Treating it as pure sky-occlusion gave a
      // ceiling that went to near-black in the corners and made every interior
      // feel like a cellar.
      if (ny < -0.5) v *= 1.24;
    } else {
      // OUTSIDE, the openness field is 1.0 everywhere, so exterior walls got
      // none of the modelling the interior gets — a flat card with a roof on
      // it. Two shapes carry a building from outside, and both are analytic
      // here for the same reason the interior ones were: we know where the
      // eaves and the grade are.
      //
      // The eave shadow is the one that matters. A roof overhang throws a band
      // of shade down the top of the wall, and its absence is most of why an
      // untextured box reads as a box rather than as a house.
      const underEave = floorY + g.wallH - py;
      if (underEave < 0.85) v *= 0.62 + 0.38 * clamp01((underEave + 0.35) / 1.2);
      // and the ground steals light back at the base
      const above = py - floorY;
      if (above < 0.45) v *= 0.76 + 0.24 * clamp01(above / 0.45);
      // a convex corner catches the sky from two sides: lift it a little so
      // massing reads as volume rather than as one continuous surface
      const near = Math.min(
        Math.abs(sx - Math.round(sx / g.tile) * g.tile),
        Math.abs(sz - Math.round(sz / g.tile) * g.tile));
      if (near < 0.10) v *= 1.0 + 0.05 * (1 - near / 0.10);
    }
    // sky above, ground below — the hemisphere term the scene's single hemi
    // light would give us if anything ever occluded it
    v *= 0.84 + 0.16 * ny;
    v = clamp01(v * 1.06);
    // daylight is warm and bounce is cool: a touch of hue separation does more
    // for "lit" than another 10% of value ever does
    const warm = inside ? 0.06 * (open.get(ck) ?? 0.3) : 0.05;
    return [clamp01(v + warm), clamp01(v + warm * 0.45), clamp01(v * 0.99)];
  };
}

// ---- perception -------------------------------------------------------------
// The reason the grid exists. Everything below reads the plan and nothing else:
// no scene, no triangles, no raycast. An agent process that has only folded
// state can answer "which room am I in and how do I leave it" exactly as well as
// a browser with the building on screen — which is the whole claim this slice
// was built to test.

/** World point → grid-local point, for a building entity. Mirrors the collider
 *  convention exactly (subtract position, un-rotate yaw, divide by scale) so
 *  perception and collision can never disagree about where a wall is. */
export function localizePoint(ent, wx, wy, wz) {
  const [px, py, pz] = Array.isArray(ent?.pos) ? ent.pos : [0, 0, 0];
  const yaw = Number.isFinite(ent?.yaw) ? ent.yaw : 0;
  const s = Number.isFinite(ent?.scale) && ent.scale > 0 ? ent.scale : 1;
  const dx = wx - px, dz = wz - pz;
  const c = Math.cos(yaw), n = Math.sin(yaw);
  return [(dx * c - dz * n) / s, (wy - py) / s, (dx * n + dz * c) / s];
}

/** A room's openings, each named by the side of THIS room it sits on and what
 *  lies beyond. `null` beyond means outdoors — which is how an agent finds its
 *  way out of a building without anyone marking an exit. */
export function openingsOf(level, room) {
  const mine = new Set(room.cells);
  const byId = new Map(level.rooms.map((r) => [r.id, r]));
  const out = [];
  for (const p of level.portals) {
    const [[ax, az], [bx, bz]] = edgeCells(p.axis, p.x, p.z);
    const aK = cellKey(ax, az), bK = cellKey(bx, bz);
    const near = mine.has(aK) ? [ax, az] : mine.has(bK) ? [bx, bz] : null;
    if (!near) continue;
    const other = mine.has(aK) ? p.between[1] : p.between[0];
    out.push({
      kind: p.kind,
      side: SIDES[sideOfCell(p.axis, p.x, p.z, near[0], near[1])],
      to: other ? (byId.get(other)?.label ?? other) : null,
    });
  }
  return out;
}

/** One sentence for the room a point stands in, or null if it stands in none.
 *
 *  Sides are the GRID's own compass, not the world's — a building rotated 40°
 *  has its own north, and saying "north" about it while a person reads a world
 *  compass would be a quiet lie. The phrasing says whose north it is. */
export function describeHere(plan, lx, lz, ly = 0) {
  const level = plan.levels.find((lv) => lv.rooms.some((r) => r.cells.includes(
    cellKey(Math.floor(lx / plan.grid.tile), Math.floor(lz / plan.grid.tile)))));
  if (!level) return null;
  const room = roomAt(plan, lx, lz, ly);
  if (!room) return null;
  const w = (room.max[0] - room.min[0]).toFixed(0), d = (room.max[1] - room.min[1]).toFixed(0);
  const name = room.label ? `the ${room.label}` : `an unnamed room (${room.id})`;
  const ways = openingsOf(level, room);
  const doors = ways.filter((o) => o.kind !== 'window');
  const wins = ways.filter((o) => o.kind === 'window');
  const phrase = (o) => `a ${o.kind} on its ${o.side} to ${o.to ?? 'outside'}`;
  const parts = [`You are in ${name} — ${w}×${d}m, ${room.area}m².`];
  parts.push(doors.length
    ? `Ways out: ${doors.map(phrase).join('; ')}.`
    : `No doors — this room is sealed.`);
  if (wins.length) parts.push(`Also ${wins.map(phrase).join('; ')}.`);
  return parts.join(' ');
}

/** The affordance line for a building in the entity list — what look() prints
 *  instead of a bare `components: structure`. */
export function describeStructure(data) {
  const plan = planStructure(data);
  let rooms = 0, doors = 0, windows = 0, walls = 0;
  for (const lv of plan.levels) {
    rooms += lv.rooms.length;
    for (const p of lv.portals) (p.kind === 'window' ? windows++ : doors++);
  }
  for (const lv of plan.grid.levels) walls += lv.walls.size;
  const n = (c, s) => `${c} ${s}${c === 1 ? '' : 's'}`;
  const bits = [n(rooms, 'room'), n(walls, 'wall')];
  if (doors) bits.push(n(doors, 'door'));
  if (windows) bits.push(n(windows, 'window'));
  const storeys = plan.levels.length > 1 ? `${plan.levels.length}-storey ` : '';
  return `a ${storeys}building: ${bits.join(', ')}`;
}

/** The room containing a grid-local point, or null. The describer's entry
 *  point, and the thing that makes "which room am I in" O(1) instead of a
 *  geometric query against triangles. */
export function roomAt(plan, lx, lz, ly = 0) {
  const tile = plan.grid.tile;
  const cx = Math.floor(lx / tile), cz = Math.floor(lz / tile);
  const k = cellKey(cx, cz);
  // Nearest level at or below the point, so a first storey doesn't answer for
  // someone standing on the second.
  let best = null;
  for (const lv of plan.levels) {
    if (lv.y > ly + 0.5) continue;
    if (!best || lv.y > best.y) {
      const room = lv.rooms.find((r) => r.cells.includes(k));
      if (room) best = { y: lv.y, level: lv, room };
    }
  }
  return best ? best.room : null;
}

// ---- routing ----------------------------------------------------------------
// The grid IS the navigation graph. Cells are nodes, and an edge between two
// neighbours is passable unless a wall stands on it — which is the same lookup
// the flood fill already does, asked one question differently.
//
// WHY THIS EXISTS AT ALL. `walkTo` samples only the height field, so a headless
// agent walks a straight line and passes through walls. With sparse free-placed
// props that is invisible; inside a building it is the whole experience. It is
// also what would have made the monolith-vs-griddled comparison worthless: an
// agent told "go to the kitchen" arrives in BOTH houses by walking through the
// dividing wall, so both arms pass and the experiment measures nothing — a
// check that fails in the direction that flatters the design.

/** Can a body pass from cell a to cell b? A door or an arch is a hole you can
 *  walk through; a window is not, and neither is a wall. */
export function passable(level, ax, az, bx, bz) {
  const e = edgeBetween(ax, az, bx, bz);
  if (!e) return false;
  const k = edgeKey(e[0], e[1], e[2]);
  if (!level.walls.has(k)) return true;
  const ap = level.apertures.get(k);
  return ap === 'door' || ap === 'arch';
}

/** Breadth-first route between two cells, as a list of cell keys inclusive of
 *  both ends, or null if no way through exists. BFS rather than A* on purpose:
 *  a domestic floor plan is tens of cells, the heuristic would cost more than
 *  it saves, and BFS is exhaustive so "there is no route" is a real answer
 *  rather than a timeout. Neighbours are visited in a fixed order so two agents
 *  folding the same log walk the same path. */
export function routeCells(level, fromKey, toKey) {
  if (!level.tiles.has(fromKey) || !level.tiles.has(toKey)) return null;
  if (fromKey === toKey) return [fromKey];
  const prev = new Map([[fromKey, null]]);
  const q = [fromKey];
  for (let i = 0; i < q.length; i++) {
    const [cx, cz] = q[i].split(',').map(Number);
    for (const [nx, nz] of [[cx, cz - 1], [cx + 1, cz], [cx, cz + 1], [cx - 1, cz]]) {
      const nk = cellKey(nx, nz);
      if (prev.has(nk) || !level.tiles.has(nk)) continue;
      if (!passable(level, cx, cz, nx, nz)) continue;
      prev.set(nk, q[i]);
      if (nk === toKey) {
        const path = [];
        for (let c = nk; c != null; c = prev.get(c)) path.push(c);
        return path.reverse();
      }
      q.push(nk);
    }
  }
  return null;
}

/** A route in grid-local metres: the true start, the centre of each cell the
 *  path turns in, and the true destination.
 *
 *  Only TURNS become waypoints. A straight run down a corridor is one leg, so a
 *  body walks it as a straight line instead of stuttering cell to cell — and
 *  the waypoint count stays proportional to the number of decisions rather than
 *  to the distance. */
export function routeLocal(plan, fromX, fromZ, toX, toZ, y = 0) {
  const g = plan.grid;
  const lv = plan.levels.find((L) => L.rooms.length) ?? plan.levels[0];
  if (!lv) return null;
  const level = lv.level;
  const key = (x, z) => cellKey(Math.floor(x / g.tile), Math.floor(z / g.tile));
  const cells = routeCells(level, key(fromX, fromZ), key(toX, toZ));
  if (!cells) return null;
  const centre = (k) => {
    const [x, z] = k.split(',').map(Number);
    return [(x + 0.5) * g.tile, (z + 0.5) * g.tile];
  };
  const pts = [[fromX, fromZ]];
  for (let i = 1; i < cells.length - 1; i++) {
    const [ax, az] = cells[i - 1].split(',').map(Number);
    const [bx, bz] = cells[i + 1].split(',').map(Number);
    if (ax !== bx && az !== bz) pts.push(centre(cells[i]));   // a turn
  }
  pts.push([toX, toZ]);
  void y;
  return pts;
}

// ---- swept wall geometry ----------------------------------------------------
// Walls stop being boxes here.
//
// A box per run is axis-aligned by construction, so it can never mitre and can
// never turn 45°. Both of those are the same limitation wearing different
// clothes: the geometry is built from the world's axes instead of from the
// wall's own direction. Sweeping a cross-section along a polyline builds it
// from the wall's direction instead, which gives true mitres at ANY angle,
// puts chamfers in the profile where they belong, and makes diagonal walls a
// change of path rather than a change of pipeline.

/** The wall cross-section, as [across, up] pairs. `across` runs −t/2..+t/2,
 *  `up` from the walk surface. The top arrises are chamfered: a bevel there
 *  catches a highlight line along the whole run, which is most of what stops a
 *  wall reading as an untextured slab. */
export function wallProfile(g, chamfer = 0.02, plinth = null) {
  const h = g.wallT / 2, H = g.wallH;
  const c = Math.max(0, Math.min(chamfer, h * 0.6, H * 0.1));
  const pr = plinth ?? { h: TRIM.base.h, out: TRIM.base.proud };
  const b = Math.min(pr.h, H * 0.25), o = Math.max(0, pr.out);
  // THE SKIRTING IS PART OF THE WALL. As separate boxes it was several boards
  // that happened to abut, and it needed its own corner reasoning; as a step in
  // the swept profile it is one board, mitred at every turn by construction,
  // and it cannot come apart from the wall it belongs to.
  return [
    [-h - o, 0], [-h - o, b], [-h, b + o], [-h, H - c],
    [-h + c, H], [h - c, H],
    [h, H - c], [h, b + o], [h + o, b], [h + o, 0],
  ].filter((pt, i, a) => i === 0 || Math.abs(pt[0] - a[i - 1][0]) > 1e-9 || Math.abs(pt[1] - a[i - 1][1]) > 1e-9);
}

const nodePt = (k) => k.split(',').map(Number);

/** Chain wall segments into polylines.
 *
 *  A run continues through a node by taking the STRAIGHTEST onward segment,
 *  which is what makes a T-junction behave: the crossing wall runs through as
 *  one line and the stem ends against it, instead of three stubs meeting at a
 *  point. Degree-2 corners chain and mitre; anything apertured is excluded
 *  because a hole makes it a different shape, and it is emitted separately. */
export function wallPolylines(level, g) {
  const segs = [];
  for (const [k, e] of level.walls) {
    if (level.apertures.has(k)) continue;
    const a = cellKey(e.x, e.z);
    const b = e.axis === 0 ? cellKey(e.x + 1, e.z)
      : e.axis === 1 ? cellKey(e.x, e.z + 1)
      : e.axis === 2 ? cellKey(e.x + 1, e.z + 1)     // ↘ diagonal
      : cellKey(e.x - 1, e.z + 1);                   // ↗ diagonal
    segs.push({ a, b, mat: e.mat, used: false });
  }
  const inc = new Map();
  segs.forEach((s, i) => {
    for (const n of [s.a, s.b]) { if (!inc.has(n)) inc.set(n, []); inc.get(n).push(i); }
  });
  const dir = (from, to) => {
    const [ax, az] = nodePt(from), [bx, bz] = nodePt(to);
    const d = Math.hypot(bx - ax, bz - az) || 1;
    return [(bx - ax) / d, (bz - az) / d];
  };
  /** the straightest unused continuation at `node` arriving along `d` */
  const onward = (node, from, d) => {
    let best = -1, bestDot = -2;
    for (const i of inc.get(node) ?? []) {
      const s = segs[i];
      if (s.used) continue;
      const other = s.a === node ? s.b : s.a;
      if (other === from) continue;
      const e = dir(node, other);
      const dot = d[0] * e[0] + d[1] * e[1];
      if (dot > bestDot) { bestDot = dot; best = i; }
    }
    return best;
  };
  const lines = [];
  const grow = (startSeg) => {
    const s = segs[startSeg];
    s.used = true;
    const pts = [s.a, s.b];
    const mat = s.mat;
    // extend forward, then backward
    for (const forward of [true, false]) {
      for (;;) {
        const tip = forward ? pts[pts.length - 1] : pts[0];
        const prev = forward ? pts[pts.length - 2] : pts[1];
        const i = onward(tip, prev, dir(prev, tip));
        if (i < 0) break;
        segs[i].used = true;
        const nxt = segs[i].a === tip ? segs[i].b : segs[i].a;
        if (pts.includes(nxt)) {
          // a closed ring: repeat the first point so the sweep knows to wrap,
          // otherwise the last corner is left unmitred and the run has a seam
          if (nxt === pts[0]) { if (forward) pts.push(nxt); else pts.unshift(nxt); }
          break;
        }
        if (forward) pts.push(nxt); else pts.unshift(nxt);
      }
    }
    lines.push({ pts: pts.map(nodePt).map(([x, z]) => [x * g.tile, z * g.tile]), mat });
  };
  // start at ends and junctions first so open runs are not cut mid-line
  for (let i = 0; i < segs.length; i++) {
    if (segs[i].used) continue;
    const dA = (inc.get(segs[i].a) ?? []).length, dB = (inc.get(segs[i].b) ?? []).length;
    if (dA !== 2 || dB !== 2) grow(i);
  }
  for (let i = 0; i < segs.length; i++) if (!segs[i].used) grow(i);   // pure loops
  return lines;
}

/** Sweep a profile along a path, mitring at every turn.
 *
 *  The mitre is the classic one: at each interior vertex the offset direction
 *  is the bisector of the two segment normals, lengthened by 1/cos(θ/2) so the
 *  faces meet exactly. It is angle-agnostic, which is the whole point — a 90°
 *  corner and a 45° corner take the same code, and that is what lets diagonal
 *  walls exist at all.
 *
 *  Returns flat positions + indices; normals are left to the caller (the
 *  realizer computes them) so this half stays free of any renderer. */
export function sweepProfile(path, profile, y0) {
  if (path.length < 2 || profile.length < 2) return { positions: [], indices: [] };
  const closed = path.length > 2
    && Math.abs(path[0][0] - path[path.length - 1][0]) < 1e-9
    && Math.abs(path[0][1] - path[path.length - 1][1]) < 1e-9;
  const pts = closed ? path.slice(0, -1) : path;
  const n = pts.length;
  const segDir = [];
  for (let i = 0; i < n - (closed ? 0 : 1); i++) {
    const a = pts[i], b = pts[(i + 1) % n];
    const dx = b[0] - a[0], dz = b[1] - a[1];
    const L = Math.hypot(dx, dz) || 1;
    segDir.push([dx / L, dz / L]);
  }
  /** unit normal (left of travel) */
  const nrm = (d) => [-d[1], d[0]];
  const offsets = [];
  for (let i = 0; i < n; i++) {
    const dIn = closed ? segDir[(i - 1 + n) % n] : segDir[Math.max(0, i - 1)];
    const dOut = closed ? segDir[i % n] : segDir[Math.min(segDir.length - 1, i)];
    const nIn = nrm(dIn), nOut = nrm(dOut);
    let mx = nIn[0] + nOut[0], mz = nIn[1] + nOut[1];
    const mL = Math.hypot(mx, mz);
    if (mL < 1e-6) { offsets.push(nOut); continue; }   // 180° doubling back
    mx /= mL; mz /= mL;
    // 1/cos(θ/2): the amount the mitre must reach to keep both faces flush
    const scale = 1 / Math.max(0.35, mx * nOut[0] + mz * nOut[1]);
    offsets.push([mx * scale, mz * scale]);
  }
  const positions = [];
  for (let i = 0; i < n; i++) {
    const [px, pz] = pts[i], [ox, oz] = offsets[i];
    for (const [u, v] of profile) positions.push(px + ox * u, y0 + v, pz + oz * u);
  }
  const P = profile.length;
  const indices = [];
  const rings = closed ? n : n - 1;
  for (let i = 0; i < rings; i++) {
    const a = i * P, b = ((i + 1) % n) * P;
    for (let j = 0; j < P - 1; j++) {
      // WINDING. The lateral offset is the LEFT normal of travel, so profile
      // point u = −t/2 lands on the right-hand side of the path. Ordering the
      // quad the obvious way (a,b,b+1) puts that face's normal back INTO the
      // wall — every surface inside-out, which reads in-world as a building
      // turned inside out rather than as anything recognisable as a normals
      // bug. Reversed here, and pinned by the outward-normal test.
      indices.push(a + j, b + j + 1, b + j, a + j, a + j + 1, b + j + 1);
    }
  }
  return { positions, indices, ringSize: P, rings: n };
}


/** Swept geometry for one level: every solid wall run, mitred. */
export function levelSweeps(level, g, floorY) {
  const prof = wallProfile(g);
  const out = [];
  for (const line of wallPolylines(level, g)) {
    const sw = sweepProfile(line.pts, prof, floorY);
    if (sw.positions.length) out.push({ ...sw, mat: line.mat, kind: 'wall' });
  }
  return out;
}
