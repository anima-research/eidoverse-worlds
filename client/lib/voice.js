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
import { sendRtc } from './net.js';
import { remotes } from './remotes.js';
import { myState } from './controller.js';
import { flashHint } from './ui.js';

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
    audio.srcObject = e.streams[0];
    p.stream = e.streams[0];        // kept so their mouth can move with their voice
    // autoplay policy: if the browser balks (receiver never clicked anything),
    // retry on the next user gesture rather than failing silently
    audio.play().catch(() => addEventListener('click', () => audio.play().catch(() => {}), { once: true }));
  };
  pc.onicecandidate = (e) => { if (e.candidate) sendRtc(id, { ice: e.candidate }); };
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

async function offerTo(id) {
  const p = peerFor(id);
  try {
    const offer = await p.pc.createOffer({ offerToReceiveAudio: true });
    await p.pc.setLocalDescription(offer);
    sendRtc(id, { sdp: p.pc.localDescription });
  } catch (e) { report('voice offer', e); }
}

async function onRtc(msg) {
  const { from, payload } = msg;
  const p = peerFor(from);
  try {
    if (payload.sdp?.type === 'offer') {
      // glare: both sides offered at once — the LOWER id's offer stands, the
      // higher id rolls back and answers (deterministic, no extra messages)
      if (p.pc.signalingState === 'have-local-offer') {
        if ((myId ?? '') < from) return;               // mine stands; ignore theirs
        await p.pc.setLocalDescription({ type: 'rollback' });
      }
      await p.pc.setRemoteDescription(payload.sdp);
      const answer = await p.pc.createAnswer();
      await p.pc.setLocalDescription(answer);
      sendRtc(from, { sdp: p.pc.localDescription });
    } else if (payload.sdp?.type === 'answer') {
      if (p.pc.signalingState === 'have-local-offer') await p.pc.setRemoteDescription(payload.sdp);
    } else if (payload.ice) {
      await p.pc.addIceCandidate(payload.ice).catch(() => {}); // late ICE for a rolled-back pc: harmless
    }
  } catch (e) { report('voice signal', e); }
}

export async function toggleMic(name) {
  myId = name ?? myId;
  if (micStream) {
    // full off: stop tracks, tear down our outbound legs (peers who still
    // send to us will re-offer if they care; simplest correct teardown)
    for (const t of micStream.getTracks()) t.stop();
    micStream = null;
    muted = false;
    for (const id of [...peers.keys()]) dropPeer(id);
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
  return true;
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
  bus.on('roster', () => {
    // arrivals get an offer while we're live; departures get torn down
    if (micStream) for (const id of humanIds()) if (!peers.has(id)) offerTo(id);
    for (const id of [...peers.keys()]) if (!remotes.has(id)) dropPeer(id);
  });
  setInterval(() => {
    for (const [id, p] of peers) {
      const r = remotes.get(id);
      if (!r?.avatar?.root || !p.audio.srcObject) continue;
      const d = r.avatar.root.position.distanceTo(myState.pos);
      p.audio.volume = Math.min(1, Math.max(0, 1 - (d - FULL_M) / (SILENT_M - FULL_M)));
    }
  }, 300);
}

// test/debug probe — connection states by peer id (the world_debug spirit)
export const voiceDebug = () => Object.fromEntries([...peers].map(([id, p]) => [id, p.pc.connectionState]));

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
