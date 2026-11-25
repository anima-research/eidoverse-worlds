// named-pose-test: every registered pose name (plus a synthetic one on the wire rows) through every owner and reader; shared/wingpresence.js.
// Run: BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun test/client/named-pose-test.ts (the browser parts re-run this file with --part, for their own mocks)
import { noWorldUrl } from "../harness/no-world.ts";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { helloOf } from "../../shared/protocol/hello.js";

const part = process.argv.includes("--part") ? process.argv[process.argv.indexOf("--part") + 1] : "wire";
const { mkCheck } = await import("../harness/harness.ts");
const { until: waitUntil } = await import("../gate/wait.ts");
const { check, tally } = mkCheck();
const WP: any = await import("../../shared/wingpresence.js");
const { WINGS_FOLDED, MAX_NAMED_POSES, POSE_NAME_RE, cleanPoses, foldedIn, wingFoldPresence, applyWingFoldPresence, applyOwnedWingFold } = WP;
const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const SYNTHETIC = "held-synthetic";   // a valid name no owner strikes: the wire must carry it like any other
const WING_BONES = ["L_Wing_Upper", "L_Wing_Upper_1", "R_Wing_Upper", "R_Wing_Upper_1", "L_Wing_Lower", "R_Wing_Lower"];

/** One row per pose an owner can strike: how each owner strikes and releases it, and what holding it looks like. */
type Registered = {
  name: string;
  encode: (held: boolean) => unknown;                    // the owners' shared encoder
  headless: { strike: (ag: any) => Promise<void>; release: (ag: any) => Promise<void>; held: (ag: any) => boolean };
  browser: { toggle: () => void; held: () => boolean };  // set in the browser-owner part
  rendered: (avatar: any) => boolean;                   // what a renderer shows once it applied the sample
  restoredOwn: (restore: any) => boolean;                // what an owner reads back from its own restore sample
};
const REGISTERED: Registered[] = [{
  name: WINGS_FOLDED,
  encode: (held) => wingFoldPresence(held),
  headless: {
    strike: async (ag) => { await door(ag, "anim", { name: WINGS_FOLDED }); },
    release: async (ag) => { await door(ag, "anim", { stop: WINGS_FOLDED }); },
    held: (ag) => ag.wingsFolded === true,
  },
  browser: { toggle: () => { throw new Error("browser part only"); }, held: () => false },
  rendered: (av) => av.wingsFolded === true,
  restoredOwn: (r) => foldedIn(r) === true,
}];
const WIRE_NAMES = [...REGISTERED.map((r) => r.name), SYNTHETIC];
let handleTool: any = null;
async function door(ag: any, tool: string, args: any) {
  return handleTool({ agent: ag, canPush: () => false, heldActivity: [], cursor: { caughtUpTo: null } }, tool, args);
}
const text = (r: any) => r?.content?.map((c: any) => c.text).join("\n") ?? "";

if (part === "wire") await wirePart();
else if (part === "browser-owner") await browserOwnerPart();
else if (part === "remote") await remotePart();
else throw new Error(`unknown part ${part}`);
console.log(`${tally.passed} passed, ${tally.failed} failed`);
process.exit(tally.failed ? 1 : 0);

// ---------------------------------------------------------------- the wire, the server, the headless owner
async function wirePart() {
  process.env.AGENT_BODY_ENGINE = "verlet";
  process.env.WORLD_TOKEN = "";
  const { WorldAgent } = await import("../../mcpl/agent.ts");
  ({ handleTool } = await import("../../mcpl/tools.ts"));
  const { scratchSequencer } = await import("../harness/harness.ts");
  const { fixture, postureFixture } = await import("../fixtures/body-fixture.ts");
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");

  console.log("\nREGISTRY");
  const { ANIM_MODES } = await import("../../mcpl/tools.ts");
  const known = Object.entries(ANIM_MODES).filter(([, m]) => m === "hold").map(([n]) => n);   // a named pose is the door's held anim
  check("every pose the door holds by name has a row here", known.length > 0 && eq([...known].sort(), REGISTERED.map((r) => r.name).sort()), JSON.stringify(known));
  for (const n of WIRE_NAMES) check(`${n}: a name in the wire grammar`, POSE_NAME_RE.test(n));

  console.log("\nTHE FIELD (every name)");
  for (const r of REGISTERED) {
    check(`${r.name}: holding it encodes {poses: [name]}`, eq(r.encode(true), { poses: [r.name] }), JSON.stringify(r.encode(true)));
    check(`${r.name}: releasing it encodes an explicit empty list (absence is not release)`, eq(r.encode(false), { poses: [] }));
  }
  for (const n of WIRE_NAMES) {
    check(`${n}: the fence keeps it, once`, eq(cleanPoses([n]), [n]) && eq(cleanPoses([n, n]), [n]));
    check(`${n}: the fence keeps it beside other names`, eq(cleanPoses([n, ...WIRE_NAMES.filter((x) => x !== n)]), [n, ...WIRE_NAMES.filter((x) => x !== n)]));
    const many = [n, ...Array.from({ length: MAX_NAMED_POSES }, (_, i) => `extra-${i}`)];
    check(`${n}: more than ${MAX_NAMED_POSES} names, a bad name or a non-string drops the list`, cleanPoses(many) === undefined
      && cleanPoses([n, "9bad"]) === undefined && cleanPoses([n, 7]) === undefined && cleanPoses(n) === undefined);
  }

  console.log("\nTHE WINGS READER (one consumer of the list)");
  const av: any = { wingsFolded: false };
  check("a list holding wings-folded among other names reads as folded", foldedIn({ poses: [SYNTHETIC, WINGS_FOLDED] }) === true);
  check("a list holding only another name reads as open, not as absence", foldedIn({ poses: [SYNTHETIC] }) === false);
  check("remote renderer consumes fold", applyWingFoldPresence(av, { poses: [WINGS_FOLDED] }) && av.wingsFolded);
  check("remote renderer consumes unfold", applyWingFoldPresence(av, { poses: [] }) && !av.wingsFolded);
  check("an older sample's boolean wingsFolded still reads as the pose", applyWingFoldPresence(av, { wingsFolded: true }) && av.wingsFolded
    && applyWingFoldPresence(av, { wingsFolded: false }) && !av.wingsFolded);
  check("legacy/absent field abstains", !applyWingFoldPresence(av, {}) && !av.wingsFolded && foldedIn(null) === null);
  const ownState: any = { wingsFolded: false }, ownAvatar: any = { wingsFolded: false };
  applyOwnedWingFold(ownState, ownAvatar, true);
  check("the owner operation joins local rig state to the wire field", ownAvatar.wingsFolded === true && wingFoldPresence(ownState.wingsFolded).poses.includes(WINGS_FOLDED));

  console.log("\nTHE BROWSER'S OWN RECONNECT (client/main.js onRestore, executed)");
  const onRestore = mainOnRestore();
  for (const r of REGISTERED) {
    const held = (sample: any) => { const got: boolean[] = []; onRestore(sample, (v: boolean) => got.push(v)); return got.at(-1); };
    check(`${r.name}: a restore holding it restores it`, held({ p: [0, 0, 0], yaw: 0, clip: "idle", poses: [SYNTHETIC, r.name] }) === true);
    check(`${r.name}: a restore without it releases it`, held({ p: [0, 0, 0], yaw: 0, clip: "idle", poses: [SYNTHETIC] }) === false);
  }
  { const got: boolean[] = []; onRestore({ p: [0, 0, 0], yaw: 0, clip: "idle", wingsFolded: true }, (v: boolean) => got.push(v));
    check("an older restore's boolean wingsFolded restores the fold", got.at(-1) === true); }

  console.log("\nWINGS: POSTURE IS NOT PROPULSION");
  const ag: any = new WorldAgent({ url: noWorldUrl(), name: "mythos", world: "pose-bench" });
  ag.bodyBoneNames = ["Hip", "Spine02", "Head", ...WING_BONES];
  ag.loadBodyBones = async () => ag.bodyBoneNames;
  ag.myRights = { role: "builder", fly: false };
  const folded = await ag.foldWings(true);
  check("headless body folds without a fly grant", ag.wingsFolded === true && folded.ok && /wings folded/.test(folded.text), folded.text);
  check("a ground posture does not create a position-owning flight integrator", ag.flight == null);
  const denied = await ag.takeOff();
  check("takeoff remains separately denied", !denied.ok && /cannot fly|not granted/.test(denied.text), denied.text);
  ag.myRights = { role: "builder", fly: true };
  const whileFolded = await ag.takeOff();
  check("a granted body still cannot take off while folded", !whileFolded.ok && /your wings are folded/.test(whileFolded.text), whileFolded.text);
  const opened = await ag.foldWings(false);
  check("and unfolds without granting propulsion", ag.wingsFolded === false && opened.ok && /wings open/.test(opened.text), opened.text);
  ag.myRights = { role: "builder", fly: false };
  ag.wingsFolded = true; ag.flight = null;
  const deniedUnfold = await ag.foldWings(false);
  check("unfold tells the truth when propulsion remains denied, and is done", deniedUnfold.ok && /still not granted/.test(deniedUnfold.text), deniedUnfold.text);
  ag.myRights = { role: "builder", fly: true };
  const tookOff = await ag.takeOff();
  check("after unfold, a granted body can take off", tookOff.ok && /took off/.test(tookOff.text), tookOff.text);
  const wingless: any = new WorldAgent({ url: noWorldUrl(), name: "wingless", world: "pose-bench" });
  wingless.bodyBoneNames = ["Hip", "Spine02", "Head"];
  wingless.loadBodyBones = async () => wingless.bodyBoneNames;
  const winglessFold = await wingless.foldWings(true);
  check("a wingless rig fails honestly", !winglessFold.ok && /no animatable wings/.test(winglessFold.text), winglessFold.text);
  wingless.wingsFolded = true;
  const released = await wingless.foldWings(false);
  check("a wingless swap can always release a carried folded posture", released.ok && /posture released/.test(released.text) && wingless.wingsFolded === false, released.text);
  const foldActs: string[] = [];
  const watcher: any = new WorldAgent({ url: noWorldUrl(), name: "watcher", world: "pose-bench" });
  watcher.gate = { act: (_id: string, key: string) => foldActs.push(key) };
  const still = { p: [0, 0, 0], yaw: 0, speed: 0, clip: "idle" };
  watcher.senses.noteActs("mythos", null, { ...still, poses: [WINGS_FOLDED] });
  check("first sighting establishes a fold baseline without inventing an act", foldActs.length === 0);
  watcher.senses.noteActs("mythos", { ...still, poses: [SYNTHETIC] }, { ...still, poses: [SYNTHETIC, WINGS_FOLDED] });
  check("an observed explicit edge announces the fold once, beside another pose", eq(foldActs, ["wings-fold"]), JSON.stringify(foldActs));

  // ---- through a real sequencer: owner -> server -> peer -> text tier, late join, reconnect ----
  const lib = mkdtempSync(join(tmpdir(), "named-pose-library-"));
  mkdirSync(join(lib, "fixtures"));
  mkdirSync(join(lib, "defs/animations"), { recursive: true });
  writeFileSync(join(lib, "fixtures/idle.vrma"), postureFixture("idle"));
  writeFileSync(join(lib, "defs/animations/idle.json"), JSON.stringify({ vrma: "fixtures/idle.vrma" }));
  writeFileSync(join(lib, "fixtures/body.vrm"), fixture());
  const AVATAR = "fixtures/body.vrm", WORLD = "pose-test";
  const h = await scratchSequencer("named-pose", { worlds: [WORLD], serverEnv: { EIDOVERSE_DIR: lib, DEFS_DIR: join(lib, "defs"), SKIP_OPT_SWEEP: "1", TRUST_NAMES: "1" }, portFrom: 9640 });
  const WS = h.BASE.replace("http", "ws") + "/ws";
  const agents: any[] = [], sockets: WebSocket[] = [];
  async function agent(name: string) {
    const a: any = new WorldAgent({ name, avatar: AVATAR, world: WORLD, url: WS });
    agents.push(a); await a.connect(); return a;
  }
  const settle = (fn: () => boolean, what: string) => waitUntil(what, fn, { ms: 5000, step: 20 });
  /** A browser-shaped owner: raw join, then the pose packets client/lib/net.js sendPose sends. */
  async function rawOwner(id: string) {
    const ws = new WebSocket(WS); sockets.push(ws);
    const snap: any = await new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error(`${id} join timed out`)), 5000);
      ws.onmessage = (ev) => { const m = JSON.parse(String(ev.data)); if (m.type === "snapshot") { clearTimeout(t); res(m); } };
      ws.onopen = () => ws.send(JSON.stringify({ type: "join", hello: helloOf(), world: WORLD, id, avatar: AVATAR, replica: true }));
    });
    let n = 0;
    const send = (extra: Record<string, unknown>) => ws.send(JSON.stringify({ type: "pose", pose: { p: [2, 0, 2], yaw: 0, speed: 0, clip: "idle", pitch: 0, mark: ++n, ...extra } }));
    return { ws, snap, send, mark: () => n };
  }
  const sampleOf = (peer: any, id: string) => peer.people.get(id)?.pose;
  const read = async (peer: any, who: string) => JSON.parse(text(await door(peer, "body_state", { who })));
  try {
    const peer = await agent("pose-peer");

    console.log("\nTHE WIRE THROUGH A SERVER (every name, a browser-shaped owner)");
    for (const n of WIRE_NAMES) {
      const id = `raw-${n}`;
      const o = await rawOwner(id);
      o.send({ poses: [n] });
      await settle(() => sampleOf(peer, id)?.mark === o.mark(), `${n} sample`);
      check(`${n}: holding it reaches the peer as {poses: [name]}`, eq(sampleOf(peer, id)?.poses, [n]), JSON.stringify(sampleOf(peer, id)));
      const held = await read(peer, id);
      check(`${n}: the text tier's body_state reports it held`, eq(held.poses, [n]), JSON.stringify(held.poses));
      o.send({ poses: [n, ...WIRE_NAMES.filter((x) => x !== n)] });
      await settle(() => sampleOf(peer, id)?.mark === o.mark(), `${n} mixed sample`);
      check(`${n}: it rides beside the other names`, eq(sampleOf(peer, id)?.poses, [n, ...WIRE_NAMES.filter((x) => x !== n)]), JSON.stringify(sampleOf(peer, id)?.poses));
      o.send({ poses: [n] });
      await settle(() => sampleOf(peer, id)?.mark === o.mark(), `${n} re-held`);
      const late = await agent(`late-${n}`);
      await settle(() => !!sampleOf(late, id), `${n} late snapshot`);
      check(`${n}: a late joiner's snapshot still holds it (the server's settled pose)`, eq(sampleOf(late, id)?.poses, [n]), JSON.stringify(sampleOf(late, id)));
      o.send({ poses: [n, 7] });
      await settle(() => sampleOf(peer, id)?.mark === o.mark(), `${n} fenced sample`);
      check(`${n}: a garbled list is dropped by the fence, the packet still arrives`, !("poses" in sampleOf(peer, id)), JSON.stringify(sampleOf(peer, id)));
      o.send({ poses: [n] });
      await settle(() => sampleOf(peer, id)?.mark === o.mark(), `${n} held before leaving`);
      o.ws.close();
      await settle(() => !peer.people.has(id), `${n} owner gone`);
      const back = await rawOwner(id);
      check(`${n}: the owner's own reconnect is handed it back (restore)`, eq(back.snap.restore?.poses, [n]), JSON.stringify(back.snap.restore));
      back.send({ poses: [] });
      await settle(() => sampleOf(peer, id)?.mark === back.mark(), `${n} released`);
      check(`${n}: releasing it arrives as an explicit empty list`, eq(sampleOf(peer, id)?.poses, []), JSON.stringify(sampleOf(peer, id)));
      check(`${n}: …and body_state reports nothing held`, eq((await read(peer, id)).poses, []));
      back.ws.close();
    }

    console.log("\nTHE HEADLESS OWNER (every registered name)");
    for (const r of REGISTERED) {
      const owner: any = await agent(`headless-${r.name}`);
      owner.bodyBoneNames = ["Hip", "Spine02", "Head", ...WING_BONES];
      owner.loadBodyBones = async () => owner.bodyBoneNames;
      owner.myRights = { role: "member", fly: false };
      await r.headless.strike(owner);
      owner.tick();
      await settle(() => sampleOf(peer, owner.name)?.poses?.includes(r.name), `${r.name} headless strike`);
      check(`${r.name}: the door strikes it without any grant, and the real tick puts it on the wire`, r.headless.held(owner)
        && !("wingsFolded" in sampleOf(peer, owner.name)), JSON.stringify(sampleOf(peer, owner.name)));
      const seen = await read(peer, owner.name);
      check(`${r.name}: perception reports the public silhouette`, seen.poses?.includes(r.name) && (r.name !== WINGS_FOLDED || /wings folded/.test(seen.summary)), seen.summary);
      owner.close();
      await settle(() => !peer.people.has(owner.name), `${r.name} headless gone`);
      const again: any = await agent(owner.name);
      check(`${r.name}: a headless reconnect restores its own held pose`, r.headless.held(again));
      again.tick();
      await settle(() => sampleOf(peer, again.name)?.poses?.includes(r.name), `${r.name} after reconnect`);
      check(`${r.name}: …and its next tick still carries it`, sampleOf(peer, again.name).poses.includes(r.name));
      again.bodyBoneNames = owner.bodyBoneNames; again.loadBodyBones = owner.loadBodyBones;
      await r.headless.release(again);
      again.tick();
      await settle(() => eq(sampleOf(peer, again.name)?.poses, []), `${r.name} headless release`);
      check(`${r.name}: release goes out as an explicit empty list`, !r.headless.held(again) && eq(sampleOf(peer, again.name).poses, []));
    }
  } finally {
    for (const s of sockets) { try { s.close(); } catch { /* closed */ } }
    for (const a of agents) a.close();
    await h.cleanup(tally.failed ? 1 : 0);
    rmSync(lib, { recursive: true, force: true });
  }

  for (const p of ["browser-owner", "remote"]) await child(p);
}

/** client/main.js's own onRestore callback, lifted out of the file and run against stubs; calls setFolded. */
function mainOnRestore() {
  const src = readFileSync(join(import.meta.dir, "../../client/main.js"), "utf8");
  const at = src.indexOf("onRestore: (r) => {");
  if (at < 0) throw new Error("client/main.js onRestore not found");
  let i = src.indexOf("{", at), depth = 0, end = -1;
  for (; i < src.length; i++) { if (src[i] === "{") depth++; else if (src[i] === "}" && --depth === 0) { end = i + 1; break; } }
  const body = src.slice(src.indexOf("(r) =>", at), end);
  const make = new Function("deps", `with (deps) { return ${body}; }`);
  const { readBodyMode } = require("../../shared/bodymode.js");
  return (sample: any, setFolded: (v: boolean) => void) => {
    const deps: any = { restoredPosition: false, myState: { pos: { y: 0, set() {} } }, setCamYaw() {}, setPosture() {}, holdHeightUntilSolid() {}, readBodyMode, foldedIn, setFolded };
    make(deps)(sample);
  };
}

async function child(p: string) {
  console.log(`\n---- part ${p} (its own process) ----`);
  const c = Bun.spawn([process.execPath, import.meta.path, "--part", p], { cwd: join(import.meta.dir, "..", ".."), env: process.env, stdout: "pipe", stderr: "pipe" });
  const [code, out, err] = await Promise.all([c.exited, new Response(c.stdout).text(), new Response(c.stderr).text()]);
  process.stdout.write(out);
  if (code) process.stdout.write(err.slice(-3000));
  const m = /(\d+) passed, (\d+) failed\s*$/.exec(out);
  tally.passed += m ? Number(m[1]) : 0;
  tally.failed += m ? Number(m[2]) : 0;
  check(`part ${p} exits cleanly`, code === 0 && !!m, `exit ${code}`);
}

// ---------------------------------------------------------------- the browser owner: controller key path, swaps
async function browserOwnerPart() {
  const { GlobalRegistrator } = await import("@happy-dom/global-registrator");
  GlobalRegistrator.register();
  globalThis.fetch = (async () => new Response("[]")) as any;   // mybody.js's roster read
  const { mock } = await import("bun:test");
  const THREE = await import("../../client/node_modules/three/build/three.module.js");
  const TSL = await import("../../client/node_modules/three/build/three.tsl.js");
  const base = import.meta.dir + "/../../client/lib/";
  const hints: string[] = [];
  const handlers = new Map<string, Function[]>();
  const bus = {
    on(t: string, f: Function) { if (!handlers.has(t)) handlers.set(t, []); handlers.get(t)!.push(f); return () => {}; },
    emit(t: string, p: any) { for (const f of handlers.get(t) ?? []) f(p); },
  };
  const canvas = Object.assign(document.createElement("canvas"), { requestPointerLock() {} });
  const realBase: any = await import(base + "base.js");
  const BENCH_CONFIG = { ...realBase.CONFIG, name: "owner", world: "bench" };
  mock.module(base + "core.js", () => ({
    THREE, TSL, camera: new THREE.PerspectiveCamera(), canvas, CONFIG: BENCH_CONFIG,
    angleDelta: (a: number, b: number) => b - a, bus, scene: new THREE.Scene(), renderer: {}, report() {},
    sun: new THREE.DirectionalLight(), ground: new THREE.Mesh(), hemi: new THREE.HemisphereLight(), grid: new THREE.Group(),
    BASE_PIXEL_RATIO: 1, DESKTOP_FOV: 55,
  }));
  mock.module(base + "base.js", () => ({ ...realBase, CONFIG: BENCH_CONFIG, bus, report() {}, tee() {} }));
  mock.module(base + "terrain.js", () => ({ heightAt: () => 0, setWaterField() {}, rainSurfaceAt: () => 0 }));
  mock.module(base + "colliders.js", () => ({ resolveColliders: () => 0, lastBlockedTop: () => 0, findSeat: () => null, raySegment: () => null,
    frameOf: () => null, lastContacts: () => [], colliders: new Map() }));
  mock.module(base + "arrivalhold.js", () => ({ heightHeld: () => false, holdHeightUntilSolid() {} }));   // the arrival hold reads the models realizer, which is not under test
  mock.module(base + "assets.js", () => ({ forgetBytes() {}, primeFiles: async () => {} }));
  mock.module(base + "world.js", () => ({ avatarMounts: new Map() }));
  mock.module(base + "state.js", () => ({ state: { st: { entities: {}, roles: {}, recentChat: [] }, lastSeq: -1, hydrated: false }, hydrate() {}, applyView() {}, reset() {}, onWorldChange: () => () => {} }));
  mock.module(base + "render/scheduler.js", () => ({ pending: new Map(), P: {} }));
  mock.module(base + "player/remotes.js", () => ({ remotes: new Map(), ensureRemote: async () => null, dropRemote: () => null, pushPose() {}, noteServerTime() {}, noteSpeaking() {} }));
  mock.module(base + "player/reachnet.js", () => ({ myReachBag: () => undefined }));
  mock.module(base + "ui/chat.js", () => ({ chat: {}, logChat() {}, noteTyping() {}, noteHistoryContext() {}, async resyncChatAfter() {}, moderatorHeader: (w) => `From a moderator of world ‹${w}›, not from Eidoverse` }));
  mock.module(base + "avatar/fp_view.js", () => ({ resolveFirstPersonAnchor: () => null, FP_FORWARD: 0, FP_EYE_LIFT: 0, FP_GAZE_AHEAD: 0, FP_GAZE_DROP: 0, composeFirstPerson() {} }));
  mock.module(base + "boot.js", () => ({ markPhase() {}, refuseBoot() {}, waitBoot() {} }));
  const { html } = await import(base + "ui/markup.js");
  mock.module(base + "ui/ui.js", () => ({ isOverlayOpen: () => false, flashHint: (s: any) => hints.push(String(s)), toast() {}, html }));
  const bodies: any[] = [];
  const body = (bones: string[]) => { const scene = new THREE.Group(); for (const n of bones) { const b: any = new THREE.Bone(); b.name = n; scene.add(b); }
    const av: any = { wingsFolded: false, vrm: { scene }, dispose() {}, setUserScale() {}, setPlateY() {} }; bodies.push(av); return av; };
  mock.module(base + "avatar/avatar.js", () => ({ makeAvatar: async () => body(WING_BONES) }));
  mock.module(base + "avatar/avatar-thumbnail.js", () => ({ contributeThumbnail() {} }));
  mock.module(base + "render/materials.js", () => ({ applyOwnBodyShadow: async () => {} }));
  let onSwitch: any = null;   // catalog.js's switch seam, as it is: one handler, mybody.js's
  const catalog = { setMyAvatarPath() {}, wireAvatarSwitch(fn: any) { onSwitch = fn; }, switchAvatar: (p: string, n: string) => onSwitch?.(p, n) };
  mock.module(base + "edit/catalog.js", () => catalog);

  const controller: any = await import("../../client/lib/player/controller.js");
  const netmod: any = await import("../../client/lib/net.js");
  const mybody: any = await import("../../client/lib/player/mybody.js");
  let owner: any = body(WING_BONES);
  controller.setMeHook(() => owner);
  controller.setRightsHook(() => ({ role: "member", can: [] }));
  controller.armFlight(WING_BONES, "owner");
  const sent: string[] = [];
  netmod.net.joined = true;
  netmod.net.ws = { readyState: 1, send: (s: string) => sent.push(s) };
  netmod.wireNet({ myState: controller.myState, me: () => owner });
  const pressG = () => bus.emit("key", { code: "KeyG", repeat: false });
  REGISTERED.find((r) => r.name === WINGS_FOLDED)!.browser = { toggle: pressG, held: () => controller.myState.wingsFolded === true && owner.wingsFolded === true };
  let clock = 100;
  const packet = () => { netmod.sendPose(clock += 100); return JSON.parse(sent.at(-1)!).pose; };

  console.log("\nTHE BROWSER OWNER → THE REAL PRESENCE PACKET (every registered name)");
  for (const r of REGISTERED) {
    r.browser.toggle();
    const on = packet();
    check(`${r.name}: the owner's key strikes it on the rig and in the wire state`, r.browser.held());
    check(`${r.name}: real sendPose publishes it as a named pose`, on?.poses?.includes(r.name) && !("wingsFolded" in on), JSON.stringify(on));
    r.browser.toggle();
    const off = packet();
    check(`${r.name}: releasing it publishes an explicit empty list`, !r.browser.held() && eq(off?.poses, []), JSON.stringify(off?.poses));
  }

  console.log("\nSWAPPED BODIES (client/lib/player/mybody.js, every registered name)");
  for (const r of REGISTERED) {
    r.browser.toggle();
    const first = body(WING_BONES); mybody.setMe(first); owner = first;
    check(`${r.name}: a newly worn body comes up holding it`, r.rendered(first));
    await catalog.switchAvatar("fixtures/other.vrm", "other");
    const swapped = mybody.getMe(); owner = swapped;
    check(`${r.name}: a body swapped in through the switch holds it`, swapped !== first && r.rendered(swapped));
    bus.emit("avatar-updated", { path: "fixtures/other.vrm", name: "other", fresh: "fixtures/other.vrm?v=2" });
    for (let i = 0; i < 100 && mybody.getMe() === swapped; i++) await Promise.resolve();   // the reload's makeAvatar settles
    const refreshed = mybody.getMe(); owner = refreshed;
    check(`${r.name}: a body reloaded in place holds it`, refreshed !== swapped && r.rendered(refreshed));
    check(`${r.name}: …and the swapped body's packet still carries it`, packet()?.poses?.includes(r.name));
    r.browser.toggle();
    check(`${r.name}: released on the new body`, !r.browser.held() && eq(packet()?.poses, []));
  }

  console.log("\nWINGS: THE BROWSER'S PROPULSION ROWS");
  pressG(); pressG();
  check("no-grant unfold says propulsion remains unavailable", /propulsion is still not granted/.test(hints.at(-1) ?? ""), hints.at(-1));
  pressG();
  controller.armFlight(null, "owner");   // a body whose bones couldn't be read (or a capsule): unknown, not "no wings"
  check("an unread body keeps a carried fold", controller.folded() === true && owner.wingsFolded === true);
  controller.armFlight([], "owner");   // a body with no authored wing chains
  const rel = packet();
  check("a wingless swap releases a carried posture, on the wire too", controller.myState.wingsFolded === false && Array.isArray(rel?.poses) && !rel.poses.includes(WINGS_FOLDED));
  check("the wingless release is said, in the words G used to say it", hints.at(-1) === "folded-wing posture released — this body has no L_Wing_* / R_Wing_* bones for the fold to move", hints.at(-1));
  let said = hints.length;
  pressG();
  check("G on the wingless body then has nothing to fold or release", hints.length === said && controller.folded() === false, hints.at(-1));
  controller.setFolded(true);   // a fold restored on rejoin (main.js) onto the wingless body
  check("a fold restored onto a known wingless body is released where it is set, and says so", controller.folded() === false && owner.wingsFolded === false &&
    hints.at(-1) === "folded-wing posture released — this body has no L_Wing_* / R_Wing_* bones for the fold to move", hints.at(-1));
  controller.armFlight(WING_BONES, "owner");
  pressG();
  check("G on a winged body folds again", controller.folded() === true && /wings folded/.test(hints.at(-1) ?? ""), hints.at(-1));
  pressG();   // open the winged body's wings again, so F may take off
  controller.setRightsHook(() => ({ role: "member", fly: true }));   // as main.js wires it, before the body is armed
  controller.armFlight(WING_BONES, "owner");
  bus.emit("key", { code: "KeyF", repeat: false });
  const up = controller.flying();
  controller.armFlight([], "owner");   // a swap mid-flight, to a wingless body
  said = hints.length;
  owner.root ??= new THREE.Object3D(); owner.setClip ??= () => {}; owner.update ??= () => {};   // updateMe places and animates the body on screen
  for (let i = 0; i < 10; i++) controller.updateMe(1 / 60, owner);   // the frames whose re-resolve once grounded a swapped body
  const state = controller.flightReport();
  check("a swap never ends a flight (lead 11-12): the wingless body flies on, frames later, still piloting",
    up === true && /state: PILOT/.test(state) && !hints.slice(said).some((h) => /withdrawn/.test(h)), `took off ${up}; ${state.split("\n")[1]}; ${hints.slice(said)}`);
  bus.emit("key", { code: "KeyF", repeat: false });   // land

  console.log("\nWINGS: ARMING FROM THE BODY ON SCREEN (mybody.js setMe -> controller.armFlightForBody)");
  const bodyOf = (bones: string[]) => ({ vrm: { scene: { traverse: (f: Function) => bones.forEach((name) => f({ isBone: true, name })) } } });
  const arm = (av: any) => controller.armFlightForBody?.(av);
  const firstSay = arm(bodyOf(WING_BONES));
  check("arming a body with the grant says flight is available", firstSay === "flight available on this body — press F", String(firstSay));
  pressG();
  check("(setup) the winged body folds", controller.folded() === true);
  arm({ vrm: { scene: { traverse() { throw new Error("unreadable"); } } } });
  check("a body whose skeleton read throws is unknown: the fold is kept", controller.folded() === true);
  arm({});
  check("a body with no vrm scene (a capsule) is unknown: the fold is kept", controller.folded() === true);
  check("/flight on an unread body doesn't count wing bones it hasn't read", /bones not read/.test(controller.flightReport()) && !/\(0 wing bones\)/.test(controller.flightReport()), controller.flightReport().split("\n")[0]);
  bus.emit("key", { code: "KeyF", repeat: false });
  check("F with a fold held on an unread body doesn't claim wings it hasn't read", /a fold is held/.test(hints.at(-1) ?? "") && /weren't read/.test(hints.at(-1) ?? "") && !/wings are folded/.test(hints.at(-1) ?? ""), hints.at(-1));
  const nodes = (names: string[]) => ({ vrm: { scene: { traverse: (f: Function) => names.forEach((name) => f({ isBone: false, name })) } } });
  arm(nodes(WING_BONES));
  check("wing nodes that aren't Bones are wings, as the renderer and the agent read them: the fold is kept", controller.folded() === true);
  arm(bodyOf(["Hips", "Spine", "Head"]));
  check("a read wingless body releases the fold", controller.folded() === false && /posture released — this body has no L_Wing_\* \/ R_Wing_\* bones/.test(hints.at(-1) ?? ""), hints.at(-1));
  const beeSay = arm(bodyOf(["Hips", "Spine", "Head", "Wings", "Wing_Left_High_Base", "Wing_Left_High1"]));
  check("a mis-named wing rig flies with the grant; the toast is the plain one", beeSay === "flight available on this body — press F", String(beeSay));
}

// ---------------------------------------------------------------- the remote renderer: mounted and not
async function remotePart() {
  const { GlobalRegistrator } = await import("@happy-dom/global-registrator");
  GlobalRegistrator.register();
  const stubs: any = await import("../stubs/remotes-stubs.mjs");
  const { mock } = await import("bun:test");
  const THREE = stubs.THREE;
  const lib = `${import.meta.dir}/../../client/lib/`;
  const camera = new THREE.PerspectiveCamera();
  const avatar = () => ({ root: new THREE.Object3D(), wingsFolded: false, dispose() {}, resetTransients() {}, setTyping() {}, playAnimation() {},
    setClip() {}, setPose() {}, clearPose() {}, setLimp() {}, playOnce() {}, setGazeTarget() {}, update() {}, setSeatApprox() {} });
  for (const m of ["assets", "world", "ui/chat", "avatar/fp_view", "boot", "ui/ui", "xr/xrbody"]) mock.module(`${lib}${m}.js`, () => stubs);
  mock.module(`${lib}core.js`, () => ({ ...stubs, camera }));
  mock.module(`${lib}avatar/avatar.js`, () => ({ ...stubs, makeAvatar: async () => avatar(), makeCapsuleAvatar: () => avatar() }));
  mock.module(`${lib}avatar/occupybody.js`, () => ({ releaseOccupied() {},
    driveOccupied: () => ({ pos: new THREE.Vector3(), q: new THREE.Quaternion(), clip: "sitchair", sw: { seatState: "ok", host: "chair", slot: "seat" } }) }));
  const { remotes, ensureRemote, pushPose, updateRemotes } = await import("../../client/lib/player/remotes.js") as any;
  let t = 1000;
  const sample = (poses: unknown) => ({ p: [1, 0, 1], yaw: 0, speed: 0, clip: "idle", poses });
  async function show(id: string, poses: unknown) { pushPose(id, sample(poses), t += 50); pushPose(id, sample(poses), t += 50); updateRemotes(1 / 60, t); return remotes.get(id).avatar; }

  for (const mounted of [false, true]) {
    console.log(`\nTHE REMOTE RENDERER, ${mounted ? "MOUNTED (a seat drives the body)" : "UNMOUNTED"} (every registered name)`);
    for (const r of REGISTERED) {
      const id = `${mounted ? "seated" : "free"}-${r.name}`;
      await ensureRemote(id, "vrms/remote.vrm");
      if (mounted) stubs.avatarMounts.set(id, { to: "chair", slot: "seat" });
      check(`${r.name}: a sample holding it renders it`, r.rendered(await show(id, [r.name])));
      check(`${r.name}: beside another pose it still renders`, r.rendered(await show(id, [SYNTHETIC, r.name])));
      check(`${r.name}: a list holding only another pose releases it`, !r.rendered(await show(id, [SYNTHETIC])));
      await show(id, [r.name]);
      check(`${r.name}: an explicit empty list releases it`, !r.rendered(await show(id, [])));
      await show(id, [r.name]);
      check(`${r.name}: a sample without the field leaves it as it was`, r.rendered(await show(id, undefined)));
    }
  }
}
