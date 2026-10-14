// Posing someone else, and letting them go, on the OTHER body's path and from
// each seat a request can come from: an agent's tools, and the browser
// console's verbs (client/lib/posecommands.js, EW.pose, EW.clearPose and
// EW.animate), here sending through an agent's socket instead of the
// browser's. The receiver is a headless body; a browser receiver
// (client/lib/localbody.js) needs a browser. Also: a body knocked over while
// kneeling falls from its kneel.
// Run: bun tools/other-body-pose-test.ts
process.env.WORLD_TOKEN = "";
process.env.AGENT_BODY_ENGINE = "verlet";
const { WorldAgent } = await import("../mcpl/agent.ts");
const { handleTool } = await import("../mcpl/tools.ts");
const { puppetPose } = await import("../shared/humanoid.js");
const { poseCommands } = await import("../client/lib/posecommands.js");
const { scratchSequencer, mkCheck, sleep } = await import("./harness.ts");
const { fixture } = await import("./body-fixture.ts");
const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import("node:fs");
const { tmpdir } = await import("node:os");
const { join } = await import("node:path");
const { check, tally } = mkCheck();

const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
check("a null pose for someone else is a release, the request clear_pose sends", eq(puppetPose(null), { pose: {} }));
check("named bones merge over what they hold", eq(puppetPose({ head: [0, 0, 0, 1] }), { pose: { head: [0, 0, 0, 1] }, merge: true }));
check("replace sends the whole pose, and a replace with nothing left is a release",
  eq(puppetPose({ head: [0, 0, 0, 1], neck: null }, true), { pose: { head: [0, 0, 0, 1] } }) && eq(puppetPose({ neck: null }, true), { pose: {} }));

// The console's verbs on the caller's own body, and what they refuse.
{
  const sent: any[] = [], played: any[] = [], state: any = { pose: null };
  const EW = poseCommands({ state, sendPuppet: (t: string, r: unknown) => { sent.push([t, r]); }, play: (a: unknown) => { played.push(a); } });
  const arm = { leftUpperArm: [0, 0, 0.3, Math.sqrt(0.91)] };
  EW.pose(arm);
  check("EW.pose poses the caller", eq(state.pose, arm) && !sent.length);
  check("EW.pose() with nothing named changes nothing and sends nothing", eq(EW.pose(), arm) && eq(state.pose, arm) && !sent.length);
  check("...nor with a target: nothing named is no release of theirs", EW.pose(undefined, "someone") === undefined && !sent.length);
  EW.pose(null);
  check("EW.pose(null) releases the caller's pose", state.pose === null && !sent.length);
  EW.pose(arm); EW.clearPose();
  check("EW.clearPose() releases the caller's pose", state.pose === null && !sent.length);
  const threw = (f: () => unknown) => { try { f(); return false; } catch (e) { return e instanceof TypeError; } };
  EW.pose(arm);
  check("a misspelled option throws rather than pose the caller", threw(() => EW.pose(null, { taget: "someone" })) && eq(state.pose, arm) && !sent.length);
  check("options of another kind throw", threw(() => EW.pose(arm, 7 as any)) && threw(() => EW.animate({ dur: 1, tracks: {} }, ["x"] as any)) && !sent.length);
  check("EW.clearPose takes a name or nothing", threw(() => EW.clearPose({ target: "someone" } as any)) && eq(state.pose, arm) && !sent.length);
  EW.animate({ dur: 1, tracks: {} });
  check("EW.animate plays on the caller, merging over its pose", played.length === 1 && played[0].replace === false && eq(state.pose, arm) && !sent.length);
}

const lib = mkdtempSync(join(tmpdir(), "other-body-library-"));
mkdirSync(join(lib, "fixtures"));
writeFileSync(join(lib, "fixtures/body.vrm"), fixture());
const h = await scratchSequencer("other-body-pose", { portFrom: 9380, serverEnv: { EIDOVERSE_DIR: lib, SKIP_OPT_SWEEP: "1" } });
const agents: any[] = [];
async function agent(name: string) {
  const a = new WorldAgent({ name, avatar: "fixtures/body.vrm", world: "puppet-test", url: h.BASE.replace("http", "ws") + "/ws" });
  agents.push(a); await a.connect(); return a as any;
}
async function until(fn: () => boolean, ms = 4000) {
  const end = Date.now() + ms;
  while (!fn()) { if (Date.now() > end) return false; await sleep(20); }
  return true;
}
const tool = (a: any, name: string, args: any) => handleTool({ agent: a, canPush: () => false, heldActivity: [], cursor: { caughtUpTo: null } }, name, args);
try {
  const poser = await agent("poser"), held = await agent("held");
  const heard: string[] = [];
  held.onEvent = (e: any) => { if (e.who === poser.name && e.kind === "say") heard.push(e.text); };
  const arm = { leftUpperArm: [0, 0, 0.3, Math.sqrt(0.91)] };

  // The tools' seat.
  await tool(poser, "pose", { bones: arm, target: held.name });
  check("an agent's pose reaches another body", await until(() => eq(held.heldPose, arm)), JSON.stringify(held.heldPose));
  check("...and that body hears it was posed", await until(() => heard.includes("(posed you)")), heard.join(" | "));
  heard.length = 0;
  await tool(poser, "clear_pose", { target: held.name });
  check("clear_pose with a target lets that body go", await until(() => held.heldPose == null), JSON.stringify(held.heldPose));
  check("...and it hears a release, not a pose", await until(() => heard.includes("(released your pose)")) && !heard.includes("(posed you)"), heard.join(" | "));

  // The console's seat: its own verbs, sending what they build through a socket.
  const own: any = { pose: null };
  const EW = poseCommands({ state: own, sendPuppet: (t: string, r: any) => poser.puppet(t, r), play: () => {} });
  heard.length = 0;
  EW.pose(arm, held.name);
  check("EW.pose with a name alone poses that body, not the caller", await until(() => eq(held.heldPose, arm)) && own.pose === null, JSON.stringify(held.heldPose));
  EW.pose(null, { target: held.name });
  check("EW.pose(null, {target}) lets that body go", await until(() => held.heldPose == null) && own.pose === null, JSON.stringify(held.heldPose));
  check("...and it hears a release", await until(() => heard.includes("(released your pose)")), heard.join(" | "));
  EW.pose(arm, { target: held.name });
  const posedAgain = await until(() => eq(held.heldPose, arm));
  EW.clearPose(held.name);
  check("EW.clearPose(name) lets that body go", posedAgain && await until(() => held.heldPose == null), JSON.stringify(held.heldPose));
  heard.length = 0;
  EW.animate({ dur: 1, tracks: { head: [{ t: 0, q: [0, 0, 0, 1] }] } }, held.name);
  check("EW.animate with a name alone animates that body, and it hears so", await until(() => heard.includes("(posed you with an animation)")), heard.join(" | "));

  // A request that carries nothing (an old console sent `pose: null` and
  // nothing else): the body keeps its pose and isn't told it was posed.
  await tool(poser, "pose", { bones: arm, target: held.name });
  const ready = await until(() => eq(held.heldPose, arm));
  heard.length = 0;
  poser.puppet(held.name, { pose: null as any });
  await tool(poser, "pose", { bones: { head: [0, 0, 0, 1] }, target: held.name });   // a marker that the empty request was handled first
  const marked = await until(() => !!held.heldPose?.head);
  check("a request that carries nothing changes nothing and says nothing",
    ready && marked && eq(held.heldPose, { ...arm, head: [0, 0, 0, 1] }) && eq(heard, ["(posed you)"]), heard.join(" | "));
  heard.length = 0;
  poser.puppet(held.name, { pose: {}, anim: { dur: 1, tracks: { head: [{ t: 0, q: [0, 0, 0, 1] }] } } });
  check("a release with an animation is told as both", await until(() => heard.includes("(released your pose, with an animation)")), heard.join(" | "));

  // Knocked over while kneeling: the fall starts from the kneel, as a
  // browser's does (its sim starts from the bones it draws). The ragdoll's
  // rest snapshot is taken with the root where the fall starts.
  const kneeler = await agent("kneeler");
  const knock = async () => {
    const before = kneeler.body?.rd;
    poser.puppet(kneeler.name, { ragdoll: true });
    return (await until(() => !!kneeler.body?.rd && kneeler.body.rd !== before, 15_000)) ? kneeler.body.rd.rest?.hips?.y : NaN;
  };
  const standing = await knock();
  kneeler.setPose(null);   // standing up ends the slump
  kneeler.setPose({ hips: { t: [0, -0.3, 0] } });
  const kneeling = await knock();
  check("a body knocked over while kneeling falls from its kneel", Math.abs(kneeling - standing + 0.3) < 1e-6,
    `rest hips y: standing ${standing}, kneeling ${kneeling}`);
} catch (e) {
  process.exitCode = 1;
  throw e;
} finally {
  for (const a of agents) a.close();
  await h.cleanup(tally.failed || process.exitCode ? 1 : 0);
  rmSync(lib, { recursive: true, force: true });
}
console.log(`${tally.passed} passed, ${tally.failed} failed`);
process.exit(tally.failed ? 1 : 0);
