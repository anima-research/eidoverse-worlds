// arrivalhold — a body that wakes up somewhere keeps its height until what it
// stands on exists here.
//
// A restore (a reload, a rejoin) puts the body back where it was — upstairs,
// on a landing — at once, but the building under it arrives seconds later:
// its model has to download and be fitted before it is solid. Until then the
// controller saw only terrain and dropped the body through every floor to the
// ground. (The agent side holds the same way: mcpl/agent.ts, the join hold.)
//
// So after a restore, the body's height is held while any placed model near
// it is still on its way — however long that takes: a slow connection or a
// busy machine can take well over 20s to bring a building in, and a hold that
// gave up first dropped the body anyway. A model whose load FAILED is not
// waited on, and a long safety bound means nothing can hold a body for ever.

import { state } from './state.js';
import { colliders } from './colliders.js';
import { modelLoadFailed } from './realize/models.js';

/** How near a placed thing has to be to matter (m, across the ground). */
const NEAR = 16;
let until = 0, armed = 0;

/** Hold the body's height for up to `ms`, while things near it arrive. The
 *  clock starts at the first frame the body is actually stepped — a page can
 *  take a long while to load the avatar after the restore lands, and a hold
 *  that had run out by then held nothing. */
export function holdHeightUntilSolid(ms = 120_000) { armed = ms; until = 0; }

/** Is a solid placed thing near (x, z) still on its way — known to the world,
 *  not yet fitted, its load not failed? Lights and `collide: "none"` never
 *  will be solid. */
export function solidArriving(x, z, entities = state.st?.entities ?? {}, fitted = colliders, failed = modelLoadFailed) {
  for (const [id, e] of Object.entries(entities)) {
    if (!e || !e.lib || e.lib === '(light)' || e.collide === 'none' || failed(id)) continue;
    const p = e.pos;
    if (!Array.isArray(p) || Math.hypot(p[0] - x, p[2] - z) > NEAR + 8 * (e.scale || 1)) continue;
    if (!fitted.has(id)) return true;
  }
  return false;
}

/** Should the controller leave the body's height alone this frame? */
export function heightHeld(pos) {
  if (armed) { until = performance.now() + armed; armed = 0; }
  if (!until) return false;
  if (performance.now() > until) { until = 0; return false; }
  // the restore arrives before the world's state is folded (net.js onSnapshot
  // restores, then hydrates, with awaits between): until then nothing is
  // known to be arriving — hold anyway
  if (!state.hydrated) return true;
  if (!solidArriving(pos.x, pos.z)) { until = 0; return false; }
  return true;
}
