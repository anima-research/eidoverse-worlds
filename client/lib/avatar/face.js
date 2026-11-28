// face — what makes a body read as present: gaze, blink, eyeballs, eyelids, mouth; one per Avatar (avatar.js).

import { THREE } from '../core.js';

// Blink and eye dials, for a rig whose lids are bones and exports no limit of its own (_findLids).
export const BLINK = {
  closed: 1.2,   // radians an upper lid swings to shut, signed (depends on the lid bone's roll); tuned by eye
  hz: 1,         // blink-rate multiplier
  axis: 0,       // which axis a lid swings about (0=x 1=y 2=z): bone roll out of Blender is arbitrary
  lower: -0.35,  // the lower lid's share, usually opposite (an upper lid alone leaves the sclera showing)
  eyeMax: 0.42,  // radians an eyeball may turn off the head's forward; eyes that track hard read as staring
  dur: 0.28,     // seconds for a full close-and-open
};
const _v = new THREE.Vector3();
const _gq = new THREE.Quaternion();        // gaze scratch — hot path, no allocs
const _gd = new THREE.Quaternion();
const _gi = new THREE.Quaternion();
const _gpq = new THREE.Quaternion();
const _gf = new THREE.Vector3();
const _gw = new THREE.Vector3();
const _gp = new THREE.Vector3();
const _pq = new THREE.Quaternion();          // lid scratch, and the lid axes
const _X = new THREE.Vector3(1, 0, 0);
const _Y2 = new THREE.Vector3(0, 1, 0);
const _Z2 = new THREE.Vector3(0, 0, 1);

/** One body's face. `a` is the Avatar that owns it (a piece never imports its owner). */
export class Face {
  constructor(a) {
    this.a = a;
    this.gazeGoal = new THREE.Vector3();
    this.blinkAt = performance.now() + 1200 + Math.random() * 3600;
    this.blinkT = -1;
    this._mouth = 0;               // smoothed jaw, so the mouth has inertia
  }

  /** Per frame, after reach and before vrm.update (avatar.js update says why). */
  update(dt, now) {
    // ---- gaze: ease the target so eyes track instead of snapping
    if (this._hasGaze) this.a.gaze.position.lerp(this.gazeGoal, 1 - Math.exp(-6 * dt));
    else {
      _v.set(0, 1.5, 3).applyAxisAngle(new THREE.Vector3(0, 1, 0), this.a.root.rotation.y)
        .add(this.a.root.position);
      this.a.gaze.position.lerp(_v, 1 - Math.exp(-3 * dt));
    }

    // ---- blink: irregular, in pairs sometimes. The clock runs whether or not this body has expressions.
    let blinkV = 0;
    if (this.blinkT >= 0) {
      this.blinkT += dt;
      const k = this.blinkT / Math.max(0.05, BLINK.dur);
      blinkV = k < 1 ? Math.sin(k * Math.PI) : 0;
      if (k >= 1) {
        this.blinkT = -1;
        // scheduled from the end of the blink, so a pair gap shorter than a blink can't chain
        const rate = Math.max(0.15, BLINK.hz);
        this.blinkAt = now + (Math.random() < 0.22 ? 220
          : (2200 + Math.random() * 4200) / rate);
      }
    } else if (now > this.blinkAt) {
      this.blinkT = 0;
    }
    // ---- eyeballs: point them at the same target the gaze eases to
    if (this._eyes === undefined) this._findEyes();
    if (this._eyes && this.a.head) {
      this.a.head.getWorldQuaternion(_gq);
      _gf.set(0, 0, 1).applyQuaternion(_gq);          // where the head faces NOW
      for (const e of this._eyes) {
        e.node.getWorldPosition(_gp);
        _gw.copy(this.a.gaze.position).sub(_gp);
        if (_gw.lengthSq() < 1e-10) continue;
        _gw.normalize();
        _gd.setFromUnitVectors(_gf, _gw);             // the world-space turn
        const ang = 2 * Math.acos(Math.min(1, Math.abs(_gd.w)));
        if (ang > BLINK.eyeMax) {                     // clamp into a cone
          _gi.identity().slerp(_gd, BLINK.eyeMax / ang);
          _gd.copy(_gi);
        }
        // local = parentWorld⁻¹ · turn · parentWorld · rest
        e.node.parent.getWorldQuaternion(_gpq);
        _gi.copy(_gpq).invert().multiply(_gd).multiply(_gpq).multiply(e.rest);
        e.node.quaternion.copy(_gi);
      }
    }

    // ---- eyelids as bones: rotated from their captured rest by the blink curve, or the eased held state
    if (this._lids === undefined) this._findLids();
    this._eyesShut = this._eyesShut ?? 0;
    const goal = this._eyesGoal ?? 0;
    if (this._eyesShut !== goal) {
      this._eyesShut += (goal - this._eyesShut) * (1 - Math.exp(-12 * dt));
      if (Math.abs(goal - this._eyesShut) < 0.002) this._eyesShut = goal;
    }
    if (this._lids) {
      // a held close and a blink share the lids: whichever is further shut wins
      const amt = Math.max(blinkV, this._eyesShut ?? 0);
      for (const l of this._lids) {
        l.node.quaternion.copy(l.rest);
        // the rig's own exported limit wins; BLINK.closed is the dial otherwise
        const shut = l.exported ?? (l.lower ? BLINK.lower : BLINK.closed);
        if (amt > 0) {
          const ax = BLINK.axis === 1 ? _Y2 : BLINK.axis === 2 ? _Z2 : _X;
          l.node.quaternion.multiply(_pq.setFromAxisAngle(ax, shut * amt));
        }
      }
    }

    const em = this.a.vrm.expressionManager;
    if (em) {
      em.setValue('blink', blinkV);
      // mouth: a real amplitude (live mic) drives the jaw, smoothed open-fast close-slow; otherwise a syllable-rate
      // envelope for the utterance
      if (this.a.voiceLevel != null) {
        const target = Math.min(1, this.a.voiceLevel * 3.2);
        const k = target > this._mouth ? 0.55 : 0.18;
        this._mouth += (target - this._mouth) * k;
        em.setValue('aa', this._mouth * 0.8);
      } else if (now < this.a.speakUntil) {
        const t = now / 1000;
        const env = 0.5 + 0.5 * Math.sin(t * 17) * Math.sin(t * 7.3);
        em.setValue('aa', Math.max(0, env) * 0.65);
        this._mouth = 0;
      } else { em.setValue('aa', 0); this._mouth = 0; }
    }
  }

  /** Find hand-rigged eyeball bones (L_Eye / R_Eye) once. A rig whose eyes are VRM-mapped is three-vrm's: this.a.gaze
   *  is already its target, and two writers on one bone fight. */
  _findEyes() {
    this._eyes = null;
    if (!this.a.vrm?.scene) return;
    if (this.a.vrm.lookAt && this.a.vrm.humanoid?.getNormalizedBoneNode?.('leftEye')) return;
    const found = [];
    this.a.vrm.scene.traverse((o) => {
      if (/^[LR]_Eye$/.test(o.name ?? '')) found.push({ node: o, rest: o.quaternion.clone() });
    });
    if (found.length) this._eyes = found;
  }

  /** Hold the eyes shut or let them open (eased in update). False when this body has no eyelid bones. */
  setEyes(shut) {
    if (this._lids === undefined) this._findLids();
    if (!this._lids) return false;
    this._eyesGoal = shut ? 1 : 0;
    return true;
  }

  /** Find the eyelid bones (L_/R_Eyelid_Upper, _Lower) once and remember where open is. The closing angle comes
   *  from the rig as a node extra; BLINK.closed is the fallback. */
  _findLids() {
    this._lids = null;
    if (!this.a.vrm?.scene) return;
    const found = [];
    this.a.vrm.scene.traverse((o) => {
      const m = /^[LR]_Eyelid_(Upper|Lower)$/.exec(o.name ?? '');
      if (!m) return;
      const ex = o.userData?.gltfExtras ?? o.userData ?? {};
      // in order of authority: a saved closed pose (already a rotation from rest), a Limit Rotation constraint
      // (absolute angles, rest mid-range, so the delta is closed - centre), then the BLINK.closed dial
      let lim = NaN;
      const cl = Number(ex.blink_closed_x);
      if (ex.blink_closed_src === 'pose') {
        if (Number.isFinite(cl) && Math.abs(cl) > 1e-3 && Math.abs(cl) < 1.6) lim = cl;
      } else {
        const mn = Number(ex.limit_min_x), mx = Number(ex.limit_max_x);
        if ([mn, mx, cl].every(Number.isFinite) && mx > mn) {
          const d = cl - (mn + mx) / 2;
          if (Math.abs(d) > 1e-3 && Math.abs(d) < 1.6) lim = d;
        }
      }
      found.push({
        node: o,
        rest: o.quaternion.clone(),
        lower: m[1] === 'Lower',
        exported: Number.isFinite(lim) && Math.abs(lim) > 1e-4 ? lim : null,
      });
    });
    if (found.length) this._lids = found;
  }

  /** Where this body should be looking. Null = relax to neutral. */
  setGazeTarget(v3) {
    if (v3) { this.gazeGoal.copy(v3); this._hasGaze = true; }
    else this._hasGaze = false;
  }
}
