# Material factory: decisions behind materials.js

Rationale behind `client/lib/render/materials.js`. § numbers are docs/history/TEL0S_NOTES.md; the history is in git.

## Why a factory (§12)

On three's WebGPU renderer a material's compiled pipeline dies whenever its node graph changes SHAPE. Upstream's
weather/sky systems sweep the scene and rewrap already-compiled materials (measured: 44 rewraps on one Safari join,
~2-6 s per graph). So every material is wrapped once at creation, before its first compile, by CLIENT-OWNED wraps
driven by folded state (effectiveSky), and everything after is uniform writes.

- Wetness is a shape-identical port of weather_system.js wrapMaterial; upstream's own transitions only ever write
  u.wetness after wrapping, so driving the same uniforms IS the upstream behaviour, minus the recompile.
- Cloud shade is our own two-tap field over a boot-made seeded noise texture, not a port: upstream's 16-tap march uses
  textures that only exist inside makeSkySystem. Ground shadows need to read as clouds, not match the dome.

## TSL function layouts

hash2/vnoise2 as plain closures are INLINED at every call site: vnoise2 calls hash2 ×4 and the puddle graph calls
vnoise2 ~5×, so each wrapped material re-emitted the hash arithmetic ~20× (seconds of NodeBuilder source generation
per material; three forum #86524 reports 0.2 s → 10 s for 5 materials). An Fn() LAYOUT emits each once as a called
function.

## Puddle cost gates

The puddle noise is 4 value-noise taps (16 hashes) per fragment on every PBR surface.
1. A material that opts out of puddles (grass, foliage cards) never builds it: GLSL cannot fold x*0 (NaN/inf).
2. At runtime the puddle factor is smoothstep(0.35, 0.9, wet), exactly 0 at wet ≤ 0.35, and the shape reaches the image
   only through mix(…, puddle), so the taps run only above that, in a uniform branch. Both are value-exact.

## No camera terms in per-view rendering

`cameraPosition` is a camera accessor (Fn(({camera}) => …)) with no camera under per-view (stereo) rendering
(WebXR's ArrayCamera, WebGL backend): the program fails to build and the object draws nothing in a headset. Bisected
headless with a stereo probe. So: MToon (non-PBR) bodies never build the puddle term, and the distance fade uses
view-space length (positionView is per sub-camera by design).

## Transmission upgrade

three's WebGPU renderer supports transmission, but only MeshPhysicalNodeMaterial builds the graph that reads the
backdrop. GLTFLoader produces a plain MeshPhysicalMaterial, so a KHR_materials_transmission glass renders as nothing
(measured: transmission 1, ior 1.5, 581 triangles, invisible; the same values on a node material render).

- Copied by property name (own properties AND prototype accessors: `transmission` is a getter/setter on the prototype,
  and Object.keys() alone dropped exactly it). Color/Vector values are copied into the target's instances, never
  shared. Textures are shared.
- Memoised source → replacement in a WeakMap, so meshes sharing a source material share the replacement.
- Non-transmissive materials are left alone (the node class costs more to compile).
- The upgraded material is put in the transparent pass, agreeing with warmqueue.

## Body shadows

- Bodies are not shadow casters by default: their depth pipelines are never warmed through warmDepth and they bypass
  the distance-ranked caster budget, so N bodies would compile in-frame in a crowded room. The blob stays as the
  contact cue.
- setBodyShadows opts a body in: avatar.js calls it for a body with a lamp inside (the lamps are found after assets.js
  prepared the scene), and for the viewer's own body when the Video setting asks. receiveShadow IS in the pipeline key
  (RenderObject.js:856/:945), so a flip costs a lit and a depth pipeline per material, warmed first where possible.
- BODY_NO_CAST: the kintsugi seams (thin ribbons threaded through the skin; their depth fights the body's and they
  self-shadow into scratches) and the wings. castShadow is per object, not per pair, and both wings plus membrane are one
  mesh, so dropping it removes wing-on-wing self-occlusion at a glancing angle (where a shadow map is worst) at the cost
  of the wings not throwing onto the body or ground. The silhouette comes from the body and hair, which still cast.

## Grass

Grass receives no shadows and casts none, set explicitly both ways (upstream vegetation ships receiveShadow=true, and
shrub wood castShadow=true: unwarmed depth pipelines compiled on the first shadow frame). It never puddles: blade normals
are forced straight up for clump lighting and sail through the flatness gate. The gate is compile-time (§12.2).
