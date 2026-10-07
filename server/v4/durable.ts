// server/v4/durable.ts — the disk practice a sequencer owes its readers (platforms review 10-06, #5):
//  - a line is on disk (fsync) BEFORE anyone is told about it: otherwise a crash after a broadcast loses the tail, the
//    restarted server re-issues the same seq with a different head, and every client holding (seq, head) holds "proof"
//    the authority equivocated;
//  - a torn last line (a crash mid-write) is cut off at open, not kept as a permanent malformed entry;
//  - a blob is written to a temp file and renamed, and one whose bytes don't match its name is rewritten, never kept.
import fs from "node:fs";
import path from "node:path";
import { sha256 } from "../../shared/v4/hash.js";

/** The log's bytes, with a torn tail (no final newline) cut off the file first. */
export function readLogBytes(logPath: string): Buffer {
  if (!fs.existsSync(logPath)) return Buffer.alloc(0);
  const b = fs.readFileSync(logPath);
  if (b.length === 0 || b[b.length - 1] === 0x0a) return b;
  const keep = b.lastIndexOf(0x0a) + 1;
  console.warn(`[v4] ${logPath}: cut a torn last line (${b.length - keep} bytes, no newline) left by an interrupted write`);
  fs.truncateSync(logPath, keep);
  return b.subarray(0, keep);
}

/** Append one line and fsync before returning: the caller broadcasts only after this. */
export function appendDurable(logPath: string, line: string) {
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  const fd = fs.openSync(logPath, "a");
  try { fs.writeSync(fd, line + "\n"); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

/** Store blob text `s` under its hash `h` at `file`: atomically, and replacing a copy that doesn't verify. */
export function putBlobFile(file: string, s: string, h: string) {
  if (fs.existsSync(file)) { try { if (`sha256:${sha256(fs.readFileSync(file, "utf8"))}` === h) return; } catch {} }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  const fd = fs.openSync(tmp, "w");
  try { fs.writeSync(fd, s); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, file);
}
