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
export const BODY_RUNTIME_KINDS = ['eidoverse-dof'];

/** A body that brings its own runtime: `runtime: { kind, module, joints? }`. `module` is a /library-relative .js
 *  path (an engine module, loaded by URL when the body is worn); `joints` an optional /library-relative .json beside
 *  the body (its exporter's joints file). No "..", no absolute paths, no URLs: the body's code comes from the same
 *  library its .vrm does.
 *  @param {unknown} rt @returns {string[]} */
export function validateBodyRuntime(rt) {
  if (rt == null || typeof rt !== 'object' || Array.isArray(rt)) return ['runtime must be an object { kind, module, joints? }'];
  const r = /** @type {Record<string, unknown>} */ (rt);
  const errs = [];
  const libPath = (v, ext) => isStr(v) && v.endsWith(ext) && !v.includes('..') && !v.startsWith('/') && !/^[a-z]+:/i.test(v);
  if (!BODY_RUNTIME_KINDS.includes(/** @type {string} */ (r.kind))) errs.push(`runtime.kind must be one of ${BODY_RUNTIME_KINDS.join(', ')}`);
  if (!libPath(r.module, '.js')) errs.push('runtime.module must be a /library-relative .js path with no ".."');
  if (r.joints != null && !libPath(r.joints, '.json')) errs.push('runtime.joints must be a /library-relative .json path with no ".."');
  // the module's steps this instance doesn't run (an engine module proved on its own clips, not yet on this one's)
  if (r.skip != null && !(Array.isArray(r.skip) && r.skip.every((s) => isStr(s) && /^[A-Za-z]\w{0,63}$/.test(s))))
    errs.push('runtime.skip must be an array of step names');
  return errs;
}
