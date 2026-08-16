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
// Readable from /audio on a device with no console.
try { window.__sttOn = () => wanted; } catch { /* no window */ }
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
    // 🔴 DISTINGUISH "no results" FROM "results that are never FINAL"
    // (2026-08-16). On R's Android, /audio reported audio reaching the
    // recognizer while nothing was ever transcribed — and from outside those
    // two states are identical. Android Chrome in continuous mode is far more
    // reluctant to finalize than desktop, so a stream of interim results that
    // never flips isFinal looks exactly like silence. Count both.
    let fin = 0, interim = 0;
    for (let i = e.resultIndex; i < e.results.length; i++) {
      (e.results[i].isFinal ? fin++ : interim++);
    }
    try {
      window.__sttLast = `results: ${fin} final, ${interim} interim`
        + (fin === 0 && interim > 0 ? '  ← hearing you, never finalizing' : '');
    } catch { /* no window */ }
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
  // 🔴 A CAPTION ENGINE THAT NEVER STARTS MUST SAY SO (R, 2026-08-16, on an
  // Android phone where voice worked both ways and STT produced nothing).
  //
  // report() is console-only and rate-limited, and NOTHING observed onstart or
  // onaudiostart — so "recognition never started" and "started and heard
  // nothing" were indistinguishable from outside, on a device with no console
  // in reach. The person's only signal was absence, which is the same signal as
  // having nothing to transcribe.
  //
  // The errors worth naming, because each has a different fix and Android hits
  // them in ways desktop does not:
  //   audio-capture — something else holds the mic. SpeechRecognition takes its
  //     OWN capture, separate from the WebRTC track (see micIsLive above), and
  //     Android is far stricter than desktop about two consumers of one device.
  //   not-allowed   — Chrome scopes this permission separately from
  //     getUserMedia, so a working WebRTC mic does NOT imply STT is permitted.
  //   network       — the recognizer is Google's, not local; it can fail while
  //     the rest of the page's connectivity is perfectly healthy.
  let sawAudio = false;
  // 🔴 The phone has no console, so the last event has to be READABLE from the
  // page itself — /audio prints it. Without this, "recognition never started"
  // and "started and heard nothing" are the same observation: silence.
  const mark = (what) => { try { window.__sttLast = what; } catch { /* no window */ } };
  rec.onaudiostart = () => { sawAudio = true; mark('audio reached the recognizer'); };
  rec.onstart = () => {
    mark('started');
    // Give it a beat: if recognition starts but never receives audio, that is
    // the contention signature and it is otherwise invisible.
    setTimeout(() => {
      if (wanted && !sawAudio) {
        mark('started but NO audio after 4s (mic contention?)');
        flashHint('captions: recognition started but no audio reached it — '
          + 'another app or tab may hold the microphone');
        report('stt', 'started but onaudiostart never fired (mic contention?)');
      }
    }, 4000);
  };
  rec.onerror = (e) => {
    mark(`error: ${e.error}`);
    if (e.error === 'no-speech' || e.error === 'aborted') return;   // ordinary silence
    report('stt', e.error);
    const said = {
      'audio-capture': 'captions: something else is holding the microphone',
      'not-allowed': 'captions: speech recognition was denied — it needs its own permission, separate from the mic',
      'service-not-allowed': 'captions: speech recognition was denied by the browser or OS',
      'network': 'captions: the speech recognizer is unreachable (it runs on Google servers, not locally)',
      'language-not-supported': `captions: no recognizer for ${rec.lang}`,
    }[e.error];
    flashHint(said ?? `captions stopped: ${e.error}`);
  };
  try { rec.start(); } catch (e) { report('stt', e); wanted = false; }
}
