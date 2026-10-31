// sound — what a `sound` component MEANS. Shared verbatim between the browser
// host (client/lib/sounds.js) and the mcpl agent (text-tier perception), so
// the two can never describe different sounds.
//
//   comp {id, type: "sound", data: {src, playing?, loop?, volume?, pitch?, near?, radius?, spatial?, t0?, description?}}
//   comp {id, type: "sound", data: null}          # silence it
//
// A sound is an audio file playing FROM an entity: positional, in the world,
// heard louder the closer you stand. The radio prop is the first carrier —
// the music player of the projector ladder (anima_dev/eidoverse_projector_
// design.md) with a file where the stream will be; the captions comp (#187)
// rides the same entity and says what the words are.
//
// (Batch 2, R 10-07: an https link is a source too now; shared/mediasrc.js decides whose browser may fetch it,
// and an untrusted host is fetched only for a viewer who opted in. What follows is the rule for the store paths.)
// SOURCE ALLOW-LIST — the picture's rule, for audio: a library-relative path
// under `eidoverse/assets/` (what the operator placed) or `store/audio/` (what
// came in through `POST /upload?as=audio`, sniffed by bytes), never a URL. A
// stream from the projector appliance is rung 3's business and arrives with
// the clock plumbing; a file is a placed asset inside the log's trust boundary.
//
// THE CLOCK. `t0` is the authority's clock, in epoch milliseconds, when
// playback (re)started, so every listener — and every late joiner — hears the
// same place in the track: the playhead is (serverNow - t0) mod duration when
// looping, serverNow() being each reader's estimate of the authority's clock
// (client/lib/serverclock.js in a browser, mcpl/agent.ts serverNow() in an
// agent). The authority stamps it when a sound starts playing; without it each
// client starts from the top and they drift.
//
// THE DESCRIPTION. A text-tier resident cannot hear. `description` says what is
// playing (≤200 chars) and that sentence, with playing/paused, is what
// look() carries. Nothing about the waveform is ever claimed.

import { mediaTier } from './mediasrc.js';
import { graphemes, graphemeList, quoted } from './text.js';

export const SOUND_DIR = 'eidoverse/assets/';
export const SOUND_STORE = 'store/audio/';
export const SOUND_DIRS = Object.freeze([SOUND_DIR, SOUND_STORE]);
const AUDIO_EXT = /\.(mp3|ogg|opus|wav|webm|m4a)$/i;
export const SOUND_DESCRIPTION_MAX = 200;
/** The description field's tooltip, in plain words. */
export const SOUND_DESCRIPTION_HINT = 'Describes what is playing in words, for people who can\'t hear it and for agents';
export const SOUND_MAX_RADIUS = 200;   // m (R 10-28: 100 → 200); componentspec's sound ranges say the same
// R 10-07: a placed sound plays (no start-paused); distance is what keeps it from covering the world
export const SOUND_DEFAULTS = Object.freeze({ playing: true, loop: true, volume: 0.8, pitch: 1, near: 1.5, radius: 12, spatial: true });
const KNOWN_KEYS = new Set(['src', 'playing', 'loop', 'volume', 'pitch', 'near', 'radius', 'spatial', 't0', 'description']);

/** Is `src` an allowed sound source? Same rule as pictures (shared/picture.js):
 *  library-relative under one of SOUND_DIRS, an audio extension, no scheme,
 *  no leading slash, no dot segments, no percent-encoding, and the parsed
 *  pathname byte-identical to the declared one. */
export function allowedSoundSrc(src) {
  if (typeof src !== 'string' || !src) return false;
  if (/^[a-z][a-z0-9+.-]*:/i.test(src) || src.startsWith('/') || src.includes('\\')) return false;
  if (/[%?#\s\u0000-\u001f\u007f]/.test(src)) return false;
  if (src.split('/').some((seg) => seg === '' || seg === '.' || seg === '..')) return false;
  if (!SOUND_DIRS.some((d) => src.startsWith(d)) || !AUDIO_EXT.test(src)) return false;
  try {
    if (new URL(`/library/${src}`, 'http://library.invalid').pathname !== `/library/${src}`) return false;
  } catch { return false; }
  return true;
}

const num = (v, lo, hi, dflt) => {
  const n = Number(v);
  return v == null || !Number.isFinite(n) ? dflt : Math.min(hi, Math.max(lo, n));
};

// THE FALLOFF (batch 2, R 10-07: "silent at radius"). BasisVR's voice curve (BasisVoiceAcoustics.cs, developer @ eac8e38):
// an inverse-distance law held at 1 inside near, times (1 − t)² over the last 5% of the range, so it reaches exactly 0 AT
// radius. Web Audio's own `inverse` model CLAMPS at maxDistance instead: a 12 m radio was still heard at about 9% (−21 dB)
// everywhere past 12 m, across the whole world. The panner keeps only the direction (rolloff 0); this gain is applied in
// the tick (client/lib/sounds.js), so what you hear is silent where the editor's sphere says.
export const TAPER_START = 0.95;
/** The distance gain at d metres from a sound: 1 inside near, inverse beyond, 0 at radius and past it. */
export function gainAt(d, near = SOUND_DEFAULTS.near, radius = SOUND_DEFAULTS.radius) {
  if (!(d >= 0)) return 0;
  if (d >= radius) return 0;
  const inv = near / Math.max(d, near);
  const t0 = TAPER_START * radius;
  if (d <= t0) return inv;
  const t = (d - t0) / (radius - t0);
  return inv * (1 - t) * (1 - t);
}

/** Validate an authored bag. `ok:false` carries WHY; `ok:true` carries the
 *  normalized sound plus notes for anything coerced. src may be an https link: `tier` says who may fetch it
 *  (shared/mediasrc.js). */
export function normalizeSound(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { ok: false, why: 'sound data must be an object {src, playing?, loop?, volume?, pitch?, near?, radius?, spatial?, t0?, description?}' };
  }
  const tier = mediaTier(data.src, 'audio');
  if (tier.tier === 'bad') return { ok: false, why: `src: ${tier.why} — ${tier.fix}` };
  const notes = [];
  const unknown = Object.keys(data).filter((k) => !KNOWN_KEYS.has(k) && !k.startsWith('_'));
  if (unknown.length) notes.push(`ignored by the evaluator: ${unknown.join(', ')} (accepted: ${[...KNOWN_KEYS].join(', ')})`);
  const radius = num(data.radius, 1, SOUND_MAX_RADIUS, SOUND_DEFAULTS.radius);
  const sound = {
    src: data.src,
    playing: data.playing !== false,
    loop: data.loop !== false,
    volume: num(data.volume, 0, 1, SOUND_DEFAULTS.volume),
    pitch: num(data.pitch, 0.5, 2, SOUND_DEFAULTS.pitch),
    near: Math.min(radius, num(data.near, 0.01, SOUND_MAX_RADIUS, SOUND_DEFAULTS.near)),
    radius,
    spatial: data.spatial !== false,
  };
  if (data.t0 != null) {
    const t0 = Number(data.t0);
    if (Number.isFinite(t0) && t0 > 0) sound.t0 = t0;
    else notes.push('t0 is not an epoch-ms number — ignored; listeners will not agree on the playhead');
  } else if (sound.playing) notes.push('no t0 — the authority stamps one when it starts; without it each client starts from the top');
  if (data.description != null) {
    const d = String(data.description).replace(/\s+/g, ' ').trim();
    if (graphemes(d) > SOUND_DESCRIPTION_MAX) { notes.push(`description clipped to ${SOUND_DESCRIPTION_MAX} characters`); sound.description = graphemeList(d).slice(0, SOUND_DESCRIPTION_MAX).join(''); }
    else if (d) sound.description = d;
  }
  if (!sound.description) notes.push('no description — anyone who can\'t hear it (or reads the world as text) gets only the file name; say what is playing');
  return { ok: true, sound, tier, notes };
}

/** The one line look() carries for a sound — the same string on the authority, in mcpl and in every client, from the same
 *  bag. Says what the author said is playing (quoted, as data), whether it is, and how far it carries; never claims
 *  anything about the audio. `now` (ms) lets a one-shot say how long ago it was started. */
export function describeSound(data, now = null) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return 'a sound (malformed declaration)';
  const file = typeof data.src === 'string' ? (/^https:/i.test(data.src) ? (() => { try { return new URL(data.src).hostname; } catch { return 'a link'; } })() : data.src.split('/').pop()) : null;
  const said = typeof data.description === 'string' && data.description.trim() ? data.description : null;
  const ok = mediaTier(data.src, 'audio').tier !== 'bad';
  const radius = num(data.radius, 1, SOUND_MAX_RADIUS, SOUND_DEFAULTS.radius);
  let state;
  if (data.playing === false) state = 'paused';
  else if (data.loop === false) state = Number.isFinite(data.t0) && Number.isFinite(now) ? `last played ${Math.max(0, Math.round((now - data.t0) / 1000))} s ago (one-shot)` : 'a one-shot';
  else state = `playing (loops; heard within ${+radius.toFixed(1)} m)`;
  const tail = ok ? '' : ' (not heard: invalid declaration)';
  return said ? `a sound, ${state}: ${quoted(said, SOUND_DESCRIPTION_MAX)}${tail}` : `a sound, ${state} (${file ?? 'no file'})${tail}`;
}
