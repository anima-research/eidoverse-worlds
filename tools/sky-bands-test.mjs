// sky-bands-test — the baked sky's strips (client/lib/sky_bands.js): every band has width, bands are cut on texel rows,
// cover [0,1] in order, and cost about the same. `node tools/sky-bands-test.mjs`
import { bandCuts } from '../client/lib/sky_bands.js';
let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) pass++; else { fail++; console.log(`  FAIL ${n} ${d}`); } };
// the same row weight bandCuts uses (the march's chord estimate), to measure each band's cost
const weight = (v) => { const lat = (0.5 - v) * Math.PI; return 0.05 + (lat <= 0 ? 0.05 : Math.min(1 / Math.max(Math.sin(lat), 0.03), 30)); };
for (const [W, H, P, B] of [[4096, 2048, 8, 0.4e6], [2048, 1024, 8, 0.4e6], [1024, 512, 4, 0.4e6], [4096, 2048, 8, 1.5e6], [64, 8, 8, 1]]) {
  const tag = `${W}x${H}x${P}@${B}`;
  const cuts = bandCuts(W, H, P, B);
  ok(`${tag}: starts at 0, ends at 1`, cuts[0] === 0 && cuts.at(-1) === 1);
  ok(`${tag}: strictly increasing (no zero-width band)`, cuts.every((v, i) => i === 0 || v > cuts[i - 1]), JSON.stringify(cuts.slice(0, 12)));
  ok(`${tag}: every edge on a texel row`, cuts.every((v) => Math.abs(v * H - Math.round(v * H)) < 1e-6));
  ok(`${tag}: no more bands than rows`, cuts.length - 1 <= H);
  const costs = [];
  for (let i = 0; i < cuts.length - 1; i++) { let c = 0; for (let r = Math.round(cuts[i] * H); r < Math.round(cuts[i + 1] * H); r++) c += weight((r + 0.5) / H); costs.push(c); }
  const mean = costs.reduce((a, b) => a + b, 0) / costs.length;
  if (H >= 512) ok(`${tag}: the heaviest band ≤ 1.6× the mean (one horizon row is the floor)`, Math.max(...costs) / mean <= 1.6, (Math.max(...costs) / mean).toFixed(2));
  if (H >= 512) ok(`${tag}: at least 90% of the bands asked for`, cuts.length - 1 >= 0.9 * Math.min(H, Math.ceil(W * H * P / B)), `${cuts.length - 1}`);
}
console.log(`${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
