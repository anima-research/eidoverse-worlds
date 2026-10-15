// swimpose — the procedural swim stroke and treading pose, one law for every reader: the browser draws it
// (client/lib/avatar.js _swimLayer, blended in by weight over the idle clip) and the headless body reader
// evaluates it (mcpl/body-state.ts), so a swimmer's read joints are the drawn ones. No rig ships a swim
// clip; the clips 'swim' and 'tread' name this pose.
//
// The stroke's beat runs on each viewer's own clock — nothing about it is on the wire — so its PHASE is
// per viewer; its shape (where the arms and legs range) is the same everywhere.

/** The clips this module draws. */
export const SWIM_CLIPS = ['swim', 'tread'];

/** [bone, x, y, z] Euler radians (order 'YZX') for each bone the stroke moves, at stroke mix `m` (0 tread,
 *  1 swim — the browser eases between them) and time `t` seconds. Never the head: the camera pitch owns it. */
export function swimTargets(m, t) {
  const ph = t * 2 * Math.PI * (0.6 + 0.25 * m);          // the stroke's beat: a little brisker when moving
  const S = 0.5 + 0.5 * Math.sin(ph), K = 0.5 + 0.5 * Math.sin(ph + Math.PI);
  const L = (a, b) => a + (b - a) * m;                    // tread → swim
  const mixv = (a, b, k) => a + (b - a) * k;
  return [
    ['hips', L(0.08, 0.55), 0, 0],
    ['spine', L(0, 0.1), 0, 0],
    ['neck', L(0, -0.45), 0, 0],
    ['leftUpperArm', 0, L(0.35 * Math.sin(ph), mixv(-0.2, -1.45, S)), L(-0.55, mixv(-0.6, -0.15, S))],
    ['rightUpperArm', 0, L(-0.35 * Math.sin(ph), mixv(0.2, 1.45, S)), L(0.55, mixv(0.6, 0.15, S))],
    ['leftLowerArm', 0, L(-0.5, mixv(-1.2, -0.1, S)), 0],
    ['rightLowerArm', 0, L(0.5, mixv(1.2, 0.1, S)), 0],
    ['leftUpperLeg', L(-0.45 - 0.25 * Math.sin(ph), -0.5 * K), 0, L(0, 0.25 * K)],
    ['rightUpperLeg', L(-0.45 + 0.25 * Math.sin(ph), -0.5 * K), 0, L(0, -0.25 * K)],
    ['leftLowerLeg', L(0.9 + 0.3 * Math.sin(ph), 1.4 * K), 0, 0],
    ['rightLowerLeg', L(0.9 - 0.3 * Math.sin(ph), 1.4 * K), 0, 0],
  ];
}
