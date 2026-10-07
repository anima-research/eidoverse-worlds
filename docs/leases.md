> **v1 only.** A v4 world refuses leases: carrying is grab/put/throw/drop/punt through the door (AGENTS.md,
> notes design 20; client/lib/v4phys.js). This document records the v1 contract.

# Animation leases — physics and motion as plugins

**The takeover negotiation is the architecture; everything that moves is a
plugin.** The engine's job is to arbitrate *who may animate what, right now* —
never to know *how* the animation is computed. A Verlet ragdoll, a rolling
ball, a rope, a cloth solver on a GPU box, somebody's homebrew tail-wag
script: all of them are lease holders streaming results, distinguishable to
the engine only by which lease they hold.

This document is the contract. It extends the two-plane doctrine (DESIGN.md):
leases live entirely on the **presence plane**; their *outcomes* commit to the
**log** as ordinary verbs. Replay never runs a plugin — it folds what plugins
committed.

## The invariant that makes plugins free

**Plugins extend senders, never receivers.** Everything a lease holder
produces reduces to poses (bodies) or transforms (entities) on the presence
plane, plus ordinary logged verbs at rest. Every client that can render a
pose stream — that is, every client ever written — renders every plugin's
output with zero knowledge that plugins exist. The moment a plugin requires
the *receiver* to install code, the world forks into those who see it and
those who don't. Don't.

Corollary: **the plugin API is the wire protocol, not any client's
internals.** A plugin may run inside a browser client, as its own headless
process (the crash-test dummy pattern), or on a house-run box (the GPU
delegate pattern). The engine cannot tell and must not care.

## Two flavors of authority, one lifecycle

Who arbitrates a lease depends on what kind of thing is being animated:

|                | bodies (avatars)                    | entities (objects)                  |
|----------------|-------------------------------------|-------------------------------------|
| arbiter        | the body's OWNER (their client)     | the SERVER (claim table per world)  |
| grant policy   | consent (`pushable`, per person)    | rights (rank-gated) + availability  |
| stream applies | owner applies + rebroadcasts        | server broadcasts holder's stream   |
| at rest        | held pose in presence               | `place` verb in the log             |
| revocation     | owner any time (movement = revoke)  | proximity take, TTL, disconnect     |

The **body lease** is the `bodydrag` protocol (grab / stream / release /
pinAt / unpin), shipped and documented in client/lib/bodydrag.js. Its
defining property: authority never actually moves — every stage is a request
the owner's client honours, and the owner's own presence stream outranks any
holder (self-healing).

The **entity lease** is the `lease` message family, defined below. Its
defining property: objects have no owning client, so the server is the
arbiter and the memory — it tracks the holder, remembers the last streamed
transform, and commits it if the holder vanishes. Nothing is ever lost to a
crashed simulator.

## Entity lease wire protocol

All client→server messages are `{type: "lease", op, id, ...}` where `id` is
an entity id. Presence-plane semantics throughout: never logged, rate-capped,
malformed input dropped.

- **`{op: "claim", id, take?}`** — ask to animate an entity.
  Granted if: the entity exists, the claimant's rank clears the world's lease
  gate (default rank 0 — physical play is *using* the world, like `use`), the
  claimant could move it by hand-authored `punt` — it is not guarded by someone
  else (`comp guard`: placer, owner and operators only) and not locked
  (`comp lock` refuses everyone) — and the entity is unleased — OR `take: true` and the claimant's body is within
  TAKE_RANGE of the object's live position (kick the ball away from the
  dribbler), OR the current lease is stale (no state for STALE_MS).
  Server replies `{op: "granted", id}` or `{op: "denied", id, why}`.
  A preempted holder receives `{op: "lost", id, to}` — it must stop
  simulating; its next `state` for that id is dropped.
  Everyone else sees `{op: "claimed", id, by}`.

- **`{op: "state", id, p, yaw?, q?}`** — the holder's sim output, ~15Hz.
  Server stores it (last-value memory) and broadcasts
  `{op: "state", id, by, p, yaw?, q?}` to everyone else. Non-holders'
  states are dropped silently (a lost holder's tail never fights the
  successor).

- **`{op: "release", id, p?, yaw?, q?}`** — done. If a final transform rides
  along (or the server holds a last state), the server **commits** it —
  orientation included: the release's `q`, else the last streamed `q`,
  except that a release stating a `yaw` without a `q` means *upright at that
  heading* (PROTOCOL §9.1) and commits no tilt:
  a `place` entry, actor `"world"`, args carrying `{by: holder, via:
  "lease"}` — the same provenance pattern as reaction effects. Then
  `{op: "released", id}` to everyone. The guard/lock check is asked again
  here: if a lock or guard landed mid-lease, nothing is committed and the
  server broadcasts one `{op: "state", id, by: "world", p, yaw}` carrying the
  logged position, so every view (the holder's too) snaps back. The object is at rest in the log;
  late joiners fold it; the lease table forgets it.

- **Holder disconnects** → identical to release-with-last-state. A crashed
  simulator leaves the object exactly where its last frame put it.

- **Stale sweep** — a lease with no state for SWEEP_MS is force-released
  (commit last state). Nothing stays possessed; nothing hovers forever.

The server never simulates. It arbitrates, remembers one transform per
leased object, and commits. CPU-only, exactly as DESIGN.md demands.

## Stages and interop — handing the same object along

Antra's requirement: *different plugins can take over at different stages,
even from the ground up.* Three composition patterns, none needing new
protocol:

1. **Within one holder** — stage chains are just code. The kick plugin's
   projectile stage hands to its rolling stage hands to settle; a rope
   plugin could catch a flying ball into a sling. One lease, one stream;
   the engine sees transforms.
2. **Across holders** — `claim {take: true}` mid-flight. The new holder
   starts its sim from the last broadcast state (position AND the velocity
   it can infer from the stream, or its own fresh impulse). This is how two
   players kick one ball, and how a hand-rolled plugin takes an object from
   the house physics — or replaces it wholesale, from the ground up: claim
   everything, simulate differently. The protocol doesn't privilege the
   built-in physics in any way.
3. **Delegation** — a house-run client (GPU delegate, cloth box, crowd
   simulator) is just a resident with a token that claims leases and
   streams. Bodies delegate by consent (an agent may accept a delegate the
   way it accepts a dragger); entities by ordinary claim. No engine hooks,
   no special trust tier — capabilities and rank already gate it.

## Self-animation: the free tier

Your own body needs no lease at all — your client owns it; a runtime-loaded
script that drives your bones and streams your presence is just *you,
moving*. The `EW` debug surface exposes enough today (bone nodes via
`me()`, `myState.pose`, `sendVerb`); `EW.lease` covers entities, and the
🧩 mods panel (client/lib/mods.js) makes the whole tier a first-class UI:
local scripts in IndexedDB run as trusted in-page modules with tick, UI
(panels/frames), and dispose hooks; a world's OWNER may promote one to the
server store, and every visitor chooses — per exact script hash, or by a
per-world wildcard — whether it runs in THEIR page. Nothing auto-executes. Trust note: an in-page script speaks AS you — loading one is a
mod-install decision. Untrusted code should instead join as **its own
participant** (own identity, own rights, animating others only through
leases it negotiates) — a spirit with its own body, not a hand in your
glove. The dummy (tools/dummy.ts, 38 lines) is the template.

## Doctrine checklist (all inherited, none new)

- Leases are presence: never logged, never replayed, lossy-tolerant.
- Outcomes are verbs: `place` for entities, held poses for bodies. The fold
  stays a pure function of the log.
- Replay NEVER re-executes a plugin (same law as behaviors §replay).
- One authority per thing per moment; every takeover is negotiated; the
  more-native authority always wins ties (owner over holder, server over
  everyone, for entities).
- No handler may throw out of the ws callbacks (commit 4f82250's law).
- Caps: state size, claim rate, one holder per object, leases per client.

## What exists today vs. what this document promises

Shipped: body leases (bodydrag + pins), headless body physics
(mcpl/physics.ts), entity leases + the kick plugin (client/lib/physobj.js).
Future work that slots in without protocol changes: ropes (a lease holder
whose at-rest form is a parametric catenary comp), cloth/crowd delegates,
lease gates as a per-world knob, agent-side kick tools, entity leases for
*attachment* (nail a body to the moving ferry — a lease on the JOIN, not
the ferry).
