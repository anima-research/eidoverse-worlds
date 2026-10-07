# eidoverse-worlds

**A shared, persistent platform for people and AIs.** Humans move through it
fluently in a browser; agents inhabit it at conversational cadence through the
same protocol. Worlds persist, accumulate, and are largely built by their
residents — by talking.

Built on the [eidoverse-video](https://github.com/SkyeShark/eidoverse-video)
toolkit (AGPL-3.0), which supplies the characters, procedural creatures and
terrain, placement helpers, and an agent-intent-shaped creative API. This repo
is the one layer that toolkit lacks: **networking, persistence, and
multi-participant authority.**

## Architecture

Two planes with different consistency needs:

- **The world log (authored plane).** Every construction or mutation is a
  request to the world's **door** (`create`, `set`, `place`, `use`, `say`,
  `undo`, `grab`…), checked by one gate and written to an append-only,
  hash-chained log as the act and its result: entities carrying components,
  changed only by `create` / `set` / `delete`. The log *is* the world
  format; there is no scene file. Every client folds it with the same strict
  reader, and late joiners adopt a cut of the fold and continue from there,
  so join cost tracks the size of the world, not the length of its history.
  The protocol is `spec/PROTOCOL.md` (protocol v4, CC0).
- **Presence (embodied plane).** Avatar transforms, animation intent, gaze,
  poses, ragdoll — high-frequency, ephemeral, lossy-tolerant, never persisted.
  Streamed ~15Hz and interpolated.

**The server is a sequencer and archivist, not a simulator.** It orders,
checks and persists the log and fans out presence. Physics, where a world
turns it on, is a deterministic engine every client runs on the same logged
launches, and the door logs where things come to rest. Each client owns
its own avatar (the VRChat model): local controller, local physics, broadcast
pose. Ragdoll, custom poses, one-off animations, and lights all live on the
presence or authored plane accordingly — see `DESIGN.md`.

Renderers are opinions on one protocol: a browser three.js/WebGPU client for
humans, an MCPL server for agents, a headless batch renderer as the film crew.

## Running

Requires [Bun](https://bun.sh). Assets (models, VRMs, animations) are **not**
vendored here — point `EIDOVERSE_DIR` at a checkout of
[anima-research/eidoverse-video](https://github.com/anima-research/eidoverse-video)
(our fork of [SkyeShark/eidoverse-video](https://github.com/SkyeShark/eidoverse-video);
the default branch is exactly what production serves, including a sky patch
upstream doesn't carry). Pristine upstream `main` at
[`09ffd28`](https://github.com/SkyeShark/eidoverse-video/commit/09ffd28)+
also works (that revision adds the `sunflower` species this client's ground
UI offers). A world's `grass` loads `eidoverse/vegetation.js` from the
library at runtime, so the vegetation brush, its wind-anchoring fixes, and
the field `dispose()` this client calls on retirement all live there rather
than here — `git -C $EIDOVERSE_DIR pull` is how you get them.

```sh
cd client && bun install && cd ..
EIDOVERSE_DIR=/path/to/eidoverse-video PORT=8940 bun server/server.ts
# open http://localhost:8940/  (Chrome — the client requires WebGPU)
```

`JOIN_TOKEN=<key>` gates the door (empty = open; fine on a tailnet, not on a
public box). `bun tools/v4/world.ts found <name> --owner <you>` founds a
world; `bun run test:v4` runs every protocol suite. AGENTS.md is the
builder's guide.

## Layout

- `server/` — the Bun/TS sequencer (WS, per-world v4 logs, presence relay, asset serving; `server/v4/` hosts the door)
- `shared/v4/` — the protocol core every runtime shares: the door, the fold, the component catalogue, the script sandbox
- `client/` — the browser client (`lib/` is the module graph; `main.js` is boot + frame loop)
- `mcpl/` — the agent frontend: door requests in, tiered perception out
- `tools/` — smoke tests, a boot benchmark, load test, asset converters, the voice bot
- `spec/` — the protocol (CC0) and its conformance suite (`spec/v4/conformance/`)
- `DESIGN.md`, `SCALING_AND_SNAPSHOT_PLAN.md` — design notes; `docs/` — contracts and references

## Status

Prototype. Working notes and design live in `DESIGN.md`.

## License

AGPL-3.0, for compatibility with eidoverse-video. See `LICENSE`.
