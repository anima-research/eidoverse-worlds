// MINIMAL werift↔Chromium: does a browser answer sendonly to a server's
// recvonly m-line when it has a track? Strips away every world concern.
import { chromium } from 'playwright';
import { RTCPeerConnection } from 'werift';
const server = new RTCPeerConnection({});
// THE REAL SHAPE: the server holds sendonly ROUTES (one per speaker this
// listener consents to hear) PLUS the recvonly floor for the listener's own
// mic — and the floor is added LAST, exactly as sfuadapter does.
const { MediaStreamTrack, MediaStream } = await import('werift');
for (const speaker of ['spkA','spkB']) {
  const t = new MediaStreamTrack({ kind: 'audio' });
  server.addTransceiver(t, { direction: 'sendonly', streams: [new MediaStream({ id: speaker, tracks: [t] })] });
}
server.addTransceiver('audio', { direction: 'recvonly' });
let fired = false;
server.onTrack.subscribe(() => { fired = true; console.log('  🔔 SERVER ontrack FIRED'); });
const offer = await server.createOffer();
await server.setLocalDescription(offer);

const b = await chromium.launch({ executablePath:'/home/claude/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome',
  args:['--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream','--autoplay-policy=no-user-gesture-required'] });
const pg = await (await b.newContext({permissions:['microphone']})).newPage();
// A real http(s) origin is required for getUserMedia's secure-context check —
// but it must be OURS, not whatever ambient world happens to hold :8960 (the
// #128 review lens: an ambient responder is not identity, and a clean
// checkout has no responder at all). A one-page server owned by the test.
const { createServer } = await import('node:http');
const pageSrv = createServer((_, res) => { res.setHeader('content-type', 'text/html'); res.end('<!doctype html><title>mini-sfu</title>'); });
await new Promise((r) => pageSrv.listen(0, '127.0.0.1', r));
await pg.goto(`http://127.0.0.1:${pageSrv.address().port}/`);
// THE REAL SEQUENCE: answer FIRST with no mic (as the client does at join),
// then acquire the mic, then answer the SAME offer again (renegotiation).
const out = await pg.evaluate(async (offerSdp) => {
  const pc = new RTCPeerConnection({});
  const r = {};
  await pc.setRemoteDescription({type:'offer', sdp: offerSdp});
  let a = await pc.createAnswer(); await pc.setLocalDescription(a);
  r.first = (a.sdp.match(/a=(sendonly|recvonly|sendrecv|inactive)/g)||[]).join(',');
  // now the mic shows up, exactly as it does when a user clicks the button
  const s = await navigator.mediaDevices.getUserMedia({audio:true});
  // THE FIX UNDER TEST: bind the mic to the transceiver the SERVER offered for
  // it — the one whose remote direction is recvonly (it wants to receive us).
  // addTrack picks the first *compatible* transceiver, which is a speaker
  // route, and the floor never gets the track.
  const floor = pc.getTransceivers().find(t => t.currentDirection === 'inactive' || t.direction === 'inactive');
  if (floor) { await floor.sender.replaceTrack(s.getTracks()[0]); floor.direction = 'sendonly'; }
  else { for (const t of s.getTracks()) pc.addTrack(t, s); }
  // the server re-offers the SAME sdp (it has no new transceivers)
  await pc.setRemoteDescription({type:'offer', sdp: offerSdp});
  a = await pc.createAnswer(); await pc.setLocalDescription(a);
  r.second = (a.sdp.match(/a=(sendonly|recvonly|sendrecv|inactive)/g)||[]).join(',');
  r.trx = pc.getTransceivers().map(t=>`${t.direction}${t.sender?.track?'+track':''}`).join(',');

  // ── STAGE 3: SWAP THE SOURCE ON AN ALREADY-PUBLISHED PC (R's TTS bug,
  // 2026-08-16: "can hear locally but not at the endpoint… toggling mic back
  // on = silence"). The floor is now sendonly, so a hunt that only knows
  // 'inactive' falls through to addTrack — and the server offers, ALWAYS: an
  // answer cannot add an m-line, so the new sender lives locally, plays into
  // the monitor, and never enters the SDP. Every later swap repeats it.
  const ctx = new AudioContext();
  const dest = ctx.createMediaStreamDestination();       // a synthetic "TTS" track
  const synthTrack = dest.stream.getAudioTracks()[0];
  // the OLD hunt, verbatim — proves the failure shape:
  {
    const floor = pc.getTransceivers().find(t => t.currentDirection === 'inactive' || t.direction === 'inactive');
    if (floor) { await floor.sender.replaceTrack(synthTrack); floor.direction = 'sendonly'; }
    else { pc.addTrack(synthTrack, dest.stream); }
  }
  // What actually happens (measured, not the orphan I predicted): addTrack
  // HIJACKS a recvonly route transceiver — its sender slot is empty, so it is
  // "compatible" — and the answer for that m-line can only ever say recvonly
  // (the server offered it sendonly, their side). The synth track sits on a
  // sender that will never transmit. Same silence, same mis-pick class as the
  // original 2026-08-15 addTrack bug, resurrected on the swap path.
  r.oldHuntTrx = pc.getTransceivers().length;
  r.oldHuntPutSynthOnRecvRoute = pc.getTransceivers()
    .some(t => t.sender?.track === synthTrack && t.direction !== 'sendonly');
  r.oldHuntOwnedSenderHasSynth = pc.getTransceivers()
    .some(t => t.direction === 'sendonly' && t.sender?.track === synthTrack);
  // the FIXED hunt — round-2 shape, kept in sync with voicesfu.js: the
  // NEGOTIATED direction is the authority; the ask (direction) counts only
  // pre-negotiation (currentDirection null). Round 1's direction-based match
  // latched onto a sendrecv transceiver JSEP had associated with a recv
  // route; currentDirection === 'recvonly' excludes it.
  {
    const mine = pc.getTransceivers().find(t =>
      t.currentDirection === 'sendonly'
      || (t.currentDirection == null && (t.direction === 'sendonly' || t.direction === 'sendrecv')));
    if (mine) await mine.sender.replaceTrack(synthTrack);
  }
  r.ownedSenderCarriesSynth = pc.getTransceivers()
    .some(t => t.currentDirection === 'sendonly' && t.sender?.track === synthTrack);
  // round-2 control: a transceiver whose ASK is sendrecv but whose NEGOTIATED
  // answer is recvonly (a route JSEP associated with our addTrack) must be
  // invisible to the hunt.
  r.recvAssociatedExcluded = !pc.getTransceivers().some(t =>
    t.currentDirection === 'recvonly' && t.direction === 'sendrecv'
    && (t.currentDirection === 'sendonly'
        || (t.currentDirection == null && (t.direction === 'sendonly' || t.direction === 'sendrecv'))));
  return r;
}, server.localDescription.sdp);
console.log('  FIRST answer (no mic yet):', out.first);
console.log('  SECOND answer (mic added):', out.second, '| transceivers:', out.trx);
console.log(out.second.includes('sendonly') ? '  ✅ revives' : '  ❌ STAYS DEAD — a rejected m-line cannot be revived');
const reproduced = out.oldHuntPutSynthOnRecvRoute && !out.oldHuntOwnedSenderHasSynth;
console.log(`  STAGE 3 — old hunt hijacks a recv route: ${reproduced ? `✅ reproduced (synth on a non-sendonly sender, ${out.oldHuntTrx} trx)` : '❌ not reproduced'}`);
console.log(`  STAGE 3 — fixed hunt swaps in place:     ${out.ownedSenderCarriesSynth ? '✅ owned sendonly sender carries the synth track' : '❌'}`);
await b.close();
pageSrv.close();
console.log(`  STAGE 3 — recv-associated sendrecv excluded: ${out.recvAssociatedExcluded ? '✅' : '❌'}`);
process.exit(reproduced && out.ownedSenderCarriesSynth && out.recvAssociatedExcluded ? 0 : 1);
