// eidoverse-worlds sequencer — the world itself (TEL0S_NOTES §15, step 7c).
//
// The unsplit World class decomposes into two collaborators behind ONE thin
// facade:
//   WorldLog     — the authored plane at rest. Entries, the folded state (the
//                  fold IS the log's projection, so state lives beside the
//                  entries it summarizes), the snapshot byte-offset
//                  bookkeeping, remembered poses — and every file under
//                  worlds/<name>/.
//   WorldSession — the embodied plane in flight. Connected clients, the
//                  dirty-pose batch, entity leases, stage-frame bookkeeping.
//                  Never persisted. Depends on the log ONE WAY (settleLease
//                  commits outcomes as `place` entries); the log never learns
//                  sessions exist.
// The World facade preserves the unsplit public surface exactly, so
// server.ts's call sites, behaviors.ts's WorldLike, and verbs.ts's VerbWorld
// all hold without edits. The registry (getWorld/forkWorld/worlds) lives here
// too; the boot sweep that CALLS getWorld stays in server.ts — waking
// scripted worlds with the server is boot policy, not world mechanics.

import { mkdirSync, existsSync, appendFileSync, readFileSync, writeFileSync, renameSync, copyFileSync } from "node:fs";
import { join } from "node:path";
import { WORLDS_DIR, FOLD_EVERY } from "./config.ts";
import { BehaviorHost } from "./behaviors.ts";
import { foldEntry, emptyState, type LogEntry, type WorldState } from "../shared/fold.js";
import { publishEntry } from "./events.ts";
import type { HnSession } from "./auth.ts";

// The settle rule — what a pose looks like TO SOMEONE ELSE — is pinned to
// server.ts by source-text gates (§15.1: settled-pose-test regexes the file
// itself). The log needs it for rememberPose, so it arrives by injection at
// boot: the wireBehaviorGate precedent, one implementation, two planes.
let settle: (pose: unknown) => Record<string, unknown> | null = () => {
  throw new Error("settledPose not wired — server.ts wires it at boot");
};
export function wireSettledPose(fn: typeof settle) { settle = fn; }

// ------------------------------------------------------------------- clients

export type Client = {
  id: string;          // participant id (v1: self-declared; later: key-derived)
  ws: { send(data: string): void; close?(code?: number, reason?: string): void; getBufferedAmount?(): number; readyState?: number };
  world: World | null;
  /** latest pose, forwarded to late joiners so they see everyone immediately.
   *  Minimal structure over an open record: the punt-reach and lease-
   *  proximity checks dereference `.p`, everything else rides opaque. */
  lastPose: ({ p?: [number, number, number] } & Record<string, unknown>) | null | undefined;
  avatar: string;      // VRM library path chosen at join
  spectator: boolean;  // retina/observer connections: receive everything, appear as nothing
  agent?: boolean;     // self-declared: an MCPL body, not a person at a keyboard
  auth?: HnSession;    // archipelago-home session bound at WS upgrade (verified human)
  sub?: string;        // durable principal id when authenticated (`human:discord:…`)
  superseded?: boolean; // kicked by identity takeover — don't let its stale pose overwrite the successor's
  tokenVerified?: boolean; // this leg presented the identity's own bearer at join
  auxBound?: boolean;  // this aux leg is bound to the primary's identity authority (token bearer OR matching login sub) — the B1 admission result, reused by the B3 attest gate
  gen?: number;        // surfaceSession (#57 B2): server-issued transport epoch for THIS leg.
                       // Monotonic, never reused. Every rtc/attestation message is stamped with
                       // it, and a superseded generation's messages are refused structurally —
                       // takeover retires the GENERATION, not just the socket.
  surface?: string;    // (name, surface) session model: "world" = the embodied primary (default);
                       // anything else = an auxiliary media leg (voice, vr-hands, …) — invisible,
                       // poseless, log-mute, rtc-capable, and REAPED when its primary dies.
                       // Per-surface last-writer-wins replaces the flat one-body rule (2026-08-07;
                       // prior art: Discord voice legs keyed to gateway sessions, XMPP resources).
  renderer?: boolean;  // donates rendering: can answer snap requests for its world
  bcRing?: unknown[];  // dev crash forensics (?bc=1): last N breadcrumbs, printed on close
  // rate windows: a griefer or a stuck client gets silence, not fanout
  msgWin: number; msgCount: number;   // all messages, per second
  verbWin: number; verbCount: number; // authored verbs, per 4s
};

// ---------------------------------------------------------------- world logs

/** The authored plane at rest: the append-only log, its live fold, and the
 *  snapshot/byte-offset machinery that keeps boot proportional to the tail. */
export class WorldLog {
  name: string;
  entries: LogEntry[] = [];
  /** The folded world. Kept live: every append updates it, so writing a
   *  snapshot is O(1) rather than a replay. */
  state: WorldState = emptyState();
  /** How much of the log the snapshot already accounts for. Entries after this
   *  are the tail a joiner still has to be told about. */
  snapSeq = -1;
  private snapBytes = 0;      // byte offset in log.jsonl just past snapSeq
  private logBytes = 0;
  private dirtySinceFold = 0;
  /** The last ≤256 say entries, fold-proof — the attest handler's lookup
   *  table (#57, review finding 3). See append(). */
  recentSays: LogEntry[] = [];
  private logPath: string;
  private posesPath: string;
  private snapPath: string;
  /** Where each identity last stood — the world remembers your resting place
   *  across disconnects, restarts, and hosts. Presence is ephemeral; the
   *  place you fell asleep is yours. */
  poses: Record<string, unknown> = {};

  constructor(name: string) {
    this.name = name;
    const dir = join(WORLDS_DIR, name);
    mkdirSync(dir, { recursive: true });
    this.logPath = join(dir, "log.jsonl");
    this.posesPath = join(dir, "poses.json");
    this.snapPath = join(dir, "snapshot.json");

    // Boot = snapshot + the bytes after it. The offset is what keeps startup
    // proportional to the TAIL rather than to the whole history: without it we
    // would still parse every line ever written just to find where to resume.
    if (existsSync(this.snapPath)) {
      try {
        const snap = JSON.parse(readFileSync(this.snapPath, "utf8"));
        if (snap?.state && typeof snap.seq === "number") {
          this.state = snap.state;
          this.snapSeq = snap.seq;
          this.snapBytes = snap.bytes ?? 0;
        }
      } catch { /* a corrupt cache is not a corrupt world — rebuild below */ }
    }
    if (existsSync(this.logPath)) {
      const buf = readFileSync(this.logPath);
      this.logBytes = buf.length;
      // If the offset is not credible (log truncated, forked, or snapshot from
      // another timeline) fall back to reading everything. The log is truth.
      const usable = this.snapSeq >= 0 && this.snapBytes > 0 && this.snapBytes <= buf.length;
      if (!usable) { this.state = emptyState(); this.snapSeq = -1; this.snapBytes = 0; }
      const text = buf.toString("utf8", usable ? this.snapBytes : 0);
      for (const line of text.split("\n")) {
        if (!line.trim()) continue;
        const e = JSON.parse(line) as LogEntry;
        this.entries.push(e);
        foldEntry(this.state, e);
      }
      this.dirtySinceFold = this.entries.length;
    }
    if (existsSync(this.posesPath)) {
      try { this.poses = JSON.parse(readFileSync(this.posesPath, "utf8")); } catch { /* corrupt = fresh */ }
    }
    // A brand-new world's first entry names the log dialect — the one fix
    // with a deadline, because it only helps logs written after it exists
    // (Hesperus finding #5). Old readers fold it as an unknown verb: nothing.
    if (this.logBytes === 0 && this.snapSeq < 0) {
      this.append("world", "genesis", { v: 2, dialect: "eidoverse-log" });
    }
  }

  /** Write the folded state beside the log. Atomic, and recording the byte
   *  offset so the next boot can seek instead of scan. */
  fold(reason = "threshold") {
    const bytes = this.logBytes;
    const seq = this.snapSeq + this.entries.length;
    if (seq < 0) return;
    const payload = JSON.stringify({ v: 1, seq, bytes, ts: Date.now(), state: this.state });
    try {
      // the snapshot's `bytes` is a promise about the FILE — the batch must
      // land first, or the recorded offset points past bytes that aren't
      // there and the next boot discards the snapshot (§15.1's one hard
      // async-append constraint). A flush failure aborts the fold: state
      // stays unfolded, retried on the next threshold, honestly.
      this.flushLog();
      writeFileSync(this.snapPath + ".tmp", payload);
      renameSync(this.snapPath + ".tmp", this.snapPath);
      this.snapSeq = seq;
      this.snapBytes = bytes;
      this.entries = [];          // history lives in the file; memory holds the tail
      this.dirtySinceFold = 0;
      console.log(`[world:${this.name}] folded through seq ${seq} (${reason})`);
    } catch (err) {
      console.error(`[world:${this.name}] fold failed`, err);
    }
  }

  /** The file half of a reset: archive everything the world was (log,
   *  snapshot, remembered poses) into worlds/<name>/erased-<ts>/ — by RENAME,
   *  never destruction — and zero the in-memory log. The facade owns the
   *  other half (behavior teardown + the fresh genesis). */
  reset(): string {
    this.flushLog();   // pending lines belong to the OLD log — they must be
                       // in the file before it is renamed into the archive
    const dir = join(WORLDS_DIR, this.name);
    const arch = join(dir, `erased-${new Date().toISOString().replace(/[:.]/g, "-")}`);
    mkdirSync(arch, { recursive: true });
    for (const f of ["log.jsonl", "snapshot.json", "poses.json"]) {
      const p = join(dir, f);
      if (existsSync(p)) renameSync(p, join(arch, f));
    }
    this.entries = [];
    this.state = emptyState();
    this.snapSeq = -1;
    this.snapBytes = 0;
    this.logBytes = 0;
    this.dirtySinceFold = 0;
    this.poses = {};
    return arch;
  }

  /** A page of history, newest-first paging via `before`.
   *
   *  Folding bounds what a JOIN costs; it does not delete anything, so this is
   *  how anyone gets at what came before: a human scrolling chat upward, or an
   *  agent asking what happened while it was not thinking. The tail is served
   *  from memory; older pages read the log, which is O(file) per request and
   *  the obvious place a real index goes when that starts to hurt. */
  readHistory({ before = Infinity, after = -Infinity, limit = 50, verbs = null as Set<string> | null }) {
    const out: LogEntry[] = [];
    const seen = new Set<number>();
    const want = (e: LogEntry) => e.seq < before && e.seq > after && (!verbs || verbs.has(e.verb));

    for (let i = this.entries.length - 1; i >= 0 && out.length < limit; i--) {
      const e = this.entries[i];
      if (want(e)) { out.push(e); seen.add(e.seq); }
    }
    // older than what is in memory — go to the file (flushed first, so a
    // page can never miss an entry the memory tail has already dropped)
    const oldestInMemory = this.entries.length ? this.entries[0].seq : Infinity;
    if (out.length < limit && before > 0 && oldestInMemory > 0 && existsSync(this.logPath)) {
      this.flushLog();
      const lines = readFileSync(this.logPath, "utf8").split("\n");
      for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
        const line = lines[i];
        if (!line.trim()) continue;
        let e: LogEntry;
        try { e = JSON.parse(line); } catch { continue; }
        if (seen.has(e.seq) || !want(e)) continue;
        out.push(e); seen.add(e.seq);
      }
    }
    out.reverse();                                   // hand back in world order
    const oldest = out.length ? out[0].seq : null;
    return { entries: out, oldestSeq: oldest, hasMore: oldest !== null && oldest > 0 };
  }

  /** What a joiner needs: the world as it is, plus anything since. */
  joinPayload() {
    return { state: this.state, tail: this.entries, throughSeq: this.snapSeq };
  }

  rememberPose(id: string, pose: unknown) {
    if (!pose) return;
    const still = settle(pose)!;
    this.poses[id] = still;
    writeFileSync(this.posesPath + ".tmp", JSON.stringify(this.poses));
    renameSync(this.posesPath + ".tmp", this.posesPath);
  }

  append(actor: string, verb: string, args: Record<string, unknown>): LogEntry {
    // seq is global across the world's whole history, not an index into what
    // happens to be in memory — folding must not renumber the past.
    const seq = this.snapSeq + this.entries.length + 1;
    const entry: LogEntry = { seq, ts: Date.now(), actor, verb, args };
    this.entries.push(entry);
    // #57 attest lookup (review finding 3): performance receipts resolve a
    // say by seq, but fold() empties entries[] every FOLD_EVERY appends — a
    // say folded out before its receipt arrives (1-2s of synthesis on a busy
    // world) would make a valid attest silently vanish, and every listener's
    // hold would fall back ON TOP of the real voice audio. Says ride their
    // own small ring that folding never touches; the 300s freshness rule in
    // the attest handler is what actually bounds staleness.
    if (verb === "say") {
      this.recentSays.push(entry);
      if (this.recentSays.length > 256) this.recentSays.shift();
    }
    const line = JSON.stringify(entry) + "\n";
    // Batched, not per-entry (§15.1, 7d): seq, the memory tail, logBytes
    // accounting, and the live fold stay SYNCHRONOUS — every reader of
    // world state sees the entry immediately — while the byte hits disk on
    // the next macrotask, so a verb, its reaction, and its behavior emits
    // coalesce into one write instead of three syscalls in the ws handler.
    // Durability is unchanged in kind: the old per-entry appendFileSync
    // promised page cache, never the platter (no fsync existed); this
    // promises the same, one tick later, and every point that makes a
    // claim about the FILE (fold's byte offset, fork's copy, reset's
    // archive, readHistory's scan, shutdown) flushes first.
    this.pending.push(line);
    this.logBytes += Buffer.byteLength(line);
    if (!this.flushArmed) {
      this.flushArmed = true;
      setTimeout(() => {
        this.flushArmed = false;
        try { this.flushLog(); } catch (err) {
          // pending is retained — the next flush point retries; house rule 3
          console.error(`[world:${this.name}] log flush failed`, err);
        }
      }, 0);
    }
    foldEntry(this.state, entry);
    if (++this.dirtySinceFold >= FOLD_EVERY) this.fold();
    return entry;
  }

  private pending: string[] = [];
  private flushArmed = false;

  /** Drain the write batch — one appendFileSync per batch. Called by the
   *  timer, and synchronously by everything that reads or repositions the
   *  file (fold, fork, reset, readHistory's file leg, shutdown). */
  flushLog() {
    if (!this.pending.length) return;
    const chunk = this.pending.join("");
    this.pending = [];
    try {
      appendFileSync(this.logPath, chunk);
    } catch (err) {
      this.pending.unshift(chunk);   // nothing lost — retried at the next point
      throw err;
    }
  }
}

// ----------------------------------------------------------------- sessions

/** The embodied plane in flight: who is connected and what their bodies are
 *  doing right now. Nothing here is ever persisted — presence is ephemeral;
 *  outcomes that must survive commit THROUGH the log (settleLease). */
export class WorldSession {
  clients = new Set<Client>();
  /** Poses received since the last stage-frame tick — latest value wins.
   *  The embodied plane is batched: N performers × M spectators must not be
   *  N×M×15Hz individual sends (24×200 would be 72k msgs/s); it's one frame
   *  per world per tick, fanned out once. */
  dirty = new Map<string, unknown>();
  /** Entity animation leases (docs/leases.md): who may animate each object
   *  right now, and the last transform they streamed — the server's memory,
   *  so a crashed or preempted simulator never loses an object. Presence
   *  plane: never persisted; outcomes commit as `place` verbs. */
  leases = new Map<string, { holder: Client; lastState: { p: number[]; yaw?: number; q?: number[] } | null; lastAt: number }>();
  frameSeq = 0;
  recPath: string | null = null; // frames archive, created lazily on first recorded frame
  lastRoster = "";               // last written roster line — deltas only

  /** `commit` is the facade's append-and-publish (§24 entry bus) — injected
   *  so the session's settlements ride the same spine as every other entry
   *  without the session ever learning the bus (or the facade) exists. */
  constructor(private log: WorldLog,
    private commit: (actor: string, verb: string, args: Record<string, unknown>) => LogEntry) {}

  /** Commit-and-forget one entity lease (docs/leases.md): the last streamed
   *  transform becomes an ordinary `place` entry — server-authored like a
   *  reaction effect, the cause in args — so nothing is ever lost to a
   *  crashed, preempted, or stale simulator. */
  settleLease(id: string, final?: { p?: number[] | null; yaw?: number | null }) {
    const L = this.leases.get(id);
    if (!L) return;
    const p = final?.p ?? L.lastState?.p ?? null;
    const yaw = final?.yaw ?? L.lastState?.yaw;
    this.leases.delete(id);
    if (p && this.log.state.entities[id]) {
      this.commit("world", "place", {
        id, pos: p, ...(yaw != null ? { yaw } : {}), by: L.holder.id, via: "lease",
      });
    }
    this.broadcast({ type: "lease", op: "released", id });
  }

  broadcast(msg: unknown, except?: Client) {
    const data = JSON.stringify(msg);
    for (const c of this.clients) if (c !== except) c.ws.send(data);
  }
}

// --------------------------------------------------------------- the facade

/** The World as everything outside this module knows it: the unsplit class's
 *  exact public surface, delegating to the log and the session underneath.
 *  behaviors.ts's WorldLike and verbs.ts's VerbWorld hold structurally. */
export class World {
  name: string;
  /** The runtime's flight recorder — the "why didn't it work" surface.
   *
   *  The world log holds what HAPPENED; this ring holds what DIDN'T and why:
   *  denied verbs, rejected shapes, rate limits, reactions that fired /
   *  skipped / failed. In-memory only, capped, never persisted — it is
   *  diagnosis, not history. Readable by anyone in the world (ws `debug`,
   *  `/debug` in the client, `world_debug` over MCPL): the log is public, so
   *  the reasons things bounced off it are public too. */
  debugLog: Record<string, unknown>[] = [];
  debug(kind: string, detail: Record<string, unknown>): void {
    this.debugLog.push({ ts: Date.now(), kind, ...detail });
    if (this.debugLog.length > 300) this.debugLog.splice(0, this.debugLog.length - 300);
  }
  /** Runtime-script host — sandboxes, budgets, per-behavior log rings. */
  bhv!: BehaviorHost;
  private log: WorldLog;
  private session: WorldSession;

  constructor(name: string) {
    this.name = name;
    this.log = new WorldLog(name);
    this.session = new WorldSession(this.log, (a, v, ar) => this.commit(a, v, ar));
    // Runtime scripts wake with the world — a behavior keeps behaving with
    // nobody connected (timers), which is the point of running server-side.
    this.bhv = new BehaviorHost(this);
    this.bhv.sync();
    const total = this.snapSeq + 1 + this.entries.length;
    console.log(`[world:${name}] loaded — ${Object.keys(this.state.entities).length} things, `
      + `${this.entries.length} tail entr${this.entries.length === 1 ? "y" : "ies"}`
      + (this.snapSeq >= 0 ? ` (snapshot through seq ${this.snapSeq}, ${total} total)` : "")
      + `, ${Object.keys(this.poses).length} remembered poses`);
  }

  // the authored plane, read through the log
  get entries() { return this.log.entries; }
  get recentSays() { return this.log.recentSays; }
  get state() { return this.log.state; }
  get snapSeq() { return this.log.snapSeq; }
  get poses() { return this.log.poses; }
  // the embodied plane, read through the session (frame bookkeeping is
  // written by server.ts's stage-frame tick, hence the setters)
  get clients() { return this.session.clients; }
  get dirty() { return this.session.dirty; }
  get leases() { return this.session.leases; }
  get frameSeq() { return this.session.frameSeq; }
  set frameSeq(v: number) { this.session.frameSeq = v; }
  get recPath() { return this.session.recPath; }
  set recPath(v: string | null) { this.session.recPath = v; }
  get lastRoster() { return this.session.lastRoster; }
  set lastRoster(v: string) { this.session.lastRoster = v; }

  append(actor: string, verb: string, args: Record<string, unknown>): LogEntry {
    return this.log.append(actor, verb, args);
  }
  /** Append AND publish (§24 entry bus): birth is publication. Every entry
   *  that an audience should hear goes through here; bare append() remains
   *  for the deliberate silences (genesis — see events.ts's rulings). */
  commit(actor: string, verb: string, args: Record<string, unknown>): LogEntry {
    const entry = this.log.append(actor, verb, args);
    publishEntry(this, entry);
    return entry;
  }
  broadcast(msg: unknown, except?: Client) { this.session.broadcast(msg, except); }
  settleLease(id: string, final?: { p?: number[] | null; yaw?: number | null }) {
    this.session.settleLease(id, final);
  }
  fold(reason = "threshold") { this.log.fold(reason); }
  flushLog() { this.log.flushLog(); }
  readHistory(opts: { before?: number; after?: number; limit?: number; verbs?: Set<string> | null }) {
    return this.log.readHistory(opts);
  }
  joinPayload() { return this.log.joinPayload(); }
  rememberPose(id: string, pose: unknown) { this.log.rememberPose(id, pose); }

  /** Erase the world back to zero.
   *
   *  The log is append-only and forever — so a reset ARCHIVES, it never
   *  destroys. Everything the world was (log, snapshot, remembered poses)
   *  moves into worlds/<name>/erased-<ts>/, recoverable by hand, and the
   *  live world starts over from an empty state. Frames recordings stay
   *  where they are: they are performances, not world state.
   *
   *  Returns the archive directory. The caller decides who owns the fresh
   *  world and how to tell everyone standing in it. */
  reset(): string {
    const arch = this.log.reset();
    this.bhv.disposeAll();
    this.bhv.sync();
    this.log.append("world", "genesis", { v: 2, dialect: "eidoverse-log" });
    return arch;
  }
}

// -------------------------------------------------------------- the registry

export const worlds = new Map<string, World>();

// A function DECLARATION on purpose (§15.1): hoisting is load-bearing for
// module-scope callers — the unsplit boot sweep called it above its
// definition, and keeping the declaration form keeps that shape legal.
export function getWorld(name: string): World {
  if (!/^[a-z0-9_-]{1,64}$/i.test(name)) throw new Error(`bad world name: ${name}`);
  let w = worlds.get(name);
  if (!w) { w = new World(name); worlds.set(name, w); }
  return w;
}

/** Copy a world into a brand-new name. The log IS the world, so a fork is a
 *  byte-copy of the log plus its derived snapshot (whose byte offset stays
 *  valid because the copy is identical) and the remembered poses — a complete
 *  copy, roles and ownership included, since grants live in the log like every
 *  other fact. The whole copy is one synchronous block on a single-threaded
 *  event loop: no append can interleave, so log and snapshot cannot drift. */
export function forkWorld(src: World, to: string): { ok: true; world: World } | { ok: false; err: string } {
  if (!/^[a-z0-9_-]{1,64}$/i.test(to)) return { ok: false, err: `bad world name "${to}" — letters, digits, - and _ only` };
  if (to === src.name) return { ok: false, err: "a world cannot be copied onto itself" };
  const destDir = join(WORLDS_DIR, to);
  if (worlds.has(to) || existsSync(destDir)) return { ok: false, err: `world "${to}" already exists` };
  const srcDir = join(WORLDS_DIR, src.name);
  if (!existsSync(join(srcDir, "log.jsonl"))) return { ok: false, err: `"${src.name}" has no history to copy yet` };
  src.flushLog();   // the copy is a claim about the FILE — the batch lands first
  mkdirSync(destDir, { recursive: true });
  for (const f of ["log.jsonl", "snapshot.json", "poses.json"]) {
    const p = join(srcDir, f);
    if (existsSync(p)) copyFileSync(p, join(destDir, f));
  }
  return { ok: true, world: getWorld(to) };   // load it now: a fork that cannot boot should fail loudly here
}
