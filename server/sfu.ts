/**
 * An in-process SFU — voice as an organ of the world server, not a service
 * beside it.
 *
 * #104 §8.1 leaves the relay implementation to the spike ("Galène and LiveKit
 * are hypotheses; the spike decides against one acceptance table"). This is a
 * third hypothesis: forward encoded Opus ourselves, in this process, so an
 * operator runs ONE thing and voice costs them nothing.
 *
 * WHY THIS IS SMALL, stated once because it is the whole argument:
 * we terminate WebRTC server-side, so the BROWSER keeps getUserMedia →
 * addTrack and therefore keeps its own jitter buffer, packet-loss concealment,
 * FEC and congestion control. We forward ENCODED Opus and never decode it.
 * Basis hand-built ~750 lines of jitter buffer + PLC + FEC + loss estimation
 * because Unity has no usable WebRTC stack; we are browser-first and do not
 * inherit that cost. (Basis read 2026-08-14; MIT, © 2024 Luke Doolan.)
 *
 * THE BIGGEST SFU TRAP, SIDESTEPPED: mixing two sources into one track forces
 * SSRC/sequence/timestamp rewriting. We give every (listener, speaker) pair its
 * own track, so no two sources ever share a stream — no rewriting exists to get
 * wrong. It also keeps one-stream-per-speaker, which #104's acceptance table
 * requires for client spatialization, and avoids server-side mixing, which
 * #104 rejects outright as the MCU mistake.
 *
 * AUTHORITY: none. This file moves bytes. Who may speak, who may hear, and
 * which generation owns a leg are decided in relaydecision.ts and enforced by
 * the caller. The SFU's only enforcement is mechanical: a pair with no consent
 * is never fed, so a modified client cannot hear what the server didn't send.
 */
import { RTCPeerConnection, MediaStreamTrack, RTCRtpCodecParameters } from "werift";
import type { RtpPacket } from "werift";
import { installSfuTransportGuard, transportErrorsSwallowed } from "./sfuguard.ts";

/** Opus, 48k stereo — the browser's default publish codec. Pinned so the
 *  answer never negotiates something we'd have to transcode. */
const AUDIO_CODEC = new RTCRtpCodecParameters({
  mimeType: "audio/opus", clockRate: 48000, channels: 2, payloadType: 111,
});

export interface SfuLeg {
  /** (id, surface, gen) — the #103 binding. A leg belongs to ONE generation;
   *  a takeover retires it rather than mutating it. */
  id: string;
  gen: number;
  pc: RTCPeerConnection;
  /** this leg's inbound mic, once the browser publishes it */
  ingress: MediaStreamTrack | null;
  /** Serializes renegotiation. Two people joining at once means two offers on
   *  THIS pc, and concurrent createOffer/setLocalDescription is SDP glare —
   *  the failure class that grew the mesh's voice.js to 1388 lines of courtship
   *  and rank arbitration. Measured before this existed: `Promise.allSettled`
   *  on two concurrent offers returned "rejected, fulfilled". It happened to
   *  work only because the surviving offer carried both tracks; had the loser
   *  carried a track the winner lacked, that route would be live in our map and
   *  invisible to the browser — silent, like every other bug this file has had.
   *  A queue is ~6 lines and removes the class. */
  negotiating: Promise<void>;
  /** speakerId → the route THIS leg hears that speaker on. `negotiated` is
   *  separate from existence: a track can be created and added to the PC while
   *  its offer has not yet succeeded, and until it does the browser has no
   *  receiver for it. Conflating the two produced a permanently silent route
   *  that `diag` reported as healthy (adversarial review B2). */
  outbound: Map<string, { track: MediaStreamTrack; negotiated: boolean }>;
  /** packets received from this leg's mic (diagnostics + the fail-closed proof) */
  rxPackets: number;
  closed: boolean;
}

export class Sfu {
  private legs = new Map<string, SfuLeg>();
  /** listener → speaker → allowed. ABSENT MEANS DENIED at BOTH levels — an
   *  allowlist, so a consent we never heard about cannot leak audio.
   *
   *  🔴 NESTED, not a joined key. `listener + NUL + speaker` is NOT injective
   *  when an id may itself contain NUL: ("a","b\0c") and ("a\0b","c") both
   *  produce `a\0b\0c`, so one pair's revoke silently revokes — or GRANTS —
   *  another's. `parseRelayIdentity` accepts `.{1,64}`, which does not exclude
   *  NUL, so nothing upstream prevented it (review item 7). Nesting also
   *  removes a string allocation per (packet × listener) — ~6600/s in a
   *  12-person room (item 9). */
  private consent = new Map<string, Map<string, boolean>>();
  /** speakers a moderator has silenced: enforced at INGRESS, so a muted
   *  speaker is inaudible to everyone at once and cannot be routed around. */
  private muted = new Set<string>();
  private forwarded = 0;

  /** Legs with tracks added but not yet offered. COALESCED on purpose: adding
   *  three routes to one leg needs ONE exchange carrying all three, not three
   *  exchanges — and werift adds a transceiver per exchange, so the wasteful
   *  version also inflates the SDP and double-delivers (measured: 3 transceivers
   *  for 2 tracks, listener hearing 60 packets for 30 forwarded). The caller
   *  should not have to know that; the SFU asks once and means once. */
  private dirty = new Set<string>();

  constructor(private opts: { onNegotiationNeeded?: (legId: string) => void } = {}) {
    // werift leaves its UDP socket's 'error' unbound, which crashes the process
    // when a peer dies mid-fanout. See sfuguard.ts — narrow by design.
    installSfuTransportGuard();
  }

  private allows(listener: string, speaker: string): boolean {
    return this.consent.get(listener)?.get(speaker) === true;   // absent = denied, both levels
  }

  /** Create a leg for an already-authenticated participant. There is no
   *  credential to mint and no webhook to admit: the websocket proved identity
   *  before we got here, so the leg IS the authorization. (This is what
   *  collapses LiveKit's A1 credential + webhook-admission surface — and with
   *  it the 4.7s webhook-bound revocation window, since revoking is now a
   *  local pc.close().) */
  createLeg(id: string, gen: number): SfuLeg {
    this.closeLeg(id);                       // one body per identity (#57 takeover)
    // Measured (werift survey, N=12): default createOffer with 12 m-lines took
    // 2021ms and gathered 96 candidates; max-bundle alone → 176ms; dropping
    // IPv6 → 61ms. At this m-line count these are not tuning, they are the
    // difference between a usable join and a two-second stall.
    const pc = new RTCPeerConnection({
      codecs: { audio: [AUDIO_CODEC] },
      bundlePolicy: "max-bundle",
      iceUseIpv6: false,
    });
    const leg: SfuLeg = { id, gen, pc, ingress: null, negotiating: Promise.resolve(),
                          outbound: new Map(), rxPackets: 0, closed: false };


    pc.ontrack = (e) => {
      // 🔴 SUBSCRIBE ONCE. ontrack fires per transceiver AND again after each
      // renegotiation, so re-subscribing here stacks handlers and every packet
      // is forwarded N times — silently, since each copy is individually
      // correct. Caught by the load test reading exactly 200% delivery at both
      // N=3 and N=12 (one renegotiation = one extra subscription).
      if (leg.ingress) return;
      leg.ingress = e.track;
      e.track.onReceiveRtp.subscribe((rtp) => this.fanout(leg, rtp));
    };
    this.legs.set(id, leg);
    return leg;
  }

  /** The hot path. One packet in, zero-or-more out — with the policy checks
   *  in the order that fails cheapest first. */
  private fanout(from: SfuLeg, rtp: RtpPacket) {
    // 🔴 D2: the closed check comes FIRST. werift's onReceiveRtp subscription
    // outlives the leg (we cannot unsubscribe what we did not keep), so
    // in-flight packets still arrive after closeLeg — and counting them made a
    // corpse look like it was still publishing.
    if (from.closed || this.muted.has(from.id)) return;   // moderator mute: at the source
    from.rxPackets++;
    for (const [listenerId, listener] of this.legs) {
      if (listenerId === from.id || listener.closed) continue;
      if (!this.allows(listenerId, from.id)) continue;         // absent = denied
      const route = listener.outbound.get(from.id);
      if (!route) continue;                  // no route = not heard
      route.track.writeRtp(rtp);             // encoded Opus, straight through
      this.forwarded++;
    }
  }

  /** Give `listener` a track to hear `speaker` on. Separate from consent on
   *  purpose: the track can exist (negotiated, stable SDP) while starved of
   *  packets, so flipping consent costs no renegotiation — which is what makes
   *  consent latency a memory write instead of an SDP round trip. */
  ensureRoute(listenerId: string, speakerId: string): boolean {
    const listener = this.legs.get(listenerId);
    if (!listener || listener.closed || listenerId === speakerId) return false;
    const existing = listener.outbound.get(speakerId);
    if (existing) {
      // 🔴 B2: a route that exists but never NEGOTIATED must be re-asked. The
      // old `has() → return false` meant one failed exchange (socket blip,
      // backgrounded tab, a throwing caller) silenced that pair FOREVER: the
      // track survived, no further ask was ever scheduled, and diag reported
      // the listener as hearing the speaker. Measured: forwarded=15, heard=0,
      // diag green. Same silent shape as every other bug in this file.
      if (!existing.negotiated) this.askToNegotiate(listenerId);
      return false;
    }
    const track = new MediaStreamTrack({ kind: "audio" });
    listener.outbound.set(speakerId, { track, negotiated: false });
    listener.pc.addTransceiver(track, { direction: "sendonly" });
    // 🔴 THE SERVER MUST OFFER, NOT ANSWER. A browser publishing its mic offers
    // `sendonly`, and an answer cannot add a receive direction the offer never
    // proposed — so answering a browser re-offer silently produces a route that
    // forwards packets into a track nobody is receiving. (Cost me the one red
    // test: diag.forwarded=20 while the listener heard 0.) Hence this hook means
    // "SFU: create an offer for this leg", never "ask the browser to re-offer".
    this.askToNegotiate(listenerId);
    return true;
  }

  /** Coalesced "this leg needs an offer". One ask per leg per microtask however
   *  many routes were added — werift adds a transceiver per exchange, so N asks
   *  inflate the SDP and double-deliver. */
  private askToNegotiate(legId: string) {
    if (this.dirty.has(legId)) return;
    const leg = this.legs.get(legId);
    if (!leg || leg.closed) return;
    this.dirty.add(legId);
    queueMicrotask(() => {
      if (!this.dirty.delete(legId)) return;
      // 🔴 B1: check leg IDENTITY, not just the id. A takeover between the add
      // and the microtask replaces the leg, and the old code fired the ask
      // against the SUCCESSOR — which has no routes, so it was a wasted
      // exchange today and a wrong-generation offer once gen is enforced.
      if (this.legs.get(legId) !== leg || leg.closed) return;
      try {
        this.opts.onNegotiationNeeded?.(legId);
      } catch (e) {
        // 🔴 B4: the hook is the CALLER's code. A throw here used to escape a
        // bare queueMicrotask, become an uncaughtException, and kill the world
        // server. A caller bug must not be fatal to everyone else's audio.
        console.error(`[sfu:${legId}] onNegotiationNeeded threw`, e);
      }
    });
  }

  /** Run an SDP exchange for this leg, SERIALIZED against every other one for
   *  the same leg. The caller supplies the actual signaling (it owns the `rtc`
   *  verb and the socket); we own only the ordering. Chaining onto the previous
   *  promise — rather than a lock with a queue — means an exchange that throws
   *  does not wedge the next one, since we swallow into the chain and let the
   *  caller see its own rejection. */
  negotiate(legId: string, exchange: (pc: RTCPeerConnection) => Promise<void>): Promise<void> {
    const leg = this.legs.get(legId);
    if (!leg || leg.closed) return Promise.reject(new Error(`no leg ${legId}`));
    const run = leg.negotiating.then(async () => {
      if (leg.closed) return;
      // 🔴 SNAPSHOT BEFORE, MARK ONLY THOSE. Marking every route after the
      // exchange resurrected B2 one level deeper: a route added AFTER the offer
      // was created cannot be in that SDP, but got marked negotiated anyway —
      // silent forever, with diag reporting it as heard. Measured: hears
      // ["s1","s2"], pendingRoutes [], listener heard 0 of 12.
      // Snapshotting means a route that arrived mid-exchange stays pending and
      // gets its own ask, which is exactly what the un-negotiated path is for.
      const covered = [...leg.outbound.keys()];
      await exchange(leg.pc);
      let stillPending = false;
      for (const [speakerId, r] of leg.outbound) {
        if (covered.includes(speakerId)) r.negotiated = true;
        else stillPending = true;
      }
      if (stillPending) this.askToNegotiate(legId);   // the latecomer gets its own round
    });
    leg.negotiating = run.catch(() => {});      // a failure must not wedge the queue
    return run;
  }

  /** Listener-consent, server-enforced (#104 A3). Deliberately NOT Basis's
   *  sender-declared recipient list: there the speaker picks who hears them,
   *  which is the weaker guarantee. */
  setConsent(listenerId: string, speakerId: string, allowed: boolean) {
    let row = this.consent.get(listenerId);
    if (!row) { row = new Map(); this.consent.set(listenerId, row); }
    row.set(speakerId, allowed);
    if (allowed) this.ensureRoute(listenerId, speakerId);
  }

  setMuted(speakerId: string, muted: boolean) {
    if (muted) this.muted.add(speakerId); else this.muted.delete(speakerId);
  }

  /** Revocation. Local and immediate — no webhook, no credential TTL, no
   *  replay window: the packets stop because the socket is gone. */
  closeLeg(id: string) {
    const leg = this.legs.get(id);
    if (!leg) return;
    leg.closed = true;
    for (const [, l] of this.legs) l.outbound.delete(id);   // nobody hears a corpse
    try { leg.pc.close(); } catch { /* already dead */ }
    this.legs.delete(id);
    this.consent.delete(id);                       // everything this leg consented to
    for (const row of this.consent.values()) row.delete(id);   // everyone's consent TO it
  }

  getLeg(id: string) { return this.legs.get(id); }

  /** /relay-diag keeps working, and the numbers are the ones that matter for
   *  the acceptance table: is anything arriving, is anything leaving. */
  diag() {
    return {
      legs: [...this.legs.values()].map((l) => ({
        id: l.id, gen: l.gen, rxPackets: l.rxPackets,
        hears: [...l.outbound.entries()].filter(([, r]) => r.negotiated).map(([id]) => id),
        // A pending route is NOT "hears" — reporting it as such is what made
        // the B2 bug invisible. Surfaced separately so a stuck one is visible.
        pendingRoutes: [...l.outbound.entries()].filter(([, r]) => !r.negotiated).map(([id]) => id),
        publishing: !!l.ingress,
        state: l.pc.connectionState,
      })),
      forwarded: this.forwarded,
      muted: [...this.muted],
      transportErrorsSwallowed: transportErrorsSwallowed(),
    };
  }

  closeAll() { for (const id of [...this.legs.keys()]) this.closeLeg(id); }
}
