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
});
const { getWorld } = await import("../server/world.ts");
const { stageFrame } = await import("../server/stage-frame.ts");
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
