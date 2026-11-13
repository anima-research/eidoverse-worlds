// navgrid — routes for a walking body through placed models, found by asking
// the same collision code that will carry the walk out.
//
// The feet (agent.ts stepFeet, client/lib/player/controller.js) move by colliders.resolveColliders, so the planner asks
// that same code, column by column on a fine lattice, and has no walkability opinion of its own:
//   - standing heights in a column: each up-facing surface (surfaceUnder, repeated downward) where
//     resolveColliders neither pushes the capsule nor answers a different floor. Storeys = several heights.
//   - a move to a neighbour column: only to a standing height within STEP (a stair tread, not a balcony).
// A* over (column, height), then string-pulled by stepping resolveColliders along each shortcut as the feet would.
//
// Pure: the world arrives through NavProbe (physics.ts navProbe). A grid caches columns until a collider changes,
// so callers keep one per physics.ts collidersGeneration.

import { MOVER } from "./mover.js";

/** Lattice spacing. Under the capsule radius (0.32), so a wall cannot fall
 *  between two neighbouring standing columns: both would be within reach of it. */
export const NAV_CELL = 0.2;
/** The lattice sits this far off the round-metre grid: a point exactly ON an authored wall face (round
 *  coordinates) can't be pushed (no direction) and would read as standing room inside the wall. */
export const NAV_OFF = 0.0131;
const at = (i) => i * NAV_CELL + NAV_OFF;
const cell = (x) => Math.round((x - NAV_OFF) / NAV_CELL);
/** Most a walk climbs or drops between neighbouring columns: the feet's own step-up (shared/mover.js
 *  MOVER.body.step), one value for walker, feet and planner. Drops too: a route never steps off a balcony. */
export const NAV_STEP = MOVER.body.step;
/** A push smaller than this is a nudge, not a wall (a balustrade beside a stair). Routed walks arrive at
 *  waypoints within it (agent.ts). */
export const NAV_NUDGE = 0.05;
/** How far around the walk's own box the search may wander for a way round. */
export const NAV_PAD = 8;
/** Expansions before the search gives up — bounds the time a walk can block
 *  the process (every agent in it shares one event loop). */
export const NAV_MAX_EXPANSIONS = 40_000;
/**
 * @typedef {object} NavProbe
 * @property {(x: number, z: number, maxY: number) => number} surfaceUnder height of the topmost surface at or below maxY at (x, z), terrain if none
 * @property {(x: number, y: number, z: number) => { ground: number, push: number }} stand a standing body's answer at (x, y, z): the ground it finds, and how far it is pushed sideways
 */
/** @typedef {{ x: number, y: number, z: number }} NavPoint */
/** Where a route ends: see route().
 *  @typedef {{ x: number, z: number, y?: number, reach?: number, above?: number, below?: number, inside?: (x: number, z: number) => boolean }} NavTarget */
/** @typedef {{ points: NavPoint[], snapped: boolean } | { refusal: string }} NavResult */

/** Longest horizontal move between two collision checks, for the feet (agent.ts) and the planner. Browser scale
 *  (2.6cm/frame walking at 60fps): a coarser step would get past a hip-band edge where a person is held. */
export const NAV_SUBSTEP = 0.03;
const SUBSTEP = NAV_SUBSTEP;
/** Planner step over level ground (see walkable). */
const COARSE = 0.1;
const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];

/** Probes one plan may make (every probe, not just expansions) before it is refused, so no plan holds the event loop. */
export const NAV_MAX_PROBES = 200_000;
/** Columns a grid remembers before starting over (it is only a cache). */
const NAV_MAX_COLUMNS = 300_000;
const OVER_BUDGET = new Error("navgrid: over budget");

/** @param {NavProbe} raw */
export function makeNavGrid(raw) {
  let budget = Infinity;
  const probe = {
    surfaceUnder: (x, z, m) => { if (--budget < 0) throw OVER_BUDGET; return raw.surfaceUnder(x, z, m); },
    stand: (x, y, z) => { if (--budget < 0) throw OVER_BUDGET; return raw.stand(x, y, z); },
  };
  const cols = new Map();

  /** Standing heights in lattice column (i, j), highest first. */
  function layers(i, j) {
    const key = `${i},${j}`;
    let out = cols.get(key);
    if (out) return out;
    out = [];
    const x = at(i), z = at(j);
    let maxY = Infinity;
    for (let n = 0; n < 16; n++) {
      const y = probe.surfaceUnder(x, z, maxY);
      if (!Number.isFinite(y) || y > maxY) break;          // only the terrain is left, and it is above the search
      const s = probe.stand(x, y, z);
      // a surface the probe overrules (a slab's underside answers its top) is found again: dedupe
      if (s.push < NAV_NUDGE && s.ground >= y - 0.01 && !out.some((v) => Math.abs(v - s.ground) < 0.05)) out.push(s.ground);
      maxY = y - 0.02;
    }
    out.sort((a, b) => b - a);
    if (cols.size >= NAV_MAX_COLUMNS) { cols.clear(); steps.clear(); level.clear(); }
    cols.set(key, out);
    return out;
  }

  /** The standing height in a column closest to y and within STEP of it. */
  function match(i, j, y, within = NAV_STEP) {
    let best = null;
    for (const v of layers(i, j)) if (Math.abs(v - y) <= within && (best === null || Math.abs(v - y) < Math.abs(best - y))) best = v;
    return best;
  }

  /** Can a body walk the straight line a→b, stepped as the feet step it (agent.ts stepFeet): never pushed, ground
   *  within a step of the last, arriving at b's height. */
  function clear(a, b) {
    return roughlyClear(a, b) && walkable(a, b);
  }

  const steps = new Map();
  const level = new Map();
  /** A level move still needs floor at the midpoint (two slabs with a gap between are not a path). */
  function levelOK(i0, j0, i1, j1, y) {
    const k = `${i0},${j0}>${i1},${j1},${Math.round(y * 100)}`;
    let ok = level.get(k);
    if (ok === undefined) {
      const st = probe.stand((at(i0) + at(i1)) / 2, y, (at(j0) + at(j1)) / 2);
      level.set(k, ok = st.push < NAV_NUDGE && Math.abs(st.ground - y) < 0.05);
    }
    return ok;
  }
  /** Can the feet get from one column's height to a neighbour's? Cached: the
   *  answer is as durable as the columns. */
  function stepOK(i0, j0, y0, i1, j1, y1) {
    const k = `${i0},${j0},${Math.round(y0 * 100)}>${i1},${j1},${Math.round(y1 * 100)}`;
    let ok = steps.get(k);
    if (ok === undefined) steps.set(k, ok = walkable({ x: at(i0), y: y0, z: at(j0) }, { x: at(i1), y: y1, z: at(j1) }));
    return ok;
  }

  /** The moves from column (i0, j0) at height y0: each of eight neighbours with a standing height within a step,
   *  no diagonal corner-cutting. The search and server/buildcheck.ts both move by exactly this. */
  function moves(i0, j0, y0) {
    const out = [];
    for (const [di, dj] of DIRS) {
      const i = i0 + di, j = j0 + dj;
      const y = match(i, j, y0);
      if (y === null) continue;
      if (di && dj && (match(i0 + di, j0, y0) === null || match(i0, j0 + dj, y0) === null)) continue;
      // level: nothing can push between two standing columns, but the floor can end (levelOK); a height change can
      // push (a floor edge in the hip band), so it is stepped as the feet will
      if (Math.abs(y - y0) > 0.01 ? !stepOK(i0, j0, y0, i, j, y) : !levelOK(i0, j0, i, j, y)) continue;
      out.push({ i, j, y });
    }
    return out;
  }

  /** The cheap half of clear(): lattice columns along the line, no physics stepped. */
  function roughlyClear(a, b) {
    const d = Math.hypot(b.x - a.x, b.z - a.z);
    const n = Math.max(1, Math.ceil(d / (NAV_CELL / 2)));
    let y = a.y;
    for (let s = 1; s <= n; s++) {
      const t = s / n;
      const v = match(cell(a.x + (b.x - a.x) * t), cell(a.z + (b.z - a.z) * t), y);
      if (v === null) return false;
      y = v;
    }
    return true;
  }

  function walkable(a, b) {
    // coarse steps on level ground (a push zone is a capsule radius wide); the feet's fine SUBSTEP where height changes
    const d = Math.hypot(b.x - a.x, b.z - a.z);
    const n = Math.max(1, Math.ceil(d / COARSE));
    let y = a.y, px = a.x, pz = a.z;
    for (let s = 1; s <= n; s++) {
      const t = s / n, x = a.x + (b.x - a.x) * t, z = a.z + (b.z - a.z) * t;
      const st = probe.stand(x, y, z);
      if (st.push > NAV_NUDGE || Math.abs(st.ground - y) > NAV_STEP) return false;
      if (Math.abs(st.ground - y) > 0.01) {
        const m = Math.max(1, Math.ceil(Math.hypot(x - px, z - pz) / SUBSTEP));
        for (let k = 1; k <= m; k++) {
          const fine = probe.stand(px + (x - px) * k / m, y, pz + (z - pz) * k / m);
          if (fine.push > NAV_NUDGE || Math.abs(fine.ground - y) > NAV_STEP) return false;
          y = fine.ground;
        }
      } else y = st.ground;
      px = x; pz = z;
    }
    return Math.abs(y - b.y) < 0.05;
  }


  /** Standing nodes near (x, z) within `reach`, at heights chosen by `pick`, best first. A floor within a step of
   *  `ref` beats any nearer one that isn't (the top of a wall is never what was meant). */
  function standingNear(x, z, pick, ref, reach = 0.6) {
    const ci = cell(x), cj = cell(z), R = Math.ceil(reach / NAV_CELL);
    const found = [];
    for (let di = -R; di <= R; di++) for (let dj = -R; dj <= R; dj++) {
      const i = ci + di, j = cj + dj, d = Math.hypot(at(i) - x, at(j) - z);
      if (d > reach) continue;
      const y = pick(layers(i, j));
      if (y === null) continue;
      found.push({ i, j, y, d, score: d + (Math.abs(y - ref) > NAV_STEP ? 100 + Math.abs(y - ref) : 0) });
    }
    return found.sort((a, b) => a.score - b.score);
  }

  /** Every place to stand within reach of (x, z): each standing height of
   *  each column, with its distance from the point. */
  function spotsNear(x, z, reach = 0.6, inside) {
    const ci = cell(x), cj = cell(z), R = Math.ceil(reach / NAV_CELL);
    const out = [];
    for (let di = -R; di <= R; di++) for (let dj = -R; dj <= R; dj++) {
      const i = ci + di, j = cj + dj, d = Math.hypot(at(i) - x, at(j) - z);
      if (d > reach || (inside && !inside(at(i), at(j)))) continue;
      const ls = layers(i, j);
      ls.forEach((y, k) => out.push({ i, j, y, d, score: 0, lowest: k === ls.length - 1 }));
    }
    return out;
  }

  /** Route from a standing body to (to.x, to.z), arriving on the floor the walk means:
   *   - `to.y`: the standing height nearest it, at most a step (or `to.above`) above and `to.below` beneath; a
   *     sealed-off upper room is a refusal, not the room below;
   *   - `to.inside`: only spots inside the region count;
   *   - otherwise the body's own storey if the destination has one, else the lowest floor there, else any
   *     reachable spot at OTHER_FLOOR_COST.
   *  Every such spot is a goal; cost counts distance from the asked point twice, so a point inside a wall is
   *  reached on the body's side, not round by the door. */
  function route(from, to) {
    budget = NAV_MAX_PROBES;
    try { return routeIn(from, to); }
    catch (err) {
      if (err !== OVER_BUDGET) throw err;
      return { refusal: `too far to plan through what is placed in one go (${Math.hypot(to.x - from.x, to.z - from.z).toFixed(0)}m) — walk part of the way first` };
    } finally { budget = Infinity; }
  }

  function routeIn(from, to) {
    const start = standingNear(from.x, from.z, (ls) => nearestOf(ls, from.y, NAV_STEP), from.y)[0];
    if (!start) return { refusal: `nowhere to stand within 0.6m of where the body is (${from.x.toFixed(2)}, ${from.y.toFixed(2)}, ${from.z.toFixed(2)})` };
    const want = to.y != null && Number.isFinite(to.y) ? to.y : null;
    // the destination itself when its own lattice cell stands (arriving there
    // IS arriving at the point asked for), else the spot
    const exactAt = new Map();
    const exactOf = (g) => {
      if (Math.abs(to.x - at(g.i)) > NAV_CELL / 2 || Math.abs(to.z - at(g.j)) > NAV_CELL / 2) return false;
      // its cell standing doesn't prove the point does (a point just inside a box)
      let ok = exactAt.get(g.y);
      if (ok === undefined) {
        const st = probe.stand(to.x, g.y, to.z);
        ok = st.push < NAV_NUDGE && Math.abs(st.ground - g.y) < 0.05
          && walkable({ x: at(g.i), y: g.y, z: at(g.j) }, { x: to.x, y: g.y, z: to.z });
        exactAt.set(g.y, ok);
      }
      return ok;
    };
    const spots = spotsNear(to.x, to.z, to.reach ?? 0.6, to.inside);
    const sameStorey = spots.some((g) => Math.abs(g.y - from.y) <= NAV_STEP);
    // the floor y picks: over ALL spots near the point (not per column), the height CLOSEST to y, at most a step
    // above it. Closest, not highest: a footstool beside a named spot is not that spot.
    let floorY = -Infinity;
    if (want != null) for (const g of spots) {
      if (g.y > want + (to.above ?? NAV_STEP) || (to.below != null && g.y < want - to.below)) continue;
      const better = Math.abs(g.y - want) < Math.abs(floorY - want) - 1e-6
        || (Math.abs(Math.abs(g.y - want) - Math.abs(floorY - want)) <= 1e-6 && g.y > floorY);
      if (better) floorY = g.y;
    }
    const preferred = (g) => want != null ? Math.abs(g.y - floorY) < 0.05
      : sameStorey ? Math.abs(g.y - from.y) <= NAV_STEP : g.lowest;
    const goals = spots
      .filter((g) => want == null || preferred(g))
      .map((g) => ({ ...g, score: 2 * (exactOf(g) ? 0 : g.d) + (preferred(g) ? 0 : OTHER_FLOOR_COST) }))
      .sort((a, b) => a.score - b.score);
    const goal = goals[0];
    if (!goal) {
      const where = to.inside ? `anywhere in it` : `within ${(to.reach ?? 0.6).toFixed(1)}m of (${to.x.toFixed(2)}, ${to.z.toFixed(2)})`;
      const height = want == null ? "" : to.below != null ? ` on its floor (${want.toFixed(2)}m)` : ` at or below ${(want + (to.above ?? NAV_STEP)).toFixed(2)}m`;
      return { refusal: `nowhere to stand ${where}${height}: ${to.inside ? "no floor there, or none with room for a body" : "it is inside something solid, or closer to a wall than a body fits"}` };
    }
    const startP = { x: from.x, y: start.y, z: from.z };
    const outOf = (g) => exactOf(g) ? { x: to.x, y: g.y, z: to.z } : { x: at(g.i), y: g.y, z: at(g.j) };
    if (clear(startP, outOf(goal))) return { points: [outOf(goal)], snapped: !exactOf(goal) };

    // A* over (column, height). Bounded to the walk's own box plus NAV_PAD.
    const lo = { i: Math.floor((Math.min(from.x, to.x) - NAV_PAD) / NAV_CELL), j: Math.floor((Math.min(from.z, to.z) - NAV_PAD) / NAV_CELL) };
    const hi = { i: Math.ceil((Math.max(from.x, to.x) + NAV_PAD) / NAV_CELL), j: Math.ceil((Math.max(from.z, to.z) + NAV_PAD) / NAV_CELL) };
    /** @typedef {{ i: number, j: number, y: number, g: number, f: number, parent: Node | null, done?: Spot }} Node */
    const key = (i, j, y) => `${i},${j},${Math.round(y * 100)}`;
    const goalAt = new Map(goals.map((g) => [key(g.i, g.j, g.y), g]));
    const h = (i, j, y) => {
      let m = Infinity;
      for (const g of goals) m = Math.min(m, Math.hypot((g.i - i) * NAV_CELL, (g.j - j) * NAV_CELL, g.y - y));
      return m;
    };
    const heap = [];
    const push = (n) => {
      heap.push(n);
      for (let c = heap.length - 1; c > 0;) { const p = (c - 1) >> 1; if (heap[p].f <= heap[c].f) break; [heap[p], heap[c]] = [heap[c], heap[p]]; c = p; }
    };
    const pop = () => {
      const top = heap[0], last = heap.pop();
      if (heap.length) {
        heap[0] = last;
        for (let p = 0; ;) {
          const l = 2 * p + 1, r = l + 1; let m = p;
          if (l < heap.length && heap[l].f < heap[m].f) m = l;
          if (r < heap.length && heap[r].f < heap[m].f) m = r;
          if (m === p) break; [heap[p], heap[m]] = [heap[m], heap[p]]; p = m;
        }
      }
      return top;
    };
    const best = new Map();
    const closed = new Set();
    push({ i: start.i, j: start.j, y: start.y, g: 0, f: h(start.i, start.j, start.y), parent: null });
    best.set(key(start.i, start.j, start.y), 0);
    let reached = null, expansions = 0;
    while (heap.length) {
      const n = pop();
      if (n.done) { reached = n; break; }            // a goal, its distance from the point asked for paid
      const k = key(n.i, n.j, n.y);
      if (closed.has(k)) continue;
      closed.add(k);
      const at = goalAt.get(k);
      if (at) push({ ...n, g: n.g + at.score, f: n.g + at.score, done: at });
      if (++expansions > NAV_MAX_EXPANSIONS) {
        return { refusal: `gave up looking for a way to (${to.x.toFixed(2)}, ${to.z.toFixed(2)}) after ${NAV_MAX_EXPANSIONS} steps of search — walk part of the way first` };
      }
      for (const { i, j, y } of moves(n.i, n.j, n.y)) {
        if (i < lo.i || i > hi.i || j < lo.j || j > hi.j) continue;
        const g = n.g + Math.hypot((i - n.i) * NAV_CELL, (j - n.j) * NAV_CELL, y - n.y);
        const kk = key(i, j, y);
        if (g >= (best.get(kk) ?? Infinity)) continue;
        best.set(kk, g);
        push({ i, j, y, g, f: g + h(i, j, y), parent: n });
      }
    }
    if (!reached) {
      const w = (hi.i - lo.i) * NAV_CELL, d = (hi.j - lo.j) * NAV_CELL;
      return { refusal: `no walkable way to (${to.x.toFixed(2)}, ${to.z.toFixed(2)}) at ${goal.y.toFixed(2)}m from here ` +
        `within ${w.toFixed(0)}×${d.toFixed(0)}m around the walk — it may be sealed off, or reached only by a climb or drop of more than ${NAV_STEP}m` };
    }
    const path = [];
    // from the goal itself (the finished node stands on it), so the last
    // turn the search made survives when the goal is replaced below
    for (let n = reached; n; n = n.parent) path.push({ x: at(n.i), y: n.y, z: at(n.j) });
    path.reverse();
    if (path.length < 2) path.push(path[0]);       // start and goal share a cell
    path[0] = startP;
    path[path.length - 1] = outOf(reached.done);
    // string-pull: keep only the corners the straight walk cannot cut
    const out = [];
    let anchor = 0;
    while (anchor < path.length - 1) {
      let k = path.length - 1;
      while (k > anchor + 1 && !clear(path[anchor], path[k])) k--;
      out.push(path[k]);
      anchor = k;
    }
    return { points: out, snapped: !exactOf(reached.done) };
  }

  return { route, layers, clear, moves, match, stepOK, at, cell };
}
/** @typedef {{ i: number, j: number, y: number, d: number, score: number, lowest?: boolean }} Spot */
/** What arriving on a floor other than the one the walk means costs, in
 *  metres of walking: the right floor wins unless it is out of reach. */
const OTHER_FLOOR_COST = 10;

function nearestOf(ls, y, within) {
  let best = null;
  for (const v of ls) if (Math.abs(v - y) <= within && (best === null || Math.abs(v - y) < Math.abs(best - y))) best = v;
  return best;
}
