# relay-spike → PRs: the complete audit

*2026-08-16. Written because we have LOST WORK from staging before by
splitting from memory instead of from the diff. Every claim here is
mechanically derived; the commands are included so it can be re-run.*

## The delta

```
git diff --stat upstream/main..relay-spike
→ 60 files changed, 7015 insertions(+), 84 deletions(-)   (80 commits)
```

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

**27 of 80 commits touch more than one group.** Cherry-picking by commit
drops hunks silently — the exact way work has gone missing before.

Worst offenders:
- `452b7be` (the phase-1 spike) spans **A+B+G+H+I** — five groups, one commit.
- `a99e147` spans **A+B+D+G+H**.
- `6881582` spans **D+E+F**.
- `69016d4` spans **B+E+F**.

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
