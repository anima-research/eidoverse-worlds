// Voice service health: a participant leg dying is not the relay dying. When the in-process SFU is broken but alive, text and
// world service stay live, voice is visibly degraded, and clients make one clean fresh join. An unknown transport error exits
// the whole process instead (sfuguard.ts reportFatal); the restart stales every credential (transport.ts incarnation). This
// module owes the degraded state visible while the process lives.

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
