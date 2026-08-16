# seatlab — the #101 seat instrument (tools harness)

Not client runtime: nothing in `client/` imports this, and it never ships in
a page load. It exists for two jobs:

1. **Derivation** — `deriveSeatProfile(avatarPath)` runs the detached lab
   (Phase A rev 2 protocol: lab-owned instance, hydrated clips, settled
   `sitchair`, 3-run determinism) and assembles a content-bound profile
   record with the winner + support-patch evidence, `review.status:
   "proposed"` — the only status the server door accepts. POST it to
   `/seat-profile?token=…` (named identity required) or hand the JSON to the
   operator for `tools/seat-accept.ts propose`.
2. **Acceptance measurement** — `measureSeat(riderId)` reads a live seat
   passively (never mutates a resident) and reports the authored surface,
   every landmark candidate's signed gap, and what the composition itself
   declared (`profiled` / `approximate: reason`).

Loading into a running client (import specifiers are absolute `/lib/...`, so
the module works served from anywhere):

```
curl -X POST "$SEQ/upload?as=script&token=$BEARER" --data-binary @tools/seatlab/seatlab.js
# → {"path": "store/scripts/<hash>.js"}
# browser console:
const lab = await import('/library/store/scripts/<hash>.js');
```

The pure math this instrument leans on (seat claim, gates, patch thresholds,
correction) lives in `client/lib/seatcore.js`, pinned by
`tools/seatcore-test.ts` — including the nonzero-Y seat-claim regression from
the `_v` register-aliasing bug this file's history is a cautionary tale about.
