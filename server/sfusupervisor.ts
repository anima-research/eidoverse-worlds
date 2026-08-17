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

/** Called by anything that discovers the SFU cannot do its job. Repeated
 *  faults update the reason (the LATEST fault is the one an operator needs). */
export function markVoiceDegraded(why: string) {
  const wasDegraded = state === "degraded";
  state = "degraded"; reason = why;
  if (!wasDegraded) {
    console.error(`[sfu] voice DEGRADED: ${why}`);
    try { notify?.(state, currentIncarnation(), reason); } catch { /* never recurse */ }
  }
  // 🔴 NO SILENCE TIMER (#130 review, item 2). Two prior versions were both
  // wrong ways: markVoiceLive with zero callers latched degraded forever, and
  // the 30s "no further faults" timer that replaced it aged faults into green
  // on the absence of evidence — a dead subsystem is silent forever, and the
  // early-return above (previous version) didn't even rearm it on a repeat
  // fault (reviewer's clocked repro: fault at t=0 and t=20, LIVE at t=31).
  //
  // Recovery now requires a POSITIVE receipt: markVoiceLive is called by the
  // adapter when an owned negotiation completes end-to-end (offer → browser
  // answer → setRemoteDescription OK) — evidence the SFU is doing its actual
  // job, not merely evidence nobody has watched it fail lately.
}

/** A supervised recovery, on a POSITIVE health receipt only: a completed
 *  negotiation proves the SFU is usable. Clients rejoin under the CURRENT
 *  incarnation — which, after a process restart, is a new one, so no stale
 *  leg can be resurrected by a client that missed the transition. */
export function markVoiceLive(why = "") {
  if (state === "live") return;
  state = "live"; reason = why;
  console.log(`[sfu] voice LIVE again${why ? `: ${why}` : ""}`);
  try { notify?.(state, currentIncarnation(), reason); } catch { /* never recurse */ }
}

export const voiceServiceState = () => ({ state, reason, incarnation: currentIncarnation() });
