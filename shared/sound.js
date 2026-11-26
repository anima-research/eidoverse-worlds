// sound — what a `sound` component means, shared by the browser (client/lib/realize/sounds.js) and the mcpl agent so the two
// never describe different sounds.
//
//   set {id, component: "sound", value: {src, playing?, loop?, volume?, pitch?, near?, radius?, spatial?, t0?, description?}}
//   delete {id, component: "sound"}               # silence it
//
// A sound is an audio file playing FROM an entity, positional, louder the closer you stand (spatial: false: no panning, and
// one level inside its radius but for the edge taper). A captions component on the
// same entity carries the words.
//
// SOURCE: a library-relative path under `eidoverse/assets/` (operator-placed) or `store/audio/` (POST /upload?as=audio,
// sniffed by bytes), or an https link whose fetch rights shared/mediasrc.js decides.
//
// CLOCK: `t0` is the authority's epoch-ms when playback (re)started, so every listener and late joiner hears the same
// place: playhead = ((serverNow − t0) × pitch) mod duration when looping (serverNow: client/lib/serverclock.js, or the
// agent's own estimate in mcpl/agent.ts). The authority stamps it; without it each client starts from the top.
//
// DESCRIPTION: a text-tier resident cannot hear; `description` (≤200 chars) is what look() carries, with playing/paused.

import { mediaTier } from './mediasrc.js';
import { graphemes, graphemeList, quoted } from './text.js';

export const SOUND_DIR = 'eidoverse/assets/';
export const SOUND_STORE = 'store/audio/';
export const SOUND_DIRS = Object.freeze([SOUND_DIR, SOUND_STORE]);
const AUDIO_EXT = /\.(mp3|ogg|opus|wav|webm|m4a)$/i;
export const SOUND_DESCRIPTION_MAX = 200;
/** The description field's tooltip, in plain words. */
export const SOUND_DESCRIPTION_HINT = 'Describes what is playing in words, for people who can\'t hear it and for agents';
export const SOUND_MAX_RADIUS = 200;   // m; componentspec's sound ranges say the same
// a placed sound plays (no start-paused); distance is what keeps it from covering the world
export const SOUND_DEFAULTS = Object.freeze({ playing: true, loop: true, volume: 0.8, pitch: 1, near: 1.5, radius: 12, spatial: true });
const KNOWN_KEYS = new Set(['src', 'playing', 'loop', 'volume', 'pitch', 'near', 'radius', 'spatial', 't0', 'description']);

/** Is `src` an allowed sound source? Same rule as pictures (shared/picture.js): library-relative under one of
 *  SOUND_DIRS, an audio extension, no scheme, no leading slash, no dot segments, no percent-encoding, and the parsed
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

// FALLOFF (BasisVR's voice curve, BasisVoiceAcoustics.cs DistanceGain): inverse-distance held at 1 inside near, times (1 − t)² over the last 5% of the range, so exactly 0 at radius
// (Web Audio's `inverse` clamps at maxDistance and is heard across the world). client/lib/realize/sounds.js applies this gain
// itself; its panner keeps only the direction.
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

/** Validate an authored bag. `ok:false` carries WHY; `ok:true` the normalized sound, notes for anything coerced, and
 *  `tier` (shared/mediasrc.js: who may fetch an https src). `clip`: as normalizePicture's. */
export function normalizeSound(data, { clip = false } = {}) {
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
    // a write is measured as written, as the door measures it (checks.js ranges.maxLen: graphemes of the value), so the two
    // can't disagree over a run of spaces; what is kept is the collapsed text
    const raw = String(data.description), d = raw.replace(/\s+/g, ' ').trim();
    if (graphemes(raw) > SOUND_DESCRIPTION_MAX && !clip) return { ok: false, why: `description is ${graphemes(raw).toLocaleString('en')} characters (at most ${SOUND_DESCRIPTION_MAX})` };
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
