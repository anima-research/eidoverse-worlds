// sfuadapter — the in-process SFU behind relayadapter.ts's interface.
//
// WHY THIS FILE EXISTS AND WHAT IT DELIBERATELY DOES NOT DO:
// relayadapter.ts already defines the shape server.ts depends on (mint, admit,
// consent, moderator mute, revoke, diag). That interface is the seam #104's
// acceptance table is written against, so a third hypothesis — ours — earns its
// row by implementing THE SAME SURFACE rather than by changing the protocol.
// Nothing in server.ts should need to know which one is running.
//
// 🔴 The decision layer is NOT re-implemented here. `admitParticipant`,
// `applyConsentUpdate`, `parseRelayIdentity` and `nextIncarnation` live in
// relaydecision.ts, are transport-agnostic, and carry all seven of amendment
// 1's refusals with 23 tests. Reusing them unchanged is the single strongest
// argument this hypothesis has: the security-shaped half was never LiveKit's.
//
// What genuinely differs from the LiveKit adapter:
//   • no JWT — a browser talks SDP to a process it is already authenticated to
//     over the world websocket, so the credential is a nonce we mint and burn,
//     not a bearer token a third party validates;
//   • no webhook — admission is synchronous, at the moment we create the leg,
//     instead of a round trip we react to after the fact;
//   • no API secret exists at all, so amendment 1's "never expose LiveKit API
//     secrets to a browser or resident tool surface" is satisfied vacuously.
import { Sfu } from "./sfu.ts";
import { admitParticipant, applyConsentUpdate, nextIncarnation,
  type RelayClaims, type LiveLegState } from "./relaydecision.ts";

export type SfuWorldState = {
  sfu: Sfu;
  incarnation: string;
  legs: Map<string, { id: string; gen: number; primaryGen: number; nonce: string }>;
  consent: Map<string, { gen: number; consent: boolean }>;
  moderatorMuted: Set<string>;
  usedNonces: Set<string>;
};

const worlds = new Map<string, SfuWorldState>();

/** Per-world SFU. Created on first use; a world with no voice never builds one. */
export function sfuState(world: string): SfuWorldState {
  let s = worlds.get(world);
  if (!s) {
    s = {
      // 🔴 The incarnation is opaque, NOT monotonic — amendment 2 explicitly
      // rejects an in-memory epoch++ that "resets when the adapter dies and can
      // accidentally reuse an old value". In-process makes this easier rather
      // than harder (the SFU cannot outlive or predecease the sequencer), but
      // "easier" is not "proven", so we still refuse to call it monotonic.
      incarnation: nextIncarnation(null, crypto.randomUUID()),
      sfu: new Sfu({ onNegotiationNeeded: (legId) => pendingOffers.get(world)?.(legId) }),
      legs: new Map(), consent: new Map(), moderatorMuted: new Set(), usedNonces: new Set(),
    };
    worlds.set(world, s);
  }
  return s;
}

/** server.ts installs a callback that knows how to reach a given leg's socket.
 *  The SFU itself must never learn about websockets — it speaks SDP and RTP. */
const pendingOffers = new Map<string, (legId: string) => void>();
export function onSfuNegotiationNeeded(world: string, fn: (legId: string) => void) {
  pendingOffers.set(world, fn);
}

/** Mint: same shape as mintRelayCredential, minus the JWT that has no analogue. */
export function mintSfuCredential(world: string, id: string, primaryGen: number, mediaGen: number) {
  const s = sfuState(world);
  const nonce = crypto.randomUUID();
  s.legs.set(id, { id, gen: mediaGen, primaryGen, nonce });
  return { nonce, incarnation: s.incarnation, identity: `${id}#${mediaGen}`, transport: "sfu" as const };
}

/** Admission — amendment 1's seven refusals, decided by the SHARED decision
 *  layer. Synchronous here because we are the SFU: there is no third party to
 *  ask and no webhook to wait for. */
export function admitSfuLeg(world: string, claims: RelayClaims, live: LiveLegState) {
  const s = sfuState(world);
  const verdict = admitParticipant(claims, { ...live, usedNonces: s.usedNonces });
  // Burn on FIRST admission, exactly as the LiveKit path does — the
  // removed-participant replay hole is real and the nonce is what closes it.
  if (verdict.admit) s.usedNonces.add(claims.nonce);
  return verdict;
}

/** Listener consent. The decision is shared; only the enforcement is ours, and
 *  ours is a memory write rather than an SDP round trip (see sfu.ts's
 *  ensureRoute doc for why routes and consent are separate concepts). */
export function setSfuConsent(world: string, listenerId: string, listenerGen: number, recv: boolean) {
  const s = sfuState(world);
  const r = applyConsentUpdate(s.consent, listenerId, listenerGen, recv);
  if (!r.changed) return r;
  for (const speakerId of s.legs.keys()) {
    if (speakerId === listenerId) continue;
    s.sfu.setConsent(listenerId, speakerId, recv);
  }
  return r;
}

/** Moderator/global mute — a different state than consent (amendment 3),
 *  enforced at the SOURCE so one call silences a speaker for everyone. */
export function setSfuModeratorMute(world: string, speakerId: string, mutedFlag: boolean) {
  const s = sfuState(world);
  mutedFlag ? s.moderatorMuted.add(speakerId) : s.moderatorMuted.delete(speakerId);
  s.sfu.setMuted(speakerId, mutedFlag);
}

/** Retirement funnel — the same one every other surface uses. */
export function revokeSfuLeg(world: string, id: string) {
  const s = worlds.get(world);
  if (!s) return null;
  const leg = s.legs.get(id) ?? null;
  s.legs.delete(id); s.consent.delete(id); s.moderatorMuted.delete(id);
  s.sfu.closeLeg(id);
  return leg;
}

/** Diagnostics merged into /relay-diag. Reports DELIVERED and SUPPRESSED
 *  separately per #104's measurement hygiene — "a cheaper server that drops
 *  more is not healthier", so a single throughput number would be misleading. */
export function sfuDiag(world: string) {
  const s = worlds.get(world);
  if (!s) return { transport: "sfu", active: false };
  const d = s.sfu.diag();
  return {
    transport: "sfu", active: true, incarnation: s.incarnation,
    legs: d.legs, forwarded: d.forwarded,
    suppressed: { gated: s.sfu.gated, capped: s.sfu.capped },
    moderatorMuted: [...s.moderatorMuted],
  };
}

// ── signaling: the server always OFFERS ───────────────────────────────────
// One pending answer-resolver per leg. `Sfu.negotiate()` serialises offers per
// leg internally (the promise chain that fixed SDP glare), so this map can
// never hold more than one entry per leg — if it somehow did, the second offer
// would be answering a question the browser was never asked.
const waiting = new Map<string, (sdp: string) => void>();

/** Create the offer for `legId` and hand it to `send`. The browser answers via
 *  the `sfu-answer` verb, which resolves the promise this awaits. */
export async function sfuNegotiate(world: string, legId: string,
  send: (payload: unknown) => void) {
  const s = worlds.get(world);
  if (!s) return;
  await s.sfu.negotiate(legId, async (pc) => {
    // Tell the client which speaker each new track carries BEFORE the offer
    // lands, so its ontrack can pair them in arrival order (see voicesfu.js).
    for (const speakerId of s.sfu.routesFor(legId)) send({ type: "sfu-route", speaker: speakerId });
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    send({ type: "sfu-offer", sdp: pc.localDescription!.sdp });
    const sdp = await new Promise<string>((resolve, reject) => {
      waiting.set(legId, resolve);
      // A browser that never answers must not wedge the leg's promise chain
      // forever — every later offer for this leg would queue behind it and the
      // participant would go permanently silent with no error anywhere.
      setTimeout(() => { if (waiting.delete(legId)) reject(new Error("answer timeout")); }, 15000);
    });
    await pc.setRemoteDescription({ type: "answer", sdp });
  }).catch((e) => console.error(`[sfu] negotiate ${legId}:`, (e as Error).message));
}

export function sfuAcceptAnswer(world: string, legId: string, sdp: string) {
  const resolve = waiting.get(legId);
  if (!resolve) return;                 // no offer outstanding — stale answer, drop
  waiting.delete(legId);
  resolve(sdp);
}

export function sfuAcceptIce(world: string, legId: string, candidate: unknown) {
  const s = worlds.get(world);
  s?.sfu.addIceCandidate(legId, candidate);
}
