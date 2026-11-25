// The gzip copies serveFrom (routes.ts) hands out, bounded: a byte budget for the copies kept (least recently served go
// first) and a size past which a file is not gzipped in-process at all (the gzip runs on the serving thread).

import { envNumber } from "./limits.ts";

/** GZIP_CACHE_MB: gzip copies kept in memory, in MB (default 256: the client's code plus some fifty 10 MB avatars, gzipped).
 *  GZIP_MAX_MB: a file larger than this is served as it is, uncompressed, by design (default 32). The gzip runs on the
 *  serving thread: a 40 MB body holds every visitor for most of a second, and a big avatar is mostly packed binary that
 *  shrinks some 25% (test/server/gz-stall-test.ts). Either may be set as high as wanted; 0 is no limit (every copy kept, every such file gzipped). */
export const gzConfig = {
  maxBytes: envNumber("GZIP_CACHE_MB", 256, (n) => n >= 0) * 1_000_000,
  maxFile: envNumber("GZIP_MAX_MB", 32, (n) => n >= 0) * 1_000_000,
};

const cache = new Map<string, { mtime: number; gz: Uint8Array }>();   // insertion order = least recently served first
let held = 0;

/** Whether a file of `size` bytes may be gzipped here at all. */
export const gzipsAt = (size: number) => gzConfig.maxFile <= 0 || size <= gzConfig.maxFile;
const budget = () => gzConfig.maxBytes > 0 ? gzConfig.maxBytes : Infinity;

/** The gzip of the file at `path` as of `mtime`: from the cache, else made (`read` gives its bytes) and kept while the
 *  budget allows. Null when the file is over GZIP_MAX_MB. */
export function gzipOf(path: string, mtime: number, size: number, read: () => Uint8Array): Uint8Array | null {
  if (!gzipsAt(size)) return null;
  const had = cache.get(path);
  if (had) { cache.delete(path); if (had.mtime === mtime) { cache.set(path, had); return had.gz; } held -= had.gz.length; }
  const gz = Bun.gzipSync(read());
  if (gz.length <= budget()) {
    cache.set(path, { mtime, gz }); held += gz.length;
    for (const [k, e] of cache) { if (held <= budget()) break; cache.delete(k); held -= e.gz.length; }
  }
  return gz;
}

/** For tests and diagnostics. */
export const gzStats = () => ({ entries: cache.size, bytes: held });
export function gzReset() { cache.clear(); held = 0; }
