// bake-seat-clip — regenerate upstream-patched/…/sitting_normal_chair.vrma.
//
// WHY THIS EXISTS
//
// `sitting_normal_chair.vrma` is authored FLOOR-ORIGIN: its hips translation
// track sits at y≈0.5247 (track units), i.e. the height of a seated pelvis
// above the FLOOR the chair stands on. Every seat path in this engine instead
// places the avatar root ON THE SEAT SURFACE — `mountTransform` puts the root
// at the socket, and `controller.toggleSit` puts it at `findSeat`'s surface.
// Root-at-surface + floor-origin clip = the body hovers above the seat by the
// clip's implied seat height. Measured live on staging before this patch:
// pelvis underside 0.250 m above the surface, hips 0.454 m (≈1.5 ft — which is
// what a viewer actually reads as "sitting in the air").
//
// The two ground clips do NOT have this bug (`sitting_on_ground` hips y=0.0975,
// `sit_laying_on_ground` 0.1138 — authored root-at-contact), which is the
// control that localizes the fault to this one file rather than to the engine's
// placement convention.
//
// WHY IN THE CLIP AND NOT IN CODE
//
// `createVRMAnimationClip` multiplies the hips translation by
//   scale = avatarRestHipsY / animationRestHipsY   (animationRestHipsY = 0.963756)
// so a shift baked here is applied to each rig IN PROPORTION TO THAT RIG'S OWN
// hip height — one number, correctly scaled per body, with no per-avatar
// profile, store, or gate. It also leaves the avatar ROOT where it is: nothing
// downstream (collision, the every-frame `resolveColliders` snap in
// controller.updateMe, network position, camera) changes meaning. Lowering the
// root instead — the #101 approach — fights the collider snap.
//
// `restHipsPosition` is read from the VRMA's REST SCENE GRAPH, not from the
// track (VRMAnimationLoaderPlugin: `hips.getWorldPosition(restHipsPosition)`),
// so editing sampler output values leaves `scale` untouched. That is the whole
// reason this edit is safe.
//
// DERIVATION OF DELTA — and the wrong turn worth recording
//
// First attempt took Δ from a "contact" reader: the lowest skinned vertex whose
// dominant bone is `hips`. That gave 0.2911, and re-measuring with the SAME
// reader then reported the pelvis landing within 3 mm of the seat on three
// bodies. It was wrong. The reader locks onto a vertex hanging below the
// visible seated mass, so it read contact while the body a viewer sees was
// still ~0.2 m in the air — the derivation and its verification shared one
// error and confirmed each other perfectly. The operator, looking at the
// screen, reported the offset unchanged in kind and merely smaller.
//
// What the operator's eye actually tracked, both times, was HIPS-above-seat:
//   before any fix   they said "1.5–2 ft"   hips sat 0.454 m  (= 1.49 ft)
//   after Δ=0.2911   they said "~8 inches"  hips sat 0.202 m  (= 7.95 in)
// Two estimates, two matches, against a reader that claimed contact throughout.
//
// So Δ is set from where a seated pelvis BELONGS, anchored twice:
//  - `sitting_on_ground.vrma` is authored root-at-contact and looks right; its
//    hips sit 0.0975 track units (~0.085 m) above the surface the body rests on;
//  - inverting the stock clip, hips-at-0.10 m puts its authored seat plane
//    0.354 m above its floor, which scales to ~0.42 m on a 1.75 m human — a
//    normal chair.
// Both give Δ ≈ 0.409, pelvis ~0.10 m above the seat. Confirmed by eye on prod.
//
// The lesson, since it cost a day: a landmark definition is part of the
// instrument. Calibration (displacement tests, frame checks, standing
// baselines) proved the frame was sound and said nothing about whether the
// point being measured was the right point. When a measurement and a human
// looking at the thing disagree, the measurement is the hypothesis.
//
// Re-derive (do not guess) if the clip is re-exported upstream: put a body in
// the pose, find the lowest point of the mass that should rest — buttocks and
// thigh undersides, not a single minimum vertex — and Δ = that height / 0.865.
//
// USAGE
//   bun tools/bake-seat-clip.ts               # write the patched file
//   bun tools/bake-seat-clip.ts --check       # verify the committed file matches
//   bun tools/bake-seat-clip.ts --delta=0.42  # a calibration round (hash not claimed)
//
// The source is read from the PRISTINE eidoverse-video checkout — that tree is
// never patched in place (upstream-patched/README.md).

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";

// `--delta=<n>` overrides for a calibration round (the eye is the instrument
// that has been right about this clip; see the note below). An overridden
// delta writes the file but does NOT claim the recorded hash.
const deltaArg = process.argv.find((a) => a.startsWith("--delta="));
const DELTA = deltaArg ? Number(deltaArg.slice("--delta=".length)) : 0.409;
if (!Number.isFinite(DELTA)) { console.error(`bad --delta`); process.exit(1); }

// The exact upstream bytes this delta was derived against. If the source no
// longer hashes to this, the derivation above was measured on a DIFFERENT clip
// and Δ must be re-measured rather than reapplied — a silent re-export is
// precisely how a hand-tuned constant goes quietly wrong.
const EXPECT_SRC = "c5f1828ffb222875f1ef1201189f032d22984ece24cc12122e7e450977dcb3e1";
const EXPECT_OUT = "ea31ca53057f3302b6103f323dbcf47c0220d2a9742039ae150c45674ca47456";

const REL = "eidoverse/assets/animations/sitting_normal_chair.vrma";
const ROOT = join(import.meta.dir, "..");
const LIB = process.env.EIDOVERSE_DIR ?? join(ROOT, "..", "eidoverse-video");
const SRC = join(LIB, REL);
const OUT = join(ROOT, "upstream-patched", REL);

const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

function bake(src: Uint8Array): Uint8Array {
  const buf = new Uint8Array(src);           // copy — never mutate the pristine bytes
  const dv = new DataView(buf.buffer);
  const jsonLen = dv.getUint32(12, true);
  const json = JSON.parse(new TextDecoder().decode(buf.subarray(20, 20 + jsonLen)));
  const binStart = 20 + jsonLen + 8;

  const anim = json.animations[0];
  const chans = anim.channels.filter((c: any) => c.target.path === "translation");
  // The humanoid hips track is the ONLY translation in a VRMA; more than one
  // means the file's shape changed and this edit is no longer well-defined.
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
