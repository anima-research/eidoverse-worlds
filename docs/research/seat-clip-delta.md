# The seated clip's hips offset

`tools/assets/bake-seat-clip.ts` regenerates `sitting_normal_chair.vrma` (committed under `patched/eidoverse/assets/animations/`) with the hips track lowered by
Δ (`DELTA`, 0.409 track units).

## The fault

`sitting_normal_chair.vrma` is authored floor-origin: its hips track sits at y ≈ 0.5247, the height of a seated
pelvis above the floor the chair stands on. Every seat path here puts the avatar root on the seat surface
(`mountTransform` at the socket; `controller.toggleSit` at the found surface). Root-at-surface plus a floor-origin
clip means the body hovers by the clip's implied seat height. The two ground clips (`sitting_on_ground`,
`sit_laying_on_ground`) are authored root-at-contact and don't hover, which localizes the fault to this one file
rather than the engine's placement convention.

## Why in the clip, not in code

`createVRMAnimationClip` multiplies hips translation by `avatarRestHipsY / animationRestHipsY` (0.963756 for this
clip), so a shift baked into the track is applied to each rig in proportion to its own hip height: one number, scaled
per body, with no per-avatar profile, store or gate. The avatar root stays where it is, so collision, the
every-frame `resolveColliders` snap, network position and camera keep their meaning. Lowering the root instead (the
#101 approach) fights the collider snap.

The loader reads `restHipsPosition` from the clip's rest scene graph, not from the track, so editing sampler output
values leaves the scale untouched. That is why the edit is safe.

## Deriving Δ

Δ is set from where a seated pelvis belongs, anchored twice; both give Δ ≈ 0.409, pelvis about 0.10 m above the seat:

- `sitting_on_ground` looks right, and its hips sit 0.0975 track units above the surface the body rests on;
- inverting the stock clip with hips at 0.10 m puts its authored seat plane at a height that scales to about 0.42 m
  on a 1.75 m human: a normal chair.

**Rejected:** deriving Δ from the lowest skinned vertex whose dominant bone is the hips. That vertex hangs below the
visible seated mass, so it read contact while the body a viewer sees was still about 0.2 m in the air, and verifying
with the same reader confirmed the same error. A landmark's definition is part of the instrument: when a measurement
and a person looking at the thing disagree, the measurement is the hypothesis.

## Re-deriving

After an upstream re-export (the source hash `EXPECT_SRC` will differ), don't reapply Δ: pose a body, find the lowest
point of the mass that should rest (buttocks and thigh undersides, never a single minimum vertex), and Δ = that height
/ 0.865. `--delta=<n>` writes a calibration bake without claiming `EXPECT_OUT`, but only against the recorded source: after a
re-export, update `EXPECT_SRC` first or the tool exits before baking.
