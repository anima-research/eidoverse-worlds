// A scale is one number (uniform, every v1 world) or [x, y, z] (a v4 world's transform, R 10-04). Kept a number while
// the three agree, so a uniform thing reads exactly as it always has.
export const scale3 = (s) => (Array.isArray(s) && s.length === 3 ? s : [s ?? 1, s ?? 1, s ?? 1]);
export const scaleWire = (v) => { const [x, y, z] = scale3(v); return x === y && y === z ? x : [x, y, z]; };
/** Put a scale (number or [x,y,z]) on a three.js object. */
export function applyScale(obj, s) { const [x, y, z] = scale3(s); obj.scale.set(x, y, z); }
/** An object's scale as the wire carries it. */
export const scaleOf = (obj) => scaleWire([obj.scale.x, obj.scale.y, obj.scale.z].map((n) => +n.toFixed(4)));
/** A record's scale as this code understands it: a v4 world's per-axis `scale3` beside the one-number `scale` every
 *  v1-era reader keeps (shared/v4/legacy.js). */
export const entScale = (e) => e?.scale3 ?? e?.scale;
