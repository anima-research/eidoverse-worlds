# server/optimize.ts — design notes

Rationale moved out of the code comments. The code keeps one line + a pointer here.

## One libvips per process

`@gltf-transform/functions` reaches sharp through `ndarray-pixels`, which declares `^0.35.0`. Whenever the store's
root manifest declares a range that doesn't intersect it, as its `^0.33.5` once did, no installer can dedupe them and
both land on disk (`node_modules/sharp` beside `node_modules/ndarray-pixels/node_modules/sharp`). Importing bare
`"sharp"` in optimize.ts would then load a second native libvips into a process that already has one, and the two
disagree about libvips' own enums:

    GLib-GObject-CRITICAL: value "32" of type 'gint' is invalid or out of
    range for property 'space' of type 'VipsInterpretation'
    Error: colourspace: parameter space not set   (sharp/lib/output.js)

On win32 that throws (the pass dies, the original is kept). On other hosts it may not: encoding returns a buffer of
uninitialized memory, gltf-transform stamps it `image/webp`, and the store serves an image that is not an image
(the material falls back to its base colour factor and renders white).

So optimize.ts never imports `"sharp"` by bare specifier. It resolves the copy gltf-transform itself uses
(`resolveNestedSharp`, tools-stamp.ts) and hands that same module back as the encoder.

Resolution and import are separate. The bare specifier is reached on exactly one condition: no copy could be resolved
from ndarray-pixels (in a deduped install that resolution finds the root's own copy, the only one, and the import takes
it by that path). A nested copy that
resolves but fails to import (ABI mismatch, missing dylib, damaged install) must not fall back: that would recreate
the two-libvips condition in the one situation where things are already going wrong. `pickSharp` fails closed, both
callers skip the texture pass, and a draco-only result ships. Less compression is a cost; an image that is not an
image is a lie. Test: test/server/one-libvips-test.ts.

Because the failure produces intact-looking bytes, every container output is also checked by `findImageLies`
(declared mimeType vs. magic bytes) before it is written; a mismatch exits 4 (retryable, not a failed marker).

## Attribute-aware LOD simplification

gltf-transform's `simplify()` hands meshoptimizer positions only, so every collapse is judged on shape alone: across
hard-edge normals (smeared wheel arches) and across UV seams (texture blotches, dulled foliage). meshoptimizer's
README says to use `Permissive` only with attribute-aware simplification. So each primitive is simplified in
`simplifyAttributes` with `simplifyWithAttributes`, normals, COLOR_0 and TEXCOORD_0 in the error metric.

Weights were chosen by measurement (six library models rendered at the client's LOD switch distances): normals 0.25,
UVs 1, colour 1. Normals at 1.0 (meshoptimizer's demo, Godot) or 0.5 (gltfpack) left several models 'ineffective'.
Protecting UV-seam and crease vertices (`meshopt_SimplifyVertex_Protect`) froze the seamed models and changed nothing
on the rest, so nothing is locked: weighted UVs let the simplifier trade instead of refuse, and a model that can't
reach the bar without tearing its UVs is refused as 'ineffective' rather than served torn.

`ErrorClamped` (meshoptimizer 1.3) clamps attribute error to the position-error scale; without it the normal error
used up the budget and every pass stopped early. The README recommends it for any attribute-aware use.

Weld, strip/fan conversion and compaction are gltf-transform's own exported helpers, as its `simplify()` uses them.

## Permissive retry

The regular pass runs first; only if it cannot reach the vertex bar does the reduce run again with meshopt's
`Permissive` mode, which may collapse edges across UV/normal seams. Seams lock the regular pass on many real models;
Permissive can drag UVs a little across a seam, which is acceptable because a LOD is only seen at distance
(lod_policy.js). Every preservation assert applies to both passes unchanged.

## LOD gate: GPU cost, not file bytes

A LOD's KTX2 textures are routinely 2–5× larger on disk than a JPEG original while far smaller in VRAM, so the
byte gate used for the other modes would refuse most real candidates. `--lod` instead requires that the vertex cut
(or for a texture-only LOD, the texture cut) holds, and that its textures cost no more GPU memory than the
original's (`glbPerf` texMB). The download ratio is logged on success because a far placement fetches the LOD first.
