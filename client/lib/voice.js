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
import { micFloor } from './voiceconsent.js';
import { myState } from './controller.js';
import { flashHint } from './ui.js';
import { receivingVoice, volumeFor, isHushed } from './voiceconsent.js';

const RTC_CFG = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };
const FULL_M = 3, SILENT_M = 20;   // full volume inside 3m, gone by 20m

let micStream = null;
let muted = false;
const peers = new Map();           // id -> { pc, audio }
let myId = null;
// TRANSMITTING, not "a stream object exists". Going quiet now disables the
// track instead of stopping it (see toggleMic), so micStream outlives mic-off
// and `!!micStream` would leave the HUD stuck reading ON. Every caller of
// micOn() is UI asking "am I being heard right now?" — this is that question.
export const micOn = () => !!micStream && micStream.getAudioTracks().some((t) => t.enabled);
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
      const track = micStream.getAudioTracks()[0];
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
  pc.addEventListener?.('connectionstatechange', () => (window.__iceLog ??= []).push(`conn[${id}]=${pc.connectionState}`));
  pc.addEventListener?.('iceconnectionstatechange', () => (window.__iceLog ??= []).push(`icestate[${id}]=${pc.iceConnectionState}`));
  pc.onconnectionstatechange = () => {
    if (['failed', 'closed', 'disconnected'].includes(pc.connectionState)) dropPeer(id);
  };
  return p;
}

function dropPeer(id) {
  const p = peers.get(id);
  if (!p) return;
  peers.delete(id);
  try { p.pc.close(); } catch (e) { report('voice close', e); }
  p.audio.srcObject = null;
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
    sendRtc(id, { sdp: p.pc.localDescription });
  } catch (e) { report(label, e); } finally { p._offering = false; }
}

/** Fire exactly one follow-up offer if our track set changed while this peer
 *  was mid-negotiation. Generation-bound: pending work raised against an
 *  earlier peer object is discarded rather than applied to its replacement.
 *  Idempotent — the flag is cleared before the offer, so a repeated call
 *  cannot stack duplicate offers. */
function reconcilePending(p, id) {
  if (!p || p.pendingReneg == null) return;
  const owed = p.pendingReneg;
  p.pendingReneg = null;                 // clear FIRST: no duplicate follow-ups
  if (owed !== p.gen) return;            // raised against a peer that no longer exists
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
      if (!peers.has(from)) offerTo(from);
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
  const p = payload.ice ? peers.get(from) : peerFor(from);
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
      // glare: both sides offered at once — the LOWER id's offer stands, the
      // higher id rolls back and answers (deterministic, no extra messages)
      if (p.pc.signalingState === 'have-local-offer') {
        if ((myId ?? '') < from) return;               // mine stands; ignore theirs
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
    for (const t of micStream.getTracks()) t.enabled = false;
    stopOnsetWatch();
    muted = false;
    flashHint('🎙 off');
    bus.emit('voice', { on: false });
    return false;
  }
  // Coming back. If we still hold the stream (the normal case now — mic-off
  // only disables it) re-enabling IS the whole acquisition step: no
  // getUserMedia, so no permission re-prompt and no new track object. Then we
  // fall THROUGH to the same attach/renegotiate/court-peers path a fresh mic
  // takes; returning early here skipped peer creation entirely, which the
  // lifecycle suite caught at once (mic ON with no peer courted).
  if (micStream) {
    for (const t of micStream.getTracks()) t.enabled = true;
  } else {
    try {
      micStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
      });
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
let _onsetTimer = null, _above = false, _lastOnset = 0;
function onsetTick() {
  const floor = micFloor();
  const level = micAnalyserLevel();
  if (!_above && level >= floor) {
    _above = true;
    const now = Date.now();
    if (now - _lastOnset > 1500) { _lastOnset = now; sendTyping(null, 'mic'); }
  } else if (_above && level < floor * 0.6) _above = false;
}
function startOnsetWatch() {
  if (_onsetTimer) return;
  _above = false;
  _onsetTimer = setInterval(onsetTick, 120);
}
function stopOnsetWatch() {
  if (_onsetTimer) { clearInterval(_onsetTimer); _onsetTimer = null; }
  _above = false;
}

// live mic level 0..1 for UI (the mic glyph's hot-glow) — analyser built
// lazily on first ask, rebuilt if the stream changed
let _an = null, _anStream = null, _anBuf = null;
export function micAnalyserLevel() {
  if (!micStream || muted) return 0;
  if (!_an || _anStream !== micStream) {
    try {
      const ctx = new AudioContext();
      const src = ctx.createMediaStreamSource(micStream);
      _an = ctx.createAnalyser(); _an.fftSize = 512;
      src.connect(_an);
      _anStream = micStream;
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
  for (const t of micStream.getTracks()) t.enabled = !muted;
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
  for (const t of micStream.getTracks()) t.stop();
  micStream = null;
  muted = false;
  stopOnsetWatch();
  for (const [id, p] of [...peers]) {
    try {
      for (const sender of p.pc.getSenders()) if (sender.track) p.pc.removeTrack(sender);
    } catch (e) { report('voice untrack', e); }
    if (!receivingVoice()) dropPeer(id); else renegotiate(id);
  }
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
  bus.on('roster', () => {
    // Arrivals get an offer while we're LIVE; departures get torn down.
    // micOn(), not micStream: since mic-off keeps the stream and only disables
    // the track, `micStream` is truthy while muted and would court strangers we
    // have nothing to say to. Transmitting is the condition that matters.
    if (micOn()) for (const id of humanIds()) if (!peers.has(id)) offerTo(id);
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
let _peerCtx = null;

export function peerLevels() {
  const out = new Map();
  for (const [id, p] of peers) {
    if (!p.stream) continue;
    let a = _peerAn.get(id);
    if (!a || a.stream !== p.stream) {
      try {
        _peerCtx ??= new AudioContext();
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
