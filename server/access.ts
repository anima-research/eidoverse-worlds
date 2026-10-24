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

import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { WORLDS_DIR, JOIN_TOKEN } from "./config.ts";
import { globalBans, findBan } from "./moderation.ts";
import { isOperator } from "./operators.ts";
import { sessionOfRequest, accountOf } from "./auth.ts";
import { directoryFor } from "./directory.ts";
import { accountAgeRefusal } from "./accountage.ts";
import { effectiveOf, isOwner, MOD_POWERS } from "../shared/protocol/roles.js";
import { opsOf } from "../shared/protocol/fold.js";
import { isBanned, kickOf } from "../shared/protocol/authority.js";
import { modLogAt } from "./custody.ts";
import { entryOf, doorOf as doorOfWc, listedIn, timedGrants, leftWords, ACCESS_WARN_MS } from "../shared/protocol/access.js";
import type { World, Client } from "./world.ts";

/** Close code for "this world is not open to you": refused at the door, or removed because access ended or changed.
 *  Clients don't redial it (4006 is moderation's, 4005 a bad link). */
export const ACCESS_CLOSE = 4010;
/** Close code for "there is nothing here YET": a spectator of a world nobody has founded. Not a refusal: clients redial
 *  it with their usual backoff, so an observer started early joins once the world exists. */
export const NOT_YET_CLOSE = 4011;

/** An identity as the door sees it. `account`: the account a credential proved (null = a guest); `actorId`: the world's
 *  opaque id for it (server/directory.ts); `trustedRenderer`: the renderers' credential (may watch anywhere, never
 *  embody); `addr`: a guest's hashed address (bans name it). */
export type Who = { account: string | null; actorId?: string | null; trustedRenderer?: boolean; addr?: string | null };
/** `mod`: an unloaded world's moderator log, read from disk with its door (a loaded world's own log is the truth). */
export type Door = { name: string; wc: Record<string, any>; label: string; world?: World; mod?: any[] };
export type EntryMode = "embody" | "watch";
export type Refusal = { code: number; reason: "banned" | "kicked" | "no-access" | "full" | "age"; why: string; until?: number };

const wcOfWorld = (w: World): Record<string, any> => (w.log?.live?.state?.().entities?.["@world"]?.c ?? {}) as Record<string, any>;

/** The door of a LOADED world. */
export function doorOfWorld(w: World): Door { const wc = wcOfWorld(w); return { name: w.name, wc, label: doorOfWc(wc), world: w }; }
/** open | public | signed-in | watch | invite-only — the label a listing shows. */
export function doorOf(w: World): string { return doorOfWc(wcOfWorld(w)); }

// ---- a world's door, without loading the world ----------------------------------------------------------------------
// Listing and HTTP reads must answer "may this caller see world X?" for worlds nobody is in. Loading them would do it,
// but a loaded world is never unloaded, so a /worlds call would pull every world on disk into memory for good. Instead:
// the change entries in world.jsonl that touch @world's access, default-role, role-defs and roles:*, folded set/delete in order,
// cached until the file changes. (Only those keys: nothing else about the world is read.) Its moderator log
// (world.mod.jsonl, never in the world log) comes with it: a ban or kick there must close the door before the world is
// loaded, as after (Antra's review of f91840e5 P1: a banned member's first /geom after a restart answered 200).
const doorCache = new Map<string, { key: string; wc: Record<string, any>; mod: any[] }>();
const DOOR_LINE = /"id"\s*:\s*"@world"/;
const isDoorComp = (k: unknown) => typeof k === "string" && (k === "access" || k === "default-role" || k === "role-defs" || k.startsWith("roles:"));   // role-defs: a custom role's powers (the moderation bypass)
/** Set by server.ts: the loaded worlds (a loaded world's own fold is the truth). */
let loadedWorlds: () => Map<string, World> = () => new Map();
export function setLoadedWorlds(fn: () => Map<string, World>) { loadedWorlds = fn; }

/** A world's door by name: the loaded world's, else read from disk; null when there is no such world. */
export function doorFor(name: string): Door | null {
  const live = loadedWorlds().get(name);
  if (live) return doorOfWorld(live);
  if (!/^[a-z0-9_-]{1,64}$/i.test(name)) return null;
  const file = join(WORLDS_DIR, name, "world.jsonl");
  let st; try { st = statSync(file); } catch { return null; }
  const modFile = join(WORLDS_DIR, name, "world.mod.jsonl");
  let ms: { size: number; mtimeMs: number } | null = null; try { ms = statSync(modFile); } catch { ms = null; }
  const key = `${st.size}:${st.mtimeMs}:${ms ? `${ms.size}:${ms.mtimeMs}` : "-"}`;
  const hit = doorCache.get(name);
  if (hit?.key === key) return { name, wc: hit.wc, label: doorOfWc(hit.wc), mod: hit.mod };
  // unreadable moderator log: no door (as an unreadable world log), never a door that forgets its bans
  let mod: any[]; try { mod = modLogAt(modFile).mod; } catch { return null; }
  const wc: Record<string, any> = {};
  try {
    for (const line of readFileSync(file, "utf8").split("\n")) {
      if (!line || !DOOR_LINE.test(line)) continue;
      let e: any; try { e = JSON.parse(line); } catch { continue; }
      if (e?.kind !== "change") continue;
      let ops: any[] = []; try { ops = opsOf(e); } catch { continue; }   // a batch's ops, or a single set/delete's own body
      for (const o of ops) {
        if (o?.id !== "@world" || !isDoorComp(o.comp)) continue;
        if (o.verb === "set" && o.value && typeof o.value === "object") wc[o.comp] = o.value;
        else if (o.verb === "delete") delete wc[o.comp];
      }
    }
  } catch { return null; }
  doorCache.set(name, { key, wc, mod });
  return { name, wc, label: doorOfWc(wc), mod };
}

/** May `who` be in this world — with a body, or watching? null = yes; else the refusal (code, reason, words).
 *  `here` (embodied joins only): how many bodies are in the world now, for access.max. */
export function entryFor(door: Door, who: Who, mode: EntryMode, { now = Date.now(), here = null as number | null } = {}): Refusal | null {
  const { account, actorId, addr } = who;
  // exclusion outranks everything but the operator: a global ban closes every door, a world's ban this one. Watching
  // counts — a ban is exclusion, not just silencing
  if (!isOperator(account)) {
    // the world's own moderator log: the loaded world's, else the one read from disk with its door (same views, at `now`)
    const off = !door.world && door.mod ? { mod: door.mod, now: () => now } : null;
    const bannedHere = (id: string) => door.world ? !!door.world.log?.bannedHere(id) : !!off && isBanned(off, id);
    const kickedHere = (id: string) => door.world ? door.world.log?.kickedHere(id) : off ? kickOf(off, id) : null;
    const gb = findBan(globalBans, account, addr);
    const ban = gb ?? findBan(globalBans, account, addr, now, door.name) ?? (actorId && bannedHere(actorId) ? { by: "a moderator" } as any : null);
    if (ban) return { code: 4006, reason: "banned", why: `you are banned from ${gb ? "these worlds" : `"${door.name}"`}${ban.reason ? ` — ${ban.reason}` : ""}` };
    const k = actorId ? kickedHere(actorId) : null;
    if (k) { const mins = Math.max(1, Math.ceil((k.until - now) / 60000));
      return { code: 4006, reason: "kicked", why: `you were removed from "${door.name}" and may come back in ${mins} min${k.reason ? ` — ${k.reason}` : ""}`, until: k.until }; }
  }
  // operators, owners and holders of a moderation power always get in (what @world.access always said)
  const eff = actorId ? effectiveOf(door.wc, actorId, { anon: !account }) : null;
  // the bypass is for people this world LISTS (an explicit role row): a power handed to everyone through default-role or
  // role-defs must not open a members-only door (final review M1, 10-18)
  // an ended timed grant is absent at `now` (security review 10-18 M6): the door reads it as not listed, loaded or not, before the
  // authority's sweep writes its end (expire-roles) — so an unloaded world's HTTP reads and a join don't honour it indefinitely
  const listed = !!actorId && listedIn(door.wc, actorId, now);
  const bypass = isOperator(account) || (listed && (isOwner(eff) || MOD_POWERS.some((p: string) => eff?.permissions?.includes(p))));
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

/** May `who` at least watch this world (it is on their map, its reads answer)? */
export function visibleTo(door: Door | null, who: Who | null, now = Date.now()): boolean {
  return !!door && entryFor(door, who ?? { account: null }, "watch", { now }) === null;
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
 *  the door key, not who). Never the URL: credentials in query strings end up in logs. */
export function httpCaller(req: Request): Who | null {
  const s = sessionOfRequest(req);
  const dir = directoryFor(WORLDS_DIR);
  const who = (account: string): Who => ({ account, actorId: dir.idOfSub(account) });
  if (s && (s.scopes.includes("worlds:join") || s.scopes.includes("worlds:spectate"))) return who(s.sub);   // one sign-in, every world (main #255: a session's old nativeWorld no longer narrows it)
  const m = /^Bearer\s+(\S+)$/i.exec(req.headers.get("authorization") ?? "");
  if (m) {
    const tok = m[1]!;
    if (JOIN_TOKEN && tok === JOIN_TOKEN) return null;
    const a = accountOf(tok);
    if (a && "account" in a) return who(a.account);
  }
  return null;
}

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
    if (ended.length) { console.log(`[world:${w.name}] timed grant(s) ended: ${ended.join(", ")}`); settleAccess(w, expel, now); }
  }
  if (warned.size > 4096) warned.clear();
}
