// Owned server -> real WorldAgent -> shared MCP tool, plus independent FK, read/replace races, and one field table
// (bones, yaw, clip, scale, named pose) from both senders; body size's own rule is the last section.
// Run: BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun test/mcpl/body-state-test.ts   mutations: bun test/mcpl/body-state-mutation-test.ts
process.env.AGENT_BODY_ENGINE = "verlet";
process.env.WORLD_TOKEN = "";
const { WorldAgent } = await import("../../mcpl/agent.ts");
const { handleTool, TOOLS } = await import("../../mcpl/tools.ts");
const { BodyStateReader } = await import("../../mcpl/body-state.ts");
const { bodyWire } = await import("../../shared/presencewire.js");
const { until: waitUntil, tryUntil } = await import("../gate/wait.ts");
const { scratchSequencer, mkCheck } = await import("../harness/harness.ts");
const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import("node:fs");
const { tmpdir } = await import("node:os");
const { helloOf } = await import("../../shared/protocol/hello.js");
const { join } = await import("node:path");
const { check, tally } = mkCheck();
const { fixture, postureFixture, glbOf } = await import("../fixtures/body-fixture.ts");

// Includes bones the old reach stand-in collapses: upperChest, shoulders,
// fingers. Non-unit ancestor scale and a second VRM0 fixture exercise frames.

const lib = mkdtempSync(join(tmpdir(), "body-state-library-"));
mkdirSync(join(lib, "fixtures"));
mkdirSync(join(lib, "defs/animations"), { recursive: true });
writeFileSync(join(lib, "fixtures/idle.vrma"), postureFixture("idle"));
writeFileSync(join(lib, "defs/animations/idle.json"), JSON.stringify({ vrma: "fixtures/idle.vrma" }));
writeFileSync(join(lib, "fixtures/sitchair.vrma"), postureFixture("sitchair"));   // sit stays missing: the unevaluated-seated rows need it
writeFileSync(join(lib, "defs/animations/sitting_normal_chair.json"), JSON.stringify({ vrma: "fixtures/sitchair.vrma" }));
writeFileSync(join(lib, "fixtures/test-body.vrm"), fixture());
writeFileSync(join(lib, "fixtures/large-body.vrm"), fixture(2));
writeFileSync(join(lib, "fixtures/old-body.vrm"), fixture(1, true));
const h = await scratchSequencer("body-state", { worlds: ["body-test"], serverEnv: { EIDOVERSE_DIR: lib, DEFS_DIR: join(lib, "defs"), SKIP_OPT_SWEEP: "1" }, portFrom: 9300 });
const agents: any[] = [];
let ownerWs: WebSocket | null = null;
async function agent(name: string, avatar = "fixtures/test-body.vrm") {
  const a = new WorldAgent({ name, avatar, world: "body-test", url: h.BASE.replace("http", "ws") + "/ws" });
  agents.push(a); await a.connect(); return a as any;
}
async function read(a: any, args: any = {}) {
  const r = await handleTool({ agent: a, canPush: () => false, heldActivity: [], cursor: { caughtUpTo: null } }, "body_state", args);
  return { wire: r, ...JSON.parse(r.content[0].text) };
}
const eq = (a: any, b: any) => JSON.stringify(a) === JSON.stringify(b);
const near = (a: number[], b: number[]) => !!a && !!b && a.length === b.length && a.every((x, i) => Math.abs(x - b[i]) < 1e-6);
try {
  const owner = await agent("body-owner"), peer = await agent("body-peer");
  check("tool is registered for both doors", TOOLS.some(t => t.name === "body_state"));
  const bones = Object.fromEntries(["spine", "chest", "neck", "head", "leftUpperArm", "leftLowerArm", "rightUpperArm", "rightLowerArm"]
    .map((n, i) => [n, [0, 0, Math.sin((i + 1) / 40), Math.cos((i + 1) / 40)]]));
  owner.setPose(bones); owner.wingsFolded = true; owner.tick();
  await waitUntil("the peer's sample", () => eq(peer.people.get(owner.name)?.pose?.pose, bones));
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
  await waitUntil("the peer's sample", () => !peer.people.get(owner.name)?.pose?.pose);
  check("clear removes overrides, not the skeleton", (await read(peer, { who: owner.name })).overrides.state === "none");
  for (const clip of ["unrecognized-clip"]) {
    owner.clip = clip; owner.setPose(bones); owner.tick();
    await waitUntil("the peer's sample", () => peer.people.get(owner.name)?.pose?.clip === clip);
    const seated = await read(owner, { detail: "all", points: ["knee_r"] });
    const seen = await read(peer, { who: owner.name, detail: "contacts", points: ["knee_r"] });
    check(`${clip}: current-body geometry is withheld on the real self/peer tool path`,
      seated.wire.isError === true && seen.wire.isError === true && seen.geometry?.basis === "rest_pose_estimate"
      && !seated.joints && !seated.contacts && !seen.contacts && seen.clip === clip && eq(seated.publishedRotations, bones));
  }
  owner.clip = "idle"; owner.setPose(null); owner.tick();
  await waitUntil("the peer's sample", () => peer.people.get(owner.name)?.pose?.clip === "idle");
  // a posture clip is applied, not the standing slot reused (main's live-contact-test rows, deleted in 04c8f3a6a)
  { const standing = await read(owner, { detail: "all" });
    owner.setPosture("sitchair"); owner.tick(); await waitUntil("the peer's sample", () => peer.people.get(owner.name)?.pose?.clip === "sitchair");
    const own = await read(owner, { detail: "all" }), seen = await read(peer, { who: owner.name, detail: "all" });
    const knee = (r: any) => r.joints?.rightLowerLeg?.position, moved = (a: number[], b: number[]) => !!a && !!b && Math.hypot(...a.map((v, i) => v - b[i])) > 0.05;
    check("sitchair changes the current knee instead of reusing the standing slot, for self and peer alike",
      own.ok && seen.ok && moved(knee(own), knee(standing)) && near(knee(own), knee(seen)), JSON.stringify([knee(standing), knee(own), knee(seen)]));
    owner.setPosture("idle"); owner.tick(); await waitUntil("the peer's sample", () => peer.people.get(owner.name)?.pose?.clip === "idle"); }
  check("standing again restores contact estimates", (await read(peer, { who: owner.name, detail: "contacts", points: ["knee_r"] })).contacts?.knee_r?.quality === "anatomical_estimate");
  // Every channel of a held pose, through owner -> server -> peer -> tool. The
  // pose tool's own kneeling example used to refuse the whole body.
  const standing = await read(peer, { who: owner.name, detail: "bones" });
  const kneel = { hips: { t: [0, -0.5, 0] } };   // the pose tool's own example (mcpl/tools.ts)
  owner.setPose(kneel as any); owner.tick();
  await waitUntil("the peer's sample", () => eq(peer.people.get(owner.name)?.pose?.pose, kneel));
  const knelt = await read(peer, { who: owner.name, detail: "bones" });
  check("the pose tool's kneeling example is read, not refused", knelt.ok && eq(knelt.publishedRotations, kneel) && eq(knelt.unreadableBones, []), knelt.error);
  const standingJoints = Object.entries(standing.joints ?? {});
  check("kneeling lowers every joint by 0.5 m and moves none sideways", standing.ok && standingJoints.length >= 10 && standingJoints.every(([k, j]: [string, any]) =>
    near(knelt.joints?.[k]?.position, [j.position[0], j.position[1] - 0.5, j.position[2]])), `${standingJoints.length} joints read standing`);
  // Every bone is read as the renderer reads it (a rotation of no length is
  // the bone's rest, a scale at or below 0 collapses or mirrors it); a bone
  // with nothing usable in it costs only itself, and every reply names it.
  const turned = [0, 0, 0.2, Math.sqrt(0.96)];
  const mixed = { leftUpperArm: turned, rightUpperArm: { q: [0, 0] }, spine: [0, 0, 0, 0], leftLowerArm: { s: [1, 0, 1] }, rightLowerArm: { q: turned, s: [1, -1, 1] } };
  owner.setPose(mixed as any); owner.tick();
  await waitUntil("the peer's sample", () => eq(peer.people.get(owner.name)?.pose?.pose, mixed));
  const partial = await read(peer, { who: owner.name, detail: "bones" });
  check("a bone with nothing usable is named, and the rest of the pose is read", partial.ok
    && eq(partial.unreadableBones, ["rightUpperArm"]) && near(partial.joints?.leftUpperArm?.rotation, turned)
    && near(partial.joints?.rightLowerArm?.rotation, turned) && near(partial.joints?.spine?.rotation, [0, 0, 0, 1]),
    JSON.stringify({ ok: partial.ok, error: partial.error, unreadable: partial.unreadableBones }));
  const brief = await read(peer, { who: owner.name });
  check("...and the summary names it too", eq(brief.unreadableBones, ["rightUpperArm"])
    && brief.summary.includes("1 unreadable: rightUpperArm"), brief.summary);
  // A bone the stand-in lacks and a name every object has (constructor) are
  // named in the bones detail's unmappedBones, and the rest of the pose is read.
  const odd = { leftUpperArm: turned, tailTip: turned, constructor: turned };
  owner.setPose(odd as any); owner.tick();
  await waitUntil("the peer's sample", () => eq(peer.people.get(owner.name)?.pose?.pose, odd));
  const unmapped = await read(peer, { who: owner.name, detail: "bones" });
  check("a bone the stand-in lacks and an inherited name are named in unmappedBones, and the rest of the pose is read", unmapped.ok
    && eq([...(unmapped.unmappedBones ?? [])].sort(), ["constructor", "tailTip"]) && near(unmapped.joints?.leftUpperArm?.rotation, turned),
    JSON.stringify({ ok: unmapped.ok, error: unmapped.error, unmapped: unmapped.unmappedBones }));
  owner.setPose(null); owner.tick();
  await waitUntil("the peer's sample", () => !peer.people.get(owner.name)?.pose?.pose);
  for (const clip of ["swim", "tread"]) {
    owner.clip = clip; owner.tick();
    await waitUntil("the peer's sample", () => peer.people.get(owner.name)?.pose?.clip === clip);
    const seen = await read(peer, { who: owner.name, detail: "all", points: ["knee_r"] });
    check(`${clip}: a swimmer's body is read (the procedural stroke over idle), not withheld`,
      seen.ok && seen.contacts?.knee_r?.quality === "anatomical_estimate" && seen.poseEvaluation?.source === "procedural_swim", JSON.stringify(seen.geometry ?? seen.error));
  }
  owner.clip = "tread"; owner.tick(); await waitUntil("the peer's sample", () => peer.people.get(owner.name)?.pose?.clip === "tread");
  const tread = await read(peer, { who: owner.name, detail: "bones" });
  owner.clip = "idle"; owner.tick(); await waitUntil("the peer's sample", () => peer.people.get(owner.name)?.pose?.clip === "idle");
  const stand = await read(peer, { who: owner.name, detail: "bones" });
  check("...and treading moves the feet off where standing puts them", tread.joints?.rightLowerLeg && stand.joints?.rightLowerLeg
    && Math.hypot(...tread.joints.rightFoot.position.map((v: number, i: number) => v - stand.joints.rightFoot.position[i])) > 0.05, JSON.stringify([tread.joints?.rightFoot?.position, stand.joints?.rightFoot?.position]));
  // A swimmer's held pose wins the bones it names, as the browser lays the
  // stroke under the held pose (avatar.js _swimLayer); the stroke still moves
  // the bones the pose leaves.
  const heldArm = { leftUpperArm: turned };
  owner.clip = "tread"; owner.setPose(heldArm as any); owner.tick();
  await waitUntil("the peer's sample", () => peer.people.get(owner.name)?.pose?.clip === "tread" && eq(peer.people.get(owner.name)?.pose?.pose, heldArm));
  const posedSwimmer = await read(peer, { who: owner.name, detail: "bones" });
  check("a treading body's held pose wins the bone it names, and the stroke still moves the others", posedSwimmer.ok
    && near(posedSwimmer.joints?.leftUpperArm?.rotation, turned)
    && !!posedSwimmer.joints?.rightUpperArm?.rotation && !!stand.joints?.rightUpperArm?.rotation
    && !near(posedSwimmer.joints.rightUpperArm.rotation, stand.joints.rightUpperArm.rotation),
    JSON.stringify([posedSwimmer.joints?.leftUpperArm?.rotation, posedSwimmer.joints?.rightUpperArm?.rotation, stand.joints?.rightUpperArm?.rotation]));
  owner.clip = "idle"; owner.setPose(null); owner.tick();
  await waitUntil("the peer's sample", () => peer.people.get(owner.name)?.pose?.clip === "idle" && !peer.people.get(owner.name)?.pose?.pose);
  peer.clip = "sit"; peer.tick();
  await waitUntil("the peer's sample", () => owner.people.get(peer.name)?.pose?.clip === "sit");
  // A hand on a body whose touch gate is shut (off by default) is stripped by the relay and withdrawn by
  // the owner (agent.ts reach-refused) whenever a tick lands, racing these reads: the peer opens its gate.
  check("(setup) the peer opens its touch gate", (await peer.request("consent", { touch: true }))?.ok === true);
  const relayed = (t: any) => eq(peer.people.get(owner.name)?.pose?.reach?.rightHand?.t, t) && eq(owner.reaches.get("rightHand")?.t, t);
  owner.reaches.set("rightHand", { t: { who: peer.name, point: "knee_r" } }); owner.tick();
  await waitUntil("the relayed reach", () => relayed({ who: peer.name, point: "knee_r" }));
  const targetSeated = await read(owner, { detail: "all", points: ["hand_r"] });
  check("a reach toward an unevaluated seated body does not claim arrival or return usable targets",
    !targetSeated.ok && targetSeated.reachEvaluation?.rightHand?.ok === false && !targetSeated.contacts?.hand_r?.reachTarget);
  // Beside the peer, in no body's capsule: the three bodies share the origin, and a point inside them is body-late's to refuse.
  owner.reaches.set("rightHand", { t: { p: [-.4, 1.2, .1], space: peer.name }, palm: false }); owner.tick();
  await waitUntil("the relayed reach", () => relayed({ p: [-.4, 1.2, .1], space: peer.name }));
  check("a point in a seated body's known root frame remains usable without posture geometry",
    (await read(owner, { detail: "all" })).reachEvaluation?.rightHand?.ok === true);
  owner.releaseReach(); peer.clip = "idle"; peer.tick();
  check("(setup) the peer shuts its touch gate again", (await peer.request("consent", { touch: false }))?.ok === true);
  owner.heldPose = bones; owner.heldPoseAuthored = false; owner.clip = "idle";
  check("internal retired physics does not leak into self readback", (await read(owner)).overrides.state === "none");
  owner.clip = "ragdoll"; owner.tick();
  await waitUntil("the peer's sample", () => peer.people.get(owner.name)?.pose?.clip === "ragdoll");
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
  await waitUntil("the peer's sample", () => peer.people.get(owner.name)?.avatar === "fixtures/large-body.vrm");
  const big = await read(owner, { detail: "bones" });
  check("body replacement invalidates geometry, including scale", big.bodyGeneration.value !== generation && Math.abs(big.joints?.head?.selfPosition[1] - 3.6) < 1e-6, JSON.stringify(big.geometry));
  const old = await agent("body-vrm0", "fixtures/old-body.vrm");
  const v0 = await read(old, { detail: "bones" });
  check("VRM0 half-turn is preserved", near(v0.joints?.leftHand?.selfPosition, [-.8, 1.5, 0]));
  owner.close();
  await waitUntil("the peer's sample", () => !peer.people.has(owner.name));
  peer.notePose(owner.name, { p: [1, 0, 1], yaw: 0, speed: 0, clip: "idle" });
  check("a late frame cannot resurrect a departed body", !peer.people.has(owner.name));
  check("leave removes the public body", (await read(peer, { who: owner.name })).wire.isError === true);
  check("disconnected self is explicitly stale", (await read(owner)).freshness.status === "stale");
  const replacement = await agent("body-owner", "fixtures/test-body.vrm");
  await waitUntil("the peer's sample", () => !!peer.people.get(replacement.name)?.pose);
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

  // ---- one pipe, every field: a sender -> the server -> a peer -> body_state ----
  // The browser-shaped sender is a raw WS join plus a hand copy of client/lib/net.js sendPose's packet, no seq/t (body fields via
  // the real bodyWire); the headless sender is a real WorldAgent's tick.
  {
    const WS = h.BASE.replace("http", "ws") + "/ws", AVATAR = "fixtures/test-body.vrm", OWNER = "scale-owner";
    const call = (a: any, name: string, args: any = {}) => handleTool({ agent: a, canPush: () => false, heldActivity: [], cursor: { caughtUpTo: null } }, name, args);
    async function readAll(a: any, args: any = {}) {
      const r = await call(a, "body_state", { detail: "all", ...args });
      return { wire: r, ...JSON.parse(r.content[0].text) };
    }
    const settle = (fn: () => boolean, what: string) => waitUntil(what, fn, { ms: 5000, step: 20 });
    const sub = (a: number[], b: number[]) => a.map((v, i) => v - b[i]);
    const add = (a: number[], b: number[]) => a.map((v, i) => v + b[i]);
    const mul = (a: number[], k: number) => a.map(v => v * k);
    const close = (a: number[] | undefined, b: number[] | undefined, e = 1e-6) => !!a && !!b && a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) < e);
    const show = (v: unknown) => JSON.stringify(v, (_k, x) => typeof x === "number" ? Math.round(x * 1e4) / 1e4 : x);
    const ROOT = [3, 0, 4], YAW = Math.PI / 2;
    const ws = ownerWs = new WebSocket(WS);
    await new Promise<void>((res, rej) => {
      const t = setTimeout(() => rej(new Error("owner join timed out")), 5000);
      ws.onmessage = (ev) => { const m = JSON.parse(String(ev.data)); if (m.type === "snapshot") { clearTimeout(t); res(); } };
      ws.onopen = () => ws.send(JSON.stringify({ type: "join", hello: helloOf(), world: "body-test", id: OWNER, avatar: AVATAR, replica: true }));
    });
    // a reach onto another body is behind its touch gate, off by default (R 10-28): the owner opens it, as a browser would
    let touchOn: any = null; const prev = ws.onmessage;
    ws.onmessage = (ev) => { const m = JSON.parse(String(ev.data)); if (m.type === "reply" && m.id === "touch-on") touchOn = m; prev?.call(ws, ev); };
    ws.send(JSON.stringify({ type: "request", id: "touch-on", verb: "consent", args: { touch: true } }));
    check("(setup) the owner opens its touch gate", (await tryUntil("the consent reply", () => touchOn, { ms: 5000 }))?.ok === true, show(touchOn));
    /** A hand copy of client/lib/net.js sendPose's packet (no seq/t: sendPose itself isn't run); body fields ONLY through the real bodyWire, unless `raw`. */
    function ownerPacket(scale: unknown, extra: Record<string, unknown> = {}, raw = false) {
      const pose: Record<string, unknown> = { p: ROOT, yaw: YAW, speed: 0, clip: "idle", pitch: 0 };
      Object.assign(pose, raw ? { scale } : bodyWire({ scale, plateY: 0 }));
      Object.assign(pose, { clipTime: 0, clipTimeSlot: "idle", clipRate: 0 }, extra);
      return { type: "pose", pose };
    }
    let sent = "";
    function ownerSend(scale: unknown, extra: Record<string, unknown> = {}, raw = false) { sent = JSON.stringify(ownerPacket(scale, extra, raw)); ws.send(sent); }
    /** Send, then wait until the PEER holds a sample with that wire scale (undefined = no key) and reach bag. */
    async function ownerAt(peer: any, scale: unknown, wireScale: number | undefined, extra: Record<string, unknown> = {}, raw = false) {
      ownerSend(scale, extra, raw);
      const want = JSON.stringify(extra.reach ?? null);
      await settle(() => {
        const p = peer.people.get(OWNER)?.pose;
        return !!p && p.scale === wireScale && ("scale" in p) === (wireScale !== undefined) && JSON.stringify(p.reach ?? null) === want;
      }, `owner sample at scale ${String(scale)}`);
    }
    const peer = await agent("scale-peer");
    await call(peer, "move", { to: [1.6, 0, 4] });
    await ownerAt(peer, 1, undefined);

    // the field table: what each sender sends, what the peer's sample holds, what body_state reports
    const heldBones = { leftUpperArm: [0, 0, 0.2, Math.sqrt(0.96)], head: { t: [0, 0.1, 0] } };
    const FIELDS: { field: string; agent: ((a: any) => void) | null; raw: Record<string, unknown> | null; arrived: (s: any) => boolean; atTool: (r: any) => boolean }[] = [
      { field: "bones", agent: (a) => a.setPose(heldBones), raw: { pose: heldBones }, arrived: (s) => eq(s.pose, heldBones), atTool: (r) => eq(r.publishedRotations, heldBones) },
      { field: "yaw", agent: (a) => { a.yaw = 1.25; }, raw: { yaw: 1.25 }, arrived: (s) => s.yaw === 1.25, atTool: (r) => r.root?.yaw === 1.25 },
      { field: "clip", agent: (a) => { a.clip = "tread"; }, raw: { clip: "tread" }, arrived: (s) => s.clip === "tread", atTool: (r) => r.clip === "tread" && r.poseEvaluation?.source === "procedural_swim" },
      { field: "scale", agent: null, raw: bodyWire({ scale: 2, plateY: 0 }), arrived: (s) => s.scale === 2, atTool: (r) => r.scale === 2 && r.summary.includes("2× size") },
      { field: "named pose", agent: (a) => { a.wingsFolded = true; }, raw: { poses: ["wings-folded"] }, arrived: (s) => eq(s.poses, ["wings-folded"]), atTool: (r) => eq(r.poses, ["wings-folded"]) && r.wingsFolded === true },
    ];
    const sender = await agent("field-agent");
    const rest = () => { sender.setPose(null); sender.yaw = 0; sender.clip = "idle"; sender.wingsFolded = false; };
    for (const f of FIELDS) {
      for (const col of ["browser", "agent"] as const) {
        const who = col === "browser" ? OWNER : sender.name;
        if (col === "browser") ws.send(JSON.stringify({ type: "pose", pose: { ...ownerPacket(1).pose, ...f.raw } }));
        else if (f.agent) { f.agent(sender); sender.tick(); }
        else {   // the headless body has no chosen size: its wire never carries the key, read as 1
          sender.tick();
          await settle(() => !!peer.people.get(who)?.pose, "agent sample");
          check(`${f.field} × agent: never sent, read as the default`, !("scale" in peer.people.get(who).pose) && (await readAll(peer, { who })).scale === 1);
          continue;
        }
        const arrived = await tryUntil(`${f.field} from the ${col} sender`, () => !!peer.people.get(who)?.pose && f.arrived(peer.people.get(who).pose), { ms: 3000, step: 20 });
        const r = await readAll(peer, { who });
        check(`${f.field} × ${col}: sent, relayed, and reported by body_state`, !!arrived && f.atTool(r), show({ sample: peer.people.get(who).pose, read: { root: r.root, clip: r.clip, scale: r.scale, poses: r.poses, rot: r.publishedRotations } }));
        if (col === "agent") { rest(); sender.tick(); await settle(() => peer.people.get(who)?.pose?.clip === "idle" && !peer.people.get(who)?.pose?.pose, "agent at rest"); }
      }
    }
    sender.close();
    await ownerAt(peer, 1, undefined);

    // ---- body size's own rule: the root carries position and yaw and is never scaled; the size lives below it ----
    const plain = JSON.stringify({ type: "pose", pose: { p: ROOT, yaw: YAW, speed: 0, clip: "idle", pitch: 0, clipTime: 0, clipTimeSlot: "idle", clipRate: 0 } });
    check("an unscaled body's packet is byte-identical to one that predates body size", sent === plain, sent);
    check("…and arrives at the peer with no scale key", !("scale" in peer.people.get(OWNER).pose));
    const base = await readAll(peer, { who: OWNER });
    check("1×: the peer reads the owner's current body", base.ok && base.poseEvaluation?.source === "vrma" && base.scale === 1, show(base.error ?? base.geometry));
    check("1×: hand-computed FK — leftHand at root + yaw·(0.8, 1.5, 0)", close(base.joints?.leftHand?.position, [3, 1.5, 3.2]), show(base.joints?.leftHand?.position));
    await call(peer, "reach", { limb: "leftHand", who: OWNER, point: "hand_r", palm: false });
    await call(peer, "reach", { limb: "rightHand", x: .3, y: 1.2, z: .5, space: OWNER, palm: false });
    await peer.reaching.refreshReachReading();
    const reach1 = structuredClone(peer.reaching.reachReading.reachEvaluation);
    check("1×: the peer's reach aims at the owner's live hand_r, 2 cm off its surface",
      close(reach1.leftHand?.target, add(base.contacts.hand_r.position, mul(base.contacts.hand_r.normal, .02))), show(reach1.leftHand));
    // a point in the owner's ROOT frame, yaw π/2: (x, y, z) → (root.x + z, y, root.z − x)
    check("1×: a point in the owner's root frame resolves by root position and yaw", close(reach1.rightHand?.target, [3.5, 1.2, 3.7]), show(reach1.rightHand));
    for (const u of [0.5, 2]) {
      await ownerAt(peer, u, u);
      const r = await readAll(peer, { who: OWNER });
      check(`${u}×: scale crosses owner → server → peer → body_state`, r.ok && r.scale === u && r.summary.includes(`${u}× size`), show(r.summary));
      check(`${u}×: world root position and yaw stay exactly as sent`, r.root?.position?.every((v: number, i: number) => v === ROOT[i]) && r.root?.yaw === YAW, show(r.root));
      check(`${u}×: hand-computed FK — leftHand at root + yaw·${u}·(0.8, 1.5, 0)`, close(r.joints?.leftHand?.position, [3, 1.5 * u, 4 - .8 * u]), show(r.joints?.leftHand?.position));
      const joints = Object.keys(base.joints ?? {});
      const badJ = joints.filter(n => !close(r.joints[n]?.position, add(ROOT, mul(sub(base.joints[n].position, ROOT), u))));
      check(`${u}×: every joint (${joints.length}) is its 1× offset from the root, scaled by ${u}`, joints.length > 15 && !badJ.length, badJ.join(", "));
      const badS = joints.filter(n => !close(r.joints[n]?.selfPosition, mul(base.joints[n].selfPosition, u)));
      check(`${u}×: root-frame joint positions scale by ${u}`, !badS.length, badS.join(", "));
      const points = Object.keys(base.contacts ?? {});
      const badC = points.filter(n => !close(r.contacts[n]?.position, add(ROOT, mul(sub(base.contacts[n].position, ROOT), u))));
      check(`${u}×: every contact (${points.length}) scales about the body root`, points.length > 10 && !badC.length, badC.join(", "));
      check(`${u}×: contact normals are unchanged by a uniform size`, points.every(n => close(r.contacts[n].normal, base.contacts[n].normal)));
      await peer.reaching.refreshReachReading();
      const ev = peer.reaching.reachReading.reachEvaluation;
      const surface = add(ROOT, mul(sub(base.contacts.hand_r.position, ROOT), u));
      check(`${u}×: the peer's reach target is the scaled hand_r + the same 2 cm (absolute) standoff`,
        ev.leftHand?.ok && close(ev.leftHand.target, add(surface, mul(base.contacts.hand_r.normal, .02))), show(ev.leftHand));
      check(`${u}×: …and matches the body_state contact the peer would read itself`,
        close(ev.leftHand?.target, add(r.contacts.hand_r.position, mul(r.contacts.hand_r.normal, .02))));
      check(`${u}×: a point in the owner's root frame is the same metres at any size (browser: root.localToWorld, root unscaled)`,
        ev.rightHand?.ok && close(ev.rightHand.target, reach1.rightHand.target), show(ev.rightHand?.target));
    }
    // persistence: a late joiner gets the size from the server's remembered pose
    const lateScale = await agent("scale-late");
    await settle(() => lateScale.people.get(OWNER)?.pose?.scale === 2, "late joiner's snapshot of the owner");
    const lateRead = await readAll(lateScale, { who: OWNER, points: ["hand_r"] });
    check("a late joiner's snapshot carries the size into geometry", lateRead.ok && lateRead.scale === 2
      && close(lateRead.contacts?.hand_r?.position, add(ROOT, mul(sub(base.contacts.hand_r.position, ROOT), 2))), show(lateRead.contacts?.hand_r));
    // never trust the wire: the fence clamps, the reader clamps, absence means 1
    await ownerAt(peer, 7, 2, {}, true);
    check("an out-of-range size is clamped to 2 by the relay and read as 2", (await readAll(peer, { who: OWNER, points: ["hand_r"] })).scale === 2);
    await ownerAt(peer, "huge", undefined, {}, true);
    const garbled = await readAll(peer, { who: OWNER });
    check("a non-numeric size is dropped by the relay and reads as 1", garbled.scale === 1 && close(garbled.contacts?.hand_r?.position, base.contacts.hand_r.position));
    peer.people.get(OWNER).pose.scale = 0.1;     // a sample that never met the fence (an older relay): the reader clamps
    const tiny = await readAll(peer, { who: OWNER, points: ["hand_r"] });
    check("the reader clamps what it is handed (0.1 → 0.5), in the geometry as well as the label", tiny.scale === 0.5
      && close(tiny.contacts?.hand_r?.position, add(ROOT, mul(sub(base.contacts.hand_r.position, ROOT), .5))), show(tiny.contacts?.hand_r));
    await ownerAt(peer, 1, undefined);
    const back = await readAll(peer, { who: OWNER });
    check("returning to 1 sends nothing and restores the 1× geometry exactly", !("scale" in peer.people.get(OWNER).pose)
      && Object.keys(base.contacts).every(n => close(back.contacts[n].position, base.contacts[n].position)));
    peer.releaseReach();
    // a scaled REACHER: fixture right shoulder at (−0.2, 1.5, 0), arm 0.3 + 0.3; the target is out of reach at 1×, within at 2×
    const selfReach = { rightHand: { t: { p: [-.4, 3, 1], space: "self" }, palm: false } };
    const evals: Record<number, any> = {};
    for (const u of [1, 2]) {
      await ownerAt(peer, u, u === 1 ? undefined : u, { reach: selfReach });
      const r = await readAll(peer, { who: OWNER });
      evals[u] = r.reachEvaluation?.rightHand;
      // root frame (−0.2u, 1.5u, 0) at yaw π/2 → world (root.x + 0, 1.5u, root.z + 0.2u)
      check(`${u}× reacher: the shoulder scales about the root`, close(evals[u]?.shoulder, [3, 1.5 * u, 4 + .2 * u]), show(evals[u]));
      check(`${u}× reacher: its self-frame target is the same metres`, close(evals[u]?.target, [4, 3, 4.4]), show(evals[u]?.target));
    }
    check("a 2× arm reaches a point a 1× arm falls short of", evals[1]?.ok && !evals[1].reached && evals[1].gap > .5
      && evals[2]?.ok && evals[2].reached === true, show({ one: evals[1]?.gap, two: evals[2]?.gap }));
    // the unjoined (legacy) agent path shares one ReachBody per avatar path between bodies
    const solo = new WorldAgent({ name: "solo", avatar: AVATAR, world: "body-test", url: WS }) as any;
    solo.pos = { x: 0, y: 0, z: 0 }; solo.yaw = 0;
    const big = { id: "big", avatar: AVATAR, pose: { p: [1, 0, 0], yaw: 0, speed: 0, clip: "idle" } as any };
    solo.people.set("big", big);
    await solo.reach("leftHand", { who: "big", point: "hand_r", palm: false });
    const legacy1 = solo.reaching.reachTargetPoint({ who: "big", point: "hand_r" });
    big.pose = { ...big.pose, scale: 2 };
    const legacy2 = solo.reaching.reachTargetPoint({ who: "big", point: "hand_r" });
    const surf1 = sub(legacy1.pos, mul(legacy1.normal, .02));
    check("unjoined path: a 2× body's contact target scales about its root, standoff absolute",
      close(legacy2?.pos, add(add([1, 0, 0], mul(sub(surf1, [1, 0, 0]), 2)), mul(legacy1.normal, .02))), show({ legacy1, legacy2 }));
    const shared = solo.reaching.reachBodySync(AVATAR);
    shared.poseAt([0, 0, 0], 0, null, 1); const arm1 = shared.armLength("rightHand");
    shared.poseAt([0, 0, 0], 0, null, 2); const arm2 = shared.armLength("rightHand");
    shared.poseAt([0, 0, 0], 0, null);    const arm3 = shared.armLength("rightHand");
    check("a reused stand-in re-measures its arm when its size changes (0.6 → 1.2 → 0.6 m)",
      Math.abs(arm1 - .6) < 1e-6 && Math.abs(arm2 - 1.2) < 1e-6 && Math.abs(arm3 - .6) < 1e-6, show({ arm1, arm2, arm3 }));
    solo.close();
  }

  // Models a reader must handle on its own: `neck` named on the head's node (#272), no humanoid skeleton
  // and bytes that aren't a model (#273), each counted per download.
  const fixtureJson = () => JSON.parse(fixture().subarray(20).toString());
  const sharedNeck = fixtureJson(), humanBones = sharedNeck.extensions.VRMC_vrm.humanoid.humanBones;
  humanBones.neck.node = humanBones.head.node;
  const flat = fixtureJson(); delete flat.extensions; delete flat.extensionsUsed;
  const models = new Map<string, Uint8Array>([["shared-neck.vrm", glbOf(sharedNeck)], ["flat.vrm", glbOf(flat)],
    ["junk.vrm", new TextEncoder().encode("not a model")], ["body.vrm", fixture()]]);
  const downloads = new Map<string, number>();
  let unreachable = false;
  const library = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(req) {
    const name = decodeURIComponent(new URL(req.url).pathname).replace(/^\/library\//, "");
    downloads.set(name, (downloads.get(name) ?? 0) + 1);
    const bytes = !unreachable && models.get(name);
    return bytes ? new Response(bytes) : new Response("no", { status: unreachable ? 503 : 404 });
  } });
  const limp = (who: string, avatar: string, hips = [0, 0, 0, 1]) => ({ who, avatar, generation: 1, self: false, connected: true,
    receivedAt: Date.now(), source: "unknown" as const, pose: { p: [0, 0, 0], yaw: 0, speed: 0, clip: "ragdoll", pose: { hips } } });
  try {
    const reader = new BodyStateReader(`http://127.0.0.1:${library.port}`);
    const turned: any = await reader.read("shared", "bones", undefined, () => limp("shared", "shared-neck.vrm", [Math.SQRT1_2, 0, 0, Math.SQRT1_2]));
    check("a bone named on another bone's node follows the pose with it", near(turned.joints?.head?.position, [0, 1, 0.8]) && near(turned.joints?.neck?.position, [0, 1, 0.8]),
      JSON.stringify({ head: turned.joints?.head?.position, neck: turned.joints?.neck?.position }));
    for (const avatar of ["flat.vrm", "junk.vrm"]) {
      let last: any;
      const who = `on-${avatar}`;
      for (let i = 0; i < 3; i++) last = await reader.read(who, "bones", undefined, () => limp(who, avatar));
      check(`a model the reader can't use is downloaded once for its version (${avatar})`, downloads.get(avatar) === 1 && !last.ok && /calling again won't change that/.test(last.error),
        JSON.stringify({ downloads: downloads.get(avatar), error: last.error }));
    }
    downloads.clear();
    const scene = (id: string) => id === "reacher" ? { ...limp("reacher", "body.vrm"), pose: { ...limp("reacher", "body.vrm").pose,
      reach: { rightHand: { t: { who: "toward", point: "shoulder_l" } } } } } : id === "toward" ? limp("toward", "flat.vrm") : null;
    for (let i = 0; i < 3; i++) await reader.read("reacher", "all", undefined, scene);
    check("…and so is one a reach is toward", downloads.get("flat.vrm") === 1 && downloads.get("body.vrm") === 1, JSON.stringify(Object.fromEntries(downloads)));
    unreachable = true;
    const failed: any = await reader.read("retry", "bones", undefined, () => limp("retry", "shared-neck.vrm"));
    unreachable = false;
    const after: any = await reader.read("retry", "bones", undefined, () => limp("retry", "shared-neck.vrm"));
    check("a failed download is tried again on the next reading", !failed.ok && /couldn't be downloaded/.test(failed.error) && after.ok,
      JSON.stringify({ failed: failed.error, after: after.error }));
  } finally { library.stop(true); }
} catch (e) {
  process.exitCode = 1;
  throw e;
} finally {
  try { ownerWs?.close(); } catch { /* already closed */ }
  for (const a of agents) a.close();
  await h.cleanup(tally.failed || process.exitCode ? 1 : 0);
  rmSync(lib, { recursive: true, force: true });
}
console.log(`${tally.passed} passed, ${tally.failed} failed`);
process.exit(tally.failed ? 1 : 0);
