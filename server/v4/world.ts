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
// What clients see (slice 3c): every client folds v4 itself. A joiner adopts the door's cut (clientCut) and folds the
// raw entries it is sent as {type: "v4-log"}; a client that doesn't fold v4 is refused at join (server.ts). No v1
// verbs are made for a v4 world. `state` is the VIEW of the fold (shared/v4/record.js viewState) plus the chat window,
// for this server's own readers (rights, bans, leases, /geom, model warm-up); it is rebuilt by its next reader after
// a write. Chat lines (say entries) are numbered v4seq × 1000 in the window and in readHistory.
import { custodyAt } from "./custody.ts";
import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { WORLDS_DIR, TRUST_NAMES } from "../config.ts";
import { directoryFor, mintId, type Entry } from "./directory.ts";
import { agentTokens } from "../auth.ts";
import { atomicWrite } from "../fsutil.ts";
import { emptySim } from "../../shared/sim.js";
import type { LogEntry, WorldState } from "../../shared/fold.js";
import { request as doorRequest, seal, actIndexOf, roleIn, isBanned } from "../../shared/v4/door.js";
import { stateView } from "../../shared/v4/client.js";
import { viewState } from "../../shared/v4/record.js";
import { hear } from "../../shared/chatwindow.js";
import { dec } from "../../shared/v4/names.js";
import { openLive, isV4Dir } from "./live.ts";
import { ENGINE_CATALOGUE, warm, modelsIn } from "./catalogue.ts";

type Any = any;
const idOut = (s: string) => dec(s) ?? s;

/** Does this world's directory hold a v4 log? (Decided once, when the world is first opened.) */
export function isV4World(name: string): boolean { return isV4Dir(path.join(WORLDS_DIR, name)); }

/** What a V4Log needs from the World around it (injected: this file never imports world.ts). */
export type V4Host = {
  broadcast(msg: unknown): void;           // every client in the world
  rightsChanged(): void;                   // tell every client its rights again
  debug(kind: string, detail: Record<string, unknown>): void;
};

export class V4Log {
  name: string;
  readonly v4 = true;
  live: Any;
  /** The view of the fold + the chat window (the readers above). Rebuilt lazily by its next reader after a write. */
  private _state!: WorldState;
  get state(): WorldState { if (this.stale) this.freshen(); return this._state; }
  set state(v: WorldState) { this._state = v; }
  /** v1 entries never live here: a v4 world has no v1 tail (joinPayload sends none). */
  entries: LogEntry[] = [];
  sim = emptySim() as Any;           // the v1 sim: none (v4 physics lives in the fold, @world.sim)
  recentSays: LogEntry[] = [];
  poses: Record<string, unknown> = {};
  /** The chat lines, newest last (readHistory's source; the v4 log itself is the door's `history`). */
  private hist: LogEntry[] = [];
  private dir: string;
  private posesPath: string;
  private host: V4Host | null = null;
  /** counters, for /tick-style inspection and the tests */
  stats = { requests: 0, writes: 0 };
  /** every actor this log names (opaque ids): clients are sent their display names, from the directory (§2.3) */
  private actors = new Set<string>();
  private names(ids: Iterable<string>) { return directoryFor(WORLDS_DIR).names(ids); }

  constructor(name: string) {
    this.name = name;
    this.dir = path.join(WORLDS_DIR, name);
    this.posesPath = path.join(this.dir, "poses.json");
    this.live = openLive(this.dir, name, { catalogue: ENGINE_CATALOGUE });
    for (const e of this.live.entries) if (e && typeof e.actor === "string") this.actors.add(e.actor);
    const st = this.live.state();
    if (st.status !== "ok") console.warn(`[world:${name}] v4 log folds to '${st.status}': the door will refuse writes`);
    this._state = this.view();
    // chat: the last 40 says, through the window's own rule
    for (const e of this.live.entries.filter((e: Any) => e && e.kind === "say").slice(-40)) this.hearSay(e);
    if (fs.existsSync(this.posesPath)) { try { this.poses = JSON.parse(fs.readFileSync(this.posesPath, "utf8")); } catch { /* corrupt = fresh */ } }
    void warm(Object.values(st.entities ?? {}).map((e: Any) => e.c.model)); // standing models, measured for the door
  }
  attach(host: V4Host) { this.host = host; }

  private view(): WorldState {
    return viewState(this.live.state(), { recentChat: this._state?.recentChat ?? [], chatTotal: this._state?.chatTotal ?? 0 }) as WorldState;
  }
  /** One say entry: into the chat window and readHistory, as {seq: v4seq × 1000, verb: "say", …}. */
  private hearSay(e: Any) {
    const who = (x: string) => directoryFor(WORLDS_DIR).nameOf(x) ?? idOut(x);
    const line = { seq: e.seq * 1000, ts: e.ts, actor: who(String(e.actor)), verb: "say", args: { text: String(e.body?.text ?? ""), ...(e.body?.to ? { to: who(String(e.body.to)) } : {}) } } as LogEntry;
    hear(this._state, { actor: line.actor, text: (line.args as Any).text, ts: line.ts, seq: line.seq });
    this.record(line);
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

  /** Send what the door just wrote: the raw v4 entries, to every client (they all fold v4). Chat lines go into the
   *  window; the view goes stale for its next reader; a role change re-sends everyone's rights. */
  private stale = false;
  private afterWrite(from: number) {
    this.stats.writes++;
    const fresh = this.live.entries.slice(from);
    const newActors = [...new Set(fresh.map((e: Any) => e?.actor).filter((a: Any) => typeof a === "string" && !this.actors.has(a)))] as string[];
    newActors.forEach((a) => this.actors.add(a));
    this.host?.broadcast({ type: "v4-log", world: this.name, from, entries: fresh, ...(newActors.length ? { names: this.names(newActors) } : {}) });
    for (const e of fresh) if (e?.kind === "say") this.hearSay(e);
    this.stale = true;
    const roles = (e: Any) => { try { return e?.kind === "state" && opsOf(e).some((o: Any) => o.id === "@world" && String(o.comp ?? "").startsWith("roles:")); } catch { return false; } };
    if (fresh.some(roles)) this.host?.rightsChanged();
  }
  private record(e: LogEntry) {
    this.hist.push(e); if (this.hist.length > 512) this.hist.splice(0, this.hist.length - 512);
    if (e.verb === "say") { this.recentSays.push(e); if (this.recentSays.length > 256) this.recentSays.shift(); }
  }

  // ---- the WorldLog surface the World facade and server.ts read ----
  append(_actor: string, verb: string, _args: Record<string, unknown>): LogEntry {
    throw new Error(`v4 world "${this.name}": a v1 '${verb}' write has no path here (writes are v4 requests; server/v4/messages.ts)`);
  }
  fold(_reason?: string) { /* the v4 log is the record; the view is rebuilt from it on load */ }
  flushLog() { /* lines are appended synchronously by the door's writeLine */ }
  reset(): string { throw new Error(`v4 world "${this.name}": reset isn't supported in a v4 world yet`); }
  readHistory({ before = Infinity, after = -Infinity, limit = 50, verbs = null as Set<string> | null }) {
    const out = this.hist.filter((e) => e.seq < before && e.seq > after && (!verbs || verbs.has(e.verb))).slice(-limit);
    const oldest = out.length ? out[0].seq : null;
    return { entries: out, oldestSeq: oldest, hasMore: false };
  }
  /** Bring the view up to date (the chat window is kept), before anyone reads it again. */
  private freshen() {
    this.stale = false;
    this._state = this.view();
  }
  joinPayload() { if (this.stale) this.freshen(); return { state: this.state, tail: [] as LogEntry[], throughSeq: this.snapSeq }; }
  /** The role the DOOR gives this identity (the door is what admits writes; v1's own default for strangers is builder,
   *  the door's is visitor, so a client must be told the door's). */
  roleOf(actor: string): string { return roleIn(this.live.state(), actor, { anon: directoryFor(WORLDS_DIR).entry(actor)?.kind === "anon" }); }
  /** The door's moderator log says this identity is banned here (door.js isBanned): join must refuse it too. */
  bannedHere(actor: string): boolean { return isBanned(this.live, actor); }
  /** Slice 3b: what a client that folds v4 adopts at join: the fold itself (shared/v4/client.js stateView), its head,
   *  and the asker's own acts that undo could still take back (newest last), so Ctrl+Z survives a reload. */
  clientCut(actor: string) {
    const X = actIndexOf(this.live); const E = this.live.entries;
    const mine = (X.actsOf.get(actor) ?? []).filter((q: number) => !["undo", "new", "throw", "drop", "leave", "move", "grab"].includes(E[q].verb) && !X.undone.has(q) && X.resultOf.has(q)).slice(-40);
    return { state: stateView(this.live.state()), head: this.head, mine, you: actor, names: this.names([...this.actors, actor]) };
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
  // the owner is an account (human:…, agent:…, local:…); a bare name means `local:<name>`, the account a TRUST_NAMES
  // server gives that typed name. Its opaque id comes from the door directory (round-2 review R1).
  const acct = /^(human|agent|aid1|local):/.test(owner) ? owner : `local:${owner.toLowerCase()}`;
  const id = directoryFor(path.dirname(dir)).resolve({ sub: acct, name: acct.startsWith("local:") ? owner : acct.split(":").pop()!, agent: /^(agent|aid1):/.test(acct) });
  const r = doorRequest(w, id, "new", { title: title ?? name });
  if (!r.ok) throw new Error(`founding refused: ${JSON.stringify(r.refused)}`);
  return { worldId: w.worldId, owner: id, account: acct, entries: w.entries.length };
}

/** Translate a v1 world's log (srcDir/log.jsonl, never written: R9) into a NEW v4 world in destDir. */
export function translateV1World(srcDir: string, destDir: string) {
  const src = path.join(srcDir, "log.jsonl");
  if (!fs.existsSync(src)) throw new Error(`${src}: no v1 log`);
  if (fs.existsSync(path.join(destDir, "v4.jsonl")) || fs.existsSync(path.join(destDir, "log.jsonl"))) throw new Error(`${destDir} already holds a world`);
  const old = fs.readFileSync(src, "utf8").split("\n").filter((l) => l.trim()).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });
  // the sequencer key is this door's (the custody file every world in this worlds dir shares, server/v4/custody.ts)
  // identities (round-2 review R1): every v1 person becomes an opaque id in the door directory; an account seen in the
  // log (a role's sub, an agent's reserved name) keeps the id it already wears here. Planned in memory, written to the
  // directory only after the log is: a failed translation leaves no identities behind.
  const dir = directoryFor(path.dirname(destDir)); const planned: Record<string, Entry> = {}; const memo = new Map<string, string>();
  const agents = agentTokens().names;
  const isAcct = (k: string) => /^(human|agent|aid1):/.test(k);
  const who = (name: string, { sub }: { sub?: string } = {}) => {
    // no account in the log: an agent's reserved name is its account; on a TRUST_NAMES (private) server a bare name is
    // local:<name>, as a join there is; anywhere else it's a legacy identity an operator binds (directory.bind)
    const acct = sub ?? (isAcct(name) ? name : agents.has(name.toLowerCase()) ? `agent:token:${name.toLowerCase()}` : TRUST_NAMES ? `local:${name.toLowerCase()}` : undefined);
    const display = isAcct(name) ? null : name;   // a role keyed by its account has no name of its own
    const key = acct ?? `name:${name}`;
    let id = memo.get(key) ?? (acct ? dir.idOfSub(acct) : null) ?? null;   // the same person they are everywhere on this door
    if (!id) { id = mintId(); planned[id] = { name: display ?? "someone", subs: acct ? [acct] : [], kind: acct ? (/^(agent|aid1):/.test(acct) ? "agent" : "human") : "legacy", since: Date.now() }; }
    if (display && planned[id]?.name === "someone") planned[id].name = display;   // a later mention brings the name
    memo.set(key, id); if (display) memo.set(`name:${display}`, id); return id; };
  // every name that ever had an account in this log (a grant with a sub, genesis roles), first: a person's acts may come
  // before the grant that names their account, and must land on the same id. (v1 can't tell two people who shared a
  // name apart in their acts; the last account seen for a name wins, and translate reports how many.)
  for (const e of old) { const a = e?.args ?? {};
    if (e?.verb === "grant" && typeof a.id === "string" && typeof a.sub === "string") who(a.id, { sub: a.sub });
    if (e?.verb === "genesis") for (const [k, v] of Object.entries<Any>(a.roles ?? {})) if (k !== "*" && typeof v?.sub === "string") who(k, { sub: v.sub }); }
  const cust = custodyAt(path.join(path.dirname(destDir), ".v4-custody.json"));
  const r = translate(old, { foldBuild: v1FoldBuild(), key: cust.sequencer(), operator: cust.operator(), nonce: crypto.randomBytes(16).toString("base64url"), who });
  if (r.stats.divergences) throw new Error(`translation diverged ${r.stats.divergences}× (first ${JSON.stringify(r.stats.firstDivergence)}): nothing written`);
  // salted and signed like every line the door writes (§2.4; round-2 review R3): a translated world is a chained log
  const text = seal(r.out, { sign: (m: string) => cust.sign(m) }).map((e: Any) => JSON.stringify(e)).join("\n") + "\n";
  // the strict reader must accept every line, and fold to the translator's own final state, before the file exists
  const back = fold(readLog(text));
  const malformed = back.diagnostics.filter(([, c]: Any) => String(c).startsWith("malformed"));
  if (back.status !== "ok" || malformed.length) throw new Error(`the translated log doesn't read back clean (${back.status}, ${malformed.length} malformed: ${JSON.stringify(malformed.slice(0, 3))}): nothing written`);
  fs.mkdirSync(destDir, { recursive: true });
  const tmp = path.join(destDir, "v4.jsonl.tmp");
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, path.join(destDir, "v4.jsonl"));
  dir.put(planned);
  return { identities: Object.keys(planned).length, stats: r.stats, entries: r.out.length, worldId: back.worldId, digest: digest(back) };
}

// ---------- fork and reset (v1 parity, done the v4 way) ----------
const WORLD_NAME = /^[a-z0-9_-]{1,64}$/i;
const headOf = (live: Any) => live.headAt(live.entries.length - 1);
/** A thing's parents before it: a batch creates children after what they hang from. */
function parentsFirst(st: Any): string[] {
  const out: string[] = [], seen = new Set<string>();
  const visit = (id: string, depth = 0) => { if (seen.has(id) || depth > 64) return; seen.add(id);
    const p = st.entities[id]?.c.parent?.to; if (typeof p === "string" && st.entities[p]) visit(p, depth + 1); out.push(id); };
  for (const id of Object.keys(st.entities)) if (id !== "@world") visit(id);
  return out;
}
/** Every component of the source as ordinary door requests (the same gate as a hand edit), in batches under the
 *  1 MiB line cap. Locks and pins are written last, after everything they'd protect exists. */
function copyInto(w: Any, actor: string, st: Any, skipWorld: (k: string) => boolean) {
  const reqs: Any[] = [], late: Any[] = [];
  for (const [k, v] of Object.entries<Any>(st.entities["@world"]?.c ?? {})) if (!skipWorld(k)) reqs.push({ tool: "set", args: { id: "@world", component: k, value: v } });
  for (const id of parentsFirst(st)) {
    const { model, lock, ...comps } = st.entities[id].c;
    reqs.push({ tool: "create", args: { id, ...(model !== undefined ? { model } : {}), components: comps } });
    if (lock !== undefined) late.push({ tool: "set", args: { id, component: "lock", value: lock } });
  }
  const all = [...reqs, ...late]; let batch: Any[] = [], size = 0, acts = 0;
  const flush = () => { if (!batch.length) return; const r = doorRequest(w, actor, "batch", { ops: batch, through_lock: true });
    if (!r.ok) throw new Error(`the copy was refused at ${JSON.stringify(batch[r.refused?.op ?? 0]?.args?.id ?? "?")}: ${r.refused?.code} ${r.refused?.reason}`); acts++; batch = []; size = 0; };
  for (const q of all) { const n = JSON.stringify(q).length; if (size + n > 400_000) flush(); batch.push(q); size += n; }
  flush();
  return acts;
}
const canonOf = (st: Any, skipWorld: (k: string) => boolean) => JSON.stringify(Object.keys(st.entities).sort().map((id) => [id,
  Object.keys(st.entities[id].c).filter((k) => id !== "@world" || !skipWorld(k)).sort().map((k) => [k, st.entities[id].c[k]])]));

/** Fork: a NEW world (its own genesis, so its own identity) whose founding act names where it came from
 *  ({world, name, head}), holding a copy of the source's current state. Built in a hidden directory and renamed into
 *  place only once its state equals the source's, so a failed fork leaves nothing. Chat history isn't copied: the
 *  source's log stays the record, and the fork links to it (v1 copied the whole log file, every chat line included). */
export function forkV4(src: V4Log, to: string, forker: string): { ok: true; worldId: string; things: number; acts: number } | { ok: false; err: string } {
  if (!WORLD_NAME.test(to)) return { ok: false, err: `bad world name "${to}" — letters, digits, - and _ only` };
  if (to === src.name) return { ok: false, err: "a world can't be copied onto itself" };
  const dest = path.join(WORLDS_DIR, to);
  if (fs.existsSync(dest)) return { ok: false, err: `world "${to}" already exists` };
  const tmp = path.join(WORLDS_DIR, `.forking-${to}-${crypto.randomBytes(4).toString("hex")}`);
  try {
    const st = src.live.state();
    fs.mkdirSync(tmp, { recursive: true });
    const blobs = path.join(WORLDS_DIR, src.name, "v4-blobs");   // content-addressed (blueprints, script sources): all of them travel
    if (fs.existsSync(blobs)) fs.cpSync(blobs, path.join(tmp, "v4-blobs"), { recursive: true });
    const w = openLive(tmp, to, { catalogue: ENGINE_CATALOGUE });
    const title = st.entities["@world"]?.c.about?.name ?? to;
    const r0 = doorRequest(w, forker, "new", { title, from: { world: src.live.worldId, name: src.name, head: headOf(src.live) } });
    if (!r0.ok) throw new Error(`founding refused: ${r0.refused?.reason}`);
    const skip = (k: string) => k === "about" || k === `roles:${forker}`;   // the founding act wrote these
    const acts = copyInto(w, forker, st, skip);
    const back = w.state();
    if (canonOf(back, skip) !== canonOf(st, skip)) throw new Error("the copy doesn't match the source (nothing was kept)");
    fs.renameSync(tmp, dest);
    return { ok: true, worldId: w.worldId, things: Object.keys(st.entities).length - 1, acts };
  } catch (e: Any) {
    fs.rmSync(tmp, { recursive: true, force: true });
    return { ok: false, err: String(e?.message ?? e) };
  }
}
/** Reset: the world's log and remembered poses move into reset-<time>/ beside it (archived, never deleted; blobs
 *  stay: they're content), and a fresh genesis is founded by the same owners, its founding act naming the world it
 *  replaced. Returns the archive directory. The caller swaps in a fresh V4Log and tells everyone present. */
export function resetV4(log: V4Log): string {
  const st = log.live.state();
  const owners = Object.entries<Any>(st.entities["@world"]?.c ?? {}).filter(([k, v]) => k.startsWith("roles:") && v?.role === "owner").map(([k]) => k.slice(6));
  if (!owners.length) throw new Error("this world has no owner to found it again");
  const prev = { world: log.live.worldId, name: log.name, head: headOf(log.live) };
  const dir = path.join(WORLDS_DIR, log.name);
  // found the fresh world ASIDE first: a refused founding changes nothing; only then do the files trade places
  const fresh = path.join(WORLDS_DIR, `.refound-${log.name}-${crypto.randomBytes(4).toString("hex")}`);
  try {
    fs.mkdirSync(fresh, { recursive: true });
    const w = openLive(fresh, log.name, { catalogue: ENGINE_CATALOGUE });
    const r0 = doorRequest(w, owners[0], "new", { title: st.entities["@world"]?.c.about?.name ?? log.name, from: prev });
    if (!r0.ok) throw new Error(`founding again refused: ${r0.refused?.reason}`);
    for (const o of owners.slice(1)) { const r = doorRequest(w, owners[0], "set", { id: "@world", component: `roles:${o}`, value: { role: "owner" } });
      if (!r.ok) throw new Error(`restoring owner ${o} refused: ${r.refused?.reason}`); }
  } catch (e) { fs.rmSync(fresh, { recursive: true, force: true }); throw e; }
  const arch = path.join(dir, `reset-${new Date().toISOString().replace(/[:.]/g, "-")}`);
  fs.mkdirSync(arch, { recursive: true });
  for (const f of ["v4.jsonl", "poses.json"]) if (fs.existsSync(path.join(dir, f))) fs.renameSync(path.join(dir, f), path.join(arch, f));
  fs.renameSync(path.join(fresh, "v4.jsonl"), path.join(dir, "v4.jsonl"));
  fs.rmSync(fresh, { recursive: true, force: true });
  return arch;
}
