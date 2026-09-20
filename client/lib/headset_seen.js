// What "a headset was seen here" actually means, as pure functions. core.js owns the storage read;
// this owns the meaning. tools/headset-seen-test.mjs drives it directly. No imports on purpose.
//
// The stored value is HISTORY, not presence (#197 review B3). Nothing can clear it when a headset is
// unplugged, and a live re-probe is no better: `isSessionSupported` stays optimistic after a headset
// is switched off (mictoggle.js:91). So it keeps its job — letting the next boot pick WebGL up front
// so the visor ENTERS instead of RELOADING — but it carries WHEN, and it expires, so a machine that
// has not seen a headset in a month stops choosing a backend for one it may no longer have.
export const HEADSET_SEEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;   // 30 days

/** When a headset was last actually used here, or null if never.
 *  The legacy marker '1' reads as 0 — "seen, time unknown" — and is honoured until the next granted
 *  session re-stamps it with a real time. */
export function headsetSeenAt(raw) {
  if (raw === '1') return 0;
  const t = Number(raw);
  return Number.isFinite(t) && t > 0 ? t : null;
}

/** Has a headset been used here recently enough to still choose the backend for it? */
export function headsetSeenRecently(now, raw) {
  const at = headsetSeenAt(raw);
  if (at === null) return false;
  if (at === 0) return true;
  return now - at < HEADSET_SEEN_TTL_MS;
}
