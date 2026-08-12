**Revision pushed — head `8d64d3c`. The last blocker is closed: every write runs whole under one shared inter-process lock, and your forked history is now a committed regression that the prior head fails by name.**

### The lock

One on-disk lock per store directory (`seats/.write-lock`), shared by the live server and the offline `seat-accept` tool alike — they construct the same `SeatStore`, so they cannot NOT share it. Exclusive-create (`openSync "wx"`) is the atom; the file carries `{pid, ts}`. Every mutation now runs **whole** under it: acquire → **forced reload** (never mtime trust — the lock is when the disk is the truth) → precondition re-check → provenance append → snapshot rename → in-memory swap → release in `finally`. Schema refusals stay outside the lock — garbage never contends with real writers.

Stale and dead locks are bounded and explicit: acquisition is a bounded spin (default 3 s, constructor-tunable), timing out is an **answer** — the caller refuses with nothing touched and says so; a lock older than its liveness window (10 s) belongs to a dead writer and is broken with a console line naming the corpse. The lock rides the real fs even under fault injection — injected faults are the transaction's to survive, not the lock's.

`expectedRev` now means what it claims: the comparison happens against the disk's truth **at commit time, under the lock**, so a proposal that interleaved anywhere before that moment moves the revision and the countersign refuses rather than bless the unseen.

And a history that forked anyway — a pre-lock writer, a hand edit — is caught at the door: startup scans the log for revision monotonicity, and duplicate or non-increasing revisions quarantine the store (served as `missing`, writes refused, said loudly). No fold order over a forked log is defensible, so none is attempted.

### The overlap regression, deterministic

`tools/seats-store-test.ts` gains your exact interleaving: writer B's `propose()` injected inside writer A's provenance-append, after A has built its next state. On this head:

1. **unique, monotonic revisions** — A commits rev N+1; B, overlapped, **refuses** (`another writer holds the seat-profile lock… nothing was written`); B retried after release lands at N+2; the log's revision sequence asserts strictly increasing;
2. **both writes survive, reconstructible** — a fresh load lists both records;
3. **the countersign cannot accept the unseen** — a proposal landing between `list` and `accept` moves the revision; the acceptance refuses with "re-list and re-review", and succeeds against the re-reviewed revision;
4. **lock failure changes nothing** — a held lock times the writer out with log, snapshot, and memory byte-identical; a dead holder past the liveness window is broken and the write proceeds;
5. **no duplicate-revision provenance survives startup** — a hand-forked log quarantines.

**Fail-on-prior-head** (`tools/receipts-101-phaseb/fail-on-prior-head-r3.txt`): the same committed harness against `b5957d4` reproduces your finding exactly — B's overlapped write returns `ok:true` and the log reads `[1,2,3,4,5,6,6,7]`: rev 6 twice, four named failures.

### Receipts, exact head `8d64d3c`

Everything else unchanged, as asked. Suites: seats-store **37** (the five vectors + everything prior) · seatcore 71 · seat-lifecycle **37/37** (owned door) · effective 42 · smoke 85/85. The store's write path is the only code touched; the browser bundle and consumers are byte-identical to the head you reviewed.

— I.M. & Cormundus
