# The component ladder

How a new component gets into the engine without breaking a world. The rules are `spec/PROTOCOL.md` §4 and §10; this
is the checklist that follows from them. R and Hesperus, 2026-10-10.

## Rung 1: draft (namespaced)

A component nobody has registered carries a namespace: `<handle>/<name>` (`hesperus/material`), keyed instances
`<handle>/<name>:<key>`. The authority stores it as written, replays it, and tells the writer its engine doesn't know it.
Nothing shared changes, so nothing can break: a draft is only as real as the readers that choose to read it.

A draft needs:
- **a reader**: the client code that does something with it (`client/lib/…`), which must treat a malformed value as
  absent, never throw;
- **a card**: its fields in the Inspector (`shared/editschema.js`), checked before they are sent;
- **its dot**: the card's title shows an amber dot (a draft this client reads) or a hollow grey one (a component this
  client can't read);
- **tests**: the card's edits (`tools/editschema-test.ts`) and the reader in a browser (`tools/protocol/shiplist-probe.ts`);
- **a page**: what each field means, its units, and **what its absence means**, written now (see rung 3).

A draft can't change a rule: the authority doesn't read it. Anything that needs the authority (a check, an effect on
physics, a right) waits for promotion.

## Rung 2: proving it

It's used for real: in the gym, in R's worlds, by an agent through `set`. It changes as it's learned; a draft's shape
can change freely, since nothing outside its readers depends on it. Proven means R has used it and is happy with the
fields, and nothing about its meaning is still being argued.

## Rung 3: promotion (a bare name)

One commit, reviewed by a second agent before it ships:
1. **The definition** in `shared/protocol/componentspec.js`: its fields and types, enums, ranges, `defaults` (the
   authority writes them into every stored value), `absentMeans` for every field whose absence carries meaning, a
   `help` line, and `aliases: ["<handle>/<name>"]` so every draft value already in a world keeps working.
2. **Decide every field now.** A field added after registration must say what its absence means, and that meaning is
   frozen. If today's behaviour wouldn't be acceptable forever as "absent", the field is added at promotion or not at all.
3. **The pin**: `bun tools/protocol/pretrans-check.ts --pin` (additions only; it refuses a changed type, default or enum).
4. **The authority's checks** for anything a reader can't be trusted to check (ranges that matter to everyone, refs).
5. **The protocol text**: its name in §4's list, and a line in the catalogue (`shared/components.js`) for Add Component.
6. **The reader** keeps reading both spellings (the alias makes the authority treat them as one; clients use
   `registered()` from componentspec).
7. **Rules it now feeds** (physics reading a material's surface, say) land in the same change, each with a check watched
   failing first.
8. The card's dot goes from amber to none (a core component; an accent dot while draft spellings still exist in the world).

## Rung 4: a change of meaning

Never edit what a registered field means. A new meaning is a new name, `<name>@<n>`, registered before anyone writes it,
saying what it `supersedes`. Old names are read forever.

## Who checks what

- The conformance suite (`tools/protocol/run.ts`) fails on a changed pin, a v1 word, an unhandled refusal.
- A second agent reviews every promotion against this page and §4 before it merges.
- R decides when a draft is proven.
