// micstate — the mic's audio machinery, independent of how the audio LEAVES.
//
// Owns the gate lane, mute, push-to-talk, the onset watcher and the one answer to
// "is my mic on" (micOn). Nothing here knows about peers, SDP or transports: a
// transport calls gateFor(rawStream) and publishes what it gets back.

// flashHint lives in ui.js; lazy-imported at its one call site so headless
// contexts that touch the mic don't drag in ui.js (and THREE).
import { bus } from '../base.js';
// tone 'attn': a press that did not turn the mic on is "something you asked for didn't happen, and why" (ui.js flashHint)
const flashHint = (msg) => import('../ui/ui.js').then((u) => u.flashHint(msg, 4000, 'attn')).catch(() => {});
import { sendTyping } from '../net.js';
import { gateThreshold, pttMode } from './voiceconsent.js';
import { gateStream, attachSource, detachSource, driveGate, driveRawTracks, setMonitor, monitoring,
         gateUnavailable, ungatedConsent, onUngatedConsent,
         makeOnsetGate, makeLevelMeter, HANG_MS, SYNTH_AUDIBLE } from './micgate.js';
// Unused here: the meter (micgate.js makeLevelMeter) takes micgate's own audioContext import.
import { audioContext } from './audioctx.js';

// Mute and the lane are microphone facts, not transport facts, so they live here.
let _lane = null;          // the stream currently on the wire (gated or synth)
let _muted = false;

export const isMuted = () => _muted;
export function toggleMute(on) {
  _muted = on === undefined ? !_muted : !!on;
  // a synth voice heard before this moment is not heard after it: the synth hang restarts here (see micGateInfo)
  _synthFrom = Date.now();
  gateAudio(Date.now());   // apply immediately — mute is authoritative
  applySynthTracks();
  bus.emit('audio:mute', _muted);
  return _muted;
}

// The server's moderator mute (voicesfubridge.js, from your-rights): the SFU drops this speaker at ingress, so the room
// hears nothing whatever the lane does. Not a lane control; roomHears() and the indicators read it.
let _modMuted = false;
export function setModeratorMute(on) {
  const next = !!on;
  if (next === _modMuted) return;
  _modMuted = next;
  bus.emit('audio:mute', _muted);
}
/** Why the room can't hear a lane that is on: 'self' (toggleMute), 'moderator' (the server's mute), or null. */
export const muteReason = () => (_muted ? 'self' : _modMuted ? 'moderator' : null);

// The transport's own on/off for the lane's tracks (voicesfu.js sfuMic writes it here, never on the tracks). A synth
// lane has no gate to close, so mute sits on top of it there: its tracks are on exactly when the transport has them on
// and the person has not muted. Unmute restores the transport's answer, so a track the transport turned off during a
// mute stays off. A device lane's tracks follow the transport alone: mute closes the gate (and the raw lane's tracks,
// in the drive closure).
let _laneOn = true;
export function setLaneEnabled(on, stream = _lane) {
  // a stream that is not (or no longer) the lane has no mute layered on it: its tracks take the answer as it is
  if (stream !== _lane) { for (const t of stream?.getTracks?.() ?? []) t.enabled = !!on; return; }
  _laneOn = !!on;
  if (!_lane) return;
  if (_lane.synthetic) applySynthTracks();
  else for (const t of _lane.getTracks?.() ?? []) t.enabled = _laneOn;
}
function applySynthTracks() {
  if (!_lane?.synthetic) return;
  for (const t of _lane.getTracks?.() ?? []) t.enabled = _laneOn && !_muted;
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
  bus.emit('audio:ptt-held', next);   // stt.js: captions follow the key
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
// One analyser on the device; the gate's meter is it with mute applied (a level of 0 is how the gate closes on mute).
const _deviceMeter = makeLevelMeter(() => _lane ? (_raw || _lane) : null);
const _meter = () => (_muted ? 0 : _deviceMeter());
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
    // while the mic is on, and only while the raw lane is consented. The transport may write a raw track first
    // (voicesfu.js sfuMic(true)); setMicLive and every tick re-apply this answer, so nothing stays open that the
    // microphone control (or a revoked consent) closed.
    if (gateUnavailable()) driveRawTracks(ungatedConsent() && (pttMode() ? want : micOn()));
  },
  announce: () => sendTyping(null, 'mic'),
  // PTT hands the machine a held answer; null means "decide by level".
  held: () => (pttMode() ? _pttHeld : null),
});
const gateAudio = (now) => _onset.apply(now);
const startOnsetWatch = () => _onset.start();
const stopOnsetWatch = () => _onset.stop();

// Re-consenting to a raw lane (micgate.js allowUngated) re-applies the gate at once, so its tracks open in the same call.
onUngatedConsent(() => gateAudio(Date.now()));

// A synth voice has no gate (gateFor passes it through): audible is speaking, held through the gaps between words
// for the onset gate's own hang (micgate.js HANG_MS). When it was last audible is the source's own record where it
// keeps one (tts.js's pacer: `audibleAt` on the synthetic stream, voicesource.js), because the generator reaches WebRTC
// without the AudioContext, whose clock can stall while it plays. A source without one is sampled through the analyser
// on each read. Only sound from _synthFrom on counts: a mute or a new synth lane starts the hang afresh.
let _synthFrom = 0, _synthAt = 0;
function synthHeardAt(level) {
  const at = _lane.audibleAt?.();
  if (typeof at === 'number') return at;
  if (level > SYNTH_AUDIBLE) _synthAt = Date.now();
  return _synthAt;
}
const laneTracks = () => _lane?.getAudioTracks?.() ?? _lane?.getTracks?.() ?? [];
const someTrackOn = (tracks) => tracks.some((t) => t.enabled && t.readyState !== 'ended');

/** What the lane is sending right now, before the transport: the gate's threshold and hang, the held key, mute, a raw
 *  lane, a synth voice. The room hearing it is roomHears(), which adds the transport and the moderator mute. */
export const micGateInfo = () => {
  const info = _onset.info();
  if (_lane?.synthetic) {
    const now = Date.now(), at = synthHeardAt(info.level);
    return { ...info, speaking: !_muted && at >= _synthFrom && now - at <= HANG_MS };
  }
  if (!micOn()) return { ...info, speaking: false };
  // a raw lane has no gain: its tracks are the wire (driven by the drive closure above; consent is what keeps them open)
  if (gateUnavailable()) return { ...info, speaking: ungatedConsent() && someTrackOn(_raw?.getAudioTracks?.() ?? []) };
  return info;
};

// The transport says whether it is carrying the lane to the room right now (voicesfu.js registers it: a connected
// peer connection with the lane's track on a sender negotiated to send). Without a transport nothing carries it.
let _carrier = null;
export const setLaneCarrier = (fn) => { _carrier = fn; };
export const laneCarried = () => { try { return !!_lane && !!_carrier?.(_lane); } catch { return false; } };

/** THE ONE ANSWER TO "IS MY VOICE GOING OUT TO THE ROOM RIGHT NOW". The lane is sending (micGateInfo), its track is
 *  on, the transport carries it to the server, and no moderator has muted you (the server would drop it). It stops at
 *  the server: the SFU forwards only to listeners who consented to hear voices, and distance fades it, so whether
 *  anyone hears it (consent, distance, an empty room) is not counted. Every indicator that goes gold asks here. */
export const roomHears = () => !!_lane && !_modMuted && someTrackOn(laneTracks()) && laneCarried()
  && !!micGateInfo().speaking;

/** Live mic level 0..1 for UI. */
export function micAnalyserLevel() { return _meter(); }
/** The sensitivity bar's level 0..1. A device lane: the device while it is on, muted or not (the bar still moves while
 *  muted, so it can be tuned), and 0 once the mic is off. A synth lane: the source's own level where it keeps one. */
export const micDeviceLevel = () => {
  if (_lane?.synthetic) { const l = _lane.level?.(); return typeof l === 'number' ? l : _deviceMeter(); }
  return _deviceLive ? _deviceMeter() : 0;
};

// ── the transport-facing seam ───────────────────────────────────────────────

let _raw = null, _gated = null, _released = false;
// _raw is the one reference to the device, so the device stops when _raw lets go of it (a synth source is the provider's)
const stopDevice = (s) => { if (s && !s.synthetic) for (const t of s.getTracks()) { try { t.stop(); } catch { /* already dead */ } } };

/** Gate a raw device stream and return what should go on the wire.
 *  A SYNTHETIC source bypasses the gate: no room noise to gate, and the WebAudio
 *  graph can't carry it on a stalled headless clock. The source's nature
 *  decides, never the transport. */
export function gateFor(rawStream) {
  if (_raw !== rawStream) stopDevice(_raw);
  _laneOn = true;   // a lane the transport is about to publish starts on
  if (!rawStream || rawStream.synthetic) {
    _raw = _gated = _lane = rawStream;
    _synthFrom = Date.now(); _synthAt = 0;
    applySynthTracks();   // muted: off before any sender gets it
    return rawStream;
  }
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
/** The transport has let go of its stream: stop the device and say it is not capturing. */
export function dropDevice() { stopDevice(_raw); _raw = null; setMicLive(false); }

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
  _deviceLive = !!on;
  // Liveness is part of the gate's authority, so re-apply now, changed or not: the transport re-enables a raw track
  // before it calls this, and mute or PTT-with-key-up must close it at once.
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
