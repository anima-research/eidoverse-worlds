// Body consent (PROTOCOL §5): two gates per body and two lists of people. PRESENCE ONLY: nothing here is ever
// appended to a log or written to world state. The authority keeps one table per body in its presence plane, refuses
// before delivery: the authority alone decides (decide below; no client gate).
//   gates   move  = where my body is: shoved (a /boom's force too), dragged, carried, seated or occupied (shove, displace)
//           touch = everything else done to it: touched (intimate points too) and posed (touch, intimate, pose)
//           each on or off; never chosen = the world's @world.body-default for that gate, else DEFAULT_GATES
//   lists   allow = these people always may, every class, whatever the gates say; block = these never may. Block beats allow.
// A stored table in an older shape (cells per tier, or one switch accept|ask|refuse) is read and rewritten
// (migratePresence, at load).
// near, follow and voice are named classes no gate covers yet (nothing here enforces them): the lists still answer them.
import { CONTACT_POINTS, canonicalPoint } from "../contact.js";
export const CLASSES = ["near", "follow", "touch", "intimate", "pose", "shove", "displace", "voice"];
export const ENFORCED = ["touch", "intimate", "pose", "shove", "displace"];
// ---- the two gates: binary switches (move on, touch off by default) ----
export const GATES = ["move", "touch"];
export const GATE_OF = Object.freeze({ shove: "move", displace: "move", touch: "touch", intimate: "touch", pose: "touch" });
export const DEFAULT_GATES = Object.freeze({ move: true, touch: false });
export const KIND_CLASS = { pose: "pose", anim: "pose", shove: "shove", drag: "displace", occupy: "displace", carry: "displace", touch: "touch" };
// ---- an older stored table's words (cells per tier, presets), read by migratePresence only; never written ----
const LEGACY_TIER = Object.freeze({ strangers: "everyone" });
const LEGACY_MODE = Object.freeze({ everyone: "allow", nobody: "deny" });
const LEGACY_CLASS = Object.freeze({ move: "displace" });
const legacyTier = (t) => (Object.hasOwn(LEGACY_TIER, t) ? LEGACY_TIER[t] : t);
const modeOf = (m) => (Object.hasOwn(LEGACY_MODE, m) ? LEGACY_MODE[m] : m);
const classOf = (c) => (Object.hasOwn(LEGACY_CLASS, c) ? LEGACY_CLASS[c] : c);
const NORMAL_FRIENDS = { near: "allow", follow: "allow", touch: "allow", intimate: "ask", pose: "ask", shove: "allow", displace: "ask", voice: "allow" };
const PRESETS = {
  normal: { everyone: { near: "ask", follow: "ask", touch: "ask", intimate: "deny", pose: "deny", shove: "deny", displace: "deny", voice: "ask" }, friends: NORMAL_FRIENDS },
  open: { everyone: { near: "allow", follow: "ask", touch: "allow", intimate: "deny", pose: "ask", shove: "ask", displace: "ask", voice: "allow" }, friends: NORMAL_FRIENDS },
  "friends-only": { everyone: Object.fromEntries(CLASSES.map((c) => [c, "deny"])), friends: NORMAL_FRIENDS },
  performer: { everyone: { near: "allow", follow: "ask", touch: "allow", intimate: "deny", pose: "allow", shove: "allow", displace: "ask", voice: "allow" }, friends: NORMAL_FRIENDS },
};
const DEFAULT_PRESET = "normal";
// a reach descriptor the relay strips (server/reachgate.ts → bodyconsent.js reachAdmits) is said to the reacher once per
// (reacher, target, class) per this long: a stream of frames is one attempt, never one message a frame
export const REACH_NOTE_MS = 15000;
// a refused act on my body is said to ME (body-refused: who, and which gate, or my block list) once per asker per this long,
// whatever they try in between (so it can't be spammed)
export const TRIED_NOTE_MS = 60000;
// Touch is judged by where a hand is, not how it was aimed: a named point is intimate if it is one of these, and
// touch if it is any other contact point (shared/contact.js). ONE classifier, namedPointClass, for the relay
// (server/reachgate.ts), the authority's reach verb and the agent. Both classes are behind the touch gate.
const INTIMATE_POINTS = new Set(["chest_front", "waist_l", "waist_r", "hip_l", "hip_r"]);
export const REACH_POINTS = Object.keys(CONTACT_POINTS);
/** a named contact point (any spelling canonicalPoint takes) → { point (canonical), cls: touch | intimate }; null if not a point */
export function namedPointClass(name) { const point = canonicalPoint(name); return point ? { point, cls: INTIMATE_POINTS.has(point) ? "intimate" : "touch" } : null; }
// What the ACTOR is told when a table refuses: the same words for a closed gate and a block (a distinct reason would leak
// a per-person deny). The real cause (decide's why) goes to the target's own attempt ring only.
export const refusalWords = (to, cls) => `${to} isn't taking ${cls} right now`;
export const REFUSAL_FIX = "leave it be: it is theirs to open";
// a world-space point at a body: inside its capsule (r 0.25 m, feet to 1.8 m) is a touch; the torso/pelvis core is intimate
export function pointClass(bodyAt, p) {
  const h = Math.hypot(p[0] - bodyAt[0], p[2] - bodyAt[2]), y = p[1] - bodyAt[1];
  if (h > 0.25 + 0.05 || y < -0.05 || y > 1.85) return null; // 5 cm: shared/reachwire.js TOUCH_GAP
  return h <= 0.2 && y >= 0.8 && y <= 1.5 ? "intimate" : "touch";
}

const listed = (t, list, who) => !!t?.[list] && Object.hasOwn(t[list], who);
/** What the authority holds for one body: each gate as chosen (undefined = never chosen) and the two lists. */
export function tableOf(P, who) { const t = P.consent?.[who];
  return { move: t?.move, touch: t?.touch, allow: Object.keys(t?.allow ?? {}), block: Object.keys(t?.block ?? {}) }; }
/** A world's @world.body-default as {move?, touch?}. The older switch's words are read too, in a stored value only,
 *  as a person's stored switch is (migratePresence): refuse and ask → both off, accept → move on. */
export function worldGates(v) {
  if (v === "refuse" || v === "ask") return { move: false, touch: false };   // ask was no until yes
  if (v === "accept") return { move: true };
  if (!v || typeof v !== "object") return {};
  return Object.fromEntries(GATES.filter((g) => typeof v[g] === "boolean").map((g) => [g, v[g]]));
}
/** What `to` says about `from` doing class `cls`: { mode: allow | deny, why }. One order, every body kind:
 *  block list > allow list > your gate for the class > the world's body-default for that gate > DEFAULT_GATES. `gate` is
 *  the gate that answered (null: the block list), for the target's own notice. */
export function decide(P, from, to, cls, worldDefault) {
  cls = classOf(cls); const t = P.consent?.[to];
  if (listed(t, "block", from)) return { mode: "deny", gate: null, why: `${to} never allows ${from}` };
  if (listed(t, "allow", from)) return { mode: "allow", listed: true, why: `${to} always allows ${from}` };
  const gate = GATE_OF[cls], wd = worldDefault ?? P.bodyDefault;   // the authority keeps P.bodyDefault = @world.body-default
  if (!gate) return t?.closed?.[cls] ? { mode: "deny", why: `${to} said no to ${cls} before the gates (kept: migratePresence)` }
    : wd === "refuse" || wd === "ask" ? { mode: "deny", why: `this world's old default (${wd}) said no to ${cls}` } : { mode: "allow", why: `no gate covers ${cls}` };
  if (typeof t?.[gate] === "boolean") return { mode: t[gate] ? "allow" : "deny", gate, why: `${to}'s ${gate} gate is ${t[gate] ? "on" : "off"}` };
  const w = worldGates(wd)[gate];
  const on = typeof w === "boolean" ? w : DEFAULT_GATES[gate];
  return { mode: on ? "allow" : "deny", gate, why: `this world's default for ${gate} is ${on ? "on" : "off"}` };
}
// Change your body's answers. Only you: there is no one who decides for you.
// Names arrive from the wire: every table is prototype-less, and a "who" must look like an identity (a '__proto__' must
// never reach Object.prototype).
const BAD_KEY = new Set(["__proto__", "constructor", "prototype"]);
const isWho = (w) => typeof w === "string" && /^[A-Za-z0-9_.:@+-]{1,64}$/.test(w) && !BAD_KEY.has(w);
const dict = () => Object.create(null);
/** An identity that will never return (a guest who left: their id is per connection): its table and every list naming it go. */
export function forgetIdentity(P, who) { if (!P?.consent) return; delete P.consent[who]; for (const t of Object.values(P.consent)) { if (t?.allow) delete t.allow[who]; if (t?.block) delete t.block[who]; } }
export const PERSON_OPS = ["allow", "block", "unlist"];
/** Arguments of earlier shapes, refused with a pointer: the switch and its ask, and the table before it. */
export const RETIRED_CONSENT = ["switch", "deny", "class", "for", "answer", "yes", "preset", "set", "pause", "friend", "unfriend", "delegate", "undelegate", "of"];
/** entries per list (allow, block); one naming a thing or sponsor not here yet is kept (it may arrive later) */
export const LIST_MAX = 1024;
export const CONSENT_FIX = "consent {move: true|false, touch: true|false}, or {allow|block|unlist: <who>} for one person";
export function setConsent(P, actor, a) {
  if (a == null || typeof a !== "object") return { ok: false, code: "shape", reason: "consent takes an object" };
  const gone = RETIRED_CONSENT.find((k) => a[k] !== undefined);
  if (gone) return { ok: false, code: "shape", reason: `consent has no '${gone}' since the two gates replaced the switch (R 10-28)`, fix: CONSENT_FIX };
  const bad = GATES.find((g) => a[g] !== undefined && typeof a[g] !== "boolean");
  if (bad) return { ok: false, code: "shape", reason: `${bad}: true or false, got ${JSON.stringify(a[bad])}`, fix: CONSENT_FIX };
  const ops = PERSON_OPS.filter((k) => a[k] !== undefined);
  if (ops.length > 1) return { ok: false, code: "shape", reason: `one of ${PERSON_OPS.join(", ")} at a time, got ${ops.join(" and ")}`, fix: CONSENT_FIX };
  const op = ops[0], who = op ? a[op] : undefined;
  if (op && !isWho(who)) return { ok: false, code: "shape", reason: `${op}: an identity`, fix: CONSENT_FIX };
  const t0 = P.consent?.[actor], size = op && op !== "unlist" ? Object.keys(t0?.[op] ?? {}).filter((k) => k !== who).length : 0;
  if (size >= LIST_MAX) return { ok: false, code: "bounds", reason: `your ${op} list holds ${LIST_MAX} entries, its limit`, fix: `remove one first: consent {unlist: <who>} (Settings ▸ body: remove)` };
  const t = ((P.consent ??= dict())[actor] ??= dict());
  for (const g of GATES) if (a[g] !== undefined) t[g] = a[g];
  if (op) { if (t.allow) delete t.allow[who]; if (t.block) delete t.block[who];
    if (op !== "unlist") (t[op] ??= dict())[who] = true; }
  return { ok: true, target: actor };
}
// migratePresence: an older stored table read as today's gates + lists, never wider; in place, idempotent (docs/decisions/CONSENT-TABLE-RECORD.md)
export const CONSENT_SHAPE = 4;
/** The classes no gate covers (near, follow, voice): an old no to one is kept in the table's `closed`, which decide reads.
 *  The day a class gets its own setting, its `closed` entry moves into that setting, so no old no outlives the switch that can reopen it. */
export const UNGATED = Object.freeze(CLASSES.filter((c) => !GATE_OF[c]));
function closedOf(t, sw) {
  if (sw === "refuse" || sw === "ask") return UNGATED;   // the switch answered every class; ask was no until yes
  if (typeof t.switch === "string" || !isTable(t)) return [];
  const row = rowOf(t, "everyone"); return UNGATED.filter((c) => row[c] !== "allow");
}
/** A table before the switch: its answers for one tier (the preset's, then its cells). */
function rowOf(t, tier) {
  const row = { ...(PRESETS[t.preset] ?? PRESETS[DEFAULT_PRESET])[tier] };
  for (const [k, r] of Object.entries(t.cells ?? {})) if (legacyTier(k) === tier && r && typeof r === "object") for (const [c, m] of Object.entries(r)) row[classOf(c)] = modeOf(m);
  return row;
}
const isTable = (t) => !(t.preset === undefined && t.cells === undefined && !t.paused);
function switchOf(t) {
  if (typeof t.switch === "string") return t.switch;
  if (!isTable(t)) return undefined;
  const row = rowOf(t, "everyone");
  const modes = ENFORCED.map((c) => row[c]);
  return t.paused || modes.includes("deny") ? "refuse" : modes.includes("ask") ? "ask" : "accept";
}
export function migratePresence(P) {
  if (!P || typeof P !== "object" || P.consentShape === CONSENT_SHAPE) return 0;
  let n = 0;
  const C0 = P.consent ?? {}, friendsOf = (w) => (Array.isArray(C0[w]?.friends) ? C0[w].friends : []);
  const befriended = new Set(Object.keys(C0).filter((w) => friendsOf(w).some((f) => f !== w && friendsOf(f).includes(w))));   // the old isFriend: mutual
  for (const [who, t] of Object.entries(C0)) { if (!t || typeof t !== "object") continue;
    const old = ["switch", "over", "preset", "cells", "paused", "friends", "delegates"].filter((k) => Object.hasOwn(t, k)); if (!old.length) continue;
    const sw = switchOf(t);
    if (sw === "refuse" || sw === "ask") { t.move = false; t.touch = false; } else if (sw === "accept") t.move = true;   // ask was no until yes
    for (const c of closedOf(t, sw)) (t.closed ??= dict())[c] = true;   // never wider for the ungated three too (UNGATED)
    // the new table has no per-friend slot: a friends-row no or ask turns that class off for everyone (its gate; ask → off), never refuses the load
    if (befriended.has(who) && isTable(t)) { const row = rowOf(t, "friends");
      for (const c of CLASSES) if (row[c] !== "allow") { if (GATE_OF[c]) t[GATE_OF[c]] = false; else (t.closed ??= dict())[c] = true; } }
    for (const [who, row] of Object.entries(t.over ?? {})) { if (!isWho(who) || !row || typeof row !== "object") continue;
      const cells = Object.entries(row).filter(([, c]) => c && typeof c === "object"), yes = new Set(cells.filter(([, c]) => c.mode === "allow" && c.until === undefined).map(([k]) => classOf(k)));
      if (cells.some(([, c]) => c.mode === "deny" || c.mode === "ask")) (t.block ??= dict())[who] = true;   // ask was no until yes
      else if (!t.paused && ENFORCED.every((c) => yes.has(c)) && UNGATED.every((c) => !t.closed?.[c] || yes.has(c))) (t.allow ??= dict())[who] = true; }   // allow grants every class: only a row that already did (a kept-closed ungated one too)
    for (const k of old) delete t[k]; n++; }
  for (const k of ["asks", "asked", "askSeq", "cool"]) if (Object.hasOwn(P, k)) { delete P[k]; n++; }
  for (const r of P.ring ?? []) if (r && Object.hasOwn(LEGACY_CLASS, r.cls)) r.cls = classOf(r.cls);
  for (const r of Object.values(P.reaches ?? {})) if (r && Object.hasOwn(LEGACY_CLASS, r.cls)) r.cls = classOf(r.cls);
  P.consentShape = CONSENT_SHAPE; return n;
}
