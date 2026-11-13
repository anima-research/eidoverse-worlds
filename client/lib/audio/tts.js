// tts — the mouth: the registered synthesizer function, the MediaStreamTrackGenerator, the
// wall-clock pacer and queue, the sidetone monitor, the own-say bridge, and the benches.
//
// It registers into voicesource.js as a synth provider (setSynthProvider), handing over a
// finished MediaStreamTrack. Synthesis is always local. Design notes: docs/research/tts-mouth.md.

import { report, bus } from '../base.js';
import { setSynthProvider, notifySynthTrackChanged } from './voicesource.js';
import { volumeFor } from './voiceconsent.js';
import { audioContext } from './audioctx.js';

// The registered synthesizer, (text) => Promise<{pcm: Int16Array, sampleRate}>; null = microphone only.
let ttsFn = null;
let ttsName = '';        // shown in the audio panel
let ttsEnabled = false;  // off by default: speaking is opt-in, like a mic

let genTrack = null;     // the live MediaStreamTrackGenerator, if any
let writer = null;

export const ttsAvailable = () => !!ttsFn;
export const ttsVoiceName = () => ttsName;
export const isTtsEnabled = () => ttsEnabled && !!ttsFn;

/** Point this body's mouth at a synthesizer (an agent harness or ttsrow's engine load). null reverts to the microphone. */
export function setTtsSource(fn, name = 'TTS') {
  ttsFn = fn || null;
  ttsName = fn ? name : '';
  if (!fn) ttsEnabled = false;
}

/** The audio panel's toggle; an agent turns it on once its source is registered. */
export function setTtsEnabled(on) {
  const was = ttsEnabled;
  ttsEnabled = !!on && !!ttsFn;
  // Mic beats TTS. Enabling with the mic live arms it and touches nothing (the mic-off path in
  // voicesfu.js does the takeover); enabling with the mic off hands the generator over here.
  if (ttsEnabled !== was && typeof window !== 'undefined') {
    import('./micstate.js').then((v) => {
      // ask the live transport first (micstate's micOn() is null on an SFU client)
      const micLive = (typeof window !== 'undefined' && typeof window.__sfuMicOn === 'function')
        ? !!window.__sfuMicOn() : v.micOn?.();
      if (ttsEnabled && canSynthesize() && !micLive) {
        startPacer(); notifySynthTrackChanged(ensureGenerator());
      } else if (!ttsEnabled) {
        stopPacer();   // the senders keep the (now silent) generator track
      }
    }).catch(() => {});
  }
  return ttsEnabled;
}

// ── the generator ───────────────────────────────────────────────────────────
// A MediaStreamTrackGenerator fed timestamped PCM at wall-clock pace, because a realtime
// AudioContext stalls in a headless browser. Chromium-only; elsewhere an agent is silent, not broken.
const CHUNK_MS = 20;

const canSynthesize = () => typeof MediaStreamTrackGenerator !== 'undefined';

/** The live generator track, rebuilt if it ended; a rebuild notifies voicesource's hooks so
 *  voicesfubridge re-binds the senders (replaceTrack, no renegotiation). */
export function ensureGenerator() {
  if (genTrack && genTrack.readyState === 'live') return genTrack;
  const replacing = !!genTrack;
  genTrack = new MediaStreamTrackGenerator({ kind: 'audio' });
  writer = genTrack.writable.getWriter();
  if (replacing) {
    console.warn('[voice] generator was dead — rebuilt; re-binding senders');
    notifySynthTrackChanged(genTrack);
  }
  return genTrack;
}

// One speaker talks one utterance at a time: synthesis is chained per speaker so consecutive
// says cannot overlap or reorder. A rejection never poisons the chain.
const _speakChains = new Map();   // speaker -> Promise
function chain(speaker, job) {
  const key = speaker || 'self';
  const prev = _speakChains.get(key) ?? Promise.resolve();
  const next = prev.then(job, job);
  const tail = next.catch(() => {});
  _speakChains.set(key, tail);
  // drop the entry once settled, so a long-lived room does not keep one promise per departed speaker
  tail.then(() => { if (_speakChains.get(key) === tail) _speakChains.delete(key); });
  return next;
}

/** Speak text through the registered synthesizer; a no-op when TTS is off.
 *  `speaker` scopes the serialization; omit it for your own voice. */
export function speak(text, speaker) {
  return chain(speaker, () => speakChunked(text));
}

// Length is latency: piper's RTF is ~1.1 and inference runs on the main thread, so tts_chunk.js
// splits the utterance, with an aggressive opening clause for time-to-first-word.
async function speakChunked(text) {
  const { ttsChunks } = await import('./tts_chunk.js');
  const chunks = ttsChunks(text);
  if (!chunks.length) return false;          // emoji-only: in the log, not the air
  if (chunks.length === 1) return speakOne(chunks[0]);
  // one epoch for the whole utterance: a stopPacer() mid-utterance kills every later chunk too
  const epoch0 = ttsEpoch;
  let any = false;
  for (const c of chunks) {
    if (ttsEpoch !== epoch0) { console.warn('[voice] utterance cancelled between chunks — dropping the rest'); return any; }
    // sequential by design; yielding between chunks lets the page paint
    const ok = await speakOne(c);
    any = any || ok;
    await new Promise((r) => setTimeout(r, 0));
  }
  return any;
}

async function speakOne(text) {
  const epoch = ttsEpoch;
  // every refusal says why, so "nothing came out" is diagnosable
  if (!isTtsEnabled()) { console.warn(`[voice] speak refused: tts off (enabled=${ttsEnabled} fn=${!!ttsFn})`); return false; }
  // no sink is not no reason to speak: sidetone still plays locally
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
    // measure clipping and DC offset in the PCM before blaming the pacer
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
  // hand the frames to the running pacer, which must never starve (below)
  if (epoch !== ttsEpoch) {
    console.warn('[voice] synthesis finished after a disable — result dropped (stale, not current)');
    return false;
  }
  enqueue(out.pcm, out.sampleRate);
  return true;
}

// ── the pacer ───────────────────────────────────────────────────────────────
// A 10ms pacer writes exactly as many frames as wall time owes: speech when there is speech,
// silence when not, like a microphone (a starved generator has nothing to encode).
// Output is resampled to 48k once, with a real filter (toOutRate): piper emits 22050 Hz and a
// cheap converter aliases (docs/research/tts-mouth.md).
const OUT_RATE = 48000;
const FRAME = Math.round(OUT_RATE / 50);   // 20ms at the OUTPUT rate
let queue = [];            // pending {pcm, sampleRate}
let ttsEpoch = 0;          // bumped by stopPacer; a synthesis from an older epoch is dropped
let qOff = 0;              // read offset into queue[0]
let playhead = 0;          // samples emitted since the pacer started
let t0 = 0;
let pacer = null;

/** Sidetone: hearing your own synthesized voice, fed from our own PCM before pacing, through the
 *  page's one AudioContext (audioctx.js). */
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

// one shared sidetone gain per AudioContext, so a volume drag reaches audio already scheduled
let _monGain = null, _monGainCtx = null;
function monitorGain(ctx) {
  if (_monGainCtx !== ctx) {
    _monGain = ctx.createGain();
    _monGain.connect(ctx.destination);
    _monGainCtx = ctx;
  }
  return _monGain;
}
bus.on('audio:volume', ({ cat }) => {
  if (cat === 'tts' && _monGain) _monGain.gain.value = 0.8 * volumeFor('tts');
});

let monitorHead = 0;              // where the sidetone has played up to, in AudioContext time
const _monSources = new Set();    // scheduled sidetone chunks, so stopPacer can stop them


function monitor(pcm, sampleRate) {
  if (!monitorOn || !pcm?.length) return;
  try {
    const monitorCtx = audioContext();
    if (monitorCtx.state === 'suspended') void monitorCtx.resume();
    const buf = monitorCtx.createBuffer(1, pcm.length, sampleRate);
    const ch = buf.getChannelData(0);
    for (let i = 0; i < pcm.length; i++) ch[i] = pcm[i] / 32768;
    const src = monitorCtx.createBufferSource();
    const g = monitorGain(monitorCtx);
    g.gain.value = 0.8 * volumeFor('tts');   // the 'tts' slider scales the sidetone only, never the outbound track
    src.buffer = buf;
    src.connect(g);
    // schedule, don't fire: chunks synthesize faster than they play, so chunk N+1 starts when N ends
    const now = monitorCtx.currentTime;
    const at = Math.max(now, monitorHead);
    _monSources.add(src);
    src.onended = () => _monSources.delete(src);
    src.start(at);
    monitorHead = at + buf.duration;
  } catch (e) { console.warn('[voice] sidetone failed (still transmitting):', e?.message || e); }
}

/** Resample to OUT_RATE with an OfflineAudioContext (WebAudio's own good resampler), so WebRTC
 *  never uses a cheap one. localStorage.eidoTtsResample = 'off' hands WebRTC the native rate, to A/B by ear. */
async function toOutRate(pcm, inRate) {
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
  // the pcm probe's measurement, one stage later: clean in + dirty out would indict the resampler
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
  // not gated on a sender: the pacer's `if (!writer) return` makes a senderless queue harmless
  if (!canSynthesize()) return;
  // resample before queueing so the pacer only handles OUT_RATE floats; epoch-guarded, as the resample is async
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
    // a source swap closes the old generator's writable; rebuild it and re-bind the senders
    if (genTrack?.readyState !== 'live') { ensureGenerator(); return; }
    const owed = Math.floor(((performance.now() - t0) / 1000) * OUT_RATE) - playhead;
    for (let n = 0; n + FRAME <= owed; n += FRAME) {
      const data = new Float32Array(FRAME);
      fillSpeech(data);
      try {
        // a stream closed between the liveness check and write() rejects async; the next tick rebuilds
        void writer.write(new AudioData({
          format: 'f32', sampleRate: OUT_RATE, numberOfFrames: FRAME,
          numberOfChannels: 1, timestamp: Math.round((playhead / OUT_RATE) * 1e6), data,
        })).catch(() => {});
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
  // drop the sidetone playhead and stop what is already scheduled: a cancelled utterance falls silent in your own ears too
  monitorHead = 0;
  for (const s of _monSources) { try { s.stop(); } catch { /* already ended */ } }
  _monSources.clear();
}

/** Probe seam: is the mouth open, and how much is waiting to be said? */
export const mouthInfo = () => ({ pacing: !!pacer, queued: queue.length, playhead });

// ── speak your own says ─────────────────────────────────────────────────────
// A body with a synthesizer voices its own says through the ordinary sender, so distance, the
// category slider and consent apply as to a microphone.
export function speakOwnSays(bus, myId) {
  bus.on('speech', async ({ actor, text, performed }) => {
    const mine = actor === myId();
    if (!mine) return;                       // someone else's say: not ours to voice
    if (performed) return;                   // a display re-emit: the voice leg already made the sound
    if (!isTtsEnabled()) { console.warn(`[voice] own say NOT spoken — tts disabled`); return; }
    // mic beats TTS: a typed say while the mic is live is discarded, visibly (queuing would play stale text)
    const micLive = (typeof window !== 'undefined' && typeof window.__sfuMicOn === 'function')
      ? !!window.__sfuMicOn() : (await import('./micstate.js')).micOn?.();
    if (micLive) { console.warn(`[voice] own say NOT synthesized — mic is live, mic beats TTS: "${String(text).slice(0, 40)}"`); return; }
    console.log(`[voice] own say → speaking: "${String(text).slice(0, 60)}"`);
    void speak(text, actor);   // keyed by speaker so consecutive says queue
  });
}

/** The generator track's identity, for a probe to compare against the sender's track. */
export const genTrackInfo = () => (genTrack
  ? { id: genTrack.id, kind: genTrack.kind, readyState: genTrack.readyState, enabled: genTrack.enabled }
  : null);



// ── console benches: window.ttsTTFS / ttsBench / ttsSpread ──────────────────
/** Time to first sound: phonemize + infer + everything until audio exists. P50 and best, not a mean. */
async function ttsTTFS(text = 'hello there, this is a test', runs = 3) {
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

/** N synth runs of the same text: best / P50 / worst and RTF. */
async function ttsBench(text = 'hello', runs = 5) {
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


/** Synthesize the same text N times to see the spread: VITS samples noise on every call. */
async function ttsSpread(text = 'hello there', runs = 5) {
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

// ── the provider registration (voicesource.js) ──────────────────────────────
// stop() stills the pacer but leaves enablement standing: mic beats TTS is a priority, not a toggle.
setSynthProvider({
  label: () => ttsName || 'TTS',
  available: () => isTtsEnabled() && canSynthesize(),
  start: () => { const t = ensureGenerator(); startPacer(); return t; },
  stop: () => stopPacer(),
});
