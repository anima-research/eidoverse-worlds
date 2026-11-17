// The in-process SFU behind server.ts's relay-adapter surface (mint, admit, consent, mute, revoke, diag); decisions
// stay in relaydecision.ts. In-process: no JWT (a one-shot nonce over the world websocket), no API secret.
import { currentIncarnation } from "./transport.ts";
import { voiceServiceState, markVoiceLive } from "./sfusupervisor.ts";
import { Sfu } from "./sfu.ts";
import { admitParticipant, applyConsentUpdate, nextIncarnation, relayIdentity,
  type RelayClaims, type LiveLegState } from "./relaydecision.ts";

export type SfuWorldState = {
  sfu: Sfu;
  incarnation: string;
  legs: Map<string, { id: string; gen: number; primaryGen: number; nonce: string }>;
  consent: Map<string, { gen: number; consent: boolean }>;
  usedNonces: Set<string>;
  /** listener → last answer, applied to later speakers; room-level on purpose ("receive voice" = hear the room).
   *  INVARIANT: it dies with the leg (revokeSfuLeg), so a reconnect starts fail-closed. */
  standingConsent: Map<string, boolean>;
  /** Legs that have proven their credential; dies with the world. */
  admitted: Set<string>;
};

const worlds = new Map<string, SfuWorldState>();

/** Built on first use; a world with no voice never builds one. */
export function sfuState(world: string): SfuWorldState {
  let s = worlds.get(world);
  if (!s) {
    s = {
      // the incarnation is opaque, not monotonic, and kept across restarts (transport.ts; not fsynced)
      incarnation: currentIncarnation(),
      sfu: new Sfu({ onNegotiationNeeded: (legId) => {
        const send = senders.get(wkey(world, legId));
        if (send) void sfuNegotiate(world, legId, send);
      } }),
      legs: new Map(), consent: new Map(), usedNonces: new Set(),
      standingConsent: new Map(), admitted: new Set(),
    };
    worlds.set(world, s);
  }
  return s;
}

const wkey = (world: string, legId: string) => `${world}\u0000${legId}`;

// legId → how to reach its browser (the SFU never sees websockets). KEYED BY world+legId: two worlds may host the same id.
const senders = new Map<string, (payload: unknown) => void>();
export function registerSfuSender(world: string, legId: string, send: (payload: unknown) => void) {
  senders.set(wkey(world, legId), send);
}

/** The credential a client presents back through admitSfuLeg: its claims plus a one-shot nonce; no JWT. */
export function mintSfuCredential(world: string, id: string, primaryGen: number, mediaGen: number) {
  // a mint retires the old leg via revokeSfuLeg (keeping consent given while no leg existed); revoke unregisters the
  // sender, so registerSfuSender must come after the mint
  const s0 = worlds.get(world);
  const hadLeg = !!s0?.legs.has(id);
  const preConsent = hadLeg ? undefined : s0?.standingConsent.get(id);
  // …and its gen watermark rides along: without it a delayed yes(gen1) after a preserved no(gen2) would re-grant
  const preWatermark = hadLeg ? undefined : s0?.consent.get(id);
  revokeSfuLeg(world, id);
  const s = sfuState(world);
  if (preConsent !== undefined) s.standingConsent.set(id, preConsent);
  if (preWatermark !== undefined) s.consent.set(id, preWatermark);
  const nonce = crypto.randomUUID();
  s.legs.set(id, { id, gen: mediaGen, primaryGen, nonce });
  // create the actual leg: a bookkeeping record of a peer connection is not one
  s.sfu.createLeg(id, mediaGen);
  applyStandingConsent(s, id);   // consent given before this leg existed still counts
  // world/id/primaryGen ride along so the client presents the full claim set: admitParticipant checks them all before the nonce
  return { nonce, incarnation: s.incarnation, identity: relayIdentity(id, mediaGen),
           world, id, primaryGen, mediaGen,
           transport: "sfu" as const, iceServers: iceServers() };
}

/** STUN even in phase 1: a client behind NAT must learn its public address or it can't be heard; TURN deferred.
 *  SFU_ICE_SERVERS = JSON array; `[]` forces host-only (tests: a loopback pair must not wait on public STUN). */
function iceServers(): { urls: string; username?: string; credential?: string }[] {
  const raw = process.env.SFU_ICE_SERVERS;
  if (raw !== undefined) {
    try { return JSON.parse(raw); }
    catch (e) {
      // never fall back silently: an operator who set this meant to change it
      console.error(`[sfu] SFU_ICE_SERVERS is not valid JSON — refusing to guess:`,
        (e as Error).message);
      return [];
    }
  }
  return [{ urls: "stun:stun.l.google.com:19302" }];
}

/** Adds `useinbandfec=1`, DTX stays off (silence-suppressed and dead look the same to a listener). Idempotent. */
export function withOpusFec(sdp: string): string {
  const pt = /a=rtpmap:(\d+)\s+opus\/48000/i.exec(sdp)?.[1];
  if (!pt) return sdp;                       // no opus offered
  const fmtp = new RegExp(`a=fmtp:${pt} ([^\r\n]*)`);
  const m = fmtp.exec(sdp);
  if (!m) return sdp.replace(new RegExp(`(a=rtpmap:${pt}\\s+opus/48000[^\r\n]*)`),
                             `$1\r\na=fmtp:${pt} useinbandfec=1`);
  if (/useinbandfec=1/.test(m[1])) return sdp;
  return sdp.replace(fmtp, `a=fmtp:${pt} ${m[1]};useinbandfec=1`);
}

export function liveLegState(world: string, id: string, primaryGen?: number): LiveLegState {
  const s = sfuState(world);
  const leg = s.legs.get(id);
  return { world, incarnation: s.incarnation, primaryGen,
           mediaGen: leg?.gen, usedNonces: s.usedNonces };
}

/** A leg is admitted ONCE; later answers are renegotiation. Cleared by revokeSfuLeg, so a fresh leg proves itself again. */
export const sfuLegAdmitted = (world: string, id: string) => !!worlds.get(world)?.admitted.has(id);
export const markSfuLegAdmitted = (world: string, id: string) => { sfuState(world).admitted.add(id); };

/** Admission: admitParticipant's eight refusal branches (relaydecision.ts); synchronous, as we are the SFU. */
export function admitSfuLeg(world: string, claims: RelayClaims, live: LiveLegState) {
  const s = sfuState(world);
  const verdict = admitParticipant(claims, { ...live, usedNonces: s.usedNonces });
  // burn on FIRST admission: the nonce closes the removed-participant replay hole
  if (verdict.admit) {
    s.usedNonces.add(claims.nonce);
    // BOUNDED: evict the oldest (a Set iterates in insertion order). Not airtight: a leg whose gens stay live through 4096
    // other admissions here can replay its credential once its nonce is evicted (no expiry backs it up)
    if (s.usedNonces.size > 4096) {
      const oldest = s.usedNonces.values().next().value;
      if (oldest !== undefined) s.usedNonces.delete(oldest);
    }
  }
  return verdict;
}

/** Shared decision; our enforcement is a memory write, not an SDP round trip (routes vs consent: sfu.ts ensureRoute). */
export function setSfuConsent(world: string, listenerId: string, listenerGen: number, recv: boolean) {
  const s = sfuState(world);
  const r = applyConsentUpdate(s.consent, listenerId, listenerGen, recv);
  if (!r.changed) {
    // a refused revoke still stops the audio: idempotence may swallow a repeated YES, never a NO
    if (!recv) {
      for (const speakerId of s.legs.keys()) s.sfu.setConsent(listenerId, speakerId, false);
      // …and clears the standing answer, or later speakers become audible; a stale revoke may clobber a newer yes:
      // silence is the safe failure
      s.standingConsent.set(listenerId, false);
    }
    return r;
  }
  // standing answer too, so applyStandingConsent honours it for later speakers
  s.standingConsent.set(listenerId, recv);
  for (const speakerId of s.legs.keys()) {
    if (speakerId === listenerId) continue;
    s.sfu.setConsent(listenerId, speakerId, recv);
  }
  return r;
}

/** Both directions: consent is a standing answer about the room, not about who was present when it was given. */
function applyStandingConsent(s: SfuWorldState, newLegId: string) {
  for (const [listenerId, recv] of s.standingConsent) {
    if (listenerId !== newLegId) s.sfu.setConsent(listenerId, newLegId, recv);
  }
  const mine = s.standingConsent.get(newLegId);
  if (mine !== undefined) {
    for (const otherId of s.legs.keys()) if (otherId !== newLegId) s.sfu.setConsent(newLegId, otherId, mine);
  }
}

/** Moderator mute: not consent; enforced at the source, so one call silences a speaker for everyone. */
export function setSfuModeratorMute(world: string, speakerId: string, mutedFlag: boolean) {
  // ONE STORE: the SFU enforces the mute, so the SFU owns the fact; sfuDiag reads it back through diag().muted
  sfuState(world).sfu.setMuted(speakerId, mutedFlag);
}

/** Server-held deafness, overriding the listener's consent. No caller now; kept for sfu-test and a spectator role. */
export function setSfuDeafened(world: string, listenerId: string, deaf: boolean) {
  sfuState(world).sfu.setDeafened(listenerId, deaf);
}

/** Retirement funnel, shared with every other surface. */
export function revokeSfuLeg(world: string, id: string) {
  senders.delete(wkey(world, id));
  // a leg revoked mid-negotiation must not leave its resolver behind to feed an answer into a closed pc
  waiting.delete(wkey(world, id));
  const s = worlds.get(world);
  if (!s) return null;
  const leg = s.legs.get(id) ?? null;
  s.legs.delete(id); s.consent.delete(id);
  s.standingConsent.delete(id);
  s.admitted.delete(id);              // a new leg must prove its credential again
  // a retired leg is not a muted one: a fresh leg with the same id must not inherit its predecessor's mute
  s.sfu.setMuted(id, false);
  s.sfu.closeLeg(id);
  return leg;
}

/** Merged into /relay-diag. DELIVERED and SUPPRESSED are separate: a cheaper server that drops more is not healthier. */
export function sfuDiag(world: string) {
  const s = worlds.get(world);
  if (!s) return { transport: "sfu", active: false };
  const d = s.sfu.diag();
  // pass the inner diag through, don't re-shape it, or fields like transportErrorsSwallowed silently drop
  return {
    ...d,
    transport: "sfu", active: true, incarnation: s.incarnation,
    // voice service state must be observable, and /relay-diag is where an operator looks
    service: voiceServiceState(),
    moderatorMuted: d.muted,          // one store, read back from the enforcement point
    deafened: d.deafened,
  };
}

// ── signaling: the server always OFFERS ───────────────────────────────────
// one pending answer-resolver per leg (negotiate() serialises offers per leg); KEYED BY world+legId, cleared by revokeSfuLeg
const waiting = new Map<string, (sdp: string) => void>();

/** The browser answers via the `sfu-answer` verb, which resolves the promise this awaits. */
export async function sfuNegotiate(world: string, legId: string,
  send: (payload: unknown) => void) {
  const s = worlds.get(world);
  if (!s) return;
  // a recvonly audio floor: without a receiving transceiver, alone there are zero m-lines and ICE never starts; with
  // others ontrack never fires
  const leg = s.sfu.getLeg(legId);
  if (leg && !leg.pc.getTransceivers().some((t: { direction?: string }) =>
        t.direction === "recvonly" || t.direction === "sendrecv")) {
    leg.pc.addTransceiver("audio", { direction: "recvonly" });
  }
  await s.sfu.negotiate(legId, async (pc) => {
    // speaker per track BEFORE the offer lands: the client pairs by msid and falls back to this arrival order (voicesfu.js)
    for (const speakerId of s.sfu.routesFor(legId)) send({ type: "sfu-route", speaker: speakerId });
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    // ask for in-band FEC explicitly: a default is not a contract; the client measures fecPacketsReceived
    // a leg retired while the offer was being made (revokeSfuLeg cleared its resolver before this await returned), or
    // re-minted under the same id: no offer to a dead leg, no stale offer to its successor, no resolver left behind
    if (s.sfu.getLeg(legId)?.pc !== pc) throw new Error(`leg ${legId} retired mid-negotiation`);
    send({ type: "sfu-offer", sdp: withOpusFec(pc.localDescription!.sdp) });
    const sdp = await new Promise<string>((resolve, reject) => {
      const k = wkey(world, legId);
      waiting.set(k, resolve);
      // a browser that never answers must not wedge the leg's chain; delete by IDENTITY, not key, so a superseded offer's
      // timer can't clobber its successor's resolver
      setTimeout(() => {
        if (waiting.get(k) === resolve) { waiting.delete(k); reject(new Error("answer timeout")); }
      }, 15000);
    });
    await pc.setRemoteDescription({ type: "answer", sdp });
    // the POSITIVE health receipt: the only path back from degraded; silence never is
    markVoiceLive(`negotiation completed for ${legId}`);
  }).catch((e) => console.error(`[sfu] negotiate ${legId}:`, (e as Error).message));
}

export function sfuAcceptAnswer(world: string, legId: string, sdp: string, claimedGen?: number) {
  // an answer must name its leg's current generation; required, not opt-in: a stale predecessor would omit it
  if (claimedGen == null) {
    console.warn(`[sfu] answer for ${legId} names no generation — dropped`);
    return;
  }
  {
    const leg = worlds.get(world)?.legs.get(legId);
    if (!leg || leg.gen !== claimedGen) {
      console.warn(`[sfu] answer for ${legId} claims gen ${claimedGen}, live gen is ${leg?.gen ?? "none"} — dropped`);
      return;
    }
  }
  const resolve = waiting.get(wkey(world, legId));
  if (!resolve) return;                 // no offer outstanding: stale answer
  waiting.delete(wkey(world, legId));
  resolve(sdp);
}

export function sfuAcceptIce(world: string, legId: string, candidate: unknown, claimedGen?: number) {
  // ICE is generation-bound like answers, required: a stale predecessor must not trickle into its successor's pc
  if (claimedGen == null) return;                    // late/stale churn, drop quietly
  const leg = worlds.get(world)?.legs.get(legId);
  if (!leg || leg.gen !== claimedGen) return;        // predecessor's candidate, drop
  worlds.get(world)?.sfu.addIceCandidate(legId, candidate);
}

/** Feeds the proximity gate. Optional: see `sfu-pos` in server.ts. */
export function sfuSetPosition(world: string, legId: string, x: number, y: number, z: number) {
  worlds.get(world)?.sfu.setPosition(legId, x, y, z);
}
