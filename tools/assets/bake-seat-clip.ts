// bake-seat-clip: regenerate the checkout's patched/…/sitting_normal_chair.vrma (config.ts PATCH_DIR's default, served
// first; a server with PATCH_DIR set elsewhere serves that copy instead), lowered onto the seat.
// The stock clip is floor-origin but seats put the root on the surface, so the hips track is lowered by Δ ≈ 0.409
// (createVRMAnimationClip rescales it per rig). How Δ is derived: docs/research/seat-clip-delta.md.
// USAGE
//   bun tools/assets/bake-seat-clip.ts               # write the patched file
//   bun tools/assets/bake-seat-clip.ts --check       # verify the committed file matches
//   bun tools/assets/bake-seat-clip.ts --delta=0.42  # a calibration round (hash not claimed)
// The source is read from the PRISTINE eidoverse-video checkout, never patched in place.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";

// `--delta=<n>` writes the file for a calibration round but does NOT claim the recorded hash
const deltaArg = process.argv.find((a) => a.startsWith("--delta="));
const DELTA = deltaArg ? Number(deltaArg.slice("--delta=".length)) : 0.409;
if (!Number.isFinite(DELTA)) { console.error(`bad --delta`); process.exit(1); }

// the exact upstream bytes Δ was derived against: if the source hash differs, re-measure Δ, don't reapply it
const EXPECT_SRC = "c5f1828ffb222875f1ef1201189f032d22984ece24cc12122e7e450977dcb3e1";
const EXPECT_OUT = "ea31ca53057f3302b6103f323dbcf47c0220d2a9742039ae150c45674ca47456";

const REL = "eidoverse/assets/animations/sitting_normal_chair.vrma";
const ROOT = join(import.meta.dir, "..", "..");
const LIB = process.env.EIDOVERSE_DIR ?? join(ROOT, "..", "eidoverse-video");
const SRC = join(LIB, REL);
const OUT = join(ROOT, "patched", REL);

const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

function bake(src: Uint8Array): Uint8Array {
  const buf = new Uint8Array(src);  // copy: never mutate the pristine bytes
  const dv = new DataView(buf.buffer);
  const jsonLen = dv.getUint32(12, true);
  const json = JSON.parse(new TextDecoder().decode(buf.subarray(20, 20 + jsonLen)));
  const binStart = 20 + jsonLen + 8;

  const anim = json.animations[0];
  const chans = anim.channels.filter((c: any) => c.target.path === "translation");
  // the hips track is the ONLY translation in a VRMA; more than one means the shape changed and this edit is undefined
  if (chans.length !== 1) throw new Error(`expected 1 translation channel, found ${chans.length}`);
  const acc = json.accessors[anim.samplers[chans[0].sampler].output];
  if (acc.componentType !== 5126 || acc.type !== "VEC3") throw new Error("hips track is not float VEC3");
  if (acc.min || acc.max) throw new Error("accessor carries min/max — bounds would need updating too");
  const shared = anim.samplers.filter((s: any) => s.output === anim.samplers[chans[0].sampler].output);
  if (shared.length !== 1) throw new Error("output accessor is shared — an in-place edit would leak");

  const bv = json.bufferViews[acc.bufferView];
  const base = binStart + (bv.byteOffset ?? 0) + (acc.byteOffset ?? 0);
  for (let i = 0; i < acc.count; i++) {
    const off = base + i * 12 + 4;           // +4 = the Y lane of each VEC3
    dv.setFloat32(off, dv.getFloat32(off, true) - DELTA, true);
  }
  return buf;                                 // same length: JSON chunk untouched
}

if (!existsSync(SRC)) {
  console.error(`pristine source not found: ${SRC}\nset EIDOVERSE_DIR to the eidoverse-video checkout`);
  process.exit(1);
}
const src = readFileSync(SRC);
const srcSha = sha(src);
if (srcSha !== EXPECT_SRC) {
  console.error(`upstream clip changed:\n  expected ${EXPECT_SRC}\n  found    ${srcSha}\nRe-measure Δ against the new bytes; do not reapply the old one.`);
  process.exit(1);
}

const out = bake(src);
const outSha = sha(out);

if (process.argv.includes("--check")) {
  const have = existsSync(OUT) ? sha(readFileSync(OUT)) : "(absent)";
  const ok = have === outSha && outSha === EXPECT_OUT;
  console.log(`${ok ? "OK" : "MISMATCH"}  committed=${have.slice(0, 16)} rebuilt=${outSha.slice(0, 16)} expected=${EXPECT_OUT.slice(0, 16)}`);
  process.exit(ok ? 0 : 1);
}

writeFileSync(OUT, out);
console.log(`baked Δ=${DELTA} → ${OUT}`);
console.log(`  src ${srcSha.slice(0, 16)}  out ${outSha.slice(0, 16)}  ${out.length} bytes (unchanged length)`);
if (deltaArg) console.warn(`  calibration bake (delta overridden) — recorded hash NOT claimed; settle the value, then fold it into DELTA and update EXPECT_OUT`);
else if (outSha !== EXPECT_OUT) console.warn(`  WARNING: output differs from the recorded hash ${EXPECT_OUT.slice(0, 16)}`);
