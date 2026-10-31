// xrpointer — the VR laser's POLICY, in one place, as plain functions a test can run without a headset
// (tools/xrpointer-test.mjs). xr.js owns the per-hand loop and the scene; this owns the decisions it makes there:
//
//   1. WHEN THE BEAM IS DRAWN — the owner's "pointer visibility" setting (Settings › VR, 10-02, after comparing with
//      Resonite): always / never / contextual. Contextual is the behaviour before the setting existed: the beam shows
//      while it rests on a panel or a nameplate, or while grip or trigger is held. Never hides the BEAM only: pointing,
//      clicking, the stick scroll and nameplate hover all still work.
//   2. HOW THE RAY FOLLOWS THE HAND — a short low-pass on the ray that is drawn AND picks with, so hand tremor does not
//      shake the beam's far end (a 0.3° tremor is 1.5 cm at 3 m: a whole row of a panel). Frame-rate independent:
//      alpha = 1 − exp(−dt/τ), the same smoothing at 72, 90 or 120 Hz. Done in the RIG's space (the tracking space),
//      so walking and turning never lag the beam; only the hand's own motion is filtered.
//   3. HOW IT HOLDS A TARGET (stickiness, with hysteresis) — once the ray is ON a clickable panel control or a
//      nameplate, it stays on it while the hand drifts a small angle off; getting ON still needs the ray (plus the
//      plate's small get-on slack) to actually hit it. Easier to stay on than to get on. While held, the ray is BENT to
//      the last point it had on the target, so the beam visibly stays there and a trigger lands there.
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
/** SURFACE DOT VISIBILITY (owner, 10-02): its own setting, beside pointer visibility, the same three words. 'never' on
 *  pointer visibility hides only the beam; the dot follows this. `target`: a panel, a nameplate or an interactable
 *  entity (what the contextual beam shows for); `surface`: anything at all under the laser (a plain wall too). */
export function dotVisible(mode, { target = false, surface = false } = {}) {
  const m = pointerVisibilityMode(mode);
  if (m === 'never') return false;
  if (m === 'always') return !!(target || surface);
  return !!target;
}
/** Does a PLAIN world entity (one with nothing to interact with) count for the beam's length this frame? Only while a
 *  button is held, or when the beam is always drawn: an idle hand in contextual or never mode must not reach out to
 *  every wall it hangs toward. An INTERACTABLE entity (below) is a target like a panel, button or not. */
export const looksAtWorld = (mode, { grip = false, trig = false } = {}) => pointerVisibilityMode(mode) === 'always' || !!(grip || trig);
/** INTERACTABLE: an entity that does something when you use it (owner, 10-02: "it does something when you trigger-click
 *  it"). The affordances look() reads out to agents (mcpl/agent.ts): its sockets (socket children: sit / mount; `sockets`
 *  is how many it has, world.js socketsOn) and reactions (use). The
 *  trigger on any entity also SELECTS it for editing (xr:select → the scene graph); that is an editor's act, not an
 *  affordance, so a plain wall is not a target. `comp`: the entity's component bag (world.js comps). */
export const interactable = (comp, sockets = 0) => !!comp && (sockets > 0 || (!!comp.reactions && typeof comp.reactions === 'object' && Object.keys(comp.reactions).length > 0));

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

// ---- 3. stickiness ----------------------------------------------------------------------------------------------
// One table, both kinds of target. GET ON: a panel control needs the ray on it; a nameplate gets PLATE_GETON_RAD of
// slack around its pill (platecard.platePick, which used to carry a flat 3 cm — generous up close and stingy far
// away, where tremor is angular; 0.01 rad is that same 3 cm at 3 m). STAY ON: while held, the target keeps the ray
// until it is STICK_STAY_RAD off the last point it had ON the target (the plate's slack included) — so the two do not
// stack blindly: the slack decides getting on, the stay margin is measured from where you last were on.
// YIELD: another control or plate under the ray takes over only past STICK_YIELD_RAD, so tremor on the seam between
// two neighbouring buttons does not flicker between them, but moving on to the next button is never held back by
// more than a fraction of a degree.
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
