// server/requestwire.ts — the ws messages that reach a world's authority. server.ts consults this table first.
//
//   request {type: "request", id, verb, args} → {type: "reply", id, verb, ok, reply}, reply = the authority's own answer
//           (kept whole under `reply`: an authority reply has fields of its own, such as inspect's `id`). Any request
//           (create, set, delete, place, batch, use, say, undo, publish, update, grab/put/throw/move/drop/wait, and the
//           reads look/inspect/measure/find/lint/history/schema/help). The asker is stamped from the connection
//           (L4), never read from the payload. Spectators may only read.
//   world-fork, world-reset
//           an owner copies the world to a new name, or erases it to zero (archived, founded again by its owners).
//   world-found
//           a signed-in person founds a new, empty world they own (server/worldlog.ts foundOwnedWorld: caps and names).
//
// Requests from one client run in order: an async warm-up (measuring a model) never lets a later request overtake an
// earlier one.
import { forkWorld, foundOwnedWorld, recheckFix } from "./worldlog.ts";
import { worldExists } from "./world.ts";
import type { Client, World } from "./world.ts";
import { globalBans, saveGlobalBans, banKey, ADDR_BAN_MS, fileAddrSanction, liftAddrSanction } from "./moderation.ts";
import { directoryFor, foldName } from "./directory.ts";
import { WORLDS_DIR } from "./config.ts";
import { isBanned } from "../shared/protocol/authority.js";
import { txnRefusal } from "../shared/protocol/authority/storage.js";
import { WIRE_READS, PERSON_ACTS } from "../shared/protocol/verbclasses.js";
import { METER_SCALE, readMeter, authorityTime } from "./readmeter.ts";
import { isOperator } from "./operators.ts";
import { capture, recheck, type ReqCap } from "./reqcap.ts";
import { isOwner } from "../shared/protocol/roles.js";

type Ctx = { c: Client; ws: { send(d: string): void }; now: number; expel: (w: World, target: Client, why: string, until?: number | null) => void; sweep?: (w: World) => void };
type Any = any;
const READS = WIRE_READS;

/** whois {name} — a name → identity lookup through the authority's directory, scoped to THIS world: the people present now,
 *  and every identity this world's log, roles or moderator log names. Never the whole directory (a name typed here
 *  can't fish for who exists elsewhere on this server), never an account (subs stay in the directory). An id (u-…)
 *  works too. Each match says its role here (the authority's), whether it's here now, and whether it's banned. (Commons
 *  audit #1: /role <name> answered by name, so owners read as visitors; an absent person couldn't be banned, and an
 *  agent had no way to find the id a ban needs.) */
export function whois(w: World, args: Any) {
  const q = typeof args?.name === "string" ? args.name.trim() : typeof args?.id === "string" ? args.id.trim() : "";
  if (!q || q.length > 128) return { ok: false, refused: { code: "shape", reason: "whois {name} (or {id: 'u-…'})", fix: "the name someone goes by here, as their nameplate shows it" } };
  const log = w.log!; const dir = directoryFor(WORLDS_DIR);
  const here = new Map<string, string>(), said = new Map<string, string>();
  for (const c of w.clients) if (c.actorId && !c.spectator) { here.set(c.actorId, c.id); if (c.declares) said.set(c.actorId, c.declares); }
  const known = new Set<string>([...here.keys(), ...log.knownIds()]);
  const want = foldName(q);
  if (!want && !/^u-[a-z2-7]{20}$/.test(q)) return { ok: false, refused: { code: "shape", reason: `"${q.slice(0, 40)}" has no letters or digits to look up`, fix: "the name someone goes by here, as their nameplate shows it" } };
  const people = [...known].filter((id) => id === q || (dir.nameOf(id) != null && foldName(dir.nameOf(id)!) === want) || (here.has(id) && foldName(here.get(id)!) === want))
    .map((id) => { const k = dir.entry(id)?.kind;
      // no kind of participant (§6a rule 3): their own declared word while here, else nothing; the account facts (a guest, an
      // imported name with no account yet) are about the account, never about what holds it
      return { id, name: here.get(id) ?? dir.nameOf(id) ?? id, ...(said.has(id) ? { declares: said.get(id) } : {}), ...(k === "anon" ? { guest: true } : k === "imported" ? { imported: true } : {}), role: log.roleOf(id), here: here.has(id), banned: isBanned(log.live, id) }; });
  return { ok: true, name: q, people, ...(people.length ? {} : { note: `nobody called "${q}" has been in this world (it only knows people who were here)` }) };
}
const reads = readMeter(); // per connection: reads and dry runs, by count and authority time (security pass 2 H-A)
// …and every request by authority time: a refused step or write is cheap now, but nothing else bounds how much of the shared
// thread one connection's stream of them takes (a guest is a fresh identity per connection, so the authority's per-identity
// rate doesn't either). 3 s of 10 is far past any person's or agent's real use.
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
    : verb === "unmute" ? `${by} unmuted ${name}` : `${by} lifted the ban on ${name}`;
}
/** The identity the authority stamps for this connection: its opaque directory id, set at join (server.ts admitJoin). A
 *  connection without one (it never joined a world) has no identity here: a request from it is a server bug. */
/** The presence message a
 *  muted person doesn't send (a caption is a speech bubble). Applied by server.ts before any handler runs (review 10-07). */
const QUIET = new Set(["typing", "anim", "puppet", "bodydrag", "drag", "caption"]);
export function gagged(c: Client, type: string): boolean {
  const w = c.world; if (!w?.log || !c.actorId || !QUIET.has(type)) return false;
  return type === "caption" && !!w.log.mutedHere(c.actorId);
}
/** A guest has no account: a fresh connection is a fresh identity, so a mute on one would be shed by
 *  reconnecting (R 10-07). When a mute lands on a guest present here, it is also filed against their
 *  connection's hashed address in this world (moderation.ts: at most a day, never past its own end), and server.ts gives
 *  it to every new guest from that address at join. Lifting one (unmute) lifts that record. A signed-in
 *  person's identity already carries; nothing is filed for them. `verb` is the authority's act; `actor` the identity that did it. */
export function guestSanctionByAddress(w: World, actor: string, by: string, verb: string, who: string, reason?: string) {
  const kind = verb === "mute" || verb === "unmute" ? "mute" : null;
  if (!kind || !w.log) return;
  const addrs = [...new Set([...w.clients].filter((t) => t.actorId === who && t.anonymous && t.addr).map((t) => t.addr as string))];
  if (verb.startsWith("un")) { liftAddrSanction(kind, w.name, who, addrs[0]); return; }
  const now = w.log.mutedHere(who);   // in force now (every channel muted)
  if (!now) return;
  for (const addr of addrs) fileAddrSanction({ kind, world: w.name, addr, actor, by, who, until: now.until ?? null,
    ...(kind === "mute" ? { channels: now.channels } : {}), ...(reason ? { reason: reason.slice(0, 280) } : {}) });
}
export const actorOf = (c: Client) => { if (!c.actorId) throw new Error(`request from ${c.id} with no directory id (join didn't resolve one)`); return c.actorId; };

/** Run fn after this client's earlier requests (their warm-ups are async); never let a throw break the queue. A throw that
 *  escapes before the request was answered is answered with the request's own id (`unanswered`), never an id-less error:
 *  a client never leaves a request pending. WorldLog.request never throws (its outcome rides its reply), so such a throw
 *  happened before the authority was reached: nothing was written (rolled back, code server-error). */
function inOrder(c: Client, ws: Ctx["ws"], fn: () => Promise<void>, unanswered?: (r: Any) => void) {
  const tail = (c.verbQueue ?? Promise.resolve()).then(fn).catch((err) => {
    console.error(`[ws] request from ${c.id} failed server-side:`, err);
    try { if (unanswered) unanswered(txnRefusal({ outcome: "rolled-back" }));
      else ws.send(JSON.stringify({ type: "error", error: "that request failed server-side — it has been logged" })); } catch { /* gone */ }
  });
  c.verbQueue = tail;
  void tail.then(() => { if (c.verbQueue === tail) c.verbQueue = undefined; });
}

const FORK_GAP_MS = 60_000, FORK_PER_HOUR = 5;
const forkAt = new Map<string, number>(), forksBy = new Map<string, number[]>();
export const REQUEST_MESSAGES: Record<string, (ctx: Ctx, msg: Any) => void> = {
  "request": ({ c, ws, expel, sweep }, msg) => {
    // {verb, args}: one request to the world's authority
    const w = c.world; if (!w) return;
    const rid = msg.id ?? null;
    const args = msg.args && typeof msg.args === "object" && !Array.isArray(msg.args) ? msg.args : {};
    const verb = String(msg.verb ?? "");
    // the envelope carries the transaction outcome too, as `txn` (PROTOCOL §7: committed | rolled-back | ambiguous; ok only
    // when committed). Never `outcome`: the body verbs' replies already use that word for asked | allowed
    let answered = false;
    const reply = (r: Any) => { answered = true; ws.send(JSON.stringify({ type: "reply", id: rid, verb, ok: r.ok === true, ...(typeof r?.txn === "string" ? { txn: r.txn } : {}), reply: r })); };
    if (c.spectator && !READS.has(verb)) { reply({ ok: false, refused: { code: "spectator", reason: "spectators may read, not write", fix: "join embodied" } }); return; }
    const metered = READS.has(verb) || args.dry === true;
    // reads are counted as they arrive (a burst is counted before any of it runs); time is checked when each request is
    // about to run, so requests queued behind a slow one can't all be admitted before the meter sees what they cost
    // a meter's refusal reaches the flight recorder like the authority's (bounded the same way)
    const metered_no = (no: Any) => { if (recordRefusal(c)) w.debug("refused", { who: c.id, verb: verb.slice(0, 32), code: no.code, line: `${c.id}'s ${verb.slice(0, 32)} was refused (${no.code}): ${no.reason}`.slice(0, 300) }); reply({ ok: false, refused: no }); };
    if (metered) { const no = reads.check(c, Date.now()); if (no) { metered_no(no); return; } }
    const mark = metered ? reads.record(c, Date.now()) : null;
    if (verb === "whois") { reply(whois(w, args)); return; }   // the server's directory, not the authority's world
    // a caption carries the connection's leg generation, stamped here (never the client's word): a captioner that was
    // taken over (a newer leg of the same identity) can't write over its successor (shared/captions.js captionRefusal)
    if (verb === "caption") args.gen = c.legGen ?? 0;
    // the request's ONE capability (server/reqcap.ts), frozen as the connection was when the request arrived: identity,
    // account, spectator, operator, the door's decision, role, leg. Rechecked when the queue reaches it (seam 1) and again
    // after warm(), immediately before the authority writes (seam 2, worldlog.ts request); the authority is given
    // cap.actorId, never the connection's actorId read after an await (reviewer item 2; review of PR #260, requestwire.ts:135)
    let cap: ReqCap;
    try { cap = capture(c, w); } catch (err) { console.error(`[ws] request from ${c.id}:`, err); reply({ ok: false, txn: "rolled-back", refused: { code: "identity", reason: "this connection has no identity here", fix: "join the world first" } }); return; }
    const still = () => recheck(cap);
    inOrder(c, ws, async () => {
      { const gone = still(); if (gone) { reply({ ok: false, txn: "rolled-back", refused: { code: "superseded", reason: gone, fix: recheckFix(gone) } }); return; } }
      { const no = (metered ? reads.check(c, Date.now(), { timeOnly: true }) : null) ?? busy.check(c, Date.now()); if (no) { metered_no(no); return; } }
      const spent = busy.record(c, Date.now());
      const wasBanned = (verb === "ban" || verb === "unban") && typeof args.who === "string" ? isBanned(w.log.live, String(args.who)) : false;
      const r = await w.log.request(cap.actorId, verb, args, still);
      const ms = (r && typeof r === "object" && authorityTime.get(r)) || 0; if (mark) mark.ms = ms; spent.ms = ms;
      reply(r);
      // the flight recorder hears every refusal (world_debug, /debug): the authority logs refused WRITES as attempt acts, but
      // a read's, a rate limit's or a ban's refusal went nowhere a person debugging could see (Commons audit, agents #5)
      // Bounded: a refusal's reason can quote what was sent (a shape refusal echoes the bad value), the ring holds 300 and
      // is read by anyone here, so each line is capped and each connection records at most 20 per 10 s (review 10-06 #1)
      if (r && !r.ok && r.refused && recordRefusal(c)) { const cap = (x: unknown, n: number) => { const t = String(x ?? ""); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
        const id = typeof args.id === "string" ? cap(args.id, 64) : null;
        w.debug("refused", { who: c.id, verb: cap(verb, 32), ...(id ? { id } : {}), code: cap(r.refused.code, 32),
          line: cap(`${c.id}'s ${verb}${id ? ` ${id}` : ""} was refused (${r.refused.code}): ${r.refused.reason ?? ""}${r.refused.fix ? ` — ${r.refused.fix}` : ""}`, 300) }); }
      // bystanders see a removal ("A removed B"), from the server (the moderator log is never a world entry)
      // — only when something happened: a kick that took someone out, a ban or unban that changed whether they're banned
      // a person-act applies now: voice mutes take effect at once (the sweep), a warning reaches its person as a
      // notice they dismiss, a mute is told to its person
      if (r?.ok && PERSON_ACTS.has(verb)) { sweep?.(w);
        const who = String(args.who ?? ""); const notice = verb === "warn" ? { type: "warned", by: c.id, reason: String(args.reason ?? "") }
          : verb === "mute" ? { type: "moderated", verb: "mute", by: c.id, you: true, channels: r.channels, until: r.until, ...(args.reason ? { reason: String(args.reason) } : {}) } : null;
        if (notice) for (const t of w.clients) if (t.actorId === who) { try { t.ws.send(JSON.stringify(notice)); } catch { /* gone */ } } }
      // a guest's mute also names their address here, and its lift lifts that (R 10-07)
      if (r?.ok && ["mute", "unmute"].includes(verb) && typeof args.who === "string" && args.who !== cap.actorId)
        guestSanctionByAddress(w, cap.actorId, c.id, verb, String(args.who), typeof args.reason === "string" ? args.reason : undefined);
      if (r?.ok && (verb === "ban" || verb === "kick" || verb === "unban" || verb === "mute" || verb === "unmute") && typeof args.who === "string") {
        const who = String(args.who);
        const happened = verb === "kick" || verb === "mute" || verb === "unmute" ? [...w.clients].some((t) => t.actorId === who && !t.spectator) : wasBanned !== isBanned(w.log.live, who);
        if (happened) { const text = modLine(w, c.id, verb, who);
          for (const t of w.clients) if (t.actorId !== who) { try { t.ws.send(JSON.stringify({ type: "moderated", verb, by: c.id, text })); } catch { /* gone */ } } }
      }
      // an unban (or the end of a kick, lifted) also lifts the address entry a guest's ban or kick left
      if (r?.ok && verb === "unban" && typeof args.who === "string") { let n = 0;
        for (const [k, e] of Object.entries(globalBans)) if ((e as Any)?.who === args.who && (e as Any)?.world === w.name) { delete globalBans[k]; n++; }
        if (n) saveGlobalBans(); }
      // a ban or kick the authority accepted takes the person out NOW (H4b: a ban used to leave the banned person present,
      // talking until they chose to leave). A guest has no account to ban, so their ban also names their
      // connection's address in this world for a day (moderation.ts) — or they'd simply reconnect as a fresh guest.
      if (r?.ok && (verb === "ban" || verb === "kick")) {
        const who = String(args.who);
        for (const t of [...w.clients]) if (t.actorId === who) {
          // a guest has no account: a fresh connection is a fresh identity, so its ban (at most a day) and its kick's cooldown
          // also name its connection's address in this world, or reconnecting would shed them (review 10-07)
          if (t.anonymous && t.addr) {
            const until = Math.min(Date.now() + ADDR_BAN_MS, r.until ?? Infinity);
            globalBans[banKey(null, t.addr, w.name)] = { by: c.id, ts: Date.now(), name: t.id, addr: t.addr, until, world: w.name, who, ...(args.reason ? { reason: String(args.reason) } : {}) };
            saveGlobalBans();
          }
          const back = r.until ? ` — you may come back ${verb === "kick" ? `in ${Math.max(1, Math.round((r.until - Date.now()) / 60000))} min` : `on ${new Date(r.until).toISOString().slice(0, 16).replace("T", " ")} UTC`}` : "";
          expel(w, t, `you were ${verb === "ban" ? "banned from" : "removed from"} "${w.name}"${args.reason ? ` — ${String(args.reason)}` : ""}${back}`, r.until ?? null);
        }
      }
    }, (r) => { if (!answered) reply(r); });
  },
  // operator-repair {id, verb, args} → {type: "reply", id, verb, ok, operator: true, reply}: a WORLD_ADMIN account mends the
  // world it is in, through the authority (review of PR #260, server.ts:742: an operator entered every world but could repair
  // nothing in it). NARROW — set/delete of @world's roles:<id>, access, default-role, role-defs, and unban (a ban or a kick)
  // — and RECORDED: the operator's own identity's act, its body operator: true (an unban's moderator-log record likewise),
  // and a server log line naming the account. Its rights are the account's (isOperator), checked here and never read from
  // the payload; the world's own rights don't gate it, its shape/value/roles/last-owner checks still do.
  "operator-repair": ({ c, ws, sweep }, msg) => {
    const w = c.world; if (!w) return;
    const rid = msg.id ?? null; const verb = String(msg.verb ?? "");
    const args = msg.args && typeof msg.args === "object" && !Array.isArray(msg.args) ? msg.args : {};
    let answered = false;
    const reply = (r: Any) => { answered = true; ws.send(JSON.stringify({ type: "reply", id: rid, verb, ok: r.ok === true, operator: true, ...(typeof r?.txn === "string" ? { txn: r.txn } : {}), reply: r })); };
    if (!isOperator(c.account)) { reply({ ok: false, refused: { code: "rights", reason: "operator-repair needs a server operator's account (WORLD_ADMIN)", fix: "ask whoever runs this server" } }); return; }   // an owner can't repair what only an operator may (an operator's ban, a shape repair)
    if (!c.actorId) { reply({ ok: false, refused: { code: "identity", reason: "this connection has no identity here", fix: "join the world first" } }); return; }
    // the same one capability as request (server/reqcap.ts), and it must still be an operator's when the queue reaches it:
    // recheck covers isOperator(account) as captured; the only await before the synchronous repair is the queue itself
    const cap = capture(c, w);
    inOrder(c, ws, async () => {
      if (!cap.operator) { reply({ ok: false, txn: "rolled-back", refused: { code: "rights", reason: "operator repair is for this server's operator", fix: "ask whoever runs this server" } }); return; }
      const gone = recheck(cap, Date.now(), { role: false });
      if (gone) { reply({ ok: false, txn: "rolled-back", refused: { code: "superseded", reason: gone, fix: recheckFix(gone) } }); return; }
      const r = w.log.operatorRepair(cap.actorId, verb, args);
      console.log(`[world:${w.name}] operator repair by ${c.account} (${c.id}): ${verb.slice(0, 32)} ${String((args as Any).component ?? (args as Any).who ?? "").slice(0, 64)} → ${r?.ok ? "ok" : r?.refused?.code}`);
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
    // a fork copies the whole world synchronously on the shared thread (review 10-06): one at a time per world, and at
    // most FORK_PER_HOUR per person, so no owner can stall every world on the authority by forking in a loop
    const now = Date.now(), last = forkAt.get(w.name) ?? 0, mine = (forksBy.get(actorOf(c)) ?? []).filter((t) => now - t < 3600_000);
    if (now - last < FORK_GAP_MS) return err(`this world was copied ${Math.round((now - last) / 1000)} s ago — try again in a minute`);
    if (mine.length >= FORK_PER_HOUR) return err(`you've copied worlds ${mine.length} times in the last hour (at most ${FORK_PER_HOUR})`);
    const to = String(msg.to ?? "").slice(0, 64);
    const r = forkWorld(w.log, to, actorOf(c));
    if (!r.ok) return err(r.err);
    forkAt.set(w.name, now); forksBy.set(actorOf(c), [...mine, now]);   // only a fork that happened counts
    console.log(`[world:${w.name}] copied → "${to}" by ${c.id} (${r.things} things, ${r.acts} acts)`);
    ws.send(JSON.stringify({ type: "world-forked", from: w.name, to }));
  },
  // Found a new, empty world that you own (ship list 10-07). A signed-in person only: a guest has no account to hold it
  // and an agent's account doesn't found here (an operator founds for an agent); caps and the name rule in foundOwnedWorld.
  "world-found": ({ c, ws }, msg) => {
    const err = (e: string) => ws.send(JSON.stringify({ type: "error", error: e, about: "world-found" }));
    if (!c.world) return err("join a world first");
    if (c.spectator) return err("spectators can't found worlds — join embodied");
    if (c.anonymous || !c.account) return err("founding a world needs a signed-in account (a guest's world would have no one to own it)");
    if (/^(agent|aid1):/.test(c.account)) return err("an agent's account doesn't found worlds here — the server's operator can found one for it");
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
    // erasing is the most senior owner's act (the founder, unless they left ownership): a co-owner made later can't wipe
    // the world from under the people who made it (review 10-06; research: delete/reset is never a switch)
    if (w.log.seniorOwner() !== actorOf(c)) return err("erasing a world is for its most senior owner (its founder) — ask them");
    if (String(msg.name ?? "") !== w.name) return err(`confirmation mismatch — reset must name "${w.name}"`);
    let arch: string; try { arch = w.resetWorld(); } catch (e: Any) {
      if (e?.movedTo) console.error(`[world:${w.name}] reset failed partway: old log in ${e.movedTo}, new one in ${e.freshAt}:`, e);
      if (e?.resetDone) { console.error(`[world:${w.name}] reset by ${c.id}: erased (history archived in ${e.resetDone}), but reopening it failed:`, e.cause ?? e);
        return err("the world was erased (its history is archived), but the server couldn't reopen it: the server's operator can restart it, and its server log says what failed"); }
      return err(e?.movedTo ? "the reset failed partway: the world's old log was moved aside, and the server's operator can put it back (its server log says where)" : `the reset failed and nothing changed: ${String(e?.message ?? e)}`); }
    console.log(`[world:${w.name}] ERASED to zero by ${c.id} — history archived in ${arch}`);
    w.broadcast({ type: "world-reset", world: w.name, by: c.id });
  },
};
/** A write from a surface that isn't the `request` message (server.ts voice-moderate: the voice control's mute/unmute).
 *  Review r14 M1 (10-18): it called w.log.request with the connection's actorId read at send time, outside the queue, the meters
 *  and the capability. Now the same path as `request`: ONE capability captured now (server/reqcap.ts), the same per-connection
 *  queue (inOrder), the busy meter, recheck when the queue reaches it (seam 1) and again before the write (seam 2, the `still`
 *  WorldLog.request calls); the authority is given cap.actorId. Resolves to the reply; never throws (a throw before the
 *  authority is a rolled-back server-error, as for `request`). */
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
