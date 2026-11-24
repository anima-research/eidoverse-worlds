// Boot constants: env knobs, directories, cadences and server policy, plus the one side effect (WORLDS_DIR must exist
// before anything touches it). server.ts imports it ahead of every module with boot work, so this runs first.

import { mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { totalmem } from "node:os";
import { envNumber } from "./limits.ts";

export const PORT = envNumber("PORT", 8940, (n) => Number.isInteger(n) && n >= 0 && n <= 65535);   // 0: an ephemeral port, as main read it
/** Default every interface; HOST=127.0.0.1 keeps a test world on this machine only. */
export const HOST = process.env.HOST ?? "0.0.0.0";
// Door policy. Empty = open (a dev box); set it on a public box (the boot log shouts if not). Checked at join and upload.
export const JOIN_TOKEN = process.env.JOIN_TOKEN ?? "";
// The renderers' own credential (docs/decisions/WORLD-ACCESS.md): a renderer presenting it may watch any world, invisibly.
// Distinct from JOIN_TOKEN: that key rides invite links, and "renderer" is a flag any client can set. Unset = none trusted.
export const RENDERER_TOKEN = process.env.RENDERER_TOKEN ?? "";
export const UPLOAD_CAP = envNumber("UPLOAD_CAP_MB", 100, (n) => n >= 0) * 1_000_000;
// narrower than the model door: a hung image is decoded into GPU memory on every client that sees it
export const IMAGE_CAP = envNumber("IMAGE_CAP_MB", 32, (n) => n >= 0) * 1_000_000;
// RECORD_FRAMES=1: stage frames + roster deltas to worlds/<name>/frames-<startTs>.jsonl. Clients are told at join.
export const RECORD = process.env.RECORD_FRAMES === "1";
// SKIP_OPT_SWEEP=1 skips both boot optimize sweeps (encode pump + ktx2/lod).
export const SKIP_OPT_SWEEP = process.env.SKIP_OPT_SWEEP === "1";
// TRUST_NAMES=1: a private server takes a typed name as an account, `local:<name>`. Never set it where strangers can reach:
// anyone typing the owner's name would be the owner.
export const TRUST_NAMES = process.env.TRUST_NAMES === "1";
/** The tightest cgroup v2 memory.max over this process's own cgroup and its parents, or 0 for none. A systemd unit's
 *  MemoryMax= is its own cgroup's file, not the root's; in a container's cgroup namespace the root is the container's. */
export function cgroupMemoryMax(read: (path: string) => string = (path) => readFileSync(path, "utf8")): number {
  let own = "", tightest = 0;
  try { own = /^0::(\/.*)$/m.exec(read("/proc/self/cgroup"))?.[1] ?? ""; } catch { /* no cgroup v2 */ }
  for (let at = own; ; at = at.slice(0, at.lastIndexOf("/"))) {
    try { const m = Number(read(`/sys/fs/cgroup${at === "/" ? "" : at}/memory.max`).trim()); if (m > 0 && (!tightest || m < tightest)) tightest = m; } catch { /* none at this level */ }
    if (at === "" || at === "/") return tightest;
  }
}
// OPT_MEM_BUDGET_MB: each optimize child runs under RLIMIT_DATA of this many MB (Linux only), and an item whose estimated
// cost exceeds it is deferred (a `.deferred` marker). Default: half the usable memory (cgroup limit, else physical). 0 = no cap.
function usableMemory(): number {
  const m = cgroupMemoryMax();
  return m > 0 ? Math.min(m, totalmem()) : totalmem();
}
export const OPT_MEM_BUDGET_MB = envNumber("OPT_MEM_BUDGET_MB", Math.floor(usableMemory() / 2_000_000), (n) => n >= 0);
// Peak RSS of an optimize pass as a multiple of the source bytes (measured 259 MB for a 5.4 MB GLB).
export const OPT_COST_FACTOR = envNumber("OPT_COST_FACTOR", 48, (n) => n > 0);
/** How long the pump waits on one optimize child before killing it (0 = never); read per child. */
export const optChildTimeoutMs = () => envNumber("OPT_CHILD_TIMEOUT_MS", 1_800_000);
// How long the screenshot broker (screenshots.ts) waits for a renderer's frame before GET /snap answers 504, in s. A software
// renderer can need 10-20. At most 225 (Bun.serve's idleTimeout cap less a roamer's journey); deploy/nginx-show.conf gives /snap 300 s.
export const SNAP_TIMEOUT_MS = envNumber("SNAP_TIMEOUT_SEC", 12, (n) => n > 0 && n <= 225) * 1000;
// How long after a start the screenshot broker waits before sweeping parked roamers (screenshots.ts sweep): reconnecting
// renderers need the moment. Tests set 0.
export const SNAP_SWEEP_GRACE_MS = envNumber("SNAP_SWEEP_GRACE_SEC", 30, (n) => n >= 0 && n <= 600) * 1000;
// How often the broker sweeps besides a roamer joining (the backstop for anything else that leaves a world unserved).
export const SNAP_SWEEP_EVERY_MS = envNumber("SNAP_SWEEP_EVERY_SEC", 15, (n) => n >= 1 && n <= 3600) * 1000;
export const ROOT = resolve(import.meta.dir, "..");
// Dev instances point this elsewhere so a scratch sequencer can't append to the live worlds' logs.
export const WORLDS_DIR = resolve(process.env.WORLDS_DIR ?? join(ROOT, "worlds"));
// Where a world's verified copy goes before an in-place upgrade (server/backups.ts): beside WORLDS_DIR, never inside it.
export const BACKUPS_DIR = resolve(process.env.BACKUPS_DIR || join(WORLDS_DIR, "..", "backups"));
// The eidoverse-video checkout = the asset library (models, VRMs, animations).
export const LIBRARY_DIR = resolve(process.env.EIDOVERSE_DIR ?? join(ROOT, "..", "eidoverse-video"));
// As WORLDS_DIR: a dev or test instance points this elsewhere.
export const OPT_DIR = resolve(process.env.OPT_DIR ?? join(ROOT, "assets", "opt"));
try { mkdirSync(OPT_DIR, { recursive: true }); } catch { /* the first write will say why */ }   // the incarnation file lives here
// Asset fixes over the library, versioned in this repo (patched/README.md): /library serves these first.
export const PATCH_DIR = resolve(process.env.PATCH_DIR ?? join(ROOT, "patched"));
// Optimized shadows of store uploads (server/optimize.ts); originals in store/ are never touched. `.failed` markers stop
// retries. The KTX2 shadow lives beside the original (store/<hash>.glb.ktx2.glb, server/store-variants.ts).
export const STORE_MIN = join(OPT_DIR, "store-min");
// The /library precedence ladder: patched fork > upload overlay > the asset library. Every walk of these dirs uses it.
export const LADDER = [PATCH_DIR, OPT_DIR, LIBRARY_DIR];

mkdirSync(WORLDS_DIR, { recursive: true });

/** The fold cache (server/statecache.ts) is rewritten every this many entries; 0 = off. */
export const STATE_CACHE_EVERY = envNumber("STATE_CACHE_EVERY", 1000, (n) => n >= 0);
/** A sim checkpoint once this many entries follow the last (authority checkpointSim, which waits for the sim to rest): a boot replays about this many; 0 = only after launches (cost: simckpt-check PC9). */
export const SIM_CHECKPOINT_EVERY = envNumber("SIM_CHECKPOINT_EVERY", 1000, (n) => n >= 0);
// ---- server policy: the limits a server runner may set, in one place (the WebSocket message cap, EW_WS_MESSAGE_BYTES,
// is in server/limits.ts) ----
/** One person's acts per window, logged entries (Matrix rc_message's shape; shared/protocol/authority/gate.js rateCheck). */
export const ACT_RATE = envNumber("ACT_RATE", 600, (n) => n > 0);
/** One person's says per window, counted apart from acts so chat and building can't starve each other. */
export const SAY_RATE = envNumber("SAY_RATE", 20, (n) => n > 0);
/** The act/say window, in seconds. */
const RATE_WINDOW_SEC = envNumber("RATE_WINDOW_SEC", 10, (n) => n > 0);
/** Bytes one account may make the log hold per window, in KiB. */
const RATE_KIB = envNumber("RATE_KIB", 2048, (n) => n > 0);
/** Bytes one guest (no account) may make the log hold per window, in KiB. */
const ANON_RATE_KIB = envNumber("ANON_RATE_KIB", 32, (n) => n > 0);
/** The act rate as the authority takes it (injected: the authority is shared code, livehost opts.rate). */
export const RATE_POLICY = { n: ACT_RATE, says: SAY_RATE, ms: RATE_WINDOW_SEC * 1000, bytes: RATE_KIB * 1024, anonBytes: ANON_RATE_KIB * 1024 };
// Founding and copying a world: no limits (a copy is one synchronous call; long copies off the shared thread are wishlisted).
/** All messages per client per second: 15 Hz of pose plus verbs plus slack; a token bucket with two seconds of burst (server/msgrate.ts). */
export const MSG_RATE = envNumber("MSG_RATE", 60, (n) => n >= 1);   // at least 1 a second: 0 refuses every message, and under 0.5 the 2 s burst never holds a token

export const FRAME_MS = 66;                 // ~15Hz, matches the client's send throttle
// Bytes of unsent backlog before frames to a client are dropped. Keep tight: proxy and kernel buffers absorb a lot before
// Bun's bufferedAmount rises. 32 KB ≈ half a second of frames.
export const FRAME_SKIP_BUFFERED = 32_000;
