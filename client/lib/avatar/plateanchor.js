// plateanchor — where a nameplate hangs: anchored to the body, following its posture. Pure (tested in
// test/client/plateanchor-test.ts); avatar.js measures the body once and calls these every frame.
//
// Shape (BasisVR's BasisNamePlateAnchorMath.cs, plus lying): measure the crown once at rest, then hang the plate over
// the live hips at the rest hips→crown height, so sitting lowers it for free; the head term only wins when the head
// rises above where the hips say (a stretch, a jump). Nobody tracks the live head: a plate that bobs reads as broken.
// Lying: when the head drops under LIE_START of its rest height above the feet AND the torso has gone over
// (TORSO_START → TORSO_FULL; sitting on the ground also puts the head low), the anchor blends to over the head.
// Y is smoothed (a damped chase with a dead zone for breathing); X/Z are not (a trailing plate reads as lag).
// Standing is rigid: in STAND_SLOTS the plate rides the rest crown over the root, so a jump clip cannot swing it; the
// chase only runs on a posture change.

const EYE_K = 1.35;        // crown = eye + 1.35·(eye − head bone)            (Basis)
const NO_EYE_K = 0.45;     // no eyes: crown = head + 0.45·(head − hips)       (Basis)
const BOUNDS_CAP_K = 1.8;  // mesh bounds may raise the crown to head + 1.8·(that span), no further (Basis):
                                  // hair and hats count, wings and a crown of tentacles don't launch the plate
const GAP_K = 0.05, GAP_MIN = 0.03, GAP_MAX = 0.15;   // gap over the crown: 5% of height, 3–15 cm (Basis)
const LIE_START = 0.5, LIE_FULL = 0.3;   // head height above feet, as a fraction of rest: blend band
const TORSO_START = 0.7, TORSO_FULL = 0.5;   // head height over the hips, as a fraction of rest: blend band
export const TAU = 0.12;          // s — Y smoothing time constant (unsourced; tuned by eye, research says 0.1–0.15)
export const DEAD = 0.02;         // m — Y dead zone (head bob, breathing)

const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const fin = (x) => typeof x === 'number' && Number.isFinite(x);

/** The crown, measured once at rest, in model units (heights along the body's up axis).
 *  { hips, head, eye?, boundsTop? } → { crown, headSpan, hipsToCrown } or null when there is no head/hips to hang from.
 *  eye: the eyes' mean height (null/absent/at-or-under the head bone → the no-eye fallback);
 *  boundsTop: the skinned mesh's top at rest (null → eyes alone). */
export function crownEstimate({ hips, head, eye = null, boundsTop = null }) {
  if (!fin(hips) || !fin(head) || head <= hips) return null;
  const eyeCrown = fin(eye) && eye > head ? eye + EYE_K * (eye - head) : head + NO_EYE_K * (head - hips);
  const cap = head + BOUNDS_CAP_K * (eyeCrown - head);
  const crown = fin(boundsTop) ? Math.max(eyeCrown, Math.min(boundsTop, cap)) : eyeCrown;
  return { crown, headSpan: crown - head, hipsToCrown: crown - hips };
}

/** The gap between crown and plate, for a body `height` metres tall (world). */
export const plateGap = (height) => clamp(GAP_K * (fin(height) ? height : 0), GAP_MIN, GAP_MAX);

const band = (x, rest, start, full) => {
  if (!fin(x) || !fin(rest) || rest <= 0) return 0;
  const t = clamp((start - x / rest) / (start - full), 0, 1);
  return t * t * (3 - 2 * t);
};
/** How far lying down the body is, 0 (upright/sitting) … 1 (lying): the head's height above the feet as a fraction of
 *  its rest height (eased across LIE_START → LIE_FULL), gated by how far the torso has gone over — head over hips as
 *  a fraction of rest (TORSO_START → TORSO_FULL). Omit the torso pair and only the head height counts. */
export function lieAmount(headAboveFeet, restHeadAboveFeet, headOverHips = null, restHeadOverHips = null) {
  const low = band(headAboveFeet, restHeadAboveFeet, LIE_START, LIE_FULL);
  return fin(headOverHips) && fin(restHeadOverHips) ? Math.min(low, band(headOverHips, restHeadOverHips, TORSO_START, TORSO_FULL)) : low;
}

/** Where the plate wants to be this frame (WORLD, y up), before smoothing.
 *  hips, head: [x,y,z] live bone positions; feetY: the lower foot's height (or the ground under the body);
 *  rest: crownEstimate()'s result plus restHeadAboveFeet (all model units); s: the live model→world scale; gap: m;
 *  lift: the wearer's own offset over the crown (Profile › Avatar, bodyscale.js plateLift — already world m), added to
 *  both the standing and the lying anchor, so it follows posture exactly as auto does. 0 = auto.
 *  → { p: [x,y,z], lie }, written into `out` when given (avatar.js calls this per body, per frame) */
export function plateAnchor({ hips, head, feetY, rest, s = 1, gap, lift = 0 }, out = { p: [0, 0, 0], lie: 0 }) {
  const up = gap + (fin(lift) ? lift : 0);
  const stand = Math.max(hips[1] + rest.hipsToCrown * s, head[1] + rest.headSpan * s) + up;
  const lie = lieAmount(head[1] - feetY, rest.restHeadAboveFeet * s, head[1] - hips[1], (rest.hipsToCrown - rest.headSpan) * s);
  const lieY = head[1] + rest.headSpan * s + up;
  out.p[0] = hips[0] + (head[0] - hips[0]) * lie; out.p[1] = stand + (lieY - stand) * lie; out.p[2] = hips[2] + (head[2] - hips[2]) * lie;
  out.lie = lie;
  return out;
}

/** One frame of the Y chase: toward `target`, but only the part of the error outside the dead zone, at
 *  1 − exp(−dt/τ). First frame (prev not a number) lands on the target. Continuous at the dead zone's edge. */
export function smoothY(prev, target, dt, { tau = TAU, dead = DEAD } = {}) {
  if (!fin(prev)) return target;
  const err = target - prev;
  if (Math.abs(err) <= dead) return prev;
  const goal = target - Math.sign(err) * dead;
  return prev + (goal - prev) * (1 - Math.exp(-Math.max(0, dt) / tau));
}

/** The clip slots that are standing for the plate: upright in ordinary motion — a fall off a ledge plays the jump.
 *  Flight, climbing and seat/lie poses keep the live anchor. */
export const STAND_SLOTS = new Set(['idle', 'walk', 'run', 'jump']);

/** One frame of the plate's height over the root. Standing, the target is the rest anchor (standY) and the chase has
 *  no dead zone, so after a posture change it lands on it exactly and then never moves; otherwise the live anchor
 *  (liveY), chased as before. A change of target is a posture change, and that is what eases. */
export function plateOffset(prev, { standing, standY, liveY }, dt, opts = {}) {
  if (!standing) return smoothY(prev, liveY, dt, opts);
  return smoothY(prev, standY, dt, opts.tau == null ? RIGID : { tau: opts.tau, dead: 0 });   // per body, per frame: no garbage
}
const RIGID = { dead: 0 };

// ---- seen from above: the label offsets away from the avatar ------------------------------------------------------
// Looking down, the gap over the crown foreshortens until from straight above the plate sits on the face. The plate is
// a screen-aligned sprite, so slide it along the camera's up (stereo depth and depth clearance untouched) by the least
// amount that keeps its bottom edge as far off the head's top as it is at eye level. The head is a ball of `headR`
// under the crown, projected through the renderer's pinhole, so the answer is exact at any range. 0 at a level or
// upward-looking camera (continuous), about headR + drop from straight above. A function of the plate's own anchor,
// not the live head, so it is as steady as the plate.

/** eye, up, fwd: the camera's world position and unit up / forward ([x,y,z]); plate: the plate's centre (world);
 *  drop: plate centre → crown (the gap + the wearer's lift, m); headR: the head's radius (m); halfH: half the pill's
 *  height as drawn (m). → the lift (m, ≥ 0) along `up`. */
export function plateViewLift({ eye, up, fwd, plate, drop, headR, halfH }) {
  const px = plate[0] - eye[0], py = plate[1] - eye[1], pz = plate[2] - eye[2];
  const zP = px * fwd[0] + py * fwd[1] + pz * fwd[2];
  const down = drop + headR;   // plate centre → the head ball's centre, straight down
  const zH = zP - down * fwd[1];
  if (!(fwd[1] < 0) || !(zP > 1e-3) || !(zH > 1e-3)) return 0;   // level or looking up; behind the eye (or NaN)
  const yP = px * up[0] + py * up[1] + pz * up[2], yH = yP - down * up[1];
  return Math.max(0, zP * (yH + headR + drop - halfH) / zH - yP + halfH);
}
