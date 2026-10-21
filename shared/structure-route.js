// Horizontal centerline routing over a griddled structure. Outdoor cells are
// navigable too; indoor ROOM derivation remains the floor-only graph.
// This is topology, not capsule clearance or terrain/mesh navigation.
import { edgeBetween, nodeAtPoint, nodeOnSide, diagOf,
  halfTriangle, halfFloored, segmentEnds, APERTURES, cellKey, edgeKey } from './structure.js';

export const ROUTE_MAX_CELLS = 16384;
const EPS = 1e-9;
const OPEN = new Set(['door', 'arch']);
export const ROUTE_STEP_METRES = 0.5;
/** Why an endpoint that isn't a finite point can't be routed. walk_to refuses
 *  a non-finite destination before it plans, so here the start (the body's
 *  own position) or the structure's placement, which carries both endpoints
 *  into its frame, wasn't finite. */
export const NON_FINITE_ENDPOINT = "an endpoint isn't a finite point in the structure's frame (the body's position or the structure's placement isn't finite), so it can't be routed, and calling again won't change that; if you need this walk, ask whoever runs this host";
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

/** Cell bounds of authored geometry: every tile, and every wall's full cell
 * (which contains either diagonal and either axis), so a free-standing wall
 * without tiles still bounds the search. Empty geometry leaves minX at
 * Infinity. */
function emptyBounds() { return { minX: Infinity, minZ: Infinity, maxX: -Infinity, maxZ: -Infinity }; }
function includeLevel(bounds, level) {
  const include = (x, z) => {
    bounds.minX = Math.min(bounds.minX, x); bounds.minZ = Math.min(bounds.minZ, z);
    bounds.maxX = Math.max(bounds.maxX, x); bounds.maxZ = Math.max(bounds.maxZ, z);
  };
  for (const k of level.tiles.keys()) {
    const [x, z] = k.split(',').map(Number); include(x, z); include(x + 1, z + 1);
  }
  for (const edge of level.walls.values()) { include(edge.x, edge.z); include(edge.x + 1, edge.z + 1); }
  return bounds;
}

// A span is filed under every cell its segment's box touches, widened by
// this margin (in cells) so a segment that only touches a wall at a cell
// boundary still finds it.
const BUCKET_MARGIN = 1e-6;
const cellRange = (lo, hi, tile) => [Math.floor(lo / tile - BUCKET_MARGIN), Math.floor(hi / tile + BUCKET_MARGIN)];

// Plans are immutable derivations of one received component revision.
// Weak keys retain neither replaced component revisions nor discarded plans.
const routeGeometry = new WeakMap();

/** What routing needs from one plan, derived once: every level's wall spans,
 * filed by the cells they touch so a check reads only the walls near its
 * segment; each cell's diagonals, which a terrain walker's graph chooses
 * among per walk (see terrainCells); and the bounds of all authored
 * geometry, which a terrain walker's search covers. */
export function routeGeometryFor(plan) {
  let prepared = routeGeometry.get(plan);
  if (prepared) return prepared;
  const g = plan.grid, spans = [], buckets = new Map(), diagonals = new Map();
  // Spans whose cells aren't safe integers (authored far beyond any search's
  // reach) can't be filed by cell; every check reads them directly.
  const wide = [];
  let cells = 0;
  const bounds = emptyBounds();
  for (const lv of plan.levels) {
    includeLevel(bounds, lv.level);
    for (const [key, edge] of lv.level.walls) {
      const ends = segmentEnds(edge, g), ap = lv.level.apertures.get(key);
      // Windows remain topological barriers. Doors/arches remove their opening,
      // but the lintel above the opening still obstructs a higher terrain plane.
      const low = lv.y + (OPEN.has(ap) ? Math.min(APERTURES[ap].top, g.wallH) : 0);
      const high = lv.y + g.wallH;
      if (!ends.flat().concat([low,high]).every(Number.isFinite)) throw new Error('non-finite wall geometry');
      if (high <= low) continue;            // an opening the wall's full height: nothing stands there
      const span = { ends, low, high, seen: 0 };
      spans.push(span);
      const [x0, x1] = cellRange(Math.min(ends[0][0], ends[1][0]), Math.max(ends[0][0], ends[1][0]), g.tile);
      const [z0, z1] = cellRange(Math.min(ends[0][1], ends[1][1]), Math.max(ends[0][1], ends[1][1]), g.tile);
      if (![x0, x1, z0, z1].every(Number.isSafeInteger)) wide.push(span);
      else for (let x = x0; x <= x1; x++) {
        let column = buckets.get(x);
        if (!column) buckets.set(x, column = new Map());
        for (let z = z0; z <= z1; z++) {
          const list = column.get(z);
          if (list) list.push(span); else { column.set(z, [span]); cells++; }
        }
      }
      if (edge.axis >= 2) {
        const cell = cellKey(edge.x, edge.z), options = diagonals.get(cell);
        const option = { axis: edge.axis, edge, low, high };
        if (options) options.push(option); else diagonals.set(cell, [option]);
      }
    }
  }
  prepared = { spans, buckets, wide, cells, diagonals, bounds };
  routeGeometry.set(plan,prepared);
  return prepared;
}

// Each check marks the spans it has tested with a fresh stamp, so a span
// filed under several cells is tested once per check.
let stamp = 0;

/** Geometry is shared across walks; this checker is fresh for each supplied
 * support basis. A tall lower wall can obstruct without supplying support. */
export function prepareWallCheck(plan, basis) {
  const band = basis.step ?? ROUTE_STEP_METRES;
  if (!Number.isFinite(band) || band < 0) throw new Error('invalid local step band');
  const { spans, buckets, wide, cells } = routeGeometryFor(plan);
  const tile = plan.grid.tile;
  const heightAt = basis.kind === 'terrain' ? basis.heightAt : () => basis.height;
  if (typeof heightAt !== 'function') throw new Error('terrain walking requires a height function');
  const overlaps = (span, y) => y < span.high - EPS && y + band >= span.low - EPS;
  return (a, b) => {
    if (![...a,...b].every(Number.isFinite)) return false;
    try {
      // Non-finite support data is a refusal even on a wall-free segment.
      if (![heightAt(...a),heightAt(...b)].every(Number.isFinite)) return false;
      const visit = ++stamp;
      const obstructs = span => {
        if (span.seen === visit) return false;
        span.seen = visit;
        const range = crossingRange(a,b,...span.ends);
        if (!range) return false;
        // A point-query terrain API cannot bound its height over an entire
        // collinear overlap. Route away from that projected wall rather than
        // certify it from a few samples. Point crossings are exact queries.
        if (range[1]-range[0] > EPS && basis.kind === 'terrain') return true;
        const t = range[0];
        const y = heightAt(a[0]+(b[0]-a[0])*t, a[1]+(b[1]-a[1])*t);
        return !Number.isFinite(y) || overlaps(span,y);
      };
      const [x0, x1] = cellRange(Math.min(a[0], b[0]), Math.max(a[0], b[0]), tile);
      const [z0, z1] = cellRange(Math.min(a[1], b[1]), Math.max(a[1], b[1]), tile);
      // A long segment (a distant endpoint's connector) covers more cells than
      // hold walls: then read the spans directly rather than every cell it covers.
      if (![x0, x1, z0, z1].every(Number.isSafeInteger) || (x1 - x0 + 1) * (z1 - z0 + 1) > cells)
        return !spans.some(obstructs);
      if (wide.some(obstructs)) return false;
      for (let x = x0; x <= x1; x++) {
        const column = buckets.get(x);
        if (!column) continue;
        for (let z = z0; z <= z1; z++) {
          const list = column.get(z);
          if (list && list.some(obstructs)) return false;
        }
      }
      return true;
    } catch { return false; }
  };
}

/** The cell graph a terrain walker searches: the diagonals that cut its
 * cells, chosen for this walk. Levels can cut one cell along different
 * diagonals, and the one that matters is the one a walker meets: the
 * diagonal whose span meets the feet-to-step band at the cell centre's
 * terrain height. When both do, the cell is cut both ways, which two halves
 * can't represent; ↘ is taken, and legs that would cross ↗ fail the wall check
 * and route elsewhere. A diagonal no level's band meets leaves the cell
 * whole. Only diagonals are carried: the node helpers read nothing else of a
 * level for a terrain walker (openings are in the spans, and half floors
 * don't bound one), and the search's bounds come from all levels. */
export function terrainCells(plan, heightAt, band) {
  const { diagonals } = routeGeometryFor(plan), g = plan.grid, walls = new Map();
  for (const [cell, options] of diagonals) {
    const [x, z] = cell.split(',').map(Number);
    const y = heightAt((x + .5) * g.tile, (z + .5) * g.tile);
    const meets = Number.isFinite(y) ? options.filter(o => y < o.high - EPS && y + band >= o.low - EPS) : options;
    const pick = meets.find(o => o.axis === 2) ?? meets[0];
    if (pick) walls.set(edgeKey(pick.axis, x, z), pick.edge);
  }
  return { walls };
}

/** The result distinguishes a validated direct leg from a refused route.
 * A refused search is never permission to walk the direct leg. The search
 * covers `bounds` (a level's own when omitted), padded by one cell; `scale`
 * is world metres per local metre, for the refusal's figures. */
export function routeLevel(level, g, from, to, outdoors, clear, { bounds, scale = 1 } = {}) {
  const blocked = reason => ({ kind: 'blocked', reason, points: [] });
  if (![...from, ...to].every(Number.isFinite)) return blocked(NON_FINITE_ENDPOINT);
  if (outdoors && clear(from, to)) return { kind: 'clear', points: [from, to] };
  if (!clear(from, from)) return blocked('the start is inside one of its walls');
  if (!clear(to, to)) return blocked('the destination is inside one of its walls; pick a point in one of its rooms, or outside it');

  // Bounds belong to authored geometry, never to walk distance.
  let { minX, minZ, maxX, maxZ } = bounds ?? includeLevel(emptyBounds(), level);
  if (minX > maxX) return blocked(outdoors ? 'the structure has no cells or walls' : 'the identified floor has no cells');
  minX--; minZ--; maxX++; maxZ++;
  const width = maxX - minX, depth = maxZ - minZ;
  if (![minX, minZ, maxX, maxZ, width, depth].every(Number.isSafeInteger) || width > ROUTE_MAX_CELLS / depth) {
    const metres = n => +(n * g.tile * scale).toPrecision(4);
    return blocked(`its footprint, padded by a cell, is ${width}×${depth} cells (${metres(width)}×${metres(depth)} m), ` +
      `over the ${ROUTE_MAX_CELLS}-cell routing limit; nearer endpoints won't help, since the search covers the whole ` +
      `footprint, but a straight leg that clears its walls needs no search`);
  }
  // Padding guarantees the projected connector remains outside every wall.
  // Its landing lies on the outer ring's centers, not on an exclusive bound.
  const clip = p => [Math.max((minX + .5) * g.tile, Math.min((maxX - .5) * g.tile, p[0])),
    Math.max((minZ + .5) * g.tile, Math.min((maxZ - .5) * g.tile, p[1]))];
  const start = clip(from), end = clip(to);
  if (![...start, ...end].every(Number.isFinite) ||
      !clear(from, start) || !clear(end, to))
    return blocked('the straight approach from an endpoint to the structure crosses one of its walls');
  const first = nodeAtPoint(level, g, ...start), last = nodeAtPoint(level, g, ...end);
  const allowed = key => {
    if (outdoors) return true;
    const [cell, half] = key.split(':'), [x, z] = cell.split(',').map(Number);
    return level.tiles.has(cell) && (!half || halfFloored(level, x, z, half));
  };
  // Terrain mode has its own supplied support everywhere. Identified-floor
  // mode has only this floor's cells/halves, irrespective of level ordering.
  if (!outdoors && (!allowed(first) || start[0] !== from[0] || start[1] !== from[1]))
    return blocked("the start isn't on this floor (it's off the floor's edge, or over a hole in it), so no route on this floor can begin there, whatever the destination");
  if (!outdoors && (!allowed(last) || end[0] !== to[0] || end[1] !== to[1]))
    return blocked("the destination isn't on this floor (it's off the floor's edge, or over a hole in it), and a walk from a floor onto the ground or another building isn't supported; pick a destination on the same floor");
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
  if (!prev.has(last)) {
    return blocked(outdoors
      ? "no path through its doorways and arches connects the start to the destination (windows don't count); pick a destination you can reach through an opening"
      : "no path across this floor connects the start to the destination: its walls are crossed only through doorways and arches (windows don't count), and a hole in the floor can divide it; pick a destination you can reach on the floor");
  }
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
