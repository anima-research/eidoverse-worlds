// stt — your voice, written down. The agent-inclusion half of voice chat.
//
// Speech is transcribed client-side and spoken into the world as ordinary
// `say` verbs prefixed "🎙 " — so transcripts land in the same log agents
// already read (catch_up, activity pulses), and their wake triggers are
// UNTOUCHED: mention/approach/whisper mechanics never learn voice exists.
// The prefix survives the server's say-fold (which keeps only text) and
// doubles as captions for humans with sound off.
//
// v1 engine is the browser's SpeechRecognition (Chrome). Honest caveat,
// flagged to the gang: desktop Chrome ships audio to Google's recognizer.
// Local whisper is the planned upgrade; the say-pipe stays identical.

import { report } from './core.js';
import { sendVerb } from './net.js';
import { flashHint } from './ui.js';
// The mic's real state — this module's capture must never outlive it.
//
// 🔴 ASK WHICHEVER TRANSPORT IS ACTUALLY RUNNING. voice.js's `micOn()` reads
// the MESH's module-level micStream, which is null forever on an SFU client —
// so importing it directly made this guard permanently false and STT
// permanently off (R, 2026-08-15: "I toggled it on and now it's just
// perma-off"). That is the same defect the mic BUTTON had: state read from one
// transport while another is live. One helper, asked in transport order.
import { micOn as meshMicOn } from './voice.js';
function micIsLive() {
  try {
    // SFU first: on relay-spike it is the default, and its bridge publishes
    // __sfuMicOn only when that transport actually initialised.
    if (typeof window.__sfuMicOn === 'function') return !!window.__sfuMicOn();
    return !!meshMicOn();
  } catch { return false; }   // unreadable state = not live = stay silent
}

let rec = null;
let wanted = false;
let uttSeq = 0;                 // one id per transcribed utterance (log plane)
export const sttOn = () => wanted;
export const sttAvailable = () => !!(window.SpeechRecognition ?? window.webkitSpeechRecognition);

export function setSTT(on) {
  wanted = on;
  if (!on) { try { rec?.stop(); } catch { /* already stopped */ } rec = null; return; }
  const SR = window.SpeechRecognition ?? window.webkitSpeechRecognition;
  if (!SR) { flashHint('no speech recognition in this browser — voice works, captions don’t'); wanted = false; return; }
  rec = new SR();
  rec.continuous = true;
  rec.interimResults = false;
  rec.lang = navigator.language || 'en-US';
  // Speech-onset presence intentionally does NOT live here (#26 review):
  // it rides the local analyser loop in voice.js, so a person who declines
  // vendor transcription still has an audible presence. STT is transcript
  // duty only.
  rec.onresult = (e) => {
    for (let i = e.resultIndex; i < e.results.length; i++) {
      if (!e.results[i].isFinal) continue;
      const text = e.results[i][0].transcript.trim();
      // The LOG plane. The sound already reached the room live (mesh audio +
      // 🎙 glyph + moving mouth); this is the written record arriving after,
      // so it must never re-perform the utterance as a fresh speech event.
      // Same doctrine as the agent voice's spoken:true. (R, 23:30)
      // 🔴 GATE THE EMIT TOO, not only the restart. A result can be delivered
      // after the mic went off (recognition is async and Chrome buffers), and
      // one leaked line is a private sentence in a public log — the failure is
      // not recoverable by fixing the next one. Two checks, because `wanted`
      // is our intent and `micOn()` is the world's reality; a disagreement
      // between them must resolve to silence.
      if (!wanted || !micIsLive()) continue;
      if (text) sendVerb('say', { text: `🎙 ${text}`, voiced: true, spoken: true, utt: ++uttSeq });
    }
  };
  // Chrome ends recognition on silence — restart while still wanted.
  //
  // 🔴 AND ONLY WHILE THE MIC IS ACTUALLY ON (R, 2026-08-15, live and costly).
  // `wanted` alone is not enough: SpeechRecognition holds its OWN microphone,
  // independent of the WebRTC track, so a mic that is off — or that never
  // managed to publish at all — leaves this loop transcribing the room and
  // saying it into the world log, and shipping the audio to the browser
  // vendor's recognizer. R's mic button read OFF while a private conversation
  // with her sister went into the log as `🎙 …` lines. The auto-restart made
  // it un-stoppable by muting: every silence timeout revived it.
  //
  // The mic toggle is the one control a person believes governs their
  // microphone. It must govern EVERY capture, not just the one WebRTC owns.
  // Fails closed: if micOn cannot be read, we stop rather than continue.
  rec.onend = () => {
    if (wanted && micIsLive()) { try { rec.start(); } catch (err) { report('stt restart', err); } }
    else if (wanted) { wanted = false; rec = null; report('stt', 'stopped: mic is off'); }
  };
  rec.onerror = (e) => { if (e.error !== 'no-speech' && e.error !== 'aborted') report('stt', e.error); };
  try { rec.start(); } catch (e) { report('stt', e); wanted = false; }
}
