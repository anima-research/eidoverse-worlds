# Native world projection (version 1)

Implemented locally, not deployed. Browser flora placement has been extracted
unchanged into `shared/flora-placement.js`; browser and native projection import it.

Join snapshots advertise `renderSceneVersion:1`. A joined world-surface client
may send `{type:"render-scene",version:1,reset:true}` for a full projection and
subsequent requests without reset for geometry deltas. World, socket generation
and membership bind the delta cursor. Requests are limited to once per 250 ms
while idle, or 60 ms while deterministic bodies are awake (including delivery
of their final resting pose);
auxiliary/superseded clients cannot use this lane. Backpressured sockets skip it.

Replies contain `world`, `seq`, `time`, `upserts`, `removed`, `transforms`,
`moving`, optional `environment`, and `warnings`. Geometry revisions are derived
hashes, not world-log entries. Structures, terrain and effective motion/mount
transforms come from the existing shared evaluators; the persistent fold is not
duplicated or changed. Per-world geometry caching and per-client cursors avoid
rebuilding/retransmitting meshes for simple transform updates. Error responses
never advance the cursor. An explicit reset recovers after client scene loss.

Limits: 512 entities, 600,000 combined structure position/index numbers, 12,000
parts/collision boxes, 6 MiB reply; failures are explicit and memoized for the
current log revision. Terrain uses authored tessellation clamped to 64–128 cells
per side, preserves the base layer color, and has a maximum 10 km extent.
This is a first bounded projection, not spatial streaming or full component parity.

`GET /library/<relative>.glb?native=1` (also VRM) requests original bytes from
the same public library/store, preserving the deliberate patch precedence.
The default browser request still prefers optimized bytes. Original files that
already require unsupported codecs can still fail in the native client.

Browser native-login approval optionally accepts `all_worlds:true`, issuing a
new native session with `nativeWorld:"*"`. This can ONLY be selected through
same-origin browser approval with a valid join-capable browser session. Start or
poll requests cannot broaden grants. Existing water-only sessions stay water-only;
native sessions cannot approve other native sessions. All existing per-world
rights, bans and identity checks still apply after the destination guard.

Unreal screenshot capabilities may identify `scene:"world-projection"` as well
as `underwater-prototype`. Tool output labels the distinction and warns that
unsupported components may be absent. Screenshot access/consent budgets are unchanged.

Tests: `tools/render-scene-test.ts`, `tools/render-scene-wire-test.ts`, extended
`tools/native-login-wire-test.ts`, existing login/broker/fold suites. Never run
integration fixtures against inhabited worlds. Deployment requires a separately
reviewed production-base patch and operator-approved restart; do not deploy the
entire dirty development worktree.

## Weather, flora and interaction extension

Version 1 gains additive `atmosphere:{clock,weather,time}` on every reply. Clock
and weather use `effectiveClock`/`effectiveSky`, including rated/real clocks,
forecast segments and manual overrides. Geometry is not retransmitted as time
advances. `environment.flora` contains seeded placements from the shared browser
evaluator, species definitions and preset composer; no new persistent state.
Native drawing uses simplified plant meshes, not Three.js textures/generators.
Fields are bounded to 500m, 800,000 placement candidates per stroke/field (5,000
per stroke for occupancy-tested structural plants), 16 strokes and 12,000
delivered plants overall. Large non-row meadows stream canonical placements into
a deterministic bounded reservoir, preserving a subset of browser placements
without retaining the entire field. Unsupported/oversized fields warn explicitly.

Entity `interact` metadata exposes declared reaction action names, sockets and
locked/mounted/moving flags. Revisions track changes to component values, not
just their names. Transforms include the live lease state when available, so a
late join or scene refresh cannot rewind an object to its resting log position.

Replies additionally carry `simulation:{enabled,foreign,activeBodies}` and
`updateIntervalMs` (66 while bodies move, otherwise 300). Epoch worlds project
the canonical sim poses, including settled bodies and mounted children, by
cloning the server cut and advancing the shared versioned law to render time.
Projection never mutates the canonical sim or writes placements. Foreign epochs
retain their barrier poses without recomputation. Live leases still take priority.
This is canonical root-pose parity, not the browser's cosmetic tumble/slope tilt.

Unreal sends ordinary `use`/`punt` verbs (including explicit kick direction).
In epoch worlds it consumes projected physics poses and never volunteers a
competing lease simulation. In pre-epoch worlds it simulates only after receiving
a physics lease grant. State streams, loss/takeover, release and disconnect use the
existing lease contract; that legacy simulation is a bounded native swept-volume
plugin, not the browser integrator. Causes in snapshot
history are never replayed. Receivers apply other holders' streams even when
local simulation is disabled. No new server authority or log verbs were added.

Avatar reaches use existing `pose.reach` relations; native two-bone IK renders
hands/feet aimed at world/self/participant coordinates and anatomical bone seeds
on loaded remote rigs. Native seeds are NOT calibrated skin contacts; the client
never asserts `reached:true`. First-person local hands, palm alignment, native
joint/torso constraints and named targets on the local body remain incomplete.
Wave/cheer/point use the existing one-shot `pose.emote` field. Native gestures
are procedural approximations, not downloaded browser animation clips.
Puppet and bodydrag requests are not accepted automatically; native ragdolls,
mount/seating, force reactions and full streamed body-pose parity remain future work.

Additional scratch checks: `tools/native-environment-control.ts`,
`tools/native-interactions-fixture.ts`, and `tools/leasetest.ts`.

## Component data (water, air, environment, vehicles)

Each upserted entity may carry `data`, the renderer-relevant component parameters
documented in `tools/water/README.md`. Absent when an entity has none of them;
additive, so version-1 clients that ignore it are unaffected.

- `data.water`: normalized by `shared/water.js` `waterParams` — the same law the
  browser uses — `{center, size, absorption, scatter, speed, waves}`. Entity-local.
- `data.air`: `{boxes:[{center, size, q}]}`, at most 16, sizes positive, invalid
  quaternions replaced by identity. Entity-local; boxes follow the live transform.
- `data.environment`, `data.vehicle`, `data.traversal`, `data.collision`: passed
  through as authored (16 KiB cap each; exceeding it fails the projection).

A world is aquatic because its entities carry these components, never because of
its name. The `water` world is an ordinary world imported by `tools/water/import.ts`.
