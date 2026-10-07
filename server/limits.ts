// eidoverse-worlds sequencer — the wire-limit table (R2, survey §1.1).
//
// "What does this server accept" used to be answerable only by reading 900
// lines of ws switch: every cap below lived as a bare literal inside its
// case, unnamed and un-overridable. One table now, env-overridable with the
// same idiom mcpl/denoise.ts established — the values are unchanged, the
// names are new. config.ts keeps the boot/cadence knobs; this file is the
// PROTOCOL surface: what a message may carry before it is refused or
// truncated. WIRE.md describes the shapes; this is where their bounds live.

const env = (k: string, d: number) => {
  const v = Number(process.env[k]);
  return Number.isFinite(v) ? v : d;
};

export const LIMITS = {
  // identity + naming
  ID_LEN: env("EW_ID_LEN", 64),                    // ids, targets, world names
  SURFACE_LEN: env("EW_SURFACE_LEN", 16),          // aux-leg surface names
  AUX_LEGS: env("EW_AUX_LEGS", 4),                 // distinct aux surfaces per identity

  // text payloads
  WHISPER_LEN: env("EW_WHISPER_LEN", 4000),
  CAPTION_LEN: env("EW_CAPTION_LEN", 500),
  BAN_REASON_LEN: env("EW_BAN_REASON_LEN", 200),

  // binary-ish payloads
  ANIM_TRACKS_BYTES: env("EW_ANIM_TRACKS_BYTES", 64_000),
  BODYDRAG_POSE_BYTES: env("EW_BODYDRAG_POSE_BYTES", 24_000),
  RTC_PAYLOAD_BYTES: env("EW_RTC_PAYLOAD_BYTES", 20_000),   // SDP-sized, not file-sized

  // paging + rings
  PAGE_MAX: env("EW_PAGE_MAX", 300),               // history/debug page ceiling
  PAGE_DEFAULT: env("EW_PAGE_DEFAULT", 50),
  BC_RING: env("EW_BC_RING", 40),                  // crash breadcrumbs kept
  WHISPER_HOLD: env("EW_WHISPER_HOLD", 20),        // held whispers per absent recipient

  // one websocket message, whole: past it the socket closes (Bun's default was 16 MB; security review 10-06 pass 2,
  // M-A). The door's own cap on one log line is 1 MiB; a request that writes one fits with room for its envelope.
  WS_MESSAGE_BYTES: env("EW_WS_MESSAGE_BYTES", 2 * 1024 * 1024),

  // receipts
  ATTEST_FRESH_MS: env("EW_ATTEST_FRESH_MS", 300_000),
} as const;
