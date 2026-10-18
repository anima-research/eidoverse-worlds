// shared/protocol/access.js — who may come INTO a world (upstream #258 "world access", in this protocol's terms).
//
// Pure: no state, no clock, no imports but roles.js. The server's door (server/access.ts) asks it at every join, after any
// change to the world's roles or access, and for every HTTP read of a world; the client's /access, /members and the World
// panel read the same function, so "may I be here" never has two answers.
//
// The facts are the world's own components on @world (PROTOCOL §7 Roles, §4 access):
//   access {join: anyone | signed-in | listed, watch?: "anyone", max?, soft?, minAccountDays?}
//     join    who may come in with a body: anyone; people with an account; or only people LISTED here (a roles:<id> whose
//             role isn't `none`).
//     watch   "anyone": whoever `join` turns away may still WATCH (a spectator: no body, no voice, nothing written). Absent,
//             watching follows `join`: a listed-only world is then invisible to everyone it doesn't list.
//   default-role {role}   what everyone not listed holds once inside (absent: visitor).
//   roles:<id> {role, can?, note?, until?}   `until` (epoch ms): when the grant ends. The authority writes its end
//             (`expire-roles`, a system act) within a second of it, and warns the holder five minutes before.
//
// Upstream spelled the same doors as rungs below visitor on one ladder (`grant * none` = members-only, `grant * spectator` =
// watch-only, `grant bob spectator`); here a rank is membership and entry is the world's `access` (roles.js: "a state is
// never a rank"). The four doors upstream's panel offers map onto these components exactly (DOORS below).

/** The four doors an owner picks between (upstream's World › access buttons), in this protocol's components. */
export const DOORS = Object.freeze({
  open:     "anyone may come in, and build (default role: builder)",
  visitors: "anyone may come in, as a visitor",
  watch:    "anyone may watch; only people listed here may come in",
  members:  "only people listed here may come in or watch; the world is invisible to everyone else",
});
export const ACCESS_WARN_MS = 5 * 60_000;   // a timed grant's holder is told this long before it ends

const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);
const accessOf = (wc) => (isObj(wc?.access) ? wc.access : null);

/** Is `actor` LISTED here: a live roles:<actor> whose role isn't `none` (a demotion keeps nobody in). */
export function listedIn(wc, actor) {
  const r = actor ? wc?.[`roles:${actor}`] : null;
  return isObj(r) && typeof r.role === "string" && r.role !== "none";
}

/** The world's door for everyone it doesn't list: open | visitors | signed-in | watch | members. */
export function doorOf(wc) {
  const a = accessOf(wc);
  const join = a?.join ?? "anyone";
  if (join === "listed") return a.watch === "anyone" ? "watch" : "members";
  if (join === "signed-in") return "signed-in";
  const dr = isObj(wc?.["default-role"]) ? wc["default-role"].role : null;
  return dr === "builder" ? "open" : "visitors";
}

/** What `who` may do at this world's door: "embody" (come in with a body), "watch" (no body), or "none", with the reason
 *  in words for a refusal. `who`: {actor?, anon? (no account), bypass? (an owner, a holder of a moderation power, an
 *  operator: they always get in), trustedRenderer? (the renderers' credential: may watch any world, never embody)}.
 *  Bans, kicks, account age and capacity are the server's (they need its moderator log, its clock and who is here). */
export function entryOf(wc, who = {}, worldName = "this world") {
  if (who.bypass) return { may: "embody" };
  const a = accessOf(wc);
  const join = a?.join ?? "anyone";
  const w = `"${worldName}"`;
  const why = join === "signed-in" && who.anon ? `${w} is for signed-in people`
    : join === "listed" && !listedIn(wc, who.actor) ? `${w} isn't open to you` : null;
  if (!why) return { may: "embody" };
  if (a?.watch === "anyone" || who.trustedRenderer) return { may: "watch", why: a?.watch === "anyone" ? `${why} — you may watch (spectate)` : why };
  return { may: "none", why };
}

/** The writes that set a door (a request's args, one per component: set, with the components' other fields kept).
 *  `wc` is the world's @world components now. → [{component, value}] */
export function doorWrites(door, wc = {}) {
  if (!Object.hasOwn(DOORS, door)) return null;
  const { join: _j, watch: _w, ...keep } = accessOf(wc) ?? {};
  const dr = isObj(wc["default-role"]) ? wc["default-role"] : {};
  if (door === "members") return [{ component: "access", value: { ...keep, join: "listed" } }];
  if (door === "watch") return [{ component: "access", value: { ...keep, join: "listed", watch: "anyone" } }];
  return [{ component: "access", value: { ...keep, join: "anyone" } },
    { component: "default-role", value: { ...dr, role: door === "open" ? "builder" : "visitor" } }];
}

/** A duration as people type it ("30m", "2h", "1d", "1w", "90 min") → ms, or null. At most a year. */
export function durationMs(s) {
  const m = String(s ?? "").trim().toLowerCase().match(/^(\d+(?:\.\d+)?)\s*(m|min|mins|minutes?|h|hr|hrs|hours?|d|days?|w|wk|weeks?)$/);
  if (!m) return null;
  const n = Number(m[1]), u = m[2][0];
  const ms = n * (u === "m" ? 60_000 : u === "h" ? 3_600_000 : u === "d" ? 86_400_000 : 604_800_000);
  return ms > 0 && ms <= 366 * 86_400_000 ? Math.round(ms) : null;
}

/** Every timed grant here: [{actor, role, until}], soonest first. */
export function timedGrants(wc) {
  const out = [];
  for (const [k, v] of Object.entries(wc ?? {})) if (k.startsWith("roles:") && isObj(v) && Number.isSafeInteger(v.until)) out.push({ actor: k.slice(6), role: v.role, until: v.until });
  return out.sort((a, b) => a.until - b.until);
}

/** "12 min left" / "3 h left" / "until 2026-10-20". */
export function leftWords(until, now) {
  const ms = until - now;
  if (ms < 3_600_000) return `${Math.max(1, Math.round(ms / 60_000))} min left`;
  if (ms < 2 * 86_400_000) return `${Math.round(ms / 3_600_000)} h left`;
  return `until ${new Date(until).toISOString().slice(0, 10)}`;
}
