// ktx2 — the texture negotiation KEY: defined here, PUBLISHED by the running
// sequencer, and only ever used by a client that got it from that sequencer.
//
// A KTX2-capable client asks for a library or store asset with ?ktx2=<key>
// and the sequencer answers with the GPU-native variant when one exists, the
// original otherwise (routes.ts, the §20 negotiation). The key is a
// GENERATION, not a boolean: rotating it is the only way to walk away from a
// poisoned cache — an answer served `max-age=31536000, immutable` under an
// old key never revalidates, not in a browser, not in nginx (it keys on the
// full query string), no matter what the origin says afterwards. A fresh key
// is a fresh cache entry everywhere at once; the old one simply stops being
// asked for.
//
// WHO READS IT is the second half of the contract, learned on rollout day.
// The sequencer imports this file at boot. The browser used to import it too
// — off the sequencer's DISK — and in the window between `git pull` and the
// restart the old process was serving the new file: a client read key 2 off
// disk and asked a server that had never heard of it, which answered as if
// unflagged (webp, immutable), and nginx pinned that under ?ktx2=2. The =2
// generation was retired within minutes of being born. So the browser no
// longer reads the key from any file: it asks the RUNNING process (/version
// carries `ktx2Key`, no-store, resolved at that process's boot) and uses
// exactly what it was handed. No key handed — an older sequencer, a failed
// fetch — means NO negotiation: an unflagged fetch is always the right answer
// for its URL, so nothing can be pinned wrong, on any deploy, in any order.
//
// Generations: 1 — the §20 launch key (2026-08-10), retired 2026-08-24 because
// provisional fall-throughs had been served immutable under it. 2 — the PR #142
// rollout key, retired immediately when an already-poisoned nginx cache entry was
// observed during rollout. 3 — the clean post-rollout generation, retired when
// the recipe joined the key: model variants baked BEFORE the texel budget
// (#146) still sat under it — on the show box, 2026-09-29, 71 of 89, textures
// up to 8192², the store's pinned immutable — and a re-bake under the same URL
// reaches no cache that already holds the old bytes. 4 — below.
//
// THE KEY DERIVES FROM THE RECIPE. A variant's bytes are a function of its
// source and the recipe that baked it; the key is the only part of a flagged
// URL a client can vary; so a recipe change that did not rotate the key would
// serve a new generation's bytes under an address caches hold the old
// generation's for — or, behind nginx, never serve them at all. KTX2_GEN is
// the part no parameter names (a poisoned cache to walk away from, a changed
// encoder); the recipe is the part that is measured. Both are in the key, the
// recipe is in the model variant's FILENAME too (store-variants.ts
// ktx2VariantPath), and the running sequencer publishes the key it booted
// with. Bodies and loose images ride the same key (one key, one negotiation):
// their bytes do not depend on this recipe, and a rotation refetches them once.
export const KTX2_GEN = 4;
/** The house texel budget: the longest side a model texture may have in this
 *  world, in either shadow (server/store-variants.ts tells the story). */
export const KTX2_TEXEL_CAP = 1024;
/** The model recipe, from every parameter a variant's bytes depend on. */
export function ktx2RecipeFor({ texel = KTX2_TEXEL_CAP } = {}) {
  if (!Number.isInteger(texel) || texel < 4 || texel % 4) throw new Error(`ktx2 texel cap must be a positive multiple of 4: ${texel}`);
  return `texel${texel}`;
}
export const KTX2_RECIPE = ktx2RecipeFor();
/** The negotiation key: generation + recipe, publishable as-is (the shape
 *  keyFromVersion accepts — a key a client would refuse is not a key). */
export function ktx2KeyFor({ gen = KTX2_GEN, recipe = KTX2_RECIPE } = {}) {
  if (!Number.isInteger(gen) || gen < 1) throw new Error(`ktx2 generation must be a positive integer: ${gen}`);
  const key = `${gen}-${recipe}`;
  if (!/^[A-Za-z0-9._-]{1,32}$/.test(key)) throw new Error(`ktx2 key is not publishable: ${key}`);
  return key;
}
export const KTX2_KEY = ktx2KeyFor();   // "4-texel1024"
export const KTX2_QUERY = `ktx2=${KTX2_KEY}`;

/** Does this request negotiate KTX2 — the CURRENT key only. A retired key is
 *  an unflagged fetch: whatever that client cached under it is what it
 *  already has, and a new client never asks with it. */
export function wantsKtx2(params) {
  return params.get('ktx2') === KTX2_KEY;
}

/** The key the running sequencer published, read off its /version body —
 *  or null when it published none (an older sequencer, or not JSON at all),
 *  which the client must treat as "do not negotiate". Never a default. */
export function keyFromVersion(json) {
  const k = json && typeof json === 'object' ? json.ktx2Key : undefined;
  return typeof k === 'string' && /^[A-Za-z0-9._-]{1,32}$/.test(k) ? k : null;
}

/** Append the negotiation to a URL that may already carry a query (avatar
 *  URLs carry ?v=<mtime>) — with the key GIVEN, which for a browser is the
 *  one /version handed it. No key → the URL untouched: an unflagged fetch. */
export function negotiate(url, key) {
  if (!key) return url;
  return url + (url.includes('?') ? '&' : '?') + `ktx2=${key}`;
}

/** The LOD recipe the running sequencer published on /version, or null when
 *  it published none — an older sequencer, and the client must not ask for a
 *  tier it never heard of (the same split-brain that poisoned ?ktx2=2: an
 *  unknown param falls through to the original, served immutable under the
 *  flagged URL). Same doctrine as keyFromVersion: never a default. */
export function lodFromVersion(json) {
  const l = json && typeof json === 'object' ? json.lodRecipe : undefined;
  return typeof l === 'string' && l.length > 0 && l.length <= 64 ? l : null;
}

/** Append the LOD tier request — the RECIPE the running sequencer published,
 *  never a bare boolean (review of #156, point 1: `lod=1` under two recipes
 *  is one immutable URL for two different byte-streams — the ?ktx2=2
 *  split-brain, one level down). No recipe → the URL untouched. Only
 *  meaningful alongside the ktx2 negotiation (a LOD variant carries KTX2
 *  textures). */
export function withLod(url, recipe) {
  if (!recipe) return url;
  return url + (url.includes('?') ? '&' : '?') + `lod=${encodeURIComponent(recipe)}`;
}

/** The sequencer's own spelling (tests, tools): negotiate with the key this
 *  file defines. A BROWSER must not call this — it would be reading the key
 *  off disk again, which is the collision. */
export function withKtx2(url) {
  return negotiate(url, KTX2_KEY);
}
