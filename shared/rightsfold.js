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
 * @returns {{role: string, gen: boolean, fly: boolean, caption?: {id: string, born?: number}}}
 */
export function rightsIn(st, id, sub) {
  if (!worldHasOwnerIn(st)) return { role: 'builder', gen: true, fly: false };
  // A grant written while its subject's sub was known carries that sub, and
  // is stored under the DISPLAY NAME of the moment (fold.js grant). So the
  // lookup by sub has to find it under whatever name it was written for —
  // otherwise a rename lost every grant (Mica, #187 round 2: the caption
  // deed, but also gen and fly, went to the wildcard default after a rename).
  const bySub = sub ? (st?.roles?.[sub] ?? Object.values(st?.roles ?? {}).find((x) => x && x.sub === sub)) : undefined;
  let r = bySub ?? st?.roles?.[id] ?? st?.roles?.['*'] ?? { role: 'builder' };
  // a name-keyed grant that KNOWS its subject's sub is worn only by that sub
  if (r.sub && r.sub !== sub) r = st?.roles?.['*'] ?? { role: 'builder' };
  return {
    role: r.role,
    gen: r.role === 'owner' || Boolean(r.gen),
    fly: Boolean(r.fly),
    ...(r.caption && r.caption.id ? { caption: { id: String(r.caption.id), ...(r.caption.born != null ? { born: r.caption.born } : {}) } } : {}),
  };
}
