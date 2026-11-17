# Origin: the July 2026 pitch and the first prototype

*Dated and frozen: moved verbatim from DESIGN.md on 2026-11-14. Much of the toolkit API it names (walkTo,
placeOn, makeCreature) isn't used here; what is built is in DESIGN.md.*

## Why eidoverse

The video toolkit already solved the hard 90%: characters with physics
locomotion and geometry-derived maneuvers, procedural creatures/robots/terrain
/weather, placement helpers that make clumsy input land correctly, and a
creative API that is *agent-intent-shaped* (`walkTo`, `seatOn`, `placeOn`,
`say`, `makeCreature`). Crucially, construction is **seeded and deterministic**
(built for reproducible batch renders) — which makes toolkit calls replicable
as-is. And it's all browser tech run headless: the same code renders fluently
in Chrome WebGPU (validated 2026-07-09 — `basic_vrm.js` byte-for-byte
unmodified, 60fps; see eidoverse-video `work/browser_spike/`).

What the toolkit lacks is exactly one layer: networking, persistence, and
multi-participant authority. That layer is this repo.

## First prototype scope (2026-07)

- Bun/TS sequencer: WS, per-world JSONL logs, join = replay + tail, pose
  relay, library asset serving from the eidoverse-video checkout
- Browser client: claudesona avatar, WASD + third-person camera, flat ground,
  idle/walk/run crossfade (full eidoverse controller port is a follow-up)
- Writes: place a model, move it, say something
- Two browsers, one world; reload-and-refold proof
- Then: agent MCPL (text perception + `say`/`walkTo`/`spawn`), retina service,
  replay-to-film demo

Deferred deliberately then: server physics, prediction, contested objects,
sandboxed untrusted scripts, interest management, scale. Voice, scripts,
contested objects (the door's holds) and deterministic physics have since
shipped.
