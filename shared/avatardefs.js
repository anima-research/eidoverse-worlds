// avatardefs — the avatar def contract, as one pure module (charter §3;
// sibling of floradefs.js, same constraints: pure, dependency-free).
//
// Avatars keep their prized discovery behavior — drop a .vrm into the
// library or the overlay and it IS an avatar, live, no manifest. A def in
// defs/avatars/<name>.json is therefore an OVERLAY on the discovered
// roster, never a gate:
//   - a def whose name matches a discovered avatar overrides its metadata
//     (height today; whatever else the roster grows tomorrow);
//   - a def carrying `vrm` (a /library path) declares an avatar the scan
//     would not find — a store upload, a subdirectory, a repointed name.
//     Declared beats discovered: a def's `vrm` wins over a same-named scan.
// Unknown keys are preserved (`doc` is the notes field), same rule as flora.

/** Avatar names come from .vrm filenames, which predate any naming rule —
 *  so the def rule is permissive where flora's is strict: printable, no
 *  path separators or control characters, ≤64 chars. */
export const AVATAR_NAME_RE = /^[^/\\\x00-\x1f]{1,64}$/;

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const isStr = (v) => typeof v === 'string' && v.length > 0;

/** Validate one avatar def. Empty list = servable.
 *  @param {string} name @param {unknown} def @returns {string[]} */
export function validateAvatarDef(name, def) {
  const errs = [];
  if (!AVATAR_NAME_RE.test(name)) errs.push(`name "${name}" — printable, no slashes, ≤64 chars`);
  if (def == null || typeof def !== 'object' || Array.isArray(def)) return [...errs, 'def must be a JSON object'];
  const d = /** @type {Record<string, unknown>} */ (def);
  if (d.vrm != null) {
    if (!isStr(d.vrm)) errs.push('vrm must be a /library-relative path string');
    else if (!d.vrm.endsWith('.vrm') || d.vrm.includes('..')) errs.push('vrm must be a .vrm path with no ".."');
  }
  if (d.height != null && !(isNum(d.height) && d.height > 0)) errs.push('height must be a positive number (metres)');
  if (d.tags != null && !(Array.isArray(d.tags) && d.tags.every(isStr))) errs.push('tags must be an array of strings');
  return errs;
}
