/**
 * Self-pose test — the `pose`/`animate` authoring surface and the one rule
 * that decides whether a pose survives walking.
 *
 * Run: cd mcpl && bun run selfpose-test.ts
 *
 * No servers needed: shared/humanoid.js is pure, and WorldAgent's constructor
 * does not connect, so the walk-shed can be exercised on a bare body.
 *
 * Expected values are HAND-COMPUTED. The one normalization figure:
 *   |[0, 0, -0.9, 0.44]| = sqrt(0.81 + 0.1936) = sqrt(1.0036) = 1.00179838…
 *   z' = -0.9 / 1.00179838… = -0.89838436…
 */

import {
  HUMANOID_BONES, REQUIRED_BONES, FINGER_BONES,
  canonicalBone, suggestBone, validatePose, validateTracks, tracksSpan, poseReport,
} from "../shared/humanoid.js";
import { WorldAgent } from "./agent.ts";

let failures = 0;
const check = (label: string, ok: boolean, detail?: string) => {
  console.log(ok ? `  \x1b[32m✓\x1b[0m ${label}` : `  \x1b[31m✗ ${label}${detail ? ` — ${detail}` : ""}\x1b[0m`);
  if (!ok) failures++;
};
const near = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) < eps;

console.log("\nvocabulary");
check("55 humanoid bones", HUMANOID_BONES.length === 55, `got ${HUMANOID_BONES.length}`);
check("30 finger bones (5 fingers x 3 segments x 2 hands)", FINGER_BONES.length === 30, `got ${FINGER_BONES.length}`);
check("17 bones every rig must have", REQUIRED_BONES.length === 17, `got ${REQUIRED_BONES.length}`);
check("no duplicates", new Set(HUMANOID_BONES).size === HUMANOID_BONES.length);
check("thumb has a metacarpal, index does not",
  HUMANOID_BONES.includes("leftThumbMetacarpal") && !HUMANOID_BONES.includes("leftIndexMetacarpal"));

console.log("\nname resolution");
check("exact name passes through", canonicalBone("leftUpperArm") === "leftUpperArm");
check("case-insensitive", canonicalBone("LeftUpperArm") === "leftUpperArm");
check("separators ignored", canonicalBone("left_upper_arm") === "leftUpperArm");
check("cross-rig synonym: forearm -> lowerArm", canonicalBone("rightforearm") === "rightLowerArm");
check("cross-rig synonym: pelvis -> hips", canonicalBone("pelvis") === "hips");
check("a non-bone is not invented", canonicalBone("tail") === null);
check("a typo suggests the real bone", suggestBone("spien") === "spine", `got ${suggestBone("spien")}`);

console.log("\npose validation");
{
  const v = validatePose({ leftUpperArm: [0, 0, -0.9, 0.44] });
  const q = v.pose.leftUpperArm;
  check("accepted the one bone", v.accepted.length === 1 && !v.rejected.length);
  check("normalized to unit", near(Math.hypot(...q), 1));
  check("z' = -0.89838436 (hand-computed)", near(q[2], -0.89838436, 1e-7), `got ${q[2]}`);
  check("a barely-off-unit input is normalized SILENTLY", poseReport(v) === "", `said "${poseReport(v)}"`);
}
{
  const v = validatePose({ spien: [0, 0, 0, 1] });
  check("unknown bone is rejected, not kept", !v.accepted.length && v.rejected.length === 1);
  check("rejection carries a suggestion", v.rejected[0].suggest === "spine");
}
{
  const v = validatePose({ head: [0, 0, 0] });
  check("a 3-component quaternion is rejected", !v.accepted.length && /want 4/.test(v.rejected[0].why));
}
{
  const v = validatePose({ head: [0, 0, 0, 0] });
  check("a zero quaternion is rejected", !v.accepted.length && /zero length/.test(v.rejected[0].why));
}
{
  // Two written names folding onto one bone: FIRST wins, second is named.
  const v = validatePose({ LeftLowerArm: [0, 0, 0, 1], leftElbow: [0, 0, 0.3, 0.95] });
  check("collision keeps the first", v.pose.leftLowerArm?.[2] === 0, `got ${JSON.stringify(v.pose.leftLowerArm)}`);
  check("collision reports the second", v.rejected.length === 1 && /already set/.test(v.rejected[0].why));
  check("collision does not double-count accepted", v.accepted.length === 1);
}
{
  const v = validatePose({ jaw: [0, 0, 0, 1] }, { known: ["hips", "head"] });
  check("a valid bone this rig lacks is 'absent', not accepted", !v.accepted.length && v.absent[0] === "jaw");
  check("absence is reported in words", /no jaw/.test(poseReport(v)));
}
check("a clean pose reports nothing", poseReport(validatePose({ head: [0, 0, 0, 1] })) === "");

console.log("\ntrack validation");
{
  const v = validateTracks({ leftarm: [{ t: 1, q: [0, 0, 0, 1] }, { t: 0, q: [0, 0, 0.3, 0.95] }] });
  const k = v.tracks.leftUpperArm;
  check("alias resolved in tracks", !!k);
  check("keyframes sorted by t", k[0].t === 0 && k[1].t === 1);
  check("span is the last keyframe", tracksSpan(v.tracks) === 1);
}
{
  const v = validateTracks({ head: [] });
  check("an empty track is dropped with a reason", !v.accepted.length && /non-empty/.test(v.rejected[0].why));
}
{
  const v = validateTracks({ head: [{ t: 0, q: [0, 0, 0, 1] }, { t: -1, q: [0, 0, 0, 1] }] });
  check("a bad keyframe is dropped but the good ones survive",
    v.tracks.head?.length === 1 && v.rejected.length === 1 && /kept the 1/.test(v.rejected[0].why));
}

console.log("\nwalking and the held pose");
{
  const POSE = { leftUpperArm: [0, 0, -0.9, 0.44] };
  const mk = () => new WorldAgent({ name: "t", world: "w" });

  const a = mk();
  a.setPose({ ...POSE });
  a.walkTo(5, 5); a.stop();
  check("a plain pose is shed by walking (the standing contract)", a.heldPose === null);

  const b = mk();
  const held = { ...POSE };
  b.setPose(held, true);
  b.walkTo(5, 5); b.stop();
  check("a pose pinned with hold survives walking", b.heldPose === held);

  const c = mk();
  c.setPose({ ...POSE }, true);
  // A restore re-arms a pose marked AUTHORED — this is the #61 shape, and the
  // reason authorship alone cannot be the test. A different object must not
  // inherit the previous pose's stickiness.
  c.heldPose = { ...POSE }; c.heldPoseAuthored = true;
  c.walkTo(5, 5); c.stop();
  check("stickiness does not transfer to a restored/foreign pose (#61 guard)", c.heldPose === null);

  const d = mk();
  d.setPose({ ...POSE }, true);
  d.setPose(null);
  d.setPose({ ...POSE });
  d.walkTo(5, 5); d.stop();
  check("clearing then re-posing does not resurrect stickiness", d.heldPose === null);

  const e = mk();
  e.setPose({ ...POSE }, true);
  e.walkTo(5, 5); e.stop();
  e.walkTo(7, 7); e.stop();
  check("a held pose survives a SECOND walk too", e.heldPose !== null);
}

// ---------------------------------------------------------------- wings
//
// Janus: "can you make it so that wing bones are allowed in the pose tool's
// surface for agents, if they have wings? right now it gives a 'not a VRM
// humanoid bone' error."
//
// Wings are RAW bones -- VRM's humanoid vocabulary has no word for them -- so
// canonicalBone returned null and the verb refused. They are addressable
// because the RIG NAMES them, the same contract by which hair and wings reach
// the springbone and ragdoll systems.
{
  const WINGED = ['Hip', 'Spine02', 'Head',
    'L_Wing_Upper', 'L_Wing_Upper_1', 'L_Wing_Upper_2',
    'R_Wing_Upper', 'L_Wing_Lower', 'R_Wing_Lower'];

  const v = validatePose({ L_Wing_Upper: [0, 0, 0.26, 0.97] });
  check("a wing bone is accepted", v.accepted.includes('L_Wing_Upper'),
        JSON.stringify(v.rejected));
  check("...and keeps its exact name (no humanoid renaming)",
        v.pose.L_Wing_Upper !== undefined && !v.renamed.length);

  const deep = validatePose({ R_Wing_Lower_2: [0, 0, 0, 1] });
  check("outer segments too", deep.accepted.includes('R_Wing_Lower_2'));

  // CASE-SENSITIVE, unlike the humanoid names. Those are a vocabulary the
  // module owns and can spell forgivingly; a raw bone name is a fact about a
  // skeleton, and `l_wing_upper` is not a bone that exists -- accepting a
  // near-miss would resolve to nothing at the client and report success.
  const low = validatePose({ l_wing_upper: [0, 0, 0, 1] });
  check("a lowercase wing name is refused", !low.accepted.length);
  check("...and the refusal names the real spelling",
        /case-sensitive/.test(low.rejected[0]?.why ?? ''), low.rejected[0]?.why);

  // GATED ON THE BODY when the caller knows its bones.
  const rawKnown = new Set(WINGED);
  const ok = validatePose({ L_Wing_Upper: [0, 0, 0, 1] }, { rawKnown });
  check("a wing this body HAS is accepted", ok.accepted.length === 1);
  const no = validatePose({ L_Wing_Upper: [0, 0, 0, 1] },
                          { rawKnown: new Set(['Hip', 'Head']) });
  check("a wing this body LACKS is refused, not silently ignored",
        !no.accepted.length && /no bone by that name/.test(no.rejected[0]?.why ?? ''),
        JSON.stringify(no.rejected));

  // Humanoid names must not be gated by rawKnown -- the guarantee is VRM's.
  const hum = validatePose({ head: [0, 0, 0, 1] }, { rawKnown: new Set() });
  check("humanoid bones stay ungated", hum.accepted.includes('head'));

  // Mixed pose: a wing and an arm in one call.
  const mix = validatePose({ leftUpperArm: [0, 0, -0.9, 0.44],
                             L_Wing_Upper: [0, 0, 0.26, 0.97] }, { rawKnown });
  check("a pose can name a wing and an arm together", mix.accepted.length === 2);
}

console.log(failures ? `\n\x1b[31m${failures} failed\x1b[0m\n` : "\n\x1b[32mall passed\x1b[0m\n");
process.exit(failures ? 1 : 0);
