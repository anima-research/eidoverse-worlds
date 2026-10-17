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
//        comp {id, type: "places", data: {
//          balcony:  {at: [0, 3.15, 2.9], label: "the balcony"},
//          upstairs: {min: [-2.2, 3.15, -2.2], max: [2.2, 5.8, 2.2], label: "the lookout room"},
//          porch_bench: null,          // hides a place the model declares
//        }}
//
//      `at` is a point to stand at (its y the floor there); `min`/`max` a
//      region (a room: its min y is its floor). Either may carry `label`.
//
// Pure: callers hand in entities and their model metadata.

export type Vec3 = [number, number, number];
export type Place = {
  name: string;
  label?: string;
  kind: "point" | "region" | "door" | "seat";
  at?: Vec3;                 // point, door, seat
  min?: Vec3; max?: Vec3;    // region
  source: "model" | "component";
};
export type PlaceHolder = { id: string; pos: number[]; yaw?: number; scale?: number };

const finite3 = (v: unknown): v is Vec3 => Array.isArray(v) && v.length === 3 && v.every((n) => typeof n === "number" && Number.isFinite(n));
const NAME = /^[A-Za-z0-9_][A-Za-z0-9_ .:'-]{0,47}$/;

/** Defaults from a model's `building` description (glTF extras). */
export function placesFromModel(meta: any): Map<string, Place> {
  const out = new Map<string, Place>();
  if (!meta || typeof meta !== "object") return out;
  const add = (p: Place) => { if (NAME.test(p.name) && !out.has(p.name)) out.set(p.name, p); };
  for (const r of Array.isArray(meta.rooms) ? meta.rooms : []) {
    if (typeof r?.id !== "string" || !finite3(r.min) || !finite3(r.max)) continue;
    const min: Vec3 = [Math.min(r.min[0], r.max[0]), Math.min(r.min[1], r.max[1]), Math.min(r.min[2], r.max[2])];
    const max: Vec3 = [Math.max(r.min[0], r.max[0]), Math.max(r.min[1], r.max[1]), Math.max(r.min[2], r.max[2])];
    // a room's floor is its own min y; a declared level/floor wins when given
    const floor = typeof r.level === "string" && Array.isArray(meta.levels)
      ? meta.levels.find((l: any) => l?.id === r.level)?.floor : undefined;
    if (Number.isFinite(floor)) min[1] = floor;
    add({ name: r.id, label: typeof r.name === "string" ? r.name : undefined, kind: "region", min, max, source: "model" });
  }
  for (const p of Array.isArray(meta.portals) ? meta.portals : []) {
    if (typeof p?.id !== "string" || !finite3(p.center)) continue;
    add({ name: p.id, kind: "door", at: p.center, label: p.id.replace(/_/g, " "), source: "model" });
  }
  for (const s of Array.isArray(meta.seats) ? meta.seats : []) {
    if (typeof s?.id !== "string" || !finite3(s.pos)) continue;
    add({ name: s.id, kind: "seat", at: s.pos, label: s.id.replace(/_/g, " "), source: "model" });
  }
  for (const a of Array.isArray(meta.arrivals) ? meta.arrivals : []) {
    if (typeof a?.id !== "string" || !finite3(a.pos)) continue;
    add({ name: a.id === "outside" ? "entrance" : `arrive_${a.id}`, kind: "point", at: a.pos, source: "model" });
  }
  return out;
}

/** Normalize a `places` component; malformed entries are dropped (they still
 *  fold and persist — the bag is blind — they just name nothing). */
export function placesFromComponent(data: unknown): Map<string, Place | null> {
  const out = new Map<string, Place | null>();
  if (!data || typeof data !== "object" || Array.isArray(data)) return out;
  for (const [name, v] of Object.entries(data as Record<string, any>)) {
    if (!NAME.test(name)) continue;
    if (v === null) { out.set(name, null); continue; }
    const label = typeof v?.label === "string" ? v.label.slice(0, 80) : undefined;
    if (finite3(v?.at)) out.set(name, { name, label, kind: v.kind === "seat" || v.kind === "door" ? v.kind : "point", at: v.at, source: "component" });
    else if (finite3(v?.min) && finite3(v?.max)) {
      const min: Vec3 = [0, 1, 2].map((k) => Math.min(v.min[k], v.max[k])) as Vec3;
      const max: Vec3 = [0, 1, 2].map((k) => Math.max(v.min[k], v.max[k])) as Vec3;
      out.set(name, { name, label, kind: "region", min, max, source: "component" });
    }
  }
  return out;
}

/** An entity's places: the model's defaults, then its component on top. */
export function placesOf(meta: any, comp: unknown): Place[] {
  const all = placesFromModel(meta);
  for (const [name, p] of placesFromComponent(comp)) {
    if (p === null) all.delete(name); else all.set(name, p);
  }
  return [...all.values()];
}

/** Model frame → world (the inverse of shared/structure.js localizePoint). */
export function toWorld(e: PlaceHolder, p: number[]): Vec3 {
  const [px, py, pz] = e.pos, yaw = e.yaw ?? 0, s = e.scale && e.scale > 0 ? e.scale : 1;
  const c = Math.cos(yaw), n = Math.sin(yaw);
  return [px + s * (p[0] * c + p[2] * n), py + s * p[1], pz + s * (-p[0] * n + p[2] * c)];
}
export function toLocal(e: PlaceHolder, w: number[]): Vec3 {
  const [px, py, pz] = e.pos, yaw = e.yaw ?? 0, s = e.scale && e.scale > 0 ? e.scale : 1;
  const dx = w[0] - px, dz = w[2] - pz, c = Math.cos(yaw), n = Math.sin(yaw);
  return [(dx * c - dz * n) / s, (w[1] - py) / s, (dx * n + dz * c) / s];
}

/** Is a body standing at world point `w` inside this region? Its feet must be
 *  on or above the region's floor (a hand's width of slack) and below its top. */
export function inRegion(e: PlaceHolder, p: Place, w: number[]): boolean {
  if (p.kind !== "region" || !p.min || !p.max) return false;
  const l = toLocal(e, w), s = e.scale && e.scale > 0 ? e.scale : 1, slack = 0.1 / s;
  return l[0] >= p.min[0] && l[0] <= p.max[0] && l[2] >= p.min[2] && l[2] <= p.max[2]
    && l[1] >= p.min[1] - slack && l[1] < p.max[1];
}

const norm = (s: string) => s.trim().toLowerCase().replace(/^the\s+/, "").replace(/[\s_-]+/g, " ");

/** Does `query` name this place? By its name, or by its label, loosely
 *  ("the reading room", "reading_room" and "Reading Room" all do). */
export function names(p: Place, query: string): boolean {
  const q = norm(query);
  return norm(p.name) === q || (p.label != null && norm(p.label) === q);
}

/** A destination a walk can aim for: a world point, the floor height to
 *  arrive on, and how far from the point a place to stand may be. */
export type Destination = { x: number; y: number; z: number; reach: number; label: string;
  /** how far above y the floor may be: a room's floor height is exact */
  above?: number;
  /** how far below y it may be (unbounded when absent) */
  below?: number;
  /** a region: only places to stand inside it count, anywhere in it */
  inside?: (x: number, z: number) => boolean };

/** How far a named room's walkable floor may sit from its declared height —
 *  in world metres, the walking body's tolerance: the body does not scale
 *  with the thing, so neither does this. */
export const ROOM_FLOOR_EPS = 0.1;
/** A seat is reached from beside it: the body's own standoff (world metres)
 *  plus the seat's half-width, which IS the model's and scales with it. */
export const SEAT_STANDOFF = 0.7, SEAT_HALF = 0.3;

/** Where to walk to reach a place. A region: anywhere on its floor, the
 *  middle preferred. A seat: the floor beside it (not the seat's own surface
 *  — the body sits by mounting it), the nearest floor below the seat. A door
 *  or point: there. */
export function destinationOf(e: PlaceHolder, p: Place): Destination {
  const s = e.scale && e.scale > 0 ? e.scale : 1;
  const label = `${e.id}/${p.name}${p.label ? ` (${p.label})` : ""}`;
  if (p.kind === "region") {
    const mid = toWorld(e, [(p.min![0] + p.max![0]) / 2, p.min![1], (p.min![2] + p.max![2]) / 2]);
    // reach covers the whole room (its half-diagonal); `inside` keeps the
    // search to the room itself — a long or furnished room is reached at
    // whatever clear floor it has, not only round its middle
    const half = Math.hypot(p.max![0] - p.min![0], p.max![2] - p.min![2]) * s / 2;
    const room = { ...p, min: [p.min![0], -Infinity, p.min![2]] as Vec3, max: [p.max![0], Infinity, p.max![2]] as Vec3 };
    return { x: mid[0], y: mid[1], z: mid[2], reach: Math.max(0.6, half), label, above: ROOM_FLOOR_EPS, below: ROOM_FLOOR_EPS,
      inside: (x, z) => inRegion(e, room, [x, 0, z]) };
  }
  const w = toWorld(e, p.at!);
  // a seat's point is where hips rest, at or a little above the seat's
  // surface: the floor beside it is the nearest one below. The margin that
  // keeps the seat's own surface out is the model's (an authoring error grows
  // with the thing; never less than 5cm) — it only looks below the seat, so
  // it can't pick another storey over the floor beside it.
  if (p.kind === "seat") return { x: w[0], y: w[1] - 0.05 * Math.max(1, s), z: w[2], reach: SEAT_STANDOFF + SEAT_HALF * s, label, above: 0 };
  return { x: w[0], y: w[1], z: w[2], reach: 0.6, label };
}
