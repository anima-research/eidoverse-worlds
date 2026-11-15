// voiceconsent — audio preferences, and the two things a person can say NO to before any audio
// moves: "don't send my voice anywhere" and "don't play other people's voices at me". Both
// default to off. Receive-off means the server forwards no voice to you (no route is built; one already negotiated is
// starved, server/sfu.ts setConsent), not muted playback.
//
// Categories: the 🎧 toggle is a voice control, and agent voice (TTS) counts as a voice. World
// ambience is taste, set once on a settings slider.

import { bus } from '../base.js';

const KEY = 'eido.audio.prefs';
// sttConsent is tri-state: null = never asked, true = accepted, false = refused (a refusal
// must not be re-prompted). volWorld's one consumer is the world bus in realize/sounds.js.
const DEFAULTS = { recvVoice: false, volVoices: 1, volWorld: 1, volTts: 1, sttConsent: null,
  // mic gate position on a 0..0.2 scale (gateThresholdDb below): 0.12 = 60% = -24 dBFS, measured
  // against a real mic in a real room
  micFloor: 0.12,
  // push-to-talk: the gate opens on a held key instead of measured level (micstate.js)
  pttMode: false };

let prefs = { ...DEFAULTS };
try {
  const raw = localStorage.getItem(KEY);
  if (raw) prefs = { ...DEFAULTS, ...JSON.parse(raw) };
} catch { /* corrupt prefs must never keep anyone out of the world */ }

const save = () => { try { localStorage.setItem(KEY, JSON.stringify(prefs)); } catch { /* private mode */ } };

// how far a voice carries: full within VOICE_FULL_M, silent past VOICE_SILENT_M (voicesfubridge.js's rolloff)
export const VOICE_FULL_M = 3, VOICE_SILENT_M = 20;

export const audioPrefs = () => ({ ...prefs });
export const receivingVoice = () => prefs.recvVoice;
export const volumeFor = (cat) => (
  cat === 'world' ? prefs.volWorld : cat === 'tts' ? prefs.volTts : prefs.volVoices);

export function setReceiveVoice(on) {
  const next = !!on;
  if (next === prefs.recvVoice) return prefs.recvVoice;
  prefs.recvVoice = next; save();
  // voicesfubridge.js restates consent to the server on this event
  bus.emit('audio:receive', next);
  return next;
}

/** Momentary silence without revoking consent: the stream keeps arriving, only playback volume
 *  drops. setReceiveVoice(false) is the privacy act: the server stops forwarding (the negotiated track stays, starved). */
let hushed = false;
export const isHushed = () => hushed;
export function setHush(on) {
  const next = !!on;
  if (next === hushed) return hushed;
  hushed = next;
  bus.emit('audio:hush', hushed);   // voicesfubridge.js's rolloff loop ramps volume; no teardown
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
// a mode, not the held key: the key lives in micstate.js next to the gate it feeds
export const pttMode = () => !!prefs.pttMode;
export function setPttMode(on) {
  const next = !!on;
  if (next === prefs.pttMode) return prefs.pttMode;
  prefs.pttMode = next; save();
  // micstate drops a held key on this event; audiopanel dims the sensitivity row
  bus.emit('audio:ptt', next);
  return next;
}

// mic sensitivity: the floor below which mic activity is treated as room noise, not speech onset
export const micFloor = () => prefs.micFloor;
export function setMicFloor(v) {
  prefs.micFloor = Math.max(0, Math.min(0.2, Number(v) || 0));
  save();
  bus.emit('audio:micfloor', prefs.micFloor);
  return prefs.micFloor;
}

// ---- STT consent -----------------------------------------------------------
// SpeechRecognition ships audio to a vendor endpoint, so STT needs its own explicit, revocable
// consent, never assumed from the mic toggle.
export const sttConsented = () => prefs.sttConsent === true;
/** Has this ever been put to the person? Distinct from what they answered. */
const sttAsked = () => prefs.sttConsent !== null && prefs.sttConsent !== undefined;
export function setSttConsent(on) {
  prefs.sttConsent = !!on; save();      // a deliberate choice is always recordable
  bus.emit('audio:stt-consent', prefs.sttConsent);
  return prefs.sttConsent;
}

/** Ask once; a remembered answer, yes or no, is returned without asking again (the audio panel
 *  is where it changes). */
export async function ensureSttConsent(ask = defaultAsk) {
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

// The gate threshold is a dB position (Discord's model), not a multiplier over the room: the level
// bar and the draggable marker share one dB track, the marker stays put and the level moves past it.

/** The gate threshold in dBFS: 0% = -60 dB (everything), 100% = 0 dB (nothing). Linear in dB. */
const gateThresholdDb = () => -60 + Math.min(1, Math.max(0, prefs.micFloor / 0.2)) * 60;

/** Same threshold as a linear amplitude, for comparing against an RMS reading. */
export const gateThreshold = () => Math.pow(10, gateThresholdDb() / 20);
