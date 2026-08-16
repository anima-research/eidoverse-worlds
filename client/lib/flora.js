// flora — the browser host for eidoverse-video's vegetation brush
// (`createFlora`), which replaced `makeGrass` upstream. Real species with PBR
// map sets — grass carpets with seasonal color, desert bunch grass, three
// Mojave shrubs, yucca, corn with baked cobs and planted rows — GPU-instanced
// whole plants, self-animating wind, pushers that part foliage around walkers.
//
// This file owns the DOM/THREE-bound hosting. The pure logic lives beside it
// so it can be unit-tested without a browser:
//   flora_args.js  — legacy makeGrass-bag mapping + preset/variety strokes
//   flora_field.js — field composition + retirement lifecycle
//   flora_lod.js   — blade-LOD index subsets for tiled strokes (§17b)
// All are covered by tools/flora.test.ts.
import { THREE, TSL, bus, camera, renderer, CONFIG } from './core.js';
import { primeFiles } from './assets.js';
import { colliders } from './colliders.js';
import { myState } from './controller.js';
import { remotes } from './remotes.js';
import { mapGrassArgs, presetStrokes } from './flora_args.js';
import { composeField } from './flora_field.js';
import { bladeLodIndex, bladeCoarseIndex } from './flora_lod.js';
import { densityCount } from './grass_quality.js';
import { pushHostHook } from './autohooks.js';

export { mapGrassArgs, presetStrokes } from './flora_args.js';
export { retireField } from './flora_field.js';

// ---- module ----------------------------------------------------------------

const FLORA_URL = '/library/eidoverse/vegetation.js';
let floraMod = null;
/** Import the vegetation module off the library route. Native ESM — relative
 *  imports inside it (shrub/corn generators) resolve against the same route.
 *  The specifier goes through an indirect import so a BUNDLER treats it as
 *  runtime data: `/library/` exists only on the sequencer at run time, and a
 *  literal dynamic import made the bundle fail trying to resolve it. */
const runtimeImport = new Function('s', 'return import(s)');
export async function loadFloraModule() {
  if (!floraMod) {
    floraMod = runtimeImport(FLORA_URL).then((m) => {
      // engine parity: the loader shim registers these globally
      globalThis.createFlora = m.createFlora;
      globalThis.FLORA_SPECIES = m.FLORA_SPECIES;
      globalThis.GRASS_COLORS = m.GRASS_COLORS;
      globalThis.resetFloraOccupancy = m.resetFloraOccupancy;
      return m;
    });
  }
  return floraMod;
}

// ---- assets ----------------------------------------------------------------

const GRASS_DIR = 'eidoverse/assets/grass';
/** Prime the map sets a species needs (albedo/normal/roughness/translucency,
 *  blade-fit + anchor JSONs, shrub bark). The module reads them synchronously
 *  Deno-style; missing optional maps degrade gracefully inside it. */
async function ensureFloraAssets(mod, species) {
  const spec = mod.FLORA_SPECIES[species];
  if (!spec) return;
  const paths = [];
  if (spec.maps) {
    for (const kind of ['albedo', 'normal', 'roughness', 'translucency']) {
      paths.push(`${GRASS_DIR}/${spec.maps}_${kind}.png`);
    }
  }
  if (spec.stem) {
    for (const kind of ['albedo', 'normal', 'roughness']) {
      paths.push(`${GRASS_DIR}/${spec.stem}_${kind}.png`);
    }
  }
  // blade grasses AND the sunflower fit their card widths to a measured
  // alpha-envelope json; unprimed it falls back to built-in envelopes
  if (spec.archetype === 'blades' || spec.archetype === 'sunflower') {
    paths.push(`${GRASS_DIR}/${spec.maps}_fit.json`);
  }
  if (spec.archetype === 'shrub') paths.push(`${GRASS_DIR}/shrub_anchors.json`);
  await primeFiles(paths); // missing files warn + degrade, never throw
}

// ---- interior clearings ----------------------------------------------------
// Exact-collider interiors paint their footprints black into a mask; the
// vertex stage sinks masked plants underground. ONE mask per FIELD, wired into
// EVERY stroke's material and disposed with the field: a module-global mask
// left earlier strokes pointing at an orphaned canvas (only the last stroke
// stayed repaintable) and leaked a bus listener per stroke per re-grow.
// The mask samples the PLANT's world XZ — the field's positionNode output —
// because positionLocal is per-plant space under instancing.
const MASK = 256;

function makeClearingMask(W, D) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = MASK;
  const ctx = canvas.getContext('2d');
  const tex = new THREE.CanvasTexture(canvas);
  tex.flipY = false;
  const paint = () => {
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, MASK, MASK);
    ctx.fillStyle = '#000';
    for (const [, e] of colliders) {
      if (!e.interior) continue;                    // things with a real floor only
      const { obj, box } = e;
      const s = obj.scale?.x || 1;
      const hw = ((box.max.x - box.min.x) / 2) * s + 0.15;  // small apron past the wall
      const hd = ((box.max.z - box.min.z) / 2) * s + 0.15;
      const bx = ((box.max.x + box.min.x) / 2) * s, bz = ((box.max.z + box.min.z) / 2) * s;
      const c = Math.cos(obj.rotation.y), n = Math.sin(obj.rotation.y);
      const wx = obj.position.x + bx * c + bz * n;
      const wz = obj.position.z - bx * n + bz * c;
      ctx.save();
      ctx.translate(((wx + W / 2) / W) * MASK, ((wz + D / 2) / D) * MASK);
      ctx.rotate(-obj.rotation.y);
      ctx.fillRect((-hw / W) * MASK, (-hd / D) * MASK, (2 * hw / W) * MASK, (2 * hd / D) * MASK);
      ctx.restore();
    }
    tex.needsUpdate = true;
  };
  const unsubscribe = bus.on('entity', paint);      // spawns/moves/rescales repaint
  paint();
  /** Sink this stroke's masked plants. Composes with the stroke's own
   *  positionNode (instancing + wind + pushers all live in there). */
  const wire = (mat) => {
    if (!mat) return;
    const { Fn, texture, vec2, vec3, float } = TSL;
    const orig = mat.positionNode;
    mat.positionNode = Fn(() => {
      const p = vec3(orig).toVar();
      const uv = p.xz.add(vec2(W / 2, D / 2)).div(vec2(W, D));
      const mask = texture(tex, uv).r;              // 1 = meadow, 0 = interior
      const sink = float(1).sub(mask).mul(4);       // deep enough for corn, not just blades
      return p.sub(vec3(0, sink, 0));
    })();
  };
  return { tex, paint, wire, dispose: () => { unsubscribe(); tex.dispose(); } };
}

// ---- density dial ----------------------------------------------------------
// The perf governor thins the meadow before dropping resolution (Safari fill
// rate). Instanced fields make this near-free: shuffle the per-instance
// attribute arrays once (deterministic — a field must stay the same field),
// and InstancedMesh.count becomes a uniform-density dial.
function wireDensityDial(field) {
  const geo = field.mesh.geometry;
  const attrs = ['aPosRot', 'aScaleVar', 'aPhase'].map((n) => geo.getAttribute(n)).filter(Boolean);
  const n = field.count;
  if (!n || !attrs.length) return;
  const order = Array.from({ length: n }, (_, i) => i);
  let seed = 0x6d2b79f5;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x80000000);
  for (let i = n - 1; i > 0; i--) {
    const j = (rnd() * (i + 1)) | 0;
    const t = order[i]; order[i] = order[j]; order[j] = t;
  }
  for (const a of attrs) {
    const sz = a.itemSize, src = a.array.slice();
    for (let i = 0; i < n; i++) {
      const s = order[i] * sz, d = i * sz;
      for (let k = 0; k < sz; k++) a.array[d + k] = src[s + k];
    }
    a.needsUpdate = true;
  }
  // the stem mesh (shrub wood) rides the same attribute OBJECTS, so the
  // shuffle above already covers it — only the count needs mirroring
  field.setDensity = (f) => {
    // densityCount owns the clamp — including genuine zero for `off` (#60)
    const keep = densityCount(n, f);
    field.mesh.count = keep;
    if (field.stemMesh) field.stemMesh.count = keep;
  };
}

// ---- frustum culling -------------------------------------------------------
// Upstream ships frustumCulled = false, and it HAS to: the engine's
// instanceMatrix is all identity (every transform rides the aPosRot/
// aScaleVar/aPhase attributes inside positionNode), so three's own
// computeBoundingSphere would union identity matrices into a half-meter
// sphere at the world origin and the field would vanish whenever the origin
// left the view. The adapter knows better: aPosRot IS the world placement
// (heights baked at build), so a correct world-space sphere is one pass
// over the attribute. Assign it explicitly — a non-null boundingSphere is
// never recomputed — and culling turns on: looking away from the meadow
// stops drawing every blade of it (§13.2 G1).
function wireFieldCulling(field) {
  const geo = field.mesh.geometry;
  const posRot = geo.getAttribute('aPosRot');
  const scaleVar = geo.getAttribute('aScaleVar');
  if (!posRot || !field.count) return;
  const box = new THREE.Box3();
  const v = new THREE.Vector3();
  for (let i = 0; i < field.count; i++) {
    box.expandByPoint(v.set(posRot.getX(i), posRot.getY(i), posRot.getZ(i)));
  }
  // plant height × the tallest instance, plus wind/pusher lean slack (the
  // tanh lean ceiling is 0.6 in the engine) — conservative on every axis
  geo.computeBoundingBox();   // per-plant LOCAL bounds (positions, not instances)
  const plantH = Math.max(0.5, geo.boundingBox.max.y - Math.min(0, geo.boundingBox.min.y));
  let maxScale = 1;
  if (scaleVar) {
    for (let i = 0; i < field.count; i++) maxScale = Math.max(maxScale, scaleVar.getY(i));
  }
  box.expandByScalar(plantH * maxScale + 0.6);
  const sphere = new THREE.Sphere();
  box.getBoundingSphere(sphere);
  // the field group sits at the scene root with an identity transform, so a
  // world-space sphere is directly what the frustum test wants
  field.mesh.boundingSphere = sphere;
  field.mesh.frustumCulled = true;
  if (field.stemMesh) {   // shrub wood is a CHILD mesh — culled independently
    field.stemMesh.boundingSphere = sphere;
    field.stemMesh.frustumCulled = true;
  }
}

// ---- tiling (§13.2 G2, re-cut §16.2.B) + blade LOD (§17b) -------------------
// One monolithic InstancedMesh can never cull a blade behind you and pays
// full fragment cost regardless of view. So a big stroke is re-cut into XZ
// tiles AFTER the density shuffle: K geometries SHARING the vertex/index/aH
// attribute objects (the backend keys GPU buffers on the attribute object —
// uploaded once) with sliced copies of only the three instanced attributes
// (~44 bytes/instance), K meshes sharing the ONE material (wind, clearing
// mask, and the factory wrap are all material- or name-bound). Each tile
// carries its own world sphere → three's frustum culling finally works —
// and per-tile `count` becomes distance density for free, because bucketing
// in stable order preserves the shuffle: any prefix of a tile is still a
// uniform random subset of its plants.
//
// The grid derives from OCCUPANCY, not a fixed edge (§16.1b): a fixed ~12m
// edge shredded 2912 sparse desert plants into 57 tiles averaging 51
// instances — and every InstancedMesh is a full NodeBuilder codegen run,
// because the material cache key carries object.uuid for any instanced
// object (three.webgpu.js:30181). Aim ~THRESHOLD instances per tile so the
// per-object costs amortise; cap the edge so the distance falloff keeps its
// granularity; refuse to tile strokes that cannot fill tiles (their
// whole-stroke sphere from wireFieldCulling already culls them).
//
// Every tile's instanceMatrix is ALLOCATED past the uniform-buffer limit —
// the shader path reads the attribute ALLOCATION, never the live draw
// count (three.webgpu.js:18031/:18041): at or below the limit the identity
// matrices become a uniform array with the COUNT BAKED INTO THE WGSL TEXT,
// a distinct program (and GPURenderPipeline) per tile size; above it they
// ride an interleaved instanced attribute whose program is
// count-independent, so every tile of a material shares ONE program and
// pipelines dedupe by source (:32003/:32248). ≤65KB of identity matrices
// per tile buys that, uploaded once — and the matrix data stays
// semantically live (normalLocal transforms through it; identity is the
// engine's contract). The sliced instanced attributes keep their REAL
// counts: the draw's instanceCount comes from live object.count
// (three.webgpu.js:29971-29973), which never exceeds them.

// §22 grassdiag toggles — normal operation leaves all of these alone
let pushersFrozen = false;
let lodForce = null;               // null | 'near' | 'far'
let diagScope = null;              // {near, far} density multipliers by diag band
const DIAG_SCOPE_EDGE = 20;        // m — grassdiag's near/far split (was the LOD
                                   // band edge until §22f retired the swap)
export function freezePushers(on) { pushersFrozen = !!on; }
export function forceBladeLod(mode) { lodForce = mode ?? null; }   // takes effect within one 300ms tile tick
/** §22c: scope a density cut to the near ring or the far sea — the spatial
 *  discriminator (WHERE does a density win come from?). null restores. */
export function setDiagDensityScope(scope) { diagScope = scope ?? null; }

const TILE_MIN_INSTANCES = 2000;   // shrubs/yucca are hundreds — stay whole
const TILE_MAX_EDGE = 28;          // m — §22h: the nearest-edge budget over-submits
                                   // by ~the tile radius's worth of curve, and
                                   // dither-killed instances aren't free (the Air's
                                   // round-6 regression) — smaller tiles halve the
                                   // waste while the dither keeps them invisible
const TILE_MIN_OCC = 256;          // can't reach this per tile → stay whole
const TILE_MAX_AXIS = 12;          // §22n: was 8 (§13.2). Finer tiles pin the
                                   // nearest-edge budget to the dither curve:
                                   // measured on the lush meadow at 2×, 12×12
                                   // submits 7.3k fewer instances for +2fps,
                                   // visible density identical; 16 adds nothing
                                   // (the residual waste is the curve's own
                                   // integral, not tile granularity).
// §22d: tel0s's Air convicted the FAR SEA's instance count outright —
// far-only density 35% recovered 46→61fps/worst 17 (identical to
// grass-hidden) while blade-thinning the same tiles bought +3. Distant
// tufts are subpixel cards: near-pure per-instance overhead and 2×2
// quad-overshading waste. At distance the meadow wants FEWER, not
// thinner. The old linear 30→140m curve was inert on a field that fits
// inside ~60m (tile centers all scored ~0.8) — quadratic, starting
// closer, done sooner: d=40m → ~0.44, d=60m → ~0.16.
const GRASS_NEAR = 15;             // full density inside this
const GRASS_FAR = 90;              // invisible beyond this
const GRASS_FALL_EXP = 2.5;        // the curve's bite — shared with the shader's
                                   // per-instance dither (§22f) so the CPU budget
                                   // and the visible density are the same law
const BLADE_LOD_KEEP = 0.4;        // far tiles keep ceil(0.4 × perBunch) blades per tuft (§17b)
// §22f: the per-tile blade-COUNT swap is RETIRED — it was the second visible
// pop (a whole tile flipping 8→4 blades), and round 3 proved blade count
// nearly free while the shader dither took over all density shaping.
//
// §22n: the swap machinery returns with a DIFFERENT far twin — the coarse
// index keeps EVERY blade at 2 segments instead of 4 (loops 0→2→4, 6 of 10
// verts referenced; no count change → no §22d pop). Built on the theory
// that opaque blades (§22m) would shift the bill to the vertex program —
// then MEASURED INERT on the Air (44/44 vs 44-45 at 2×, drift-controlled,
// 22/60 tiles engaged and verified wearing the 96-entry twin): the M5's
// vertex throughput acquits vertex count for the THIRD time (§22c blade
// thinning +3, §22f swap retirement, now this). Default OFF on the
// evidence; ?grassvlod=on is the opt-in for vertex-bound GPU tiers, and
// the coarse twin doubles as a diag lever via forceBladeLod('far').
// §22q: shaped resident density — tel0s's diag put the remaining grass cost
// in the near/mid instance count (density 35% recovered 41→58fps while sky/
// terrain/physics measured ≈free). Uniform thinning is the ugly version; the
// shaped lever thins by DENSE_BASE at every distance through the §22h rank
// dither, widens survivors by 1/√DENSE_BASE (width only — constant coverage,
// unchanged height envelope), and holds a full-density guard ring at the
// camera's feet where a missing tuft is individually legible. The CPU tile
// budget follows the same law (denseAt at the tile's NEAREST point, so the
// budget is never the bottleneck) — that's where the submitted-instance win
// comes from. ?grassdense=N (0..1] overrides; 1 is the kill switch
// (byte-identical shader, untouched budgets).
const DENSE_DEFAULT = 0.65;        // §22q probe (real-meadow scale, 2940×1912
                                   // @2×, drift-controlled): 1.0 → 52fps,
                                   // 0.8 → 60 but dipping (lo 52), 0.65 → a
                                   // locked 60-61 at 30% fewer submitted
                                   // instances; screenshot means Δ ≤ 0.5 RGB.
                                   // The least thinning that holds the cap.
export const DENSE_BASE = (() => {
  const v = Number(CONFIG.params.get('grassdense'));
  return Number.isFinite(v) && v > 0 && v <= 1 ? v : DENSE_DEFAULT;
})();
const DENSE_GUARD_NEAR = 2;        // m — full density inside this…
const DENSE_GUARD_FAR = 8;         // m — …ramped to DENSE_BASE by this
/** CPU mirror of the shader's guard ramp: the density factor at distance d. */
const denseAt = (d) => {
  if (DENSE_BASE >= 1) return 1;
  const t = Math.min(1, Math.max(0, (d - DENSE_GUARD_NEAR) / (DENSE_GUARD_FAR - DENSE_GUARD_NEAR)));
  return 1 + (DENSE_BASE - 1) * t * t * (3 - 2 * t);   // smoothstep, same knots
};
const VLOD_ON = CONFIG.params.get('grassvlod') === 'on';
const BLADE_LOD_OUT = VLOD_ON ? 45 : Infinity;   // m — tile swaps to coarse past this
const BLADE_LOD_IN = VLOD_ON ? 38 : Infinity;    // m — and back only inside this
const _tv = new THREE.Vector3();

/** The uniform-vs-attribute fork for the identity instanceMatrix, read off
 *  the live backend (WebGPU: device.limits.maxUniformBufferBindingSize —
 *  65536 with three's default device request; WebGL2 fallback:
 *  MAX_UNIFORM_BLOCK_SIZE). `threshold` is the occupancy the grid aims for;
 *  `cross` is the smallest ALLOCATION that takes the shared-program
 *  attribute path — 0 when an exotic limit would make forcing it wasteful
 *  (tiles then keep per-size programs: degraded, never wrong). */
function matrixPathCaps() {
  let limit = 65536;
  try { limit = renderer.backend.capabilities.getUniformBufferLimit() || 65536; }
  catch { /* pre-init or stubbed backend — assume the WebGPU default */ }
  const threshold = Math.floor(Math.min(65536, limit) / 64);
  const cross = Math.floor(limit / 64) + 1;
  return { threshold, cross: cross * 64 <= 262144 ? cross : 0 };
}

function tileField(f, bladeLod = false) {
  // the shrub archetype pairs a stem mesh sharing backing arrays — skip it
  if (f.stemMesh || (f.count ?? 0) < TILE_MIN_INSTANCES) return false;
  const src = f.mesh.geometry;
  const names = ['aPosRot', 'aScaleVar', 'aPhase'];
  const inst = names.map((n) => src.getAttribute(n));
  if (inst.some((a) => !a)) return false;
  const posRot = inst[0], scaleVar = inst[1];
  const n = f.count;
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity, maxScale = 1;
  for (let i = 0; i < n; i++) {
    const x = posRot.getX(i), z = posRot.getZ(i);
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
    const s = scaleVar.getY(i);
    if (s > maxScale) maxScale = s;
  }
  const spanX = (maxX - minX) || 1, spanZ = (maxZ - minZ) || 1;
  const { threshold, cross } = matrixPathCaps();
  // as many tiles as the stroke affords at ~threshold occupancy, spread by
  // aspect; the edge cap may then ADD columns/rows a sparse stroke cannot
  // afford — which is exactly what the occupancy floor below refuses
  const afford = Math.max(1, Math.floor(n / threshold));
  // ?grasstiles=N — §22n diag override: finer tiles pin the nearest-edge
  // budget (§22h) tighter to the true dither curve, at more draw calls
  const axisCap = Number(CONFIG.params.get('grasstiles')) || TILE_MAX_AXIS;
  let nx = Math.min(axisCap, Math.max(1, Math.round(Math.sqrt(afford * spanX / spanZ))));
  let nz = Math.min(axisCap, Math.max(1, Math.round(afford / nx)));
  nx = Math.max(nx, Math.ceil(spanX / TILE_MAX_EDGE));
  nz = Math.max(nz, Math.ceil(spanZ / TILE_MAX_EDGE));
  if (nx * nz < 4) return false;     // culling can't win on a postage stamp
  if (n / (nx * nz) < TILE_MIN_OCC) return false;   // sparse: stroke sphere already culls
  const buckets = Array.from({ length: nx * nz }, () => []);
  for (let i = 0; i < n; i++) {      // STABLE scan — preserves the shuffle
    const tx = Math.min(nx - 1, Math.floor((posRot.getX(i) - minX) / spanX * nx));
    const tz = Math.min(nz - 1, Math.floor((posRot.getZ(i) - minZ) / spanZ * nz));
    buckets[tz * nx + tx].push(i);
  }
  src.computeBoundingBox();          // per-plant LOCAL bounds (tiny)
  const plantH = Math.max(0.5, src.boundingBox.max.y - Math.min(0, src.boundingBox.min.y));
  const pad = plantH * maxScale + 0.6;   // tallest plant + the wind/push lean ceiling
  // §17b — ONE far-LOD index per STROKE: the count falloff thins INSTANCES;
  // this thins BLADES PER TUFT on the instances that remain. Whole 24-entry
  // blade runs, evenly strided, still pointing into the SHARED vertex
  // buffers (flora_lod.js re-verifies the run layout entry by entry — a
  // reshaped upstream degrades to no LOD, never a torn tuft). Every tile's
  // far twin wears this same attribute object, so the whole stroke pays one
  // extra GPU index buffer (~kept×24 entries) and nothing else.
  let farIndex = null;
  if (bladeLod) {
    const srcIdx = src.getIndex();
    // §22n: the far twin is the COARSE index (every blade, 2 segments) —
    // the count-subset builder stays available for diag/weak-tier use
    const sub = srcIdx && (bladeCoarseIndex(srcIdx.array, src.getAttribute('position').count)
      ?? bladeLodIndex(srcIdx.array, src.getAttribute('position').count, BLADE_LOD_KEEP));
    if (sub) farIndex = new THREE.BufferAttribute(sub, 1);
  }
  const container = new THREE.Group();
  container.userData = { ...f.mesh.userData };
  const tiles = [];
  const lodGeos = new Map();         // tile → { near, far } geometry twins (§17b)
  const m4 = new THREE.Matrix4();
  for (const idx of buckets) {
    if (!idx.length) continue;
    const tg = new THREE.BufferGeometry();
    tg.setIndex(src.getIndex());
    for (const name of ['position', 'normal', 'uv', 'aH', 'color']) {
      const a = src.getAttribute(name);
      if (a) tg.setAttribute(name, a);   // SHARED objects — one GPU upload
    }                                    // 'color': §22m opaque blades bake
                                         // Sol's palette per vertex — a tile
                                         // without it draws BLACK (attribute
                                         // reads of a missing binding)
    const box = new THREE.Box3();
    names.forEach((name, j) => {
      const a = inst[j], sz = a.itemSize;
      const arr = new a.array.constructor(idx.length * sz);
      for (let k = 0; k < idx.length; k++) {
        for (let c = 0; c < sz; c++) arr[k * sz + c] = a.array[idx[k] * sz + c];
      }
      tg.setAttribute(name, new THREE.InstancedBufferAttribute(arr, sz));
    });
    // §22f: draw-order rank into the flutter-phase lane, PER TILE — the
    // shader dither (vegetation lodGrow.exp) keeps an instance iff
    // rank < keep(distance), which is exactly this tile's count-prefix
    // refined continuously: no double-thinning, no tile seams. The rank
    // rides as phase (×2π) so the flutter stays uniform per location —
    // the order IS the density shuffle, spatially random.
    {
      const ph = tg.getAttribute('aPhase');
      if (ph) for (let k = 0; k < idx.length; k++) ph.array[k * 3] = (Math.PI * 2 * k) / idx.length;
    }
    for (const i of idx) box.expandByPoint(_tv.set(posRot.getX(i), posRot.getY(i), posRot.getZ(i)));
    box.expandByScalar(pad);
    // allocation crosses the uniform-buffer limit → one shared program for
    // every tile of this material (see the section header)
    const alloc = Math.max(idx.length, cross);
    const tm = new THREE.InstancedMesh(tg, f.mesh.material, alloc);
    for (let k = 0; k < alloc; k++) tm.setMatrixAt(k, m4.identity());   // the engine's identity contract
    tm.count = idx.length;             // the DRAW count is live; the allocation is not
    const sphere = box.getBoundingSphere(new THREE.Sphere());
    tm.boundingSphere = sphere;        // frustum culling (tiles carry identity
    // transforms, so local == world) — and the SAME sphere on the geometry:
    // the render sort reads geometry.boundingSphere, not the object's
    // (three.webgpu.js:60872-60880), and the shared plant-local position
    // attribute would sort every tile as co-located at the origin, leaving
    // the alpha-tested meadow in arbitrary order. Both assigned non-null,
    // so neither is ever recomputed (raycasts never touch grass).
    tg.boundingSphere = sphere;
    tm.frustumCulled = true;
    Object.assign(tm.userData, f.mesh.userData);   // noWalkable/noSupportCheck/…
    tm.castShadow = false;
    tm.receiveShadow = f.mesh.receiveShadow;
    tm.userData.fullCount = idx.length;
    // §17b — the tile's far-LOD twin: the same shared vertex attribute
    // objects, the SAME sliced instanced attribute objects (zero copies —
    // the density shuffle permuted instanced data before tiling, and an
    // index addresses per-vertex data only), the stroke's one far index.
    // The attribute LAYOUT is identical to the near twin's, and every
    // layout key in the vendored renderer is built from names/formats plus
    // an index PRESENCE flag — never the index object's identity
    // (three.webgpu.js:30035-30081, :81752-81780) — so the swap re-keys
    // nothing: zero new programs, zero new pipelines (see applyTiles).
    if (farIndex) {
      const fg = new THREE.BufferGeometry();
      fg.setIndex(farIndex);           // per-STROKE object, shared by every tile
      for (const name of ['position', 'normal', 'uv', 'aH', 'color']) {
        const a = src.getAttribute(name);
        if (a) fg.setAttribute(name, a);
      }
      for (const name of names) fg.setAttribute(name, tg.getAttribute(name));
      // the render sort reads geometry.boundingSphere (:60872-60880) and
      // culling reads the object's — the twin shares the SAME sphere object
      // as the near geometry, so both stay true across every swap
      fg.boundingSphere = sphere;
      tm.userData.lodFar = false;      // observable per-tile state (EW.grass)
      lodGeos.set(tm, { near: tg, far: fg });
    }
    container.add(tm);
    tiles.push(tm);
  }
  // the container answers for the stroke: #74's applied-truth reads .count
  Object.defineProperty(container, 'count', {
    get: () => tiles.reduce((s, t) => s + (t.visible ? t.count : 0), 0),
  });
  const origDispose = f.dispose;
  f.mesh = container;
  f.tiled = true;
  f.tiles = tiles;
  let eff = 1;
  const applyTiles = () => {
    for (const t of tiles) {
      const d = _tv.copy(t.boundingSphere.center).distanceTo(camera.position);
      // §22f: the CPU count is a BUDGET evaluated at the tile's NEAREST
      // point (keep(dNearest) ≥ keep(d) for every instance in it), and the
      // shader dither shapes the VISIBLE density per instance at the exact
      // same curve (GRASS_FALL_EXP, vegetation lodGrow.exp) — the budget is
      // never the bottleneck and tile seams vanish. Also fixes a subtle
      // over-cull: a tile whose CENTER passed GRASS_FAR used to hide while
      // its near half was still inside. Exponent 2.5 (§22e): round-4 diag
      // measured both rings safe at 0.35; the shader grow covers the look.
      const dN = Math.max(0.01, d - t.boundingSphere.radius);
      const fall = dN >= GRASS_FAR ? 0
        : dN <= GRASS_NEAR ? 1
          : (1 - (dN - GRASS_NEAR) / (GRASS_FAR - GRASS_NEAR)) ** GRASS_FALL_EXP;
      const scope = diagScope ? (d < DIAG_SCOPE_EDGE ? diagScope.near : diagScope.far) : 1;
      // §22q: denseAt at the nearest point ≥ the shader's keep multiplier for
      // every instance in the tile — budget stays a ceiling, never a seam
      t.count = densityCount(t.userData.fullCount, eff * fall * scope * denseAt(dN));
      t.visible = t.count > 0;
      // §17b — blade LOD rides the same distance one band later, with
      // hysteresis. The swap is a pointer write, never a compile: the live
      // render object mutates in place and keeps its pipeline outright
      // (three.webgpu.js:30430-30434 setGeometry, :32305-32309 +
      // :81690-81744 — the backend's needsRenderUpdate never looks at
      // geometry), and even a cold re-key lands on the same cached
      // program/pipeline because both twins share one attribute layout.
      // t.count semantics are untouched (#74): instances ride the count,
      // blades ride the index — independent dimensions.
      const pair = lodGeos.get(t);
      if (pair) {
        // lodForce (§22 grassdiag) overrides the distance bands; null = the
        // normal hysteresis, restated: a far tile stays far until it comes
        // inside IN, a near tile stays near until it passes OUT
        const wantFar = lodForce ? lodForce === 'far'
          : (t.userData.lodFar ? d > BLADE_LOD_IN : d >= BLADE_LOD_OUT);
        if (wantFar && !t.userData.lodFar) {
          t.geometry = pair.far; t.userData.lodFar = true;
        } else if (!wantFar && t.userData.lodFar) {
          t.geometry = pair.near; t.userData.lodFar = false;
        }
      }
    }
  };
  f.setDensity = (k) => { eff = k; applyTiles(); };
  f._applyTiles = applyTiles;        // warmField re-settles counts post-warm
  let lastTick = 0;
  f._tileTick = () => {              // buildFloraField hangs this on autoHooks
    const now = performance.now();
    if (now - lastTick < 300) return;
    lastTick = now;
    applyTiles();
  };
  applyTiles();
  f.dispose = () => {
    for (const t of tiles) {                       // teardown-only: shared
      const pair = lodGeos.get(t);                 // buffers die with the field;
      if (pair) (t.geometry === pair.far ? pair.near : pair.far).dispose();
      t.geometry.dispose();                        // …the unmounted LOD twin too
    }
    origDispose?.call(f);
  };
  return true;
}

// ---- pushers ---------------------------------------------------------------
// The brush's own interaction model: up to 4 pusher slots part the plants
// around moving bodies. Slot 0 is the local avatar; the rest are the nearest
// remote presences. Per-frame and cheap (a uniform write).
function wirePushers(field) {
  const R = 1.1;
  // reused across frames — this hook ran every frame allocating two arrays
  // and sorting all remotes to keep 4 pusher slots (§14.1 offender #4)
  const list = [];
  const cand = [];
  const hook = () => {
    list.length = 0;
    // diag freeze (§22 grassdiag): an empty pusher list zeroes the per-vertex
    // displacement work in the shader — the A/B that answers "is it the
    // pushers?" on a GPU-bound machine
    if (pushersFrozen) { field.setPushers(list); return; }
    if (myState?.pos) list.push({ x: myState.pos.x, y: myState.pos.y, z: myState.pos.z, r: R });
    if (remotes?.size) {
      cand.length = 0;
      for (const [, rb] of remotes) {
        const p = rb?.avatar?.root?.position;
        if (p) cand.push(p);
      }
      if (myState?.pos && cand.length > 3) {
        cand.sort((a, b) => a.distanceToSquared(myState.pos) - b.distanceToSquared(myState.pos));
      }
      for (let i = 0; i < Math.min(3, cand.length); i++) {
        const p = cand[i];
        list.push({ x: p.x, y: p.y, z: p.z, r: R });
      }
    }
    field.setPushers(list);
  };
  pushHostHook(hook);
  return hook;
}

// ---- the field -------------------------------------------------------------

/** Build a flora field from a `grass` verb bag. Returns a field shaped to
 *  terrain.js's setGrass contract: { mesh, material, update, autoHooks,
 *  setDensity, dispose }. The mesh is added to the scene here; setGrass owns
 *  removing and disposing it. */
export async function buildFloraField(rawArgs, { scene, heightFn }) {
  const mod = await loadFloraModule();
  const args = mapGrassArgs(rawArgs);
  const strokes = presetStrokes(args);
  const species = [...new Set(strokes.map((st) => st.species ?? 'grass'))];
  for (const sp of species) await ensureFloraAssets(mod, sp);
  // the grass verb is a world singleton: each build starts a fresh occupancy
  // registry, or a replaced field's plants would still claim their ground
  mod.resetFloraOccupancy();
  const W = args.width ?? args.size ?? 30, D = args.depth ?? args.size ?? 30;
  const mask = makeClearingMask(W, D);
  const group = new THREE.Group();
  const fields = [];
  try {
    for (const st of strokes) {
      // §22e: blades-archetype strokes are the tileable ones the count
      // falloff cuts — the shader's density-compensation grow (upstream
      // opts.lodGrow) makes the survivors cover for the removed: constants
      // MATCH the falloff's so the two halves of the trade stay coupled.
      // Shrubs/yucca are untiled (no falloff) and get no grow.
      //
      // §22i A/B kill-switch (round-7 anomaly: density-35% stopped
      // recovering — either the 22h shader costs more than it saves on
      // Metal, or the Air was thermally throttled; two reloads on the same
      // machine state decide):
      //   ?grasslod=off       no lodGrow at all — the pre-§22e shader
      //   ?grasslod=nodither  grow only (the §22e shader, no rank/blade dither)
      //   (default)           the full §22h shader
      const lodMode = CONFIG.params.get('grasslod') ?? 'full';
      // §22l: the blades fragment diet (upstream opts.fastShade — one albedo
      // sample; no relief/rough/SSS fetches a 4cm blade could never show).
      // ?grassshade=full restores upstream's four-fetch material for A/B.
      const shadeMode = CONFIG.params.get('grassshade') ?? 'fast';
      // §22m (this branch): opaque geometry blades — Sol's silhouette via the
      // fitted envelope, Sol's palette baked to vertex colors, zero alpha
      // test. ?grassgeo=cards boots the atlas-card meadow for the A/B.
      const geoMode = CONFIG.params.get('grassgeo') ?? 'opaque';
      const isBladeSpecies = mod.FLORA_SPECIES?.[st.species]?.archetype === 'blades';
      const blades = isBladeSpecies && lodMode !== 'off';
      const f = await mod.createFlora({
        ...st, heightFn,
        ...(blades ? { lodGrow: { near: GRASS_NEAR, far: GRASS_FAR, cap: 1.7,
          ...(lodMode !== 'nodither' ? { exp: GRASS_FALL_EXP, vertsPerBlade: 10, bladeKeepFar: 0.4,
            // §22q: the shaped resident density rides the dither — see the
            // DENSE_BASE block above; absent (=1) the shader is byte-identical
            ...(DENSE_BASE < 1 ? { baseKeep: DENSE_BASE,
              guardNear: DENSE_GUARD_NEAR, guardFar: DENSE_GUARD_FAR } : {}),
          } : {}),
        } } : {}),
        ...(isBladeSpecies && shadeMode === 'fast' ? { fastShade: true } : {}),
        ...(isBladeSpecies && geoMode === 'opaque' ? { opaqueBlades: true } : {}),
      });
      // named so an applied-truth report (#74) can identify the stroke
      f.strokeLabel = `${fields.length}:${st.species ?? 'grass'}`;
      // §22m: report the material generation the stroke ACTUALLY built —
      // read from the material, never from the options (the palette
      // sampler can fall back silently, and three screenshot rounds once
      // compared cards to cards because nothing surfaced that)
      f.grassMode = !isBladeSpecies ? 'n/a'
        : f.material?.alphaTest === 0 ? 'opaque'
        : f.material?.type === 'MeshSSSNodeMaterial' ? 'cards-sss' : 'cards-fast';
      if (isBladeSpecies) console.log(`[flora] ${f.strokeLabel} blades mode: ${f.grassMode}`);
      wireDensityDial(f);
      mask.wire(f.material);
      // big blade/corn strokes tile (per-tile culling + distance density);
      // small ones keep the whole-stroke sphere from G1. Only the 'blades'
      // archetype carries blade-LOD twins (§17b) — corn/shrub/yucca
      // geometry has no per-blade run structure to subset
      const arch = mod.FLORA_SPECIES[st.species ?? 'grass']?.archetype;
      if (!tileField(f, arch === 'blades')) {
        wireFieldCulling(f);
        // §22f: untiled strokes get the whole-stroke draw-order rank in the
        // flutter lane (the tiled path writes it per tile) — the shader
        // dither needs it wherever lodGrow.exp rides
        const ph = f.mesh?.geometry?.getAttribute?.('aPhase');
        if (ph && f.count) {
          for (let k = 0; k < f.count; k++) ph.array[k * 3] = (Math.PI * 2 * k) / f.count;
          ph.needsUpdate = true;
        }
      }
      group.add(f.mesh);
      fields.push(f);
    }
  } catch (e) {
    // a half-built field must not leak its listener or its finished strokes
    for (const f of fields) f.dispose?.();
    mask.dispose();
    throw e;
  }
  const field = composeField({ group, fields, mask });
  field._strokes = fields;   // warmField re-settles per-tile falloff after the warm
  field.autoHooks.push(wirePushers(field));   // setGrass unhooks everything the field owns
  for (const f of fields) {
    if (f._tileTick) { pushHostHook(f._tileTick); field.autoHooks.push(f._tileTick); }
  }
  // the sky's scene-diff claim must never own the meadow (§17c) — a grass
  // build regularly overlaps an async sky build at boot
  group.userData.skyExempt = true;
  scene.add(group);
  return field;
}

// ---- the warm (§16.2.B) -----------------------------------------------------
// compileAsync skips visible=false and out-of-frustum objects
// (three.webgpu.js:60819/:60869), and applyTiles has already run against the
// boot camera by the time the field compiles — a field-level compileAsync
// leaves every culled tile COLD, and a cold tile codegens SYNCHRONOUSLY
// inside the first render() that looks at it: the jank that used to follow
// the resident around the first minute. So the warm is per render object,
// house pattern (sky.js:450-453): each object compiles detached with its
// culling defeated, one real frame between objects. Three yields ~10 rAF
// frames per object internally (NodeBuilder stage yields), so the field
// warms in ~K×10 background frames — and NO tile is ever cold after.
//
// Blade-LOD twins (§17b) need no second pass: one warm per tile covers both
// geometry variants. The node builder caches on the render object's initial
// cache key, whose geometry part is LAYOUT-only — sorted attribute names/
// formats plus an index PRESENCE flag, never the index object
// (three.webgpu.js:30035-30081 via :54283-54286) — and the pipeline cache
// key is stage ids + the same layout-keyed backend key (:32248-32251,
// :81752-81780), so the far twin key-matches everything the near warm
// already built; on the live swap the render object keeps its compiled
// pipeline outright (:32305-32309, :81690-81744). The far index buffer
// itself uploads at first use — a few hundred bytes per stroke, keyed on
// the shared attribute object (:31031-31043), not a compile.

/** Compile every render object of a built field (tiles, untiled stroke
 *  meshes, shrub stems) off the render path, then re-settle tile counts
 *  against the live camera. Awaited by the grass build (world.js) between
 *  prepareObject and setGrass; errors are swallowed like every house warm. */
export async function warmField(field, renderer, camera, scene) {
  const root = field?.mesh;
  if (!root) return;
  const meshes = [];
  root.traverse((o) => { if (o.isMesh) meshes.push(o); });
  // the whole field leaves the scene for the duration — a real frame
  // mid-warm must never meet a still-cold sibling and pay its compile
  // synchronously inside render()
  const sceneParent = root.parent;
  sceneParent?.remove(root);
  try {
    for (const o of meshes) {
      const parent = o.parent;
      parent?.remove(o);               // detached: never drawn mid-compile —
      const save = { visible: o.visible, frustumCulled: o.frustumCulled, count: o.count };
      o.visible = true;                // …compileAsync(o, …) still walks it
      o.frustumCulled = false;
      if (o.isInstancedMesh && o.count < 2) o.count = 2;  // count-0 tiles still compile
      try {
        await renderer.compileAsync(o, camera, scene).catch(() => {});
      } finally {
        o.visible = save.visible;
        o.frustumCulled = save.frustumCulled;
        if (o.isInstancedMesh) o.count = save.count;
        parent?.add(o);
      }
      // a REAL frame between objects — scheduler.yield-style continuations
      // starve rAF on Chromium; the warm must breathe with the renderer
      await new Promise((r) => requestAnimationFrame(r));
    }
  } finally {
    sceneParent?.add(root);
  }
  // tile counts/visibility were settled at BUILD time against the boot
  // camera — re-settle now that every tile is warm and the camera is live
  for (const f of field._strokes ?? []) f._applyTiles?.();
}
