// Laws a world's look depends on, pinned as data (the house's view, #260 10-20: "Where a law must be exact, a vector file
// would pin it"). spec/conformance/laws.json holds, for fixed inputs: the ground's height (terrain params → heights at
// fixed points, as float64 bits) and the sky's forecast (a policy → each segment's start, end, state and intensity).
// The reference (shared/terrainmath.js, shared/forecast.js) must reproduce them bit for bit. --write regenerates.
//   bun tools/protocol/laws-check.ts [--write]
import fs from "node:fs";
import { makeHeightField, terrainParams } from "../../shared/terrainmath.js";
import { normalizePolicy, segmentAt } from "../../shared/forecast.js";
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
if (process.argv.includes("--write")) { fs.writeFileSync(FILE, JSON.stringify({ note: "heights and intensities are IEEE-754 float64 bits, big-endian hex; times are epoch ms", ...now }, null, 1) + "\n"); console.log("laws.json written"); process.exit(0); }
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
console.log(`[laws-check] ${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
