# Meadow grass rendering: tiling, density and LOD

Rationale behind `client/lib/vegetation/flora.js`. § numbers are docs/history/TEL0S_NOTES.md sections and progress-log entries (§13.2, §16,
§17, §22*); three.webgpu.js line numbers are the vendored r184 build. The history is in git.

## Culling (§13.2 G1)

Upstream ships `frustumCulled = false` because every transform lives in the `aPosRot/aScaleVar/aPhase` attributes and
`instanceMatrix` is all identity: three's own bounding sphere would be a half-metre sphere at the origin. `aPosRot` IS
the world placement, so one pass over it gives a correct world sphere; assigning it (a non-null sphere is never
recomputed) turns culling on. Pad: plant height × tallest instance + 0.6 m (the engine's tanh lean ceiling).

## Tiling (§13.2 G2, §16.1b, §16.2.B)

A big stroke is re-cut into XZ tiles AFTER the density shuffle. Tiles share the vertex/index/aH/color attribute
OBJECTS (the backend keys GPU buffers on the object, so one upload) and get sliced copies of the three instanced
attributes; all tiles share the one material. Each tile carries its own sphere, so culling works per tile, and a
per-tile `count` becomes distance density for free: bucketing in stable order preserves the shuffle, so any prefix is
still a uniform random subset.

- The grid derives from OCCUPANCY, not a fixed edge: a fixed ~12 m edge cut 2912 sparse desert plants into 57 tiles of
  ~51, and every InstancedMesh is a full NodeBuilder codegen (the material cache key carries object.uuid for instanced
  objects, :30181). Aim ~threshold instances per tile, cap the edge, refuse strokes that can't fill tiles.
- `TILE_MAX_EDGE` 28 m (§22h): the nearest-edge budget over-submits by about a tile radius of curve; smaller tiles halve
  that waste. `TILE_MAX_AXIS` 12 (§22n): measured on the lush meadow at 2×, 12×12 submits 7.3k fewer instances for
  +2 fps with identical visible density; 16 adds nothing.
- `color` must be on every tile: opaque blades (§22m) bake the palette per vertex and a missing binding draws black.

### The identity instanceMatrix and one shared program

The shader path reads the attribute ALLOCATION, not the live draw count (:18031/:18041). At or below the uniform-buffer
limit the identity matrices become a uniform array with the count baked into the WGSL, a distinct program and pipeline
per tile size. Above it they are an instanced attribute with a count-independent program, so every tile of a material
shares one program and pipelines dedupe by source (:32003/:32248). Each tile's allocation is therefore pushed just past
the limit (`matrixPathCaps`: WebGPU `maxUniformBufferBindingSize`, 65536 by default; WebGL2 `MAX_UNIFORM_BLOCK_SIZE`),
≤65 KB of identity per tile, uploaded once. The draw's instanceCount comes from the live `object.count`
(:29971-29973), which never exceeds the sliced attributes.

The tile sphere is also assigned to the GEOMETRY: the render sort reads `geometry.boundingSphere` (:60872-60880), and the
shared plant-local positions would otherwise sort every tile as co-located at the origin.

### Global-rank tiling

A blades stroke the occupancy rules refuse (the Commons meadow: 1729 tufts on 80×70 m → 9 tiles of 192) stayed one
InstancedMesh, never culled. It now tiles without changing a blade: every tuft keeps the whole-stroke rank, and a
tile's count is only a CEILING (entries are in global order, so a prefix drops exactly the tufts whose rank exceeds
keep at the tile's nearest XZ point, less `GR_MARGIN`). Re-applied whenever the eye moves `GR_MARGIN/2`; hooks run
before movement, so the budget is one frame behind (a teleport can under-draw one frame). `?grassgrank=0` restores the
refusal.

## Density

- The perf governor thins the meadow before dropping resolution: shuffle the instanced attributes once
  (deterministically) and `InstancedMesh.count` is a uniform-density dial. densityCount owns the clamp, including true
  zero for `off`.
- Distance falloff (§22d): the far sea's instance count was the cost (far-only density 35% recovered 46→61 fps, same as
  grass hidden; blade thinning bought +3). Distant tufts are subpixel cards, near-pure per-instance overhead. The curve
  is quadratic-ish from `GRASS_NEAR` 15 m to `GRASS_FAR` 90 m with exponent 2.5 (§22e), shared with the shader dither.
- Per-tile budget (§22f): the CPU count is evaluated at the tile's NEAREST point, so it is a ceiling for every instance
  in it; the shader dither (vegetation `lodGrow.exp`) keeps an instance iff rank < keep(distance), the same curve. No
  double thinning, no seams. The rank rides in the aPhase lane (×2π), so flutter stays uniform.
- Shaped resident density (§22q): near/mid instance count was the remaining cost (density 35% recovered 41→58 fps).
  `DENSE_BASE` thins at every distance through the rank dither and widens survivors by 1/√DENSE_BASE (width only), with
  a full-density guard ring 2→8 m at the camera's feet. 0.65 measured a locked 60-61 fps at 30% fewer submitted
  instances, screenshot means within 0.5 RGB (1.0 → 52 fps, 0.8 → 60 dipping to 52). `?grassdense=1` is the kill switch.
- The budget uses the camera's WORLD position: in XR the camera is a child of the rig and `camera.position` is
  rig-relative.

## Blade LOD (§17b, §22f, §22n)

One far index per stroke, shared by every tile's far twin geometry (the same vertex and sliced instanced attribute
objects). Layout keys are names/formats plus an index-PRESENCE flag, never the index object (:30035-30081,
:81752-81780), so a swap is a pointer write: zero new programs or pipelines, and the live render object keeps its
pipeline (:30430-30434, :32305-32309, :81690-81744).

- §22f retired the per-tile blade-COUNT swap (a visible pop; blade count measured nearly free).
- §22n brought the twin back as a COARSE index (every blade, 2 segments instead of 4). Measured inert on the M-series
  Air (vertex count acquitted a third time), so it is OFF by default; `?grassvlod=on` opts in, and
  `forceBladeLod('far')` uses it as a diag lever. flora_lod.js re-verifies the run layout; a reshaped upstream degrades
  to no LOD, never a torn tuft.

## Shader modes (A/B switches)

- `?grasslod=off|nodither` (§22i): no density-compensation grow / grow without the rank dither.
- `?grassshade=full` (§22l): upstream's four-fetch blade material instead of the one-albedo-sample diet.
- `?grassgeo=cards` (§22m): atlas cards instead of opaque geometry blades. The mode a stroke reports is read from the
  built material, never the options (the palette sampler can fall back silently).

## The warm (§16.2.B)

compileAsync skips invisible and out-of-frustum objects (:60819/:60869), and tiles are already culled against the boot
camera, so a field-level compile leaves culled tiles cold and they codegen synchronously in the first render that sees
them. The warm is per render object (the sky.js pattern): each detached, culling defeated, one real rAF between objects
(scheduler.yield-style continuations starve rAF on Chromium), the whole field out of the scene meanwhile. One warm per
tile covers both LOD twins (layout-keyed caches, see above); the far index uploads at first use (:31031-31043).
