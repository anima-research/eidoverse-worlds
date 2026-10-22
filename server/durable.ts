// server/durable.ts — the disk practice a sequencer owes its readers (platforms review 10-06, #5):
//  - a line is on disk (fsync) BEFORE anyone is told about it: otherwise a crash after a broadcast loses the tail, the
//    restarted server re-issues the same seq with a different head, and every client holding (seq, head) holds "proof"
//    the authority equivocated;
//  - a torn last line (a crash mid-write) is cut off at open, not kept as a permanent malformed entry;
//  - a blob is written to a temp file and renamed, and one whose bytes don't match its name is rewritten, never kept.
import fs from "node:fs";
import path from "node:path";
import { sha256 } from "../shared/protocol/hash.js";

/** The log's bytes, with a torn tail (no final newline) cut off the file first. `cut: false` is a reader's: it leaves the
 *  file alone and only leaves the tail out, since a line without its newline may be one a writer is appending now (review
 *  of #260, server I127: a reader that cut it made the writer's line land broken). Only the log's writer cuts. */
export function readLogBytes(logPath: string, { cut = true } = {}): Buffer {
  if (!fs.existsSync(logPath)) return Buffer.alloc(0);
  const b = fs.readFileSync(logPath);
  if (b.length === 0 || b[b.length - 1] === 0x0a) return b;
  const keep = b.lastIndexOf(0x0a) + 1;
  if (!cut) return b.subarray(0, keep);
  console.warn(`[log] ${logPath}: cut a torn last line (${b.length - keep} bytes, no newline) left by an interrupted write`);
  fs.truncateSync(logPath, keep);
  return b.subarray(0, keep);
}

/** Write all of `buf` to `fd`: writeSync may take fewer bytes than it was given (a full disk, a signal, a pipe), and a short
 *  write treated as whole is a torn line in memory. It loops until every byte is taken; a write that takes nothing throws. */
export function writeAll(fd: number, buf: Uint8Array) {
  let off = 0;
  while (off < buf.length) {
    const n = fs.writeSync(fd, buf, off, buf.length - off);
    if (!(n > 0)) throw new Error(`short write: ${off} of ${buf.length} bytes taken, then none (disk full?)`);
    off += n;
  }
}
/** Append one line and fsync before returning: the caller broadcasts only after this. Any throw from here leaves the line's
 *  disk state unknown (open, write, sync and close are not one step): the authority wedges the file and calls it ambiguous. */
export function appendDurable(logPath: string, line: string) {
  mkdirDurable(path.dirname(logPath));
  const fresh = !fs.existsSync(logPath);
  const fd = fs.openSync(logPath, "a");
  try { writeAll(fd, Buffer.from(line + "\n", "utf8")); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  if (fresh) syncDir(path.dirname(logPath));   // a file's first line is durable only once its name is (review of #260, server I17)
}
/** fsync a directory, so a file just created or renamed into it survives a crash (POSIX: the entry lives in the directory,
 *  not the file). Windows can't open a directory for this, and NTFS journals names itself: skipped there. */
function syncDir(dir: string) {
  if (process.platform === "win32") return;
  const fd = fs.openSync(dir, "r");
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

/** Make `dir` and any missing parents, durably: a directory mkdir just made is named by an entry in its parent, which a
 *  crash can lose like any other new name, taking the directory and what was written in it. So each parent that gained an
 *  entry is synced, from `dir`'s own parent up to the parent of the first directory made. `dir` itself is the caller's to
 *  sync once its file is in it. */
function mkdirDurable(dir: string) {
  const first = fs.mkdirSync(dir, { recursive: true });
  if (first === undefined) return;
  const top = path.dirname(path.resolve(first));
  for (let d = path.dirname(path.resolve(dir)); ; d = path.dirname(d)) { syncDir(d); if (d === top || d === path.dirname(d)) break; }
}

/** Store blob text `s` under its hash `h` at `file`: atomically, and replacing a copy that doesn't verify. */
export function putBlobFile(file: string, s: string, h: string) {
  if (fs.existsSync(file)) { try { if (`sha256:${sha256(fs.readFileSync(file, "utf8"))}` === h) return; } catch {} }
  mkdirDurable(path.dirname(file));
  const tmp = `${file}.${process.pid}.tmp`;
  const fd = fs.openSync(tmp, "w");
  try { writeAll(fd, Buffer.from(s, "utf8")); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, file);
  syncDir(path.dirname(file));
}
