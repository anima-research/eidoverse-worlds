// shared/axes.js — the axis letters, one table: a letter an editor or an agent may write for a unit vector. Pure.
// Motion, the motion reader, the editor and look-at's reader take all six; look-at's door and turn take the three positive
// letters only (tools/axes-test.ts pins both).
export const AXES = Object.freeze({ x: Object.freeze([1, 0, 0]), y: Object.freeze([0, 1, 0]), z: Object.freeze([0, 0, 1]),
  "-x": Object.freeze([-1, 0, 0]), "-y": Object.freeze([0, -1, 0]), "-z": Object.freeze([0, 0, -1]) });
/** The letters look-at's door and turn take: no negative letter. */
export const POSITIVE_AXES = Object.freeze({ x: AXES.x, y: AXES.y, z: AXES.z });
