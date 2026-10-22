// Laws a world's look depends on, pinned as data (the house's view, #260 10-20: "Where a law must be exact, a vector file
// would pin it"). spec/conformance/laws.json holds, for fixed inputs: the ground's height (terrain params → heights at
// fixed points, as float64 bits) and the sky's forecast (a policy → each segment's start, end, state and intensity).
// The reference (shared/terrainmath.js, shared/forecast.js) must reproduce them bit for bit. --write regenerates.
// Each law names its version (LAWS: the ground's, the sky's, as the registry's sky.law says forecast@1): a change meant to
// alter a law's pinned output is a new version, so --write refuses to change it under the version already in the file, and
// LWV holds the same against git (pinhistory.ts).
//   bun tools/protocol/laws-check.ts [--write]
import fs from "node:fs";
import { makeHeightField, terrainParams } from "../../shared/terrainmath.js";
import { MAX_FEATURES } from "../../shared/terrainshape.js";
import { normalizePolicy, segmentAt } from "../../shared/forecast.js";
import * as PH from "./pinhistory.ts";
export const LAWS = { ground: { version: "ground@1", data: "terrain" }, sky: { version: "forecast@1", data: "sky" } } as const;
const FILE = new URL("../../spec/conformance/laws.json", import.meta.url);
const bits = (x: number) => { const b = new DataView(new ArrayBuffer(8)); b.setFloat64(0, x); return b.getBigUint64(0).toString(16).padStart(16, "0"); };
const TERRAINS = [{}, { seed: 7, amplitude: 4 }, { seed: 123456, amplitude: 1.5, scale: 40 }, { seed: 3, features: [{ type: "hill", x: 10, z: 10, radius: 20, height: 6 }, { type: "ridge", x1: -50, z1: 0, x2: 50, z2: 5, radius: 8, height: -3 }] }, { seed: 9, features: [{ type: "flatten", x: 64, z: -64, radius: 15, height: 2, edge: 4 }] }];
const POINTS = [[0, 0], [1.5, -2.25], [10, 10], [-37.5, 12], [64, -64], [200, 3]];
const POLICIES = [{ seed: "rain-town", states: ["clear", { state: "rain", weight: 2 }, "fog"], dwell: [600, 1800], k: [0.7, 1], epoch: 1767225600000 },
  { seed: 42, states: ["clear", "storm"], dwell: [120, 240], epoch: 1767225600000 }];
const terrain = TERRAINS.map((a) => { const h = makeHeightField(terrainParams(a)) as any; const at = typeof h === "function" ? h : h.heightAt ?? h.at;
  return { args: a, heights: POINTS.map(([x, z]) => [x, z, bits(at(x, z))]) }; });
const sky = POLICIES.map((f) => { const p: any = { ...normalizePolicy(f), epoch: f.epoch }; const segs: unknown[] = []; let t = f.epoch, cur = null;
  for (let i = 0; i < 12; i++) { const s: any = segmentAt(p, t, cur); segs.push([s.idx, s.startMs, s.endMs, s.state, bits(s.k)]); cur = s; t = s.endMs; }
  return { policy: f, segments: segs }; });
const now = { terrain, sky };
/** The rows' columns, and what a second reader must do before the height law (generated from the code: LWC). */
const COLUMNS = { "terrain[].heights[]": ["x (m)", "z (m)", "height (m, float64 bits)"], "sky[].segments[]": ["index (segments since the epoch)", "startMs", "endMs", "state", "intensity k (float64 bits)"] };
const D = terrainParams({});
const CONTRACT = `The ground: each row's args are normalised by terrainParams (shared/terrainmath.js) before the height law makeHeightField reads them, and the heights pinned are of the normalised params. A missing or non-finite number takes its default: size ${D.size}, amplitude ${D.amplitude}, flatRadius ${D.flatRadius}, flatHeight ${D.flatHeight}, frequency ${D.frequency}; seed, default ${D.seed}, is truncated toward zero and then read as a 32-bit integer (seed | 0), where 0 reads as 1; octaves is truncated and clamped to 1..8, default ${D.octaves}. Any other key (scale in one row here) is not a parameter and changes nothing. Shaping (shared/terrainshape.js shapeParams) is carried only when the args use it: the first ${MAX_FEATURES} features, in order; an unknown type is dropped; radius is clamped to 0..2000 and a feature with radius <= 0.05 dropped; height is clamped to -500..500; a ridge needs finite x1, z1, x2, z2, a hill or flatten finite x, z, or it is dropped; a flatten's edge defaults to radius * 0.5, clamped to 0.01..2000. The features then apply in order over the noise (shapeHeight). The sky: each policy is read through normalizePolicy (shared/forecast.js) with its epoch kept, and segments are walked from the epoch, each starting where the last ended.`;
if (process.argv.includes("--write")) {
  const had = fs.existsSync(FILE) ? JSON.parse(fs.readFileSync(FILE, "utf8")) : null;
  const moved = Object.entries(LAWS).filter(([k, L]) => had?.laws?.[k] === L.version && JSON.stringify(had[L.data]) !== JSON.stringify((now as any)[L.data])).map(([, L]) => `${L.data} under ${L.version}`);
  if (moved.length) { console.log(`refusing to write: ${moved.join(", ")} would change (a change meant to alter results is a new version: bump it in LAWS, laws-check.ts)`); process.exit(1); }
  fs.writeFileSync(FILE, JSON.stringify({ laws: { ground: LAWS.ground.version, sky: LAWS.sky.version }, columns: COLUMNS, contract: CONTRACT, note: "heights and intensities are IEEE-754 float64 bits, big-endian hex; times are epoch ms", ...now }, null, 1) + "\n"); console.log(`laws.json written (${LAWS.ground.version}, ${LAWS.sky.version})`); process.exit(0); }
let pass = 0, fail = 0;
const check = (n: string, ok: boolean, info?: unknown) => { if (ok) { pass++; console.log(`ok   ${n}`); } else { fail++; console.log(`FAIL ${n}`); if (info !== undefined) console.log("     ", JSON.stringify(info).slice(0, 400)); } };
const want = fs.existsSync(FILE) ? JSON.parse(fs.readFileSync(FILE, "utf8")) : null;
check("LW0 the law vectors exist", !!want);
if (want) {
  check(`LW1 the ground: every pinned height, bit for bit (${TERRAINS.length} grounds × ${POINTS.length} points)`, JSON.stringify(want.terrain) === JSON.stringify(now.terrain), now.terrain.map((t, i) => JSON.stringify(t) === JSON.stringify(want.terrain[i])));
  check(`LW2 the sky: every pinned forecast segment (start, end, state, intensity) (${POLICIES.length} policies × 12)`, JSON.stringify(want.sky) === JSON.stringify(now.sky), now.sky.map((s, i) => JSON.stringify(s) === JSON.stringify(want.sky[i])));
  const flat = new Set(now.terrain.flatMap((t) => t.heights.map((h) => h[2]))).size, states = new Set(now.sky.flatMap((s) => (s.segments as any[]).map((g) => g[3]))).size;
  check("LW3 the vectors exercise the law: heights vary and more than one weather state appears", flat > 5 && states > 1, { distinctHeights: flat, states });
}
check("LWC the rows are labelled (columns: each row's arity is its header's) and the contract says how terrain args are normalised before the height law (defaults, clamps), as the code states them now",
  JSON.stringify(want?.columns) === JSON.stringify(COLUMNS) && want?.contract === CONTRACT && now.terrain.every((t) => t.heights.every((h) => h.length === COLUMNS["terrain[].heights[]"].length)) && now.sky.every((g) => (g.segments as any[]).every((r) => r.length === COLUMNS["sky[].segments[]"].length)),
  { columns: JSON.stringify(want?.columns) === JSON.stringify(COLUMNS), contract: want?.contract === CONTRACT || want?.contract });
check(`LWV each law names its version (ground ${LAWS.ground.version}, sky ${LAWS.sky.version}), and an earlier laws.json under the same version (the base's, the previous) pinned the same output: a change in pinned output is a new version`, (() => {
  const ROOT = new URL("../../", import.meta.url).pathname; const F = "spec/conformance/laws.json";
  const r = PH.sameVersionChanged(ROOT, F, (f) => (fs.existsSync(ROOT + f) ? fs.readFileSync(ROOT + f, "utf8") : null), Object.entries(LAWS).map(([k, L]) => ({ law: k, versionOf: (x: any) => x?.laws?.[k], data: [L.data] })));
  if (r.out.length) console.log("     ", JSON.stringify(r).slice(0, 400)); return want?.laws?.ground === LAWS.ground.version && want?.laws?.sky === LAWS.sky.version && !r.out.length; })(), want?.laws);
console.log(`[laws-check] ${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
