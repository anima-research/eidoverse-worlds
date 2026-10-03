# Edit mode on entities and components — the design

*Status: agreed with the owner 2026-10-01 (vocabulary locked); being built on `edit/components-B` as the
"B" of an A/B against the current Edit Mode PR (tag `edit-A-2026-10-01`). Follows RFC #208 rev 3 and
`docs/COMPONENTS-TODAY.md` (the baseline). Nothing here goes upstream until the owner says so.*

## 1. Vocabulary (locked)

| word | means | test it passes |
|---|---|---|
| **asset** | a raw file: a model, image, sound (`eidoverse/assets/…`, `store/…`) | already the code's meaning |
| **entity** | one thing in a world: a Transform plus a bag of components, optionally a child of another entity | |
| **component** | one capability of an entity (Model, Light, Pendulum, Seats…), an immutable content-hashed record with a parameter schema (`shared/components.js`) | |
| **blueprint** | the master design: an entity with its components and children, saved as one immutable record; copies are spawned from it | a builder, a kid and an agent all read it without a glossary |
| **copy** | a placed blueprint (engine word: instance) | |
| **override** | what one copy changes for itself (this lamp is red); kept across updates | |
| **tool** | something you use to change the world (move, wall brush, paint, sculpt); not stored — its results are | |
| **world** | the whole scene, or connected scenes in one file; itself an entity whose components are its sky, ground, weather | |

Words we decided against, and why: *prefab* (needs a dev background), *thing* (too vague), *piece*,
*item* (implies carried), *prop* (implies inert), *template/pattern* (copies don't follow the original),
*scene* (collides with world), *asset* for saved entities (asset already means raw files).

## 2. Principles that decide the edge cases

1. **The log records results, never processes.** Anything the editor adds or derives is written as an
   ordinary entry; nothing is inferred at render time (the scar to avoid: inferred lamps). A recorded
   sequence of actions breaks when code changes; a recorded result doesn't.
2. **Updates are offered, never applied.** No world changes because something elsewhere changed.
3. **The bag is the superset.** An entity may hold several components; one-thing-per-entity is the
   special case of a bag with one entry. Ownership (placer, lock, guard) lives on the entity, so a lamp
   that is one entity has one owner.
4. **Old spellings are aliases, forever.** `shared/components.js` reads every existing record as
   components and writes it back byte-identical; untouched entities keep their bytes. The new form is
   written wherever that costs nothing: added components are always written new, and components are
   edited as components. **Exception, decided 10-01:** an old `kind:"light"` entity keeps being edited
   with the `light` verb (a field-level partial update). Migrating it would need a re-spawn, which hands
   its guard to the editor (new placer), renews `born` (voiding caption deeds), is refused when locked,
   isn't atomic, and blanks it for older clients.
5. **One declaration, every surface.** Desktop panel, VR quad and the agent's `inspect`/`edit` tools read
   the same schema (`shared/editschema.js`).

## 3. The data model

### Entity
`Transform { pos, q, scale }` + `comp` bag + optional `parent`. Orientation is a **quaternion** `q`
(`shared/rot.js`); `yaw` stays as its friendly subset and the alias for yaw-only history (PROTOCOL §9.1
draft, branch `hep/quaternions`). Scale stays uniform in this pass (open question 1).

**Rotation order is per entity** (owner, 10-01): `rotOrder` on the Transform, XYZ by default, any of the six
Euler orders or a quaternion mode (Maya's rotateOrder, Blender's rotation mode). Because `q` is what is
stored, changing the order only changes how the Rotate channels read — the object never moves. It matters
most later, when motion or animation is keyed in Euler channels. *Built (step 3):* stored as `comp.rotOrder`
(`"XYZ"…"ZYX"` or `"quat"`; absent = XYZ, never written), because a new `place` arg would not fold on clients
that predate it; the component view reads it as a Transform param. Order names are Maya's: **XYZ applies X
first** (R = Rz·Ry·Rx), which three.js spells `ZYX` (PROTOCOL §4, `shared/euler.js`).

An entity with nothing but a Transform is an **Empty**: a pivot, a group parent, a spawn point, a target.

### Components
The 24 engine records in `shared/components.js`, ordered in the inspector as *what it is* first
(Model, Light, Shape, Structure), then *what it does* (motion, seats, particles, sound, picture), then
*rules* (lock, guard). Rules for the bag:

- **No per-component offsets.** A part that needs its own position (a bulb at the top of a lamp) is a
  **child entity**. "Where is this?" always has one answer.
- **Needs.** A record lists what it needs. Adding a component whose need has **one sensible default**
  adds the default too, as real entries, in **one undo step** (a Shape brings a default Material). A need
  that requires a **choice** asks ("pick a model for this picture"). Removing something another component
  needs names the dependant and offers *remove both*. *Built (step 3):* no Shape/Material records exist yet, so
  the live cases are **Reactions needs the whole entity's Pendulum** (auto-added at rest; a spin in the way
  asks before it is replaced; removing the pendulum offers remove-both) and **Collider/Seats/Picture need a
  Model**, which can't be added in place (a spawn replaces the entity), so on an Empty that need is a blocked
  entry that says what to do.
- **Repeatables.** Motions and annotations may repeat; everything else is one per entity.
- **Light is a component** (`comp.light`, built 10-01). `kind: "light"` stays the alias for an entity
  whose only component is Light; a Model and a Light may share an entity (a lamp). An authored Light on an
  entity **suppresses inferred lamps** on that entity (authored beats inferred; otherwise an emissive lamp
  model double-lights). A light glows from its entity's origin; a bulb position is a child Empty.
- **Collider is a component** (`comp.collider {shape: exact|box}`, built 10-01). Removing it falls back to
  the legacy `collide`, then to size-decided.

### Children
`parent { to, slot?, offset?, yaw? }` already exists (written by `mount`). The hierarchy panel shows it as a
real tree; drag a row onto another to parent, out to unparent. A child's Transform is local to its parent.
*Built (step 4):* `shared/hierarchy.js` is the tree as a function of the fold, and parenting writes the
existing verbs: `mount {offset, q, yaw}` at the child's world pose (the mount already took `q`, PROTOCOL
§9.1) / `dismount {pos, q, yaw}`, plus `place {scale}` when the carrier's world scale isn't 1 — the renderer
multiplies a child's scale by its carrier's and neither verb carries scale. A child's channel box reads the
mount (offset, relative q); Translate/Rotate write one `mount`, Scale a scale-only `place`. The door refuses a
loop. The inspector header carries **Parent: [pick] ✕** (and *unparent*), the same edit as a drag, for VR and
agents (`parent.to`). Known gaps: the fold's `remove` step-off ignores the carrier's scale and its own
carrier (a removed carrier that itself rode something), so riders of scaled or nested carriers land off;
the gizmo still declines children; a lock doesn't stop `dismount` at the door.

### The world entity
One entity per world, id `@world`, whose components are **Sky**, **Ground** (terrain), **Grass**,
**Weather**. Today these live outside `entities` (`state.sky`, `state.terrain`, `state.grass`); the alias
maps them both ways exactly as the entity aliases do. "One sky per world" is not a special rule: Sky is
one-per-entity and there is one world entity. Picking a sky in the library **replaces** the world's Sky.
*Built (step 5):* `shared/worldentity.js`. Sky and Weather partition `state.sky` (Weather = `weather`,
`weatherK`, `weatherSeconds`, `forecast`, `override`; the fold's `ts/seq/by` are stamps); Ground is
`state.terrain`, Grass `state.grass`. Four engine records (category World, never addable to a thing). Edits go
out as the existing verbs: every `sky.*` edit is one re-authored `sky` (everything standing rides along,
the Weather included, and a turning day is re-anchored at now), `weather.state` one `weather`, `ground.*`
one `terrain`, `grass.*` one `grass` (`grass.mow` = `grass {clear:true}`). A sky pick's args are the
preset's plus the carried Weather, so the new Sky holds nothing of the old one. The corpus test holds the
round trip on every local world (392 world states) with a partition oracle of its own.

### Blueprints
A blueprint is a canonical-JSON (RFC 8785) record, content-hashed:
`{ kind: "eido.blueprint", v: 1, name, parent?: <hash>, root: { components, children: [...] } }`.
Editing a blueprint makes a **new version** naming its parent (lineage, RFC §Lineage).

A **copy** is an entity carrying `comp.blueprint = { hash, name }` **and its full expanded components**.
Expanded on purpose (principle 1): every client — old ones, agents, replays — renders a copy with no
resolver, and the log holds the result. The link is what lets the editor:

- compute the copy's **overrides** (its components minus the blueprint version's);
- **offer** an update: "12 copies of Lamp can update to v3 — all / some / none". Accepting rewrites each
  copy's components as *new version ⊕ its overrides*. An override on a field the update also changed is a
  **conflict**, and that copy asks instead of guessing;
- **unlink** (drop `comp.blueprint`; the entity keeps its components and stops following anything).

Copies in another world wait for that world's owner. A blueprint store per world keeps every record its
copies name (RFC: retention), so a world opens offline.

Later, not now: nested blueprints (a house blueprint containing lamp copies); the version scheme already
admits them.

## 4. Tools

Engine built-ins only in this pass (user-authored tools are code: RFC ladder, step 5+):
select · move · rotate · scale · wall brush · floor paint · aperture (door/window) · eraser · ground
sculpt/paint · place seat. A tool writes ordinary verbs.

**Save as Blueprint** turns a selection (with its children) into a blueprint: draw a house with tools once,
place copies forever.

Doors and windows become **blueprints mounted in a wall slot** (they have behaviour: open, lock, sound),
replacing plan apertures, in a later pass; until then the aperture tool keeps working.

## 5. The editor

- **B** enters edit mode on the **Build** tab; the last tab used is remembered after that.
- **Left: Build** with three sections, **Blueprints · Tools · World**:
  - *Blueprints*: the starters, the asset library (a raw model is offered as "a blueprint of one Model"),
    and blueprints saved in this world.
  - *Tools*: the structure tools and the transform tools as tiles.
  - *World*: the world entity's Sky / Ground / Weather presets; picking replaces.
- **Left: Hierarchy**, a real tree (children nested, drag to parent), blueprint copies marked with their
  blueprint's name and an "out of date" dot when a newer version is offered.
- **Right: Inspector**, a header (name/label, hidden, id, placed by, blueprint link + *open blueprint* /
  *unlink*) then one card per component, then **Add Component** by category; blocked entries show why.
- **Right: Channel box** (Maya's), above the cards: Translate X/Y/Z, Rotate X/Y/Z, Scale. Rotate shows
  **Euler degrees derived from the stored quaternion** in the entity's rotation order (§3); an edit to one
  axis composes exactly into `q` (no gimbal accumulation, because `q` is what is stored). A q has two Euler
  readings plus 360° wraps; each viewer's last composed triple picks the branch, so channels read back as
  typed; a fresh viewer gets the canonical reading (middle axis within ±90°), and an upright thing reads
  (0, yaw, 0). At gimbal lock the inner channel keeps the viewer's value (0 for a fresh viewer) and the outer
  takes the rest; the card says it is locked. A **Quaternion** row (x y z w)
  can be expanded and edited directly, normalized on commit. Overridden fields on a copy are marked.
- **Rotate gizmo** turns about any axis (full `q`), not only yaw.

## 6. What changes on the wire (each with its alias)

| change | old spelling (read forever) | new spelling (written on edit) |
|---|---|---|
| orientation | `yaw` | `q` (+ `yaw` when yaw-only) |
| light as a component | `kind: "light"` + top-level fields | `comp.light {…}` on any entity |
| empty entity | (none possible) | `spawn {id}` with no `lib` |
| collider | `collide` (browser only) | `comp.collider { shape }` |
| world | `state.sky/terrain/grass` | `@world` entity components (alias only; the verbs stay) |
| blueprint copy | — | `comp.blueprint { hash, name }` + expanded components |
| blueprint store | — | `blueprint {hash, record}` verb: publish a record into `state.blueprints` (builder rank, §8; PROTOCOL §4.1) |

**Record hashes cover meaning, not prose** (built in step 3): a record's hash excludes `summary`, `note`,
every `hint` and `fallback.text`, which are documentation and may be reworded without changing it.
Everything else is hashed — including `category`, `fallback.visual`, `readOnly` and Seats' `seat` defaults,
which an include-list of `kind, v, name, params, needs` would have dropped although `seat` is meaning.

The door shape-checks `comp light` and `comp collider` (one shared rule, `compRefusal`), consistent with
PROTOCOL §4 giving them contracts; every other type stays opaque except for size.

Every row is covered by `tools/components-corpus-test.ts` (round trip on every local world log) before it
ships, and PROTOCOL.md is updated in the same stack.

## 7. Build order on `edit/components-B`

1. Quaternions: bring `hep/quaternions` onto B.
2. Wire: light as a component, empty entities, collider; aliases + corpus test.
3. Inspector: header + cards + Add Component with needs (auto-add / ask / remove-both); Channel box with
   quaternions; rotate gizmo on `q`.
4. Hierarchy as a tree with drag-to-parent. *(built)*
5. Build panel: Blueprints · Tools · World; B opens on Build; the world entity's components. *(built)*
   Blueprints re-hosts the starters and the library (a model is offered as "a blueprint of one Model";
   placing is build.js's `holdGhost`, unchanged), "add light", and an empty *saved here* line for step 6.
   Tools re-hosts the transform tools (build.js `setTool`, the call Q/G/E/R make), the six building tools
   (structure_ui, its own undo stack) and seat placement (seatedit, on the selected thing); one tool reads
   armed at a time, and a transform tile puts an armed building tool down. World re-hosts the sky presets
   (`defs/sky/_presets.json`), the ground palette's shapes, tints and plantings (`shared/grounddefs.js`
   now holds the args recipe the ground panel also writes through) and the weathers; a pick is one verb
   and one Ctrl+Z step. B opens on Build the first time; the left tab is then remembered per viewer
   (`client/lib/edittabs.js`, localStorage; a layout saved before Build opens on Build once). `@world` is
   pinned atop the Hierarchy (and in World); selecting it shows its four cards in the Inspector; agents get
   it through `inspect`, `edit` and `hierarchy`. The VR quad paints Build (library, World) and the cards.
   Gaps found: §4's **ground sculpt/paint does not exist** (the ground is a preset terrain; a brush is a new
   tool and a wire change); **Sky and Weather share the `sky` verb's wholesale fold**, so any Sky edit
   re-authors a forecast policy and the fold re-epochs it (its segment sequence restarts) — a Sky-only
   partial verb would be a wire change; the World section is **owner-only** (sky/terrain/grass/weather are
   owner rank), read-only for a builder; the first-ever terrain has no undo (no verb removes terrain) and
   the first sky's undo is `sky {}`; Q/G/E/R still leave an armed building tool armed (only the tiles put it
   down; Esc does too); Esc with `@world` selected leaves edit mode (build.js's Esc ladder doesn't know it);
   the sky panel's own commit re-sends the stored `hours` anchor, so on a turning day it snaps the clock back
   (found, not changed here; the World cards re-anchor).
6. Blueprints: record, store, Save as Blueprint, place copy, overrides, update offer, unlink.
   *6a built (record, store, verb; no UI):* `shared/blueprint.js` — the record's shape and size rule
   (`blueprintRefusal`, which the door and later the editor share), its hash (`canon` + `sha256hex` from
   `shared/components.js` over the record minus its `note`: `name` and `parent` are meaning), `expand`,
   `overridesOf` and `rebase` (a three-way merge fact by fact — a field, a component, a part — that returns
   the merged tree or a conflict list, never a guess). Nodes hold component instances in `componentsOf`'s
   vocabulary; the root holds no placement (its Transform may say `scale`/`rotOrder`), a child's Transform is
   local, no node holds an Attachment, and **each child carries an `id`**, unique among its siblings, so an
   update can find the same part in the next version (the §3 record didn't name one; without it a rebase
   could only match children by position). **The store is folded state** (`state.blueprints[hash] =
   {record, by, ts}`), not a side store: the records then live in the world's own log, so a copied, forked or
   offline world carries every record its copies name with no second file to keep in step; the snapshot holds
   it and `stateToEntries` replays it; the fold recomputes each hash and files nothing under a name that is
   not its own; nothing unpublishes. Cost: every join ships the whole store in its state (bounded at 64 KB a
   record; a lazy fetch is a later optimization). **The `blueprint` verb** (builder rank, §8): the door
   refuses a malformed or oversized record, a hash that isn't the record's (naming the right one), and a
   parent the store doesn't hold (so every lineage a world keeps is complete back to the version its copies
   were placed from); an identical re-publish is accepted as a thin `{hash}` entry, and one whose note alone
   differs goes in whole. PROTOCOL §4.1, AGENTS.md, and an agent `blueprints` tool listing the store with
   lineage. Tests: `tools/blueprint-test.ts`; the corpus test saves every final entity of every local world as
   a one-part blueprint and expands it back exact (518, none refused). Gaps found: a legacy `kind:"light"`
   entity saves as a keyless Light, which `expand` writes back as `kind:"light"` — 6b must decide whether a
   placed copy of it goes out as the `light` verb or as `comp.light`; `comp.blueprint` still reads as an
   Annotation in the inspector (a read-only Blueprint record belongs with 6c's header link); a new verb is,
   per PROTOCOL §10, a `genesis` bump that no existing world could ever carry — flagged in §4.1 like `q`.
   **Decided (owner, 2026-10-02 19:18: "everything should go out under the new comp system… for the sake of future
   consistency"):** every NEW write uses the component form: a placed copy of a legacy light goes out as
   `comp.light`, never the `light` verb. Legacy `kind:"light"` entries already in a log keep reading through the
   alias table; nothing is migrated, and nothing new is written in the old spelling.
   *Left:* **6b** placing copies (spawn the expanded tree, children mounted at their local poses, the link
   on the root, one undo step) and reading a placed copy back as a tree; **6c** Save as Blueprint (a
   selection with its children → a record → `blueprint`), the update offer ("12 copies of Lamp can update
   to v3"), conflicts asked per copy, and unlink.
7. VR parity for every panel; text-tier readout for every new component and for copies.

## 8. Open questions

1. Non-uniform scale (X/Y/Z) in the channel box: a wire change for every entity; deferred.
2. ~~Euler order~~ — decided: XYZ default, changeable per entity (`rotOrder`, §3).
3. ~~Who may publish a blueprint~~ — decided: builder rank by default. Owner-defined roles and powers (how
   many roles, what each may do, defaults equal to today's three ranks, and the owner always holding every
   power so no world can be made uneditable) are on the feature wishlist as their own piece.
5. The live `tools/comptest.ts` matrix doesn't cover the new spellings yet (AGENTS.md: a verb without a
   check there "doesn't exist yet") — owed before any of this goes upstream.
4. Copy expansion costs bytes per copy; a resolver that stores only the link + overrides is a later
   optimization once every client can resolve.
