// assets — every byte the client pulls, and the host shims that let Skye's
// toolkit modules run unmodified in a browser.
//
// Three caches, all keyed by library path and all "download+parse once":
//   byteCache  raw bytes (with progress reporting into the loading tray)
//   glbCache   parsed GLB prototypes — every use gets a skeleton clone
//   vrmaCache  animation bytes, retargeted per-VRM at use

import { THREE, renderer, camera, scene, report, bus } from './core.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { VRMLoaderPlugin, VRMUtils } from '@pixiv/three-vrm';
import { MToonMaterialLoaderPlugin } from '@pixiv/three-vrm-materials-mtoon';
import { MToonNodeMaterial } from '@pixiv/three-vrm-materials-mtoon/nodes';
import { VRMAnimationLoaderPlugin, createVRMAnimationClip } from '@pixiv/three-vrm-animation';
import { clone as skeletonClone } from 'three/addons/utils/SkeletonUtils.js';
import { beginWork, enqueue } from './loadwork.js';

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
  for (const key of [...byteCache.keys()]) if (key.includes(match)) byteCache.delete(key);
}

export async function fetchBytes(path) {
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
          return buf.buffer;
        }
        return await r.arrayBuffer();
      } finally { loadDone(path); demandEnd(); }
    })());
  }
  return byteCache.get(path);
}

// ---- loaders ----------------------------------------------------------------

const draco = new DRACOLoader().setDecoderPath('https://www.gstatic.com/draco/versioned/decoders/1.5.7/');
function makeLoader(vrm = false) {
  const l = new GLTFLoader();
  l.setDRACOLoader(draco);
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
async function primeTextures(obj, work) {
  for (const t of collectTextures(obj)) {
    try { renderer.initTexture(t); } catch { /* first bind will get it */ }
    await work.tick();
  }
}

export async function loadVRM(libPath, { priority = 1 } = {}) {
  const work = beginWork(`vrm ${libPath.split('/').pop()}`);
  try {
    work.phase('download');
    const buf = await fetchBytes(`/library/${libPath}`);
    work.phase('queued');
    // The parse and skeleton passes are the irreducibly-synchronous chunk of a
    // body: serialize so two arrivals can't stack theirs into the same frames,
    // and yield between passes so each stall is one pass long, not their sum.
    // Bodies default to priority 1 — people materialize before furniture.
    return await enqueue(async () => {
      work.phase('parse');
      const gltf = await new Promise((res, rej) => makeLoader(true).parse(buf, '', res, rej));
      const vrm = gltf.userData.vrm;
      await work.yield();
      work.phase('skeleton');
      VRMUtils.combineSkeletons?.(vrm.scene) ?? VRMUtils.removeUnnecessaryJoints?.(vrm.scene);
      VRMUtils.rotateVRM0(vrm); // VRM0 → faces +Z
      await work.yield();
      work.phase('textures');
      await primeTextures(vrm.scene, work);
      return vrm;
    }, { lane: 'cpu', priority });
  } finally { work.end(); }
}

// Friendly names for library paths — store hashes are unreadable, and the
// loading tray should say "deco desk", not "4fee4b7c4794a2be".
export const libLabels = new Map();

const glbCache = new Map();
export async function loadGLB(libPath) {
  const short = (libLabels.get(libPath) ?? libPath.split('/').pop()).slice(0, 28);
  if (!glbCache.has(libPath)) {
    const key = `glb:${short}`;
    loadTrack(key, short);
    glbCache.set(libPath, (async () => {
      const work = beginWork(`glb ${short}`);
      try {
        work.phase('download');
        const buf = await fetchBytes(`/library/${libPath}`);
        work.phase('queued');
        return await enqueue(async () => {
          work.phase('parse');
          const gltf = await new Promise((res, rej) => makeLoader(false).parse(buf, '', res, rej));
          await work.yield();
          work.phase('textures');
          await primeTextures(gltf.scene, work);
          return gltf.scene;
        }, { lane: 'cpu', priority: 0 });
      } finally { loadDone(key); work.end(); }
    })());
  }
  const proto = await glbCache.get(libPath);
  const obj = skeletonClone(proto); // safe for rigged + static alike
  // Precompile pipelines OFF the render path — otherwise the first frame that
  // sees a new material stalls the main thread (the ~1.5s spawn freeze).
  // Only the FIRST use of a model queues (it pays real codegen + pipeline
  // creation); repeats are cache hits and would just sit in line to discover
  // that — prod trace: "queued 19311ms · compile 5ms".
  if (compiledLibs.has(libPath)) {
    await renderer.compileAsync(obj, camera, scene).catch(() => {});
    return obj;
  }
  // Two spawns of the same model racing used to BOTH queue a full compile —
  // and with two gpu slots they ran CONCURRENTLY, each paying the whole
  // codegen+pipeline cost (Safari: ~6s each, twice, for one model). Clones
  // share material references, so one compile warms them all: the first
  // caller compiles, everyone else awaits it and then cache-hits.
  if (!libCompiles.has(libPath)) {
    const work = beginWork(`compile ${short}`);
    work.phase('queued'); // before enqueue — an empty lane starts the job synchronously
    // In the loading tray too: on Safari a single material graph compiles for
    // SECONDS — a spinner named after the model turns that from mystery jank
    // into visible progress.
    loadTrack(`compile:${libPath}`, `⚙ ${short}`);
    const p = enqueue(() => {
      work.phase('compile');
      return renderer.compileAsync(obj, camera, scene).catch(() => {});
    }, { lane: 'gpu', priority: 0 })
      .then(() => compiledLibs.add(libPath))
      .finally(() => { libCompiles.delete(libPath); work.end(); loadDone(`compile:${libPath}`); });
    libCompiles.set(libPath, p);
    await p;
    return obj;
  }
  await libCompiles.get(libPath).catch(() => {});
  await renderer.compileAsync(obj, camera, scene).catch(() => {}); // warm now
  return obj;
}
// Libs whose pipelines have been compiled once this session — repeat spawns
// skip the queue. (A sky/weather wrap or a new light can invalidate pipeline
// caches; the direct compileAsync above still handles that, just unqueued.)
const compiledLibs = new Set();
const libCompiles = new Map(); // libPath -> in-flight first compile

// ---- VRMA clips -------------------------------------------------------------

export const CLIP_SLOTS = ['idle', 'walk', 'run', 'sit', 'lie', 'jump', 'climb'];
// Slot names are the wire vocabulary (pose.clip); files are whatever the
// library calls them.
export const CLIP_FILES = { sit: 'sitting_on_ground', lie: 'sit_laying_on_ground', climb: 'climbLedge' };
// Approximate natural speeds of the library clips (m/s), for timeScale sync.
export const CLIP_SPEED = { idle: 0, walk: 1.55, run: 4.0, sit: 0, lie: 0, jump: 0, climb: 0 };

const vrmaCache = new Map();
// Digest of the clip bytes THIS PAGE actually loaded, hashed once at fetch
// (#101 B3): the seat gate compares it to the digest the server judged the
// profile against, so a fallback clip or a divergent file can never wear a
// profile that was derived from different bytes. A filename is not an
// identity; the hash of what arrived is.
const vrmaSha = new Map(); // slot → hex sha256, present only once resolved
export function vrmaShaLoaded(slot) { return vrmaSha.get(slot) ?? null; }
export function vrmaBytes(slot) {
  if (!vrmaCache.has(slot)) {
    const p = fetchBytes(`/library/eidoverse/assets/animations/${CLIP_FILES[slot] ?? slot}.vrma`);
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
        const buf = await fetchBytes(`/library/${p}`);
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
 *  native here, so this is the short version of the Deno one. */
globalThis.loadImageTexture = async (bytes, opts = {}) => {
  const u8 = bytes instanceof Uint8Array ? bytes
    : bytes instanceof ArrayBuffer ? new Uint8Array(bytes)
      : new Uint8Array(bytes);
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
  return tex;
};

// Toolkit modules construct their own loader for celestial meshes. The Deno
// host has it as a global, so ours must too — without it the sky died on
// `globalThis.GLTFLoader is not a constructor` and fell back to the basic sky.
globalThis.GLTFLoader = GLTFLoader;
globalThis.DRACOLoader = DRACOLoader;

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
