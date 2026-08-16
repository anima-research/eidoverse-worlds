// materials — the factory. Every material that enters the world scene passes
// through here at CREATION, before its first compile, and comes out carrying
// its final shader-graph shape: the wetness wrap, the cloud-shade term, and
// its shadow-receiving policy. After birth, everything the weather or the sky
// ever does to a surface is a uniform write. Nothing rewraps, nothing
// recompiles, nothing waits for the sky to arrive.
//
// Why this exists (TEL0S_NOTES §12): on three's WebGPU renderer a material's
// compiled pipeline dies whenever its node graph changes SHAPE. Upstream's
// weather/sky systems integrate by sweeping the scene and rewrapping already-
// compiled materials — measured at 44 rewraps on one Safari join, ~2-6s per
// graph there. The cure is to apply the wraps before the first compile ever
// happens, which means the wraps cannot depend on upstream systems that
// arrive seconds later. So the wraps here are CLIENT-OWNED and driven by
// FOLDED STATE (the same effectiveSky derivation the sequencer and the mcpl
// agent use), not by scraping the weather system's internals. Wet ground in
// rain works identically under the SkyMesh fallback, with Skye's modules
// nowhere in sight.
//
// Two wraps:
//   wetness     — a shape-identical port of weather_system.js wrapMaterial
//                 (same node structure, same noPuddles gate, our uniforms).
//                 Upstream's own transitions only ever write u.wetness after
//                 wrapping, so driving the same three uniforms IS the
//                 upstream behavior, minus the recompile.
//   cloud shade — our OWN cheap field, not a port: upstream's is a 16-tap
//                 march over textures generated inside makeSkySystem, which
//                 cannot exist before the sky modules do. Ground shadows need
//                 to READ as clouds, not match the dome tap-for-tap — theirs
//                 is already labelled cheapDensity. Two taps of a boot-made
//                 tileable noise texture, wind-scrolled, sun-projected.
//
// Every prepared mesh is marked userData.noWet + noCloudShadow, so upstream's
// sweeps (weather_system wrapScene, sky_system wrapCloudShadows) find nothing
// to do. Unprepared materials — the 🧩 mods escape hatch — still get swept
// exactly as before; that path degrades, it doesn't break.
//
// The noise lattice is SEEDED, not Math.random: every client grows the same
// cloud field, so two people standing together watch the same shadow cross
// the same meadow.

import { THREE, TSL, sun, ground, renderer } from './core.js';
import { state } from './state.js';
import { effectiveSky } from '../../shared/forecast.js';

const {
  uniform, texture, float, vec2, vec3, vec4, mix, clamp, smoothstep,
  fract, floor, dot, length, positionWorld, normalWorld, cameraPosition,
  materialColor, materialRoughness, materialMetalness,
} = TSL;

// ---- the shared uniform state -----------------------------------------------
// One set for the whole scene, exactly like upstream's: every wrapped
// material's subtree points at these. Writing them costs nothing per material.

const U = {
  // wetness (the upstream trio — wetTint is never written upstream either,
  // but it is part of the wrapped graph's shape, so it is part of ours)
  wet: uniform(0),
  wetTint: uniform(new THREE.Color(1, 1, 1)),
  puddleK: uniform(1),
  // cloud shade
  cloudStrength: uniform(0),                    // 0 ≡ gain exactly 1.0 (off)
  cloudLo: uniform(0.7),
  cloudHi: uniform(1.0),
  cloudOff: uniform(new THREE.Vector2(0, 0)),   // sun-projection offset (m)
  scroll1: uniform(new THREE.Vector2(0, 0)),    // wind accumulators (m)
  scroll2: uniform(new THREE.Vector2(0, 0)),
};

// ---- the cloud noise texture ------------------------------------------------
// Tileable multi-octave value noise, generated once at boot. The texture
// OBJECT is what the graphs bind, so its identity must never change — and it
// never does. Seeded PRNG (mulberry32): same field on every client.

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeCloudNoise(size = 256) {
  const rand = mulberry32(0x9e3779b9);
  const OCT = [{ cells: 4, amp: 0.5 }, { cells: 8, amp: 0.3 }, { cells: 16, amp: 0.2 }];
  const lattices = OCT.map((o) => {
    const arr = new Float32Array(o.cells * o.cells);
    for (let i = 0; i < arr.length; i++) arr[i] = rand();
    return arr;
  });
  const smooth = (t) => t * t * (3 - 2 * t);
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let v = 0;
      for (let o = 0; o < OCT.length; o++) {
        const { cells, amp } = OCT[o];
        const lat = lattices[o];
        const fx = (x / size) * cells, fy = (y / size) * cells;
        const ix = Math.floor(fx), iy = Math.floor(fy);
        const tx = smooth(fx - ix), ty = smooth(fy - iy);
        const w = (cx, cy) => lat[(cy % cells) * cells + (cx % cells)];
        v += amp * ((w(ix, iy) * (1 - tx) + w(ix + 1, iy) * tx) * (1 - ty)
          + (w(ix, iy + 1) * (1 - tx) + w(ix + 1, iy + 1) * tx) * ty);
      }
      const b = Math.max(0, Math.min(255, Math.round(v * 255)));
      const k = (y * size + x) * 4;
      data[k] = data[k + 1] = data[k + 2] = b;
      data[k + 3] = 255;
    }
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  return tex;
}

const noiseTex = makeCloudNoise();
// Primed ONCE at factory init (§16.1c): this texture rides INSIDE every PBR
// wrap's colorNode subtree (a TSL texture(...) node holds it as node.value),
// where assets.js collectTextures' Object.values walk can never see it — so
// every wrapped material's first compile used to meet it cold. core.js
// top-level-awaits renderer.init(), so the device exists here.
try { renderer.initTexture(noiseTex); } catch { /* first bind will get it */ }
// world-meters per texture tile, two octaves at different scales/speeds so
// the field boils instead of sliding as one rigid sheet
const CLOUD_SCALE1 = 1 / 420;
const CLOUD_SCALE2 = 1 / 97;
const CLOUD_H = 300;   // nominal cloud-base height the sun projection assumes

// ---- the wetness wrap (ported shape-identical from weather_system.js) -------
// Structure kept 1:1 with upstream's wrapMaterial (hash2/vnoise2 included)
// so the LOOK is the look worlds already have — only the uniforms are ours.

const hash2 = (p) => {
  const a = fract(vec3(p.x, p.y, p.x).mul(0.1031));
  const d = dot(a, vec3(a.y, a.z, a.x).add(33.33));
  const b = a.add(d);
  return fract(b.x.add(b.y).mul(b.z));
};
const vnoise2 = (p) => {
  const i = floor(p), f = fract(p);
  const sm = f.mul(f).mul(f).mul(f.mul(f.mul(6).sub(15)).add(10)); // quintic: C2, no lattice creases
  const a = hash2(i), b = hash2(i.add(vec2(1, 0)));
  const c = hash2(i.add(vec2(0, 1))), d = hash2(i.add(vec2(1, 1)));
  return mix(mix(a, b, sm.x), mix(c, d, sm.x), sm.y);
};

/** The cloud-shade factor for one material: 1.0 where the sky is open,
 *  dipping toward (1 - strength) under a cloud. Fresh subtree per material
 *  (matching how upstream builds per-wrap), shared uniforms + texture. */
function cloudShade() {
  const p = positionWorld.xz.add(U.cloudOff);
  const n1 = texture(noiseTex, p.add(U.scroll1).mul(CLOUD_SCALE1)).r;
  const n2 = texture(noiseTex, p.add(U.scroll2).mul(CLOUD_SCALE2)).r;
  const n = n1.mul(0.72).add(n2.mul(0.28));
  return float(1).sub(smoothstep(U.cloudLo, U.cloudHi, n).mul(U.cloudStrength));
}

function wrapMaterial(mat, receiver, pbr) {
  const upMask = clamp(normalWorld.y, 0, 1).pow(2).mul(U.wet);
  // crossed-card foliage carries upward normals for clump lighting, so
  // receivers can opt out of the ground-only puddle replacement path
  const puddleGate = (mat.userData?.noPuddles || receiver?.userData?.noPuddles)
    ? float(0) : float(1);
  const flat = smoothstep(0.985, 0.998, normalWorld.y);
  // puddle mask: threshold value noise near its MIDDLE (near-max contours
  // grid up), coarse octave warps the fine one so outlines meander
  const warp = vec2(
    vnoise2(positionWorld.xz.mul(0.045)),
    vnoise2(positionWorld.xz.mul(0.045).add(vec2(37.7, 11.3))),
  ).sub(0.5).mul(2.2);
  const pn = vnoise2(positionWorld.xz.mul(0.35).add(warp))
    .add(vnoise2(positionWorld.xz.mul(0.09)).mul(0.6));
  // distance-faded: procedural noise has no mips — far wet ground should
  // read as uniform sheen, not aggregated swamp
  const pDist = length(positionWorld.sub(cameraPosition));
  // shape × gate, always: sharpening after the wetness multiply would zero
  // all puddles in any state below full wet
  const pShape = smoothstep(0.97, 1.13, pn).mul(flat).mul(U.puddleK).mul(puddleGate)
    .mul(float(1).sub(smoothstep(160, 450, pDist)));
  const puddle = smoothstep(0.25, 0.6, pShape).mul(smoothstep(0.35, 0.9, U.wet));
  // normalize color roots to RGBA once — alpha must survive for cutout
  // silhouettes (foliage cards)
  const baseColor4 = vec4(mat.colorNode ?? materialColor);
  const baseRgb = baseColor4.rgb;
  // wetness reads through gloss, not blackness — mild darkening only
  const darkened = baseRgb.mul(mix(float(1), float(0.68), upMask.mul(0.85)));
  const wetCol = darkened.mul(mix(vec3(1, 1, 1), U.wetTint, upMask.mul(0.6)));
  // pseudo-depth from the shape mask: shallow rims barely change the
  // ground, centers deepen + cool — the see-through read
  const pDepth = smoothstep(0.3, 1.0, pShape);
  const waterFloor = wetCol.mul(mix(float(0.96), float(0.62), pDepth))
    .mul(mix(vec3(1, 1, 1), vec3(0.84, 0.91, 1.0), pDepth.mul(0.7)));
  const finalWetRgb = mix(wetCol, waterFloor, puddle);
  // cloud shade rides the same colorNode (PBR surfaces only — matching the
  // upstream cloud sweep's own selection)
  const rgb = pbr ? finalWetRgb.mul(cloudShade()) : finalWetRgb;
  mat.colorNode = vec4(rgb, baseColor4.a);
  if (pbr) {
    const baseRough = mat.roughnessNode ?? materialRoughness;
    mat.roughnessNode = mix(mix(baseRough, float(0.10), upMask.mul(0.8)), float(0.045), puddle);
    // water stays dielectric: low roughness supplies its Fresnel, not metal
    const baseMetal = mat.metalnessNode ?? materialMetalness;
    mat.metalnessNode = mix(baseMetal, float(0), puddle);
  }
  mat.needsUpdate = true;
}

// ---- the seam ---------------------------------------------------------------

const preparedMats = new WeakSet();
const stats = { meshes: 0, wrapped: 0, unlit: 0 };

/** Wrap one material, once. Basic (unlit) materials are skipped — a stand-in
 *  box and a light gizmo have no business getting wet. Returns whether the
 *  material was wrapped. */
export function prepareMaterial(mat, receiver = null) {
  if (!mat?.isNodeMaterial || preparedMats.has(mat)) return false;
  preparedMats.add(mat);
  if (mat.isMeshBasicNodeMaterial) { stats.unlit++; return false; }
  // upstream's own PBR duck test (sky_system wrapCloudShadows): real PBR gets
  // cloud shade + roughness/metalness terms; other lit node materials (MToon
  // bodies) get the wetness color term only — exactly what the sweeps did
  const pbr = mat.isMeshStandardNodeMaterial || mat.isMeshPhysicalNodeMaterial
    || (mat.roughness !== undefined && mat.metalness !== undefined);
  wrapMaterial(mat, receiver, pbr);
  stats.wrapped++;
  return true;
}

/** Pass a whole object through the factory: marks every mesh so upstream's
 *  sweeps skip it, applies the shadow-receiving policy for its kind, and
 *  wraps every material. Idempotent; call before the first compile. */
export function prepareObject(root, { kind = 'model' } = {}) {
  const receive = kind === 'model' || kind === 'terrain';
  const grass = kind === 'grass';
  root.traverse((o) => {
    if (!o.isMesh) return;
    stats.meshes++;
    o.userData.noWet = true;           // the upstream sweeps' skip markers —
    o.userData.noCloudShadow = true;   // this mesh is already dressed
    // EXPLICIT both ways: upstream vegetation ships receiveShadow=true, and
    // an if-without-else here silently left the scene's biggest fill
    // surface paying per-fragment shadow taps while the comment claimed
    // otherwise (§13.1 — intent is not behavior)
    o.receiveShadow = receive;
    // grass never CASTS either: leaf cards already ship castShadow=false
    // upstream, but shrub wood ships TRUE (vegetation.js:989) — five
    // shadow-depth pipelines nothing ever pre-warms, compiled synchronously
    // on the first shadow frame after grass lands. Blob-shadow philosophy
    // (§16.2.B); castShadow sits in NO pipeline cache key (§12.1), and this
    // runs before the field's warm (world.js), so clearing it here is free.
    if (grass) o.castShadow = false;
    const mats = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
    for (const m of mats) {
      // grass never puddles: blade normals are deliberately forced straight
      // up for clump lighting, which sails through the puddle flatness gate
      // — without this, rain paints puddles ON BLADES and rewrites
      // roughness/metalness across 318k instances. The gate is compile-time
      // (§12.2), so the branch costs nothing. Wet darkening + cloud shade
      // stay — a rain-dark meadow under crossing cloud shadows is the shot.
      if (grass) m.userData.noPuddles = true;
      prepareMaterial(m, o);
    }
  });
  return root;
}

// ---- the driver -------------------------------------------------------------
// Folded state in, uniform writes out. Weather targets derive at ~1Hz (the
// same cadence sky.js ticks its clock); easing runs per frame. Ground wets
// fast and dries slow, which is what ground does.

const WET = { clear: 0, fair: 0, sunshower: 0.55, overcast: 0.15, rain: 0.85, storm: 1, cyclone: 1, darkstorm: 1 };
const WX_COVER = { clear: 0, fair: 0.18, sunshower: 0.35, overcast: 0.85, rain: 0.9, storm: 0.92, cyclone: 0.96, darkstorm: 1 };
const CLOUD_COVER = { clear: 0, cumulus: 0.38, stratus: 0.6, cirrus: 0.15 };
// wind directions (unit-ish) for the two octaves — different headings so the
// field evolves instead of translating
const WIND1 = { x: 1.9, y: 0.55 };
const WIND2 = { x: -0.7, y: 1.3 };

let cursor = null;        // effectiveSky's O(1) segment cursor
let lastDerive = 0;
let lastTick = 0;
let smoothTargetCover = 0;
const target = { wet: 0, cover: 0 };
const _dir = new THREE.Vector3();

function deriveTargets() {
  const a = state.st?.sky;
  if (!a) { target.wet = 0; target.cover = 0; return; }
  const eff = effectiveSky(a, Date.now(), cursor);
  cursor = eff.cursor;
  const w = eff.weather && WET[eff.weather] !== undefined ? eff.weather : 'clear';
  const k = eff.k ?? 1;
  target.wet = (WET[w] ?? 0) * k;
  target.cover = Math.max(CLOUD_COVER[a.clouds] ?? 0, (WX_COVER[w] ?? 0) * k);
}

const approach = (cur, goal, dt, tau) => cur + (goal - cur) * Math.min(1, dt / tau);

/** Per-frame: ease the weather uniforms toward folded state and keep the
 *  cloud field moving. Cheap — a handful of uniform writes. */
export function updateMaterials(nowMs) {
  const dt = lastTick ? Math.min(0.25, (nowMs - lastTick) / 1000) : 0.016;
  lastTick = nowMs;
  if (nowMs - lastDerive > 1000) { lastDerive = nowMs; deriveTargets(); }

  // ground wets in ~10s, dries in ~40s
  U.wet.value = approach(U.wet.value, target.wet, dt, target.wet > U.wet.value ? 10 : 40);

  // wind scroll: speed scales gently with coverage (storms move faster)
  const windK = 1 + target.cover * 2.5;
  U.scroll1.value.x += WIND1.x * windK * dt;
  U.scroll1.value.y += WIND1.y * windK * dt;
  U.scroll2.value.x += WIND2.x * windK * dt;
  U.scroll2.value.y += WIND2.y * windK * dt;

  // sun projection: a cloud shadows the point the sun-ray through it hits.
  // sun.position is driven by whichever sky is live (and swaps to moonlight
  // at night, which shadows exactly as it should)
  _dir.copy(sun.position).normalize();
  const off = CLOUD_H / Math.max(0.25, _dir.y);
  U.cloudOff.value.set(_dir.x * off, _dir.z * off);

  // coverage moves the threshold window (more sky covered → more ground
  // shaded); full overcast flattens the patchiness — uniform grey sky casts
  // no travelling shadows, it just dims (which sunDim already does)
  const cover = approach(smoothTargetCover, target.cover, dt, 15);
  smoothTargetCover = cover;
  const lo = 1.02 - 0.72 * cover;
  U.cloudLo.value = lo;
  U.cloudHi.value = lo + 0.22;
  const sunUp = Math.max(0, Math.min(1, _dir.y * 4));
  const patchy = 1 - Math.max(0, Math.min(1, (cover - 0.8) / 0.17));
  U.cloudStrength.value = 0.5 * sunUp * patchy * Math.min(1, cover * 3);
}

/** Debug surface (EW.materials). */
export const materialsDebug = () => ({
  ...stats,
  wet: +U.wet.value.toFixed(3),
  cover: +smoothTargetCover.toFixed(3),
  strength: +U.cloudStrength.value.toFixed(3),
  target: { ...target },
});

// The stage floor exists before any verb lands and compiles on the first
// frame — it goes through the factory at module init, same as everything
// after it. (core.js cannot import us: core imports nothing.)
prepareObject(ground, { kind: 'terrain' });
