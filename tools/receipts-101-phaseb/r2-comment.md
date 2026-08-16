**Revision pushed — head `b5957d4`. All three boundaries folded, the door is owned, and the reviewed head fails every new check by name.**

### B1 — one cache, whole-request epochs, pending on arrival

The guard and cache logic existed twice — one copy per consumer — and each copy had the holes you named. It now exists once: `seatcore.makeVerdictCache`, consumed by both `client/lib/seats.js` and `WorldAgent` (the browser supplies a `/avatars` fetch, the agent its `httpBase` fetch — nothing else differs). The guard is epoch-based: every bump advances a global epoch recorded against the name, a request stamps the epoch it **departed** under, and a resolution is refused for any name bumped after departure — cached or never-seen (your empty-cache race, closed at the root). `note()` additionally demotes the held verdict to `pending` **before** its refetch departs — the gate declares `profile update pending` and the old value stops moving bodies the moment the event lands, refetch or no refetch. Event revs are floors: a response older than an announced revision is pre-event by definition and refused whole; a response that cannot state its revision is refused once any rev has been announced.

Your four vectors are pinned in `tools/seatcore-test.ts` with an injectable transport (the races are deterministic there — time and resolution order are the test's to control), and the live chain runs against the real door in the lifecycle matrix: **seatprobe** — a disposable avatar the test uploads, profiles, countersigns, and seats a real `WorldAgent` on (`0.79m`, corrected) — has its bytes re-uploaded mid-sit, and the agent's own `look()` moves through `pending`/`stale (avatar bytes changed)` without ever re-serving the old value; `/avatars` serves `stale` naming which bytes.

### B2 — the write door refuses what it cannot safely hold

`validateProfile` now requires roster-name syntax (`[a-zA-Z0-9_-]{1,48}`), refuses the language's reserved names (`__proto__`/`constructor`/`prototype`) explicitly, and pins `pose === "sitchair"` — the slice's whole scope. The store's maps are **null-prototype at every layer** (including on load from parsed JSON, where `obj[k] ??=` reads inherited slots — the pollution door), and proposals must name a **rostered** avatar (there must be bytes to judge against); the operator-import lane may carry an unrostered name only via an explicit flag that lands in provenance. Real-door vectors in the lifecycle matrix: `__proto__`, `constructor`, `prototype`, unknown avatar, wrong pose — all 4xx, rev unmoved, no events, `Object.prototype` asserted clean. On the reviewed head the same vectors return **`ok:true` at revs 1–4 and the pollution assertion fails** — the vulnerability was live (`fail-on-reviewed-head-r2.txt`).

### B3 — provenance ⊇ applied state, always

`persist` is provenance-first: the next state is built without touching the live one, the log line appends, the snapshot renames, and only then does memory swap. An append failure changes nothing anywhere. A snapshot failure leaves the log AHEAD and reports failure — and startup folds receipted writes forward, rewriting the snapshot to match its receipts: durable-with-receipt or not at all. A snapshot **ahead** of its log is a state with no receipt: quarantined, served as `missing`, refused for writes (503), said loudly. Countersign now requires `--expect-rev` — the revision the operator `list`ed and reviewed — and both processes reload from disk before every mutation, so a second writer's stale snapshot cannot clobber: the cross-process vector (A proposes, B countersigns from its old view) refuses with "re-list and re-review". Fault injection in `tools/seats-store-test.ts` (26 checks) via an injectable fs surface: append-fail, rename-fail + recovery, quarantine, stale-revision countersign, two-writer CAS.

### Harness — the door is ours or the test is over

The port is OS-assigned (bind-0 preflight), asserted silent before the child spawns, the child's stdout/stderr are preserved and printed on any fatal, and before a single check counts, the responding server must have **written this run's scratch `WORLDS_DIR`** — a listener that answers without leaving tracks in our tmpdir is somebody else's door and the test dies rather than inspect it. The committed file passes as committed: **37/37**.

### Receipts, exact head `b5957d4`

Suites: seatcore **71** · seats-store **26** · seat-lifecycle **37/37** (owned door) · effective 42 · motioneval 33 · supportclass 29 · uneven-support 15 · denoise 31 · remotes-lifecycle 30 · smoke 85/85 · comptest 33/0 · worldops 23/0 · browser bundle green (127 modules). permtest 21/2 and voice-lifecycle 122/2 pre-existing on main, as before.

Fail-on-reviewed-head (`tools/receipts-101-phaseb/fail-on-reviewed-head-r2.txt`): seats-store **21 named failures** (`__proto__` accepted at rev 1, pollution assertion fails, unreviewed countersign accepted); lifecycle **12 named failures** (dangerous keys 200, rev moves on refused writes, no-CAS countersign); seatcore-test fails at import — the shared cache did not exist on that head, which is the point: the duplicated copies it replaces were where your races lived.

— I.M. & Cormundus
