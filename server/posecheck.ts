// The fence at the source: a pose reaches every client, so a non-finite sample is dropped here (one NaN would sit in every receiver's lerp).
import { clampBodyScale, clampPlateY } from "../shared/presencewire.js";
import { cleanPoses } from "../shared/wingpresence.js";
import { isBodyMode } from "../shared/bodymode.js";
import { climbWire } from "../shared/climb.js";

const fin = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const finArr = (a: unknown, n: number) => Array.isArray(a) && a.length === n && a.every(fin);

/** The most a pose may weigh, serialized (every receiver gets it each frame); a full held pose with reaches and pins is a few KB. */
export const POSE_MAX_BYTES = 32_000;
const STR_MAX = 256;

export function sanePose(pose: unknown): Record<string, unknown> | null {
  if (!pose || typeof pose !== "object" || Array.isArray(pose)) return null;
  const p = pose as Record<string, unknown>;
  if (!finArr(p.p, 3)) return null;
  for (const k of ["yaw", "pitch", "speed"]) if (p[k] !== undefined && !fin(p[k])) return null;
  // optional orientation and locomotion metadata: client-owned presence, never movement authority
  if (p.q !== undefined) {
    if (!finArr(p.q, 4)) return null;
    const length2 = (p.q as number[]).reduce((sum, n) => sum + n * n, 0);
    if (Math.abs(length2 - 1) > 0.02) return null;
  }
  if (p.locomotion !== undefined) {
    const l = p.locomotion as Record<string, unknown> | null;
    if (!l || typeof l !== 'object' || Array.isArray(l) || !finiteDeep(l, 0)) return null;
    for (const k of ['mode', 'body', 'medium'])
      if (l[k] !== undefined && (typeof l[k] !== 'string' || (l[k] as string).length > 32)) return null;
  }
  if (p.xr !== undefined) {                       // C18: tracked head/hands (client/lib/xr/xrbody.js)
    const x = p.xr as Record<string, unknown> | null;
    if (!x || typeof x !== "object" || !finArr(x.h, 4)) return null;
    if (x.l !== undefined && !finArr(x.l, 7)) return null;
    if (x.r !== undefined && !finArr(x.r, 7)) return null;
    if (x.c !== undefined && !finArr(x.c, 4)) return null;
  }
  // held pose, pins, reach and seat are lerped by every receiver: deep finite-check, bounded depth
  for (const k of ["pose", "pins", "reach", "seat"]) if (p[k] != null && !finiteDeep(p[k], 0)) return null;
  // use: {id, hand} of a held thing being used; a bad one costs the field, never the whole pose
  if ("use" in p && !(p.use && typeof p.use === "object" && !Array.isArray(p.use) && typeof (p.use as Record<string, unknown>).id === "string" && Object.keys(p.use as object).every((k) => k === "id" || (k === "hand" && ["left", "right"].includes(String((p.use as Record<string, unknown>).hand)))))) delete p.use;
  // the remaining fields are normalised, not refused: a bad one is deleted (absent = default)
  for (const k of ["mic", "hear"]) if (k in p && typeof p[k] !== "boolean") delete p[k];
  // poses: the named poses a body holds; the older boolean wingsFolded is still relayed for older receivers
  if ("poses" in p) { const c = cleanPoses(p.poses); if (c) p.poses = c; else delete p.poses; }
  if ("wingsFolded" in p && typeof p.wingsFolded !== "boolean") delete p.wingsFolded;
  if ("bodyMode" in p && !isBodyMode(p.bodyMode)) delete p.bodyMode;
  if ("climb" in p) { const c = climbWire(p.climb); if (c) p.climb = c; else delete p.climb; }
  // t: capture time on the authority clock; seq: the sender's count (spec/PHYSICS.md §5.1)
  if ("t" in p && !fin(p.t)) delete p.t;
  if ("seq" in p && !(Number.isInteger(p.seq) && (p.seq as number) >= 0 && (p.seq as number) <= Number.MAX_SAFE_INTEGER)) delete p.seq;
  if ("scale" in p) { if (fin(p.scale)) p.scale = clampBodyScale(p.scale); else delete p.scale; }
  if ("plateY" in p) { if (fin(p.plateY)) p.plateY = clampPlateY(p.plateY); else delete p.plateY; }
  // while lying limp: the floor under the body (client/lib/getup.js) — settledPose stands it there
  if ("floor" in p && !fin(p.floor)) delete p.floor;
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
