// eidoverse-worlds sequencer — boot constants (TEL0S_NOTES §15, step 7a).
// Env knobs, directories, and cadences, plus the one directory side effect
// (WORLDS_DIR must exist before anything touches it). This module is
// server.ts's FIRST import, so everything here runs before any other
// module's boot work — the same order the constants had inline.

import { mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { totalmem } from "node:os";

export const PORT = Number(process.env.PORT ?? 8940);
// Show-night door policy. Empty = open (dev on a tailnet). On a public box you
// MUST set this — the boot log shouts if you forgot. Checked at join and upload.
export const JOIN_TOKEN = process.env.JOIN_TOKEN ?? "";
// The RENDERERS' own credential (docs/DESIGN-world-access.md). A renderer is the
// vision of the agents in a world — snapshots are how they see — so a renderer
// presenting this may WATCH any world, members-only ones included (invisible,
// never authoring, as every renderer). Distinct from JOIN_TOKEN on purpose: the
// door key rides invite links, and "renderer" is a flag any client can set, so
// the door key + the flag must never be a key to a private world. Unset = no
// renderer is trusted beyond what the world allows everyone.
export const RENDERER_TOKEN = process.env.RENDERER_TOKEN ?? "";
export const UPLOAD_CAP = Number(process.env.UPLOAD_CAP_MB ?? 20) * 1_000_000;
// Pictures are textures, not models: a hung image is decoded into GPU memory
// on every client that sees it, so the door is narrower than the model door.
export const IMAGE_CAP = Number(process.env.IMAGE_CAP_MB ?? 8) * 1_000_000;
// RECORD_FRAMES=1 appends every broadcast stage frame (plus roster deltas) to
// worlds/<name>/frames-<bootTs>.jsonl. World log + frames file + asset store =
// enough to re-render the whole performance offline, at production quality,
// forever. Clients are told at join — recording is never invisible.
export const RECORD = process.env.RECORD_FRAMES === "1";
// SKIP_OPT_SWEEP=1 skips both boot optimize sweeps (encode pump + ktx2/lod);
// serving worlds must be startable without shouldering the optimizer.
export const SKIP_OPT_SWEEP = process.env.SKIP_OPT_SWEEP === "1";
// OPT_MEM_BUDGET_MB bounds the optimizer so serving a world never competes
// with encoding one: each optimize child runs under RLIMIT_DATA of this
// many MB (Linux only — XNU accepts the limit and ignores it), and an item
// whose ESTIMATED cost exceeds it is deferred (a `.deferred` marker beside
// the would-be variant, a count in /version for this boot) rather than
// attempted — a bigger host does it later; the small one still optimizes
// everything that fits. Default: half of the memory this process can
// actually use — the cgroup limit when there is one (a 1GB container on a
// 64GB box must not budget 32GB), else physical memory. 0 = no cap, no gate.
function usableMemory(): number {
  try { const m = Number(readFileSync("/sys/fs/cgroup/memory.max", "utf8").trim()); if (m > 0) return Math.min(m, totalmem()); } catch { /* no cgroup v2 */ }
  return totalmem();
}
// Env values are VALIDATED: a budget that is not a finite number >= 0 ("banana", -1) falls back to the default
// with a warning — NaN used to disable the cap silently and serialise as null; a negative one deferred everything.
function envNumber(name: string, fallback: number, ok: (n: number) => boolean): number {
  const raw = process.env[name]?.trim();   // " " is not a number either — Number(" ") is 0
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (Number.isFinite(n) && ok(n)) return n;
  console.warn(`[config] ${name}=${JSON.stringify(raw)} is not valid — using ${fallback}`);
  return fallback;
}
export const OPT_MEM_BUDGET_MB = envNumber("OPT_MEM_BUDGET_MB", Math.floor(usableMemory() / 2_000_000), (n) => n >= 0);
// Peak RSS of an optimize pass as a multiple of the source bytes, for the
// estimate above: measured 259MB for a 5.4MB store GLB (x48). The KTX2/LOD
// arms were not measured separately and are assumed the same order.
export const OPT_COST_FACTOR = envNumber("OPT_COST_FACTOR", 48, (n) => n > 0);
// How long the snapshot broker (snapshots.ts) waits for a renderer's frame
// before GET /snap answers 504. 12s suits a GPU renderer; a software-rendered
// one (SwiftShader, --disable-gpu) running a full world can need 10-20s per
// frame, and loses most races at 12. A summoned roamer first travels (up to
// 25s) and then has at least 40s for its first frame, so the broker's longest
// wait is 25s plus the larger of 40s and this window. /snap sends nothing while
// it waits, and GET /snap sets its own per-request timeout a little past that
// longest wait (5s), capped at 255s, the largest idleTimeout Bun.serve
// accepts. So the most this window can be is 225 (255, less the 25s journey
// and the 5s): a larger value is refused like any other invalid one, and 12 is
// used with a warning. A proxy in front must allow the same longest wait.
// Behind deploy/nginx-show.conf, `location /` sets no proxy_read_timeout, so
// nginx's 60s default cuts any /snap that waits past 60s, which a roamed one
// can at the defaults (25s + 40s), and any one can once SNAP_TIMEOUT_SEC is
// above 60.
export const SNAP_TIMEOUT_MS = envNumber("SNAP_TIMEOUT_SEC", 12, (n) => n > 0 && n <= 225) * 1000;
export const ROOT = resolve(import.meta.dir, "..");
// Dev instances point this elsewhere so a scratch sequencer can't append to the
// live worlds' logs (they are append-only and forever — a stray dev spawn is
// permanent). Default keeps the production path unchanged.
export const WORLDS_DIR = resolve(process.env.WORLDS_DIR ?? join(ROOT, "worlds"));
// The eidoverse-video checkout = the asset library (models, VRMs, animations).
export const LIBRARY_DIR = resolve(process.env.EIDOVERSE_DIR ?? join(ROOT, "..", "eidoverse-video"));
// Same doctrine as WORLDS_DIR: a dev or test instance points this elsewhere so it can never write derived
// variants or markers into the live store (a harness once did — review of #172).
export const OPT_DIR = resolve(process.env.OPT_DIR ?? join(ROOT, "assets", "opt"));
try { mkdirSync(OPT_DIR, { recursive: true }); } catch { /* the first write will say why */ }   // an overridden OPT_DIR may not exist yet; the incarnation file lives here
// Deliberate ASSET fixes over the library (versioned IN this repo —
// patched/README.md carries the doctrine): /library serves these with TOP
// precedence, so every machine gets the fix via ordinary git pull while
// eidoverse-video stays pristine. §24j: this is the successor of
// upstream-patched/, which also carried ENGINE-code overrides — those
// retired with the braid (video is an asset library now); the grass engine
// lives in client/lib/vegetation/ as first-class client code. Only assets
// belong here, and each one is a candidate for upstreaming to the library.
// A test instance points it elsewhere, as it does WORLDS_DIR and OPT_DIR.
export const PATCH_DIR = resolve(process.env.PATCH_DIR ?? join(ROOT, "patched"));
// Optimized shadows of store uploads (draco+webp@1024, see server/optimize.ts).
// Originals in store/ are never touched; /library serving prefers a store-min
// sibling when one exists. `.failed` markers stop hopeless files from being
// retried every boot. The KTX2 shadow (the ?ktx2=<key> answer, shared/ktx2.js) lives beside the
// original instead — store/<hash>.glb.ktx2.glb, the library's <rel>.ktx2.glb
// convention (server/store-variants.ts).
export const STORE_MIN = join(OPT_DIR, "store-min");
// The /library precedence ladder, NAMED (R2): patched fork > upload overlay
// > the asset library. Every walk of these three dirs should spell it this
// way — seats.ts documents what a wrong-order copy costs.
export const LADDER = [PATCH_DIR, OPT_DIR, LIBRARY_DIR];

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
