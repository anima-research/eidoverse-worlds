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
 *  The legacy marker '1' reads as 0 — "seen, TIME UNKNOWN". It is not a timestamp and must not be
 *  treated as one; see migrateHeadsetSeen for how it stops being permanent. */
export function headsetSeenAt(raw) {
  if (raw === '1') return 0;
  const t = Number(raw);
  return Number.isFinite(t) && t > 0 ? t : null;
}

/** The legacy marker is MIGRATED ON FIRST OBSERVATION, not honoured forever (#197 round-two review
 *  B3). Previously '1' mapped to 0 and 0 returned true unconditionally, so exactly the users carrying
 *  the old marker — the population the original defect created — stayed "headset-capable" forever,
 *  even with the headset gone or the machine replaced. Automatic backend choice never expired.
 *
 *  Stamping it with the time we FIRST SAW it under this build is the honest reading of what the
 *  marker says: "a headset was used here at some unknown time before now". That starts the same
 *  30-day clock every real timestamp gets, and one granted session re-stamps it properly.
 *
 *  Returns the value to persist, or null if nothing needs writing. The caller owns storage. */
export function migrateHeadsetSeen(now, raw) {
  return raw === '1' ? String(now) : null;
}

/** Has a headset been used here recently enough to still choose the backend for it?
 *  `now` and `raw` only — the legacy marker is not special-cased here, because by the time this is
 *  asked the caller has migrated it. An unmigrated '1' is treated as UNKNOWN, which is the safe
 *  answer: the visor still works, it just reloads once instead of entering in place. */
export function headsetSeenRecently(now, raw) {
  const at = headsetSeenAt(raw);
  if (at === null || at === 0) return false;
  return now - at < HEADSET_SEEN_TTL_MS;
}
