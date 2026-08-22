# Eidoverse Overhaul Charter — DRAFT

Branch: `overhaul/rimward`. Status: **ratified 2026-08-21** on the four
founding ⚑s (braid policy, web delivery, engine, sim-core language) — see
resolutions inline, marked ✅. Remaining open points stay marked ⚑.

## 1. Why

The engine has outgrown a three.js webpage. Two ceilings, hit from both sides:

- **Performance.** The §16–§22 arc (see TEL0S_NOTES §10) spent weeks buying a
  locked 60fps on an M5 Air — pixel budgets, cruise governor, LOD dither,
  fastShade, opaque blades, shaped density. Every win was hand-rolled work a
  real engine gives you for free (instancing LOD, culling, shader permutation,
  frame pacing). We are optimizing against the platform, not with it.
- **Complexity.** Physics (ammo), avatars (Tripo), voice (piper), seats, mic,
  agents, moderation, flora — systems accrete as entangled modules calling each
  other directly. Cross-system coupling is where the jank lives, and every new
  system raises the cost of the next.

Team consensus: port to another engine, and rework the systems to be
"more Rimworld-y" — modular, data-driven, extensible.

## 2. What must survive (invariants)

1. **Worlds are append-only; logs replay unchanged.** The log format is the
   contract. Any new stack must boot an existing world log and reproduce it.
   This is the crown jewel and the primary parity gate for the whole port.
2. **Multiplayer, server-authoritative.** The server remains the truth.
3. **Agents are first-class citizens.** The MCPL door (and whatever succeeds
   it) means AI participants act in-world through the same protocol humans do.
   Any engine choice must keep the world fully drivable through a wire
   protocol — no logic locked inside a scene graph.
4. **Content.** Worlds, assets, species/flora definitions, avatars carry over.
5. ✅ **Braid policy (resolved 2026-08-21).** eidoverse-worlds is **our own
   thing**; eidoverse-video becomes an **upstream asset library** — art,
   models, fitted envelopes, species data flow downstream to us; engine code
   no longer shared. The `upstream` remote stays fetch-only. The
   upstream-patched override mechanism keeps the *legacy* client alive
   unchanged while it remains the reference renderer (§6 phase 2).

## 3. "Rimworld-y", defined

What RimWorld actually gets right, translated to us:

- **Defs, not code.** Content is declarative data (RimWorld: XML defs; us:
  JSON/TOML defs with schemas). A flora species, a seat, a behavior, an avatar
  archetype is a def file. Adding content means adding data; code changes are
  reserved for new *kinds* of things.
- **Simulation tick ≠ render frame.** The sim advances on its own fixed tick;
  presentation interpolates. Decoupling these is what kills a whole class of
  jank (and what makes headless/agent-only worlds cheap).
- **Systems over objects.** Modules (growth, wind, seating, speech, physics)
  operate over shared component data — ECS or ECS-lite. A system can be added,
  replaced, or disabled without surgery on its neighbors.
- **Events over direct calls.** Systems communicate through events. Our
  append-only log is already an event spine — lean into it: the log stops
  being a persistence detail and becomes the architecture.
- **Mod surface.** Def loading + system registration is the same mechanism
  third parties (and our own agents) would use to extend a world. Design it
  once, use it ourselves first.

## 4. Architecture thesis: split sim from presentation

The load-bearing move, more than the engine choice:

```
┌────────────────────────────┐      events / snapshots      ┌──────────────────┐
│  SIM CORE (engine-agnostic)│ ───────────────────────────▶ │  PRESENTATION    │
│  fixed tick, def-driven,   │ ◀─────────────────────────── │  (the new engine)│
│  emits/consumes log events │      intents / verbs         │  render, input,  │
│  server-authoritative      │                              │  audio, juice    │
└────────────────────────────┘                              └──────────────────┘
```

- The sim core owns truth: entities, components, defs, the tick, the log.
  It runs headless. Replay = re-feeding the log. Agents connect here.
- The presentation layer is a *view* over sim state. It holds no authority
  and no gameplay logic. It can be swapped, duplicated (two clients on
  different engines during migration), or absent (headless worlds).
- Consequence: the engine port becomes a **client port**, and the invariants
  in §2 live in the sim core where no engine migration can break them again.

✅ Resolved 2026-08-21: **the sim core stays TypeScript on the Deno server
for now** — phase 1 is a refactor of `server/`, not a rewrite. tel0s has
ideas for a later ground-up sim-core redo; the §4 split is deliberately
shaped so that redo swaps in behind the same protocol when it comes.

## 5. Engine candidates (presentation layer)

| | Godot 4 | Bevy | Unity | Custom (wgpu) |
|---|---|---|---|---|
| License | MIT | MIT/Apache | Proprietary | — |
| Language | GDScript/C# | Rust | C# | Rust/Zig/… |
| Editor tooling | Strong | None | Strong | None |
| Web export | Weak for 3D (threading/wasm size) | Decent (wasm-native) | Weak | Ours to build |
| ECS / Rimworld-y fit | Nodes + Resources (ECS-lite viable) | Pure ECS, the platonic fit | DOTS (heavy) | Whatever we write |
| Multiplayer | High-level API built in | Ecosystem crates | Netcode packages | Ours |
| Small-team velocity | High | Medium (Rust ramp, pre-1.0 churn) | High but licensed | Low |
| Risk | Web story; C# interop edges | API churn; no editor; hiring/onboarding | License terms drift; closed | The rewrite trap, in full |

✅ Resolved 2026-08-21: **Godot 4 (current stable 4.6.x), web delivery
required, native builds for local dev/testing on this branch.** Bevy is the
named fallback if — and only if — the phase-0 web-export gate fails.

### 5.1 Godot web reality (verified 2026-08, Godot 4.6.3 stable)

The constraints we are signing up for, so nobody is surprised in phase 2:

- **Renderer: Compatibility only (WebGL 2).** Forward+/Mobile don't export
  to web; WebGPU support is unimplemented. This is a *downgrade* from our
  current three.js WebGPU client — the meadow currently leans on TBDR HSR
  behavior we measured under WebGPU. Hence the phase-0 gate: the meadow at
  60fps **in the web export**, not just the native editor build.
- **No C# on web.** The .NET runtime doesn't run in the browser sandbox;
  web C# export is roadmapped, not shipped. **Client scripting is GDScript.**
- **Threads need COOP/COEP** (`Cross-Origin-Opener-Policy: same-origin`,
  `Cross-Origin-Embedder-Policy: require-corp`) for SharedArrayBuffer. We
  own the Deno server — adding the headers is a two-line change to
  `routes.ts`. 4.3+ also offers a single-threaded export (no headers,
  larger binary) as a fallback. ⚑ pick threaded-with-headers vs
  single-threaded during phase 0, by measurement.
- **Payload:** engine wasm ≈ 5MB brotli (~35-40MB raw). Our server already
  gzips wasm (§23); add brotli for the engine payload.
- ⚑ COEP `require-corp` constrains cross-origin asset fetches — audit how
  eidoverse-video asset-library URLs are served before committing to the
  threaded build.

## 6. Migration strategy: strangler, not big-bang

Keep the current client alive and shipping until the new one earns its place.

- **Phase 0 — Godot spike (timeboxed).** One vertical slice: a Godot 4.6
  client connects to the *existing* Deno server over the current WS verbs,
  boots one real world log, walks an avatar through the meadow. Develop
  native for speed, but the **exit gate runs in the web export**
  (Compatibility renderer): meadow at 60fps, boot time sane, payload
  measured. No system rework, ugly code allowed. If the web gate fails
  after honest effort, Bevy gets the same timebox before we reconvene.
- **Phase 1 — sim extraction.** Refactor `server/` toward the §4 shape:
  fixed tick, def registry, event bus over the log. Current three.js client
  keeps working throughout — this phase has no visible surface and is gated
  by log-replay parity (existing worlds byte-identical through the new core).
- **Phase 2 — new client to parity.** Build the presentation layer in the
  chosen engine against the phase-1 protocol. Parity gates per slice, same
  culture as the rebuild: paritybench/lightbench/bootjank analogs on the new
  stack, old client as the reference renderer.
- **Phase 3 — systems rework.** Migrate systems one at a time into defs +
  modules (flora first — we know its laws cold; then seats, voice, physics).
  Each migration is a def schema plus a system module plus a parity check.
- **Phase 4 — retire the old client.** Only when the new one is the one
  people prefer to open.

## 7. What carries over from the rebuild

The §22 arc's *laws* are engine-agnostic and become defs/specs, not lore:
density-vs-distance laws, guard rings, LOD dither ranks, width-comp under
thinning, the cruise governor's pixel budget, the measurement doctrine
(warmup exclusion, drift control, engagement verification). Port the laws,
not the shaders.

## 8. Non-goals

- No new gameplay during the port. No visual redesign — parity means parity.
- No re-derivation of solved problems (grass, KTX2 pipeline decisions).
- No engine-maximalism: we adopt an engine's renderer/tooling, not its
  opinions about where truth lives (§2.2 stands).

## 9. Risks

- **The rewrite trap / second-system effect.** Mitigation: strangler phasing,
  vertical-slice gates, old client alive until phase 4, no-new-gameplay rule.
- **Braid drift.** Resolved by policy (§2.5): video is an asset library,
  not an engine peer. Residual risk is asset-format drift — mitigated by
  keeping the vendor/override recipe until the legacy client retires.
- **Godot web export dead ends** (WebGL2 perf, wasm payload, COEP vs
  assets). Mitigation: the phase-0 gate runs in the web export, Bevy is
  the named fallback, and the §4 split keeps the blast radius to the
  presentation layer.
- **Team bandwidth.** The rebuild taught us slices + gates beat ambition;
  the charter's phases are sized to be droppable at any boundary.

## 10. Immediately next

1. ~~Ratify the founding ⚑s~~ — done 2026-08-21 (braid: worlds is ours,
   video is an asset library; web required, native for dev; Godot 4;
   sim stays TS with a later redo in tel0s's pocket).
2. Phase-0 spike scaffold: `godot/` project on this branch, WS client
   speaking the existing driver verbs, world-log boot.
3. During the spike: measure threaded-vs-single-threaded web export;
   audit COEP vs asset-library URLs; pick GDScript patterns for the
   def-consuming client early (they set the tone for phase 3).
