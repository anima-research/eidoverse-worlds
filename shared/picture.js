// picture — what a `picture` component MEANS. Shared verbatim between the
// browser host (client/lib/pictures.js) and the mcpl agent (text-tier
// perception), so the two can never describe different pictures.
//
//   comp {id, type: "picture", data: {src, part, look?, lit?, flip?}}
//   comp {id, type: "picture", data: null}          # take it down
//
// A picture is an image on a NAMED PART of the entity that owns it — the #167
// shape: the comp names a GLB node, the host textures that node's material.
// It is rung 1 of the projector ladder (anima_dev/eidoverse_projector_design.md):
// the screen comp is a picture whose texture is a video, so every seam here
// (allow-listed source, named part, the look line, restore-on-remove) is the
// seam the screen will reuse.
//
// SOURCE ALLOW-LIST. `src` is a library-relative path under `eidoverse/assets/`
// — served by the sequencer's own /library/ route (Skye's library plus the
// assets/opt overlay). Never a URL: a picture is an authored asset the operator
// placed, not a fetch the world performs on someone's behalf. That is the whole
// content story for this rung, and it is what keeps a picture inside the world
// log's trust boundary instead of reaching out of it.
//
// THE LOOK LINE. Text-tier residents perceive by reading. A picture with no
// `look` reads as "a picture (<file>)", which is true and nearly useless; the
// author can say what it shows in ≤200 chars and that sentence is what look()
// carries. Nothing about pixels is ever claimed — the host renders, the line
// describes, and the two are the author's responsibility to keep honest.

export const PICTURE_DIR = 'eidoverse/assets/';
const IMAGE_EXT = /\.(png|jpe?g|webp)$/i;
export const PICTURE_LOOK_MAX = 200;
export const PICTURE_LIT = Object.freeze({ scene: 'lit by the scene', self: 'self-lit (a screen)' });
const KNOWN_KEYS = new Set(['src', 'part', 'look', 'lit', 'flip']);

/** Is `src` an allowed picture source? Library-relative, under PICTURE_DIR,
 *  image extension, no scheme, no leading slash, no dot segments. */
export function allowedPictureSrc(src) {
  if (typeof src !== 'string' || !src) return false;
  if (/^[a-z][a-z0-9+.-]*:/i.test(src) || src.startsWith('/') || src.includes('\\')) return false;
  if (src.split('/').some((seg) => seg === '' || seg === '.' || seg === '..')) return false;
  return src.startsWith(PICTURE_DIR) && IMAGE_EXT.test(src);
}

/** Validate an authored bag. `ok:false` carries WHY (legible, once per authoring);
 *  `ok:true` carries the normalized picture plus notes for anything coerced. */
export function normalizePicture(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { ok: false, why: 'picture data must be an object {src, part, look?}' };
  }
  if (!allowedPictureSrc(data.src)) {
    return {
      ok: false,
      why: `src ${JSON.stringify(data.src ?? null)} is not an allowed picture source — a library-relative ` +
        `.png/.jpg/.webp under ${PICTURE_DIR} (no URLs: pictures are placed assets, not fetches)`,
    };
  }
  if (typeof data.part !== 'string' || !data.part.trim() || data.part.length > 64) {
    return { ok: false, why: 'part must name the GLB node to texture (a non-empty string, ≤64 chars) — measure {id} lists them' };
  }
  const notes = [];
  const unknown = Object.keys(data).filter((k) => !KNOWN_KEYS.has(k) && !k.startsWith('_'));
  if (unknown.length) notes.push(`ignored by the evaluator: ${unknown.join(', ')} (accepted: ${[...KNOWN_KEYS].join(', ')})`);
  const picture = { src: data.src, part: data.part.trim(), lit: 'scene', flip: false };
  if (data.look != null) {
    const look = String(data.look).replace(/\s+/g, ' ').trim();
    if (look.length > PICTURE_LOOK_MAX) {
      notes.push(`look clipped to ${PICTURE_LOOK_MAX} chars`);
      picture.look = look.slice(0, PICTURE_LOOK_MAX);
    } else if (look) picture.look = look;
  }
  if (!picture.look) notes.push('no look line — text-tier residents will see only the file name; say what it shows');
  if (data.lit != null) {
    if (Object.hasOwn(PICTURE_LIT, data.lit)) picture.lit = data.lit;
    else notes.push(`lit ${JSON.stringify(data.lit)} is unknown (${Object.keys(PICTURE_LIT).join('/')}) — using scene`);
  }
  if (data.flip != null) picture.flip = data.flip === true;
  return { ok: true, picture, notes };
}

/** The one line look() carries for a picture — the same string on every
 *  client, from the same bag. Says what the author said it shows; never
 *  claims anything about the pixels. */
export function describePicture(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return 'a picture (malformed declaration)';
  const file = typeof data.src === 'string' ? data.src.split('/').pop() : null;
  const look = typeof data.look === 'string' && data.look.trim() ? data.look.replace(/\s+/g, ' ').trim().slice(0, PICTURE_LOOK_MAX) : null;
  const where = typeof data.part === 'string' && data.part ? ` on its ${data.part}` : '';
  const ok = allowedPictureSrc(data.src) && typeof data.part === 'string' && data.part;
  const bits = [];
  if (!ok) bits.push('not shown: invalid declaration');
  if (data.lit === 'self') bits.push('self-lit');
  const tail = bits.length ? ` (${bits.join('; ')})` : '';
  return look ? `a picture${where}: ${look}${tail}` : `a picture${where} (${file ?? 'no file'})${tail}`;
}
