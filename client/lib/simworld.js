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
// Presentation INTERPOLATES between ticks (PROTOCOL_v2 §5: "clients
// interpolate presentation between ticks exactly as they interpolate
// presence"). The sim's tick-T state is where a body stands at wall time
// epoch.ts + T·tickMs, and tickOf rounds UP — so the sim's current state is
// the END of the interval "now" falls in, and the state one tick earlier is
// its START. Each frame the applier remembers every body's position at the
// tick before advancing across a boundary, then shows the lerp of the two at
// the fractional phase of now within the tick: exact sim time, zero added
// latency, no extrapolation (nothing ever overshoots a bounce or the ground).
// At 15Hz ticks on a 60Hz+ display the tick-stepped v0.1 painted each
// position four frames running (tel0s, playtest 2026-09-01: "I can sort of
// see the individual physics updates in the form of juddering"). Not one
// number the sim owns is touched: the displayed lerp never feeds back, and
// the parity legs read state.sim, never obj.position.

import { THREE } from './core.js';
import { state } from './state.js';
import { advanceSim, tickOf } from '../../shared/sim.js';
import { entities } from './world.js';
import { pushHostHook } from './autohooks.js';
import { reindexCollider, colliders } from './colliders.js';
import { heightAt } from './terrain.js';

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

// ---- between-tick interpolation (presentation) -------------------------------
// prev: id -> position at the tick BEFORE the sim's current one — the start
// of the interval the display is inside. Captured only when THIS applier
// steps the sim across a boundary; if anything else moved the sim since
// (a folded intent whose ts ran ahead of this clock, a new epoch), the
// remembered starts are stale and are dropped — those bodies show the sim's
// word outright until the next boundary, which is exactly v0.1's behaviour
// and exactly the skew doctrine in the header (phase shifts, nothing else).
const prev = new Map();    // id -> [x, y, z]
let tickSeen = -1;         // the tick the applier itself last left the sim at

/** Wire the applier. Called once from main.js, beside the realizers. */
let lastAt = 0;
export function initSimWorld() {
  pushHostHook(() => {
    const sim = state.sim;
    if (!sim?.epoch || sim.epoch.foreign) return;
    const wall = Date.now();
    const target = tickOf(sim, wall);
    if (sim.tick !== tickSeen) prev.clear();
    if (sim.tick < target) {
      // crossing a boundary this frame: stand at the tick before, remember
      // every body there, then step to the interval's end
      if (sim.tick < target - 1) advanceSim(sim, target - 1);
      for (const id in sim.bodies) {
        const b = sim.bodies[id];
        let pv = prev.get(id);
        if (!pv) { pv = [0, 0, 0]; prev.set(id, pv); }
        pv[0] = b.p[0]; pv[1] = b.p[1]; pv[2] = b.p[2];
      }
      advanceSim(sim, target);
    }
    tickSeen = sim.tick;
    // the phase of now inside the sim's current tick, (0, 1]: 1 is the
    // boundary itself, i.e. the sim's word verbatim
    const k = Math.min(1, Math.max(0, (wall - sim.epoch.ts) / sim.epoch.tickMs - (sim.tick - 1)));
    const now = performance.now();
    const dt = Math.min(0.1, (now - (lastAt || now)) / 1000);
    lastAt = now;
    for (const id in sim.bodies) {
      const b = sim.bodies[id];
      const obj = entities.get(id);
      if (!obj) continue;
      let sp = spins.get(id);
      if (!sp) {
        sp = { q: obj.quaternion.clone(), arm: Infinity, cx: 0, cz: 0, box: null };
        spins.set(id, sp);
      }
      // ARM: how far the mesh's visual center sits from the entity origin
      // (local, horizontal). Rotating a quaternion rotates about the ORIGIN,
      // so a far-offset model (the barrels group ships its cluster 1.95m off
      // origin, §24t-4) would sweep its mesh in a metres-wide arc — those
      // models arc without tumbling instead. Fitted from the collider box
      // WHENEVER THE BOX CHANGES, never cached at first sight: a body that is
      // already resting in the join snapshot is seen by this applier on the
      // first frame after hydrate, frames before its model has loaded and
      // its box exists — and a geometry cached then said "origin-centred",
      // so the barrels tumbled on a 1.3m arm straight through the ground on
      // every punt after a reload (tel0s, playtest 2026-09-01, §24t-7).
      // Unknown geometry (no box yet) = no tumble, no grounding lift.
      const cb = colliders.get(id)?.box ?? null;
      if (cb !== sp.box) {
        sp.box = cb;
        const scl = obj.scale ?? { x: 1, z: 1 };
        sp.cx = cb ? (cb.min.x + cb.max.x) / 2 * (scl.x || 1) : 0;
        sp.cz = cb ? (cb.min.z + cb.max.z) / 2 * (scl.z || 1) : 0;
        sp.arm = cb ? Math.hypot(sp.cx, sp.cz) : Infinity;
      }
      // a resting body stands on the sim's word exactly (the collider index
      // below reads it); a moving one shows the lerp of its two tick poses
      const pv = b.resting ? undefined : prev.get(id);
      if (pv) {
        obj.position.set(pv[0] + (b.p[0] - pv[0]) * k, pv[1] + (b.p[1] - pv[1]) * k,
          pv[2] + (b.p[2] - pv[2]) * k);
      } else {
        obj.position.set(b.p[0], b.p[1], b.p[2]);
      }
      // VISUAL GROUNDING. The sim grounds the entity ORIGIN on the terrain —
      // all it can know: the mesh is an asset fact, never in the log. A
      // far-offset model stands somewhere else, and on a slope the ground
      // there is not the ground here: the barrels' cluster sank 29cm into a
      // hillside at every landing (tel0s, playtest 2026-09-01, §24t-6).
      // Show the visual center standing on ITS ground — lift by the terrain
      // difference between the two footprints. Presentation only, like the
      // tumble: ~0 for an origin-centred model, exactly 0 without terrain.
      // (a body the sim has standing ON another thing — eidosim@0.3.0's
      // `on` — takes that thing's top as its ground, not the terrain's)
      if (sp.arm > 0.05 && sp.box && !b.on) {
        const c = Math.cos(b.yaw), s = Math.sin(b.yaw);
        const wx = sp.cx * c + sp.cz * s, wz = -sp.cx * s + sp.cz * c;
        const p = obj.position;
        p.y += heightAt(p.x + wx, p.z + wz) - heightAt(p.x, p.z);
      }
      // cosmetic tumble/settle (see the header block above)
      const q = sp.q;
      const flat = Math.hypot(b.v[0], b.v[2]);
      // Airborne = the sim's OWN word (v[1] ≠ 0), never a height threshold:
      // tick-quantized positions hover under any threshold late in a fall
      // and through the tiny bounce tail, so a threshold righted the barrel
      // in mid-air (tel0s, playtest 2026-08-31 — "return to normal
      // orientation before they hit the ground"). The sim zeroes v[1]
      // exactly when grounded contact begins, which is exactly when a
      // tumbling thing should start righting itself.
      if (!b.resting && b.v[1] !== 0 && flat > 0.05 && sp.arm < 0.5) {
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
    for (const id of prev.keys()) if (!(id in sim.bodies)) prev.delete(id);
  });
}
