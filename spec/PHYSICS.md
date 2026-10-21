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

- `@world.physics-engine` = `{engine: "<name>@<semver>", tickMs?}`. An engine is
  named by its **version**, and a server **carries** a version when its
  implementation reproduces that version's conformance digests
  (`spec/conformance/physics/`: throw scenarios and what each comes to rest as).
  A change that still reproduces them is the same version; a change meant to alter
  results is a new version with its own digests. The owner may name the engine
  alone (`eidosim`) or a version (`eidosim@1.0.0`); when no version is named, the
  **authority stamps** the one it carries. A version the owner names is kept, and
  a server that doesn't carry it treats the world as foreign. The reference
  authority carries `eidosim@1.0.0`.
- **Changing the engine is a cut**: the authority refuses to change or delete
  `@world.physics-engine` while anything is in flight (an owner may force it, freezing
  in-flight bodies where they are). After the cut, everything is
  interpreted under the new engine.
- **A version the authority stamped is the authority's to restamp.** When a world
  names an engine this server carries under a version it doesn't, and the version
  was stamped (no version typed in the request that set the engine), the authority
  cuts the world to the version it would stamp today, itself, as `system` (act
  `restamp-engine`), at the next request or heartbeat. The owner never chose the
  old version, so the cut overrides no choice of theirs, and the log shows where
  the world's law changed. **A flight doesn't hold the cut back**: this server
  can't compute it, so a cut that waited for its rest would never come. The cut
  ends each flight itself, leaving the thing where the fold has it (only a rest
  moves it), and names what it ended (`ended`; a purged launch's unknown body is
  counted, `endedUnknown`). That is the cut's change, not a rest, so a reader that
  carries the old version has no rest to check it against. A lift on the record
  outlives the cut; only a hold in presence defers it, to the next act. A server
  that can't sign for the world doesn't cut it.
- **A version the owner named, or an engine of a name this server doesn't carry,**
  is the owner's to change. The server serves what doesn't need the engine and
  refuses what only the engine computes (a throw, or a grab or delete that would
  set a resting thing falling), with `foreign-engine`, naming the engine's version
  and what would have fallen, and saying an owner can set one this server
  carries. It never quietly substitutes a settlement for the engine's result.
- **A reader that doesn't carry the named version MUST NOT recompute the
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
  against each other: thrown at each other fast enough, they can pass (body–body
  time of impact is a later build).
- **A height-field ground** (`shared/terrainmath.js`).
- **Waking and knocking**: a dynamic thing at rest that no hand rule holds fixed
  (not locked, under nothing locked, holding nothing locked) is a sleeping body.
  It wakes when a moving body touches it (a contact within the speculative
  distance, as Box3D and Jolt both wake), flies under the launch whose flight
  touched it, and rests as that launch's (§1). Everything else at rest is a
  collider.
  A sleeper is never woken by a support leaving, so the authority does it: when
  a grab takes up, or a delete removes, a thing that a dynamic sleeper touches
  from above (its box meets the thin slab just over one of the thing's tops),
  that sleeper is launched from rest (`v: [0, 0, 0]`) even when it is parented
  to another support it also rested on, and the engine decides whether what is
  left holds it. Held, flying and locked things stay.
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
must be able to carry every field.

**Reserved, not written (shape audit 2026-10-16)**, all but two. `mass` and
`density` stay open fields: the contact push reads them (`shared/shove.js`
`massOf`: the authority's contact gate (`punt {contact: true}`), the walker and
the agent cap a push by mass), though eidosim's flight doesn't yet. Nothing reads the other eight, so
they are `physics`' *reserved fields*: their names, units, limits and
meanings of absence below are held (in the registry's `reservedFields`,
`reservedShape` and `absentMeans`, all pinned), and every write of one is
refused (code `reserved`) until an engine declares that it reads it. A number
a builder can type that nothing honours is a number tuned for nothing. Absence
keeps the behaviour before the field existed: the engine's own law. None will
ever be a materialized default (a pinned `mass: 1` is wrong for every crate
ever made). `physics.kind` is **required**: a bare `{}` read as dynamic while
the component's absence means static or nothing.

| field | unit | absent means |
|---|---|---|
| `mass` | kg, > 0 | `density` × the volume of the stamped shape (`shapes.js shapeVolume`). That shape is the measured **bounding box** today, so a chair weighs as a solid box; eidosim computes exactly this (`shared/sim.js`: 1000 kg/m³ × its box) |
| `density` | kg/m³, > 0 | its surface's density, else 1000 (water; eidosim's) |
| `surface` | a `surface:<name>` on `@world` (was `material`, renamed so `material` means appearance only) | friction, restitution and their combine modes from their own fields, else the engine's law |
| `friction` | ≥ 0, one coefficient (static = dynamic) | its surface's, else the engine's law |
| `restitution` | 0..1 | its surface's, else the engine's law |
| `frictionCombine`, `restitutionCombine` | `average` \| `min` \| `multiply` \| `max` | its surface's, else `average` (friction) and `max` (restitution) |
| `linearDamping`, `angularDamping` | 1/s | the engine's law (eidosim: none) |
| `centerOfMass` | [x, y, z] m, own frame before scale | the centroid of its stamped shape |

**Cut** (they were named, never read, and 0 values stored them): `ccd` (a
solver-quality knob no format maps: Unity has four modes, Jolt a motion
quality, KHR and OMI none; eidosim sweeps every body anyway) and `layers` /
`mask` (32-bit layers can't explain themselves to a reader of the log, and
Unity's 32-layer cap is a decade-old complaint; when collision filtering
arrives it is **named groups**, KHR's `collisionSystems`, probably on
`collider`). Additive later, each with its meaning of absence: `gravityFactor`
(absent 1; KHR and OMI), `staticFriction` / `dynamicFriction` (absent:
`friction`), inertia.

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
| `kind: kinematic` | `eKINEMATIC` / `isKinematic` | `EMotionType::Kinematic` | `KinematicPositionBased` | `AnimatableBody3D` |
| `w` | angular velocity, rad/s, world | `GetAngularVelocity` | `angvel` | `angular_velocity` |

Box2D v3 (2D) has the same set: `density`, `friction`, `restitution`, linear
and angular damping, `isBullet`, `categoryBits`/`maskBits` (64-bit, a
superset of 32).

- **Surfaces.** A world names its materials as `@world surface:<name>
  {friction?, restitution?, density?, frictionCombine?, restitutionCombine?,
  label?}` (Marrow's Surface Data Cards: one name bundles a surface's
  numbers, and content names materials rather than raw per-object numbers).
  `surface` is **reserved** with `physics`' reserved fields (writes closed;
  both open together). A `physics.surface` naming no surface reads as none.
  The registry may later add built-in surface names; a world's own
  `surface:<name>` wins.
- **Combining two surfaces is the protocol's, not the engine's.** The modes
  are the four every engine can carry (PhysX's, Unity's and Rapier's enums;
  Jolt and Box2D v3 take any rule as a callback): `average`, `min`,
  `multiply`, `max`. When two touching surfaces name different modes, the
  later in that list wins (PhysX's and Unity's priority). Absent everywhere,
  friction averages (the PhysX, Unity and Rapier default) and restitution
  takes the max (the Jolt and Box2D default: a bouncy ball stays bouncy on
  any floor). Geometric mean, Jolt's and Box2D's friction default, isn't
  offered: three of the engines can't express it. **KHR_physics_rigid_bodies
  names the same four modes (`average`, `minimum`, `maximum`, `multiply`) but
  resolves a mismatch the other way round** (if either says average, average;
  then minimum, maximum, multiply). We keep the engines' order, which three of
  them carry natively; an importer of KHR materials resolves each touching
  pair to one mode, never maps mode to mode.
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
  a static. **The authority stamps it** (shape audit 2026-10-16): a thing
  that has `motion`, `motion:<part>` or `openable`, itself or on anything it
  hangs under, is stamped `kinematic` rather than `static` when the world runs
  physics, and a static thing that starts moving is restamped. Behaviour is
  unchanged under eidosim; the record no longer says "never moves".
- **A thing with `motion`** (pendulum, spin, orbit, oscillate, path) is a closed
  form of time, so it is a deterministic input (Covenant I). An engine that
  can carries it as a kinematic collider at its motion's pose; eidosim reads
  only the transform, so a thrown ball passes through a swinging pendulum
  today. Don't build on that pass-through. A whole thing's motion turns
  about its `pivot` component (absent: its origin); a part's motion
  (`motion:<part>`) carries its own `pivot`, in the part's frame.
- **`physics-joint:<name>` is reserved** (the constraint between two bodies;
  OMI_physics_joint's name, beside `physics` and `physics-engine`). Renamed
  from `joint` on 2026-10-16, when nothing stored it: `joint` is now the
  reserved **skeleton node** (Maya's joint, glTF's skin joint, a VRM humanoid
  bone: one bone of an avatar's entity tree). The authority refuses both. No
  fields are pinned: one `anchor` and one `axis` can't carry the **two
  frames** every engine and glTF/OMI use (Rapier's local frame on each body,
  Unity's anchor + connectedAnchor, OMI's joint node + connected node), and a
  six-member type enum with `limits: [min, max]` in "rad or m" is ambiguous
  for a cone or a spring. `parent` is a rigid attachment and never a solver
  joint; `openable` is kinematic animation; a *physical* door is a
  physics-joint.
- **The target shape, sketched so the first engine with joints doesn't
  invent one (not registered, not pinned).** After OMI/KHR, with both frames
  stored rather than derived at load (Covenant III: things move after
  authoring):
  `{to: ref, a: {pos, q}, b: {pos, q}, limits: [{linear?: [axes], angular?:
  [axes], min?, max?, stiffness?, damping?}], drives: [{type, mode, axis,
  maxForce, positionTarget, velocityTarget, stiffness, damping}], collide?:
  false, breakForce? (N), breakTorque? (N·m)}`. Each frame is in its own
  body's frame before scale; the authority *stamps* both from one authored
  world-space anchor at write (as it stamps `physics.shape`), so authoring
  keeps "place one empty". Limits are m or rad (N/m, N·m/rad). Named types
  (hinge, slider, ball, fixed) are editor presets that compile to limits,
  never stored (Unity's ConfigurableJoint-versus-HingeJoint split is the
  lesson).

## 4. Covenant III — the planes stand

- The presence plane still **never folds** and is never a sim input.
- **The engine/presence boundary is crossed only by log entries, in both
  directions.** Bodies and hands affect the sim only by crossing the plane as
  checked acts — `throw {id, v, w?}`, `punt {id, power | v}`, a `drop` with
  physics — and the `sim` entry they produce carries everything the engine
  needs. Taking a thing *out* of the engine is a `lift` or `catch`, whatever
  the cause: a grab today, a touch or push takeover later. Returning it is a
  `launch` (a release with its state) or (reserved) a settlement (§4.3). The engine MUST
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
  *reserved* (refused until built), `deflect` (a `sim` entry: the body hands a flying thing back). A thing under live authority that meets a
  body delivers a `shove` to that body's client under its consent table
  (actor: the thing's live authority, carrying the thing's `id` and `v`);
  the thing's own motion ignores the body. Carrying a person is a consent
  class (`carry`, PROTOCOL body consent; reserved): the carried person's
  client parents their own body to the carrier's hand, and may stop at any
  moment. When avatar bodies are simulated, they are simulated the way
  Boneworks does it and Fusion networks it: a physics rig in the presence
  plane, per client, driven toward its tracked targets, with a force-driven
  puppet of every other body; never in the engine, never in the log.
- **Live simulation authority** over a thing is presence: transient, cheap, unlogged. What is built and binding:
  - **The holder's switch.** `grabbable.steal` defaults to `true` (the latest grab wins); under `steal: false` the second
    `grab` is refused (`held`) until a `launch` or a settlement.
  - **Claims are ordered by admission**, never by a sender's `t` (§5.1 says the same of releases): two grabs in one
    beat resolve in the order the door admitted them.
  - **Letting go is a `launch`**: the released thing crosses into the engine as one committed intent and belongs to the
    engine until it rests (§4); a flight's outcome never depends on a presence-plane fact (Covenant III).
  - **A held object rides its holder's hand**: it travels in the holder's pose as which grip and where, never as a
    separate stream. Taking a resting thing into live authority is a `lift`; leaving it is a `launch`.
  - **Reserved names, refused until built** (their intended rules are direction, in docs/PHYSICS-DIRECTION.md): the verb
    `cohold`, the `steal` value `"ask"`, and on `@world.physics-engine` the fields `claimDebounceMs` and
    `liveAuthorityExpiryMs`.
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

### 4.3. The state-sync lane and settlement (reserved)

The presence message `state` (a live authority streaming a thing's samples) and the settlement claim are reserved names:
the server refuses every `state` sample, and nothing settles by claim yet. Their intended shapes are direction, not
contract: docs/PHYSICS-DIRECTION.md.

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
  (client/lib/thingphysics.js).

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
(`ENGINES` in `shared/protocol/simlayer.js`) under its version, with that version's
digests in `spec/conformance/physics/`, and passes the
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

## Lost at the edge

A flight that crosses the world's edge is lost there and then: the sim layer reports it rested where it is (`lost`), the rest is admitted without the engine's resting flag, and the authority sends it home on the same pass. Bounds bound x, z and the sky (`max[1]`); the floor is the terrain's, never `bounds.min[1]` (the default bounds' min y sits above the default heightfield). (10-11, attack-physics P1/P2.)
