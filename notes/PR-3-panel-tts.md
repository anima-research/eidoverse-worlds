# PR 3 — Audio panel + TTS

*Draft. Not pushed. Independent of PR 1; touches no transport code.*

## What it does

- **The panel stops lying.** Mic meter, volume slider and TTS row each displayed
  a state the system was not in. The TTS row now reads "not available while your
  mic is on" and dims, instead of naming a loaded voice that will never speak.
- **TTS publishes with the mic off.** Four stacked bugs: the SFU called
  `getUserMedia` directly instead of asking the shared seam; the seam treated
  "mic off" and "no mic" as one state; the SFU never registered the
  synth-rebuild hook; and that hook was a single assignment, so two registrants
  silently overwrote each other.
- **"Hear my own mic (monitor)"** — a feature that existed with zero callers.
  It is the instrument that answers "is the gate working?" by ear.
- Three copies of one status string collapsed into one (they had already
  drifted).

## Why panel + TTS ship together

Four commits straddle the two. They were edited together all afternoon because
the panel *displays* TTS state; splitting them would produce two PRs that each
half-explain the same behaviour.

## Note for review

Several tests in this area were found to **import nothing** — they re-typed the
shipped logic inline and asserted against the copy. They are marked as such and
are not evidence. The one that mattered (`voicesource-real-test.mjs`) was
rewritten to import the real module and is mutation-verified against five
mutants.
