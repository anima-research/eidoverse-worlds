// shared/protocol/authority/catalogue.js — the model catalogue and a thing's geometry (refactor C11, 2026-10-12; moved from
// authority.js's "the model catalogue" section unchanged). A leaf: math and the spatial index read a thing's box through
// geomE; nothing here reaches the gate. The load-time `CTX.cat = LAB_CATALOGUE` rides along: authority.js imports this
// file, so an out-of-call reader (a test reading the index) still finds the lab's catalogue in force.
import { PURGED } from "../fold.js";
import { MODELS } from "../labmodels.js";
import { COMPONENTS } from "../componentspec.js";
import { collisionBoxes } from "../../structure.js";
import { CTX } from "./ctx.js";
// ---------- the model catalogue (engine, slice 2) ----------
// The lab's authority read its own table (./labmodels.js). The engine's models are library paths measured from their GLBs
// (server/modelcatalogue.ts), so the catalogue is injected: io.catalogue = { get(name) → entry | undefined,
// list(query) → [name, entry][] }. An entry is { label, size?, box?, surfaces, solids?, sockets? }:
//   box      [[x,y,z], [x,y,z]] in the model's frame (a GLB's origin is wherever its author put it); absent → the lab's
//            convention, a size-box with the origin at the base centre;
//   surfaces [{y, x?: [min,max], z?: [min,max], inset?}] in the model's frame (measured flat zones carry x/z);
//   size     absent → a model this server can name but not measure (no placement help, no collisions, said so).
// request() sets CTX.cat for the duration of one synchronous call; nothing in the authority awaits, so calls can't interleave.
// own keys only: MODELS["constructor"] is Object (the lab authority accepted model "constructor"; L1's no-prototype rule)
export const LAB_CATALOGUE = Object.freeze({ get: (n) => (Object.hasOwn(MODELS, n) ? MODELS[n] : undefined), list: (q) => Object.entries(MODELS).filter(([k, m]) => k.includes(q) || m.label.includes(q)) });
CTX.cat = LAB_CATALOGUE;
const modelOf = (name) => (typeof name === "string" ? CTX.cat.get(name) : undefined);
const geomOf = (name) => { const m = modelOf(name); return m && m.size ? m : undefined; };
const boxOfM = (m) => m.box ?? [[-m.size[0] / 2, 0, -m.size[2] / 2], [m.size[0] / 2, m.size[1], m.size[2] / 2]];
// A building (`structure`) is solid where its walls are, not where its placeholder model is (review 10-07 N2: the authority
// never read `structure`, so bodies walked through Commons walls and things were put inside them). Its geometry is the
// structure's own collision boxes (shared/structure.js collisionBoxes: the same derivation the browser's colliders use),
// in the thing's frame, as a measured model's `solids` are; its floors are surfaces (a body steps over a slab, a thing
// rests on one), and a doorway is the absence of a box, so it stays walkable. The anchor's model is ignored, as the
// browser hides it. Cached per structure VALUE (a write replaces a value, never changes it in place), so the spatial
// index's identity checks still hold. Past STRUCT_MAX solid boxes the building's whole box stands (conservative, as
// server/solids.ts does past its limit).
const STRUCT_MAX = 512; const STRUCTGEO = new WeakMap();
function structGeom(v) {
  if (!v || typeof v !== "object" || Array.isArray(v) || v === PURGED) return undefined;
  if (STRUCTGEO.has(v)) return STRUCTGEO.get(v);
  // a building whose boxes can't be derived has no solid geometry here (walked and placed through), so the operator is told,
  // once per structure value (the result is cached per value just below)
  let boxes = []; try { boxes = collisionBoxes(v); } catch (e) { boxes = []; console.warn(`[authority] a structure's collision boxes couldn't be derived, so nothing in it is solid here: ${String(e?.message ?? e).slice(0, 200)}`); }
  const ok = (b) => [b.x0, b.y0, b.z0, b.x1, b.y1, b.z1].every(Number.isFinite);
  const lohi = (b) => [[Math.min(b.x0, b.x1), Math.min(b.y0, b.y1), Math.min(b.z0, b.z1)], [Math.max(b.x0, b.x1), Math.max(b.y0, b.y1), Math.max(b.z0, b.z1)]];
  const walls = boxes.filter((b) => ok(b) && b.kind !== "floor").map(lohi);
  // floors as surfaces, one per row run of tiles at one height (a 30 × 30 floor is 30 surfaces, not 900)
  const rows = new Map(); for (const b of boxes) if (ok(b) && b.kind === "floor") { const [lo, hi] = lohi(b); const k = `${hi[1]}|${lo[2]}|${hi[2]}`; let a = rows.get(k); if (!a) rows.set(k, (a = [])); a.push([lo[0], hi[0], lo[1]]); }
  const surfaces = [], floors = [];
  for (const [k, a] of rows) { const [y, z0, z1] = k.split("|").map(Number); a.sort((p, q) => p[0] - q[0]);
    for (let i = 0; i < a.length;) { let x0 = a[i][0], x1 = a[i][1], y0 = a[i][2]; i++; while (i < a.length && a[i][0] <= x1 + 1e-6) { x1 = Math.max(x1, a[i][1]); y0 = Math.min(y0, a[i][2]); i++; }
      surfaces.push({ y, x: [x0, x1], z: [z0, z1] }); floors.push([[x0, y0, z0], [x1, y, z1]]); } }
  const all = [...walls, ...floors];
  let g;
  if (!all.length) g = undefined;   // an empty plan (a building just started): nothing to stand on or bump into
  else { const lo = [0, 1, 2].map((i) => Math.min(...all.map((b) => b[0][i]))), hi = [0, 1, 2].map((i) => Math.max(...all.map((b) => b[1][i])));
    g = { label: "a building", structure: true, box: [lo, hi], size: hi.map((x, i) => x - lo[i]), surfaces, solids: walls.length > STRUCT_MAX ? [[lo, hi]] : walls }; }
  STRUCTGEO.set(v, g); return g;
}
// a mesh thing's geometry, from its component alone (componentspec `mesh`; primitives, R 10-12): base-centred like a measured
// model, so boxOfM's default box is its box; a sphere and a capsule are `round` (they offer no face when tipped). Cached per
// VALUE, as structGeom
const r4 = (n) => Math.round(n * 1e4) / 1e4;
const isNum = (x) => typeof x === "number" && Number.isFinite(x);
export const MESH_SIZE = COMPONENTS.mesh.ranges.size;
const MESHGEO = new WeakMap();
const meshOk = (v) => v && typeof v === "object" && !Array.isArray(v) && v !== PURGED && COMPONENTS.mesh.enums.shape.includes(v.shape)
  && Array.isArray(v.size) && v.size.length === 3 && v.size.every((x) => isNum(x) && x >= MESH_SIZE.min && x <= MESH_SIZE.max);
/** What a mesh value measures, by shape (the client's readMesh reads the same): a sphere is x³; a cylinder is x wide and y tall;
 *  a capsule is at least its diameter tall; a plane is 0.05 thick. */
export const meshSize = ({ shape, size: [x, y, z] }) => (shape === "sphere" ? [x, x, x] : shape === "cylinder" ? [x, y, x] : shape === "capsule" ? [x, Math.max(x, y), x] : shape === "plane" ? [x, MESH_SIZE.min, z] : [x, y, z]);
export function meshGeom(v) {
  if (!meshOk(v)) return undefined;
  if (MESHGEO.has(v)) return MESHGEO.get(v);
  const size = meshSize(v);
  const round = v.shape === "sphere" || v.shape === "capsule";
  const g = { label: `a ${v.shape}`, mesh: v.shape, size, surfaces: round ? [] : [{ y: size[1] }], ...(round ? { round: true } : {}) };
  MESHGEO.set(v, g); return g;
}
/** The engine's shape of a mesh thing (PHYSICS §3.1): box → [[min], [max]]; sphere → {sphere}; plane → a thin box; a cylinder or
 *  a capsule its bounding box, since no carried engine reads a cylinder (review S1.1: a tagged cylinder was a collider to the
 *  authority and nothing to eidosim, and a crate fell through it). In the thing's frame, base-centred, as geomE places. */
export function meshShape(v) {
  const g = meshGeom(v); if (!g) return null; const r = r4(g.size[0] / 2);
  if (v.shape === "sphere") return { type: "sphere", radius: r, pos: [0, r, 0] };
  return boxOfM(g).map((c) => c.map(r4));
}
/** A thing's geometry: its building's (structure) if it has one, else its mesh's, else its model's. */
const geomE = (e) => (e?.c.structure !== undefined ? structGeom(e.c.structure) : e?.c.mesh !== undefined ? meshGeom(e.c.mesh) : geomOf(e?.c.model));
/** Run fn with world w's catalogue in force (also for callers outside request(), e.g. a server's settle tick). */
export function withCatalogue(w, fn) { const prev = CTX.cat; CTX.cat = w.catalogue ?? LAB_CATALOGUE; try { return fn(); } finally { CTX.cat = prev; } }
export { modelOf, geomOf, boxOfM, geomE };
