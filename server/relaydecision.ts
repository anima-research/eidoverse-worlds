// The relay adapter's pure decision logic (admission refusals, incarnation rules), testable with no transport, sockets or clock.
//   incarnation — the durable relay identity: a durably advanced counter + entropy, not an epoch
//   mediaGen — this participant's relay-leg generation (the credential names exactly one)
//   nonce — a single-use credential id: a replayed bearer credential would re-admit a removed participant

export interface RelayClaims {
  world: string;
  id: string;
  primaryGen: number;
  mediaGen: number;
  incarnation: string;
  nonce: string;
}

export interface LiveLegState {
  world: string;
  incarnation: string;           // the adapter's CURRENT incarnation
  // the sequencer's live view of this identity, or undefined if absent:
  primaryGen?: number;           // gen of the embodied world session
  mediaGen?: number;             // gen of the CURRENT relay leg issued for id
  usedNonces: Set<string>;       // nonces already admitted once
}

export type Admission = { admit: true } | { admit: false; reason: string };

/** Eight refusal branches (no expiry: there is no bearer token, the nonce is single-use). Identity is the websocket's; every generation check is decided here. */
export function admitParticipant(claims: RelayClaims, live: LiveLegState): Admission {
  if (claims.world !== live.world) return { admit: false, reason: "wrong world" };
  if (!claims.id) return { admit: false, reason: "no identity" };
  if (live.primaryGen == null) return { admit: false, reason: "no living primary" };
  if (claims.primaryGen !== live.primaryGen) return { admit: false, reason: "retired primary generation" };
  if (live.mediaGen == null) return { admit: false, reason: "no relay leg issued" };
  if (claims.mediaGen !== live.mediaGen) return { admit: false, reason: "retired media generation" };
  if (claims.incarnation !== live.incarnation) return { admit: false, reason: "prior relay incarnation" };
  if (live.usedNonces.has(claims.nonce)) return { admit: false, reason: "credential replay" };
  return { admit: true };
}

/** Carries the accepted generation, so a stale leg is visibly stale in every roster and log line. */
export const relayIdentity = (id: string, mediaGen: number) => `${id}#g${mediaGen}`;
export function parseRelayIdentity(s: string): { id: string; mediaGen: number } | null {
  const m = /^(.{1,64})#g(\d{1,12})$/.exec(s);
  return m ? { id: m[1], mediaGen: Number(m[2]) } : null;
}

/** `prev`: the file's value, or null. The entropy suffix keeps a lost-file counter reuse from colliding; only the
 *  counter half is ordered, and only while the file survives. */
export function nextIncarnation(prev: string | null, entropy: string): string {
  const n = prev ? Number(/^i(\d+)-/.exec(prev)?.[1] ?? 0) : 0;
  return `i${n + 1}-${entropy}`;
}

/** May this listener's subscription to this speaker be active? Self-mute is pre-encode and not consulted. Fails closed. */
export interface AudibilityState {
  listenerConsent: boolean;      // listener-authored receive consent (default false)
  moderatorMuted: boolean;       // global track mute (moderation)
}
export const subscriptionActive = (s: AudibilityState) => s.listenerConsent && !s.moderatorMuted;

/** Generation-bound and idempotent: a stale generation never applies, so a reconnect can't silently broaden consent. */
export function applyConsentUpdate(
  current: Map<string, { gen: number; consent: boolean }>,
  listenerId: string, listenerGen: number, consent: boolean,
): { changed: boolean; reason?: string } {
  const prev = current.get(listenerId);
  if (prev && prev.gen > listenerGen) return { changed: false, reason: "stale listener generation" };
  if (prev && prev.gen === listenerGen && prev.consent === consent) return { changed: false, reason: "idempotent" };
  current.set(listenerId, { gen: listenerGen, consent });
  return { changed: true };
}
