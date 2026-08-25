// ---- live voice as presence (R, 23:30) --------------------------------------
// The same two-plane split we built for the agent voice, pointed at humans:
// the SOUND is already live over the mesh (zero latency, no waiting on
// transcription), so the visible half must be live too — mouth driven by real
// amplitude, 🎙 glyph while the mic is hot. STT stays on the LOG plane, landing
// afterward as an ordinary say. Nobody waits for words to know you're talking.

import { CONFIG, bus } from './core.js';
import { micOn as meshMicOn, isMuted, micAnalyserLevel as meshMicLevel } from './micstate.js';

import { remotes, noteSpeaking } from './remotes.js';
import { sendTyping } from './net.js';
import { getMe } from './mybody.js';

// 🔴 READ WHICHEVER TRANSPORT IS LIVE (2026-08-15). Every function below used
// to come straight from voice.js — which reads voice.js's OWN module-level
// `micStream` and `peers`. On an SFU client both are null/empty FOREVER (the
// mic and the peers live in voicesfu.js), so:
//   · peerLevels() returned an empty Map      → NOBODY's mouth ever moved
//   · micAnalyserLevel() returned 0 at line 1 → your own mouth never moved,
//     and the 🎙 glyph never lit, no matter how loudly you spoke.
// Verified by reading voice.js:854 (`if (!micStream || muted) return 0`) and
// :1161 (`for (const [id, p] of peers)`), not inferred.
//
// Same shape as mictoggle.js:85-94 and stt.js: ask the SFU bridge first, fall
// back to the mesh. The SFU deliberately exposes the SAME shapes
// (sfuPeerLevels returns "the same shape relayPeerLevels() returns, so
// mouth-flap code is shared" — voicesfu.js:168), so this is a lookup change,
// not a logic change.
const micIsOn = () => {
  try {
    if (typeof window.__sfuMicOn === 'function') return !!window.__sfuMicOn();
    return !!meshMicOn();
  } catch { return false; }
};
const myLevel = () => {
  try {
    if (typeof window.__sfuMyLevel === 'function') return window.__sfuMyLevel();
    return meshMicLevel();
  } catch { return 0; }
};
const allPeerLevels = () => {
  try {
    // 🔴 ONE TRANSPORT, ONE ANSWER. This fell back to the mesh's own `peers`
    // analyser map; with the mesh gone the SFU global is the only source, and
    // an empty Map is the honest answer before the bridge installs it — never a
    // stale second opinion.
    if (typeof window.relayPeerLevels === 'function') return window.relayPeerLevels();
    return new Map();
  } catch { return new Map(); }
};

const VOICE_GATE = 0.045;        // below this is room tone, not speech
let _micGlyphOn = false, _micGlyphAt = 0, _micTail = 0;

export function updateVoiceMouths(now) {
  // mine: local analyser, no round trip
  const me = getMe();
  if (me) {
    const live = micIsOn() && !isMuted();
    me.voiceLevel = live ? myLevel() : null;
    // 🎙 means SOUND IS COMING OUT OF ME, not "my mic is plugged in" (R,
    // 23:38: "it's not just if the mic is capturing my voice activity, it's
    // if the mic is simply ON"). An always-on badge is furniture — it stops
    // carrying information the second everyone wears one. So it tracks
    // actual speech, with a short tail so ordinary pauses between words
    // don't strobe it.
    const speaking = live && me.voiceLevel > VOICE_GATE;
    if (speaking) _micTail = now + 900;
    const show = now < _micTail;
    if (show !== _micGlyphOn || (show && now - _micGlyphAt > 1500)) {
      _micGlyphOn = show; _micGlyphAt = now;
      sendTyping(null, show ? 'mic' : null);
      me.setTyping(show ? 'mic' : null);
    }
    if (speaking) me.speakUntil = now + 400;   // keeps head/gaze life going
  }
  // theirs: one analyser per inbound stream
  const levels = allPeerLevels();
  for (const [id, r] of remotes) {
    const lv = levels.get(id);
    if (r.avatar) r.avatar.voiceLevel = lv == null ? null : lv;
    if (lv != null && lv > VOICE_GATE) noteSpeaking(id, 600);
  }
}

// Two-plane speech, timer-free (R, 16:09): captions are the live performance
// (bubble + mouth, paced to the voice); the logged say carries spoken:true
// and world.js never re-performs it. No dedup windows, no content matching —
// the message itself says which plane it belongs to.
//
// caption and speech were two verbatim-identical handlers in main.js; the
// merge (§14 6c) is one routine on two bus names — the planes still arrive
// separately, they just perform identically.
function performSpeech({ actor, text }) {
  const av = actor === CONFIG.name ? getMe() : remotes.get(actor)?.avatar;
  av?.say(text);
  if (actor !== CONFIG.name) noteSpeaking(actor, Math.min(12000, 3000 + text.length * 30));
}
// side-effecting on import (the emitters.js pattern): these are pure
// subscriptions, and nothing can emit either event before connect()
bus.on('caption', performSpeech);
bus.on('speech', performSpeech);
