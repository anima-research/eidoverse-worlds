// server/v4/world.ts — a v4 world inside today's server (slice 2).
//
// world.ts's World facade holds a log object; for a world whose directory holds a v4 log (line 0 a v4 genesis,
// isV4Dir) that object is a V4Log instead of a WorldLog. Old (v1) worlds never reach this file: World's constructor
// asks isV4World(name) and builds the WorldLog exactly as before.
//
// Writes: every write is a v4 REQUEST through the door (shared/v4/door.js: one `admit`, act + state entries, the ts
// from this server's clock). request() is the only way in. The v1 write path (append) refuses loudly: a v1 verb
// reaching a v4 world is a routing bug (server/v4/messages.ts maps the old UI's verbs to requests), and writing it
// would put a v1 entry into a v4 log, or show clients a change the log never got.
//
// What clients see: today's client folds v1, so a V4Log serves the COMPATIBILITY PROJECTION (shared/v4/legacy.js):
// `state` is the v4 fold read as a v1 state, and after each request the v1 verbs that move a client from the old
// projection to the new one are published as ordinary `log` entries (the bus: client fanout, behaviors). Before they
// go out, the server folds them with the client's own fold and compares with a fresh projection; if they don't
// reproduce it (a change with no v1 spelling), no verbs go out and every client gets a fresh snapshot (a resync,
// the reconnect path). The raw v4 entries also go out, as {type: "v4-log"}, for clients that read v4 (slice 3).
//
// Projected entries are numbered seq = v4seq × 1000 + k (k-th verb that v4 entry projected to), so they're
// increasing, survive restarts, and name the v4 entry they came from. A snapshot covers through v4seq × 1000 + 999.
import fs from "node:fs";
import path from "node:path";
import { WORLDS_DIR } from "../config.ts";
import { atomicWrite } from "../fsutil.ts";
import { emptySim } from "../../shared/sim.js";
import type { LogEntry, WorldState } from "../../shared/fold.js";
import { request as doorRequest, actIndexOf } from "../../shared/v4/door.js";
import { stateView } from "../../shared/v4/client.js";
import { legacyState, legacyDelta, foldLegacy, legacyDiff } from "../../shared/v4/legacy.js";
import { dec } from "../../shared/v4/names.js";
import { openLive, isV4Dir } from "./live.ts";
import { ENGINE_CATALOGUE, warm, modelsIn } from "./catalogue.ts";

type Any = any;
const idOut = (s: string) => dec(s) ?? s;

/** Does this world's directory hold a v4 log? (Decided once, when the world is first opened.) */
export function isV4World(name: string): boolean { return isV4Dir(path.join(WORLDS_DIR, name)); }

/** What a V4Log needs from the World around it (injected: this file never imports world.ts). */
export type V4Host = {
  publish(entry: LogEntry): void;          // the entry bus (World.commit's publish half)
  broadcast(msg: unknown): void;           // every client in the world
  resync(): void;                          // a fresh snapshot to every client (server.ts's buildSnapshot)
  rightsChanged(): void;                   // tell every client its rights again
  debug(kind: string, detail: Record<string, unknown>): void;
  /** Does any client in the world still read the compatibility projection? (A client that folds v4 itself, slice 3b,
   *  doesn't: it derives its own from the v4-log stream.) Absent = yes. */
  projectionWanted?(): boolean;
};

export class V4Log {
  name: string;
  readonly v4 = true;
  live: Any;
  /** The projection every client holds (it is what they fold). Checked against the v4 fold after every request. */
  state: WorldState;
  /** v1 entries never live here: a v4 world has no v1 tail (joinPayload sends none). */
  entries: LogEntry[] = [];
  sim = emptySim() as Any;           // the v1 sim: none (v4 physics isn't projected to old clients)
  recentSays: LogEntry[] = [];
  poses: Record<string, unknown> = {};
  /** The projected entries, newest last (readHistory's source; the v4 log itself is the door's `history`). */
  private hist: LogEntry[] = [];
  private dir: string;
  private posesPath: string;
  private host: V4Host | null = null;
  /** counters, for /tick-style inspection and the tests */
  stats = { requests: 0, writes: 0, projected: 0, resyncs: 0, skipped: 0 };

  constructor(name: string) {
    this.name = name;
    this.dir = path.join(WORLDS_DIR, name);
    this.posesPath = path.join(this.dir, "poses.json");
    this.live = openLive(this.dir, name, { catalogue: ENGINE_CATALOGUE });
    const st = this.live.state();
    if (st.status !== "ok") console.warn(`[world:${name}] v4 log folds to '${st.status}': the door will refuse writes`);
    this.state = this.project();
    // chat: the last 40 says as the v1 window (the fold's own trim rule)
    const says = this.live.entries.filter((e: Any) => e && e.kind === "say").slice(-40);
    this.state = foldLegacy(this.state, says.map((e: Any) => ({ seq: e.seq * 1000, ts: e.ts, actor: idOut(e.actor), verb: "say", args: { text: String(e.body?.text ?? "") } })));
    if (fs.existsSync(this.posesPath)) { try { this.poses = JSON.parse(fs.readFileSync(this.posesPath, "utf8")); } catch { /* corrupt = fresh */ } }
    void warm(Object.values(st.entities ?? {}).map((e: Any) => e.c.model)); // standing models, measured for the door
  }
  attach(host: V4Host) { this.host = host; }

  private project(): WorldState {
    return legacyState(this.live.state(), { recentChat: this.state?.recentChat ?? [], chatTotal: this.state?.chatTotal ?? 0 }) as WorldState;
  }
  /** The last v4 seq. */
  get head(): number { return this.live.entries.length - 1; }
  get snapSeq(): number { return this.head * 1000 + 999; }

  /** One v4 request, as `actor` (an identity the caller has already encoded). Warms any model it names first, so
   *  the door can measure it; the door call itself is synchronous. */
  async request(actor: string, tool: string, args: Record<string, unknown> = {}) {
    await warm(modelsIn(args));
    return this.requestSync(actor, tool, args);
  }
  requestSync(actor: string, tool: string, args: Record<string, unknown> = {}) {
    this.stats.requests++;
    const from = this.live.entries.length;
    const r = doorRequest(this.live, actor, tool, args);
    if (this.live.entries.length > from) this.afterWrite(from);
    return r;
  }

  /** Publish what the door just wrote: the raw v4 entries, then the projection's v1 verbs (checked), or a resync.
   *  Slice 3b: when every client in the world folds v4 itself, no projection is computed at all; the next client
   *  that needs one gets a fresh one at join (joinPayload). */
  private stale = false;
  private afterWrite(from: number) {
    this.stats.writes++;
    const fresh = this.live.entries.slice(from);
    this.host?.broadcast({ type: "v4-log", world: this.name, from, entries: fresh });
    if (this.host?.projectionWanted && !this.host.projectionWanted()) {
      // the chat window stays current (a later joiner that reads the projection gets it); entities wait for freshen()
      const says = fresh.filter((e: Any) => e?.kind === "say").map((e: Any) => ({ seq: e.seq * 1000, ts: e.ts, actor: idOut(e.actor), verb: "say", args: { text: String(e.body?.text ?? ""), ...(e.body?.to ? { to: idOut(String(e.body.to)) } : {}) } } as LogEntry));
      if (says.length) { this.state = foldLegacy(this.state, says); for (const e of says) this.record(e); }
      this.stale = true; this.stats.skipped++;
      const roles = (e: Any) => { try { return e?.kind === "state" && opsOf(e).some((o: Any) => o.id === "@world" && String(o.comp ?? "").startsWith("roles:")); } catch { return false; } };
      if (fresh.some(roles)) this.host?.rightsChanged();
      return;
    }
    if (this.stale) this.freshen();
    const last = fresh[fresh.length - 1];
    const ts = Number.isInteger(last?.ts) ? last.ts : Date.now();
    const actorOf = idOut(String(fresh.find((e: Any) => e?.kind === "act" || e?.kind === "say")?.actor ?? last?.actor ?? "world"));
    // the verbs, numbered by the v4 entry they came from
    const out: LogEntry[] = [];
    for (const e of fresh) if (e?.kind === "say") out.push({ seq: e.seq * 1000, ts: e.ts, actor: idOut(e.actor), verb: "say", args: { text: String(e.body?.text ?? ""), ...(e.body?.to ? { to: idOut(String(e.body.to)) } : {}) } } as LogEntry);
    const next = this.project();
    const delta = legacyDelta(this.state, next);
    let k = 1;
    const ok = delta !== null && delta.length < 999;
    if (ok) for (const v of delta!) out.push({ seq: last.seq * 1000 + k++, ts, actor: actorOf, verb: v.verb, args: v.args } as LogEntry);
    const held = foldLegacy(this.state, out);
    const diff = ok ? legacyDiff(held, next) : { reason: delta === null ? "no v1 spelling" : "too many verbs" };
    const rolesMoved = JSON.stringify(this.state.roles ?? {}) !== JSON.stringify(next.roles ?? {});
    if (!diff) {
      this.state = held;
      for (const e of out) this.record(e);
      for (const e of out) this.host?.publish(e);
      this.stats.projected += out.length;
    } else {
      // no faithful verbs: the clients get the projection itself (chat carried from what they held)
      this.state = { ...next, recentChat: held.recentChat, chatTotal: held.chatTotal } as WorldState;
      for (const e of out) if (e.verb === "say") this.record(e);
      this.stats.resyncs++;
      this.host?.debug("v4-resync", { from, to: this.head, why: diff });
      this.host?.resync();
    }
    if (rolesMoved) this.host?.rightsChanged();
  }
  private record(e: LogEntry) {
    this.hist.push(e); if (this.hist.length > 512) this.hist.splice(0, this.hist.length - 512);
    if (e.verb === "say") { this.recentSays.push(e); if (this.recentSays.length > 256) this.recentSays.shift(); }
  }

  // ---- the WorldLog surface the World facade and server.ts read ----
  append(_actor: string, verb: string, _args: Record<string, unknown>): LogEntry {
    throw new Error(`v4 world "${this.name}": a v1 '${verb}' write has no path here (writes are v4 requests; server/v4/messages.ts)`);
  }
  fold(_reason?: string) { /* the v4 log is the record; the projection is rebuilt from it on load */ }
  flushLog() { /* lines are appended synchronously by the door's writeLine */ }
  reset(): string { throw new Error(`v4 world "${this.name}": reset isn't supported in a v4 world yet`); }
  readHistory({ before = Infinity, after = -Infinity, limit = 50, verbs = null as Set<string> | null }) {
    const out = this.hist.filter((e) => e.seq < before && e.seq > after && (!verbs || verbs.has(e.verb))).slice(-limit);
    const oldest = out.length ? out[0].seq : null;
    return { entries: out, oldestSeq: oldest, hasMore: false };
  }
  /** Bring a skipped projection up to date (chat from the recorded says), before anyone reads it again. */
  private freshen() {
    this.state = { ...this.project(), recentChat: this.state.recentChat, chatTotal: this.state.chatTotal } as WorldState;
    this.stale = false;
  }
  joinPayload() { if (this.stale) this.freshen(); return { state: this.state, tail: [] as LogEntry[], throughSeq: this.snapSeq }; }
  /** Slice 3b: what a client that folds v4 adopts at join: the fold itself (shared/v4/client.js stateView), its head,
   *  and the asker's own acts that undo could still take back (newest last), so Ctrl+Z survives a reload. */
  clientCut(actor: string) {
    const X = actIndexOf(this.live); const E = this.live.entries;
    const mine = (X.actsOf.get(actor) ?? []).filter((q: number) => !["undo", "new", "throw", "drop", "leave", "move", "grab"].includes(E[q].verb) && !X.undone.has(q) && X.resultOf.has(q)).slice(-40);
    return { state: stateView(this.live.state()), head: this.head, mine };
  }
  rememberPose(id: string, pose: unknown, settle: (p: unknown) => unknown) {
    if (!pose) return;
    this.poses[id] = settle(pose);
    try { fs.mkdirSync(this.dir, { recursive: true }); atomicWrite(this.posesPath, JSON.stringify(this.poses)); } catch (err) { console.error(`[world:${this.name}] poses`, err); }
  }
  /** What the snapshot says about this world's protocol (agents read it to route their tools). */
  info() { return { version: 4, head: this.head, worldId: this.live.worldId, tools: "send {type: 'v4', id, tool, args}; reply {type: 'v4-result', id, …}" }; }
}

// ---- founding and translating (tools/v4/world.ts is the command line) ----
import { translate } from "../../shared/v4/translate-v1.js";
import { v1FoldBuild } from "./build.ts";
import { enc } from "../../shared/v4/names.js";
import { readLog, fold, digest, opsOf } from "../../shared/v4/fold.js";

/** Found a new v4 world in `dir` (which must not hold a world): genesis + the founding act, through the door. */
export function foundV4(dir: string, name: string, owner: string, title?: string, now?: () => number) {
  if (fs.existsSync(path.join(dir, "v4.jsonl")) || fs.existsSync(path.join(dir, "log.jsonl"))) throw new Error(`${dir} already holds a world`);
  fs.mkdirSync(dir, { recursive: true });
  const w = openLive(dir, name, { now });
  const r = doorRequest(w, enc(owner), "new", { title: title ?? name });
  if (!r.ok) throw new Error(`founding refused: ${JSON.stringify(r.refused)}`);
  return { worldId: w.worldId, owner: enc(owner), entries: w.entries.length };
}

/** Translate a v1 world's log (srcDir/log.jsonl, never written: R9) into a NEW v4 world in destDir. */
export function translateV1World(srcDir: string, destDir: string) {
  const src = path.join(srcDir, "log.jsonl");
  if (!fs.existsSync(src)) throw new Error(`${src}: no v1 log`);
  if (fs.existsSync(path.join(destDir, "v4.jsonl")) || fs.existsSync(path.join(destDir, "log.jsonl"))) throw new Error(`${destDir} already holds a world`);
  const old = fs.readFileSync(src, "utf8").split("\n").filter((l) => l.trim()).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });
  const r = translate(old, { foldBuild: v1FoldBuild() });
  if (r.stats.divergences) throw new Error(`translation diverged ${r.stats.divergences}× (first ${JSON.stringify(r.stats.firstDivergence)}): nothing written`);
  const text = r.out.map((e: Any) => JSON.stringify(e)).join("\n") + "\n";
  // the strict reader must accept every line, and fold to the translator's own final state, before the file exists
  const back = fold(readLog(text));
  const malformed = back.diagnostics.filter(([, c]: Any) => String(c).startsWith("malformed"));
  if (back.status !== "ok" || malformed.length) throw new Error(`the translated log doesn't read back clean (${back.status}, ${malformed.length} malformed: ${JSON.stringify(malformed.slice(0, 3))}): nothing written`);
  fs.mkdirSync(destDir, { recursive: true });
  const tmp = path.join(destDir, "v4.jsonl.tmp");
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, path.join(destDir, "v4.jsonl"));
  return { stats: r.stats, entries: r.out.length, worldId: back.worldId, digest: digest(back) };
}
