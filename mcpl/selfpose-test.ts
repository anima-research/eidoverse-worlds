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
  canonicalBone, suggestBone, validatePose, validateTracks, tracksSpan, poseReport, poseChannels, mergePose,
} from "../shared/humanoid.js";
import { WorldAgent } from "./agent.ts";
import { rigFromGltf } from "./rigbones.ts";

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

console.log("\npose channels (the {q, t, s} value form)");
{
  const c = poseChannels([0, 0, 0, 1]);
  check("a bare quaternion is still a pose value", !!c && c.q?.[3] === 1 && c.t === null && c.s === null);
  const h = poseChannels({ t: [0, -0.3, 0] });
  check("translation alone is enough", !!h && h.q === null && h.t?.[1] === -0.3);
  const u = poseChannels({ q: [0, 0, 0, 1], s: 1.3 });
  check("a number scale means uniform", JSON.stringify(u?.s) === "[1.3,1.3,1.3]");
  check("non-uniform scale passes through", JSON.stringify(poseChannels({ s: [1, 1.5, 1] })?.s) === "[1,1.5,1]");
  check("a malformed channel is dropped, the good ones kept",
    (() => { const m = poseChannels({ q: [0, 0, 1], t: [0, 1, 0] }); return m?.q === null && m?.t?.[1] === 1; })());
  check("nothing usable is null", poseChannels({ q: [0, 0] }) === null && poseChannels("head") === null && poseChannels(null) === null);
  check("a non-finite component is not usable", poseChannels({ t: [0, NaN, 0] }) === null);
}

console.log("\nposes over any bone (rig-checked)");
{
  // A mythos-shaped rig: Armature > Root > Hip > {Pelvis > L_Thigh, Waist > Spine01 > L_Clavicle > L_Wing_Upper}
  const names = ["Armature", "Root", "Hip", "Pelvis", "L_Thigh", "Waist", "Spine01", "L_Clavicle", "L_Wing_Upper", "Head"];
  const kids: Record<string, string[]> = { Armature: ["Root"], Root: ["Hip"], Hip: ["Pelvis", "Waist"], Pelvis: ["L_Thigh"],
    Waist: ["Spine01"], Spine01: ["L_Clavicle", "Head"], L_Clavicle: ["L_Wing_Upper"] };
  const g = {
    nodes: names.map((n) => ({ name: n, children: (kids[n] ?? []).map((c) => names.indexOf(c)) })),
    skins: [{ joints: names.slice(1).map((n) => names.indexOf(n)) }],
    extensions: { VRMC_vrm: { humanoid: { humanBones: {
      hips: { node: 2 }, leftUpperLeg: { node: 4 }, spine: { node: 5 }, chest: { node: 6 }, leftShoulder: { node: 7 }, head: { node: 9 } } } } },
  };
  const rig = rigFromGltf(g)!;
  check("the rig reader finds every joint", rig.bones.length === 9 && rig.bones.includes("L_Wing_Upper"), JSON.stringify(rig.bones));
  check("...maps raw humanoid bones to VRM names", rig.humanoidOf.Hip === "hips" && rig.humanoidOf.L_Thigh === "leftUpperLeg");
  check("...and knows what sits above the hips", JSON.stringify(rig.aboveHips) === JSON.stringify(["Root", "Armature"]));

  const v = validatePose({ L_Wing_Upper: [0, 0, 0.38, 0.92], hips: { t: [0, -0.5, 0] }, head: { q: [0, 0, 0, 1], s: 1.2 } }, { rig });
  check("a wing, a hips move and a scaled head are all accepted", v.accepted.length === 3 && !v.rejected.length, poseReport(v));
  check("the wing is reported as beyond the humanoid set", JSON.stringify(v.custom) === '["L_Wing_Upper"]');
  check("a value with only q stays a bare array", Array.isArray(v.pose.L_Wing_Upper));
  check("t keeps the object form", JSON.stringify(v.pose.hips) === '{"t":[0,-0.5,0]}', JSON.stringify(v.pose.hips));

  const pel = validatePose({ Pelvis: [0.1, 0, 0, 0.995] }, { rig });
  check("an exact rig bone outranks a synonym: Pelvis stays Pelvis, not hips",
    "Pelvis" in pel.pose && !("hips" in pel.pose) && !pel.renamed.length, JSON.stringify(pel.pose));
  const rawh = validatePose({ L_Thigh: [0, 0, 0, 1] }, { rig });
  check("a raw humanoid name reads as its VRM name", "leftUpperLeg" in rawh.pose && rawh.renamed[0]?.to === "leftUpperLeg");
  const root = validatePose({ Root: { t: [0, -0.3, 0] } }, { rig });
  check("a bone above the hips is refused, and told to move hips", !root.accepted.length && /move hips/.test(root.rejected[0]?.why ?? ""));
  const typo = validatePose({ L_Wing_Uper: [0, 0, 0, 1] }, { rig });
  check("a typo of a rig bone is rejected with the real name", !typo.accepted.length && typo.rejected[0]?.suggest === "L_Wing_Upper");
  const absent = validatePose({ tail_1: [0, 0, 0, 1] }, { rig });
  check("a bone this rig does not have is rejected", !absent.accepted.length && /not a bone of this rig/.test(absent.rejected[0]?.why ?? ""));
  const blind = validatePose({ L_Wing_Upper: [0, 0, 0, 1] });
  check("with no rig to check, a non-humanoid name is kept but said to be unchecked",
    blind.accepted.length === 1 && /could not check L_Wing_Upper/.test(poseReport(blind)));
  check("...while a near-miss of a humanoid bone is still a typo", !validatePose({ spien: [0, 0, 0, 1] }).accepted.length);
  check("zero scale is refused", /above 0/.test(validatePose({ head: { s: 0 } }, { rig }).rejected[0]?.why ?? ""));
  check("an unknown channel is named", /unknown channel "r"/.test(validatePose({ head: { r: [0, 0, 0, 1] } }, { rig }).rejected[0]?.why ?? ""));
  check("a bad q inside the object says which channel", /^q: /.test(validatePose({ head: { q: [0, 0, 1] } }, { rig }).rejected[0]?.why ?? ""));
}

console.log("\nmerge and release");
{
  const kneel = { hips: { t: [0, -0.58, 0] }, leftLowerLeg: [0.7, 0, 0, 0.7] };
  const m = mergePose(kneel, { leftUpperArm: [0, 0, 0.38, 0.92] })!;
  check("merging an arm keeps the kneel", !!m.hips && !!m.leftLowerLeg && !!m.leftUpperArm);
  check("...without touching the pose it merged into", !("leftUpperArm" in kneel));
  const r = mergePose(m, { leftLowerLeg: null })!;
  check("a null releases just that bone", !("leftLowerLeg" in r) && !!r.hips && !!r.leftUpperArm);
  check("a bone given again is replaced whole, not blended", JSON.stringify(mergePose(kneel, { hips: [0, 0, 0, 1] })!.hips) === "[0,0,0,1]");
  check("releasing the last bone leaves nothing held", mergePose({ head: [0, 0, 0, 1] }, { head: null }) === null);
  check("merging into nothing is just the delta", JSON.stringify(mergePose(null, { head: [0, 0, 0, 1] })) === '{"head":[0,0,0,1]}');
  const v = validatePose({ leftUpperArm: null, forearm_left: null });
  check("the validator takes null as a release", v.released.includes("leftUpperArm") && v.pose.leftUpperArm === null);
  const t = validatePose({ spien: null });
  check("...and still catches a typo in one", !t.released.length && t.rejected[0]?.suggest === "spine");
}

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

console.log(failures ? `\n\x1b[31m${failures} failed\x1b[0m\n` : "\n\x1b[32mall passed\x1b[0m\n");
process.exit(failures ? 1 : 0);
