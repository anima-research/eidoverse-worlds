// Sequencer wiring for the archive; the storage implementation is testable
// without importing config (and therefore without touching production paths).
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { RECORD, WORLDS_DIR } from "./config.ts";
import { FrameArchive, DEFAULT_ARCHIVE_POLICY, type ArchivePolicy } from "./frame-archive.ts";
import { recordingSummaryOf } from "../shared/recording.js";

function limit(name: string, fallback: number) {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (raw.trim() && Number.isSafeInteger(n) && n > 0) return n;
  console.warn("[recording] invalid " + name + "=" + JSON.stringify(raw) + "; using " + fallback);
  return fallback;
}
const policy: ArchivePolicy = {
  segmentBytes: limit("RECORD_SEGMENT_BYTES", DEFAULT_ARCHIVE_POLICY.segmentBytes),
  segmentMs: limit("RECORD_SEGMENT_MS", DEFAULT_ARCHIVE_POLICY.segmentMs),
  maxBytes: limit("RECORD_MAX_BYTES", DEFAULT_ARCHIVE_POLICY.maxBytes),
  maxSegments: limit("RECORD_MAX_SEGMENTS", DEFAULT_ARCHIVE_POLICY.maxSegments),
  minFreeBytes: limit("RECORD_MIN_FREE_BYTES", DEFAULT_ARCHIVE_POLICY.minFreeBytes),
};
const boot = Date.now() + "-" + randomUUID();
/** A label of at most 80 characters (code points), checked here at boot with
 *  the other RECORD_* values; an invalid one warns and falls back. */
function performanceId(raw: string | undefined, fallback: string) {
  if (raw === undefined || raw === "") return fallback;
  if (raw.trim() && [...raw].length <= 80) return raw;
  console.warn("[recording] invalid RECORD_PERFORMANCE_ID=" + JSON.stringify(raw) +
    " (it must be 1 to 80 characters, not only spaces); using " + fallback);
  return fallback;
}
const performance = performanceId(process.env.RECORD_PERFORMANCE_ID, boot);
const archives = new Map<string, FrameArchive>();
export function recorderFor(world: string, report: (event: string, detail: Record<string, unknown>) => void) {
  if (!RECORD) return null;
  let archive = archives.get(world);
  if (!archive) {
    archive = new FrameArchive(join(WORLDS_DIR, world), world, policy, { boot, performance, report });
    archives.set(world, archive);
  }
  return archive;
}
/** The full status, for /recordings. `waiting`: recording is on, but no one
 *  has joined this world since boot, so it has no archive yet. */
export function recordingStatus(world: string) {
  return archives.get(world)?.status() ?? { state: RECORD ? "waiting" : "disabled", policy };
}
/** What a client is told: state, stop code and performance, nothing else. */
export function recordingSummary(world: string) { return recordingSummaryOf(recordingStatus(world)); }
export function recordingMaintenance() { for (const a of archives.values()) a.maintain(); }
export function closeRecordings() { for (const a of archives.values()) a.close(); }

/** World reset must not reset the recorder's budgets or stopped state. */
export function prepareRecordingReset(world: string) { archives.get(world)?.endEpoch(); }

type RecordingWorld = {
  name: string; recordingLogId(): string;
  clients: Iterable<{ ws: { send(data: string): unknown } }>;
  debug(kind: string, detail: Record<string, unknown>): void;
};
export function frameRecorder(w: RecordingWorld) {
  const archive = recorderFor(w.name, (event, detail) => {
    // The server log gets everything; the flight recorder and clients get
    // the stop's code, never its error text, which can carry host paths.
    console.warn("[world:" + w.name + "] recording " + event, detail);
    const { detail: _text, ...shared } = detail;
    w.debug("recording-" + event, shared);
    if (event === "stopped") {
      const notice = JSON.stringify({ type: "recording-status", recording: false,
        recordingStatus: recordingSummaryOf({ state: "stopped", reason: detail.reason, performance: detail.performance }) });
      for (const c of w.clients) {
        try { c.ws.send(notice); } catch { /* a closed peer cannot hide the stop from others */ }
      }
    }
  });
  archive?.bindLog(() => w.recordingLogId());
  return archive;
}
