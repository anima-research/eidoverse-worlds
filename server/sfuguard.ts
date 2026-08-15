/**
 * Containment for a werift bug that would otherwise crash the world server.
 *
 * werift creates its UDP socket and binds "message" but never "error"
 * (`werift/lib/common/src/transport.js:130-142`; contrast its TCP path at
 * :383-393, which DOES bind one). An unhandled `'error'` on a Node EventEmitter
 * throws globally, so when a peer's socket dies and the kernel answers our next
 * send with ICMP port-unreachable, dgram surfaces ECONNREFUSED and takes the
 * process with it.
 *
 * Measured 2026-08-14: closing six listeners during active fanout produced
 * EIGHT uncaught exceptions. In production that is "someone left a busy room,
 * the world server died". These have been in every test run today; I filtered
 * them as noise for hours before noticing they were unhandled rather than
 * merely ugly.
 *
 * WHY A PROCESS HANDLER AND NOT A PER-CONNECTION ONE: the socket is created
 * inside werift and is not reachable through any exported API. I tried a
 * per-connection guard first and it did nothing, because the throw happens
 * below the layer werift exposes. Upstream fix would be one line in their
 * transport; worth a PR.
 *
 * WHY THIS IS NARROW ON PURPOSE: a blanket `process.on("uncaughtException")`
 * would mask real faults — exactly the "never catch {}" failure this codebase
 * has a standing rule about. So this matches only the four errno strings a dead
 * UDP peer can produce, only while the SFU is running, and re-throws everything
 * else so a genuine bug still crashes loudly.
 */

/** errnos a dead/unreachable UDP peer produces. Nothing else is swallowed. */
const BENIGN = /\b(ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENETUNREACH|EPIPE)\b/;

let installed = false;
let swallowed = 0;

/** Idempotent: safe to call from every Sfu constructor. */
export function installSfuTransportGuard() {
  if (installed) return;
  installed = true;

  const onError = (err: unknown) => {
    const msg = String((err as Error)?.message ?? err);
    if (BENIGN.test(msg)) { swallowed++; return; }   // a dead peer's socket; expected
    throw err;                                        // anything else is a real bug: crash
  };

  process.on("uncaughtException", onError);
  process.on("unhandledRejection", onError);
}

/** Surfaced in /relay-diag: a climbing count is normal churn, but a spike
 *  means peers are dying faster than they should and is worth looking at. */
export function transportErrorsSwallowed() { return swallowed; }
