// headset-seen-test: the stored headset bit is HISTORY, and says so (#197).
// Nothing clears `ew-headset-seen` when a headset is unplugged, and isSessionSupported stays optimistic after a headset
// is switched off, so a re-probe isn't honest either: the value carries WHEN, expires, and the copy claims only that a
// headset has been USED here. Drives the REAL client/lib/xr/headset_seen.js (no imports, nothing to stub); its wiring (the
// boot backend choice, the panel copy, the time stamp's writers) is in test/client/wiring-check.ts.
// Run: BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun test/client/headset-seen-test.mjs
// Mutations that must turn a named check red:
//   headset_seen.js: headsetSeenRecently ignores the TTL (always true once seen)
//   headset_seen.js: an unmigrated legacy '1' reads as recent again (the permanence defect)
//   (core.js, videopanel.js and xr.js mutations go red in test/client/wiring-check.ts)
import { headsetSeenAt, migrateHeadsetSeen, headsetSeenRecently, HEADSET_SEEN_TTL_MS } from '../../client/lib/xr/headset_seen.js';
import { suite } from "../gate/suite.ts";


const S = suite("headset-seen");
const check = (name, ok, detail) => S.check(name, ok, detail);

const NOW = 1_800_000_000_000;

console.log('\nwhat the stored value means:');
check('never seen → null', headsetSeenAt(null) === null);
check('garbage → null', headsetSeenAt('yes please') === null);
check('a timestamp reads back as itself', headsetSeenAt(String(NOW)) === NOW);
check('the legacy "1" marker still reads as seen (time unknown)', headsetSeenAt('1') === 0);

console.log('\nwhen it still chooses the backend:');
check('a session an hour ago counts', headsetSeenRecently(NOW, String(NOW - 3600e3)) === true);
check('a session a week ago counts', headsetSeenRecently(NOW, String(NOW - 7 * 864e5)) === true);
check('a session 29 days ago counts', headsetSeenRecently(NOW, String(NOW - 29 * 864e5)) === true);
check('a session 31 days ago has EXPIRED — the machine stops claiming a headset',
  headsetSeenRecently(NOW, String(NOW - 31 * 864e5)) === false);
check('the TTL is a month, not a lifetime and not a session',
  HEADSET_SEEN_TTL_MS > 7 * 864e5 && HEADSET_SEEN_TTL_MS <= 90 * 864e5, `${HEADSET_SEEN_TTL_MS / 864e5} days`);
check('never seen → not recently', headsetSeenRecently(NOW, null) === false);
// THE BOUNDARY, not a day either side: `<` → `<=` and a millisecond TTL shift must fail (the other TTL check is a loose 7..90-day range)
check('exactly at the TTL is NOT recent (the boundary, not a day either side)',
  headsetSeenRecently(NOW, String(NOW - HEADSET_SEEN_TTL_MS)) === false);
check('…and one millisecond inside it still is',
  headsetSeenRecently(NOW, String(NOW - HEADSET_SEEN_TTL_MS + 1)) === true);
// the legacy guard is bound by the GUARD, not arithmetic: `now - 0` exceeds any TTL, so a large epoch passes without the guard
check('the legacy 0 is rejected by the GUARD, not by TTL arithmetic',
  headsetSeenAt('1') === 0 && headsetSeenRecently(HEADSET_SEEN_TTL_MS - 1, '1') === false);
// '1' carries no time, so it must not read as "recent" forever
check('an UNMIGRATED legacy marker is not "recent" — unknown time is not a licence',
  headsetSeenRecently(NOW, '1') === false);
check('migrating a legacy marker stamps it with the time it was first seen under this build',
  migrateHeadsetSeen(NOW, '1') === String(NOW));
check('…and a migrated marker then reads as recent', headsetSeenRecently(NOW, migrateHeadsetSeen(NOW, '1')) === true);
check('…and ages out on the SAME clock as every real timestamp',
  headsetSeenRecently(NOW + HEADSET_SEEN_TTL_MS + 1, migrateHeadsetSeen(NOW, '1')) === false);
check('a real timestamp is not re-stamped (migration touches only the legacy marker)',
  migrateHeadsetSeen(NOW, String(NOW - 5)) === null);
check('nothing stored migrates to nothing', migrateHeadsetSeen(NOW, null) === null);
// STRICT equality on the legacy marker: loose `==` matches 1, '1.0', ' 1 ', true, [1], so a numeric 1 is re-stamped every
// boot and never expires. Pin the near-misses.
for (const [raw, label] of [['01', "'01'"], [1, 'the NUMBER 1'], ['0', "'0'"], [undefined, 'undefined'], [' 1 ', "' 1 '"]]) {
  check(`${label} is NOT the legacy marker`, migrateHeadsetSeen(NOW, raw) === null, `migrated to ${migrateHeadsetSeen(NOW, raw)}`);
}
check("'01' reads as the timestamp 1, not as the legacy marker", headsetSeenAt('01') === 1);
check("'0' and undefined read as never-seen", headsetSeenAt('0') === null && headsetSeenAt(undefined) === null);

// the copy and the wiring (the panel's words, the predicate's callers, the time stamp's writers): test/client/wiring-check.ts

S.done();
