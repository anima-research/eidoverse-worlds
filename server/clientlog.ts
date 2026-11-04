// server/clientlog.ts — the /clientlog tee's budget: rate, size, scrub, disk. The numbers and their precedents (Beeper rageshake,
// Mastodon, Sentry, Logster, Element): notes/eidoverse/pr260/RESEARCH-clientlog-budget-conventions-2026-11-03.md.
import { existsSync, mkdirSync, readdirSync, statSync, appendFileSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { newBucket, admitMessage, type MsgBucket } from "./msgrate.ts";

const num = (k: string, d: number) => Math.max(0, Number(process.env[k] ?? d));   // an operator's rail (README): 0 = none
export const LIMITS = {
  ipPer10Min: num("CLIENTLOG_IP_PER_10MIN", 30),        // posts per address (IPv6 by /64) per 10 min, the burst the same
  senderPer10Min: num("CLIENTLOG_SENDER_PER_10MIN", 30), senderBurst: 10,   // posts per signed-in account (else per address) per 10 min, 10 in a row: several tabs and an agent fit (RESEARCH-bf4-questions)
  bodyBytes: 256 * 1024,                 // a request above this is 413, by Content-Length and again while reading
  lineChars: 2000, lines: 2000,          // inside a request: cut, never refused
  senderBytes: 2 * 1024 * 1024,          // a sender's file keeps its newest 2 MB
  totalBytes: 200 * 1024 * 1024,         // the store keeps its newest 200 MB, oldest files first
  keepMs: num("CLIENTLOG_KEEP_DAYS", 14) * 86_400_000,   // and nothing older than 14 days, per file by its last write; retired hourly (routes.ts)
};
const WINDOW_MS = 600_000;

/** An address's bucket key: IPv4 as is, IPv6 by its /64 (one host holds a /64, so one key per host, not 2^64). */
export function ipBucketKey(addr: string): string {
  const a = addr.replace(/%.*$/, "").toLowerCase();
  if (!a.includes(":")) return a;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(a); if (mapped) return mapped[1]!;
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(a);   // the same address in hex groups (::ffff:102:304)
  if (hex) { const n = (parseInt(hex[1]!, 16) << 16 | parseInt(hex[2]!, 16)) >>> 0; return [n >>> 24, n >> 16 & 255, n >> 8 & 255, n & 255].join("."); }
  const [head = "", tail = ""] = a.split("::"), h = head ? head.split(":") : [], t = tail ? tail.split(":") : [];
  const groups = [...h, ...Array<string>(Math.max(0, 8 - h.length - t.length)).fill("0"), ...t];
  return groups.slice(0, 4).map((g) => g.replace(/^0+(?=.)/, "")).join(":") + "::/64";
}

/** Two token buckets a post spends from, the sender's then the address's (server/msgrate.ts: the house's bucket): a sender
 *  refused by its own bucket spends nothing from the address its neighbours share. */
export class ClientLogRate {
  private ip = new Map<string, MsgBucket>(); private sender = new Map<string, MsgBucket>(); private sweptAt = 0;
  /** null when admitted, else the whole seconds until a token returns (Retry-After). */
  admit(addr: string, sender: string, now = Date.now()): number | null {
    if (now - this.sweptAt > 60_000) { this.sweptAt = now; for (const m of [this.ip, this.sender]) for (const [k, b] of m) if (now - b.at > WINDOW_MS) m.delete(k); }
    return this.take(this.sender, sender, now, LIMITS.senderPer10Min, LIMITS.senderBurst)
      ?? this.take(this.ip, ipBucketKey(addr), now, LIMITS.ipPer10Min, LIMITS.ipPer10Min);
  }
  private take(m: Map<string, MsgBucket>, key: string, now: number, per10Min: number, burst: number): number | null {
    if (!per10Min) return null;
    let b = m.get(key); if (!b) { b = newBucket(burst); m.set(key, b); }
    const rate = per10Min * 1000 / WINDOW_MS;
    if (admitMessage(b, now, rate, burst) === "run") return null;
    return Math.max(1, Math.ceil((1 - b.tokens) / rate));
  }
}

const KEYS = String.raw`(?:password|passwd|secret|token|bearer|auth|authorization|cookie|set-cookie|api[_-]?key|credentials?|private[_-]?key)`;
const RULES: [RegExp, string][] = [
  [/((?<![a-z0-9])(?:set-)?cookie(?![a-z0-9])"?\s*[:=]\s*"?)(?!\[Filtered\])[^"\n}]+/gi, "$1[Filtered]"],   // a cookie header whole: its value is `a=1; ew_sess=…`, so no stop at `;`
  [new RegExp(String.raw`((?<![a-z0-9])${KEYS}(?![a-z0-9])[\w-]*"?\s*[:=]\s*"?)(?!\[Filtered\])((?:bearer\s+)?[^"\s,;&}\]]+)`, "gi"), "$1[Filtered]"],   // key: value, key=value, "key":"value", Header: value
  [/\bbearer\s+(?!\[Filtered\])[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer [Filtered]"],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g, "[Filtered]"],                      // a JWT
  [/(\/\/)[^\s/@"']+:[^\s/@"']+@/g, "$1[Filtered]@"],                                                 // user:pass@host in a URL
  [/([?&](?:key|sig|signature|access_token|id_token|refresh_token|apikey|api_key)=)(?!\[Filtered\])[^&\s"'#]+/gi, "$1[Filtered]"],
];
/** Secrets a client's console may carry, replaced by `[Filtered]` (Sentry's default key list, plus cookies, URL auth,
 *  bearer/JWT shapes, and ICE/TURN credentials); the key and the rest of the line stay. */
export function scrub(text: string): { text: string; scrubbed: number } {
  let scrubbed = 0;
  for (const [re, to] of RULES) text = text.replace(re, (...m) => { scrubbed++; return to.replace(/\$(\d)/g, (_, i) => m[Number(i)] ?? ""); });
  return { text, scrubbed };
}
/** A private-key block has no business in a console log: the whole request is refused, nothing stored (rageshake's
 *  rejection_conditions; Element's CVE-2024-34353 was a key that reached the server). */
export const holdsPrivateKey = (text: string) => /-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(text);

/** A request's lines within LIMITS: a long line keeps its head, too many lines keep the head and the tail, each cut marked. */
export function boundLines(text: string): { lines: string[]; cut: number } {
  let cut = 0;
  let lines = text.split(/\r?\n/).filter((l) => l.length > 0)
    .map((l) => (l.length > LIMITS.lineChars ? (cut++, `${l.slice(0, LIMITS.lineChars)} …[cut at ${LIMITS.lineChars} chars]`) : l));
  if (lines.length > LIMITS.lines) {
    const head = Math.floor(LIMITS.lines / 2), tail = LIMITS.lines - head - 1, dropped = lines.length - head - tail;
    lines = [...lines.slice(0, head), `…[${dropped} lines cut]`, ...lines.slice(-tail)]; cut += dropped;
  }
  return { lines, cut };
}

/** One file per world and sender under `dir`: `<world>/<sender>.log`. A new line always lands; what gives way is the old:
 *  a sender's file keeps its newest `senderBytes`, the store its newest `totalBytes` (oldest files first) and `keepMs`. */
export class ClientLogStore {
  private files = new Map<string, { size: number; mtime: number }>(); private total = 0; private retiredAt = 0;
  constructor(readonly dir: string, readonly caps = { senderBytes: LIMITS.senderBytes, totalBytes: LIMITS.totalBytes, keepMs: LIMITS.keepMs }) {
    mkdirSync(dir, { recursive: true }); this.scan();
  }
  /** What is on disk, by name and stat. */
  scan() {
    this.files.clear(); this.total = 0;
    for (const w of readdirSync(this.dir, { withFileTypes: true })) {
      if (!w.isDirectory()) continue;
      for (const f of readdirSync(join(this.dir, w.name))) {
        if (!f.endsWith(".log")) continue;
        const p = join(this.dir, w.name, f); const s = statSync(p);
        this.files.set(p, { size: s.size, mtime: s.mtimeMs }); this.total += s.size;
      }
    }
  }
  pathOf(world: string, sender: string) { return join(this.dir, world, `${sender}.log`); }
  bytesOf(world: string, sender: string) { return this.files.get(this.pathOf(world, sender))?.size ?? 0; }
  get totalSize() { return this.total; }
  /** Appends `chunk`; throws when the filesystem refuses (the caller answers 500, never a false ok). */
  append(world: string, sender: string, chunk: string, now = Date.now()) {
    const path = this.pathOf(world, sender); mkdirSync(join(this.dir, world), { recursive: true });
    let bytes = Buffer.byteLength(chunk);
    if (bytes > this.caps.senderBytes) { chunk = tailAtLine(chunk, this.caps.senderBytes); bytes = Buffer.byteLength(chunk); }
    const cur = this.files.get(path);
    if (cur && cur.size + bytes > this.caps.senderBytes) {   // roll: keep the newest half, so the next appends don't each rewrite
      const kept = tailAtLine(readFileSync(path, "utf8"), Math.floor(this.caps.senderBytes / 2) - bytes);
      writeFileSync(path, kept); this.total -= cur.size - Buffer.byteLength(kept); cur.size = Buffer.byteLength(kept);
    }
    appendFileSync(path, chunk);
    const e = cur ?? { size: 0, mtime: 0 }; e.size += bytes; e.mtime = now; this.files.set(path, e); this.total += bytes;
    while (this.total > this.caps.totalBytes) { const oldest = this.oldest(); if (!oldest || oldest === path) break; this.remove(oldest); }
    if (now - this.retiredAt > 3_600_000) this.retire(now);
  }
  /** Unlinks every file last written before `now - keepMs`; keepMs 0 keeps everything. */
  retire(now = Date.now()) {
    this.retiredAt = now;
    if (!this.caps.keepMs) return;
    for (const [p, e] of this.files) if (now - e.mtime > this.caps.keepMs) this.remove(p);
  }
  private oldest(): string | null {
    let best: string | null = null, at = Infinity;
    for (const [p, e] of this.files) if (e.mtime < at) { at = e.mtime; best = p; }
    return best;
  }
  private remove(p: string) {
    const e = this.files.get(p); if (!e) return;
    try { unlinkSync(p); } catch (err) { if (existsSync(p)) throw err; }
    this.files.delete(p); this.total -= e.size;
  }
}
/** The last `max` bytes of `text`, from a line start. */
function tailAtLine(text: string, max: number): string {
  if (max <= 0) return "";
  const buf = Buffer.from(text); if (buf.byteLength <= max) return text;
  const slice = buf.subarray(buf.byteLength - max); const nl = slice.indexOf(10);
  return slice.subarray(nl < 0 ? 0 : nl + 1).toString();
}
