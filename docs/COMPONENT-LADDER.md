# The component ladder

How a new component gets into the engine without breaking a world. The rules are `spec/PROTOCOL.md` §4 and §10; this
is the checklist that follows from them. R and Hesperus, 2026-10-10.

## Draft, trial, reserved, stable: four words, two different questions

**Draft** is a rung of this ladder: a namespaced component (`<handle>/<name>`) the authority has **not admitted** to its
registry. It is stored as written, but the engine doesn't know it and no rule reads it.

**Trial**, **trial-kernel**, **reserved** and **stable** are the *status* of a name that **is** in the registry (`status` on every
definition in `shared/protocol/componentspec.js`; `schema` returns it, and the Inspector shows it on the card):
- **trial**: admitted and written, but its shape may still change during the alpha (about a year). When it changes we
  translate or repair stored values where we can. Every registered name that isn't reserved is trial at v1.
- **trial-kernel** (reviewer item 5, 10-18): the kernel's status. `transform`, `parent`, `model`, `roles` and `access` carry it in the
  registry as their component shape (recut C11: the ladder's vocabulary is the registry's `roles.vocab`, a trial break needing
  --ack; the four doors are client presets that write `access`), and
  shared/protocol/kernelspec.js extends it below the registry to the log envelope and its kinds, the fold's operations and
  batch body, the identity grammar and the version (PROTOCOL §1–§3, §13). The shapes are pinned in `spec/kernel-pin.json`;
  tools/protocol/kernel-check.ts (the gate's core lane) is red the moment the code differs from the pin, and
  `kernel-check.ts --pin` refuses to re-pin unless the same change carries all three companions: a translator change
  (translate-v1's `TRANSLATOR` moved `@N → @N+1`, or `--translator <a new translate step>`), a `REGISTRY-CHANGELOG.md` line
  (`--ack "<why>"`, written as `kernel: <why>` with the diff beneath), and vectors (`--vectors <dir>`:
  `spec/kernel-vectors/<dir>/vectors.json`, entries the OLD reader — snapshotted from git into `old-fold.js` at re-pin time —
  refuses and the NEW reader folds clean; the gate runs them). The pin records the companions and the check verifies them
  at every run, so none can be dropped after the fact. Not an acknowledgement rung: `--ack` alone never re-pins the kernel.
  A **scope extension** (a registered name entering the kernel with the shape the registry pin already holds, as model, roles
  and access did on 10-18) changes what no stored byte means: it re-pins on `--ack` alone, no translator or vectors, and the
  pin records the names (kernel-check K12 proves a shape change can't ride in on it).
- **reserved**: the name is held (nobody else may take it) but every write is refused, with one refusal for all reserved
  names (code `reserved`; the definition's `instead` says what to use meanwhile). Today: `physics-joint` (the
  constraint between two bodies; renamed from `joint` 10-16, nothing stored it), `joint` (a skeleton node: Maya, glTF,
  VRM; for avatar entity trees), `surface` (with physics' reserved fields), `schemas`, `terrain-grid`, `terrain-tile`, `terrain-paint`; `sockets` (the old map: lift-only, the door turns a write of it into
  socket children); and the names R held for shapes not settled yet (shape audit 10-16): `material`, `anim-pose` (one frame; R 10-17), `anim-clip`,
  `anim-states`, `camera`, `zone`, `video`, `spring-joint`, `link`, `tags`; and `body-owner`, `edit-grant`, `avatar-deny`
  (the avatar guard rails' names, PROTOCOL §7a).
- **reserved inside a trial component**: a field or a kind can be held the same way, refused with code `reserved` while
  its name is kept for an addition later (the registry's `reservedFields` / `reservedKinds`, pinned):
  - `station`: `poses`, `sync`, `approach`, `enter`, `leave`, `reach`, `look`, `input`, `fromSeat` (researched in
    RESEARCH-socket-body-2026-10-06, built in shared/sockbody.js's reader, unused in any stored world; each comes back
    with its `absentMeans`). `hold` (bone overrides over the pose) is cut, not held.
  - `grabbable`: `fx` (presence-only particles while use is held). A grip's `hold` is cut.
  - `reactions`: the handler kind `impulse` (it returns with its general meaning when an engine carries impulses).
  - `terrain`: the kind `raster` (an imported height raster; no reader draws or walks it yet, so its fields stay
    unregistered).
  - `physics`: `surface` (was `material`), `friction`, `restitution`, `frictionCombine`,
    `restitutionCombine`, `linearDamping`, `angularDamping`, `centerOfMass` (the vocabulary every engine shares; units,
    limits and meanings of absence held in `reservedShape`/`absentMeans`; they open when an engine reads them). `mass` and
    `density` stay open: the body shove reads them.
    `layers`, `mask`, `ccd` are cut, not held.
- **cut fields that say where they went** (the registry's `dropped`): a write of one is refused with a pointer, a
  stored one is repaired by the explicit maintenance command (shared/protocol/shaperepair.js; `bun tools/protocol/world.ts repair <name>`, which runs lift-sockets, rename-components and repair-shapes in that order; never at load: reviewer item 9 + the lead's ruling, 10-18) and by translate-v1@12 and later: `motion.amplitude`
  (→ `amp`), `motion.part` (→ `motion:<slot> {node: <part>}`: a node's name from a model file is data in the value, never part of a key; readers find the part by `node`), `physics.material` (→ `surface`), `sky.weatherSeconds` (→
  `transition`; the sky act still takes it), `sky.clock` (→ `tz`; likewise), `terrain.water` (→ the `water` component).
  Some are taken at the door instead and stored in today's spelling: `parent.order` (dropped), `light.day` (→
  `daytime`) and the first protocol's grass knobs. The command's acts are `lift-sockets`, `rename-components` and `repair-shapes` (each with `command` and `by`: provenance; one pre-repair backup under `repair-backups/` for `--rollback`); a world needing a step its readers can't serve loads but refuses writes with `repair-needed`. The shape repair runs once per world (the system's
  `repair-shapes` act marks the world; a founding or translation writes one; older worlds' markers are read back, and a
  purged one counts as marked); PROTOCOL §4 lists everything it repairs.
- **references are stored as written** (R 10-17, binding: "definitely serve path again alongside hash"): `model` is its
  library path, a particle Essential its name, `grass.preset` its name (back as a field: Fable #4, expanding later is
  cheap, un-expanding impossible). `model-hash` (trial, 10-17; `sha256:<64 hex>`, written by the server) rides beside a
  model when the catalogue already knows its bytes, the way Godot's `ext_resource` carries `uid` beside `path` and a lock
  file `integrity` beside `resolved`: optional, never the reference. A model stored as `eido:sha256/<hex>` (translate-v1
  @8–@11) gets its path back when the repair command runs where the host's index knows it (repair v2), else it still loads as it is.
- **a component split out of another**: `water` (trial, 10-16) left `terrain`, as every engine keeps water apart from
  ground. `@world`'s `water {level (m, required), color?, opacity?, kind?: still|river|ocean, flow? [x, z] m/s}`; no
  `water` is a dry world, and absent fields read as `0x1d5a6e`, 0.82, a kind decided from the ground
  (shared/waterkind.js) and no current. Its readers moved with it: the authority's ground (spatial.js), the client
  (drawing, ground panel), the agent, and the mover's water law (shared/mover.js), through shared/terrainshape.js's
  `worldWater`, which reads an older `terrain.water` until the load moves it.
- **stable**: promised. Its meaning never changes; it only grows by additions, and a changed meaning is a new versioned
  name (rung 4). None is stable at v1.

So a draft is not trial: a draft isn't admitted at all, and a trial component is admitted but unpromised.

**The pin is a tripwire, not a vow.** `spec/registry-pin.json` records each name's status, types, defaults, enums,
ranges, required fields, meanings of absence and grammars. `test:protocol` (pretrans D8) goes red when any of them is
removed, changed or narrowed. Then:
- an **addition** (a new name, field, default, enum member or widened range) re-pins with a plain
  `bun tools/protocol/pretrans-check.ts --pin`;
- a **break on a trial or reserved name** re-pins only with an acknowledgement:
  `bun tools/protocol/pretrans-check.ts --pin --ack "<why>"`. That appends a line to `spec/REGISTRY-CHANGELOG.md`
  naming every break and why, in the same commit as the pin;
- a **break on a stable name** never re-pins, acknowledged or not.

The pin also records what is held or closed inside a trial name (PROTOCOL §4): `reservedKinds` (the kinds above),
`reservedShape` (what a reserved field will mean when it opens: `physics`' units, limits and combine enums) and
`nestedEnums` (a nested grammar's closed vocabularies, by path: `structure`'s aperture kinds, wall axes, tile halves). A
`nestedEnums` member removed trips D8 like an enum's; a change to `reservedKinds` or `reservedShape` shows only in the
pin's diff for now.

Not pinned, but refused by the same registry: a definition's `stamped` fields (the sky's `ts`, `override`,
`forecast.epoch`) are the authority's alone, and a write carrying one is refused `stamped`, naming the act that owns it.

## Rung 1: draft (namespaced)

A component nobody has registered carries a namespace: `<handle>/<name>` (`hesperus/material`), keyed instances
`<handle>/<name>:<key>`. The authority stores it as written, replays it, and tells the writer its engine doesn't know it.
Nothing shared changes, so nothing can break: a draft is only as real as the readers that choose to read it. A draft is
unproven — possibly janky, possibly unsafe — and the editor says so.

A draft needs:
- **a reader**: the client code that does something with it (`client/lib/…`), which must treat a malformed value as
  absent, never throw, and which **registers what it reads** (`registerDraft` in `shared/drafts.js`: the name, a title,
  a summary, a category, the blank value Add Component writes, and where it applies);
- **a card**: its fields in the Inspector (`shared/editschema.js`), checked before they are sent;
- **its chip**: the card's title wears an AMBER chip, "draft" (a draft this client reads); a component this client can't
  read wears a hollow grey one, "unknown";
- **its offer**: Add Component lists it under a **"drafts"** heading, amber chip, with the hint "unproven: this client
  reads it; the engine doesn't" — ONLY on a client that registered a reader for it (a server, or an agent's `inspect`,
  has none and never offers it);
- **tests**: the card's edits (`tools/editschema-test.ts`) and the reader in a browser (`tools/protocol/shiplist-probe.ts`);
- **a page**: what each field means, its units, and **what its absence means**, written now (see rung 3).

A draft can't change a rule: the authority doesn't read it. Anything that needs the authority (a check, an effect on
physics, a right) waits for promotion.

## Rung 2: trusted here (owner-approved), and proving it

"Not engine-official, but used and trusted in this world." Trust is a fact about the WORLD, not the engine: the
world's owner writes `@world.trusted-components = {components: ["hesperus/material", …]}` (a registered world-only component,
gated like the rest of `@world`: owner, never a permission — `editWorld` doesn't reach it). The list holds namespaced
draft base names only (no keys, no bare or registered names: a bare name is the engine's or nothing), at most 64, each
once; the authority refuses anything else (`trustRefusal` in `shared/drafts.js`, the same rule the inspector reads).

What clients make of it:
- a trusted draft's card wears a BLUE chip, "trusted here";
- Add Component lists it in the main list under its own category (not under "drafts"), blue chip, no "unproven" hint;
- in the Inspector card of a draft, an **owner** sees "trust this in this world" / "stop trusting it in this world" (one
  request: `@world.trusted-components` with the name toggled; an emptied list deletes the component). Everyone else sees the chip;
- the World inspector (with Sky and Weather) has a **Trusted components** card listing them, each with an owner's
  "stop trusting".

What it does NOT do: the authority still doesn't read a trusted draft. Trust ≠ engine understanding; it still can't
feed a rule, and anything that needs the authority still waits for promotion.

Proving it is the same as before: it's used for real, in the gym, in R's worlds, by an agent through `set`. It changes
as it's learned; a draft's shape can change freely, since nothing outside its readers depends on it. Proven means R
has used it and is happy with the fields, and nothing about its meaning is still being argued. Trust in a world is a
signal on the way there, not the promotion.

## Rung 3: promotion (a bare name) — official, no chip

One commit, reviewed by a second agent before it ships:
1. **The definition** in `shared/protocol/componentspec.js`: its fields and types, enums, ranges, `defaults` (the
   authority writes them into every stored value), `absentMeans` for every field whose absence carries meaning, a
   `help` line, and `aliases: ["<handle>/<name>"]` so every draft value already in a world keeps working.
2. **Decide every field now.** A field added after registration must say what its absence means, and that meaning is
   frozen. If today's behaviour wouldn't be acceptable forever as "absent", the field is added at promotion or not at all.
3. **The pin**: `bun tools/protocol/pretrans-check.ts --pin` (additions re-pin freely; a change, removal or narrowing of a
   trial name needs `--ack "<why>"` and leaves a REGISTRY-CHANGELOG line; a stable name's never re-pins). A promoted
   name is `trial` until it is promised (`stable`).
4. **The authority's checks** for anything a reader can't be trusted to check (ranges that matter to everyone, refs).
   **Every field that holds an entity id is typed** `ref` / `refs` (or listed in `refPaths` when nested): that type is what
   lets a duplicate, a publish and a merge rebind it, a deletion clear it in the same act (R 10-17), and `lint` report it
   when it names nothing. An id in an untyped string field is invisible to all four.
5. **The protocol text**: §4 lists examples (the registry itself is componentspec + `spec/registry-pin.json`); name it
   there if it's one a reader should meet first, and add a line in the catalogue (`shared/components.js`) for Add Component.
6. **The reader** keeps reading both spellings (the alias makes the authority treat them as one; clients use
   `registered()` from componentspec).
7. **Rules it now feeds** (physics reading a material's surface, say) land in the same change, each with a check watched
   failing first.
8. The card's chip goes from amber or blue to none (a core component; an accent dot while draft spellings still exist
   in the world). A world's `trusted` list may still name the old spelling: harmless (`registered()` now answers for it;
   the authority refuses a registered name in a NEW `trusted` write), and the owner may remove it.

## Rung 4: a change of meaning

Never edit what a **stable** field means. (A **trial** field may change during the alpha, acknowledged in the
changelog and with a repair or translation for stored values where one is possible; see the tripwire above.) A new meaning is a new name, `<name>@<n>`, registered before anyone writes it,
saying what it `supersedes`. Old names are read forever.

## A keyed component is a facet; anything with its own life is a child entity

A keyed name (`motion:<slot>`, `roles:<identity>`, `script:<name>`) is one more facet of the thing it sits on: Unreal's
component name within its actor, never a second entity system. The rule (engine-scars review 2026-10-17, R's ruling):
**anything that needs its own transform, lock, rights, references or children is a child entity, not a key suffix.**

- *Its own transform*: it sits somewhere of its own (a seat, a hook, a bone). Make it a child with `parent {to}` and a
  `transform` local to its parent. Sockets went this way (a socket is a child entity with `socket {name}`); avatar bones
  (`joint`, reserved) will too.
- *Its own lock or rights*: someone may lock it, or hold rights over it, apart from its thing. A key can't be locked on its
  own (a lock covers the whole thing), and a key's creator rule is not a rights system.
- *References to it*: something else names it (a reaction pointing at it, a script's ref). Ids are stable and typed refs
  are cleared on delete (the authority's follow-up; a script's scope is left alone); a key is renamed by rewriting it, and nothing follows the rename (Unreal's FName scar).
- *Children*: things hang from it. Only entities have children.

What may stay a key: data with no life of its own, read with its thing (a motion's parameters, with the node it drives
written as data, `motion:<slot> {node}`, never in the key; a role; a script's source and scope). If a key ever grows one
of the four needs above, promote it to a child entity, and write the promotion here.

## Who checks what

- The conformance suite (`tools/protocol/run.ts`) fails on a changed pin, a v1 word, an unregistered refusal code (scars G1).
- A second agent reviews every promotion against this page and §4 before it merges.
- A world's owner decides what that world trusts (`@world.trusted-components`); R decides when a draft is proven.
