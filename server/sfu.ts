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
import { RTCPeerConnection, MediaStreamTrack, MediaStream, RTCRtpCodecParameters } from "werift";
import type { RtpPacket } from "werift";
import { transportErrorsSwallowed } from "./sfuguard.ts";

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

  // werift leaves its UDP socket's 'error' unbound, which crashes the process
  // when a peer dies mid-fanout — see sfuguard.ts. The guard that swallows it is
  // installed ONCE by server.ts at boot, not here: a constructor must not change
  // process-wide crash semantics for a whole world server.
  constructor(private opts: { onNegotiationNeeded?: (legId: string) => void } = {}) {}

  /** Last known world position per leg, and when we heard it. */
  private pos = new Map<string, { x: number; y: number; z: number; at: number }>();
  /** Packets suppressed because nobody could have heard them. Diagnostic only. */
  gated = 0;
  /** Packets suppressed by the per-listener speaker cap. Diagnostic only. */
  capped = 0;
  /** listener → speakerIds currently holding an audible slot. */
  private slots = new Map<string, Set<string>>();

  /** Client rolloff is FULL_M=3 → SILENT_M=20 (client/lib/voicesfubridge.js:145;
   *  this cited voicerelay.js until the LiveKit client was deleted), so
   *  beyond SILENT_M the listener multiplies the stream by exactly zero.
   *
   *  🔴 HYSTERESIS, not a fixed margin. My first version added MARGIN_M=10 with a
   *  plausible story about sprint speed; reading BasisDistanceJob.cs:74-84 showed
   *  the real mechanism — an EXIT threshold 10% further than the ENTER threshold,
   *  keyed on previous state (`prevVoice ? d2 < voiceExit : d2 < voiceEnter`).
   *  A margin does not stop flapping: someone standing at exactly the cutoff
   *  toggles on every position update, and each toggle is an audible cut. Two
   *  thresholds with memory cannot flap, which is why every VR stack does it this
   *  way. Cost: one bool per pair. */
  private static readonly ENTER_M = 20;      // start forwarding within this
  private static readonly HYSTERESIS = 1.10; // …stop only beyond 10% further (Basis's value)
  private static readonly POS_STALE_MS = 5000;

  /** Hard cap on simultaneous speakers per listener, mirroring Basis's
   *  BasisAudioCapJob. Distance alone is NOT enough: forty people in one plaza
   *  are all within 20m of each other, so the gate passes every pair and we are
   *  back to N². A cap bounds the worst case at N×MAX_AUDIBLE instead.
   *
   *  0 disables the cap (the default — an operator opts in, because silently
   *  dropping a speaker is a policy choice, not a default we should impose). */
  maxAudiblePerListener = 0;
  /** Someone already audible gets their squared distance multiplied by this when
   *  competing for a slot, so a newcomer must be MEANINGFULLY closer to displace
   *  them. Without it, two people at nearly equal distance swap the last slot
   *  every tick and both stutter. Basis calls it StickinessBonus. */
  private static readonly STICKINESS = 0.8;
  /** Was this pair audible last time? The memory that makes hysteresis work.
   *  🔴 NESTED for the same reason consent is: `listener + NUL + speaker` is not
   *  injective when ids may contain NUL. I re-introduced the joined key here
   *  three commits after fixing it in consent — the shape is seductive. */
  private inRange = new Map<string, Map<string, boolean>>();

  /** Tell the SFU where a participant is. Positions are OPTIONAL — a world that
   *  never calls this simply never gates, which is why this cannot break an
   *  existing deployment. */
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

  /** Does `speaker` hold one of `listener`'s audible slots?
   *
   *  🔴 Recomputed lazily on the PACKET path rather than on a timer, because a
   *  timer would need to know when anyone moved. The set only changes when a
   *  speaker who is NOT currently in it wants in — which is exactly when we can
   *  afford the O(k) comparison, since that speaker is by definition producing a
   *  packet we were about to forward anyway. */
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

  /** Squared distance between two legs, or null if either position is unknown. */
  private d2(a: string, b: string): number | null {
    const p = this.pos.get(a), q = this.pos.get(b);
    if (!p || !q) return null;
    const dx = p.x - q.x, dy = p.y - q.y, dz = p.z - q.z;
    return dx * dx + dy * dy + dz * dz;
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
  // ═══════════════════════════════════════════════════════════════════════
  // 🔮 FUTURE: P2P OFFLOAD — where it plugs in, and why it plugs in HERE.
  //
  // The settled architecture (#104) is relay-floor with P2P as deferred phase 2:
  // the SFU always works, and a pair that manages a direct connection stops
  // paying for the relay hop. Basis has shipped exactly this; the pieces to
  // steal, with file:line, are in notes/SFU-HANDOFF.md. The short version:
  //
  //   • THE HOOK IS THIS LOOP. Basis checks `IsP2POffloaded(sender, client)` in
  //     its fanout (BasisServerHandleEvents.cs:995) and skips the send. Ours
  //     would be one more `continue` right beside the proximity gate — the gate
  //     and the offload check are the same SHAPE (both answer "does this packet
  //     need to traverse the relay?"), which is why they belong adjacent.
  //
  //   • FAST-PATH THE COMMON CASE. `HasOffloadedPairs` is a volatile int compare
  //     that short-circuits before any map lookup, because zero-offload is
  //     overwhelmingly common (BasisServerP2PBroker.cs:44-58). At 12 people it
  //     hardly matters; at their 1000 it removes a million hash lookups a tick.
  //     Our proximity gate should learn the same trick if `pos` is ever empty.
  //
  //   • PAIRS ARE UNORDERED. They pack (lo,hi) into a long so a pair has ONE
  //     identity regardless of direction. Ours must too — and note this is the
  //     third place in this file wanting a pair key, after consent and inRange.
  //     If a fourth appears, extract a PairMap<T> rather than joining strings;
  //     the NUL-join collision has already been found here twice.
  //
  //   • THE HARD PART IS NOT THE PLUMBING, IT IS THE WATCHDOG. A direct link
  //     that dies silently is WORSE than no direct link, because both ends think
  //     they are connected and neither hears anything. Basis extracted that
  //     decision logic into BasisP2PLinkHealth.cs specifically so it could be
  //     unit-tested headless (their client is Unity-only) — the same move we
  //     made with relaydecision.ts, arrived at independently. Their verdicts:
  //       DemoteStale        — no inbound past staleMs → path is dead/one-way
  //       DemoteUnconfirmed  — reached Connected but the server never confirmed
  //       ClearFlapCounter   — healthy long enough to forget past flapping
  //     …with a post-connect GRACE window where demotion is never allowed, and
  //     staleness checked BEFORE unconfirmed so the reported reason is specific.
  //     Copy that structure into relaydecision.ts (transport-agnostic, already
  //     the regression anchor) rather than inventing new thresholds.
  //
  //   • DEMOTION MUST BE INVISIBLE. Falling back to the relay is the recovery
  //     path, so the relay route must still EXIST while offloaded — keep the
  //     transceiver negotiated and starve it, exactly as consent already does
  //     (see ensureRoute's doc). That is why consent and routes are separate
  //     concepts in this file, and it is what makes demotion a memory write
  //     instead of an SDP round trip.
  //
  // 🔮 ANIMATION OFFLOAD is the same broker with different traffic and a much
  //     lower stake: a dropped pose interpolates, a dropped voice packet is an
  //     audible hole. If both are built, voice should be the LAST thing moved to
  //     a new direct link and the FIRST thing moved back — earn trust with pose
  //     traffic, spend it on audio. Basis routes both over one link; we do not
  //     have to, and the asymmetry in failure cost argues we should not.
  // ═══════════════════════════════════════════════════════════════════════
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
      // Proximity gate. Deliberately AFTER consent so it can only ever SUBTRACT:
      // it is an efficiency hint, never a second authorization. If positions are
      // unknown or stale we forward (fail-OPEN here is correct — the cost of a
      // wrong gate is silence, and silence is the failure users actually notice;
      // the cost of forwarding is bandwidth the client already discards).
      if (!this.inEarshot(listenerId, from.id)) { this.gated++; continue; }
      if (!this.withinCap(listenerId, from.id)) { this.capped++; continue; }
      const route = listener.outbound.get(from.id);
      if (!route) continue;                  // no route = not heard
      route.track.writeRtp(rtp);             // encoded Opus, straight through
      this.forwarded++;
    }
  }

  /** Speaker ids this leg has routes for, in insertion order — which is the
   *  order werift added the transceivers, hence the order the browser's
   *  ontrack will fire. The client pairs tracks to speakers by that order (see
   *  client/lib/voicesfu.js); a Map preserves it, which is the only reason this
   *  is safe to rely on. */
  routesFor(legId: string): string[] {
    return [...(this.legs.get(legId)?.outbound.keys() ?? [])];
  }

  /** Trickle ICE from the browser. Unknown leg or malformed candidate is
   *  dropped rather than thrown — a late candidate for a closed leg is normal
   *  churn, not an error worth crashing a voice session over. */
  addIceCandidate(legId: string, candidate: unknown) {
    const leg = this.legs.get(legId);
    if (!leg || leg.closed || !candidate) return;
    try { void leg.pc.addIceCandidate(candidate as RTCIceCandidate); } catch {}
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
    // 🔴 IDENTITY RIDES WITH THE TRACK (Basis validation, 2026-08-15).
    // Basis puts the speaker in the PACKET — ServerAudioSegmentMessage is
    // {playerIdMessage, audioSegmentData} — and stamps it from the
    // authenticated sender, discarding whatever the client claimed
    // (BasisServerHandleEvents.cs:973-976). Audio is self-identifying; nothing
    // is inferred.
    //
    // Ours inferred identity from ARRIVAL ORDER: a sideband `sfu-route` queue
    // shifted on each ontrack. That is a positional coupling between two
    // processes, and it has ALREADY desynced once (a leaked listener attached
    // tracks to the WRONG speaker — voicesfu.js:66-71). The failure mode is the
    // worst available: right voice, wrong avatar, everything looks healthy.
    //
    // WebRTC has a first-class channel for this and we were not using it. msid
    // travels in the SDP and surfaces as e.streams[0].id in the browser.
    // VERIFIED against real Chromium (tools/msid-probe.ts): werift derives msid
    // from the SENDER's streamIds, which come from `streams` here — NOT from
    // fields on MediaStreamTrack. Setting streamId/id on the track produces NO
    // msid at all (measured: browser saw streamIds:["default"]).
    const stream = new MediaStream({ id: speakerId, tracks: [track] });
    listener.outbound.set(speakerId, { track, negotiated: false });
    listener.pc.addTransceiver(track, { direction: "sendonly", streams: [stream] } as any);
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
        // A pending route is NOT "hears" — reporting it as such is what made
        // the B2 bug invisible. Surfaced separately so a stuck one is visible.
        pendingRoutes: [...l.outbound.entries()].filter(([, r]) => !r.negotiated).map(([id]) => id),
        publishing: !!l.ingress,
        state: l.pc.connectionState,
      })),
      forwarded: this.forwarded,
      // 🔴 SUPPRESSION BELONGS IN THE SAME REPORT AS DELIVERY. These were public
      // fields that only sfuadapter reached into, so anything calling sfu.diag()
      // directly — tools/sfu-load.ts does — saw forwarded with no idea how many
      // packets were deliberately dropped. Basis's lesson, recorded in
      // SFU-HANDOFF: "a cheaper server that drops more is not healthier", and a
      // load harness that cannot see drops will report exactly that.
      suppressed: { gated: this.gated, capped: this.capped },
      muted: [...this.muted],
      transportErrorsSwallowed: transportErrorsSwallowed(),
    };
  }

  closeAll() { for (const id of [...this.legs.keys()]) this.closeLeg(id); }
}
