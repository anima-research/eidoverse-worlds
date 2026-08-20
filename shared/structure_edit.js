// structure_edit — the griddled-building editor's pure half.
//
// Every operation is DATA IN, DATA OUT: a `structure` component goes in, a new
// one comes out, and nothing is mutated. That falls out of how a building is
// stored — one `comp`, replaced wholesale — and it buys three things for free:
//
//   - UNDO is keeping the previous value. No inverse operations to get wrong,
//     no replaying a log backwards.
//   - A PREVIEW is just running the edit and drawing the result. The ghost and
//     the commit cannot disagree, because they are the same function.
//   - The whole editor is testable with no browser, no pointer, no scene.
//
// ⚠️ Wholesale replace also means LAST WRITE WINS. Two people editing one
// building will clobber each other — not corrupt it, but silently lose an edit.
// That is a real limitation of the storage choice, worth knowing before anyone
// builds together rather than after.

import { cellKey, edgeKey, APERTURES, GRID_DEFAULTS } from './structure.js';

/** A structure's own defaults, so an empty building is still a legal one. */
export const emptyStructure = (over = {}) => ({
  tile: GRID_DEFAULTS.tile, wallH: GRID_DEFAULTS.wallH, wallT: GRID_DEFAULTS.wallT,
  labels: {}, levels: [{ y: 0, tiles: [], walls: [], apertures: [] }], ...over,
});

const clone = (d) => JSON.parse(JSON.stringify(d ?? emptyStructure()));
const lvOf = (d, i) => (d.levels[i] ??= { y: 0, tiles: [], walls: [], apertures: [] });

/** Edge identity, for comparing entries that may carry extra fields. */
const sameEdge = (w, axis, x, z) => w[0] === axis && w[1] === x && w[2] === z;
const sameCell = (t, x, z) => t[0] === x && t[1] === z;

// ---- picking ----------------------------------------------------------------

/** Every edge of the cell under a grid-local point, nearest first.
 *
 *  Distances are in metres along the surface, so a mode can simply take the
 *  first entry, or filter to the kinds it accepts — the wall tool wants edges
 *  and diagonals, the floor tool wants none of them. Returning the whole list
 *  rather than one winner is what lets the same pick serve every tool. */
export function pickEdges(g, lx, lz) {
  const t = g.tile ?? GRID_DEFAULTS.tile;
  const cx = Math.floor(lx / t), cz = Math.floor(lz / t);
  const u = lx / t - cx, v = lz / t - cz;
  const R = Math.SQRT1_2;
  return [
    { axis: 0, x: cx, z: cz, d: v * t, side: 'N' },
    { axis: 0, x: cx, z: cz + 1, d: (1 - v) * t, side: 'S' },
    { axis: 1, x: cx, z: cz, d: u * t, side: 'W' },
    { axis: 1, x: cx + 1, z: cz, d: (1 - u) * t, side: 'E' },
    { axis: 2, x: cx, z: cz, d: Math.abs(u - v) * R * t, side: 'NW-SE' },
    { axis: 3, x: cx, z: cz, d: Math.abs(u + v - 1) * R * t, side: 'NE-SW' },
  ].sort((a, b) => a.d - b.d);
}

/** The nearest edge of the kinds a tool accepts. */
export function pickEdge(g, lx, lz, { diagonals = true } = {}) {
  const all = pickEdges(g, lx, lz).filter((e) => diagonals || e.axis < 2);
  return all[0] ?? null;
}

/** The nearest edge that actually CARRIES a wall.
 *
 *  Geometric nearness is the wrong question for a door tool. The diagonals
 *  cross a cell's middle, so anywhere near the centre the nearest edge is a
 *  diagonal that usually has no wall in it — and the click silently does
 *  nothing. Asking for the nearest edge that exists is what the user meant. */
export function pickWalledEdge(data, lx, lz, level = 0) {
  const lv = data?.levels?.[level];
  if (!lv) return null;
  const have = new Set((lv.walls ?? []).map((w) => `${w[0]}:${w[1]},${w[2]}`));
  return pickEdges(data, lx, lz).find((e) => have.has(`${e.axis}:${e.x},${e.z}`)) ?? null;
}

export const pickCell = (g, lx, lz) => {
  const t = g.tile ?? GRID_DEFAULTS.tile;
  return { x: Math.floor(lx / t), z: Math.floor(lz / t) };
};

// ---- edits ------------------------------------------------------------------

export function addWall(data, { axis, x, z }, level = 0, mat = 'wall') {
  const d = clone(data), lv = lvOf(d, level);
  if (lv.walls.some((w) => sameEdge(w, axis, x, z))) return d;
  // a diagonal and an orthogonal wall can coexist in a cell, but TWO diagonals
  // cannot — the second would cut a cell already cut
  if (axis >= 2) lv.walls = lv.walls.filter((w) => !(w[0] >= 2 && w[1] === x && w[2] === z));
  lv.walls.push(mat === 'wall' ? [axis, x, z] : [axis, x, z, mat]);
  return d;
}

export function removeWall(data, { axis, x, z }, level = 0) {
  const d = clone(data), lv = lvOf(d, level);
  lv.walls = lv.walls.filter((w) => !sameEdge(w, axis, x, z));
  // an aperture with no wall to sit in is not a doorway, it is nothing
  lv.apertures = lv.apertures.filter((a) => !sameEdge(a, axis, x, z));
  return d;
}

/** Put an aperture in a wall, or clear it with kind = null. */
export function setAperture(data, { axis, x, z }, kind, level = 0) {
  const d = clone(data), lv = lvOf(d, level);
  if (!lv.walls.some((w) => sameEdge(w, axis, x, z))) return d;   // nothing to hole
  lv.apertures = lv.apertures.filter((a) => !sameEdge(a, axis, x, z));
  if (kind && APERTURES[kind]) lv.apertures.push([axis, x, z, kind]);
  return d;
}

export function setTile(data, { x, z }, mat = 'floor', half = null, level = 0) {
  const d = clone(data), lv = lvOf(d, level);
  lv.tiles = lv.tiles.filter((t) => !sameCell(t, x, z));
  lv.tiles.push(half ? [x, z, mat, half] : [x, z, mat]);
  return d;
}

export function removeTile(data, { x, z }, level = 0) {
  const d = clone(data), lv = lvOf(d, level);
  lv.tiles = lv.tiles.filter((t) => !sameCell(t, x, z));
  return d;
}

/** Draw a rectangular room: floor across the span, walls right round it.
 *
 *  This is the primary tool — in Sims you drag a room, you do not lay walls one
 *  at a time — and it is also where the edge model earns its keep. The
 *  perimeter is expressed as edges, so dragging a second room against the first
 *  SHARES their common wall instead of stacking two walls in one place. */
export function drawRoom(data, a, b, level = 0, mat = 'wall') {
  let d = clone(data);
  const x0 = Math.min(a.x, b.x), x1 = Math.max(a.x, b.x);
  const z0 = Math.min(a.z, b.z), z1 = Math.max(a.z, b.z);
  for (let x = x0; x <= x1; x++) {
    for (let z = z0; z <= z1; z++) d = setTile(d, { x, z }, 'floor', null, level);
  }
  for (let x = x0; x <= x1; x++) {
    d = addWall(d, { axis: 0, x, z: z0 }, level, mat);
    d = addWall(d, { axis: 0, x, z: z1 + 1 }, level, mat);
  }
  for (let z = z0; z <= z1; z++) {
    d = addWall(d, { axis: 1, x: x0, z }, level, mat);
    d = addWall(d, { axis: 1, x: x1 + 1, z }, level, mat);
  }
  return d;
}

/** Erase a rectangle: floor and any wall not shared with what remains. */
export function eraseRoom(data, a, b, level = 0) {
  let d = clone(data);
  const x0 = Math.min(a.x, b.x), x1 = Math.max(a.x, b.x);
  const z0 = Math.min(a.z, b.z), z1 = Math.max(a.z, b.z);
  for (let x = x0; x <= x1; x++) {
    for (let z = z0; z <= z1; z++) d = removeTile(d, { x, z }, level);
  }
  const lv = lvOf(d, level);
  const floored = new Set(lv.tiles.map((t) => cellKey(t[0], t[1])));
  // a wall survives if either side still has a floor: it is someone else's wall
  lv.walls = lv.walls.filter((w) => {
    const [axis, x, z] = w;
    if (axis >= 2) return floored.has(cellKey(x, z));
    const [[ax, az], [bx, bz]] = axis === 0
      ? [[x, z - 1], [x, z]] : [[x - 1, z], [x, z]];
    return floored.has(cellKey(ax, az)) || floored.has(cellKey(bx, bz));
  });
  const kept = new Set(lv.walls.map((w) => edgeKey(w[0], w[1], w[2])));
  lv.apertures = lv.apertures.filter((a2) => kept.has(edgeKey(a2[0], a2[1], a2[2])));
  return d;
}

/** Name the room a cell belongs to. */
export function labelCell(data, { x, z }, label) {
  const d = clone(data);
  d.labels = { ...d.labels };
  if (label) d.labels[cellKey(x, z)] = label; else delete d.labels[cellKey(x, z)];
  return d;
}
