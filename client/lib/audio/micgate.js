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
import { report, warnRarely } from '../base.js';

// Envelope time constants (s) for setTargetAtTime: ~95% of target in 3·tau, so attack is ~95% open in 24 ms;
// worst-case onset is the 20 ms tick + envelope ≈ 44 ms. Attack stays faster than release (a late open loses a
// consonant, an early close cuts a word). The 700 ms hang-time runs before the release fade.
const ATTACK_TAU = 0.008;
const RELEASE_TAU = 0.12;
// Lookahead (s): delay the audio, not the detector, so a low-energy onset (/h/) that never crosses the threshold is
// still in the delay line when the vowel opens the gate. Costs 50 ms of outbound latency.
const LOOKAHEAD = 0.05;
// A deliberate close (push-to-talk released, mute, the mic turned off) is a cut, not a fade: a linear ramp to 0 this
// long (s), short enough to be "at once" and long enough not to click. The release fade (RELEASE_TAU) is only the
// voice-activation gate's, after its hang: from full it takes ~0.83 s to fall 60 dB, and sound in it is sent.
// A push-to-talk release is a cut with a tail: what was said while the key was down is still in the lookahead, so its
// ramp starts one lookahead later and the end of the last word goes out. A mute or the mic off cuts from now.
const CUT_S = 0.005;
// The gain is closed (nothing worth calling voice goes out) below this: -60 dB.
const GAIN_CLOSED = 0.001;

let _ctx = null, _src = null, _gain = null, _dest = null, _look = null;
let _rawStream = null, _gatedStream = null, _level = () => 0;

// If the graph can't be built, gateStream fails closed (returns null) unless the person explicitly chose ungated
// transmission via allowUngated(true): a privacy control must never silently downgrade to "off".
let _gateUnavailable = false;   // the graph could not be built on this device
let _ungatedConsent = false;    // explicit "transmit raw anyway" choice
export const gateUnavailable = () => _gateUnavailable;
export const ungatedConsent = () => _ungatedConsent;
// A change of consent takes effect at once, in both directions: revoking closes a live raw lane, and re-consenting
// re-applies the gate's whole answer (micstate.js's drive closure, registered through onUngatedConsent), so the raw
// tracks and what micGateInfo reports agree without waiting for the next tick.
let _onConsent = null;
export const onUngatedConsent = (fn) => { _onConsent = fn; };
export function allowUngated(on) {
  _ungatedConsent = !!on;
  if (!on && _gateUnavailable) driveRawTracks(false);
  try { _onConsent?.(); } catch (e) { report('ungated consent', e); }
}

/** Wrap a mic stream in the gate graph. Returns the gated stream for WebRTC, or
 *  null when the graph can't be built (the raw stream under allowUngated). */
export function gateStream(stream, levelFn) {
  release();
  _rawStream = stream;
  _level = levelFn || (() => 0);
  try {
    _ctx = audioContext();
    anchorOnResume(_ctx);
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
    _env = { at: 0, from: 0, to: 0, tau: RELEASE_TAU * 1000 };
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

    // muting closes this gate too (micstate.js toggleMute → driveGate), so both streams stay live and the gain only
    // decides how much of the raw signal reaches the destination
    return _gatedStream;
  } catch (e) {
    report('mic gate graph', e);
    release();
    // fail closed; allowUngated(true) is the explicit way back to raw, and then the raw tracks are the gate (driveRawTracks)
    _gateUnavailable = true;
    if (_ungatedConsent) { _rawStream = stream; _rawWanted = 1; }
    return _ungatedConsent ? stream : null;
  }
}

// The envelope as scheduled, on the wall clock (performance.now, ms): what the gain is doing now, worked out from what
// was asked of it, so it reads true when the audio clock is not being sampled. { at, from, to, tau } is setTargetAtTime;
// { at, from, cutEnd, tail, pre } is a cut whose ramp runs from `at` to `cutEnd`; until `at` (a tail's hold) the gain
// carries on as `pre`, the envelope before it; `tail` marks a push-to-talk release's, whose sound goes out until cutEnd.
let _env = { at: 0, from: 0, to: 0, tau: RELEASE_TAU * 1000 };
const envAt = (t, e = _env) => {
  if (e.cutEnd !== undefined) {
    if (t < e.at) return e.pre ? envAt(t, e.pre) : e.from;   // the hold: the attack under way runs on through it
    return t >= e.cutEnd ? 0 : e.from * (1 - (t - e.at) / (e.cutEnd - e.at));
  }
  return e.to + (e.from - e.to) * Math.exp(-Math.max(0, t - e.at) / e.tau);
};
// A gain that refuses automation takes a step; what it had accepted is cancelled first (mic-gate-envelope-test.mjs §5).
const stepTo = (p, v) => {
  try { p.cancelScheduledValues(0); } catch { /* refused as well */ }
  try { p.value = v; } catch { /* the graph is gone: nothing is going out */ }
};

/** Drive the gain from the gate decision. `open` is the gate's boolean; the smoothing lives here. `cut` closes in CUT_S
 *  instead of fading (a deliberate close: the key released, mute, the mic off). `tail` (the key released) starts that
 *  cut one lookahead later, so what was said while the key was down still goes out. */
export function driveGate(open, { cut = false, tail = false } = {}) {
  if (!_gain || !_ctx) return;
  const now = performance.now();
  const target = open ? 1 : 0;
  const p = _gain.gain;
  // Where the gain is. Running, the wall-clock model is the gain; suspended, the audio clock (and the gain with it) has
  // stopped while the model ran on, so read the gain itself, or a cut would jump it back up to the model and ramp
  // buffered sound out on resume.
  const level = (t) => {
    if (!gateRunning()) { const g = Number(p.value); if (Number.isFinite(g)) return g; }
    return envAt(t);
  };
  if (!open && cut) {
    // with no delay line there is nothing held back to let out: the tail is the lookahead itself. A suspended context's
    // clock has stopped, so a hold scheduled on it would run only after resume, sending the held word with the tail long
    // over on the wall clock (and no gold): cut at once instead
    const lag = tail && _look && gateRunning() ? LOOKAHEAD : 0;
    const at = now + lag * 1000, cutEnd = at + CUT_S * 1000;
    // A cut already scheduled stands: the 20 ms tick asks again on every pass, and rescheduling would push it later
    // each time. Only a cut that closes sooner replaces it (a mute inside a release's tail: stop now).
    const scheduled = _env.cutEnd !== undefined;
    if (!scheduled || cutEnd < _env.cutEnd) {
      const from = level(at);   // the gain where the ramp starts (a held key's attack runs on through the tail)
      let stepped = false;
      try {
        // cancel from the ramp's start, not from now: a press in this render quantum has its attack at `t` (mic-gate-envelope-test.mjs §2)
        const t = _ctx.currentTime;
        p.cancelScheduledValues(t + lag); p.setValueAtTime(from, t + lag); p.linearRampToValueAtTime(0, t + lag + CUT_S);
      } catch { stepTo(p, 0); stepped = true; }
      // a gain that took a step is shut now: no tail is going out; nor is one from a gain already shut (push-to-talk armed
      // while silent: the cut has nothing in the lookahead to let out)
      _env = stepped ? { at: now, from: 0, cutEnd: now }
        : { at, from, cutEnd, tail: lag > 0 && from > GAIN_CLOSED, pre: lag > 0 && !scheduled ? _env : undefined };
    }
  } else {
    // a close while a cut is scheduled (or has run) leaves the cut: driven again it would become this fade (mic-gate-envelope-test.mjs §3)
    if (!open && _env.cutEnd !== undefined) return;
    const from = level(now);
    // one smoothing stage: setTargetAtTime is the envelope, so target the true endpoint (pre-lerping the step
    // double-smooths and the gate never fully closes)
    const tau = open ? ATTACK_TAU : RELEASE_TAU;
    let stepped = false;
    try {
      // After a cut, cancel what of it the audio clock has not yet run, and hold the gain where it is: a re-press inside a
      // release's tail, or an open after a cut made while the context was suspended, would otherwise meet that cut and
      // close the new word. A cut that has already run is past, so the cancel leaves it be.
      if (_env.cutEnd !== undefined) { const t = _ctx.currentTime; p.cancelScheduledValues(t); p.setValueAtTime(from, t); }
      p.setTargetAtTime(target, _ctx.currentTime, tau);
    } catch { stepTo(p, target); stepped = true; }
    // a gain that took a step is already at its target: no fade to report as sending
    _env = { at: now, from: stepped ? target : from, to: target, tau: tau * 1000 };
  }
  _wanted = target;
}

/** Is the gate's audio graph running? A suspended (or closed) AudioContext sends nothing through the gated lane (no
 *  packets: measured in headless Chrome, while a raw device track keeps sending), whatever the gain says. True with no
 *  graph (a raw or synth lane doesn't pass through it). */
export const gateRunning = () => !_gain || !_ctx?.state || _ctx.state === 'running';
/** Does a release have a lookahead tail to let out? null with no graph yet (a raw or synth lane has none). */
export const gateLookahead = () => (_gain ? !!_look : null);

// The envelope runs on performance.now, the gain on the audio clock, and a suspended context stops only the latter: a
// suspend during the release fade leaves the gain where it was (measured: 0.37 on resume). So when the context runs
// again, the envelope restarts from the gain's own value. A cut is 5 ms and stays a cut.
// A push-to-talk release's tail is the other way about: its hold is scheduled on the audio clock, so a suspend inside it
// leaves the rest of the hold to run on resume, by when the tail is over on the wall clock: the held word would go out
// with no gold. driveGate cuts at once when a tick finds the context suspended, but only if a tick runs in time (timers
// are often throttled when contexts are suspended). So the moment the context leaves 'running', a pending tail is cut
// from the gain's own value, and on resume only the cut's 5 ms ramp is left, as after any cut. Any statechange inside a
// tail cuts it: a suspend and a resume told together, late, both read 'running' (mic-gate-envelope-test.mjs §4).
// One listener per context (_anchored), reading the module's live _ctx, _gain and _env: a rebuilt lane on the same
// context adds none, and a listener on a context the gate has left does nothing.
const _anchored = new WeakSet();
function anchorOnResume(ctx) {
  if (!ctx?.addEventListener || _anchored.has(ctx)) return;
  _anchored.add(ctx);
  ctx.addEventListener('statechange', () => {
    if (ctx !== _ctx || !_gain) return;
    cutPendingTail();
    if (!gateRunning() || _env.cutEnd !== undefined) return;
    let g = NaN;
    try { g = Number(_gain.gain.value); } catch { /* unreadable: keep the envelope */ }
    if (!Number.isFinite(g)) return;
    const tau = _wanted ? ATTACK_TAU : RELEASE_TAU;
    _env = { at: performance.now(), from: g, to: _wanted, tau: tau * 1000 };
  });
}

// The context has stopped (suspended, interrupted, closed) with a release's tail still to run: end the tail here. The
// gain is read, not modelled: the audio clock has stopped, and where it stopped is where the ramp must start. A tail
// the audio clock had already run reads 0, and cutting from 0 changes nothing.
function cutPendingTail() {
  if (_env.cutEnd === undefined || !_env.tail) return;
  const now = performance.now(), p = _gain.gain;
  let stepped = false, from = 0;
  try {
    const g = Number(p.value), t = _ctx.currentTime;
    from = Number.isFinite(g) ? g : envAt(now);
    p.cancelScheduledValues(t); p.setValueAtTime(from, t); p.linearRampToValueAtTime(0, t + CUT_S);
  } catch { stepTo(p, 0); stepped = true; }
  // a cut from now, and no tail: gateSending() and gateTailLeft() stop reporting one (micstate's watch on the old tail
  // still fires at its time, finds none left, and tells the indicators)
  _env = stepped ? { at: now, from: 0, cutEnd: now } : { at: now, from, cutEnd: now + CUT_S * 1000 };
}

/** Is the gated lane still letting sound through? True while the gain is above -60 dB: through the release fade after
 *  the voice-activation hang (sound in it is sent), and through a push-to-talk release's tail until its cut has
 *  closed; false at once after a mute's or mic-off's cut. False with no graph. */
export const gateSending = () => {
  if (!_gain) return false;
  // a cut from now is 5 ms: closed for anything a person or an indicator sees; a tail sends until it has closed
  if (_env.cutEnd !== undefined) return !!_env.tail && performance.now() < _env.cutEnd;
  return envAt(performance.now()) > GAIN_CLOSED;
};
/** How long (ms) until a push-to-talk release's tail has closed; 0 when none is going out. */
export const gateTailLeft = () => (_gain && _env.tail ? Math.max(0, _env.cutEnd - performance.now()) : 0);

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
export function setMonitorDelay(sec) {
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
      } catch (e) { warnRarely('mic-level-build', '[mic] the level meter could not be built; the level reads as silence', e); return 0; }
    }
    _an.getFloatTimeDomainData(_anBuf);
    let s = 0;
    for (let i = 0; i < _anBuf.length; i++) s += _anBuf[i] * _anBuf[i];
    return Math.sqrt(s / _anBuf.length);
  };
}

/** The gate's hang-time: it holds open this long after the last tick over the line. */
export const HANG_MS = 700;
/** A synth frame counts as sound above this RMS (-100 dBFS, under 16-bit audio's -96 dBFS floor; a quieter frame is
 *  still sent, and not counted). A synth lane has no gate; micstate.js reports it speaking while it sends sound, held for
 *  HANG_MS, and tts.js's pacer records when the generator last took a frame over this (audibleAt). */
export const SYNTH_AUDIBLE = 1e-5;

/** The speech-onset gate: a block-minima noise floor, a fixed threshold with ~3 dB hysteresis and 700 ms hang-time,
 *  and the once-per-utterance 🎙 announcement. `drive(open)` is the transport's gain hand (it applies its own
 *  lane/mute authority first); `level()` returning 0 means muted: close, drop the speaking latch, learn nothing.
 *
 *  Invariants:
 *  - drive the gate before any early return;
 *  - learn before judging (~160 ms settle window: 8 ticks; or a loud room fires the 🎙 at itself);
 *  - the floor is min-of-block-minima (6 × 0.4 s), so speech shorter than that 2.4 s window can't raise it;
 *  - announce only after the gate has been open 60 ms, max once per 1.5 s, so the pill and the audio agree;
 *  - `speaking` reports threshold plus hang-time, or the bar flickers through pauses;
 *  - 20 ms tick: the interval is the worst-case clip on a word's attack. */
export function makeOnsetGate({ level, threshold, drive, announce, held = () => null }) {
  let _timer = null, _above = false, _lastOnset = -Infinity, _openUntil = -Infinity;
  let _openedAt = 0, _announced = false;
  let _noise = 0.01, _settle = 0;
  let _blocks = new Array(6).fill(Infinity), _blockIdx = 0, _blocksFilled = 0,
      _blockMin = Infinity, _blockStart = 0;

  // Push-to-talk is a mode of this machine: `held()` returns null when the level decides, else the key's boolean.
  // The level side keeps running (meter, noise floor), but under a held answer it never fires the 🎙; press()
  // announces instead, through the same rate limit.
  const decide = (now) => { const h = held(); return h === null ? (_above || now <= _openUntil) : h; };
  // every time here is performance.now(): a wall-clock step back would hold the hang, and the mic, open (micgate-onset-test.mjs)
  const mono = () => performance.now();
  const apply = () => drive(decide(mono()));
  // an unreadable level is silence to the gate, and is told to the console (base.js warnRarely)
  const read = () => { try { return level(); } catch (e) { warnRarely('mic-level', '[mic] the level could not be read; the gate treats it as silence', e); return 0; } };

  function tick() {
    // a level that can't be read closes the gate, as mute does (a throw here would leave it in its last state, open or not)
    const lv = read();
    if (lv <= 0) {
      // muted: close, do not learn, and drop the speaking latch (or info().speaking reports true while forced shut)
      _above = false; _openUntil = -Infinity;
      apply(); return;
    }
    if (_settle < 8) {
      _settle++;
      const a0 = lv < _noise ? 0.3 : 0.5;
      _noise += (lv - _noise) * a0;
      apply();               // measuring, but still CLOSED — not frozen
      return;
    }
    const nowT = mono();
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
    const now = nowT;
    if (lv >= on) {
      _openUntil = now + HANG_MS;            // hang-time
      if (!_above) { _above = true; _openedAt = now; _announced = false; }
      if (held() === null && !_announced && now - _openedAt >= 60 && now - _lastOnset > 1500) {
        _announced = true; _lastOnset = now; announce();
      }
    } else if (_above && lv < off && now > _openUntil) _above = false;
    apply();
  }

  return {
    /** Re-measure the room on every start: a floor learned in a quiet session would gate you out of a loud one. */
    start() {
      if (_timer) return;   // already watching: nothing below runs, so the latch and the floor carry on as they are
      _above = false; _openUntil = -Infinity;   // a watch started from stopped starts closed, not inside the old hang
      _noise = 0.01; _settle = 0;
      _blocks = new Array(6).fill(Infinity); _blockIdx = 0; _blocksFilled = 0;
      _blockMin = Infinity; _blockStart = mono();
      _timer = setInterval(tick, 20);
    },
    stop() {
      if (_timer) { clearInterval(_timer); _timer = null; }
      _above = false; _openUntil = -Infinity;
    },
    /** Apply the current latch through the transport's authority (mute toggles call it directly). */
    apply,
    /** Drop the speaking latch without stopping the watch: unmute hands control back to the gate. */
    dropLatch() { _above = false; _openUntil = -Infinity; },
    /** A push-to-talk press: announce the 🎙, under the same once-per-1.5 s limit as a level onset. The caller
     *  applies the gate. */
    press() {
      const now = mono();
      if (now - _lastOnset > 1500) { _lastOnset = now; announce(); }
    },
    /** `speaking` is what the room is getting: the held answer when there is one, else threshold plus hang-time. */
    // the level read is guarded here as in tick(): a throw would make every reader (roomHears, the glyph) fail toward
    // not gold while the gate, the held key, a raw lane or a synth voice still sends
    info: () => ({ level: read(), noise: _noise, on: threshold(), speaking: decide(mono()) }),
  };
}
