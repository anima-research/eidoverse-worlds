// The yaw unit contract, in one place.
//
// World yaw is RADIANS everywhere the runtime touches it — `THREE.Object3D
// .rotation.y`, `Math.sin/cos` in every composer, `Math.PI/2` in every
// effective-transform fixture, and spec/PROTOCOL.md §9 Conventions ("`yaw` in
// radians about +Y, with forward = +Z"). The renderer's scenegraph inspector is honest
// about it: it prints `yaw°` and converts degree input back to radians before
// it writes anything.
//
// The agent-authored surfaces were not (#147). `yaw: {type:'number'}` in a tool
// schema and a bare `yaw?` in the verb table say nothing, and one authored
// object carries `yaw: 30.00` next to another carrying `yaw: 1.57` — thirty
// radians beside a right angle, almost certainly a degree-looking input the
// world accepted verbatim. The fold was consistent; the contract was missing.
//
// So: ONE description string, referenced by every typed yaw property on every
// agent door, and ONE conversion helper. Existing world state is NOT rewritten
// — a 30-radian orientation may be exactly what its author wanted, and raw log
// state is authoritative. We label the door, not the room.
//
// tools/yaw-units-test.ts fails if a schema or the verb table drifts back to
// an unlabeled `yaw: number`.

/** The single labelling of yaw for every agent-facing schema. */
export const YAW_UNITS =
  "Rotation about +Y in RADIANS, not degrees — 0 faces +Z, Math.PI/2 (1.5708) is a quarter turn, " +
  "Math.PI (3.1416) a half turn. Degrees convert at your end: radians = degrees * Math.PI / 180, " +
  "so 30 degrees is 0.5236. A bare 30 here is thirty RADIANS (~279 degrees, four full turns on) " +
  "and the world will take it literally.";

/** The one conversion boundary. Nothing normalizes stored world state. */
export const degreesToRadians = (deg: number): number => (deg * Math.PI) / 180;
export const radiansToDegrees = (rad: number): number => (rad * 180) / Math.PI;

/** Yaw for a reader: the stored scalar, its unit, and what it means in degrees.
 *  Full turns are named rather than folded away, so `yaw 30` reads as the
 *  four-and-a-bit turns it is instead of a plausible-looking bearing. */
export function formatYaw(rad: number): string {
  if (!Number.isFinite(rad)) return `${rad} rad (not a rotation)`;
  const deg = radiansToDegrees(rad);
  const wrapped = ((deg % 360) + 360) % 360;
  const turns = Math.abs(Math.trunc(deg / 360));
  const scalar = +rad.toFixed(3);
  return turns === 0
    ? `${scalar} rad (${wrapped.toFixed(1)}°)`
    : `${scalar} rad (${wrapped.toFixed(1)}° after ${turns} full turn${turns === 1 ? "" : "s"})`;
}
