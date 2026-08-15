/**
 * F, refined. Three tiers to attribute the cost honestly:
 *
 *  full     = SFU fanout + SRTP ENCRYPT + dgram send + N fake browsers
 *             RECEIVING (SRTP decrypt + depacketize). ONE process.
 *             <- this is what tools/sfu-load.ts reports.
 *  sendonly = same, but every listener peer's ontrack subscriber is removed
 *             AND we drop the received data as early as werift lets us.
 *             Still pays server-side encrypt + real UDP send.
 *  nopeers  = SFU bookkeeping/fanout only.
 *
 * A real deployment pays roughly `sendonly`; the clients pay the rest, on
 * their own machines.
 */
import { RTCPeerConnection, MediaStreamTrack, RTCRtpCodecParameters, RtpPacket, RtpHeader } from "werift";
import { Sfu } from "../../server/sfu.ts";

const CODEC = new RTCRtpCodecParameters({ mimeType: "audio/opus", clockRate: 48000, channels: 2, payloadType: 111 });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const N = Number(process.argv[2] ?? 12), SECONDS = Number(process.argv[3] ?? 8),
      SPEAKERS = Number(process.argv[4] ?? 2), MODE = process.argv[5] ?? "full";
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
  // MODE=sendonly: do NOT subscribe on the receiving side at all.
  if (MODE === "full") pc.ontrack = (e) => e.track.onReceiveRtp.subscribe(() => { peer.heard++; });
  const leg = sfu.createLeg(id, 1);
  await negotiate(pc, leg.pc);
  peers.push(peer);
}
await sleep(1200);
for (const l of peers) for (const s of peers) if (l.id !== s.id) sfu.setConsent(l.id, s.id, true);
for (const p of peers) await negotiate(sfu.getLeg(p.id)!.pc, p.pc);
await sleep(1500);

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
await sleep(500);
const elapsed = (Date.now() - t0) / 1000;
const cpu = process.cpuUsage(cpu0);
console.log(`MODE=${MODE} N=${N} spk=${SPEAKERS}  cpu=${(((cpu.user + cpu.system) / 1000 / (elapsed * 1000)) * 100).toFixed(1)}%  forwarded=${sfu.diag().forwarded}`);
sfu.closeAll();
process.exit(0);
