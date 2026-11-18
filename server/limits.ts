// The wire-limit table: what a message may carry before it is refused or truncated, each cap named and
// env-overridable. docs/reference/WIRE.md describes the shapes; this is where their bounds live (config.ts keeps boot/cadence knobs).

/** An env number, VALIDATED: unset or "" is the fallback; not a number, or outside `ok`, is the fallback with a warning
 *  (NaN silently disabled a cap; Number("") is 0). Every env number in server/ reads through it. */
export function envNumber(name: string, fallback: number, ok: (n: number) => boolean = (n) => n >= 0): number {
  const raw = process.env[name]?.trim();
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (Number.isFinite(n) && ok(n)) return n;
  console.warn(`[config] ${name}=${JSON.stringify(raw)} is not valid — using ${fallback}`);
  return fallback;
}
const env = (k: string, d: number) => envNumber(k, d, (n) => Number.isInteger(n) && n >= 0);   // every limit here is a count
/** A world's name at the serving doors (the sequencer, the agent door, the routes): letters, digits, - and _, at most 64. Founding (worldlog.ts FOUND_NAME) and the world CLI (oldworlds.ts NAME) are stricter. */
export const WORLD_NAME_RE = /^[a-z0-9_-]{1,64}$/i;

export const LIMITS = {
  // identity + naming
  ID_LEN: env("EW_ID_LEN", 64),                    // ids, targets, world names
  SURFACE_LEN: env("EW_SURFACE_LEN", 16),          // aux-leg surface names
  AUX_LEGS: env("EW_AUX_LEGS", 4),                 // distinct aux surfaces per identity

  // text payloads
  CAPTION_LEN: env("EW_CAPTION_LEN", 500),
  BAN_REASON_LEN: env("EW_BAN_REASON_LEN", 200),

  // binary-ish payloads
  ANIM_TRACKS_BYTES: env("EW_ANIM_TRACKS_BYTES", 64_000),
  BODYDRAG_POSE_BYTES: env("EW_BODYDRAG_POSE_BYTES", 24_000),

  // paging + rings
  PAGE_MAX: env("EW_PAGE_MAX", 300),               // history/debug page ceiling
  PAGE_DEFAULT: env("EW_PAGE_DEFAULT", 50),
  BC_RING: env("EW_BC_RING", 40),                  // crash breadcrumbs kept

  // one websocket message, whole: past it the socket closes (Bun's default is 16 MB). A 1 MiB log line (the door's cap) fits with its envelope.
  WS_MESSAGE_BYTES: env("EW_WS_MESSAGE_BYTES", 2 * 1024 * 1024),

  // receipts
  ATTEST_FRESH_MS: env("EW_ATTEST_FRESH_MS", 300_000),
} as const;
