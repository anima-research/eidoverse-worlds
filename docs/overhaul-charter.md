# Eidoverse Overhaul Charter — DRAFT

Branch: `overhaul/rimward`. Status: **draft for discussion** — nothing below is
locked until the team ratifies it. Decision points are marked ⚑.

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
5. ⚑ **The braid with eidoverse-video.** Skye's line and ours currently share
   an engine. A port ends that sharing at the engine layer unless upstream
   comes along. Decide early: does the overhaul happen inside the braid
   (coordinated with Skye), beside it (new client, shared server/protocol), or
   does it fork the destiny? This is a people question before it is a
   technical one.

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

⚑ Open: does the sim core stay TypeScript on the Deno server (lowest-risk —
it's a refactor of `server/`, not a rewrite), or move into the new engine's
language? Draft position: **stays TS/Deno for phase 1–2**; revisit only if the
tick can't hold rate at target world sizes.

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

Draft recommendation: **Godot 4** — open source (matters for a research
project and for anything we'd share back with Skye), an actual editor for an
actual team, C# available where GDScript runs out, headless mode if we ever
want sim-in-engine, and a mod story (PCK loading, GDExtension). **Bevy** is
the honest runner-up: its ECS is the most Rimworld-y thing in existence, and
if we keep the sim in TS anyway, the client being Rust matters less — but
pre-1.0 churn plus no editor is a real tax on a small team.

⚑ The deciding constraint: **is browser delivery still a requirement?**
"Outgrown a three.js webpage" suggests native builds are now acceptable. If
web stays mandatory, the table tilts hard toward Bevy (or staying web-native);
if native is fine, Godot wins on velocity. This one question does most of the
choosing — answer it first.

## 6. Migration strategy: strangler, not big-bang

Keep the current client alive and shipping until the new one earns its place.

- **Phase 0 — spike (timeboxed).** One vertical slice per finalist engine:
  connect to the *existing* Deno server, boot one real world log, walk an
  avatar through the meadow, hold 60fps. No system rework, ugly code allowed.
  The slice that feels best under the hands wins; measurements decide ties.
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
- **Losing the braid.** Mitigation: decide §2.5 *with* Skye, early; keep the
  server/protocol shared even if clients diverge.
- **Engine-specific dead ends** (Godot web export, Bevy churn). Mitigation:
  the §4 split keeps the blast radius to the presentation layer.
- **Team bandwidth.** The rebuild taught us slices + gates beat ambition;
  the charter's phases are sized to be droppable at any boundary.

## 10. Immediately next

1. Ratify or amend this charter (the ⚑ marks: braid policy, sim-core
   language, web-vs-native, engine finalists).
2. Answer web-vs-native — it collapses most of §5.
3. Timebox phase-0 spikes for the finalists.
