// bun tools/stage-frame-failure-test.ts — real tick function, failed socket,
// live peer and on-disk archive. Import config only after isolating all roots.
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { strict as assert } from "node:assert";
const scratch = mkdtempSync(join(tmpdir(), "ew-stage-failure-"));
Object.assign(process.env, {
  WORLDS_DIR: join(scratch, "worlds"), OPT_DIR: join(scratch, "opt"),
  EIDOVERSE_DIR: join(scratch, "library"), RECORD_FRAMES: "1", SKIP_OPT_SWEEP: "1",
  RECORD_MIN_FREE_BYTES: "1", RECORD_MAX_BYTES: "100000", RECORD_MAX_SEGMENTS: "10",
  // 81 characters: invalid, so recording.ts warns at boot and uses the boot ID.
  RECORD_PERFORMANCE_ID: "p".repeat(81),
});
const { getWorld } = await import("../server/world.ts");
const { stageFrame, stageFrames } = await import("../server/stage-frame.ts");
const { FRAME_SKIP_BUFFERED } = await import("../server/config.ts");
const { closeRecordings, recordingStatus } = await import("../server/recording.ts");
const { archiveIndex } = await import("../server/frame-archive.ts");
let passed = false;
try {
  const w = getWorld("failure");
  const sent: string[] = [];
  w.clients.add({ id: "bad-send", avatar: "", ws: { send() { throw new Error("departed"); } } } as any);
  w.clients.add({ id: "bad-backlog", avatar: "", ws: { getBufferedAmount() { throw new Error("departed"); }, send() {} } } as any);
  w.clients.add({ id: "reader", spectator: true, avatar: "", ws: { send(s: string) { sent.push(s); } } } as any);
  w.dirty.set("performer", { p: [1,0,0] });
  stageFrame(w);
  assert.equal(w.dirty.size, 0);
  const frame = sent.map(s => JSON.parse(s)).find(m => m.type === "frame");
  assert.ok(frame, "later peer receives the failed receiver's frame");
  assert.equal(recordingStatus("failure").state, "recording");
  assert.notEqual(recordingStatus("failure").performance, "p".repeat(81), "an invalid performance ID falls back at boot");

  // Every world's frame is sent before any world's archive write.
  const order: string[] = [];
  const worldsInOrder = [getWorld("order-a"), getWorld("order-b")];
  for (const ow of worldsInOrder) {
    ow.clients.add({ id: "p-" + ow.name, avatar: "", ws: { send() { order.push("send:" + ow.name); } } } as any);
    ow.dirty.set("p-" + ow.name, { p: [0, 0, 0] });
  }
  stageFrames(worldsInOrder, (ow: any) => ({ append() { order.push("archive:" + ow.name); return true; } }));
  assert.deepEqual(order, ["send:order-a", "send:order-b", "archive:order-a", "archive:order-b"],
    "every world's frame goes out before any archive write");

  // A receiver whose socket is backed up is skipped; the others get the frame.
  const backlog = getWorld("backlog");
  const got: string[] = [];
  backlog.clients.add({ id: "slow", avatar: "", ws: { getBufferedAmount: () => FRAME_SKIP_BUFFERED + 1, send() { got.push("slow"); } } } as any);
  backlog.clients.add({ id: "fast", avatar: "", ws: { getBufferedAmount: () => 0, send() { got.push("fast"); } } } as any);
  backlog.dirty.set("fast", { p: [0, 0, 0] });
  stageFrames([backlog], () => null);
  assert.deepEqual(got, ["fast"], "a backed-up receiver is skipped while others get the frame");

  // The roster lists who performs, and the index's firstLogSeq is the last
  // authored entry applied when the segment opened.
  const anchored = getWorld("anchored");
  anchored.append("tester", "say", { text: "one" });
  anchored.append("tester", "say", { text: "two" });
  anchored.flushLog();
  const logLines = readFileSync(join(scratch, "worlds", "anchored", "log.jsonl"), "utf8").trim().split("\n").map(l => JSON.parse(l));
  const lastLogged = logLines[logLines.length - 1].seq;
  for (const c of [
    { id: "performer" },
    { id: "watcher", spectator: true },
    { id: "old-leg", superseded: true },
    { id: "relay", surface: "voice" },
  ]) anchored.clients.add({ ...c, avatar: "body.vrm", ws: { send() {} } } as any);
  anchored.dirty.set("performer", { p: [1, 0, 0] });
  stageFrame(anchored);
  const [anchorPart] = archiveIndex(join(scratch, "worlds", "anchored"));
  assert.equal(anchorPart.metadata?.firstLogSeq, lastLogged, "firstLogSeq is the seq of the last authored entry before the frames");
  const firstLine = JSON.parse(readFileSync(join(scratch, "worlds", "anchored", anchorPart.file), "utf8").split("\n")[0]);
  assert.deepEqual(firstLine.roster, [{ id: "performer", avatar: "body.vrm" }],
    "the roster leaves out a spectator, a superseded leg and a non-world surface");
  closeRecordings();
  const part = archiveIndex(join(scratch, "worlds", "failure"))[0];
  const stored = readFileSync(join(scratch, "worlds", "failure", part.file), "utf8").trim().split("\n").map(s => JSON.parse(s));
  assert.deepEqual(stored.find(m => m.type === "frame"), frame, "archive retains exactly the delivered frame");
  assert.equal(part.metadata?.frames, 1);
  assert.equal(part.logState, "resolved");
  passed = true;
  console.log("PASS failed send/backlog lookup: later peer and active archive retain the same frame");
} finally {
  closeRecordings();
  if (passed) rmSync(scratch, { recursive: true, force: true });
  else console.error("Failure evidence at " + scratch);
}
process.exit(0);
