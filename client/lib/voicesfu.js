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
// A dead media path must be visible to the PERSON, not only in the console —
// they are holding a phone and watching a gold mic meter that is telling them
// the truth about capture and nothing about transmission.
import { logChat } from './chat.js';
import { playWhenAllowed } from './audiounlock.js';

let pc = null, cred = null, micStream = null, wantMic = false;
// My own outbound analyser (sfuMyLevel). Declared HERE, with the rest of the
// module state, because sfuConnect() clears it on reconnect — a `let` further
// down the file is in the temporal dead zone for any caller that runs during
// module evaluation, and that is a runtime error `node --check` cannot see.
let _myAn = null, _myBuf = null, _myStream = null;
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
  // Autoplay policy: a page that has not been gestured at cannot start audio.
  // The smoke launches Chromium with --autoplay-policy=no-user-gesture-required,
  // but a real user's first join needs the unlock queue — see audiounlock.js for
  // why the old one-shot 'click' listener silently failed on a phone.
  playWhenAllowed(s.audio, id);
}

export async function sfuConnect(credential, send) {
  cred = credential;
  // 🔴 A MIC TRACK BELONGS TO THE PC THAT PUBLISHED IT (2026-08-15, found live
  // — R's mic read ON and published NOTHING for an entire session while a
  // freshly-loaded tab worked fine).
  //
  // On a reconnect this function builds a NEW pc, but `micStream` still named
  // the OLD one's stream. The bridge then replays the wanted mic (`if
  // (sfuMicWanted()) await sfuMic(true)`), which hits sfuMic's early return:
  //     if (micStream) { …enable tracks…; return; }
  // …so it re-enabled tracks on a stream attached to a CLOSED peer connection
  // and never called addTrack on the live one. sfuMicOn() is
  // `!!micStream && wantMic` — both true — so the badge lit, the panel
  // ticked, and the server saw publishing=false with rx=0 forever.
  //
  // The old stream's tracks must also be STOPPED, or the mic hardware light
  // stays on for a connection nobody is listening to.
  if (micStream) {
    for (const t of micStream.getTracks()) { try { t.stop(); } catch { /* already dead */ } }
    micStream = null;      // wantMic is deliberately KEPT: intent survives a
                           // reconnect, the stream does not. The bridge's
                           // replay then takes the real addTrack path.
  }
  _myAn = null; _myStream = null;   // the analyser was bound to the dead stream
  // 🔴 THE SERVER CHOOSES THE ICE CONFIG, not this file (2026-08-16). This was
  // `iceServers: []` with the comment "same host: no STUN needed" — true of the
  // loopback pairs it was written against, and the reason a PHONE could not be
  // heard: with no STUN there is no reflexive candidate, so a peer on another
  // network has no viable pair and ICE stalls in 'checking' forever without
  // throwing. The mesh never had this problem because voice.js:33 always
  // carried a STUN server.
  //
  // It comes from the credential (SFU-SPEC.md:113's `iceServers?`) so the
  // operator can point at their own STUN/TURN without a client rebuild. The
  // fallback stays [] — a credential from a server that predates this field
  // behaves exactly as before rather than silently acquiring a public
  // dependency.
  pc = new RTCPeerConnection({ iceServers: credential?.iceServers ?? [] });

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

  // Candidate TYPE is the evidence for the diagnosis below: host-only means no
  // STUN reflexive address was ever obtained, so nothing off this machine can
  // route to us. Recorded here because by the time ICE stalls, the candidates
  // are long gone.
  let _sawNonHostCandidate = false;
  pc.onicecandidate = (e) => {
    if (!e.candidate) return;
    if (e.candidate.type && e.candidate.type !== 'host') _sawNonHostCandidate = true;
    send({ type: 'sfu-ice', candidate: e.candidate });
  };

  // 🔴 A CONNECTION THAT NEVER CONNECTS MUST SAY SO (R, 2026-08-16, from a real
  // phone on a real network: "that probably shouldn't be a silent failure").
  //
  // Nothing here watched connectionState, so the ONLY signal of a dead media
  // path was rxPackets=0 in server-side diag — invisible to the person holding
  // the phone, who sees a gold mic meter (the LOCAL analyser, which is happily
  // reading a live capture) and concludes the mic works. It does. The packets
  // just never leave.
  //
  // The specific failure this caught: `iceServers: []` above is correct for
  // same-host peers and CANNOT work across networks — no STUN means no
  // server-reflexive candidate, no TURN means no relay, so a phone on cellular
  // or another subnet has no viable candidate pair and ICE simply never
  // completes. No exception is thrown; the state machine just stops at
  // 'checking' and sits there.
  //
  // 'disconnected' is deliberately NOT treated as failure — it is often
  // transient and recovers on its own (webrtc-mesh-gotchas: disconnected ≠
  // failed). 'failed' and a stall in 'checking' are the real reports.
  let iceStallTimer = null;
  const clearStall = () => { if (iceStallTimer) { clearTimeout(iceStallTimer); iceStallTimer = null; } };
  pc.oniceconnectionstatechange = () => {
    const st = pc.iceConnectionState;
    if (st === 'checking') {
      clearStall();
      // Host-only candidate pairs settle in well under a second on a LAN; 8s
      // means there is no viable pair and there never will be without STUN/TURN.
      iceStallTimer = setTimeout(() => {
        if (pc.iceConnectionState === 'checking' || pc.iceConnectionState === 'new') {
          const hostOnly = !_sawNonHostCandidate;
          console.error('[voice] 🔴 ICE STALLED — no media path. '
            + `iceConnectionState=${pc.iceConnectionState} after 8s.`
            + (hostOnly ? '  Only HOST candidates were gathered: this peer can only reach '
                + 'the server on the same machine/LAN. A phone or remote listener needs a '
                + 'STUN/TURN server, which this build does not configure (iceServers: []).'
                : '')
            + '  Your mic is capturing (the meter is local) but NOTHING is being transmitted.');
          logChat('*', 'voice: no media path to the server — mic is on but nobody can hear you');
        }
      }, 8000);
    } else if (st === 'connected' || st === 'completed') {
      clearStall();
      console.info(`[voice] ICE ${st} — media path is live`);
    } else if (st === 'failed') {
      clearStall();
      console.error('[voice] 🔴 ICE FAILED — no media path to the server. '
        + 'Mic capture is unaffected and still looks healthy; nothing is reaching anyone.');
      logChat('*', 'voice: connection failed — mic is on but nobody can hear you');
    } else if (st === 'closed') {
      clearStall();
    }
  };
  return pc;
}

/** Server-initiated renegotiation. The ONLY negotiation path — see the header. */
export async function sfuOnOffer(sdp, send) {
  if (!pc) return;
  await pc.setRemoteDescription({ type: 'offer', sdp });
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  // 🔴 PRESENT THE CREDENTIAL (amendment 1). The nonce was minted, handed to
  // us, and never sent back — so the server's replay check had nothing to
  // check and usedNonces was never populated in production. The seven refusals
  // existed and could not run. An admission gate the client never addresses is
  // not a gate.
  send({ type: 'sfu-answer', sdp: answer.sdp, cred: cred && {
    world: cred.world, id: cred.id, primaryGen: cred.primaryGen,
    mediaGen: cred.mediaGen ?? cred.gen, incarnation: cred.incarnation, nonce: cred.nonce } });
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
  if (!on) {
    // 🔴 MIC OFF MUST NOT MEAN VOICE OFF when a synth provider is speaking for
    // you. Disabling the tracks was right for a microphone and wrong for a body
    // whose voice is synthesized: it silenced TTS along with the mic, which is
    // why "mic off" produced no packets at all rather than falling back.
    // Swap the SOURCE instead of muting it, so the sender keeps publishing.
    const { synthProvider } = await import('./voicesource.js');
    // 🔴 SAY WHY THE SWAP DID OR DID NOT HAPPEN. Three rounds of "still zero
    // packets" with no way to tell whether this branch ran, whether the
    // provider was available, or whether publishing failed afterwards. Same
    // lesson as the panel teardown: a path that can decline silently turns the
    // next report into another guess.
    const prov = synthProvider();
    try {
      window.__sfuSrc = `mic off · provider=${prov ? 'registered' : 'NONE'}`
        + (prov ? ` · available=${!!prov.available?.()}` : '');
    } catch { /* no window */ }
    if (prov?.available?.()) {
      // Drop the device stream and let the publish path below re-acquire from
      // voiceSource(), which now returns the synth when micWanted is false.
      // Re-entering rather than duplicating that block keeps ONE place where a
      // track is chosen and attached — the transceiver hunt below is subtle
      // enough that a second copy would drift.
      if (micStream) {
        for (const t of micStream.getTracks()) { try { t.stop(); } catch { /* gone */ } }
        micStream = null;
      }
      try { window.__sfuSrc += ' · swapping to synth'; } catch {}
      return void sfuPublish();
    }
    micStream?.getTracks().forEach((t) => (t.enabled = false));
    try { (await import('./micstate.js')).setMicLive(false); } catch { /* module may be absent in probes */ }
    return;
  }
  // 🔴 A SYNTH STREAM IS NOT A MIC TO RE-ENABLE (regression fix, 2026-08-16).
  // Turning the mic OFF now SWAPS the published source to the synthesizer, so
  // `micStream` may hold synthetic frames. This path re-enabled its tracks and
  // returned — lighting the badge, publishing happily, and never acquiring the
  // microphone. From the server the leg looks identical (same leg, packets
  // flowing) while the mic is not actually captured, so STT transcribes nothing
  // and the only visible symptom is "STT stopped working".
  //
  // I introduced that an hour ago by making mic-off swap rather than mute.
  // Re-acquire whenever the current stream is not a real device.
  if (micStream && !micStream.synthetic) {
    micStream.getTracks().forEach((t) => (t.enabled = true));
    return;
  }
  if (micStream?.synthetic) {
    for (const t of micStream.getTracks()) { try { t.stop(); } catch { /* gone */ } }
    micStream = null;                      // force a real getUserMedia below
  }
  if (micPending) {
    await micPending;
    if (micStream && !micStream.synthetic) micStream.getTracks().forEach((t) => (t.enabled = true));
    return;
  }
  return sfuPublish();
}

/** Acquire a source (mic or synth, decided by voiceSource) and publish it.
 *  Split out of sfuMic so the mic-OFF path can re-enter it to swap sources
 *  rather than carrying a second copy of the transceiver logic below. */
async function sfuPublish() {
  if (!pc) return;
  if (micPending) return micPending;
  micPending = (async () => {
    // 🔴 ASK THE SEAM, NOT THE DEVICE (R, 2026-08-16 — her TTS reached nobody).
    // This called getUserMedia directly, bypassing voiceSource() entirely. The
    // MESH asks the seam (voice.js:551) and therefore gets a synthesized track
    // for free; the SFU never asked, so on this transport a TTS provider had no
    // route to a sender at all — mic on, TTS refuses by design (tts.js:591);
    // mic off, nothing publishes. Her typed lines could not leave the machine
    // in either state, and /relay-diag showed pub=false with rx=0 throughout.
    //
    // voiceSource() returns the microphone when one is available and wanted,
    // and the synth provider otherwise, marking synthetic streams so the gate
    // is skipped. Everything below — addTrack, the transceiver hunt,
    // replaceTrack — is source-agnostic and unchanged.
    const { voiceSource } = await import('./voicesource.js');
    const raw = await voiceSource({ micWanted: wantMic });
    // 🔴 GATE IT BEFORE THE SENDER SEES IT (2026-08-16). This published `raw`
    // directly, so the SFU sent the unprocessed device stream: continuous room
    // tone, with the panel's sensitivity slider driving nothing at all. The
    // mesh gated at voice.js:615 ("GATE THE STREAM BEFORE WEBRTC EVER SEES
    // IT") and voice.js was the gate's only caller, so the transport we
    // actually ship was the ungated one. gateFor() passes a synthetic source
    // through untouched — no room noise to gate, and the gate's graph cannot
    // run on a headless stalled clock.
    const { gateFor, gateIsUnavailable, ungatedAllowed, setMicLive } = await import('./micstate.js');
    const s = gateFor(raw);
    // Tell micstate whether a DEVICE is capturing — the third state micOn()
    // needs and sfuMicOn() never had (it is two-state and cannot tell a muted
    // mic from a live one).
    setMicLive(!raw?.synthetic && wantMic);
    if (!raw?.synthetic && gateIsUnavailable() && !ungatedAllowed()) {
      // Refuse rather than publish ungated: the panel offers an explicit
      // opt-in row for that, and silently transmitting an ungated mic is the
      // one outcome nobody consented to.
      bus.emit('voice-gate-unavailable', {});
      wantMic = false;
      return;
    }
    try {
      window.__sfuSrc = `published ${s?.synthetic ? 'SYNTH' : 'mic'}`
        + ` · tracks=${s?.getTracks?.().length ?? 0}`
        + ` · wantMic=${wantMic}`;
    } catch { /* no window */ }
    micStream = s;
    // 🔴 addTrack PICKS A TRANSCEIVER FOR YOU, AND IT PICKS THE WRONG ONE.
    //
    // Root-caused 2026-08-15 with a 40-line isolation harness
    // (tools/mini-sfu-test.mjs — keep it, it reproduces this in seconds without
    // a world). With anyone else in the room our pc holds, in order:
    //     [sendonly route → speakerA] [sendonly route → speakerB] [recvonly floor]
    // The FLOOR is the m-line the server offers to receive OUR mic. addTrack
    // reuses the first *compatible* transceiver, which is a speaker ROUTE, so
    // the mic lands there (locally sendrecv, answered a=recvonly because the
    // server offered that m-line sendonly) and the floor is answered a=inactive
    // forever. Measured, both ends:
    //     a=recvonly,a=recvonly,a=inactive | trx: sendrecv+track,recvonly,recvonly
    // werift fires ontrack only for sendonly|sendrecv with a non-zero port
    // (transceiverManager.js:288), so the server NEVER subscribes: diag says
    // publishing:false / rxPackets:0 while this client honestly says
    // micPublished:true with thousands of packets sent. Both true, different
    // m-lines.
    //
    // Only reproduces with 2+ people — a lone client has no routes to mis-pick,
    // which is why every single-client probe passed while two humans heard
    // nothing all day.
    //
    // The fix: put the track on the transceiver the SERVER offered FOR it. The
    // floor is the one sitting inactive (nothing has ever been sent on it).
    // Verified in isolation: a=recvonly,a=recvonly,a=sendonly.
    const track = s.getTracks()[0];
    const floor = pc.getTransceivers().find(
      (t) => t.currentDirection === 'inactive' || t.direction === 'inactive');
    if (floor) {
      await floor.sender.replaceTrack(track);
      floor.direction = 'sendonly';
    } else {
      // No floor offered yet (we are the only one here, or the mic beat the
      // first offer). addTrack is correct then: there are no routes to mis-pick.
      for (const t of s.getTracks()) pc.addTrack(t, s);
    }
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

/** MY OWN level, for my own mouth flap and the 🎙 glyph.
 *
 *  The mesh has had this since the beginning (voice.js micAnalyserLevel) and
 *  the SFU never did, so on an SFU client the speaker's own avatar sat
 *  slack-jawed while everyone else's moved — voicemouths.js asked voice.js,
 *  whose micStream is null on this transport, and got a flat 0. Same analyser
 *  shape as sfuPeerLevels below, on the outbound stream instead of an inbound
 *  one. (2026-08-15.)
 *
 *  Reads the RAW mic, deliberately: the question a mouth answers is "are you
 *  making sound", not "is the gate currently forwarding it" — a gated-shut
 *  syllable still moves your face. */
export function sfuMyLevel() {
  if (!micStream || !wantMic) return 0;
  try {
    if (!_myAn || _myStream !== micStream) {
      const ctx = audioContext();
      _myAn = ctx.createAnalyser(); _myAn.fftSize = 512;
      ctx.createMediaStreamSource(micStream).connect(_myAn);
      _myBuf = new Float32Array(_myAn.fftSize);
      _myStream = micStream;
    }
    _myAn.getFloatTimeDomainData(_myBuf);
    let peak = 0;
    for (const v of _myBuf) peak = Math.max(peak, Math.abs(v));
    return peak;
  } catch { return 0; }
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
    // 🔴 THE RAW ICE/CONNECTION STATES, not just the derived boolean (added
    // 2026-08-16). `active` collapses to false for a peer that is still
    // 'checking', one that has 'failed', and one that never existed — three
    // different problems with three different fixes, reported as one bit. The
    // morning's phone bug was a peer stuck in 'checking' forever, and nothing
    // in this blob could say so.
    iceConnectionState: pc?.iceConnectionState ?? null,
    connectionState: pc?.connectionState ?? null,
    iceGatheringState: pc?.iceGatheringState ?? null,
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
