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
import { mkdirDurable } from "./durable.ts";
import { forkCopy, operatorRepair as authorityOperatorRepair, request as authorityRequest, actIndexOf, roleIn, isBanned, kickOf, muteOf, sanctionsNow, effectiveIn, seniorOwnerOf, tick as authorityTick, settle as authoritySettle, presenceEvent, scriptsView, settleOrphans, liftWorld, reachAdmits, reachLetGo, expireRoles as authorityExpireRoles } from "../shared/protocol/authority.js";
import { authorityTime } from "./readmeter.ts";
import { txnOutcome, txnRefusal, wedgedOf } from "../shared/protocol/authority/storage.js";
import { clientCutOf, spokenOf } from "../shared/protocol/replica.js";
import { viewState } from "../shared/protocol/view.js";
import { holdWire } from "../shared/grab.js";
import { hear } from "../shared/chatwindow.js";
import { dec } from "../shared/protocol/names.js";
import { openLive, isWorldDir, isPreNamesDir } from "./livehost.ts";
import { ENGINE_CATALOGUE, warm, modelsIn } from "./modelcatalogue.ts";
import { backupBeforeRepair, sealBackup, dropBackup } from "./repairfiles.ts";

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
  /** send to one identity's embodied leg(s); false when they aren't here */
  toActor?(actor: string, msg: unknown): boolean;
  /** speech is arrival-only (R 10-18): the seq at or below which this identity may not read a say back (null = an admin:
   *  no floor). The World answers from its connections (world.ts sayFloor); the authority's history reads it. */
  sayFloor?(actor: string): number | null;
  /** after a request: every standing pose that carries a reach is held to the tables as they are now, so a hand a consent
   *  no longer allows leaves at once, whether the touch was allowed by the table or granted by an ask */
  regateReaches?(): void;
};

/** What a person can do about a recheck's refusal (review of #260, server I23): reconnecting and sending again helps only
 *  when the connection changed under the request; when the door, the role or operator status changed, sending again from
 *  a new connection meets the same answer. */
export function recheckFix(reason: string): string {
  if (/door no longer lets|operator status changed|needs a server operator/.test(reason)) return "sending it again won't change this: what this account may do here changed";
  if (/role here changed/.test(reason)) return "send it again if you still mean it, under your role as it is now";
  return "reconnect, then send it again from the connection that is in the world now";
}

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
    // a host that can't say when someone arrived (none attached yet) hides every say: a floor at the head (fail closed)
    this.live = openLive(this.dir, name, { catalogue: ENGINE_CATALOGUE, present: () => this.host?.present?.() ?? [],
      sayFloor: (a: string) => (this.host?.sayFloor ? this.host.sayFloor(a) : Infinity) });
    for (const e of this.live.entries) if (e && typeof e.actor === "string") this.actors.add(e.actor);
    // a world opened after a crash: what was held when the host stopped is settled now (nobody is connected yet), and
    // logged, so a joiner's cut already has it back in the world (authority.js settleOrphans)
    try { const settled = settleOrphans(this.live, []); if (settled.length) console.log(`[world:${name}] settled ${settled.length} hold(s) left from before the restart: ${JSON.stringify(settled).slice(0, 300)}`); }
    catch (err) { console.error(`[world:${name}] settling orphaned holds`, err); }
    // the load (authority.js liftWorld) writes nothing: it reports what maintenance the world needs, to the console and, once
    // the world is attached, to the flight recorder (world_debug, /debug)
    try { const lifted = liftWorld(this.live) as Any[];
      const skipped = lifted.filter((x) => x.skipped);
      for (const k of skipped) console.warn(`[world:${name}] this server can't sign for this world (${k.skipped}): ${k.why}`);
      // the load writes nothing (lead's ruling 10-18): it says which maintenance steps the world needs, and whether writes are
      // refused meanwhile (repair-needed), naming the command
      const need = lifted.find((x) => x.repairNeeded)?.repairNeeded;
      if (need) console.warn(`[world:${name}] needs maintenance (${need.steps.join(", ")}): ${need.why}. ${need.fix.replace("<name>", name)}`);
      this.liftNotes = [...skipped.map((k) => ({ skipped: k.skipped, why: k.why })), ...(need ? [{ repair: true, needed: true, ...need }] : [])]; }
    catch (err) { console.error(`[world:${name}] lifting sockets`, err); }
    const st = this.live.state();
    if (st.status !== "ok") console.warn(`[world:${name}] log folds to '${st.status}': the authority will refuse writes`);
    // §12: a value stripped to its commit that no purge names: the log was changed outside the purge rule. Said, not enforced:
    // the value reads as unknown, and writes go on (house markup, #260 10-20)
    const altered = (st.diagnostics ?? []).filter(([, c]: Any) => c === "commit-unpurged");
    if (altered.length) console.warn(`[world:${name}] log was changed outside its purge rule at line(s) ${altered.map(([q]: Any) => q).join(", ")} (a value stripped to its commit, no purge naming it): it reads as unknown, and the authority refuses writes until the operator, with the world closed, restores those lines from a backup of the log and reopens it (each restored whole keeps its commit, so later lines still verify)`);
    this._state = this.view();
    // chat: the last 40 says, through the window's own rule; chatTotal counts every line ever said here
    const says = this.live.entries.filter((e: Any) => e && e.kind === "say");
    if (this._state) this._state.chatTotal = Math.max(0, says.length - 40);
    for (const e of says.slice(-40)) this.hearSay(e);
    if (fs.existsSync(this.posesPath)) { try { this.poses = JSON.parse(fs.readFileSync(this.posesPath, "utf8")); } catch { /* corrupt = fresh */ } }
    // standing models, measured for the authority; a request waits for them (review of #260, server I70: one decided in
    // the first moments after a load met unsized standing models, and its outcome is logged for good)
    this.standing = warm(Object.values(st.entities ?? {}).map((e: Any) => e.c.model)).catch(() => {});
  }
  /** what the load's socket lift couldn't do (per host), whether the world still needs the shape repair, and a rename's failure, said to the flight recorder when a world attaches */
  private liftNotes: Record<string, unknown>[] = [];
  private standing: Promise<unknown> = Promise.resolve();
  attach(host: LogHost) { this.host = host; for (const n of this.liftNotes) host.debug(n.repair ? "repair-needed" : "custody", n); }

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
  /** `still` (optional): the asker's capability, rechecked after the await and immediately before the synchronous authority
   *  call (a connection that closed, was taken over or left while its request waited must not write: review of PR #260,
   *  requestwire.ts:135). It returns null while the asker may still act, else the refusal's words; nothing is written then.
   *  requestwire.ts passes server/reqcap.ts recheck(cap) here: the request's one immutable capability, re-validated (liveness,
   *  identity, operator, the door, the role) at this seam, the last await before the commit.
   *  Never throws: every request ends in a reply carrying its transaction outcome (requestSync). */
  async request(actor: string, verb: string, args: Record<string, unknown> = {}, still?: () => string | null) {
    let gone: string | null | undefined;
    try { await this.standing; await warm(modelsIn(args)); gone = still?.(); }
    catch (err) { console.error(`[world:${this.name}] ${verb.slice(0, 32)} by ${actor}: failed before the authority saw it`, err); return txnRefusal({ outcome: "rolled-back" }); }
    if (gone) return { ok: false, txn: "rolled-back", refused: { code: "superseded", reason: gone, fix: recheckFix(gone) } };
    return this.requestSync(actor, verb, args);
  }
  /** One request through the authority, as a transaction (PROTOCOL §7; storage.js txnOutcome): the reply carries
   *  `txn` (never `outcome`: a body verb's reply uses that word) — committed (ok), rolled-back (a refusal, or a throw before any of it was written) or ambiguous (a durable
   *  write threw, or it was cut off part-way; never ok, code `ambiguous`, `from` = the first seq whose state is unknown).
   *  Persist before publish: lines reach entries only after the disk took them (storage.js append), and whatever reached
   *  entries is published here in a finally, whether the authority returned or threw (a durable line is never left
   *  unpublished: every client's chain would be behind the server's). Never throws. */
  requestSync(actor: string, verb: string, args: Record<string, unknown> = {}) {
    if (this.retired) return { ...WorldLog.RESET, txn: "rolled-back" };
    this.stats.requests++;
    const live = this.live;
    const from = live.entries.length; const held = this.holdsKey(); const wedgedBefore = wedgedOf(live);
    const t0 = performance.now(); let r: Any = null; let threw: unknown = null;
    try { r = authorityRequest(live, actor, verb, args); }
    catch (err) { threw = err ?? new Error("the authority threw"); }
    finally { this.publish(from, held); }
    const o = txnOutcome(live, from, { threw: threw !== null, refused: !!r && typeof r === "object" && r.ok === false, wedgedBefore });
    if (threw !== null) {
      console.error(`[world:${this.name}] ${verb.slice(0, 32)} by ${actor} threw in the authority (${o.outcome}${o.outcome === "ambiguous" ? ` from seq ${o.from}` : ""}):`, threw);
      if (o.outcome === "ambiguous") this.host?.debug("ambiguous", { verb: verb.slice(0, 32), from: o.from, wedged: !!o.wedged, line: `a ${verb.slice(0, 32)} ended ambiguous at seq ${o.from}${o.wedged ? ": storage failed mid-write; writes are refused until the world is reopened" : ""}` });
      r = txnRefusal(o);
    } else if (r && typeof r === "object") { r.txn = o.outcome; }
    if (r && typeof r === "object") authorityTime.set(r, performance.now() - t0);
    return r;
  }
  /** After a request (returned or thrown): publish what reached the log, the holds if they changed, the inbox. A publish
   *  that fails is logged, never turned into the request's outcome (its lines are durable whatever a socket did). */
  private publish(from: number, held: string) {
    try { if (this.live.entries.length > from) this.afterWrite(from); } catch (err) { console.error(`[world:${this.name}] publishing seq ${from}… failed`, err); }
    try { if (this.holdsKey() !== held) this.host?.broadcast({ type: "holds", world: this.name, holds: this.holds() }); this.forwardInbox(); }
    catch (err) { console.error(`[world:${this.name}] holds/inbox after a request failed`, err); }
    // a request may have closed someone's table (consent, a friend removed, a pause): what rests on them is held to it now,
    // not at the reacher's next packet (review of #260)
    try { this.host?.regateReaches?.(); } catch (err) { console.error(`[world:${this.name}] re-gating reaches after a request failed`, err); }
  }
  /** A server operator's recorded repair (authority.js operatorRepair: @world's roles/access/default-role/role-defs, unban, repair-shapes;
   *  recorded as the operator's act with operator: true). Only server/requestwire.ts's operator-repair reaches it, behind
   *  isOperator. Synchronous, like requestSync: there is no await between the check and the write. */
  operatorRepair(actor: string, verb: string, args: Record<string, unknown> = {}) {
    if (this.retired) return { ...WorldLog.RESET, txn: "rolled-back" };
    const live = this.live;
    const from = live.entries.length; const held = this.holdsKey(); const wedgedBefore = wedgedOf(live);
    let r: Any = null; let threw: unknown = null;
    // the shape repair (reviewer item 9): its pre-repair log is kept beside the world for a rollback (server/repairfiles.ts;
    // `bun tools/protocol/world.ts repair <name> --rollback`, with the server stopped), as the CLI keeps it
    try {
      const backup = (verb === "repair" || verb === "repair-shapes") && args.dryRun !== true ? backupBeforeRepair(this.dir, { by: actor }) : null;
      // a throw from a durable write is ambiguous (durable.ts: the line may be on disk while the count didn't move), so a
      // throw keeps the backup; only a repair that returned having written nothing drops it (review of #260, server I24)
      let threwHere = true;
      try { r = authorityOperatorRepair(live, actor, verb, args); threwHere = false; }
      finally { if (backup) { if (threwHere || live.entries.length > from) sealBackup(backup); else dropBackup(backup); } }
    } catch (err) { threw = err ?? new Error("the repair threw"); }
    finally { this.publish(from, held); }   // the same transaction as requestSync: what reached the log is published
    const o = txnOutcome(live, from, { threw: threw !== null, refused: !!r && typeof r === "object" && r.ok === false, wedgedBefore });
    if (threw !== null) { console.error(`[world:${this.name}] operator repair ${verb.slice(0, 32)} threw (${o.outcome}):`, threw); return txnRefusal(o); }
    if (r && typeof r === "object") r.txn = o.outcome;
    return r;
  }
  /** The relay's per-packet question for a reach descriptor aimed at another body (authority.js reachAdmits): presence only,
   *  never a request (nothing appended, no ask made). A refusal it noted goes straight to the reacher's socket. */
  reachAdmits(from: string, to: string, cls: string, extra: { point?: string | null; limb?: string; quiet?: boolean } = {}) {
    if (this.retired) return { ok: false, code: "reset", reason: "this world was reset", noted: false };
    const r = reachAdmits(this.live, from, to, cls, extra);
    if (r.noted) this.forwardInbox();
    return r;
  }
  /** …and after the packet: which bodies a relayed limb of `from`'s rests on. A yes whose hand is no longer on its body ends
   *  (authority.js reachLetGo; r2 holes F3). Presence only. */
  reachLetGo(from: string, aimed: Set<string>) {
    if (this.retired) return false;
    return reachLetGo(this.live, from, aimed);
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
  /** Timed grants (server/access.ts sweepAccess, once a second): the authority writes the end of every roles:<id> whose
   *  `until` has passed (expire-roles), sent out like any write. → the identities whose grant ended. */
  expireRoles(): string[] {
    if (this.retired || this.live.state().status !== "ok") return [];
    const from = this.live.entries.length; let ended: string[] = [];
    try { ended = authorityExpireRoles(this.live); } finally { if (this.live.entries.length > from) this.afterWrite(from); }
    return ended;
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
    this.host?.broadcast(msg);
    for (const e of fresh) if (e?.kind === "say") this.hearSay(e);
    this.stale = true;
    // anything that can change what someone may do: a role, the definitions, the default role, access
    const roles = (e: Any) => { try { return e?.kind === "change" && opsOf(e).some((o: Any) => o.id === "@world" && (String(o.comp ?? "").startsWith("roles:") || ["role-defs", "default-role", "access"].includes(o.comp))); } catch { return false; } };
    if (fresh.some(roles)) this.host?.rightsChanged();
  }
  private record(e: ChatLine) {
    this.hist.push(e); if (this.hist.length > 512) this.hist.splice(0, this.hist.length - 512);
    if (e.verb === "say") { this.recentSays.push(e); if (this.recentSays.length > 256) this.recentSays.shift(); }
  }

  // ---- what the World and server.ts read ----
  /** A page of chat history, newest first by `before` (the whole log is in memory: every line ever said here). `floor`:
   *  speech is arrival-only (R 10-18), so a say at or below this log seq isn't read back (null = an admin: every say). */
  readHistory({ before = Infinity, after = -Infinity, limit = 50, verbs = null as Set<string> | null, floor = Infinity as number | null }) {
    // the whole log is in memory (live.entries): page back through every chat line ever said, not the ones heard since
    // load (Commons audit #2: scrollback stopped at 40 and told people it was "the beginning of this world")
    if (verbs && !verbs.has("say")) return { entries: [], oldestSeq: null, hasMore: false };
    const out: ChatLine[] = []; let more = false; const E = this.live.entries;
    for (let i = E.length - 1; i >= 0; i--) { const e = E[i]; if (!e || e.kind !== "say" || e.body?.commit !== undefined) continue;
      if (floor !== null && !(e.seq > floor)) break;   // before the asker arrived: older lines are older still
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
  /** does `actor` hold `permission` now: an ended timed grant is absent at `now`, as the door reads it (access.ts listedIn),
   *  before the authority's sweep writes its end (pre-review of #260: readChat read an ended grant for up to a sweep) */
  may(actor: string, permission: string, now = Date.now()): boolean {
    const st: Any = this.live.state(); const wc = st?.entities?.["@world"]?.c ?? {}; const g = wc[`roles:${actor}`];
    const ended = g && typeof g === "object" && Number.isSafeInteger(g.until) && g.until <= now;
    const view = ended ? { ...st, entities: { ...st.entities, "@world": { ...st.entities["@world"], c: Object.fromEntries(Object.entries(wc).filter(([k]) => k !== `roles:${actor}`)) } } } : st;
    return effectiveIn(view, actor, { anon: directoryFor(WORLDS_DIR).entry(actor)?.kind === "anon" })?.can?.[permission] === true;
  }
  /** Every identity this world knows: the actors its log names, the roles it holds, the people its moderator log
   *  names, and everyone whose body it remembers (they were here, even if they never wrote anything). A name lookup —
   *  requestwire.ts whois — is scoped to these, never the whole directory. */
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
  /** Everything in force now, per identity (the sweep that re-applies voice mutes reads it). */
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
import { isOwner } from "../shared/protocol/roles.js";

/** Found a new world in `dir` (which must not hold a world): genesis + the founding act, through the authority. */
export function foundWorld(dir: string, name: string, owner: string, title?: string, now?: () => number) {
  if (fs.existsSync(path.join(dir, "world.jsonl")) || fs.existsSync(path.join(dir, "log.jsonl"))) throw new Error(`${dir} already holds a world`);
  mkdirDurable(dir);   // the world's directory is named in its parent, which a crash can lose like the log's first line
  const w = openLive(dir, name, { now });
  // the owner is an account (human:…, agent:…, local:…); a bare name means `local:<name>`, the account a TRUST_NAMES
  // server gives that typed name. Its opaque id comes from the authority directory (round-2 review R1).
  const acct = /^(human|agent|aid1|local):/.test(owner) ? owner : `local:${owner.toLowerCase()}`;
  const id = directoryFor(path.dirname(dir)).resolve({ sub: acct, name: acct.startsWith("local:") ? owner : acct.split(":").pop()! });
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
    // the founding act wrote about and the forker's role; canonOf uses the same skip, so they agree
    const skip = (k: string) => k === "about" || k === `roles:${forker}`;
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
  const owners = Object.entries<Any>(st.entities["@world"]?.c ?? {}).filter(([k, v]) => k.startsWith("roles:") && isOwner(v)).map(([k]) => k.slice(6));
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
    // a world with a door stays behind it (upstream #258): erasing the content must not be what opens a members-only or a
    // signed-in-only world to everyone, or drops its watch rule, age or size limit (review of #260, server I7: only
    // "listed" was kept). Its door (access, default-role) and every live role come back; a timed grant keeps its end, one
    // already past is left behind.
    const wc = st.entities["@world"]?.c ?? {};
    if (wc.access != null) {
      const now = Date.now();
      const keep: [string, Any][] = Object.entries<Any>(wc).filter(([k, v]) => (k === "access" || k === "default-role" || k === "role-defs"
        || (k.startsWith("roles:") && !isOwner(v))) && !(Number.isSafeInteger(v?.until) && v.until <= now));
      keep.sort(([a], [b]) => (a === "role-defs" ? -1 : b === "role-defs" ? 1 : 0));   // custom roles first: a role refers to them
      for (const [k, v] of keep) { const r = authorityRequest(w, owners[0], "set", { id: "@world", component: k, value: v });
        if (!r.ok) throw new Error(`keeping ${k} through the reset refused: ${r.refused?.reason}`); }
    }
  } catch (e) { fs.rmSync(fresh, { recursive: true, force: true }); throw e; }
  const arch = path.join(dir, `reset-${new Date().toISOString().replace(/[:.]/g, "-")}`);
  fs.mkdirSync(arch, { recursive: true });
  // from the first rename on, a failure has changed something: it says where the old log went (review of #260, server I19)
  try {
    for (const f of ["world.jsonl", "poses.json"]) if (fs.existsSync(path.join(dir, f))) fs.renameSync(path.join(dir, f), path.join(arch, f));
    fs.renameSync(path.join(fresh, "world.jsonl"), path.join(dir, "world.jsonl"));
  } catch (e: Any) { const err: Any = new Error(String(e?.message ?? e)); err.movedTo = arch; err.freshAt = fresh; throw err; }
  // the fresh log is in place, and nothing left in the scratch directory is used again: failing to remove it, whole or in
  // part, leaves litter for the operator, not a failed reset
  try { fs.rmSync(fresh, { recursive: true, force: true }); } catch (e) { console.warn(`[world] reset left its scratch directory ${fresh}: ${e}`); }
  return arch;
}
