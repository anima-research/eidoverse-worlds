// server/requestwire.ts — the ws messages that reach a world's authority. server.ts consults this table first.
//   request {type: "request", id, verb, args} → {type: "reply", id, verb, ok, reply}, reply = the authority's own answer, whole.
//           The asker is stamped from the connection, never read from the payload. Spectators may only read.
//   world-fork, world-reset   an owner copies the world to a new name, or erases it to zero (archived, founded again).
//   world-found               a signed-in person founds a new, empty world they own (server/worldlog.ts foundOwnedWorld).
// Requests from one client run in order: an async warm-up never lets a later request overtake an earlier one.
import { forkWorld, foundOwnedWorld, recheckFix } from "./worldlog.ts";
import { worldExists, worlds } from "./world.ts";
import type { Client, World } from "./world.ts";
import { serverBans, saveServerBans, banKey, ADDR_BAN_MS, fileAddrSanction, liftAddrSanction, notPersisted } from "./moderation.ts";
import { directoryFor, foldName } from "./directory.ts";
import { WORLDS_DIR } from "./config.ts";
import { isBanned, inForceOf } from "../shared/protocol/authority.js";
import { txnRefusal } from "../shared/protocol/authority/storage.js";
import { WIRE_READS, PERSON_ACTS } from "../shared/protocol/verbclasses.js";
import { METER_SCALE, readMeter, authorityTime } from "./readmeter.ts";
import { isOperator } from "./operators.ts";
import { capture, recheck, type ReqCap } from "./request-capability.ts";
import { isOwner } from "../shared/protocol/roles.js";
import { UPGRADE_MESSAGES } from "./upgrade.ts";

type Ctx = { c: Client; ws: { send(d: string): void }; now: number; expel: (w: World, target: Client, why: string, until?: number | null) => void; sweep?: (w: World) => void };
type Any = any;
const READS = WIRE_READS;

/** whois {name | id} — name → identity, scoped to THIS world (people present, and identities its logs name): never the
 *  whole directory, never an account. Each match carries its role here, whether it's here now, and whether it's banned. */
export function whois(w: World, args: Any) {
  const q = typeof args?.name === "string" ? args.name.trim() : typeof args?.id === "string" ? args.id.trim() : "";
  if (!q || q.length > 128) return { ok: false, refused: { code: "shape", reason: "whois {name} (or {id: 'u-…'})", fix: "the name someone goes by here, as their nameplate shows it" } };
  const log = w.log!; const dir = directoryFor(WORLDS_DIR);
  const here = new Map<string, string>(), said = new Map<string, string>();
  for (const c of w.clients) if (c.actorId && !c.spectator) { here.set(c.actorId, c.id); if (c.declares) said.set(c.actorId, c.declares); }
  const known = new Set<string>([...here.keys(), ...log.knownIds()]);
  const want = foldName(q);
  if (!want && !/^u-[a-z2-7]{20}(?:[a-z2-7]{4})?$/.test(q)) return { ok: false, refused: { code: "shape", reason: `"${q.slice(0, 40)}" has no letters or digits to look up`, fix: "the name someone goes by here, as their nameplate shows it" } };
  const people = [...known].filter((id) => id === q || (dir.nameOf(id) != null && foldName(dir.nameOf(id)!) === want) || (here.has(id) && foldName(here.get(id)!) === want))
    .map((id) => { const k = dir.entry(id)?.kind;
      // no kind of participant: their own declared word while here, else nothing; the account facts are about the account
      return { id, name: here.get(id) ?? dir.nameOf(id) ?? id, ...(said.has(id) ? { declares: said.get(id) } : {}), ...(k === "anon" ? { guest: true } : k === "imported" ? { imported: true } : {}), role: log.roleOf(id), here: here.has(id), banned: isBanned(log.live, id) }; });
  return { ok: true, name: q, people, ...(people.length ? {} : { note: `nobody called "${q}" has been in this world (it only knows people who were here)` }) };
}
/** allow/block naming an identity no one wears now (a departed guest's per-connection id) is refused `gone`; the client
 *  prunes it on this refusal. */
export function goneListing(w: World, args: Any) {
  const op = typeof args?.allow === "string" ? "allow" : typeof args?.block === "string" ? "block" : null;
  const id: string = op ? args[op] : ""; if (!id) return null;
  if (id.startsWith("script:") || id.startsWith("scripts-by:")) return null;
  const e = directoryFor(WORLDS_DIR).entry(id);
  if (e && (e.kind !== "anon" || [...w.clients].some((o) => o.actorId === id))) return null;
  return { code: "gone", reason: e ? "no one wears that identity now: it was a guest's, which ends with their visit" : "this server knows no one by that identity",
    fix: op === "block" ? "close your move or touch gate to keep out someone you can't name"
      : e ? "a guest is named afresh each connection: allow them while they're here, by the identity they have then"
      : "whois {name} gives the identity of someone who has been in this world" };
}
const reads = readMeter(); // per connection: reads and dry runs, by count and authority time (H-A)
// …and every authority request (`request` but whois, and requestAs; not world-fork/world-reset) by authority time,
// the only per-connection bound on the shared thread (a guest is a fresh identity per connection); 3 s of 10 is far past real use.
const busy = readMeter({ n: Infinity, ms: 3000 * METER_SCALE, window: 10_000 });
const refusalTimes = new WeakMap<Client, number[]>();
/** At most 20 refusal lines per connection per 10 s reach the flight recorder (the rest are the same story). */
function recordRefusal(c: Client): boolean {
  const now = Date.now(); const ts = (refusalTimes.get(c) ?? []).filter((t) => now - t < 10_000);
  if (ts.length >= 20) { refusalTimes.set(c, ts); return false; }
  ts.push(now); refusalTimes.set(c, ts); return true;
}
/** What bystanders are told when the authority removes someone: who did it, to whom (names, from the directory). Not the
 *  reason (that went to the person, and stays in the moderator log), not an address, not an account. */
function modLine(w: World, by: string, verb: string, who: string) {
  const name = directoryFor(WORLDS_DIR).nameOf(who) ?? "someone";
  return verb === "ban" ? `${by} banned ${name} from this world` : verb === "kick" ? `${by} removed ${name} from this world` : verb === "mute" ? `${by} muted ${name}`
    : verb === "unmute" ? `${by} unmuted ${name}` : verb === "warn" ? `${by} warned ${name}` : `${by} lifted the ban on ${name}`;
}
/** The presence types a mute may gag; only `caption` is gagged today (a speech bubble), the rest pass. Applied by server.ts before any handler. */
const QUIET = new Set(["typing", "anim", "puppet", "bodydrag", "drag", "caption"]);
export function gagged(c: Client, type: string): boolean {
  const w = c.world; if (!w?.log || !c.actorId || !QUIET.has(type)) return false;
  return type === "caption" && !!w.log.mutedHere(c.actorId);
}
/** A guest has no account, so a mute on one would be shed by reconnecting: it is also filed against their connection's hashed
 *  address in this world (moderation.ts: at most a day), and server.ts gives it to every new guest from that address at join.
 *  Lifting one (unmute) lifts that record. `verb` is the authority's act; `actor` the identity that did it. */
export function guestSanctionByAddress(w: World, actor: string, by: string, verb: string, who: string, reason?: string): string | null {
  const kind = verb === "mute" || verb === "unmute" ? "mute" : null;
  if (!kind || !w.log) return null;
  const addrs = [...new Set([...w.clients].filter((t) => t.actorId === who && t.anonymous && t.addr).map((t) => t.addr as string))];
  if (verb.startsWith("un")) return liftAddrSanction(kind, w.name, who, addrs[0]);
  // this actor's own mutes in force on `who`, never the union with another's: each issuer's is filed apart
  // one record per issuer: its channels union to the longest end, as a timeout replaces a timeout elsewhere; unmute lifts it
  const mine = inForceOf(w.log.live, who, "mute").filter((m: Any) => m.actor === actor);
  if (!mine.length) return null;
  const channels = [...new Set(mine.flatMap((m: Any) => m.channels ?? ["voice", "chat"]))] as string[];
  const until = mine.some((m: Any) => m.until === undefined) ? null : Math.max(...mine.map((m: Any) => m.until));
  let unsaved: string | null = null;   // why the file wasn't written (the sanction holds in memory only), said in the reply
  for (const addr of addrs) unsaved ??= fileAddrSanction({ kind, world: w.name, addr, actor, by, who, until, channels, ...(reason ? { reason: reason.slice(0, 280) } : {}) });
  return unsaved;
}
/** An unban's lift of the address entry a guest's ban left in this world (the request path and operator-repair alike).
 *  Returns why the file wasn't written (the lift holds in memory only), else null. */
function liftGuestAddressBan(w: World, who: string): string | null {
  let n = 0;
  for (const [k, e] of Object.entries(serverBans)) if ((e as Any)?.who === who && (e as Any)?.world === w.name) { delete serverBans[k]; n++; }
  return n ? saveServerBans() : null;
}
/** The identity the authority stamps for this connection (its directory id, set at join); none is a server bug. */
export const actorOf = (c: Client) => { if (!c.actorId) throw new Error(`request from ${c.id} with no directory id (join didn't resolve one)`); return c.actorId; };

/** Run fn after this client's earlier requests (their warm-ups are async); never let a throw break the queue. A throw that
 *  escapes before the request was answered is answered with the request's own id (`unanswered`), never an id-less error:
 *  a client never leaves a request pending. WorldLog.request never throws (its outcome rides its reply), so such a throw
 *  happened before the authority was reached: nothing was written (rolled back, code server-error). */
const QUEUE_MAX = 256;   // requests one connection may have queued, the one in flight counted (255 behind a stalled one): past it, refused at arrival
function inOrder(c: Client, ws: Ctx["ws"], fn: () => Promise<void>, unanswered?: (r: Any) => void) {
  const n = c.queued ?? 0;
  if (n >= QUEUE_MAX) { const no = { code: "busy", reason: `${n} of your requests are still waiting their turn`, fix: "wait for their replies, then ask again" };
    try { if (unanswered) unanswered({ ok: false, txn: "rolled-back", refused: no }); else ws.send(JSON.stringify({ type: "error", error: `${no.reason}: ${no.fix}` })); } catch { /* gone */ }
    return; }
  c.queued = n + 1;
  const tail = (c.verbQueue ?? Promise.resolve()).then(fn).catch((err) => {
    console.error(`[ws] request from ${c.id} failed server-side:`, err);
    try { if (unanswered) unanswered(txnRefusal({ outcome: "rolled-back" }));
      else ws.send(JSON.stringify({ type: "error", error: "that request failed server-side — it has been logged" })); } catch { /* gone */ }
  });
  c.verbQueue = tail;
  void tail.then(() => { c.queued = (c.queued ?? 1) - 1; if (c.verbQueue === tail) c.verbQueue = undefined; });
}

export const REQUEST_MESSAGES: Record<string, (ctx: Ctx, msg: Any) => void> = {
  ...UPGRADE_MESSAGES,   // world-upgrade-review, world-upgrade: the operator opens a world saved in an older format (server/upgrade.ts)
  "request": ({ c, ws, expel, sweep }, msg) => {
    // {verb, args}: one request to the world's authority
    const w = c.world; if (!w) return;
    const rid = msg.id ?? null;
    const args = msg.args && typeof msg.args === "object" && !Array.isArray(msg.args) ? msg.args : {};
    const verb = String(msg.verb ?? "");
    // the envelope carries the transaction outcome too, as `txn` (spec/PROTOCOL.md §7: committed | rolled-back | ambiguous).
    // Never `outcome`: the body verbs' replies already use that word
    let answered = false;
    const reply = (r: Any) => { answered = true; ws.send(JSON.stringify({ type: "reply", id: rid, verb, ok: r.ok === true, ...(typeof r?.txn === "string" ? { txn: r.txn } : {}), reply: r })); };
    if (c.spectator && !READS.has(verb)) { reply({ ok: false, refused: { code: "spectator", reason: "spectators may read, not write", fix: "join embodied" } }); return; }
    const metered = READS.has(verb) || args.dry === true;
    // reads are counted on arrival, time is checked when each one runs (a queued burst can't all slip in); a meter's
    // refusal reaches the flight recorder like the authority's
    const metered_no = (no: Any) => { if (recordRefusal(c)) w.debug("refused", { who: c.id, verb: verb.slice(0, 32), code: no.code, line: `${c.id}'s ${verb.slice(0, 32)} was refused (${no.code}): ${no.reason}`.slice(0, 300) }); reply({ ok: false, refused: no }); };
    if (metered) { const no = reads.check(c, Date.now()); if (no) { metered_no(no); return; } }
    const mark = metered ? reads.record(c, Date.now()) : null;
    if (verb === "consent") { const gone = goneListing(w, args); if (gone) { reply({ ok: false, refused: gone }); return; } }
    // a caption carries the connection's leg generation, stamped here, so a taken-over leg can't overwrite its successor
    if (verb === "caption") args.gen = c.legGen ?? 0;
    // the request's ONE capability (server/request-capability.ts), frozen at arrival; rechecked when the queue reaches it (seam 1) and
    // before the authority writes (seam 2). The authority gets cap.actorId, never c.actorId read after an await
    let cap: ReqCap;
    try { cap = capture(c, w); } catch (err) { console.error(`[ws] request from ${c.id}:`, err); reply({ ok: false, txn: "rolled-back", refused: { code: "identity", reason: "this connection has no identity here", fix: "join the world first" } }); return; }
    const still = () => recheck(cap);
    inOrder(c, ws, async () => {
      { const gone = still(); if (gone) { reply({ ok: false, txn: "rolled-back", refused: { code: "superseded", reason: gone, fix: recheckFix(gone) } }); return; } }
      // the server's directory and the authority's roles, read in this connection's turn, for a world it is still in
      if (verb === "whois") { reply(whois(w, args)); return; }
      { const no = (metered ? reads.check(c, Date.now(), { timeOnly: true }) : null) ?? busy.check(c, Date.now()); if (no) { metered_no(no); return; } }
      const spent = busy.record(c, Date.now());
      const wasBanned = (verb === "ban" || verb === "unban") && typeof args.who === "string" ? isBanned(w.log.live, String(args.who)) : false;
      const r = await w.log.request(cap.actorId, verb, args, still);
      const ms = (r && typeof r === "object" && authorityTime.get(r)) || 0; if (mark) mark.ms = ms; spent.ms = ms;
      // a guest's sanction is also filed by address, BEFORE the reply: a file that couldn't be written is said in the
      // reply (`warning`) and the moderated line, never swallowed after the ack
      let unsaved: string | null = null;
      // a guest's ban (at most a day) also names their connection's address in this world, or reconnecting would shed it
      if (r?.ok && verb === "ban" && typeof args.who === "string") for (const t of w.clients) if (t.actorId === args.who && t.anonymous && t.addr) {
        const until = Math.min(Date.now() + ADDR_BAN_MS, r.until ?? Infinity);
        serverBans[banKey(null, t.addr, w.name)] = { by: c.id, ts: Date.now(), name: t.id, addr: t.addr, until, world: w.name, who: String(args.who), ...(args.reason ? { reason: String(args.reason) } : {}) };
        unsaved ??= saveServerBans();
      }
      // a guest's mute also names their address here, and its lift lifts that
      if (r?.ok && ["mute", "unmute"].includes(verb) && typeof args.who === "string" && args.who !== cap.actorId)
        unsaved ??= guestSanctionByAddress(w, cap.actorId, c.id, verb, String(args.who), typeof args.reason === "string" ? args.reason : undefined);
      // an unban also lifts the address entry a guest's ban left
      if (r?.ok && verb === "unban" && typeof args.who === "string") unsaved ??= liftGuestAddressBan(w, args.who);
      const lifted = verb.startsWith("un");
      if (unsaved && r && typeof r === "object") r.warning = notPersisted(unsaved, lifted);
      reply(r);
      // the flight recorder (/debug) hears the authority's refusals (the early replies above, e.g. spectator or a consent
      // naming someone gone, aren't recorded); bounded, since a reason can echo what was sent and anyone here
      // reads the ring: lines capped, at most 20 per connection per 10 s
      if (r && !r.ok && r.refused && recordRefusal(c)) { const cap = (x: unknown, n: number) => { const t = String(x ?? ""); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
        const id = typeof args.id === "string" ? cap(args.id, 64) : null;
        w.debug("refused", { who: c.id, verb: cap(verb, 32), ...(id ? { id } : {}), code: cap(r.refused.code, 32),
          line: cap(`${c.id}'s ${verb}${id ? ` ${id}` : ""} was refused (${r.refused.code}): ${r.refused.reason ?? ""}${r.refused.fix ? ` — ${r.refused.fix}` : ""}`, 300) }); }
      // a person-act applies now: the sweep (voice mutes), a warning's notice, a mute told to its person
      if (r?.ok && PERSON_ACTS.has(verb)) { sweep?.(w);
        const who = String(args.who ?? ""); const notice = verb === "warn" ? { type: "warned", by: c.id, reason: String(args.reason ?? "") }
          : verb === "mute" ? { type: "moderated", verb: "mute", by: c.id, you: true, channels: r.channels, until: r.until, ...(args.reason ? { reason: String(args.reason) } : {}) } : null;
        if (notice) for (const t of w.clients) if (t.actorId === who) { try { t.ws.send(JSON.stringify(notice)); } catch { /* gone */ } }
        // a warning is private: its moderator alone is told it went, as the broadcast tells them of a mute or kick
        if (verb === "warn") try { ws.send(JSON.stringify({ type: "moderated", verb, by: c.id, text: modLine(w, c.id, verb, who) })); } catch { /* gone */ } }
      if (r?.ok && (verb === "ban" || verb === "kick" || verb === "unban" || verb === "mute" || verb === "unmute") && typeof args.who === "string") {
        const who = String(args.who);
        const happened = verb === "kick" || verb === "mute" || verb === "unmute" ? [...w.clients].some((t) => t.actorId === who && !t.spectator) : wasBanned !== isBanned(w.log.live, who);
        if (happened) { const said = modLine(w, c.id, verb, who), text = said + (unsaved ? ` (${notPersisted(unsaved, lifted)})` : "");
          // the moderator's own line carries no warning: their reply said it
          for (const t of w.clients) if (t.actorId !== who) { try { t.ws.send(JSON.stringify({ type: "moderated", verb, by: c.id, text: t === c ? said : text })); } catch { /* gone */ } } }
      }
      // a ban or kick the authority accepted takes the person out now; a kicked person may come straight back. A guest's ban
      // also names their connection's address in this world for a day (moderation.ts), or they'd reconnect as a fresh guest.
      if (r?.ok && (verb === "ban" || verb === "kick")) {
        const who = String(args.who);
        for (const t of [...w.clients]) if (t.actorId === who) {
          const back = verb === "kick" ? " — you may come back" : r.until ? ` — you may come back on ${new Date(r.until).toISOString().slice(0, 16).replace("T", " ")} UTC` : "";
          expel(w, t, `you were ${verb === "ban" ? "banned from" : "removed from"} "${w.name}"${args.reason ? ` — ${String(args.reason)}` : ""}${back}`, r.until ?? null);
        }
      }
    }, (r) => { if (!answered) reply(r); });
  },
  // operator-repair {id, verb, args} → {type: "reply", id, verb, ok, operator: true, reply}: a server operator mends the world
  // through the authority. NARROW (set/delete of @world's roles:<id>, access, default-role, role-defs; unban) and RECORDED
  // (operator: true, plus a server log line). Rights are the account's (isOperator); the world's checks still apply.
  "operator-repair": ({ c, ws, sweep }, msg) => {
    const w = c.world; if (!w) return;
    const rid = msg.id ?? null; const verb = String(msg.verb ?? "");
    const args = msg.args && typeof msg.args === "object" && !Array.isArray(msg.args) ? msg.args : {};
    let answered = false;
    const reply = (r: Any) => { answered = true; ws.send(JSON.stringify({ type: "reply", id: rid, verb, ok: r.ok === true, operator: true, ...(typeof r?.txn === "string" ? { txn: r.txn } : {}), reply: r })); };
    if (!isOperator(c.account)) { reply({ ok: false, refused: { code: "rights", reason: "operator-repair needs a server operator's account (SERVER_OPERATORS)", fix: "ask whoever runs this server" } }); return; }   // an owner can't repair what only an operator may (an operator's ban, a shape repair)
    if (!c.actorId) { reply({ ok: false, refused: { code: "identity", reason: "this connection has no identity here", fix: "join the world first" } }); return; }
    // the same one capability as request (server/request-capability.ts), and it must still be an operator's when the queue reaches it:
    // recheck covers isOperator(account) as captured; the only await before the synchronous repair is the queue itself
    const cap = capture(c, w);
    inOrder(c, ws, async () => {
      if (!cap.operator) { reply({ ok: false, txn: "rolled-back", refused: { code: "rights", reason: "operator repair is for this server's operator", fix: "ask whoever runs this server" } }); return; }
      const gone = recheck(cap, Date.now(), { role: false });
      if (gone) { reply({ ok: false, txn: "rolled-back", refused: { code: "superseded", reason: gone, fix: recheckFix(gone) } }); return; }
      const r = w.log.operatorRepair(cap.actorId, verb, args);
      console.log(`[world:${w.name}] operator repair by ${c.account} (${c.id}): ${verb.slice(0, 32)} ${String((args as Any).component ?? (args as Any).who ?? "").slice(0, 64)} → ${r?.ok ? "ok" : r?.refused?.code}`);
      // as request's unban does: the lift's file failure is said in the reply, before it
      const unsaved = r?.ok && verb === "unban" && typeof (args as Any).who === "string" ? liftGuestAddressBan(w, (args as Any).who) : null;
      if (unsaved && r && typeof r === "object") r.warning = notPersisted(unsaved, true);
      reply(r);
      if (r?.ok) sweep?.(w);   // an unban or a role change applies now (the sanctions sweep; the role change re-sends rights itself)
    }, (r) => { if (!answered) reply(r); });
  },
  // Copy the world you're standing in to a new name: a new world (its own identity) whose founding act names this one,
  // holding a copy of its current state. Owner-only (it copies everything here; the owner's call).
  "world-fork": ({ c, ws }, msg) => {
    const w = c.world; if (!w) return;
    const err = (e: string) => ws.send(JSON.stringify({ type: "error", error: e }));
    if (c.spectator) return err("spectators can't copy worlds — join embodied");
    const role = w.log.roleOf(actorOf(c)); if (!isOwner(role)) return err(`copying a world needs its owner — you are a ${role} here`);
    const to = String(msg.to ?? "").slice(0, 64);
    const r = forkWorld(w.log, to, actorOf(c));
    if (!r.ok) return err(r.err);
    console.log(`[world:${w.name}] copied → "${to}" by ${c.id} (${r.things} things, ${r.acts} acts${r.importedRoles ? `, ${r.importedRoles} role(s) held by imported identities an operator may still bind` : ""})`);
    ws.send(JSON.stringify({ type: "world-forked", from: w.name, to }));
  },
  // Found a new, empty world that you own. Any signed-in account, human or agent: a guest has no account to own it.
  "world-found": ({ c, ws }, msg) => {
    const err = (e: string) => ws.send(JSON.stringify({ type: "error", error: e, about: "world-found" }));
    if (!c.world) return err("join a world first");
    if (c.spectator) return err("spectators can't found worlds — join embodied");
    if (c.anonymous || !c.account) return err("founding a world needs a signed-in account (a guest's world would have no one to own it)");
    const name = String(msg.name ?? "").trim().toLowerCase().slice(0, 64);
    const r = foundOwnedWorld(name, actorOf(c), c.account, typeof msg.title === "string" ? msg.title : undefined, worldExists);
    if (!r.ok) return err(r.err);
    console.log(`[world:${name}] founded by ${c.id} (${c.account}) from ${c.world.name}`);
    ws.send(JSON.stringify({ type: "world-founded", name, worldId: r.worldId }));
  },
  // Erase the world you're standing in to zero. Owner-only, and the request must carry the world's own name (the
  // client makes you type it). History is archived beside it, never destroyed; the same owners hold the fresh world.
  "world-reset": ({ c, ws }, msg) => {
    const w = c.world; if (!w) return;
    const err = (e: string) => ws.send(JSON.stringify({ type: "error", error: e }));
    if (c.spectator) return err("spectators can't erase worlds — join embodied");
    const role = w.log.roleOf(actorOf(c)); if (!isOwner(role)) return err(`erasing a world needs its owner — you are a ${role} here`);
    // erasing is the most senior owner's act (the founder, unless they left ownership), never a later co-owner's
    if (w.log.seniorOwner() !== actorOf(c)) return err("erasing a world is for its most senior owner (its founder) — ask them");
    if (String(msg.name ?? "") !== w.name) return err(`confirmation mismatch — reset must name "${w.name}"`);
    let arch: string; try { arch = w.resetWorld(); } catch (e: Any) {
      // where the logs are now, as worldlog.ts resetWorld left them
      if (e?.movedTo) console.error(`[world:${w.name}] reset failed partway: ${e.logMoved ? `no world.jsonl here (moved aside before this reset); the fresh log is in ${e.freshAt}` : "nothing moved: the old log is where it was"}:`, e);
      if (e?.resetDone && e.opened) {   // the fresh world is open: the reset stands, and its scripts (it has none yet) are the operator's to look at
        console.error(`[world:${w.name}] reset by ${c.id}: the fresh world is open, but its scripts didn't start:`, e.cause ?? e); arch = e.resetDone; }
      else if (e?.resetDone) { console.error(`[world:${w.name}] reset by ${c.id}: erased (history archived in ${e.resetDone}), but the fresh log didn't open:`, e.cause ?? e);
        // the loaded World still holds the erased world: drop it from the registry so the next join opens the fresh log
        if (worlds.get(w.name) === w) worlds.delete(w.name);
        w.broadcast({ type: "world-reset", world: w.name, by: c.id });
        return err("the world was erased (its history is archived), but the server couldn't open the fresh world just now: it opens again from disk at the next join, and if that fails too, ask whoever runs this server (what failed is in its log). There is nothing more to erase right now"); }
      // what the world does now, and whether to reset again: world.ts retires a log that was moved aside
      else return err(e?.logMoved
        ? "the reset failed partway: the world's old log was moved aside (the server's log says where), so this world takes no writes until the server's operator puts it back. Resetting again is safe: it finishes the erase, and the old log stays in the archive this attempt made"
        : `the reset failed and the world's log is where it was, so the world goes on as before: ${String(e?.message ?? e)}`); }
    console.log(`[world:${w.name}] ERASED to zero by ${c.id} — history archived in ${arch}`);
    w.broadcast({ type: "world-reset", world: w.name, by: c.id });
  },
};
/** A write from a surface other than `request` (server.ts voice-moderate), on the same path: one capability, inOrder, the
 *  busy meter, seams 1 and 2, cap.actorId. Resolves to the reply; never throws. */
export function requestAs(c: Client, ws: Ctx["ws"], w: World, verb: string, args: Any): Promise<Any> {
  return new Promise((resolve) => {
    let cap: ReqCap;
    try { cap = capture(c, w); } catch (err) { console.error(`[ws] ${verb} from ${c.id}:`, err); resolve({ ok: false, txn: "rolled-back", refused: { code: "identity", reason: "this connection has no identity here", fix: "join the world first" } }); return; }
    inOrder(c, ws, async () => {
      { const gone = recheck(cap); if (gone) { resolve({ ok: false, txn: "rolled-back", refused: { code: "superseded", reason: gone, fix: recheckFix(gone) } }); return; } }
      { const no = busy.check(c, Date.now()); if (no) { resolve({ ok: false, txn: "rolled-back", refused: no }); return; } }
      const spent = busy.record(c, Date.now());
      const r = await w.log.request(cap.actorId, verb, args, () => recheck(cap));
      spent.ms = (r && typeof r === "object" && authorityTime.get(r)) || 0;
      resolve(r);
    }, (r) => resolve(r));
  });
}

export const requestHandler = (type: unknown) => (typeof type === "string" && Object.hasOwn(REQUEST_MESSAGES, type) ? REQUEST_MESSAGES[type] : undefined);
