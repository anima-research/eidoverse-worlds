// micgate — the noise gate as a smoothed gain, not a track.enabled switch (which clicks at both ends, the opening
// click on the first consonant). The gate is a GainNode with an attack/release envelope:
//
//     voiceSource()  →  MediaStreamSource  →  GainNode  →  MediaStreamDestination
//                                               ↑                     ↓
//                                        gate (this file)    the track WebRTC sends
//
// The analyser reads the SOURCE side: measuring after the gate is a feedback loop
// that latches shut. voiceSource() is the one seam for humans and agents; a
// synthetic source bypasses the gate (micstate.js gateFor).
//
// Also here: the ungated-lane fallback, the self-monitor tap, and the shared onset
// machine + level meter (makeOnsetGate / makeLevelMeter).

import { audioContext } from './audioctx.js';
import { report } from '../base.js';

// Envelope time constants (s) for setTargetAtTime: ~95% of target in 3·tau, so attack is ~95% open in 24 ms;
// worst-case onset is the 20 ms tick + envelope ≈ 44 ms. Attack stays faster than release (a late open loses a
// consonant, an early close cuts a word). The 700 ms hang-time runs before the release fade.
const ATTACK_TAU = 0.008;
const RELEASE_TAU = 0.12;
// Lookahead (s): delay the audio, not the detector, so a low-energy onset (/h/) that never crosses the threshold is
// still in the delay line when the vowel opens the gate. Costs 50 ms of outbound latency.
const LOOKAHEAD = 0.05;

let _ctx = null, _src = null, _gain = null, _dest = null, _look = null;
let _rawStream = null, _gatedStream = null, _level = () => 0;

// If the graph can't be built, gateStream fails closed (returns null) unless the person explicitly chose ungated
// transmission via allowUngated(true): a privacy control must never silently downgrade to "off".
let _gateUnavailable = false;   // the graph could not be built on this device
let _ungatedConsent = false;    // explicit "transmit raw anyway" choice
export const gateUnavailable = () => _gateUnavailable;
export const ungatedConsent = () => _ungatedConsent;
export function allowUngated(on) { _ungatedConsent = !!on; }

/** Wrap a mic stream in the gate graph. Returns the gated stream for WebRTC, or
 *  null when the graph can't be built (the raw stream under allowUngated). */
export function gateStream(stream, levelFn) {
  release();
  _rawStream = stream;
  _level = levelFn || (() => 0);
  try {
    _ctx = audioContext();
    if (!_ctx || typeof _ctx.createMediaStreamDestination !== 'function') {
      _gateUnavailable = true;
      _rawWanted = _ungatedConsent ? 1 : 0;      // a consented raw lane is open until PTT says otherwise
      return _ungatedConsent ? stream : null;   // fail CLOSED, not raw
    }
    _gateUnavailable = false;
    _src = _ctx.createMediaStreamSource(stream);
    _gain = _ctx.createGain();
    // start closed: opening on the first frame would broadcast the room before the settle window has learned its
    // noise floor. `_wanted` outlives the graph, so reset it or gateOpenness() reports the previous lane's state.
    _gain.gain.value = 0;
  _wanted = 0;
    _dest = _ctx.createMediaStreamDestination();
    // src → lookahead delay → gate gain → destination. Without createDelay, connect straight through: a missing
    // enhancement must not fall into the fail-closed no-gate path.
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

    // muting operates on the raw track (micstate.js), so both streams stay live and the gate only decides how much
    // of the raw signal reaches the destination
    return _gatedStream;
  } catch (e) {
    report('mic gate graph', e);
    release();
    // fail closed; allowUngated(true) is the explicit way back to raw
    _gateUnavailable = true;
    return _ungatedConsent ? stream : null;
  }
}

/** Drive the gain from the gate decision. `open` is the gate's boolean; the smoothing lives here. */
export function driveGate(open) {
  if (!_gain || !_ctx) return;
  // one smoothing stage: setTargetAtTime is the envelope, so target the true endpoint (pre-lerping the step
  // double-smooths and the gate never fully closes)
  const target = open ? 1 : 0;
  const tau = open ? ATTACK_TAU : RELEASE_TAU;
  try {
    _gain.gain.setTargetAtTime(target, _ctx.currentTime, tau);
  } catch { _gain.gain.value = target; }
  _wanted = target;
}

// ── the ungated lane's only gate ─────────────────────────────────────────────
// On the consented raw lane there is no gain for driveGate() to drive, so push-to-talk toggles the raw tracks'
// `enabled` instead. Intent is recorded so gateOpenness() reports what the wire is doing.
let _rawWanted = 0;
export function driveRawTracks(open) {
  if (!_rawStream) return false;
  for (const t of _rawStream.getAudioTracks?.() ?? []) t.enabled = !!open;
  _rawWanted = open ? 1 : 0;
  return true;
}


// ── monitor: hear your own lane, exactly as the room hears it ───────────────
// Tapped after the gain, so it carries the gate (a raw-source monitor would sound fine while the room heard
// nothing). On speakers this will feed back: keep the default level low and say so in the UI.
let _mon = null, _delay = null, _wanted = 0;
// long enough to be heard as a separate event rather than as an echo of your own voice (setMonitorDelay retunes it)
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
    // a deliberate delay, past the ~50 ms echo threshold, so you can hear whether the gate clipped a word; the same
    // createDelay guard as the lookahead
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
  // setTargetAtTime, not a bare assignment: a step change in a monitor path is an audible click
  try { _mon.gain.setTargetAtTime(level, _ctx.currentTime, 0.02); }
  catch { _mon.gain.value = level; }
  return true;
}
export const monitoring = () => !!_mon;

/** Is any signal reaching the wire right now? Reports the gate's intent, not the mid-fade .value, so the indicator
 *  never flickers through an envelope. */
export const gateOpenness = () => (_gain ? _wanted : (_gateUnavailable && _rawStream ? _rawWanted : 0));
export const gateGainNow = () => (_gain ? _gain.gain.value : 0);


/** Detach the device from the lane, keeping the lane alive: the GainNode and destination stay, so every peer's
 *  sender still holds a live track and the mic can come back without renegotiation. */
export function detachSource() {
  try { _src?.disconnect(); } catch { /* already gone */ }
  _src = null;
  _rawStream = null;
  if (_gain) _gain.gain.value = 0;        // lane open, silent
}

/** Reconnect a new device stream into the existing lane. Returns the same gated stream the senders already hold. */
export function attachSource(stream) {
  if (!_ctx || !_gain || !_dest) return null;
  try { _src?.disconnect(); } catch { /* fine */ }
  _src = _ctx.createMediaStreamSource(stream);
  // through the same lookahead as gateStream, or a reattach loses the first syllable
  if (_look) _src.connect(_look); else _src.connect(_gain);
  _rawStream = stream;
  return _gatedStream;
}

/** Full teardown, the lane included. Only for leaving the world or revoking consent, never for going quiet: this
 *  path costs a renegotiation to undo. */
export function release() {
  try { _src?.disconnect(); } catch { /* already gone */ }
  try { _look?.disconnect(); } catch { /* already gone */ }
  _look = null;
  try { _gain?.disconnect(); } catch { /* already gone */ }
  try { _mon?.disconnect(); } catch { /* already gone */ }
  _mon = null;
  // deliberately does not stop the destination's tracks: they belong to the stream WebRTC holds, and stop() is a
  // one-way door; the caller's sender cleanup owns that
  _src = _gain = _dest = null;
  _gatedStream = null;
  _rawStream = null;
  _rawWanted = 0;
}

/** The raw stream, for anything that must measure the true input (the analyser: measuring the gated output would
 *  make the gate self-latching). */
export const rawStream = () => _rawStream;

/** Retune the monitor delay live, in seconds (0…2); unused in-repo, kept for console tuning. */
function setMonitorDelay(sec) {
  MONITOR_DELAY = Math.max(0, Math.min(2, Number(sec) || 0));
  if (_delay && _ctx) {
    try { _delay.delayTime.setTargetAtTime(MONITOR_DELAY, _ctx.currentTime, 0.05); }
    catch { _delay.delayTime.value = MONITOR_DELAY; }
  }
  return MONITOR_DELAY;
}

// ── the onset machine + level meter ─────────────────────────────────────────
// micstate.js (the transport seam) instantiates each with its own stream/mute closures.

/** RMS level meter over whatever stream `getMeasured` currently names; null means "muted or no stream": report 0
 *  and learn nothing. Reuses the one shared AudioContext and disconnects the replaced analyser pair. */
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

/** The speech-onset gate: a block-minima noise floor, a fixed threshold with ~3 dB hysteresis and 700 ms hang-time,
 *  and the once-per-utterance 🎙 announcement. `drive(open)` is the transport's gain hand (it applies its own
 *  lane/mute authority first); `level()` returning 0 means muted: close, drop the speaking latch, learn nothing.
 *
 *  Invariants:
 *  - drive the gate before any early return;
 *  - learn before judging (~1 s settle window, or a loud room fires the 🎙 at itself);
 *  - the floor is min-of-block-minima (6 × 0.4 s), so speech can never raise it;
 *  - announce only after the gate has been open 60 ms, max once per 1.5 s, so the pill and the audio agree;
 *  - `speaking` reports threshold plus hang-time, or the bar flickers through pauses;
 *  - 20 ms tick: the interval is the worst-case clip on a word's attack. */
export function makeOnsetGate({ level, threshold, drive, announce, held = () => null }) {
  let _timer = null, _above = false, _lastOnset = 0, _openUntil = 0;
  let _openedAt = 0, _announced = false;
  let _noise = 0.01, _settle = 0;
  let _blocks = new Array(6).fill(Infinity), _blockIdx = 0, _blocksFilled = 0,
      _blockMin = Infinity, _blockStart = 0;

  // Push-to-talk is a mode of this machine: `held()` returns null when the level decides, else the key's boolean.
  // The level side keeps running (meter, noise floor), but under a held answer it never fires the 🎙; press()
  // announces instead, through the same rate limit.
  const decide = (now) => { const h = held(); return h === null ? (_above || now <= _openUntil) : h; };
  const apply = (now) => drive(decide(now));

  function tick() {
    const lv = level();
    if (lv <= 0) {
      // muted: close, do not learn, and drop the speaking latch (or info().speaking reports true while forced shut)
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
      if (held() === null && !_announced && now - _openedAt >= 60 && now - _lastOnset > 1500) {
        _announced = true; _lastOnset = now; announce();
      }
    } else if (_above && lv < off && now > _openUntil) _above = false;
    apply(now);
  }

  return {
    /** Re-measure the room on every start: a floor learned in a quiet session would gate you out of a loud one. */
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
    /** Apply the current latch through the transport's authority (mute toggles call it directly). */
    apply,
    /** Drop the speaking latch without stopping the watch: unmute hands control back to the gate. */
    dropLatch() { _above = false; _openUntil = 0; },
    /** A push-to-talk press: announce the 🎙, under the same once-per-1.5 s limit as a level onset. The caller
     *  applies the gate. */
    press(now = Date.now()) {
      if (now - _lastOnset > 1500) { _lastOnset = now; announce(); }
    },
    /** `speaking` is what the room is getting: the held answer when there is one, else threshold plus hang-time. */
    info: () => ({ level: level(), noise: _noise, on: threshold(),
      speaking: decide(Date.now()) }),
  };
}
