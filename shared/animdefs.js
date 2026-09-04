// animdefs — the animation-clip def contract (charter §3; sibling of
// avatardefs.js, same doctrine: an OVERLAY on the discovered roster, never
// a gate). Dropping a .vrma into the library/overlay/patch dirs stays a
// live clip with no def. A def in defs/animations/<name>.json:
//   - matching a discovered clip's name: overrides/adds metadata (tags,
//     doc — whatever the roster grows);
//   - carrying `vrma` (a /library path): declares a clip the scan wouldn't
//     find, or repoints a name. Declared beats discovered.
// Unknown keys are preserved. Same constraints as everything in shared/.

import { AVATAR_NAME_RE } from './avatardefs.js';

/** Clip names come from .vrma filenames — same permissive rule as avatars. */
export const ANIM_NAME_RE = AVATAR_NAME_RE;

const isStr = (v) => typeof v === 'string' && v.length > 0;

/** Validate the emote sidecar (defs/animations/_emotes.json): each entry
 *  {clip (required), icon?, listed?}. Key order is bar order — normative.
 *  @param {unknown} emotes @returns {string[]} */
export function validateEmotes(emotes) {
  if (emotes == null || typeof emotes !== 'object' || Array.isArray(emotes)) return ['_emotes must be a JSON object'];
  const errs = [];
  for (const [name, e] of Object.entries(emotes)) {
    if (name === 'doc') continue;
    if (!ANIM_NAME_RE.test(name)) { errs.push(`emote name "${name}" fails the name rule`); continue; }
    if (e == null || typeof e !== 'object' || Array.isArray(e)) { errs.push(`${name} must be an object`); continue; }
    if (!isStr(/** @type {any} */ (e).clip)) errs.push(`${name}.clip is required (string)`);
    if (/** @type {any} */ (e).icon != null && !isStr(/** @type {any} */ (e).icon)) errs.push(`${name}.icon must be a string`);
  }
  return errs;
}

/** Validate one animation def. Empty list = servable.
 *  @param {string} name @param {unknown} def @returns {string[]} */
export function validateAnimationDef(name, def) {
  const errs = [];
  if (!ANIM_NAME_RE.test(name)) errs.push(`name "${name}" — printable, no slashes, ≤64 chars`);
  if (def == null || typeof def !== 'object' || Array.isArray(def)) return [...errs, 'def must be a JSON object'];
  const d = /** @type {Record<string, unknown>} */ (def);
  if (d.vrma != null) {
    if (!isStr(d.vrma)) errs.push('vrma must be a /library-relative path string');
    else if (!d.vrma.endsWith('.vrma') || d.vrma.includes('..')) errs.push('vrma must be a .vrma path with no ".."');
  }
  if (d.tags != null && !(Array.isArray(d.tags) && d.tags.every(isStr))) errs.push('tags must be an array of strings');
  return errs;
}
