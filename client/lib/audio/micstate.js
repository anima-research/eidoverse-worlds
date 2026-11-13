// micstate — the mic's audio machinery, independent of how the audio LEAVES.
//
// Owns the gate lane, mute, push-to-talk, the onset watcher and the one answer to
// "is my mic on" (micOn). Nothing here knows about peers, SDP or transports: a
// transport calls gateFor(rawStream) and publishes what it gets back.

// flashHint lives in ui.js; lazy-imported at its one call site so headless
// contexts that touch the mic don't drag in ui.js (and THREE).
import { bus } from '../base.js';
// tone 'attn': a press that did not turn the mic on is "something you asked for didn't happen, and why" (ui.js flashHint)
const flashHint = (msg) => import('../ui.js').then((u) => u.flashHint(msg, 4000, 'attn')).catch(() => {});
import { sendTyping } from '../net.js';
import { gateThreshold, pttMode } from './voiceconsent.js';
import { gateStream, attachSource, detachSource, driveGate, driveRawTracks, setMonitor, monitoring,
         gateUnavailable, ungatedConsent,
         makeOnsetGate, makeLevelMeter } from './micgate.js';
// The analyser hangs off the shared context; without this import the meter
// silently reads 0 inside its own catch.
import { audioContext } from './audioctx.js';

// Mute and the lane are microphone facts, not transport facts, so they live here.
let _lane = null;          // the stream currently on the wire (gated or synth)
let _muted = false;

export const isMuted = () => _muted;
export function toggleMute(on) {
  _muted = on === undefined ? !_muted : !!on;
  gateAudio(Date.now());   // apply immediately — mute is authoritative
  bus.emit('audio:mute', _muted);
  return _muted;
}

// ── push-to-talk: the key IS the gate ───────────────────────────────────────
// In PTT mode the level machinery keeps running (meter, noise floor) but the gate
// DECISION is the held key alone, not key AND level. The micgate envelope and
// lookahead still shape the open. Mute stays authoritative above this.
let _pttHeld = false;
export const pttHeld = () => _pttHeld;
export function setPttHeld(on) {
  const next = !!on;
  if (next === _pttHeld) return;
  _pttHeld = next;
  const now = Date.now();
  // The press is a gesture: announce the 🎙 on it, through the machine's
  // once-per-1.5s rate limit.
  if (next && pttMode() && micOn()) _onset.press(now);
  gateAudio(now);   // apply immediately — a 20ms tick is an audible latency here
}
bus.on('audio:ptt', (on) => {
  const now = Date.now();
  if (on) {
    // Arming closes the gate now, not on the next tick: on an ungated lane that
    // tick would be a window of raw transmission.
    gateAudio(now);
    return;
  }
  // Leaving PTT with the key down: drop it, so the next regime starts closed.
  if (_pttHeld) _pttHeld = false;
  // The drive closure restores an ungated lane to raw-and-open unless muted or
  // the device is off — one writer for the raw tracks.
  gateAudio(now);
});

// The onset watcher: micgate.js's makeOnsetGate/makeLevelMeter, instantiated
// over this module's own lane and mute.
const _meter = makeLevelMeter(() => (!_lane || _muted) ? null : (_raw || _lane));
const _onset = makeOnsetGate({
  level: _meter,
  threshold: gateThreshold,
  drive: (open) => {
    // The machine's decision (level, or the held key) is one input; the lane's
    // authority is the other, and it is the same answer micOn() gives everyone:
    // a lane exists, a device is capturing, and the person has not muted.
    const want = micOn() ? open : false;
    driveGate(want);
    // No graph (gate unavailable, raw consented): the decision goes to the raw
    // tracks. PTT closes the wire; voice activation leaves the lane raw, but only
    // while the mic is on. The transport writes the same answer, so a tick can
    // never re-open what the microphone control closed.
    if (gateUnavailable()) driveRawTracks(pttMode() ? want : micOn());
  },
  announce: () => sendTyping(null, 'mic'),
  // PTT hands the machine a held answer; null means "decide by level".
  held: () => (pttMode() ? _pttHeld : null),
});
const gateAudio = (now) => _onset.apply(now);
const startOnsetWatch = () => _onset.start();
const stopOnsetWatch = () => _onset.stop();

/** What the gate is actually doing right now — for the meter and for tuning. */
// `speaking` is what the room gets: the lane's authority (no lane, muted) is
// applied here as in the drive closure, so the pill and the audio agree.
export const micGateInfo = () => {
  const info = _onset.info();
  return micOn() ? info : { ...info, speaking: false };
};

/** Live mic level 0..1 for UI. */
export function micAnalyserLevel() { return _meter(); }

// ── the transport-facing seam ───────────────────────────────────────────────

let _raw = null, _gated = null, _released = false;

/** Gate a raw device stream and return what should go on the wire.
 *  A SYNTHETIC source bypasses the gate: no room noise to gate, and the WebAudio
 *  graph can't carry it on a stalled headless clock. The source's nature
 *  decides, never the transport. */
export function gateFor(rawStream) {
  if (!rawStream || rawStream.synthetic) { _raw = _gated = _lane = rawStream; return rawStream; }
  _raw = rawStream;
  // Reuse a standing lane: attachSource returns the same gated stream the
  // senders already hold, so returning from a release costs zero renegotiation.
  const reused = _released ? attachSource(rawStream) : null;
  _released = false;
  _gated = reused || gateStream(rawStream, micAnalyserLevel);
  _lane = _gated;
  _deviceLive = true;
  startOnsetWatch();
  // Apply the current authority (mute, held key) synchronously: an ungated raw
  // track arrives enabled, and the first tick is 20 ms away.
  gateAudio(Date.now());
  return _gated;
}

/** True when the gate refused to build (no AudioContext, etc). A transport must
 *  decide whether to publish ungated — never do it silently. */
export const gateIsUnavailable = () => gateUnavailable();
export const ungatedAllowed = () => ungatedConsent();
export const rawMicStream = () => _raw;

/** Stop the onset watcher and forget the lane (device release is the caller's). */
export function gateRelease() {
  stopOnsetWatch();
  _released = true;
  _gated = _lane = null;
}

/** Turn the mic on or off. The ONE entry point every UI uses. */
export async function toggleMic() {
  const fn = typeof window !== 'undefined' ? window.__sfuMic : null;
  // The server's "no relay" outranks the hook: voicesfubridge installs __sfuMic
  // whatever the server runs, so without this a relay-less world swallows every
  // ON press. net.js sets __voiceRelayAbsent. (Turning OFF still goes through.)
  if (!fn || (typeof window !== 'undefined' && window.__voiceRelayAbsent && !micOn())) {
    // No bridge yet: relay still connecting, or this world has none (net.js flags it).
    flashHint(window.__voiceRelayAbsent
      ? 'this world has no voice relay — the mic can\'t go live here'
      : 'voice is still connecting — try again in a moment');
    return micOn();
  }
  const on = await fn();
  bus.emit('audio:mic', on);
  return on;
}

/** THE ONE ANSWER TO "IS MY MIC ON". A mic is on when a LANE exists, a DEVICE
 *  is capturing, and the person has not muted. Transports report device
 *  liveness through setMicLive(); everything else in the client asks HERE. */
let _deviceLive = false;
export function setMicLive(on) {
  const next = !!on;
  if (next === _deviceLive) return;
  _deviceLive = next;
  // Liveness is part of the gate's authority, so re-apply now: on mic ON the
  // transport re-enables an ungated raw track and PTT-with-key-up must close it.
  gateAudio(Date.now());
}
export const micOn = () => !!_lane && _deviceLive && !_muted;
/** The device leg of micOn() on its own — what the transport last reported.
 *  Readable so a harness can tell "no lane" from "lane, device off"; the UI
 *  keeps asking micOn(). */
export const micDeviceLive = () => _deviceLive;

/** Release the DEVICE while keeping the lane.
 *  (1) The raw device track stops, so the OS recording indicator goes out.
 *  (2) The GATED track does not: a MediaStreamDestination track can't restart,
 *      so stopping it would cost a new graph and a renegotiation with every peer.
 *  Reacquiring reconnects a new source into the same graph at zero cost. */
export function releaseMicrophone() {
  if (!_lane) return;
  // Stop ONLY the raw device, never `_lane` (rule 2). Where the lane IS the
  // device (synthetic / gate-unavailable, raw === lane) rule 1 wins. _raw is null
  // after the first release, so repeats are harmless.
  if (_raw) for (const t of _raw.getTracks()) t.stop();
  _deviceLive = false;
  driveGate(false);
  detachSource();
  _raw = null;
  _released = true;
  stopOnsetWatch();
  bus.emit('audio:mic', false);
}

/** Hear your own lane, exactly as the room hears it (tapped after the gate). */
export function selfMonitor(on, level = 0.35) { return setMonitor(on, level); }
export const selfMonitoring = () => monitoring();
