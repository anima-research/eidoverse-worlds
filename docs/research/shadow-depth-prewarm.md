# Shadow-depth pre-warm (client/lib/render/warmqueue.js)

The shadow-depth pass was the one pipeline family nothing warmed: every caster
the rig enables paid a synchronous `createRenderPipeline` inside the next shadow
render (TEL0S_NOTES §16.1c). `warmDepth()` warms a caster's depth pipelines
through `compileAsync` BEFORE `castShadow` flips, so the real pass is a pure
cache hit.

Grounded in the vendored three.webgpu.js (r184). Line numbers below refer to
that build and were read, not assumed; re-check them if three is upgraded.

## Why a warm compile lands the real pipeline

The pipeline cache is renderer-global and keys on program ids + a VALUE-only
backend key (:32248-32252, lookup :32035-32047): material blend/depth/stencil/
side state, target formats, sample count, topology, geometry key — no object,
scene or context IDENTITY anywhere (:81752-81782). Programs dedupe by WGSL
SOURCE STRING (:32003-32029), and NodeBuilder names uniforms/vars with
builder-local counters (:51535-51557, :51570-51590) with constants inlined by
value (:50882-50931) — so structurally identical graphs emit byte-identical
text. A warm compile that reproduces the real pass's material VALUES, node
graph, object and target formats therefore lands the exact GPURenderPipeline
the real pass will ask for.

## What the real pass does

`ShadowNode.updateShadow` sets `scene.overrideMaterial` to a per-light
`NodeMaterial{colorNode: vec4(0,0,0,1), isShadowPassMaterial, NoBlending,
fog: false}` (:44603, built :43865-3884) and renders into a RenderTarget whose
`texture.type = shadow.mapType` with a default DepthTexture (:44272-4285).
Depth-pass codegen is scene-independent BY DESIGN — `getDynamicCacheKey` skips
the lights/env/fog key entirely for `isShadowPassMaterial` (:30257-30268). Per
caster material the renderer derives colorNode/depthNode/positionNode once and
caches THE INSTANCES on itself (`_getShadowNodes`, :61040-61133), then mutates
the override material per object: alphaTest/alphaMap/transparent copied, side
flipped through `_shadowSide` (:61187-61203, map :57817).

## The trap

`renderObject()` RESTORES colorNode/depthNode/positionNode/side after queueing
(:61237-61243), and `compileAsync` DEFERS codegen to after that restore
(:61343-61383, loop :58761-58790). So a naive "overrideMaterial + compileAsync"
compiles the WRONG pipeline for any caster with a map, alphaTest or flipped
side.

The fix: PRE-configure the warm material to exactly the post-mutation state
(same cached node instances via `_getShadowNodes`, which also primes the
renderer's cache for the real pass), so save → mutate → restore is identity and
the deferred build sees the correct state (`configureFor()`).

## Why the mutation is invisible to frames

`compileAsync` captures its render target/context synchronously before its
first internal yield (:58652-58654; items carry the context, :61358) — the same
precedent as the avatar thumbnail (avatar.js) — so target and overrideMaterial
are restored in the same synchronous block and no real frame ever sees them.
Pipelines build through `device.createRenderPipelineAsync` (:79006-79031), not
the blocking variant, so nothing stalls the queue.

## Escape hatch

`?nodepthwarm=1` bypasses the pre-warm (casters compile in-frame), to tell a
wrongly-warmed pipeline from a driver compare issue. If the vendored build ever
drops `renderer._getShadowNodes`, the pre-warm disables itself with a warning.
