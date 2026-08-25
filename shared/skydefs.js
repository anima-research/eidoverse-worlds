// skydefs — the sky-preset contract (charter §3). Presets are AUTHORING
// conveniences: the build panel applies them to its sliders and previews;
// commit writes concrete sky-verb args. The fold never sees a preset name —
// foldSkyEntry computes state at fold time, so anything def-referenced
// there would let a mutable file rewrite logged meaning. This file is why
// that can't happen: presets live strictly on the authoring side.

import { DEF_NAME_RE } from './floradefs.js';

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const isStr = (v) => typeof v === 'string' && v.length > 0;

const NUMERIC = ['hours', 'rate', 'azimuth', 'sun', 'ambient', 'fill', 'exposure', 'fog'];
const STRINGY = ['clouds', 'weather'];

/** Validate the presets sidecar (defs/sky/_presets.json). Empty = servable.
 *  @param {unknown} presets @returns {string[]} */
export function validateSkyPresets(presets) {
  if (presets == null || typeof presets !== 'object' || Array.isArray(presets)) {
    return ['_presets must be a JSON object'];
  }
  const errs = [];
  for (const [name, p] of Object.entries(presets)) {
    if (name === 'doc') continue;
    if (!DEF_NAME_RE.test(name)) { errs.push(`preset name "${name}" fails the def-name rule`); continue; }
    if (p == null || typeof p !== 'object' || Array.isArray(p)) { errs.push(`${name} must be an object of sky args`); continue; }
    for (const k of NUMERIC) if (p[k] != null && !isNum(p[k])) errs.push(`${name}.${k} must be a number`);
    for (const k of STRINGY) if (p[k] != null && !isStr(p[k])) errs.push(`${name}.${k} must be a string`);
  }
  return errs;
}
