# The component ladder

How a new component gets into the engine without breaking a world. The rules are `spec/PROTOCOL.md` §4 and §10; this
is the checklist that follows from them. R and Hesperus, 2026-10-10.

## Draft, trial, reserved, stable: four words, two different questions

**Draft** is a rung of this ladder: a namespaced component (`<handle>/<name>`) the authority has **not admitted** to its
registry. It is stored as written, but the engine doesn't know it and no rule reads it.

**Trial**, **reserved** and **stable** are the *status* of a name that **is** in the registry (`status` on every
definition in `shared/protocol/componentspec.js`; `schema` returns it, and the Inspector shows it on the card):
- **trial**: admitted and written, but its shape may still change during the alpha (about a year). When it changes we
  translate or repair stored values where we can. Every registered component is trial at v1.
- **reserved**: the name is held (nobody else may take it) but every write is refused, with one refusal for all reserved
  names (code `reserved`; the definition's `instead` says what to use meanwhile). Today: `physics-joint` (the
  constraint between two bodies; renamed from `joint` 10-16, nothing stored it), `joint` (a skeleton node: Maya, glTF,
  VRM; for avatar entity trees), `surface` (with physics' reserved fields), `schemas`, `terrain-grid`, `terrain-tile`, `terrain-paint`; `sockets` (the old map: lift-only, the door turns a write of it into
  socket children); and the names R held for shapes not settled yet (shape audit 10-16): `material`, `anim-clip`,
  `anim-states`, `camera`, `zone`, `video`, `spring-joint`, `link`, `tags`.
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
  stored one is repaired at a world's first load (shared/protocol/shaperepair.js) and by translate-v1@12: `motion.amplitude`
  (→ `amp`), `motion.part` (→ `motion:<slot> {node: <part>}`: a node's name from a model file is data in the value, never part of a key; readers find the part by `node`), `physics.material` (→ `surface`), `sky.weatherSeconds` (→
  `transition`; the sky act still takes it), `sky.clock` (→ `tz`; likewise), `terrain.water` (→ the `water` component).
  Some are taken at the door instead and stored in today's spelling: `parent.order` (dropped), `light.day` (→
  `daytime`), `grass.preset` (→ its strokes) and the first protocol's grass knobs. The load's act is `repair-shapes`, once
  per world (its act, a founding stamped `shapes`, or a translate-v1@12 act marks the world); PROTOCOL §4 lists
  everything it repairs.
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
world's owner writes `@world.trusted = {components: ["hesperus/material", …]}` (a registered world-only component,
gated like the rest of `@world`: owner, never a permission — `editWorld` doesn't reach it). The list holds namespaced
draft base names only (no keys, no bare or registered names: a bare name is the engine's or nothing), at most 64, each
once; the authority refuses anything else (`trustRefusal` in `shared/drafts.js`, the same rule the inspector reads).

What clients make of it:
- a trusted draft's card wears a BLUE chip, "trusted here";
- Add Component lists it in the main list under its own category (not under "drafts"), blue chip, no "unproven" hint;
- in the Inspector card of a draft, an **owner** sees "trust this in this world" / "stop trusting it in this world" (one
  request: `@world.trusted` with the name toggled; an emptied list deletes the component). Everyone else sees the chip;
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
5. **The protocol text**: its name in §4's list, and a line in the catalogue (`shared/components.js`) for Add Component.
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

## Who checks what

- The conformance suite (`tools/protocol/run.ts`) fails on a changed pin, a v1 word, an unhandled refusal.
- A second agent reviews every promotion against this page and §4 before it merges.
- A world's owner decides what that world trusts (`@world.trusted`); R decides when a draft is proven.
