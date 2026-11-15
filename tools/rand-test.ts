// tools/rand-test.ts — the shared seeded stream (shared/rand.js), and a tripwire for the float LCG that collapsed into a cycle
// of 10,466 states (#299: a 32-bit seed times glibc's multiplier passes 2^53, so the mask reads rounded bits).
//   BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun tools/rand-test.ts
import fs from "node:fs";
import path from "node:path";
import { mulberry32, seededBytes } from "../shared/rand.js";

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail: unknown = "") => { if (ok) pass++; else fail++; console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : `  ${typeof detail === "string" ? detail : JSON.stringify(detail)}`}`); };
const ROOT = path.join(import.meta.dir, "..");

{ const r = mulberry32(12345), seen = new Set<number>(); let low = 0;
  for (let i = 0; i < 200_000; i++) { const v = r(); seen.add(v); if (Math.floor(v * 8) === 0) low++; }
  check("200,000 draws from seed 12345 are distinct but for birthday collisions (~5 expected): no short cycle", seen.size > 199_950, seen.size);
  check("…and an eighth of them fall in the lowest eighth (the old stream put 99.5% of seed % 8 at 0)", Math.abs(low / 200_000 - 1 / 8) < 0.005, low); }
check("the stream is in [0, 1) and repeats from its seed", (() => { const a = mulberry32(7), b = mulberry32(7); for (let i = 0; i < 1000; i++) { const v = a(); if (!(v >= 0 && v < 1) || v !== b()) return false; } return true; })());
check("mulberry32(1)'s first draw is the reference value (integer arithmetic, the same on every engine)", mulberry32(1)() === 0.6270739405881613, mulberry32(1)());
{ const b = seededBytes(3), x = b(4096), c = new Set(x);
  check("seededBytes gives n bytes per call, spread over all 256 values", x.length === 4096 && c.size === 256 && b(3).length === 3, c.size); }

// a tripwire for the shape that bit, not the whole class (a float product past 2^53): glibc's multiplier in a `*` product, either side
const M = "1103" + "515245";   // split so this file doesn't match itself
const LCG = new RegExp(String.raw`[\w)\]]\s*\*\s*${M}\b|\b${M}\s*\*\s*[\w(]`);
const hits: string[] = [];
const walk = (dir: string) => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
  if (e.name === "node_modules" || e.name.startsWith(".") || e.name === "frozen") continue;
  const p = path.join(dir, e.name);
  if (e.isDirectory()) walk(p);
  else if (/\.(ts|js|mjs|html)$/.test(e.name)) fs.readFileSync(p, "utf8").split("\n").forEach((l, n) => { if (LCG.test(l)) hits.push(`${path.relative(ROOT, p)}:${n + 1}`); });
} };
walk(ROOT);   // the whole tree but node_modules, dot-dirs and frozen/ (import-v1's pinned closure, kept byte for byte)
check("no product with glibc's multiplier outside Math.imul in the tree, frozen/ aside (it passes 2^53): use shared/rand.js", hits.length === 0, hits.join(", "));
check("…and the scan catches the shape either way round and leaves Math.imul alone", LCG.test("seed = (seed * 1103" + "515245 + 12345) & 0x7fffffff") && LCG.test("seed = (1103" + "515245 * seed + 12345) & 0x7fffffff") && !LCG.test("Math.imul(seed, 1103" + "515245)"));

console.log(`${fail ? "FAIL" : "ok"} rand: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
