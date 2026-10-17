// buildcheck — what a model will be like to walk into, measured before anyone
// spawns it. Advisory: nothing here refuses an upload.
//
// The model is fitted exactly as a spawn of it would be (client/lib/colliders.js)
// and explored with the walking body's own rules (mcpl/navgrid.ts: where a
// capsule 0.32m × 1.9m can stand, and every move it can make), on a lattice
// over its footprint and a margin of ground around it. From that:
//
//   - whether it is walk-in at all (a small model is one solid box);
//   - its floors, and how much of each can be reached from the ground outside;
//   - for every covered area that can't be, the likely reason: a passage
//     narrower than a body (it IS reachable for a slimmer one), a rise higher
//     than a step, a climb something at hip height stops (an overhanging
//     landing), or simply no way in;
//   - suggested rooms (covered floor, split where it narrows), doors (where
//     rooms meet the outside or each other) and stairs (what joins floors),
//     ready to name as places;
//   - the draw-call / triangle budget.
//
// Runs in its own process (server/buildcheck-run.ts): it loads the collider
// module, and a check can take seconds — neither belongs in the sequencer.

import { collisionTriangles } from "./geometry.ts";
import { glbPerfOfFile } from "./glbperf.ts";
import { rankOf, TIER_NAMES } from "../shared/perfrank.js";
import { decideSupportClass } from "../client/lib/supportclass.js";
import { makeNavGrid, NAV_CELL, NAV_STEP } from "../mcpl/navgrid.ts";
import { placesFromModel } from "../mcpl/places.ts";

export type Warning = { kind: string; message: string; at?: number[] };
export type CheckReport = {
  ok: boolean;
  walkIn: { roomScale: boolean; footprint: number; height: number };
  perf: { tris: number; draws: number; mats: number; rank: string } | null;
  levels: { y: number; area: number; reachable: number }[];
  suggested: {
    rooms: { id: string; min: number[]; max: number[]; area: number; level: number }[];
    doors: { id: string; at: number[]; between: string[]; width: number }[];
    stairs: { id: string; at: number[]; between: string[] }[];
    places: Record<string, unknown>;
  };
  warnings: Warning[];
  /** the scale it was checked at (1: the file's own size) */
  scale: number;
  ms: number;
};

const BODY_R = 0.32, THIN_R = 0.2, TALL = 1.9, MARGIN = 1.6;
/** Smallest unreachable floor area reported — smaller is a pocket behind furniture. */
const MIN_AREA = 2.5;
const NUDGE = 0.05;   // navgrid NAV_NUDGE
/** How far (cells) a room grows past its eroded core — the erosion's own depth. */
const GROW = 3;
const AREA = NAV_CELL * NAV_CELL;
/** The most lattice columns (footprint plus margin) a check walks: ~100m square. */
const MAX_COLUMNS = 250_000, MAX_SIDE = Math.sqrt(MAX_COLUMNS) * NAV_CELL, MAX_HEIGHT = 120;
/** A surface a body can't step onto with a floor this close beneath it is
 *  furniture (a table, a counter, a bunk), not a floor of the building. */
const FURNITURE_MAX = 1.2;
const r2 = (v: number) => Math.round(v * 100) / 100;

/** Check the GLB at `file`. `C` is client/lib/colliders.js, `THREE` its three
 *  (the caller loads them behind the core.js stub — see buildcheck-run.ts). */
export async function checkModel(file: string, C: any, THREE: any, { scale = 1 } = {}): Promise<CheckReport> {
  const t0 = performance.now();
  const warnings: Warning[] = [];
  const mesh = await collisionTriangles(new Uint8Array(await Bun.file(file).arrayBuffer()));
  if (!mesh) throw new Error("not a readable GLB with triangles");
  // at a placed thing's scale: the model is scaled, the body is not — every
  // measure below (doors, rises, floors, rooms) is in world metres. Suggested
  // places go back to the model's own frame, where a places component lives.
  if (scale !== 1) for (let k = 0; k < mesh.positions.length; k++) mesh.positions[k] *= scale;

  // ---- size: is it walk-in, as the world will fit it?
  const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  for (let k = 0; k < mesh.positions.length; k += 3) for (let a = 0; a < 3; a++) {
    mn[a] = Math.min(mn[a], mesh.positions[k + a]); mx[a] = Math.max(mx[a], mesh.positions[k + a]);
  }
  const w = mx[0] - mn[0], d = mx[2] - mn[2], h = mx[1] - mn[1];
  const roomScale = decideSupportClass({ w, d, h }).roomScale;
  // ---- performance
  const pf = glbPerfOfFile(file);
  const rank = pf ? rankOf(pf) : null;
  const perf = pf && rank ? { tris: pf.tris, draws: pf.draws, mats: pf.mats, rank: TIER_NAMES[rank.rank] } : null;
  if (pf && rank && rank.rank >= 3) warnings.push({ kind: "perf", message:
    `rendering cost is "${TIER_NAMES[rank.rank]}" (${pf.tris} triangles, ${pf.draws} draw calls, ${pf.mats} materials; set by ${rank.worst}) — `
    + `merge static parts into one mesh and share materials (colour can ride vertex colours) to bring draws under 12` });
  const walkIn = { roomScale, footprint: r2(w * d), height: r2(h) };
  // ---- too big to walk through cell by cell: the size and budget only
  const columns = ((w + 2 * MARGIN) / NAV_CELL + 1) * ((d + 2 * MARGIN) / NAV_CELL + 1);
  if (!(columns <= MAX_COLUMNS) || !(h <= MAX_HEIGHT)) {
    warnings.push({ kind: "too-large", message: `${w.toFixed(0)}×${d.toFixed(0)}m and ${h.toFixed(0)}m tall is more than the check walks through `
      + `(${Math.round(MAX_SIDE)}m square, ${MAX_HEIGHT}m tall): floors, rooms and reachability were not checked — the upload is fine either way` });
    return { ok: false, walkIn, perf, levels: [], suggested: { rooms: [], doors: [], stairs: [], places: {} }, warnings, scale, ms: Math.round(performance.now() - t0) };
  }
  if (!roomScale) warnings.push({ kind: "solid", message:
    `${w.toFixed(1)}×${d.toFixed(1)}m and ${h.toFixed(1)}m tall is under the walk-in size (a 16m² footprint and 2.2m height): `
    + `the world fits it as one solid box, so nobody can go inside. If it is meant to be entered, spawn it with collide: "exact". `
    + `(The rest of this report reads it as if it were.)` });

  // ---- fit it as a spawn would (forced exact: we read its inside either way)
  C.clearColliders();
  const geom = new THREE.BufferGeometry();
  geom.setAttribute("position", new THREE.BufferAttribute(mesh.positions, 3));
  geom.setIndex(new THREE.BufferAttribute(mesh.indices, 1));
  const root = new THREE.Group(); root.add(new THREE.Mesh(geom)); root.updateMatrixWorld(true);
  C.fitCollider("model", root, { collide: "exact", localFrame: true });
  const flat = () => 0;
  const probeAt = (r: number, tall = TALL) => {
    const v = new THREE.Vector3();
    return {
      surfaceUnder: (x: number, z: number, maxY: number) => C.surfaceUnder(x, z, flat, maxY).y,
      stand: (x: number, y: number, z: number) => {
        v.set(x, y, z);
        const ground = C.resolveColliders(v, flat, r, tall, tall >= TALL);
        return { ground, push: Math.hypot(v.x - x, v.z - z) };
      },
    };
  };
  const body = makeNavGrid(probeAt(BODY_R)), thin = makeNavGrid(probeAt(THIN_R));
  const lo = { i: body.cell(mn[0] - MARGIN), j: body.cell(mn[2] - MARGIN) };
  const hi = { i: body.cell(mx[0] + MARGIN), j: body.cell(mx[2] + MARGIN) };
  const inside = (i: number, j: number) => i >= lo.i && i <= hi.i && j >= lo.j && j <= hi.j;
  const key = (i: number, j: number, y: number) => `${i},${j},${Math.round(y * 100)}`;
  const xyz = (n: { i: number; j: number; y: number }) => [r2(body.at(n.i)), r2(n.y), r2(body.at(n.j))];

  // ---- every place a body can stand, and whether something is overhead
  // covered: something overhead (a roof, a ceiling, an upper floor);
  // roomy: at least a body's height of it — under the eaves, in an attic or
  // a crawlspace a body can't stand, so it is no floor of a room
  type N = { i: number; j: number; y: number; covered: boolean; roomy: boolean };
  const nodes = new Map<string, N>();
  const o = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0);
  for (let i = lo.i; i <= hi.i; i++) for (let j = lo.j; j <= hi.j; j++) {
    for (const y of body.layers(i, j)) {
      const head = C.raySegment(o.set(body.at(i), y + 0.1, body.at(j)), up, 40);
      nodes.set(key(i, j, y), { i, j, y, covered: head != null, roomy: head == null || head + 0.1 >= TALL - 0.05 });
    }
  }

  // ---- reachable from the ground outside (the lattice's own rim)
  const bfs = (grid: typeof body, seeds: N[], allow: (n: { i: number; j: number; y: number }) => boolean) => {
    const seen = new Map<string, string | null>();       // key -> parent key
    const q: { i: number; j: number; y: number }[] = [];
    for (const s of seeds) { const k = key(s.i, s.j, s.y); if (!seen.has(k)) { seen.set(k, null); q.push(s); } }
    for (let h = 0; h < q.length; h++) {
      const n = q[h];
      for (const m of grid.moves(n.i, n.j, n.y)) {
        if (!inside(m.i, m.j) || !allow(m)) continue;
        const k = key(m.i, m.j, m.y);
        if (!seen.has(k)) { seen.set(k, key(n.i, n.j, n.y)); q.push(m); }
      }
    }
    return seen;
  };
  const rim = [...nodes.values()].filter((n) => (n.i === lo.i || n.i === hi.i || n.j === lo.j || n.j === hi.j) && Math.abs(n.y) < 0.05);
  const reach = bfs(body, rim, () => true);

  // ---- floors: the covered heights with room to stand
  // a tabletop has open air and then a floor a metre or so beneath it; a body
  // can't step onto it, and it is no floor to reach. Looked for with front
  // faces only: from inside a solid plinth the first face down is its own
  // underside, seen from behind, and doesn't count.
  const bvh = [...C.nearColliders((mn[0] + mx[0]) / 2, (mn[2] + mx[2]) / 2, Math.max(w, d))].find(([id]: any) => id === "model")?.[1]?.exact?.bvh;
  const down = new THREE.Ray(new THREE.Vector3(), new THREE.Vector3(0, -1, 0)), up_ = new THREE.Ray(new THREE.Vector3(), new THREE.Vector3(0, 1, 0));
  const furniture = (n: N) => {
    if (!bvh) return false;
    down.origin.set(body.at(n.i), n.y - 0.1, body.at(n.j));
    const hit = bvh.raycastFirst(down, THREE.FrontSide);
    if (!hit) return false;
    const drop = n.y - hit.point.y;
    if (!(drop > NAV_STEP && drop <= FURNITURE_MAX)) return false;
    // ...and open air between: looking up from that floor, the first face is
    // the top's underside. A solid block (a stair's tread built down to the
    // floor) shows none — from inside it, its faces are all seen from behind.
    up_.origin.set(body.at(n.i), hit.point.y + 0.05, body.at(n.j));
    const under = bvh.raycastFirst(up_, THREE.FrontSide);
    return !!under && under.point.y < n.y + 0.01;
  };
  const covered = [...nodes.values()].filter((n) => n.covered && n.roomy && !furniture(n));
  // A floor is a height a lot of standing room shares; a stair's treads
  // each hold a little. So heights are binned (5cm), the bins holding a
  // square metre or more are floors (with neighbouring dense bins — a
  // floor that isn't quite level), and the sparse heights near a floor (a
  // threshold sill) join it. Chaining height to nearest height instead runs
  // a shallow stair's treads from one floor into the next.
  const BIN = 0.05, binOf = (y: number) => Math.round(y / BIN);
  const bins = new Map<number, N[]>();
  for (const n of covered) (bins.get(binOf(n.y)) ?? bins.set(binOf(n.y), []).get(binOf(n.y))!).push(n);
  const dense = [...bins.keys()].filter((b) => bins.get(b)!.length * AREA >= 1).sort((a, b) => a - b);
  const bands: { lo: number; hi: number }[] = [];
  for (const b of dense) {
    const last = bands[bands.length - 1];
    if (last && b - last.hi <= 2) last.hi = b; else bands.push({ lo: b, hi: b });
  }
  const levels = bands.map((B) => ({ nodes: covered.filter((n) => n.y >= (B.lo - 1.5) * BIN && n.y <= (B.hi + 1.5) * BIN) }));
  const floors = levels.filter((L) => L.nodes.length * AREA >= 2).map((L) => {
    // its height: the densest bin's, not an average dragged by a sill
    const best = [...new Set(L.nodes.map((n) => binOf(n.y)))].sort((a, b) => bins.get(b)!.length - bins.get(a)!.length)[0];
    const at = bins.get(best)!;
    return { y: r2(at.reduce((s, n) => s + n.y, 0) / at.length), nodes: L.nodes };
  });
  const levelOf = (n: { y: number }) => floors.findIndex((f) => Math.abs(f.y - n.y) < 0.15);
  if (!covered.length) warnings.push({ kind: "no-inside", message: "nowhere under a roof or ceiling has room to stand — it has no inside a body can be in" });

  // ---- what can't be reached, and why
  const stuck = covered.filter((n) => !reach.has(key(n.i, n.j, n.y)));
  // a pocket behind furniture is no room: only floor areas of a few square
  // metres are diagnosed
  const comps = components(stuck, body, key, inside).filter((cmp) => cmp.length * AREA >= MIN_AREA);
  const thinReach = comps.length ? bfs(thin, rim.filter((n) => thin.layers(n.i, n.j).some((y) => Math.abs(y - n.y) < 0.05)), () => true) : new Map();
  for (const comp of comps) {
    const area = comp.length * AREA;
    const c = centroid(comp, body);
    // per floor, not averaged: "20.3m² at 0.3m and 19.8m² at 3.3m"
    const byFloor = new Map<number, number>();
    for (const n of comp) { const lv = levelOf(n); if (lv >= 0) byFloor.set(lv, (byFloor.get(lv) ?? 0) + AREA); }
    const floorsText = [...byFloor].sort((x, y) => x[0] - y[0]).map(([lv, a]) => `${a.toFixed(1)}m² at ${floors[lv].y}m`);
    const where = floorsText.length
      ? `${floorsText.join(" and ")} of floor, around (${c[0]}, ${c[2]}),`
      : `${area.toFixed(1)}m² of floor at ${c[1]}m around (${c[0]}, ${c[2]})`;
    // a slimmer body gets in: a passage narrower than a body
    const thinHit = comp.find((n) => thinReach.has(key(n.i, n.j, n.y)));
    if (thinHit) {
      const path: string[] = [];
      for (let k: string | null | undefined = key(thinHit.i, thinHit.j, thinHit.y); k; k = thinReach.get(k)) path.push(k);
      // the narrow spot: walking the slim body's way in from outside, the
      // stretch a full body can't stand on just before it gets in
      const ps = path.map(parseKey).reverse();
      let narrow: typeof ps = [];
      for (const p of ps) {
        const k = key(p.i, p.j, p.y);
        if (nodes.has(k) && reach.has(k)) { narrow = []; continue; }   // still where a body can go
        if (!nodes.has(k)) { narrow.push(p); continue; }
        break;                                                         // inside
      }
      const at = narrow.length ? centroid(narrow, body) : c;
      warnings.push({ kind: "narrow", at, message: `${where} can only be reached through a passage narrower than a body, near (${at[0]}, ${at[2]}) at ${at[1]}m — `
        + `a body needs more than 0.64m clear (its 0.32m radius each side); 1m is comfortable` });
      continue;
    }
    // next to reachable floor: a climb that fails, or a rise too high
    // a failed climb is between neighbours; a rise too high may sit a few
    // cells from the nearest reachable ground (a body can't stand right
    // against the face of a ledge)
    let blocked: N | null = null, rise: { n: N; dy: number } | null = null;
    for (const n of comp) {
      for (let di = -3; di <= 3 && !blocked; di++) for (let dj = -3; dj <= 3; dj++) {
        if (!di && !dj) continue;
        const adjacent = Math.abs(di) <= 1 && Math.abs(dj) <= 1;
        for (const y of body.layers(n.i + di, n.j + dj)) {
          if (!reach.has(key(n.i + di, n.j + dj, y))) continue;
          const dy = Math.abs(y - n.y);
          if (adjacent && dy <= NAV_STEP && dy > 0.01 && !blocked) blocked = n;
          else if (dy > NAV_STEP && dy <= 1.2 && !rise) rise = { n, dy };
        }
      }
      if (blocked) break;
    }
    if (blocked) {
      const at = xyz(blocked);
      warnings.push({ kind: "climb", at, message: `${where} can't be reached: the climb onto it near (${at[0]}, ${at[2]}) is stopped by something at a climbing body's hip height — `
        + `most often the edge of an upper floor overhanging the top treads; start the floor where the last tread ends` });
    } else if (rise) {
      const at = xyz(rise.n);
      warnings.push({ kind: "rise", at, message: `${where} can't be reached: it sits ${rise.dy.toFixed(2)}m above the floor beside it near (${at[0]}, ${at[2]}), more than a body steps (0.55m) — add a step or a stair (at the top of a stair: start the floor where the last tread ends, rather than over it)` });
    } else {
      warnings.push({ kind: "sealed", at: c, message: `${where} can't be reached from outside — no opening leads to it` });
    }
  }

  // ---- suggested rooms: the space walls enclose on each floor
  // Furniture splits a floor's standing room (a table across the middle of a
  // room narrows it like a doorway) but not its walls, so rooms are read from
  // ROOM SPACE: columns under cover, with floor at this level (a stairwell
  // is a hole in it), and no WALL — something solid at 1.4–2.0m above the
  // floor, within a body's radius: above chair backs, tables and benches,
  // below hanging lamps and ceiling beams; walls, tall shelves and a door
  // standing open all cross it. (The probe: the collider code's own wall
  // band, for a 0.4m-tall body whose feet are 1.5m up.)
  const rooms: CheckReport["suggested"]["rooms"] = [];
  let roomSeq = 0;                                        // ids never reused, though rooms are dropped
  const roomOf = new Map<string, string>();               // standing node -> room
  const wallBand = probeAt(BODY_R, 0.4);
  floors.forEach((f, li) => {
    const space = new Map<string, { i: number; j: number }>();
    for (let i = lo.i; i <= hi.i; i++) for (let j = lo.j; j <= hi.j; j++) {
      const x = body.at(i), z = body.at(j);
      // a roof or ceiling over a standing body's head — looked for from the
      // head up, so the table or bench a column holds doesn't count as one
      if (C.raySegment(o.set(x, f.y + TALL, z), up, 40) == null) continue;   // open sky
      if (Math.abs(C.surfaceUnder(x, z, flat, f.y + 0.15).y - f.y) > 0.15) continue;   // no floor at this level here
      // ...nor another floor within head height over it: a raised floor laid
      // on a plinth is that floor's room, not the ground's
      if (floors.some((g) => g.y > f.y + 0.15 && g.y < f.y + TALL && Math.abs(C.surfaceUnder(x, z, flat, g.y + 0.15).y - g.y) <= 0.15)) continue;
      if (wallBand.stand(x, f.y + 1.5, z).push > NUDGE) continue;           // a wall
      space.set(`${i},${j}`, { i, j });
    }
    const dist = new Map<string, number>(), q: { i: number; j: number }[] = [];
    for (const c of space.values()) {
      if ([[1, 0], [-1, 0], [0, 1], [0, -1]].some(([a, b]) => !space.has(`${c.i + a},${c.j + b}`))) { dist.set(`${c.i},${c.j}`, 0); q.push(c); }
    }
    for (let h = 0; h < q.length; h++) {
      const c = q[h], dc = dist.get(`${c.i},${c.j}`)!;
      for (const [a, b] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const k = `${c.i + a},${c.j + b}`, m = space.get(k);
        if (m && !dist.has(k)) { dist.set(k, dc + 1); q.push(m); }
      }
    }
    // cores: two cells in from every edge — a doorway erodes away
    const flatComps = (cells: { i: number; j: number }[]) => components(cells.map((c) => ({ ...c, y: f.y })), body, key, inside, true);
    const label = new Map<string, string>(), front: { i: number; j: number }[] = [], grown = new Map<string, number>();
    const mine: string[] = [];
    for (const cmp of flatComps([...space.values()].filter((c) => (dist.get(`${c.i},${c.j}`) ?? 0) >= 2))) {
      if (cmp.length * AREA < 1) continue;
      const id = `room_${++roomSeq}`; mine.push(id);
      for (const c of cmp) { label.set(`${c.i},${c.j}`, id); grown.set(`${c.i},${c.j}`, 0); front.push(c); }
      rooms.push({ id, min: [], max: [], area: 0, level: li });
    }
    // grown back out by the margin the erosion took — not through a doorway
    for (let h = 0; h < front.length; h++) {
      const c = front[h], id = label.get(`${c.i},${c.j}`)!, g = grown.get(`${c.i},${c.j}`)!;
      if (g >= GROW) continue;
      for (const [a, b] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const k = `${c.i + a},${c.j + b}`, m = space.get(k);
        if (m && !label.has(k)) { label.set(k, id); grown.set(k, g + 1); front.push(m); }
      }
    }
    // space no core reached — a porch under deep eaves: too narrow to have
    // a middle, still a place of its own. A sliver along a wall is not.
    for (const cmp of flatComps([...space.values()].filter((c) => !label.has(`${c.i},${c.j}`)))) {
      if (cmp.length * AREA < 1.5 || cmp.filter((c) => (dist.get(`${c.i},${c.j}`) ?? 0) >= 1).length * AREA < 1) continue;
      const id = `room_${++roomSeq}`; mine.push(id);
      for (const c of cmp) label.set(`${c.i},${c.j}`, id);
      rooms.push({ id, min: [], max: [], area: 0, level: li });
    }
    // a room reaches in from the open sky: a porch a metre deep does, the
    // strip under the eaves along an outside wall does not
    const sky = new Map<string, number>(), sq: { i: number; j: number }[] = [];
    for (const c of space.values()) {
      if ([[1, 0], [-1, 0], [0, 1], [0, -1]].some(([a, b]) => C.raySegment(o.set(body.at(c.i + a), f.y + TALL, body.at(c.j + b)), up, 40) == null)) { sky.set(`${c.i},${c.j}`, 1); sq.push(c); }
    }
    for (let h = 0; h < sq.length; h++) {
      const c = sq[h], dc = sky.get(`${c.i},${c.j}`)!;
      for (const [a, b] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const k = `${c.i + a},${c.j + b}`, m = space.get(k);
        if (m && !sky.has(k)) { sky.set(k, dc + 1); sq.push(m); }
      }
    }
    for (const id of [...mine]) {
      const deep = [...label].some(([k, v]) => v === id && (sky.get(k) ?? Infinity) >= 3);
      if (deep) continue;
      for (const [k, v] of [...label]) if (v === id) label.delete(k);
      mine.splice(mine.indexOf(id), 1);
      rooms.splice(rooms.findIndex((r) => r.id === id), 1);
    }
    const top = floors[li + 1]?.y ?? r2(mx[1]);
    for (const n of f.nodes) { const id = label.get(`${n.i},${n.j}`); if (id) roomOf.set(key(n.i, n.j, n.y), id); }
    // standing room on this floor between labelled columns (beside furniture,
    // under a table's edge) belongs to the room it opens into
    // — a few cells at most, so it doesn't run out through the front door
    const spread = f.nodes.filter((n) => roomOf.has(key(n.i, n.j, n.y)));
    const onFloor = new Set(f.nodes.map((n) => key(n.i, n.j, n.y)));
    const steps = new Map(spread.map((n) => [key(n.i, n.j, n.y), 0]));
    for (let h = 0; h < spread.length; h++) {
      const n = spread[h], kn = key(n.i, n.j, n.y), id = roomOf.get(kn)!, st = steps.get(kn)!;
      if (st >= GROW) continue;
      for (const m of body.moves(n.i, n.j, n.y)) {
        const k = key(m.i, m.j, m.y);
        if (onFloor.has(k) && !roomOf.has(k)) { roomOf.set(k, id); steps.set(k, st + 1); spread.push(nodes.get(k)!); }
      }
    }
    for (const id of mine) {
      const room = rooms.find((r) => r.id === id)!;
      const cells = [...label].filter(([, v]) => v === id).map(([k]) => k.split(",").map(Number));
      const xs = cells.map(([i]) => body.at(i)), zs = cells.map(([, j]) => body.at(j));
      room.min = [r2(Math.min(...xs) - NAV_CELL / 2), f.y, r2(Math.min(...zs) - NAV_CELL / 2)];
      room.max = [r2(Math.max(...xs) + NAV_CELL / 2), r2(Math.min(top, f.y + 6)), r2(Math.max(...zs) + NAV_CELL / 2)];
      room.area = r2(f.nodes.filter((n) => roomOf.get(key(n.i, n.j, n.y)) === id && reach.has(key(n.i, n.j, n.y))).length * AREA);
    }
  });
  // a room nobody can stand in, reachably, is no room to name
  for (let k = rooms.length - 1; k >= 0; k--) if (rooms[k].area < 0.5) rooms.splice(k, 1);

  // ---- suggested doors and stairs: where rooms meet the outside, each other, or other floors
  const doors: CheckReport["suggested"]["doors"] = [], stairs: CheckReport["suggested"]["stairs"] = [];
  // a stair: covered standing room BETWEEN floors — not the ground under the
  // eaves, which lies below the lowest of them
  const isStair = (n: N) => n.covered && levelOf(n) < 0 && n.y > (floors[0]?.y ?? 0) + 0.15;
  // outside: open sky, and unroomed ground connected to it (the strip under
  // the eaves, the step under a balcony) — not a pocket beside a chair
  const outside = new Set<string>(), oq: N[] = [];
  for (const [k, n] of nodes) if (!n.covered && reach.has(k)) { outside.add(k); oq.push(n); }
  for (let h = 0; h < oq.length; h++) {
    const n = oq[h];
    for (const m of body.moves(n.i, n.j, n.y)) {
      const k = key(m.i, m.j, m.y), mn3 = nodes.get(k);
      if (!mn3 || outside.has(k) || roomOf.has(k) || !reach.has(k) || isStair(mn3)) continue;
      outside.add(k); oq.push(mn3);
    }
  }
  const crossings = new Map<string, N[]>();
  for (const [k, id] of roomOf) {
    const n = nodes.get(k)!;
    for (const m of body.moves(n.i, n.j, n.y)) {
      const mk = key(m.i, m.j, m.y), other = roomOf.get(mk), mn2 = nodes.get(mk);
      if (!mn2 || !reach.has(mk)) continue;
      const to = other ?? (outside.has(mk) ? "outside" : null);
      if (!to || to === id || Math.abs(m.y - n.y) > NAV_STEP) continue;    // a threshold step still joins
      const pair = [id, to].sort().join("|");
      (crossings.get(pair) ?? crossings.set(pair, []).get(pair)!).push(n);
    }
  }
  for (const [pair, ns] of crossings) {
    for (const cmp of components(ns, body, key, inside, true, 2)) {
      const at = centroid(cmp, body), cols = new Set(cmp.map((n) => `${n.i},${n.j}`)).size;
      doors.push({ id: `door_${doors.length + 1}`, at, between: pair.split("|"), width: r2(Math.min(4, cols * NAV_CELL / 2 + 2 * BODY_R)) });
    }
  }
  const between = covered.filter((n) => reach.has(key(n.i, n.j, n.y)) && isStair(n));
  for (const cmp of components(between, body, key, inside)) {
    const ends = new Map<number, string>();               // floor -> the room (or floor) reached there
    for (const n of cmp) for (const m of body.moves(n.i, n.j, n.y)) {
      const lv = levelOf(m);
      if (lv < 0) continue;
      const r = roomOf.get(key(m.i, m.j, m.y));
      if (r || !ends.has(lv)) ends.set(lv, r ?? `floor at ${floors[lv].y}m`);
    }
    if (ends.size >= 2) stairs.push({ id: `stair_${stairs.length + 1}`, at: centroid(cmp, body), between: [...ends.values()] });
  }

  // ---- the model's own description, held to the same measure
  const declared = placesFromModel(mesh.building);
  for (const p of declared.values()) {
    if (p.kind !== "region") continue;
    const any = [...reach.keys()].some((k) => {
      const n = nodes.get(k); if (!n) return false;
      const x = body.at(n.i), z = body.at(n.j);
      return x >= p.min![0] * scale && x <= p.max![0] * scale && z >= p.min![2] * scale && z <= p.max![2] * scale && Math.abs(n.y - p.min![1] * scale) < 0.15;
    });
    if (!any) warnings.push({ kind: "declared", message: `the model declares a room "${p.name}" at ${r2(p.min![1] * scale)}m, but nowhere in it at that height can a body reach from outside${scale !== 1 ? ` (at scale ${scale})` : ""}` });
  }

  const places: Record<string, unknown> = {};
  const local = (v: number[]) => v.map((x) => Math.round(x / scale * 1000) / 1000);
  for (const r of rooms) places[r.id] = { min: local(r.min), max: local(r.max) };
  for (const dd of doors) places[dd.id] = { at: local(dd.at), kind: "door" };
  for (const s of stairs) places[s.id] = { at: local(s.at) };
  C.clearColliders();
  return {
    ok: warnings.length === 0,
    walkIn,
    perf,
    levels: floors.map((f) => ({ y: f.y, area: r2(f.nodes.length * AREA), reachable: r2(f.nodes.filter((n) => reach.has(key(n.i, n.j, n.y))).length * AREA) })),
    suggested: { rooms, doors, stairs, places },
    warnings,
    scale,
    ms: Math.round(performance.now() - t0),
  };
}

function parseKey(k: string) { const [i, j, y] = k.split(","); return { i: +i, j: +j, y: +y / 100 }; }

function centroid(ns: { i: number; j: number; y: number }[], g: { at: (i: number) => number }) {
  const s = ns.reduce((a, n) => [a[0] + g.at(n.i), a[1] + n.y, a[2] + g.at(n.j)], [0, 0, 0]);
  return s.map((v) => r2(v / ns.length));
}

/** Connected groups among `ns`: by the body's own moves, or (flat) by
 *  adjacency on one level, within `gap` cells. */
function components<T extends { i: number; j: number; y: number }>(ns: T[], g: any, key: (i: number, j: number, y: number) => string,
  inside: (i: number, j: number) => boolean, flat = false, gap = 1): T[][] {
  const pool = new Map(ns.map((n) => [key(n.i, n.j, n.y), n]));
  const byCol = new Map<string, T[]>();
  for (const n of ns) (byCol.get(`${n.i},${n.j}`) ?? byCol.set(`${n.i},${n.j}`, []).get(`${n.i},${n.j}`)!).push(n);
  const out: T[][] = [];
  const seen = new Set<string>();
  for (const [k0, n0] of pool) {
    if (seen.has(k0)) continue;
    const comp: T[] = [], q = [n0]; seen.add(k0);
    for (let h = 0; h < q.length; h++) {
      const n = q[h]; comp.push(n);
      const next = flat
        ? (() => { const r: T[] = []; for (let a = -gap; a <= gap; a++) for (let b = -gap; b <= gap; b++) for (const m of byCol.get(`${n.i + a},${n.j + b}`) ?? []) if (Math.abs(m.y - n.y) < 0.15) r.push(m); return r; })()
        : g.moves(n.i, n.j, n.y).filter((m: any) => inside(m.i, m.j)).map((m: any) => pool.get(key(m.i, m.j, m.y))).filter(Boolean);
      for (const m of next) { const k = key(m.i, m.j, m.y); if (!seen.has(k) && pool.has(k)) { seen.add(k); q.push(m); } }
    }
    out.push(comp);
  }
  return out;
}
