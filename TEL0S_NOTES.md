# TEL0S_NOTES — rebuild notes: loading · lighting · performance · separation

Status: working notes, 2026-08-08. Orientation + diagnosis by Fable (three
deep read-throughs: loading pipeline, lighting system, module architecture),
design directions proposed for discussion with tel0s. Nothing here is decided.

---

## 1. What must survive the rebuild (the keel)

Before any diagnosis: a list of things the read-through found genuinely
*right*, which the rebuild should carry forward rather than relitigate.

- **The two-plane model** (log vs presence). Stated everywhere, honoured
  everywhere. Not up for debate.
- **The protocol** (`spec/PROTOCOL.md`, CC0, fixtures). Clean, closed verb
  set with three open extension lanes. The rebuild targets runtimes, not the
  log format — existing world logs must replay unchanged.
- **`forecast.js`** — pure, deterministic time-of-day + weather, shared
  verbatim by browser, sequencer, and agent. The best module in the repo.
- **Motion as closed-form `f(params, t)`** with the generous reader
  (`motion.js:45-66`): parsing generous, math exact.
- **One code path for join and live** — `stateToEntries` (`world.js:597`)
  re-synthesizing folded state into synthetic verbs so snapshot-join and
  live entries share an apply path. The principle survives; its *level*
  moves (see §3).
- **Presence interpolation** (`remotes.js:16-28, 97-139, 228-243`) —
  clock-offset smoothing, render-behind, bracket-and-lerp, re-plan on new
  pairs only.
- **The pure/hosted split where it was applied** — `flora_field.js` /
  `emitter_field.js` / `autohooks.js`: DOM-free, unit-tested lifecycle
  registries. **This is the pattern the whole client should follow** — the
  rebuild is largely "apply this everywhere."
- **The flight recorder** (`World.debug` ring + `/debug` + `world_debug`) —
  "the log says what happened; this says why it didn't."
- **The comments.** Nearly every non-obvious decision carries its incident,
  measurement, and date (`net.js:568-576`, `assets.js:198-202`,
  `sky.js:210-216`, `server.ts:1906-1911`…). A ground-up rebuild that
  discards these will re-earn every one of those bugs. **First concrete
  action of any rebuild: harvest them into an incident ledger** (an
  ADR/incidents doc) so the knowledge survives file deletion.
- **The test matrix** (`tools/comptest.ts`, `permtest.ts`, fixture
  conformance, headless stubs). Evidence the pure/hosted split works.

---

## 2. Diagnosis — many symptoms, two diseases

The three pain areas named for the rebuild — loading, lighting, performance /
separation — trace back to **two root causes** plus a layer of measured
hot-path debt.

### Disease A: shader-graph shape instability

On three.js WebGPU, a material's compiled pipeline is invalidated whenever
the *shape* of its node graph changes. Today the shape changes at runtime
constantly:

- Upstream `weather_system` / `sky_system` integrate by **sweeping the scene
  and rewrapping existing materials** after first compile
  (`docs/upstream-wrap-once.md` — 44 materials rewrapped on one Safari join,
  ~2–6s per graph on WebKit, ~0.5s on Chrome).
- Every point-light grant/loss changes the lighting loop of every material
  (`lights.js:11-13`; measured: grass + 4 lights never finished compiling,
  grass + 2 booted in 429ms — `sky.js:726-733`).
- `scene.environment` identity flips (already fixed with the persistent
  512×256 env target, `sky.js:28-35` — proof this disease is curable).

Nearly all the machinery the client is drowning in exists to absorb this one
disease: `holdObjectCompiles` (25s cap), `holdFrames` (4s cap), the light
budget of 4, whole-scene `compileAsync` per light grant, the deliberately
held boot beat, and the boot-order dependency of sky-before-objects — which
is a genuine circular wait broken only by timeouts (`sky.js:218` freezes
object compiles mid-replay; `sky.js:418` then awaits boot; recorded worst
case rode this to the 45s splash ceiling, `net.js:571-576`).

### Disease B: the fold is entangled with realization

The client's `applyEntry` both *updates world state* and *does scene work*
(async asset loads, GPU compiles, awaited terrain builds). Consequences:

- Join replay is a **serial `await` loop over entries** (`net.js:578-590`) —
  exactly the "another serial loader" that `SCALING_AND_SNAPSHOT_PLAN.md` §9
  warns about. 12s of one measured 13s cold boot was one crate download
  blocking the loop (`net.js:562-563`).
- Live entries race each other: `ws.onmessage` is async and unserialized
  (`net.js:333-337`), so ordering is reconstructed downstream via
  `pendingOps`/`pendingMounts` (`world.js:39-46`) instead of guaranteed
  upstream.
- There is no placeholder tier, no priority order (spawn assets fetch in Set
  insertion order, `net.js:566`), no cancellation on demand fetches, and no
  real progress: the two signals a loading UI needs (`hydrating`,
  `entities-settled`) are emitted to **zero listeners**.
- Boot is an emergent negotiation between five subsystems, held together by
  escape hatches: 12s boot-gate escape (`boot.js:153`), 25s compile-hold cap,
  4s frame-hold, 30s shadow fallback (`world.js:114`), 45s splash ceiling,
  1200ms terrain-precompile cap. **The density of timeouts is the
  diagnosis**: they are apologies for dependencies that shouldn't exist.

### Supporting counts (the debt layer)

Loading:
- 3-RTT prologue before the WS even opens; `/avatars` is a **top-level
  await** blocking the whole module graph (`main.js:74`); `core.js:100`
  top-level-awaits `renderer.init()` for every importer.
- No `modulepreload`; the 2.1MB engine is discovered at waterfall depth 3.
- **No parsed-VRM cache** — N wearers of one body = N full parses
  (`assets.js:134`); `.vrm` is deliberately `no-cache` server-side
  (`server.ts:1340`) because names are mutable — content addressing fixes
  both at once. `optimize.ts` excludes VRMs.
- `byteCache` unbounded, retains compressed bytes forever (plan §11.3,
  called out and unchanged); no service worker / Cache Storage.
- `GLTFLoader.parse` is one opaque synchronous stall — no workers, no KTX2.
- Server half of the snapshot plan is **done** (live fold, snapshot + ≤150
  tail, byte-offset restart); client half (placeholders, priority,
  cancellation, persistent cache) is **not**.

Lighting:
- Three systems that don't compose: the sky (sun+hemi+IBL — the only
  physically coherent light), placed lights (one type: PointLight, cap 4,
  never casts shadows, ignores time-of-day — a porch light burns at noon),
  and emissive-derived lamps (client-side inference, ≤2 global, competing
  for the same integer). Which objects win lamps depends on **load order** —
  two clients in one world are lit differently (`sky.js:734-742`).
- `keep` escapes the budget entirely (`lights.js:83`) — 50 kept lights
  reproduce exactly the hang the budget exists to prevent.
- One shadow caster in the world (the sun), static ortho frustum on origin —
  shadows end ~46m out; terrain, grass, and avatars neither cast nor
  receive.
- One-way ratchets: `MAX_CAST` decrements permanently (`lights.js:150`),
  shadow map 2048→1024 never restores (`main.js:1155`), and a transient
  fps dip **writes the cloud downgrade to localStorage** (`sky.js:114`) —
  degrading future sessions.
- Five of eight sky-tuner sliders silently do nothing on the primary sky
  path (`sky.js:660-691` vs `build.js:975-983`).
- Spec drift: `keep` is implemented in four places and appears nowhere in
  `PROTOCOL.md`.

Per-frame hot path (measured/read offenders, worst first):
1. Camera collision: recursive raycast over **every mesh of every entity**,
   three call sites per frame, with `liveEntities()` allocating a fresh
   array each call (`world.js:48`, `controller.js:386`) — while a BVH-backed
   spatial grid sits unused in `colliders.js:286`.
2. `physobj.js:137-149`: O(sims × all colliders) with a `Vector3` allocation
   in the inner loop — same unused grid.
3. `updateGaze` O(n²) per frame (`remotes.js:280-302`) recomputing an answer
   that changes at conversational rate.
4. `_autoParticleSystems` hooks and `tickMotion` run unconditionally — no
   distance or visibility gates.

Separation of concerns:
- `main.js` is four modules in a trench coat (ragdoll, mounts, bodydrag
  receive, pins, consent, voice-mouths, a 190-line command if-chain, the
  governor, an emote toolbar, the frame loop — lines 105–1203 are one giant
  `else` block).
- No verb/comp dispatch table anywhere: a 26-case switch in `world.js:122`,
  a 240-line mirror switch in `server.ts:255`, and **three different
  registration idioms** for evaluators (hard imports, bus subscription,
  per-frame polling).
- Real import cycles, worst: `world → flora → controller → chat → net →
  world` — the whole stack folded into a loop. Four communication mechanisms
  in simultaneous use (module singletons, untyped bus, five hand-rolled DI
  hooks, 34 globals).
- `server.ts` is 2,896 lines / ~11 concerns; `message()` is ~930 lines;
  sync `appendFileSync` per log entry in the ws handler; `readHistory`
  re-reads the whole log per request (self-acknowledged at
  `server.ts:1031`).
- The server imports `foldSkyEntry` and `normalizeParticles` **out of
  `client/lib/`** — right intent (one fold), wrong direction.
- `build.js` contains literal NUL bytes as key separators — `grep` silently
  skips the file.

---

## 3. The organizing principle: fold → state → realize

One idea addresses both diseases and most of the debt, and it is a
*generalization of the repo's own best patterns* (`stateToEntries`, the
`_field.js` split):

**Split the client into a pure fold and a set of scheduled realizers.**

```
log entry ──► fold (pure, sync, shared) ──► WorldState (data, always consistent)
                                                │  diffs
                          ┌─────────────┬───────┴──────┬──────────┬─────────┐
                       models        lighting rig   terrain     sky     grass/…
                     realizer         realizer      realizer  realizer
                          └─────────────┴──────┬───────┴──────────┴─────────┘
                                     ONE scheduler (priority, budget,
                                     cancellation — no timeouts)
```

- **The fold is pure, synchronous, and shared.** One `fold.ts` in a
  `shared/` package, used verbatim by server, browser, and agent — the
  "fold is sacred / mirrored math" house rules become true *by construction*
  instead of by discipline. Folding a snapshot takes milliseconds; hydration
  is no longer a loader.
- **Realizers are registered projections of state.** Each one (models,
  lights, terrain, sky, flora, emitters, motion, colliders) subscribes to
  state diffs and enqueues work into one scheduler. Idempotent: realize
  (state) from scratch or incrementally — join and live are the same path,
  one level up from where `stateToEntries` put it.
- **The scheduler is the only loader.** Priorities computed from (distance
  to camera, asset size, kind: your-body > bodies > near objects > far >
  cosmetics), explicit cancellation tokens (entity removed / superseded /
  world switched → pending work cancelled), bounded lanes, and **zero
  timeout escapes** — dependencies are declared, not discovered. `loadwork`'s
  lanes, `prefetch`'s demand-preemption, and `enqueueWorldBuild`'s gating
  all fold into it.
- Ordering hazards evaporate: live entries fold instantly in seq order
  (fold is sync — no async interleaving); realizers catch up at their own
  pace; `pendingOps`/`pendingMounts` machinery deletes.
- Progress is free: the scheduler knows outstanding work per priority band —
  a real loading bar and the plan's §19 gates (shell in 2-3s, recognizable
  stage in 5s) become measurable instead of aspirational.

### Placeholders make the world appear at fold time

The snapshot (or `/geom`, which already computes bboxes) carries per-entity
bounding boxes → the models realizer instantiates placeholder proxies at
t≈0 (grey box / footprint), swapped as GLBs stream in by priority. Plan
§9.1, finally cheap to do because state install is instant.

---

## 4. Loading, redesigned

Boot becomes a short, declared sequence instead of a negotiation:

1. **Static shell + `modulepreload`** for the known-at-build-time graph
   (three.webgpu.js, addons, vrm libs) — kills the depth-3 waterfall.
2. **WS opens immediately.** The join `hello` carries identity, roster,
   rights, snapshot ref, recent chat, restore pose — the 3-RTT prologue
   (`/avatars` → `/whoami` → connect) collapses into the socket. No
   top-level awaits anywhere in the module graph (`core` exports an
   explicit `init()`).
3. **Fold snapshot → placeholders + terrain proxy visible.** Curtain policy
   becomes a *choice* measured in one place: your body (idle+walk only) +
   folded state + terrain. Everything else streams behind by priority.
4. Sky, grass, prefetch, shadows, clip hydration: ordinary low-priority
   scheduler entries — `whenBooted()` gating deletes.

Asset identity and caching:

- **Content-address everything, including VRMs** (plan §10) — mutable names
  become alias → hash. Kills the `.vrm no-cache` hack, enables
  `immutable` caching, service worker + Cache Storage for warm joins, and
  honest cold/warm progress. Extend `optimize.ts` to VRMs.
- **Parsed-prototype caches with refcounts and bounds**: bytes (evictable
  once decoded), parsed GLB prototypes (exists), **parsed VRM prototypes
  (missing — the single biggest miss for a 24-body room)**, compiled
  pipelines. The plan's §11.3 language adopted as a contract.
- **Parse off the main thread**: GLTF/Draco (and later KTX2/Basis) decode in
  a worker pool; main thread does sliced GPU upload only. This attacks the
  one genuinely unsliceable stall.

With Disease A cured (§5), the compile-hold machinery — the *other* half of
load jank — deletes outright.

## 5. Lighting, redesigned

**Contract: the shader graph's shape is fixed at boot; runtime changes are
uniform writes.** This is the wrap-once ask (`docs/upstream-wrap-once.md`,
option 2 — ubershader, uniform-gated) pursued in two moves:

- **Client-side material factory**: every material entering the scene passes
  through one factory that applies all wraps (wetness, cloud shadow, light
  slots) at creation, *before* first compile. New assets compile once,
  against their final graph. No sky-before-objects dependency → the
  circular wait and both hold mechanisms delete.
- **Upstream ask stands**: factory-form wraps or built-in uniform-gated
  branches. The adapter shrinks as upstream improves (the
  `emitters.js:26-28` doctrine).

**One lighting rig** (a realizer) owns every runtime light:

- Sun + hemi + IBL: sky-driven, as today — this part is healthy.
- **N fixed light slots** (target 8–16 once adds don't recompile), allocated
  at boot, driven to zero when idle. Placed lights and emissive lamps become
  *light requests*; the rig assigns slots by priority: distance to camera,
  authored > inferred, `keep` as top *priority* — **not** a budget escape.
  Slot churn = uniform writes. Deterministic given (state, camera), so two
  clients in the same spot light the same way.
- **All lights live in time-of-day**: dayness/exposure context flows from
  the rig; placed lights dim by day like lamps do (opt-out via a comp field
  if someone wants a noon-burning porch light *on purpose*).
- **Shadows**: the sun cascade follows the camera (step 1: re-centre the
  existing ortho on the player — a few lines; step 2: CSM). Terrain
  receives. Caster set is rig-budgeted by distance, replacing the
  250ms-per-object drip.
- **Governor with two-way levers**: one quality controller owning
  (clouds, slots, emitters, grass, pixel ratio, shadow res) with degrade
  *and recover* paths, session-scoped — never writing user preferences.
  Tuner sliders either work or don't exist.
- Spec: document `keep` (or its successor, `priority`) in PROTOCOL.md; add
  a fixture.

`forecast.js` and everything upstream of `nowHours()` is untouched.

## 6. Client architecture

- **`shared/` package** (server ← shared → client ← agent): protocol types,
  `fold.ts`, `forecast.js`, particle/motion normalization, the pendulum
  math (one file ends the mirror rule).
- **One registry shape** for verbs/comps/realizers/frame-systems — replaces
  the 26-case client switch, the 240-line server switch, and the three
  registration idioms. AGENTS.md's "register nothing" becomes "register
  once."
- **Frame loop as an explicit system list** with per-system budget + enable
  flags; the governor manipulates systems, not ad-hoc levers. Target:
  `frame.ts` under ~120 lines.
- **`main.js` dissolves** into boot / local-body (ragdoll, pins, mounts,
  consent, shove) / commands (registry, one file per command) / governor /
  frame.
- **Spatial index as a service** (the `colliders.js` grid, promoted):
  camera collision, physobj contacts, seat search, and gaze all query it.
  Fixes hot-path offenders 1–3 in one move; add distance gates to emitter
  hooks and motion ticks for #4.
- **`HostAdapter`** — one seam for eidoverse-video: `loadModule`, `prime`,
  `registerHook`/`retireHook`, `makeSky/makeTerrain/createFlora/…`. The
  eval + Deno shim + 34 globals live behind it.
- One communication idiom: state reads + typed events; globals only inside
  the adapter.

## 7. Server shape

Split along the seams the file already shows (behaviors/geometry/optimize/
aid1 prove the pattern): `auth` · `moderation` · `rights` · `reactions` ·
`lint` · `routes` (table; `/upload` its own module) · **verb table**
(`{rank, validate, fold, after}` — replaces the 280-line verb case and
the five post-append if-chains) · `World` → `WorldLog` (persistence) /
`WorldState` (fold, from `shared/`) / `WorldSession` (clients, leases,
broadcast). Async/batched log appends (sync `appendFileSync` per entry sits
in the ws handler today); segmented log + index (plan §6) when history
queries actually hurt — `readHistory`'s full-file read is the present
offender.

## 8. What "ground up" should mean

Recommendation: **rebuild the skeleton, transplant the organs.** The
protocol, fold semantics, forecast, motion math, presence interpolation,
`autohooks`, the `_field` modules, and the flight recorder survive nearly
verbatim. What is genuinely ground-up: the boot path, the scheduler, the
lighting rig, the frame loop, the module graph, and the server's dispatch —
the *connective tissue*, which is where all the pain lives. A parallel
big-bang rewrite would re-earn every measured incident in the comments; a
skeleton-first strangler keeps the world bootable at every step:

1. Harvest the incident comments into an incidents/ADR ledger.
2. Extract `shared/` (fold, forecast, protocol types) — server stops
   importing from `client/lib/`; agent folds identically. Pure motion.
3. Land the scheduler + state/realize skeleton; port realizers one at a
   time (models first, then lights, terrain, sky, flora, emitters).
4. New boot path (1-RTT hello, placeholders, curtain policy).
5. Material factory + lighting rig (Disease A cure; holds delete).
5½. Streamed residency (demote/promote + proto eviction) and grass
   render optimization (culling, tiling, distance density) — §13.
   Inserted 2026-08-09 at tel0s's direction, before main.js dissolves.
6. Dissolve `main.js`; frame-system list; spatial-index service.
7. Server split.

Each step is independently shippable and testable against the existing
fixture/tool matrix.

## 9. Decisions (2026-08-09, tel0s + Fable — was "Open questions")

1. **Compatibility scope.** Existing logs replay unchanged. The snapshot
   grows optional per-entity bboxes (placeholder tier without a `/geom`
   round trip) — a fold-output addition, not a verb change.
2. **Upstream (Skye) vs local ownership.** tel0s will talk to Skye about
   the wrap-once / `dispose()` / seed asks; meanwhile we build the
   material factory ourselves — never bottleneck the rebuild on upstream.
   The adapter shrinks as upstream improves.
3. **Browser targets.** Chrome-first for the rebuild; Safari/Firefox
   support wanted not long after. Graph-shape stability is held as a
   standing constraint precisely because it is what makes WebKit
   *possible* later without redesign.
4. **Workers.** Yes to a small decode-worker pool, staged after the loader
   skeleton lands, as plain ES-module workers
   (`new Worker(url, {type: 'module'})`) — no build step. KTX2/Basis waits
   for the asset pipeline plus measurement.
5. **No-build doctrine holds.** `shared/` is plain JS + JSDoc types; Bun
   imports it from TS directly, the browser natively; type safety via
   `tsc --noEmit`. Revisit only if JSDoc friction becomes real.
6. **Spectator client is in scope** — it is important, and it is exactly a
   second, smaller realizer set over the same folded state.
7. **Placed lights stay PointLight-only** for now (the rig + slots +
   shadows are the actual win); a light-kinds conversation soon.

## 10. Progress log

- **2026-09-01 — §24t-9: CATCH-UP MERGE (9072ffa).** anima/main was
  one commit ahead (a468cba — geometry LOD for placeable objects,
  #156: optimize.ts --lod, store-variants LOD recipe, upload.ts, a
  600-line object-lod-test). One conflict, the upload.ts import
  block: upstream's LOD names ride in, the door stays on R1's
  aid1JoinIdentity (the HN_*/verifyToken form is what R1 replaced;
  the merged body references neither). Gates on the merged tree:
  object-lod-test 0 failed (upstream's own), smoke 85/85, sim-smoke
  10/0, sim-test 32/0, replaybench 1/1, parity PASS. rimward is 0
  behind anima/main; colleagues take 90 commits with
  docs/UPSTREAM-FLAGS.md as the briefing. Local `main` untouched this
  round (tel0s's call whether it follows).

- **2026-09-01 — §24t-8: COLLIDERS FOR THE SIM, AND THE PROD FLEET
  (a2c29dc, 5caa264).** tel0s's ruling: an asset's geometry reaches the
  sim the one way Covenant III allows — the SEQUENCER stamps it into
  history. EIDOSIM@0.3.0: server/boxes.ts is a warm cache of model
  boxes (summarizeGlb, mm-rounded), filled on every join and awaited
  on the wire before a spawn/epoch reaches its sync validator
  (messages.ts; only a never-seen lib pays one file read);
  `spawn.box` under a live epoch (client box discarded), `epoch.boxes`
  for every standing lib at the barrier. The sim folds them into a
  STATIC table (yaw-rotated scaled local box → world AABB; yaw via
  simmath's sinT/cosT — the kernel's first shipped use); a punted body
  carries its own. Per tick: a static whose top the body was above and
  whose footprint it overlaps is GROUND (land on a crate, slide, rest
  ON it — `b.on` names the support; the applier skips the terrain lift
  then); one met from the side pushes out along the shallower
  horizontal axis and reflects that velocity (wall bounce); a slider
  losing its support by more than STEP_DOWN 0.3 FALLS instead of
  gluing; a rested body is a static again. Collider changes (place/
  remove/mount/dismount/motion) advance to their entry's tick first —
  live fold ≡ replay, proven. 0.1.0 AND 0.2.0 carried untouched:
  commons's 0.2.0 replay digest IDENTICAL under the new build (proved
  against HEAD's sim.js on the real log). Scope stated: no body–body
  collisions in flight, resting bodies not woken, structures not
  stamped (⚑ §6). sim-test 21→32, sim-smoke 9→10 (the stamp, not the
  client's), sim-ground-smoke 7/0, replaybench, parity. PROTOCOL_v2
  §2 delivered note + §6 row. THE PROD FLEET (tel0s copied 44 rigs
  into the overlay — one directory too deep; flattened): board before
  ragdoll 56/3, ammodoll 68/1 → after ragdoll 59/1, ammodoll 69/0,
  bodysim 20/0, reachrig, settled-pose 19/0, NO table touched. (1)
  HANDOVER carried no hinge axes: the transported normals were rebuilt
  from REST on a seeded doll → hands 12–22cm off after ONE step on
  41/44 rigs (the one-rig check sat on a rig that barely moved its
  arms — now fleet-wide); snapshots carry `h`. (2) snapshot ROUNDING
  is chaos food: 0.1mm/1mm·s⁻¹ → 1–35cm at 80 steps on 20 rigs; exact
  → 0.00cm; the packer is full precision. (3) tel0s's skeleton is
  authored 0.233m forward of its root: _followRoot drew the corpse
  23cm from its physics and the drive read bone positions 23cm off
  the particles → spine antiparallel, stale frame, chest 42° roll —
  drive directions from particles now, _measureHipsLocal in the base
  (both engines). (4) ammodoll widened limits in the UNcentred Euler
  frame while Bullet measures in the centred one (Euler angles are
  not additive across axes): feline's stride still 8.6–10.7° over →
  fixed-point iteration of the centering; a LOCKED axis born off locks
  AT the born angle. OPEN, NAMED BY THE BOARD: post-landing CREEP —
  the ground contact is a pure vertical clamp; mythos-2 after a shove
  lands +37cm then creeps back 39cm over 5.5s while an arm fights its
  limits (painthair 7cm). Every constraint family toggled changes the
  outcome (chaos); a sleep-regime grip made feline flail → reverted.
  Wants a tuned ground-friction law swept in rag-tune — colleague
  territory; the shove check judges the shove (a second after), a new
  check judges the creep. UPSTREAM-FLAGS §3a carries the whole run.
  LESSONS: a per-rig check on FLEET[0] is a check on one rig's
  temperament; a handover is the SAME body — carry every transported
  state and carry it exactly; when an instrument-scoped fix moves the
  board the wrong way, revert and name the item rather than tune.

- **2026-09-01 — §24t-7: THE ARM FITTED TOO EARLY (8488283).** tel0s,
  after §24t-6, on FLAT ground, reloaded, private window: "the barrel
  really is dropping through the ground for a moment before resettling
  on the surface" — and rightly suspicious of the interpolation, since
  it began with that build. Two probes cleared the interpolation (a
  convex blend of two on-or-above-ground poses cannot undercut them;
  0/300 frames below the law; a position.y setter trap on the barrel
  caught zero below-ground writes). The third probe — a copy of
  commons, punting FROM the page, sampling the RENDERED mesh's lowest
  world point per frame — showed the mesh climbing 1.37m while the
  origin hopped 0.28m: the cosmetic tumble was running on the barrels
  and sweeping the 1.3m (scaled) arm in an arc; for tel0s's −z/+x
  punts the arc goes DOWN through the ground, and the righting slerp
  brings it back — the report, verbatim. WHY the §24t-4 arm gate let
  it through: the geometry was fitted from the collider box ONCE at
  the applier's first sight of the body; a body already resting in
  the join snapshot is seen on the first frame after hydrate, before
  its model has loaded and its box exists → cached "origin-centred"
  for the tab's life. Every earlier probe spawned then punted (model
  loaded, arm right); tel0s's barrel has been a resting sim body since
  punt 104, so EVERY RELOAD since — the first being for the
  interpolation build — re-armed the tumble; the same stale fit
  zeroed the §24t-6 lift ("still getting it to an extent"). FIX: the
  fit re-runs whenever the collider box identity changes; unknown
  geometry = no tumble, no lift. sim-ground-smoke flight 3 reloads the
  page with the body in the join snapshot and asserts no tumble (max
  tilt 0.0°) and the mesh never below its ground (0.000m) — on the
  previous build the same flight went 1.37m up, then through the
  floor. LESSON for the notes: a per-frame gate that reads a lazily
  built index must re-read it, never memoize its absence. Gates:
  sim-ground-smoke 7/0, sim-smoke 9/0, parity PASS; commons-copy probe
  0 frames below ground.

- **2026-09-01 — §24t-6: THE GHOST'S VERTICAL HALF (aaccf29).** tel0s:
  "gravity overrides and the barrel clips down through the ground when
  I punt it, before it pops back up to its new resting place on the
  meadowgrass." The sim never does — every tick of all five commons
  0.2.0 flights has y ≥ g — and neither does the applier (a frame-
  sampled probe in a scratch hilly world: 0 frames below the terrain
  law in 300). It is the barrels' two-metre ghost (§24t-4), vertical:
  the sim grounds the entity ORIGIN (all it can know — the mesh is an
  asset fact never in the log) and the visible cluster stands 1.95m
  away on a slope where the ground is somewhere else. Measured along
  tel0s's own punts (seq 107–108): the cluster sat up to 29cm inside
  the hillside at every landing, surfacing briefly at the top of each
  hop — exactly the report. FIX: the applier shows the visual center
  standing on ITS ground (lift by the terrain difference between the
  two footprints — collider-box center × scale rotated by the sim's
  yaw). Presentation only, like the tumble; ~0 for origin-centred
  models, 0 without terrain, never read back. NEW GATE
  tools/sim-ground-smoke.ts (commons's terrain, the barrels at seq
  108's launch, two flights sampled per frame): origin never undercuts
  the law, cluster never sinks (worst −0.0001m), rests ON its ground
  (0.0000m) — the same probe read 150/150 frames below, worst −0.29m,
  before. UPSTREAM-FLAGS §3b gains the vertical consequence + the two
  residues only the asset fix removes (a body RELEASED to the fold is
  realized at the authored origin height; the static terrain re-seat
  seats by origin) + why the re-export is a migration (every logged
  pos names the current origin). Gates: sim-ground-smoke 5/0,
  sim-smoke 9/0, sim-test 21/0, parity PASS.

- **2026-09-01 — §24t-5: THE FLIGHT WITHOUT THE JUDDER (b629e50).**
  tel0s confirms 0.2.0 fixes the physics (commons carries the
  eidosim@0.2.0 epoch at seq 102) and asks for the thing PROTOCOL_v2
  §5 always promised: "clients interpolate presentation between ticks
  exactly as they interpolate presence" — the shadow sim advanced to
  the ceil-quantized tick, so a 66ms tick painted four frames running
  on a 60Hz display ("I can sort of see the individual physics
  updates in the form of juddering"). The applier now remembers every
  body's position at the tick BEFORE it steps the sim across a
  boundary and shows the lerp of the two at now's fractional phase:
  because tickOf rounds UP, the current state is the interval's END
  and the previous tick its START — exact sim time, zero added
  latency, never an extrapolation (nothing overshoots a bounce or the
  ground). Remembered starts are dropped whenever anything else moved
  the sim (an intent whose ts ran ahead of this clock, a new epoch):
  those bodies show the word outright until the next boundary — v0.1
  behaviour, the header's skew doctrine unchanged. Resting bodies
  stand on the word exactly (the collider re-index reads it).
  PRESENTATION ONLY — no sim number is read back; the parity legs
  read state.sim. sim-smoke gains a ninth check: the realized ball
  moves on (nearly) every animation frame while in flight — 47/47
  live frame pairs (tick-stepped managed ~1 in 4). Also dropped the
  round-3 PUNT-DEBUG probe line. PROTOCOL_v2 §5 records the delivery.
  Gates: sim-smoke 9/0, sim-test 21/0, replaybench 1/1 (re-recorded —
  the playtest grew commons), parity PASS.

- **2026-08-31 — §24t-4: THE BARRELS' TWO-METRE GHOST (d6295cd).**
  Round 4 closed the constant-direction mystery with a ruler:
  scifi_barrels_group_of_four.glb ships its geometry 1.95m from the
  model origin (bbox center [−0.001, 0.504, −1.953]). The entity
  origin — what /punt aimed through, what reach measured, what every
  rotation pivots on — hangs in EMPTY AIR 2m from the visible
  cluster: standing "directly in its way" still put tel0s behind the
  ghost, so all nine logged punts stamped +z (the log reconstruction
  shows the barrel marching 24m north, puncher forever 1–3m behind
  the origin). The same offset powered round one's "wide arc through
  the ground" (any rotation sweeps the mesh on a 2m arm). FIXES:
  colliders.entityWorldCenter(id) — where a thing VISIBLY is (box
  center × scale × yaw + position); physobj kick() measures nearest/
  reach/direction by the center (proven with the real model in a real
  client: north-of-visible stamps [0,0.9,−1], south stamps
  [0,0.9,+1]); the cosmetic tumble AND the legacy spin are arm-gated
  (visual center >0.5m off origin ⇒ arc without spinning).
  UPSTREAM-FLAGS §3b: the asset wants re-exporting origin-centred;
  summarizeGlb makes a library-wide offender audit a one-liner.
  MEANWHILE the righting-mid-air report persists because commons
  NEVER ENTERED 0.2.0 — the log has no new epoch entry (old sequencer
  build still running, or /epoch not re-run): restart the sequencer,
  /epoch once, and the flat floor is history. Gates: sim-test 21/0,
  sim-smoke 8/0, replaybench 1/1, parity, panelbench.

- **2026-08-31 — §24t-3: EIDOSIM@0.2.0 — terrain-aware ground
  (c5ba7ed).** Round 3 solved the whole mystery: tel0s plays on HILLY
  terrain, and 0.1.0's flat floor grounds every flight at launch
  altitude — a hilltop punt lands on an INVISIBLE floor over the
  downhill meadow. That is BOTH remaining reports at once ("stopped
  above the ground"; "rights before hitting the ground" — it truly
  landed, on the flat floor; the tumble gate was innocent). The
  "constant direction" was the chase dynamic + pre-fix orphaned fold
  (the logged dirs seq 82–95 vary honestly). NEW shared/terrainmath.js:
  the toolkit height law (already nearly covenant-clean: integer-hash
  mulberry32 + value-noise fBm, NO transcendentals) in pure exact ops —
  two stated substitutions (pow→halving, hypot→sqrt); ≥99.8%
  bit-identical to the walked mesh, worst Δ ~1e-15. shared/sim.js:
  SIM_ID=eidosim@0.2.0, BOTH laws carried — 0.2 folds terrain entries
  (epoch adopts standing terrain; mid-epoch terrain releases every
  body; grounded sliders GLUED to terrain; rising ground splats;
  terrainless = flat fallback; snapshot carries params), 0.1 path
  UNTOUCHED — replaybench digest for commons (0.1.0 flights) UNCHANGED
  across the bump, the Covenant-II proof. Live upgrade is clean via
  §24t-2's machinery: /epoch on a 0.1 world mints 0.2 (different sim ≠
  idempotent-refusal) + epoch-release places carry bodies across.
  End-to-end: hilly scratch world, punt launched at −0.338, rests at
  terrain −0.453190 under it, bit-exact. Gates: sim-test 21/0 (8 new
  incl. the 0.1.0 law pinned BY NAME), sim-smoke 8/0, replaybench 1/1,
  smoke 85/85, parity. PROTOCOL_v2 §2 records it. tel0s's next step:
  run /epoch once in commons — it upgrades the world in place.

- **2026-08-31 — §24t-2: PLAYTEST ROUND 2 (82ae29a).** Three reports,
  one root: the fold and the sim disagreeing about where a punted thing
  IS. (1) /epoch IDEMPOTENT — same sim+tick refused pre-log (the entry
  would clear every live body: a mid-flight barrel freezing in the air
  IS the "stopped above the ground"). (2) A REAL re-epoch (different
  tick) now RELEASES bodies into the fold: the after-hook commits each
  live body's last sim word as place {via:"epoch-release"} (the lease
  table's own release shape) — the stale-fold orphaning was also the
  true "too far to kick while standing next to it" (vPunt composes
  sim→lease→FOLD, and the fold held a spawn point punts ago). Verified
  live: rest 3.78m → re-epoch → fold reads [3.7834,0,0] + release
  entry in history. (3) /geom composes simPose like vPunt already did
  (agents measured punted crates where they USED to be). (4) the
  cosmetic tumble rights on the sim's own word (v[1]!==0), not a
  height threshold — tick-quantized descent+bounce-tail righted
  barrels visibly mid-air. replaybench baseline re-recorded (the local
  commons log grew — the playtest itself). NO sim-law change. Gates:
  sim-smoke 8/0, sim-test 13/0, replaybench 1/1, smoke 85/85, parity.

- **2026-08-31 — §24t: THE PUNT PLAYTEST (f6c7eed).** tel0s booted
  barrels: "spin through the ground in a wide arc, then slide far
  away". Three findings, ZERO sim-law changes (no epoch bump): (1) the
  world had NO EPOCH — entering one took a raw world_verb, so the
  playtest of the new physics ran the LEGACY volunteer sim; /epoch
  [tickMs] is a command now (owner-ranked server-side). (2) shapeOf
  classified any round-ish bbox as a BALL — the 2×2 barrels group
  rolled about its origin (mesh sweeping the ground) on ball friction;
  the ball test now requires ball SIZE (<0.9m), furniture-scale things
  tumble+settle like crates. (3) feel: default power 5→4, epoch lift
  ratio 0.45→0.9 (the sim normalizes the stamped vector — at 0.45 a
  default punt apexed at 6cm, a scoot; now a knee-high hop, apex
  0.28m, rest 2.8m; all INPUTS, logged meaning unchanged), plus a
  COSMETIC tumble in simworld (airborne bodies tumble ⊥ travel, right
  themselves grounded — presentation-only, position untouched, parity
  reads position). /KICK IS MODERATION, SOLIDLY (ruling): the
  one-word-two-acts overload died; /punt owns physics and gained
  people — /punt <person> = the consented ragdoll shove (shovePerson
  shared with /push; the target's client decides). Help def +
  registry updated. Gates: sim-smoke 8/0 (browser leg runs the tumble
  applier), defs-smoke 31/0, smoke 85/85, paritybench, panelbench.

- **2026-08-30 — §24s: THE OPEN ROAD — owned numerics + the renderer
  seam (4235a38, fb85d8c, 8a739fa).** (1) docs/UPSTREAM-FLAGS.md: the
  one-document merge briefing for colleagues (6 upstream reds w/ fixes,
  the now-live dormant features, the physics instrument fixes prod may
  want, process lessons, the structural map). (2) shared/simmath.js
  (simmath@0.1.0): Covenant I's owned-numerics kernel, delivered in
  no-build plain JS instead of the promised wasm — sinT/cosT/atan2T/
  expT from ONLY the covenant-blessed exact-op set (Cody–Waite two-word
  reduction, fixed-order Taylor with exact-op coefficient divisions,
  atan argument-halving, exponent-bit 2^k with a load-time self-check).
  Bit-identity is a property of the CONSTRUCTION; coefficients are the
  version. Accuracy ≤1 ulp sin/cos to 1e7 rad. tools/simmath-test 14/0:
  a 48,000-point sweep digests IDENTICALLY under Bun-JSC, node-V8 and
  deno-V8, pinned to a committed golden. No shipped sim uses it yet —
  it exists so §6's vocabulary can grow without reopening Covenant I
  (PROTOCOL_v2 §2 records the delivery; wasm stays the named fallback).
  (3) docs/RENDERER-SEAM.md: full 113-module inventory of the charter
  thesis — ALREADY ~63% TRUE by line count (shared/ provably
  three-free; 72 modules import no three; the 17k coupled lines
  concentrate in ten files); two channels (core.js import chokepoint,
  the globalThis host contract — the big unsealed one); four-move
  program. MOVES 1+2 EXECUTED same day: client/lib/capture.js (the one
  framebuffer-readback primitive — net.js snap + screenshots; avatar
  portraits deliberately NOT unified, offscreen-subject ≠ frame
  capture; survey correction: world.js compileAsync was already
  warmqueue-conducted) and client/lib/base.js (bus/CONFIG/report/
  colours/helpers split from core.js, 59 modules retargeted; core.js =
  127 lines of pure presentation substrate; headless suites now run
  the REAL bus/report). Move 3 counted: first-party code uses 76 THREE
  symbols — a written-downable interface. Move 4 (replace the globals
  contract) is upstream-shaped and waits on coordination. Gates all
  green (parity/light/panel, both dolls, bodysim, defs-smoke, smoke,
  sim suite + simmath). REMAINING OPEN ROAD: seam move 3 (mechanical,
  large churn), move 4 (needs Skye/colleagues), §6 sim vocabulary
  (⚑-open, colleague call), the doll run on prod's fleet, and the
  engine decision itself (Phase 0/2 — reopened, colleague territory).

- **2026-08-30 — §24r: THE TWO §C CALLS, delivered (3a5d93d, d44dc02).**
  tel0s ruled: port the seats write-half, unify the stdio door. (1)
  SEATS: the #101/#105 store was three-review-rounds-hardened with ~90%
  unreachable — no HTTP proposal door, no verdicts served, judge()
  never called. The spec already existed as tools/seat-lifecycle-test
  (37 checks, authored to FAIL ON MAIN); it passes whole now. POST
  /seat-profile: NAMED actor only (tokens.json bearer or aid1 — the
  /upload legs; the anonymous door token is 401, a seat profile moves
  every wearer), proposals ONLY (countersign keeps NO HTTP path — the
  operator tool on the box), immediate announce (the store's mtime
  bookkeeping keeps the 5s poll from repeating it). /avatars entries
  carry the PRE-JUDGED `seat` verdict + x-profiles-rev. seats.ts owns
  the one live store + announceProfileUpdate (one push, two writers,
  no drift). Test fix: the clip sha now resolves the SAME serve ladder
  the store judges (patched fork first) — hashing the library copy
  read "stale" forever against bytes no client animates. (2) STDIO
  DOOR: mcpl/tools.ts is the ONE table + ONE dispatcher — TOOLS moved
  verbatim; the 26-case 460-line handleTool switch became HANDLERS
  (verbs.ts treatment, §B3's deferred item, bodies verbatim) with a
  LOAD-TIME advertise⇔handle assertion; host differences ride ToolCtx
  (persistence hooks, push/hold activity truth, catch_up cursor,
  travel as a session-only hook). net-server 1981→1445; the stdio
  server 258→82 — a pure transport now, 16→34 tools (pose, reach,
  animate, measure, world_history, sheets… free forever). NEW
  tools/stdio-door-test.ts 13/0 — that door's first test EVER, real
  JSON-RPC over stdin/stdout. Gates: seat-lifecycle 37/37,
  seats-store, seatcore, smoke 85/85, typing-mcpl, whisper-disable
  5/5 (regexes retargeted to the table), join-rfc005 59/0,
  door-cap-gate-live 23/0, channel-cap-gate 19/0, approach-wire 27/0,
  media-whitelist 27/0, defs-smoke 31/0, paritybench. Pre-existing
  env reds verified unchanged at HEAD: spoken-say-door, keepalive,
  incident-88-door (fixed-port class). EVERY SURVEY ITEM (§A–§D,
  R0–R4, both §C calls) IS NOW CLOSED.

- **2026-08-29 — §24q: R4 — panels and defs round two, delivered
  (20e998c…b7254d9).** Four gated slices. (1) NEW client/lib/rows.js —
  the house row builders (sliderTable/checkRow/selectRow/btn/btnRow/
  sectionHead + the SELECT_CSS skin), dumb on purpose: layout and
  wiring, never state, so reset stays write-then-repaint everywhere.
  debug.js collapsed onto it 917→727 (the slider-table loop was
  spelled SIX private times in that one file; three copy-buttons →
  copyBtn+tableLiteral; five section heads → a [head, builder] loop).
  (2) BUILD.JS FIVE-WAY SPLIT along its own banners: 1301→504 gesture
  core (mode/selection/ghost/drag/undo + the ONE pointer/key router) +
  seatedit.js (the seat-anchor grammar; the router hands gestures
  across the seam — armed placement outranks the ghost, gizmo picks
  lose to it, exactly the old ladder; hooks back = build.js exports,
  cycle eval-safe by construction) + palette.js (models/avatars/
  upload/STARTER) + groundpanel.js + skypanel.js. main.js/mybody.js
  retargeted; toggleBuildMenu had ZERO consumers and died. (3) THE
  GROUND VOCABULARY IS A DEF (defs/ground/_palette.json +
  shared/grounddefs.js): tints (the hexes that sat beside _colors.json
  references), shapes, grass dials, and the five planting bags — blade
  plantings declare their tint column and take the height dial, the
  mojave planting NAMES its flora preset as data. SINGLE-SOURCE: no
  fallback vocabulary (the fallback would be the mirror reborn); a
  defs push repaints in place carrying the author's dials. (4) SKY
  CLOCKS + HELP AS DEFS: defs/sky/_clocks.json (the hardcoded LA tz;
  validator checks every tz against host IANA — a typo would throw
  inside hoursAt on every client at once; a committed tz the def
  dropped shows as a raw-tz option, never as "authored") and
  defs/ui/_help.json (ui.js's 120 lines of prose; a world can reword
  its own welcome; the layout section stays code-side for its live
  reset button; KEYMAP export dead). All on the presets law — commits
  write concrete args, the log never stores a def name. NEW GATE:
  tools/panelbench.ts (16 checks) — the panels lazy-build on open, so
  construction errors were invisible to every boot gate and the
  surfaces went their whole lives eyeball-only; now a scratch world +
  headless Chrome opens all four sections, round-trips edit mode,
  reads the help sheet, counts the debug panel's 45 sliders, and
  demands zero console errors. NOT def-ized deliberately: sky slider
  specs (code-shaped UI plumbing), Piper voice + STARTER (small; on
  demand). Gates held per slice: panelbench 16/0, defs-smoke 31/0
  (was 28 — +ground/clocks/help), paritybench, lightbench 30/30,
  smoke 85/85. THE SURVEY'S PROGRAM (R0–R4) IS COMPLETE; outstanding:
  the two §C colleague calls (seats write-half, stdio door) and the
  handleTool table that rides them.

- **2026-08-29 — §24p: R3 — the dolls share a spine (453aaf2).** The
  survey planned R3 against three engines; rapierdoll's retirement and
  upstream's shared/joints+humanoid shrank the honest remainder, and
  this is it. NEW client/lib/rigmeasure.js: the truths the two
  survivors must AGREE on, one copy each — the 12-pair body cut
  (byte-identical as CHAINS/CORE_SEGMENTS until now; JOINTS +
  DRIVEN_BONES derive, re-exported from ragdoll.js for avatar/bodydrag),
  closestParams + segDistance (ammodoll had re-spelled the solve inline
  as segd), rigFrameOf, and the {j,p,v,dy} HANDOVER FORMAT packed and
  parsed once — that one is a wire surface (a verlet on one machine
  seeds a bullet rig on another; four spellings before). NEW
  client/lib/bodyengine.js: BodyEngineBase, the engine contract stated
  where both engines stand on it — lifecycle fields, .pinned, the
  impulse law (cap 8 + _topple + clock restart), the settle CLOCK law
  (pinned resets, quiet accumulates, cancel clears; thresholds stay
  engine-tuned — the verlet keeps its hysteresis band, the bullet its
  linear+angular quiet), root-follows-hips. The verlet stops mirroring
  shared/joints.js torsoRadius (calls it now — the comment there had
  promised "the same derivation the ragdoll uses"). RAPIERDOLL
  RECOVERY: ammodoll's static build asks nearColliders (the §14.2
  service query) instead of scanning the whole colliders map. NEW
  tools/bodysim-test.ts, 20 checks: the makeRagdoll seam had ZERO
  coverage (how dropped-seedVel lived a month) — now asserted: verlet
  floor while wasm warms, loaded engine answers, stored choice,
  unknown-name fallback, interface parity, single ownership of the
  shared spine, and a handover snapshot with hips 0.5m from the bones
  reaching BOTH engines through the door. Harness dedupe SKIPPED: the
  236 identical lines are down to 27 of generic scaffolding (rig-load
  absorbed the truth); boilerplate is not a mirror. Boards unchanged
  through the whole extraction: ragdoll 59/0, ammodoll 68/0. Gates:
  bodysim 20/0, settled-pose 19/19, reach/reachrig/reachwire,
  paritybench, lightbench 30/30, bootjank clean. KNOWN-RED (pre-
  existing at HEAD, upstream's): avatar-test — their reach integration
  calls _reachOwned on the test stand-in avatar, which lacks it; add to
  the flag-to-upstream list. R4 remains; §C colleague calls unchanged.

- **2026-08-29 — §24o: THE DOLL BOARD GOES GREEN — the four reds were
  two bugs and two lying instruments (253bf10).** Ruling from tel0s:
  fix knee/fold in how the dolls APPLY limits, not in the tuned tables
  — and the tables indeed needed nothing (shared/joints.js untouched).
  (1) Knee "hyperextension" (claude_suit 117°, mythos-wings 126°) was
  the tumble suite's POSITIONAL instrument misreading a legal fetal
  fold: it compared shin deviation against torso-forward, valid only
  below 90° of thigh flexion in the measuring frame — hips at their
  stop plus legal spine curl put the thigh at ~119°, where a legal
  backward fold reads a forward component of exactly −cos(thigh angle)
  (predicted 0.49, measured 0.48). Every leg joint sat within 6° of
  its table the whole time. The instrument now predicts the legal fold
  direction from the thigh's own swing-from-rest; control with
  inverted knees fires at 123°. (2) The hand-tuned hip row (flex 90 /
  ext 8 / twist 0 / z ±13) RESTORED — parked for the wrap-point class,
  whose fix (range centering) landed months ago with a "put the row
  back" note nobody collected. (3) The wings 73°-vs-72° crumple was
  foldOf normalizing mythos-wings' 7.2mm hips→spine bone (the rig
  authors its real span in upperChest) — direction noise under a
  millimeter of Bullet linear slack while both spine joints sat at
  their 10°/20° stops; lower axis now hips→chest, same function for
  both engines. (4) The wings shove Δx=−0.63 was not direction bias
  but CHAOS: the verlet's hips-spine-chest FLEX cone read that same
  7mm link's noise-direction and swung the real spine→chest link in
  answer, every substep — 65 m/s peak at ground impact on a plain
  topple (claude_suit 3.8), six seconds of thrash drowning a 2.5 m/s
  shove. FLEX rows whose rest link is under 3cm are skipped at build.
  Peak 65.6→3.3, settle 257→125 steps, shove lands +0.14 the way
  pushed. BOARD: ragdoll 59/0, ammodoll 68/0 — first fully green doll
  board this arc. Gates: settled-pose 19/19, reach/reachrig/reachwire,
  paritybench, lightbench 30/30. THE PRE-UPSTREAM-MERGE DOLL BLOCKER
  IS CLEARED (the fleet is still the local 2-rig overlay — worth one
  run on prod's 14 before the colleagues' merge). LESSON, twice in one
  day: a rig that authors a 7mm bone breaks any instrument or
  constraint that treats segment direction as free — length-floor
  every direction read. R3 extraction is now unblocked.

- **2026-08-28 — §24n: THE CATCH-UP MERGE — 283 upstream commits, the
  refactor holds.** anima/main (the live org line; the SkyeShark
  `upstream` remote is stale — new fetch-only remote `anima`, push
  DISABLED) merged into rimward (febba9e) and main (af200de, clean —
  the §22 restore's 17 markers survive). Upstream's arc: the #104
  relay-floor cutover (voice.js DELETED, in-process SFU via werift,
  credentialed sfu-* wire, incarnation-stamped voice-service), the
  reach/touch lane (declarative pose.reach re-solved per client,
  shared/contact+joints+humanoid+reachwire — they did their own
  joints-table extraction, superseding half of our R3 plan), KTX2
  store shadows + negotiation keys, RFC-005 channels, mcpl-core-ts as
  a sibling file: dependency (cloned + built at ../mcpl-core-ts; mcpl/
  has its own bun install now). WHERE UPSTREAM MET THE REFACTOR:
  micstate = our factories + their delegation removal (the cutover its
  comments predicted); server.ts = our table/join-split + their seven
  SFU cases inlined verbatim (gen-coupled, upstream-hot) + their
  takeover→retireRelayLeg in installJoin + attest rung in messages.ts;
  chat = our dispatcher + their /audio as chat-local + touch/letgo via
  registry rows; agent = our shared-fold structure intact around their
  reach subsystems. UPSTREAM BUGS FOUND (fixed here, FLAG TO THEM):
  (1) their smoke asserts rtc delivery their server deleted; (2) their
  mesh-fallback suite tests the deleted delegation (ours rewritten
  post-cutover); (3) agent.ts imports three/webgpu with no three in
  any root lockfile — the door can't boot clean (root gains three
  ^0.184.0); (4) the hardened token registry rejects example keys and
  dev-token IS an example key — their typing suite can never pass
  (ours uses a scratch registry). MERGE MISHAP SURVIVED: a stash
  during the merge dropped MERGE_HEAD; restored by hand (echo sha >
  .git/MERGE_HEAD) — never stash mid-merge. GATES (all green):
  smoke 85/85 (rtc check now asserts the CLOSED lane), paritybench,
  lightbench 30/30, defs-smoke 28/28, sim-smoke 8/8 (the whole §24
  arc survives), sim/tick/state/foldfix/flora/replaybench, leasetest
  19/19, behaviortest 27/27, incident-88 18/2-known, typing-mcpl,
  micstate suite, THEIR suites: sfu-test 70/70, sfu-adapter 42,
  relay-decision 23, reach-test, mini-sfu. MYTHOS-WINGS landed
  (tel0s, assets/opt — local only, ignored): ammodoll 66/2, ragdoll
  56/3, IDENTICAL at pre-anima-merge = zero merge regressions; the
  remaining doll reds are pre-existing tuning/fleet items
  (ktx2-variant knees, wings knee+shove, 8.6cm handover, missing
  no-upperChest rig) — STILL THE PRE-UPSTREAM-MERGE BLOCKER.
  AMENDED same day: no-upperChest resolved WITHOUT staging —
  claude_suit.vrm (library) is a no-upperChest rig; copied into the
  local overlay (ignored). rig-load gained the roster's own
  .ktx2.vrm exclusion (texture variants were being tumbled as
  bodies), and the 8.6cm HANDOVER RED WAS AN ARTIFACT RIG — it
  passes on the real fleet. The TRUE blocker list is now four
  tuning items, all on real rigs: knee hyperextension (claude_suit
  117°, mythos-wings 126°), the wings 73°-vs-72° fold bound, and
  the wings shove direction (Δx=-0.63). ragdoll 58/1, ammodoll
  66/2.

- **2026-08-27 — §24m: R2 — the tables, delivered.** (1) The ws switch
  is a handler table (90cc9fc): server/messages.ts, 20 entries, bodies
  moved VERBATIM (the verbs.ts precedent — expel rides ctx, module
  never imports server.ts); held-whisper machinery moved with its
  writers; the two source-text suites retargeted; server.ts 1379→851.
  (2) atomicWrite (server/fsutil.ts) replaced eight tmp+rename pairs —
  seats untouched (pending call). (3) Every wire limit has a name
  (a35f193): server/limits.ts, 27 sites, env-overridable, values
  unchanged; LADDER named in config; generic resolveInLadder SKIPPED
  (one consumer = theater). (4) JOIN SPLIT (11b924a): admitJoin (can
  only answer and refuse — never touches the roster) / installJoin
  (the only roster mutator) / buildSnapshot (pure read, finally
  testable without a socket) — ADMISSION BEFORE TAKEOVER is structural
  now, not a comment. (5) tools/harness.ts (4be976d): the scratch
  bench, one copy; both §24 smokes converted (~180 lines gone);
  lightbench/paritybench keep bespoke scaffolds until next touched
  (their Windows/Edge lessons live there). Deferred with §C: handleTool
  table. Gates held throughout: smoke 85/85 through the table,
  behaviortest 27/27, leasetest 19/19, sim-smoke 8/8, defs-smoke
  28/28, authtest 22/1-known, settled-pose 19/19, whisper-disable 5/5,
  voice-wiring 35/35, paritybench, lightbench, replaybench.

- **2026-08-27 — §24l: R1 — one truth, delivered.** Five mirrors dead:
  (1) aid1Slug in server/aid1.ts + aid1JoinIdentity in auth.ts — the
  three doors share one identity derivation (0eb5fe3); (2)
  shared/force.js owns the radial-cause falloff — bodies keep only
  consent + ground-zero direction; (3) the command registry is the
  WHOLE alias truth (29aee4f): chat.js's 26-case switch → five
  chat-owned handlers + resolveCommand; use/mount/dismount/debug join
  as listed:false rows; /use's alias-is-the-action is declared data;
  (4) the emote vocabulary is a def (bdb1580,
  defs/animations/_emotes.json): key order = bar/number-key order,
  clip/icon/listed; avatar.js hydrates in place, the bar rebuilds on
  the push, Digit[1-9] follows the order — four drifted copies gone;
  (5) ONE onset machine (93eac2e): makeOnsetGate/makeLevelMeter in
  micgate.js, both transports instantiate, twins deleted (voice
  1388→1207, micstate 429→255, net −316). Full voice suite green incl.
  micstate-exec (executes, not reads). Deferred with the §C calls:
  stdio-door tool table (rides the retire-or-unify decision). Lesson
  paid twice now: backticks inside double-quoted commit -m get
  command-substituted by zsh — single-quote or drop them.

- **2026-08-27 — §24k: two retirements + R0, the bleeding stopped.**
  RAPIERDOLL RETIRED (41422ba, −1,589 lines): panel-only reachability,
  no feature parity, permanent divergence tax; tone motors recoverable
  from history. UPSTREAM-PATCHED RETIRED (69a598a): the grass engine
  came home — client/lib/vegetation/ (vegetation.js + three generators
  vendored @62365e9, provenance-stamped, cherry-pick-by-hand forever);
  the ASSET overlay survives as top-level patched/ (same top /library
  precedence, delete-to-fall-back; carries the fixed sit clip); the
  vendor-base merge-file recipe is obsolete. R0 (survey §A, all
  eight + hygiene): gate fixes ported into the mesh copy that runs
  (speaking latch, analyser leak); ttsrow's mic check gains its
  fallback; main.js mic-open goes through micstate; nails are firm on
  the owner's machine (localbody passes firm; verlet accepts it for
  parity); physobj per-axis scale; net-server loses the shipped \$HOME;
  THE AGENT FOLDS WITH shared/fold.js (applyEntry's diverged mirror
  deleted — entity/mount maps are derived views + a side-effect pass;
  #88 strictness UPSTREAMED into the reference fold: place/dismount
  take finite-vec3 or nothing); THE AGENT SEES THE SIM (adopts the
  join cut, folds punts, stamps flight/rest into perception; supports
  drop at launch, rebuild at rest); build.js escapes server names.
  Pre-existing environmental failures noted, verified at HEAD:
  ragdoll-test 2 (VRM fleet composition), incident-88 2 (support
  scene), knockdown/compfold (need external servers), emitter-percept
  passes-then-hangs. Seats + stdio-door calls still await colleagues.

- **2026-08-26 — §24h: THE SIM IS REAL — eidosim@0.1.0, proven
  cross-engine.** PROTOCOL_v2 implementation, four slices, one day:
  (1) shared/sim.js (75328cf) — exact-ops ballistics (no
  transcendentals/clock/randomness), ceil quantization, dialect-3 punt
  (dir required), resting-contact + slide-friction (the terminal
  micro-bounce taught the contact branch), authored-word-wins release,
  foreign-epoch refusal, schedule-independent advancement; sim-test
  13/13. (2) sequencer (580e7a0) — epoch verb rank 2 (validated
  against the carried sim, after-hook folds the barrier), fold.js
  epoch case + stateToEntries preserving the tick-0 anchor ts,
  WorldLog folds sim beside instant (normative order), snapshots +
  join payload carry the cut, 'sim' tick system, debug {sim:true},
  punt-requires-dir + sim-aware reach. (3+4) client + proof (cc5201e)
  — shadow sim in state.js, simworld.js applier on the engine frame
  hook, physobj punt-volunteering stands down under epoch (drags/
  hand-offs untouched), kick UI stamps full launch vector. THE PROOF
  (sim-smoke 8/8): one punt computed by JSC (sequencer), JSC
  (independent refold from fetched entries), and V8 (browser shadow) —
  rest p=[8.143363781124814, 0, 3.1430091343374413] BIT FOR BIT in all
  three. Covenant I holds across engines. replaybench grew sim legs
  (self-agreement + sim-snapshot parity, adversarially verified).
  v0.1 scope honest: punt only, own-ground-plane collision (terrain =
  sim@0.2 epoch bump), force + §6 ⚑s open. Worlds OPT IN via /epoch —
  nothing changes for any world until its owner speaks it.

- **2026-08-25 — §24g: three more domains — clips, skies, building style.**
  ANIMATIONS (9b4a44b): defs/animations/ overlays the clip roster,
  same declared-beats-discovered contract as avatars; vrma resolves on
  the clip ladder (PATCH>OPT>LIBRARY — resolveLibFile deliberately
  doesn't know .vrma); tags/doc ride /defs, /animations stays the
  prefetcher's byte-budget shape. SKY (9b4a44b): build.js's five named
  skies → defs/sky/_presets.json — authoring conveniences ONLY (commit
  writes concrete args; foldSkyEntry computes at fold time, so a
  def-referenced preset would let a mutable file rewrite logged
  meaning — presets live strictly on the authoring side). New
  client/lib/defs.js = shared client registry view (one fetch,
  invalidated by defs-updated; the preset row repopulates live).
  STRUCTURE (3338803): investigated — the grid engine is pure
  algorithm, NOT def material; the def-able surface was the realizer's
  PALETTE, the "style catalog seam" its own comment anticipated.
  defs/structure/_palette.json restyles the five slots by MUTATING the
  live shared materials (colorNode rebuilt through the named finish) —
  standing buildings restyle on the push. Overlay doctrine (style is
  never a gate; missing def = built-in style), vs single-source for
  species. Gates: defs-smoke 27/27, structure-field 159/159,
  flora.test 70/70, smoke 85/85, paritybench PASS, lightbench 30/30,
  replaybench green. Def domains now: flora (species+colors+presets),
  avatars, animations, sky presets, structure palette.

- **2026-08-25 — §24f: the determinism ruling + biome presets as data.**
  RULING RATIFIED by tel0s: the log stores INTENTS, outcomes recomputed
  by a deterministic sim — drafted as spec/PROTOCOL_v2.md (f8e81fa,
  dialect 3, CC0 like v1). The four covenants: owned numerics (no host
  transcendentals; wasm kernel makes bit-exactness a build artifact),
  sim epochs + snapshot barriers ("every log is always replayable"
  beats "one sim replays everything forever"), the planes stand
  (presence never a sim input; influence crosses as stamped intents;
  leases stay presence choreography), tick-indexed time (ceil
  quantization from the epoch entry). Instant fold untouched in every
  dialect; v1/v2 logs valid forever; intent vocabulary + sim-ownership
  ⚑-open for ratification. PRESETS (0d0c8fb): the mojave recipe left
  flora_args.js for defs/flora/_presets.json — declarative template
  vocabulary (inset/offset-fractions/seedAdd/density×k), interpreted
  by presetStrokes(args, presets); unknown preset now fails LOUDLY
  (was silent fallthrough — logged meaning must not drift). The
  corn/sunflower variety recipes stay in code (generator-coupled).
  Proven: 7-stroke mojave composed from the def in a live client
  (defs-smoke 22/22, flora.test 70/70 feeding the shipped file).

- **2026-08-22 — §24e: phase-1 slice 6 — the palette def + LIVE defs.**
  (0cecb57) GRASS_COLORS left vegetation.js for defs/flora/_colors.json
  (underscore = domain sidecar convention), hydrated before species so
  leafRecolor names resolve. And the Rimworld-y payoff: DEFS ARE LIVE —
  a defs-watch tick system fingerprints defs/ (1s, mtime+size) and
  pushes `defs-updated` (wire addition); clients re-fetch /defs,
  re-hydrate REPLACING, and regrow the meadow from the same authored
  args. Proven under a live headless client: grass.json density edited
  22→5 on disk → planted 24352→5556, no reboot, no log entry. RULING
  recorded in defs/README.md: seats are NOT defs — they're a judged
  store (proposals, countersigns, provenance, locks; #101/#105); the
  line is "if writing it requires authority/judgment/provenance it's a
  store; if editing it is authorship it's a def". Gates: defs-smoke
  20/20, flora.test 67/67, smoke 85/85, paritybench PASS, lightbench
  30/30, replaybench green.

- **2026-08-22 — §24d: phase-1 slices 4+5 — the entry bus, avatar defs.**
  BUS (6ad41f8): birth IS publication. Seven append sites hand-rolled
  append + broadcast({type:'log'}) and only runVerb told the behavior
  host; now World.commit() appends + publishes on server/events.ts and
  boot-registered subscribers (client-fanout, behaviors) hear every
  committed entry uniformly, error-isolated per listener. Rulings in
  events.ts: genesis stays silent; fanout precedes behaviors (effect
  entries publish after their cause, seq order dense on the wire); the
  one reordering (bhv.onEntry before after-hooks) ruled acceptable —
  only `use` overlaps, and a script hearing it a beat before the
  reaction's effect sees a legal moment of the world. Bus gauges ride
  GET /tick. Future systems (seats, recorders, the sim core) subscribe
  in server.ts instead of teaching another append site to fan out.
  Per tel0s's ruling on the braid: with defs + (eventually) our own
  renderer, the upstream-patched override mechanism is on the road to
  retirement — overrides become defs, not forked engine files.
  AVATAR DEFS (a0dd10a): defs/avatars/<name>.json OVERLAYS the
  discovered roster — drop-a-vrm stays live defless; a matching def
  overrides height (beats the thumbs sidecar); `vrm` declares or
  repoints a name at any /library path; unresolvable paths refused
  loudly, roster stands. Gates: defs-smoke 17/17, behaviortest 27/27,
  smoke 85/85, leasetest 19/19, paritybench PASS, replaybench green.

- **2026-08-22 — §24c: THE CLOBBER — §22 grass was reverted on main
  since Aug 18.** defs-smoke's engagement check (mode cards-sss where
  opaque belonged) exposed it: upstream's 95303a7 (Mica, "bring prod's
  hand-patched vegetation.js into the repo — NOT MY WORK") rode the
  7fed06e anima-research merge and CLOBBERED our override — and that
  "hand-patched" file is byte-identical to stock engine 62365e9, so
  the hand patch contained nothing and the merge silently reverted the
  whole §22 arc + §23 sunflower rebase. Every stack on main since
  Aug 18 served the pre-§22 cards-SSS meadow (~26fps class). RESTORED
  on main (2abcd3a, from 65ea7aa's file — 17 markers, species data
  verified identical) and pushed. LESSON for the braid: any merge
  touching upstream-patched/ must re-run the marker count
  (grep -c 'lodGrow|fastShade|opaqueBlades|baseKeep|sampleBladePalette'
  = 17) — or just run defs-smoke, which now checks engagement.

- **2026-08-22 — §24b: phase-1 slices 2+3 — defs and the heartbeat.**
  DEFS (1c9104c): flora species left vegetation.js for
  defs/flora/<name>.json — shared/floradefs.js validates (type-level,
  unknown keys preserved, doc field for lore), server/defs.ts serves
  GET /defs (1s TTL, broken defs refused loudly + individually),
  FLORA_SPECIES hydrates once before first build (createFlora +
  loadFloraModule both await; object identity preserved for
  globalThis). Adding a species = adding a JSON file — proven by
  tools/defs-smoke.ts: a def-only burgundy species rendered opaque
  (drawn 6133) existing in no .js file; unknown species fails loudly,
  world stands. GRASS_COLORS stays engine-side for now (calibrated to
  Sol's atlas); candidate for defs later. NOTE: future upstream
  species-table edits now conflict with a deletion — port them to
  defs JSON (the §23 merge-file recipe still covers the rest of the
  file). TICK (dc6dffc): the sequencer's four naked setIntervals
  became named systems on server/tick.ts — one scheduler (§3's client
  principle, server-side), per-beat error isolation, gauges at
  GET /tick. Verbatim bodies, cadences unchanged; the seam for the
  future fixed-step sim core. Wire additions /defs + /tick recorded
  in WIRE.md. Gates across both: defs-smoke 12/12, flora.test 67/67,
  tick-test 7/7, smoke 85/85, leasetest 19/19, paritybench PASS,
  lightbench 30/30, bootjank clean at 153k planted, replaybench green.

- **2026-08-22 — §24a: phase-1 slice 1 — the gate before the surgery.**
  Engine choice reopened by colleague deliberation (Godot's own-engine
  detour ended "not just right now"; the godotwebgpu fork measured
  stuttery by a colleague, matching its 3-months-dormant beta state) —
  so work moved to the lane no colleague decision blocks: sim
  extraction. Landed: `tools/replaybench.ts` (36bd3c8) — the log-replay
  parity gate. Four pure-read checks per world: fold determinism
  (two independent parses+folds), snapshot-path ≡ genesis-path (the two
  WorldLog boot paths), stateToEntries roundtrip (documented
  exclusions: sky, chat window, bans, roles.sub), and a per-machine
  baseline digest in worlds/.replaybench.json. Adversarially verified
  (doctored snapshot, malformed line, baseline mismatch each RED as
  intended); commons green, baseline recorded. And `docs/WIRE.md`
  (8e7afe6) — the live-wire protocol inventory freeze v0: WS session
  model (legs/gen/takeover/close codes/rate caps), both planes, every
  message both directions, the rank-gated verb table, HTTP surface,
  five as-built quirks flagged for a phase-1 ruling. Wire changes now
  must be flagged as wire changes in review. Also: three.js-vs-wasm
  renderer estimate delivered to colleagues (GPU: identical; browser
  vs native ~10-25% paid by both; JS-vs-wasm ≈ 1-3ms/frame CPU encode
  at our draw counts — we are fill-bound, so ≈ nothing today).

- **2026-08-21 — §24: the rimward pivot (opened).** Team consensus: the
  engine has outgrown a three.js webpage — port to another engine and
  rework the systems to be "more Rimworld-y" (modular, data-driven,
  extensible). Grass optimization paused. Branch `overhaul/rimward`
  opened; `docs/overhaul-charter.md` drafted (11fa681) — nothing locked.
  Thesis on the table: split an engine-agnostic sim core (fixed tick,
  defs, the append-only log promoted to event spine) from a swappable
  presentation layer, so the port becomes a *client* port and the
  log-replay invariant lives where no engine can break it. Draft engine
  lean: Godot 4, Bevy runner-up; the deciding ⚑ is whether browser
  delivery is still a requirement. Other ⚑s: braid policy with Skye
  (a people question first), sim-core language (draft: stays TS/Deno
  through phase 2), strangler migration with the old client alive to
  parity. RATIFIED same day (be7d784): worlds is our own thing,
  eidoverse-video an upstream *asset library*; web delivery required
  (native ok for on-branch dev); engine = Godot 4.6, Bevy fallback
  only if the web gate fails; sim stays TS (tel0s holds ideas for a
  later sim redo behind the same protocol). Godot web reality,
  verified: Compatibility/WebGL2 only (no WebGPU — a renderer
  downgrade from our three.js client, hence the gate), no C# on web
  (GDScript it is), COOP/COEP for threads (we own the server),
  ~5MB brotli engine wasm. Phase 0: one Godot spike against the
  existing Deno server, exit gate runs in the web export.

- **2026-08-15 — §23: the lines braid — upstream merge + sunflower.**
  Skye merged tel0s/main d9925d9 into the upstream line (462efec, with
  her own merge fixups) — the §22 grass arc now ships upstream via the
  upstream-patched override she kept intact. We merged her
  feat/sunflower-species back (49a67b3, `upstream` = fetch-only remote,
  push DISABLED): Tripo avatar pipeline (#110-#120), ammo default body
  engine (#107) + vendored wasm, the TTS/piper voice lane (#91), seats,
  agent/mic hardening, /version build identity (#51), and the sunflower
  species. THE SNAG the branch didn't solve: our vegetation.js override
  wins /library, and it predated the sunflower — FLORA_SPECIES.sunflower
  was dead on any stack running it. Fixed by three-way merge-file
  (base = video 8b37f0f at vendor time, theirs = video origin/main):
  four clean hunks (import, species entry, heading yaw-lock, archetype
  branch), zero overlap with our patches. Gate green (parity PASS,
  lightbench 30/30, bootjank clean, flora 67/67 incl. 6 new sunflower
  tests); headless smoke planted a 485-instance sunflower field at
  61fps, heading lock visible, no page errors. LESSON: every upstream
  vegetation.js change now costs an override rebase — the standing
  refresh recipe is merge-file against the vendor-base sha (recorded
  here: 8b37f0f → 62365e9).

- **2026-08-12 — §22r: MSAA back on by default.** tel0s's call: a
  silently-missing AA reads as a rendering bug to colleagues who
  weren't holding the §22n measurement. The dPR-gated auto-off is
  reverted; MSAA is the default everywhere, ?msaa=0 stays as the
  opt-out (+10fps at 2× retina, one flag away), and §22q already
  bought frames back for the default look. A proper settings row
  (alongside the other quality dials) is the eventual home.

- **2026-08-11 — §22q: shaped resident density.** The Tsushima trade,
  applied at every distance instead of only past 15m: DENSE_BASE thins
  instances through the §22h rank dither (keep ×= base), survivors
  widen by 1/√base — WIDTH ONLY, the height envelope a taller meadow
  would betray stays untouched — and a guard ring (2..8m smoothstep)
  holds full density at the camera's feet, the one place a missing
  tuft is individually legible. Density cut and width comp ride ONE
  ramp, so density × coverage is continuous everywhere. The CPU tile
  budget mirrors the law at each tile's nearest point (denseAt ≥ every
  instance's keep multiplier — the budget stays a ceiling, never a
  seam), which is where the submitted-instance win comes from.
  MEASURED (real-meadow scale 153k planted, 2940×1912 buffer @2×,
  cruise off, drift-controlled): 1.0 → 52fps, 0.8 → 60 dipping (lo
  52), 0.65 → locked 60-61 at 121k→84k submitted (−30%), 0.5 → 60
  (68k) with visibly chunkier near-mid blades. Screenshot means moved
  ≤ 0.5 RGB across the whole sweep — the width comp holds coverage.
  Default 0.65 (least thinning that holds the cap); ?grassdense=N
  overrides, =1 is the kill switch (byte-identical shader, untouched
  budgets). grassDiag regime header now prints `dense N`. tel0s's eye
  remains the gate on the default.

- **2026-08-11 — §22 merge: grass-opaque-blades → main.** tel0s's eye
  signed off; fast-forward (06aa000..b34d8b1), tree identical to the
  gate-green branch tip, branch deleted. The A/B lever survives as
  `?grassgeo=cards`. Their real session across the arc: 26 (ghost
  shader) → 37 (opaque) → ~50 (MSAA policy). Remaining headroom on the
  books: near/mid-field density shaping, and the sky re-bake spike
  (clouds arc).

- **2026-08-11 — §22p (branch): the 34ms mystery dies twice.** Verdict
  in two parts, both measured. (1) tel0s's recurring worst=34 is VSYNC
  QUANTIZATION: on a 60Hz panel a frame either makes the slot (16.7ms)
  or waits for the next (33.3ms), so EVERY sub-60 second must contain
  doubled frames — worst=34 in a 41fps phase is arithmetic, not a
  hitch, and their distribution is actually TIGHT (worst never exceeded
  2×vsync). The density-35% row proves it exactly: 58fps = 56 single +
  2 doubled frames. (2) Underneath, a REAL ~1-per-10s GPU spike
  (42-45ms, zero longtasks, zero heap movement — main thread clean)
  matches the sky baked-tier re-bake cadence (9-12s); it hides inside
  vsync headroom when the frame is light and surfaces sub-60. Already
  on the clouds arc's books. THE FIX: perf gains doubled/spikes
  per-second counters (frame.js window classification: >25ms = waited
  one vsync, >40ms = beyond any pacing explanation); grassDiag prints
  2×/s and spk/s per phase with the legend "doubled is EXPECTED
  sub-60". Smoked: doubled/s tracks the fps deficit arithmetically,
  both columns zero at 61fps. The worst-alone metric can never send
  us ghost-hunting again. Gate: parity PASS, lightbench 30/30,
  bootjank clean.

- **2026-08-11 — §22o (branch): the MSAA policy lands + the tile trim.**
  tel0s confirmed MSAA's 5-10 frame cost by eye, and their full diag
  attributed the whole remaining gap to grass (hidden 61 vs baseline
  41; sky/terrain/physics ≈ free; density 35% → 58 — instance count
  still rules under opaque; far sea +9 vs near +5). Landed: (a) hiDPI
  boots (dPR ≥ 1.5) default to NO MSAA — the 4× resolve at retina is
  ~4ms/frame for stairsteps ~220dpi already hides; ?msaa=1 restores
  (the shimmer escape hatch). (b) TILE_MAX_AXIS 8→12 (?grasstiles=N
  diag override): finer tiles pin the §22h nearest-edge budget to the
  dither curve — 7.3k fewer submitted instances, +2fps, visible
  density identical; 16 adds nothing. Probe-view stack since morning:
  31 → ~55 (opaque + no-MSAA + tiles12) before the cruise. OPEN
  MYSTERY logged: a recurring worst=34ms frame rides grass visibility
  in EVERY diag phase (even at 58fps, autos off) and disappears only
  when the field hides — periodic, grass-linked, not wind/autos/sky;
  suspect list starts at the 300ms tile tick. Gate: flora.test 61/61,
  parity PASS, lightbench 30/30, bootjank clean.

- **2026-08-11 — §22n (branch): vertex LOD built, measured, acquitted —
  and MSAA convicted.** The coarse far twin (flora_lod bladeCoarseIndex:
  every blade at loops 0→2→4, 12 index entries referencing 6 of 10
  verts — an index subset never renumbers, so the §22h dither's bladeId
  survives untouched; same structural layout proof, 61/61 unit tests)
  rides the §17b swap machinery with bands 45/38. Measured at 2×
  fullscreen, drift-controlled, engagement VERIFIED (22/60 tiles wearing
  the 96-entry twin): 44/44 vs 44-45 — INERT. The M5's vertex throughput
  acquits vertex count for the third time (§22c +3, §22f retirement,
  now this). Default OFF on the evidence; ?grassvlod=on is the opt-in
  for vertex-bound tiers. The same slice armed the audit's next lever:
  ?msaa=0 (core.js antialias param, default unchanged) — and THAT is
  the missing bill: 44 → 54fps (+10, drift-stable). The 4×MSAA resolve
  at 2× retina costs ~4ms/frame. Policy candidate: antialias off when
  dPR ≥ 1.5 — but opaque blades have GEOMETRIC edges where cards had
  alpha ones, so shimmer-in-motion is tel0s's eyeball call before any
  default flips. Cache postscript: tel0s's "opaque ≈ cards, 26fps" was
  the /library 24h browser cache serving the pre-§22l SSS shader
  through a server restart — fixed in d87cd13 (.js/.mjs/.json now
  no-cache + ETag 304s; the .vrm carve-out extended to code). Gate:
  flora.test 61/61, parity PASS, lightbench 30/30, bootjank clean.

- **2026-08-11 — §22m (branch grass-opaque-blades): Sol's meadow, in
  geometry.** tel0s green-lit the Tsushima-lineage rewrite with "keep
  it close to Sol's art" as the constraint — and the codebase met us
  halfway: bunchGeometry was already one card per blade with loop
  widths fitted to the atlas art's measured envelope (_fit.json), so
  the opaque blade IS the fitted strip (the envelope already tapers to
  the art's tip), and the material IS the existing no-maps path
  (alphaTest 0, attribute('color'), cheap backlit) once maps aren't
  loaded. New: sampleBladePalette bakes each atlas column into a
  root→tip vertex-color ladder (alpha-weighted, sRGB→linear, per-blade
  hue jitter); ladder gains calibrated against the card render by
  screenshot means (R 1.00 G 0.97 B 1.10 final). No alpha test → the
  TBDR's hidden-surface removal eats the meadow's overdraw.
  ?grassgeo=cards restores the atlas cards (A/B in one boot).
  Bugs found on the way, both instructive: (1) the flora tiler copies
  a NAMED list of shared attributes — 'color' wasn't on it and missing
  attribute bindings render BLACK (fixed in tile + far-twin lists);
  (2) since the §22l sweep, primeFiles negotiates KTX2 bytes under PNG
  names, so the palette sampler got undecodable bytes and silently
  fell back — THREE screenshot rounds compared cards to cards (the
  probe now refetches raw art when primed bytes aren't PNG). Also: a
  0.55 partial-normal experiment turned the meadow charcoal —
  side-facing normals see neither sun nor sky; Sol's up-normal trick
  is the meadow's brightness (specular veil muted at the material:
  roughness ×1.35, specularIntensity 0.35). Measured, drift-controlled
  2× spawn view: cards 40-41 → opaque 49±1 (the saga's biggest single
  lever). 1× vsync-caps. Gate: parity PASS, lightbench 30/30, bootjank
  clean. AWAITING tel0s's eye before merge.

- **2026-08-11 — §22l: the fragment diet + the sweep that never ran.**
  A full levers audit (Fable fork, GPU Gems ch.7 lineage vs the actual
  material) found the bill is fragment-side: every meadow pixel paid 4
  texture fetches (albedo/normal/rough/transl) + per-light SSS on
  MeshSSSNodeMaterial + alphaTest discard (defeats TBDR HSR) — and the
  KTX2 image sweep had NEVER run on the Air: tel0s's pkgutil-expanded
  KTX sat in ~/Downloads, never on PATH, so §20d exit-3-skipped every
  boot and the atlases served raw RGBA. Fixes: (1) encoder assembled at
  ~/.local/ktx (bin+lib siblings), findKtx2Encoder now probes that
  docs-recipe path as a fallback — a PATH-less install can't silently
  starve the sweep again; boot sweep encoded 93 variants (meadow albedo
  4.9×, transl 5.7×). (2) upstream-patched opts.fastShade (blades
  default via flora.js, ?grassshade=full = upstream's exact material):
  MeshStandardNodeMaterial, ONE shared albedo sample (color+opacity),
  no relief/rough fetches, the already-authored cheap backlit term
  instead of per-light SSS, albedo aniso 4→1. Byte-identical without
  the opt. Measured (drift-controlled, 2×, spawn view): 31 (morning
  §22h baseline) → 36-39 (ktx2 alone) → 41-42 (+fastShade); at 1× the
  meadow now vsync-caps at 61. Screenshot pair eyeballed: same blade
  character, no visible relief loss. Audit verdict recorded: full
  opaque-blade rewrite (Tsushima lineage, no discard → TBDR HSR eats
  the overdraw) is the L-sized root fix IF this lands short — needs
  tel0s's art-direction call. Gate: parity PASS, lightbench 30/30,
  bootjank clean.

- **2026-08-11 — §22k: the resident takes the pixel wheel.** The freeze
  tel0s reported after §22j turned out to be Zen/Firefox, not Chrome —
  hunt closed (headless+headed Chrome soaks had already cleared the
  cruise path; the headed "repro" was Chrome's occluded-window
  throttle, proven by a mid-freeze `sample`: main thread 97% idle at
  mach_msg). Per tel0s: render scale becomes a resident dial. build.js
  grows a scale⚙ row beside grass⚙ (auto | 100% | 85% | 70%,
  persisted as ew-render-scale — an explicit choice is a preference;
  machine pressure stays session-only). governor: residentBase() =
  BASE × factor; 'auto' = cruise drives (default, unchanged); a pinned
  factor anchors pixelRatio outright and stands the cruise down — the
  emergency <26fps pixels lever still sheds below a pin and restores
  to it (a crisis outranks a preference, only while it lasts).
  Housekeeping: build.js's SIX raw NUL bytes (the seat-gizmo `id\x00
  slot` map keys — the very footgun that hid setCloudQuality at
  :1089) are now \x00 escapes, byte-identical semantics; the file
  greps clean for the first time. Gate: paritybench PASS, lightbench
  30/30, bootjank clean, rs-smoke (pin 0.7 → pr 1.4 at boot, zero
  cruise moves; live flip to auto re-anchors pr 2) PASS.

- **2026-08-11 — §22j: the dead band learns the pixel law.** Session
  moved onto the Air itself; the ?grasslod three-way A/B ran drift-
  controlled (off / nodither / full / off-again, one browser, warm-up
  boot excluded). Verdict: at 1× render scale ALL configs run 60fps;
  at 2× ALL run ~30 (off 30/30, nodither 29/29, full 31/31, off#2
  30/29). The §22e-h shader work is FREE (keep it — it buys the
  seamless look), round 7's 26fps baseline was machine state, and the
  machine is simply pixel-bound: resolution is the only lever that
  moves it, and its whole steady state lives inside the 26-52 dead
  band where the ladder never engages. So §17d reopens WITH evidence
  (it was closed "for now" before these tables): governor.js gains a
  cruise lever — after 8 consecutive dead-band seconds, pixels alone
  steps −0.25 toward a floor of max(0.7, BASE×0.7) (1.4 on a 2×
  panel); restore is the shared silent +0.125 above 52fps; ?cruise=off
  disables (the A/B lever). Cruise-probe on the Air: 2→1.75→1.5→1.4
  in 30s, steady 38-41fps (was 30-31), zero oscillation over 100s.
  Everything else about §17d stands — no other lever enters the band.
  Gate: paritybench PASS, lightbench 30/30, bootjank clean.
  Housekeeping: TEL0S_NOTES.md itself contained a raw NUL byte (§21's
  whisperKey line) that made every grep against this file silently
  return nothing — the build.js:1089 footgun's sibling, now spelled
  out as text.

- **2026-08-11 — §22h: the dither pays its debts.** Round 6 on the Air
  REGRESSED to 40fps — the flagged risk real: dither-killed instances
  paid the full vertex program (submitted 131.5k vs 98.5k, and
  far-LOD was worth +12 again = live vertex ALU binding). Corrections
  in the patch file: (1) the alive test hoists and the dynamics
  (wind×3 + gust fetch + pusher loop) run inside If(alive) — dead
  vertices near-free (emission byte-identical without lodGrow.exp);
  (2) blade-level dither via vertexIndex (10-vert runs, per-instance
  hash, fading to the retired swap's proven 0.4) — the +12 recovered
  continuously; (3) TILE_MAX_EDGE 45→28 — discovered INERT for the
  lush meadow (the 8×8 TILE_MAX_AXIS already binds at ~11m tiles;
  helps mid-size fields only; the ~30% budget waste stands but its
  PRICE is what (1) cut). Gate: lightbench 30/30 + measure 120fps
  (the TSL compiles), bootjank clean, grass-quality 57/57,
  paritybench PASS. Round 7 decides.
- **2026-08-11 — §22g (tel0s's idea): upstream-patched/ — the forks
  come home.** Deliberate upstream redos now live IN this repo:
  upstream-patched/<rel> shadows the same rel in eidoverse-video via
  a top-precedence /library branch (PATCH_DIR in config; delete the
  file to fall back to Skye's). vegetation.js (the §22e/f lodGrow +
  dither patch) is the first resident; ../eidoverse-video is reset to
  PRISTINE (8b37f0f — the two local commits' content is canonical
  here now; never patch her checkout in place again, and the old
  format-patch carrying instructions are OBSOLETE: one git pull of
  THIS repo delivers everything to every machine). Proven end-to-end:
  the route serves the patched copy (2 lodGrow hits) while disk
  upstream has 0; lightbench 30/30 + measure 120fps building the
  meadow from the overlay; bootjank 14 rough frames (best lush-commons
  yet); paritybench PASS. The README carries the doctrine: minimal
  opt-gated deltas, byte-identical without the opt, PR to Skye then
  delete.
- **2026-08-11 — §22f: density becomes a continuous law — the visible
  squares cannot exist.** tel0s (round 5, ~55+ usual / 47-48 worst):
  the per-TILE quantization was VISIBLE — whole 30-45m squares of
  count/blade change while walking; they proposed subdividing tiles.
  The landed answer keeps tiles big (8a's 17-draw economy) and makes
  them invisible instead: (1) the falloff's SHAPE moves into the
  shader per instance — keep(d) at the exact CPU curve, an instance
  survives iff its DRAW-ORDER RANK < keep, where the rank is written
  into the flutter-phase lane post-shuffle per tile (rank-as-phase is
  still uniform per location; zero new attributes) — this is the
  CPU count-prefix refined continuously, single-thinned, seamless at
  every boundary; (2) the CPU count becomes a BUDGET at the tile's
  NEAREST edge (keep(dNearest) ≥ every instance's keep — the shader
  never wants what wasn't submitted; also fixes the center-based
  over-cull at GRASS_FAR); (3) the per-tile blade swap is RETIRED
  (BLADE_LOD bands = Infinity — round 3 proved blade count ~free and
  the swap was the second visible pop; forceBladeLod stays a live
  diag lever and the constants are the weak-GPU re-entry point);
  (4) grassdiag's scope split gets its own DIAG_SCOPE_EDGE=20. RISK
  flagged: dither-killed instances still pay vertex fetch (submitted
  budget > visible, e.g. lush commons submits 131.5k for a
  curve-shaped visible set) — round-3 evidence says the far bill was
  raster-side so this should hold; the Air's round-6 table decides.
  vegetation.js carries a SECOND local commit in ../eidoverse-video
  (rank-dither in the lodGrow block; opts-gated, byte-identical
  without exp) — format-patch both for the Air. Gate: flora 55/55,
  grass-quality 57/57, bootjank clean, lightbench 30/30 + measure
  120fps, paritybench PASS.
- **2026-08-11 — §22e: density-compensation grow — appearance restored
  in the cheap currency, savings kept in the expensive one.** tel0s's
  round-4 diag: EVERY lever now recovers to the 61fps ceiling (the
  residual ~2.4ms is thin enough that anything clears it) — and the
  22d curve "reads a little too sparse". The classic fix, both asks at
  once: the count falloff bites harder (exponent 2→2.5; round 4
  measured BOTH rings safe at 0.35) while the upstream grass shader
  grows the SURVIVORS with camera distance (opts.lodGrow: smoothstep
  GRASS_NEAR→FAR, cap 1.7 — area ∝ scale², compensating ~3×
  thinning). Safe by tel0s's own data: blade-thinning (an area cut)
  bought +3fps in round 3, so area is NOT what the Air pays for —
  instances are; restoring coverage via scale gives back almost none
  of the win. The vegetation.js patch is opts-gated (no lodGrow →
  grow ≡ 1, byte-identical for every other host) and committed in the
  eidoverse-video repo LOCALLY — tel0s pushes that repo when ready;
  it's PR material for Skye with the rest. flora passes lodGrow only
  for blades-archetype strokes (the tiled ones the falloff cuts;
  shrubs/yucca have no falloff and get no grow), constants shared so
  the trade stays coupled. Gate: flora 55/55, grass-quality 57/57,
  bootjank clean (lush commons drawn 106.5k→98.5k), lightbench 30/30
  + measure 120fps no page errors, paritybench PASS. Awaiting the
  Air's fifth table + eyes.
- **2026-08-11 — §22d: the far sea convicted — the falloff curve was
  inert on human-scale fields.** Three Air diag rounds converged:
  round 1 (half-window confound — the inspector pane halved the
  canvas) pointed at blade volume; round 2 at full window acquitted
  blades and convicted something density-shaped; round 3's spatial
  split was unambiguous — far-sea-only @35% recovered 46→61fps/worst
  17 IDENTICAL to grass-hidden, near-ring-only 53, blade-thinning +3,
  render-scale-80% 59. Distant tufts are subpixel cards: near-pure
  per-instance overhead + 2×2 quad-overshading — at distance the
  meadow wants FEWER, not thinner. The old linear 30→140m falloff
  granted ~0.8 to every tile of a 90×80 field (inert by design range);
  now quadratic 15→90m (d=40 → 0.44, d=60 → 0.16). Lush commons drawn
  150k→106.5k on the bench camera. grassdiag grew the discriminating
  phases (near/far density scope, render scale) that found it. Gate:
  flora 55/55, grass-quality 57/57, bootjank clean, lightbench 30/30 +
  measure 120fps, paritybench PASS. Awaiting the Air's fps + eyes;
  the tuning surface is GRASS_NEAR/FAR + the exponent. The
  render-scale-59 datapoint keeps the 17d dead-band question warm.
- **2026-08-11 — §22c: the meadow's verdict — blade VOLUME, and the
  bands were too generous.** tel0s's Air grassDiag on full×lush:
  pushers off +1fps, wind off +1fps (the physics theory ACQUITTED),
  far-LOD everywhere 44→61fps / worst 50→17ms — the complete
  no-grass ceiling. The cost is blades-per-tuft × instances, nothing
  else. Fix: BLADE_LOD_OUT/IN 60/50 → 20/15 — full 8-blade tufts only
  in the tile underfoot; everything else draws the 40% index the
  measurement proved visually free at meadow density (swaps stay
  pointer-writes, 17b). Local proof against the SAME lush commons:
  bootjank 48→17 frames >25ms, p95 16.7→8.4ms. Gate: flora 55/55,
  lightbench 30/30 + measure 120fps, paritybench PASS. Awaiting
  tel0s's Air retest; the constants are the whole knob if the middle
  distance wants more lushness, and a third mid-tier index is a small
  slice on the same machinery if bands alone can't satisfy both eyes
  and fps.
- **2026-08-11 — §22b: the sticky-35fps ratchet was the SKY, and it's
  fixed.** tel0s's repro named the sky pane's quality knob — and the
  §18 extraction's "setCloudQuality has no caller anywhere" was
  defeated by the recorded build.js NUL-byte footgun (ripgrep skipped
  the one file with the caller, build.js:1089). The chain: every
  quality flip forces a full sky rebuild, and teardownSky could never
  reach the engine's dispose() (not on the api) — so each flip leaked
  the ~64MB _envTarget, the bake target, and the noise/weather
  textures. PROVEN by probe (scratchpad skyq-probe): pre-fix textures
  69→73→74→77 and renderTargets 7→9→9→11 across two flips, monotonic;
  post-fix perfectly periodic (69↔68, 7↔6) AND 96MB less resident at
  the baked tier (the first rebuild now frees boot leftovers too). The
  fix: teardownSky calls skyInner.dispose() via the §18b _internals
  ref (cloudShadowRoots is empty in this client — the factory marks
  everything noCloudShadow — so its unwrap loop is a no-op, no
  recompiles). EW.setCloudQuality exposed for diagnosis. The DROP to
  35 at 'high' is honest cost, not a bug: high is the LIVE volumetric
  march every frame (baked tiers re-bake per 9s) — beyond a fanless
  Air's budget by design; tel0s's "clouds are extremely unoptimized"
  is this tier + weather states, a future arc (upstream graph-caching
  asks are the real fix). Gate: lightbench 30/30, paritybench PASS.
  BENCH NOTE: bootjank baselines SHIFTED tonight — tel0s planted a
  lush meadow (density 1.4, 153k instances) in the real commons,
  which bootjank faithfully replays; p95/p99 comparisons against
  pre-planting runs are apples-to-oranges now.
- **2026-08-10 — §22: grassdiag — the meadow's GPU cost, attributed by
  difference.** tel0s suspects grass PHYSICS (the shader pushers) over
  fill on the MacBook's 50fps. The costs are GPU-side and invisible to
  the CPU bill, so the diagnostic is differential: `await
  EW.grassDiag()` freezes one component per ~4s phase — pushers (empty
  list → the per-vertex displacement early-outs), all autos
  (wind/gust/billboards/ticks), blades forced far-LOD, density 35%,
  grass hidden — sampling fps/ms/worst, fully self-restoring
  (try/finally). New flora exports freezePushers/forceBladeLod (the
  LOD hysteresis restated equivalently for the force hook — verified
  near↔far bands unchanged); terrain.getGrassField; bootjank
  --grassdiag [--pixels N] runs it headless. Validated mechanically
  here (all phases cycle+restore, no page errors, lightbench 30/30);
  this box holds 121fps even at pixelRatio 3 so deltas are zero BY
  RIGHTS — the discriminating run is tel0s's vsync-bound Mac, where
  the first phase that recovers toward the no-grass fps names the
  dominant cost.
- **2026-08-10 — §20d LANDED — THE KTX2 ARC IS COMPLETE (models 20a/b,
  avatars 20c, loose textures 20d).** optimize.ts --ktx2-img: pngjs/
  jpeg-js decode (the arc's ONE dep addition, pure-JS, flagged — sharp
  is broken on this box and the flip must gate deterministically) →
  vertical row flip BAKED (three's KTX2Loader ignores KTX orientation
  metadata; the engine contract stores the flip in pixels) → toktx.
  Filename→codec/transfer classification with a verified CALL SITE per
  rule (127 files dry-run: grass albedo/translucency + sky photos
  ETC1S/sRGB, normals/roughness UASTC/linear, particle sprites
  UASTC/sRGB — emitters.js loads them {srgb:true}, overruling the
  brief's table; trace_06.png has CONFLICTING consumers → honestly no
  variant; 9 non-POT files skipped with reasons). Sweep arm #3 over
  the three curated dirs; /library ?ktx2=1 extended to images; the
  client negotiates at the FILE layer (primeFiles) so every path/cache
  identity is unchanged and loadImageTexture routes by 12-byte magic
  sniff (detached-buffer hazard defused: parse gets a copy, never the
  primed storage). ORIENTATION PROVEN two ways: a constructed corner-
  marker round-tripped through the independent KTX transcoder, and
  pixel statistics on the shipped albedo (mean |diff| 2.19 vs flipped
  source, 22.29 vs unflipped). Gate: 28 variants built + 4 honest
  skips; bootjank shows every asset class negotiating (veg maps
  ?ktx2=1, starmap 2.9MB→1.2MB wire, the 92.5MB veg upload block →
  16MB); lightbench 30/30 + measure at 120fps (the meadow renders
  through KTX2 — visual truth); paritybench PASS.
- **2026-08-10 — §21 LANDED: the voice double-offer, diagnosed
  deeper.** The brief's premise corrected by the agent: upstream
  ALREADY serializes per-peer (sigQ) — the two inherited check
  failures were Windows/Bun TIMER artifacts (~15.6ms setTimeout
  granularity × three sequential awaits missing the suite's 20/60ms
  windows), so upstream likely never saw them fail on their boxes;
  our earlier "fails identically on pristine upstream/main" was true
  on THIS box specifically. The fix is real regardless: the stored
  chain now carries its own .catch (a rejected link could WEDGE every
  signal queued behind it — a genuine latent bug), and
  setRemoteDescription/createAnswer submit together (spec-faithful:
  RTCPeerConnection's internal op chain orders them; the sequential
  await bought only latency) — answers leave one tick sooner
  everywhere. Glare logic untouched. voice-lifecycle 95/95 ×4 (three
  agent runs + operator). Platform note: the suite's margins are
  tick-exact on Windows/Bun.
- **2026-08-10 — §20c LANDED: VRMs, KTX2 by surgical container
  rewrite.** No gltf-transform Document ever touches a VRM (it drops
  the VRM/VRMC extensions): optimize.ts --ktx2-vrm parses the GLB
  container raw, classifies every image across THREE schema
  generations (core glTF + VRMC_materials_mtoon + VRM0
  materialProperties; scalar-sampled slots → UASTC, unclassifiable →
  UASTC), swaps image bytes IN PLACE (every bufferView keeps its
  index; offsets recomputed 4-aligned; zero reindexing;
  accessor-shared views never touched), and VALIDATES its own output
  before writing — 13 untouched JSON sections stringify-identical,
  every unreplaced view byte-compared; any discrepancy refuses. A
  torn VRM is someone's body. Sweep covers vrms/**.vrm both bases
  (skipping .ktx2.vrm self-encodes); /library's ?ktx2=1 branch covers
  .vrm with a freshness guard (avatars mutate mid-session);
  avatarRoster filters variant ghosts; loadVRM flags capable fetches
  (the &ktx2=1-after-?v= case). MEASURED: aletheia 31→23.3MB
  (6,982-check independent verification, ktx2check 3/3,
  deterministic); the heavyjoin gate shows 14.1MB on the wire
  (gzipped variant), textures 42ms (raw original: 352ms), pool-hit
  0ms intact. claude.vrm turned out to have ZERO textures — a pure
  vertex-color body; honest exit 2. Adjacent fixes landed with it:
  prefetch now warms the SAME ?ktx2=1 cache key demand fetches use
  (ktx2Capable export — unflagged warmth was pure waste for capable
  clients, a 20b-era gap), /library-models stops listing .ktx2.glb
  ghosts. Gate: lightbench 30/30, paritybench PASS. Known: a freshly
  uploaded avatar gets its variant at the next boot sweep (freshness
  guard keeps serving correct meanwhile); .failed markers don't
  expire on source change; sharp remains unusable on this Windows box
  (two-libvips clash — skip-the-texture posture holds). REMAINING in
  the arc: 20d loose toolkit PNGs (veg + 4K sky = the last big
  chunk), the JPEG-threshold decision, then the voice double-offer
  fix (queued by tel0s).
- **2026-08-10 — §20a+20b LANDED: KTX2, server arm + client loader.**
  optimize.ts --ktx2 (diet minus webp, plus per-texture toktx/ktx —
  probed KTX2_TOKTX→toktx→ktx, exit 3 = no-encoder = env-skip; UASTC+
  RDO+zstd for non-color slots, ETC1S q128 for baseColor/emissive,
  --genmipmap; not-smaller gate 1.25× vs SOURCE for ktx2 mode);
  upload.ts library sweep (boot-deferred, recursive over
  eidoverse/assets/models/**.glb, path-preserving OPT_DIR/<rel>.ktx2.glb
  dests through the same serial pump; VRMs excluded per doctrine);
  routes.ts negotiated serving (?ktx2=1 + .glb + variant-exists, else
  byte-identical originals — agents/tools never see extensionsRequired
  they can't parse) + .ktx2/.wasm content types. Client: one KTX2Loader
  singleton beside draco (vendored basis transcoder path, detectSupport
  post-TLA-init), setKTX2Loader in makeLoader (all three parse sites),
  globalThis.KTX2Loader for toolkit modules, ?ktx2=1 appended to .glb
  library fetches when workerConfig exists, textureUploadBytes
  compressed branch (mip-byte sum). MEASURED: the commons five
  transcode 1.8-4.2× (CRT 39.3→9.5MB); negotiation curl-verified
  (6.7MB unflagged / 3.6MB flagged); bootjank shows the client
  self-negotiating (?ktx2=1 URLs + basis_transcoder.wasm fetch) and
  per-GLB texture phases COLLAPSED — CRT textures 10ms (the Mac paid
  1221ms for the raw original). Encoder for this box: a portable
  toktx v4.4.2 (7z-extracted NSIS, scratchpad, no install); prod Mac:
  pkgutil-extract per docs/ktx2-encoder.md (brew has no formula — a
  correction; the pkg's Rosetta demand is an installer-metadata bug over
  a fully arm64 payload). Gate: 5/5 transcodes + ktx2check, lightbench 30/30
  (the cloud-easing check now samples up to 5 rAF pairs — a loaded
  headless box batches rAF callbacks and a single pair can read dt=0),
  paritybench PASS (variants realized live in bootjank's browser).
  FINDINGS: JPEG-textured models can exceed the 1.25× gate (UASTC 8bpp
  floor vs JPEG source — crow 2.9→6.0MB, honest .failed, originals
  served; threshold/resize is tel0s's call); pristine optimize.ts has
  NEVER run on this Windows box (ndarray-pixels' nested sharp 0.35
  clashes with root sharp 0.33 — the ktx2 arm sidesteps it by feeding
  toktx PNG/JPEG directly, sharp best-effort only); collider-survey's
  single-file mode crashes on ORIGINALS too (empty-stats guard missing
  — pre-existing, noted not fixed); ~0.7s of the sky-bake stall tail
  can leak past the curtain (residual queue drain after whenBakeReady
  resolves — minor, watch it). REMAINING: 20c VRMs (surgical container
  rewrite), 20d loose toolkit PNGs (the last big tex-upload chunk:
  veg 92.5MB + the 4K sky sources).
- **2026-08-10 — UPSTREAM MERGE: six commits from anima-research/main
  (c2c51d8..0775b93), cherry-picked -x in order.** Clean: incident-88
  door hardening (+3 suites), modclose 4006-through-close(), both
  voice fixes (mic-track timing classes; the one-AudioContext leak,
  +audioctx.js). Translated: HN_AUD env knob → server/auth.ts (the
  block moved in 7a); the motioneval extraction — upstream pulled the
  motion closed-forms into DOM-free motioneval.js for the agent's
  text-tier perception (their flora_lod-style move), adopted whole
  with our two deltas re-applied (the 90m camera gate, the
  pendulumImpulse mirror comment now pointing at server/reactions.ts);
  mcpl/agent.ts kept OUR shared-fold stateToEntries delegation (theirs
  is a drifted local copy) + their new effective.ts import. Local
  portability patches to their new suites: process.execPath-never-
  "bun" (the Windows shim footgun) in incident-88-door-test +
  modclose, EIDOVERSE_DIR house default in modclose. Gate: motioneval,
  audioctx 7/7, incident-88 20/20 + edge 10/10, modclose PASS,
  servergate smoke/authtest/behaviortest 3/3, paritybench, lightbench
  30/30, bootjank A/B-verified vs a pre-merge worktree (the slower
  sky compile this evening is environmental — identical pre-merge).
  KNOWN INHERITED: voice-lifecycle 93/95 — the 2 failing checks fail
  IDENTICALLY on pristine upstream/main (their documented-open
  double-offer answer loss, "main loses the second at setLocal");
  candidate for us to fix under the standing upstream-redo permission.
  KNOWN LOCAL: incident-88-door-test still times out on Windows after
  the spawn fix (its fixed-port mcpl boot; sibling coverage green) —
  flagged, not chased. mcpl/bun.lock is TRACKED (old upstream commit)
  — do not delete it; the footgun is running bun INSTALLS in mcpl,
  not the lockfile.
- **2026-08-10 — MacBook CONFIRMATION (tel0s's own --heavyjoin trace)
  closes the §19 arc.** First wear of the 21MB body: parse 68ms,
  textures 352ms over 24 frames; ZERO frames >25ms after t=14.9s
  through both heavy joins; the MToon compile (~4s) fully off-frame;
  rewear "pool-hit — 1ms / compile skipped". The Metal compile of the
  sky's 1.5MB bake shader costs ~7.2s and its 5s frame lands INSIDE
  the 13.7s splash — invisible; warm visits will skip most of it.
  Steady state locks their 60Hz vsync (p50 16.7ms). VERDICT: the
  worker-parse tail is NOT justified by data (parse was the smallest
  number in the trace) — shelved on evidence. ELEVATED by the same
  trace: KTX2/basis via the server optQueue — their Mac pays
  1.0-1.2s/GLB in texture decode and 1.07GB of raw RGBA uploads
  (vs ~456MB on the dev box); compressed textures collapse both
  4-8×. That is the next arc when tel0s calls it. Minor note: the
  16MB/frame upload budget produces ~100ms frames on Mac's slower
  uploads (one 100ms frame at t=14.9s) — a per-platform budget is
  the five-minute version, KTX2 the real one.
- **2026-08-10 — §19b LANDED: the VRM instance pool — a body parsed
  once is never re-paid.** The step-5½ deferred tail, landed with its
  recorded landmine defused: three-vrm has NO blessed deep-clone (its
  plugins bind to specific nodes — verified against vendored 3.5.2), so
  the cache is a pool of whole parsed INSTANCES: Avatar.dispose splits —
  per-body artifacts (label/bubble/mixer/scene membership) die as
  before; the VRM returns to the pool INTACT via releaseVRM (real
  deepDispose only at pool eviction; dispose is now idempotent so a
  stale second dispose can't re-pool a worn body). Reset at release AND
  defensively at take (lookAt/humanoid/expressions/springBoneManager
  resets, all line-verified; a reset that throws evicts rather than
  pools a haunted body). Budget: 2 instances / 64MB, LRU,
  never-evict-what-just-landed; evictIdleProtos drains the pool FIRST
  under GPU pressure; poolStats rides EW.gpu(). The own-body switch
  order (mybody wireAvatarSwitch) was verified already-correct
  (new-ready → swap → release) and is now documented load-bearing.
  Pool hits skip the conductor compile explicitly (instance-keyed
  vrmWarmed). PROOF in bootjank --heavyjoin's new join→leave→rejoin
  leg: first wear "parse 124ms over 24 frames + warm 3.3s off-frame";
  rejoin "vrm aletheia.vrm: pool-hit — 0ms" + "compile skipped —
  pooled body" with ZERO jank frames. Gate: lightbench 30/30,
  paritybench PASS. Known transients (agent-flagged): spring bones on
  a pool hit see the placement jump exactly as a fresh parse does; the
  whenCalm thumbnail borrow race is pre-existing and now SAFER.
  Remaining for the MacBook switch halt: first-wear Metal pipeline
  compile + parse speed — awaiting tel0s's --heavyjoin trace there
  before weighing the worker-parse project.
- **2026-08-10 — §19a LANDED: the cloud-graph compile is splash, not
  session (tel0s's call).** The §18b fence is eager again — 'clear'
  always respells as empty cumulus on capable tiers — and the one big
  compile lands INSIDE the boot gate: whenSkyWarm now waits for
  ensureSkyBake + whenBakeReady (the band pipeline warm), cap raised
  8→25s (measured: the stall spans t≈6→15.3s on this box's cold GPU
  cache and the curtain lifts as it ends; the gate resolves EARLY when
  warm — the cap binds only pathologically; warm Dawn caches pay ~0).
  Boot on commons: ~5s → ~15s cold, first visit only. Every
  mid-session sky change is now uniform writes, no exceptions. Also:
  bootjank gains --heavyjoin (a 21MB-avatar resident joins at t≈+12s —
  the §19b measurement mode). MEASURED on this box: the heavy arrival
  is CLEAN (parse 125ms, textures 168ms, spread over 24 frames, worst
  frame 41.7ms) — tel0s's couple-of-seconds switch halt does not
  reproduce here, pointing at the SWITCH-specific path (old-body
  teardown + fresh MToon pipeline compiles on Metal) and/or MacBook
  parse speed. §19b next: VRM proto cache (the recorded tail — with
  the dispose landmine) + switch-path teardown deferral; MacBook trace
  requested to confirm the dominant term.
- **2026-08-10 — §18 LANDED: the sky stops halting, light edits stop
  lying.** Two user reports from tel0s's MacBook session, both
  root-caused by extraction and fixed. **18a (lights, a bug FAMILY —
  executed by a Fable agent, full servergate 12/12 gate):** (1) the
  fold's light-on-light case wholesale-replaced the entity, destroying
  comp/parent/yaw/scale — violating PROTOCOL §3.1's own "partial
  update" text; it now carries them (base kind-guarded; fixture 05
  extended after byte-identical regeneration proof; foldfix 24/24,
  state 31/31 gain light cases; stateToEntries roundtrips yaw/scale
  via a synthetic in-vocabulary `place`). (2) refreshLight ≡
  createLight now (mounted-pose guard, base/meta re-stamp,
  emitCompBag + execMount — a mounted light no longer JUMPS on a live
  brightness edit). (3) keeps are exempt from the governor's slotCap
  slice per PROTOCOL :99-108 (cap sheds the sheddable tail only).
  (4) the editor coalesces drags to ~1 verb/350ms (11.4/4s < the 12
  VERB_RATE — a colour-picker gesture no longer strands the local
  preview behind rate-limit refusals) and rolls back on refusal
  (net.js emits verb-refused → one refreshLight re-derives from fold).
  (5) lightbench gains `── live edit`: per-field re-apply at
  dayGlow>0, noon day:false ignition, the live-vs-join parity
  SIGNATURE across a re-join, foldParity over a comped+mounted light
  edit, keep exemption at 9 lights > 8 slots — 30/30. **18b (the ~5s
  sky halt, by hand):** the extraction KILLED the rebuild hypothesis —
  mid-session sky verbs never rebuild (world-identity only); the halt
  is maybeRefreshGraph's clear↔cloudy graph flip: a ~1.5MB-WGSL 8-pass
  cloud-march bake graph whose compile stalls the whole GPU process
  5-10s — measured, and NOTHING hides it (even createRenderPipelineAsync
  blocks Chrome's queue submits behind Tint; an eager boot pin moved a
  9-12s stall INTO clear worlds' first minute — reverted). The landed
  design: LAZY fence — clear worlds pin the cheap c0 graph; the first
  cloudy change pays the one c0→c1 rebuild (once per session, at the
  user's own change); from then on bakedCloudsPinned() gates the
  _internals.sky.setClouds wrap so 'clear' is respelled as an EMPTY
  cumulus (finalMul 0) and the preset never flips back — every
  subsequent sky change is uniform writes. cloudy→clear NEVER rebakes
  (one-directional maybeRefreshGraph). Plus: a dusk/dawn verb now
  requests a bake immediately (was: up to 9s of cadence latency —
  circular-delta jump detection); the band-context bake pipeline warms
  through the conductor before any band renders it ('warming' state);
  the degrade ladder counts FAILURES not builds (one recovered boot no
  longer condemns every later sky verb to a stacked frozen SkyMesh);
  azimuth stays dropped (units undefined upstream — ask #8).
  docs/upstream-wrap-once.md Addendum 2: per-bakeKey cache,
  authoritative includeClouds, bopts.target, api dispose (67MB leak
  per rebuild), azimuth setter. OPEN, tel0s's call: the one-time c1
  compile stall remains (~5-10s cold GPU, once) — options: pre-pay it
  inside the boot splash for weather-bearing worlds, or shrink it
  everywhere via cfg.cloudPasses (quality trade). Gate: servergate
  12/12, lightbench 30/30, paritybench PASS, bootjank max 516ms /
  p99 8.5ms over 45s, --wide PASS.
- **2026-08-10 — §17 LANDED (17a/17b/17c): vegetation part 2.** Grounded
  in tel0s's own trace (§17 header). **17a** prime-on-decode: every
  toolkit texture (vegetation texNode maps, sky domes — all TSL-node-
  held, invisible to collectTextures) uploads through the 16MB/frame
  budget at the loadImageTexture chokepoint, right after decode — the
  t≈6.5-6.8s stroke hitches are GONE from bootjank, the 4K starmap
  frame went 108→33ms. **17b** blade-LOD by index subset (new
  flora_lod.js, pure + unit-tested 13 checks): far tiles (>60m out,
  <50m back in) swap to a per-stroke index keeping 40% of blades,
  evenly strided, whole 24-entry runs only — shares every vertex
  buffer, and the executing agent PROVED zero new programs/pipelines
  from three.webgpu.js source (geometry is not a render-object chain
  key; the layout cache key never reads index identity; a live
  geometry swap keeps the compiled pipeline outright — one warm covers
  both twins). Far-field triangle bill ≈41% of before, compounding the
  instance falloff; near field bit-identical. EW.grass() reports
  lod/lodTiles. Structural re-verification in bladeLodIndex degrades
  to no-LOD on upstream version skew, never a torn tuft. **17c** the
  sky claim fence: terrain mesh, grass group wear userData.skyExempt
  at their add sites; claimSkyAdditions filters on it AND on isDebug
  (debug.js had worn that marker with a "sky must not adopt" comment
  since it was written — the filter never read it; tel0s's trace
  caught the claim swallowing the TERRAIN, which a sky rebuild would
  then have removed). Gate: flora 55/55, grass-quality 57/57, bootjank
  (no sky-claim leaks, no veg-texture stalls), lightbench --measure
  19/19 at 120fps, paritybench PASS. **17d — tel0s's call, open**: the
  26-52fps dead band (a 40fps meadow machine sheds nothing; the
  resident dial is today's control), near falloff tuning, device
  defaults.
- **2026-08-10 — 8e LANDED. STEP 8 COMPLETE — the rough first minute is
  measured, engineered away, and observable.** EW.grass() (terrain.js
  grassTiles — per-stroke tiled/planted/drawn/visible-tiles; §13.2's
  promised stats finally land), EW.warm() (conductor queue), EW.lanes()
  (scheduler + loadwork depths vs caps), EW.colliderCache() (per-lib
  BVH bytes/refs). bootjank prints the grass-tile and warm-queue lines
  in every run. THE STANDING GATE for client changes is now:
  paritybench + lightbench + bootjank (add bootjank --wide when
  residency/loading is touched). Final commons-replica numbers for the
  night, before→after: worst frame 1166→350ms, pipelines in the boot
  window 56→14, p99 8.6ms, texture uploads ≤34MB/frame (was 112),
  far-city worlds fetch NOTHING beyond the radius, and after t≈6s the
  frame trace is flat 120fps. The residue: one ~300ms GLTF-parse
  longtask at t≈1s (worker parse is the recorded tail), and boot is
  ~2s longer by design (sky warmth moved into the splash, capped 8s).
  Deferred tails standing: KTX2 via the server optQueue, ES-module
  decode/parse workers, ragdoll cell cache, VRM proto cache, CSM,
  segmented log index.
- **2026-08-10 — 8d LANDED: the storm's edges are calm.** (1) Governor
  loading grace: while warm-conductor items are queued/running, loadwork
  lanes busy, or promote tails pending, BOTH lever directions freeze and
  every streak counter resets — storm fps is loading, not a performance
  regime; EW.governor() carries grace/calmFor/calm + one "⏸ grace held"
  history line per spell. (2) whenCalm(): 5 consecutive smooth seconds
  (the restore ladder's own >52fps 1Hz read) with the busy predicate
  false, on its OWN counter (goodFor is consumed by every restore),
  sticky once latched. The thumbnail contribution and the speculative
  prefetch stream (roster VRMs — measured 45MB racing the storm at
  t≈5s) both ride it now; demand loads never touched prefetch and its
  'demand' abort preemption is intact. Policy note (flagged by the
  agent): a machine permanently in the 26-52fps dead band never latches
  calm, so those extras never start there — no wall-clock fallback, by
  design, revisit if it bites. (3) primeTextures spends a ~16MB
  estimated-bytes budget per frame (w×h×4×1.33; one oversized texture
  still uploads, alone in its frame) — single-frame tex uploads fell
  from 59-112MB to ≤34MB, hitches 75-141→41-100ms. The factory's shared
  noiseTex is primed once at module init (it rides colorNode graphs,
  invisible to Object.values); MToon was investigated and is NOT a gap
  (every map is an own constructor property read via materialReference —
  documented at collectTextures). Gate: grass-quality 57/57, bootjank
  (max frame 358ms — the residue is one 298ms GLTF-parse longtask,
  worker-parse is the recorded deferred tail), --wide PASS, lightbench
  19/19, paritybench PASS.
- **2026-08-10 — 8c LANDED: the join gate works, promotes drip, colliders
  share.** (1) createModel gates on POSITION unconditionally —
  residencyRadius falls back to DIAG_DEFAULT=12 (gate at 128m) until geom
  lands; the sweep now promotes bare null reservations too, not just
  placeholders (found live: a `place` moving a far entity near pre-geom
  would never have loaded). bootjank --wide (new fixture: 3 near + 6 far
  spawns at 300-500m, distinct libs) is the network witness — pre-8c it
  failed 6/6 FETCHED with demotes=6; now 6/6 never fetched, demotes=0.
  (2) realizeModel split: the visible half stays synchronous (step-out,
  scene.add, comp events); the heavy tail (fitCollider, attachLamps,
  registerCaster, mount re-execution) drains ≤4ms/frame through a new
  'promote-tail' frame system (after 'build'), identity-guarded, cancelled
  by demote/retire. A mount landing in the gap skips the child's collider
  (execMount law); the tail emits {kind:'collider'} so the grass clearing
  mask still learns interiors. (3) colliders.js per-lib cache — the brief
  assumed buildExact was world-baked; IT WAS ALREADY LOCAL (inv(root) folds
  the pose out), so the key is lib alone (scale-free product) and zero
  query paths changed. Shared: merged geometry+BVH, the topLie scalar, the
  hasFloor verdict. Writes only from pristine-clone fits (no glued riders,
  no part motions — shareableLib); step-out re-fits stay per-entity;
  refcounted, dropped at zero. colliderCacheStats() exported for 8e.
  Incidental fix: re-fits now clear stale bucket cells. (4) Two mount
  indices (fold-truth by parent.to at one choke point; scene-truth by
  userData.mountedTo at its write sites — a remove folds children's parent
  records away before retire runs, so scene truth is all step-out has) —
  the two O(N)-per-promote scans and canDemote's carrier scan are now
  O(children). parseAsync skipped (promisified same-thread parse — zero
  win). Gate: collider-test 34/34, models-field 12/12, flora 42/42,
  bootjank --wide PASS, bootjank commons (worst 400ms, everything after
  t=2s ≤50ms), lightbench 19/19, paritybench PASS. Known transient
  (flagged by the executing agent): a parity read in the 1-2 frame tail
  window of a promoted CARRIER could see mount-pose drift — no current
  bench samples that window. Remaining: the t≈1s parse/upload burst (8d).
- **2026-08-10 — 8b LANDED: the warm conductor.** client/lib/warmqueue.js:
  every pipeline warm rides one serialized queue with priority classes —
  P_GATE (terrain) > P_MODEL (GLBs, the avatar body) > P_AMBIENT (sky
  domes, shadow-depth variants). The classes exist because the first gate
  MEASURED the failure: FIFO queued a rain world's cloud-march compiles
  ahead of the terrain compile the curtain waits on and boot went 2s→16s.
  GLB and avatar compiles run mesh-by-mesh inside their item with a real
  rAF between — a whole-object compileAsync still gulped ~11 pipelines in
  one GPU-process batch (measured 383/491ms stalls) even serialized.
  Depth pre-warm: casterPass never flips an unwarmed caster; warmDepth
  compiles the exact shadow-pass state through compileAsync against the
  sun's shadow camera (the r184 trap — renderObject RESTORES its shadow-
  override mutations before compileAsync's deferred codegen runs, so a
  naive warm compiles the wrong pipeline; the warm material is
  pre-configured to the post-mutation state; the full line-number proof
  lives in warmqueue.js's header). Terrain's 1200ms compile cap deleted
  (P_GATE, awaited fully — an uncompiled ground is worse than a longer
  splash). Sky warm moved BEFORE the curtain: whenSkyWarm gate with an
  8s cap, riding its own counter beside the worldBuild chain (grass
  parks that chain on whenBooted — a sky queued behind it would deadlock
  the curtain; buildSky's own whenBooted wait removed for the same
  reason). Numbers (commons replica): frames>25ms 22→12, worst frame
  1166→433ms, pipelines 56→14, p99 16.5ms; boot 3.0→5.0s — the sky's
  warmth moved INTO the splash by design, rain worlds cap at 8s.
  lightbench's caster check now POLLS (first-cast has designed-in warm
  latency — the bench asserts the end state, not the old timing).
  Observed while gating, pre-existing: the sky's scene-diff claim can
  swallow concurrently-added debug helper groups (warm labels "sky warm
  debug:colliders") — harmless for warming, but teardownSky would remove
  them with the sky; noted, not fixed here. Remaining boot jank: the
  hydration/parse longtask storm (8c) and 59-112MB single-frame texture
  uploads (8d).
- **2026-08-10 — 8a LANDED: the meadow arrives warm.** Occupancy tiler
  (mojave 68→17 render objects; every tile's instanceMatrix ALLOCATED
  past the uniform-buffer limit so all tiles of a material share ONE
  program — three's fork reads the allocation, never the live count),
  host texture cache in loadImageTexture (bytes-identity WeakMap:
  Deno.readFileSync returns the same primed array per path, so identity
  IS the URL; 38→24 decodes; regrow reuses instead of re-decoding;
  cached textures dispose-proofed against upstream stroke dispose()),
  per-tile geometry.boundingSphere (the render sort reads the GEOMETRY
  sphere — the meadow no longer sorts as co-located at the origin),
  shrub stems stop casting (5 never-warmed depth pipelines gone), and
  warmField: every render object compiles DETACHED, one per real frame,
  then applyTiles re-settles against the live camera — no tile is ever
  cold. Gate: flora 42/42, grass-quality 57/57 (fixed its own Windows
  pathname bug: URL.pathname → fileURLToPath), lightbench 17+19 (120fps
  at 4-16 slots; dense-field build wall +~0.7s — the price of warming
  every tile, accepted), paritybench PASS, bootjank on the commons
  replica: rough window 8.4s→4.2s, worst frame 1166→825ms, pipelines
  56→31, ZERO pipeline creations after t=4s. Executed by a Fable agent
  from a scratchpad brief; its three deviations (above the limit the
  matrix rides an interleaved instanced ATTRIBUTE, not a storage
  buffer — program still count-independent; the cache-key gate is
  isInstancedMesh alone so the count=1 clamp is unnecessary; the whole
  field stays detached for the warm's duration so mid-warm frames never
  meet a cold sibling) all verified sound. Remaining boot jank is
  models (8b: unlaned compiles, depth pre-warm) and texture-upload
  spikes (8d).
- **2026-08-10 — step 8 opened: the rough first minute, measured and
  designed.** New tools/bootjank.ts replays a byte-copy of commons and
  attributes every long frame via document-start GPU hooks: rough
  0→8.4s then flat 120fps; worst frames are draws waiting on pipeline
  bursts (641ms, 1166ms). Two extractions grounded §16: compileAsync
  is ~10 yieldToMain per render object (rAF-quantised on Firefox) and
  the tiler multiplied mojave into 68 objects of ~51 instances (per-
  tile node builds via uuid cache key; <1024 instances bakes the count
  into WGSL); shadow depth + cold tiles + capped terrain compile
  synchronously inside render(); the residency gate is inert at join
  (everything loads, then far demotes); fitCollider rebuilds BVHs per
  ENTITY. Design: warm conductor, occupancy tiler + host texture
  cache, join gate + promote budget, storm edges. Slices 8a-8e in
  §16.3.
- **2026-08-10 — STEP 7 COMPLETE — the server split. THE §8 SEQUENCE IS
  DONE.** Four slices in one night, each gated 12/12 + paritybench
  (7c also lightbench 19/19): **7a** (d852118) config/auth/moderation/
  rights/lint/reactions step out with the cycle-breaking signatures
  (rightsOf reads the folded state; ban data separates from expel; the
  pendulum mirror moves to reactions.ts with the client cross-ref
  updated). **7b** (bdb988e) the verb table — one row per verb {rank,
  gen?, selfRankZero?, validate?, after?} + runVerb; preamble prose and
  the six post-append hooks byte-identical; expel injected via ctx; the
  okSim destructure bug fixed. **7c** (64e776b) World → WorldLog (the
  fold is the log's projection) / WorldSession (presence; depends on
  log one-way) behind a facade that keeps WorldLike and VerbWorld
  holding unedited; routes.ts table + upload.ts; the type-hygiene trio.
  **7d** (72bd0ed) batched appends — seq/tail/logBytes/fold stay
  synchronous, bytes coalesce per macrotask, and every claim about the
  FILE flushes first (fold's offset, fork's copy, reset's archive,
  readHistory's scan, shutdown's sweep); durability unchanged in kind
  and now stated honestly (page cache, as ever — no fsync ever
  existed). server.ts: 2,630 → 1,005 lines across 7 modules + world/
  routes/upload/verbs. Slices 7a-7c executed by directed Fable
  subagents from scratchpad briefs (each ended its turn mid-gate; I
  gated + committed — zombie-port sweeps between runs are part of the
  recipe now); 7d by hand, as durability deserved. **Steps 1-7 of §8
  plus the inserted 5½ are all landed.** The rebuild's foundation is
  laid: one fold, one loader, one lighting rig, fixed graph shapes,
  streamed residency, a culled meadow, a dissolved client, a split
  server, and 300+ wire-contract checks green around all of it.
- **2026-08-10 — 7-prep: servergate lands, and the battery baselines
  CLEAN.** `tools/servergate.ts` runs the step-7 gate lattice as one
  command: twelve suites, each external-server tool getting a fresh
  scratch sequencer with its exact env header, kill-by-child-handle +
  a post-run port sweep for the self-booting suites' leaked servers
  (Windows children outlive parents), per-tool log files. Two runner
  lessons paid for: piped child output with no reader deadlocks a
  verbose tool until its timeout (the first baseline spent 37 minutes
  proving it — stream to files); and `bunx`-triggered root installs
  PRUNE hoisted deps from root node_modules (mcpl's three/webgpu
  resolution died mid-session — mcpl now has its own node_modules;
  note bun install refuses mcpl/package.json on this box for reasons
  bun's own JSON parser disproves, npm works). And the big one: the
  "permtest 2 pre-existing env failures" carried in memory since the
  early sessions root-caused at last — **mcpl/tokens.json (gitignored
  secrets) simply doesn't exist on this machine**; the tests were
  written against a dev fixture (`dev-token` → claude). Fixture
  created locally; permtest 23/0, authtest 23/0 (its nick-reservation
  case was the same absence). **Baseline: 12/12** — smoke 85 ·
  authtest 23 · collide-fold 6 · support-lifecycle 22 · permtest 23 ·
  comptest 33 · modtest 23 · locktest 13 · leasetest 19 · worldops 23 ·
  compfold 24 · behaviortest 27. The split's gate is unqualified green.
- **2026-08-09 — STEP 6 COMPLETE — 6c: the trench coat comes off.**
  main.js 1120 → 381 lines: what remains is what the header always
  claimed — boot wiring, the door, the frame-system list, EW. The rest
  moved per §14.2: `mybody.js` (identity + the `me` handle behind one
  getter — 18 closure sites read one seam; the avatar-updated cold-cache
  crash fixed with a load-bearing `?.`), `localbody.js` (ragdoll/mounts/
  pins/dragged/shove — logChat INJECTED via initLocalBody so the chat
  knot stays open), `consent.js` (zero-import), `voicemouths.js`
  (caption/speech twins merged), `emotebar.js`, `mint.js` (dynamic), and
  `commands/` — registry.js a PURE table importing nothing, chat.js
  deriving autocomplete from it (the hand-kept copy and its duplicate
  /kick row die; chat→handlers→net→chat never closes), handlers.js
  preserving the kick/push disambiguator fallthrough, the dead /rename
  answering honestly at last. tools/voice-wiring-test.ts followed its
  code (35/35). Executed by a directed Fable subagent against the §14
  map; module-graph claims audited before commit (registry imports
  nothing ✓, localbody never imports chat ✓, chat imports only the
  registry ✓). Verified: lightbench PASS · paritybench PASS. Step 6 is
  closed — remaining small tail: the ragdoll body-level cell cache.
  **Next: step 7 — the server split (§7).**
- **2026-08-09 — 6b landed: the frame loop is a system list.**
  `lib/frame.js` owns the loop; main.js registers ~18 systems in the
  order §14.1's constraints demand. Each tick is timed into a rolling
  average (`EW.frame()` prints the bill), carries enable + stride flags,
  and is fenced — a throwing system reports (throttled) instead of
  killing rAF and freezing the world. `perf.js` (zero-import leaf) holds
  fps for governor/HUD/debug; `hud.js` takes paintHud; `bc.js` takes the
  breadcrumbs (system names stamp as they run). `startFrame()` is
  explicit — the loop still starts only after identity resolves. The
  governor gains its first system-stride lever: 'cosmetics' halves the
  autos hooks under pressure, two-way. Verified: lightbench 19/19 ·
  paritybench PASS. Remaining in step 6: 6c dissolution.
- **2026-08-09 — 6a COMPLETE: the spatial service, and all four hot paths
  are dead.** `raySegment(origin, dir, far)` in colliders.js answers the
  follow camera's one question — how far back may the eye sit — from the
  grid: candidate ids from the cells the ≤6m segment overlaps, slab test
  against each OBB (the same world→local transform surfaceUnder uses),
  BVH `raycastFirst` for exact entries (the camera still slides through a
  doorway instead of bumping the pavilion's box), the walking POST for
  pillars (a tree's canopy box must not yank the camera the way its
  sparse meshes never did), `camGhost` hoisted onto the entry at
  fitCollider. The recursive every-mesh-of-every-entity raycast with its
  three per-frame allocations (offender #1) is deleted, along with the
  `setCameraCollisionTargets` DI hook — the grid needs no entity list.
  `findSeat` and `surfaceUnder` leave their full-map scans for
  `nearColliders` (a seat search ran every X press and the 0.45s hint
  beat); rapierdoll's hand-rolled 8m filter becomes the grid query it
  was imitating. With slice 1 (physobj, gaze 4Hz, motion 90m gate,
  pusher reuse) all four §2 hot-path offenders are gone. Deferred small
  tail: the ragdoll body-level cell cache (a resolveColliders signature
  change; ~171 map lookups/frame, modest). En route: a `_want` name
  collision with photo mode broke module load — caught by the new habit,
  a 2s esbuild parse pass before any bench roundtrip. Verified:
  lightbench 19/19 · paritybench PASS. Next: 6b (frame-system list).

- **2026-08-09 — STEP 5½ COMPLETE — the review round.** An adversarial
  Fable review of the whole 5½ diff verified the §13 contracts against
  source (stable bucketing, shared-buffer upload/dispose semantics,
  identity-instanceMatrix load-bearing via r184's setupPosition, culling
  path, retain/release balance, LRU safety) and found **2 blockers, both
  fixed**: promote removed the stand-in SUBTREE wholesale while mounts
  and emitters legally hang durable children off placeholders — cargo
  mounted on a far carrier vanished forever (parity silently green;
  realizeModel now steps riders out + clears mountRel so execMount
  re-attaches) and emitters attached to a stand-in survived as stale
  registry handles (the spawn event now retires-then-reapplies). Plus
  five should-fixes: the forgetBytes byte-ledger drift (double-count +
  LRU stall), eviction racing in-flight clones (loadsInFlight refs +
  post-await recheck), a failed lib becoming a 500ms promote loop
  (rejection leaves glbCache + 30s backoff), editHold made id-based in
  world.js (promotion swaps the object under a userData flag), terrain's
  layer textures (colorNode-bound, unreachable from material props —
  stashed at build, disposed at replace), and residency distance =
  min(camera, avatar) so photo-mode flight can't demote the floor under
  your own body. Re-gated: lightbench 19/19 · paritybench PASS. Step 5½
  is closed. **Next: step 6 — main.js dissolution, frame-system list,
  spatial-index service.**
- **2026-08-09 — step 5½ R2+R3: protos evict under a VRAM budget, bytes
  ride an LRU.** `glbCache` is refcounted (realize retains, retire/demote
  release); every ~5s the residency sweep reads
  `renderer.info.memory.total` against a 1.5GB budget and zero-ref protos
  dispose their unique geometries/materials/textures (the factory's
  shared noise texture rides the node graph — unreachable from material
  properties) and leave `glbCache`/`compiledLibs`. Compressed bytes stay
  (byteCache/HTTP cache): re-promote is a parse, not a download.
  `byteCache` is a 128MB LRU (Map order = recency) — the 29.5MB
  VRM-after-one-glance class of retention is gone. `EW.gpu()` = info
  .memory + tier stats. Verified: lightbench 19/19 · paritybench PASS.
  Step 5½ implementation complete — adversarial review round is the
  remaining gate before the step closes.
- **2026-08-09 — step 5½ G2: the meadow is tiled.** Big blade/corn strokes
  (≥2k instances) re-cut after the density shuffle into ~12m XZ tiles: K
  geometries sharing the vertex/index/`aH` attribute OBJECTS (one GPU
  upload) with sliced copies of only the three instanced attributes, K
  meshes sharing the ONE material, per-tile world spheres +
  `frustumCulled = true` — three's culling finally works on grass, and
  per-tile `count` gives distance density free (stable bucketing
  preserves the shuffle, so a tile prefix stays a uniform thinner): full
  inside 30m, →25% at 140m, invisible beyond, on a 300ms tick.
  `setDensity` is the per-tile fan-out; the container answers #74's
  applied-truth with a summing `count` getter and `strokeApplied` learned
  `applied-with-falloff` (deliberate under-draw is not a failed dial —
  the cap binds from above with per-tile rounding slack). Tile geometries
  die with the field (`dispose` wrapped); userData flags + shadow policy
  copied per tile; shrubs (stem-mesh pairs, hundreds of instances) keep
  G1's whole-stroke sphere. Verified: lightbench 19/19 + measure sweep
  (grass builds ~1.5s through the tiler, 120fps) · paritybench PASS.
- **2026-08-09 — step 5½, first two slices: grass G1 + residency R1.**
  G1 (§13.2): per-stroke WORLD bounding spheres assigned by the adapter +
  `frustumCulled = true` (upstream couldn't — its instanceMatrix is all
  identity, so three would cull a half-meter sphere at the origin);
  looking away from the meadow stops drawing every blade. Grass
  `receiveShadow` now EXPLICITLY false (the old if-without-else left the
  scene's biggest fill surface paying shadow taps while the comment
  claimed otherwise) and `noPuddles` gates the puddle branch off at
  compile (blade normals are forced straight up — rain painted puddles ON
  BLADES); wet darkening + cloud shade stay. R1 (§13.3): the 500ms
  residency sweep — beyond 80m + 4×bbox-diagonal (20m hysteresis) a
  realized entity de-realizes back to the placeholder tier (subtree,
  collider BVH, camera-collision triangles, lamps, caster freed);
  promotion reruns the ordinary load pipeline; and an entity SPAWNING
  beyond its radius with a known bbox never loads at all — the far city
  is honest boxes until approached. Refusals: carriers, mounted
  children, part sockets/motions, seated bodies, the selected entity
  (editHold). Emitters retire on the new 'demote' event. Plus the
  setTerrain disposal leak fix, `EW.residency()`, `EW.gpu()`. Verified:
  lightbench 19/19 (drive an entity across the boundary with `place`;
  fold parity holds demoted AND re-promoted) · paritybench PASS ·
  measure sweep 15/15. Remaining in step 5½: G2 (tiling + distance
  density), R2 (refcounted proto eviction under the info.memory
  budget), R3 (byte LRU).
- **2026-08-09 — STEP 5 COMPLETE — 5g: measured, reviewed, fixed.**
  `tools/lightbench.ts` (CDP, scratch door, headless Edge) now proves what
  paritybench can't see: rain folded → wet/cover targets exact and rising
  frame-over-frame; six placed lights + the adopted bolt assign exactly per
  §12.4 (keeps + mirror cast, casting = min(requests, cap)); at noon only
  the `day:false` porch burns among eight slots; **the lightning is a
  mirrored `foreign:` request and the scene's light topology is exactly
  the fixed inventory** (hemi, sun, slots, eager fill); casters track
  realized models; zero page errors. **The slot sweep answers the oldest
  number in this rebuild**: grass compiled 1379/1510/1551/1597ms at
  4/8/12/16 slots and held ~120fps at every count — the "grass + 4 lights
  never finished compiling" hang was runtime-recompile churn, cured
  structurally; default pool raised 4→8 (measured, the modest end of §5's
  band; `?slots=N` re-measures). Throttled boot (25mbit/40ms) median
  2054ms on a heavier world than step 4's, connect mark 86–101ms — the
  early socket intact, no regression. An adversarial Fable review of the
  whole step-5 diff confirmed the §12 contract surface against source
  (wetness port node-for-node, r184 claims, proxy vs consumer, module
  graph acyclic) and found **2 blockers, both fixed**: the governor's
  grass restore read EFFECTIVE density (capped residents wedged the
  unwind — casters/lights/emitters never recovered; the governor now
  tracks its own dial) and the adopted lightning leaked across
  eidoverse→skymesh teardowns (scene-diff can't see what the seam kept
  out of the scene; `releaseForeignLights()` rides teardownSky + the
  build-budget fallback — a dead mirror could have burned at strike
  intensity 12000 forever). Plus: pointless-shed guards (lights/casters
  levers verify something is actually casting), `?slots=abc` NaN guard
  (froze the frame loop), mirrors hold RESERVED slots (exempt from the
  governor cap — a shed-to-zero pool must not delete a storm's strikes),
  ladder-robust caster stepping. Re-gated after fixes: lightbench 15/15 ·
  paritybench PASS. Disease A is cured: no compile-ordering timeout, no
  hold, no recompile storm survives in the client. **Next: step 6 —
  main.js dissolution, frame-system list, spatial-index service.**
- **2026-08-09 — 5f landed: the light policy is spec.** PROTOCOL §3.1 now
  states what `keep` honestly means under the rig (first claim on a
  casting slot, never governor-shed — top *priority*, not an unbounded
  promise) and adds `day: false`, the deliberate noon porch light's
  opt-out of the time-of-day cycle. Both stored only in their non-default
  state; partial updates merge them like any light field. The shared fold
  carries `day` (foldEntry + stateToEntries + the WorldState typedef);
  fixture `05-lightpolicy` pins survival-through-partials and
  clear-at-default for both flags, its folded.json generated by the
  shared fold itself. Client: the realizer passes folded truth as
  EXPLICIT values into updateLight — which also fixed a live landmine
  where a cleared `keep` folded as absent and slipped through the
  null-skip patch guard, leaving the old value stuck on. The inspector
  grew the "burns at noon" checkbox. docs/upstream-wrap-once.md gained
  the addendum for Skye: the `strikeLight` injection ask, a per-material
  cloud-shadow wrap, and blessing `noWet`/`noCloudShadow` as contract
  (noting AGENTS.md says materials where the code checks meshes).
  Verified: foldfix 20/20 · state 29/29 · compfold 24/24 (FOLD_EVERY=1
  scratch door) · paritybench PASS.
- **2026-08-09 — 5e landed: the holds are deleted.** `holdObjectCompiles`
  (25s cap, the sky-before-objects wait), `holdFrames`/`framesHeld` (the
  4s settle beat), the gpu-lane held-object filter, and the render skip
  in the frame loop are all gone — presentation never pauses again. The
  reason they existed is cured, not suppressed: materials are born with
  their final graph (5a), light topology is frozen at boot (5b), the env
  texture is persistent, so sky arrival invalidates NOTHING. The one real
  cost that remains — the sky's own dome pipelines, the biggest single
  compile in the client — warms detached (claim-diff list → remove →
  compileAsync → re-add, the grass precompile pattern) so even the sky's
  first frame doesn't stall. `checkIdle` drops its objectsHeld coupling;
  the jank watchdog stops excusing held beats (there are none to excuse).
  The boot beat is dead; §2's timeout-density diagnosis is now fully
  answered — no compile-ordering timeout survives in the client.
  Verified: paritybench PASS.
- **2026-08-09 — 5d landed: the governor is two-way, and the tuner stops
  lying.** `client/lib/governor.js` — one lever ladder (casters → light
  slots → emitters → grass → pixels → LOD+shadow-res), every lever with
  degrade AND recover, unwound back-to-front on 5 smooth seconds
  (pixels return first, the meadow regrows last). One shed per 3-second
  slow window (a hitch cannot cascade the ladder); 26/52 fps hysteresis
  with a dead band that counts toward neither. Session-scoped — no
  localStorage writes ever. The cloud lever is GONE: it persisted a
  degradation across sessions and answered slowness with a full sky
  rebuild; cloud tier is the resident's ⚙ preference alone now. Tuner
  rescue: fog density works on both sky paths (upstream only ever wrote
  fog COLOR — the slider was dead on the shipped sky for no reason);
  sun/ambient ride as post-update multipliers after applyToLights (the
  layering sky_worlds' own comment invites); azimuth/fill dim honestly
  with "the detailed sky drives this itself" instead of sitting there
  dead. 5 of 8 dead-on-real-sky sliders → 1 honest death + 3 rescued.
  Verified: paritybench PASS. `EW.governor()` shows the ladder + move
  history. (Noted en route: build.js's seat-gizmo keys embed raw NUL
  separators — deliberate, but it makes ripgrep treat the file as
  binary; a future cleanup could use the escape form.)
- **2026-08-09 — 5c landed: the shadow follows the camera; casters are a
  budget, not a drip.** The sun's config moved into the rig (shadowMap
  enabled/type are pipeline-shape → set once at module init); the frustum
  follows by sliding the ORTHO EXTENTS — the camera expressed in the
  light's view frame, left/right/top/bottom/near/far re-centred around it,
  texel-snapped against shimmer, our own updateProjectionMatrix (three
  never calls it). Recompile-free on both sky paths, no fight over
  sun.position (the sky rewrites it per frame). Shadows now exist
  everywhere, not just ±46m from spawn. Casters: castShadow is in no
  cache key, so the nearest-K entities cast (K=12, a governor lever),
  re-ranked every 300ms, ≤2 new enables per pass to spread first-cast
  depth pipelines — the one virtue of the old drainShadows drip, kept
  without its 250ms beats, lanes-idle coupling, or 30s fallback (all
  deleted, world.js and the models realizer's re-arm both). Bodies stay
  on blob shadows until measured. Verified: paritybench PASS.
- **2026-08-09 — 5b landed: the lighting rig.** `client/lib/lightrig.js` —
  the light topology is born at module init and never changes: N point
  slots (start 4 = the old measured-safe MAX_CAST, `?slots=N` for the 5g
  re-measure) under one group, idle = intensity 0. Placed lights, emissive
  lamps, and foreign lights are REQUESTS: assignment is keep/adopted >
  authored > inferred, ties by camera distance with a 15% incumbent bonus
  (no boundary flicker); slot churn is uniform writes. `keep` is now top
  priority, NOT a budget escape (old keeps cast outside the budget —
  unbounded; 4 fixed slots are strictly cheaper than the old worst case).
  The weather system's permanent lightning PointLight is adopted through a
  stable scene Proxy on the makeWeatherSystem seam (lights swallowed at
  add(), mirrored into a slot verbatim per frame; the one-system-per-scene
  registry eviction reaches our release because the proxy is stable).
  Dead: MAX_CAST + grantCast + the compileAsync-per-grant, sky.js's
  MAX_LAMPS/lampLights/attachLocalLights (lamps are rig requests now, no
  whenBooted deferral — nothing left to defer), the lights.js→sky.js
  import edge, and fillLight's lazy birth (eager now — it used to appear
  exactly when the sky DEGRADED, paying a recompile storm at the worst
  moment). Placed lights now live in time-of-day like lamps (the §5
  design; `day:false` opt-out rides 5f). Governor's shed lever maps onto
  a slot cap that can come back up. Verified: paritybench PASS (light
  verb + partial update through the request path, reconnect green).
  `EW.lightrig()` shows the pool.
- **2026-08-09 — 5a landed: the material factory.** `client/lib/materials.js`
  — every material entering the world passes through `prepareObject` at
  creation, before first compile: a shape-identical port of upstream's
  wetness wrap (same nodes, same `noPuddles` gate, our uniforms), our own
  two-tap cloud-shade field (seeded tileable noise born at boot — every
  client grows the same field — wind-scrolled, sun-projected via the live
  sun light), and the shadow-receiving policy (terrain receives at last;
  placeholders/gizmos never). Every prepared mesh carries `noWet` +
  `noCloudShadow`, so upstream's sweeps find nothing; unprepared (🧩 mod)
  materials still get swept as before. The driver reads FOLDED state
  (`effectiveSky` → wet/coverage targets, ~1Hz derive + per-frame ease:
  wets in ~10s, dries in ~40s) — wet ground works before the sky modules
  arrive, and under the SkyMesh fallback. Wired at every birth site: GLB
  prototypes, VRMs (MToon gets wetness, matching the sweep), terrain,
  grass (whole stroke group), stage floor; markers on placeholders,
  gizmos, emitters (a fire no longer gets wet — deliberate). Verified:
  paritybench PASS (terrain/grass/model compiles all through wrapped
  graphs, reconnect leg green). Visual tuning + the uniforms-move probe
  ride 5g. `EW.materials()` exposes the counters.
- **2026-08-09 — step 5 grounded: the extraction round, and §12.** Three
  line-level extraction passes (Opus agents, verified against the design):
  upstream's wrap mechanics, three.webgpu r184's actual invalidation
  rules, and the client's material/governor/shadow map. The findings
  reshaped §5 into a concrete reference design — **§12** — with the
  binding facts: the lights hash is per-light `(id, castShadow)` in
  traversal order (identity, not count — so the weather system's
  permanent lightning PointLight needs a scene-proxy adoption seam, not a
  swap trick); there is no intensity-0 culling (dim-to-zero is the
  supported "off"); `object.castShadow` is in no cache key (the
  caster-budget drip can die) while `receiveShadow` is in both (set at
  birth, never toggle); `weather.wrapMaterial` is already factory-form
  and the wetness wrap is stubbable shape-identically before the modules
  arrive, while cloud shadow is not (we bring our own field). Bugs
  surfaced en route: real terrain never receives shadows; the shadow box
  is pinned ±46 around the *origin*; the governor's cloud lever persists
  degradation to localStorage and answers slowness with a full sky
  rebuild; 5 of 8 tuner sliders are dead on the real sky; `fillLight`'s
  lazy birth is itself a topology change. Also: every date stamped
  2026-08-10/11 in this log, PROTOCOL §3.1, and fixture 04's README was
  wrong (git: steps 1–4 all landed 2026-08-09) — corrected.
- **2026-08-09 — `shared/` landed (sequence step 2, first slice).**
  `forecast.js` and `particles.js` moved from `client/lib/` to `shared/`
  (both were already pure and dependency-free — the move retires the
  server's wrong-direction imports out of `client/lib/`). Imports updated
  in `server/server.ts`, `mcpl/agent.ts`, `client/lib/{world,sky,emitters}.js`
  (via `../../shared/…`, which resolves to repo root on disk and clamps to
  `/shared/…` in the browser), and four test tools; `/shared/` route added
  to the sequencer with client-code caching policy (no-store);
  `shared/README.md` states the doctrine. Verified: forecast 77/77,
  particles 93/93, skywatch 33/33, comptest 33/33, compfold 24/24 (against
  a `FOLD_EVERY=1` scratch sequencer per its header). Next in `shared/`:
  protocol types, then `fold.ts` (step 2b — server-side extraction first,
  fixture-tested; client adoption rides the state/realize skeleton).
- **2026-08-09 — step 4 complete: the early socket. The wire opens before
  the engine wakes.** An inline zero-import script in index.html (inline
  because a file would cost a blocking fetch on exactly the RTT it saves)
  opens the WS and sends the join the moment the HTML lands; net.js ADOPTS
  the socket at connect() only when the join it sent is byte-for-byte the
  one net would send — any mismatch (rename at the door, avatar switch,
  login flow) closes it unadopted and connects fresh. The early socket is
  an optimization, never an authority. Eligibility is the returning-
  resident path only (first-run visitors get the door; spectators/
  renderers normal path; ?earlysock=0 disables). Buffered messages drain
  in order before live delivery takes over, with the rewire synchronous
  against the final empty check so nothing slips between. **Measured
  (25mbit/40ms): connect/world at ~91ms vs ~341ms — the folded world and
  its placeholders stand 3.7× earlier**; total stays bandwidth-bound
  (unchanged), which is the honest shape: time-to-world-visible is the
  win. Verified: paritybench PASS on an open door AND a tokened door
  (JOIN_TOKEN env), reconnect leg exercising the no-stash fallback; the
  wrong-key path falls back by construction to the pre-existing 4003
  handling. §8 step 4 is done — next: step 5, the material factory +
  lighting rig (Disease A).
- **2026-08-09 — step 4, first slice: the boot path sheds its prologue and
  gains a placeholder tier.**
  - `modulepreload` for the static heavy graph (rapier excluded — dynamic);
    the 2.1MB engine starts fetching the moment HTML lands.
  - The `/avatars` top-level await — which gated the ENTIRE module graph —
    is gone. Bare names resolve server-side for everyone else's view; the
    local body path comes from a cached last-resolution (warm boots: zero
    roster requests) or a non-blocking early fetch raced against the
    snapshot's own roster (cold boots). Measured en route: making the body
    wait for the snapshot instead cost +350ms at 25mbit/40ms — the VRM's
    START time is the boot; the race keeps it as early as the old blocking
    prologue without the blocking.
  - The join snapshot now carries the avatar roster, and a `geom` message
    follows it (async bbox summaries; the join send stays synchronous — an
    awaited join would let the same client's next messages interleave,
    the exact hazard the client fold just escaped). The models realizer
    stands **placeholders** at fold time: one shared geometry + material,
    translucent boxes at the folded transform, real entities to every map
    (place moves them, mounts seat them, motion swings them) but invisible
    to camera collision, colliders, shadows, and the parity identity check.
  - World-phase progress tracks `scheduler.pending(P.FAR)` instead of
    jumping 0→1 — the bar's biggest segment finally moves with the loads.
    The curtain policy is unchanged (body + state + terrain).
  - Measured (bootbench, Edge, cold cache): localhost flat (~1.1s);
    25mbit/40ms throttled 1735ms vs 1745ms baseline with 0.8MB fewer
    bytes — cold-boot parity, with the wins living where the bench can't
    see: warm boots (cached path), placeholders, honest progress, and
    higher-RTT links. paritybench PASS incl. reconnect; foldfix 16/16.
  Still ahead in step 4: the pre-module-graph early socket (1-RTT join) —
  staged separately; it touches auth/door flows headless can't fully gate.
- **2026-08-09 — the legacy path is deleted. One fold, one writer, every
  runtime.** With tel0s's go-ahead on the spawn question (deviate from
  upstream's original view), the two holds cleared and the axe fell:
  - **S9 pinned**: PROTOCOL.md §3.1 documents overwrite semantics as a
    dated erratum (implementation wins, no dialect bump — every persisted
    log already meant this); `keep`/`collide` join the documented shapes;
    **fixture 04-overwrite** (driven through the real door) pins same-id
    replacement, cross-kind replacement both ways, and light-on-light
    partial merge. foldfix 16/16.
  - **S8 retired**: `stateToEntries` joined shared/fold.js — the browser
    and the mcpl agent both consume it, the agent's deliberate omissions
    encoded as explicit flags instead of a hand-mirrored copy. compfold
    24/24.
  - **Deleted**: `applyEntry` and its 26-case switch, `pendingOps`,
    `pendingMounts`, `applyMount`/`retryMounts`, the legacy replay branch
    in onSnapshot, `NON_GATING`, the dead `hydrating`/`entities-settled`
    signals, the `?realize` seam (realizers init unconditionally; PORTED
    lives in models.js), and `resetWorld` (zero callers; the realizers'
    reset handlers are the successor). world.js is 345 lines of registries
    + world-scope builders, down from ~670. paritybench is single-pass —
    what keeps it honest now is the reconnect leg, the mount-pose bucket,
    the refusal gate, and the server-fold witness, not a second
    implementation. AGENTS.md house rule 1 rewritten: the fold is
    SINGULAR.
  - Verified on the deleted tree: comptest 33/33 · compfold 24/24 ·
    permtest unchanged · state 24/24 · scheduler 9/9 · models-field 12/12
    · foldfix 16/16 · paritybench PASS (all three reads). §11.5's table is
    fully checked off except the compile-holds row, which was always
    step 5's (material factory).
- **2026-08-09 — 3c review round: deletion held, gate upgraded, blockers
  fixed.** The adversarial Opus review returned 3 blockers + 9 should-fixes
  (and a long checked-and-clean list confirming the core: the gen guard,
  the pendingOps-retirement trick, boot gating, backlog ordering, comp
  re-emission idempotence, `?realize=0` end-to-end). Landed in response:
  - **Gate first**: parity gained `parentDiffs` + `mountPoseDiffs` buckets
    and paritybench a **reconnect leg** (close the page socket, rejoin,
    re-read parity over the live scene) plus refusals-fail-the-pass. Run
    against the unfixed tree it CAUGHT B1 (1 mountPose diff after
    reconnect) — the gate is proven, not assumed.
  - **B1**: `refreshModel` no longer applies the fold's absolute pose to a
    MOUNTED child (the mount owns the transform; the dismount stamp brings
    the fold's word back). §11.4's reconcile∘reconcile=reconcile is true
    again.
  - **B2** (deliberate behavior change): under the realizers the arrival
    window is exactly `state.recentChat` (≤40 fairness-trimmed lines);
    tail says beyond it are not replayed — they are PAGEABLE, and `shown`
    now counts what was actually rendered so the "showing N of M" hint
    appears exactly when lines are elsewhere. Fits the rev-4 no-backscroll
    direction; legacy path unchanged.
  - **S2**: `logChat` dedupes by real seq — a reconnect re-render of the
    window is a no-op (synthetic/negative-seq lines exempt).
  - **S3**: deferred shadow-in re-arms off `scheduler.onIdle(P.FAR)` so the
    one-caster-per-beat drain waits for the realizer's loads, not
    loadwork's now-quiet lanes.
  - **S4**: the realizer's `reset` retires every tracked id (scene teardown,
    not just bookkeeping) — world switch without reload is safe.
  - **S5**: a `sockets` comp arriving AFTER a mount re-seats the riders
    (resolved socket is part of the linkage identity).
  - **S6** (deliberate): `applyGrantState` defaults unlisted ids to
    `builder`, matching the fold and the server — the HUD stops lying.
  - Verified: paritybench full PASS both paths × 3 reads each (mid,
    post-reconnect, post-teardown), all suites green.
  **Deletion remains held on**: S8 (mcpl agent's `stateToEntries` mirror —
  port the agent onto shared/fold + a shared stateToEntries, next slice),
  S9 (the PROTOCOL.md §3 spawn no-op-vs-overwrite contradiction — needs
  the upstream conversation before we delete the spec-conforming side),
  and a real-session soak. Deferred smaller items: S1 (spoken-say metadata
  in recentChat — needs a server fold change), S7 (tuner-preview + weather
  test), world-phase progress from `scheduler.pending()`, per-comp clone
  cost, reconnect event-storm nit.
- **2026-08-09 — 3c ports landed: environment + social realizers, causes
  dispatcher.** Terrain/grass/sky/weather/asset realize from the folded
  singletons (`realize/environment.js` — thin, because the application
  logic was EXTRACTED into world.js functions shared with the legacy
  switch: one implementation, two drivers, zero migration drift). Roles,
  behavior roster, and the arrival chat window realize from state
  (`realize/social.js` — the state/tail chat-overlap dance is simply gone:
  window from state once, live says via causes). Fold-inert verbs
  (use/punt/force, moderation narration, live say) dispatch through
  `realize/causes.js` off a `live-entry` bus event — causes are events,
  not state, and the fold deliberately shapes nothing for them. Under
  REALIZE the entire ordered replay loop in onSnapshot is skipped;
  `?realize=0` still restores the legacy path wholesale. paritybench's
  recipe now drives the owner-rank verbs (driver joins FIRST and owns the
  world — refusals had made the first green run partially vacuous, caught
  by reading the refusal lines) — PASS on both paths with terrain/grass/
  sky/rain/grant/say exercised in-browser. Deletion of the legacy path
  (applyEntry switch, stateToEntries, pendingOps/pendingMounts, the seam)
  is the next commit, gated on an Opus review of this diff.
- **2026-08-09 — 3b landed: the models realizer.** The whole flat entity-id
  namespace (`spawn/place/remove/light/comp/motion/mount/dismount`) is now
  realized FROM state when active: `realize/models_field.js` (pure planner,
  12/12 headless) + `realize/models.js` (hosted executor) + `realize/seam.js`
  (the `?realize=0` kill switch as a LEAF, so net.js consulting it creates
  no cycle). The design's one trick: every load completion re-reads current
  state, so `pendingOps`/`pendingMounts` have no successor — a mid-flight
  `place`/`remove` just changes state, and an unexecutable mount simply
  stays visible in the fold until both ends realize (`mountsTouching`).
  Loads go through the scheduler: keyed `entity:<id>`, owned, prioritized
  by live camera distance at dequeue, cancelled on remove. Compatibility:
  writes the same maps and emits the same bus events as legacy, so every
  consumer (motion, emitters, panels, terrain re-seat, remotes) is
  untouched; two fold-faithfulness upgrades — orphaned cargo lands at the
  FOLD's stamped pose, and a same-id spawn follows the fold's overwrite.
  **Spec/impl contradiction flagged**: PROTOCOL.md §3 says spawn is "no-op
  if id exists"; the reference fold overwrites. Per the spec's own rule the
  implementation wins until filed — raise with Skye/upstream. Legacy cases
  stay intact behind the seam; they die at 3c cleanup.
- **2026-08-09 — the 3b gate is green: paritybench PASS on both paths.**
  `tools/paritybench.ts` (Opus-built, verified first-hand): scratch
  sequencer + headless Edge (real WebGPU adapter, no GPU flags needed) +
  driven compfold recipe + `EW.foldParity()` read mid-sequence AND
  post-teardown (end-only reads are vacuous — the comp-rich entity is
  gone), with a spectator socket printing the server fold as witness.
  Both seam paths pass with 0 diffs in every bucket, no seq gaps, boot
  ~320–1100ms headless. The `?realize=0` pass is the true house-rule-1
  mirror; the realizer pass guards the new writer. Also fixed en route:
  the Windows "bun on PATH is an npm .cmd shim" spawn-leak (paritybench
  spawns `process.execPath`; same latent leak patched in
  `fp-snap-probe.ts`). Next: 3c — port the remaining realizers
  (terrain/sky/grass), then delete the legacy cases and their machinery
  (§11.5 table).
- **2026-08-09 — 3a landed: the skeleton's pure half + shadow mode.**
  `client/lib/state.js` (world-as-data over `shared/fold.js`; sync,
  seq-guarded, subscriber-guarded) and `client/lib/scheduler.js` (the one
  loader: keys/owners/lanes with the measured caps, band priorities
  re-read at dequeue, cancellation, `onIdle` — no timeouts), both DOM-free
  and headless-tested (`tools/state-test.ts` 19/19,
  `tools/scheduler-test.ts` 9/9). `net.js` now folds every snapshot and
  live entry into the shadow alongside the legacy path — adopting today's
  live-folded server state without double-folding the overlap tail — and
  `EW.foldParity()` (`client/lib/parity.js`) prints drift between the
  shared fold and legacy `applyEntry` on demand: ids, comp bags, mounts.
  Nothing consumes the shadow yet; 3b (models realizer) is next. Full
  suite re-verified: foldfix 12/12 · comptest 33/33.
- **2026-08-09 — the fold moved to `shared/fold.js`** (sequence step 2,
  second slice): `foldEntry`, `emptyState`, `trimRecentChat`, `ROLE_RANK`,
  and the `LogEntry`/`WorldState` shapes (as JSDoc typedefs — no-build
  doctrine) extracted verbatim from `server/server.ts`, comments included;
  the server imports them back. The extraction is pinned by a new
  conformance runner, `tools/foldfix-test.ts`, which folds
  `spec/fixtures/*/log.jsonl` with the shared fold and applies the spec's
  own comparison rule — the runner PROTOCOL.md §11 promised but nothing
  implemented. Verified: foldfix 12/12 · comptest 33/33 · compfold 24/24 ·
  permtest unchanged vs baseline. House rule 1 in AGENTS.md updated: the
  server side of the mirror is retired; the client's `applyEntry` adopts
  the shared fold with the state/realize skeleton (step 3).
- **2026-08-09 — landmines 1 and 2 fixed** (`sendAnim` import; house rule 3
  guards on `open`/`close` and the module-level intervals). Both pushed.
- **2026-08-09 — incident ledger landed** (sequence step 1):
  `docs/INCIDENTS.md`, 475 entries across 11 subsystem sections — every
  measured-incident comment in the tree, numbers verbatim, plus the
  AGENTS.md house rules with attributions and the cited commit hashes.
  The harvest also surfaced **active landmines** (constraints current code
  violates), verified where marked ✓:
  1. ✓ `sendAnim` called but never imported (`main.js:621` vs the net.js
     import at `:28`; exported at `net.js:51`) — the bus swallows the
     ReferenceError, so a puppeted animation plays locally and never
     relays. One-line fix.
  2. ✓ House rule 3 ("no handler may throw out of Bun.serve") guards only
     `message` — `open`/`close` and the two module-level `setInterval`s
     are unguarded, and `close` reaches `appendFileSync`/rename. An
     EIO/ENOSPC there is exactly the 4f82250 crash-loop failure.
  3. The light budget is worse than §2 stated: lamps don't consult placed
     lights' count, so 4 placed + 2 lamps = 6 casters — past the
     measured-fatal count — before `keep` is even considered.
  4. `loadwork.js`'s header promises one-at-a-time materialization; the
     lanes are `max: 2`. Header lies.
  5. `sky_baked.js:340` uses the two-arg `bakeEnv` form that `sky.js:468`
     documents as a bug (different receiver — reconcile, may be benign).
  Items 6–10 of the landmine report (hot-path raycast/allocs, one-way
  ratchets, uncached VRM parse, unserialized log applies, dead signals)
  are already §2 findings. Fixes for 1 and 2 proposed as immediate,
  separate commits — they are live bugs, not rebuild work.

## 11. The skeleton, sketched — step 3 reference design

Written 2026-08-09, before implementation, so the interfaces exist on paper
for review and posterity. This is the concrete form of §3's principle.

### 11.1 Module inventory

```
shared/fold.js            the fold (landed — step 2)
client/lib/state.js       folded WorldState + change events   (3a, pure)
client/lib/scheduler.js   the one loader                      (3a, pure)
client/lib/realize/*.js   registered projections of state     (3b+)
client/lib/systems.js     the frame loop's explicit list      (step 6)
```

`state.js` and `scheduler.js` are DOM-free and THREE-free on purpose — the
`_field.js` discipline — so both are headless-testable (`tools/state-test.ts`,
`tools/scheduler-test.ts`).

### 11.2 state.js — the world as data

```js
import { foldEntry, emptyState } from '../../shared/fold.js';

state.st        // WorldState (shared/fold.js typedef) — THE world, as data
state.lastSeq   // highest folded seq

hydrate(snapshotState, tail)  // adopt server state wholesale (it IS
                              // WorldState-shaped), fold the tail, emit
                              // {type:'hydrated'} — milliseconds, sync
foldLive(entry)               // foldEntry + emit {type:'entry', entry} — sync
reset()                       // world switch/fork → emptyState + {type:'reset'}
onWorldChange(fn) → off       // subscribe; events carry the entry, state is
                              // read from state.st (events are invalidation
                              // signals, not data carriers)
```

Invariants:
- **Folding is synchronous and in seq order.** The net layer feeds entries
  one at a time; `foldLive` warns on seq regression and drops duplicates.
  This kills the async-onmessage interleave (§2, hazard 15) at the source:
  only *realization* is async, and it reads consistent state.
- `state.st` is a pure function of (snapshot, entries) — the same contract
  the server's fold has, because it IS the server's fold.
- Nothing in `state.js` touches the scene, the DOM, or THREE.

Event vocabulary starts minimal (`hydrated | reset | entry`); realizer-
facing refinement (per-facet interests) is added at 3b with its first
consumer, not speculated now.

### 11.3 scheduler.js — the one loader

```js
schedule({ key,               // dedupe identity ('glb:deco/crate.glb')
           owner,             // cancellation scope ('entity:crate1')
           lane,              // 'net' (6) | 'cpu' (2) | 'gpu' (2) — the
                              // measured caps from loadwork/assets carry over
           priority,          // number | () => number, re-evaluated at
                              // dequeue (distance to camera moves)
           run(signal) })     // does the work; honours AbortSignal
  → { cancel(), done }        // done: Promise
cancelOwner(owner)            // entity removed / superseded / world switch
pending(minPriority?)         // outstanding count at or above a band
onIdle(fn, minPriority?)      // curtain + progress read THESE, not timeouts
```

Priority bands (constants, not magic numbers): `BODY_SELF > BODY > NEAR >
VISIBLE > FAR > COSMETIC`. FIFO within a band. Dedupe by `key`: scheduling
an already-queued key keeps one job at the higher priority.

Invariants:
- **No timeouts anywhere.** Readiness is observed (queue drain per band),
  never assumed. The 12s/25s/4s/30s/45s escape-hatch stack (§2) has no
  successor in this design.
- Runtime-agnostic pumping (microtask on schedule/completion), so Bun tests
  drive it without a renderer. Budget slicing stays inside jobs (loadwork's
  `tick()` mechanics survive as the work-record layer, which the scheduler
  does not replace — only the lanes).
- During migration the old `loadwork.enqueue` delegates into the scheduler;
  `holdObjectCompiles`/`holdFrames` stay until the material factory (step 5)
  removes their reason.

### 11.4 The realizer contract (3b+)

```js
makeModelsRealizer(ctx) → {
  name: 'models',
  interests: ['spawn','place','remove','comp','mount','dismount'],
  reconcile(st),      // full idempotent pass — hydration, world switch,
                      // late enable. Placeholders from snapshot bboxes
                      // appear HERE, at fold time, before any bytes.
  onChange(st, ev),   // one fold event — schedule loads/updates via the
                      // scheduler, keyed and owned for cancellation
  dispose(),
}
```

- A realizer owns its scene objects (keyed by entity id) and its scheduler
  jobs (owner = `entity:<id>`), and touches no other realizer's.
- `reconcile ∘ reconcile = reconcile` — idempotence is the contract that
  makes join and live the same path, one level above `stateToEntries`.
- The entity-object registry stays compatible during migration: the models
  realizer writes the same `world.js` `entities` Map existing consumers
  read; the Map's ownership moves, its shape doesn't.

Port order (each lands green, world bootable): **models** → lights (the
rig's data side, ahead of step 5) → terrain → sky → grass/flora → emitters
→ motion (stays a frame system, reading comps from `state.st`).

### 11.5 What dies, and when

| Machinery | Dies at |
|---|---|
| `stateToEntries` + synthetic negative-seq replay | models realizer (3b) |
| `pendingOps` / `pendingMounts` ordering reconstruction | 3b (fold is sync; realizers read state) |
| serial `await applyEntry` replay loop + `NON_GATING` | 3b–3c as cases port |
| `whenBooted()` gating of sky/grass/prefetch | 3c (ordinary low-priority jobs) |
| `holdObjectCompiles` / `holdFrames` + their timeout caps | step 5 (material factory) |
| dead `hydrating`/`entities-settled` signals | replaced by scheduler band events (3a) |

### 11.6 Migration safety: shadow mode (3a)

3a wires `state.js` into `net.js` *alongside* the existing path: every
snapshot hydrates it, every live entry folds into it, and nothing consumes
it yet. A dev parity probe (debug surface) compares shadow state against
the legacy maps — entity ids, transforms, comp bags — so drift between the
shared fold and `applyEntry` is *measured for free* during the whole
migration window, before any behavior moves. House rule 1's remaining
mirror becomes an assertion instead of a hope.

## 12. Materials and light, grounded — step 5 reference design

Three extraction passes (2026-08-09) pinned the facts this design binds to:
upstream's wrap mechanics (`weather_system.js`/`sky_system.js`, read at
line level), the vendored three build's invalidation rules (r184,
unminified), and the full client map (material birth sites, governor,
shadow machinery, hold callers).

### 12.1 The rules of the game (three.webgpu r184, verified)

A render object's pipeline key has two halves. **Material half** (re-read
only on `material.needsUpdate`): the node graph *by node identity*, every
material property (numbers collapsed to on/off), `object.receiveShadow`,
geometry/morph/skeleton/instancing shape. **Dynamic half** (checked every
draw): the lights hash, env node, fog node, `shadowMap.enabled`/`.type`,
`receiveShadow` again. The lights hash is **per-light `(id, castShadow)`
in scene-traversal order** — identity and order, not count.

Uniform-level (never in any key, safe to animate): light `intensity`
(**no intensity-0 culling exists** — zero is the supported "off"),
`color`, `position`, `distance` (even through 0), `decay`; shadow
`mapSize` (realloc, no recompile) / `bias` / camera extents (call
`updateProjectionMatrix()` ourselves — three won't); env texture
*content*; fog color/density; `toneMappingExposure`.

Shape-level (frozen at boot or pay a full-scene recompile): the light
set, order, and each light's `castShadow`; `light.visible` (**culls it
from the hash — never use**); `shadowMap.enabled`/`.type`; `scene.fog`
object identity; `scene.environment` identity; tone mapping crossing
`NoToneMapping`; post-processing. `object.castShadow` is in **no key** —
a free runtime toggle (shadow-pass render-list membership only), while
`object.receiveShadow` is in **both** — set at creation, never toggle.
Node reassignment without `material.needsUpdate = true` is silently
ignored.

### 12.2 Upstream wrap truth

- **Wetness** (`weather_system`): `wrapMaterial(mat, mesh)` is exported —
  factory-form exists. The sweep's skip registry is closure-private, but
  `mesh.userData.noWet` skips it cleanly. The wrap's dependencies are
  three shared uniforms + built-in TSL + two pure noise fns, **no
  textures** — a shape-identical client-side build is feasible before the
  weather modules exist. `mat.userData.noPuddles` is a compile-time gate
  the port must reproduce.
- **Cloud shadow** (`sky_system`): sweep-only (no per-material entry);
  `mesh.userData.noCloudShadow` skips cleanly; the graph is a 16-tap
  march over textures generated inside `makeSkySystem` — **not** stubbable
  shape-identically ahead of it.
- After either wrap lands, every weather/cloud/TOD change is uniform-only.
  The disease was only ever *when* the wrap lands.
- `makeWeatherSystem` permanently `scene.add`s one lightning PointLight at
  construction (upstream already treats it as a slot: "a strike changes
  uniform data only"). Identity-keyed hashing means no swap trick absorbs
  it — it needs the adapter seam below.

### 12.3 `materials.js` — the factory

One seam, `prepare(root)` / `prepareMaterial(mat, opts)`, applied at every
material birth site (GLB/VRM parse, terrain, flora, placeholders, gizmos,
domes) **before first compile**. Lit node materials get the wrap stack;
unlit get markers and `receiveShadow` policy only. The factory also owns
the clone paths (`ghostify`, the light-placement ghost) so clones stay
prepared.

The wrap stack is client-owned and uniform-gated, applied once at birth:

1. **Wetness** — a shape-identical port of upstream's wrap (same node
   structure, same `noPuddles` gate), driven by factory-global uniforms.
2. **Cloud shade** — our *own* cheap field: a client-generated noise
   DataTexture (born at boot, identity stable), fixed tap count,
   wind-scrolled, `coverage`/`strength` uniforms, strength 0 ≡ gain 1.0.
   Deliberately not Skye's march: hers is already a cheap approximation
   of the dome, and ground shadows need to *read* as clouds, not match it
   tap-for-tap.
3. **`receiveShadow` set at birth** — terrain finally receives (today only
   the hidden stage floor does); placeholders and gizmos stay off.

Every prepared mesh gets `noWet` + `noCloudShadow`, so upstream's sweeps
find nothing to do. `wrapScene()` still runs for unprepared materials
(the 🧩 mods escape hatch degrades exactly as today). The uniforms are
driven from **folded state**, not upstream internals: `effectiveSky` →
weather name + k → wet/coverage targets via a small table; sun direction
from our own sun light. Wet ground in rain stops requiring Skye's modules
at all — it works identically under the skymesh fallback.

### 12.4 `lightrig.js` — the rig

Fixed inventory born before first compile, one Group, one order, never
added/removed/reparented/visible-toggled after: **sun** (the one shadow
caster), **hemi**, **fill** (no longer lazily created — its lazy birth
today is itself a topology change), **N point slots** (start 8; the
ceiling is measured in 5g, not assumed — the old "grass + 4 hung" number
was runtime-recompile churn, and that compile now happens once at boot
behind the splash). Idle slot = intensity 0.

Everything else becomes a **light request**, not a light: placed `light`
entities (from folded state), emissive lamps (inferred at model realize —
the material is the declaration, as today), and adopted toolkit lights.
Assignment is deterministic in (state, camera): keep-authored > authored >
inferred, ties by camera distance, with hysteresis so boundary churn
doesn't flicker; churn is uniform writes. Two clients in one spot light
the same way. The rig computes dayness and dims day-aware requests (lamps
by default; placed lights too, with a verb-arg opt-out for the deliberate
noon porch light — documented with `keep` in 5f).

**The bolt seam**: intercept the `makeWeatherSystem` global (the same
`defineProperty` seam sky.js uses for `makeSkySystem`) and hand it a
stable per-scene Proxy whose `add`/`remove` swallows lights into an
adoption list; the rig mirrors an adopted light's pos/color/intensity/
distance into a reserved slot per frame. Even one rendered frame with a
foreign light in the scene is a full recompile storm, which is why the
swallow must happen at `add`, not after construction. The seam deletes
the day upstream grows a `strikeLight` injection (ask recorded).

`lights.js` keeps the gizmo + inspector editor and loses the budget
(`MAX_CAST`, `grantCast`, `shedALight`); `sky.js` loses `lampLights`,
`MAX_LAMPS`, and `attachLocalLights`' boot deferral (nothing left to
defer). The `lights.js → sky.js` import edge — the one non-core cycle in
the module graph — dies with them.

### 12.5 Sun shadow

The frustum follows the camera: re-centre the ortho box each frame
(uniform + our own `updateProjectionMatrix()`), keeping the ±46 extent
initially; CSM later. Today's box is pinned to the *origin* — shadows
stop existing 46 units from spawn. Casters: `castShadow` toggles are
free, so the rig budgets the caster set by camera distance per frame
(top-K, K a governor lever) — `markShadowless`/`drainShadows`, the
250ms drip, the `lanes-idle` coupling, and the 30s fallback all die.
Bodies can finally cast (measure, then retire the blob). `mapSize`
becomes a two-way lever.

### 12.6 Governor, two-way

One controller, session-scoped, **no localStorage writes ever** (today
the cloud lever persists a degradation across sessions and answers
slowness with a full sky rebuild — the most expensive possible response).
Levers, each with degrade *and* recover: pixel ratio (already two-way),
caster budget K, active-slot cap (compiled cost of N is paid at boot;
capping is pure GPU relief), emitter tier, grass density, shadow mapSize,
LOD bias (already two-way), and cloud tier **last, baked-tiers only**
(re-bake, never rebuild; the live-march 'high' tier is a user choice the
governor never touches). Tuner sliders work or die: `hours`/`rate`/
`exposure` already work; `fog` gets rewired to density (upstream only
writes fog *color* — density is ours on both paths); `sun`/`ambient`
become post-`update()` multipliers the rig applies after
`applyToLights`; `azimuth`/`fill` die honestly on the real-sky path.

### 12.7 What dies at step 5

`holdObjectCompiles` + its 25s cap + the `objectsHeld` coupling inside
`checkIdle`; `holdFrames`/`framesHeld` + the settle beat; the whole-scene
`compileAsync` per light grant; `markShadowless`/`drainShadows` + the 30s
fallback; `MAX_CAST`/`MAX_LAMPS`/`shedALight`; the lazy `fillLight`; the
localStorage cloud ratchet. `whenBooted` survives only as a *bandwidth*
yield (sky prime, prefetch) — it no longer orders compiles. The
`compiledLibs` cache's caveat comment ("a wrap or a new light can
invalidate") becomes false and is deleted: compiled once is compiled.

### 12.8 Order of work, and what 5g must measure

5a factory → 5b rig + bolt seam → 5c shadow follow + caster budget →
5d governor + tuner → 5e delete the holds → 5f spec (`keep`, day-dim
opt-out, fixture) → 5g measure. Each lands green behind paritybench.
5g measures: the slot ceiling with grass at N = 4/8/12/16 (boot-time
compile + per-fragment loop cost — the loop is real even at intensity 0);
MToon under the ported wetness wrap (today's sweep already wraps MToon —
parity, not regression); the Proxy seam against `weatherRegistry`'s
WeakMap identity (one stable proxy per scene); bootbench before/after
(the settle beat should vanish). Upstream asks to record alongside
`docs/upstream-wrap-once.md`: `strikeLight` injection, a per-material
cloud-shadow wrap entry, and blessing `noWet`/`noCloudShadow` as
supported markers.

## 13. Streamed residency and the meadow's draw bill — step 5½ reference design

Two extraction passes (2026-08-09) ground this: the vegetation toolkit's
instancing internals, and the client's full asset-ownership/disposal graph.

### 13.1 The binding facts

**Vegetation** (`vegetation.js`): one InstancedMesh per stroke; every
per-instance transform lives in three custom attributes (`aPosRot` xyz+yaw,
`aScaleVar`, `aPhase` incl. tilt) applied in `positionNode` — **the
instanceMatrix is all identity**, which is why upstream ships
`frustumCulled = false`: three would cull against a meaningless half-meter
sphere at the origin and vanish the field. Wind is ONE uniform (vertex
stage, gust texture sampled in-shader); the per-frame hook writes one
float; **all grass cost is GPU fill** (alpha-tested opaque cutout,
DoubleSide, the client's measured "318k blades is the frame budget on
Safari"). The node graph binds attributes by NAME and holds no mesh
reference; the clearing mask wires the MATERIAL; heights are baked at
build time into `aPosRot.y`. The client's `wireDensityDial` already
Fisher-Yates-shuffles the instance arrays (seeded), which is what makes a
`count` prefix a uniform density dial — and makes stable-order tile
bucketing compose with it for free. Grass material is `MeshSSSNodeMaterial`
(PBR duck yes) — so today it takes the FULL factory wrap including puddles
(and blade normals are forced straight up, which sails through the
puddle flatness gate: rain paints puddles ON BLADES), and upstream sets
`receiveShadow = true`, which the factory never clears (its "grass stays
a non-receiver" comment described intent, not behavior).

**Residency** (client audit): `loadGLB` clones share geometry, materials,
textures, pipelines with the cached prototype — a per-entity dispose may
touch NONE of it; dropping a clone frees scene-graph, matrices,
camera-collision triangles, collider BVH heap, and ~zero VRAM. All GPU
bytes are pinned by `glbCache` (never evicted, no refcount), and three
r184 holds STRONG maps of every geometry (`_geometryDisposeListeners`)
and texture/attribute (`Info.memoryMap`) ever uploaded — GC alone frees
nothing; only explicit `dispose()` reaches `GPUBuffer.destroy`. Real
weights: median optimized model ~350KB wire but ~22MB resident (4x1024²
texture sets + mips); `byteCache` holds a 29.5MB VRM forever after one
look; `denoFiles` keeps a second full copy of every toolkit asset;
`vrmaCache` ~14-20MB. `renderer.info.memory` is real byte accounting and
nothing reads it. Found leak: `setTerrain` removes the old terrain and
never disposes it. `retire()` is a correct scene-graph retire with zero
GPU deallocation (right, given sharing). Scheduler dedupe/cancel is
promote-churn-ready (one gap: `loadGLB` takes no AbortSignal — an
in-flight load runs to completion and warms the cache, which is fine).
The three demote-impossibles: carriers with mounted cargo, part-socket
mounts (`findPart` on a placeholder is null; `mbase` is per-clone),
live physobj sims. `parity.js`'s parent/mount-pose buckets need a
placeholder exemption or a demoted child reads as false drift.

### 13.2 Grass, in two moves

**G1 — the free wins (no tiling):**
- Per-stroke WORLD bounding sphere assigned by the adapter (computable
  from `aPosRot` min/max + height×maxScale + 0.6m lean slack; the group
  sits at the scene root with identity transform) + `frustumCulled =
  true`. Looking away stops drawing the whole field. Assign explicitly —
  never let `computeBoundingSphere` run (it reads the identity matrices).
- `kind: 'grass'` in the factory sets `receiveShadow = false` explicitly
  (else-branch, not absence) — no more per-fragment shadow taps on the
  scene's biggest fill surface.
- `mat.userData.noPuddles = true` before the wrap — the ported
  compile-time gate zeroes the puddle branch. Wet sheen darkening and
  cloud shade STAY (rain-dark meadows and cloud shadows crossing grass
  are the money shots); puddles-on-blades and the metalness rewrite go.

**G2 — tiling:** after `wireDensityDial` + `mask.wire`, before
`prepareObject`/compile: bucket instances by XZ tile (STABLE order, so
each tile's order stays a uniform random permutation → per-tile `count`
is a uniform thinner). K geometries share the vertex/index/`aH` attribute
OBJECTS (uploaded once — the backend keys buffers on the attribute
object) and carry sliced copies of only the three instanced attributes
(~44B/instance); K meshes share ONE material (mask/wind/factory wrap all
material- or name-bound); per-tile spheres, `frustumCulled = true`.
Distance density rides per-tile `count` (near full → far thinned → beyond
R invisible) on a throttled tick. Tile only blade-grass/corn strokes
above ~2k instances (shrubs are hundreds; their stem mesh is a child
sharing backing arrays — pair or skip). Integration seams (from
extraction): replace `field.setDensity` with the per-tile fan-out; keep
the #74 applied-truth working (`strokeApplied` reads `mesh.count` — give
the container a summing getter or keep per-stroke reporting); wrap
`field.dispose` to free tile geometries; copy the `userData.no*` flags +
`castShadow=false`/`receiveShadow` onto every tile; keep K modest (~8×8
on a big stand — one pipeline, K draw calls, culling wins dominate).
Pre-existing, noted not fixed: shrub wood shares the leaf's pre-mask
positionNode → clearings never sank wood.

### 13.3 Residency, in three tiers

**R1 — de-realization (CPU/frame relief).** Demotion is the fold→state→
realize doctrine read backwards: state never changes, the PROJECTION
coarsens. A far entity swaps back to the placeholder tier (already legal
everywhere), its loads cancel by owner, lamps/casters release, collider
drops (beyond interaction range by construction; the clearing mask
repaints on entity events at promote). Promote IS `createModel` — the
existing pipeline re-reads state, re-executes mounts, re-announces comp
bags (emitters re-attach off those events). Sweep: models.js, ~500ms,
distances from FOLDED positions (works for placeholders too), hysteresis
promote below R_in / demote above R_out, radius scaled by bbox diagonal
(a mountain never demotes at 90m). REFUSE to demote: carriers with
cargo, part-socket mounts, live physobj sims, the selected/dragged
entity. `kind: 'demote'` on the entity bus; emitters retire their handle
on it; parity.js exempts placeholders from parent/mount-pose buckets.
Also in this slice: the `setTerrain` disposal leak fix.

**R2 — proto eviction (the actual VRAM).** Refcount libs
(`loadGLB`/release on retire+demote); at zero refs, under
`onIdle(P.NEAR)` and over a `renderer.info.memory.total` budget: traverse
the proto, dispose unique geometries/materials/textures (copy
`retireField`'s discipline — the one teardown that gets ownership right),
delete `glbCache` + `compiledLibs` entries. `byteCache` keeps the
compressed bytes (prefetch already made the wire cost a disk read —
re-promote is a parse, not a download; that assumption is load-bearing).
NEVER dispose per-entity: shared with every clone, and material.dispose
releases pipeline refcounts scene-wide.

**R3 — the byte tier.** LRU byte budget on `byteCache` (pure JS heap, no
GPU coupling, tens of MB reclaimed risk-free); `denoFiles` stays (sync
read contract) but its byteCache twins are LRU-evictable.

Out of scope, flagged: a VRM prototype cache (the "24-body room" miss) —
because `avatar.dispose()` deepDisposes today, safe ONLY while bodies
re-parse; the day a proto cache lands that becomes a cross-body
texture-blanking bug. Bodies are presence with their own lifecycle;
separate slice.

**Governor + debug:** residency radius and grass distance-R become
two-way levers; `EW.residency()`, `EW.gpu()` (= renderer.info.memory —
finally read), grass tile stats on the debug surface. Gates: paritybench
(small worlds — nothing demotes; the parity exemption still verified),
lightbench extension (spawn far → placeholder; move EW.camera → promote;
eviction drops info.memory), and a grass tile check (tile count, culled
draws, blades-drawn ≈ eff × count).

### 13.4 Order of work

G1 (free wins) → R1 + terrain-leak fix → G2 (tiling + distance density)
→ R2 + R3 (eviction + byte LRU) → probes + adversarial review → §10.

## 14. Step 6 reference design — the trench coat comes off

Grounded by the main.js structure map (2026-08-09; extraction agent, line
ranges verified). main.js is 1164 lines; 142-1164 is one else-block (the
?mintthumbs branch), gated behind a top-level await initIdentity() at 192.

### 14.1 Binding facts
- Frame loop (1058-1120): 20 steps, exact order + documented constraints:
  motion before remotes (mounted derive); sky -> materials -> rig (sun
  position); voice-mouths before avatar update; bodydrag before remotes;
  gaze after remotes; sendPose after every myState writer; exactly one of
  the five me-drives per frame; governor+HUD at 1Hz post-render.
- Hot paths confirmed: camera collision = 3 Vector3 allocs + fresh
  liveEntities array + recursive intersectObjects over every mesh
  (controller.js:378-392) while colliders.js has OBBs + BVHs + an 8m grid;
  physobj = O(sims x ALL colliders) + alloc in inner loop (137-149),
  IGNORES rotation/scale (latent); rapierdoll:342 same with manual 8m
  filter; gaze O(n^2)/frame at conversational rate; ungated: tickMotion
  (every comp bag every frame), autoParticleSystems hooks, flora pusher
  hook (2 arrays + sort every frame), seat-hint full comps x sockets scan.
- Grid today: CELL=8, 2D, string keys, generator near() fixed 3x3 (radius
  capped ~8m), entries {obj|duck, local Box3 + yaw = OBB, pillar, exact
  BVH, interior, lie}. findSeat/surfaceUnder/physobj/rapierdoll DON'T use
  it. fitSupportBox duck (headless agents) must survive promotion.
- Dissolution risks: `me` closed over by ~18 sites -> lib/mybody.js
  ({get me, setMe} + avatar-path state, imports core only); commands
  cycle chat->registry->net->chat -> split registry.js (pure table,
  imports NOTHING, chat imports only it) from handler modules registered
  at boot; kick/push disambiguators need ordered fallthrough; fps ->
  lib/perf.js leaf; BC -> lib/bc.js (imports net only; avatar reads the
  global); boot.js (splash) stays a leaf — the SEQUENCE stays in main.js,
  which shrinks to ~120 lines of boot; mint.js dynamically imported kills
  the else-block; loop start becomes explicit startFrame() (today rAF
  waits on the identity RTT — keep that ordering deliberately).
- Found bugs to fix en route: /rename emitted by chat.js:514, no
  subscriber (dead command); avatar-updated handler throws on null
  myAvatarPath (main.js:304, cold cache); duplicate /kick autocomplete
  row (chat.js:406/411); duplicate bodydrag import (main.js:46/51).

### 14.2 The slices
- **6a spatial service** (perf first): variable-radius near(x,z,r) with
  interned integer keys + zero-alloc iteration; raySegment(origin,dir,far)
  -> nearest {t,id} (2D DDA over cells, OBB slab test, BVH raycastFirst
  only for exact entries, per-entry noCamCollide hoisted) replacing the
  camera raycast at its three call sites' shared core; physobj +
  rapierdoll + findSeat + surfaceUnder onto near(); gaze throttled to
  250ms + speaker epoch (rate fix, not index — n is room-scale); distance
  gates: tickMotion skips entities beyond ~90m (closed-form motion
  catches up exactly on re-entry), flora pusher hook reuses arrays;
  ragdoll body-level cell cache (one query, 19 joints).
- **6b frame.js**: registerSystem({name, tick, enabled, every}) honoring
  the documented order constraints; per-system rolling ms exposed
  (EW.frame()); governor gains system strides as levers; perf.js owns
  fps; hud.js owns paintHud; bc.js extracted; explicit startFrame().
- **6c dissolution**: mint.js (dynamic import, kills the else); mybody.js
  (me + avatar-path + swap + avatar-updated guard); localbody.js
  (ragdoll/mounts+seats/pins/dragged/shove/puppet/force — logChat via
  bus or init hook, NOT import, until the chat knot is cut);
  consent.js (zero-dep); voicemouths.js (mouths + caption/speech merge);
  commands/registry.js + handlers (fix /rename, kill the dup /kick row,
  preserve kick/push fallthrough order); main.js = the boot sequence.
Gates per slice: paritybench + lightbench; 6a additionally an A/B frame
probe (camera-collision cost) if measurable headless.

## 15. Step 7 reference design — the server split

Grounded by the server.ts structure map (2026-08-09; 2,630 lines — §2's
"2,896 / verb switch at :255" was stale, the fold moved to shared/ in
step 2). Binding facts:

### 15.1 What the map pinned
- Verb dispatch today = VERB_NEEDS rank table + 8 inline validator blocks
  + a common preamble (world/spectator/rate/allow-list/rank/lock, with
  exact error prose six suites assert on) + append→broadcast + SIX
  post-append hooks: bhv.onEntry (unconditional), reactToUse (use),
  bhv.sync (behavior), lintMotion (motion|comp:motion), lintParticles
  (comp:particles), the expel loop (ban|kick).
- Ordering invariant at all six append sites: **seq assigned →
  appendFileSync → foldEntry → threshold fold → broadcast**. seq comes
  from snapSeq+entries.length+1 in append() and NOWHERE else. fold()
  writes bytes=logBytes, so logBytes must equal the real file size when
  fold runs — the async-append design's one hard constraint: keep (seq,
  entries.push, foldEntry) synchronous; defer only the byte write;
  flush must be awaited by fold/fork/reset/readHistory-file-leg/shutdown.
  No fsync anywhere today (page-cache durability — be honest about it).
- Wire contract = API: close codes 4002-4006, {type:"error"} prose
  substrings, the snapshot field set, present[].pose = settledPose
  (pinned by SOURCE-TEXT regex), geom as a separate post-join message
  (join stays synchronous), lease message shapes, whisperKey's NUL separator (a raw \x00 byte once lived HERE and made this whole file invisible to grep - the build.js:1089 footgun's sibling).
- **Source-text gates**: settled-pose-test, whisper-disable-test,
  voice-wiring-test regex server.ts ITSELF — so settledPose + the
  whisper/rtc/typing cases STAY in server.ts; the split extracts around
  them. (Cheaper than re-pointing three suites; revisit later.)
- behaviors.ts's WorldLike + wireBehaviorGate/Store is the proven DI
  seam — the World facade must keep that surface.
- Cycle breaks: rightsOf/worldHasOwner/lockRefusal narrow to
  (state, …) not (World, …); expel lives with the session (moderation
  owns only ban DATA); after-hooks get a ctx {log, state, session,
  recorder, rights} instead of importing World; getWorld's forward
  reference must stay a function declaration (hoisting is load-bearing).
- Fix en route: bodydrag okSim destructure bug (validates sim.v, never
  sim.q — real); dead trimRecentChat import; resolveLibFile duplicate;
  lastPose typed unknown but dereferenced; (c as any).bcRing undeclared.

### 15.2 The modules
config.ts (env + dirs + cadences) · auth.ts (HN sessions, jti,
sessionFromCookie, agentTokens, .sessions.json) · moderation.ts (ban
DATA: BanRec, globalBans, findBan, save/restore) · rights.ts
(VERB_NEEDS, rightsOf(state,…), worldHasOwner, lockRefusal,
LOCK_GUARDED, isAdminId) · lint.ts (MOTION_TYPES, lintMotion,
lintParticles, one resolveLibFile) · reactions.ts (reactToUse,
pendulumImpulse — the house-rule-2 mirror comment travels) · verbs.ts
(THE TABLE: {rank, gen?, selfRankZero?, validate?(ctx,args),
after?(ctx,entry)} + the shell; after-hooks dispatch synchronously
inside message's try/catch, exactly as today) · world.ts (World →
WorldLog [entries/snapSeq/logBytes/append/fold/readHistory/reset +
state, since the fold is the log's projection] + WorldSession
[clients/dirty/leases/frameSeq/recPath/broadcast/settleLease — session
depends on log, one-way] + the debug recorder; World stays a thin
facade honoring WorldLike so behaviors.ts never changes) · routes.ts
(the fetch table + serveFrom/contentType/gzCache) · upload.ts
(/upload + optQueue/pumpOptimize, per §7). The ws switch STAYS in
server.ts (source-text gates + it shrinks to a session-relay list once
join internals and the verb case delegate).

### 15.3 Slices and gates
- **7-prep: tools/servergate.ts** — one runner that boots a scratch
  sequencer per tool with its exact env header (permtest 8991,
  modtest 8992+WORLD_ADMIN, comptest 8993, locktest 8994, compfold
  8995+FOLD_EVERY=1, leasetest 8997, behaviortest 8994+BHV_TIMER_MIN=1,
  worldops 8992) plus the self-booting suites (smoke, authtest,
  support-lifecycle), sequentially, kill-by-child-handle, PASS/FAIL
  table. Baseline it GREEN on the unsplit server first.
- **7a**: extract auth/moderation/rights/lint/reactions (+config) with
  the narrowed signatures; server.ts imports back. Pure motion.
- **7b**: verbs.ts — the table + shell replace the verb case and the
  six hooks. Error prose byte-identical (suites assert substrings).
- **7c**: World → Log/Session decomposition behind the facade +
  routes.ts/upload.ts table.
- **7d** (own slice, most careful): batched appends per §15.1's
  constraint + explicit flush points; loadtest + full battery.
Every slice: servergate + paritybench (client against split server).

## 16. The rough first minute — step 8 reference design (the smooth arrival)

The foundation is laid; this is the first optimization pass on top of it.
The complaint (tel0s, 2026-08-10): loading is fast on a good connection,
but the frame rate is rough for the first while — especially when grass
loads — before settling at 120fps. Measured, mapped, and designed here.

### 16.1 Ground truth (bootjank + perflogs + two extractions, 2026-08-10)

`tools/bootjank.ts` (new) replays a byte-copy of worlds/commons in a
scratch sequencer and records every frame from document start, with
document-start hooks on createRenderPipeline/createShaderModule/
writeBuffer/writeTexture/copyExternalImageToTexture, longtask spans, and
resource timings. Headless Edge run: **rough 0→8.4s, then flat 120fps**
(p50 8.3ms). 22 frames over 25ms; worst 641ms (t=2.7s) and 1166ms
(t=8.4s) — both frames with almost no JS in them, arriving right after
pipeline-creation bursts. 56 pipelines / 122 shader modules total, all
in the first 8s. Real-session corroboration in worlds/.perflogs.jsonl
(Firefox 153, the live commons): `build grass 3000/6077/6487ms` with
six-seven ~230-250ms solo-grass frame gaps each, session fps 86.

The mechanisms, in causal order:

**(a) compileAsync is frame-quantised and multiplied by render-object
count.** Three's compileAsync awaits `yieldToMain()` ~10× per render
object (NodeBuilder yields after every build stage × shader stage, plus
the per-object loop: three.webgpu.js:52670-52702, 58758-58790).
`yieldToMain` = `scheduler.yield()` where available, else
**requestAnimationFrame** (three.core.js:2074-2088). On Firefox that is
~10 full frames per render object; the mojave field is **68 render
objects** (57 tiles + 6 leaf + 5 stem) → ~680 frames ≈ the measured
6s "build grass". On Chrome/Edge scheduler.yield makes it a same-turn
continuation storm instead — faster wall clock, but it starves rAF
while it runs. Either way the cost scales with OBJECT COUNT, and the
tiler multiplied 7 strokes into 68 objects.

**(b) The mojave tiler is pathological for sparse strokes.**
TILE_MIN_INSTANCES (flora.js:221) gates on stroke TOTAL (2000), not
per-tile occupancy: 2912 sparse desert plants shred into 57 tiles
averaging **51 instances**. Three consequences: (1)
getMaterialCacheKey appends object.uuid for any InstancedMesh
(three.webgpu.js:30185) and the node-builder cache keys on it
(:54283-54286) — **every tile is a full NodeBuilder codegen run** even
though all share one material; (2) below **1024 instances**
(64KB maxUniformBufferBindingSize / 64B) the identity instanceMatrix
becomes a uniform array with the count **baked into the WGSL text**
(:18041, :76760) — up to ~55 distinct vertex programs, distinct
GPURenderPipelines; (3) 68 objects × per-frame renderObject overhead
forever after. Above 1024 the matrix rides a storage buffer and
pipelines dedupe by program source (:32248) — which is why lightbench's
dense 16-tile field compiles in 1.4-1.6s while sparse mojave takes 6.

**(c) Whole pipeline families are never pre-warmed and compile
synchronously inside render().** The normal render path calls the
BLOCKING device.createRenderPipeline (three.webgpu.js:78990); only
compileAsync reaches the async variant. Never warmed: **the shadow
depth pass** (compileAsync only walks the main camera's render list —
every caster the rig enables, ≤2 per 300ms casterPass beat, pays a
sync compile inside render; lightrig.js:287-288 knows); **cold grass
tiles** (compileAsync skips visible=false and out-of-frustum objects
(three.webgpu.js:60819, :60869), and applyTiles runs BEFORE the warm
(flora.js:318) against wherever the camera is at build time — tiles
beyond 140m or outside the boot frustum compile synchronously when
the resident first looks at them: the jank that follows you around
the first minute); **shrub stems' depth variants** (vegetation.js:989
ships castShadow=true, prepareObject never clears it); **terrain past
its 1200ms compile cap** (world.js:122-127 races and gives up, the
biggest material in the world then codegens inside render);
**node-graph-only textures** (collectTextures walks Object.values(m)
only — assets.js:154-166 — so the factory noiseTex and MToon node maps
upload inside first bind).

**(d) Unlaned compiles bypass the gpu lane.** Of loadGLB's three
compile paths only the first-of-lib one is enqueued gpu(2); the
repeat-clone (assets.js:248) and racing-second-caller (:274) paths call
compileAsync bare — up to 6 concurrent compiles fighting rAF, invisible
to the jank attribution (no beginWork record).

**(e) Single-frame CPU boulders in the promote path.** realizeModel is
fully synchronous: fitCollider builds a fresh BVH **per entity** (never
cached per lib — 20 blankets of one lib do 20 per-vertex topLie walks;
colliders.js:162-214), toNonIndexed() triples vertex allocations,
plus per-promote O(N) scans (placeholder cargo step-out models.js:168,
mountsTouching models_field.js:72) and the O(N²) residencySweep every
500ms. Terrain build lands 573ms in one frame, then re-seats every
entity (world.js:131-137). GLTFLoader.parse (never parseAsync) runs
100-200ms per GLB on the main thread, cpu-lane(2) throttled.

**(f) The residency gate is inert at join.** models.js:119 requires the
entity to already BE a placeholder to skip far loads, but at hydration
entities.get(id) === null (geom arrives strictly after the snapshot) —
so **every model in the world loads regardless of distance**, then the
sweep demotes the far ones ≤500ms later. Full download+parse+clone+
compile paid for things that immediately become stand-ins again.
Invisible in 6-model commons; ruinous at city scale.

**(g) Storm-adjacent scheduling own-goals.** The sky warm (3.1s
measured) runs AFTER the curtain lifts (sky.js:414→452) — squarely in
the visible window. contributeThumbnail fires by setTimeout at t+4s —
a render-target compile burst mid-storm (main.js:184). The roster VRM
prefetch pulled 45MB (aletheia+aporia+claude_suit) at t=5-6s with
nobody else in the world. The governor sheds during the storm (fps
genuinely dips) then unwinds afterward — each pixels notch a
render-target realloc, each detail flip a 16MB shadow-map realloc
(governor.js:170-188). Texture uploads spike 25-34MB in single frames.
And grass tiles all sort as co-located (render sort uses
geometry.boundingSphere — three.webgpu.js:60872-60880 — and tile
geometries share the plant-local position attribute), so the
alpha-tested meadow renders in arbitrary order forever: worse early-Z
every frame, not just at boot.

Also measured and NOT the problem: applyTiles/_tileTick recounts
(count-only, no re-upload, 57 iterations/300ms — noise), pusher
uniforms (768B/frame), wind (one float per stroke per frame),
updateMaterials (~12 uniform writes). The steady state is genuinely
clean — everything above is arrival cost.

### 16.2 The design

One principle: **nothing compiles, parses, or builds inside a visible
frame without a budget.** Four fronts:

**A. The warm conductor (new client/lib/warmqueue.js).** One serialized
frame-budgeted queue through which EVERY pipeline warm passes:
grass tiles, GLB libs (all three paths — 248/274 get laned), VRM
bodies, sky domes, terrain, and NEW: shadow-depth variants. Depth
warming works by rendering the caster once into a 1×1 throwaway
depth target with the rig's shadow camera — same pipeline key as the
real pass — before castShadow flips true (casterPass asks the queue,
budget stays ≤2/beat as today but the compile happens off-frame).
Grass tile warming: after build, per tile briefly set
frustumCulled=false + visible=true and compileAsync(tile, camera,
scene) one at a time through the queue — kills the whole cold-tile
class. Terrain joins the queue with no cap (arrival can gate on the
splash a moment longer; an uncompiled ground is worse). The queue
yields to rAF between items (real frame yields, not scheduler.yield),
so warms stretch a little longer but never own a frame.

**B. Grass: fewer, fuller tiles + shared textures (flora.js + host).**
(1) Tile size derives from OCCUPANCY, not fixed 12m: choose the grid
so expected per-tile count ≥ ~1024 (storage-buffer instancing, shared
WGSL program, one node build amortised) with a floor of 2×2 tiles for
big fields; sparse strokes that cannot reach ~256/tile stay untiled
(their per-stroke world sphere already culls). Mojave: 57 objects →
~4-6. lightbench-density fields keep their culling win. (2) Host-level
URL cache in loadImageTexture (assets.js:500) — vegetation.js's
loadMap is uncached upstream, 38 decodes/uploads where 24 are unique
(~197MB→~123MB VRAM); the host cache fixes every toolkit module
without touching upstream. (3) Per-tile geometry.boundingSphere set
to the tile's world sphere (each tile owns its BufferGeometry object;
attributes stay shared) — restores front-to-back sort for the
alpha-tested meadow. (4) prepareObject(kind:'grass') clears
castShadow on shrub stems (blob-shadow philosophy; kills 5 unwarmed
depth pipelines). (5) The discarded original InstancedMesh (64B/inst
+ n identity setMatrixAt, pure garbage at 109k instances) — upstream
ask for Skye (a build-without-mesh entry point), recorded in
docs/upstream-wrap-once.md; not worth an adapter hack.

**C. The join gate + promote budget (models.js/colliders.js).**
(1) The residency gate works from POSITION with a conservative default
radius when libGeom hasn't arrived (R_BASE + DIAG_K × defaultDiag);
geom arrival re-runs the gate for anything it grew. Far entities never
load at join. (2) fitCollider caches decide() per (libPath, quantised
scale) — BVH and topLie built once per lib, not per entity. (3)
realizeModel's tail (fitCollider, reindex, attachLamps, casters) moves
behind a small per-frame budget so six promotes cannot land their
boulders in one frame; scene.add stays immediate (the thing appears,
its collider follows within a frame or two). (4) The O(N) scans:
carrier/mount lookups get an index maintained on entity events instead
of Object.values/entries per promote; residencySweep reuses it.
(5) parseAsync where three offers it; the VRM path keeps its phase
yields.

**D. Calm the storm's edges.** Sky warm joins the conductor BEFORE the
curtain lifts (arrival gates on it; it is 3s of splash, not 3s of
jank). contributeThumbnail and roster VRM prefetch wait for the
governor's goodFor signal (5 smooth seconds), not a wall-clock timer.
The governor gets a boot grace: no shed/restore while the warm queue
or load lanes are non-empty — the storm is not a performance regime,
it is loading. collectTextures walks node graphs (traverse material
via .colorNode etc or simply prime the factory's known shared
textures) so compileAsync stops meeting cold textures.

### 16.3 Slices and gates

- **8a** grass: occupancy tiler + host texture cache + tile spheres +
  stem castShadow + warm-all-tiles through a minimal queue. Gate:
  bootjank (build grass wall time, worst-frame, pipeline count —
  expect 68→~12 objects), lightbench 19/19 incl. --measure,
  paritybench, grass-quality/flora suites.
- **8b** warm conductor: warmqueue.js; lane the bare compiles; depth
  pre-warm; terrain uncapped; sky warm pre-curtain. Gate: bootjank
  (no >100ms frame after curtain in the commons replica), lightbench,
  paritybench; casterPass behavior unchanged in lightbench's caster
  checks.
- **8c** join gate + promote budget + collider cache + indices. Gate:
  bootjank on a WIDE world (author a far-city fixture — assert far
  entities never fetch), paritybench incl. residency cycle,
  collider-survey/collider-test, models-field-test.
- **8d** storm edges: governor grace, deferred thumbnail/prefetch,
  node-graph texture priming. Gate: bootjank + lightbench + governor
  behavior probe.
- **8e** observability: EW.grass() tile stats (promised at §13 and
  never landed), scheduler.laneStats + loadwork lanes on EW, bootjank
  joins the standing gate list for client changes.

Deferred, recorded: KTX2/basis transcode through the existing server
optQueue (kills the 512MB upload bill properly — its own step),
ES-module decode workers (no-build doctrine allows), parse in a worker.

### 16.4 bootjank facts worth keeping

Headless Edge renders at 120Hz (p50 8.3ms is a real vsync). The
`__jank` recorder hooks survive the whole session at negligible cost.
`EW.frame()` returns an ARRAY of {name, ms (EWMA α=0.05), every,
enabled} — a burst never shows in it; the GPU hooks are the honest
witness. Buffer-upload total (888MB/40s) is dominated by steady-state
per-object UBO writes — not a boot problem, ignore it in reports.

## 20. KTX2 — the texture bill, paid in the right currency

The MacBook trace's mandate (§10): 1.0-1.2s/GLB of createImageBitmap
decode and 1.07GB of raw RGBA uploads, both collapsing 4-8× with
GPU-native compressed textures. Grounded by a full extraction of the opt
pipeline, serving precedence, vendored KTX2Loader/WebGPU paths, and the
encoder gap (task record 2026-08-10).

### 20.1 The shape

**Encoder** (the one hard gap): KTX-Software's toktx/ktx CLI, probed
KTX2_TOKTX env → toktx → ktx on PATH; absent = optimize exit code 3 =
env-skip, never a .failed marker (the sharp-degrade pattern,
optimize.ts:50-59). Prod Mac: pkgutil-extract the arm64 pkg (docs/ktx2-encoder.md —
brew has no formula, and the pkg installer falsely demands Rosetta:
its metadata lacks hostArchitectures while the payload is pure arm64).
Dev box: a portable
extraction (7z on the NSIS installer) pointed at by env — no install.

**Server (20a)**: optimize.ts gains a --ktx2 mode: full existing diet
(dedup/prune/resample/draco — skip the webp stage) + per-texture toktx:
UASTC+zstd for normal/ORM/packed slots (MToon samples .r/.b scalars —
ETC1S block noise reads as data corruption there), ETC1S for
baseColor/emissive, --genmipmap. KHR_texture_basisu is already in
ALL_EXTENSIONS. A recursive library sweep (boot-deferred, serial, like
the store sweep at upload.ts:69-77 but path-preserving — the store arm's
basename() collides for library rels) writes OPT_DIR/<rel>.ktx2.glb for
eidoverse/assets/models/**.glb. VRMs excluded (doctrine at
optimize.ts:19-21 + gltf-transform drops VRM extensions — the surgical
container rewrite is 20c).

**Serving**: NEGOTIATED, not shadowed — OPT_DIR already wins
unconditionally (routes.ts:505-506), but agents/tools parse library GLBs
with no KTX2 decode, and KHR_texture_basisu lands in extensionsRequired
(old parsers THROW, GLTFLoader.js:1476). So the variant serves ONLY on
`?ktx2=1` + variant-exists, else the original — one small branch in the
/library route, distinct URL = clean nginx cache entry. contentType
gains .ktx2 (20d's loose files will need it anyway).

**Client (20b)**: one KTX2Loader singleton beside the draco one
(assets.js:141) — transcoder path
/node_modules/three/examples/jsm/libs/basis/ (vendored, served via
routes.ts:511-513), detectSupport(renderer) at module scope (core.js:100
top-level-awaits init, so ordering is free); setKTX2Loader in makeLoader
(covers all three parse sites) + globalThis.KTX2Loader beside the
GLTFLoader export for toolkit modules. loadGLB appends ?ktx2=1 to
/library .glb fetches once workerConfig exists. textureUploadBytes gains
the compressed branch (sum of mipmap byteLengths — the w*h*4 estimate
over-charges BC7 4× and re-wastes the §17a budget win).

**20c (later)**: VRMs via container-level rewrite (images/textures/
extensionsUsed patched, VRM JSON untouched byte-for-byte otherwise);
the VRM meta thumbnail (_extractGLTFImage → <img>) is the one raw-bytes
reader — needThumbnailImage defaults false, stays false. **20d
(later)**: loose toolkit PNGs (.ktx2 siblings + the loadImageTexture
branch + the baked-flipY contract handled at encode time).

### 20.2 Gate
Transcode the five commons libs with the portable encoder; assert:
variant served with flag / original without (curl); bootjank commons —
texture-upload total and per-GLB decode phases collapse; lightbench,
paritybench; collider-survey still parses a transcoded GLB
(gltf-transform reads the container without decoding pixels).

## 17. The meadow's draw bill, part 2 — vegetation LOD + the last hitches

Step 8 fixed the compile storms; tel0s's own trace (2026-08-10, their
machine) shows what remains: (a) 41ms hitches at t≈6.5-6.8s exactly when
the vegetation strokes build — their textures ride TSL nodes
(vegetation.js texNode(maps.albedo)), invisible to collectTextures'
property walk, so they upload at first bind INSIDE the warm's compile
items (the 4K starmap does the same at t≈1.7s: 34MB, 108ms); (b) a full
meadow holds their MacBook at ~40fps — the fill bill: mojave ≈ 1.72M
alpha-tested DoubleSide triangles (§16.1b), the classic countless-blades
problem (GPU Gems ch.7), and 40fps sits in the governor's 26/52 dead band
forever so no lever ever moves; (c) the sky's scene-diff claim swallowed
the TERRAIN mesh in their trace ("sky warm terrain") — anything added
while the async sky build is in flight and not wearing entityId/isBody
gets claimed, and teardownSky would then REMOVE it on the next sky
rebuild. The grass group is equally claimable. Real bug, made visible by
8b's warm labels.

### 17.1 The design

**17a — prime-on-decode at the host chokepoint.** Every toolkit texture
passes through loadImageTexture (assets.js). After decode, queue the
texture into the existing bytes-per-frame budget (renderer.initTexture,
~16MB/frame, real frame yields) — uploads spread BEFORE any compile binds
them, for vegetation, sky, and every future toolkit module at once. A
compile that wins the race anyway just uploads at bind as today.

**17b — blade-LOD by index subset, per tile.** The 'blades' archetype
builds perBunch blades per instanced geometry (galleta 34, meadow grass
8), contiguous vertex/index runs per blade (LOOPS=4 segments). A far-LOD
BufferGeometry SHARES every vertex attribute object and carries only a
shorter index (keep k of n blades, evenly strided) — same attribute
layout ⇒ same WGSL program ⇒ ZERO new pipelines (§16.1b's sharing rule).
applyTiles swaps tile.geometry by distance with hysteresis (~60m out,
~50m back in); count falloff already thins instances, blade LOD compounds
it: far-field triangle bill drops ~60% with the near field untouched.
Tiled strokes only (shrub leaf-planes and yucca are small counts,
untiled — recorded tail if ever needed).

**17c — the sky claim fence.** World-owned roots wear
userData.skyExempt (terrain mesh at setTerrain, grass group at
buildFloraField, debug groups at their creation); claimSkyAdditions
filters on it alongside entityId/isBody. A positive marker at the add
site, not a name heuristic.

**17d — policy, tel0s's call (not implemented unprompted):** the
26-52fps dead band means a 40fps meadow machine never sheds; the
resident grass dial (#60: full/medium/low, persisted per browser) is
today's intended control. Options if wanted later: grass-only shed
below ~45fps, steeper near falloff (GRASS_NEAR 30→24), device-default
quality. All change look or policy — none land without a decision.

### 17.2 Gates
17a/17c: bootjank (the 6.5-6.8s hitches and the 34MB starmap frame
shrink; no "sky warm terrain"/grass claims in the load log), lightbench,
paritybench. 17b: those plus flora.test, grass-quality, lightbench
--measure fps, and EW.grass() showing LOD state per tile.
