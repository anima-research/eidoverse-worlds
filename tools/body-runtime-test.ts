// bun tools/body-runtime-test.ts — a body that brings its own runtime (§24 avatar defs: `runtime`): the def contract
// (shared/avatardefs.js), the frame order the avatar runs it in (client/lib/bodyruntime_core.js), and — when a library
// is at hand (EIDOVERSE_DIR) — that the module claude_robot's def names exports what that order calls.
// BODY_RUNTIME_TEETH=1 checks the order against a scrambled expectation: it must FAIL, or the order check proves nothing.
import { readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { validateAvatarDef, validateBodyRuntime } from "../shared/avatardefs.js";
import { makeBodyRuntime, writeAll, defForBody } from "../client/lib/bodyruntime_core.js";
import { bodyRuntimeFor } from "../client/lib/bodyruntime.js";
let pass = 0, fail = 0;
const check = (n: string, ok: boolean, d: unknown = "") => { ok ? pass++ : fail++; console.log(`  ${ok ? "\x1b[32m✓" : "\x1b[31m✗"}\x1b[0m ${n}${ok ? "" : `  ${JSON.stringify(d)}`}`); };
const ROOT = join(import.meta.dir, "..");
const BODY_SHA: Record<string, string> = {
  claude_robot: "fbeaa3b4162b4fd6d893b13e4172a9a9e8e78eb964e4ae4a3373c1a5bb2ca2f0",
  claude_robot_2k: "e04e19c594ee55d3017360e21bf499c9f56ed13a1deb17cc04e9acf881696ef4",
};

// 1. the defs: both robot defs serve; the runtime contract refuses what it should
for (const name of ["claude_robot", "claude_robot_2k"]) {
  const def = JSON.parse(readFileSync(join(ROOT, "defs", "avatars", `${name}.json`), "utf8"));
  check(`defs/avatars/${name}.json validates`, validateAvatarDef(name, def).length === 0, validateAvatarDef(name, def));
  check(`${name} carries exact maker/runtime provenance`, def.provenance?.assetRepo === "SkyeShark/eidoverse-video"
    && def.provenance?.assetCommit === "0e8716fd1ba15dbc23369dd7c84a2053754bb0e2"
    && def.provenance?.vrmSha256 === BODY_SHA[name]
    && def.provenance?.runtimeSourceSha256 === "1b5f7c3588444eebc9c88477bfc76d1a730e0949ecb8e827b0f88647747943cc"
    && def.provenance?.jointsSourceSha256 === "356a2ae9c343281c78fd0b0b15779dc3419312fa03780a815187d47dbc437cf5", def.provenance);
}
const good = { kind: "claude-robot-dof" };
check("a built-in runtime with no skip list validates", validateBodyRuntime(good).length === 0);
for (const [why, rt] of [
  ["not an object", "claude-robot-dof"], ["an unknown kind", { kind: "anything" }], ["no kind", {}],
  ["an executable module path", { ...good, module: "eidoverse/claude_robot_dof.js" }],
  ["a joints path", { ...good, joints: "eidoverse/assets/vrms/claude_robot.joints.json" }],
  ["an encoded path", { ...good, module: "eidoverse/%2e%2e/x.js" }],
] as const) check(`refuses a runtime: ${why}`, validateBodyRuntime(rt).length > 0);
check("the def refuses a bad runtime too", validateAvatarDef("x", { runtime: { kind: "anything" } }).length > 0);

// 2. the frame order, against a module that records what it's asked
const calls: string[] = [];
const rec = (name: string) => (...a: unknown[]) => { calls.push(name); };
const mod: Record<string, unknown> = Object.fromEntries(["initArmDOF", "setupHandDOF", "setupLegDOF", "setupCrown", "keepArmPose",
  "rehomeBody", "applyHardwareDOF", "applyLegClearance", "applyArmDOF", "applyHandDOF", "applyHeadExpression", "applyCrown"]
  .map((n) => [n, rec(n)]));
mod.LEG_JOINTS = [{ bone: "leftLowerLeg" }];
const set: { off: number }[] = [];
const binding = (v: number) => ({ buffer: new Float64Array(16), valueSize: v, binding: { setValue: (_b: unknown, off: number) => set.push({ off }) } });
const mixer = { _bindings: [binding(4), binding(3), binding(4)], _nActiveBindings: 2, _accuIndex: 1 };
const rt = makeBodyRuntime("claude-robot-dof", mod, { joints: { hinges: { leftLowerArm: {} } }, report: () => {} })!;
const vrm = {};
rt.init(vrm);
rt.afterMixer(vrm, mixer);
rt.beforeVrmUpdate(vrm, 1 / 60);
const WANT = ["initArmDOF", "setupHandDOF", "setupLegDOF", "setupCrown", "keepArmPose", "rehomeBody", "applyHardwareDOF",
  "applyLegClearance", "applyArmDOF", "applyHandDOF", "applyHeadExpression", "applyCrown"];
const want = process.env.BODY_RUNTIME_TEETH ? [...WANT].reverse() : WANT;
check("init, after the mixer, before vrm.update: the module's documented order", JSON.stringify(calls) === JSON.stringify(want), calls);
check("writeAll writes the active bindings only, from the accumulator the update filled",
  set.length === 2 && set[0].off === 2 * 4 && set[1].off === 2 * 3, set);
calls.length = 0;
rt.init(vrm);
makeBodyRuntime("claude-robot-dof", mod, { report: () => {} })!.init(vrm);
check("a body is set up once, even worn again by a new runtime (a pooled body's skeleton isn't at rest)", calls.length === 0, calls);
check("no runtime for an unknown kind or no module", makeBodyRuntime("other", mod) === null && makeBodyRuntime("claude-robot-dof", null as any) === null);

// 3. a step that throws: reported once, skipped after, and the rest of the frame still runs
const reports: string[] = [];
let crowns = 0;
const bad = { ...mod, applyArmDOF: () => { throw new Error("boom"); }, applyCrown: () => { crowns++; } };
const rt2 = makeBodyRuntime("claude-robot-dof", bad, { report: (m: string) => reports.push(m) })!;
for (let i = 0; i < 3; i++) rt2.beforeVrmUpdate({}, 1 / 60);
check("a throwing step is reported once and skipped from then on", reports.length === 1 && rt2.dead.has("applyArmDOF"), reports);
check("...and the steps after it still run every frame", crowns === 3, crowns);
let wrote = 0;
writeAll({ _bindings: null } as any); writeAll(undefined as any);
check("writeAll with no bindings is a no-op", wrote === 0);

// 3b. a def's skip list: those steps never run
const calls2: string[] = [];
const mod2: Record<string, unknown> = Object.fromEntries(Object.keys(mod).filter((k) => k !== "LEG_JOINTS")
  .map((n) => [n, () => { calls2.push(n); }]));
mod2.LEG_JOINTS = mod.LEG_JOINTS;
const rt3 = makeBodyRuntime("claude-robot-dof", mod2, { skip: ["setupLegDOF", "applyHardwareDOF", "applyLegClearance"], report: () => {} })!;
rt3.init({}); rt3.beforeVrmUpdate({}, 1 / 60);
check("a skipped step never runs (the def's runtime.skip)", !calls2.some((c) => ["setupLegDOF", "applyHardwareDOF", "applyLegClearance"].includes(c))
  && calls2.includes("applyArmDOF"), calls2);
check("runtime.skip validates as step names", validateBodyRuntime({ ...good, skip: ["setupLegDOF"] }).length === 0
  && validateBodyRuntime({ ...good, skip: "setupLegDOF" }).length > 0 && validateBodyRuntime({ ...good, skip: ["../x"] }).length > 0);
check("lamps and emissiveMax validate", validateAvatarDef("x", { lamps: false, emissiveMax: 1 }).length === 0
  && validateAvatarDef("x", { lamps: "no" }).length > 0 && validateAvatarDef("x", { emissiveMax: -1 }).length > 0);

// 3c. limp: the constraints the module took over at init are handed back while limp, and taken again when it stands
const cHip = { destination: "leftHipPitch" }, cCalf = { destination: "leftCalf" };
const mgr = { constraints: new Set<any>([cHip, cCalf]), addConstraint(c: any) { this.constraints.add(c); }, deleteConstraint(c: any) { this.constraints.delete(c); } };
const vrmL = { nodeConstraintManager: mgr };
const modL = { ...mod, setupLegDOF: (v: any) => { v.nodeConstraintManager.deleteConstraint(cHip); } };
const rtL = makeBodyRuntime("claude-robot-dof", modL, { report: () => {} })!;
rtL.init(vrmL);
check("init: the module took the hip stage's constraint over", !mgr.constraints.has(cHip) && mgr.constraints.has(cCalf));
rtL.setLimp(vrmL, true);
check("limp: it is handed back (vrm.update drives the stage while the sim owns the bones)", mgr.constraints.has(cHip));
rtL.setLimp(vrmL, false);
check("standing again: taken again (the runtime solves it)", !mgr.constraints.has(cHip) && mgr.constraints.has(cCalf));

// 4. which def a body's library path belongs to
const avatars = { claude_robot: { tags: ["robot"] }, renamed: { vrm: "eidoverse/assets/vrms/other/robot.vrm" } };
check("by its file name, the roster's ?v= ignored", defForBody(avatars, "eidoverse/assets/vrms/claude_robot.vrm?v=123")?.name === "claude_robot");
check("a def declaring the vrm path wins", defForBody(avatars, "eidoverse/assets/vrms/other/robot.vrm?v=9")?.name === "renamed");
check("a body with no def has no runtime", defForBody(avatars, "eidoverse/assets/vrms/bee.vrm") === null && defForBody(null as any, "x.vrm") === null);

// 5. the reviewed built-in loader and exact vendored runtime
const loaded = await bodyRuntimeFor("eidoverse/assets/vrms/claude_robot.vrm", () => {},
  { name: "claude_robot", def: { runtime: good } });
const loaderSrc = readFileSync(join(ROOT, "client/lib/bodyruntime.js"), "utf8");
check("production has no query-string bypass for authored body constraints",
  !loaderSrc.includes("bodyruntime=0") && !loaderSrc.includes("bodyruntime-skip") && !loaderSrc.includes("searchParams.get(\"bodyruntime"));
check("the closed loader returns the reviewed runtime kind", loaded?.kind === good.kind);
const m = await import("../client/lib/bodyruntimes/claude_robot_dof.js");
const missing = WANT.filter((n) => typeof m[n] !== "function");
check("the built-in Claude runtime exports every step of the order", missing.length === 0, missing);
check("the built-in Claude runtime exports LEG_JOINTS", Array.isArray(m.LEG_JOINTS) && m.LEG_JOINTS.length > 0);
const j = await import("../client/lib/bodyruntimes/claude_robot_joints.js");
check("the built-in joints data has hinges", !!j.default?.hinges);

// 6. product-door ownership: the pure core is not enough if Avatar never calls it.
const avsrc = readFileSync(join(ROOT, "client/lib/avatar.js"), "utf8");
const at = (...needles: string[]) => needles.map((n) => avsrc.indexOf(n));
const [mix, after, reach, before, vu] = at("this.mixer.update(dt)", "this.bodyRuntime.afterMixer", "BC('av:reach')", "this.bodyRuntime.beforeVrmUpdate", "this.vrm.update(dt)");
check("Avatar runs the runtime after mixer and after reach, before vrm.update",
  mix >= 0 && mix < after && after < reach && reach < before && before < vu, { mix, after, reach, before, vu });
check("Avatar load initializes and installs the runtime",
  avsrc.includes("await bodyRuntimeFor(libPath") && avsrc.includes("bodyRuntime?.init(vrm)") && avsrc.includes("av.bodyRuntime = bodyRuntime"));
check("Avatar limp and disposal hand runtime ownership back",
  avsrc.includes("this.bodyRuntime?.setLimp?.(this.vrm, on)") && avsrc.includes("this.bodyRuntime?.dispose?.(this.vrm)"));

// 7. pool boundary: a body disposed while limp must not return with three-vrm
// and the body runtime both owning the same node constraint.
const rtL2 = makeBodyRuntime("claude-robot-dof", modL, { report: () => {} })!;
rtL.setLimp(vrmL, true);
rtL.dispose(vrmL);
rtL2.init(vrmL); // INITED path: reassert ownership instead of reading posed rest
check("dispose + pooled rewear retakes constraints from the limp owner", !mgr.constraints.has(cHip));

// 8. exact external body metadata, when the library is supplied.
const lib = process.env.EIDOVERSE_DIR;
if (lib) {
  for (const [name, sha] of Object.entries(BODY_SHA)) {
    const bytes = readFileSync(join(lib, "eidoverse/assets/vrms", `${name}.vrm`));
    check(`${name}.vrm has the reviewed content hash`, createHash("sha256").update(bytes).digest("hex") === sha);
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength); let off = 12, gltf: any = null;
    while (off < bytes.length) { const n = dv.getUint32(off, true), typ = bytes.toString("ascii", off + 4, off + 8); off += 8;
      if (typ === "JSON") gltf = JSON.parse(bytes.toString("utf8", off, off + n).trim()); off += n; }
    const meta = gltf?.extensions?.VRMC_vrm?.meta;
    check(`${name}.vrm carries coherent CC BY metadata`, meta?.licenseUrl === "https://creativecommons.org/licenses/by/4.0/"
      && meta?.creditNotation === "required" && meta?.authors?.includes("Claude (Opus 5.5)") && meta?.authors?.includes("SkyeShark")
      && meta?.allowExcessivelyViolentUsage === true && meta?.allowExcessivelySexualUsage === true
      && meta?.allowAntisocialOrHateUsage === true && meta?.allowPoliticalOrReligiousUsage === true, meta);
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
