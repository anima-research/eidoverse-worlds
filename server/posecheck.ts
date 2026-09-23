// A pose that reaches the wire reaches EVERY client. 2026-09-05 23:13: one NaN
// from a waking stick made a presenter's pos/yaw NaN, and the server relayed
// it — each receiver's lerp then held NaN until its own guard caught it. The
// client guards remain (they fix the cause); this is the fence at the source:
// a non-finite sample is dropped here, never batched into a frame.
const fin = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const finArr = (a: unknown, n: number) => Array.isArray(a) && a.length === n && a.every(fin);

export function sanePose(pose: unknown): Record<string, unknown> | null {
  if (!pose || typeof pose !== "object") return null;
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
  for (const k of ["pose", "pins", "reach"]) if (p[k] != null && !finiteDeep(p[k], 0)) return null;
  return p;
}

const MAX_DEPTH = 6, MAX_KEYS = 512;
function finiteDeep(v: unknown, depth: number): boolean {
  if (typeof v === "number") return Number.isFinite(v);
  if (v === null || typeof v === "string" || typeof v === "boolean") return true;
  if (depth > MAX_DEPTH) return false;
  if (Array.isArray(v)) return v.length <= MAX_KEYS && v.every((x) => finiteDeep(x, depth + 1));
  if (typeof v === "object") { const ks = Object.keys(v as object); return ks.length <= MAX_KEYS && ks.every((k) => finiteDeep((v as Record<string, unknown>)[k], depth + 1)); }
  return false;
}
