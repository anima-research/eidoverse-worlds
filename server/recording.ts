// Sequencer wiring for the archive; the storage implementation is testable
// without importing config (and therefore without touching production paths).
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { RECORD, WORLDS_DIR } from "./config.ts";
import { FrameArchive, DEFAULT_ARCHIVE_POLICY, type ArchivePolicy } from "./frame-archive.ts";

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
const performance = process.env.RECORD_PERFORMANCE_ID || boot;
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
export function recordingStatus(world: string) {
  return archives.get(world)?.status() ?? { state: RECORD ? "waiting" : "disabled", policy };
}
export function recordingMaintenance() { for (const a of archives.values()) a.maintain(); }
export function closeRecordings() { for (const a of archives.values()) a.close(); }
