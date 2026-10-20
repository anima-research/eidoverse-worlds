// shared/protocol/authority/moderation.js — acting on a person: the rule every person-act shares (personAct), lifting a
// sanction (personLift), and the moderation verbs (warn, mute/unmute, kick, ban/unban, ghost/unghost, modlog, bans) as
// MOD_VERBS, which authority.js spreads into VERBS where they stood (refactor split, 2026-10-17; moved from authority.js's
// "acting on a person" section and the VERBS table unchanged). Moderation is the separate moderator log (§2.1): nothing
// here writes the world log.
import { isIdentity } from "../fold.js";
import * as R from "../roles.js";
import { CTX } from "./ctx.js";
import { refuse, said } from "./refuse.js";
import { isE, opsQuiet } from "./storage.js";
import { banOf, effective, entryBy, inForceOf, may, modHolder, rankOf, roleOf, sanctionsNow, wcOf } from "./rights.js";

// ---------- acting on a person (research roles §6) ----------
const WARN_OR_MOD = (st, who) => modHolder(st, who) || roleOf(st, who) === "owner";
const reasonOf = (a) => (typeof a.reason === "string" && a.reason.trim() ? { reason: a.reason.slice(0, R.REASON_MAX) } : {});
/** A duration in minutes → until (the authority's ms). Capped below owner at `cap` (an owner may go past it only when ownerCap is false). */
function minutesUntil(w, actor, minutes, { cap, what, required = false, ownerCap = false }) {
  if (minutes === undefined) { if (required) refuse("shape", `${what} needs minutes (how long)`, `e.g. minutes: 5, 60 or 1440 (at most ${cap})`); return undefined; }
  if (!(typeof minutes === "number" && Number.isFinite(minutes) && minutes > 0)) refuse("shape", `${what}: minutes is a number above 0`, "");
  if (minutes > cap && (ownerCap || roleOf(w.state(), actor) !== "owner")) refuse("bounds", `${what} lasts at most ${cap} minutes${ownerCap ? "" : " (owners may go longer)"}`, `minutes: ${cap} or less`);
  return Math.floor(w.now() + minutes * 60000);
}
/** The rule every person-act shares: the switch (one of `powers`), an identity, someone ranked strictly below you.
 *  Returns {target: {role, rank}} for the reply. `noOwner`: this act refuses owners outright, with today's words. */
function personAct(w, actor, a, verb, powers, { noOwner } = {}) {
  const st = w.state();
  if (!isIdentity(a.who)) refuse("shape", `${verb} {who}: an identity (u-…); whois {name} finds it`, "", {});
  const me = effective(st, actor);
  if (!powers.some((k) => me.can[k])) refuse("rights", `${verb === "ban" ? "banning" : verb === "kick" ? "kicking" : verb === "ghost" ? "ghosting someone" : verb === "warn" ? "warning someone" : "muting someone"} needs ${powers.length > 1 ? `one of ${powers.join(", ")}` : powers[0]}; you are ${me.role}`, "ask a moderator or an owner", { needs: powers.join("|") });
  if (a.who === actor) refuse("rank", `you can't ${verb} yourself`, "");
  const them = roleOf(st, a.who, CTX.isAnon(a.who));
  if (noOwner && them === "owner") refuse("rights", `${said(a.who)} is an owner here; an owner can't be ${noOwner}`, "an owner made after them can be demoted first (roles:<them>); then act");
  const tr = rankOf(st, a.who, CTX.isAnon(a.who));
  if (tr >= me.rank) refuse("rank", `${said(a.who)} is ${R.roleDef(wcOf(st), them)?.name ?? them}; you (${me.name}) can't act on equal or higher ranks`, "ask someone ranked above them", { needs: "rank" });
  if (a.reason !== undefined && (typeof a.reason !== "string" || a.reason.length > R.REASON_MAX)) refuse("shape", `reason is text, up to ${R.REASON_MAX} characters`, "");
  return { target: { role: them, rank: tr } };
}
/** Lifting a sanction (unban, unmute, unghost): the permission, and the record's rule: an owner, its author, or someone
 *  who outranks its author (strict: unban, unmute) or stands at their rank or above (ghost: "lifted only at that rank or higher"). */
function personLift(w, actor, a, verb, recs, { strict, power = verb }) {
  const st = w.state(); if (!isIdentity(a.who)) refuse("shape", `un${verb} {who}`, "");
  if (!may(st, actor, power) && roleOf(st, actor) !== "owner") refuse("rights", `lifting a ${verb} needs ${power}; you are ${roleOf(st, actor)}`, "ask a moderator or an owner", { needs: power });
  if (a.who === actor) refuse("rank", `you can't lift a ${verb} on yourself`, "ask someone ranked above whoever made it");   // review 10-07
  // a lift ends every record of its kind in force, so it must be allowed over each one (stacked sanctions: review 10-07);
  // with none in force (never made, or already ended) there is nothing to lift, and nothing is logged
  const inForce = Array.isArray(recs) ? recs : recs ? [recs] : [];
  if (!inForce.length) refuse("nothing", `${said(a.who)} has no ${verb === "ban" ? "ban or kick" : verb} in force here`, "modlog shows the sanctions in force; one that has ended needs no lifting");
  for (const rec of inForce) {
  if (roleOf(st, actor) === "owner" || rec.actor === actor) continue;
  const mine = rankOf(st, actor), theirs = rankOf(st, rec.actor);
  if (strict ? mine <= theirs : mine < theirs) refuse("rank", `${said(rec.actor)} (${roleOf(st, rec.actor)}) made this ${verb}; only they, an owner${strict ? ", or someone who outranks them" : ", or someone at their rank or above"} may lift it`, `ask ${said(rec.actor)} or an owner`, { by: rec.actor });
  }
}
const MOD_VERBS = {
  // moderation (§2.1): a separate log, enforced by the authority; never a world entry. Research roles §5–6: every act on a
  // person needs its permission and a target ranked strictly below you (never yourself, never your equal, never an owner);
  // its duration is capped below owner; its record names identities. Expiry is the authority's clock (sanction views above).
  warn: (w, actor, a) => { const t = personAct(w, actor, a, "warn", R.WARN_POWERS);
    if (typeof a.reason !== "string" || !a.reason.trim()) refuse("shape", "warn {who, reason}: a warning says why", "e.g. warn {who, reason: 'please keep it friendly'}");
    w.appendMod({ actor, verb: "warn", who: a.who, reason: a.reason.slice(0, R.REASON_MAX) }); return { ok: true, warned: a.who, ...t, logged: "moderator log" }; },
  mute: (w, actor, a) => { const t = personAct(w, actor, a, "mute", ["mute"]);
    const ch = a.channels ?? ["voice", "chat"];
    if (!Array.isArray(ch) || !ch.length || ch.some((c) => c !== "voice" && c !== "chat") || new Set(ch).size !== ch.length) refuse("shape", "mute.channels is ['voice'], ['chat'] or both", "leave it out for both");
    const until = minutesUntil(w, actor, a.minutes, { cap: R.MUTE_MAX_MIN, what: "a mute", required: true });
    w.appendMod({ actor, verb: "mute", who: a.who, channels: ch, until, ...reasonOf(a) }); return { ok: true, muted: a.who, channels: ch, until, ...t, logged: "moderator log" }; },
  unmute: (w, actor, a) => { personLift(w, actor, a, "mute", inForceOf(w, a.who, "mute"), { strict: true });
    w.appendMod({ actor, verb: "unmute", who: a.who }); return { ok: true, unmuted: a.who }; },
  // a kick removes a live session now (the authority's server does the removing on this reply); they may come back after
  // `minutes` (default 10, at most 60: VRChat's kick is a one-hour bar)
  kick: (w, actor, a) => { const t = personAct(w, actor, a, "kick", ["kick"], { noOwner: "kicked" });
    const until = minutesUntil(w, actor, a.minutes ?? R.KICK_DEFAULT_MIN, { cap: R.KICK_MAX_MIN, what: "a kick's cooldown", ownerCap: true });
    w.appendMod({ actor, verb: "kick", who: a.who, until, ...reasonOf(a) }); return { ok: true, kicked: a.who, until, ...t, logged: "moderator log" }; },
  ban: (w, actor, a) => { const t = personAct(w, actor, a, "ban", ["ban"], { noOwner: "banned" });
    const owner = roleOf(w.state(), actor) === "owner";
    if (a.days === undefined && !owner) refuse("rights", `a ban with no end needs an owner; you may ban for up to ${R.MOD_BAN_MAX_DAYS} days`, `ban {who, days: 1|7|${R.MOD_BAN_MAX_DAYS}, reason}`, { needs: "owner" });
    if (a.days !== undefined && !(typeof a.days === "number" && a.days > 0 && a.days <= 3650)) refuse("shape", "ban.days is a number of days (more than 0)", "leave it out (owners) for a ban until lifted");
    if (a.days !== undefined && a.days > R.MOD_BAN_MAX_DAYS && !owner) refuse("rights", `a ban longer than ${R.MOD_BAN_MAX_DAYS} days needs an owner`, `ban for ${R.MOD_BAN_MAX_DAYS} days or less, or ask an owner`, { needs: "owner" });
    const until = a.days === undefined ? undefined : Math.floor(w.now() + a.days * 86400000);
    w.appendMod({ actor, verb: "ban", who: a.who, ...(until !== undefined ? { until } : {}), ...reasonOf(a) }); return { ok: true, banned: a.who, ...(until !== undefined ? { until } : { until: null }), ...t, logged: "moderator log" }; },
  unban: (w, actor, a) => { if (!isIdentity(a.who)) refuse("shape", "unban {who}", "");
    // an operator's recorded repair lifts any ban or kick here, their own included (authority.js operatorRepair), and says so
    const op = !!CTX.operator && CTX.operator === actor;
    if (!op) personLift(w, actor, a, "ban", [...inForceOf(w, a.who, "ban"), ...inForceOf(w, a.who, "kick")], { strict: true });
    w.appendMod({ actor, verb: "unban", who: a.who, ...(op ? { operator: true } : {}) }); return { ok: true, unbanned: a.who, ...(op ? { operator: true } : {}) }; },
  // ghost (PLAN 10-06): `ghost {on}` with no who is the mode you choose (presence: never logged; spectate);
  // `ghost {who, minutes?, reason}` is a sanction (kick holders, on a rank below; capped like a mute below owner)
  ghost: (w, actor, a) => {
    if (a.who === undefined || a.who === actor) { if (typeof a.on !== "boolean") refuse("shape", "ghost {on: true|false}: become a ghost here (unseen; you can't interact or talk), or come back", "or ghost {who, minutes, reason} to ghost someone (kick holders)");
      if (!a.on && inForceOf(w, actor, "ghost").length) refuse("ghost", "you were made a ghost by a moderator; that isn't yours to end", "a moderator ranked at or above them can bring you back");
      const G = (w.presence.ghosts ??= {}); if (a.on) G[actor] = { ts: Math.floor(w.now()) }; else delete G[actor]; w.presenceDirty = true;
      return { ok: true, ghost: a.on, chosen: true, recorded: false }; }
    const t = personAct(w, actor, a, "ghost", ["kick"], { noOwner: "made a ghost" });
    const owner = roleOf(w.state(), actor) === "owner";
    const until = a.minutes === undefined && owner ? undefined : minutesUntil(w, actor, a.minutes, { cap: R.MUTE_MAX_MIN, what: "a ghost sanction", required: true });
    w.appendMod({ actor, verb: "ghost", who: a.who, ...(until !== undefined ? { until } : {}), ...reasonOf(a) }); return { ok: true, ghosted: a.who, until: until ?? null, ...t, logged: "moderator log" }; },
  unghost: (w, actor, a) => {
    personLift(w, actor, a, "ghost", inForceOf(w, a.who, "ghost"), { strict: false, power: "kick" });
    w.appendMod({ actor, verb: "unghost", who: a.who }); return { ok: true, unghosted: a.who }; },
  // the moderation log (research: read by anyone holding a moderation power): newest first, merged with role changes
  // from the world log (roles:* writes, read-only) and the authority's automatic cool-downs
  modlog: (w, actor, a) => { const st = w.state(); if (!modHolder(st, actor) && roleOf(st, actor) !== "owner") refuse("rights", "the moderation log is for people who hold a moderation power (mute, kick, ban or pauseScripts)", "ask a moderator", { needs: "mute|kick|ban|pauseScripts" });
    const lim = Math.max(1, Math.min(200, a.limit ?? 50)); const before = a.before ?? Infinity;
    const rows = w.mod.map((m, i) => ({ ...m, at: i, src: "mod" }));
    for (let i = 0; i < w.entries.length; i++) { const e = w.entries[i]; if (!isE(e) || e.kind !== "change") continue;
      for (const o of opsQuiet(e)) if (o.id === "@world" && String(o.comp ?? "").startsWith("roles:")) rows.push({ ts: e.ts, actor: entryBy(w, e).by, verb: "role", who: o.comp.slice(6), role: o.verb === "delete" ? null : o.value?.role ?? null, ...(o.value?.can ? { can: o.value.can } : {}), seq: i, src: "log" }); }
    const out = rows.filter((r) => (a.who === undefined || r.who === a.who) && r.ts < before).sort((x, y) => y.ts - x.ts || (y.at ?? y.seq) - (x.at ?? x.seq)).slice(0, lim)
      .map((r) => ({ ...r, by: said(r.actor), name: typeof r.who === "string" ? said(r.who) : undefined, ...(r.until !== undefined ? { inForce: r.until > w.now() } : {}) }));
    return { ok: true, records: out, ...(out.length === lim ? { next: out.at(-1).ts, more: "send before: next for older" } : {}) }; },
  bans: (w, actor) => { const st = w.state(); if (!modHolder(st, actor) && roleOf(st, actor) !== "owner") refuse("rights", "the ban list is for people who hold a moderation power", "ask a moderator", { needs: "mute|kick|ban|pauseScripts" });
    const byName = (m) => (m && m.actor ? { ...m, by: said(m.actor) } : m);   // the author by name: the asker's page may not know an absent moderator
    const now = Object.entries(sanctionsNow(w)).map(([who, x]) => ({ who, name: said(who), role: roleOf(st, who), ...Object.fromEntries(Object.entries(x).map(([k, m]) => [k, byName(m)])) }));
    const ended = []; const seen = new Set(); for (let i = w.mod.length - 1; i >= 0; i--) { const m = w.mod[i]; if (m.verb !== "ban" || seen.has(m.who)) continue; seen.add(m.who); if (!banOf(w, m.who)) ended.push({ ...byName(m), name: said(m.who) }); }
    return { ok: true, now, ended: ended.slice(0, 100) }; },
};
export { MOD_VERBS };
