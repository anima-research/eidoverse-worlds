# Engine refactor survey — 2026-08-26

Four parallel deep-reads (UI layer · voice/embodiment lane · server+MCPL
periphery · body-physics engines) plus a direct pass over the lanes the
rebuild already knows. Branch `overhaul/rimward`. Everything here carries
file:line evidence in the underlying reads; this document is the curated,
prioritized synthesis.

**Status 2026-08-27:** §A (all eight bugs + hygiene) is DONE — R0 complete
(41422ba…61da4e4). Two §C retirements are DONE by tel0s's call:
`upstream-patched/` (grass engine now `client/lib/vegetation/`, asset
overlay lives at `patched/`) and rapierdoll (−1,589 lines). The #88
strictness was upstreamed into `shared/fold.js` as part of A6. §C's other
two calls (seats write-half, stdio door) await colleague input.

**R1 is DONE** (0eb5fe3…93eac2e): aid1 slug + verifyJoinIdentity in one
place; `shared/force.js` owns the radial falloff; the command registry is
the whole alias truth (chat.js keeps only its five chat-owned handlers);
the emote vocabulary is a def (`defs/animations/_emotes.json` — bar,
number keys, /emote and help all derive); and the onset gate/level meter
are ONE factory in micgate.js (both transports' twin copies deleted,
−316 lines). The stdio-door tool-table unification was deliberately left
out of R1 — it rides the pending §C call.

**R2 is DONE** (90cc9fc…4be976d): the ws switch is a handler table
(`server/messages.ts`, bodies verbatim; server.ts 1379→851); join split
into admitJoin/installJoin/buildSnapshot — admission-before-takeover is
structural, the join payload testable without a socket; every wire limit
has a name (`server/limits.ts`, env-overridable, 27 sites); `atomicWrite`
replaced eight hand-rolled pairs (seats deliberately untouched — pending
call); the /library LADDER is named (a generic resolver was considered
and SKIPPED: one consumer = theater); `tools/harness.ts` owns the scratch
bench (both §24 smokes converted). Deferred with the §C calls:
net-server's handleTool table (its shape depends on retire-vs-unify).
R3 (the dolls' shared core + skeleton def) and R4 (panels + defs round
two) not yet begun.

## The verdict

The hypothesis was right, with a sharper shape than expected. The core —
fold, sim, protocol, and this month's systems (defs, tick, bus,
replaybench) — is clean. The mess concentrates in two places:

1. **The pre-rebuild periphery**: UI panels, the voice lane, the three
   body-physics engines, and the MCPL agent — code that grew before the
   fold→state→realize discipline existed and never got the pass.
2. **One disease, everywhere**: *hand-mirrored copies of single truths.*
   The exact failure mode house rule 1 exists to kill — "must stay in
   step" comments guarding parallel implementations — is alive in at
   least eight places, and several copies have already diverged.

The survey also surfaced **eight live bugs**, all in the duplication
class. That is the argument in one line: the mess is not cosmetic.

## A. Live bugs found by the survey (fix first — small, each ≤1h)

1. **The noise gate runs its stale fork.** The gate/onset state machine
   exists twice (`voice.js:664-864` vs `micstate.js:65-271`, ~200 lines,
   54 lines diverged) — and micstate *delegates back to the old copy*,
   which lacks two fixes the new one carries: a speaking-latch bug (mute
   mid-speech ⇒ `speaking` stuck true forever) and an analyser-node leak
   on every mic-stream change.
2. **The TTS row's mic check is a hard false.** `ttsrow.js:563-568` keys
   on an SFU global nothing installs, with no fallback — so the row never
   greys, while `tts.js:660` silently discards typed says. Display says
   on; reality is off. (micstate.js:359 documents this exact regression
   as already-found; it is still unfixed.)
3. **`main.js:512` bypasses the mic entry point** — imports voice.js
   directly, so the TTS-boot mic-open never emits `audio:mic`; HUD badge
   and panels don't hear it.
4. **`setPin(…, firm)` is dropped by two of three body engines** — and by
   the owner's own re-pin path (`localbody.js:262`), so a persistent nail
   is held with grab tuning on the owner's machine and nail tuning on the
   dragger's. Divergent physics per viewer.
5. **`mcpl/net-server.ts:192` ships a developer's home directory** as the
   models-dir fallback — the *fixed* copy of this bug (with its incident
   note) sits next door in `mcpl/server.ts:120`. The unguarded
   `readdirSync` throws ENOENT with someone else's `$HOME` in the message.
6. **The MCPL agent's fold has drifted from the reference.**
   `agent.ts:739-901` hand-mirrors `foldEntry` and already disagrees on
   four verbs: `place` (strictness), `light` (drops comp/parent/yaw on
   re-light), `remove` (no cargo cascade), `spawn` (drops `collide`).
   Same log, two worlds. This class already caused the crashed-look()
   incident the file's own comments cite.
7. **The agent is blind to the sim.** No MCPL file consumes
   `shared/sim.js`; the join snapshot's `sim` cut is never read; there is
   no `punt` case. A punted object is invisible to text-tier perception —
   `look()` reports where the log last placed it while every renderer
   shows the flight.
8. **`physobj.js:79`'s collider→world box math is wrong** (`scale.x`
   only, no rotation) — the third hand-rolled copy of math the dolls
   spell correctly twice.

Hygiene rider: `build.js:919/974` interpolate server-supplied names into
`innerHTML` unescaped while `ui.js` has `escapeHtml` for the same job.

## B. The five structural themes

### B1. Hand-mirrors of single truths (the disease)
Beyond bugs 1/6 above: the `force` falloff is duplicated agent↔client
with a stale "keep in sync" comment naming the wrong file
(`agent.ts:830` vs `localbody.js:379` — `shared/` is the obvious home,
sim-adjacent); the **aid1 identity slug** is triplicated verbatim across
three doors (`server.ts:516`, `upload.ts:188`, `net-server.ts:1278`) —
if they drift, an agent is a different person depending on the door; the
**emote vocabulary lives in four places** (avatar EMOTES, emotebar ICON,
registry help string — which lists `dance` twice — and ui.js prose, plus
the `1-6` key range hardcoded twice); **chat.js carries a second command
alias table** that registry.js was explicitly written to replace — 21 of
26 cases are pure re-dispatch, and each table has aliases the other
lacks; the **stdio MCP server is a stale copy** of net-server's tool
table (16 vs 26 tools, drifted descriptions, "shared schema" claim
false).

### B2. The three-dolls problem (~4,900 lines, one lineage)
ammodoll is rapierdoll's fork with the copies left in (its own header
says so): ~550-600 lines of line-identical shared core across the trio
(frame math, settle law, snapshot, topple, seed-ω recovery), plus 236
identical lines between two test harnesses. The cost is not lines — it's
that **fixes land in one fork**: terrain-following ground and the
hipsOffset fix exist only in ammodoll; the grid-bounded collider query
exists only in rapierdoll (the *default* engine still does the full-map
scan that work removed). The 12-segment body cut is byte-identical in
three files; joint limits exist in five vocabularies that silently
disagree (shoulder cone: 85° / ~69° / ±85°). And **rapierdoll is
effectively vestigial**: panel-only reachability via localStorage, no
hair/fingers/wings, flat ground, one unshipped capability (tone motors).
The engine-selection seam itself has zero test coverage — the exact gap
the dropped-seedVel incident documents.

### B3. Giant switches awaiting the verbs.ts treatment
`server.ts`'s ws switch is 878 lines; the `join` case alone is **321
lines / 16 phases**, with the load-bearing "admission before takeover"
invariant held by a comment. 19 of 22 cases move cleanly to a handler
table on the existing VerbCtx precedent (three source-text-regex test
suites must be retargeted — budgeted, that's why it hasn't moved). The
same shape twice in MCPL: `handleTool` (369 lines, 26 cases that should
key off the existing TOOLS array) and `serve()` (323 lines, one block
copy-pasted three times). And chat.js's 26-case switch is the client's
copy of the same pattern.

### B4. Defs, round two (authored content still in code)
The registry earned its keep; these tables are queued at its door:
**ground/terrain palette** (build.js GROUND_TINTS — which already
references `_colors.json` keys by string while hardcoding hexes beside
them — TERRAIN_SHAPES, GRASS_HEIGHT/DENSITY, the five PLANTINGS bags
that hardcode `preset: 'mojave'`); **emotes/clips** (the four-site
vocabulary of B1 → `defs/animations/` entries carrying slot/order/icon/
speed, the domain built for exactly this); **the humanoid skeleton**
(three byte-identical segment tables + reconciled joint limits →
`defs/skeleton/humanoid.json`); **sky slider specs + BASIC_ONLY +
the hardcoded LA timezone**; **Piper voice character** (noise scales,
length scale — the file itself argues these are voice decisions, not
perf knobs); the STARTER model catalog; ui.js's 120 lines of help prose.

### B5. Shared utilities that are ten copies each
`atomicWrite` (tmp+rename) hand-rolled **ten times** with accidental
differences (0600 sometimes, orphan cleanup once, injectable-fs once);
the wire-limit table doesn't exist (≈25 protocol caps as inline literals
in the ws switch — "what does this server accept" is unanswerable
without reading 900 lines; `server/limits.ts` with the `env()` idiom
mcpl/denoise.ts already uses); the library precedence ladder re-spelled
at five sites (seats.ts documents the lie a wrong-order copy produces);
the refusal idiom (`error` send + close + sometimes-unmap) 30 times with
accidental asymmetries; **no shared UI row builder** — seven private
reimplementations (two *within* single files), six copies of one
slider-table builder in debug.js alone, ten inline no-op re-applications
of index.html's own `select` rule; and the four browser test harnesses
each carry the same ~90 lines of CDP scaffolding.

## C. Retirements to decide (each needs a human call)

- **`upstream-patched/` itself**: the mechanism now protects exactly one
  file (vegetation.js + one clip). The braid it existed for is over —
  video is an asset library. Retire it: vegetation.js becomes a
  first-class client module, the merge-file recipe dies, PATCH_DIR
  serving stays only if the patched clip needs it.
- **rapierdoll**: retire or demote to a spike beside `rapier-spike.ts`.
  1,589 lines (incl. tests) + a permanent divergence tax vs one
  unshipped feature.
- **seats.ts's write half**: ~90% of a three-review-rounds-hardened store
  (locks, provenance, quarantine) is unreachable — the proposal/
  countersign routes were never ported. Port them or move the store to
  tools/ with a read-only projection in server/. The current state — a
  5s poll against a store the server can only read — is the worst option.
- **the stdio MCP server**: export TOOLS + a transport-agnostic
  handleTool and register from it (stdio door gains its 10 missing
  tools), or retire it.

## D. Recommended program

- **R0 — stop the bleeding** (~2 days): the eight bugs of §A. Each is
  small; several are one extraction with tests already pinning behavior
  (micstate-*, voice-lifecycle, bodydrag suites).
- **R1 — one truth** (~1 week): agent fold → `foldEntry` + side-effect
  pass; agent adopts `shared/sim.js`; gate machine extraction; force
  falloff → shared; aid1 slug + verifyJoinToken → aid1.ts; emote def;
  chat/registry command unification. This retires the disease, not just
  today's symptoms.
- **R2 — the tables** (~1 week): `server/messages.ts` + the join
  admit/install/snapshot split (makes admission-before-takeover
  structural); limits.ts; atomicWrite; ladder resolver; refuse();
  handleTool table; tools harness extraction.
- **R3 — the dolls** (gated on the rapier decision): shared core
  extraction (`rigmeasure.js` + `BodyEngineBase`), skeleton def, seam
  test, then port the three one-fork-only fixes to the survivor(s).
- **R4 — panels and defs round two** (incremental, low risk): ui rows.js;
  build.js five-way split; debug.js panel collapse; ground/sky/help
  defs; upstream-patched retirement.

Every phase lands behind the existing gates (replaybench, paritybench,
lightbench, smoke, defs-smoke, sim-smoke, the per-lane suites), same as
everything else on this branch.
