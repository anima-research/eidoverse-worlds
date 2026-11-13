/**
 * An in-process SFU: voice as an organ of the world server, so an operator runs one thing. WebRTC terminates here, so the
 * browser keeps its own jitter buffer, loss concealment, FEC and congestion control; we forward encoded Opus and never decode.
 * Every (listener, speaker) pair gets its own track, so there is no SSRC/sequence/timestamp rewriting and no server-side mixing.
 * Authority: none. Who may speak or hear, and which generation owns a leg, are decided in relaydecision.ts and enforced by the
 * caller; the SFU's only enforcement is mechanical: a pair with no consent is never fed. Future P2P offload: docs/research/sfu-p2p-offload.md.
 */
import { RTCPeerConnection, MediaStreamTrack, MediaStream, RTCRtpCodecParameters } from "werift";
import type { RtpPacket } from "werift";
import { transportErrorsSwallowed } from "./sfuguard.ts";

/** Opus, 48k stereo — the browser's default publish codec. Pinned so the
 *  answer never negotiates something we'd have to transcode. */
const AUDIO_CODEC = new RTCRtpCodecParameters({
  mimeType: "audio/opus", clockRate: 48000, channels: 2, payloadType: 111,
});

export interface SfuLeg {
  /** (id, surface, gen): a leg belongs to ONE generation; a takeover retires it rather than mutating it. */
  id: string;
  gen: number;
  pc: RTCPeerConnection;
  /** this leg's inbound mic, once the browser publishes it */
  ingress: MediaStreamTrack | null;
  /** Serializes renegotiation: two concurrent createOffer/setLocalDescription on one pc is SDP glare, and a lost offer
   *  can leave a route live in our map and invisible to the browser (silent). A queue removes the class. */
  negotiating: Promise<void>;
  /** speakerId → the route THIS leg hears that speaker on. `negotiated` is separate from existence: until its offer
   *  succeeds the browser has no receiver for the track (conflated, a silent route reads healthy in `diag`). */
  outbound: Map<string, { track: MediaStreamTrack; negotiated: boolean }>;
  /** packets received from this leg's mic (diagnostics + the fail-closed proof) */
  rxPackets: number;
  closed: boolean;
}

export class Sfu {
  private legs = new Map<string, SfuLeg>();
  /** listener → speaker → allowed. Absent means denied at both levels: an allowlist. Nested, not a joined key: an id may
   *  contain NUL (parseRelayIdentity accepts `.{1,64}`), so a NUL-joined key is not injective. */
  private consent = new Map<string, Map<string, boolean>>();
  /** speakers a moderator has silenced: enforced at INGRESS, so a muted
   *  speaker is inaudible to everyone at once and cannot be routed around. */
  private muted = new Set<string>();
  /** listeners the server has made deaf: overrides their own consent, which they could turn back on */
  private deafened = new Set<string>();
  private forwarded = 0;

  /** Legs with tracks added but not yet offered. COALESCED: werift adds a transceiver per exchange, so one exchange per
   *  route inflates the SDP and double-delivers; three routes need ONE exchange. */
  private dirty = new Set<string>();

  // the werift UDP-error guard (sfuguard.ts) is installed once by server.ts at boot, never here: a constructor must not
  // change process-wide crash semantics
  constructor(private opts: { onNegotiationNeeded?: (legId: string) => void } = {}) {}

  /** Last known world position per leg, and when we heard it. */
  private pos = new Map<string, { x: number; y: number; z: number; at: number }>();
  /** Packets suppressed because nobody could have heard them. Diagnostic only. */
  gated = 0;
  /** Packets suppressed by the per-listener speaker cap. Diagnostic only. */
  capped = 0;
  /** listener → speakerIds currently holding an audible slot. */
  private slots = new Map<string, Set<string>>();

  /** Client rolloff is FULL_M=3 → SILENT_M=20 (client/lib/audio/voicesfubridge.js), so beyond SILENT_M the listener hears exactly
   *  zero. Hysteresis, not a fixed margin: an exit threshold 10% beyond enter, keyed on previous state, or each flap is an audible cut. */
  private static readonly ENTER_M = 20;      // start forwarding within this
  private static readonly HYSTERESIS = 1.10; // …stop only beyond 10% further (Basis's value)
  private static readonly POS_STALE_MS = 5000;

  /** Hard cap on simultaneous speakers per listener (Basis's BasisAudioCapJob): forty people in one plaza all pass the
   *  distance gate, so without it the worst case is N². 0 disables it (the default: dropping a speaker is policy). */
  maxAudiblePerListener = 0;
  /** An incumbent's squared distance is multiplied by this when competing for a slot, so a newcomer must be
   *  MEANINGFULLY closer (else two near-equal speakers swap the last slot every tick). Basis's StickinessBonus. */
  private static readonly STICKINESS = 0.8;
  /** Was this pair audible last time? The memory hysteresis needs. Nested for the same reason consent is. */
  private inRange = new Map<string, Map<string, boolean>>();

  /** Tell the SFU where a participant is. OPTIONAL: a world that never calls this never gates. */
  setPosition(legId: string, x: number, y: number, z: number, now = Date.now()) {
    this.pos.set(legId, { x, y, z, at: now });
  }

  /** Could `listener` possibly hear `speaker`? Unknown or stale → YES.
   *  Hysteresis: a pair already in range stays in range until 10% further out. */
  private inEarshot(listenerId: string, speakerId: string, now = Date.now()): boolean {
    const a = this.pos.get(listenerId), b = this.pos.get(speakerId);
    if (!a || !b) return true;                                   // unknown → forward
    if (now - a.at > Sfu.POS_STALE_MS || now - b.at > Sfu.POS_STALE_MS) return true;  // stale → forward
    const dx = a.x - b.x, dy = a.y - b.y, dz = a.z - b.z;
    const d2 = dx * dx + dy * dy + dz * dz;    // squared: no sqrt on the packet path
    const enter = Sfu.ENTER_M * Sfu.ENTER_M;
    const exit = enter * Sfu.HYSTERESIS * Sfu.HYSTERESIS;
    let row = this.inRange.get(listenerId);
    const was = row?.get(speakerId) === true;
    const nowIn = was ? d2 < exit : d2 < enter;
    if (nowIn !== was) {
      if (!row) { row = new Map(); this.inRange.set(listenerId, row); }
      row.set(speakerId, nowIn);
    }
    return nowIn;
  }

  /** Does `speaker` hold one of `listener`'s audible slots? Recomputed lazily on the packet path: the set only changes
   *  when a speaker not in it wants in, which is exactly when that speaker has a packet to forward. */
  private withinCap(listenerId: string, speakerId: string): boolean {
    const cap = this.maxAudiblePerListener;
    if (cap <= 0) return true;                                   // disabled → everyone
    let held = this.slots.get(listenerId);
    if (!held) { held = new Set(); this.slots.set(listenerId, held); }
    if (held.has(speakerId)) return true;                        // already audible → keep
    if (held.size < cap) { held.add(speakerId); return true; }    // room to spare

    // Full. Displace the furthest holder, but only if this speaker is closer
    // than that holder's STICKINESS-discounted distance.
    const me = this.d2(listenerId, speakerId);
    if (me === null) return true;                                // no positions → cannot rank, admit
    let worstId: string | null = null, worstD2 = -1;
    for (const h of held) {
      const d = this.d2(listenerId, h);
      if (d === null) continue;
      const effective = d * Sfu.STICKINESS;                      // incumbents are sticky
      if (effective > worstD2) { worstD2 = effective; worstId = h; }
    }
    if (worstId !== null && me < worstD2) {
      held.delete(worstId); held.add(speakerId);
      // The displaced speaker also loses its hysteresis memory, so it must
      // re-enter range cleanly rather than inheriting a stale "was in" bit.
      this.inRange.get(listenerId)?.delete(worstId);
      return true;
    }
    return false;
  }

  /** Squared distance between two legs, or null if either position is unknown or stale. One staleness rule: a position
   *  inEarshot would not gate on, withinCap may not rank on either (else the cap drops what the gate passed). */
  private d2(a: string, b: string, now = Date.now()): number | null {
    const p = this.pos.get(a), q = this.pos.get(b);
    if (!p || !q) return null;
    if (now - p.at > Sfu.POS_STALE_MS || now - q.at > Sfu.POS_STALE_MS) return null;
    const dx = p.x - q.x, dy = p.y - q.y, dz = p.z - q.z;
    return dx * dx + dy * dy + dz * dz;
  }

  private allows(listener: string, speaker: string): boolean {
    if (this.deafened.has(listener)) return false;
    return this.consent.get(listener)?.get(speaker) === true;   // absent = denied, both levels
  }

  /** Create a leg for an already-authenticated participant: the websocket proved identity, so the leg IS the
   *  authorization (revoking is a local pc.close()). */
  createLeg(id: string, gen: number): SfuLeg {
    this.closeLeg(id);                       // one body per identity (takeover)
    // measured at 12 m-lines: default createOffer 2021 ms; max-bundle 176 ms; without IPv6 61 ms
    const pc = new RTCPeerConnection({
      codecs: { audio: [AUDIO_CODEC] },
      bundlePolicy: "max-bundle",
      iceUseIpv6: false,
    });
    const leg: SfuLeg = { id, gen, pc, ingress: null, negotiating: Promise.resolve(),
                          outbound: new Map(), rxPackets: 0, closed: false };


    pc.ontrack = (e) => {
      // subscribe once: ontrack fires per transceiver and after each renegotiation; re-subscribing forwards every packet N times
      if (leg.ingress) return;
      leg.ingress = e.track;
      e.track.onReceiveRtp.subscribe((rtp) => this.fanout(leg, rtp));
    };
    this.legs.set(id, leg);
    return leg;
  }

  /** The hot path. One packet in, zero-or-more out, the policy checks in the order that fails cheapest first.
   *  (A future P2P offload check sits beside the proximity gate: docs/research/sfu-p2p-offload.md.) */
  private fanout(from: SfuLeg, rtp: RtpPacket) {
    // the closed check comes first: werift's subscription outlives the leg, so packets still arrive after closeLeg
    if (from.closed || this.muted.has(from.id)) return;   // moderator mute: at the source
    from.rxPackets++;
    for (const [listenerId, listener] of this.legs) {
      if (listenerId === from.id || listener.closed) continue;
      if (!this.allows(listenerId, from.id)) continue;         // absent = denied
      // Proximity gate, AFTER consent so it can only SUBTRACT (a hint, never an authorization). Unknown or stale
      // positions forward: fail-OPEN, since a wrong gate costs silence and forwarding costs only bandwidth.
      if (!this.inEarshot(listenerId, from.id)) { this.gated++; continue; }
      if (!this.withinCap(listenerId, from.id)) { this.capped++; continue; }
      const route = listener.outbound.get(from.id);
      if (!route) continue;                  // no route = not heard
      route.track.writeRtp(rtp);             // encoded Opus, straight through
      this.forwarded++;
    }
  }

  /** Speaker ids this leg has routes for, in insertion order (a Map's): the order werift added the transceivers, hence
   *  the order the browser's ontrack fires (client/lib/audio/voicesfu.js). */
  routesFor(legId: string): string[] {
    return [...(this.legs.get(legId)?.outbound.keys() ?? [])];
  }

  /** Trickle ICE from the browser. An unknown leg or malformed candidate is dropped, never thrown (normal churn). */
  addIceCandidate(legId: string, candidate: unknown) {
    const leg = this.legs.get(legId);
    if (!leg || leg.closed || !candidate) return;
    try { void leg.pc.addIceCandidate(candidate as RTCIceCandidate); } catch {}
  }

  /** Give `listener` a track to hear `speaker` on. Separate from consent on purpose: a negotiated track can be starved,
   *  so flipping consent is a memory write, not an SDP round trip. */
  ensureRoute(listenerId: string, speakerId: string): boolean {
    const listener = this.legs.get(listenerId);
    if (!listener || listener.closed || listenerId === speakerId) return false;
    const existing = listener.outbound.get(speakerId);
    if (existing) {
      // a route that exists but never negotiated is re-asked, or one failed exchange silences the pair forever
      if (!existing.negotiated) this.askToNegotiate(listenerId);
      return false;
    }
    const track = new MediaStreamTrack({ kind: "audio" });
    // identity rides with the track: the speaker id is the msid (e.streams[0].id in the browser), never inferred from arrival
    // order. werift derives msid from the sender's `streams`, not from fields on MediaStreamTrack.
    const stream = new MediaStream({ id: speakerId, tracks: [track] });
    listener.outbound.set(speakerId, { track, negotiated: false });
    listener.pc.addTransceiver(track, { direction: "sendonly", streams: [stream] } as any);
    // the server must offer, not answer: a browser's mic offer is `sendonly`, and an answer can't add a receive direction
    this.askToNegotiate(listenerId);
    return true;
  }

  /** Coalesced "this leg needs an offer": one ask per leg per microtask however many routes were added (werift adds a
   *  transceiver per exchange, so N asks inflate the SDP and double-deliver). */
  private askToNegotiate(legId: string) {
    if (this.dirty.has(legId)) return;
    const leg = this.legs.get(legId);
    if (!leg || leg.closed) return;
    this.dirty.add(legId);
    queueMicrotask(() => {
      if (!this.dirty.delete(legId)) return;
      // check leg identity, not just the id: a takeover in between replaces the leg
      if (this.legs.get(legId) !== leg || leg.closed) return;
      try {
        this.opts.onNegotiationNeeded?.(legId);
      } catch (e) {
        // the hook is the caller's code: a throw escaping queueMicrotask would kill the world server
        console.error(`[sfu:${legId}] onNegotiationNeeded threw`, e);
      }
    });
  }

  /** Run an SDP exchange for this leg, SERIALIZED against every other one for it. The caller supplies the signaling;
   *  we own only the ordering. Chained onto the previous promise, so one that throws doesn't wedge the next. */
  negotiate(legId: string, exchange: (pc: RTCPeerConnection) => Promise<void>): Promise<void> {
    const leg = this.legs.get(legId);
    if (!leg || leg.closed) return Promise.reject(new Error(`no leg ${legId}`));
    const run = leg.negotiating.then(async () => {
      if (leg.closed) return;
      // snapshot before, mark only those: a route added after the offer was created isn't in that SDP and gets its own ask
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

  /** Listener consent, server-enforced. Not a sender-declared recipient list: that is the weaker guarantee. */
  setConsent(listenerId: string, speakerId: string, allowed: boolean) {
    let row = this.consent.get(listenerId);
    if (!row) { row = new Map(); this.consent.set(listenerId, row); }
    row.set(speakerId, allowed);
    if (allowed) this.ensureRoute(listenerId, speakerId);
  }

  setMuted(speakerId: string, muted: boolean) {
    if (muted) this.muted.add(speakerId); else this.muted.delete(speakerId);
  }

  setDeafened(listenerId: string, deaf: boolean) {
    if (deaf) this.deafened.add(listenerId); else this.deafened.delete(listenerId);
  }

  /** Revocation. Local and immediate — no webhook, no credential TTL, no
   *  replay window: the packets stop because the socket is gone. */
  closeLeg(id: string) {
    const leg = this.legs.get(id);
    if (!leg) return;
    leg.closed = true;
    // routes survive the speaker: werift keeps a transceiver forever, and routes are keyed and msid'd by speaker id, so a
    // same-id successor reuses the track. No audio leaks: consent for the retired id is wiped below, and an unconsented route is starved.
    try { leg.pc.close(); } catch { /* already dead */ }
    this.legs.delete(id);
    this.pos.delete(id);
    this.slots.delete(id);
    for (const held of this.slots.values()) held.delete(id);
    this.inRange.delete(id);
    for (const row of this.inRange.values()) row.delete(id);
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
        // a pending route is NOT "hears": surfaced separately so a stuck one is visible
        pendingRoutes: [...l.outbound.entries()].filter(([, r]) => !r.negotiated).map(([id]) => id),
        publishing: !!l.ingress,
        state: l.pc.connectionState,
      })),
      forwarded: this.forwarded,
      // suppression belongs in the same report as delivery: a cheaper server that drops more is not healthier
      suppressed: { gated: this.gated, capped: this.capped },
      muted: [...this.muted],
      deafened: [...this.deafened],
      transportErrorsSwallowed: transportErrorsSwallowed(),
    };
  }

  closeAll() { for (const id of [...this.legs.keys()]) this.closeLeg(id); }
}
