// shared/v4/refusal.js — how a door refusal reads, in one place, so a person in edit mode and an agent calling a tool
// see the same words for the same refusal (PARITY: "refusals show the same text the agents get"). The door's reply is
// {ok: false, refused: {code, reason, teach, …}}; `what` names the request ("place", "undo", "move crate-1").
//
// Names: an identity or id outside the §2.3 grammar ("Riannon", "Lamp") is stored escaped (x--5269…). These words are
// read by people and by agents' verb tools (which take v1 names), so an escaped name is read back as it is spelled. A
// hashed name (h--) can't be read back and stays. The door tool's raw JSON reply is untouched: its ids are the ones to
// send back, and the door says people's names readably itself (with the id in `by`).
import { dec } from "./names.js";

const readable = (s) => String(s).replace(/\bx--(?:[0-9a-f]{2})+\b/g, (m) => dec(m) ?? m);

export function refusalText(what, reply) {
  const r = reply?.refused ?? {};
  return readable(`${what} refused by the door (${r.code ?? "refused"}): ${r.reason ?? ""}${r.teach ? ` — ${r.teach}` : ""}`);
}

// ---- the lock question (PROTOCOL-v4 §5; R's dialog, research 44 #1) ----
// A lock refusal asks a person who may lift locks "This is locked. Move anyway?" with three answers. An agent gets the
// same refusal text and the same two ways through in the door's teach (through_lock, or unlock first).

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
/** The three answers, in R's order. `through` re-sends with through_lock (one act, the lock stays on); `cancel` writes
 *  nothing and puts the thing back; `unlock` removes the lock and then does it (two acts; Ctrl+Z undoes the edit first). */
export const lockChoices = (verb) => [
  { v: "through", label: `✓ ${verb} anyway` },
  { v: "cancel", label: "✕ Cancel" },
  { v: "unlock", label: "🔓 Unlock" },
];
