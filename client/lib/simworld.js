// simworld — the client half of the deterministic sim (PROTOCOL_v2,
// dialect 3). state.js folds the intents; this module ADVANCES the sim to
// the tick "now" quantizes to and applies body poses onto the realized
// entities, every frame, through the engine's own hook array.
//
// Nothing here is authoritative and nothing here is sent anywhere: the sim
// state is a pure function of the log (plus the adopted join cut), the
// sequencer computes the identical states independently, and this module
// only makes them VISIBLE. Clock skew between this machine and the
// sequencer shifts the flight's phase by the skew and nothing else — the
// rest pose is recomputation, not observation, and cannot drift.
//
// v0.1 presentation is tick-stepped (the epoch's tickMs, 15Hz at 66):
// matching the pose stream's cadence. Interpolation between ticks is
// presentation polish the spec sanctions; it can come later without
// touching a single number the sim owns.

import { state } from './state.js';
import { advanceSim, tickOf } from '../../shared/sim.js';
import { entities } from './world.js';
import { pushHostHook } from './autohooks.js';
import { reindexCollider } from './colliders.js';

const restIndexed = new Set();

/** Console/probe surface (EW.simFold): the shadow sim's cut. `bodies`
 *  after rest is the determinism proof's client leg — bit-comparable
 *  against the sequencer's and any independent recompute. */
export const simState = () => state.sim;

/** Wire the applier. Called once from main.js, beside the realizers. */
export function initSimWorld() {
  pushHostHook(() => {
    const sim = state.sim;
    if (!sim?.epoch || sim.epoch.foreign) return;
    advanceSim(sim, tickOf(sim, Date.now()));
    for (const id in sim.bodies) {
      const b = sim.bodies[id];
      const obj = entities.get(id);
      if (!obj) continue;
      obj.position.set(b.p[0], b.p[1], b.p[2]);
      if (obj.userData.base?.pos) {
        // the realizer's rest-pose record follows the sim's word, so
        // re-seat logic and inspectors read where the thing IS
        obj.userData.base.pos[0] = b.p[0];
        obj.userData.base.pos[1] = b.p[1];
        obj.userData.base.pos[2] = b.p[2];
      }
      if (b.resting && !restIndexed.has(id)) {
        restIndexed.add(id);
        try { reindexCollider(id); } catch { /* colliders may not know it */ }
      } else if (!b.resting) {
        restIndexed.delete(id);
      }
    }
  });
}
