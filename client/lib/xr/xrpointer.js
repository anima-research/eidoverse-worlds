// xrpointer — the VR laser's policy as plain functions a test can run without a headset (test/client/xrpointer-test.mjs).
// xr.js owns the per-hand loop and the scene; this owns three decisions:
//   1. when the beam is drawn — the "pointer visibility" setting (Settings › VR): always / never / contextual
//      (on a panel or nameplate, or while grip or trigger is held). 'never' hides only the beam; pointing still works.
//   2. how the ray follows the hand — a frame-rate-independent low-pass (alpha = 1 − exp(−dt/τ)) in the rig's space,
//      so tremor doesn't shake the far end and walking never lags the beam.
//   3. how it holds a target — hysteresis: easier to stay on a control or nameplate than to get on; while held the
//      ray is bent to the last point it had on the target, so the beam stays and a trigger lands there.
import * as THREE from 'three';

// ---- 1. the setting -------------------------------------------------------------------------------------------
export const POINTER_VIS_MODES = ['always', 'never', 'contextual'];
export const POINTER_VIS_DEFAULT = 'contextual';
export const pointerVisibilityMode = (v) => (POINTER_VIS_MODES.includes(v) ? v : POINTER_VIS_DEFAULT);   // an unknown stored value reads as the default
/** Is the beam drawn this frame? `target`: the ray rests on a panel or a nameplate. `grip`/`trig`: held. */
export function pointerVisible(mode, { target = false, grip = false, trig = false } = {}) {
  const m = pointerVisibilityMode(mode);
  if (m === 'never') return false;
  if (m === 'always') return true;
  return !!(target || grip || trig);
}
/** The surface dot's own setting, the same three words. `target`: a panel, nameplate or interactable entity;
 *  `surface`: anything at all under the laser. */
export function dotVisible(mode, { target = false, surface = false } = {}) {
  const m = pointerVisibilityMode(mode);
  if (m === 'never') return false;
  if (m === 'always') return !!(target || surface);
  return !!target;
}
/** Does a plain world entity count for the beam's length this frame? Only while a button is held or the beam is
 *  always drawn, so an idle hand doesn't reach out to every wall. An interactable entity (below) is always a target. */
export const looksAtWorld = (mode, { grip = false, trig = false } = {}) => pointerVisibilityMode(mode) === 'always' || !!(grip || trig);
/** An entity that does something when trigger-clicked: it has sockets (sit / mount; `sockets` = how many, world.js
 *  socketsOn) or reactions (use). Selecting for edit is not an affordance, so a plain wall is not a target.
 *  `comp`: the entity's component bag. */
export const interactable = (comp, sockets = 0) => !!comp && (sockets > 0 || (!!comp.reactions && typeof comp.reactions === 'object' && Object.keys(comp.reactions).length > 0));

// ---- 2. smoothing ---------------------------------------------------------------------------------------------
// τ: time to close ~63% of a gap. At 30 ms tremor (8–12 Hz) is roughly halved and a brisk sweep trails ≈5°. Raise to
// steady the beam, lower if aiming feels late.
export const POINTER_TAU = 0.03;          // s
// a step this large in ONE frame is not tremor: tracking re-acquired, a recentre, a teleport. Snap rather than swoop.
export const POINTER_SNAP_RAD = 0.6;      // rad
const POINTER_SNAP_M = 0.5;        // m
const smoothAlpha = (dt, tau = POINTER_TAU) => (!(dt > 0) ? 0 : !(tau > 0) ? 1 : 1 - Math.exp(-dt / tau));
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

// ---- 3. stickiness ----------------------------------------------------------------------------------------------
// Get on: a panel control needs the ray on it; a nameplate gets PLATE_GETON_RAD of slack around its pill. Stay on:
// the held target keeps the ray until it is STICK_STAY_RAD off the last point it had on it. Yield: another target
// under the ray takes over only past STICK_YIELD_RAD, so tremor on the seam between two buttons doesn't flicker.
export const PLATE_GETON_RAD = 0.01;      // ≈0.57°
export const STICK_STAY_RAD = 0.025;      // ≈1.4° — 2 cm at arm's length (0.8 m), 7.5 cm at 3 m
export const STICK_YIELD_RAD = 0.008;     // ≈0.46°
/** The held target for the next frame. `held` / `raw`: {key, …} or null (raw = what the unbent ray is on now);
 *  `angle`: radians between the unbent ray and the held target's last point (NaN when there is none, or the held
 *  target has gone). → { held, bend }: bend = draw and pick toward held's point instead of along the ray. */
export function stickStep(held, raw, angle) {
  if (raw && held && raw.key === held.key) return { held: raw, bend: false };   // on it: its point follows the ray
  if (held && Number.isFinite(angle) && angle <= (raw ? STICK_YIELD_RAD : STICK_STAY_RAD)) return { held, bend: true };
  return { held: raw ?? null, bend: false };
}

const _d = new THREE.Vector3(), _q = new THREE.Quaternion(), _one = new THREE.Vector3(1, 1, 1), _fwd = new THREE.Vector3(0, 0, -1);
/** Angle (rad) between the ray (origin, unit dir) and the direction to `point`. */
export const angleTo = (origin, dir, point) => { _d.subVectors(point, origin); return _d.lengthSq() < 1e-12 ? 0 : dir.angleTo(_d); };
/** A ray matrix from `origin` looking at `point` (−Z forward, the controllers' convention). Writes `out`. */
export function rayMatrixTo(out, origin, point) {
  _d.subVectors(point, origin).normalize();
  _q.setFromUnitVectors(_fwd, _d);
  return out.compose(origin, _q, _one);
}
