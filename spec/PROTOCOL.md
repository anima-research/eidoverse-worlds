# The eidoverse world-log protocol, v1

**License: CC0 1.0 (public domain).** This document and the fixtures beside
it may be implemented, copied, and modified by anyone, from any codebase,
under any license, without permission or attribution. The reference
implementation in this repository is separately licensed (AGPL); *the
contract is free*. SMTP being free is what made the mail ecosystem exist.

Status: v1, normative for logs whose `genesis` entry says `dialect:
"eidoverse-log", v: 1`. The words MUST/SHOULD/MAY are used in the RFC-2119
sense. Where this document and the reference implementation disagree, the
implementation has a bug — file it.

## 0. The one idea

**A world is its log.** There is no scene file. The log is an append-only,
totally ordered sequence of *intent verbs*; folding it from the beginning
yields the world, on every implementation, at any time, forever. Everything
else — snapshots, clients, servers — is derived cache or transport.

## 1. The log

- Serialization: JSON Lines. One entry per line, UTF-8, no NUL bytes.
- Entry shape: `{ "seq": int, "ts": int, "actor": string, "verb": string,
  "args": object }`.
  - `seq`: dense, starts at 0, never renumbered. `ts`: epoch milliseconds,
    the sequencer's clock. `actor`: who spoke (§6). `args`: verb-specific.
- A fresh log MUST open with `{verb: "genesis", args: {v: 1, dialect:
  "eidoverse-log"}}` (actor `world`). Readers MUST treat an absent genesis
  as v1 (logs predate the marker).
- **Folding is total.** No entry may error a fold: malformed or unknown
  entries shape nothing, and the log keeps them. A replay must never fail
  and never kick anyone.
- **Unknown verbs and unknown component types MUST be preserved**, not
  dropped. This is the entire forward-compatibility story.

## 2. Folded state

Folding produces, at minimum:

```jsonc
{
  "entities": { "<id>": { "pos": [x,y,z], "yaw": r, "lib": "path"?,  // things; no lib = an Empty (§3.1)
                           "scale": s?, "actor": who, "ts": ms, "collide"?,
                           "kind": "light"?, "color"?, "intensity"?, "range"?, "keep"?, "day"?,
                           "comp": { "<type>": <opaque data> }?,      // §4
                           "parent": { "to", "slot"?, "offset"?, "yaw"? }? } },
  "mounts": { "<body-id>": { "to", "slot"?, "offset"?, "yaw"? } }?,   // §5
  "roles":  { "<id>": { "role": "owner|builder|visitor", "gen"?: true,
                         "sub"?: "durable id" } },                    // §7
  "behaviors": { "<id>": { "src", "runtime"?: "client", "attach"?, "caps"?,
                            "knobs"?, "author", "ts", "state"? } }?   // §8
}
```

Implementations MAY fold more (chat windows, ban lists); conformance is
measured on the fields above (see `fixtures/README.md`).

## 3. Verbs and their fold semantics (normative)

| verb | args | fold effect |
|---|---|---|
| `genesis` | `{v, dialect}` | nothing (version marker) |
| `spawn` | `{id, lib?, pos?, yaw?, q?, scale?, collide?}` | create **or replace** entity (see §3.1). An absent (or null) `lib` creates an **Empty**: an entity with only a transform; a present but empty `lib` (`""`) folds to nothing *(Empty: amendment 2026-10-01, §3.2)*. `q`: §9.1 *(amendment 2026-09-26)* |
| `place` | `{id, pos?, yaw?, q?, scale?}` | update transform; re-stamps rest pose. Orientation per §9.1 *(`q`: amendment 2026-09-26)* |
| `light` | `{id, pos?, color?, intensity?, range?, keep?, day?}` | create light entity; re-issuing on an id that already folds as a light is a **partial update** (absent fields keep their prior value); a non-light holding the id is replaced wholesale (§3.1) |
| `remove` | `{id}` | delete entity; children mounted on it get their **absolute pose computed and stamped** (parent pos + offset rotated by the parent's orientation, §9.1), then orphaned; body mounts onto it are cleared |
| `comp` | `{id, type, data\|null}` | `entities[id].comp[type] = data`; null deletes. **Blind**: data is opaque to the fold. Writers SHOULD keep data ≤ 8 KB |
| `motion` | `{id, type, …params}` | sugar: `comp[motion] = args-minus-id`; `type: null` deletes. If `t0` absent, fold stamps `t0 = entry.ts` |
| `mount` | `{id, to, slot?, offset?, yaw?, q?}` | if `id` is an entity: set its `parent`; else record in `mounts` (a body). No-op if `to` missing or `id == to` |
| `dismount` | `{id, pos?, yaw?, q?}` | clear parent/mount; if entity and pos given, **stamp** it (§9 invariant) |
| `use` | `{id, action}` | **nothing** — a cause, kept as history; effects are separate entries |
| `force` | `{at:[x,y,z], radius?, power?}` | **nothing** — a physical cause (blast/gust); LIVE clients apply it to bodies they own, under those bodies' consent; replay never re-detonates *(dialect v2)* |
| `punt` | `{id, power?, dir?}` | **nothing** — a physical cause on an entity; a LIVE client volunteers to simulate the flight via an animation lease (§5), and the landing arrives as an ordinary `place` *(dialect v2)* |
| `say` | `{text}` | chat (implementation-defined window; not conformance-scored) |
| `grant` | `{id, role?, gen?, sub?}` | update `roles[id]`; missing role/gen inherit current; `sub`, when present, binds the grant to that durable identity (§7) |
| `behavior` | `{id, src, runtime?, attach?, caps?, knobs?}` or `{id, remove: true}` | bind/unbind a runtime script (§8); author = entry actor. `runtime` folds only as `"client"` (a client mod offer, §8); absent = the server sandbox |
| `bstate` | `{id, data}` | `behaviors[id].state = data` (script kv persistence) |
| `terrain` / `grass` / `sky` / `weather` | opaque bags | world-scope singletons (grass `{clear: true}` deletes; weather merges into sky). Grass bags speak eidoverse-video's `createFlora` (species/height/density/color/rows); legacy makeGrass bags in old logs are mapped client-side, never rewritten |
| `asset` | `{name, path}` | append to the world's asset palette (dedup by path) |
| anything else | — | **nothing, and the log keeps it** |

### 3.1 The id namespace is flat, and the newest word wins

A `spawn` whose id already exists REPLACES the previous holder **wholesale**:
transform, component bag, and parent attachment are those of the new entry
alone (nothing is inherited — a bag you want to survive re-authoring is a
bag you re-author). The same replacement applies across kinds: a `spawn`
landing on a light id, or a `light` landing on a model id, replaces it, and
an Empty (§3.2) is a kind like the others — a model spawned over it, or it
spawned over a model, replaces wholesale. The
one exception is `light`-on-`light`, which merges as a partial update (the
table above) — brightening a lamp is not re-authoring it.

*Erratum (2026-08-09):* this section previously read "no-op if id exists"
for `spawn`. Every reference fold since genesis has overwritten, so every
persisted v1 log already means what this section now says — the text was
wrong, not the worlds. Documented under §0's rule that the implementation
wins the argument; no dialect bump.

`keep` and `day` (lights) fold into the entity (§2) and carry client policy
in world state, not rendering guarantees. `keep: true` gives the light
**first claim on a casting slot** and exempts it from perf-governor
shedding — top *priority*, not an unbounded promise: a client's slot pool
is finite, and past it a kept light still glows without casting. `day:
false` opts a light out of the time-of-day cycle: it burns at its authored
intensity at noon (the deliberate porch light). Absent or true, a placed
light dims toward midday the way lamps do. Both are stored only in their
non-default state (`keep: true`, `day: false`); partial updates merge them
like any other light field. Pinned by fixture `05-lightpolicy`.

### 3.2 Empties *(amendment 2026-10-01)*

A `spawn` with no `lib` folds to an **Empty**: `{pos, yaw, q?, scale?,
collide?, actor, ts, …}` with neither `lib` nor `kind` on the record. It is
an entity in every other respect — it can be placed, mounted and carried,
removed, carry any component (§4), and other entities can mount onto it — so
it serves as a pivot, a group parent, a spawn point or a target. Clients
draw nothing for it (an editor MAY show a gizmo while editing). Re-spawning
an Empty as an Empty keeps its identity for deeds (`born`); a model spawned
on its id is a new thing, as across any kinds.

*Versioning.* Before this amendment the reference fold dropped a lib-less
spawn, and no persisted log carries one (the reference corpus was checked),
so every old log folds byte-identically. A reader that predates it folds an
Empty to nothing: it shows nothing (which is what an Empty looks like), its
`comp`/`place` entries fold to nothing, and a `mount` *of* the Empty is filed
under `mounts` as if the id were a body (§5) — inert, since no body by that
name arrives. Same footing as `q` (§9.1): an optional-argument change, no
`genesis` bump, flagged here for review. Pinned by fixture `06-components`.

## 4. Components

Entities carry a bag of `type → data`. The fold is blind: no taxonomy, no
registry, no validation beyond size. Meaning lives in whichever evaluator
consumes a type. Known types in v1, with their contracts:

- **`sockets`** `{<slot>: {pos: [x,y,z], yaw?, pose?: "sit"|"sitchair"|"lie"}}`
  — named attachment points in the ENTITY's local frame. A mount referencing
  a slot seats the rider there; the rider composes with the entity's live
  transform (a sitter rides a swinging swing for free).
- **`motion`** (and **`motion:<part>`** for one named node of the model) —
  *functions of time*, never frames. Types: `pendulum {axis, pivot, amp,
  period, phase, damp, maxAmp, t0}`, `spin {axis, pivot, degPerSec|rpm,
  phase, t0}`, `orbit {center, radius, degPerSec, phase, face, t0}`, `bob
  {axis, amp, period, phase, t0}`, `path {points, speed|duration, loop:
  loop|pingpong|once, face, t0}`. Every client evaluates the same closed
  form at its own now. **Generous reading is normative**: `amplitude` is
  `amp`; `axis` accepts `"x"|"y"|"z"|"-x"|…` as well as `[x,y,z]`; missing
  `damp` is 0 (perpetual — friction is opt-in); missing `t0` is stamped at
  fold. Unknown motion types render as stillness, never errors.
- **`reactions`** `{<action>: {impulse: rad/s, …}}` — server-side: a `use`
  with a matching action emits ordinary logged effect entries (e.g. a
  velocity-matched pendulum impulse) with `{cause: seq, by: actor}`
  provenance. Replay folds the effects; it never re-runs the reaction.

- **`light`** `{color?, intensity?, range?, keep?, day?}` *(amendment
  2026-10-01)* — a point light at the entity's origin, on **any** entity: a
  model and a light on one entity is a lamp; a light on an Empty is a bare
  bulb. Fields and defaults are the `light` verb's (§3.1: color `0xffd9a0`,
  intensity 16, range 10 m, `keep: true` = first claim on a casting slot,
  `day: false` = burns at noon); a field of the wrong type reads as its
  default. The light follows the entity's live transform (motion, mounts).
  A part that needs its own position (a bulb at the top of a lamp) is a child
  entity, not an offset. The legacy spelling — an entity created by the
  `light` verb (`kind: "light"` + top-level fields) — stays valid forever and
  means the same thing; if an entity carries both, `kind: "light"` wins.
  Writers SHOULD NOT add a `light` component to a `kind: "light"` entity
  (the reference door refuses it).
- **`collider`** `{shape: "exact" | "box"}` *(amendment 2026-10-01)* — how
  bodies collide with the entity: `exact` against its triangles, `box`
  against its bounding box. Absent, a client decides by size. It overrides
  the legacy `collide` argument of `spawn` (§3), which stays valid; a shape
  other than `exact`/`box` is ignored (the legacy value, or size, decides).
  Client-side meaning only; the fold is blind to it as to every type.

Everything else in a bag is somebody's annotation. Preserve it.

## 5. Two planes

- **Authored plane**: the log. Low frequency, high value, persisted forever.
- **Presence plane**: avatar/body poses, emotes, transient gestures, reach
  descriptors, ~15 Hz, interpolated, lossy, **never persisted**. Anything at
  frame rate belongs here; writing per-frame transforms into the log is
  non-conforming. A reach travels as a *declarative relation*
  (`pose.reach`, shared/reachwire.js) — a target, not solved bones — and
  every client re-solves it locally with the same closed-form IK; the
  server relays the bag opaquely. Semantic rig state travels the same way:
  `pose.wingsFolded` is a boolean intent, never implementation-specific wing
  quaternions; each renderer applies it through the worn rig's own fold path.
- **The plane-transition invariant**: anything returning from live motion to
  rest MUST stamp its absolute pose into the verb that ends the ride
  (`dismount {pos, yaw}`; `motion {type: null}` + `place`). The log never
  depends on reconstructing where a ride was.
- **Animation leases** extend the presence plane to entities (docs/leases.md):
  one negotiated holder streams an object's transforms; the arbiter (the
  body's owner, or the sequencer for entities) commits the resting `place`.
  The plane-transition invariant is enforced BY the sequencer for entity
  leases: release, disconnect, and staleness all commit the last transform.

## 6. Actors

- `actor` is the durable attribution ink of the permanent record.
- Reserved: `world` (the sequencer's own acts), `bhv:<id>` (script effects),
  `*` (wildcard subject, never an actor). Doors MUST refuse clients claiming
  these. Control characters in ids are stripped; ids are ≤ 64 chars.

## 7. Authority

Rights ladder per world: `visitor` (say, use, mount **yourself**) <
`builder` (+ spawn/place/remove/light/comp/motion/behavior/cargo-mount) <
`owner` (+ terrain/grass/sky/weather/grant, and a `behavior` carrying
`runtime: "client"`, §8). `gen` is an orthogonal spend
capability (introducing new assets). A world with no owner is open
(everyone builds); the first embodied joiner of a brand-new world becomes
its owner. Grants are log entries like everything else. A grant carrying a
`sub` is worn only by that durable identity; a display name is a nameplate,
not a deed.

## 8. Runtime scripts

`behavior` binds a content-addressed script (`store/scripts/<sha256-16>.js`)
into the world, in one of two runtimes.

- **Server (no `runtime`).** The script runs server-side, sandboxed,
  budgeted; it affects the world ONLY by emitting ordinary logged verbs,
  gated by its author's live rights. Script kv persists via `bstate`
  entries.
- **Client (`runtime: "client"`).** The binding is an OFFER to visitors'
  clients, not a resident of the server: a sequencer MUST NOT execute it.
  Each visitor's client runs it only on that visitor's consent (per script,
  keyed to its content-addressed `src`, or per world), in that visitor's
  own context; whatever it does reaches the world as the ordinary verbs and
  presence that visitor's client sends. Offering one is an owner act (§7).
  The reference client hosts these as in-page modules with the visitor's
  full authority (docs/leases.md, "Self-animation"; client/lib/mods.js);
  `attach`, `caps` and `knobs` have no meaning in this runtime there.

**Replay never re-executes scripts** in either runtime — it folds what they
emitted (or, for client mods, what the consenting clients sent). (Sandbox
limits, consent UI and in-page hosting are implementation policy; the log
semantics above are the protocol.)

## 9. Conventions

Metres. Y-up. Right-handed. `yaw` in radians about +Y, with forward = +Z and
`yaw = atan2(x, z)` of the facing vector. Transforms position/yaw(+scale),
quaternions where full rotation is needed — never Euler triples. Colors are
integers (`0xffd9a0`). Times are epoch milliseconds on the sequencer's
clock. Entity ids are opaque strings; asset paths are content-addressed
under `store/` (`<sha256-prefix>.glb`) — a binding pins exact bytes.

### 9.1 Orientation: `q`, with `yaw` as its friendly subset

*Amendment (2026-09-26, Hesperus — draft on a workbench branch, not yet
ratified; no dialect bump, see Versioning below).* An entity's orientation MAY be a full unit quaternion `q:
[x, y, z, w]` (same layout as the pose wire), for things that are more than
turned: a crate on its edge, a lamp knocked flat, anything a lease let
tumble. `yaw` stays exactly what it was — and is the whole vocabulary a
writer needs for anything upright.

- **Folded state.** An entity folds `q` only when a verb gave it one. When it
  has a `q`, that is the whole truth, and its `yaw` is always that `q`'s
  *heading* (atan2 of the rotated +Z, as above; for a thing facing straight
  up or down, the heading of its rotated +Y, negated when it faces up — the
  continuous limit). So a yaw-only reader is always right about which way a
  thing faces, and a log that never says `q` folds exactly as before.
- **`spawn`** with a usable `q` folds that orientation (normalized); else
  `yaw` as always.
- **`place` / `dismount`**: a usable `q` replaces the orientation (and wins
  over any `yaw` in the same args). A bare `yaw` means *turn it about +Y to
  that heading*: an upright thing just turns, and a tilted thing turns where
  it lies, keeping its tilt (`q' = R_y(yaw − heading(q)) ⊗ q`). Only an
  explicit `q` stands a thing back up. Neither → orientation unchanged.
- **`mount`**: `q` is the rider's orientation relative to its carrier, like
  `yaw`. On `remove`, riders' offsets rotate by the carrier's full
  orientation and their orientation composes (`q_carrier ⊗ q_rel`); a log
  with no `q` anywhere takes the original yaw arithmetic unchanged.
- **Usable** = an array of four finite numbers with a nonzero norm; anything
  else shapes nothing (the §1 totality rule), and a spawn falls back to its
  `yaw`.
- **Numerics.** The fold computes headings and yaw-rotations with owned
  trig (`shared/simmath.js`, PROTOCOL_v2 Covenant I's kernels) — never host
  `sin/cos/atan2` — so every runtime folds the same bits.
- **Readers that only speak yaw** (older clients, agent tools) keep working
  and stay honest about facing; they will show a toppled thing upright.
- **Versioning.** `q` is an optional argument on existing verbs, not a new
  verb, so under §10 it takes **no `genesis` bump** — the same footing as
  `collide` on `spawn` and `keep`/`day` on `light` (each also added without
  one, and `collide` also made pre-amendment readers see an object
  differently). Rows carrying `q` are tagged in the table instead. ⚑ for
  review: a yaw-only reader silently shows a toppled thing standing, and
  `genesis` alone could never announce this to a world that predates it (it
  is written once, at creation) — if a marker is wanted, the precedent is
  PROTOCOL_v2's mid-log `epoch` entry, not a number.

## 10. Extending the protocol

The verb set is **closed on purpose**; three lanes are always open:
state-shaped extensions via `comp` types, event-shaped via `use` actions,
semantic via uploaded scripts. A new verb is an amendment: rare, deliberate,
and announced by a `genesis` dialect/version bump in logs that use it.
Component-type *meanings* (the §4 contracts) grow by documentation in this
spec, so two implementations that both know `sockets` agree on what it does.

## 11. Conformance

Fold each `fixtures/*/log.jsonl` from empty state; compare your folded
result with `folded.json` (fields of §2 only; see `fixtures/README.md` for
the comparison rule). The fixtures are generated by the reference
implementation — if you disagree with one, one of us has a bug, and the
argument will be short.
