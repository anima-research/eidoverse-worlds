// voicemouths — live voice as presence: mouths driven by real amplitude, 🎙 glyph while you
// speak. STT stays on the log plane and lands afterward as an ordinary say.

import { CONFIG, bus } from '../base.js';
import { micOn as meshMicOn, isMuted, micAnalyserLevel as meshMicLevel } from './micstate.js';

import { remotes, noteSpeaking } from '../remotes.js';
import { sendTyping } from '../net.js';
import { getMe } from '../mybody.js';

// ask the SFU bridge's globals first (voicesfubridge.js installs them), then micstate — as mictoggle.js and stt.js do
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
    // an empty Map before the bridge installs the global
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
    // 🎙 tracks actual speech, not "mic on", with a short tail so pauses don't strobe it
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

// captions are the live performance (bubble + mouth); the logged say carries spoken:true and
// world.js never re-performs it. caption and speech are one routine on two bus names.
function performSpeech({ actor, text }) {
  const av = actor === CONFIG.name ? getMe() : remotes.get(actor)?.avatar;
  av?.say(text);
  if (actor !== CONFIG.name) noteSpeaking(actor, Math.min(12000, 3000 + text.length * 30));
}
// subscribes on import; nothing emits either event before connect()
bus.on('caption', performSpeech);
bus.on('speech', performSpeech);
