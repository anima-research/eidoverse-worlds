// xrpointer — the VR laser's POLICY, in one place, as plain functions a test can run without a headset
// (tools/xrpointer-test.mjs). xr.js owns the per-hand loop and the scene; this owns the decisions it makes there:
//
//   1. WHEN THE BEAM IS DRAWN — the owner's "pointer laser" setting (Settings › VR, 10-02, after comparing with
//      Resonite): always / never / contextual. Contextual is the behaviour before the setting existed: the beam shows
//      while it rests on a panel or a nameplate, or while grip or trigger is held. Never hides the BEAM only: pointing,
//      clicking, the stick scroll and nameplate hover all still work.
//   2. HOW THE RAY FOLLOWS THE HAND — a short low-pass on the ray that is drawn AND picks with, so hand tremor does not
//      shake the beam's far end (a 0.3° tremor is 1.5 cm at 3 m: a whole row of a panel). Frame-rate independent:
//      alpha = 1 − exp(−dt/τ), the same smoothing at 72, 90 or 120 Hz. Done in the RIG's space (the tracking space),
//      so walking and turning never lag the beam; only the hand's own motion is filtered.
import * as THREE from 'three';

// ---- 1. the setting -------------------------------------------------------------------------------------------
export const LASER_MODES = ['always', 'never', 'contextual'];
export const LASER_DEFAULT = 'contextual';
export const laserMode = (v) => (LASER_MODES.includes(v) ? v : LASER_DEFAULT);   // an unknown stored value reads as the default
/** Is the beam drawn this frame? `target`: the ray rests on a panel or a nameplate. `grip`/`trig`: held. */
export function laserVisible(mode, { target = false, grip = false, trig = false } = {}) {
  const m = laserMode(mode);
  if (m === 'never') return false;
  if (m === 'always') return true;
  return !!(target || grip || trig);
}
/** Does the hand look for WORLD entities this frame (the laser's length)? Panels and nameplates are always looked
 *  for — they are the targets a resting laser serves. The world is looked at only while a button is held, or when the
 *  beam is always drawn: an idle hand in contextual or never mode must not paint a dot on every wall it hangs toward
 *  (and must not pay a scene raycast per hand per frame for it). */
export const looksAtWorld = (mode, { grip = false, trig = false } = {}) => laserMode(mode) === 'always' || !!(grip || trig);

// ---- 2. smoothing ---------------------------------------------------------------------------------------------
// τ is the time to close ~63% of a gap. 30 ms: physiological tremor (8–12 Hz) is roughly halved, and a deliberate
// sweep trails by ω·τ (≈5° at a brisk 3 rad/s, gone the moment the hand stops). Raise it to steady the beam more,
// lower it if aiming feels late; that is the one dial.
export const POINTER_TAU = 0.03;          // s
// a step this large in ONE frame is not tremor: tracking re-acquired, a recentre, a teleport. Snap rather than swoop.
export const POINTER_SNAP_RAD = 0.6;      // rad
export const POINTER_SNAP_M = 0.5;        // m
export const smoothAlpha = (dt, tau = POINTER_TAU) => (!(dt > 0) ? 0 : !(tau > 0) ? 1 : 1 - Math.exp(-dt / tau));
/** One frame: `out` ({position, quaternion}) moves toward `to`. `st` is the caller's per-hand state ({init}).
 *  Returns 'snap' or the alpha used. */
export function smoothPose(out, to, dt, st, tau = POINTER_TAU) {
  if (!st.init || out.position.distanceTo(to.position) > POINTER_SNAP_M || out.quaternion.angleTo(to.quaternion) > POINTER_SNAP_RAD) {
    out.position.copy(to.position); out.quaternion.copy(to.quaternion); st.init = true;
    return 'snap';
  }
  const a = smoothAlpha(dt, tau);
  out.position.lerp(to.position, a); out.quaternion.slerp(to.quaternion, a);
  return a;
}
