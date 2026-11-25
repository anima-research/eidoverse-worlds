# Seat-profile store: write authority and integrity

The design behind `server/seats.ts` (the server side of seat profiles; see also docs/reference/SEATS.md).

## Write authority

- HTTP proposals require a NAMED actor: a tokens.json bearer or a home-node-verified aid1 identity (the same two legs
  /upload trusts). The anonymous door token may not write here: a seat profile moves every wearer of an avatar, and
  `?by=` is self-asserted.
- The countersign that makes a profile load-bearing has NO HTTP path. `tools/operator/seat-accept.ts` is run by the operator on
  the box, edits the store through `SeatStore`'s own functions, and the running server notices via an mtime watch
  (reload, diff, push `avatar-profile-updated`). Bearer tokens are never logged or echoed.
- The countersign requires the revision the operator REVIEWED (`expectedRev`). Under the lock, an interleaved proposal
  moves the revision and the acceptance refuses rather than bless a record nobody looked at.

## Integrity boundaries

- The two map layers are NULL-PROTOTYPE, and the keys are schema-refused reserved names besides: `__proto__` cannot
  reach an inherited slot even if a future validator regresses. (`obj[k] ??=` on a plain object reads inherited slots
  before assigning.)
- Proposals name a ROSTER avatar: the bytes must exist to judge against. The operator-import lane may carry an
  unrostered name explicitly, and the flag is recorded as provenance.
- Every write is PROVENANCE-FIRST: the log line is appended before the snapshot renames, the in-memory store swaps only
  after both, and no caller reports success (or broadcasts) before the swap. A crash between log and snapshot leaves the
  log AHEAD, and startup folds it forward. A snapshot ahead of its log is a state with no receipt: quarantined, served as
  missing, said loudly. Provenance is always a superset of applied state.
- Two records at one revision in the log mean a forked history (a pre-lock writer or a hand edit). No fold order is
  defensible, so the store is quarantined until the operator reconciles.

## The write lock

The store has two real writers (the live server and the offline operator tool), and a check-then-act freshen is
interleavable. So every mutation runs whole under one shared on-disk lock: acquire, forced reload (never mtime trust),
precondition re-check, provenance append, snapshot rename, in-memory swap, release in `finally`.

- **The atom** is exclusive create: `openSync(…, "wx")` mints the lock file or throws EEXIST, on Windows and POSIX
  alike. The file carries `{pid, nonce, ts}`; ownership is the nonce, never the path.
- **Liveness is PID-verified, never inferred from age.** A live writer delayed past an age threshold would have its lock
  stolen and history forked. `process.kill(pid, 0)` answers on this single-host design: ESRCH means the lock is
  orphaned; anything else (alive, or EPERM) is a holder to WAIT for, however old its stamp. When liveness is unknown the
  acquirer times out rather than violate exclusion. PID reuse cannot resurrect a broken claim: a reused pid is a live
  process, so the lock is simply waited on, and the nonce keeps a release from touching a lock it did not mint.
- **Breaking a dead lock is a rename-steal, not an unlink.** Rename is the atomic claim, so two breakers cannot both
  succeed; the tomb's nonce is checked against the record judged dead, and if the rename caught a newer (live) lock it is
  put back and the breaker retries. The put-back is not atomic: on POSIX it can replace a lock another writer minted in
  the gap (server/seats.ts acquireLock), so exclusion rests on the commit gates below, not on the break alone.
- **Acquisition is a bounded spin** while the holder is live: timing out is an answer (the caller refuses with no state
  touched), not a hang. The dead-holder branch retries without reading the deadline, so a dead lock that can't be
  renamed spins forever (server/seats.ts acquireLock).
- **The lock rides the real fs** even under fault injection: injected faults are the transaction's to survive, not the
  lock's.
- **Commit gates.** Immediately before each irreversible step (the log append, the snapshot rename) the writer checks the
  on-disk lock is still the one it minted. A liveness-verified lock cannot be stolen from a live holder, but if any path
  ever takes it anyway the transaction aborts. The check and the step are separate calls, so this narrows a breach to
  that gap rather than closing it. Lost
  after the append, the receipt stands and the snapshot is withheld; recovery folds it forward, or quarantines if a
  successor also appended.
