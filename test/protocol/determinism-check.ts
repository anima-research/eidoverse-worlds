// test/protocol/determinism-check.ts — the fold and the sim own their numbers (PROTOCOL_v2 Covenant I; shared/simmath.js is the
// kernel). A host transcendental or a wall clock in the code every replica runs is a forked world: two correct engines may
// differ in the last bit. This scans shared/protocol/fold.js, shared/eidosim.js, the sim layer (simlayer.js, replica.js) and
// every module they reach by static relative import, and fails on a call of Math.sin/cos/tan/atan2/exp/log/pow/random,
// Date.now or performance.now (comments stripped). Lines where such a call is legitimate are allowed by name in ALLOWED,
// each with why; rot.js has its own row (test/shared/rot-test.ts). The authority (shared/protocol/authority/) is not scanned: it
// computes once and writes rounded results into the log (TEACHING-FINDINGS 11-02); replicas fold the stored numbers.
// usage: bun test/protocol/determinism-check.ts     (prints each offence as file:line; exit 1 if any)
// @ts-nocheck
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dir, "../..");
const ROOTS = ["shared/protocol/fold.js", "shared/protocol/simlayer.js", "shared/protocol/replica.js", "shared/eidosim.js"];
const CALL = /\b(?:Math\.(?:sin|cos|tan|atan2|exp|log|pow|random)|Date\.now|performance\.now)\s*\(/;
// file → a pattern the line must match, why the call is not a replica's number, and the calls it permits there (any
// other banned call on the same line is still an offence)
const ALLOWED: [string, RegExp, string, RegExp][] = [
  ["shared/protocol/simlayer.js", /^const yawOf = \(q\) =>/, "the engine view's yaw: eidosim reads the quaternion (sim.js quatOf) when the view carries one, which worldPose always does", /Math\.atan2\s*\(/g],
  ["shared/mover.js", /^(?!.*(?:Math\.(?:sin|cos|tan|log|pow|random)|Date\.now|performance\.now)\s*\().*Math\.(?:exp|atan2)\(/, "the walker: the authority steps it once and writes rounded results into the log (mover-check proves the client agrees); no replica re-walks", /Math\.(?:exp|atan2)\s*\(/g],
  ["shared/terrainshape.js", /Date\.now\(\)/, "a grid fetch's retry timer (cache bookkeeping); the grid's heights are the fold's input, not its arithmetic", /Date\.now\s*\(/g],
];
const IMPORT = /(?:(?:import|export)[^'";]*from\s*|import\s*\(?\s*|require\s*\(\s*)['"](\.[^'"]+)['"]/g;   // also export-from and bare `import './x'`
const files: string[] = [], missing: string[] = [];
const walk = (rel: string) => {
  if (files.includes(rel)) return;
  const p = path.join(ROOT, rel); if (!fs.existsSync(p)) { if (!missing.includes(rel)) missing.push(rel); return; }   // unread code is unchecked code: an offence
  files.push(rel);
  for (const m of fs.readFileSync(p, "utf8").matchAll(IMPORT)) walk(path.posix.normalize(path.posix.join(path.posix.dirname(rel), m[1])));
};
ROOTS.forEach(walk);
// the rule on its own samples: a call is caught, a mention in a comment is not
for (const [line, hit] of [["const k = 1 - Math.exp(-ease * dt);", true], ["// no Math.pow here", false], ["const t = Date.now();", true]])
  if (CALL.test(line.replace(/\/\/.*$/, "")) !== hit) { console.log(`[determinism-check] self-check failed on ${line}`); process.exit(2); }
// an allowed line covers its own call, never another banned call beside it
for (const [rel, line, ok] of [["shared/mover.js", "const k = 1 - Math.exp(-ease * dt);", true], ["shared/mover.js", "return Math.exp(x) + Math.random();", false],
  ["shared/protocol/simlayer.js", "const yawOf = (q) => (Array.isArray(q) ? 2 * Math.atan2(q[1], q[3]) : 0);", true], ["shared/protocol/simlayer.js", "const yawOf = (q) => Math.atan2(q[1], q[3]) + Math.random();", false],
  ["shared/terrainshape.js", "misses.set(ref, Date.now());", true], ["shared/terrainshape.js", "misses.set(ref, Date.now() + Math.random());", false]] as const)
  if (ALLOWED.some(([f, re, , only]) => rel === f && re.test(line) && !CALL.test(line.replace(only, ""))) !== ok) { console.log(`[determinism-check] allow self-check failed on ${line}`); process.exit(2); }
const offences: string[] = [];
for (const rel of files) {
  const src = fs.readFileSync(path.join(ROOT, rel), "utf8").replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
  src.split("\n").forEach((raw, i) => {
    const line = raw.replace(/\/\/.*$/, "");
    if (CALL.test(line) && !ALLOWED.some(([f, re, , only]) => rel === f && re.test(raw) && !CALL.test(line.replace(only, "")))) offences.push(`${rel}:${i + 1}  ${raw.trim().slice(0, 120)}`);
  });
}
for (const m of missing) offences.push(`${m}  is imported (or a root) but isn't there, so it wasn't scanned`);
for (const o of offences) console.log("  " + o);
console.log(`[determinism-check] ${files.length} files reached from ${ROOTS.join(", ")}; ${offences.length ? `${offences.length} offence(s): a host transcendental or wall clock in replica code` : `no host transcendental or wall clock outside the ${ALLOWED.length} allowed lines`}`);
process.exit(offences.length ? 1 : 0);
