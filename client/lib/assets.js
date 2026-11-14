// assets — every byte the client pulls, and the host shims that let toolkit modules run unmodified in a browser.
// Four caches, keyed by library path, each download+parse once:
//   byteCache  raw bytes (progress into the loading tray)
//   glbCache   parsed GLB prototypes; every use gets a skeleton clone
//   vrmaCache  animation bytes, retargeted per VRM at use
//   vrmPool    whole parsed VRMs at rest (a bound rig has no clone, so released bodies are reworn intact)

import { keyFromVersion, negotiate, lodFromVersion } from '../../shared/ktx2.js';
import { tierOf, askFor } from './render/lod_policy.js';
import { awaitBodyGate, bodyGateArmed, bodyGateOpen } from './render/bodygate.js';
// ?bodyfirst=0: world parses stop waiting for the body (A/B measurement, body-less tests)
const BODY_FIRST = CONFIG.params.get('bodyfirst') !== '0';
import { THREE, renderer, camera, scene } from './core.js';
import { report, bus, CONFIG } from './base.js';
import { versionReady } from './version.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';
import { VRMLoaderPlugin, VRMUtils } from '@pixiv/three-vrm';
import { MToonMaterialLoaderPlugin } from '@pixiv/three-vrm-materials-mtoon';
import { MToonNodeMaterial } from '@pixiv/three-vrm-materials-mtoon/nodes';
import { parsePoseAnimation, retargetPoseAnimation } from './avatar/poseclips.js';
import { CLIP_SLOTS, CLIP_FILES, CLIP_SPEED } from '../../shared/clipdefs.js';
export { CLIP_SLOTS, CLIP_FILES, CLIP_SPEED } from '../../shared/clipdefs.js';
import { clone as skeletonClone } from 'three/addons/utils/SkeletonUtils.js';
import { beginWork, enqueue, nextFrame, loadNote } from './render/loadwork.js';
import { warm } from './render/warmqueue.js';
import { prepareObject } from './render/materials.js';
import { registerFoliage } from './vegetation/foliage.js';
import { markDrawBatchSource } from './render/draw_batches.js';
import { libRelOf, modelWord } from '../../shared/eido.js';

// ---- loading tray -----------------------------------------------------------
// every in-flight asset (downloads with bytes, builds as spinners); ui.js renders it, this owns the data

const loads = new Map(); // key -> { label, done, total }
// cumulative, for the boot bar: per-asset entries vanish on finish, so `loads` alone would leap backwards
const bytes = { done: 0, total: 0 };
export const bootBytes = () => ({ ...bytes });
export const loadingItems = () => [...loads.values()];
function announce() { bus.emit('loading', loadingItems()); }
export function loadTrack(key, label) { loads.set(key, { label, done: 0, total: 0 }); announce(); }
function loadProgress(key, done, total) {
  const l = loads.get(key);
  if (!l) return;
  if (total && !l.total) bytes.total += total;       // count each asset once
  bytes.done += Math.max(0, done - l.done);
  l.done = done; l.total = total;
  announce();
}
export function loadDone(key) { loads.delete(key); announce(); }

// ---- demand activity ----------------------------------------------------------
// prefetch.js must never cost a real load: 'demand' aborts its stream; demandState() parks it until the network is quiet

let demandActive = 0;
let lastDemandAt = 0;
export const demandState = () => ({ active: demandActive, last: lastDemandAt });
function demandStart() { demandActive++; lastDemandAt = performance.now(); bus.emit('demand'); }
function demandEnd() { demandActive = Math.max(0, demandActive - 1); lastDemandAt = performance.now(); }

// ---- raw bytes --------------------------------------------------------------

const byteCache = new Map();
export function forgetBytes(match) {
  for (const key of [...byteCache.keys()]) {
    if (!key.includes(match)) continue;
    byteCache.delete(key);
    const s = byteSizes.get(key);
    if (s !== undefined) { byteTotal -= s; byteSizes.delete(key); }   // the ledger forgets too, or byteTotal drifts forever
  }
}

// ---- the byte tier's budget ---------------------------------------------------
// LRU budget on byteCache (JS heap); Map order is the LRU. The HTTP cache keeps the wire bytes, so a re-fetch is a disk read
const BYTE_BUDGET = 128 * 1024 * 1024;
const byteSizes = new Map();   // path -> resolved byteLength, insertion = LRU
let byteTotal = 0;
function touchBytes(path) {
  const size = byteSizes.get(path);
  if (size === undefined) return;
  byteSizes.delete(path);
  byteSizes.set(path, size);
}
function noteBytes(path, len) {
  const prev = byteSizes.get(path);
  if (prev !== undefined) { byteTotal -= prev; byteSizes.delete(path); }   // re-fetch: replace, never double-count
  byteSizes.set(path, len);
  byteTotal += len;
  while (byteTotal > BYTE_BUDGET && byteSizes.size > 1) {
    const oldest = byteSizes.keys().next().value;
    if (oldest === path) break;         // never evict what just landed
    byteTotal -= byteSizes.get(oldest) ?? 0;
    byteSizes.delete(oldest);
    byteCache.delete(oldest);
  }
}

export async function fetchBytes(path) {
  if (byteCache.has(path)) { touchBytes(path); return byteCache.get(path); }
  if (!byteCache.has(path)) {
    byteCache.set(path, (async () => {
      loadTrack(path, path.split('/').pop().split('?')[0]);
      demandStart();
      try {
        // 3 tries on 5xx/network; evict on final failure, or a cached rejection poisons every later ask for the path
        let r;
        for (let attempt = 0; ; attempt++) {
          try { r = await fetch(path); } catch (err) { if (attempt >= 2) throw err; r = null; }
          if (r && (r.ok || r.status < 500 || attempt >= 2)) break;
          await new Promise((res) => setTimeout(res, attempt === 0 ? 700 : 1800));
        }
        if (!r.ok) throw new Error(`fetch ${path}: ${r.status}`);
        const total = Number(r.headers.get('content-length') ?? 0);
        if (r.body && total > 200_000) { // stream big bodies for byte progress
          const reader = r.body.getReader();
          const chunks = [];
          let got = 0;
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            chunks.push(value);
            got += value.length;
            lastDemandAt = performance.now(); // long downloads keep prefetch parked
            loadProgress(path, got, total);
          }
          const buf = new Uint8Array(got);
          let o = 0;
          for (const c of chunks) { buf.set(c, o); o += c.length; }
          noteBytes(path, buf.byteLength);
          return buf.buffer;
        }
        const ab = await r.arrayBuffer();
        noteBytes(path, ab.byteLength);
        return ab;
      } catch (err) { byteCache.delete(path); throw err; }
      finally { loadDone(path); demandEnd(); }
    })());
  }
  return byteCache.get(path);
}

// ---- loaders ----------------------------------------------------------------

// three's own decoder via /node_modules: no third-party origin at run time (the CSP connect-src names none)
const draco = new DRACOLoader().setDecoderPath('/node_modules/three/examples/jsm/libs/draco/gltf/');
// one KTX2 transcoder for every parse site; detectSupport here is safe, core.js awaits renderer.init() first
const ktx2 = new KTX2Loader()
  .setTranscoderPath('/node_modules/three/examples/jsm/libs/basis/')
  .detectSupport(renderer);
/** Whether this GPU negotiates KTX2 variants: prefetch must warm the SAME cache key demand fetches use. */
export const ktx2Capable = () => !!ktx2.workerConfig;
// key from the RUNNING server (/version, version.js), never the shared/ktx2.js it serves: they differ between pull and restart
export const ktx2KeyReady = versionReady.then(keyFromVersion);
/** The running server's geometry-LOD recipe, or null: never ask for a tier the running process didn't declare. */
export const lodRecipeReady = versionReady.then(lodFromVersion);
// resolved, for synchronous reads (the 2 Hz residency sweep can't await); null until or unless /version publishes
let ktx2Key = null, lodRecipe = null;
ktx2KeyReady.then((k) => { ktx2Key = k; }).catch(() => {});
lodRecipeReady.then((r) => { lodRecipe = r; }).catch(() => {});
/** Settles once /version answers or fails; never rejects. */
export const negotiationReady = Promise.all([ktx2KeyReady, lodRecipeReady]).then(() => {}, () => {});
/** Can a lod ask cross the wire now (transcoder, running key and recipe, bare .glb)? Nothing is reported asked that couldn't be. */
export const lodNegotiable = (libPath) => resolveLoadRequest(libPath, 'lod').tier === 'lod';
/** The decision seam of a tiered load: tier wish → URL, asked tier, cache key. test/client/lod-loader-child.ts gates it. */
export function resolveLoadRequest(libPath, tier = 'full') {
  // an eido:sha256/… model fetches /library/eido/sha256/<hex>.glb; the cache keys stay the model value itself
  const ask = askFor({ libPath: libRelOf(libPath), key: ktx2Key, capable: !!ktx2.workerConfig, recipe: lodRecipe, tier });
  return { url: ask.url, tier: ask.tier, glbKey: ask.tier === 'lod' ? `${libPath}#lod` : libPath };
}
/** GPU memory against the proto budget — the policy's "device pressure". */
export const gpuPressure = () => (renderer.info?.memory?.total ?? 0) / GPU_BUDGET;
// loadGLB(lib, { tier: 'full' | 'lod' }) is the only place a tier turns into bytes
/** The running server's key appended when this GPU decodes KTX2 and the asset class is `eligible`; else the bare path. */
async function negotiated(path, eligible) {
  const key = eligible && ktx2.workerConfig ? await ktx2KeyReady : null;
  return negotiate(path, key);
}
export function makeLoader(vrm = false) {   // exported for bench/glbperf-parity.mjs (the client's own loader)
  const l = new GLTFLoader();
  l.setDRACOLoader(draco);
  l.setKTX2Loader(ktx2);
  if (vrm) {
    l.register((p) => new VRMLoaderPlugin(p, {
      mtoonMaterialPlugin: new MToonMaterialLoaderPlugin(p, { materialType: MToonNodeMaterial }),
    }));
  }
  return l;
}

// ---- texture priming --------------------------------------------------------
// a budget-slice of uploads per frame, so the first render doesn't stall; maps are own properties, so Object.values finds them
function collectTextures(obj) {
  const seen = new Set();
  const out = [];
  obj.traverse((o) => {
    const mats = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
    for (const m of mats) {
      for (const v of Object.values(m)) {
        if (v?.isTexture && !seen.has(v)) { seen.add(v); out.push(v); }
      }
    }
  });
  return out;
}
// bytes, not CPU-ms: initTexture returns while the GPU works, so a ms budget would let several 4K maps land in one frame
const TEX_FRAME_BYTES = 16 * 1024 * 1024;
function textureUploadBytes(t) {
  const img = t.image;
  const w = img?.width ?? 0, h = img?.height ?? 0;
  // compressed: bill the literal mip bytes (the w*h*4 estimate over-charges BC7 4×)
  if (t.isCompressedTexture) return t.mipmaps?.reduce((s, m) => s + (m.data?.byteLength ?? 0), 0) || (w * h);
  if (!w || !h) return 4 * 1024 * 1024;   // dimensionless: charge something so a run of unknowns still spreads
  return w * h * 4 * (t.generateMipmaps === false ? 1 : 1.33);
}
async function primeTextures(obj, work) {
  let spent = 0;
  for (const t of collectTextures(obj)) {
    const est = textureUploadBytes(t);
    // `spent > 0`: an oversized texture still uploads, alone in its frame; the budget spreads, never skips
    if (spent > 0 && spent + est > TEX_FRAME_BYTES) {
      await work.yield();
      spent = 0;
    }
    try { renderer.initTexture(t); } catch { /* first bind will get it */ }
    spent += est;
    await work.tick();   // the CPU-ms budget stays too: decode-side cost is real
  }
}

// prime-on-decode: node-graph textures miss collectTextures but all pass loadImageTexture; spreads, never gates
const texPrimeQueue = [];
let texPrimePumping = false;
function queueTexturePrime(tex) {
  texPrimeQueue.push(tex);
  if (texPrimePumping) return;
  texPrimePumping = true;
  (async () => {
    let spent = 0;
    while (texPrimeQueue.length) {
      const t = texPrimeQueue.shift();
      const est = textureUploadBytes(t);
      if (spent > 0 && spent + est > TEX_FRAME_BYTES) {
        await nextFrame();
        spent = 0;
      }
      try { renderer.initTexture(t); } catch { /* disposed/pre-init — bind pays */ }
      spent += est;
    }
    texPrimePumping = false;
  })();
}

export async function loadVRM(libPath, { priority = 1 } = {}) {
  // the pool is consulted first; a hit skips download, parse, skeleton and textures
  const t0 = performance.now();
  const pooled = takePooledVrm(libPath);
  if (pooled) {
    loadNote(`vrm ${libPath.split('/').pop()}: pool-hit — ${Math.round(performance.now() - t0)}ms`);
    return pooled;
  }
  const work = beginWork(`vrm ${libPath.split('/').pop()}`);
  try {
    work.phase('download');
    // bodies negotiate KTX2 like GLBs; the full URL keys byteCache, vrmPool and vrmMeta key on the bare libPath
    const url = await negotiated(libPath, libPath.split('?')[0].endsWith('.vrm'));
    const buf = await fetchBytes(`/library/${url}`);
    work.phase('queued');
    // serialized, yielding between passes so each stall is one pass long; priority 1: people before furniture
    return await enqueue(async () => {
      work.phase('parse');
      const gltf = await new Promise((res, rej) => makeLoader(true).parse(buf, '', res, rej));
      const vrm = gltf.userData.vrm;
      // every bone's rest before anything writes it (avatar.js _rawRest): the skeleton pass drops unweighted joints
      vrm.userData ??= {};
      vrm.userData.boneRest = Object.create(null);   // keyed by node name: constructor or __proto__ is a bone like any other (#297)
      vrm.scene.traverse((o) => {
        if (o.isBone && o.name && !(o.name in vrm.userData.boneRest)) {
          vrm.userData.boneRest[o.name] = { q: o.quaternion.toArray(), p: o.position.toArray(), s: o.scale.toArray() };
        }
      });
      // pool ledger: source bytes are the VRAM proxy the budget counts
      vrmMeta.set(vrm, { libPath, bytes: buf.byteLength });
      await work.yield();
      work.phase('skeleton');
      VRMUtils.combineSkeletons(vrm.scene);
      // SkinnedMesh bounds are bind-pose: a posed multi-primitive body would lose parts to culling
      vrm.scene.traverse((o) => { if (o.isSkinnedMesh) o.frustumCulled = false; });
      VRMUtils.rotateVRM0(vrm); // VRM0 → faces +Z
      // before the first compile, so the final graph shape (MToon wetness, sweep markers) is born with the body
      prepareObject(vrm.scene, { kind: 'body' });
      await work.yield();
      work.phase('textures');
      await primeTextures(vrm.scene, work);
      return vrm;
    }, { lane: 'cpu', priority });
  } finally { work.end(); }
}

// ---- the VRM instance pool --------------------------------------------------
// VRMs can't share a proto (three-vrm binds specific nodes), so the pool shelves whole instances. The pool owns
// disposal: never deepDispose a pooled body elsewhere (black avatar); only eviction disposes.
const vrmPool = new Map();        // libPath -> [{ vrm, bytes, at }], oldest first
const vrmMeta = new WeakMap();    // vrm -> { libPath, bytes }, stamped at parse
const warmedVrms = new WeakSet(); // instances whose pipelines warmed once
const VRM_POOL_MAX = 2;                    // whole parsed bodies held at rest
const VRM_POOL_BYTES = 64 * 1024 * 1024;   // source-byte proxy for their VRAM
let vrmPoolBytes = 0;
let vrmPoolCount = 0;
let vrmPoolEvictions = 0;

/** Instance-keyed: a pooled body skips the conductor; a fresh parse of the same lib has new materials and warms again. */
export const vrmWarmed = (vrm) => warmedVrms.has(vrm);
export const markVrmWarmed = (vrm) => { warmedVrms.add(vrm); };

/** Vendored three-vrm 3.5.2: spring joints guard `delta <= 0`, so the closing update(0) keeps the settled state. */
function resetVrmInstance(vrm) {
  if (vrm.lookAt) { vrm.lookAt.target = null; vrm.lookAt.reset(); }
  vrm.humanoid?.resetNormalizedPose();
  vrm.humanoid?.resetRawPose();
  vrm.expressionManager?.resetValues();
  vrm.scene.updateMatrixWorld(true);   // spring tails derive from world matrices
  vrm.springBoneManager?.reset();
  vrm.update(0);
}

/** Deep-dispose the LRU pooled instance, never `keep`: one over-budget body still pools rather than thrashing. */
function evictOldestPooled(keep = null) {
  let path = null, list = null;
  for (const [p, l] of vrmPool) {
    if (l[0] && (!list || l[0].at < list[0].at)) { path = p; list = l; }
  }
  const oldest = list?.[0];
  if (!oldest || oldest === keep) return false;
  list.shift();
  if (!list.length) vrmPool.delete(path);
  vrmPoolCount--; vrmPoolBytes -= oldest.bytes;
  vrmMeta.delete(oldest.vrm);          // a later stray release deep-disposes, never re-pools
  VRMUtils.deepDispose?.(oldest.vrm.scene);
  vrmPoolEvictions++;
  return true;
}

/** Pools INTACT unless its reset throws (evict, never pool a haunted body) or it never came from loadVRM (dispose now). */
export function releaseVRM(vrm) {
  if (!vrm?.scene) return;
  for (const list of vrmPool.values()) {  // double-release guard, before any mutation
    if (list.some((e) => e.vrm === vrm)) return;
  }
  vrm.scene.parent?.remove(vrm.scene);
  const meta = vrmMeta.get(vrm);
  if (!meta) { VRMUtils.deepDispose?.(vrm.scene); return; }
  try { resetVrmInstance(vrm); } catch (e) {
    console.warn('[vrmpool] reset failed — evicting instead of pooling', e);
    vrmMeta.delete(vrm);
    VRMUtils.deepDispose?.(vrm.scene);
    vrmPoolEvictions++;
    return;
  }
  let list = vrmPool.get(meta.libPath);
  if (!list) vrmPool.set(meta.libPath, list = []);
  const entry = { vrm, bytes: meta.bytes, at: performance.now() };
  list.push(entry);
  vrmPoolCount++; vrmPoolBytes += entry.bytes;
  while ((vrmPoolCount > VRM_POOL_MAX || vrmPoolBytes > VRM_POOL_BYTES)
    && evictOldestPooled(entry)) { /* LRU out until within budget */ }
}

/** Re-resets (a borrower like the thumbnail pass may have posed it); a throw is a miss, never a haunted hit. */
function takePooledVrm(libPath) {
  const list = vrmPool.get(libPath);
  if (!list?.length) return null;
  const entry = list.pop();
  if (!list.length) vrmPool.delete(libPath);
  vrmPoolCount--; vrmPoolBytes -= entry.bytes;
  try { resetVrmInstance(entry.vrm); } catch (e) {
    console.warn('[vrmpool] take-reset failed — re-parsing instead', e);
    vrmMeta.delete(entry.vrm);
    VRMUtils.deepDispose?.(entry.vrm.scene);
    vrmPoolEvictions++;
    return null;
  }
  return entry.vrm;
}

/** Debug shape; rides EW.gpu() via protoStats. */
export const poolStats = () => ({
  instances: vrmPoolCount,
  bytes: vrmPoolBytes,
  budget: { instances: VRM_POOL_MAX, bytes: VRM_POOL_BYTES },
  evictions: vrmPoolEvictions,
  libs: [...vrmPool.entries()].map(([p, l]) => `${p.split('/').pop()}×${l.length}`),
});

// friendly names: the loading tray says "deco desk", not a store hash
export const libLabels = new Map();
/** Library name, else file name; an unnamed old address is "thing", never its hex (shared/eido.js modelWord). */
export const modelName = (model) => modelWord(model, (m) => libLabels.get(m) ?? null);

const glbCache = new Map();
export async function loadGLB(libPath, { tier = 'full' } = {}) {
  // the WIRE decides the tier: a lod wish that can't negotiate is a full load, keyed, fetched and reported as one
  await negotiationReady;
  const req = resolveLoadRequest(libPath, tier);
  tier = req.tier;
  const glbKey = req.glbKey;
  const short = modelName(libPath).slice(0, 28) + (tier === 'lod' ? '·lod' : '');
  loadsInFlight.set(glbKey, (loadsInFlight.get(glbKey) ?? 0) + 1);
  try {
  if (!glbCache.has(glbKey)) {
    const key = `glb:${short}`;
    loadTrack(key, short);
    const p = (async () => {
      const work = beginWork(`glb ${short}`);
      try {
        work.phase('download');
        // a lod ask is never a worse model (the server falls back); the full URL keys byteCache
        const buf = await fetchBytes(`/library/${req.url}`);
        // body first: the PARSE waits for your own body (bodygate.js), capped so nothing can hold the world
        if (BODY_FIRST && bodyGateArmed() && !bodyGateOpen()) {
          work.phase('body-first');
          await awaitBodyGate(12000);
        }
        work.phase('queued');
        return await enqueue(async () => {
          work.phase('parse');
          const gltf = await new Promise((res, rej) => makeLoader(false).parse(buf, '', res, rej));
          // the PROTOTYPE goes through the factory once; clones share its materials and copy its markers
          prepareObject(gltf.scene, { kind: 'model', foliage: false });   // foliage cores go on each clone, below
          markDrawBatchSource(gltf.scene);
          // for the realizer: which cache entry (retain/release/eviction) and which tier the SERVER sent
          gltf.scene.userData.glbKey = glbKey;
          gltf.scene.userData.tierServed = tierOf(gltf.parser?.json, lodRecipe);   // the reducer's stamp, this recipe
          gltf.scene.userData.tierAsked = tier;   // what crossed the wire — the sweep compares against THIS
          await work.yield();
          work.phase('textures');
          await primeTextures(gltf.scene, work);
          return gltf.scene;
        }, { lane: 'cpu', priority: 0 });
      } finally { loadDone(key); work.end(); }
    })();
    // a cached rejection would make one bad fetch an instant-fail loop under the residency sweep's re-promotes
    p.catch(() => { if (glbCache.get(glbKey) === p) glbCache.delete(glbKey); });
    glbCache.set(glbKey, p);
  }
  const proto = await glbCache.get(glbKey);
  const obj = skeletonClone(proto); // safe for rigged + static alike
  registerFoliage(obj);             // per-placement foliage cores (foliage.js)
  // all three compile paths go through the warm conductor (warmqueue.js): a bare compileAsync starves rAF
  if (compiledLibs.has(glbKey)) {
    await warm(`compile ${short}`, () => renderer.compileAsync(obj, camera, scene).catch(() => {}));
    return obj;
  }
  // clones share materials: the first caller compiles, racers await it and cache-hit
  if (!libCompiles.has(glbKey)) {
    // in the tray too: a compile can take seconds (Safari)
    loadTrack(`compile:${glbKey}`, `⚙ ${short}`);
    // per mesh, a real frame between (one multi-material compile is one GPU gulp); unculled: detached clones' matrices are stale
    const p = warm(`compile ${short}`, async () => {
      const meshes = [];
      obj.traverse((o) => { if (o.isMesh) meshes.push(o); });
      for (const mesh of meshes) {
        const culled = mesh.frustumCulled;
        mesh.frustumCulled = false;
        try { await renderer.compileAsync(mesh, camera, scene).catch(() => {}); }
        finally { mesh.frustumCulled = culled; }
        await nextFrame();
      }
    })
      .then(() => compiledLibs.add(glbKey))
      .finally(() => { libCompiles.delete(glbKey); loadDone(`compile:${glbKey}`); });
    libCompiles.set(glbKey, p);
    await p;
    return obj;
  }
  // Await the first compile OUTSIDE the conductor (item-awaits-item deadlocks at concurrency 1), then warm cheaply.
  await libCompiles.get(glbKey).catch(() => {});
  await warm(`compile ${short}`, () => renderer.compileAsync(obj, camera, scene).catch(() => {}));
  return obj;
  } finally {
    const n = (loadsInFlight.get(glbKey) ?? 1) - 1;
    if (n <= 0) loadsInFlight.delete(glbKey); else loadsInFlight.set(glbKey, n);
  }
}
// compiled once is compiled: graph shapes are fixed at birth
const compiledLibs = new Set();
const libCompiles = new Map(); // libPath -> in-flight first compile
// in-flight loads count as references: eviction during a clone's compile yield would dispose its shared proto
const loadsInFlight = new Map();

// ---- proto residency --------------------------------------------------------
// only dispose() frees VRAM: protos are refcounted by clones, zero-ref ones evict over budget
// NEVER call this per-entity: disposal reaches every clone
const libRefs = new Map();     // lib -> count of realized clones in the scene
export function retainGLB(lib) { libRefs.set(lib, (libRefs.get(lib) ?? 0) + 1); }
export function releaseGLB(lib) {
  const n = (libRefs.get(lib) ?? 0) - 1;
  if (n <= 0) libRefs.delete(lib); else libRefs.set(lib, n);
}
const GPU_BUDGET = 1_500_000_000;   // bytes of renderer.info.memory.total
export async function evictIdleProtos() {
  if ((renderer.info?.memory?.total ?? 0) < GPU_BUDGET) return 0;
  let evicted = 0;
  // the VRM pool drains first: pooled bodies are zero-ref by construction
  while ((renderer.info?.memory?.total ?? 0) >= GPU_BUDGET && evictOldestPooled()) evicted++;
  if ((renderer.info?.memory?.total ?? 0) < GPU_BUDGET) return evicted;
  for (const [lib, promise] of [...glbCache]) {
    if (libRefs.has(lib) || loadsInFlight.has(lib)) continue;   // worn, or being fitted
    const proto = await promise.catch(() => null);
    // the awaits yield: re-check before touching anything
    if (libRefs.has(lib) || loadsInFlight.has(lib)) continue;
    glbCache.delete(lib);
    compiledLibs.delete(lib);
    if (proto) {
      const seenMats = new Set();
      proto.traverse((o) => {
        o.geometry?.dispose?.();
        for (const m of Array.isArray(o.material) ? o.material : o.material ? [o.material] : []) {
          if (seenMats.has(m)) continue;
          seenMats.add(m);
          // the factory's shared cloud-noise texture rides the node graph, out of Object.values' reach
          for (const v of Object.values(m)) if (v?.isTexture) v.dispose();
          m.dispose();
        }
      });
      evicted++;
    }
    if ((renderer.info?.memory?.total ?? 0) < GPU_BUDGET) break;
  }
  return evicted;
}
export const protoStats = () => ({
  protos: glbCache.size, referenced: libRefs.size,
  bytesCached: byteSizes.size, byteTotal,
  vrmPool: poolStats(),
});

// ---- VRMA clips -------------------------------------------------------------

// 'fly' and 'soar' are the airborne pair: fallIdle (limbs trailing, no contact), not a run cycle.

const vrmaCache = new Map();
// the seat gate matches this to the server's profile digest: a divergent clip can't wear another's profile
const vrmaSha = new Map(); // slot → hex sha256, present only once resolved
export function vrmaShaLoaded(slot) { return vrmaSha.get(slot) ?? null; }
// ?v=<mtime> from /animations: the only invalidation reaching caches we don't control
// lazy: a top-level fetch would gate the module graph
let clipRoster = null;
function clipPath(file) {
  clipRoster ??= fetch('/animations', { cache: 'no-store' })
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`animations ${r.status}`))))
    .then((list) => new Map(list.map((e) => [e.name, e.path])))
    .catch((e) => {
      console.warn('[clips] roster unavailable — clips load unversioned, and a changed clip may serve stale', e);
      return new Map();
    });
  return clipRoster.then((m) => m.get(file) ?? `eidoverse/assets/animations/${file}.vrma`);
}

export function vrmaBytes(slot) {
  if (!vrmaCache.has(slot)) {
    const p = clipPath(CLIP_FILES[slot] ?? slot).then((rel) => fetchBytes(`/library/${rel}`));
    vrmaCache.set(slot, p);
    p.then(async (buf) => {
      const d = await crypto.subtle.digest('SHA-256', buf);
      vrmaSha.set(slot, [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join(''));
    }).catch(() => { /* fetch failure already surfaces via the caller */ });
  }
  return vrmaCache.get(slot);
}

// the parsed VRMAnimation is avatar-independent: parse once
const vrmaAnimCache = new Map(); // slot -> Promise<VRMAnimation>
function vrmaAnimation(slot, priority = 1) {
  if (!vrmaAnimCache.has(slot)) {
    const p = (async () => {
      const buf = await vrmaBytes(slot);
      const work = beginWork(`vrma ${slot}`);
      try {
        work.phase('queued');
        return await enqueue(async () => {
          work.phase('parse');
          return parsePoseAnimation(buf);
        }, { lane: 'cpu', priority });
      } finally { work.end(); }
    })();
    p.catch(() => vrmaAnimCache.delete(slot)); // a transient failure must not stick
    vrmaAnimCache.set(slot, p);
  }
  return vrmaAnimCache.get(slot);
}

export async function clipFor(vrm, slot, { priority = 1 } = {}) {
  return retargetPoseAnimation(await vrmaAnimation(slot, priority), vrm);
}

// ---- procedural textures ----------------------------------------------------

/** Log verbs name terrain layers as colors (serializable); clients bake the maps locally. */
export function noiseTexture(hex, scale = 0.22) {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const ctx = c.getContext('2d');
  const base = new THREE.Color(hex);
  const img = ctx.createImageData(64, 64);
  for (let i = 0; i < 64 * 64; i++) {
    const n = 1 - scale + Math.random() * scale * 2;
    img.data[i * 4] = Math.min(255, base.r * 255 * n);
    img.data[i * 4 + 1] = Math.min(255, base.g * 255 * n);
    img.data[i * 4 + 2] = Math.min(255, base.b * 255 * n);
    img.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  return tex;
}

// ============================================================================
// The eidoverse module host
// ============================================================================
// Toolkit modules are written for Deno and read files SYNCHRONOUSLY: prime an in-memory file system for those reads

const denoFiles = new Map(); // library-relative path -> Uint8Array
const textDecoder = new TextDecoder();

/** Paths are library-relative ("eidoverse/sky_system.js"); a missing file is reported, not fatal: a world degrades. */
export async function primeFiles(paths, { concurrency = 6 } = {}) {
  const missing = [];
  const q = paths.filter((p) => !denoFiles.has(p));
  await Promise.all(Array.from({ length: Math.min(concurrency, q.length) }, async () => {
    while (q.length) {
      const p = q.shift();
      try {
        // loose images negotiate KTX2; denoFiles keys on the bare path, loadImageTexture sniffs the magic
        const url = await negotiated(p, /\.(png|jpe?g)$/i.test(p));
        const buf = await fetchBytes(`/library/${url}`);
        denoFiles.set(p, new Uint8Array(buf));
      } catch (e) { missing.push(p); }
    }
  }));
  if (missing.length) console.warn('[host] not primed:', missing.join(', '));
  return missing;
}

/** Prefetch lists are discovered, never hardcoded (the no-manifest rule). */
export async function listLibrary(dir) {
  try {
    const r = await fetch(`/library-list?dir=${encodeURIComponent(dir)}`);
    // null, NOT []: an empty directory and an old server without this endpoint are different facts
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}

const normDeno = (p) => String(p).replace(/^\.?\//, '');

globalThis.Deno = {
  readFileSync(p) {
    const f = denoFiles.get(normDeno(p));
    if (!f) throw new Error(`[host] not primed: ${p}`);
    return f;
  },
  readTextFileSync(p) {
    return textDecoder.decode(globalThis.Deno.readFileSync(p));
  },
  async readFile(p) { return globalThis.Deno.readFileSync(p); },
  async readTextFile(p) { return globalThis.Deno.readTextFileSync(p); },
  // writes are swallowed; a later read gets a clear "not primed"
  writeFileSync() {}, writeTextFileSync() {},
  async writeFile() {}, async writeTextFile() {},
  mkdirSync() {}, statSync() { throw new Error('[host] statSync unsupported'); },
  // Engine-side look-dev knobs, not scene parameters: the client supplies only the tier the hardware can hold.
  env: {
    get: (k) => globalThis.__ewEnv?.[k],
    set: (k, v) => { (globalThis.__ewEnv ??= {})[k] = v; },
    has: (k) => globalThis.__ewEnv?.[k] !== undefined,
  },
  // absent, not a stub that pretends to succeed
  Command: class { constructor() { throw new Error('[host] no subprocesses in a browser'); } },
  build: { os: 'browser' },
};

/** The browser side of the toolkit's loadImageTexture (render_scene.mjs), cached per bytes object + opts.
 *  Cached textures are shared, so dispose() is a no-op: a disposed shared texture is black. */
const imageTexCache = new WeakMap(); // bytes object -> Map<opts key, Promise<Texture>>
// the full 12-byte KTX2 identifier, matched byte-for-byte so nothing else routes to the transcoder
const KTX2_MAGIC = [0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a];
globalThis.loadImageTexture = async (bytes, opts = {}) => {
  // only srgb + flipY alter the constructed texture; wrap/anisotropy are caller-side and agree per URL
  const cacheable = typeof bytes === 'object' && bytes !== null;
  const key = `${opts.srgb ? 's' : 'l'}:${opts.flipY !== false ? 'f' : 'n'}`;
  if (cacheable) {
    const hit = imageTexCache.get(bytes)?.get(key);
    if (hit) return hit;
  }
  const p = (async () => {
    const u8 = bytes instanceof Uint8Array ? bytes
      : bytes instanceof ArrayBuffer ? new Uint8Array(bytes)
        : new Uint8Array(bytes);
    // bytes may arrive as KTX2: route by the 12-byte container magic, never the path
    if (u8.length >= 12 && KTX2_MAGIC.every((v, i) => u8[i] === v)) {
      // Flip and colorSpace were baked at encode (server --ktx2-img): don't override colorSpace here.
      // ktx2.parse DETACHES its buffer, so pass a copy: readFileSync returns the same Uint8Array per path.
      const tex = await new Promise((res, rej) => ktx2.parse(u8.slice().buffer, res, rej));
      // As the raster path: repeat wrap; flipY false (the flip is baked); mips and filters come from the container.
      tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
      if (cacheable) {
        tex.userData.ewShared = true;   // served from cache — teardowns must skip it
        tex.dispose = () => {};         // session-pinned, same as the raster path
      }
      queueTexturePrime(tex);           // initTexture sums literal mip bytes
      return tex;
    }
    // the toolkit's contract (render_scene.mjs loadImageTexture): the flip is baked into the pixels and tex.flipY
    // stays false; { flipY: false } skips it for glTF images. Must match, or authored-UV textures arrive mirrored.
    const bitmap = await createImageBitmap(new Blob([u8]), {
      colorSpaceConversion: 'none',
      imageOrientation: opts.flipY !== false ? 'flipY' : 'none',
    });
    const tex = new THREE.Texture(bitmap);
    tex.colorSpace = opts.srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.flipY = false;         // matches the engine's bitmap orientation
    tex.generateMipmaps = true;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.needsUpdate = true;
    if (cacheable) {
      tex.userData.ewShared = true;   // served from cache — teardowns must skip it
      tex.dispose = () => {};         // session-pinned (see above)
    }
    queueTexturePrime(tex);           // upload spread, ahead of the compile
    return tex;
  })();
  if (cacheable) {
    let per = imageTexCache.get(bytes);
    if (!per) imageTexCache.set(bytes, per = new Map());
    per.set(key, p);
    p.catch(() => per.delete(key));   // a transient decode failure must not stick
  }
  return p;
};

// toolkit modules build their own celestial-mesh loader from this global; without it the sky falls back to basic
globalThis.GLTFLoader = GLTFLoader;
globalThis.DRACOLoader = DRACOLoader;
// the configured SINGLETON, not the class: toolkit loaders get the transcoder path + detectSupport they can't redo
globalThis.KTX2Loader = ktx2;

/** GLB bytes → scene, for toolkit modules that load their own meshes. */
globalThis.loadGLBBytes = async (bytes) => {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const gltf = await new Promise((res, rej) =>
    makeLoader(false).parse(u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength), '', res, rej));
  return gltf.scene;
};

// ---- module loading ---------------------------------------------------------

const eidoModules = new Map();
/** Eval-load a toolkit module by name ("terrain.js"); concurrent callers share one fetch. */
export function loadEidoModule(name) {
  if (!eidoModules.has(name)) {
    eidoModules.set(name, (async () => {
      const r = await fetch(`/library/eidoverse/${name}`);
      if (!r.ok) throw new Error(`module ${name}: ${r.status}`);
      const src = await r.text();
      denoFiles.set(`eidoverse/${name}`, new TextEncoder().encode(src)); // self-prime
      (0, eval)(src); // the same indirect-eval hosting as the toolkit's own renderer
    })());
  }
  return eidoModules.get(name);
}

export { VRMUtils, skeletonClone };
