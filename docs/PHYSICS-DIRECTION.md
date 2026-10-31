# Physics direction — designs not yet built

Informative (recut C18, 2026-10-21): the unbuilt parts of spec/PHYSICS.md §4, moved out of the contract so the spec holds
only what is built and the names it reserves. Each is the intended rule when it's built; until then the names are
refused (PHYSICS §4.1, §4.3).

## deflect (a body hands a flying thing back)

*reserved*, `deflect {id, v, w?}` (a `sim` entry: the thing leaves the body
  with the state the client gives it, under the body's consent, like a
  launch; refused until built).

## Live simulation authority (the full intended rules)

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

## The state-sync lane

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

## Settlement is a checked claim

When a thing under live authority comes to rest (asleep about 0.5 s) or is put
down, its authority sends one **settlement**: a resting pose. The door treats
it as a claim, like `put`: physical checks (support, overlap) and reach
against the holder's last presence, so a cheating client can do no more than
a builder could. It is logged as a plain `transform` change, attributed to
everyone who handled the thing since it last rested. Trajectories never enter
the log. A holder who disconnects mid-motion is settled from their last
accepted state, or released into the sim.

## Moved from PHYSICS.md (recut C18, the house's plan #260 2026-10-20, item 18)

Verbatim when moved; the spec keeps the names, these keep the design.

### Physical properties: the reserved fields' design

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

### Joints: the target shape

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

### Carrying a person, and simulated bodies

- Carrying a person is a consent class (`carry`, PROTOCOL body consent;
  reserved): the carried person's client parents their own body to the
  carrier's hand, and may stop at any moment.
- When avatar bodies are simulated, they are simulated the way Boneworks does
  it and Fusion networks it: a physics rig in the presence plane, per client,
  driven toward its tracked targets, with a force-driven puppet of every
  other body; never in the engine, never in the log.
