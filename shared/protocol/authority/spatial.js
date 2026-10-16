// shared/protocol/authority/spatial.js — the spatial index and the work budget (refactor C11, 2026-10-12; moved from
// authority.js's "the spatial index" section unchanged). A leaf over math, the catalogue and storage: the budget refuses
// through refuse.js, and the gate's enter() reads WORK_BUDGET/clockMs from here.
import { offChain } from "../simlayer.js";
import { CTX } from "./ctx.js";
import { refuse } from "./refuse.js";
import { LAB_CATALOGUE, geomE } from "./catalogue.js";
import { aabb, boxToObb, obbs, overlap, satCost, satDepth, surfacesOf } from "./math.js";
import { VOLATILE } from "./storage.js";
import { terrainParams, makeHeightField } from "../../terrainmath.js";
import { shapeParams, shapeReady, waterParams } from "../../terrainshape.js";
// The authority is synchronous and every world on a server shares its one thread, so no request may cost the world's size
// squared. Every hot path (support under a point, overlap warnings, a body's track, place's search, delete's set-down,
// what rests on a thing picked up) asks the index "what could touch this box?" instead of every entity.
//   Per thing: its world AABB, oriented boxes and surfaces, cached on its ENTITY OBJECT (a live world's states share every
//   entity a write didn't touch: server/livehost.ts applyShared), valid while its model entry and every ancestor's entity
//   object are the same ones. So a write re-measures only what it touched.
//   Per folded state: a 4 m grid over those boxes (huge things on a list of their own), built on the state's first query.
//   A state is never mutated once folded or previewed (admit's working copy is never queried), so neither is its index.
// Every answer lists candidates in the state's key order, so a first-hit or best-so-far loop over them picks exactly what
// the loop over Object.keys picked. The work budget (CTX.work, set per call by enter) bounds what one call may spend in these
// searches, counted in units of about 0.1 µs of this laptop's time (measured: a candidate scanned ≈ 1, an axis-aligned
// box test ≈ 1, a rotated one ≈ 80, a query ≈ 10): WORK_BUDGET.units ≈ 30 ms at rest, the same answer on any host. A
// clock backstop (WORK_BUDGET.ms from the call's start, read every 64 units) bounds a host that is far slower. Past
// either, a read or a solver is refused (too-costly) rather than holding every world's thread.
export const WORK_BUDGET = { units: 350000, ms: 150 };
const clockMs = () => globalThis.performance?.now?.() ?? Date.now();
const spend = (n, what = CTX.work.what ?? "this", fix = "ask about less at once: lint {id} checks one thing; place onto a smaller surface, or at a spot (at: [x, z])") => {
  if ((CTX.work.left -= n) < 0 || ((CTX.work.k += n) >= 64 && ((CTX.work.k = 0), clockMs() > CTX.work.until))) { CTX.work.left = -1; CTX.work.until = -Infinity;
    refuse("too-costly", `${what} would take more of the authority's time than one request may have (it's shared by every world on this server)`, fix); } };
const GEO = new WeakMap(); const SPATIAL = new WeakMap(); const CELL = 4, BIG = 64;
function geoOf(st, id) {
  const e = st.entities[id]; if (!e) return null;
  // what its world box reads: its model entry, and the transform and parent VALUES of it and each ancestor (a value is
  // replaced, never changed in place, so these identities say whether anything it depends on changed)
  const m = geomE(e); const chain = [e.c.transform, e.c.parent]; let p = e.c.parent?.to, n = 0;
  while (p && n++ <= 33 && st.entities[p]) { const x = st.entities[p]; chain.push(x, x.c.transform, x.c.parent); p = x.c.parent?.to; }
  const g = GEO.get(e);
  if (g && g.id === id && g.m === m && g.chain.length === chain.length && g.chain.every((x, i) => x === chain[i])) return g;
  const box = m ? aabb(st, id) : null; const ob = box ? obbs(st, id) : []; const surfs = box ? surfacesOf(st, id) : [];
  // each oriented box's own world AABB (a cheap reject before the 15-axis test), and the box the grid files it under
  // (h: its projected half-size on each world axis, summed as satDepth sums it, so hitsIx can reject on it exactly)
  const ext = ob.map((o) => { const h = [0, 1, 2].map((i) => o.ax.reduce((a, axv, j) => a + Math.abs(axv[i]) * o.h[j], 0)); return { h, min: o.c.map((v, i) => v - h[i]), max: o.c.map((v, i) => v + h[i]) }; });
  let q = null;
  if (box) { q = { min: box.min.slice(), max: box.max.slice() };
    for (const x of ext) for (let i = 0; i < 3; i++) { q.min[i] = Math.min(q.min[i], x.min[i]); q.max[i] = Math.max(q.max[i], x.max[i]); }
    for (const s of surfs) { q.min[0] = Math.min(q.min[0], s.min[0]); q.max[0] = Math.max(q.max[0], s.max[0]); q.min[2] = Math.min(q.min[2], s.min[1]); q.max[2] = Math.max(q.max[2], s.max[1]); q.max[1] = Math.max(q.max[1], s.y); } }
  const rec = { id, m, chain, box, obbs: ob, ext, surfs, q };
  GEO.set(e, rec); return rec;
}
const cellOf = (v) => Math.floor(v / CELL);
const cellKey = (i, k) => (i + 1e6) * 2e6 + (k + 1e6);
// the grid cells a record is filed under (null: a huge thing, on the `big` list)
const cellsOf = (g) => { if (g.cells !== undefined) return g.cells;
  const x0 = cellOf(g.q.min[0]), x1 = cellOf(g.q.max[0]), z0 = cellOf(g.q.min[2]), z1 = cellOf(g.q.max[2]);
  if ((x1 - x0 + 1) * (z1 - z0 + 1) > BIG || !Number.isFinite(x0 + x1 + z0 + z1)) return (g.cells = null);
  const out = []; for (let x = x0; x <= x1; x++) for (let z = z0; z <= z1; z++) out.push(cellKey(x, z)); return (g.cells = out); };
// The index a state's queries use. Kept incrementally: a state that shares nearly every entity with the one indexed last
// (the next state of the same world: a write, or a preview of one) is derived from it, re-filing only the things that
// changed, appeared or went (and everything riding on them); anything else is built whole. Both give the same index.
const LASTIX = new WeakMap(); // catalogue → the index built or derived last
// VOLATILE (the "indexed whole" mark): authority/storage.js, beside scratch which propagates it
function spatial(st) {
  const ver = CTX.cat.version ?? 0; let ix = SPATIAL.get(st);
  if (ix && ix.cat === CTX.cat && ix.ver === ver) return ix;
  if (VOLATILE.has(st.entities)) { ix = buildIx(st, ver); SPATIAL.set(st, ix); return ix; }
  const prev = LASTIX.get(CTX.cat);
  ix = (prev && prev.ver === ver && deriveIx(prev, st)) || buildIx(st, ver);
  SPATIAL.set(st, ix); LASTIX.set(CTX.cat, ix); return ix;
}
function fileIx(ix, id, g, cloned) {
  const cs = cellsOf(g); if (!cs) { ix.big.push(id); return; }
  for (const k of cs) { let a = ix.grid.get(k); if (!a) ix.grid.set(k, (a = [])); else if (cloned && !cloned.has(k)) { ix.grid.set(k, (a = a.slice())); } cloned?.add(k); a.push(id); }
}
function buildIx(st, ver) {
  const ix = { cat: CTX.cat, ver, ents: st.entities, order: new Map(), next: 0, rec: new Map(), grid: new Map(), big: [], kids: null, memo: new Map() };
  for (const id of Object.keys(st.entities)) { ix.order.set(id, ix.next++);
    if (offChain(st, id)) continue;   // switched off: nothing to stand on, bump into or overlap (componentspec disabled)
    const g = geoOf(st, id); if (!g?.q) continue; ix.rec.set(id, g); fileIx(ix, id, g, null); }
  return ix;
}
function deriveIx(prev, st) {
  const E = st.entities, P = prev.ents; if (E === P) return null;
  const keys = Object.keys(E); const changed = [];
  for (const id of keys) if (E[id] !== P[id]) { changed.push(id); if (changed.length > 256) return null; }
  const added = changed.filter((id) => !prev.order.has(id));
  if (added.some((id) => /^(0|[1-9]\d*)$/.test(id))) return null;   // an integer-like key sorts first, not last: build whole
  const removed = prev.order.size + added.length > keys.length ? [...prev.order.keys()].filter((id) => E[id] === undefined) : [];
  // what rides on a changed or removed thing moved with it (its world box comes from the chain): re-file it too
  const pk = kidsOfIx(prev, P); const touched = new Set([...changed, ...removed]); const todo = [...touched];
  if (added.length) { const nu = new Set(added); for (const id of keys) if (nu.has(E[id].c.parent?.to)) todo.push(id); }   // a link to a thing that just appeared
  while (todo.length) { const t = todo.pop(); touched.add(t); for (const k of pk.get(t) ?? []) if (!touched.has(k)) todo.push(k); if (touched.size > 2048) return null; }
  const ix = { cat: CTX.cat, ver: prev.ver, ents: E, order: prev.order, next: prev.next, rec: new Map(prev.rec), grid: new Map(prev.grid), big: prev.big, kids: prev.kids, memo: new Map() };
  if (added.length || removed.length) { ix.order = new Map(prev.order); for (const id of removed) ix.order.delete(id); for (const id of added) ix.order.set(id, ix.next++);
    let last = -1; for (const id of keys) { const o = ix.order.get(id); if (!(o > last)) return null; last = o; } }   // the key order is what Object.keys says, or build whole
  const cloned = new Set();
  for (const id of touched) { const old = prev.rec.get(id);
    if (old) { ix.rec.delete(id); const cs = cellsOf(old);
      if (cs) for (const k of cs) { const a = ix.grid.get(k); if (!a) continue; const b = a.filter((x) => x !== id); if (b.length) ix.grid.set(k, b); else ix.grid.delete(k); cloned.add(k); } } }
  ix.big = prev.big.filter((x) => !touched.has(x));
  for (const id of touched) { if (E[id] === undefined || offChain(st, id)) continue; const g = geoOf(st, id); if (!g?.q) continue; ix.rec.set(id, g); fileIx(ix, id, g, cloned); }
  // the children map is rebuilt (lazily) only when a parent link changed
  if (added.length || removed.length || changed.some((id) => P[id]?.c.parent?.to !== E[id]?.c.parent?.to)) ix.kids = null;
  return ix;
}
function kidsOfIx(ix, ents) {
  if (ix.kids) return ix.kids; const kids = new Map();
  for (const id of Object.keys(ents)) { const p = ents[id].c.parent?.to; if (p) { let a = kids.get(p); if (!a) kids.set(p, (a = [])); a.push(id); } }
  return (ix.kids = kids);
}
const kidsMap = (st) => kidsOfIx(spatial(st), st.entities);
/** For tests: does the index this state's queries use (built or derived) file exactly what a fresh build files? A list
 *  of differences, empty when it does. */
export function indexAudit(w) {
  const prevCat = CTX.cat; CTX.cat = w.catalogue ?? LAB_CATALOGUE;
  try { const st = w.state(); const ix = spatial(st); const fresh = buildIx(st, ix.ver); const out = [];
    const norm = (x) => ({ ids: [...x.rec.keys()].sort().join(), grid: [...x.grid.entries()].map(([k, a]) => `${k}:${[...a].sort().join()}`).sort().join(";"), big: [...x.big].sort().join(),
      order: Object.keys(st.entities).filter((id) => x.order.has(id)).sort((a, b) => x.order.get(a) - x.order.get(b)).join(), boxes: [...x.rec.entries()].map(([id, g]) => `${id}:${JSON.stringify(g.q)}`).sort().join() });
    const a = norm(ix), b = norm(fresh); for (const k of Object.keys(a)) if (a[k] !== b[k]) out.push(k);
    if (JSON.stringify([...kidsMap(st).entries()]) !== JSON.stringify([...kidsOfIx({ kids: null }, st.entities).entries()])) out.push("kids");
    for (const id of Object.keys(st.entities)) if (JSON.stringify(ix.rec.get(id)?.box ?? null) !== JSON.stringify(aabb(st, id)) || JSON.stringify(ix.rec.get(id)?.surfs ?? []) !== JSON.stringify(aabb(st, id) ? surfacesOf(st, id) : [])) { out.push(`geometry of ${id}`); break; }
    return out; } finally { CTX.cat = prevCat; }
}
// the things whose box meets [min, max] (closed: touching counts), in the state's key order
function near(st, min, max) {
  const ix = spatial(st);
  const x0 = cellOf(min[0]), x1 = cellOf(max[0]), z0 = cellOf(min[2]), z1 = cellOf(max[2]);
  // what's filed in those cells (and the huge things), once each, in key order: memoized per cell range (a search asks
  // the same few ranges thousands of times)
  const wide = !((x1 - x0 + 1) * (z1 - z0 + 1) <= ix.grid.size); const k0 = wide ? 0 : cellKey(x0, z0), k1 = wide ? -1 : cellKey(x1, z1);
  let m1 = ix.memo.get(k0); if (!m1) { if (ix.memo.size > 4096) ix.memo.clear(); ix.memo.set(k0, (m1 = new Map())); }
  let cand = m1.get(k1);
  if (!cand) { const seen = new Set(); cand = [];
    const take = (id) => { if (!seen.has(id)) { seen.add(id); cand.push(id); } };
    if (wide) { for (const a of ix.grid.values()) a.forEach(take); }   // a query wider than the world: every filed thing once
    else for (let x = x0; x <= x1; x++) for (let z = z0; z <= z1; z++) ix.grid.get(cellKey(x, z))?.forEach(take);
    ix.big.forEach(take);
    if (cand.length > 1) cand.sort((a, b) => ix.order.get(a) - ix.order.get(b));
    m1.set(k1, cand); }
  const out = [];
  for (const id of cand) { const q = ix.rec.get(id).q;
    if (q.min[0] <= max[0] && q.max[0] >= min[0] && q.min[1] <= max[1] && q.max[1] >= min[1] && q.min[2] <= max[2] && q.max[2] >= min[2]) out.push(id); }
  spend(10 + cand.length + (cand.length >> 2));
  return out;
}
// hits(), through the index's cached boxes. The query box is axis-aligned, so the world's three axes are among the 15
// the test takes its minimum over: a penetration of eps or less along one of them (the same numbers satDepth would
// compute there: half-sizes summed, less the centres' distance) is already the answer. Only the rest run the full test.
function hitsIx(st, box, id, eps, B = boxToObb(box)) {   // B: the box as an oriented box (a caller testing many may pass its own)
  const g = spatial(st).rec.get(id); if (!g) return false;
  for (let k = 0; k < g.obbs.length; k++) { const x = g.ext[k], o = g.obbs[k]; spend(1);
    if (B.h[0] + x.h[0] - Math.abs(o.c[0] - B.c[0]) <= eps || B.h[1] + x.h[1] - Math.abs(o.c[1] - B.c[1]) <= eps || B.h[2] + x.h[2] - Math.abs(o.c[2] - B.c[2]) <= eps) continue;
    spend(satCost(B, o)); if (satDepth(B, o) > eps) return true; }
  return false;
}
// descendants() through the index's children map (a set: callers here only ask membership)
function familyOf(st, id) { const kids = kidsMap(st); const out = new Set([id]); const todo = [id];
  for (let n = 0; todo.length && n < 1e6; n++) { for (const k of kids.get(todo.pop()) ?? []) if (!out.has(k)) { out.add(k); todo.push(k); } } return out; }

// THE GROUND (owner, 10-15 22:34): the authority stands things and bodies on the ground the walker walks on. @world's
// terrain component through shared/terrainmath.js (terrainParams → makeHeightField: the sim's law, and the client's and the
// agent's to ~1 ulp, features and heightmap included through terrainshape), and its water (terrainshape's waterParams, the
// level the mover's water law reads). No terrain component: y 0 and no water, as every world stood before. The field is
// built once per terrain VALUE (a write replaces the value, never changes it in place: the revision is the object), not
// per call. A heightmap's grid comes through terrainshape's loader (the server's disk, server/heightmap.ts).
// A heightmap whose grid isn't here yet (a world copied without its store/heightmaps file, a hash not uploaded, the loader's
// miss window) is NOT READY (holes r3 F2/F3): the height law would fall back to the noise law, and nothing commits ground on
// that (terrainshape's rule; the browser and the agent keep their last ground). Its ground is never cached, so it is built
// the moment the grid lands, and any read of its height refuses with words: ground-seated placement, a walk, a put, a
// set-down. Readers that only advise (warnings, the settle's rest-attach) ask groundReady first and skip.
const GROUND = new WeakMap();
const FLAT = Object.freeze({ terrain: false, ready: true, height: () => 0, level: null });
const loading = () => refuse("ground-loading", "this world's ground is still loading: its heightmap's grid isn't on this server yet, and the authority won't stand anything (or judge a step) on a guessed height",
  "try again in a moment; if it stays missing, an owner can upload the heightmap image again");
function groundOf(st) {
  const t = st.entities["@world"]?.c.terrain;
  if (!t || typeof t !== "object") return FLAT;
  let g = GROUND.get(t);
  if (!g) {
    const level = waterParams(t)?.level ?? null;
    if (!shapeReady(shapeParams(t))) return { terrain: true, ready: false, height: loading, level };
    g = Object.freeze({ terrain: true, ready: true, height: makeHeightField(terrainParams(t)), level }); GROUND.set(t, g);
  }
  return g;
}
const groundReady = (st) => groundOf(st).ready;
const terrainAt = (st, x, z) => { const y = groundOf(st).height(x, z); return Number.isFinite(y) ? y : 0; };

// The highest support at (x, z) at or below y (+2 cm): a placed thing's top, or the ground (terrain counts at any height:
// nothing stands under it, and a thing's top below it is buried, not a floor).
function supportBelow(st, x, z, y, ignore = new Set()) {
  let best = { y: terrainAt(st, x, z), id: "ground" };
  const ix = spatial(st);
  for (const id of near(st, [x, -Infinity, z], [x, Infinity, z])) {
    if (ignore.has(id)) continue;
    for (const s of ix.rec.get(id).surfs)
      if (x >= s.min[0] && x <= s.max[0] && z >= s.min[1] && z <= s.max[1] && s.y <= y + 0.02 && s.y > best.y) best = { y: s.y, id };
  }
  return best;
}

// Supported anywhere under its footprint (the engine's rule: a box rests on a top its footprint overlaps), not just
// under its centre — so a thing physics left resting is never called floating by the authority (playtest 22, F5). On
// terrain, the highest ground under the footprint (its corners, edges' middles and centre): a box on a slope rests on it.
function supportUnder(st, b, ignore) {
  const G = groundOf(st); let gy = 0;
  if (G.terrain) { gy = -Infinity; for (const fx of [0, 0.5, 1]) for (const fz of [0, 0.5, 1]) { const y = G.height(b.min[0] + (b.max[0] - b.min[0]) * fx, b.min[2] + (b.max[2] - b.min[2]) * fz); if (Number.isFinite(y) && y > gy) gy = y; }
    if (!Number.isFinite(gy)) gy = 0; }
  let best = { y: gy, id: "ground" };
  const ix = spatial(st);
  for (const id of near(st, [b.min[0], -Infinity, b.min[2]], [b.max[0], Infinity, b.max[2]])) { if (ignore.has(id)) continue;
    for (const s of ix.rec.get(id).surfs) if (b.max[0] > s.min[0] && b.min[0] < s.max[0] && b.max[2] > s.min[1] && b.min[2] < s.max[1] && s.y <= b.min[1] + 0.02 && s.y > best.y) best = { y: s.y, id }; }
  return best;
}

export { GEO, LASTIX, SPATIAL, buildIx, groundOf, groundReady, terrainAt, cellKey, cellOf, cellsOf, clockMs, deriveIx, familyOf, fileIx, geoOf, hitsIx, kidsMap, kidsOfIx, near, spatial, spend, supportBelow, supportUnder };
