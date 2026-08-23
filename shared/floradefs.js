// floradefs — the flora def contract, as one pure module (charter §3:
// content is declarative data; code is reserved for new KINDS of things).
//
// A flora species def is a JSON object in defs/flora/<name>.json. The server
// validates each def against this module at load and refuses to serve one
// that fails — so a typo becomes a boot log line, not a broken world. Same
// constraints as everything in shared/ (README.md): pure, dependency-free,
// no Date.now().
//
// The checks are TYPE-level, not taste-level: a def that would crash or
// silently misbuild in the engine is an error; a strange tuning value is the
// author's business. Unknown keys are PRESERVED, never dropped — the same
// forward-compatibility rule the log protocol lives by (`doc` is the
// conventional human-notes field).

/** The engine's geometry builders. A def naming an archetype outside this
 *  set cannot be built by any current client — refused at load, like an
 *  unknown verb is refused at the door (new archetypes are engine code, so
 *  the set grows here in the same commit that grows the engine).
 *  @type {string[]} */
export const FLORA_ARCHETYPES = ['blades', 'shrub', 'yucca', 'corn', 'sunflower'];

/** Def names double as wire values in `grass` verb args and as filenames. */
export const DEF_NAME_RE = /^[a-z][a-z0-9_-]{0,32}$/;

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const isStr = (v) => typeof v === 'string' && v.length > 0;
const isVec = (v, n) => Array.isArray(v) && v.length === n && v.every(isNum);
const isObj = (v) => v != null && typeof v === 'object' && !Array.isArray(v);

/** Validate one flora def. Returns a list of human-readable problems —
 *  empty means servable.
 *  @param {string} name @param {unknown} def @returns {string[]} */
export function validateFloraDef(name, def) {
  const errs = [];
  if (!DEF_NAME_RE.test(name)) errs.push(`name "${name}" — lowercase letter first, then letters/digits/_/-, ≤33 chars`);
  if (!isObj(def)) return [...errs, 'def must be a JSON object'];
  const d = /** @type {Record<string, unknown>} */ (def);

  if (!isStr(d.archetype)) errs.push('archetype is required (string)');
  else if (!FLORA_ARCHETYPES.includes(d.archetype)) {
    errs.push(`archetype "${d.archetype}" unknown — engine builds: ${FLORA_ARCHETYPES.join(', ')}`);
  }
  // per-field type gates, checked only when present
  const num = ['density', 'clump', 'sss', 'rough', 'pushScale', 'footRadius', 'stemColor'];
  for (const k of num) if (d[k] != null && !isNum(d[k])) errs.push(`${k} must be a number`);
  const str = ['maps', 'stem', 'gen'];
  for (const k of str) if (d[k] != null && !isStr(d[k])) errs.push(`${k} must be a string`);
  const obj = ['blades', 'rosette', 'corn', 'sunflower', 'colors', 'wind', 'regionTint'];
  for (const k of obj) if (d[k] != null && !isObj(d[k])) errs.push(`${k} must be an object`);
  if (d.baseScale != null && !isVec(d.baseScale, 2)) errs.push('baseScale must be [lo, hi]');
  if (d.stemTint != null && !isVec(d.stemTint, 3)) errs.push('stemTint must be [r, g, b]');
  if (d.leafRecolor != null && !isStr(d.leafRecolor) && !isVec(d.leafRecolor, 3)) {
    errs.push('leafRecolor must be a GRASS_COLORS name or [r, g, b]');
  }
  if (isObj(d.wind)) {
    for (const k of ['base', 'gust', 'gustFreq', 'flutter']) {
      if (d.wind[k] != null && !isNum(d.wind[k])) errs.push(`wind.${k} must be a number`);
    }
  }
  return errs;
}

/** Validate the palette sidecar (defs/flora/_colors.json): each entry is a
 *  [r,g,b] multiplier or a {recolor: [r,g,b]} hue-changer. `doc` rides free
 *  like everywhere else. Returns problems; empty = servable.
 *  @param {unknown} colors @returns {string[]} */
export function validateFloraColors(colors) {
  if (!isObj(colors)) return ['_colors must be a JSON object'];
  const errs = [];
  for (const [name, v] of Object.entries(colors)) {
    if (name === 'doc') continue;
    const ok = isVec(v, 3) || (isObj(v) && isVec(/** @type {any} */ (v).recolor, 3));
    if (!ok) errs.push(`${name} must be [r,g,b] or {recolor: [r,g,b]}`);
  }
  return errs;
}
