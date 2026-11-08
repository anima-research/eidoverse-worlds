// eidoverse-worlds sequencer — WORLD ACCESS: who may come in, decided by the world (upstream #258 / #259,
// docs/DESIGN-world-access.md; ported to this protocol 2026-10-17).
//
// Upstream wrote access as the bottom rungs of its `grant` ladder (`none`, `spectator`). Here the facts are the world's own
// components, read by one pure function both the server and the client import (shared/protocol/access.js):
//   @world.access {join: anyone|signed-in|listed, watch?: "anyone", max?, soft?, minAccountDays?}
//   @world.default-role, roles:<id> {role, …, until?}
// This module is the one place every DOOR asks:
//   entryFor      — the decision for a connection or an HTTP caller: bans → kick → operator / moderation powers →
//                   the world's access (shared entryOf) → account age → capacity (embodied joins only)
//   httpCaller    — who is asking over HTTP (cookie session, or a bearer the door takes)
//   doorFor       — a world's door, read from disk when the world isn't loaded (a /worlds listing never loads one)
//   settleAccess  — after roles or access change: remove whoever may no longer stay (4010)
//   sweepAccess   — timed grants: warn five minutes out, then the authority writes the end (expire-roles) and settle
// It never imports server.ts: the session's expel is injected by the caller.
//
// Not ported from upstream (and why): a FOUNDING CAP (joining never founds a world here; founding is `world-found`, with no
// engine quota); the directory SEARCH of everyone who has signed in (this
// server's whois is scoped to a world's own people: a roster of sign-ins isn't an owner's to browse); `grant <name>
// spectator` for ONE person (a role is membership here, never a state: a world that admits only people listed lets
// everyone else watch with access.watch, or no one).

import { WORLDS_DIR, JOIN_TOKEN } from "./config.ts";
import { serverBans, findBan, doorLocked, LOCKED_WHY } from "./moderation.ts";
import { isOperator } from "./operators.ts";
import { sessionOfRequest, accountOf } from "./auth.ts";
import { directoryFor } from "./directory.ts";
import { accountAgeRefusal } from "./accountage.ts";
import { effectiveOf, isOwner, MOD_POWERS } from "../shared/protocol/roles.js";
import { isBanned } from "../shared/protocol/authority.js";
import { addressOf } from "./peer.ts";
import { entryOf, doorOf as doorOfWc, listedIn, timedGrants, leftWords, ACCESS_WARN_MS } from "../shared/protocol/access.js";
import { type World, type Client } from "./world.ts";
import { type OldWorld } from "./oldworlds.ts";
import { lookup, ownerIn, type IndexEntry } from "./worldindex.ts";

/** Close code for "this world is not open to you": refused at the door, or removed because access ended or changed.
 *  Clients don't redial it (4006 is moderation's, 4005 a bad link). */
export const ACCESS_CLOSE = 4010;
/** Close code for "there is nothing here YET": a spectator of a world nobody has founded. Not a refusal: clients redial
 *  it with their usual backoff, so an observer started early joins once the world exists. */
export const NOT_YET_CLOSE = 4011;
/** The one refusal for a world that doesn't exist and one this principal may not discover: the same bytes for both (no
 *  existence oracle, docs/DESIGN-log-vocabulary.md §F F-3). */
export const unavailable = (name: string) => ({ code: "world-unavailable", message: `No accessible world named ${name}.` });
/** Its close code, by what the joiner asked for (never by what exists): a watcher redials (an observer started before a
 *  founding gets in once the world exists), a body doesn't. */
export const unavailableClose = (watching: boolean) => (watching ? NOT_YET_CLOSE : 4005);

/** An identity as the door sees it. `account`: the account a credential proved (null = a guest); `actorId`: the world's
 *  opaque id for it (server/directory.ts); `trustedRenderer`: the renderers' credential (may watch anywhere, never
 *  embody); `addr`: a guest's hashed address (bans name it). */
export type Who = { account: string | null; actorId?: string | null; trustedRenderer?: boolean; addr?: string | null };
/** `mod`: an unloaded world's moderator log, read from disk with its door (a loaded world's own log is the truth). */
export type Door = { name: string; wc: Record<string, any>; label: string; world?: World; mod?: any[] };
export type EntryMode = "embody" | "watch";
export type Refusal = { code: number; reason: "banned" | "no-access" | "full" | "age" | "locked"; why: string; until?: number };

const wcOfWorld = (w: World): Record<string, any> => (w.log?.live?.state?.().entities?.["@world"]?.c ?? {}) as Record<string, any>;

/** The door of a LOADED world. */
export function doorOfWorld(w: World): Door { const wc = wcOfWorld(w); return { name: w.name, wc, label: doorOfWc(wc), world: w }; }
/** open | public | signed-in | watch | invite-only — the label a listing shows. */
export function doorOf(w: World): string { return doorOfWc(wcOfWorld(w)); }

// ---- a world's door, without loading the world ----------------------------------------------------------------------
// Listing and HTTP reads must answer "may this caller see world X?" for worlds nobody is in. Loading them would do it,
// but a loaded world is never unloaded, so a /worlds call would pull every world on disk into memory for good. Instead the
// door is read off the access index (worldindex.ts: @world's door components and the moderator log, read from disk when
// they change, never because of who asks).
/** Set by server.ts: the loaded worlds (a loaded world's own fold is the truth). */
let loadedWorlds: () => Map<string, World> = () => new Map();
export function setLoadedWorlds(fn: () => Map<string, World>) { loadedWorlds = fn; }
const doorOfEntry = (name: string, e: IndexEntry): Door | null => (e.kind === "saved" && e.door ? { name, wc: e.door.wc, label: doorOfWc(e.door.wc), mod: e.door.mod } : null);

/** A world's door by name: the loaded world's, else the index's; null when there is no such saved world (missing, mid-swap,
 *  an old format, or a moderator log that can't be read). Every name makes the same index lookup. */
export function doorFor(name: string): Door | null {
  if (!/^[a-z0-9_-]{1,64}$/i.test(name)) return null;
  const live = loadedWorlds().get(name), e = lookup(name, { loaded: !!live });
  return live ? doorOfWorld(live) : doorOfEntry(name, e);
}

/** Who goes past this door whatever it says: operators, and owners and holders of a moderation power (what @world.access
 *  always said). The one reading for entryFor and discoverable. The bypass is for people this world LISTS (an explicit role
 *  row): a power handed to everyone through default-role or role-defs must not open an invite-only door (final review M1,
 *  10-18); an ended timed grant is absent at `now` (security review 10-18 M6): the door reads it as not listed, loaded or not,
 *  before the authority's sweep writes its end (expire-roles), so an unloaded world's HTTP reads and a join don't honour it
 *  indefinitely. */
function bypassOf(wc: Record<string, any>, account: string | null, actorId: string | null, now: number): { listed: boolean; bypass: boolean } {
  const eff = actorId ? effectiveOf(wc, actorId, { anon: !account }) : null;
  const listed = !!actorId && listedIn(wc, actorId, now);
  return { listed, bypass: isOperator(account) || (listed && (isOwner(eff) || MOD_POWERS.some((p: string) => eff?.permissions?.includes(p)))) };
}

/** May `who` be in this world — with a body, or watching? null = yes; else the refusal (code, reason, words).
 *  `here` (embodied joins only): how many bodies are in the world now, for access.max. */
export function entryFor(door: Door, who: Who, mode: EntryMode, { now = Date.now(), here = null as number | null } = {}): Refusal | null {
  const { account, actorId, addr } = who;
  // exclusion outranks everything but the operator: a server ban closes every door, a world's ban this one. Watching
  // counts — a ban is exclusion, not just silencing
  if (!isOperator(account)) {
    // the world's own moderator log: the loaded world's, else the one read from disk with its door (same views, at `now`)
    const off = !door.world && door.mod ? { mod: door.mod, now: () => now } : null;
    const bannedHere = (id: string) => door.world ? !!door.world.log?.bannedHere(id) : !!off && isBanned(off, id);
    const gb = findBan(serverBans, account, addr);
    const ban = gb ?? findBan(serverBans, account, addr, now, door.name) ?? (actorId && bannedHere(actorId) ? { by: "a moderator" } as any : null);
    if (ban) return { code: 4006, reason: "banned", why: `you are banned from ${gb ? "these worlds" : `"${door.name}"`}${ban.reason ? ` — ${ban.reason}` : ""}` };
  }
  const { listed, bypass } = bypassOf(door.wc, account, actorId ?? null, now);
  // a ban file the server couldn't read: the door is locked to everyone it doesn't know (moderation.ts doorLocked); the renderer holds the operator's own key and never embodies
  if (doorLocked() && !isOperator(account) && !listed && !who.trustedRenderer) return { code: ACCESS_CLOSE, reason: "locked", why: LOCKED_WHY };
  const e = entryOf(door.wc, { actor: actorId ?? undefined, anon: !account, bypass, trustedRenderer: !!who.trustedRenderer }, door.name, now);
  if (e.may === "none" || (mode === "embody" && e.may === "watch")) return { code: ACCESS_CLOSE, reason: "no-access", why: e.why ?? `"${door.name}" isn't open to you` };
  if (bypass) return null;
  const acc = door.wc.access && typeof door.wc.access === "object" ? door.wc.access : null;
  // a trusted renderer has no account and never embodies: the door let it watch above, and the account-age rule is about
  // accounts (review of #260, server I52)
  const age = acc && !who.trustedRenderer ? accountAgeRefusal({ world: door.name, minDays: acc.minAccountDays, account, anonymous: !account, now }) : null;
  if (age && !(mode === "watch" && acc?.watch === "anyone")) return { code: ACCESS_CLOSE, reason: "age", why: age };
  // "full" is transient (someone leaves): its own close (4005 "full"), which clients wait out and try again
  if (mode === "embody" && here != null && acc && Number.isInteger(acc.max) && here >= acc.max) return { code: 4005, reason: "full", why: `"${door.name}" is full (${acc.max} at once)` };
  return null;
}

/** May `who` learn that this world exists: its door shows itself to them (public or listed to them, a grant, a power that
 *  bypasses the door). The one predicate behind /worlds, the join, /access and redial; anything else is `unavailable`. */
export function discoverable(door: Door | null, who: Who | null, now = Date.now()): boolean {
  if (!door) return false;
  const { account = null, actorId = null } = who ?? {};
  if (isOperator(account)) return true;
  const { bypass } = bypassOf(door.wc, account, actorId, now);
  return entryOf(door.wc, { actor: actorId ?? undefined, anon: !account, bypass, trustedRenderer: !!who?.trustedRenderer }, door.name, now).may !== "none";
}
// ---- what a name is to someone (§F F-3: no existence oracle; Mica 11-05, #23 rulings 4 and "timing oracle") ----
/** What `who` may be told about `name`: `door` (a saved world discoverable to them), `interrupted` (an in-place conversion
 *  stopped mid-swap) or `old` (saved in an older format), else `unavailable`, what a missing world gets. Decided from the
 *  access index (worldindex.ts lookup: the same calls for every name, no world opened): the two diagnoses go only to the
 *  operator and, for an old world, its recognised owner (worldindex.ts ownerIn, from the owners the entry holds: no log
 *  read, no CLI). Anyone else gets `unavailable` from the same lookup, as a missing name does. `proven` is the account a
 *  credential proved (upgrade.ts provenWho), never a typed name. A Promise only while an old world's owners are still being
 *  read (it appeared or changed a moment ago). */
export type Told = { kind: "door"; door: Door } | { kind: "unavailable" } | { kind: "interrupted" }
  | { kind: "old"; old: OldWorld; operator: boolean; owner: "bound" | "name" | null; ownerName?: string };
export function toldOf(name: string, who: Who | null, proven: { account: string; name: string } | null = null): Told | Promise<Told> {
  const no: Told = { kind: "unavailable" };
  if (!/^[a-z0-9_-]{1,64}$/i.test(name)) return no;
  const live = loadedWorlds().get(name), e = lookup(name, { loaded: !!live });   // the one index read, whatever the name is
  const operator = isOperator(proven?.account ?? null);
  const door = live ? doorOfWorld(live) : doorOfEntry(name, e);
  if (door) return discoverable(door, who) ? { kind: "door", door } : no;
  if (e.kind === "interrupted") return operator ? { kind: "interrupted" } : no;
  if (e.kind !== "old") return no;
  if (operator) return { kind: "old", old: e.old, operator, owner: null };
  const old = e.old;
  const asOwner = (): Told => { const o = ownerIn(e, proven); return o?.recognised ? { kind: "old", old, operator, owner: o.recognised, ownerName: o.owner } : no; };
  // its owners still being read (the world appeared or changed a moment ago): a signed-in asker waits for them
  return e.ready && proven ? e.ready.then(asOwner, () => no) : asOwner();
}
/** May `who` at least watch this world (it is on their map, its reads answer)? */
export function visibleTo(door: Door | null, who: Who | null, now = Date.now()): boolean {
  return discoverable(door, who, now) && entryFor(door!, who ?? { account: null }, "watch", { now }) === null;
}
/** What `who` may do at this door: enter | watch | none, with the refusal's words. */
export function youAt(door: Door, who: Who | null): { you: "enter" | "watch" | "none"; why?: string } {
  const embody = entryFor(door, who ?? { account: null }, "embody");
  if (!embody || embody.reason === "full") return { you: "enter" };
  const watch = entryFor(door, who ?? { account: null }, "watch");
  return { you: watch ? "none" : "watch", why: embody.why };
}

/** Who is asking, over HTTP: the session cookie the join takes (auth.ts sessionOfRequest), or an `Authorization: Bearer` credential the
 *  join door takes (an enrolled agent's bearer, an aid1 agent credential). Null = anonymous (a JOIN_TOKEN bearer proves
 *  the door key, not who). Never the URL: credentials in query strings end up in logs. The cookie wins here; the join and
 *  setup take an explicit credential over it — either way one the sender holds (#260 bot 4). */
export function httpCaller(req: Request): Who | null {
  const s = sessionOfRequest(req);
  if (s && (s.scopes.includes("worlds:join") || s.scopes.includes("worlds:spectate"))) return whoAccount(s.sub);   // one sign-in, every world (main #255: a session's old nativeWorld no longer narrows it)
  return bearerCaller(req) ?? null;
}
/** The account and credential name an HTTP caller proves (httpCaller's, with the name an old world's owner check reads). */
export function httpProven(req: Request): { account: string; name: string } | null {
  const s = sessionOfRequest(req);
  if (s && (s.scopes.includes("worlds:join") || s.scopes.includes("worlds:spectate"))) return { account: s.sub, name: s.name ?? "" };
  if (!/^Bearer\b/i.test(req.headers.get("authorization") ?? "")) return null;
  const tok = bearerOf(req); if (!tok || (JOIN_TOKEN && tok === JOIN_TOKEN)) return null;
  const a = accountOf(tok); return a && "account" in a ? { account: a.account, name: a.name } : null;
}
/** Who an `Authorization: Bearer` proves, ignoring any cookie: undefined when none is sent, null when it proves nobody. */
export function bearerCaller(req: Request): Who | null | undefined {
  if (!/^Bearer\b/i.test(req.headers.get("authorization") ?? "")) return undefined;
  const tok = bearerOf(req);
  if (!tok || (JOIN_TOKEN && tok === JOIN_TOKEN)) return null;
  const a = accountOf(tok);
  return a && "account" in a ? whoAccount(a.account) : null;
}
/** The token an `Authorization: Bearer <token>` header carries (RFC 6750; the scheme in any case), else "". */
export const bearerOf = (req: Request): string => /^Bearer\s+(\S+)$/i.exec(req.headers.get("authorization") ?? "")?.[1] ?? "";
/** A request's hashed address (never kept raw), as a guest's ban names it: the upgrade and the HTTP reads hash alike. */
export const hashedAddress = (req: Request, srv?: Parameters<typeof addressOf>[1]) =>
  new Bun.CryptoHasher("sha256").update(`eidoverse-addr:${addressOf(req, srv)}`).digest("hex").slice(0, 24);
/** Who a read is for: the caller, else a guest at their hashed address, so a guest's address ban holds at the reads (#260 bot 5). */
export function httpVisitor(req: Request, srv?: Parameters<typeof addressOf>[1]): Who {
  return httpCaller(req) ?? { account: null, addr: hashedAddress(req, srv) };
}
const whoAccount = (account: string): Who => ({ account, actorId: directoryFor(WORLDS_DIR).idOfSub(account) });

/** A connection as the door sees it. */
export function whoOf(c: Client): Who {
  return { account: c.account ?? null, actorId: c.actorId ?? null, trustedRenderer: !!c.trustedRenderer, addr: c.addr ?? null };
}

export type Expel = (w: World, target: Client, why: string, until?: number | null, code?: number) => void;

/** After a world's roles or access change: everyone who may no longer be here, as they are (embodied or watching), is
 *  removed with 4010 and the reason. Aux legs go with their primary (expel reaps them). Capacity never removes anyone. */
export function settleAccess(w: World, expel: Expel, now = Date.now()) {
  if (!w.log) return;
  const door = doorOfWorld(w);
  for (const c of [...w.clients]) {
    if (c.superseded || (c.surface ?? "world") !== "world") continue;   // an aux leg follows its primary
    const r = entryFor(door, whoOf(c), c.spectator ? "watch" : "embody", { now });
    if (!r || r.reason === "full") continue;
    console.log(`[world:${w.name}] ${c.id} may no longer be here (${r.reason}): removed`);
    expel(w, c, r.reason === "no-access" ? `your access to "${w.name}" ended or changed — ${r.why}` : r.why, r.until ?? null, r.code === 4006 ? 4006 : ACCESS_CLOSE);
  }
}

// timed grants: who has been warned about which end (world\0actor\0until)
const warned = new Set<string>();
/** Every second (server.ts registers it): in each loaded world, tell anyone whose timed grant ends within five minutes,
 *  once; then the authority writes the ends that have passed (expire-roles), and whoever lost entry with them is
 *  removed. */
export function sweepAccess(worlds: Iterable<World>, expel: Expel, now = Date.now()) {
  for (const w of worlds) {
    if (!w.log) continue;
    const wc = wcOfWorld(w);
    for (const g of timedGrants(wc)) {
      if (g.until - now > ACCESS_WARN_MS || g.until <= now) continue;
      const k = `${w.name}\u0000${g.actor}\u0000${g.until}`;
      if (warned.has(k)) continue;
      const closes = listedIn(wc, g.actor) && wc.access?.join === "listed";
      // marked warned only once it reached them: someone who arrives inside the last five minutes is told on the next sweep
      for (const c of w.clients) if (c.actorId === g.actor && (c.surface ?? "world") === "world")
        try { c.ws.send(JSON.stringify({ type: "notice", text: `your ${g.role} grant in "${w.name}" ends in ${leftWords(g.until, now).replace(" left", "")}${closes ? ` — this world admits only people listed, so you'll have to leave then` : ""}` })); warned.add(k); } catch { /* gone */ }
    }
    const ended = w.log.expireRoles();
    if (ended.length) console.log(`[world:${w.name}] timed grant(s) ended: ${ended.join(", ")}`);
    // a world without custody can't log the end, but the door already reads it as over: settle anyway (#260 bot 14)
    if (ended.length || timedGrants(wc).some((g: { until: number }) => g.until <= now)) settleAccess(w, expel, now);
  }
  if (warned.size > 4096) warned.clear();
}
