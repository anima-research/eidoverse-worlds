// groundstep — one frame of a walking body's height over its support (controller.js, out of the float).
// A body on the ground stays on ground that falls away no steeper than it can walk (floor snap: Godot's
// floor_snap_length, Unreal's walk-down within its walkable slope), so walking downhill never reads as a fall.

export const GRAVITY = 16;            // m/s²
export const SNAP_SLOPE = 1;          // tan 45°: ground falling away faster than this per metre walked is a ledge
export const SNAP_SLACK = 0.02;       // m

/** s = {y, vy, grounded}, changed in place; support = the ground under the body now; moved = metres walked this
 *  frame; floor = where a fall stops (the bed, for a swimmer falling into water); snap = false where there's no floor to keep */
export function groundStep(s, support, dt, moved, { floor = support, snap = true, slope = SNAP_SLOPE } = {}) {
  const drop = s.y - support;
  if (snap && s.grounded && drop > SNAP_SLACK && drop <= SNAP_SLACK + slope * moved) { s.y = support; s.vy = 0; return s; }
  if (!s.grounded || drop > SNAP_SLACK) {
    s.grounded = false;
    s.vy -= GRAVITY * dt;
    s.y += s.vy * dt;
    if (s.y <= floor) { s.y = floor; s.vy = 0; s.grounded = true; }
  } else { s.y = support; s.vy = 0; s.grounded = true; }
  return s;
}
