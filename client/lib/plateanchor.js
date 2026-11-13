// plateanchor — WHERE a nameplate hangs: anchored to the body, following its posture. Pure, so the test drives these
// very functions (tools/plateanchor-test.ts); avatar.js measures the body once and calls them every frame.
//
// WHY this shape (notes/eidoverse/nameplate-anchor-research-2026-09-30.md; owner, 09-30): a plate at a fixed 1.95 m
// above the feet is wrong for a short or a tall body and can't follow sitting or lying down. Nobody tracks the live
// HEAD — "a plate that bobs with the wearer's neck reads as broken" (BasisVR, BasisNamePlateAnchorMath.cs). So, Basis's
// way: measure the crown ONCE at rest, then hang the plate over the LIVE HIPS at the rest hips→crown height. Sitting
// lowers the hips, so the plate comes down with them for free. The head term (head + head span) only wins when the
// head rises above where the hips say it should be (a stretch, a jump's reach).
// LYING (Basis doesn't handle it; its plate would float a torso-length above a lying body): when the head drops under
// LIE_START of its rest height above the feet, the anchor blends to over the head — smoothly across the band down to
// LIE_FULL, so lying down is a glide, not a snap. A LOW HEAD ALONE IS NOT LYING: measured on the real clips (09-30,
// tools/plateanchor-shot-probe.mjs), sitting_on_ground puts the head at ~40% of its rest height (tigerbee 0.587 m of
// 1.44) — inside the band, so the plate slid 63% of the way to the head of a person sitting upright. What tells the
// two apart is the TORSO: head-over-hips as a fraction of rest is ~0.9 sitting (claude 0.90, tigerbee 0.92) and ~0.4
// on the lie clip (0.40 / 0.36). So lying = a low head AND a torso that has gone over (TORSO_START → TORSO_FULL);
// the lower of the two blends wins. A bow or a crouch keeps the head high, so it doesn't count either.
// Y is smoothed (a critically-damped chase with a small dead zone for breathing and head bob); X/Z are not — a plate
// that trails its walking body sideways reads as lag.
// STANDING IS RIGID (owner, 10-01: "big noticeable lag on the nameplate on jumping"): the chase was on the live anchor,
// and a jump clip moves the hips under the root (crouch, tuck, land), so the eased plate chased a swinging target.
// Upright in ordinary motion (STAND_SLOTS) the plate rides the REST crown over the root and the clip cannot move it;
// the chase only runs when the target changes, which is a posture change (stand ↔ sit ↔ lie).

export const EYE_K = 1.35;        // crown = eye + 1.35·(eye − head bone)            (Basis)
export const NO_EYE_K = 0.45;     // no eyes: crown = head + 0.45·(head − hips)       (Basis)
export const BOUNDS_CAP_K = 1.8;  // mesh bounds may raise the crown to head + 1.8·(that span), no further (Basis):
                                  // hair and hats count, wings and a crown of tentacles don't launch the plate
export const GAP_K = 0.05, GAP_MIN = 0.03, GAP_MAX = 0.15;   // gap over the crown: 5% of height, 3–15 cm (Basis)
export const LIE_START = 0.5, LIE_FULL = 0.3;   // head height above feet, as a fraction of rest: blend band
export const TORSO_START = 0.7, TORSO_FULL = 0.5;   // head height over the hips, as a fraction of rest: blend band
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

// ---- seen from above (owner, 10-01: "make sure the label offsets away from the avatar when seen from above") ------
// The plate hangs a gap over the crown in WORLD up. Looking down, that gap foreshortens (cos of the pitch) and the
// head's own top rises on screen toward the plate, until from straight above the plate sits on the face. The plate is
// a screen-aligned sprite, so the fix is in screen terms: slide it along the camera's up (perpendicular to the view,
// so its stereo depth and its own-body depth clearance are untouched) by the least amount that keeps its bottom edge
// standing off the head's top by what it does at eye level (drop − halfH: a few cm for a near plate; negative — an
// overlap — for a plate grown for range, which keeps exactly the overlap it has there). The head is a ball of `headR`
// under the crown, projected through the same pinhole the renderer uses, so the answer is exact at any range. The lift
// is 0 at eye level, grows smoothly as the camera pitches down, and is about headR + drop from straight above. A level
// or upward-looking camera lifts nothing (the rule alone would ask ~1 cm looking up 25°, the head being nearer the eye
// than the plate; at a level camera it is exactly 0, so the cut is continuous).
// (Clearing the head's top with no stand-off left the pill touching the head from straight above — 10-01 shots.)
// A pure function of the camera and the plate's own anchor (not the live head), so it is as steady as the plate.

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
