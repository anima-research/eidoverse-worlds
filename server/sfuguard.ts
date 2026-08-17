/**
 * Containment for a werift bug that would otherwise crash the world server.
 *
 * werift creates its UDP socket and binds "message" but never "error"
 * (`werift/lib/common/src/transport.js:130-131`; every `on("error")` in the
 * package is on a TCP client). An unhandled `'error'` on a Node EventEmitter
 * throws globally, so when a peer's socket dies and the kernel answers our next
 * send with ICMP port-unreachable, dgram surfaces ECONNREFUSED and takes the
 * process with it. Measured: closing six listeners during active fanout
 * produced EIGHT uncaught exceptions — "someone left a busy room, the world
 * server died". Upstream fix is one line in their transport; worth a PR.
 *
 * ── WHAT ADVERSARIAL REVIEW FOUND WRONG WITH THE FIRST VERSION ──────────────
 *
 * C2 (worst): it matched `err.message` with a REGEX, so any application error
 * whose text merely mentioned an errno was silently eaten. Proven:
 * `TypeError: Cannot read properties of undefined (reading 'ECONNRESET')` was
 * swallowed and the process survived. That is a `catch {}` in disguise, in a
 * codebase with a standing rule against exactly that. Now we match `err.code`
 * — the structured field Node sets on real syscall errors — and require an
 * Error instance. A TypeError has no `.code`, so it can never match.
 *
 * C1: re-throwing inside the handler preserves the crash site on Node but NOT
 * on Bun (measured: unguarded exit 1 pointing at the real bug; guarded exit 7
 * pointing at this file). Since this project runs Bun, a naive re-throw made
 * every real crash anonymous. We now log the original error and its stack
 * ourselves before exiting, so the crash site survives on both runtimes.
 *
 * C3: `unhandledRejection` and `uncaughtException` do not have the same
 * semantics and no longer share a handler.
 */

/** errno CODES a dead/unreachable UDP peer produces. Structured, not textual:
 *  matching message text is how the first version swallowed a TypeError. */
const BENIGN_CODES = new Set(["ECONNREFUSED", "ECONNRESET", "EHOSTUNREACH", "ENETUNREACH", "EPIPE"]);

let installed = false;
let swallowed = 0;

function isBenignTransportError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const code = (err as NodeJS.ErrnoException).code;
  if (typeof code !== "string" || !BENIGN_CODES.has(code)) return false;
  // 🔴 REQUIRE a syscall. `syscall === undefined` was too permissive: an
  // application error carrying a benign code with no syscall got swallowed and
  // the process survived in an unknown state — the same catch{}-in-disguise
  // this file exists to prevent. Demonstrated in review with
  // `Error("fetch failed", code=ECONNREFUSED)`, and there are seven in-process
  // fetch() calls in server/, so it is reachable rather than theoretical.
  // dgram ALWAYS sets syscall, so requiring it costs us nothing.
  const syscall = (err as NodeJS.ErrnoException).syscall;
  return typeof syscall === "string" && /^(recv|send)/.test(syscall);
}

/** Preserve the crash site ourselves. A bare `throw` inside the handler loses
 *  the original stack on Bun, which is worse than not guarding at all. */
function reportFatal(err: unknown, kind: string, onFatal?: (e: unknown, k: string) => void) {
  console.error(`\n[sfu] FATAL (${kind}) — not a benign transport error:`);
  console.error(err instanceof Error && err.stack ? err.stack : err);
  fatals++;
  // The supervisor decides what this means for VOICE. The world server keeps
  // serving text, presence and builds regardless — see the doc above.
  try { onFatal?.(err, kind); } catch { /* a supervisor that throws must not recurse */ }
}
let fatals = 0;
export const transportFatals = () => fatals;

/** 🔴 EXPLICIT, NOT A CONSTRUCTOR SIDE EFFECT (independent review, 2026-08-16).
 *  This was called from the Sfu constructor, so CONSTRUCTING AN SFU silently
 *  replaced process-wide crash semantics for an entire world server that
 *  otherwise installs no such handlers — upstream has none. A voice subsystem
 *  must not decide what happens to unrelated failures.
 *
 *  Now: server.ts calls it once, at boot, with a log line. Same protection,
 *  visible in the place that owns the process.
 *
 *  It also no longer EXITS on a non-transport error. Killing the world server —
 *  text, presence, builds, everyone — because voice hit an unexpected exception
 *  is a bigger outage than the one it prevents. It reports, marks voice
 *  degraded through the supervisor, and lets the process live. */
export function installSfuTransportGuard(onFatal?: (err: unknown, kind: string) => void) {
  if (installed) return;
  installed = true;
  console.log("[sfu] transport guard installed (werift UDP errno swallowing)");

  process.on("uncaughtException", (err) => {
    if (isBenignTransportError(err)) { swallowed++; return; }
    reportFatal(err, "uncaughtException", onFatal);
  });

  // Separate handler: a rejection is not an exception, and the benign case here
  // is narrower — werift's send path can reject with the same errnos.
  process.on("unhandledRejection", (reason) => {
    if (isBenignTransportError(reason)) { swallowed++; return; }
    reportFatal(reason, "unhandledRejection", onFatal);
  });
}

/** Surfaced in /relay-diag: a climbing count is normal churn, but a spike means
 *  peers are dying faster than they should and is worth looking at. */
export function transportErrorsSwallowed() { return swallowed; }

/** Exported for tests — the classifier is the security-relevant half. */
export const __isBenignTransportError = isBenignTransportError;
