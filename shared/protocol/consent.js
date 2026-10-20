// Ported from the protocol lab (2026-10-05); its words renamed before release (10-17, below).
// Body consent (PROTOCOL L6 as revised 21:45; research 42 §4). PRESENCE ONLY: nothing here is ever appended to a
// log or written to world state. The authority keeps one table per body in its presence plane, refuses before delivery,
// and the target's client has the final word (the lab has no clients; `inbox` stands in for delivery).
//   classes: near, follow, touch (social points), intimate (intimate points), pose, shove, displace, voice
//   cells: allow | ask | deny, separately for everyone and for friends (friends = mutual, between authority-stamped ids:
//          both named each other in their `friends` list)
//   presets: the SAME for every body. Normal is the default for every participant; Performer is opt-in.
//   silence is no: a body that never sent a table gets Normal; an ask nobody answers within 20 s is a no.
//   delegates: the people YOU named (a list apart from friends) may close your table (pause, deny); only you may open it,
//          and only you add or remove a friend or a delegate (friend/unfriend, delegate/undelegate)
// Renamed before release (protocol minor 0, R 10-17 14:41): tier `strangers` → `everyone`; cells everyone|ask|nobody →
// allow|ask|deny; class `move` → `displace` (someone else displacing your body; `move` is your own walk); the one `friend`
// list split into the mutual `friends` tier and `delegates`. The old words are still taken on the wire (LEGACY_* below), and
// a presence file in the old shape is read and rewritten in the new (migratePresence; storage.js calls it at load).
// The lab enforces touch/intimate, pose, shove and displace (what the lab can model: reach, pose, ragdoll, drag/grab of a
// body). near, follow and voice are in the table and shown, but the lab has no fade, follow track or SFU to enforce.
import { CONTACT_POINTS, canonicalPoint } from "../contact.js";
export const CLASSES = ["near", "follow", "touch", "intimate", "pose", "shove", "displace", "voice"];
export const ENFORCED = ["touch", "intimate", "pose", "shove", "displace"];
export const TIERS = ["everyone", "friends"];
export const MODES = ["allow", "ask", "deny"];
/** The words before 10-17, read on the wire and in a stored table; never written. */
export const LEGACY_TIER = Object.freeze({ strangers: "everyone" });
export const LEGACY_MODE = Object.freeze({ everyone: "allow", nobody: "deny" });
export const LEGACY_CLASS = Object.freeze({ move: "displace" });
const tierOf = (t) => (Object.hasOwn(LEGACY_TIER, t) ? LEGACY_TIER[t] : t);
const modeOf = (m) => (Object.hasOwn(LEGACY_MODE, m) ? LEGACY_MODE[m] : m);
const classOf = (c) => (Object.hasOwn(LEGACY_CLASS, c) ? LEGACY_CLASS[c] : c);
const NORMAL_FRIENDS = { near: "allow", follow: "allow", touch: "allow", intimate: "ask", pose: "ask", shove: "allow", displace: "ask", voice: "allow" };
export const PRESETS = {
  normal: { everyone: { near: "ask", follow: "ask", touch: "ask", intimate: "deny", pose: "deny", shove: "deny", displace: "deny", voice: "ask" }, friends: NORMAL_FRIENDS },
  open: { everyone: { near: "allow", follow: "ask", touch: "allow", intimate: "deny", pose: "ask", shove: "ask", displace: "ask", voice: "allow" }, friends: NORMAL_FRIENDS },
  "friends-only": { everyone: Object.fromEntries(CLASSES.map((c) => [c, "deny"])), friends: NORMAL_FRIENDS },
  performer: { everyone: { near: "allow", follow: "ask", touch: "allow", intimate: "deny", pose: "allow", shove: "allow", displace: "ask", voice: "allow" }, friends: NORMAL_FRIENDS },
};
export const DEFAULT_PRESET = "normal"; // for every new body: never a property of what kind of participant it is (42 §4.3)
export const ASK_MS = 20000, COOL_MS = 600000, MAX_ALLOW_MS = 30 * 24 * 3600000;
// a reach descriptor the relay strips (server/reachgate.ts → authority.js reachAdmits) is said to the reacher once per
// (reacher, target, class) per this long: a stream of frames is one attempt, never one message a frame
export const REACH_NOTE_MS = 15000;
export const KIND_CLASS = { pose: "pose", anim: "pose", shove: "shove", drag: "displace", occupy: "displace", carry: "displace", touch: "touch" };
// Touch is judged by where a hand is, not how it was aimed (42 P8): a named point is intimate if it is one of these, and
// touch if it is any other contact point (shared/contact.js). ONE classifier, namedPointClass, for the relay
// (server/reachgate.ts), the authority's reach verb and the agent (r2 holes F5: the verb kept its own 19-point list, so
// cheek, eye, knee and foot, which the relay classes touch and tells you to ask for, could never be asked for).
export const INTIMATE_POINTS = new Set(["chest_front", "waist_l", "waist_r", "hip_l", "hip_r"]);
export const REACH_POINTS = Object.keys(CONTACT_POINTS);
/** a named contact point (any spelling canonicalPoint takes) → { point (canonical), cls: touch | intimate }; null if not a point */
export function namedPointClass(name) { const point = canonicalPoint(name); return point ? { point, cls: INTIMATE_POINTS.has(point) ? "intimate" : "touch" } : null; }
// An ask answered yes is ONE touch (r2 holes F3), and lasts at most this long even while the hand is held: the window a
// no holds (COOL_MS) is the longest a yes holds. Long enough for a held hand on a walk or a slow dance, short enough that
// a yes forgotten in a long session doesn't stand in for consent an hour on. Letting go, either person leaving, or the
// target's cell moving off allow ends it sooner (authority.js reachLetGo, leave, revokeAfter).
export const REACH_GRANT_MS = COOL_MS;
// What the ASKER is told when a table refuses: the same words for a tier's deny, a per-person no, a pause, an ask
// answered no and an ask nobody answered (10-13 consent research: the reason leaked a per-person deny). The real cause
// (decide's why) goes to the target's own attempt ring only.
export const refusalWords = (to, cls) => `${to} isn't taking ${cls} right now`;
export const REFUSAL_FIX = "leave it be: it is theirs to open";
// a world-space point at a body: inside its capsule (r 0.25 m, feet to 1.8 m) is a touch; the torso/pelvis core is intimate
export function pointClass(bodyAt, p) {
  const h = Math.hypot(p[0] - bodyAt[0], p[2] - bodyAt[2]), y = p[1] - bodyAt[1];
  if (h > 0.25 + 0.05 || y < -0.05 || y > 1.85) return null; // TOUCH_GAP 5 cm (42 §4.5)
  return h <= 0.2 && y >= 0.8 && y <= 1.5 ? "intimate" : "touch";
}

export function tableOf(P, who) { const t = P.consent?.[who]; const pre = PRESETS[t?.preset ?? DEFAULT_PRESET] ?? PRESETS[DEFAULT_PRESET];
  return { preset: t?.preset ?? DEFAULT_PRESET, everyone: { ...pre.everyone, ...(t?.cells?.everyone ?? {}) }, friends: { ...pre.friends, ...(t?.cells?.friends ?? {}) },
    paused: !!t?.paused, friendsList: t?.friends ?? [], delegates: t?.delegates ?? [], overrides: t?.over ?? {} }; }
export const isFriend = (P, a, b) => (P.consent?.[a]?.friends ?? []).includes(b) && (P.consent?.[b]?.friends ?? []).includes(a);
// What `to`'s table says about `from` doing class `cls` now: { mode: allow | ask | deny, why }
export function decide(P, from, to, cls, now) {
  const t = tableOf(P, to); cls = classOf(cls);
  if (t.paused) return { mode: "deny", why: `${to} has paused (every class is deny, friends included)` };
  const o = t.overrides[from]?.[cls];
  if (o && (o.until === undefined || o.until > now)) return o.mode === "deny" ? { mode: "deny", why: `${to} said no to ${cls} from ${from}` } : { mode: "allow", why: `${to} allowed ${cls} from ${from}`, standing: "allow" };
  const tier = isFriend(P, from, to) ? "friends" : "everyone";
  return { mode: t[tier][cls], tier, why: `${to}'s ${cls} for ${tier} is ${t[tier][cls]}` };
}
// L6: change a table. Only the person opens; anyone they named a delegate may CLOSE (pause, deny), never open.
// Names and classes arrive from the wire: every table is prototype-less, and a "who" must look like an identity
// (security pass 2, H-0: deny '__proto__' wrote into Object.prototype for every world in the process).
const BAD_KEY = new Set(["__proto__", "constructor", "prototype"]);
const isWho = (w) => typeof w === "string" && /^[A-Za-z0-9_.:@+-]{1,64}$/.test(w) && !BAD_KEY.has(w);
const bag = () => Object.create(null);
export function setConsent(P, actor, a, now) {
  if (a == null || typeof a !== "object") return { ok: false, code: "shape", reason: "consent takes an object" };
  if (a.of !== undefined && !isWho(a.of)) return { ok: false, code: "shape", reason: "of: an identity" };
  const target = a.of ?? actor; const self = target === actor;
  const t = ((P.consent ??= bag())[target] ??= bag());
  const set = a.set && typeof a.set === "object" ? { ...a.set, class: classOf(a.set.class), tier: tierOf(a.set.tier ?? "everyone"), mode: modeOf(a.set.mode) } : a.set;
  const opening = a.preset !== undefined || (set && set.mode !== "deny") || a.allow !== undefined || a.pause === false || a.friend !== undefined || a.delegate !== undefined;
  // who is on your lists is yours alone (review r11 M1): naming, and removing, a friend or a delegate. A removal closes
  // nothing a delegate could close for you, so it is never one of their closings
  const lists = a.unfriend !== undefined || a.undelegate !== undefined;
  if (!self && lists) return { ok: false, code: "consent", reason: `only ${target} may change who ${target}'s friends and delegates are` };
  if (!self && (opening || !(t.delegates ?? []).includes(actor))) return { ok: false, code: "consent", reason: opening ? `only ${target} may open ${target}'s consent` : `${target} hasn't named you a delegate` };
  // every argument is checked before any is applied: a refused change changes nothing
  if (a.preset !== undefined && (typeof a.preset !== "string" || !Object.hasOwn(PRESETS, a.preset))) return { ok: false, code: "shape", reason: `no preset '${a.preset}'`, fix: Object.keys(PRESETS).join(", ") };
  if (set && (!CLASSES.includes(set.class) || !MODES.includes(set.mode) || !TIERS.includes(set.tier))) return { ok: false, code: "shape", reason: "set {class, tier: everyone|friends, mode: allow|ask|deny}" };
  const who = a.allow ?? a.deny; const cls = a.class !== undefined ? [classOf(a.class)] : CLASSES;
  if (a.allow !== undefined || a.deny !== undefined) {
    if (!isWho(who)) return { ok: false, code: "shape", reason: "allow/deny: an identity" };
    if (!cls.every((c) => CLASSES.includes(c))) return { ok: false, code: "shape", reason: `class: one of ${CLASSES.join(", ")}` };
    // an allowance lasts the for it names: a positive number of ms (an allow for 0 expired at once; none means an hour)
    if (a.allow !== undefined && a.for != null && !(typeof a.for === "number" && a.for > 0)) return { ok: false, code: "shape", reason: `for: how long it lasts, in ms (a positive number), got ${JSON.stringify(a.for)}`, fix: `e.g. for: 600000 (ten minutes); at most ${MAX_ALLOW_MS}` }; }
  // pause is true or false; any other value is refused
  if (a.pause !== undefined && typeof a.pause !== "boolean") return { ok: false, code: "shape", reason: `pause is true or false, got ${JSON.stringify(a.pause)}` };
  if (a.friend !== undefined && !isWho(a.friend)) return { ok: false, code: "shape", reason: "friend: an identity" };
  if (a.delegate !== undefined && !isWho(a.delegate)) return { ok: false, code: "shape", reason: "delegate: an identity" };
  if (a.unfriend !== undefined && !isWho(a.unfriend)) return { ok: false, code: "shape", reason: "unfriend: an identity" };
  if (a.undelegate !== undefined && !isWho(a.undelegate)) return { ok: false, code: "shape", reason: "undelegate: an identity" };
  if (a.preset !== undefined) { t.preset = a.preset; t.cells = bag(); }
  if (set) ((t.cells ??= bag())[set.tier] ??= bag())[set.class] = set.mode;
  if (a.allow !== undefined || a.deny !== undefined) {
    const until = a.allow !== undefined ? now + Math.min(a.for ?? 3600000, MAX_ALLOW_MS) : undefined;
    for (const c of cls) ((t.over ??= bag())[who] ??= bag())[c] = { mode: a.allow !== undefined ? "allow" : "deny", ...(until !== undefined ? { until } : {}) }; }
  if (a.pause !== undefined) t.paused = a.pause;
  if (a.friend !== undefined) t.friends = [...new Set([...(t.friends ?? []), a.friend])];
  if (a.delegate !== undefined) t.delegates = [...new Set([...(t.delegates ?? []), a.delegate])];
  // removing: a friend off your list ends the mutual tier at once (isFriend reads both lists on every decision; the caller's
  // revokeAfter ends what the friends tier alone allowed); a delegate off it can no longer close your table
  if (a.unfriend !== undefined) t.friends = (t.friends ?? []).filter((x) => x !== a.unfriend);
  if (a.undelegate !== undefined) t.delegates = (t.delegates ?? []).filter((x) => x !== a.undelegate);
  return { ok: true, target };
}
/** The presence plane's consent tables in today's shape. A table stored before 10-17 (cells.strangers, everyone/nobody,
 *  class move, one `friends` list that also closed the table) is rewritten: the old list stays the friends list AND becomes
 *  the delegates list (it did both jobs, so nobody gains or loses a power), and P.consentShape marks the plane as done so a
 *  delegates list emptied since is never refilled. Returns how many tables changed. In place; idempotent. */
export const CONSENT_SHAPE = 2;
export function migratePresence(P) {
  if (!P || typeof P !== "object" || P.consentShape === CONSENT_SHAPE) return 0;
  let n = 0;
  for (const t of Object.values(P.consent ?? {})) { if (!t || typeof t !== "object") continue; n++;
    if (t.cells && typeof t.cells === "object") { const cells = bag();
      for (const [tier, row] of Object.entries(t.cells)) { if (!row || typeof row !== "object") continue; const r = (cells[tierOf(tier)] ??= bag());
        for (const [c, m] of Object.entries(row)) r[classOf(c)] = modeOf(m); }
      t.cells = cells; }
    for (const row of Object.values(t.over ?? {})) if (row && typeof row === "object" && Object.hasOwn(row, "move")) { if (!Object.hasOwn(row, "displace")) row.displace = row.move; delete row.move; }
    if (Array.isArray(t.friends) && !Array.isArray(t.delegates)) t.delegates = t.friends.slice(); }
  for (const r of P.ring ?? []) if (r && Object.hasOwn(LEGACY_CLASS, r.cls)) r.cls = classOf(r.cls);
  for (const k of Object.values(P.asks ?? {})) if (k && Object.hasOwn(LEGACY_CLASS, k.cls)) k.cls = classOf(k.cls);
  for (const r of Object.values(P.reaches ?? {})) if (r && Object.hasOwn(LEGACY_CLASS, r.cls)) r.cls = classOf(r.cls);
  P.consentShape = CONSENT_SHAPE; return n;
}
