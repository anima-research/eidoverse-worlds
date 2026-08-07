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
export const micOn = () => !!micStream;
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
function applyDirection(p) {
  const dir = wantDirection();
  try {
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
  p = { pc, audio };
  peers.set(id, p);
  if (micStream) for (const t of micStream.getTracks()) pc.addTrack(t, micStream);
  pc.ontrack = (e) => {
    // FAIL CLOSED: consent can be revoked mid-negotiation, and a track that
    // was in flight when it happened must not land. Nothing is attached and
    // nothing plays unless receive is on at the moment audio actually arrives.
    if (!receivingVoice()) { try { for (const t of e.streams[0]?.getTracks() ?? []) t.stop(); } catch { /* best effort */ } return; }
    audio.srcObject = e.streams[0];
    p.stream = e.streams[0];        // kept so their mouth can move with their voice
    // autoplay policy: if the browser balks (receiver never clicked anything),
    // retry on the next user gesture rather than failing silently
    audio.play().catch(() => addEventListener('click', () => audio.play().catch(() => {}), { once: true }));
  };
  pc.onicecandidate = (e) => { if (e.candidate) sendRtc(id, { ice: e.candidate }); };
  pc.onconnectionstatechange = () => (window.__iceLog ??= []).push(`conn[${id}]=${pc.connectionState}`);
  pc.oniceconnectionstatechange = () => (window.__iceLog ??= []).push(`icestate[${id}]=${pc.iceConnectionState}`);
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

async function renegotiate(id) {
  const p = peers.get(id);
  if (!p || p.pc.signalingState !== 'stable') return;
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
    } else if (payload.sdp?.type === 'answer') {
      if (p.pc.signalingState === 'have-local-offer') {
        await p.pc.setRemoteDescription(payload.sdp);
      for (const c of p.pendingIce ?? []) {
        await p.pc.addIceCandidate(c).catch((err) => (window.__iceLog ??= []).push(`flushIce-FAIL ${err.name}`));
      }
      p.pendingIce = [];
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
  if (micStream) {
    // SEND state only. Going quiet must not deafen you: listening is a
    // separate permission (review catch — the old teardown dropped every
    // peer, including inbound legs, which then had no trigger to re-offer
    // until the next roster event, so muting yourself silently deafened you
    // for an unbounded time). We remove OUR track from each peer and keep
    // the connection alive; if we are not listening either, THEN the peer
    // has no purpose and comes down.
    for (const t of micStream.getTracks()) t.stop();
    micStream = null;
    stopOnsetWatch();
    muted = false;
    for (const [id, p] of [...peers]) {
      try {
        for (const sender of p.pc.getSenders()) if (sender.track) p.pc.removeTrack(sender);
      } catch (e) { report('voice untrack', e); }
      if (!receivingVoice()) dropPeer(id);
      else renegotiate(id);          // tell them our track is gone; keep theirs
    }
    flashHint('🎙 off');
    bus.emit('voice', { on: false });
    return false;
  }
  try {
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true },
    });
  } catch (e) {
    report('microphone', e);
    flashHint('microphone unavailable — check browser permission');
    return false;
  }
  for (const id of humanIds()) offerTo(id);
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

export function toggleMute() {
  if (!micStream) return false;
  muted = !muted;
  for (const t of micStream.getTracks()) t.enabled = !muted;
  flashHint(muted ? '🔇 muted' : '🎙 unmuted');
  bus.emit('voice', { on: true, muted });
  return muted;
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
    // arrivals get an offer while we're live; departures get torn down
    if (micStream) for (const id of humanIds()) if (!peers.has(id)) offerTo(id);
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
