// arrivalhold — a body that wakes up somewhere keeps its height until what it
// stands on exists here.
//
// A restore (a reload, a rejoin) puts the body back where it was — upstairs,
// on a landing — at once, but the building under it arrives seconds later:
// its model has to download and be fitted before it is solid. Until then the
// controller saw only terrain and dropped the body through every floor to the
// ground. (The agent side holds the same way: mcpl/agent.ts, the join hold.)
//
// So after a restore, the body's height is held while any placed model whose
// footprint's circle comes within NEAR (16m) of it, or whose size isn't known
// yet, is still on its way, up to a safety bound of 120s: a slow connection
// or a busy machine can take well over 20s to bring a building in, and a hold
// that gave up first dropped the body anyway. Which models are still on their
// way, and which are near, is arrivalnear.js's: a model whose load FAILED is
// not waited on while it backs off, and the bound means nothing can hold a
// body for ever.

import { state } from './state.js';
import { modelArriving, modelFootprint } from './realize/models.js';
import { arrivingNear } from './arrivalnear.js';

let until = 0, armed = 0, heldFor = 0;

/** Hold the body's height for up to `ms`, while things near it arrive. The
 *  clock starts at the first frame the body is actually stepped — a page can
 *  take a long while to load the avatar after the restore lands, and a hold
 *  that had run out by then held nothing. */
export function holdHeightUntilSolid(ms = 120_000) { armed = ms; until = 0; }

/** Is a solid placed model near (x, z) still on its way? */
export function solidArriving(x, z, entities = state.st?.entities ?? {}) {
  return arrivingNear(x, z, entities, modelArriving, modelFootprint, true).length > 0;
}

/** Should the controller leave the body's height alone this frame? */
export function heightHeld(pos) {
  if (armed) { until = performance.now() + armed; heldFor = armed; armed = 0; }
  if (!until) return false;
  if (performance.now() > until) {
    until = 0;
    // gave up: said once, with what was still coming, so a fall after this can
    // be told from an ordinary one
    const still = state.hydrated ? arrivingNear(pos.x, pos.z, state.st?.entities ?? {}, modelArriving, modelFootprint) : [];
    console.warn(`[arrivalhold] gave up holding a restored body's height after ${Math.round(heldFor / 1000)}s at`
      + ` (${pos.x.toFixed(1)}, ${pos.y.toFixed(2)}, ${pos.z.toFixed(1)}): ${state.hydrated
        ? `still on its way near it: ${still.join(', ') || 'none now'}` : 'the world never hydrated'}`);
    return false;
  }
  // the restore arrives before the world's state is folded (net.js onSnapshot
  // restores, then hydrates, with awaits between): until then nothing is
  // known to be arriving — hold anyway
  if (!state.hydrated) return true;
  if (!solidArriving(pos.x, pos.z)) { until = 0; return false; }
  return true;
}
