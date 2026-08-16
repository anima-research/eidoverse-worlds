// warmqueue — the warm conductor (TEL0S_NOTES §16.2.A).
//
// One serialized queue through which pipeline warms pass: GLB lib compiles
// (assets.js), terrain (world.js), sky domes (sky.js), and shadow-depth
// variants (below, driven by lightrig's casterPass). Concurrency is ONE —
// that is the point: the GPU process compiles one thing at a time while
// frames keep presenting. The gpu lane's 2-wide concurrency was exactly
// what let compiles fight each other (§16.1d); the conductor replaces it
// for pipeline warms while the lane keeps its remaining users (avatar
// bodies, portrait contexts).
//
// Between items: one REAL requestAnimationFrame yield — never
// scheduler.yield, whose same-turn continuation storm starves rAF on
// Chromium (§16.1a). Errors are swallowed per the house warm pattern
// (every warm call site already wrote `.catch(() => {})`), but counted;
// warmStats() is the debug shape 8e hangs on EW later.

import { renderer, scene, sun, THREE, TSL } from './core.js';
import { beginWork, nextFrame } from './loadwork.js';

// ---- the queue --------------------------------------------------------------

const queue = [];
let running = false;
const stats = { queued: 0, done: 0, failed: 0, lastLabel: null };

// Priority classes, because FIFO gated arrival on ambience: the rain world's
// cloud-march compiles queued AHEAD of the terrain compile the curtain waits
// on, and boot went 2s → 16s (measured, first 8b gate). GATE items are what
// the splash is waiting for; AMBIENT items (sky domes, depth variants) are
// pure background warmth. Stable FIFO within a class.
export const P_GATE = 0;     // arrival waits on this (terrain)
export const P_MODEL = 1;    // a thing someone is about to see (default)
export const P_AMBIENT = 2;  // sky domes, shadow-depth variants

/** Enqueue an async warm. Runs fn() alone — highest class first, arrival
 *  order within a class — one real frame between items. The returned promise
 *  resolves when the item has RUN — never rejects (errors are swallowed and
 *  counted, house warm pattern). */
export function warm(label, fn, { p = P_MODEL } = {}) {
  return new Promise((resolve) => {
    // the record starts at enqueue so the wait is visible as its own phase
    // (loadwork's doctrine: queue time must not masquerade as work time)
    const work = beginWork(label);
    work.phase('queued');
    const item = { label, fn, work, resolve, p };
    // stable insert: after the last item of an equal-or-higher class
    let at = queue.length;
    while (at > 0 && queue[at - 1].p > p) at--;
    queue.splice(at, 0, item);
    stats.queued++;
    pump();
  });
}

async function pump() {
  if (running) return;
  running = true;
  while (queue.length) {
    const item = queue.shift();
    stats.lastLabel = item.label;
    item.work.phase('warm');
    try {
      await item.fn();
      stats.done++;
    } catch (e) {
      stats.failed++;               // swallowed, but never silently: counted
    } finally {
      item.work.end();
      item.resolve();
    }
    await nextFrame();              // a REAL frame between items (§16.1a)
  }
  running = false;
}

// `pending` counts queued items only — the item currently being warmed has
// been shifted off the queue, so `running` is part of the honest busy answer
// (the governor's loading grace reads both, §16.2.D).
export const warmStats = () => ({ ...stats, pending: queue.length, running });

// ---- shadow-depth pre-warm --------------------------------------------------
// The shadow-depth pass was the one pipeline family NOTHING warmed: every
// caster the rig enables paid a synchronous createRenderPipeline inside the
// next shadow render (§16.1c). This warms a caster's depth pipelines through
// compileAsync BEFORE castShadow ever flips, so the real pass is a pure
// cache hit. Grounded in the vendored three.webgpu.js (r184) — every line
// number below was read, not assumed:
//
//   The pipeline cache is renderer-global and keys on program ids + a
//   VALUE-only backend key (:32248-32252, lookup :32035-32047): material
//   blend/depth/stencil/side state, target formats, sample count, topology,
//   geometry key — no object, scene, or context IDENTITY anywhere
//   (:81752-81782). Programs dedupe by WGSL SOURCE STRING (:32003-32029),
//   and NodeBuilder names uniforms/vars with builder-local counters
//   (:51535-51557, :51570-51590) with constants inlined by value
//   (:50882-50931) — so structurally identical graphs emit byte-identical
//   text. A warm compile that reproduces the real pass's material VALUES,
//   node graph, object and target formats therefore lands the exact
//   GPURenderPipeline the real pass will ask for.
//
//   The real pass: ShadowNode.updateShadow sets scene.overrideMaterial to a
//   per-light NodeMaterial{colorNode:vec4(0,0,0,1), isShadowPassMaterial,
//   NoBlending, fog:false} (:44603, built :43865-3884) and renders into a
//   RenderTarget whose texture.type = shadow.mapType with a default
//   DepthTexture (:44272-4285). Depth-pass codegen is scene-independent BY
//   DESIGN — getDynamicCacheKey skips the lights/env/fog key entirely for
//   isShadowPassMaterial (:30257-30268) — and per caster material the
//   renderer derives colorNode/depthNode/positionNode once and caches THE
//   INSTANCES on itself (_getShadowNodes, :61040-61133), then mutates the
//   override material per object: alphaTest/alphaMap/transparent copied,
//   side flipped through _shadowSide (:61187-61203, map :57817).
//
//   The one trap: renderObject() RESTORES colorNode/depthNode/positionNode/
//   side after queueing (:61237-61243), and compileAsync DEFERS codegen to
//   after that restore (:61343-61383, loop :58761-58790) — so a naive
//   "overrideMaterial + compileAsync" compiles the WRONG pipeline for any
//   caster with a map/alphaTest/flipped side. The fix: PRE-configure our
//   warm material to exactly the post-mutation state (same cached node
//   instances via _getShadowNodes — which also primes the renderer's cache
//   for the real pass), so save→mutate→restore is identity and the deferred
//   build sees the correct state.
//
//   compileAsync captures its render target/context synchronously before
//   its first internal yield (:58652-58654; items carry the context,
//   :61358) — the avatar-thumbnail precedent (avatar.js) — so target and
//   overrideMaterial are restored in the same synchronous block and no real
//   frame ever sees them. Pipelines build through
//   device.createRenderPipelineAsync (:79006-79031), not the blocking
//   variant — nothing stalls the queue.

const SHADOW_SIDE = {
  [THREE.FrontSide]: THREE.BackSide,
  [THREE.BackSide]: THREE.FrontSide,
  [THREE.DoubleSide]: THREE.DoubleSide,
};

let warmMat = null;       // our shadow-pass material — value-identical to three's
let baseColorNode = null; // vec4(0,0,0,1), inlined by value in WGSL
let scratchRT = null;     // format-matched fallback target (never drawn into)
let depthWarmBroken = false;

function ensureDepthWarm() {
  if (warmMat) return true;
  if (depthWarmBroken) return false;
  // the one internal this leans on — if the vendored build ever moves it,
  // degrade to today's behavior (flip immediately, compile in-frame) loudly
  if (typeof renderer._getShadowNodes !== 'function') {
    depthWarmBroken = true;
    console.warn('[warm] three internals moved (_getShadowNodes) — depth pre-warm disabled, casters compile in-frame as before');
    return false;
  }
  baseColorNode = TSL.vec4(0, 0, 0, 1);
  warmMat = new THREE.NodeMaterial();
  warmMat.name = 'ShadowMaterial';       // matches getShadowMaterial (label only)
  warmMat.colorNode = baseColorNode;
  warmMat.isShadowPassMaterial = true;   // scene-independent codegen + real-pass parity
  warmMat.blending = THREE.NoBlending;
  warmMat.fog = false;
  return true;
}

// The warm target: prefer the REAL shadow map RT (same render context as the
// real pass — for textured casters even the NodeBuilder state is shared, the
// material cache key includes context.id). Before the first shadow render it
// doesn't exist yet; the scratch RT replicates setupRenderTarget's FORMATS
// verbatim (:44272-4285) — only formats enter the pipeline key, so 4×4 is
// plenty: the compile never draws into it.
function warmTarget() {
  if (sun.shadow?.map?.isRenderTarget) return sun.shadow.map;
  if (!scratchRT) {
    const depthTexture = new THREE.DepthTexture(4, 4);
    depthTexture.compareFunction = renderer.reversedDepthBuffer
      ? THREE.GreaterEqualCompare : THREE.LessEqualCompare;
    scratchRT = new THREE.RenderTarget(4, 4);
    scratchRT.texture.type = sun.shadow.mapType;
    scratchRT.depthTexture = depthTexture;
  }
  return scratchRT;
}

/** Configure warmMat to the exact state renderObject() leaves the real
 *  per-light shadow material in for this caster material (:61181-61209) —
 *  so the compile path's save/mutate/restore is identity. */
function configureFor(m) {
  const sn = renderer._getShadowNodes(m); // cached per material ON THE RENDERER —
                                          // the same instances the real pass uses
  warmMat.alphaTest = m.alphaTest;
  warmMat.alphaMap = m.alphaMap;
  warmMat.transparent = m.transparent || m.transmission > 0
    || Boolean(m.transmissionNode?.isNode) || Boolean(m.backdropNode?.isNode);
  warmMat.side = (m.shadowSide !== null && m.shadowSide !== undefined)
    ? m.shadowSide
    : (renderer.shadowMap.type === THREE.VSMShadowMap ? m.side : SHADOW_SIDE[m.side]);
  warmMat.positionNode = sn.positionNode ?? (m.positionNode?.isNode ? m.positionNode : null);
  warmMat.colorNode = sn.colorNode ?? baseColorNode;
  warmMat.depthNode = sn.depthNode ?? null;
  // bump the version or a multi-material mesh's second round would reuse the
  // first round's cached builder state (RenderObjects.get version-checks the
  // material on chain reuse, :30436 — 'version' itself is in no cache key)
  warmMat.needsUpdate = true;
}

// One compile round: this mesh, this material's depth config. Every group of
// a multi-material mesh dedupes to the same pipeline key within a round
// (shared geometry + same material values), so per-unique-material rounds
// warm everything with zero waste.
async function compileDepthRound(mesh, material) {
  configureFor(material);
  const saveVisible = mesh.visible;
  const saveCulled = mesh.frustumCulled;
  const prevOverride = scene.overrideMaterial;
  const prevTarget = renderer.getRenderTarget();
  mesh.visible = true;         // compile's projectObject skips invisible (:60819)
  mesh.frustumCulled = false;  // …and out-of-frustum (:60869) — restored below
  scene.overrideMaterial = warmMat;
  renderer.setRenderTarget(warmTarget());
  let compiled;
  try {
    // the live scene as targetScene: the builder's env/fog inputs match the
    // real pass exactly (both inert for an unlit shadow material — :30264)
    compiled = renderer.compileAsync(mesh, sun.shadow.camera, scene);
  } finally {
    // same synchronous block — no frame can observe any of these mutated
    renderer.setRenderTarget(prevTarget);
    scene.overrideMaterial = prevOverride;
    mesh.visible = saveVisible;
    mesh.frustumCulled = saveCulled;
  }
  await (compiled?.catch(() => {}) ?? Promise.resolve());
}

/** Warm every shadow-depth pipeline a caster will need, through the
 *  conductor. `getMeshes` is re-read when the item RUNS, so a caster
 *  released while queued warms nothing. Resolves when done (or when the
 *  warm is unsupported — the caller's flip then behaves exactly as today). */
export function warmDepth(label, getMeshes) {
  if (!ensureDepthWarm()) return Promise.resolve();
  return warm(label, async () => {
    for (const mesh of getMeshes() ?? []) {
      if (!mesh?.isMesh) continue;
      const mats = Array.isArray(mesh.material)
        ? [...new Set(mesh.material)]
        : mesh.material ? [mesh.material] : [];
      for (const m of mats) {
        await compileDepthRound(mesh, m);
        await nextFrame();     // breathe between rounds too — real frames
      }
    }
  }, { p: P_AMBIENT });        // background warmth: never ahead of arrivals
}
