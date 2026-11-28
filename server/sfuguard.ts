/**
 * Containment for a werift bug: its UDP sockets bind "message" but never "error", so a peer leaving (ICMP port-unreachable →
 * ECONNREFUSED on our next send) would take the whole process down.
 * Every raw socket werift creates flows through `UdpTransport.init`, so patching it gives each one an "error" handler that
 * swallows positively-identified benign errnos (counted in /relay-diag) and treats everything else as fatal; `send` is
 * wrapped for the callback path. The process-global handlers are pure fatal reporters: an unowned socket with the same
 * errno still dies (test/server/sfu-test.ts). Bind-time errors stay fatal. server.ts installs this once at boot.
 */

import { UdpTransport } from "werift";

/** errno CODES a dead/unreachable UDP peer produces. Structured, never message text. */
const BENIGN_CODES = new Set(["ECONNREFUSED", "ECONNRESET", "EHOSTUNREACH", "ENETUNREACH", "EPIPE"]);

let installed = false;
let swallowed = 0;
let fatals = 0;

function isBenignTransportError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const code = (err as NodeJS.ErrnoException).code;
  if (typeof code !== "string" || !BENIGN_CODES.has(code)) return false;
  // a syscall is required: an application error with a benign code (fetch's ECONNREFUSED) must not be swallowed
  const syscall = (err as NodeJS.ErrnoException).syscall;
  return typeof syscall === "string" && /^(recv|send)/.test(syscall);
}

/** Log the crash site ourselves (a bare throw in a handler loses the stack on Bun), then exit: an unknown error is an unknown
 *  process state, and recovery (restart → new incarnation → one clean rejoin) needs a real restart. */
function reportFatal(err: unknown, kind: string, onFatal?: (e: unknown, k: string) => void) {
  console.error(`\n[sfu] FATAL (${kind}):`);
  console.error(err instanceof Error && err.stack ? err.stack : err);
  fatals++;
  try { onFatal?.(err, kind); } catch { /* a notifier that throws must not recurse */ }
  process.exit(1);
}
export const transportFatals = () => fatals;

/** Install the guard. Only transports created after installation are covered, so call this before the first Sfu is constructed. */
export function installSfuTransportGuard(onFatal?: (err: unknown, kind: string) => void) {
  if (installed) {
    if (onFatal) console.warn("[sfu] transport guard already installed — second onFatal ignored");
    return;
  }
  installed = true;
  console.log("[sfu] transport guard installed (werift-owned UDP errno containment)");

  // the ownership seam: every raw dgram socket werift makes is created inside UdpTransport.init
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
    // the callback-send path surfaces the same errnos as a rejection: contain it at the same seam
    const origSend = (t as unknown as { send: (...a: unknown[]) => Promise<unknown> }).send;
    if (typeof origSend === "function") {
      (t as unknown as { send: (...a: unknown[]) => Promise<unknown> }).send = async (...a: unknown[]) => {
        try { return await origSend.apply(t, a); }
        catch (err) { if (isBenignTransportError(err)) { swallowed++; return; } throw err; }
      };
    }
    return t;
  }) as UdpInit;

  // process scope: pure fatal reporters, no benign branch
  process.on("uncaughtException", (err) => reportFatal(err, "uncaughtException", onFatal));
  process.on("unhandledRejection", (reason) => reportFatal(reason, "unhandledRejection", onFatal));
}

/** Surfaced in /relay-diag: a climbing count is normal churn; a spike is worth a look. */
export function transportErrorsSwallowed() { return swallowed; }

/** Exported for tests. */
export const __isBenignTransportError = isBenignTransportError;
