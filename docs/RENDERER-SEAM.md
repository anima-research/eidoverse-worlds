# The renderer seam — inventory and program

The charter's thesis (docs/overhaul-charter.md §5, as re-argued after the
Godot reopening): **own the architecture, rent the renderer** — three.js
WebGPU behind a narrow interface, so the presentation layer can be swapped
without touching sim/fold/protocol truth. This document is the measured
state of that seam, from a full-client inventory (2026-08-30, 113 modules,
37,066 lines; §24s). Measurement before movement — the same doctrine every
arc on this branch has run on.

## The headline

**The thesis is already ~63% true by line count.** `shared/` is provably
three-free (verified: the only matches are comments saying so). 72 modules
(13,747 lines) import no three.js at all; 11 more (6,367 lines) touch only
vector/quaternion/matrix math. The renderer-coupled remainder — 30 modules,
~17,000 lines — is heavily concentrated: ten files carry half of it.

| band | meaning | modules | ~lines |
|---|---|---:|---:|
| F | no three.js | 72 | 13,747 |
| A | math-only (Vector3/Quat/Matrix) | 11 | 6,367 |
| B | scene-graph, stock materials | 13 | 5,610 |
| C | materials / TSL shaders | 6 | 4,163 |
| D | renderer/GPU (targets, compile, info) | 5 | 1,865 |
| E | loaders / three-vrm / BVH | 3 | 3,690 |
| mixed F+D | protocol interleaved with GPU calls | 3 | 1,624 |

## The two channels

1. **The import chokepoint (good).** Only five files import a `three`
   specifier directly: `core.js` (three + tsl, re-exported as the whole
   namespace), `assets.js` (loaders), `colliders.js` + `debug.js`
   (three-mesh-bvh), `realize/structure.js` (BufferGeometryUtils).
   Everything else reaches three through `core.js` — a WIDE seam, but a
   singular one. The swap surface is "what core.js hands out", and today
   the answer is "everything".
2. **The globals contract (bad, and invisible to import graphs).**
   `core.js` installs the eidoverse module-host contract:
   `globalThis.THREE` (three+TSL merged), `_s`/`_c`/`_r`/`_sun`/`_hemi`/
   `_sceneTime`. All four `vegetation/*.js` files bind it at module scope,
   and sky/emitters eval-load upstream toolkit modules that depend on it.
   This is the single biggest unsealed surface.

## What is already behind a seam

The fold→state→realize discipline has been quietly building the charter's
shape for months:

- **realize/** — the designated scene writers, several already three-free
  (`environment`, `social`, `causes`), with pure planning halves beside
  the impure ones (`models_field.js`: "No THREE, no DOM, no scheduler").
  The healthiest seam in the codebase.
- **materials.js `prepareMaterial()`** — one entry point rewrites node
  graphs; callers know nothing about TSL.
- **lightrig slots** — callers make requests; nobody touches a light.
- **flora/emitters engine splits** — DOM/THREE hosting halves beside
  headless-tested pure halves.
- **warmqueue** — every pipeline compile funnels through one serialized
  conductor.
- **terrain.js `heightAt()`**, **frame.js `registerSystem`** (render is
  just a system named 'render'), and **bodysim ENGINES** — which is the
  MODEL: a Map of named engines behind a tiny selection API, lazily
  loaded, floor engine always present. The renderer seam should look
  like bodysim.

## What is bare

- The `globalThis.THREE`/`_s`/`_c`/`_r` host contract (above).
- `net.js:782-813` — the WIRE PROTOCOL module renders a frame and reads
  the framebuffer to mint avatar thumbnails.
- `commands/handlers.js:337` — the slash-command dispatcher does the same
  for screenshots.
- `avatar.js:1704-1816` — a third private copy of the same intent (the
  portrait render-target pipeline).
- `world.js` — one inline `renderer.compileAsync` that BYPASSES the
  warmqueue conductor (arguably a latent bug: the concurrency-1 queue
  exists precisely to stop compiles fighting).
- `governor.js` + `grassdiag.js` — two independent owners of
  `renderer.setPixelRatio`.
- `core.js` policy (MSAA, tone mapping, colorspace, far plane) living in
  the module every file imports.

## The ten hardest-coupled modules

avatar.js (1839 — three-vrm woven through pose/gaze/springbones/
expressions + the portrait RT), vegetation.js (1199 — inline TSL wind
shader over the merged global namespace, vendored), assets.js (994 — the
whole loader pipeline), sky.js (867 — two eval-loaded external renderers
behind one verb), colliders.js (857 — MeshBVH IS the data structure),
flora.js (784), debug.js (727), sky_baked.js (523), materials.js (358 —
mutates colorNode on every material in the world), core.js (282 — small,
but it IS the seam and currently leaks the namespace).

Dependency asymmetry worth pinning: **three-mesh-bvh and ammo are
portable** across a swap (CPU-side, merely accept three-shaped geometry);
**three-vrm is not** — a rig runtime bonded to Object3D/SkinnedMesh/
AnimationMixer. ~2,800 lines across avatar.js + assets.js are the
irreducible cost centre of any renderer move.

## The program (four moves, in order of cheapness)

1. **`captureFrame()` — DONE (§24s).** `client/lib/capture.js` is the one
   framebuffer-readback primitive; net.js's snap handler and the
   screenshot command dispatch through it (their private renderer calls
   deleted, their core.js imports narrowed). Two corrections to the
   survey while landing it: world.js's compileAsync was ALREADY routed
   through the warmqueue conductor (the inline call sits inside a warm()
   thunk), and avatar.js's portrait path is deliberately NOT unified —
   it is an offscreen-SUBJECT renderer (own RenderTarget, isolated
   scene, async pixel reads), and one primitive with five booleans would
   be worse than two honest ones.
2. **base.js — DONE (§24s).** The renderer-free substrate (`bus`,
   `CONFIG`, `setName/setToken`, `report`/`setErrorSink`, `angleDelta`,
   `parallelMap`, the participant colours) split out of core.js; 59
   modules retargeted mechanically. base.js guards its browser touches,
   so headless suites now import the REAL bus and report instead of a
   stub's. core.js is 127 lines of pure presentation substrate and
   imports only base.
3. **Narrow core.js's export** from the whole namespace to an explicit
   surface (the list of what the client actually uses — countable now
   that move 2 landed).
4. **Replace the globals host contract** with an explicit host object
   passed to eval-loaded modules. The hard one, and upstream-shaped
   (vendored vegetation + Skye's toolkit) — needs coordination, not just
   code.

None of these commit to any particular replacement renderer; all four pay
for themselves in legibility even if three.js WebGPU is rented forever.
