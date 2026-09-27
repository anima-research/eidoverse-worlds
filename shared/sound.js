// sound — what a `sound` component MEANS. Shared verbatim between the browser
// host (client/lib/sounds.js) and the mcpl agent (text-tier perception), so
// the two can never describe different sounds.
//
//   comp {id, type: "sound", data: {src, playing?, loop?, volume?, radius?, t0?, look?}}
//   comp {id, type: "sound", data: null}          # silence it
//
// A sound is an audio file playing FROM an entity: positional, in the world,
// heard louder the closer you stand. The radio prop is the first carrier —
// the music player of the projector ladder (anima_dev/eidoverse_projector_
// design.md) with a file where the stream will be; the captions comp (#187)
// rides the same entity and says what the words are.
//
// SOURCE ALLOW-LIST — the picture's rule, for audio: a library-relative path
// under `eidoverse/assets/` (what the operator placed) or `store/audio/` (what
// came in through `POST /upload?as=audio`, sniffed by bytes), never a URL. A
// stream from the projector appliance is rung 3's business and arrives with
// the clock plumbing; a file is a placed asset inside the log's trust boundary.
//
// THE CLOCK. `t0` is epoch milliseconds when playback (re)started, so every
// listener — and every late joiner — hears the same place in the track: the
// playhead is (now - t0) mod duration when looping. Motion params are
// functions of time for the same reason. Whoever emits `playing: true` should
// stamp it; without it each client starts from the top and they drift.
//
// THE LOOK LINE. A text-tier resident cannot hear. `look` says what is
// playing (≤200 chars) and that sentence, with playing/paused, is what
// look() carries. Nothing about the waveform is ever claimed.

export const SOUND_DIR = 'eidoverse/assets/';
export const SOUND_STORE = 'store/audio/';
export const SOUND_DIRS = Object.freeze([SOUND_DIR, SOUND_STORE]);
const AUDIO_EXT = /\.(mp3|ogg|opus|wav|webm|m4a)$/i;
export const SOUND_LOOK_MAX = 200;
export const SOUND_DEFAULTS = Object.freeze({ playing: true, loop: true, volume: 0.8, radius: 12 });
const KNOWN_KEYS = new Set(['src', 'playing', 'loop', 'volume', 'radius', 't0', 'look']);

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

/** Validate an authored bag. `ok:false` carries WHY; `ok:true` carries the
 *  normalized sound plus notes for anything coerced. */
export function normalizeSound(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { ok: false, why: 'sound data must be an object {src, playing?, loop?, volume?, radius?, t0?, look?}' };
  }
  if (!allowedSoundSrc(data.src)) {
    return {
      ok: false,
      why: `src ${JSON.stringify(data.src ?? null)} is not an allowed sound source — a library-relative ` +
        `.mp3/.ogg/.opus/.wav/.webm/.m4a under ${SOUND_DIR} or ${SOUND_STORE} (no URLs: sounds are placed assets, not fetches)`,
    };
  }
  const notes = [];
  const unknown = Object.keys(data).filter((k) => !KNOWN_KEYS.has(k) && !k.startsWith('_'));
  if (unknown.length) notes.push(`ignored by the evaluator: ${unknown.join(', ')} (accepted: ${[...KNOWN_KEYS].join(', ')})`);
  const sound = {
    src: data.src,
    playing: data.playing !== false,
    loop: data.loop !== false,
    volume: num(data.volume, 0, 1, SOUND_DEFAULTS.volume),
    radius: num(data.radius, 1, 200, SOUND_DEFAULTS.radius),
  };
  if (data.t0 != null) {
    const t0 = Number(data.t0);
    if (Number.isFinite(t0) && t0 > 0) sound.t0 = t0;
    else notes.push('t0 is not an epoch-ms number — ignored; listeners will not agree on the playhead');
  } else if (sound.playing) notes.push('no t0 — every client starts from the top and late joiners drift; stamp Date.now() when you start it');
  if (data.look != null) {
    const look = String(data.look).replace(/\s+/g, ' ').trim();
    if (look.length > SOUND_LOOK_MAX) { notes.push(`look clipped to ${SOUND_LOOK_MAX} chars`); sound.look = look.slice(0, SOUND_LOOK_MAX); }
    else if (look) sound.look = look;
  }
  if (!sound.look) notes.push('no look line — text-tier residents will see only the file name; say what is playing');
  return { ok: true, sound, notes };
}

/** The one line look() carries for a sound — the same string on every
 *  client, from the same bag. Says what the author said is playing, and
 *  whether it is; never claims anything about the audio itself. */
export function describeSound(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return 'a sound (malformed declaration)';
  const file = typeof data.src === 'string' ? data.src.split('/').pop() : null;
  const look = typeof data.look === 'string' && data.look.trim() ? data.look.replace(/\s+/g, ' ').trim().slice(0, SOUND_LOOK_MAX) : null;
  const ok = allowedSoundSrc(data.src);
  const state = data.playing === false ? 'paused' : 'playing';
  const tail = ok ? '' : ' (not heard: invalid declaration)';
  return look ? `a sound, ${state}: ${look}${tail}` : `a sound, ${state} (${file ?? 'no file'})${tail}`;
}
