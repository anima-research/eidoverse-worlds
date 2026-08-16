**Revision pushed — head `d71546a` (the fix lands at `527256f`). Ownership is a nonce, liveness is a verified pid, age proves nothing, and even a pathological steal now aborts a transaction instead of forking history.**

### Ownership and liveness, made real

- **The lock record is `{pid, nonce, ts}` and the holder retains its nonce** — ownership is the nonce, never the path. `ts` is informational only; nothing anywhere breaks a lock because it is old.
- **Liveness is pid-verified**: `process.kill(pid, 0)` on this single-host design — `ESRCH` means the holder no longer exists; anything else (alive, or `EPERM`) means a holder we **wait for, however old its stamp**. If liveness is unknowable, we time out rather than violate exclusion. Pid reuse cannot resurrect a broken claim: a reused pid is a *live* process, so the lock is simply waited on — and the nonce keeps release from ever touching a lock it didn't mint.
- **Breaking a dead lock is a rename-steal, not an unlink**: rename is the atomic claim (two breakers cannot both win), and the tomb's nonce is verified against the record that was judged dead — if the rename caught a newer live lock instead, it is restored untouched and the breaker retries.
- **Release only releases its own**: the on-disk nonce must match the one we minted, or release is a logged no-op. Your second finding — the first writer unlinking a successor's lock — is structurally impossible now.
- **Commit gates as the last line**: `ownsLock()` is re-read immediately before the provenance append *and* before the snapshot rename. If any pathological path ever takes the lock from a live writer anyway, the transaction **aborts** — pre-append with nothing written; post-append with the snapshot withheld, the log line standing as a receipt for recovery to fold (or, if a successor also wrote, for the monotonicity quarantine to catch). An exclusion breach degrades to a refused write, never to two rev-N records.

### The regressions (all committed in `tools/seats-store-test.ts`, 44 checks)

- **Live-but-old holder** — the lock names this test process's own pid (alive by construction) with a stamp from an hour ago: the second writer **times out with log, snapshot, and memory byte-identical, and the holder's lock file untouched**. On the prior head this exact vector steals the lock and writes (`ok:true` — your finding, reproduced by the committed harness).
- **Dead holder, fresh stamp** — pid 999999999 stamped *now*: broken immediately, because death is verified and age is irrelevant in both directions.
- **Release-safety + gate** — the lock is swapped to a successor's mid-transaction (inside the provenance append): the writer aborts at the second gate, its snapshot and memory stay unchanged, its release leaves the successor's lock in place, and the receipted orphan line folds forward on the next load. On the prior head, the control run **crashes at this probe** — the old unconditional release had *deleted* the successor's lock, so there was nothing left to read. The crash is the finding (`fail-on-prior-head-r4.txt`).
- All prior vectors retained: ordinary overlap refusal + retry, monotonic revisions, countersign CAS, lock-timeout no-op, duplicate-revision quarantine, fault injection, recovery.

### Receipts, exact head `d71546a`

Only `server/seats.ts` and its test moved. Suites: seats-store **44** · seatcore 71 · seat-lifecycle **37/37** (owned door) · effective 42 · smoke 85/85. Fail-on-prior-head: `tools/receipts-101-phaseb/fail-on-prior-head-r4.txt` — the live-holder steal reproduced by name, and the control aborting where the prior head deleted a lock it never owned.

— I.M. & Cormundus
