// Identity is carried by the authored log's own bytes, not a sidecar whose
// rename could separate it from the log during reset. Only read the opening
// line; an incomplete/oversized/unreadable opening has no resolved identity.
import { openSync, readSync, closeSync } from "node:fs";
import { createHash } from "node:crypto";
export const LOG_OPENING_LIMIT = 65536;
export function logIdentity(path: string): string {
  const fd = openSync(path, "r");
  try {
    const bytes = Buffer.alloc(LOG_OPENING_LIMIT);
    let used = 0;
    while (used < bytes.length) {
      const n = readSync(fd, bytes, used, bytes.length - used, used);
      if (n === 0) break;
      const end = bytes.indexOf(10, used);
      used += n;
      if (end >= 0 && end < used) {
        if (end === 0) throw new Error("empty authored-log opening");
        return "sha256:" + createHash("sha256").update(bytes.subarray(0, end + 1)).digest("hex");
      }
    }
    throw new Error("authored-log opening is incomplete or exceeds " + LOG_OPENING_LIMIT + " bytes");
  } finally { closeSync(fd); }
}
