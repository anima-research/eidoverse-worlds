// eidoverse-worlds sequencer — the verb table + shell (TEL0S_NOTES §15, 7b).
//
// The authored plane's entire dispatch: one row per verb ({rank, gen?,
// selfRankZero?, validate?, after?}) built on rights.ts's VERB_NEEDS — which
// stays exported there, wireBehaviorGate reads it — plus runVerb(), the shell
// that replaced server.ts's whole `case "verb"` body. Everything the suites
// assert on (error prose, debug(kind) names, hook order) moved here
// byte-identical; server.ts's case is now a one-call relay.
//
// Cycle break (§15.1): this module never imports server.ts. The World/Client
// shapes are structural (the behaviors.ts WorldLike precedent), and expel —
// which lives with the session — is INJECTED per dispatch via ctx.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { VERB_RATE, OPT_DIR } from "./config.ts";
import { isAdminId, rightsOf, worldHasOwner, VERB_NEEDS, lockRefusal, guardRefusal, captionDeedRefusal } from "./rights.ts";
import { settleAccess, resolveName, principalOf, canEnter, whoOf, SUB_RE, type AccessWorld, type Expel } from "./access.ts";
import { entryRestrictedIn } from "../shared/rightsfold.js";
import { normalizeCaptionArgs, captionRefusal } from "../shared/captions.js";
import { lintMotion, lintParticles } from "./lint.ts";
import { reactToUse } from "./reactions.ts";
import { behaviorLimits } from "./behaviors.ts";
import { lightArgsError } from "./verb-shapes.ts";
import { ROLE_RANK, foldEntry, type LogEntry, type WorldState } from "../shared/fold.js";
import { SIM_ID } from "../shared/sim.js";
import { boxOf, worldLibs } from "./boxes.ts";

// Bodies alive at the moment an epoch entry is validated — consumed by the
// epoch after-hook to release them into the fold (see the verb below).
const epochRelease = new WeakMap<object, { id: string; p: number[]; yaw: number }[]>();

// ---- what runVerb needs from the session (structural) ----------------------

export type VerbClient = {
  id: string;
  sub?: string;
  spectator: boolean;
  world: VerbWorld | null;
  lastPose: unknown;
  ws: { send(data: string): void };
  verbWin: number; verbCount: number;
  /** This leg's generation, issued on acceptance (server.ts: a same-identity join is a takeover). */
  gen?: number;
  /** The world-scoped generation (World.legGen): what caption entries carry — survives a sequencer restart. */
  legGen?: number;
};

export type VerbWorld = {
  name: string;
  state: WorldState;
  clients: Set<VerbClient>;
  leases: Map<string, { lastState: { p: number[]; yaw?: number; q?: number[] } | null }>;
  sim: { epoch: unknown; bodies: Record<string, { p: number[] }> };
  bhv: { sync(): void; onEntry(entry: LogEntry): void };
  append(actor: string, verb: string, args: Record<string, unknown>): LogEntry;
  commit(actor: string, verb: string, args: Record<string, unknown>): LogEntry;
  broadcast(msg: unknown, except?: VerbClient): void;
  debug(kind: string, detail: Record<string, unknown>): void;
  fold(reason?: string): void;
};

/** Built by server.ts per dispatch. `now` is the message handler's clock, so
 *  the verb-rate window does exactly the arithmetic the unsplit file did;
 *  expel is injected because it lives with the session (§15.1) and this
 *  module must never import server.ts. */
export type VerbCtx = {
  w: VerbWorld;
  c: VerbClient;
  now: number;
  expel(w: VerbWorld, target: VerbClient, why: string, code?: number): void;
};

// ---- the table -------------------------------------------------------------

export type VerbRow = {
  rank: number;
  gen?: boolean;
  /** Needs the caption deed for args.id (rights.ts captionDeedRefusal). */
  caption?: boolean;
  /** Mounting or dismounting YOURSELF (sit on the swing, step off the ferry)
   *  is a visitor act — using the world, not editing it. Moving OTHER things
   *  (cargo onto a truck) stays building. The shell drops rank to 0 when
   *  args.id names the client itself. */
  selfRankZero?: boolean;
  /** Shape-check + rebuild args before they become history. Refusal prose is
   *  API (suites assert substrings); flight-recorder writes (debug "denied" /
   *  "rejected") happen in here, so each branch keeps its exact kind and
   *  detail. Returns the args to append, or the refusal the shell sends. */
  validate?(ctx: VerbCtx, args: Record<string, unknown>): { args: Record<string, unknown> } | { error: string };
  /** Post-append hook, dispatched synchronously inside message()'s try/catch,
   *  after the broadcast and before bhv.onEntry. (Order proven identical to
   *  the unsplit file: onEntry no-ops for every hooked verb except `use`,
   *  whose reactToUse always ran first.) */
  after?(ctx: VerbCtx, entry: LogEntry): void;
};

// ---- validators (moved verbatim from server.ts's case "verb") --------------

// A grant's end, as typed: "30m", "2h", "1d", "1w" (also "90 min", "3 days").
const DURATION_RE = /^(\d{1,4})\s*(m|mins?|minutes?|h|hrs?|hours?|d|days?|w|weeks?)$/i;
const DURATION_UNIT: Record<string, number> = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 };
/** The longest a timed grant may run — beyond a year, say "no end" instead. */
const MAX_GRANT_MS = 366 * 86_400_000;
export function parseGrantDuration(s: string): number | null {
  const m = DURATION_RE.exec(s.trim());
  if (!m) return null;
  const ms = Number(m[1]) * DURATION_UNIT[m[2]!.toLowerCase()[0]!]!;
  return ms > 0 && ms <= MAX_GRANT_MS ? ms : null;
}

/** May a display name be a record's KEY? Not when it could be read as
 *  something else: the wildcard, a reserved actor, or a subject string (a
 *  record under "human:discord:1" belonging to someone else would make every
 *  later edit of it look like a request about that subject). */
function fileableName(n: string): boolean {
  return !!n && n !== "*" && !/^world$/i.test(n) && !/^bhv:/i.test(n) && !SUB_RE.test(n) && !/[\u0000-\u001f\u007f]/.test(n);
}

function vGrant(ctx: VerbCtx, args: Record<string, unknown>) {
  const { w } = ctx;
  const now = Date.now();
  // shape-check before it becomes history: {id, role?, gen?, fly?, until?|for?, revoke?}
  // A durable subject string may be longer than a display name.
  const rawId = String(args.id ?? "");
  let id = rawId.slice(0, SUB_RE.test(rawId) ? 128 : 64);
  const role = args.role != null ? String(args.role) : undefined;
  const gen = args.gen != null ? Boolean(args.gen) : undefined;
  // The flight capability, orthogonal to the ladder exactly like gen, and
  // whitelisted here for the same reason everything else is: this validator
  // decides what may become history, so an arg it does not name is dropped
  // before the fold ever sees it.
  const fly = args.fly != null ? Boolean(args.fly) : undefined;
  // The caption deed: `caption: "<entityId>"` binds authority to caption that
  // one entity, resolved HERE to its creation generation so the deed dies
  // with the object; `caption: null` revokes. Anything else is refused
  // before it can become history.
  let caption: { id: string; born?: number } | null | undefined;
  if (args.caption === null) caption = null;
  else if (args.caption !== undefined) {
    const target = String(args.caption ?? "").slice(0, 64);
    const ent = target ? (w.state.entities as Record<string, { born?: number } | undefined>)[target] : undefined;
    if (!target || !ent) return { error: `grant caption wants the id of an entity that exists here (got ${JSON.stringify(args.caption)})` };
    caption = { id: target, ...(ent.born != null ? { born: ent.born } : {}) };
  }
  // TIME: `for: "2h"` (a duration, resolved HERE to an absolute instant so
  // the log is deterministic), or `until: <epoch ms>`, or `until: null` to
  // clear an end. Absent keeps whatever end the record had.
  let until: number | null | undefined;
  if (args.for != null && args.until !== undefined) return { error: "grant takes for (a duration) or until (an instant), not both" };
  if (args.for != null) {
    const ms = parseGrantDuration(String(args.for));
    if (ms == null) return { error: `grant for wants a duration like "30m", "2h", "1d" or "1w", up to a year (got ${JSON.stringify(args.for)})` };
    until = now + ms;
  } else if (args.until === null) until = null;
  else if (args.until !== undefined) {
    const n = Number(args.until);
    if (!Number.isFinite(n) || n <= now) return { error: "grant until wants a moment in the future, in epoch milliseconds" };
    if (n - now > MAX_GRANT_MS) return { error: "grant until is more than a year away — leave the end off instead" };
    until = Math.round(n);
  }
  // REVOKE: the record goes; its holder falls back to the world's default.
  const revoke = args.revoke === true;
  if (revoke && (role != null || gen != null || fly != null || caption !== undefined || until !== undefined)) {
    return { error: "revoke stands alone: grant {id, revoke: true}" };
  }
  if (!id || (!revoke && role == null && gen == null && fly == null && caption === undefined && until === undefined) || (role != null && ROLE_RANK[role] == null)) {
    return { error: "grant wants {id, role: owner|builder|visitor|spectator|none} and/or {gen: true|false} and/or {fly: true|false} and/or {caption: \"<entityId>\"|null}, optionally {for: \"2h\"} or {until: <ms>|null}; or {id, revoke: true}" };
  }
  const roles = (w.state.roles ?? {}) as Record<string, { role?: string; sub?: string; until?: number } | undefined>;
  if (id === "*") {
    if (caption) return { error: "the caption deed is granted to one captioner, not to everyone" };
    if (role === "owner") {
      return { error: "everyone cannot own a world" };
    }
    if (until != null) return { error: "the wildcard can't expire — a closed world would quietly open when it did; give individuals a time instead" };
    if (role != null && ROLE_RANK[role]! < ROLE_RANK.visitor && !worldHasOwner(w.state)) {
      return { error: "a world with no owner is open to everyone — it needs an owner before it can be closed" };
    }
  }
  // WHO: the durable subject this grant is about.
  //   · A record already filed under this exact name KNOWS its person: its
  //     own sub, whatever any directory says (review: a directory lookup
  //     here once returned a different person's sub, and the fold — which
  //     touches every record carrying the sub — deleted THEIR record, an
  //     owner's included). A name-keyed record (no sub) is bound to the
  //     person standing here under that name, if one is: authority follows
  //     the person, not the nick.
  //   · No record under the name: the person present, else a subject string
  //     typed directly, else the directory of identities this instance has
  //     seen (one match binds; several are refused; none stays by name).
  let sub: string | undefined;
  const named = id;   // what the owner typed, before a subject string is re-filed under its name below
  // A SUBJECT STRING IS A SUBJECT, before anything else: the owner panel adds
  // a directory pick by its sub, and a display name can be set to look exactly
  // like one — so name lookups (a present namesake, a record under that name)
  // must never get the first say over it (Greptile #258: a visitor named
  // "human:discord:…" would have received the pick's grant, owner included).
  const explicit = id !== "*" && SUB_RE.test(id);
  const rec = id !== "*" && !explicit ? roles[id] : undefined;
  const present = id !== "*" && !explicit ? [...w.clients].find((o) => o.id === id && o.sub) : undefined;
  if (id === "*") sub = undefined;
  else if (explicit) {
    sub = id;
    // A subject that already HAS a record keeps it where it is: re-filing it
    // under the person's newest name could merge it into a name-only record
    // already there — whose role (owner, say) the fold would carry over
    // (Greptile #258: a time edit made a renamed member an owner). A NEW
    // record is filed under the person's last-seen name, unless that name
    // could be mistaken for something else (`*`, a reserved actor, another
    // subject string): then under the subject itself (a member named "*"
    // once made a revoke-by-subject hit the wildcard).
    // …exactly one, though: a world written before the one-record migration
    // can hold several for a subject, and rightsIn deliberately reads that
    // ambiguity as the wildcard. Continuing any ONE of them would resurrect
    // its fields (an old owner role, say — Greptile #258), so a grant asks
    // for a clean slate; a revoke removes them all (the fold drops every
    // record carrying the subject).
    const owns = Object.keys(roles).filter((k) => roles[k]?.sub === sub);
    if (owns.length > 1 && !revoke) {
      return { error: `${sub} has more than one grant here from older history (${owns.join(", ")}) — revoke it, then grant again` };
    }
    if (owns.length === 1) id = owns[0]!;
    else if (!owns.length) {
      const p = principalOf(id);
      if (p && fileableName(p.name)) id = p.name.slice(0, 64);
    }
  }
  else if (rec) {
    // …unless someone ELSE stands here under that name: the owner may mean
    // the person in front of them or the one the record names, so neither
    // is guessed — refused, and the refusal says whose record it is.
    if (rec.sub && present?.sub && present.sub !== rec.sub) {
      return { error: `"${id}" already carries a grant bound to another subject (${rec.sub}) — revoke or move that record before granting ${id} anew` };
    }
    // …or a name-only record would be bound to someone standing here who
    // already has their OWN record under another name: the fold would merge
    // the two, carrying the name-only record's role over theirs. Which one
    // the owner means is not guessed.
    // (A revoke is never ambiguous here: it removes only the name-only record,
    // and the person's own grant is untouched — Greptile #258.)
    if (!rec.sub && present?.sub && !revoke) {
      const own = Object.keys(roles).find((k) => k !== id && roles[k]?.sub === present.sub);
      if (own) return { error: `"${id}" is listed by name only, and the ${id} standing here already has their own grant (as "${own}") — revoke one of the two first` };
    }
    sub = rec.sub ?? present?.sub;
  }
  else if (present?.sub) sub = present.sub;
  else {
    const known = resolveName(id);
    if (known.length === 1) sub = known[0]!.sub;
    else if (known.length > 1) {
      return { error: `more than one "${id}" has been here (${known.map((k) => k.sub).join(", ")}) — grant by subject instead: grant {id: "<subject>", …}` };
    }
  }
  // …and never over another subject's record: the fold would relabel that
  // principal's authority as this one's, so it fails closed there and the
  // door says why here (shared/fold.js grant)
  if (sub && !revoke) {
    const occupant = roles[id];
    if (occupant?.sub && occupant.sub !== sub) {
      return { error: `"${id}" already carries a grant bound to another subject (${occupant.sub}) — revoke or move that record before granting ${id} anew` };
    }
  }
  // The record this grant touches: the one filed under exactly the name the
  // owner typed; otherwise the one CARRYING the subject (an older name of the
  // same person). Never a record that merely sits under the subject's current
  // display name — that can be another person's (Greptile #258: a revoke by
  // subject once took a different member's record whose name collided).
  // The wildcard is its own record: `revoke *` takes the door back to the
  // world's default (Greptile #258 caught this lookup skipping it). A subject
  // string never matches by key — a display name can be made to look like one.
  const key = named === "*" ? (roles["*"] ? "*" : undefined)
    : rec ? named : sub ? Object.keys(roles).find((k) => roles[k]?.sub === sub) : undefined;
  const target = key ? roles[key] : undefined;
  if (until != null && (role === "owner" || (role == null && target?.role === "owner"))) {
    return { error: "ownership doesn't expire — grant builder for a time, or revoke ownership later" };
  }
  if (revoke && !target) {
    return { error: `"${id}" has no grant here to revoke — they already have this world's default` };
  }
  const out: Record<string, unknown> = revoke
    ? { id: key ?? id, revoke: true, ...(target?.sub ? { sub: target.sub } : {}) }
    : { id, ...(role != null ? { role } : {}), ...(gen != null ? { gen } : {}),
        ...(fly != null ? { fly } : {}), ...(caption !== undefined ? { caption } : {}),
        ...(sub ? { sub } : {}), ...(until !== undefined ? { until } : {}) };
  // THE RESULT, CHECKED: fold this grant into a copy and look at the world it
  // would leave. Checking only the one record named let a grant whose sub
  // merged away another record slip past (review), so the guards read the
  // outcome, not the request.
  const before = w.state as unknown as Record<string, unknown>;
  const after = { ...before, roles: structuredClone(w.state.roles ?? {}) } as unknown as WorldState;
  foldEntry(after, { seq: -1, ts: now, actor: ctx.c.id, verb: "grant", args: out } as LogEntry);
  const starAfter = ROLE_RANK[String((after.roles as Record<string, { role?: string }>)?.["*"]?.role ?? "builder")] ?? 0;
  const closed = entryRestrictedIn(before as any) || starAfter < ROLE_RANK.visitor;
  //  · a closed world keeps an owner — with none it would read as ownerless,
  //    and an ownerless world is open to everyone
  if (closed && worldHasOwner(w.state) && !worldHasOwner(after)) {
    return { error: `that would leave "${w.name}" with no owner while it's closed to others — and a world with no owner is open to everyone; grant another owner first, or open the world` };
  }
  //  · nobody shuts themselves out by accident (an operator cannot be shut out)
  const me = whoOf(ctx.c as unknown as { id: string; sub?: string; nameReserved?: boolean });
  if (!isAdminId(me.id, me.sub) && !canEnter({ name: w.name, state: after }, me, "embody", now).ok) {
    const mine = roles[ctx.c.id];
    const hint = !me.sub && !me.nameReserved
      ? " — sign in first: a typed name can't hold a closed world's door"
      : mine && !mine.sub ? ` — your own grant here is filed by name only; grant {id: "${ctx.c.id}", role: "owner"} first binds it to you` : "";
    return { error: `that would shut you out of "${w.name}"${hint}` };
  }
  return { args: out };
}

/** After a grant folds, send each present participant the server's effective
 * rights for THEM. Clients consume an answer, not a second precedence model.
 * This reaches wildcard and durable-sub changes that a name-only delta merge
 * cannot represent. The log entry remains the durable cause; this is its
 * personalized live projection. */
function afterGrant(ctx: VerbCtx, entry: LogEntry) {
  // …and the same pass removes whoever may no longer be here (a world just
  // closed, a member revoked). One implementation with the expiry sweep:
  // access.ts settleAccess.
  settleAccess(ctx.w as unknown as AccessWorld, ctx.expel as unknown as Expel, Date.now(),
    { seq: entry.seq, by: `by ${ctx.c.id}` });
  // Tell the GRANTER what the grant actually did — whom it bound to. A name
  // is not a person, and an owner granting "bob" deserves to see which bob
  // (review: otherwise a squatted display name is bound silently).
  const a = entry.args as { id?: string; sub?: string; role?: string; revoke?: boolean };
  const w = ctx.w;
  const lines: string[] = [];
  const closed = entryRestrictedIn(w.state as any);
  if (a.id && a.id !== "*" && a.revoke) {
    lines.push(`revoked ${a.id}'s grant${a.sub ? ` (${a.sub})` : " (filed by name)"} — they now have this world's default`);
  } else if (a.id && a.id !== "*") {
    if (a.sub) {
      const p = principalOf(a.sub);
      lines.push(`${a.id}'s grant is bound to ${a.sub}${p ? ` (${p.kind}, last here as "${p.name}")` : ""}`);
    } else if (closed) {
      lines.push(`${a.id} is listed by name only: that lets in an agent called ${a.id}, but not a person — nobody called ${a.id} has signed in here yet. Once they have, revoke and grant again (it then binds to them), or grant by their subject`);
    }
  }
  if (a.id === "*" && closed) {
    const byName = Object.entries(w.state.roles ?? {}).filter(([k, r]) => k !== "*" && r && !r.sub).map(([k]) => k);
    if (byName.length) lines.push(`listed by name only, so these get in only if they're agents with that name: ${byName.join(", ")} — for a person, revoke and grant again once they've signed in, or grant by subject`);
  }
  if (lines.length) {
    try { ctx.c.ws.send(JSON.stringify({ type: "mod", text: lines.join("\n") })); } catch { /* the grant stands regardless */ }
  }
}

function vForce(_ctx: VerbCtx, args: Record<string, unknown>) {
  // shape-check before it becomes history: {at:[x,y,z], radius?,
  // power?}. Bounded HARD — the receiver caps what it applies to
  // itself, but the log should never carry a number that reads as a
  // weapon, and a replayed entry must be as harmless as a live one
  // is consensual.
  const at = Array.isArray(args.at) ? (args.at as unknown[]).map(Number) : null;
  if (!at || at.length !== 3 || at.some((n) => !Number.isFinite(n))) {
    return { error: "force wants {at: [x,y,z], radius?, power?}" };
  }
  const radius = Math.min(30, Math.max(0.5, Number(args.radius ?? 4)));
  const power = Math.min(12, Math.max(0.2, Number(args.power ?? 3)));
  return { args: { at, radius, power } };
}

function vPunt(ctx: VerbCtx, args: Record<string, unknown>) {
  const { w, c } = ctx;
  // shape-check before it becomes history: {id, dir?, power?}. The
  // target must exist, the power is bounded, and the kicker must be
  // NEAR the thing — an arm's-length act like /push, checked here
  // because agents reach this verb with no client-side gate. The
  // object's LIVE position counts (a leased ball is where its sim
  // says, not where the log left it).
  const id = String(args.id ?? "").slice(0, 64);
  if (!id || !w.state.entities[id]) {
    return { error: `nothing here called "${id}" to kick` };
  }
  // live position, most-authoritative first: a sim-owned flight, then a
  // leased volunteer's stream, then the log's word
  const at = w.sim.bodies[id]?.p ?? w.leases.get(id)?.lastState?.p ?? w.state.entities[id].pos;
  const me = (c.lastPose as { p?: number[] } | null | undefined)?.p;
  if (!me || Math.hypot(me[0] - at[0], me[2] - at[2]) > 4) {
    w.debug("denied", { who: c.id, verb: "punt", why: `${id} is out of reach` });
    return { error: `${id} is too far away to kick` };
  }
  const power = Math.min(10, Math.max(0.5, Number(args.power ?? 5)));
  const dir = Array.isArray(args.dir) ? (args.dir as unknown[]).slice(0, 3).map(Number) : null;
  const dirOk = dir && dir.length === 3 && dir.every(Number.isFinite) && dir.some((v) => v !== 0);
  // Dialect 3 (PROTOCOL_v2, Covenant III): under an epoch the sim owns the
  // flight, and the sim may read NOTHING off the presence plane — so the
  // intent must carry its whole vector, or it is refused at the door
  // rather than logged as an entry the sim will treat as inert.
  if (w.state.epoch && !dirOk) {
    return { error: "this world runs a deterministic sim — punt needs dir: [x, y, z] (the intent carries its whole vector)" };
  }
  return { args: { id, power, ...(dirOk ? { dir } : {}) } };
}

function vComp(ctx: VerbCtx, args: Record<string, unknown>) {
  const { w, c } = ctx;
  // shape-check before it becomes history: {id, type, data|null}.
  // data is opaque but BOUNDED — components are parameters, not
  // payloads; anything bigger belongs in /upload + a path here.
  const id = String(args.id ?? "").slice(0, 64);
  const type = String(args.type ?? "").slice(0, 32);
  if (!id || !type) {
    w.debug("rejected", { who: c.id, verb: "comp", why: "malformed — wants {id, type, data|null}" });
    return { error: "comp wants {id, type, data|null}" };
  }
  // `captions` is server-written: it folds from the `caption` verb, whose
  // deed and dedupe would mean nothing if any builder could overwrite the
  // bag by hand. One writer path (shared/captions.js).
  if (type === "captions") {
    w.debug("rejected", { who: c.id, verb: "comp", why: `type captions is server-written on ${id}` });
    return { error: `"captions" is written by the caption verb, not by comp — grant a captioner the deed (grant {id, caption: "${id}"}) and let it write` };
  }
  // The cap is 8192 CHARACTERS of the data's JSON (String.length: UTF-16
  // code units), not bytes — 8192 characters of CJK is ~24 KB on the wire
  // and still fits. One unit for every size cap in this file, and for the
  // captions bag's bounds (shared/captions.js), so the numbers compare.
  if (args.data !== undefined && args.data !== null
    && JSON.stringify(args.data).length > 8192) {
    w.debug("rejected", { who: c.id, verb: "comp", why: `data too large (8192 chars of JSON max) on ${id}.${type}` });
    return { error: "component data too large (8192 characters of JSON max) — put big things in /upload and reference the path" };
  }
  return { args: { id, type, data: args.data ?? null } };
}

/** One caption line, or the screen going quiet. Shape by the shared meaning
 *  module; then the dedupe and session order against the FOLDED bag, so a
 *  duplicate/old n, a stale session, or an end for the wrong session is
 *  refused before it can become history — a resend after a lost receipt
 *  never writes twice. */
function vCaption(ctx: VerbCtx, args: Record<string, unknown>) {
  const { w, c } = ctx;
  const n = normalizeCaptionArgs(args);
  if (!n.ok) {
    w.debug("rejected", { who: c.id, verb: "caption", why: n.why });
    return { error: n.why };
  }
  const ent = (w.state.entities as Record<string, { comp?: { captions?: unknown } } | undefined>)[n.args.id];
  if (!ent) return { error: `"${n.args.id}" is not here — nothing to caption` };
  // the leg's generation is the SERVER's word (a client-supplied one was
  // already dropped by the shape): who the captioner is, is who holds the
  // live leg, and the bag follows it. The OWNER (and operators) recover a
  // screen regardless of which leg holds it: their entry is stamped with the
  // bag's own generation, and their `end` ends whatever session is current —
  // written into the entry, so the fold sees the same override the door did.
  const bag = ent.comp?.captions as { gen?: number; session?: string } | undefined;
  const rights = rightsOf(w.state, c.id, c.sub);
  const override = ROLE_RANK[rights.role] >= ROLE_RANK.owner;
  const legGen = c.legGen ?? c.gen ?? 0;
  const stamped = { ...n.args, gen: override && bag ? Math.max(legGen, Number(bag.gen) || 0) : legGen } as Record<string, unknown>;
  if (override && bag && n.args.end && bag.session) stamped.session = bag.session;
  const why = captionRefusal(ent.comp?.captions, stamped);
  if (why) {
    w.debug("rejected", { who: c.id, verb: "caption", why });
    return { error: why };
  }
  return { args: stamped };
}

function vMount(ctx: VerbCtx, args: Record<string, unknown>) {
  const { w, c } = ctx;
  const id = String(args.id ?? "").slice(0, 64);
  const to = String(args.to ?? "").slice(0, 64);
  if (!id || !to || id === to || !w.state.entities[to]) {
    w.debug("rejected", { who: c.id, verb: "mount",
      why: !w.state.entities[to] ? `no entity "${to}" to mount onto` : "malformed mount" });
    return { error: "mount wants {id, to: <existing entity>, slot?, offset?, yaw?}" };
  }
  return { args };   // shape passed — a mount's slot/offset/yaw ride as sent
}

function vModerate(ctx: VerbCtx, args: Record<string, unknown>, verb: "kick" | "ban" | "unban") {
  const { w, c } = ctx;
  // Moderation verbs: {id, reason?}. Owner-rank, checked by the shell like
  // grant. Shape-checked and TARGET-checked before they become
  // history: no self-moderation, no wildcard, and the power ladder
  // does not eat itself — operators are untouchable, and one owner
  // cannot ban another (a WORLD_ADMIN can; that is what it is for).
  const id = String(args.id ?? "").trim().slice(0, 64);
  if (!id || id === "*") {
    return { error: `${verb} wants {id, reason?} — a specific participant, not everyone` };
  }
  if (id.toLowerCase() === c.id.toLowerCase()) {
    return { error: "you cannot moderate yourself" };
  }
  // The durable principal, when the target is standing right here —
  // a ban keyed only to a display name is evaded by /name; carrying
  // the sub makes it stick to the person, not the label.
  const targetC = [...w.clients].find((o) => o.id.toLowerCase() === id.toLowerCase());
  const targetSub = targetC?.sub;
  if (!isAdminId(c.id, c.sub)) {
    if (isAdminId(id, targetSub)) {
      return { error: `${id} is a world operator — operators cannot be ${verb === "kick" ? "kicked" : "banned"}` };
    }
    if (verb !== "unban" && rightsOf(w.state, id, targetSub).role === "owner") {
      return { error: `${id} also owns this world — owners cannot ${verb} each other (a WORLD_ADMIN can)` };
    }
  }
  const reason = args.reason != null ? String(args.reason).slice(0, 200) : undefined;
  return { args: { id, ...(reason ? { reason } : {}), ...(verb === "ban" && targetSub ? { sub: targetSub } : {}) } };
}

function vBehavior(ctx: VerbCtx, args: Record<string, unknown>) {
  const { w, c } = ctx;
  // Bind a runtime script: {id, src, attach?, caps?, knobs?} or
  // {id, remove: true}. src must be a content-addressed script
  // upload — the binding pins exact bytes, so replay is exact.
  const id = String(args.id ?? "").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 48);
  if (!id) return { error: "behavior wants {id, src|remove}" };
  if (args.remove) return { args: { id, remove: true } };
  // runtime "client" = a MOD OFFER (docs/leases.md §self-animation):
  // code visitors may choose to run in their own clients, each by
  // per-script consent. Publishing code for OTHERS' machines is an
  // owner act — a stricter gate than binding a sandboxed behavior.
  const runtime = args.runtime != null ? String(args.runtime) : undefined;
  if (runtime !== undefined && runtime !== "client") {
    return { error: 'behavior runtime must be "client" (or absent for the server sandbox)' };
  }
  if (runtime === "client" && ROLE_RANK[rightsOf(w.state, c.id, c.sub).role] < 2 && !isAdminId(c.id, c.sub)) {
    w.debug("denied", { who: c.id, verb: "behavior", why: "client-runtime mods are owner-only" });
    return { error: "offering mods to visitors' clients is for this world's owner" };
  }
  const src = String(args.src ?? "");
  // OPT_DIR = <root>/assets/opt — the same path the unsplit check spelled out
  if (!/^store\/scripts\/[a-f0-9]{16}\.js$/.test(src) || !existsSync(join(OPT_DIR, src))) {
    w.debug("rejected", { who: c.id, verb: "behavior", why: `no such script: ${src} — upload with POST /upload?as=script first` });
    return { error: "src must be an uploaded script path (POST /upload?as=script → store/scripts/<hash>.js)" };
  }
  const nBehaviors = Object.keys(w.state.behaviors ?? {}).length;
  if (!w.state.behaviors?.[id] && nBehaviors >= behaviorLimits.MAX_BEHAVIORS_PER_WORLD) {
    return { error: `this world already runs ${nBehaviors} behaviors (cap ${behaviorLimits.MAX_BEHAVIORS_PER_WORLD})` };
  }
  const attach = args.attach != null ? String(args.attach).slice(0, 64) : undefined;
  if (attach && !w.state.entities[attach]) {
    return { error: `nothing here called "${attach}" to attach to` };
  }
  if (args.knobs != null && JSON.stringify(args.knobs).length > 4096) {
    return { error: "knobs too large (4096 characters of JSON max)" };
  }
  const capsIn = (args.caps ?? {}) as Record<string, unknown>;
  const caps = {
    ...(Array.isArray(capsIn.verbs) ? { verbs: capsIn.verbs.map(String).slice(0, 16) } : {}),
    ...(capsIn.selfOnly != null ? { selfOnly: Boolean(capsIn.selfOnly) } : {}),
  };
  return { args: { id, src, ...(attach ? { attach } : {}),
    ...(runtime === "client" ? { runtime: "client" } : {}),
    ...(Object.keys(caps).length ? { caps } : {}),
    ...(args.knobs != null ? { knobs: args.knobs } : {}) } };   // author = entry.actor, never client-supplied
}

function vSay(_ctx: VerbCtx, args: Record<string, unknown>) {
  // (#57 B1: a presence-derived spoken stamp — "author has a live voice leg,
  // so mark the say spoken" — was prototyped and rejected in review: a live
  // voice leg proves capability, not that THIS utterance was performed. Its
  // replacement is the `attest` receipt path in server.ts; clients
  // hold-then-fallback on `performed` receipts, and `spoken` below remains
  // author-controlled DISPLAY metadata that never decides performance.)
  // Spoken-say protocol: `spoken`/`utt`/`t0` are display metadata for
  // a voice that already performed as captions. t0 is a REORDER key
  // on every client, so it is never trusted raw — it exists only
  // inside the spoken protocol, must be finite, and is clamped to a
  // bounded utterance window ending at arrival. Ordinary says get all
  // three stripped: a confused client degrades to normal chat rather
  // than breaking.
  const a = args as Record<string, unknown>;
  const now = Date.now();
  const MAX_UTTER_MS = 300_000;
  const uttN = Number(a.utt);
  const t0N = Number(a.t0);
  if (a.spoken === true && Number.isSafeInteger(uttN) && uttN >= 0) {
    a.spoken = true;
    a.utt = uttN;
    if (Number.isFinite(t0N)) {
      a.t0 = Math.min(now, Math.max(now - MAX_UTTER_MS, t0N));
    } else delete a.t0;
  } else { delete a.spoken; delete a.utt; delete a.t0; }
  return { args };
}

// ---- after hooks (moved verbatim from the six post-append sites) -----------

function afterComp(ctx: VerbCtx, entry: LogEntry) {
  const type = String((entry.args as Record<string, unknown>).type ?? "");
  // a folded motion that can't move is a silence someone will debug
  // at 4am — lint it into the recorder while the fold is still warm
  if (/^motion(:|$)/.test(type)) lintMotion(ctx.w, entry);
  // Same courtesy for an emitter that won't emit: an unknown preset or
  // a clamped parameter is a silence the author would otherwise have
  // to discover by asking someone with a GPU what they can see.
  // (`particles:<name>` too — every emitter key — and a malformed
  // `particles:…` key gets told why it isn't one.)
  if (type === "particles" || type.startsWith("particles:")) lintParticles(ctx.w, entry);
}

function afterModerate(ctx: VerbCtx, entry: LogEntry) {
  // A ban or kick lands NOW on every matching body, not at some future
  // join — the fold recorded the fact; this is the fact taking effect.
  const { c } = ctx;
  const args = entry.args as { id: string; sub?: string; reason?: string };
  const tid = String(args.id).toLowerCase();
  const tsub = args.sub;
  const treason = args.reason;
  const w = ctx.w;
  for (const other of [...w.clients]) {
    if (other === c) continue;
    if (other.id.toLowerCase() !== tid && !(tsub && other.sub === tsub)) continue;
    ctx.expel(w, other, entry.verb === "ban"
      ? `you were banned from "${w.name}" by ${c.id}${treason ? ` — ${treason}` : ""}`
      : `you were removed from "${w.name}" by ${c.id}${treason ? ` — ${treason}` : ""}`);
    console.log(`[world:${w.name}] ${other.id} ${entry.verb === "ban" ? "banned" : "kicked"} by ${c.id}${treason ? ` (${treason})` : ""}`);
  }
}

// ---- the table itself ------------------------------------------------------
// rank/gen stay single-sourced in rights.ts's VERB_NEEDS (the behavior gate
// reads the same numbers); each row here only adds what the shell dispatches.

/** Under a live epoch the sequencer stamps the model's box into the spawn
 *  entry (eidosim@0.3.0 folds it — PROTOCOL_v2 Covenant III: the sim reads
 *  geometry from history, never from an asset). The client's word on a box
 *  is discarded: asset facts are the sequencer's to write. Outside an epoch
 *  the log is unchanged — an epoch entered later stamps `boxes` for every
 *  standing lib itself. The cache is warmed on the wire before this runs
 *  (messages.ts); a lib it cannot summarize simply spawns boxless. */
function vSpawn(ctx: VerbCtx, args: Record<string, unknown>) {
  const { box: _clientBox, ...rest } = args;
  const live = ctx.w.sim.epoch as { foreign?: boolean } | null;
  if (!live || live.foreign || typeof rest.lib !== "string") return { args: rest };
  const box = boxOf(rest.lib);
  return { args: box ? { ...rest, box } : rest };
}

function vLight(ctx: VerbCtx, args: Record<string, unknown>) {
  const error = lightArgsError(args);
  if (error) {
    ctx.w.debug("rejected", { who: ctx.c.id, verb: "light", why: error });
    return { error };
  }
  // Keep the sparse bag: the fold merges partial updates with a standing light.
  return { args };
}

const extras: Record<string, Pick<VerbRow, "selfRankZero" | "validate" | "after">> = {
  say: { validate: vSay },
  caption: { validate: vCaption },
  spawn: { validate: vSpawn },
  light: { validate: vLight },
  // A `use` is a cause; reactions turn it into logged effects.
  use: { after: (ctx, entry) => reactToUse(ctx.w, entry) },
  mount: { selfRankZero: true, validate: vMount },
  dismount: { selfRankZero: true },
  grant: { validate: vGrant, after: afterGrant },
  force: { validate: vForce },
  punt: { validate: vPunt },
  // Entering the deterministic-sim epoch (PROTOCOL_v2 §3). The sim named
  // must be one THIS build carries — authoring an epoch nobody can compute
  // would orphan the world's physics on its own sequencer. The after-hook
  // folds the barrier snapshot the spec requires around epoch boundaries.
  epoch: {
    validate: (ctx, args) => {
      const stashLive = () => {
        // Stash the live bodies NOW — by the time the after-hook runs, the
        // folded epoch entry has already cleared them.
        const held = Object.entries(ctx.w.sim.bodies as Record<string, { p: number[]; yaw?: number }>)
          .map(([id, b]) => ({ id, p: [...b.p], yaw: typeof b.yaw === "number" ? b.yaw : 0 }));
        epochRelease.set(ctx.w, held);
      };
      if (args.sim === null) {
        // LEAVING the epoch (ruling tel0s 2026-09-01: explicit, never a
        // toggle). Every live body is released into the fold at its sim word
        // (the after-hook's epoch-release places), the barrier folds, and the
        // world is back on v1 semantics. Nothing to leave = refused pre-log.
        const live = ctx.w.sim.epoch as { foreign?: boolean } | null;
        if (!live) return { error: "this world is not under a sim epoch — nothing to leave" };
        stashLive();
        return { args: { sim: null } };
      }
      const sim = String(args.sim ?? "");
      const tickMs = Number(args.tickMs ?? 66);
      if (sim !== SIM_ID) return { error: `this sequencer carries ${SIM_ID} — epoch must name it exactly (or sim: null to leave)` };
      if (!Number.isInteger(tickMs) || tickMs < 16 || tickMs > 1000) {
        return { error: "epoch tickMs must be an integer in [16, 1000]" };
      }
      // IDEMPOTENT (tel0s, playtest 2026-08-31: ran /epoch twice): re-entering
      // the SAME epoch is refused before anything is logged — the entry would
      // clear every live body (a mid-flight barrel freezes in the air) and
      // reset the tick for no semantic gain. A different tickMs is a real
      // re-epoch and proceeds, with the release below.
      const live = ctx.w.sim.epoch as { sim?: string; tickMs?: number; foreign?: boolean } | null;
      if (live && !live.foreign && live.sim === sim && live.tickMs === tickMs) {
        return { error: `already under ${sim} at a ${tickMs}ms tick — nothing to re-enter (flights and rest poses stand)` };
      }
      stashLive();
      // eidosim@0.3.0: the epoch adopts the sequencer's word on the world's
      // geometry — lib → box for every model standing here at the barrier
      // (Covenant III; ruling tel0s 2026-09-01). Warmed on the wire before
      // this runs; a lib without a summary is left out and is no collider.
      const boxes: Record<string, unknown> = {};
      for (const lib of worldLibs(ctx.w.state)) { const b = boxOf(lib); if (b) boxes[lib] = b; }
      return { args: { sim, tickMs, boxes } };
    },
    after: (ctx) => {
      // A real re-epoch RELEASED every live body when its entry folded — but
      // the instant fold still holds their last AUTHORED positions, which by
      // now can be a spawn point a dozen punts ago. Commit each body’s last
      // sim word as a place (the same server-authored release the lease
      // table performs), so the fold, every client and every late joiner
      // agree where things actually stand instead of orphaning the meshes
      // where each client’s applier last drew them.
      for (const b of epochRelease.get(ctx.w) ?? []) {
        ctx.w.commit("world", "place", {
          id: b.id, pos: [+b.p[0].toFixed(4), +b.p[1].toFixed(4), +b.p[2].toFixed(4)],
          yaw: b.yaw, via: "epoch-release",
        });
      }
      epochRelease.delete(ctx.w);
      ctx.w.fold("epoch-barrier");
    },
  },
  comp: { validate: vComp, after: afterComp },
  motion: { after: (ctx, entry) => lintMotion(ctx.w, entry) },
  // ...and a (re)bind reconciles sandboxes before scripts hear anything else.
  behavior: { validate: vBehavior, after: (ctx) => ctx.w.bhv.sync() },
  kick: { validate: (ctx, args) => vModerate(ctx, args, "kick"), after: afterModerate },
  ban: { validate: (ctx, args) => vModerate(ctx, args, "ban"), after: afterModerate },
  unban: { validate: (ctx, args) => vModerate(ctx, args, "unban") },
};

export const VERBS: Record<string, VerbRow> = Object.fromEntries(
  Object.entries(VERB_NEEDS).map(([verb, needs]) => [verb, { ...needs, ...extras[verb] }]),
);

// ---- the shell -------------------------------------------------------------

/** The entire `case "verb"` body: preamble → validator → append+broadcast →
 *  after hooks, in exactly the unsplit order. `verb` and `rawArgs` are the
 *  wire values untouched — msg.verb and msg.args exactly as parsed. */
export function runVerb(ctx: VerbCtx, verb: string, rawArgs: unknown): void {
  const { w, c, now } = ctx;
  if (!c.world) return;
  // spectators watch; authoring needs a body. (This is the entire
  // show-night moderation model: the audience cannot touch the stage.)
  // B3 (#57): aux media legs ride the spectator flag, so this gate also means
  // an aux NEVER authors — not even say. The topology-A carve-out
  // (verified-aux-say, c1fdb11) let a voice leg author its own says; under
  // voice-leg-speaks-what-the-body-says the leg's only voice-shaped message
  // is `attest`, handled before the verb switch. Identity's token
  // authenticates the leg; identity's RIGHTS do not flow into a second
  // command path.
  if (c.spectator) {
    c.ws.send(JSON.stringify({ type: "error", error: "spectators can't author — join embodied to build" }));
    return;
  }
  if (now - c.verbWin > 4000) { c.verbWin = now; c.verbCount = 0; }
  if (++c.verbCount > VERB_RATE) {
    if (c.verbCount === VERB_RATE + 1) w.debug("rate-limit", { who: c.id });
    c.ws.send(JSON.stringify({ type: "error", error: "slow down — verb rate limit" }));
    return;
  }
  // A verb is a string. Property lookup would coerce anything else (a wire
  // verb of ["light"] finds the "light" row) past the checks below, which
  // test the verb's name, so nothing else reaches the table.
  if (typeof (verb as unknown) !== "string") {
    const why = "a verb is a string, such as \"light\"";
    w.debug("rejected", { who: c.id, verb: String(verb), why });
    c.ws.send(JSON.stringify({ type: "error", error: why }));
    return;
  }
  // verb allow-list + per-world rights (rights.ts owns the ladder).
  const row = VERBS[verb];
  if (!row) {
    w.debug("denied", { who: c.id, verb: String(verb), why: "verb not allowed" });
    // the refusal teaches the lanes: the verb set is closed ON PURPOSE
    // and each kind of extension has a designed door
    c.ws.send(JSON.stringify({ type: "error",
      error: `verb not allowed: ${verb} — the verb set is closed by design; extend state with comp {id, type, data}, interactions with use {id, action}, semantics with behavior scripts (see AGENTS.md). New verbs are protocol amendments.` }));
    return;
  }
  const selfMount = Boolean(row.selfRankZero)
    && String((rawArgs as Record<string, unknown> | undefined)?.id ?? "") === c.id;
  const needRank = selfMount ? 0 : row.rank;
  const rights = rightsOf(w.state, c.id, c.sub);
  // The caption deed sits with the rank gate: same teaching order (who may),
  // before locks and shapes. A visitor holding the deed passes here for
  // exactly one entity; a builder without it does not.
  const deedWhy = row.caption ? captionDeedRefusal(w.state, rights, rawArgs as Record<string, unknown> | undefined) : null;
  if (deedWhy) {
    w.debug("denied", { who: c.id, verb: String(verb), why: "no caption deed" });
    c.ws.send(JSON.stringify({ type: "error", error: deedWhy }));
    return;
  }
  if (ROLE_RANK[rights.role] < needRank || (row.gen && !rights.gen)) {
    const why = row.gen && ROLE_RANK[rights.role] >= row.rank
      ? "bringing new assets into this world needs the gen capability — ask its owner"
      : `"${verb}" needs ${row.rank >= 2 ? "the world's owner" : "builder rights"} here — you are a ${rights.role}`;
    w.debug("denied", { who: c.id, verb: String(verb), why });
    c.ws.send(JSON.stringify({ type: "error", error: why }));
    return;
  }
  // the guard gate sits AFTER rank (same teaching order) and BEFORE the
  // lock: a stranger's refusal should name who may author the thing, not
  // tell them to unlock something they may not touch
  const guardedWhy = guardRefusal(w.state, { id: c.id, sub: c.sub, role: rights.role }, verb, rawArgs as Record<string, unknown> | undefined);
  if (guardedWhy) {
    w.debug("denied", { who: c.id, verb: String(verb), why: "guarded" });
    c.ws.send(JSON.stringify({ type: "error", error: guardedWhy }));
    return;
  }
  // the lock gate sits AFTER rank (a visitor's refusal should teach
  // rank, not locks) and BEFORE shape-checks/append: a locked thing
  // refuses everyone identically, locker included
  const lockedWhy = lockRefusal(w.state, verb, rawArgs as Record<string, unknown> | undefined);
  if (lockedWhy) {
    w.debug("denied", { who: c.id, verb: String(verb), why: "locked" });
    c.ws.send(JSON.stringify({ type: "error", error: lockedWhy }));
    return;
  }
  let args = (rawArgs ?? {}) as Record<string, unknown>;
  if (row.validate) {
    const r = row.validate(ctx, args);
    if ("error" in r) {
      c.ws.send(JSON.stringify({ type: "error", error: r.error }));
      return;
    }
    args = r.args;
  }
  // The placer PRINCIPAL is the server's to write, never the client's: a
  // spawn or light carries the connection's display id and its durable
  // subject (when the door vouched for one), stamped here after validation
  // and stripped from whatever the client sent. A behavior bind records its
  // author's subject the same way, so a script's creations can freeze it.
  if (verb === "spawn" || verb === "light") {
    const { placer: _clientPlacer, ...rest } = args;
    args = { ...rest, placer: { id: c.id, ...(c.sub ? { sub: c.sub } : {}) } };
  } else if (verb === "behavior") {
    const { bySub: _clientSub, ...rest } = args;
    args = c.sub && !rest.remove ? { ...rest, bySub: c.sub } : rest;
  }
  // §24 entry bus: commit = append + publish (client fanout with the
  // authoritative echo, then behaviors — see events.ts's ordering ruling).
  // After-hooks run once the CAUSE is on the wire, so the effect entries
  // they commit publish in seq order.
  const entry = w.commit(c.id, verb, args);
  row.after?.(ctx, entry);
}
