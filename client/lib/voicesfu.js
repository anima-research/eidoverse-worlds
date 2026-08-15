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
/** Speaker ids announced by the server, consumed in order by ontrack. Module
 *  level and subscribed ONCE (see sfuConnect) — core.js has no `off`. */
const routeQueue = [];
bus.on('sfu-route', (m) => routeQueue.push(m.speaker));
const speakers = new Map();           // id → { audio, stream, wantVolume, an, buf }

export const sfuActive = () => !!pc && pc.connectionState === 'connected';
export const sfuMicOn = () => !!micStream && wantMic;
/** The mic the user ASKED for, which is not the mic they GOT: sfuMicOn() needs
 *  a live micStream, and a press before `pc` exists sets only this. The bridge
 *  replays it once the credential lands. Intent and achievement must be
 *  readable separately or a pre-connection press is silently lost. */
export const sfuMicWanted = () => wantMic;

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
  //
  // 🔴 ONE SUBSCRIPTION FOR THE MODULE'S LIFETIME, not one per connect. core.js
  // exposes on/emit and NO `off`, so subscribing inside sfuConnect() leaked a
  // listener on every voice-leg reconnect — each bound to a dead pc's array,
  // all of them receiving every announcement while only the newest ontrack
  // consumed one. pending.shift() then desyncs and tracks attach to the WRONG
  // speaker id. The module-level array is rebound here instead.
  routeQueue.length = 0;
  pc.ontrack = (e) => {
    // 🔴 PREFER THE TRACK'S OWN IDENTITY. The server now names each outbound
    // stream after the speaker it carries (sfu.ts ensureRoute), so msid gives
    // us identity that CANNOT desync — the id arrives welded to the media
    // instead of correlated with it by arrival order. Basis's principle:
    // ServerAudioSegmentMessage carries {playerId, audioData} together.
    //
    // The queue stays as a fallback for a server that predates this, but it is
    // no longer the load-bearing path. When both are present and DISAGREE, msid
    // wins and we say so loudly — that disagreement is exactly the silent
    // wrong-avatar bug we could never see before.
    const viaMsid = e.streams?.[0]?.id;
    const viaQueue = routeQueue.shift();
    const id = (viaMsid && viaMsid !== 'default') ? viaMsid : viaQueue;
    if (viaMsid && viaQueue && viaMsid !== 'default' && viaMsid !== viaQueue) {
      console.warn('[sfu] route identity mismatch — msid', viaMsid, 'vs queue', viaQueue, '(trusting msid)');
    }
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
 *  what the browser's own AGC/NS/AEC expect.
 *
 *  🔴 CORRECTED 2026-08-15 (read the tree, don't repeat your own summary). This
 *  comment used to say "Basis hand-builds all three". Two-thirds wrong:
 *    • AGC — hand-built and SERIOUS. BasisMicrophoneAgc.cs is a speech-level
 *      normalizer with a minimum-statistics noise-floor tracker, asymmetric
 *      attack/release, and gain HELD across pauses so the next utterance starts
 *      at level. 588 lines of tests (BasisMicrophoneAgcTests.cs), whose names
 *      are the best available checklist for judging ours.
 *    • NS  — NOT hand-built: a native RNNoise binding (com.xiph.rnnoise,
 *      prebuilt librnnoise per platform). Defaults OFF.
 *    • AEC — DOES NOT EXIST in their tree. Zero hits for echo-cancel/AEC/
 *      SpeexDSP/aec3 across every .cs. They rely on OS AEC or headphones.
 *  So the honest version of our argument is narrower and still holds: the
 *  browser hands us AGC+NS+AEC for free, and AEC is the one Basis never got at
 *  all. Their real declined cost for us is the 745-line jitter buffer. */
// 🔴 ONE ACQUISITION AT A TIME (review, 2026-08-15). getUserMedia is SLOW — a
// permission prompt is seconds — and two callers can be inside it at once: the
// user pressing V, and the relay-cred replay that honours a pre-connection
// press. Both saw `micStream == null`, both awaited, and both ran addTrack:
// TWO audio senders, two negotiations, the user published twice (echoing to
// every listener), and the first stream orphaned — `sfuClose` cannot stop it
// because micStream no longer names it, so THE MIC HARDWARE LIGHT STAYS ON
// AFTER LEAVING. The guard is the promise, not a boolean: late callers await
// the same acquisition instead of starting a second one.
let micPending = null;

export async function sfuMic(on = true) {
  wantMic = on;
  if (!pc) return;
  if (!on) { micStream?.getTracks().forEach((t) => (t.enabled = false)); return; }
  if (micStream) { micStream.getTracks().forEach((t) => (t.enabled = true)); return; }
  if (micPending) { await micPending; micStream?.getTracks().forEach((t) => (t.enabled = true)); return; }
  micPending = (async () => {
    const s = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    micStream = s;
    for (const t of s.getTracks()) pc.addTrack(t, s);
  })();
  // A DENIED permission prompt is a normal answer, not a crash. getUserMedia
  // rejects, and no caller catches: the relay-cred replay (voicesfubridge:47)
  // would take an unhandled rejection into a bus handler. Clear the intent so
  // the state stays honest — sfuMicOn() is `!!micStream && wantMic`, so leaving
  // wantMic true after a denial would be a claim we did not earn.
  try {
    await micPending;
  } catch (e) {
    wantMic = false;
    console.warn('[sfu] mic not granted:', e?.name || e);
    return;
  } finally { micPending = null; }
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

/** Live inbound-audio stats — the browser's NetEq telling us what it is doing.
 *  Exposed because #104's measurement hygiene wants delivered AND destroyed
 *  counted separately, and because these fields ARE the evidence that we do not
 *  need Basis's 745-line jitter buffer: jitterBufferTargetDelay is NetEq's
 *  adaptive depth, inserted/removedSamples are its time-stretching, and
 *  concealedSamples is its PLC. All of it for free, on the receive side. */
export async function sfuInboundStats() {
  if (!pc) return [];
  const out = [];
  (await pc.getStats()).forEach((r) => {
    if (r.type === 'inbound-rtp' && r.kind === 'audio') out.push({
      packetsReceived: r.packetsReceived, packetsLost: r.packetsLost, jitter: r.jitter,
      jitterBufferDelay: r.jitterBufferDelay, jitterBufferTargetDelay: r.jitterBufferTargetDelay,
      jitterBufferEmittedCount: r.jitterBufferEmittedCount,
      concealedSamples: r.concealedSamples, concealmentEvents: r.concealmentEvents,
      insertedSamplesForDeceleration: r.insertedSamplesForDeceleration,
      removedSamplesForAcceleration: r.removedSamplesForAcceleration,
      fecPacketsReceived: r.fecPacketsReceived, fecPacketsDiscarded: r.fecPacketsDiscarded,
    });
  });
  return out;
}

export function sfuClose() {
  try { pc?.close(); } catch {}
  pc = null;
  for (const s of speakers.values()) { s.audio.srcObject = null; try { s.an?.disconnect(); } catch {} }
  speakers.clear();
}
