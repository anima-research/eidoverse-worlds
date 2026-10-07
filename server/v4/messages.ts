// server/v4/messages.ts — the ws messages a v4 world answers differently (slice 2). server.ts consults this table
// first, and ONLY when the client's world is a v4 world (World.v4); every v1 world dispatches exactly as before.
//
//   v4      {type: "v4", id, tool, args} → {type: "v4-result", id, tool, ok, reply}, reply = the door's own answer
//           (kept whole under `reply`: a door reply has fields of its own, such as inspect's `id`). Any door request
//           (create, set, delete, place, batch, use, say, undo, publish, update, grab/put/throw/move/drop/wait, and the
//           reads look/inspect/measure/find/check/history/schema/help). The asker is stamped from the connection
//           (L4), never read from the payload. Spectators may only read.
//   verb    refused (slice 3c): a v4 world takes door requests only. Every client spells its UI's verbs as requests at
//           its own edge (shared/v4/fromv1.js: the page's net.js, the agent's sendVerb), so no v1 verb reaches here.
//   lease, world-fork, world-reset
//           refused: a lease's settlement skipped every gate in v1 (PARITY (c)2), and fork/reset act on v1 files.
//
// Requests from one client run in order: an async warm-up (measuring a model) never lets a later request overtake an
// earlier one (the same per-client queue the v1 verb path uses).
import { forkV4 } from "./world.ts";
import type { Client, World } from "../world.ts";
import { globalBans, saveGlobalBans, banKey, ADDR_BAN_MS } from "../moderation.ts";
import { directoryFor, foldName } from "./directory.ts";
import { WORLDS_DIR } from "../config.ts";
import { isBanned } from "../../shared/v4/door.js";
import { readMeter, doorTime } from "./readmeter.ts";

type Ctx = { c: Client; ws: { send(d: string): void }; now: number; expel: (w: World, target: Client, why: string) => void };
type Any = any;
const READS = new Set(["look", "inspect", "measure", "find", "check", "history", "schema", "help", "wait", "whois"]);
const KIND_WORD: Record<string, string> = { human: "person", agent: "agent", anon: "guest", legacy: "v1 name (no account bound yet)" };

/** whois {name} — a name → identity lookup through the door's directory, scoped to THIS world: the people present now,
 *  and every identity this world's log, roles or moderator log names. Never the whole directory (a name typed here
 *  can't fish for who exists elsewhere on this door), never an account (subs stay in the directory). An id (u-…)
 *  works too. Each match says its role here (the door's), whether it's here now, and whether it's banned. (Commons
 *  audit #1: /role <name> answered by name, so owners read as visitors; an absent person couldn't be banned, and an
 *  agent had no way to find the id a ban needs.) */
export function whois(w: World, args: Any) {
  const q = typeof args?.name === "string" ? args.name.trim() : typeof args?.id === "string" ? args.id.trim() : "";
  if (!q || q.length > 128) return { ok: false, refused: { code: "shape", reason: "whois {name} (or {id: 'u-…'})", teach: "the name someone goes by here, as their nameplate shows it" } };
  const v4 = w.v4!; const dir = directoryFor(WORLDS_DIR);
  const here = new Map<string, string>(); for (const c of w.clients) if (c.v4id && !c.spectator) here.set(c.v4id, c.id);
  const known = new Set<string>([...here.keys(), ...v4.knownIds()]);
  const want = foldName(q);
  if (!want && !/^u-[a-z2-7]{20}$/.test(q)) return { ok: false, refused: { code: "shape", reason: `"${q.slice(0, 40)}" has no letters or digits to look up`, teach: "the name someone goes by here, as their nameplate shows it" } };
  const people = [...known].filter((id) => id === q || (dir.nameOf(id) != null && foldName(dir.nameOf(id)!) === want) || (here.has(id) && foldName(here.get(id)!) === want))
    .map((id) => ({ id, name: here.get(id) ?? dir.nameOf(id) ?? id, kind: KIND_WORD[dir.entry(id)?.kind ?? ""] ?? "unknown", role: v4.roleOf(id), here: here.has(id), banned: isBanned(v4.live, id) }));
  return { ok: true, name: q, people, ...(people.length ? {} : { note: `nobody called "${q}" has been in this world (it only knows people who were here)` }) };
}
const reads = readMeter(); // per connection: reads and dry runs, by count and door time (security pass 2 H-A)
// …and every request by door time: a refused step or write is cheap now, but nothing else bounds how much of the shared
// thread one connection's stream of them takes (a guest is a fresh identity per connection, so the door's per-identity
// rate doesn't either). 3 s of 10 is far past any person's or agent's real use.
const busy = readMeter({ n: Infinity, ms: 3000, window: 10_000 });
const refusalTimes = new WeakMap<Client, number[]>();
/** At most 20 refusal lines per connection per 10 s reach the flight recorder (the rest are the same story). */
function recordRefusal(c: Client): boolean {
  const now = Date.now(); const ts = (refusalTimes.get(c) ?? []).filter((t) => now - t < 10_000);
  if (ts.length >= 20) { refusalTimes.set(c, ts); return false; }
  ts.push(now); refusalTimes.set(c, ts); return true;
}
/** What bystanders are told when the door removes someone: who did it, to whom (names, from the directory). Not the
 *  reason (that went to the person, and stays in the moderator log), not an address, not an account. */
function modLine(w: World, by: string, tool: string, who: string) {
  const name = directoryFor(WORLDS_DIR).nameOf(who) ?? "someone";
  return tool === "ban" ? `${by} banned ${name} from this world` : tool === "kick" ? `${by} removed ${name} from this world` : `${by} lifted the ban on ${name}`;
}
/** The identity the door stamps for this connection: its opaque directory id, set at join (server.ts admitJoin). A
 *  connection without one (it never joined a v4 world) has no identity here: a request from it is a server bug. */
export const actorOf = (c: Client) => { if (!c.v4id) throw new Error(`v4 request from ${c.id} with no directory id (join didn't resolve one)`); return c.v4id; };

/** Run fn after this client's earlier requests (their warm-ups are async); never let a throw break the queue. */
function inOrder(c: Client, ws: Ctx["ws"], fn: () => Promise<void>) {
  const tail = (c.verbQueue ?? Promise.resolve()).then(fn).catch((err) => {
    console.error(`[ws] v4 request from ${c.id} failed server-side:`, err);
    try { ws.send(JSON.stringify({ type: "error", error: "that request failed server-side — it has been logged" })); } catch { /* gone */ }
  });
  c.verbQueue = tail;
  void tail.then(() => { if (c.verbQueue === tail) c.verbQueue = undefined; });
}

const V1_VERB = { code: "v1-verb", reason: "a v4 world takes door requests, not v1 verbs", teach: "send {type: 'v4', id, tool, args}; help lists the tools" };


export const V4_MESSAGES: Record<string, (ctx: Ctx, msg: Any) => void> = {
  "v4": ({ c, ws, expel }, msg) => {
    // {tool, args}: a door request (a v1 `verb` in it is refused: clients spell at their own edge, 3c)
    const w = c.world; if (!w?.v4) return;
    const rid = msg.id ?? null;
    const args = msg.args && typeof msg.args === "object" && !Array.isArray(msg.args) ? msg.args : {};
    const tool = String(msg.tool ?? "");
    const reply = (r: Any) => ws.send(JSON.stringify({ type: "v4-result", id: rid, tool, ok: r.ok === true, reply: r }));
    if (typeof msg.verb === "string") { w.debug("v4-v1-verb", { who: c.id, verb: msg.verb }); reply({ ok: false, refused: V1_VERB }); return; }
    if (c.spectator && !READS.has(tool)) { reply({ ok: false, refused: { code: "spectator", reason: "spectators may read, not write", teach: "join embodied" } }); return; }
    const metered = READS.has(tool) || args.dry === true;
    let mark: { ms: number } | null = null;
    { const no = (metered ? reads.check(c, Date.now()) : null) ?? busy.check(c, Date.now()); if (no) { reply({ ok: false, refused: no }); return; } }
    if (metered) mark = reads.record(c, Date.now());
    const spent = busy.record(c, Date.now());
    if (tool === "whois") { reply(whois(w, args)); return; }   // the server's directory, not the door's world
    inOrder(c, ws, async () => {
      if (c.world !== w) return;
      const wasBanned = (tool === "ban" || tool === "unban") && typeof args.who === "string" ? isBanned(w.v4!.live, String(args.who)) : false;
      const r = await w.v4!.request(actorOf(c), tool, args);
      const ms = (r && typeof r === "object" && doorTime.get(r)) || 0; if (mark) mark.ms = ms; spent.ms = ms;
      reply(r);
      // the flight recorder hears every refusal (world_debug, /debug): the door logs refused WRITES as attempt acts, but
      // a read's, a rate limit's or a ban's refusal went nowhere a person debugging could see (Commons audit, agents #5)
      // Bounded: a refusal's reason can quote what was sent (a shape refusal echoes the bad value), the ring holds 300 and
      // is read by anyone here, so each line is capped and each connection records at most 20 per 10 s (review 10-06 #1)
      if (r && !r.ok && r.refused && recordRefusal(c)) { const cap = (x: unknown, n: number) => { const t = String(x ?? ""); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
        const id = typeof args.id === "string" ? cap(args.id, 64) : null;
        w.debug("refused", { who: c.id, tool: cap(tool, 32), ...(id ? { id } : {}), code: cap(r.refused.code, 32),
          line: cap(`${c.id}'s ${tool}${id ? ` ${id}` : ""} was refused (${r.refused.code}): ${r.refused.reason ?? ""}${r.refused.teach ? ` — ${r.refused.teach}` : ""}`, 300) }); }
      // bystanders see a removal as v1 showed it ("A removed B"), from the server (the moderator log is never a world entry)
      // — only when something happened: a kick that took someone out, a ban or unban that changed whether they're banned
      if (r?.ok && (tool === "ban" || tool === "kick" || tool === "unban") && typeof args.who === "string") {
        const who = String(args.who);
        const happened = tool === "kick" ? [...w.clients].some((t) => t.v4id === who && !t.spectator) : wasBanned !== isBanned(w.v4!.live, who);
        if (happened) { const text = modLine(w, c.id, tool, who);
          for (const t of w.clients) if (t.v4id !== who) { try { t.ws.send(JSON.stringify({ type: "moderated", verb: tool, by: c.id, text })); } catch { /* gone */ } } }
      }
      // a ban or kick the door accepted takes the person out NOW (H4b: a ban used to leave the banned person present,
      // talking and whispering until they chose to leave). A guest has no account to ban, so their ban also names their
      // connection's address in this world for a day (moderation.ts) — or they'd simply reconnect as a fresh guest.
      if (r?.ok && (tool === "ban" || tool === "kick")) {
        const who = String(args.who);
        for (const t of [...w.clients]) if (t.v4id === who) {
          if (tool === "ban" && t.anonymous && t.addr) {
            globalBans[banKey(null, t.addr, w.name)] = { by: c.id, ts: Date.now(), name: t.id, addr: t.addr, until: Date.now() + ADDR_BAN_MS, world: w.name, ...(args.reason ? { reason: String(args.reason) } : {}) };
            saveGlobalBans();
          }
          expel(w, t, `you were ${tool === "ban" ? "banned from" : "removed from"} "${w.name}"${args.reason ? ` — ${String(args.reason)}` : ""}`);
        }
      }
    });
  },
  "verb": ({ c, ws }, msg) => {
    const w = c.world; if (!w?.v4) return;
    w.debug("v4-v1-verb", { who: c.id, verb: String(msg.verb ?? "") });
    ws.send(JSON.stringify({ type: "error", error: `${V1_VERB.reason} (this '${String(msg.verb ?? "")}' wasn't written) — reload the page for the current client` }));
  },
  "lease": ({ ws }) => { ws.send(JSON.stringify({ type: "error", error: "leases aren't part of v4 worlds: carrying is grab/put/throw through the door (L6)" })); },
  // Copy the world you're standing in to a new name: a new world (its own identity) whose founding act names this one,
  // holding a copy of its current state. Owner-only (it copies everything here; the owner's call).
  "world-fork": ({ c, ws }, msg) => {
    const w = c.world; if (!w?.v4) return;
    const err = (e: string) => ws.send(JSON.stringify({ type: "error", error: e }));
    if (c.spectator) return err("spectators can't copy worlds — join embodied");
    const role = w.v4.roleOf(actorOf(c)); if (role !== "owner") return err(`copying a world needs its owner — you are a ${role} here`);
    const to = String(msg.to ?? "").slice(0, 64);
    const r = forkV4(w.v4, to, actorOf(c));
    if (!r.ok) return err(r.err);
    console.log(`[world:${w.name}] copied → "${to}" by ${c.id} (${r.things} things, ${r.acts} acts)`);
    ws.send(JSON.stringify({ type: "world-forked", from: w.name, to }));
  },
  // Erase the world you're standing in to zero. Owner-only, and the request must carry the world's own name (the
  // client makes you type it). History is archived beside it, never destroyed; the same owners hold the fresh world.
  "world-reset": ({ c, ws }, msg) => {
    const w = c.world; if (!w?.v4) return;
    const err = (e: string) => ws.send(JSON.stringify({ type: "error", error: e }));
    if (c.spectator) return err("spectators can't erase worlds — join embodied");
    const role = w.v4.roleOf(actorOf(c)); if (role !== "owner") return err(`erasing a world needs its owner — you are a ${role} here`);
    if (String(msg.name ?? "") !== w.name) return err(`confirmation mismatch — reset must name "${w.name}"`);
    let arch: string; try { arch = w.resetV4(); } catch (e: Any) { return err(`the reset failed and nothing changed: ${String(e?.message ?? e)}`); }
    console.log(`[world:${w.name}] ERASED to zero by ${c.id} — history archived in ${arch}`);
    w.broadcast({ type: "world-reset", world: w.name, by: c.id });
  },
};
export const v4Handler = (type: unknown) => (typeof type === "string" && Object.hasOwn(V4_MESSAGES, type) ? V4_MESSAGES[type] : undefined);
