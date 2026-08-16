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
the world is an entry in an append-only, per-world event log of intent verbs:
`spawn`, `place`, `makeCreature{seed}`, `transitionTo('storm')`, `say`,
`importPlace{hash}`. Low frequency, high value, persisted forever. The log
**is** the world format — there is no scene file. Late joiners fold the log
(snapshot + tail). Deterministic seeded construction means a verb replays into
the identical world on every client.

Consequences we get for free:
- **Persistence**: a world is a log + content-addressed assets. A file.
- **Forkability**: branch the log → alternate timeline, film "take", backup.
- **Retroactive filming**: any moment that ever happened can be re-rendered
  offline at production quality by pointing the existing eidoverse batch
  renderer at a replay. The video toolkit isn't discarded — it becomes the
  camera crew. Machinima-native platform.
- **Undo**: inverse entries. History is first-class.

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
- Contested interactions (two hands, one object) get server-validated
  ownership transfer later — still not server physics.
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
| **Things** | Placed objects: fetched GLBs, procedural builds, scan nodes, primitives. Transform, parent, owner, behaviors. |
| **Automata** | Self-animating (`makeCreature`/`makeBot`): autonomous motion + command surface. Ownable, possessable. |
| **Regions** | Named volumes: capability scopes + triggers ("the kitchen", a private room). |
| **Inscriptions** | Text/media anchored in space — notes, signs, screens. Substrate for asynchronous interaction. |
| **World** | Sky, weather, terrain, time. |

Relations: scene-graph attachment (eidoverse support-chain memory), ownership,
region membership.

## Components (2026-08-02 — shipped: comp/mount/motion/use)

Entities carry a **generic component bag**: `comp {id, type, data|null}` folds
`data` under `type`, blindly, on both server and client. The server never
learns what a `swing` means; meaning lives in whichever evaluator consumes a
type — `motion` in the client's evaluator library, `sockets` in mounting,
`reactions` in the server's reaction hook. Unknown types sit in the bag,
forward-compatible: a new component kind is client code plus emitted verbs,
zero sequencer changes. This is the Unity entity/component *data* model with
an event-sourcing discipline Unity doesn't have — and without its logic model:
**components carry parameters, never code, and nothing writes a component
per-frame.** Components change only via logged verbs.

Building blocks shipped:

- **`motion`** — the log stores *functions of time*, never frames:
  `pendulum` (swings), `spin` (windmills), `orbit`, `bob`, `path` (ferries,
  patrol routes). Every client — live, late-joining, replaying a fork —
  evaluates the same closed form at its own `now`: no integration, no drift,
  no ongoing traffic. Sequencer-not-simulator, applied to dynamics. New motion
  types are pure `f(params, t) → transform` added client-side.
- **`mount` / `dismount`** — scene-graph attachment in the log. Things get
  `parent`; bodies (avatars) go in `state.mounts`. Passengers and cargo ride
  the parent frame with zero per-rider traffic. Sockets are a component
  (`sockets: {seat: {...}, helm: {...}}`), merged with Layer-0 affordances.
  **Invariant: any transition back to rest stamps absolute pose into the verb**
  (`dismount {pos, yaw}`; a stopping ferry's `motion {type:null}` + `place`) —
  the log stays self-sufficient, never dependent on reconstructing a ride.
- **`use`** — the universal interact, rank 0 and fold-less: a *cause*, kept in
  the log as history, whose *effects* are separately logged entries. Mounting
  yourself is likewise rank 0: sitting on the swing is using the world, not
  editing it.
- **`reactions`** — the first slice of the Layer-2 behavior runtime: an
  entity's component maps use-actions to effects (so far: pendulum `impulse`,
  closed-form velocity-matched — pushing against the swing does little,
  pushing with it builds). Reactions run server-side with world authority
  under the author's standing decision, emit ordinary verbs with
  `{cause, by}` provenance, and are wrapped so no reaction can ever take the
  sequencer down. Crucially, **replay never re-executes behaviors** — it folds
  the verbs they emitted. Scripts therefore get randomness and wall-clock for
  free; only the fold must stay deterministic.

**The script tier shipped 2026-08-02** (`server/behaviors.ts`, `sdk/`,
AGENTS.md surface 2): uploaded script files (`/upload?as=script`,
content-addressed) bound by `behavior` entries, each running server-side in
its own QuickJS-in-WASM sandbox — gas/memory/emit-budgeted, capability-
masked, author-rights checked at every emit, per-behavior log rings, paused
loudly after repeated errors. Triggers: `use`, `say`, `enter`, `leave`,
timers. Replay never re-executes scripts — it folds the verbs they emitted.
Still ahead: proximity/phrase/region triggers, and `publish`/`attach` to
promote an authored behavior into the world's Layer-1 vocabulary with knobs.

## Interactions: three layers

**Layer 0 — intrinsic affordances (authored by nobody).** The controller
derives affordances from geometry: vaultable, climbable, sittable (`seatOn`
raycasts real seat pans). Everything is walkable-on / grabbable / placeable by
virtue of being physical. A scanned stool is sittable the moment it arrives.
Physicality is the universal interface between species.

**Layer 1 — composed behaviors (authorable by anyone).** Trigger→action pairs
from a fixed vocabulary. Triggers: proximity, touch/use, sit, timer, phrase,
region enter/leave. Actions: play clip, move, particles, sound, say, give,
teleport, flip state. Composable from the panel UI or by verb; the vocabulary
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
speak → visemes); explicit triggers are emotes and Layer-1 firings.

## Human input

Same verbs as agents, reached through embodiment and UI:
- **Move a chair**: embodied carry (click-hold, walk, drop, auto-reseat), or
  arrange mode where **drag semantics are the placement helpers** — the chair
  stays seated on surfaces, lands ON the table not beside it, kisses flush via
  `placeTouching`. Drag is transient presence traffic; release commits one
  clean log entry. Undo = inverse entry.
- **Spawn**: palette (library + inventory) with ghost preview; **semantic
  search** (the fetch_model pipeline as in-world catalog — Poly Haven /
  Smithsonian / NASA, theme-ranked); **ask a Claude** (commissioning as a
  first-class path); quick primitives.

One verb surface, three modalities: mouse, speech, code.

## Live everything — the no-manifest rule

**Nothing about a world is declared at startup.** No world config file, no
asset manifest. Everything arrives through the log, at runtime:
- Assets are content-addressed (hash = identity = cache key, immutable,
  upload-anytime, never stale, never deleted while referenced by any log).
- The sequencer treats verbs as opaque — it never restarts for content.
- Ingestion is an in-world service (the fetch_model pipeline live; the
  reality pipeline: phone video → video-to-3D → hierarchy-of-meshes GLB →
  `importPlace`), used while standing in the world.
- Layer-1 behaviors are data (hot); Layer-2 scripts are modules with an
  attach/detach/version lifecycle (hot); platform updates are a client
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
client operation: drop presence in A, fold B's snapshot, spawn. Identity and
inventory (hashes + verbs) travel by construction; standing does not — B's
capabilities apply. Portals are Layer-1 objects. Agents may hold presence in
multiple worlds simultaneously — but visibly (presence never lies about
attention).

## Agent frontend

An MCPL server: verbs in, perception out. Perception is **tiered**: text-tier
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

## v1 prototype scope

- Bun/TS sequencer: WS, per-world JSONL logs, join = replay + tail, pose
  relay, library asset serving from the eidoverse-video checkout
- Browser client: claudesona avatar, WASD + third-person camera, flat ground,
  idle/walk/run crossfade (full eidoverse controller port is a follow-up)
- Verbs: `spawn`, `place`, `say`
- Two browsers, one world; reload-and-refold proof
- Then: agent MCPL (text perception + `say`/`walkTo`/`spawn`), retina service,
  replay-to-film demo

Deferred deliberately (v1 list): server physics, prediction, contested
objects, sandboxed untrusted scripts, interest management, scale. Voice has
since shipped — see "Voice" below.

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
- How raw may log entries be — verbs only vs. trusted JS escape hatch.
- Licensing: eidoverse-video is AGPL-3.0; this repo should be compatible.

## Permissions (2026-07-27)

Per-world roles, event-sourced through the log like everything else: an
owner-authored `grant` verb (`{id, role?: owner|builder|visitor, gen?: bool}`)
is the only way rights change, so permission history replays, folds, and
audits. Enforcement is entirely server-side (`VERB_NEEDS` in server.ts).

- **visitor** — present, talk, emote.
- **builder** — + `spawn` / `place` / `remove` / drag.
- **owner** — + world-shaping (`terrain` / `grass` / `sky` / `weather`) and `grant`.
- **gen** — orthogonal spend capability: the `asset` verb (introducing NEW
  vocabulary — where Orrery generations land). Owners always have it.

Defaults, chosen so casual worlds stay frictionless:
- A world with **no owner** is OPEN — everyone is builder+gen (the
  pre-permissions behaviour; legacy worlds are unchanged until someone owns them).
- The **first embodied joiner of a brand-new world** is auto-granted owner
  (actor `world` in the log).
- In an **owned** world, unlisted ids default to builder WITHOUT gen —
  friends can build together immediately, but spend is restricted. The
  wildcard entry changes the default: `/grant * visitor` closes the world,
  `/grant * +gen` opens generation to everyone. `*` cannot be owner.
- `WORLD_ADMIN=<ids>` (env) makes operators owner everywhere — bootstrap for
  legacy worlds and lockout recovery.

Identity, interim: ids are self-asserted names, EXCEPT names appearing in
`mcpl/tokens.json` — those are **reserved for agents**, claimable only with
the agent's own bearer (the MCPL door forwards it as `agentToken` at join;
`AGENT_TOKEN` env for direct/stdio agents). When archipelago-home lands
(connectome/docs/home-node.md), aid1 `sub`s replace names as the principal
ids in the roles map without the model changing.

## Moderation (2026-08-02)

Two scopes, following the two kinds of state this codebase has:

**Per-world** — `kick` / `ban` / `unban` are ordinary owner-rank verbs
(`{id, reason?}`), gated by the same `VERB_NEEDS` ladder as `grant`. Bans
fold into `WorldState.bans` (event-sourced: they replay, audit, and ride a
fork); a kick is an act like `use` — logged, folded to nothing. Both land
immediately on every matching connected body (`expel`: error, close `4006`,
leave broadcast) and a ban additionally refuses joins — spectating included —
at the door. Agents moderate through the identical gate: an agent that owns a
world gets `kick`/`ban`/`unban`/`list_bans` MCP tools with no extra capability
machinery. Guardrails: no self-moderation, no `*`, operators are untouchable,
and owners cannot ban each other (a `WORLD_ADMIN` can).

**Global** — there is no global log, so instance-wide bans are messages
(`global-ban` / `global-unban` / `global-bans`), `WORLD_ADMIN`-only, persisted
in `WORLDS_DIR/.bans.json` (inside WORLDS_DIR deliberately: a scratch
sequencer gets a scratch ban list, same doctrine as the logs). A global ban
expels from every world at once and closes every door.

Bans key on the durable `sub` when the target was present to be identified
(captured into the ban record at ban time), falling back to the display id —
a verified human cannot shed a ban by renaming. Unverified name-only bans
remain evadable by `/name` until archipelago-home identity is universal;
close code `4006` is in both the browser client's and WorldAgent's no-retry
lists, so a removed client never hammers the door.

## Orrery (3D prompting) seam

Orrery is a separate service; agents and humans drive its multistage flow
(prompt → image candidates → requester approval → 3D generation) against its
own API directly — large files never transit the agent. Its output lands
here through the existing content-addressed door:

- `POST /upload?token=<agent bearer or door token>&by=<requester>` — the
  store is inert bytes; accepting an upload grants nothing world-visible.
- What enters a WORLD is the `asset` verb (+`spawn`), which per-world roles
  gate: `asset` needs the gen capability. That is the whole spend-permission
  story on this side; metering/allowances live in Orrery keyed by principal
  (home-node §6).
