// relaydecision — the relay adapter's PURE decision logic, extracted headless
// so the seven refusal proofs (#104 amendment 1) and the incarnation rules
// (amendment 2) are pinned by tests with no transport, no sockets, no clock.
// The Basis lesson (BasisP2PLinkHealth): the part that decides is a function;
// the part that talks to the world imports it.
//
// Vocabulary (from the #104 contracts):
//   incarnation — the durable relay-service identity (amendment 2: NOT called
//     an epoch and NOT claimed monotonic in-memory; a counter durably advanced
//     plus entropy, so a reused counter after file loss still cannot collide).
//   mediaGen — the sequencer generation of THIS participant's relay leg
//     (a surface session in the #103 model; the credential names exactly one).
//   nonce — single-use credential id; a bearer credential replayed after its
//     leg was removed re-admits a removed participant (probed and measured on
//     an external relay, 2026-08-13), and single-use is what closes it.

export interface RelayClaims {
  world: string;
  id: string;
  primaryGen: number;
  mediaGen: number;
  incarnation: string;
  nonce: string;
}

export interface LiveLegState {
  world: string;                 // the world this admission gate serves
  incarnation: string;           // the adapter's CURRENT incarnation
  // the sequencer's live view of this identity, or undefined if absent:
  primaryGen?: number;           // gen of the embodied world session
  mediaGen?: number;             // gen of the CURRENT relay leg issued for id
  usedNonces: Set<string>;       // nonces already admitted once
}

export type Admission = { admit: true } | { admit: false; reason: string };

/** The seven refusals, in the order amendment 1 names them. The in-process
 *  SFU has no bearer expiry or signature to enforce upstream (the world
 *  websocket already authenticated the identity); everything about our
 *  generations is decided HERE. */
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

/** Participant identity on the relay carries the accepted generation, so a
 *  stale leg is visibly stale in every roster and log line (amendment 1's
 *  "relay participant identity that includes the accepted generation"). */
export const relayIdentity = (id: string, mediaGen: number) => `${id}#g${mediaGen}`;
export function parseRelayIdentity(s: string): { id: string; mediaGen: number } | null {
  const m = /^(.{1,64})#g(\d{1,12})$/.exec(s);
  return m ? { id: m[1], mediaGen: Number(m[2]) } : null;
}

/** Advance the durable incarnation. `prev` is whatever the incarnation file
 *  held (null on first boot or lost file); the counter advances past it and
 *  the entropy suffix makes even a lost-file counter reuse non-colliding.
 *  Honest name: this is an INCARNATION ID; only the counter half is ordered,
 *  and only while the file survives. */
export function nextIncarnation(prev: string | null, entropy: string): string {
  const n = prev ? Number(/^i(\d+)-/.exec(prev)?.[1] ?? 0) : 0;
  return `i${n + 1}-${entropy}`;
}

/** Three independent audibility states (amendment 3) resolved into ONE
 *  question the relay can act on: may THIS listener's subscription to THIS
 *  speaker's track be active? Publisher self-mute is pre-encode and never
 *  consulted here (it needs no server); moderation and listener consent are
 *  server-enforced and independent. Fail closed: absent consent = false. */
export interface AudibilityState {
  listenerConsent: boolean;      // listener-authored receive consent (default false)
  moderatorMuted: boolean;       // global track mute (moderation)
}
export const subscriptionActive = (s: AudibilityState) => s.listenerConsent && !s.moderatorMuted;

/** Consent updates are generation-bound and idempotent (amendment 3): an
 *  update stamped with a stale listener generation must not apply — a
 *  reconnect must not silently broaden consent, so the fresh leg starts
 *  from fail-closed regardless of what its predecessor had said. */
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
