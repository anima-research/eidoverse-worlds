// terrainshape — the terrain you SHAPE, over the terrain you roll.
//
// The `terrain` verb's noise (terrainmath.js / the toolkit's makeTerrain)
// gives a world hills, but not THESE hills: an author could pick how rough
// and which random layout, never "a mountain here, a valley there". Two ways
// to say where, both riding the same verb:
//
//   features   placed shapes, applied in order over the base:
//                {type:'hill',    x, z, radius, height}         a round bump; negative height = a pit
//                {type:'ridge',   x1, z1, x2, z2, radius, height} a raised line; negative = a valley/channel
//                {type:'flatten', x, z, radius, height, edge?}  level a circle to an ABSOLUTE height
//   heightmap  {grid: 'store/heightmaps/<hash>.json', min, max} — an uploaded
//              grayscale image REPLACES the noise as the base: black = min
//              metres, white = max, stretched over the terrain's `size`
//              square (image x → world +x, image down → world +z). Features
//              still apply on top.
//
// Both of those live in the bag, and a write of the bag replaces them whole. Two more shape the ground from components of
// their own on @world, so one piece changes without the rest being sent again:
//
//   terrain-feature:<name>   one placed shape, written as a list feature is, with `order?`. Named features apply after
//                            the bag's list, by order (absent: 0) and then by name.
//   terrain-tile:<i>-<j>     {mm: [...]}: one tile of the SCULPTED layer, whole millimetres added after every feature,
//                            so a stroke always shows where it was made. Written by the authority's `sculpt`
//                            (shared/protocol/sculpt.js works a brush out once; every reader reads its result).
//
// The sculpted layer is a lattice fixed in world space (SCULPT): a sample every 0.5 m, in tiles of 32 × 32. Tile
// <i>-<j> holds columns 32i… along x and rows 32j… along z, counted from −2048 m, row-major (rows run along z, as a
// heightmap image's do). Between samples the layer is bilinear; a tile that isn't there is level.
//
// A reader gathers all of it into the ground's ARGS (groundArgs from @world's components, withShaping from a view) and
// hands them on as it always handed the bag. The extras ride under a symbol (SHAPING), so no stored bag can carry them
// and JSON.stringify(args) is still the bag alone. A level ground (no terrain, or kind flat) is never shaped.
//
// ONE implementation, three consumers: the client's mesh and heightAt, the agents' heightAt, and the deterministic sim
// (via terrainmath.js); they must agree or bodies stand in the air. So this file uses only exact operations (+ - * /,
// sqrt, floor, comparisons: no pow, no hypot). A world that shapes nothing never reaches this code.

import { MOVER, waterStance, waterCost } from './mover.js';   // the water law (below): one walker, one law
import { sha256hex } from './sha256.js';

export const MAX_FEATURES = 64;        // in the bag's list
export const MAX_NAMED = 64;           // terrain-feature:<name> components
export const MAX_TILES = 1024;         // terrain-tile:<i>-<j> components (a quarter of a square kilometre, every sample moved)
export const MAX_GRID = 1025;          // per side; a 1025² map is ~2 MB of samples
/** The sculpted layer's lattice. spacing: metres between samples. tile: samples per tile side. span: tiles per side.
 *  origin: the world x and z of sample 0. limit: how far a sample may stand from the ground under it, mm. */
export const SCULPT = Object.freeze({ spacing: 0.5, tile: 32, span: 256, origin: -2048, limit: 500000 });
export const SHAPING = Symbol('terrain shaping');
const TYPES = new Set(['hill', 'ridge', 'flatten']);

const num = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const GRID_REF = /^store\/heightmaps\/[0-9a-f]{16}\.json$/;

/** One placed shape as the height law reads it, or null when it is malformed (a reader drops it; the authority
 *  refuses to store it). @param {any} f */
export function featureOf(f) {
  if (!f || !TYPES.has(f.type)) return null;
  const radius = clamp(num(f.radius, 0), 0, 2000);
  const height = clamp(num(f.height, 0), -500, 500);
  if (!(radius > 0.05)) return null;
  if (f.type === 'ridge') {
    if (![f.x1, f.z1, f.x2, f.z2].every((v) => typeof v === 'number' && Number.isFinite(v))) return null;
    return { type: 'ridge', x1: f.x1, z1: f.z1, x2: f.x2, z2: f.z2, radius, height };
  }
  if (![f.x, f.z].every((v) => typeof v === 'number' && Number.isFinite(v))) return null;
  const g = { type: f.type, x: f.x, z: f.z, radius, height };
  if (f.type === 'flatten') g.edge = clamp(num(f.edge, radius * 0.5), 0.01, 2000);
  return g;
}

/** The shaping part of the ground's args, normalized — or null when the
 *  world uses none (the caller then keeps its plain noise law, untouched).
 *  Malformed features are dropped, not guessed at.
 *  @param {Record<string | symbol, any>} a */
export function shapeParams(a) {
  const features = [];
  const read = (list) => { for (const f of list) { const g = featureOf(f); if (g) features.push(g); } };
  read(Array.isArray(a?.features) ? a.features.slice(0, MAX_FEATURES) : []);
  const over = a?.[SHAPING];
  if (over?.named) read(over.named);
  let heightmap = null;
  const h = a?.heightmap;
  if (h && typeof h.grid === 'string' && GRID_REF.test(h.grid)) {
    const min = num(h.min, 0), max = num(h.max, 10);
    heightmap = { grid: h.grid, min, max };
  }
  // the sculpted layer is named, never carried: the sim's state holds these params (and hashes them), so the tiles stay out
  const sculpt = over?.tiles ? layerRef(over.tiles) : null;
  return features.length || heightmap || sculpt ? { features, heightmap, ...(sculpt ? { sculpt } : {}) } : null;
}

// ---- the ground's args: the bag, the named features, the sculpted tiles ---------------

/** Can this ground be shaped? A terrain that isn't level: no terrain at all and kind flat are the level floor. */
export const shapeable = (t) => !!t && typeof t === 'object' && !Array.isArray(t) && t.kind !== 'flat';
const TILE_KEY = /^(0|[1-9][0-9]{0,2})-(0|[1-9][0-9]{0,2})$/;
/** A tile's [i, j] from its key `<i>-<j>`, or null when it names no tile of the lattice. */
export function tileIndex(key) { const m = TILE_KEY.exec(String(key)); if (!m) return null; const i = Number(m[1]), j = Number(m[2]); return i < SCULPT.span && j < SCULPT.span ? [i, j] : null; }
export const tileKey = (i, j) => `${i}-${j}`;
/** The tile a world point falls in, as its key, or null outside the lattice. */
export function tileAt(x, z) { const n = SCULPT.spacing * SCULPT.tile, i = Math.floor((x - SCULPT.origin) / n), j = Math.floor((z - SCULPT.origin) / n);
  return i >= 0 && j >= 0 && i < SCULPT.span && j < SCULPT.span ? tileKey(i, j) : null; }
/** A tile's samples, or null when the value isn't one: `mm` is tile² whole numbers within the limit. */
export function tileOf(v) { const mm = Array.isArray(v) ? v : v?.mm, n = SCULPT.tile * SCULPT.tile;
  if (!Array.isArray(mm) || mm.length !== n) return null;
  for (let k = 0; k < n; k++) { const x = mm[k]; if (!Number.isInteger(x) || x > SCULPT.limit || x < -SCULPT.limit) return null; }
  return mm; }

/** A tile as a reply or a reading says it: how many samples, and how far they stand from the ground under them (mm). A
 *  tile is 1024 numbers, which nobody reads; anything else comes back as it is. */
export const tileSaid = (comp, v) => (typeof comp === 'string' && comp.startsWith('terrain-tile:') && Array.isArray(v?.mm) ? { samples: v.mm.length, min: Math.min(...v.mm), max: Math.max(...v.mm) } : v);

/** The ground's args: the terrain bag with the world's named features and sculpted tiles riding on it (SHAPING).
 *  `features` is {<name>: value}, `tiles` {<i>-<j>: {mm} | mm}. With neither, or on a level ground, the bag itself, so
 *  a world that shapes nothing reads exactly as it did. */
export function withShaping(terrain, features, tiles) {
  if (!shapeable(terrain)) return terrain ?? null;
  const names = Object.keys(features ?? {}).filter((n) => features[n] && typeof features[n] === 'object').sort();
  const ord = (n) => num(features[n].order, 0);
  names.sort((a, b) => ord(a) - ord(b));   // a stable sort: equal orders keep their name order
  const named = names.slice(0, MAX_NAMED).map((n) => features[n]);
  // (in key order, so two readers handed more tiles than a ground carries keep the same ones)
  const T = {}; let count = 0;
  for (const k of Object.keys(tiles ?? {}).sort()) { if (count >= MAX_TILES) break; const mm = tileIndex(k) && tileOf(tiles[k]); if (mm) { T[k] = mm; count++; } }
  if (!named.length && !count) return terrain;
  return { ...terrain, [SHAPING]: { named, tiles: count ? T : null } };
}

// one composition per terrain value: the same pieces give back the same args, so a cache keyed on the args (the
// authority's ground, the sim's field) holds until the ground really changes. Keyed on values, never on @world's bag: a
// fold may change that in place.
const composed = new WeakMap();   // terrain value -> { parts, args }
/** The ground's args from @world's components (a fold's record of it). */
export function groundArgs(wc) {
  const t = wc?.terrain;
  if (!shapeable(t)) return t ?? null;
  let features = null, tiles = null; const parts = [];
  for (const k in wc) {   // every key of @world (its roles and assets too): one cheap test turns most away
    if (k.charCodeAt(7) !== 45 || k.charCodeAt(0) !== 116) continue;   // 'terrain-…'
    if (k.startsWith('terrain-feature:')) { (features ??= {})[k.slice(16)] = wc[k]; parts.push(k, wc[k]); }
    else if (k.startsWith('terrain-tile:')) { (tiles ??= {})[k.slice(13)] = wc[k]; parts.push(k, wc[k]); }
  }
  if (!features && !tiles) return t;
  const last = composed.get(t);
  if (last && last.parts.length === parts.length && last.parts.every((p, i) => p === parts[i])) return last.args;
  const args = withShaping(t, features, tiles);
  composed.set(t, { parts, args });
  return args;
}
/** The named features and the tiles a ground's args carry: {named, tiles} (either may be empty), for a reader that
 *  tells what changed between two grounds. */
export const shapingOf = (args) => args?.[SHAPING] ?? null;

// ---- the sculpted layer --------------------------------------------------------
// A layer is every tile a ground carries, held by a name made from what the tiles hold, so the same sculpting has the
// same name on every machine. The LAYER_CACHE named or read last are kept; a height function holds its own from the
// moment it finds it, and the sim builds its height function the moment it is handed a ground (shared/sim.js), so a
// layer in use is never looked up twice. A name that isn't here (a sim's state adopted before its world's ground was
// read) is not ready, as a heightmap's missing grid isn't (shapeReady): reading the ground's args names it again, which
// the replica does before it feeds a sim (protocol/siminputs.js).
const LAYER_CACHE = 256;
const layers = new Map();          // name -> Map(tile number -> mm)
const tileNames = new WeakMap();   // mm -> the hash of its samples
const layerNames = new WeakMap();  // a ground's tiles -> their layer's name
function layerRef(tiles) {
  let ref = layerNames.get(tiles);
  if (!ref) {
    ref = sha256hex(Object.keys(tiles).sort().map((k) => { const mm = tiles[k]; let h = tileNames.get(mm);
      if (!h) { h = sha256hex(mm.join(',')); tileNames.set(mm, h); } return `${k}:${h}`; }).join('\n')).slice(0, 32);
    layerNames.set(tiles, ref);
  }
  let L = layers.get(ref);
  if (L) layers.delete(ref);
  else { L = new Map(); for (const k of Object.keys(tiles)) { const [i, j] = tileIndex(k); L.set(i * SCULPT.span + j, tiles[k]); } }
  layers.set(ref, L);
  while (layers.size > LAYER_CACHE) layers.delete(layers.keys().next().value);
  return ref;
}
/** A layer by its name, or null when this machine doesn't hold it. (A layer read is a layer kept.) */
export function layerFor(ref) { const L = layers.get(ref); if (!L) return null; layers.delete(ref); layers.set(ref, L); return L; }
/** The layer's height at a point, metres: bilinear between the four samples round it. */
function sculptSampler(L) {
  const { spacing, tile, span, origin } = SCULPT, N = tile * span;
  let lastK = -1, lastT;   // a walk and a mesh build read neighbours: the last tile is usually the next one too
  const at = (gx, gz) => {
    if (!(gx >= 0 && gz >= 0 && gx < N && gz < N)) return 0;
    const ti = Math.floor(gx / tile), tj = Math.floor(gz / tile), k = ti * span + tj;
    if (k !== lastK) { lastK = k; lastT = L.get(k); }
    return lastT ? lastT[(gz - tj * tile) * tile + (gx - ti * tile)] : 0;
  };
  return (x, z) => {
    const u = (x - origin) / spacing, v = (z - origin) / spacing, i = Math.floor(u), j = Math.floor(v);
    const d00 = at(i, j), d10 = at(i + 1, j), d01 = at(i, j + 1), d11 = at(i + 1, j + 1);
    if (d00 === 0 && d10 === 0 && d01 === 0 && d11 === 0) return 0;
    const fu = u - i, fv = v - j, a = d00 + (d10 - d00) * fu, b = d01 + (d11 - d01) * fu;
    return (a + (b - a) * fv) / 1000;
  };
}

// ---- heightmap grids ---------------------------------------------------------
// A grid is {w, h, data: Uint16Array} — 0..65535 per sample, row-major from
// the image's top-left. On the wire and on disk: {w, h, data: base64 of the
// little-endian uint16s}, decoded once by the server at upload so every
// consumer reads integers, never an image decoder's opinion of one.

// Grids are cached by ref, the last GRID_CACHE kept. A disk miss is remembered for MISS_RETRY_MS; a failed fetch backs
// off from FETCH_RETRY_MS, doubling to MISS_RETRY_MS. Nothing commits ground for a heightmap until its grid is here
// (shapeReady): browser and agent keep their last ground and rebuild when it lands (client/lib/world.js, mcpl/agent.ts).
const GRID_CACHE = 8;
const MISS_RETRY_MS = 30_000;
const FETCH_RETRY_MS = 1_000;
const grids = new Map();
const misses = new Map();     // ref -> when the loader last failed on it
const fetchMisses = new Map();   // ref -> { until, n }: no fetch before `until`; n failures in a row
const inflight = new Map();   // ref -> the fetch in progress
let loader = null, fetcher = null;

function keep(ref, g) {
  grids.delete(ref); grids.set(ref, g); misses.delete(ref); fetchMisses.delete(ref);
  while (grids.size > GRID_CACHE) grids.delete(grids.keys().next().value);
}
const missedLately = (ref) => { const t = misses.get(ref); return t != null && Date.now() - t < MISS_RETRY_MS; };

/** Make a grid available to every height function that names it. */
export function registerGrid(ref, grid) { keep(ref, grid); }
/** A synchronous source for grids not yet registered — the server's disk.
 *  Clients and agents fetch asynchronously instead (they cannot block): see setGridFetcher. */
export function setGridLoader(fn) { loader = fn; }
/** An asynchronous source — `fn(ref)` resolves to the wire form ({w, h, data}) or throws. */
export function setGridFetcher(fn) { fetcher = fn; }
export function gridFor(ref) {
  let g = grids.get(ref);
  if (g) { grids.delete(ref); grids.set(ref, g); return g; }
  if (!loader || missedLately(ref)) return null;
  try { g = loader(ref); } catch { g = null; }
  if (g) keep(ref, g); else misses.set(ref, Date.now());
  return g ?? null;
}
/** Fetch a grid through the fetcher, once at a time per ref: resolves to the grid, or null if it could not
 *  be had (and then not fetched again until its backoff has passed: gridRetryIn). */
export function requestGrid(ref) {
  const have = gridFor(ref);
  if (have) return Promise.resolve(have);
  if (!fetcher || gridRetryIn(ref) > 0) return Promise.resolve(null);
  let p = inflight.get(ref);
  if (!p) {
    p = (async () => {
      try { const g = decodeGrid(await fetcher(ref)); keep(ref, g); return g; }
      catch {
        const n = (fetchMisses.get(ref)?.n ?? 0) + 1;
        fetchMisses.set(ref, { until: Date.now() + Math.min(MISS_RETRY_MS, FETCH_RETRY_MS * 2 ** (n - 1)), n });
        return null;
      }
      finally { inflight.delete(ref); }
    })();
    inflight.set(ref, p);
  }
  return p;
}
/** Milliseconds until a failed grid may be fetched again (0: now). */
export function gridRetryIn(ref) { const m = fetchMisses.get(ref); return m ? Math.max(0, m.until - Date.now()) : 0; }
/** Whether a terrain's shaping can be computed as written — false while its heightmap grid is still
 *  missing (the height law would fall back to noise, which nothing should commit to), or its sculpted layer isn't held. */
export function shapeReady(shape) { return (!shape?.heightmap || !!gridFor(shape.heightmap.grid)) && (!shape?.sculpt || layers.has(shape.sculpt)); }

/** Wire/disk form → grid. Integer byte assembly, so it is exact everywhere. */
export function decodeGrid(obj) {
  const w = obj?.w | 0, h = obj?.h | 0;
  if (w < 2 || h < 2 || w > MAX_GRID || h > MAX_GRID || typeof obj.data !== 'string') throw new Error('bad heightmap grid');
  const bin = atob(obj.data);
  if (bin.length !== w * h * 2) throw new Error(`heightmap grid has ${bin.length / 2} samples, want ${w * h}`);
  const data = new Uint16Array(w * h);
  for (let i = 0; i < data.length; i++) data[i] = bin.charCodeAt(2 * i) | (bin.charCodeAt(2 * i + 1) << 8);
  return { w, h, data };
}

/** Grid → wire/disk form. */
export function encodeGrid(grid) {
  let s = '';
  const CH = 0x8000;
  const bytes = new Uint8Array(grid.data.length * 2);
  for (let i = 0; i < grid.data.length; i++) { bytes[2 * i] = grid.data[i] & 0xff; bytes[2 * i + 1] = grid.data[i] >> 8; }
  for (let i = 0; i < bytes.length; i += CH) s += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
  return { w: grid.w, h: grid.h, data: btoa(s) };
}

// ---- the height law ------------------------------------------------------------

const sm = (t) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));
// round-topped bump: 1 at the centre, 0 at r, flat at both ends — (1-t²)²
const bell = (d2, r) => { const t2 = d2 / (r * r); if (t2 >= 1) return 0; const k = 1 - t2; return k * k; };

/** Wrap a base height function with a world's shaping.
 *  @param {(x: number, z: number) => number} base  the noise law (toolkit or terrainmath)
 *  @param {NonNullable<ReturnType<typeof shapeParams>>} S
 *  @param {number} size  the terrain square the heightmap stretches over
 *  @returns {(x: number, z: number) => number} */
export function shapeHeight(base, S, size) {
  const hm = S.heightmap, feats = S.features;
  const half = size / 2;
  const sample = (g, x, z) => {
    // image-space position, clamped to the edge (outside the square the edge rows extend)
    const u = clamp((x + half) / size, 0, 1) * (g.w - 1), v = clamp((z + half) / size, 0, 1) * (g.h - 1);
    const i = Math.floor(u), j = Math.floor(v);
    const i1 = i + 1 < g.w ? i + 1 : i, j1 = j + 1 < g.h ? j + 1 : j;
    const fu = u - i, fv = v - j, d = g.data, W = g.w;
    const a = d[j * W + i] + (d[j * W + i1] - d[j * W + i]) * fu;
    const b = d[j1 * W + i] + (d[j1 * W + i1] - d[j1 * W + i]) * fu;
    return hm.min + (hm.max - hm.min) * ((a + (b - a) * fv) / 65535);
  };
  // The grid is HELD from the moment it is first found: a built terrain keeps its own image however the
  // cache turns over. Until then it is looked up per call (a sim's field made before the grid landed).
  let held = hm ? gridFor(hm.grid) : null;
  // the sculpted layer likewise: found once, then this height function's own
  let sculpted = null;
  const layer = () => { const L = layerFor(S.sculpt); return L ? (sculpted = sculptSampler(L)) : null; };
  if (S.sculpt) layer();
  return (x, z) => {
    let h;
    if (hm) {
      const g = held ?? (held = gridFor(hm.grid));
      h = g ? sample(g, x, z) : base(x, z);
    } else h = base(x, z);
    for (let n = 0; n < feats.length; n++) {
      const f = feats[n];
      if (f.type === 'hill') {
        const dx = x - f.x, dz = z - f.z;
        h += f.height * bell(dx * dx + dz * dz, f.radius);
      } else if (f.type === 'ridge') {
        // distance to the segment, squared
        const ex = f.x2 - f.x1, ez = f.z2 - f.z1, L2 = ex * ex + ez * ez;
        let t = L2 > 0 ? ((x - f.x1) * ex + (z - f.z1) * ez) / L2 : 0;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const dx = x - (f.x1 + ex * t), dz = z - (f.z1 + ez * t);
        h += f.height * bell(dx * dx + dz * dz, f.radius);
      } else {   // flatten: level to an absolute height, softening out over `edge`
        const dx = x - f.x, dz = z - f.z, d = Math.sqrt(dx * dx + dz * dz);
        const w = d <= f.radius ? 1 : sm(1 - (d - f.radius) / f.edge);
        h += (f.height - h) * w;
      }
    }
    if (S.sculpt) { const sc = sculpted ?? layer(); if (sc) h += sc(x, z); }
    return h;
  };
}

// ---- water ---------------------------------------------------------------------
// One level per world: the `water` component on @world, {level, color?, opacity?}. Ground below `level` is under water
// unless a pocket zone keeps it out (shared/zone.js). Rendered by every client, read by every agent, ignored by the sim
// (a thrown thing lands on the lakebed).
//
// A body WADES until the water is at its chest, then SWIMS (waterStance). Nothing is walled off (wadeAllowed/waterBlocks
// always allow); a planner prices water instead (waterCost). The law lives in shared/mover.js; these are re-exports.
export { waterStance, waterCost };
export const SWIM_AT = MOVER.swim.at;         // of body height: deeper than this at the feet, the body floats (the chest)
export const SWIM_SPEED = MOVER.swim.speed;   // m/s, a steady stroke
export const SWIM_RUN = MOVER.swim.run;       // m/s, swimming hard (shift)
export const WALK_SPEED = MOVER.walk.speed;   // the walking pace waterCost prices against
/** @deprecated wading has no depth limit now — kept so callers of the old rule still read one. */
export const WADE_DEPTH = 1.0;
const HEX = /^#[0-9a-fA-F]{6}$/;
/** @world's water component, or undefined. @param {Record<string, any>} c  @world's components (or a view: {water, terrain}) */
export const worldWater = (c) => c?.water;
/** A world's water, normalized — or null when it has none. Its colour is an int (0xRRGGBB) or an older '#rrggbb'.
 *  @param {Record<string, any>} a  terrain-verb args carrying `water` (the water component riding on them) */
export function waterParams(a) {
  const w = a?.water;
  if (!w || typeof w.level !== 'number' || !Number.isFinite(w.level)) return null;
  return {
    level: clamp(w.level, -500, 500),
    color: Number.isInteger(w.color) && w.color >= 0 && w.color <= 0xffffff ? `#${w.color.toString(16).padStart(6, '0')}` : typeof w.color === 'string' && HEX.test(w.color) ? w.color : '#1d5a6e',
    opacity: clamp(num(w.opacity, 0.82), 0.1, 1),
  };
}

/** @deprecated swimming means no step is refused; kept so the old callers read "allowed". */
export function wadeAllowed() { return true; }
/** The one place a route planner asks whether water blocks a move: with swimming, it never does —
 *  ask waterCost for what the water costs instead. */
export function waterBlocks() { return false; }

/** The shaped heightAt for terrain-verb args over a base law — or the base
 *  itself when the args shape nothing. What the client and agents call. */
export function shapedHeightAt(base, args) {
  const S = shapeParams(args);
  return S ? shapeHeight(base, S, num(args?.size, 80)) : base;
}
