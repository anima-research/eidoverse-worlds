// Bounded, preserve-and-stop stage archive. This plane may fail without
// withholding the live frame. Raw JSONL stays compatible with offline renderers;
// compression belongs on exported copies, away from the sequencer's tick.
import { readdirSync, statSync, statfsSync, openSync, closeSync, writeSync, writeFileSync, renameSync, readFileSync, fsyncSync } from "node:fs";
import { join } from "node:path";
import { logIdentity } from "./log-identity.ts";
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
const INDEX_FILE = /^frames-.*\.index\.json$/;
// A stop's full text (an error with host paths) goes to the server log and the
// segment index; everyone else sees only its code. The index keeps the text
// well inside the reader's INDEX_RESERVE limit.
const REASON_TEXT_LIMIT = 1024;

/** Why capture stopped, as a code, and what an operator does about it. A stop
 *  holds until the sequencer restarts; admission then runs again, so capture
 *  resumes if the cause has cleared and stops again if it hasn't. */
export const STOP_RECOVERY: Record<string, string> = {
  "world-byte-limit": "Move closed segments and their indices out of the world directory, or raise RECORD_MAX_BYTES, then restart.",
  "segment-count-limit": "Move closed segments and their indices out of the world directory, or raise RECORD_MAX_SEGMENTS, then restart.",
  "frame-exceeds-segment-limit": "Raise RECORD_SEGMENT_BYTES above the largest frame batch, then restart.",
  "disk-floor": "Free space on the filesystem holding the world directory (or lower RECORD_MIN_FREE_BYTES), then restart.",
  "archive-io": "Fix the I/O failure named in the server log, then restart.",
  "log-identity": "Fix the authored log's opening line named in the server log, then restart.",
};
type Segment = {
  version: 1; world: string; performance: string; boot: string; ordinal: number;
  file: string; openedAt: number; closedAt: number | null;
  firstFrameSeq: number; lastFrameSeq: number | null;
  /** The seq of the last authored-log entry applied when the segment opened
   *  (-1 if none): the segment's frames follow it. */
  firstLogSeq: number; logId: string | null; frames: number | null; bytes: number | null;
  state: "open" | "closed" | "interrupted";
  /** The close or stop reason: a code, then any error text, capped. */
  reason?: string;
};
type Hooks = {
  now?: () => number; freeBytes?: () => number;
  write?: (fd: number, data: Uint8Array) => number;
  close?: (fd: number) => void;
  sync?: (fd: number) => void;
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
  const names = readdirSync(dir, { withFileTypes: true });
  const logs = new Map<string, string[]>(), logErrors: string[] = [];
  const candidates = ["log.jsonl", ...names.filter(e => e.isDirectory() && e.name.startsWith("erased-"))
    .map(e => e.name + "/log.jsonl")];
  for (const path of candidates) {
    try {
      const id = logIdentity(join(dir, path));
      const paths = logs.get(id) ?? []; paths.push(path); logs.set(id, paths);
    } catch (e) { logErrors.push(path + ": " + String(e)); }
  }
  // A segment is named by its frames file or its index: open() writes the
  // index first, so a crash before the frames file exists leaves an index
  // naming a missing file, which is reported, not hidden.
  const segmentFiles = new Set(names.map(e => e.name).filter(n => SEGMENT_FILE.test(n)));
  for (const n of names.map(e => e.name)) if (INDEX_FILE.test(n)) segmentFiles.add(n.replace(/\.index\.json$/, ".jsonl"));
  return [...segmentFiles].sort().map(file => {
    const indexPath = join(dir, file.replace(/\.jsonl$/, ".index.json"));
    let metadata: Segment | null = null, metadataError: string | null = null;
    try {
      if (statSync(indexPath).size > INDEX_RESERVE) throw new Error("index exceeds metadata limit");
      const parsed = JSON.parse(readFileSync(indexPath, "utf8"));
      if (!parsed || parsed.version !== 1 || parsed.file !== file ||
          !["open", "closed", "interrupted"].includes(parsed.state))
        throw new Error("invalid segment index");
      metadata = parsed;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") metadataError = String(e);
    }
    // One damaged/missing sidecar does not hide intact neighboring segments.
    let actualBytes: number | null = null, fileError: string | null = null;
    try { actualBytes = statSync(join(dir, file)).size; } catch (e) { fileError = String(e); }
    // A closed index certifies its byte count; a file of another size isn't
    // the one it closed.
    const sizeMismatch = metadata?.state === "closed" && actualBytes !== null && metadata.bytes !== actualBytes;
    const logPaths = metadata?.logId ? logs.get(metadata.logId) ?? [] : [];
    const logState = !metadata?.logId ? "unknown" : logPaths.length === 1 ? "resolved" : logPaths.length ? "ambiguous" : "missing";
    return { file, actualBytes, metadata, metadataError, fileError, logState, logPaths,
      ...(sizeMismatch ? { sizeMismatch: { indexBytes: metadata!.bytes, actualBytes } } : {}),
      ...(logErrors.length ? { logErrors } : {}) };
  });
}

export class FrameArchive {
  readonly boot: string;
  readonly performance: string;
  private now: () => number;
  private freeBytes: () => number;
  private write: (fd: number, data: Uint8Array) => number;
  private closeFile: (fd: number) => void;
  private sync: (fd: number) => void;
  private report: NonNullable<Hooks["report"]>;
  private state: "ready" | "recording" | "stopped" | "closed" = "ready";
  /** The stop's code, which is all anyone but the server log and the index sees. */
  private reason: string | null = null;
  private reasonText: string | null = null;
  private refused = 0;
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
  private logId: string | null = null;

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
    this.closeFile = options.close ?? closeSync;
    this.sync = options.sync ?? fsyncSync;
    this.report = options.report ?? ((event, detail) => console.warn("[recording:" + world + "] " + event, detail));
    try {
      if (!Object.values(policy).every(n => Number.isSafeInteger(n) && n > 0))
        throw new Error("archive limits must be positive safe integers");
      if ([...this.performance].length > 80 || [...this.boot].length > 80 || world.length > 200)
        throw new Error("archive identifiers are too long");
      const inventory = archiveInventory(dir);
      this.totalBytes = inventory.bytes; this.segments = inventory.segments; this.inventoryKnown = true;
      this.admit(0, true);
    } catch (e) { this.stop("archive-io", String(e)); }
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
      firstFrameSeq: seq, lastFrameSeq: null, firstLogSeq: logSeq, logId: this.logId,
      frames: null, bytes: null, state: "open" };
    // The index first, then the frames file: a crash between them leaves an
    // index naming a missing file, which the reader reports, never a frames
    // file that reads as legacy. A collision is an error, never permission to
    // append to an earlier boot.
    const encoded = JSON.stringify(meta) + "\n";
    writeFileSync(this.indexPath(meta), encoded, { flag: "wx" });
    this.totalBytes += Buffer.byteLength(encoded);
    const fd = openSync(join(this.dir, file), "wx");
    this.current = { meta, fd, bytes: 0, frames: 0, indexBytes: Buffer.byteLength(encoded) };
    this.segments++;
    this.lastRoster = "";
    this.state = "recording";
    this.announce("segment-open", { file, performance: this.performance, ordinal: meta.ordinal });
  }

  /** Close the open segment. `code` is why (a stop's code, or "rotation" and
   *  the like); `text` is a stop's full text, which the index keeps and the
   *  segment-close report carries only as `detail`, for the server log. */
  private finish(code: string, text: string = code, interrupted = false) {
    const c = this.current;
    if (!c) return;
    this.current = null; // close/update failures must not reuse a suspect fd
    // The frames reach the disk before the index says they're closed.
    let closeError: unknown, closeFailed = false;
    try { this.sync(c.fd); } catch (e) { closeError = e; closeFailed = true; }
    try { this.closeFile(c.fd); } catch (e) { if (!closeFailed) closeError = e; closeFailed = true; }
    c.meta.closedAt = closeFailed ? null : this.now();
    const full = closeFailed ? text + "; close-failed: " + String(closeError) : text;
    c.meta.reason = full.length > REASON_TEXT_LIMIT ? full.slice(0, REASON_TEXT_LIMIT) + "…" : full;
    c.meta.state = interrupted || closeFailed ? "interrupted" : "closed";
    c.meta.bytes = statSync(join(this.dir, c.meta.file)).size;
    // An interrupted write may have torn its batch, and a failed close cannot
    // certify the final range even when prior writes returned success. Either
    // way the range is unknown: preserve bytes and ask the reader to recover
    // the tail from complete lines, as for an open segment.
    const rangeKnown = !interrupted && !closeFailed;
    c.meta.frames = rangeKnown ? c.frames : null;
    if (!rangeKnown) c.meta.lastFrameSeq = null;
    const data = JSON.stringify(c.meta) + "\n", path = this.indexPath(c.meta);
    const tmp = openSync(path + ".tmp", "w");
    try { writeSync(tmp, data); this.sync(tmp); } finally { closeSync(tmp); }
    renameSync(path + ".tmp", path);
    const dirFd = openSync(this.dir, "r");
    try { this.sync(dirFd); } finally { closeSync(dirFd); }
    this.totalBytes += c.meta.bytes - c.bytes + Buffer.byteLength(data) - c.indexBytes;
    this.announce("segment-close", { file: c.meta.file, reason: code,
      ...(full !== code ? { detail: full } : {}), state: c.meta.state, bytes: c.meta.bytes });
    if (closeFailed) throw closeError;
  }

  /** `code` names the stop (STOP_RECOVERY's keys); `detail` is any error
   *  text, which can carry host paths and stays in the server log and index. */
  private stop(code: string, detail?: string, interrupted = false) {
    if (this.state === "stopped" || this.state === "closed") return;
    this.state = "stopped"; this.reason = code;
    this.reasonText = detail === undefined ? code : code + ": " + detail;
    try { this.finish(code, this.reasonText, interrupted); }
    catch (e) { this.reasonText += "; index-close: " + String(e); }
    // A failed write may leave a partial batch or index temporary. Reconcile
    // once on stop; if even stat fails, publish unknown rather than zero.
    try {
      const inventory = archiveInventory(this.dir);
      this.totalBytes = inventory.bytes; this.segments = inventory.segments; this.inventoryKnown = true;
    } catch { this.inventoryKnown = false; }
    this.announce("stopped", { reason: code, detail: this.reasonText, performance: this.performance, boot: this.boot, logId: this.logId,
      totalBytes: this.inventoryKnown ? this.totalBytes : null, recovery: STOP_RECOVERY[code] ?? "Fix the cause named in the server log, then restart." });
  }

  /** Called after live fanout. A batch is admitted whole: roster + frame fit
   * both the segment and world budgets, or recording stops before writing it.
   * A frame not archived because capture has stopped is counted (status's
   * refusedFrames), the one that stopped it included. */
  append(frame: string, roster: string, seq: number, logSeq: number): boolean {
    const archived = this.appendBatch(frame, roster, seq, logSeq);
    if (!archived && this.state === "stopped") this.refused++;
    return archived;
  }

  private appendBatch(frame: string, roster: string, seq: number, logSeq: number): boolean {
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
    } catch (e) { this.stop("archive-io", String(e), true); return false; }
  }

  private pruneRate(now: number) {
    while (this.rate.length && this.rate[0].at <= now - 60_000) this.rate.shift();
  }

  status() {
    const now = this.now(); this.pruneRate(now);
    return { state: this.state, reason: this.reason, performance: this.performance, boot: this.boot, logId: this.logId,
      totalBytes: this.inventoryKnown ? this.totalBytes : null, writtenBytes: this.writtenBytes, segments: this.segments,
      refusedFrames: this.refused,
      bytesPerSecond: this.rate.reduce((sum, r) => sum + r.bytes, 0) / Math.max(1, Math.min(60, (now - this.startedAt) / 1000)),
      currentSegment: this.current?.meta.file ?? null,
      currentSegmentBytes: this.current?.bytes ?? 0,
      currentSegmentAgeMs: this.current ? Math.max(0, now - this.current.meta.openedAt) : null,
      policy: this.policy };
  }

  /** Bind once per authored-log epoch. Failure is an archival stop, never
   * permission to substitute a filename or a restarted sequence number. */
  bindLog(readId: () => string) {
    if (this.state === "stopped" || this.state === "closed" || this.logId !== null) return;
    try {
      const id = readId();
      if (!/^sha256:[a-f0-9]{64}$/.test(id)) throw new Error("unresolved authored-log identity");
      this.logId = id;
    } catch (e) { this.stop("log-identity", String(e)); }
  }

  /** Close before reset moves the authored log. Keep cumulative quotas and
   * any stopped latch; a new epoch cannot buy another storage allowance. */
  endEpoch() {
    // First, whatever happens next: status never names a log the world no
    // longer has, stopped or not. The closing segment keeps its own logId.
    this.logId = null;
    if (this.state === "stopped" || this.state === "closed") return;
    try {
      this.finish("world-reset");
      if (this.admit(0, true)) this.state = "ready";
    } catch (e) { this.stop("archive-io", String(e), true); }
  }

  /** Close a segment that has reached its age limit, idle or not, so it is
   *  safe to export on schedule; and stop if the disk floor is crossed. */
  maintain() {
    if (this.state === "stopped" || this.state === "closed") return;
    try {
      if (!this.admit(0, false)) return;
      if (this.current && this.now() - this.current.meta.openedAt >= this.policy.segmentMs) {
        this.finish("time-rotation");
        if (this.admit(0, true)) this.state = "ready";
      }
    } catch (e) { this.stop("archive-io", String(e), true); }
  }

  close() {
    if (this.state === "stopped" || this.state === "closed") return;
    try { this.finish("shutdown"); this.state = "closed"; }
    catch (e) { this.stop("archive-io", String(e), true); }
  }
}
