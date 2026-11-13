import { GlobalRegistrator } from "@happy-dom/global-registrator";
GlobalRegistrator.register();

let failures = 0;
const check = (label: string, ok: boolean, detail?: string) => {
  console.log(ok ? `  \x1b[32m✓\x1b[0m ${label}` : `  \x1b[31m✗ ${label}${detail ? ` — ${detail}` : ""}\x1b[0m`);
  if (!ok) failures++;
};

const stubs: any = await import("./remotes-stubs.mjs");
const { mock } = await import("bun:test");
for (const m of ["core", "assets", "world", "chat", "fp_view", "boot", "ui", "avatar", "xrbody"]) {
  mock.module(`${import.meta.dir}/../client/lib/${m}.js`, () => stubs);
}
const remotesMod: any = await import("../client/lib/remotes.js");
const camera: any = stubs.camera;
camera.getWorldPosition ??= (v: any) => v.copy(camera.position);

const heldStill = <T>(fn: () => T): T => {
  const real = performance.now, p = real.call(performance);
  performance.now = () => p;
  try { return fn(); } finally { performance.now = real; }
};

async function drawnBetween(id: string, a: Record<string, unknown>, b: Record<string, unknown>) {
  const r = await remotesMod.ensureRemote(id, null);
  const avatar: any = { root: new stubs.THREE.Object3D(), pitch: 0, posed: undefined,
    update() {}, setLimp() {}, setClip() {}, setPose(p: unknown) { this.posed = p; }, clearPose() { this.posed = null; } };
  r.avatar = avatar;
  return heldStill(() => {
    const at = remotesMod.serverNow() - 110;   // bodies are drawn interpDelay (110 ms with no lateness) behind serverNow (remotes.js)
    remotesMod.pushPose(id, a, at - 2_000);
    remotesMod.pushPose(id, b, at + 2_000);
    r.late = null;   // a sample stamped 2 s back reads as a late link and widens interpDelay; this row is about the edge, not lateness
    remotesMod.updateRemotes(0.016);
    return { y: avatar.root.position.y, yaw: avatar.root.rotation.y, posed: avatar.posed };
  });
}

const KNEEL = { hips: { q: [0, 0, 0, 1], t: [0, -0.3, 0] }, spine: [0.2, 0, 0, 0.98] };
const FALLING = { hips: [0.3, 0, 0, 0.954], spine: [0.5, 0, 0, 0.866] };
const STANDING = { leftHand: [0, 0, 0.3, 0.954] };
const near = (x: number, want: number) => Math.abs(x - want) < 1e-6;

console.log("\nthe sample where a body goes limp or gets up:");
{
  const d = await drawnBetween("falls", { p: [0, 0, 0], yaw: 0, clip: "sit", pose: KNEEL },
    { p: [0, -0.74, 0], yaw: 1, clip: "ragdoll", pose: FALLING });
  check("a body that goes limp is drawn at the limp sample's root", near(d.y, -0.74), `root y ${d.y}, want -0.74 (-0.37 blended)`);
  check("...turned as the limp sample has it", near(d.yaw, 1), `yaw ${d.yaw}, want 1 (0.5 blended)`);
  check("...in the limp sample's pose, with no hips translation held over from the kneel",
    JSON.stringify(d.posed) === JSON.stringify(FALLING), `posed ${JSON.stringify(d.posed)}`);
}
{
  const d = await drawnBetween("rises", { p: [0, -0.74, 0], yaw: 0, clip: "ragdoll", pose: FALLING },
    { p: [0, 0, 0], yaw: 1, clip: "idle", pose: STANDING });
  check("a body that gets up is drawn at the standing sample's root", near(d.y, 0), `root y ${d.y}, want 0 (-0.37 blended)`);
  check("...turned as the standing sample has it", near(d.yaw, 1), `yaw ${d.yaw}, want 1 (0.5 blended)`);
  check("...in the standing sample's pose, with none of the fall's bones held over",
    JSON.stringify(d.posed) === JSON.stringify(STANDING), `posed ${JSON.stringify(d.posed)}`);
}
{
  const d = await drawnBetween("tumbles", { p: [0, -0.74, 0], yaw: 0, clip: "ragdoll" }, { p: [0, -0.5, 0], yaw: 1, clip: "ragdoll" });
  check("a body that stays limp is still drawn between its samples", near(d.y, -0.62) && near(d.yaw, 0.5), `root y ${d.y}, yaw ${d.yaw}; want -0.62, 0.5`);
}
{
  const d = await drawnBetween("walks", { p: [0, 0, 0], yaw: 0, clip: "idle" }, { p: [0, 0.5, 0], yaw: 1, clip: "walk" });
  check("a body that stays up is still drawn between its samples, across a clip change", near(d.y, 0.25) && near(d.yaw, 0.5), `root y ${d.y}, yaw ${d.yaw}; want 0.25, 0.5`);
}

console.log(`\n${failures ? `${failures} failed` : "all passed"}`);
process.exit(failures ? 1 : 0);
