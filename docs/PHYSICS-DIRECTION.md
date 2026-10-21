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
