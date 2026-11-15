// models_field — the models realizer's pure half (docs/history/TEL0S_NOTES.md §11.4): diff the folded entities against
// what is realized and decide what to create, retire or rebuild. No THREE, no DOM; models.js executes the plan,
// test/client/models-field-test.ts tests this half (same split as ../flora_field.js / emitter_field.js).

import { P } from '../render/scheduler.js';
import { COMPONENTS } from '../../../shared/protocol/componentspec.js';
import { solidOff } from '../../../shared/protocol/simlayer.js';
import { isMeshBag } from '../../../shared/components.js';
export { isMeshBag };

/** The model a record draws, or null: the one component that decides what a realized object IS (a GLB, or a bare frame).
 *  Mesh, light and socket are realized on that frame, each on its own (models.js syncParts, syncCompLight). */
export const modelOf = (ent) => (typeof ent?.model === 'string' ? ent.model : null);

/** What the realizer needs to know about a realized id to detect identity drift: the model it wears (none for a frame).
 *  @typedef {{ model?: string|null }} RealizedView */

/** The registered `mesh` component (shared/protocol/componentspec.js), read as a client reads it: a malformed value is
 *  absent (the thing is an Empty), never a throw. A field outside its range is clamped to it; a capsule is at least its
 *  diameter tall (the authority's meshSize says the same). */
export const MESH_SHAPES = COMPONENTS.mesh.enums.shape;
const { min: SMIN, max: SMAX } = COMPONENTS.mesh.ranges.size;
export function readMesh(m) {
  if (!isMeshBag(m)) return null;
  const n = (x) => (typeof x === 'number' && Number.isFinite(x) ? Math.min(SMAX, Math.max(SMIN, x)) : 1);
  const size = Array.isArray(m.size) && m.size.length === 3 ? m.size.map(n) : [1, 1, 1];
  if (m.shape === 'capsule') size[1] = Math.max(size[0], size[1]);
  return { shape: m.shape, size };
}
/** One string per distinct geometry: a changed shape or size is reshaped in place by models.js (setMeshShape), not a planReconcile rebuild. */
export const meshKeyOf = (ent) => { const m = readMesh(ent?.mesh); return m ? `${m.shape}|${m.size.join(',')}` : null; };

/** Switched off (componentspec `disabled`), itself or anything it hangs under: not loaded, not drawn, no collider — present
 *  in the world as links, not downloaded, until re-enabled. Same rule as the engine's offChain. */
export function offIn(stEntities, id) { for (let k = id, n = 0; k && n < 33; k = stEntities[k]?.parent?.to, n++) if (stEntities[k]?.disabled === true) return true; return false; }

/** Diff folded entities against the realized view.
 *  - in state but not realized → create; realized but gone from state → retire
 *  - realized as one kind, folded as another (the id namespace is flat) → rebuild
 *  - a model whose `lib` changed → rebuild (a mesh's geometry key is the hosted half's): the planner projects
 *    whatever the fold holds (a `set` of the component; a create of a live id is a fold no-op)
 *  - anything else (transform, params, comps) is the hosted half's in-place refresh
 *
 *  @param {Record<string, any>} stEntities  state.st.entities
 *  @param {Map<string, RealizedView>} realized
 *  @returns {{ create: {id: string, ent: any}[], retire: string[] }} */
export function planReconcile(stEntities, realized) {
  const create = [];
  const retire = [];
  for (const [id, view] of realized) {
    const ent = stEntities[id];
    if (!ent || offIn(stEntities, id)) { retire.push(id); continue; }
    if ((view.model ?? null) !== modelOf(ent)) {
      retire.push(id);
      create.push({ id, ent });
    }
  }
  for (const [id, ent] of Object.entries(stEntities)) {
    if (!realized.has(id) && !offIn(stEntities, id)) create.push({ id, ent });
  }
  return { create, retire };
}

/** Load priority by distance from the viewpoint, re-evaluated at dequeue so a walk toward something promotes it.
 *  Bands, not a curve. */
export function bandForDistance(d) {
  if (!Number.isFinite(d)) return P.VISIBLE;
  if (d <= 12) return P.NEAR;
  if (d <= 40) return P.VISIBLE;
  return P.FAR;
}

/** Entity mounts whose folded parent involves `touchedId` (as child or carrier): the set to re-check after a spawn
 *  realizes. A mount that cannot execute yet stays in the fold until both ends are live. */
export function mountsTouching(stEntities, touchedId, childrenOf = null) {
  // `childrenOf(id)` (the fold's own index, world.js) answers the carrier direction in O(children) instead of O(world)
  if (childrenOf) {
    const out = stEntities[touchedId]?.parent ? [touchedId] : [];
    for (const cid of childrenOf(touchedId)) out.push(cid);
    return out;
  }
  const out = [];
  for (const [id, ent] of Object.entries(stEntities)) {
    if (!ent.parent) continue;
    if (id === touchedId || ent.parent.to === touchedId) out.push(id);
  }
  return out;
}


/** Does this entity's collision belong to somebody else? Then no box is inferred for it here:
 *  - mounted cargo collides as its carrier (models.js execMount).
 *  - a `structure` entity's collision is declared by the structure realizer (exact wall/floor/corner boxes); the
 *    entity is only an anchor whose mesh is hidden, and a box inferred from it would be an invisible obstacle.
 *
 *  @param {any} ent   the folded entity record
 *  @param {boolean} mounted  whether the scene object rides a carrier */
export function collisionOwnedElsewhere(ent, mounted = false) {
  // collision off for bodies has no box either: collider {enabled: false} or blocks without bodies (simlayer.js solidOff, the authority's reading)
  return !!mounted || !!ent?.structure || solidOff(ent, 'bodies');
}
