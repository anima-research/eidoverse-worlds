// shared/thingref.js — how a reader names a thing without its id (R 10-17 00:46, STAGING-TODO "ID HARDENING" (5)).
// An id is opaque (26 base32: shared/protocol/ids.js) and never changes; what a thing is CALLED is its label, which anyone
// may change and which two things may share (duplicate labels stay allowed: ambiguity is surfaced, never forbidden). So:
//   handleOf   a short handle for reading: the shortest prefix of the id (at least 4 characters) no other id here starts
//              with, derived fresh from what is here now (git's abbreviated hash). An id of 12 characters or fewer (an
//              older readable id: "tower", "lamp-light") is its own handle.
//   resolveThing  what someone typed → one thing: its exact id; else its label (case and outer spaces ignored); else a
//              unique id prefix of 4 or more characters. Several things matching is refused with the candidates, never
//              resolved by picking one. Pure: the agent's tools (mcpl) and the editor's Hierarchy read the same rules.
// Scripts never look things up by label: they reference by id (docs/SCRIPTS.md).
export const HANDLE_MIN = 4;
export const WHOLE_UP_TO = 12;

/** The shortest unique prefix (≥ HANDLE_MIN) of `id` among `ids` (an iterable of every id here), or the id itself. */
export function handleOf(id, ids) {
  id = String(id);
  if (id.length <= WHOLE_UP_TO) return id;
  const others = []; for (const x of ids) if (x !== id) others.push(String(x));
  for (let n = HANDLE_MIN; n < id.length; n++) { const p = id.slice(0, n); if (!others.some((x) => x.startsWith(p))) return p; }
  return id;
}

/**
 * @param {string} raw what was typed
 * @param {{id: string, label?: unknown}[]} things every thing here
 * @returns {{id: string, by: "id" | "label" | "prefix"} | {ambiguous: {id: string, label?: string}[], by: "label" | "prefix"} | {none: true}}
 */
export function resolveThing(raw, things) {
  const q = String(raw ?? "").trim(); if (!q) return { none: true };
  const list = [...things];
  const exact = list.find((t) => t.id === q); if (exact) return { id: exact.id, by: "id" };
  const lq = q.toLowerCase();
  const byLabel = list.filter((t) => typeof t.label === "string" && t.label.trim().toLowerCase() === lq);
  if (byLabel.length === 1) return { id: byLabel[0].id, by: "label" };
  if (byLabel.length > 1) return { ambiguous: byLabel, by: "label" };
  if (q.length >= HANDLE_MIN) {
    const byPrefix = list.filter((t) => t.id.startsWith(q));
    if (byPrefix.length === 1) return { id: byPrefix[0].id, by: "prefix" };
    if (byPrefix.length > 1) return { ambiguous: byPrefix, by: "prefix" };
  }
  return { none: true };
}

/** Which of `things` share a label with another of them: id → true (the Hierarchy marks only these twins). */
export function labelTwins(things) {
  const seen = new Map(); for (const t of things) { const l = typeof t.label === "string" ? t.label.trim().toLowerCase() : ""; if (!l) continue; seen.set(l, (seen.get(l) ?? 0) + 1); }
  const out = new Set(); for (const t of things) { const l = typeof t.label === "string" ? t.label.trim().toLowerCase() : ""; if (l && seen.get(l) > 1) out.add(t.id); }
  return out;
}
