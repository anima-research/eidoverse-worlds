// bun tools/pose-handler-test.ts — the pose fence is PRODUCT-BOUND: the real "pose" message handler
// (server/messages.ts) neither updates lastPose nor stages a frame for a malformed sample, and does both
// for a finite one. Deleting sanePose() from the handler turns this red; so does deleting posecheck.ts.
process.env.WORLDS_DIR ??= require("node:fs").mkdtempSync(require("node:os").tmpdir() + "/pose-handler-");
process.env.JOIN_TOKEN ??= "test-door";
const { MESSAGES } = await import("../server/messages.ts");
const ok = (v: unknown, why: string) => { if (!v) { console.error("FAIL", why); process.exit(1); } };
const sent: string[] = [];
const dirty = new Map<string, unknown>();
const c: any = { id: "c1", world: { name: "w", dirty }, lastPose: { p: [9, 9, 9] } };
const ctx: any = { c, ws: { send: (d: string) => sent.push(d) }, now: Date.now(), expel: () => {} };
const before = c.lastPose;
MESSAGES["pose"](ctx, { type: "pose", pose: { p: [NaN, 0, 0], yaw: 0 } });
ok(c.lastPose === before, "malformed pose: lastPose untouched");
ok(dirty.size === 0, "malformed pose: nothing staged for broadcast");
MESSAGES["pose"](ctx, { type: "pose", pose: { p: [1, 0, 2], yaw: 0.5, pose: { hips: [0, 0, 0, NaN] } } });
ok(c.lastPose === before && dirty.size === 0, "NaN buried in a bone quat: still nothing staged");
const fine = { p: [1, 0, 2], yaw: 0.5, speed: 0 };
MESSAGES["pose"](ctx, { type: "pose", pose: fine });
ok(c.lastPose === fine, "finite pose: lastPose updated");
ok(dirty.get("c1") === fine, "finite pose: staged for the next frame");
ok(sent.length === 0, "the pose handler answers nothing on the socket");
console.log("pose-handler: 6 ok");
import("node:fs").then((fs) => { try { fs.rmSync(process.env.WORLDS_DIR!, { recursive: true, force: true }); } catch {} });
