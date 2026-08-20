# upstream-patched — deliberate forks of eidoverse-video library files

Files here SHADOW their same-relative-path originals in the eidoverse-video
checkout: the `/library` route serves this directory with top precedence
(before the assets/opt variants and before EIDOVERSE_DIR itself). Delete a
file to fall back to Skye's copy. The eidoverse-video checkout stays
PRISTINE — never patch it in place; the standing permission (tel0s,
2026-08-10: redo upstream when it's a performance blocker) lands here,
versioned with this repo, so every machine gets it via ordinary git pull.

Each file is a full copy of the upstream original plus a minimal,
commented delta. Keep diffs small and opt-gated where possible (a host
that doesn't pass the new option must get byte-identical behavior — these
files still serve to agents and any future host). When Skye lands the
change upstream, delete the file here.

Current patches:

- `eidoverse/vegetation.js` — `opts.lodGrow` (§22e/f): density-compensation
  grow (survivors of the host's distance thinning scale up to `cap`) and,
  with `lodGrow.exp`, the per-instance dither that moves the count-falloff
  curve into the shader (draw-order rank vs keep(d) — continuous density,
  no tile seams). Without the opt: byte-identical to upstream. PR material
  for Skye alongside docs/upstream-wrap-once.md.

- `eidoverse/assets/animations/sitting_normal_chair.vrma` — hips translation
  track lowered by 0.409 (track units; 169 keyframes, Y lane only, X/Z and
  every other byte untouched). The clip is authored FLOOR-ORIGIN — its hips
  sit at y≈0.5247, a seated pelvis above the floor the chair stands on —
  while every seat path here puts the avatar root ON THE SEAT SURFACE
  (`mountTransform` at the socket, `controller.toggleSit` at `findSeat`'s
  surface). Root-at-surface + floor-origin clip = the body hovers by the
  clip's implied seat height; measured 0.454 m at the hips, which reads to a
  viewer as sitting a foot and a half in the air. The two ground clips are
  authored root-at-contact and are unaffected — that is the control that puts
  the fault in this file rather than in the engine's placement convention.
  Baked here rather than corrected in code because `createVRMAnimationClip`
  scales the hips track by each rig's own hips ratio, so one shift lands
  correctly on every body, and the avatar ROOT never moves — nothing
  downstream (collision, the per-frame `resolveColliders` snap, network
  position, camera) changes meaning. Δ is anchored on `sitting_on_ground`
  (root-at-contact, hips 0.085 m above its contact surface) and on chair-height
  proportions; an earlier Δ=0.2911 derived from a lowest-vertex "contact"
  reader under-corrected by ~0.10 m and is the cautionary tale in
  `tools/bake-seat-clip.ts`. Regenerate with `bun tools/bake-seat-clip.ts`
  (`--check` verifies, `--delta=` for a calibration round).
