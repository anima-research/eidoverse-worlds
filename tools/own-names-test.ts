// tools/own-names-test.ts — a bone or contact-point name is read as an OWN key only: the names every object inherits
// (constructor, __proto__, toString, valueOf) are never a bone, a point, or a name "already set" (#297).
//   BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun tools/own-names-test.ts
// @ts-nocheck
import { canonicalBone, validatePose, validateTracks, mergePose, puppetPose } from "../shared/humanoid.js";
import { canonicalPoint } from "../shared/contact.js";
import { canonicalLimb } from "../shared/reachwire.js";

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail: unknown = "") => { if (ok) pass++; else fail++; console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : `  ${JSON.stringify(detail)}`}`); };
const q = [0, 0, 0, 1];
const INHERITED = ["constructor", "__proto__", "toString", "valueOf", "hasOwnProperty"];

for (const n of INHERITED) check(`canonicalBone(${n}) is null`, canonicalBone(n) === null, String(canonicalBone(n)));
check("canonicalBone still folds a real bone and an alias", canonicalBone("Head") === "head" && canonicalBone("left_elbow") === "leftLowerArm");
for (const n of INHERITED) check(`canonicalPoint(${n}) is null`, canonicalPoint(n) === null, canonicalPoint(n));
for (const n of ["left constructor", "right_toString"]) check(`canonicalPoint(${n}) is null`, canonicalPoint(n) === null, canonicalPoint(n));
check("canonicalPoint still resolves a real point", canonicalPoint("nape") === "neck_back" && canonicalPoint("neck back") === "neck_back");
for (const n of INHERITED) check(`canonicalLimb(${n}) is null`, canonicalLimb(n) === null, String(canonicalLimb(n)));
check("canonicalLimb still folds a real limb", canonicalLimb("left hand") === "leftHand");

// no rig: an unknown name is kept under its written name, so an inherited one must be kept the same way, not clash with Object.prototype
const v1 = validatePose({ constructor: q });
check("validatePose keeps constructor as a written custom bone", JSON.stringify(v1.accepted) === '["constructor"]' && Object.hasOwn(v1.pose, "constructor") && Object.keys(v1.pose).length === 1, { accepted: v1.accepted.map(String), keys: Object.keys(v1.pose) });
for (const n of ["toString", "valueOf"]) {
  const v = validatePose({ [n]: q });
  check(`validatePose accepts ${n} (no clash with an inherited name)`, v.rejected.length === 0 && v.accepted[0] === n, v.rejected);
  const r = validatePose(JSON.parse(`{"${n}": null}`));
  check(`validatePose releases ${n}`, r.rejected.length === 0 && r.released[0] === n, r.rejected);
}
const vr = validatePose(JSON.parse('{"__proto__": null}'));
check("validatePose releases __proto__ as an own key, not the pose's prototype", Object.getPrototypeOf(vr.pose) === Object.prototype && Object.hasOwn(vr.pose, "__proto__") && vr.released[0] === "__proto__", { keys: Object.keys(vr.pose), released: vr.released });
// a rig: a node literally named constructor is a real custom bone of that rig, and a mapped node still maps
const rig = { bones: ["constructor", "Hips_jnt"], humanoidOf: { Hips_jnt: "hips" } };
const vg = validatePose({ constructor: q, Hips_jnt: q }, { rig });
check("validatePose with a rig keeps its node named constructor as a custom bone", vg.rejected.length === 0 && Object.hasOwn(vg.pose, "constructor") && Object.hasOwn(vg.pose, "hips") && Object.keys(vg.pose).length === 2, { rejected: vg.rejected, absent: vg.absent?.map(String), keys: Object.keys(vg.pose) });
const vp = validatePose(JSON.parse('{"__proto__": [0, 0, 0, 1]}'));
check("validatePose keeps __proto__ as an own key, not the pose's prototype", Object.getPrototypeOf(vp.pose) === Object.prototype && Object.hasOwn(vp.pose, "__proto__") && vp.accepted[0] === "__proto__", { keys: Object.keys(vp.pose), accepted: vp.accepted });
const vt = validateTracks({ toString: [{ t: 0, q }], head: [{ t: 0, q }] });
check("validateTracks refuses toString as not a bone, keeps head", Object.keys(vt.tracks).join() === "head" && vt.rejected[0]?.name === "toString", vt);

const delta = JSON.parse('{"__proto__": [0, 0, 0, 1]}');
const merged = mergePose({ head: q }, delta);
check("mergePose keeps __proto__ as a key and the prototype plain", Object.getPrototypeOf(merged) === Object.prototype && Object.keys(merged).sort().join() === "__proto__,head", { keys: Object.keys(merged ?? {}) });
check("mergePose(null, {__proto__}) holds it", mergePose(null, delta) !== null && Object.hasOwn(mergePose(null, delta), "__proto__"));
const rep = puppetPose(delta, true);
check("puppetPose replace with only __proto__ is not a release-all", Object.keys(rep.pose).length === 1, rep);
check("mergePose still releases a null bone", mergePose({ head: q, neck: q }, { head: null })?.head === undefined);

console.log(`${fail ? "FAIL" : "ok"} own-names: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
