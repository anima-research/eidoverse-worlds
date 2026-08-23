/**
 * Agent reach test — the tool surface, the solve, the attestation, and the
 * events, on a bare WorldAgent with stand-in skeletons. No servers.
 *
 * Run: bun mcpl/reach-test.ts
 *
 * The wire grammar itself is tools/reachwire-test.ts; the geometry is
 * tools/reachlive-test.ts. What THIS suite owns is the seam between them:
 * a blind body resolving a descriptor from streamed presence, solving its
 * own arm, attesting `reached`, and hearing about other people's hands.
 */
import { WorldAgent } from "./agent.ts";
import { ReachBody } from "./physics.ts";
import { normalizeReachBag } from "../shared/reachwire.js";

let failures = 0;
const check = (label: string, ok: boolean, detail?: string) => {
  console.log(ok ? `  \x1b[32m✓\x1b[0m ${label}` : `  \x1b[31m✗ ${label}${detail ? ` — ${detail}` : ""}\x1b[0m`);
  if (!ok) failures++;
};

// A VRM1 optimized rig for both bodies (the ragdoll suites' stand-in door).
const { rigs } = await import("../tools/rig-load.mjs");
const rig: any = rigs().find((r: any) => !r.err && !r.vrm0);
check("a VRM1 rig is available for the stand-ins", !!rig, "assets/opt missing?");
if (!rig) process.exit(1);

const DEFAULT_BODY = "eidoverse/assets/vrms/claude.vrm";
const mkAgent = async () => {
  const ag: any = new WorldAgent({ name: "me", world: "test" });
  // pre-seed the solver bodies the way a live join's fetch would
  ag.reachBodies.set(DEFAULT_BODY, await ReachBody.fromSkeleton(rig.P));
  return ag as any;
};

console.log(`\nrig: ${rig.name}`);

console.log("\nthe tool surface refuses legibly");
{
  const ag = await mkAgent();
  const r1 = await ag.reach("tentacle", { p: [0, 1, 0] });
  check("unknown limb is named and taught", !r1.ok && r1.text.includes("rightHand"), r1.text);
  const r2 = await ag.reach("rightHand", { who: "nobody_here", point: "shoulder_l" });
  check("an absent person is refused", !r2.ok && r2.text.includes("nobody_here"), r2.text);
  const r3 = await ag.reach("rightHand", { flavour: "grape" });
  check("an unusable target teaches both grammars", !r3.ok && r3.text.includes("{who, point}"), r3.text);
  check("nothing streamed after refusals", ag.reaches.size === 0);
}

console.log("\na world-point reach: solve, verdict, wire bag");
{
  const ag = await mkAgent();
  ag.pos = { x: 0, y: 0, z: 0 }; ag.yaw = 0;
  // just in front of the chest: comfortably reachable
  const r = await ag.reach("rightHand", { p: [0.1, 1.1, 0.35] });
  check("reach accepted", r.ok, r.text);
  check("the reply is a verdict, not a shrug", /rests on|short|reaching/.test(r.text), r.text);
  check("descriptor streams", ag.reaches.has("rightHand"));
  const bag = normalizeReachBag(Object.fromEntries(ag.reaches));
  check("the streamed bag survives the wire reader", !!bag?.rightHand, JSON.stringify(bag));
  const far = await ag.reach("leftHand", { p: [4, 1, 4] });
  check("an unreachable point says how short and why", /short|not arriving/.test(far.text) && /limited by/.test(far.text), far.text);
  check("...but still streams (the arm extends toward it)", ag.reaches.has("leftHand"));
  const rel = ag.releaseReach("left");
  check("release with a generous limb name", rel.includes("left hand"), rel);
  check("released limb leaves the bag", !ag.reaches.has("leftHand"));
  check("release of an idle limb says so", ag.releaseReach("leftFoot").includes("wasn't"), "");
}

console.log("\na landmark on another body, from streamed presence");
{
  const ag = await mkAgent();
  ag.pos = { x: 0, y: 0, z: 0 }; ag.yaw = 0;
  // digi stands half a metre in front, facing us (yaw π) — shoulder in range
  ag.people.set("digi", { id: "digi", avatar: "", pose: { p: [0, 0, 0.55], yaw: Math.PI, speed: 0, clip: "idle" } });
  const r = await ag.reach("rightHand", { who: "digi", point: "shoulder_l" });
  check("reach accepted", r.ok, r.text);
  check("the target is named as theirs", r.text.includes("digi's shoulder_l"), r.text);
  const entry = ag.reaches.get("rightHand");
  check("descriptor carries the canonical point", entry?.t?.point === "shoulder_l");
  const v = ag.solveReachEntry("rightHand", entry);
  check("solve resolves against their stand-in", v.state === "ok", JSON.stringify(v));
  check("gap is a real number", v.state === "ok" && Number.isFinite(v.gap), JSON.stringify(v));

  // attestation follows the world: they walk away, reached must drop
  if (v.state === "ok" && v.reached) check("close = reached", entry.reached === true);
  ag.people.set("digi", { id: "digi", avatar: "", pose: { p: [6, 0, 6], yaw: 0, speed: 0, clip: "idle" } });
  ag.reachTick();
  check("they left arm's reach — attestation drops", ag.reaches.get("rightHand").reached === undefined);
  const v2 = ag.solveReachEntry("rightHand", ag.reaches.get("rightHand"));
  check("...and the verdict says the distance", v2.state === "ok" && v2.gap > 1, JSON.stringify(v2));
}

console.log("\nself-touch and frames");
{
  const ag = await mkAgent();
  ag.pos = { x: 2, y: 0, z: 3 }; ag.yaw = Math.PI / 2;
  const r = await ag.reach("rightHand", { who: "me", point: "head_top" });
  check("own head is a legal target", r.ok, r.text);
  check("described as yours", r.text.includes("your head_top"), r.text);
  // self-space: one metre forward should land one metre along +X at yaw π/2
  const tp = ag.reachTargetPoint({ p: [0, 1, 1], space: "self" });
  check("self-frame point rides my yaw", tp && !("err" in tp)
    && Math.abs(tp.pos[0] - 3) < 1e-9 && Math.abs(tp.pos[2] - 3) < 1e-9, JSON.stringify(tp));
  // their-space: same transform, their transform
  ag.people.set("digi", { id: "digi", avatar: "", pose: { p: [10, 0, 0], yaw: 0, speed: 0, clip: "idle" } });
  const tq = ag.reachTargetPoint({ p: [0, 1, 1], space: "digi" });
  check("avatar-frame point rides their pose", tq && !("err" in tq)
    && Math.abs(tq.pos[0] - 10) < 1e-9 && Math.abs(tq.pos[2] - 1) < 1e-9, JSON.stringify(tq));
  const tm = ag.reachTargetPoint({ p: [0, 1, 1], space: "ghost" });
  check("an absent frame is an error, not a guess", tm && "err" in tm, JSON.stringify(tm));
}

console.log("\nhearing about hands aimed at me");
{
  const ag = await mkAgent();
  const pings: any[] = [];
  ag.onPing = (p: any) => pings.push(p);
  const pose = (reach: any): any => ({ p: [1, 0, 1], yaw: 0, speed: 0, clip: "idle", ...(reach ? { reach } : {}) });
  const aim = { rightHand: { t: { who: "me", point: "shoulder_l" } } };
  const touch = { rightHand: { t: { who: "me", point: "shoulder_l" }, reached: true } };

  // first observation is a baseline — a hand already resting there says nothing
  ag.notePose("digi", pose(touch));
  check("baseline seeds silently", pings.length === 0, JSON.stringify(pings));

  const ag2 = await mkAgent();
  const pings2: any[] = [];
  ag2.onPing = (p: any) => pings2.push(p);
  ag2.notePose("digi", pose(null));
  ag2.notePose("digi", pose(aim));
  check("a new reach at me knocks once", pings2.length === 1 && pings2[0].kind === "reach", JSON.stringify(pings2));
  check("...with the point and the limb in words",
    pings2[0].text.includes("your shoulder_l") && pings2[0].text.includes("right hand"), pings2[0]?.text);
  ag2.notePose("digi", pose(aim));
  check("holding the aim does not knock again", pings2.length === 1);
  ag2.notePose("digi", pose(touch));
  check("arrival knocks as touch", pings2.length === 2 && pings2[1].kind === "touch", JSON.stringify(pings2.at(-1)));
  ag2.notePose("digi", pose(touch));
  ag2.notePose("digi", pose(aim));    // trembles off...
  ag2.notePose("digi", pose(touch));  // ...and back on within the refractory
  check("a trembling touch knocks once", pings2.filter((p) => p.kind === "touch").length === 1, JSON.stringify(pings2));
  ag2.notePose("digi", pose(null));
  check("release is not a knock", pings2.length === 2, JSON.stringify(pings2.at(-1)));
  // a reach at someone else is their event, not mine
  ag2.notePose("digi", pose({ leftHand: { t: { who: "somebodyelse", point: "head_top" } } }));
  check("reaches at others stay ambient", pings2.length === 2);
}

console.log("\nbeing knocked over drops the reach");
{
  const ag = await mkAgent();
  await ag.reach("rightHand", { p: [0.1, 1.1, 0.35] });
  check("reaching", ag.reaches.size === 1);
  ag.pushable = true;
  ag.knockDown("digi", [1, 0, 0], "digi shoves you");
  check("a corpse does not keep reaching", ag.reaches.size === 0);
}

console.log(failures ? `\n\x1b[31m${failures} failing\x1b[0m` : "\n\x1b[32mall passed\x1b[0m");
process.exit(failures ? 1 : 0);
