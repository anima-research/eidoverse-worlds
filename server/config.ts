// eidoverse-worlds sequencer — boot constants (TEL0S_NOTES §15, step 7a).
// Env knobs, directories, and cadences, plus the one directory side effect
// (WORLDS_DIR must exist before anything touches it). This module is
// server.ts's FIRST import, so everything here runs before any other
// module's boot work — the same order the constants had inline.

import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

export const PORT = Number(process.env.PORT ?? 8940);
// Show-night door policy. Empty = open (dev on a tailnet). On a public box you
// MUST set this — the boot log shouts if you forgot. Checked at join and upload.
export const JOIN_TOKEN = process.env.JOIN_TOKEN ?? "";
export const UPLOAD_CAP = Number(process.env.UPLOAD_CAP_MB ?? 20) * 1_000_000;
// RECORD_FRAMES=1 appends every broadcast stage frame (plus roster deltas) to
// worlds/<name>/frames-<bootTs>.jsonl. World log + frames file + asset store =
// enough to re-render the whole performance offline, at production quality,
// forever. Clients are told at join — recording is never invisible.
export const RECORD = process.env.RECORD_FRAMES === "1";
export const ROOT = resolve(import.meta.dir, "..");
// Dev instances point this elsewhere so a scratch sequencer can't append to the
// live worlds' logs (they are append-only and forever — a stray dev spawn is
// permanent). Default keeps the production path unchanged.
export const WORLDS_DIR = resolve(process.env.WORLDS_DIR ?? join(ROOT, "worlds"));
// The eidoverse-video checkout = the asset library (models, VRMs, animations).
export const LIBRARY_DIR = resolve(process.env.EIDOVERSE_DIR ?? join(ROOT, "..", "eidoverse-video"));
export const OPT_DIR = join(ROOT, "assets", "opt");
// Deliberate forks of upstream library files (versioned IN this repo —
// upstream-patched/README.md carries the doctrine): /library serves these
// with TOP precedence, so every machine gets the standing-permission
// upstream redos via ordinary git pull while eidoverse-video stays pristine.
export const PATCH_DIR = join(ROOT, "upstream-patched");
// Optimized shadows of store uploads (draco+webp@1024, see server/optimize.ts).
// Originals in store/ are never touched; /library serving prefers a store-min
// sibling when one exists. `.failed` markers stop hopeless files from being
// retried every boot. The KTX2 shadow (the ?ktx2=<key> answer, shared/ktx2.js) lives beside the
// original instead — store/<hash>.glb.ktx2.glb, the library's <rel>.ktx2.glb
// convention (server/store-variants.ts).
export const STORE_MIN = join(OPT_DIR, "store-min");

mkdirSync(WORLDS_DIR, { recursive: true });

/** How many entries may accumulate past a snapshot before folding again.
 *  Small enough that a joiner's tail stays trivial, large enough that a busy
 *  world is not writing a snapshot per action. */
export const FOLD_EVERY = Number(process.env.FOLD_EVERY ?? 150);
/** Authored verbs allowed per client per 4s. A griefer gets silence; a person
 *  arranging furniture must not. Configurable because a build session and a
 *  show night want different answers. */
export const VERB_RATE = Number(process.env.VERB_RATE ?? 12);
/** All messages per client per second — 15Hz of pose plus verbs plus slack. */
export const MSG_RATE = Number(process.env.MSG_RATE ?? 60);

export const FRAME_MS = 66;                 // ~15Hz, matches the client's send throttle
// Bytes of unsent backlog before we drop frames to a client. Keep TIGHT: with
// nginx fronting, its buffers + the kernel's absorb a lot before Bun's
// bufferedAmount rises at all (measured 2026-07-26: 33s of latency built up
// without ever tripping a 256KB threshold). 32KB ≈ half a second of frames —
// a slow client skips to current instead of drifting behind the show.
export const FRAME_SKIP_BUFFERED = 32_000;
