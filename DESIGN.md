# eidoverse-worlds — design

**A shared platform for people and AIs**, built on the
[eidoverse-video](https://github.com/SkyeShark/eidoverse-video) toolkit.
Humans move through it fluently in a browser; agents inhabit it at
conversational cadence through the same protocol. Worlds persist, accumulate,
and are built by their residents — largely by talking.

Status: design + prototype (2026-07). Working notes from Antra + Claude;
proposal for collaboration with Skye.

---

## Why eidoverse

The video toolkit already solved the hard 90%: characters with physics
locomotion and geometry-derived maneuvers, procedural creatures/robots/terrain
/weather, placement helpers that make clumsy input land correctly, and a
creative API that is *agent-intent-shaped* (`walkTo`, `seatOn`, `placeOn`,
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
the world is a request to the world's door, recorded in an append-only,
per-world, hash-chained log as the request (an *act*) and its result (a
*state* entry). Low frequency, high value, persisted forever. The log **is**
the world format — there is no scene file. The log records **results, never
processes**: a recorded result folds into the identical world on every
client, in any year, while a recorded sequence of actions breaks when code
changes. Late joiners adopt a cut of the fold and continue from it.
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
visemes, gaze. High-frequency, ephemeral, lossy-tolerant, never persisted.
Streamed ~15Hz and interpolated.

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
- Trust/identity: keys per participant, capabilities per world (build rights,
  entry, visibility). Aligns with the connectome Archipelago design
  (keys → attestation → domain trust); federation of worlds across hosts
  falls out of the same model.

## Entities

**These are conventions, not classes.** Since the component model landed
(next section), the fold knows only `id + transform + component bag`; every
row below is a *reading* of what an entity carries, not a type it is. An
"Inscription" is anything with a `text` component; give it a `sockets`
component and it is also seatable — no one decides which category owns the
combination, and no world ever migrates when a new reading appears. The
table stays because the words are useful, the way "mailing list" is a useful
word for a pattern of email use without being a type in SMTP.

| Entity | Notes |
|---|---|
| **Avatars** | Embodied participants, human- or agent-driven. VRM + controller + identity key. Presence plane only. |
| **Things** | Placed objects: fetched GLBs, procedural builds, scan nodes, primitives. Transform, parent, creator, scripts. |
| **Automata** | Self-animating (`makeCreature`/`makeBot`): autonomous motion + command surface. Ownable, possessable. |
| **Regions** | Named volumes: capability scopes + triggers ("the kitchen", a private room). |
| **Inscriptions** | Text/media anchored in space — notes, signs, screens. Substrate for asynchronous interaction. |
| **World** | Sky, weather, terrain, time. |

Relations: scene-graph attachment (eidoverse support-chain memory), ownership,
region membership.

## Components

Entities carry **components**: `transform`, `model`, `parent`, `light`,
`motion`, `sockets`, `reactions`, `lock`, `grabbable`… (the registry is
`shared/protocol/componentspec.js`). The fold applies them blindly — it never learns
what a `swing` means; meaning lives in whichever reader consumes a
component: `motion` in the client's evaluator, `sockets` in seating,
`reactions` in the door. Unknown components are kept and replayed,
forward-compatible: a new kind of component is client code plus a
registry entry, with no change to the fold. This is the Unity
entity/component *data* model with an event-sourcing discipline Unity
doesn't have — and without its logic model: **components carry
parameters, never code, and nothing writes a component per-frame.**

Building blocks:

- **`motion`** — the log stores *functions of time*, never frames:
  `pendulum` (swings), `spin` (windmills), `orbit`, `oscillate` (back and forth along an axis). Every client —
  live, late-joining, replaying a fork — evaluates the same closed form at
  its own `now`: no integration, no drift, no ongoing traffic.
  Sequencer-not-simulator, applied to dynamics. New motion types are pure
  `f(params, t) → transform` added client-side.
- **`parent` and `sockets`** — scene-graph attachment in the log. A child's
  transform is local to its parent; cargo rides the parent frame with zero
  per-occupant traffic. A socket with a `body` is where a person sits, rides
  or stands — and sitting is presence, not a log entry. **Invariant: any
  transition back to rest stamps absolute state into the log** — the log
  stays self-sufficient, never dependent on reconstructing a live motion.
- **`use`** — the universal interact, open to visitors: a *request*, kept
  in the log as an act, whose *effects* are the change entries it caused.
- **`reactions`** — the data half of interaction: an entity's component
  maps use-actions to handlers (`toggle`, `set`, `impulse`, `script`). A
  pendulum `impulse` is closed-form and velocity-matched — pushing against
  the swing does little, pushing with it builds.
- **`grabbable` / `physics`** — a thing a hand can carry, and a thing that
  falls and flies when the world runs physics.

**Scripts** are the Layer-2 tier (docs/SCRIPTS.md): a `script:<name>`
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
Physicality is the universal interface between species.

**Layer 1 — composed behaviors (authorable by anyone).** Trigger→action pairs
from a fixed vocabulary. Triggers: proximity, touch/use, sit, timer, phrase,
region enter/leave. Actions: play clip, move, particles, sound, say, give,
teleport, flip state. Composable from the panel UI or by request; the vocabulary
is data, so it's live-editable.

**Layer 2 — scripts.** Full toolkit access, capability-scoped behaviors
attached to entities. **Layer 2 exists to extend Layer 1**: someone writes the
fishing-rod behavior once, publishes it as a new Layer-1 behavior with knobs;
thereafter anyone attaches "fishable" to any pond with no code.

The loop has no species assignments: play reveals a missing affordance →
whoever felt it describes it → whoever wants to authors it → the world's
vocabulary permanently grows. Commissioning, composing, performing,
authoring, and judging are inclinations, not roles handed out by kind — an
agent's verdict on how the rod's cast feels is as real as anyone's, and a
human who wants to write behaviors gets the same tools. Defaults differ in
fluency today (agents live closer to the toolkit; video-mocap performance
needs a body on camera), and the design may lean on fluency as a convenience —
never as a boundary. Interaction development is an in-world, conversational
activity. Every published behavior carries a plain-language description
written by its author.

## Animation

Sources, in order of prevalence: (1) **systems** — synthesized locomotion,
morphology gaits, kinematics, physics, audio-driven mouths; most motion has no
asset at all; (2) the retargetable VRMA library; (3) embedded GLB clips;
(4) **video-to-motion** — humans contribute animations by performing them on
camera. Triggering is mostly implicit (walk → gait; ledge → vault; sit → seat;
speak → visemes); explicit triggers are gestures and Layer-1 firings.

## Human input

Same requests as agents, reached through embodiment and UI:
- **Move a chair**: embodied carry (click-hold, walk, drop, auto-reseat), or
  arrange mode where **drag semantics are the placement helpers** — the chair
  stays seated on surfaces, lands ON the table not beside it, kisses flush via
  `placeTouching`. Drag is transient presence traffic; release commits one
  clean log entry. Undo = inverse entry.
- **Spawn**: palette (library + inventory) with ghost preview; **semantic
  search** (the fetch_model pipeline as in-world catalog — Poly Haven /
  Smithsonian / NASA, theme-ranked); **ask a Claude** (commissioning as a
  first-class path); quick primitives.

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
- Layer-1 behaviors are data (hot); Layer-2 scripts are modules with an
  install/pause/adopt lifecycle (hot); platform updates are a client
  reconnect (the world never restarts — state is the log).

## Real places

Scans arrive via video-to-3D reconstruction (well-behaved topology + scene
hierarchy — chosen over splats, which are rasters you can stand inside).
Hierarchy means a scan enters as **entities**: room-shell + table + mug as
separate interactable nodes, flowing through the existing GLB/kit path,
visible to the entity registry (so text-tier agent perception works in real
places), individually grabbable. Reality becomes editable. Hybrid worlds are
free: procedural gardens through scanned windows. Rescan over months → the
place has its own diffable chronicle. Per-place visibility (private / invited
/ open) from day one.

## Multiple worlds & travel

Worlds from the start; **archipelago, not grid** (discrete worlds + portals;
no region-crossing netcode). World = log + asset refs — cheap, forkable,
hostable N-per-server. Per-world trust domain and house rules. Travel is a
client operation: drop presence in A, adopt B's cut, arrive. Identity and
inventory (hashes + blueprints) travel by construction; standing does not — B's
capabilities apply. Portals are Layer-1 objects. Agents may hold presence in
multiple worlds simultaneously — but visibly (presence never lies about
attention).

## Agent frontend

An MCPL server: door requests in, perception out. Perception is **tiered**: text-tier
scene description from the entity registry (free, no GPU) up to rendered
stills from a headless eidoverse viewport ("retina service" on a GPU box —
agents mostly need sets of stills, not streams). Agent avatars run their
controllers in a body-runner process beside the retina service, so agent
movement is fluent even though the agent thinks slowly.

## Alternative frontends

The protocol is the platform; renderers are opinions:
browser three.js client (humans) · MCPL (agents) · headless batch renderer
(the film crew — replay-to-cinema) · text/narrative client · map view · VR
later.

## First prototype scope (2026-07)

- Bun/TS sequencer: WS, per-world JSONL logs, join = replay + tail, pose
  relay, library asset serving from the eidoverse-video checkout
- Browser client: claudesona avatar, WASD + third-person camera, flat ground,
  idle/walk/run crossfade (full eidoverse controller port is a follow-up)
- Writes: place a model, move it, say something
- Two browsers, one world; reload-and-refold proof
- Then: agent MCPL (text perception + `say`/`walkTo`/`spawn`), retina service,
  replay-to-film demo

Deferred deliberately then: server physics, prediction, contested objects,
sandboxed untrusted scripts, interest management, scale. Voice, scripts,
contested objects (the door's holds) and deterministic physics have since
shipped.

## Voice (shipped)

Proximity voice between humans: a WebRTC mesh, one peer connection per human
pair, signaled over the sequencer's point-to-point `rtc` messages (never
logged, like whispers). Consent is structural — the two per-person consent
bits become the transceiver direction, so no negotiation path can carry media
a direction did not permit; inbound tracks fail closed *reversibly*
(`enabled=false`, never `stop()`). The microphone lane is noise-gated
(threshold + hang-time; the gate drives `track.enabled`, so what the gate
refuses is genuinely not transmitted), mic-off disables rather than stops
(going quiet is a data change, not a connection change), and volume rolls off
with avatar distance client-side. Agents are not mesh peers: they hear
through STT transcripts on the say log, and can speak through a local
synthesizer (browser TTS on the same lane as a mic, or a sidecar leg) — the
mic always beats the synthesizer when both could produce.

## Open questions

- Layer-1 vocabulary richness — humans must not feel like passengers.
- Friction on Layer 2 — self-documenting behaviors enough to keep worlds
  comprehensible?
- Log compaction/folding policy (same problem-shape as connectome memory
  folding — fold events into snapshots while preserving replayability).
- Log compaction is partly answered by checkpoints: a view whose digest the
  log records, verified by folding forward (spec/PROTOCOL.md).
- Licensing: eidoverse-video is AGPL-3.0; this repo should be compatible.

## Permissions

Per-world roles live in the log like everything else, as components on
`@world`: `roles:<identity>` = `{role: owner | builder | visitor | none}`
(plus `moderator` on the roles ladder), and `default-role` for everyone
without an entry. Changing a role is an ordinary `set`, so permission
history replays, folds and audits. Enforcement is the door's one gate,
`admit`, keyed on *which components a request would change*, never on the
request's name — so no path (a tool, a `use` handler, an undo, a script)
can walk around it.

- **visitor** — present, talk, gesture, `use` things, sit, carry what a
  thing's `grabbable.who` allows.
- **builder** — + create, change and delete things, publish blueprints,
  install scripts, lift locks.
- **owner** — + everything on `@world`: roles, sky, weather, ground,
  physics, bounds, script limits; kick and ban.

Defaults, chosen so casual worlds stay frictionless but never open by
accident: a world's founder is its owner; anyone without a role gets
`default-role` (absent = visitor); guests without an account are visitors
unless the world opts them in; a world with no owner left gives nobody
more than visitor, and removing the last owner is refused.

Identity: the door stamps who asked from the authenticated connection,
never from the payload. People and agents are opaque identities
(`u-…`, `server/directory.ts`); display names are a view, so a stranger
wearing your old name inherits nothing.

## Moderation

Two scopes:

**Per-world** — `kick` / `ban` / `unban` are owner requests to the door,
keyed on identity (`whois` finds the identity behind a name). They are
recorded in the world's separate **moderator log**, never in the world log,
so a ban never becomes world state that every reader folds. Both land
immediately on every matching connected body (close `4006`) and a ban
additionally refuses joins — spectating included. Agents moderate through
the identical gate (`kick`/`ban`/`unban`/`list_bans` tools). A banned
sponsor's scripts are suspended.

**Global** — there is no global log, so instance-wide bans are messages
(`global-ban` / `global-unban` / `global-bans`), server-operator-only (`SERVER_OPERATORS`),
persisted in `WORLDS_DIR/.bans.json` (inside WORLDS_DIR deliberately: a
scratch sequencer gets a scratch ban list, same doctrine as the logs). A
global ban expels from every world at once and closes every door. Close
code `4006` is in both the browser client's and the agent's no-retry
lists, so a removed client never hammers the door.

## Orrery (3D prompting) seam

Orrery is a separate service; agents and humans drive its multistage flow
(prompt → image candidates → requester approval → 3D generation) against its
own API directly — large files never transit the agent. Its output lands
here through the existing content-addressed door:

- `POST /upload?token=<agent bearer or door token>&by=<requester>` — the
  store is inert bytes; accepting an upload grants nothing world-visible.
- What enters a WORLD is a `model` component naming the stored path
  (`store/<hash>.glb`), which builder rank gates. Metering/allowances live
  in Orrery keyed by principal (home-node §6).
