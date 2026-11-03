/**
 * Containment for a werift bug that would otherwise crash the world server —
 * scoped, as of v3, to the sockets werift actually owns.
 *
 * werift creates its UDP socket and binds "message" but never "error"
 * (`werift/lib/common/src/transport.js:130-131` in the CJS tree; the shipped
 * ESM bundle mirrors it — every `on("error")` in the package is on a TCP
 * client). An unhandled `'error'` on a Node EventEmitter throws globally, so
 * when a peer's socket dies and the kernel answers our next send with ICMP
 * port-unreachable, dgram surfaces ECONNREFUSED and takes the process with it.
 * Measured: closing six listeners during active fanout produced EIGHT uncaught
 * exceptions — "someone left a busy room, the world server died". Upstream fix
 * is one line in their transport; worth a PR.
 *
 * ── WHAT REVIEW FOUND WRONG WITH EACH PRIOR VERSION ─────────────────────────
 *
 * v1 (adversarial review): matched `err.message` with a REGEX, so any
 * application error whose text merely mentioned an errno was silently eaten —
 * a `catch {}` in disguise. v2 matched the structured `err.code` + a send/recv
 * `syscall`, and required an Error instance.
 *
 * v2 (#130 round 2, antra): still PROCESS-GLOBAL catch-by-shape. Its own
 * positive test proved the gap — it swallowed a standalone Node dgram
 * ECONNREFUSED with no werift ownership involved. Any other present or future
 * UDP subsystem in the sequencer could lose a real uncaught send/recv fault
 * merely because it shares the same structured fields. Shape is not ownership.
 *
 * v3 (this file): containment moves to the OWNERSHIP SEAM. Every raw UDP
 * socket werift creates flows through its exported `UdpTransport.init` (the
 * STUN and TURN protocol layers both construct through it; the sctp module's
 * same-named class wraps an existing socket and creates none). We patch that
 * one choke point: each werift-created socket gets an "error" handler that
 * swallows positively-identified benign transport errnos (counted, visible in
 * /relay-diag) and treats everything else as fatal-with-stack; the instance's
 * `send` is wrapped so the callback-path rejection with the same errnos is
 * contained too. The process-global handlers below are now PURE fatal
 * reporters — no benign branch at process scope AT ALL — so an unowned dgram
 * failure anywhere else in the sequencer preserves ordinary fatal semantics.
 * The discriminating test: an unowned socket erroring with the exact same
 * errno/syscall shape must die, and does (tools/sfu-test.ts).
 *
 * Known edges of the seam (review, 2026-08-18): the handler attaches after
 * init resolves, so bind-time errors stay default-fatal (correct — EADDRINUSE
 * is not peer churn, and this matches upstream/v2). The bundle's
 * MediaStreamTrackFactory.rtpSource creates one receive-only socket outside
 * the seam — referenced nowhere in this repo, and its plausible failures were
 * never in the benign set. `werift/nonstandard` is a separate bundle with its
 * own UdpTransport copy this patch cannot reach; nothing here imports it.
 *
 * Retained from earlier rounds:
 * - C1: a bare re-throw inside a handler loses the original stack on Bun
 *   (measured), so the reporters log the original error + stack themselves
 *   before exiting nonzero.
 * - C3: `uncaughtException` and `unhandledRejection` have different semantics
 *   and do not share a handler.
 * - Explicit installation (independent review, 2026-08-16): server.ts calls
 *   this once at boot with a log line; constructing an Sfu must not silently
 *   replace process-wide crash semantics. On this engine-only branch nothing
 *   in the server wires it yet — the tests install it; #132 wires it.
 */

import { UdpTransport } from "werift";

/** errno CODES a dead/unreachable UDP peer produces. Structured, not textual:
 *  matching message text is how v1 swallowed a TypeError. */
const BENIGN_CODES = new Set(["ECONNREFUSED", "ECONNRESET", "EHOSTUNREACH", "ENETUNREACH", "EPIPE"]);

let installed = false;
let swallowed = 0;
let fatals = 0;

function isBenignTransportError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const code = (err as NodeJS.ErrnoException).code;
  if (typeof code !== "string" || !BENIGN_CODES.has(code)) return false;
  // 🔴 REQUIRE a syscall. `syscall === undefined` was too permissive: an
  // application error carrying a benign code with no syscall got swallowed and
  // the process survived in an unknown state. Demonstrated in review with
  // `Error("fetch failed", code=ECONNREFUSED)`, and there are seven in-process
  // fetch() calls in server/, so it is reachable rather than theoretical.
  // dgram ALWAYS sets syscall, so requiring it costs us nothing.
  const syscall = (err as NodeJS.ErrnoException).syscall;
  return typeof syscall === "string" && /^(recv|send)/.test(syscall);
}

/** Preserve the crash site ourselves — a bare `throw` inside a handler loses
 *  the original stack on Bun — then EXIT, preserving the ordinary fatal
 *  contract. "Voice degraded but alive" is NOT an outcome the guard may
 *  produce for an unknown error: an unknown error means an unknown process
 *  state, and amendment 2's recovery story (restart → durable incarnation
 *  advances → every credential structurally stale → one clean rejoin) only
 *  works if the process actually restarts. */
function reportFatal(err: unknown, kind: string, onFatal?: (e: unknown, k: string) => void) {
  console.error(`\n[sfu] FATAL (${kind}):`);
  console.error(err instanceof Error && err.stack ? err.stack : err);
  fatals++;
  try { onFatal?.(err, kind); } catch { /* a notifier that throws must not recurse */ }
  process.exit(1);
}
export const transportFatals = () => fatals;

/** CONTRACT (#130 rounds 1–2): containment is bound to OWNED werift transport.
 *  🔴 INSTALL ORDER IS LOAD-BEARING: the patch covers only transports created
 *  AFTER installation. A werift socket minted pre-install has no handler and —
 *  with process scope now pure-fatal — its benign churn is the original crash
 *  again. The hard requirement, stated: install BEFORE the first Sfu /
 *  RTCPeerConnection construction. (#132, when it wires this into server.ts,
 *  should assert it rather than trust it.)
 *  Werift-created sockets may have positively-identified benign transport
 *  errnos swallowed (counted); every other uncaught failure anywhere in the
 *  process — including a non-werift dgram socket failing with the identical
 *  errno/syscall shape — logs its original stack and exits nonzero, exactly
 *  as it would have unguarded. */
export function installSfuTransportGuard(onFatal?: (err: unknown, kind: string) => void) {
  if (installed) {
    if (onFatal) console.warn("[sfu] transport guard already installed — second onFatal ignored");
    return;
  }
  installed = true;
  console.log("[sfu] transport guard installed (werift-owned UDP errno containment)");

  // ── the ownership seam ────────────────────────────────────────────────────
  // Every raw dgram socket werift makes is created inside UdpTransport.init
  // (verified against both the CJS tree and the shipped ESM bundle: the STUN
  // and TURN layers construct through the static, and nothing else calls
  // `new UdpTransport` with a socket type). Wrapping the static therefore IS
  // positive ownership: a socket gets the benign-swallow handler if and only
  // if werift created it.
  type UdpInit = typeof UdpTransport.init;
  const origInit: UdpInit = UdpTransport.init.bind(UdpTransport);
  (UdpTransport as { init: UdpInit }).init = (async (...args: Parameters<UdpInit>) => {
    const t = await origInit(...args);
    const sock = (t as unknown as { socket?: NodeJS.EventEmitter }).socket;
    if (sock && typeof sock.on === "function") {
      sock.on("error", (err: unknown) => {
        if (isBenignTransportError(err)) { swallowed++; return; }
        reportFatal(err, "werift-udp error", onFatal);
      });
    }
    // The callback-send path surfaces the same errnos as a rejection rather
    // than an emitter error; contain it at the same seam so it never reaches
    // process scope.
    const origSend = (t as unknown as { send: (...a: unknown[]) => Promise<unknown> }).send;
    if (typeof origSend === "function") {
      (t as unknown as { send: (...a: unknown[]) => Promise<unknown> }).send = async (...a: unknown[]) => {
        try { return await origSend.apply(t, a); }
        catch (err) { if (isBenignTransportError(err)) { swallowed++; return; } throw err; }
      };
    }
    return t;
  }) as UdpInit;

  // ── process scope: pure fatal reporters, NO benign branch ────────────────
  process.on("uncaughtException", (err) => reportFatal(err, "uncaughtException", onFatal));
  process.on("unhandledRejection", (reason) => reportFatal(reason, "unhandledRejection", onFatal));
}

/** Surfaced in /relay-diag: a climbing count is normal churn, but a spike means
 *  peers are dying faster than they should and is worth looking at. */
export function transportErrorsSwallowed() { return swallowed; }

/** Exported for tests — the classifier is the security-relevant half. */
export const __isBenignTransportError = isBenignTransportError;
