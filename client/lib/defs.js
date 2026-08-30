// defs — the client's view of the instance def registry (charter §3).
// One fetch of GET /defs, shared by every client-side consumer (the sky
// panel's preset row; whoever comes next), invalidated when the sequencer
// pushes `defs-updated` so a def edited on disk reaches the next reader.
//
// The flora engine (vegetation.js, served off /library) keeps its OWN
// fetch of the same route — it is a standalone engine file that cannot
// import client lib modules. Two fetch sites, one per layer, both cheap
// and both invalidated by the same push (world.js handles the engine's
// refresh + regrow).
import { bus } from './base.js';

let reg = null;
bus.on('defs-updated', () => { reg = null; });

/** The parsed /defs registry — {flora, floraColors, floraPresets, avatars,
 *  animations, skyPresets, …}. Rejections clear the memo so the next
 *  caller retries. */
export function defsRegistry() {
  reg ??= fetch('/defs', { cache: 'no-store' })
    .then((r) => { if (!r.ok) throw new Error(`GET /defs -> ${r.status}`); return r.json(); })
    .catch((e) => { reg = null; throw e; });
  return reg;
}
