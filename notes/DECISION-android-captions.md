# Captions on Android — the decision, not the bug

*2026-08-16. Written because R asked for higher-level planning after I burned
two theories guessing. The facts below are researched, not inferred.*

## What is actually true

- **Chromium issue [40324711](https://issues.chromium.org/issues/40324711)** —
  "Web Speech API: Continuous speech recognition is broken on Android."
  `continuous` does not work: recognition stops after ~3–4s of no speech
  regardless of the flag. Upstream has debated faking it vs throwing
  not-supported, and done neither.
- **The documented workaround is restarting in `onend`** — which `stt.js`
  already does, and has since long before today.
- **On Android that restart plays the OS earcon every time.** R's "chime every
  6–8 seconds" IS the workaround. It is not a notification and not our sound.
- **`webkitSpeechRecognition` is cloud-based on every platform.** Chrome on
  Android exposes the on-device API but ships no models
  (`available({processLocally:true})` → "unavailable"); Samsung Internet
  exposes only the legacy cloud constructor. There is no setting where
  captions keep audio on the device.
- Our consent dialog (`voiceconsent.js:128`) already says audio goes to the
  browser vendor's speech service, platform-neutrally. **Nothing to fix there.**

**So Android captions are: audible chiming, and unreliable text.** Both are
consequences of one upstream defect we cannot fix from here.

## What this is NOT

Not an SFU problem. **Bidirectional audio phone↔desktop over a real network is
PROVEN** (2026-08-16, R's Galaxy, both directions confirmed by ear). Captions
are a separate feature, and this decision must not be allowed to hold the SFU
PR hostage.

## The options

### A. Detect Android and don't offer captions there
Cheapest, most honest. `sttAvailable()` returns false on Android Chrome; the
toggle does not appear; a line explains why.
- ✅ No chiming, no false promise, no privacy exposure for a feature that does
  not work anyway.
- ❌ Removes a feature that *sometimes* produces a line before dying.
- ❌ UA sniffing, which ages badly — and upstream may fix this, at which point
  our block is the bug.

### B. Ship it degraded, and SAY so
Keep the restart loop, add a one-time notice on Android: "captions are
unreliable on this platform and your phone will chime — Chromium bug 40324711".
- ✅ No capability removed; the person decides with real information.
- ❌ The chiming is genuinely unpleasant and we would be shipping it knowingly.

### C. Restart smarter: only while speech is actually happening
We already run a local analyser for mouth-flap (`voice.js`). Gate the `onend`
restart on recent speech energy, so a silent room stops the loop — the chime
then only fires while someone is actually talking, which is both less frequent
and arguably meaningful feedback.
- ✅ Keeps captions, kills most of the chiming, no UA sniffing.
- ❌ More moving parts; still one chime per utterance; still cloud.
- ⚠️ UNVERIFIED — I have not tested whether Android finalizes a result within
  the window a single utterance provides. **Would need a real test on R's phone
  before anyone believes it.**

### D. Local whisper (already the file's stated plan, `stt.js:12`)
whisper.cpp/transformers.js in a worker. The say-pipe is unchanged — this
swaps only the engine.
- ✅ Fixes Android AND the privacy problem AND the chime, all at once.
- ✅ The isolation headers landed this morning (PR 0) are a prerequisite:
  threaded WASM is what makes local inference viable in-page. **We already
  measured 1.31× overall, 1.53× on long utterances.**
- ❌ Real work: model download (~40–75MB), worker, VAD, latency budget.
- ❌ Its own PR, its own scope.

## Recommendation

**C or B now, D as the real answer, A only if C fails the test.**

The sequencing matters more than the choice: **none of this blocks the SFU
PR.** Captions are one platform's degraded feature; the SFU's claim is proven.
Anything here that grows past a few lines should be its own PR after the split,
not smuggled into it.

## The one measurement that would decide C

On a real Android phone: start recognition, speak ONE sentence, stop.
Does `onresult` fire with `isFinal` before the session dies?
- If yes → C works, and captions become per-utterance rather than continuous.
- If no → Android cannot finalize within a session at all, C is dead, and the
  choice collapses to A/B until D.

`/audio`'s tally (`[start×N audiostart×N result:final×N …]`) answers this
directly. It is one test on the device already in R's hand.

---

## MEASURED 2026-08-16 18:11Z — captions WORK on Android, unreliably

R's Galaxy, Chrome, page stamped `stt-diag-5`, after speaking "Hello":

```
stt ▸ build stt-diag-5 · lang en-US · stt ON ·
start×7 audiostart×7 sound×6 speech×6 speechend×6
nomatch×4 end×5 result:final×3 err:aborted×1
```

**Three `🎙 Hello` lines actually landed in the world log.** So:

- ✅ **`result:final×3`** — Android DOES finalize. Captions work.
- ⚠️ **`speech×6` vs `final×3` + `nomatch×4`** — roughly half of heard
  utterances come back as text, half come back empty.
- ✅ **`lang en-US`** — the language suspect is cleared.

### This REVERSES the plan above

Every option in this file assumed captions were broken on Android. They are
not. They are **unreliable** — a materially different thing:

- **A (block on Android) is now WRONG.** It would disable a working feature.
- **The behavioural "zero finals → give up" check is also WRONG**, for the
  reason R gave before any of this was measured: absence of results is not
  evidence of breakage. Here there were finals; a check watching for their
  absence would have fired during the four nomatches and disabled captions
  mid-conversation, on a device where they work.
- **B (ship with a notice)** is defensible if the chiming is the complaint.
- **D (local whisper)** remains the real upgrade — it fixes the ~50% miss rate,
  the chime, and the privacy exposure together.

### What I got wrong, recorded because the pattern repeated

Three theories before measuring — contention, restart-loop, never-finalizing —
**all three about the session's LIFECYCLE**, because that was the code I had
been reading. The truth was in recognition QUALITY, which I never proposed. The
instrument answered in one line what an hour of theorising did not, and R's
"maybe you should research this before guessing more" was the turn that got us
here.

### Still open

- The ~50% miss rate: is it acoustic (phone mic already committed to WebRTC,
  reaching the recognizer processed), or the Chromium bug's session churn
  clipping utterances? `err:aborted×1` and `end×5` suggest churn is real.
- The chime remains, and remains upstream's.
