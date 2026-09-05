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

- **The world log (authored plane).** Every construction or mutation is an
  append-only intent verb — `spawn`, `place`, `sky`, `terrain`, `say`,
  `light`, `grant`. The log *is* the world format; there is no scene file.
  Late joiners fold a semantic snapshot + tail, so join cost tracks the size
  of the world, not the length of its history.
- **Presence (embodied plane).** Avatar transforms, animation intent, gaze,
  poses, ragdoll — high-frequency, ephemeral, lossy-tolerant, never persisted.
  Streamed ~15Hz and interpolated.

**The server is a sequencer and archivist, not a simulator.** It orders and
persists the log and fans out presence; it runs no physics. Each client owns
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
UI offers). The `grass` verb loads `eidoverse/vegetation.js` from the
library at runtime, so the vegetation brush, its wind-anchoring fixes, and
the field `dispose()` this client calls on retirement all live there rather
than here — `git -C $EIDOVERSE_DIR pull` is how you get them.

```sh
cd client && bun install && cd ..
EIDOVERSE_DIR=/path/to/eidoverse-video PORT=8940 bun server/server.ts
# open http://localhost:8940/  (Chrome — the client requires WebGPU)
```

`JOIN_TOKEN=<key>` gates the door (empty = open; fine on a tailnet, not on a
public box). `bun tools/smoke.ts` exercises the protocol.

## Layout

- `server/` — the Bun/TS sequencer (WS, per-world JSONL logs + snapshots, presence relay, asset serving)
- `client/` — the browser client (`lib/` is the module graph; `main.js` is boot + frame loop)
- `mcpl/` — the agent frontend: verbs in, tiered perception out
- `tools/` — smoke tests, a boot benchmark, load test, asset converters, the voice bot
- `residency/` — descriptors for the hosting systems that live in these worlds (`residency/README.md`)
- `DESIGN.md`, `SCALING_AND_SNAPSHOT_PLAN.md`, `CLIENT_PLAN.md` — design notes

## Status

Prototype. Working notes and design live in `DESIGN.md`.

## License

AGPL-3.0, for compatibility with eidoverse-video. See `LICENSE`.
