// voicerelay — the relay-floor voice leg (#104 phase-1 spike).
//
// One leg to the voice relay: publish if speaking, subscribe per speaker.
// This is the ENTIRE required system — reconnect is dumb (rejoin from
// scratch under a fresh credential/incarnation), and that simplicity is the
// whole argument for relay-floor. Cleverness here is a smell.
//
// EXACTLY ONE PLAYBACK OWNER (amendment 6): this module activates only under
// ?relay=1, and main.js then never calls initVoice() — the mesh does not
// exist in a relay session, so no pair of systems can both own a speaker.
//
// Fail-closed receive (amendment 3): we connect with autoSubscribe OFF and
// the SERVER subscribes us per speaker when our listener consent says so —
// receive-off means the relay does not forward, not that we discard.
import { bus, report } from './core.js';
import { sendRelayCredRequest, sendVoiceConsent, sendTyping } from './net.js';
import { remotes, noteSpeaking } from './remotes.js';
import { receivingVoice, volumeFor, isHushed } from './voiceconsent.js';
import { audioContext } from './audioctx.js';
import { myState } from './controller.js';
import { flashHint } from './ui.js';

const FULL_M = 3, SILENT_M = 20;         // same rolloff constants as the mesh
let room = null;                          // livekit Room
let cred = null;                          // {token,url,identity,incarnation,gen,ttl}
let myName = null;
let micTrack = null;                      // LocalAudioTrack while publishing
let wantMic = false;                      // user intent, survives reconnects
const speakers = new Map();               // id -> {audio, stream, an, buf, wantVolume}
let serviceState = { state: 'unknown', incarnation: null };
let _lk = null;                           // lazy module
const lk = async () => (_lk ??= await import('livekit-client'));

export const relayActive = () => !!room;
export const relayMicOn = () => !!micTrack && wantMic;

async function connect() {
  if (!cred) return;
  const { Room, RoomEvent } = await lk();
  const r = new Room({ adaptiveStream: false, dynacast: false });
  r.on(RoomEvent.TrackSubscribed, (track, _pub, participant) => {
    if (track.kind !== 'audio') return;
    const id = participant.identity.replace(/#g\d+$/, '');
    let s = speakers.get(id);
    if (!s) { s = { audio: new Audio(), wantVolume: 0 }; speakers.set(id, s); }
    s.audio.autoplay = true;
    s.audio.playsInline = true;
    const stream = new MediaStream([track.mediaStreamTrack]);
    s.audio.srcObject = stream;
    s.stream = stream;
    s.audio.play().catch(() => addEventListener('click', () => s.audio.play().catch(() => {}), { once: true }));
  });
  r.on(RoomEvent.TrackUnsubscribed, (track, _pub, participant) => {
    if (track.kind !== 'audio') return;
    const id = participant.identity.replace(/#g\d+$/, '');
    const s = speakers.get(id);
    if (s) { s.audio.srcObject = null; s.stream = null; try { s.an?.disconnect(); } catch {} s.an = null; }
  });
  r.on(RoomEvent.Disconnected, () => {
    // Client watchdog — SEPARATE evidence from the sequencer's probe (A2).
    // Dumb recovery: drop everything, ask for a fresh credential; the reply
    // carries the current incarnation and a fresh join follows.
    room = null;
    for (const s of speakers.values()) { s.audio.srcObject = null; try { s.an?.disconnect(); } catch {} }
    speakers.clear();
    micTrack = null;
    if (cred) { cred = null; setTimeout(() => sendRelayCredRequest(), 1000); }
  });
  await r.connect(cred.url, cred.token, { autoSubscribe: false });
  room = r;
  console.log(`[relay] joined as ${cred.identity} (incarnation ${cred.incarnation})`);
  bus.emit('voice-relay', { on: true, incarnation: cred.incarnation });
  // state that survived the reconnect: mic intent and receive consent
  sendVoiceConsent(receivingVoice());
  if (wantMic) publishMic().catch((e) => report('relay mic', e));
}

async function publishMic() {
  if (!room || micTrack) return;
  const { createLocalAudioTrack } = await lk();
  // LiveKit's capture pipeline (AEC/NS) for the spike; the micgate lane joins
  // in the migration phase — phase-1 proves the transport contract.
  micTrack = await createLocalAudioTrack({ echoCancellation: true, noiseSuppression: true });
  await room.localParticipant.publishTrack(micTrack, { dtx: true, red: true });
  flashHint('🎙 live (relay) — speak, the room hears');
  bus.emit('voice', { on: true });
}

/** The relay session's mic toggle — same three-state intent as the mesh's:
 *  off / open. (Self-mute rides track.mute — pre-encode in livekit-client.) */
export async function relayToggleMic() {
  wantMic = !wantMic;
  if (!wantMic && micTrack) {
    await micTrack.mute();                 // pre-encode gate: no bytes leave
    flashHint('🎙 off (relay)');
    bus.emit('voice', { on: false });
    return false;
  }
  if (wantMic && micTrack) { await micTrack.unmute(); bus.emit('voice', { on: true }); return true; }
  if (wantMic) await publishMic();
  return wantMic;
}

export function initVoiceRelay(name) {
  myName = name;
  bus.on('relay-cred', (msg) => {
    cred = msg;
    serviceState = msg.service ?? serviceState;
    connect().catch((e) => { report('relay connect', e); cred = null; });
  });
  bus.on('voice-service', (svc) => {
    const restarted = serviceState.incarnation && svc.incarnation !== serviceState.incarnation;
    serviceState = svc;
    if (svc.state === 'degraded') flashHint('🔇 voice service degraded — text and world unaffected');
    if (svc.state === 'up' && (restarted || !room)) {
      // Incarnation moved (or we never joined): every old credential and track
      // is structurally stale. One clean fresh join — nothing to resume.
      try { room?.disconnect(); } catch {}
      room = null; cred = null;
      sendRelayCredRequest();
      flashHint('🔊 voice service up — rejoining');
    }
  });
  // Consent changes are listener-authored and server-enforced; the local pref
  // (voiceconsent.js) stays the single UI source and we forward every flip.
  bus.on('audio:receive', (on) => sendVoiceConsent(on));
  bus.on('roster', () => {
    for (const [id, s] of speakers) if (!remotes.has(id)) {
      s.audio.srcObject = null; try { s.an?.disconnect(); } catch {} speakers.delete(id);
    }
  });
  // Ask for the credential once JOINED — init runs before the ws handshake
  // completes, and an unjoined send is silently dropped. One request per
  // session; reconnect paths re-ask explicitly.
  let asked = false;
  const askOnce = (n) => { if (!asked && n?.joined) { asked = true; sendRelayCredRequest(); } };
  bus.on('net', askOnce);

  // Distance rolloff + hush: same two-clock shape as the mesh (slow target,
  // fast approach), applied to the per-speaker elements.
  setInterval(() => {
    for (const [id, s] of speakers) {
      const r = remotes.get(id);
      if (!r?.avatar?.root || !s.audio.srcObject) continue;
      const d = r.avatar.root.position.distanceTo(myState.pos);
      const roll = Math.min(1, Math.max(0, 1 - (d - FULL_M) / (SILENT_M - FULL_M)));
      s.wantVolume = isHushed() ? 0 : roll * volumeFor('voices');
    }
  }, 300);
  const STEP = 60 / 700;
  setInterval(() => {
    for (const s of speakers.values()) {
      if (!s.audio.srcObject || s.wantVolume == null) continue;
      const d = s.wantVolume - s.audio.volume;
      s.audio.volume = Math.abs(d) <= STEP ? s.wantVolume : s.audio.volume + Math.sign(d) * STEP;
    }
  }, 60);
}

// ---- mouths: same analyser pattern as the mesh's peerLevels ----------------
export function relayPeerLevels() {
  const out = new Map();
  for (const [id, s] of speakers) {
    if (!s.stream) continue;
    if (!s.an) {
      try {
        const ctx = audioContext();
        s.an = ctx.createAnalyser(); s.an.fftSize = 512;
        ctx.createMediaStreamSource(s.stream).connect(s.an);
        s.buf = new Float32Array(s.an.fftSize);
      } catch { continue; }
    }
    s.an.getFloatTimeDomainData(s.buf);
    let sum = 0;
    for (let i = 0; i < s.buf.length; i++) sum += s.buf[i] * s.buf[i];
    out.set(id, Math.min(1, Math.sqrt(sum / s.buf.length) * 4));
  }
  return out;
}

// ---- diagnostics: the relay page (both-ends discipline) --------------------
export function relayDiagClient() {
  return {
    active: relayActive(),
    identity: cred?.identity ?? null,
    gen: cred?.gen ?? null,
    incarnation: cred?.incarnation ?? null,
    service: serviceState,
    micPublished: !!micTrack, micIntent: wantMic,
    speakers: [...speakers.entries()].map(([id, s]) => ({
      id, hasStream: !!s.stream, volume: s.audio?.volume ?? null, wantVolume: s.wantVolume })),
    connectionState: room?.state ?? 'disconnected',
  };
}
if (typeof window !== 'undefined') {
  window.relayDiag = relayDiagClient;
  window.relayMic = relayToggleMic;
}
