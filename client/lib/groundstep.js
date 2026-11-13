// groundstep — one frame of a walking body's height over its support (controller.js, out of the float).
// A body on the ground stays on ground that falls away no steeper than it can walk, up to a fixed reach (floor snap:
// Godot's floor_snap_length, Unreal's walk-down within MaxStepHeight), so walking downhill never reads as a fall.

export const GRAVITY = 16;            // m/s²
export const SNAP_SLOPE = 1;          // tan 45°: ground falling away faster than this per metre walked is a ledge
export const SNAP_MAX = 0.3;          // m: the most one frame snaps down, whatever the stride (a hitch frame is a ledge, not a slope)
export const SNAP_SLACK = 0.02;       // m: within this a grounded body stays grounded, walking or not (as before the snap)

/** s = {y, vy, grounded}, changed in place; support = the ground under the body now; walked = metres the stride
 *  covered this frame; floor = where a fall stops (the bed, for a swimmer falling into water: more than SNAP_MAX
 *  below, so it never snaps) */
export function groundStep(s, support, dt, walked, { floor = support, slope = SNAP_SLOPE, max = SNAP_MAX } = {}) {
  const drop = s.y - support;
  if (s.grounded && drop > SNAP_SLACK && drop <= Math.min(max, slope * walked)) { s.y = support; s.vy = 0; return s; }
  if (!s.grounded || drop > SNAP_SLACK) {
    s.grounded = false;
    s.vy -= GRAVITY * dt;
    s.y += s.vy * dt;
    if (s.y <= floor) { s.y = floor; s.vy = 0; s.grounded = true; }
  } else { s.y = support; s.vy = 0; s.grounded = true; }
  return s;
}
