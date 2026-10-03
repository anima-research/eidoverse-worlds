// models_field — the models realizer's pure half (TEL0S_NOTES §11.4).
//
// Given the folded state's entity record and a view of what is currently
// realized in the scene, decide WHAT must change: which ids to create,
// which to retire, which to rebuild because their identity changed out
// from under them. No THREE, no DOM, no scheduler calls — the hosted half
// (models.js) executes the plan; this half is the part a headless test can
// hold to the light (tools/models-field-test.ts). Same discipline as
// flora_field.js / emitter_field.js.

import { P } from '../scheduler.js';

/** What the realizer needs to know about a realized id to detect identity
 *  drift. kind: 'model' | 'light'; lib only meaningful for models.
 *  @typedef {{ kind: 'model'|'light', lib?: string }} RealizedView */

/** Diff folded entities against the realized view.
 *
 *  Identity rules:
 *  - an id in state but not realized → create
 *  - realized but gone from state → retire
 *  - realized as one kind, folded as the other (a `light` verb landing on a
 *    model id, or a spawn replacing a light — the id namespace is flat) →
 *    rebuild (retire + create)
 *  - a model whose `lib` changed → rebuild. The fold OVERWRITES a same-id
 *    spawn (that is what the reference fold does; the realizer projects
 *    state, so it follows — note: PROTOCOL.md §3 says "no-op if id exists",
 *    which the reference implementation contradicts; flagged upstream, and
 *    whichever way that lands, this planner keeps projecting the fold).
 *  - everything else (transform, params, comps) is a cheap in-place refresh
 *    the hosted half applies directly; not this planner's business.
 *
 *  @param {Record<string, any>} stEntities  state.st.entities
 *  @param {Map<string, RealizedView>} realized
 *  @returns {{ create: {id: string, ent: any}[], retire: string[] }} */
export function planReconcile(stEntities, realized) {
  const create = [];
  const retire = [];
  for (const [id, view] of realized) {
    const ent = stEntities[id];
    if (!ent) { retire.push(id); continue; }
    const foldedKind = ent.kind === 'light' ? 'light' : 'model';
    if (view.kind !== foldedKind || (foldedKind === 'model' && view.lib !== ent.lib)) {
      retire.push(id);
      create.push({ id, ent });
    }
  }
  for (const [id, ent] of Object.entries(stEntities)) {
    if (!realized.has(id)) create.push({ id, ent });
  }
  return { create, retire };
}

/** Load priority for an entity's assets, by distance from the viewpoint.
 *  Re-evaluated at dequeue (the scheduler takes a function), so a walk
 *  toward something promotes it without rescheduling. Bands, not a curve:
 *  the difference that matters is "in front of you" vs "the world behind
 *  you", not metre seventeen vs metre eighteen. */
export function bandForDistance(d) {
  if (!Number.isFinite(d)) return P.VISIBLE;
  if (d <= 12) return P.NEAR;
  if (d <= 40) return P.VISIBLE;
  return P.FAR;
}

/** Entity mounts (state parent records) whose scene linkage should exist:
 *  returns the ids whose folded parent involves `touchedId` (as child or
 *  carrier) — the set to re-check after a spawn realizes. With state as the
 *  single pending list, there is no pendingMounts map to maintain: a mount
 *  that cannot execute yet simply stays visible in the fold until both ends
 *  are live. */
export function mountsTouching(stEntities, touchedId, childrenOf = null) {
  // `childrenOf` (parent id -> Set of child ids, the hosted half's
  // fold-parent index, §16.2.C) answers the carrier direction in
  // O(children) instead of O(world); membership is identical to the scan
  // below by construction (the index is maintained on every parent write).
  if (childrenOf) {
    const out = stEntities[touchedId]?.parent ? [touchedId] : [];
    const kids = childrenOf.get(touchedId);
    if (kids) for (const cid of kids) out.push(cid);
    return out;
  }
  const out = [];
  for (const [id, ent] of Object.entries(stEntities)) {
    if (!ent.parent) continue;
    if (id === touchedId || ent.parent.to === touchedId) out.push(id);
  }
  return out;
}


/** Does this entity's collision belong to somebody else?
 *
 *  Two cases, one law: an entity whose collision is owned elsewhere must not
 *  have a box inferred for it here.
 *
 *  - MOUNTED cargo collides as its carrier (execMount law).
 *  - A `structure` entity's collision is DECLARED by the structure realizer —
 *    walls, floors and corner fills, each an exact box. The entity itself is
 *    only an anchor for the component, and its lib is a placeholder whose mesh
 *    is hidden. Inferring a box from that placeholder left an invisible
 *    crate-sized obstacle at the origin of every building: the mesh was
 *    hidden, the collider was not.
 *
 *  @param {any} ent   the folded entity record
 *  @param {boolean} mounted  whether the scene object rides a carrier */
export function collisionOwnedElsewhere(ent, mounted = false) {
  return !!mounted || !!ent?.comp?.structure;
}

/** Derived materialization UI state; error content is a fixed safe summary. */
export function loadStatus(tracked, realized, inRange) {
  const state = realized ? 'ready' : tracked.loading ? (tracked.phase ?? 'queued')
    : !inRange ? 'deferred' : tracked.failedAt ? 'failed' : 'queued';
  return { state, error: tracked.error ?? null,
    retryAvailable: state === 'failed',
    label: ({ready: 'Ready', queued: 'Queued', loading: 'Loading',
      deferred: 'Loads when nearby', failed: 'Loading failed'})[state] };
}
