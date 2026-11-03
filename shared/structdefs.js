// structdefs — the structure-palette contract (charter §3). An OVERLAY on
// the realizer's built-in style, never a gate: slots and finish shader
// nodes are engine; the def restyles their values. Absent slots keep the
// built-in default; unknown slots are preserved for future palette members.

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const isStr = (v) => typeof v === 'string' && v.length > 0;
const isObj = (v) => v != null && typeof v === 'object' && !Array.isArray(v);

/** Validate the palette sidecar (defs/structure/_palette.json).
 *  @param {unknown} palette @returns {string[]} */
export function validateStructurePalette(palette) {
  if (!isObj(palette)) return ['_palette must be a JSON object'];
  const errs = [];
  for (const [slot, s] of Object.entries(palette)) {
    if (slot === 'doc') continue;
    if (!isObj(s)) { errs.push(`${slot} must be an object`); continue; }
    if (s.color != null && !(isNum(s.color) && Number.isInteger(s.color) && s.color >= 0 && s.color <= 0xffffff)) {
      errs.push(`${slot}.color must be a 0..0xffffff integer`);
    }
    for (const k of ['roughness', 'opacity']) {
      if (s[k] != null && !(isNum(s[k]) && s[k] >= 0 && s[k] <= 2)) errs.push(`${slot}.${k} must be a number in [0, 2]`);
    }
    if (s.finish != null && !isStr(s.finish)) errs.push(`${slot}.finish must be a string`);
  }
  return errs;
}
