// tts — THE MOUTH. Everything that makes samples: the registered synthesizer
// function, the MediaStreamTrackGenerator, the wall-clock pacer, the queue,
// the sidetone monitor, the own-say bridge, and the benches.
//
// This module was evicted from voicesource.js (#90 review B1): the SEAM
// stays there — 88 lines, no synthesizer — and this module registers into it
// as a synth PROVIDER (setSynthProvider), handing over a finished
// MediaStreamTrack. voice.js and the mesh never import from here.
//
// LOCAL, always. Synthesis on the client costs the server nothing and scales
// with clients rather than with the room (R, 2026-08-08).

import { report } from './core.js';
import { setSynthProvider, notifySynthTrackChanged } from './voicesource.js';
import { audioContext } from './audioctx.js';

// The registered TTS source. null = ordinary microphone.
//   fn: (text: string) => Promise<{pcm: Int16Array, sampleRate: number}>
// A *function pointer*, deliberately: an agent points at its own synthesizer
// and nothing here needs to know what produces the samples.
let ttsFn = null;
let ttsName = '';        // shown in the audio panel so it is never ambiguous
let ttsEnabled = false;  // OFF by default — speaking is opt-in, like a mic

let genTrack = null;     // the live MediaStreamTrackGenerator, if any
let writer = null;

export const ttsAvailable = () => !!ttsFn;
export const ttsVoiceName = () => ttsName;
export const isTtsEnabled = () => ttsEnabled && !!ttsFn;

/** Point this body's mouth at a synthesizer. Called by an agent harness, never
 *  by the UI. Passing null reverts to the microphone. */
export function setTtsSource(fn, name = 'TTS') {
  ttsFn = fn || null;
  ttsName = fn ? name : '';
  if (!fn) ttsEnabled = false;
}

// ── the human path to the SAME seam ─────────────────────────────────────────
// A human picking a voice and an agent registering one MUST be the same call,
// or the two drift and "how is that one speaking?" stops having one answer.
// setTtsSource is that call for both; a UI is only ever a wrapper over it.
//
// 🔴 The browser's own speechSynthesis CANNOT be that source, and this is a
// hard platform limit rather than something to work around. The Web Speech API
// offers no route from speak() to an AudioNode, MediaStream or Blob — on Linux
// synthesis does not even occur in the browser (speech-dispatcher over a
// socket), so there is nothing to capture. The spec request to allow
// SpeechSynthesis → MediaStreamTrack (WICG/speech-api#69) is still open and
// unimplemented. A first draft here routed speak() through a
// MediaStreamDestination + MediaRecorder; that records SILENCE, because
// nothing is ever connected to the destination. It cannot be.
//
// So a human who wants a synthesized voice needs a source that RETURNS SAMPLES:
//   • a local synthesizer over the same ws protocol piperbridge.js uses
//   • an in-browser WASM TTS (Piper via onnxruntime-web, kokoro-js, sherpa-onnx)
//   • a cloud TTS returning wav/mp3, decoded with decodeAudioData
// All three are ordinary `(text) => {pcm, sampleRate}` functions and all three
// go through setTtsSource unchanged. The seam is already symmetric; what a
// human lacks is a bundled source, not a different API.
//
// The in-browser option is REAL and close: kokoro-js runs an 82M TTS entirely
// client-side (WASM, or WebGPU where available) and tts.generate(text) hands
// back samples — ~82MB cached after first load, 21 voices, no server and no
// install. Piper-via-onnxruntime-web is the same shape (~75MB, VITS, ~0.03
// realtime factor, first audio ~40ms). Either is a drop-in `(text) =>
// {pcm, sampleRate}`; neither needs one line of this file to change.
//
// So the honest statement is narrow: the browser's BUILT-IN speechSynthesis
// cannot feed the mic lane. Every other synthesizer can, including ones that
// run in the same page. Do not read the paragraph above as "browsers cannot do
// TTS into WebRTC" — they can, and this codebase already does it with Piper
// over a socket (2.70s of audio in 0.08s, measured 2026-08-08).
//
// Until a source is bundled the UI row stays honest: toggle disabled, field
// reads "system default (microphone)". No pretend voice picker.

/** The audio panel's toggle. Humans leave this off and use a mic; an agent
 *  turns it on once its source is registered. */
export function setTtsEnabled(on) {
  const was = ttsEnabled;
  ttsEnabled = !!on && !!ttsFn;
  // 🔴 EITHER ORDER MUST WORK. voiceSource() mixes the synth in when the mic
  // opens — but enabling TTS AFTER the mic is already live used to just set a
  // flag, so nothing was ever connected and speech went nowhere. That is the
  // mirror of the bug this fixes, and shipping only one direction would be the
  // asymmetric repair this codebase keeps producing. Wire (or unwire) it here
  // too, so mic-then-TTS and TTS-then-mic reach the same place.
  // 🔴 EITHER ORDER MUST WORK, ONE MECHANISM ONLY (#91 B3). Enabling TTS with
  // the mic already live arms it for later and touches nothing — MIC BEATS
  // TTS (R, 2026-08-09), and the mic's retirement path (voice.js mic-off)
  // does the takeover via rebindSenders. Enabling with the mic off performs
  // the takeover HERE, by the same mechanism: the generator goes ON the
  // sender via replaceTrack. There is no WebAudio mixing path any more —
  // micgate's destination node produces NOTHING where the AudioContext clock
  // stalls (field-measured 2026-08-10: 'running', +0.000s/2s, 17 packets
  // EVER), which is every headless body; two divergent handoffs also allowed
  // an ordering where synth stayed mixed in while the raw mic reopened.
  if (ttsEnabled !== was && typeof window !== 'undefined') {
    import('./voice.js').then((v) => {
      const micLive = v.micOn?.();
      if (ttsEnabled && canSynthesize() && !micLive) {
        startPacer(); notifySynthTrackChanged(ensureGenerator());
      } else if (!ttsEnabled) {
        // Disable stills the producer; the senders keep the (now silent)
        // generator track unless a live mic already reclaimed them — the
        // same standing-lane rule the mic release uses.
        stopPacer();
      }
    }).catch(() => {});
  }
  return ttsEnabled;
}

// ── the generator ───────────────────────────────────────────────────────────
// MediaStreamTrackGenerator fed timestamped PCM at WALL-CLOCK pace. The pacing
// is the load-bearing part and it is not ours: voicebox/page.html found that a
// realtime AudioContext in a headless browser runs its clock at ~1% and stalls
// mid-run. Frames as DATA, paced by the wall clock, is what fixed it there.
//
// Chromium-only today. Firefox has no MediaStreamTrackGenerator, so an agent
// there falls back to the microphone path (i.e. stays silent) rather than
// throwing — a missing voice must never take the body down with it.
const CHUNK_MS = 20;

export const canSynthesize = () => typeof MediaStreamTrackGenerator !== 'undefined';

// Fired when a DEAD generator is replaced by a live one. The new track is a
// different object, so every sender still holding the old one transmits silence
// forever — ICE healthy, direction sendonly, nothing to see. voice.js listens
// and replaceTrack()s it onto the existing senders (no renegotiation).
// sourceIsDead() was written for exactly this and had ZERO callers, the same
// way toggleMute did while the HUD called the destructive path.
/** Test seam: fire the installed hook without having to kill a real generator
 *  (MediaStreamTrackGenerator does not exist under happy-dom). */

// Exported so the mic-off handover can wire the synth in (voice.js). Internal
// to the module otherwise — nothing else should be minting generators.
export function ensureGenerator() {
  if (genTrack && genTrack.readyState === 'live') return genTrack;
  const replacing = !!genTrack;
  // An ENDED generator is not a dead end: make a new one and hand it back. The
  // caller replaceTrack()s it onto the existing sender — no device, no
  // permission prompt, no renegotiation. This is the recovery a microphone
  // cannot offer, and the reason a TTS source is easier to keep alive than a
  // mic (R, 2026-08-08).
  genTrack = new MediaStreamTrackGenerator({ kind: 'audio' });
  writer = genTrack.writable.getWriter();
  if (replacing) {
    console.warn('[voice] generator was dead — rebuilt; re-binding senders');
    notifySynthTrackChanged(genTrack);   // voice.js re-binds every sender
  }
  return genTrack;
}

/** Speak text through the registered synthesizer. Silent no-op when TTS is off
 *  or unavailable — callers should not have to branch. */
export async function speak(text) {
  const epoch = ttsEpoch;
  // EVERY REFUSAL SAYS WHY. This function had five silent `return false`
  // paths, so "nothing came out" looked identical whether TTS was off, the
  // sender was missing, or the synthesizer returned empty. A whole evening was
  // spent unable to tell those apart (2026-08-08).
  if (!isTtsEnabled()) { console.warn(`[voice] speak refused: tts off (enabled=${ttsEnabled} fn=${!!ttsFn})`); return false; }
  // NO SINK IS NOT NO REASON TO SPEAK. This used to refuse outright, which meant
  // a human who picked a voice and typed heard nothing until they also opened
  // their mic — an unrelated control, and not one anybody would guess at. With
  // sidetone we can still play it locally; only TRANSMISSION needs the lane.
  // Say which of the two happened rather than silently doing half.
  if (!canSynthesize() && !sidetone()) {
    console.warn('[voice] speak refused: no generator sink and sidetone off');
    return false;
  }
  console.log(`[voice] synthesizing ${text.length} chars…`);
  let out;
  try {
    out = await ttsFn(text);
  } catch (e) { report('tts synthesize', e); return false; }
  if (!out?.pcm?.length) { console.warn('[voice] synthesizer returned no pcm'); return false; }
    // 🔴 IS THE PCM ITSELF CLEAN? R, 2026-08-09: short utterances sound "badly
    // compressed or staticy", long ones are perfect. That is NOT a prosody
    // complaint — static means the SAMPLES are wrong, so measure them before the
    // pacer can be blamed. Clipping and DC offset both sound like distortion and
    // both show up in one pass; if these are clean, the fault is downstream.
    {
      const pcm = out.pcm;
      let peak = 0, sum = 0, clipped = 0;
      for (let i = 0; i < pcm.length; i++) {
        const v = pcm[i]; const a = v < 0 ? -v : v;
        if (a > peak) peak = a;
        if (a >= 32767) clipped++;
        sum += v;
      }
      const dc = sum / pcm.length;
      console.log(`[voice] pcm: ${pcm.length} samples @${out.sampleRate}Hz `
        + `peak ${(peak / 32768).toFixed(3)} (${(20 * Math.log10(peak / 32768 || 1e-9)).toFixed(1)} dBFS) `
        + `dc ${(dc / 32768).toFixed(4)} clipped ${clipped}`
        + (clipped > pcm.length * 0.001 ? '  ⚠️ CLIPPING' : '')
        + (Math.abs(dc / 32768) > 0.01 ? '  ⚠️ DC OFFSET' : ''));
    }
  // QUEUE IT — DO NOT PUSH IT. The frames are handed to a wall-clock pacer that
  // is already running; see the pacer below for why the track must never starve.
  if (epoch !== ttsEpoch) {
    console.warn('[voice] synthesis finished after a disable — result dropped (stale, not current)');
    return false;
  }
  enqueue(out.pcm, out.sampleRate);
  return true;
}

// ── the pacer: A MOUTH IS ALWAYS OPEN ──────────────────────────────────────
// THE BUG THIS FIXES (2026-08-08): speak() used to write its frames in a tight
// await loop and then stop. Between utterances the generator got NOTHING, so
// the track was starved — and a starved MediaStreamTrackGenerator is not a
// quiet microphone, it is a track with no media to encode. Every local check
// passed (samples written, speak() returned true, sender bound, ICE connected)
// and the room heard silence.
//
// The workbench rig got this right and I dropped it in the port: it runs a
// 10ms pacer that writes exactly as many frames as wall time OWES, filling
// them with speech when there is speech and with SILENCE when there is not, so
// the track never starves. Speech is what fills the frames; the frames happen
// regardless. That is what makes this behave like a microphone, which is the
// entire point of the source design — a mic keeps producing silence when you
// are not talking, and the mesh keeps carrying it.
// 🔴 RESAMPLE TO 48k OURSELVES, ONCE, WITH A REAL FILTER.
//
// R, 2026-08-09: short utterances sound "badly compressed or staticy"; long ones
// are fine. The pcm arriving from the model is CLEAN (measured: peak -3.4 dBFS,
// dc -0.0009, 0 clipped), so the distortion is downstream — and the one lossy
// step downstream is rate conversion. Piper emits 22050 Hz; WebRTC/Opus encodes
// at 48000. 48000/22050 = 2.1768…, not an integer ratio, so a cheap linear
// resampler aliases — worst on short bursts, where there is no steady signal for
// it to settle into. Exactly the reported symptom.
//
// The monitor path does NOT have this problem because WebAudio resamples with a
// proper filter. Same samples, two routes, one sounds right: that is the tell.
//
// So we hand WebRTC audio already at its native rate and skip its converter.
const OUT_RATE = 48000;
// (RATE_HINT is gone: the pacer now speaks ONE rate, OUT_RATE. Keeping a second
// rate around was how 22050-sized frames got declared as 48k in my first pass.)
const FRAME = Math.round(OUT_RATE / 50);   // 20ms at the OUTPUT rate
let queue = [];            // pending {pcm, sampleRate}
// Disable epoch (#91 B2's stale-becomes-current hole, caught by the harness):
// a synthesis in flight when TTS is disabled completes AFTER stopPacer cleared
// the queue and would re-enqueue into it — re-enabling then played text the
// user disabled minutes ago. speak() captures the epoch before synthesizing
// and its result is dropped if a disable happened in between.
let ttsEpoch = 0;
let qOff = 0;              // read offset into queue[0]
let playhead = 0;          // samples emitted since the pacer started
let t0 = 0;
let pacer = null;

/** SIDETONE — hearing your own synthesized voice.
 *
 *  R, 2026-08-09: "I don't hear anything when I type into the chat box. Hearing
 *  yourself as a human using TTS is half the fun."
 *
 *  She is right, and the omission was structural: speak() feeds the SENDER, so
 *  the samples go to the room and never to your own speakers. Everyone else
 *  hears you; you are the one person who cannot. (Telephony calls this
 *  sidetone, and leaves it in deliberately — a line with none sounds dead.)
 *
 *  A separate AudioContext path, not a loopback of the peer connection: we own
 *  the PCM before it is paced onto the track, so this stays exact and adds no
 *  round trip. Off for renderers/spectators, which have no business making
 *  noise.
 */
// The sidetone plays through the PAGE's one AudioContext (audioctx.js), not a
// private one. A second context here is exactly the disease #86 exists to cure:
// it counts against Chrome's ~six-context cap and its output cannot compose with
// the shared gain graph (distance, category sliders, ambient bed).
let monitorOn = (() => {
  try { return localStorage.getItem('eido.ttsSidetone') !== 'off'; } catch { return true; }
})();
export const sidetone = (on) => {
  if (on !== undefined) {
    monitorOn = !!on;
    try { localStorage.setItem('eido.ttsSidetone', on ? 'on' : 'off'); } catch { /* private mode */ }
  }
  return monitorOn;
};

function monitor(pcm, sampleRate) {
  if (!monitorOn || !pcm?.length) return;
  try {
    const monitorCtx = audioContext();
    // A context created before a user gesture starts suspended; a resume() that
    // never lands must not throw away the sample.
    if (monitorCtx.state === 'suspended') void monitorCtx.resume();
    const buf = monitorCtx.createBuffer(1, pcm.length, sampleRate);
    const ch = buf.getChannelData(0);
    for (let i = 0; i < pcm.length; i++) ch[i] = pcm[i] / 32768;
    const src = monitorCtx.createBufferSource();
    const g = monitorCtx.createGain();
    // Slightly under unity: your own voice should sit behind the room, the way
    // sidetone always does, rather than competing with it.
    g.gain.value = 0.8;
    src.buffer = buf;
    src.connect(g).connect(monitorCtx.destination);
    src.start();
  } catch (e) { console.warn('[voice] sidetone failed (still transmitting):', e?.message || e); }
}

/** Resample to OUT_RATE with WebAudio's own (good) resampler, so the browser's
 *  WebRTC path never has to do it with a cheap one.
 *
 *  OfflineAudioContext resamples on render — the same filter the monitor path
 *  gets for free, which is why the monitor sounds right and the sent audio does
 *  not. Async, so callers queue the RESULT rather than the raw pcm. */
async function toOutRate(pcm, inRate) {
  // 🔴 SWITCHABLE, because I added this stage on a theory that later turned out
  // to be the WRONG explanation for the symptom it was meant to fix (the real
  // cause of bad short utterances was missing terminal punctuation —
  // rhasspy/piper#252). Resampling myself may be a genuine improvement, a no-op,
  // or a SECOND resample on top of the browser's own — I never verified which,
  // which is exactly the mistake this file keeps recording.
  //   localStorage.eidoTtsResample = 'off'   → hand WebRTC the native rate
  // A/B it by ear; the probe below prints what each path produces.
  try {
    if (localStorage.getItem('eidoTtsResample') === 'off') {
      const f = new Float32Array(pcm.length);
      for (let i = 0; i < pcm.length; i++) f[i] = pcm[i] / 32768;
      return f;
    }
  } catch { /* private mode */ }
  if (inRate === OUT_RATE) {
    const f = new Float32Array(pcm.length);
    for (let i = 0; i < pcm.length; i++) f[i] = pcm[i] / 32768;
    return f;
  }
  const Ctx = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  if (!Ctx) {                                  // no offline context: send as-is
    const f = new Float32Array(pcm.length);
    for (let i = 0; i < pcm.length; i++) f[i] = pcm[i] / 32768;
    return f;
  }
  const outLen = Math.ceil((pcm.length * OUT_RATE) / inRate);
  const ctx = new Ctx(1, outLen, OUT_RATE);
  const buf = ctx.createBuffer(1, pcm.length, inRate);
  const ch = buf.getChannelData(0);
  for (let i = 0; i < pcm.length; i++) ch[i] = pcm[i] / 32768;
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.connect(ctx.destination);
  src.start();
  const rendered = await ctx.startRendering();
  const outCh = rendered.getChannelData(0);
  // Same measurement the pcm probe makes, one stage later. Clean in + dirty out
  // here would be conclusive; matching stats mean the resampler is exonerated
  // and the fault is further down (pacer, generator, or Opus).
  {
    let peak = 0, sum = 0;
    for (let i = 0; i < outCh.length; i++) { const a = Math.abs(outCh[i]); if (a > peak) peak = a; sum += a * a; }
    console.log(`[voice] resampled ${pcm.length}@${inRate} → ${outCh.length}@${OUT_RATE} `
      + `peak ${peak.toFixed(3)} rms ${Math.sqrt(sum / (outCh.length || 1)).toFixed(4)}`
      + (peak > 0.999 ? '  ⚠️ CLIPPING INTRODUCED' : ''));
  }
  return outCh;
}


function enqueue(pcm, sampleRate) {
  monitor(pcm, sampleRate);          // hear yourself, then send
  // Deliberately NOT gated on having a sender. Two traps I walked into here:
  // canSynthesize() tests browser SUPPORT for MediaStreamTrackGenerator (not an
  // open lane), and `genTrack` is CREATED by ensureGenerator() inside
  // startPacer() — so gating on either would block the first utterance and stop
  // the generator from ever being built. The pacer's own `if (!writer) return`
  // already makes a senderless queue harmless; it drains once a lane exists.
  if (!canSynthesize()) return;
  // Resample BEFORE queueing so the pacer only ever handles OUT_RATE floats and
  // the frame math has exactly one rate in it.
  // EPOCH-GUARDED at the PUSH, not just at speak() (r5 self-review): the
  // resample is async, so a disable can land between this call and the
  // callback — and an unguarded push here re-opened the stale-becomes-current
  // hole one stage after the epoch closed it at speak(). The audio a user
  // disabled must die at EVERY asynchronous seam it could cross, not the
  // first one.
  const epoch = ttsEpoch;
  void toOutRate(pcm, sampleRate)
    .then((f) => { if (epoch === ttsEpoch) queue.push(f); })
    .catch((e) => report('resample', e));
}

function fillSpeech(out) {
  let i = 0;
  while (i < out.length) {
    const head = queue[0];
    if (!head) break;                       // nothing queued → leave silence
    const src = head;                       // already Float32 at OUT_RATE
    const n = Math.min(out.length - i, src.length - qOff);
    for (let k = 0; k < n; k++) out[i + k] = src[qOff + k];
    i += n; qOff += n;
    if (qOff >= src.length) { queue.shift(); qOff = 0; }
  }
}

export function startPacer() {
  if (pacer) return;
  ensureGenerator();
  t0 = performance.now();
  playhead = 0;
  pacer = setInterval(() => {
    if (!writer) return;
    const owed = Math.floor(((performance.now() - t0) / 1000) * OUT_RATE) - playhead;
    for (let n = 0; n + FRAME <= owed; n += FRAME) {
      const data = new Float32Array(FRAME);
      fillSpeech(data);
      try {
        writer.write(new AudioData({
          format: 'f32', sampleRate: OUT_RATE, numberOfFrames: FRAME,
          numberOfChannels: 1, timestamp: Math.round((playhead / OUT_RATE) * 1e6), data,
        }));
      } catch (e) { report('tts write', e); }
      playhead += FRAME;
    }
  }, 10);
}

/** Stop pacing (releases the interval). The track stays live. */
export function stopPacer() {
  if (pacer) { clearInterval(pacer); pacer = null; }
  queue = []; qOff = 0;
  ttsEpoch++;              // anything still synthesizing belongs to the old era
}

/** Probe seam: is the mouth open, and how much is waiting to be said? */
export const mouthInfo = () => ({ pacing: !!pacer, queued: queue.length, playhead });

/** What voice.js calls instead of getUserMedia. Returns a MediaStream from
 *  whichever source this body uses. */

// ── speak your own says ─────────────────────────────────────────────────────
// world.js already emits 'speech' for every say that was not already performed
// (args.spoken marks the ones a voice paced itself, so this cannot
// double-speak). A body with a synthesizer listens for its OWN and voices it:
// that is the entire bridge from "posted text" to "made a sound", and it runs
// through the ordinary sender, so distance, the category slider and consent all
// apply exactly as they do to a microphone.
export function speakOwnSays(bus, myId) {
  bus.on('speech', async ({ actor, text }) => {
    const mine = actor === myId();
    if (!mine) return;                       // someone else's say: not ours to voice
    if (!isTtsEnabled()) { console.warn(`[voice] own say NOT spoken — tts disabled`); return; }
    // #91 B3, declared policy: a typed say while the mic is live is DISCARDED,
    // visibly. Mic beats TTS is a priority — synthesizing-but-not-sending
    // burns cycles for nothing, and queuing behind a live mic means old text
    // suddenly playing minutes later when the mic drops. You spoke with your
    // voice; the text stays text.
    const micLive = (await import('./voice.js')).micOn?.();
    if (micLive) { console.warn(`[voice] own say NOT synthesized — mic is live, mic beats TTS: "${String(text).slice(0, 40)}"`); return; }
    console.log(`[voice] own say → speaking: "${String(text).slice(0, 60)}"`);
    void speak(text);
  });
}

/** THE ONE QUESTION A SILENT VOICE CANNOT ANSWER FROM INSIDE: is the track we
 *  are feeding the same object the peer connection is sending? speak() can
 *  return true — synthesized, written, no errors — while the samples pour into
 *  an orphan generator because the mic lane opened from a different source.
 *  Every local check still passes and the room hears nothing. This exposes the
 *  identity so a probe can compare it against the sender's track. */
export const genTrackInfo = () => (genTrack
  ? { id: genTrack.id, kind: genTrack.kind, readyState: genTrack.readyState, enabled: genTrack.enabled }
  : null);



/** Benchmark the current voice: N runs of the same text, reporting the spread.
 *
 *  Exists because every latency claim today has been settled by measurement and
 *  none by argument. Run it, switch backend, run it again:
 *
 *      await ttsBench('hello')                     // current backend
 *      localStorage.eidoTtsBackend = 'wasm'        // then reload and re-run
 *
 *  Reports P50 and best rather than a mean: a mean over 5 runs hides the one
 *  slow first call that the user actually feels.
 */
export async function ttsTTFS(text = 'hello there, this is a test', runs = 3) {
  // 🔴 TIME TO FIRST SOUND — the number a LISTENER experiences, which is not the
  // same as `infer`. R, 2026-08-09: "as long as you can load your own models from
  // your end you ought to be able to poll time to first sound, since TTS is wired
  // to be able to hear yourself." Exactly: self-monitoring makes an agent its own
  // measurement instrument, no human in the loop.
  //
  // TTFS = phonemize + infer + everything between the call and audio existing.
  // Optimising `infer` alone can move that number not at all, which is precisely
  // the mistake this whole evening kept making at a different layer.
  if (!isTtsEnabled() || !ttsFn) { console.warn('[ttfs] no voice loaded'); return null; }
  const out = [];
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    const r = await ttsFn(text);
    const ttfs = performance.now() - t0;
    const secs = (r?.pcm?.length || 0) / (r?.sampleRate || 22050);
    out.push({ ttfs, secs });
  }
  out.sort((a, b) => a.ttfs - b.ttfs);
  const p50 = out[Math.floor(out.length / 2)];
  console.log(`[ttfs] ${JSON.stringify(text)} ×${runs}: `
    + `best ${Math.round(out[0].ttfs)}ms · P50 ${Math.round(p50.ttfs)}ms `
    + `→ ${p50.secs.toFixed(2)}s audio · RTF ${(p50.ttfs / 1000 / Math.max(p50.secs, 1e-6)).toFixed(3)}`);
  return { best: out[0].ttfs, p50: p50.ttfs, secs: p50.secs };
}
if (typeof window !== 'undefined') window.ttsTTFS = ttsTTFS;

export async function ttsBench(text = 'hello', runs = 5) {
  if (!isTtsEnabled() || !ttsFn) { console.warn('[bench] no voice loaded'); return null; }
  const ms = [];
  let secs = 0;
  for (let i = 0; i < runs; i++) {
    const t = performance.now();
    const out = await ttsFn(text);
    ms.push(performance.now() - t);
    secs = (out?.pcm?.length || 0) / (out?.sampleRate || 22050);
  }
  ms.sort((a, b) => a - b);
  const p50 = ms[Math.floor(ms.length / 2)];
  console.log(`[bench] ${JSON.stringify(text)} ×${runs}: `
    + `best ${Math.round(ms[0])}ms · P50 ${Math.round(p50)}ms · worst ${Math.round(ms.at(-1))}ms `
    + `→ ${secs.toFixed(2)}s audio · RTF ${(p50 / 1000 / Math.max(secs, 1e-6)).toFixed(3)}`);
  return { best: ms[0], p50, worst: ms.at(-1), secs };
}
if (typeof window !== 'undefined') window.ttsBench = ttsBench;


/** Speak the same text N times so you can hear the SPREAD, not one sample.
 *
 *  R, 2026-08-09, found the need for this with a one-character test: two strings
 *  that phonemize identically sounded different, because VITS samples noise on
 *  every call. Judging a voice from one utterance is judging one draw.
 */
export async function ttsSpread(text = 'hello there', runs = 5) {
  if (!isTtsEnabled() || !ttsFn) { console.warn('[spread] no voice loaded'); return null; }
  const rows = [];
  for (let i = 0; i < runs; i++) {
    const r = await ttsFn(text);
    const pcm = r?.pcm || [];
    let peak = 0, sum = 0;
    for (let k = 0; k < pcm.length; k++) { const a = Math.abs(pcm[k]); if (a > peak) peak = a; sum += a * a; }
    rows.push({ n: pcm.length, peak: peak / 32768, rms: Math.sqrt(sum / (pcm.length || 1)) / 32768 });
  }
  const lens = rows.map((r) => r.n);
  const spread = (Math.max(...lens) - Math.min(...lens)) / Math.max(...lens) * 100;
  console.log(`[spread] ${JSON.stringify(text)} ×${runs}: `
    + `${Math.min(...lens)}-${Math.max(...lens)} samples (${spread.toFixed(1)}% length spread)`);
  rows.forEach((r, i) => console.log(`  run ${i + 1}: ${r.n} samples  peak ${r.peak.toFixed(3)}  rms ${r.rms.toFixed(4)}`));
  return { spread, rows };
}
if (typeof window !== 'undefined') window.ttsSpread = ttsSpread;

// ── the provider registration ────────────────────────────────────────────────
// voicesource.js owns the QUESTION (where does this body's voice come from);
// this module is one ANSWER. available() is enablement AND capability — a
// registered engine with TTS switched on. start() hands the generator track
// over with the pacer running; stop() stills the pacer but leaves enablement
// standing (mic beats TTS is a priority, not a toggle).
setSynthProvider({
  label: () => ttsName || 'TTS',
  available: () => isTtsEnabled() && canSynthesize(),
  start: () => { const t = ensureGenerator(); startPacer(); return t; },
  stop: () => stopPacer(),
});
