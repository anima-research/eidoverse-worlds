// A held pose's rotation, translation and scale, read by the headless
// stand-ins (body_state's reader, the reach solver, the ragdoll's start) and
// drawn by the renderer, must put every joint in the same place. The renderer
// side is client/lib/avatar.js transcribed (setPose, the hips step of its
// update, vrm.update, _applyRawPose and _rawRest at full weight; the ragdoll's
// start transcribes bakeHipsIntoRoot's drop), on a VRM loaded by three-vrm
// exactly as the client loads it (assets.js records boneRest before anything
// moves a bone). When those change, this transcription changes with them.
// The reach solver sees only the held pose's normalized layer, as the
// renderer's IK runs before its raw layer is laid; contacts and joints are
// read with both.
//
// Rigs: the self-contained fixture, VRM1 and VRM0, scaled, and with bones
// turned at rest the way real rigs turn them (a scale acts in the bone's own
// rest axes, so an unturned rig can't tell the right axes from the wrong
// ones). With EIDOVERSE_DIR set, the library's avatars too.
// Run: bun tools/held-pose-parity-test.ts
process.env.AGENT_BODY_ENGINE = "verlet";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import * as THREE from "../client/node_modules/three/build/three.module.js";
import { GLTFLoader } from "../client/node_modules/three/examples/jsm/loaders/GLTFLoader.js";
import { VRMLoaderPlugin, VRMUtils } from "../client/node_modules/@pixiv/three-vrm/lib/three-vrm.module.js";
import { poseChannels } from "../shared/humanoid.js";
import { parsePoseAnimation, retargetPoseAnimation } from "../client/lib/poseclips.js";
import { BodyStateReader } from "../mcpl/body-state.ts";
import { HeadlessBody, ReachBody } from "../mcpl/physics.ts";
import { fixture, postureFixture } from "./body-fixture.ts";
import { mkCheck } from "./harness.ts";
const { check, tally } = mkCheck();

// A rotation of `deg` degrees about an axis, as [x, y, z, w].
const turn = (x: number, y: number, z: number, deg: number) => {
  const s = Math.sin(deg * Math.PI / 360) / Math.hypot(x, y, z);
  return [x * s, y * s, z * s, Math.cos(deg * Math.PI / 360)];
};
const turns = {
  hips: turn(0, 1, 0, 30), spine: turn(1, 0, 0, 20), chest: turn(0, 1, 1, 47), head: turn(0, 0, 1, 15),
  leftUpperArm: turn(0, 0, 1, 126), leftLowerArm: turn(1, 1, 0, 90), rightLowerArm: turn(0, 1, 0, -70), rightHand: turn(1, 0, 1, 60),
  rightUpperLeg: turn(1, 0, 0, 180), leftFoot: turn(0, 1, 0, 45),
};
const files = new Map<string, Uint8Array>([
  ["/library/vrm1.vrm", fixture()],
  ["/library/vrm0.vrm", fixture(1, true)],
  ["/library/large.vrm", fixture(2)],
  ["/library/turned-vrm1.vrm", fixture(1, false, turns)],
  ["/library/turned-vrm0.vrm", fixture(1, true, turns)],
]);
const library = process.env.EIDOVERSE_DIR;
if (library) {
  const dir = join(library, "eidoverse/assets/vrms");
  for (const n of readdirSync(dir).filter(n => n.endsWith(".vrm") && !n.endsWith(".ktx2.vrm"))) files.set("/library/" + n, readFileSync(join(dir, n)));
}
// A standing body plays a clip under its held pose: the fixture's idle, at
// its first frame on both sides.
const idleBytes = postureFixture("idle");
files.set("/library/__corpus/idle.vrma", idleBytes);
const idle = await parsePoseAnimation(idleBytes.buffer.slice(idleBytes.byteOffset, idleBytes.byteOffset + idleBytes.byteLength));
const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch(req) {
  const path = decodeURIComponent(new URL(req.url).pathname);
  if (path === "/animations") return Response.json([{ name: "idle", path: "__corpus/idle.vrma" }]);
  const f = files.get(path);
  return f ? new Response(f) : new Response("missing", { status: 404 });
} });
const base = `http://127.0.0.1:${server.port}`;

async function loadVrm(bytes: Uint8Array) {
  const loader = new GLTFLoader();
  loader.register((p: any) => new VRMLoaderPlugin(p));
  loader.register(() => ({ name: "no-texture-upload", loadTexture: async () => new THREE.Texture() }));
  const gltf: any = await new Promise((res, rej) => loader.parse(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), "", res, rej));
  const vrm = gltf.userData.vrm;
  vrm.userData ??= {};
  vrm.userData.boneRest = {};
  vrm.scene.traverse((o: any) => {
    if (o.isBone && o.name && !(o.name in vrm.userData.boneRest)) {
      vrm.userData.boneRest[o.name] = { q: o.quaternion.toArray(), p: o.position.toArray(), s: o.scale.toArray() };
    }
  });
  VRMUtils.rotateVRM0(vrm);
  const root = new THREE.Object3D();   // the avatar root: position and yaw
  root.add(vrm.scene);
  return { vrm, root };
}

/** avatar.js, at full weight. A standing body: the clip's frame, the head
 *  pitch, the held pose's normalized layer, vrm.update, then its raw layer.
 *  A limp one (remotes.js sets a ragdoll limp): no clip under the sim's
 *  bones, no pitch and no raw layer. `clip: false` leaves out the clip alone,
 *  for the agent's reach body, which plays none. */
function drawHeld(vrm: any, bones: Record<string, unknown>, { limp = false, clip = true, pitch = 0 } = {}) {
  const h = vrm.humanoid, rest = vrm.userData.boneRest;
  if (!limp && clip) {
    const mixer = new THREE.AnimationMixer(vrm.scene);
    mixer.clipAction(retargetPoseAnimation(idle, vrm)).play();
    mixer.setTime(0);
  }
  if (!limp && pitch) h.getNormalizedBoneNode("head").quaternion.premultiply(
    new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.max(-0.5, Math.min(0.6, pitch))));
  const raw: any[] = [];
  let hipsT: any = null;
  for (const [n, v] of Object.entries(bones)) {            // setPose
    const c = poseChannels(v);
    const norm = c && h.getNormalizedBoneNode(n);
    if (!norm) continue;
    if (c.q) norm.quaternion.set(c.q[0], c.q[1], c.q[2], c.q[3]).normalize();
    if (n === "hips" && c.t) hipsT = new THREE.Vector3(c.t[0], c.t[1], c.t[2]);
    const t = n === "hips" ? null : c.t;
    if (t || c.s) raw.push({ node: h.getRawBoneNode(n), t, s: c.s });
  }
  if (hipsT) h.getNormalizedBoneNode("hips").position.add(hipsT);   // update: hips translation, then vrm.update
  h.update();
  for (const e of limp ? [] : raw) {                       // _applyRawPose, with _rawRest's parent frame
    const local = (o: any) => { const r = rest[o.name]; return new THREE.Matrix4().compose(new THREE.Vector3().fromArray(r.p), new THREE.Quaternion().fromArray(r.q), new THREE.Vector3().fromArray(r.s)); };
    const P = new THREE.Matrix4();
    let o = e.node.parent;
    while (o && o.isBone && rest[o.name]) { P.premultiply(local(o)); o = o.parent; }
    if (o && o !== vrm.scene) { vrm.scene.updateMatrixWorld(true); P.premultiply(vrm.scene.matrixWorld.clone().invert().multiply(o.matrixWorld)); }
    if (e.t) e.node.position.add(new THREE.Vector3(e.t[0], e.t[1], e.t[2]).applyMatrix3(new THREE.Matrix3().setFromMatrix4(P).invert()));
    if (e.s) e.node.scale.multiply(new THREE.Vector3(e.s[0], e.s[1], e.s[2]));
  }
  vrm.scene.updateMatrixWorld(true);
}

const poses: Record<string, Record<string, unknown>> = {
  "kneeling (the pose tool's example)": { hips: { t: [0, -0.5, 0] } },
  "rotations over a kneel": { hips: { q: [0.1, 0, 0, 0.995], t: [0, -0.3, 0.05] }, leftUpperArm: [0, 0, -0.5, 0.866], spine: [0.08, 0, 0, 0.997] },
  "translation on an arm": { leftLowerArm: { t: [0.02, 0.05, 0] } },
  "uniform scale": { leftUpperArm: { s: 1.5 } },
  "non-uniform scale": { leftUpperArm: { s: [1, 1.6, 1] }, rightUpperLeg: { s: [1.3, 1, 0.8] }, chest: { s: [1.2, 0.9, 1] } },
  "all channels together, and a rotation of no length": { hips: { t: [0, -0.2, 0] }, chest: { q: [0, 0.2, 0, 0.98], s: [1.2, 1, 1] }, rightLowerArm: { q: [0, 0, 0.3, 0.954], t: [0, 0.03, 0] }, head: { s: 1.4 }, neck: [0, 0, 0, 0] },
  "every channel on hips and on a forearm": { hips: { q: [0, 0.1, 0, 0.995], t: [0.05, -0.25, 0.02], s: [1.1, 0.9, 1.2] }, leftLowerArm: { q: [0.2, 0, 0, 0.98], t: [0, 0.02, 0.01], s: [0.8, 1.3, 1] } },
  "a scale that mirrors and one that collapses": { leftLowerArm: { s: [1, -1, 1] }, rightUpperArm: { q: [0, 0, 0.3, 0.954], s: [0.5, 0, 1] } },
};

try {
  const reader = new BodyStateReader(base);
  for (const path of [...files.keys()].filter(k => k.endsWith(".vrm")).map(k => k.slice("/library/".length))) {
    let worst = 0, where = "", compared = 0, unread = 0, skipped = 0, worstTurn = 0, turnWhere = "";
    for (const [pose, bones] of Object.entries(poses)) for (const limp of [false, true]) {
      const label = `${pose}, ${limp ? "limp" : "standing"}`;
      const { vrm, root } = await loadVrm(files.get("/library/" + path)!);
      root.position.set(2, 0.5, -1); root.rotation.y = 0.6;
      root.updateMatrixWorld(true);
      drawHeld(vrm, bones, { limp, pitch: 0.4 });
      root.updateMatrixWorld(true);
      // Both publish a head pitch, which only the standing body draws.
      const o: any = { who: path, avatar: path, generation: 1, self: true, connected: true, source: "unknown",
        pose: { p: [2, 0.5, -1], yaw: 0.6, pitch: 0.4, speed: 0, pose: bones, ...(limp ? { clip: "ragdoll" } : { clip: "idle", clipTime: 0 }) } };
      const r = await reader.read(path, "bones", undefined, () => ({ ...o, receivedAt: Date.now() }));
      if (!r.ok) { unread++; check(`${path}, ${label}: body_state reads it`, false, r.error); continue; }
      for (const [k, j] of Object.entries(r.joints) as [string, any][]) {
        const drawn = vrm.humanoid.getRawBoneNode(k);
        if (!drawn) { skipped++; continue; }
        const gap = new THREE.Vector3(...j.position).distanceTo(drawn.getWorldPosition(new THREE.Vector3()));
        compared++;
        if (gap > worst) { worst = gap; where = `${label}, ${k}`; }
        const norm = vrm.humanoid.getNormalizedBoneNode(k).quaternion;   // the rotation the pose set, in the same normalized frame
        const turned = 2 * Math.acos(Math.min(1, Math.abs(new THREE.Quaternion(...j.rotation).dot(norm))));
        if (turned > worstTurn) { worstTurn = turned; turnWhere = `${label}, ${k}`; }
      }
    }
    check(`${path}: body_state's joints are where the renderer draws them, for every held pose`, !unread && !skipped && compared > 0 && worst < 1e-5 && worstTurn < 1e-6,
      `${compared} joints compared, ${skipped} without a drawn bone, ${unread} pose(s) unread, worst ${(worst * 1000).toFixed(4)} mm (${where}), ${worstTurn.toExponential(1)} rad (${turnWhere})`);
  }

  // Only a pose that isn't a map of bones is unusable whole.
  {
    const bad = await reader.read("bad", "bones", undefined, () => ({ who: "bad", avatar: "vrm1.vrm", generation: 1, self: true, connected: true,
      source: "unknown", receivedAt: Date.now(), pose: { p: [0, 0, 0], yaw: 0, speed: 0, clip: "ragdoll", pose: [[0, 0, 0, 1]] } } as any));
    check("a published pose that isn't a map of bones is refused whole, with no claim about its bones",
      !bad.ok && bad.error === "published pose is not a map of bones" && bad.unreadableBones === null, bad.error);
  }

  // The reach solver sees the held pose's normalized layer only: the
  // renderer solves its IK before it lays a held translation on an arm or a
  // scale (avatar.js update), so the solve is the same with or without them,
  // and only the drawn hand moves.
  {
    const reaching = (bones: Record<string, unknown>) => reader.read("reacher", "bones", undefined, () => ({ who: "reacher", avatar: "turned-vrm1.vrm",
      generation: 1, self: true, connected: true, source: "unknown", receivedAt: Date.now(),
      pose: { p: [0, 0, 0], yaw: 0, speed: 0, clip: "idle", clipTime: 0, pose: bones, reach: { leftHand: { t: { p: [1.4, 1.3, 0.4] } } } } } as any));   // out of reach, so the gap is the arm's shortfall
    const plain = await reaching({ head: [0, 0, 0, 1] });
    // A translation on the upper arm and a scale on the chest would move the
    // shoulder, and a scale on the upper arm would lengthen the arm, for a
    // solver that saw them.
    const held = await reaching({ head: [0, 0, 0, 1], chest: { s: [1.3, 1, 1] }, leftUpperArm: { t: [0, 0.08, 0], s: [1, 1.6, 1] }, leftLowerArm: { t: [0, 0.05, 0] } });
    const a = plain.reachEvaluation?.leftHand, b = held.reachEvaluation?.leftHand;
    check("a held arm's translation and scale don't change its reach solve, as the renderer's IK never sees them",
      plain.ok && held.ok && a?.ok && b?.ok && a.gap > 0.1 && Math.abs(a.gap - b.gap) < 1e-9, JSON.stringify({ plain: a?.gap, held: b?.gap, error: held.error }));
    const moved = plain.ok && held.ok ? new THREE.Vector3(...plain.joints.leftHand.position).distanceTo(new THREE.Vector3(...held.joints.leftHand.position)) : NaN;
    check("...and the hand is drawn where they put it", moved > 0.01, `${(moved * 1000).toFixed(1)} mm`);
  }

  // The ragdoll's start: a held hips drop moves onto the root, as the
  // browser's bakeHipsIntoRoot moves it, so the fall begins where the body
  // was drawn. Same fall with and without the held drop; only the root moves.
  for (const path of ["vrm1.vrm", "vrm0.vrm"]) {
    const t = [0.1, -0.3, 0.05], yaw = 0.6;
    const starts: any[] = [];
    for (const pose of [null, { hips: { t } }]) {
      const body = await HeadlessBody.create(base, path);
      if (!body) throw new Error("the headless sim is unavailable");
      body.begin({ x: 2, z: -1, yaw, pose, rootY: 0.5 });
      starts.push(body.rd.p.hips.clone());
    }
    const { vrm, root } = await loadVrm(files.get("/library/" + path)!);
    root.rotation.y = yaw; root.updateMatrixWorld(true);
    const hips = vrm.humanoid.getNormalizedBoneNode("hips");
    const drop = new THREE.Vector3(...t).applyMatrix3(new THREE.Matrix3().setFromMatrix4(hips.parent.matrixWorld));
    const moved = new THREE.Vector3().subVectors(starts[1], starts[0]);
    check(`${path}: a fall from a held hips drop starts where the browser starts it`, moved.distanceTo(drop) < 1e-6,
      `moved (${moved.toArray().map((v: number) => v.toFixed(4)).join(", ")}), browser (${drop.toArray().map((v: number) => v.toFixed(4)).join(", ")})`);
  }

  // An agent's own reach body is kept and posed again for each solve
  // (agent.ts reachBodySync): what one held pose scaled or moved goes when
  // the next pose comes.
  const kept = await ReachBody.create(base, "turned-vrm1.vrm"), fresh = await ReachBody.create(base, "turned-vrm1.vrm");
  if (!kept || !fresh) throw new Error("no reach body");
  const hand = (b: any) => b.av.nodes.leftHand.getWorldPosition(new THREE.Vector3());
  fresh.poseAt([1, 0, 2], 0.3, null);
  const stretched = { hips: { t: [0, -0.3, 0] }, leftUpperArm: { s: [1, 2, 1] }, leftLowerArm: { t: [0, 0.04, 0] } };
  kept.poseAt([1, 0, 2], 0.3, stretched);
  const posed = hand(kept);
  // The agent's reach body plays no clip, so it's held to the renderer with none.
  {
    const { vrm, root } = await loadVrm(files.get("/library/turned-vrm1.vrm")!);
    root.position.set(1, 0, 2); root.rotation.y = 0.3; root.updateMatrixWorld(true);
    drawHeld(vrm, stretched, { clip: false });
    root.updateMatrixWorld(true);
    const drawn = vrm.humanoid.getRawBoneNode("leftHand").getWorldPosition(new THREE.Vector3());
    check("the agent's reach body puts a held pose's hand where the renderer draws it", posed.distanceTo(drawn) < 1e-5,
      `${(posed.distanceTo(drawn) * 1000).toFixed(4)} mm`);
    const limp = await loadVrm(files.get("/library/turned-vrm1.vrm")!);
    limp.root.position.set(1, 0, 2); limp.root.rotation.y = 0.3; limp.root.updateMatrixWorld(true);
    drawHeld(limp.vrm, stretched, { limp: true });
    limp.root.updateMatrixWorld(true);
    kept.poseAt([1, 0, 2], 0.3, stretched, 1, false);
    const drawnLimp = limp.vrm.humanoid.getRawBoneNode("leftHand").getWorldPosition(new THREE.Vector3());
    check("...and a limp one's where the renderer draws a limp body's, with no raw layer",
      hand(kept).distanceTo(drawnLimp) < 1e-5 && drawnLimp.distanceTo(drawn) > 0.1, `${(hand(kept).distanceTo(drawnLimp) * 1000).toFixed(4)} mm`);
    kept.poseAt([1, 0, 2], 0.3, stretched);
  }
  kept.poseAt([1, 0, 2], 0.3, null);
  const near = (a: number[], b: number[]) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) < 1e-9;
  const ck = kept.contact("hand_l", 0), cf = fresh.contact("hand_l", 0);
  check("a reach body posed again drops the last pose's translation and scale",
    posed.distanceTo(hand(fresh)) > 0.1 && hand(kept).distanceTo(hand(fresh)) < 1e-9 && !!ck && !!cf && near(ck.pos, cf.pos) && near(ck.normal, cf.normal)
    && Math.abs((kept.armLength("leftHand") ?? NaN) - (fresh.armLength("leftHand") ?? NaN)) < 1e-12,
    `posed ${posed.distanceTo(hand(fresh)).toFixed(3)} m away, then ${hand(kept).distanceTo(hand(fresh)).toExponential(1)} m`);

  // A rotation of no length normalizes to identity in the renderer, the
  // bone's rest, replacing whatever the clip left; and so here.
  {
    const a = await ReachBody.create(base, "turned-vrm1.vrm");
    if (!a) throw new Error("no reach body");
    const q = [0, 0, 0.3, Math.sqrt(0.91)];
    a.poseAt([0, 0, 0], 0, null);
    a.av.nodes.spine.quaternion.set(q[0], q[1], q[2], q[3]);   // as a clip would leave it
    a.holdPose({ spine: [0, 0, 0, 0] });
    check("a rotation of no length puts the bone at rest, over the clip, as the renderer reads it", a.av.nodes.spine.quaternion.equals(new THREE.Quaternion()),
      JSON.stringify(a.av.nodes.spine.quaternion.toArray()));
  }

  // An arm's length is the solver's: a held scale on it doesn't lengthen it.
  {
    const scaled = await ReachBody.create(base, "turned-vrm1.vrm");
    if (!scaled) throw new Error("no reach body");
    scaled.poseAt([1, 0, 2], 0.3, { leftUpperArm: { s: [1, 1.6, 1] } });
    check("a held scale doesn't change the arm length the solver measures",
      Math.abs((scaled.armLength("leftHand") ?? NaN) - (fresh.armLength("leftHand") ?? NaN)) < 1e-12,
      `${scaled.armLength("leftHand")} vs ${fresh.armLength("leftHand")}`);
  }

  // A contact's normal under a held non-uniform scale stays perpendicular to
  // the surface it marks, as a normal on the drawn mesh does: it goes through
  // the bone's inverse transpose, not its matrix.
  {
    const body = await ReachBody.create(base, "turned-vrm1.vrm");
    if (!body) throw new Error("no reach body");
    const node = body.av.nodes.leftLowerArm;
    body.poseAt([0, 0, 0], 0, null);
    const m0 = new THREE.Matrix3().setFromMatrix4(node.matrixWorld), n0 = new THREE.Vector3(...body.contact("forearm_l", 0)!.normal);
    const t1 = new THREE.Vector3(1, 0, 0).cross(n0).normalize(), t2 = n0.clone().cross(t1);
    const local = [t1, t2].map((t) => t.clone().applyMatrix3(m0.clone().invert()));
    body.poseAt([0, 0, 0], 0, { leftLowerArm: { s: [1, 1.8, 0.6] } });
    const m1 = new THREE.Matrix3().setFromMatrix4(node.matrixWorld), n1 = new THREE.Vector3(...body.contact("forearm_l", 0)!.normal);
    const off = Math.max(...local.map((t) => Math.abs(n1.dot(t.clone().applyMatrix3(m1).normalize()))));
    check("a contact's normal on a scaled bone stays perpendicular to its surface", off < 1e-9, `cosine to the surface ${off.toExponential(2)}`);
    // A scale with a 0 in it collapses the surface: the contact sits where the
    // collapse draws it, and faces as the bone would unscaled.
    body.poseAt([0, 0, 0], 0, null);
    const unscaled = body.contact("forearm_l", 0)!;
    body.poseAt([0, 0, 0], 0, { leftLowerArm: { s: [1, 0, 1] } });
    const flat = body.contact("forearm_l", 0)!;
    check("a contact on a collapsed bone faces as it would unscaled, where the collapse draws it",
      new THREE.Vector3(...flat.normal).distanceTo(new THREE.Vector3(...unscaled.normal)) < 1e-9 && Math.abs(new THREE.Vector3(...flat.normal).length() - 1) < 1e-9
      && new THREE.Vector3(...flat.pos).distanceTo(new THREE.Vector3(...unscaled.pos)) > 1e-3, JSON.stringify({ flat, unscaled }));
  }
} finally {
  server.stop(true);
}
console.log(`${tally.passed} passed, ${tally.failed} failed`);
process.exit(tally.failed ? 1 : 0);
