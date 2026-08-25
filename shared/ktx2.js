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
// observed during rollout. 3 — the clean post-rollout generation.
export const KTX2_KEY = '3';
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

/** The sequencer's own spelling (tests, tools): negotiate with the key this
 *  file defines. A BROWSER must not call this — it would be reading the key
 *  off disk again, which is the collision. */
export function withKtx2(url) {
  return negotiate(url, KTX2_KEY);
}
