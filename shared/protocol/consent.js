// Ported from the protocol lab (the protocol lab, 2026-10-05) unchanged.
// Body consent (PROTOCOL L6 as revised 21:45; research 42 §4). PRESENCE ONLY: nothing here is ever appended to a
// log or written to world state. The authority keeps one table per body in its presence plane, refuses before delivery,
// and the target's client has the final word (the lab has no clients; `inbox` stands in for delivery).
//   classes: near, follow, touch (social points), intimate (intimate points), pose, shove, move, voice
//   cells: everyone | ask | nobody, separately for strangers and friends (friends = mutual, between authority-stamped ids)
//   presets: the SAME for every body. Normal is the default for humans and agents alike; Performer is opt-in.
//   silence is no: a body that never sent a table gets Normal; an ask nobody answers within 20 s is a no.
//   anyone you trust (someone YOU named a friend) may close your shield; only you may open it.
// The lab enforces touch/intimate, pose, shove and move (what the lab can model: reach, pose, ragdoll, drag/grab of a
// body). near, follow and voice are in the table and shown, but the lab has no fade, follow track or SFU to enforce.
import { CONTACT_POINTS, canonicalPoint } from "../contact.js";
export const CLASSES = ["near", "follow", "touch", "intimate", "pose", "shove", "move", "voice"];
export const ENFORCED = ["touch", "intimate", "pose", "shove", "move"];
const MODES = ["everyone", "ask", "nobody"];
const NORMAL_FRIENDS = { near: "everyone", follow: "everyone", touch: "everyone", intimate: "ask", pose: "ask", shove: "everyone", move: "ask", voice: "everyone" };
export const PRESETS = {
  normal: { strangers: { near: "ask", follow: "ask", touch: "ask", intimate: "nobody", pose: "nobody", shove: "nobody", move: "nobody", voice: "ask" }, friends: NORMAL_FRIENDS },
  open: { strangers: { near: "everyone", follow: "ask", touch: "everyone", intimate: "nobody", pose: "ask", shove: "ask", move: "ask", voice: "everyone" }, friends: NORMAL_FRIENDS },
  "friends-only": { strangers: Object.fromEntries(CLASSES.map((c) => [c, "nobody"])), friends: NORMAL_FRIENDS },
  performer: { strangers: { near: "everyone", follow: "ask", touch: "everyone", intimate: "nobody", pose: "everyone", shove: "everyone", move: "ask", voice: "everyone" }, friends: NORMAL_FRIENDS },
};
export const DEFAULT_PRESET = "normal"; // for every new body: never a property of being an agent (42 §4.3)
export const ASK_MS = 20000, COOL_MS = 600000, MAX_ALLOW_MS = 30 * 24 * 3600000;
// a reach descriptor the relay strips (server/reachgate.ts → authority.js reachAdmits) is said to the reacher once per
// (reacher, target, class) per this long: a stream of frames is one attempt, never one message a frame
export const REACH_NOTE_MS = 15000;
export const KIND_CLASS = { pose: "pose", anim: "pose", shove: "shove", drag: "move", seat: "move", carry: "move", touch: "touch" };
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
// target's cell moving off everyone ends it sooner (authority.js reachLetGo, leave, revokeAfter).
export const REACH_GRANT_MS = COOL_MS;
// What the ASKER is told when a table refuses: the same words for a tier's nobody, a per-person no, a pause, an ask
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

export function tableOf(P, who) { const t = P.consent?.[who]; const pre = PRESETS[t?.preset ?? DEFAULT_PRESET];
  return { preset: t?.preset ?? DEFAULT_PRESET, strangers: { ...pre.strangers, ...(t?.cells?.strangers ?? {}) }, friends: { ...pre.friends, ...(t?.cells?.friends ?? {}) },
    paused: !!t?.paused, friendsList: t?.friends ?? [], overrides: t?.over ?? {} }; }
export const isFriend = (P, a, b) => (P.consent?.[a]?.friends ?? []).includes(b) && (P.consent?.[b]?.friends ?? []).includes(a);
// What `to`'s table says about `from` doing class `cls` now: { mode, why }
export function decide(P, from, to, cls, now) {
  const t = tableOf(P, to);
  if (t.paused) return { mode: "nobody", why: `${to} has paused (every class is nobody, friends included)` };
  const o = t.overrides[from]?.[cls];
  if (o && (o.until === undefined || o.until > now)) return o.mode === "deny" ? { mode: "nobody", why: `${to} said no to ${cls} from ${from}` } : { mode: "everyone", why: `${to} allowed ${cls} from ${from}`, standing: "allow" };
  const tier = isFriend(P, from, to) ? "friends" : "strangers";
  return { mode: t[tier][cls], tier, why: `${to}'s ${cls} for ${tier} is ${t[tier][cls]}` };
}
// L6: change a table. Only the person opens; anyone they named a friend may CLOSE (pause, deny), never open.
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
  const opening = a.preset !== undefined || (a.set && a.set.mode !== "nobody") || a.allow !== undefined || a.pause === false || a.friend !== undefined;
  if (!self && (opening || !(t.friends ?? []).includes(actor))) return { ok: false, code: "consent", reason: self ? "" : opening ? `only ${target} may open ${target}'s consent` : `${target} hasn't named you someone they trust` };
  if (a.preset !== undefined) { if (typeof a.preset !== "string" || !Object.hasOwn(PRESETS, a.preset)) return { ok: false, code: "shape", reason: `no preset '${a.preset}'`, fix: Object.keys(PRESETS).join(", ") }; t.preset = a.preset; t.cells = bag(); }
  if (a.set) { const { class: c, tier = "strangers", mode } = a.set;
    if (!CLASSES.includes(c) || !MODES.includes(mode) || !["strangers", "friends"].includes(tier)) return { ok: false, code: "shape", reason: "set {class, tier: strangers|friends, mode: everyone|ask|nobody}" };
    ((t.cells ??= bag())[tier] ??= bag())[c] = mode; }
  if (a.allow !== undefined || a.deny !== undefined) { const who = a.allow ?? a.deny; const cls = a.class !== undefined ? [a.class] : CLASSES;
    if (!isWho(who)) return { ok: false, code: "shape", reason: "allow/deny: an identity" };
    if (!cls.every((c) => CLASSES.includes(c))) return { ok: false, code: "shape", reason: `class: one of ${CLASSES.join(", ")}` };
    const until = a.allow !== undefined ? now + Math.min(a.for ?? 3600000, MAX_ALLOW_MS) : undefined;
    for (const c of cls) ((t.over ??= bag())[who] ??= bag())[c] = { mode: a.allow !== undefined ? "allow" : "deny", ...(until ? { until } : {}) }; }
  if (a.pause !== undefined) t.paused = !!a.pause;
  if (a.friend !== undefined && !isWho(a.friend)) return { ok: false, code: "shape", reason: "friend: an identity" };
  if (a.friend !== undefined) t.friends = [...new Set([...(t.friends ?? []), a.friend])];
  return { ok: true, target };
}
