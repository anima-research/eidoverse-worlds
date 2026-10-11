// bun test tools/frame-archive.test.ts — small real files, injected clock/disk.
import { test, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, writeSync, readdirSync, statSync, mkdirSync, closeSync, renameSync, copyFileSync, appendFileSync, fsyncSync } from "node:fs";
import { logIdentity, LOG_OPENING_LIMIT } from "../server/log-identity.ts";
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
  // The failed write may have torn its batch: the range is unknown, as for a
  // failed close, and the reader recovers the tail from complete lines.
  expect(index.metadata).toMatchObject({ state: "interrupted", lastFrameSeq: null, frames: null });
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

test("idle last-segment rotation stops before claiming another ready capture", () => {
  const { a, time, events } = fixture({ maxSegments: 1 });
  expect(a.append(frame(0), roster, 0, 0)).toBe(true);
  time(2000); a.maintain();
  expect(a.status()).toMatchObject({ state: "stopped", reason: "segment-count-limit", currentSegment: null });
  expect(events.filter(e => e.event === "stopped")).toHaveLength(1);
  a.maintain();
  expect(events.filter(e => e.event === "stopped")).toHaveLength(1);
});

test("failed close preserves interrupted bytes without certifying a final range", () => {
  const { a, dir, events } = fixture({}, { close: (fd: number) => {
    closeSync(fd); throw new Error("late close I/O failure");
  } });
  a.append(frame(0), roster, 0, 0);
  a.close();
  const entry = archiveIndex(dir)[0];
  expect(a.status().state).toBe("stopped");
  expect(entry.metadata).toMatchObject({ state: "interrupted", frames: null, lastFrameSeq: null });
  expect(entry.metadata?.reason).toContain("close-failed");
  // The close's report shares its code; the failure's text is its detail, for the server log.
  expect(events.find(e => e.event === "segment-close")).toMatchObject({ reason: "shutdown", state: "interrupted" });
  expect(events.find(e => e.event === "segment-close")?.detail).toContain("late close I/O failure");
  expect(entry.actualBytes).toBeGreaterThan(0);
  expect(lines(dir, entry.file).filter(r => r.type === "frame")).toHaveLength(1);
  expect(events.some(e => e.event === "segment-close" && e.state === "closed")).toBe(false);
});

test("one torn or oversized index does not hide its bytes or intact neighbors", () => {
  const { a, dir } = fixture({ segmentBytes: 200 });
  a.append(frame(0), roster, 0, 0); a.append(frame(1), roster, 1, 0); a.close();
  const [first] = archiveIndex(dir);
  const path = join(dir, first.file.replace(/\.jsonl$/, ".index.json"));
  for (const damage of ['{"version":', 'null', "x".repeat(9000)]) {
    writeFileSync(path, damage);
    const index = archiveIndex(dir);
    expect(index).toHaveLength(2);
    expect(index[0].metadata).toBeNull();
    expect(index[0].metadataError).toBeTruthy();
    expect(index[0].actualBytes).toBe(first.actualBytes);
    expect(index[1].metadata?.state).toBe("closed");
  }
});

test("authored-log identity moves with bytes and resolves duplicate/missing paths honestly", () => {
  const { a, dir } = fixture();
  const log = join(dir, "log.jsonl"), opening = '{"verb":"genesis","args":{"epoch":"one"}}\n';
  writeFileSync(log, opening);
  const id = logIdentity(log);
  appendFileSync(log, '{"verb":"say"}\n');
  expect(logIdentity(log)).toBe(id);
  a.bindLog(() => logIdentity(log)); a.append(frame(0), roster, 0, 1); a.close();
  expect(archiveIndex(dir)[0]).toMatchObject({ logState: "resolved", logPaths: ["log.jsonl"] });
  mkdirSync(join(dir, "erased-one")); renameSync(log, join(dir, "erased-one", "log.jsonl"));
  writeFileSync(log, '{"verb":"genesis","args":{"epoch":"two"}}\n');
  expect(archiveIndex(dir)[0]).toMatchObject({ logState: "resolved", logPaths: ["erased-one/log.jsonl"] });
  mkdirSync(join(dir, "erased-copy")); copyFileSync(join(dir, "erased-one", "log.jsonl"), join(dir, "erased-copy", "log.jsonl"));
  expect(archiveIndex(dir)[0].logState).toBe("ambiguous");
  rmSync(join(dir, "erased-one"), { recursive: true }); rmSync(join(dir, "erased-copy"), { recursive: true });
  expect(archiveIndex(dir)[0].logState).toBe("missing");
});

test("incomplete, oversized or unreadable log opening fails recording identity closed", () => {
  for (const content of ["", '{"verb":', "x".repeat(LOG_OPENING_LIMIT) + "\n"]) {
    const { a, dir } = fixture();
    const path = join(dir, "log.jsonl"); writeFileSync(path, content);
    expect(() => logIdentity(path)).toThrow();
    a.bindLog(() => logIdentity(path));
    expect(a.status()).toMatchObject({ state: "stopped", logId: null });
    expect(a.status().reason).toContain("log-identity");
    expect(a.append(frame(0), roster, 0, 0)).toBe(false);
  }
  const { a, dir } = fixture();
  a.bindLog(() => logIdentity(join(dir, "absent")));
  expect(a.status().state).toBe("stopped");
});

test("epoch rotation retains cumulative quota, identity and stopped performance metadata", () => {
  const { a, dir, events } = fixture({ maxSegments: 2 }, { performance: "the-show" });
  const path = join(dir, "log.jsonl");
  writeFileSync(path, "epoch1\n"); const first = logIdentity(path);
  a.bindLog(() => first); a.append(frame(0), roster, 0, 99); a.endEpoch();
  const used = a.status().totalBytes;
  writeFileSync(path, "epoch2\n"); const second = logIdentity(path);
  a.bindLog(() => second); a.append(frame(1), roster, 1, 0); a.endEpoch();
  expect(a.status()).toMatchObject({ state: "stopped", reason: "segment-count-limit", segments: 2 });
  expect(a.status().totalBytes).toBeGreaterThan(used!);
  expect(archiveIndex(dir).map(r => r.metadata?.logId)).toEqual([first, second]);
  expect(archiveIndex(dir).every(r => r.metadata?.reason === "world-reset")).toBe(true);
  const stop = events.find(e => e.event === "stopped");
  expect(stop.performance).toBe("the-show");
  a.endEpoch();
  expect(a.status().state).toBe("stopped");
});


test("a closed segment's frames and index are synced before the index is renamed in, and the directory after", () => {
  const synced: string[] = [];
  const { a, dir } = fixture({}, { sync: (fd: number) => { synced.push(String(fd)); fsyncSync(fd); } });
  a.append(frame(0), roster, 0, 0);
  a.close();
  // The frames file, the index temporary, then the directory.
  expect(synced).toHaveLength(3);
  const [entry] = archiveIndex(dir);
  expect(entry.metadata?.state).toBe("closed");
  expect(readdirSync(dir).some(n => n.endsWith(".tmp"))).toBe(false);
});

test("a closed index whose byte count isn't its file's is flagged", () => {
  const { a, dir } = fixture();
  a.append(frame(0), roster, 0, 0); a.close();
  const [entry] = archiveIndex(dir);
  expect(entry.sizeMismatch).toBeUndefined();
  appendFileSync(join(dir, entry.file), "torn");
  const [after] = archiveIndex(dir);
  expect(after.sizeMismatch).toEqual({ indexBytes: entry.actualBytes, actualBytes: entry.actualBytes! + 4 });
});

test("a stop's code is all status says; its text stays in the index and the report", () => {
  const { a, dir, events } = fixture({}, { write: () => { throw new Error("EIO: i/o error, write '/srv/secret/worlds/show'"); } });
  expect(a.append(frame(0), roster, 0, 0)).toBe(false);
  expect(a.status()).toMatchObject({ state: "stopped", reason: "archive-io" });
  expect(JSON.stringify(a.status())).not.toContain("/srv/secret");
  const stop = events.find(e => e.event === "stopped");
  expect(stop.reason).toBe("archive-io");
  expect(stop.detail).toContain("/srv/secret");
  expect(stop.recovery).toContain("I/O failure");
  expect(archiveIndex(dir)[0].metadata?.reason).toContain("/srv/secret");
  // As the sequencer's reporter shares them with world_debug: without `detail`.
  const shared = events.map(({ detail, ...rest }) => rest);
  expect(shared.find(e => e.event === "segment-close")?.reason).toBe("archive-io");
  expect(JSON.stringify(shared)).not.toContain("/srv/secret");
});

test("the reason written into an index is capped well inside the reader's limit", () => {
  const { a, dir } = fixture({}, { write: () => { throw new Error("x".repeat(20_000)); } });
  a.append(frame(0), roster, 0, 0);
  const [entry] = archiveIndex(dir);
  expect(entry.metadataError).toBeNull();
  expect(entry.metadata!.reason!.length).toBeLessThanOrEqual(1025);
});

test("frames refused after a stop are counted, the one that stopped it included", () => {
  const { a, free } = fixture();
  expect(a.append(frame(0), roster, 0, 0)).toBe(true);
  free(10);
  expect(a.append(frame(1), roster, 1, 0)).toBe(false);
  expect(a.append(frame(2), roster, 2, 0)).toBe(false);
  expect(a.status()).toMatchObject({ state: "stopped", reason: "disk-floor", refusedFrames: 2 });
});

test("a world reset clears the log identity first, even for a stopped archive", () => {
  const live = fixture();
  live.a.bindLog(() => "sha256:" + "a".repeat(64));
  live.a.endEpoch();
  expect(live.a.status().logId).toBeNull();
  const stopped = fixture();
  stopped.a.bindLog(() => "sha256:" + "b".repeat(64));
  stopped.free(10);
  stopped.a.append(frame(0), roster, 0, 0);
  expect(stopped.a.status().state).toBe("stopped");
  expect(stopped.a.status().logId).toBe("sha256:" + "b".repeat(64));
  stopped.a.endEpoch();
  expect(stopped.a.status().logId).toBeNull();
});

test("the index is written before the frames file, so a failed index write leaves no frames file", () => {
  const { a, dir } = fixture({}, { boot: "fixed-boot" });
  // After admission's inventory, so it's the index write that fails.
  mkdirSync(join(dir, "frames-fixed-boot-000000.index.json"));
  expect(a.append(frame(0), roster, 0, 0)).toBe(false);
  expect(a.status().reason).toBe("archive-io");
  expect(readdirSync(dir).includes("frames-fixed-boot-000000.jsonl")).toBe(false);
});

test("an index naming a missing frames file is listed, not hidden", () => {
  const { a, dir } = fixture();
  a.append(frame(0), roster, 0, 0); a.close();
  const [entry] = archiveIndex(dir);
  rmSync(join(dir, entry.file));
  const [after] = archiveIndex(dir);
  expect(after.file).toBe(entry.file);
  expect(after.metadata?.state).toBe("closed");
  expect(after.actualBytes).toBeNull();
  expect(after.fileError).toContain("ENOENT");
});

test("a legacy frames file in the base's shape reads as legacy: no index, no error, identity unknown", () => {
  const { dir } = fixture();
  writeFileSync(join(dir, "frames-1759000000000.jsonl"),
    '{"type":"roster","t":1,"roster":[{"id":"p","avatar":""}]}\n' + frame(0) + "\n" + frame(1) + "\n");
  const [legacy] = archiveIndex(dir);
  expect(legacy).toMatchObject({ file: "frames-1759000000000.jsonl", metadata: null, metadataError: null, fileError: null, logState: "unknown" });
});

test("a segment whose closed state is only in a leftover .index.json.tmp still reads as unclosed", () => {
  const { a, dir } = fixture();
  a.append(frame(0), roster, 0, 0);
  const open = archiveIndex(dir)[0];
  const indexPath = join(dir, open.file.replace(/\.jsonl$/, ".index.json"));
  // The close wrote its temporary and died before the rename.
  writeFileSync(indexPath + ".tmp", JSON.stringify({ ...open.metadata, state: "closed", closedAt: 2000, frames: 1, bytes: open.actualBytes }) + "\n");
  const [entry] = archiveIndex(dir);
  expect(entry.metadata?.state).toBe("open");
  expect(entry.metadata?.frames).toBeNull();
});

test("crossing 80% of the world budget warns once, and not again", () => {
  // Big enough that 80% lies below the cap less admission's 8 KiB reserve.
  const { a, events } = fixture({ maxBytes: 100_000, segmentBytes: 4000 });
  for (let i = 0; i < 600 && a.status().state !== "stopped"; i++) a.append(frame(i, "y".repeat(300)), roster, i, 0);
  expect(a.status().reason).toBe("world-byte-limit");
  const warnings = events.filter(e => e.event === "budget-warning");
  expect(warnings).toHaveLength(1);
  expect(warnings[0].totalBytes).toBeGreaterThanOrEqual(80_000);
});

test("the segment cap counts UTF-8 bytes, not UTF-16 units", () => {
  // Each "é" is 2 bytes and 1 unit: counting units would let a segment run
  // past its byte cap.
  const { a, dir } = fixture({ segmentBytes: 600 });
  for (let i = 0; i < 12; i++) expect(a.append(frame(i, "é".repeat(100)), roster, i, 0)).toBe(true);
  a.close();
  const index = archiveIndex(dir);
  expect(index.length).toBeGreaterThan(1);
  for (const entry of index) expect(entry.actualBytes!).toBeLessThanOrEqual(600);
});

test("a performance id is counted in characters, so 80 two-unit characters are within the limit", () => {
  const { a } = fixture({}, { performance: "🎭".repeat(80) });
  expect(a.status().state).toBe("ready");
  const { a: over } = fixture({}, { performance: "🎭".repeat(81) });
  expect(over.status()).toMatchObject({ state: "stopped", reason: "archive-io" });
});

test("a directory named like a segment stops capture, naming it", () => {
  const dir = mkdtempSync(join(tmpdir(), "ew-archive-"));
  mkdirSync(join(dir, "frames-123.jsonl"));
  const { a, events } = fixture({}, { dir });
  expect(a.status()).toMatchObject({ state: "stopped", reason: "archive-io" });
  expect(events.find(e => e.event === "stopped").detail).toContain("frames-123.jsonl");
});

test("if the stop's reconciliation can't read the directory, total bytes are unknown, not stale", () => {
  const { a, dir, free } = fixture();
  a.append(frame(0), roster, 0, 0);
  rmSync(dir, { recursive: true, force: true });
  free(-1);
  expect(a.append(frame(1), roster, 1, 0)).toBe(false);
  expect(a.status()).toMatchObject({ state: "stopped", totalBytes: null });
});

test("the offline index reports every authored log it couldn't identify, resolved segments included", () => {
  const { a, dir } = fixture();
  writeFileSync(join(dir, "log.jsonl"), '{"seq":0,"verb":"genesis"}\n');
  a.bindLog(() => logIdentity(join(dir, "log.jsonl")));
  a.append(frame(0), roster, 0, 0); a.close();
  mkdirSync(join(dir, "erased-unreadable"));
  writeFileSync(join(dir, "erased-unreadable", "log.jsonl"), "");
  const [entry] = archiveIndex(dir);
  expect(entry.logState).toBe("resolved");
  expect(entry.logErrors?.some(e => e.startsWith("erased-unreadable/log.jsonl"))).toBe(true);
});
