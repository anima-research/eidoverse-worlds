// placer — who may AUTHOR a thing, mirrored from the server's rule
// (server/rights.ts placerOf/isPlacer) so the panels can grey out what the
// server would refuse without re-deriving authorship from display names.
//
// An entity carries its placer PRINCIPAL from creation: {id, sub?}. When the
// door vouched for a subject, the subject is the deed and the display id is a
// nameplate — a rename keeps your things, a stranger wearing your old name
// gets none of them. Without a subject (self-asserted humans, entities that
// predate the stamp) the display id is all there is. The world's owner and an
// operator pass regardless: the server says so too.
import { entityMeta, comps } from './world.js';
import { net } from './net.js';

/** The principal that placed `id`, or a display-id fallback for old entities. */
export function placerOf(id) {
  const meta = entityMeta.get(id);
  if (!meta) return null;
  if (meta.placer?.id) return meta.placer;
  return meta.actor ? { id: meta.actor } : null;
}

/** May I author `id`? Placer by subject when it has one, by display id otherwise; owner/operator always. */
export function mayAuthor(id) {
  if (net.myRights?.role === 'owner') return true;
  const p = placerOf(id);
  if (!p) return false;
  return p.sub ? net.mySub === p.sub : net.myId === p.id;
}

/** The name to SHOW for who guards `id`: the stamped placer's display id,
 *  never the entity's latest `actor`. The two drift on purpose — an owner's
 *  partial re-light updates `actor` while the placer stays — and round one
 *  labelled the guard with `actor`, so a panel could authorize Bob and tell
 *  the room the owner guarded it (Mica, #190 round 2). Every guard label in
 *  the browser reads through here; `actor` is creation/last-edit attribution
 *  and nothing more. */
export function placerName(id) { return placerOf(id)?.id ?? 'its placer'; }

/** Guarded by someone I am not: the server would refuse every edit. */
export function guardedByOther(id) {
  return !!comps.get(id)?.guard && !mayAuthor(id);
}
