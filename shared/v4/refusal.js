// shared/v4/refusal.js — how a door refusal reads, in one place, so a person in edit mode and an agent calling a tool
// see the same words for the same refusal (PARITY: "refusals show the same text the agents get"). The door's reply is
// {ok: false, refused: {code, reason, fix, …}}; `what` names the request ("place", "undo", "move crate-1").
//
// Names: an identity or id outside the §2.3 grammar ("Riannon", "Lamp") is stored escaped (x--5269…). These words are
// read by people and by agents' tools (which take plain names), so an escaped name is read back as it is spelled. A
// hashed name (h--) can't be read back and stays. The door tool's raw JSON reply is untouched: its ids are the ones to
// send back, and the door says people's names readably itself (with the id in `by`).
import { dec, actorName, ACTOR_ID } from "./names.js";

// an actor id (u-…) reads as its display name (names.js registry); an escaped name reads back as spelled
const readable0 = (s) => String(s).replace(ACTOR_ID, (m) => actorName(m)).replace(/\bx--(?:[0-9a-f]{2})+\b/g, (m) => dec(m) ?? m);
const readable = readable0;

export function refusalText(what, reply) {
  const r = reply?.refused ?? {};
  return readable(`${what} refused by the door (${r.code ?? "refused"}): ${r.reason ?? ""}${r.fix ? ` — ${r.fix}` : ""}`);
}

// ---- for people (ship list 10-07: "refusals shown to humans use tool syntax and hex ids") ----
// A person reads what they tried and why, in words: no refusal code, no tool syntax (the door's fix is for agents and
// is kept only when it's already plain words), and things named by their labels. `nameOf(id)` → how a person knows that
// thing (its label, or what it is), or null when the word isn't a thing's id. An agent's tools keep refusalText, and the
// client logs that too (the console), so nothing is lost for whoever wants the door's whole answer.
const TOOLISH = /[{}[\]`]|=>|\w\s*\(|\b\w+:\s*['"\d[{tf]|throughLock|merge: true/;
/** Ids in a sentence → names a person knows (a dotted path "lamp.light.intensity" → "Lamp's light intensity"). */
export function namedFor(text, nameOf = () => null) {
  return readable(String(text)).replace(/(?<![\w@-])([a-z0-9][a-z0-9-]{0,63})((?:\.[a-zA-Z][\w-]*(?::[\w-]+)?)*)(?![\w-])/g, (m, id, path) => {
    const n = nameOf(id); if (!n) return m;
    return path ? `${n}'s ${path.slice(1).split(".").join(" ")}` : n; });
}
/** "Couldn't move the crate: …" — a refusal as a person reads it. */
export function plainRefusal(what, reply, nameOf = () => null) {
  const r = reply?.refused ?? {};
  const fix = typeof r.fix === "string" && r.fix && !TOOLISH.test(r.fix) ? r.fix : "";
  const reason = String(r.reason ?? "it wasn't allowed").replace(/\s*\(§[^)]*\)/g, "");
  return namedFor(`Couldn't ${what}: ${reason}${fix ? `. ${fix.replace(/^./, (c) => c.toUpperCase())}` : ""}`, nameOf);
}

// ---- the lock question (PROTOCOL-v4 §5; R's dialog, research 44 #1) ----
// A lock refusal asks a person who may lift locks "This is locked. Move anyway?" with three answers. An agent gets the
// same refusal text and the same two ways through in the door's fix (throughLock, or unlock first).

/** The verb a lock refusal asks about: what the request would do to the locked thing. */
export function lockVerb(req) {
  if (req?.tool === "undo") return "Undo";
  const ops = req?.tool === "batch" ? (req.args?.ops ?? []) : [req];
  const comp = (o) => o?.args?.component;
  if (ops.some((o) => o?.tool === "delete" && comp(o) === undefined)) return "Delete";
  if (ops.some((o) => o?.tool === "set" && comp(o) === "model")) return "Replace";
  if (ops.some((o) => o?.tool === "place" || ((o?.tool === "set" || o?.tool === "delete") && ["transform", "parent"].includes(comp(o))))) return "Move";
  return "Change";
}
/** "This is locked. Move anyway?" */
export const lockQuestion = (verb) => `This is locked. ${verb} anyway?`;
/** The lock question's one line for a person: who locked it, and which thing when the lock is on a parent.
 *  The door's full refusal (with its teaching for agents) stays in the log and the console. */
export function lockBody(r, id) {
  const k = r?.refused?.lock; const by = r?.refused?.by;
  const who = by ? ` by ${readable(by)}` : "";
  return k && id && k !== id ? `It rides ${readable(k)}, which is locked${who}.` : `Locked${who}.`;
}
/** The three answers, in R's order. `through` re-sends with throughLock (one act, the lock stays on); `cancel` writes
 *  nothing and puts the thing back; `unlock` removes the lock and then does it (two acts; Ctrl+Z undoes the edit first). */
export const lockChoices = (verb) => [
  { v: "through", label: `✓ ${verb} anyway` },
  { v: "cancel", label: "✕ Cancel" },
  { v: "unlock", label: "🔓 Unlock" },
];

/** A door warning ({id, kind, …}) as one sentence for a person or an agent (agent lab: "the out-of-bounds warning doesn't
 *  say out of what"; "edit replies… warnings get lost"). */
export function warningText(w, nameOf = null) {
  if (!w || typeof w !== "object") return String(w);
  const readable = (x) => (nameOf ? namedFor(x, nameOf) : readable0(x));   // a person's surface names things by label
  const id = readable(w.id ?? "?");
  switch (w.kind) {
    case "overlap": return `${id} overlaps ${readable(w.with)} by ${w.by} m`;
    case "sunk": return `${id} sinks ${w.depth} m into ${readable(w.into)}`;
    case "floating": return `${id} floats ${w.gap} m above ${readable(w.above)}`;
    case "out-of-bounds": return w.bounds ? `${id} is outside the world's bounds (x ${w.bounds.min[0]}…${w.bounds.max[0]}, y ${w.bounds.min[1]}…${w.bounds.max[1]}, z ${w.bounds.min[2]}…${w.bounds.max[2]} m)` : `${id} is outside the world's bounds`;
    default: return `${id}: ${w.kind ?? JSON.stringify(w)}`;
  }
}

/** How long ago, in words a person reads at a glance. */
export function agoWords(ts, now = Date.now()) {
  const s = Math.max(0, (now - ts) / 1000);
  return s < 60 ? "just now" : s < 3600 ? `${Math.round(s / 60)} min ago` : s < 86400 ? `${Math.round(s / 3600)} h ago` : new Date(ts).toISOString().slice(0, 10);
}
/** One component's provenance from the door's inspect `touched` (R 10-04, "where a value came from"), the same words in
 *  the Inspector's card tooltip and an agent's inspect: "set by Rowan · 3 min ago", "as made by Ann · 2 h ago", or, past
 *  the recent window, "unchanged since before act #N — history for older". Never claims more than the window saw. */
export function touchWords(t, now = Date.now()) {
  if (!t) return null;
  if (t.beyond !== undefined) return `unchanged since before act #${t.beyond} — history for older`;
  return `${t.created ? "as made by" : "set by"} ${readable(t.by)} · ${agoWords(t.ts, now)}`;
}
