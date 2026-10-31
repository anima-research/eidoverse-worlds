// eidoverse-worlds sequencer — filesystem idioms (R2, survey §4.1).
//
// The tmp-write + rename pair was hand-rolled TEN times across the server
// (auth, moderation, routes, upload, world ×2, seats ×2, optimize, and the
// MCPL door), with accidental differences: two sites passed mode 0600,
// one had orphan-tmp cleanup, exactly one (seats) routed through an
// injectable fs surface so its failure atomicity is TESTABLE. One helper
// now, carrying the best of each: atomicity by rename, explicit mode,
// injectable fs (the seats fault-injection precedent — every caller
// inherits testability), and stale-tmp tolerance (a crash between write
// and rename leaves <path>.tmp; the next write simply overwrites it).

import { writeFileSync, renameSync, lstatSync, openSync, writeSync, fsyncSync, closeSync, unlinkSync } from "node:fs";
import { randomBytes } from "node:crypto";

export type AtomicFs = {
  writeFileSync: typeof writeFileSync;
  renameSync: typeof renameSync;
};

/** Write-then-rename. The rename is the commit: readers never observe a
 *  half-written file, and a crash costs at most an orphan .tmp beside it. */
export function atomicWrite(
  path: string,
  data: string | Uint8Array,
  opts: { mode?: number; fs?: AtomicFs } = {},
) {
  const fs: AtomicFs = opts.fs ?? { writeFileSync, renameSync };
  fs.writeFileSync(`${path}.tmp`, data, opts.mode != null ? { mode: opts.mode } : undefined);
  fs.renameSync(`${path}.tmp`, path);
}

/** A private file (0600), written atomically: a fresh random temp made with "wx" (a planted temp or symlink is never followed),
 *  and a symlink at the target refused rather than replaced (post-review 10-28 #5). */
export function writePrivate(path: string, data: string) {
  let link = false; try { link = lstatSync(path).isSymbolicLink(); } catch { /* absent: fine */ }
  if (link) throw new Error(`${path} is a symlink: refused (remove it, then try again)`);
  const tmp = `${path}.${randomBytes(8).toString("hex")}.tmp`, fd = openSync(tmp, "wx", 0o600);
  try { writeSync(fd, data); fsyncSync(fd); closeSync(fd); renameSync(tmp, path); }
  catch (e) { try { closeSync(fd); } catch { /* closed */ } try { unlinkSync(tmp); } catch { /* gone */ } throw e; }
}
