// micstate — the mic's audio machinery, independent of how the audio LEAVES.
//
// 🔴 WHY THIS EXISTS (2026-08-16). All of this lived in voice.js, the MESH
// transport, and voice.js was its only production caller. So the SFU — the
// transport we actually ship — published the RAW device stream:
//
//     mesh:  micStream = gateStream(rawMic, micAnalyserLevel)   // gated
//     sfu:   micStream = s                                      // raw
//
// Verified by count: 8 gate calls in voice.js, ZERO across voicesfu.js,
// voicesfubridge.js and voicesource.js. Every SFU call has been sending
// continuous room tone with the sensitivity slider doing nothing — not a
// regression, it was never wired on this transport. (voicesfu.js's own comment
// says synthetic streams are marked "so the gate is skipped", written as though
// a gate existed to skip.)
//
// Found because R asked "have you read ALL of the audio code?" — I had not.
//
// Nothing here knows about peers, SDP or transports. A transport calls
// gateFor(rawStream) and publishes what it gets back.

import { bus, flashHint } from './core.js';
import { sendTyping } from './net.js';
import { gateThreshold } from './voiceconsent.js';
import { gateStream, attachSource, driveGate, setMonitor, monitoring,
         gateUnavailable, ungatedConsent, isGated } from './micgate.js';

// 🔴 MUTE AND LANE LIVE HERE NOW, not in a transport. They were voice.js
// module state (`muted`, `micStream`), which is why the SFU had no mute at all:
// pressing the HUD mic on the SFU path returns at voice.js:508 before touching
// `muted`, so the flag could never be set — and voicemouths.js:57 read it
// anyway, on BOTH transports. A muted mic is a fact about the microphone, not
// about how its audio leaves the machine.
let _lane = null;          // the stream currently on the wire (gated or synth)
let _muted = false;

export const isMuted = () => _muted;
export function toggleMute(on) {
  _muted = on === undefined ? !_muted : !!on;
  gateAudio(Date.now());   // apply immediately — mute is authoritative
  bus.emit('audio:mute', _muted);
  return _muted;
}

let _noise = 0.01;
let _settle = 0;
// BasisVR's block tracker: 6 × 0.4s minima. See onsetTick.
let _blocks = new Array(6).fill(Infinity), _blockIdx = 0, _blocksFilled = 0,
    _blockMin = Infinity, _blockStart = 0;
function onsetTick() {
  const level = micAnalyserLevel();
  // 🔴 DRIVE THE GATE BEFORE ANY EARLY RETURN. Both of the bails below (muted /
  // silent, and the settle window) used to skip gateAudio() entirely — so the
  // gain simply KEPT ITS LAST VALUE. If the gate happened to be open when you
  // stopped talking into silence, or during the first second after unmuting, it
  // stayed open and the monitor played straight through: R, twice, "hear myself
  // isn't obeying the mic sensitivity". A control loop that skips its output
  // stage is not a control loop.
  if (level <= 0) { gateAudio(Date.now()); return; }   // muted: close, do not learn

  // LEARN BEFORE JUDGING. The floor starts cold at 0.01, so in a loud room the
  // first second reads as "way above the floor" and fires the 🎙 at the room
  // itself — which is exactly what R saw: "it seemed like mic sensitivity was
  // picking up a fair amount of background noise". Simulation put essentially
  // every remaining false trigger in this window. Spend the first ~1s measuring
  // only. Erring here is free: nobody speaks in the first tick after unmuting,
  // and a missed onset costs an icon, not audio (audio always flows).
  if (_settle < 8) {
    _settle++;
    const a0 = level < _noise ? 0.3 : 0.5;
    _noise += (level - _noise) * a0;
    gateAudio(Date.now());               // measuring, but still CLOSED — not frozen
    return;
  }

  // NOISE FLOOR: minimum-of-block-minima, ported from BasisVR
  // (BasisNoiseFloorTracker, MIT — R: "I'll bet money BasisVR already solved
  // this"; she was right, and their design is better than the follower I
  // hand-tuned). 6 blocks × 0.4s: take the quietest RMS in each block, then the
  // quietest block. The floor therefore tracks the quietest moment in the last
  // ~2.4s, so SPEECH CAN NEVER RAISE IT — structurally, not by tuning. My
  // exponential follower could be dragged up by a long utterance and gate the
  // speaker out mid-sentence; this cannot, and needed no rate constant at all.
  const nowT = Date.now();
  if (level < _blockMin) _blockMin = level;
  if (nowT - _blockStart >= 400) {
    _blockStart = nowT;
    _blocks[_blockIdx] = _blockMin;
    _blockIdx = (_blockIdx + 1) % 6;
    if (_blocksFilled < 6) _blocksFilled++;
    _blockMin = Infinity;
  }
  _noise = Math.max(1e-5, Math.min(_blockMin, ...(_blocks.slice(0, _blocksFilled))));

  // THRESHOLD IS MULTIPLICATIVE, not additive — also theirs (AutoGateOverNoise
  // = 2.5). This is the same lesson as "a fixed 0.04 cannot work across mics",
  // one level up: an ADDITIVE margin is still an absolute number, so it is
  // wrong at a different gain. `floor × k` scales with the signal and is the
  // only form that behaves the same on a headset and a laptop array.
  //
  // The slider picks k over 1.6…5.0, with 2.5 (their default) mid-scale.
  // FIXED THRESHOLD, Discord-style. The noise floor is still measured (it drives
  // nothing now but is kept for the meter and for diagnosing "why did it not
  // open"), but the GATE compares against an absolute dB level the user set.
  // That is what makes the marker stay put while the level moves past it.
  const on = gateThreshold();
  const off = on * 0.7;                    // ~3 dB of hysteresis

  const now = Date.now();
  if (level >= on) {
    _openUntil = now + 700;               // hang-time: see gateAudio()
    if (!_above) { _above = true; _openedAt = now; _announced = false; }
    // 🔴 THE PILL AND THE AUDIO MUST AGREE. R: "sometimes I can see the TTS voice
    // threshold getting triggered (pill over the head) without hearing anything
    // through hear-myself — these should have the exact same gate."
    //
    // They shared the threshold but not the OBSERVABLE. The pill fired the instant
    // `_above` flipped; the audio rides an envelope, so a single-tick spike (a
    // cough, a key) trips the flag and is nearly inaudible before the gate shuts.
    // Announce only once the gate has been open long enough to have actually
    // PASSED audio — one envelope's worth. The pill then means "the room heard
    // something", which is what a pill over your head claims.
    if (!_announced && now - _openedAt >= 60 && now - _lastOnset > 1500) {
      _announced = true; _lastOnset = now; sendTyping(null, 'mic');
    }
  } else if (_above && level < off && now > _openUntil) _above = false;
  gateAudio(now);
}

// 🔴 THE GATE MUST GATE THE AUDIO, NOT JUST THE ICON. R, 2026-08-09: "I would
// DEFINITELY gate the mic sensitivity to cover the full audio channel so every
// little background noise isn't broadcasted to the room. That's extra confusing
// because we have no affordance to say when audio is getting broadcasted."
//
// She is right and I had this backwards: I spent an hour tuning this thing as an
// INDICATOR problem, when the indicator was reporting truthfully — audio really
// was always flowing. Your keyboard, your fan and your family went to the room
// whenever the mic was open, and the only thing the threshold changed was a
// glyph. A "sensitivity" control that does not control what anyone hears is
// worse than none, because it reads as if it does.
//
// track.enabled is the right mechanism: universal (unlike
// MediaStreamTrackGenerator, which is Chromium-only), synchronous, spec-mandated
// to render silence, and already what mute uses — so this cannot fight it.
//
// HANG-TIME, not a hard cut. Speech is full of gaps: stops, breaths, the pause
// before a clause. Closing the instant level drops chops words in half, so the
// gate stays open 700ms past the last sound above threshold and only then
// closes. Cost is 700ms of room tone after each utterance; the alternative is
// being unintelligible.
function gateAudio(now) {
  if (!_lane || _muted) { driveGate(false); return; }   // mute is authoritative
  driveGate(_above || now <= _openUntil);
}
/** What the gate is actually doing right now — for the meter and for tuning.
 *  Exposed because "why did it not trigger" is unanswerable from the outside:
 *  the same RMS means different things in different rooms. */
export const micGateInfo = () => ({
  level: micAnalyserLevel(), noise: _noise,
  // 🔴 ONE formula, not a copy. This drifted the moment the gate went
  // multiplicative — it still carried the old additive margin, so the panel and
  // the gate reported DIFFERENT thresholds. Derived from the same expression
  // now; if the gate changes, this cannot silently disagree.
  on: gateThreshold(),
  // 🔴 THRESHOLD *PLUS HANG-TIME* — R: "turn the bar gold when it's streaming
  // live audio over the threshold + hangtime". `_above` alone goes false the
  // instant your level dips, but the gate is still open for another 700ms and
  // the room is still hearing you. Reporting _above would make the bar flicker
  // dark through every pause in a sentence while audio was flowing: an
  // indicator that contradicts the thing it indicates.
  speaking: _above || Date.now() <= _openUntil,
});
function startOnsetWatch() {
  if (_onsetTimer) return;
  _above = false;
  // Re-measure the room on every mic open. A floor learned in a quiet session
  // would gate you out of a loud one — and worse, a floor learned while a fan
  // was running stays high after it stops. Start low and let the follower rise;
  // erring quiet costs a few false 🎙 in the first second, erring loud costs
  // your first sentence.
  _noise = 0.01;
  _settle = 0;
  _blocks = new Array(6).fill(Infinity); _blockIdx = 0; _blocksFilled = 0;
  _blockMin = Infinity; _blockStart = Date.now();                            // re-learn the room, then judge
  // 40ms, not 120: the tick interval is the WORST-CASE CLIP on the first
  // syllable now that this gates audio. 120ms removes an audible chunk of a
  // word's attack; 40ms is under the threshold where a missing onset is
  // perceptible, and the work per tick is one FFT read.
  _onsetTimer = setInterval(onsetTick, 20);
}
function stopOnsetWatch() {
  if (_onsetTimer) { clearInterval(_onsetTimer); _onsetTimer = null; }
  _above = false;
}

// live mic level 0..1 for UI (the mic glyph's hot-glow) — analyser built
// lazily on first ask, rebuilt if the stream changed
let _an = null, _anStream = null, _anBuf = null, _anCtx = null;
export function micAnalyserLevel() {
  // muted → 0 (nothing is being sent, and the gate must not learn a floor from
  // a muted mic). But NOT gated → 0: the gate needs the true input level to
  // decide when to reopen, which is the whole reason we measure the raw side.
  if (!_lane || _muted) return 0;
  const measured = _raw || _lane;
  if (!_an || _anStream !== measured) {
    try {
      // ONE CONTEXT, REUSED. This made a NEW AudioContext every time the mic
      // stream changed and never closed the old one — and Chrome caps a
      // document at ~6, after which every further context is born unusable and
      // SILENTLY so. Toggle the mic a few times and whatever asks next gets a
      // dead one.
      const ctx = audioContext();
      const src = ctx.createMediaStreamSource(measured);
      _an = ctx.createAnalyser(); _an.fftSize = 512;
      src.connect(_an);
      _anStream = measured;
      _anBuf = new Float32Array(_an.fftSize);
    } catch { return 0; }
  }
  _an.getFloatTimeDomainData(_anBuf);
  let s = 0;
  for (let i = 0; i < _anBuf.length; i++) s += _anBuf[i] * _anBuf[i];
  return Math.sqrt(s / _anBuf.length);
}

// ── the transport-facing seam ───────────────────────────────────────────────

let _raw = null, _gated = null, _released = false;

/** Gate a raw device stream and return what should go on the wire.
 *  A SYNTHETIC source bypasses the gate outright: no room noise to gate, and
 *  the gate's WebAudio graph cannot carry it on a stalled headless clock — the
 *  generator track goes out as-is, frames as data. Same rule voice.js:610-615
 *  applied; it is the source's nature that decides, never the transport's. */
export function gateFor(rawStream) {
  if (!rawStream || rawStream.synthetic) { _raw = _gated = _lane = rawStream; return rawStream; }
  _raw = rawStream;
  // Reuse a standing lane: attachSource returns the same gated stream the
  // senders already hold, so returning from a release costs zero renegotiation.
  const reused = _released ? attachSource(rawStream) : null;
  _released = false;
  _gated = reused || gateStream(rawStream, micAnalyserLevel);
  _lane = _gated;
  startOnsetWatch();
  return _gated;
}

/** True when the gate refused to build (no AudioContext, etc). A transport must
 *  decide whether to publish ungated — never do it silently. */
export const gateIsUnavailable = () => gateUnavailable();
export const ungatedAllowed = () => ungatedConsent();
export const gateActive = () => isGated();
export const rawMicStream = () => _raw;

/** Stop the onset watcher and forget the lane (device release is the caller's). */
export function gateRelease() {
  stopOnsetWatch();
  _released = true;
  _gated = _lane = null;
}

/** Hear your own lane, exactly as the room hears it. Tapped AFTER the gate's
 *  gain node (micgate.js:150), so when the gate closes the monitor goes quiet —
 *  a monitor on the raw source would sound perfect while the room heard
 *  nothing, which is the confusion it exists to resolve. */
export function selfMonitor(on, level = 0.35) { setMonitor(on, level); }
export const selfMonitoring = () => monitoring();
