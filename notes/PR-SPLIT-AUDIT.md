# relay-spike → PRs: the complete audit

*2026-08-16. Written because we have LOST WORK from staging before by
splitting from memory instead of from the diff. Every claim here is
mechanically derived; the commands are included so it can be re-run.*

## The delta

```
git diff --stat upstream/main..relay-spike
→ 86 files changed, 9338 insertions(+), 132 deletions(-)  (126 commits)
```

🔴 **These numbers go stale FAST.** This block said 60 files / 7015 / 80
commits until 2026-08-16 13:1x — a full day of work later. Re-derive before
trusting any count here; the coverage script is the only part that self-checks.

🔴 **`origin` in this tree is a LOCAL PATH** (`/home/claude/eido/engine`), not
GitHub. Measuring against `origin/main` says "241 commits ahead" and is
meaningless for PR purposes. **Always measure against `upstream/main`**
(github.com/anima-research/eidoverse-worlds). Rebased onto it 2026-08-16:
80 ahead, 0 behind. Backup branch: `backup-relay-spike-20260816`.

## Coverage — all 60 files assigned, 0 unaccounted

| group | files | ships as |
|---|---|---|
| **A. SFU core** (#104) | 16 — `sfu.ts` 514, `sfuadapter.ts` 283, `relayadapter.ts` 284, `sfuguard.ts`, `relaydecision.ts`, 9 tests/probes, `SFU-SPEC.md`, `SFU-HANDOFF.md` | **PR 1** |
| **B. SFU wiring** | 15 — `server.ts`, `voicesfu.js` 326, `voicesfubridge.js`, `voicerelay.js`, `main.js`, `voice.js`, `voicemouths.js`, 8 smokes/probes | **PR 1** |
| **C. door media bridge** | 2 — `mcpl/agent.ts`, `mcpl/net-server.ts` | **PR 1** |
| **D. mic / HUD truth** | 8 — `mictoggle.js`, `micgate.js`, `stt.js`, 5 probes | PR 2 |
| **E. audio panel UI** | 3 — `audiopanel.js`, `voicelist.js`, teardown probe | PR 3 |
| **F. TTS** | 5 — `tts.js`, `tts-chunk.js`, `ttsrow.js`, `engine-piper.js`, probe | PR 3 |
| **G. isolation headers** | 1 — `routes.ts` (partial) | PR 0 |
| **H. join / net probes** | 5 — `net.js`, 4 probes | PR 1 |
| **I. deps / manifest** | 5 — both `bun.lock`s, both `package.json`s, `index.html` | PR 1 |

Re-run the coverage check before shipping anything (it prints UNASSIGNED):
`notes/pr-split-coverage.py` — asserts every file in the diff has a group.

## 🔴 Why this CANNOT be split per-commit

**14 of 126 commits touch more than one group** (re-derived 2026-08-16 13:1x;
this previously read "27 of 80" and the offender list named commits whose
spans have since changed — a stale justification for a conclusion that
happens to still hold). Cherry-picking by commit drops hunks silently — the
exact way work has gone missing before.

Worst offenders now:
- `452b7be` (the phase-1 spike) spans **G+H+I** (14 files).
- `dd379d8` spans **E+F+K**, `0f1c510` spans **E+F+J**, `3d4e8d6` spans **E+F+I**.
- The E+F pairing recurs (panel + TTS edited together all afternoon), which is
  itself the argument for shipping E and F as ONE PR.

Even the smallest candidate is not file-clean: **`server/routes.ts` carries 8
isolation-header lines AND 19 SFU lines** across its 4 hunks. PR 0 therefore
needs a hunk-level extraction, not a file copy.

## 🔴 Dependencies that were WRONG in my earlier survey

1. **`d7c4aed` (media-bridge listener leak) is NOT independent.** It fixes the
   `Bun.serve()` return value discarded by **`634ba11`** (the door's
   media-signalling frames), which is SFU work. The listener it holds does not
   exist without that commit. Ships inside PR 1, not alone.
2. **A, B and C are one subsystem.** `SFU-HANDOFF.md` is explicit: the SFU is a
   library and *"nothing calls it"* until `server.ts` wires it. Shipping the
   core without the wiring merges dead code; shipping wiring without the core
   does not build.
3. `server/relaydecision.ts` is the **regression anchor** (23 tests,
   transport-agnostic) — HANDOFF says it *"must not change"*. Run it after
   every extraction step.

## Recommended PR order

**PR 0 — isolation headers** (~8 lines of `routes.ts`, hunk-extracted).
COOP/COEP so ONNX gets 8 threads instead of 1. Independent of everything
else once extracted; biggest win per line in the whole branch.

**PR 1 — the SFU (#104)** = A + B + C + H + I. ~45 files. Large, but it is one
coherent thing tied to an existing upstream issue, with its own spec, handoff
doc and 41+ passing tests. Splitting it further creates PRs that do not build.

**PR 2 — mic/HUD truth** (D). Display-vs-reality fixes: the glyph said MIC OFF
while the SFU published; the sensitivity bar read a dead transport. Depends on
PR 1 (it fixes what the SFU wiring exposed).

**PR 3 — audio panel + TTS** (E + F). Kept TOGETHER deliberately: 4 commits
straddle the E/F line (`97053ba`, `2deab0d`, `6881582`, `69016d4`), so
splitting them means hunk surgery for no reviewer benefit.

## Verify before declaring done

```bash
# nothing left behind: this must print NOTHING
git diff upstream/main..relay-spike --name-only | sort > /tmp/a
cat <every PR branch's file list> | sort -u > /tmp/b
comm -23 /tmp/a /tmp/b
```
A file in `/tmp/a` but not `/tmp/b` is work about to be lost.

---

## PR 0 — measured, 2026-08-16 (`tools/tts-threading-bench.mjs`)

Two servers, same commit, only `isolate()` differing. Chromium-1228 (the pin
every other browser smoke uses). 4 phrases × 2 repeats per arm.

| | bare `:8974` | isolated `:8960` |
|---|---|---|
| `crossOriginIsolated` | false | **true** |
| `SharedArrayBuffer` | false | **true** |
| ORT `numThreads` | **1** | **8** |
| median warm synthesis | 853.8ms | **695.9ms** |
| ms per 1k samples | 14.70 | **11.22** |
| cold load (63MB model + graph opt) | 55.1s | **47.2s** |

**Length-normalized: 1.31× faster. Raw median: 1.23×. Cold load: 1.17× (−7.8s).**

🔴 **The win SCALES WITH UTTERANCE LENGTH** — which is the number that matters,
because long utterances are what froze the page:

| chars | bare ms/1k | isolated ms/1k | speedup |
|---|---|---|---|
| 34 | 19.12 | 16.75 | 1.14× |
| 38 | 15.30 | 12.82 | 1.19× |
| 45 | 15.75 | 12.97 | 1.21× |
| **104** | 12.70 | **8.28** | **1.53×** |

🔴 **Do not write "8× faster" in the PR.** Threads went 1→8; wall-clock went
1.2–1.5×. Piper is a small model with sequential structure, so most of the
graph does not parallelize. The honest claim is *"1.3× overall, 1.5× on long
utterances, and ORT stops silently running single-threaded."*

**Validity guards this bench carries** (engine-piper.js:344-378 is why):
`noise_w` makes the same text produce different-length audio, and length IS
latency (RTF ≈ 1.1). So it reports sample counts per run and normalizes by
them; the arms differed by <1% in total audio, so the raw and normalized
figures agree. It also asserts the two arms actually reported DIFFERENT
`crossOriginIsolated` — an A/B that silently didn't vary is the failure this
would otherwise ship.

Reproduce: `node tools/tts-threading-bench.mjs --isolated 8960 --bare 8974`
(bare arm = worktree at HEAD with `git revert --no-commit 919c0d1`).

---

## Found while testing, NOT fixed — for later, deliberately

**Display names cap at 64 chars and TRUNCATE silently** (`server/server.ts:469`,
`.slice(0, 64)`). R pasted a URL into the name field on mobile and joined as
`phone_testhttps://mazda-mic-joy-conducted.trycloudflare.com/?wor` — exactly 64
characters, so the guard fired correctly and still produced a nonsense identity.

R: "it's probably more of a length problem. Names (especially display names)
have no business being that long."

Two separate things worth deciding together:
1. **64 is too generous** for a display name — something like 32 is plenty.
2. **Truncating is the wrong failure.** It manufactured a valid-looking name
   from a mis-paste, so nothing told anyone it was wrong. A refusal ("that name
   is too long") is honest; a silent trim is how a paste becomes an identity.

Deliberately NOT fixed today: it is unrelated to the SFU/audio work, it touches
the join path (which every client depends on), and changing an identity rule
mid-test would have muddied the captions measurement. Belongs in its own small
PR with a decision about the limit.

## Follow-up for the UI redesign — spacing has NO tokens

Found 2026-08-16 while matching the audio panel to the sky panel. The client has
real design tokens for **colour and type** (`--accent`, `--edge`, `--dim`,
`--fs-sm`) and panels use them correctly. It has **none for spacing**: 25
hardcoded `gap:` values across `index.html`, `audiopanel.js` and `voicelist.js`,
and no `--space`/`--gap` variable anywhere.

That is why the audio panel drifted to `gap: 10px; margin: 5px 0` while the
house row (`index.html:307`) is `gap: 7px` with no vertical margin — there was
nothing to inherit, so a new panel invented its own and nobody could see the
difference without measuring.

Matched by hand for now. **The real fix is spacing tokens both panels read**,
which belongs in the UI redesign R has already said is coming — building it
today would touch every panel and then be thrown away.

## 🔴 "Fixed by a reload" — three times on 2026-08-16

Three separate "bugs" this session were a page running stale modules:
the /audio tally that appeared missing, the `— last event:` string that proved
an old chat.js, and STT that "stopped working" and returned after a reload.

Cause is structural, not carelessness: the world server was restarted **eleven
times** in one session and each restart serves new code to pages that never
re-import it. A long-lived tab drifts arbitrarily far from the tree.

Mitigation shipped: `/audio` ends with `build: <stamp>`. A report whose stamp is
not current is a stale page, and the correct response is "reload", not
debugging. **Check the stamp before believing any other field.**
