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
