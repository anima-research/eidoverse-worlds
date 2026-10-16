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
// ONE implementation, three consumers: the client's mesh and walking
// heightAt, the agents' heightAt, and the deterministic sim (via
// terrainmath.js). They must agree or bodies stand in the air or in the
// ground. So this file holds to the sim's blessed exact-op set (Covenant I):
// + - * /, Math.sqrt, Math.floor, comparisons — no pow, no hypot, nothing
// transcendental. A world with neither key never reaches this code, so no
// existing world's ground moves by a bit.

export const MAX_FEATURES = 64;
export const MAX_GRID = 1025;          // per side; a 1025² map is ~2 MB of samples
const TYPES = new Set(['hill', 'ridge', 'flatten']);

const num = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const GRID_REF = /^store\/heightmaps\/[0-9a-f]{16}\.json$/;

/** The shaping part of terrain-verb args, normalized — or null when the
 *  world uses none (the caller then keeps its plain noise law, untouched).
 *  Malformed features are dropped, not guessed at.
 *  @param {Record<string, any>} a */
export function shapeParams(a) {
  const features = [];
  for (const f of Array.isArray(a?.features) ? a.features.slice(0, MAX_FEATURES) : []) {
    if (!f || !TYPES.has(f.type)) continue;
    const radius = clamp(num(f.radius, 0), 0, 2000);
    const height = clamp(num(f.height, 0), -500, 500);
    if (!(radius > 0.05)) continue;
    if (f.type === 'ridge') {
      if (![f.x1, f.z1, f.x2, f.z2].every((v) => typeof v === 'number' && Number.isFinite(v))) continue;
      features.push({ type: 'ridge', x1: f.x1, z1: f.z1, x2: f.x2, z2: f.z2, radius, height });
    } else {
      if (![f.x, f.z].every((v) => typeof v === 'number' && Number.isFinite(v))) continue;
      const g = { type: f.type, x: f.x, z: f.z, radius, height };
      if (f.type === 'flatten') g.edge = clamp(num(f.edge, radius * 0.5), 0.01, 2000);
      features.push(g);
    }
  }
  let heightmap = null;
  const h = a?.heightmap;
  if (h && typeof h.grid === 'string' && GRID_REF.test(h.grid)) {
    const min = num(h.min, 0), max = num(h.max, 10);
    heightmap = { grid: h.grid, min, max };
  }
  return features.length || heightmap ? { features, heightmap } : null;
}

// ---- heightmap grids ---------------------------------------------------------
// A grid is {w, h, data: Uint16Array} — 0..65535 per sample, row-major from
// the image's top-left. On the wire and on disk: {w, h, data: base64 of the
// little-endian uint16s}, decoded once by the server at upload so every
// consumer reads integers, never an image decoder's opinion of one.

// Grids are cached by ref, newest-used last, and only the last GRID_CACHE are kept: a world that has been
// re-imaged many times does not hold every old image. A ref the disk loader could not find is remembered
// for MISS_RETRY_MS, so a missing file is not re-read on every height sample. A FETCH that failed backs
// off — FETCH_RETRY_MS, doubling to MISS_RETRY_MS — so a passing network fault costs seconds, not half a
// minute. Nothing commits ground for a heightmap until its grid is here (shapeReady): browser and agent
// keep the last ground they had, and rebuild once the grid lands (client/lib/world.js, mcpl/agent.ts).
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
 *  be had (and then not asked for again until MISS_RETRY_MS has passed). */
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
 *  missing (the height law would fall back to noise, which nothing should commit to). */
export function shapeReady(shape) { return !shape?.heightmap || !!gridFor(shape.heightmap.grid); }

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
    return h;
  };
}

// ---- water ---------------------------------------------------------------------
// One level per world, riding the terrain bag: `water: {level, color?, opacity?}`.
// Every point of ground below `level` is under water, so one number makes every
// low place a lake. It is presence-free world state like the ground itself:
// rendered by every client, read by every agent, and (v1) ignored by the sim —
// a thrown thing still lands on the lakebed.
//
// A body WADES until the water is at its chest, then SWIMS (waterStance): its feet leave the bed and it
// floats with head and shoulders above the surface. Wading is slower the deeper it gets; swimming is
// slower still. Nothing is walled off: the old 1 m wading wall is gone (wadeAllowed/waterBlocks now
// always allow), and a planner prices water instead (waterCost). The client's controller and the agents'
// walk both read these, from the body's own height.
export const SWIM_AT = 0.75;        // of body height: deeper than this at the feet, the body floats (the chest)
export const SWIM_SPEED = 0.9;      // m/s, a steady stroke
export const SWIM_RUN = 1.5;        // m/s, swimming hard (shift)
export const WALK_SPEED = 1.55;     // the walking pace waterCost prices against
/** @deprecated wading has no depth limit now — kept so callers of the old rule still read one. */
export const WADE_DEPTH = 1.0;
const sm01 = (t) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));
const HEX = /^#[0-9a-fA-F]{6}$/;
/** A world's water, normalized — or null when it has none.
 *  @param {Record<string, any>} a  terrain-verb args */
export function waterParams(a) {
  const w = a?.water;
  if (!w || typeof w.level !== 'number' || !Number.isFinite(w.level)) return null;
  return {
    level: clamp(w.level, -500, 500),
    color: typeof w.color === 'string' && HEX.test(w.color) ? w.color : '#1d5a6e',
    opacity: clamp(num(w.opacity, 0.82), 0.1, 1),
  };
}

/** How a body of `height` metres stands where the ground is at `ground`, under water at `level`:
 *  `y` is where its feet go (the bed, or — swimming — the depth that keeps its chest at the surface),
 *  `depth` the water over the bed, `swimming` whether it floats, and `speedFactor` its walking speed
 *  in that water (knee-deep ~0.86, waist-deep ~0.61, chest-deep 0.5; null while swimming — swim
 *  speeds apply instead). No water: the ground, at full speed. */
export function waterStance(level, ground, height = 1.7) {
  if (level == null) return { y: ground, depth: 0, swimming: false, speedFactor: 1 };
  const depth = level - ground, floatY = level - SWIM_AT * height;
  if (ground < floatY) return { y: floatY, depth, swimming: true, speedFactor: null };
  const f = (depth > 0 ? depth : 0) / height;
  return { y: ground, depth, swimming: false, speedFactor: 1 - 0.5 * sm01((f - 0.08) / 0.67) };
}

/** How much longer a metre takes here than on dry ground — the planner's price for water. 1 dry;
 *  ~2 chest-deep; ~1.7 swimming (a 0.9 m/s stroke against a 1.55 m/s walk). */
export function waterCost(level, ground, height = 1.7) {
  const s = waterStance(level, ground, height);
  return s.swimming ? WALK_SPEED / SWIM_SPEED : 1 / s.speedFactor;
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
