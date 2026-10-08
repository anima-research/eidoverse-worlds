// A pose that reaches the wire reaches EVERY client. 2026-09-05 23:13: one NaN
// from a waking stick made a presenter's pos/yaw NaN, and the server relayed
// it — each receiver's lerp then held NaN until its own guard caught it. The
// client guards remain (they fix the cause); this is the fence at the source:
// a non-finite sample is dropped here, never batched into a frame.
import { clampBodyScale, clampPlateY } from "../shared/presencewire.js";

const fin = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const finArr = (a: unknown, n: number) => Array.isArray(a) && a.length === n && a.every(fin);

/** The most a pose may weigh, serialized: every receiver gets it each frame, every joiner gets it in `present`, and it
 *  is remembered on disk (security review 10-06 pass 2, M-A: nothing bounded it, and the socket took 16 MB). A whole
 *  held pose of every bone, two hands' reaches and pins is a few kilobytes. */
export const POSE_MAX_BYTES = 32_000;
const STR_MAX = 256;

export function sanePose(pose: unknown): Record<string, unknown> | null {
  if (!pose || typeof pose !== "object" || Array.isArray(pose)) return null;
  const p = pose as Record<string, unknown>;
  if (!finArr(p.p, 3)) return null;
  for (const k of ["yaw", "pitch", "speed"]) if (p[k] !== undefined && !fin(p[k])) return null;
  if (p.xr !== undefined) {                       // C18: tracked head/hands (client/lib/xrbody.js)
    const x = p.xr as Record<string, unknown> | null;
    if (!x || typeof x !== "object" || !finArr(x.h, 4)) return null;
    if (x.l !== undefined && !finArr(x.l, 7)) return null;
    if (x.r !== undefined && !finArr(x.r, 7)) return null;
    if (x.c !== undefined && !finArr(x.c, 4)) return null;
  }
  // held pose (bone quats), body pins and reach descriptors ride the same packet and are lerped by
  // every receiver — a NaN anywhere inside them is the same fault. Deep finite-check, bounded depth.
  for (const k of ["pose", "pins", "reach", "seat"]) if (p[k] != null && !finiteDeep(p[k], 0)) return null;   // seat: its input signals (seat.in) are numbers every receiver blends by
  // use: what a holder is pressing while they hold a thing ({id, hand}: grabbable's presence tier; every receiver draws
  // the thing's own fx while it rides). Strings only: anything else costs the field, never the whole pose
  if ("use" in p && !(p.use && typeof p.use === "object" && !Array.isArray(p.use) && typeof (p.use as Record<string, unknown>).id === "string" && Object.keys(p.use as object).every((k) => k === "id" || (k === "hand" && ["left", "right"].includes(String((p.use as Record<string, unknown>).hand)))))) delete p.use;
  // voice and body fields are normalised here, not refused: a bad one costs its field, never the whole pose (the
  // receivers clamp too, but lastPose is remembered for joiners). Absent = unknown / default, so garbage is deleted.
  for (const k of ["mic", "hear"]) if (k in p && typeof p[k] !== "boolean") delete p[k];
  // a sample's capture time (authority clock, ms) and its sender's count (spec/PHYSICS.md §5.1): bad ones cost the field
  if ("t" in p && !fin(p.t)) delete p.t;
  if ("seq" in p && !(Number.isInteger(p.seq) && (p.seq as number) >= 0 && (p.seq as number) <= Number.MAX_SAFE_INTEGER)) delete p.seq;
  if ("scale" in p) { if (fin(p.scale)) p.scale = clampBodyScale(p.scale); else delete p.scale; }
  if ("plateY" in p) { if (fin(p.plateY)) p.plateY = clampPlateY(p.plateY); else delete p.plateY; }
  for (const [k, v] of Object.entries(p)) if (typeof v === "string" && v.length > STR_MAX) delete p[k];
  let size = Infinity; try { size = JSON.stringify(p).length; } catch { /* cyclic: impossible off the wire */ }
  return size <= POSE_MAX_BYTES ? p : null;
}

const MAX_DEPTH = 6, MAX_KEYS = 512;
function finiteDeep(v: unknown, depth: number): boolean {
  if (typeof v === "number") return Number.isFinite(v);
  if (v === null || typeof v === "boolean") return true;
  if (typeof v === "string") return v.length <= STR_MAX;
  if (depth > MAX_DEPTH) return false;
  if (Array.isArray(v)) return v.length <= MAX_KEYS && v.every((x) => finiteDeep(x, depth + 1));
  if (typeof v === "object") { const ks = Object.keys(v as object); return ks.length <= MAX_KEYS && ks.every((k) => finiteDeep((v as Record<string, unknown>)[k], depth + 1)); }
  return false;
}
