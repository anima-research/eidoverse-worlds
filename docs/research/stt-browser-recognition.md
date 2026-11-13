# Browser speech recognition (client/lib/audio/stt.js): field notes

What was learned running captions on the browser's SpeechRecognition. `stt.js` keeps one-line rules; the evidence
lives here.

## Privacy: there is no local mode

`webkitSpeechRecognition` is cloud-based on every platform (researched 2026-08-16). Chrome on Android exposes the newer
on-device API surface but ships no models, so `available({processLocally: true})` always resolves "unavailable";
Samsung Internet exposes only the legacy constructor. No configuration keeps caption audio on the device. Local
whisper is the planned upgrade; the say-pipe stays identical.

## The mic toggle governs every capture

SpeechRecognition holds its OWN microphone, independent of the WebRTC track. A recognizer restarted on `wanted` alone
kept transcribing (and shipping audio to the vendor) while the mic button read off, and a private conversation went
into the world log. Hence: restart only while the mic is live, gate the emit too (a result can arrive after the mic
went off), fail closed when the mic state can't be read, and read the mic from whichever transport is running (the
mesh's `micOn()` is null forever on an SFU client).

## Phones: works about half the time

Measured once, on one device (Samsung Galaxy / Chrome, saying "Hello" repeatedly):
`speech×6 result:final×3 nomatch×4 err:aborted×1`. The tester's mobile data was dropping, and every utterance is a
round trip to Google, so some nomatches may be network. Do not "fix" it by disabling captions on mobile; that was
proposed twice and would have blocked a working feature. Get current numbers first: `/stt` in world chat prints
build, lang, event tally and last event; `/stt say` posts that line into the world. `speech×N` with
`result:final×0` is the broken case; anything with finals is unreliable-but-working.

- `continuous` does not work on Android (https://issues.chromium.org/issues/40324711): recognition stops after a few
  seconds of silence. The workaround is restarting in onend, and on Android every restart plays the OS earcon (heard
  as "a chime every 6-8 seconds"). A session that dies that fast also rarely survives to finalize.
- Android Chrome is reluctant to finalize; a stream of interim results that never flips isFinal looks like silence,
  so both are counted.
- The language is a prime suspect for nomatch: `navigator.language` on a Galaxy may not match what is spoken, and a
  wrong-language recognizer returns confident nothing.

## Diagnostics must exist before they are needed

The phone has no console. The tally and last event are module-scope and assigned at load: a probe that only exists
once STT has run reads exactly like "no events". `flashHint` is a 2.6 s overlay, not a log, so a failure worth telling
someone about goes to the chat log as well.

## Sound is not speech

`soundstart` is any audio; `speechstart` is audio the recognizer judges to be speech. A cough raises only soundstart,
and a healthy recognizer in a quiet room ends with no result. Any "captions are broken here" test must key on
speechstart-with-no-result, never on the absence of results. nomatch (a final result with nothing recognised) gets
one quiet local line, at most every 30 s, never a `say`.

## Captions are derived state

setSTT(true) once had a single caller, the HUD mic button, so a mic turned on any other way (the audio panel, the
reconnect replay after a reload) never started captions. Running STT is derived: consent AND a live mic AND a
recognizer, re-evaluated on `audio:mic` and `audio:stt-consent`.
