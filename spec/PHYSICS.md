# Physics in the eidoverse world protocol — the deterministic-sim amendment

**License: CC0 1.0 (public domain)** — same grant as PROTOCOL.md; the
contract is free.

*This began as the deterministic-sim amendment to the first protocol
(PROTOCOL_v2.md, "dialect 3"; kept verbatim as `history/PROTOCOL-v2-sim.md`,
which is what code citing "PROTOCOL_v2 Covenant I" points at) and is now the
physics part of the protocol (PROTOCOL.md); the covenants carried over
unchanged, and how physics meets the log was redone: launches are `sim`
entries, and the log records where things come to rest.*

Status: normative for worlds whose `@world.physics-engine` names an engine, with a
reference implementation: `shared/sim.js` over `shared/eidosim.js` (eidosim), `shared/simmath.js`,
`shared/terrainmath.js`, and the sim layer `shared/protocol/simlayer.js`. MUST /
SHOULD / MAY are RFC-2119. Parts marked **reserved** are names, shapes and rules
fixed now, before an implementation, because the log, the registry pin or shipped
clients would freeze whatever came first (research physics-seeds 10-07): an
authority refuses what they describe until it implements them.

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
  the engine `@world.physics-engine` names. It owns what is in the air between a launch
  and its rest. It never writes the log; the authority does, from its own copy.

A change entry whose `cause` is a launch IS the rest of the bodies that
launch set moving: the launched body and, under engines that collide moving
bodies with resting ones, any body its flight set moving through contact
(engine-defined: eidosim names the launch whose flight touched it). Each of its
`transform` values MUST equal where the engine has that body. A carrier
checks this; a disagreement is evidence against the authority, not a second
truth.

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

- `@world.physics-engine` = `{engine: "<name>@<semver>", build, tickMs?}`. The owner
  sets `engine`; the **authority stamps `build`**, the hash of the exact files
  that implement it (determinism is per binary). The reference authority carries
  `eidosim@1.0.0` (`EIDOSIM_BUILD` in `shared/protocol/simlayer.js`;
  `bun run test:protocol` recomputes it from the files and fails if they changed
  without a new build).
- **Changing the engine is a cut**: the authority refuses to change or delete
  `@world.physics-engine` while anything is in flight (an owner may force it, freezing
  in-flight bodies where they are). After the cut, everything is
  interpreted under the new engine.
- **A reader that doesn't carry the named build MUST NOT recompute the
  flights.** It folds the log (the rests are there) and shows nothing in
  flight, rather than guessing. A wrong answer is worse than a missing
  animation.

eidosim@1.0.0, the law (its constants are its version):

- **Rigid bodies** (boxes and spheres) with full rotation, mass from a fixed
  density, and gyroscopic motion, stepped at the world's `tickMs` with four
  substeps per tick.
- **Soft contacts after Box3D**: per substep, integrate velocities, warm start,
  a soft push, integrate positions, a rigid relax with friction (the pinned
  combine rule, §3.2), twist friction and rolling resistance; restitution after
  the substeps. Contact slop 5 mm; speculative distance 2 cm.
- **Swept collisions**: a moving body is swept against everything at rest
  (colliders and sleeping bodies) by conservative advancement, so a fast body
  doesn't cross a thin wall between ticks. Two moving bodies are not swept
  against each other: thrown at each other fast enough, they can pass (review
  physics.md #8; body–body time of impact is a later build).
- **A height-field ground** (`shared/terrainmath.js`).
- **Waking and knocking**: a dynamic thing at rest that no hand rule holds fixed
  (not locked, under nothing locked, holding nothing locked) is a sleeping body.
  It wakes when a moving body touches it (a contact within the speculative
  distance, as Box3D and Jolt both wake), flies under the launch whose flight
  touched it, and rests as that launch's (§1). Everything else at rest is a
  collider.
- **Rest**: a body that sleeps comes to rest and is a collider (or a sleeper)
  again. A runaway backstop rests a body after 20000 ticks. A launch's spin is
  capped so no corner moves faster than 20 m/s, as `v` is.

Its state is plain JSON and exact: advancing it to a tick in one jump, tick by
tick, or with a JSON copy between ticks gives the same bits (Covenant IV).

The first eidosim (`eidosim@0.1.0`–`0.5.0`, PROTOCOL_v2 dialect 3: ballistic
boxes, yaw only) is not carried. An old world that ran it is imported with its
rests written as plain changes (the importer runs that engine itself, once).

### 3.1. Shapes

`physics.shape` is stamped by the authority into the log, so its grammar is
fixed before any engine writes a shape that isn't a box
(`shared/protocol/shapes.js`; the authority refuses anything else):

- **A bare `[[minX, minY, minZ], [maxX, maxY, maxZ]]` is a box, forever**: the
  authority's measured box in the thing's own frame, finite, min ≤ max. Every
  shape stamped so far is one.
- **Any other shape is a tagged object** in the thing's own frame, in metres,
  placed by optional `pos` [x, y, z] and `q` (a unit quaternion):
  `{type: "box", half: [x, y, z]}`, `{type: "sphere", radius}`,
  `{type: "capsule", radius, halfHeight}` and `{type: "cylinder", radius,
  halfHeight}` (along local +Y), and `{type: "convex" | "mesh" | "compound",
  blob}`.
- **Convex, mesh and compound geometry is never inline.** `blob` is a content
  address, `sha256:<64 hex>` (what the blob store mints), which the
  **authority** bakes from the model and stamps (Covenant III: geometry enters
  the sim only through the log). A convex blob holds the hull's points, a mesh
  blob its triangles (static colliders only, for engines that say so), a
  compound blob its children `[{shape, pos?, q?}]`.
- A new type is an addition to this grammar, never a change to an old one.
  An engine that can't carry a shape treats the thing as no body (the boxes table
  carries boxes only: `simlayer.engineBox`); it never misreads one shape as
  another.
- **`collider.shape` is a request; `physics.shape` is the result.**
  `collider.shape` (`exact` | `box` | `sphere`) says how a thing's geometry is to be
  derived for walking collision and, under engines that read it, for the
  sim; `physics.shape` is what the authority measured and stamped. A future
  request vocabulary (`capsule`, `convex` …) is added to
  `collider.shape`, and its stamp is the tagged object above: one
  vocabulary for what is asked, one grammar for what is recorded.
- **`sphere`** (the first such request): the authority fits a sphere to the
  model's measured box, centred on it, radius its largest half extent, and
  stamps `{type: "sphere", radius, pos}`. eidosim flies it as a sphere (it
  rolls, with rolling resistance).

### 3.2. Physical properties

Named now, with units and what their absence means (PROTOCOL §4: a field
added later states its meaning of absence, and the pin freezes it). The names,
units and combine rules are the vocabulary the major engines **share**
(PhysX/Unity, Jolt, Rapier, Godot, Bullet, and Box2D v3 for the 2D analogues),
in SI units, not any one engine's API: eidosim stays this protocol's engine,
and whichever engine follows it (most likely a spec-defined deterministic one)
must be able to carry every field. Every one is optional and **none is a
materialized default**: no engine this server carries reads them yet, and a
constant written into every value would be wrong for most things (a pinned
`mass: 1` is wrong for every crate ever made). Absence keeps the behaviour
before the field existed: the engine's own law.

| field | unit | absent means |
|---|---|---|
| `mass` | kg, > 0 | `density` × the volume of the stamped shape (`shapes.js shapeVolume`; a blob shape's baked geometry) |
| `density` | kg/m³, > 0 | its material's surface density, else 1000 (water) |
| `material` | a `surface:<name>` on `@world` | friction, restitution and their combine modes from their own fields, else the engine's law |
| `friction` | ≥ 0, one coefficient (static = dynamic) | its material's, else the engine's law |
| `restitution` | 0..1 | its material's, else the engine's law |
| `frictionCombine`, `restitutionCombine` | `average` \| `min` \| `multiply` \| `max` | its material's, else `average` (friction) and `max` (restitution) |
| `linearDamping`, `angularDamping` | 1/s | the engine's law (eidosim: none) |
| `centerOfMass` | [x, y, z] m, own frame | the centroid of its stamped shape |
| `ccd` | bool | the engine's law (eidosim sweeps every moving body against what rests; two flying bodies don't sweep against each other) |
| `layers`, `mask` | 32-bit collision layers | layers 1; mask all (0xffffffff). Two things collide only if each one's mask holds a layer of the other |

How the names map (recalled from each engine's public API; a mapping, not an
adoption):

| here | PhysX / Unity | Jolt | Rapier | Godot |
|---|---|---|---|---|
| `mass`, `density` | `setMass` + `updateMassAndInertia(density)` / `Rigidbody.mass` | `MassProperties.mMass`; shape `mDensity` | collider `mass` / `density` | `RigidBody3D.mass` (no density) |
| `friction` | `PxMaterial` static = dynamic / `PhysicsMaterial` both | `mFriction` | `friction` | `PhysicsMaterial.friction` |
| `restitution` | `restitution` / `bounciness` | `mRestitution` | `restitution` | `bounce` |
| `*Combine` | `PxCombineMode` AVERAGE/MIN/MULTIPLY/MAX / `PhysicsMaterialCombine` | a combine callback | `CoefficientCombineRule` | `rough` / `absorbent` flags (no general modes) |
| `linearDamping`, `angularDamping` | `linearDamping`, `angularDamping` | `mLinearDamping`, `mAngularDamping` | `linearDamping`, `angularDamping` | `linear_damp`, `angular_damp` |
| `centerOfMass` | `cMassLocalPose` / `centerOfMass` | `OffsetCenterOfMassShape` | `MassProperties` local CoM | `center_of_mass` |
| `ccd` | `eENABLE_CCD` / `Continuous` | `EMotionQuality::LinearCast` | `ccdEnabled` | `continuous_cd` |
| `layers`, `mask` | `PxFilterData` words / layer matrix | object layers + filters | `InteractionGroups(memberships, filter)` | `collision_layer`, `collision_mask` |
| `kind: kinematic` | `eKINEMATIC` / `isKinematic` | `EMotionType::Kinematic` | `KinematicPositionBased` | `AnimatableBody3D` |
| `w` | angular velocity, rad/s, world | `GetAngularVelocity` | `angvel` | `angular_velocity` |

Box2D v3 (2D) has the same set: `density`, `friction`, `restitution`, linear
and angular damping, `isBullet`, `categoryBits`/`maskBits` (64-bit, a
superset of 32).

- **Surfaces.** A world names its materials as `@world surface:<name>
  {friction?, restitution?, density?, frictionCombine?, restitutionCombine?,
  label?}` (Marrow's Surface Data Cards: one name bundles a surface's
  numbers, and content names materials rather than raw per-object numbers).
  A material naming no surface reads as no material. The registry may later
  add built-in surface names; a world's own `surface:<name>` wins.
- **Combining two surfaces is the protocol's, not the engine's.** The modes
  are the four every engine can carry (PhysX's, Unity's and Rapier's enums;
  Jolt and Box2D v3 take any rule as a callback): `average`, `min`,
  `multiply`, `max`. When two touching surfaces name different modes, the
  later in that list wins (PhysX's and Unity's priority). Absent everywhere,
  friction averages (the PhysX, Unity and Rapier default) and restitution
  takes the max (the Jolt and Box2D default: a bouncy ball stays bouncy on
  any floor). Geometric mean, Jolt's and Box2D's friction default, isn't
  offered: three of the engines can't express it.
- **Angular velocity is `w`: [x, y, z] in rad/s about world axes, everywhere**
  (acts, launches, state samples). Orientation is `q`, a unit quaternion
  (PROTOCOL §9.1).
- A body's mass and strength belong to the person's body data, never to a
  thing's `physics`.
- A field is added only with an engine that reads it, or says in its help
  that none does yet.

### 3.3. Joints, kinematic things and motion

- **`physics.kind: kinematic`**: a collider moved only by authored edits and
  `motion`, never by the engine; it pushes dynamic things and is never
  pushed or launched. Under eidosim it is a collider at its transform, like
  a static.
- **A thing with `motion`** (pendulum, spin, orbit, bob, path) is a closed
  form of time, so it is a deterministic input (Covenant I). An engine that
  can carries it as a kinematic collider at its motion's pose; eidosim reads
  only the transform, so a thrown ball passes through a swinging pendulum
  today. Don't build on that pass-through.
- **`joint:<name>` is reserved**: `{to: ref, type: fixed | hinge | slider |
  ball | distance | spring, anchor, axis, limits, drive {stiffness, damping,
  maxForce}, breakForce}`. `to` is a typed reference (duplicate and publish
  rebind it). The authority refuses it until the world's engine declares
  joints (`ENGINES[…].joints`). `parent` is a rigid attachment and never a
  solver joint; `openable` is kinematic animation; a *physical* door is a
  joint.

## 4. Covenant III — the planes stand

- The presence plane still **never folds** and is never a sim input.
- **The engine/presence boundary is crossed only by log entries, in both
  directions.** Bodies and hands affect the sim only by crossing the plane as
  checked acts — `throw {id, v, w?}`, `punt {id, power | v}`, a `drop` with
  physics — and the `sim` entry they produce carries everything the engine
  needs. Taking a thing *out* of the engine is a `lift` or `catch`, whatever
  the cause: a grab today, a touch or push takeover later. Returning it is a
  `launch` (a release with its state) or a settlement (§4.4). The engine MUST
  NOT depend on any presence fact that is not stamped into an entry.
- **Continuous contact gives no unlogged impulse to the engine.** Contact
  under live simulation authority (§4.1) is presence, and enters history
  only as a settlement or a launch.
- **A launched thing belongs to the engine until it rests.** No state write
  may touch it in flight except its rest (caused by its launch) or a catch
  (itself a `sim` entry).
- Carrying is presence: a held thing moves with its holder's body and is
  settled into the log by `put`, `drop` or `throw` (AGENTS.md).

### 4.1. Three authorities (design 20, P1–P3)

Three different things, never conflated (conflating them is how SpatialOS lost
updates; VRChat splits them the same way):

- **Body authority** is the person's own: never transferred, never
  sim-owned, never shared. Contact between people is each receiver's machine
  applying another's puppet force to its own body, so consent is enforced
  where it lands. It is never logged. **Bodies are not sim inputs because
  the log is results, never processes; a body in the engine is a process.**
  A body has no `physics` component and the engine never sees it: a flight
  passes through a body. The body's client may `catch` (existing) or,
  *reserved*, `deflect {id, v, w?}` (a `sim` entry: the thing leaves the body
  with the state the client gives it, under the body's consent, like a
  launch; refused until built). A thing under live authority that meets a
  body delivers a `shove` to that body's client under its consent table
  (actor: the thing's live authority, carrying the thing's `id` and `v`);
  the thing's own motion ignores the body. Carrying a person is a consent
  class (`carry`, PROTOCOL body consent; reserved): the carried person's
  client parents their own body to the carrier's hand, and may stop at any
  moment. When avatar bodies are simulated, they are simulated the way
  Boneworks does it and Fusion networks it: a physics rig in the presence
  plane, per client, driven toward its tracked targets, with a force-driven
  puppet of every other body; never in the engine, never in the log.
- **Live simulation authority** over a thing is presence: transient, cheap,
  unlogged. *Reserved; the rules are fixed now:*
  - **The toucher or holder simulates it.** Whoever grabs a thing, or (with
    lower priority) touches it, simulates it locally, so hand and object are
    in one local sim with zero latency. Everyone else draws a proxy.
  - **Grab beats touch.** Two counters order it (Fiedler 2018): `oseq`
    increments on each grab, `aseq` on each touch takeover and each rest; an
    increase in `oseq` wins over an increase in `aseq`; the latest grab wins.
    A touch takeover by impact (a hand or a body meeting a thing, Fusion's
    `ImpactUtilities`, VRChat's collision transfer) bids `aseq` only, never
    `oseq`: a held thing is never taken by bumping into it.
  - **The holder's switch.** The latest grab wins because `grabbable.steal`
    defaults to `true`; under `steal: false` a held thing's `oseq` cannot
    advance until a `launch` or a settlement, and the second `grab` is
    refused (`held`). *Reserved:* `steal: "ask"` (the holder's client is
    asked, as a body act is) is a value the authority refuses until built.
  - **Claims are ordered by admission, never by a sender's `t`** (§5.1 says
    the same of releases): two grabs in one beat resolve in the order the
    door admitted them. *Reserved on `@world.physics-engine`, refused until
    read:* `claimDebounceMs` (default 200: an equal-priority `aseq` takeover
    within it is refused, Overte's `SimulationOwner` debounce) and
    `liveAuthorityExpiryMs` (default 5000: a live authority silent that long
    is expired, and its thing is settled from the last accepted state or
    released into the engine).
  - **Two hands on one thing is one authority** (research 10-11, C: every
    system that ships has one simulator per thing; Bonelab Fusion lets a
    second hand act only as a force inside the holder's sim). *Reserved:*
    `cohold` is a verb the authority refuses until built. Its rule is fixed:
    the second person's hand is a `reach` that tracks the grip; it acts on
    the thing only inside the holder's sim, as a puppet contact; it never
    streams the thing's state and never advances `oseq`. A release while
    co-held is the holder's `launch`; the rest is attributed to both.
  - **The door is the arbiter.** It relays every claim, orders handovers
    optimistically (a local take, corrected by the arbiter), and refuses
    stale ones. It is *not* the edit lease, which governs history.
  - **Velocity carries across a handover.** Letting go is a `launch`: the
    released thing (and anything touching it that live authority had taken)
    crosses into the engine as one committed intent and belongs to the engine
    until it rests (§4). The thrower does not keep simulating it — live
    authority ends at release, so a flight's outcome never depends on a
    presence-plane fact (Covenant III).
  - **A held object rides its holder's hand**: it travels in the holder's
    pose as which grip and where, never as a separate stream.
  - **Live authority may stream an object's state on a presence lane**
    (§4.3) while it moves; rest is never a sample.
  - Taking a resting thing into live authority is a `lift`; leaving it is a
    `launch` or a settlement (above).
- **Write authority** is the door: it alone appends to the log, and it checks
  every claim that becomes history.

### 4.2. Releases carry their state

A `throw` or `drop` MAY carry `w` (spin, rad/s, world frame) and `t` (the
moment the hand let go, on the authority's clock, §5.1). The act records the
request as sent; the launch carries `w` for engines that spin things (eidosim
does, capped as in §3), and `q` (the thing's orientation as it was
let go) for engines that rotate them; a rest under such an engine writes the
engine's `q` beside its `pos`. `t` is for validation and for smoothing the
thrower's own view of their flight, **never a backdated sim input**: a launch
takes effect at its own entry's tick (Covenant IV), because backdating turns
into rollback the moment bodies collide.

### 4.3. The state-sync lane (reserved)

A live authority streams a thing's state as presence, separately from body
frames and from the log: `state {s: [sample, …]}`, each sample

    {id, by, aseq, oseq, t, p, q, v, w, sleep}

`by` the identity simulating it; `aseq`/`oseq` the counters (§4.1); `t` the
capture time on the authority's clock; `p` (m) and `q` (unit quaternion) its
world pose; `v` (m/s) and `w` (rad/s) its world velocities; `sleep` whether
its simulator has it at rest. A sample is **absolute, self-contained and
latest-wins**: no deltas against unacknowledged state, so the lane can move
from the WebSocket to unreliable datagrams (a WebRTC DataChannel with
`ordered: false, maxRetransmits: 0`, or WebTransport datagrams) without
changing meaning. Receivers MAY drive a proxy toward the samples by force
(pushable) or kinematically; a quantization, a priority accumulator and a
per-client byte budget are added with the lane. Rest is a reliable
settlement (§4.4), never a sample. Today the server checks the shape
(`shared/presencewire.js stateSampleError`) and refuses every sample as
reserved.

### 4.4. Settlement is a checked claim (design 20, P3; reserved)

When a thing under live authority comes to rest (asleep about 0.5 s) or is put
down, its authority sends one **settlement**: a resting pose. The door treats
it as a claim, like `put`: physical checks (support, overlap) and reach
against the holder's last presence, so a cheating client can do no more than
a builder could. It is logged as a plain `transform` change, attributed to
everyone who handled the thing since it last rested. Trajectories never enter
the log. A holder who disconnects mid-motion is settled from their last
accepted state, or released into the sim.

## 5. Covenant IV — tick-indexed time

- Sim time is a dense tick counter of `tickMs` steps. The only clock is the
  entries' `ts` (the authority's admission time); wall clock never enters the
  sim.
- An intent takes effect at the **first tick boundary at or after its
  entry's `ts`**, by fixed quantization. Two implementations replaying the
  same entries MUST agree on every intent's tick with no reference to their
  own clocks.
- Between entries, ticks are pure advancement. Clients present the engine's
  state interpolated between ticks at display time — exact sim time, no
  extrapolation, and no sim number is ever read back from the display
  (client/lib/simworld.js).

### 5.1. One clock for presence and the sim

- **The authority's clock** is `max(last entry ts, wall clock)`, never
  backwards: it stamps entries' `ts`, and therefore the sim's ticks.
  Presence frames carry *it* as `t`, never raw wall time; otherwise a world
  whose log runs ahead of wall time (an imported world, a skewed host) has
  its flights drawn at the wrong tick.
- **A client measures it by round trip**: `clock {t0}` (its own clock,
  echoed) is answered `{t0, t}`; the offset is `t − (t0 + t1) / 2`, and the
  smallest recent round trip wins (queuing only adds delay). A frame's `t` is
  a one-way fallback until the first round trip
  (`client/lib/serverclock.js`).
- **Every presence sample may carry its capture time and count**: `t` on the
  authority's clock (from the sender's estimate, sent once a round trip has
  measured it) and `seq`, the sender's own count. Receivers interpolate at
  capture time when it is sane against the carrying frame (not after it,
  not older than 1 s), else at the frame's. The server's fence drops a bad
  `t` or `seq`, never the pose; neither is part of the pose remembered for
  late joiners. State samples (§4.3) and release acts (§4.2) use the same
  clock.

## 6. Scope and open questions

Today (eidosim@1.0.0): boxes and spheres, full rotation, stacks that topple,
free dynamic things knocked by what flies. ⚑ Open: joints in the log (the
engine has them; no component names them yet); capsules, convex and compound
shapes; flying bodies colliding with each other mid-flight under two
different launches is engine-defined attribution (the touching launch);
shared live physics between several hands is solved one way everywhere that
ships (research 10-11, C): one simulator per thing, a holder-side theft
switch, claims ordered by the arbiter; the second hand, where it exists at
all (Bonelab Fusion, MIT, `LabFusion/src/Entities`), is a force inside the
holder's sim. §4.1 fixes the same here (`steal`, admission order, `cohold`
reserved) and Overte's `SimulationOwner.h` supplies the two numbers. `motion` is never integrated by the sim: it is a closed form of
time, which an engine that can carries as a kinematic collider (§3.3).

## 7. Other engines — moddable physics

A physics mod is an engine: a named, versioned implementation a world
selects in `@world.physics-engine`. What it must be is exactly what §2–§5 say — owned
numerics, no clock, no randomness, ordered iteration; its constants are its
version; it reads only what is stamped in entries; it advances by ticks; it
reads the shapes (§3.1) and properties (§3.2) it declares, with their stated
meanings of absence, and refuses honestly what it can't carry. To
be carried, it registers beside eidosim in the authority's engine table
(`ENGINES` in `shared/protocol/simlayer.js`) with its build hash, and passes the
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
- `bun tools/protocol/run.ts phys physlive physseeds` runs the physics suites:
  launches, rests by cause, carriers, the running server and a client's fold,
  and the reserved seeds (the shape grammar, physical properties, releases
  with spin, the state sample, one clock).
- *Placeholder (§4.1, reserved):* when live authority exists, taking a resting
  thing into it by touch MUST be a `lift` in the log, exactly as a grab is.
