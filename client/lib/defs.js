// defs — the client's view of the instance def registry: one fetch of GET /defs shared by every client-side consumer,
// invalidated when the sequencer pushes `defs-updated`.
// The flora engine (client/lib/vegetation/vegetation.js ensureFloraDefs) keeps its OWN fetch of the route: it imports
// only its own files and shared/, never a client lib module. world.js handles its refresh on the same push.
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
