# Barge-in: "mic live" should mean SPEAKING, not SWITCHED ON

*Designed 2026-08-16 with R, deliberately NOT built the same day — see the
stop-condition at the bottom.*

## The case it gets wrong

R, testing: "If mic and TTS are on, and you type instead of talk, I would expect
typed words to come out as TTS probably."

Right now `tts.js` discards the typed say entirely and logs
`own say NOT synthesized — mic is live, mic beats TTS`. Someone sitting with an
open mic saying nothing, who types a line, is typing *precisely because* they do
not want to speak it. Discarding it is the wrong call.

## Whose policy this is — checked, not assumed

`git log -S "mic beats TTS"` → **bd3f867, PR #91, 2026-08-12, octopusburrow**
(our own account). The commit message names the designer:

> **Mic beats TTS as a PRIORITY, not a toggle** (R's design, and better than
> the symmetric version I wrote first)

So there is **no upstream reviewer to negotiate with and no external policy to
deviate from**. It is R's own rule, three days old, and she is now looking at
the case it handles badly.

## Why the rule is still right

A body publishes ONE source. `micStream` is a single stream on one peer
connection, so mic and TTS are not two lanes — they compete for the same one.
A priority is the correct shape; a mixer is not available.

**What was never specified is what counts as "live."** In August a mic that was
switched on WAS a mic that was publishing. Barge-in refines the rule rather than
overturning it.

## The design

Replace `micLive` (the switch) with "have I been above the speech threshold
recently?" (the behaviour).

- **Signal:** `sfuMyLevel()` — `voicesfu.js:378`, my own outbound analyser,
  already running continuously for mouth-flap. On-device, instant, no
  permission, no cloud.
- **NOT STT.** Cloud round-trip, ~50% miss measured on R's Galaxy
  (`notes/DECISION-android-captions.md`), and a Google request per decision.
- **Window:** speech in the last ~1-2s counts as live. Needs measuring, not
  guessing — a threshold picked at a desk is how the mic gate got its
  `micFloor` wrong the first time.
- **Two behaviours, decide separately:**
  1. *Gate* — a typed say while genuinely quiet gets synthesized (this is R's ask)
  2. *Interrupt* — speech onset ABORTS an in-flight utterance (the fuller
     version; `stopPacer()` and the queue in `speak()` already exist)

## 🔴 Why this was not built on 2026-08-16

Two regressions shipped that hour, both in `tts.js`: the outbound-gain version
of self-TTS volume (caught mid-build by R) and the shared sidetone gain node
(which silenced her monitoring entirely, reverted in 6010c54). That is the
signal to stop making judgement calls in this file for the day, not to keep
going while the context is warm.

Build it fresh, after the review agents have seen the day's work.
