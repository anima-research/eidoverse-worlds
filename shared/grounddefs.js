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

// ------------------------------------------------------------ the verb args a choice writes
// One recipe for "this palette choice → these terrain/grass args", read by the
// world panel's 🌿 section (client/lib/groundpanel.js) and the Build tab's World
// section (client/lib/editpanels.js) alike, so the two can never write
// different args for the same pick.

/** The choice the panel starts from when nothing is dialled yet (the names
 *  groundpanel always preferred, else each table's first entry). */
export function paletteDefaults(pal) {
  const first = (o) => Object.keys(o ?? {})[0] ?? null;
  const pref = (o, k) => (o?.[k] != null ? k : first(o));
  return { tint: pref(pal?.tints, 'meadow'), shape: pref(pal?.shapes, 'hills'), height: pref(pal?.grassHeight, 'meadow'),
    density: pref(pal?.grassDensity, 'normal'), plant: pref(pal?.plantings, 'meadow'), seed: 7 };
}

/** terrain-verb args for a choice {shape?, tint?, seed?}. With `base` (the
 *  world's current terrain bag) only the chosen dials change and every other
 *  authored field (size, segments, a custom layer's repeat) is kept; without
 *  it, the panel's own ground: 160 m, 200 segments, flat within 16 m. */
export function terrainArgs(pal, choice = {}, base = null) {
  const out = base ? JSON.parse(JSON.stringify(base)) : { seed: choice.seed ?? 7, size: 160, segments: 200, flatRadius: 16, layers: [{ repeat: 16 }] };
  if (choice.seed != null) out.seed = choice.seed;
  if (choice.shape != null && pal?.shapes?.[choice.shape] != null) out.amplitude = pal.shapes[choice.shape];
  const color = choice.tint != null ? pal?.tints?.[choice.tint]?.layer : null;
  if (color) out.layers = Array.isArray(out.layers) && out.layers.length ? out.layers.map((l, i) => (i ? l : { ...l, color })) : [{ color, repeat: 16 }];
  return out;
}

/** grass-verb args for a choice {plant, height?, density?, tint?}: one bag on
 *  the singleton grass verb, straight from the def; blade plantings take the
 *  height dial and the tint row's colour column. null when the planting is unknown. */
export function grassArgs(pal, { plant, height, density, tint } = {}) {
  const p = pal?.plantings?.[plant];
  if (!p) return null;
  const args = JSON.parse(JSON.stringify(p.args));
  if (p.blade) {
    if (pal.grassHeight?.[height] != null) args.height = pal.grassHeight[height];
    const color = pal.tints?.[tint]?.[p.tint];
    if (color) args.color = color;
  }
  if (pal.grassDensity?.[density] != null) args.density = pal.grassDensity[density];
  return args;
}

/** Read a world's terrain/grass back as palette names: which shape, tint,
 *  planting, height and density they were grown from (null where the bag holds
 *  something the palette doesn't name — an agent's own terrain, say). */
export function groundChoice(pal, terrain, grass) {
  const by = (o, pred) => Object.keys(o ?? {}).find((k) => pred(o[k])) ?? null;
  const layer = Array.isArray(terrain?.layers) ? terrain.layers[0]?.color : null;
  return {
    shape: terrain ? by(pal?.shapes, (v) => v === terrain.amplitude) : null,
    tint: layer ? by(pal?.tints, (t) => t?.layer === layer) : null,
    seed: terrain?.seed ?? null,
    plant: grass ? by(pal?.plantings, (p) => (p?.args?.preset != null ? p.args.preset === grass.preset : p?.args?.species === grass.species && grass.preset == null)) : null,
    height: grass?.height != null ? by(pal?.grassHeight, (v) => v === grass.height) : null,
    density: grass?.density != null ? by(pal?.grassDensity, (v) => v === grass.density) : null,
  };
}
