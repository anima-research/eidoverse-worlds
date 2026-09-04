// grounddefs — the ground-palette contract (charter §3, defs round two).
//
// Same law as the sky presets: everything here is an AUTHORING convenience.
// The ground panel applies a choice as a concrete terrain/grass verb on a
// deliberate click, so the log never stores one of these names — a mutable
// def file can restyle the panel, never rewrite logged meaning.

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const isStr = (v) => typeof v === 'string' && v.length > 0;
const isObj = (v) => v != null && typeof v === 'object' && !Array.isArray(v);
// panel labels, not def files — spaces allowed ("mojave desert"), still bounded
const LABEL_RE = /^[a-z][a-z0-9 _-]{0,32}$/;

/** Validate the ground palette sidecar (defs/ground/_palette.json).
 *  Empty result = servable. @param {unknown} t @returns {string[]} */
export function validateGroundPalette(t) {
  if (!isObj(t)) return ['_palette must be a JSON object'];
  const errs = [];
  const table = (key, per) => {
    const v = t[key];
    if (v == null) { errs.push(`missing "${key}"`); return; }
    if (!isObj(v)) { errs.push(`"${key}" must be an object`); return; }
    for (const [name, row] of Object.entries(v)) {
      if (!LABEL_RE.test(name)) { errs.push(`${key} name "${name}" — lowercase letter first, then letters/digits/space/_/-, ≤33 chars`); continue; }
      per(name, row);
    }
  };
  table('tints', (name, row) => {
    if (!isObj(row)) { errs.push(`tints.${name} must be an object`); return; }
    if (!isStr(row.layer) || !/^#[0-9a-f]{6}$/i.test(row.layer)) errs.push(`tints.${name}.layer must be a #rrggbb colour`);
    for (const k of ['grass', 'tufts']) {
      if (row[k] !== null && row[k] !== undefined && !isStr(row[k])) errs.push(`tints.${name}.${k} must be a recolor name or null`);
    }
  });
  table('shapes', (name, v) => { if (!isNum(v) || v < 0) errs.push(`shapes.${name} must be a number ≥ 0`); });
  table('grassHeight', (name, v) => { if (!isNum(v) || v <= 0) errs.push(`grassHeight.${name} must be a number > 0`); });
  table('grassDensity', (name, v) => { if (!isNum(v) || v <= 0) errs.push(`grassDensity.${name} must be a number > 0`); });
  table('plantings', (name, p) => {
    if (!isObj(p)) { errs.push(`plantings.${name} must be an object`); return; }
    if (!isObj(p.args)) { errs.push(`plantings.${name}.args must be an object (a grass-verb bag)`); return; }
    if (!isStr(p.args.species) && !isStr(p.args.preset)) errs.push(`plantings.${name}.args needs a species or a preset`);
    if (p.blade != null && typeof p.blade !== 'boolean') errs.push(`plantings.${name}.blade must be a boolean`);
    if (p.blade && !isStr(p.tint)) errs.push(`plantings.${name} is blade grass and needs a tint column name`);
    if (p.tint != null && !['grass', 'tufts'].includes(p.tint)) errs.push(`plantings.${name}.tint must be "grass" or "tufts"`);
  });
  return errs;
}
