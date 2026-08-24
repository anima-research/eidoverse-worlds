// ktx2 — the texture negotiation KEY, one constant both sides import.
//
// A KTX2-capable client asks for a library or store asset with ?ktx2=<key>
// and the sequencer answers with the GPU-native variant when one exists, the
// original otherwise (routes.ts, the §20 negotiation). The key is a
// GENERATION, not a boolean, and it lives here rather than as a literal in
// four client fetch sites and one server branch, because rotating it is the
// only way to walk away from a poisoned cache: an answer served
// `max-age=31536000, immutable` under ?ktx2=1 — which is what every store
// upload's flagged answer WAS, webp included (2026-08-24, the show box) —
// never revalidates, not in a browser, not in nginx (it keys on the full
// query string), no matter what the origin says afterwards. A fresh key is
// a fresh cache entry everywhere at once; the old one simply stops being
// asked for. Bump this when a flagged answer has been pinned wrong.
//
// Generations: 1 — the §20 launch key (2026-08-10), retired 2026-08-24 because
// provisional fall-throughs had been served immutable under it.
export const KTX2_KEY = '2';
export const KTX2_QUERY = `ktx2=${KTX2_KEY}`;

/** Does this request negotiate KTX2 — the CURRENT key only. A retired key is
 *  an unflagged fetch: whatever that client cached under it is what it
 *  already has, and a new client never asks with it. */
export function wantsKtx2(params) {
  return params.get('ktx2') === KTX2_KEY;
}

/** Append the negotiation to a URL that may already carry a query
 *  (avatar URLs carry ?v=<mtime>). */
export function withKtx2(url) {
  return url + (url.includes('?') ? '&' : '?') + KTX2_QUERY;
}
