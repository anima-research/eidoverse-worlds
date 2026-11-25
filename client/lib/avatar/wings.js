// wings — a winged rig's flap, fold and hand-back from the ragdoll; one per Avatar (avatar.js), run from its update().

import { THREE } from '../core.js';
import { BREATH } from '../../../shared/breath.js';

// Wings, when a rig has them: [LR]_Wing_(Upper|Lower)[_<n>], four chains off the clavicles, any length. The flap
// is procedural, not a clip: VRMA addresses only humanoid bones, and the wings must stop being driven the instant
// the body goes limp. The axis is the body's forward (bone roll out of Blender is arbitrary); the sides differ by
// sign. The dials, idle and power, are read by _flap; `wingEffort` in [0,1] crossfades them term by term.
export const WING_IDLE = {
  deg: 10,       // half-amplitude at the shoulder (an idle, not flight)
  hz: 1 / BREATH, // one beat per BREATH (shared/breath.js)
  bias: 0,       // degrees of permanent lift over the rig's rest pose, both sides
  tip: 0.9,      // the outer segment's share of the amplitude (less than the root gives the wing a curve)
  lag: 0.25,     // cycles the outer segment trails the inner by: membrane rather than board
  sync: true,    // upper and lower pairs share one phase (false beats them against each other: an insect)
  recover: 0.5,  // seconds to slerp back into the flap after a ragdoll
  sweep: 18,     // degrees fore/aft at the shoulder, about the body's up: opens the tip's arc into an ellipse
  sweepPhase: 0.25, // cycles the sweep leads the flap by (a quarter turn makes the ellipse; 0 is a tilted hinge)
};

// the power stroke, while the wings hold a body up: controller.js sets wingEffort from the flight state
export const WING_POWER = {
  deg: 8,        // small and fast: a blur of short strokes
  hz: 2.1,       // past ~3Hz the whole chain blurs into one shape
  bias: -8,      // the stroke sits low: a power flap drives down from above
  tip: 0.78,     // under load a wing straightens along its span instead of curling
  lag: 0.09,     // a loaded wing drives as more of one surface
  sync: true,
  recover: 0.55,
  sweep: 17,     // about the idle's (18), at a faster beat: the ellipse is what reads as moving air
  sweepPhase: 0.25,
};

// The folded-wing posture (test/client/flight-test.ts T6): a pose, not a clip, composed through _flap so folding
// inherits the ragdoll handover. Read out of the authored Blender action (wings-folded_1.asset.blend): quaternions
// local to each bone's rest, in three.js [x,y,z,w] order (Blender stores [w,x,y,z]).
const WING_FOLDED = {
  L_Wing_Lower: [-0.19528, +0.01928, +0.08113, +0.97720],
  L_Wing_Lower_1: [+0.00000, +0.00000, -0.14119, +0.98998],
  L_Wing_Lower_2: [+0.00000, -0.00000, -0.07015, +0.99754],
  L_Wing_Upper: [-0.61553, +0.10840, -0.23210, +0.74532],
  L_Wing_Upper_1: [+0.02722, +0.15488, -0.05078, +0.98625],
  L_Wing_Upper_2: [+0.07325, +0.01376, -0.08462, +0.99362],
  R_Wing_Lower: [-0.18819, -0.03912, -0.05598, +0.97976],
  R_Wing_Lower_1: [-0.00000, +0.00000, +0.15163, +0.98844],
  R_Wing_Lower_2: [-0.00000, +0.00000, +0.09890, +0.99510],
  R_Wing_Upper: [-0.57842, -0.13811, +0.24053, +0.76714],
  R_Wing_Upper_1: [+0.00000, -0.00000, +0.17326, +0.98488],
};

/** Blend two wing dial sets: numbers interpolate (`recover` included); non-numbers (`sync`) take the idle's value. */
const _wmix = {};
function mixWings(a, b, t) {
  for (const k of Object.keys(a)) {
    const av = a[k], bv = b[k];
    _wmix[k] = (typeof av === 'number' && typeof bv === 'number') ? av + (bv - av) * t : av;
  }
  return _wmix;
}
const _wq = new THREE.Quaternion();        // wing scratch
const _wpq = new THREE.Quaternion();
const _wacc = new THREE.Quaternion();
const _wfold = new THREE.Quaternion();
const _wtgt = new THREE.Quaternion();
const _wr = new THREE.Quaternion();
const _wax = new THREE.Vector3();
const _wup = new THREE.Vector3();
const _wsw = new THREE.Quaternion();
const DEG = Math.PI / 180;

/** One body's wings. `a` is the Avatar that owns them (a piece never imports its owner). */
export class Wings {
  constructor(a) { this.a = a; }

  /** Per frame, after vrm.update (avatar.js update says why); while limp the wings belong to the sim. */
  update(dt) {
    if (this._wings === undefined) this._findWings();
    if (this._wings && !this.a._limp) this._flap(dt);
  }

  /** Getting up (setLimp): the flap captures where the sim left each wing and blends out of it. */
  stoodUp() {
    if (this._wings === undefined) this._findWings();
    if (this._wings) {
      for (const w of this._wings) w.from = w.node.quaternion.clone();
      this._wingBlend = 0;
    }
  }

  /** Find the wing bones once and remember their authored pose (every frame of _flap rebuilds from it, and the
   *  ragdoll reads it as its equilibrium). Wings are springbones, so three-vrm may have posed them already: prefer
   *  each spring joint's _initialLocalRotation, the live pose only for a bone no springbone claims. */
  _findWings() {
    this._wings = null;
    if (!this.a.vrm?.scene) return;
    const springRest = new Map();
    for (const j of this.a.vrm.springBoneManager?.joints ?? []) {
      if (j?.bone && j._initialLocalRotation) springRest.set(j.bone, j._initialLocalRotation);
    }
    const found = [];
    this.a.vrm.scene.traverse((o) => {
      const m = /^([LR])_Wing_(Upper|Lower)(?:_(\d+))?$/.exec(o.name ?? '');
      if (!m) return;
      found.push({
        node: o,
        rest: (springRest.get(o) ?? o.quaternion).clone(),
        side: m[1] === 'L' ? 1 : -1,
        lower: m[2] === 'Lower',
        depth: m[3] ? Number(m[3]) : 0,
      });
    });
    if (!found.length) return;
    found.sort((a, b) => a.depth - b.depth);   // roots before tips: a tip composes on its root's new orientation
    this._wings = found;
    this.a.__wingRest = new Map(found.map((w) => [w.node, w.rest]));
  }

  /** One frame of the flap. Every wing is rebuilt from its captured rest, so this cannot integrate. The rotation is
   *  about a world axis (the body's forward) carried into the bone's parent frame: local = P⁻¹ · R · P · rest. */
  _flap(dt) {
    // effort (controller.js) eased here, asymmetric: on fast, off slowly (the climb trails into the glide)
    const want = THREE.MathUtils.clamp(this.a.wingEffort ?? 0, 0, 1);
    const have = this._wingEffort ?? 0;
    const tau = want > have ? 0.18 : 0.55;
    this._wingEffort = have + (want - have) * (1 - Math.exp(-dt / tau));
    const e = this._wingEffort;

    // folding, eased over about half a second
    const fWant = this.a.wingsFolded ? 1 : 0;
    const fHave = this._wingFold ?? 0;
    this._wingFold = fHave + (fWant - fHave) * (1 - Math.exp(-dt / 0.45));
    const fold = this._wingFold;
    // the flap runs underneath and the fold blends over the top, so a body that folds mid-idle settles
    const folding = fold > 0.001;
    const W = e < 0.001 ? WING_IDLE : mixWings(WING_IDLE, WING_POWER, e);
    this._wingBlend = Math.min(1, (this._wingBlend ?? 1) + dt / Math.max(0.01, W.recover));
    this._wingT = (this._wingT ?? 0) + dt * Math.max(0, W.hz);
    this._wingT -= Math.floor(this._wingT);      // stays in [0,1) forever
    // the body's forward, from the normalized rig (those bones rest facing +Z; raw bones carry arbitrary roll)
    const h = this.a.vrm.humanoid;
    const ref = this._wingRef ?? (this._wingRef =
      h?.getNormalizedBoneNode?.('upperChest') ?? h?.getNormalizedBoneNode?.('chest')
      ?? h?.getNormalizedBoneNode?.('spine') ?? this.a.root);
    ref.getWorldQuaternion(_wq);
    _wax.set(0, 0, 1).applyQuaternion(_wq).normalize();   // forward: the flap
    _wup.set(0, 1, 0).applyQuaternion(_wq).normalize();   // up: the sweep
    for (const w of this._wings) {
      const ph = this._wingT - W.lag * w.depth - (W.sync || !w.lower ? 0 : 0.5);
      // each segment out carries `tip` of the one before it, as its own rotation on top of the root's
      const amp = W.deg * Math.pow(W.tip, w.depth);
      const ang = (amp * Math.sin(ph * Math.PI * 2) + W.bias) * DEG * w.side;
      _wr.setFromAxisAngle(_wax, ang);
      // the fore/aft sweep about up, mirrored the other way (both wings sweep forward together)
      const sw = W.sweep * Math.pow(W.tip, w.depth)
        * Math.sin((ph + W.sweepPhase) * Math.PI * 2) * DEG * -w.side;
      if (sw) _wr.premultiply(_wsw.setFromAxisAngle(_wup, sw));
      w.node.parent.getWorldQuaternion(_wpq);
      _wacc.copy(_wpq).invert().multiply(_wr).multiply(_wpq).multiply(w.rest);
      // ...then toward the fold; WING_FOLDED is local to rest, so the target is rest * folded
      if (folding) {
        const q = WING_FOLDED[w.node.name];
        if (q) {
          _wfold.set(q[0], q[1], q[2], q[3]);
          _wtgt.copy(w.rest).multiply(_wfold);
          _wacc.slerp(_wtgt, fold);
        }
      }
      if (this._wingBlend < 1 && w.from) {
        w.node.quaternion.copy(w.from).slerp(_wacc, this._wingBlend);   // standing up: out of the ragdoll's pose, not a teleport
      } else {
        w.node.quaternion.copy(_wacc);
      }
      w.node.updateMatrix();   // a springbone has matrixAutoUpdate false
    }
  }
}
