// Horizontal centerline routing over a griddled structure. Outdoor cells are
// navigable too; indoor ROOM derivation remains the floor-only graph.
// This is topology, not capsule clearance or terrain/mesh navigation.
import { edgeBetween, nodeAtPoint, nodeOnSide, diagOf,
  halfTriangle, halfFloored, segmentEnds, APERTURES } from './structure.js';

export const ROUTE_MAX_CELLS = 16384;
const EPS = 1e-9;
const OPEN = new Set(['door', 'arch']);
export const ROUTE_STEP_METRES = 0.5;
const cross = (ax, az, bx, bz) => ax * bz - az * bx;

/** Intersection parameters on the walking segment, including touching and
 * collinear overlap. null means disjoint; [t,t] means one crossing. */
function crossingRange(a, b, c, d) {
  const rx = b[0] - a[0], rz = b[1] - a[1], sx = d[0] - c[0], sz = d[1] - c[1];
  const qx = c[0] - a[0], qz = c[1] - a[1];
  const den = cross(rx, rz, sx, sz);
  if (![rx, rz, sx, sz, qx, qz, den].every(Number.isFinite)) throw new Error('non-finite segment geometry');
  if (Math.abs(den) > EPS) {
    const t = cross(qx, qz, sx, sz) / den, u = cross(qx, qz, rx, rz) / den;
    return t >= -EPS && t <= 1 + EPS && u >= -EPS && u <= 1 + EPS ? [Math.max(0, Math.min(1, t)), Math.max(0, Math.min(1, t))] : null;
  }
  if (Math.hypot(rx, rz) <= EPS) {
    if (Math.abs(cross(a[0]-c[0], a[1]-c[1], sx, sz)) > EPS) return null;
    return a[0] >= Math.min(c[0],d[0])-EPS && a[0] <= Math.max(c[0],d[0])+EPS &&
      a[1] >= Math.min(c[1],d[1])-EPS && a[1] <= Math.max(c[1],d[1])+EPS ? [0,0] : null;
  }
  if (Math.abs(cross(qx, qz, rx, rz)) > EPS) return null;
  const useX = Math.abs(rx) >= Math.abs(rz), axis = useX ? 0 : 1, r = useX ? rx : rz;
  const t0=(c[axis]-a[axis])/r, t1=(d[axis]-a[axis])/r;
  const lo=Math.max(0,Math.min(t0,t1)), hi=Math.min(1,Math.max(t0,t1));
  return hi >= lo-EPS ? [lo,Math.max(lo,hi)] : null;
}

// Plans are immutable derivations of one received component revision.
// Weak keys retain neither replaced component revisions nor discarded plans.
const routeGeometry = new WeakMap();
export function routeGeometryFor(plan) {
  let prepared = routeGeometry.get(plan);
  if (prepared) return prepared;
  const spans = [];
  const terrain = { tiles: new Map(), walls: new Map(), apertures: new Map(), halves: new Map() };
  for (const lv of plan.levels) {
    for (const [key,tile] of lv.level.tiles) terrain.tiles.set(key,tile);
    for (const [key,edge] of lv.level.walls) terrain.walls.set(key,edge);
  }
  for (const lv of plan.levels) for (const [key, edge] of lv.level.walls) {
    const ends = segmentEnds(edge, plan.grid), ap = lv.level.apertures.get(key);
    // Windows remain topological barriers. Doors/arches remove their opening,
    // but the lintel above the opening still obstructs a higher terrain plane.
    const low = lv.y + (OPEN.has(ap) ? Math.min(APERTURES[ap].top, plan.grid.wallH) : 0);
    const high = lv.y + plan.grid.wallH;
    if (!ends.flat().concat([low,high]).every(Number.isFinite)) throw new Error('non-finite wall geometry');
    if (high > low) spans.push({ ends, low, high });
  }
  prepared = { spans, terrain };
  routeGeometry.set(plan,prepared);
  return prepared;
}

/** Geometry is shared across walks; this checker is fresh for each supplied
 * support basis. A tall lower wall can obstruct without supplying support. */
export function prepareWallCheck(plan, basis) {
  const band = basis.step ?? ROUTE_STEP_METRES;
  if (!Number.isFinite(band) || band < 0) throw new Error('invalid local step band');
  const { spans } = routeGeometryFor(plan);
  const heightAt = basis.kind === 'terrain' ? basis.heightAt : () => basis.height;
  if (typeof heightAt !== 'function') throw new Error('terrain walking requires a height function');
  const overlaps = (span, y) => y < span.high - EPS && y + band >= span.low - EPS;
  return (a, b) => {
    if (![...a,...b].every(Number.isFinite)) return false;
    try {
      // Non-finite support data is a refusal even on a wall-free segment.
      if (![heightAt(...a),heightAt(...b)].every(Number.isFinite)) return false;
      for (const span of spans) {
        const range = crossingRange(a,b,...span.ends);
        if (!range) continue;
        const point = t => [a[0]+(b[0]-a[0])*t,a[1]+(b[1]-a[1])*t];
        if (range[1]-range[0] > EPS && basis.kind === 'terrain') {
          // A point-query terrain API cannot bound its height over an entire
          // collinear overlap. Route away from that projected wall rather than
          // certify it from a few samples. Point crossings are exact queries.
          return false;
        }
        const y = heightAt(...point(range[0]));
        if (!Number.isFinite(y) || overlaps(span,y)) return false;
      }
      return true;
    } catch { return false; }
  };
}

/** The result distinguishes a validated direct leg from a refused route.
 * A refused search is never permission to walk the direct leg. */
export function routeLevel(level, g, from, to, outdoors, clear) {
  const blocked = reason => ({ kind: 'blocked', reason, points: [] });
  if (![...from, ...to].every(Number.isFinite)) return blocked('non-finite endpoint');
  if (outdoors && clear(from, to)) return { kind: 'clear', points: [from, to] };
  if (!clear(from, from) || !clear(to, to)) return blocked('endpoint lies on a solid wall');

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
      !clear(from, start) || !clear(end, to))
    return blocked('exterior connector is obstructed');
  const first = nodeAtPoint(level, g, ...start), last = nodeAtPoint(level, g, ...end);
  const allowed = key => {
    if (outdoors) return true;
    const [cell, half] = key.split(':'), [x, z] = cell.split(',').map(Number);
    return level.tiles.has(cell) && (!half || halfFloored(level, x, z, half));
  };
  // Terrain mode has its own supplied support everywhere. Identified-floor
  // mode has only this floor's cells/halves, irrespective of level ordering.
  if (!outdoors && (!allowed(first) || !allowed(last) || start[0] !== from[0] ||
      start[1] !== from[1] || end[0] !== to[0] || end[1] !== to[1]))
    return blocked('identified-floor route requires floored endpoints (floor-to-terrain transitions are unavailable)');
  // One cell/half is convex. Its admitted endpoints can use a clear direct
  // segment, especially a stationary request which must not visit the center.
  if (!outdoors && first === last && clear(from, to))
    return { kind: 'clear', points: [from, to] };
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
      const e = edgeBetween(x, z, nx, nz);
      const dest = nodeOnSide(level, nx, nz, back);
      if (!allowed(dest)) continue;
      const crossing = e[0] === 0 ? [(e[1] + .5) * g.tile, e[2] * g.tile]
        : [e[1] * g.tile, (e[2] + .5) * g.tile];
      if (clear(center(key),crossing) && clear(crossing,center(dest))) out.push({ key: dest, crossing });
    }
    const other = cell + (half === 'A' ? ':B' : ':A');
    const crossing = [(x + .5) * g.tile, (z + .5) * g.tile];
    if (half && allowed(other) && clear(center(key),crossing) && clear(crossing,center(other)))
      out.push({ key: other, crossing });
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
  if (!prev.has(last)) return blocked('no walkable connection between the endpoints');
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
    if (!clear(raw[i - 1], raw[i])) return blocked('cell route has an obstructed segment');
  // Local collinearity removal only. No unbounded visibility-search pass.
  const points = [];
  for (const p of raw) {
    if (points.length && Math.hypot(p[0] - points.at(-1)[0], p[1] - points.at(-1)[1]) < EPS) continue;
    while (points.length >= 2) {
      const a = points.at(-2), b = points.at(-1);
      const abx = b[0] - a[0], abz = b[1] - a[1], bpx = p[0] - b[0], bpz = p[1] - b[1];
      if (Math.abs(cross(abx, abz, bpx, bpz)) > EPS || abx * bpx + abz * bpz < 0 || !clear(a, p)) break;
      points.pop();
    }
    points.push(p);
  }
  return { kind: 'routed', points };
}
