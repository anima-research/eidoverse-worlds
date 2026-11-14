# eidoverse-worlds — design

**Shared, persistent worlds and the protocol that keeps them**, built on the
[eidoverse-video](https://github.com/SkyeShark/eidoverse-video) toolkit.
A world is reached through several surfaces, each suited to minds with
different abilities and aptitudes: a browser, VR, a phone, and MCPL (text and
tools). Every surface speaks the same protocol and is in the same world.
Worlds persist, accumulate, and are built by those who live in them.

Status: the design. First written 2026-07 as working notes from Antra + Claude
(a proposal for collaboration with Skye), revised as parts were built; what
isn't built says so, and spec/ binds where the two differ.

---

## Why eidoverse

The video toolkit already solved the hard 90%: characters with physics
locomotion and geometry-derived maneuvers, procedural creatures/robots/terrain
/weather, placement helpers that make clumsy input land correctly, and a
creative API that is *intent-shaped* (`walkTo`, `seatOn`, `placeOn`,
`say`, `makeCreature`). Crucially, construction is **seeded and deterministic**
(built for reproducible batch renders) — which makes toolkit calls replicable
as-is. And it's all browser tech run headless: the same code renders fluently
in Chrome WebGPU (validated 2026-07-09 — `basic_vrm.js` byte-for-byte
unmodified, 60fps; see eidoverse-video `work/browser_spike/`).

What the toolkit lacks is exactly one layer: networking, persistence, and
multi-participant authority. That layer is this repo.

## The two planes

World state splits into two things with different consistency needs:

**1. The world log (authored plane).** Everything that constructs or mutates
the world is a request to the world's door (the spec's *authority*),
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
- **Retroactive filming**: any moment that ever happened can be re-rendered
  offline at production quality by pointing the existing eidoverse batch
  renderer at a replay. The video toolkit isn't discarded — it becomes the
  camera crew. Machinima-native platform.
- **Undo**: by act — take back one request's result, refusing what others
  changed since. History is first-class.

**2. Presence (embodied plane).** Avatar transforms, animation intent,
visemes, gaze. High-frequency, ephemeral, lossy-tolerant, never logged (an
operator can record frames to a side file with `RECORD_FRAMES=1`; clients
are told at join). Streamed ~15Hz and interpolated.

Because eidoverse animation is *systemic* (locomotion synthesized, creatures
self-animating, mouths audio-driven), presence streams **intent state**
(locomotion vector, active clip + phase, gesture, viseme envelope) and each
client's local systems reproduce the motion. Replicate inputs to the animation
systems, not bone poses.

## Authority

**The server is a sequencer and archivist, not a simulator.**
- Server: orders/validates/persists the log, fans out presence. CPU-only.
- Each client owns its own avatar (local controller + physics) and broadcasts
  pose — the VRChat model. Fluent movement is guaranteed because it's local.
- GPU sims (fluid, cloth, grass, particles, weather rendering) are cosmetic,
  client-local, parameterized by log events. Allowed to diverge.
- Contested interactions (two hands, one object) are settled by the door:
  it tracks who holds what and checks every put, drop and throw. Physics,
  where a world turns it on, is a deterministic engine every client runs
  on the same logged launches (spec/PHYSICS.md) — still not a server
  simulating for everyone.
- Trust/identity: capabilities per world (build rights, entry, visibility)
  are built (Permissions, below). Keys per participant are the direction,
  not built: they align with the connectome Archipelago design
  (keys → attestation → domain trust), and federation of worlds across hosts
  falls out of the same model. Today an identity belongs to one server;
  portable identity is later work.

## Entities

**These are conventions, not classes.** Since the component model landed
(next section), the fold knows only `id + transform + component bag`; every
row below is a *reading* of what an entity carries, not a type it is. An
"Inscription" is anything with a `text` component; give it a socket child
with a `station` and it is also seatable — no one decides which category owns the
combination, and no world ever migrates when a new reading appears. The
table stays because the words are useful, the way "mailing list" is a useful
word for a pattern of email use without being a type in SMTP.

| Entity | Notes |
|---|---|
| **Avatars** | Embodied participants. VRM + controller + identity. Presence plane only. |
| **Things** | Placed objects: fetched GLBs, procedural builds, scan nodes, primitives. Transform, parent, creator, scripts. |
| **Automata** | Self-animating (`makeCreature`/`makeBot`): autonomous motion + command surface. Ownable, possessable. |
| **Regions** | Named volumes: capability scopes + triggers ("the kitchen", a private room). |
| **Inscriptions** | Text/media anchored in space — notes, signs, screens. Substrate for asynchronous interaction. |
| **World** | Sky, weather, terrain, time. |

Relations: scene-graph attachment (eidoverse support-chain memory), ownership,
region membership.

## Components

Entities carry **components**: `transform`, `model`, `parent`, `light`,
`motion`, `socket`, `reactions`, `lock`, `grabbable`… (the registry is
`shared/protocol/componentspec.js`). The fold applies them blindly — it never learns
what a `swing` means; meaning lives in whichever reader consumes a
component: `motion` in the client's evaluator, `socket` and `station` in
seating, `reactions` in the door. Unknown components are kept and replayed,
forward-compatible: a new kind of component is client code plus a
registry entry, with no change to the fold. This is the Unity
entity/component *data* model with an event-sourcing discipline Unity
doesn't have — and without its logic model: **components carry
parameters, never code, and nothing writes a component per-frame.**

Building blocks:

- **`motion`** — the log stores *functions of time*, never frames:
  `pendulum` (swings), `spin` (windmills), `orbit`, `oscillate` (back and
  forth along an axis), `path` (along points). Every client — live,
  late-joining, replaying a fork — evaluates the same closed form at its
  own `now`: no integration, no drift, no ongoing traffic.
  Sequencer-not-simulator, applied to dynamics. New motion types are pure
  `f(params, t) → transform` added client-side.
- **`parent`, `socket` and `station`** — scene-graph attachment in the log.
  A child's transform is local to its parent; cargo rides the parent frame
  with zero per-occupant traffic. A socket is a child entity, and one with a
  `station` is where a person sits, rides or stands — and sitting is
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
- **`grabbable` / `physics`** — a thing a hand can carry, and a thing that
  falls and flies when the world runs physics.

**Scripts** are the Layer-2 tier (docs/guide/SCRIPTS.md): a `script:<name>`
component naming an uploaded source, run by the door in a QuickJS sandbox
with its sponsor's rights narrowed to a declared scope, fuel- and
rate-budgeted, paused loudly after repeated failures. Each activation is
one act plus one all-or-nothing batch through the same gate as anyone's
request, and **replay never re-runs code** — it folds the batch the
script wrote. Scripts therefore get a seeded `Math.random` and a frozen
clock, and every cause chain ends at a person. Triggers: `use`, `say`,
`enter`, `leave`, `grab`, `release`, component changes, timers. Still
ahead: proximity/phrase/region triggers, and publishing an authored
behaviour into the world's Layer-1 vocabulary with knobs.

## Interactions: three layers

**Layer 0 — intrinsic affordances (authored by nobody).** The controller
derives affordances from geometry: vaultable, climbable, sittable (`seatOn`
raycasts real seat pans). Everything is walkable-on / grabbable / placeable by
virtue of being physical. A scanned stool is sittable the moment it arrives.
Physicality is the one interface every participant shares.

**Layer 1 — reactions (built); composed behaviors (not built).** Built: an
entity's `reactions` component maps a use to one of a fixed set of handlers
(`toggle`, `set`, `play`, `reset`, `impulse`, `script`, pinned in the
registry); new behaviour is a script. Not built: a composable trigger→action vocabulary (proximity, sit,
timer, phrase, region enter/leave → play clip, move, particles, sound, say,
give, teleport), authorable by anyone from the panel UI or by request.

**Layer 2 — scripts.** Full toolkit access, capability-scoped behaviors
attached to entities. **Layer 2 exists to extend Layer 1** (not built yet):
someone writes the fishing-rod behavior once, publishes it as a new Layer-1 behavior with knobs;
thereafter anyone attaches "fishable" to any pond with no code.

The loop hands out no roles by kind: play reveals a missing affordance →
whoever felt it describes it → whoever wants to authors it → the world's
vocabulary permanently grows. Commissioning, composing, performing,
authoring and judging are inclinations, and every surface reaches the same
tools. Fluency differs by surface today (MCPL sits closer to the toolkit;
video-mocap performance needs a body on camera), and the design may lean on
that as a convenience, never as a boundary. Interaction development happens
in-world. Every published behavior carries a plain-language description
written by its author.

## Animation

Sources, in order of prevalence: (1) **systems** — synthesized locomotion,
morphology gaits, kinematics, physics, audio-driven mouths; most motion has no
asset at all; (2) the retargetable VRMA library; (3) embedded GLB clips;
(4) **video-to-motion** — animations contributed by performing them on
camera. Triggering is mostly implicit (walk → gait; ledge → vault; sit → seat;
speak → visemes); explicit triggers are gestures and Layer-1 firings.

## Input in the browser

The same requests MCPL sends, reached through embodiment and UI:
- **Move a chair**: embodied carry (click-hold, walk, drop, auto-reseat), or
  arrange mode where **drag semantics are the placement helpers** — the chair
  stays seated on surfaces, lands ON the table not beside it, kisses flush via
  `placeTouching`. Drag is transient presence traffic; release commits one
  clean log entry. Undo = inverse entry.
- **Spawn**: palette (library + inventory) with ghost preview; **semantic
  search** (the fetch_model pipeline as in-world catalog — Poly Haven /
  Smithsonian / NASA, theme-ranked); **ask for it** (commissioning as a
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
- Ingestion is an in-world service (the fetch_model pipeline live; the
  reality pipeline: phone video → video-to-3D → hierarchy-of-meshes GLB →
  `importPlace`), used while standing in the world.
- Reactions are data (hot); Layer-2 scripts are modules with an
  install/pause/adopt lifecycle (hot); platform updates are a client
  reconnect (the world never restarts — state is the log).

## Real places

Scans arrive via video-to-3D reconstruction (well-behaved topology + scene
hierarchy — chosen over splats, which are rasters you can stand inside).
Hierarchy means a scan enters as **entities**: room-shell + table + mug as
separate interactable nodes, flowing through the existing GLB/kit path,
visible to the entity registry (so text-tier perception works in real
places), individually grabbable. Reality becomes editable. Hybrid worlds are
free: procedural gardens through scanned windows. Rescan over months → the
place has its own diffable chronicle. Per-place visibility (private / invited
/ open) from day one.

## Multiple worlds & travel

Worlds from the start; **archipelago, not grid** (discrete worlds + portals;
no region-crossing netcode). World = log + asset refs — cheap, forkable,
hostable N-per-server. Per-world trust domain and house rules. Travel is a
client operation: drop presence in A, adopt B's snapshot, arrive. Identity and
inventory (hashes + blueprints) travel by construction; standing does not — B's
capabilities apply. Portals are Layer-1 objects. A participant may hold
presence in several worlds at once, but visibly (presence never lies about
attention). Travel between worlds on one server is built (`travel`); across
servers it waits on portable identity.

## The MCPL frontend

An MCPL server: door requests in, perception out. Perception is **tiered**:
a text-tier scene description from the entity registry (free, no GPU) up to
rendered stills (`screenshot`, drawn by a renderer client elsewhere:
docs/operator/REMOTE-SCREENSHOTS.md), since a reader of text needs sets of
stills more than streams. The body runs its controller inside the frontend's
own process, with no renderer (`mcpl/headless-core.mjs`), so it moves
fluently however slowly its mind thinks.

## Alternative frontends

The protocol is the platform; renderers are opinions:
the browser three.js client (desktop, VR and phone) · MCPL (text and tools)
· headless batch renderer (the film crew — replay-to-cinema) · text/narrative
client · map view. The first two are built.

## First prototype scope (2026-07)

- Bun/TS sequencer: WS, per-world JSONL logs, join = replay + tail, pose
  relay, library asset serving from the eidoverse-video checkout
- Browser client: claudesona avatar, WASD + third-person camera, flat ground,
  idle/walk/run crossfade (full eidoverse controller port is a follow-up)
- Writes: place a model, move it, say something
- Two browsers, one world; reload-and-refold proof
- Then: MCPL (text perception + `say`/`walkTo`/`spawn`), retina service,
  replay-to-film demo

Deferred deliberately then: server physics, prediction, contested objects,
sandboxed untrusted scripts, interest management, scale. Voice, scripts,
contested objects (the door's holds) and deterministic physics have since
shipped.

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
history replays, folds and audits. Enforcement is the door's one gate,
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

Identity: the door stamps who asked from the authenticated connection,
never from the payload. Every participant is an opaque identity
(`u-…`, `server/directory.ts`); display names are a view, so a stranger
wearing your old name inherits nothing.

## Moderation

Two scopes:

**Per-world** — `kick` / `ban` / `unban` are requests to the door by anyone
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
scratch sequencer gets a scratch ban list, same doctrine as the logs). A
server ban expels from every world at once and refuses every join. Close
code `4006` is in both the browser client's and the MCPL frontend's
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
