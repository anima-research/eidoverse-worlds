// lod_policy — which geometry tier a placement fetches, decided BEFORE the
// fetch, from three local inputs and nothing the world shares:
//
//   the RESIDENT's dial     models⚙ — auto / full detail / eco (reduce
//                           sooner: the pressured band, always). Persisted per
//                           browser like clouds⚙ and grass⚙; never a verb.
//   the DISTANCE            how far the placement sits from the resident's
//                           eye or body, whichever is nearer (models.js
//                           entDist), against the entity's own residency radius
//                           (R_BASE + bbox diagonal × k, shared/lod-distance.js) — so a
//                           cathedral goes reduced later than a mug.
//   DEVICE PRESSURE         GPU memory against the proto budget (assets.js
//                           gpuPressure) and the frame governor's shed — a
//                           fixed 1.5 GB budget, not the card's own capacity.
//
// The answer is 'full' or 'lod'. 'lod' asks for the recipe the running sequencer PUBLISHED on /version
// (shared/ktx2.js lodFromVersion); none published, no tier asked. The server answers with the variant or the original
// (the loader records which: userData.tierServed), and colliders/support never read the reduced mesh (models.js: a
// lod-tier placement owns no collider until it upgrades on approach); the build pointer's raycast (build.js aimPoint) can.
//
// Hysteresis: a placement at the band edge must not flip tiers every sweep.
// The upgrade edge sits inside the downgrade edge by LOD_HYST on each side.
//
// DOM-free and side-effect-free: unit-tested in test/client/lod-policy-test.ts.

import { negotiate, withLod } from '../../../shared/ktx2.js';

export const MODEL_QUALITY = ['auto', 'full', 'eco'];
// the distance geometry is shared with the server's LOD budget (shared/lod-distance.js)
export { LOD_FRACTION, LOD_HYST } from '../../../shared/lod-distance.js';
import { LOD_FRACTION, LOD_HYST } from '../../../shared/lod-distance.js';
/** Under pressure — and on the 'eco' dial — the edge halves: reduced
 *  tiers come in much closer, but never to arm's length. */
export const PRESSURE_EDGE = 0.5;
/** GPU memory / proto budget at which the policy calls it pressure. */
export const PRESSURE_AT = 0.8;
/** Metres from a placement's ORIGIN inside which it is full detail, on every dial and at every scale: a lod-tier placement
 *  owns no collider, no support surface (models.js), and what is in reach must have them. A long model's far end can still
 *  be in reach while its origin is past this (chooseTier's dist is to the origin). The unscaled radius never came this
 *  close (R ≥ 80m → an eco upgrade edge of 13.5m); a scaled-down placement would — a 0.1× rack at 4m. */
export const LOD_NEAR_MIN = 10;

const KEY = 'ew-model-quality';

/** The dial state. `store` is localStorage in the browser, anything with
 *  getItem/setItem in tests, or absent (state then lives for the session). */
export function makeModelQuality(store) {
  const saved = store?.getItem?.(KEY);
  let quality = MODEL_QUALITY.includes(saved) ? saved : 'auto';
  let shed = false;   // the governor's session dial — never persisted
  return {
    get quality() { return quality; },
    get shed() { return shed; },
    setQuality(q) {
      if (!MODEL_QUALITY.includes(q)) return quality;
      quality = q;
      store?.setItem?.(KEY, q);
      return quality;
    },
    setShed(v) { shed = !!v; return shed; },
  };
}

/** The tier to fetch for a placement.
 *  `dist` metres from the resident's eye or body, the nearer; `radius` the entity's residency
 *  radius; `quality` the dial; `recipe` what /version published (null → no
 *  negotiation, ever); `pressure` gpu memory / budget (0..∞); `shed` the
 *  governor's session dial; `current` the tier it wears now, for hysteresis; `scale` the placement's uniform scale.
 *
 *  SCALE: the server budgets each LOD (2 px of error, 1 texel per pixel) at the unscaled model's closest switch
 *  distance, and a placement at scale s is s× bigger on screen at every distance — so its edge moves by exactly s: a
 *  3× pallet goes reduced at 3× the distance (its error stays 2 px, not 6), a 0.1× server rack at a tenth (down to
 *  LOD_NEAR_MIN). A scaled-UP placement can therefore skip the reduced tier altogether: residency (models.js) is
 *  unscaled, and a 3× pallet is demoted to its stand-in (~108 m) before its reduced edge (~150 m) — full detail until
 *  then, a memory cost, never a quality one. The scale is read as a number ("3" is 3, as three.js's setScalar reads
 *  it); anything that isn't a positive finite number is 1. */
export function chooseTier({ dist, radius, quality = 'auto', recipe = null, pressure = 0, shed = false, current = null, scale = 1 }) {
  if (!recipe || quality === 'full') return 'full';
  // 'eco' is the pressured band, always: the edge halves. Near the model's origin stays full on every dial (dist is to
  // the origin, so a long model's far end can be reduced at arm's length); only 'full' ignores distance (in the other direction).
  const squeezed = quality === 'eco' || pressure >= PRESSURE_AT || shed;
  const n = Number(scale), s = Number.isFinite(n) && n > 0 ? n : 1;
  const edge = Math.max((radius > 0 ? radius : 80) * LOD_FRACTION * (squeezed ? PRESSURE_EDGE : 1) * s,
    LOD_NEAR_MIN / (1 - LOD_HYST));   // the UPGRADE edge, edge × (1 − H), never inside LOD_NEAR_MIN
  if (current === 'lod') return dist < edge * (1 - LOD_HYST) ? 'full' : 'lod';
  if (current === 'full') return dist > edge * (1 + LOD_HYST) ? 'lod' : 'full';
  return dist > edge ? 'lod' : 'full';
}

/** Which tier a parsed GLB actually is — the server's word, read off the
 *  identity stamp the reducer writes (asset.extras {lodOf, recipe,
 *  tools}) and bound to the RUNNING recipe. Not "any recipe extra": an
 *  authored model may carry an unrelated `recipe` of its own, and reading
 *  that as a lod would strip a full source model of its collider. lodOf must be
 *  present and recipe must equal what /version published; anything else —
 *  a wrong-generation stamp, a bare recipe, the original chain answering a
 *  lod ask — is 'full', honestly. */
export function tierOf(gltfJson, recipe) {
  const x = gltfJson?.asset?.extras;
  if (!recipe || !x || typeof x !== 'object') return 'full';
  return typeof x.lodOf === 'string' && x.lodOf.length > 0 && x.recipe === recipe ? 'lod' : 'full';
}

/** The WIRE truth of a tier choice: the URL a load
 *  actually fetches and which tier that URL asks for. A lod ask rides the
 *  KTX2 negotiation because the reduced variant's textures ARE KTX2 — a
 *  browser without the transcoder (`capable` false), a sequencer that
 *  published no key or no recipe, or a non-.glb path cannot ask, and the
 *  answer says so: tier 'full', no `lod=` on the wire. The realizer keys
 *  its hysteresis and its reporting on THIS, never on what the policy
 *  wished. */
export function askFor({ libPath, key = null, capable = false, recipe = null, tier = 'full' }) {
  const glb = typeof libPath === 'string' && libPath.endsWith('.glb');
  const k = glb && capable && key ? key : null;
  const url = negotiate(libPath, k);
  if (tier === 'lod' && k && recipe) return { url: withLod(url, recipe), tier: 'lod' };
  return { url, tier: 'full' };
}
