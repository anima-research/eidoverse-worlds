// supportclass — one classifier for "can a box top be trusted as ground?"
//
// The browser's collider decide() and the headless support pipeline must
// agree about which assets are floor-shaped with a lying box top, so the grid
// arithmetic, the decision arithmetic and the constants live HERE,
// dependency-free; colliders.js and server/geometry.ts are adapters that
// gather vertices their own way and feed the same math.
//
// Over the survey's floor-shaped meshes (h ≤ 0.8 m, tighter than decide()'s 1.0 m), the 24×24 max-y grid's MEDIAN
// top tracks the raycast median to 1.8cm worst case (tools/assets/collider-survey.ts): a per-mesh figure, not a
// per-cell bound. The same grid doubles as the headless HEIGHTFIELD; per-cell trust is CERT_* below.

export const TOPGRID_VERSION = 1;
export const LIE_GRID = 24;              // cells per side
export const SPARSE_MIN_CELLS = 8;       // a 4-corner quad covers 4: too sparse to accuse
const ROOM_MIN_AREA = 16;         // m² (scaled) — decide()'s room-scale gate
const ROOM_MIN_H = 2.2;           // m (scaled)
const FLOOR_MIN_AREA = 2;         // m² (scaled) — smaller and nobody walks on it
const FLOOR_MAX_H = 1.0;          // m (scaled) — decide()'s one movable line
export const UNEVEN_MIN_LIE = 0.10;      // m (scaled) — below this a box is honest enough
export const TOPGRID_MAX_JSON = 8192;    // hard cap on the serialized payload
/** Per-cell certification: a cell is OFFERED as support only when a within-cell
 *  ray subsample (4×4, 8×8 for a rough cell: server/geometry.ts) finds its surface varies by no more than this
 *  (model metres; a gap between the rays goes unseen);
 *  uncertified cells serve as null. 0.03 keeps the world bound (0.05m) up to
 *  scale ~1.66; consumers must refuse grids their scale stretches. */
export const CERT_SPREAD = 0.03;         // m, model frame — max within-cell surface spread
export const CERT_MAX_WORLD = 0.05;      // m, world frame — the agreed per-cell truth bound
export const CERT_SUBSAMPLE = 4;         // rays per cell axis (4×4 per cell)

/** Bucket model-local vertices into a LIE_GRID² footprint grid, max-y per
 *  cell. Both adapters feed this: the browser walks THREE meshes, the
 *  server walks gltf-transform accessors — the math is this one function. */
export function gridAccumulator(minX, minZ, w, d) {
  if (!(w > 0) || !(d > 0)) return null;
  const n = LIE_GRID;
  const cells = new Float64Array(n * n).fill(-Infinity);
  return {
    n,
    add(x, y, z) {
      const cx = Math.min(n - 1, Math.max(0, Math.floor(((x - minX) / w) * n)));
      const cz = Math.min(n - 1, Math.max(0, Math.floor(((z - minZ) / d) * n)));
      const k = cz * n + cx;
      if (y > cells[k]) cells[k] = y;
    },
    /** lie = box top − median occupied cell top; sparse grids accuse nobody. */
    finish(boxTopY) {
      const tops = [];
      for (let i = 0; i < cells.length; i++) if (cells[i] !== -Infinity) tops.push(cells[i]);
      let lie = 0;
      if (tops.length >= SPARSE_MIN_CELLS) {
        tops.sort((a, b) => a - b);
        const h = tops.length >> 1;
        lie = boxTopY - (tops.length % 2 ? tops[h] : (tops[h - 1] + tops[h]) / 2);
      }
      return { cells, occupied: tops.length, lie };
    },
  };
}

/** The decision arithmetic, verbatim from decide() (colliders.js). ALL
 *  inputs are WORLD-SCALED metres — callers multiply by the entity scale.
 *  `lie` may be 0/omitted when only the shape gates are being asked. */
export function decideSupportClass({ w, d, h, lie = 0 }) {
  const roomScale = w * d >= ROOM_MIN_AREA && h >= ROOM_MIN_H;
  const floorShaped = !roomScale && w * d >= FLOOR_MIN_AREA && h <= FLOOR_MAX_H;
  const uneven = floorShaped && lie > UNEVEN_MIN_LIE;
  return { roomScale, floorShaped, uneven };
}

/** Is a served topGrid payload usable as support? Anything not versioned, finite
 *  and bounded is refused; on refusal the caller ABSTAINS, never falls back to
 *  the box top. Unoccupied cells are explicit nulls. */
export function validTopGrid(g) {
  if (!g || typeof g !== "object") return false;
  if (g.version !== TOPGRID_VERSION) return false;
  if (g.n !== LIE_GRID) return false;
  if (!Array.isArray(g.minXZ) || g.minXZ.length !== 2 || !g.minXZ.every(Number.isFinite)) return false;
  if (!Array.isArray(g.sizeXZ) || g.sizeXZ.length !== 2 || !g.sizeXZ.every((v) => Number.isFinite(v) && v > 0)) return false;
  if (!Number.isFinite(g.lie)) return false;
  // certSpread declares the bound every offered cell was certified to; a
  // grid without one (or claiming worse than the contract) is refused
  if (!Number.isFinite(g.certSpread) || g.certSpread <= 0 || g.certSpread > CERT_SPREAD) return false;
  if (!Array.isArray(g.cells) || g.cells.length !== LIE_GRID * LIE_GRID) return false;
  let occupied = 0;
  for (const c of g.cells) {
    if (c === null) continue;
    if (!Number.isFinite(c)) return false;
    occupied++;
  }
  if (occupied < SPARSE_MIN_CELLS) return false;
  try { if (JSON.stringify(g).length > TOPGRID_MAX_JSON) return false; } catch { return false; }
  return true;
}
