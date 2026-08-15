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
import { report } from './core.js';

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

let _ctx = null, _src = null, _gain = null, _dest = null;
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
    _src.connect(_gain);
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
    _delay = _ctx.createDelay(2.0);
    _delay.delayTime.value = MONITOR_DELAY;
    _gain.connect(_delay);
    _delay.connect(_mon);
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
  _src.connect(_gain);
  _rawStream = stream;
  return _gatedStream;
}

/** Full teardown — the lane included. ONLY for leaving the world or revoking
 *  consent, never for going quiet: this is the path that costs a renegotiation
 *  to undo. */
export function release() {
  try { _src?.disconnect(); } catch { /* already gone */ }
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
