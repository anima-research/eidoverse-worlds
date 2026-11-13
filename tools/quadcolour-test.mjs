// The VR panel grade as pure numbers (client/lib/quadgrade.js): gradeSRGB is the JS twin of the shader grade in
// quadcolour.js, and tools/xr-quad-colour-probe.mjs holds the GPU to it at the default and both extremes. This file
// holds the twin to what the grade must mean. Also the persisted choice: garbage and out-of-range come back sane.
// Then the inverse ACES: acesFilmicInverseJS reads the SAME constant arrays the shader does, and is round-tripped
// through three's OWN forward (its constants read out of the three the client serves), so a typo'd constant, a
// swapped matrix or a three bump that changes the curve turns this red.
//   BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun tools/quadcolour-test.mjs
import { gradeSRGB, GRADE_DEFAULT, GRADE_RANGE, loadGrade, LUMA, acesFilmicInverseJS } from '../client/lib/quadgrade.js';
import { readFileSync } from 'node:fs';
let pass = 0, fail = 0;
const check = (name, ok, note = '') => { if (ok) { pass++; console.log(`  ok    ${name}`); } else { fail++; console.log(`  FAIL  ${name}${note ? `  -- ${note}` : ''}`); } };
const near = (a, b, e = 1e-9) => a.every((v, i) => Math.abs(v - b[i]) <= e);
const luma = (c) => c[0] * LUMA[0] + c[1] * LUMA[1] + c[2] * LUMA[2];
const brand = [0x8f / 255, 0xe8 / 255, 0xc8 / 255], panel = [5 / 255, 20 / 255, 20 / 255], grey = [0.3, 0.3, 0.3];
const spread = (c) => Math.max(...c) - Math.min(...c);

console.log('VR PANEL GRADE (pure)');
check('neutral (1, 1) is the identity', [brand, panel, grey, [0, 0, 0], [1, 1, 1]].every((c) => near(gradeSRGB(c, { saturation: 1, contrast: 1 }), c)));
check('saturation leaves a grey grey', near(gradeSRGB(grey, { saturation: 1.8, contrast: 1 }), grey));
check('saturation keeps luma (unclamped colour)', Math.abs(luma(gradeSRGB(brand, { saturation: 1.15, contrast: 1 })) - luma(brand)) < 1e-9);
check('saturation > 1 spreads the channels, < 1 closes them', spread(gradeSRGB(brand, { saturation: 1.5 })) > spread(brand) && spread(gradeSRGB(brand, { saturation: 0.5 })) < spread(brand));
check('saturation 0 is its luma grey', (() => { const g = gradeSRGB(brand, { saturation: 0 }); return near(g, [luma(brand), luma(brand), luma(brand)]); })());
check('contrast pivots on mid-grey', near(gradeSRGB([0.5, 0.5, 0.5], { contrast: 1.7 }), [0.5, 0.5, 0.5]));
check('contrast > 1 pushes dark down and light up', (() => { const d = gradeSRGB(panel, { contrast: 1.2 }), l = gradeSRGB([0.8, 0.8, 0.8], { contrast: 1.2 }); return d[1] < panel[1] && l[0] > 0.8; })());
check('the result stays in [0, 1] at the extremes', [brand, panel, [1, 0, 0], [0, 0, 1]].every((c) => gradeSRGB(c, { saturation: GRADE_RANGE.saturation[1], contrast: GRADE_RANGE.contrast[1] }).every((v) => v >= 0 && v <= 1)));
check('the default is a MODEST boost (both > 1, both ≤ 1.2)', GRADE_DEFAULT.saturation > 1 && GRADE_DEFAULT.saturation <= 1.2 && GRADE_DEFAULT.contrast > 1 && GRADE_DEFAULT.contrast <= 1.2, JSON.stringify(GRADE_DEFAULT));
check('the default sits inside its ranges', GRADE_DEFAULT.saturation >= GRADE_RANGE.saturation[0] && GRADE_DEFAULT.saturation <= GRADE_RANGE.saturation[1] && GRADE_DEFAULT.contrast >= GRADE_RANGE.contrast[0] && GRADE_DEFAULT.contrast <= GRADE_RANGE.contrast[1]);

// the persisted choice
const store = new Map();
globalThis.localStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
check('nothing stored → the default', near(Object.values(loadGrade()), [GRADE_DEFAULT.saturation, GRADE_DEFAULT.contrast]));
store.set('ew-xr-panel-grade', '{not json'); check('garbage → the default', near(Object.values(loadGrade()), [GRADE_DEFAULT.saturation, GRADE_DEFAULT.contrast]));
store.set('ew-xr-panel-grade', JSON.stringify({ saturation: 99, contrast: -3 })); check('out of range → clamped to the range', near(Object.values(loadGrade()), [GRADE_RANGE.saturation[1], GRADE_RANGE.contrast[0]]));
store.set('ew-xr-panel-grade', JSON.stringify({ saturation: 1.4, contrast: 'x' })); check('a good key kept, a bad one defaulted', near(Object.values(loadGrade()), [1.4, GRADE_DEFAULT.contrast]));


console.log('INVERSE ACES (the JS twin against three\'s forward)');
{
  const src = readFileSync(new URL('../client/node_modules/three/src/nodes/display/ToneMappingFunctions.js', import.meta.url), 'utf8');
  const nums = (s) => s.replace(/-\s+/g, '-').match(/-?\d*\.\d+/g).map(Number);
  const mat = (name) => nums(src.match(new RegExp(`const ${name} = mat3\\(([^)]*)\\)`))?.[1] ?? '');
  const IN = mat('ACESInputMat'), OUT = mat('ACESOutputMat');
  const fit = nums(src.match(/const RRTAndODTFit = [\s\S]*?return a\.div\( b \);/)?.[0] ?? '');   // [0.0245786, 0.000090537, 0.4329510, 0.983729, 0.238081]
  check('three\'s forward ACES read from source (two 3×3 matrices, five fit constants)', IN.length === 9 && OUT.length === 9 && fit.length === 5, JSON.stringify({ IN, OUT, fit }));
  const mul3 = (m, v) => [0, 1, 2].map((i) => m[i * 3] * v[0] + m[i * 3 + 1] * v[1] + m[i * 3 + 2] * v[2]);   // TSL mat3(9 scalars), as the shader reads it
  const rrt = (v) => (v * (v + fit[0]) - fit[1]) / (v * (v + fit[2]) * fit[3] + fit[4]);
  const forward = (c, e) => mul3(OUT, mul3(IN, c.map((x) => x * e / 0.6)).map(rrt)).map((x) => Math.min(1, Math.max(0, x)));
  const eotf = (s) => (s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4), oetf = (l) => (l <= 0.0031308 ? l * 12.92 : 1.055 * l ** (1 / 2.4) - 0.055);
  const worst = {};
  for (const e of [0.5, 0.78, 1, 1.3]) {   // the house exposure is 0.78; the others bracket it
    let w = 0, at = null;
    for (let r = 0; r <= 255; r += 5) for (let g = 0; g <= 255; g += 5) for (let b = 0; b <= 255; b += 5) {   // 52³, white included
      const back = forward(acesFilmicInverseJS([r, g, b].map((x) => eotf(x / 255)), e), e).map((x) => oetf(x) * 255);
      const err = Math.max(Math.abs(back[0] - r), Math.abs(back[1] - g), Math.abs(back[2] - b));
      if (err > w) { w = err; at = [r, g, b]; }
    }
    worst[e] = { err: +w.toFixed(4), at };
  }
  check('forward ∘ inverse is the identity on the sRGB grid at every exposure (worst < 0.5 of an 8-bit step)', Object.values(worst).every((x) => x.err < 0.5), JSON.stringify(worst));
  const white = forward(acesFilmicInverseJS([1, 1, 1], 0.78), 0.78);
  check('white comes back white (within 1e-4, the constants\' 8 places)', white.every((v) => v > 1 - 1e-4), JSON.stringify(white));
  check('a saturated hue needs a negative linear input (why the shader does not clamp at 0)', acesFilmicInverseJS([eotf(0x8f / 255), eotf(0xe8 / 255), eotf(0xc8 / 255)], 0.78)[0] < 0);
  const qc = readFileSync(new URL('../client/lib/quadcolour.js', import.meta.url), 'utf8');
  check('the shader reads the same arrays (quadcolour.js: mat3(...ACES_OUT_INV), mat3(...ACES_IN_INV), no literals of its own)',
    /mat3\(\.\.\.ACES_OUT_INV\)/.test(qc) && /mat3\(\.\.\.ACES_IN_INV\)/.test(qc) && !/1\.76474097|0\.64303825/.test(qc));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
