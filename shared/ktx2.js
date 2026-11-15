// ktx2 — the texture negotiation key: defined here, published by the running server on /version (`ktx2Key`), and only
// ever used by a client that got it from there.
//
// A KTX2-capable client asks for an asset with ?ktx2=<key> and the server answers with the GPU-native variant when one
// exists (server/routes.ts). The key is a GENERATION, not a boolean: a variant is served short-lived (VARIANT_CC), but an
// answer once served immutable never revalidates, so rotating the key is the only way to leave a poisoned cache behind.
// Retired generations: docs/research/ktx2-key-generations.md.
//
// The client imports its helpers (assets.js, prefetch.js) but never KTX2_KEY: a browser reads the key off /version, and no
// key means no negotiation.
export const KTX2_KEY = '4';
export const KTX2_QUERY = `ktx2=${KTX2_KEY}`;

/** Does this request negotiate KTX2? The CURRENT key only; a retired key is an unflagged fetch. */
export function wantsKtx2(params) {
  return params.get('ktx2') === KTX2_KEY;
}

/** The key the running server published on /version, or null when it published none ("do not negotiate"). Never a default. */
export function keyFromVersion(json) {
  const k = json && typeof json === 'object' ? json.ktx2Key : undefined;
  return typeof k === 'string' && /^[A-Za-z0-9._-]{1,32}$/.test(k) ? k : null;
}

/** Append the negotiation to a URL (which may already carry a query) with the key GIVEN. No key: the URL untouched. */
export function negotiate(url, key) {
  if (!key) return url;
  return url + (url.includes('?') ? '&' : '?') + `ktx2=${key}`;
}

/** The LOD recipe the running server published on /version, or null when it published none (an unknown tier would be
 *  served as the original, immutable, under the flagged URL). Never a default. */
export function lodFromVersion(json) {
  const l = json && typeof json === 'object' ? json.lodRecipe : undefined;
  return typeof l === 'string' && l.length > 0 && l.length <= 64 ? l : null;
}

/** Append the LOD tier request: the published RECIPE, never a bare boolean (one immutable URL must mean one byte-stream).
 *  No recipe: the URL untouched. Only meaningful alongside the ktx2 negotiation. */
export function withLod(url, recipe) {
  if (!recipe) return url;
  return url + (url.includes('?') ? '&' : '?') + `lod=${encodeURIComponent(recipe)}`;
}

/** The server's own spelling (tests, tools): negotiate with the key this file defines. A browser must not call this. */
export function withKtx2(url) {
  return negotiate(url, KTX2_KEY);
}
