// A chosen body size (pose.scale, shared/presencewire.js) reaches the TEXT tier's geometry, end to end:
// a browser-shaped owner (raw WS join + the exact packet client/lib/net.js sendPose builds, body fields via the
// real bodyWire) → a scratch sequencer (its posecheck fence clamps, its lastPose persists) → a real WorldAgent
// peer → the real body_state / reach tools. No renderer, no production world.
//
//   BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun tools/body-state-scale-test.ts
//   mutations: bun tools/body-state-scale-mutation-test.ts
//
// The rule is the browser's (client/lib/avatar.js _applyBodyScale, client/lib/reachnet.js): the ROOT carries
// position and yaw and is never scaled; the size lives below it (vrm.scene / the stand-in's pivot). So:
//   - root position and yaw are exactly what the owner sent, at every size;
//   - every joint and contact sits at root + u·(its 1× offset from the root): scaled ABOUT THE ROOT;
//   - contact normals do not change, and a reach target's 2 cm standoff stays 2 cm (world metres, landmarkWorld);
//   - a point in a body's root frame (reach space: <id> | 'self') is the same metres at any size;
//   - a scaled reacher's shoulder scales about its root and its arm is u× as long;
//   - absent scale = 1, and an unscaled body's wire carries no `scale` key at all.
// Expected positions are hand-computed from the fixture skeleton (tools/body-fixture.ts) where the closed form is
// simple, and otherwise stated as the scaling relation against the same pipeline's 1× reading.
process.env.AGENT_BODY_ENGINE = "verlet";
process.env.WORLD_TOKEN = "";
const { WorldAgent } = await import("../mcpl/agent.ts");
const { handleTool } = await import("../mcpl/tools.ts");
const { bodyWire } = await import("../shared/presencewire.js");
const { scratchSequencer, mkCheck, sleep } = await import("./harness.ts");
const { fixture, postureFixture } = await import("./body-fixture.ts");
const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import("node:fs");
const { tmpdir } = await import("node:os");
const { join } = await import("node:path");
const { check, tally } = mkCheck();

const lib = mkdtempSync(join(tmpdir(), "body-scale-library-"));
mkdirSync(join(lib, "fixtures"));
mkdirSync(join(lib, "defs/animations"), { recursive: true });
writeFileSync(join(lib, "fixtures/idle.vrma"), postureFixture("idle"));
writeFileSync(join(lib, "defs/animations/idle.json"), JSON.stringify({ vrma: "fixtures/idle.vrma" }));
writeFileSync(join(lib, "fixtures/body.vrm"), fixture());
const AVATAR = "fixtures/body.vrm", WORLD = "body-scale", OWNER = "scale-owner";
const h = await scratchSequencer("body-scale", { serverEnv: { EIDOVERSE_DIR: lib, DEFS_DIR: join(lib, "defs"), SKIP_OPT_SWEEP: "1" }, portFrom: 9560 });
const WS = h.BASE.replace("http", "ws") + "/ws";

const agents: any[] = [];
async function agent(name: string) {
  const a = new WorldAgent({ name, avatar: AVATAR, world: WORLD, url: WS }) as any;
  agents.push(a); await a.connect(); return a;
}
const call = (a: any, name: string, args: any = {}) => handleTool({ agent: a, canPush: () => false, heldActivity: [], cursor: { caughtUpTo: null } }, name, args);
async function read(a: any, args: any = {}) {
  const r = await call(a, "body_state", { detail: "all", ...args });
  return { wire: r, ...JSON.parse(r.content[0].text) };
}
async function until(fn: () => boolean, what: string) {
  const end = Date.now() + 5000;
  while (!fn()) { if (Date.now() > end) throw new Error(`timed out waiting for ${what}`); await sleep(20); }
}
const sub = (a: number[], b: number[]) => a.map((v, i) => v - b[i]);
const add = (a: number[], b: number[]) => a.map((v, i) => v + b[i]);
const mul = (a: number[], k: number) => a.map(v => v * k);
const near = (a: number[] | undefined, b: number[] | undefined, e = 1e-6) => !!a && !!b && a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) < e);
const show = (v: unknown) => JSON.stringify(v, (_k, x) => typeof x === "number" ? Math.round(x * 1e4) / 1e4 : x);

// ---- the browser-shaped owner: the same join and the same pose packet a browser sends ----
const ROOT = [3, 0, 4], YAW = Math.PI / 2;
const ownerWs = new WebSocket(WS);
await new Promise<void>((res, rej) => {
  const t = setTimeout(() => rej(new Error("owner join timed out")), 5000);
  ownerWs.onmessage = (ev) => { const m = JSON.parse(String(ev.data)); if (m.type === "snapshot") { clearTimeout(t); res(); } };
  ownerWs.onopen = () => ownerWs.send(JSON.stringify({ type: "join", world: WORLD, id: OWNER, avatar: AVATAR }));
});
/** client/lib/net.js sendPose's packet, field for field; body fields ONLY through the real bodyWire, unless `raw`
 *  overrides them (a hostile/garbled sender — the fence and the readers must hold anyway). */
function ownerPacket(scale: unknown, extra: Record<string, unknown> = {}, raw = false) {
  const pose: Record<string, unknown> = { p: ROOT, yaw: YAW, speed: 0, clip: "idle", pitch: 0 };
  Object.assign(pose, raw ? { scale } : bodyWire({ scale, plateY: 0 }));
  Object.assign(pose, { clipTime: 0, clipTimeSlot: "idle", clipRate: 0 }, extra);
  return { type: "pose", pose };
}
let sent = "";
function ownerSend(scale: unknown, extra: Record<string, unknown> = {}, raw = false) {
  sent = JSON.stringify(ownerPacket(scale, extra, raw));
  ownerWs.send(sent);
}
/** Send, then wait until the PEER holds a sample with that wire scale (undefined = no key) and reach bag. */
async function ownerAt(peer: any, scale: unknown, wireScale: number | undefined, extra: Record<string, unknown> = {}, raw = false) {
  ownerSend(scale, extra, raw);
  const want = JSON.stringify(extra.reach ?? null);
  await until(() => {
    const p = peer.people.get(OWNER)?.pose;
    return !!p && p.scale === wireScale && ("scale" in p) === (wireScale !== undefined) && JSON.stringify(p.reach ?? null) === want;
  }, `owner sample at scale ${String(scale)}`);
}

try {
  const peer = await agent("scale-peer");
  await call(peer, "walk_to", { x: 1.6, z: 4 });
  await ownerAt(peer, 1, undefined);

  // ---- the wire at default: absence, byte for byte ----
  const plain = JSON.stringify({ type: "pose", pose: { p: ROOT, yaw: YAW, speed: 0, clip: "idle", pitch: 0, clipTime: 0, clipTimeSlot: "idle", clipRate: 0 } });
  check("an unscaled body's packet is byte-identical to one that predates body size", sent === plain, sent);
  check("…and arrives at the peer with no scale key", !("scale" in peer.people.get(OWNER).pose));

  const base = await read(peer, { who: OWNER });
  check("1×: the peer reads the owner's current body", base.ok && base.poseEvaluation?.source === "vrma" && base.scale === 1, show(base.error ?? base.geometry));
  check("1×: hand-computed FK — leftHand at root + yaw·(0.8, 1.5, 0)", near(base.joints?.leftHand?.position, [3, 1.5, 3.2]), show(base.joints?.leftHand?.position));
  await call(peer, "reach", { limb: "leftHand", who: OWNER, point: "hand_r", palm: false });
  await call(peer, "reach", { limb: "rightHand", x: .3, y: 1.2, z: .5, space: OWNER, palm: false });
  await peer.refreshReachReading();
  const reach1 = structuredClone(peer.reachReading.reachEvaluation);
  check("1×: the peer's reach aims at the owner's live hand_r, 2 cm off its surface",
    near(reach1.leftHand?.target, add(base.contacts.hand_r.position, mul(base.contacts.hand_r.normal, .02))), show(reach1.leftHand));
  // a point in the owner's ROOT frame, yaw π/2: (x, y, z) → (root.x + z, y, root.z − x)
  check("1×: a point in the owner's root frame resolves by root position and yaw", near(reach1.rightHand?.target, [3.5, 1.2, 3.7]), show(reach1.rightHand));

  for (const u of [0.5, 2]) {
    await ownerAt(peer, u, u);
    const r = await read(peer, { who: OWNER });
    check(`${u}×: scale crosses owner → server → peer → body_state`, r.ok && r.scale === u && r.summary.includes(`${u}× size`), show(r.summary));
    check(`${u}×: world root position and yaw stay exactly as sent`, r.root?.position?.every((v: number, i: number) => v === ROOT[i]) && r.root?.yaw === YAW, show(r.root));
    check(`${u}×: hand-computed FK — leftHand at root + yaw·${u}·(0.8, 1.5, 0)`, near(r.joints?.leftHand?.position, [3, 1.5 * u, 4 - .8 * u]), show(r.joints?.leftHand?.position));
    const joints = Object.keys(base.joints ?? {});
    const badJ = joints.filter(n => !near(r.joints[n]?.position, add(ROOT, mul(sub(base.joints[n].position, ROOT), u))));
    check(`${u}×: every joint (${joints.length}) is its 1× offset from the root, scaled by ${u}`, joints.length > 15 && !badJ.length, badJ.join(", "));
    const badS = joints.filter(n => !near(r.joints[n]?.selfPosition, mul(base.joints[n].selfPosition, u)));
    check(`${u}×: root-frame joint positions scale by ${u}`, !badS.length, badS.join(", "));
    const points = Object.keys(base.contacts ?? {});
    const badC = points.filter(n => !near(r.contacts[n]?.position, add(ROOT, mul(sub(base.contacts[n].position, ROOT), u))));
    check(`${u}×: every contact (${points.length}) scales about the body root`, points.length > 10 && !badC.length, badC.join(", "));
    check(`${u}×: contact normals are unchanged by a uniform size`, points.every(n => near(r.contacts[n].normal, base.contacts[n].normal)));

    await peer.refreshReachReading();
    const ev = peer.reachReading.reachEvaluation;
    const surface = add(ROOT, mul(sub(base.contacts.hand_r.position, ROOT), u));
    check(`${u}×: the peer's reach target is the scaled hand_r + the same 2 cm (absolute) standoff`,
      ev.leftHand?.ok && near(ev.leftHand.target, add(surface, mul(base.contacts.hand_r.normal, .02))), show(ev.leftHand));
    check(`${u}×: …and matches the body_state contact the peer would read itself`,
      near(ev.leftHand?.target, add(r.contacts.hand_r.position, mul(r.contacts.hand_r.normal, .02))));
    check(`${u}×: a point in the owner's root frame is the same metres at any size (browser: root.localToWorld, root unscaled)`,
      ev.rightHand?.ok && near(ev.rightHand.target, reach1.rightHand.target), show(ev.rightHand?.target));
  }

  // ---- persistence: a late joiner gets the size from the server's remembered pose ----
  const late = await agent("scale-late");
  await until(() => late.people.get(OWNER)?.pose?.scale === 2, "late joiner's snapshot of the owner");
  const lateRead = await read(late, { who: OWNER, points: ["hand_r"] });
  check("a late joiner's snapshot carries the size into geometry", lateRead.ok && lateRead.scale === 2
    && near(lateRead.contacts?.hand_r?.position, add(ROOT, mul(sub(base.contacts.hand_r.position, ROOT), 2))), show(lateRead.contacts?.hand_r));

  // ---- never trust the wire: the fence clamps, the reader clamps, absence means 1 ----
  await ownerAt(peer, 7, 2, {}, true);
  check("an out-of-range size is clamped to 2 by the relay and read as 2", (await read(peer, { who: OWNER, points: ["hand_r"] })).scale === 2);
  await ownerAt(peer, "huge", undefined, {}, true);
  const garbled = await read(peer, { who: OWNER });
  check("a non-numeric size is dropped by the relay and reads as 1", garbled.scale === 1 && near(garbled.contacts?.hand_r?.position, base.contacts.hand_r.position));
  peer.people.get(OWNER).pose.scale = 0.1;     // a sample that never met the fence (an older relay): the reader clamps
  const tiny = await read(peer, { who: OWNER, points: ["hand_r"] });
  check("the reader clamps what it is handed (0.1 → 0.5), in the geometry as well as the label", tiny.scale === 0.5
    && near(tiny.contacts?.hand_r?.position, add(ROOT, mul(sub(base.contacts.hand_r.position, ROOT), .5))), show(tiny.contacts?.hand_r));
  await ownerAt(peer, 1, undefined);
  const back = await read(peer, { who: OWNER });
  check("returning to 1 sends nothing and restores the 1× geometry exactly", !("scale" in peer.people.get(OWNER).pose)
    && Object.keys(base.contacts).every(n => near(back.contacts[n].position, base.contacts[n].position)));
  peer.releaseReach();

  // ---- a scaled REACHER: the owner's own arm, evaluated by the peer ----
  // Fixture right shoulder joint (rightUpperArm) at (−0.2, 1.5, 0) authored; arm 0.3 + 0.3 to the wrist. The target,
  // in the owner's own root frame, is 1 m ahead of where a 2× shoulder sits: out of reach at 1×, within reach at 2×.
  const selfReach = { rightHand: { t: { p: [-.4, 3, 1], space: "self" }, palm: false } };
  const evals: Record<number, any> = {};
  for (const u of [1, 2]) {
    await ownerAt(peer, u, u === 1 ? undefined : u, { reach: selfReach });
    const r = await read(peer, { who: OWNER });
    evals[u] = r.reachEvaluation?.rightHand;
    // root frame (−0.2u, 1.5u, 0) at yaw π/2 → world (root.x + 0, 1.5u, root.z + 0.2u)
    check(`${u}× reacher: the shoulder scales about the root`, near(evals[u]?.shoulder, [3, 1.5 * u, 4 + .2 * u]), show(evals[u]));
    check(`${u}× reacher: its self-frame target is the same metres`, near(evals[u]?.target, [4, 3, 4.4]), show(evals[u]?.target));
  }
  check("a 2× arm reaches a point a 1× arm falls short of", evals[1]?.ok && !evals[1].reached && evals[1].gap > .5
    && evals[2]?.ok && evals[2].reached === true, show({ one: evals[1]?.gap, two: evals[2]?.gap }));

  // ---- the unjoined (legacy) agent path shares one ReachBody per avatar path between bodies ----
  const solo = new WorldAgent({ name: "solo", avatar: AVATAR, world: WORLD, url: WS }) as any;
  solo.pos = { x: 0, y: 0, z: 0 }; solo.yaw = 0;
  const big = { id: "big", avatar: AVATAR, pose: { p: [1, 0, 0], yaw: 0, speed: 0, clip: "idle" } as any };
  solo.people.set("big", big);
  await solo.reach("leftHand", { who: "big", point: "hand_r", palm: false });
  const legacy1 = solo.reachTargetPoint({ who: "big", point: "hand_r" });
  big.pose = { ...big.pose, scale: 2 };
  const legacy2 = solo.reachTargetPoint({ who: "big", point: "hand_r" });
  const surf1 = sub(legacy1.pos, mul(legacy1.normal, .02));
  check("unjoined path: a 2× body's contact target scales about its root, standoff absolute",
    near(legacy2?.pos, add(add([1, 0, 0], mul(sub(surf1, [1, 0, 0]), 2)), mul(legacy1.normal, .02))), show({ legacy1, legacy2 }));
  const shared = solo.reachBodySync(AVATAR);
  shared.poseAt([0, 0, 0], 0, null, 1); const arm1 = shared.armLength("rightHand");
  shared.poseAt([0, 0, 0], 0, null, 2); const arm2 = shared.armLength("rightHand");
  shared.poseAt([0, 0, 0], 0, null);    const arm3 = shared.armLength("rightHand");
  check("a reused stand-in re-measures its arm when its size changes (0.6 → 1.2 → 0.6 m)",
    Math.abs(arm1 - .6) < 1e-6 && Math.abs(arm2 - 1.2) < 1e-6 && Math.abs(arm3 - .6) < 1e-6, show({ arm1, arm2, arm3 }));
  solo.close();
} catch (e) {
  process.exitCode = 1;
  throw e;
} finally {
  try { ownerWs.close(); } catch { /* already closed */ }
  for (const a of agents) a.close();
  await h.cleanup(tally.failed || process.exitCode ? 1 : 0);
  rmSync(lib, { recursive: true, force: true });
}
console.log(`${tally.passed} passed, ${tally.failed} failed`);
process.exit(tally.failed ? 1 : 0);
