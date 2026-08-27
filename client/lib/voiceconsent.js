// voiceconsent — the two things a person must be able to say NO to before any
// audio moves: "don't send my voice anywhere" and "don't play other people's
// voices at me". Both default to OFF. Voice is opt-in in BOTH directions.
//
// Why receive-off is not just muted playback: an inbound peer connection is a
// negotiated stream, not a volume slider. If you have not opted in, we do not
// answer the offer at all — "off" means no audio path exists, not "an audio
// path exists and we discard it". Cheaper, and it is the honest reading of
// the word.
//
// Category doctrine (convention, checked against Discord/VRChat/Rec Room):
// the 🎧 toggle is a VOICE control. World ambience is taste, set once, and
// lives on a settings slider — not on a HUD button you press situationally.
// Agent voice (TTS/captions) counts as a VOICE: a resident is a resident, and
// it would be strange for a synthetic speaker to be unmutable when a human
// one is not.

import { bus } from './core.js';

const KEY = 'eido.audio.prefs';
// sttConsent is TRI-STATE and must stay so: null = never asked, true =
// accepted, false = refused. A boolean cannot tell "not asked" from "said no",
// so a refusal would be re-prompted on the next mic-on — turning a no into a
// recurring negotiation, which is the opposite of asking once (review catch).
// 🔴 volWorld DEFAULTS TO 1, not 0.6 (R, 2026-08-16: "maybe we should set world
// volume to 100% by default as well. We don't really have anything to test it
// against right now but at least it will be starting from a default that makes
// sense").
//
// 🔴 volumeFor('world') HAS NO CALLER, AND THAT IS DELIBERATE — not an unwired
// loose end (R, 2026-08-16: "we shipped some PRs related to this and closed
// them because it was getting into component-editing territory and we decided
// to punt on it. That's correct for the time being").
//
// So do not "fix" this by hunting for the missing consumer: world/ambient audio
// volume waits on the component-editing work, and the slider is the surface
// held ready for it. It is a parked feature with a visible control, which is a
// different thing from a control that lies — the TTS slider an hour ago was the
// latter, promising listener-side control that its own architecture had already
// made impossible.
//
// 1.0 rather than 0.6 for exactly that reason: 0.6 was a guess about the
// balance of a mix that does not exist yet. When ambient audio does land, the
// first person to hear it should hear it as authored, not through a 40% cut
// nobody chose on purpose.
const DEFAULTS = { recvVoice: false, volVoices: 1, volWorld: 1, volTts: 1, sttConsent: null,
  // Sensitivity, not an absolute level: it scales the margin a sound must clear
  // ABOVE the measured room noise (see onsetTick). 0.06 is the lowest value that
  // took zero false triggers across 200 simulated room/noise combinations while
  // never missing speech, so the slider has honest room in both directions.
  // 60% = -24 dBFS. R's number, found by TESTING IT IN HER ROOM — "seems like
  // 60% is a good place" — which beats my four earlier defaults, every one of
  // them reasoned from published reference levels rather than measured against
  // a real mic at a real gain. The slider is honest and 1:1 now, so anyone
  // else's number is a drag away; this is a good place to start, not a claim
  // about everyone's room.
  micFloor: 0.12,
  // Push-to-talk: the gate opens on a HELD KEY instead of on measured level.
  // Off by default — voice activation is the mode everything above was tuned
  // for, and PTT is the deliberate opt-in of someone who knows their room
  // (an open-plan office, a fan, a housemate) will not survive a level gate.
  pttMode: false };

let prefs = { ...DEFAULTS };
try {
  const raw = localStorage.getItem(KEY);
  if (raw) prefs = { ...DEFAULTS, ...JSON.parse(raw) };
} catch { /* corrupt prefs must never keep anyone out of the world */ }

const save = () => { try { localStorage.setItem(KEY, JSON.stringify(prefs)); } catch { /* private mode */ } };

export const audioPrefs = () => ({ ...prefs });
export const receivingVoice = () => prefs.recvVoice;
export const volumeFor = (cat) => (
  cat === 'world' ? prefs.volWorld : cat === 'tts' ? prefs.volTts : prefs.volVoices);

export function setReceiveVoice(on) {
  const next = !!on;
  if (next === prefs.recvVoice) return prefs.recvVoice;
  prefs.recvVoice = next; save();
  // voice.js tears inbound peers down / permits them on this event; nothing
  // else may open an inbound stream without consulting receivingVoice().
  bus.emit('audio:receive', next);
  return next;
}

/** Momentary silence WITHOUT revoking consent: the stream keeps arriving and
 *  keeps advancing, so unmuting drops you back into a sentence already in
 *  progress — the way you rejoin a human voice you had stopped attending to.
 *  Distinct from setReceiveVoice(false), which is the privacy act: that one
 *  tears the inbound path down so no media is negotiated at all. Silence and
 *  consent are different questions and this is the one people press often.
 *  (R, in world 12:11: the deafen was killing the utterance and starting the
 *  next one — a cut, not a mute.) */
let hushed = false;
export const isHushed = () => hushed;
export function setHush(on) {
  const next = !!on;
  if (next === hushed) return hushed;
  hushed = next;
  bus.emit('audio:hush', hushed);   // voice.js ramps element volume; no teardown
  return hushed;
}

export function setVolume(cat, v) {
  const n = Math.max(0, Math.min(1, Number(v) || 0));
  if (cat === 'world') prefs.volWorld = n;
  else if (cat === 'tts') prefs.volTts = n;
  else prefs.volVoices = n;
  save();
  bus.emit('audio:volume', { cat, value: n });
  return n;
}

// ---- push-to-talk ----------------------------------------------------------
// A MODE, not a momentary state: which regime decides when the gate opens.
// The held-key itself lives in micstate.js next to the gate decision it feeds;
// this file only remembers the choice, like every other preference here.
export const pttMode = () => !!prefs.pttMode;
export function setPttMode(on) {
  const next = !!on;
  if (next === prefs.pttMode) return prefs.pttMode;
  prefs.pttMode = next; save();
  // micstate drops a held key on this event (a mode you leave should not
  // leave a phantom finger on the gate), and the panel dims the sensitivity
  // row — under PTT the floor drives nothing, and a control that does
  // nothing must not look like it does. That rule is this file's history.
  bus.emit('audio:ptt', next);
  return next;
}

// mic sensitivity (R, 17:19: typing sounds pinged the ear) — the floor below
// which mic activity is treated as room noise, not speech onset
export const micFloor = () => prefs.micFloor;
export function setMicFloor(v) {
  prefs.micFloor = Math.max(0, Math.min(0.2, Number(v) || 0));
  save();
  bus.emit('audio:micfloor', prefs.micFloor);
  return prefs.micFloor;
}

// ---- STT consent -----------------------------------------------------------
// The browser's SpeechRecognition ships audio to a VENDOR endpoint off this
// machine. Someone toggling a microphone in a world does not expect their
// room to be transcribed by a third party. So STT is gated behind an explicit,
// revocable, plainly-worded consent — asked once, remembered, never assumed
// from the mic toggle.
export const sttConsented = () => prefs.sttConsent === true;
/** Has this ever been put to the person? Distinct from what they answered. */
export const sttAsked = () => prefs.sttConsent !== null && prefs.sttConsent !== undefined;
export function setSttConsent(on) {
  prefs.sttConsent = !!on; save();      // a deliberate choice is always recordable
  bus.emit('audio:stt-consent', prefs.sttConsent);
  return prefs.sttConsent;
}

/** Ask once, in words that name the actual consequence. Returns a promise of
 *  the answer; a refusal is remembered as a refusal (we do not re-nag). */
export async function ensureSttConsent(ask = defaultAsk) {
  // Only the UNSET state prompts. A remembered answer — yes or no — is
  // returned without asking again: "no" is an answer, not an invitation to
  // ask differently next time. Changing it later is a deliberate act in the
  // audio panel, where the person goes looking rather than being interrupted.
  if (sttAsked()) return prefs.sttConsent === true;
  const yes = await ask();
  setSttConsent(yes);
  return prefs.sttConsent === true;
}

function defaultAsk() {
  return Promise.resolve(confirm(
    'Turn on speech-to-text?\n\n' +
    'Your microphone audio will be sent to your browser vendor\'s speech ' +
    'service (a third party outside this world) to be transcribed. The text ' +
    'is then posted as your chat message and stored in the world log.\n\n' +
    'Voice chat itself does NOT require this — you can talk without it.',
  ));
}

/** How many times the measured room noise a sound must be, to count as speech.
 *
 *  🔴 THE ONE DEFINITION. This formula lived in FOUR places (the gate, the gate's
 *  own info dump, and two panel readouts) and had already drifted once — the
 *  panel kept an old additive version after the gate went multiplicative, so the
 *  two reported different thresholds (2026-08-09). Anything that needs it
 *  imports it from here.
 *
 *  Range 1.5x…20x, widened after R found the old 5x ceiling too low: "even
 *  someone talking in another room here is hitting 100% from time to time."
 *  She was right — distant speech lands around 3-4x a quiet room's floor, so a
 *  5x maximum left almost no rejection headroom, while her own voice clears the
 *  floor by more than 30x. The top of the range is now genuinely strict and the
 *  bottom still catches a whisper.
 */
// THE THRESHOLD IS A dB POSITION, not a multiplier over the room.
//
// R, after three rounds of the marker and the colour disagreeing: "maybe it's
// time to search online for how other people have programmed mic sensitivity
// sliders". Discord's model, and it is better than what I built:
//
//   • one widget, two jobs — the live level bar and the draggable threshold
//     share one track, on a dB scale (roughly -60..0 dBFS)
//   • the marker DOES NOT MOVE. The level moves past it.
//   • colour by GATE STATE, not by level: below the marker is muted, above is
//     live
//
// My room-relative version (level >= noise x k) meant the threshold moved as the
// room changed — so drawing the marker where the gate opens made it slide away
// from the cursor, and drawing it where the cursor was made the colour flip
// somewhere else. There is no way to draw two coordinate systems as one mark.
// A fixed dB threshold removes the conflict at the root rather than papering it.
//
// dB also fixes the crushed scale: on a linear RMS meter a quiet room and speech
// are both jammed into the left edge, which is why the useful part of the slider
// kept feeling like a sliver. In dB they are 25 points apart.

/** The gate threshold in dBFS. 0% = -60 dB (everything), 100% = 0 dB (nothing).
 *  Linear in dB, which is already logarithmic in amplitude — the standard shape
 *  for this control, and the reason Discord's slider feels even end to end. */
export const gateThresholdDb = () => -60 + Math.min(1, Math.max(0, prefs.micFloor / 0.2)) * 60;

/** Same threshold as a linear amplitude, for comparing against an RMS reading. */
export const gateThreshold = () => Math.pow(10, gateThresholdDb() / 20);

/** dBFS of a linear amplitude, floored so silence does not become -Infinity. */
export const toDb = (amp) => 20 * Math.log10(Math.max(amp, 1e-6));

/** Where a level sits on the meter, 0..1 across the same -60..0 dB span the
 *  threshold uses. ONE function for both, so the bar and the marker cannot
 *  land in different places — that mismatch is this control's whole history. */
export const meterPos = (amp) => Math.max(0, Math.min(1, (toDb(amp) + 60) / 60));
