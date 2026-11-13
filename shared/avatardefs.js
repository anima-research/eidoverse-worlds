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
  if (d.runtime != null) errs.push(...validateBodyRuntime(d.runtime));
  // a body's glow is not always a lamp: indicator lights and a screen glow, they don't light a room. `lamps: false`
  // keeps attachLamps off the body; `emissiveMax` caps its materials' emissive strength (a file authored for a film's
  // bloom threshold glares under another renderer's)
  if (d.lamps != null && typeof d.lamps !== 'boolean') errs.push('lamps must be true or false');
  if (d.emissiveMax != null && !(isNum(d.emissiveMax) && d.emissiveMax >= 0)) errs.push('emissiveMax must be a number >= 0');
  return errs;
}

/** The kinds of body runtime the client knows how to drive (client/lib/bodyruntime_core.js). */
export const BODY_RUNTIME_KINDS = ['claude-robot-dof'];

/** A body may select one reviewed runtime BUILT INTO this Worlds client.
 * Defs carry no module URL: avatar assets are data, never an executable-code
 * grant to every viewer. Adding a kind requires a Worlds source review.
 * @param {unknown} rt @returns {string[]} */
export function validateBodyRuntime(rt) {
  if (rt == null || typeof rt !== 'object' || Array.isArray(rt)) return ['runtime must be an object { kind, skip? }'];
  const r = /** @type {Record<string, unknown>} */ (rt);
  const errs = [];
  if (!BODY_RUNTIME_KINDS.includes(/** @type {string} */ (r.kind))) errs.push(`runtime.kind must be one of ${BODY_RUNTIME_KINDS.join(', ')}`);
  for (const k of Object.keys(r)) if (!['kind', 'skip'].includes(k)) errs.push(`runtime.${k} is not allowed; executable code and joints are built into the named kind`);
  if (r.skip != null && !(Array.isArray(r.skip) && r.skip.every((v) => isStr(v) && /^[A-Za-z]\w{0,63}$/.test(v))))
    errs.push('runtime.skip must be an array of step names');
  return errs;
}
