// server/lazylog.ts — a log whose prefix stays on disk: genesis and the tail read from the cache's offsets; a prefix line is read
// and strictly parsed on first access (a holey array whose prototype answers a hole), so every reader sees the eager entries.
import fs from "node:fs";
import { readLog, Malformed } from "../shared/protocol/fold.js";
import { posAt } from "../shared/protocol/authority.js";
import type { At } from "./statecache.ts";

type Any = any;
const isE = (e: Any) => e && !(e instanceof Malformed) && typeof e === "object";
const CHUNK = 8 << 20;

function readAt(fd: number, pos: number, len: number) {
  const b = Buffer.allocUnsafe(len); let off = 0;
  while (off < len) { const n = fs.readSync(fd, b, off, len - off, pos + off); if (n <= 0) throw new Error(`short read at byte ${pos + off}`); off += n; }
  return b;
}

/** The entries of the log at `logPath` with lines 1..coversIndex-1 left on disk, or null (with `why`) when the file doesn't
 *  hold, at the cache's offsets, the genesis and the covered line (head `coversHead`) it says. A torn last line is cut, as
 *  readLogBytes cuts it (this is the log's writer). */
export function openTail(logPath: string, coversIndex: number, coversHead: string, at: At, why: (s: string) => void) {
  let fd: number; try { fd = fs.openSync(logPath, "r"); } catch { return null; }
  try {
    const st = fs.fstatSync(fd); let size = st.size;
    if (!(at.g > 0 && at.g <= at.start && at.start < at.end && at.end <= size)) { why(`the log has ${size} bytes, and it covered [${at.start}, ${at.end})`); return null; }
    let tail = readAt(fd, at.start, size - at.start);
    if (tail[tail.length - 1] !== 0x0a) { const keep = tail.lastIndexOf(0x0a) + 1;
      if (at.start + keep < at.end) { why("the covered line is torn"); return null; }
      console.warn(`[log] ${logPath}: cut a torn last line (${tail.length - keep} bytes, no newline) left by an interrupted write`);
      fs.truncateSync(logPath, at.start + keep); size = at.start + keep; tail = tail.subarray(0, keep); }
    const gb = readAt(fd, 0, at.g);
    if (gb.indexOf(0x0a) !== at.g - 1 || tail.indexOf(0x0a) !== at.end - at.start - 1) { why("the covered line isn't at its offset"); return null; }
    const [g] = readLog(gb.subarray(0, at.g - 1)); const T = readLog(tail);
    if (!isE(g) || g.kind !== "genesis" || !isE(T[0]) || T[0].head !== coversHead) { why(`line ${coversIndex} isn't at its offset (another head)`); return null; }
    const E: Any[] = []; E.length = coversIndex + T.length; E[0] = posAt(g, 0);
    for (let k = 0; k < T.length; k++) E[coversIndex + k] = posAt(T[k], coversIndex + k);
    return { entries: E, size, lastStart: at.start + tail.lastIndexOf(0x0a, tail.length - 2) + 1, prefix: lazyPrefix(E, logPath, coversIndex, at.start, { dev: st.dev, ino: st.ino }) };
  } finally { fs.closeSync(fd); }
}

/** Lines 1..hi-1 of E (on disk before byte `end`) load on first read. → {onDisk(), loadAll()}: how many are still on disk,
 *  and read the rest at once (a purge, a refold from genesis). */
function lazyPrefix(E: Any[], logPath: string, hi: number, end: number, ident: { dev: number; ino: number }) {
  let offs: Float64Array | null = null, left = Math.max(0, hi - 1), fd: number | null = null;
  const open = () => {
    if (fd !== null) return fd;
    const f = fs.openSync(logPath, "r"); const s = fs.fstatSync(f);
    if (s.dev !== ident.dev || s.ino !== ident.ino || s.size < end) { fs.closeSync(f); throw new Error(`${logPath} is no longer the log this world booted from (replaced or cut): its covered lines can't be read`); }
    fd = f; queueMicrotask(() => { try { fs.closeSync(f); } catch { /* closed */ } fd = null; });   // one open per synchronous run
    return f;
  };
  const lineStarts = () => {   // offs[i] = line i's first byte, offs[hi] = end
    if (offs) return offs;
    const f = open(), o = new Float64Array(hi + 1); let i = 1;
    for (let pos = 0; pos < end; pos += CHUNK) { const b = readAt(f, pos, Math.min(CHUNK, end - pos));
      for (let k = b.indexOf(0x0a); k >= 0; k = b.indexOf(0x0a, k + 1)) { if (i > hi) throw new Error(`${logPath}: more lines before byte ${end} than the fold cache covered`); o[i++] = pos + k + 1; } }
    if (i !== hi + 1 || o[hi] !== end) throw new Error(`${logPath}: ${i - 1} lines before byte ${end}, and the fold cache covered ${hi}`);
    return (offs = o);
  };
  const put = (n: number, e: Any) => { Object.defineProperty(E, n, { value: posAt(e, n), writable: true, enumerable: true, configurable: true }); if (--left === 0) Object.setPrototypeOf(E, Array.prototype); return e; };
  const load = (n: number) => { const o = lineStarts(); const [e] = readLog(readAt(open(), o[n], o[n + 1] - o[n] - 1)); return put(n, e); };
  const slot = (k: string | symbol) => { if (typeof k !== "string") return -1; const n = +k; return n >= 1 && n < hi && String(n) === k && !Object.hasOwn(E, k) ? n : -1; };
  if (left) Object.setPrototypeOf(E, new Proxy(Array.prototype, {
    get(t, k, r) { const n = r === E ? slot(k) : -1; return n < 0 ? Reflect.get(t, k, r) : load(n); },
    has(t, k) { return slot(k) >= 0 || Reflect.has(t, k); },
  }));
  return {
    onDisk: () => left,
    loadAll() { if (!left) return; const f = open(); const all = readLog(readAt(f, 0, end));
      if (all.length !== hi) throw new Error(`${logPath}: ${all.length} lines before byte ${end}, and the fold cache covered ${hi}`);
      for (let n = 1; n < hi && left; n++) if (!Object.hasOwn(E, n)) put(n, all[n]); },
  };
}
