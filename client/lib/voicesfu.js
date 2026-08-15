// voicesfu — the browser half of the in-process SFU, in plain WebRTC.
//
// SIBLING of voicerelay.js, not a replacement. #104 amendment 6 keeps the mesh
// as rollback during staging and forbids the spike from changing production, so
// a third transport must be ADDITIVE: same bus events, same speakers map shape,
// same relayDiag() surface the browser smoke already asserts against.
//
// 🔴 WHY THIS FILE IS SHORT (and why that is the argument, not a shortcut):
// only 5 of voicerelay.js's 200 lines were actually LiveKit — `new Room(...)`
// plus `createLocalAudioTrack`. Everything else (per-speaker <audio> elements,
// distance rolloff, hush, the analyser feeding relayPeerLevels for mouth flap,
// the askOnce join-race guard) is generic browser code that works unchanged
// against any transport. The SDK was never carrying the hard part.
//
// 🔴 THE SERVER OFFERS, ALWAYS. A browser publishing its mic offers `sendonly`;
// an answer cannot add a receive direction the offer never proposed, so a
// server that answers silently forwards into a track nobody receives
// (measured: forwarded=20, heard=0). Every renegotiation here is
// server-initiated: we only ever setRemoteDescription(offer) → answer.
import { bus } from './core.js';
import { audioContext } from './audioctx.js';

let pc = null, cred = null, micStream = null, wantMic = false;
const speakers = new Map();           // id → { audio, stream, wantVolume, an, buf }

export const sfuActive = () => !!pc && pc.connectionState === 'connected';
export const sfuMicOn = () => !!micStream && wantMic;

/** Attach a remote track to a per-speaker <audio>, exactly as the LiveKit path
 *  does — the playback half is transport-agnostic and stays byte-identical so
 *  the rolloff/hush/analyser code below can be shared verbatim. */
function attach(id, track) {
  let s = speakers.get(id);
  if (!s) { s = { audio: new Audio(), wantVolume: 0 }; speakers.set(id, s); }
  s.audio.autoplay = true;
  s.audio.playsInline = true;
  const stream = new MediaStream([track]);
  s.audio.srcObject = stream;
  s.stream = stream;
  // Autoplay policy: a page that has not been clicked cannot start audio. The
  // smoke launches Chromium with --autoplay-policy=no-user-gesture-required,
  // but a real user's first join needs this fallback or they hear nothing and
  // nothing in the logs says why.
  s.audio.play().catch(() =>
    addEventListener('click', () => s.audio.play().catch(() => {}), { once: true }));
}

export async function sfuConnect(credential, send) {
  cred = credential;
  pc = new RTCPeerConnection({ iceServers: [] });   // same host: no STUN needed

  // The server names each route by the speaker it carries, in the transceiver's
  // mid → we cannot read that portably, so the SERVER tells us via a sideband
  // `sfu-route` message before the offer that adds it. ontrack then pairs the
  // arriving track with the speaker id in arrival order.
  const pending = [];
  bus.on('sfu-route', (m) => pending.push(m.speaker));
  pc.ontrack = (e) => {
    const id = pending.shift();
    if (id) attach(id, e.track);
  };

  pc.onicecandidate = (e) => { if (e.candidate) send({ type: 'sfu-ice', candidate: e.candidate }); };
  return pc;
}

/** Server-initiated renegotiation. The ONLY negotiation path — see the header. */
export async function sfuOnOffer(sdp, send) {
  if (!pc) return;
  await pc.setRemoteDescription({ type: 'offer', sdp });
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  send({ type: 'sfu-answer', sdp: answer.sdp });
}

export async function sfuOnIce(candidate) {
  try { await pc?.addIceCandidate(candidate); } catch {}
}

/** Publish the mic. Plain getUserMedia — no SDK wrapper. The constraints match
 *  what the browser's own AGC/NS/AEC expect; Basis hand-builds all three
 *  (BasisMicrophoneAgcTests.cs) because Unity has no equivalent, and that is
 *  precisely the work we are declining to redo. */
export async function sfuMic(on = true) {
  wantMic = on;
  if (!pc) return;
  if (!on) { micStream?.getTracks().forEach((t) => (t.enabled = false)); return; }
  if (micStream) { micStream.getTracks().forEach((t) => (t.enabled = true)); return; }
  micStream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });
  for (const t of micStream.getTracks()) pc.addTrack(t, micStream);
  // Adding a track makes US want to renegotiate — but the server offers, so we
  // ASK it to, rather than offering ourselves and causing glare.
  bus.emit('sfu-want-negotiate', {});
}

/** Same shape relayPeerLevels() returns, so mouth-flap code is shared. */
export function sfuPeerLevels() {
  const out = new Map();
  for (const [id, s] of speakers) {
    if (!s.stream) continue;
    if (!s.an) {
      try {
        const ctx = audioContext();      // the shared context, not a new one per speaker
        s.an = ctx.createAnalyser(); s.an.fftSize = 512;
        ctx.createMediaStreamSource(s.stream).connect(s.an);
        s.buf = new Float32Array(s.an.fftSize);
      } catch { continue; }
    }
    s.an.getFloatTimeDomainData(s.buf);
    let peak = 0;
    for (const v of s.buf) peak = Math.max(peak, Math.abs(v));
    out.set(id, peak);
  }
  return out;
}

/** The diag surface the browser smoke asserts against — same keys as
 *  relayDiag() so one smoke test can drive either transport. */
export function sfuDiagClient() {
  return {
    transport: 'sfu',
    active: sfuActive(),
    identity: cred?.identity ?? null,
    micPublished: sfuMicOn(),
    speakers: [...speakers.entries()].map(([id, s]) => ({ id, hasStream: !!s.stream })),
  };
}

/** Live speaker records, for the rolloff/hush loops in the bridge. Returns the
 *  actual objects (playback state must be mutated in place, not on a copy) but
 *  as entries rather than the Map itself, so a caller cannot add or delete
 *  speakers behind ontrack's back. */
export function sfuSpeakerEntries() { return [...speakers.entries()]; }

export function sfuClose() {
  try { pc?.close(); } catch {}
  pc = null;
  for (const s of speakers.values()) { s.audio.srcObject = null; try { s.an?.disconnect(); } catch {} }
  speakers.clear();
}
