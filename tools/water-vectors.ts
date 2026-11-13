// Generates shared/conformance/water.json: reference outputs of shared/water.js
// (waterParams, waveHeight, swimStep) for native ports (Unreal) to reproduce.
//   bun tools/water-vectors.ts          write the file
//   bun tools/water-vectors.ts --check  fail if the file is stale
import { waterParams, waveHeight, swimStep } from "../shared/water.js";
import { readFileSync, writeFileSync } from "node:fs";

const round = (v: any): any => typeof v === "number" ? Number(v.toPrecision(12))
  : Array.isArray(v) ? v.map(round) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, round(x)])) : v;
const withTop = (w: any) => ({ ...w, top: w.center[1] + w.size[1] / 2, bottom: w.center[1] - w.size[1] / 2 });

const world = { center: [0, -125, 0], size: [2000, 250, 2000], absorption: [.1, .036, .018], scatter: [.014, .11, .17], speed: 2.4,
  waves: [{ amplitude: .38, wavelength: 24, direction: [.3420201, .9396926], phase: 0 }, { amplitude: .23, wavelength: 13.7, direction: [.9063078, .4226183], phase: 1.7 },
    { amplitude: .12, wavelength: 7.1, direction: [.6156615, -.7880108], phase: 3.2 }, { amplitude: .06, wavelength: 3.3, direction: [-.9781476, .2079117], phase: .8 }] };
const paramCases: [string, any][] = [
  ["water world", world],
  ["defaults", {}],
  ["malformed", { center: [1, "x", 2], size: [-5, 0, 1e9], absorption: [-1, .2, NaN], speed: 99, waves: [{ amplitude: 9, wavelength: .01, direction: [0, 0] }, null] }],
  ["too many waves", { waves: Array.from({ length: 11 }, (_, i) => ({ amplitude: .1 * i, wavelength: 5 + i, direction: [1, i], phase: i })) }],
  ["slow", { speed: .01, size: [10, 4, 10], center: [3, -2, 1] }],
];
const params = paramCases.map(([name, data]) => ({ name, data, expect: round(withTop(waterParams(data))) }));

const heights: any[] = [];
for (const [name, data] of paramCases.slice(0, 3)) {
  const w = withTop(waterParams(data));
  for (const [x, z, t] of [[0, 0, 0], [12.5, -40, 3.3], [-700, 250.25, 1799.9], [3, 4, 3599.99]])
    heights.push({ name, data, x, z, t, expect: round(waveHeight(w, x, z, t)) });
}

const swims: any[] = [];
const inputs: [string, any][] = [
  ["forward", { direction: [0, 0, 1] }],
  ["fast diagonal", { direction: [1, 0, 1], fast: true }],
  ["dive", { direction: [0, -1, 0], dive: true }],
  ["rise", { direction: [0, 1, 0], rise: true }],
  ["idle float", { direction: [0, 0, 0] }],
  ["huge input", { direction: [30, 5, -40] }],
];
for (const [name, input] of inputs) for (const start of [[10, -6, 4], [0, -1.2, 0]]) {
  const w = withTop(waterParams(world));
  let pos = start, velocity = [0, 0, 0], t = 100;
  const steps: any[] = [];
  for (let i = 0; i < 40; i++) {
    const dt = [1 / 60, 1 / 30, .25][i % 3];   // .25 exercises the dt clamp
    const r = swimStep(pos, velocity, input, w, dt, t); t += dt;
    pos = r.pos; velocity = r.velocity; steps.push({ dt, pos: round(r.pos), velocity: round(r.velocity), mode: r.mode });
  }
  swims.push({ name, input, start, t0: 100, steps });
}

const out = JSON.stringify({ source: "shared/water.js", tolerance: 1e-6, params, heights, swims }, null, 1) + "\n";
const path = new URL("../shared/conformance/water.json", import.meta.url);
if (process.argv.includes("--check")) {
  if (readFileSync(path, "utf8") !== out) { console.error("water.json is stale: run bun tools/water-vectors.ts"); process.exit(1); }
  console.log(`WATER_VECTORS_CURRENT ${params.length}/${heights.length}/${swims.length}`);
} else { writeFileSync(path, out); console.log(`wrote ${params.length} params, ${heights.length} heights, ${swims.length} swim sequences`); }
