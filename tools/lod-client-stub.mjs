// tools/lod-client-stub.mjs — the realizer's dependency cone, stubbed for
// tools/lod-client-test.ts. client/lib/realize/models.js is REAL there; so
// are lod_policy.js, models_field.js, state.js (the fold), scheduler.js and
// base.js (the bus). This one file stands in for:
//
//   core.js      a WebGPURenderer at import time — here a bare scene and camera
//   assets.js    the loader — the WIRE truth (askFor) decides the tier a load
//                IS, a pretend sequencer answers a stamped variant when it
//                "baked" one and the original otherwise, and the test can
//                HOLD every load open and release it by hand, so a tier swap
//                can be caught mid-flight
//   colliders.js / lightrig.js / lights.js — recorded, never built
//   world.js     its maps only (entities, mounts, edit holds, findPart)
//
// Every side effect the test asserts on is a plain array or Map here.
import * as THREE_ from '../client/node_modules/three/build/three.module.js';
import { askFor, tierOf } from '../client/lib/lod_policy.js';

// ---- core.js ----------------------------------------------------------------
// makePlaceholder wants the node material class from three/webgpu; the
// stand-in's material is never rendered here
export const THREE = { ...THREE_, MeshBasicNodeMaterial: THREE_.MeshBasicMaterial };
export const scene = new THREE_.Scene();
export const camera = new THREE_.PerspectiveCamera();
export const renderer = { info: { memory: { total: 0 } }, domElement: null };
export const reports = [];
export const report = (where, e) => { reports.push({ where, e }); };
export const CONFIG = {};

// ---- assets.js --------------------------------------------------------------
/** The pretend sequencer + browser: what /version published, whether this
 *  "browser" transcodes KTX2, and which libs have a baked variant. Mutable —
 *  a section flips them and spawns fresh placements. */
export const server = { key: '3', recipe: 'lod1-r25e01-texel1024', capable: true, variants: new Set() };
/** Every loadGLB call, in order: { lib, tier (what crossed the wire), url }. */
export const loads = [];
/** Loads held open while `hold` is on: { lib, tier, url, release() }. */
export const held = [];
let hold = false;
export const setHold = (v) => { hold = !!v; };
let pressure = 0;
export const setPressure = (p) => { pressure = p; };
export const gpuPressure = () => pressure;
export const retained = new Map();
export const released = [];
export const retainGLB = (k) => retained.set(k, (retained.get(k) ?? 0) + 1);
export const releaseGLB = (k) => { released.push(k); retained.set(k, (retained.get(k) ?? 0) - 1); };
export const evictIdleProtos = async () => 0;
export const ktx2KeyReady = Promise.resolve(server.key);
export const lodRecipeReady = Promise.resolve(server.recipe);
export const negotiationReady = Promise.resolve();
export const lodNegotiable = (lib) =>
  askFor({ libPath: lib, key: server.key, capable: server.capable, recipe: server.recipe, tier: 'lod' }).tier === 'lod';
/** The loader as the realizer sees it. Identity stamps are the real
 *  loader's: glbKey (the cache entry worn), tierServed (tierOf over what the
 *  "server" answered, bound to the running recipe), tierAsked (the wire). */
export async function loadGLB(lib, { tier = 'full' } = {}) {
  const ask = askFor({ libPath: lib, key: server.key, capable: server.capable, recipe: server.recipe, tier });
  const rec = { lib, tier: ask.tier, url: ask.url };
  loads.push(rec);
  if (hold) await new Promise((release) => held.push({ ...rec, release }));
  // the answer: a stamped variant for a lib the sequencer baked, the
  // original chain (extras untouched — none here) otherwise
  const json = ask.tier === 'lod' && server.variants.has(lib)
    ? { asset: { extras: { lodOf: `sha-${lib}`, recipe: server.recipe, tools: { meshoptimizer: 'x', encoder: 'none' } } } }
    : { asset: { extras: {} } };
  const g = new THREE_.Group();
  g.add(new THREE_.Mesh(new THREE_.BoxGeometry(1, 1, 1), new THREE_.MeshBasicMaterial()));
  g.userData.glbKey = ask.tier === 'lod' ? `${lib}#lod` : lib;
  g.userData.tierServed = tierOf(json, server.recipe);
  g.userData.tierAsked = ask.tier;
  return g;
}

// ---- colliders.js -----------------------------------------------------------
export const colliders = new Map();
/** ['fit' | 'remove' | 'refit', id] in order. */
export const colliderLog = [];
export const fitCollider = (id, obj, opts) => { colliders.set(id, { obj, opts }); colliderLog.push(['fit', id]); };
export const removeCollider = (id) => { colliders.delete(id); colliderLog.push(['remove', id]); };
export const refitCollider = (id) => { colliderLog.push(['refit', id]); };
export const reindexCollider = () => {};

// ---- lightrig.js / lights.js ------------------------------------------------
export const attachLamps = () => {};
export const releaseOwner = () => {};
export const registerCaster = () => {};
export const releaseCaster = () => {};
export const makeLight = () => new THREE_.Group();
export const updateLight = () => {};
export const disposeLight = () => {};

// ---- the governor's cone (governor.js is REAL in the harness) ---------------
// core.js extras: the sun and the pixel-ratio base the 'detail' / 'pixels'
// levers touch
export const sun = { shadow: { mapSize: { width: 2048, set() {} }, map: null } };
export const BASE_PIXEL_RATIO = 1;
renderer.setPixelRatio = () => {};
renderer.getPixelRatio = () => 1;
// warmqueue.js / loadwork.js: never loading — the governor's grace never holds
export const warmStats = () => ({ pending: 0, running: false });
export const warm = (label, fn) => Promise.resolve().then(fn);
export const laneBusy = () => false;
// lightrig.js / emitters.js / terrain.js / frame.js / remotes.js: every lever
// BELOW 'lod' in the ladder answers "nothing to shed", so a slow window
// reaches the lod lever deterministically
export const setSlotCap = () => {};
export const getSlotCap = () => 0;
export const maxSlots = () => 0;
export const litCount = () => 0;
export const setCasterBudget = () => {};
export const getCasterBudget = () => 2;
export const casterCount = () => 0;
export const setEmitterQuality = () => false;
export const emitterQuality = () => 'auto';
export const emitterCount = () => 0;
export const setGrassDensity = () => {};
export const getGrassDensity = () => 1;
export const hasGrass = () => false;
export const setLodBias = () => {};
const every = { autos: 2 };
export const setSystemEvery = (k, v) => { every[k] = v; };
export const getSystemEvery = (k) => every[k] ?? 1;
// ui.js: toasts recorded
export const toasts = [];
export const toast = (msg, kind, ms) => { toasts.push({ msg, kind, ms }); };

// ---- world.js (its maps) ----------------------------------------------------
export const entities = new Map();
export const entityMeta = new Map();
export const comps = new Map();
export const avatarMounts = new Map();
export const editHolds = new Set();
export function findPart(root, name) {
  let hit = null;
  root?.traverse?.((o) => { if (!hit && o.name === name) hit = o; });
  return hit;
}
