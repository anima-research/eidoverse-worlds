// Laws a world's look depends on, pinned as data (the house's view, #260 10-20: "Where a law must be exact, a vector file
// would pin it"). spec/conformance/laws.json holds, for fixed inputs: the ground's height (terrain params → heights at
// fixed points, as float64 bits) and the sky's forecast (a policy → each segment's start, end, state and intensity).
// The reference (shared/terrainmath.js, shared/forecast.js) must reproduce them bit for bit. --write regenerates.
// Each law names its version (LAWS: the ground's, the sky's, as the registry's sky.law says forecast@1): a change meant to
// alter a law's pinned output is a new version, so --write refuses to change it under the version already in the file, and
// LWV holds the same against git (pinhistory.ts).
//   bun test/protocol/laws-check.ts [--write]
import fs from "node:fs";
import { createHash } from "node:crypto";
import { makeHeightField, terrainParams } from "../../shared/terrainmath.js";
import { MAX_FEATURES, MAX_NAMED, SCULPT, withShaping } from "../../shared/terrainshape.js";
import { normalizePolicy, segmentAt } from "../../shared/forecast.js";
import * as PH from "../harness/pinhistory.ts";
import { fileURLToPath } from "node:url";
import { suite } from "../gate/suite.ts";
// ground@2 (2026-11-20): the ground gained two inputs beside the terrain's own args, each from components of its own on
// @world: named features (terrain-feature:<name>) and the sculpted layer (terrain-tile:<i>-<j>). Every ground@1 row pins
// the height it pinned (they are the first rows, unchanged); the rows after them carry `named` and `tiles`.
export const LAWS = { ground: { version: "ground@2", data: "terrain" }, sky: { version: "forecast@1", data: "sky" } } as const;
// sha256 of ground@1's rows as JSON (args and heights), taken from the laws.json that carried that version: LW5
const GROUND1 = "bc95d2a31c30a142d34eb2c8268bdd75aae77cd1e27126a863fde56fd7e92cc1";
const FILE = new URL("../../spec/conformance/laws.json", import.meta.url);
const bits = (x: number) => { const b = new DataView(new ArrayBuffer(8)); b.setFloat64(0, x); return b.getBigUint64(0).toString(16).padStart(16, "0"); };
const TERRAINS = [{}, { seed: 7, amplitude: 4 }, { seed: 123456, amplitude: 1.5, scale: 40 }, { seed: 3, features: [{ type: "hill", x: 10, z: 10, radius: 20, height: 6 }, { type: "ridge", x1: -50, z1: 0, x2: 50, z2: 5, radius: 8, height: -3 }] }, { seed: 9, features: [{ type: "flatten", x: 64, z: -64, radius: 15, height: 2, edge: 4 }] }];
const POINTS = [[0, 0], [1.5, -2.25], [10, 10], [-37.5, 12], [64, -64], [200, 3]];
// grounds shaped from beside the bag. named: {<name>: a feature (+ order)}; tiles: {<i>-<j>: {<sample>: mm}}, a tile's
// samples that aren't level, by their place in its row-major list (the rest are 0)
const SHAPED = [
  { args: { seed: 5, amplitude: 2 }, named: { mound: { type: "hill", x: 10, z: 10, radius: 12, height: 3 }, cut: { type: "ridge", x1: -40, z1: 10, x2: -30, z2: 14, radius: 6, height: -2 } } },
  // order before name: the pad levels first (order -1), then the hill is raised on it; b-pad before a-rise would otherwise read the other way round
  { args: { seed: 5, amplitude: 2, features: [{ type: "hill", x: 0, z: 0, radius: 9, height: 1.5 }] }, named: { "a-rise": { type: "hill", x: 1.5, z: -2.25, radius: 4, height: 0.75 }, "b-pad": { type: "flatten", x: 0, z: 0, radius: 6, height: 1, edge: 2, order: -1 } } },
  { args: { seed: 11, amplitude: 0 }, tiles: { "128-128": { 0: 1000, 1: 400, 32: -250, 660: 730 }, "131-127": { 31: -1200 }, "53-152": { 17: 90, 49: 45 } } },
  { args: { seed: 3, features: [{ type: "flatten", x: 10, z: 10, radius: 5, height: 2 }] }, named: { lip: { type: "ridge", x1: 0, z1: 0, x2: 10, z2: 10, radius: 3, height: 0.5 } }, tiles: { "128-128": { 660: -333, 661: 125 }, "127-127": { 1023: 500 } } },
];
const tileOf = (sparse: Record<string, number>) => { const mm = new Array(SCULPT.tile ** 2).fill(0); for (const [k, v] of Object.entries(sparse)) mm[Number(k)] = v; return mm; };
const shapedArgs = (r: any) => withShaping({ kind: "noise", ...r.args }, r.named ?? null, r.tiles ? Object.fromEntries(Object.entries(r.tiles).map(([k, t]: any) => [k, { mm: tileOf(t) }])) : null);
const POLICIES = [{ seed: "rain-town", states: ["clear", { state: "rain", weight: 2 }, "fog"], dwell: [600, 1800], k: [0.7, 1], epoch: 1767225600000 },
  { seed: 42, states: ["clear", "storm"], dwell: [120, 240], epoch: 1767225600000 }];
const terrain = [...TERRAINS.map((a) => ({ args: a })), ...SHAPED].map((r: any) => { const h = makeHeightField(terrainParams(r.named || r.tiles ? shapedArgs(r) : r.args)) as any; const at = typeof h === "function" ? h : h.heightAt ?? h.at;
  return { ...r, heights: POINTS.map(([x, z]) => [x, z, bits(at(x, z))]) }; });
const sky = POLICIES.map((f) => { const p: any = { ...normalizePolicy(f), epoch: f.epoch }; const segs: unknown[] = []; let t = f.epoch, cur = null;
  for (let i = 0; i < 12; i++) { const s: any = segmentAt(p, t, cur); segs.push([s.idx, s.startMs, s.endMs, s.state, bits(s.k)]); cur = s; t = s.endMs; }
  return { policy: f, segments: segs }; });
const now = { terrain, sky };
/** The rows' columns, and what a second reader must do before the height law (generated from the code: LWC). */
const COLUMNS = { "terrain[].heights[]": ["x (m)", "z (m)", "height (m, float64 bits)"], "sky[].segments[]": ["index (segments since the epoch)", "startMs", "endMs", "state", "intensity k (float64 bits)"] };
const D = terrainParams({});
const CONTRACT = `The ground: each row's args are normalised by terrainParams (shared/terrainmath.js) before the height law makeHeightField reads them, and the heights pinned are of the normalised params. A missing or non-finite number takes its default: size ${D.size}, amplitude ${D.amplitude}, flatRadius ${D.flatRadius}, flatHeight ${D.flatHeight}, frequency ${D.frequency}; seed, default ${D.seed}, is truncated toward zero and then read as a 32-bit integer (seed | 0), where 0 reads as 1; octaves is truncated and clamped to 1..8, default ${D.octaves}. kind: 'flat' is level ground at its height (default 0, size 200): the noise keys and shaping are then not read (no row here pins it). Any other key (scale in one row here) is not a parameter and changes nothing. Shaping (shared/terrainshape.js shapeParams) is carried only when the args use it: the first ${MAX_FEATURES} features, in order; an unknown type is dropped; radius is clamped to 0..2000 and a feature with radius <= 0.05 dropped; height is clamped to -500..500; a ridge needs finite x1, z1, x2, z2, a hill or flatten finite x, z, or it is dropped; a flatten's edge defaults to radius * 0.5, clamped to 0.01..2000; a heightmap {grid, min (default 0), max (default 10)} whose grid is a stored grid's reference is carried too (no row here pins it: its grid is data outside this file). The features then apply in order over the base height (shapeHeight): the noise, or, when a heightmap's grid is found, the heightmap's sample in its place (the noise is then not read; a grid not found falls back to the noise). A row may shape its ground from beside its args, as a world does from components of their own on @world (never on level ground: kind 'flat' reads neither). named is {<name>: a feature, with order?}: read as a list feature is and applied after the list, by order (absent or non-finite: 0) and then by name in code-unit order, the first ${MAX_NAMED} of them. tiles is the sculpted layer, {<i>-<j>: {<sample>: mm}}: a lattice of samples every ${SCULPT.spacing} m, sample (gx, gz) standing at x = ${SCULPT.origin} + ${SCULPT.spacing} gx, z = ${SCULPT.origin} + ${SCULPT.spacing} gz; tile <i>-<j> holds the ${SCULPT.tile} × ${SCULPT.tile} samples gx = ${SCULPT.tile} i …, gz = ${SCULPT.tile} j …, row-major with rows along z (sample (gx, gz) is entry (gz - ${SCULPT.tile} j) * ${SCULPT.tile} + (gx - ${SCULPT.tile} i)), in whole millimetres; a row here lists only the samples that aren't 0, and a tile or sample not given is 0. At a point the layer is bilinear between the four samples round it (u = (x - ${SCULPT.origin}) / ${SCULPT.spacing}, i = floor(u), along x first: a = d00 + (d10 - d00) * fu, b = d01 + (d11 - d01) * fu, then (a + (b - a) * fv) / 1000 metres; nothing is added where all four are 0), and it is added last, after every feature. The sky: each policy is read through normalizePolicy (shared/forecast.js) with its epoch kept, and segments are walked from the epoch, each starting where the last ended.`;
if (process.argv.includes("--write")) {
  const had = fs.existsSync(FILE) ? JSON.parse(fs.readFileSync(FILE, "utf8")) : null;
  const moved = Object.entries(LAWS).filter(([k, L]) => had?.laws?.[k] === L.version && JSON.stringify(had[L.data]) !== JSON.stringify((now as any)[L.data])).map(([, L]) => `${L.data} under ${L.version}`);
  if (moved.length) { console.log(`refusing to write: ${moved.join(", ")} would change (a change meant to alter results is a new version: bump it in LAWS, laws-check.ts)`); process.exit(1); }
  fs.writeFileSync(FILE, JSON.stringify({ laws: { ground: LAWS.ground.version, sky: LAWS.sky.version }, columns: COLUMNS, contract: CONTRACT, note: "heights and intensities are IEEE-754 float64 bits, big-endian hex; times are epoch ms", ...now }, null, 1) + "\n"); console.log(`laws.json written (${LAWS.ground.version}, ${LAWS.sky.version})`); process.exit(0); }
const { check, done } = suite("laws-check");
const { value: want, bad } = PH.parsedNow(FILE);   // conflict markers in the file are LW0's red, not a crashed suite
check("LW0 the law vectors exist and parse", !!want, bad ? { bad } : undefined);
if (want) {
  check(`LW1 the ground: every pinned height, bit for bit (${TERRAINS.length + SHAPED.length} grounds × ${POINTS.length} points; ${SHAPED.length} shaped from beside the bag: named features, sculpted tiles)`, JSON.stringify(want.terrain) === JSON.stringify(now.terrain), now.terrain.map((t, i) => JSON.stringify(t) === JSON.stringify(want.terrain[i])));
  check(`LW2 the sky: every pinned forecast segment (start, end, state, intensity) (${POLICIES.length} policies × 12)`, JSON.stringify(want.sky) === JSON.stringify(now.sky), now.sky.map((s, i) => JSON.stringify(s) === JSON.stringify(want.sky[i])));
  const flat = new Set(now.terrain.flatMap((t) => t.heights.map((h) => h[2]))).size, states = new Set(now.sky.flatMap((s) => (s.segments as any[]).map((g) => g[3]))).size;
  check("LW3 the vectors exercise the law: heights vary and more than one weather state appears", flat > 5 && states > 1, { distinctHeights: flat, states });
  // a shaped row must be moved by what shapes it, or it pins nothing: each differs from its own args' bare ground at some point
  const moved = SHAPED.map((r: any, i) => { const bare = makeHeightField(terrainParams({ kind: "noise", ...r.args })) as any; return now.terrain[TERRAINS.length + i].heights.filter(([x, z, b]: any) => b !== bits(bare(x, z))).length; });
  check("LW4 every row shaped from beside the bag stands apart from its own unshaped ground at the pinned points (named features and sculpted tiles are read)", moved.every((n) => n >= 2), moved);
  // the ground@1 rows are held by what they were when ground@1 was the version (their args and every height, as that file
  // pinned them), so a height changed under ground@2 can't pass for the old law
  const g1 = createHash("sha256").update(JSON.stringify(want.terrain.slice(0, TERRAINS.length))).digest("hex");
  check("LW5 every ground@1 row is still pinned as it was, args and heights (its rows' digest, taken at ground@1): the first rows", g1 === GROUND1 && want.terrain.slice(0, TERRAINS.length).every((t: any) => !t.named && !t.tiles), g1);
}
check("LWC the rows are labelled (columns: each row's arity is its header's) and the contract says how terrain args are normalised before the height law (defaults, clamps), as the code states them now",
  JSON.stringify(want?.columns) === JSON.stringify(COLUMNS) && want?.contract === CONTRACT && now.terrain.every((t) => t.heights.every((h) => h.length === COLUMNS["terrain[].heights[]"].length)) && now.sky.every((g) => (g.segments as any[]).every((r) => r.length === COLUMNS["sky[].segments[]"].length)),
  { columns: JSON.stringify(want?.columns) === JSON.stringify(COLUMNS), contract: want?.contract === CONTRACT || want?.contract });
{ const ROOT = fileURLToPath(new URL("../../", import.meta.url)); const F = "spec/conformance/laws.json";
  let r: any; try { r = PH.sameVersionChanged(ROOT, F, (f) => (fs.existsSync(ROOT + f) ? fs.readFileSync(ROOT + f, "utf8") : null), Object.entries(LAWS).map(([k, L]) => ({ law: k, versionOf: (x: any) => x?.laws?.[k], data: [L.data] }))); } catch (err: any) { r = { threw: PH.reason(err) }; }   // a throw (a record it can't read) is a red row, as N10's; a bug keeps its stack
  if (r.out?.length) console.log("     ", JSON.stringify(r).slice(0, 400)); const threw = "threw" in r;
  check(`LWV each law names its version (ground ${LAWS.ground.version}, sky ${LAWS.sky.version}), and an earlier laws.json under the same version (the base's, the previous) pinned the same output: a change in pinned output is a new version`, !threw && want?.laws?.ground === LAWS.ground.version && want?.laws?.sky === LAWS.sky.version && !r.out.length, threw ? { threw: r.threw } : { ...want?.laws, ...(r.unheld?.length ? { unheld: r.unheld } : {}) }); }   // a history that starts with no version: green, its reason kept
done();
