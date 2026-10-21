// shared/protocol/roles.js — who may do what in a world (RESEARCH-roles-moderation-2026-10-06; PLAN decisions 10-06).
// Pure data and pure functions: the authority (shared/protocol/authority.js) reads them to admit writes, the server reads them through
// the authority to tell a client its rights, and the client reads them to draw badges, menus and the roles grid. No state
// of its own, no clock, no imports: a browser and bun import the same file.
//
// THE SANCTIONED SOCIETY. A world's people stand on one ranked ladder, and the ladder is MEMBERSHIP only:
//   inhabitant 0 · builder 100 · moderator 200 · owner 255, and an owner's custom roles at any free rank in between.
// (R 10-21: the base rung is `inhabitant`: you belong here and may make it home, without building it. It was `visitor`,
// renamed because visitor sat too close to `guest`, which is the conventional word for a person without an account, and
// the two are different axes: guest says whether we know you across visits, a role says what you may do. A guest holds
// a role like anyone else, and a world may give guests any role it gives newcomers (default-role.guests).)
// "Below you" is a total order on it (ranks are unique), and every rank comparison compares two members.
// Outside the ladder sit explicit UNRANKED states, never rungs: Banned (not in the world at all; the moderator log
// holds it: reason, by, until), and the timed ones (muted, kicked). A state is never compared as a rank, and a rank can't
// express a state: that is why banned is not "rank -5". There is no rung below inhabitant (`none` is gone, R 10-21: a ban or
// a mute does that job), so no gate can meet a sub-floor role.

// ---------------- the five defaults R hasn't ruled on yet (one value each: flip it here) ----------------
/** Q1: caption is a property of the SCREEN it captions, not a role switch (true = off the role list). */
export const CAPTION_ON_SCREENS = true;
/** Q2: owners fly by default (the old protocol had flight off even for owners). */
export const OWNERS_FLY = true;
/** Q3: people without an account (guests) can't be set above the world's default role. */
export const GUESTS_AT_MOST_DEFAULT = true;
/** Q4: editWorld (sky, weather, ground, the card, spawn, bounds, fall) is a permission; false = those stay owner-only. */
export const EDIT_WORLD_PERMISSION = true;
/** Q5: a ban by anyone below owner is at most this many days; owners may ban for longer, or with no end. */
export const MOD_BAN_MAX_DAYS = 30;

// ---------------- the other caps (research §5) ----------------
export const MUTE_MAX_MIN = 7 * 24 * 60;        // a mute lasts at most 7 days
export const KICK_DEFAULT_MIN = 10, KICK_MAX_MIN = 60;
export const REASON_MAX = 500;

export const RANK = Object.freeze({ inhabitant: 0, builder: 100, moderator: 200, owner: 255 });
/** What an id the world doesn't define stands at: below every rung, so it is never "more". Not a role. */
export const BELOW = -1;
// A lock (recut B2, R 10-20 "a soft barrier by rank"; house 21:59Z): a lock is just `true`; its strength is the rank its
// SETTER holds now, read from the log at check time (a setter who's demoted takes their locks down with them). Anyone at
// that rank or above may act through it or lift it; the authority decides (gate.js), the padlock only asks.
/** The words for a lock's strength: who may lift it (display only). */
export const lockWord = (rank) => (rank >= RANK.owner ? "owners only" : rank >= RANK.moderator ? "moderators and up" : "builders and up");
export const BUILTIN_IDS = Object.freeze(["inhabitant", "builder", "moderator", "owner"]);

// ---------------- the closed permission list ----------------
// [name, plain words (UI and help), needs]. The order is the order the grid shows.
const LIST = [
  ["build", "make things, and change or delete what you made; publish the world's blueprints", []],
  ["editOthers", "change or delete things other people made (undo still goes only along rank)", ["build"]],
  ...(EDIT_WORLD_PERMISSION ? [["editWorld", "change the world's look and layout: sky, weather, ground, the card, spawn points, bounds", ["build"]]] : []),
  ["generate", "add new models or pictures to the world's assets (the world's generation credit)", ["build"]],
  ["fly", "fly in this world", []],
  ["scripts", "install and edit scripts (they act with your rights)", ["build"]],
  ["pauseScripts", "pause or resume scripts whose sponsor ranks below you", []],
  ["mute", "mute someone's voice or chat for everyone, for a while (up to 7 days); warn them", []],
  ["kick", "remove someone now; they can't come back for a while (up to 60 min); warn them", []],
  ["ban", `keep someone out for up to ${MOD_BAN_MAX_DAYS} days (owners: any length); lift bans you may; warn them`, ["kick"]],
  ["grantRoles", "give or take roles ranked below yours, with only permissions you hold", []],
  ...(CAPTION_ON_SCREENS ? [] : [["caption", "caption a screen", []]]),
];
export const PERMISSIONS = Object.freeze(Object.fromEntries(LIST.map(([k, text, needs]) => [k, Object.freeze({ text, needs: Object.freeze(needs) })])));
export const PERMISSION_NAMES = Object.freeze(LIST.map(([k]) => k));
/** The powers that act on people: holding any of them shows the Moderation panel and the moderation log. */
/** Owner-only powers go through this one test (recut B1): a grant value or effective rights whose role is the built-in owner. */
export const OWNER = "owner";
/** The base rung (R 10-21: inhabitant), through one test like owner: "anyone here" for a who, the badge that isn't shown. */
export const BASE = "inhabitant";
export const isBase = (x) => (typeof x === "string" ? x : x?.role) === BASE;
export const isOwner = (x) => (typeof x === "string" ? x : x?.role) === OWNER;   // a role string, a grant or effective rights
export const MOD_POWERS = Object.freeze(["mute", "kick", "ban", "pauseScripts"]);
/** The powers that may warn (research §2: warn isn't a permission; the gentlest act comes with any of these). */
export const WARN_POWERS = Object.freeze(["mute", "kick", "ban"]);

const on = (...ks) => Object.freeze(Object.fromEntries(PERMISSION_NAMES.map((k) => [k, ks.includes(k)])));
// The built-in roles. Their rank is fixed; an owner may edit inhabitant's, builder's and moderator's permissions (role-defs);
// the owner column is locked: every permission, always (fly per OWNERS_FLY).
export const BUILTIN = Object.freeze({
  inhabitant: Object.freeze({ name: "Inhabitant", rank: RANK.inhabitant, can: on() }),
  builder:   Object.freeze({ name: "Builder",   rank: RANK.builder,   can: on("build", "editOthers", "scripts") }),
  moderator: Object.freeze({ name: "Moderator", rank: RANK.moderator, can: on("build", "editOthers", "scripts", "pauseScripts", "mute", "kick", "ban", "grantRoles") }),
  owner:     Object.freeze({ name: "Owner",     rank: RANK.owner,     can: Object.freeze(Object.fromEntries(PERMISSION_NAMES.map((k) => [k, k === "fly" ? OWNERS_FLY : true]))) }),
});

const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);
export const CUSTOM_ID = /^[a-z][a-z0-9-]{0,23}$/;
// The list is the registry's (roles.vocab, recut C11): a change to it is a trial break needing --ack.
export const RESERVED_IDS = Object.freeze(new Set(["owner", "banned"]));
/** A role a `who` may name: a built-in, or an id a world's owner could define (CUSTOM_ID, not a reserved word). Whether
 *  this world defines it is the authority's to say (roleDef). */
export const isRoleId = (x) => BUILTIN_IDS.includes(x) || (typeof x === "string" && CUSTOM_ID.test(x) && !RESERVED_IDS.has(x));

/** A world's role definitions: @world.role-defs (or {} ). */
export const defsOf = (wc) => (isObj(wc?.["role-defs"]) ? wc["role-defs"] : {});

/** A role by id in a world (its @world components `wc`): {id, name, rank, can, builtin, custom} or null if the world
 *  doesn't define it. Who may install scripts is each role's `scripts` permission (script-settings.install is gone, 10-16). */
export function roleDef(wc, id) {
  if (id === "owner") return { id, ...BUILTIN.owner, builtin: true };
  const defs = defsOf(wc); const d = Object.hasOwn(defs, id) && isObj(defs[id]) ? defs[id] : null;
  if (Object.hasOwn(BUILTIN, id)) {
    const b = BUILTIN[id]; const can = { ...b.can, ...(isObj(d?.can) ? pickPermissions(d.can) : {}) };
    return { id, name: typeof d?.name === "string" ? d.name : b.name, rank: b.rank, can, builtin: true, ...(d?.note ? { note: d.note } : {}) };
  }
  // a rank written around the authority (a hand-edited log, an old translation) is range-checked here too: never above the owner
  if (!d || !CUSTOM_ID.test(id) || !Number.isInteger(d.rank) || d.rank < 1 || d.rank > 254) return null;
  return { id, name: typeof d.name === "string" ? d.name : id, rank: d.rank, can: { ...on(), ...(isObj(d.can) ? pickPermissions(d.can) : {}) }, custom: true, ...(d.note ? { note: d.note } : {}) };
}
const pickPermissions = (can) => Object.fromEntries(Object.entries(can).filter(([k, v]) => Object.hasOwn(PERMISSIONS, k) && typeof v === "boolean"));

/** Every role a world has, highest rank first (owner first): what the grid and the role pickers list. */
export function rolesOf(wc) {
  const ids = [...BUILTIN_IDS, ...Object.keys(defsOf(wc)).filter((k) => !Object.hasOwn(BUILTIN, k))];
  return ids.map((id) => roleDef(wc, id)).filter(Boolean).sort((a, b) => b.rank - a.rank);
}
/** The rank a role id stands at here; an id the world doesn't define is -1 (never "more"). */
export const rankOfRole = (wc, id) => roleDef(wc, id)?.rank ?? BELOW;

/** The permissions a set closes over: drop any permission whose needs aren't all on (read-time: never fail open). */
export function closeOver(can) {
  const out = { ...can };
  for (let changed = true; changed;) { changed = false;
    for (const k of PERMISSION_NAMES) if (out[k] && PERMISSIONS[k].needs.some((n) => !out[n])) { out[k] = false; changed = true; } }
  return out;
}
/** The first dependency a set breaks: [permission, missing] or null (write-time: refused, naming it). */
export function brokenNeed(can) {
  for (const k of PERMISSION_NAMES) if (can[k]) for (const n of PERMISSIONS[k].needs) if (!can[n]) return [k, n];
  return null;
}

/** The role a person holds in a world, by id: the roles:<id> entry, else (a guest) the guests role, else the default
 *  role, else inhabitant. A role the world doesn't define reads as inhabitant. A world with no owner caps everyone at inhabitant
 *  (§2.3). `anon` = a guest (no account). Mirrors the authority's roleOf exactly; the authority calls this. */
export function roleIdOf(wc, id, { anon = false, owners = null } = {}) {
  if (!wc) return "inhabitant";
  const dr = isObj(wc["default-role"]) ? wc["default-role"] : null;
  const base = roleDef(wc, dr?.role) ? dr.role : "inhabitant";
  let r = isObj(wc[`roles:${id}`]) ? wc[`roles:${id}`].role : anon ? guestRoleOf(wc) : base;
  if (typeof r !== "string" || !roleDef(wc, r)) r = "inhabitant";
  const hasOwner = owners ?? Object.keys(wc).some((k) => k.startsWith("roles:") && isOwner(wc[k]));
  return !hasOwner && rankOfRole(wc, r) > RANK.inhabitant ? "inhabitant" : r;
}
/** What a guest (no account) is here: default-role.guests when the world defines it, never owner, and (GUESTS_AT_MOST_DEFAULT)
 *  never above the default role; else inhabitant (R 10-21: guests start as inhabitants even where newcomers build). */
export function guestRoleOf(wc) {
  const dr = isObj(wc?.["default-role"]) ? wc["default-role"] : null; const g = dr?.guests;
  const base = roleDef(wc, dr?.role) ? dr.role : "inhabitant";
  const above = (r) => GUESTS_AT_MOST_DEFAULT && rankOfRole(wc, r) > rankOfRole(wc, base);
  if (typeof g !== "string" || g === "owner" || !roleDef(wc, g) || above(g)) return "inhabitant";
  return g;
}

/** A person's effective rights: {role, name, rank, can: {<permission>: bool}, permissions: [names on]}.
 *  The role's permissions, then the default role's `can` (default-role.can, for those who hold the default role: an imported
 *  world's grant to everyone), then the per-person `can` (applied last: Discord's member overwrites), then closed over dependencies. Owners hold every
 *  permission whatever `can` says (their column is locked); `can.fly: true` may still give an owner flight when OWNERS_FLY
 *  is off. */
export function effectiveOf(wc, id, opts = {}) {
  const role = roleIdOf(wc, id, opts); const def = roleDef(wc, role) ?? roleDef(wc, "inhabitant");
  let can = { ...def.can };
  const entry = isObj(wc?.[`roles:${id}`]) ? wc[`roles:${id}`] : null;
  if (role === OWNER) { if (entry?.can?.fly === true) can.fly = true; }
  else {
    const dr = isObj(wc?.["default-role"]) ? wc["default-role"] : null;
    if (!entry && !opts.anon && isObj(dr?.can)) Object.assign(can, pickPermissions(dr.can));
    if (isObj(entry?.can)) Object.assign(can, pickPermissions(entry.can));
    can = closeOver(can);
  }
  return { role, name: def.name, rank: def.rank, can, permissions: PERMISSION_NAMES.filter((k) => can[k]) };
}

/** Why this role-defs value is refused, or null: {code, reason, fix, didYouMean?}. `held(id)` counts the people who
 *  hold role `id` now (roles:* and the default role), so a custom role someone holds can't be deleted. `prev` is the
 *  current value (to see what was removed). */
export function checkRoleDefs(v, prev, held = () => 0) {
  const bad = (code, reason, fix = "role-defs is {<role id>: {name, rank, can: {<permission>: true|false}, note?}}", extra = {}) => ({ code, reason, fix, ...extra });
  if (!isObj(v)) return bad("shape", "role-defs must be an object {<role id>: {name, rank, can}}");
  const ranks = new Map();
  for (const [id, d] of Object.entries(v)) {
    if (id === "owner") return bad("shape", "role-defs can't define owner: the owner holds every permission, always, at rank 255", "leave owner out");
    if (!Object.hasOwn(BUILTIN, id) && (RESERVED_IDS.has(id) || !CUSTOM_ID.test(id))) return bad("shape", `'${id}' isn't a role id you can make: a–z first, then a–z, 0–9 and '-', up to 24 (not ${[...RESERVED_IDS].join(", ")})`);
    if (!isObj(d)) return bad("shape", `role-defs.${id} must be {name, rank, can}`);
    for (const k of Object.keys(d)) if (!["name", "rank", "can", "note"].includes(k)) return bad("schema", `role-defs.${id}: unknown key '${k}'`, "a role is {name, rank, can, note?}");
    if (d.name !== undefined && !(typeof d.name === "string" && d.name.trim().length >= 1 && d.name.length <= 32)) return bad("shape", `role-defs.${id}.name is 1–32 characters`);
    if (d.note !== undefined && !(typeof d.note === "string" && d.note.length <= 120)) return bad("shape", `role-defs.${id}.note is up to 120 characters`);
    if (Object.hasOwn(BUILTIN, id)) { if (d.rank !== undefined && d.rank !== BUILTIN[id].rank) return bad("rank", `${id}'s rank is fixed at ${BUILTIN[id].rank}`, "make a custom role to stand somewhere else"); }
    else {
      if (!Number.isInteger(d.rank) || d.rank < 1 || d.rank > 254) return bad("rank", `role-defs.${id}.rank must be a whole number 1–254 (inhabitant is 0, owner 255)`, "place it between two roles: e.g. 150 sits between builder (100) and moderator (200)");
      if ([RANK.builder, RANK.moderator].includes(d.rank)) return bad("rank", `rank ${d.rank} is ${d.rank === RANK.builder ? "builder" : "moderator"}'s; two roles never share a rank`, "pick a free number");
    }
    const r = Object.hasOwn(BUILTIN, id) ? BUILTIN[id].rank : d.rank;
    if (ranks.has(r)) return bad("rank", `${id} and ${ranks.get(r)} both stand at rank ${r}; two roles never share a rank (so "below you" is never ambiguous)`, "pick a free number");
    ranks.set(r, id);
    if (d.can !== undefined) {
      if (!isObj(d.can)) return bad("shape", `role-defs.${id}.can must be {<permission>: true|false}`);
      for (const [k, x] of Object.entries(d.can)) {
        if (!Object.hasOwn(PERMISSIONS, k)) { const dym = guessSwitch(k); return bad("schema", `role-defs.${id}.can: there is no permission '${k}'${dym.length ? `; did you mean '${dym[0]}'?` : ""}`, `the permissions: ${PERMISSION_NAMES.join(", ")}`, { didYouMean: dym }); }
        if (typeof x !== "boolean") return bad("shape", `role-defs.${id}.can.${k} is true or false`);
      }
      const full = Object.hasOwn(BUILTIN, id) ? { ...BUILTIN[id].can, ...d.can } : d.can;
      const br = brokenNeed(full); if (br) return bad("needs", `role-defs.${id}: ${br[0]} needs ${br[1]}, which is off`, `turn ${br[1]} on too, or ${br[0]} off`);
    }
  }
  for (const id of Object.keys(isObj(prev) ? prev : {})) if (!Object.hasOwn(BUILTIN, id) && !Object.hasOwn(v, id)) { const n = held(id);
    if (n > 0) return bad("held", `${n} ${n === 1 ? "person holds" : "people hold"} ${id}; give them another role first`, "move them to another role (one batch: their roles:<id> and role-defs together)"); }
  return null;
}
/** Why this per-person `can` is refused, or null. */
export function checkCan(can, at) {
  if (!isObj(can)) return { code: "shape", reason: `${at}.can must be {<permission>: true|false}`, fix: `the permissions: ${PERMISSION_NAMES.join(", ")}` };
  for (const [k, x] of Object.entries(can)) {
    if (!Object.hasOwn(PERMISSIONS, k)) { const dym = guessSwitch(k); return { code: "schema", reason: `${at}.can: there is no permission '${k}'${dym.length ? `; did you mean '${dym[0]}'?` : ""}`, fix: `the permissions: ${PERMISSION_NAMES.join(", ")}`, didYouMean: dym }; }
    if (typeof x !== "boolean") return { code: "shape", reason: `${at}.can.${k} is true or false`, fix: "" };
  }
  return null;
}
/** A typo of a permission name: case-insensitive, prefix either way, else one or two edits. */
export function guessSwitch(k) {
  const x = String(k).toLowerCase(); const lev = (a, b) => { const d = Array.from({ length: b.length + 1 }, (_, j) => j);
    for (let i = 1; i <= a.length; i++) { let p = d[0]; d[0] = i; for (let j = 1; j <= b.length; j++) { const t = d[j]; d[j] = Math.min(d[j] + 1, d[j - 1] + 1, p + (a[i - 1] === b[j - 1] ? 0 : 1)); p = t; } } return d[b.length]; };
  return PERMISSION_NAMES.map((s) => { const y = s.toLowerCase(); return [s, y === x ? 0 : (x.length >= 3 && (y.startsWith(x) || x.startsWith(y))) ? 0.5 : lev(x, y)]; })
    .filter(([, d]) => d <= 2).sort((a, b) => a[1] - b[1]).slice(0, 3).map(([s]) => s);
}

// ---------------- what one person may do to another (the person menu; pure, unit-tested) ----------------
/** The items of the person menu `me` sees for `them`. me/them: {id, rank, permissions: [..], role?, name?} (from
 *  effectiveOf); state: {muted?: bool, banned?: bool}. Returns [{id, label}] in menu order, plus
 *  {id: 'rank-line', label, dim: true} when rank is the only reason nothing more shows. Never yourself beyond Mention
 *  (a public @name in chat; it was Message, a DM tab, until whisper left world chat, R 10-18). */
export function personActions(me, them, state = {}) {
  const out = [{ id: "mention", label: "Mention" }];
  if (!me || !them || me.id === them.id) return out;
  const has = (k) => (me.permissions ?? []).includes(k);
  const anyMod = MOD_POWERS.some(has) || has("grantRoles");
  const below = them.rank < me.rank;
  if (below) {
    if (WARN_POWERS.some(has)) out.push({ id: "warn", label: "Warn…" });
    if (has("mute")) out.push(state.muted ? { id: "unmute", label: "Unmute" } : { id: "mute", label: "Mute…" });
    if (has("kick")) out.push({ id: "kick", label: "Kick…" });
    if (has("ban")) out.push({ id: "ban", label: "Ban…" });
    if (has("grantRoles")) out.push({ id: "role", label: "Role ▸" });
  } else if (anyMod) out.push({ id: "rank-line", dim: true, label: `they're ${article(them.name ?? them.role ?? "a member")}; you can't act on equal or higher ranks` });
  if (MOD_POWERS.some(has)) out.push({ id: "history", label: "Moderation history" });
  return out;
}
const article = (n) => (/^[aeiou]/i.test(n) ? `an ${n.toLowerCase()}` : `a ${n.toLowerCase()}`);
/** The roles `me` may give (grantRoles): ranked below me, holding only permissions I hold. Owners may give any but owner
 *  through ownership's own path (seniority), so owner is listed for owners. */
export function grantableRoles(wc, me) {
  return rolesOf(wc).filter((r) => isOwner(me) ? true : r.rank < me.rank && PERMISSION_NAMES.every((k) => !r.can[k] || (me.permissions ?? []).includes(k)));
}
/** The badge a person's row shows (research §UI): none for an inhabitant (the list doesn't shout), "guest" for someone
 *  without an account (whatever role guests get), else the role's name. {text, tone: 'owner'|'mod'|'role'|'guest'}. */
export function badgeOf(p) {
  if (!p) return null;
  if (p.anon) return { text: "guest", tone: "guest" };
  if (!p.role || isBase(p)) return null;
  return { text: (p.name ?? p.role).toLowerCase(), tone: isOwner(p) ? "owner" : p.role === "moderator" ? "mod" : "role" };
}
