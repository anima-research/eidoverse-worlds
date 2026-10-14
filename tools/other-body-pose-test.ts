// Posing someone else, and letting them go, on the OTHER body's path: an
// agent poses a headless body through the shared tools, then releases it, and
// a console that asks with a null pose releases it the same way. The browser
// console's EW.pose and EW.clearPose send what puppetPose builds, as the tools
// do, so both seats are held to one request shape here.
// Run: bun tools/other-body-pose-test.ts
process.env.WORLD_TOKEN = "";
const { WorldAgent } = await import("../mcpl/agent.ts");
const { handleTool } = await import("../mcpl/tools.ts");
const { puppetPose } = await import("../shared/humanoid.js");
const { scratchSequencer, mkCheck, sleep } = await import("./harness.ts");
const { check, tally } = mkCheck();

const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
check("a null pose for someone else is a release, the request clear_pose sends", eq(puppetPose(null), { pose: {} }));
check("named bones merge over what they hold", eq(puppetPose({ head: [0, 0, 0, 1] }), { pose: { head: [0, 0, 0, 1] }, merge: true }));
check("replace sends the whole pose, and a replace with nothing left is a release",
  eq(puppetPose({ head: [0, 0, 0, 1], neck: null }, true), { pose: { head: [0, 0, 0, 1] } }) && eq(puppetPose({ neck: null }, true), { pose: {} }));

const h = await scratchSequencer("other-body-pose", { portFrom: 9380 });
const agents: any[] = [];
async function agent(name: string) {
  const a = new WorldAgent({ name, world: "puppet-test", url: h.BASE.replace("http", "ws") + "/ws" });
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

  await tool(poser, "pose", { bones: arm, target: held.name });
  check("an agent's pose reaches another body", await until(() => eq(held.heldPose, arm)), JSON.stringify(held.heldPose));
  check("...and that body hears it was posed", await until(() => heard.includes("(posed you)")), heard.join(" | "));

  heard.length = 0;
  await tool(poser, "clear_pose", { target: held.name });
  check("clear_pose with a target lets that body go", await until(() => held.heldPose == null), JSON.stringify(held.heldPose));
  check("...and it hears a release, not a pose", await until(() => heard.includes("(released your pose)")) && !heard.includes("(posed you)"), heard.join(" | "));

  // The console's seat: EW.pose(null, {target}) sends puppetPose(null).
  await tool(poser, "pose", { bones: arm, target: held.name });
  await until(() => eq(held.heldPose, arm));
  poser.puppet(held.name, puppetPose(null));
  check("a null pose from the console's seat lets that body go", await until(() => held.heldPose == null), JSON.stringify(held.heldPose));

  // An old console sent `pose: null` and nothing else: the body keeps its
  // pose and isn't told it was posed.
  await tool(poser, "pose", { bones: arm, target: held.name });
  await until(() => eq(held.heldPose, arm));
  heard.length = 0;
  poser.puppet(held.name, { pose: null as any });
  await tool(poser, "pose", { bones: { head: [0, 0, 0, 1] }, target: held.name });   // a marker that the empty request was handled first
  await until(() => !!held.heldPose?.head);
  check("a request that carries nothing changes nothing and says nothing", eq(held.heldPose, { ...arm, head: [0, 0, 0, 1] }) && eq(heard, ["(posed you)"]), heard.join(" | "));
} catch (e) {
  process.exitCode = 1;
  throw e;
} finally {
  for (const a of agents) a.close();
  await h.cleanup(tally.failed || process.exitCode ? 1 : 0);
}
console.log(`${tally.passed} passed, ${tally.failed} failed`);
process.exit(tally.failed ? 1 : 0);
