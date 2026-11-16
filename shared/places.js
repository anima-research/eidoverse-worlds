// places — named places on placed things, for walking to and for knowing where
// you are.
//
// A place belongs to an entity and is written in that entity's MODEL frame (Y
// up, metres, the frame sockets use), so it moves, turns and scales with the
// thing. Two sources, the second overriding the first name by name:
//
//   1. the model's own description: a `building` object in a scene node's
//      glTF extras (rooms, portals, seats, arrivals — the shape
//      mythos-models/buildings writes). Defaults, shipped with the file.
//   2. the entity's `places` component — anyone with builder rank can add,
//      rename or retire places at any time, long after the thing was built:
//
//        set {id, component: "places", value: {
//          balcony:  {at: [0, 3.15, 2.9], label: "the balcony"},
//          upstairs: {min: [-2.2, 3.15, -2.2], max: [2.2, 5.8, 2.2], label: "the lookout room"},
//          porch_bench: null,          // hides a place the model declares
//        }}
//
//      `at` is a point to stand at (its y the floor there); `min`/`max` a
//      region (a room: its min y is its floor). Either may carry `label`.
//
// Pure: callers hand in entities and their model metadata.

import { isFiniteVec3 } from "./protocol/is.js";

/** @typedef {[number, number, number]} Vec3 */
/** @typedef {{ name: string, label?: string, kind: "point" | "region" | "door" | "seat", at?: Vec3, min?: Vec3, max?: Vec3, source: "model" | "component" }} Place
 *  at: a point, door or seat; min/max: a region */
/** The thing a place belongs to: pos, q ([x, y, z, w]) or yaw, scale (a number or [x, y, z]), and name (how a reader calls
 *  it: its unique label, else its handle).
 *  @typedef {{ id: string, pos: number[], yaw?: number, q?: number[], scale?: number | number[], name?: string }} PlaceHolder */

const NAME = /^[A-Za-z0-9_][A-Za-z0-9_ .:'-]{0,47}$/;

/** Defaults from a model's `building` description (glTF extras).
 *  @returns {Map<string, Place>} */
export function placesFromModel(meta) {
  const out = new Map();
  if (!meta || typeof meta !== "object") return out;
  const add = (p) => { if (NAME.test(p.name) && !out.has(p.name)) out.set(p.name, p); };
  for (const r of Array.isArray(meta.rooms) ? meta.rooms : []) {
    if (typeof r?.id !== "string" || !isFiniteVec3(r.min) || !isFiniteVec3(r.max)) continue;
    const min = [Math.min(r.min[0], r.max[0]), Math.min(r.min[1], r.max[1]), Math.min(r.min[2], r.max[2])];
    const max = [Math.max(r.min[0], r.max[0]), Math.max(r.min[1], r.max[1]), Math.max(r.min[2], r.max[2])];
    // a room's floor is its own min y; a declared level/floor wins when given
    const floor = typeof r.level === "string" && Array.isArray(meta.levels)
      ? meta.levels.find((l) => l?.id === r.level)?.floor : undefined;
    if (Number.isFinite(floor)) min[1] = floor;
    add({ name: r.id, label: typeof r.name === "string" ? r.name : undefined, kind: "region", min, max, source: "model" });
  }
  for (const p of Array.isArray(meta.portals) ? meta.portals : []) {
    if (typeof p?.id !== "string" || !isFiniteVec3(p.center)) continue;
    add({ name: p.id, kind: "door", at: p.center, label: p.id.replace(/_/g, " "), source: "model" });
  }
  for (const s of Array.isArray(meta.seats) ? meta.seats : []) {
    if (typeof s?.id !== "string" || !isFiniteVec3(s.pos)) continue;
    add({ name: s.id, kind: "seat", at: s.pos, label: s.id.replace(/_/g, " "), source: "model" });
  }
  for (const a of Array.isArray(meta.arrivals) ? meta.arrivals : []) {
    if (typeof a?.id !== "string" || !isFiniteVec3(a.pos)) continue;
    add({ name: a.id === "outside" ? "entrance" : `arrive_${a.id}`, kind: "point", at: a.pos, source: "model" });
  }
  return out;
}

/** Normalize a `places` component; malformed entries name nothing (they still fold and persist).
 *  @returns {Map<string, Place | null>} */
export function placesFromComponent(data) {
  const out = new Map();
  if (!data || typeof data !== "object" || Array.isArray(data)) return out;
  for (const [name, v] of Object.entries(data)) {
    if (!NAME.test(name)) continue;
    if (v === null) { out.set(name, null); continue; }
    const label = typeof v?.label === "string" ? v.label.slice(0, 80) : undefined;
    if (isFiniteVec3(v?.at)) out.set(name, { name, label, kind: "point", at: v.at, source: "component" });   // a stored `kind` is ignored
    else if (isFiniteVec3(v?.min) && isFiniteVec3(v?.max)) {
      const min = [0, 1, 2].map((k) => Math.min(v.min[k], v.max[k]));
      const max = [0, 1, 2].map((k) => Math.max(v.min[k], v.max[k]));
      out.set(name, { name, label, kind: "region", min, max, source: "component" });
    }
  }
  return out;
}

/** An entity's places: the model's defaults, then its component on top.
 *  @returns {Place[]} */
export function placesOf(meta, comp) {
  const all = placesFromModel(meta);
  for (const [name, p] of placesFromComponent(comp)) {
    if (p === null) all.delete(name); else all.set(name, p);
  }
  return [...all.values()];
}

const scale3 = (s) => Array.isArray(s) && s.length === 3 && s.every((x) => Number.isFinite(x) && x !== 0) ? [s[0], s[1], s[2]]
  : typeof s === "number" && s > 0 ? [s, s, s] : [1, 1, 1];
/** The frame's stretch as sizes: a mirrored axis (negative) is drawn mirrored, but its lengths are positive. */
const mag3 = (s) => scale3(s).map(Math.abs);
/** How much a thing's frame scales a volume in it: the product of the axes its places are framed at (scale3), so a
 *  region's size in the world agrees with where inRegion finds it.
 *  @param {PlaceHolder} e */
export function frameVolume(e) { const s = mag3(e.scale); return s[0] * s[1] * s[2]; }
const rotOf = (e) => { const q = e.q; if (Array.isArray(q) && q.length === 4 && q.every(Number.isFinite)) { const n = Math.hypot(...q); if (n > 1e-9) return q.map((x) => x / n); }
  const y = e.yaw ?? 0; return [0, Math.sin(y / 2), 0, Math.cos(y / 2)]; };
const qApply = (q, v) => { const [x, y, z, w] = q; const tx = 2 * (y * v[2] - z * v[1]), ty = 2 * (z * v[0] - x * v[2]), tz = 2 * (x * v[1] - y * v[0]);
  return [v[0] + w * tx + (y * tz - z * ty), v[1] + w * ty + (z * tx - x * tz), v[2] + w * tz + (x * ty - y * tx)]; };
/** Model frame → world (toLocal is its inverse; shared/structure.js localizePoint is the yaw-only, uniform-scale case of that). */
export function toWorld(e, p) {
  const s = scale3(e.scale), d = qApply(rotOf(e), [p[0] * s[0], p[1] * s[1], p[2] * s[2]]);
  return [e.pos[0] + d[0], e.pos[1] + d[1], e.pos[2] + d[2]];
}
export function toLocal(e, w) {
  const s = scale3(e.scale), q = rotOf(e), d = qApply([-q[0], -q[1], -q[2], q[3]], [w[0] - e.pos[0], w[1] - e.pos[1], w[2] - e.pos[2]]);
  return [d[0] / s[0], d[1] / s[1], d[2] / s[2]];
}

/** Is a body standing at world point `w` inside this region? Its feet must be
 *  on or above the region's floor (a hand's width of slack) and below its top. */
export function inRegion(e, p, w) {
  if (p.kind !== "region" || !p.min || !p.max) return false;
  const l = toLocal(e, w), slack = 0.1 / mag3(e.scale)[1];   // a hand's width in metres, in the frame's height
  return l[0] >= p.min[0] && l[0] <= p.max[0] && l[2] >= p.min[2] && l[2] <= p.max[2]
    && l[1] >= p.min[1] - slack && l[1] < p.max[1];
}

const norm = (s) => s.trim().toLowerCase().replace(/^the\s+/, "").replace(/[\s_-]+/g, " ");

/** Does `query` name this place? By its name, or by its label, loosely
 *  ("the reading room", "reading_room" and "Reading Room" all do). */
export function names(p, query) {
  const q = norm(query);
  return norm(p.name) === q || (p.label != null && norm(p.label) === q);
}

/** A destination a walk can aim for: a world point, the floor height to arrive on, and how far from the point a place to
 *  stand may be. above: how far above y the floor may be (a room's floor height is exact); below: how far below (unbounded
 *  when absent); inside: a region, only places to stand inside it count; orBeside: where to walk instead when no walk
 *  reaches this spot (beside what the thing stands on: a cup on a table); bodyAt: a person's own spot, short of which the
 *  walk stops (y is their root there, and their floor the one their body is on).
 *  @typedef {{ x: number, y: number, z: number, reach: number, label: string, above?: number, below?: number,
 *    inside?: (x: number, z: number) => boolean, orBeside?: Destination, bodyAt?: { x: number, z: number } }} Destination */
/** How far a named room's walkable floor may sit from its declared height —
 *  in world metres, the walking body's tolerance: the body does not scale
 *  with the thing, so neither does this. */
export const ROOM_FLOOR_EPS = 0.1;
/** A seat is reached from beside it: the body's own standoff (world metres)
 *  plus the seat's half-width, which IS the model's and scales with it. */
export const SEAT_STANDOFF = 0.7, SEAT_HALF = 0.3;

/** Where to walk to reach a place: a region's floor (middle preferred); the floor beside a seat (sitting is a
 *  mount); a door or point itself.
 *  @param {PlaceHolder} e @param {Place} p @returns {Destination} */
export function destinationOf(e, p) {
  const s = mag3(e.scale);   // per axis: a stretched thing's room and seat are stretched with it
  const label = `${e.name ?? e.id}/${p.name}${p.label ? ` (${p.label})` : ""}`;
  if (p.kind === "region") {
    const mid = toWorld(e, [(p.min[0] + p.max[0]) / 2, p.min[1], (p.min[2] + p.max[2]) / 2]);
    // reach covers the room's half-diagonal; `inside` keeps the search in the room, so any clear floor counts
    const half = Math.hypot((p.max[0] - p.min[0]) * s[0], (p.max[2] - p.min[2]) * s[2]) / 2;
    const room = { ...p, min: [p.min[0], -Infinity, p.min[2]], max: [p.max[0], Infinity, p.max[2]] };
    return { x: mid[0], y: mid[1], z: mid[2], reach: Math.max(0.6, half), label, above: ROOM_FLOOR_EPS, below: ROOM_FLOOR_EPS,
      inside: (x, z) => inRegion(e, room, [x, mid[1], z]) };   // at the room's own floor height: a tilted frame turns y into local x/z (bot #463)
  }
  const w = toWorld(e, p.at);
  // a seat's point is where hips rest: aim at the nearest floor below, with a margin (model-scaled, >= 5cm)
  // keeping the seat's own surface out; a stretched seat's half-width is the wider of its two
  if (p.kind === "seat") return { x: w[0], y: w[1] - 0.05 * Math.max(1, s[1]), z: w[2], reach: SEAT_STANDOFF + SEAT_HALF * Math.max(s[0], s[2]), label, above: 0 };
  return { x: w[0], y: w[1], z: w[2], reach: 0.6, label };
}
