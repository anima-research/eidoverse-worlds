// Horizontal centerline routing over a griddled structure. Outdoor cells are
// navigable too; indoor ROOM derivation remains the floor-only graph.
// This is topology, not capsule clearance or terrain/mesh navigation.
import { edgeKey, edgeBetween, nodeAtPoint, nodeOnSide, diagOf,
  halfTriangle, segmentEnds } from './structure.js';

export const ROUTE_MAX_CELLS = 16384;
const EPS = 1e-9;
const OPEN = new Set(['door', 'arch']);
const cross = (ax, az, bx, bz) => ax * bz - az * bx;

/** Closed segment intersection, including endpoints and collinear overlap.
 * Touching a solid wall is not an admissible shortcut around its endpoint. */
export function intersectsWall(a, b, c, d) {
  const rx = b[0] - a[0], rz = b[1] - a[1], sx = d[0] - c[0], sz = d[1] - c[1];
  const qx = c[0] - a[0], qz = c[1] - a[1];
  const den = cross(rx, rz, sx, sz);
  if (![rx, rz, sx, sz, qx, qz, den].every(Number.isFinite)) return true;
  if (Math.abs(den) > EPS) {
    const t = cross(qx, qz, sx, sz) / den, u = cross(qx, qz, rx, rz) / den;
    return t >= -EPS && t <= 1 + EPS && u >= -EPS && u <= 1 + EPS;
  }
  if (Math.abs(cross(qx, qz, rx, rz)) > EPS) return false;
  // Handles degenerate walk segments as a point-on-wall test too.
  if (Math.hypot(rx, rz) <= EPS && Math.abs(cross(a[0] - c[0], a[1] - c[1], sx, sz)) > EPS) return false;
  return Math.max(Math.min(a[0], b[0]), Math.min(c[0], d[0])) <= Math.min(Math.max(a[0], b[0]), Math.max(c[0], d[0])) + EPS &&
    Math.max(Math.min(a[1], b[1]), Math.min(c[1], d[1])) <= Math.min(Math.max(a[1], b[1]), Math.max(c[1], d[1])) + EPS;
}

function geometry(level, g) {
  const walls = [];
  for (const [key, edge] of level.walls) {
    if (OPEN.has(level.apertures.get(key))) continue;
    const ends = segmentEnds(edge, g);
    if (!ends.flat().every(Number.isFinite)) throw new Error('non-finite wall geometry');
    walls.push(ends);
  }
  return walls;
}
const clearOf = (walls, a, b) => !walls.some(([c, d]) => intersectsWall(a, b, c, d));
export function clearLevelSegment(level, g, a, b) {
  if (![...a, ...b].every(Number.isFinite)) return false;
  try { return clearOf(geometry(level, g), a, b); } catch { return false; }
}

/** The result distinguishes a validated direct leg from a refused route.
 * A refused search is never permission to walk the direct leg. */
export function routeLevel(level, g, from, to) {
  const blocked = reason => ({ kind: 'blocked', reason, points: [] });
  if (![...from, ...to].every(Number.isFinite)) return blocked('non-finite endpoint');
  let walls;
  try { walls = geometry(level, g); } catch (e) { return blocked(String(e.message)); }
  if (clearOf(walls, from, to)) return { kind: 'clear', points: [from, to] };
  if (!clearOf(walls, from, from) || !clearOf(walls, to, to)) return blocked('endpoint lies on a solid wall');

  // Bounds belong to authored geometry, never to walk distance. Include walls
  // without tiles: a free-standing exterior wall still blocks a walk.
  let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
  const include = (x, z) => { minX = Math.min(minX, x); minZ = Math.min(minZ, z); maxX = Math.max(maxX, x); maxZ = Math.max(maxZ, z); };
  for (const k of level.tiles.keys()) {
    const [x, z] = k.split(',').map(Number); include(x, z); include(x + 1, z + 1);
  }
  for (const edge of level.walls.values()) {
    // Full cell extent also contains either diagonal and either axis.
    include(edge.x, edge.z); include(edge.x + 1, edge.z + 1);
  }
  minX--; minZ--; maxX++; maxZ++;
  const width = maxX - minX, depth = maxZ - minZ;
  if (![minX, minZ, maxX, maxZ, width, depth].every(Number.isSafeInteger) ||
      width <= 0 || depth <= 0 || width > ROUTE_MAX_CELLS / depth)
    return blocked('routing region exceeds ' + ROUTE_MAX_CELLS + ' cells');
  // Padding guarantees the projected connector remains outside every wall.
  // Its landing lies on the outer ring's centers, not on an exclusive bound.
  const clip = p => [Math.max((minX + .5) * g.tile, Math.min((maxX - .5) * g.tile, p[0])),
    Math.max((minZ + .5) * g.tile, Math.min((maxZ - .5) * g.tile, p[1]))];
  const start = clip(from), end = clip(to);
  if (![...start, ...end].every(Number.isFinite) ||
      !clearOf(walls, from, start) || !clearOf(walls, end, to))
    return blocked('exterior connector is obstructed');
  const first = nodeAtPoint(level, g, ...start), last = nodeAtPoint(level, g, ...end);
  const center = key => {
    const [cell, half] = key.split(':');
    const [x, z] = cell.split(',').map(Number);
    if (!half) return [(x + .5) * g.tile, (z + .5) * g.tile];
    const tri = halfTriangle(x, z, diagOf(level, x, z), half, g);
    return [tri.reduce((n, p) => n + p[0], 0) / 3, tri.reduce((n, p) => n + p[1], 0) / 3];
  };
  const inside = (x, z) => x >= minX && x < maxX && z >= minZ && z < maxZ;
  const step = [[0, -1, 'N', 'S'], [1, 0, 'E', 'W'], [0, 1, 'S', 'N'], [-1, 0, 'W', 'E']];
  const neighbors = key => {
    const [cell, half] = key.split(':'), [x, z] = cell.split(',').map(Number);
    const out = [];
    for (const [dx, dz, side, back] of step) {
      const nx = x + dx, nz = z + dz;
      if (!inside(nx, nz) || nodeOnSide(level, x, z, side) !== key) continue;
      const e = edgeBetween(x, z, nx, nz), ek = edgeKey(...e);
      if (level.walls.has(ek) && !OPEN.has(level.apertures.get(ek))) continue;
      const dest = nodeOnSide(level, nx, nz, back);
      const crossing = e[0] === 0 ? [(e[1] + .5) * g.tile, e[2] * g.tile]
        : [e[1] * g.tile, (e[2] + .5) * g.tile];
      out.push({ key: dest, crossing });
    }
    const diag = diagOf(level, x, z);
    if (half && OPEN.has(level.apertures.get(edgeKey(diag, x, z))))
      out.push({ key: cell + (half === 'A' ? ':B' : ':A'), crossing: [(x + .5) * g.tile, (z + .5) * g.tile] });
    return out;
  };
  // At most two nodes per cell. BFS chooses deterministically; it makes no
  // promise of globally shortest Euclidean paths or multi-building search.
  const prev = new Map([[first, null]]), q = [first];
  for (let i = 0; i < q.length && !prev.has(last); i++) {
    for (const n of neighbors(q[i])) {
      if (prev.has(n.key)) continue;
      prev.set(n.key, { key: q[i], crossing: n.crossing }); q.push(n.key);
    }
  }
  if (!prev.has(last)) return blocked('no walkable opening connects the endpoints');
  const keys = [], crossings = [];
  for (let k = last; k !== null;) {
    keys.push(k);
    const p = prev.get(k);
    if (p) crossings.push(p.crossing);
    k = p?.key ?? null;
  }
  keys.reverse(); crossings.reverse();
  const raw = [from, start, center(first)];
  for (let i = 0; i < crossings.length; i++) raw.push(crossings[i], center(keys[i + 1]));
  raw.push(end, to);
  // Validate the actual polyline, including off-center endpoints and half-cell
  // representatives. Unsupported overlapping diagonals fail visibly here.
  for (let i = 1; i < raw.length; i++)
    if (!clearOf(walls, raw[i - 1], raw[i])) return blocked('cell route has an obstructed segment');
  // Local collinearity removal only. No unbounded visibility-search pass.
  const points = [];
  for (const p of raw) {
    if (points.length && Math.hypot(p[0] - points.at(-1)[0], p[1] - points.at(-1)[1]) < EPS) continue;
    while (points.length >= 2) {
      const a = points.at(-2), b = points.at(-1);
      const abx = b[0] - a[0], abz = b[1] - a[1], bpx = p[0] - b[0], bpz = p[1] - b[1];
      if (Math.abs(cross(abx, abz, bpx, bpz)) > EPS || abx * bpx + abz * bpz < 0 || !clearOf(walls, a, p)) break;
      points.pop();
    }
    points.push(p);
  }
  return { kind: 'routed', points };
}
