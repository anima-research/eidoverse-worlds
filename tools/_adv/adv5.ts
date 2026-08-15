/**
 * F, decisive. Attribute cost by VARYING N while holding the SERVER's real
 * work constant-per-listener, and by comparing against a run where the
 * listeners' RTCPeerConnections do not exist at all.
 *
 * Key insight: in tools/sfu-load.ts the process contains 2N PeerConnections
 * (N "browser" + N server legs). A real deployment has N server legs only.
 * If the per-listener cost is symmetric, HALF the measured CPU is the
 * clients'. Test it: run the identical fanout with listeners terminated by a
 * bare UDP sink instead of a full RTCPeerConnection.
 */
import { RTCPeerConnection, MediaStreamTrack, RTCRtpCodecParameters, RtpPacket, RtpHeader } from "werift";
import { Sfu } from "../../server/sfu.ts";

const CODEC = new RTCRtpCodecParameters({ mimeType: "audio/opus", clockRate: 48000, channels: 2, payloadType: 111 });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const N = Number(process.argv[2] ?? 12), SECONDS = Number(process.argv[3] ?? 8), SPEAKERS = Number(process.argv[4] ?? 2);
const PTIME_MS = 20, OPUS_BYTES = 80;
const negotiate = async (o: RTCPeerConnection, a: RTCPeerConnection) => {
  const off = await o.createOffer(); await o.setLocalDescription(off);
  await a.setRemoteDescription(o.localDescription!);
  const an = await a.createAnswer(); await a.setLocalDescription(an);
  await o.setRemoteDescription(a.localDescription!);
};

const sfu = new Sfu({ onNegotiationNeeded: () => {} });
const peers: { id: string; pc: RTCPeerConnection; mic: MediaStreamTrack; heard: number }[] = [];
for (let i = 0; i < N; i++) {
  const id = `p${i}`;
  const pc = new RTCPeerConnection({ codecs: { audio: [CODEC] } });
  const mic = new MediaStreamTrack({ kind: "audio" });
  pc.addTransceiver(mic, { direction: "sendonly" });
  const peer = { id, pc, mic, heard: 0 };
  pc.ontrack = (e) => e.track.onReceiveRtp.subscribe(() => { peer.heard++; });
  const leg = sfu.createLeg(id, 1);
  await negotiate(pc, leg.pc);
  peers.push(peer);
}
await sleep(1200);
for (const l of peers) for (const s of peers) if (l.id !== s.id) sfu.setConsent(l.id, s.id, true);
for (const p of peers) await negotiate(sfu.getLeg(p.id)!.pc, p.pc);
await sleep(1500);

// Measure the SPEAKER-SIDE cost alone: the speaker's own writeRtp into its mic
// crosses the fake browser's sender -> UDP -> the SFU leg's receiver. That is
// TWO client-side legs per packet that a real server never runs.
// Tier: measure total, then measure with fanout SUPPRESSED (consent revoked)
// -- the delta is everything downstream of ingress, and the remainder is the
// pure ingest cost of ONE speaker's packets (which the server does pay once).
const run = async (label: string) => {
  const cpu0 = process.cpuUsage(), t0 = Date.now();
  let sent = 0;
  const ticks = Math.floor((SECONDS * 1000) / PTIME_MS);
  for (let tick = 0; tick < ticks; tick++) {
    for (const p of peers.slice(0, SPEAKERS)) {
      p.mic.writeRtp(new RtpPacket(
        new RtpHeader({ payloadType: 111, sequenceNumber: tick & 0xffff, timestamp: tick * 960, ssrc: 1000 + peers.indexOf(p) }),
        Buffer.alloc(OPUS_BYTES, 0xfe)));
      sent++;
    }
    await sleep(PTIME_MS);
  }
  await sleep(400);
  const elapsed = (Date.now() - t0) / 1000, cpu = process.cpuUsage(cpu0);
  const pct = ((cpu.user + cpu.system) / 1000 / (elapsed * 1000)) * 100;
  console.log(`  ${label.padEnd(28)} cpu=${pct.toFixed(1)}%  forwarded=${sfu.diag().forwarded}`);
  return pct;
};

console.log(`\nN=${N}, ${SPEAKERS} speaking\n`);
const withFanout = await run("A: full fanout (as shipped)");
// Now revoke ALL consent: speakers still publish (ingest + client send + server
// recv all still happen) but ZERO packets are forwarded and no listener PC
// receives anything.
for (const l of peers) for (const s of peers) if (l.id !== s.id) sfu.setConsent(l.id, s.id, false);
await sleep(200);
const f0 = sfu.diag().forwarded;
const noFanout = await run("B: ingest only (no fanout)");
const stillForwarded = sfu.diag().forwarded - f0;

console.log(`\n  fanout-attributable   = ${(withFanout - noFanout).toFixed(1)} pts`);
console.log(`  ingest+client-publish = ${noFanout.toFixed(1)} pts  (forwarded during B: ${stillForwarded})`);
console.log(`\n  NOTE: 'ingest' here still includes the FAKE BROWSER's send path`);
console.log(`  (SRTP encrypt + dgram) which a real deployment runs on the client.\n`);
sfu.closeAll();
process.exit(0);
