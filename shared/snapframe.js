// Optional framing for a world snapshot, one normaliser for its three readers: GET /snap's query (server/routes.ts),
// the `snap` wire message's `frame` (client/lib/render/net_capture.js) and the agent `snapshot` tool (mcpl/tools.ts).
// An absent field means the default framing.
//   dist   — third/selfie: metres from camera to body, measured flat (third behind, selfie in front)  [0.5, 30]
//   height — third/selfie: camera height above the body's feet                                       [0, 30]
//   pitch  — first: gaze tilt in degrees, + up, − down (default about −4.3°)                         [-85, 85]

export const SNAP_DIST = [0.5, 30];
export const SNAP_HEIGHT = [0, 30];
export const SNAP_PITCH = [-85, 85];

const clamp = (v, [lo, hi]) => Math.min(hi, Math.max(lo, v));
// Only finite numbers and non-blank numeric strings (query values) count; booleans/arrays/objects are dropped before
// conversion (Number(false) is 0, which would put the camera at foot height).
const num = (v) => {
  if (typeof v !== 'number' && typeof v !== 'string') return undefined;
  if (typeof v === 'string' && v.trim() === '') return undefined;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : undefined;
};

/** @returns {{dist?: number, height?: number, pitch?: number}} only the fields
 *  that were given as finite numbers, each clamped to its range. */
export function normalizeSnapFrame(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  const d = num(raw.dist), h = num(raw.height), p = num(raw.pitch);
  if (d !== undefined) out.dist = clamp(d, SNAP_DIST);
  if (h !== undefined) out.height = clamp(h, SNAP_HEIGHT);
  if (p !== undefined) out.pitch = clamp(p, SNAP_PITCH);
  return out;
}
