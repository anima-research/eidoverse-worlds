// picture — what a `picture` component MEANS, shared by the browser host (client/lib/realize/pictures.js) and the mcpl agent.
//
//   picture {src, width?, description?, lit?}   (a quad of its own, facing +Z on the thing's origin)
//
// A standalone image: its own quad, `width` metres wide, height from the image's aspect. A texture on a NAMED node of a
// model is the `material` component's (shared/material.js).
//
// SOURCES: an https link (shared/mediasrc.js decides whose browser may fetch it), or a library-relative path under one
// of PICTURE_DIRS, served by the server's /library/ route (`store/images/` holds uploads via `POST /upload?as=image`).
//
// DESCRIPTION: the author's ≤200-char `description` is what look() carries for text-tier readers. Nothing about pixels is claimed.

import { mediaTier } from './mediasrc.js';
import { graphemes, graphemeList, quoted } from './text.js';

export const PICTURE_DIR = 'eidoverse/assets/';
export const PICTURE_STORE = 'store/images/';
export const PICTURE_DIRS = Object.freeze([PICTURE_DIR, PICTURE_STORE]);
const IMAGE_EXT = /\.(png|jpe?g|webp)$/i;
export const PICTURE_DESCRIPTION_MAX = 200;
export const PICTURE_MAX_WIDTH = 20;
export const PICTURE_DEFAULTS = Object.freeze({ lit: 'scene', width: 1 });
/** The description field's tooltip, in plain words. */
export const DESCRIPTION_HINT = 'Describes this in words, for people who can\'t see it and for agents';
export const PICTURE_LIT = Object.freeze({ scene: 'lit by the scene', self: 'self-lit (a screen)' });
const KNOWN_KEYS = new Set(['src', 'width', 'description', 'lit']);

/** Is `src` an allowed picture source? Library-relative, under one of PICTURE_DIRS, image extension, no scheme, no
 *  leading slash, no dot segments, no `%` (a URL parser reads `%2e%2e` as `..`), and the parsed pathname comes back
 *  byte-identical: the rule is over what the FETCH canonicalizes to. */
export function allowedPictureSrc(src) {
  if (typeof src !== 'string' || !src) return false;
  if (/^[a-z][a-z0-9+.-]*:/i.test(src) || src.startsWith('/') || src.includes('\\')) return false;
  if (/[%?#\s\u0000-\u001f\u007f]/.test(src)) return false;
  if (src.split('/').some((seg) => seg === '' || seg === '.' || seg === '..')) return false;
  if (!PICTURE_DIRS.some((d) => src.startsWith(d)) || !IMAGE_EXT.test(src)) return false;
  try {
    // what the browser will actually ask the library route for; any difference means the string and the fetch disagree
    if (new URL(`/library/${src}`, 'http://library.invalid').pathname !== `/library/${src}`) return false;
  } catch { return false; }
  return true;
}

/** Validate an authored bag: {ok: false, why} or {ok: true, picture, tier, notes} (notes for anything coerced).
 *  `clip`: a stored bag being read, so an over-long description is clipped with a note; a write refuses it. */
export function normalizePicture(data, { clip = false } = {}) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { ok: false, why: 'picture data must be an object {src, width?, description?, lit?}' };
  }
  const tier = mediaTier(data.src, 'image');
  if (tier.tier === 'bad') return { ok: false, why: `src: ${tier.why} — ${tier.fix}` };
  const notes = [];
  const unknown = Object.keys(data).filter((k) => !KNOWN_KEYS.has(k) && !k.startsWith('_'));
  if (unknown.length) notes.push(`ignored by the evaluator: ${unknown.join(', ')} (accepted: ${[...KNOWN_KEYS].join(', ')})`);
  const picture = { src: data.src, width: PICTURE_DEFAULTS.width, lit: 'scene' };
  if (data.width !== undefined) { const w = Number(data.width); if (Number.isFinite(w) && w > 0) picture.width = Math.min(PICTURE_MAX_WIDTH, w); else notes.push('width is a number of metres above 0 — using 1'); }
  if (data.description != null) {
    // measured as it is kept and sent, collapsed: every write path commits this value, so the door's ranges.maxLen then
    // measures the same string (#377 review 2)
    const d = String(data.description).replace(/\s+/g, ' ').trim();
    if (graphemes(d) > PICTURE_DESCRIPTION_MAX && !clip) return { ok: false, why: `description is ${graphemes(d).toLocaleString('en')} characters (at most ${PICTURE_DESCRIPTION_MAX})` };
    if (graphemes(d) > PICTURE_DESCRIPTION_MAX) { notes.push(`description clipped to ${PICTURE_DESCRIPTION_MAX} characters`); picture.description = graphemeList(d).slice(0, PICTURE_DESCRIPTION_MAX).join(''); }
    else if (d) picture.description = d;
  }
  if (!picture.description) notes.push('no description — anyone who can\'t see it (or reads the world as text) gets only the file name; say what it shows');
  if (data.lit != null) {
    if (Object.hasOwn(PICTURE_LIT, data.lit)) picture.lit = data.lit;
    else notes.push(`lit ${JSON.stringify(data.lit)} is unknown (${Object.keys(PICTURE_LIT).join('/')}) — using scene`);
  }
  return { ok: true, picture, tier, notes };
}

/** The one line look() carries for a picture: what the author said it shows (quoted, as data); never anything about pixels. */
export function describePicture(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return 'a picture (malformed declaration)';
  const file = typeof data.src === 'string' ? (/^https:/i.test(data.src) ? (() => { try { return new URL(data.src).hostname; } catch { return 'a link'; } })() : data.src.split('/').pop()) : null;
  const said = typeof data.description === 'string' && data.description.trim() ? data.description : null;
  const ok = mediaTier(data.src, 'image').tier !== 'bad';
  const bits = [];
  if (!ok) bits.push('not shown: invalid declaration');
  if (data.lit === 'self') bits.push('self-lit');
  const tail = bits.length ? ` (${bits.join('; ')})` : '';
  return said ? `a picture: ${quoted(said, PICTURE_DESCRIPTION_MAX)}${tail}` : `a picture (${file ?? 'no file'})${tail}`;
}
