// thingref — how a reader names a thing without its id. An id is opaque (26 base32: shared/protocol/ids.js); a label
// is what it's called, changeable and shareable (ambiguity is surfaced, never forbidden). Pure: mcpl's tools and the
// editor's Hierarchy read the same rules.
//   handleOf      the shortest id prefix (≥ 4 chars) no other id here starts with, like git's abbreviated hash; an id
//                 of ≤ 12 chars (an older readable id: "tower") is its own handle.
//   resolveThing  typed text → one thing: exact id, else label (case/outer spaces ignored), else a unique id prefix of
//                 4+ chars. Several matches are returned as `ambiguous`, never picked from.
// Scripts reference by id, never by label (docs/guide/SCRIPTS.md).
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
