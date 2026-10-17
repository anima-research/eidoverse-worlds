// picture — what a `picture` component MEANS. Shared verbatim between the
// browser host (client/lib/pictures.js) and the mcpl agent (text-tier
// perception), so the two can never describe different pictures.
//
//   picture {src, width?, alt?, lit?}   (a quad of its own, facing +Z on the thing's origin; look → alt)
// Shape audit 10-16 (render-media-env §5): part and flip (texturing a node of the model) are cut: that is a material
// override, the reserved `material` component's. An older bag naming a part is drawn as a quad of its own (0 were stored).
//   comp {id, type: "picture", data: null}          # take it down
//
// A picture is an image on a NAMED PART of the entity that owns it — the #167
// shape: the comp names a GLB node, the host textures that node's material.
// It is rung 1 of the projector ladder (anima_dev/eidoverse_projector_design.md):
// the screen comp is a picture whose texture is a video, so every seam here
// (allow-listed source, named part, the look line, restore-on-remove) is the
// seam the screen will reuse.
//
// (Batch 2, R 10-07: an https link is a source too now; shared/mediasrc.js decides whose browser may fetch it,
// and an untrusted host is fetched only for a viewer who opted in. What follows is the rule for the store paths.)
// SOURCE ALLOW-LIST. `src` is a library-relative path under one of two roots,
// both served by the sequencer's own /library/ route: `eidoverse/assets/`
// (Skye's library plus the assets/opt overlay — what the operator placed) and
// `store/images/` (what someone uploaded through `POST /upload?as=image`:
// content-addressed, sniffed by bytes, token-gated and rate-limited like every
// store upload). Never a URL: a picture is an authored asset that entered
// through a door, not a fetch the world performs on someone's behalf. That is
// the whole content story for this rung, and it is what keeps a picture inside
// the world log's trust boundary instead of reaching out of it.
//
// THE LOOK LINE. Text-tier residents perceive by reading. A picture with no
// `look` reads as "a picture (<file>)", which is true and nearly useless; the
// author can say what it shows in ≤200 chars and that sentence is what look()
// carries. Nothing about pixels is ever claimed — the host renders, the line
// describes, and the two are the author's responsibility to keep honest.

import { mediaTier } from './mediasrc.js';
import { graphemes, graphemeList, quoted } from './text.js';

export const PICTURE_DIR = 'eidoverse/assets/';
export const PICTURE_STORE = 'store/images/';
export const PICTURE_DIRS = Object.freeze([PICTURE_DIR, PICTURE_STORE]);
const IMAGE_EXT = /\.(png|jpe?g|webp)$/i;
export const PICTURE_ALT_MAX = 200;
export const PICTURE_LOOK_MAX = PICTURE_ALT_MAX;   // the old name, for callers not yet renamed
export const PICTURE_MAX_WIDTH = 20;
export const PICTURE_DEFAULTS = Object.freeze({ lit: 'scene', width: 1 });
/** The alt field's tooltip, in plain words (R 10-07). */
export const ALT_HINT = 'Alternative text: describes this for people who can\'t see it, and for agents';
export const PICTURE_LIT = Object.freeze({ scene: 'lit by the scene', self: 'self-lit (a screen)' });
const KNOWN_KEYS = new Set(['src', 'width', 'alt', 'lit']);

/** Is `src` an allowed picture source? Library-relative, under one of PICTURE_DIRS,
 *  image extension, no scheme, no leading slash, no dot segments — and no
 *  percent-encoding at all. The rule is over the path the FETCH will
 *  canonicalize to, not the string as written: a URL parser reads `%2e%2e`
 *  as `..` (a dot segment by spec), and a server may decode `%41` to `A`
 *  after the check ran (Mica, #186 review). Library paths are plain; a `%`
 *  has no honest use in one, so its presence is a refusal, and the parsed
 *  pathname must come back byte-identical to the declared one. */
export function allowedPictureSrc(src) {
  if (typeof src !== 'string' || !src) return false;
  if (/^[a-z][a-z0-9+.-]*:/i.test(src) || src.startsWith('/') || src.includes('\\')) return false;
  if (/[%?#\s\u0000-\u001f\u007f]/.test(src)) return false;
  if (src.split('/').some((seg) => seg === '' || seg === '.' || seg === '..')) return false;
  if (!PICTURE_DIRS.some((d) => src.startsWith(d)) || !IMAGE_EXT.test(src)) return false;
  try {
    // What the browser will actually ask the library route for. Any
    // difference — a collapsed segment, a decoded byte — means the string
    // and the fetch disagree, and the fetch is the one that matters.
    if (new URL(`/library/${src}`, 'http://library.invalid').pathname !== `/library/${src}`) return false;
  } catch { return false; }
  return true;
}

/** Validate an authored bag. `ok:false` carries WHY (legible, once per authoring);
 *  `ok:true` carries the normalized picture plus notes for anything coerced.
 *  Batch 2 (10-07): `part` is optional (absent = a quad of its own, `width` m wide); `alt` is the describing line
 *  (renamed from `look`: HTML's word); src may be an https link (shared/mediasrc.js says who may fetch it). */
export function normalizePicture(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { ok: false, why: 'picture data must be an object {src, width?, alt?, lit?}' };
  }
  const tier = mediaTier(data.src, 'image');
  if (tier.tier === 'bad') return { ok: false, why: `src: ${tier.why} — ${tier.fix}` };
  const notes = [];
  const unknown = Object.keys(data).filter((k) => !KNOWN_KEYS.has(k) && !k.startsWith('_'));
  if (unknown.length) notes.push(`ignored by the evaluator: ${unknown.join(', ')} (accepted: ${[...KNOWN_KEYS].join(', ')})`);
  const picture = { src: data.src, width: PICTURE_DEFAULTS.width, lit: 'scene' };
  if (data.width !== undefined) { const w = Number(data.width); if (Number.isFinite(w) && w > 0) picture.width = Math.min(PICTURE_MAX_WIDTH, w); else notes.push('width is a number of metres above 0 — using 1'); }
  if (data.alt != null) {
    const alt = String(data.alt).replace(/\s+/g, ' ').trim();
    if (graphemes(alt) > PICTURE_ALT_MAX) { notes.push(`alt clipped to ${PICTURE_ALT_MAX} characters`); picture.alt = graphemeList(alt).slice(0, PICTURE_ALT_MAX).join(''); }
    else if (alt) picture.alt = alt;
  }
  if (!picture.alt) notes.push('no alt text — agents and people who can\'t see it get only the file name; say what it shows');
  if (data.lit != null) {
    if (Object.hasOwn(PICTURE_LIT, data.lit)) picture.lit = data.lit;
    else notes.push(`lit ${JSON.stringify(data.lit)} is unknown (${Object.keys(PICTURE_LIT).join('/')}) — using scene`);
  }
  return { ok: true, picture, tier, notes };
}

/** The one line look() carries for a picture — the same string on the authority, in mcpl and in every client, from the
 *  same bag. Says what the author said it shows (quoted, as data); never claims anything about the pixels. */
export function describePicture(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return 'a picture (malformed declaration)';
  const file = typeof data.src === 'string' ? (/^https:/i.test(data.src) ? (() => { try { return new URL(data.src).hostname; } catch { return 'a link'; } })() : data.src.split('/').pop()) : null;
  const alt = typeof data.alt === 'string' && data.alt.trim() ? data.alt : null;
  const where = '';   // a picture is a quad of its own (part was cut, shape audit 10-16)
  const ok = mediaTier(data.src, 'image').tier !== 'bad';
  const bits = [];
  if (!ok) bits.push('not shown: invalid declaration');
  if (data.lit === 'self') bits.push('self-lit');
  const tail = bits.length ? ` (${bits.join('; ')})` : '';
  return alt ? `a picture${where}: ${quoted(alt, PICTURE_ALT_MAX)}${tail}` : `a picture${where} (${file ?? 'no file'})${tail}`;
}
