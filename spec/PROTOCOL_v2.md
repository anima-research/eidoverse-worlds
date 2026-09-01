# The eidoverse world-log protocol, v2 — the deterministic-sim amendment

**License: CC0 1.0 (public domain)** — same grant as PROTOCOL.md; the
contract is free.

Status: **DRAFT, with a reference implementation** (ruling accepted
2026-08-25; `eidosim@0.1.0` landed 2026-08-26 — `shared/sim.js`, scope:
the `punt` intent, ballistic flight with bounces on the body's own ground
plane, authored-word-wins release, epoch adoption via snapshot cuts.
Covenant I proven cross-engine: one flight computed by JavaScriptCore
twice-independently and V8 once, bit-identical — see tools/sim-smoke.ts.
Terrain-aware collision, `force`, and the ⚑s of §6 remain open).
Normative, once ratified, for logs whose `genesis` (or `epoch`, §3) says
`dialect: "eidoverse-log", v: 3`. Everything in PROTOCOL.md (v1, dialects
1–2) stands unless amended here. MUST/SHOULD/MAY are RFC-2119.

## 0. The extended idea

v1's one idea: **a world is its log** — fold it from the beginning and you
have the world, on any implementation, at any time, forever. v1 delivered
that for everything except motion's *outcomes*: physical causes (`punt`,
`force`) folded to nothing, volunteer clients simulated the flight on the
presence plane, and the *result* landed back in the log as a `place`.

This amendment finishes the thought: **the log stores intents, and a
deterministic simulation recomputes their outcomes.** The fold's covenant
now covers motion. A dialect-3 log plus this spec's sim yields the world —
including where the crate came to rest — bit-for-bit, on any conforming
implementation, at any time, forever. Logs get smaller and more meaningful
(a history of intentions, not coordinates), forks stay perfect, and an
agent reading history reads *why*, not *where*.

Determinism is a covenant with teeth. The four covenants below are the
price, agreed in full before any sim code exists.

## 1. Two folds, one truth

- **The instant fold** (v1 §3): pure per-entry state transitions —
  unchanged, forever. Every v1 verb keeps its exact v1 semantics in every
  dialect. Replaying yesterday's logs is not renegotiated by this document.
- **The sim fold** (new): a fixed-tick, deterministic reduction over the
  *sim-scoped* entries of a dialect-3 epoch. It owns what v1 delegated to
  volunteer clients: ballistic flights, impulses, settling, and whatever
  physical vocabulary §5 grows.

World state is the instant fold's state with the sim fold's state composed
over it at the requested tick. Conformance (§6) measures both.

## 2. Covenant I — owned numerics

The sim fold MUST be bit-reproducible across implementations, platforms,
and decades. Therefore, inside the sim fold:

- Only IEEE 754 binary64 operations with bit-exact semantics are allowed
  from the host: `+ − × ÷`, `sqrt`, comparisons, and integer/bit ops.
- **Host transcendentals are forbidden** (`sin`, `cos`, `exp`, `pow`, …):
  their results vary by engine and version. A sim needing them MUST use an
  implementation it owns (shipped polynomial/lookup approximations pinned
  by the epoch, §3) or run its numeric kernel as a pinned **wasm** module,
  whose arithmetic the wasm spec makes bit-exact by construction.
- No wall clock, no randomness, no iteration over unordered collections
  without a defined order. (The v1 fold already lives by this — shared/'s
  house rules become normative here.)

The reference implementation SHOULD keep the sim kernel wasm-compiled so
"same epoch, same bits" is a build artifact rather than a discipline.

*Delivered (2026-08-31):* **eidosim@0.2.0 — terrain-aware ground** (the
epoch bump 0.1.0's own header scheduled). `shared/terrainmath.js` is the
toolkit terrain height law re-expressed in the blessed exact-op set (two
substitutions: `pow(0.5, n)` → accumulated halving; `hypot` → `sqrt` —
hypot is implementation-approximated and historically differs across
engines). ≥99.8% bit-identical to the mesh clients walk, worst divergence
~1e-15. The sim folds `terrain` entries: a 0.2 epoch adopts the world's
standing terrain; a terrain entry under a live epoch re-grounds the world
and releases every body to the instant fold. Grounded sliders are glued to
the terrain; flights meeting rising ground splat to contact; terrainless
worlds keep the flat-floor fallback. **eidosim@0.1.0 remains CARRIED**: old
epochs replay under the exact law they were written under (replaybench
digests unchanged across the bump), while new epochs mint 0.2.0 — the
epoch-release places make the live upgrade clean.

*Delivered (2026-08-30):* `shared/simmath.js` (`simmath@0.1.0`) is the
owned-numerics kernel — `sinT/cosT/atan2T/expT` built exclusively from the
blessed exact-op set (Cody–Waite two-word reduction, fixed-order
polynomials, explicit-endian bit assembly), in the house's no-build plain
JS. Its coefficients are its version under Covenant II. Proven bit-identical
across JavaScriptCore, node-V8 and deno-V8 on a 48,000-point sweep with a
committed golden digest (tools/simmath-test.ts); accuracy ≤2 ulp on
sin/cos/exp over the working domain. The wasm form remains the named
fallback if any host engine is ever caught breaking IEEE exactness. No
shipped sim uses it yet — eidosim@0.1.0's vocabulary needs none of it; it
exists so the vocabulary MAY grow (§6) without reopening this covenant.

## 3. Covenant II — sim epochs and snapshot barriers

The instant fold is small enough to freeze in a spec. A physics sim is
not: any behavioral change silently rewrites what old intents *mean*. So
sim behavior is **versioned in the log itself**:

- A dialect-3 log's `genesis` — or, in an existing world, an `epoch` entry
  (actor `world`) — declares `{sim: "<name>@<semver>", tickMs: <int>}`.
  Everything sim-scoped after it is interpreted under exactly that sim.
- **Upgrading the sim folds a snapshot barrier**: the sequencer folds the
  world's derived state, then appends a new `epoch`. History before the
  barrier is thereafter replayed *from the barrier snapshot* — the derived
  cache honored as truth-at-barrier — and recomputed only by an
  implementation carrying the retired sim version, if anyone still does.
- The promise this trades to keep the deeper one: not "one sim replays all
  of history forever," but **"every log is always replayable."** A
  conforming implementation MUST refuse to recompute an epoch whose sim it
  does not carry, and MUST use the barrier snapshot instead — a wrong
  answer is worse than a cached one.

## 4. Covenant III — the planes stand

v1 §5 is not weakened; it is what makes this amendment affordable:

- The presence plane still **never folds** and is never a sim input.
  Logging poses at frame rate remains non-conforming — bloat is precisely
  what intents exist to avoid.
- Embodied bodies affect the sim **only by crossing the plane as committed
  intents**: a punt with a vector, a force, a throw with a release
  velocity. The crossing entry carries everything the sim needs — the sim
  MUST NOT depend on any presence-plane fact that is not stamped into an
  entry (the plane-transition invariant, extended forward).
- Animation leases survive as presence-plane choreography. Under dialect 3
  a lease settlement MAY commit as a v1 `place` (result-shaped, exact —
  correct for a hand-carried object) or the interaction MAY be authored as
  a sim intent (a `punt` whose flight the sim owns). Which objects are
  sim-owned vs lease-animated is world/def policy, not protocol.

## 5. Covenant IV — tick-indexed time

- The epoch declares `tickMs`. Sim time is a dense tick counter from the
  epoch entry; wall clock never enters the sim fold.
- An intent takes effect at the **first tick boundary at or after its
  entry's `ts`**, by fixed quantization: `tick = ceil((ts − epoch.ts) /
  tickMs)`. Two implementations replaying the same entries MUST agree on
  every intent's tick with no reference to their own clocks.
- Between-entry ticks are pure sim advancement. Querying state "now" means
  folding to the tick that `now` quantizes to — clients interpolate
  presentation between ticks exactly as they interpolate presence.

## 6. Intent vocabulary (sketch — the open section)

Dialect 3 re-scopes the existing physical causes and reserves room to
grow. ⚑ marks what ratification must settle:

| verb | dialect ≤2 (unchanged there) | dialect 3 |
|---|---|---|
| `punt` | folds nothing; volunteer flight; landing is a `place` | **sim-scoped**: the sim owns the flight; no result entry — the resting pose is recomputed |
| `force` | folds nothing; live clients apply to consenting bodies | **sim-scoped** for sim-owned entities; bodies keep consent semantics (presence) |
| ⚑ `impulse`? `throw`? `grab`/`release`? | — | candidate new intents; each must carry its full physical argument (vector, magnitude, point of application) per Covenant III |

⚑ Also open for ratification: which entity classes are sim-owned by
default; collision vocabulary between sim entities and terrain; whether
`motion` (closed-form, v1) merges into the sim or remains a parallel
authored lane (draft position: **remains** — a pendulum as a function of
time is already deterministic and cheaper than integration).

## 7. Additivity and migration

- v1/v2-dialect logs remain valid and meaningful forever, unchanged.
- Mixed logs are legal: a v2-dialect world enters dialect 3 by its first
  `epoch` entry; everything before folds exactly as it always did.
- No existing verb changes meaning outside a dialect-3 epoch. `place`
  stays result-shaped and legal even inside one (a build tool stamping a
  crate is authorship, not physics).

## 8. Conformance

Everything v1 §11 requires, plus, per dialect-3 fixture epoch:

- **Self-agreement**: fold the fixture log twice from empty, independently
  parsed; canonical digests MUST be identical (no impurity).
- **Cross-agreement**: an implementation's tick-state digests at the
  fixture's named ticks MUST equal the fixture's — bit-for-bit, per §2.
- **Barrier honesty**: given a fixture with a mid-log `epoch` and barrier
  snapshot, an implementation lacking the pre-barrier sim MUST reproduce
  post-barrier digests from the snapshot and MUST NOT invent pre-barrier
  recomputation.

The reference gate is `tools/replaybench.ts`, which already enforces
self-agreement and snapshot parity for the instant fold; dialect-3
fixtures extend it with tick digests.
