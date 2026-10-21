// eidoverse-worlds sequencer — WORLD ACCESS: who may come in, decided by the
// world (docs/DESIGN-world-access.md).
//
// Archipelago answers "who is this?" (a verified sub, a name, a kind). Whether
// that identity may be HERE is the world's own fact: the bottom two rungs of
// the rights ladder (shared/fold.js ROLE_RANK — `none`, `spectator`), written
// by owners through the same `grant` verb as every other right, so access
// replays, folds, audits and rides a fork like everything else.
//
// This module is the one place every door asks:
//   canEnter      — the decision (bans → operator → the world's ladder)
//   httpCaller    — who is asking over HTTP (cookie session or bearer)
//   settleAccess  — after roles change: push rights, remove who may not stay
//   sweepAccess   — expiry: warn five minutes out, settle `until` into history
//   the directory — subs Eidoverse has seen, so owners can name the absent
//   the founding cap — every member may found worlds, a few per day
//
// Like rights.ts it never imports server.ts (§15.1): the session's expel is
// injected by the caller.

import { existsSync, readFileSync, statSync, openSync, readSync, closeSync } from "node:fs";
import { join } from "node:path";
import { WORLDS_DIR } from "./config.ts";
import { atomicWrite } from "./fsutil.ts";
import { foldEntry, type LogEntry, type WorldState } from "../shared/fold.js";
import { entryOf, entryRestrictedIn, worldHasOwnerIn } from "../shared/rightsfold.js";
import { isAdminId, rightsOf } from "./rights.ts";
import { globalBans, findBan } from "./moderation.ts";
import { sessionFromCookie, agentTokens, aid1JoinIdentity } from "./auth.ts";

/** Close code for "this world is not open to you" — refused at the door, or
 *  removed because access ended. The client does not retry it. Distinct from
 *  4006 (moderation), whose message says "removed by moderation". */
export const ACCESS_CLOSE = 4010;
/** Close code for "there is nothing here yet" — watching a world that does
 *  not exist. NOT a refusal: clients retry it (with their usual backoff), so
 *  an observer started before the world is founded joins once it is. */
export const NOT_YET_CLOSE = 4011;

/** An identity as the access decision sees it.
 *  `sub` — the durable subject a door vouched for (home-node session, aid1).
 *  `nameReserved` — the NAME itself is authoritative: an agent bearer from
 *  tokens.json, or an aid1 agent (the home node enrolls agent names
 *  uniquely). A human's display name is self-chosen, so it never is; a typed
 *  name at the JOIN_TOKEN door never is.
 *  `onlyWorld` — credential narrowing (a native device session limited to one
 *  world). It can only refuse. */
export type Who = { id: string; sub?: string; nameReserved?: boolean; onlyWorld?: string; watchOnly?: boolean; trustedRenderer?: boolean };
export type EntryMode = "embody" | "watch";
type WorldLike = { name: string; state: WorldState };

/** Rights as the ENTRY decision sees them. Operators pass everywhere. In a
 *  world that restricts entry, a record filed only under a NAME (no sub) is a
 *  nameplate, not a key: only an identity whose name is itself authoritative
 *  (a reserved agent name) may wear it. Everyone else needs a record bound to
 *  their durable sub, or gets the wildcard — otherwise anyone who can choose a
 *  display name, or type one at the door-key door, could walk in as a member.
 *  (In open worlds name-keyed grants keep their old meaning — this changes
 *  entry only.) */
export function entryRightsOf(state: WorldState, who: Who, now = Date.now()) {
  if (isAdminId(who.id, who.sub)) return rightsOf(state, who.id, who.sub, now);
  if (entryRestrictedIn(state as any) && !who.nameReserved) return rightsOf(state, who.id, who.sub, now, { nameKeyed: false });
  return rightsOf(state, who.id, who.sub, now);
}

export type Refusal = { ok: false; code: number; reason: "banned" | "watch-only" | "no-access"; why: string };

/** May `who` be in world `w` — embodied, or watching? */
export function canEnter(w: WorldLike, who: Who, mode: EntryMode, now = Date.now()): { ok: true } | Refusal {
  // Exclusion outranks everything but the operator: a global ban closes every
  // door, a world ban closes this one. Spectating counts — a ban is exclusion,
  // not just silencing. (Same prose the join door always sent.)
  const gb = findBan(globalBans, who.id, who.sub);
  const ban = gb ?? findBan(w.state.bans, who.id, who.sub);
  if (ban && !isAdminId(who.id, who.sub)) {
    return { ok: false, code: 4006, reason: "banned",
      why: `you are banned from ${gb ? "these worlds" : `"${w.name}"`}${ban.reason ? ` — ${ban.reason}` : ""} (by ${ban.by})` };
  }
  // A TRUSTED RENDERER (RENDERER_TOKEN, config.ts) is the vision of the agents
  // inside: it may watch any world — never be embodied, never author.
  if (who.trustedRenderer && mode === "watch") return { ok: true };
  if (who.onlyWorld && who.onlyWorld !== "*" && who.onlyWorld !== w.name && !isAdminId(who.id, who.sub)) {
    return { ok: false, code: ACCESS_CLOSE, reason: "no-access", why: `this sign-in is limited to "${who.onlyWorld}"` };
  }
  // a sign-in that carries only worlds:spectate may watch, never be embodied
  // (the ws join refuses it on scope; the HTTP answers must agree)
  if (mode === "embody" && who.watchOnly && !isAdminId(who.id, who.sub)) {
    const watch = entryOf(entryRightsOf(w.state, who, now));
    return watch === "none"
      ? { ok: false, code: ACCESS_CLOSE, reason: "no-access", why: `"${w.name}" isn't open to you` }
      : { ok: false, code: ACCESS_CLOSE, reason: "watch-only", why: `your sign-in lets you watch "${w.name}", not join it in a body` };
  }
  const entry = entryOf(entryRightsOf(w.state, who, now));
  if (entry === "embody" || (mode === "watch" && entry === "watch")) return { ok: true };
  if (entry === "watch") {
    return { ok: false, code: ACCESS_CLOSE, reason: "watch-only",
      why: `you may watch "${w.name}" but not join it in a body — open it with ?spectate` };
  }
  // Says nothing about who is inside, who owns it, or why: a members-only
  // world is unlisted and invisible to non-members. (That the name is TAKEN
  // cannot be hidden — founding it would fail — so the refusal is honest
  // about that much and no more.)
  return { ok: false, code: ACCESS_CLOSE, reason: "no-access", why: `"${w.name}" isn't open to you` };
}

/** Is this world visible to `who` — listed, and readable over HTTP? Visible
 *  means "may at least watch". An anonymous caller is everyone (`*`). */
export function visibleTo(w: WorldLike, who: Who | null, now = Date.now()): boolean {
  return canEnter(w, who ?? { id: "" }, "watch", now).ok;
}

/** Who is asking, over HTTP: the browser's session cookie, or an
 *  `Authorization: Bearer` credential (an aid1 token or a tokens.json agent
 *  bearer — what the MCPL door holds). Null = anonymous. Never the URL:
 *  credentials in query strings end up in logs. */
export function httpCaller(req: Request): Who | null {
  // A session is an identity for these reads only if it carries Eidoverse
  // access at all (worlds:join, or worlds:spectate to watch) — the same scopes
  // the ws join demands. Otherwise a login with neither, whose subject still
  // held a grant somewhere, could read a private world the door would refuse
  // it (Greptile #258).
  const s = sessionFromCookie(req.headers.get("cookie"));
  if (s && (s.scopes.includes("worlds:join") || s.scopes.includes("worlds:spectate"))) {
    return { id: s.name, sub: s.sub, ...(s.nativeWorld ? { onlyWorld: s.nativeWorld } : {}),
      ...(!s.scopes.includes("worlds:join") ? { watchOnly: true } : {}) };
  }
  const m = /^Bearer\s+(\S+)$/i.exec(req.headers.get("authorization") ?? "");
  if (m) {
    const tok = m[1]!;
    const name = agentTokens().byToken.get(tok);
    if (name) return { id: name, nameReserved: true };
    const aid = aid1JoinIdentity(tok);
    if (aid) return { id: aid.slug, sub: aid.payload.sub, nameReserved: aid.payload.kind !== "human" };
  }
  return null;
}

// ---- a world's door, without loading the world -----------------------------------
// Listing and HTTP reads must answer "may this caller see world X?" for worlds
// nobody is in. Loading them would do it, but a loaded world is never unloaded
// — so a /worlds call would pull every world on disk into memory for good.
// Instead: the snapshot's roles and bans, plus the access verbs in the log tail
// after it, folded by the same fold, cached until either file changes.

const doorCache = new Map<string, { key: string; state: WorldState }>();
const ACCESS_VERBS = new Set(["grant", "ban", "unban"]);
const ACCESS_LINE = /"verb"\s*:\s*"(grant|ban|unban)"/;

/** The world as the access decision needs it: loaded if it is, otherwise its
 *  roles and bans read from disk. Null when no such world exists. */
export function worldForAccess(name: string, loaded: Map<string, WorldLike>): WorldLike | null {
  const live = loaded.get(name);
  if (live) return live;
  if (!/^[a-z0-9_-]{1,64}$/i.test(name)) return null;
  const dir = join(WORLDS_DIR, name);
  const logPath = join(dir, "log.jsonl"), snapPath = join(dir, "snapshot.json");
  let logStat, snapStat;
  try { logStat = statSync(logPath); } catch { return null; }
  try { snapStat = statSync(snapPath); } catch { snapStat = null; }
  const key = `${logStat.size}:${logStat.mtimeMs}:${snapStat ? `${snapStat.size}:${snapStat.mtimeMs}` : "-"}`;
  const hit = doorCache.get(name);
  if (hit && hit.key === key) return { name, state: hit.state };
  const state = { roles: {}, bans: {} } as unknown as WorldState;
  let from = 0;
  // A corrupt snapshot is a corrupt CACHE, not a corrupt world — the loader
  // ignores it and replays the log, and so does this: read the access entries
  // from byte zero (Greptile #258: a bad snapshot once locked an idle world's
  // own owners out). Only an unreadable LOG fails closed, below.
  if (snapStat) {
    try {
      const snap = JSON.parse(readFileSync(snapPath, "utf8"));
      if (snap?.state && typeof snap.seq === "number" && typeof snap.bytes === "number" && snap.bytes > 0 && snap.bytes <= logStat.size) {
        (state as any).roles = snap.state.roles ?? {};
        (state as any).bans = snap.state.bans ?? {};
        from = snap.bytes;
      }
    } catch { (state as any).roles = {}; (state as any).bans = {}; from = 0; }
  }
  try {
    const len = logStat.size - from;
    const buf = Buffer.alloc(len);
    const fd = openSync(logPath, "r");
    try { readSync(fd, buf, 0, len, from); } finally { closeSync(fd); }
    for (const line of buf.toString("utf8").split("\n")) {
      // cheap prefilter, tolerant of any JSON spacing (the parse decides)
      if (!ACCESS_LINE.test(line)) continue;
      try {
        const e = JSON.parse(line) as LogEntry;
        if (ACCESS_VERBS.has(e.verb)) foldEntry(state, e);
      } catch { /* a torn last line is the live writer's, not ours */ }
    }
  } catch (e) {
    // Unreadable = invisible to everyone but operators. Fail closed: a world
    // whose door we cannot read must not be listed as open.
    console.log(`[access] could not read ${name}'s door: ${(e as Error).message}`);
    return { name, state: { roles: { "*": { role: "none" }, "~unreadable": { role: "owner" } }, bans: {} } as unknown as WorldState };
  }
  doorCache.set(name, { key, state });
  return { name, state };
}

// ---- after roles change ------------------------------------------------------

export type AccessClient = {
  id: string; sub?: string; spectator: boolean; nameReserved?: boolean; trustedRenderer?: boolean; surface?: string;
  world: unknown; ws: { send(data: string): void };
};
export type AccessWorld = WorldLike & {
  clients: Set<AccessClient>;
  commit(actor: string, verb: string, args: Record<string, unknown>): LogEntry;
  debug?(kind: string, detail: Record<string, unknown>): void;
};
export type Expel = (w: AccessWorld, target: AccessClient, why: string, code?: number) => void;

export function whoOf(c: { id: string; sub?: string; nameReserved?: boolean; trustedRenderer?: boolean }): Who {
  return { id: c.id, ...(c.sub ? { sub: c.sub } : {}), ...(c.nameReserved ? { nameReserved: true } : {}),
    ...(c.trustedRenderer ? { trustedRenderer: true } : {}) };
}

/** The roles just changed (a grant, a revoke, an expiry settled). Tell every
 *  present participant what they may do now — clients consume an answer, not
 *  a second precedence model — and remove whoever may no longer be here.
 *  Someone who may still WATCH is told so, and can come back with ?spectate. */
export function settleAccess(w: AccessWorld, expel: Expel, now: number,
  cause: { seq?: number; by?: string; expired?: boolean } = {}) {
  const open = !worldHasOwnerIn(w.state as any);
  for (const other of [...w.clients]) {
    if (other.world !== w || !w.clients.has(other)) continue;   // reaped with a primary earlier in this loop
    const rights = { ...rightsOf(w.state, other.id, other.sub, now), open };
    try {
      other.ws.send(JSON.stringify({ type: "your-rights", rights, ...(cause.seq != null ? { causeSeq: cause.seq } : {}) }));
    } catch (err) {
      w.debug?.("rights-delivery-error", { who: other.id, seq: cause.seq ?? null, error: String(err) });
    }
    const v = canEnter(w, whoOf(other), other.spectator ? "watch" : "embody", now);
    if (v.ok || v.code !== ACCESS_CLOSE) continue;
    const ended = cause.expired ? `your time in "${w.name}" has ended` : `your access to "${w.name}" changed${cause.by ? ` (${cause.by})` : ""}`;
    const tail = v.reason === "watch-only" ? ` — you may still watch it with ?spectate` : "";
    expel(w, other, `${ended}${tail}`, ACCESS_CLOSE);
    console.log(`[world:${w.name}] ${other.id} removed — access ${cause.expired ? "expired" : "changed"} (${v.reason})`);
  }
}

// ---- expiry ------------------------------------------------------------------

/** How far ahead someone is warned that their access is ending. */
export const ACCESS_WARN_MS = 5 * 60_000;
const warned = new Map<string, number>();

/** One pass over the loaded worlds (tick system, every few seconds):
 *  - records past their `until` are SETTLED into history — a world-authored
 *    `grant {revoke, expired}` — then settleAccess removes whoever lost entry;
 *  - anyone present whose access ends within ACCESS_WARN_MS is told once.
 *  Evaluation never depends on this having run: rightsIn already reads an
 *  expired record as absent. The sweep makes the end visible and audited. */
export function sweepAccess(worlds: Iterable<AccessWorld>, expel: Expel, now = Date.now()) {
  for (const w of worlds) {
    const roles = (w.state.roles ?? {}) as Record<string, { until?: number; sub?: string; role?: string }>;
    const expired = Object.entries(roles).filter(([, r]) => typeof r?.until === "number" && r.until <= now);
    if (expired.length) {
      let seq: number | undefined;
      for (const [id, r] of expired) {
        const e = w.commit("world", "grant", { id, revoke: true, expired: true, ...(r.sub ? { sub: r.sub } : {}) });
        seq = e.seq;
        console.log(`[world:${w.name}] ${id}'s ${r.role ?? "grant"} expired`);
      }
      settleAccess(w, expel, now, { seq, expired: true });
    }
    for (const c of w.clients) {
      if ((c.surface ?? "world") !== "world") continue;   // one warning per identity, not per leg
      const who = whoOf(c);
      const r = entryRightsOf(w.state, who, now);
      if (typeof r.until !== "number" || r.until - now > ACCESS_WARN_MS) continue;
      const key = `${w.name}|${c.sub ?? c.id}|${r.until}`;
      if (warned.has(key)) continue;
      warned.set(key, now);
      const after = entryRightsOf(w.state, who, r.until);
      const mins = Math.max(1, Math.round((r.until - now) / 60_000));
      const when = `in ${mins} minute${mins === 1 ? "" : "s"}`;
      const loses = c.spectator ? entryOf(after) === "none" : entryOf(after) !== "embody";
      const text = loses
        ? `your access to "${w.name}" ends ${when}`
        : after.role !== r.role ? `your ${r.role} rights in "${w.name}" end ${when} — you'll be a ${after.role}` : null;
      if (!text) continue;
      try { c.ws.send(JSON.stringify({ type: "notice", text, until: r.until })); } catch { /* the sweep must never throw */ }
    }
  }
  for (const [k, t] of warned) if (now - t > 2 * 60 * 60_000) warned.delete(k);
}

// ---- the directory -------------------------------------------------------------
// Every durable identity a door has vouched for, so an owner can grant someone
// who is not present: `/grant bob builder` resolves bob → bob's sub here, and
// the grant is bound to the PERSON, not the nick. Instance-level (not world
// data), beside the worlds like .bans.json, 0600. Names are what the identity
// service said at the last sighting.

export type PrincipalRec = { name: string; kind: "human" | "agent"; first: number; last: number };
export const PRINCIPALS_FILE = join(WORLDS_DIR, ".principals.json");
const principals: Record<string, PrincipalRec> = {};
try {
  if (existsSync(PRINCIPALS_FILE)) {
    const raw = JSON.parse(readFileSync(PRINCIPALS_FILE, "utf8")) as Record<string, PrincipalRec>;
    for (const [sub, p] of Object.entries(raw)) {
      if (p && typeof p.name === "string" && (p.kind === "human" || p.kind === "agent")) principals[sub] = p;
    }
  }
} catch (e) { console.log(`[access] directory restore failed (starting empty): ${e}`); }
let principalsTimer: ReturnType<typeof setTimeout> | null = null;
function savePrincipalsSoon() {
  if (principalsTimer) return;
  principalsTimer = setTimeout(() => {
    principalsTimer = null;
    try { atomicWrite(PRINCIPALS_FILE, JSON.stringify(principals), { mode: 0o600 }); }
    catch (e) { console.log(`[access] directory save failed: ${e}`); }
  }, 2000);
  (principalsTimer as { unref?: () => void }).unref?.();
}
/** A door vouched for `sub` under `name` just now. */
export function notePrincipal(sub: string | undefined, name: string, kind: "human" | "agent", now = Date.now()) {
  if (!sub || !name) return;
  // names the world reserves for itself never enter the directory — nobody can
  // join under them, and a grant must never be filed under one
  if (name === "*" || /^world$/i.test(name) || /^bhv:/i.test(name)) return;
  const p = principals[sub];
  if (p && p.name === name && p.kind === kind && now - p.last < 10 * 60_000) return;
  principals[sub] = { name, kind, first: p?.first ?? now, last: now };
  savePrincipalsSoon();
}
/** Everyone the directory knows under this name (case-insensitive), newest first. */
export function resolveName(name: string): { sub: string; name: string; kind: string }[] {
  const key = name.toLowerCase();
  return Object.entries(principals)
    .filter(([, p]) => p.name.toLowerCase() === key)
    .sort(([, a], [, b]) => b.last - a.last)
    .map(([sub, p]) => ({ sub, name: p.name, kind: p.kind }));
}
export function principalOf(sub: string): PrincipalRec | undefined { return principals[sub]; }
/** Identities whose last-seen name contains `q` (case-insensitive), most
 *  recently seen first — the owner panel's "add someone" search. */
export function searchDirectory(q: string, limit = 8): { sub: string; name: string; kind: string; last: number }[] {
  const key = q.trim().toLowerCase();
  if (!key) return [];
  return Object.entries(principals)
    .filter(([, p]) => p.name.toLowerCase().includes(key))
    .sort(([, a], [, b]) => {
      // a name that STARTS with what was typed ranks above one that merely contains it
      const pa = a.name.toLowerCase().startsWith(key) ? 0 : 1, pb = b.name.toLowerCase().startsWith(key) ? 0 : 1;
      return pa - pb || b.last - a.last;
    })
    .slice(0, limit)
    .map(([sub, p]) => ({ sub, name: p.name, kind: p.kind, last: p.last }));
}
/** A durable subject string, as the home node mints them. */
export const SUB_RE = /^(human|agent|service):[^\s]{1,120}$/;

// ---- founding ------------------------------------------------------------------
// Every member may found worlds, a few per day: the cap is per identity over a
// rolling 24 hours. FOUND_DAILY_CAP=off removes it. Operators are exempt.

const capEnv = (process.env.FOUND_DAILY_CAP ?? "5").trim().toLowerCase();
// A value that does not parse keeps the default rather than becoming 0 (which
// would silently stop everyone founding anything).
const capNum = Number(capEnv);
export const FOUND_DAILY_CAP: number | null = capEnv === "off" ? null
  : capEnv !== "" && Number.isFinite(capNum) && capNum >= 0 ? Math.floor(capNum) : 5;
export const FOUNDING_FILE = join(WORLDS_DIR, ".founding.json");
const DAY_MS = 24 * 60 * 60_000;
const founded: Record<string, number[]> = {};
try {
  if (existsSync(FOUNDING_FILE)) {
    const raw = JSON.parse(readFileSync(FOUNDING_FILE, "utf8")) as Record<string, number[]>;
    for (const [k, v] of Object.entries(raw)) if (Array.isArray(v)) founded[k] = v.filter((t) => typeof t === "number");
  }
} catch (e) { console.log(`[access] founding ledger restore failed (starting empty): ${e}`); }
const foundingKey = (who: Who) => who.sub ?? `name:${who.id.toLowerCase()}`;

/** Why `who` may not found another world right now, or null. */
export function foundingRefusal(who: Who, now = Date.now()): string | null {
  if (FOUND_DAILY_CAP == null || isAdminId(who.id, who.sub)) return null;
  const recent = (founded[foundingKey(who)] ?? []).filter((t) => now - t < DAY_MS);
  if (recent.length < FOUND_DAILY_CAP) return null;
  const freeAt = Math.min(...recent) + DAY_MS;
  const hrs = Math.max(1, Math.ceil((freeAt - now) / 3_600_000));
  return `you've made ${recent.length} new world${recent.length === 1 ? "" : "s"} in the last day, which is the limit — you can make another in about ${hrs} hour${hrs === 1 ? "" : "s"}`;
}
/** `who` just founded (or forked into) a new world. */
export function noteFounding(who: Who, now = Date.now()) {
  if (isAdminId(who.id, who.sub)) return;
  const k = foundingKey(who);
  founded[k] = [...(founded[k] ?? []).filter((t) => now - t < DAY_MS), now];
  for (const [key, v] of Object.entries(founded)) if (!v.some((t) => now - t < DAY_MS)) delete founded[key];
  try { atomicWrite(FOUNDING_FILE, JSON.stringify(founded), { mode: 0o600 }); }
  catch (e) { console.log(`[access] founding ledger save failed: ${e}`); }
}
