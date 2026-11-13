// stt — speech transcribed in the browser and posted as ordinary `say` verbs prefixed "🎙 ",
// so transcripts land in the log agents already read and double as captions.
//
// Engine: the browser's SpeechRecognition, which is cloud-based (the audio goes to the vendor).
// Field notes, Android quirks and how to measure: docs/research/stt-browser-recognition.md.

import { say } from '../net.js';
import { report, bus } from '../base.js';
import { sttConsented } from './voiceconsent.js';
import { flashHint } from '../ui/ui.js';
// flashHint is a transient overlay, so failures go to chat too. Lazy import: a static chat.js
// import drags core.js into every headless test that mocks core.
const logChat = (who, text) => import('../ui/chat.js').then((m) => m.logChat(who, text)).catch(() => {});
// the mic's real state: this module's capture must never outlive it. SFU first (its bridge
// installs __sfuMicOn only once that transport initialised), then micstate.
import { micOn as meshMicOn } from './micstate.js';
function micIsLive() {
  try {
    if (typeof window.__sfuMicOn === 'function') return !!window.__sfuMicOn();
    return !!meshMicOn();
  } catch { return false; }   // unreadable state = not live = stay silent
}

let rec = null;
let wanted = false;
let uttSeq = 0;                 // one id per transcribed utterance (log plane)
// diagnostics readable from /audio on a device with no console; the tally persists across toggles
try { window.__sttOn = () => wanted; } catch { /* no window */ }

const tally = Object.create(null);
let lastMissNotice = 0;
let restarts = 0;
const firstStart = performance.now();
function mark(what, kind) {
  try {
    if (kind) tally[kind] = (tally[kind] ?? 0) + 1;
    window.__sttLast = what;
  } catch { /* no window */ }
}
try {
  window.__sttTally = () =>
    Object.entries(tally).map(([k, n]) => `${k}×${n}`).join(' ') || 'no events yet';
} catch { /* no window */ }
export const sttAvailable = () => !!(window.SpeechRecognition ?? window.webkitSpeechRecognition);

export function setSTT(on) {
  if (on && wanted && rec) return;      // already running — never rebuild the recognizer
  wanted = on;
  if (!on) { try { rec?.stop(); } catch { /* already stopped */ } rec = null; return; }
  const SR = window.SpeechRecognition ?? window.webkitSpeechRecognition;
  if (!SR) { const m = 'no speech recognition in this browser — voice works, captions don’t'; flashHint(m); logChat('*', m); wanted = false; return; }
  rec = new SR();
  rec.continuous = true;
  rec.interimResults = false;
  // a wrong-language recognizer returns confident nothing, so the language is surfaced
  rec.lang = navigator.language || 'en-US';
  try { window.__sttLang = rec.lang; } catch { /* no window */ }
  rec.onresult = (e) => {
    // count interims too: a stream that never finalizes (Android) looks like silence from outside
    let fin = 0, interim = 0;
    for (let i = e.resultIndex; i < e.results.length; i++) {
      (e.results[i].isFinal ? fin++ : interim++);
    }
    try {
      mark(`results: ${fin} final, ${interim} interim`
        + (fin === 0 && interim > 0 ? '  ← hearing you, never finalizing' : ''),
        fin ? 'result:final' : 'result:interim');
    } catch { /* no window */ }
    for (let i = e.resultIndex; i < e.results.length; i++) {
      if (!e.results[i].isFinal) continue;
      const text = e.results[i][0].transcript.trim();
      // spoken: true — the sound already reached the room live; never re-perform it.
      // Gate the emit too: a result arriving after the mic went off would leak a private line.
      if (!wanted || !micIsLive()) continue;
      if (text) { ++uttSeq; say(`🎙 ${text}`, { spoken: true, utt: uttSeq, live: true }); }
    }
  };
  // Chrome ends recognition on silence: restart while wanted AND the mic is live
  // (SpeechRecognition holds its own capture, so the mic toggle must govern it; fails closed).
  rec.onend = () => {
    restarts++;
    const secs = ((performance.now() - firstStart) / 1000).toFixed(0);
    if (wanted && micIsLive()) {
      try {
        rec.start();
        mark(`ended+restarted ${restarts}× in ${secs}s${restarts >= 3 ? '  ← the session keeps dying; captions cannot finalize' : ''}`, 'end');
      } catch (err) { mark(`restart failed: ${err?.message ?? err}`); report('stt restart', err); }
    }
    else if (wanted) { wanted = false; rec = null; mark('stopped: mic is off'); report('stt', 'stopped: mic is off'); }
  };
  // a caption engine that never starts must say so in chat (report() is console-only)
  let sawAudio = false;
  rec.onaudiostart = () => { sawAudio = true; mark('audio reached the recognizer', 'audiostart'); };
  rec.onstart = () => {
    mark('started', 'start');
    // started but no audio is the mic-contention signature, otherwise invisible
    setTimeout(() => {
      if (wanted && !sawAudio) {
        mark('started but NO audio after 4s (mic contention?)');
        const m = 'captions: recognition started but no audio reached it — '
          + 'another app or tab may hold the microphone';
        flashHint(m); logChat('*', m);
        report('stt', 'started but onaudiostart never fired (mic contention?)');
      }
    }, 4000);
  };
  // soundstart is any audio, speechstart is speech; nomatch is a final result with nothing recognised
  rec.onsoundstart = () => mark('sound detected (not necessarily speech)', 'sound');
  rec.onspeechstart = () => mark('SPEECH detected', 'speech');
  rec.onspeechend = () => mark('speech ended', 'speechend');
  rec.onnomatch = () => {
    mark('nomatch — heard something, recognised nothing', 'nomatch');
    // one quiet local line (never a `say`), at most every 30s
    const now = Date.now();
    if (now - lastMissNotice > 30_000) {
      lastMissNotice = now;
      logChat('*', '(didn\u2019t catch that)');
    }
  };
  rec.onerror = (e) => {
    mark(`error: ${e.error}`, `err:${e.error}`);
    if (e.error === 'no-speech' || e.error === 'aborted') return;   // ordinary silence
    report('stt', e.error);
    const said = {
      'audio-capture': 'captions: something else is holding the microphone',
      'not-allowed': 'captions: speech recognition was denied — it needs its own permission, separate from the mic',
      'service-not-allowed': 'captions: speech recognition was denied by the browser or OS',
      'network': 'captions: the speech recognizer is unreachable (it runs on Google servers, not locally)',
      'language-not-supported': `captions: no recognizer for ${rec.lang}`,
    }[e.error];
    const m = said ?? `captions stopped: ${e.error}`;
    flashHint(m); logChat('*', m);
  };
  try { rec.start(); } catch (e) { report('stt', e); wanted = false; }
}

// running STT is derived state: consent AND a live mic AND a recognizer, re-evaluated on both events
function syncSTT() {
  const want = sttConsented() && micIsLive() && sttAvailable();
  if (want !== wanted) setSTT(want);
}
bus.on('audio:mic', syncSTT);
bus.on('audio:stt-consent', syncSTT);
