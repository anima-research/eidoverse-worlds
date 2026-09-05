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

*Delivered (2026-09-04):* **eidosim@0.4.0 — swept collisions.** 0.3 tested
collisions at each tick's endpoint only, so within the legal parameter domain
(`tickMs` up to 1000, launch power up to 20 m/s) a fast body crossed a thin
wall between two endpoints and never met it (PR #160 review, B4). 0.4 sweeps
the body's box along the tick's displacement against every static — a slab
test in exact ops — and resolves the earliest contact at the contact point: a
top met from above is a landing under the same contact law, a side is a wall
bounce; the remainder of that tick's motion is spent there. Already-
overlapping states keep 0.3's endpoint resolution. Same constants, same
order; **0.1.0, 0.2.0 and 0.3.0 remain CARRIED** — `spec/fixtures/worlds/`
holds one authored story replayed under 0.3.0 (tunnelling and all: that is
its law, pinned) and under 0.4.0, with committed baseline digests over the
complete normative sim state in its normative order.

*Delivered (2026-09-01):* **eidosim@0.3.0 — the world's things are
colliders.** Ruling (tel0s): an asset's geometry enters the sim the only way
Covenant III allows — *stamped into history by the sequencer*. Under a live
epoch every `spawn` of a model carries `box: [[min],[max]]` (the model's
local bounding box, millimetre-rounded; a client-authored box is discarded),
and an `epoch` entry carries `boxes: {lib → box}` for every model standing in
the world at the barrier. The sim folds those into a table of static
colliders — each fold entity's yaw-rotated, scaled box as a world AABB, yaw
through simmath's owned sin/cos (its first shipped use) — and a punted body
carries its own. Per tick: a static whose top the body was above and whose
footprint it overlaps is ground (land on a crate, slide, rest on it, under
the same contact law as terrain); one met from the side pushes the body out
along the shallower horizontal axis and reflects that velocity (a wall
bounce); a grounded slider that loses its support by more than a step falls
rather than gluing; a body at rest is a static again. Collider changes
(`place`, `remove`, mount/dismount, motion) take effect at their entry's tick,
so a live fold and a replay agree bit for bit (tools/sim-test.ts proves it,
along with the pinned 0.2.0 replay flying *through* the same wall). Scope
stated: flying bodies do not collide with each other; a resting body is not
woken by a hit; things that mount, ride a motion, or have no box are not
colliders; structures (def-built) are not yet stamped. **0.1.0 and 0.2.0
remain CARRIED**; commons's 0.2.0 replay digest is byte-identical across the
bump.

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
- **Leaving an epoch** (ruling 2026-09-01): an `epoch` entry whose `sim` is
  literally `null` ends the sim epoch. It is explicit, never a toggle — a
  world-changing act must not depend on hidden state. The sequencer MUST
  release every live body into the instant fold first (result-shaped
  `place` entries, `via: "epoch-release"`) and fold the barrier around the
  exit; from the exit on, sim-scoped verbs keep their pre-dialect-3
  semantics. Leaving with no epoch to leave is refused before it is logged;
  a MISSING or malformed `sim` is not an exit and shapes nothing. Entering
  the same sim at the same tick twice is likewise refused (idempotence);
  a different sim or tick is a real re-epoch with the same release.

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

*Delivered (2026-09-01):* the reference client interpolates. Because the
quantization rounds up, the sim's current state is the end of the interval
`now` falls in and the previous tick's state is its start; the applier
shows their lerp at `now`'s fractional phase — exact sim time, no added
latency, no extrapolation. Presentation only: no sim number is read back
from the display (client/lib/simworld.js; tools/sim-smoke.ts holds the
every-frame-moves check).

## 6. Intent vocabulary (sketch — the open section)

Dialect 3 re-scopes the existing physical causes and reserves room to
grow. ⚑ marks what ratification must settle:

| verb | dialect ≤2 (unchanged there) | dialect 3 |
|---|---|---|
| `punt` | folds nothing; volunteer flight; landing is a `place` | **sim-scoped**: the sim owns the flight; no result entry — the resting pose is recomputed |
| `force` | folds nothing; live clients apply to consenting bodies | **sim-scoped** for sim-owned entities; bodies keep consent semantics (presence). *Deferred (2026-09-01) pending the "sim-owned by default" ⚑ below: a radial force claims every model in its radius, which is a ruling, not an implementation's call. Under 0.1–0.4 epochs `force` stays presence-only.* |
| ⚑ `impulse`? `throw`? `grab`/`release`? | — | candidate new intents; each must carry its full physical argument (vector, magnitude, point of application) per Covenant III |

| `spawn` / `epoch` | unchanged | **sequencer-stamped geometry**: `spawn.box`, `epoch.boxes` — the only door through which an asset's shape reaches the sim (Covenant III; eidosim@0.3.0) |

⚑ Also open for ratification: which entity classes are sim-owned by
default; collision vocabulary between sim bodies themselves (0.3 collides
bodies with standing things and terrain only), and for def-built
structures; whether
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

## 9. Other sims — moddable physics (sketch, 2026-09-01)

Asked by a colleague: *can physics mods run server-side?* In this
architecture the honest answer is **yes, and more than server-side** — the
epoch mechanism is already the socket. There is no "server physics" as
such: the sequencer folds a deterministic sim over the log, and so does
every client that carries it, and so does any replay. A **physics mod is a
sim** — a named, versioned implementation a world selects by name in its
`epoch` entry (`{sim: "<name>@<semver>", tickMs}`). eidosim@0.3.0 is simply
the reference one. What a mod must be is exactly what §2–§5 say: owned
numerics (exact ops; `shared/simmath.js` for anything transcendental), no
clock, no randomness, ordered iteration; its constants are its version; it
reads only what is stamped in entries; it advances at the epoch's tick.

What exists today and what is missing, in the reference implementation:

- **Carried set → registry.** `shared/sim.js` hard-wires `SIM_ID` and a
  `CARRIED` set, and the sequencer's `epoch` validator accepts `SIM_ID`
  exactly. The mod socket is a registry — `shared/sims.js`, `{ "<name@ver>":
  { emptySim, simEntry, advanceSim, tickOf, simSnapshot } }` — with the epoch
  validator accepting any *registered* name, and eidosim's three laws as its
  first entries. Small.
- **Where mods come from.** Operator-installed modules first (a `sims/`
  directory the sequencer loads, trusted like defs — hot-reloadable, server-
  owned). Sandboxed *uploaded* sims (the `behavior` verb's sandbox is the
  precedent) would need a Covenant-I lint on the source before registration
  — forbid `Math.sin/cos/exp/pow/random`, `Date`, unordered iteration — and
  a cost ceiling per tick. Later, if wanted.
- **Clients that do not carry the mod.** Today a foreign epoch is honored by
  refusal: bodies are not shown (the entity stays at the fold's word). For a
  mod that lives only on the sequencer, the sequencer MUST **stream** its sim
  state to such clients — a presence-shaped `sim-pose` message at tick
  cadence, never folded, consumed by the applier in place of recomputation.
  The log stays bit-replayable by anyone who carries the mod; the barrier
  snapshot stays truth for anyone who does not. This is the one piece of
  real work.
- **Conformance for mods.** `tools/sim-test.ts` is already the shape:
  self-agreement, schedule independence, totality, snapshot round-trip,
  cross-engine digest. Generalize it to `tools/sim-conformance.ts <module>`
  and require a pass before a name may be registered.
- **New intents.** A mod that wants `throw`/`grab` (§6) also needs the
  sequencer's door: a validator in the verb table and a rank in
  `VERB_NEEDS`. The registry entry should therefore carry `intents:
  { verb: validate }` alongside its fold. This is where §6's ⚑s get
  settled per mod rather than once for all.

⚑ Open: whether two mods may be composed in one epoch (draft position:
**no** — one law per epoch, compose by writing a sim that imports both);
and whether a mod may declare which entity classes it owns by default
(draft position: yes, in its registry entry — that is the §6 "sim-owned"
flag, answered per sim).
