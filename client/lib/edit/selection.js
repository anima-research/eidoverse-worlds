// selection — the editor's ONE selection (C6, 2026-10-12; review S2-1 / debt #7).
//
// Before this, six modules each held a piece of it (scenegraph's `selected` as the declared
// truth, build.js's `selected` reconciled to it every frame, editpanels' `extra` set plus
// `worldSel`/`envFocus`, structure_ui's `selectedId`), and an `extending` flag existed so the
// `sg:selected` a re-primary emitted mid-change would not clear the set it was changing.
//
// Now: `{ ids, kind }`, ids ordered with the PRIMARY first; one 'selection' bus event per change,
// carrying the new state, and none for a no-op. Nothing here knows whether an id exists — callers
// that need a live thing check `entities` first — so it is headless and has no three.
//
//   kind: 'things' (placed entities) | 'world' (the @world entity) | 'env:<key>' (the world with
//         one environment card in focus) | null when empty
//
// scenegraph.sceneSelected() and editpanels.selection() remain as thin adapters over this
// (client-check names them); they are the 'things' view of the store.
import { bus } from '../base.js';

let ids = [];
let kind = null;
let act = null;   // the ACTIVE id: the last one clicked (R, gym 10-17 20:39). null = the primary stands in

const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
const dedupe = (list) => { const out = []; for (const id of list ?? []) if (id != null && !out.includes(id)) out.push(id); return out; };

function commit(next, k, a = act) {
  const nk = next.length ? k : null;
  const na = a != null && a !== next[0] && next.includes(a) ? a : null;   // the primary as active is the default: stored as null, so it is no change
  if (nk === kind && same(next, ids) && na === act) return false;
  ids = next; kind = nk; act = na;
  bus.emit('selection', selection());
  return true;
}

/** The selection, as a copy: `{ ids, kind }`. */
export const selection = () => ({ ids: [...ids], kind });
/** The first id, or null. */
export const primary = () => ids[0] ?? null;
/** The ACTIVE id: the last one clicked (a Ctrl-click's add, a Shift range's far end), which the multi-selection Inspector
 *  names (Unity's active object, Blender's active). Not the primary: the gizmo and every single-thing tool keep the first.
 *  Always one of the ids; the primary when nothing clicked is still selected. */
export const active = () => (act != null && ids.includes(act) ? act : ids[0] ?? null);
export const isSelected = (id) => ids.includes(id);
export const isEmpty = () => ids.length === 0;

/** Replace the selection. An empty list clears. `a` names the active id (a Shift range: the row clicked); omitted, the
 *  primary is. */
export function set(list, k = 'things', a = null) { return commit(dedupe(Array.isArray(list) ? list : [list]), k, a); }
/** Add what is missing, after the current ids (a box select: never takes one off). On an empty
 *  selection the first becomes the primary. */
export function extend(list, k = 'things') {
  const add = dedupe(Array.isArray(list) ? list : [list]).filter((id) => !ids.includes(id));
  if (!add.length) return false;
  return commit(kind === k || kind === null ? [...ids, ...add] : add, k);
}
/** A Ctrl/Shift-click: add it if absent, take it out if present. Taking the primary out promotes
 *  the next id and keeps the rest — one event, which is the whole reason this module exists. */
export function toggle(id, k = 'things') {
  if (id == null) return false;
  if (kind !== null && kind !== k) return set([id], k);
  return ids.includes(id) ? commit(ids.filter((x) => x !== id), k) : commit([...ids, id], k, id);   // an add is the one clicked: active
}
export function clear() { return commit([], null, null); }
