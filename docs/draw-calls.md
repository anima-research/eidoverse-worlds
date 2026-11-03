# Draw calls and visual parity

Library models now share instanced draws when their geometry, material, layers,
shadow policy and spatial cell agree. The optimization is enabled by default.
It applies to the live frame and to captures, without changing world state,
asset bytes, texture resolution, geometry detail or quality settings.

## Measurements

Measured with Chrome 152 / WebGPU on macOS, at 800 × 600 with antialiasing.
These are fixture results, not a production FPS claim. Actual savings depend
on how many compatible copies a view contains.

| View | GPU draws before | GPU draws after |
| --- | ---: | ---: |
| 144 repeated boxes, including shadows and output | 194 | 6 |
| Same fixture with authored tangents and normal maps | 194 | 30 |
| Mixed opaque and transparent objects | 242 | 102 |
| Camera cutting through the field | 120 | 31 |
| 32 actual library crates through the full client | 53 | 33 |

The 13-case GPU probe checks motion, hidden objects, layers, camera culling,
off-camera shadow casters, transparency, cutouts, tangents, overlapping copies,
mirrored and sheared hierarchies, and removal. Submitted triangle counts stayed
the same in all measured cases. The largest changed-pixel count was 18 of
480,000; changes above two channel levels affected at most seven pixels.
Overlapping, mirrored and sheared fallback cases were pixel-identical.

The separate full-client probe exercises real GLB parsing, shared prototypes,
the warm conductor, caster selection and source identities. Its 32-crate view
changed 42 pixels; eight differed by more than two channel levels. It also
checks fold parity after place, mount, remove, reconcile and disabling batching.

## What is already batched

The audit found these existing reductions:

* [Flora](../client/lib/flora.js) uses instanced, culled spatial tiles. Merging
  those into one field-wide draw would lose culling and submit more grass.
* [Particles](../client/lib/emitters.js) already use instanced emitters. Different
  emitter parameters, origins and transparent ordering require separate care.
* [Buildings](../client/lib/realize/structure.js) already merge geometry per
  palette material per building. Their shaders use building-local coordinates;
  merging buildings in world space would change the surface patterns.
* [The lighting rig](../client/lib/lightrig.js) already limits shadow casters.
  This change retains that policy and batches compatible selected casters.
* Skinned avatars and translucent surfaces retain their existing rendering.

Repeated library clones were the general opportunity left by those paths:
they shared GPU assets but still submitted one draw per mesh per copy.

## Implementation and exclusions

[draw_batches.js](../client/lib/draw_batches.js) temporarily replaces source
submissions during one synchronous render. Originals remain in their original
hierarchies. Only their layer masks are suppressed; their children stay visible.
Masks and temporary batch attachments are restored in `finally`, including if
rendering fails. Picking, collision, parts, mounts, inspection and provenance
continue to address the originals.

Each batch holds at most 64 instances and occupies a 16 m cell. Fixed allocation
keeps the shader's uniform-buffer layout stable as membership changes. Individual
camera culling happens before batching; camera-invisible originals still render
through the shadow camera. Batch bounds retain the sources' geometry bounds.
Color and shadow variants warm through the existing conductor while originals
continue drawing. Idle instance buffers expire, and prototype disposal and world
reset release them. Geometry, materials and textures remain asset-owned.

The compatibility checks deliberately keep these cases on ordinary draws:

* Transparent/transmissive, skinned, morphing, already-instanced and custom
  callback/shader geometry; unusual depth/stencil, clipping and render-order
  requirements; explicit culling opt-outs.
* Mirrored, singular, sheared transforms and nonuniformly scaled ancestor
  hierarchies. The latter produced shadow differences in the pixel probe.
* Intersecting bounds of candidate objects sharing a material, including flat
  coplanar sheets. Keeping their original draw order preserves depth ties.
  This guard is conservative: overlapping bounds may contain disjoint meshes.

In r184, instancing transforms normals but does not transform `tangentLocal`.
Tangent-bearing copies therefore also need identical rotation and scale. Their
shared linear transform stays on the batch; only translations are instanced.
This preserves authored normal-map tangents without modifying shared materials.

## Diagnostics and reproduction

```js
EW.draws()                  // measured last world render, plus batching counters
EW.draws({ sources: true }) // source inventory by type and library, before batching
EW.setDrawBatching(false)   // release batches and compare the original renderer
EW.setDrawBatching(true)    // warm and resume
```

`?batching=0` disables batching from boot. For a custom renderer/plugin, set
`object.userData.noDrawBatch = true` on a mesh or ancestor to exclude that scope.

`render.drawCalls` includes the world render's nested shadow and output passes,
but excludes other work such as an earlier sky bake. `savedColorDraws` counts
eliminated source color submissions; it is not the total shadow-inclusive
saving. `warming`, `failed` and `overlapping` explain common missed opportunities.
The optional source inventory counts visible objects/material groups, not all
GPU passes, and runs only when requested.

```sh
bun tools/draw-batches-test.ts
bun tools/drawbench.ts --out /tmp/ew-drawbench
bun tools/draw-world-probe.ts
bun tools/paritybench.ts
bun tools/foldfix-test.ts
bun tools/models-field-test.ts
```

The GPU bench owns a temporary HTTP listener. The world probes own scratch
sequencers; they do not join or restart a resident world. The full-client probe
needs the normal asset library. `SFU_TEST_CHROME` selects the browser for the draw
probes; otherwise they use installed macOS Chrome or Playwright's managed browser.

Two broader checks exposed existing issues outside this change:

* `parts-test.ts` cannot import `surfaceUnder` from its collider stub, reproduced
  on untouched `main` at `e7a0f96`.
* `object-lod-test.ts` fails its catalog assertion in a checkout containing
  library LOD variants. An empty baseline checkout passes; adding an existing
  LOD filename to that baseline reproduces `/library-models` exposing the
  variant. The catalog route is unchanged by this work.
