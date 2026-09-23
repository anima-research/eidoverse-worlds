// lod_policy — which geometry tier a placement fetches, decided BEFORE the
// fetch (the #156 client contract), from three local inputs and nothing the
// world shares:
//
//   the RESIDENT's dial     models⚙ — auto / full detail / eco (reduce
//                           sooner: the pressured band, always). Persisted per
//                           browser like clouds⚙ and grass⚙; never a verb.
//   the DISTANCE            how far the placement sits from the resident's
//                           eye, against the entity's own residency radius
//                           (R_BASE + bbox diagonal × k, models.js) — so a
//                           cathedral goes reduced later than a mug.
//   DEVICE PRESSURE         GPU memory against the proto budget (assets.js
//                           gpuPressure) and the frame governor's shed — a
//                           6GB card and a 24GB card should not fetch alike.
//
// The answer is 'full' or 'lod'. 'lod' asks the running sequencer for the
// recipe it PUBLISHED on /version (shared/ktx2.js lodFromVersion) — no
// recipe published, no tier asked, ever: an older sequencer, or a failed
// /version fetch, degrades to exactly today's behaviour. And a lod request
// is never a WORSE model: the server answers with the variant when one
// exists and the original chain otherwise (provisional), the loader records
// which arrived (userData.tierServed), and colliders/support/raycast never
// read the reduced mesh at all (models.js: a lod-tier placement owns no
// collider until it upgrades on approach).
//
// Hysteresis: a placement at the band edge must not flip tiers every sweep.
// The upgrade edge sits inside the downgrade edge by LOD_HYST on each side.
//
// DOM-free and side-effect-free: unit-tested in tools/lod-policy-test.ts.

import { negotiate, withLod } from '../../shared/ktx2.js';

export const MODEL_QUALITY = ['auto', 'full', 'eco'];
/** Fraction of the residency radius beyond which 'auto' fetches the reduced
 *  tier. R = 80m + diag×4 (models.js), so a 2m prop goes reduced past ~40m,
 *  a 20m building past ~70m. */
export const LOD_FRACTION = 0.45;
/** Band hysteresis: upgrade below edge×(1−H), downgrade above edge×(1+H). */
export const LOD_HYST = 0.25;
/** Under pressure — and on the 'eco' dial — the edge halves: reduced
 *  tiers come in much closer, but never to arm's length. */
export const PRESSURE_EDGE = 0.5;
/** GPU memory / proto budget at which the policy calls it pressure. */
export const PRESSURE_AT = 0.8;

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
 *  `dist` metres from the resident's eye; `radius` the entity's residency
 *  radius; `quality` the dial; `recipe` what /version published (null → no
 *  negotiation, ever); `pressure` gpu memory / budget (0..∞); `shed` the
 *  governor's session dial; `current` the tier it wears now, for hysteresis. */
export function chooseTier({ dist, radius, quality = 'auto', recipe = null, pressure = 0, shed = false, current = null }) {
  if (!recipe || quality === 'full') return 'full';
  // 'eco' is the pressured band, always: the edge halves. It does NOT reduce
  // what you stand beside — the first field run did, and a 66m rig's girders
  // at arm's length became slabs across the camera. Near stays full on every
  // dial; only 'full' ignores distance (in the other direction).
  const squeezed = quality === 'eco' || pressure >= PRESSURE_AT || shed;
  const edge = (radius > 0 ? radius : 80) * LOD_FRACTION * (squeezed ? PRESSURE_EDGE : 1);
  if (current === 'lod') return dist < edge * (1 - LOD_HYST) ? 'full' : 'lod';
  if (current === 'full') return dist > edge * (1 + LOD_HYST) ? 'lod' : 'full';
  return dist > edge ? 'lod' : 'full';
}

/** Which tier a parsed GLB actually is — the server's word, read off the
 *  identity stamp the reducer writes (#156: asset.extras {lodOf, recipe,
 *  tools}) and bound to the RUNNING recipe. Not "any recipe extra": the
 *  reducer preserves source extras, and an authored model may carry an
 *  unrelated `recipe` of its own (review of #170, point 1) — reading that as
 *  a lod would strip a full source model of its collider. lodOf must be
 *  present and recipe must equal what /version published; anything else —
 *  a wrong-generation stamp, a bare recipe, the original chain answering a
 *  lod ask — is 'full', honestly. */
export function tierOf(gltfJson, recipe) {
  const x = gltfJson?.asset?.extras;
  if (!recipe || !x || typeof x !== 'object') return 'full';
  return typeof x.lodOf === 'string' && x.lodOf.length > 0 && x.recipe === recipe ? 'lod' : 'full';
}

/** The WIRE truth of a tier choice (review of #170, point 2): the URL a load
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
