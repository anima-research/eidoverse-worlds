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
// flagged to the gang: Chrome ships audio to Google's recognizer — and that is
// not desktop-only, as this comment used to imply. Researched 2026-08-16:
// webkitSpeechRecognition is cloud-based on EVERY platform. Chrome on Android
// exposes the newer on-device API surface but ships no models, so
// `available({processLocally: true})` always resolves "unavailable"; Samsung
// Internet exposes only the legacy constructor, which has always been cloud.
// So there is no configuration in which enabling captions keeps the audio on
// the device. Local whisper is the planned upgrade; the say-pipe stays
// identical.
//
// ┌──────────────────────────────────────────────────────────────────────────┐
// │ 🔴 STT ON PHONES: WORKS, ~50% OF THE TIME. Measured 2026-08-16.          │
// │                                                                          │
// │ Do not "fix" this by disabling captions on mobile — that was proposed    │
// │ twice and both versions would have blocked a WORKING feature.            │
// │                                                                          │
// │ Real numbers, Samsung Galaxy / Chrome, speaking "Hello" repeatedly:      │
// │   speech×6  result:final×3  nomatch×4  err:aborted×1                     │
// │ Three transcriptions reached the world log. Roughly half of the          │
// │ utterances the recognizer HEARD came back empty.                         │
// │                                                                          │
// │ Confounder, honestly: the tester's mobile data was dropping during that  │
// │ session, and this recognizer is CLOUD-based (every utterance is a round  │
// │ trip to Google). An unknown share of those nomatches may be network, not │
// │ recognition. It has been measured ONCE, on ONE device.                   │
// │                                                                          │
// │ Get the current numbers before theorising — the page reports itself:     │
// │   /stt        in world chat — build, lang, event tally, last event       │
// │   /stt say    posts that line INTO the world (no copy/paste on mobile)   │
// │ `nomatch` = heard, recognised nothing. `speech` = classified as speech.  │
// │ A tally with speech×N and result:final×0 is the broken case; anything    │
// │ with finals in it is the unreliable-but-working case.                    │
// │                                                                          │
// │ Full history, four options and why three are wrong:                      │
// │   notes/DECISION-android-captions.md                                     │
// │ Upstream: https://issues.chromium.org/issues/40324711                    │
// └──────────────────────────────────────────────────────────────────────────┘
//
// 🔴 ANDROID: `continuous` DOES NOT WORK. Chromium issue 40324711 — recognition
// stops after ~3-4s of no speech regardless of the flag, and upstream has
// debated faking it vs throwing not-supported. The documented workaround is
// restarting in onend, which is what this file does — and on Android that
// restart plays the OS connect/disconnect earcon EVERY time. R heard exactly
// that as "a chime every 6-8 seconds": it is the workaround being audible, not
// a bug of ours and not a notification.

import { report, bus } from './base.js';
import { sttConsented } from './voiceconsent.js';
import { sendVerb } from './net.js';
import { flashHint } from './ui.js';
// 🔴 flashHint is a 2.6s OVERLAY, not a log (ui.js:flashHint). Every caption
// failure I "surfaced" this morning appeared and vanished on a phone screen
// nobody was watching — R: "not getting any chat log errors when STT fails on
// phone", and she was right, there were none. A failure worth telling someone
// about has to persist where they can scroll back to it.
// Lazy, same pattern as micstate's flashHint: a static chat.js import drags
// core.js's full surface (assignColors, colorFor) into every context that
// mocks core for headless tests — the composed lifecycle suite crashed on
// exactly that (#131 re-review). STT's chat lines are advisory; losing one on
// a failed import is fine, losing the module graph is not.
const logChat = (who, text) => import('./chat.js').then((m) => m.logChat(who, text)).catch(() => {});
// The mic's real state — this module's capture must never outlive it.
//
// 🔴 ASK WHICHEVER TRANSPORT IS ACTUALLY RUNNING. voice.js's `micOn()` reads
// the MESH's module-level micStream, which is null forever on an SFU client —
// so importing it directly made this guard permanently false and STT
// permanently off (R, 2026-08-15: "I toggled it on and now it's just
// perma-off"). That is the same defect the mic BUTTON had: state read from one
// transport while another is live. One helper, asked in transport order.
import { micOn as meshMicOn } from './micstate.js';
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

// 🔴 MODULE SCOPE, ASSIGNED AT LOAD (fixed 2026-08-16 — the tally did not print
// on R's phone at all). Both of these lived inside setSTT(): __sttTally was
// only assigned from inside mark(), so it did not EXIST until STT had been
// switched on AND an event had fired — and /audio run after toggling STT off
// showed no bracket, which reads exactly like "no events" rather than "the
// probe is not wired". A diagnostic that is absent when unused is
// indistinguishable from a diagnostic reporting nothing.
//
// Worse, `tally` was re-created per setSTT() call, so counts reset on every
// toggle — it could never accumulate across the on/off cycle we are trying to
// measure. Both now persist for the page's lifetime.
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
  // 🔴 THE LANGUAGE IS A PRIME SUSPECT FOR nomatch (2026-08-16). R's Galaxy
  // returned nomatch×5 — final results recognising nothing — after speech was
  // detected. The Samsung-specific reports call this out: navigator.language on
  // a Galaxy may not match what is actually being spoken, and a recognizer
  // asked for the wrong language returns confident nothing rather than an
  // error. Report it so the phone can tell us instead of us guessing.
  rec.lang = navigator.language || 'en-US';
  try { window.__sttLang = rec.lang; } catch { /* no window */ }
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
      mark(`results: ${fin} final, ${interim} interim`
        + (fin === 0 && interim > 0 ? '  ← hearing you, never finalizing' : ''),
        fin ? 'result:final' : 'result:interim');
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
    // 🔴 COUNT THE RESTARTS (2026-08-16). On Android the session ends every
    // 6-8s no matter what, so this handler re-starts it forever — and every
    // start/stop plays the OS recognition earcon. R heard "a chime every 6-8
    // seconds" and that was the loop being audible; the same loop is why
    // nothing is ever transcribed, since a session that dies that fast never
    // survives to finalize. One symptom she could hear, one she could not,
    // both this.
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
  rec.onaudiostart = () => { sawAudio = true; mark('audio reached the recognizer', 'audiostart'); };
  rec.onstart = () => {
    mark('started', 'start');
    // Give it a beat: if recognition starts but never receives audio, that is
    // the contention signature and it is otherwise invisible.
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
  // 🔴 nomatch — the fourth invisible state (found by RESEARCH, 2026-08-16,
  // after R said "maybe you should research this before guessing more" and she
  // was right; I had burned two theories by then). It fires when the recognizer
  // returns a FINAL result in which nothing was confidently recognised —
  // distinct from no-speech (heard nothing) and from a result we dropped for
  // not being final. Without it, "the recognizer heard you and understood
  // nothing" is invisible.
  // 🔴 SOUND IS NOT SPEECH (R, 2026-08-16: "a lot of live mics don't return any
  // STT because it's not speech, just random noises like coughing").
  //
  // She caught a false positive I was about to ship: "the session ended with no
  // final result" is ALSO what a perfectly healthy recognizer does when nobody
  // said words — a quiet room, a cough, papers shuffling. Blocking captions on
  // that would tell people the feature is broken on machines where it works,
  // and it would fire almost every time rather than rarely.
  //
  // The API already draws the distinction, and we were listening to neither
  // half: `soundstart` is any audio, `speechstart` is audio the recognizer
  // judges to be SPEECH. A cough raises soundstart alone. So any future
  // "captions are broken here" test must key on speechstart — heard actual
  // speech, produced nothing — and never on the absence of results.
  rec.onsoundstart = () => mark('sound detected (not necessarily speech)', 'sound');
  rec.onspeechstart = () => mark('SPEECH detected', 'speech');
  rec.onspeechend = () => mark('speech ended', 'speechend');
  rec.onnomatch = () => {
    mark('nomatch — heard something, recognised nothing', 'nomatch');
    // 🔴 TELL THEM IT MISSED (2026-08-16). Measured on a phone: roughly half of
    // heard utterances come back empty. A silent miss is indistinguishable from
    // "you did not speak", so people conclude the world dropped their line —
    // and it is invisible to us too. This does not fix the miss; it stops it
    // being a mystery, which is the honest thing we CAN do while the recogniser
    // stays cloud-based and upstream-broken.
    //
    // Deliberately quiet: one short local line, never a `say`. A failed
    // transcription is not an utterance and must not reach the room — that
    // would put "(didn't catch that)" in the world log as if it were speech.
    // 🔴 RATE-LIMIT IT. The measured session had nomatch×4 in a couple of
    // minutes, and a mic in a noisy room will produce far more — a notice
    // printed every time becomes the spam it was meant to prevent, and trains
    // people to ignore the one that matters. At most one every 30s.
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

// 🔴 RUNNING-STT IS DERIVED STATE, NOT A CLICK'S SIDE EFFECT (R, 2026-08-16:
// "I don't see any STT at all landing in the chatlog", desktop, consent long
// since granted). setSTT(true) had exactly ONE caller: the HUD mic button's
// own click handler (mictoggle.flipMic). Turn the mic on any other way — the
// audio panel's microphone checkbox, or the bridge's reconnect replay after a
// reload, which is precisely what a reload does — and captions never start,
// with consent granted, the recognizer available, and no error anywhere.
//
// The truth is a conjunction: consent AND a live mic AND a recognizer. So
// derive it, from the same two events whose emitters already existed with
// nothing listening. flipMic keeps its one legitimate extra job — ASKING for
// consent the first time — and this keeps the running state true afterwards.
function syncSTT() {
  const want = sttConsented() && micIsLive() && sttAvailable();
  if (want !== wanted) setSTT(want);
}
bus.on('audio:mic', syncSTT);
bus.on('audio:stt-consent', syncSTT);
