// myview — what YOU have hidden in your own view (the Hierarchy's 👁; R 10-04: "Hidden" is the local one). Never logged,
// never sent, never seen by anyone else: a view filter, like Unity's scene-visibility eye (research 51: the eye means four
// things in four engines; ours means exactly one). Kept per world in this browser.
import { bus, CONFIG } from './base.js';

const key = () => `ew-myhidden-${CONFIG.world ?? ''}`;
let set = new Set();
try { set = new Set(JSON.parse(localStorage.getItem(key()) ?? '[]')); } catch { /* none */ }
const save = () => { try { localStorage.setItem(key(), JSON.stringify([...set])); } catch { /* fine */ } };

export const isMineHidden = (id) => set.has(id);
export const myHiddenCount = () => set.size;
/** The id carrying the hide when a hit object is out of MY view (the eye on it or on anything it hangs under; with
 *  `eyeOnly` false, also isolated out), else null. What isn't drawn for me isn't clicked by me (R 10-12 17:33). */
export function outOfMyView(o, { eyeOnly = false } = {}) {
  for (let n = o, k = 0; n && k < 64; n = n.parent, k++) { const id = n.userData?.entityId; if (id != null && (set.has(id) || (!eyeOnly && isolatedOut(id)))) return id; }
  return null;
}
export function toggleMineHidden(id) { if (set.has(id)) set.delete(id); else set.add(id); save(); bus.emit('myview', { id, hidden: set.has(id) }); return set.has(id); }
export function showAllMine() { const ids = [...set]; set.clear(); save(); for (const id of ids) bus.emit('myview', { id, hidden: false }); return ids.length; }

// ISOLATE (R, 10-10: "we also need an 'isolate selected' checkbox somewhere"): see only these things, in MY view, until
// it is turned off. Never saved, never logged. A thing is kept with what it rides (its ancestors: a hidden parent hides
// its children) and what rides it (its descendants); realize/models.js reads isolatedOut beside isMineHidden.
let keep = null;   // null = off; else the Set of ids still shown
export const isolating = () => keep !== null;
export const isolatedOut = (id) => keep !== null && !keep.has(id);
/** ids: the things to isolate (null or empty turns it off). parentOf(id) → its parent's id or null; all: every entity id. */
export function setIsolate(ids, parentOf = () => null, all = []) {
  const was = keep;
  if (!ids?.length) keep = null;
  else {
    keep = new Set();
    for (const id of ids) for (let p = id, n = 0; p && n < 64; p = parentOf(p), n++) keep.add(p);                       // it and what it rides
    for (const id of all) for (let p = parentOf(id), n = 0; p && n < 64; p = parentOf(p), n++) if (ids.includes(p)) { keep.add(id); break; }   // what rides it
  }
  for (const id of new Set([...all, ...(was ?? []), ...(keep ?? [])])) bus.emit('myview', { id, hidden: isolatedOut(id) });
  return keep ? keep.size : 0;
}
