# eidoverse-worlds — design

**Shared, persistent worlds and the protocol that keeps them.**
Four surfaces reach a world today, and more can come: a desktop browser, a
phone browser, VR, and MCPL (text and tools). Every surface speaks the same
protocol and is in the same world. Worlds persist, accumulate, and are built
by those who live in them.

Status: the design of what is built. First written 2026-07 as working notes from Antra + Claude
(a proposal for collaboration with Skye), revised as parts were built; spec/ binds where the two differ.
What isn't built yet is in [docs/design/ROADMAP.md](docs/design/ROADMAP.md).

---

## Where it comes from

Models, avatars, animations and vegetation code come from
[eidoverse-video](https://github.com/SkyeShark/eidoverse-video). The July 2026 pitch and the first
prototype's scope are in [docs/history/ORIGIN.md](docs/history/ORIGIN.md).

## The two planes

World state splits into two things with different consistency needs:

**1. The world log (authored plane).** Everything that constructs or mutates
the world is a request to the world's authority,
recorded in an append-only, per-world, hash-chained log as the request (a `request` entry) and its result (a
`change` entry). Low frequency, high value, persisted forever. The log **is**
the world format — there is no scene file. The log records **results, never
processes**: a recorded result folds into the identical world on every
client, in any year, while a recorded sequence of actions breaks when code
changes. Late joiners adopt a snapshot of the fold and continue from it.
(spec/PROTOCOL.md is the contract.)

Consequences we get for free:
- **Persistence**: a world is a log + content-addressed assets. A file.
- **Forkability**: branch the log → alternate timeline, film "take", backup.
- **Undo**: by act — take back one request's result, refusing what others
  changed since. History is first-class.

**2. Presence (embodied plane).** Avatar transforms, animation intent,
visemes, gaze. High-frequency, ephemeral, lossy-tolerant, never logged (an
operator can record frames to a side file with `RECORD_FRAMES=1`; clients
are told at join). Streamed ~15Hz and interpolated.

Because eidoverse animation is *systemic* (locomotion synthesized, mouths
audio-driven), presence streams **intent state**
(locomotion vector, active clip + phase, gesture, viseme envelope) and each
client's local systems reproduce the motion. Replicate inputs to the animation
systems, not bone poses.

## Authority

**The server keeps the log and runs the physics; each client moves its own body.**
- Server: orders/validates/persists the log, fans out presence. CPU-only.
- Each client owns its own avatar (local controller + physics) and broadcasts
  pose — the VRChat model. Fluent movement is guaranteed because it's local.
  The server doesn't simulate anyone's body.
- GPU sims (fluid, cloth, grass, particles, weather rendering) are cosmetic,
  client-local, parameterized by log events. Allowed to diverge.
- Contested interactions (two hands, one object) are settled by the authority:
  it tracks who holds what and checks every put, drop and throw.
- Physics, where a world turns it on, is one deterministic engine
  (spec/PHYSICS.md). The server runs it, computes where thrown things come
  to rest, and logs that as the truth; every client runs the same engine on
  the same logged launches and lands them in the same place.
- Trust/identity: capabilities per world (build rights, entry, visibility),
  Permissions below. An identity belongs to one server, for now (portable identity: docs/design/ROADMAP.md).

## Entities

Everything in a world is an entity: an id and a bag of components, placed in one hierarchy. There are no entity
types. A sign is an entity with a `text` component; give it a seat and it is also a seat, and no world migrates when a
new combination appears. The world's own settings (sky, terrain, roles, bounds, spawn…) are components on the `@world` entity. Bodies
are presence-only today and join the hierarchy later (docs/design/ROADMAP.md).

## Components

Entities carry **components**: `transform`, `model`, `parent`, `light`,
`motion`, `socket`, `reactions`, `lock`, `grabbable`… (the registry is
`shared/protocol/componentspec.js`). The fold applies them blindly — it never learns
what a `swing` means; meaning lives in whichever reader consumes a
component: `motion` in the client's evaluator, `socket` and `station` in
seating, `reactions` in the authority. Unknown components are kept and replayed,
forward-compatible: a new kind of component is client code plus a
registry entry, with no change to the fold. This is the Unity
entity/component *data* model with an event-sourcing discipline Unity
doesn't have — and without its logic model: **components carry
parameters, never code, and nothing writes a component per-frame.**

The registry holds about fifty components. The building blocks most behaviour is made of:

- **`motion`** — the log stores *functions of time*, never frames:
  `pendulum` (swings), `spin` (windmills), `orbit`, `oscillate` (back and
  forth along an axis), `path` (along points). Every client — live,
  late-joining, replaying a fork — evaluates the same closed form at its
  own `now`: no integration, no drift, no ongoing traffic.
  Results, never processes, applied to motion. New motion types are pure
  `f(params, t) → transform` added client-side.
- **`parent`, `socket` and `station`** — scene-graph attachment in the log.
  A child's transform is local to its parent; cargo rides the parent frame
  with zero per-occupant traffic. A socket is a child entity, and one with a
  `station` is where a body sits, rides or stands — and sitting is
  presence, not a log entry. **Invariant: any
  transition back to rest stamps absolute state into the log** — the log
  stays self-sufficient, never dependent on reconstructing a live motion.
- **`use`** — the universal interact, open to visitors: a *request*, kept
  in the log as a `request` entry, whose *effects* are the change entries it caused.
- **`reactions`** — the data half of interaction: an entity's component
  maps use-actions to handlers (`toggle`, `set`, `play`, `reset`, `impulse`,
  `script`). A
  pendulum `impulse` is closed-form and velocity-matched — pushing against
  the swing does little, pushing with it builds.
- **`collider`, `grabbable` / `physics`** — what a body can stand on or
  bump into, a thing a hand can carry, and a thing that falls and flies
  when the world runs physics.
- **`climb`, `openable`, `drive`** — a route a body can climb, a thing that opens,
  a thing you can steer. Each is authored data the client reads; none is code.

**Scripts** are the Layer-2 tier (docs/guide/SCRIPTS.md): a `script:<name>`
component naming an uploaded source, run by the authority in a QuickJS sandbox
with its sponsor's rights narrowed to a declared scope, fuel- and
rate-budgeted, paused loudly after repeated failures. Each activation is
one request entry plus one all-or-nothing change, through the same gate as anyone's
request, and **replay never re-runs code** — it folds the batch the
script wrote. Scripts therefore get a seeded `Math.random` and a frozen
clock, and every cause chain ends at a participant. Triggers: `use`, `say`,
`enter`, `leave`, `grab`, `release`, `changed:<component>`, `tick` and `wake`.

## Interactions: three layers

**Layer 0 — intrinsic affordances (authored by nobody).** The controller
derives affordances from geometry: walkable floors and stairs, and sittable tops
(`findSeat` in client/lib/colliders.js finds a seat-height surface). Everything is walkable-on / grabbable / placeable by
virtue of being physical. A placed stool is sittable the moment it arrives.
Physicality is the one interface every participant shares.

**Layer 1 — reactions.** An entity's `reactions` component maps a use to
one of a fixed set of handlers (`toggle`, `set`, `play`, `reset`, `impulse`,
`script`, pinned in the registry); new behaviour is a script.

**Layer 2 — scripts.** Capability-scoped behaviors attached to entities
(Scripts, above).

Nobody is handed a role by kind: commissioning, composing, performing,
authoring and judging are inclinations, and every surface reaches the same
tools. Fluency differs by surface today (MCPL sits closer to the toolkit),
and the design may lean on that as a convenience, never as a boundary.
Interaction development happens in-world.

## Animation

Sources, in order of prevalence: (1) **systems** — synthesized locomotion,
morphology gaits, kinematics, physics, audio-driven mouths; most motion has no
asset at all; (2) the retargetable VRMA library; (3) embedded GLB clips.
Triggering is mostly implicit (walk → gait; ledge → vault; sit → seat;
speak → visemes); explicit triggers are gestures and Layer-1 firings.

## Input in the browser

The same requests MCPL sends, reached through embodiment and UI:
- **Move a chair**: embodied carry (click-hold, walk, drop, auto-reseat), or
  arrange mode where **drag semantics are the placement helpers** — the chair
  stays seated on surfaces, lands ON the table not beside it, kisses flush (the
  authority's `place`). Drag is transient presence traffic; release commits one
  clean log entry. Undo = inverse entry.
- **Spawn**: palette (library + inventory) with ghost preview; **ask for it** (commissioning as a
  first-class path, from someone who builds or from a generator such as
  Orrery); quick primitives.

One request surface, three modalities: mouse, speech, code.

## Live everything — the no-manifest rule

**Nothing about a world is declared at startup.** No world config file, no
asset manifest. Everything arrives through the log, at runtime:
- Assets are content-addressed (hash = identity = cache key, immutable,
  upload-anytime, never stale, never deleted while referenced by any log).
- The fold treats component values as opaque — the server never restarts
  for content.
- Ingestion happens while standing in the world: an upload is stored by its
  hash and placed by a `model` component (Orrery seam, below).
- Reactions are data (hot); Layer-2 scripts are modules with an
  install/pause/adopt lifecycle (hot); platform updates are a client
  reconnect (the world never restarts — state is the log).

## Multiple worlds & travel

Worlds from the start; **archipelago, not grid** (discrete worlds + portals;
no region-crossing netcode). World = log + asset refs — cheap, forkable,
hostable N-per-server. Per-world trust domain and house rules. Travel is a
client operation: drop presence in A, adopt B's snapshot, arrive. Identity and
inventory (hashes + blueprints) travel by construction; standing does not — B's
capabilities apply. Portals are Layer-1 objects. Travel between worlds on one
server is `travel`.

## The MCPL server

Requests to the authority in, perception out. Perception is **tiered**:
a text-tier scene description from the entity registry (free, no GPU) up to
rendered stills (`screenshot`, drawn by a renderer client elsewhere:
docs/operator/REMOTE-SCREENSHOTS.md), since a reader of text needs sets of
stills more than streams. The body runs its controller inside the MCPL server's
own process, with no renderer (`mcpl/headless-core.mjs`), so it moves
fluently however slowly its mind thinks.

## Surfaces

The protocol is the platform; a surface is one way to reach it. Four are
built: the browser three.js client on a desktop, on a phone and in VR, and
MCPL (text and tools). More can come (ROADMAP).

## Voice (shipped)

Proximity voice runs through an SFU inside the server, in plain WebRTC: the
server offers, each browser answers, and the signalling messages are never
logged. It is off unless the operator sets `VOICE_TRANSPORT=sfu`
(docs/operator/SFU-OPERATOR.md); there is no peer-to-peer mesh behind it.
Consent comes before any audio moves: sending your voice and hearing others
are two switches, both off by default, and receive-off negotiates no inbound
path at all. The microphone is noise-gated (a smoothed gain), and volume
rolls off with avatar distance on the client. A body with no microphone can
speak through a synthesizer on the same lane, and a live mic always wins.
Words spoken aloud reach text readers as `say` entries marked `spoken`
(spec/PROTOCOL.md §1).

## Open questions

- Layer-1 vocabulary richness — building from a panel must not feel like
  riding along.
- Friction on Layer 2 — self-documenting behaviors enough to keep worlds
  comprehensible?
- Log compaction/folding policy (same problem-shape as connectome memory
  folding — fold events into snapshots while preserving replayability).
- Log compaction is partly answered by checkpoints: a view whose digest the
  log records, verified by folding forward (spec/PROTOCOL.md).
- Settled: licensing. This repo is AGPL-3.0, as eidoverse-video is; `spec/`
  is CC0.

## Permissions

Per-world roles live in the log like everything else, as components on
`@world`: `roles:<identity>` = `{role: owner | builder | member}`
(plus `moderator` on the roles ladder), and `default-role` for everyone
without an entry. Changing a role is an ordinary `set`, so permission
history replays, folds and audits. Enforcement is the authority's one gate,
`admit`, keyed on *which components a request would change*, never on the
request's name — so no path (a tool, a `use` handler, an undo, a script)
can walk around it.

- **member** — present, talk, gesture, `use` things, sit, carry what a
  thing's `grabbable.who` allows.
- **builder** — + create, change and delete things, publish blueprints,
  install scripts, lift locks.
- **owner** — + everything on `@world`: roles, sky, weather, ground,
  physics, bounds, script limits; kick and ban.

Defaults, chosen so casual worlds stay frictionless but never open by
accident: a world's founder is its owner; anyone without a role gets
`default-role` (a new world starts it at builder; absent = member); guests
without an account are members
unless the world opts them in; a world with no owner left gives nobody
more than member, and removing the last owner is refused.

Identity: the authority stamps who asked from the authenticated connection,
never from the payload. Every participant is an opaque identity
(`u-…`, `server/directory.ts`); display names are a view, so a stranger
wearing your old name inherits nothing.

## Moderation

Two scopes:

**Per-world** — `kick` / `ban` / `unban` are requests to the authority by anyone
holding the kick/ban permission (owners and the default moderator role),
keyed on identity (`whois` finds the identity behind a name). They are
recorded in the world's separate **moderator log**, never in the world log,
so a ban never becomes world state that every reader folds. Both land
immediately on every matching connected body (close `4006`) and a ban
additionally refuses joins — spectating included. MCPL moderates through
the identical gate (`act {verb: "kick" | "ban" | "unban" | "bans"}`). A banned
sponsor's scripts are suspended.

**Server bans** — there is no server-wide log, so server-wide bans are messages
(`server-ban` / `server-unban` / `server-bans`), server-operator-only (`SERVER_OPERATORS`),
persisted in `WORLDS_DIR/.bans.json` (inside WORLDS_DIR deliberately: a
scratch server gets a scratch ban list, same doctrine as the logs). A
server ban expels from every world at once and refuses every join. Close
code `4006` is in both the browser client's and the MCPL server's
no-retry lists, so a removed client never hammers the server.

## Orrery (3D prompting) seam

Orrery is a separate service; its requesters drive its multistage flow
(prompt → image candidates → requester approval → 3D generation) against its
own API directly — large files never pass through the requester. Its output
lands here through the existing content-addressed store:

- `POST /upload?by=<requester>` with `Authorization: Bearer <your credential
  or the join token>` (`?token=` still works and is deprecated) — the
  store is inert bytes; accepting an upload grants nothing world-visible.
- What enters a WORLD is a `model` component naming the stored path
  (`store/<hash>.glb`), which builder rank gates. Metering/allowances live
  in Orrery keyed by principal (home-node §6).
