# The eidoverse world protocol

**License: CC0 1.0 (public domain).** This document and the conformance
suite beside it (`conformance/`) may be implemented, copied, and modified
by anyone, from any codebase, under any license, without permission or
attribution. The reference implementation in this repository is separately
licensed (AGPL); *the contract is free*. SMTP being free is what made the
mail ecosystem exist.

Status: normative for logs whose genesis says `dialect: "eidoverse-log", v: 4,
minor: 0` (the version history is at the end).
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
   word; nobody invents a state word — a new feature is a new component
   (§4, §10).
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
| `for`, `grant` | reserved for acting on someone's behalf; until identities have keys, an entry carrying `for` is malformed |
| `by` | legacy (the lab's name for `actor`): allowed, and every reader MUST ignore it. Writers MUST NOT write it |

An unknown field, a `seq` field, a missing or non-string `kind`/`actor`/
`verb`, a non-object `body`, a bad `cause`, or a missing, fractional or
decreasing `ts` makes the entry malformed: it shapes nothing and the reader
reports it in diagnostics, never in the world.

**The kinds.**

- **`genesis`** — entry 0, and only entry 0 (§13).
- **`change`** — the fold's only input (§3).
- **`act`** — a request as it was sent, with its refusal if it was refused.
  Acts are history: the fold never reads them. A change entry's `cause` is
  usually the act that asked for it.
- **`sim`** — a physics intent (a launch, a lift, a catch, the engine's
  digest); read only by readers that carry the world's engine
  (`PHYSICS.md`).
- **`say`** — chat: `body {text, to?}`. Never world state.
- **`purge`** — the one rule that changes the record (§12).
- **`sequencer`** — governance: handing the writer role on, or an owner
  override (§13).

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
folded.

## 3. State operations and their fold semantics (normative)

A `change` entry's `verb` and `body` are one of:

| verb | body | fold |
|---|---|---|
| `create` | `{id}` | a new, empty entity; does nothing if `id` is live |
| `set` | `{id, comp, value?, salt?}` | replace that one component's value; does nothing if the entity is missing, or if `value` is **absent** (`null` is a value) |
| `delete` | `{id, comp?}` | with `comp`: remove that component (nothing if it isn't there); without: remove the entity (never `@world`) |
| `batch` | `{ops: [{verb, id, comp?, value?, salt?}, …]}` | the ops above, applied in order |

- A batch never contains a batch.
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
  reference authority and clients write `<slug>-<26 base32>`), so two forks
  rarely mint alike; that makes renames on merge rare, never unnecessary. An
  entity id never has an identity's shape (`u-` and 20 base32 letters).
- **Identities** (actors, and keys such as `roles:<identity>`):
  `[a-z0-9-]{1,64}`, opaque. The mapping from an identity to a person lives
  outside the log, so purging a person never needs the log's skeleton.
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
  their fields, defaults and meanings are in `shared/protocol/componentspec.js`; a
  authority answers `schema {component?}` with the same. Among them: `transform
  {pos, q, scale}`, `model` (a library path), `label`, `description`, `parent {to, socket?}`,
  `pivot`, `light`, `motion`, `sockets`, `params`, `reactions`, `lock`, `hidden`, `disabled`,
  `openable`, `physics`, `grabbable`, `particles`, `script:<name>`,
  `joint:<name>` (reserved: refused until an engine carries joints), and on
  `@world`: `about`, `bounds`, `spawn`, `roles:<identity>`, `default-role`,
  `sky`, `terrain`, `terrain-grid`, `terrain-tile:<i>-<j>`, `grass`, `physics-engine`, `surface:<name>`,
  `script-settings`, `blueprints:<hash>`, `assets:<key>`, `capacity`, `schemas:<name>`.
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
- **A changed meaning is a new name**, `<name>@<n>` (`light@2`), registered
  before anyone writes it, whose definition says what it `supersedes`. Old
  names are read forever. No component may change how another is read.
- **Every parameter is written down.** The authority writes a component's
  defaults into the stored value when it is created or set, so a reader never
  supplies a value the log doesn't hold, and a later change to a default
  never changes an old world. A parameter's meaning (its units, what it
  does) never changes; a new meaning is a new versioned name.
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
  narrows its type (`physics.shape`); the conformance suite fails when one
  changes, and only additions may be re-pinned. A
  `schemas:<name>` component on `@world` is **optional**: it holds the content
  hash of that name's written definition (shape, units, prose meaning, what
  absence means, an example), and once set it never changes. It adds what the
  pin can't check, the prose, for a world that travels to readers who don't
  share this registry; a world without one is read by this registry, whose
  pinned meanings never change.
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
- **A thing reads like an accessibility tree.** To anyone who perceives by
  reading (an agent's `look` and `inspect`, a screen reader, the inspector),
  a thing is its **name** (`label`), its **description** (`description`: how
  it is described to a text-based reader, alt text, one plain string), then
  what it **can do** and its **state**, generated from its components
  (`openable` → it can be opened, open or shut, locked; `grabbable` → it can
  be picked up; `sockets` → it can be sat on; `sound` → playing; `lock`; …),
  so a description never restates an affordance and can't contradict one.
  `story` is the long-form details beside it (a titled placard, and the
  things it marks). A visible nameplate is not a component: it is a child
  thing carrying `text` (billboarded); the reading above is what
  non-visual readers get.
- **Effects are documents.** A `particles` component names an effect: an
  Essentials name (`fire`) or a stored document's content address
  (`sha256:<64 hex>`, the same bytes as `eido:sha256/<64 hex>`), whose
  emitters are modules (spawn, shape, velocity, forces, rotation, size,
  colour, render) and whose `params` are the knobs an instance may set. A
  document is bounded (how many particles, how long, how fast) and checked
  when it is stored and when it is named, because it runs on every
  visitor's machine. The first protocol's flat bag is still read (a stored
  value is read forever) and no longer written.
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
request moves a copy to a newer version, keeping its own overrides.

## 5. Two planes

- **Authored plane**: the log. Low frequency, high value, persisted forever.
- **Presence plane**: bodies and whatever a hand is holding or dragging —
  poses, emotes, transient gestures, reach descriptors — ~15 Hz,
  interpolated, lossy, **never persisted**. Anything at frame rate belongs
  here; writing per-frame values into the log is non-conforming. A reach
  travels as a *declarative relation* (`pose.reach`, shared/reachwire.js) —
  a target, not solved bones — and every client re-solves it locally with
  the same closed-form IK; the server relays the bag opaquely. Semantic rig
  state travels the same way: `pose.wingsFolded` is a boolean intent, never
  implementation-specific wing quaternions; each renderer applies it
  through the worn rig's own fold path. The same packet carries a body's
  size and a person's voice state, each optional, absence meaning the
  default (or, for voice, *unknown*):
  - `pose.scale` — the wearer's chosen size multiplier for the whole body
    (mesh, eyes, stride, collider); absent = 1. Range 0.5–2.
  - `pose.plateY` — metres the nameplate hangs above the body's measured
    crown, at its authored size (it grows with `scale`); absent = 0 (auto).
    Range −0.3…+0.8.
  - `pose.mic` — this person's microphone is live; `pose.hear` — they are
    hearing voices. Booleans; absent = unknown, never "off".

  Receivers MUST clamp `scale`/`plateY` to their ranges and read a
  non-number as absent; a non-boolean `mic`/`hear` is absent
  (shared/presencewire.js holds the clamps; the server's pose fence applies
  the same ones). `scale`/`plateY` are body state and ride the settled pose
  a server keeps for late joiners, as `wingsFolded` does; `mic`/`hear` are
  a live reading re-sent with every packet and are never part of it. The
  pose packet's fields are `docs/pose-wire.md`.
- **Presence touches the log only through checked acts, and only with what
  the world needs.** The authority checks every body request against its
  own cheap track of each body (speed, reach, solids). Arriving is presence:
  it is never logged. A teleport while present is an act (it resets the
  track), recording who and when, never where from or to, and never what kind
  of client someone uses. Picking something up, putting it down, letting it
  go, throwing and punting are acts that record the request about the thing
  and who handled it, never the body's position or hand: a put's change
  carries where the thing went, and a launch's `sim` entry where it left and
  how fast, which the engine needs. A release with velocity is a launch.
  Continuous contact from a body or a held thing gives no unlogged impulse
  **to the engine**: contact under live simulation authority is presence,
  and enters history only as a settlement or a launch (spec/PHYSICS.md §4). A
  disconnect settles at the last accepted state. (A world whose scripts
  listen for `enter`/`leave` records who triggered each activation, as every
  script act does; that is the world's choice, visible in its scripts.)
- **One clock.** Frames carry the world's authority clock (the one that
  stamps entries' `ts`, never behind the log), and a client measures it by
  round trip (`clock {t0}` → `{t0, t}`). A presence sample may carry its own
  capture time `t` on that clock and its sender's count `seq`
  (spec/PHYSICS.md §5.1).
- **The plane-transition invariant**: anything returning from live motion
  to rest stamps its absolute state into the log (a put's transform, a
  rest caused by its launch). The log never depends on reconstructing where
  a ride was.
- **Body consent.** Every body has one table of act classes (near, follow,
  social touch, intimate touch, pose, shove, move, voice), each set to
  everyone, ask, or nobody, separately for strangers and friends — the same
  table for humans and agents. Silence is no. The authority refuses before
  delivery, and the target's own client has the final word. Consent is
  presence: it is never logged and is not a grant.

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

## 7. The authority

Every write reaches the log through the world's **authority**. A request
`{verb, args}` — `create`, `set`, `delete`, `place`, `batch`, `use`, `say`,
`undo`, `publish`, `update`, `grab`, `put`, `throw`, `drop`, `punt`… — is
first turned into the state writes it would make, whatever word or path
produced it (a request verb, a `use` handler, an undo, a blueprint update, a script,
a rest). Then **one gate, `admit`**, checks those writes, keyed on:

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

Verb-specific checks MAY add to `admit`, never replace it. Accepted, the
authority appends the request as an `act` and its result as one `change` entry
caused by it; a refused write is appended as an act carrying its refusal
(`{code, reason, fix}`) and nothing else is written (refusals that would
only flood the log, such as rate limits, are answered without an entry). **Every appended entry passes the gate**,
acts, says and sim entries included.

**Roles** are components on `@world`: `roles:<identity>` = `{role}`, and
`default-role` for everyone without one (absent: visitor). The reference
authority's ladder is `visitor` < `builder` < `owner` (a `moderator` rank sits
between builder and owner where the roles ladder is enabled): changing any
component of an entity needs builder; changing `@world` needs owner, except
`blueprints:*` (publishing a blueprint, builder). Removing the last owner is
refused, and a world with no owner gives nobody more than visitor. **Two
owner lists, never confused:** governance keys in genesis (§13) decide who
may sign handoffs; roles decide rights inside the world.

**Locks.** `lock: true` on an entity binds everyone, its locker and owners
included: no write may change it or anything attached to it — no component
set, added or removed, no move, no new parent, no new model, no removal —
except the lock itself (by someone who may lift it). Use stays open: a
handler's own writes may change a locked thing's state (an `openable`, a
`label`) but never its `transform`, `parent` or `model`; sitting, scripts'
reads and a new thing placed on top are open too. Anyone who may delete the `lock` component
(builders and owners) may instead send a request with `throughLock: true`;
the log records only the edit. A lock binds authoring, not motion. A lock
has a level: `true` is builder level, and `{rank: "builder" | "moderator" |
"owner"}` names one. Only someone at that rank or above, or whoever set the
lock, may change or remove it or act through it; nobody sets a lock above
their own rank.

**Requests are open; results are closed.** Anyone may add a request word —
a verb, a `use` action, a script command — and no request word grants a
right. Unknown requests are refused at the authority; nothing about them reaches
the fold.

**Moderation** (kicks, bans and their reasons) lives in a separate
moderator log written by the same authority, never in the world log; a world
reader never folds it. Only its effects reach the world, through the gate.

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
person. **Replay never re-runs code**: the fold reads the batch. An auditor
may re-run the source with the recorded event, clock, seed and presence
reads and compare. The reference API, limits and determinism rules are
`docs/SCRIPTS.md`.

## 9. Conventions

Metres. Y-up. Right-handed. Forward = +Z; a heading `yaw` is the angle about
+Y, `atan2(x, z)` of the facing vector. Colors are integers (`0xffd9a0`).
Times are epoch milliseconds on the authority's clock (`ts`). Entity ids are
opaque; asset paths are content-addressed under `store/` (`<hash>.glb`) and
blobs are named `sha256:<64 hex>` — a reference pins exact bytes.

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
heading uses owned trig (`shared/simmath.js`), never host `sin/cos/atan2`,
so every runtime gets the same bits.

## 10. Extending the protocol

- **A new feature is a new component** (§4). Register a bare name by
  documenting it here and in the catalogue; otherwise use your domain
  prefix.
- **A new request** (a verb, a `use` action, a script command) is the
  authority's practice: it changes no old log, and it grants nothing — its writes pass
  `admit` like everyone's.
- **The four operations, the envelope, the kinds and the fold are fixed.**
  Changing them is a new `minor` (or a new `v`) in genesis; a reader that
  doesn't know a world's minor refuses the world rather than folding it to
  a different digest.

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
diagnostics. If you disagree with a result, one of us has a bug, and the
argument will be short.

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
  the sequencer key named in genesis (or the latest handoff). The authority signs
  at least every write it commits. A client SHOULD remember the last `(seq,
  head)` it saw for each world and check that the log extends it on its next
  visit: that is what catches a sequencer rewriting its own history. Two
  signed heads for one seq are published evidence.
- **Purge** (`kind: "purge"`, `body {values: [{seq, op?}, …]}`) is the one
  rule that changes the record. Each target folds as *absent(purged)* at
  every point in time — a defined value, distinct from deleted — and a
  later `set` of the same component replaces it normally. Purgeable: a
  `set`'s value (the id, component name and position never are, so the fold
  can still say what was purged), and the whole body of an `act`, `say` or
  `sim` entry. A purge rewrites the stored line, replacing `value` + `salt`
  with `commit`; the skeleton is unchanged, so every head still verifies
  and the bytes are gone. A purge of a purge, a target at or after the
  purge's own seq, a target that isn't a value, and a `roles:` value
  (governance is reversed by acts, never erased) are each diagnosed and
  ignored. Blobs are purged by deleting their bytes; since the fold never
  reads bytes, the world doesn't change.

## 13. Genesis and governance

- **Genesis** (seq 0, `kind: "genesis"`, actor `system`, verb `genesis`):
  `body {dialect: "eidoverse-log", v: 4, minor: 0, nonce, owners: [[<key>…], …],
  sequencer, quorum?, rewind_window?, parent?}`. Exactly those fields within a
  known minor. `dialect` and `v` are the shape every eidoverse log has
  announced itself with since its first genesis (`{v, dialect}`); `v` is the
  protocol's number, and it is written here and nowhere else. `nonce` is ≥ 16 random bytes, canonical unpadded base64url (two
  worlds founded with the same keys must not share an id). `owners` are rank
  tiers of keys, tier 0 highest; `quorum` optionally gives each tier's
  threshold; `parent {world, seq, head}` names the world a fork came from.
  Genesis seeds no state: the founding act then writes `@world` through the
  gate. A missing or malformed genesis means "no world"; a `dialect`, `v` or
  `minor` the reader doesn't implement means "unknown version" and no world.
- **Keys** are `ed25519:<base64url of 32 bytes>`. Registration refuses a key
  that is small-order in any sign-bit encoding or has y ≥ p; verification
  is cofactorless with canonical S and R (the `ed25519/` vectors).
- **Governance** (`kind: "sequencer"`) moves the writer role, signed by the
  outgoing sequencer or by a quorum of an owner tier. A higher tier may
  **reclaim** a world from the head onward, or **rewind** a lower-ranked
  branch (kept as a record, never folded) while that branch is shorter than
  `rewind_window` change entries (default 1000); beyond that a rewind needs
  every tier-0 key. An empty tier can never act. Moving a world and forking
  it are different: a fork is a new genesis naming its parent. Nothing is
  atomic across worlds.
- **The governance body** is `{key?, owners?, fork?, sigs}`, exactly those
  fields, at least one of `key`, `owners`, `fork`:
  - `key`: the new sequencer key; `owners`: the new tiers, whole (same shape
    as genesis: distinct registrable keys); `fork {seq, head}`: rewind to just
    after `seq` (`seq` < this entry's seq), whose head is `head`.
  - `sigs`: a non-empty list of distinct `{key, v}`; `v` is base64url Ed25519
    over UTF-8 `"eidoverse-gov:<world id>:<seq>:" + JCS(body without sigs)`
    (**GOV-1**). Only signatures that verify count.
  - **GOV-2, rank.** An entry's rank is the highest tier (smallest number)
    whose quorum signed it. A body that is only `key`, signed by the outgoing
    sequencer, is a **handoff** of rank *none*, below every tier.
  - **GOV-3, quorum.** Tier t acts when at least `quorum[t]` of its keys
    signed (genesis `quorum`; absent: 1 for a one-key tier, else a strict
    majority). **An empty tier never acts**, whatever its quorum computes to
    (`all([])` is true in most languages: a reader must say so explicitly).
    When `owners` changes the number of tiers, quorum reverts to the default.
  - **GOV-4, removing.** Removing a tier-t key, or demoting it to a lower
    tier, needs rank t or higher.
  - **GOV-5, adding.** Adding a key to tier t, or promoting one into it,
    needs rank t or higher. So a tier can never fill a tier above itself, and
    **an empty tier can never be filled**: whoever should hold tier 0 must be
    named in genesis. (Without this rule a tier-1 key adds two tier-0 keys,
    and those two remove the original one.)
  - A `fork` needs a rank higher than every branch it orphans, and every
    tier-0 key once the orphaned branch holds `rewind_window` change entries
    or more; a `key` without a handoff is a **reclaim** and needs a rank
    higher than the current branch's.

  The fold never reads `sequencer` entries, so these rules decide who may
  write, never what a world is. The reference reader for them is
  `conformance/gov.py` (with `conformance/test_gov.py`); the reference
  authority does not yet write or validate them.
- **Forks and merges.** A fork's genesis carries `parent {world, seq,
  head}`: the world it was copied from, the seq it was copied at and that
  seq's chain head. The acts that copy the parent's state are verb
  `fork-copy`, so a reader tells an inherited thing from one born in the
  fork. A merge of fork F into its parent P, with base B = F's
  `genesis.parent`, decides each of F's entity ids x (this is the rule; the
  reference implementation doesn't merge yet):
  1. x was live in P folded to B's seq **and** in F it was created by a
     `fork-copy` act (never deleted and re-created): the same thing. Merge it
     per component against its value at the base.
  2. Otherwise, if P has ever had x (live or deleted): a collision. Mint a
     fresh id in P, and rewrite every **typed reference** to x in the merged
     changes (ids-as-keys such as `roles:<identity>` are people, never
     renamed).
  3. Otherwise x is new to P and keeps its id.

  A value that names x without a typed reference (a namespaced component's
  data) is not rewritten; the merge act lists each one as a warning. The
  merge act records its **rename map** `{x: y}`, so provenance and outside
  links can follow. An id chosen to collide is simply renamed: a fork can
  never overwrite a thing in its parent.
- **Whose key is tier 0.** A world's founder holds tier 0 with a key made on
  their own machine (the authority's `create-world {ownerKey}`; a translated
  world's `--founder-key`). A host's custody keys (sequencer, operator) are
  never the founder's. A world founded without one has an empty tier 0 for
  ever, and its operator key (tier 1) is its top governance key.

## 14. Worlds from the first protocol

The first protocol (an untyped verb log) is retired. An old world's log can
be translated once, one way, into a new world
(`bun tools/protocol/world.ts translate <old> <new>`); the old log is read, never
written. Each old entry appears in the new log as an `act` with verb
`imported` (`body {verb, args, from}`) or as a `say`, followed by the change it
produced; fields with no component in this protocol ride along as `imported:<name>`. A
translated world is an ordinary world from then on.

## Version history

A log says which protocol reads it in its genesis, `{dialect: "eidoverse-log",
v}`. File names, wire fields and code don't carry the number.

| `v` | What it is | Text |
|---|---|---|
| 1–2 | The first world log: an untyped verb log folded by its reader (`genesis {verb: "genesis", args: {v, dialect}}`); dialect 2 added `force` and `punt` | `history/PROTOCOL-v1.md` |
| 3 | The deterministic-physics amendment: a sim fold over sim-scoped entries, sim epochs (`dialect 3`) | `history/PROTOCOL-v2-sim.md` |
| 4 | This protocol: typed entries (`change`, `act`, `sim`, `say`, `purge`, `sequencer`), the authority, opaque identities, the signed chain and governance keys. Its physics is `PHYSICS.md` | this document |

Logs of `v` 1–3 are not read at runtime; §14 translates one, once, into a new
world.
