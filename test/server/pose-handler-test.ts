// bun test/server/pose-handler-test.ts — the pose fence (server/posecheck.ts sanePose), and that it is PRODUCT-BOUND: the real "pose" message handler
// (server/messages.ts) neither updates lastPose nor stages a frame for a malformed sample, and does both
// for a finite one. Deleting sanePose() from the handler turns this red; so does deleting posecheck.ts.
process.env.WORLDS_DIR ??= require("node:fs").mkdtempSync(require("node:os").tmpdir() + "/pose-handler-");
process.env.JOIN_TOKEN ??= "test-door";
const { MESSAGES } = await import("../../server/messages.ts");
const { sanePose } = await import("../../server/posecheck.ts");
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
// the attest handler (same file): a stale receipt is refused IN WORDS (a malformed seq or digest is dropped silently)
{ const v: any = { id: "c1", gen: 3, surface: "voice", auxBound: true, world: { name: "w", recentSays: [{ seq: 7, verb: "say", actor: "c1", ts: Date.now() - 24 * 3600_000, args: { text: "old" } }] } };
  MESSAGES["attest"]({ ...ctx, c: v }, { type: "attest", seq: 7, gen: 3, digest: "0".repeat(64) });
  ok(sent.length === 1 && /stale/.test(sent[0]), "attest of a say older than ATTEST_FRESH_MS: an error frame saying it is stale, not silence"); }

// the fence itself: what sanePose passes, drops and clamps
const good = { p: [1, 0, 2], yaw: 0.3, speed: 0, clip: "idle", pitch: 0 };
ok(sanePose(good) === good, "a finite pose passes through untouched");
ok(sanePose({ ...good, p: [NaN, 0, 2] }) === null, "NaN position dropped");
ok(sanePose({ ...good, yaw: NaN }) === null, "NaN yaw dropped");
ok(sanePose({ ...good, yaw: Infinity }) === null, "Infinity yaw dropped");
ok(sanePose({ ...good, p: [1, 0] }) === null, "short position dropped");
ok(sanePose({ ...good, p: ["1", 0, 2] }) === null, "string position dropped");
ok(sanePose(null) === null && sanePose("x") === null, "non-object dropped");
ok(sanePose({ p: [0, 0, 0] }) !== null, "minimal pose (no yaw) passes");
const xr = { h: [0, 0, 0, 1], r: [0.1, 1.1, 0.3, 0, 0, 0, 1], c: [0, 0, 1, 0] };
ok(sanePose({ ...good, xr }) !== null, "C18 xr passes");
ok(sanePose({ ...good, xr: { ...xr, h: [NaN, 0, 0, 1] } }) === null, "NaN head quat dropped");
ok(sanePose({ ...good, xr: { ...xr, r: [0, 1, 2] } }) === null, "short grip dropped");
ok(sanePose({ ...good, xr: { h: [0, 0, 0, 1] } }) !== null, "xr with head only passes");
ok(sanePose({ ...good, xr: null }) === null, "null xr dropped");
// the deep fence: held pose (bone quats), pins, reach — a NaN anywhere inside is the same fault
const deep = { ...good, pose: { hips: [0, 0, 0, 1], head: [0.1, 0, 0, 0.99] }, pins: [{ bone: "leftHand", p: [1, 2, 3] }], reach: { right: { t: { p: [0, 1, 0] }, palm: 0.5 } } };
ok(sanePose(deep) !== null, "deep pose/pins/reach pass");
ok(sanePose({ ...deep, pose: { hips: [0, NaN, 0, 1] } }) === null, "NaN buried in a bone quat dropped");
ok(sanePose({ ...deep, pins: [{ bone: "x", p: [1, Infinity, 3] }] }) === null, "Infinity buried in a pin dropped");
ok(sanePose({ ...deep, reach: { right: { t: { p: [0, 1, NaN] } } } }) === null, "NaN buried in reach dropped");
ok(sanePose({ ...good, pose: null, pins: null, reach: null }) !== null, "null clears pass (the client's 'let go' contract)");
let nest: unknown = 1; for (let i = 0; i < 8; i++) nest = { a: nest };
ok(sanePose({ ...good, pose: nest }) === null, "a container nested past MAX_DEPTH dropped");
const wide: Record<string, number> = {}; for (let i = 0; i < 600; i++) wide["k" + i] = 0;
ok(sanePose({ ...good, pins: wide }) === null, "a container wider than MAX_KEYS dropped");
// the voice and body fields (review 09-30 S3): normalised at the fence, not relayed opaquely — every receiver clamps
// too, but the server REMEMBERS lastPose for joiners, so garbage would otherwise outlive its sender's next packet
{
  const v = sanePose({ ...good, mic: "yes", hear: 1 })!;
  ok(v && !("mic" in v) && !("hear" in v), "non-boolean mic/hear dropped (the pose itself kept)");
  const b = sanePose({ ...good, mic: true, hear: false })!;
  ok(b?.mic === true && b?.hear === false, "boolean mic/hear kept");
  const c = sanePose({ ...good, scale: 9, plateY: -4 })!;
  ok(c?.scale === 2 && c?.plateY === -0.3, `scale/plateY clamped to 0.5–2 / −0.3…+0.8 (got ${c?.scale} / ${c?.plateY})`);
  const d = sanePose({ ...good, scale: 0.01, plateY: 0.5 })!;
  ok(d?.scale === 0.5 && d?.plateY === 0.5, "scale clamped up to 0.5, an in-range plateY untouched");
  const e = sanePose({ ...good, scale: "2", plateY: null })!;
  ok(e && !("scale" in e) && !("plateY" in e), "a non-number scale/plateY is dropped — absence is the default");
  const f = sanePose({ ...good, scale: 1.5, plateY: 0.3 })!;
  ok(f?.scale === 1.5 && f?.plateY === 0.3, "in-range scale/plateY relay as sent");
}
console.log("pose-handler: 33 ok");
import("node:fs").then((fs) => { try { fs.rmSync(process.env.WORLDS_DIR!, { recursive: true, force: true }); } catch {} });
