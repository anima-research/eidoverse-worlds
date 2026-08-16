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
await pg.goto('http://127.0.0.1:8960/');
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
  return r;
}, server.localDescription.sdp);
console.log('  FIRST answer (no mic yet):', out.first);
console.log('  SECOND answer (mic added):', out.second, '| transceivers:', out.trx);
console.log(out.second.includes('sendonly') ? '  ✅ revives' : '  ❌ STAYS DEAD — a rejected m-line cannot be revived');
await b.close(); process.exit(0);
