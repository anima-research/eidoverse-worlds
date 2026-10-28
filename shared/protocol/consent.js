// Body consent (PROTOCOL §5, R 10-28): two gates per body and two lists of people. PRESENCE ONLY: nothing here is ever
// appended to a log or written to world state. The authority keeps one table per body in its presence plane, refuses
// before delivery, and the target's client has the final word.
//   gates   move  = where my body is: shoved (a /boom's force too), dragged, carried, seated or occupied (shove, displace)
//           touch = everything else done to it: touched (intimate points too) and posed (touch, intimate, pose)
//           each on or off; never chosen = the world's @world.body-default for that gate, else DEFAULT_GATES
//   lists   allow = these people always may, every class, whatever the gates say; block = these never may. Block beats allow.
// Its history: a table of cells per tier (to 10-20), then one switch accept|ask|refuse (to 10-28); `ask` and its inbox are
// on branch archive/consent-ask. A stored table in either shape is read and rewritten (migratePresence, at load).
// near, follow and voice are named classes no gate covers yet (nothing here enforces them): the lists still answer them.
import { CONTACT_POINTS, canonicalPoint } from "../contact.js";
export const CLASSES = ["near", "follow", "touch", "intimate", "pose", "shove", "displace", "voice"];
export const ENFORCED = ["touch", "intimate", "pose", "shove", "displace"];
// ---- the two gates (R 10-28: "keep main's shape of binary switches"; main had pushable on, posable off) ----
export const GATES = ["move", "touch"];
export const GATE_OF = Object.freeze({ shove: "move", displace: "move", touch: "touch", intimate: "touch", pose: "touch" });
export const DEFAULT_GATES = Object.freeze({ move: true, touch: false });
export const KIND_CLASS = { pose: "pose", anim: "pose", shove: "shove", drag: "displace", occupy: "displace", carry: "displace", touch: "touch" };
// ---- a stored table's words before 10-20 (tiers of cells, presets), read by migratePresence only; never written ----
export const TIERS = ["everyone", "friends"];
export const MODES = ["allow", "ask", "deny"];
/** The words before 10-17, read in a stored table; never written. */
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
export const DEFAULT_PRESET = "normal";
// a reach descriptor the relay strips (server/reachgate.ts → bodyconsent.js reachAdmits) is said to the reacher once per
// (reacher, target, class) per this long: a stream of frames is one attempt, never one message a frame
export const REACH_NOTE_MS = 15000;
// a refused act on my body is said to ME (body-refused: who, and which gate, or my block list) once per asker per this long,
// whatever they try in between (main's client said "X tried to knock you over" on every one; this can't be spammed)
export const TRIED_NOTE_MS = 60000;
// Touch is judged by where a hand is, not how it was aimed (42 P8): a named point is intimate if it is one of these, and
// touch if it is any other contact point (shared/contact.js). ONE classifier, namedPointClass, for the relay
// (server/reachgate.ts), the authority's reach verb and the agent. Both classes are behind the touch gate.
export const INTIMATE_POINTS = new Set(["chest_front", "waist_l", "waist_r", "hip_l", "hip_r"]);
export const REACH_POINTS = Object.keys(CONTACT_POINTS);
/** a named contact point (any spelling canonicalPoint takes) → { point (canonical), cls: touch | intimate }; null if not a point */
export function namedPointClass(name) { const point = canonicalPoint(name); return point ? { point, cls: INTIMATE_POINTS.has(point) ? "intimate" : "touch" } : null; }
// What the ACTOR is told when a table refuses: the same words for a closed gate and a block (10-13 consent research: the
// reason leaked a per-person deny). The real cause (decide's why) goes to the target's own attempt ring only.
export const refusalWords = (to, cls) => `${to} isn't taking ${cls} right now`;
export const REFUSAL_FIX = "leave it be: it is theirs to open";
// a world-space point at a body: inside its capsule (r 0.25 m, feet to 1.8 m) is a touch; the torso/pelvis core is intimate
export function pointClass(bodyAt, p) {
  const h = Math.hypot(p[0] - bodyAt[0], p[2] - bodyAt[2]), y = p[1] - bodyAt[1];
  if (h > 0.25 + 0.05 || y < -0.05 || y > 1.85) return null; // TOUCH_GAP 5 cm (42 §4.5)
  return h <= 0.2 && y >= 0.8 && y <= 1.5 ? "intimate" : "touch";
}

const listed = (t, list, who) => !!t?.[list] && Object.hasOwn(t[list], who);
/** What the authority holds for one body: each gate as chosen (undefined = never chosen) and the two lists. */
export function tableOf(P, who) { const t = P.consent?.[who];
  return { move: t?.move, touch: t?.touch, allow: Object.keys(t?.allow ?? {}), block: Object.keys(t?.block ?? {}) }; }
/** A world's @world.body-default as {move?, touch?}. The switch's words (to 10-28) are read too, in a stored value only,
 *  as a person's stored switch is (migratePresence): refuse → both off, ask → move on and touch off, accept → move on. */
export function worldGates(v) {
  if (v === "refuse") return { move: false, touch: false };
  if (v === "ask") return { move: true, touch: false };
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
  if (listed(t, "allow", from)) return { mode: "allow", why: `${to} always allows ${from}` };
  const gate = GATE_OF[cls]; if (!gate) return { mode: "allow", why: `no gate covers ${cls}` };
  if (typeof t?.[gate] === "boolean") return { mode: t[gate] ? "allow" : "deny", gate, why: `${to}'s ${gate} gate is ${t[gate] ? "on" : "off"}` };
  const w = worldGates(worldDefault ?? P.bodyDefault)[gate];   // the authority keeps P.bodyDefault = @world.body-default
  const on = typeof w === "boolean" ? w : DEFAULT_GATES[gate];
  return { mode: on ? "allow" : "deny", gate, why: `this world's default for ${gate} is ${on ? "on" : "off"}` };
}
// Change your body's answers. Only you: there is no one who decides for you.
// Names arrive from the wire: every table is prototype-less, and a "who" must look like an identity (security pass 2,
// H-0: deny '__proto__' wrote into Object.prototype for every world in the process).
const BAD_KEY = new Set(["__proto__", "constructor", "prototype"]);
const isWho = (w) => typeof w === "string" && /^[A-Za-z0-9_.:@+-]{1,64}$/.test(w) && !BAD_KEY.has(w);
const bag = () => Object.create(null);
export const PERSON_OPS = ["allow", "block", "unlist"];
/** Arguments of earlier shapes, refused with a pointer: the switch and its ask (to 10-28), the table before it (to 10-20). */
export const RETIRED_CONSENT = ["switch", "deny", "class", "for", "answer", "yes", "preset", "set", "pause", "friend", "unfriend", "delegate", "undelegate", "of"];
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
  const t = ((P.consent ??= bag())[actor] ??= bag());
  for (const g of GATES) if (a[g] !== undefined) t[g] = a[g];
  if (op) { if (t.allow) delete t.allow[who]; if (t.block) delete t.block[who];
    if (op !== "unlist") (t[op] ??= bag())[who] = true; }
  return { ok: true, target: actor };
}
/** The presence plane's consent tables in today's shape (CONSENT_SHAPE), only ever NARROWER than they were. A switch (to
 *  10-28): refuse → both gates off; ask → move on, touch off; accept → move on, touch left to the world's default. A table
 *  before the switch (to 10-20: preset, cells, pause, friends) is read as the switch it became then: paused or any enforced
 *  class closed for everyone → refuse, else any ask → ask, else accept. Per-person answers become the lists: any class
 *  denied → block; else any class allowed with no end → allow (one with an end was a yes for a while, and is dropped). The
 *  asks, their cool-downs and their rate are dropped, silently (R 10-28 13:03: "we're keeping their gates"). Returns how many
 *  tables changed. In place; idempotent. */
export const CONSENT_SHAPE = 4;
function switchOf(t) {
  if (typeof t.switch === "string") return t.switch;
  if (t.preset === undefined && t.cells === undefined && !t.paused) return undefined;
  const row = { ...(PRESETS[t.preset] ?? PRESETS[DEFAULT_PRESET]).everyone };
  for (const [tier, r] of Object.entries(t.cells ?? {})) if (tierOf(tier) === "everyone" && r && typeof r === "object") for (const [c, m] of Object.entries(r)) row[classOf(c)] = modeOf(m);
  const modes = ENFORCED.map((c) => row[c]);
  return t.paused || modes.includes("deny") ? "refuse" : modes.includes("ask") ? "ask" : "accept";
}
export function migratePresence(P) {
  if (!P || typeof P !== "object" || P.consentShape === CONSENT_SHAPE) return 0;
  let n = 0;
  for (const t of Object.values(P.consent ?? {})) { if (!t || typeof t !== "object") continue;
    const old = ["switch", "over", "preset", "cells", "paused", "friends", "delegates"].filter((k) => Object.hasOwn(t, k)); if (!old.length) continue;
    const sw = switchOf(t);
    if (sw === "refuse") { t.move = false; t.touch = false; } else if (sw === "ask") { t.move = true; t.touch = false; } else if (sw === "accept") t.move = true;
    for (const [who, row] of Object.entries(t.over ?? {})) { if (!isWho(who) || !row || typeof row !== "object") continue;
      const cells = Object.values(row).filter((c) => c && typeof c === "object");
      if (cells.some((c) => c.mode === "deny")) (t.block ??= bag())[who] = true;
      else if (cells.some((c) => c.mode === "allow" && c.until === undefined)) (t.allow ??= bag())[who] = true; }
    for (const k of old) delete t[k]; n++; }
  for (const k of ["asks", "asked", "askSeq", "cool"]) if (Object.hasOwn(P, k)) { delete P[k]; n++; }
  for (const r of P.ring ?? []) if (r && Object.hasOwn(LEGACY_CLASS, r.cls)) r.cls = classOf(r.cls);
  for (const r of Object.values(P.reaches ?? {})) if (r && Object.hasOwn(LEGACY_CLASS, r.cls)) r.cls = classOf(r.cls);
  P.consentShape = CONSENT_SHAPE; return n;
}
