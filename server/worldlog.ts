// server/worldlog.ts — a world's log as this server holds it: the authority over the world's directory.
//
// Every world this server serves speaks the current protocol (its directory holds world.jsonl, line 0 a genesis saying
// {dialect, v: 4}: isWorldDir); World
// (server/world.ts) holds one WorldLog. Writes: every write is a REQUEST through the authority (shared/protocol/authority.js: one
// `admit`, act + change entries, the ts from this server's clock); request() is the only way in.
//
// What clients see: every client folds the log itself. A joiner adopts the authority's cut (clientCut) and folds the raw entries
// it is sent as {type: "log"}. `state` is the VIEW of the fold (shared/protocol/view.js viewState) plus the chat window,
// for this server's own readers (/geom, model warm-up, the chat window); it is rebuilt by its next reader after a
// write. Chat lines (say entries) are numbered seq × 1000 in the window and in readHistory.
import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { WORLDS_DIR } from "./config.ts";
import { directoryFor } from "./directory.ts";
import { atomicWrite } from "./fsutil.ts";
import { forkCopy, request as authorityRequest, actIndexOf, roleIn, isBanned, kickOf, muteOf, ghostOf, sanctionsNow, effectiveIn, seniorOwnerOf, tick as authorityTick, settle as authoritySettle, presenceEvent, scriptsView, settleOrphans, liftWorld } from "../shared/protocol/authority.js";
import { authorityTime } from "./readmeter.ts";
import { clientCutOf, spokenOf } from "../shared/protocol/replica.js";
import { viewState } from "../shared/protocol/view.js";
import { holdWire } from "../shared/grab.js";
import { hear } from "../shared/chatwindow.js";
import { dec } from "../shared/protocol/names.js";
import { openLive, isWorldDir, isPreNamesDir } from "./livehost.ts";
import { ENGINE_CATALOGUE, warm, modelsIn } from "./modelcatalogue.ts";

type Any = any;
/** One chat line as this server's readers hold it (the chat window, history pages, the attest lookup): a say entry
 *  numbered seq × 1000, its actor a display name. */
export type ChatLine = { seq: number; ts: number; actor: string; verb: "say"; args: { text: string; to?: string; spoken?: boolean; utt?: number; t0?: number } };
/** The view of the fold (shared/protocol/view.js viewState) plus the chat window. */
export type WorldView = { entities: Record<string, Any>; terrain: Any; grass: Any; sky: Any; assets: Any[]; recentChat: Any[]; chatTotal: number; roles: Record<string, Any>; bans: Record<string, Any> };
const idOut = (s: string) => dec(s) ?? s;

/** An entry as clients are sent it: without the chain fields (world, head, sig) and an act/say body's salt. Clients
 *  adopt a cut at join and fold ops; nothing reads those fields, and on a two-character say they were 380 of its 488
 *  bytes (Commons audit #8). The log on disk keeps them, and the authority's history serves them whole. */
export function wireEntry(e: Any) {
  if (!e || typeof e !== "object") return e;
  const { world: _w, head: _h, sig: _s, ...rest } = e;
  if ((rest.kind === "say" || rest.kind === "act") && rest.body && typeof rest.body === "object" && !Array.isArray(rest.body) && "salt" in rest.body) { const { salt: _t, ...b } = rest.body; rest.body = b; }
  return rest;
}
/** Does this world's directory hold a log? (Decided once, when the world is first opened.) */
export function isWorldSaved(name: string): boolean { return isWorldDir(path.join(WORLDS_DIR, name)); }
/** Does it hold a log saved before the 2026-10-07 names pass (livehost isPreNamesDir)? */
export function isPreNamesSaved(name: string): boolean { return isPreNamesDir(path.join(WORLDS_DIR, name)); }

/** What a WorldLog needs from the World around it (injected: this file never imports world.ts). */
export type LogHost = {
  broadcast(msg: unknown): void;           // every client in the world
  rightsChanged(): void;                   // tell every client its rights again
  debug(kind: string, detail: Record<string, unknown>): void;
  /** who is here (embodied, not spectating): their identity and last known position. Scripts' timers sleep when this
   *  is empty, and world.near(r) reads it (research 41 §3.5, §3.8) */
  present?(): { id: string; at: number[] | null }[];
  /** the log stream: `msg` to everyone, `ghostMsg` (says emptied) to a ghost (PLAN 10-06: a ghost can't read chat) */
  broadcastLog?(msg: unknown, ghostMsg: unknown): void;
  /** send to one identity's embodied leg(s); false when they aren't here */
  toActor?(actor: string, msg: unknown): boolean;
};

export class WorldLog {
  name: string;
  live: Any;
  /** The view of the fold + the chat window (the readers above). Rebuilt lazily by its next reader after a write. */
  private _state!: WorldView;
  get state(): WorldView { if (this.stale) this.freshen(); return this._state; }
  /** the last 256 says (the attest handler's lookup: a voice leg's receipt names one by seq) */
  recentSays: ChatLine[] = [];
  poses: Record<string, unknown> = {};
  /** The chat lines, newest last (readHistory's source; the log itself is the authority's `history`). */
  private hist: ChatLine[] = [];
  private dir: string;
  private posesPath: string;
  private host: LogHost | null = null;
  /** counters, for /tick-style inspection and the tests */
  stats = { requests: 0, writes: 0 };
  /** Set by World.resetWorld before the fresh log takes this one's place: a request that was awaiting warm() must not
   *  append the old world's line into the new world's file (review 10-14 C1). */
  retired = false;
  retire() { this.retired = true; }
  private static RESET = { ok: false, refused: { code: "reset", reason: "this world was reset while the request waited; it is a new world now", fix: "reload, then send it again" } };
  /** every actor this log names (opaque ids): clients are sent their display names, from the directory (§2.3) */
  private actors = new Set<string>();
  private names(ids: Iterable<string>) { return directoryFor(WORLDS_DIR).names(ids); }

  constructor(name: string) {
    this.name = name;
    this.dir = path.join(WORLDS_DIR, name);
    this.posesPath = path.join(this.dir, "poses.json");
    this.live = openLive(this.dir, name, { catalogue: ENGINE_CATALOGUE, present: () => this.host?.present?.() ?? [] });
    for (const e of this.live.entries) if (e && typeof e.actor === "string") this.actors.add(e.actor);
    // a world opened after a crash: what was held when the host stopped is settled now (nobody is connected yet), and
    // logged, so a joiner's cut already has it back in the world (authority.js settleOrphans)
    try { const settled = settleOrphans(this.live, []); if (settled.length) console.log(`[world:${name}] settled ${settled.length} hold(s) left from before the restart: ${JSON.stringify(settled).slice(0, 300)}`); }
    catch (err) { console.error(`[world:${name}] settling orphaned holds`, err); }
    // a world stored before sockets were entities is lifted at its first load, and logged (authority.js liftWorld)
    // A host whose lift fails is left as it was (no seats until a later load lifts it) and said, per host: to the console
    // and, once the world is attached, to the flight recorder (world_debug, /debug). A world this server can't sign for
    // isn't lifted here at all, so it stays in the old spelling, with no seats, on this server: said too (review 10-12).
    try { const lifted = liftWorld(this.live) as Any[];
      const done = lifted.filter((x) => x.made), failed = lifted.filter((x) => x.failed), skipped = lifted.filter((x) => x.skipped);
      if (done.length) console.log(`[world:${name}] lifted ${done.length} socket host(s) to socket children: ${JSON.stringify(done).slice(0, 300)}`);
      for (const f of failed) console.error(`[world:${name}] lifting ${f.host}'s sockets failed (${f.failed.code}): ${f.failed.reason}; it keeps the old spelling, with no seats, until a load lifts it`);
      for (const k of skipped) console.warn(`[world:${name}] not lifting its sockets (${k.skipped}): ${k.why}; seats stored in the old spelling don't work on this server`);
      this.liftNotes = [...failed.map((f) => ({ host: f.host, ...f.failed })), ...skipped.map((k) => ({ skipped: k.skipped, why: k.why }))]; }
    catch (err) { console.error(`[world:${name}] lifting sockets`, err); }
    const st = this.live.state();
    if (st.status !== "ok") console.warn(`[world:${name}] log folds to '${st.status}': the authority will refuse writes`);
    this._state = this.view();
    // chat: the last 40 says, through the window's own rule; chatTotal counts every line ever said here
    const says = this.live.entries.filter((e: Any) => e && e.kind === "say");
    if (this._state) this._state.chatTotal = Math.max(0, says.length - 40);
    for (const e of says.slice(-40)) this.hearSay(e);
    if (fs.existsSync(this.posesPath)) { try { this.poses = JSON.parse(fs.readFileSync(this.posesPath, "utf8")); } catch { /* corrupt = fresh */ } }
    void warm(Object.values(st.entities ?? {}).map((e: Any) => e.c.model)); // standing models, measured for the authority
  }
  /** what the load's socket lift couldn't do (per host), said to the flight recorder when a world attaches */
  private liftNotes: Record<string, unknown>[] = [];
  attach(host: LogHost) { this.host = host; for (const n of this.liftNotes) host.debug("lift-sockets", n); }

  private view(): WorldView {
    return viewState(this.live.state(), { recentChat: this._state?.recentChat ?? [], chatTotal: this._state?.chatTotal ?? 0 }) as WorldView;
  }
  /** One say entry: into the chat window and readHistory, as {seq: seq × 1000, verb: "say", …}. */
  private sayLine(e: Any): ChatLine {
    const who = (x: string) => directoryFor(WORLDS_DIR).nameOf(x) ?? idOut(x);
    return { seq: e.seq * 1000, ts: e.ts, actor: who(String(e.actor)), verb: "say", args: { text: String(e.body?.text ?? ""), ...(e.body?.to ? { to: who(String(e.body.to)) } : {}), ...spokenOf(e.body) } } as ChatLine;
  }
  private hearSay(e: Any) {
    const line = this.sayLine(e);
    hear(this._state, { actor: line.actor, text: (line.args as Any).text, ts: line.ts, seq: line.seq });
    this.record(line);
  }
  /** The last seq. */
  get head(): number { return this.live.entries.length - 1; }
  /** The last chat number this world could have issued (seq × 1000 + 999): legs opened after it number above it. */
  get snapSeq(): number { return this.head * 1000 + 999; }

  /** One request, as `actor` (an identity the caller has already encoded). Warms any model it names first, so
   *  the authority can measure it; the authority call itself is synchronous. */
  async request(actor: string, verb: string, args: Record<string, unknown> = {}) {
    await warm(modelsIn(args));
    return this.requestSync(actor, verb, args);
  }
  requestSync(actor: string, verb: string, args: Record<string, unknown> = {}) {
    if (this.retired) return WorldLog.RESET;
    this.stats.requests++;
    const from = this.live.entries.length; const held = this.holdsKey();
    const t0 = performance.now(); const r = authorityRequest(this.live, actor, verb, args); if (r && typeof r === "object") authorityTime.set(r, performance.now() - t0);
    if (this.live.entries.length > from) this.afterWrite(from);
    if (this.holdsKey() !== held) this.host?.broadcast({ type: "holds", world: this.name, holds: this.holds() });
    this.forwardInbox();
    return r;
  }
  /** The authority's body inbox (asks, replies, acts, revocations: PROTOCOL L6) reaches its person: what's new since we
   *  last sent is pushed to their socket as {type: "body-inbox", messages} (tools audit 10-07: it was written and never
   *  delivered). The inbox itself is left as the authority keeps it, so `inbox` still answers an agent that polls. */
  /** per person: the `n` of the last message forwarded (authority.js inboxPush numbers each one, and the count outlives the
   *  200 cap and an `inbox` drain), so a queue that is full, or was emptied, still forwards what is new (holes review
   *  10-15 H1: forwarding by the array's length stuck at 200 forever) */
  private inboxSent = new Map<string, number>();
  private forwardInbox() {
    const box = this.live.presence?.inbox as Record<string, { n?: number }[]> | undefined; if (!box || !this.host?.toActor) return;
    for (const [who, msgs] of Object.entries(box)) {
      const sent = this.inboxSent.get(who) ?? 0; const fresh = msgs.filter((m) => (m?.n ?? 0) > sent); if (!fresh.length) continue;
      if (this.host.toActor(who, { type: "body-inbox", world: this.name, messages: fresh })) this.inboxSent.set(who, fresh[fresh.length - 1].n ?? sent);
    }
    for (const who of this.inboxSent.keys()) if (!box[who]) this.inboxSent.delete(who);   // drained by `inbox`: what comes next is all new
  }
  /** Who holds what (the authority's presence plane, design 20 P2): {id: {by}}. Never logged; every client draws a held thing
   *  in its holder's hand, so it is sent whenever it changes, and in every join cut. */
  holds(): Record<string, { by: string }> {
    const out: Record<string, { by: string }> = {};
    // the hold record (shared/grab.js holdWire): by, hand, grip or offset, second: every client draws it from these
    for (const [id, h] of Object.entries(this.live.presence.holds ?? {}) as [string, Any][]) out[id] = holdWire(h) as { by: string };
    return out;
  }
  private holdsKey() { return JSON.stringify(this.holds()); }
  /** A person's last connection left (not a takeover): what they held is dropped into the world (orphans, 18a), and the
   *  authority forgets their body. Their tracked body, if any, is all `leave` needs. */
  departed(actor: string) {
    if (!this.live.presence.bodies?.[actor]) return;
    try { this.requestSync(actor, "leave", {}); } catch (err) { console.error(`[world:${this.name}] leave for ${actor}`, err); }
  }

  /** Scripts (research 41): the authority's timers on this server's clock (server.ts calls World.scripts.tick once a second). What
   *  they write goes out like any write. */
  tickScripts() {
    if (this.retired) return;
    if (this.live.state().status !== "ok") return;
    const from = this.live.entries.length;
    try { authorityTick(this.live); } finally { if (this.live.entries.length > from) this.afterWrite(from); }
  }
  /** The engine's heartbeat (server.ts `physics`): rests log at tick cadence with nobody asking, and requests no longer
   *  carry the settling (DESIGN-physics-responsiveness §1; STRIKES PH-S1-2: 150–500 ms per request during a cascade). */
  settle() {
    if (this.retired) return;
    if (this.live.state().status !== "ok") return;
    const from = this.live.entries.length; const held = this.holdsKey();
    try { authoritySettle(this.live); }
    finally { if (this.live.entries.length > from) this.afterWrite(from); if (this.holdsKey() !== held) this.host?.broadcast({ type: "holds", world: this.name, holds: this.holds() }); }
  }
  /** Someone arrived or left: scripts that listen for enter / leave hear it (by their identity). */
  presenceScripts(kind: "enter" | "leave", who: string) {
    if (this.retired) return;
    if (this.live.state().status !== "ok") return;
    const from = this.live.entries.length;
    try { presenceEvent(this.live, kind, who); } finally { if (this.live.entries.length > from) this.afterWrite(from); }
  }
  /** The authority's status view of every script here (debug panel, world_debug {behaviors}). */
  scriptsView(id?: string) { return scriptsView(this.live, id); }

  /** Send what the authority just wrote: the raw entries, to every client (they all fold the log). Chat lines go into the
   *  window; the view goes stale for its next reader; a role change re-sends everyone's rights. */
  private stale = false;
  private afterWrite(from: number) {
    this.stats.writes++;
    const fresh = this.live.entries.slice(from);
    const newActors = [...new Set(fresh.map((e: Any) => e?.actor).filter((a: Any) => typeof a === "string" && !this.actors.has(a)))] as string[];
    newActors.forEach((a) => this.actors.add(a));
    // a role written for someone who never acted here: clients need their name too, or the narration says "made u-…"
    const named = new Set<string>(newActors);
    for (const e of fresh) { if (e?.kind !== "change") continue; let ops: Any[] = []; try { ops = opsOf(e); } catch { /* malformed: nothing to name */ }
      for (const o of ops) if (o?.id === "@world" && String(o.comp ?? "").startsWith("roles:")) named.add(String(o.comp).slice(6)); }
    const msg = { type: "log", world: this.name, from, entries: fresh.map(wireEntry), ...(named.size ? { names: this.names(named) } : {}) };
    // a ghost gets every entry (the fold must stay contiguous) but each say's body and speaker emptied
    if (this.host?.broadcastLog) this.host.broadcastLog(msg, { ...msg, entries: msg.entries.map((e: Any) => (e?.kind === "say" ? { ...e, actor: "world", body: {} } : e)) });
    else this.host?.broadcast(msg);
    for (const e of fresh) if (e?.kind === "say") this.hearSay(e);
    this.stale = true;
    // anything that can change what someone may do: a role, the definitions, the default role, the install setting
    const roles = (e: Any) => { try { return e?.kind === "change" && opsOf(e).some((o: Any) => o.id === "@world" && (String(o.comp ?? "").startsWith("roles:") || ["role-defs", "default-role", "script-settings", "access"].includes(o.comp))); } catch { return false; } };
    if (fresh.some(roles)) this.host?.rightsChanged();
  }
  private record(e: ChatLine) {
    this.hist.push(e); if (this.hist.length > 512) this.hist.splice(0, this.hist.length - 512);
    if (e.verb === "say") { this.recentSays.push(e); if (this.recentSays.length > 256) this.recentSays.shift(); }
  }

  // ---- what the World and server.ts read ----
  /** A page of chat history, newest first by `before` (the whole log is in memory: every line ever said here). */
  readHistory({ before = Infinity, after = -Infinity, limit = 50, verbs = null as Set<string> | null }) {
    // the whole log is in memory (live.entries): page back through every chat line ever said, not the ones heard since
    // load (Commons audit #2: scrollback stopped at 40 and told people it was "the beginning of this world")
    if (verbs && !verbs.has("say")) return { entries: [], oldestSeq: null, hasMore: false };
    const out: ChatLine[] = []; let more = false; const E = this.live.entries;
    for (let i = E.length - 1; i >= 0; i--) { const e = E[i]; if (!e || e.kind !== "say" || e.body?.commit !== undefined) continue;
      const seq = e.seq * 1000; if (seq >= before) continue; if (seq <= after) break;
      if (out.length === limit) { more = true; break; } out.push(this.sayLine(e)); }
    out.reverse();
    return { entries: out, oldestSeq: out.length ? out[0].seq : null, hasMore: more };
  }
  /** Bring the view up to date (the chat window is kept), before anyone reads it again. */
  private freshen() {
    this.stale = false;
    this._state = this.view();
  }
  /** The role the authority gives this identity (the authority is what admits writes). */
  roleOf(actor: string): string { return roleIn(this.live.state(), actor, { anon: directoryFor(WORLDS_DIR).entry(actor)?.kind === "anon" }); }
  /** Every identity this world knows: the actors its log names, the roles it holds, the people its moderator log
   *  names, and everyone whose body it remembers (they were here, even if they never wrote anything). A name lookup —
   *  messages.ts whois, a whisper held for someone absent — is scoped to these, never the whole directory. */
  knownIds(): Set<string> {
    const out = new Set<string>([...this.actors, ...Object.keys(this.poses)]);
    for (const k of Object.keys(this.live.state().entities?.["@world"]?.c ?? {})) if (k.startsWith("roles:")) out.add(k.slice(6));
    for (const m of this.live.mod ?? []) if (typeof m?.who === "string") out.add(m.who);
    for (const id of [...out]) if (!/^u-[a-z2-7]{20}$/.test(id)) out.delete(id);   // the system's own (system, world, script:…) aren't people
    return out;
  }
  /** The authority's moderator log says this identity is banned here (authority.js isBanned): join must refuse it too. */
  bannedHere(actor: string): boolean { return isBanned(this.live, actor); }
  private anon(actor: string) { return directoryFor(WORLDS_DIR).entry(actor)?.kind === "anon"; }
  /** What this identity may do here, from the authority (roles.js effectiveOf): {role, name, rank, can, switches}. */
  rightsOf(actor: string) { return effectiveIn(this.live.state(), actor, { anon: this.anon(actor) }); }
  /** A kick whose cooldown still runs: {until, by, reason?} or null (join refuses it). */
  kickedHere(actor: string): Any { return kickOf(this.live, actor); }
  mutedHere(actor: string, channel?: "voice" | "chat"): Any { return muteOf(this.live, actor, channel); }
  ghostHere(actor: string): Any { return ghostOf(this.live, actor); }
  /** Everything in force now, per identity (the sweep that re-applies voice mutes and ghost hiding reads it). */
  sanctions(): Record<string, Any> { return sanctionsNow(this.live); }
  /** The most senior owner (reset is theirs alone: review 10-06; research §owner-only). */
  seniorOwner(): string | null { return seniorOwnerOf(this.live); }
  /** @world.access ({join, max?, soft?}) or null. */
  access(): Any { const a = this.live.state().entities?.["@world"]?.c?.access; return a && typeof a === "object" ? a : null; }
  /** Has this identity a roles:<id> here (access.join 'listed')? */
  listedHere(actor: string): boolean { return !!this.live.state().entities?.["@world"]?.c?.[`roles:${actor}`]; }
  /** Slice 3b: what a client that folds the log adopts at join: the fold itself (shared/protocol/replica.js wireState), its head,
   *  and the asker's own acts that undo could still take back (newest last), so Ctrl+Z survives a reload. */
  clientCut(actor: string) {
    const X = actIndexOf(this.live); const E = this.live.entries;
    const mine = (X.actsOf.get(actor) ?? []).filter((q: number) => !["undo", "create-world", "throw", "drop", "leave", "move", "grab"].includes(E[q].verb) && !X.undone.has(q) && X.resultOf.has(q)).slice(-40);
    return { ...clientCutOf(this.live), head: this.head, mine, you: actor, names: this.names([...this.actors, actor]), holds: this.holds() };
  }
  rememberPose(id: string, pose: unknown, settle: (p: unknown) => unknown) {
    if (!pose) return;
    this.poses[id] = settle(pose);
    try { fs.mkdirSync(this.dir, { recursive: true }); atomicWrite(this.posesPath, JSON.stringify(this.poses)); } catch (err) { console.error(`[world:${this.name}] poses`, err); }
  }
  /** What the snapshot says about this world's protocol (agents read it to route their tools). */
  info() { return { dialect: DIALECT, v: VERSION, head: this.head, worldId: this.live.worldId, verbs: "send {type: 'request', id, verb, args}; reply {type: 'reply', id, …}" }; }
}

// ---- founding and translating (tools/protocol/world.ts is the command line) ----
import { opsOf, DIALECT, VERSION } from "../shared/protocol/fold.js";

/** Found a new world in `dir` (which must not hold a world): genesis + the founding act, through the authority. */
export function foundWorld(dir: string, name: string, owner: string, title?: string, now?: () => number) {
  if (fs.existsSync(path.join(dir, "world.jsonl")) || fs.existsSync(path.join(dir, "log.jsonl"))) throw new Error(`${dir} already holds a world`);
  fs.mkdirSync(dir, { recursive: true });
  const w = openLive(dir, name, { now });
  // the owner is an account (human:…, agent:…, local:…); a bare name means `local:<name>`, the account a TRUST_NAMES
  // server gives that typed name. Its opaque id comes from the authority directory (round-2 review R1).
  const acct = /^(human|agent|aid1|local):/.test(owner) ? owner : `local:${owner.toLowerCase()}`;
  const id = directoryFor(path.dirname(dir)).resolve({ sub: acct, name: acct.startsWith("local:") ? owner : acct.split(":").pop()!, agent: /^(agent|aid1):/.test(acct) });
  const r = authorityRequest(w, id, "create-world", { title: title ?? name });
  if (!r.ok) throw new Error(`founding refused: ${JSON.stringify(r.refused)}`);
  return { worldId: w.worldId, owner: id, account: acct, entries: w.entries.length };
}

// ---------- a person founds a world they own (ship list 10-07: only an operator could) ----------
// The authority's own founding act (`new`, genesis naming the founder as owner), built aside and renamed into place, as a fork
// is. Who may (server/requestwire.ts world-found decides from the connection; this file keeps the ledger):
//   - a signed-in PERSON: a guest (no account) never founds, and an agent's account doesn't either (an operator founds
//     for an agent: tools/protocol/world.ts found); spectators don't;
//   - at most FOUNDING.perAccount worlds per account, ever (deleting isn't offered yet, so this is a lifetime cap);
//   - one at a time per account (FOUNDING.gapMs apart), and at most FOUNDING.perHour across the whole server, so a
//     crowd of new accounts can't take every good name in an afternoon (no land rush);
//   - a name of 3-32 lowercase letters, digits and '-', starting with a letter or digit, that no world has: taken,
//     loaded or on disk (an existing world is never touched, let alone taken over).
// The ledger (WORLDS_DIR/.founders.json: name → {account, actor, ts}) is what the caps count; a dot-name is never a world.
export const FOUNDING = {
  perAccount: Number(process.env.FOUND_PER_ACCOUNT ?? 3),
  perHour: Number(process.env.FOUND_PER_HOUR ?? 12),
  gapMs: Number(process.env.FOUND_GAP_MS ?? 10 * 60_000),
};
export const FOUND_NAME = /^[a-z0-9][a-z0-9-]{2,31}$/;
const foundersPath = () => path.join(WORLDS_DIR, ".founders.json");
export function foundersLedger(): Record<string, { account: string; actor: string; ts: number }> {
  try { const v = JSON.parse(fs.readFileSync(foundersPath(), "utf8")); return v && typeof v === "object" && !Array.isArray(v) ? v : {}; } catch { return {}; }
}
/** Why this account may not found `name` now (a sentence for the person), or null when it may. */
export function foundRefusal(account: string, name: string, exists: (n: string) => boolean, now = Date.now()): string | null {
  if (!FOUND_NAME.test(name)) return `"${name.slice(0, 40)}" can't be a world's name: 3 to 32 lowercase letters, digits and '-', starting with a letter or digit`;
  if (exists(name)) return `there's already a world called "${name}" — pick another name`;
  const L = Object.values(foundersLedger());
  const mine = L.filter((x) => x.account === account);
  if (mine.length >= FOUNDING.perAccount) return `you've founded ${mine.length} worlds here, the most one account may (${FOUNDING.perAccount})`;
  const last = Math.max(0, ...mine.map((x) => x.ts));
  if (now - last < FOUNDING.gapMs) return `you founded a world ${Math.round((now - last) / 60000)} min ago — one every ${Math.round(FOUNDING.gapMs / 60000)} min`;
  if (L.filter((x) => now - x.ts < 3600_000).length >= FOUNDING.perHour) return `this server has had ${FOUNDING.perHour} new worlds in the last hour, its limit — try again later`;
  return null;
}
/** Found `name` for `actor` (its owner), recording it in the ledger. Built aside, renamed into place: nothing half-made. */
export function foundOwnedWorld(name: string, actor: string, account: string, title?: string, exists: (n: string) => boolean = (n) => fs.existsSync(path.join(WORLDS_DIR, n)), now = Date.now()):
  { ok: true; worldId: string } | { ok: false; err: string } {
  const why = foundRefusal(account, name, exists, now); if (why) return { ok: false, err: why };
  const dest = path.join(WORLDS_DIR, name);
  const tmp = path.join(WORLDS_DIR, `.founding-${name}-${crypto.randomBytes(4).toString("hex")}`);
  try {
    fs.mkdirSync(tmp, { recursive: true });
    const w = openLive(tmp, name, { catalogue: ENGINE_CATALOGUE });
    const r = authorityRequest(w, actor, "create-world", { title: String(title || name).slice(0, 80) });
    if (!r.ok) throw new Error(`the authority refused the founding: ${r.refused?.reason}`);
    if (fs.existsSync(dest)) throw new Error(`there's already a world called "${name}"`);   // taken while this one was built
    fs.renameSync(tmp, dest);
    const L = foundersLedger(); L[name] = { account, actor, ts: now }; atomicWrite(foundersPath(), JSON.stringify(L, null, 1));
    return { ok: true, worldId: w.worldId };
  } catch (e: Any) {
    fs.rmSync(tmp, { recursive: true, force: true });
    return { ok: false, err: String(e?.message ?? e) };
  }
}

// ---------- fork and reset ----------
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
/** Every component of the source as ordinary requests (the same gate as a hand edit), in batches under the
 *  1 MiB line cap. Locks and pins are written last, after everything they'd protect exists. */
function copyInto(w: Any, actor: string, st: Any, skipWorld: (k: string) => boolean) {
  const reqs: Any[] = [], late: Any[] = [];
  for (const [k, v] of Object.entries<Any>(st.entities["@world"]?.c ?? {})) if (!skipWorld(k)) reqs.push({ verb: "set", args: { id: "@world", component: k, value: v } });
  for (const id of parentsFirst(st)) {
    const { model, lock, ...comps } = st.entities[id].c;
    reqs.push({ verb: "create", args: { id, ...(model !== undefined ? { model } : {}), components: comps } });
    if (lock !== undefined) late.push({ verb: "set", args: { id, component: "lock", value: lock } });
  }
  const all = [...reqs, ...late]; let batch: Any[] = [], size = 0, acts = 0;
  const flush = () => { if (!batch.length) return; const r = forkCopy(w, actor, { ops: batch, throughLock: true });   // logged as fork-copy: inherited, not born
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
 *  source's log stays the record, and the fork links to it. */
export function forkWorld(src: WorldLog, to: string, forker: string): { ok: true; worldId: string; things: number; acts: number } | { ok: false; err: string } {
  if (!WORLD_NAME.test(to)) return { ok: false, err: `bad world name "${to}" — letters, digits, - and _ only` };
  if (to === src.name) return { ok: false, err: "a world can't be copied onto itself" };
  const dest = path.join(WORLDS_DIR, to);
  if (fs.existsSync(dest)) return { ok: false, err: `world "${to}" already exists` };
  const tmp = path.join(WORLDS_DIR, `.forking-${to}-${crypto.randomBytes(4).toString("hex")}`);
  try {
    const st = src.live.state();
    fs.mkdirSync(tmp, { recursive: true });
    const blobs = path.join(WORLDS_DIR, src.name, "blobs");   // content-addressed (blueprints, script sources): all of them travel
    if (fs.existsSync(blobs)) fs.cpSync(blobs, path.join(tmp, "blobs"), { recursive: true });
    const w = openLive(tmp, to, { catalogue: ENGINE_CATALOGUE });
    const title = st.entities["@world"]?.c.about?.name ?? to;
    const at = src.live.entries.length - 1;   // genesis.parent {world, seq, head}: the merge base (PROTOCOL §13)
    const r0 = authorityRequest(w, forker, "create-world", { title, from: { world: src.live.worldId, name: src.name, seq: at, head: src.live.headAt(at) } });
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
 *  replaced. Returns the archive directory. The caller swaps in a fresh WorldLog and tells everyone present. */
export function resetWorld(log: WorldLog): string {
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
    const r0 = authorityRequest(w, owners[0], "create-world", { title: st.entities["@world"]?.c.about?.name ?? log.name, from: prev });
    if (!r0.ok) throw new Error(`founding again refused: ${r0.refused?.reason}`);
    for (const o of owners.slice(1)) { const r = authorityRequest(w, owners[0], "set", { id: "@world", component: `roles:${o}`, value: { role: "owner" } });
      if (!r.ok) throw new Error(`restoring owner ${o} refused: ${r.refused?.reason}`); }
  } catch (e) { fs.rmSync(fresh, { recursive: true, force: true }); throw e; }
  const arch = path.join(dir, `reset-${new Date().toISOString().replace(/[:.]/g, "-")}`);
  fs.mkdirSync(arch, { recursive: true });
  for (const f of ["world.jsonl", "poses.json"]) if (fs.existsSync(path.join(dir, f))) fs.renameSync(path.join(dir, f), path.join(arch, f));
  fs.renameSync(path.join(fresh, "world.jsonl"), path.join(dir, "world.jsonl"));
  fs.rmSync(fresh, { recursive: true, force: true });
  return arch;
}
