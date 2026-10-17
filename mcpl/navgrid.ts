// navgrid — routes for a walking body through placed models, found by asking
// the same collision code that will carry the walk out.
//
// A body's feet (agent.ts stepFeet, client/lib/controller.js) are moved by
// colliders.resolveColliders: it stands where that function lets it stand,
// steps up at most STEP, and is pushed off anything solid within its radius
// of its hips. So the planner asks the same two questions of the same code,
// column by column on a fine lattice, and never holds an opinion of its own
// about what is walkable:
//
//   - which heights in this column can a body STAND at? Every up-facing
//     surface (colliders.surfaceUnder, repeated downward) where
//     resolveColliders, asked at that height, neither pushes the capsule nor
//     answers a different floor (the lattice sits a little off round
//     coordinates, see NAV_OFF). Stacked storeys are simply several heights
//     in one column; a wall's own column, and every column within a capsule
//     radius of it, has none at that height.
//   - can a body walk from one column to the next? Only if the next one
//     offers a standing height within STEP of this one — up a stair tread,
//     not up a balcony, and not off one either.
//
// A* over (column, height), then string-pulled: a waypoint is dropped
// whenever the body could walk straight past it — checked by stepping the
// same resolveColliders along the line the way the feet will, unpushed and
// never climbing or dropping more than a step. On open ground that leaves the
// one leg walk_to always walked.
//
// Pure: everything about the world arrives through NavProbe (mcpl/physics.ts
// navProbe binds it to the live colliders), so a test can hand it anything.
// A grid caches what it learns about columns; it stays true until a collider
// changes, so a caller keeps one per collider generation (physics.ts
// collidersGeneration) and plans every walk in between against it.

/** Lattice spacing. Under the capsule radius (0.32), so a wall cannot fall
 *  between two neighbouring standing columns: both would be within reach of it. */
export const NAV_CELL = 0.2;
/** The lattice sits this far off the round-metre grid. Authored walls put
 *  their faces on round coordinates, and a lattice point exactly ON a face is
 *  the one place resolveColliders cannot push from (the push has no
 *  direction), so it would read as standing room inside the wall. */
export const NAV_OFF = 0.0131;
const at = (i: number) => i * NAV_CELL + NAV_OFF;
const cell = (x: number) => Math.round((x - NAV_OFF) / NAV_CELL);
/** Most a walk climbs or drops between neighbouring columns — the feet's own
 *  step-up (colliders.js STEP; resolveColliders caps it at 0.3 × tall = 0.57
 *  for a standing body). Drops are held to the same bound: a route never
 *  steps off a balcony. */
export const NAV_STEP = 0.55;
/** A push smaller than this is a nudge, not a wall: a body at the edge of
 *  something's reach (a balustrade beside a stair, a chair at a table) is
 *  shifted a centimetre or two and walks on. Routed walks arrive at their
 *  waypoints within it (agent.ts), since a waypoint may sit in such a place. */
export const NAV_NUDGE = 0.05;
/** How far around the walk's own box the search may wander for a way round. */
export const NAV_PAD = 8;
/** Expansions before the search gives up — bounds the time a walk can block
 *  the process (every agent in it shares one event loop). */
export const NAV_MAX_EXPANSIONS = 40_000;

export type NavProbe = {
  /** height of the topmost surface at or below maxY at (x, z), terrain if none */
  surfaceUnder(x: number, z: number, maxY: number): number;
  /** a standing body's answer at (x, y, z): the ground it finds, and how far it is pushed sideways */
  stand(x: number, y: number, z: number): { ground: number; push: number };
};
export type NavPoint = { x: number; y: number; z: number };
/** Where a route ends: see route(). */
export type NavTarget = { x: number; z: number; y?: number; reach?: number; above?: number; below?: number;
  inside?: (x: number, z: number) => boolean };
export type NavResult = { points: NavPoint[]; snapped: boolean } | { refusal: string };

/** Longest horizontal move between two collision checks — for the feet
 *  (agent.ts) and for the planner stepping a line the way they will. Browser
 *  scale: a person at 60fps moves 2.6cm a frame walking, 6.7cm running, and
 *  whether a body gets past an edge in its hip band can depend on how far it
 *  moves between checks; a coarser agent step would get through where a
 *  person is held. */
export const NAV_SUBSTEP = 0.03;
const SUBSTEP = NAV_SUBSTEP;
/** Planner step over level ground (see walkable). */
const COARSE = 0.1;
const DIRS: [number, number][] = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];

/** Probes one plan may make — line checks and column reads included, not
 *  just A* expansions — so no destination, however far, can hold the event
 *  loop. Past it the plan is refused. */
export const NAV_MAX_PROBES = 200_000;
/** Columns a grid remembers before starting over (it is only a cache). */
const NAV_MAX_COLUMNS = 300_000;
const OVER_BUDGET = new Error("navgrid: over budget");

export function makeNavGrid(raw: NavProbe) {
  let budget = Infinity;
  const probe: NavProbe = {
    surfaceUnder: (x, z, m) => { if (--budget < 0) throw OVER_BUDGET; return raw.surfaceUnder(x, z, m); },
    stand: (x, y, z) => { if (--budget < 0) throw OVER_BUDGET; return raw.stand(x, y, z); },
  };
  const cols = new Map<string, number[]>();

  /** Standing heights in lattice column (i, j), highest first. */
  function layers(i: number, j: number): number[] {
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
      // A surface the floor probe overrules (a slab's underside answers with
      // the slab's top) is that other surface's height, found again: dedupe.
      if (s.push < NAV_NUDGE && s.ground >= y - 0.01 && !out.some((v) => Math.abs(v - s.ground) < 0.05)) out.push(s.ground);
      maxY = y - 0.02;
    }
    out.sort((a, b) => b - a);
    if (cols.size >= NAV_MAX_COLUMNS) { cols.clear(); steps.clear(); level.clear(); }
    cols.set(key, out);
    return out;
  }

  /** The standing height in a column closest to y and within STEP of it. */
  function match(i: number, j: number, y: number, within = NAV_STEP): number | null {
    let best: number | null = null;
    for (const v of layers(i, j)) if (Math.abs(v - y) <= within && (best === null || Math.abs(v - y) < Math.abs(best - y))) best = v;
    return best;
  }

  /** Can a body walk the straight line a→b? Stepped the way the feet step
   *  it (agent.ts stepFeet): at each substep resolveColliders must not push
   *  the body, and the ground it answers must be within a step of the last —
   *  up a tread, not up a ledge, and not off one. Arrives at b's height. */
  function clear(a: NavPoint, b: NavPoint): boolean {
    return roughlyClear(a, b) && walkable(a, b);
  }

  const steps = new Map<string, boolean>();
  const level = new Map<string, boolean>();
  /** A level move still needs floor between its two columns: two slabs at
   *  one height with a gap between them are two places to stand, not a
   *  path. The midpoint must hold the body up, at that height, unpushed. */
  function levelOK(i0: number, j0: number, i1: number, j1: number, y: number): boolean {
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
  function stepOK(i0: number, j0: number, y0: number, i1: number, j1: number, y1: number): boolean {
    const k = `${i0},${j0},${Math.round(y0 * 100)}>${i1},${j1},${Math.round(y1 * 100)}`;
    let ok = steps.get(k);
    if (ok === undefined) steps.set(k, ok = walkable({ x: at(i0), y: y0, z: at(j0) }, { x: at(i1), y: y1, z: at(j1) }));
    return ok;
  }

  /** The moves a body can make from column (i0, j0) at height y0: to each of
   *  the eight neighbours that offers a standing height within a step, never
   *  cutting a corner diagonally (both sides it passes must stand too), and —
   *  where the height changes — stepped the way the feet will step it.
   *  Between two standing columns at one height nothing can push (a wall
   *  between them would be within reach of both); a change of height can: a
   *  floor edge in the hip band of a body on the tread below. The search and
   *  the building check (server/buildcheck.ts) both move by exactly this. */
  function moves(i0: number, j0: number, y0: number): { i: number; j: number; y: number }[] {
    const out: { i: number; j: number; y: number }[] = [];
    for (const [di, dj] of DIRS) {
      const i = i0 + di, j = j0 + dj;
      const y = match(i, j, y0);
      if (y === null) continue;
      if (di && dj && (match(i0 + di, j0, y0) === null || match(i0, j0 + dj, y0) === null)) continue;
      // between two standing columns at one height nothing can push (a wall
      // between them would be within reach of both) but the floor can end
      // between them; a change of height can push — a floor edge in the hip
      // band of a body on the tread below — so those moves are stepped the
      // way the feet will step them
      if (Math.abs(y - y0) > 0.01 ? !stepOK(i0, j0, y0, i, j, y) : !levelOK(i0, j0, i, j, y)) continue;
      out.push({ i, j, y });
    }
    return out;
  }

  /** The cheap half: along the line, the nearest lattice column (already
   *  known, usually) offers a standing height within a step of the last.
   *  Rejects most hopeless shortcuts without stepping any physics. */
  function roughlyClear(a: NavPoint, b: NavPoint): boolean {
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

  function walkable(a: NavPoint, b: NavPoint): boolean {
    // Coarse steps where the ground is level — a push zone is a capsule
    // radius wide, a coarse step cannot miss one — and the feet's own fine
    // steps across any span where the height changes, which is where the
    // step size decides whether a body gets past an edge in its hip band.
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


  /** The standing node nearest (x, z) at a height chosen by `pick`, searching
   *  outward up to `reach` metres — a body pressed to a wall, or a goal a
   *  hand's width inside one, still has somewhere to stand. A floor within a
   *  step of `ref` beats any nearer one that is not (the top of the wall a
   *  goal sits in is closer than the floor beside it, and never what was meant). */
  function standingNear(x: number, z: number, pick: (ls: number[]) => number | null, ref: number, reach = 0.6) {
    const ci = cell(x), cj = cell(z), R = Math.ceil(reach / NAV_CELL);
    const found: Spot[] = [];
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
  function spotsNear(x: number, z: number, reach = 0.6, inside?: (x: number, z: number) => boolean): Spot[] {
    const ci = cell(x), cj = cell(z), R = Math.ceil(reach / NAV_CELL);
    const out: Spot[] = [];
    for (let di = -R; di <= R; di++) for (let dj = -R; dj <= R; dj++) {
      const i = ci + di, j = cj + dj, d = Math.hypot(at(i) - x, at(j) - z);
      if (d > reach || (inside && !inside(at(i), at(j)))) continue;
      const ls = layers(i, j);
      ls.forEach((y, k) => out.push({ i, j, y, d, score: 0, lowest: k === ls.length - 1 }));
    }
    return out;
  }

  /** Route from a standing body to (to.x, to.z), arriving on the floor the
   *  walk means:
   *   - `to.y` given: the place to stand nearest that height, no more than a
   *     step above it (y means "on the floor at about this height": 0 is a
   *     ground floor raised 0.3m) — or no more than `to.above` above it, when the floor's
   *     height is known exactly (a named room's: a stair tread inside the
   *     room is not its floor) — and only that: asked for an upper room that
   *     is sealed off, the answer is a refusal, not the room below it
   *     (`to.below` bounds it from beneath the same way);
   *   - `to.inside`: only spots inside a region count (a named room, reached
   *     anywhere on its floor);
   *   - otherwise the body's own storey when the destination has a floor
   *     within a step of it (a walk across an upper floor stays on it), else
   *     the lowest place to stand there (the ground floor of another
   *     building, the ground under a balcony) — and failing those, wherever
   *     there IS a reachable place to stand, at a cost: the treads of a stair
   *     whose ground beneath is solid, say.
   *  Every such spot is a goal, and the search takes whichever it reaches
   *  most cheaply, counting distance from the point asked for twice over —
   *  a point inside a wall is reached on the side the body is already on,
   *  not round by the door. */
  function route(from: NavPoint, to: NavTarget): NavResult {
    budget = NAV_MAX_PROBES;
    try { return routeIn(from, to); }
    catch (err) {
      if (err !== OVER_BUDGET) throw err;
      return { refusal: `too far to plan through what is placed in one go (${Math.hypot(to.x - from.x, to.z - from.z).toFixed(0)}m) — walk part of the way first` };
    } finally { budget = Infinity; }
  }

  function routeIn(from: NavPoint, to: NavTarget): NavResult {
    const start = standingNear(from.x, from.z, (ls) => nearestOf(ls, from.y, NAV_STEP), from.y)[0];
    if (!start) return { refusal: `nowhere to stand within 0.6m of where the body is (${from.x.toFixed(2)}, ${from.y.toFixed(2)}, ${from.z.toFixed(2)})` };
    const want = to.y != null && Number.isFinite(to.y) ? to.y : null;
    // the destination itself when its own lattice cell stands (arriving there
    // IS arriving at the point asked for), else the spot
    const exactAt = new Map<number, boolean>();
    const exactOf = (g: Spot) => {
      if (Math.abs(to.x - at(g.i)) > NAV_CELL / 2 || Math.abs(to.z - at(g.j)) > NAV_CELL / 2) return false;
      // its cell standing is no proof the point itself does — a point a
      // hand's width inside a box is beside a cell that stands
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
    // the floor y picks: of every place to stand near the point (not column
    // by column — a column the upper floor does not reach, a stool beside it
    // pushing, would offer the ground floor beneath as a match), the height
    // CLOSEST to y, no more than a step above it. Closest, not highest: a
    // footstool a step above a named spot on the floor is not that spot.
    let floorY = -Infinity;
    if (want != null) for (const g of spots) {
      if (g.y > want + (to.above ?? NAV_STEP) || (to.below != null && g.y < want - to.below)) continue;
      const better = Math.abs(g.y - want) < Math.abs(floorY - want) - 1e-6
        || (Math.abs(Math.abs(g.y - want) - Math.abs(floorY - want)) <= 1e-6 && g.y > floorY);
      if (better) floorY = g.y;
    }
    const preferred = (g: Spot) => want != null ? Math.abs(g.y - floorY) < 0.05
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
    const outOf = (g: Spot): NavPoint => exactOf(g) ? { x: to.x, y: g.y, z: to.z } : { x: at(g.i), y: g.y, z: at(g.j) };
    if (clear(startP, outOf(goal))) return { points: [outOf(goal)], snapped: !exactOf(goal) };

    // A* over (column, height). Bounded to the walk's own box plus NAV_PAD.
    const lo = { i: Math.floor((Math.min(from.x, to.x) - NAV_PAD) / NAV_CELL), j: Math.floor((Math.min(from.z, to.z) - NAV_PAD) / NAV_CELL) };
    const hi = { i: Math.ceil((Math.max(from.x, to.x) + NAV_PAD) / NAV_CELL), j: Math.ceil((Math.max(from.z, to.z) + NAV_PAD) / NAV_CELL) };
    type Node = { i: number; j: number; y: number; g: number; f: number; parent: Node | null; done?: Spot };
    const key = (i: number, j: number, y: number) => `${i},${j},${Math.round(y * 100)}`;
    const goalAt = new Map(goals.map((g) => [key(g.i, g.j, g.y), g]));
    const h = (i: number, j: number, y: number) => {
      let m = Infinity;
      for (const g of goals) m = Math.min(m, Math.hypot((g.i - i) * NAV_CELL, (g.j - j) * NAV_CELL, g.y - y));
      return m;
    };
    const heap: Node[] = [];
    const push = (n: Node) => {
      heap.push(n);
      for (let c = heap.length - 1; c > 0;) { const p = (c - 1) >> 1; if (heap[p].f <= heap[c].f) break; [heap[p], heap[c]] = [heap[c], heap[p]]; c = p; }
    };
    const pop = (): Node => {
      const top = heap[0], last = heap.pop()!;
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
    const best = new Map<string, number>();
    const closed = new Set<string>();
    push({ i: start.i, j: start.j, y: start.y, g: 0, f: h(start.i, start.j, start.y), parent: null });
    best.set(key(start.i, start.j, start.y), 0);
    let reached: Node | null = null, expansions = 0;
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
    const path: NavPoint[] = [];
    // from the goal itself (the finished node stands on it), so the last
    // turn the search made survives when the goal is replaced below
    for (let n: Node | null = reached; n; n = n.parent) path.push({ x: at(n.i), y: n.y, z: at(n.j) });
    path.reverse();
    if (path.length < 2) path.push(path[0]);       // start and goal share a cell
    path[0] = startP;
    path[path.length - 1] = outOf(reached.done!);
    // string-pull: keep only the corners the straight walk cannot cut
    const out: NavPoint[] = [];
    let anchor = 0;
    while (anchor < path.length - 1) {
      let k = path.length - 1;
      while (k > anchor + 1 && !clear(path[anchor], path[k])) k--;
      out.push(path[k]);
      anchor = k;
    }
    return { points: out, snapped: !exactOf(reached.done!) };
  }

  return { route, layers, clear, moves, match, stepOK, at, cell };
}

type Spot = { i: number; j: number; y: number; d: number; score: number; lowest?: boolean };
/** What arriving on a floor other than the one the walk means costs, in
 *  metres of walking: the right floor wins unless it is out of reach. */
const OTHER_FLOOR_COST = 10;

function nearestOf(ls: number[], y: number, within: number): number | null {
  let best: number | null = null;
  for (const v of ls) if (Math.abs(v - y) <= within && (best === null || Math.abs(v - y) < Math.abs(best - y))) best = v;
  return best;
}
