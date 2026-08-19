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
// DERIVATION OF DELTA (live measurement, staging, calibrated reader = lowest
// skinned vertex whose dominant bone is `hips`):
//   claude:     contact 0.25492, seated hips 0.45598 → scale 0.8697 → Δ 0.2931
//   local body: contact 0.25015, seated hips 0.45362 → scale 0.8652 → Δ 0.2891
// Two independent rigs agreeing to 1.4% is the evidence that ONE shift serves
// the roster. Midpoint taken; residual under 2 mm on both.
//
// Re-derive Δ (do not guess it) if the clip is ever re-exported upstream, or if
// a body shows a visible gap: measure contact and seated hips for that body,
// Δ = contact / (hips / 0.5247).
//
// POST-BAKE MEASUREMENT (same instrument, same chairs, staging):
//   path A (local, X-sit)  pelvis −0.00323  hips +0.20177   (was +0.25015 / +0.45362)
//   path B (local, socket) pelvis −0.00117  hips +0.20207   (was +0.24794 / +0.45317)
//   remote claude.vrm      pelvis −0.00279  hips +0.20131   (was +0.25492 / +0.45598)
// Rig-to-rig spread 2.0 mm — the evidence that ONE shift serves different rigs,
// which is why this file exists instead of a per-avatar profile system.
//
// Both rigs land ~2.4 mm LOW, so the exactly-centred Δ would be ≈0.2883 rather
// than 0.2911. Deliberately NOT applied: 2.4 mm is invisible (the avatars' own
// standing feet-to-root bias is 44 mm), and re-baking would invalidate the
// hashes below and demand another full measurement pass to stay honest. If this
// file is ever re-baked for another reason, fold 0.2883 in then.
//
// USAGE
//   bun tools/bake-seat-clip.ts            # write the patched file
//   bun tools/bake-seat-clip.ts --check    # verify the committed file matches
//
// The source is read from the PRISTINE eidoverse-video checkout — that tree is
// never patched in place (upstream-patched/README.md).

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";

const DELTA = 0.2911;

// The exact upstream bytes this delta was derived against. If the source no
// longer hashes to this, the derivation above was measured on a DIFFERENT clip
// and Δ must be re-measured rather than reapplied — a silent re-export is
// precisely how a hand-tuned constant goes quietly wrong.
const EXPECT_SRC = "c5f1828ffb222875f1ef1201189f032d22984ece24cc12122e7e450977dcb3e1";
const EXPECT_OUT = "5527a10b3edd6ed096325c70c22b050e15428e6ed5e2ae74818d79fc992a0c59";

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
if (outSha !== EXPECT_OUT) console.warn(`  WARNING: output differs from the recorded hash ${EXPECT_OUT.slice(0, 16)}`);
