# The TTS mouth (client/lib/audio/tts.js): design notes

Rationale behind the browser's synthesized-voice path, kept out of the code comments.

## The browser's built-in speechSynthesis cannot feed the mic lane

The Web Speech API offers no route from `speak()` to an AudioNode, MediaStream or Blob. On Linux, synthesis does
not even happen in the browser (speech-dispatcher over a socket), so there is nothing to capture. The spec request to
allow SpeechSynthesis → MediaStreamTrack (WICG/speech-api#69) is open and unimplemented. Routing `speak()` through a
MediaStreamDestination + MediaRecorder records silence: nothing is ever connected to the destination.

So a voice needs a source that RETURNS SAMPLES, any `(text) => {pcm, sampleRate}` with `pcm` in 16-bit range (an
`Int16Array`, or numbers to ±32767: `tts.js` divides by 32768):

- a local synthesizer over the same ws protocol `piperbridge.js` uses;
- an in-browser WASM/WebGPU TTS (Piper via onnxruntime-web, ~75 MB, VITS; kokoro-js, ~82 MB, 21 voices);
- a cloud TTS returning wav/mp3, decoded with `decodeAudioData` (its float channel scaled ×32768 first).

All three go through `setTtsSource` unchanged. The narrow statement is: the BUILT-IN speechSynthesis cannot feed the
mic lane; every other synthesizer can, including ones running in the same page, wherever `MediaStreamTrackGenerator`
exists (Chromium; elsewhere `enqueue` plays the sidetone and sends nothing).

## Why the generator is paced by the wall clock, and never starves

A realtime AudioContext in a headless browser can run its clock at ~1% and stall, so frames are written as DATA to a
MediaStreamTrackGenerator at wall-clock pace. A 10 ms pacer writes exactly as many frames as wall time owes: speech
when there is speech, silence when not. A starved generator is not a quiet microphone; it is a track with no media to
encode, and every local check (samples written, sender bound, ICE connected) passes while the room hears nothing.

## Resampling to 48 kHz ourselves

Piper emits 22050 Hz; WebRTC/Opus encodes at 48000. The ratio is not an integer, and a cheap linear resampler aliases,
worst on short bursts. WebAudio's OfflineAudioContext resamples with a proper filter (the same one the sidetone path
gets), so `resampleTo` hands WebRTC audio already at OUT_RATE. It is switchable (`localStorage.eidoTtsResample = 'off'`)
because it was never verified to beat the browser's own conversion: the short-utterance artefact it targeted turned out
to be missing terminal punctuation (rhasspy/piper#252).

## Length is latency: chunking

Piper's real-time factor is about 1.1, so synthesis costs about as long as the audio. One long `ort.run()` on the main
thread freezes the page for that long. `tts-chunk.js` splits utterances the way the sidecar does, with an aggressive
opening clause, since time-to-first-word is synth(chunk 1). Chunks still run on the main thread; moving inference into
a Worker is the real cure and remains open.

## Cancellation dies at every await

A disable or mic takeover bumps `ttsEpoch`. The epoch is captured once per utterance (so chunks after the one in flight
die too) and checked again at the queue push after the async resample. `stopPacer` also stops already-scheduled
sidetone sources and resets the sidetone playhead, so a cancelled tail is not heard locally and the next utterance does
not queue behind it.

## The sidetone gain

It needs both properties at once: ONE shared node (so a slider drag reaches audio already scheduled ahead; a per-chunk
node set at creation is always one utterance late) and context-tracked (rebuilt when the AudioContext identity changes;
a node on a dead context is silence with no error). Each property alone has regressed before.

Self-TTS volume scales the sidetone only, never the outbound track: every listener already owns 'voices', distance
rolloff and consent, and a sender-side gain would override their settings.

Sidetone chunks are SCHEDULED on their own playhead, not started on arrival: chunks synthesize faster than they play,
and a bare `src.start()` stacks them.

## Mic beats TTS

A typed say while the mic is live is discarded, visibly. On the SFU, `voice.js`'s own `micOn()` reads a stream that is
always null, so both the enable path and the own-say bridge ask the live transport (`window.__sfuMicOn`).
