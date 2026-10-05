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
export function toggleMineHidden(id) { if (set.has(id)) set.delete(id); else set.add(id); save(); bus.emit('myview', { id, hidden: set.has(id) }); return set.has(id); }
export function showAllMine() { const ids = [...set]; set.clear(); save(); for (const id of ids) bus.emit('myview', { id, hidden: false }); return ids.length; }
