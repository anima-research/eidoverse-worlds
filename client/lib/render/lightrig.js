// lightrig — one owner for every runtime light. three r184 keys its pipeline cache by (light id, castShadow) in
// scene order (docs/history/TEL0S_NOTES.md §12.1), so the light TOPOLOGY is born here and never changes: N point
// slots and a small spot pool under one group, never added/removed/toggled; an idle slot is intensity 0. Everything
// that wants a light (placed lights, emissive lamps, the weather's lightning) makes a REQUEST; slot churn is uniform
// writes.
//
// Assignment is deterministic in (requests, camera): keep/adopted → authored → inferred lamps, then camera distance
// with an incumbent bonus, then key. `keep` is top priority and escapes the governor's cap, not the pool: more keeps than
// slots and the farthest glow without casting.
//
// The weather factory scene.add()s its own lightning PointLight, and a foreign light in the scene is a recompile
// storm, so makeWeatherSystem is handed a Proxy of the scene whose add/remove ADOPT lights into requests (bottom of
// file; the seam goes when upstream grows a strikeLight injection, docs/history/UPSTREAM-WRAP-ONCE.md).
//
// Measurements and the chest lamp's shadow tuning: docs/research/light-rig.md.

import { THREE, scene, camera, renderer, sun } from '../core.js';
import { CSMShadowNode } from 'three/addons/csm/CSMShadowNode.js';
import { CONFIG, tee, bus } from '../base.js';
import { warmDepth } from './warmqueue.js';

// ---- the fixed inventory ----------------------------------------------------

// ?slots=N (0..16); a non-numeric value falls back to 8 rather than making zero slots
const _slotsParam = Number(CONFIG.params.get('slots') ?? 8);
const N_SLOTS = Number.isFinite(_slotsParam) ? Math.max(0, Math.min(16, Math.round(_slotsParam))) : 8;

const rigGroup = new THREE.Group();
rigGroup.name = 'lightrig';
const slots = [];
// ONE slot casts, and is born casting (flipping castShadow on a live slot is a recompile). A request that wants
// shadows is assigned here (see assign).
const SHADOW_SLOT = 0;
// The lamp's shadow map, bias and bulb position, tuned by eye against a moving body: docs/research/light-rig.md.
const SHADOW_MAP = 256;
const SHADOW_WORK_DIST = 12;
const SHADOW_BIAS_TEXELS = 8;
// where the bulb sits in the lamp bone's frame (metres): 2cm back toward the wings, 15cm up, near the collarbone
const SHADOW_FORWARD = -0.02;
const SHADOW_UP = 0.15;
const SHADOW_SIDE = 0;
const shadowTexel = (n = SHADOW_MAP) => (2 * SHADOW_WORK_DIST) / n;
// live-tunable copies (setLampShadow); the consts above are the defaults
let _biasTexels = SHADOW_BIAS_TEXELS;
let _workDist = SHADOW_WORK_DIST;
// The bulb nudge in the bone's own frame, so it rides the chest however the body turns. forward = out of the chest
// (-Z in the bone frame), up = toward the head, side = toward the body's left.
const _nudge = new THREE.Vector3(SHADOW_SIDE, SHADOW_UP, -SHADOW_FORWARD);
// The resident's shadow preference (the video settings row); read here because the slot loop needs it.
const SH_KEY = 'ew-shadows';
const stored = (k) => { try { return localStorage.getItem(k); } catch { return null; } };   // storage can throw (site data blocked)
let _prefShadows = stored(SH_KEY) !== 'off';   // `let`: setShadows() flips it, and shadowsOn() must follow
for (let i = 0; i < N_SLOTS; i++) {
  const pl = new THREE.PointLight(0xffffff, 0, 10, 1.7);
  pl.name = `slot${i}`;
  pl.castShadow = i === SHADOW_SLOT;   // pipeline shape, fixed at birth; the preference is uniform-level (applyShadowPref)
  if (i === SHADOW_SLOT) {
    pl.shadow.mapSize.set(SHADOW_MAP, SHADOW_MAP);
    // depth precision is the near/far RATIO: near 0.03 (the bulb is inside the body), far = the light's own falloff
    // (trackShadowFar keeps it there)
    pl.shadow.camera.near = 0.03;
    pl.shadow.camera.far = Math.max(2, pl.distance || 10);
    pl.shadow.camera.updateProjectionMatrix();
    // bias stays small and negative; normalBias (derived from the texel size) does the heavy lifting
    pl.shadow.bias = -0.0005;
    pl.shadow.normalBias = SHADOW_BIAS_TEXELS * shadowTexel();
  }
  slots.push(pl);
  rigGroup.add(pl);
}
scene.add(rigGroup);

export const shadowsOn = () => _prefShadows;
// The lamp's shadow dials, live (mapSize is a realloc and normalBias a uniform; neither is in a pipeline cache key).
// Any subset of {map, texels, dist, forward, up, side}; the bias is re-derived from the resulting map size so a size
// change keeps the look. forward/up/side move the bulb (metres, bone frame; see _nudge).
export function setLampShadow({ map, texels, dist, forward, up, side } = {}) {
  const pl = slots[SHADOW_SLOT];
  if (!pl) return null;
  if (Number.isFinite(map)) {
    const n = Math.max(16, Math.min(2048, Math.round(map)));
    pl.shadow.mapSize.set(n, n);
    // three only reallocates the target once the old one is disposed
    pl.shadow.map?.dispose?.();
    pl.shadow.map = null;
  }
  if (Number.isFinite(texels)) _biasTexels = Math.max(0, texels);
  if (Number.isFinite(dist)) _workDist = Math.max(0.01, dist);
  // ±0.5m: a bulb inside a ribcage; a metre of nudge has left the body
  const clamp = (v) => Math.max(-0.5, Math.min(0.5, v));
  if (Number.isFinite(forward)) _nudge.z = -clamp(forward);   // forward is -z (see _nudge)
  if (Number.isFinite(up)) _nudge.y = clamp(up);
  if (Number.isFinite(side)) _nudge.x = clamp(side);
  pl.shadow.normalBias = _biasTexels * ((2 * _workDist) / (pl.shadow.mapSize.x || SHADOW_MAP));
  return lampShadowState();
}
export const lampShadowState = () => {
  const pl = slots[SHADOW_SLOT];
  if (!pl) return null;
  const n = pl.shadow.mapSize.x || SHADOW_MAP;
  return {
    map: n, texels: _biasTexels, workDist: _workDist,
    texelMM: +((2 * _workDist / n) * 1000).toFixed(2),
    // where the bulb sits relative to its bone (metres, bone frame)
    forward: +(-_nudge.z).toFixed(4), up: +_nudge.y.toFixed(4), side: +_nudge.x.toFixed(4),
    normalBias: +pl.shadow.normalBias.toFixed(5),
    bias: pl.shadow.bias,
    near: pl.shadow.camera.near, far: pl.shadow.camera.far,
  };
};

// The shadow switch is uniform-level: shadowMap.enabled and castShadow are in every lit material's pipeline key, so
// they are fixed on at boot and 'off' is shadow.intensity 0 with the depth pass stopped (autoUpdate off).
/** Does this light actually draw shadows right now? Shape (castShadow + the map) AND the preference's uniform half. */
const castsNow = (l) => Boolean(l?.castShadow && renderer.shadowMap.enabled && l.shadow && l.shadow.intensity > 0 && l.shadow.autoUpdate !== false);
function applyShadowPref(on) {
  for (const l of [sun, slots[SHADOW_SLOT]]) {
    if (!l?.shadow) continue;
    l.shadow.intensity = on ? 1 : 0;
    l.shadow.autoUpdate = on;
    if (on) l.shadow.needsUpdate = true;   // the held map is stale: redraw it once now
  }
}
/** Put the shadow preference's uniform half back (after a probe held shadow maps across frames). */
export const reassertShadowPref = () => applyShadowPref(_prefShadows);
export function setShadows(on) {
  localStorage.setItem(SH_KEY, on ? 'on' : 'off');
  _prefShadows = on;
  applyShadowPref(on);
}
// pipeline shape, set once before the first compile (see applyShadowPref)
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = ({ basic: THREE.BasicShadowMap, pcf: THREE.PCFShadowMap, soft: THREE.PCFSoftShadowMap })[CONFIG.params.get('shadowtype')] ?? THREE.PCFSoftShadowMap;   // ?shadowtype=basic|pcf|soft, a diagnostic
sun.castShadow = true;
applyShadowPref(shadowsOn());
// shadow map resolution (persisted; the video settings row). A live change is a realloc, no recompile.
const RES_KEY = 'ew-shadow-res';
export const SHADOW_RES = [1024, 2048, 4096];
export const shadowRes = () => { const v = +stored(RES_KEY); return SHADOW_RES.includes(v) ? v : 2048; };
// one dial for every caster: the sun takes n, the lamp slot scales SHADOW_MAP by n/2048
const lampMapFor = (n) => Math.round(SHADOW_MAP * (n / 2048));
export function setShadowRes(n) {
  localStorage.setItem(RES_KEY, String(n));
  sun.shadow.mapSize.set(n, n);
  if (slots[SHADOW_SLOT] && slots[SHADOW_SLOT].shadow.mapSize.x !== lampMapFor(n)) setLampShadow({ map: lampMapFor(n) });
}
sun.shadow.mapSize.set(shadowRes(), shadowRes());
if (lampMapFor(shadowRes()) !== SHADOW_MAP) setLampShadow({ map: lampMapFor(shadowRes()) });
// ?csm=2|3|4 — cascaded shadow maps (bench probe): three's CSMShadowNode fits one ortho camera per cascade around the
// view frustum each frame, replacing the follow box in updateShadow. N cascades = N depth passes.
const CSM_N = Math.min(4, Math.max(0, +CONFIG.params.get('csm') || 0));
let csm = null;
if (CSM_N >= 2) {
  csm = new CSMShadowNode(sun, { cascades: CSM_N, maxFar: +CONFIG.params.get('csmfar') || 150, mode: CONFIG.params.get('csmmode') || 'practical', lightMargin: 100 });
  sun.shadow.shadowNode = csm;
  addEventListener('resize', () => { if (csm.camera) csm.updateFrustums(); });   // no camera until the first compiled frame (CSMShadowNode._init): a resize before that would throw
}
if (CONFIG.params.has('shadowfloat')) sun.shadow.mapType = THREE.FloatType;   // ?shadowfloat=1 (boot): 32-bit float depth map, a D3D11/ANGLE comparison-sampling variant
sun.shadow.bias = -0.0006;
sun.shadow.normalBias = 0.02;
// Boot line for the shadow state (?shadowdebug): the persisted switch, the map, and where the sun is.
if (CONFIG.params.has('shadowdebug')) setTimeout(() => { try { const d = sun.position.clone().normalize(); tee(`[shadows] csm=${csm ? csm.cascades : 0} pref=${shadowsOn() ? 'on' : 'off'} map=${renderer.shadowMap.enabled} type=${renderer.shadowMap.type} size=${sun.shadow.mapSize.x} sun=(${d.x.toFixed(2)},${d.y.toFixed(2)},${d.z.toFixed(2)}) intensity=${sun.intensity.toFixed(2)} casters=${casters.size} casting=${[...casters.values()].filter((c) => c.casting).length}`);
  // real-hardware facts: the map's depth texture, GL error state, the extensions that shape the shadow path
  const m = sun.shadow.map; const dt = m?.depthTexture; const gl = renderer.backend?.gl; const ext = (n) => gl ? (gl.getExtension(n) ? 1 : 0) : '?';
  tee(`[shadows] map=${m ? `${m.width}x${m.height}` : 'none'} depthTex=${dt ? `type:${dt.type} fmt:${dt.format} cmp:${dt.compareFunction} ver:${dt.version}` : 'none'} glError=${gl ? gl.getError() : '?'} parallelCompile=${ext('KHR_parallel_shader_compile')} clipControl=${ext('EXT_clip_control')} depthClamp=${ext('EXT_depth_clamp')} renderer=${(() => { try { const d = gl.getExtension('WEBGL_debug_renderer_info'); return d ? gl.getParameter(d.UNMASKED_RENDERER_WEBGL).slice(0, 60) : gl.getParameter(gl.RENDERER).slice(0, 60); } catch { return '?'; } })()}`);
  } catch (e) { tee(`[shadows] probe threw: ${e?.message ?? e}`); } }, 20000);

// ---- requests ---------------------------------------------------------------

/** key -> request. A request is a light that WANTS to cast:
 *    obj        Object3D whose world position the slot follows (or null)
 *    offset     local-frame offset within obj (lamp = emissive mesh centre)
 *    pos        fallback world position when there is no obj
 *    mirror     a foreign THREE light whose live color/intensity/distance/
 *               decay/position the slot copies verbatim (the lightning)
 *    color/intensity/range/decay  the authored params (ignored when mirror)
 *    keep       top priority — never outbid by distance
 *    authored   placed by a verb (beats inferred lamps)
 *    dayAware   dimmed by the sky's dayness like a lamp
 *    owner      release scope (entity:<id>) */
const requests = new Map();
let assignDirty = true;

export function requestLight(key, spec) {
  requests.set(key, {
    obj: null, offset: null, pos: null, mirror: null,
    color: 0xffd9a0, intensity: 16, range: 10, decay: 1.7,
    keep: false, authored: false, dayAware: false, owner: null,
    shadows: false,   // wants the casting slot (see SHADOW_SLOT)
    spot: null,       // {angle, inner} (glTF half-angles, rad): a spot, lit from the SPOT pool, shining along obj's -Z
    ...spec, key, slot: -1, sslot: -1,
  });
  assignDirty = true;
}
/** Patch a live request. Only keys that can change the ordering dirty assignment: a breathing lamp patches
 *  intensity 60 times a second. */
const ORDERING_KEYS = ['keep', 'authored', 'obj', 'offset', 'pos', 'mirror', 'owner', 'spot'];
export function updateRequest(key, patch) {
  const r = requests.get(key);
  if (!r) return;
  Object.assign(r, patch);
  if ('obj' in patch || 'offset' in patch) delete r._joint;   // skinnedPosOf re-derives the dominant joint
  if (ORDERING_KEYS.some((k) => k in patch)) assignDirty = true;
}
export function releaseLight(key) {
  if (requests.delete(key)) assignDirty = true;
}
export function releaseOwner(owner) {
  for (const [k, r] of requests) if (r.owner === owner) requests.delete(k);
  assignDirty = true;
}
export const isCasting = (key) => (requests.get(key)?.slot ?? -1) >= 0;

// ---- lamps ------------------------------------------------------------------
// A body that glows sheds light: each emissive mesh (≤2) gets a lamp request at its centre. A placed model infers
// none (its lights are light components). A request costs nothing until it wins a slot.

/** Request a light at each emissive mesh's centre (<=2 per object). `opts.shadows` claims the ONE casting slot and
 *  defaults to FALSE: only avatar.js passes true.
 *  @returns {{key:string, intensity:number}[]} the requests made (a caller animating a lamp needs both). */
export function attachLamps(root, owner, { shadows = false } = {}) {
  const made = [];
  const emissive = [];
  root.traverse((o) => {
    if (!o.isMesh) return;
    const m = o.material;
    const glow = (m?.emissiveIntensity ?? 1) *
      Math.max(m?.emissive?.r ?? 0, m?.emissive?.g ?? 0, m?.emissive?.b ?? 0);
    // an emitter, not MToon's unlit trick (emissive ≈ white + a map at strength 1): a flat emissive colour with no
    // map, or a map driven above strength 1
    if ((!m?.emissiveMap && glow > 0.5) || (m?.emissiveMap && (m?.emissiveIntensity ?? 1) > 1)) {
      emissive.push({ mesh: o, glow: Math.max(glow, m?.emissiveIntensity ?? 1) });
    }
  });
  emissive.slice(0, 2).forEach(({ mesh, glow }, i) => {
    mesh.geometry.computeBoundingSphere();
    // saturated emissive keeps its colour; whitish reads as a warm bulb
    const ec = mesh.material.emissive;
    const sat = Math.max(ec.r, ec.g, ec.b) - Math.min(ec.r, ec.g, ec.b);
    const intensity = Math.min(40, 6 + 2.6 * glow);
    const key = `lamp:${owner}:${i}`;
    requestLight(key, {
      obj: mesh,
      offset: mesh.geometry.boundingSphere.center.clone(),
      color: sat > 0.25 ? ec.clone() : 0xffd9a0,
      intensity,
      range: 12,                 // tight radius: grass fragments cost
      shadows,                   // the caller's call: a nearer glowing prop must not take the casting slot off a body
      dayAware: true, owner,
    });
    made.push({ key, intensity });
  });
  return made;
}

// ---- time of day ------------------------------------------------------------
// The sky tells the rig how day it is (sky.js applyTuning); lamps and placed lights answer with one glow curve.

// null = unknown, and unknown lights the lamp (1 would zero every day-aware light until a sky loads)
let dayness = null;
export function setDayness(d) { dayness = d; }
const dayGlow = () => (dayness == null ? 1 : Math.pow(1 - dayness, 2));
/** The same curve for emissive surfaces, so a surface and its light dim together. */
export const glowScale = () => dayGlow();

// ---- assignment -------------------------------------------------------------
// Deterministic in (requests, camera): tier (keep/adopted → authored →
// inferred), then camera distance with a 15% incumbent bonus (hysteresis),
// then key (stable tiebreak). Recomputed when the request set changes, the
// camera moves, or 600ms passes — slot WRITES happen every frame regardless.

let slotCap = N_SLOTS;
export function setSlotCap(n) {
  slotCap = Math.max(0, Math.min(N_SLOTS, n));
  assignDirty = true;
}
export const getSlotCap = () => slotCap;
export const maxSlots = () => N_SLOTS;

const _wp = new THREE.Vector3();
const _lastCam = new THREE.Vector3(Infinity, Infinity, Infinity);
let lastAssign = 0;

// A SkinnedMesh's bounding-sphere centre (the offset attachLamps stores) is in bind-pose coordinates, so rotating it
// by the node's quaternion swings the light in an arc; a skinned lamp is located through its dominant bone instead.
function worldPosOf(r, out) {
  if (r.mirror) return out.copy(r.mirror.position);
  if (r.obj) {
    if (r.offset && r.obj.isSkinnedMesh) return skinnedPosOf(r, out);
    r.obj.getWorldPosition(out);
    if (r.offset) out.add(_wp.copy(r.offset).applyQuaternion(r.obj.getWorldQuaternion(_q)).multiplyScalar(r.obj.getWorldScale(_s).x || 1));
    return out;
  }
  return out.set(...(r.pos ?? [0, 1, 0]));
}

// The dominant joint for a skinned lamp: the largest weight on the vertex nearest the bind-space centre. One bone,
// not a blend: a lamp is a rigid fixture on one bone.
const _bindM = new THREE.Matrix4();
function lampJointOf(mesh, centre) {
  const geo = mesh.geometry, skel = mesh.skeleton;
  const pos = geo.getAttribute('position'), sk = geo.getAttribute('skinIndex'), sw = geo.getAttribute('skinWeight');
  if (!pos || !sk || !sw || !skel) return -1;
  let best = -1, bestD = Infinity;
  for (let i = 0; i < pos.count; i++) {
    const d = (pos.getX(i) - centre.x) ** 2 + (pos.getY(i) - centre.y) ** 2 + (pos.getZ(i) - centre.z) ** 2;
    if (d < bestD) { bestD = d; best = i; }
  }
  if (best < 0) return -1;
  let j = sk.getX(best), w = sw.getX(best);
  for (const [gi, gw] of [[sk.getY(best), sw.getY(best)], [sk.getZ(best), sw.getZ(best)], [sk.getW(best), sw.getW(best)]]) {
    if (gw > w) { w = gw; j = gi; }
  }
  return w > 0 ? j : -1;
}

function skinnedPosOf(r, out) {
  const mesh = r.obj;
  if (r._joint === undefined) r._joint = lampJointOf(mesh, r.offset);
  const skel = mesh.skeleton, j = r._joint;
  // no usable skin: the node's matrix on the bind position (exact for an unposed body)
  if (j < 0 || !skel?.bones?.[j]) {
    return out.copy(r.offset).applyMatrix4(mesh.matrixWorld);
  }
  // bone * inverse-bind is the skinning transform for one fully-weighted bone
  _bindM.multiplyMatrices(skel.bones[j].matrixWorld, skel.boneInverses[j]);
  out.copy(r.offset).applyMatrix4(_bindM);
  // the nudge rides the bone (lamps only: a mirror has no bind offset)
  if (r.shadows && (_nudge.x || _nudge.y || _nudge.z)) {
    out.add(_wp.copy(_nudge).applyQuaternion(skel.bones[j].getWorldQuaternion(_q)));
  }
  return out;
}
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _p = new THREE.Vector3();

// the camera's WORLD position: in XR the camera is a child of the rig and camera.position is only the head's offset
const _eye = new THREE.Vector3();
function assign(now) {
  lastAssign = now;
  camera.getWorldPosition(_eye);
  _lastCam.copy(_eye);
  assignDirty = false;
  assignSpots();
  const ranked = [...requests.values()].filter((r) => !r.spot).map((r) => {
    const d = worldPosOf(r, _p).distanceTo(_eye);
    return {
      r,
      tier: r.keep ? 0 : r.authored ? 1 : 2,
      d: r.slot >= 0 ? d * 0.85 : d,   // incumbents hold their ground
    };
  }).sort((a, b) => a.tier - b.tier || a.d - b.d || (a.r.key < b.r.key ? -1 : 1));
  // mirrors (the adopted lightning) hold reserved slots: neither distance nor the governor's cap sheds a strike
  const mirrors = ranked.filter((x) => x.r.mirror).slice(0, N_SLOTS).map((x) => x.r);
  const nonMirror = ranked.filter((x) => !x.r.mirror);
  // `keep` is exempt from governor shedding: the cap applies to the tail only. More keeps than slots and the nearest
  // win; the rest glow without casting.
  const keeps = nonMirror.filter((x) => x.r.keep)
    .slice(0, Math.max(0, N_SLOTS - mirrors.length))
    .map((x) => x.r);
  const rest = nonMirror.filter((x) => !x.r.keep)
    .slice(0, Math.max(0, Math.min(slotCap, N_SLOTS - mirrors.length - keeps.length)))
    .map((x) => x.r);
  const winners = [...mirrors, ...keeps, ...rest];
  const winnerSet = new Set(winners);
  // evicted requests free their slots first; a request that stays assigned keeps its slot
  for (const r of requests.values()) {
    if (r.slot >= 0 && !winnerSet.has(r)) r.slot = -1;
  }
  const used = new Set(winners.map((r) => r.slot).filter((i) => i >= 0));
  // the first request that wants shadows takes the casting slot before the general pass; a second lights without
  // casting (a second caster would be a recompile)
  const wants = winners.find((r) => r.shadows);
  if (wants && wants.slot !== SHADOW_SLOT) {
    // SWAP with the incumbent (usually the world, realized before your avatar) rather than wait for a free slot
    const incumbent = winners.find((r) => r !== wants && r.slot === SHADOW_SLOT);
    const vacated = wants.slot;          // -1 if it was never assigned
    wants.slot = SHADOW_SLOT;
    used.add(SHADOW_SLOT);
    if (incumbent) incumbent.slot = vacated;
    else if (vacated >= 0) used.delete(vacated);
  }
  let free = 0;
  for (const r of winners) {
    if (r.slot >= 0) continue;
    while (used.has(free)) free++;
    if (free >= N_SLOTS) break;
    r.slot = free;
    used.add(free);
  }
}

// ---- the sun shadow ---------------------------------------------------------
// The frustum follows the camera by sliding the ortho extents in the light's view frame (moving sun.position would
// fight the sky), snapped to shadow-map texels or every step shimmers.

const SHADOW_HALF = 46;    // the measured box (docs/research/light-rig.md)
const SHADOW_DEPTH = 90;   // covers relief + trees around the focus plane
const _sm = new THREE.Matrix4();
const _sx = new THREE.Vector3(), _sy = new THREE.Vector3(), _sz = new THREE.Vector3();
const _rel = new THREE.Vector3(), _cw = new THREE.Vector3();
const _ZERO = new THREE.Vector3();

function updateShadow() {
  if (csm) return;   // the cascades fit themselves around the view (updateBefore)
  const cam = sun.shadow.camera;
  _rel.copy(camera.getWorldPosition(_cw)).sub(sun.position);   // world: in XR the camera is a child of the rig
  _sm.lookAt(sun.position, _ZERO, THREE.Object3D.DEFAULT_UP);
  _sm.extractBasis(_sx, _sy, _sz);
  const texel = (2 * SHADOW_HALF) / (sun.shadow.mapSize.x || 2048);
  const fx = Math.round(_rel.dot(_sx) / texel) * texel;
  const fy = Math.round(_rel.dot(_sy) / texel) * texel;
  cam.left = fx - SHADOW_HALF;
  cam.right = fx + SHADOW_HALF;
  cam.top = fy + SHADOW_HALF;
  cam.bottom = fy - SHADOW_HALF;
  // dist goes negative when the camera stands up-sun of the light: never clamp it (an ortho camera takes a negative near)
  const dist = -_rel.dot(_sz);
  cam.near = dist - SHADOW_DEPTH;
  cam.far = dist + SHADOW_DEPTH;
  cam.updateProjectionMatrix();
}

// ---- the caster budget ------------------------------------------------------
// object.castShadow is in no pipeline cache key, so the caster set is a live distance budget: the nearest K cast (plus up
// to 4 already casting inside the hysteresis edge, casterPass), the rest keep receiving. Depth pipelines are pre-warmed (warmqueue.warmDepth) before castShadow flips, ≤2 flips per
// pass; a disable fades out and castShadow clears when the fade ends (endFade). docs/research/shadow-depth-prewarm.md.

const casters = new Map();   // id -> { obj, meshes, casting, warm, released }
// how many things may cast at most: a Video setting; the governor sheds below it under load and climbs back to it
export const CASTER_CHOICES = [6, 12, 24, 48, 96];
let casterCeiling = (() => { try { const v = +localStorage.getItem('ew-shadow-casters'); return CASTER_CHOICES.includes(v) ? v : 24; } catch { return 24; } })();
let casterBudget = casterCeiling;
export const getCasterCeiling = () => casterCeiling;
export function setCasterCeiling(k) { if (!CASTER_CHOICES.includes(+k)) return; casterCeiling = +k; casterBudget = casterCeiling; try { localStorage.setItem('ew-shadow-casters', String(k)); } catch { /* private window */ } }
let lastCasterPass = 0;

/** The models realizer registers every realized model here; retire releases. */
export function registerCaster(id, obj) {
  const meshes = [];
  // start not casting (a realizer may hand meshes in casting): the pass flips only where want !== casting
  obj.traverse((o) => { if (o.isMesh) { o.castShadow = false; meshes.push(o); } });
  casters.set(id, { id, obj, meshes, casting: false, warm: 'none', released: false, fade: 0 });
}
export function releaseCaster(id) {
  const c = casters.get(id);
  if (c) { c.released = true; fading.delete(c); }   // a queued warm re-reads this and skips the work
  casters.delete(id);
}
// realize/lifecycle.js: a realized object is going; its caster record and lamps go with it
bus.on('realized', ({ id, owner }) => { releaseCaster(id); releaseOwner(owner); });
export const casterCount = () => casters.size;
export function setCasterBudget(k) { casterBudget = Math.max(0, Math.min(casterCeiling, k)); }
export const getCasterBudget = () => casterBudget;

// ---- the fade: a caster dithers in and out over FADE_MS (materials.js FADE_MASK reads mesh.userData.shadowFade in
// the depth pass). castShadow goes true at the start of a fade-in and false at the end of a fade-out; a caster that
// comes back mid-fade reverses. A mesh whose material was never marked hard-flips.
export const FADE_MS = 300;
const fading = new Set();
let lastFadeTick = 0;
const canFade = (m) => {
  const ms = Array.isArray(m.material) ? m.material : m.material ? [m.material] : [];
  return ms.length > 0 && ms.every((x) => x?.userData?.shadowFade === true);
};
function writeFade(c) {
  for (const m of c.meshes) if (canFade(m)) m.userData.shadowFade = c.fade;
}
function beginFade(c) {
  if (fading.has(c)) return;
  fading.add(c);
  // a batched InstancedMesh carries its own userData (amount 1): the source draws itself while it fades
  for (const m of c.meshes) if (!m.userData.noDrawBatch) { m.userData.noDrawBatch = true; (c.unbatched ??= []).push(m); }
}
function endFade(c) {
  fading.delete(c);
  for (const m of c.unbatched ?? []) delete m.userData.noDrawBatch;
  c.unbatched = null;
  if (c.fade === 0) for (const m of c.meshes) m.castShadow = false;
}
function stepFades(now) {
  const dt = lastFadeTick ? Math.min(100, Math.max(0, now - lastFadeTick)) : 0;
  lastFadeTick = now;
  if (!fading.size) return;
  for (const c of fading) {
    const target = c.casting ? 1 : 0;
    c.fade = target > c.fade ? Math.min(1, c.fade + dt / FADE_MS) : Math.max(0, c.fade - dt / FADE_MS);
    writeFade(c);
    if (c.fade === target) endFade(c);
  }
}
export const fadingCount = () => fading.size;

function casterPass() {
  const ranked = [...casters.values()]
    .map((c) => ({ c, d: c.obj.getWorldPosition(_p).distanceToSquared(camera.getWorldPosition(_cw)) }))
    .sort((a, b) => a.d - b.d);
  let enables = 0;
  // hysteresis: a caster keeps casting until 1.25× the last caster's distance (squared: 1.5625), so a row of crates
  // doesn't blink at the boundary. A budget of 0 keeps nothing.
  const edge = casterBudget === 0 ? -1 : ranked.length >= casterBudget ? ranked[casterBudget - 1].d * 1.5625 : Infinity;
  for (let i = 0; i < ranked.length; i++) {
    const { c, d } = ranked[i];
    const want = i < casterBudget || (c.casting && d <= edge && i < casterBudget + 4);
    if (want === c.casting) continue;
    if (!want) {                          // the draw is shed when the fade-out ends
      c.casting = false;
      beginFade(c);
      continue;
    }
    // an unwarmed caster never flips: warm once, flip on a later pass once its depth pipelines exist
    if (c.warm === 'none') {
      c.warm = 'pending';
      warmDepth(`depth ${String(c.id).slice(0, 24)}`, () => (c.released ? [] : c.meshes))
        .then(() => { c.warm = 'done'; });
      continue;
    }
    if (c.warm !== 'done') continue;      // still warming
    if (c.fade > 0) { c.casting = true; beginFade(c); continue; }   // still fading out: reverse, no flip
    if (enables >= 2) continue;           // ≤2 flips per pass
    enables++;
    c.casting = true;
    writeFade(c);                         // amount 0 before the first depth draw
    for (const m of c.meshes) m.castShadow = true;
    beginFade(c);
  }
}

// ---- the per-frame drive ----------------------------------------------------

// the casting slot's shadow far plane follows its light's range (rewritten every frame by whichever request holds it)
const _SHADOW_FAR_EPS = 1e-4;
function trackShadowFar(pl) {
  if (!pl.castShadow) return;
  const want = Math.max(2, pl.distance || 10);
  if (Math.abs(pl.shadow.camera.far - want) < _SHADOW_FAR_EPS) return;
  pl.shadow.camera.far = want;
  pl.shadow.camera.updateProjectionMatrix();
}

// ---- the spot pool: its own light type, so its own fixed pool (?spots=N, default 2). Same ranking as the point
// pool; no shadows.
const _spotRaw = CONFIG.params.get('spots');   // null when absent: Number(null) is 0
const _spotParam = _spotRaw == null || _spotRaw === '' ? NaN : Number(_spotRaw);
const N_SPOT = Number.isFinite(_spotParam) && _spotParam >= 0 ? Math.min(8, Math.round(_spotParam)) : 2;
const spotSlots = [];
for (let i = 0; i < N_SPOT; i++) {
  const sl = new THREE.SpotLight(0xffffff, 0, 10, Math.PI / 4, 0, 1.7);
  sl.name = `spot${i}`; sl.castShadow = false;
  rigGroup.add(sl); rigGroup.add(sl.target);
  spotSlots.push(sl);
}
function assignSpots() {
  const ranked = [...requests.values()].filter((r) => r.spot).map((r) => ({ r, tier: r.keep ? 0 : r.authored ? 1 : 2,
    d: worldPosOf(r, _p).distanceTo(_eye) * (r.sslot >= 0 ? 0.85 : 1) }))
    .sort((a, b) => a.tier - b.tier || a.d - b.d || (a.r.key < b.r.key ? -1 : 1));
  const win = new Set(ranked.slice(0, N_SPOT).map((x) => x.r));
  for (const r of requests.values()) if (r.sslot >= 0 && (!win.has(r) || !r.spot)) r.sslot = -1;
  const used = new Set([...win].map((r) => r.sslot).filter((i) => i >= 0));
  let free = 0;
  for (const r of win) { if (r.sslot >= 0) continue; while (used.has(free)) free++; if (free >= N_SPOT) break; r.sslot = free; used.add(free); }
  for (const r of win) if (r.slot >= 0) r.slot = -1;   // a light that became a spot leaves the point pool
}
const _sq = new THREE.Quaternion(), _sfwd = new THREE.Vector3();
function writeSpots() {
  const lit = new Array(N_SPOT).fill(null);
  for (const r of requests.values()) if (r.spot && r.sslot >= 0) lit[r.sslot] = r;
  for (let i = 0; i < N_SPOT; i++) {
    const sl = spotSlots[i], r = lit[i];
    if (!r) { sl.intensity = 0; continue; }
    worldPosOf(r, sl.position);
    if (r.obj) r.obj.getWorldQuaternion(_sq); else if (r.q) _sq.set(r.q[0], r.q[1], r.q[2], r.q[3]); else _sq.identity();   // r.q: an unrealized host's world q (realize/models.js lightSpec)
    _sfwd.set(0, 0, -1).applyQuaternion(_sq);   // glTF/Godot: a spot shines down its local -Z
    sl.target.position.copy(sl.position).add(_sfwd);
    sl.target.updateMatrixWorld();
    sl.color.set(r.color);
    sl.intensity = r.intensity * (r.dayAware ? dayGlow() : 1);
    sl.distance = r.range; sl.decay = r.decay;
    sl.angle = r.spot.angle;
    sl.penumbra = r.spot.angle > 0 ? Math.min(1, Math.max(0, (r.spot.angle - (r.spot.inner ?? 0)) / r.spot.angle)) : 0;   // as three's GLTFLoader maps it
  }
}

/** Call once per frame. Reassigns when needed; writes every slot's uniforms. */
export function updateRig(now) {
  updateShadow();
  stepFades(now);   // before the pass: a fade begun this frame is drawn at its start amount first
  if (now - lastCasterPass > 300) { lastCasterPass = now; casterPass(); }
  if (assignDirty || now - lastAssign > 600 || _lastCam.distanceToSquared(camera.getWorldPosition(_eye)) > 2.25) {
    assign(now);
  }
  writeSpots();
  const lit = new Array(N_SLOTS).fill(null);
  for (const r of requests.values()) if (r.slot >= 0 && !r.spot) lit[r.slot] = r;
  for (let i = 0; i < N_SLOTS; i++) {
    const pl = slots[i], r = lit[i];
    if (!r) { pl.intensity = 0; continue; }
    if (r.mirror) {
      // an adopted foreign light: upstream drives its object, the slot copies it verbatim
      pl.position.copy(r.mirror.position);
      pl.color.copy(r.mirror.color);
      pl.intensity = r.mirror.intensity;
      pl.distance = r.mirror.distance;
      pl.decay = r.mirror.decay;
      trackShadowFar(pl);
      continue;
    }
    worldPosOf(r, pl.position);
    pl.color.set(r.color);   // Color.set takes a Color, a hex, or a string
    pl.intensity = r.intensity * (r.dayAware ? dayGlow() : 1);
    pl.distance = r.range;
    pl.decay = r.decay;
    trackShadowFar(pl);
  }
}

// ---- governor compatibility: the lights lever maps onto the slot cap -----------

export const litCount = () => {
  let n = 0;
  for (const r of requests.values()) if (r.slot >= 0) n++;
  return n;
};
export function shedALight() {
  if (slotCap === 0 || litCount() === 0) return false;
  setSlotCap(slotCap - 1);
  return true;
}

export const rigDebug = () => ({
  spots: spotSlots.map((sl) => ({ intensity: +sl.intensity.toFixed(3), angle: +sl.angle.toFixed(4), penumbra: +sl.penumbra.toFixed(4),
    pos: sl.position.toArray().map((x) => +x.toFixed(3)), dir: sl.target.position.clone().sub(sl.position).toArray().map((x) => +x.toFixed(3)) })),
  slots: N_SLOTS, cap: slotCap, dayness: dayness == null ? null : +dayness.toFixed(3),
  assignDirty,
  // the shadow gates; `wantsShadows` follows the REQUEST, not slots[SHADOW_SLOT], so a probe answers for the lamp
  shadows: (() => {
    const want = [...requests.values()].filter((r) => r.shadows);
    const held = want.filter((r) => r.slot >= 0);
    return {
      pref: shadowsOn(), map: renderer.shadowMap.enabled, sun: sun.castShadow, sunCasting: castsNow(sun),
      castingSlot: SHADOW_SLOT,
      slotIsCaster: castsNow(slots[SHADOW_SLOT]),
      wantsShadows: want.map((r) => ({
        key: r.key, slot: r.slot,
        casting: r.slot >= 0 && castsNow(slots[r.slot]),
        intensity: r.slot >= 0 ? +(slots[r.slot]?.intensity ?? 0).toFixed(3) : 0,
      })),
      anyCasting: held.some((r) => castsNow(slots[r.slot])),
      lamp: lampShadowState(),
    };
  })(),
  slotState: slots.map((pl, i) => ({
    i, casting: pl.castShadow, intensity: +pl.intensity.toFixed(3),
  })),
  _slots: slots,   // the live lights, for probes and test/client/shadow-fade-test.mjs; the fields above are the stable surface
  casters: casters.size, casterBudget,
  casting: [...casters.values()].filter((c) => c.casting).length,
  casterList: [...casters.values()].map((c) => ({ id: String(c.id).slice(0, 24), casting: c.casting, warm: c.warm, fade: +c.fade.toFixed(3), meshes: c.meshes.length })),
  requests: [...requests.values()].map((r) => ({
    key: r.key, slot: r.slot, keep: r.keep, authored: r.authored,
    mirror: Boolean(r.mirror), dayAware: r.dayAware,
  })),
});

// ---- the makeWeatherSystem seam --------------------------------------------

const sceneProxies = new WeakMap();
function proxyFor(realScene) {
  let p = sceneProxies.get(realScene);
  if (p) return p;
  p = new Proxy(realScene, {
    get(t, prop) {
      if (prop === 'add') {
        return (...objs) => {
          for (const o of objs) {
            if (o?.isLight) adoptForeign(o);
            else t.add(o);
          }
          return p;
        };
      }
      if (prop === 'remove') {
        return (...objs) => {
          for (const o of objs) {
            if (o?.isLight) unadoptForeign(o);
            else t.remove(o);
          }
          return p;
        };
      }
      const v = t[prop];
      return typeof v === 'function' ? v.bind(t) : v;
    },
    set(t, prop, val) { t[prop] = val; return true; },   // writes land on the real scene
  });
  sceneProxies.set(realScene, p);
  return p;
}

function adoptForeign(light) {
  requestLight(`foreign:${light.uuid}`, { mirror: light, keep: true, authored: true });
}
function unadoptForeign(light) {
  releaseLight(`foreign:${light.uuid}`);
}

/** Release every adopted foreign light. The sky's teardown calls this: its scene-diff cannot see the bolt (the seam
 *  kept it out of the scene), and a dead mirror would hold a reserved slot forever. */
export function releaseForeignLights() {
  for (const k of [...requests.keys()]) {
    if (k.startsWith('foreign:')) releaseLight(k);
  }
}

let _realMakeWeatherSystem = null;
Object.defineProperty(globalThis, 'makeWeatherSystem', {
  configurable: true,
  get() {
    if (!_realMakeWeatherSystem) return undefined;
    return (args = {}) => _realMakeWeatherSystem(
      args?.scene ? { ...args, scene: proxyFor(args.scene) } : args,
    );
  },
  set(fn) { _realMakeWeatherSystem = fn; },
});
