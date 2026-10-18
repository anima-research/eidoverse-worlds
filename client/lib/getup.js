// getup — where a body that went limp stands up again.
//
// While a body lies in a heap its root follows the hips a hips-height LOWER
// (bodyengine.js _followRoot: root.y = hips.y - hipsOffset), so the root of
// a body lying on a floor sits well below that floor — ~0.75m below a stair
// landing. Getting up used to put the feet at height 0, which happened to
// work on the ground (the walking controller steps up anything within
// 0.55m) and nowhere else: on a landing the feet started inside the solid
// stair, upstairs under the floor the body lay on.
//
// The floor it stands on is the highest surface under its HIPS: the landing
// it fell on — not a slab overhead, not the terrain beneath the building.

import { THREE } from './core.js';
import { surfaceUnder } from './colliders.js';
import { heightAt } from './terrain.js';

const _hips = new THREE.Vector3();
/** Hips a little above the floor they lie on; the probe starts just above them. */
const ABOVE_HIPS = 0.1;
/** How far a lying body's root can sit below the floor it lies on, for a body
 *  at scale 1 — its hips-height less the little the hips lie above the floor.
 *  Rigs range ~0.55 to ~1.1; it grows with the body's scale. Used only when
 *  the rig can't say where its hips are, or a record lacks its floor. */
const ROOT_BELOW_FLOOR = 1.1;

/** The floor height a lying body stands up onto, at its root's x/z. */
export function floorUnderLyingBody(me, terrainAt = heightAt) {
  const r = me.root.position;
  const h = me.vrm?.humanoid;
  const hips = h?.getRawBoneNode?.('hips') ?? h?.getNormalizedBoneNode?.('hips');
  const top = hips ? hips.getWorldPosition(_hips).y : r.y + ROOT_BELOW_FLOOR * bodyScale(me.userScale);
  return surfaceUnder(r.x, r.z, terrainAt, top + ABOVE_HIPS).y;
}

const bodyScale = (s) => (Number.isFinite(s) && s > 0 ? s : 1);

/** A remembered lying body (a rejoin mid-heap) → the height to wake at.
 *  The floor it lay on, when it was recorded (presence `floor`, which the
 *  server's settledPose already stands the body on for current records).
 *  Otherwise — a record from before `floor` existed — its root plus how far
 *  a root can lie below its floor, for a body of this size (`scale`, the
 *  presence body scale): at or above that floor, to settle down onto. */
export function standingYFromLyingRoot(rootY, { floor, scale } = {}) {
  if (Number.isFinite(floor)) return floor;
  return rootY + ROOT_BELOW_FLOOR * bodyScale(scale);
}
