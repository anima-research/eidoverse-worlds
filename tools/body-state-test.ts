// Owned server -> real WorldAgent -> shared MCP tool, plus independent FK
// coordinates and read/replace races. No production world or renderer.
// Run: bun tools/body-state-test.ts
process.env.AGENT_BODY_ENGINE = "verlet";
process.env.WORLD_TOKEN = "";
const { WorldAgent } = await import("../mcpl/agent.ts");
const { handleTool, TOOLS } = await import("../mcpl/tools.ts");
const { BodyStateReader } = await import("../mcpl/body-state.ts");
const { scratchSequencer, mkCheck, sleep } = await import("./harness.ts");
const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import("node:fs");
const { tmpdir } = await import("node:os");
const { join } = await import("node:path");
const { check, tally } = mkCheck();
const { fixture, postureFixture } = await import("./body-fixture.ts");

// Includes bones the old reach stand-in collapses: upperChest, shoulders,
// fingers. Non-unit ancestor scale and a second VRM0 fixture exercise frames.

const lib = mkdtempSync(join(tmpdir(), "body-state-library-"));
mkdirSync(join(lib, "fixtures"));
mkdirSync(join(lib, "defs/animations"), { recursive: true });
writeFileSync(join(lib, "fixtures/idle.vrma"), postureFixture("idle"));
writeFileSync(join(lib, "defs/animations/idle.json"), JSON.stringify({ vrma: "fixtures/idle.vrma" }));
writeFileSync(join(lib, "fixtures/test-body.vrm"), fixture());
writeFileSync(join(lib, "fixtures/large-body.vrm"), fixture(2));
writeFileSync(join(lib, "fixtures/old-body.vrm"), fixture(1, true));
const h = await scratchSequencer("body-state", { serverEnv: { EIDOVERSE_DIR: lib, DEFS_DIR: join(lib, "defs"), SKIP_OPT_SWEEP: "1" }, portFrom: 9300 });
const agents: any[] = [];
async function agent(name: string, avatar = "fixtures/test-body.vrm") {
  const a = new WorldAgent({ name, avatar, world: "body-test", url: h.BASE.replace("http", "ws") + "/ws" });
  agents.push(a); await a.connect(); return a as any;
}
async function read(a: any, args: any = {}) {
  const r = await handleTool({ agent: a, canPush: () => false, heldActivity: [], cursor: { caughtUpTo: null } }, "body_state", args);
  return { wire: r, ...JSON.parse(r.content[0].text) };
}
async function until(fn: () => boolean) {
  const end = Date.now() + 4000;
  while (!fn()) { if (Date.now() > end) throw new Error("presence condition timed out"); await sleep(20); }
}
const eq = (a: any, b: any) => JSON.stringify(a) === JSON.stringify(b);
const near = (a: number[], b: number[]) => !!a && !!b && a.length === b.length && a.every((x, i) => Math.abs(x - b[i]) < 1e-6);
try {
  const owner = await agent("body-owner"), peer = await agent("body-peer");
  check("tool is registered for both doors", TOOLS.some(t => t.name === "body_state"));
  const bones = Object.fromEntries(["spine", "chest", "neck", "head", "leftUpperArm", "leftLowerArm", "rightUpperArm", "rightLowerArm"]
    .map((n, i) => [n, [0, 0, Math.sin((i + 1) / 40), Math.cos((i + 1) / 40)]]));
  owner.setPose(bones); owner.wingsFolded = true; owner.tick();
  await until(() => eq(peer.people.get(owner.name)?.pose?.pose, bones));
  const self = await read(owner, { detail: "all", points: ["chest_front", "hand_l"] });
  const other = await read(peer, { who: owner.name, detail: "all", points: ["chest_front", "hand_l"] });
  check("eight exact quaternions round-trip owner -> server -> peer -> tool", self.ok && other.ok && eq(self.publishedRotations, bones) && eq(other.publishedRotations, bones), JSON.stringify(other.geometry));
  check("public peer pose requires no consent", !other.wire.isError && other.wingsFolded === true);
  check("remote provenance stays unknown", other.overrides.source === "unknown" && self.overrides.source === "authored");
  check("full humanoid hierarchy includes shoulders and fingers", !!other.joints?.upperChest && !!other.joints?.leftShoulder && !!other.joints?.leftMiddleProximal);
  check("contacts are world frames with actionable targets and explicit quality", other.contacts?.hand_l?.position?.length === 3 && other.contacts.hand_l.quality === "anatomical_estimate" && eq(other.contacts.hand_l.reachTarget, { who: owner.name, point: "hand_l" }));
  check("self and peer derive the same held geometry", near(self.contacts?.hand_l?.position, other.contacts?.hand_l?.position));
  const late = await agent("body-late");
  const joined = await read(late, { who: owner.name, detail: "bones" });
  check("late join snapshot reaches the real read tool", joined.ok && eq(joined.publishedRotations, bones));
  owner.setPose(null); owner.tick();
  await until(() => !peer.people.get(owner.name)?.pose?.pose);
  check("clear removes overrides, not the skeleton", (await read(peer, { who: owner.name })).overrides.state === "none");
  for (const clip of ["unrecognized-clip"]) {
    owner.clip = clip; owner.setPose(bones); owner.tick();
    await until(() => peer.people.get(owner.name)?.pose?.clip === clip);
    const seated = await read(owner, { detail: "all", points: ["knee_r"] });
    const seen = await read(peer, { who: owner.name, detail: "contacts", points: ["knee_r"] });
    check(`${clip}: current-body geometry is withheld on the real self/peer tool path`,
      seated.wire.isError === true && seen.wire.isError === true && seen.geometry?.basis === "rest_pose_estimate"
      && !seated.joints && !seated.contacts && !seen.contacts && seen.posture === clip && eq(seated.publishedRotations, bones));
  }
  owner.clip = "idle"; owner.setPose(null); owner.tick();
  await until(() => peer.people.get(owner.name)?.pose?.clip === "idle");
  check("standing again restores contact estimates", (await read(peer, { who: owner.name, detail: "contacts", points: ["knee_r"] })).contacts?.knee_r?.quality === "anatomical_estimate");
  peer.clip = "sit"; peer.tick();
  await until(() => owner.people.get(peer.name)?.pose?.clip === "sit");
  owner.reaches.set("rightHand", { t: { who: peer.name, point: "knee_r" } });
  const targetSeated = await read(owner, { detail: "all", points: ["hand_r"] });
  check("a reach toward an unevaluated seated body does not claim arrival or return usable targets",
    !targetSeated.ok && targetSeated.reachEvaluation?.rightHand?.ok === false && !targetSeated.contacts?.hand_r?.reachTarget);
  owner.reaches.set("rightHand", { t: { p: [0, 1.2, .1], space: peer.name }, palm: false });
  check("a point in a seated body's known root frame remains usable without posture geometry",
    (await read(owner, { detail: "all" })).reachEvaluation?.rightHand?.ok === true);
  owner.releaseReach(); peer.clip = "idle"; peer.tick();
  owner.heldPose = bones; owner.heldPoseAuthored = false; owner.clip = "idle";
  check("internal retired physics does not leak into self readback", (await read(owner)).overrides.state === "none");
  owner.clip = "ragdoll"; owner.tick();
  await until(() => peer.people.get(owner.name)?.pose?.clip === "ragdoll");
  check("physics is separate from authored holding", (await read(owner)).overrides.source === "physics" && (await read(peer, { who: owner.name })).overrides.source === "physics");
  owner.setPose(null); owner.tick();

  // Independent known FK: hand x=.8,y=1.5; root yaw pi/2 maps +x to -z.
  owner.pos = { x: 3, y: 0, z: 4 }; owner.yaw = Math.PI / 2;
  let fk = await read(owner, { detail: "bones" });
  check("world joints include root translation and yaw", near(fk.joints?.leftHand?.position, [3, 1.5, 3.2]));
  owner.setPose({ leftShoulder: [0, 0, Math.SQRT1_2, Math.SQRT1_2] });
  fk = await read(owner, { detail: "bones" });
  check("shoulder override propagates through actual hierarchy", near(fk.joints?.leftHand?.position, [3, 2.2, 3.9]));
  owner.setPose(null);
  const before = { pose: owner.heldPose, reaches: [...owner.reaches], pos: { ...owner.pos } };
  await read(owner, { detail: "all" });
  check("perception does not author pose, movement or reaches", owner.heldPose === before.pose && eq([...owner.reaches], before.reaches) && eq(owner.pos, before.pos));
  owner.reaches.set("leftHand", { t: { p: [.4, 1.3, .2], space: "self" }, palm: false });
  const reachRead = await read(owner, { detail: "all", points: ["hand_l"] });
  check("active self-relative reach is evaluated for readback", reachRead.reachEvaluation?.leftHand?.ok && !near(reachRead.joints.leftHand.position, [3, 1.5, 3.2]), JSON.stringify(reachRead.reachEvaluation));
  check("reading a reach leaves held intent unchanged", owner.reaches.size === 1 && owner.heldPose === null);
  owner.releaseReach();
  const historyBefore = await owner.history({ limit: 200 });
  await read(owner, { detail: "all" });
  const historyAfter = await owner.history({ limit: 200 });
  check("body reads produce no authored world-log entries", eq(historyBefore.entries, historyAfter.entries));
  check("a snapshot does not claim stability", (await read(owner)).stability.status === "unmeasured");
  const change = setTimeout(() => owner.setPose({ head: [0, 0, Math.SQRT1_2, Math.SQRT1_2] }), 120);
  const windowed = await read(owner, { window_ms: 350 });
  clearTimeout(change);
  check("observation window measures joint motion", windowed.ok && windowed.stability.samples >= 3 && windowed.stability.maxJointDeltaDeg > 89
    && windowed.stability.status === "motion_observed" && windowed.stability.branchFlips === null, JSON.stringify(windowed.stability));
  owner.setPose(null);
  check("invalid observation windows are refused", (await read(owner, { window_ms: 6000 })).wire.isError === true);

  const generation = (await read(owner)).bodyGeneration.value;
  owner.setAvatar("fixtures/large-body.vrm");
  await until(() => peer.people.get(owner.name)?.avatar === "fixtures/large-body.vrm");
  const big = await read(owner, { detail: "bones" });
  check("body replacement invalidates geometry, including scale", big.bodyGeneration.value !== generation && Math.abs(big.joints?.head?.selfPosition[1] - 3.6) < 1e-6, JSON.stringify(big.geometry));
  const old = await agent("body-vrm0", "fixtures/old-body.vrm");
  const v0 = await read(old, { detail: "bones" });
  check("VRM0 half-turn is preserved", near(v0.joints?.leftHand?.selfPosition, [-.8, 1.5, 0]));
  owner.close();
  await until(() => !peer.people.has(owner.name));
  peer.notePose(owner.name, { p: [1, 0, 1], yaw: 0, speed: 0, clip: "idle" });
  check("a late frame cannot resurrect a departed body", !peer.people.has(owner.name));
  check("leave removes the public body", (await read(peer, { who: owner.name })).wire.isError === true);
  check("disconnected self is explicitly stale", (await read(owner)).freshness.status === "stale");
  const replacement = await agent("body-owner", "fixtures/test-body.vrm");
  await until(() => !!peer.people.get(replacement.name)?.pose);
  check("same-name rejoin gets a new observer generation", (await read(peer, { who: replacement.name })).bodyGeneration.value !== other.bodyGeneration.value);
  const p = peer.people.get(replacement.name)!;
  const receipt = p.observedAt; p.observedAt = Date.now() - 6000;
  check("stale peer samples fail loudly", (await read(peer, { who: replacement.name })).wire.isError === true);
  p.observedAt = receipt;
  p.pose = { ...p.pose, p: [null, 0, 0] };
  check("unknown position never becomes a rest-pose coordinate", (await read(peer, { who: replacement.name, detail: "contacts" })).root === null);
  check("unknown names and invalid options are tool errors", (await read(peer, { who: "absent" })).wire.isError === true && (await read(peer, { detail: "nonsense" })).wire.isError === true);
  check("prototype names are not contact points", (await read(peer, { points: ["__proto__"] })).wire.isError === true);

  // Deterministic held fetch: a replacement must not wear the old body's
  // geometry when the old request completes later.
  let release!: () => void;
  const held = new Promise<void>(r => { release = r; });
  const serveFixture = (req: Request) => new URL(req.url).pathname === "/animations"
    ? Response.json([{ name: "idle", path: "idle.vrma" }])
    : new Response(req.url.endsWith(".vrma") ? postureFixture("idle") : fixture());
  const slow = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) { await held; return serveFixture(req); } });
  try {
    const reader = new BodyStateReader(`http://127.0.0.1:${slow.port}`);
    let o: any = { who: "changing", avatar: "test.vrm", generation: 1, self: false, connected: true, receivedAt: Date.now(),
      source: "unknown", pose: { p: [0, 0, 0], yaw: 0, speed: 0, clip: "idle" } };
    const pending = reader.read(o.who, "all", undefined, () => o);
    o = { ...o, generation: 2 }; release();
    check("in-flight old skeleton cannot answer for a replacement", (await pending).error?.includes("body changed"));
  } finally { slow.stop(true); }
  let resume!: () => void;
  const waiting = new Promise<void>(r => { resume = r; });
  const postureServer = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) { await waiting; return serveFixture(req); } });
  try {
    const reader = new BodyStateReader(`http://127.0.0.1:${postureServer.port}`);
    let o: any = { who: "sitting", avatar: "test.vrm", generation: 1, self: false, connected: true, receivedAt: Date.now(),
      source: "unknown", pose: { p: [0, 0, 0], yaw: 0, speed: 0, clip: "idle" } };
    const pending = reader.read(o.who, "all", undefined, () => o);
    o = { ...o, pose: { ...o.pose, clip: "sit" } }; resume();
    const result = await pending;
    check("posture is rechecked after an asynchronous skeleton load", !result.ok && result.geometry?.reason === "posture_not_evaluated" && !result.contacts);
  } finally { postureServer.stop(true); }
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
