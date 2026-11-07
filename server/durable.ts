// server/durable.ts — the disk practice a sequencer owes its readers (platforms review 10-06, #5):
//  - a line is on disk (fsync) BEFORE anyone is told about it: otherwise a crash after a broadcast loses the tail, the
//    restarted server re-issues the same seq with a different head, and every client holding (seq, head) holds "proof"
//    the authority equivocated;
//  - a torn last line (a crash mid-write) is cut off at open, not kept as a permanent malformed entry;
//  - a blob is written to a temp file and renamed, and one whose bytes don't match its name is rewritten, never kept.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { sha256 } from "../shared/protocol/hash.js";

/** Does the file at `p` hold `needle`'s bytes? Read in 1 MiB chunks, never whole (the boot sweep's peek, review L18). */
export function fileIncludes(p: string, needle: string): boolean {
  const n = Buffer.from(needle), b = Buffer.allocUnsafe((1 << 20) + n.length), fd = fs.openSync(p, "r");
  try { for (let pos = 0, keep = 0; ;) { const got = fs.readSync(fd, b, keep, b.length - keep, pos); if (got <= 0) return false;
    pos += got; const end = keep + got; if (b.subarray(0, end).includes(n)) return true;
    keep = Math.min(n.length - 1, end); b.copy(b, 0, end - keep, end); } }   // a needle across the chunk edge is found next read
  finally { fs.closeSync(fd); }
}

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
export function syncDir(dir: string) {
  if (process.platform === "win32") return;
  const fd = fs.openSync(dir, "r");
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

/** fsync one file's bytes (a copy just made: copyFileSync syncs nothing). Windows flushes a file only through a handle
 *  opened for writing (FlushFileBuffers); POSIX blobs may be read-only. */
export function syncFile(p: string) {
  const fd = fs.openSync(p, process.platform === "win32" ? "r+" : "r");
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
/** fsync every file and directory under `dir`, deepest first, `dir` included: a tree copied with cpSync (a fork's blobs)
 *  is written but not durable until each file's bytes and each directory's entries are synced. */
export function syncTree(dir: string) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) syncTree(p);
    else if (ent.isFile()) syncFile(p);
  }
  syncDir(dir);
}

/** Make `dir` and any missing parents, durably: a directory mkdir just made is named by an entry in its parent, which a
 *  crash can lose like any other new name, taking the directory and what was written in it. So each parent that gained an
 *  entry is synced, from `dir`'s own parent up to the parent of the first directory made. `dir` itself is the caller's to
 *  sync once its file is in it. */
export function mkdirDurable(dir: string) {
  const first = fs.mkdirSync(dir, { recursive: true });
  if (first === undefined) return;
  const top = path.dirname(path.resolve(first));
  for (let d = path.dirname(path.resolve(dir)); ; d = path.dirname(d)) { syncDir(d); if (d === top || d === path.dirname(d)) break; }
}

/** Replace `file` with `data`, atomically and durably: written whole to a temp file (`mode`, set before the data goes in)
 *  and synced, renamed over `file`, and the directory that holds the new name synced. */
export function replaceDurable(file: string, data: string | Uint8Array, mode = 0o644) {
  mkdirDurable(path.dirname(file));
  const tmp = `${file}.${process.pid}.tmp`;
  const fd = fs.openSync(tmp, "w", mode);
  try { fs.fchmodSync(fd, mode); writeAll(fd, typeof data === "string" ? Buffer.from(data, "utf8") : data); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, file);
  syncDir(path.dirname(file));   // the new name, in its directory
}
// ---- the one cross-process file lock (was custody.ts's): pid + nonce written to a file of its own and synced, then linked to the
// lock name, so the lock never exists without its holder; a dead holder (its pid exited) is removed, never one merely old ----
/** Who holds a lock file: the pid and the nonce its taker wrote (`<pid> <nonce>`), or null when it can't be read. */
function holderOf(f: string): { pid: number; nonce: string } | null {
  let s: string; try { s = fs.readFileSync(f, "utf8"); } catch { return null; }
  const [p, nonce] = s.split(" "); const pid = Number(p);
  return Number.isInteger(pid) && pid > 0 && /^[0-9a-f]{16}$/.test(nonce ?? "") ? { pid, nonce } : null;
}
/** Whether the holder `pid` named in a lock is gone: its process exited (same host: the file is local), or it is this
 *  process. A lock is held only inside one synchronous call, and only the main thread takes one, so a lock naming this
 *  process that the call doesn't hold was left by an earlier process with the same pid: a restart can get its old pid
 *  back. A worker thread that took one would share this pid and could clear a live sibling's lock: one that does needs the
 *  thread in the lock's holder. */
function gone(pid: number): boolean {
  if (pid === process.pid) return true;
  try { process.kill(pid, 0); return false; } catch (e) { return (e as NodeJS.ErrnoException).code === "ESRCH"; }
}
/** Takes the lock file `name` for this process, or returns null when another holds it. Returns the nonce. */
function take(name: string): string | null {
  const nonce = crypto.randomBytes(8).toString("hex"), tmp = `${name}.${nonce}.tmp`;
  const fd = fs.openSync(tmp, "wx", 0o600);
  try { fs.writeSync(fd, `${process.pid} ${nonce}`); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  try { fs.linkSync(tmp, name); return nonce; }
  catch (e) { if ((e as NodeJS.ErrnoException).code === "EEXIST") return null; throw e; }
  finally { fs.rmSync(tmp, { force: true }); }
}
/** Removes the lock file `f` if its holder is gone (above), as one step. Two waiters can both see the same dead holder, so the
 *  one that removes it first takes `<lock>.<its nonce>`, the right to remove that one lock, and removes `f` only if `f`
 *  still holds that nonce. A nonce is never reused, so a lock that has since replaced it is never removed. A right whose
 *  holder is gone before giving it back is removed the same way. Whether it removed `f`. */
function clearIfGone(lock: string, f: string): boolean {
  const h = holderOf(f); if (!h || !gone(h.pid)) return false;
  const right = `${lock}.${h.nonce}`;
  if (!take(right)) { clearIfGone(lock, right); return false; }
  try { if (holderOf(f)?.nonce !== h.nonce) return false; fs.unlinkSync(f); return true; } finally { fs.rmSync(right, { force: true }); }
}
/** Run `f` holding the lock file `lock` (its directory must exist): another process waits up to `waitMs` for it, removes one
 *  whose holder has exited, and throws past `waitMs`. Only this process removes its own lock. Not re-entrant. */
export function withFileLock<T>(lock: string, waitMs: number, f: () => T): T {
  const wait = new Int32Array(new SharedArrayBuffer(4)); const until = performance.now() + waitMs;
  while (!take(lock)) {
    if (clearIfGone(lock, lock)) continue;
    if (performance.now() > until) { const h = holderOf(lock);
      throw new Error(`${lock} has been held${h ? ` by process ${h.pid}` : ""} for ${waitMs / 1000} s; if no process is using it, remove it`); }
    Atomics.wait(wait, 0, 0, 10);
  }
  try { return f(); } finally { fs.rmSync(lock, { force: true }); }
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
