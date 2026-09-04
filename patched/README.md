# patched/ — the versioned asset overlay

Deliberate fixes to eidoverse-video library ASSETS, versioned in this repo:
`/library` serves anything here with top precedence (PATCH > OPT > LIBRARY),
so every machine gets the fix via ordinary `git pull` while eidoverse-video
stays pristine. Delete a file to fall back to the library's copy.

Assets only. This directory succeeds `upstream-patched/` (§22g), which also
carried ENGINE-code overrides — the mechanism that let our grass rewrite
ship over upstream's vegetation.js. That contract retired on 2026-08-27
(§24j): the braid ended (eidoverse-video is an asset library, not an engine
peer), the anima-research merge clobber showed exactly how the override
mechanism fails (TEL0S_NOTES §24c), and the grass engine now lives in
`client/lib/vegetation/` as first-class client code. The vendor-base
merge-file recipe is obsolete with it.

Every file here is a candidate for upstreaming to the library — a patched
asset is a bug report with the fix attached.

Current contents:
- `eidoverse/assets/animations/sitting_normal_chair.vrma` — the corrected
  sit clip (see docs/INCIDENTS.md, the stale-cache incident of 2026-08-19,
  and seats.ts's precedence notes).
