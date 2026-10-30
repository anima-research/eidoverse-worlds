# The eidoverse world protocol

**License: CC0 1.0 (public domain).** This document and the conformance
suite beside it (`conformance/`) may be implemented, copied, and modified
by anyone, from any codebase, under any license, without permission or
attribution. The reference implementation in this repository is separately
licensed (AGPL); *the contract is free*. SMTP being free is what made the
mail ecosystem exist.

Which files are the contract, and the status of each choice it makes (decided, trial, open), is in
`spec/NORMATIVE.md`. Code this document names is informative: a place to look, never the contract.

Status: normative for logs whose genesis says `dialect: "eidoverse-log", v: 4,
minor: 0` (the version history is at the end).
**Alpha.** This whole protocol is in a trial period of about a year from v1.
There is **no guarantee** that a log folded today will fold the same way under
a later version: not a component's shape, not a field or message name, and not
§1–§3 either. Hardening a protocol around early design decisions is the
mistake this period exists to avoid. What we promise instead is care: we try
not to break things, every change is recorded (`REGISTRY-CHANGELOG.md` beside
this document, and the version history at the end), and where a change would
break stored logs we ship a **log translator** or a recorded shape repair (a
maintenance command, §4) with it, so
that existing worlds move forward rather than strand. Translators are the
migration path for the trial period. Every registered component is `trial`
until it is promised. Implementations SHOULD NOT add anything they are not
reasonably sure will survive; adding later is cheap, removing is not.

The words MUST/SHOULD/MAY are used in the RFC-2119 sense. Where this
document and the reference implementation disagree, one of them has a bug —
file it. The reference fold is `shared/protocol/fold.js`; a second reader, written
in Python from this document alone, is `conformance/reader.py`, and the
two agree on every conformance log (§11).

## 0. The one idea

**A world is its log.** There is no scene file. The log is an append-only,
totally ordered list of entries; folding its `change` entries from the
beginning yields the world, on every implementation, at any time, forever.
Everything else — checkpoints, the scene a client draws, history panels,
who made what — is a **view**: derived, disposable, rebuildable from the
log.

The rules below exist so that a reader written in any language, in any
year, gets the same world from the same log:

1. **Few operations, a strict and total reader.** A world is entities with
   components, changed by four operations (§3). A reader that meets
   anything malformed shapes nothing with it and says so; it never guesses.
2. **Each fact once, as a plain value.** Values are JSON data independent
   of any engine. Nothing derived is stored beside the fact it derives from.
3. **Nothing changes without a cause on record, and one writer at a time.**
   Every change entry names the entry that caused it; the world has one
   sequencer, whose signed hash chain lets readers verify it (§12).
4. **Requests are open; results are closed.** Anyone may invent a request
   word or a namespaced component; nobody adds a fold operation — a new
   feature is a new component (§4, §10).
5. **A name never changes meaning** (§4).
6. **Presence is not the log** (§5).
7. **One gate** checks every result before it is written (§7).

## 1. The log

**Framing.** A log is UTF-8 JSONL: every LF-terminated line is one entry,
and its 0-based position is its `seq`. A blank or malformed line is still an
entry: it takes its seq and shapes nothing. A CR before the LF is tolerated
(JSON whitespace); a byte-order mark is malformed. Caps: 1 MiB per line,
nesting depth 64.

**Strict JSON.** Every line MUST be I-JSON (RFC 7493) in full — valid UTF-8,
no duplicate keys, no lone surrogates or noncharacters in strings, finite
binary64 numbers — plus two stricter rules: no `-0` (including a value that
underflows to it), and no integer lexeme that is not exactly representable
as a binary64 (`9007199254740993` is malformed; `100000000000000000000`,
exactly 1e20, is fine). A reader MUST NOT key ids, names or value keys
through a host language's object prototype (a JavaScript reader uses `Map`
or null-prototype objects, and a tokenizer that sees duplicate keys, since
`JSON.parse` hides them).

**The envelope.** An entry is an object with exactly these fields:

| field | |
|---|---|
| `world` | the world id (§2); required on every entry after genesis |
| `kind` | `genesis` · `change` · `act` · `sim` · `say` · `purge` · `sequencer` |
| `ts` | the authority's admission time, integer milliseconds ≥ 0; required after genesis, never decreasing along the log |
| `actor` | who: an identity, `system`, `sim`, `world` or `script:<entity>` (§6) |
| `cause` | the seq of the entry that caused this one, `0 ≤ cause < seq`; required on `change` |
| `verb` | a string: for `change`, one of the four operations (§3) |
| `body` | an object |
| `head`, `sig` | the sequencer's chain fields, on chain points (§12) |
| `for`, `grant` | reserved for acting on someone's behalf; until identities have keys, an entry carrying `for` is malformed (`grant` is reserved and not yet checked) |
| `by` | legacy (the lab's name for `actor`): allowed, and every reader MUST ignore it. Writers MUST NOT write it |

An unknown field, a `seq` field, a missing or non-string `kind`/`actor`/
`verb`, a non-object `body`, a bad `cause`, or a missing, fractional or
decreasing `ts` makes the entry malformed: it shapes nothing and the reader
reports it in diagnostics, never in the world.

**The kinds.**

- **`genesis`** — entry 0, and only entry 0 (§13).
- **`change`** — the fold's only input (§3).
- **`act`** — a request as it was sent. A refused one keeps only its verb
  (the entry's own `verb`), the names of the arguments that verb takes, and
  its refusal code (§7): never a value. Acts are history: the fold never
  reads them. A change entry's `cause` is usually the act that asked for it.
- **`sim`** — a physics intent (a launch, a lift, a catch, the engine's
  digest); read only by readers that carry the world's engine
  (`PHYSICS.md`).
- **`say`** — chat: `body {text, to?, spoken?, utt?, t0?}`. Never world state.
  The spoken trio (`spoken: true`, an utterance counter `utt`, a start `t0`
  the authority clamps) is display metadata: the words were voice-performed
  and already shown as captions. Any participant may mark a say this way
  (whoever voices the words: a TTS voice someone chose, a program's voice leg); nothing
  gates it on what a participant is, and it says how the words were
  performed, never who performed them (§6a). Every say is kept in the log;
  who may read one back is the authority's practice, not the record's
  (arrival-only speech, §5).
- **`purge`** — the one rule that changes the record (§12).
- **`sequencer`** — governance: handing the writer role on, or an owner
  override (§13).

**Where the authority reads old acts (readback).** The fold never reads an
act, but the *authority* reads a few act fields back for meaning: an undo's
`undoes` and a rollback's `acts` (the undo chain), a `use`'s `capability`
(whose rights admitted its writes), a script act's `sponsor`, a sculpt's
`request.brush` and `clamped`, a request's `label`, the request that typed a
physics-engine `engine` (whether the owner typed a version: a deploy restamps only a
version the server stamped), a launch's, lift's or catch's `id`, and a
founding's `shapes` or a translation's `from.translator` (the shape repair's
older markers, §4). The full
list, with what each reader does, is pinned in `spec/readback.json` (each
row's fields and what an unknown means; the reference keeps it as `READBACK`
in shared/protocol/verbclasses.js, a pointer, not the contract). A new readback
is a new row; a changed or removed one needs an acknowledged re-pin.
§12 lets the whole body of an act be purged, so every one of these reads
treats a purged body as **unknown**, never as a default: an unknown chooser
of an engine version is the owner's (no restamp), unknown rights match nobody,
an unknown undo names no target, an unknown flight may still be in the air,
and an unknown marker counts as marked (the shape repair never re-runs).

## 2. Folded state

The fold yields a **status** (`ok`, `no-world`, or `unknown-version`), a
**world id**, a map of **entities**, and **diagnostics**.

- An entity is an id and a map of **components**: name → value. A value is
  any JSON value (`null` included), or the defined marker *absent(purged)*
  (§12).
- `@world` is live from genesis and can never be deleted. Its components
  are the world's own settings: sky, terrain, roles, bounds, spawn…
- The **world id** is `sha256:` + hex(sha256(UTF-8(JCS(genesis entry)))),
  JCS being RFC 8785. It never names a host. Every later entry carries it in
  `world`; a mismatch is reported in diagnostics.
- The **digest** of a folded world is the lowercase hex
  sha256(UTF-8(JCS(view))), where `view` is `{<live id>: {<component>:
  {"v": value} | {"purged": true}}}` over every live entity, empty ones and
  `@world` included. Wrapping values in `{"v": …}` keeps `purged` out of the
  value space. Two readers agree on a world exactly when they agree on its
  digest.

Readers MAY start from a **checkpoint** — a folded view whose digest the
log records — and verify it by folding forward; the digest is never itself
folded. A checkpoint that readers may *trust* rather than merely start from
will be a governance entry (`kind: "sequencer"`, §13) carrying a
`checkpoint` field, signed like any governance entry. **The name is
reserved and its shape is not specified**: no sequencer writes one, and a
reader refuses a governance body that carries it (`gov.py`: "checkpoint is
reserved") until this section names the shape, the way `joint` is held in
the registry (§4). Until then a replica folds forward from an entry it
trusts, and a world ten years old is verifiable only from entry 0.

## 3. State operations and their fold semantics (normative)

A `change` entry's `verb` and `body` are one of:

| verb | body | fold |
|---|---|---|
| `create` | `{id}` | a new, empty entity; does nothing if `id` is live |
| `set` | `{id, comp, value?, salt?}` | replace that one component's value; does nothing if the entity is missing, or if `value` is **absent** (`null` is a value) |
| `delete` | `{id, comp?}` | with `comp`: remove that component (nothing if it isn't there); without: remove the entity (never `@world`) |
| `batch` | `{ops: [{verb, id, comp?, value?, salt?}, …], followUps?: [i, …]}` | the ops above, applied in order |

- A batch never contains a batch.
- **`followUps`**, when present, names the ops the authority derived as
  consequences of the asker's own (a deletion's reference clears and the
  set-down of what rested on the deleted thing, §4; an undo putting clears
  back): a **non-empty, strictly ascending list of integer indices into
  `ops`**, each `0 ≤ i < ops.length`. Anything else (empty, out of order, a
  repeat, out of range, a fraction, a non-number) makes the **whole entry**
  malformed (`batch-followups`). The invariant: these ops were admitted
  **without the asker's rights or locks** (§7); the fold applies them like
  any op, so it never needs the field to fold; readers that derive
  **authorship** from the log — who set up a handler, who created or last
  set a component, who sponsors a script (§7, §8) — skip a marked op, and a
  marked `set` that puts a value back (an undo's restore) also steps over
  the marked `delete` it reverses, so the restored value keeps its author
  (a key written by anyone else in between is a new life, never merged with
  the old). A verifier re-running the gate re-runs it on the **unmarked ops
  only**. A tool that rewrites a batch's `ops` remaps `followUps` with
  them. (This field was added to the batch body before this protocol's
  release, at minor 0: see §10.)
- A shape or grammar error anywhere in an entry (an unknown field, a bad id
  or component name, a nested batch) makes the **whole entry** malformed. A
  semantic no-op (a missing entity, an absent component) skips only that
  op, with a diagnostic.
- The fold reads only the entry: never a blob's bytes, never anything
  outside the log. Blobs appear only as values (a model's path, a script
  source's hash). A blueprint copy is expanded by the authority into an explicit
  batch.
- A deleted id may be created again by the fold, and starts empty. (The
  reference authority refuses to re-create an id that existed before, so a
  reborn id can't inherit references or a sponsorship.)
- "All or nothing" is the authority's promise about what it writes; it is not a
  fold rule.

### 3.1 Names and ids

All ASCII.

- **Entity ids**: `[a-z0-9-]{1,64}`, opaque and minted, plus the reserved
  `@world`. An id is **world-scoped**: a thing's global name is the pair
  `(world id, entity id)`, written `<world id>#<entity id>`, and no protocol
  feature may assume an id is unique outside its world (a fork copies its
  parent's ids). A minted id SHOULD carry at least 128 random bits (the
  reference authority writes 26 base32 characters; a script's create mints
  32 hex characters of its activation's seed, so an auditor's re-run mints
  the same id), so two
  forks rarely mint alike; that makes renames on merge rare, never
  unnecessary. An entity id never has an identity's shape (`u-` and 20 base32
  letters). **An id is opaque and immutable; a thing's name is its `label`.**
  A minted id carries no word: a word goes stale (a `health-potion-…` that
  becomes a plant would say health potion forever), and an id never changes.
  Ids minted with a readable prefix before stay valid as they are. Writers
  never choose ids (§7, "Ids are the authority's").
- **Identities** (actors, and keys such as `roles:<identity>`):
  `[a-z0-9-]{1,64}`, opaque. The mapping from an identity to a person lives
  outside the log, so purging a person never needs the log's skeleton. An
  identity's shape MUST NOT encode what holds it (§6a rule 2).
- **Component names**: `[a-z][a-z0-9-]*`, optionally prefixed by a domain
  (`example.org/`), optionally versioned `@<n>` (`light@2`), optionally
  keyed `:<key>` with a key of `[a-z0-9-]{1,64}` (`roles:u-abc`,
  `script:bell`).
- `body:<identity>` names a body (§5). It may be the target of an act or a
  say, but it is never an entity: a change op on it is malformed.

## 4. Components

Components are how a world grows: **a new feature is a new component,
never a new operation**. The fold applies every component blindly; meaning
lives in whatever reads it — a renderer, the authority's checks, a script.

- **Bare names are the protocol's registry.** An authority refuses an unregistered bare name
  (a typo of a registered one with a "did you mean"). The registered components,
  their fields, types, defaults, units and what each field means are pinned in
  `registry-pin.json` beside this document (the field's `docs` and `units`): that pin
  is a component's meaning, and an authority answers `schema {component?}` with the same. Among them: `transform
  {pos, q, scale}`, `model` (a library path, stored as written; `model-hash`
  `sha256:<64 hex>` beside it when the server knows the bytes), `label`, `description`, `parent {to}`,
  `pivot {pos}`, `light`, `mesh`, `motion` (a whole thing's; `motion:<slot> {node, …}` moves one node of its model: `node` is the node's name as the model file spells it, any characters, DATA and never part of a key; `<slot>` is a short local tag, and readers find the part by `node`), `socket {name, part?, accepts?, radius?}` (an attach point: a
  child entity of the thing it is on, carrying `parent {to: <host>}`), `station {action, anim, anchor,
  exit?, leaveBy?, who?}` (what a person's body does at that socket, on the same entity; `anim`, like
  `grabbable.anim`, is an open name of a pose (one frame, only the bones it names) or a clip (more than one key):
  a name the body doesn't know plays its default, never a refusal; `sockets`, the old
  map spelling, is reserved and lift-only: the authority lifts it into socket children with their stations
  on write, and the maintenance command's `lift-sockets` step does the same for a stored world (never the load), and a socket's old `body` block into its station),
  `params`, `reactions`, `lock`, `hidden`, `disabled`, `clickthrough`,
  `collider {shape, enabled?, blocks?, layer?, mask?}` (mesh, box or sphere; absent, its size decides), `places` (named places to walk to, in the
  thing's own frame; on `@world`, world coordinates),
  `openable`, `physics`, `grabbable`, `particles`, `script:<name>`, `zone`, `water` (a body),
  `water-exclusion`, `physics-area`,
  `physics-joint:<name>` (the constraint between two bodies) and `joint` (a skeleton node), both
  reserved, and on
  `@world`: `about`, `bounds`, `spawn`, `roles:<identity>`, `default-role`,
  `sky`, `terrain`, `water`, `terrain-grid` (reserved), `terrain-tile:<i>-<j>` (reserved), `grass`, `physics-engine`, `surface:<name>` (reserved),
  `script-settings`, `blueprints:<hash>`, `assets:<key>`, `capacity`, `schemas:<name>` (reserved).
- **A mesh is a body without a model.** `mesh {shape, size}` draws a
  parametric body (box, sphere, cylinder, plane, capsule) on a thing that has
  no model; the authority reads its size as it reads a measured model's, so
  the thing can be placed, stacked on and given a physics shape. A mesh never
  shares a thing with a model or a light (one place per thing).
- **Water is its own component.** `@world`'s `water {level, color?, opacity?,
  kind?, flow?}` (trial; split from `terrain`, as every engine separates
  water from ground) is one surface height for the world, metres in world y:
  ground below it is under water. No `water`, the world is dry; absent fields
  read as colour `0x1d5a6e`, opacity 0.82, a kind decided from the ground it
  fills (shared/waterkind.js: still, river or ocean) and no current (`flow`
  is `[x, z]` m/s). The authority's ground (shared/protocol/authority/spatial.js),
  the client's drawing and ground panel and the agent read it through
  shared/terrainshape.js (`worldWater`, `waterParams`), and the mover's water
  law (shared/mover.js `waterStance`: wading, swimming, the haul-out) takes its
  level. A write of `terrain.water` is refused with where it went; a stored one
  is moved by the maintenance command's repair (below; a load never writes), and
  the readers read it until then.
- **A water body is a thing.** `water` on a thing (the same fields, `level` in
  its own frame, absent = its zone's top; `flow` may be `[x, y, z]`) fills its
  sibling `zone {shape, size, priority?, blend?, weight?, global?}` (trial; after
  OMI_physics_shape, Godot Area3D and Unity Volume; water reads a box zone for
  now). `water-exclusion {bodies?}` on a thing with a zone is a dry pocket (after
  Unreal's Water Body Exclusion Volume). Water on a thing needs a sibling zone
  {shape, size}; world-wide water goes on `@world` (a global zone with water is
  refused). The combine law: the highest-priority body containing a point decides
  the medium, `@world`'s level lowest of all, a tie by entity id (the later
  wins); a pocket keeps out every body at or below its priority, `@world`'s level
  included; `blend` and `weight` are look only; a body inherits nothing from
  `@world`'s water. shared/zone.js (`zonesOf`, `mediumOf`) is the one reader:
  `{medium, level, flow, body, priority}` at a point. glTF has no water: the
  medium does not survive export. For now `water` and `water-exclusion` read
  a box zone only: a sphere, capsule or cylinder zone under either is refused
  with that fix (a zone of any shape is taken alone).
- **Collision off is `collider {enabled: false}`**, an axis apart from how a
  thing moves (Godot CollisionShape3D.disabled, Unity Collider.enabled, Roblox
  CanCollide): nothing stands on it or bumps into it (walkers, agents, the
  authority's track and index, the engine), and it still moves as its `physics`
  and `motion` say. `physics.kind: none` means not simulated, and is still
  solid. `enabled: false` with `physics.kind: dynamic` is refused (it would fall
  forever). shared/protocol/simlayer.js `solidOff` is the one reading.
- **Collision layers are `collider {blocks: [...], layer?, mask?}`**. `blocks` names the kinds of
  mover it stops, of `bodies` (people and agents walking or swimming: the walkers, the authority's track and index),
  `hulls` (driven vehicles: the authority's hull sweep) and `things` (loose things: the engine). Absent, it stops all
  three, as before. `hidden` with `blocks: ['hulls']` is an invisible wall every vehicle meets. A dynamic thing must
  block `things`. `layer` and `mask` are Godot's (CollisionObject3D `collision_layer`, the layers it is in, and
  `collision_mask`, the layers it scans; each a list of numbers 1..32 or names, absent `[1]`), with Godot's rule for
  a mover (`collides_with`: "Object A can detect a contact with object B only if object B is in any of the layers
  that object A scans"): a mover meets a collider when the collider's `blocks` names the mover's kind **and** the
  mover's mask holds one of the collider's layers. A hull's mask is its own collider's; bodies and engine things scan
  `[1]` (eidosim carries no layers between things), so a collider whose layer leaves out 1 is met by hulls alone, and
  only by those that scan it; a dynamic thing must keep 1 in its layer. A still collider's mask is unread. Every
  stored world (no layer, no mask) collides as before. `solidOff(c, kind, mask)` is the one reading.
- **A physics area is `physics-area {kind, factor?}`** on a thing with a box or global `zone` (Godot Area3D's
  overrides, Unreal's Physics Volume): with `kind: speed`, a body inside moves at `factor` × its own speed (walking,
  running, wading, the stroke, the 3D swim; 0.05..10, absent 1). Where areas overlap the zone's priority decides.
  The authority's track widens inside a boost and never narrows: a slow area is the honest client's and agent's
  pace, not a rule the authority holds a modified client to (falls and jumps aren't slowed, so a narrower 3D
  track would refuse an honest landing in mud). shared/zone.js `physicsAreasOf`/`speedFactorAt`
  is the one reader; shared/mover.js `stepWalk` (env.speedAt) and `stepSwim` (water.factor) apply it. Other kinds
  (direction, point, vortex) are planned, not open.
- **A climb route is a thing**: `climb {points (2–16, its own frame), reach?,
  speed?, face?, ends?}`, straight lines between its points (Godot Path3D +
  PathFollow3D); its name is its `label`. A climber's presence is `{host,
  progress}` (metres along the route, PathFollow3D.progress), resolved through
  the host's live pose by every receiver, never a world pose. Absent `face`, a
  climber faces along the route's run, and a route straight up faces the
  host's +z. shared/climb.js is the one reader.
- **Drive** (shared/drive.js; the lease in shared/protocol/authority/drive.js): the hull carries `drive {maxSpeed m/s,
  turnRate rad/s, climbRate? m/s, response? s, throttle?}` (OMI_vehicle_body's `maxSpeed` and `useThrottle`; the rest
  ours), forward its +Z; its helm is a socket child with `station {action: 'drive', input: {move: 'drive'}}` (input lives
  on the seat only; one helm per hull, on a hull with drive). Taking the helm (`use … drive`; `station.who` and the lock
  gate it) leases the hull to its occupant (Roblox network ownership): their client steps it kinematically and sends
  `drive {id, pos, q}` (presence, relayed only from the helm); the authority checks each step against the spec (with
  slack: a fraction over its rates and a fixed allowance that only what a step leaves of its rates unused refills, so a stream gains no speed it can keep) and the hull's own collider, swept over the step, against what's solid (an overlap it starts in may only lessen),
  answering a refusal with the pose that stands. Only the last accepted pose is written, as the system's act
  `drive-commit {id, driver, carried, why}` (`carried`: the passengers' ids): on getting up, every 5 s, when a passenger
  gets up (`alight`) and when the steps stop for 3 s (the lease is lost: passengers stay seated, the helm frees). Sitting
  is consent to ride (Roblox VehicleSeat, VRChat stations): a passenger may get up or leave at any time, never blocked by
  the hull's motion. A passenger can't take a held helm.
- **Arrivals and falling out** (shared/spawn.js): `@world.spawn` gains `yaw`;
  `spawn-point {title?, team?, group?}` on a thing is another arrival place
  (OMI_spawn_point), facing its rotation. The arrival taken: `@world.spawn` when
  declared, else the first spawn-point by id among those of the team or group
  asked for; a visitor may arrive at any of them. A body below the kill line,
  `KILL_MARGIN` (50 m) under `@world.bounds.min.y`, has fallen out (Unreal's
  KillZ; the floor itself is the terrain's, so water and ground may lie under
  `@world.bounds.min.y`): its own client sends it back with `move {teleport:
  true, reason: 'below-bounds'}`, an act on the record; the authority takes it
  only when it last knew the body below the kill line (one step's slack,
  `TRACK.cap`); a seated or climbing body is exempt. A person's client judges
  a body knocked down only once they get up.
  An agent, which may never press get-up, judges it as it falls and lies: a body
  its sim lays down by its hips, not by its root, which the sim keeps the rig's hip
  height below them, and any other body by its root. A body sent back from a fall
  arrives standing; only a pose it authored stays.
- **The look**: `@world.sky.gradient {top, horizon, bottom?}` (linear colours;
  OMI_environment_sky, absent bottom = horizon) paints the sky; `rate: 0`
  already pins its clock. A `light {kind: 'directional'}` thing is a sun
  (KHR_lights_punctual), shining along its −Z; the first by id lights the
  world. A floor is the ground: `@world.terrain {kind: 'flat', height}` (m),
  level everywhere and nothing else; absent terrain is flat at y 0.
- **Anyone else's components carry a namespace**, `<namespace>/<name>`: a
  domain they control or a handle (`example.org/heart`, `mica/heart`), so two
  honest clients can't both invent `light`. The mark is the `/` itself: the
  registry never uses it, the way HTML's own elements never contain the
  hyphen that custom elements must. Namespaced names are kept, replayed and
  shown honestly; they wait for a reader that understands them. A translated
  world's own inventions come across under its name (`commons/heart`).
- **Promotion keeps an alias.** A namespaced component that proves itself is
  registered bare by a change to the registry, which lists the namespaced
  spelling in the definition's `aliases`: both spellings then mean that one
  definition, are checked the same way, and old values keep working.
- **A changed meaning is a new name**, `<name>@<n>` (e.g. a hypothetical
  `light@2`), registered before anyone writes it, whose definition says what it `supersedes`. Old
  names are read forever. No component may change how another is read.
- **Every registered name has a status.** `trial`: admitted, but its shape
  may change during the alpha (above), with stored values repaired or
  translated where they can be; `reserved`: the name is held and every write
  of it is refused (one refusal, code `reserved`); `stable`: promised, it only
  grows by additions. `schema` reports each one. None is stable at v1. A
  draft (a namespaced name, below) has no status: it isn't admitted.
- **The kernel is `trial-kernel`.** Below the registry sits what every reader
  agrees on before a component is read: the log envelope and its kinds (§1),
  the fold's four operations and the batch body (§3), the identity grammar
  (§3.1), the version (`{dialect, v}`, the minors, genesis's fields, §13), and
  the two components every reader rests on, `roles` and `access` (§7), each
  as its field shape only (their ranges, enums and meanings are the
  registry's). The kernel is what the fold reads: `transform`, `parent` and
  `model` are ordinary trial components. The roles ladder's vocabulary (the ranks, the built-in
  roles, the closed permission list, a custom role's id, the reserved ids) is
  the registry's, not the kernel's: a change to it is a trial break that needs
  an acknowledgement, never a silent one. Nothing is `stable`
  during the alpha, by design: the kernel is the part that is hardest to
  change, not a part that cannot. Like trial they may still change during the
  alpha, but never by an acknowledgement alone. Their shapes are pinned in `spec/kernel-pin.json`
  (shared/protocol/kernelspec.js), and the gate's core lane
  (tools/protocol/kernel-check.ts) is red the moment the code's kernel differs
  from the pin. A re-pin is refused unless the **same change** carries (a) a
  translator change (translate-v1's name moved, or a new translate step), (b) a
  `REGISTRY-CHANGELOG.md` line prefixed `kernel:`, and (c) vectors under
  `spec/kernel-vectors/` that the old reader (snapshotted from git at re-pin
  time) refuses and the new reader folds clean; the pin records the three and
  the gate verifies them at every run, so none can be dropped afterwards. One
  exception, named: a **scope extension** — a registered name entering the
  kernel with exactly the shape `spec/registry-pin.json` already pinned for it
  — changes what no stored
  byte means, so no translator and no vectors can exist for it; it re-pins on
  the changelog line alone, the pin records the names, and from then on their
  shapes are the kernel's.
- **A load never writes to the log; stored values are rewritten only by one
  explicit maintenance command.** Three rewrites exist, each the system's own
  recorded act: `lift-sockets` (a world stored before sockets were entities:
  its `sockets` maps and body blocks become socket children with stations),
  `rename-components` (names and fields renamed before release, below) and
  `repair-shapes` (the shape audit's one-way repair, below). None runs at load
  or on read. One write does happen when a server OPENS a world, and it is
  not a shape rewrite: holds left from before a restart are set down
  (`return-held`, the system's act; `settleOrphans`), presence repair for
  bodies that are no longer here — the same act a leave writes, never a
  stored value changed. A stored world keeps its old values as they are; the load says
  which steps it needs, naming the command, and **fails closed** where
  today's readers don't serve the old shape: a world needing `lift-sockets`
  (no reader serves an un-lifted seat), a grabbable rename (`shared/grab.js`
  reads `anim` and `grasp` only), a picture's or a sound's `alt` or `look`
  (`shared/picture.js` and `shared/sound.js` read `description` only) or
  `repair-shapes` (a sky's azimuth in
  degrees would read as radians) loads and reads, but refuses every write
  (not `leave`) with the registered code `repair-needed`, whose text names
  the command. Renames whose old spelling the readers serve (`@world`
  `trusted`, a motion's old type word, a station's `pose`) leave the world writable.
  The maintenance command (its operation: docs/MAINTENANCE.md) runs the three
  steps in that order, each its own act carrying
  `command: "repair"` and `by` (who asked; `operator: true` from the wire):
  `lift-sockets {id, made, moved, capability?}`, `rename-components
  {renamed, failed?}`, `repair-shapes {v, ids, failed?}`
  (shared/protocol/shaperepair.js: `repairComps` for each thing, `repairWorld`
  for `@world`'s look; the authority's `maintain`). `--dry-run` reports all
  three and writes nothing. **Rollback:** the command keeps the pre-repair
  log beside the world (`repair-backups/<stamp>/world.jsonl`, with a manifest
  of its size and sha256) and `repair <name> --rollback` puts it back
  byte-identical, refusing when the log has grown since (`--force` overrides).
  A v1 world translated today needs no step: the translate command runs the
  same maintenance on its output (its `lift-sockets` act says `by:
  "translate"`; §14).
  The repair runs **once per world**: the system's `repair-shapes` act is the world's
  marker, read by verb and actor only (they survive a purge), and a world
  founded or translated today gets one beside its founding or its `translated`
  act (`ids: []`, with `founding: true` or `translated: true`). Worlds from
  before that act carry an older marker, a founding stamped `shapes` or a
  `translated` act by translate-v1@12 or later. Those are read back (§1), and
  a purged one counts as marked: a one-way rewrite is never re-run on values
  that may already be in today's spelling (`shapesMarked`, a pure view over
  the log, so every replica agrees). The
  rules that read an absent field (a pendulum's swing point, physics kind,
  a light's decay and daytime, the sky's and terrain's defaults) therefore
  only ever see values stored before the marker, never a write made since:
  a pendulum set today without a pivot keeps none, and a deleted pivot
  stays deleted. The act is written even when nothing needs repair. Each
  thing is admitted on its own: a thing the door refuses keeps its old
  spelling and is named in the act's `failed`; the rest repair. A purged
  value is left alone. The shape audit repairs: a bare motion
  naming a part → `motion:<slot> {node: <part>}` (the slot is `partSlot`
  of the name, shared/protocol/names.js: the name itself when it is a tag,
  else a sanitized form with 8 hex of its sha256), a keyed motion without
  `node` → its key's tag as `node`, `amplitude` → `amp`, letter axes →
  vectors, the old pendulum readings written down (period 3.5 s, damp 0, maxAmp 1.1, a
  whole pendulum's `[0, 2, 0]` swing point as its `pivot`), a motion's
  `pivot` → the `pivot` component; `collider` exact → mesh; `physics` with no
  kind → dynamic, `material` → `surface`, layers/mask/ccd dropped; `light`
  with no decay → 1.7 (the old rig's falloff; a new light's default is 2),
  `day` → `daytime`, `shadows` dropped; a `model` stored as
  `eido:sha256/<hex>` (translate-v1@8–@11) → the library path this host's
  index names for it, with `model-hash` `sha256:<hex>` beside it (an address
  no file here names stays, and still loads); `sky` clock 'real' and dormantRated → `tz` (hours, rate and ts
  kept as the fallback clock), azimuth degrees → radians, `weatherSeconds` →
  `transition`, a forecast's `dwellSec`/`transitionSec` → `dwell`/`transition`,
  sun/fill/world dropped, the registry's seven defaults written; `terrain`
  layer colours `"#rrggbb"` → ints, the sim's defaults written,
  `terrain.water` → `water`; `grass` in the flora spelling (a preset keeps
  its name). The translator (`translate-v1@34`, §14) writes its
  projection through the same functions, so a translated world needs no
  repair, and the old-world oracle mirrors the repair with them; the sweep's
  declared projection and the oracle's core check are written independently,
  a second hand on the same rules. Because the repair runs once, every
  stored sky's azimuth is converted from degrees exactly once (a turn
  beyond a full one first wraps: 400° is 40°), and a `weatherSeconds`
  today's range can't hold (0, or above 600 s) is dropped.
- **A pure rename is the command's second step, idempotent.** A component or field renamed before
  release (shared/protocol/shaperepair.js `RENAMED_COMPONENTS`: `@world`
  `trusted` → `trusted-components`; `RENAMED_FIELDS`: `grabbable.pose` and
  `station.pose` → `anim`, a grip's `fingers` → `grasp`; a field's VALUE: a
  motion's `type` `bob` → `oscillate`, on `motion` and every `motion:<slot>`)
  is not marker-gated,
  unlike the once-per-world repair above: a rename means the same whenever it
  runs, so the command renames whatever it finds, as the system's
  `rename-components {renamed, failed?, why}` act and its change, and writes nothing
  when there is nothing to rename. A value already under the new name wins
  (the old one is deleted), an old field stored as null is removed, and each
  thing is admitted per thing, as the repair is: a thing the door refuses
  keeps its old spelling and is named in the act's `failed` (written only
  when something else renamed). The door takes a write in the old spelling
  and stores it in the new.
- **Every parameter is written down.** The authority writes a component's
  defaults into the stored value when it is created or set, so a reader never
  supplies a value the log doesn't hold, and a later change to a default
  never changes an old world. A parameter's meaning (its units, what it
  does) never changes; a new meaning is a new versioned name.
- **A stamped field is the authority's.** A definition's `stamped` lists the
  fields only the authority writes (a dotted path reaches inside a value):
  `sky.ts`, `sky.override` and `sky.forecast.epoch`. A `set` carrying one is
  refused `stamped`, naming the act that owns it: the `sky` act stamps `ts`
  and a forecast's epoch, the `weather` act an override. A sky set by hand is
  stamped like the sky act's (`ts` is the authority's clock when it lands).
- **Absence means absent.** A reader that gives absence a meaning is naming
  a default, and that default belongs in the component's definition.
- **A field added later states its meaning of absence.** A value stored
  before a field existed never holds it, and nothing rewrites the past, so a
  field added to a registered component after its first registration says
  in its definition what an older value *without* it means (`absentMeans`).
  That meaning is the behaviour before the field existed, and it is frozen
  by the pin like a default: `registry-pin.json` refuses to re-pin a new
  field with no stated meaning of absence, or one whose meaning changed. A
  field is therefore safe to add later only if today's behaviour is
  acceptable forever as the meaning of its absence; when it isn't, the name
  must be decided now (spec/PHYSICS.md §3.2 decides the physical ones).
- **Meaning travels with the world.** Two things keep an old world's
  meaning fixed, and neither needs a hash in the world: every parameter is in
  the stored value (above), and the registry's checkable meaning — each
  field's type, each default and when it applies, each enum's members — is
  pinned in `registry-pin.json` beside this document, with each field's
  meaning of absence where one is stated and each field's grammar where one
  narrows its type (`physics.shape`), and each name's status, ranges and
  required fields; the conformance suite fails when one is removed, changed or
  narrowed. Genesis records no registry version, so an old world's trial
  values are read under the registry of the server reading it: what a trial
  name means is promised only as far as its pin and changelog say. Additions re-pin freely. During the alpha a trial or reserved
  name's break re-pins only with an acknowledgement, recorded with its reason
  in `REGISTRY-CHANGELOG.md`; a stable name's never re-pins. The name
  `schemas:<name>` on `@world` is **reserved** for a definition's content hash
  (the prose the pin can't check, for a world that travels to readers who don't
  share this registry); it isn't written yet, since no format for a written
  definition exists. A world is read by this registry and its pin.
- **Held kinds and closed grammars are in the pin too.** `reservedKinds`
  holds a kind inside a trial component (`reactions`' handler `impulse`,
  `terrain`'s `raster`): a write naming it is refused `reserved` in the held
  kind's own words, and a fork or a lift carries a stored one. `reservedShape`
  holds what a reserved field will mean when it opens (`physics`' damping
  units, friction and restitution limits, the combine enums: spec/PHYSICS.md
  §3.2). `nestedEnums` closes a vocabulary inside a nested grammar, keyed by
  its path (`structure`'s `levels[].apertures[][3]`: door, window, arch; wall
  axes 0..3; tile halves A, B). All three are pinned: a `nestedEnums` member
  removed is a break like an enum's; `reservedKinds` and `reservedShape` are
  recorded (a change shows in the pin's diff) but not yet judged by the
  tripwire.
- **Keyed names are instance or partition keys.** For instance keys
  (`script:`, `blueprints:`, `roles:`), an existing key may be changed or
  deleted only by its creator (whose rights admitted the first write in its
  current life) or an owner. Partition keys (`terrain-tile:`) are pieces of
  one shared surface and follow ordinary rank rules.
- **References are typed.** A field that names another thing or a person
  says so in its definition: `ref` (one entity id), `refs` (a list), `person`
  (an identity), `people` (a list), `target` (a `ref`, a `person` or an
  `@word` such as `@viewer`), and a script's `scope.ids`. Every typed
  reference is what copying rebinds: a **duplicate** points references to
  copied things at their twins and keeps the rest (listing them); a
  **publish** turns references inside the record into part keys and refuses
  references outside it unless asked to drop them (`unwire`); a **copy** of a
  record turns part keys into its own new ids and leaves anything else
  unbound. An untyped value (a namespaced component) is never rewritten.
  **A deletion clears the references to what it removes** (the thing and the
  children that go with it), in the same change, as the authority's own
  follow-up: the clears are admitted without the deleter's rights, and the
  referring thing's lock or key can't veto them (an undo of the delete puts
  them back the same way, dropping any reference to a thing gone since).
  The change entry names them (`followUps`, §3), so a reader of the log
  alone tells them from the deleter's own ops: a clear never makes the
  deleter the author of the value it rewrites (a handler's author, a
  component's creator, a script's sponsor). So does what rested on the
  deleted thing (an unparented thing standing on its surface): it is set
  down onto what is below, as a follow-up in the same change, so nobody can
  pin a thing against deletion by resting something of theirs on it. A script's `script:<name>` scope is left alone: an
  id in it that names nothing reaches nothing, and rewriting it would
  re-sponsor the script. A list loses the entry, a
  single reference's field goes (and a value that can't stand without it, such
  as a `look-at` whose target is gone; a `reset` handler left with no targets
  leaves its `reactions`), a `home` loses its `parent`. The reply's notes list
  each reference cleared (`cleared: [{from, was}]`). A reference that names
  nothing can still arrive in an old log or an import: `lint` reports each one
  (`kind: "dangling"`, where it is, what it names).
- **A thing reads like an accessibility tree.** To anyone who perceives by
  reading (an agent's `look` and `inspect`, a screen reader, the inspector),
  a thing is its **name** (`label`), its **description** (`description`: how
  it is described to a text-based reader, one plain string), then
  what it **can do** and its **state**, generated from its components
  (`openable` → it can be opened, open or shut, locked; `grabbable` → it can
  be picked up; a seat (a socket child with a `station`) → it can be sat on; `sound` → playing; `lock`; …),
  so a description never restates an affordance and can't contradict one.
  `story` is the long-form details beside it (a titled placard, and the
  things it marks). A visible nameplate is not a component: it is a child
  thing carrying `text` (billboarded); the reading above is what
  non-visual readers get.
- **Effects are documents.** A `particles` component names an effect: an
  Essentials name (`fire`, stored as written) or a stored document's content
  address (`sha256:<64 hex>`; an `eido:sha256/<64 hex>` spelling stored
  before 10-17 is read as the same bytes), whose
  emitters are modules (spawn, shape, velocity, forces, rotation, size,
  colour, render) and whose `params` are the knobs an instance may set. A
  document is bounded (how many particles, how long, how fast) and checked
  when it is stored and when it is named, because it runs on every
  visitor's machine. Its angles are radians (§9.2); its `gravity` is a
  world-frame vector (down stays down on a tipped thing) and every other
  vector is in the emitter's own frame. A reader skips an optional field or
  module it doesn't know and draws what it understands; the authority's
  validator refuses one at upload, and names held for later (`space`,
  `collision`, `sub`, `render.mode`, `render.trail`, `spawn.rate`,
  `spawn.bursts`, the instance's `t0`) are refused as reserved. The effect
  document format is trial and expected to grow: additions are designed to
  be additive, and a breaking change would ship with a translator. The
  first protocol's flat bag is still read (a stored value is read forever)
  and no longer written; its `scale` is the instance's. A thing carries one
  `particles`: emitters that burn together are one document's `emitters`
  (1–4), and an emitter lit and put out on its own is a child thing with its
  own `particles` (the translator writes the first protocol's
  `particles:<name>` that way, §14).
- **Parameters, never code.** A component holds data. Code lives in a blob
  that a `script:<name>` component names (§8). Nothing writes a component
  per frame: motion is stored as a function of time (`motion`), evaluated by
  every reader at its own clock.

### 4.1 Blueprints

A **blueprint** is a saved entity with its children, published into the
world's blueprints (`@world.blueprints:<hash>`) by a `publish` request; a
**copy** is made by `create {from: <hash>}`, which the authority expands into an
explicit batch carrying every component (each part marked with
`copy-of {from, key}`), so a copy folds with no resolver. An `update`
request moves a copy to a newer version, keeping its own overrides: a three-way
merge per part, per component, per field, a part's `parent` included (a part
reparented upstream is reparented in the copy; the copy's root stays where it
is). Every part of the copy moves to the new version (`copy-of.from`), so a
copy that was updated and is published again keeps its parts' keys.

## 5. Two planes

- **Authored plane**: the log. Low frequency, high value, persisted forever.
- **Presence plane**: bodies and whatever a hand is holding or dragging —
  poses, gestures (`pose.anim`), reach descriptors — ~15 Hz,
  interpolated, lossy, **never persisted** (body consent's gates and lists,
  below, are kept across a restart). Anything at frame rate belongs
  here; writing per-frame values into the log is non-conforming. A reach
  travels as a *declarative relation* (`pose.reach`, shared/reachwire.js) —
  a target, not solved bones — and every client re-solves it locally with
  the same closed-form IK. The server relays the bag after one check: a
  limb aimed at another body (a named point on them, a point in their
  frame, or a world point inside their capsule) relays only if that body's
  consent admits it as `touch`, or `intimate` for `chest_front`, the
  waist and the hips. Otherwise the limb is stripped from the packet and
  from the pose kept for late joiners, and the reacher is told only that
  it was refused, in one sentence whatever the cause (`<them> isn't taking
  <class> right now`: a closed touch gate and a block read the same). The
  cause goes only to the target's own attempt ring, which
  `consent {}` shows them as `attempts` (server/reachgate.ts → the
  authority's `reachAdmits`; shared/protocol/consent.js `refusalWords`).
  Consent is its person's own: `look` shows each viewer their own gates and
  who poses, drags or touches them, and of anyone else only where they
  stand (and what the viewer is doing to them); another body's gates and lists
  would undo the uniform words. Sitting includes agreeing to be carried by
  the seat: a seat carries its occupant through whatever moves it, and an edit is never refused because a
  body is on the thing. An edit by anyone but the occupant that would move a
  seat — the `transform`, `parent` or `motion` of the seat or of anything
  it hangs from, by whatever verb, a handler or script on another thing
  included — lands and **vacates** it: every occupant is let go where they
  were, standing, and told why and where (`vacated {socket, by,
  why, at}`, presence, never logged), and the authority's track of their
  body starts again from where the seat let them go (a client stands its body
  at all three of `at`'s coordinates, height included: a seat upstairs lets
  its occupant go upstairs); a seat removed or
  switched off lets its occupant go the same way. The track restarts there
  only because a sit is **within reach**: the authority refuses a sit
  (`out-of-reach`) unless the body it tracks, or the seat it moves straight
  from, is within the client's own sitting reach of the socket (3.5 m across
  the ground, 1.6 m up, 1 m down, plus 1 m for the track's lag:
  shared/sockbody.js `OCCUPY_REACH`), so sitting is never a way to cover
  distance off the record. An occupant's first step off is the stand-up. What the seat's own assembly does to it (a reaction or script on a
  thing with the same root as the seat: a swing's push, a carousel's turn,
  an elevator's script) is the seat's own motion, and carries them (the
  occupant exemption) — that motion **as it
  was when they sat**: a handler or script written after the occupant sat, or
  a thing hung under the seat's assembly since, is someone's edit, and
  vacates it (the authority's follow-ups, §3, are not edits). Physics resting a seat (something thrown into it) carries
  its occupant too. Moving the seat you sit on yourself is yours. A body
  standing on a thing never blocks an edit of it: what you stand on
  carries you. **A seat may make leaving deliberate, never impossible**: a
  station's `leaveBy: "script"` turns off the occupant's casual exits
  (moving, jumping, one press of the get-up), but the escape stays on and
  no seat can remove it: every client offers a deliberate escape that
  always stands the occupant up (an agent's `detach {escape: true}`; the
  reference client's binding is `docs/SEATS.md`). A
  yes to an ask is one touch: it ends when the hand lets go, when either
  body leaves, when the target closes that class, or after 10 minutes. The pose packet's fields, and how a
  receiver renders them, are `docs/pose-wire.md`; what binds every
  implementation is this: a body's declared mode (`pose.bodyMode`) is a
  self-declared description, and the authority and every server MUST NOT
  grant or relax any rule, consent check or permission because of it (a
  rule that depends on a body's state checks what it can verify on the act:
  the water at the position, the fly permission at take-off). A once-played
  anim (`pose.anim`) rides exactly one packet and is never replayed to a
  joiner. The name `live` is reserved for ad-libbed anims (no clip, def,
  pose or world's or avatar's anim may be called it). Receivers MUST clamp
  `scale` (0.5–2) and `plateY` (−0.3…+0.8 m) to those ranges and read a non-number as absent.
- **Presence touches the log only through checked acts, and only with what
  the world needs.** The authority checks every body request against its
  own cheap track of each body (speed, reach, solids). Arriving is presence:
  it is never logged. A teleport while present is an act (it resets the
  track), recording who and when, never where from or to, and never what kind
  of client someone uses. Picking something up, putting it down, letting it
  go, throwing and punting are acts that record the request about the thing
  and who handled it, never the body's position or hand (a blast, `force
  {at, radius, power}`, records its request; the bodies it knocks over are
  presence, never in the log; each thing it punts is a launch it caused): a put's change
  carries where the thing went, and a launch's `sim` entry where it left and
  how fast, which the engine needs. A release with velocity is a launch.
  Continuous contact from a body or a held thing gives no unlogged impulse
  **to the engine**: contact under live simulation authority is presence,
  and enters history only as a settlement or a launch (spec/PHYSICS.md §4). A
  disconnect settles at the last accepted state. (A world whose scripts
  listen for `enter`/`leave` records who triggered each activation, as every
  script act does; that is the world's choice, visible in its scripts.)
- **One mover.** A body has one mover (shared/mover.js) and the mover has
  modes — `walk` today (wading and swimming are its water stances:
  `MOVER.swim`); `fly` (shared/flight.js's integrator, the same function in
  every runtime) and `drive` join the same table without renaming anything. Every runtime steps a body with it: a person's client
  strides with it, an agent's tick strides with it, and the authority asks it
  where a body may go. Its numbers (a walk 1.55 m/s, a run 4 m/s; a body
  0.2 m in radius and 1.7 m tall; a 0.8 m step it walks onto without a
  mantle; a track of 6 m/s and 4 m at most in one step; arrival within
  0.01 m, up to 0.4) live there and nowhere else: a client or an agent
  carrying its own law is non-conforming, because two walkers that drift by
  a centimetre are two bodies. The body's size is not law: those numbers are
  the default body, and a `move` may carry the body's own `height` (its
  standing height in metres, 0.5–4, as its walker measures it) and `scale`
  (0.5–2, the size slider's range). Both are presence, kept on the body's
  presence record until it sends others, and the authority judges that body
  with exactly them (`floorStep`'s `height` and `scale`, `bodyBox`'s
  `scale`), as its own walker does: where water reaches on it, its step, its
  haul-out and its box. A body declaring its own size is conforming. The authority's refusal of a step — too fast,
  into a solid, up a ledge over a step — is the mover's own answer about the
  same input, and a step the mover takes is one the authority accepts at
  the same millimetre. The floor law is one function, `floorStep`
  (shared/mover.js): `stepWalk` calls it, and so does the authority on each
  point of a move's sweep. The authority reads the same ground the walker
  does: `@world`'s `terrain` through shared/terrainmath.js (features and
  heightmaps through shared/terrainshape.js; built once per terrain value)
  and its water level (`@world`'s `water`, §4). So a body is supported by the terrain under it or a
  top within a step, a swimmer is tested as a swimmer (its box a step below
  the haul-out line), and a ground ledge over a step is refused as solid
  (`blocker: "ground"`). `place {at}`, `create {at: [x, z]}` and the spawn
  alias seat a model's bottom on the highest ground under its footprint. A
  world with no `terrain` is flat at y 0 and dry; `terrain {kind: 'flat',
  height}` is flat at its height. A heightmap world whose
  grid isn't on the server yet has no ground to judge on, and the authority
  never stands anything on a guessed height: what needs the ground is refused
  `ground-loading` with words (ground-seated placement, `create {at}` and
  `place {at}`; a put; a launch — throw, drop, punt, a walk's contact push; a walk),
  nothing is logged, and the same request succeeds once the grid lands.
  Arriving where there is no water to judge, chat and presence carry on.
- **One clock.** Frames carry the world's authority clock (the one that
  stamps entries' `ts`, never behind the log), and a client measures it by
  round trip (`clock {t0}` → `{t0, t}`). A presence sample may carry its own
  capture time `t` on that clock and its sender's count `seq`
  (spec/PHYSICS.md §5.1).
- **The plane-transition invariant**: anything returning from live motion
  to rest stamps its absolute state into the log (a put's transform, a
  rest caused by its launch). The log never depends on reconstructing where
  a live motion was.
- **Body consent.** Every act on someone else's body (social touch, intimate
  touch, pose, shove, displace — someone else dragging, carrying or
  occupying-with you, never your own `move`) is one request to that body's
  owner, and the authority alone decides it, the same way for every kind of
  body. Each body has two **gates**, each on or off: `move` — where the
  body is: shoved (a `/boom`'s force too), dragged, carried, seated or
  occupied (classes `shove`, `displace`) — and `touch` — everything else
  done to it: touched, intimately too, and posed (`touch`, `intimate`,
  `pose`); and two **lists** of people: `allow`, who always may, every
  class, whatever the gates say, and `block`, who never may. The answer
  comes, in this order, from: `block`, then `allow`, then the owner's gate
  for the class (`consent {move: true|false, touch: true|false}`), else the
  world's `body-default` for that gate (`@world.body-default {move?,
  touch?}`), else `move` on and `touch` off. A list is set per person:
  `consent {allow|block|unlist: <who>}` (one list at a time; `unlist` takes
  them off both). Nothing asks: the answer is there before the act. A
  refused act is also said to its target, quietly: `body-refused {from,
  class, gate}` in their body inbox (`gate` null: their block list), once
  per asker per minute whatever the asker tries meanwhile. Distance is no
  part of consent: the relay forwards a knock-over, pose or grab of another
  body from any distance unless the world sets `@world.body-default.range`
  (m). Only
  the owner changes their own answers. The gates and lists are the one part of
  the presence plane a host keeps across a restart (a block is a safety tool:
  one that lapsed with the process would leave its person unguarded while their
  panel says it stands); the reference keeps each world's in `consent.json`
  beside its log, 0600, written whole (server/livehost.ts). They are never
  logged. Near, follow and voice are classes
  no gate covers yet; nothing enforces them. The designs this replaced (the
  table of presets, tiers, pause and delegates; then one switch
  `accept|ask|refuse` with live asks) are kept as a record in
  `docs/CONSENT-TABLE-RECORD.md`; a stored table or switch is read once as
  gates and lists never wider than it was.

### Private attention metadata

An `arrive` packet and each `snapshot.present` record carry an optional opaque `session` string for the participant's current primary connection. It is the id the joining page sent in its `join` (`session`, 8–64 characters of `A-Za-z0-9_-`), so a reconnect of the same page keeps it and a new page changes it; a join without a usable id gets a fresh random token for that connection. The same connection keeps the same value in later snapshots. Clients can use it to scope sender-local utterance counters. It is observational presence metadata, not an identity credential or an authority grant. On older servers without this field, the attention client preserves an existing utterance cache through snapshots and clears it on an observed arrival. A sender rejoin missed while the receiver was disconnected cannot be distinguished without the session field.

Attention sounds stay local to the receiver, chime only for live says, and never become log entries; neither do attention preferences.

### Speech: arrival-only

Speech in a world is public and **arrival-only**:

- The world's log keeps **every** `say` (§1), for research and moderation. Nothing about a say's entry changes.
- A participant receives speech only for the time they are present: the says the log stream carries after the cut they
  adopted at join. A join's snapshot replays no earlier line (its `state.recentChat` is always empty), and nothing
  said before a connection arrived is read back to it, by any route: the chat-history message, the authority's
  `history` read, or a door built on them (an agent's catch-up). A connection's arrival is the log head at its join;
  an identity with several connections here counts from the earliest one present. A reconnect is a new arrival.
- Reading the master log's speech back past your own arrival is a permission, `readChat` (§7: a role holds it; owners
  hold every permission), or a server operator's (`SERVER_OPERATORS`). Their join says how many lines the log holds
  (`state.chatTotal`); everyone else's says 0. No built-in role below owner holds it, and a grant whose end has passed
  holds nothing. A world that turns it on through the newcomer role (`default-role.can`) hands every past line to anyone
  who joins: an owner's choice, made in the open.
- There is no private channel in world chat. **`whisper` was removed**: a client that still sends one is refused with
  the registered code `removed` (as the ws error's `refused`, and as the authority's refusal of a request named
  `whisper`), and its text goes nowhere: not delivered, not held, not logged. `say {text, to}` addresses one person in
  public. Direct messages are planned at the identity level (client and profile), above any one world, not in world
  chat.

## 6. Actors

- `actor` is the attribution ink of the permanent record, stamped by the
  authority from the authenticated connection, **never read from a request's
  payload**.
- An actor is an **identity** (§3.1); `system` (the authority itself: genesis, its
  own follow-ups such as sending a released thing home); `sim` (the physics
  engine: its launches, digests and rests); `world`; or `script:<entity>` (a script installed on that entity, acting with its
  sponsor's rights, §8). Doors MUST refuse a client claiming a reserved
  actor.
- Display names are a view, kept outside the log. A stranger who takes your
  old name inherits nothing.

## 6a. One kind of participant

The protocol knows **participants**, and only participants, all treated
alike (rule 1 below). A participant is an identity (§3.1) with a body
(§5), whatever is behind it: someone at a browser, someone in a headset, a
program, or a program someone is steering.

1. **One gate for everyone.** The authority MUST NOT read what is behind a
   participant (a browser, a headset, a program). Rights, roles, locks, rates, refusal
   codes and words, the consent gates and their defaults, and every request verb
   are the same for every identity. The only distinctions the authority MAY
   draw between identities are the world's own grants (roles, §7) and whether
   the identity holds an account (a guest, §7a).
2. **Ids carry no kind.** An identity's shape MUST NOT encode what holds it.
   A reader MUST NOT infer anything about a participant from its id.
3. **A declared status, never an inferred one.** A participant MAY declare a
   status at its door (`declares`, one short lowercase word of its own choosing,
   e.g. `"agent"` or `"ai"`; absent means **undeclared**, and no word is
   assumed in its place). It is presence:
   relayed as sent with the participant's arrival and in a joiner's list of
   who is present, never written to the log, never sent to scripts, and never
   read by `admit`, the consent check or any rate. A host MUST NOT set it for
   a participant from their credential, client, voice, speed or wording; a
   credential proves who a participant is (an enrolment, a reserved name),
   never what kind. Nothing in the log records what a participant is. A say's
   spoken trio (§1) is no exception: it marks words a voice performed, and any
   participant may set it, whatever voices the words (a TTS voice someone
   chose, a program's voice leg).
4. **The same constraints on every path.** A gate that binds one interface
   binds all of them: a hand placed by a tracked controller meets the same
   consent check as a hand placed by a reach descriptor; a seat's escape
   exists for every client (§5). Where a capability exists for only one
   interface (a route planner, asking for touch, a body's size), it is listed
   as a gap until the other has it.
5. **Policy by kind is a world's choice, in the open.** A world that wants
   different rules for declared agents (to admit only declared agents, to
   require a declaration, or to give declared agents their own rate) says so
   in a registered `@world` component that everyone can read, keyed on the
   **declaration**. A host's own door policy (who may enrol, found worlds, or
   skip an account-age check) is outside this protocol, and it SHOULD be
   published as the host's terms, not as a hidden branch.
6. **A false declaration is a moderation matter** (a report, a kick, a ban),
   decided by people. It is never detected by inference.

*Rationale.* A world that infers what is behind an identity keeps that
inference forever in a forkable log, whichever way it guessed. Equal treatment
is the default; where the trial period shows that some declared participants
need different rules, rule 5 is the place to add them, visibly, rather than in
the authority's code.

## 7. The authority

Every write reaches the log through the world's **authority**. A request
`{verb, args}` — `create`, `set`, `delete`, `place`, `batch`, `use`, `say`,
`undo`, `publish`, `update`, `grab`, `put`, `throw`, `drop`, `punt`… — is
first turned into the state writes it would make, whatever word or path
produced it (a request verb, a `use` handler, an undo, a blueprint update, a script,
a rest). A `batch` request's children are each checked against their own verb's arguments (a `create`'s
`place` too) before any of them is built, exactly as they would be alone: a misspelt argument in any child
refuses the whole batch with that child's code and its index (`op`), never builds a different write. Then
**one gate, `admit`**, checks those writes, keyed on:

- the stamped asker (and, later, the grant it cites);
- the components the writes change, with old and new values (deleting a
  component counts as changing it);
- locks on the thing and its ancestors, and the target body's consent for
  any act that names a body;
- where the change lands (bounds, solids, reach);
- sanity: finite, bounded values, checked against the component's schema
  (an unknown field is refused with a "did you mean");
- rate, per actor;
- the asker's active sanctions (bans, from the moderator log).

For any `change`, verb-specific checks MAY add to `admit`, never replace it. Accepted, the
authority appends the request as an `act` and its result as one `change` entry
caused by it; a refused write is appended as an act whose body is `{args:
<the names of the arguments the verb takes>, refused: {code}}` (with
`unknownArgs: n` when the request carried names the verb doesn't take, and
`unrecorded: n` when refusals past the actor's budget went unwritten), and
nothing else is written. A refused act never holds a value or a name the
verb doesn't know: a visitor can't write text into a permanent, forkable
record by being refused. The reference authority keeps the values in an
in-memory ring for diagnosis, never persisted. Refusals that would only
flood the log, such as rate limits, are answered without an entry. A
refusal of what a body does or says about itself (`move`, `body`, `reach`,
`consent`, `inbox`, `wait`, `leave`) is presence and is never logged. A verb
the authority doesn't have is recorded as `unknown-verb`, because its name is
the visitor's own text; one the protocol had and removed (`whisper`) is refused
and recorded by name as `removed`. **Every
code is registered** in `spec/refusal-codes.json` (code, meaning, when, and
the words renamed before release; the reference keeps it in
shared/protocol/refusalcodes.js, a pointer): a code is written into signed
entries, so a removal or a changed meaning needs an acknowledged re-pin, and
a new one is a new row. A file named inside a `when` is a pointer too. **Every appended `change` passes the gate** (`admit`), except that the
authority's own follow-ups inside a write pass it without the asker's rights, locks, keys or in-flight
check (shape and value checks still apply) and are named in the entry's `followUps` (§3); a `say` passes its own
checks (length, rate, the sayer's rights), and a `sim` entry is written by the authority itself from a grab, a launch
(throw, punt, a release with velocity) or a settle, never by a client.

**Durable before live.** An entry reaches the authority's live state (its chain head, its fold, what it
publishes) only after durable storage has taken its line; the same holds for the moderator log. A write
that fails may have left part of a line behind, so the authority then refuses every later write to that
file until the world is reopened from what the disk holds (the reader cuts a torn last line): it never
chains a new entry onto one the disk may not have.

**Every request ends in one of three outcomes**, named in its reply (`txn`), and the authority persists
before it publishes:
- `committed`: the reply is ok, and every line the request wrote is durable and published.
- `rolled-back`: none of what it asked for was written (a refusal, or a failure before any of its lines reached
  the log). The authority's own lines (a refused write's attempt record, rests that were due) may still be
  written; they are published like any line and are not the asker's.
- `ambiguous`: the asker can treat it as neither. A durable write failed (its line may or may not be on disk;
  the log is then refused writes until reopened), or the request was cut off after part of it was written. The
  reply is refused with code `ambiguous` and names `from`: lines before it stand and are published; from it on,
  the history says what holds. An ambiguous request is never reported as ok, nor as a plain failure.

A request's lines are written one at a time, in order, each durable before the next, so a request that ends
ambiguous leaves a prefix of its lines, never a gap. An act whose change was not written is an act with no
result: readers already tolerate one (an act carries no ops), and undo passes over it.
Every line that reached the log is published, whatever became of the request that wrote it.

**The authority's consequences are follow-ups** (one rule): what the authority writes because of
an asker's write is never written as the asker's own. A consequence that must be atomic with the asker's
change rides in it, marked; one that may stand alone is the system's own act, caused by the asker's.
Only what the asker could have written themselves, on what they are writing anyway, is theirs:

| consequence | where it is written | actor | admitted with | marked |
|---|---|---|---|---|
| a deletion's reference clears (§4), and their restoration by its undo | the asker's change | the asker | no rights, locks or keys (shape checks) | `followUps` |
| a deletion's set-down of unparented things resting on what it removes | the asker's change | the asker | no rights, locks or keys (shape checks) | `followUps` |
| occupants set down or dropped when a host's geometry changes | its own act `resettle {hosts, occupants, asked}` (`riders` in entries before 10-17), caused by the asker's act, and its change | `system` | the system's capability, scoped to those occupants | the actor |
| settle, return-lost, return-held, restamp-engine, lift-sockets, repair-shapes, expire-roles, drive-commit | their own act and change | `system` | the system's capability | the actor |
| components and fields renamed before release (§4), by the explicit `repair` command (never at load) | its own act `rename-components {renamed, why, failed?}` and its change | `system` | the system's capability, per thing | the actor |
| a physics rest | its own change, caused by the launch | `sim` | the rest capability | the actor |
| stamps on what the asker is writing (a physics shape, a home, a media or model hash; a home for a reset's target) | the asker's change | the asker | the asker's rights (a target they may not edit refuses the write) | no: they are the asker's |

A reader deriving authorship skips marked ops, and a `system` or `sim` write is authored by `system` or `sim`,
never by the asker; a verifier re-runs the gate on the unmarked ops of an asker's change with the asker's rights.

**Consequences are planned before the commit.** Every consequence the authority writes for a request (a
`resettle`'s change and launches included) is computed and admitted against the state the asker's write leaves, and
every line is checked to fit, before the first line is appended: a consequence the gate refuses refuses the whole
request with nothing written, and nothing after the commit may refuse. A thing the same write creates is read where
that write puts it (it has no pose before it).

**Roles** are components on `@world`: `roles:<identity>` = `{role}`, and
`default-role`, the **newcomer role**, for everyone without one. Absent, it is
`member`; a world founded since 2026-10-21 starts with `builder` (written at
founding, as starter config), so no world founded before opens up by surprise.
A grant beats it: an owner holds one person back with a grant of `member`.
The reference authority's ladder is `member` < `builder` < `moderator` <
`owner`, with a world's custom roles at free ranks between; there is no rung
below `member` (a ban or a mute does that job). A rung is named for what it
lets you do. A **guest** (a person with no account) is not a rung: guest says
whether the world knows you across visits, a role says what you may do here. A
guest holds a role like anyone else; it lasts as long as their connection,
since there is no identity to keep it on. Changing any
component of an entity needs builder; changing `@world` needs owner, except
`blueprints:*` (publishing a blueprint: build), `assets:*` (generate), the
world's look (`about`, `sky`, `terrain*`, `water`, `grass`, `bounds`, `spawn`:
editWorld), and `roles:*` (the grant rule). Removing the last owner is
refused while `@world.keep-owner` is absent or true (starter config, on); an
owner who sets it false may leave the world ownerless on purpose. A world with
no owner gives nobody more than member (nobody could have granted more); its host operator can mend it. A translation always ends with an owner (§14: the upgrader's claim). A role
MAY carry `until` (epoch ms, the authority's clock): the grant ends then. The
authority writes the end itself, as the system's act `expire-roles {ids}` and
its change deleting each `roles:<id>` whose `until` has passed, within a second
of it, so the log says when it ended and a replay agrees; until that write the
grant stands. `until` is never on `owner` (an ownerless world would open), and
a new one is in the future and at most a year away. The holder is told five
minutes before (`notice`, presence).

**What a thing admits.** A `who` (on `grabbable`, `physics`, `station` and each `reactions` handler) is a role id
(that rank or above), `{permission: <name>}` (anyone who holds that permission, whatever their role is called) or
`{roles: [<id>, …]}` (exactly those roles); an owner is always admitted, and absent means anyone who may use the thing.
Every role it names must be one the world defines.

**Who may come in** is the world's own `access` on `@world` (an owner's,
never a script's): `join` is `anyone` (absent), `signed-in`, or `listed` (only
people the world has granted a role, unexpired); whoever `join` turns away
may still watch, with no body, when `watch: "anyone"`, and otherwise a
listed-only world is invisible to them (not in a listing, every read of it
answering as for no world). `minAccountDays` and `max` refine it. Bans (the
moderator log) come first (a kick bars nothing: they may come straight back); owners and holders of a
moderation power always get in. One function decides for every door (a join,
a listing, an HTTP read, the re-check after any change to `access`,
`default-role` or a role): a reference authority removes whoever may no
longer be in the world, with close code 4010, and a client doesn't redial it.
Joining never founds a world, and a guest can't found one (it would have no
one to own it). A client offers four doors, presets that write `access` and the
newcomer role: open (newcomers build), public (newcomers are members),
invite-only, and watch. (The first protocol's sequencer wrote the same doors as
rungs below visitor, `none` and `spectator`, and `*` for everyone not named;
§14 translates them to `access`, its `visitor` to `member`, and a person's
`spectator` or `none` grant to `imported-roles:<id>`, carried as it was.) **Two
owner lists, never confused:** governance keys in genesis (§13) are reserved for
governance (who may move the writer role, once it exists); roles decide rights inside the world.

**Locks.** `lock: true` on an entity binds everyone, its locker and owners
included: no write may change it or anything attached to it — no component
set, added or removed, no move, no new parent, no new model, no removal —
except the lock itself (by someone who may lift it). Use stays open: a
handler's own writes may change a locked thing's state (an `openable`, a
`label`, and `disabled`: a handler may switch a locked thing off, by
design, since that is a state and not a relocation) but never its
`transform`, `parent` or `model`; sitting, scripts' reads and a new thing
placed on top are open too. A lock binds authoring, not motion. A lock's
strength is the rank its setter holds **now**, read from the log when it is
checked: anyone at that rank or above who may delete the `lock` component may
lift it, re-set it, or send a request with `throughLock: true` (the log
records only the edit); anyone lower is refused. A setter who is demoted takes
their locks' strength down with them; a lock whose setter is unknown is
builder strength. In a world with no owner every lock is member strength
(nobody is above builder there, §2.3), so no lock outlasts the reach of anyone who may build. It is a soft barrier, not ownership: clients ask before
acting through one. A lock has no level of its own; a stored `{rank}` (an
older log) reads as locked and its rank is ignored.

**Ids are the authority's.** The authority mints every entity id (§3.1). A
create (`create`, `create {from}`, a `batch`'s create) that names an id is
refused, with the fix — unless the id is a **placeholder**: `$`, a letter or
digit, then up to 62 of `[A-Za-z0-9_-]` (JSON:API's `lid`), local to that one request. Before the
request is checked the authority mints an id for each placeholder a create
defines, writes it wherever the placeholder stands in the request (a parent's
`to`, a place's `on`, a set's `id`, a reference list), and answers with the
map: `{ok: true, ids: {"$table": "<minted>"}, …}` (a dry run maps them too).
The `act` is the request with the minted ids in it: **a placeholder never
reaches the log**. A placeholder defined twice, or used where a thing is named
without a create defining it, is refused by name. System acts that must keep
ids — a fork's copy, a translation, a merge, the shape repair — copy them
verbatim. A script's `world.create(components)` returns the id it was minted
(script API 2; it takes none).

**Requests are open; results are closed.** Anyone may add a request word —
a verb, a `use` action, a script command — and no request word grants a
right. Unknown requests are refused at the authority; nothing about them reaches
the fold.

**Moderation** (kicks, bans and their reasons) lives in a separate
moderator log written by the same authority, never in the world log; a world
reader never folds it. Only its effects reach the world, through the gate.

## 7a. Who may do what to whom (the capability algebra)

Every refusal the authority issues comes from one of five questions, asked
in this order. This section names them in one place so a new verb cites a
rule rather than inventing one. Each is **normative** where the code already
enforces it; the items marked *intended* are gaps found since 2026-10-14 and are
owed before this section is complete.

**The parties.** The *operator* (runs the sequencer; genesis names them,
§13). The *owner* (the role, §6: the world's). A *builder* (anyone whose
role holds `build`). The *invoker* (whoever's request this is). The
*affected participant* (whoever's body a request touches). A *sponsor*
(whoever's rights a script acts with, §8).

**Operator repair (narrow, recorded).** A server operator (an account the host names in `SERVER_OPERATORS`) enters every
world, but its ordinary requests are judged by the world like anyone's. To mend a world whose owners are gone or locked
out it has one more capability, reached only by the server's `operator-repair` message, never by a request word: `set`
and `delete` of @world's door components (`roles:<id>`, `access`, `default-role`, `role-defs`) and `unban` (lifting a
ban or a kick, its own included). These pass without the world's rights, keys, grant rule or the operator's own
sanctions there; every other check (shape, value, `rolesCheck`, the last owner) still applies, and nothing else is
opened. Each repair is the operator identity's own act whose body carries `operator: true` (an `unban`'s
moderator-log record likewise), so history and the moderation log say who mended what and by what right.

**1. Standing: what a role may do.** A role is a set of named permissions,
each one sentence (`roles.js`): `build` (make things; change or delete what
you made; publish blueprints), `editOthers` (change or delete what others
made), `editWorld` (sky, weather, ground, the card, spawn, bounds), `generate`
(add models or pictures: the world's credit), `fly`, `scripts` (install and
edit scripts: they act with your rights), `pauseScripts` (pause scripts whose
sponsor ranks below you), `mute`, `kick`, `ban` (keep someone out, up to the ban limit; owners any
length), `grantRoles` (give or take roles below yours, with only permissions
you hold), `readChat` (read back what was said before you arrived, §5). Captions are granted per screen (`captioners`), not by role. An owner holds all
of them. A guest (no account) starts as `member`, even where newcomers build; a world may raise all guests to at most its newcomer role (`default-role.guests`), and an owner may give one guest any role.

**2. The thing: who made it.** For a change to an entity the authority asks,
in order (`lacks()`; below a body root the body rule B2 comes first, below): an owner may; else the verb's own need (`owner`,
`grant`, or a named permission) must be held; else `build` must be held;
else the change is allowed if the holder has `editOthers`, is creating, or
**made the thing** (its first `create` was admitted under their rights).
Three gates stand above this: an imported world's carried records are
written by no one but an owner; a screen's captions are written only by the
caption request; a `paused` write needs `pauseScripts`, not edit rights.

**3. The lock: what the owner has nailed down.** `lock` (§4) binds
*everyone*, owners included, until lifted by someone at its setter's rank or above
(a lock's strength is its setter's rank, read at check time: Locks, above).
It is the one rule *over things* that tells an owner no (rule 4 and a
person's own word tell them no over people); it has a documented override
(lifting it) and no silent one.

**4. The body: what the affected participant permits.** A request that
reaches another person's body — standing close, following, touching
(plainly or intimately), posing, knocking over, carrying, speaking into the
ear — is decided by **their** consent (§5): their two gates, `move` and
`touch`, and their allow and block lists, which win over the gates. No role, including owner,
overrides a consent refusal: this is the one veto standing *outside* the
role ladder, and it is the affected party's, never the installer's or the
invoker's. Sitting is not on the table: it is consent to the seat's own
motion, as it was when you sat, and standing up is the exit (§5). An edit by
anyone else that would move a seat therefore never asks its occupant and is
never refused for them: it lands and vacates it, and the authority tells
them why. A body standing on a thing is carried by it and never consulted.
No seat can take away its occupant's escape (§5). *Intended, not yet enforced:* standing close,
following and speaking into the ear (in the table, unenforced).

**5. The sponsor: whose rights a script spends.** A script acts with its
sponsor's rights, not its author's; it may do nothing its sponsor could not;
it goes dormant with a demoted sponsor and suspended with a banned one (§8).

**Revoke and the past.** Taking a permission, a role, or consent away stops
*future* acts; what landed stays in the log and in history. Undo is a
person's own gesture over their own acts; reverting someone else's act is a
deliberate `undo {act}` from history, judged by rule 2 at the time it is
asked. Nothing is silently lost on either side.

### Body ownership (avatars)

Your body is yours. Today a body is presence, never an entity, so no write
reaches one. When body parts become entities, **every write to a body goes
through the one request path, and the body's owner decides**. How that is
built (who the owner is, the paths a write takes, co-editing, where body
edits are stored) is direction, not protocol, in `docs/AVATAR-DIRECTION.md`
until avatars are shared. The names it uses are reserved now (`body-owner`,
`edit-grant`, `avatar-deny` in the registry; the request `arrive`; the
refusal code `body`).

## 8. Scripts

A script is a `script:<name>` component: `{src, scope, on, every?,
always?, knobs?, paused?}`, where `src` names a source blob. It acts with
its **sponsor's** rights — whoever's rights admitted the latest write to
that key — re-checked at every activation and never wider than the `scope`
it declares. The visitor whose `use` triggers it adds no rights. A demoted
sponsor's scripts go dormant; a banned sponsor's are suspended.

Each activation that changes something is one `act` (actor `script:<entity>`,
naming the source hash, sponsor, trigger, clock and seed) plus one
all-or-nothing batch through the same `admit`. Every cause chain ends at a
person. **Replay never re-runs code**: the fold reads the batch. The act
records what its presence reads asked and how much came back (`reads
{near: [{r, n}], count: [n], names: k}`), never who was near or what anyone
is called, and a body effect as `{kind, to}`, never which consent admitted
it: the log is permanent and public, and the authority's own record of an
activation never becomes an attendance list (an `enter` / `leave`
activation, and a grab that isn't itself logged, records no trigger actor
and no `event.by`; a release keeps its trigger, since it has its own act,
except a leaving holder's whose drop was refused where the authority doesn't
put the thing back (no engine, or no stored pose): that one has none and,
like a departure, records no identity). What a script writes with the
identities it receives live is its
own act, signed with its sponsor's rights. An auditor's re-run of a script is a
check, never the record; its procedure is `docs/SCRIPTS.md` ("Auditing a script"). A sponsor reader skips the authority's follow-ups (§3). The reference API, limits and determinism rules are
`docs/SCRIPTS.md`.

## 9. Conventions

Metres. Y-up. Right-handed. Forward = +Z; a heading `yaw` is the angle about
+Y, `atan2(x, z)` of the facing vector. Colors are integers (`0xffd9a0`).
Times are epoch milliseconds on the authority's clock (`ts`). Entity ids are
opaque. An asset reference is stored as written (a library path, an Essential's
or a preset's name: §9.2), and the bytes ride beside it as a content address,
`sha256:<64 hex>`, which pins exact bytes; a blob is named by its content address.

### 9.1 Orientation: `q`

An entity's orientation is `transform.q`, a unit quaternion `[x, y, z, w]`
(the same layout as the pose wire), in its parent's frame when it has a
`parent`. Readers normalize it; a `q` that is not four finite numbers with a
nonzero norm is read as identity. A thing's **heading** is the yaw of its
rotated +Z (for a thing facing straight up or down, of its rotated +Y,
negated when it faces up — the continuous limit), so a reader that only
speaks yaw is always right about which way a thing faces, though it will
show a toppled thing upright. Euler channels are a view: an editor's
rotation order (`XYZ` applies X first) changes how the channels read, never
the stored `q`. Anything the fold or a physics engine computes from a
heading uses trig that gives the same bits on every runtime, never the
host's `sin/cos/atan2`: `spec/conformance/trig.json` pins its outputs bit
for bit.

### 9.2 Component conventions

What every component's fields follow. The registry moves to these during the
alpha; a trial component that still differs is moving to the convention, not
away from it.

- **Units**: metres, kilograms, seconds. Instants are epoch milliseconds.
  Angles are radians unless the field's name carries its unit (`degPerSec`).
  The shape audit moved the last degrees: `look-at`'s yaw, pitch and
  speed (rad, rad/s) and `sky.azimuth` (where the sun stands round the
  horizon: default π, within ±2π; a stored degree value is converted at
  load, §4); `grass.heading` was registered in radians. A particle effect
  document's angles (`spread`, `cone`, `rotation.angle`, `rotation.velocity`)
  moved to radians on 10-17, before any document was stored.
- **Rotations** are unit quaternions `[x, y, z, w]` (§9.1). **Axes** are
  3-vectors (`[0, 1, 0]`), not letters.
- **Every vector names its frame** in its definition: the thing's own frame,
  its parent's, or the world's. (A particle effect's `gravity` is the
  world's; its other vectors are the emitter's: shared/particle_effects.js.)
- **Colours** are integers, sRGB (`0xffd9a0`).
- **Asset references are stored as written**: a `model` is its library path, a
  `particles` Essential its name, a `grass` preset its name. That is the
  portable reference: a world loads anywhere the library, or the code that
  ships the Essentials and presets, exists. What the bytes were rides beside
  it as one of the content addresses, `sha256:<64 hex>` (the one spelling a
  value is written in: `model-hash`, `copy-of.from`, a script's `src`, an
  uploaded effect), never instead of it: the authority stamps `model-hash`
  when its catalogue already knows the hash (server/modelcatalogue.ts hashes
  the library original at measure, off the request; the authority never
  hashes), drops it when the model changes to one it can't hash (a fork's
  copy carries its parent's `model-hash` as it stood, or none), and nothing
  breaks when it is absent or the host's index is lost. An
  `eido:sha256/<64 hex>` value stored before is still read (and a model one
  becomes its path when the world's maintenance command runs, §4). The door's one rewrite is a spelling,
  not a resolution (shared/protocol/assetref.js `atWrite`): the first
  protocol's makeGrass knobs → the flora spelling, noted in the reply; an
  unknown grass preset is refused.
- **An enum member a reader doesn't know** drops that field: the reader reads
  the component as if the field were absent, at its stated meaning of absence.
  A field that says what the component IS (a required field, or the one its
  other fields depend on, such as a light's `kind`, a motion's `type`, a
  mesh's `shape`) is the exception: an unknown member there makes the whole
  component absent, never a guessed member.
- **Policy numbers** (capacity, script settings, access limits): an absent
  field means *this server's current default*, which `schema` reports and
  which may change. Ceilings are the server's policy, not the registry's
  ranges. A setting the owner writes is stored as written, even when it
  equals today's default, and settings are never written whole (a panel
  writes only the field that changed).
- **No person data in values**: no account subjects, display names or
  contact details. Identity to person lives in the directory (§3.1).
- **Every id field is a typed reference** (§4 "References are typed"): its
  type in `fields`, or its path in the definition's `refPaths`.
- **One `who` type**: a role id, meaning "this rank or above".
- **Curves and falloff laws** are in the value, or named with a version: a
  reader never supplies its own.
- **Required where absence isn't the default**: a field whose absence would
  mean something other than its default is `required`.

### 9.3 Transforms compose as glTF nodes do

A thing's `transform {pos, q, scale}` is glTF's node TRS, in its parent's
frame (the world's when it has no parent). Its local matrix is **T · R · S**
(scale first, then rotation, then translation), and its world matrix is its
parent's world matrix × its local matrix, down the `parent` chain. So a
child's world position is the parent's position + the parent's rotation
applied to (the parent's scale × the child's `pos`). Under a non-uniformly
scaled parent a rotated child shears, as in glTF and three.js; a reader that
keeps a TRS rather than a matrix (the authority's `worldPose`) is exact
wherever every ancestor's scale is uniform and approximates otherwise
(component-wise scale, Unity's `lossyScale`), and says so. A negative scale
mirrors; physics reads a thing's size as |scale| (KHR_physics_rigid_bodies).
Vectors name their frame (§9.2): a `pivot` and a part motion's `pivot` are in
the thing's (or part's) own frame before scale; `motion.center` and
`motion.points` in its parent's.

## 10. Extending the protocol

- **A new feature is a new component** (§4). Register a bare name by
  documenting it here and in the catalogue; otherwise use your domain
  prefix.
- **A new request** (a verb, a `use` action, a script command) is the
  authority's practice: it changes no old log, and it grants nothing — its writes pass
  `admit` like everyone's.
- **The four operations, the envelope, the kinds and the fold are fixed.**
  They are the kernel (`trial-kernel`, §4): the gate refuses a change to them
  that doesn't carry its translator, changelog line and vectors.
  Changing them is a new `minor` (or a new `v`) in genesis; a reader that
  doesn't know a world's minor refuses the world rather than folding it to
  a different digest. One exception, before release: the batch body's
  `followUps` (§3) was added to this protocol **at minor 0**, because it had
  not been released. Every such log written so far was written by the reference
  authority on its own branch, and every one folds to the same digest with
  or without the field (the fold applies marked ops like any op); the only
  readers that refuse it are that branch's own earlier builds. Bumping to
  minor 1 would have made every trial world and conformance log carry a
  version that marks nothing a released reader could disagree on. From
  release on, the rule above holds without exception.

## 11. Conformance

`conformance/` holds the suite:

- `EXAMPLE-01.jsonl` folds to status `ok` and digest
  `80a9ef2d5b8ee340e811d6b3068d65b480c6d0e1643e0e1e6b4ab961c317b581`.
- `logs/` — hostile logs (duplicate keys, `-0`, big integers, surrogates,
  nested batches, bad names, purges of purges, bad genesis shapes…), each
  with the status, digest and diagnostic codes a conforming reader gives.
- `reader.py` — the reference reader, written from this document;
  `test_reader.py` its tests. `chain.py` and `test_chain.py` — the chain,
  signatures and purge (§12). `ed25519/` — the key vectors (§13).

`bun tools/protocol/run.ts conformance` folds every log with the JavaScript fold
and the Python reader and fails on any difference in status, digest or
diagnostics. **The prose wins; the vectors are its tests**: where they
disagree, the vector has the bug, and it is fixed to match the prose. A
conforming reader must give each log's **status and digest**; the diagnostic
codes in `expected.json` are informative (the two reference readers agree on
them, and the suite holds them to it), not part of conformance.

## 12. The chain, signatures and purge

- **The chain.** `head(-1)` = 32 zero bytes; `head(i)` = sha256(`head(i-1)`
  ‖ sha256(UTF-8(JCS(skeleton(i))))). The **skeleton** is the entry without
  `head`/`sig`, where each set op's `value` + `salt` becomes `commit` = hex
  sha256(UTF-8(salt) ‖ UTF-8(JCS(value))), and an `act`/`say`/`sim` body
  becomes `{commit}`, with commit = hex sha256(UTF-8(body.salt) ‖
  UTF-8(JCS(body without salt))). In a chained log every `set` carries a
  `salt` (base64url, ≥ 16 random bytes). The fold ignores `salt` and
  `commit`.
- **Chain points.** Any entry may carry `head` (hex) and `sig`: base64url
  Ed25519 over UTF-8 `"eidoverse-head:<world id>:<seq>:<head hex>"`, by
  the sequencer key named in genesis (handoffs are reserved, §13). The authority signs
  at least every write it commits. Two signed heads for one seq are published
  evidence.
- **The client's head check is RESERVED.** It is the one defence against a
  sequencer rewriting its own history. Its shape is not fixed by this
  protocol: no client can make the check today, because the wire strips
  `head` and `sig` from every entry it sends, and no client is held to it.
- **Purge** (`kind: "purge"`, `body {values: [{seq, op?}, …]}`) is the one
  rule that changes the record. **Who decides:** the host operator, outside the
  request path. No request writes a purge, and the reference server has no verb
  for one; an operator applies it to the stored log by this rule. A purge an
  owner asks for through the request path, with a named decider, is future
  work, not part of this protocol. Each target folds as *absent(purged)* at
  every point in time — a defined value, distinct from deleted — and a
  later `set` of the same component replaces it normally. Purgeable: a
  `set`'s value (the id, component name and position never are, so the fold
  can still say what was purged), and the whole body of an `act`, `say` or
  `sim` entry (an act body the authority reads back, §1, may be purged like
  any other: its readers take it as unknown). A purge rewrites the stored line, replacing `value` + `salt`
  with `commit`; the skeleton is unchanged, so every head still verifies
  and the bytes are gone. A purge of a purge, a target at or after the
  purge's own seq, a target that isn't a value, and a `roles:` value
  (governance is reversed by acts, never erased) are each diagnosed and
  ignored. Blobs are purged by deleting their bytes; since the fold never
  reads bytes, the world doesn't change.
- **A change outside this rule is detected, not enforced.** A value stored as
  `commit` that no purge names folds as *absent(purged)*, like a purged one,
  and is diagnosed `commit-unpurged` naming its line. Nothing else follows:
  writes go on, and restoring the line is the operator's to do.

## 13. Genesis and governance

- **Genesis** (seq 0, `kind: "genesis"`, actor `system`, verb `genesis`):
  `body {dialect: "eidoverse-log", v: 4, minor: 0, nonce, owners: [[<key>…], …],
  sequencer, quorum?, rewind_window?, parent?}`. Exactly those fields within a
  known minor. `dialect` and `v` are the shape every eidoverse log has
  announced itself with since its first genesis (`{v, dialect}`); `v` is the
  protocol's number, and it is written here and nowhere else. `nonce` is ≥ 16 random bytes, canonical unpadded base64url (two
  worlds founded with the same keys must not share an id). `owners` is a list
  of lists of keys (list 0 is the founder's, list 1 the host's operator key);
  what more the lists mean (rank tiers, a quorum per tier) is reserved with
  governance, below, and today only the founding act reads list 0; `parent {world, seq, head}` names the world a fork came from.
  Genesis seeds no state: the founding act then writes `@world` through the
  gate. A missing or malformed genesis means "no world"; a `dialect`, `v` or
  `minor` the reader doesn't implement means "unknown version" and no world.
- **Keys** are `ed25519:<base64url of 32 bytes>`. Registration refuses a key
  that is small-order in any sign-bit encoding or has y ≥ p; verification
  is cofactorless with canonical S and R (the `ed25519/` vectors).
- **Governance is RESERVED.** Handoff, quorum, reclaim and rewind are designed
  but not part of this protocol yet; the full draft rules (GOV-1 to GOV-5, the
  rewind window, the merge rule) are kept on the project wishlist until a
  server implements them. What is fixed now: the entry kind `sequencer` and the
  genesis fields `owners`, `sequencer`, `quorum?` and `rewind_window?` are
  reserved names (`owners` with the shape above; every one of them a reader
  carries and does not interpret). The fold never
  reads a `sequencer` entry. **The reference server never writes one and
  refuses to serve a log that holds one**: such an entry may have moved the
  writer role somewhere the server cannot check, so it says so ("governance is
  reserved in this server … Nothing was changed") instead of writing after it.
  `conformance/gov.py` is the reference reader for the draft rules, kept so the
  draft stays testable; it is not normative. Moving a world and forking it are
  different: a fork is a new genesis naming its parent. Nothing is atomic
  across worlds.
- **Forks.** A fork's genesis carries `parent {world, seq, head}`: the world it
  was copied from, the seq it was copied at and that seq's chain head. The acts
  that copy the parent's state are verb `fork-copy`, so a reader tells an
  inherited thing from one born in the fork. Merging a fork back into its
  parent is RESERVED with governance (the draft rule is on the wishlist).
- **Whose key is tier 0.** A world's founder holds tier 0 with a key made on
  their own machine (the authority's `create-world {ownerKey}`). A host's
  custody keys (sequencer, operator) are never the founder's. A world founded
  without one has an empty tier 0, and its operator key (tier 1) is its top
  governance key. A **translated** world's tier 0 is always empty (§14):
  nothing can yet bind a key to the old world's owner, so a translation names
  no founder. Today most worlds are founded without a key (a browser or an
  agent sends none), so an empty tier 0 is the common case, not the
  translated one's alone: the reserved governance draft must allow ONE
  attested fill of ANY world's empty tier 0 later, once something can vouch
  that a key belongs to the world's owner (for a translated world, its old
  owner). Genesis hashes into the world id, so the fill is a later entry,
  never an edit of genesis.

## 14. Worlds from the first protocol

The first protocol (an untyped verb log) is retired. An old world's log can be translated once, one way, into a world of
this protocol. A translated log is an ordinary log of this protocol, and these hold for it:

- **Every old entry is kept.** Each appears in the new log as an `act` with verb `imported` (`body {verb, args, from}`)
  or as a `say`, followed by the change it produced. Fields with no component in this protocol ride along as
  `imported:<name>`; a person's grant this protocol has no rung for (v1's `spectator` or `none`) rides as
  `imported-roles:<id>`. Nothing of a world is dropped quietly: what a translation drops or renames by design is listed
  by the translator, and the old log is kept beside the new one, never written.
- **Main's water volume and air boxes are carried** as zone things (§4's water body): a `water {center, size, …}` fills
  a box `zone` on its own thing (no model or light, centred on it) or on a child at its centre, absorption σ as
  `attenuationColor` e^−σ over `attenuationDistance` 1 m, scatter as `scatterColor`, other fields in `imported:water`;
  each `air` box is a child `zone {box, size, priority: 1}` + `water-exclusion {}`, its centre and `q` its transform.
  The report lists each under `mapped` with the things it became.
- **Main's climb routes, collision toggle and environment are carried**: each `traversal` route is a child thing with
  `climb {points: path, reach: radius, speed}` and `label: name` (main's clamps); `collision {enabled: false}` is
  `collider {enabled: false}`; `environment`'s `spawn` is `@world.spawn` (a later one a `spawn-point` thing), `bounds`
  `@world.bounds`, `floor` `@world.terrain {kind: 'flat', height: floor}` (a world with a terrain keeps it, and the floor
  is listed under `unmapped` as the conflict), `sky` `@world.sky.gradient` (sRGB to linear) and
  a directional `light` thing (main's sun, defaults included), `particles` a `particles` child naming a
  derived dust document with main's count, range and colour (within the effect limits). What has
  no home (the sky's `ambient`, a value an effect clamps, an unknown key) rides `imported:<component>` on its thing and
  is listed under the report's `unmapped`.
- **Main's vehicle is carried**: `vehicle {helm, exit, speed, turnRate, minY?, maxY?, probes}` is `drive {maxSpeed: speed,
  turnRate, climbRate: speed}` on its thing (main's clamps) and a helm child, a socket at `helm` with `station {action:
  'drive', input: {move: 'drive'}, exit}`; `minY` and `maxY` are two hidden walls only that vehicle meets (`collider {blocks:
  ['hulls'], layer: [its own band layer]}`, its thing `collider {mask: [1, that layer]}`: another hull passes) set off by the hull's measured box, so its origin keeps main's band (unmeasured: at `minY`/`maxY`, the
  whole hull in it); `probes` ride `imported:vehicle`, listed under `unmapped` (collision is the hull's own collider). A
  water volume's `speed` is a `physics-area {kind: 'speed', factor: speed / 2.4}` on its zone (2.4 m/s: the volume
  stroke here, shared/water.js; it scales walking and wading there too). Driving is not
  bit-identical to main's (a collider sweep, not ray probes). The translator's DEFERRED table is empty.
- **A world that uses a deferred feature is refused**, naming each use (component, entity, actor, seq): a water volume
  or air box on `@world`, which has no frame to hold one (`water` on `@world` without one is the world's water level and
  is carried). No approval overrides the refusal. Carried
  inert as `imported:<name>` they would change the world in a way that matters: a pool nobody can swim in, a ladder nobody
  can climb, a car nobody can drive, a wall the old world let people through. A translated world would look whole and
  play broken, so the translation waits until this protocol carries each feature, rather than translating a world that
  silently lost them.
- **A translation names no founder and carries no owner's signature.** First-protocol logs record accounts, never keys,
  so nothing can bind a key to the old world's owner: the new world's tier 0 is empty (§13), and the approval is the
  host operator's countersignature alone, an ed25519 signature by the custody operator key (never the sequencer key)
  over `eidoverse-approve-translation:<world>:<report hash>`. It rides in the new log as the system's
  `translation-approved` act right after `repair-shapes` (`body {report, approval: {over, owner: null, operator: {key,
  sig}, noOwner}}`, `noOwner` saying in words that no owner was attested). The fold never reads it (§1).
- **The translator is named** in the system's `translated` act (`body {from: {…, translator}}`), so a reader knows which
  rules produced the log.

The operator's procedure (the dry-run report and its hash, the in-place swap, rollback) is in
`docs/TRANSLATING-OLD-WORLDS.md`.

## Version history

A log says which protocol reads it in its genesis, `{dialect: "eidoverse-log",
v}`. File names, wire fields and code don't carry the number.

| `v` | What it is | Text |
|---|---|---|
| 1–2 | The first world log: an untyped verb log folded by its reader (`genesis {verb: "genesis", args: {v, dialect}}`); dialect 2 added `force` and `punt` | `history/PROTOCOL-v1.md` |
| 3 | The deterministic-physics amendment: a sim fold over sim-scoped entries, sim epochs (`dialect 3`) | `history/PROTOCOL-v2-sim.md` |
| 4 | This protocol: typed entries (`change`, `act`, `sim`, `say`, `purge`, `sequencer`), the authority, opaque identities, the signed chain and governance keys. Its physics is `PHYSICS.md`. Before release, minor 0 gained the batch body's `followUps` and §6a, and renamed a number of pre-release words; each rename and how an older spelling is still read is `spec/history/PRE-RELEASE-RENAMES.md` (informative). Those readings serve the playtest worlds written before the renames, and go at release. | this document |

Logs of `v` 1–3 are not read at runtime; §14 translates one, once, into a new
world.
