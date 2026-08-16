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
import { currentIncarnation } from "./transport.ts";
import { Sfu } from "./sfu.ts";
import { admitParticipant, applyConsentUpdate, nextIncarnation, relayIdentity,
  type RelayClaims, type LiveLegState } from "./relaydecision.ts";

export type SfuWorldState = {
  sfu: Sfu;
  incarnation: string;
  legs: Map<string, { id: string; gen: number; primaryGen: number; nonce: string }>;
  consent: Map<string, { gen: number; consent: boolean }>;
  moderatorMuted: Set<string>;
  usedNonces: Set<string>;
  /** listener → their last stated answer, applied to speakers who arrive LATER.
   *
   *  🔴 THIS IS ROOM-LEVEL, NOT PER-SPEAKER, AND THAT IS DELIBERATE. A listener
   *  who says YES is consenting to *hear the room*, so someone joining later is
   *  audible without a fresh consent event — which is what the audio panel's
   *  single "receive voice" toggle actually means to a user. A per-speaker ACL
   *  would be a different product (and a worse one: it would silence a newcomer
   *  until the listener noticed them and opted in individually).
   *
   *  The safety property that makes it acceptable is that it dies with the leg:
   *  revokeSfuLeg deletes this entry, so a RECONNECT starts fail-closed and
   *  cannot inherit a yes the fresh leg never gave. That invariant was broken
   *  until 2026-08-14 — the live path never called revokeSfuLeg at all — so if
   *  you are reading this while changing retirement, that is the thing not to
   *  break. Reviewer found it by reconnecting a real websocket; no unit test
   *  could, because the tests called revokeSfuLeg themselves. */
  standingConsent: Map<string, boolean>;
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
      //
      // 🔴 THIS PASSED A HARDCODED `null` PREV UNTIL 2026-08-16, which is
      // exactly the reset amendment 2 rejects: every process start produced
      // `i1-…` again, so a credential minted before a restart was
      // indistinguishable from one minted after. The comment above defends
      // OPACITY and never noticed it was also describing a RESET. The durable
      // implementation (atomic tmp+rename) existed the whole time in the
      // LiveKit adapter and was already booted — now in transport.ts, booted by
      // server.ts, so there is ONE incarnation per process and it survives a
      // restart. Found by an independent audit.
      incarnation: currentIncarnation(),
      sfu: new Sfu({ onNegotiationNeeded: (legId) => {
        const send = senders.get(legId);
        if (send) void sfuNegotiate(world, legId, send);
      } }),
      legs: new Map(), consent: new Map(), moderatorMuted: new Set(), usedNonces: new Set(),
      standingConsent: new Map(),
    };
    worlds.set(world, s);
  }
  return s;
}

/** legId → how to reach that leg's browser. The SFU itself never learns about
 *  websockets (it speaks SDP and RTP); the adapter owns this seam.
 *
 *  🔴 This replaces a per-WORLD callback that server.ts was supposed to install
 *  and never did — so onNegotiationNeeded fired into an empty map and a route
 *  that consent had already created sat in `pendingRoutes` forever. Measured:
 *  the listener showed pending:['smoke-a'] while the speaker pushed 1764
 *  packets into the SFU and nobody heard anything. A per-LEG registry cannot
 *  have that bug, because the same call that creates the leg registers it. */
const senders = new Map<string, (payload: unknown) => void>();
export function registerSfuSender(legId: string, send: (payload: unknown) => void) {
  senders.set(legId, send);
}

/** Mint: same shape as mintRelayCredential, minus the JWT that has no analogue. */
export function mintSfuCredential(world: string, id: string, primaryGen: number, mediaGen: number) {
  const s = sfuState(world);
  const nonce = crypto.randomUUID();
  s.legs.set(id, { id, gen: mediaGen, primaryGen, nonce });
  // 🔴 CREATE THE ACTUAL LEG. The first version recorded the bookkeeping entry
  // and stopped there, so negotiate() found "no leg <id>" and every browser sat
  // at active:false forever with no error anywhere — the credential minted, the
  // identity assigned, and nothing behind it. A record of a peer connection is
  // not a peer connection.
  s.sfu.createLeg(id, mediaGen);
  applyStandingConsent(s, id);   // consent given before this leg existed still counts
  // world/id/primaryGen ride along so the client can PRESENT the full claim set
  // on its next authenticated act (amendment 1). Without them the client could
  // only echo a nonce, and admitParticipant checks six things besides the nonce.
  return { nonce, incarnation: s.incarnation, identity: relayIdentity(id, mediaGen),
           world, id, primaryGen, mediaGen,
           transport: "sfu" as const, iceServers: iceServers() };
}

/** ICE servers handed to the browser with its credential — the `iceServers?`
 *  field SFU-SPEC.md:113 designed into mintLeg and nobody ever populated.
 *
 *  🔴 WHY THIS IS NOT "PHASE 2" (R, 2026-08-16, from a phone that could not be
 *  heard). SFU-SPEC.md:135 says "No TURN for phase 1 — TURN is a phase-2
 *  direct-pair concern", and I let that stand for STUN too. The reasoning was
 *  imported from the wrong topology: in a direct P2P pair BOTH ends sit behind
 *  NAT, which is the hard case deferred to phase 2. An SFU has exactly one
 *  reachable endpoint and every client dials OUT to it — so a client needs only
 *  to discover its own public address, which is what STUN does, statelessly and
 *  for free.
 *
 *  The mesh has always had this (client/lib/voice.js:33) and that is precisely
 *  why phone↔desktop worked on mesh and not here. Shipping an SFU that only
 *  carries audio between tabs on one machine would make "voice works" false for
 *  everyone not sitting at the server.
 *
 *  TURN genuinely IS deferred: it relays media, costs bandwidth, needs
 *  credentials, and is only required when STUN fails (symmetric NAT). Set
 *  SFU_ICE_SERVERS to a JSON array to add one, or to `[]` to force host-only
 *  (which is what the tests want — a loopback pair must not wait on a public
 *  STUN server that may not answer in CI).
 */
function iceServers(): { urls: string; username?: string; credential?: string }[] {
  const raw = process.env.SFU_ICE_SERVERS;
  if (raw !== undefined) {
    try { return JSON.parse(raw); }
    catch (e) {
      // 🔴 Do NOT silently fall back to the default here. An operator who set
      // this meant to change it; swallowing a typo would hand out a config they
      // did not choose and the symptom would be unreachable voice for exactly
      // the remote users this exists to serve.
      console.error(`[sfu] SFU_ICE_SERVERS is not valid JSON — refusing to guess:`,
        (e as Error).message);
      return [];
    }
  }
  return [{ urls: "stun:stun.l.google.com:19302" }];
}

/** Admission — amendment 1's seven refusals, decided by the SHARED decision
 *  layer. Synchronous here because we are the SFU: there is no third party to
 *  ask and no webhook to wait for. */
/** Add `useinbandfec=1` (and keep DTX off — a silence-suppressed stream and a
 *  dead one are indistinguishable to a listener, and our proximity gate already
 *  decides who is worth sending). Idempotent: an fmtp line that already asks
 *  for FEC is left alone rather than accumulating duplicate params. */
export function withOpusFec(sdp: string): string {
  const pt = /a=rtpmap:(\d+)\s+opus\/48000/i.exec(sdp)?.[1];
  if (!pt) return sdp;                       // no opus offered — nothing to ask for
  const fmtp = new RegExp(`a=fmtp:${pt} ([^\r\n]*)`);
  const m = fmtp.exec(sdp);
  if (!m) return sdp.replace(new RegExp(`(a=rtpmap:${pt}\\s+opus/48000[^\r\n]*)`),
                             `$1\r\na=fmtp:${pt} useinbandfec=1`);
  if (/useinbandfec=1/.test(m[1])) return sdp;
  return sdp.replace(fmtp, `a=fmtp:${pt} ${m[1]};useinbandfec=1`);
}

/** The sequencer's live view of an identity, for the admission gate. */
export function liveLegState(world: string, id: string, primaryGen?: number): LiveLegState {
  const s = sfuState(world);
  const leg = s.legs.get(id);
  return { world, incarnation: s.incarnation, primaryGen,
           mediaGen: leg?.gen, usedNonces: s.usedNonces };
}

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
  if (!r.changed) {
    // 🔴 A REFUSED REVOKE IS A PRIVACY FAILURE, NOT A NO-OP. Consent recorded
    // at one gen and revoked at another was rejected as a "stale listener
    // generation" — the browser showed consent OFF while audio kept flowing,
    // and the smoke caught it as `audio survived revocation`. Idempotence may
    // swallow a repeated YES; it must NEVER swallow a NO. When in doubt, the
    // quiet answer is the safe one, so a refused revoke still stops the audio.
    if (!recv) for (const speakerId of s.legs.keys()) s.sfu.setConsent(listenerId, speakerId, false);
    return r;
  }
  // 🔴 Apply to legs that DO NOT EXIST YET, too. This loop over s.legs misses
  // any speaker who joins after the listener consents — measured: consent ON
  // produced `hears: []` because the speaker's leg was registered later, and
  // the route only appeared by accident of ordering. Record the standing
  // answer so joinSfuLeg can honour it on arrival.
  s.standingConsent.set(listenerId, recv);
  for (const speakerId of s.legs.keys()) {
    if (speakerId === listenerId) continue;
    s.sfu.setConsent(listenerId, speakerId, recv);
  }
  return r;
}

/** Apply every existing listener's standing consent to a newly-arrived speaker,
 *  and the newcomer's own standing consent to everyone already here. Called
 *  when a leg is created, because consent is a STANDING answer about the room,
 *  not a statement about the participants who happened to be present when it
 *  was given. */
function applyStandingConsent(s: SfuWorldState, newLegId: string) {
  for (const [listenerId, recv] of s.standingConsent) {
    if (listenerId !== newLegId) s.sfu.setConsent(listenerId, newLegId, recv);
  }
  const mine = s.standingConsent.get(newLegId);
  if (mine !== undefined) {
    for (const otherId of s.legs.keys()) if (otherId !== newLegId) s.sfu.setConsent(newLegId, otherId, mine);
  }
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
  senders.delete(id);
  // A leg revoked mid-negotiation must not leave its resolver behind: for up to
  // 15s sfuAcceptAnswer would otherwise feed an SDP answer into a CLOSED pc,
  // where setRemoteDescription throws into a bare .catch and the failure is
  // swallowed into a console.error. Fails safe, but it is still a leak of a
  // live promise and a silenced error.
  waiting.delete(wkey(world, id));
  const s = worlds.get(world);
  if (!s) return null;
  const leg = s.legs.get(id) ?? null;
  s.legs.delete(id); s.consent.delete(id); s.moderatorMuted.delete(id);
  s.standingConsent.delete(id);
  // 🔴 Clear the SFU's mute too, or the two stores diverge: /relay-diag and the
  // moderator UI read s.moderatorMuted (now empty) while fanout still checks
  // sfu.muted (still set) and gags the speaker at ingress. Fails SAFE — silence,
  // not leakage — but a moderator cannot tell why someone is inaudible, which
  // is displayed-state-vs-real-state on a control surface.
  s.sfu.setMuted(id, false);
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
// 🔴 KEYED BY world+legId, NOT legId (independent review, 2026-08-16). Two
// worlds hosting the same participant id — routine, since ids are per-identity
// and not per-world — collided in this map: whichever leg answered first
// resolved the OTHER world's pending offer. Keyed properly, and cleared on
// revoke (see revokeSfuLeg) so a leg torn down mid-negotiation cannot leave a
// resolver behind for 15s waiting to feed an SDP answer to a closed pc.
const wkey = (world: string, legId: string) => `${world}\u0000${legId}`;
const waiting = new Map<string, (sdp: string) => void>();

/** Create the offer for `legId` and hand it to `send`. The browser answers via
 *  the `sfu-answer` verb, which resolves the promise this awaits. */
export async function sfuNegotiate(world: string, legId: string,
  send: (payload: unknown) => void) {
  const s = worlds.get(world);
  if (!s) return;
  // 🔴 AN OFFER WITH NOTHING IN IT NEVER CONNECTS. A leg with no routes yet
  // produces an SDP with ZERO m-lines: signaling completes (have-remote-offer →
  // stable) and ICE never starts, so connectionState sits at "new" forever with
  // no error on either side. Measured — the browser reported exactly that.
  //
  // A leg only gains routes when some OTHER participant consents to hear it, so
  // the first offer is empty by construction. We add a recvonly audio
  // transceiver as the floor: it gives ICE something to gather for, and it is
  // also honest — this leg WILL receive audio, we just do not know whose yet.
  // 🔴 THE FLOOR IS ABOUT *RECEIVING*, NOT ABOUT BEING EMPTY (2026-08-15).
  //
  // This used to read `getTransceivers().length === 0`, which is only true for
  // a leg that has no OUTBOUND routes yet. The moment a second person is in the
  // room, each leg gets a `sendonly` route to the other BEFORE its first
  // negotiation — so length is already 1, the floor is skipped, and the offer
  // contains no recvonly m-line at all. The server then never proposes to
  // RECEIVE, `ontrack` never fires, `leg.ingress` stays null, and diag reports
  // `publishing:false, rxPackets:0` while the publisher's own client correctly
  // reports `micPublished:true` and its stats show thousands of packets sent.
  //
  // Both ends were telling the truth about different halves of a connection
  // that was only ever negotiated in one direction. It reproduced as "my mic
  // doesn't work" for a human and "my voice doesn't work" for an agent — the
  // same defect, and it hid because the ALONE case (no routes → floor applied)
  // is exactly what every fresh single-client probe exercises.
  //
  // The honest condition: does this leg have a way to receive? If not, add one.
  const leg = s.sfu.getLeg(legId);
  if (leg && !leg.pc.getTransceivers().some((t: { direction?: string }) =>
        t.direction === "recvonly" || t.direction === "sendrecv")) {
    leg.pc.addTransceiver("audio", { direction: "recvonly" });
  }
  await s.sfu.negotiate(legId, async (pc) => {
    // Tell the client which speaker each new track carries BEFORE the offer
    // lands, so its ontrack can pair them in arrival order (see voicesfu.js).
    for (const speakerId of s.sfu.routesFor(legId)) send({ type: "sfu-route", speaker: speakerId });
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    // 🔴 ASK FOR FEC EXPLICITLY (#104 §8 item 4, "steal Basis's Opus
    // discipline"). We forward ENCODED Opus and never decode it, so the
    // BROWSER's encoder owns in-band FEC end-to-end — Chromium enables it by
    // default, which is why this worked without ever being requested. But
    // "works by default" is not a contract: a default can change, and a browser
    // that does not enable it fails silently and identically to packet loss.
    // Stating useinbandfec=1 in the fmtp makes it an agreed parameter rather
    // than a hope, and the client already measures fecPacketsReceived so the
    // claim has an instrument at the other end.
    send({ type: "sfu-offer", sdp: withOpusFec(pc.localDescription!.sdp) });
    const sdp = await new Promise<string>((resolve, reject) => {
      waiting.set(wkey(world, legId), resolve);
      // A browser that never answers must not wedge the leg's promise chain
      // forever — every later offer for this leg would queue behind it and the
      // participant would go permanently silent with no error anywhere.
      setTimeout(() => { if (waiting.delete(wkey(world, legId))) reject(new Error("answer timeout")); }, 15000);
    });
    await pc.setRemoteDescription({ type: "answer", sdp });
  }).catch((e) => console.error(`[sfu] negotiate ${legId}:`, (e as Error).message));
}

export function sfuAcceptAnswer(world: string, legId: string, sdp: string) {
  const resolve = waiting.get(wkey(world, legId));
  if (!resolve) return;                 // no offer outstanding — stale answer, drop
  waiting.delete(wkey(world, legId));
  resolve(sdp);
}

export function sfuAcceptIce(world: string, legId: string, candidate: unknown) {
  const s = worlds.get(world);
  s?.sfu.addIceCandidate(legId, candidate);
}

/** Feed the proximity gate. Optional — see the `sfu-pos` case in server.ts. */
export function sfuSetPosition(world: string, legId: string, x: number, y: number, z: number) {
  worlds.get(world)?.sfu.setPosition(legId, x, y, z);
}
