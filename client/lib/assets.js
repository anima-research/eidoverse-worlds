// assets — every byte the client pulls, and the host shims that let Skye's
// toolkit modules run unmodified in a browser.
//
// Four caches, all keyed by library path and all "download+parse once":
//   byteCache  raw bytes (with progress reporting into the loading tray)
//   glbCache   parsed GLB prototypes — every use gets a skeleton clone
//   vrmaCache  animation bytes, retargeted per-VRM at use
//   vrmPool    whole parsed VRM instances at rest (§19b — no clone exists
//              for a bound rig, so released bodies are reworn intact)

import { keyFromVersion, negotiate, lodFromVersion } from '../../shared/ktx2.js';
import { tierOf, askFor } from './lod_policy.js';
import { THREE, renderer, camera, scene } from './core.js';
import { report, bus } from './base.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';
import { VRMLoaderPlugin, VRMUtils } from '@pixiv/three-vrm';
import { MToonMaterialLoaderPlugin } from '@pixiv/three-vrm-materials-mtoon';
import { MToonNodeMaterial } from '@pixiv/three-vrm-materials-mtoon/nodes';
import { VRMAnimationLoaderPlugin, createVRMAnimationClip } from '@pixiv/three-vrm-animation';
import { clone as skeletonClone } from 'three/addons/utils/SkeletonUtils.js';
import { beginWork, enqueue, nextFrame, loadNote } from './loadwork.js';
import { warm } from './warmqueue.js';
import { prepareObject } from './materials.js';
import { markDrawBatchSource } from './draw_batches.js';

// ---- loading tray -----------------------------------------------------------
// Every in-flight asset (downloads with byte progress, builds as spinners) is
// listed so "nothing is happening" never looks like nothing is happening.
// ui.js renders it; this module only owns the data.

const loads = new Map(); // key -> { label, done, total }
// Cumulative byte counters for the boot progress bar. Per-asset entries vanish
// when they finish, so a bar built from `loads` alone would leap backwards
// every time a download completed.
const bytes = { done: 0, total: 0 };
export const bootBytes = () => ({ ...bytes });
export const loadingItems = () => [...loads.values()];
function announce() { bus.emit('loading', loadingItems()); }
export function loadTrack(key, label) { loads.set(key, { label, done: 0, total: 0 }); announce(); }
export function loadProgress(key, done, total) {
  const l = loads.get(key);
  if (!l) return;
  if (total && !l.total) bytes.total += total;       // count each asset once
  bytes.done += Math.max(0, done - l.done);
  l.done = done; l.total = total;
  announce();
}
export function loadDone(key) { loads.delete(key); announce(); }

// ---- demand activity ----------------------------------------------------------
// The background prefetcher (prefetch.js) streams the library into the HTTP
// cache during idle time, and it must never cost a real load a millisecond.
// Every demand fetch marks itself here: the 'demand' event aborts prefetch's
// in-flight stream immediately, and demandState() keeps it parked until the
// network has been quiet for a while.

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
    const s = byteSizes.get(key);   // the ledger forgets too, or byteTotal
    if (s !== undefined) { byteTotal -= s; byteSizes.delete(key); }   // drifts forever (review S1)
  }
}

// ---- the byte tier's budget (§13.3 R3) --------------------------------------
// byteCache retained the raw bytes of everything ever fetched, forever —
// including 29.5MB VRMs after one glance. Pure JS heap, no GPU coupling: an
// LRU with a byte budget reclaims it risk-free. Map iteration order IS the
// LRU (touched entries re-insert at the tail). The HTTP cache still holds
// the wire bytes (immutable/etag), so a re-fetch after eviction is a disk
// read, not a download — prefetch made that assumption load-bearing.
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
        const r = await fetch(path);
        if (!r.ok) { byteCache.delete(path); throw new Error(`fetch ${path}: ${r.status}`); }
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
      } finally { loadDone(path); demandEnd(); }
    })());
  }
  return byteCache.get(path);
}

// ---- loaders ----------------------------------------------------------------

const draco = new DRACOLoader().setDecoderPath('https://www.gstatic.com/draco/versioned/decoders/1.5.7/');
// §20b: ONE KTX2 transcoder for every parse site (VRM, GLB, loadGLBBytes).
// The transcoder is the vendored basis wasm, served by the /node_modules
// route. detectSupport at module scope is ordering-safe: core.js top-level-
// awaits renderer.init() (core.js:100) before this module evaluates, which
// is exactly what the deprecated detectSupportAsync shim would re-await.
const ktx2 = new KTX2Loader()
  .setTranscoderPath('/node_modules/three/examples/jsm/libs/basis/')
  .detectSupport(renderer);
/** Whether this GPU/browser negotiates KTX2 variants (?ktx2=<key>, shared/ktx2.js) — prefetch
 *  must warm the SAME cache key demand fetches will use. */
export const ktx2Capable = () => !!ktx2.workerConfig;
// The negotiation key comes from the RUNNING sequencer, never from a file it
// merely serves. In the window between `git pull` and the restart the old
// process serves the new shared/ktx2.js; a client that read the key off that
// file asked a server that had never heard of it, got an unflagged answer
// (webp, immutable), and nginx pinned it under the new key — the =2
// collision of 2026-08-24, retired within minutes. /version is the running
// process talking (no-store; resolved at ITS boot). No key there — an older
// sequencer, a failed fetch — means no negotiation at all: an unflagged
// fetch is always the right answer for its URL, so nothing can be pinned
// wrong, on any deploy, in any order. One fetch per page, awaited by every
// negotiating load (they are all async already; the prefetcher awaits it
// once before building its queue).
const versionReady = fetch('/version', { cache: 'no-store' })
  .then((r) => (r.ok ? r.json() : null)).catch(() => null);
export const ktx2KeyReady = versionReady.then(keyFromVersion);
/** The geometry-LOD recipe the running sequencer bakes (#156, lodFromVersion)
 *  — or null: no tier is ever asked for that the running process did not
 *  declare, the same split-brain gate as the key. */
export const lodRecipeReady = versionReady.then(lodFromVersion);
// the resolved answers, for SYNCHRONOUS policy reads (the residency sweep
// runs at 2Hz and cannot await): null until /version answers, null forever
// when it published nothing
let ktx2Key = null, lodRecipe = null;
ktx2KeyReady.then((k) => { ktx2Key = k; }).catch(() => {});
lodRecipeReady.then((r) => { lodRecipe = r; }).catch(() => {});
/** Settles once /version has answered (or failed) — a tier choice made
 *  after this knows whether a lod ask can cross the wire. Never rejects. */
export const negotiationReady = Promise.all([ktx2KeyReady, lodRecipeReady]).then(() => {}, () => {});
/** Can a lod ask for this lib CROSS THE WIRE from this browser, right now
 *  (review of #170, point 2)? The reduced variant's textures are KTX2, so
 *  the ask rides the ktx2 negotiation: the transcoder must have detected
 *  support, the running sequencer must have published a key AND a recipe,
 *  and only bare .glb paths negotiate. The policy treats "no" as no recipe
 *  — nothing is asked that could not be, and nothing is reported as asked. */
export const lodNegotiable = (libPath) => resolveLoadRequest(libPath, 'lod').tier === 'lod';
/** THE decision seam of a tiered load (review of #170, round three): from a
 *  tier wish to everything loadGLB derives from it — the URL it fetches, the
 *  tier that URL asks (askFor over this module's LIVE state: the running key
 *  and recipe, this GPU's transcoder) and the cache identity it keys. One
 *  function, exported, so the product-door gate executes the real seam and
 *  never a restatement of it: tools/lod-loader-probe.ts runs THIS module
 *  against an owned sequencer, and a mutation here fails it. */
export function resolveLoadRequest(libPath, tier = 'full') {
  const ask = askFor({ libPath, key: ktx2Key, capable: !!ktx2.workerConfig, recipe: lodRecipe, tier });
  return { url: ask.url, tier: ask.tier, glbKey: ask.tier === 'lod' ? `${libPath}#lod` : libPath };
}
/** GPU memory against the proto budget — the policy's "device pressure". */
export const gpuPressure = () => (renderer.info?.memory?.total ?? 0) / GPU_BUDGET;
/** Tiered loading, one seam (#156 client contract): `loadGLB(lib, { tier })`
 *  — 'full' or 'lod' — is the only place a tier turns into bytes. */
/** The path a negotiating load fetches: the running server's key appended
 *  when this GPU decodes KTX2 and `eligible` (the asset class negotiates),
 *  the bare path otherwise. */
async function negotiated(path, eligible) {
  const key = eligible && ktx2.workerConfig ? await ktx2KeyReady : null;
  return negotiate(path, key);
}
function makeLoader(vrm = false) {
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
// GPU texture creation + upload otherwise happens inside the first compile or
// render that binds each texture — batched into one frame. Walking the object
// and uploading a budget-slice per frame moves that cost off the stall.
//
// Coverage (§16.1c, investigated 8d): the Object.values(m) walk sees every own
// enumerable property, and that IS where the model/body texture set lives —
// three's material classes and MToonNodeMaterial (vendored 3.5.2) assign
// every map in their constructors (map, normalMap, emissiveMap,
// shadeMultiplyTexture, shadingShiftTexture, rimMultiplyTexture,
// matcapTexture, outlineWidthMultiplyTexture, uvAnimationMaskTexture — all
// plain `this.X = …`), and their TSL graphs reference those PROPERTIES via
// materialReference, so no MToon texture lives only inside a node. The one
// node-graph-only texture in the client is the factory's shared cloud
// noiseTex (a TSL texture(...) node holds it as node.value inside every PBR
// wrap's colorNode) — primed once at factory init (materials.js), not
// collected here. No graph walk needed; nothing unbounded.
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
// Bytes-per-frame budget for uploads. work.tick's CPU-ms budget alone let
// several 4K textures land in one tick window: renderer.initTexture returns
// in microseconds while the GPU process swallows upload + mipgen — measured
// 59-112MB single-frame spikes, 75-141ms hitches at t≈1.4-2s (bootjank
// worst-15, §16.1g). Estimate what each upload will cost and take a REAL
// frame once a frame's budget is spent.
const TEX_FRAME_BYTES = 16 * 1024 * 1024;
function textureUploadBytes(t) {
  const img = t.image;
  const w = img?.width ?? 0, h = img?.height ?? 0;
  // compressed (KTX2 → BC7/ASTC/ETC): the upload bill is the literal mip
  // bytes — the raw-RGBA w*h*4 estimate below over-charges BC7 4× and
  // squanders the per-frame budget the §17a spread runs on
  if (t.isCompressedTexture) return t.mipmaps?.reduce((s, m) => s + (m.data?.byteLength ?? 0), 0) || (w * h);
  if (!w || !h) return 4 * 1024 * 1024;   // dimensionless (data/undecoded):
                                          // charge something so a run of
                                          // unknowns still spreads
  return w * h * 4 * (t.generateMipmaps === false ? 1 : 1.33);
}
async function primeTextures(obj, work) {
  let spent = 0;
  for (const t of collectTextures(obj)) {
    const est = textureUploadBytes(t);
    // budget check BEFORE the upload; the `spent > 0` guard means one
    // oversized texture (a 4K map alone is ~89MB) still uploads — the
    // budget spreads, never skips — just alone in its own frame
    if (spent > 0 && spent + est > TEX_FRAME_BYTES) {
      await work.yield();
      spent = 0;
    }
    try { renderer.initTexture(t); } catch { /* first bind will get it */ }
    spent += est;
    await work.tick();   // the CPU-ms budget stays — decode-side cost is real
                         // too (a tick yield without a byte reset only makes
                         // the spread MORE generous, never less)
  }
}

// Prime-on-decode (§17a): toolkit textures ride TSL node graphs
// (vegetation.js texNode(maps.albedo), the sky's domes) — invisible to
// collectTextures' property walk, so they used to upload at first bind
// INSIDE a warm's compileAsync (measured: three 41ms frames as the strokes
// built, one 108ms frame for the 4K starmap — tel0s's trace, §17). Every
// one of them passes through loadImageTexture, so each decoded texture
// queues here and uploads through the same bytes-per-frame budget BEFORE
// any compile binds it. A compile that wins the race anyway just uploads
// at bind, exactly as before — this spreads, never gates.
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
  // §19b: a body parsed and compiled this session never re-pays. The pool is
  // consulted FIRST — a hit skips download+parse+skeleton+textures entirely.
  const t0 = performance.now();
  const pooled = takePooledVrm(libPath);
  if (pooled) {
    loadNote(`vrm ${libPath.split('/').pop()}: pool-hit — ${Math.round(performance.now() - t0)}ms`);
    return pooled;
  }
  const work = beginWork(`vrm ${libPath.split('/').pop()}`);
  try {
    work.phase('download');
    // §20c: bodies negotiate KTX2 exactly like GLBs (loadGLB above) — when
    // the transcoder detected support, ask and the server answers with the
    // surgical-rewrite variant when a fresh one exists, the original
    // otherwise. avatarPath arrives in BOTH forms — bare library rels and
    // roster paths already carrying ?v=mtime — so the flag APPENDS (&) after
    // an existing query rather than assuming one. The full URL keys
    // byteCache (variant and original are distinct byte entries — correct),
    // while the vrmPool and its vrmMeta ledger key on libPath UNTOUCHED, so
    // pool identity is unaffected by negotiation.
    const url = await negotiated(libPath, libPath.split('?')[0].endsWith('.vrm'));
    const buf = await fetchBytes(`/library/${url}`);
    work.phase('queued');
    // The parse and skeleton passes are the irreducibly-synchronous chunk of a
    // body: serialize so two arrivals can't stack theirs into the same frames,
    // and yield between passes so each stall is one pass long, not their sum.
    // Bodies default to priority 1 — people materialize before furniture.
    return await enqueue(async () => {
      work.phase('parse');
      const gltf = await new Promise((res, rej) => makeLoader(true).parse(buf, '', res, rej));
      const vrm = gltf.userData.vrm;
      // pool ledger (§19b): path for the release side, source bytes as the
      // VRAM proxy the pool budget counts
      vrmMeta.set(vrm, { libPath, bytes: buf.byteLength });
      await work.yield();
      work.phase('skeleton');
      VRMUtils.combineSkeletons?.(vrm.scene) ?? VRMUtils.removeUnnecessaryJoints?.(vrm.scene);
      // A SkinnedMesh's bounding sphere comes from BIND-POSE positions, so it
      // stops bounding the mesh the moment the skeleton poses — and three.js
      // then culls against that stale sphere, so parts of a body vanish
      // depending on camera angle.
      //
      // Invisible on a one-primitive avatar, whose bounds are body-sized and
      // effectively never leave the frustum. A multi-material body splits into
      // one SkinnedMesh PER PRIMITIVE, each with region-tight bounds: measured
      // on a 6-primitive rig, the hair primitive (bounds y 0.83..1.00 — the head
      // alone) disappeared from most angles while the seam primitive (bounds
      // spanning the whole body) never did. That reads as "the hair is missing
      // but its gold highlights are still there".
      vrm.scene.traverse((o) => { if (o.isSkinnedMesh) o.frustumCulled = false; });
      VRMUtils.rotateVRM0(vrm); // VRM0 → faces +Z
      // through the factory BEFORE the first compile: the final graph shape
      // (wetness on MToon, sweep markers) is born with the body
      prepareObject(vrm.scene, { kind: 'body' });
      await work.yield();
      work.phase('textures');
      await primeTextures(vrm.scene, work);
      return vrm;
    }, { lane: 'cpu', priority });
  } finally { work.end(); }
}

// ---- the VRM instance pool (§19b) -------------------------------------------
// GLBs cache a proto and hand out skeleton clones; VRMs cannot — three-vrm
// binds humanoid/expressions/springBones/lookAt to SPECIFIC nodes, and the
// vendored 3.5.2 ships no deep-clone that rebinds them (VRMUtils has exactly
// combineMorphs/combineSkeletons/deepDispose/removeUnnecessaryJoints/
// removeUnnecessaryVertices/rotateVRM0; the lookAt/humanoid clone()s reference
// the SAME nodes — verified). So switching bodies pools WHOLE PARSED
// INSTANCES: release resets one to rest and shelves it intact; take hands it
// back out and the whole download+parse+skeleton+textures pipeline is
// skipped. One instance serves one body at a time — two residents wearing the
// same VRM are two instances, and the second ALSO pools on release.
//
// THE POOL OWNS DISPOSAL (the §13.3 landmine, recorded since step 5½):
// Avatar.dispose used to deepDispose the body's geometry/materials/textures,
// and a disposed-then-pooled instance is a black-avatar bug. Bodies now come
// back here UNTOUCHED; the real deepDispose happens only at pool eviction —
// LRU under the caps below, or the residency sweep's GPU-budget drain
// (pooled bodies are zero-ref by construction, so they evict before protos).
const vrmPool = new Map();        // libPath -> [{ vrm, bytes, at }], oldest first
const vrmMeta = new WeakMap();    // vrm -> { libPath, bytes }, stamped at parse
const warmedVrms = new WeakSet(); // instances whose pipelines warmed once
const VRM_POOL_MAX = 2;                    // whole parsed bodies held at rest
const VRM_POOL_BYTES = 64 * 1024 * 1024;   // source-byte proxy for their VRAM
let vrmPoolBytes = 0;
let vrmPoolCount = 0;
let vrmPoolEvictions = 0;

/** Has this INSTANCE been through makeAvatar's conductor warm? A pooled
 *  body's pipelines are live in the renderer's cache — a re-warm would be a
 *  cheap no-op that still occupies the conductor, so makeAvatar skips it.
 *  Instance-keyed, not lib-keyed: a second fresh parse of the same lib has
 *  brand-new material objects and warms like any first wear. */
export const vrmWarmed = (vrm) => warmedVrms.has(vrm);
export const markVrmWarmed = (vrm) => { warmedVrms.add(vrm); };

/** Reset a parsed instance to rest — every call verified supported in the
 *  vendored @pixiv/three-vrm 3.5.2 (lib/three-vrm.module.js):
 *    humanoid.resetNormalizedPose / resetRawPose  (:1959, :1965)
 *    expressionManager.resetValues                 (:370)
 *    lookAt.reset                                  (:2500)
 *    springBoneManager.reset                       (:5540 — per-joint rest
 *      rotation, tails re-derived from the freshly-reset world matrices)
 *  The closing vrm.update(0) pushes it all through the managers (normalized →
 *  raw copy, neutral morph weights applied, lookAt applier at 0/0); spring
 *  joints hard-guard `delta <= 0` (:5368), so the settled state survives it. */
function resetVrmInstance(vrm) {
  if (vrm.lookAt) { vrm.lookAt.target = null; vrm.lookAt.reset(); }
  vrm.humanoid?.resetNormalizedPose();
  vrm.humanoid?.resetRawPose();
  vrm.expressionManager?.resetValues();
  vrm.scene.updateMatrixWorld(true);   // spring tails derive from world matrices
  vrm.springBoneManager?.reset();
  vrm.update(0);
}

/** Deep-dispose the LRU pooled instance. `keep` is never evicted — the house
 *  pattern (noteBytes): what just landed doesn't leave, so one over-budget
 *  body still pools rather than thrashing. Returns false when nothing can go. */
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

/** Give a body back. The instance pools INTACT — never disposed here — unless
 *  its reset throws (evict rather than pool a haunted body: correctness beats
 *  caching) or it never came from loadVRM (old contract: deep-dispose now). */
export function releaseVRM(vrm) {
  if (!vrm?.scene) return;
  for (const list of vrmPool.values()) {  // double-release guard, before any
    if (list.some((e) => e.vrm === vrm)) return;  // mutation: one slot per instance
  }
  vrm.scene.parent?.remove(vrm.scene); // detach from the scene before pooling
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

/** Pop an instance for re-wear. Defensively re-resets — a borrower (the
 *  thumbnail pass runs behind whenCalm and can outlive a fast switch) may
 *  have posed a body mid-pool; if THAT reset throws, the instance is disposed
 *  and the caller re-parses — a miss, never a haunted hit. */
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

/** Debug shape — rides EW.gpu() via protoStats, like the proto/byte tiers. */
export const poolStats = () => ({
  instances: vrmPoolCount,
  bytes: vrmPoolBytes,
  budget: { instances: VRM_POOL_MAX, bytes: VRM_POOL_BYTES },
  evictions: vrmPoolEvictions,
  libs: [...vrmPool.entries()].map(([p, l]) => `${p.split('/').pop()}×${l.length}`),
});

// Friendly names for library paths — store hashes are unreadable, and the
// loading tray should say "deco desk", not "4fee4b7c4794a2be".
export const libLabels = new Map();

const glbCache = new Map();
export async function loadGLB(libPath, { tier = 'full' } = {}) {
  // the WIRE decides which tier this load IS (review of #170, point 2): a
  // lod wish that cannot negotiate — no transcoder, no key, no recipe, not
  // a .glb — is a full load, keyed, fetched, and reported as one
  await negotiationReady;
  const req = resolveLoadRequest(libPath, tier);
  tier = req.tier;
  const glbKey = req.glbKey;
  const short = (libLabels.get(libPath) ?? libPath.split('/').pop()).slice(0, 28) + (tier === 'lod' ? '·lod' : '');
  loadsInFlight.set(glbKey, (loadsInFlight.get(glbKey) ?? 0) + 1);
  try {
  if (!glbCache.has(glbKey)) {
    const key = `glb:${short}`;
    loadTrack(key, short);
    const p = (async () => {
      const work = beginWork(`glb ${short}`);
      try {
        work.phase('download');
        // §20 + #156: the URL was decided above (resolveLoadRequest) — the running
        // server's key when this GPU decodes KTX2 and the path negotiates,
        // the lod recipe on top only when the ask is real. The server answers
        // the variant when one exists, the original chain otherwise
        // (provisional): a lod request is never a worse model. The full URL
        // keys byteCache, so variant and original are distinct entries.
        const buf = await fetchBytes(`/library/${req.url}`);
        work.phase('queued');
        return await enqueue(async () => {
          work.phase('parse');
          const gltf = await new Promise((res, rej) => makeLoader(false).parse(buf, '', res, rej));
          // the PROTOTYPE goes through the factory once; every skeletonClone
          // shares its wrapped materials and copies its mesh markers
          prepareObject(gltf.scene, { kind: 'model' });
          markDrawBatchSource(gltf.scene);
          // identity the realizer reads: which cache entry this proto is (for
          // retain/release/eviction) and which tier the SERVER actually sent
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
    // a REJECTED promise must not be the lib's answer forever — the residency
    // sweep re-promotes near placeholders, and a cached rejection turned one
    // bad fetch into an instant-fail loop (review S3; models backs off too)
    p.catch(() => { if (glbCache.get(glbKey) === p) glbCache.delete(glbKey); });
    glbCache.set(glbKey, p);
  }
  const proto = await glbCache.get(glbKey);
  const obj = skeletonClone(proto); // safe for rigged + static alike
  // Precompile pipelines OFF the render path — otherwise the first frame that
  // sees a new material stalls the main thread (the ~1.5s spawn freeze).
  // ALL THREE compile paths run through the warm conductor (warmqueue.js,
  // §16.2.A): the repeat-clone and racing-second-caller paths used to call
  // compileAsync BARE — up to 6 concurrent compiles starving rAF, invisible
  // to jank attribution (§16.1d) — and the gpu lane's 2-wide concurrency let
  // even the laned ones fight each other. Only the FIRST use of a model pays
  // real codegen + pipeline creation; repeats are cache hits — prod trace:
  // "queued 19311ms · compile 5ms".
  if (compiledLibs.has(glbKey)) {
    await warm(`compile ${short}`, () => renderer.compileAsync(obj, camera, scene).catch(() => {}));
    return obj;
  }
  // Two spawns of the same model racing used to BOTH queue a full compile —
  // each paying the whole codegen+pipeline cost (Safari: ~6s each, twice,
  // for one model). Clones share material references, so one compile warms
  // them all: the first caller compiles, everyone else awaits it and then
  // cache-hits.
  if (!libCompiles.has(glbKey)) {
    // In the loading tray too: on Safari a single material graph compiles for
    // SECONDS — a spinner named after the model turns that from mystery jank
    // into visible progress. (The conductor's own beginWork carries the
    // queued/warm phases the old record here tracked.)
    loadTrack(`compile:${glbKey}`, `⚙ ${short}`);
    // Per-MESH inside the item, a real frame between: one compileAsync over a
    // multi-material object batches every pipeline into one GPU-process gulp
    // (the CRT monitor's 1123ms warm still stalled a frame 617ms even
    // serialized). Mesh-by-mesh, shared materials cache-hit after their
    // first mesh and the burst spreads. frustumCulled defeats the walk's
    // culling for detached clones whose world matrices are still stale.
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
  // The racing second caller awaits the first-of-lib compile OUTSIDE the
  // conductor (a conductor item must never await another conductor item —
  // that is item-awaits-item, a deadlock at concurrency 1), then queues its
  // own now-cheap warm.
  await libCompiles.get(glbKey).catch(() => {});
  await warm(`compile ${short}`, () => renderer.compileAsync(obj, camera, scene).catch(() => {}));
  return obj;
  } finally {
    const n = (loadsInFlight.get(glbKey) ?? 1) - 1;
    if (n <= 0) loadsInFlight.delete(glbKey); else loadsInFlight.set(glbKey, n);
  }
}
// Libs whose pipelines have been compiled once this session — repeat spawns
// skip the queue. Compiled once is compiled: graph shapes are fixed at birth.
const compiledLibs = new Set();
const libCompiles = new Map(); // libPath -> in-flight first compile
// loads mid-flight count as references: eviction during a clone's compile
// yield would dispose the proto it shares (review S2)
const loadsInFlight = new Map();

// ---- proto residency (§13.3 R2) ---------------------------------------------
// All GPU bytes live on the PROTOTYPES (clones share everything), and three
// pins every uploaded geometry/texture in strong maps — only explicit
// dispose() frees VRAM. So protos are refcounted by realized clones, and
// when GPU memory crosses the budget, zero-ref protos evict: dispose their
// unique resources, drop the cache entries. The compressed bytes stay
// available (byteCache/HTTP cache), so a re-promote is a parse, not a
// download. NEVER call this per-entity — disposal here reaches every clone.
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
  // The VRM pool drains first (§19b): pooled bodies are zero-ref by
  // construction — nobody wears an instance that sits in the pool — so under
  // real GPU pressure they are the cheapest correct thing to give back.
  while ((renderer.info?.memory?.total ?? 0) >= GPU_BUDGET && evictOldestPooled()) evicted++;
  if ((renderer.info?.memory?.total ?? 0) < GPU_BUDGET) return evicted;
  for (const [lib, promise] of [...glbCache]) {
    if (libRefs.has(lib) || loadsInFlight.has(lib)) continue;   // worn, or being fitted
    const proto = await promise.catch(() => null);
    // the awaits yield — re-check before touching anything (review S2)
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
          // the factory's shared cloud-noise texture rides the node graph,
          // not a material property — Object.values never reaches it
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
  vrmPool: poolStats(),   // §19b — rides EW.gpu() like the other tiers
});

// ---- VRMA clips -------------------------------------------------------------

// 'fly' and 'soar' are the airborne pair. Janus, watching a body climb on the
// run cycle: "the running animation during flying is a bit goofy" -- and it is,
// a stride is legs doing work against ground that is not there. fallIdle is the
// library's free-fall pose: limbs trailing, no contact implied, which is what a
// body hanging under its own wings actually looks like.
export const CLIP_SLOTS = ['idle', 'walk', 'run', 'sit', 'lie', 'jump', 'climb', 'fly', 'soar'];
// Slot names are the wire vocabulary (pose.clip); files are whatever the
// library calls them.
export const CLIP_FILES = { sit: 'sitting_on_ground', lie: 'sit_laying_on_ground', climb: 'climbLedge',
  // Both airborne slots share one file today; they are separate SLOTS so a
  // purpose-made flap and glide can replace either without touching a caller.
  fly: 'fallIdle', soar: 'fallIdle' };
// Approximate natural speeds of the library clips (m/s), for timeScale sync.
export const CLIP_SPEED = { fly: 0, soar: 0, idle: 0, walk: 1.55, run: 4.0, sit: 0, lie: 0, jump: 0, climb: 0 };

const vrmaCache = new Map();
// Digest of the clip bytes THIS PAGE actually loaded, hashed once at fetch
// (#101 B3): the seat gate compares it to the digest the server judged the
// profile against, so a fallback clip or a divergent file can never wear a
// profile that was derived from different bytes. A filename is not an
// identity; the hash of what arrived is.
const vrmaSha = new Map(); // slot → hex sha256, present only once resolved
export function vrmaShaLoaded(slot) { return vrmaSha.get(slot) ?? null; }
// Clip URLs carry ?v=<mtime>, exactly as avatar URLs do — the server's
// /animations roster mints the stamp against the file it would actually
// SERVE (upstream-patched over opt over library), so a fork and its original
// never share a version. Without it a clip has no invalidation story at all:
// prod 2026-08-19, a corrected sit clip was live and byte-verified on the
// wire while a browser kept animating from a copy stored under the older
// `immutable` headers and never re-requested it — no 304s, nothing this end
// could purge. A version in the URL is the only invalidation that reaches a
// cache we do not control; with one, `serveFrom` may also hand the clip the
// year-long immutable lifetime, so an UNCHANGED clip costs zero requests.
//
// Fetched lazily rather than at module load: the first call rides alongside
// loadVRM, whose megabytes dwarf this JSON, so it costs no wall-clock — and a
// top-level fetch here is what once gated the whole module graph.
//
// A roster failure degrades to the bare, unversioned URL: exactly today's
// behaviour (no-cache + ETag), never worse. Clips must not stop loading
// because a listing did.
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

// The parsed VRMAnimation is avatar-independent — only createVRMAnimationClip
// (a cheap retarget against the humanoid rig) needs the vrm. This used to
// re-parse the whole ~1.9MB VRMA per slot PER AVATAR, so every body arriving
// re-paid nine GLTF parses the first one had already done.
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
          const l = new GLTFLoader();
          l.register((pl) => new VRMAnimationLoaderPlugin(pl));
          const gltf = await new Promise((res, rej) => l.parse(buf.slice(0), '', res, rej));
          const anim = gltf.userData.vrmAnimations?.[0];
          if (!anim) throw new Error(`no animation in ${slot}.vrma`);
          return anim;
        }, { lane: 'cpu', priority });
      } finally { work.end(); }
    })();
    p.catch(() => vrmaAnimCache.delete(slot)); // a transient failure must not stick
    vrmaAnimCache.set(slot, p);
  }
  return vrmaAnimCache.get(slot);
}

export async function clipFor(vrm, slot, { priority = 1 } = {}) {
  return createVRMAnimationClip(await vrmaAnimation(slot, priority), vrm);
}

// ---- procedural textures ----------------------------------------------------

/** Small tinted-noise CanvasTexture — lets log verbs specify terrain layers as
 *  colors (serializable) while clients bake the actual maps locally. */
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
// Skye's modules are written for a Deno host: they read their own dependencies
// and assets with SYNCHRONOUS file reads (`eval(Deno.readTextFileSync(...))`,
// `Deno.readFileSync(tex)`). A browser cannot do a synchronous network read, so
// the contract is honoured the only way it can be: prime an in-memory file
// system first, then let the synchronous reads hit it.
//
// This is what lets `sky_worlds.js` — 2000+ lines of world packaging that
// assumes a filesystem — run in a browser tab with ZERO edits to Skye's source.
// Every future toolkit module gets the same deal for free.

const denoFiles = new Map(); // library-relative path -> Uint8Array
const textDecoder = new TextDecoder();

/** Warm the virtual filesystem. Call before anything that eval-loads toolkit
 *  modules or reads toolkit assets. Paths are library-relative
 *  ("eidoverse/sky_system.js"). Missing files are reported, not fatal —
 *  a world package that references an asset we failed to fetch should degrade,
 *  not abort the whole sky. */
export async function primeFiles(paths, { concurrency = 6 } = {}) {
  const missing = [];
  const q = paths.filter((p) => !denoFiles.has(p));
  await Promise.all(Array.from({ length: Math.min(concurrency, q.length) }, async () => {
    while (q.length) {
      const p = q.shift();
      try {
        // §20d: loose images negotiate KTX2 at the FILE layer — capable
        // clients ask, and the server answers with the flip-baked .ktx2
        // sibling when the sweep built one (curated dirs), the original
        // otherwise. Only the WIRE URL changes: denoFiles still keys on the
        // bare library path, so readFileSync, the bytes-identity texture
        // cache (§16.2.B), and every toolkit module see the same identities —
        // the bytes just arrive GPU-native, and loadImageTexture sniffs the
        // container magic to tell which shape it got.
        const url = await negotiated(p, /\.(png|jpe?g)$/i.test(p));
        const buf = await fetchBytes(`/library/${url}`);
        denoFiles.set(p, new Uint8Array(buf));
      } catch (e) { missing.push(p); }
    }
  }));
  if (missing.length) console.warn('[host] not primed:', missing.join(', '));
  return missing;
}

/** Directory listing from the sequencer, so prefetch lists are discovered
 *  rather than hardcoded (the no-manifest rule applies to us too). */
export async function listLibrary(dir) {
  try {
    const r = await fetch(`/library-list?dir=${encodeURIComponent(dir)}`);
    // null, NOT [] — an empty directory and a sequencer that has never heard of
    // this endpoint are different facts, and treating them the same made an
    // old server look like a world with no sky assets in it.
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
  // Bake/export paths in the toolkit write intermediates to disk. In a browser
  // there is nowhere to put them and nothing that reads them back in the same
  // session — swallowing the write is correct, and louder than it looks
  // because anything that then READS the file gets a clear "not primed".
  writeFileSync() {}, writeTextFileSync() {},
  async writeFile() {}, async writeTextFile() {},
  mkdirSync() {}, statSync() { throw new Error('[host] statSync unsupported'); },
  // Engine-side look-dev gates. Skye's modules read these deliberately as
  // ENGINE knobs rather than parameters (a scene tuning cloud pass counts is a
  // scene doing look development it doesn't own). We honour that: the client
  // doesn't invent options, it just supplies the tier the hardware can hold.
  env: {
    get: (k) => globalThis.__ewEnv?.[k],
    set: (k, v) => { (globalThis.__ewEnv ??= {})[k] = v; },
    has: (k) => globalThis.__ewEnv?.[k] !== undefined,
  },
  // Subprocess (ffmpeg for the asteroid bake) — declaring it absent is more
  // honest than a stub that pretends to succeed.
  Command: class { constructor() { throw new Error('[host] no subprocesses in a browser'); } },
  build: { os: 'browser' },
};

/** Decode image bytes into a three texture — the browser implementation of the
 *  engine's loadImageTexture contract (render_scene.mjs). createImageBitmap is
 *  native here, so this is the short version of the Deno one.
 *
 *  Decoded textures are CACHED by bytes-object identity + the constructing
 *  options (§16.2.B): Skye's loaders (vegetation.js loadMap, sky_worlds
 *  readTex, …) have no cache of their own and re-read the same primed file
 *  per stroke/build — and Deno.readFileSync returns the SAME Uint8Array per
 *  path, so object identity IS the URL. Mojave decoded and uploaded 38
 *  vegetation textures where 24 were unique (§16.1). A WeakMap, so callers
 *  handing us fresh buffers simply miss — nothing transient gets pinned.
 *
 *  Cached textures are session-pinned: an upstream stroke's dispose()
 *  (vegetation.js:1006-1013) frees its map set on every regrow, and a
 *  disposed shared texture served from cache is a black-field bug — so a
 *  cached texture's dispose becomes a no-op, marked userData.ewShared.
 *  Accepted in the §16 design (~24 grass maps); a regrow now REUSES its
 *  textures instead of leaking freshly decoded copies of them. */
const imageTexCache = new WeakMap(); // bytes object -> Map<opts key, Promise<Texture>>
// The full 12-byte KTX2 identifier («KTX 20»\r\n\x1a\n) — the file-format spec's
// own magic, matched byte-for-byte so nothing else can ever route to the
// transcoder by accident.
const KTX2_MAGIC = [0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a];
globalThis.loadImageTexture = async (bytes, opts = {}) => {
  // srgb + flipY are the only options that alter the CONSTRUCTED texture;
  // wrap/anisotropy are caller-side mutations, identical for every same-URL
  // same-opts call site (vegetation.js keeps leaf sets ClampToEdge and stem
  // sets Repeat on different files — verified, they never diverge)
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
    // §20d: the file layer negotiates KTX2 (primeFiles ?ktx2=<key>), so library
    // bytes may arrive GPU-native — route by the container itself, never the
    // path. The 12-byte KTX2 identifier can't prefix a PNG/JPEG, so non-KTX2
    // bytes fall through to EXACTLY today's path.
    if (u8.length >= 12 && KTX2_MAGIC.every((v, i) => u8[i] === v)) {
      // Both engine contracts were baked at ENCODE (server --ktx2-img):
      //   - the vertical flip is in the PIXELS (three's KTX2Loader ignores
      //     KTX orientation metadata, so it could not be honoured later);
      //   - colorSpace comes from the container's DFD transfer, which the
      //     encoder matched to this call site's opts.srgb — do NOT override
      //     it here (parseColorSpace already set it).
      // ktx2.parse TRANSFERS its buffer to the transcoder worker (detached on
      // return) — hand it a COPY, never the primed file's own storage: Deno.
      // readFileSync returns the same Uint8Array per path, and detaching it
      // would corrupt every later read. One copy per bytes+opts, then cached.
      const tex = await new Promise((res, rej) => ktx2.parse(u8.slice().buffer, res, rej));
      // Same property treatment as the raster path where applicable: repeat
      // wrap (callers retighten to ClampToEdge exactly as they do today);
      // flipY stays false (CompressedTexture's only valid value — the flip is
      // baked); generateMipmaps stays false and min/mag filters are already
      // set by the loader (the mips are IN the container).
      tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
      if (cacheable) {
        tex.userData.ewShared = true;   // served from cache — teardowns must skip it
        tex.dispose = () => {};         // session-pinned, same as the raster path
      }
      queueTexturePrime(tex);           // §17a: initTexture sums literal mip bytes
      return tex;
    }
    // Engine contract (render_scene.mjs loadImageTexture): the vertical flip is
    // BAKED into the pixels (browser flipY convention) and tex.flipY stays
    // false, so it composes with repeat tiling; { flipY: false } skips the bake
    // for glTF-convention images. This shim must match or every texture sampled
    // through authored UVs (the vegetation trim sheets were the first) arrives
    // vertically mirrored.
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
    queueTexturePrime(tex);           // §17a: upload spread, ahead of the compile
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

// Toolkit modules construct their own loader for celestial meshes. The Deno
// host has it as a global, so ours must too — without it the sky died on
// `globalThis.GLTFLoader is not a constructor` and fell back to the basic sky.
globalThis.GLTFLoader = GLTFLoader;
globalThis.DRACOLoader = DRACOLoader;
// the configured SINGLETON, not the class: a toolkit module constructing its
// own GLTFLoader attaches it via setKTX2Loader(globalThis.KTX2Loader) and
// gets the transcoder path + detectSupport it could not redo itself
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
/** Eval-load a toolkit module by name ("terrain.js"). Idempotent; concurrent
 *  callers share one fetch. */
export function loadEidoModule(name) {
  if (!eidoModules.has(name)) {
    eidoModules.set(name, (async () => {
      const r = await fetch(`/library/eidoverse/${name}`);
      if (!r.ok) throw new Error(`module ${name}: ${r.status}`);
      const src = await r.text();
      denoFiles.set(`eidoverse/${name}`, new TextEncoder().encode(src)); // self-prime
      (0, eval)(src); // same indirect-eval hosting as the engine
    })());
  }
  return eidoModules.get(name);
}

export { VRMUtils, skeletonClone };
