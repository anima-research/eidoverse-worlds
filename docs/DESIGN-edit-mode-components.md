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
   components and writes it back byte-identical; untouched entities keep their bytes. An entity is saved
   in the new form only when edited in the new inspector (write-new-on-edit).
5. **One declaration, every surface.** Desktop panel, VR quad and the agent's `inspect`/`edit` tools read
   the same schema (`shared/editschema.js`).

## 3. The data model

### Entity
`Transform { pos, q, scale }` + `comp` bag + optional `parent`. Orientation is a **quaternion** `q`
(`shared/rot.js`); `yaw` stays as its friendly subset and the alias for yaw-only history (PROTOCOL §9.1
draft, branch `hep/quaternions`). Scale stays uniform in this pass (open question 1).

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
  needs names the dependant and offers *remove both*.
- **Repeatables.** Motions and annotations may repeat; everything else is one per entity.
- **Light is a component.** `kind: "light"` becomes the alias for an entity whose only component is
  Light; a Model and a Light may share an entity (a lamp).
- **Collider is a component** with a verb that writes it.

### Children
`parent { to, slot?, offset?, yaw? }` already exists (written by `mount`). The hierarchy panel shows it as a
real tree; drag a row onto another to parent, out to unparent. A child's Transform is local to its parent.

### The world entity
One entity per world, id `@world`, whose components are **Sky**, **Ground** (terrain), **Grass**,
**Weather**. Today these live outside `entities` (`state.sky`, `state.terrain`, `state.grass`); the alias
maps them both ways exactly as the entity aliases do. "One sky per world" is not a special rule: Sky is
one-per-entity and there is one world entity. Picking a sky in the library **replaces** the world's Sky.

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
  **Euler degrees derived from the stored quaternion** (order XYZ, shown); an edit to one axis composes
  exactly into `q` (no gimbal accumulation, because `q` is what is stored). A **Quaternion** row (x y z w)
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
| blueprint store | — | `blueprint` verb: publish a record (owner/builder rank) |

Every row is covered by `tools/components-corpus-test.ts` (round trip on every local world log) before it
ships, and PROTOCOL.md is updated in the same stack.

## 7. Build order on `edit/components-B`

1. Quaternions: bring `hep/quaternions` onto B.
2. Wire: light as a component, empty entities, collider; aliases + corpus test.
3. Inspector: header + cards + Add Component with needs (auto-add / ask / remove-both); Channel box with
   quaternions; rotate gizmo on `q`.
4. Hierarchy as a tree with drag-to-parent.
5. Build panel: Blueprints · Tools · World; B opens on Build; the world entity's components.
6. Blueprints: record, store, Save as Blueprint, place copy, overrides, update offer, unlink.
7. VR parity for every panel; text-tier readout for every new component and for copies.

## 8. Open questions

1. Non-uniform scale (X/Y/Z) in the channel box: a wire change for every entity; deferred.
2. Euler order shown in the channel box: XYZ (Maya's default) unless the owner prefers another.
3. Who may publish a blueprint into a world: builder rank (like `spawn`) or owner rank (like client mods)?
4. Copy expansion costs bytes per copy; a resolver that stores only the link + overrides is a later
   optimization once every client can resolve.
