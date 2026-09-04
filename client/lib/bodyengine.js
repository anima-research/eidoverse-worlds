// bodyengine — the shared spine of every body-physics engine.
//
// THE ENGINE CONTRACT (inherited from the retired rapierdoll, via ammodoll's
// header, now stated where both engines can stand on it):
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
// Everything downstream (goLimp, drag, nails, the presence stream) goes
// through bodysim.makeRagdoll and cannot tell which engine answered — so the
// parts of the lifecycle that MUST agree live here, and only those. The
// engines stay different machines: this class owns clocks and bookkeeping,
// never solving.
//
// What each engine must supply: _topple(lean) (how a velocity lands on its
// bodies), and its own settle THRESHOLDS — the clock law is shared, the
// numbers are tuned per engine and stay there.

import { THREE } from './core.js';

const _iv = new THREE.Vector3();

/** Wire-borne shoves are capped at the trust boundary (main.js), and once more
 *  here: the sim protects its own stability rather than assuming every caller
 *  was polite. m/s. */
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

  /** True while any pin holds this body. Engines create `pins` when the first
   *  pin lands (the verlet, lazily) or at build (the bullet rig) — both read
   *  the same here. */
  get pinned() { return (this.pins?.size ?? 0) > 0; }

  /** Shove a body whose sim is still running — a second push landing on
   *  someone already going down, or a blast reaching a body mid-tumble.
   *  Same application as the constructor's lean (the engine's _topple).
   *  The body is moving again: settle starts over, and so does the deadline —
   *  a shove at 7.9s of an 8s window must not capture a body still in the
   *  air. Restarting elapsed grants the new motion the same full window the
   *  original fall had.
   *  @param v THREE.Vector3, m/s. */
  impulse(v) {
    if (this.done) return;
    _iv.copy(v);
    if (_iv.lengthSq() > IMPULSE_CAP * IMPULSE_CAP) _iv.setLength(IMPULSE_CAP);
    this._topple(_iv);
    this.settledFor = 0;
    this.elapsed = 0;
  }

  /** The settle CLOCK law, one copy: a held body neither settles nor
   *  deadlines (a pin is ongoing input, and capturing would freeze a hung
   *  body's constraint enforcement); quiet time accumulates in SECONDS;
   *  `cancel` clears the clock — the verlet passes a hysteresis band here
   *  (it takes real motion to restart the countdown, not a flicker), the
   *  bullet rig cancels on any noise. Thresholds stay engine-owned: the
   *  caller compares settledFor / elapsed against its own tuned numbers. */
  _settleTick(dt, quiet, cancel = !quiet) {
    this.elapsed += dt;
    if (this.pinned) { this.settledFor = 0; this.elapsed = 0; return; }
    if (quiet) this.settledFor += dt;
    else if (cancel) this.settledFor = 0;
  }

  /** Root follows the hips so the body lies where it fell.
   *
   *  FALLING, the root only ever descends: Math.min against where it started
   *  guards against a solve-overshoot frame popping the whole mesh above the
   *  ground. But a PINNED body is being CARRIED — the hand may lift it, so
   *  the root must follow the hips upward too, or the sim rises while the
   *  rendered body stays floor-bound (the pose curls into a dangle a few
   *  centimetres up and stops — exactly what that looked like). Once lifted,
   *  the ceiling moves up with the body: releasing from a height starts the
   *  NEXT sim's rootStartY there, and the fall brings it back down. */
  /** Where the hips sit relative to the root, horizontally, in the ROOT's own
   *  frame — measured from the rest pose once at build. Most rigs author the
   *  pelvis above the origin and this is ~0; tel0s authors its whole skeleton
   *  0.233m forward of it, and a root-follow that assumed zero drew that body
   *  23cm from where its particles were — and, worse, fed the drive a hips
   *  bone position 23cm off the hips particle (§24t-8). */
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
    if (this.pinned && y > this.rootStartY) this.rootStartY = y;
    root.y = Math.min(this.rootStartY, y);
  }
}
