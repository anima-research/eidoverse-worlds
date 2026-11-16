import { routeLevel, prepareWallCheck, routeGeometryFor, terrainCells, ROUTE_STEP_METRES, NON_FINITE_ENDPOINT } from './structure-route.js';
export { ROUTE_STEP_METRES };
// structure — the griddled-building model's pure half. Design notes (the § references below): docs/research/griddled-structures.md.
//
// Given one `structure` component's data, decide EVERYTHING the world needs to know about that building: the boxes to
// draw, the boxes to collide, the rooms the walls enclose, the doorways that join them, and routes through them. No THREE,
// no DOM: client/lib/realize/structure.js executes this plan (test/shared/structure-field-test.ts holds it).
// Walls live on grid EDGES, not in cells (§2).
//
// COORDINATES. Cell (x, z) covers grid-local [x, x+1) × [z, z+1) on the ground plane. Edges are canonical by construction:
//   axis 0 — runs along X, from (x, z) to (x+1, z): the boundary between cell (x, z-1) and cell (x, z).
//   axis 1 — runs along Z, from (x, z) to (x, z+1): the boundary between cell (x-1, z) and cell (x, z).
//   axis 2/3 — diagonals across cell (x, z): ↘ and ↗ (§9).
// All coordinates here are GRID-LOCAL: a grid is an entity with its own position and yaw.

/** @typedef {{ x0:number, y0:number, z0:number, x1:number, y1:number, z1:number,
 *              mat:string, kind:'floor'|'wall'|'jamb'|'sill'|'lintel' }} Box */

/** @typedef {{ id:string, label:string|null, cells:string[], area:number,
 *              min:[number,number], max:[number,number],
 *              centre:[number,number] }} Room */

/** @typedef {{ axis:0|1, x:number, z:number, kind:'door'|'window',
 *              between:[string|null, string|null] }} Portal */

/** Defaults that are a CONTRACT: every part generated against the grid assumes them (§3). */
export const GRID_DEFAULTS = Object.freeze({
  tile: 1.0,      // metres per cell
  wallH: 2.8,     // wall height / floor-to-floor
  wallT: 0.15,    // wall thickness
  slabT: 0.10,    // floor slab thickness (it sits ON the level's y: its top, the walk surface, is y + slabT)
});

/** Aperture profiles: how much wall is left below (`bottom`) and above (`top`) the hole. An aperture spans its whole
 *  segment with no side jambs, and is an absence of boxes, so collision needs no concept of a hole (§4). */
export const APERTURES = Object.freeze({
  door:   { bottom: 0.00, top: 2.10 },
  window: { bottom: 0.90, top: 2.10 },
  arch:   { bottom: 0.00, top: 2.40 },
});

/** Where makeShader's contact terms stop biting: the wall profile must sample AT them, or a kink shows as a band (§12). */
export const SHADE_KINKS = Object.freeze({
  floorContact: 0.55, ceilContact: 0.40,   // interior
  groundContact: 0.45, eave: 0.85,         // exterior — the outside face has
});                                        // its own breakpoints, and the
                                           // profile is shared by both faces

export const cellKey = (x, z) => `${x},${z}`;
export const edgeKey = (axis, x, z) => `${axis}:${x},${z}`;

/** The two cells an edge separates, in grid-local coords: [negative side, positive side] along the edge's normal. */
export function edgeCells(axis, x, z) {
  return axis === 0
    ? [[x, z - 1], [x, z]]     // an X-running edge separates north from south
    : [[x - 1, z], [x, z]];    // a Z-running edge separates west from east
}

/** The edge between two orthogonally adjacent cells, or null if they aren't neighbours (edgeCells' inverse). */
export function edgeBetween(ax, az, bx, bz) {
  if (ax === bx && az === bz - 1) return [0, ax, bz];       // b is south of a
  if (ax === bx && az === bz + 1) return [0, ax, az];       // b is north of a
  if (az === bz && ax === bx - 1) return [1, bx, az];       // b is east of a
  if (az === bz && ax === bx + 1) return [1, ax, az];       // b is west of a
  return null;
}

/** Grid-local compass: a rotated grid has its own north, so a describer composes these with the grid's yaw (§13). */
export const SIDES = Object.freeze({ N: 'north', E: 'east', S: 'south', W: 'west' });

/** Which local side of `cell` this edge lies on. */
export function sideOfCell(axis, x, z, cx, cz) {
  if (axis === 0) return cz === z ? 'N' : 'S';
  return cx === x ? 'W' : 'E';
}

// ---- diagonals --------------------------------------------------------------
// axis 2 is ↘, axis 3 is ↗. A cut cell contributes two nodes (halves A/B), named by the sides they touch (§9).

/** The diagonal cutting a cell, or null. */
export function diagOf(level, x, z) {
  if (level.walls.has(edgeKey(2, x, z))) return 2;
  if (level.walls.has(edgeKey(3, x, z))) return 3;
  return null;
}

/** Which half of a cell touches `side` ('N'|'E'|'S'|'W'); '' when uncut. */
export function halfFor(level, x, z, side) {
  const d = diagOf(level, x, z);
  if (!d) return '';
  if (d === 2) return (side === 'N' || side === 'E') ? ':A' : ':B';
  return (side === 'N' || side === 'W') ? ':A' : ':B';
}

/** Every node a cell contributes to the room/route graph. */
export function cellNodes(level, x, z) {
  const k = cellKey(x, z);
  if (!diagOf(level, x, z)) return [k];
  const only = level.halves?.get(k);
  return only ? [`${k}:${only}`] : [`${k}:A`, `${k}:B`];
}

/** Is this half of a cut cell actually floored? An unfloored half is outside
 *  the building: no node, no room, no route, no floor. */
export function halfFloored(level, x, z, half) {
  const only = level.halves?.get(cellKey(x, z));
  return !only || only === half.replace(':', '');
}

/** The node of cell (x,z) that touches `side`. */
export const nodeOnSide = (level, x, z, side) => cellKey(x, z) + halfFor(level, x, z, side);

/** Which half a grid-local point falls in — the describer's and router's way
 *  in. ↘ splits on u = v; ↗ splits on u + v = 1. */
export function nodeAtPoint(level, g, lx, lz) {
  const x = Math.floor(lx / g.tile), z = Math.floor(lz / g.tile);
  const d = diagOf(level, x, z);
  const k = cellKey(x, z);
  if (!d) return k;
  const u = lx / g.tile - x, v = lz / g.tile - z;
  if (d === 2) return u > v ? `${k}:A` : `${k}:B`;
  return (u + v) < 1 ? `${k}:A` : `${k}:B`;
}

const SIDE_OF = [['N', 'S'], ['E', 'W'], ['S', 'N'], ['W', 'E']];
const STEP = [[0, -1], [1, 0], [0, 1], [-1, 0]];

/** Node-level adjacency for rooms: a room is bounded by walls whatever holes they carry (§8); routes are structure-route.js's. */
export function nodeNeighbours(level, x, z) {
  const out = [];
  for (let i = 0; i < 4; i++) {
    const [side, back] = SIDE_OF[i], [dx, dz] = STEP[i];
    const nx = x + dx, nz = z + dz;
    if (!level.tiles.has(cellKey(nx, nz))) continue;
    const e = edgeBetween(x, z, nx, nz);
    const ek = e && edgeKey(e[0], e[1], e[2]);
    if (ek && level.walls.has(ek)) continue;
    const here = nodeOnSide(level, x, z, side), there = nodeOnSide(level, nx, nz, back);
    const ok = (n, cx, cz) => !n.includes(':') || halfFloored(level, cx, cz, n.split(':')[1]);
    if (!ok(here, x, z) || !ok(there, nx, nz)) continue;
    out.push([here, there]);
  }
  return out;
}

/** The whole node graph for a level. */
export function nodeGraph(level) {
  const adj = new Map();
  const add = (a, b) => {
    if (!adj.has(a)) adj.set(a, new Set());
    if (!adj.has(b)) adj.set(b, new Set());
    adj.get(a).add(b); adj.get(b).add(a);
  };
  for (const k of level.tiles.keys()) {
    const [x, z] = k.split(',').map(Number);
    for (const n of cellNodes(level, x, z)) if (!adj.has(n)) adj.set(n, new Set());
    for (const [a, b] of nodeNeighbours(level, x, z)) add(a, b);
  }
  return adj;
}

// ---- normalization ----------------------------------------------------------

/** Coerce one component payload into a shape the planner can trust totally: a malformed structure yields an EMPTY
 *  plan, never a throw (§14). */
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
    const halves = new Map();    // cellKey -> 'A'|'B' when only one half is floored
    const walls = new Map();     // edgeKey -> {axis, x, z, mat}
    const apertures = new Map(); // edgeKey -> kind
    for (const t of Array.isArray(lv.tiles) ? lv.tiles : []) {
      const x = int(t?.[0]), z = int(t?.[1]);
      if (x == null || z == null) continue;
      const k0 = cellKey(x, z);
      tiles.set(k0, typeof t[2] === 'string' ? t[2] : 'floor');
      // a cell cut by a diagonal may be floored on only ONE side (the corner of a building, §9)
      if (t[3] === 'A' || t[3] === 'B') halves.set(k0, t[3]);
    }
    for (const w of Array.isArray(lv.walls) ? lv.walls : []) {
      const axis = [0, 1, 2, 3].includes(w?.[0]) ? w[0] : null;
      const x = int(w?.[1]), z = int(w?.[2]);
      if (axis == null || x == null || z == null) continue;
      walls.set(edgeKey(axis, x, z), { axis, x, z, mat: typeof w[3] === 'string' ? w[3] : 'wall' });
    }
    for (const a of Array.isArray(lv.apertures) ? lv.apertures : []) {
      const axis = [0, 1, 2, 3].includes(a?.[0]) ? a[0] : null;
      const x = int(a?.[1]), z = int(a?.[2]);
      const kind = APERTURES[a?.[3]] ? a[3] : null;
      if (axis == null || x == null || z == null || !kind) continue;
      // an aperture with no wall to sit in is nothing: dropped here, so later stages may assume the wall
      const k = edgeKey(axis, x, z);
      if (!walls.has(k)) continue;
      apertures.set(k, kind);
    }
    g.levels.push({ y: Number.isFinite(lv.y) ? lv.y : 0, tiles, halves, walls, apertures });
  }
  return g;
}

// ---- geometry + collision ---------------------------------------------------

/** Fill the missing quadrant at each external corner with its OWN small box, never by stretching a wall across it (§5).
 *  A quadrant is uncovered when neither wall bounding it is present, and a CORNER when both opposite walls are. */
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

/** Group aperture-free wall segments into RUNS: maximal contiguous collinear chains sharing a material, one box each.
 *  Apertured segments stay solitary (§6). */
export function wallRuns(level, g) {
  const lines = new Map();   // "axis:cross" -> [{ along, mat }]
  for (const [k, e] of level.walls) {
    if (level.apertures.has(k)) continue;
    // runs are axis-aligned only (a diagonal collides as levelBoxes' steps)
    if (e.axis >= 2) continue;
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

/** A run's along-axis span in metres: its own cells, not extended into the joints it meets. */
export function runSpan(run, level, g) {
  const startEdge = run.axis === 0 ? [0, run.lo, run.cross] : [1, run.cross, run.lo];
  const endEdge = run.axis === 0 ? [0, run.hi, run.cross] : [1, run.cross, run.hi];
  // A run stops where it stops; corners are closed by cornerFills, not by
  // stretching this span past the wall it meets.
  void startEdge; void endEdge;
  return [run.lo * g.tile, (run.hi + 1) * g.tile];
}

/** Decompose one wall edge into boxes, grid-local metres: one box, or with an aperture at most a sill below and a
 *  lintel above, each spanning the full segment. A door has no sill; an arch reaching wallH has no lintel. Degenerate
 *  boxes are never emitted, so no sliver reaches the solver. */
export function wallBoxes(edge, aperture, g, y, ext = [0, 0]) {
  const { axis, x, z, mat } = edge;
  const t = g.wallT, h = g.wallH, half = t / 2;
  // Along-axis span in metres, and the fixed cross-axis band the wall occupies.
  const a0 = (axis === 0 ? x * g.tile : z * g.tile) - ext[0];
  const a1 = (axis === 0 ? x * g.tile : z * g.tile) + g.tile + ext[1];
  const cross = (axis === 0 ? z : x) * g.tile;
  const c0 = cross - half, c1 = cross + half;
  // build in (along, low, high) terms, then project onto world axes once
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

/** One floor cell's slab: it sits ON the level's y and occupies [y, y + slabT]; the walk surface is its top (§7). */
export function tileBox(x, z, mat, g, y) {
  return {
    x0: x * g.tile, y0: y, z0: z * g.tile,
    x1: (x + 1) * g.tile, y1: y + g.slabT, z1: (z + 1) * g.tile,
    mat, kind: 'floor',
  };
}

// ---- rooms ------------------------------------------------------------------

/** Flood-fill the tiled cells into rooms, blocked by walls. A door does not merge two rooms (§8). Scanned in sorted key
 *  order, so room ids are a pure function of the data. */
export function deriveRooms(level, g) {
  const adj = nodeGraph(level);
  const seen = new Set();
  const rooms = [];
  const keys = [...adj.keys()].sort();
  for (const start of keys) {
    if (seen.has(start)) continue;
    const cells = [];
    const stack = [start];
    seen.add(start);
    while (stack.length) {
      const k = stack.pop();
      cells.push(k);
      for (const n of adj.get(k) ?? []) {
        if (seen.has(n)) continue;
        seen.add(n); stack.push(n);
      }
    }
    cells.sort();
    // a node key may carry a half suffix; the CELL is the part before it
    const cellOf = (k) => k.split(':')[0].split(',').map(Number);
    let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
    for (const k of cells) {
      const [cx, cz] = cellOf(k);
      if (cx < minX) minX = cx; if (cx + 1 > maxX) maxX = cx + 1;
      if (cz < minZ) minZ = cz; if (cz + 1 > maxZ) maxZ = cz + 1;
    }
    // a half-cell is half a tile of floor
    const area = cells.reduce((t, k) => t + (k.includes(':') ? 0.5 : 1), 0) * g.tile * g.tile;
    rooms.push({
      id: `r${rooms.length + 1}`,
      label: g.labels[cells[0]] ?? cells.map((k) => g.labels[k] ?? g.labels[k.split(':')[0]]).find((v) => typeof v === 'string') ?? null,
      cells,
      area,
      min: [minX * g.tile, minZ * g.tile],
      max: [maxX * g.tile, maxZ * g.tile],
      centre: [((minX + maxX) / 2) * g.tile, ((minZ + maxZ) / 2) * g.tile],
    });
  }
  return rooms;
}

/** Every aperture, resolved to the two rooms it joins. A null side means outdoors: an exterior door. */
export function derivePortals(level, rooms) {
  const roomOf = new Map();
  for (const r of rooms) for (const c of r.cells) roomOf.set(c, r.id);
  const portals = [];
  for (const [k, kind] of level.apertures) {
    const w = level.walls.get(k);
    if (!w) continue;
    if (w.axis >= 2) {
      // a diagonal's two sides are the two halves of its own cell
      const k = cellKey(w.x, w.z);
      portals.push({ axis: w.axis, x: w.x, z: w.z, kind,
        between: [roomOf.get(`${k}:A`) ?? null, roomOf.get(`${k}:B`) ?? null] });
      continue;
    }
    const [[ax, az], [bx, bz]] = edgeCells(w.axis, w.x, w.z);
    const sideA = sideOfCell(w.axis, w.x, w.z, ax, az);
    const sideB = sideOfCell(w.axis, w.x, w.z, bx, bz);
    portals.push({
      axis: w.axis, x: w.x, z: w.z, kind,
      between: [
        roomOf.get(nodeOnSide(level, ax, az, sideA)) ?? null,
        roomOf.get(nodeOnSide(level, bx, bz, sideB)) ?? null,
      ],
    });
  }
  return portals;
}

// ---- the plan ---------------------------------------------------------------

/** One level's COLLISION boxes, grid-local: the floor tiles, the solid wall
 *  runs, what's left of an apertured segment, the corner fills and a diagonal's
 *  stair steps. planStructure's `boxes`, and the door's solids (shared/protocol/authority/catalogue.js
 *  reads collisionBoxes) — one derivation, so the browser's colliders and the
 *  door's walls can't disagree about where a wall is. */
function levelBoxes(level, g) {
  const boxes = [];
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
  // diagonal collision is stair-stepped: one yaw per building's collider, steps well under a body radius (§9)
  for (const [k, e] of level.walls) {
    if (e.axis < 2) continue;
    const [[sx, sz], [ex, ez]] = segmentEnds(e, g);
    const open = ['door', 'arch'].includes(level.apertures.get(k));
    const lo = open ? APERTURES[level.apertures.get(k)].top : 0;
    if (lo >= g.wallH) continue;   // the opening reaches the top: no lintel (wallBoxes)
    const len = Math.hypot(ex - sx, ez - sz);
    const N = Math.min(64, Math.max(8, Math.ceil(len / (g.wallT * 1.2))));
    const r = Math.max(g.wallT * 0.8, (len / N) * 0.7);
    for (let i = 0; i <= N; i++) {
      const t = i / N;
      const cx = sx + (ex - sx) * t, cz = sz + (ez - sz) * t;
      boxes.push({
        x0: cx - r, x1: cx + r,
        y0: floorY + lo,
        y1: floorY + g.wallH,
        z0: cz - r, z1: cz + r, mat: e.mat, kind: 'wall',
      });
    }
  }
  return boxes;
}

/** Every collision box of a structure (all levels), grid-local, without the
 *  visual derivation (rooms, parts, sweeps): what a headless reader that only
 *  needs to know where the walls are (the door) asks for. */
export function collisionBoxes(data) {
  const g = normalize(data);
  return g.levels.flatMap((level) => levelBoxes(level, g));
}

/** The whole derivation for one structure component: what to draw, what to collide, what the rooms are, what joins
 *  them. Pure and total; the hosted half rebuilds it on every reconcile (§14). */
export function planStructure(data) {
  const g = normalize(data);
  const boxes = [];
  const levels = [];
  for (const level of g.levels) {
    // The walk surface: the top of this level's foundation. Walls rise from it,
    // apertures are measured from it, and a body stands on it.
    const floorY = level.y + g.slabT;
    boxes.push(...levelBoxes(level, g));
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
// A SECOND derivation from the same grid, for rendering only; collision never sees it (§10).

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

/** Every visual part for one level. */
export function levelParts(level, g, floorY) {
  const parts = [];
  const h = g.wallH;

  for (const [k, mat] of level.tiles) {
    const [x, z] = k.split(',').map(Number);
    if (level.halves?.has(k)) continue;      // half-cells are prisms, see levelSweeps
    parts.push(tileBox(x, z, mat, g, floorY - g.slabT));
  }
  // walls, apertured or not, and their trim are swept (levelSweeps): only box-shaped pieces are parts

  // flat roof with an overhang (§10)
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
// Baked analytically at build time from what the plan knows: no AO pass, no extra lights (§12).

/** Per-cell daylight, BFS'd out from the apertures through open edges and doorways. */
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
    // the floor: below about 0.38 an interior reads as broken, not dim
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
 *  normal returning a linear [r, g, b] multiplier. Sampling at `p + n·ε` is what lets the
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
      // concave joins, as a PRODUCT of per-wall falloffs: a corner compounds
      for (const [axis, ex, ez] of [[0, cx, cz], [0, cx, cz + 1], [1, cx, cz], [1, cx + 1, cz]]) {
        if (!level.walls.has(edgeKey(axis, ex, ez))) continue;
        const d = distToEdge(sx, sz, axis, ex, ez, g.tile);
        v *= 0.56 + 0.44 * clamp01(d / 0.62);
      }
      // contact shadow up from the floor
      const hAbove = py - floorY;
      if (hAbove < SHADE_KINKS.floorContact) v *= 0.62 + 0.38 * clamp01(hAbove / SHADE_KINKS.floorContact);
      // and down from the ceiling
      const below = floorY + g.wallH - py;
      if (below < SHADE_KINKS.ceilContact) v *= 0.82 + 0.18 * clamp01(below / SHADE_KINKS.ceilContact);
      // floor bounce: a downward face indoors is lit by the floor
      if (ny < -0.5) v *= 1.24;
    } else {
      // outside: the eave shadow down the top of the wall
      const underEave = floorY + g.wallH - py;
      if (underEave < SHADE_KINKS.eave) v *= 0.62 + 0.38 * clamp01((underEave + 0.35) / 1.2);
      // and the ground steals light back at the base
      const above = py - floorY;
      if (above < SHADE_KINKS.groundContact) v *= 0.76 + 0.24 * clamp01(above / SHADE_KINKS.groundContact);
      // a convex corner catches the sky from two sides: lift it a little so
      // massing reads as volume rather than as one continuous surface
      const near = Math.min(
        Math.abs(sx - Math.round(sx / g.tile) * g.tile),
        Math.abs(sz - Math.round(sz / g.tile) * g.tile));
      if (near < 0.10) v *= 1.0 + 0.05 * (1 - near / 0.10);
    }
    // sky above, ground below: the hemisphere term
    v *= 0.84 + 0.16 * ny;
    v = clamp01(v * 1.06);
    // daylight warm, bounce cool
    const warm = inside ? 0.06 * (open.get(ck) ?? 0.3) : 0.05;
    return [clamp01(v + warm), clamp01(v + warm * 0.45), clamp01(v * 0.99)];
  };
}

// ---- perception -------------------------------------------------------------
// Reads the plan and nothing else (no scene, no raycast), so a headless agent answers as well as a browser (§13).

/** World point → grid-local point, for a building entity: the collider's convention exactly (subtract position,
 *  un-rotate yaw, divide by scale). */
export function localizePoint(ent, wx, wy, wz) {
  const [px, py, pz] = Array.isArray(ent?.pos) ? ent.pos : [0, 0, 0];
  const yaw = Number.isFinite(ent?.yaw) ? ent.yaw : 0;
  const s = Number.isFinite(ent?.scale) && ent.scale > 0 ? ent.scale : 1;
  const dx = wx - px, dz = wz - pz;
  const c = Math.cos(yaw), n = Math.sin(yaw);
  return [(dx * c - dz * n) / s, (wy - py) / s, (dx * n + dz * c) / s];
}

/** A room's openings, each named by the side of THIS room it sits on and what lies beyond (null: outdoors). */
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

/** One sentence for the room a point stands in, or null. Sides are the grid's own compass, and the phrasing says so. */
export function describeHere(plan, lx, lz, ly = 0) {
  // the room's own level, never one re-derived from the cell key (cell keys are x,z: §13)
  const here = levelAt(plan, lx, lz, ly);
  if (!here) return null;
  const { level, room } = here;
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

/** The room containing a grid-local point, or null. */
export function roomAt(plan, lx, lz, ly = 0) {
  return levelAt(plan, lx, lz, ly)?.room ?? null;
}

/** The storey a point stands on AND the room it stands in, resolved once: the highest level whose surface is at most
 *  half a metre above the point that has a room at that cell. Null when there is none. */
export function levelAt(plan, lx, lz, ly = 0) {
  let best = null;
  for (const lv of plan.levels) {
    if (lv.y > ly + 0.5) continue;
    if (!best || lv.y > best.y) {
      const room = lv.rooms.find((r) => r.cells.includes(nodeAtPoint(lv.level, plan.grid, lx, lz)));
      if (room) best = { y: lv.y, level: lv, room };
    }
  }
  return best ? { level: best.level, room: best.room } : null;
}

// ---- routing ----------------------------------------------------------------
// The grid IS the navigation graph: an edge between neighbours is passable unless a wall stands on it with no door or
// arch in it (§1; the search is structure-route.js's).

/** Prepare one immutable structure-plan snapshot against a supplied walking basis. The standing
 * resolver, not floor ordering or x/z overlap, owns that basis:
 * terrain {heightAt(localX,localZ), step?, scale?}; floor {height, level?, step?, scale?}.
 * A floor's level index identifies THIS structure as the support owner;
 * omit it on other structures, which can constrain walls but offer no support.
 * step is the feet-to-step obstruction band in local metres, not a grant of
 * floor ownership. Callers scale ROUTE_STEP_METRES from world metres; scale
 * (world metres per local metre, 1 when omitted) only puts a refusal's
 * figures in world metres. A preparation that can't be made (no basis, or
 * geometry that isn't finite) says why in `failed`, so a caller can tell a
 * structure it can't read from one that refuses a route; its route() refuses
 * and its clear() is false. */
export function prepareRouteLocal(plan, basis) {
  // Freeze the chosen mode/identity and function reference for this walk.
  // A caller cannot change a floor into terrain halfway through validation.
  basis = basis ? { ...basis } : basis;
  const blocked = reason => ({ kind: 'blocked', reason, points: [], confined: basis?.kind === 'floor' && basis.level != null });
  const unusable = reason => ({ failed: reason, route: () => blocked(reason), clear: () => false, confined: false });
  if (!basis || !['terrain','floor'].includes(basis.kind)) return unusable('walking support basis is required');
  let clear;
  try { clear = prepareWallCheck(plan,basis); }
  catch (e) { return unusable(String(e.message)); }
  const confined = basis.kind === 'floor' && basis.level != null;
  const scale = Number.isFinite(basis.scale) && basis.scale > 0 ? basis.scale : 1;
  // The immutable plan's cached local geometry has no support/transform
  // state. Each new received component revision produces a different plan.
  return {
    confined,
    clear: (ax,az,bx,bz) => clear([ax,az],[bx,bz]),
    route(fromX,fromZ,toX,toZ) {
      const from=[fromX,fromZ], to=[toX,toZ];
      if (![...from,...to].every(Number.isFinite)) return blocked(NON_FINITE_ENDPOINT);
      if (basis.kind === 'terrain') {
        if (clear(from,to)) return { kind: 'clear', points: [from,to], confined: false };
        // The search covers every level's geometry; the diagonals that cut its
        // cells are the ones this walk's terrain meets (terrainCells).
        const cells = terrainCells(plan, basis.heightAt, basis.step ?? ROUTE_STEP_METRES);
        return { ...routeLevel(cells,plan.grid,from,to,true,clear,{ bounds: routeGeometryFor(plan).bounds, scale }), confined: false };
      }
      if (!Number.isFinite(basis.height)) return blocked('non-finite floor height');
      if (!confined) return clear(from,to)
        ? {kind:'clear',points:[from,to],confined:false}
        : blocked('another structure obstructs the identified-floor route');
      const lv=Number.isInteger(basis.level) ? plan.levels[basis.level] : null;
      if (!lv || Math.abs(lv.y-basis.height)>1e-7)
        return blocked('identified support floor does not match supplied feet height');
      return { ...routeLevel(lv.level,plan.grid,from,to,false,clear,{ scale }), confined:true };
    },
  };
}

// ---- swept wall geometry ----------------------------------------------------
// Walls are a cross-section swept along a polyline: true mitres at any angle (§11).

/** Insert profile points wherever an edge crosses one of `vs`: an exact shared shading sample at every cut (§12). */
export function refineProfile(profile, vs) {
  const cuts = [...new Set(vs)].sort((a, b) => a - b);
  const out = [];
  for (let i = 0; i < profile.length; i++) {
    const cur = profile[i], prev = profile[i - 1];
    if (prev) {
      const lo = Math.min(prev[1], cur[1]), hi = Math.max(prev[1], cur[1]);
      const between = cuts.filter((v) => v > lo + 1e-9 && v < hi - 1e-9);
      if (prev[1] > cur[1]) between.reverse();
      for (const v of between) {
        const t = (v - prev[1]) / (cur[1] - prev[1]);
        out.push([prev[0] + (cur[0] - prev[0]) * t, v]);
      }
    }
    out.push(cur);
  }
  return out;
}

/** The wall cross-section, as [across, up] pairs: `across` −t/2..+t/2, `up` from the walk surface, top arrises chamfered. */
export function wallProfile(g, chamfer = 0.02, plinth = null, cuts = null) {
  const h = g.wallT / 2, H = g.wallH;
  const c = Math.max(0, Math.min(chamfer, h * 0.6, H * 0.1));
  const pr = plinth ?? { h: TRIM.base.h, out: TRIM.base.proud };
  const b = Math.min(pr.h, H * 0.25), o = Math.max(0, pr.out);
  // the skirting is a step in the profile: one board, mitred by construction
  const base = [
    [-h - o, 0], [-h - o, b], [-h, b + o], [-h, H - c],
    [-h + c, H], [h - c, H],
    [h, H - c], [h, b + o], [h + o, b], [h + o, 0],
  ].filter((pt, i, a) => i === 0 || Math.abs(pt[0] - a[i - 1][0]) > 1e-9 || Math.abs(pt[1] - a[i - 1][1]) > 1e-9);
  // a ladder up the wall, plus an exact cut at every aperture height so a
  // lintel or sill shares its boundary sample with the wall it continues
  const apHeights = Object.values(APERTURES).flatMap((a) => [a.bottom, a.top]).filter((v) => v > 0 && v < H);
  // a sample ON each shading kink (SHADE_KINKS); the ladder covers the smooth stretches between
  const kinks = [SHADE_KINKS.floorContact, H - SHADE_KINKS.ceilContact,
    SHADE_KINKS.groundContact, H - SHADE_KINKS.eave];
  const ladder = [];
  for (let v = 0.3; v < H - c; v += 0.3) ladder.push(v);
  return refineProfile(base, cuts ?? [...apHeights, ...kinks, ...ladder].filter((v) => v > 0 && v < H));
}

const nodePt = (k) => k.split(',').map(Number);

/** Chain wall segments into polylines, continuing through a node by the STRAIGHTEST onward segment (a T's crossing
 *  wall runs through). Apertured segments are excluded and swept separately (§11). */
export function wallPolylines(level, g) {
  const segs = [];
  for (const [k, e] of level.walls) {
    if (level.apertures.has(k)) continue;
    const [start, end] = segmentEnds(e, { tile: 1 }); // vertex keys, before metre scaling
    const a = cellKey(...start), b = cellKey(...end);
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
    // at a plain corner a run turns; at a junction only if something carries straight on (§11)
    const degree = (inc.get(node) ?? []).length;
    const minDot = degree > 2 ? 0.7 : -2;
    for (const i of inc.get(node) ?? []) {
      const s = segs[i];
      if (s.used) continue;
      const other = s.a === node ? s.b : s.a;
      if (other === from) continue;
      const e = dir(node, other);
      const dot = d[0] * e[0] + d[1] * e[1];
      if (dot > bestDot && dot >= minDot) { bestDot = dot; best = i; }
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
          // a closed ring: repeat the first point so the sweep wraps (else the last corner is unmitred)
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

/** Sweep a profile along a path, mitring at every turn: each interior offset is the bisector of the two segment normals,
 *  lengthened by 1/cos(θ/2). Returns flat positions + indices; the realizer computes normals. */
export function sweepProfile(path, profile, y0, ends = null) {
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
    // `ends`: mitre an apertured piece against the run it interrupts (§11)
    let dIn = closed ? segDir[(i - 1 + n) % n] : segDir[Math.max(0, i - 1)];
    let dOut = closed ? segDir[i % n] : segDir[Math.min(segDir.length - 1, i)];
    if (!closed && i === 0 && ends?.inDir) dIn = ends.inDir;
    if (!closed && i === n - 1 && ends?.outDir) dOut = ends.outDir;
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
      // winding reversed: the offset is the LEFT normal of travel (§11; pinned by the outward-normal test)
      indices.push(a + j, b + j + 1, b + j, a + j, a + j + 1, b + j + 1);
    }
  }
  // end caps on an open run (else a doorway shows the inside of the wall)
  if (!closed) {
    const cap = capProfile(profile);
    const last = (n - 1) * P;
    for (let t = 0; t < cap.length; t += 3) {
      // the far cap faces along travel, the near cap against it, so their
      // windings are opposites
      indices.push(last + cap[t], last + cap[t + 1], last + cap[t + 2]);
      indices.push(cap[t + 2], cap[t + 1], cap[t]);
    }
  }
  return { positions, indices, ringSize: P, rings: n };
}


/** A wall segment's two endpoints in grid-local metres, for any axis. */
export function segmentEnds(e, g) {
  // Both diagonals cut their OWN cell, as nodeAtPoint/halfTriangle define.
  // Axis 3 starts at NE and ends at SW; its start is not the NW corner.
  const a = [(e.x + (e.axis === 3 ? 1 : 0)) * g.tile, e.z * g.tile];
  const b = e.axis === 0 ? [(e.x + 1) * g.tile, e.z * g.tile]
    : e.axis === 1 ? [e.x * g.tile, (e.z + 1) * g.tile]
    : e.axis === 2 ? [(e.x + 1) * g.tile, (e.z + 1) * g.tile]
    : [e.x * g.tile, (e.z + 1) * g.tile];
  return [a, b];
}

/** The straightest neighbouring segment's direction arriving at / leaving an
 *  apertured segment, so its swept ends mitre into the run they interrupt. */
function neighbourDirs(level, g, key, e) {
  const [a, b] = segmentEnds(e, g);
  const unit = (p, q) => {
    const d = Math.hypot(q[0] - p[0], q[1] - p[1]) || 1;
    return [(q[0] - p[0]) / d, (q[1] - p[1]) / d];
  };
  const own = unit(a, b);
  /** `leaving`: the direction LEAVING the node (a path's end), else ARRIVING (its start). Mixing them flips the mitre (§11). */
  const at = (node, want, leaving) => {
    let best = null, bestDot = -2;
    for (const [k2, e2] of level.walls) {
      if (k2 === key) continue;
      const [c, d] = segmentEnds(e2, g);
      for (const [p, q] of [[c, d], [d, c]]) {
        if (Math.hypot(p[0] - node[0], p[1] - node[1]) > 1e-9) continue;
        const dir = leaving ? unit(p, q) : unit(q, p);
        const dot = dir[0] * want[0] + dir[1] * want[1];
        if (dot > bestDot) { bestDot = dot; best = dir; }
      }
    }
    return best;
  };
  return { inDir: at(a, own, false) ?? undefined, outDir: at(b, own, true) ?? undefined };
}

/** Swept geometry for one level: every solid wall run, mitred; each apertured segment's sill and lintel; window glass;
 *  and the prism under a half-floored cell. */
export function levelSweeps(level, g, floorY) {
  const prof = wallProfile(g);
  const out = [];
  for (const line of wallPolylines(level, g)) {
    const sw = sweepProfile(line.pts, prof, floorY);
    if (sw.positions.length) out.push({ ...sw, mat: line.mat, kind: 'wall' });
  }
  // a half-floored cell's slab is a triangle (§9)
  for (const [k, mat] of level.tiles) {
    const half = level.halves?.get(k);
    if (!half) continue;
    const [x, z] = k.split(',').map(Number);
    const d = diagOf(level, x, z);
    if (!d) continue;
    const pr = triPrism(halfTriangle(x, z, d, half, g), floorY - g.slabT, floorY);
    out.push({ ...pr, mat, kind: 'floor' });
  }

  // an apertured segment: the same swept profile, clipped vertically (§11)
  for (const [k, e] of level.walls) {
    const ap = level.apertures.get(k);
    if (!ap) continue;
    const prf = APERTURES[ap];
    const [a, b] = segmentEnds(e, g);
    const top = Math.min(prf.top, g.wallH);
    const nd = neighbourDirs(level, g, k, e);
    for (const [lo, hi] of [[0, prf.bottom], [top, g.wallH]]) {
      if (hi - lo < 1e-6) continue;
      const cp = clipProfileV(prof, lo, hi);
      if (cp.length < 2) continue;
      const sw = sweepProfile([a, b], cp, floorY, nd);
      if (sw.positions.length) out.push({ ...sw, mat: e.mat, kind: 'wall' });
    }
    // glass is swept too: edgeSpan can't express a diagonal
    if (prf.bottom > 0) {
      const gt = TRIM.glass.t / 2;
      const pane = [[-gt, prf.bottom], [-gt, top], [gt, top], [gt, prf.bottom], [-gt, prf.bottom]];
      const gs = sweepProfile([a, b], pane, floorY, nd);
      if (gs.positions.length) out.push({ ...gs, mat: 'glass', kind: 'glass' });
    }
  }
  return out;
}

/** Clip a wall profile to a vertical band, closing it flat at the cuts: a lintel is [top, H], a sill [0, bottom]; the flat
 *  cut is the reveal (§11). */
export function clipProfileV(profile, vMin, vMax) {
  const out = [];
  const lerp = (a, b, v) => {
    const t = (v - a[1]) / (b[1] - a[1]);
    return [a[0] + (b[0] - a[0]) * t, v];
  };
  for (let i = 0; i < profile.length; i++) {
    const cur = profile[i], prev = profile[i - 1];
    if (prev) {
      for (const edge of [vMin, vMax]) {
        if ((prev[1] < edge && cur[1] > edge) || (prev[1] > edge && cur[1] < edge)) {
          out.push(lerp(prev, cur, edge));
        }
      }
    }
    if (cur[1] >= vMin - 1e-9 && cur[1] <= vMax + 1e-9) out.push(cur);
  }
  // drop duplicates the clipping can produce at a vertex sitting on a cut
  return out.filter((p, i, a) => i === 0
    || Math.abs(p[0] - a[i - 1][0]) > 1e-9 || Math.abs(p[1] - a[i - 1][1]) > 1e-9);
}

/** Triangulate a profile as an END CAP. The profile is v-monotone, so it merge-walks its two chains (no ear clipping). */
export function capProfile(profile) {
  const n = profile.length;
  if (n < 3) return [];
  let apex = 0;
  for (let i = 1; i < n; i++) if (profile[i][1] > profile[apex][1]) apex = i;
  const left = [], right = [];
  for (let i = 0; i <= apex; i++) left.push(i);
  for (let i = n - 1; i >= apex; i--) right.push(i);
  const tris = [];
  let li = 0, ri = 0;
  while (li < left.length - 1 || ri < right.length - 1) {
    const advanceLeft = ri >= right.length - 1
      || (li < left.length - 1 && profile[left[li + 1]][1] <= profile[right[ri + 1]][1]);
    if (advanceLeft) { tris.push(left[li], left[li + 1], right[ri]); li++; }
    else { tris.push(right[ri], left[li], right[ri + 1]); ri++; }
  }
  return tris;
}

/** The three corners of a floored half-cell, in grid-local metres. */
export function halfTriangle(x, z, diag, half, g) {
  const t = g.tile, X = x * t, Z = z * t;
  const c = { nw: [X, Z], ne: [X + t, Z], se: [X + t, Z + t], sw: [X, Z + t] };
  if (diag === 2) {                                   // ↘ from nw to se
    return half === 'A' ? [c.nw, c.ne, c.se] : [c.nw, c.se, c.sw];
  }
  return half === 'A' ? [c.nw, c.ne, c.sw] : [c.ne, c.se, c.sw];   // ↗ from ne to sw
}

/** A closed triangular prism with outward normals (the slab under a half-cell): its winding from the cross product. */
export function triPrism(corners, y0, y1) {
  let [p0, p1, p2] = corners;
  const a = [p1[0] - p0[0], p1[1] - p0[1]], b = [p2[0] - p0[0], p2[1] - p0[1]];
  if (a[1] * b[0] - a[0] * b[1] <= 0) { const s = p1; p1 = p2; p2 = s; }
  const tri = [p0, p1, p2];
  const positions = [];
  for (const y of [y1, y0]) for (const p of tri) positions.push(p[0], y, p[1]);
  const indices = [0, 1, 2, 5, 4, 3];                 // top up, bottom down
  for (let i = 0; i < 3; i++) {
    const j = (i + 1) % 3;
    // the sides run the other way round from the caps (by signed volume)
    indices.push(i, j + 3, j, i, i + 3, j + 3);       // side quad, outward
  }
  return { positions, indices };
}
