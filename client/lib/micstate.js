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

// 🔴 flashHint lives in ui.js, not core.js — the wrong path was a LINK-TIME
// boot-breaker in the browser (the module graph refuses to load), and
// micstate-exec-test could not see it because its core.js STUB also carried a
// flashHint, codifying the same wrong guess. Lazy-imported at the one call
// site rather than statically: a hint is UI, this file is machinery, and the
// static form dragged all of ui.js (and its THREE import) into every context
// that touches the mic — including headless ones with no DOM at all.
import { bus } from './base.js';
const flashHint = (msg) => import('./ui.js').then((u) => u.flashHint(msg)).catch(() => {});
import { sendTyping } from './net.js';
import { gateThreshold } from './voiceconsent.js';
import { gateStream, attachSource, detachSource, driveGate, setMonitor, monitoring,
         gateUnavailable, ungatedConsent, isGated,
         makeOnsetGate, makeLevelMeter } from './micgate.js';
// 🔴 The analyser hangs off the shared context; omitting this import made
// micAnalyserLevel() return 0 forever inside its own catch{} rather than
// erroring — a silent meter, which is the exact failure this file's gate is
// meant to make impossible.
import { audioContext } from './audioctx.js';

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

// 🔴 THE ONSET WATCHER'S STATE. Extracted from voice.js:680-682 — the slice
// that moved the FUNCTIONS started below these declarations, so every one of
// them was a free variable here: startOnsetWatch/onsetTick/gateAudio threw
// ReferenceError on first call, i.e. turning the mic on rejected. `node --check`
// passes on an unbound identifier and every test in place greps source text, so
// nothing could report it. Caught by an adversarial agent that EXECUTED the
// module instead of reading it.
// §24l R1 (survey A1): the machine is micgate.js's makeOnsetGate/
// makeLevelMeter now — the ~200-line twin this replaced was where the
// speaking-latch and analyser-leak fixes FIRST landed (2026-08-17) while
// the mesh's identical copy kept running without them; one factory ends
// that class. The mesh delegation below is unchanged: when the mesh is the
// live transport, ITS instance is the truth the panels describe.
const _meter = makeLevelMeter(() => (!_lane || _muted) ? null : (_raw || _lane));
const _onset = makeOnsetGate({
  level: _meter,
  threshold: gateThreshold,
  drive: (open) => driveGate((!_lane || _muted) ? false : open),
  announce: () => sendTyping(null, 'mic'),
});
const gateAudio = (now) => _onset.apply(now);
const startOnsetWatch = () => _onset.start();
const stopOnsetWatch = () => _onset.stop();

/** What the gate is actually doing right now — for the meter and for
 *  tuning. Post-cutover (anima merge, §24n): the mesh is GONE — this
 *  module's own factory instance is the only gate there is. */
export const micGateInfo = () => _onset.info();

/** Live mic level 0..1 for UI — the factory meter over this module's own
 *  _raw/_lane (the mesh delegation retired with voice.js). */
export function micAnalyserLevel() { return _meter(); }

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
  _deviceLive = true;
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

/** Turn the mic on or off. The ONE entry point every UI uses.
 *
 *  🔴 voice.js:508 used to route here to `window.__sfuMic` and return before
 *  touching mesh state — which is exactly why the SFU had no mute: the flag it
 *  checked could never be set. #131's standalone form delegated to the mesh
 *  when no SFU hook was installed; the #132 cutover deletes the mesh, so with
 *  one transport there is no routing left to do, only the call. */
export async function toggleMic() {
  const fn = typeof window !== 'undefined' ? window.__sfuMic : null;
  if (!fn) { flashHint('voice is still connecting — try again in a moment'); return micOn(); }
  const on = await fn();
  bus.emit('audio:mic', on);
  return on;
}

/** 🔴 THE ONE ANSWER TO "IS MY MIC ON". The audit found EIGHT sources of truth
 *  and four different fallback ladders across mictoggle/audiopanel/voicemouths/
 *  stt/tts/ttsrow/chat — each subtly different, one of which (ttsrow) returned
 *  a hard false with no fallback, so the TTS row never greyed out on the mesh.
 *
 *  A mic is on when a LANE exists, a DEVICE is capturing, and the user has not
 *  muted — the three-state distinction voice.js:56-66 documented and the SFU
 *  never had (sfuMicOn() is two-state and does not read track.enabled, so a mic
 *  muted by disabling its track still reported micPublished:true).
 *
 *  Transports report device liveness through setMicLive(); everything else in
 *  the client asks HERE. */
let _deviceLive = false;
export function setMicLive(on) { _deviceLive = !!on; }
export const micOn = () => !!_lane && _deviceLive && !_muted;

/** Release the DEVICE while keeping the lane. Ported verbatim from voice.js:909
 *  — the reasoning is R's and was paid for in production:
 *
 *  (1) The raw device track MUST stop, or the OS recording indicator stays lit
 *      while this function's whole promise is that it goes away.
 *  (2) The GATED track must NOT stop. stop() is a one-way door and a
 *      MediaStreamDestination track cannot be restarted, so re-enabling the mic
 *      would need a new graph and a renegotiation with every peer. R,
 *      2026-08-09: "we don't want to tear down audio tracks at all unless
 *      someone leaves... that's how we ran into people not hearing each other
 *      and unmute lag while it sets it all up again. Now we just mute the lane."
 *
 *  So: kill the device, leave the lane at zero gain. Senders keep a live track,
 *  no renegotiation, and reacquiring reconnects a new source into the SAME
 *  graph. The SFU had NO equivalent — sfuClose() closes the pc but never stops
 *  a device, so the recording indicator survived a disconnect. */
export function releaseMicrophone() {
  if (!_lane) return;
  // Stop ONLY the raw device (#131 review). `_raw || _lane` stopped the LANE
  // whenever the raw was already gone — a second release, or any release after
  // the raw was nulled — which is the one-way door rule (2) forbids: a stopped
  // destination track cannot restart, so the function was causing the exact
  // renegotiation it promises to prevent. Rule (1) still wins where the lane
  // IS the device (synthetic / gate-unavailable paths, where raw === lane):
  // the OS recording indicator is a privacy promise, so a present raw always
  // stops, even at the cost of that lane. Repeated release is harmless by
  // construction: _raw is null after the first.
  if (_raw) for (const t of _raw.getTracks()) t.stop();
  _deviceLive = false;
  driveGate(false);
  detachSource();
  _raw = null;
  _released = true;
  stopOnsetWatch();
  bus.emit('audio:mic', false);
}

/** Is there a microphone at all? Transport-agnostic and cheap. */
export async function hasMicDevice() {
  try {
    const devs = await navigator.mediaDevices?.enumerateDevices?.();
    return !!devs?.some((d) => d.kind === 'audioinput');
  } catch { return false; }
}

/** Hear your own lane, exactly as the room hears it. Tapped AFTER the gate's
 *  gain node (micgate.js:150), so when the gate closes the monitor goes quiet —
 *  a monitor on the raw source would sound perfect while the room heard
 *  nothing, which is the confusion it exists to resolve. */
export function selfMonitor(on, level = 0.35) { return setMonitor(on, level); }
export const selfMonitoring = () => monitoring();
