// micgate — the noise gate as a GAIN, not a switch.
//
// R, 2026-08-09: "why not do the WebAudio graph now? I'm worried we'll forget
// about it if we wait." Right on both counts — and "later" is how a boolean gate
// becomes permanent.
//
// WHY A GRAPH AT ALL. Gating with `track.enabled` is binary and abrupt: the
// track goes from full to digital silence between one 40ms tick and the next.
// That is an audible click at both ends, and the opening click lands on your
// first consonant — the worst possible place. BasisVR gates with a smoothed
// gain (BasisLocalMicrophoneDriver: `_noiseGateGain` lerped toward 0/1 with
// attack/release coefficients), which is the right shape and needs per-sample
// access we did not have while handing the raw device track to WebRTC.
//
// The graph:
//
//     voiceSource()  →  MediaStreamSource  →  GainNode  →  MediaStreamDestination
//                                               ↑                     ↓
//                                        gate (this file)    the track WebRTC sends
//
// The analyser still reads the SOURCE side, not the gated side — measuring after
// the gate would be a feedback loop: gain drops, measured level drops, gate
// closes harder, and it latches shut. The gate must always judge the true input.
//
// 🔴 This wraps humans AND agents alike, because voiceSource() is the one seam
// both come through (a human gets a microphone, an agent gets its synthesizer).
// An agent's speech is loud and continuous, so it sails through the gate — but
// it means an agent whose synth emits room tone between utterances is quiet for
// the same reason a human is, with no second code path to maintain.

import { audioContext } from './audioctx.js';
import { report } from './base.js';

// 🔴 THE ENVELOPE IS setTargetAtTime, AND THE TICK IS A FLOOR UNDER IT.
//
// Two things ate the first syllable and only one of them was a constant.
// R, 2026-08-09: "lower the gate time to start capturing? The first syllable
// sounds a little chopped off."
//
//   1. THE TICK. driveGate() cannot react faster than it is called. That was a
//      40ms onset tick; it is 20ms now, below the ~30ms where a missing onset
//      becomes audible.
//   2. THE TIME CONSTANT. setTargetAtTime reaches ~63% of target in one tau and
//      ~95% in three, so tau 0.008s is ~95% open in 24ms.
//
// Worst case is tick + envelope: ~44ms now, against ~160ms before. A plosive is
// ~20-40ms, so that is the difference between "puh" and "uh".
//
// Release stays slow on purpose: 0.12s is a soft ~360ms tail, and the 700ms
// hang-time runs BEFORE the fade begins, so a pause mid-sentence never reaches
// it. Attack always faster than release — opening late loses a consonant,
// closing early cuts a word in half.
//
// (Superseded, kept only as a warning: BasisVR's 0.10/0.05 are per 20ms audio
// FRAME, and copying them onto our tick took 300ms to reach 90% — an audible
// fade-in on the first word, worse than the click it replaced. Their rates are
// not our rates. An earlier lerp-based pass here used 0.35/0.18 and is gone
// entirely; do not resurrect a second smoothing stage, see driveGate.)
const ATTACK_TAU = 0.008;
const RELEASE_TAU = 0.12;
// 🔴 LOOKAHEAD — the third thing that ate first syllables, and the one no
// attack speed can fix (R, 2026-08-16: "Hello often sounds like 'ello'").
// An unvoiced /h/ is LOW-ENERGY: it never crosses the threshold at all, so
// the gate opens on the vowel and the consonant is already gone — a detector
// problem, not an envelope problem. The fix every hardware gate uses: delay
// the AUDIO, not the DETECTOR. The analyser reads the raw side (pre-delay),
// so when the vowel trips the gate, the /h/ is still inside the delay line
// and passes through the opening gain. Cost: 50ms of outbound latency, well
// under the network's own jitter buffer; the close tail grows by the same
// 50ms, which the 700ms hang-time already dwarfs.
const LOOKAHEAD = 0.05;

let _ctx = null, _src = null, _gain = null, _dest = null, _look = null;
let _rawStream = null, _gatedStream = null, _level = () => 0;

/** Wrap a mic stream in the gate graph. Returns the stream to hand to WebRTC —
 *  or the original stream unchanged if the graph cannot be built, because a
 *  voice that works ungated beats no voice at all. */
// ── declared vs effective (#90 review B2, 2026-08-11) ───────────────────────
// If the gate graph cannot be built, the OLD behavior returned the raw device
// stream — every room sound transmitted ungated while the UI still showed
// sensitivity controls. A privacy control that silently downgrades to "off"
// is worse than none. Now: construction failure REFUSES the stream (caller
// gets null and must not transmit) unless the user has explicitly chosen
// ungated transmission via allowUngated(true). Machine-visible either way.
let _gateUnavailable = false;   // the graph could not be built on this device
let _ungatedConsent = false;    // explicit "transmit raw anyway" choice
export const gateUnavailable = () => _gateUnavailable;
export const ungatedConsent = () => _ungatedConsent;
export function allowUngated(on) { _ungatedConsent = !!on; }

export function gateStream(stream, levelFn) {
  release();
  _rawStream = stream;
  _level = levelFn || (() => 0);
  try {
    _ctx = audioContext();
    if (!_ctx || typeof _ctx.createMediaStreamDestination !== 'function') {
      _gateUnavailable = true;
      return _ungatedConsent ? stream : null;   // fail CLOSED, not raw
    }
    _gateUnavailable = false;
    _src = _ctx.createMediaStreamSource(stream);
    _gain = _ctx.createGain();
    // Start CLOSED. Opening on the first frame would broadcast whatever the room
    // is doing at the instant the mic opens — the exact leak the settle window
    // exists to prevent, and the one R heard as "picking up background noise".
    _gain.gain.value = 0;
  // A fresh lane IS closed — say so. `_wanted` outlives the graph it described;
  // without this reset gateOpenness() reports the pre-release value (1 if the
  // gate was open when the device was released), so micTransmitting() claims
  // "audible now" before a single driveGate tick has run on the new lane.
  _wanted = 0;
    _dest = _ctx.createMediaStreamDestination();
    // src → lookahead delay → gate gain → destination. See LOOKAHEAD.
    //
    // 🔴 THE LOOKAHEAD IS POLISH, THE GATE IS THE PRODUCT (#131 re-review).
    // Built unguarded, a context without createDelay (a minimal WebAudio
    // environment — the lifecycle suite's fake, and any constrained embedder)
    // threw here, and the catch below turned "no 50ms lookahead" into the
    // fail-closed NO-GATE-AT-ALL path: mic on yielded no lane, no raw stream,
    // no senders — the whole voice stack regressed to protect a nicety. An
    // enhancement's absence must cost exactly the enhancement.
    _look = null;
    if (typeof _ctx.createDelay === "function") {
      try {
        _look = _ctx.createDelay(0.2);
        _look.delayTime.value = LOOKAHEAD;
      } catch { _look = null; /* no lookahead on this device — gate still real */ }
    }
    if (_look) { _src.connect(_look); _look.connect(_gain); }
    else _src.connect(_gain);
    _gain.connect(_dest);
    _gatedStream = _dest.stream;

    // Carry the original track's identity forward where it matters: muting still
    // operates on the RAW track (see voice.js), so both streams stay live and the
    // gate only decides how much of the raw signal reaches the destination.
    return _gatedStream;
  } catch (e) {
    report('mic gate graph', e);
    release();
    // FAIL CLOSED (B2): "ungated beats silent" was the old rule, and it made
    // the sensitivity UI a lie whenever WebAudio broke. Silent-with-a-reason
    // beats secretly-raw; allowUngated(true) is the explicit way back.
    _gateUnavailable = true;
    return _ungatedConsent ? stream : null;
  }
}

/** Drive the gain from the gate decision. `open` is the gate's boolean; the
 *  smoothing lives here so the decision logic stays readable. */
export function driveGate(open) {
  if (!_gain || !_ctx) return;
  // 🔴 DO NOT DOUBLE-SMOOTH. This used to compute a lerped step and then hand it
  // to setTargetAtTime — which is ITSELF an exponential approach, so the gain
  // never actually reached the step, and reading .value back on the next tick
  // fed that lag forward. The result was a gate that never fully closed: R heard
  // her own monitor ignoring the sensitivity setting entirely (2026-08-09).
  //
  // setTargetAtTime already IS the envelope. Target the true endpoint (1 or 0)
  // and let the time constant do the shaping — one smoothing stage, not two.
  const target = open ? 1 : 0;
  const tau = open ? ATTACK_TAU : RELEASE_TAU;
  try {
    _gain.gain.setTargetAtTime(target, _ctx.currentTime, tau);
  } catch { _gain.gain.value = target; }
  _wanted = target;
}


// ── MONITOR: hear your own lane, exactly as the room hears it ───────────────
// R, 2026-08-09: "can you feed my own audio lane back to me for this test so I
// can hear myself?" — the only way to judge whether the gate clips a consonant
// or trails too long is to hear the GATED signal, not the raw mic.
//
// 🔴 Tapped AFTER the gain node, so it carries the gate: when the gate closes,
// the monitor goes quiet too. A monitor on the raw source would sound perfect
// while the room heard nothing, which is precisely the confusion this is meant
// to resolve.
//
// 🔴 FEEDBACK: on speakers this WILL howl — mic hears monitor hears mic. Ship it
// at a low default, and say so in the UI rather than discovering it at volume.
let _mon = null, _delay = null, _wanted = 0;
// Long enough to be heard as a separate event rather than as an echo of your
// own voice. Tunable live via setMonitorDelay() while testing.
let MONITOR_DELAY = 0.4;
export function setMonitor(on, level = 0.35) {
  if (!_ctx || !_gain) return false;
  if (!on) {
    if (_mon) {
      try { _mon.disconnect(); } catch { /* gone */ }
      try { _delay?.disconnect(); } catch { /* gone */ }
      _mon = null; _delay = null;
    }
    return false;
  }
  if (!_mon) {
    _mon = _ctx.createGain();
    // A DELIBERATE DELAY. R, 2026-08-09: "can you delay the sound a bit so it's
    // easier to hear? It's so quick it's actually hard to tell if I'm hearing it
    // in the environment or in my headphones." Zero-latency monitoring is
    // correct for performing and useless for TESTING — it phases with your own
    // voice conducting through your skull and becomes indistinguishable from the
    // room. 400ms is past the echo threshold (~50ms), so it reads as a distinct
    // repeat you can compare against what you just said: did the gate clip the
    // start of that word, or not?
    // Same guard as the lookahead above: the delay is the FEATURE here rather
    // than polish, but a context without createDelay should yield zero-latency
    // monitoring (degraded, still audible), not an uncaught throw from a
    // settings checkbox (second-agent review of 6231c37 — the exact class the
    // lookahead fix closed, one function over).
    _delay = null;
    if (typeof _ctx.createDelay === "function") {
      try {
        _delay = _ctx.createDelay(2.0);
        _delay.delayTime.value = MONITOR_DELAY;
      } catch { _delay = null; }
    }
    if (_delay) { _gain.connect(_delay); _delay.connect(_mon); }
    else _gain.connect(_mon);
    _mon.connect(_ctx.destination);
  }
  // setTargetAtTime, not a bare assignment: a step change in a monitor path is
  // an audible click straight into your ears.
  try { _mon.gain.setTargetAtTime(level, _ctx.currentTime, 0.02); }
  catch { _mon.gain.value = level; }
  return true;
}
export const monitoring = () => !!_mon;

/** Is any signal actually reaching the wire right now? The honest answer to
 *  "am I being broadcast", read from the gain itself rather than inferred. */
// Reports the gate's INTENT, not the instantaneous .value: during a fade the
// real gain is mid-slope, and an indicator that flickers through every envelope
// would misreport 'am I being heard' at exactly the moments that matter.
export const gateOpenness = () => (_gain ? _wanted : 0);
export const gateGainNow = () => (_gain ? _gain.gain.value : 0);
export const isGated = () => !!_gain;

// ── MIX A SYNTHESIZED VOICE INTO THE SAME LANE ─────────────────────────────
// 🔴 R, 2026-08-09: "sometimes I toggle the mic and it seems to be live and
// sometimes not... fine if I toggle it first before touching TTS, and it breaks
// forever if I touch TTS first."
//
// Exact diagnosis. voiceSource() was an EITHER/OR: `if (isTtsEnabled()) return
// synth-track; else return microphone`. That is an agent-shaped assumption — a
// synthesizer REPLACES the mic — and it is wrong for a human who has a voice AND
// wants TTS. Enable TTS first and the mic toggle silently hands the mesh a
// generator instead of a microphone, forever, with every check reporting healthy.
//
// A synth is not a replacement for a mouth; it is another thing that makes sound
// in the same room. So it mixes in AFTER the gate: your room noise must clear a
// threshold, but synthesized speech is already the signal and must never be
// gated by it.

/** Detach the DEVICE from the lane, keeping the lane itself alive.
 *
 *  🔴 This is the one that matters for reconnect cost. The GainNode and the
 *  MediaStreamDestination stay — so the track every peer's sender holds is still
 *  live, and no renegotiation is needed when the mic comes back. Only the
 *  source-side connection goes away, because its device track just stopped.
 *
 *  R, 2026-08-09: "we don't want to tear down audio tracks at all unless someone
 *  leaves or unchecks the connect-to-audio box — that's how we ran into people
 *  not hearing each other and unmute lag while it sets it all up again." */
export function detachSource() {
  try { _src?.disconnect(); } catch { /* already gone */ }
  _src = null;
  _rawStream = null;
  if (_gain) _gain.gain.value = 0;        // lane open, silent
}

/** Reconnect a new device stream into the EXISTING lane. Returns the same gated
 *  stream the senders already hold, so nothing downstream changes. */
export function attachSource(stream) {
  if (!_ctx || !_gain || !_dest) return null;
  try { _src?.disconnect(); } catch { /* fine */ }
  _src = _ctx.createMediaStreamSource(stream);
  // Through the SAME lookahead as gateStream — reattaching without it would
  // silently lose the first syllable again, on exactly the reconnect path
  // nobody re-tests by ear.
  if (_look) _src.connect(_look); else _src.connect(_gain);
  _rawStream = stream;
  return _gatedStream;
}

/** Full teardown — the lane included. ONLY for leaving the world or revoking
 *  consent, never for going quiet: this is the path that costs a renegotiation
 *  to undo. */
export function release() {
  try { _src?.disconnect(); } catch { /* already gone */ }
  try { _look?.disconnect(); } catch { /* already gone */ }
  _look = null;
  try { _gain?.disconnect(); } catch { /* already gone */ }
  // Disposal OWNERSHIP (#90 review): this module built the monitor tap and the
  // synth mix-in, so this module disconnects them — a release that leaves its
  // own nodes wired into a dead graph is the asymmetric repair again.
  try { _mon?.disconnect(); } catch { /* already gone */ }
  _mon = null;
  // Deliberately does NOT stop the destination's tracks: they belong to the
  // stream WebRTC holds, and stop() is a one-way door. The caller's own sender
  // cleanup owns that.
  _src = _gain = _dest = null;
  _gatedStream = null;
  _rawStream = null;
}

/** The RAW stream, for anything that must measure the true input — the analyser
 *  especially. Measuring the gated output would make the gate self-latching. */
export const rawStream = () => _rawStream;

/** Retune the monitor delay live, in seconds (0…2). For finding the spacing that
 *  makes a clipped consonant obvious rather than ambiguous. */
export function setMonitorDelay(sec) {
  MONITOR_DELAY = Math.max(0, Math.min(2, Number(sec) || 0));
  if (_delay && _ctx) {
    try { _delay.delayTime.setTargetAtTime(MONITOR_DELAY, _ctx.currentTime, 0.05); }
    catch { _delay.delayTime.value = MONITOR_DELAY; }
  }
  return MONITOR_DELAY;
}
export const monitorDelay = () => MONITOR_DELAY;

// ── the onset machine + level meter, ONE copy (§24l R1, survey A1) ──────────
// This state machine lived twice — voice.js (the mesh) and micstate.js (the
// transport seam) — as a ~200-line verbatim fork, and fixes landed in one
// copy at a time (the speaking-latch and analyser-leak fixes sat in the copy
// that never ran until R0 ported them back). One factory now; each transport
// instantiates with its own stream/mute closures. Every comment below was
// paid for in production — they travel with the machine.

/** RMS level meter over whatever stream `getMeasured` currently names —
 *  null means "muted or no stream": report 0 and learn nothing.
 *
 *  ONE CONTEXT, REUSED: this used to make a NEW AudioContext per stream
 *  change and never close the old one — Chrome caps a document at ~6, after
 *  which every further context is born unusable, SILENTLY. And the replaced
 *  analyser pair is DISCONNECTED — the shared context lives forever, so
 *  dropped-but-connected nodes accumulate in its graph otherwise. */
export function makeLevelMeter(getMeasured) {
  let _an = null, _anStream = null, _anBuf = null, _anSrc = null;
  return function level() {
    const measured = getMeasured();
    if (!measured) return 0;
    if (!_an || _anStream !== measured) {
      try {
        const ctx = audioContext();
        try { _anSrc?.disconnect(); _an?.disconnect(); } catch { /* gone */ }
        const src = ctx.createMediaStreamSource(measured);
        _an = ctx.createAnalyser(); _an.fftSize = 512;
        src.connect(_an);
        _anSrc = src;
        _anStream = measured;
        _anBuf = new Float32Array(_an.fftSize);
      } catch { return 0; }
    }
    _an.getFloatTimeDomainData(_anBuf);
    let s = 0;
    for (let i = 0; i < _anBuf.length; i++) s += _anBuf[i] * _anBuf[i];
    return Math.sqrt(s / _anBuf.length);
  };
}

/** The speech-onset gate: BasisVR's block-minima noise floor, a fixed
 *  threshold with ~3dB hysteresis and 700ms hang-time, and the once-per-
 *  utterance 🎙 announcement. `drive(open)` is the transport's gain hand
 *  (it applies its own lane/mute authority first); `level()` returning 0
 *  means muted — close, drop the speaking latch, learn nothing.
 *
 *  Laws kept from the twins' histories:
 *  - DRIVE THE GATE BEFORE ANY EARLY RETURN (a control loop that skips its
 *    output stage is not a control loop — the monitor played through);
 *  - LEARN BEFORE JUDGING (~1s settle window, or a loud room fires the 🎙
 *    at itself);
 *  - the floor is min-of-block-minima (6 × 0.4s), so SPEECH CAN NEVER
 *    RAISE IT — structurally, not by tuning;
 *  - THE PILL AND THE AUDIO MUST AGREE: announce only after the gate has
 *    been open one envelope's worth (60ms), max once per 1.5s;
 *  - `speaking` reports threshold PLUS hang-time, or the bar flickers dark
 *    through every pause while the room still hears you;
 *  - 20ms tick: the interval is the worst-case clip on a word's attack. */
export function makeOnsetGate({ level, threshold, drive, announce }) {
  let _timer = null, _above = false, _lastOnset = 0, _openUntil = 0;
  let _openedAt = 0, _announced = false;
  let _noise = 0.01, _settle = 0;
  let _blocks = new Array(6).fill(Infinity), _blockIdx = 0, _blocksFilled = 0,
      _blockMin = Infinity, _blockStart = 0;

  const apply = (now) => drive(_above || now <= _openUntil);

  function tick() {
    const lv = level();
    if (lv <= 0) {
      // muted: close, do not learn — and DROP THE SPEAKING LATCH, or
      // info().speaking reports true forever while the gate is forced shut
      _above = false; _openUntil = 0;
      apply(Date.now()); return;
    }
    if (_settle < 8) {
      _settle++;
      const a0 = lv < _noise ? 0.3 : 0.5;
      _noise += (lv - _noise) * a0;
      apply(Date.now());               // measuring, but still CLOSED — not frozen
      return;
    }
    const nowT = Date.now();
    if (lv < _blockMin) _blockMin = lv;
    if (nowT - _blockStart >= 400) {
      _blockStart = nowT;
      _blocks[_blockIdx] = _blockMin;
      _blockIdx = (_blockIdx + 1) % 6;
      if (_blocksFilled < 6) _blocksFilled++;
      _blockMin = Infinity;
    }
    _noise = Math.max(1e-5, Math.min(_blockMin, ...(_blocks.slice(0, _blocksFilled))));
    const on = threshold();
    const off = on * 0.7;                    // ~3 dB of hysteresis
    const now = Date.now();
    if (lv >= on) {
      _openUntil = now + 700;                // hang-time
      if (!_above) { _above = true; _openedAt = now; _announced = false; }
      if (!_announced && now - _openedAt >= 60 && now - _lastOnset > 1500) {
        _announced = true; _lastOnset = now; announce();
      }
    } else if (_above && lv < off && now > _openUntil) _above = false;
    apply(now);
  }

  return {
    /** Re-measure the room on every start: a floor learned in a quiet
     *  session would gate you out of a loud one. */
    start() {
      if (_timer) return;
      _above = false;
      _noise = 0.01; _settle = 0;
      _blocks = new Array(6).fill(Infinity); _blockIdx = 0; _blocksFilled = 0;
      _blockMin = Infinity; _blockStart = Date.now();
      _timer = setInterval(tick, 20);
    },
    stop() {
      if (_timer) { clearInterval(_timer); _timer = null; }
      _above = false;
    },
    /** Apply the current latch through the transport's authority — the
     *  external gateAudio (mute toggles call it directly). */
    apply,
    /** Drop the speaking latch without stopping the watch — unmute hands
     *  control back to the gate rather than reopening mid-latch. */
    dropLatch() { _above = false; _openUntil = 0; },
    info: () => ({ level: level(), noise: _noise, on: threshold(),
      speaking: _above || Date.now() <= _openUntil }),
  };
}
