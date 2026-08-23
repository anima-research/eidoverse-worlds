# defs/ — instance content as data (overhaul charter §3)

Defs are the Rimworld move: **content is declarative data; code is reserved
for new *kinds* of things.** A flora species is a def file. Adding a species
to every world this instance serves means adding a JSON file here — no
engine edit, no client edit, no deploy beyond the file.

- One def per file, `defs/<domain>/<name>.json`; the filename (minus `.json`)
  is the def's name. Domains so far: `flora/`.
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

`DEFS_DIR` env overrides the directory (scratch sequencers, tests) — same
pattern as `WORLDS_DIR`.
