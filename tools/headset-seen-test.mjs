// headset-seen-test — the stored headset bit is HISTORY, and says so (#197 review B3).
//
// `ew-headset-seen` was written on a granted session and never cleared, and the Video panel read it
// as "Right now: a headset is present". Nothing can clear it when a headset is unplugged, and a live
// re-probe is not an honest substitute — isSessionSupported stays optimistic after a headset is
// switched off (mictoggle.js:91). So the value carries WHEN, expires, and the copy claims only what
// is known: a headset has been USED here.
//
// Drives the REAL client/lib/headset_seen.js (no imports, so nothing to stub and nothing a stub could
// invent). The wiring checks bind it to its real consumers: the boot backend choice and the panel copy.
//
// Run: BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun tools/headset-seen-test.mjs
//
// Mutations that must turn a named check red:
//   headset_seen.js: headsetSeenRecently ignores the TTL (always true once seen)
//   headset_seen.js: an unmigrated legacy '1' reads as recent again (the permanence defect)
//   core.js: the migration stops writing back, so the marker never ages
//   core.js: the boot choice reads the raw bit again instead of the predicate
//   videopanel.js: the copy returns to "Right now: a headset is present"
//   xr.js: a granted session writes '1' instead of the time
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { headsetSeenAt, migrateHeadsetSeen, headsetSeenRecently, HEADSET_SEEN_TTL_MS } from '../client/lib/headset_seen.js';

const dir = dirname(fileURLToPath(import.meta.url));
const read = (f) => readFileSync(join(dir, '..', f), 'utf8');
const core = read('client/lib/core.js');
const panel = read('client/lib/videopanel.js');
const xr = read('client/lib/xr.js');

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  else { fail++; console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? ` — ${detail}` : ''}`); }
};

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
// THE LEGACY MARKER MUST NOT BE PERMANENT (#197 round-two review B3). This suite previously
// asserted `headsetSeenRecently(NOW, '1') === true` — pinning the defect in place: '1' mapped to 0
// and 0 returned true unconditionally, so exactly the users carrying the old marker stayed
// "headset-capable" forever, with a gone headset or a new machine.
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
{ const core = readFileSync(new URL('../client/lib/core.js', import.meta.url), 'utf8');
  check('core.js MIGRATES on read and writes the stamp back, or the marker never ages',
    /migrateHeadsetSeen/.test(core) && /setItem\(PREF_HEADSET_SEEN, migrated\)/.test(core)); }

console.log('\nthe copy claims only what is known:');
check('the Video panel no longer says a headset IS present',
  !/headset is present/i.test(panel) && !/Right now: a headset/i.test(panel));
check('…it says one has been USED here', /has been used here/i.test(panel));
check('the no-headset branch is equally past-tense',
  !/no headset sensed/i.test(panel) && /No headset has been used here recently/i.test(panel));
check('the WebGPU warning is past-tense too',
  !/⚠ A headset is present/.test(panel) && /A headset has been used here/.test(panel));
check('the panel asks the PREDICATE, not the raw bit',
  /headsetSeenRecently\(\)/.test(panel) && !/PREF_HEADSET_SEEN\) === '1'/.test(panel));

console.log('\nthe wiring:');
check('the boot backend choice asks the predicate',
  /headsetSeen: headsetSeenRecently\(\)/.test(core));
check('a granted session stamps the TIME, not a flag',
  !/setItem\(PREF_HEADSET_SEEN, '1'\)/.test(xr) && !/setItem\('ew-headset-seen', '1'\)/.test(xr));
check('…at every writer', (xr.match(/setItem\(PREF_HEADSET_SEEN, String\(Date\.now\(\)\)\)/g) ?? []).length === 2,
  `${(xr.match(/setItem\(PREF_HEADSET_SEEN, String\(Date\.now\(\)\)\)/g) ?? []).length} writers stamp the time`);

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
