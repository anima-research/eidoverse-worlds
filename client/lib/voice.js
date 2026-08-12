// voice — proximity voice chat between the humans in a world.
//
// Ported from porch-old (index.html:9751-9822), blessed by exultation doctrine:
// WebRTC is wrong for STATE, fine for MEDIA — a P2P mesh for room-sized voice,
// LiveKit if a world ever outgrows it. Signaling rides the sequencer as `rtc`
// messages: point-to-point, never logged (same privacy reasoning as whispers).
//
// Shape: 🎙 on → getUserMedia → offer to every human already here; anyone who
// arrives while your mic is live gets an offer too. A peer with their mic OFF
// still answers offers (recvonly) — hearing needs no microphone. Agents are
// skipped (r.agent — they hear through STT transcripts in the say log, which
// also leaves their mention/approach/whisper triggers untouched).
//
// Mute ≠ mic off: mute disables the outgoing tracks but keeps the mesh warm.
// Volume rolls off by avatar distance — voice is proximity-scoped like chat.

import { bus, report } from './core.js';
import { sendRtc, sendTyping } from './net.js';
import { remotes } from './remotes.js';
import { micFloor, gateThreshold } from './voiceconsent.js';
import { voiceSource, setGeneratorRebuildHook } from './voicesource.js';
import { gateStream, attachSource, detachSource, driveGate, gateOpenness,
         setMonitor, monitoring, release as releaseGate } from './micgate.js';
import { audioContext } from './audioctx.js';
import { myState } from './controller.js';
import { flashHint } from './ui.js';
import { receivingVoice, volumeFor, isHushed } from './voiceconsent.js';

// How long an unanswered local offer stays 'live' for glare purposes. Past
// this, an incoming offer is treated as a rejoin rather than a rival — a real
// glare rival answers within a round trip.
const GLARE_GRACE_MS = 4000;
const RTC_CFG = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };
const FULL_M = 3, SILENT_M = 20;   // full volume inside 3m, gone by 20m

let micStream = null;
// The pre-gate device stream. The analyser MUST measure this, not micStream:
// measuring the gated output makes the gate self-latching (gain drops →
// measured level drops → gate closes harder → never reopens).
let _rawMic = null;
// True when the DEVICE is gone but the LANE is still standing — the state that
// makes coming back cheap.
let _micReleased = false;
let muted = false;
const peers = new Map();           // id -> { pc, audio }
let myId = null;
// TRANSMITTING, not "a stream object exists". Going quiet now disables the
// track instead of stopping it (see toggleMic), so micStream outlives mic-off
// and `!!micStream` would leave the HUD stuck reading ON. Every caller of
// micOn() is UI asking "am I being heard right now?" — this is that question.
// 🔴 NOT track.enabled ANY MORE. The noise gate now toggles `enabled` between
// words, so reading it here would make the HUD flicker "mic off" in every pause
// — the control would look broken precisely while it worked. `muted` is the
// user's intent and does not move on its own, which is the question every caller
// is actually asking: am I open to the room?
// 🔴 THREE STATES, NOT TWO. `muted` and "mic off" are different things and used
// to be told apart by track.enabled — which the NOISE GATE now owns, toggling it
// between words. When I repointed micOn() at `muted` I collapsed them, and
// toggleMic's off-path (which sets enabled=false but muted=false) then left
// micOn() permanently TRUE: R, 2026-08-09, "I'm not sure what the microphone
// option does? It's just stuck on and I can't do anything with it."
//
//   _micLive false          → mic off: nothing is captured, the row reads off
//   _micLive true + muted   → open but deliberately silent
//   _micLive true + !muted  → open; the gate decides moment to moment
let _micLive = false;
// The lane exists because a SYNTHESIZER adopted it, not a device. Cleared the
// moment a real device takes over (mic beats TTS).
let _synthLane = false;
export const synthLaneActive = () => _synthLane && !!micStream;
export const micOn = () => !!micStream && _micLive && !muted;
/** Am I audible RIGHT NOW — i.e. is the gate open this instant? For a live
 *  indicator, not for state. This is the affordance R asked for: "we have no
 *  affordance to say when audio is getting broadcasted." */
export const micTransmitting = () =>
  // Read the GAIN, not a boolean. With a smoothed gate there is no on/off flag
  // to consult — the honest question is "how much of me is reaching the wire",
  // and 0.05 is the point where a listener would call it audible rather than
  // the tail of a fade.
  !!micStream && !muted && gateOpenness() > 0.05;
export const isMuted = () => muted;

function humanIds() {
  return [...remotes.entries()].filter(([, r]) => !r.agent).map(([id]) => id);
}

/** The two consent bits, as a transceiver direction. This is the whole
 *  consent model expressed structurally: not a check that code paths must
 *  remember to consult, but the shape of the connection itself, so there is
 *  no path — offer, answer, or renegotiation — that can negotiate media a
 *  direction did not permit. (Review catch: offerToReceiveAudio:true asked
 *  for inbound audio even with receive off, and an answer could then deliver
 *  it. The old comment claimed the offer "cannot deliver audio we did not ask
 *  for" — but the offer DID ask.) */
function wantDirection() {
  const send = !!micStream, recv = receivingVoice();
  return send && recv ? 'sendrecv' : send ? 'sendonly' : recv ? 'recvonly' : 'inactive';
}

/** Force every audio transceiver on this peer to the currently-consented
 *  direction. Called before any offer/answer, and again when consent moves. */
/** Un-silence inbound audio that the consent gate disabled on arrival.
 *  The tracks are still live — the gate sets `enabled = false` rather than
 *  stop() precisely so this is possible — so consenting later is a local flip
 *  with no renegotiation. Attaches the element too, for the case where the
 *  peer was built before any track arrived. */
function reenableInbound(p) {
  const tracks = (p.pc.getReceivers?.() ?? [])
    .map((r) => r.track)
    .filter((t) => t && t.kind === 'audio' && t.readyState === 'live');
  if (!tracks.length) return;
  for (const t of tracks) t.enabled = true;
  // Restore the element only if it lost its stream, but ALWAYS ensure p.stream
  // names something: the gate's early return can leave a peer attached with no
  // stream recorded, and that is the exact path this function repairs.
  if (!p.audio.srcObject) {
    const stream = new MediaStream(tracks);
    p.audio.srcObject = stream;
    p.stream = stream;
  } else if (!p.stream) {
    p.stream = p.audio.srcObject;      // same object the element already holds
  }
  p.audio.play().catch(() => addEventListener('click', () => p.audio.play().catch(() => {}), { once: true }));
}

/** THE track this body should be sending right now — the single answer both
 *  handoff sites consult. Without it, applyDirection re-attached micStream's
 *  gated track on EVERY renegotiation, silently undoing a mic-off TTS
 *  takeover minutes later (r3 B4 field catch: the sender held the gate's
 *  destination again by the next reconcile — two mechanisms, one sender,
 *  last-writer-wins forever). Mic live → the gated lane; otherwise, if a
 *  synthesizer is armed and has a generator, the generator; else the lane. */
function activeSendTrack() {
  if (!micStream) return null;
  const lane = micStream.getAudioTracks()[0] || null;
  if (_micLive) return lane;                      // a live mic always wins
  const gen = _synthTrack;
  return gen && gen.readyState === 'live' ? gen : lane;
}
let _synthTrack = null;                            // set by the takeover sites

function applyDirection(p) {
  const dir = wantDirection();
  try {
    // A live mic with nothing attached is the same class of mismatch as a
    // wrong direction, so it is repaired in the same place. addTrack runs only
    // in peerFor's construction path, which leaves two windows where a peer
    // ends up permanently silent: a mic opened after the peer was built, and —
    // the race that made this intermittent — a peer built DURING the await on
    // getUserMedia, when micStream is still null and any one-shot back-fill
    // has already run. Every offer and renegotiation passes through here, so
    // attaching here makes it an invariant rather than a patch per path.
    if (micStream) {
      const track = activeSendTrack();
      const sender = p.pc.getSenders().find((s) => s.track?.kind === 'audio' || !s.track);
      if (track && sender && sender.track !== track) sender.replaceTrack(track).catch((e) => report('voice track', e));
      else if (track && !sender) p.pc.addTrack(track, micStream);
    }
    for (const t of p.pc.getTransceivers?.() ?? []) {
      if (t.receiver?.track?.kind === 'audio' || t.sender?.track?.kind === 'audio' || !t.receiver) {
        if (t.direction !== dir) t.direction = dir;
      }
    }
  } catch (e) { report('voice direction', e); }
  return dir;
}

function peerFor(id) {
  let p = peers.get(id);
  if (p) return p;
  const pc = new RTCPeerConnection(RTC_CFG);
  const audio = new Audio();
  audio.autoplay = true;
  audio.playsInline = true;
  p = { pc, audio, gen: ++_peerGen };
  peers.set(id, p);
  cancelSoleCourterReach(id);   // a lane exists again — a pending deferred reach is moot
  if (micStream) for (const t of micStream.getTracks()) pc.addTrack(t, micStream);
  pc.ontrack = (e) => {
    // FAIL CLOSED: consent can be revoked mid-negotiation, and a track that
    // was in flight when it happened must not land. Nothing is AUDIBLE unless
    // receive is on at the moment audio actually arrives.
    // FAIL CLOSED, but REVERSIBLY. This previously called t.stop() on their
    // track, which is a ONE-WAY DOOR: per mediacapture-streams stop() ends a
    // track permanently, and per WebRTC-PC §5.3.1 `receiver.track` is never
    // reassigned — so that transceiver's remote track was gone for its whole
    // lifetime. No renegotiation, no direction change, and no second ontrack
    // could bring it back. Consenting AFTER someone's track arrived left you
    // permanently deaf to that person while still audible to them: the
    // one-way report of 2026-08-08, order-dependent, which is why it read as
    // a who-joined-first problem.
    //
    // stop() also never stopped the RTP on the wire, so it bought no
    // bandwidth — it only removed the way back. `enabled` is the mechanism
    // the spec provides for a reversible refusal: synchronous, local,
    // mandated to render silence, and reversible with no negotiation.
    for (const t of e.streams[0]?.getTracks() ?? []) t.enabled = receivingVoice();
    audio.srcObject = e.streams[0];
    // p.stream is set BEFORE the consent bail, not after. It is what
    // peerLevels()/mouth animation read, and a refused-then-consented track
    // recovers its AUDIO via reenableInbound() but would never come back
    // through here — so leaving it unset behind the bail made the repaired
    // path permanently mouth-blind. Attaching and naming the stream are one
    // act; only PLAYING is gated. (Mica, #63 review.)
    p.stream = e.streams[0];
    if (!receivingVoice()) return;   // attached and named, but SILENT until consent
    // autoplay policy: if the browser balks (receiver never clicked anything),
    // retry on the next user gesture rather than failing silently
    audio.play().catch(() => addEventListener('click', () => audio.play().catch(() => {}), { once: true }));
  };
  pc.onicecandidate = (e) => { if (e.candidate) sendRtc(id, { ice: e.candidate }); };
  // restartIce() does not send anything by itself — it raises negotiationneeded
  // and waits for the application to offer. With no handler the flag was set and
  // nothing ever went out, so an ICE restart would have been a silent no-op.
  // renegotiate() is exactly the "offer if we can, queue if mid-flight" path
  // this needs, so route the event there rather than writing a second one.
  pc.addEventListener?.('negotiationneeded', () => { renegotiate(id); });
  pc.addEventListener?.('connectionstatechange', () => (window.__iceLog ??= []).push(`conn[${id}]=${pc.connectionState}`));
  pc.addEventListener?.('iceconnectionstatechange', () => (window.__iceLog ??= []).push(`icestate[${id}]=${pc.iceConnectionState}`));
  pc.onconnectionstatechange = () => {
    const st = pc.connectionState;
    // 🔴 'disconnected' IS NOT 'failed'. It means ICE consent checks stopped
    // arriving — a wifi blip, a handover, a laptop lid — and it recovers on its
    // own most of the time. MDN is explicit: "don't call close() on
    // disconnected — you'd be discarding a connection that may well recover."
    // We were tearing the peer down instantly, so a momentary blip permanently
    // destroyed a working link and nothing rebuilt it: the peer is gone from the
    // map, so no renegotiation can reach it, and the other end still holds a
    // live connection to a peer that no longer exists. That is the one-way
    // audio, and it explains why it survives mic toggles (the peer is not
    // there to re-offer) and why a full restart FLIPS which side is deaf (only
    // the restarted side rebuilds).
    //
    // Give it a grace period and try an ICE restart before giving up. Only
    // 'failed' and 'closed' are terminal.
    if (st === 'failed' || st === 'closed') {
      // STALENESS GUARD (r5, review): after reach-back replaces this peer,
      // the OLD pc is closed and can still emit state changes ('closed', or a
      // late 'failed'). Without this check a ghost event drops the fresh
      // REPLACEMENT — and 'closed' being terminal, nothing rebuilds it: the
      // repair mechanism itself becomes the killer. A dead generation's
      // events are void; only the registry's current peer may act. This is
      // also the one-outstanding-retry bound: repeated events on one dead pc
      // cannot fan out into duplicate offers.
      if (peers.get(id) !== p) return;
      clearTimeout(p._discoTimer); dropPeer(id);
      // Field, 2026-08-10 (voicetest, cellular×2): dropping on 'failed' left the
      // id with NO peer and nothing re-offered — roster rescans run only on
      // roster events, which a mid-session ICE death does not produce. The
      // neighbor is still here; the lane just died. Reach again immediately,
      // exactly once — if that offer's ICE fails too, the next 'failed' lands
      // back here, so persistent unreachability retries at ICE cadence rather
      // than looping hot. 'closed' stays terminal: WE closed that peer on
      // purpose (leave, replacement), and re-offering would resurrect it.
      // Repair OWNERSHIP is split by who courts: humans are ours (we offer,
      // so we reach back). Agent lanes are agent-initiated (we never offer to
      // agents — line ~10), so their 'failed' repair belongs to the agent's
      // voice source; reaching from here would invert the direction
      // convention and race their own re-offer.
      // WHO reaches back = WHO COURTED (r2, revised in-review). Both peers
      // usually see 'failed' near-simultaneously; if both re-offered, two
      // fresh never-settled rivals meet and the glare logic reads them as
      // rejoins — both roll back and answer, each marries a different
      // session, and the pair storms at ICE cadence. So:
      //   · the lane's SOLE courter (we offered, they never have — an agent's
      //     leg toward humans, or a one-mic human pair) reaches back
      //     unconditionally: nobody else ever will;
      //   · a DUAL-courtship lane (both sides have offered — two live mics)
      //     is arbitrated by rank, the mesh-heal sweep's own convention:
      //     lower id offers, higher answers through the normal path.
      // A first version rank-gated everything and silently disarmed the
      // agent leg's only repair whenever it ranked high. If only the
      // non-reaching side noticed the death, the reacher's own ICE fails
      // within its timeout and lands here — late beats storming.
      // (We still never reach TOWARD agent peers: their lanes are theirs.)
      //
      // ⚠️ ARBITRATION MUST MATCH THE 300ms RECONCILE SWEEP (r6, adversarial
      // review). The recut onto post-#91 main pulled in a reconcile interval
      // (see ~line 1036) that offers to any roster HOLE when (myId < id) —
      // court-ignorant, rank-only. So an UNCONDITIONAL sole-courter reach-back
      // that ranks HIGH races that sweep: both ends drop on 'failed', we reach
      // immediately, and within ≤300ms the low peer's sweep offers too — two
      // never-stable pcs cross and glare-storm, the exact failure this repair
      // claims to prevent. The two mechanisms must share ONE rule: the LOWER
      // id offers.
      //   · we rank LOW  (myId < id): reach immediately — the sweep would make
      //     the same offer, and sooner is strictly better;
      //   · we rank HIGH and the lane is DUAL: rank says wait to be offered to
      //     (unchanged);
      //   · we rank HIGH and are the SOLE courter (the agent-leg-toward-human
      //     case, no sweep will ever cover it because the human ranks higher
      //     than the agent id... or the peer simply never noticed the death):
      //     DEFER past one sweep cycle, then reach only if still unhealed. This
      //     gives the low peer's sweep deterministic first crack (no glare) yet
      //     preserves the agent leg's only repair when nobody else acts.
      if (st === 'failed' && remotes.has(id) && !remotes.get(id)?.agent && p._court) {
        const weRankLow = (myId ?? '') < id;
        if (weRankLow || !p._theyEverOffered) {
          if (weRankLow) offerTo(id);                 // matches the sweep — immediate, no race
          else scheduleSoleCourterReach(id);          // high & sole: defer past the sweep window
        }
      }
      return;
    }
    if (st === 'connected') { clearTimeout(p._discoTimer); p._discoTimer = null; return; }
    if (st === 'disconnected' && !p._discoTimer) {
      p._discoTimer = setTimeout(() => {
        p._discoTimer = null;
        if (pc.connectionState !== 'disconnected') return;    // recovered on its own
        // Still down after the grace window: ask ICE to find a new path rather
        // than destroying the peer. restartIce() renegotiates in place, which
        // keeps the transceivers — and therefore the agreed direction — intact.
        try { pc.restartIce?.(); } catch (e) { report('voice ice restart', e); }
      }, 6000);
    }
  };
  return p;
}

function dropPeer(id) {
  // Cancel any deferred sole-courter reach FIRST — before the no-peer early
  // return (#102 review): a reach is scheduled precisely when no peer exists
  // yet, so leaving it to expire would retain a dead id in _soleReach and (were
  // the object-identity guard ever weakened) risk courting a successor. Cancel
  // on the true leave.
  cancelSoleCourterReach(id);
  const p = peers.get(id);
  if (!p) return;
  // A pending disconnect timer outlives the peer it was watching unless it is
  // cleared here — it would fire against a closed pc and try to restart ICE on
  // a connection nobody holds.
  clearTimeout(p._discoTimer);
  p._discoTimer = null;
  peers.delete(id);
  try { p.pc.close(); } catch (e) { report('voice close', e); }
  p.audio.srcObject = null;
  // the mouth-animation analyser hung off this peer's stream — without this
  // the MediaStreamSource graph node lived for the whole session (#95's
  // side-table census found the leak; every departed speaker kept a node)
  const a = _peerAn.get(id);
  if (a) { try { a.an.disconnect(); } catch {} _peerAn.delete(id); }
}

/** Re-offer on an EXISTING peer after our track set changed (mic on/off while
 *  a consented inbound leg is live). Silent no-op if we are mid-negotiation. */
/** SINGLE-FLIGHT (#36 review): recvReady can arrive while this peer's FIRST
 *  offer is still inside createOffer — signalingState hasn't left 'stable'
 *  yet, so the state check alone lets a second offer start concurrently and
 *  the two race into glare against ourselves. One offer in flight per peer;
 *  a request that finds one in flight simply yields to it — any offer that
 *  lands satisfies a newly-consented receiver. */
async function offerOn(p, id, label) {
  if (p._offering) return;
  p._offering = true;
  try {
    // direction FIRST: the offer must describe what we consented to, not ask
    // for everything and filter later
    applyDirection(p);
    const offer = await p.pc.createOffer();
    await p.pc.setLocalDescription(offer);
    p._offeredAt = Date.now();     // for the rejoin-vs-glare distinction
    sendRtc(id, { sdp: p.pc.localDescription });
    // Repair-ownership tell (r3, moved here in r4 review): a COURTER is
    // anyone who has actually SENT an offer on this lane — courtship,
    // renegotiation, ICE-restart follow-ups alike. Setting it only in
    // offerTo let a renegotiating answerer mark the far side dual
    // (_theyEverOffered) while never owning repair itself: courter
    // rank-blocked, answerer court-blocked, NOBODY reaches. And setting it
    // before the await marked lanes courted when the offer never left the
    // building. After the send: the flag states a fact.
    p._court = true;
  } catch (e) { report(label, e); } finally { p._offering = false; }
}

/** Fire exactly one follow-up offer if our track set changed while this peer
 *  was mid-negotiation. Generation-bound: pending work raised against an
 *  earlier peer object is discarded rather than applied to its replacement.
 *  Idempotent — the flag is cleared before the offer, so a repeated call
 *  cannot stack duplicate offers. */
function reconcilePending(p, id) {
  // Bounded trace of every reconciliation decision. The cross-generation seam
  // is invisible downstream — a leaked follow-up may still bail on signaling
  // state, so an offer COUNT cannot see it — and this is what makes the
  // refusal assertable. Capped so a long session cannot grow it without bound.
  {
    const L = (globalThis.__reconcileLog ??= []);
    L.push(`id=${id} owed=${p?.pendingReneg} gen=${p?.gen} isCurrent=${peers.get(id) === p}`);
    if (L.length > 200) L.splice(0, L.length - 200);
  }
  if (!p || p.pendingReneg == null) return;
  const owed = p.pendingReneg;
  p.pendingReneg = null;                 // clear FIRST: no duplicate follow-ups
  if (owed !== p.gen) return;            // debt belongs to this peer object
  // ...and this peer object must still BE the peer for this id. The generation
  // check above is self-referential: an old answer handler that was already
  // mid-await when its peer was dropped and rebuilt compares the old object to
  // its own gen, matches, and then renegotiate(id) resolves peers.get(id) —
  // the REPLACEMENT. So the dead peer's debt gets paid by its successor, which
  // is the exact leak the generation stamp was meant to prevent (Mica, #62).
  if (peers.get(id) !== p) return;
  if (p.pc.signalingState !== 'stable') return;
  renegotiate(id);
}

async function renegotiate(id) {
  const p = peers.get(id);
  if (!p) return;
  if (p.pc.signalingState !== 'stable') {
    // FOURTH TIMING CLASS (Mica, #62). Our track set changed while a
    // negotiation was already in flight, so we cannot offer now — but the
    // old offer was built without this track, and no second event will
    // bring us back here. Dropping the request is how a live mic ends up
    // on a sendrecv transceiver carrying silence. Record the intent,
    // STAMPED WITH THIS PEER'S GENERATION, and reconcile on return to
    // stable; a peer that gets dropped and rebuilt takes its pending work
    // with it rather than handing it to its successor.
    p.pendingReneg = p.gen;
    return;
  }
  await offerOn(p, id, 'voice renegotiate');
}

async function offerTo(id) {
  await offerOn(peerFor(id), id, 'voice offer');
}

// SOLE-COURTER HIGH-RANK REACH-BACK (r6): we outrank the peer, so the 300ms
// reconcile sweep's "lower id offers" rule means the PEER should re-establish
// the lane — but if they never noticed the death (mid-session ICE failure
// produces no roster event on their side), nobody sweeps and the lane stays
// dead. Wait past one sweep cycle: if the peer's sweep (or their own
// reach-back) rebuilt the lane, `peers.has(id)` is true and we do nothing —
// no glare. If it's still a hole, we are the last resort and reach. Deferred
// reaches are keyed by id so repeated 'failed' events don't stack timers.
const _soleReach = new Map();
function scheduleSoleCourterReach(id) {
  if (_soleReach.has(id)) return;                 // one outstanding deferred reach per id
  // Bind the debt to the EXACT remote record that incurred it, not just the id
  // (#102 review). #97 makes a same-id takeover a FRESH remote object; if the
  // predecessor leaves/takes over inside this 380ms window and a successor
  // re-occupies the key before the timer fires, the predecessor's repair debt
  // must not court the successor. Same object-identity guard the avatar loader
  // uses (remotes.get(id) !== r): the successor is a different object.
  const expected = remotes.get(id);
  if (!expected) return;                          // nothing to owe a reach to
  const t = setTimeout(() => {
    _soleReach.delete(id);
    // still unhealed, still present, still not an agent — AND still the SAME
    // remote generation that scheduled this reach (identity, not mere presence).
    if (!peers.has(id) && remotes.get(id) === expected && !expected.agent) offerTo(id);
  }, 380);                                        // > the 300ms sweep period, with margin
  _soleReach.set(id, t);
}
function cancelSoleCourterReach(id) {
  const t = _soleReach.get(id);
  if (t) { clearTimeout(t); _soleReach.delete(id); }
}

async function onRtc(msg) {
  const { from, payload } = msg;
  // LATE-CONSENT WAKE (#34, matrix-proven 2026-08-06): an offer that arrives
  // while receive is off is dropped BEFORE a peer exists — correct — but the
  // sender is then wedged in have-local-offer, and every heal path skipped it
  // (renegotiate bails on non-stable, roster re-offers only unknown ids).
  // Deadlock until reload. So a receiver who turns consent ON announces it,
  // and a live-mic sender rebuilds the wedged leg. This runs BEFORE the
  // consent gate on purpose: it negotiates THEIR inbound, not ours — no
  // consent of ours is needed to learn someone now wants to hear.
  if (payload?.recvReady) {
    if (micStream) {
      const p = peers.get(from);
      // mid-flight first offer: the state is still 'stable' but an offer is
      // being built — tearing down or re-offering here is the race the
      // review named. Yield: the in-flight offer reaches a receiver who now
      // answers. And a HEALTHY peer stays untouched (idempotent recvReady).
      if (p?._offering) return;
      if (p && p.pc.signalingState !== 'stable') dropPeer(from);
      // roster-gated: RTC updates peers, it never creates one for an id the
      // world hasn't announced (#95) — a recvReady straggling in after its
      // sender left must not court a departed generation
      if (!peers.has(from)) { if (remotes.has(from)) offerTo(from); }
      else renegotiate(from);
    }
    return;
  }
  // CONSENT GATE: with receive-voice off we never negotiate an inbound path.
  // Not "answer then mute" — no audio path exists at all. An ANSWER to our
  // own offer is still processed, but it is safe now for a structural reason
  // rather than an assumed one: that offer was created sendonly, so there is
  // no recv direction for an answer to fill. ontrack also fails closed.
  // ICE candidates pass the gate for the same structural reason answers do:
  // our offer was sendonly, so the remote's candidates can only complete that
  // sendonly path — no inbound audio route exists for them to open. Dropping
  // them here (pre-2026-08-07 behavior) silently broke every mic-only sender
  // whose peer couldn't reach us directly: connections survived ONLY via
  // peer-reflexive discovery (host/srflx checks arriving unsolicited), which
  // works on localhost/LAN and fails through TURN or across real NATs —
  // "works in the lab, dead in production", wedged in checking forever.
  if (!receivingVoice() && payload?.sdp?.type !== 'answer' && !payload?.ice) return;
  // ICE never creates a peer: candidates only make sense for a negotiation
  // we already own. A stray candidate (early trickle before an offer we
  // dropped, or residue from a peer generation dropPeer() discarded) must
  // not conjure a fresh pc — flushing old-generation candidates into a
  // replacement pc poisons its checks (Mica's contamination rule, 08-07).
  // Offers/answers may BUILD a peer — but only for a participant the world
  // has announced (#95: presence data, RTC included, updates generations and
  // never creates them; an SDP offer from a departed id built a peer no
  // roster sweep had a body to key on). ICE never creates, as before.
  const p = payload.ice ? peers.get(from)
    : (peers.get(from) ?? (remotes.has(from) ? peerFor(from) : null));
  if (!p) return;
  // Per-peer signal serialization: two concurrent onRtc invocations for the
  // same peer interleave across their awaits (offer A setRemote -> offer B
  // setRemote -> A answers -> B's createAnswer fires in 'stable'). Chain
  // errors handled per-link so one failed signal doesn't wedge the queue.
  // recvReady stays outside the chain above — it may rebuild the peer.
  p.sigQ = (p.sigQ ?? Promise.resolve()).then(() => processSignal(p, from, payload));
  await p.sigQ.catch(() => {});
}

async function processSignal(p, from, payload) {
  try {
    if (payload.sdp?.type === 'offer') {
      p._theyEverOffered = true;   // dual courtship: rank must arbitrate repair
      // glare: both sides offered at once — the LOWER id's offer stands, the
      // higher id rolls back and answers (deterministic, no extra messages)
      if (p.pc.signalingState === 'have-local-offer') {
        // GLARE vs REJOIN. Glare's premise is that BOTH offers are live, so
        // the loser's offer will be answered by the winner. A peer that
        // RELOADED breaks that premise: their old session is gone, nobody is
        // left to answer the offer we are protecting, and returning here
        // discards the only live offer in the exchange — both sides strand,
        // silently, forever. Field receipt 2026-08-08: "she could hear me
        // until she hard reloaded."
        //
        // The tell is that our offer has been outstanding with no answer. A
        // true glare rival answers within a round trip; a reloaded peer never
        // will, because the session that owed us that answer no longer exists.
        // So yield to an offer that arrives after our own has gone unanswered
        // past a round trip, and keep the id rule only for the genuine
        // simultaneous case.
        // The tell is not TIME — a slow link can exceed any grace legitimately —
        // it is whether this peer has ever answered anything of ours. A true
        // glare rival is mid-exchange on a live connection; a reloaded peer is
        // brand new to us and has never completed a negotiation. `_everStable`
        // is set the first time we reach a settled state with them, so an
        // offer from a peer we have never settled with is a JOIN, not a rival.
        if (p._everStable && (myId ?? '') < from) return;   // real glare: mine stands
        await p.pc.setLocalDescription({ type: 'rollback' });
      }
      await p.pc.setRemoteDescription(payload.sdp);
      for (const c of p.pendingIce ?? []) {
        await p.pc.addIceCandidate(c).catch((err) => (window.__iceLog ??= []).push(`flushIce-FAIL ${err.name}`));
      }
      p.pendingIce = [];
      applyDirection(p);            // our answer states OUR consent, not theirs
      const answer = await p.pc.createAnswer();
      await p.pc.setLocalDescription(answer);
      p._everStable = true;      // we answered them: a real exchange happened
      sendRtc(from, { sdp: p.pc.localDescription });
      // NOT reconciled here. Answering lands us in stable, but applyDirection
      // above already put the current track set into the answer we just sent —
      // the far end has it. Firing a follow-up offer would re-destabilize a
      // peer that is already correct, and it regressed the mid-negotiation
      // test (peer ended have-local-offer instead of stable). The pending flag
      // is owed only where WE were the offerer and our offer went out stale.
      p.pendingReneg = null;

    } else if (payload.sdp?.type === 'answer') {
      if (p.pc.signalingState === 'have-local-offer') {
        p._offeredAt = null;       // answered: no longer an outstanding offer
        p._everStable = true;      // we have completed a negotiation with them
        await p.pc.setRemoteDescription(payload.sdp);
        for (const c of p.pendingIce ?? []) {
          await p.pc.addIceCandidate(c).catch((err) => (window.__iceLog ??= []).push(`flushIce-FAIL ${err.name}`));
        }
        p.pendingIce = [];
        // Back to stable: pay any renegotiation we owed from mid-flight.
        reconcilePending(p, from);
      }
    } else if (payload.ice) {
      if (p.pc.remoteDescription) {
        await p.pc.addIceCandidate(payload.ice).catch((err) => {
          (window.__iceLog ??= []).push(`addIce-FAIL ${err.name}: ${err.message} [state=${p.pc.signalingState}]`);
        });
      } else {
        (p.pendingIce ??= []).push(payload.ice);   // queue until a remote description exists
      }
    }
  } catch (e) { (window.__iceLog ??= []).push(`signal-FAIL ${e?.name}: ${e?.message}`); report('voice signal', e); }
}

export async function toggleMic(name) {
  myId = name ?? myId;
  if (micOn()) {
    // GOING QUIET IS A DATA CHANGE, NOT A CONNECTION CHANGE (R, 2026-08-08).
    //
    // This used to stop() the track, removeTrack() it from every peer, and
    // renegotiate — three destructive operations to express "don't transmit".
    // Four of the six voice bugs fixed this week were in the renegotiation
    // that followed, and stop() manufactures precisely the `audio:ended`
    // sender state that the live one-way-audio blocker shows in the field.
    // The identical intent was already implemented correctly ten lines below
    // in toggleMute (track.enabled = false, zero renegotiation, zero bugs) —
    // it simply had no callers, while the HUD button called this.
    //
    // So: disable the track. It stays live, the sender stays bound, the
    // transceiver stays sendonly, the SDP does not change, and coming back is
    // one assignment rather than getUserMedia + renegotiate. Muting cannot
    // deafen you because no peer is touched at all.
    for (const t of (_rawMic || micStream).getTracks()) t.enabled = false;
    stopOnsetWatch();
    _micLive = false;                // the state the checkbox and HUD icon read
    muted = false;
    driveGate(false);                // close the lane; never tear it down
    flashHint('🎙 off');
    bus.emit('voice', { on: false });
      // 🔴 MIC OFF = TTS TAKES OVER, if it was left enabled (R, 2026-08-09).
      // MIC BEATS TTS is a priority, not a toggle: the TTS setting stands while
      // the mic wins, so the moment the mic drops the synth must actually be
      // wired in — otherwise "drops back to TTS without touching anything" is
      // just silence, and the user has no way to tell an armed voice from a
      // broken one. Fixing only the mic-on direction would be exactly the
      // asymmetric repair voicesource.js warns about two lines up from its own
      // mix site.
      // ONE mechanism (#91 B3): the generator goes ON the sender, here as
      // everywhere. The old path mixed synth into micgate's destination node —
      // a mouth sewn shut wherever the AudioContext clock stalls, and a second
      // divergent handoff whose ordering against tts.js's own takeover could
      // leave synth mixed in while the raw mic reopened. replaceTrack only.
      import('./voicesource.js').then((vs) => {
        const sp = vs.synthProvider?.();
        if (!sp?.available?.()) return;
        _synthTrack = sp.start();
        rebindSenders(_synthTrack);
      }).catch(() => {});
    return false;
  }
  // Coming back. If we still hold the stream (the normal case now — mic-off
  // only disables it) re-enabling IS the whole acquisition step: no
  // getUserMedia, so no permission re-prompt and no new track object. Then we
  // fall THROUGH to the same attach/renegotiate/court-peers path a fresh mic
  // takes; returning early here skipped peer creation entirely, which the
  // lifecycle suite caught at once (mic ON with no peer courted).
  // 🔴 `micStream` DOES NOT MEAN "A DEVICE IS CAPTURING". After
  // releaseMicrophone() it deliberately SURVIVES — the lane stays up so the mesh
  // needs no renegotiation on the way back (R: "we just mute the lane", and
  // recovering a torn-down audio path costs seconds). But its tracks are STOPPED
  // and a stopped track cannot be revived. Branching on micStream alone sent the
  // return-from-release path into the re-enable branch below, where it flipped
  // `enabled` on dead tracks: getUserMedia was never called, no device was ever
  // reacquired, and the mic silently never came back after any release.
  //
  // `_micReleased` is the variable that answers "is there a device behind this
  // lane" — and it is ALREADY the discriminator twelve lines down, where
  // attachSource decides whether to reuse the standing graph. Same question,
  // same answer, both places.
  // …and not a SYNTH-ADOPTED lane: that branch re-enables an existing DEVICE,
  // and a synthetic lane has none — the same discriminator class as
  // _micReleased, caught by the same suite the hour it was introduced. Mic ON
  // over a synth lane must ACQUIRE the device; the device then replaces the
  // generator on the senders (mic beats TTS), and the fresh-mic path below
  // already does exactly that.
  if (micStream && !_micReleased && !_synthLane) {
    // 🔴 THE SAME TRACK THE OFF-PATH TOUCHED. micStream is the GATED output now,
    // so re-enabling its track does nothing for the RAW device track that mic-off
    // disabled — the mic came back once and was silent forever after (R,
    // 2026-08-09: "it enables correctly only the first time. Once toggled again,
    // it never comes back"). Asymmetric repair, in the one file that has a whole
    // memory note about asymmetric repair. Both paths name (_rawMic || micStream)
    // so they cannot drift apart again.
    for (const t of (_rawMic || micStream).getTracks()) t.enabled = true;
  } else {
    try {
      // WHERE THE VOICE COMES FROM is a property of this body, not a hardcoded
      // device call: a human gets the microphone, an agent gets its own
      // synthesizer, and everything downstream is identical either way. See
      // voicesource.js — the alternative was a second WebRTC client holding
      // the same identity, which produced 543 takeovers on 2026-08-08.
      const rawMic = await voiceSource();
      // GATE THE STREAM BEFORE WEBRTC EVER SEES IT. micStream becomes the GATED
      // stream, so every existing path (addTrack, replaceTrack, the senders)
      // carries gated audio with no further changes. The raw stream is kept for
      // measurement and for mute.
      _rawMic = rawMic;
      // Reuse the EXISTING lane if one is standing: attachSource returns the
      // same gated stream the senders already hold, so coming back from a
      // release costs ZERO renegotiation. Only build a new graph when there is
      // none — that rebuild is the "unmute lag while it sets it all up again"
      // R described.
      // A SYNTHETIC source bypasses the gate outright: no room noise to gate,
      // and the gate's WebAudio graph cannot even carry it on a stalled clock
      // (headless). The generator track goes on the senders as-is — frames as
      // data, paced by the wall clock, exactly as designed.
      const reused = rawMic.synthetic ? null : (_micReleased ? attachSource(rawMic) : null);
      micStream = rawMic.synthetic ? rawMic : (reused || gateStream(rawMic, micAnalyserLevel));
      _synthLane = !!rawMic.synthetic;
      // B2: a null gate is a REFUSAL, not a fallback. Stop the device we just
      // opened (no capture without a lane), tell the user the true state, and
      // do not transmit. allowUngated(true) + retry is the explicit override.
      if (!micStream) {
        for (const t of rawMic.getTracks?.() ?? []) t.stop();
        flashHint('voice gate unavailable — NOT transmitting (raw-mic override available in audio panel)');
        bus.emit('voice-gate-unavailable', {});
        return false;
      }
      _micReleased = false;
    } catch (e) {
      report('microphone', e);
      flashHint('microphone unavailable — check browser permission');
      return false;
    }
  }
  // Attach FIRST, renegotiate second. applyDirection is where the track is
  // adopted, but renegotiate() bails on a peer that is not 'stable' — and a
  // peer mid-negotiation when the mic opens is exactly one of the cases this
  // is repairing, so routing the attachment only through renegotiate would
  // skip it. Attaching is safe in any signaling state; replaceTrack on an
  // existing sender needs no renegotiation at all.
  // Retire the synth producer FIRST (#91 B3: mic beats TTS, and the handoff
  // must be ordered — applyDirection below puts the gated mic track back on
  // every sender via replaceTrack, so stopping the pacer before that leaves
  // no window with two producers and no window with none).
  import('./voicesource.js').then((vs) => vs.synthProvider?.()?.stop?.()).catch(() => {});
  // 🔴 PRODUCER STATE FLIPS BEFORE THE REBIND (r4 — the founding receipt's
  // third catch). applyDirection consults activeSendTrack(), which reads
  // _micLive — and _micLive used to be set BELOW this loop, so at the exact
  // moment the mic went live every sender was handed the GENERATOR: a dead
  // outbound leg (pacer stopped, device track never bound) that the
  // acceptance greenwashed by asserting only the CAPTURE side. Same class as
  // the _micReleased and _synthLane discriminator bugs: a state flag read
  // before its writer ran. The unmute lesson rides along: mic ON is an
  // unmute, or a muted user pressing the button wedges with every light
  // reading silence.
  _micLive = true;
  muted = false;
  for (const p of peers.values()) applyDirection(p);
  for (const id of [...peers.keys()]) renegotiate(id);
  // Only reach for peers we do NOT already hold. A peer mid-negotiation has
  // an answer in flight that will carry the track we just attached — offering
  // into it forces glare against ourselves and leaves the peer parked in
  // have-local-offer (Mica, #34). renegotiate() above already covers the
  // stable ones; this covers the strangers.
  for (const id of humanIds()) if (!peers.has(id)) offerTo(id);
  flashHint('🎙 live — speak, neighbors hear · <b>mute</b> in the dock');
  bus.emit('voice', { on: true });
  startOnsetWatch();
  return true;
}

// Presence at speech ONSET, from the LOCAL analyser — deliberately not from
// SpeechRecognition (#26 review): declining vendor transcription must not
// mute your presence. Level crossing the visible panel floor emits one
// 'mic' typing-presence event; hysteresis (fall to 60% of floor) plus a
// 1.5s refractory keep sustained speech from machine-gunning the channel.
// Monotonic peer generation. A peer REPLACED by dropPeer+rebuild is a
// different peer with the same id, and work scheduled against the old one
// must not land on the new one — answers carry no negotiation identity of
// their own, so we supply it (Mica, #62 review).
let _peerGen = 0;
let _onsetTimer = null, _above = false, _lastOnset = 0, _openUntil = 0;
// When this open began, and whether it has been announced — see onsetTick.
let _openedAt = 0, _announced = false;
// ADAPTIVE FLOOR. R, 2026-08-09 mid-call: "lol mic sensitivity still needs
// work" — the 🎙 indicator fired on nothing and missed real speech.
//
// The old gate compared raw RMS to a FIXED 0.04. That cannot work across
// machines: RMS scales with mic gain, distance and OS-level AGC, so 0.04 is
// deafening on a headset and unreachable on a laptop array two feet away. One
// constant against an unnormalised signal is the whole bug.
//
// So measure the ROOM and gate relative to it. `_noise` tracks the quiet level
// with a slow one-sided follower — falls fast toward quiet, rises slowly — so a
// long utterance cannot drag the floor up behind itself and gate you out
// mid-sentence, while a fan switching on is absorbed within a few seconds.
// Speech has to clear the noise by a MARGIN, which is what makes it work the
// same in a silent room and a loud one.
//
// The slider still matters: it scales the margin (sensitivity), rather than
// naming an absolute level nobody can reason about.
let _noise = 0.01;
let _settle = 0;
// BasisVR's block tracker: 6 × 0.4s minima. See onsetTick.
let _blocks = new Array(6).fill(Infinity), _blockIdx = 0, _blocksFilled = 0,
    _blockMin = Infinity, _blockStart = 0;
function onsetTick() {
  const level = micAnalyserLevel();
  // 🔴 DRIVE THE GATE BEFORE ANY EARLY RETURN. Both of the bails below (muted /
  // silent, and the settle window) used to skip gateAudio() entirely — so the
  // gain simply KEPT ITS LAST VALUE. If the gate happened to be open when you
  // stopped talking into silence, or during the first second after unmuting, it
  // stayed open and the monitor played straight through: R, twice, "hear myself
  // isn't obeying the mic sensitivity". A control loop that skips its output
  // stage is not a control loop.
  if (level <= 0) { gateAudio(Date.now()); return; }   // muted: close, do not learn

  // LEARN BEFORE JUDGING. The floor starts cold at 0.01, so in a loud room the
  // first second reads as "way above the floor" and fires the 🎙 at the room
  // itself — which is exactly what R saw: "it seemed like mic sensitivity was
  // picking up a fair amount of background noise". Simulation put essentially
  // every remaining false trigger in this window. Spend the first ~1s measuring
  // only. Erring here is free: nobody speaks in the first tick after unmuting,
  // and a missed onset costs an icon, not audio (audio always flows).
  if (_settle < 8) {
    _settle++;
    const a0 = level < _noise ? 0.3 : 0.5;
    _noise += (level - _noise) * a0;
    gateAudio(Date.now());               // measuring, but still CLOSED — not frozen
    return;
  }

  // NOISE FLOOR: minimum-of-block-minima, ported from BasisVR
  // (BasisNoiseFloorTracker, MIT — R: "I'll bet money BasisVR already solved
  // this"; she was right, and their design is better than the follower I
  // hand-tuned). 6 blocks × 0.4s: take the quietest RMS in each block, then the
  // quietest block. The floor therefore tracks the quietest moment in the last
  // ~2.4s, so SPEECH CAN NEVER RAISE IT — structurally, not by tuning. My
  // exponential follower could be dragged up by a long utterance and gate the
  // speaker out mid-sentence; this cannot, and needed no rate constant at all.
  const nowT = Date.now();
  if (level < _blockMin) _blockMin = level;
  if (nowT - _blockStart >= 400) {
    _blockStart = nowT;
    _blocks[_blockIdx] = _blockMin;
    _blockIdx = (_blockIdx + 1) % 6;
    if (_blocksFilled < 6) _blocksFilled++;
    _blockMin = Infinity;
  }
  _noise = Math.max(1e-5, Math.min(_blockMin, ...(_blocks.slice(0, _blocksFilled))));

  // THRESHOLD IS MULTIPLICATIVE, not additive — also theirs (AutoGateOverNoise
  // = 2.5). This is the same lesson as "a fixed 0.04 cannot work across mics",
  // one level up: an ADDITIVE margin is still an absolute number, so it is
  // wrong at a different gain. `floor × k` scales with the signal and is the
  // only form that behaves the same on a headset and a laptop array.
  //
  // The slider picks k over 1.6…5.0, with 2.5 (their default) mid-scale.
  // FIXED THRESHOLD, Discord-style. The noise floor is still measured (it drives
  // nothing now but is kept for the meter and for diagnosing "why did it not
  // open"), but the GATE compares against an absolute dB level the user set.
  // That is what makes the marker stay put while the level moves past it.
  const on = gateThreshold();
  const off = on * 0.7;                    // ~3 dB of hysteresis

  const now = Date.now();
  if (level >= on) {
    _openUntil = now + 700;               // hang-time: see gateAudio()
    if (!_above) { _above = true; _openedAt = now; _announced = false; }
    // 🔴 THE PILL AND THE AUDIO MUST AGREE. R: "sometimes I can see the TTS voice
    // threshold getting triggered (pill over the head) without hearing anything
    // through hear-myself — these should have the exact same gate."
    //
    // They shared the threshold but not the OBSERVABLE. The pill fired the instant
    // `_above` flipped; the audio rides an envelope, so a single-tick spike (a
    // cough, a key) trips the flag and is nearly inaudible before the gate shuts.
    // Announce only once the gate has been open long enough to have actually
    // PASSED audio — one envelope's worth. The pill then means "the room heard
    // something", which is what a pill over your head claims.
    if (!_announced && now - _openedAt >= 60 && now - _lastOnset > 1500) {
      _announced = true; _lastOnset = now; sendTyping(null, 'mic');
    }
  } else if (_above && level < off && now > _openUntil) _above = false;
  gateAudio(now);
}

// 🔴 THE GATE MUST GATE THE AUDIO, NOT JUST THE ICON. R, 2026-08-09: "I would
// DEFINITELY gate the mic sensitivity to cover the full audio channel so every
// little background noise isn't broadcasted to the room. That's extra confusing
// because we have no affordance to say when audio is getting broadcasted."
//
// She is right and I had this backwards: I spent an hour tuning this thing as an
// INDICATOR problem, when the indicator was reporting truthfully — audio really
// was always flowing. Your keyboard, your fan and your family went to the room
// whenever the mic was open, and the only thing the threshold changed was a
// glyph. A "sensitivity" control that does not control what anyone hears is
// worse than none, because it reads as if it does.
//
// track.enabled is the right mechanism: universal (unlike
// MediaStreamTrackGenerator, which is Chromium-only), synchronous, spec-mandated
// to render silence, and already what mute uses — so this cannot fight it.
//
// HANG-TIME, not a hard cut. Speech is full of gaps: stops, breaths, the pause
// before a clause. Closing the instant level drops chops words in half, so the
// gate stays open 700ms past the last sound above threshold and only then
// closes. Cost is 700ms of room tone after each utterance; the alternative is
// being unintelligible.
function gateAudio(now) {
  if (!micStream || muted) { driveGate(false); return; }   // mute is authoritative
  driveGate(_above || now <= _openUntil);
}
/** What the gate is actually doing right now — for the meter and for tuning.
 *  Exposed because "why did it not trigger" is unanswerable from the outside:
 *  the same RMS means different things in different rooms. */
export const micGateInfo = () => ({
  level: micAnalyserLevel(), noise: _noise,
  // 🔴 ONE formula, not a copy. This drifted the moment the gate went
  // multiplicative — it still carried the old additive margin, so the panel and
  // the gate reported DIFFERENT thresholds. Derived from the same expression
  // now; if the gate changes, this cannot silently disagree.
  on: gateThreshold(),
  // 🔴 THRESHOLD *PLUS HANG-TIME* — R: "turn the bar gold when it's streaming
  // live audio over the threshold + hangtime". `_above` alone goes false the
  // instant your level dips, but the gate is still open for another 700ms and
  // the room is still hearing you. Reporting _above would make the bar flicker
  // dark through every pause in a sentence while audio was flowing: an
  // indicator that contradicts the thing it indicates.
  speaking: _above || Date.now() <= _openUntil,
});
function startOnsetWatch() {
  if (_onsetTimer) return;
  _above = false;
  // Re-measure the room on every mic open. A floor learned in a quiet session
  // would gate you out of a loud one — and worse, a floor learned while a fan
  // was running stays high after it stops. Start low and let the follower rise;
  // erring quiet costs a few false 🎙 in the first second, erring loud costs
  // your first sentence.
  _noise = 0.01;
  _settle = 0;
  _blocks = new Array(6).fill(Infinity); _blockIdx = 0; _blocksFilled = 0;
  _blockMin = Infinity; _blockStart = Date.now();                            // re-learn the room, then judge
  // 40ms, not 120: the tick interval is the WORST-CASE CLIP on the first
  // syllable now that this gates audio. 120ms removes an audible chunk of a
  // word's attack; 40ms is under the threshold where a missing onset is
  // perceptible, and the work per tick is one FFT read.
  _onsetTimer = setInterval(onsetTick, 20);
}
function stopOnsetWatch() {
  if (_onsetTimer) { clearInterval(_onsetTimer); _onsetTimer = null; }
  _above = false;
}

// live mic level 0..1 for UI (the mic glyph's hot-glow) — analyser built
// lazily on first ask, rebuilt if the stream changed
let _an = null, _anStream = null, _anBuf = null, _anCtx = null;
export function micAnalyserLevel() {
  // muted → 0 (nothing is being sent, and the gate must not learn a floor from
  // a muted mic). But NOT gated → 0: the gate needs the true input level to
  // decide when to reopen, which is the whole reason we measure the raw side.
  if (!micStream || muted) return 0;
  const measured = _rawMic || micStream;
  if (!_an || _anStream !== measured) {
    try {
      // ONE CONTEXT, REUSED. This made a NEW AudioContext every time the mic
      // stream changed and never closed the old one — and Chrome caps a
      // document at ~6, after which every further context is born unusable and
      // SILENTLY so. Toggle the mic a few times and whatever asks next gets a
      // dead one.
      const ctx = audioContext();
      const src = ctx.createMediaStreamSource(measured);
      _an = ctx.createAnalyser(); _an.fftSize = 512;
      src.connect(_an);
      _anStream = measured;
      _anBuf = new Float32Array(_an.fftSize);
    } catch { return 0; }
  }
  _an.getFloatTimeDomainData(_anBuf);
  let s = 0;
  for (let i = 0; i < _anBuf.length; i++) s += _anBuf[i] * _anBuf[i];
  return Math.sqrt(s / _anBuf.length);
}

// Kept as the explicit verb for "go quiet without touching the mic button's
// meaning" — it is now the SAME mechanism toggleMic uses (track.enabled), so
// the two can no longer disagree. Before 2026-08-08 this was the correct
// implementation with zero callers while the HUD used the destructive path.
export function toggleMute() {
  if (!micStream) return false;
  muted = !muted;
  // Unmuting hands control back to the NOISE GATE, it does not open the mic.
  // Setting enabled=true here would broadcast whatever the room is doing until
  // the next tick closed it again — a small leak, but exactly the one this gate
  // exists to prevent. Muting still forces false immediately: mute must be
  // instant and must never wait for a tick.
  // Mute acts on the RAW device track, not the gated output: the gated stream's
  // track is a graph destination, and disabling it would fight the gain node
  // rather than replace it. Muting at the source is also the honest thing — the
  // microphone genuinely stops contributing.
  for (const t of (_rawMic || micStream).getTracks()) t.enabled = !muted;
  if (!muted) { _above = false; _openUntil = 0; }   // gate decides from here
  driveGate(false);                                  // and close it immediately
  flashHint(muted ? '🔇 muted' : '🎙 unmuted');
  bus.emit('voice', { on: true, muted });
  return muted;
}

/** Release the microphone device entirely — the OS/browser recording indicator
 *  goes away. This is the ONLY path that stops tracks, and it is deliberately
 *  not what the HUD mic button does: it costs a permission re-prompt and a
 *  renegotiation to undo, so it is a privacy action, not a "go quiet" action. */
export function releaseMicrophone() {
  if (!micStream) return;
  // 🔴 STOP THE DEVICE, NEVER THE GRAPH OUTPUT. Two separate rules meet here:
  //
  // (1) The raw device track MUST stop, or the OS recording indicator stays lit
  //     while this function's whole promise is that it goes away. micStream is
  //     now a graph destination, so stopping only that would leave the actual
  //     microphone recording.
  //
  // (2) The GATED track must NOT stop. stop() is a one-way door (see the note in
  //     ontrack above — the same mistake cost us a permanently-deaf peer), and a
  //     MediaStreamDestination track cannot be restarted, so re-enabling the mic
  //     would need a whole new graph and a renegotiation to hand the new track
  //     to every peer. R, 2026-08-09: "we don't want to tear down audio tracks
  //     at all unless someone leaves or unchecks the connect-to-audio box —
  //     that's how we ran into people not hearing each other and unmute lag
  //     while it sets it all up again. Now we just mute the lane."
  //
  // So: kill the device, leave the lane in place at zero gain. The senders keep
  // a live track, no renegotiation is needed, and reacquiring the mic reconnects
  // a new source into the SAME graph.
  for (const t of (_rawMic || micStream).getTracks()) t.stop();
  driveGate(false);              // lane stays up, gain to zero
  detachSource();                // lane (GainNode + destination) SURVIVES
  _rawMic = null;
  // micStream KEEPS naming the gated stream. Its track is still live and still
  // held by every sender, so the mesh needs no renegotiation when the mic comes
  // back — that rebuild is exactly the "unmute lag while it sets it all up
  // again" R described. Audibility is decided by `muted` and the gate; this
  // variable only means "a lane exists".
  // 🔴 THE DEVICE IS GONE, SO SAY SO. micOn() is `micStream && _micLive &&
  // !muted`, and micStream deliberately SURVIVES here (the lane stays up so the
  // mesh needs no renegotiation). That makes _micLive the only variable left
  // that can express "no device is capturing" — and without this line it stayed
  // true, so micOn() reported an open mic after a release. toggleMic() then took
  // its already-on branch and muted a lane with nothing behind it instead of
  // reacquiring the device: the mic button silently stopped working after any
  // release, and getUserMedia was never called again.
  //
  // This is a STATE correction, not a teardown. Nothing is stopped here that
  // wasn't already stopped four lines up; the graph, the senders and the track
  // all stay exactly where they are.
  _micLive = false;
  _micReleased = true;
  muted = false;
  stopOnsetWatch();
  // 🔴 NO UNTRACK, NO RENEGOTIATION — that is the whole contract (#90 B3).
  // Everything above this line promised the standing lane: senders keep the
  // live destination track (currently carrying silence — gain zero, source
  // detached), so reacquiring is attachSource(newDevice) into the SAME graph
  // with zero SDP churn. A removeTrack+renegotiate loop lived here anyway,
  // quietly doing the teardown the comments forswore — every reacquire paid
  // the renegotiation the design existed to avoid, and the lifecycle suite
  // never pinned it. Privacy is not weakened by its removal: the device is
  // stopped (OS indicator off) and the lane transmits silent frames only.
  flashHint('🎙 released');
  bus.emit('voice', { on: false });
}

export function initVoice(name) {
  myId = name;
  bus.on('rtc', onRtc);
  // revoking consent is retroactive: existing inbound legs come down at once.
  // If our mic is live we re-offer, so our outbound (which they consented to)
  // survives — revoking "I hear you" must not silently revoke "you hear me".
  bus.on('audio:receive', (on) => {
    if (on) {
      // permit inbound on peers we already hold, then reach the rest
      // Re-enable anything the gate silenced on arrival. Without this, a
      // track that landed while receive was off stays enabled=false forever:
      // the direction below is repaired but no audio is ever heard, which is
      // the one-way bug this pairs with. Idempotent, so it is safe on every
      // flip; a track that was never silenced is simply set true again.
      for (const p of peers.values()) reenableInbound(p);
      for (const p of peers.values()) applyDirection(p);
      for (const id of [...peers.keys()]) renegotiate(id);
      if (micStream) for (const id of humanIds()) if (!peers.has(id)) offerTo(id);
      // and tell everyone: any sender whose offer we consent-dropped is
      // wedged with no path to us until they hear this (#34 wake)
      for (const id of humanIds()) sendRtc(id, { recvReady: true });
      return;
    }
    // revoked: inbound legs come down. If our mic is live the outbound they
    // consented to is re-established — SENDONLY, so the re-offer cannot
    // smuggle back the inbound we just refused (review catch).
    for (const id of [...peers.keys()]) dropPeer(id);
    if (micStream) for (const id of humanIds()) offerTo(id);
  });
  // A generation ended — leave, kick/ban, reconnect prune, or a TAKEOVER.
  // The takeover is why this cannot ride the roster sweep below: the id is
  // still present, but the peer (and its analyser) belonged to the
  // predecessor's connection and must not survive into the successor (#97
  // review). A live mic re-offers on the roster event that follows.
  bus.on('participant-teardown', (id) => dropPeer(id));
  bus.on('roster', () => {
    // Arrivals get an offer while we're LIVE; departures get torn down.
    // micOn(), not micStream: since mic-off keeps the stream and only disables
    // the track, `micStream` is truthy while muted and would court strangers we
    // have nothing to say to. Transmitting is the condition that matters.
    // A synth-lane body courts arrivals exactly like a live mic: it is a
    // transmitting body whose voice happens to be synthesized (r3 B4).
    if (micOn() || synthLaneActive()) for (const id of humanIds()) if (!peers.has(id)) offerTo(id);
    for (const id of [...peers.keys()]) if (!remotes.has(id)) dropPeer(id);
  });
  // Two clocks on purpose. Distance is a slow fact — 300ms is plenty and
  // keeps the per-frame cost near zero. The hush FADE is a gesture, and a
  // gesture quantized to 300ms steps feels like a fade drawn with a ruler.
  // So the target is recomputed slowly and the approach runs fast (R, testing
  // live at 12:32: "I really like the audio fade — I'd halve the time").
  // 700ms edge-to-edge, linear — and it genuinely reaches zero.
  setInterval(() => {
    for (const [id, p] of peers) {
      const r = remotes.get(id);
      if (!r?.avatar?.root || !p.audio.srcObject) continue;
      const d = r.avatar.root.position.distanceTo(myState.pos);
      const roll = Math.min(1, Math.max(0, 1 - (d - FULL_M) / (SILENT_M - FULL_M)));
      // distance × slider × hush. HUSH IS A GAIN, never a teardown: the stream
      // keeps arriving and advancing, so unhushing rejoins the sentence already
      // in progress instead of starting the next one — the way you rejoin a
      // human voice you had stopped attending to. (Field report from a live
      // desk test: a teardown-on-toggle cut the utterance mid-word.)
      p.wantVolume = isHushed() ? 0 : roll * volumeFor('voices');
    }

    // ── RECONCILE: the roster is the truth, the peer map is a cache ──────────
    // 🔴 A REPAIR ONLY ONE ROLE CAN TRIGGER IS NOT A REPAIR. Both rebuild sites
    // (mic-on, and the recvReady flip) require micStream — so a listener who
    // joined MUTED, which is the default, could never rebuild a peer that
    // vanished. That is the same asymmetry class as the disconnected/dropPeer
    // bug: the two ends permanently disagree about whether a connection exists,
    // and only one of them is able to do anything about it.
    //
    // This runs for everyone, mic or no mic. Someone in the roster with no peer
    // is a hole; offerTo() builds a recvonly connection when we have no mic,
    // which is exactly what a listener wants.
    //
    // Cheap by construction: it is a set difference over a handful of ids on a
    // loop that already walks the peers, and offerTo() is a no-op once the peer
    // exists. Deliberately NOT dropping peers absent from the roster — a peer
    // missing from a momentarily-stale roster must not be torn down, which is
    // the mistake this whole file is recovering from.
    for (const id of humanIds()) {
      if (peers.has(id)) continue;
      // Only offer to ids that outrank us, or we and a peer who is ALSO
      // reconciling both offer at once and manufacture glare every 300ms.
      // The lower id offers; the higher waits to be offered to.
      if ((myId ?? '') < id) offerTo(id);
    }

    // ── THE TIMEOUT THAT WAS NOT THERE ───────────────────────────────────────
    // 🔴 `_offeredAt` was WRITTEN twice and READ nowhere; GLARE_GRACE_MS was
    // declared and never used. Both are fossils of a stale-offer timeout that
    // got removed when the glare test moved to `_everStable` — and nothing
    // replaced the recovery it provided.
    //
    // So an offer that is simply never answered wedges FOREVER. Every existing
    // heal path is reactive: they notice have-local-offer when something else
    // arrives. If their tab was backgrounded, the sequencer dropped the
    // point-to-point message, or they reloaded mid-exchange, nothing arrives —
    // renegotiate() bails on non-stable, and the reconciler above skips us
    // because peers.has(id) is true. The peer exists and is permanently deaf.
    //
    // A generous timeout: a real answer comes back in well under a second, so
    // 12s is far past any legitimate round trip and only catches the dead.
    for (const [id, p] of peers) {
      if (p.pc.signalingState !== 'have-local-offer' || !p._offeredAt) continue;
      if (Date.now() - p._offeredAt < 12000) continue;
      p._offeredAt = null;
      // Roll back to stable and re-offer rather than dropping the peer: the far
      // end may be perfectly healthy and merely never have received our SDP.
      // Tearing down here would be the disconnected/dropPeer mistake again.
      p.pc.setLocalDescription({ type: 'rollback' })
        .then(() => offerTo(id))
        .catch((e) => report('voice stale offer', e));
    }
  }, 300);
  // LINEAR, not exponential. An exponential approach spends most of its life
  // crawling through the quiet end — exactly where an ear is most alert to
  // "is that still on?" — so a mute built from decaying multiplications
  // leaves a faint voice hanging for seconds. Measured: the old curve was
  // still nonzero at 2280ms and only crossed -40dB at 1140ms (field report,
  // 12:35: "I can hear a really faint version of your voice for a number of
  // seconds"). My -40dB snap threshold was itself far too quiet to be
  // inaudible. A mute should travel at a constant rate and ARRIVE.
  // Exponential still suits DISTANCE — a physical fact rather than an
  // intention — and that stays on the 300ms pass above.
  const FADE_MS = 700;                       // full-scale travel time
  const STEP = 60 / FADE_MS;                 // per-tick delta at 60ms
  setInterval(() => {
    for (const p of peers.values()) {
      if (!p.audio.srcObject || p.wantVolume == null) continue;
      const d = p.wantVolume - p.audio.volume;
      p.audio.volume = Math.abs(d) <= STEP
        ? p.wantVolume                       // lands exactly, no residue
        : p.audio.volume + Math.sign(d) * STEP;
    }
  }, 60);
}

// test/debug probe — connection states by peer id (the world_debug spirit)
/** Real per-peer inbound-audio stats, for the external browser matrix — the
 *  probe it previously "read" (__voicePcs) never existed, so its inbound
 *  numbers were structurally zero (#36 review). This one queries the actual
 *  RTCPeerConnections. */
export async function voiceStats() {
  const out = {};
  for (const [id, p] of peers) {
    try {
      const stats = await p.pc.getStats();
      let packets = 0;
      stats.forEach((s) => { if (s.type === 'inbound-rtp' && s.kind === 'audio') packets += s.packetsReceived ?? 0; });
      out[id] = { state: p.pc.connectionState, inboundAudioPackets: packets };
    } catch { out[id] = { state: p.pc.connectionState, inboundAudioPackets: null }; }
  }
  return out;
}

// test/debug probes (the world_debug spirit)
export const peerVolume = (id) => peers.get(id)?.audio.volume ?? null;
// test/debug probe — connection states by peer id
export const voiceDebug = () => Object.fromEntries([...peers].map(([id, p]) => [id, p.pc.connectionState]));
/** Which peers have a stream bound for mouth animation. `peerLevels()` skips
 *  any peer without one, and it does so silently — so a peer can be perfectly
 *  audible while its mouth never moves, a half-repair visible only to everyone
 *  ELSE. Exported so that gap is assertable (and greppable in prod) rather
 *  than only observable by watching a face that should be talking. */
/** Which peers owe a follow-up offer, and at which generation. The fourth
 *  timing class is invisible from outside otherwise: a peer that owes a
 *  renegotiation looks exactly like one that does not. */
/** TEST SEAM: clear a peer's pending debt so a regression can isolate work
 *  that could only have come from a DIFFERENT peer generation. */
export const voiceClearPending = (id) => { const p = peers.get(id); if (p) p.pendingReneg = null; };

export const voicePendingReneg = () =>
  Object.fromEntries([...peers].map(([id, p]) => [id, p.pendingReneg ?? null]));

export const voiceMouthBound = () =>
  Object.fromEntries([...peers].map(([id, p]) => [id, !!p.stream]));
export const voicePcs = () => [...peers.values()].map((p) => p.pc); // experiment branch: raw pcs for stats probes

// ---- per-speaker levels (R, 23:30: mouths move in sync with the sound)
// One analyser per inbound stream, built lazily. Same RMS math as the local
// mic glyph; the caller maps id -> avatar. Cheap enough at mesh scale: an
// analyser node is a few hundred bytes and the read is a single loop.
const _peerAn = new Map();          // id -> {an, buf, stream}
/** test/debug probe — how many mouth-animation analysers are live (#95:
 *  each departed speaker used to leave one behind, forever) */
export const voiceAnalyserCount = () => _peerAn.size;
let _peerCtx = null;

export function peerLevels() {
  const out = new Map();
  for (const [id, p] of peers) {
    if (!p.stream) continue;
    let a = _peerAn.get(id);
    if (!a || a.stream !== p.stream) {
      try {
        _peerCtx ??= audioContext();
        const an = _peerCtx.createAnalyser();
        an.fftSize = 512;
        _peerCtx.createMediaStreamSource(p.stream).connect(an);
        a = { an, buf: new Float32Array(an.fftSize), stream: p.stream };
        _peerAn.set(id, a);
      } catch { continue; }
    }
    a.an.getFloatTimeDomainData(a.buf);
    let s = 0;
    for (let i = 0; i < a.buf.length; i++) s += a.buf[i] * a.buf[i];
    out.set(id, Math.min(1, Math.sqrt(s / a.buf.length) * 4));
  }
  return out;
}

/** Sender-side truth for probes: what track, if any, each peer is actually
 *  sending — id, readyState and enabled. Pair it with genTrackInfo() to answer
 *  "am I feeding the track I am sending?", which no local success check can. */
// A REBUILT SOURCE MUST REACH THE SENDERS. When the synthesizer's generator
// dies and is re-made, the new track is a different object; every sender still
// holds the dead one and transmits silence forever while ICE and direction look
// perfectly healthy — indistinguishable from the audio:ended blocker seen in
// the field. replaceTrack needs no renegotiation, so the repair is cheap and
// safe in any signaling state.
/** Put `track` on every audio sender — replaceTrack only, zero SDP churn.
 *  The ONE mechanism for handing the lane between producers (#91 B3): the
 *  mic-off→TTS takeover, the TTS-generator rebuild, and the TTS-only body
 *  all route through here. (Mic-ON goes through applyDirection, which adopts
 *  micStream's gated track by the same replaceTrack — one mechanism per
 *  direction, no WebAudio mixing anywhere.) */
export function rebindSenders(track) {
  for (const p of peers.values())
    for (const s of p.pc.getSenders())
      if (!s.track || s.track.kind === 'audio')
        s.replaceTrack(track).catch((e) => report('voice track rebind', e));
}

setGeneratorRebuildHook((track) => {
  // ADOPT THE SYNTH LANE (r3 B4, caught by the first real-media acceptance
  // run): rebindSenders repairs senders that EXIST, but a body whose mic was
  // never live has none — its transceivers are recvonly (the reconciler's
  // listener shape) and wantDirection() reads micStream to decide send. Every
  // fake-engine suite passed around that hole; two real browsers sent 0 RTP.
  // So a synth track arriving with no lane BECOMES the lane: micStream is the
  // synthetic stream, direction gains send, existing peers renegotiate, and
  // strangers get courted — the same arc a fresh mic takes, minus the gate
  // (frames are data; there is no room noise to gate). _micLive stays false:
  // micOn() asks about the DEVICE, and no device is capturing.
  //
  // Deliberately NOT undone when TTS is disabled: the lane stands and carries
  // silence (the pacer stops feeding it), exactly the standing-lane contract
  // the mic release path documents — going quiet is a data change.
  if (!micStream) {
    if (!track) return;
    micStream = new MediaStream([track]);
    _synthLane = true;
    _synthTrack = track;
    for (const p of peers.values()) applyDirection(p);
    for (const id of [...peers.keys()]) renegotiate(id);
    for (const id of humanIds()) if (!peers.has(id)) offerTo(id);
    return;
  }
  // 🔴 NEVER MUTATE A DEVICE LANE (r4 self-audit — the fourth member of the
  // state-discriminator family). This block used to swap the arriving
  // generator INTO micStream unconditionally. For a SYNTH lane that is the
  // correct rebuild bookkeeping — the stream's whole content is the
  // generator. But when micStream is the STANDING DEVICE LANE (mic used,
  // then off — the release contract keeps it up), the swap evicted the gated
  // destination track and made the lane NAME the generator: the next mic-ON
  // re-enabled the device, asked activeSendTrack() for the lane, and bound
  // the generator — a dead outbound leg via a different door than the one
  // r4 closed (sequence: mic on → off → enable TTS → mic on). The lane is
  // micgate's output and only micgate may restaff it; the hook's job on a
  // device lane is the SENDERS only, and activeSendTrack() already prefers
  // _synthTrack while the mic is not live.
  if (_synthLane) {
    try {
      if (typeof micStream.removeTrack === 'function' && typeof micStream.addTrack === 'function') {
        for (const t of micStream.getTracks()) if (t !== track) micStream.removeTrack(t);
        if (!micStream.getTracks().includes(track)) micStream.addTrack(track);
      }
    } catch (e) { report('voice stream rebind', e); }
  }
  _synthTrack = track;
  for (const p of peers.values()) {
    for (const s of p.pc.getSenders()) {
      if (s.track && s.track.kind !== 'audio') continue;
      s.replaceTrack(track).catch((e) => report('voice track rebind', e));
    }
  }
});

export function senderTrackInfo() {
  const out = [];
  for (const [id, p] of peers) {
    for (const s of p.pc.getSenders()) {
      if (s.track?.kind && s.track.kind !== 'audio') continue;
      out.push({ peer: id, track: s.track
        ? { id: s.track.id, readyState: s.track.readyState, enabled: s.track.enabled } : null });
    }
  }
  return { micOn: micOn(), hasStream: !!micStream,
    localTracks: micStream ? micStream.getTracks().map((t) => ({ id: t.id, readyState: t.readyState, enabled: t.enabled })) : [],
    senders: out };
}


// ONE-WAY AUDIO IS A DIRECTION QUESTION, AND NOTHING ELSE COULD ANSWER IT.
// R, 2026-08-09: Digi could hear her and she could not hear Digi; a full Chrome
// restart FLIPPED which side was deaf. That flip is the whole diagnosis — a
// symptom that swaps with join order lives in negotiation, not in the mic. But
// every check we had (mic on? track live? peer connected?) reports fine on BOTH
// sides of a one-way link, because each end is individually healthy.
//
// What is NOT observable without this: `direction` is the local preference and
// `currentDirection` is what the WIRE actually agreed. They can disagree — that
// is precisely what a direction set outside a renegotiation looks like — and
// only currentDirection explains silence. Also dumps whether our sender has a
// live track and whether the inbound track is enabled, since a track silenced by
// a receive-toggle stays enabled=false forever and produces the same symptom.
//
// Paste voiceDiag() from both browsers; the asymmetry names the culprit.
export function voiceDiag() {
  const out = [];
  for (const [id, p] of peers.entries()) {
    const tx = [], rx = [];
    for (const t of p.pc.getTransceivers?.() ?? []) {
      const kind = t.receiver?.track?.kind || t.sender?.track?.kind;
      if (kind && kind !== 'audio') continue;
      tx.push(`want=${t.direction} wire=${t.currentDirection ?? '—'}`);
      const st = t.sender?.track, rt = t.receiver?.track;
      rx.push(`send:${st ? `${st.readyState}/${st.enabled ? 'on' : 'OFF'}` : 'none'}`
        + ` recv:${rt ? `${rt.readyState}/${rt.enabled ? 'on' : 'OFF'}` : 'none'}`);
    }
    out.push({
      peer: id,
      signaling: p.pc.signalingState,
      conn: p.pc.connectionState,
      ice: p.pc.iceConnectionState,
      everStable: !!p._everStable,
      transceivers: tx,
      tracks: rx,
    });
  }
  return { me: myId, mic: micStream ? 'open' : 'CLOSED',
    wantDirection: wantDirection(), peers: out };
}
/** WHY IS MY MIC NOT LIVE — the one question voiceDiag() cannot answer, because
 *  a mic that silently became a synth generator looks identical to a healthy one
 *  from every angle we had. R, 2026-08-09: "sometimes I toggle the mic and it
 *  seems to be live and sometimes not, and it's just silently failing."
 *
 *  The decisive fact is WHAT KIND OF TRACK we are sending. A real microphone
 *  track has a deviceId and a label from the OS; a MediaStreamTrackGenerator has
 *  neither. Nothing else distinguishes them — same kind, same readyState, same
 *  enabled. */
/** Is there a microphone at all?
 *
 *  R, 2026-08-09: "maybe if there isn't a live mic detected, it can't be turned
 *  on?" — which dissolves the objection I had to mic-beats-TTS. My worry was an
 *  agent silently muted by a mic it never asked for; an agent has no capture
 *  device, so with this guard the mic cannot be on and the case stops existing.
 *
 *  enumerateDevices() works BEFORE permission is granted: labels come back empty
 *  until the user consents, but the entries are there, so presence can be
 *  checked without prompting. Deliberately fails OPEN — if enumeration throws or
 *  the API is missing we return true and let getUserMedia be the real gate,
 *  because refusing a mic that exists is worse than offering one that does not.
 */
export async function hasMicDevice() {
  try {
    const devs = await navigator.mediaDevices?.enumerateDevices?.();
    if (!devs) return true;
    return devs.some((d) => d.kind === 'audioinput');
  } catch { return true; }
}

export function micDiag() {
  const raw = _rawMic?.getAudioTracks?.()[0] || null;
  // WHAT THE SENDERS HOLD, not what local bookkeeping names (r3 B4 field
  // catch): after a mic-off TTS takeover, rebindSenders puts the generator on
  // every sender while micStream still names the standing gated lane — so
  // reading micStream here reported the gate's destination as "sentToPeers"
  // and flunked a transition that was in fact correct on the wire. Ask a real
  // sender first; fall back to the stream only when no peer exists to ask.
  let sent = null;
  for (const p of peers.values()) {
    const st = p.pc.getSenders?.().find((x) => x.track?.kind === 'audio')?.track;
    if (st) { sent = st; break; }
  }
  sent = sent || micStream?.getAudioTracks?.()[0] || null;
  const settings = (t) => { try { return t?.getSettings?.() || {}; } catch { return {}; } };
  const kindOf = (t) => {
    if (!t) return 'none';
    // Constructor first, deviceId second: real Chromium stamps a deviceId on
    // MediaStreamTrackGenerator tracks too (r3 B4 reporter run: the sender
    // provably held the generator — ids matched — while this heuristic called
    // it a microphone). "Has a deviceId" is not "is a device".
    if (t.constructor?.name === 'MediaStreamTrackGenerator') return 'synthetic (generator)';
    const s = settings(t);
    if (s.deviceId) return `microphone (${t.label || 'unnamed'})`;
    return t.label ? `synthetic (${t.label})` : 'synthetic/graph output';
  };
  return {
    micLive: micOn(), muted, gateOpen: gateOpenness() > 0.05,
    rawSource: kindOf(raw),
    sentToPeers: kindOf(sent),
    rawEnabled: raw ? raw.enabled : null,
    sentEnabled: sent ? sent.enabled : null,
    // The tell: if these disagree about being a microphone, the mic silently
    // became something else.
    verdict: !raw ? 'NO DEVICE — nothing was ever opened'
      : !sent ? 'no track being sent'
      // The contradiction case FIRST (r4 review): a live mic whose peers are
      // receiving the synthesizer is a dead outbound leg wearing a green
      // light — the exact state the founding receipt exposed. Never report
      // 'ok' from the capture side alone.
      : micOn() && !/microphone/.test(kindOf(sent))
        ? 'BROKEN: mic is live but peers receive ' + kindOf(sent)
      : !micOn() && /microphone/.test(kindOf(sent)) && gateOpenness() === 0
        ? 'suspect: mic not live yet a device track is on the senders'
      : /microphone/.test(kindOf(raw)) ? 'ok: a real microphone is the source'
      : 'BROKEN: the source is not a microphone',
  };
}
if (typeof window !== 'undefined') window.micDiag = micDiag;
if (typeof window !== 'undefined') window.voiceDiag = voiceDiag;


// Self-monitoring: hear your own GATED lane, exactly as the room hears it.
// Exposed from voice.js so the panel has one import for everything voice-shaped,
// and so a monitor can never outlive the mic it is monitoring.
export function setSelfMonitor(on) {
  if (on && !micStream) return false;     // nothing to monitor yet
  return setMonitor(on);
}
export const selfMonitoring = () => monitoring();
