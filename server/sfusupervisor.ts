// Voice service health — amendment 2's "separate participant-leg death from
// relay-service death", for an in-process SFU.
//
// 🔴 The in-process argument ("the SFU cannot outlive or predecease the
// sequencer") CONVERTS this requirement, it does not satisfy it: it makes death
// total rather than impossible. Amendment 2 still asks for the observable
// behaviour, and every clause of it applies to us:
//
//   text/world service remains live · voice visibly becomes degraded ·
//   all old credentials become stale · clients perform ONE clean fresh join ·
//   no duplicate participant, playback or `performed` receipt survives
//
// What we get for free from being in-process: no probe is needed to discover
// that the SFU died, because it dies with us, and a restart already advances
// the DURABLE incarnation (transport.ts), which is what makes every prior
// credential structurally stale. What we still owe: a degraded STATE that is
// visible while the process lives — an SFU can be broken without being dead.

import { currentIncarnation } from "./transport.ts";

export type VoiceState = "live" | "degraded";

let state: VoiceState = "live";
let reason = "";
let notify: ((s: VoiceState, incarnation: string, reason: string) => void) | null = null;

/** server.ts supplies the broadcast; the supervisor owns the decision. */
export function onVoiceServiceChange(fn: typeof notify) { notify = fn; }

/** Called by the transport guard on a non-benign fault, and by anything else
 *  that discovers the SFU cannot do its job. Idempotent per state. */
export function markVoiceDegraded(why: string) {
  if (state === "degraded") return;
  state = "degraded"; reason = why;
  console.error(`[sfu] voice DEGRADED: ${why}`);
  try { notify?.(state, currentIncarnation(), reason); } catch { /* never recurse */ }
  // 🔴 NOT A ONE-WAY DOOR (independent review, 2026-08-16). markVoiceLive had
  // ZERO callers, so a single non-benign fault anywhere in the process latched
  // voice degraded for the life of the server with no path back — and because
  // the guard is process-wide, an unrelated unhandled rejection could do it.
  //
  // A degraded voice service that has stopped faulting is a RECOVERED one: the
  // SFU is in-process, so there is nothing to restart and nothing to wait for
  // except evidence that the fault is not recurring. If it recurs, this timer
  // is replaced by the next degrade and the window starts again — so a
  // crash-looping subsystem stays visibly degraded rather than flapping green.
  clearTimeout(recoveryTimer);
  recoveryTimer = setTimeout(() => markVoiceLive("no further faults for 30s"), 30_000);
  // A recovery timer must never hold the process open on its own.
  (recoveryTimer as { unref?: () => void }).unref?.();
}
let recoveryTimer: ReturnType<typeof setTimeout> | undefined;

/** A supervised recovery: the SFU is usable again. Clients rejoin under the
 *  CURRENT incarnation — which, after a process restart, is a new one, so no
 *  stale leg can be resurrected by a client that missed the transition. */
export function markVoiceLive(why = "") {
  clearTimeout(recoveryTimer);
  if (state === "live") return;
  state = "live"; reason = why;
  console.log(`[sfu] voice LIVE again${why ? `: ${why}` : ""}`);
  try { notify?.(state, currentIncarnation(), reason); } catch { /* never recurse */ }
}

export const voiceServiceState = () => ({ state, reason, incarnation: currentIncarnation() });
