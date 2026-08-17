# PR 2 — Remove the mesh: one transport, one playback owner

*Draft. Not pushed. Depends on PR 1.*

## What it does

Deletes `client/lib/voice.js` (1403 lines), the `?mesh=1` arm, and the server's
`rtc` verb. Extracts the transport-neutral half into `client/lib/micstate.js`
first, so nothing is lost with the transport.

**−1563 lines net.**

## Answering #104 A5 directly

A5: *"keep current mesh available as the existing production/rollback path."*

**The rollback path is preserved — it is the revert.** One command, no config
change, no migration, and the mesh is not deleted from history. What a clean
swap buys is **testability**: two live transports mean every audio result
carries the question *"which one produced this?"* — a question that has already
cost real time twice, an hour of "SFU results" that were actually mesh, and a
sidecar signalling happily into an `rtc` verb nobody consumed.

It also satisfies amendment 6's *"exactly one playback owner must be visible at
all times"*, which two transports structurally cannot.

## What moved, and why it had to move first

The mesh was not only a transport — it **housed the shared audio machinery**,
and `voice.js` was the only production caller of all of it:

- **the mic noise gate** (8 gate calls in voice.js; **zero** in the SFU path).
  The SFU published the raw device stream: continuous room tone, sensitivity
  slider driving nothing. Not a regression — never wired on this transport.
- **`micAnalyserLevel` (RMS)** — the measure the sensitivity slider was
  calibrated against by ear. The SFU's own level is **peak**, ~1.4–3x higher
  for speech, so deleting the RMS analyser would have silently re-scaled it.
- **mute**, which the SFU never had (its toggle returned before touching the flag)
- **`releaseMicrophone`** — the only path that stops the device and clears the
  OS recording indicator
- **one `micOn()`** replacing **eight** sources of truth and four different
  fallback ladders, one of which returned a hard `false` with no fallback

## Risk

Highest-risk PR of the set: it removes the fallback. Mitigations —
`micstate.js` is exercised by a test that **executes** all ten exports rather
than grepping (the extraction shipped six undeclared variables that every
source-level check passed), and the whole thing is one revert from restored.

🔴 **Merge only after a real two-browser audio check.** Every mesh bug this year
was found by two real browsers, never by a suite.
