// voicesfu — the browser half of the in-process SFU, in plain WebRTC: the only voice transport.
// The relayDiag()/relayMic names it exposes through voicesfubridge.js are historical; the smokes
// assert against them.
//
// The server offers, always: we only ever setRemoteDescription(offer) → answer. Rationale for the
// negotiation, transceiver and acquisition rules below: docs/research/sfu-client-negotiation.md.
import { bus } from '../base.js';
import { audioContext } from './audioctx.js';
import { logChat } from '../ui/chat.js';   // a dead media path must be visible to the person, not only the console
import { playWhenAllowed } from './audiounlock.js';
import { why } from '../debuglog.js';
import { rawMicStream, setMicLive } from './micstate.js';

let pc = null, cred = null, micStream = null, wantMic = false;
let _myAn = null, _myBuf = null, _myStream = null;   // my outbound analyser (sfuMyLevel); cleared by sfuConnect
// speaker ids announced by the server, consumed in order by ontrack; subscribed once (bus has no `off`)
const routeQueue = [];
bus.on('sfu-route', (m) => routeQueue.push(m.speaker));
const speakers = new Map();           // id → { audio, stream, wantVolume, an, buf }

export const sfuActive = () => !!pc && pc.connectionState === 'connected';
export const sfuMicOn = () => !!micStream && wantMic;
/** Intent, as distinct from sfuMicOn(): a press before `pc` exists sets only this, and the bridge
 *  replays it once the credential lands. */
export const sfuMicWanted = () => wantMic;

/** Attach a remote track to a per-speaker <audio>. */
function attach(id, track) {
  let s = speakers.get(id);
  if (!s) { s = { audio: new Audio(), wantVolume: 0 }; speakers.set(id, s); }
  s.audio.autoplay = true;
  s.audio.playsInline = true;
  const stream = new MediaStream([track]);
  s.audio.srcObject = stream;
  s.stream = stream;
  // autoplay policy: a real user's first join needs the unlock queue (audiounlock.js)
  playWhenAllowed(s.audio, id);
}

export async function sfuConnect(credential, send) {
  cred = credential;
  // a mic track belongs to the pc that published it: stop the old stream (and its hardware light)
  // so the bridge's replay publishes afresh on the live pc. wantMic is kept: intent survives a reconnect.
  if (micStream) {
    for (const t of micStream.getTracks()) { try { t.stop(); } catch { /* already dead */ } }
    micStream = null;
  }
  // close the predecessor with its handlers nulled, or a ghost's 'failed' would diagnose the new pc
  if (pc) {
    try { pc.onicecandidate = pc.ontrack = pc.oniceconnectionstatechange = null; pc.close(); }
    catch { /* already closed */ }
  }
  pendingIce.length = 0;            // candidates for the dead pc are meaningless
  _myAn = null; _myStream = null;   // the analyser was bound to the dead stream
  // the server chooses the ICE config (the credential's iceServers), so an operator can point at
  // their own STUN/TURN; without one a peer on another network stalls in 'checking'
  pc = new RTCPeerConnection({ iceServers: credential?.iceServers ?? [] });

  // The server names each outbound stream after its speaker (sfu.ts ensureRoute), so the msid is
  // the route's identity; the sideband `sfu-route` queue (arrival order) is a fallback for an older
  // server, and msid wins, loudly, when they disagree.
  routeQueue.length = 0;
  pc.ontrack = (e) => {
    const viaMsid = e.streams?.[0]?.id;
    const viaQueue = routeQueue.shift();
    const id = (viaMsid && viaMsid !== 'default') ? viaMsid : viaQueue;
    if (viaMsid && viaQueue && viaMsid !== 'default' && viaMsid !== viaQueue) {
      console.warn('[sfu] route identity mismatch — msid', viaMsid, 'vs queue', viaQueue, '(trusting msid)');
    }
    if (id) attach(id, e.track);
  };

  // host-only candidates = no STUN reflexive address: only this machine, the LAN or a routable host can reach us; recorded for the stall diagnosis
  let _sawNonHostCandidate = false;
  pc.onicecandidate = (e) => {
    if (!e.candidate) return;
    if (e.candidate.type && e.candidate.type !== 'host') _sawNonHostCandidate = true;
    // the candidate names its generation, as the answer does, so a stale tab cannot trickle into its successor's pc
    send({ type: 'sfu-ice', candidate: e.candidate, gen: cred?.mediaGen });
  };

  // A connection that never connects must say so to the person (the mic meter reads capture, not
  // transmission). Without a viable pair ICE just sits in 'checking', so a stall is reported like
  // 'failed'; 'disconnected' is often transient and is not.
  let iceStallTimer = null;
  const clearStall = () => { if (iceStallTimer) { clearTimeout(iceStallTimer); iceStallTimer = null; } };
  const myPc = pc;   // the handlers judge the connection they were armed for, not a successor
  pc.oniceconnectionstatechange = () => {
    if (myPc !== pc) return;            // a ghost has no diagnosis to offer
    const st = pc.iceConnectionState;
    if (st === 'checking') {
      clearStall();
      // LAN pairs settle in well under a second; 8s means there is no viable pair
      iceStallTimer = setTimeout(() => {
        if (myPc !== pc) return;        // superseded while armed — not our patient
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
          bus.emit('sfu-media-dead', { reason: 'ice-stalled' });
        }
      }, 8000);
    } else if (st === 'connected' || st === 'completed') {
      clearStall();
      console.info(`[voice] ICE ${st} — media path is live`);
      bus.emit('sfu-media-live', {});     // the bridge resets its recovery budget
    } else if (st === 'failed') {
      clearStall();
      console.error('[voice] 🔴 ICE FAILED — no media path to the server. '
        + 'Mic capture is unaffected and still looks healthy; nothing is reaching anyone.');
      logChat('*', 'voice: connection failed — reconnecting voice…');
      bus.emit('sfu-media-dead', { reason: 'ice-failed' });   // the bridge owns the retry budget
    } else if (st === 'closed') {
      clearStall();
    }
  };
  return pc;
}

/** Server-initiated renegotiation: the only negotiation path (see the header). */
export async function sfuOnOffer(sdp, send) {
  if (!pc) return;
  const myPc = pc;   // a reconnect mid-await swaps the module-level pc; answer only on the one this offer was for
  await myPc.setRemoteDescription({ type: 'offer', sdp });
  if (myPc !== pc) return;              // superseded mid-exchange — the new pc has its own offer coming
  // feed the candidates that arrived before a remote description existed
  while (pendingIce.length) {
    if (myPc !== pc) return;   // queue now belongs to the successor's offer
    const c = pendingIce.shift();
    try { await myPc.addIceCandidate(c); } catch { /* stale */ }
  }
  const answer = await myPc.createAnswer();
  if (myPc !== pc) return;
  await myPc.setLocalDescription(answer);
  if (myPc !== pc) return;
  // rescue a stranded publish: a publish that beat the first offer can sit on a transceiver JSEP
  // associated a recv route; a live outbound track with no m-line sending moves to the floor
  const outTrack = micStream?.getTracks?.()[0];
  if (outTrack && outTrack.readyState === 'live'
      && !myPc.getTransceivers().some((t) => t.currentDirection === 'sendonly')) {
    const floor = myPc.getTransceivers().find(
      (t) => t.currentDirection === 'inactive' || t.direction === 'inactive');
    if (floor) {
      why('publish', 'post-offer rescue: outbound track was stranded — moving to the floor');
      await floor.sender.replaceTrack(outTrack);
      if (myPc !== pc) return;          // superseded mid-rescue — not our negotiation to ask for
      floor.direction = 'sendonly';
      bus.emit('sfu-want-negotiate', {});
    }
  }
  // present the credential (the server's replay check, usedNonces) and the generation this answer
  // is for (the server drops it if the leg was replaced since the offer)
  send({ type: 'sfu-answer', sdp: answer.sdp, gen: cred?.mediaGen ?? cred?.gen, cred: cred && {
    world: cred.world, id: cred.id, primaryGen: cred.primaryGen,
    mediaGen: cred.mediaGen ?? cred.gen, incarnation: cred.incarnation, nonce: cred.nonce } });
}

// candidates that arrive while sfuOnOffer is still applying the offer are queued, not dropped
const pendingIce = [];
export async function sfuOnIce(candidate) {
  if (!pc) return;
  if (!pc.remoteDescription) { pendingIce.push(candidate); return; }
  try { await pc.addIceCandidate(candidate); } catch { /* stale/dup candidate */ }
}

// One acquisition at a time: getUserMedia can sit on a prompt for seconds, and two callers inside
// it would publish twice. The guard is the promise, so late callers await the same acquisition;
// micPendingPc says which pc it was for (a stale pending is awaited, then treated as absent).
let micPending = null;
let micPendingPc = null;

/** Publish or release the mic. Mic off with a synth provider available swaps the source instead
 *  of muting, so the sender keeps publishing. */
export async function sfuMic(on = true) {
  wantMic = on;
  if (!pc) return;
  if (!on) {
    const { synthProvider } = await import('./voicesource.js');
    const prov = synthProvider();
    why('publish', `mic off · provider=${prov ? 'registered' : 'NONE'}`
      + (prov ? ` · available=${!!prov.available?.()}` : ''));
    if (prov?.available?.()) {
      // drop the device stream and re-enter sfuPublish, the one place a track is chosen and attached
      if (micStream) {
        for (const t of micStream.getTracks()) { try { t.stop(); } catch { /* gone */ } }
        micStream = null;
      }
      why('publish', 'swapping to synth');
      return void sfuPublish();
    }
    micStream?.getTracks().forEach((t) => (t.enabled = false));
    try { (await import('./micstate.js')).setMicLive(false); } catch { /* module may be absent in probes */ }
    return;
  }
  // a real device is re-enabled in place; a synthetic stream is dropped and a device re-acquired
  if (micStream && !micStream.synthetic) {
    micStream.getTracks().forEach((t) => (t.enabled = true));
    setMicLive(true);
    return;
  }
  if (micStream?.synthetic) {
    for (const t of micStream.getTracks()) { try { t.stop(); } catch { /* gone */ } }
    micStream = null;
  }
  if (micPending && micPendingPc === pc) {
    await micPending;   // a waiter only waits: the publish re-reads wantMic itself
    return;
  }
  return sfuPublish();
}

/** Acquire a source (mic or synth, decided by voiceSource) and publish it. */
async function sfuPublish() {
  if (!pc) return;
  // join a fresh same-pc pending; await a stale one and re-check (two waiters must not mint two acquisitions)
  while (micPending) {
    if (micPendingPc === pc) return micPending;
    try { await micPending; } catch { /* the old one's problem */ }
  }
  const myPc = pc;   // a reconnect during the prompt swaps pc; the track must not land on another session's connection
  micPendingPc = myPc;
  micPending = (async () => {
    const { voiceSource } = await import('./voicesource.js');
    const asked = wantMic;
    const raw = await voiceSource({ micWanted: asked });
    // re-read intent after the await: a mic toggled during the prompt means this answer is stale
    if (wantMic !== asked) {
      why('publish', `intent changed during acquisition (asked mic=${asked}, now ${wantMic}) — dropping ${raw?.synthetic ? 'synth' : 'device'}`);
      for (const t of raw?.getTracks?.() ?? []) { try { t.enabled = false; t.stop(); } catch { /* gone */ } }
      if (!raw?.synthetic) { try { (await import('./micstate.js')).setMicLive(false); } catch { /* probe env */ } }
      return 'intent-changed';
    }
    // gate it before the sender sees it (gateFor passes a synthetic source through untouched)
    const { gateFor, gateIsUnavailable, ungatedAllowed, setMicLive } = await import('./micstate.js');
    const s = gateFor(raw);
    setMicLive(!raw?.synthetic && wantMic);   // micstate's "a device is capturing" state
    if (!raw?.synthetic && gateIsUnavailable() && !ungatedAllowed()) {
      // refuse rather than publish ungated; the audio panel offers the explicit opt-in
      bus.emit('voice-gate-unavailable', {});
      wantMic = false;
      return;
    }
    // superseded during acquisition: stop what we acquired and let the new session's replay publish
    if (myPc !== pc) {
      why('publish', 'pc superseded during acquisition — dropping this publish');
      for (const t of raw?.getTracks?.() ?? []) { try { t.stop(); } catch { /* gone */ } }
      try { setMicLive(false); } catch { /* probe env */ }
      return;
    }
    why('publish', `published ${s?.synthetic ? 'SYNTH' : 'mic'}`
      + ` · tracks=${s?.getTracks?.().length ?? 0}` + ` · wantMic=${wantMic}`);
    micStream = s;
    // addTrack picks a transceiver for you, and with 2+ people it picks a speaker route, so the track
    // goes on the one the server offered for it, the floor (docs/research/sfu-client-negotiation.md;
    // repro: test/labs/mini-sfu-repro.mjs). Order: the sender we already own (replaceTrack, no
    // renegotiation) → the inactive floor → bare addTrack only when neither exists (solo, pre-offer).
    const track = s.getTracks()[0];
    const mine = pc.getTransceivers().find((t) =>
      t.currentDirection === 'sendonly'
      || (t.currentDirection == null && (t.direction === 'sendonly' || t.direction === 'sendrecv')));
    if (mine) {
      await mine.sender.replaceTrack(track);
    } else {
      const floor = pc.getTransceivers().find(
        (t) => t.currentDirection === 'inactive' || t.direction === 'inactive');
      if (floor) {
        await floor.sender.replaceTrack(track);
        floor.direction = 'sendonly';
      } else {
        for (const t of s.getTracks()) pc.addTrack(t, s);
      }
    }
  })();
  // a denied prompt is a normal answer: clear our own intent (never a superseded invocation's)
  const own = micPending;
  let outcome;
  try {
    outcome = await own;
  } catch (e) {
    if (myPc === pc) wantMic = false;
    console.warn('[sfu] mic not granted:', e?.name || e);
    return;
  } finally {
    if (micPending === own) micPending = null;   // CAS: a successor may have registered its own pending
  }
  if (outcome === 'intent-changed') {
    // the decision the flip would have made on a settled stream; with no provider there is
    // nothing to publish (re-entering would re-acquire the device just dropped, forever)
    if (myPc !== pc) return;
    const { synthProvider } = await import('./voicesource.js');
    const prov = synthProvider();
    if (wantMic || !!prov?.available?.()) return sfuPublish();
    return;
  }
  // the server offers, so ask it to renegotiate rather than offering ourselves (glare)
  bus.emit('sfu-want-negotiate', {});
}

/** My own level, for my mouth flap and the 🎙 glyph (voicemouths.js). */
export function sfuMyLevel() {
  if (!micStream || !wantMic) return 0;
  try {
    // measure the raw device, not the gated lane: a mouth must move below the threshold too
    const src = rawMicStream() ?? micStream;
    if (!_myAn || _myStream !== src) {
      const ctx = audioContext();
      _myAn = ctx.createAnalyser(); _myAn.fftSize = 512;
      ctx.createMediaStreamSource(src).connect(_myAn);
      _myBuf = new Float32Array(_myAn.fftSize);
      _myStream = src;
    }
    _myAn.getFloatTimeDomainData(_myBuf);
    let peak = 0;
    for (const v of _myBuf) peak = Math.max(peak, Math.abs(v));
    return peak;
  } catch { return 0; }
}

/** id → peak level per speaker (installed as window.relayPeerLevels by the bridge). */
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

/** The diag surface the browser smoke asserts against (window.relayDiag). */
export function sfuDiagClient() {
  return {
    transport: 'sfu',
    active: sfuActive(),
    identity: cred?.identity ?? null,
    micPublished: sfuMicOn(),
    // the raw states, not just `active`: 'checking', 'failed' and never-existed are three problems
    iceConnectionState: pc?.iceConnectionState ?? null,
    connectionState: pc?.connectionState ?? null,
    iceGatheringState: pc?.iceGatheringState ?? null,
    speakers: [...speakers.entries()].map(([id, s]) => ({ id, hasStream: !!s.stream })),
  };
}

/** Live speaker records (mutated in place by the bridge's rolloff loops), as entries so the Map stays ours. */
export function sfuSpeakerEntries() { return [...speakers.entries()]; }

/** Inbound-audio stats from the browser's NetEq (jitter buffer depth, time-stretching, PLC). */
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

/** Tear down one departed speaker's playback; the <audio> and analyser are never in the DOM, so nothing else reclaims them. */
export function sfuDropSpeaker(id) {
  const s = speakers.get(id);
  if (!s) return;
  try { s.audio.pause(); } catch { /* already dead */ }
  s.audio.srcObject = null;
  try { s.an?.disconnect(); } catch { /* never built */ }
  speakers.delete(id);
}

export function sfuClose() {
  try { pc?.close(); } catch {}
  pc = null;
  for (const s of speakers.values()) { s.audio.srcObject = null; try { s.an?.disconnect(); } catch {} }
  speakers.clear();
}
