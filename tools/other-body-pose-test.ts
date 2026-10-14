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
  // Every way a call meant for someone else could land on the caller throws,
  // and the caller keeps its pose.
  const refused: Array<[string, () => unknown]> = [
    ["a misspelled option", () => EW.pose(null, { taget: "someone" })],
    ["options of another kind", () => EW.pose(arm, 7 as any)],
    ["options as a list", () => EW.animate({ dur: 1, tracks: {} }, ["x"] as any)],
    ["options passed as undefined", () => EW.pose(null, undefined)],
    ["options passed as null", () => EW.animate({ dur: 1, tracks: {} }, null as any)],
    ["an empty name", () => EW.pose(null, "")],
    ["an empty target", () => EW.pose(null, { target: "" })],
    ["a target given as undefined", () => EW.pose(null, { target: undefined })],
    ["a target that isn't a name", () => EW.pose(arm, { target: 7 as any })],
    ["replace that isn't true or false", () => EW.pose(arm, { replace: "yes" as any })],
    ["a name where the bones go", () => EW.pose("someone" as any)],
    ["a list where the bones go", () => EW.pose([[0, 0, 0, 1]] as any)],
    ["a target among the bones", () => EW.pose({ ...arm, target: "someone" } as any)],
    ["a target inside the animation", () => EW.animate({ dur: 1, tracks: {}, target: "someone" } as any)],
    ["clearPose with options", () => EW.clearPose({ target: "someone" } as any)],
    ["clearPose with undefined", () => EW.clearPose(undefined as any)],
    ["clearPose with null", () => EW.clearPose(null as any)],
    ["clearPose with an empty name", () => EW.clearPose("")],
    ["an argument after the options", () => EW.pose(null, { replace: true }, "someone" as any)],
    ["a function where the options go", () => EW.pose(arm, (() => "someone") as any)],
    ["clearPose with an argument after the name", () => (EW.clearPose as any)("someone", "else")],
    ["a name where the animation goes", () => EW.animate("someone" as any)],
    ["a list where the animation goes", () => EW.animate([{ dur: 1, tracks: {} }] as any)],
    ["an animation's replace that isn't true or false", () => EW.animate({ dur: 1, tracks: {}, replace: "yes" } as any)],
  ];
  const slipped = refused.filter(([, f]) => !threw(f)).map(([what]) => what);
  check("every call that could land on the caller by mistake throws instead", !slipped.length && eq(state.pose, arm) && !sent.length && !played.length,
    slipped.length ? `didn't throw: ${slipped.join(", ")}` : "");
  EW.pose({ head: [0, 0, 0, 1] }, { replace: undefined });
  check("a replace left undefined is no replace", eq(state.pose, { ...arm, head: [0, 0, 0, 1] }) && !sent.length);
  EW.pose({ head: null });
  check("EW.pose({}, name) merges nothing over theirs, so it sends nothing", EW.pose({}, "someone") === undefined && !sent.length);
  EW.animate({ dur: 1, tracks: {} });
  check("EW.animate plays on the caller, merging over its pose", played.length === 1 && played[0].replace === false && eq(state.pose, arm) && !sent.length);
  EW.animate({ dur: 1, tracks: {} }, { replace: true });
  check("...and a replacing animation ends the caller's pose first", played.length === 2 && played[1].replace === true && state.pose === null && !sent.length);
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
  const head = [0, 0.2, 0, Math.sqrt(0.96)], spine = [0.1, 0, 0, Math.sqrt(0.99)];
  EW.pose({ head }, held.name);
  check("EW.pose by name merges over what that body holds", posedAgain && await until(() => eq(held.heldPose, { ...arm, head })), JSON.stringify(held.heldPose));
  EW.pose({ head: undefined }, held.name);
  check("...an undefined bone releases it there, as it would on the caller", await until(() => eq(held.heldPose, arm)), JSON.stringify(held.heldPose));
  EW.pose({ spine }, { target: held.name, replace: true });
  check("...and replace makes the named bones its whole pose", await until(() => eq(held.heldPose, { spine })), JSON.stringify(held.heldPose));
  EW.clearPose(held.name);
  check("EW.clearPose(name) lets that body go", await until(() => held.heldPose == null), JSON.stringify(held.heldPose));
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
  // A replacing animation ends a held pose too, and the body is told so.
  await tool(poser, "pose", { bones: arm, target: held.name });
  const posedFirst = await until(() => eq(held.heldPose, arm));
  heard.length = 0;
  EW.animate({ dur: 1, tracks: { head: [{ t: 0, q: [0, 0, 0, 1] }] } }, { target: held.name, replace: true });
  check("a replacing animation that ends a held pose is told as a release", posedFirst
    && await until(() => heard.includes("(released your pose, with an animation)")) && held.heldPose == null, heard.join(" | "));

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
  // What each fall starts from, as begin() is handed it.
  const begun: any[] = [], body = kneeler.body, begin = body.begin.bind(body);
  body.begin = (o: any) => { begun.push(structuredClone(o)); return begin(o); };
  kneeler.setPose(null);
  // A pose no one authored, as a fall's own frames are.
  const slumped = { spine: [0.3, 0, 0, Math.sqrt(0.91)], leftUpperArm: [0, 0, 0.5, Math.sqrt(0.75)] };
  kneeler.heldPose = slumped; kneeler.heldPoseAuthored = false;
  const again = await knock();
  check("a body knocked over falls from the pose it was drawn in, whoever authored it",
    Number.isFinite(again) && eq(begun.at(-1)?.pose, slumped), JSON.stringify(begun.at(-1)?.pose)?.slice(0, 120));
  // While the fall waits on its skeleton and ground (tumble's waits always
  // yield, so what is done right after the blow lands before begin): a pose
  // given then is the one it starts from, a release lets it start standing,
  // and a second blow starts it from the slump the first one put up, which
  // is what the body was drawn in by then.
  const waited = async (during: () => void) => {
    const before = kneeler.body?.rd, count = begun.length;
    kneeler.knockDown(poser.name, null, "(knocked over)");
    during();
    await until(() => kneeler.body?.rd && kneeler.body.rd !== before, 15_000);
    return { pose: begun.at(-1)?.pose, begins: begun.length - count };
  };
  kneeler.setPose(null);
  const given = { hips: { t: [0, -0.2, 0] }, head: [0, 0.2, 0, Math.sqrt(0.96)] };
  const g = await waited(() => kneeler.setPose(given));
  check("...and from a pose given while the fall waited to start", eq(g.pose, given), JSON.stringify(g.pose)?.slice(0, 120));
  kneeler.setPose(null);
  kneeler.setPose({ hips: { t: [0, -0.3, 0] } });
  const r = await waited(() => { kneeler.heldPose = null; kneeler.heldPoseAuthored = false; });   // what a release does (the puppet handler)
  check("...from standing when its pose was released while it waited", r.pose === null, JSON.stringify(r.pose)?.slice(0, 120));
  kneeler.setPose(null);
  let slump: unknown;
  const twice = await waited(() => { slump = structuredClone(kneeler.heldPose); kneeler.knockDown(poser.name, null, "(knocked over)"); });
  check("...and once, from the first blow's slump, when a second blow lands while it waits", twice.begins === 1 && !!slump && eq(twice.pose, slump),
    `${twice.begins} begin(s), ${JSON.stringify(twice.pose)?.slice(0, 80)}`);
  kneeler.setPose(null);
  kneeler.pos.y = 0.5;     // standing on something above the terrain
  const raised = await knock();
  check("...and from the height it stood at, not the terrain under it",
    begun.at(-1)?.rootY === 0.5 && Math.abs(raised - standing - 0.5) < 1e-6, `rootY ${begun.at(-1)?.rootY}, rest hips y ${raised}`);
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
