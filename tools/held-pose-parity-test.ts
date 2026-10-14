// A held pose's rotation, translation and scale, read by the headless
// stand-ins (body_state's reader, the reach solver, the ragdoll's start) and
// drawn by the renderer, must put every joint in the same place. The renderer
// side is client/lib/avatar.js transcribed (setPose, the hips step of its
// update, vrm.update, _applyRawPose and _rawRest at full weight; the ragdoll's
// start is bakeHipsIntoRoot), on a VRM loaded by three-vrm exactly as the
// client loads it (assets.js records boneRest before anything moves a bone).
// When those change, this transcription changes with them.
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
import { BodyStateReader } from "../mcpl/body-state.ts";
import { HeadlessBody, ReachBody } from "../mcpl/physics.ts";
import { fixture } from "./body-fixture.ts";
import { mkCheck } from "./harness.ts";
const { check, tally } = mkCheck();

const half = (deg: number) => Math.sin(deg * Math.PI / 360), cos = (deg: number) => Math.cos(deg * Math.PI / 360);
const turns = {
  leftUpperArm: [0, 0, half(126), cos(126)],
  rightUpperLeg: [half(180), 0, 0, cos(180)],
  chest: [0, half(40), half(25), Math.sqrt(1 - half(40) ** 2 - half(25) ** 2)],
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
const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch(req) {
  const f = files.get(decodeURIComponent(new URL(req.url).pathname));
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

/** avatar.js, at full weight. */
function drawHeld(vrm: any, bones: Record<string, unknown>) {
  const h = vrm.humanoid, rest = vrm.userData.boneRest;
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
  for (const e of raw) {                                   // _applyRawPose, with _rawRest's parent frame
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
  "kneeling (the pose tool's example)": { hips: { t: [0, -0.3, 0] } },
  "rotations over a kneel": { hips: { q: [0.1, 0, 0, 0.995], t: [0, -0.3, 0.05] }, leftUpperArm: [0, 0, -0.5, 0.866], spine: [0.08, 0, 0, 0.997] },
  "translation on an arm": { leftLowerArm: { t: [0.02, 0.05, 0] } },
  "uniform scale": { leftUpperArm: { s: 1.5 } },
  "non-uniform scale": { leftUpperArm: { s: [1, 1.6, 1] }, rightUpperLeg: { s: [1.3, 1, 0.8] }, chest: { s: [1.2, 0.9, 1] } },
  "all channels together": { hips: { t: [0, -0.2, 0] }, chest: { q: [0, 0.2, 0, 0.98], s: [1.2, 1, 1] }, rightLowerArm: { q: [0, 0, 0.3, 0.954], t: [0, 0.03, 0] }, head: { s: 1.4 } },
};

try {
  const reader = new BodyStateReader(base);
  for (const path of [...files.keys()].map(k => k.slice("/library/".length))) {
    let worst = 0, where = "", compared = 0, unread = 0;
    for (const [label, bones] of Object.entries(poses)) {
      const { vrm, root } = await loadVrm(files.get("/library/" + path)!);
      root.position.set(2, 0.5, -1); root.rotation.y = 0.6;
      root.updateMatrixWorld(true);
      drawHeld(vrm, bones);
      root.updateMatrixWorld(true);
      const o: any = { who: path, avatar: path, generation: 1, self: true, connected: true, source: "unknown",
        pose: { p: [2, 0.5, -1], yaw: 0.6, speed: 0, clip: "ragdoll", pose: bones } };
      const r = await reader.read(path, "bones", undefined, () => ({ ...o, receivedAt: Date.now() }));
      if (!r.ok) { unread++; check(`${path}, ${label}: body_state reads it`, false, r.error); continue; }
      for (const [k, j] of Object.entries(r.joints) as [string, any][]) {
        const drawn = vrm.humanoid.getRawBoneNode(k);
        if (!drawn) continue;
        const gap = new THREE.Vector3(...j.position).distanceTo(drawn.getWorldPosition(new THREE.Vector3()));
        compared++;
        if (gap > worst) { worst = gap; where = `${label}, ${k}`; }
      }
    }
    check(`${path}: body_state's joints are where the renderer draws them, for every held pose`, !unread && compared > 0 && worst < 1e-5,
      `${compared} joints compared, ${unread} pose(s) unread, worst ${(worst * 1000).toFixed(4)} mm (${where})`);
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
  const stretched = { hips: { t: [0, -0.3, 0] }, leftUpperArm: { s: [1, 2, 1] } };
  kept.poseAt([1, 0, 2], 0.3, stretched);
  const posed = hand(kept);
  const read = await new BodyStateReader(base).read("reach", "bones", undefined, () => ({ who: "reach", avatar: "turned-vrm1.vrm", generation: 1,
    self: true, connected: true, source: "unknown", receivedAt: Date.now(), pose: { p: [1, 0, 2], yaw: 0.3, speed: 0, clip: "ragdoll", pose: stretched } } as any));
  check("the reach solver's body puts a held pose's hand where body_state does",
    !!read.ok && posed.distanceTo(new THREE.Vector3(...read.joints.leftHand.position)) < 1e-9, read.error ?? "");
  kept.poseAt([1, 0, 2], 0.3, null);
  check("a reach body posed again drops the last pose's translation and scale",
    posed.distanceTo(hand(fresh)) > 0.1 && hand(kept).distanceTo(hand(fresh)) < 1e-9,
    `posed ${posed.distanceTo(hand(fresh)).toFixed(3)} m away, then ${hand(kept).distanceTo(hand(fresh)).toExponential(1)} m`);
} finally {
  server.stop(true);
}
console.log(`${tally.passed} passed, ${tally.failed} failed`);
process.exit(tally.failed ? 1 : 0);
