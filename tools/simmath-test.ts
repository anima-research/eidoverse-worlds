// simmath-test — the deterministic numerics kernel, proven (Covenant I).
//
//   bun tools/simmath-test.ts
//
// Three claims, each load-bearing for PROTOCOL_v2:
//   1. ACCURACY — sinT/cosT/atan2T/expT track the host libm within a few
//      ulp over the sim's working domain (the kernel must be a real math
//      library, not a deterministic wrong answer);
//   2. IDENTITY ACROSS ENGINES — a fixed 48k-point sweep digests to the
//      same sha256 under Bun (JSC), node (V8) and deno (V8, different
//      embedding). This is the whole covenant: the kernel is built from
//      IEEE-exact ops only, so engines cannot disagree;
//   3. IDENTITY ACROSS TIME — the sweep digest equals the committed GOLDEN
//      constant. The coefficients ARE the version (Covenant II): any edit
//      that moves a bit anywhere in the kernel trips this first, and the
//      correct response is an epoch bump, never a quiet re-record.

import { join } from "node:path";
import { existsSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { mkCheck, bold, ROOT } from "./harness.ts";
import { sinT, cosT, atan2T, expT, PI, SIMMATH_ID } from "../shared/simmath.js";

const { check, tally } = mkCheck();
console.log(`\n${bold("simmath-test")} — ${SIMMATH_ID}`);

// The committed truth. Re-record ONLY as part of a deliberate version bump
// of SIMMATH_ID — see claim 3 above.
const GOLDEN = "7f604515c4858e4c3dce5f0c8fe9fef2e27ee661d3373288a93ea7037fb62bb8";

// ---- 1. accuracy ------------------------------------------------------------
console.log("\naccuracy against the host libm (which the sim itself may never call):");
{
  let worstS = 0, worstC = 0;
  for (let i = 0; i < 20000; i++) {
    const x = (i - 10000) * 0.033;                        // ±330 rad
    worstS = Math.max(worstS, Math.abs(sinT(x) - Math.sin(x)));
    worstC = Math.max(worstC, Math.abs(cosT(x) - Math.cos(x)));
  }
  check("sinT within 2 ulp over ±330 rad", worstS <= 4.5e-16, `worst ${worstS.toExponential(2)}`);
  check("cosT within 2 ulp over ±330 rad", worstC <= 4.5e-16, `worst ${worstC.toExponential(2)}`);
  let worstFar = 0;
  for (const x of [1e4, 12345.678, 1e5, 999999.25, 1e6]) {
    worstFar = Math.max(worstFar, Math.abs(sinT(x) - Math.sin(x)), Math.abs(cosT(x) - Math.cos(x)));
  }
  check("reduction holds to the 1e6 rad domain edge", worstFar <= 1e-16 * 20, `worst ${worstFar.toExponential(2)}`);
  let worstA = 0;
  for (let i = 0; i < 5000; i++) {
    const y = Math.sin(i * 1.7) * 50, x = Math.cos(i * 2.3) * 50;
    worstA = Math.max(worstA, Math.abs(atan2T(y, x) - Math.atan2(y, x)));
  }
  check("atan2T within ~4 ulp of π", worstA <= 2e-15, `worst ${worstA.toExponential(2)}`);
  let worstE = 0;
  for (let i = 0; i < 4000; i++) {
    const x = (i - 2000) * 0.35;                          // ±700
    const e = expT(x), r = Math.exp(x);
    worstE = Math.max(worstE, r === 0 ? Math.abs(e) : Math.abs(e - r) / r);
  }
  check("expT within 2 ulp relative over ±700", worstE <= 4.5e-16, `worst ${worstE.toExponential(2)}`);
}

// ---- 2. the fixed words -----------------------------------------------------
console.log("\nedges and identities:");
{
  check("sinT(0)=0, cosT(0)=1, expT(0)=1", sinT(0) === 0 && cosT(0) === 1 && expT(0) === 1);
  check("expT(-∞)=0, expT(∞)=∞, overflow→∞, underflow→0",
    expT(-Infinity) === 0 && expT(Infinity) === Infinity
    && expT(710) === Infinity && expT(-746) === 0);
  check("NaN in → NaN out", Number.isNaN(sinT(NaN)) && Number.isNaN(cosT(Infinity)) && Number.isNaN(atan2T(NaN, 1)));
  check("atan2T quadrants: (1,1)=π/4-ish, (0,-1)=π, (-1,0)=-π/2-ish, origin=0",
    Math.abs(atan2T(1, 1) - PI / 4) < 1e-15 && atan2T(0, -1) === PI
    && Math.abs(atan2T(-1, 0) + PI / 2) < 1e-15 && atan2T(0, 0) === 0);
  let pyth = 0;
  for (let i = 1; i < 1000; i++) {
    const x = i * 0.618;
    const s = sinT(x), c = cosT(x);
    pyth = Math.max(pyth, Math.abs(s * s + c * c - 1));
  }
  check("sin²+cos² = 1 within 2 ulp", pyth <= 4.5e-16, `worst ${pyth.toExponential(2)}`);
}

// ---- 3. the cross-engine sweep ---------------------------------------------
// One deterministic sweep (an LCG over the full working domain), outputs
// packed as raw float64 bytes, digested. The SAME module file runs under
// each engine on this machine; a differing digest is a nonconforming engine
// (or a broken kernel) and fails loudly.
console.log("\ncross-engine identity (the covenant itself):");

const SWEEP = `
  const out = new Float64Array(48000);
  let seed = 0x9e3779b9 >>> 0;
  const next = () => { // LCG — integer ops, deterministic
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  let j = 0;
  for (let i = 0; i < 12000; i++) {
    const u = next();
    out[j++] = sinT((u - 0.5) * 2e6);
    out[j++] = cosT((next() - 0.5) * 2e6);
    out[j++] = atan2T((next() - 0.5) * 100, (next() - 0.5) * 100);
    out[j++] = expT((next() - 0.5) * 1400);
  }
  const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(out.buffer));
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
`;

const simmathPath = join(ROOT, "shared", "simmath.js").replaceAll("\\", "/");
const runner = `
  import { sinT, cosT, atan2T, expT } from ${JSON.stringify("file://" + simmathPath)};
  ${SWEEP}
  console.log(hex);
`;
const dir = mkdtempSync(join(tmpdir(), "simmath-"));
const runnerPath = join(dir, "sweep.mjs");
writeFileSync(runnerPath, runner);

async function digestUnder(cmd: string[]): Promise<string | null> {
  try {
    const p = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
    const out = (await new Response(p.stdout).text()).trim();
    return /^[0-9a-f]{64}$/.test(out) ? out : null;
  } catch { return null; }
}

const bunHex = await digestUnder([process.execPath, runnerPath]);
check("Bun (JSC) computes the sweep", !!bunHex, bunHex ?? "no digest");
check("...and it matches the committed GOLDEN digest — the coefficients are the version",
  bunHex === GOLDEN, `got ${bunHex}\n     want ${GOLDEN}`);

const engines: [string, string[]][] = [];
if (Bun.which("node")) engines.push(["node (V8)", ["node", runnerPath]]);
if (Bun.which("deno")) engines.push(["deno (V8)", ["deno", "run", "--allow-read", runnerPath]]);
if (!engines.length) check("a second engine exists for the cross-engine leg", false, "install node or deno");
for (const [name, cmd] of engines) {
  const hex = await digestUnder(cmd);
  check(`${name} agrees BIT FOR BIT`, hex === bunHex, hex ? `got ${hex}` : "engine failed to run the sweep");
}

console.log(`\n${bold(tally.failed ? "RED" : "GREEN")} — ${tally.passed} passed, ${tally.failed} failed\n`);
process.exit(tally.failed ? 1 : 0);
