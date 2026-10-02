// bun test tools/frame-archive.test.ts — small real files, injected clock/disk.
import { test, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, writeSync, readdirSync, statSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FrameArchive, archiveInventory, archiveIndex, type ArchivePolicy } from "../server/frame-archive.ts";

const dirs: string[] = [];
const handles: FrameArchive[] = [];
afterEach(() => {
  for (const a of handles.splice(0)) a.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function fixture(overrides: Partial<ArchivePolicy> = {}, extra: any = {}) {
  const dir = extra.dir ?? mkdtempSync(join(tmpdir(), "ew-archive-"));
  if (!dirs.includes(dir)) dirs.push(dir);
  let now = 1000, free = 100_000_000;
  const events: any[] = [];
  const policy = { segmentBytes: 400, segmentMs: 1000, maxBytes: 100_000, maxSegments: 100, minFreeBytes: 1000, ...overrides };
  const a = new FrameArchive(dir, "show", policy, { now: () => now, freeBytes: () => free,
    report: (event, detail) => events.push({ event, ...detail }), ...extra });
  handles.push(a);
  return { dir, a, events, policy, time: (n: number) => now = n, free: (n: number) => free = n };
}
const roster = JSON.stringify([{ id: "performer", avatar: "body.vrm" }]);
const frame = (seq: number, text = "") => JSON.stringify({ type: "frame", seq, t: 1000 + seq, poses: { performer: { p: [seq, 0, 0], text } } });
const lines = (dir: string, file: string) => readFileSync(join(dir, file), "utf8").trim().split("\n").map(s => JSON.parse(s));

test("size rotation preserves each frame once, with roster at every segment start", () => {
  const { a, dir } = fixture();
  for (let i = 0; i < 10; i++) expect(a.append(frame(i), roster, i, 42)).toBe(true);
  a.close();
  const index = archiveIndex(dir);
  expect(index.length).toBeGreaterThan(1);
  const all: number[] = [];
  for (const [ordinal, part] of index.entries()) {
    expect(part.actualBytes).toBeLessThanOrEqual(400);
    expect(part.metadata?.ordinal).toBe(ordinal);
    expect(part.metadata?.state).toBe("closed");
    expect(part.metadata?.firstLogSeq).toBe(42);
    const rows = lines(dir, part.file);
    expect(rows[0]).toMatchObject({ type: "roster", roster: JSON.parse(roster) });
    all.push(...rows.filter(r => r.type === "frame").map(r => r.seq));
  }
  expect(all).toEqual(Array.from({ length: 10 }, (_, i) => i));
  expect(a.status().totalBytes).toBe(archiveInventory(dir).bytes);
});

test("roster changes are written as deltas and are included in admission size", () => {
  const { a, dir } = fixture({ segmentBytes: 3000 });
  expect(a.append(frame(0), roster, 0, 1)).toBe(true);
  expect(a.append(frame(1), roster, 1, 1)).toBe(true);
  expect(a.append(frame(2), "[]", 2, 1)).toBe(true);
  a.close();
  expect(lines(dir, archiveIndex(dir)[0].file).map(r => r.type)).toEqual(["roster", "frame", "frame", "roster", "frame"]);
});

test("time rotates both busy and idle segments without making empty files", () => {
  const { a, dir, time } = fixture({ segmentBytes: 3000 });
  a.append(frame(0), roster, 0, 1);
  time(2000); a.maintain();
  expect(a.status().currentSegment).toBeNull();
  expect(archiveIndex(dir)[0].metadata?.reason).toBe("time-rotation");
  time(4000); a.maintain();
  expect(archiveIndex(dir)).toHaveLength(1);
  a.append(frame(1), roster, 1, 1);
  time(5000); a.append(frame(2), roster, 2, 1);
  a.close();
  expect(archiveIndex(dir)).toHaveLength(3);
});

test("world cap admits whole batches including indices and preserves earlier bytes", () => {
  const { a, dir } = fixture({ maxBytes: 12_000, segmentBytes: 2000 });
  let accepted = 0;
  while (a.append(frame(accepted, "x".repeat(500)), roster, accepted, 0)) accepted++;
  expect(accepted).toBeGreaterThan(0);
  expect(accepted).toBeLessThan(30);
  expect(a.status().reason).toBe("world-byte-limit");
  expect(archiveInventory(dir).bytes).toBeLessThanOrEqual(12_000);
  const before = archiveIndex(dir).map(p => readFileSync(join(dir, p.file), "utf8"));
  expect(a.append(frame(99), roster, 99, 0)).toBe(false);
  expect(archiveIndex(dir).map(p => readFileSync(join(dir, p.file), "utf8"))).toEqual(before);
  expect(archiveIndex(dir).flatMap(p => lines(dir, p.file)).filter(l => l.type === "frame")).toHaveLength(accepted);
});

test("legacy archives and interrupted tmp metadata are charged before first admission", () => {
  const dir = mkdtempSync(join(tmpdir(), "ew-archive-"));
  dirs.push(dir);
  writeFileSync(join(dir, "frames-123.jsonl"), "x".repeat(20_000));
  writeFileSync(join(dir, "frames-dead.index.json.tmp"), "x".repeat(10_000));
  writeFileSync(join(dir, "log.jsonl"), "authored history");
  const { a } = fixture({ maxBytes: 30_000 }, { dir });
  expect(a.status()).toMatchObject({ state: "stopped", reason: "world-byte-limit", totalBytes: 30_000 });
  expect(a.append(frame(0), roster, 0, 0)).toBe(false);
  expect(readFileSync(join(dir, "log.jsonl"), "utf8")).toBe("authored history");
  expect(readFileSync(join(dir, "frames-123.jsonl"), "utf8").length).toBe(20_000);
  expect(archiveIndex(dir)[0].metadata).toBeNull();
});

test("segment count cap includes legacy files and never erases a segment", () => {
  const { a, dir } = fixture({ maxSegments: 2, segmentBytes: 200 });
  expect(a.append(frame(0), roster, 0, 0)).toBe(true);
  expect(a.append(frame(1), roster, 1, 0)).toBe(true);
  expect(a.append(frame(2), roster, 2, 0)).toBe(false);
  expect(a.status().reason).toBe("segment-count-limit");
  expect(archiveIndex(dir)).toHaveLength(2);
});

test("an oversized UTF-8 frame + roster stops before opening a segment", () => {
  const { a, dir } = fixture({ segmentBytes: 200 });
  expect(a.append(frame(0, "🦅".repeat(80)), roster, 0, 0)).toBe(false);
  expect(a.status().reason).toBe("frame-exceeds-segment-limit");
  expect(readdirSync(dir)).toHaveLength(0);
});

test("disk floor stops at the batch boundary and stays latched even after space returns", () => {
  const { a, free, dir, events } = fixture();
  a.append(frame(0), roster, 0, 0);
  free(9300);
  expect(a.append(frame(1, "x".repeat(120)), roster, 1, 0)).toBe(false);
  expect(a.status().reason).toBe("disk-floor");
  free(100_000_000);
  expect(a.append(frame(2), roster, 2, 0)).toBe(false);
  expect(events.filter(e => e.event === "stopped")).toHaveLength(1);
  expect(archiveIndex(dir).flatMap(p => lines(dir, p.file)).filter(l => l.type === "frame").map(f => f.seq)).toEqual([0]);
});

test("disk probe error or unknown free space is a loud stop", () => {
  for (const freeBytes of [() => { throw new Error("statfs failed"); }, () => NaN]) {
    const { a, events, dir } = fixture({}, { freeBytes });
    expect(a.status().state).toBe("stopped");
    expect(a.status().reason).toContain("archive-io");
    expect(events.some(e => e.event === "stopped")).toBe(true);
    expect(readdirSync(dir)).toHaveLength(0);
  }
});

test("short writes complete, failed partial write leaves interrupted evidence without retry", () => {
  let fail = false, calls = 0;
  const { a, dir } = fixture({ segmentBytes: 3000 }, { write: (fd: number, bytes: Uint8Array) => {
    if (fail && ++calls > 1) throw new Error("disk went away");
    return writeSync(fd, bytes.subarray(0, 10));
  } });
  expect(a.append(frame(0), roster, 0, 0)).toBe(true);
  fail = true;
  expect(a.append(frame(1), roster, 1, 0)).toBe(false);
  const index = archiveIndex(dir)[0];
  expect(index.metadata).toMatchObject({ state: "interrupted", lastFrameSeq: 0, frames: 1 });
  expect(index.actualBytes).toBe(index.metadata!.bytes);
  expect(readFileSync(join(dir, index.file), "utf8").endsWith("\n")).toBe(false);
  expect(a.status().totalBytes).toBe(archiveInventory(dir).bytes);
});

test("restart creates fresh ordinal stream, preserves unclosed metadata and groups a performance", () => {
  const one = fixture({}, { boot: "1000-first", performance: "opening-night" });
  one.a.append(frame(0), roster, 0, 2);
  // Model crash recovery from durable bytes while the first fd stays untouched.
  const prior = readFileSync(join(one.dir, archiveIndex(one.dir)[0].file));
  const two = fixture({}, { dir: one.dir, boot: "2000-next", performance: "opening-night" });
  two.a.append(frame(0), roster, 0, 10); two.a.close();
  const index = archiveIndex(one.dir);
  expect(index).toHaveLength(2);
  expect(index[0].metadata).toMatchObject({ state: "open", lastFrameSeq: null, frames: null });
  expect(index[1].metadata).toMatchObject({ state: "closed", ordinal: 0, firstLogSeq: 10 });
  expect(new Set(index.map(i => i.metadata?.performance)).size).toBe(1);
  expect(readFileSync(join(one.dir, index[0].file))).toEqual(prior);
});

test("a filename collision stops instead of overwriting, and invalid policies fail closed", () => {
  const first = fixture({}, { boot: "same" });
  first.a.append(frame(0), roster, 0, 0); first.a.close();
  const original = archiveIndex(first.dir).map(p => readFileSync(join(first.dir, p.file), "utf8"));
  const second = fixture({}, { dir: first.dir, boot: "same" });
  expect(second.a.append(frame(1), roster, 1, 0)).toBe(false);
  expect(archiveIndex(first.dir).map(p => readFileSync(join(first.dir, p.file), "utf8"))).toEqual(original);
  expect(fixture({ maxBytes: NaN }).a.status().state).toBe("stopped");
});

test("rate ages to zero and segment age reports the current file", () => {
  const { a, time } = fixture({ segmentMs: 100_000 });
  a.append(frame(0), roster, 0, 0);
  time(2000);
  expect(a.status().bytesPerSecond).toBeGreaterThan(0);
  expect(a.status().currentSegmentAgeMs).toBe(1000);
  time(61_000);
  expect(a.status().bytesPerSecond).toBe(0);
});
