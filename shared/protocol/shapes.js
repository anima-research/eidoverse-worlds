// shared/protocol/shapes.js — the grammar of a collision shape (spec/PHYSICS.md §3.1). physics.shape is stamped by the
// authority into the log, so its grammar is frozen the moment the first engine writes one: it's fixed here, before any
// non-box shape exists (research physics-seeds 10-07, seed 3).
//
//   [[minX, minY, minZ], [maxX, maxY, maxZ]]   a box: the authority's measured box, in the thing's own frame. Every
//                                             shape stamped so far is one, so a bare 2-array is a box FOREVER.
//   {type, …, pos?, q?}                        any other shape: a tagged object, in the thing's own frame, in metres.
//                                             pos (offset) and q (unit quaternion) place it in that frame.
//     box       {half: [x, y, z]}             half-extents about pos (a rotated box in a compound)
//     sphere    {radius}
//     capsule   {radius, halfHeight}          along local +Y; halfHeight is the cylinder part's half length
//     cylinder  {radius, halfHeight}          along local +Y
//     convex    {blob}                        the hull's points, baked by the authority (no inline geometry)
//     mesh      {blob}                        a triangle mesh (static colliders only, for engines that say so)
//     compound  {blob}                        children [{shape, pos?, q?}], baked by the authority
//   blob: a content address, "sha256:<64 lowercase hex>" (what putBlob mints), resolvable from the world's blob store.
//
// A new type is an addition to this grammar (and to PHYSICS.md), never a change to an old one. Nothing else is a shape.
// Shared by the authority (it refuses anything else), the sim layer (eidosim is handed boxes only) and any reader.

export const SHAPE_TYPES = ["box", "sphere", "capsule", "cylinder", "convex", "mesh", "compound"];
const KEYS = { box: ["half"], sphere: ["radius"], capsule: ["radius", "halfHeight"], cylinder: ["radius", "halfHeight"], convex: ["blob"], mesh: ["blob"], compound: ["blob"] };
export const BLOB_ADDRESS = /^sha256:[0-9a-f]{64}$/;
const MAX = 1e4;   // metres: the same bound a transform's pos takes is generous for a collider's size
const fin = (x) => typeof x === "number" && Number.isFinite(x);
const vec3 = (a) => Array.isArray(a) && a.length === 3 && a.every(fin) && a.every((x) => Math.abs(x) <= MAX);
const size = (x) => fin(x) && x > 0 && x <= MAX;

/** A bare box [[min], [max]] (finite, min ≤ max on every axis). */
export const isBoxShape = (s) => Array.isArray(s) && s.length === 2 && vec3(s[0]) && vec3(s[1]) && s[0].every((x, i) => x <= s[1][i]);

/** Why `s` isn't a shape (a sentence), or null when it is one. */
export function shapeError(s) {
  if (Array.isArray(s)) return isBoxShape(s) ? null : "a bare shape is a box [[minX, minY, minZ], [maxX, maxY, maxZ]]: two finite points, min ≤ max on every axis";
  if (!s || typeof s !== "object") return `a shape is a box [[min], [max]] or a tagged object {type: ${SHAPE_TYPES.join("|")}, …}`;
  const keys = KEYS[s.type];
  if (!keys) return `no shape type ${JSON.stringify(s.type)} (types: ${SHAPE_TYPES.join(", ")})`;
  for (const k of Object.keys(s)) if (k !== "type" && k !== "pos" && k !== "q" && !keys.includes(k)) return `a ${s.type} takes ${keys.join(", ")} (and pos?, q?), not '${k}'`;
  for (const k of keys) if (s[k] === undefined) return `a ${s.type} needs ${k}`;
  if (s.pos !== undefined && !vec3(s.pos)) return "pos is [x, y, z] in metres, in the thing's own frame";
  if (s.q !== undefined && !(Array.isArray(s.q) && s.q.length === 4 && s.q.every(fin) && Math.abs(Math.hypot(...s.q) - 1) < 1e-6)) return "q is a unit quaternion [x, y, z, w]";
  if (s.type === "box" && !(vec3(s.half) && s.half.every((x) => x > 0))) return "a box's half is [x, y, z]: positive half-extents in metres";
  if ((s.type === "sphere" || s.type === "capsule" || s.type === "cylinder") && !size(s.radius)) return `a ${s.type}'s radius is metres, > 0`;
  if ((s.type === "capsule" || s.type === "cylinder") && !(fin(s.halfHeight) && s.halfHeight >= 0 && s.halfHeight <= MAX)) return `a ${s.type}'s halfHeight is metres, ≥ 0`;
  if (keys[0] === "blob" && !(typeof s.blob === "string" && BLOB_ADDRESS.test(s.blob))) return `a ${s.type}'s geometry is a content address, "sha256:<64 hex>" (the authority bakes and stamps it), never inline`;
  return null;
}

/** Volume in m³ of a well-formed primitive (mass, when absent, is density × this); null for a blob shape, whose volume
 *  is its baked geometry's, or for anything that isn't a shape. */
export function shapeVolume(s) {
  if (shapeError(s)) return null;
  if (Array.isArray(s)) return (s[1][0] - s[0][0]) * (s[1][1] - s[0][1]) * (s[1][2] - s[0][2]);
  const r = s.radius, h = s.halfHeight;
  switch (s.type) {
    case "box": return 8 * s.half[0] * s.half[1] * s.half[2];
    case "sphere": return (4 / 3) * Math.PI * r * r * r;
    case "capsule": return Math.PI * r * r * 2 * h + (4 / 3) * Math.PI * r * r * r;
    case "cylinder": return Math.PI * r * r * 2 * h;
    default: return null;
  }
}
