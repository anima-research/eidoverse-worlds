// The heading law's trig, pinned as data (PROTOCOL §9.1; the house's view, #260 10-20: a law that must be exact is a vector
// file, not a pointer at code). spec/conformance/trig.json holds inputs and the exact float64 bits of sin, cos and atan2
// that every reader must produce; the reference (shared/simmath.js) must reproduce them. --write regenerates from it.
// The file names its law's version (LAW): a change meant to alter the outputs is a new version, so --write refuses to change
// a pinned output under the version already in the file (bump LAW), and TRV holds the same against git (pinhistory.ts).
//   bun tools/protocol/trig-check.ts [--write]
import fs from "node:fs";
import { sinT, cosT, atan2T, SIMMATH_ID } from "../../shared/simmath.js";
import * as PH from "./pinhistory.ts";
export const LAW = "heading-trig@1";
const DATA = ["sin", "cos", "atan2"] as const;
const FILE = new URL("../../spec/conformance/trig.json", import.meta.url);
const bits = (x: number) => { const b = new DataView(new ArrayBuffer(8)); b.setFloat64(0, x); return b.getBigUint64(0).toString(16).padStart(16, "0"); };
const angles = [0, 1e-9, 0.1, 0.5, 1, Math.PI / 6, Math.PI / 4, Math.PI / 3, Math.PI / 2, 2, 3, Math.PI, 4, 5, 2 * Math.PI, 7, -0.3, -1.7, -Math.PI, 100, -100, 12345.678];
const pairs: [number, number][] = [[0, 1], [1, 0], [1, 1], [-1, 1], [1, -1], [-1, -1], [0, -1], [-0, -1], [3, 4], [-4, 3], [1e-9, 1], [0.6, -0.8], [2.5, 0.25]];
/** What a second reader must do with these bits (generated from the kernel, so it can't drift from it: TRC). */
const CONTRACT = `These are the outputs of the reference kernel ${SIMMATH_ID} (shared/simmath.js: two-word Cody-Waite argument reduction, then fixed-order polynomials, built only from IEEE-754-exact operations), NOT the host libm's sin, cos and atan2, and not correctly rounded (about 1-3 ulp). By design sin(pi/6) here is ${bits(sinT(Math.PI / 6))}, not 0.5 (3fe0000000000000): identical on every engine matters, perfect does not. A second implementation must reproduce these exact bits: port the kernel (its coefficients, reduction words and evaluation order are its version) or ship this table; a libm call will not match.`;
const now = { sin: angles.map((a) => [bits(a), bits(sinT(a))]), cos: angles.map((a) => [bits(a), bits(cosT(a))]), atan2: pairs.map(([y, x]) => [bits(y), bits(x), bits(atan2T(y, x))]) };
if (process.argv.includes("--write")) {
  const had = fs.existsSync(FILE) ? JSON.parse(fs.readFileSync(FILE, "utf8")) : null;
  const moved = had?.law === LAW ? DATA.filter((k) => JSON.stringify(had[k]) !== JSON.stringify(now[k])) : [];
  if (moved.length) { console.log(`refusing to write: ${moved.join(", ")} would change under ${LAW} (a change meant to alter results is a new version: bump LAW in trig-check.ts)`); process.exit(1); }
  fs.writeFileSync(FILE, JSON.stringify({ law: LAW, kernel: SIMMATH_ID, contract: CONTRACT, note: "inputs and outputs are IEEE-754 float64 bits, big-endian hex", ...now }, null, 1) + "\n"); console.log(`trig.json written (${LAW})`); process.exit(0); }
let pass = 0, fail = 0;
const check = (n: string, ok: boolean, info?: unknown) => { if (ok) { pass++; console.log(`ok   ${n}`); } else { fail++; console.log(`FAIL ${n}`); if (info !== undefined) console.log("     ", JSON.stringify(info).slice(0, 400)); } };
const want = fs.existsSync(FILE) ? JSON.parse(fs.readFileSync(FILE, "utf8")) : null;
check("TR0 the trig vectors exist", !!want);
if (want) for (const k of ["sin", "cos", "atan2"] as const) {
  const off = (want[k] as string[][]).filter((row, i) => JSON.stringify(row) !== JSON.stringify(now[k][i]));
  check(`TR ${k}: the reference reproduces every pinned output bit for bit (${want[k].length} rows)`, want[k].length === now[k].length && !off.length, off.slice(0, 3));
}
check(`TRC the file says what a second reader must do: the kernel it pins (${SIMMATH_ID}) and its contract (the reference kernel's bits, not libm's; sin(pi/6) not 0.5 by design; port the kernel or ship the table), as the kernel states them now`,
  want?.kernel === SIMMATH_ID && want?.contract === CONTRACT && bits(sinT(Math.PI / 6)) !== bits(0.5) && (want?.sin ?? []).some((r: string[]) => r[0] === bits(Math.PI / 6) && r[1] !== bits(0.5)), { kernel: want?.kernel, contract: want?.contract === CONTRACT || want?.contract });
check(`TRV the file names its law's version (${LAW}), and an earlier trig.json under the same version (the base's, the previous) pinned the same outputs: a change in pinned output is a new version`, (() => {
  const ROOT = new URL("../../", import.meta.url).pathname; const F = "spec/conformance/trig.json";
  const r = PH.sameVersionChanged(ROOT, F, (f) => (fs.existsSync(ROOT + f) ? fs.readFileSync(ROOT + f, "utf8") : null), [{ law: "trig", versionOf: (x) => x?.law, data: [...DATA] }]);
  if (r.out.length) console.log("     ", JSON.stringify(r).slice(0, 400)); return want?.law === LAW && !r.out.length; })(), { law: want?.law, LAW });
console.log(`[trig-check] ${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
