# #101 Phase B — acceptance table

Battery: scratch sequencer `:8994` (fresh WORLDS_DIR, open local door), world `chapel101b`,
branch `im/101-seat-profiles`. Chapel specimen = provenance-linked clone of prod commons
`e6482948` (`store/0445768b0c87d590.glb`): **exact transform to full precision and Digi's
four authored sockets verbatim, read from the public `/geom` tier** (the live chapel was
never written). `seat`/`seat3`/`seat4` migrated to `seatAnchor:"surface"` (the authored
opt-in); `seat2` left legacy-root as the same-cushion in-place control. Profiles derived
REAL (tools/seatlab `deriveSeatProfile`, receipts in `derivation-receipts.json`), proposed
via operator import, countersigned via `tools/seat-accept.ts` (receipt = the accepted
Phase B contract comment). Pad plane (Phase A, `summarizeGlb`): world Y **1.690**; socket
plane **1.6967** (7 mm authorship, verified again by `measureSeat`).

| # | Criterion | Result | Receipt |
|---|---|---|---|
| 1 | Founding specimen, claude + aletheia, three framings | **PASS** — both rigs seated ON the bench pads | `claude-seated-on-bench.jpg` (independent observer, wide) · `claude-seated-third.png` · `claude-seated-selfie.png` · `aletheia-seated-on-bench.jpg` (duo frame) · `aletheia-seated-third.png` · `aletheia-seated-selfie.png` |
| 2 | Known-good legacy seat does not regress | **PASS** — `seat2` (same cushion, no anchor): root at socket plane **1.70** = today's composition byte-identical, plus the declared state; crate control identical in the lifecycle test (y=1.00 both sides of the diff) | sitter-legacy look(): `ground height 1.70m … (seat approximate: legacy socket)` · `fail-on-main-lifecycle.txt` (the same check is one of the 3 that rightly PASS on main) |
| 3 | Gap within declared tolerance, both rigs | **PASS** — contact ON the socket plane by construction of the composition: claude root 1.4912 + 0.2055 = 1.6967 (socket), −pad = **+6.7 mm**; aletheia root 1.4109 + 0.2791 = 1.690 (seat3 socket) −pad ≈ **+0–7 mm**. Both ≪ 5 cm cushion tolerance, within the 2 cm rigid bound too | `numeric-receipts.json` · measureSeat: `gap.root = −0.2055`, `seatState: profiled` |
| 4 | Deterministic derivation | **PASS** — 3 bit-identical runs per rig; contactY reproduces Phase A's accepted numbers exactly (0.2055 / 0.2791) on the rebuilt instrument; real winner + nonzero support patch recorded (claude: char1001 v259, patch 31@1.84 cm; aletheia: Body_(merged)baked001 v282, patch 13@0.95 cm) | `derivation-receipts.json` |
| 5 | Stale rejected after byte change | **PASS** — accepted-with-foreign-hash serves `stale`, names which bytes, withholds the number; consumers declare | seat-lifecycle-test (`stale(avatar)`, value withheld) — 22/22 |
| 6 | Unsupported / missing explicit | **PASS** — unsupported serves its refusal string; missing = "no profile"; proposed = "not countersigned"; all three consumers declare (nameplate ≈ · console line · look() suffix) | seat-lifecycle-test · sitter-legacy look() · seatcore-test gate section |
| 7 | Moving parent, correction rides the arc, no drift | **PASS** — pendulum (axis X, amp 0.5, tilting parent): 5 mid-arc samples, socket Z traversing 1.6 m: **dY = 0.2055 exactly, dX = dZ = 0 exactly** every sample. The parent-normal implementation's signature (lateral dZ up to ±9.8 cm) is absent — the live B2 discriminator, matching the hand-math fixture in seatcore-test | `numeric-receipts.json` (swing samples) · sitter-swing look(): `3.34m … (riding its pendulum)`, no suffix |
| 8 | Three-consumer agreement | **PASS** — same slot, same value: browser-remote 1.4912 = headless 1.4912 (claude/seat); aletheia 1.4108 (remote) vs 1.4109 (headless); browser-local 1.4910 (claude/seat4, pad −0.29 vs seat3 −0.291 = authorship, not drift). Late-hydration transient = declared approximate on ALL consumers (sample 1 of the swing series is the state, captured) | `numeric-receipts.json` · sitter logs |
| 9 | #18/#98 dismount unchanged | **PASS** — mechanism untouched; body dismount clears seat, controller truth returns; entity stamping verbatim main behavior | seat-lifecycle-test final section + main control |
| 10 | Fail-on-main | **PASS** — 19 named failures on main (server+agent from main, branch instruments), 3 passes = exactly the invariants that must hold on both sides; main's seated header: `seated on crate1.` — silent root-at-socket. Visual before = Phase A's hover screenshots of this same bench (`im/101-seat-instrument` receipts), after = #1's photographs | `fail-on-main-lifecycle.txt` · Phase A `claude-hover-at-authored-plane.jpg` |
| 11 | No live chapel mutation | **PASS** — prod was touched only by a public read-only `/geom` GET to copy the authored sockets; all writes on the scratch clone | this file, `restage-sockets.ts` |

Suites on committed head: smoke 85/85 · seatcore 55 · seat-lifecycle 22/22 · effective 42 ·
motioneval 33 · supportclass 29 · uneven-support 15 · denoise 31 · remotes-lifecycle green ·
comptest 33/0 · worldops 23/0 · permtest 21/2 and voice-lifecycle 122/2 **pre-existing on
main** (verified on a main worktree control).
