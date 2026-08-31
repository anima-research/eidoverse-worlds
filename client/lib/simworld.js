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

import { THREE } from './core.js';
import { state } from './state.js';
import { advanceSim, tickOf } from '../../shared/sim.js';
import { entities } from './world.js';
import { pushHostHook } from './autohooks.js';
import { reindexCollider } from './colliders.js';

const restIndexed = new Set();

// ---- presentation-only tumble -----------------------------------------------
// The sim owns POSITION and yaw; it deliberately carries no angular state
// (a spin covenant would be sim@0.2). But a body arcing with frozen
// rotation reads as dead (tel0s, playtest 2026-08-31) — so the applier adds
// a COSMETIC tumble, derived each frame from nothing but the sim's own
// p/v/resting: airborne bodies tumble about the axis perpendicular to
// travel (the physobj box law, 2.2 rad/s), grounded ones right themselves
// to the sim's word (upright at b.yaw). Local dressing, like hair: never
// streamed, never folded, and the parity checks read position, which this
// never touches.
const spins = new Map();   // id -> THREE.Quaternion (presentation state)
const _axis = new THREE.Vector3();
const _dq = new THREE.Quaternion();
const _upq = new THREE.Quaternion();
const UP = new THREE.Vector3(0, 1, 0);
const TUMBLE = 2.2;        // rad/s while airborne — a hop reads as a tumble

/** Console/probe surface (EW.simFold): the shadow sim's cut. `bodies`
 *  after rest is the determinism proof's client leg — bit-comparable
 *  against the sequencer's and any independent recompute. */
export const simState = () => state.sim;

/** Wire the applier. Called once from main.js, beside the realizers. */
let lastAt = 0;
export function initSimWorld() {
  pushHostHook(() => {
    const sim = state.sim;
    if (!sim?.epoch || sim.epoch.foreign) return;
    advanceSim(sim, tickOf(sim, Date.now()));
    const now = performance.now();
    const dt = Math.min(0.1, (now - (lastAt || now)) / 1000);
    lastAt = now;
    for (const id in sim.bodies) {
      const b = sim.bodies[id];
      const obj = entities.get(id);
      if (!obj) continue;
      obj.position.set(b.p[0], b.p[1], b.p[2]);
      // cosmetic tumble/settle (see the header block above)
      let q = spins.get(id);
      if (!q) { q = obj.quaternion.clone(); spins.set(id, q); }
      const flat = Math.hypot(b.v[0], b.v[2]);
      // Airborne = the sim's OWN word (v[1] ≠ 0), never a height threshold:
      // tick-quantized positions hover under any threshold late in a fall
      // and through the tiny bounce tail, so a threshold righted the barrel
      // in mid-air (tel0s, playtest 2026-08-31 — "return to normal
      // orientation before they hit the ground"). The sim zeroes v[1]
      // exactly when grounded contact begins, which is exactly when a
      // tumbling thing should start righting itself.
      if (!b.resting && b.v[1] !== 0 && flat > 0.05) {
        _axis.set(b.v[2], 0, -b.v[0]).normalize();
        _dq.setFromAxisAngle(_axis, TUMBLE * dt);
        q.premultiply(_dq);
      } else {
        _upq.setFromAxisAngle(UP, b.yaw);
        q.slerp(_upq, Math.min(1, 6 * dt));
      }
      obj.quaternion.copy(q);
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
    // released bodies drop their presentation state — the realizers
    // re-assert the authored transform the moment the fold owns them again
    for (const id of spins.keys()) if (!(id in sim.bodies)) spins.delete(id);
  });
}
