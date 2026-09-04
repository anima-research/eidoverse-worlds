// seats — the browser's seat-profile cache and gate assembly (#101).
//
// One judge, three readers: this is reader one and two (the local body and
// every remote both route through mountTransform, which asks here). The
// cache holds SERVER-JUDGED verdicts from /avatars — never a rehashed file,
// never a default — refreshed on connect and on the two update events, with
// per-name fetch generations so a slow response from before an acceptance
// can never roll the acceptance back (seatcore.makeGenerationGuard; the #95
// lesson wearing seat-profile clothes).
//
// The runtime gate (seatcore.seatGate) additionally needs two local truths
// the server cannot know: which mixer slot is ACTUALLY playing on the rider
// (setClip's fallback walk must never let "sit" consume a chair profile),
// and the digest of the clip bytes this page really loaded (assets.js
// hashes them once at fetch — a filename is not an identity).

import { bus } from './base.js';
import { vrmaShaLoaded } from './assets.js';
import { makeVerdictCache, seatGate, riderScalar, nameFromAvatarPath, SEAT_CLIP_FILE } from './seatcore.js';

// The cache logic — epochs, pending demotion, event-rev floors — lives ONCE
// in seatcore.makeVerdictCache, shared verbatim with the headless agent and
// pinned by bun against the #105 review's four vectors. This module supplies
// only the browser's transport and wiring.
const cache = makeVerdictCache(async () => {
  const res = await fetch('/avatars', { cache: 'no-store' });
  if (!res.ok) throw new Error(`roster ${res.status}`);
  const rev = Number(res.headers.get('x-profiles-rev') ?? NaN);
  return { rev, entries: await res.json() };
});
let started = false;

export function initSeats() {
  if (started) return;
  started = true;
  // note() bumps BEFORE its refetch departs and demotes the held verdict to
  // pending immediately — the order is the whole guarantee
  bus.on('avatar-updated', ({ name }) => cache.note(name, NaN));
  bus.on('avatar-profile-updated', ({ name, rev }) => cache.note(name, Number(rev)));
  cache.init();
}

/** The full gate for one mounted rider, assembled from the served verdict
 *  plus this page's runtime truths. `rider` is {path, av} — the avatar path
 *  the roster knows the body by, and the live wrapper (null while loading).
 *  Returns {applied:true, contactY, scale} or {applied:false, reason} — the
 *  reason is the declared string, shared verbatim with the other readers. */
export function seatCorrectionFor(rider, sock) {
  if (!rider || !rider.path) return { applied: false, reason: 'no rider context' };
  if (!rider.av) return { applied: false, reason: 'body loading' };
  const name = nameFromAvatarPath(rider.path);
  if (!name) return { applied: false, reason: 'no rider context' };
  const verdict = cache.get(name);
  const sc = riderScalar([rider.av.root.scale.x, rider.av.root.scale.y, rider.av.root.scale.z]);
  if (!sc.ok) return { applied: false, reason: sc.why };
  const g = seatGate({
    sock, verdict,
    pose: sock?.pose ?? 'sitchair',
    currentSlot: rider.av.currentSlot,
    loadedClipSha256: vrmaShaLoaded(SEAT_CLIP_FILE),
    currentClipSha256: verdict?.clipSha256,
  });
  if (!g.apply) return { applied: false, reason: g.reason };
  return { applied: true, contactY: g.contactY, scale: sc.s };
}

// ---- declaration bookkeeping ------------------------------------------------
// One console line per state CHANGE per rider — a seat that stays approximate
// through a whole sit logs once, not per frame; standing up clears the key so
// the next sit declares afresh.

const declared = new Map(); // riderId → last declared "to/slot state reason"
export function declareSeatState(riderId, to, slot, state, reason) {
  const key = `${to}/${slot ?? 'seat'} ${state} ${reason ?? ''}`;
  if (declared.get(riderId) === key) return;
  declared.set(riderId, key);
  if (state === 'approximate') console.info(`[seat] ${riderId} on ${to}/${slot ?? 'seat'}: seat approximate — ${reason}`);
  else console.info(`[seat] ${riderId} on ${to}/${slot ?? 'seat'}: seat profiled`);
}
export function clearSeatState(riderId) { declared.delete(riderId); }
