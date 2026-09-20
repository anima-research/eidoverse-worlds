// capsule-recovery-test — the capsule is a FLOOR, not a verdict (#196 review B1).
//
// The review's required evidence: a product-path test proving fail → capsule → SAME body recovery,
// including same-path remote reannouncement and authority takeover. Drives the REAL
// client/lib/remotes.js (renderer-side imports stubbed; the recovery logic itself is the product).
//
// Run: BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun tools/capsule-recovery-test.mjs
//
// Each of these mutations of the PRODUCT must turn a named check red:
//   remotes.js: never set `r.capsuleFor` on the fallback    → nothing knows a debt is owed
//   remotes.js: `retryBody` body removed (early return)     → the debt is never paid
//   remotes.js: same-path reannounce stops calling retryBody → the reannounce path stays terminal
//   remotes.js: takeover drops `fresh.capsuleFor`            → takeover makes the substitution permanent
//   remotes.js: drop the POST-load `remotes.get(id) !== r`   → a mid-flight body lands on a superseded record
//
// Two mutants SURVIVE this suite and are declared, not hidden:
//   • dropping the PRE-load guard (top of the timer) — EQUIV here: every scenario that supersedes
//     during the backoff is caught one line later by the post-load guard, which this suite does bind.
//     It is belt-and-braces against a supersede between timer fire and the first await.
//   • RETRY_MAX 3 → 9999 — not distinguishable inside a sane test window: the backoff
//     (400/1600/5000 ms) is what limits attempts over ~5 s, not the cap. Measured 09-19: a dead
//     asset yields retries 1→2→3 and attempts 1→3 under BOTH values. Killing it would need a
//     ~15 s test; the cap's observable (counter stops, further announces arm nothing) is bound
//     instead, which is what the product promises.
import { plugin } from 'bun';
import { fileURLToPath } from 'node:url';
const here = (f) => fileURLToPath(new URL(f, import.meta.url));

// One shared control object with the avatar stub (see recovery-avatar-stub.mjs):
//   .failing — whether a real-body load rejects;  .attempts — how many were requested.
const probe = (globalThis.__avatarProbe ||= { failing: true, attempts: 0, made: [] });
probe.reset = () => { probe.failing = true; probe.attempts = 0; probe.made = []; };

plugin({
  name: 'recovery-stubs',
  setup(b) {
    b.onResolve({ filter: /^\.\/core\.js$/ }, () => ({ path: here('./core-stub.mjs') }));
    b.onResolve({ filter: /^\.\/avatar\.js$/ }, () => ({ path: here('./recovery-avatar-stub.mjs') }));
    b.onResolve({ filter: /^\.\/world\.js$/ }, () => ({ path: here('./recovery-empty-stub.mjs') }));
    b.onResolve({ filter: /^\.\/seats\.js$/ }, () => ({ path: here('./recovery-empty-stub.mjs') }));
    b.onResolve({ filter: /^\.\/reachnet\.js$/ }, () => ({ path: here('./recovery-empty-stub.mjs') }));
    b.onResolve({ filter: /^\.\/poseclips\.js$/ }, () => ({ path: here('./recovery-empty-stub.mjs') }));
    b.onResolve({ filter: /wingpresence\.js$/ }, () => ({ path: here('./recovery-empty-stub.mjs') }));
    b.onResolve({ filter: /^\.\/base\.js$/ }, () => ({ path: here('./core-stub.mjs') }));
  },
});

const R = await import('../client/lib/remotes.js');

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  else { fail++; console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? ` — ${detail}` : ''}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PATH = 'eidoverse/assets/vrms/somebody.vrm';

// ---------------------------------------------------------------- the floor
probe.reset();
let r = await R.ensureRemote('alice', PATH);
check('a failed body load leaves a capsule on screen', !!r.avatar?.isCapsule);
check('the record records the debt it still owes (capsuleFor)', r.capsuleFor === PATH);
check('the record does NOT claim the intended body is worn',
  r.avatar?.isCapsule === true && r.capsuleFor === PATH);

// ---------------------------------------------------------------- the door back out
// The network comes back. A same-path reannounce is evidence the peer is live.
probe.failing = false;
const before = probe.attempts;
const same = await R.ensureRemote('alice', PATH);
check('a same-path reannounce returns the SAME record (no rebuild)', same === r);
// The retry is SCHEDULED here, not run: it fires after a backoff so a flapping peer cannot
// drive a load per announce. What must be true synchronously is that the record is now armed.
check('…and arms a retry rather than returning the capsule forever',
  r.retrying === true, `retrying=${r.retrying}`);
await sleep(700);   // past the first backoff step
check('the armed retry actually asked for the real body',
  probe.attempts > before, `${probe.attempts - before} attempts`);
check('the real body replaces the capsule once the network recovers',
  r.avatar && !r.avatar.isCapsule, `avatar isCapsule=${r.avatar?.isCapsule}`);
check('the debt is cleared once paid', !r.capsuleFor);

// ---------------------------------------------------------------- takeover pays the debt too
probe.reset();          // failing again
const t0 = await R.ensureRemote('bob', PATH);
check('bob falls back to the capsule', !!t0.avatar?.isCapsule && t0.capsuleFor === PATH);
probe.failing = false;
const t1 = await R.ensureRemote('bob', PATH, { authority: true });
check('an authority takeover produces a FRESH record (identity guard, #97 B2)', t1 !== t0);
check('the takeover carries the debt forward rather than making it permanent',
  t1.capsuleFor === PATH || !t1.avatar?.isCapsule);
await sleep(700);
check('the successor ends up in the real body', t1.avatar && !t1.avatar.isCapsule);

// ---------------------------------------------------------------- bounded, not a hot loop
probe.reset();          // failing, and stays failing
const c = await R.ensureRemote('carol', PATH);
check('carol falls back', !!c.avatar?.isCapsule);
const a0 = probe.attempts;
for (let i = 0; i < 8; i++) { await R.ensureRemote('carol', PATH); }
await sleep(900);
const spent = probe.attempts - a0;
check('a dead asset costs a bounded number of retries, not one per announce',
  spent > 0 && spent <= 4, `${spent} attempts for 8 announces`);
check('carol keeps the capsule while the asset stays down', !!c.avatar?.isCapsule);

// The CAP itself. Measured (probe, 09-19): against a permanently dead asset `retries` climbs
// 1→2→3 and STOPS, and no further announce arms another attempt. Asserting on elapsed attempts
// alone cannot distinguish the cap from the backoff inside any window a test should burn —
// RETRY_MAX=9999 still only manages ~3 attempts in 5 s — so the binding is on the counter
// reaching the cap and then refusing to move, which is the cap's actual observable.
for (let i = 0; i < 6; i++) { await R.ensureRemote('carol', PATH); await sleep(400); }
await sleep(1200);
const cappedAt = c.retries;
check('the retry counter climbs to the cap against a dead asset', cappedAt >= 3, `retries=${cappedAt}`);
const attemptsAtCap = probe.attempts;
for (let i = 0; i < 4; i++) { await R.ensureRemote('carol', PATH); await sleep(300); }
await sleep(800);
check('at the cap, further announces arm NOTHING (it gave up, it did not grind)',
  c.retries === cappedAt && probe.attempts === attemptsAtCap,
  `retries ${cappedAt}→${c.retries}, attempts ${attemptsAtCap}→${probe.attempts}`);
check('carol still has the capsule, and still knows what she owes',
  !!c.avatar?.isCapsule && c.capsuleFor === PATH);

// ---------------------------------------------------------------- generation safety
// A retry in flight must not land on a record that has since been replaced.
probe.reset();
const d0 = await R.ensureRemote('dave', PATH);
check('dave falls back', !!d0.avatar?.isCapsule);
probe.failing = false;
await R.ensureRemote('dave', PATH);                 // schedules a retry on d0
const d1 = await R.ensureRemote('dave', 'other/body.vrm');   // different path → rebuild, d0 superseded
check('a body switch supersedes the pending record', d1 !== d0);
const d0Body = d0.avatar;                       // the capsule the superseded record holds
await sleep(700);
check('the map still holds the successor', R.remotes.get('dave') === d1);
// The damage a missing identity guard does lands on the SUPERSEDED RECORD, not on the map: the
// stale retry resolves and writes its body into d0, leaving a live avatar nobody owns and nobody
// disposes (the ghost #95 exists to prevent). Assert where the write would land.
check('a stale retry never adopts a body into the superseded record (identity guard held)',
  d0.avatar === d0Body, 'the superseded record adopted a late body — undisposable ghost');
check('…and the successor keeps its own body',
  d1.avatar && d1.avatar !== d0.avatar);

// ---------------------------------------------------------------- superseded MID-LOAD
// The case above is caught by the guard at the top of the timer (the switch happens during the
// backoff). The guard AFTER the await is only reachable when the supersede lands while the body is
// genuinely in flight — hold the load open and switch underneath it.
probe.reset();
const e0 = await R.ensureRemote('erin', PATH);
check('erin falls back', !!e0.avatar?.isCapsule);
const e0Body = e0.avatar;
probe.failing = false;
probe.loadMs = 900;                        // the retry's load will be slow BEFORE it starts
await R.ensureRemote('erin', PATH);        // arms the retry (fires after the 400ms backoff)
await sleep(600);                          // timer fired ~400ms; the slow load is now in flight
const e1 = await R.ensureRemote('erin', 'other/body.vrm');   // supersede DURING that load
check('a mid-load switch supersedes the record', e1 !== e0);
await sleep(1600);                         // let the stale load finish and be rejected
check('a body that finishes loading for a superseded record is disposed, not adopted',
  e0.avatar === e0Body, 'the superseded record adopted a mid-flight body');
check('the successor is unharmed by the stale completion',
  R.remotes.get('erin') === e1);
probe.loadMs = 0;

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
