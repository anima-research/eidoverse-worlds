// shared/protocol/authority/rights.js — rights, and the views over the log that say who did what and who is sanctioned
// (refactor C11, 2026-10-12; moved from authority.js's "rights", "views over the log" and "sanctions" sections unchanged).
// A leaf over storage (isE, opsQuiet) and the ladder in roles.js.
import * as R from "../roles.js";
import { CTX } from "./ctx.js";
import { followUpsOf, isE, opsQuiet, readback } from "./storage.js";
// The ladder, the closed permission list and the effective set live in shared/protocol/roles.js (the Sanctioned Society: ranked
// membership only; banned and ghost are states outside it). Every rank comparison in the authority goes through rankOf /
// whoRank below, so a custom role (any id an owner defined in @world.role-defs) stands where its rank says.
const RANK = R.RANK;
const wcOf = (st) => st.entities?.["@world"]?.c;
const ownersOf = (st) => { const c = st.entities?.["@world"]?.c ?? {}; return Object.keys(c).filter((k) => k.startsWith("roles:") && c[k]?.role === "owner"); };
// §2.3: an empty owner list means NOBODY above visitor. A world may declare a default role for strangers
// (`default-role`, what an imported world's `roles['*']` becomes); absence means visitor.
// a guest (no account) is never given the world's default role: it's for people who proved who they are. An owner
// may still grant a guest a role by its id (H4: an anonymous connection was a builder wherever default-role was)
// …unless the world opts guests in (`default-role.guests`, R 10-06): explicit, default visitor, never above the default role
function roleOf(st, actor, anon = CTX.isAnon(actor)) {
  const c = wcOf(st); if (!c) return "none";
  return R.roleIdOf(c, actor, { anon, owners: ownersOf(st).length > 0 });
}
/** Where a person stands on the ladder (a role the world doesn't define reads as visitor; legacy none as -1). */
const rankOf = (st, actor, anon) => R.rankOfRole(wcOf(st), roleOf(st, actor, anon));
/** The rank a `who` field names (physics.who, grabbable.who, a handler's or a seat's who): a role the world doesn't
 *  define (a custom role since deleted) reads as owner, so a who never opens to more people than it said. */
const whoRank = (st, name) => R.roleDef(wcOf(st), name)?.rank ?? RANK.owner;
/** Effective rights {role, name, rank, can, permissions} (roles.js effectiveOf). */
const effective = (st, actor, anon = CTX.isAnon(actor)) => R.effectiveOf(wcOf(st) ?? {}, actor, { anon, owners: ownersOf(st).length > 0 });
const may = (st, actor, sw) => roleOf(st, actor) === "owner" ? (sw !== "fly" || effective(st, actor).can.fly) : effective(st, actor).can[sw] === true;
/** Does this identity hold any power that acts on people (mute, kick, ban, pauseScripts)? Opens the moderation log. */
const modHolder = (st, who) => R.MOD_POWERS.some((k) => may(st, who, k));
export const effectiveIn = (st, actor, { anon = false } = {}) => R.effectiveOf(wcOf(st) ?? {}, actor, { anon, owners: ownersOf(st).length > 0 });
/** The role the authority gives `actor` in a folded state (a view: what a client should be told it may do here). */
export const roleIn = (st, actor, { anon = false } = {}) => roleOf(st, actor, anon);
// ---------- views over the log: who did what (L2: derived, never stored) ----------
const isScriptActor = (a) => typeof a === "string" && a.startsWith("script:");
// ---------- sanctions: views over the moderator log (research §5) ----------
// Every sanction is a record with an optional `until` (the authority's clock, ms). Expiry is computed, never written: a view
// reads the latest record of its pair and asks whether it's still in force NOW (w.now(): the authority's clock). Records
// name identities, never display names. A record without `until` (an imported world's ban, an owner's ban "until lifted",
// an old kick) is permanent for a ban and no cooldown for a kick.
// Every record since the last LIFT of its kind (unban, unmute, unghost) that is still in force counts, and the STRONGEST
// wins: a weaker record never cancels a stronger one (independent review 10-07: a moderator's 0.0001-day ban under an
// owner's permanent one used to replace it, the newest record alone being read). Lifting goes through personLift.
const latestOf = (w, who, verbs) => { let r = null; for (const m of w.mod) if (m.who === who && verbs.includes(m.verb)) r = m; return r; };
const inForce = (w, m) => !!m && (m.until === undefined || m.until > w.now());
const sinceLift = (recs, verb, lifts) => { let out = []; for (const m of recs) { if (lifts.includes(m.verb)) out = []; else if (m.verb === verb) out.push(m); } return out; };
const strongest = (a) => a.reduce((x, m) => (!x ? m : x.until === undefined ? x : m.until === undefined || m.until > x.until ? m : x), null);
const recsOf = (w, who) => w.mod.filter((m) => m.who === who);
/** The sanctions of one kind in force on `who` now, every one (a lift must be allowed over each). */
export function inForceOf(w, who, kind, recs = recsOf(w, who)) {
  const lifts = { ban: ["unban"], kick: ["unban"], mute: ["unmute"], ghost: ["unghost"] }[kind];
  return sinceLift(recs, kind, lifts).filter((m) => inForce(w, m) && (kind !== "kick" || m.until !== undefined));
}
const banFrom = (w, who, recs) => strongest(inForceOf(w, who, "ban", recs));
const kickFrom = (w, who, recs) => strongest(inForceOf(w, who, "kick", recs));
const muteFrom = (w, who, channel, recs) => { const all = inForceOf(w, who, "mute", recs); if (!all.length) return null;
  const channels = [...new Set(all.flatMap((m) => m.channels ?? ["voice", "chat"]))];   // the union: a voice-only mute never narrows a both-channel one
  // asked about one channel, the record, its end and its reason are the mutes that cover it, never a voice-only one for chat
  // (a caller that passes a channel reads only presence, until and reason; one that reads channels passes none, so a is all)
  const a = channel ? all.filter((m) => (m.channels ?? ["voice", "chat"]).includes(channel)) : all; if (!a.length) return null;
  const top = strongest(a); return { ...top, channels, until: a.some((m) => m.until === undefined) ? undefined : Math.max(...a.map((m) => m.until)) }; };
const ghostFrom = (w, who, recs) => strongest(inForceOf(w, who, "ghost", recs)) ?? (w.presence?.ghosts?.[who] ? { verb: "ghost", who, chosen: true, ts: w.presence.ghosts[who].ts } : null);
/** The ban in force on `who` (the strongest record), or null. */
export const banOf = (w, who) => banFrom(w, who, recsOf(w, who));
export const isBanned = (w, who) => !!banOf(w, who);
/** The kick whose cooldown still runs (they can't rejoin until m.until), or null. An unban ends it early. */
export const kickOf = (w, who) => kickFrom(w, who, recsOf(w, who));
/** The mute in force (channels: the union of every mute in force, until: the latest), or null; `channel` narrows it. */
export const muteOf = (w, who, channel) => muteFrom(w, who, channel, recsOf(w, who));
/** Ghost (PLAN 10-06: in the world, outside society): the sanction in force, else the mode its holder chose. */
export const ghostOf = (w, who) => ghostFrom(w, who, recsOf(w, who));
/** Everything in force now, per identity (the Moderation panel's Bans tab; the server's join, voice and ghost gates).
 *  One pass over the moderator log, so the server's sweep stays linear in it. */
export function sanctionsNow(w) {
  const by = new Map(); for (const m of w.mod) if (typeof m.who === "string") { let a = by.get(m.who); if (!a) by.set(m.who, (a = [])); a.push(m); }
  for (const k of Object.keys(w.presence?.ghosts ?? {})) if (!by.has(k)) by.set(k, []);
  const out = {}; for (const [x, recs] of by) { const b = banFrom(w, x, recs), k = kickFrom(w, x, recs), m = muteFrom(w, x, undefined, recs), g = ghostFrom(w, x, recs);
    if (b || k || m || g) out[x] = { ...(b ? { ban: b } : {}), ...(k ? { kick: k } : {}), ...(m ? { mute: m } : {}), ...(g ? { ghost: g } : {}) }; }
  return out;
}
// Who a change entry is "by": its cause's actor (the person whose request it was), and whose RIGHTS admitted it. Those
// differ for a `use`: the visitor pulled the lever, but the handler's author's rights made the change, and the act
// records that author (capability.author). Entries with no act for a cause (rests, genesis-era) are their own actor's.
function entryBy(w, e) {
  const c = w.entries[e.cause];
  const by = isE(c) && c.kind === "act" ? c.actor : e.actor;
  // a behaviour's results were admitted with its SPONSOR's rights (L4), which its act names (checkable from sponsorAt)
  // READBACK: a purged cause act no longer says whose rights admitted it (a handler's author? a script's sponsor?), so the
  // rights are unknown: null, which matches nobody. Never `by`: that would hand the visitor who pulled the lever the
  // handler author's thing (engine-scars 4, consent gaps G1 d)
  if (isE(c) && c.kind === "act") { const b = readback(w, e.cause);
    if (b === null) return { seq: e.seq, by, rights: null };
    return { seq: e.seq, by, rights: b.capability?.author || (isScriptActor(c.actor) && b.sponsor) || by }; }
  return { seq: e.seq, by, rights: by };
}
// The creator of a thing (comp undefined), or of component `comp` on it, in its CURRENT life: the entry that made it
// present after it was last absent. null if it isn't present now. { seq, by, rights }.
// The change entries that may touch `id`, newest first. A live world (server) keeps an index id → seqs so these
// views cost the thing's own history, not the whole log's; without one (the suites) every entry is a candidate.
function* backward(w, id) {
  if (w.touching) { const a = w.touching(id); for (let k = a.length - 1; k >= 0; k--) yield a[k]; return; }
  for (let i = w.entries.length - 1; i >= 0; i--) yield i;
}
// A follow-up set that put a value back (an undo's restore) also steps over the follow-up delete it reverses (review r10 M2),
// so the restored value keeps its author and its life; any write of the asker's own in between ends that (a key re-created
// by someone else after a clear is a new life, never merged with the old one).
export function creatorOf(w, id, comp) {
  let found = null, restored = false;
  for (const i of backward(w, id)) { const e = w.entries[i]; if (!isE(e) || e.kind !== "change") continue;
    const ops = opsQuiet(e); const fu = followUpsOf(e);
    for (let k = ops.length - 1; k >= 0; k--) { const o = ops[k]; if (o.id !== id) continue;
      if (o.verb === "set" && fu.has(k)) { if (o.comp === comp) restored = true; continue; }   // the authority's follow-up (a reference cleared or put back) authors nothing (review r9 H1)
      if (o.verb === "delete" && fu.has(k) && restored && comp !== undefined && (o.comp === comp || o.comp === undefined)) { restored = false; continue; }
      if (o.verb === "set" && o.comp === comp) restored = false;
      if (comp === undefined) { if (o.verb === "create") return entryBy(w, e); if (o.verb === "delete" && o.comp === undefined) return null; continue; }
      if (o.verb === "set" && o.comp === comp) found = e;
      else if ((o.verb === "delete" && (o.comp === comp || o.comp === undefined)) || o.verb === "create") return found && entryBy(w, found); } }
  return found && entryBy(w, found);
}
// Who last set (or deleted) component `comp` on a thing: { seq, by, rights, deleted } or null if nobody ever has.
export function lastSetterOf(w, id, comp) {
  let restored = false;
  for (const i of backward(w, id)) { const e = w.entries[i]; if (!isE(e) || e.kind !== "change") continue;
    const ops = opsQuiet(e); const fu = followUpsOf(e);
    for (let k = ops.length - 1; k >= 0; k--) { const o = ops[k]; if (o.id !== id || o.comp !== comp || o.verb === "create") continue;
      if (fu.has(k)) { if (o.verb === "set") { restored = true; continue; } if (restored) { restored = false; continue; } }   // r9 H1, r10 M2
      return { ...entryBy(w, e), deleted: o.verb === "delete" }; } }
  return null;
}
// Who made a thing: the view inspect shows (no stored `placer`).
const madeBy = (w, id) => creatorOf(w, id)?.by ?? null;

// (refactor split, 2026-10-17: moved here from authority.js's "the authority" section; request, undo and the hands' returns read it)
const RESERVED = new Set(["system", "sim", "world"]); // the authority's own identities: a request can never be stamped as one

export { RANK, RESERVED, backward, banFrom, effective, entryBy, ghostFrom, inForce, isScriptActor, kickFrom, latestOf, madeBy, may, modHolder, muteFrom, ownersOf, rankOf, recsOf, roleOf, sinceLift, strongest, wcOf, whoRank };
