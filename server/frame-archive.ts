// Bounded, preserve-and-stop stage archive. This plane may fail without
// withholding the live frame. Raw JSONL stays compatible with offline renderers;
// compression belongs on exported copies, away from the sequencer's tick.
import { readdirSync, statSync, statfsSync, openSync, closeSync, writeSync, writeFileSync, renameSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

export type ArchivePolicy = {
  segmentBytes: number; segmentMs: number; maxBytes: number;
  maxSegments: number; minFreeBytes: number;
};
export const DEFAULT_ARCHIVE_POLICY: ArchivePolicy = {
  segmentBytes: 64 * 1024 ** 2, segmentMs: 3600_000,
  maxBytes: 10 * 1024 ** 3, maxSegments: 4096, minFreeBytes: 5 * 1024 ** 3,
};
// Room for the small index's atomic replacement (old + new); always reserved
// before accepting a frame, including the first one. Never a frame-size overrun.
const INDEX_RESERVE = 8192;
const ARCHIVE_FILE = /^frames-.*\.(jsonl|index\.json)(\.tmp)?$/;
const SEGMENT_FILE = /^frames-.*\.jsonl$/;
type Segment = {
  version: 1; world: string; performance: string; boot: string; ordinal: number;
  file: string; openedAt: number; closedAt: number | null;
  firstFrameSeq: number; lastFrameSeq: number | null;
  firstLogSeq: number; frames: number | null; bytes: number | null;
  state: "open" | "closed" | "interrupted"; reason?: string;
};
type Hooks = {
  now?: () => number; freeBytes?: () => number;
  write?: (fd: number, data: Uint8Array) => number;
  report?: (event: string, detail: Record<string, unknown>) => void;
};

/** Inventory only filenames and stats, never read multi-GB frame files.
 * Legacy boot-only files and leftover atomic-write temporaries count too. */
export function archiveInventory(dir: string) {
  let bytes = 0, segments = 0;
  for (const name of readdirSync(dir)) {
    if (!ARCHIVE_FILE.test(name)) continue;
    const s = statSync(join(dir, name));
    if (!s.isFile()) throw new Error("archive path is not a file: " + name);
    bytes += s.size;
    if (SEGMENT_FILE.test(name)) segments++;
  }
  return { bytes, segments };
}

/** Offline index: frame bytes remain authoritative after an interrupted write.
 * An open index means unclosed (possibly still recording); its final range and
 * last complete JSONL line must be recovered by the reader, not guessed here. */
export function archiveIndex(dir: string) {
  return readdirSync(dir).filter(n => SEGMENT_FILE.test(n)).sort().map(file => {
    const indexPath = join(dir, file.replace(/\.jsonl$/, ".index.json"));
    let metadata: Segment | null = null;
    try { metadata = JSON.parse(readFileSync(indexPath, "utf8")); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
    return { file, actualBytes: statSync(join(dir, file)).size, metadata };
  });
}

export class FrameArchive {
  readonly boot: string;
  readonly performance: string;
  private now: () => number;
  private freeBytes: () => number;
  private write: (fd: number, data: Uint8Array) => number;
  private report: NonNullable<Hooks["report"]>;
  private state: "ready" | "recording" | "stopped" | "closed" = "ready";
  private reason: string | null = null;
  private totalBytes = 0;
  private inventoryKnown = false;
  private segments = 0;
  private writtenBytes = 0;
  private startedAt: number;
  private rate: { at: number; bytes: number }[] = [];
  private current: { meta: Segment; fd: number; bytes: number; frames: number; indexBytes: number } | null = null;
  private ordinal = 0;
  private lastRoster = "";
  private warned = false;

  constructor(readonly dir: string, readonly world: string, readonly policy: ArchivePolicy = DEFAULT_ARCHIVE_POLICY,
    options: Hooks & { boot?: string; performance?: string } = {}) {
    this.boot = options.boot ?? randomUUID();
    this.performance = options.performance ?? this.boot;
    this.now = options.now ?? Date.now;
    this.startedAt = this.now();
    this.freeBytes = options.freeBytes ?? (() => {
      const s = statfsSync(dir); return Number(s.bavail) * Number(s.bsize);
    });
    this.write = options.write ?? ((fd, data) => writeSync(fd, data));
    this.report = options.report ?? ((event, detail) => console.warn("[recording:" + world + "] " + event, detail));
    try {
      if (!Object.values(policy).every(n => Number.isSafeInteger(n) && n > 0))
        throw new Error("archive limits must be positive safe integers");
      if (this.performance.length > 80 || this.boot.length > 80 || world.length > 200)
        throw new Error("archive identifiers are too long");
      const inventory = archiveInventory(dir);
      this.totalBytes = inventory.bytes; this.segments = inventory.segments; this.inventoryKnown = true;
      this.admit(0, true);
    } catch (e) { this.stop("archive-io: " + String(e)); }
  }

  private announce(event: string, detail: Record<string, unknown>) {
    // Reporting is diagnostic, never a reason to lose a live frame.
    try { this.report(event, detail); } catch (e) { console.error("[recording] reporter failed", e); }
  }

  private admit(bytes: number, opening: boolean): boolean {
    if (this.totalBytes + bytes + INDEX_RESERVE > this.policy.maxBytes) {
      this.stop("world-byte-limit"); return false;
    }
    if (opening && this.segments >= this.policy.maxSegments) {
      this.stop("segment-count-limit"); return false;
    }
    const free = this.freeBytes(); // a failed/unsupported statfs stops recording
    if (!Number.isFinite(free) || free < 0) throw new Error("available disk space is unknown");
    if (free - bytes - INDEX_RESERVE < this.policy.minFreeBytes) {
      this.stop("disk-floor"); return false;
    }
    return true;
  }

  private indexPath(meta: Segment) { return join(this.dir, meta.file.replace(/\.jsonl$/, ".index.json")); }

  private open(seq: number, logSeq: number, now: number) {
    const file = "frames-" + this.boot + "-" + String(this.ordinal++).padStart(6, "0") + ".jsonl";
    const meta: Segment = { version: 1, world: this.world, performance: this.performance,
      boot: this.boot, ordinal: this.ordinal - 1, file, openedAt: now, closedAt: null,
      firstFrameSeq: seq, lastFrameSeq: null, firstLogSeq: logSeq,
      frames: null, bytes: null, state: "open" };
    // A collision is an error, never permission to append to an earlier boot.
    const fd = openSync(join(this.dir, file), "wx");
    this.current = { meta, fd, bytes: 0, frames: 0, indexBytes: 0 };
    this.segments++;
    const encoded = JSON.stringify(meta) + "\n";
    writeFileSync(this.indexPath(meta), encoded, { flag: "wx" });
    this.current.indexBytes = Buffer.byteLength(encoded);
    this.totalBytes += this.current.indexBytes;
    this.lastRoster = "";
    this.state = "recording";
    this.announce("segment-open", { file, performance: this.performance, ordinal: meta.ordinal });
  }

  private finish(reason: string, interrupted = false) {
    const c = this.current;
    if (!c) return;
    this.current = null; // close/update failures must not reuse a suspect fd
    try {
      closeSync(c.fd);
    } finally {
      c.meta.closedAt = this.now(); c.meta.reason = reason;
      c.meta.state = interrupted ? "interrupted" : "closed";
      c.meta.bytes = statSync(join(this.dir, c.meta.file)).size;
      c.meta.frames = c.frames;
      const data = JSON.stringify(c.meta) + "\n", path = this.indexPath(c.meta);
      writeFileSync(path + ".tmp", data);
      renameSync(path + ".tmp", path);
      this.totalBytes += c.meta.bytes - c.bytes + Buffer.byteLength(data) - c.indexBytes;
    }
    this.announce("segment-close", { file: c.meta.file, reason, bytes: c.meta.bytes });
  }

  private stop(reason: string, interrupted = false) {
    if (this.state === "stopped" || this.state === "closed") return;
    this.state = "stopped"; this.reason = reason;
    try { this.finish(reason, interrupted); }
    catch (e) { this.reason += "; index-close: " + String(e); }
    // A failed write may leave a partial batch or index temporary. Reconcile
    // once on stop; if even stat fails, publish unknown rather than zero.
    try {
      const inventory = archiveInventory(this.dir);
      this.totalBytes = inventory.bytes; this.segments = inventory.segments; this.inventoryKnown = true;
    } catch { this.inventoryKnown = false; }
    this.announce("stopped", { reason: this.reason, totalBytes: this.inventoryKnown ? this.totalBytes : null,
      recovery: "Export closed archives, free space or raise limits, then restart. Existing archives are preserved." });
  }

  /** Called after live fanout. A batch is admitted whole: roster + frame fit
   * both the segment and world budgets, or recording stops before writing it. */
  append(frame: string, roster: string, seq: number, logSeq: number): boolean {
    if (this.state === "stopped" || this.state === "closed") return false;
    try {
      const now = this.now();
      const rosterLine = '{"type":"roster","t":' + now + ',"roster":' + roster + '}\n';
      let batch = (roster !== this.lastRoster ? rosterLine : "") + frame + "\n";
      let bytes = Buffer.byteLength(batch);
      if (this.current && (this.current.bytes + bytes > this.policy.segmentBytes ||
          now - this.current.meta.openedAt >= this.policy.segmentMs)) {
        this.finish("rotation");
      }
      if (!this.current) {
        batch = rosterLine + frame + "\n"; bytes = Buffer.byteLength(batch);
      }
      if (bytes > this.policy.segmentBytes) { this.stop("frame-exceeds-segment-limit"); return false; }
      if (!this.admit(bytes, !this.current)) return false;
      if (!this.current) this.open(seq, logSeq, now);
      const c = this.current!;
      const data = Buffer.from(batch);
      let offset = 0;
      while (offset < data.length) {
        const n = this.write(c.fd, data.subarray(offset));
        if (!Number.isInteger(n) || n <= 0 || n > data.length - offset) throw new Error("invalid archive write result");
        offset += n; c.bytes += n; this.totalBytes += n; this.writtenBytes += n;
      }
      c.frames++; c.meta.lastFrameSeq = seq; this.lastRoster = roster;
      this.rate.push({ at: now, bytes });
      this.pruneRate(now);
      if (!this.warned && this.totalBytes >= this.policy.maxBytes * 0.8) {
        this.warned = true;
        this.announce("budget-warning", { totalBytes: this.totalBytes, maxBytes: this.policy.maxBytes });
      }
      return true;
    } catch (e) { this.stop("archive-io: " + String(e), true); return false; }
  }

  private pruneRate(now: number) {
    while (this.rate.length && this.rate[0].at <= now - 60_000) this.rate.shift();
  }

  status() {
    const now = this.now(); this.pruneRate(now);
    return { state: this.state, reason: this.reason, performance: this.performance, boot: this.boot,
      totalBytes: this.inventoryKnown ? this.totalBytes : null, writtenBytes: this.writtenBytes, segments: this.segments,
      bytesPerSecond: this.rate.reduce((sum, r) => sum + r.bytes, 0) / Math.max(1, Math.min(60, (now - this.startedAt) / 1000)),
      currentSegment: this.current?.meta.file ?? null,
      currentSegmentBytes: this.current?.bytes ?? 0,
      currentSegmentAgeMs: this.current ? Math.max(0, now - this.current.meta.openedAt) : null,
      policy: this.policy };
  }

  /** Close an idle, aged segment too, so it is safe to export on schedule. */
  maintain() {
    if (this.state === "stopped" || this.state === "closed") return;
    try {
      if (!this.admit(0, false)) return;
      if (this.current && this.now() - this.current.meta.openedAt >= this.policy.segmentMs) {
        this.finish("time-rotation"); this.state = "ready";
      }
    } catch (e) { this.stop("archive-io: " + String(e), true); }
  }

  close() {
    if (this.state === "stopped" || this.state === "closed") return;
    try { this.finish("shutdown"); this.state = "closed"; }
    catch (e) { this.stop("archive-io: " + String(e), true); }
  }
}
