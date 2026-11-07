// bun tools/body-runtime-test.ts — a body that brings its own runtime (§24 avatar defs: `runtime`): the def contract
// (shared/avatardefs.js), the frame order the avatar runs it in (client/lib/bodyruntime_core.js), and — when a library
// is at hand (EIDOVERSE_DIR) — that the module claude_robot's def names exports what that order calls.
// BODY_RUNTIME_TEETH=1 checks the order against a scrambled expectation: it must FAIL, or the order check proves nothing.
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { validateAvatarDef, validateBodyRuntime } from "../shared/avatardefs.js";
import { makeBodyRuntime, writeAll, defForBody } from "../client/lib/bodyruntime_core.js";
let pass = 0, fail = 0;
const check = (n: string, ok: boolean, d: unknown = "") => { ok ? pass++ : fail++; console.log(`  ${ok ? "\x1b[32m✓" : "\x1b[31m✗"}\x1b[0m ${n}${ok ? "" : `  ${JSON.stringify(d)}`}`); };
const ROOT = join(import.meta.dir, "..");

// 1. the defs: both robot defs serve; the runtime contract refuses what it should
for (const name of ["claude_robot", "claude_robot_2k"]) {
  const def = JSON.parse(readFileSync(join(ROOT, "defs", "avatars", `${name}.json`), "utf8"));
  check(`defs/avatars/${name}.json validates`, validateAvatarDef(name, def).length === 0, validateAvatarDef(name, def));
}
const good = { kind: "eidoverse-dof", module: "eidoverse/claude_robot_dof.js", joints: "eidoverse/assets/vrms/claude_robot.joints.json" };
check("a runtime without joints is fine", validateBodyRuntime({ kind: good.kind, module: good.module }).length === 0);
for (const [why, rt] of [
  ["not an object", "eidoverse/claude_robot_dof.js"], ["an unknown kind", { ...good, kind: "anything" }], ["no kind", { module: good.module }],
  ["module climbs out", { ...good, module: "../secrets.js" }], ["module absolute", { ...good, module: "/etc/x.js" }],
  ["module a URL", { ...good, module: "https://evil.example/x.js" }], ["module not .js", { ...good, module: "eidoverse/x.ts" }],
  ["joints climbs out", { ...good, joints: "a/../../b.json" }], ["joints not .json", { ...good, joints: "eidoverse/x.js" }],
] as const) check(`refuses a runtime: ${why}`, validateBodyRuntime(rt).length > 0);
check("the def refuses a bad runtime too", validateAvatarDef("x", { runtime: { ...good, module: "../x.js" } }).length > 0);

// 2. the frame order, against a module that records what it's asked
const calls: string[] = [];
const rec = (name: string) => (...a: unknown[]) => { calls.push(name); };
const mod: Record<string, unknown> = Object.fromEntries(["initArmDOF", "initHandDOF", "initLegDOF", "initCrown", "keepArmPose",
  "rehomeBody", "applyHardwareDOF", "applyLegClearance", "applyArmDOF", "applyHandDOF", "applyHeadExpression", "applyCrown"]
  .map((n) => [n, rec(n)]));
mod.LEG_JOINTS = [{ bone: "leftLowerLeg" }];
const set: { off: number }[] = [];
const binding = (v: number) => ({ buffer: new Float64Array(16), valueSize: v, binding: { setValue: (_b: unknown, off: number) => set.push({ off }) } });
const mixer = { _bindings: [binding(4), binding(3), binding(4)], _nActiveBindings: 2, _accuIndex: 1 };
const rt = makeBodyRuntime("eidoverse-dof", mod, { joints: { hinges: { leftLowerArm: {} } }, report: () => {} })!;
const vrm = {};
rt.init(vrm);
rt.afterMixer(vrm, mixer);
rt.beforeVrmUpdate(vrm, 1 / 60);
const WANT = ["initArmDOF", "initHandDOF", "initLegDOF", "initCrown", "keepArmPose", "rehomeBody", "applyHardwareDOF",
  "applyLegClearance", "applyArmDOF", "applyHandDOF", "applyHeadExpression", "applyCrown"];
const want = process.env.BODY_RUNTIME_TEETH ? [...WANT].reverse() : WANT;
check("init, after the mixer, before vrm.update: the module's documented order", JSON.stringify(calls) === JSON.stringify(want), calls);
check("writeAll writes the active bindings only, from the accumulator the update filled",
  set.length === 2 && set[0].off === 2 * 4 && set[1].off === 2 * 3, set);
calls.length = 0;
rt.init(vrm);
makeBodyRuntime("eidoverse-dof", mod, { report: () => {} })!.init(vrm);
check("a body is set up once, even worn again by a new runtime (a pooled body's skeleton isn't at rest)", calls.length === 0, calls);
check("no runtime for an unknown kind or no module", makeBodyRuntime("other", mod) === null && makeBodyRuntime("eidoverse-dof", null as any) === null);

// 3. a step that throws: reported once, skipped after, and the rest of the frame still runs
const reports: string[] = [];
let crowns = 0;
const bad = { ...mod, applyArmDOF: () => { throw new Error("boom"); }, applyCrown: () => { crowns++; } };
const rt2 = makeBodyRuntime("eidoverse-dof", bad, { report: (m: string) => reports.push(m) })!;
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
const rt3 = makeBodyRuntime("eidoverse-dof", mod2, { skip: ["initLegDOF", "applyHardwareDOF", "applyLegClearance"], report: () => {} })!;
rt3.init({}); rt3.beforeVrmUpdate({}, 1 / 60);
check("a skipped step never runs (the def's runtime.skip)", !calls2.some((c) => ["initLegDOF", "applyHardwareDOF", "applyLegClearance"].includes(c))
  && calls2.includes("applyArmDOF"), calls2);
check("runtime.skip validates as step names", validateBodyRuntime({ ...good, skip: ["initLegDOF"] }).length === 0
  && validateBodyRuntime({ ...good, skip: "initLegDOF" }).length > 0 && validateBodyRuntime({ ...good, skip: ["../x"] }).length > 0);
check("lamps and emissiveMax validate", validateAvatarDef("x", { lamps: false, emissiveMax: 1 }).length === 0
  && validateAvatarDef("x", { lamps: "no" }).length > 0 && validateAvatarDef("x", { emissiveMax: -1 }).length > 0);

// 3c. limp: the constraints the module took over at init are handed back while limp, and taken again when it stands
const cHip = { destination: "leftHipPitch" }, cCalf = { destination: "leftCalf" };
const mgr = { constraints: new Set<any>([cHip, cCalf]), addConstraint(c: any) { this.constraints.add(c); }, deleteConstraint(c: any) { this.constraints.delete(c); } };
const vrmL = { nodeConstraintManager: mgr };
const modL = { ...mod, initLegDOF: (v: any) => { v.nodeConstraintManager.deleteConstraint(cHip); } };
const rtL = makeBodyRuntime("eidoverse-dof", modL, { report: () => {} })!;
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

// 5. the real module, when a library is at hand: it must export what the order calls
const lib = process.env.EIDOVERSE_DIR;
const real = lib ? join(lib, good.module) : "";
if (real && existsSync(real)) {
  const m = await import(real);
  const missing = WANT.filter((n) => typeof m[n] !== "function");
  check(`${good.module} exports every step of the order`, missing.length === 0, missing);
  check(`${good.module} exports LEG_JOINTS`, Array.isArray(m.LEG_JOINTS) && m.LEG_JOINTS.length > 0);
  const jp = join(lib!, good.joints);
  check(`${good.joints} is there, with hinges`, existsSync(jp) && !!JSON.parse(readFileSync(jp, "utf8")).hinges);
} else console.log(`  · no library module at ${real || "(EIDOVERSE_DIR unset)"}: the real-module checks skipped`);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
