// rightsfold — what a folded world says an identity may do, as one function
// both runtimes can call.
//
// This is the precedence rule out of server/rights.ts, and it lives here
// because THREE places needed it and two of them had reimplemented it by hand:
// the sequencer (authoritative), the browser (its own HUD + the flight gate),
// and the mcpl agent. Each hand-rolled merge was a chance to disagree with the
// authority, and two of them took it -- the browser erased its own `fly` with
// a partial grant, and the agent never updated at all until reconnect.
//
// PURE, per shared/README.md: the admin override stays in server/rights.ts
// because WORLD_ADMIN is an environment fact, not a world fact, and it reaches
// a client only as an already-computed `yourRights` in the snapshot.
//
// The rule, verbatim from rights.ts and verified against it by test:
//   - a world with no owner is OPEN: builder + gen, and NEVER fly
//   - otherwise a name-keyed record wins over the wildcard `*`
//   - a name-keyed grant bound to a sub is worn only by that sub
//   - gen is implied by owner; fly is implied by nothing
//   - the caption deed ({id, born}) is implied by nothing either: it is the
//     one additional authoring act a visitor may hold, for one entity
//   - a record past its `until` is read as ABSENT (its holder falls back to
//     the wildcard); the caller supplies the clock, so the fold never has to
//
// ENTRY (world access) is the bottom of the same ladder: `none` may not come
// in, `spectator` may watch, `visitor` and up may be embodied. One function
// answers both "may I build" and "may I be here", so the two cannot disagree.

import { ROLE_RANK } from './fold.js';

/** @param {{roles?: Record<string, any>}} st  a folded WorldState */
export function worldHasOwnerIn(st) {
  for (const [id, r] of Object.entries(st?.roles ?? {})) {
    if (id !== '*' && r?.role === 'owner') return true;
  }
  return false;
}

/**
 * @param {{roles?: Record<string, any>}} st
 * @param {string} id     display name
 * @param {string} [sub]  durable subject, when known
 * @param {number} [now]  the reader's clock (epoch ms) — records past their `until` are skipped
 * @param {{nameKeyed?: boolean}} [opts]  nameKeyed:false — a record filed only under a NAME (no sub)
 *   is not worn; only sub-bound records and the wildcard count. The entry decision for a closed
 *   world uses this: a display name is self-chosen, so a name-keyed grant must not be a key to it.
 * @returns {{role: string, gen: boolean, fly: boolean, caption?: {id: string, born?: number}, until?: number}}
 */
export function rightsIn(st, id, sub, now = Date.now(), { nameKeyed = true } = {}) {
  if (!worldHasOwnerIn(st)) return { role: 'builder', gen: true, fly: false };
  // An expired record is not there. Filtered BEFORE the precedence below, so
  // an expired name-keyed grant cannot shadow a live wildcard, and an expired
  // duplicate cannot make a live sub-record look ambiguous.
  const live = (x) => (x && !(typeof x.until === 'number' && x.until <= now) ? x : undefined);
  const roles = Object.fromEntries(Object.entries(st?.roles ?? {}).filter(([, x]) => live(x)));
  st = { ...st, roles };
  // A grant written while its subject's sub was known carries that sub, and
  // is stored under the DISPLAY NAME of the moment (fold.js grant). So the
  // lookup by sub has to find it under whatever name it was written for —
  // otherwise a rename lost every grant (Mica, #187 round 2: the caption
  // deed, but also gen and fly, went to the wildcard default after a rename).
  // …and FAILS CLOSED when history holds more than one record for the sub
  // (a world written before the migration): ambiguity answers with the
  // wildcard default, never with whichever record happens to come first,
  // until the owner's next grant folds them into one.
  const same = sub ? Object.values(st?.roles ?? {}).filter((x) => x && x.sub === sub) : [];
  const bySub = sub ? (st?.roles?.[sub] ?? (same.length === 1 ? same[0] : undefined)) : undefined;
  const byName = st?.roles?.[id];
  let r = bySub ?? (same.length > 1 || (byName && !byName.sub && !nameKeyed) ? undefined : byName) ?? st?.roles?.['*'] ?? { role: 'builder' };
  // a name-keyed grant that KNOWS its subject's sub is worn only by that sub
  if (r.sub && r.sub !== sub) r = st?.roles?.['*'] ?? { role: 'builder' };
  return {
    role: r.role,
    gen: r.role === 'owner' || Boolean(r.gen),
    fly: Boolean(r.fly),
    ...(r.caption && r.caption.id ? { caption: { id: String(r.caption.id), ...(r.caption.born != null ? { born: r.caption.born } : {}) } } : {}),
    ...(typeof r.until === 'number' ? { until: r.until } : {}),
  };
}

/** What a computed rights answer says about ENTRY: 'embody' (visitor and
 *  up), 'watch' (spectator), or 'none'. An unknown role string reads as
 *  'none' — fail closed on a rung this reader does not know.
 *  @param {{role: string}} rights */
export function entryOf(rights) {
  const rank = ROLE_RANK[rights?.role];
  if (rank == null) return 'none';
  return rank >= ROLE_RANK.visitor ? 'embody' : rank >= ROLE_RANK.spectator ? 'watch' : 'none';
}

/** The world's door for everyone not named: the wildcard's rung, or the
 *  default ('builder' in an owned world, open in an ownerless one).
 *  @param {{roles?: Record<string, any>}} st */
export function wildcardRoleIn(st) {
  if (!worldHasOwnerIn(st)) return 'builder';
  return st?.roles?.['*']?.role ?? 'builder';
}

/** Does this world restrict who may come in? True when the wildcard sits
 *  below visitor — members-only (`none`) or watch-only (`spectator`).
 *  @param {{roles?: Record<string, any>}} st */
export function entryRestrictedIn(st) {
  return (ROLE_RANK[wildcardRoleIn(st)] ?? 0) < ROLE_RANK.visitor;
}
