// Voice service health: a participant leg dying is not the relay dying. The seam for a broken-but-alive SFU: mark voice
// degraded (text and world service stay live), broadcast it, and recover on a completed negotiation. Nothing marks it yet
// while the process lives: the one caller is sfuguard.ts's fatal hook, just before an unknown transport error exits the
// process (the restart stales every credential, transport.ts incarnation), and a negotiation timeout is only logged
// (sfuadapter.ts negotiate).

import { currentIncarnation } from "./transport.ts";

export type VoiceState = "live" | "degraded";

let state: VoiceState = "live";
let reason = "";
let notify: ((s: VoiceState, incarnation: string, reason: string) => void) | null = null;

/** server.ts supplies the broadcast; the supervisor owns the decision. */
export function onVoiceServiceChange(fn: typeof notify) { notify = fn; }

/** Called by anything that finds the SFU can't do its job; repeated faults update the reason (the latest is the useful one). */
export function markVoiceDegraded(why: string) {
  const wasDegraded = state === "degraded";
  state = "degraded"; reason = why;
  if (!wasDegraded) {
    console.error(`[sfu] voice DEGRADED: ${why}`);
    try { notify?.(state, currentIncarnation(), reason); } catch { /* never recurse */ }
  }
  // no silence timer: a dead subsystem is silent forever. Recovery needs a positive receipt (markVoiceLive).
}

/** Recovery on a positive receipt only: a completed negotiation (offer → answer → setRemoteDescription OK) proves the SFU
 *  usable. Clients rejoin under the current incarnation, so no stale leg is resurrected. */
export function markVoiceLive(why = "") {
  if (state === "live") return;
  state = "live"; reason = why;
  console.log(`[sfu] voice LIVE again${why ? `: ${why}` : ""}`);
  try { notify?.(state, currentIncarnation(), reason); } catch { /* never recurse */ }
}

export const voiceServiceState = () => ({ state, reason, incarnation: currentIncarnation() });
