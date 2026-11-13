// bodyengine — the shared spine of every body-physics engine.
//
// THE ENGINE CONTRACT:
//
//   constructor(avatar, lean, rest, seedVel)
//   step(dt)            → sparse local-quat pose (drives the avatar directly),
//                         or null once captured
//   impulse(v)          — a shove landing mid-tumble (wire path: puppet {lean}
//                         and the force verb)
//   setPin(joint, target, firm) / setPin(joint, null) / setPin(null)
//   snapshot()          → {j,p,v} handover (rigmeasure.js owns the format)
//   .pins .pinned .done .finalPose .p .maxV
//   dispose()           — engines with off-heap state free it here
//
// Everything downstream goes through bodysim.makeRagdoll and cannot tell which engine answered. This class owns
// the clocks and bookkeeping that MUST agree, never solving. Each engine supplies _topple(lean) (how a velocity
// lands on its bodies) and its own settle THRESHOLDS — the clock law is shared, the numbers are per engine.

import { THREE } from '../core.js';

const _iv = new THREE.Vector3();

/** Wire-borne shoves are capped at the trust boundary (main.js) and again here, for the sim's own stability. m/s. */
const IMPULSE_CAP = 8;

export class BodyEngineBase {
  constructor(avatar) {
    this.avatar = avatar;
    this.done = false;
    this.pose = null;
    this.finalPose = null;
    this.settledFor = 0;
    this.elapsed = 0;
    this.maxV = Infinity;
    this.p = {};                 // joint -> world pos (debug + parity surface)
  }

/** True while any pin holds this body (engines create `pins` lazily or at build). */
  get pinned() { return (this.pins?.size ?? 0) > 0; }

/** Shove a body whose sim is still running, via the engine's _topple. Restarts both the settle clock and the
 *  deadline, so a late shove gets the full window and can't be captured mid-air.
 *  @param v THREE.Vector3, m/s. */
  impulse(v) {
    if (this.done) return;
    _iv.copy(v);
    if (_iv.lengthSq() > IMPULSE_CAP * IMPULSE_CAP) _iv.setLength(IMPULSE_CAP);
    this._topple(_iv);
    this.settledFor = 0;
    this.elapsed = 0;
  }

/** The settle CLOCK law, one copy: a pinned body neither settles nor deadlines (capturing would freeze a hung body's
 *  constraints); quiet time accumulates in seconds; `cancel` clears it (the verlet passes a hysteresis band, the
 *  bullet rig cancels on any noise). Callers compare settledFor / elapsed against their own thresholds. */
  _settleTick(dt, quiet, cancel = !quiet) {
    this.elapsed += dt;
    if (this.pinned) { this.settledFor = 0; this.elapsed = 0; return; }
    if (quiet) this.settledFor += dt;
    else if (cancel) this.settledFor = 0;
  }

/** Hips offset from the root, horizontally in the root's own frame, measured from the rest pose at build. ~0 on most
 *  rigs, but some author the skeleton well forward of the origin (0.233 m on one). */
  _measureHipsLocal(restHipsWorld) {
    const root = this.avatar.root;
    if (!restHipsWorld || !root) { this.hipsLocalX = 0; this.hipsLocalZ = 0; return; }
    const dx = restHipsWorld.x - root.position.x, dz = restHipsWorld.z - root.position.z;
    const yaw = root.rotation?.y ?? 0;
    const c = Math.cos(yaw), s = Math.sin(yaw);
    // world → root-local (inverse yaw)
    this.hipsLocalX = dx * c - dz * s;
    this.hipsLocalZ = dx * s + dz * c;
  }

/** Root follows the hips so the body lies where it fell. Falling, it only descends (guards a solve-overshoot pop);
 *  a pinned (carried) or floating body may be lifted, so the ceiling moves up with it. */
  _followRoot() {
    const hips = this.p.hips;
    if (!hips) return;
    const root = this.avatar.root.position;
    const yaw = this.avatar.root.rotation?.y ?? 0;
    const lx = this.hipsLocalX ?? 0, lz = this.hipsLocalZ ?? 0;
    const c = Math.cos(yaw), s = Math.sin(yaw);
    // root-local → world (yaw), then the root goes where the hips minus that is
    root.x = hips.x - (lx * c + lz * s);
    root.z = hips.z - (-lx * s + lz * c);
    const y = hips.y - this.hipsOffset;
    // a carried body may be lifted, and a FLOATING one rides up a wave: the root follows it up too
    if ((this.pinned || this.floating) && y > this.rootStartY) this.rootStartY = y;
    root.y = Math.min(this.rootStartY, y);
  }
}
