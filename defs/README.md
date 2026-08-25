# defs/ — instance content as data (overhaul charter §3)

Defs are the Rimworld move: **content is declarative data; code is reserved
for new *kinds* of things.** A flora species is a def file. Adding a species
to every world this instance serves means adding a JSON file here — no
engine edit, no client edit, no deploy beyond the file.

- One def per file, `defs/<domain>/<name>.json`; the filename (minus `.json`)
  is the def's name. Domains so far: `flora/`, `avatars/`, `animations/`
  (clip overlay, same declared-beats-discovered contract as avatars — `vrma`
  adds/repoints, tags/doc ride /defs), `sky/` (the `_presets.json` sidecar:
  named skies for the build panel — authoring conveniences only; commit
  writes concrete args, the log never stores a preset name), `structure/`
  (the `_palette.json` sidecar: the instance's building style, an overlay
  mutating the realizer's live materials — restyles standing buildings on
  the hot-reload push; missing def keeps the built-in style).
- **Avatars are an overlay, not a gate** (`shared/avatardefs.js`): dropping
  a .vrm into the library/overlay stays a live avatar with no def. A def
  matching a discovered name overrides its metadata (`height`); a def
  carrying `vrm` (a /library path) declares an avatar the scan wouldn't
  find, or repoints a name — declared beats discovered. A def whose vrm
  path doesn't resolve is refused loudly and the discovered roster stands.
- The contract per domain lives in `shared/` as a pure validator
  (`shared/floradefs.js`) — the server refuses to serve a def that fails it
  (loudly, at load), so a typo becomes a boot log line, not a broken world.
- Served at **`GET /defs`** as `{flora: {name: def}}`. The browser engine
  hydrates its species registry from this before the first flora build
  (`ensureFloraDefs` in vegetation.js). Reloaded on a ~1s cache, so editing
  a def during dev shows up on the next client boot without a server
  restart.
- **Unknown keys are preserved, never dropped** — same forward-compatibility
  rule as the log protocol. `doc` is the conventional human-notes field
  (JSON has no comments; the tuning lore rides in-band).
- Colors: `leafRecolor` may name a `GRASS_COLORS` entry (`"straw"`) —
  resolved at hydration — or carry a raw `[r,g,b]` triple. `stemColor` is a
  decimal int of the hex color (JSON has no hex literals; the `doc` notes
  the hex). `GRASS_COLORS` itself still lives in vegetation.js (calibrated
  against Sol's blade atlas — engine-adjacent for now; a candidate for
  `defs/flora/_colors.json` later).
- Worlds reference species by name in `grass` verb args. A log that names a
  species this instance lacks fails that stroke loudly at build time and
  leaves the rest of the world standing — the log itself is untouched
  (append-only, forever).

- **Underscore files are domain sidecars, not defs** — `flora/_colors.json`
  is the palette table (served as `floraColors`), `flora/_presets.json` the
  named biome recipes (served as `floraPresets`; template vocabulary
  documented in its own `doc`) — each validated whole, skipped by the
  def-per-file loader. A logged `grass` bag naming a preset this instance
  lacks fails loudly, exactly like an unknown species.
- **Hot reload:** the sequencer fingerprints this directory once a second
  (the `defs-watch` tick system) and pushes `defs-updated` to every live
  client when it changes — clients re-hydrate and regrow what the changed
  content shapes. Editing a def under a running world is a live act.

## What is NOT a def

Defs are **authored** content: hand-written, declarative, reviewable in a
diff, safe to hot-reload. Not everything data-shaped belongs here:

- **Seat profiles** (server/seats.ts) stay a *store*, not defs: they are
  runtime-*judged* state — named-actor proposals, operator countersigns
  with no HTTP path, provenance-first atomic writes, cross-process locks,
  revision preconditions (#101/#105). Flattening that into TTL-rescanned
  JSON files would delete the security model. The line: if writing it
  requires authority, judgment, or provenance, it's a store; if editing it
  is authorship, it's a def.
- **World state** is the log's, always.

`DEFS_DIR` env overrides the directory (scratch sequencers, tests) — same
pattern as `WORLDS_DIR`.
