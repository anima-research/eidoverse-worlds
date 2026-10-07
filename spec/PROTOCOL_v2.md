# Physics in the eidoverse world protocol — the deterministic-sim amendment

**License: CC0 1.0 (public domain)** — same grant as PROTOCOL.md; the
contract is free.

*This file keeps its old name because code cites it ("PROTOCOL_v2 Covenant
I") for the owned-numerics rules. It began as the deterministic-sim
amendment to the first protocol and is now the physics part of protocol v4
(PROTOCOL.md); the covenants carried over unchanged, and how physics meets
the log was redone for v4: launches are `sim` entries, and the log records
where things come to rest.*

Status: normative for v4 worlds whose `@world.sim` names an engine, with a
reference implementation: `shared/sim.js` (eidosim), `shared/simmath.js`,
`shared/terrainmath.js`, and the sim layer `shared/v4/simlayer.js`. MUST /
SHOULD / MAY are RFC-2119.

## 0. The idea

A world is its log, and the log records **results, never processes**. For
motion that would mean logging every frame — so a world that wants things
to fly runs a **deterministic engine** instead: the log records the
*intent* that starts a motion (a throw, a punt) and, when the motion ends,
the *result* (where the thing came to rest, caused by that intent). Every
reader that carries the engine replays the flight bit for bit and checks
that it lands where the log says; every reader that doesn't still folds the
world exactly, because the rest is an ordinary change entry. Nothing about
the world depends on carrying the engine; only watching the flight does.

## 1. Two folds, one truth

- **The fold** (PROTOCOL.md §3): pure, per-entry state transitions. It
  never reads `sim` entries and never runs an engine.
- **The sim layer**: a fixed-tick, deterministic reduction over the log's
  change entries and its `sim` entries (launches, lifts, catches), run by
  the engine `@world.sim` names. It owns what is in the air between a launch
  and its rest. It never writes the log; the door does, from its own copy.

A change entry whose `cause` is a launch IS that body's rest, and its value
MUST equal where the engine has the body. A carrier checks this; a
disagreement is evidence against the door, not a second truth.

## 2. Covenant I — owned numerics

The engine MUST be bit-reproducible across implementations, platforms and
decades. Therefore, inside the sim:

- Only IEEE 754 binary64 operations with bit-exact semantics are allowed
  from the host: `+ − × ÷`, `sqrt`, comparisons, and integer/bit ops.
- **Host transcendentals are forbidden** (`sin`, `cos`, `exp`, `pow`, …):
  their results vary by engine and version. A sim needing them MUST use an
  implementation it owns (shipped polynomial/lookup approximations pinned
  by the engine's version, §3) or run its numeric kernel as a pinned
  **wasm** module, whose arithmetic the wasm spec makes bit-exact by
  construction.
- No wall clock, no randomness, no iteration over unordered collections
  without a defined order.

`shared/simmath.js` (`simmath@0.1.0`) is the owned kernel —
`sinT/cosT/atan2T/expT` built only from the exact-op set (Cody–Waite
two-word reduction, fixed-order polynomials, explicit-endian bit assembly).
Its coefficients are its version. It is proven bit-identical across
JavaScriptCore, node-V8 and deno-V8 on a 48,000-point sweep with a committed
golden digest (tools/simmath-test.ts); accuracy ≤ 2 ulp on sin/cos/exp over
the working domain. `shared/terrainmath.js` is the terrain height law
re-expressed in the same exact-op set (`pow(0.5, n)` → accumulated halving;
`hypot` → `sqrt`, since hypot is implementation-approximated).

## 3. Covenant II — the engine is named and hashed

A physics change silently rewrites what old intents mean, so the engine is
versioned in the log itself:

- `@world.sim` = `{engine: "<name>@<semver>", build, tickMs?}`. The owner
  sets `engine`; the **door stamps `build`**, the hash of the exact files
  that implement it (determinism is per binary). The reference door carries
  `eidosim@0.1.0` through `0.5.0` in one build (`EIDOSIM_BUILD` in
  `shared/v4/simlayer.js`; `bun run test:v4` recomputes it from the files
  and fails if they changed without a new name).
- **Changing the engine is a cut**: the door refuses to change or delete
  `@world.sim` while anything is in flight (an owner may force it, freezing
  in-flight bodies where they are). After the cut, everything is
  interpreted under the new engine.
- **A reader that doesn't carry the named build MUST NOT recompute the
  flights.** It folds the log (the rests are there) and shows nothing in
  flight, rather than guessing. A wrong answer is worse than a missing
  animation.

The eidosim laws, each kept exactly as written:

- **0.5.0 — continuing contacts.** After each contact the remaining tick
  time is swept again, so a body touching a deck slides horizontally and
  can fall from its edge; the remaining movement still meets walls, and the
  ground support plane participates. At most eight contacts per body per
  tick; exhausting that budget leaves the body at its last safe contact.
  When the last body rests, idle ticks are skipped without changing state.
- **0.4.0 — swept collisions.** The body's box is swept along each tick's
  displacement against every static (a slab test in exact ops) and the
  earliest contact resolved, so a fast body can't cross a thin wall
  between two tick endpoints.
- **0.3.0 — the world's things are colliders.** Each thing's shape enters
  the sim only as stamped by the door into the log (`physics.shape`, its
  measured box): a static's top is ground, its side is a wall.
- **0.2.0 — terrain-aware ground** (`shared/terrainmath.js`).
- **0.1.0 — ballistic flight** with bounces on a flat ground plane.

## 4. Covenant III — the planes stand

- The presence plane still **never folds** and is never a sim input.
- Bodies and hands affect the sim **only by crossing the plane as checked
  acts** — `throw {id, v}`, `punt {id, power | v}`, a `drop` with physics —
  and the `sim` entry they produce carries everything the engine needs. The
  engine MUST NOT depend on any presence fact that is not stamped into an
  entry. Continuous contact gives no unlogged impulse.
- **A launched thing belongs to the engine until it rests.** No state write
  may touch it in flight except its rest (caused by its launch) or a catch
  (itself a `sim` entry).
- Carrying is presence: a held thing moves with its holder's body and is
  settled into the log by `put`, `drop` or `throw` (AGENTS.md).

## 5. Covenant IV — tick-indexed time

- Sim time is a dense tick counter of `tickMs` steps. The only clock is the
  entries' `ts` (the door's admission time); wall clock never enters the
  sim.
- An intent takes effect at the **first tick boundary at or after its
  entry's `ts`**, by fixed quantization. Two implementations replaying the
  same entries MUST agree on every intent's tick with no reference to their
  own clocks.
- Between entries, ticks are pure advancement. Clients present the engine's
  state interpolated between ticks at display time — exact sim time, no
  extrapolation, and no sim number is ever read back from the display
  (client/lib/simworld.js).

## 6. Scope and open questions

Today (eidosim, all versions): boxes, yaw only; flying bodies don't collide
with each other; a resting body is not woken by a hit, so stacks don't
topple; things don't spin. ⚑ Open: collisions between moving bodies;
rotation; whether `motion` (closed-form functions of time) ever merges into
the sim (draft position: **no** — a pendulum as a function of time is
already deterministic and cheaper than integration); shared live physics
between several hands.

## 7. Other engines — moddable physics

A physics mod is an engine: a named, versioned implementation a world
selects in `@world.sim`. What it must be is exactly what §2–§5 say — owned
numerics, no clock, no randomness, ordered iteration; its constants are its
version; it reads only what is stamped in entries; it advances by ticks. To
be carried, it registers beside eidosim in the door's engine table
(`ENGINES` in `shared/v4/simlayer.js`) with its build hash, and passes the
same conformance (§8). An engine only the server carries would need the
server to stream its state to clients as presence — never folded — while
the log stays exact for everyone.

## 8. Conformance

- **Self-agreement**: fold a log twice from empty, independently parsed;
  sim states and digests MUST be identical.
- **Rests**: every rest in a log MUST equal the carried engine's result for
  its launch (the sim layer's `checks.disagree` is empty).
- **Cross-engine**: results MUST be bit-identical across JavaScript
  engines (tools/simmath-test.ts for the kernel; the `browser` suite runs
  the shared core in headless Chromium byte for byte against bun).
- `bun tools/v4/run.ts phys physlive` runs the physics suites: launches,
  rests by cause, carriers, the running server and a client's fold.
