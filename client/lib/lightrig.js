// lightrig — one owner for every runtime light, built on the r184 ground
// truth (TEL0S_NOTES §12.1): the pipeline cache keys lights by (id,
// castShadow) in scene-traversal order, intensity-0 lights stay in the hash,
// and visible=false culls them out of it. So the rig's contract is:
//
//   The light TOPOLOGY is born at module init and never changes. N point
//   slots live under one group, created before the first compile, never
//   added, removed, reparented, or visible-toggled after. An idle slot is
//   intensity 0 — the supported "off". Everything that used to add or
//   remove a PointLight (placed lights within a budget, emissive lamps,
//   the weather system's lightning) becomes a REQUEST, and slot churn is
//   uniform writes.
//
// This deletes the disease at its root: adding a point light was a
// whole-scene recompile (grass + 4 lights measured never finishing), so a
// budget of 4, a compileAsync per grant, and a one-way governor ratchet all
// existed to ration it. Slots make the cost a boot-time constant.
//
// Requests are assigned deterministically in (state, camera): keep-marked
// and adopted lights first, then authored placed lights, then inferred
// lamps — ties by camera distance, stable-keyed, with an incumbent bonus so
// a walk along the boundary doesn't flicker a porch light. Two clients in
// the same spot light the same way. `keep` is top PRIORITY, not a budget
// escape: with more keeps than slots, the farthest keep glows without
// casting — the pool is the physics, honestly stated.
//
// N defaults to 8 — MEASURED, not guessed (lightbench --measure, 2026-08-09):
// with the compile at boot instead of mid-session, a full grass field
// compiled in 1379/1510/1551/1597ms at 4/8/12/16 slots and held ~120fps at
// every count on this hardware. The old "grass + 4 lights never finished
// compiling" was the runtime-recompile churn, now structurally gone. 8 is
// the modest end of the §5 target band because per-fragment loop cost and
// WGSL→Metal compile scale with slot count and weaker machines haven't
// been measured yet; the governor's cap lever handles them downward, and
// ?slots=N re-measures anytime.
//
// ---- the foreign-light seam -------------------------------------------------
// makeWeatherSystem permanently scene.add()s one lightning PointLight at
// construction (upstream already drives it slot-style — "a strike changes
// uniform data only" — it just doesn't know about our pool). One rendered
// frame with a foreign light in the scene is a full recompile storm, so the
// swallow has to happen at add(), not after construction: the same
// defineProperty seam sky.js uses for makeSkySystem hands the weather
// factory a Proxy of the scene whose add/remove intercepts lights into an
// ADOPTION list. The rig mirrors an adopted light's live properties into a
// slot each frame — the strike flashes exactly as authored, through our
// topology. The proxy is stable per real scene (weather_system keys its
// one-system-per-scene registry on the scene object it was handed).
// The seam deletes the day upstream grows a strikeLight injection
// (docs/upstream-wrap-once.md addendum).

import { THREE, scene, camera, renderer, sun } from './core.js';
import { CSMShadowNode } from 'three/addons/csm/CSMShadowNode.js';
import { CONFIG, tee } from './base.js';
import { warmDepth } from './warmqueue.js';

// ---- the fixed inventory ----------------------------------------------------

// Number.isFinite guard: ?slots=abc yielding NaN would create zero slots and
// then throw in updateRig's Array(NaN) every frame — with no try/catch around
// the frame loop, that silently stops rAF and freezes the whole client. The
// measurement knob must not be a foot-gun (review note 4).
const _slotsParam = Number(CONFIG.params.get('slots') ?? 8);
const N_SLOTS = Number.isFinite(_slotsParam) ? Math.max(0, Math.min(16, Math.round(_slotsParam))) : 8;

const rigGroup = new THREE.Group();
rigGroup.name = 'lightrig';
const slots = [];
for (let i = 0; i < N_SLOTS; i++) {
  const pl = new THREE.PointLight(0xffffff, 0, 10, 1.7);
  pl.name = `slot${i}`;
  pl.castShadow = false;    // point-light shadows are a cost cliff the rig
                            // never pays — the sun is the one shadow caster
  slots.push(pl);
  rigGroup.add(pl);
}
scene.add(rigGroup);

// The sun is the one shadow caster, and its config is topology: shadowMap
// enabled/type are in the pipeline cache key (§12.1), so they are set here,
// once, before the first compile, and never touched again. mapSize/bias and
// the camera extents are uniform-level — the governor may move mapSize both
// ways, and the frustum follows the camera below. (This block lived in
// main.js; the rig owns the caster, so it owns the caster's terms.)
// The resident's shadow switch (persisted; the video settings row). Read here
// so the first compile already knows — shadowMap.enabled is pipeline-shape,
// and a live flip recompiles once; castShadow alone is free (§12.1).
const SH_KEY = 'ew-shadows';
const stored = (k) => { try { return localStorage.getItem(k); } catch { return null; } };   // storage can throw (site data blocked)
export const shadowsOn = () => stored(SH_KEY) !== 'off';
export function setShadows(on) {
  localStorage.setItem(SH_KEY, on ? 'on' : 'off');
  renderer.shadowMap.enabled = on;
  sun.castShadow = on;
}
renderer.shadowMap.enabled = shadowsOn();
renderer.shadowMap.type = ({ basic: THREE.BasicShadowMap, pcf: THREE.PCFShadowMap, soft: THREE.PCFSoftShadowMap })[CONFIG.params.get('shadowtype')] ?? THREE.PCFSoftShadowMap;   // ?shadowtype=basic|pcf|soft (boot-time: pipeline-shape) — R 09-07 19:22 diagnostic
sun.castShadow = shadowsOn();
// shadow map resolution (persisted; the video settings row, R 09-07 21:32). Uniform-level:
// three's ShadowNode setSize()s the target every update, so a live change is a realloc, no recompile.
const RES_KEY = 'ew-shadow-res';
export const SHADOW_RES = [1024, 2048, 4096];
export const shadowRes = () => { const v = +stored(RES_KEY); return SHADOW_RES.includes(v) ? v : 2048; };
export function setShadowRes(n) { localStorage.setItem(RES_KEY, String(n)); sun.shadow.mapSize.set(n, n); }
sun.shadow.mapSize.set(shadowRes(), shadowRes());
// ?csm=2|3|4 — cascaded shadow maps (bench probe, R 09-07 21:32: 'better performance in VR'; Basis ships 4
// cascades over 150 m, first split at 12%). three's CSMShadowNode fits one ortho camera per cascade around the
// VIEW frustum every frame, with lightMargin m of room behind the light — the follow-box below is replaced by
// it wholesale (the near-plane trap of a2e25e2 cannot occur by construction). Each cascade is its own map at
// mapSize, so N cascades = N depth passes; the trade is sharper near shadows + horizon coverage against fill.
const CSM_N = Math.min(4, Math.max(0, +CONFIG.params.get('csm') || 0));
export let csm = null;
if (CSM_N >= 2) {
  csm = new CSMShadowNode(sun, { cascades: CSM_N, maxFar: +CONFIG.params.get('csmfar') || 150, mode: CONFIG.params.get('csmmode') || 'practical', lightMargin: 100 });
  sun.shadow.shadowNode = csm;
  addEventListener('resize', () => csm.updateFrustums());
}
if (CONFIG.params.has('shadowfloat')) sun.shadow.mapType = THREE.FloatType;   // ?shadowfloat=1 (boot) — R 09-07 19:30: 32-bit float depth map; a D3D11/ANGLE comparison-sampling variant to test on her GPU
sun.shadow.bias = -0.0006;
sun.shadow.normalBias = 0.02;
// Boot line for the shadow state (R 09-07 19:10: 'nothing casts a shadow except right under my avatar' on desktop
// too, while a headless probe measured the yucca casting) — the persisted switch, the map, and where the sun is.
if (CONFIG.params.has('shadowdebug')) setTimeout(() => { try { const d = sun.position.clone().normalize(); tee(`[shadows] csm=${csm ? csm.cascades : 0} pref=${shadowsOn() ? 'on' : 'off'} map=${renderer.shadowMap.enabled} type=${renderer.shadowMap.type} size=${sun.shadow.mapSize.x} sun=(${d.x.toFixed(2)},${d.y.toFixed(2)},${d.z.toFixed(2)}) intensity=${sun.intensity.toFixed(2)} casters=${casters.size} casting=${[...casters.values()].filter((c) => c.casting).length}`);
  // real-hardware facts (R 09-07 19:28: no ground shadow on her GPU, SwiftShader shows one): the map's depth texture, GL error state, the extensions that shape the shadow path
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
    ...spec, key, slot: -1,
  });
  assignDirty = true;
}
/** Patch a live request.
 *
 *  INTENSITY DOES NOT DIRTY ASSIGNMENT. Slot assignment is by TIER and CAMERA
 *  DISTANCE -- intensity is not an input to it, and the rig deliberately
 *  recomputes at most every 600ms while writing slot values every frame. A
 *  breathing lamp calls this 60 times a second, so dirtying on every patch
 *  defeated that cadence entirely, for a value the sorter does not read.
 *  (mica caught it in review of PR #173.)
 *
 *  Anything that CAN change the ordering still dirties: tier, the object being
 *  followed, or the owner. */
const ORDERING_KEYS = ['keep', 'authored', 'obj', 'offset', 'pos', 'mirror', 'owner'];
export function updateRequest(key, patch) {
  const r = requests.get(key);
  if (!r) return;
  Object.assign(r, patch);
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
// Models that glow shed light: any spawned object with emissive surfaces gets
// a lamp REQUEST at each emissive mesh's centre (≤2 per object — a chandelier
// is one fixture, not ten). No budget, no whenBooted deferral: a request
// costs nothing until it wins a slot, and winning one is uniform writes.
// (This was sky.js attachLocalLights, which owned a hard MAX_LAMPS=2 ceiling
// and a boot deferral that both existed to ration recompiles.)

/** @returns {{key:string, intensity:number}[]} the requests it made -- a caller
 *  that wants to ANIMATE a lamp needs the key and the intensity the inference
 *  chose, and reading either back out of the private map was the alternative. */
export function attachLamps(root, owner) {
  const made = [];
  const emissive = [];
  root.traverse((o) => {
    if (!o.isMesh) return;
    const m = o.material;
    const glow = (m?.emissiveIntensity ?? 1) *
      Math.max(m?.emissive?.r ?? 0, m?.emissive?.g ?? 0, m?.emissive?.b ?? 0);
    if (glow > 0.5 || (m?.emissiveMap && (m?.emissiveIntensity ?? 1) > 1)) {
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
      dayAware: true, owner,
    });
    made.push({ key, intensity });
  });
  return made;
}

// ---- time of day ------------------------------------------------------------
// The sky tells the rig how day it is (applyTuning, both sky paths); lamps
// and placed lights answer with the same glow curve lamps always had. A
// placed light dimming at noon is the §5 design — the opt-out verb arg
// (`day: false`, the deliberate noon porch light) rides 5f with its fixture.

// UNSET, not noon. This was `1`, and dayGlow is (1-dayness)^2 -- so an unset
// clock scaled every day-aware light to exactly ZERO. setDayness has one caller
// (sky.js applyTuning), which runs when a sky is applied, so before any sky
// condition loaded a lamp emitted light and cast none. Janus found it: "the
// lighting from the lamp doesn't happen until I load a sky condition."
//
// A default of 1 is the worst of the range: it makes "we do not know the time
// yet" indistinguishable from "the brightest moment of the day", and it fails
// TOTALLY rather than partially. Null says unknown, and unknown lights the
// lamp -- a light that works before the sky loads and then dims is a much
// better wrong answer than one that is missing until you touch a menu.
let dayness = null;
export function setDayness(d) { dayness = d; }
const dayGlow = () => (dayness == null ? 1 : Math.pow(1 - dayness, 2));
/** The same curve the cast lights use, for anything that GLOWS rather than
 *  casts. An emissive surface has no slot and never passed through here, so a
 *  lamp's bulb burned at full strength at midnight and at noon alike -- glaring
 *  after dark, washed out at midday. Exported so the surface and its light dim
 *  on ONE curve. */
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

function worldPosOf(r, out) {
  if (r.mirror) return out.copy(r.mirror.position);
  if (r.obj) {
    r.obj.getWorldPosition(out);
    if (r.offset) out.add(_wp.copy(r.offset).applyQuaternion(r.obj.getWorldQuaternion(_q)).multiplyScalar(r.obj.getWorldScale(_s).x || 1));
    return out;
  }
  return out.set(...(r.pos ?? [0, 1, 0]));
}
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _p = new THREE.Vector3();

function assign(now) {
  lastAssign = now;
  _lastCam.copy(camera.position);
  assignDirty = false;
  const ranked = [...requests.values()].map((r) => {
    const d = worldPosOf(r, _p).distanceTo(camera.position);
    return {
      r,
      tier: r.keep ? 0 : r.authored ? 1 : 2,
      d: r.slot >= 0 ? d * 0.85 : d,   // incumbents hold their ground
    };
  }).sort((a, b) => a.tier - b.tier || a.d - b.d || (a.r.key < b.r.key ? -1 : 1));
  // Mirrors (the adopted lightning) hold RESERVED slots: they are upstream's
  // own lights with transient authored intensity, so they neither compete on
  // camera distance nor answer to the governor's cap — a shed-to-zero pool
  // must not silently delete a storm's strikes (review note 5).
  const mirrors = ranked.filter((x) => x.r.mirror).slice(0, N_SLOTS).map((x) => x.r);
  const nonMirror = ranked.filter((x) => !x.r.mirror);
  // `keep` exempts a light from perf-governor shedding (PROTOCOL §3.1): the
  // cap applies to the SHEDDABLE tail only, so keep-tier requests always
  // assign. Only physics outbids a keep — more keeps than slots and the
  // nearest win; the rest glow without casting, the honest limit.
  const keeps = nonMirror.filter((x) => x.r.keep)
    .slice(0, Math.max(0, N_SLOTS - mirrors.length))
    .map((x) => x.r);
  const rest = nonMirror.filter((x) => !x.r.keep)
    .slice(0, Math.max(0, Math.min(slotCap, N_SLOTS - mirrors.length - keeps.length)))
    .map((x) => x.r);
  const winners = [...mirrors, ...keeps, ...rest];
  const winnerSet = new Set(winners);
  // evicted requests free their slots first, then newcomers take free ones —
  // a request that stays assigned keeps its slot (no one-frame handoff)
  for (const r of requests.values()) {
    if (r.slot >= 0 && !winnerSet.has(r)) r.slot = -1;
  }
  const used = new Set(winners.map((r) => r.slot).filter((i) => i >= 0));
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
// The frustum FOLLOWS the camera. The old ±46 box was pinned to the world
// origin — shadows simply stopped existing 46 units from spawn. Moving
// sun.position would fight the sky (which rewrites it per frame on the
// eidoverse path and at 1Hz on the skymesh path), so the follow slides the
// ORTHO EXTENTS instead: express the camera in the light's view frame and
// re-centre left/right/top/bottom/near/far around it. Extents are uniform-
// level (§12.1 — we call updateProjectionMatrix ourselves; three won't),
// so this is recompile-free and sky-agnostic. Extents snap to shadow-map
// texels or every step of the walk re-samples every shadow edge (shimmer).

const SHADOW_HALF = 46;    // the measured box, unchanged — CSM later
const SHADOW_DEPTH = 90;   // covers relief + trees around the focus plane
const _sm = new THREE.Matrix4();
const _sx = new THREE.Vector3(), _sy = new THREE.Vector3(), _sz = new THREE.Vector3();
const _rel = new THREE.Vector3(), _cw = new THREE.Vector3();
const _ZERO = new THREE.Vector3();

function updateShadow() {
  if (csm) return;   // the cascades fit themselves around the view (updateBefore)
  const cam = sun.shadow.camera;
  // WORLD position: in VR the camera is a child of the rig (xr.js: rig.position = where you stand, rig.add(camera)),
  // so camera.position is the head's offset inside the rig — the box sat at the world origin while R stood 50 m
  // away, and every desktop test passed because desktop never parents the camera (R in-headset 09-07 22:28)
  _rel.copy(camera.getWorldPosition(_cw)).sub(sun.position);
  _sm.lookAt(sun.position, _ZERO, THREE.Object3D.DEFAULT_UP);
  _sm.extractBasis(_sx, _sy, _sz);
  const texel = (2 * SHADOW_HALF) / (sun.shadow.mapSize.x || 2048);
  const fx = Math.round(_rel.dot(_sx) / texel) * texel;
  const fy = Math.round(_rel.dot(_sy) / texel) * texel;
  cam.left = fx - SHADOW_HALF;
  cam.right = fx + SHADOW_HALF;
  cam.top = fy + SHADOW_HALF;
  cam.bottom = fy - SHADOW_HALF;
  // the light camera looks down -z, so the focus sits -fz in front of it.
  // dist goes NEGATIVE whenever the camera stands up-sun of the light's
  // fixed point (sun.position is ~27-60 m from the origin; every prop in
  // staging is at x 40-60, z 42-69 — 15-25 m BEHIND that point). The old
  // `Math.max(0.1, …)` clamp assumed only a below-horizon sun could do that
  // and threw the whole quarter out of the map: 12 casters "casting", no
  // shadow on any GPU (R 09-07). An orthographic camera takes a negative
  // near; three reads shadow.camera.near/far only for VSM and log depth.
  const dist = -_rel.dot(_sz);
  cam.near = dist - SHADOW_DEPTH;
  cam.far = dist + SHADOW_DEPTH;
  cam.updateProjectionMatrix();
}

// ---- the caster budget ------------------------------------------------------
// object.castShadow is in NO pipeline cache key (§12.1) — toggling it only
// changes shadow-pass render-list membership. So the caster set is a live
// distance budget, not a drip: the nearest K entities cast, the rest keep
// receiving. A caster's depth pipelines are PRE-WARMED through the conductor
// (warmqueue.warmDepth, §16.2.A) before its castShadow ever flips — the old
// flow paid a synchronous createRenderPipeline inside the next shadow render
// per enable, which was the rhythmic 300ms-beat hitch (§16.1c). The ≤2/beat
// budget stays, now counting FLIPS of already-warm casters; disables stay
// immediate (free — castShadow is in no cache key). Bodies stay on their
// blob shadows until measured (§12.5).

const casters = new Map();   // id -> { obj, meshes, casting, warm, released }
let casterBudget = 12;
let lastCasterPass = 0;

/** The models realizer registers every realized model here; retire releases. */
export function registerCaster(id, obj) {
  const meshes = [];
  obj.traverse((o) => { if (o.isMesh) meshes.push(o); });
  casters.set(id, { id, obj, meshes, casting: false, warm: 'none', released: false });
}
export function releaseCaster(id) {
  const c = casters.get(id);
  if (c) c.released = true;   // a queued warm re-reads this and skips the work
  casters.delete(id);
}
export const casterCount = () => casters.size;
export function setCasterBudget(k) { casterBudget = Math.max(0, k); }
export const getCasterBudget = () => casterBudget;

function casterPass() {
  const ranked = [...casters.values()]
    .map((c) => ({ c, d: c.obj.getWorldPosition(_p).distanceToSquared(camera.getWorldPosition(_cw)) }))
    .sort((a, b) => a.d - b.d);
  let enables = 0;
  for (let i = 0; i < ranked.length; i++) {
    const { c } = ranked[i];
    const want = i < casterBudget;
    if (want === c.casting) continue;
    if (!want) {                          // disables are free — flip now
      c.casting = false;
      for (const m of c.meshes) m.castShadow = false;
      continue;
    }
    // an unwarmed caster never flips: ask the conductor once, flip on a
    // later beat once its depth pipelines exist (the end state is identical
    // to the old flow, merely later by the warm latency)
    if (c.warm === 'none') {
      c.warm = 'pending';
      warmDepth(`depth ${String(c.id).slice(0, 24)}`, () => (c.released ? [] : c.meshes))
        .then(() => { c.warm = 'done'; });
      continue;
    }
    if (c.warm !== 'done') continue;      // still warming
    if (enables >= 2) continue;           // ≤2 FLIPS per beat, as before
    enables++;
    c.casting = true;
    for (const m of c.meshes) m.castShadow = true;
  }
}

// ---- the per-frame drive ----------------------------------------------------

/** Call once per frame. Reassigns when needed; writes every slot's uniforms. */
export function updateRig(now) {
  updateShadow();
  if (now - lastCasterPass > 300) { lastCasterPass = now; casterPass(); }
  if (assignDirty || now - lastAssign > 600 || _lastCam.distanceToSquared(camera.position) > 2.25) {
    assign(now);
  }
  const lit = new Array(N_SLOTS).fill(null);
  for (const r of requests.values()) if (r.slot >= 0) lit[r.slot] = r;
  for (let i = 0; i < N_SLOTS; i++) {
    const pl = slots[i], r = lit[i];
    if (!r) { pl.intensity = 0; continue; }
    if (r.mirror) {
      // the lightning (or any adopted foreign light): copy it verbatim —
      // upstream drives its object, the slot is its body in our topology
      pl.position.copy(r.mirror.position);
      pl.color.copy(r.mirror.color);
      pl.intensity = r.mirror.intensity;
      pl.distance = r.mirror.distance;
      pl.decay = r.mirror.decay;
      continue;
    }
    worldPosOf(r, pl.position);
    pl.color.set(r.color);   // Color.set takes a Color, a hex, or a string
    pl.intensity = r.intensity * (r.dayAware ? dayGlow() : 1);
    pl.distance = r.range;
    pl.decay = r.decay;
  }
}

// ---- governor compatibility -------------------------------------------------
// The 5d governor gets real two-way levers; until then main.js's existing
// shed lever maps onto the cap — and unlike the old MAX_CAST ratchet, this
// one can come back up.

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
export function restoreALight() {
  if (slotCap >= N_SLOTS) return false;
  setSlotCap(slotCap + 1);
  return true;
}

export const rigDebug = () => ({
  slots: N_SLOTS, cap: slotCap, dayness: dayness == null ? null : +dayness.toFixed(3),
  // Whether the next pass will recompute slot assignment. Exposed because the
  // 600ms cadence is a PROPERTY worth testing -- a per-frame patch that dirties
  // it defeats the cadence silently.
  assignDirty,
  casters: casters.size, casterBudget,
  casting: [...casters.values()].filter((c) => c.casting).length,
  casterList: [...casters.values()].map((c) => ({ id: String(c.id).slice(0, 24), casting: c.casting, warm: c.warm, meshes: c.meshes.length })),
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
    // property writes land on the real scene (default [[Set]] would too —
    // explicit so nobody has to re-derive it)
    set(t, prop, val) { t[prop] = val; return true; },
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

/** Release every adopted foreign light. The sky's teardown calls this: the
 *  scene-diff that undoes a sky build cannot see the bolt (the seam kept it
 *  OUT of the scene on purpose), and on the eidoverse→skymesh paths that
 *  never construct a replacement weather system, the registry-eviction
 *  release never fires either — a dead mirror would hold a reserved slot
 *  forever, frozen at whatever intensity the last strike left it (review
 *  blocker 2: storms peak at intensity 12000). */
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
