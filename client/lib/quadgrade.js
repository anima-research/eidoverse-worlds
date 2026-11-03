// quadgrade — the VR panels' saturation/contrast grade as pure numbers (no three): the defaults, the ranges, the
// persisted choice, and gradeSRGB, the JS twin of the shader grade in quadcolour.js. VR panels only: never the design
// tokens, never the desktop (owner, 09-30: 'colours are generally less vibrant in VR' — a modest default boost).
export const LUMA = [0.2126, 0.7152, 0.0722];   // Rec. 709, the weights the shader uses
// VR panel grade: modest by default (owner asked for a modest default boost); the Settings › VR sliders drive these
export const GRADE_DEFAULT = Object.freeze({ saturation: 1.15, contrast: 1.08 });
export const GRADE_RANGE = Object.freeze({ saturation: [0.5, 2], contrast: [0.5, 1.8] });
const LS = 'ew-xr-panel-grade';
export const clampTo = (v, [lo, hi], d) => (Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);
export const storeGrade = (g) => { try { localStorage.setItem(LS, JSON.stringify(g)); } catch {} };
export function loadGrade() {
  let o = {}; try { o = JSON.parse(localStorage.getItem(LS) || '{}') ?? {}; } catch {}
  return { saturation: clampTo(Number(o.saturation), GRADE_RANGE.saturation, GRADE_DEFAULT.saturation),
    contrast: clampTo(Number(o.contrast), GRADE_RANGE.contrast, GRADE_DEFAULT.contrast) };
}
/** The grade in sRGB-encoded [0,1] (the JS twin of the shader): saturation about Rec.709 luma, contrast about mid-grey. */
export function gradeSRGB([r, g, b], { saturation = 1, contrast = 1 } = {}) {
  const y = r * LUMA[0] + g * LUMA[1] + b * LUMA[2];
  return [r, g, b].map((v) => Math.min(1, Math.max(0, (y + (v - y) * saturation - 0.5) * contrast + 0.5)));
}

// The inverse of three r186's acesFilmicToneMapping (ToneMappingFunctions.js), as data the shader in quadcolour.js
// reads and as gradeSRGB's sibling twin below — one copy, so tools/quadcolour-test.mjs round-trips the constants the GPU
// uses through three's own forward. The matrices are listed in the row order three lists its forward ones.
export const ACES_IN_INV = Object.freeze([1.76474097, -0.67577768, -0.08896329, -0.14702785, 1.16025151, -0.01322366, -0.03633683, -0.16243644, 1.19877327]);
export const ACES_OUT_INV = Object.freeze([0.64303825, 0.31118675, 0.04577546, 0.05926869, 0.93143649, 0.00929492, 0.0059619, 0.06392902, 0.93011838]);
export const ACES_FIT = Object.freeze({ A: 0.0245786, B: 0.000090537, C: 0.983729, D: 0.4329510 * 0.983729, E: 0.238081 });   // RRTAndODTFit's

const mul3 = (m, v) => [0, 1, 2].map((i) => m[i * 3] * v[0] + m[i * 3 + 1] * v[1] + m[i * 3 + 2] * v[2]);   // as TSL's mat3(9 scalars) reads them
/** One channel of RRTAndODTFit⁻¹: y = (v² + Av − B)/(Cv² + Dv + E) solved for v ≥ 0 (the shader's rrtInv). */
export function acesFitInverse(y) {
  const { A, B, C, D, E } = ACES_FIT, yc = Math.min(1, Math.max(0, y));
  const a = 1 - yc * C, b = A - yc * D, c = B + yc * E;
  return (-b + Math.sqrt(Math.max(b * b + 4 * a * c, 0))) / (2 * a);
}
/** The JS twin of quadcolour.js acesFilmicInverse: the linear working colour whose ACES Filmic at `exposure` is `lin`. */
export function acesFilmicInverseJS(lin, exposure = 1) {
  const y = mul3(ACES_OUT_INV, lin.map((v) => Math.min(1, Math.max(0, v))));
  return mul3(ACES_IN_INV, y.map(acesFitInverse)).map((v) => v * 0.6 / exposure);
}
