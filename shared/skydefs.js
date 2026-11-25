// skydefs — the sky-preset sidecars (defs/sky/_presets.json, _clocks.json). Presets are authoring conveniences: the
// build panel applies them to its sliders, and the commit writes concrete sky-verb args. The fold never sees a preset
// name (shared/forecast.js foldSkyEntry), so a mutable defs file can't rewrite logged meaning.

import { DEF_NAME_RE } from './floradefs.js';
import { isNum, isStr } from './protocol/is.js';


const NUMERIC = ['hours', 'rate', 'azimuth', 'sun', 'ambient', 'fill', 'exposure', 'fog'];
const STRINGY = ['clouds', 'weather'];

/** Validate the real-clock sidecar (defs/sky/_clocks.json): the named timezones the sky panel's clock row offers.
 *  Each tz is checked against the host's IANA data here, else a typo would throw inside hoursAt on every client.
 *  @param {unknown} clocks @returns {string[]} */
export function validateSkyClocks(clocks) {
  if (clocks == null || typeof clocks !== 'object' || Array.isArray(clocks)) {
    return ['_clocks must be a JSON object'];
  }
  const errs = [];
  for (const [name, c] of Object.entries(clocks)) {
    if (name === 'doc') continue;
    if (c == null || typeof c !== 'object' || Array.isArray(c)) { errs.push(`${name} must be an object`); continue; }
    if (!isStr(c.label)) errs.push(`${name}.label must be a string`);
    if (!isStr(c.tz)) { errs.push(`${name}.tz must be an IANA timezone string`); continue; }
    try { new Intl.DateTimeFormat('en-US', { timeZone: c.tz }); }
    catch { errs.push(`${name}.tz "${c.tz}" is not a timezone this host knows`); }
  }
  return errs;
}

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
